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
//! * `OMP_TAMS_RETENTION_HOURS` Aufbewahrung der eigenen Flows (Standard 0 = unbegrenzt); Tag `segment_retention_offset` + Löschlauf (AppNote 0019)
//! * `OMP_TAMS_FLOW_RETENTION_HOURS` ganze Flows löschen, wenn so lange unverändert (Standard 0 = nie); Tag `flow_retention_offset`
//! * `OMP_TAMS_EMPTY_FLOW_HOURS` leere Flows ohne Segmente nach so vielen Stunden aufräumen (Standard 0 = nie)
//! * `OMP_TAMS_CONTAINER`      `mpegts` (Standard) | `mp4` (fragmentiertes MP4 mit Init-Segment, AppNote 0024; ISO-BMFF-Fragmente wie `qtmux`, keine CMAF-Markenprüfung)
//! * `OMP_TAMS_SEGMENT_SECONDS` Segmentlänge (Standard 2; wirksam an der nächsten GOP-Grenze)
//! * `OMP_TAMS_VIDEO_KBPS`, `OMP_TAMS_AUDIO_BPS`  Bitraten (Standard 4000 kbit/s und 192000 bit/s)

mod uibundle;
use omp_node_sdk::connection::{
    ReceiverConnection, ReceiverControl, ReceiverResource, bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery,
};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, Range, RawResponse, ReceiverSpec, SetError};
use omp_tams::auth::{Auth, redact_url, secret_from_env};
use omp_tams::client::{Client, ClientConfig};
use omp_tams_writer::runtime::{self, Handle, RecStatus};
use omp_tams_writer::spool::Spool;
use omp_tams_writer::uploader::{FlowRegistry, Uploader, UploaderStatus};
use serde_json::Value;
use std::sync::{Arc, Mutex};
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
    /// Zweiter Client für Metadaten-Kopien (Zugang wie der Uploader, Entscheidung D-T3); `None` ohne Einrichtung.
    copier: Option<Arc<Client>>,
    copy_state: Arc<Mutex<CopyState>>,
    retention_s: u64,
    retention: Arc<omp_tams_writer::retention::RetentionStats>,
}

#[derive(Default, Clone)]
struct CopyState {
    /// `idle` | `running` | `done` | `error`
    status: String,
    /// JSON des letzten Ergebnisses bzw. die Fehlermeldung
    result: String,
}

fn num(name: &str, unit: Option<&str>) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind: ParamType::Number, unit: unit.map(str::to_string), range: None, readonly: true }
}
fn text(name: &str) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind: ParamType::String, unit: None, range: None, readonly: true }
}

/// Flow-ID muss eine UUID sein (nie in einen Pfad gesetzt, was keine ist).
fn uuid_arg(args: &serde_json::Map<String, Value>, key: &str) -> Result<Option<String>, InvokeError> {
    match args.get(key).and_then(Value::as_str).map(str::trim) {
        None | Some("") => Ok(None),
        Some(s) if s.len() == 36 && s.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() }) => Ok(Some(s.to_string())),
        Some(_) => Err(InvokeError::Message(format!("{key}: keine gültige Flow-ID (UUID)"))),
    }
}

