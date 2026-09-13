//! `omp-2110-gateway` (Kapitel 19 Teil 1, `docs/END-GOAL-FEATURES.md`
//! §19.3a Punkt 4/§19.4): bidirektionale Brücke zwischen SMPTE-2110-
//! Multicast (LAN, Fremdgeräte) und dem OMP-internen MXL-Fabric.
//! Gerichtet je Instanz (`OMP_2110_GATEWAY_DIRECTION=ingest|output`,
//! gleiches Muster wie `omp-srt-gateway`s `OMP_SRT_GATEWAY_DIRECTION`),
//! **anders als `omp-srt-gateway` aber mit MXL-Bezug auf einer Seite**
//! (Details: `pipeline.rs`-Moduldoku).
//!
//! - **Ingest** fix per Env-Var(s) konfiguriert, kein Live-Parameter —
//!   gleiche "einmal konfiguriert, dauerhaft aktiv"-Philosophie wie
//!   `omp-srt-gateway` (dortige Moduldoku). Zwei Konfigurationswege
//!   (§19.3a Punkt 4: "SDP-Annahme... statt aus Einzel-Env-Vars" — als
//!   Alternative, nicht als Ersatz umgesetzt): `OMP_2110_GATEWAY_SDP`/
//!   `_SDP_FILE` (echtes SDP, `sdp.rs` parst Adresse/Port/Breite/Höhe/
//!   Framerate) hat Vorrang vor den einzelnen `OMP_2110_GATEWAY_*`-Vars.
//! - **Output** wählt die MXL-Quelle dynamisch per echtem IS-05-
//!   Receiver-PATCH (Flow-Editor drag&drop, gleiches Muster wie
//!   `omp-viewer`), der 2110-Zielendpunkt bleibt fix (Env-Var) — anders
//!   als bei `omp-srt-gateway`s Downlink, wo *beide* Seiten fix sind.
//! - **Audio (D21, `UMSETZUNG.md`):** war bis dahin komplett out of
//!   scope ("Video-only... Audio-Ingest/-Output folgt bei konkretem
//!   Bedarf", Nachtrag 46) — jetzt ergänzt, weil AMWA IS-08 einen
//!   Audio-Signalweg braucht, um Kanäle darauf umzuroutern (s.
//!   `pipeline.rs`-Moduldoku für die genaue Kopplung Video/Audio je
//!   Richtung). Konfiguration exakt nach demselben Zwei-Wege-Muster wie
//!   Video (`OMP_2110_GATEWAY_AUDIO_SDP`/`_AUDIO_SDP_FILE` vor den
//!   einzelnen `OMP_2110_GATEWAY_AUDIO_*`-Vars), bewusst OHNE SAP
//!   (anders als `omp-aes67-gateway` — reines ST2110, keine Dante-/
//!   AES67-Discovery-Erwartung).

mod pipeline;
mod sdp;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_node_sdk::channelmapping::{
    Channel, ChannelMapApply, ChannelMapping, InputSpec, MapEntry, OutputSpec, CONTROL_TYPE as CM_CONTROL_TYPE,
};
use omp_node_sdk::connection::{
    bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery, ReceiverConnection,
    ReceiverControl, ReceiverResource,
};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, ReceiverSpec, SenderSpec, SetError,
};
use pipeline::{AudioOutputConfig, IngestConfig, OutputConfig};
use serde_json::Value;

/// Generische Kanal-Labels für IS-08-Inputs/Outputs — s.
/// `omp-aes67-gateway::main::generic_channels`-Doku (bewusst dupliziert).
fn generic_channels(count: i32) -> Vec<Channel> {
    (1..=count.max(1)).map(|n| Channel { label: format!("Channel {n}") }).collect()
}

/// NMOS IS-08 (D21) — steuert `audiomixmatrix` in der Ingest-Pipeline
/// (2110 → MXL) live neu.
struct IngestMatrixApply(Arc<pipeline::IngestHandle>);
impl ChannelMapApply for IngestMatrixApply {
    fn apply(&self, _output_id: &str, map: &BTreeMap<u32, MapEntry>) {
        self.0.set_channel_map(map);
    }
}

