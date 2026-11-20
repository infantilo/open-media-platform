//! Node-Rahmen der Rückleitung (UMSETZUNG 106.11): IS-05-Empfänger für Ton und Bild, Parameter `contrib.*`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource, bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, ReceiverSpec, SetError};
use serde_json::Value;

use crate::config::{SrtMode, parse_pids, redact, validate_line_uri};
use crate::out::{OutConfig, OutSettings, OutShared, run};

#[derive(Clone, Copy)]
enum Kind {
    Video,
    Audio,
}

struct OutControl {
    registry: RegistryClient,
    shared: OutShared,
    kind: Kind,
}

impl OutControl {
    fn slot(&self) -> &Arc<Mutex<String>> {
        match self.kind {
            Kind::Video => &self.shared.video_flow,
            Kind::Audio => &self.shared.audio_flow,
        }
    }
}

impl ReceiverControl for OutControl {
    fn apply(&self, resource: &ReceiverResource) {
        let new = match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => sender.flow_id.unwrap_or_default(),
                Err(e) => {
                    eprintln!("omp-contribution(out): Sender {sender_id} nicht auflösbar: {e}");
                    return;
                }
            },
            _ => String::new(),
        };
        *self.slot().lock().expect("lock poisoned") = new;
        self.shared.reconfigure.store(true, Ordering::Relaxed);
    }
}

struct OutStore {
    shared: OutShared,
    video_conn: Arc<ReceiverConnection<OutControl>>,
    audio_conn: Arc<ReceiverConnection<OutControl>>,
}

fn spec(name: &str, kind: ParamType, readonly: bool) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly }
}

