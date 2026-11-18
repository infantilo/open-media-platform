//! omp-mxl-bridge (Kap. 103, Entwurf D5): Brücke zwischen zwei MXL-Domains auf demselben Rechner. Der Node läuft in der
//! Domain seiner Eingänge (`OMP_MXL_DOMAIN`), liest je einen per IS-05 gewählten Video- und Audio-Flow und schreibt sie
//! als eigene Flows in die Zieldomain (`OMP_MXL_TARGET_DOMAIN`). Die Brücke wandelt nicht (Format der Quelle = Format der Brücke, sonst Ablehnung; nur `OMP_BRIDGE_CONVERT=1` wandelt).
//! Details: `pipeline.rs`.

mod pipeline;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use omp_node_sdk::connection::{
    ReceiverConnection, ReceiverControl, ReceiverResource, bulk_cors_methods, bulk_discovery,
    bulk_patch, list_ids, root_discovery,
};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, LatencyInfo, LatencyRange, NodeConfig, ParamSpec, ParamStore,
    ParamType, RawResponse, ReceiverSpec, SenderSpec, SetError,
};
use serde_json::Value;

#[derive(Clone, Copy)]
enum Kind {
    Video,
    Audio,
}

/// Setzt IS-05-PATCHes (Quellwahl) um: löst den Sender zur MXL-`flow_id` auf und lässt den Zweig neu aufbauen.
struct BridgeControl {
    registry: RegistryClient,
    pipeline: pipeline::PipelineHandle,
    kind: Kind,
    connected: Arc<Mutex<String>>,
}

impl ReceiverControl for BridgeControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected.lock().expect("lock poisoned") = flow_id.clone();
                        match self.kind {
                            Kind::Video => self.pipeline.connect_video(flow_id),
                            Kind::Audio => self.pipeline.connect_audio(flow_id),
                        }
                    }
                    None => eprintln!("omp-mxl-bridge: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-mxl-bridge: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected.lock().expect("lock poisoned") = String::new();
                match self.kind {
                    Kind::Video => self.pipeline.disconnect_video(),
                    Kind::Audio => self.pipeline.disconnect_audio(),
                }
            }
        }
    }
}

struct BridgeStore {
    in_domain: String,
    out_domain: String,
    video_connected: Arc<Mutex<String>>,
    audio_connected: Arc<Mutex<String>>,
    video_flow_id: String,
    audio_flow_id: String,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    video_conn: Arc<ReceiverConnection<BridgeControl>>,
    audio_conn: Arc<ReceiverConnection<BridgeControl>>,
    pipeline: pipeline::PipelineHandle,
}

fn ro(name: &str, kind: ParamType) -> ParamSpec {
    ParamSpec {
        name: name.to_string(),
        kind,
        unit: None,
        range: None,
        readonly: true,
    }
}

