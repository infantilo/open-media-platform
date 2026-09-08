//! omp-channel-player (Kapitel 6 Teil 6, `docs/decisions.md` neuer
//! Nachtrag): einzweigiger, Isel-freier "Kanal"-Player — gedacht als EINE
//! von zwei physischen Quellen am Video-Mixer-Crosspoint für echten
//! Crossfade (`docs/END-GOAL-FEATURES.md:1203-1211`). Genau EIN
//! Video-Sender + EIN Audio-Sender (gleicher Kontrakt wie jeder andere
//! Player-Node), `load()` ersetzt den aktuellen Inhalt sofort — kein
//! Cue/Take, keine A/B-Slots, s. `pipeline.rs`-Moduldoku für die
//! ausführliche Begründung und die Live-Diagnose, die zu diesem Node
//! führte (`omp-player`s Active-Pad-Freeze).
//!
//! **Noch NICHT in `omp-playout-automation` verdrahtet** — dieser Schritt
//! baut/verifiziert nur den Node selbst (Teil 6). Automation-Retargeting
//! auf zwei physische Kanäle ist Teil 7 (s. `docs/END-GOAL-FEATURES.md`
//! §6.5).
mod discovery;
mod pipeline;
mod presets;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use omp_node_sdk::is04::RegistryClient;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, SenderSpec, SetError,
};
use pipeline::PipelineHandle;
use serde_json::Value;
use std::sync::Mutex;

/// S. `omp-mxf-player-direct::probe_duration_ms` — wortgleich übernommen
/// (eigener Thread + `gst_pbutils::Discoverer`, damit ein `gst::init()`
/// hier keine Kollision mit dem bereits laufenden Pipeline-Thread
/// riskiert).
fn probe_duration_ms(path: &Path) -> Option<u64> {
    let path = path.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = gstreamer::init();
        let result = (|| -> Option<u64> {
            let uri = gstreamer::glib::filename_to_uri(&path, None).ok()?;
            let discoverer = gstreamer_pbutils::Discoverer::new(gstreamer::ClockTime::from_seconds(5)).ok()?;
            let info = discoverer.discover_uri(uri.as_str()).ok()?;
            info.duration().map(|d| d.mseconds())
        })();
        let _ = tx.send(result);
    });
    rx.recv_timeout(std::time::Duration::from_secs(8)).ok().flatten()
}

/// S. `omp-mxf-player-direct::resolve_media_path` — identische
/// Traversal-Absicherung.
fn resolve_media_path(media_dir: &Path, rel_or_abs: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(rel_or_abs);
    if candidate.is_absolute() {
        return candidate.canonicalize().map_err(|e| format!("Datei {rel_or_abs:?} nicht lesbar: {e}"));
    }
    let joined = media_dir.join(rel_or_abs);
    let canonical = joined.canonicalize().map_err(|e| format!("Datei {rel_or_abs:?} (unter {media_dir:?}) nicht lesbar: {e}"))?;
    let canonical_dir = media_dir.canonicalize().map_err(|e| format!("OMP_MEDIA_DIR {media_dir:?} nicht lesbar: {e}"))?;
    if !canonical.starts_with(&canonical_dir) {
        return Err(format!("Datei {rel_or_abs:?} liegt außerhalb von OMP_MEDIA_DIR"));
    }
    Ok(canonical)
}

struct PlayerStore {
    pipeline: PipelineHandle,
    media_dir: PathBuf,
    registry: RegistryClient,
    // `discovery::discover` ist blockierend (eigener Registry-Roundtrip)
    // — im periodischen Poll-Loop statt bei jedem `GET availableSources`
    // ausgeführt, gleiches Muster wie `omp-player`.
    available_sources: Arc<Mutex<Vec<discovery::DiscoveredSource>>>,
}

