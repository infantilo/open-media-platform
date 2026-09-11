//! omp-decklink: Blackmagic-DeckLink-SDI/IP-Capture-Karte ⇄ MXL
//! (`UMSETZUNG.md` D10). Gerichtet je Instanz
//! (`OMP_DECKLINK_DIRECTION=ingest|output`, gleiches Muster wie
//! `omp-srt-gateway`/`omp-2110-gateway`):
//!
//! - **Ingest** (Teil 1, Default): Karte → MXL, reine Live-Quelle wie
//!   `omp-source` (`nodes/omp-source/src/main.rs`, hier als Vorlage
//!   übernommen), aber echte Hardware-Erfassung statt `videotestsrc`/
//!   `audiotestsrc`. Modus/Gerät fix per Env-Var (`OMP_DECKLINK_*`).
//! - **Output** (Teil 2): MXL → Karte, Quellwahl per echtem IS-05-
//!   Receiver-PATCH (Flow-Editor drag&drop), gleiches Muster wie
//!   `omp-2110-gateway`s Output-Richtung + `omp-recorder`s zwei
//!   unabhängige Video-/Audio-Receiver (Details `pipeline.rs`-Moduldoku).
//!
//! Mehrfach instanziierbar (`OMP_LABEL`/`OMP_PORT`), je eine Instanz pro
//! physischem DeckLink-Gerät (`OMP_DECKLINK_DEVICE_NUMBER`) und Richtung
//! — dieselbe Karte kann NICHT gleichzeitig von einer Ingest- und einer
//! Output-Instanz belegt werden (Blackmagic-Treiber-Grenze, kein
//! OMP-Check dafür in dieser Runde, s. `docs/decisions.md`).

mod pipeline;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_node_sdk::connection::{
    bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery, ReceiverConnection,
    ReceiverControl, ReceiverResource,
};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, LatencyInfo, LatencyRange, NodeConfig, ParamSpec, ParamStore,
    ParamType, Range, RawResponse, ReceiverSpec, SenderSpec, SetError,
};
use pipeline::SAMPLE_RATE;
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Direction {
    Ingest,
    Output,
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

// ---------------------------------------------------------------------
// Ingest (Teil 1)
// ---------------------------------------------------------------------

struct IngestStore {
    flow_id: String,
    audio_flow_id: String,
    device_number: i32,
    mode: String,
    audio_channels: u32,
    signal: Arc<AtomicBool>,
    /// AMWA BCP-008-01 (NMOS Receiver Status Monitoring, `docs/
    /// decisions.md` BCP-008-Nachtrag): Ingest empfängt echtes SDI/IP-
    /// Signal über die Karte, ist also der "Receiver" dieser Instanz.
    /// Immer aktiv (keine Enable/Disable-Semantik wie bei Output),
    /// `monitor.activate()` direkt nach dem Pipeline-Start.
    monitor: Arc<omp_node_sdk::Monitor>,
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
                name: "signal".to_string(),
                kind: ParamType::Boolean,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "deviceNumber".to_string(),
                kind: ParamType::Number,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "mode".to_string(),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum {
                    values: pipeline::SUPPORTED_MODES.iter().map(|m| m.to_string()).collect(),
                }),
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
                name: "flowId".to_string(),
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
        ];
        parameters.extend(self.monitor.param_specs("monitor"));
        Descriptor {
            // Eine Hardware-Erfassung setzt selbst den Ursprung, wie
            // omp-source (dortige Begründung 1:1 übernommen) — keine
            // zusätzliche Latenz messbar, da es keinen MXL-Eingang gibt.
            latency: Some(LatencyInfo {
                video: Some(LatencyRange { min_latency_frames: 0, max_latency_frames: 0 }),
                audio: None,
                data: None,
                supports_delay_compensation: false,
            }),
            parameters,
            methods: self.monitor.method_specs("monitor"),
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "direction" => Some(serde_json::json!("ingest")),
            "signal" => Some(serde_json::json!(self.signal.load(Ordering::Relaxed))),
            "deviceNumber" => Some(serde_json::json!(self.device_number)),
            "mode" => Some(serde_json::json!(self.mode)),
            "audioChannels" => Some(serde_json::json!(self.audio_channels)),
            "flowId" => Some(serde_json::json!(self.flow_id)),
            "audioFlowId" => Some(serde_json::json!(self.audio_flow_id)),
            // Keine Paketverlust-Erkennung auf SDI/IP-Hardware-Ebene
            // verfügbar (anders als `omp-2110-gateway`s `rtpjitter
            // buffer`) — leere Zählerliste statt erfundener Werte.
            _ => self.monitor.get("monitor", name, None, Vec::new),
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        match self.monitor.set("monitor", name, &value) {
            Some(true) => Ok(()),
            Some(false) => Err(SetError::Unknown),
            None => Err(SetError::Unknown),
        }
    }

    fn invoke(
        &self,
        name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        if self.monitor.invoke("monitor", name) {
            Ok(())
        } else {
            Err(InvokeError::Unknown)
        }
    }
}