/// S. `IngestMatrixApply`-Doku — Audio-Output-Pipeline-Pendant (MXL →
/// 2110).
struct AudioOutputMatrixApply(pipeline::AudioOutputPipelineHandle);
impl ChannelMapApply for AudioOutputMatrixApply {
    fn apply(&self, _output_id: &str, map: &BTreeMap<u32, MapEntry>) {
        self.0.set_channel_map(map.clone());
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Direction {
    Ingest,
    Output,
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

/// `224.0.0.0`–`239.255.255.255` (IPv4-Multicast-Bereich, RFC 5771) —
/// entscheidet, ob eine aus einem SDP gelesene `c=`-Adresse als
/// `multicast_group` an `St2110VideoInput` weitergereicht werden muss
/// (s. dortige Doku) oder eine reine Unicast-Zieladresse ist, die für
/// den Empfänger-eigenen Listen-Socket ohne Bedeutung ist.
fn is_multicast(host: &str) -> bool {
    host.split('.')
        .next()
        .and_then(|first| first.parse::<u8>().ok())
        .is_some_and(|first| (224..=239).contains(&first))
}

struct IngestStore {
    flow_id: String,
    listen_port: u16,
    multicast_group: Option<String>,
    ptp_domain: Option<u32>,
    pipeline: Arc<pipeline::IngestHandle>,
    /// AMWA BCP-008-01 (NMOS Receiver Status Monitoring, `docs/
    /// decisions.md` BCP-008-Nachtrag 2026-09-11) — Ingest empfängt
    /// echten 2110-Traffic aus dem Netzwerk, ist also der "Receiver"
    /// dieses Gateways (die MXL-Weiterleitung ist nur die interne
    /// Konsequenz, nicht die überwachte Seite). Immer aktiv (kein
    /// Enable/Disable-Konzept, s. Moduldoku), `monitor.activate()`
    /// direkt nach dem erfolgreichen Pipeline-Start. Deckt seit D21
    /// BEIDE Essenzen ab (s. `spawn_ingest_monitor_tick`) — ein
    /// eigener zweiter Monitor pro Essenz wäre spec-genauer (BCP-008
    /// ist pro NMOS-Ressource gedacht), aber `omp-decklink` (D18)
    /// etabliert bereits das "ein Monitor pro Richtung"-Muster für
    /// genau diesen Fall, hier bewusst konsistent übernommen.
    monitor: Arc<omp_node_sdk::Monitor>,
    /// D21: Audio-Ingest-Parameter fürs Descriptor (Video hat keine
    /// eigenen — `flowId`/`listenEndpoint` blieben absichtlich Video-
    /// exklusiv benannt, s. u.).
    audio_flow_id: String,
    audio_listen_port: u16,
    audio_multicast_group: Option<String>,
    audio_channels: i32,
    /// AMWA IS-08 (D21).
    channel_mapping: Arc<ChannelMapping<IngestMatrixApply>>,
}

impl ParamStore for IngestStore {
    fn descriptor(&self) -> Descriptor {
        let mut parameters = vec![
            ParamSpec {
                name: "direction".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "flowId".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "listenEndpoint".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "audioFlowId".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "audioListenEndpoint".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "audioChannels".to_string(),
                kind: ParamType::Number,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "ptpSynced".to_string(),
                kind: ParamType::Boolean,
                unit: None,
                range: None,
                readonly: true,
            },
        ];
        parameters.extend(self.monitor.param_specs("monitor"));
        Descriptor { latency: None, parameters, methods: self.monitor.method_specs("monitor") }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "direction" => Some(serde_json::json!("ingest")),
            "flowId" => Some(serde_json::json!(self.flow_id)),
            "listenEndpoint" => {
                let group = self.multicast_group.as_deref().unwrap_or("0.0.0.0");
                Some(serde_json::json!(format!("{group}:{}", self.listen_port)))
            }
            "audioFlowId" => Some(serde_json::json!(self.audio_flow_id)),
            "audioListenEndpoint" => {
                let group = self.audio_multicast_group.as_deref().unwrap_or("0.0.0.0");
                Some(serde_json::json!(format!("{group}:{}", self.audio_listen_port)))
            }
            "audioChannels" => Some(serde_json::json!(self.audio_channels)),
            // `null`, wenn keine PTP-Domain konfiguriert ist (kein
            // stillschweigendes `false` — "nicht aktiviert" und "aktiv,
            // aber noch nicht synchronisiert" sind unterschiedliche
            // Zustände).
            "ptpSynced" => match self.ptp_domain {
                Some(_) => Some(serde_json::json!(self.pipeline.ptp_synced().unwrap_or(false))),
                None => Some(Value::Null),
            },
            _ => self.monitor.get("monitor", name, None, || {
                let (lost, late) = self.pipeline.jitterbuffer_stats();
                let (audio_lost, audio_late) = self.pipeline.audio_jitterbuffer_stats();
                vec![
                    ("num-lost".to_string(), "RTP-Pakete (Video), laut rtpjitterbuffer verloren".to_string(), lost as i64),
                    ("num-late".to_string(), "RTP-Pakete (Video), laut rtpjitterbuffer zu spät angekommen".to_string(), late as i64),
                    ("audio-num-lost".to_string(), "RTP-Pakete (Audio), laut rtpjitterbuffer verloren".to_string(), audio_lost as i64),
                    ("audio-num-late".to_string(), "RTP-Pakete (Audio), laut rtpjitterbuffer zu spät angekommen".to_string(), audio_late as i64),
                ]
            }),
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        match self.monitor.set("monitor", name, &value) {
            Some(true) => Ok(()),
            Some(false) => Err(SetError::Unknown),
            None => Err(SetError::ReadOnly),
        }
    }

    fn invoke(&self, name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        if self.monitor.invoke("monitor", name) {
            Ok(())
        } else {
            Err(InvokeError::Unknown)
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<omp_node_sdk::RawResponse> {
        self.channel_mapping
            .handle(method, path, body)
            .map(|(status, content_type, body)| omp_node_sdk::RawResponse { status, content_type, body })
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.channel_mapping.cors_methods(path)
    }
}

/// Setzt IS-05-PATCHes (Quellwahl) auf die Output-Pipeline um — gleiches
/// Muster wie `omp-viewer::main::ViewerControl`, hier ohne UMD-Label
/// (der 2110-Ausgang trägt kein Textoverlay).
struct OutputControl {
    registry: RegistryClient,
    pipeline: pipeline::OutputPipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
    /// S. `OutputStore::monitor`-Doku — `activate()`/`deactivate()` bei
    /// jedem echten Connect/Disconnect (IS-05-PATCH), nicht nur beim
    /// Pipeline-Rebuild-Erfolg: ein Disconnect ist der einzige Signal-
    /// geber für "dieser Sender ist jetzt inaktiv" (BCP-008-02s
    /// `overallStatus`/`transmissionStatus`/`essenceStatus`-Sonderfall).
    monitor: Arc<omp_node_sdk::Monitor>,
}

impl ReceiverControl for OutputControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        self.pipeline.connect(flow_id);
                        self.monitor.activate();
                    }
                    None => eprintln!("omp-2110-gateway: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-2110-gateway: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                self.pipeline.disconnect();
                self.monitor.deactivate();
            }
        }
    }
}

/// D21: Audio-Pendant zu `OutputControl` — bewusst EIN eigener Typ statt
/// `OutputControl` generisch über den Pipeline-Handle-Typ zu machen
/// (`pipeline::OutputPipelineHandle` und `pipeline::
/// AudioOutputPipelineHandle` sind unabhängige Typen, s. `pipeline.rs`-
/// Moduldoku zur bewusst getrennten Video-/Audio-Ausgangspipeline).
/// Rührt `monitor` NICHT an (anders als `OutputControl`) — Video bleibt
/// wie bisher der alleinige Treiber von `activate()`/`deactivate()`
/// (identisches Muster zu `omp-decklink::main::OutputControl::is_video`,
/// dort ebenfalls nur die Video-Instanz).
struct AudioOutputControl {
    registry: RegistryClient,
    pipeline: pipeline::AudioOutputPipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
}

impl ReceiverControl for AudioOutputControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        self.pipeline.connect(flow_id);
                    }
                    None => eprintln!("omp-2110-gateway: audio sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-2110-gateway: resolve audio sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                self.pipeline.disconnect();
            }
        }
    }
}

