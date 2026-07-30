//! omp-audio-monitor (Nutzerwunsch 2026-07-29: "wir müssen auch das
//! audio abhören können. kann der viewer auch audio oder brauchen wir
//! ein audio monitoring node?"): liest eine per Drag & Drop verbundene
//! MXL-Audioquelle beliebigen Kanal-/Abtastformats und stellt sie als
//! MP3-über-HTTP-Dauerstrom zum Abhören im Browser bereit — exaktes
//! Strukturmuster von `omp-viewer` (MJPEG-Vorschau), hier Audio statt
//! Video. Eigener Node statt Audio-Ausgabe direkt in `omp-viewer`:
//! Letzterer liefert Video als MJPEG-Bildstrom (image/jpeg-Frames) zum
//! Browser — ein grundverschiedener Transportmechanismus, der sich
//! nicht einfach um Audio erweitern lässt, ohne zwei unabhängige
//! Übertragungsarten in einem video-fokussierten Node zu vermischen.
//! Deckt außerdem die bereits in `docs/decisions.md`
//! (2026-07-14-Entscheidungssitzung, K4) getroffene, bis jetzt nicht
//! umgesetzte Entscheidung "Solo/PFL wird gebaut (Monitor-Summe +
//! lokale Wiedergabe)" ab: Quelle kann später auch der neue
//! `omp-audio-mixer`-Monitor-Bus (Pre-Listen, s. dortiges
//! `channel.<id>.pfl`) sein, für diesen Node ist das nur ein weiterer
//! wählbarer MXL-Audio-Sender, keine Sonderfall-Logik nötig.

mod pipeline;
mod uibundle;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use omp_mediaio::audio_stream;
use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{
    Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse,
    ReceiverSpec, SetError,
};
use serde_json::Value;

/// Setzt IS-05-PATCHes (Quellwahl) auf die Pipeline um — identisches
/// Muster zu `omp-viewer::main::ViewerControl`/`omp-scaler::main::
/// ScalerControl`: löst `sender_id` über die Registry-Query-API zu
/// einer MXL-`flow_id` auf und lässt die Pipeline neu aufbauen. Ein
/// leerer/abwesender `sender_id` (oder `master_enable=false`) trennt.
struct MonitorControl {
    registry: RegistryClient,
    pipeline: pipeline::PipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
    connected_label: Arc<Mutex<String>>,
}

impl ReceiverControl for MonitorControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        *self.connected_label.lock().expect("lock poisoned") = sender.label;
                        self.pipeline.connect(flow_id);
                    }
                    None => eprintln!("omp-audio-monitor: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-audio-monitor: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                *self.connected_label.lock().expect("lock poisoned") = String::new();
                self.pipeline.disconnect();
            }
        }
    }
}

struct MonitorStore {
    connected_flow_id: Arc<Mutex<String>>,
    connected_label: Arc<Mutex<String>>,
    audio_stream_url: String,
    connection: Arc<ReceiverConnection<MonitorControl>>,
}

impl ParamStore for MonitorStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                ParamSpec {
                    name: "connectedFlowId".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "connectedLabel".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "audioStreamUrl".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
            ],
            methods: vec![],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "connectedFlowId" => Some(serde_json::json!(
                *self.connected_flow_id.lock().expect("lock poisoned")
            )),
            "connectedLabel" => Some(serde_json::json!(
                *self.connected_label.lock().expect("lock poisoned")
            )),
            "audioStreamUrl" => Some(serde_json::json!(self.audio_stream_url)),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(
        &self,
        _name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if let Some((status, content_type, body)) = self.connection.handle(method, path, body) {
            return Some(RawResponse {
                status,
                content_type,
                body,
            });
        }
        uibundle::route(method, path)
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Audio Monitor");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9390").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Default 0 (freier Port vom OS) — mehrere vom Instanz-Launcher
    // gestartete Monitore dürfen sich sonst keinen festen Port teilen,
    // gleicher Grund wie `omp-viewer`s OMP_VIEWER_PREVIEW_PORT.
    let stream_port: u16 = env_or("OMP_AUDIO_MONITOR_STREAM_PORT", "0").parse()?;
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let receiver_id = omp_node_sdk::idgen::new_v4();

    let broadcaster = Arc::new(audio_stream::Broadcaster::new());
    let actual_stream_port =
        audio_stream::spawn(&format!("0.0.0.0:{stream_port}"), broadcaster.clone())?;
    let audio_stream_url = format!("http://{host}:{actual_stream_port}/audio-stream");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config { domain };
    let pipeline_shutdown = shutdown.clone();
    let broadcaster_for_pipeline = broadcaster.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(
            pipeline_config,
            broadcaster_for_pipeline,
            tx,
            pipeline_shutdown,
            ready_tx,
        )
    });

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-audio-monitor: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-audio-monitor: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let media_ready_pipeline = pipeline_handle.clone();
    let connected_flow_id = Arc::new(Mutex::new(String::new()));
    let connected_label = Arc::new(Mutex::new(String::new()));
    let connection = Arc::new(ReceiverConnection::new(
        receiver_id.clone(),
        MonitorControl {
            registry: RegistryClient::new(registry_url.clone()),
            pipeline: pipeline_handle,
            connected_flow_id: connected_flow_id.clone(),
            connected_label: connected_label.clone(),
        },
    ));

    let store: Arc<dyn ParamStore> = Arc::new(MonitorStore {
        connected_flow_id,
        connected_label,
        audio_stream_url,
        connection,
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
            // "media-ready" (ARCHITECTURE.md §5 Punkt 6) über
            // PipelineHandle::media_ready() — false vor dem ersten
            // Connect und direkt nach jedem Quellwechsel, bis der neu
            // verbundene Input nachweislich einen Buffer liefert.
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready_pipeline.media_ready()
            })),
        },
        store,
    )
    .await?;

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-audio-monitor: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-audio-monitor: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-audio-monitor: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}