impl ParamStore for BridgeStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            // Wie beim Scaler: ein Grain Verzögerung durch die Ausgangskette; keine Verzögerungsanpassung.
            latency: Some(LatencyInfo {
                video: Some(LatencyRange {
                    min_latency_frames: 1,
                    max_latency_frames: 1,
                }),
                audio: None,
                data: None,
                supports_delay_compensation: false,
            }),
            parameters: vec![
                ro("inputDomain", ParamType::String),
                ro("outputDomain", ParamType::String),
                ro("connectedVideoFlowId", ParamType::String),
                ro("connectedAudioFlowId", ParamType::String),
                ro("targetVideoFlowId", ParamType::String),
                ro("targetAudioFlowId", ParamType::String),
                ro("targetWidth", ParamType::Number),
                ro("targetHeight", ParamType::Number),
                ro("targetFramerate", ParamType::String),
                ro("videoMode", ParamType::String),
                ro("audioMode", ParamType::String),
                ro("videoFlowing", ParamType::Boolean),
                ro("audioFlowing", ParamType::Boolean),
            ],
            methods: vec![],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "inputDomain" => Some(serde_json::json!(self.in_domain)),
            "outputDomain" => Some(serde_json::json!(self.out_domain)),
            "connectedVideoFlowId" => Some(serde_json::json!(
                *self.video_connected.lock().expect("lock poisoned")
            )),
            "connectedAudioFlowId" => Some(serde_json::json!(
                *self.audio_connected.lock().expect("lock poisoned")
            )),
            "targetVideoFlowId" => Some(serde_json::json!(self.video_flow_id)),
            "targetAudioFlowId" => Some(serde_json::json!(self.audio_flow_id)),
            "targetWidth" => Some(serde_json::json!(self.width)),
            "targetHeight" => Some(serde_json::json!(self.height)),
            "targetFramerate" => Some(serde_json::json!(format!(
                "{}/{}",
                self.fps_num, self.fps_den
            ))),
            "videoMode" => Some(serde_json::json!(self.pipeline.video_mode())),
            "audioMode" => Some(serde_json::json!(self.pipeline.audio_mode())),
            "videoFlowing" => Some(serde_json::json!(self.pipeline.media_ready())),
            "audioFlowing" => Some(serde_json::json!(self.pipeline.audio_flowed())),
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
        let to_raw = |(status, content_type, body)| RawResponse {
            status,
            content_type,
            body,
        };
        let (vid, aid) = (self.video_conn.id(), self.audio_conn.id());
        root_discovery(method, path)
            .or_else(|| list_ids(method, path, "receivers", &[vid, aid]))
            .or_else(|| bulk_discovery(method, path))
            .or_else(|| {
                bulk_patch(method, path, "receivers", body, |id, params| {
                    if id == vid {
                        Some(self.video_conn.patch_staged(params).0)
                    } else if id == aid {
                        Some(self.audio_conn.patch_staged(params).0)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| bulk_patch(method, path, "senders", body, |_, _| None))
            .or_else(|| self.video_conn.handle(method, path, body))
            .or_else(|| self.audio_conn.handle(method, path, body))
            .map(to_raw)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.video_conn
            .cors_methods(path)
            .or_else(|| self.audio_conn.cors_methods(path))
            .or_else(|| bulk_cors_methods(path, "senders"))
            .or_else(|| bulk_cors_methods(path, "receivers"))
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "MXL-Bruecke");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9390").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let in_domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let out_domain = env_or("OMP_MXL_TARGET_DOMAIN", "");
    if out_domain.is_empty() {
        eprintln!(
            "omp-mxl-bridge: OMP_MXL_TARGET_DOMAIN ist nicht gesetzt (Zieldomain beim Start wählen)"
        );
        return Err("OMP_MXL_TARGET_DOMAIN fehlt".into());
    }
    if out_domain == in_domain {
        eprintln!(
            "omp-mxl-bridge: Ein- und Ausgangsdomain sind gleich ({in_domain}) — die Brücke tut nichts Sinnvolles"
        );
    }
    // Format der Brücke = Format der durchgereichten Quelle (die Brücke wandelt nicht); Standard wie `omp-source`.
    let width: u32 = env_or("OMP_WIDTH", "").parse().unwrap_or(640);
    let height: u32 = env_or("OMP_HEIGHT", "").parse().unwrap_or(480);
    let fps_num: u32 = env_or("OMP_FRAMERATE_NUM", "").parse().unwrap_or(25);
    let fps_den: u32 = env_or("OMP_FRAMERATE_DEN", "").parse().unwrap_or(1);
    let audio_channels: u32 = env_or("OMP_AUDIO_CHANNELS", "")
        .parse()
        .ok()
        .filter(|c| (1..=64).contains(c))
        .unwrap_or(2);
    let rate_mode = omp_mediaio::framerate::RateMode::from_env();
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let video_receiver_id = omp_node_sdk::idgen::new_v4();
    let audio_receiver_id = omp_node_sdk::idgen::new_v4();
    let video_flow_id = omp_node_sdk::idgen::new_v4();
    let audio_flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let config = pipeline::Config {
        in_domain: in_domain.clone(),
        out_domain: out_domain.clone(),
        video_flow_id: video_flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        label: label.clone(),
        width,
        height,
        framerate_numerator: fps_num,
        framerate_denominator: fps_den,
        audio_channels,
        convert: env_or("OMP_BRIDGE_CONVERT", "") == "1",
        rate_mode,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let hb = pipeline_heartbeat.clone();
    let pipeline_thread =
        std::thread::spawn(move || pipeline::run(config, tx, pipeline_shutdown, ready_tx, hb));

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            eprintln!("omp-mxl-bridge: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => return Err("pipeline thread ended before reporting readiness".into()),
    };

    let video_connected = Arc::new(Mutex::new(String::new()));
    let audio_connected = Arc::new(Mutex::new(String::new()));
    let make = |id: &str, kind: Kind, connected: &Arc<Mutex<String>>| {
        Arc::new(ReceiverConnection::new(
            id.to_string(),
            BridgeControl {
                registry: RegistryClient::new(registry_url.clone()),
                pipeline: pipeline_handle.clone(),
                kind,
                connected: connected.clone(),
            },
        ))
    };
    let video_conn = make(&video_receiver_id, Kind::Video, &video_connected);
    let audio_conn = make(&audio_receiver_id, Kind::Audio, &audio_connected);

    let media_ready = pipeline_handle.clone();
    let store: Arc<dyn ParamStore> = Arc::new(BridgeStore {
        in_domain,
        out_domain,
        video_connected,
        audio_connected,
        video_flow_id: video_flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        width,
        height,
        fps_num,
        fps_den,
        video_conn,
        audio_conn,
        pipeline: pipeline_handle,
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
                        id: Some(video_flow_id),
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
                        sample_rate_numerator: pipeline::SAMPLE_RATE,
                        channel_count: audio_channels,
                        media_type: "audio/float32".to_string(),
                        bit_depth: 32,
                        source_id: None,
                    }),
                    ..Default::default()
                },
            ],
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
                    ..Default::default()
                },
            ],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready.media_ready()
            })),
        },
        store,
    )
    .await?;

    handle.register_worker("pipeline", pipeline_heartbeat);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    let message = omp_node_sdk::errcode::tag(&message);
                    eprintln!("omp-mxl-bridge: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-mxl-bridge: shutdown requested"),
        _ = events => eprintln!("omp-mxl-bridge: pipeline thread ended"),
    }
    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();
    Ok(())
}