struct OutputStore {
    destination_host: String,
    destination_port: u16,
    connected_flow_id: Arc<Mutex<String>>,
    connection: Arc<ReceiverConnection<OutputControl>>,
    ptp_domain: Option<u32>,
    pipeline: pipeline::OutputPipelineHandle,
    /// AMWA BCP-008-02 (NMOS Sender Status Monitoring) — Output sendet
    /// echten 2110-Traffic ins Netzwerk, ist also der "Sender" dieses
    /// Gateways. Aktiv/inaktiv folgt der IS-05-Receiver-Verbindung (s.
    /// `OutputControl::apply`), nicht dem Prozess-Lebenszyklus — anders
    /// als bei Ingest, das immer aktiv ist.
    monitor: Arc<omp_node_sdk::Monitor>,
    /// D21: Audio-Output — unabhängige Pipeline/Verbindung (s.
    /// `pipeline.rs`-Moduldoku), teilt sich aber `monitor` mit Video
    /// (Video bleibt alleiniger Treiber von activate/deactivate, s.
    /// `AudioOutputControl`-Doku).
    destination_audio_host: String,
    destination_audio_port: u16,
    connected_audio_flow_id: Arc<Mutex<String>>,
    audio_connection: Arc<ReceiverConnection<AudioOutputControl>>,
    audio_pipeline: pipeline::AudioOutputPipelineHandle,
    /// AMWA IS-08 (D21).
    channel_mapping: Arc<ChannelMapping<AudioOutputMatrixApply>>,
}

impl ParamStore for OutputStore {
    fn descriptor(&self) -> Descriptor {
        let mut parameters = vec![
            ParamSpec {
                name: "direction".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "connectedFlowId".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "destinationEndpoint".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "connectedAudioFlowId".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "destinationAudioEndpoint".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "ptpSynced".to_string(),
                kind: ParamType::Boolean,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "audioPtpSynced".to_string(),
                kind: ParamType::Boolean,
                unit: None,
                range: None,
                readonly: true,
            },
        ];
        parameters.extend(self.monitor.param_specs("monitor"));
        Descriptor { latency: None, parameters, methods: self.monitor.method_specs("monitor") }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "direction" => Some(serde_json::json!("output")),
            "connectedFlowId" => Some(serde_json::json!(
                *self.connected_flow_id.lock().expect("lock poisoned")
            )),
            "destinationEndpoint" => Some(serde_json::json!(format!(
                "{}:{}",
                self.destination_host, self.destination_port
            ))),
            "connectedAudioFlowId" => Some(serde_json::json!(
                *self.connected_audio_flow_id.lock().expect("lock poisoned")
            )),
            "destinationAudioEndpoint" => Some(serde_json::json!(format!(
                "{}:{}",
                self.destination_audio_host, self.destination_audio_port
            ))),
            "ptpSynced" => match self.ptp_domain {
                Some(_) => Some(serde_json::json!(self.pipeline.ptp_synced().unwrap_or(false))),
                None => Some(Value::Null),
            },
            "audioPtpSynced" => match self.ptp_domain {
                Some(_) => Some(serde_json::json!(self.audio_pipeline.ptp_synced().unwrap_or(false))),
                None => Some(Value::Null),
            },
            // Keine echte Transmission-Error-Erkennung auf der Sende-
            // seite verfügbar (kein Rückkanal von einem 2110-Empfänger)
            // — `Vec::new` liefert bewusst eine leere Zählerliste statt
            // erfundener Werte, spec-konform für "capability absent"
            // (`GetTransmissionErrorCounters`-Doku).
            _ => self.monitor.get("monitor", name, None, Vec::new),
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        match self.monitor.set("monitor", name, &value) {
            Some(true) => Ok(()),
            Some(false) => Err(SetError::Unknown),
            None => Err(SetError::ReadOnly),
        }
    }

