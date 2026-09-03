//! omp-mxf-player-direct: minimale, playlist-lose MXF-Wiedergabe (kein
//! `append`/`cue`/`take`, keine A/B-Slots) — spielt GENAU eine Datei,
//! Video UND Audio (alle Programmgruppen). Diagnose-/Direkt-Geschwister
//! von `omp-mxf-player`, s. `pipeline.rs`-Moduldoku für den Anlass
//! (Nutzerauftrag 2026-09-02) und die genaue Abweichung vom dortigen
//! `input-selector`/Cue-Take-Aufbau.
//!
//! **Steuer-UI** (`uibundle.rs`, Nutzerauftrag 2026-09-03: "mxf player
//! (direkt ohne playliste) braucht noch ein ui zum laden des clips,
//! seeking, play, stop... und audioshuffle selection") — `OMP_MXF_FILE`
//! bleibt der Startwert (Autoplay beim Prozessstart, unverändert), das UI
//! kann die Datei danach live wechseln (`load`), abspielen/anhalten
//! (`play`/`stop`), innerhalb des Clips suchen (`seek`) und das
//! Audio-Shuffle-Preset ändern (`setPreset`) — direkter, vereinfachter
//! Nachbau von `omp-mxf-player/ui/bundle.js` (dieselbe generische
//! Node-Proxy-API `/api/v1/nodes/<id>/methods/<name>`), OHNE dessen
//! Playlist/Cue-Take-Mechanik (dieser Node hat nur EINEN aktiven Clip,
//! kein Vorbereiten eines zweiten während der erste läuft).
mod pipeline;
mod presets;
mod uibundle;

use std::path::PathBuf;

use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, SenderSpec, SetError,
};
use pipeline::PipelineHandle;
use serde_json::Value;

struct PlayerStore {
    pipeline: PipelineHandle,
    media_dir: PathBuf,
    shuffle_presets: Vec<presets::AudioPreset>,
    groups: Vec<presets::ProgramGroup>,
}

