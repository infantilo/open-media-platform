//! omp-decklink: Blackmagic-DeckLink-SDI/IP-Capture-Karte → MXL
//! (`UMSETZUNG.md` D10, Teil 1: Ingest — Ausgabe-Richtung/"senden" ist
//! Teil 2, noch nicht begonnen, s. `docs/decisions.md`). Reine Live-
//! Quelle wie `omp-source` (`nodes/omp-source/src/main.rs`, hier als
//! Vorlage übernommen), aber echte Hardware-Erfassung statt
//! `videotestsrc`/`audiotestsrc`. Mehrfach instanziierbar
//! (`OMP_LABEL`/`OMP_PORT`), je eine Instanz pro physischem
//! DeckLink-Gerät (`OMP_DECKLINK_DEVICE_NUMBER`).

mod pipeline;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use omp_node_sdk::is04::TRANSPORT_MXL;
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, LatencyInfo, LatencyRange, NodeConfig, ParamSpec, ParamStore,
    ParamType, Range, SenderSpec, SetError,
};
use pipeline::SAMPLE_RATE;
use serde_json::Value;

struct DecklinkStore {
    flow_id: String,
    audio_flow_id: String,
    device_number: i32,
    mode: String,
    audio_channels: u32,
    signal: Arc<std::sync::atomic::AtomicBool>,
}

impl ParamStore for DecklinkStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            // Eine Hardware-Erfassung setzt selbst den Ursprung, wie
            // omp-source (dortige Begründung 1:1 übernommen) — keine
            // zusätzliche Latenz messbar, da es keinen MXL-Eingang gibt.
            latency: Some(LatencyInfo {
                video: Some(LatencyRange { min_latency_frames: 0, max_latency_frames: 0 }),
                audio: None,
                data: None,
                supports_delay_compensation: false,
            }),
            parameters: vec![
                ParamSpec {
                    name: "signal".to_string(),
                    kind: ParamType::Boolean,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "deviceNumber".to_string(),
                    kind: ParamType::Number,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "mode".to_string(),
                    kind: ParamType::Enum,
                    unit: None,
                    range: Some(Range::Enum {
                        values: pipeline::SUPPORTED_MODES.iter().map(|m| m.to_string()).collect(),
                    }),
                    readonly: true,
                },
                ParamSpec {
                    name: "audioChannels".to_string(),
                    kind: ParamType::Number,
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
                    name: "audioFlowId".to_string(),
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
            "signal" => Some(serde_json::json!(self.signal.load(Ordering::Relaxed))),
            "deviceNumber" => Some(serde_json::json!(self.device_number)),
            "mode" => Some(serde_json::json!(self.mode)),
            "audioChannels" => Some(serde_json::json!(self.audio_channels)),
            "flowId" => Some(serde_json::json!(self.flow_id)),
            "audioFlowId" => Some(serde_json::json!(self.audio_flow_id)),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::Unknown)
    }

    fn invoke(
        &self,
        _name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "DeckLink");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9330").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let device_number: i32 = env_or("OMP_DECKLINK_DEVICE_NUMBER", "0").parse()?;
    let mode = env_or("OMP_DECKLINK_MODE", "1080p25");
    let audio_channels: u32 = env_or("OMP_DECKLINK_AUDIO_CHANNELS", "2").parse()?;
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let Some(mode_info) = pipeline::mode_info(&mode) else {
        return Err(format!(
            "OMP_DECKLINK_MODE={mode:?} nicht unterstützt (unterstützt: {:?})",
            pipeline::SUPPORTED_MODES
        )
        .into());
    };

    // Flow-UUID == MXL-flow-id-Konvention (`UMSETZUNG.md` C4).
    let flow_id = omp_node_sdk::idgen::new_v4();
    let audio_flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        flow_id: flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        label: label.clone(),
        device_number,
        mode: mode.clone(),
        audio_channels,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx, pipeline_heartbeat_thread)
    });

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!(
                "omp-decklink: pipeline build failed (device-number={device_number}, mode={mode}): {e}"
            );
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-decklink: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let media_ready_pipeline = pipeline_handle.clone();
    let signal = Arc::new(AtomicBool::new(pipeline_handle.signal()));

    let store: Arc<dyn ParamStore> = Arc::new(DecklinkStore {
        flow_id: flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        device_number,
        mode: mode.clone(),
        audio_channels,
        signal: signal.clone(),
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
                        frame_width: mode_info.width,
                        frame_height: mode_info.height,
                        grain_rate_numerator: mode_info.fps_numerator,
                        grain_rate_denominator: mode_info.fps_denominator,
                    }),
                    tags: HashMap::new(),
                    ..Default::default()
                },
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Audio {
                        id: Some(audio_flow_id),
                        sample_rate_numerator: SAMPLE_RATE,
                        channel_count: audio_channels,
                        media_type: "audio/float32".to_string(),
                        bit_depth: 32,
                    }),
                    ..Default::default()
                },
            ],
            receivers: vec![],
            instance_id,
            // Wie omp-source: echter Nachweis geflossener Video-Buffer,
            // kein hartkodiertes `true` (ARCHITECTURE.md §5 Punkt 6).
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready_pipeline.media_ready()
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
                    eprintln!("omp-decklink: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
                pipeline::Event::SignalChanged(ok) => {
                    signal.store(ok, Ordering::Relaxed);
                    eprintln!(
                        "omp-decklink: signal [{}]: {}",
                        device_number,
                        if ok { "OK" } else { "KEIN SIGNAL" }
                    );
                    if !ok {
                        handle
                            .publish_alert(format!(
                                "DeckLink device-number={device_number}: kein Eingangssignal"
                            ))
                            .await;
                    }
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-decklink: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-decklink: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}
