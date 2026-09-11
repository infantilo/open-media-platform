//! omp-recorder (`UMSETZUNG.md` C22, `ARCHITECTURE.md` §24.7): MXL-Quelle
//! (Video+Audio) → Datei. Ausschließlich MXL als Eingang, keine
//! Capture-Karte/Blackmagic-Abhängigkeit (gleiche Entscheidung wie
//! §24.6). Zwei unabhängige IS-05-Receiver (Video/Audio, wie
//! `omp-viewer`s Empfangsseite, C6) plus ein davon getrennter
//! Aufnahme-Lebenszyklus (`record.start`/`record.stop`) — Details/
//! Encoder-Wahl in `pipeline.rs`.

mod pipeline;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use omp_node_sdk::connection::{
    bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery, ReceiverConnection,
    ReceiverControl, ReceiverResource,
};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    Range, RawResponse, ReceiverSpec, SetError,
};
use serde_json::Value;

/// Gemeinsam für Video- und Audio-Receiver (nur unterschiedlich, welche
/// `PipelineHandle`-Methode sie beim Verbinden/Trennen rufen) — löst
/// `sender_id` über die Registry auf eine MXL-`flow_id` auf, genau wie
/// `omp-viewer`s `ViewerControl`.
struct RecorderReceiverControl {
    registry: RegistryClient,
    pipeline: pipeline::PipelineHandle,
    is_video: bool,
}

impl ReceiverControl for RecorderReceiverControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        if self.is_video {
                            self.pipeline.connect_video(flow_id);
                        } else {
                            self.pipeline.connect_audio(flow_id);
                        }
                    }
                    None => eprintln!("omp-recorder: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-recorder: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                if self.is_video {
                    self.pipeline.disconnect_video();
                } else {
                    self.pipeline.disconnect_audio();
                }
            }
        }
    }
}

struct RecorderStore {
    pipeline: pipeline::PipelineHandle,
    video_connection: Arc<ReceiverConnection<RecorderReceiverControl>>,
    audio_connection: Arc<ReceiverConnection<RecorderReceiverControl>>,
    /// AMWA BCP-008-01 (NMOS Receiver Status Monitoring, `docs/
    /// decisions.md` BCP-008-Nachtrag) — Rekorder empfängt Inhalt zum
    /// Aufzeichnen, ist also der "Receiver". Anders als bei den
    /// Gateway-Nodes gibt es hier keinen kontinuierlich pollbaren
    /// Jitterbuffer — `record.start`/`record.stop` (Aufnahme-
    /// Lebenszyklus, nicht der IS-05-Verbindungsstatus) treiben
    /// `activate()`/`deactivate()` direkt in `invoke()`; ein Fehlschlag
    /// (Start scheitert, oder eine laufende Aufnahme bricht ab, s.
    /// `pipeline::Event::Warning`-Zweig unten) setzt `activity`/
    /// `content` sofort auf `Unhealthy`, OHNE zu deaktivieren — ein
    /// Abbruch ist kein sauberer Stopp, Betreiber sollen das als
    /// Störung sehen, nicht als neutrales `Inactive`.
    monitor: Arc<omp_node_sdk::Monitor>,
}

impl ParamStore for RecorderStore {
    fn descriptor(&self) -> Descriptor {
        let mut parameters = vec![
            ParamSpec {
                name: "record.status".to_string(),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum {
                    values: vec![
                        "idle".to_string(),
                        "recording".to_string(),
                        "error".to_string(),
                    ],
                }),
                readonly: true,
            },
            ParamSpec {
                name: "record.durationMs".to_string(),
                kind: ParamType::Number,
                unit: Some("ms".to_string()),
                range: None,
                readonly: true,
            },
        ];
        parameters.extend(self.monitor.param_specs("monitor"));
        let mut methods = vec![
            MethodSpec {
                name: "record.start".to_string(),
                args: vec![MethodArg {
                    name: "fileName".to_string(),
                    kind: ParamType::String,
                }],
            },
            MethodSpec {
                name: "record.stop".to_string(),
                args: vec![],
            },
        ];
        methods.extend(self.monitor.method_specs("monitor"));
        Descriptor { latency: None, parameters, methods }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "record.status" => Some(serde_json::json!(self.pipeline.status().as_str())),
            "record.durationMs" => Some(serde_json::json!(self.pipeline.duration_ms())),
            // Keine Zähler-Quelle hier — leere Liste statt erfundener
            // Werte (s. `omp-srt-gateway::GatewayStore::get`).
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