impl ParamStore for OutStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                spec("contrib.uri", ParamType::String, false),
                spec("contrib.mode", ParamType::String, false),
                spec("contrib.latencyMs", ParamType::Number, false),
                spec("contrib.streamId", ParamType::String, false),
                spec("contrib.audioBitrateKbps", ParamType::Number, false),
                spec("contrib.videoEnabled", ParamType::Boolean, false),
                spec("contrib.videoBitrateKbps", ParamType::Number, false),
                spec("contrib.direction", ParamType::String, true),
                spec("contrib.transport", ParamType::String, true),
                spec("contrib.state", ParamType::String, true),
                spec("contrib.lastError", ParamType::String, true),
                spec("contrib.reconnects", ParamType::Number, true),
                spec("contrib.bitrateKbps", ParamType::Number, true),
                spec("contrib.rttMs", ParamType::Number, true),
                spec("contrib.lossPermille", ParamType::Number, true),
                spec("contrib.retransmits", ParamType::Number, true),
                spec("contrib.hasVideo", ParamType::Boolean, true),
                spec("connectedAudioFlowId", ParamType::String, true),
                spec("connectedVideoFlowId", ParamType::String, true),
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
            "contrib.audioBitrateKbps" => Some(serde_json::json!(st.audio_kbps)),
            "contrib.videoEnabled" => Some(serde_json::json!(st.video_enabled)),
            "contrib.videoBitrateKbps" => Some(serde_json::json!(st.video_kbps)),
            "contrib.direction" => Some(serde_json::json!("out")),
            "contrib.transport" => Some(serde_json::json!(validate_line_uri(&st.uri).map(|(t, _)| t.as_str()).unwrap_or("srt"))),
            "contrib.state" => Some(serde_json::json!(*s.state.lock().expect("lock poisoned"))),
            "contrib.lastError" => Some(serde_json::json!(*s.last_error.lock().expect("lock poisoned"))),
            "contrib.reconnects" => Some(serde_json::json!(s.reconnects.load(Ordering::Relaxed))),
            "contrib.bitrateKbps" => Some(serde_json::json!(stats.bitrate_kbps)),
            "contrib.rttMs" => Some(serde_json::json!(stats.rtt_ms)),
            "contrib.lossPermille" => Some(serde_json::json!(stats.loss_permille)),
            "contrib.retransmits" => Some(serde_json::json!(stats.retransmits)),
            "contrib.hasVideo" => Some(serde_json::json!(s.has_video.load(Ordering::Relaxed))),
            "connectedAudioFlowId" => Some(serde_json::json!(*s.audio_flow.lock().expect("lock poisoned"))),
            "connectedVideoFlowId" => Some(serde_json::json!(*s.video_flow.lock().expect("lock poisoned"))),
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let s = &self.shared;
        let bad = |e: String| {
            eprintln!("omp-contribution(out): {e}");
            SetError::Unknown
        };
        {
            let mut st = s.settings.lock().expect("lock poisoned");
            let num = |v: &Value, lo: f64, hi: f64| v.as_f64().filter(|x| (lo..=hi).contains(x)).ok_or(SetError::Unknown);
            match name {
                "contrib.uri" => st.uri = validate_line_uri(value.as_str().ok_or(SetError::Unknown)?).map_err(bad)?.1,
                "contrib.mode" => st.mode = SrtMode::parse(value.as_str().ok_or(SetError::Unknown)?).map_err(bad)?,
                "contrib.latencyMs" => st.latency_ms = num(&value, 0.0, 30000.0)? as u32,
                "contrib.streamId" => st.stream_id = value.as_str().ok_or(SetError::Unknown)?.to_string(),
                "contrib.audioBitrateKbps" => st.audio_kbps = num(&value, 16.0, 640.0)? as u32,
                "contrib.videoBitrateKbps" => st.video_kbps = num(&value, 100.0, 50000.0)? as u32,
                "contrib.videoEnabled" => st.video_enabled = value.as_bool().ok_or(SetError::Unknown)?,
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

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
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

fn env_num<T: std::str::FromStr>(key: &str, fallback: T) -> T {
    env_or(key, "").trim().parse().unwrap_or(fallback)
}

/// Startet den Node in der Richtung `out`.
pub async fn run_node() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Rückleitung");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9397").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let _ = parse_pids; // gleiche Konfigurationsmodule wie der Eingang
    let uri = validate_line_uri(&env_or("OMP_CONTRIB_URI", "srt://127.0.0.1:9000"))?.1;
    let settings = OutSettings {
        uri,
        mode: SrtMode::parse(&env_or("OMP_CONTRIB_MODE", "caller"))?,
        latency_ms: env_num("OMP_CONTRIB_LATENCY_MS", 200u32),
        stream_id: env_or("OMP_CONTRIB_STREAMID", ""),
        audio_kbps: env_num("OMP_CONTRIB_AUDIO_BITRATE_KBPS", 128u32),
        video_enabled: env_or("OMP_CONTRIB_VIDEO_ENABLED", "0") == "1",
        video_kbps: env_num("OMP_CONTRIB_VIDEO_BITRATE_KBPS", 2000u32),
    };
    let passphrase_file = std::env::var("OMP_CONTRIB_PASSPHRASE_FILE").ok().filter(|p| !p.is_empty());
    let shared = OutShared::new(settings);
    // Direkte Bindung an Flows (Test/Alleinbetrieb ohne NMOS-Verbindung); im Betrieb verbindet IS-05.
    if let Ok(f) = std::env::var("OMP_CONTRIB_AUDIO_FLOW_ID") {
        *shared.audio_flow.lock().expect("lock poisoned") = f;
    }
    if let Ok(f) = std::env::var("OMP_CONTRIB_VIDEO_FLOW_ID") {
        *shared.video_flow.lock().expect("lock poisoned") = f;
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<crate::pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let hb = Arc::new(AtomicU64::new(0));
    let (sd, hb2, sh2) = (shutdown.clone(), hb.clone(), shared.clone());
    let cfg = OutConfig { domain, passphrase_file };
    let th = std::thread::spawn(move || run(cfg, tx, sd, hb2, sh2));

    let video_id = omp_node_sdk::idgen::new_v4();
    let audio_id = omp_node_sdk::idgen::new_v4();
    let make = |id: &str, kind: Kind| {
        Arc::new(ReceiverConnection::new(id.to_string(), OutControl { registry: RegistryClient::new(registry_url.clone()), shared: shared.clone(), kind }))
    };
    let video_conn = make(&video_id, Kind::Video);
    let audio_conn = make(&audio_id, Kind::Audio);
    let store: Arc<dyn ParamStore> = Arc::new(OutStore { shared: shared.clone(), video_conn, audio_conn });
    let playing = shared.state.clone();
    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![],
            receivers: vec![
                ReceiverSpec { id: Some(video_id), transport: Some(TRANSPORT_MXL.to_string()), media_types: Some(vec!["video/v210".to_string()]), ..Default::default() },
                ReceiverSpec { id: Some(audio_id), transport: Some(TRANSPORT_MXL.to_string()), media_types: Some(vec!["audio/float32".to_string()]), ..Default::default() },
            ],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || *playing.lock().expect("lock poisoned") == "playing")),
        },
        store,
    )
    .await?;
    handle.register_worker("pipeline", hb);
    let events = async {
        while let Some(crate::pipeline::Event::Error(m)) = rx.recv().await {
            let m = omp_node_sdk::errcode::tag(&m);
            eprintln!("omp-contribution(out): {m}");
            handle.publish_alert(m).await;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-contribution(out): shutdown requested"),
        _ = events => eprintln!("omp-contribution(out): pipeline thread ended"),
    }
    shutdown.store(true, Ordering::Relaxed);
    let _ = th.join();
    Ok(())
}
