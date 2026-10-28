//! omp-recorder (`UMSETZUNG.md` C22, `ARCHITECTURE.md` §24.7): MXL-Quelle
//! (Video+Audio) → Datei. Ausschließlich MXL als Eingang, keine
//! Capture-Karte/Blackmagic-Abhängigkeit (gleiche Entscheidung wie
//! §24.6). Zwei unabhängige IS-05-Receiver (Video/Audio, wie
//! `omp-viewer`s Empfangsseite, C6) plus ein davon getrennter
//! Aufnahme-Lebenszyklus (`record.start`/`record.stop`) — Details/
//! Encoder-Wahl in `pipeline.rs`.

mod audio_plan;
mod pipeline;
mod uibundle;

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
    /// Nummer des Audio-Eingangs (0 = Hauptquelle); bei Video ohne Bedeutung.
    audio_input: usize,
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
                            self.pipeline.connect_audio(self.audio_input, flow_id);
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
                    self.pipeline.disconnect_audio(self.audio_input);
                }
            }
        }
    }
}

struct RecorderStore {
    pipeline: pipeline::PipelineHandle,
    /// Zielverzeichnis der Aufnahmen und optional das Clip-Verzeichnis der Player (`OMP_RECORDER_CLIP_DIR`):
    /// existiert die Medien-ID dort schon, braucht `record.start` das Flag `overwrite`.
    media_dir: String,
    clip_dir: String,
    video_connection: Arc<ReceiverConnection<RecorderReceiverControl>>,
    /// Audio-Receiver in Eingangsreihenfolge (Kapitel 45): 0 = Hauptquelle, weitere für zusätzliche Quellen.
    audio_connections: Vec<Arc<ReceiverConnection<RecorderReceiverControl>>>,
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
    /// Label-Plan (JSON, `omp-mxf-mca::plan_json`) für die nächste `.mxf`-Aufnahme;
    /// leer = keine MCA-Labels.
    mca_plan: std::sync::Mutex<String>,
    /// Kanalplan (JSON, s. `audio_plan.rs`) für die nächste Aufnahme; leer = Ton der Hauptquelle unverändert.
    audio_plan: std::sync::Mutex<String>,
}

