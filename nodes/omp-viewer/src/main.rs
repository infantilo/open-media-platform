//! omp-viewer: MXL → Bild (`UMSETZUNG.md` C6). Zweiter der drei
//! MXL-Demo-Services (`docs/decisions.md`, 2026-07-09): zeigt einen per
//! IS-05-Receiver-PATCH gewählten MXL-Flow headless über MJPEG-über-HTTP
//! an (PIPELINE CONTROLLERs bewährtes Preview-Muster,
//! `lib/PreviewPipeline.js`). Quellwahl über `sender_id` (nicht per
//! Kommandozeile) — dadurch funktioniert Drag & Drop im bestehenden
//! Flow-Editor (B3) sofort, ohne Orchestrator-Änderung.

mod pipeline;
mod uibundle;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use omp_mediaio::preview;
use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{
    Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse,
    ReceiverSpec, SetError,
};
use serde_json::Value;

/// Setzt IS-05-PATCHes (Quellwahl) auf die Pipeline um: löst `sender_id`
/// über die Registry-Query-API zu einer MXL-`flow_id` auf (Konvention
/// Flow-UUID == MXL-`flow-id`, `UMSETZUNG.md` C4) und lässt die Pipeline
/// neu aufbauen. Ein leerer/abwesender `sender_id` (oder
/// `master_enable=false`) trennt.
struct ViewerControl {
    registry: RegistryClient,
    pipeline: pipeline::PipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
}

impl ReceiverControl for ViewerControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        self.pipeline.connect(flow_id);
                    }
                    None => eprintln!("omp-viewer: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-viewer: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                self.pipeline.disconnect();
            }
        }
    }
}

struct ViewerStore {
    connected_flow_id: Arc<Mutex<String>>,
    preview_url: String,
    connection: Arc<ReceiverConnection<ViewerControl>>,
}

impl ParamStore for ViewerStore {
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
                    name: "previewUrl".to_string(),
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
            "previewUrl" => Some(serde_json::json!(self.preview_url)),
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
    let label = env_or("OMP_LABEL", "Viewer");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9340").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Default 0 (freier Port vom OS) statt eines festen Ports: mehrere
    // vom Instanz-Launcher gestartete Viewer (`UMSETZUNG.md` C8) dürfen
    // sich sonst genau wie bei `OMP_PORT` keinen festen Port teilen.
    // `previewUrl` (unten) macht den tatsächlichen Port für die UI
    // ohnehin dynamisch sichtbar, ein fester Default hätte hier keinen
    // Mehrwert mehr.
    let preview_port: u16 = env_or("OMP_VIEWER_PREVIEW_PORT", "0").parse()?;
    let sink_element = std::env::var("OMP_VIEWER_SINK").ok();
    // Vom Instanz-Launcher gesetzt (`UMSETZUNG.md` C8), sonst leer bei
    // manuellem Start.
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    // Wie bei playouts Sender-ID (C3): die Receiver-ID wird hier erzeugt,
    // weil der IS-05-Receiver-Connection-Endpoint (ReceiverConnection)
    // schon vor start() unter der endgültigen ID verdrahtet sein muss.
    let receiver_id = omp_node_sdk::idgen::new_v4();

    let broadcaster = Arc::new(preview::Broadcaster::new());
    let actual_preview_port =
        preview::spawn(&format!("0.0.0.0:{preview_port}"), broadcaster.clone())?;
    let preview_url = format!("http://{host}:{actual_preview_port}/preview");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        sink_element,
    };
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
            eprintln!("omp-viewer: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-viewer: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let connected_flow_id = Arc::new(Mutex::new(String::new()));
    let connection = Arc::new(ReceiverConnection::new(
        receiver_id.clone(),
        ViewerControl {
            registry: RegistryClient::new(registry_url.clone()),
            pipeline: pipeline_handle,
            connected_flow_id: connected_flow_id.clone(),
        },
    ));

    let store: Arc<dyn ParamStore> = Arc::new(ViewerStore {
        connected_flow_id,
        preview_url,
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
                media_types: Some(vec!["video/v210".to_string()]),
            }],
            instance_id,
        },
        store,
    )
    .await?;

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-viewer: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-viewer: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-viewer: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}
