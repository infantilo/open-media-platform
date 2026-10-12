//! omp-playout-buffer (Kapitel 39): Failover-Puffer am Ende eines Workflow-Graphen. Liest einen
//! MXL-Video- und einen MXL-Audio-Flow, hält eine konfigurierbare Tiefe (`bufferMs`, Standard 2,5 s)
//! vor und schreibt beides als eigene, nie abreißende MXL-Flows im festen Zielformat. Fällt der
//! Vorgänger aus (Absturz, Umschalten, Standby-Übernahme), läuft der Ausgang erst aus dem Puffer,
//! danach mit Standbild/Schwarz und Stille weiter — und setzt an der Wiederaufnahme mit neu
//! aufgebauter, streng monotoner Zeitleiste fort. Details: `buffer.rs` (Logik), `pipeline.rs`.

mod buffer;
mod pipeline;
mod uibundle;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use omp_node_sdk::connection::{
    ReceiverConnection, ReceiverControl, ReceiverResource, bulk_cors_methods, bulk_discovery, bulk_patch, list_ids,
    root_discovery,
};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, LatencyInfo, LatencyRange, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore,
    ParamType, Range, RawResponse, ReceiverSpec, SenderSpec, SetError,
};
use serde_json::Value;

/// Gemeinsam für Video- und Audio-Receiver (wie `omp-recorder`): löst `sender_id` über die Registry auf
/// eine MXL-`flow_id` auf. Ein leerer `sender_id` (oder `master_enable=false`) trennt — der Ausgang läuft
/// dabei unverändert weiter.
struct BufferReceiverControl {
    registry: RegistryClient,
    pipeline: pipeline::PipelineHandle,
    is_video: bool,
    connected_flow_id: Arc<Mutex<String>>,
}

impl ReceiverControl for BufferReceiverControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        if self.is_video {
                            self.pipeline.connect_video(flow_id);
                        } else {
                            self.pipeline.connect_audio(flow_id);
                        }
                    }
                    None => eprintln!("omp-playout-buffer: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-playout-buffer: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                self.connected_flow_id.lock().expect("lock poisoned").clear();
                if self.is_video {
                    self.pipeline.disconnect_video();
                } else {
                    self.pipeline.disconnect_audio();
                }
            }
        }
    }
}

struct BufferStore {
    pipeline: pipeline::PipelineHandle,
    video_connection: Arc<ReceiverConnection<BufferReceiverControl>>,
    audio_connection: Arc<ReceiverConnection<BufferReceiverControl>>,
    connected_video: Arc<Mutex<String>>,
    connected_audio: Arc<Mutex<String>>,
    video_flow_id: String,
    audio_flow_id: String,
    format: String,
    fps_num: u32,
    fps_den: u32,
    sample_rate: u32,
}

fn ro(name: &str, kind: ParamType, unit: Option<&str>) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: unit.map(str::to_string), range: None, readonly: true }
}

impl BufferStore {
    fn period_ms(&self) -> f64 {
        1000.0 * self.fps_den as f64 / self.fps_num.max(1) as f64
    }
}