// ---------------------------------------------------------------------
// Output (Teil 2)
// ---------------------------------------------------------------------

/// Gemeinsam für Video- und Audio-Receiver (nur unterschiedlich, welche
/// `OutputPipelineHandle`-Methode sie beim Verbinden/Trennen rufen) —
/// löst `sender_id` über die Registry auf eine MXL-`flow_id` auf, genau
/// wie `omp-2110-gateway::OutputControl`/`omp-recorder::
/// RecorderReceiverControl`.
struct OutputControl {
    registry: RegistryClient,
    pipeline: pipeline::OutputPipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
    is_video: bool,
    /// S. `OutputStore::monitor`-Doku. Nur die Video-`OutputControl`
    /// ruft `activate()`/`deactivate()` — Video ist die Anker-
    /// Verbindung (Moduldoku oben: ohne sie baut `build_output` gar
    /// keine Pipeline), Audio kann unabhängig kommen/gehen, ohne den
    /// Aktivitätszustand des Senders selbst zu ändern.
    monitor: Arc<omp_node_sdk::Monitor>,
}

impl ReceiverControl for OutputControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        if self.is_video {
                            self.pipeline.connect_video(flow_id);
                            self.monitor.activate();
                        } else {
                            self.pipeline.connect_audio(flow_id);
                        }
                    }
                    None => eprintln!("omp-decklink: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-decklink: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                if self.is_video {
                    self.pipeline.disconnect_video();
                    self.monitor.deactivate();
                } else {
                    self.pipeline.disconnect_audio();
                }
            }
        }
    }
}

