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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource};
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
}

impl ParamStore for SinkStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                ParamSpec { name: "direction".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
                ParamSpec { name: "flowId".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
                ParamSpec { name: "listenEndpoint".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
                ParamSpec { name: "discoveredViaSap".to_string(), kind: ParamType::Boolean, unit: None, range: None, readonly: true },
                ParamSpec { name: "ptpSynced".to_string(), kind: ParamType::Boolean, unit: None, range: None, readonly: true },
            ],
            methods: vec![],
        }
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

/// Setzt IS-05-PATCHes (Quellwahl) auf die Source-Pipeline um — gleiches
/// Muster wie `omp-2110-gateway::main::OutputControl`.
struct SourceControl {
    registry: RegistryClient,
    pipeline: pipeline::SourcePipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
}

impl ReceiverControl for SourceControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        self.pipeline.connect(flow_id);
                    }
                    None => eprintln!("omp-aes67-gateway: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-aes67-gateway: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                self.pipeline.disconnect();
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
}

impl ParamStore for SourceStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                ParamSpec { name: "direction".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
                ParamSpec { name: "connectedFlowId".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
                ParamSpec { name: "destinationEndpoint".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
                ParamSpec { name: "ptpSynced".to_string(), kind: ParamType::Boolean, unit: None, range: None, readonly: true },
            ],
            methods: vec![],
        }
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
            let pipeline_thread = std::thread::spawn(move || pipeline::run_sink(cfg, events_tx, pipeline_shutdown, ready_tx));

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

            let store: Arc<dyn ParamStore> = Arc::new(SinkStore {
                flow_id: flow_id.clone(),
                listen_port,
                multicast_group,
                discovered_via_sap,
                ptp_domain,
                pipeline: pipeline_handle,
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

            run_event_loop(handle, &mut events_rx, shutdown, pipeline_thread, None).await;
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
            let pipeline_thread = std::thread::spawn(move || pipeline::run_source(cfg, events_tx, pipeline_shutdown, ready_tx));

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
            let connection = Arc::new(ReceiverConnection::new(
                receiver_id.clone(),
                SourceControl {
                    registry: RegistryClient::new(registry_url.clone()),
                    pipeline: pipeline_handle,
                    connected_flow_id: connected_flow_id.clone(),
                },
            ));

            let store: Arc<dyn ParamStore> = Arc::new(SourceStore {
                destination_host,
                destination_port,
                connected_flow_id,
                connection,
                ptp_domain,
                pipeline: ptp_pipeline,
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

            run_event_loop(handle, &mut events_rx, shutdown, pipeline_thread, Some(sap_announcer)).await;
        }
    }

    Ok(())
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
) {
    let events = async {
        while let Some(event) = events_rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-aes67-gateway: pipeline error: {message}");
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
