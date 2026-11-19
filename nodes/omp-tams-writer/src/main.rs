//! omp-tams-writer (Kapitel 105.3): MXL-Quelle (Video + Audio) → TAMS-Speicher (API 8.2).
//!
//! Zwei IS-05-Receiver (Video/Audio, wie `omp-recorder`), Methoden `tams.start`/`tams.stop`. Der Node nimmt **nur**
//! als Client auf; der Speicher ist ein fremder Dienst (Entscheidung D-T2).
//!
//! Einstellung per Umgebung (Zugangsdaten nur aus Datei oder Umgebung, nie aus Parametern — Entscheidung D-T3):
//! * `OMP_TAMS_URL`            Basisadresse inkl. Versionspfad, z. B. `https://tams.example/tams/v8.2` (TLS Pflicht, außer Loopback)
//! * `OMP_TAMS_AUTH`           `none` (Standard) | `bearer` | `basic` | `url_token`
//! * `OMP_TAMS_USER`           Benutzername bei `basic`
//! * `OMP_TAMS_TOKEN_FILE`     Datei mit dem Token/Passwort (Rechte höchstens 0600) — oder `OMP_TAMS_TOKEN`
//! * `OMP_TAMS_SPOOL_DIR`      Warteschlange (Standard `/var/tmp/omp-tams-spool/<instanz>`)
//! * `OMP_TAMS_SPOOL_MAX_MB`   Obergrenze der Warteschlange (Standard 2048); darüber werden die ältesten Segmente verworfen
//! * `OMP_TAMS_SEGMENT_SECONDS` Segmentlänge (Standard 2; wirksam an der nächsten GOP-Grenze)
//! * `OMP_TAMS_VIDEO_KBPS`, `OMP_TAMS_AUDIO_BPS`  Bitraten (Standard 4000 kbit/s und 192000 bit/s)

use omp_node_sdk::connection::{
    ReceiverConnection, ReceiverControl, ReceiverResource, bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery,
};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{Descriptor, InvokeError, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, Range, RawResponse, ReceiverSpec, SetError};
use omp_tams::auth::{Auth, redact_url, secret_from_env};
use omp_tams::client::{Client, ClientConfig};
use omp_tams_writer::runtime::{self, Handle, RecStatus};
use omp_tams_writer::spool::Spool;
use omp_tams_writer::uploader::{FlowRegistry, Uploader, UploaderStatus};
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

struct WriterReceiverControl {
    registry: RegistryClient,
    handle: Handle,
    is_video: bool,
}

impl ReceiverControl for WriterReceiverControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) if self.is_video => self.handle.connect_video(flow_id),
                    Some(flow_id) => self.handle.connect_audio(flow_id),
                    None => eprintln!("omp-tams-writer: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-tams-writer: resolve sender {sender_id} failed: {e}"),
            },
            _ if self.is_video => self.handle.disconnect_video(),
            _ => self.handle.disconnect_audio(),
        }
    }
}

struct WriterStore {
    handle: Handle,
    /// `None`, wenn kein Speicher eingerichtet ist: der Grund steht dann hier (und `tams.start` lehnt ab).
    config_problem: Option<String>,
    uploader: Arc<UploaderStatus>,
    service_display: String,
    video_connection: Arc<ReceiverConnection<WriterReceiverControl>>,
    audio_connection: Arc<ReceiverConnection<WriterReceiverControl>>,
    monitor: Arc<omp_node_sdk::Monitor>,
}

fn num(name: &str, unit: Option<&str>) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind: ParamType::Number, unit: unit.map(str::to_string), range: None, readonly: true }
}
fn text(name: &str) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind: ParamType::String, unit: None, range: None, readonly: true }
}