impl ParamStore for BufferStore {
    fn descriptor(&self) -> Descriptor {
        // Latenz = eigene Pufferdeckung (`bufferMs`), deterministisch (min == max). Der vom Orchestrator
        // zugewiesene Ausgleich (`setOutputDelay`) kommt bewusst NICHT hinein — wie beim Scaler beschreibt die
        // Deklaration die Eigenlatenz, der Ausgleich wird vom Plan obendrauf gerechnet.
        let target_ms = self.pipeline.buffer_ms() as f64;
        let video_frames = (target_ms / self.period_ms()).round() as u32 + 1;
        let audio_samples = (target_ms * self.sample_rate as f64 / 1000.0).round() as u32;
        let mut parameters = vec![
            ParamSpec {
                name: "bufferMs".to_string(),
                kind: ParamType::Number,
                unit: Some("ms".to_string()),
                range: Some(Range::Number { min: 100.0, max: 20000.0 }),
                readonly: false,
            },
            ParamSpec {
                name: "resumeMs".to_string(),
                kind: ParamType::Number,
                unit: Some("ms".to_string()),
                range: Some(Range::Number { min: 0.0, max: 20000.0 }),
                readonly: false,
            },
            ParamSpec {
                name: "refillPermille".to_string(),
                kind: ParamType::Number,
                unit: Some("‰".to_string()),
                range: Some(Range::Number { min: 0.0, max: 100.0 }),
                readonly: false,
            },
            ParamSpec {
                name: "holdMode".to_string(),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum { values: vec!["last".to_string(), "black".to_string()] }),
                readonly: false,
            },
        ];
        for (name, kind, unit) in [
            ("state", ParamType::Enum, None),
            ("refilling", ParamType::Boolean, None),
            ("refillFrames", ParamType::Number, None),
            ("refillSamples", ParamType::Number, None),
            ("targetMs", ParamType::Number, Some("ms")),
            ("delayFrames", ParamType::Number, Some("frames")),
            ("fillMs", ParamType::Number, Some("ms")),
            ("audioFillMs", ParamType::Number, Some("ms")),
            ("frontAgeMs", ParamType::Number, Some("ms")),
            ("bufferBytes", ParamType::Number, Some("B")),
            ("maxBytes", ParamType::Number, Some("B")),
            ("droppedFrames", ParamType::Number, None),
            ("trimmedFrames", ParamType::Number, None),
            ("underruns", ParamType::Number, None),
            ("resumes", ParamType::Number, None),
            ("holdTicks", ParamType::Number, None),
            ("silentBlocks", ParamType::Number, None),
            ("audioSeeks", ParamType::Number, None),
            ("audioGapSamples", ParamType::Number, None),
            ("audioSkippedSamples", ParamType::Number, None),
            ("tsJumps", ParamType::Number, None),
            ("videoIn", ParamType::Number, None),
            ("audioIn", ParamType::Number, None),
            ("videoOut", ParamType::Number, None),
            ("audioOut", ParamType::Number, None),
            ("originTsVideoPct", ParamType::Number, Some("%")),
            ("originTsAudioPct", ParamType::Number, Some("%")),
            ("inputRebuilds", ParamType::Number, None),
            ("videoInputAgeMs", ParamType::Number, Some("ms")),
            ("audioInputAgeMs", ParamType::Number, Some("ms")),
            ("connectedVideoFlowId", ParamType::String, None),
            ("connectedAudioFlowId", ParamType::String, None),
            ("targetVideoFlowId", ParamType::String, None),
            ("targetAudioFlowId", ParamType::String, None),
            ("format", ParamType::String, None),
            ("status", ParamType::String, None),
        ] {
            let mut spec = ro(name, kind, unit);
            if name == "state" {
                spec.range = Some(Range::Enum { values: vec!["fill".to_string(), "run".to_string(), "hold".to_string()] });
            }
            parameters.push(spec);
        }
        Descriptor {
            latency: Some(LatencyInfo {
                video: Some(LatencyRange { min_latency_frames: video_frames, max_latency_frames: video_frames }),
                audio: Some(LatencyRange { min_latency_frames: audio_samples, max_latency_frames: audio_samples }),
                data: None,
                supports_delay_compensation: true,
            }),
            parameters,
            methods: vec![MethodSpec {
                name: "setOutputDelay".to_string(),
                args: vec![MethodArg { name: "frames".to_string(), kind: ParamType::Number }],
            }],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let s = self.pipeline.snapshot();
        let j = |v: u64| Some(serde_json::json!(v));
        match name {
            "bufferMs" => j(self.pipeline.buffer_ms()),
            "resumeMs" => j(self.pipeline.resume_ms()),
            "holdMode" => Some(serde_json::json!(self.pipeline.hold_mode().as_str())),
            "refillPermille" => j(self.pipeline.refill_permille() as u64),
            "state" => Some(serde_json::json!(s.state)),
            "refilling" => Some(serde_json::json!(s.refilling)),
            "refillFrames" => j(s.refill_frames),
            "refillSamples" => j(s.refill_samples),
            "targetMs" => j(s.target_ms),
            "delayFrames" => j(self.pipeline.delay_frames()),
            "fillMs" => j(s.video_fill_ms),
            "audioFillMs" => j(s.audio_fill_ms),
            "frontAgeMs" => j(s.front_age_ms),
            "bufferBytes" => j(s.buffer_bytes as u64),
            "maxBytes" => j(s.max_bytes as u64),
            "droppedFrames" => j(s.dropped_video),
            "trimmedFrames" => j(s.trimmed_video),
            "underruns" => j(s.underruns),
            "resumes" => j(s.resumes),
            "holdTicks" => j(s.hold_ticks),
            "silentBlocks" => j(s.silent_blocks),
            "audioSeeks" => j(s.audio_seeks),
            "audioGapSamples" => j(s.audio_gap_samples),
            "audioSkippedSamples" => j(s.audio_skipped_samples),
            "tsJumps" => j(s.video_ts_jumps + s.audio_ts_jumps),
            "videoIn" => j(s.video_in),
            "audioIn" => j(s.audio_in),
            "videoOut" => j(s.video_out),
            "audioOut" => j(s.audio_out),
            "originTsVideoPct" => j(s.video_origin_ts_pct),
            "originTsAudioPct" => j(s.audio_origin_ts_pct),
            "inputRebuilds" => j(s.rebuilds_video + s.rebuilds_audio),
            "videoInputAgeMs" => j(s.video_input_age_ms),
            "audioInputAgeMs" => j(s.audio_input_age_ms),
            "connectedVideoFlowId" => Some(serde_json::json!(*self.connected_video.lock().expect("lock poisoned"))),
            "connectedAudioFlowId" => Some(serde_json::json!(*self.connected_audio.lock().expect("lock poisoned"))),
            "targetVideoFlowId" => Some(serde_json::json!(self.video_flow_id)),
            "targetAudioFlowId" => Some(serde_json::json!(self.audio_flow_id)),
            "format" => Some(serde_json::json!(self.format)),
            // Alle Messwerte in einem Aufruf (JSON-Text) — das Panel fragt einmal je Sekunde nur dies ab.
            "status" => Some(serde_json::json!(
                serde_json::json!({
                    "state": s.state, "targetMs": s.target_ms, "fillMs": s.video_fill_ms, "audioFillMs": s.audio_fill_ms,
                    "frontAgeMs": s.front_age_ms, "bufferBytes": s.buffer_bytes, "maxBytes": s.max_bytes,
                    "droppedFrames": s.dropped_video, "videoFrames": s.video_frames, "droppedAudioBytes": s.dropped_audio_bytes, "trimmedFrames": s.trimmed_video, "underruns": s.underruns,
                    "resumes": s.resumes, "holdTicks": s.hold_ticks, "silentBlocks": s.silent_blocks,
                    "refilling": s.refilling, "refillFrames": s.refill_frames, "refillSamples": s.refill_samples,
                    "audioSeeks": s.audio_seeks, "audioGapSamples": s.audio_gap_samples,
                    "audioSkippedSamples": s.audio_skipped_samples,
                    "tsJumps": s.video_ts_jumps + s.audio_ts_jumps, "videoIn": s.video_in, "audioIn": s.audio_in,
                    "videoOut": s.video_out, "audioOut": s.audio_out, "originTsVideoPct": s.video_origin_ts_pct,
                    "originTsAudioPct": s.audio_origin_ts_pct, "inputRebuilds": s.rebuilds_video + s.rebuilds_audio,
                    "videoInputAgeMs": s.video_input_age_ms, "audioInputAgeMs": s.audio_input_age_ms,
                    "delayFrames": self.pipeline.delay_frames(),
                    "videoConnected": !self.connected_video.lock().expect("lock poisoned").is_empty(),
                    "audioConnected": !self.connected_audio.lock().expect("lock poisoned").is_empty(),
                })
                .to_string()
            )),
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let num = || value.as_f64().filter(|v| v.is_finite() && *v >= 0.0).map(|v| v as u64).ok_or(SetError::Unknown);
        match name {
            "bufferMs" => {
                let ms = num()?;
                if !(100..=20000).contains(&ms) {
                    return Err(SetError::Unknown);
                }
                self.pipeline.set_buffer_ms(ms);
                Ok(())
            }
            "resumeMs" => {
                let ms = num()?;
                if ms > 20000 {
                    return Err(SetError::Unknown);
                }
                self.pipeline.set_resume_ms(ms);
                Ok(())
            }
            "refillPermille" => {
                let v = num()?;
                if v > 100 {
                    return Err(SetError::Unknown);
                }
                self.pipeline.set_refill_permille(v as u32);
                Ok(())
            }
            "holdMode" => {
                let mode = value.as_str().and_then(buffer::HoldMode::parse).ok_or(SetError::Unknown)?;
                self.pipeline.set_hold_mode(mode);
                Ok(())
            }
            _ if self.get(name).is_some() => Err(SetError::ReadOnly),
            _ => Err(SetError::Unknown),
        }
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            // D8 (ARCHITECTURE.md §15.1 Punkt 3): wird zur Zieltiefe addiert (Bild + Ton gemeinsam).
            "setOutputDelay" => {
                let frames = args
                    .get("frames")
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite() && *v >= 0.0)
                    .map(|v| v as u64)
                    .ok_or(InvokeError::Unknown)?;
                self.pipeline.set_output_delay(frames);
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        if let Some(ui) = uibundle::route(method, path) {
            return Some(ui);
        }
        root_discovery(method, path)
            .or_else(|| list_ids(method, path, "receivers", &[self.video_connection.id(), self.audio_connection.id()]))
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
        self.video_connection
            .cors_methods(path)
            .or_else(|| self.audio_connection.cors_methods(path))
            .or_else(|| bulk_cors_methods(path, "senders"))
            .or_else(|| bulk_cors_methods(path, "receivers"))
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn env_num<T: std::str::FromStr>(key: &str, fallback: T) -> T {
    std::env::var(key).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(fallback)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Playout-Puffer");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9385").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Zielformat wie omp-scaler/omp-source (Rollenformat des Workflows setzt dieselben Variablen).
    let width: u32 = env_num("OMP_WIDTH", 640);
    let height: u32 = env_num("OMP_HEIGHT", 480);
    let fps_num: u32 = env_num("OMP_FRAMERATE_NUM", 25);
    let fps_den: u32 = env_num("OMP_FRAMERATE_DEN", 1);
    let sample_rate: u32 = env_num("OMP_AUDIO_RATE", 48000);
    let channels: u32 = env_num("OMP_AUDIO_CHANNELS", 2);
    let buffer_ms: u64 = env_num("OMP_BUFFER_MS", 2500u64).clamp(100, 20000);
    let resume_ms: Option<u64> = std::env::var("OMP_RESUME_MS").ok().and_then(|v| v.trim().parse().ok());
    let hold_mode = buffer::HoldMode::parse(&env_or("OMP_HOLD_MODE", "last")).unwrap_or(buffer::HoldMode::Last);
    let max_video_mib: u64 = env_num("OMP_BUFFER_MAX_MIB", 1024u64);
    let refill_permille: u32 = env_num("OMP_REFILL_PERMILLE", 10u32).min(100);
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let video_receiver_id = omp_node_sdk::idgen::new_v4();
    let audio_receiver_id = omp_node_sdk::idgen::new_v4();
    let video_flow_id = omp_node_sdk::idgen::new_v4();
    let audio_flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        label: label.clone(),
        video_flow_id: video_flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        width,
        height,
        fps_num,
        fps_den,
        sample_rate,
        channels,
        buffer_ms,
        resume_ms,
        hold_mode,
        refill_permille,
        max_video_mib,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let output_heartbeat = Arc::new(AtomicU64::new(0));
    let (hb_in, hb_out) = (pipeline_heartbeat.clone(), output_heartbeat.clone());
    let pipeline_thread =
        std::thread::spawn(move || pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx, hb_in, hb_out));

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-playout-buffer: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-playout-buffer: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let registry = RegistryClient::new(registry_url.clone());
    let connected_video = Arc::new(Mutex::new(String::new()));
    let connected_audio = Arc::new(Mutex::new(String::new()));
    let video_connection = Arc::new(ReceiverConnection::new(
        video_receiver_id.clone(),
        BufferReceiverControl {
            registry: registry.clone(),
            pipeline: pipeline_handle.clone(),
            is_video: true,
            connected_flow_id: connected_video.clone(),
        },
    ));
    let audio_connection = Arc::new(ReceiverConnection::new(
        audio_receiver_id.clone(),
        BufferReceiverControl {
            registry,
            pipeline: pipeline_handle.clone(),
            is_video: false,
            connected_flow_id: connected_audio.clone(),
        },
    ));

    let media_ready_pipeline = pipeline_handle.clone();
    let store: Arc<dyn ParamStore> = Arc::new(BufferStore {
        pipeline: pipeline_handle,
        video_connection,
        audio_connection,
        connected_video,
        connected_audio,
        video_flow_id: video_flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        format: format!("{width}x{height}@{fps_num}/{fps_den} {sample_rate} Hz x{channels}"),
        fps_num,
        fps_den,
        sample_rate,
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
                    label: Some("Video".to_string()),
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
                    label: Some("Audio".to_string()),
                    ..Default::default()
                },
            ],
            receivers: vec![
                ReceiverSpec {
                    id: Some(video_receiver_id),
                    transport: Some(TRANSPORT_MXL.to_string()),
                    media_types: Some(vec!["video/v210".to_string()]),
                    label: Some("Video".to_string()),
                    ..Default::default()
                },
                ReceiverSpec {
                    id: Some(audio_receiver_id),
                    transport: Some(TRANSPORT_MXL.to_string()),
                    media_types: Some(vec!["audio/float32".to_string()]),
                    label: Some("Audio".to_string()),
                    ..Default::default()
                },
            ],
            instance_id,
            // Der Ausgang schreibt von Anfang an (Schwarz/Stille, solange nichts anliegt) — wie ein Mischer.
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_ready_pipeline.media_ready())),
        },
        store,
    )
    .await?;

    // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md Nachtrag 130/131).
    handle.register_worker("inputs", pipeline_heartbeat);
    handle.register_worker("output", output_heartbeat);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-playout-buffer: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-playout-buffer: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-playout-buffer: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}