    fn invoke(&self, name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        if self.monitor.invoke("monitor", name) {
            Ok(())
        } else {
            Err(InvokeError::Unknown)
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<omp_node_sdk::RawResponse> {
        let to_raw = |(status, content_type, body)| omp_node_sdk::RawResponse { status, content_type, body };
        root_discovery(method, path)
            .or_else(|| {
                list_ids(method, path, "receivers", &[self.connection.id(), self.audio_connection.id()])
            })
            .or_else(|| bulk_discovery(method, path))
            .or_else(|| {
                bulk_patch(method, path, "receivers", body, |id, params| {
                    if self.connection.id() == id {
                        Some(self.connection.patch_staged(params).0)
                    } else if self.audio_connection.id() == id {
                        Some(self.audio_connection.patch_staged(params).0)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| bulk_patch(method, path, "senders", body, |_, _| None))
            .or_else(|| self.connection.handle(method, path, body))
            .or_else(|| self.audio_connection.handle(method, path, body))
            .or_else(|| self.channel_mapping.handle(method, path, body))
            .map(to_raw)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.connection
            .cors_methods(path)
            .or_else(|| self.audio_connection.cors_methods(path))
            .or_else(|| bulk_cors_methods(path, "senders"))
            .or_else(|| bulk_cors_methods(path, "receivers"))
            .or_else(|| self.channel_mapping.cors_methods(path))
    }
}

struct IngestParams {
    listen_port: u16,
    multicast_group: Option<String>,
    width: i32,
    height: i32,
    fps_num: i32,
    fps_den: i32,
}

/// Liest die Ingest-Konfiguration bevorzugt aus einem gereichten SDP
/// (`OMP_2110_GATEWAY_SDP_FILE` > `OMP_2110_GATEWAY_SDP`, §19.3a
/// Punkt 4), sonst aus den einzelnen `OMP_2110_GATEWAY_*`-Variablen.
fn resolve_ingest_params() -> Result<IngestParams, String> {
    let sdp_content = if let Ok(path) = std::env::var("OMP_2110_GATEWAY_SDP_FILE") {
        Some(std::fs::read_to_string(&path).map_err(|e| format!("SDP-Datei '{path}' lesen: {e}"))?)
    } else {
        std::env::var("OMP_2110_GATEWAY_SDP").ok()
    };

    if let Some(sdp_content) = sdp_content {
        let parsed = sdp::parse_video_sdp(&sdp_content)?;
        let multicast_group = is_multicast(&parsed.host).then_some(parsed.host);
        return Ok(IngestParams {
            listen_port: parsed.port,
            multicast_group,
            width: parsed.width,
            height: parsed.height,
            fps_num: parsed.framerate_numerator,
            fps_den: parsed.framerate_denominator,
        });
    }

    Ok(IngestParams {
        listen_port: env_or("OMP_2110_GATEWAY_LISTEN_PORT", "6000")
            .parse()
            .map_err(|e| format!("OMP_2110_GATEWAY_LISTEN_PORT: {e}"))?,
        multicast_group: std::env::var("OMP_2110_GATEWAY_MULTICAST_GROUP").ok(),
        width: env_or("OMP_2110_GATEWAY_WIDTH", "1920")
            .parse()
            .map_err(|e| format!("OMP_2110_GATEWAY_WIDTH: {e}"))?,
        height: env_or("OMP_2110_GATEWAY_HEIGHT", "1080")
            .parse()
            .map_err(|e| format!("OMP_2110_GATEWAY_HEIGHT: {e}"))?,
        fps_num: env_or("OMP_2110_GATEWAY_FPS_NUM", "25")
            .parse()
            .map_err(|e| format!("OMP_2110_GATEWAY_FPS_NUM: {e}"))?,
        fps_den: env_or("OMP_2110_GATEWAY_FPS_DEN", "1")
            .parse()
            .map_err(|e| format!("OMP_2110_GATEWAY_FPS_DEN: {e}"))?,
    })
}

struct AudioIngestParams {
    listen_port: u16,
    multicast_group: Option<String>,
    sample_rate: i32,
    channels: i32,
}

/// D21: Audio-Pendant zu `resolve_ingest_params` — bewusst OHNE SAP (s.
/// Moduldoku oben).
fn resolve_audio_ingest_params() -> Result<AudioIngestParams, String> {
    let sdp_content = if let Ok(path) = std::env::var("OMP_2110_GATEWAY_AUDIO_SDP_FILE") {
        Some(std::fs::read_to_string(&path).map_err(|e| format!("Audio-SDP-Datei '{path}' lesen: {e}"))?)
    } else {
        std::env::var("OMP_2110_GATEWAY_AUDIO_SDP").ok()
    };

    if let Some(sdp_content) = sdp_content {
        let parsed = sdp::parse_audio_sdp(&sdp_content)?;
        let multicast_group = is_multicast(&parsed.host).then_some(parsed.host);
        return Ok(AudioIngestParams {
            listen_port: parsed.port,
            multicast_group,
            sample_rate: parsed.sample_rate,
            channels: parsed.channels,
        });
    }

    Ok(AudioIngestParams {
        listen_port: env_or("OMP_2110_GATEWAY_AUDIO_LISTEN_PORT", "6002")
            .parse()
            .map_err(|e| format!("OMP_2110_GATEWAY_AUDIO_LISTEN_PORT: {e}"))?,
        multicast_group: std::env::var("OMP_2110_GATEWAY_AUDIO_MULTICAST_GROUP").ok(),
        sample_rate: env_or("OMP_2110_GATEWAY_AUDIO_SAMPLE_RATE", "48000")
            .parse()
            .map_err(|e| format!("OMP_2110_GATEWAY_AUDIO_SAMPLE_RATE: {e}"))?,
        channels: env_or("OMP_2110_GATEWAY_AUDIO_CHANNELS", "2")
            .parse()
            .map_err(|e| format!("OMP_2110_GATEWAY_AUDIO_CHANNELS: {e}"))?,
    })
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "2110-Gateway");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9400").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    // Kapitel 19 Teil 2 (opt-in, `docs/END-GOAL-FEATURES.md` §19.3a
    // Punkt 3): ohne die Variable unverändertes Free-Run-Verhalten.
    let ptp_domain: Option<u32> = match std::env::var("OMP_PTP_DOMAIN") {
        Ok(v) => Some(v.parse().map_err(|e| format!("OMP_PTP_DOMAIN: {e}"))?),
        Err(_) => None,
    };

    let direction = match env_or("OMP_2110_GATEWAY_DIRECTION", "ingest").as_str() {
        "output" => Direction::Output,
        _ => Direction::Ingest,
    };

    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));

    match direction {
        Direction::Ingest => {
            let IngestParams { listen_port, multicast_group, width, height, fps_num, fps_den } =
                resolve_ingest_params()?;
            let AudioIngestParams {
                listen_port: audio_listen_port,
                multicast_group: audio_multicast_group,
                sample_rate: audio_sample_rate,
                channels: audio_channels,
            } = resolve_audio_ingest_params()?;
            let flow_id = omp_node_sdk::idgen::new_v4();
            let audio_flow_id = omp_node_sdk::idgen::new_v4();
            // S. `omp-decklink::main`-Pendant-Kommentar (`UMSETZUNG.md`
            // D17/D18): `FlowSpec::Audio` UND `ChannelMapping`s
            // `OutputSpec::source_id` brauchen dieselbe, tatsächlich
            // registrierte Source-UUID.
            let audio_source_id = omp_node_sdk::idgen::new_v4();
            let control_host = host.clone();

            let cfg = IngestConfig {
                domain,
                flow_id: flow_id.clone(),
                label: label.clone(),
                listen_port,
                multicast_group: multicast_group.clone(),
                width,
                height,
                framerate_numerator: fps_num,
                framerate_denominator: fps_den,
                ptp_domain,
                audio_flow_id: audio_flow_id.clone(),
                audio_listen_port,
                audio_multicast_group: audio_multicast_group.clone(),
                audio_sample_rate,
                audio_channels,
            };

            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let pipeline_shutdown = shutdown.clone();
            let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
            let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
            let pipeline_thread = std::thread::spawn(move || {
                pipeline::run_ingest(cfg, events_tx, pipeline_shutdown, ready_tx, pipeline_heartbeat_thread)
            });

            let pipeline_handle = match ready_rx.await {
                Ok(Ok(handle)) => handle,
                Ok(Err(e)) => {
                    eprintln!("omp-2110-gateway: ingest pipeline build failed: {e}");
                    return Err(e.into());
                }
                Err(_) => {
                    eprintln!("omp-2110-gateway: ingest pipeline thread ended before reporting readiness");
                    return Err("ingest pipeline thread ended before reporting readiness".into());
                }
            };

            let pipeline_handle = Arc::new(pipeline_handle);
            let media_ready_pipeline = pipeline_handle.clone();

            let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Receiver));
            // Ingest ist "einmal konfiguriert, dauerhaft aktiv" (s.
            // Moduldoku) — sofort aktivieren, kein IS-05-Connect-Ereignis
            // wie bei Output.
            monitor.activate();
            spawn_ingest_monitor_tick(monitor.clone(), pipeline_handle.clone());

            // AMWA IS-08 (D21) — "2110-audio-in" bündelt die per Netzwerk
            // empfangenen Audiokanäle (kein IS-04-Receiver dafür
            // registriert, reine Netzwerk-Erfassung, `parent` bleibt
            // null/null — identisches Muster zu `omp-decklink`s "sdi-in"),
            // "mxl-audio-out" die des ausgehenden MXL-Audio-Senders.
            let channel_mapping = Arc::new(ChannelMapping::new(
                vec![InputSpec {
                    id: "2110-audio-in".to_string(),
                    name: "ST2110-30 Audio Input".to_string(),
                    description: "Per Netzwerk empfangene Audiokanäle".to_string(),
                    channels: generic_channels(audio_channels),
                    parent_id: None,
                    parent_type: None,
                    reordering: true,
                    block_size: 1,
                }],
                vec![OutputSpec {
                    id: "mxl-audio-out".to_string(),
                    name: "MXL Audio Output".to_string(),
                    description: "Ausgehender MXL-Audio-Flow".to_string(),
                    channels: generic_channels(audio_channels),
                    source_id: Some(audio_source_id.clone()),
                    routable_inputs: Some(vec![Some("2110-audio-in".to_string()), None]),
                }],
                IngestMatrixApply(pipeline_handle.clone()),
            ));

            let store: Arc<dyn ParamStore> = Arc::new(IngestStore {
                flow_id: flow_id.clone(),
                listen_port,
                multicast_group,
                ptp_domain,
                pipeline: pipeline_handle,
                monitor,
                audio_flow_id: audio_flow_id.clone(),
                audio_listen_port,
                audio_multicast_group,
                audio_channels,
                channel_mapping,
            });

            let handle = omp_node_sdk::start(
                NodeConfig {
                    label,
                    host,
                    port,
                    registry_url,
                    nats_url,
                    senders: vec![
                        SenderSpec {
                            transport: Some(TRANSPORT_MXL.to_string()),
                            flow: Some(FlowSpec::Video {
                                id: Some(flow_id),
                                frame_width: width as u32,
                                frame_height: height as u32,
                                grain_rate_numerator: fps_num as u32,
                                grain_rate_denominator: fps_den as u32,
                            }),
                            ..Default::default()
                        },
                        SenderSpec {
                            transport: Some(TRANSPORT_MXL.to_string()),
                            flow: Some(FlowSpec::Audio {
                                id: Some(audio_flow_id),
                                sample_rate_numerator: audio_sample_rate as u32,
                                channel_count: audio_channels as u32,
                                media_type: "audio/L24".to_string(),
                                bit_depth: 24,
                                source_id: Some(audio_source_id),
                            }),
                            ..Default::default()
                        },
                    ],
                    receivers: vec![],
                    instance_id,
                    media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                        media_ready_pipeline.media_ready()
                    })),
                },
                store,
            )
            .await?;