impl ParamStore for WriterStore {
    fn descriptor(&self) -> Descriptor {
        let mut parameters = vec![
            ParamSpec {
                name: "tams.status".to_string(),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum { values: vec!["idle".to_string(), "recording".to_string(), "error".to_string()] }),
                readonly: true,
            },
            ParamSpec { name: "tams.connected".to_string(), kind: ParamType::Boolean, unit: None, range: None, readonly: true },
            text("tams.service"),
            num("tams.queueSegments", None),
            num("tams.queueBytes", Some("B")),
            num("tams.registered", None),
            num("tams.rejected", None),
            num("tams.droppedOverflow", None),
            num("tams.segmentsWritten", None),
            num("tams.errors", None),
            num("tams.lagMs", Some("ms")),
            text("tams.lastError"),
        ];
        parameters.extend(self.monitor.param_specs("monitor"));
        let mut methods = vec![MethodSpec { name: "tams.start".to_string(), args: vec![] }, MethodSpec { name: "tams.stop".to_string(), args: vec![] }];
        methods.extend(self.monitor.method_specs("monitor"));
        Descriptor { latency: None, parameters, methods }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let u = &self.uploader;
        match name {
            "tams.status" => Some(serde_json::json!(self.handle.status().as_str())),
            "tams.connected" => Some(serde_json::json!(u.connected.load(Ordering::Relaxed))),
            // nur Adresse ohne Token (D-T3)
            "tams.service" => Some(serde_json::json!(self.service_display)),
            "tams.queueSegments" => Some(serde_json::json!(u.queue_segments.load(Ordering::Relaxed))),
            "tams.queueBytes" => Some(serde_json::json!(u.queue_bytes.load(Ordering::Relaxed))),
            "tams.registered" => Some(serde_json::json!(u.registered.load(Ordering::Relaxed))),
            "tams.rejected" => Some(serde_json::json!(u.rejected.load(Ordering::Relaxed))),
            "tams.droppedOverflow" => Some(serde_json::json!(u.dropped_overflow.load(Ordering::Relaxed))),
            "tams.segmentsWritten" => Some(serde_json::json!(self.handle.counters.segments_written.load(Ordering::Relaxed))),
            "tams.errors" => Some(serde_json::json!(u.errors.load(Ordering::Relaxed))),
            "tams.lagMs" => Some(serde_json::json!(u.lag_ms.load(Ordering::Relaxed))),
            "tams.lastError" => Some(serde_json::json!(self.config_problem.clone().unwrap_or_else(|| u.error_text()))),
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
        match name {
            "tams.start" => {
                if let Some(p) = &self.config_problem {
                    return Err(InvokeError::Message(format!("kein TAMS-Speicher eingerichtet: {p}")));
                }
                match self.handle.start() {
                    Ok(()) => {
                        self.monitor.activate();
                        Ok(())
                    }
                    Err(e) => {
                        let delay = self.monitor.status_reporting_delay();
                        self.monitor.activity.observe(omp_node_sdk::HealthLevel::Unhealthy, delay, Some(&e));
                        self.monitor.content.observe(omp_node_sdk::HealthLevel::Unhealthy, delay, Some(&e));
                        Err(InvokeError::Message(e))
                    }
                }
            }
            "tams.stop" => match self.handle.stop() {
                Ok(()) => {
                    self.monitor.deactivate();
                    Ok(())
                }
                Err(e) => Err(InvokeError::Message(e)),
            },
            _ => {
                if self.monitor.invoke("monitor", name) {
                    Ok(())
                } else {
                    Err(InvokeError::Unknown)
                }
            }
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        root_discovery(method, path)
            .or_else(|| list_ids(method, path, "receivers", &[self.video_connection.id(), self.audio_connection.id()]))
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

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

/// Client aus der Umgebung. `Err(Grund)` statt Absturz: der Node läuft trotzdem und zeigt den Grund an.
fn client_from_env() -> Result<(Client, String), String> {
    let url = std::env::var("OMP_TAMS_URL").map_err(|_| "OMP_TAMS_URL nicht gesetzt".to_string())?;
    let secret = secret_from_env().map_err(|e| e.to_string())?;
    let user = std::env::var("OMP_TAMS_USER").ok();
    let auth = Auth::from_parts(&env_or("OMP_TAMS_AUTH", "none"), user.as_deref(), secret)?;
    let display = redact_url(&url);
    let client = Client::new(ClientConfig::new(url, auth)).map_err(|e| e.to_string())?;
    Ok((client, display))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "TAMS-Aufnahme");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9360").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let spool_dir = std::env::var("OMP_TAMS_SPOOL_DIR").unwrap_or_else(|_| format!("/var/tmp/omp-tams-spool/{}", instance_id.clone().unwrap_or_else(|| port.to_string())));
    let spool_max: u64 = env_or("OMP_TAMS_SPOOL_MAX_MB", "2048").parse::<u64>().unwrap_or(2048).max(16) << 20;
    let spool = Arc::new(Spool::open(&spool_dir, spool_max)?);
    let flow_registry = FlowRegistry::new(spool.clone(), vec![]);

    let (client_result, shutdown) = (client_from_env(), Arc::new(AtomicBool::new(false)));
    let mut upload_status = Arc::new(UploaderStatus::default());
    let mut config_problem = None;
    let mut service_display = String::new();
    let mut uploader_thread = None;
    match client_result {
        Ok((client, display)) => {
            service_display = display;
            let uploader = Uploader::new(client, spool.clone(), flow_registry.clone(), Box::new(omp_mediaio::timebase::tai_now_ns));
            upload_status = uploader.status.clone();
            let sd = shutdown.clone();
            uploader_thread = Some(std::thread::spawn(move || uploader.run(sd)));
        }
        Err(e) => {
            eprintln!("omp-tams-writer: {e}");
            config_problem = Some(e);
        }
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<runtime::Event>();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let cfg = runtime::Config {
        domain,
        spool,
        registry: flow_registry,
        segment_s: env_or("OMP_TAMS_SEGMENT_SECONDS", "2").parse::<u32>().unwrap_or(2).clamp(1, 30),
        video_kbps: env_or("OMP_TAMS_VIDEO_KBPS", "4000").parse().unwrap_or(4000),
        audio_bps: env_or("OMP_TAMS_AUDIO_BPS", "192000").parse().unwrap_or(192_000),
        uploader_status: upload_status.clone(),
    };
    let pipeline_shutdown = shutdown.clone();
    let heartbeat = Arc::new(AtomicU64::new(0));
    let hb = heartbeat.clone();
    let pipeline_thread = std::thread::spawn(move || runtime::run(cfg, tx, pipeline_shutdown, ready_tx, hb));
    let handle = match ready_rx.await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            eprintln!("omp-tams-writer: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => return Err("pipeline thread ended before reporting readiness".into()),
    };

    let video_receiver_id = omp_node_sdk::idgen::new_v4();
    let audio_receiver_id = omp_node_sdk::idgen::new_v4();
    let registry = RegistryClient::new(registry_url.clone());
    let video_connection = Arc::new(ReceiverConnection::new(video_receiver_id.clone(), WriterReceiverControl { registry: registry.clone(), handle: handle.clone(), is_video: true }));
    let audio_connection = Arc::new(ReceiverConnection::new(audio_receiver_id.clone(), WriterReceiverControl { registry, handle: handle.clone(), is_video: false }));
    let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Receiver));
    monitor.deactivate();
    let media_handle = handle.clone();
    let store: Arc<dyn ParamStore> = Arc::new(WriterStore { handle, config_problem, uploader: upload_status, service_display, video_connection, audio_connection, monitor: monitor.clone() });

    let node = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![],
            receivers: vec![
                ReceiverSpec { id: Some(video_receiver_id), transport: Some(TRANSPORT_MXL.to_string()), media_types: Some(vec!["video/v210".to_string()]), label: Some("Video".to_string()), ..Default::default() },
                ReceiverSpec { id: Some(audio_receiver_id), transport: Some(TRANSPORT_MXL.to_string()), media_types: Some(vec!["audio/L24".to_string()]), label: Some("Audio".to_string()), ..Default::default() },
            ],
            instance_id,
            // Im Leerlauf ist der Node als Senke ohne Ausgänge bereit; während der Aufnahme: sobald ein Puffer kam
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_handle.status() != RecStatus::Recording || media_handle.media_ready())),
        },
        store,
    )
    .await?;
    node.register_worker("pipeline", heartbeat);

    let events = async {
        while let Some(runtime::Event::Warning(message)) = rx.recv().await {
            eprintln!("omp-tams-writer: {message}");
            let delay = monitor.status_reporting_delay();
            monitor.activity.observe(omp_node_sdk::HealthLevel::Unhealthy, delay, Some(&message));
            node.publish_alert(message).await;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-tams-writer: shutdown requested"),
        _ = events => eprintln!("omp-tams-writer: pipeline thread ended"),
    }
    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();
    if let Some(t) = uploader_thread {
        let _ = t.join();
    }
    Ok(())
}
