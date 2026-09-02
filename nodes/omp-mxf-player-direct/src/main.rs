//! omp-mxf-player-direct: minimale, playlist-lose MXF-Wiedergabe (kein
//! `append`/`load`/`cue`/`take`, keine A/B-Slots) — spielt GENAU eine,
//! über `OMP_MXF_FILE` vorgegebene Datei automatisch beim Prozessstart,
//! Video UND Audio (alle Programmgruppen, Default-Preset "stereo").
//! Diagnose-/Direkt-Geschwister von `omp-mxf-player`, s. `pipeline.rs`-
//! Moduldoku für den Anlass (Nutzerauftrag 2026-09-02) und die genaue
//! Abweichung vom dortigen `input-selector`/Cue-Take-Aufbau.
mod pipeline;
mod presets;

use std::path::PathBuf;
use std::sync::Mutex;

use omp_node_sdk::{Descriptor, InvokeError, NodeConfig, ParamStore, ParamType, RawResponse, SenderSpec, SetError};
use pipeline::PipelineHandle;
use serde_json::Value;

struct PlayerStore {
    file: String,
    status: Mutex<String>,
}

impl ParamStore for PlayerStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                omp_node_sdk::ParamSpec { name: "file".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
                omp_node_sdk::ParamSpec { name: "status".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ],
            methods: vec![],
            latency: None,
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "file" => Some(serde_json::json!(self.file)),
            "status" => Some(serde_json::json!(self.status.lock().expect("lock poisoned").clone())),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, _name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }

    fn extra_route(&self, _method: &str, _path: &str, _body: &[u8]) -> Option<RawResponse> {
        None
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

/// S. `omp-mxf-player::resolve_media_path` — identische Traversal-
/// Absicherung, hier einmalig beim Start statt pro API-Aufruf (kein
/// `append`, also kein wiederholter Bedarf).
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
        file: file_path_str,
        status: Mutex::new("playing".to_string()),
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

    // Kein eigener Teardown-Code (s. pipeline.rs-Moduldoku): der Prozess
    // endet hier, das OS räumt die GStreamer-Pipeline mit ihm auf — kein
    // zweiter Zweig, kein Wiederverwenden, kein kontrollierter Drain
    // nötig wie bei omp-mxf-player.
    drop(pipeline_thread);
    Ok(())
}
