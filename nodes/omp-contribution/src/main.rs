//! omp-contribution: Leitungseingang (SRT) → MXL im nativen Format (UMSETZUNG 106.6). Endpunkt-Einstellungen sind
//! schreibbare Laufzeit-Parameter (`contrib.*`), Statistik ist nur lesbar. Passphrase nur aus `OMP_CONTRIB_PASSPHRASE_FILE`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use omp_contribution::config::{SrtMode, parse_pids, redact, validate_line_uri, validate_relay_uri};
use omp_contribution::pipeline::{self, Settings, Shared};
use omp_node_sdk::is04::TRANSPORT_MXL;
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{Descriptor, InvokeError, LatencyInfo, LatencyRange, NodeConfig, ParamSpec, ParamStore, ParamType, SenderSpec, SetError};
use serde_json::Value;

struct ContribStore {
    shared: Shared,
    flow_id: String,
    audio_flow_id: String,
}

fn spec(name: &str, kind: ParamType, readonly: bool) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly }
}

impl ParamStore for ContribStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: Some(LatencyInfo { video: Some(LatencyRange { min_latency_frames: 0, max_latency_frames: 0 }), audio: None, data: None, supports_delay_compensation: false }),
            parameters: vec![
                spec("contrib.uri", ParamType::String, false),
                spec("contrib.mode", ParamType::String, false),
                spec("contrib.latencyMs", ParamType::Number, false),
                spec("contrib.streamId", ParamType::String, false),
                spec("contrib.audioPids", ParamType::String, false),
                spec("contrib.relayUri", ParamType::String, false),
                spec("contrib.relayMode", ParamType::String, false),
                spec("contrib.transport", ParamType::String, true),
                spec("contrib.state", ParamType::String, true),
                spec("contrib.rttMs", ParamType::Number, true),
                spec("contrib.lossPermille", ParamType::Number, true),
                spec("contrib.retransmits", ParamType::Number, true),
                spec("contrib.bitrateKbps", ParamType::Number, true),
                spec("contrib.inputFormat", ParamType::String, true),
                spec("contrib.audioChannels", ParamType::Number, true),
                spec("contrib.lastError", ParamType::String, true),
                spec("contrib.reconnects", ParamType::Number, true),
                spec("flowId", ParamType::String, true),
                spec("audioFlowId", ParamType::String, true),
            ],
            methods: vec![],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let s = &self.shared;
        let st = s.settings.lock().expect("lock poisoned").clone();
        let stats = s.stats.lock().expect("lock poisoned").clone();
        match name {
            "contrib.uri" => Some(serde_json::json!(redact(&st.uri))),
            "contrib.mode" => Some(serde_json::json!(st.mode.as_str())),
            "contrib.latencyMs" => Some(serde_json::json!(st.latency_ms)),
            "contrib.streamId" => Some(serde_json::json!(st.stream_id)),
            "contrib.audioPids" => Some(serde_json::json!(st.audio_pids.iter().map(|p| format!("0x{p:x}")).collect::<Vec<_>>().join(","))),
            "contrib.relayUri" => Some(serde_json::json!(redact(&st.relay_uri))),
            "contrib.relayMode" => Some(serde_json::json!(st.relay_mode.as_str())),
            "contrib.transport" => Some(serde_json::json!(validate_line_uri(&st.uri).map(|(t, _)| t.as_str()).unwrap_or("srt"))),
            "contrib.state" => Some(serde_json::json!(*s.state.lock().expect("lock poisoned"))),
            "contrib.rttMs" => Some(serde_json::json!(stats.rtt_ms)),
            "contrib.lossPermille" => Some(serde_json::json!(stats.loss_permille)),
            "contrib.retransmits" => Some(serde_json::json!(stats.retransmits)),
            "contrib.bitrateKbps" => Some(serde_json::json!(stats.bitrate_kbps)),
            "contrib.inputFormat" => Some(serde_json::json!(*s.input_format.lock().expect("lock poisoned"))),
            "contrib.audioChannels" => Some(serde_json::json!(s.audio_channels.load(Ordering::Relaxed))),
            "contrib.lastError" => Some(serde_json::json!(*s.last_error.lock().expect("lock poisoned"))),
            "contrib.reconnects" => Some(serde_json::json!(s.reconnects.load(Ordering::Relaxed))),
            "flowId" => Some(serde_json::json!(self.flow_id)),
            "audioFlowId" => Some(serde_json::json!(self.audio_flow_id)),
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let s = &self.shared;
        let bad = |e: String| {
            eprintln!("omp-contribution: {e}");
            SetError::Unknown
        };
        {
            let mut st = s.settings.lock().expect("lock poisoned");
            match name {
                "contrib.uri" => st.uri = validate_line_uri(value.as_str().ok_or(SetError::Unknown)?).map_err(bad)?.1,
                "contrib.relayUri" => st.relay_uri = validate_relay_uri(value.as_str().ok_or(SetError::Unknown)?).map_err(bad)?,
                "contrib.relayMode" => st.relay_mode = SrtMode::parse(value.as_str().ok_or(SetError::Unknown)?).map_err(bad)?,
                "contrib.mode" => st.mode = SrtMode::parse(value.as_str().ok_or(SetError::Unknown)?).map_err(bad)?,
                "contrib.latencyMs" => {
                    let v = value.as_f64().filter(|v| (0.0..=30000.0).contains(v)).ok_or(SetError::Unknown)?;
                    st.latency_ms = v as u32;
                }
                "contrib.streamId" => st.stream_id = value.as_str().ok_or(SetError::Unknown)?.to_string(),
                "contrib.audioPids" => st.audio_pids = parse_pids(value.as_str().ok_or(SetError::Unknown)?).map_err(bad)?,
                n if self.get(n).is_some() => return Err(SetError::ReadOnly),
                _ => return Err(SetError::Unknown),
            }
        }
        s.reconfigure.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn invoke(&self, _name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn env_num<T: std::str::FromStr>(key: &str, fallback: T) -> T {
    env_or(key, "").trim().parse().unwrap_or(fallback)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Leitung");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9396").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let direction = env_or("OMP_CONTRIB_DIRECTION", "in");
    match direction.as_str() {
        "in" => {}
        "out" => return omp_contribution::outnode::run_node().await,
        other => return Err(format!("OMP_CONTRIB_DIRECTION: „{other}“ unbekannt (in, out)").into()),
    }
    let uri = validate_line_uri(&env_or("OMP_CONTRIB_URI", "srt://:9000"))?.1;
    let mode = SrtMode::parse(&env_or("OMP_CONTRIB_MODE", "listener"))?;
    let settings = Settings {
        uri,
        mode,
        latency_ms: env_num("OMP_CONTRIB_LATENCY_MS", 200u32),
        stream_id: env_or("OMP_CONTRIB_STREAMID", ""),
        audio_pids: parse_pids(&env_or("OMP_CONTRIB_AUDIO_PIDS", ""))?,
        relay_uri: validate_relay_uri(&env_or("OMP_CONTRIB_RELAY_URI", ""))?,
        relay_mode: SrtMode::parse(&env_or("OMP_CONTRIB_RELAY_MODE", "caller"))?,
    };
    // Deklaration für NMOS (vor dem ersten Bild nötig). Der MXL-Fluss selbst trägt das erkannte native Format.
    let (decl_w, decl_h): (u32, u32) = (env_num("OMP_WIDTH", 1920), env_num("OMP_HEIGHT", 1080));
    let (num, den): (u32, u32) = (env_num("OMP_FRAMERATE_NUM", 25), env_num("OMP_FRAMERATE_DEN", 1));
    let decl_channels: u32 = env_num("OMP_CONTRIB_AUDIO_CHANNELS", 2);
    let passphrase_file = std::env::var("OMP_CONTRIB_PASSPHRASE_FILE").ok().filter(|p| !p.is_empty());

    let flow_id = std::env::var("OMP_VIDEO_FLOW_ID").unwrap_or_else(|_| omp_node_sdk::idgen::new_v4());
    let audio_flow_id = std::env::var("OMP_AUDIO_FLOW_ID").unwrap_or_else(|_| omp_node_sdk::idgen::new_v4());

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let shared = Shared::new(settings);
    let cfg = pipeline::Config {
        domain,
        flow_id: flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        label: label.clone(),
        fallback_rate: (num as i32, den as i32),
        passphrase_file,
    };
    let hb = Arc::new(AtomicU64::new(0));
    let (sd, hb2, sh2) = (shutdown.clone(), hb.clone(), shared.clone());
    let th = std::thread::spawn(move || pipeline::run(cfg, tx, sd, ready_tx, hb2, sh2));
    match ready_rx.await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => return Err("Pipeline-Thread vorzeitig beendet".into()),
    }

    let store: Arc<dyn ParamStore> = Arc::new(ContribStore { shared: shared.clone(), flow_id: flow_id.clone(), audio_flow_id: audio_flow_id.clone() });
    let group = omp_node_sdk::group::name_or(&flow_id);
    let flowed = shared.video_flowed.clone();
    let video_total = shared.video_total.clone();
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
                    flow: Some(FlowSpec::Video { id: Some(flow_id), frame_width: decl_w, frame_height: decl_h, grain_rate_numerator: num, grain_rate_denominator: den }),
                    tags: HashMap::from([
                        ("urn:x-nmos:tag:grouphint/v1.0".to_string(), vec![format!("{group}:high")]),
                        ("urn:x-omp:tags".to_string(), vec!["source.live".to_string()]),
                    ]),
                    ..Default::default()
                },
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Audio { id: Some(audio_flow_id), sample_rate_numerator: 48000, channel_count: decl_channels, media_type: "audio/float32".to_string(), bit_depth: 32, source_id: None }),
                    tags: HashMap::from([("urn:x-nmos:tag:grouphint/v1.0".to_string(), vec![format!("{group}:audio")])]),
                    ..Default::default()
                },
            ],
            receivers: vec![],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || flowed.load(Ordering::Relaxed))),
        },
        store,
    )
    .await?;
    handle.register_worker("pipeline", hb);
    handle.register_rate_kpi("video_fps", video_total);

    let events = async {
        while let Some(pipeline::Event::Error(m)) = rx.recv().await {
            let m = omp_node_sdk::errcode::tag(&m);
            eprintln!("omp-contribution: {m}");
            handle.publish_alert(m).await;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-contribution: shutdown requested"),
        _ = events => eprintln!("omp-contribution: pipeline thread ended"),
    }
    shutdown.store(true, Ordering::Relaxed);
    let _ = th.join();
    Ok(())
}