struct OutputStore {
    device_number: i32,
    mode: String,
    audio_channels: u32,
    connected_video_flow_id: Arc<Mutex<String>>,
    connected_audio_flow_id: Arc<Mutex<String>>,
    video_connection: Arc<ReceiverConnection<OutputControl>>,
    audio_connection: Arc<ReceiverConnection<OutputControl>>,
    /// AMWA BCP-008-02 (NMOS Sender Status Monitoring) — Output sendet
    /// echtes SDI/IP-Signal über die Karte, ist also der "Sender"
    /// dieser Instanz. Aktiv/inaktiv folgt der Video-Receiver-
    /// Verbindung (s. `OutputControl::apply`), nicht dem Prozess-
    /// Lebenszyklus.
    monitor: Arc<omp_node_sdk::Monitor>,
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
                name: "deviceNumber".to_string(),
                kind: ParamType::Number,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "mode".to_string(),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum {
                    values: pipeline::SUPPORTED_MODES.iter().map(|m| m.to_string()).collect(),
                }),
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
                name: "connectedVideoFlowId".to_string(),
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
        ];
        parameters.extend(self.monitor.param_specs("monitor"));
        Descriptor { latency: None, parameters, methods: self.monitor.method_specs("monitor") }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "direction" => Some(serde_json::json!("output")),
            "deviceNumber" => Some(serde_json::json!(self.device_number)),
            "mode" => Some(serde_json::json!(self.mode)),
            "audioChannels" => Some(serde_json::json!(self.audio_channels)),
            "connectedVideoFlowId" => Some(serde_json::json!(
                *self.connected_video_flow_id.lock().expect("lock poisoned")
            )),
            "connectedAudioFlowId" => Some(serde_json::json!(
                *self.connected_audio_flow_id.lock().expect("lock poisoned")
            )),
            // Kein Rückkanal von einem echten SDI-/IP-Empfänger — leere
            // Zählerliste statt erfundener Werte (s. `IngestStore::get`).
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

    fn invoke(
        &self,
        name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        if self.monitor.invoke("monitor", name) {
            Ok(())
        } else {
            Err(InvokeError::Unknown)
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        root_discovery(method, path)
            .or_else(|| {
                list_ids(
                    method,
                    path,
                    "receivers",
                    &[self.video_connection.id(), self.audio_connection.id()],
                )
            })
            .or_else(|| bulk_discovery(method, path))
            .or_else(|| {
                bulk_patch(method, path, "receivers", body, |id, params| {
                    if self.video_connection.id() == id {
                        Some(self.video_connection.patch_staged(params).0)
                    } else if self.audio_connection.id() == id {
                        Some(self.audio_connection.patch_staged(params).0)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| bulk_patch(method, path, "senders", body, |_, _| None))
            .or_else(|| self.video_connection.handle(method, path, body))
            .or_else(|| self.audio_connection.handle(method, path, body))
            .map(to_raw)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.video_connection
            .cors_methods(path)
            .or_else(|| self.audio_connection.cors_methods(path))
            .or_else(|| bulk_cors_methods(path, "senders"))
            .or_else(|| bulk_cors_methods(path, "receivers"))
    }
}

/// BCP-008-Tick für die Ingest-Richtung (`omp_node_sdk::MonitorKind::
/// Receiver`) — s. `omp-2110-gateway::main::spawn_ingest_monitor_tick`-
/// Doku (gleiche Kadenz/Begründung). `link`/`streamStatus` stützen sich
/// hier auf `signal` (`decklinkvideosrc`s echtes Kabel-/Format-Lock-
/// Signal, bereits vom Event-Loop aktuell gehalten, s. `Event::
/// SignalChanged`) — anders als bei `omp-2110-gateway` gibt es hier
/// tatsächlich ein physisches Link-Signal, kein `AllUp`-Dauerzustand.
/// `connectionStatus` bekommt hier nur den optimistischen Healthy-Tick;
/// die Verschlechterung kommt event-getrieben direkt aus dem
/// `Event::Error`-Zweig der aufrufenden `main()` (kein GStreamer-Bus-
/// Doppel-Poll nötig). `externalSynchronizationStatus` bleibt dauerhaft
/// `NotUsed` (kein PTP-/Genlock-Signal in diesem Node verfügbar) — dafür
/// bewusst kein `observe()`-Aufruf hier, `Monitor::new` startet ihn
/// bereits neutral.
fn spawn_decklink_monitor_tick(monitor: Arc<omp_node_sdk::Monitor>, signal: Arc<AtomicBool>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let delay = monitor.status_reporting_delay();
            let level = if signal.load(Ordering::Relaxed) {
                omp_node_sdk::HealthLevel::Healthy
            } else {
                omp_node_sdk::HealthLevel::Unhealthy
            };
            monitor.link.observe(level, delay, Some("kein Eingangssignal (decklinkvideosrc::signal=false)"));
            monitor.content.observe(level, delay, Some("kein Eingangssignal, kein dekodierbarer Stream"));
            monitor.activity.observe(omp_node_sdk::HealthLevel::Healthy, delay, None);
        }
    });
}

/// BCP-008-Tick für die Output-Richtung (`omp_node_sdk::MonitorKind::
/// Sender`) — s. `spawn_decklink_monitor_tick`-Doku. Kein physisches
/// Link-Readback auf der Ausgangsseite dieser Karte verfügbar (anders
/// als `signal` bei Ingest) — `linkStatus` bleibt deshalb dauerhaft auf
/// seinem `Monitor::new`-Startwert `AllUp` (ehrliche Grenze, s.
/// `docs/decisions.md` BCP-008-Nachtrag, gleiche Einschränkung wie bei
/// `omp-2110-gateway`s Output-Richtung). Nur relevant, solange verbunden
/// (`monitor.overall() == Neutral` prüft das, s. dortige Doku).
fn spawn_output_monitor_tick(monitor: Arc<omp_node_sdk::Monitor>, pipeline: pipeline::OutputPipelineHandle) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            if monitor.overall() == omp_node_sdk::HealthLevel::Neutral {
                continue;
            }
            let delay = monitor.status_reporting_delay();
            let level = if pipeline.media_ready() {
                omp_node_sdk::HealthLevel::Healthy
            } else {
                omp_node_sdk::HealthLevel::Unhealthy
            };
            monitor.content.observe(level, delay, Some("keine Bilder an die Karte seit dem letzten Tick"));
            monitor.activity.observe(omp_node_sdk::HealthLevel::Healthy, delay, None);
        }
    });
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "DeckLink");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9330").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let device_number: i32 = env_or("OMP_DECKLINK_DEVICE_NUMBER", "0").parse()?;
    let mode = env_or("OMP_DECKLINK_MODE", "1080p25");
    let audio_channels: u32 = env_or("OMP_DECKLINK_AUDIO_CHANNELS", "2").parse()?;
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let direction = match env_or("OMP_DECKLINK_DIRECTION", "ingest").as_str() {
        "output" => Direction::Output,
        _ => Direction::Ingest,
    };

    if pipeline::mode_info(&mode).is_none() {
        return Err(format!(
            "OMP_DECKLINK_MODE={mode:?} nicht unterstützt (unterstützt: {:?})",
            pipeline::SUPPORTED_MODES
        )
        .into());
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));

    match direction {
        Direction::Ingest => {
            // mode_info() bereits oben geprüft — hier nur noch entpackt.
            let mode_info = pipeline::mode_info(&mode).expect("mode already validated above");

            // Flow-UUID == MXL-flow-id-Konvention (`UMSETZUNG.md` C4).
            let flow_id = omp_node_sdk::idgen::new_v4();
            let audio_flow_id = omp_node_sdk::idgen::new_v4();

            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let pipeline_config = pipeline::IngestConfig {
                domain,
                flow_id: flow_id.clone(),
                audio_flow_id: audio_flow_id.clone(),
                label: label.clone(),
                device_number,
                mode: mode.clone(),
                audio_channels,
            };
            let pipeline_shutdown = shutdown.clone();
            let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
            let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
            let pipeline_thread = std::thread::spawn(move || {
                pipeline::run_ingest(pipeline_config, tx, pipeline_shutdown, ready_tx, pipeline_heartbeat_thread)
            });

            let pipeline_handle = match ready_rx.await {
                Ok(Ok(handle)) => handle,
                Ok(Err(e)) => {
                    eprintln!(
                        "omp-decklink: ingest pipeline build failed (device-number={device_number}, mode={mode}): {e}"
                    );
                    return Err(e.into());
                }
                Err(_) => {
                    eprintln!("omp-decklink: ingest pipeline thread ended before reporting readiness");
                    return Err("ingest pipeline thread ended before reporting readiness".into());
                }
            };

            let media_ready_pipeline = pipeline_handle.clone();
            let signal = Arc::new(AtomicBool::new(pipeline_handle.signal()));

            let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Receiver));
            // Ingest ist immer aktiv (keine Enable/Disable-Semantik,
            // anders als Output) — sofort aktivieren.
            monitor.activate();
            spawn_decklink_monitor_tick(monitor.clone(), signal.clone());

            let store: Arc<dyn ParamStore> = Arc::new(IngestStore {
                flow_id: flow_id.clone(),
                audio_flow_id: audio_flow_id.clone(),
                device_number,
                mode: mode.clone(),
                audio_channels,
                signal: signal.clone(),
                monitor: monitor.clone(),
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
                                frame_width: mode_info.width,
                                frame_height: mode_info.height,
                                grain_rate_numerator: mode_info.fps_numerator,
                                grain_rate_denominator: mode_info.fps_denominator,
                            }),
                            tags: HashMap::new(),
                            ..Default::default()
                        },
                        SenderSpec {
                            transport: Some(TRANSPORT_MXL.to_string()),
                            flow: Some(FlowSpec::Audio {
                                id: Some(audio_flow_id),
                                sample_rate_numerator: SAMPLE_RATE,
                                channel_count: audio_channels,
                                media_type: "audio/float32".to_string(),
                                bit_depth: 32,
                            }),
                            ..Default::default()
                        },
                    ],
                    receivers: vec![],
                    instance_id,
                    // Wie omp-source: echter Nachweis geflossener
                    // Video-Buffer, kein hartkodiertes `true`
                    // (ARCHITECTURE.md §5 Punkt 6).
                    media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                        media_ready_pipeline.media_ready()
                    })),
                },
                store,
            )
            .await?;

            handle.register_worker("pipeline", pipeline_heartbeat);

            let events = async {
                while let Some(event) = rx.recv().await {
                    match event {
                        pipeline::Event::Error(message) => {
                            eprintln!("omp-decklink: pipeline error: {message}");
                            // Sofortige Verschlechterung (s.
                            // `spawn_decklink_monitor_tick`-Doku) — der
                            // Tick pusht danach weiter optimistisch
                            // Healthy, `DebouncedDomain` entscheidet
                            // selbst, ob/wann das als Erholung zählt.
                            monitor.activity.observe(
                                omp_node_sdk::HealthLevel::Unhealthy,
                                monitor.status_reporting_delay(),
                                Some(&message),
                            );
                            handle.publish_alert(message).await;
                        }
                        pipeline::Event::SignalChanged(ok) => {
                            signal.store(ok, Ordering::Relaxed);
                            eprintln!(
                                "omp-decklink: signal [{device_number}]: {}",
                                if ok { "OK" } else { "KEIN SIGNAL" }
                            );
                            if !ok {
                                handle
                                    .publish_alert(format!(
                                        "DeckLink device-number={device_number}: kein Eingangssignal"
                                    ))
                                    .await;
                            }
                        }
                    }
                }
            };

            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    eprintln!("omp-decklink: shutdown requested");
                }
                _ = events => {
                    eprintln!("omp-decklink: pipeline thread ended");
                }
            }

            shutdown.store(true, Ordering::Relaxed);
            let _ = pipeline_thread.join();
        }
        Direction::Output => {
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let pipeline_config = pipeline::OutputConfig {
                domain,
                device_number,
                mode: mode.clone(),
                audio_channels,
            };
            let pipeline_shutdown = shutdown.clone();
            let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
            let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
            let pipeline_thread = std::thread::spawn(move || {
                pipeline::run_output(pipeline_config, tx, pipeline_shutdown, ready_tx, pipeline_heartbeat_thread)
            });

            let pipeline_handle = match ready_rx.await {
                Ok(Ok(handle)) => handle,
                Ok(Err(e)) => {
                    eprintln!("omp-decklink: output pipeline init failed: {e}");
                    return Err(e.into());
                }
                Err(_) => {
                    eprintln!("omp-decklink: output pipeline thread ended before reporting readiness");
                    return Err("output pipeline thread ended before reporting readiness".into());
                }
            };

            let video_receiver_id = omp_node_sdk::idgen::new_v4();
            let audio_receiver_id = omp_node_sdk::idgen::new_v4();
            let registry = RegistryClient::new(registry_url.clone());
            let connected_video_flow_id = Arc::new(Mutex::new(String::new()));
            let connected_audio_flow_id = Arc::new(Mutex::new(String::new()));

            let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Sender));
            // Startzustand `Inactive` (noch kein Video-Connect erfolgt)
            // — `OutputControl::apply` übernimmt `activate()`/
            // `deactivate()` bei jedem echten Video-Connect/-Disconnect.
            monitor.deactivate();
            spawn_output_monitor_tick(monitor.clone(), pipeline_handle.clone());

            let video_connection = Arc::new(ReceiverConnection::new(
                video_receiver_id.clone(),
                OutputControl {
                    registry: registry.clone(),
                    pipeline: pipeline_handle.clone(),
                    connected_flow_id: connected_video_flow_id.clone(),
                    is_video: true,
                    monitor: monitor.clone(),
                },
            ));
            let audio_connection = Arc::new(ReceiverConnection::new(
                audio_receiver_id.clone(),
                OutputControl {
                    registry,
                    pipeline: pipeline_handle.clone(),
                    connected_flow_id: connected_audio_flow_id.clone(),
                    is_video: false,
                    monitor: monitor.clone(),
                },
            ));

            let media_ready_pipeline = pipeline_handle.clone();
            let store: Arc<dyn ParamStore> = Arc::new(OutputStore {
                device_number,
                mode: mode.clone(),
                audio_channels,
                connected_video_flow_id,
                connected_audio_flow_id,
                video_connection,
                audio_connection,
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
                    receivers: vec![
                        ReceiverSpec {
                            id: Some(video_receiver_id),
                            transport: Some(TRANSPORT_MXL.to_string()),
                            media_types: Some(vec!["video/v210".to_string()]),
                            label: Some("Video".to_string()),
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

            handle.register_worker("pipeline", pipeline_heartbeat);

            let events = async {
                while let Some(event) = rx.recv().await {
                    match event {
                        pipeline::Event::Error(message) => {
                            eprintln!("omp-decklink: pipeline error: {message}");
                            // S. `spawn_decklink_monitor_tick`-Doku —
                            // nur relevant, solange verbunden, sonst hat
                            // `deactivate()` `activity` schon auf
                            // `Inactive` gesetzt und ein `observe()` hier
                            // würde das unnötig überschreiben.
                            if monitor.overall() != omp_node_sdk::HealthLevel::Neutral {
                                monitor.activity.observe(
                                    omp_node_sdk::HealthLevel::Unhealthy,
                                    monitor.status_reporting_delay(),
                                    Some(&message),
                                );
                            }
                            handle.publish_alert(message).await;
                        }
                        pipeline::Event::SignalChanged(_) => {
                            // Nur relevant für Ingest (`signal`-Property
                            // von `decklinkvideosrc`) — Output nutzt
                            // diesen Event-Zweig nicht, s. `pipeline.rs`.
                        }
                    }
                }
            };

            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    eprintln!("omp-decklink: shutdown requested");
                }
                _ = events => {
                    eprintln!("omp-decklink: pipeline thread ended");
                }
            }

            shutdown.store(true, Ordering::Relaxed);
            let _ = pipeline_thread.join();
        }
    }

    Ok(())
}

