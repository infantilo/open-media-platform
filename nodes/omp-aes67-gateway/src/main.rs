//! `omp-aes67-gateway` (Kapitel 19 Teil 3, `docs/END-GOAL-FEATURES.md`
//! §19.3c/§19.4): bidirektionale Brücke zwischen AES67/RTP-Multicast
//! (LAN, Dante-Geräte im AES67-Modus, Ravenna/Lawo/Merging u. a.) und
//! dem OMP-internen MXL-Fabric — Audio-Pendant zu `omp-2110-gateway`,
//! zusätzlich mit einer SAP-Komponente (RFC 2974, `sap.rs`), weil AES67-
//! /Dante-Geräte Fremdströme ausschließlich darüber finden, nicht durch
//! Adress-Scanning.
//!
//! - **Sink**-Rolle (AES67 → MXL): drei Konfigurationswege, in dieser
//!   Reihenfolge versucht — (1) ein direkt gereichtes SDP
//!   (`OMP_AES67_GATEWAY_SDP`/`_SDP_FILE`, gleiches Muster wie
//!   `omp-2110-gateway`), (2) SAP-Discovery
//!   (`OMP_AES67_GATEWAY_DISCOVER_NAME` = gesuchter Session-Name-
//!   Teilstring, wartet auf ein passendes SAP-Announcement), (3)
//!   einzelne `OMP_AES67_GATEWAY_*`-Variablen als letzter Rückfall.
//! - **Source**-Rolle (MXL → AES67): fixer Ziel-Endpunkt (Env-Vars),
//!   MXL-Quelle dynamisch per IS-05-Receiver-PATCH — plus ein
//!   dauerhaft laufender SAP-`Announcer`, der das eigene SDP periodisch
//!   ankündigt, solange der Prozess läuft (unabhängig davon, ob gerade
//!   eine MXL-Quelle verbunden ist — ein Dante-Controller soll den
//!   Stream schon vor dem ersten Connect als "vorhanden" listen können,
//!   exakt wie ein Hardware-Gateway das täte).