impl ParamStore for PlayerStore {
    fn descriptor(&self) -> Descriptor {
        let parameters = vec![
            ParamSpec { name: "currentLabel".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "mediaType".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec {
                name: "positionMs".to_string(),
                kind: ParamType::Number,
                unit: Some("ms".to_string()),
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "durationMs".to_string(),
                kind: ParamType::Number,
                unit: Some("ms".to_string()),
                range: None,
                readonly: true,
            },
            // JSON-Array [string] — Dateinamen direkt unter OMP_MEDIA_DIR.
            ParamSpec { name: "mediaLibrary".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            // JSON-Array [{senderId,label}] — Live-Kandidaten, s.
            // `discovery::discover`.
            ParamSpec { name: "availableSources".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
        ];

        let methods = vec![
            MethodSpec {
                name: "load".to_string(),
                args: vec![
                    MethodArg { name: "label".to_string(), kind: ParamType::String },
                    MethodArg { name: "pattern".to_string(), kind: ParamType::String },
                    MethodArg { name: "file".to_string(), kind: ParamType::String },
                    MethodArg { name: "senderId".to_string(), kind: ParamType::String },
                    MethodArg { name: "toneFrequency".to_string(), kind: ParamType::Number },
                    MethodArg { name: "durationMs".to_string(), kind: ParamType::Number },
                ],
            },
            MethodSpec { name: "stop".to_string(), args: vec![] },
        ];

        Descriptor { parameters, methods, latency: None }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "currentLabel" => Some(serde_json::json!(self.pipeline.current_label())),
            "mediaType" => Some(serde_json::json!(self.pipeline.media_type())),
            "positionMs" => Some(serde_json::json!(self.pipeline.position_ms() as f64)),
            "durationMs" => Some(serde_json::json!(self.pipeline.duration_ms() as f64)),
            "mediaLibrary" => {
                let mut files: Vec<String> = std::fs::read_dir(&self.media_dir)
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| entry.ok())
                    .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .collect();
                files.sort();
                Some(serde_json::json!(files))
            }
            "availableSources" => {
                let sources = self.available_sources.lock().expect("lock poisoned");
                Some(serde_json::json!(
                    sources.iter().map(|s| serde_json::json!({"senderId": s.sender_id, "label": s.label})).collect::<Vec<_>>()
                ))
            }
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "load" => {
                let label = args.get("label").and_then(Value::as_str).unwrap_or("Item").to_string();
                let duration_ms_arg = args.get("durationMs").and_then(Value::as_f64).map(|v| v as i64);

                // Precedence senderId > file > pattern — deckungsgleich mit
                // `omp-player::invoke("append")`.
                if let Some(sender_id) = args.get("senderId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    let (video_flow_id, audio_flow_id) = discovery::resolve(&self.registry, sender_id, true).ok_or(InvokeError::Unknown)?;
                    self.pipeline.load(pipeline::Item {
                        label,
                        source: pipeline::ItemSource::Live { video_flow_id, audio_flow_id },
                        duration_hint_ms: None,
                    });
                    return Ok(());
                }
                if let Some(file) = args.get("file").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    let abs = resolve_media_path(&self.media_dir, file).map_err(|_| InvokeError::Unknown)?;
                    let duration_hint_ms = duration_ms_arg.or_else(|| probe_duration_ms(&abs).map(|ms| ms as i64));
                    self.pipeline.load(pipeline::Item {
                        label,
                        source: pipeline::ItemSource::File { path: abs.to_string_lossy().to_string() },
                        duration_hint_ms,
                    });
                    return Ok(());
                }
                let pattern = args.get("pattern").and_then(Value::as_str).unwrap_or(pipeline::EMPTY_PATTERN).to_string();
                let tone_freq = args.get("toneFrequency").and_then(Value::as_f64).unwrap_or(0.0);
                self.pipeline.load(pipeline::Item {
                    label,
                    source: pipeline::ItemSource::TestPattern { pattern, tone_freq },
                    duration_hint_ms: duration_ms_arg,
                });
                Ok(())
            }
            "stop" => {
                self.pipeline.load(pipeline::Item {
                    label: String::new(),
                    source: pipeline::ItemSource::TestPattern { pattern: pipeline::EMPTY_PATTERN.to_string(), tone_freq: 0.0 },
                    duration_hint_ms: None,
                });
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Kanal-Player");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "0").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let width: u32 = env_or("OMP_WIDTH", "").parse().unwrap_or(pipeline::DEFAULT_WIDTH);
    let height: u32 = env_or("OMP_HEIGHT", "").parse().unwrap_or(pipeline::DEFAULT_HEIGHT);
    let media_dir = PathBuf::from(env_or("OMP_MEDIA_DIR", "data/media"));

    let video_flow_id = omp_node_sdk::idgen::new_v4();
    let audio_flow_id = omp_node_sdk::idgen::new_v4();
    let own_video_sender_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        video_flow_id: video_flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        label: label.clone(),
        width,
        height,
    };
    let pipeline_thread = std::thread::spawn(move || pipeline::run(pipeline_config, tx, ready_tx));

    let pipeline_handle: PipelineHandle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-channel-player: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-channel-player: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let senders = vec![
        SenderSpec {
            id: Some(own_video_sender_id.clone()),
            transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
            flow: Some(omp_node_sdk::node::FlowSpec::Video {
                id: Some(video_flow_id),
                frame_width: width,
                frame_height: height,
                grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
                grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
            }),
            label: Some(format!("{label} Sender")),
            ..Default::default()
        },
        SenderSpec {
            transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
            flow: Some(omp_node_sdk::node::FlowSpec::Audio {
                id: Some(audio_flow_id),
                sample_rate_numerator: pipeline::SAMPLE_RATE,
                channel_count: pipeline::CHANNELS,
                media_type: "audio/float32".to_string(),
                bit_depth: 32,
            }),
            label: Some(format!("{label} Audio")),
            ..Default::default()
        },
    ];

    let available_sources = Arc::new(Mutex::new(Vec::new()));
    let store: Arc<dyn ParamStore> = Arc::new(PlayerStore {
        pipeline: pipeline_handle.clone(),
        media_dir,
        registry: RegistryClient::new(registry_url.clone()),
        available_sources: available_sources.clone(),
    });

    let media_ready_pipeline = pipeline_handle.clone();
    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url: registry_url.clone(),
            nats_url,
            senders,
            receivers: vec![],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_ready_pipeline.media_ready())),
        },
        store,
    )
    .await?;

    let discovery = discovery::discovery_loop(registry_url, own_video_sender_id, omp_node_sdk::is04::FORMAT_VIDEO, available_sources);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-channel-player: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-channel-player: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-channel-player: pipeline thread ended");
        }
        _ = discovery => {
            eprintln!("omp-channel-player: discovery loop ended");
        }
    }

    drop(pipeline_thread);
    Ok(())
}
