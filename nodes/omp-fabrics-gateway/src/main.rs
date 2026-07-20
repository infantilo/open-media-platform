//! `omp-fabrics-gateway`: erster echter Node-Konsument von
//! `omp_mediaio::fabrics` (Kapitel 16 Teil 2, `docs/END-GOAL-
//! FEATURES.md` §16.4 — Details/Design-Entscheidung: `relay.rs`).
//! Zweigeteilt wie `omp-2110-gateway`/`omp-aes67-gateway`
//! (`OMP_FABRICS_GATEWAY_ROLE=target|initiator`).

mod relay;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use omp_mediaio::fabrics::Provider;
use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, ReceiverSpec, SenderSpec, SetError,
};
use relay::{InitiatorConfig, InitiatorHandle, TargetConfig};
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Target,
    Initiator,
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn parse_provider(value: &str) -> Provider {
    match value {
        "verbs" => Provider::Verbs,
        "efa" => Provider::Efa,
        "shm" => Provider::Shm,
        _ => Provider::Tcp,
    }
}

struct TargetStore {
    flow_id: String,
    target_info: String,
}

impl ParamStore for TargetStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                ParamSpec {
                    name: "role".to_string(),
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
                // Kapitel 16 Teil 2 (`relay.rs`-Moduldoku): opake
                // Fabrics-Zieladresse, muss der Initiator-Seite per HTTP
                // zugänglich sein — kein Node-Contract-Standardfeld,
                // Fabrics selbst kennt kein IS-04/05-Analogon dafür.
                ParamSpec {
                    name: "fabricsTargetInfo".to_string(),
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
            "role" => Some(serde_json::json!("target")),
            "flowId" => Some(serde_json::json!(self.flow_id)),
            "fabricsTargetInfo" => Some(serde_json::json!(self.target_info)),
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

/// Setzt IS-05-PATCHes (Quellwahl der zu relayenden Quelle) um — gleiches
/// Muster wie `omp-2110-gateway::main::OutputControl`.
struct InitiatorControl {
    registry: RegistryClient,
    handle: Arc<InitiatorHandle>,
    connected_flow_id: Arc<Mutex<String>>,
}

impl ReceiverControl for InitiatorControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        self.handle.connect(flow_id);
                    }
                    None => eprintln!("omp-fabrics-gateway: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-fabrics-gateway: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                self.handle.disconnect();
            }
        }
    }
}

struct InitiatorStore {
    target_url: String,
    connected_flow_id: Arc<Mutex<String>>,
    connection: Arc<ReceiverConnection<InitiatorControl>>,
}

impl ParamStore for InitiatorStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                ParamSpec {
                    name: "role".to_string(),
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
                    name: "targetUrl".to_string(),
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
            "role" => Some(serde_json::json!("initiator")),
            "connectedFlowId" => Some(serde_json::json!(
                *self.connected_flow_id.lock().expect("lock poisoned")
            )),
            "targetUrl" => Some(serde_json::json!(self.target_url)),
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

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "FabricsGateway");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9410").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let provider = parse_provider(&env_or("OMP_FABRICS_PROVIDER", "tcp"));
    let bind_node = env_or("OMP_FABRICS_BIND_NODE", "0.0.0.0");
    let bind_service = env_or("OMP_FABRICS_BIND_SERVICE", "0");

    let role = match env_or("OMP_FABRICS_GATEWAY_ROLE", "target").as_str() {
        "initiator" => Role::Initiator,
        _ => Role::Target,
    };

    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel::<relay::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));

    match role {
        Role::Target => {
            let width: u32 = env_or("OMP_FABRICS_WIDTH", "1920").parse()?;
            let height: u32 = env_or("OMP_FABRICS_HEIGHT", "1080").parse()?;
            let fps_num: u32 = env_or("OMP_FABRICS_FPS_NUM", "25").parse()?;
            let fps_den: u32 = env_or("OMP_FABRICS_FPS_DEN", "1").parse()?;
            let flow_id = omp_node_sdk::idgen::new_v4();

            let cfg = TargetConfig {
                domain,
                flow_id: flow_id.clone(),
                label: label.clone(),
                width,
                height,
                framerate_numerator: fps_num,
                framerate_denominator: fps_den,
                provider,
                bind_node,
                bind_service,
            };

            // Kein GStreamer-Pipeline-Thread nötig (s. relay.rs-Moduldoku)
            // — `start_target` läuft synchron im Tokio-Blockierungskontext
            // und startet selbst den dauerhaften Relay-Thread.
            let target_handle = relay::start_target(cfg, events_tx, shutdown.clone())
                .map_err(|e| format!("Fabrics target build failed: {e}"))?;

            let store: Arc<dyn ParamStore> = Arc::new(TargetStore {
                flow_id: flow_id.clone(),
                target_info: target_handle.target_info.clone(),
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
                            frame_width: width,
                            frame_height: height,
                            grain_rate_numerator: fps_num,
                            grain_rate_denominator: fps_den,
                        }),
                        ..Default::default()
                    }],
                    receivers: vec![],
                    instance_id,
                    media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || target_handle.media_ready())),
                },
                store,
            )
            .await?;

            run_event_loop(handle, &mut events_rx, shutdown).await;
        }
        Role::Initiator => {
            let target_url = std::env::var("OMP_FABRICS_TARGET_URL")
                .map_err(|_| "OMP_FABRICS_TARGET_URL nicht gesetzt (Initiator-Rolle braucht die Ziel-Instanz-URL)")?;

            let cfg = InitiatorConfig { domain, provider, bind_node, bind_service, target_url: target_url.clone() };
            let initiator_handle = InitiatorHandle::new(cfg, events_tx)
                .map_err(|e| format!("Fabrics initiator runtime build failed: {e}"))?;

            let media_ready_handle = initiator_handle.clone();
            let receiver_id = omp_node_sdk::idgen::new_v4();
            let connected_flow_id = Arc::new(Mutex::new(String::new()));
            let connection = Arc::new(ReceiverConnection::new(
                receiver_id.clone(),
                InitiatorControl {
                    registry: RegistryClient::new(registry_url.clone()),
                    handle: initiator_handle,
                    connected_flow_id: connected_flow_id.clone(),
                },
            ));

            let store: Arc<dyn ParamStore> =
                Arc::new(InitiatorStore { target_url, connected_flow_id, connection });

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
                        media_ready_handle.media_ready()
                    })),
                },
                store,
            )
            .await?;

            run_event_loop(handle, &mut events_rx, shutdown).await;
        }
    }

    Ok(())
}

async fn run_event_loop(
    handle: omp_node_sdk::NodeHandle,
    events_rx: &mut tokio::sync::mpsc::UnboundedReceiver<relay::Event>,
    shutdown: Arc<AtomicBool>,
) {
    let events = async {
        while let Some(event) = events_rx.recv().await {
            match event {
                relay::Event::Error(message) => {
                    eprintln!("omp-fabrics-gateway: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-fabrics-gateway: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-fabrics-gateway: relay thread(s) ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
}