    /// Geschäftslogik-Fehler (z. B. "keine Quelle verbunden") können hier
    /// nicht mit einer eigenen Meldung durchgereicht werden —
    /// `InvokeError` kennt nur `Unknown` (HTTP 404 "unknown method",
    /// SDK-Grenze, nicht Teil dieses Schritts). Der tatsächliche Grund
    /// steht stattdessen in `record.status`/den Server-Logs und wird per
    /// `handle.publish_alert` als Alarm sichtbar (s. `main()` unten) —
    /// bewusste, dokumentierte Vereinfachung, kein übersehener Fall.
    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "record.start" => {
                let file_name = args
                    .get("fileName")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                match self.pipeline.start_recording(file_name.to_string()) {
                    Ok(()) => {
                        self.monitor.activate();
                        Ok(())
                    }
                    Err(e) => {
                        eprintln!("omp-recorder: record.start failed: {e}");
                        let delay = self.monitor.status_reporting_delay();
                        self.monitor.activity.observe(omp_node_sdk::HealthLevel::Unhealthy, delay, Some(&e));
                        self.monitor.content.observe(omp_node_sdk::HealthLevel::Unhealthy, delay, Some(&e));
                        Err(InvokeError::Unknown)
                    }
                }
            }
            "record.stop" => match self.pipeline.stop_recording() {
                Ok(()) => {
                    self.monitor.deactivate();
                    Ok(())
                }
                Err(e) => {
                    eprintln!("omp-recorder: record.stop failed: {e}");
                    Err(InvokeError::Unknown)
                }
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
        let to_raw = |(status, content_type, body)| RawResponse {
            status,
            content_type,
            body,
        };
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

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Recorder");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9350").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Gleiche Variable/gleicher Default wie `omp-media-library`s Scan
    // (`ARCHITECTURE.md` §24.7): eine Aufnahme landet ohne manuellen
    // Schritt im nächsten Library-Scan.
    let media_dir = env_or("OMP_MEDIA_DIR", "/home/infantilo/OpenMediaPlatform/data");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    // Wie bei omp-viewer (C6): Receiver-IDs vor start() erzeugen, weil
    // die IS-05-Connection-Endpoints (ReceiverConnection) schon unter
    // der endgültigen ID verdrahtet sein müssen.
    let video_receiver_id = omp_node_sdk::idgen::new_v4();
    let audio_receiver_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config { domain, media_dir };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx, pipeline_heartbeat_thread)
    });

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-recorder: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-recorder: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let registry = RegistryClient::new(registry_url.clone());
    let video_connection = Arc::new(ReceiverConnection::new(
        video_receiver_id.clone(),
        RecorderReceiverControl {
            registry: registry.clone(),
            pipeline: pipeline_handle.clone(),
            is_video: true,
        },
    ));
    let audio_connection = Arc::new(ReceiverConnection::new(
        audio_receiver_id.clone(),
        RecorderReceiverControl {
            registry,
            pipeline: pipeline_handle.clone(),
            is_video: false,
        },
    ));

    let media_ready_pipeline = pipeline_handle.clone();
    let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Receiver));
    // Startzustand `Inactive` — kein `record.start` bisher.
    monitor.deactivate();
    let store: Arc<dyn ParamStore> = Arc::new(RecorderStore {
        pipeline: pipeline_handle,
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
            // "media-ready" (ARCHITECTURE.md §5 Punkt 6): true, sobald
            // seit dem letzten `record.start` mindestens ein Buffer den
            // Muxer erreicht hat (s. `pipeline.rs`) — false im Leerlauf,
            // kein Fehlzustand (dieser Node hat keine eigenen Sender).
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready_pipeline.media_ready()
            })),
        },
        store,
    )
    .await?;

    // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
    // Nachtrag 130/131).
    handle.register_worker("pipeline", pipeline_heartbeat);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Warning(message) => {
                    eprintln!("omp-recorder: {message}");
                    // Abgebrochene Aufnahme (s. `RecorderStore::monitor`-
                    // Doku): sofort Unhealthy, kein `deactivate()` — ein
                    // Abbruch ist keine saubere Deaktivierung.
                    let delay = monitor.status_reporting_delay();
                    monitor.activity.observe(omp_node_sdk::HealthLevel::Unhealthy, delay, Some(&message));
                    monitor.content.observe(omp_node_sdk::HealthLevel::Unhealthy, delay, Some(&message));
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-recorder: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-recorder: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}
