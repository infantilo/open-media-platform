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

mod pipeline;
mod sdp;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, ReceiverSpec, SenderSpec, SetError,
};
use pipeline::{IngestConfig, OutputConfig};
use serde_json::Value;

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
}

impl ParamStore for IngestStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
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
            ],
            methods: vec![],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "direction" => Some(serde_json::json!("ingest")),
            "flowId" => Some(serde_json::json!(self.flow_id)),
            "listenEndpoint" => {
                let group = self.multicast_group.as_deref().unwrap_or("0.0.0.0");
                Some(serde_json::json!(format!("{group}:{}", self.listen_port)))
            }
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, _name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }
}

/// Setzt IS-05-PATCHes (Quellwahl) auf die Output-Pipeline um — gleiches
/// Muster wie `omp-viewer::main::ViewerControl`, hier ohne UMD-Label
/// (der 2110-Ausgang trägt kein Textoverlay).
struct OutputControl {
    registry: RegistryClient,
    pipeline: pipeline::OutputPipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
}

impl ReceiverControl for OutputControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        self.pipeline.connect(flow_id);
                    }
                    None => eprintln!("omp-2110-gateway: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-2110-gateway: resolve sender {sender_id} failed: {e}"),
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
}

impl ParamStore for OutputStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
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
            ],
            methods: vec![],
        }
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
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, _name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<omp_node_sdk::RawResponse> {
        self.connection
            .handle(method, path, body)
            .map(|(status, content_type, body)| omp_node_sdk::RawResponse { status, content_type, body })
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

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "2110-Gateway");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9400").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

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
            let flow_id = omp_node_sdk::idgen::new_v4();

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
            };

            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let pipeline_shutdown = shutdown.clone();
            let pipeline_thread =
                std::thread::spawn(move || pipeline::run_ingest(cfg, events_tx, pipeline_shutdown, ready_tx));

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

            let media_ready_pipeline = Arc::new(pipeline_handle);

            let store: Arc<dyn ParamStore> = Arc::new(IngestStore {
                flow_id: flow_id.clone(),
                listen_port,
                multicast_group,
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
                        flow: Some(FlowSpec::Video {
                            id: Some(flow_id),
                            frame_width: width as u32,
                            frame_height: height as u32,
                            grain_rate_numerator: fps_num as u32,
                            grain_rate_denominator: fps_den as u32,
                        }),
                        ..Default::default()
                    }],
                    receivers: vec![],
                    instance_id,
                    media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                        media_ready_pipeline.media_ready()
                    })),
                },
                store,
            )
            .await?;

            run_event_loop(handle, &mut events_rx, shutdown, pipeline_thread).await;
        }
        Direction::Output => {
            let destination_host = env_or("OMP_2110_GATEWAY_DEST_HOST", "239.1.1.1");
            let destination_port: u16 = env_or("OMP_2110_GATEWAY_DEST_PORT", "6000").parse()?;
            let width: i32 = env_or("OMP_2110_GATEWAY_WIDTH", "1920").parse()?;
            let height: i32 = env_or("OMP_2110_GATEWAY_HEIGHT", "1080").parse()?;
            let fps_num: i32 = env_or("OMP_2110_GATEWAY_FPS_NUM", "25").parse()?;
            let fps_den: i32 = env_or("OMP_2110_GATEWAY_FPS_DEN", "1").parse()?;

            let cfg = OutputConfig {
                domain,
                destination_host: destination_host.clone(),
                destination_port,
                width,
                height,
                framerate_numerator: fps_num,
                framerate_denominator: fps_den,
            };

            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let pipeline_shutdown = shutdown.clone();
            let pipeline_thread =
                std::thread::spawn(move || pipeline::run_output(cfg, events_tx, pipeline_shutdown, ready_tx));

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

            let media_ready_pipeline = pipeline_handle.clone();
            let receiver_id = omp_node_sdk::idgen::new_v4();
            let connected_flow_id = Arc::new(Mutex::new(String::new()));
            let connection = Arc::new(ReceiverConnection::new(
                receiver_id.clone(),
                OutputControl {
                    registry: RegistryClient::new(registry_url.clone()),
                    pipeline: pipeline_handle,
                    connected_flow_id: connected_flow_id.clone(),
                },
            ));

            let store: Arc<dyn ParamStore> = Arc::new(OutputStore {
                destination_host,
                destination_port,
                connected_flow_id,
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
                        ..Default::default()
                    }],
                    instance_id,
                    media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                        media_ready_pipeline.media_ready()
                    })),
                },
                store,
            )
            .await?;

            run_event_loop(handle, &mut events_rx, shutdown, pipeline_thread).await;
        }
    }

    Ok(())
}

async fn run_event_loop(
    handle: omp_node_sdk::NodeHandle,
    events_rx: &mut tokio::sync::mpsc::UnboundedReceiver<pipeline::Event>,
    shutdown: Arc<AtomicBool>,
    pipeline_thread: std::thread::JoinHandle<()>,
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
    let _ = pipeline_thread.join();
}