            // AMWA IS-08 (D21) — kündigt die Channel-Mapping-API im
            // IS-04-Device an, erst nach `start()` möglich (`handle.port`
            // steht erst nach dem tatsächlichen Binden fest).
            if let Err(e) = handle
                .add_device_control(serde_json::json!({
                    "type": CM_CONTROL_TYPE,
                    "href": format!("http://{control_host}:{}/x-nmos/channelmapping/v1.0/", handle.port),
                }))
                .await
            {
                eprintln!("omp-2110-gateway: announcing channelmapping control failed: {e}");
            }

            // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
            // Nachtrag 130/131).
            handle.register_worker("pipeline", pipeline_heartbeat);

            run_event_loop(handle, &mut events_rx, shutdown, vec![pipeline_thread]).await;
        }
        Direction::Output => {
            let destination_host = env_or("OMP_2110_GATEWAY_DEST_HOST", "239.1.1.1");
            let destination_port: u16 = env_or("OMP_2110_GATEWAY_DEST_PORT", "6000").parse()?;
            let width: i32 = env_or("OMP_2110_GATEWAY_WIDTH", "1920").parse()?;
            let height: i32 = env_or("OMP_2110_GATEWAY_HEIGHT", "1080").parse()?;
            let fps_num: i32 = env_or("OMP_2110_GATEWAY_FPS_NUM", "25").parse()?;
            let fps_den: i32 = env_or("OMP_2110_GATEWAY_FPS_DEN", "1").parse()?;
            let destination_audio_host = env_or("OMP_2110_GATEWAY_AUDIO_DEST_HOST", "239.1.1.2");
            let destination_audio_port: u16 = env_or("OMP_2110_GATEWAY_AUDIO_DEST_PORT", "6002").parse()?;
            let audio_sample_rate: i32 = env_or("OMP_2110_GATEWAY_AUDIO_SAMPLE_RATE", "48000").parse()?;
            let audio_channels: i32 = env_or("OMP_2110_GATEWAY_AUDIO_CHANNELS", "2").parse()?;
            let control_host = host.clone();

            let cfg = OutputConfig {
                domain: domain.clone(),
                destination_host: destination_host.clone(),
                destination_port,
                width,
                height,
                framerate_numerator: fps_num,
                framerate_denominator: fps_den,
                ptp_domain,
            };

            let audio_events_tx = events_tx.clone();
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let pipeline_shutdown = shutdown.clone();
            let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
            let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
            let pipeline_thread = std::thread::spawn(move || {
                pipeline::run_output(cfg, events_tx, pipeline_shutdown, ready_tx, pipeline_heartbeat_thread)
            });

            let pipeline_handle = match ready_rx.await {
                Ok(Ok(handle)) => handle,
                Ok(Err(e)) => {
                    eprintln!("omp-2110-gateway: output pipeline build failed: {e}");
                    return Err(e.into());
                }
                Err(_) => {
                    eprintln!("omp-2110-gateway: output pipeline thread ended before reporting readiness");
                    return Err("output pipeline thread ended before reporting readiness".into());
                }
            };

            // D21: eigene, unabhängige Audio-Ausgangspipeline (s.
            // `pipeline.rs`-Moduldoku) — eigener Thread, eigener
            // Heartbeat-Worker, eigenes Ready-Signal.
            let audio_cfg = AudioOutputConfig {
                domain,
                destination_host: destination_audio_host.clone(),
                destination_port: destination_audio_port,
                sample_rate: audio_sample_rate,
                channels: audio_channels,
                ptp_domain,
            };
            let (audio_ready_tx, audio_ready_rx) = tokio::sync::oneshot::channel();
            let audio_pipeline_shutdown = shutdown.clone();
            let audio_pipeline_heartbeat = Arc::new(AtomicU64::new(0));
            let audio_pipeline_heartbeat_thread = audio_pipeline_heartbeat.clone();
            let audio_pipeline_thread = std::thread::spawn(move || {
                pipeline::run_audio_output(
                    audio_cfg,
                    audio_events_tx,
                    audio_pipeline_shutdown,
                    audio_ready_tx,
                    audio_pipeline_heartbeat_thread,
                )
            });
            let audio_pipeline_handle = match audio_ready_rx.await {
                Ok(Ok(handle)) => handle,
                Ok(Err(e)) => {
                    eprintln!("omp-2110-gateway: audio output pipeline build failed: {e}");
                    return Err(e.into());
                }
                Err(_) => {
                    eprintln!("omp-2110-gateway: audio output pipeline thread ended before reporting readiness");
                    return Err("audio output pipeline thread ended before reporting readiness".into());
                }
            };

            let media_ready_pipeline = pipeline_handle.clone();
            let ptp_pipeline = pipeline_handle.clone();
            let receiver_id = omp_node_sdk::idgen::new_v4();
            let audio_receiver_id = omp_node_sdk::idgen::new_v4();
            let connected_flow_id = Arc::new(Mutex::new(String::new()));
            let connected_audio_flow_id = Arc::new(Mutex::new(String::new()));
            let registry = RegistryClient::new(registry_url.clone());
            let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Sender));
            // Startzustand `Inactive` (noch kein IS-05-Connect erfolgt) —
            // anders als bei Ingest kein sofortiges `activate()` hier,
            // das übernimmt `OutputControl::apply` beim ersten echten
            // Video-Connect (Video bleibt alleiniger Treiber, s.
            // `AudioOutputControl`-Doku).
            monitor.deactivate();
            spawn_output_monitor_tick(
                monitor.clone(),
                pipeline_handle.clone(),
                audio_pipeline_handle.clone(),
                connected_audio_flow_id.clone(),
            );
            let connection = Arc::new(ReceiverConnection::new(
                receiver_id.clone(),
                OutputControl {
                    registry: registry.clone(),
                    pipeline: pipeline_handle,
                    connected_flow_id: connected_flow_id.clone(),
                    monitor: monitor.clone(),
                },
            ));
            let audio_connection = Arc::new(ReceiverConnection::new(
                audio_receiver_id.clone(),
                AudioOutputControl {
                    registry,
                    pipeline: audio_pipeline_handle.clone(),
                    connected_flow_id: connected_audio_flow_id.clone(),
                },
            ));

            // AMWA IS-08 (D21): "mxl-audio-in" hängt am tatsächlich
            // registrierten IS-04-Audio-Receiver (`parent`, s. `docs/
            // Interoperability - NMOS IS-04.md`-Pflicht), "2110-audio-out"
            // hat KEINE Source (`source_id: None` — reiner Netzwerk-
            // Ausgang, keine NMOS-Ressource, identisches Muster zu
            // `omp-decklink`s "sdi-out").
            let channel_mapping = Arc::new(ChannelMapping::new(
                vec![InputSpec {
                    id: "mxl-audio-in".to_string(),
                    name: "MXL Audio Input".to_string(),
                    description: "Ausgewählte MXL-Audioquelle".to_string(),
                    channels: generic_channels(audio_channels),
                    parent_id: Some(audio_receiver_id.clone()),
                    parent_type: Some("receiver"),
                    reordering: true,
                    block_size: 1,
                }],
                vec![OutputSpec {
                    id: "2110-audio-out".to_string(),
                    name: "ST2110-30 Audio Output".to_string(),
                    description: "Ausgehende Audiokanäle über das Netzwerk".to_string(),
                    channels: generic_channels(audio_channels),
                    source_id: None,
                    routable_inputs: Some(vec![Some("mxl-audio-in".to_string()), None]),
                }],
                AudioOutputMatrixApply(audio_pipeline_handle.clone()),
            ));

            let store: Arc<dyn ParamStore> = Arc::new(OutputStore {
                destination_host,
                destination_port,
                connected_flow_id,
                connection,
                ptp_domain,
                pipeline: ptp_pipeline,
                monitor,
                destination_audio_host,
                destination_audio_port,
                connected_audio_flow_id,
                audio_connection,
                audio_pipeline: audio_pipeline_handle,
                channel_mapping,
            });

            let handle = omp_node_sdk::start(
                NodeConfig {
                    label,
                    host,
                    port,
                    registry_url,
                    nats_url,
                    senders: vec![],
                    receivers: vec![
                        ReceiverSpec {
                            id: Some(receiver_id),
                            transport: Some(TRANSPORT_MXL.to_string()),
                            media_types: Some(vec!["video/v210".to_string()]),
                            ..Default::default()
                        },
                        ReceiverSpec {
                            id: Some(audio_receiver_id),
                            transport: Some(TRANSPORT_MXL.to_string()),
                            media_types: Some(vec!["audio/L24".to_string()]),
                            label: Some("Audio".to_string()),
                        },
                    ],
                    instance_id,
                    media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                        media_ready_pipeline.media_ready()
                    })),
                },
                store,
            )
            .await?;

            // AMWA IS-08 (D21) — s. Ingest-Zweig-Kommentar.
            if let Err(e) = handle
                .add_device_control(serde_json::json!({
                    "type": CM_CONTROL_TYPE,
                    "href": format!("http://{control_host}:{}/x-nmos/channelmapping/v1.0/", handle.port),
                }))
                .await
            {
                eprintln!("omp-2110-gateway: announcing channelmapping control failed: {e}");
            }

            // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
            // Nachtrag 130/131).
            handle.register_worker("pipeline", pipeline_heartbeat);
            handle.register_worker("audio-pipeline", audio_pipeline_heartbeat);

            run_event_loop(handle, &mut events_rx, shutdown, vec![pipeline_thread, audio_pipeline_thread]).await;
        }
    }

    Ok(())
}

