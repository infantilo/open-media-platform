//! `omp-webrtc-gateway` (Nachtrag 240/241): Smartphone-Kamera per WebRTC
//! (WHIP, H.264 + Opus) → MXL-Flow. Schritt 1 des Plans aus Nachtrag 240:
//! nur die Kamera-Richtung (Ingest), Signalisierung und Testseite; die
//! Monitor-Richtung (WHEP) und die Handy-Bedienseite folgen.
//!
//! Endpunkte (über `ParamStore::extra_route`, Port = Node-Port):
//! - `POST /whip` — SDP-Offer (`application/sdp`) → `201` + SDP-Answer.
//!   Eine laufende Sitzung wird ersetzt (eine Kamera je Node).
//! - `DELETE /whip` — Sitzung beenden (kein sitzungsspezifisches
//!   `Location`-Ziel, weil `RawResponse` keine Zusatz-Header kennt).
//! - `GET /` (= `/camera.html`, Alias `/whip-test.html`) — Handy-Sendeseite
//!   (Kamera → WHIP, Kameraauswahl, Latenzmessung).
//! - `GET /clock` — Server-Uhrzeit für den Uhrenabgleich der Latenzmessung.
//!
//! Richtung `monitor` (`OMP_WEBRTC_GATEWAY_DIRECTION=monitor`, Schritt 3):
//! MXL → Handy. Zwei IS-05-Receiver (Video, Audio) wählen die Quelle,
//! `POST /whep` / `DELETE /whep` bedient den Zuschauer, `GET /` liefert die
//! Monitor-Seite (`monitor.html`).

mod monitor;
mod pipeline;

use std::sync::{Arc, Mutex};

use omp_node_sdk::connection::{
    ReceiverConnection, ReceiverControl, ReceiverResource, bulk_cors_methods, bulk_discovery,
    bulk_patch, list_ids, root_discovery,
};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse,
    ReceiverSpec, SenderSpec, SetError,
};
use serde_json::Value;

const CAMERA_PAGE: &str = include_str!("camera.html");
const MONITOR_PAGE: &str = include_str!("monitor.html");

fn env_or(key: &str, fallback: &str) -> String {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => v,
        _ => fallback.to_string(),
    }
}

fn latency_value(v: Option<f64>) -> Value {
    v.map_or(Value::Null, |ms| {
        serde_json::json!((ms * 10.0).round() / 10.0)
    })
}

struct CameraStore {
    flow_id: String,
    audio_flow_id: String,
    gateway: Arc<pipeline::Gateway>,
}

impl ParamStore for CameraStore {
    fn descriptor(&self) -> Descriptor {
        let ro = |name: &str, kind: ParamType| ParamSpec {
            name: name.to_string(),
            kind,
            unit: None,
            range: None,
            readonly: true,
        };
        Descriptor {
            latency: None,
            parameters: vec![
                ro("flowId", ParamType::String),
                ro("audioFlowId", ParamType::String),
                ro("whipEndpoint", ParamType::String),
                ro("connectionState", ParamType::String),
                ro("sessionActive", ParamType::Boolean),
                ro("jitterbufferMs", ParamType::Number),
                // Glas-zu-Glas-Messung (Sendeseite im Messmodus), null ohne
                // frische Messung; Endpunkt: Zeitstempel-Zeichnung im Bild
                // bis direkt hinter den Decoder (ohne Kamera-Aufnahme und
                // MXL-Schreiben, s. pipeline.rs / Nachtrag 242).
                ro("e2eLatencyMs", ParamType::Number),
                ro("e2eLatencyLastMs", ParamType::Number),
                ro("e2eLatencyMaxMs", ParamType::Number),
            ],
            methods: vec![],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "flowId" => Some(serde_json::json!(self.flow_id)),
            "audioFlowId" => Some(serde_json::json!(self.audio_flow_id)),
            "whipEndpoint" => Some(serde_json::json!("/whip")),
            "connectionState" => Some(serde_json::json!(self.gateway.connection_state())),
            "sessionActive" => Some(serde_json::json!(
                self.gateway.connection_state() == "connected"
            )),
            "jitterbufferMs" => Some(serde_json::json!(self.gateway.latency_ms())),
            "e2eLatencyMs" => Some(latency_value(
                self.gateway.latency_stats().map(|(avg, _, _)| avg),
            )),
            "e2eLatencyLastMs" => Some(latency_value(
                self.gateway.latency_stats().map(|(_, last, _)| last),
            )),
            "e2eLatencyMaxMs" => Some(latency_value(
                self.gateway.latency_stats().map(|(_, _, max)| max),
            )),
            _ => None,
        }
    }