mod pipeline;
mod sap;
mod sdp;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_node_sdk::connection::{
    bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery, ReceiverConnection,
    ReceiverControl, ReceiverResource,
};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, ReceiverSpec, SenderSpec, SetError,
};
use pipeline::{SinkConfig, SourceConfig};
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Direction {
    Sink,
    Source,
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

/// S. `omp-2110-gateway::main::is_multicast`-Doku, identische Logik
/// (bewusst dupliziert statt geteilt, gleiche Begründung wie dort:
/// jeder Gateway-Node ist ein eigenständiges, unabhängig bau- und
/// verteilbares Binary).
fn is_multicast(host: &str) -> bool {
    host.split('.')
        .next()
        .and_then(|first| first.parse::<u8>().ok())
        .is_some_and(|first| (224..=239).contains(&first))
}

struct SinkStore {
    flow_id: String,
    listen_port: u16,
    multicast_group: Option<String>,
    discovered_via_sap: bool,
    ptp_domain: Option<u32>,
    pipeline: Arc<pipeline::SinkHandle>,
    /// AMWA BCP-008-01 (NMOS Receiver Status Monitoring, `docs/
    /// decisions.md` BCP-008-Nachtrag) — Sink empfängt echten AES67-
    /// Traffic aus dem Netzwerk, ist also der "Receiver" dieses
    /// Gateways (identisches Muster zu `omp-2110-gateway::IngestStore`,
    /// Audio-Pendant). Immer aktiv, `monitor.activate()` direkt nach
    /// Pipeline-Start.
    monitor: Arc<omp_node_sdk::Monitor>,
}

impl ParamStore for SinkStore {
    fn descriptor(&self) -> Descriptor {
        let mut parameters = vec![
            ParamSpec { name: "direction".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "flowId".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "listenEndpoint".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "discoveredViaSap".to_string(), kind: ParamType::Boolean, unit: None, range: None, readonly: true },
            ParamSpec { name: "ptpSynced".to_string(), kind: ParamType::Boolean, unit: None, range: None, readonly: true },
        ];
        parameters.extend(self.monitor.param_specs("monitor"));
        Descriptor { latency: None, parameters, methods: self.monitor.method_specs("monitor") }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "direction" => Some(serde_json::json!("sink")),
            "flowId" => Some(serde_json::json!(self.flow_id)),
            "listenEndpoint" => {
                let group = self.multicast_group.as_deref().unwrap_or("0.0.0.0");
                Some(serde_json::json!(format!("{group}:{}", self.listen_port)))
            }
            "discoveredViaSap" => Some(serde_json::json!(self.discovered_via_sap)),
            "ptpSynced" => match self.ptp_domain {
                Some(_) => Some(serde_json::json!(self.pipeline.ptp_synced().unwrap_or(false))),
                None => Some(Value::Null),
            },
            _ => self.monitor.get("monitor", name, None, || {
                let (lost, late) = self.pipeline.jitterbuffer_stats();
                vec![
                    ("num-lost".to_string(), "RTP-Pakete, laut rtpjitterbuffer verloren".to_string(), lost as i64),
                    ("num-late".to_string(), "RTP-Pakete, laut rtpjitterbuffer zu spät angekommen".to_string(), late as i64),
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
}

/// Setzt IS-05-PATCHes (Quellwahl) auf die Source-Pipeline um — gleiches
/// Muster wie `omp-2110-gateway::main::OutputControl`.
struct SourceControl {
    registry: RegistryClient,
    pipeline: pipeline::SourcePipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
    /// S. `SourceStore::monitor`-Doku.
    monitor: Arc<omp_node_sdk::Monitor>,
}

impl ReceiverControl for SourceControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        self.pipeline.connect(flow_id);
                        self.monitor.activate();
                    }
                    None => eprintln!("omp-aes67-gateway: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-aes67-gateway: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                self.pipeline.disconnect();
                self.monitor.deactivate();
            }
        }
    }
}

struct SourceStore {
    destination_host: String,
    destination_port: u16,
    connected_flow_id: Arc<Mutex<String>>,
    connection: Arc<ReceiverConnection<SourceControl>>,
    ptp_domain: Option<u32>,
    pipeline: pipeline::SourcePipelineHandle,
    /// AMWA BCP-008-02 (NMOS Sender Status Monitoring) — Source sendet
    /// echten AES67-Traffic ins Netzwerk, ist also der "Sender" dieses
    /// Gateways. Aktiv/inaktiv folgt der IS-05-Receiver-Verbindung (s.
    /// `SourceControl::apply`), nicht dem Prozess-Lebenszyklus (der
    /// SAP-Announcer läuft unabhängig davon weiter, s. Moduldoku).
    monitor: Arc<omp_node_sdk::Monitor>,
}

impl ParamStore for SourceStore {
    fn descriptor(&self) -> Descriptor {
        let mut parameters = vec![
            ParamSpec { name: "direction".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "connectedFlowId".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "destinationEndpoint".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "ptpSynced".to_string(), kind: ParamType::Boolean, unit: None, range: None, readonly: true },
        ];
        parameters.extend(self.monitor.param_specs("monitor"));
        Descriptor { latency: None, parameters, methods: self.monitor.method_specs("monitor") }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "direction" => Some(serde_json::json!("source")),
            "connectedFlowId" => Some(serde_json::json!(*self.connected_flow_id.lock().expect("lock poisoned"))),
            "destinationEndpoint" => {
                Some(serde_json::json!(format!("{}:{}", self.destination_host, self.destination_port)))
            }
            "ptpSynced" => match self.ptp_domain {
                Some(_) => Some(serde_json::json!(self.pipeline.ptp_synced().unwrap_or(false))),
                None => Some(Value::Null),
            },
            // Kein Rückkanal von einem echten AES67-Empfänger — leere
            // Zählerliste (s. `omp-2110-gateway::OutputStore::get`).
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
            .or_else(|| list_ids(method, path, "receivers", &[self.connection.id()]))
            .or_else(|| bulk_discovery(method, path))
            .or_else(|| {
                bulk_patch(method, path, "receivers", body, |id, params| {
                    (self.connection.id() == id).then(|| self.connection.patch_staged(params).0)
                })
            })
            .or_else(|| bulk_patch(method, path, "senders", body, |_, _| None))
            .or_else(|| self.connection.handle(method, path, body))
            .map(to_raw)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.connection
            .cors_methods(path)
            .or_else(|| bulk_cors_methods(path, "senders"))
            .or_else(|| bulk_cors_methods(path, "receivers"))
    }
}

struct SinkParams {
    listen_port: u16,
    multicast_group: Option<String>,
    sample_rate: i32,
    channels: i32,
    discovered_via_sap: bool,
}

/// Sucht in `listener`s aktuell bekannten SAP-Sessions eine
/// `m=audio`-Session, deren `s=`-Name `name_filter` als Teilstring
/// enthält (leerer Filter = erste gefundene Audio-Session), und wartet
/// dafür bis zu `timeout` — reale AES67-/Dante-Geräte announcen nicht
/// sofort beim Prozessstart, sondern erst beim nächsten periodischen
/// Intervall (typischerweise Sekunden bis niedrige Zehntelminuten).
fn discover_audio_sdp(listener: &sap::Listener, name_filter: &str, timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    loop {
        for session in listener.sessions() {
            if let Ok(parsed) = sdp::parse_audio_sdp(&session.sdp) {
                let matches = name_filter.is_empty()
                    || parsed.session_name.as_deref().is_some_and(|n| n.contains(name_filter));
                if matches {
                    return Ok(session.sdp);
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "keine passende SAP-Session gefunden (Filter '{name_filter}', {timeout:?} gewartet)"
            ));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn resolve_sink_params() -> Result<SinkParams, String> {
    let sdp_content = if let Ok(path) = std::env::var("OMP_AES67_GATEWAY_SDP_FILE") {
        Some(std::fs::read_to_string(&path).map_err(|e| format!("SDP-Datei '{path}' lesen: {e}"))?)
    } else {
        std::env::var("OMP_AES67_GATEWAY_SDP").ok()
    };

    if let Some(sdp_content) = sdp_content {
        let parsed = sdp::parse_audio_sdp(&sdp_content)?;
        let multicast_group = is_multicast(&parsed.host).then_some(parsed.host);
        return Ok(SinkParams {
            listen_port: parsed.port,
            multicast_group,
            sample_rate: parsed.sample_rate,
            channels: parsed.channels,
            discovered_via_sap: false,
        });
    }

    if let Ok(name_filter) = std::env::var("OMP_AES67_GATEWAY_DISCOVER_NAME") {
        let timeout_secs: u64 = env_or("OMP_AES67_GATEWAY_DISCOVER_TIMEOUT_SECS", "30")
            .parse()
            .map_err(|e| format!("OMP_AES67_GATEWAY_DISCOVER_TIMEOUT_SECS: {e}"))?;
        eprintln!("omp-aes67-gateway: warte per SAP auf eine Session, die '{name_filter}' enthält...");
        let listener = sap::Listener::start()?;
        let sdp_content = discover_audio_sdp(&listener, &name_filter, Duration::from_secs(timeout_secs))?;
        drop(listener);
        let parsed = sdp::parse_audio_sdp(&sdp_content)?;
        eprintln!(
            "omp-aes67-gateway: per SAP entdeckt: '{}' auf {}:{}",
            parsed.session_name.as_deref().unwrap_or("(ohne Namen)"),
            parsed.host,
            parsed.port
        );
        let multicast_group = is_multicast(&parsed.host).then_some(parsed.host);
        return Ok(SinkParams {
            listen_port: parsed.port,
            multicast_group,
            sample_rate: parsed.sample_rate,
            channels: parsed.channels,
            discovered_via_sap: true,
        });
    }

    Ok(SinkParams {
        listen_port: env_or("OMP_AES67_GATEWAY_LISTEN_PORT", "6100")
            .parse()
            .map_err(|e| format!("OMP_AES67_GATEWAY_LISTEN_PORT: {e}"))?,
        multicast_group: std::env::var("OMP_AES67_GATEWAY_MULTICAST_GROUP").ok(),
        sample_rate: env_or("OMP_AES67_GATEWAY_SAMPLE_RATE", "48000")
            .parse()
            .map_err(|e| format!("OMP_AES67_GATEWAY_SAMPLE_RATE: {e}"))?,
        channels: env_or("OMP_AES67_GATEWAY_CHANNELS", "2")
            .parse()
            .map_err(|e| format!("OMP_AES67_GATEWAY_CHANNELS: {e}"))?,
        discovered_via_sap: false,
    })
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "AES67-Gateway");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9420").parse()?;
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

    let direction = match env_or("OMP_AES67_GATEWAY_DIRECTION", "sink").as_str() {
        "source" => Direction::Source,
        _ => Direction::Sink,
    };

    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));

    match direction {
        Direction::Sink => {
            let SinkParams { listen_port, multicast_group, sample_rate, channels, discovered_via_sap } =
                resolve_sink_params()?;
            let flow_id = omp_node_sdk::idgen::new_v4();

            let cfg = SinkConfig {
                domain,
                flow_id: flow_id.clone(),
                label: label.clone(),
                listen_port,
                multicast_group: multicast_group.clone(),
                sample_rate,
                channels,
                ptp_domain,
            };

            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let pipeline_shutdown = shutdown.clone();
            let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
            let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
            let pipeline_thread = std::thread::spawn(move || {
                pipeline::run_sink(cfg, events_tx, pipeline_shutdown, ready_tx, pipeline_heartbeat_thread)
            });

            let pipeline_handle = match ready_rx.await {
                Ok(Ok(handle)) => handle,
                Ok(Err(e)) => {
                    eprintln!("omp-aes67-gateway: sink pipeline build failed: {e}");
                    return Err(e.into());
                }
                Err(_) => {
                    eprintln!("omp-aes67-gateway: sink pipeline thread ended before reporting readiness");
                    return Err("sink pipeline thread ended before reporting readiness".into());
                }
            };

            let pipeline_handle = Arc::new(pipeline_handle);
            let media_ready_pipeline = pipeline_handle.clone();

            let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Receiver));
            // Sink ist immer aktiv (kein Enable/Disable-Konzept, wie
            // `omp-2110-gateway`s Ingest).
            monitor.activate();
            spawn_sink_monitor_tick(monitor.clone(), pipeline_handle.clone());

            let store: Arc<dyn ParamStore> = Arc::new(SinkStore {
                flow_id: flow_id.clone(),
                listen_port,
                multicast_group,
                discovered_via_sap,
                ptp_domain,
                pipeline: pipeline_handle,
                monitor: monitor.clone(),
            });

            let handle = omp_node_sdk::start(
                NodeConfig {
                    label,
                    host,
                    port,
                    registry_url,
                    nats_url,
                    senders: vec![SenderSpec {
                        transport: Some(TRANSPORT_MXL.to_string()),
                        flow: Some(FlowSpec::Audio {
                            id: Some(flow_id),
                            sample_rate_numerator: sample_rate as u32,
                            channel_count: channels as u32,
                            media_type: "audio/float32".to_string(),
                            bit_depth: 32,
                        }),
                        ..Default::default()
                    }],
                    receivers: vec![],
                    instance_id,
                    media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_ready_pipeline.media_ready())),
                },
                store,
            )
            .await?;

            // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
            // Nachtrag 130/131).
            handle.register_worker("pipeline", pipeline_heartbeat);

            run_event_loop(handle, &mut events_rx, shutdown, pipeline_thread, None, monitor).await;
        }
        Direction::Source => {
            let destination_host = env_or("OMP_AES67_GATEWAY_DEST_HOST", "239.5.5.6");
            let destination_port: u16 = env_or("OMP_AES67_GATEWAY_DEST_PORT", "6100").parse()?;
            let sample_rate: i32 = env_or("OMP_AES67_GATEWAY_SAMPLE_RATE", "48000").parse()?;
            let channels: i32 = env_or("OMP_AES67_GATEWAY_CHANNELS", "2").parse()?;
            let sap_interval_secs: u64 = env_or("OMP_AES67_GATEWAY_SAP_INTERVAL_SECS", "30").parse()?;

            let cfg = SourceConfig {
                domain,
                destination_host: destination_host.clone(),
                destination_port,
                sample_rate,
                channels,
                ptp_domain,
            };

            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let pipeline_shutdown = shutdown.clone();
            let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
            let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
            let pipeline_thread = std::thread::spawn(move || {
                pipeline::run_source(cfg, events_tx, pipeline_shutdown, ready_tx, pipeline_heartbeat_thread)
            });

            let pipeline_handle = match ready_rx.await {
                Ok(Ok(handle)) => handle,
                Ok(Err(e)) => {
                    eprintln!("omp-aes67-gateway: source pipeline build failed: {e}");
                    return Err(e.into());
                }
                Err(_) => {
                    eprintln!("omp-aes67-gateway: source pipeline thread ended before reporting readiness");
                    return Err("source pipeline thread ended before reporting readiness".into());
                }
            };

            // SAP-Announcer läuft ab sofort, unabhängig vom ersten
            // IS-05-Connect (Moduldoku pipeline.rs::run_source).
            // Origin-Adresse: `OMP_AES67_GATEWAY_LOCAL_ADDR`, sonst
            // `127.0.0.1` (Dev-/Loopback-Default wie überall sonst in
            // diesem Crate) — reale Deployments setzen die echte
            // Interface-Adresse.
            let sap_origin: std::net::Ipv4Addr = env_or("OMP_AES67_GATEWAY_LOCAL_ADDR", "127.0.0.1")
                .parse()
                .map_err(|e| format!("OMP_AES67_GATEWAY_LOCAL_ADDR: {e}"))?;
            let sap_announcer = sap::Announcer::start(
                sap_origin,
                pipeline_handle.sdp().to_string(),
                Duration::from_secs(sap_interval_secs),
            )?;

            let media_ready_pipeline = pipeline_handle.clone();
            let ptp_pipeline = pipeline_handle.clone();
            let receiver_id = omp_node_sdk::idgen::new_v4();
            let connected_flow_id = Arc::new(Mutex::new(String::new()));
            let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Sender));
            // Startzustand `Inactive` — `SourceControl::apply`
            // übernimmt `activate()`/`deactivate()` beim echten IS-05-
            // Connect/Disconnect (unabhängig vom SAP-Announcer, s.
            // `SourceStore::monitor`-Doku).
            monitor.deactivate();
            spawn_source_monitor_tick(monitor.clone(), pipeline_handle.clone());
            let connection = Arc::new(ReceiverConnection::new(
                receiver_id.clone(),
                SourceControl {
                    registry: RegistryClient::new(registry_url.clone()),
                    pipeline: pipeline_handle,
                    connected_flow_id: connected_flow_id.clone(),
                    monitor: monitor.clone(),
                },
            ));

            let store: Arc<dyn ParamStore> = Arc::new(SourceStore {
                destination_host,
                destination_port,
                connected_flow_id,
                connection,
                ptp_domain,
                pipeline: ptp_pipeline,
                monitor: monitor.clone(),
            });

            let handle = omp_node_sdk::start(
                NodeConfig {
                    label,
                    host,
                    port,
                    registry_url,
                    nats_url,
                    senders: vec![],
                    receivers: vec![ReceiverSpec {
                        id: Some(receiver_id),
                        transport: Some(TRANSPORT_MXL.to_string()),
                        media_types: Some(vec!["audio/float32".to_string()]),
                        ..Default::default()
                    }],
                    instance_id,
                    media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_ready_pipeline.media_ready())),
                },
                store,
            )
            .await?;

            // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
            // Nachtrag 130/131).
            handle.register_worker("pipeline", pipeline_heartbeat);
            handle.register_worker("sap-announcer", sap_announcer.heartbeat_handle());

            run_event_loop(handle, &mut events_rx, shutdown, pipeline_thread, Some(sap_announcer), monitor).await;
        }
    }

    Ok(())
}

