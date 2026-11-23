//! omp-avdelay: echter A/V-Delay für den MCR und die Workflows. Liest je einen per IS-05 gewählten Video- und Audio-Flow aus der
//! MXL-Domain des Nodes und schreibt sie zeitlich verschoben als eigene Flows zurück: das Bild um ganze Bilder
//! (`delay.videoFrames`), der Ton auf das Sample genau (`delay.audioMs`); beides jederzeit änderbar, der Ton gleitet ohne
//! Sprung (`delay.slewPermille`). Der Node ändert nur die Zeit, nie das Format (kein Wandlungspfad). Details: `pipeline.rs`, `delay.rs`.

mod delay;
mod pipeline;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use omp_mediaio::rawcopy::AvDelay;
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
struct DelayControl {
    registry: RegistryClient,
    pipeline: pipeline::PipelineHandle,
    kind: Kind,
    connected: Arc<Mutex<String>>,
}

impl ReceiverControl for DelayControl {
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
                    None => eprintln!("omp-avdelay: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-avdelay: resolve sender {sender_id} failed: {e}"),
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

struct DelayStore {
    in_domain: String,
    out_domain: String,
    delay: Arc<AvDelay>,
    slew: Mutex<f64>,
    frame_ms: f64,
    audio_ms: Mutex<f64>,
    video_connected: Arc<Mutex<String>>,
    audio_connected: Arc<Mutex<String>>,
    video_flow_id: String,
    audio_flow_id: String,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    video_conn: Arc<ReceiverConnection<DelayControl>>,
    audio_conn: Arc<ReceiverConnection<DelayControl>>,
    pipeline: pipeline::PipelineHandle,
}

fn rw(name: &str, unit: Option<&str>, range: Option<(f64, f64)>) -> ParamSpec {
    ParamSpec {
        name: name.to_string(),
        kind: ParamType::Number,
        unit: unit.map(str::to_string),
        range: range.map(|(min, max)| omp_node_sdk::Range::Number { min, max }),
        readonly: false,
    }
}

/// Obergrenze der Tonverzögerung (ms); größer macht ohne Bildverzögerung keinen Sinn für einen Ausgleich.
const MAX_AUDIO_MS: f64 = 10_000.0;

fn ro_names() -> [&'static str; 13] {
    ["inputDomain", "outputDomain", "connectedVideoFlowId", "connectedAudioFlowId", "targetVideoFlowId", "targetAudioFlowId", "targetWidth", "targetHeight", "targetFramerate", "videoMode", "audioMode", "videoFlowing", "audioFlowing"]
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

impl ParamStore for DelayStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            // Ein Grain Grundlatenz; dazu die einstellbare Bildverzögerung (0…max Bilder). Gerade dieser Node ist die Verzögerung,
            // die andere ausgleichen, daher meldet er Delay-Anpassung.
            latency: Some(LatencyInfo {
                video: Some(LatencyRange {
                    min_latency_frames: 1,
                    max_latency_frames: 1 + self.delay.max_frames(),
                }),
                audio: None,
                data: None,
                supports_delay_compensation: true,
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
                rw("delay.videoFrames", Some("frames"), Some((0.0, self.delay.max_frames() as f64))),
                rw("delay.audioMs", Some("ms"), Some((0.0, MAX_AUDIO_MS))),
                rw("delay.slewPermille", Some("permille"), Some((0.01, 1000.0))),
                ro("delay.videoMs", ParamType::Number),
                ro("delay.audioCurrentMs", ParamType::Number),
                ro("delay.offsetMs", ParamType::Number),
                ro("delay.maxVideoFrames", ParamType::Number),
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
            "delay.videoFrames" => Some(serde_json::json!(self.delay.video_frames())),
            "delay.audioMs" => Some(serde_json::json!(*self.audio_ms.lock().expect("lock poisoned"))),
            "delay.slewPermille" => Some(serde_json::json!(self.slew.lock().expect("lock poisoned").to_owned())),
            "delay.videoMs" => Some(serde_json::json!(delay::video_ms(self.delay.video_frames(), self.frame_ms))),
            "delay.audioCurrentMs" => Some(serde_json::json!(delay::samples_to_ms(self.delay.audio_current_samples()))),
            "delay.offsetMs" => Some(serde_json::json!(delay::offset_ms(
                delay::samples_to_ms(self.delay.audio_target_samples()),
                self.delay.video_frames(),
                self.frame_ms
            ))),
            "delay.maxVideoFrames" => Some(serde_json::json!(self.delay.max_frames())),
            "videoFlowing" => Some(serde_json::json!(self.pipeline.media_ready())),
            "audioFlowing" => Some(serde_json::json!(self.pipeline.audio_flowed())),
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let num = || value.as_f64().filter(|v| v.is_finite()).ok_or(SetError::Unknown);
        match name {
            "delay.videoFrames" => {
                let v = num()?;
                if v < 0.0 || v > self.delay.max_frames() as f64 {
                    return Err(SetError::Unknown);
                }
                self.delay.set_video_frames(v.round() as u32);
                Ok(())
            }
            "delay.audioMs" => {
                let v = num()?;
                if !(0.0..=MAX_AUDIO_MS).contains(&v) {
                    return Err(SetError::Unknown);
                }
                *self.audio_ms.lock().expect("lock poisoned") = v;
                self.delay.set_audio_delay_samples(delay::ms_to_samples(v));
                Ok(())
            }
            "delay.slewPermille" => {
                let v = num()?;
                if !(0.01..=1000.0).contains(&v) {
                    return Err(SetError::Unknown);
                }
                *self.slew.lock().expect("lock poisoned") = v;
                self.delay.set_slew_permille(v);
                Ok(())
            }
            n if n.starts_with("delay.") || ro_names().contains(&n) => Err(SetError::ReadOnly),
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
    let label = env_or("OMP_LABEL", "A/V-Delay");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9395").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let in_domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Standard: dieselbe Domain (Flows des Nodes liegen neben den Quellen); eine andere Ausgangsdomain ist möglich.
    let out_domain = match env_or("OMP_MXL_TARGET_DOMAIN", "") {
        d if d.is_empty() => in_domain.clone(),
        d => d,
    };
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
    let max_frames: u32 = env_or("OMP_AVDELAY_MAX_VIDEO_FRAMES", "").parse().ok().filter(|n| (1..=250).contains(n)).unwrap_or(25);
    let delay = AvDelay::new(max_frames);
    // Startwerte (die Laufzeit-Parameter überschreiben sie; der MCR setzt sie nach dem Start aus der Datenbank).
    let start_frames: u32 = env_or("OMP_AVDELAY_VIDEO_FRAMES", "").parse().unwrap_or(0);
    let start_audio_ms: f64 = env_or("OMP_AVDELAY_AUDIO_MS", "").parse().ok().filter(|v: &f64| v.is_finite() && (0.0..=MAX_AUDIO_MS).contains(v)).unwrap_or(0.0);
    delay.set_video_frames(start_frames);
    delay.set_audio_delay_samples(delay::ms_to_samples(start_audio_ms));
    let frame_ms = delay::frame_ms(fps_num, fps_den);
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
        delay: delay.clone(),
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let hb = pipeline_heartbeat.clone();
    let pipeline_thread =
        std::thread::spawn(move || pipeline::run(config, tx, pipeline_shutdown, ready_tx, hb));

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            eprintln!("omp-avdelay: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => return Err("pipeline thread ended before reporting readiness".into()),
    };

    let video_connected = Arc::new(Mutex::new(String::new()));
    let audio_connected = Arc::new(Mutex::new(String::new()));
    let make = |id: &str, kind: Kind, connected: &Arc<Mutex<String>>| {
        Arc::new(ReceiverConnection::new(
            id.to_string(),
            DelayControl {
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
    let store: Arc<dyn ParamStore> = Arc::new(DelayStore {
        in_domain,
        out_domain,
        delay,
        slew: Mutex::new(5.0),
        frame_ms,
        audio_ms: Mutex::new(start_audio_ms),
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
                    eprintln!("omp-avdelay: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-avdelay: shutdown requested"),
        _ = events => eprintln!("omp-avdelay: pipeline thread ended"),
    }
    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();
    Ok(())
}