impl WriterStore {
    /// `tams.copyRange`: Metadaten-Kopie (neuer Flow, gleiche Objects) je angegebenem Flow. Läuft im Hintergrund
    /// (`tams.copyStatus`, Ergebnis als JSON in `tams.lastCopy`), damit der Node nicht blockiert.
    fn copy_range(&self, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let client = self.copier.clone().ok_or_else(|| InvokeError::Message("kein TAMS-Speicher eingerichtet".into()))?;
        let (video, audio) = (uuid_arg(args, "videoFlow")?, uuid_arg(args, "audioFlow")?);
        if video.is_none() && audio.is_none() {
            return Err(InvokeError::Message("weder videoFlow noch audioFlow angegeben".into()));
        }
        let ts = |k: &str| -> Result<i128, InvokeError> {
            let t = args.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("");
            omp_tams::time::Timestamp::parse(t).map(|x| x.ns()).map_err(|e| InvokeError::Message(format!("{k}: kein Zeitstempel (Sekunden:Nanosekunden): {e}")))
        };
        let (start, end) = (ts("start")?, ts("end")?);
        if end <= start {
            return Err(InvokeError::Message("Ende liegt nicht nach dem Anfang".into()));
        }
        let label = args.get("label").and_then(Value::as_str).map(str::trim).filter(|l| !l.is_empty()).map(|l| l.chars().take(120).collect::<String>());
        {
            let mut st = self.copy_state.lock().expect("lock poisoned");
            if st.status == "running" {
                return Err(InvokeError::Message("eine Kopie läuft bereits".into()));
            }
            *st = CopyState { status: "running".into(), result: String::new() };
        }
        let state = self.copy_state.clone();
        std::thread::spawn(move || {
            let range = omp_tams::copy::range_ns(start, end);
            let mut out = serde_json::Map::new();
            let mut failure = None;
            for (kind, flow) in [("video", video), ("audio", audio)] {
                let Some(flow) = flow else { continue };
                let (new_flow, new_source) = (omp_node_sdk::idgen::new_v4(), omp_node_sdk::idgen::new_v4());
                match omp_tams::copy::copy_range(&client, &flow, &new_flow, &new_source, label.as_deref(), range) {
                    Ok(r) => {
                        out.insert(kind.into(), serde_json::json!({"sourceFlow": flow, "flowId": r.flow_id, "sourceId": r.source_id, "segments": r.segments, "from": omp_tams::time::Timestamp::from_ns(r.from_ns).to_string(), "to": omp_tams::time::Timestamp::from_ns(r.to_ns).to_string()}));
                    }
                    Err(e) => {
                        failure = Some(format!("{kind}: {e}"));
                        break;
                    }
                }
            }
            let mut st = state.lock().expect("lock poisoned");
            match failure {
                None => *st = CopyState { status: "done".into(), result: Value::Object(out).to_string() },
                Some(f) => *st = CopyState { status: "error".into(), result: f },
            }
        });
        Ok(())
    }
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
            num("tams.retentionHours", Some("h")),
            num("tams.retentionRuns", None),
            num("tams.flowsDeleted", None),
            text("tams.copyStatus"),
            text("tams.lastCopy"),
        ];
        parameters.extend(self.monitor.param_specs("monitor"));
        let arg = |n: &str, k: ParamType| MethodArg { name: n.to_string(), kind: k };
        let mut methods = vec![
            MethodSpec { name: "tams.start".to_string(), args: vec![] },
            MethodSpec { name: "tams.stop".to_string(), args: vec![] },
            MethodSpec { name: "tams.copyRange".to_string(), args: vec![arg("videoFlow", ParamType::String), arg("audioFlow", ParamType::String), arg("start", ParamType::String), arg("end", ParamType::String), arg("label", ParamType::String)] },
        ];
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
            "tams.retentionHours" => Some(serde_json::json!(self.retention_s as f64 / 3600.0)),
            "tams.flowsDeleted" => Some(serde_json::json!(self.retention.flows_deleted.load(Ordering::Relaxed))),
            "tams.retentionRuns" => Some(serde_json::json!(self.retention.runs.load(Ordering::Relaxed))),
            "tams.copyStatus" => Some(serde_json::json!(self.copy_state.lock().expect("lock poisoned").status.clone())),
            "tams.lastCopy" => Some(serde_json::json!(self.copy_state.lock().expect("lock poisoned").result.clone())),
            "tams.lastError" => {
                let ret = self.retention.last_error.lock().expect("lock poisoned").clone();
                let base = self.config_problem.clone().unwrap_or_else(|| u.error_text());
                Some(serde_json::json!(if base.is_empty() { ret } else { base }))
            }
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

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
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
            "tams.copyRange" => self.copy_range(args),
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
        if let Some(r) = uibundle::route(method, path) {
            return Some(r);
        }
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

    let retention_s: u64 = env_or("OMP_TAMS_RETENTION_HOURS", "0").parse::<f64>().ok().filter(|h| *h > 0.0).map(|h| (h * 3600.0) as u64).unwrap_or(0);
    let hours = |key: &str| -> u64 { env_or(key, "0").parse::<f64>().ok().filter(|h| *h > 0.0).map(|h| (h * 3600.0) as u64).unwrap_or(0) };
    let policy = omp_tams_writer::retention::Policy { segment_s: retention_s, flow_s: hours("OMP_TAMS_FLOW_RETENTION_HOURS"), empty_flow_s: hours("OMP_TAMS_EMPTY_FLOW_HOURS") };
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
        registry: flow_registry.clone(),
        segment_s: env_or("OMP_TAMS_SEGMENT_SECONDS", "2").parse::<u32>().unwrap_or(2).clamp(1, 30),
        video_kbps: env_or("OMP_TAMS_VIDEO_KBPS", "4000").parse().unwrap_or(4000),
        audio_bps: env_or("OMP_TAMS_AUDIO_BPS", "192000").parse().unwrap_or(192_000),
        uploader_status: upload_status.clone(),
        retention_s,
        flow_retention_s: policy.flow_s,
        container: {
            let name = env_or("OMP_TAMS_CONTAINER", "mpegts");
            runtime::Container::from_name(&name).unwrap_or_else(|| {
                eprintln!("omp-tams-writer: OMP_TAMS_CONTAINER={name:?} unbekannt (mpegts|mp4) — nehme mpegts");
                runtime::Container::MpegTs
            })
        },
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
    let copier = client_from_env().ok().map(|(c, _)| Arc::new(c));
    let retention = Arc::new(omp_tams_writer::retention::RetentionStats::default());
    let mut retention_thread = None;
    if policy.active()
        && let Some(c) = copier.clone()
    {
        let (reg, sd, st) = (flow_registry.clone(), shutdown.clone(), retention.clone());
        retention_thread = Some(std::thread::spawn(move || omp_tams_writer::retention::run(c, reg, policy, std::time::Duration::from_secs(60), omp_mediaio::timebase::tai_now_ns, sd, st)));
    }
    let store: Arc<dyn ParamStore> = Arc::new(WriterStore { retention_s, retention, copier, copy_state: Arc::new(Mutex::new(CopyState { status: "idle".into(), result: String::new() })), handle, config_problem, uploader: upload_status, service_display, video_connection, audio_connection, monitor: monitor.clone() });

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
    if let Some(t) = retention_thread {
        let _ = t.join();
    }
    Ok(())
}