/// BCP-008-Tick für die Ingest-Richtung (`omp_node_sdk::MonitorKind::
/// Receiver`) — läuft als eigener Tokio-Task neben `run_event_loop`,
/// bis der Node beendet wird (kein Shutdown-Signal nötig: der ganze
/// Prozess endet, der Task stirbt mit ihm). 1s-Kadenz, deutlich unter
/// `statusReportingDelay` (Default 3s), damit die Entprellung in
/// `Monitor`/`DebouncedDomain` echte Wirkung hat statt vom Poll-Intervall
/// selbst verschluckt zu werden.
///
/// **Ehrliche Grenze (kein Raten):** `linkStatus` bleibt hier dauerhaft
/// `AllUp` — es gibt in dieser Umgebung kein echtes NIC-/PHY-Signal
/// dafür (anders als z. B. `omp-decklink`s Kabel-Erkennungssignal, s.
/// `docs/decisions.md` BCP-008-Nachtrag: geplanter Folgeschritt). Ein
/// kompletter Paketausfall zeigt sich stattdessen ehrlich im
/// `connectionStatus` (`num-lost` bleibt 0, aber `media_ready()` fällt
/// zurück auf `false`, sobald der Depayloader keine neuen Buffer mehr
/// sieht — s. `pipeline::IngestHandle`-Doku zur "media-ready"-Probe).
fn spawn_ingest_monitor_tick(monitor: Arc<omp_node_sdk::Monitor>, pipeline: Arc<pipeline::IngestHandle>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        let (mut prev_lost, mut prev_late) = pipeline.jitterbuffer_stats();
        let (mut prev_audio_lost, mut prev_audio_late) = pipeline.audio_jitterbuffer_stats();
        loop {
            ticker.tick().await;
            let delay = monitor.status_reporting_delay();

            let sync_level = match pipeline.ptp_synced() {
                Some(true) => omp_node_sdk::HealthLevel::Healthy,
                Some(false) => omp_node_sdk::HealthLevel::Unhealthy,
                None => omp_node_sdk::HealthLevel::Neutral,
            };
            monitor.sync.observe(sync_level, delay, Some("PTP nicht synchronisiert"));

            // D21: Video- UND Audio-Zweig teilen sich diesen EINEN
            // Monitor (s. `IngestStore::monitor`-Doku) — `activity`/
            // `content` fassen beide Essenzen zusammen (Verlust/
            // Ausbleiben SUMMIERT bzw. UND-verknüpft), damit "eine
            // Essenz fehlt" nicht stillschweigend als "alles gesund"
            // durchgeht. Die einzelnen Zähler bleiben trotzdem separat
            // abfragbar (`IngestStore::get`s `audio-num-lost`/`-late`).
            let (lost, late) = pipeline.jitterbuffer_stats();
            let (audio_lost, audio_late) = pipeline.audio_jitterbuffer_stats();
            let (delta_lost, delta_late) = (lost.saturating_sub(prev_lost), late.saturating_sub(prev_late));
            let (delta_audio_lost, delta_audio_late) =
                (audio_lost.saturating_sub(prev_audio_lost), audio_late.saturating_sub(prev_audio_late));
            prev_lost = lost;
            prev_late = late;
            prev_audio_lost = audio_lost;
            prev_audio_late = audio_late;
            let total_lost = delta_lost + delta_audio_lost;
            let total_late = delta_late + delta_audio_late;
            let connection_level = if total_lost > 0 {
                omp_node_sdk::HealthLevel::Unhealthy
            } else if total_late > 0 {
                omp_node_sdk::HealthLevel::PartiallyHealthy
            } else {
                omp_node_sdk::HealthLevel::Healthy
            };
            monitor.activity.observe(
                connection_level,
                delay,
                Some(&format!(
                    "rtpjitterbuffer meldet {total_lost} verlorene/{total_late} verspätete Pakete seit dem letzten Tick (Video+Audio)"
                )),
            );

            let stream_level = if pipeline.media_ready() && pipeline.audio_media_ready() {
                omp_node_sdk::HealthLevel::Healthy
            } else {
                omp_node_sdk::HealthLevel::Unhealthy
            };
            monitor.content.observe(
                stream_level,
                delay,
                Some("kein dekodiertes Video- oder Audiobild seit dem letzten Tick"),
            );
        }
    });
}