    fn set(&self, name: &str, _value: Value) -> Result<(), SetError> {
        match name {
            "flowId" | "audioFlowId" | "whipEndpoint" | "connectionState" | "sessionActive"
            | "jitterbufferMs" | "e2eLatencyMs" | "e2eLatencyLastMs" | "e2eLatencyMaxMs" => {
                Err(SetError::ReadOnly)
            }
            _ => Err(SetError::Unknown),
        }
    }

    fn invoke(
        &self,
        _name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let text = |status: u16, body: String| RawResponse {
            status,
            content_type: "text/plain",
            body: body.into_bytes(),
        };
        match (method, path) {
            // Handy-Sendeseite (`/whip-test.html` bleibt als Alias aus Schritt 1).
            ("GET", "/" | "/camera.html" | "/whip-test.html") => Some(RawResponse {
                status: 200,
                content_type: "text/html; charset=utf-8",
                body: CAMERA_PAGE.as_bytes().to_vec(),
            }),
            // Uhrenabgleich für die Latenzmessung: die Seite schätzt daraus
            // ihren Versatz zur Server-Uhr (NTP-artig, kleinste RTT gewinnt).
            ("GET", "/clock") => Some(RawResponse {
                status: 200,
                content_type: "application/json",
                body: serde_json::json!({"ms": pipeline::server_epoch_ms()})
                    .to_string()
                    .into_bytes(),
            }),
            ("POST", "/whip") => {
                let Ok(offer) = std::str::from_utf8(body) else {
                    return Some(text(400, "offer is not UTF-8".to_string()));
                };
                Some(match self.gateway.whip_offer(offer) {
                    Ok(answer) => RawResponse {
                        status: 201,
                        content_type: "application/sdp",
                        body: answer.into_bytes(),
                    },
                    Err(e) => {
                        eprintln!("omp-webrtc-gateway: WHIP offer failed: {e}");
                        text(500, e)
                    }
                })
            }
            ("DELETE", "/whip") => {
                self.gateway.teardown();
                Some(text(200, "ok".to_string()))
            }
            _ => None,
        }
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        (path == "/whip").then(|| vec!["POST", "DELETE"])
    }
}

/// Für beide Richtungen gleiche Node-Basiskonfiguration.
struct Common {
    label: String,
    host: String,
    port: u16,
    registry_url: String,
    nats_url: String,
    domain: String,
    instance_id: Option<String>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // `OMP_WEBRTC_GATEWAY_DIRECTION=camera|monitor` (Muster wie
    // `OMP_2110_GATEWAY_DIRECTION`): camera = Handy → MXL (WHIP),
    // monitor = MXL → Handy (WHEP).
    let monitor = env_or("OMP_WEBRTC_GATEWAY_DIRECTION", "camera") == "monitor";
    let common = Common {
        label: env_or(
            "OMP_LABEL",
            if monitor {
                "WebRTC-Monitor"
            } else {
                "WebRTC-Kamera"
            },
        ),
        host: env_or("OMP_HOST", "127.0.0.1"),
        port: env_or("OMP_PORT", if monitor { "9442" } else { "9440" }).parse()?,
        registry_url: env_or("OMP_REGISTRY_URL", "http://localhost:8010"),
        nats_url: env_or("OMP_NATS_URL", "nats://localhost:4222"),
        domain: env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl"),
        instance_id: std::env::var("OMP_INSTANCE_ID").ok(),
    };
    if monitor {
        run_monitor(common).await
    } else {
        run_camera(common).await
    }
}