impl ParamStore for PlayerStore {
    fn descriptor(&self) -> Descriptor {
        let parameters = vec![
            ParamSpec { name: "file".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "status".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
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
            ParamSpec { name: "audioPreset".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            // JSON-Array [string] — Dateinamen direkt unter OMP_MEDIA_DIR
            // (gleiches flache Muster wie omp-mxf-player::mediaLibrary).
            ParamSpec { name: "mediaLibrary".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            // JSON-Array [{id,label,channels}] — die Programmgruppen.
            ParamSpec { name: "programGroups".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            // JSON-Array [{id,label,routes}] — die Shuffle-Presets.
            ParamSpec { name: "shufflePresets".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
        ];

        let methods = vec![
            MethodSpec { name: "play".to_string(), args: vec![] },
            MethodSpec { name: "stop".to_string(), args: vec![] },
            MethodSpec { name: "load".to_string(), args: vec![MethodArg { name: "file".to_string(), kind: ParamType::String }] },
            MethodSpec {
                name: "seek".to_string(),
                args: vec![MethodArg { name: "positionMs".to_string(), kind: ParamType::Number }],
            },
            MethodSpec {
                name: "setPreset".to_string(),
                args: vec![MethodArg { name: "audioPreset".to_string(), kind: ParamType::String }],
            },
        ];

        Descriptor { parameters, methods, latency: None }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "file" => Some(serde_json::json!(self.pipeline.current_file())),
            "status" => Some(serde_json::json!(if self.pipeline.is_playing() { "playing" } else { "stopped" })),
            "positionMs" => Some(serde_json::json!(self.pipeline.position_ms() as f64)),
            "durationMs" => Some(serde_json::json!(self.pipeline.duration_ms() as f64)),
            "audioPreset" => Some(serde_json::json!(self.pipeline.current_preset_id())),
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
            "programGroups" => Some(serde_json::json!(
                self.groups.iter().map(|g| serde_json::json!({"id": g.id, "label": g.label, "channels": g.channels})).collect::<Vec<_>>()
            )),
            "shufflePresets" => Some(serde_json::json!(
                self.shuffle_presets
                    .iter()
                    .map(|p| serde_json::json!({"id": p.id, "label": p.label, "routes": p.routes}))
                    .collect::<Vec<_>>()
            )),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "play" => {
                self.pipeline.play();
                Ok(())
            }
            "stop" => {
                self.pipeline.stop();
                Ok(())
            }
            "load" => {
                let file = args.get("file").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or(InvokeError::Unknown)?;
                let abs = resolve_media_path(&self.media_dir, file).map_err(|_| InvokeError::Unknown)?;
                self.pipeline.load(abs.to_string_lossy().to_string());
                Ok(())
            }
            "seek" => {
                let position_ms = args.get("positionMs").and_then(Value::as_f64).ok_or(InvokeError::Unknown)?;
                self.pipeline.seek(position_ms as i64);
                Ok(())
            }
            "setPreset" => {
                let preset_id = args.get("audioPreset").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let preset = presets::find_preset(&self.shuffle_presets, preset_id).cloned().ok_or(InvokeError::Unknown)?;
                self.pipeline.set_preset(preset);
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, _body: &[u8]) -> Option<RawResponse> {
        uibundle::route(method, path)
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

/// S. `omp-mxf-player::resolve_media_path` — identische Traversal-
/// Absicherung. Ursprünglich nur beim Start verwendet, jetzt zusätzlich
/// aus `invoke("load", ...)` heraus (Nutzerauftrag 2026-09-03: Datei
/// live wechseln, relativ zu `OMP_MEDIA_DIR` oder absolut).
fn resolve_media_path(media_dir: &std::path::Path, rel_or_abs: &str) -> Result<PathBuf, String> {
    let candidate = std::path::Path::new(rel_or_abs);
    if candidate.is_absolute() {
        return candidate
            .canonicalize()
            .map_err(|e| format!("OMP_MXF_FILE {rel_or_abs:?} nicht lesbar: {e}"));
    }
    let joined = media_dir.join(rel_or_abs);
    let canonical = joined
        .canonicalize()
        .map_err(|e| format!("OMP_MXF_FILE {rel_or_abs:?} (unter {media_dir:?}) nicht lesbar: {e}"))?;
    let canonical_dir = media_dir
        .canonicalize()
        .map_err(|e| format!("OMP_MEDIA_DIR {media_dir:?} nicht lesbar: {e}"))?;
    if !canonical.starts_with(&canonical_dir) {
        return Err(format!("OMP_MXF_FILE {rel_or_abs:?} liegt außerhalb von OMP_MEDIA_DIR"));
    }
    Ok(canonical)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "MXF Player (Direct)");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9396").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let width: u32 = env_or("OMP_WIDTH", "").parse().unwrap_or(pipeline::DEFAULT_WIDTH);
    let height: u32 = env_or("OMP_HEIGHT", "").parse().unwrap_or(pipeline::DEFAULT_HEIGHT);
    let media_dir = PathBuf::from(env_or("OMP_MEDIA_DIR", "data/media"));

    let file_arg = std::env::var("OMP_MXF_FILE")
        .map_err(|_| "OMP_MXF_FILE ist nicht gesetzt — dieser Node braucht genau eine MXF-Datei (absolut oder relativ zu OMP_MEDIA_DIR)")?;
    let file_path = resolve_media_path(&media_dir, &file_arg)?;
    let file_path_str = file_path.to_string_lossy().to_string();

    let settings = presets::default_settings();
    let preset = presets::find_preset(&settings.presets, "stereo")
        .or_else(|| settings.presets.first())
        .cloned()
        .ok_or("keine Audio-Presets in presets::default_settings()")?;

    let video_flow_id = omp_node_sdk::idgen::new_v4();
    let group_flow_ids: Vec<String> = settings.groups.iter().map(|_| omp_node_sdk::idgen::new_v4()).collect();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        video_flow_id: video_flow_id.clone(),
        group_flow_ids: group_flow_ids.clone(),
        groups: settings.groups.clone(),
        preset,
        label: label.clone(),
        width,
        height,
        file_path: file_path_str.clone(),
    };
    let pipeline_thread = std::thread::spawn(move || pipeline::run(pipeline_config, tx, ready_tx));

    let pipeline_handle: PipelineHandle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-mxf-player-direct: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-mxf-player-direct: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let mut senders = Vec::with_capacity(1 + settings.groups.len());
    senders.push(SenderSpec {
        transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
        flow: Some(omp_node_sdk::node::FlowSpec::Video {
            id: Some(video_flow_id),
            frame_width: width,
            frame_height: height,
            grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
            grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
        }),
        label: Some(format!("{label} Programm")),
        ..Default::default()
    });
    for (group, flow_id) in settings.groups.iter().zip(group_flow_ids.into_iter()) {
        senders.push(SenderSpec {
            transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
            flow: Some(omp_node_sdk::node::FlowSpec::Audio {
                id: Some(flow_id),
                sample_rate_numerator: pipeline::SAMPLE_RATE,
                channel_count: group.channels,
                media_type: "audio/float32".to_string(),
                bit_depth: 32,
            }),
            label: Some(format!("{label} {}", group.label)),
            ..Default::default()
        });
    }

    let store: std::sync::Arc<dyn ParamStore> = std::sync::Arc::new(PlayerStore {
        pipeline: pipeline_handle.clone(),
        media_dir,
        shuffle_presets: settings.presets,
        groups: settings.groups,
    });

    let media_ready_pipeline = pipeline_handle.clone();
    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders,
            receivers: vec![],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(std::sync::Arc::new(move || media_ready_pipeline.media_ready())),
        },
        store,
    )
    .await?;

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-mxf-player-direct: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-mxf-player-direct: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-mxf-player-direct: pipeline thread ended");
        }
    }

    // Kein eigener Teardown-Code hier: `pipeline::run()` läuft in einer
    // eigenen Endlosschleife (baut den Zweig bei jedem EOS neu auf, s.
    // dortige Doku zum Nutzerfund 2026-09-02 "Loop statt Stillstand nach
    // dem ersten Dateiende") — der Prozess endet hier, das OS räumt die
    // GStreamer-Pipeline mit ihm ab.
    drop(pipeline_thread);
    Ok(())
}