impl RecorderStore {
    fn receiver_ids(&self) -> Vec<&str> {
        let mut v = vec![self.video_connection.id()];
        v.extend(self.audio_connections.iter().map(|c| c.id()));
        v
    }
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
        parameters.push(ParamSpec {
            name: "record.mcaPlan".to_string(),
            kind: ParamType::String,
            unit: None,
            range: None,
            readonly: false,
        });
        parameters.push(ParamSpec {
            name: "record.audioPlan".to_string(),
            kind: ParamType::String,
            unit: None,
            range: None,
            readonly: false,
        });
        parameters.extend(self.monitor.param_specs("monitor"));
        let mut methods = vec![
            MethodSpec {
                name: "record.start".to_string(),
                args: vec![
                    MethodArg { name: "fileName".to_string(), kind: ParamType::String },
                    // Standard aus: liegt die Medien-ID schon als Clip vor, wird nicht überschrieben.
                    MethodArg { name: "overwrite".to_string(), kind: ParamType::Boolean },
                ],
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
            "record.mcaPlan" => Some(serde_json::json!(self.mca_plan.lock().expect("lock poisoned").clone())),
            "record.audioPlan" => Some(serde_json::json!(self.audio_plan.lock().expect("lock poisoned").clone())),
            _ => self.monitor.get("monitor", name, None, Vec::new),
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        if name == "record.mcaPlan" {
            let text = value.as_str().ok_or(SetError::Unknown)?.to_string();
            *self.mca_plan.lock().expect("lock poisoned") = text;
            return Ok(());
        }
        if name == "record.audioPlan" {
            let text = value.as_str().ok_or(SetError::Unknown)?.to_string();
            // Früh ablehnen statt erst beim Start: ein ungültiger Plan soll nicht bis zur Sendezeit unbemerkt bleiben.
            audio_plan::AudioPlan::parse(&text).map_err(|_| SetError::Unknown)?;
            *self.audio_plan.lock().expect("lock poisoned") = text;
            return Ok(());
        }
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
                let overwrite = match args.get("overwrite") {
                    Some(Value::Bool(b)) => *b,
                    Some(Value::String(t)) => matches!(t.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "ja"),
                    _ => false,
                };
                if !overwrite && let Some(found) = pipeline::existing_clip(&[self.media_dir.as_str(), self.clip_dir.as_str()], file_name) {
                    let msg = format!("Die Medien-ID „{file_name}“ liegt bereits als Clip vor ({}) — mit overwrite=true überschreiben", found.display());
                    eprintln!("omp-recorder: record.start abgelehnt: {msg}");
                    return Err(InvokeError::Message(msg));
                }
                match self.pipeline.start_recording(file_name.to_string(), Some(self.mca_plan.lock().expect("lock poisoned").clone()), Some(self.audio_plan.lock().expect("lock poisoned").clone())) {
                    Ok(()) => {
                        self.monitor.activate();
                        Ok(())
                    }
                    Err(e) => {
                        eprintln!("omp-recorder: record.start failed: {e}");
                        let delay = self.monitor.status_reporting_delay();
                        self.monitor.activity.observe(omp_node_sdk::HealthLevel::Unhealthy, delay, Some(&e));
                        self.monitor.content.observe(omp_node_sdk::HealthLevel::Unhealthy, delay, Some(&e));
                        Err(InvokeError::Message(e))
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
        if let Some(ui) = uibundle::route(method, path) {
            return Some(ui);
        }
        root_discovery(method, path)
            .or_else(|| {
                list_ids(method, path, "receivers", &self.receiver_ids())
            })
            .or_else(|| bulk_discovery(method, path))
            .or_else(|| {
                bulk_patch(method, path, "receivers", body, |id, params| {
                    if self.video_connection.id() == id {
                        Some(self.video_connection.patch_staged(params).0)
                    } else {
                        self.audio_connections.iter().find(|c| c.id() == id).map(|c| c.patch_staged(params).0)
                    }
                })
            })
            .or_else(|| bulk_patch(method, path, "senders", body, |_, _| None))
            .or_else(|| self.video_connection.handle(method, path, body))
            .or_else(|| self.audio_connections.iter().find_map(|c| c.handle(method, path, body)))
            .map(to_raw)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.video_connection
            .cors_methods(path)
            .or_else(|| self.audio_connections.iter().find_map(|c| c.cors_methods(path)))
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
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
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
    // Kapitel 45: mehrere Audio-Eingänge (Quellen) für den Kanalplan; Standard 1 wie bisher.
    let audio_inputs: usize = env_or("OMP_RECORDER_AUDIO_INPUTS", "1").parse::<usize>().unwrap_or(1).clamp(1, 8);
    let audio_receiver_ids: Vec<String> = (0..audio_inputs).map(|_| omp_node_sdk::idgen::new_v4()).collect();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let clip_dir = env_or("OMP_RECORDER_CLIP_DIR", "");
    let store_media_dir = media_dir.clone();
    let pipeline_config = pipeline::Config { domain, media_dir, audio_inputs };
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
            audio_input: 0,
        },
    ));
    let audio_connections: Vec<_> = audio_receiver_ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            Arc::new(ReceiverConnection::new(
                id.clone(),
                RecorderReceiverControl { registry: registry.clone(), pipeline: pipeline_handle.clone(), is_video: false, audio_input: i },
            ))
        })
        .collect();

    let media_ready_pipeline = pipeline_handle.clone();
    let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Receiver));
    // Startzustand `Inactive` — kein `record.start` bisher.
    monitor.deactivate();
    let store: Arc<dyn ParamStore> = Arc::new(RecorderStore {
        pipeline: pipeline_handle,
        media_dir: store_media_dir,
        clip_dir,
        video_connection,
        audio_connections,
        monitor: monitor.clone(),
        mca_plan: std::sync::Mutex::new(String::new()),
        audio_plan: std::sync::Mutex::new(String::new()),
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![],
            receivers: {
                let mut r = vec![ReceiverSpec {
                    id: Some(video_receiver_id),
                    transport: Some(TRANSPORT_MXL.to_string()),
                    media_types: Some(vec!["video/v210".to_string()]),
                    label: Some("Video".to_string()),
                    ..Default::default()
                }];
                for (i, id) in audio_receiver_ids.iter().enumerate() {
                    r.push(ReceiverSpec {
                        id: Some(id.clone()),
                        transport: Some(TRANSPORT_MXL.to_string()),
                        media_types: Some(vec!["audio/L24".to_string()]),
                        // „Audio“ bleibt der Name des ersten (Kompatibilität), weitere heißen „Audio 2“ …
                        label: Some(if i == 0 { "Audio".to_string() } else { format!("Audio {}", i + 1) }),
                        ..Default::default()
                    });
                }
                r
            },
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
