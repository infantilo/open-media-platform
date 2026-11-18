//! omp-hls-source: HLS-Eingang → MXL (Video + Audio). Holt einen HTTP-Live-Streaming-Strom (RFC 8216, z. B. ein
//! CDN-Feed oder eine Webquelle) per URL, dekodiert ihn und schreibt ihn als MXL-Flows, so dass er wie jede andere
//! Live-Quelle (`omp-source`, Kamera) in Mischer, Switcher, Viewer und Aufnahme geht. Die Adresse ist
//! Prozess-Konfiguration (`OMP_HLS_URL`, Node-Option); bei Netzfehlern, Stream-Ende oder Stillstand verbindet der
//! Node selbst neu (s. `pipeline.rs`).

mod pipeline;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use omp_mediaio::preview;
use omp_node_sdk::is04::TRANSPORT_MXL;
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, LatencyInfo, LatencyRange, NodeConfig, ParamSpec, ParamStore,
    ParamType, SenderSpec, SetError,
};
use pipeline::{CHANNELS, SAMPLE_RATE, Shared};
use serde_json::Value;

struct HlsStore {
    shared: Shared,
    fps: Arc<Mutex<f64>>,
    flow_id: String,
    audio_flow_id: String,
    /// Adresse ohne Zugangsdaten (Benutzer:Passwort@ und Query werden für die Anzeige entfernt).
    display_uri: String,
    preview_url: String,
}