#[cfg(test)]
mod bcp008_tests {
    use super::*;

    // `IngestStore` braucht keine echte Hardware/Pipeline (alle Felder
    // sind einfache Werte/Handles) — deshalb hier direkt gegen sie
    // getestet, ohne ein echtes DeckLink-Gerät zu brauchen (in dieser
    // Sandbox sowieso nicht vorhanden, s. `docs/decisions.md`
    // BCP-008-Nachtrag: "ohne Hardware getestet", gleiche Grenze wie
    // beim ursprünglichen D10-Teil-1/2). `OutputStore` teilt sich
    // dieselbe `Monitor`-Dispatch-Logik (`monitor.get`/`set`/`invoke`),
    // ein zweiter Test dafür wäre redundant.
    fn store() -> IngestStore {
        IngestStore {
            flow_id: "flow-1".to_string(),
            audio_flow_id: "flow-2".to_string(),
            device_number: 0,
            mode: "1080p25".to_string(),
            audio_channels: 2,
            signal: Arc::new(AtomicBool::new(true)),
            monitor: Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Receiver)),
        }
    }

    #[test]
    fn descriptor_includes_bcp008_monitor_params_and_methods() {
        let d = store().descriptor();
        let names: Vec<&str> = d.parameters.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"monitor.overallStatus"));
        assert!(names.contains(&"monitor.connectionStatus"), "receiver-side wire name expected");
        assert!(names.contains(&"monitor.streamStatus"));
        assert!(names.contains(&"monitor.linkStatus"));
        assert!(names.contains(&"monitor.statusReportingDelay"));
        assert_eq!(d.methods.len(), 1);
        assert_eq!(d.methods[0].name, "monitor.resetCountersAndMessages");
    }

    #[test]
    fn get_dispatches_monitor_params_alongside_own_params() {
        let s = store();
        assert_eq!(s.get("signal"), Some(serde_json::json!(true)));
        s.monitor.activate();
        assert_eq!(s.get("monitor.overallStatus"), Some(serde_json::json!("Healthy")));
        assert_eq!(s.get("monitor.lostPacketCounters"), Some(serde_json::json!([])));
    }

    #[test]
    fn set_writes_through_to_monitor_config() {
        let s = store();
        assert!(s.set("monitor.statusReportingDelay", serde_json::json!(5000)).is_ok());
        assert_eq!(s.monitor.status_reporting_delay(), Duration::from_millis(5000));
        assert!(matches!(s.set("monitor.overallStatus", serde_json::json!("Healthy")), Err(SetError::Unknown)));
    }

    #[test]
    fn invoke_reset_clears_monitor_counters() {
        let s = store();
        s.monitor.link.observe(omp_node_sdk::HealthLevel::Unhealthy, Duration::ZERO, Some("no cable"));
        assert_eq!(s.monitor.link.transition_counter(), 1);
        assert!(s.invoke("monitor.resetCountersAndMessages", &serde_json::Map::new()).is_ok());
        assert_eq!(s.monitor.link.transition_counter(), 0);
        assert!(matches!(s.invoke("unknownMethod", &serde_json::Map::new()), Err(InvokeError::Unknown)));
    }
}