async fn run_camera(common: Common) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Common {
        label,
        host,
        port,
        registry_url,
        nats_url,
        domain,
        instance_id,
    } = common;
    // Workflow-Auflösung/-Format (wie omp-source): fehlt/ungültig → Default.
    let width: u32 = env_or("OMP_WIDTH", "").parse().unwrap_or(1280);
    let height: u32 = env_or("OMP_HEIGHT", "").parse().unwrap_or(720);
    let fps_num: u32 = env_or("OMP_FRAMERATE_NUM", "").parse().unwrap_or(25);
    let fps_den: u32 = env_or("OMP_FRAMERATE_DEN", "").parse().unwrap_or(1);
    let latency_ms: u32 = env_or("OMP_WEBRTC_LATENCY_MS", "40").parse()?;
    let sample_rate = 48_000u32;
    let channels = 2u32;

    let flow_id = omp_node_sdk::idgen::new_v4();
    let audio_flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let gateway = pipeline::Gateway::new(
        pipeline::Config {
            domain,
            flow_id: flow_id.clone(),
            audio_flow_id: audio_flow_id.clone(),
            label: label.clone(),
            width,
            height,
            fps_num,
            fps_den,
            sample_rate,
            channels,
            latency_ms,
        },
        tx,
    )?;
    let media_ready_gateway = gateway.clone();
    let heartbeat = gateway.heartbeat.clone();

    let store: Arc<dyn ParamStore> = Arc::new(CameraStore {
        flow_id: flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        gateway: gateway.clone(),
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
                        frame_width: width,
                        frame_height: height,
                        grain_rate_numerator: fps_num,
                        grain_rate_denominator: fps_den,
                    }),
                    ..Default::default()
                },
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Audio {
                        id: Some(audio_flow_id),
                        sample_rate_numerator: sample_rate,
                        channel_count: channels,
                        media_type: "audio/float32".to_string(),
                        bit_depth: 32,
                        source_id: None,
                    }),
                    ..Default::default()
                },
            ],
            receivers: vec![],
            instance_id,
            // Wie omp-2110-gateway-Ingest: "bereit" erst, wenn echte
            // Medien geflossen sind (Handy verbunden), nicht schon beim Start.
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready_gateway.media_ready()
            })),
        },
        store,
    )
    .await?;
    handle.register_worker("pipeline", heartbeat);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-webrtc-gateway: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-webrtc-gateway: shutdown requested"),
        _ = events => eprintln!("omp-webrtc-gateway: pipeline event channel closed"),
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Monitor-Richtung (MXL → Handy, WHEP), Nachtrag 243
// ---------------------------------------------------------------------

/// IS-05-Quellwahl für den Video-Receiver (Muster `omp-2110-gateway`
/// `OutputControl`, hier ohne Pipeline-Neuaufbau: die dauerhafte
/// Monitor-Pipeline tauscht nur die Quelle aus).
struct VideoControl {
    registry: RegistryClient,
    monitor: Arc<monitor::Monitor>,
    connected: Arc<Mutex<String>>,
}

impl ReceiverControl for VideoControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => match self.monitor.connect_video(&flow_id) {
                        Ok(()) => *self.connected.lock().expect("lock poisoned") = flow_id,
                        Err(e) => {
                            eprintln!("omp-webrtc-gateway: connect video {flow_id} failed: {e}")
                        }
                    },
                    None => eprintln!("omp-webrtc-gateway: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-webrtc-gateway: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                self.connected.lock().expect("lock poisoned").clear();
                self.monitor.disconnect_video();
            }
        }
    }
}