/// BCP-008-Tick für die Sink-Richtung (`omp_node_sdk::MonitorKind::
/// Receiver`) — s. `omp-2110-gateway::main::spawn_ingest_monitor_tick`-
/// Doku (identische Begründung/Kadenz, Audio- statt Video-Pendant).
/// `connectionStatus`s Verschlechterung kommt zusätzlich event-getrieben
/// aus `run_event_loop`s `Event::Error`-Zweig (kein doppeltes GStreamer-
/// Bus-Polling nötig, s. `omp-decklink::main::spawn_decklink_monitor_
/// tick`-Doku zur selben Überlegung) — der Tick selbst pusht hier nur
/// den optimistischen Healthy-Wert.
fn spawn_sink_monitor_tick(monitor: Arc<omp_node_sdk::Monitor>, pipeline: Arc<pipeline::SinkHandle>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        let (mut prev_lost, mut prev_late) = pipeline.jitterbuffer_stats();
        loop {
            ticker.tick().await;
            let delay = monitor.status_reporting_delay();

            let sync_level = match pipeline.ptp_synced() {
                Some(true) => omp_node_sdk::HealthLevel::Healthy,
                Some(false) => omp_node_sdk::HealthLevel::Unhealthy,
                None => omp_node_sdk::HealthLevel::Neutral,
            };
            monitor.sync.observe(sync_level, delay, Some("PTP nicht synchronisiert"));

            let (lost, late) = pipeline.jitterbuffer_stats();
            let (delta_lost, delta_late) = (lost.saturating_sub(prev_lost), late.saturating_sub(prev_late));
            prev_lost = lost;
            prev_late = late;
            let connection_level = if delta_lost > 0 {
                omp_node_sdk::HealthLevel::Unhealthy
            } else if delta_late > 0 {
                omp_node_sdk::HealthLevel::PartiallyHealthy
            } else {
                omp_node_sdk::HealthLevel::Healthy
            };
            monitor.activity.observe(
                connection_level,
                delay,
                Some(&format!("rtpjitterbuffer meldet {delta_lost} verlorene/{delta_late} verspätete Pakete seit dem letzten Tick")),
            );

            let stream_level =
                if pipeline.media_ready() { omp_node_sdk::HealthLevel::Healthy } else { omp_node_sdk::HealthLevel::Unhealthy };
            monitor.content.observe(stream_level, delay, Some("kein dekodierbarer Audiostrom seit dem letzten Tick"));
        }
    });
}