/// Zeigt die Adresse ohne `user:pass@` und ohne Query/Fragment — Token stehen oft in der Query.
fn redact_uri(uri: &str) -> String {
    let Some(i) = uri.find("://") else {
        return String::new();
    };
    let (scheme, rest) = uri.split_at(i + 3);
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let rest = match rest.find('@') {
        Some(at) if !rest[..at].contains('/') => &rest[at + 1..],
        _ => rest,
    };
    format!("{scheme}{rest}")
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

impl ParamStore for HlsStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            // Wie eine andere Quelle: der erste geschriebene Grain ist der Ursprung (keine zusätzliche Latenz im
            // MXL-Pfad). Die Netzpuffer des Streams (mehrere Sekunden) sind kein Teil des MXL-Pfads.
            latency: Some(LatencyInfo {
                video: Some(LatencyRange {
                    min_latency_frames: 0,
                    max_latency_frames: 0,
                }),
                audio: None,
                data: None,
                supports_delay_compensation: false,
            }),
            parameters: vec![
                ro("url", ParamType::String),
                ro("state", ParamType::String),
                ro("lastError", ParamType::String),
                ro("reconnects", ParamType::Number),
                ro("hasAudio", ParamType::Boolean),
                ro("fps", ParamType::Number),
                ro("flowId", ParamType::String),
                ro("audioFlowId", ParamType::String),
                ro("previewUrl", ParamType::String),
            ],
            methods: vec![],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let s = &self.shared;
        match name {
            "url" => Some(serde_json::json!(self.display_uri)),
            "state" => Some(serde_json::json!(*s.state.lock().expect("lock poisoned"))),
            "lastError" => Some(serde_json::json!(
                *s.last_error.lock().expect("lock poisoned")
            )),
            "reconnects" => Some(serde_json::json!(s.reconnects.load(Ordering::Relaxed))),
            "hasAudio" => Some(serde_json::json!(s.audio_seen.load(Ordering::Relaxed))),
            "fps" => Some(serde_json::json!(*self.fps.lock().expect("lock poisoned"))),
            "flowId" => Some(serde_json::json!(self.flow_id)),
            "audioFlowId" => Some(serde_json::json!(self.audio_flow_id)),
            "previewUrl" => Some(serde_json::json!(self.preview_url)),
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
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn env_num<T: std::str::FromStr>(key: &str, fallback: T) -> T {
    env_or(key, "").trim().parse().unwrap_or(fallback)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "HLS");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9320").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let uri = env_or("OMP_HLS_URL", "").trim().to_string();
    if uri.is_empty() {
        eprintln!(
            "omp-hls-source: OMP_HLS_URL ist nicht gesetzt (Admin → Einstellungen → Node-Optionen)"
        );
        return Err("OMP_HLS_URL fehlt".into());
    }
    // Format: dieselbe Konvention wie omp-source (Workflow-Format setzt OMP_WIDTH/… ; fehlt/ungültig → Standard).
    let width: u32 = env_num("OMP_WIDTH", pipeline::DEFAULT_WIDTH);
    let height: u32 = env_num("OMP_HEIGHT", pipeline::DEFAULT_HEIGHT);
    let framerate_numerator: u32 = env_num("OMP_FRAMERATE_NUM", pipeline::FRAMERATE_NUMERATOR);
    let framerate_denominator: u32 = env_num("OMP_FRAMERATE_DEN", pipeline::FRAMERATE_DENOMINATOR);
    let max_bitrate_kbps: u32 = env_num("OMP_HLS_MAX_BITRATE_KBPS", 0);
    let stall_secs: u64 = env_num("OMP_HLS_STALL_SECONDS", 15);
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let flow_id = omp_node_sdk::idgen::new_v4();
    let audio_flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let preview_port: u16 = env_or("OMP_HLS_PREVIEW_PORT", "0").parse()?;
    let preview_broadcaster = Arc::new(preview::Broadcaster::new());
    let preview_heartbeat = Arc::new(AtomicU64::new(0));
    let actual_preview_port = preview::spawn(
        &format!("0.0.0.0:{preview_port}"),
        preview_broadcaster.clone(),
        preview_heartbeat.clone(),
    )?;
    let preview_url = format!("http://{host}:{actual_preview_port}/preview");

    let shared = Shared::new();
    let pipeline_config = pipeline::Config {
        domain,
        flow_id: flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        label: label.clone(),
        uri: uri.clone(),
        width,
        height,
        framerate_numerator,
        framerate_denominator,
        max_bitrate_kbps,
        stall_secs,
        preview_broadcaster,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let hb = pipeline_heartbeat.clone();
    let shared_thread = shared.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(
            pipeline_config,
            tx,
            pipeline_shutdown,
            ready_tx,
            hb,
            shared_thread,
        )
    });

    match ready_rx.await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            eprintln!(
                "omp-hls-source: pipeline build failed: {}",
                omp_node_sdk::errcode::tag(&e)
            );
            return Err(e.into());
        }
        Err(_) => return Err("pipeline thread ended before reporting readiness".into()),
    }

    let fps = Arc::new(Mutex::new(0.0));
    let store: Arc<dyn ParamStore> = Arc::new(HlsStore {
        shared: shared.clone(),
        fps: fps.clone(),
        flow_id: flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        display_uri: redact_uri(&uri),
        preview_url,
    });

    let group = omp_node_sdk::group::name_or(&flow_id);
    let media_ready_shared = shared.clone();
    let video_counter = shared.video_total.clone();

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
                        grain_rate_numerator: framerate_numerator,
                        grain_rate_denominator: framerate_denominator,
                    }),
                    // `source.live`: eine Playlist wählt die Live-Quelle per Tag (wie bei omp-source).
                    tags: HashMap::from([
                        (
                            "urn:x-nmos:tag:grouphint/v1.0".to_string(),
                            vec![format!("{group}:high")],
                        ),
                        (
                            "urn:x-omp:tags".to_string(),
                            vec!["source.live".to_string()],
                        ),
                    ]),
                    ..Default::default()
                },
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Audio {
                        id: Some(audio_flow_id),
                        sample_rate_numerator: SAMPLE_RATE,
                        channel_count: CHANNELS,
                        media_type: "audio/float32".to_string(),
                        bit_depth: 32,
                        source_id: None,
                    }),
                    tags: HashMap::from([(
                        "urn:x-nmos:tag:grouphint/v1.0".to_string(),
                        vec![format!("{group}:audio")],
                    )]),
                    ..Default::default()
                },
            ],
            receivers: vec![],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready_shared.video_flowed.load(Ordering::Relaxed)
            })),
        },
        store,
    )
    .await?;

    handle.register_worker("pipeline", pipeline_heartbeat);
    handle.register_worker("preview-accept", preview_heartbeat);
    handle.register_rate_kpi("video_fps", video_counter);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Fps(measured) => {
                    *fps.lock().expect("lock poisoned") = measured;
                }
                pipeline::Event::Error(message) => {
                    let message = omp_node_sdk::errcode::tag(&message);
                    eprintln!("omp-hls-source: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-hls-source: shutdown requested"),
        _ = events => eprintln!("omp-hls-source: pipeline thread ended"),
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::redact_uri;

    #[test]
    fn redact_hides_credentials_and_query() {
        assert_eq!(
            redact_uri("https://cdn.example.com/live/a.m3u8"),
            "https://cdn.example.com/live/a.m3u8"
        );
        assert_eq!(
            redact_uri("https://user:pw@cdn.example.com/a.m3u8?token=geheim#x"),
            "https://cdn.example.com/a.m3u8"
        );
        assert_eq!(redact_uri("http://h/a.m3u8?x=a@b"), "http://h/a.m3u8");
        assert_eq!(redact_uri("kein-schema"), "");
    }
}