/// Audio-Pendant zu [`VideoControl`].
struct AudioControl {
    registry: RegistryClient,
    monitor: Arc<monitor::Monitor>,
    connected: Arc<Mutex<String>>,
}

impl ReceiverControl for AudioControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => match self.monitor.connect_audio(&flow_id) {
                        Ok(()) => *self.connected.lock().expect("lock poisoned") = flow_id,
                        Err(e) => {
                            eprintln!("omp-webrtc-gateway: connect audio {flow_id} failed: {e}")
                        }
                    },
                    None => {
                        eprintln!("omp-webrtc-gateway: audio sender {sender_id} has no flow_id")
                    }
                },
                Err(e) => {
                    eprintln!("omp-webrtc-gateway: resolve audio sender {sender_id} failed: {e}")
                }
            },
            _ => {
                self.connected.lock().expect("lock poisoned").clear();
                self.monitor.disconnect_audio();
            }
        }
    }
}

struct MonitorStore {
    monitor: Arc<monitor::Monitor>,
    video_connection: Arc<ReceiverConnection<VideoControl>>,
    audio_connection: Arc<ReceiverConnection<AudioControl>>,
    connected_video: Arc<Mutex<String>>,
    connected_audio: Arc<Mutex<String>>,
}

impl ParamStore for MonitorStore {
    fn descriptor(&self) -> Descriptor {
        let ro = |name: &str, kind: ParamType| ParamSpec {
            name: name.to_string(),
            kind,
            unit: None,
            range: None,
            readonly: true,
        };
        Descriptor {
            latency: None,
            parameters: vec![
                ro("direction", ParamType::String),
                ro("whepEndpoint", ParamType::String),
                ro("connectionState", ParamType::String),
                ro("sessionActive", ParamType::Boolean),
                ro("videoFlowId", ParamType::String),
                ro("audioFlowId", ParamType::String),
                ro("videoFlowing", ParamType::Boolean),
                ro("audioFlowing", ParamType::Boolean),
                ro("bitrateKbps", ParamType::Number),
            ],
            methods: vec![],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "direction" => Some(serde_json::json!("monitor")),
            "whepEndpoint" => Some(serde_json::json!("/whep")),
            "connectionState" => Some(serde_json::json!(self.monitor.connection_state())),
            "sessionActive" => Some(serde_json::json!(
                self.monitor.connection_state() == "connected"
            )),
            "videoFlowId" => Some(serde_json::json!(
                *self.connected_video.lock().expect("lock poisoned")
            )),
            "audioFlowId" => Some(serde_json::json!(
                *self.connected_audio.lock().expect("lock poisoned")
            )),
            "videoFlowing" => Some(serde_json::json!(self.monitor.media_ready())),
            "audioFlowing" => Some(serde_json::json!(self.monitor.audio_flowed())),
            "bitrateKbps" => Some(serde_json::json!(self.monitor.bitrate_kbps())),
            _ => None,
        }
    }

    fn set(&self, name: &str, _value: Value) -> Result<(), SetError> {
        match name {
            "direction" | "whepEndpoint" | "connectionState" | "sessionActive" | "videoFlowId"
            | "audioFlowId" | "videoFlowing" | "audioFlowing" | "bitrateKbps" => {
                Err(SetError::ReadOnly)
            }
            _ => Err(SetError::Unknown),
        }
    }