/// BCP-008-Tick für die Source-Richtung (`omp_node_sdk::MonitorKind::
/// Sender`) — s. `spawn_sink_monitor_tick`-Doku. Kein Paketverlust-
/// Signal auf der Senderseite verfügbar (kein Rückkanal von einem
/// echten AES67-Empfänger) — `transmissionStatus`/`essenceStatus`
/// stützen sich deshalb, wie beim 2110-Gateway, auf `media_ready()`.
fn spawn_source_monitor_tick(monitor: Arc<omp_node_sdk::Monitor>, pipeline: pipeline::SourcePipelineHandle) {
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

            if monitor.overall() == omp_node_sdk::HealthLevel::Neutral {
                continue;
            }
            let level =
                if pipeline.media_ready() { omp_node_sdk::HealthLevel::Healthy } else { omp_node_sdk::HealthLevel::Unhealthy };
            monitor.activity.observe(level, delay, Some("keine Samples an den AES67-Ausgang seit dem letzten Tick"));
            monitor.content.observe(level, delay, Some("keine gültige Essenz seit dem letzten Tick"));
        }
    });
}

async fn run_event_loop(
    handle: omp_node_sdk::NodeHandle,
    events_rx: &mut tokio::sync::mpsc::UnboundedReceiver<pipeline::Event>,
    shutdown: Arc<AtomicBool>,
    pipeline_thread: std::thread::JoinHandle<()>,
    // Muss bis zum Shutdown am Leben bleiben (sendet sonst vorzeitig ihr
    // Delete-Paket, s. `sap::Announcer::drop`) — deshalb hier
    // durchgereicht statt lokal in `main` gehalten und implizit vor
    // Ablauf dieser Funktion gedroppt.
    _sap_announcer: Option<sap::Announcer>,
    monitor: Arc<omp_node_sdk::Monitor>,
) {
    let events = async {
        while let Some(event) = events_rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-aes67-gateway: pipeline error: {message}");
                    // Sofortige Verschlechterung, solange verbunden (s.
                    // `spawn_sink_monitor_tick`-Doku) — für Sink immer
                    // wahr (immer aktiv), für Source nur bei
                    // bestehender IS-05-Verbindung.
                    if monitor.overall() != omp_node_sdk::HealthLevel::Neutral {
                        monitor.activity.observe(omp_node_sdk::HealthLevel::Unhealthy, monitor.status_reporting_delay(), Some(&message));
                    }
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-aes67-gateway: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-aes67-gateway: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();
}