/// BCP-008-Tick für die Output-Richtung (`omp_node_sdk::MonitorKind::
/// Sender`) — s. `spawn_ingest_monitor_tick`-Doku (gleiche Kadenz/
/// Begründung). Kein Paketverlust-Signal auf der Senderseite verfügbar
/// (kein Rückkanal von einem echten 2110-Empfänger in dieser Umgebung)
/// — `transmissionStatus` stützt sich deshalb, wie `essenceStatus`, auf
/// `media_ready()` (liefert die Pipeline tatsächlich Bilder an
/// `udpsink`?). D21: `audio_pipeline`/`connected_audio_flow_id` fließen
/// NUR ein, solange Audio tatsächlich verbunden ist (Video bleibt
/// alleiniger Treiber von `activate()`/`deactivate()`, s.
/// `AudioOutputControl`-Doku) — sonst würde ein rein Video-Setup ohne
/// jemals verbundenes Audio fälschlich als "Audio fehlt" degradiert.
fn spawn_output_monitor_tick(
    monitor: Arc<omp_node_sdk::Monitor>,
    pipeline: pipeline::OutputPipelineHandle,
    audio_pipeline: pipeline::AudioOutputPipelineHandle,
    connected_audio_flow_id: Arc<Mutex<String>>,
) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let delay = monitor.status_reporting_delay();

            let sync_level = match pipeline.ptp_synced() {
                Some(true) => omp_node_sdk::HealthLevel::Healthy,
                Some(false) => omp_node_sdk::HealthLevel::Unhealthy,
                None => omp_node_sdk::HealthLevel::Neutral,
            };
            monitor.sync.observe(sync_level, delay, Some("PTP nicht synchronisiert"));

            // Nur relevant, solange verbunden (`Monitor::deactivate()`
            // hat `activity`/`content` sonst schon auf `Inactive`
            // gesetzt, s. `OutputControl::apply`) — ein `observe()` mit
            // `Healthy` würde das sofort wieder aufheben, ohne echten
            // Grund, DESHALB hier auf `overall()` prüfen statt blind zu
            // observieren.
            if monitor.overall() == omp_node_sdk::HealthLevel::Neutral {
                continue;
            }
            let audio_connected = !connected_audio_flow_id.lock().expect("lock poisoned").is_empty();
            let level = if pipeline.media_ready() && (!audio_connected || audio_pipeline.media_ready()) {
                omp_node_sdk::HealthLevel::Healthy
            } else {
                omp_node_sdk::HealthLevel::Unhealthy
            };
            monitor.activity.observe(
                level,
                delay,
                Some("keine Bilder/kein Ton an den 2110-Ausgang seit dem letzten Tick"),
            );
            monitor.content.observe(level, delay, Some("keine gültige Essenz seit dem letzten Tick"));
        }
    });
}

/// `pipeline_threads`: ein Eintrag bei Ingest (ein gemeinsames Video+
/// Audio-`gst::Pipeline`, s. `pipeline.rs`-Moduldoku), zwei bei Output
/// (unabhängige Video-/Audio-Ausgangspipelines, D21) — der `events`-
/// Kanal schließt erst, wenn ALLE zugehörigen Sender (ein Klon pro
/// Pipeline-Thread) verworfen wurden.
async fn run_event_loop(
    handle: omp_node_sdk::NodeHandle,
    events_rx: &mut tokio::sync::mpsc::UnboundedReceiver<pipeline::Event>,
    shutdown: Arc<AtomicBool>,
    pipeline_threads: Vec<std::thread::JoinHandle<()>>,
) {
    let events = async {
        while let Some(event) = events_rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-2110-gateway: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-2110-gateway: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-2110-gateway: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    for t in pipeline_threads {
        let _ = t.join();
    }
}
