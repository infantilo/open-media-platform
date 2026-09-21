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

mod pipeline;

use std::sync::Arc;

use omp_node_sdk::is04::TRANSPORT_MXL;
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, SenderSpec,
    SetError,
};
use serde_json::Value;

const CAMERA_PAGE: &str = include_str!("camera.html");

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

struct Store {
    flow_id: String,
    audio_flow_id: String,
    gateway: Arc<pipeline::Gateway>,
}

impl ParamStore for Store {
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
            | "latencyMs" => Err(SetError::ReadOnly),
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

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "WebRTC-Kamera");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9440").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
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

    let store: Arc<dyn ParamStore> = Arc::new(Store {
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