    fn invoke(
        &self,
        _name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let text = |status: u16, body: String| RawResponse {
            status,
            content_type: "text/plain",
            body: body.into_bytes(),
        };
        let page = match (method, path) {
            ("GET", "/" | "/monitor.html") => Some(RawResponse {
                status: 200,
                content_type: "text/html; charset=utf-8",
                body: MONITOR_PAGE.as_bytes().to_vec(),
            }),
            ("GET", "/clock") => Some(RawResponse {
                status: 200,
                content_type: "application/json",
                body: serde_json::json!({"ms": pipeline::server_epoch_ms()})
                    .to_string()
                    .into_bytes(),
            }),
            ("POST", "/whep") => Some(match std::str::from_utf8(body) {
                Err(_) => text(400, "offer is not UTF-8".to_string()),
                Ok(offer) => match self.monitor.whep_offer(offer) {
                    Ok(answer) => RawResponse {
                        status: 201,
                        content_type: "application/sdp",
                        body: answer.into_bytes(),
                    },
                    Err(e) => {
                        eprintln!("omp-webrtc-gateway: WHEP offer failed: {e}");
                        text(500, e)
                    }
                },
            }),
            ("DELETE", "/whep") => {
                self.monitor.teardown();
                Some(text(200, "ok".to_string()))
            }
            _ => None,
        };
        if page.is_some() {
            return page;
        }
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
        if path == "/whep" {
            return Some(vec!["POST", "DELETE"]);
        }
        self.video_connection
            .cors_methods(path)
            .or_else(|| self.audio_connection.cors_methods(path))
            .or_else(|| bulk_cors_methods(path, "senders"))
            .or_else(|| bulk_cors_methods(path, "receivers"))
    }
}

async fn run_monitor(common: Common) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Common {
        label,
        host,
        port,
        registry_url,
        nats_url,
        domain,
        instance_id,
    } = common;
    // Ausgabeformat für den Zuschauer (Encoder-Größe): Workflow-Werte wie
    // bei der Kamera, sonst 1280x720@25 (Handy-Monitor, nicht Sendequalität).
    let width: u32 = env_or("OMP_WIDTH", "").parse().unwrap_or(1280);
    let height: u32 = env_or("OMP_HEIGHT", "").parse().unwrap_or(720);
    let fps_num: u32 = env_or("OMP_FRAMERATE_NUM", "").parse().unwrap_or(25);
    let fps_den: u32 = env_or("OMP_FRAMERATE_DEN", "").parse().unwrap_or(1);
    let bitrate_kbps: u32 = env_or("OMP_WEBRTC_BITRATE_KBPS", "4000").parse()?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let monitor = monitor::Monitor::new(
        monitor::Config {
            domain,
            width,
            height,
            fps_num,
            fps_den,
            sample_rate: 48_000,
            channels: 2,
            bitrate_kbps,
        },
        tx,
    )?;
    let media_ready_monitor = monitor.clone();
    let heartbeat = monitor.heartbeat.clone();

    let registry = RegistryClient::new(registry_url.clone());
    let video_receiver_id = omp_node_sdk::idgen::new_v4();
    let audio_receiver_id = omp_node_sdk::idgen::new_v4();
    let connected_video = Arc::new(Mutex::new(String::new()));
    let connected_audio = Arc::new(Mutex::new(String::new()));
    let video_connection = Arc::new(ReceiverConnection::new(
        video_receiver_id.clone(),
        VideoControl {
            registry: registry.clone(),
            monitor: monitor.clone(),
            connected: connected_video.clone(),
        },
    ));
    let audio_connection = Arc::new(ReceiverConnection::new(
        audio_receiver_id.clone(),
        AudioControl {
            registry,
            monitor: monitor.clone(),
            connected: connected_audio.clone(),
        },
    ));

    let store: Arc<dyn ParamStore> = Arc::new(MonitorStore {
        monitor: monitor.clone(),
        video_connection,
        audio_connection,
        connected_video,
        connected_audio,
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
                    ..Default::default()
                },
                ReceiverSpec {
                    id: Some(audio_receiver_id),
                    transport: Some(TRANSPORT_MXL.to_string()),
                    media_types: Some(vec!["audio/float32".to_string()]),
                    label: Some("Audio".to_string()),
                },
            ],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready_monitor.media_ready()
            })),
        },
        store,
    )
    .await?;
    handle.register_worker("pipeline", heartbeat);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-webrtc-gateway: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-webrtc-gateway: shutdown requested"),
        _ = events => eprintln!("omp-webrtc-gateway: pipeline event channel closed"),
    }
    Ok(())
}
