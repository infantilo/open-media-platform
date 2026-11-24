//! omp-normalizer (UMSETZUNG Kapitel 106): bringt jede Leitung **nur bei Abweichung** ins Hausformat. Passt das Format,
//! kopiert der Node die Grains bitgleich (kein Skalieren, keine Farbwandlung, kein Re-Encode). Das Hausformat ist zur Laufzeit
//! einstellbar (`normalize.houseFormat`). Details: `pipeline.rs`, Entwurf `ARCHITECTURE.md` §33.

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
    Descriptor, InvokeError, LatencyInfo, LatencyRange, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, ReceiverSpec,
    SenderSpec, SetError,
};
use omp_normalizer::audiomap::AudioMap;
use omp_normalizer::house::HouseFormat;
use serde_json::Value;

#[derive(Clone, Copy)]
enum Kind {
    Video,
    Audio,
    Data,
}

struct NormControl {
    registry: RegistryClient,
    pipeline: pipeline::PipelineHandle,
    kind: Kind,
    connected: Arc<Mutex<String>>,
}

impl ReceiverControl for NormControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected.lock().expect("lock poisoned") = flow_id.clone();
                        match self.kind {
                            Kind::Video => self.pipeline.connect_video(flow_id),
                            Kind::Audio => self.pipeline.connect_audio(flow_id),
                            Kind::Data => self.pipeline.connect_data(flow_id),
                        }
                    }
                    None => eprintln!("omp-normalizer: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-normalizer: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected.lock().expect("lock poisoned") = String::new();
                match self.kind {
                    Kind::Video => self.pipeline.disconnect_video(),
                    Kind::Audio => self.pipeline.disconnect_audio(),
                    Kind::Data => self.pipeline.disconnect_data(),
                }
            }
        }
    }
}

/// Ergebnis der letzten A/V-Messung (106.4). `method`: `none` (nichts gemessen/kein Marker), `marker`.
#[derive(Clone, Default)]
struct AvState {
    running: bool,
    method: &'static str,
    ms: Option<f64>,
    confidence: f64,
    samples: usize,
}

struct NormStore {
    domain: String,
    avsync: Arc<Mutex<AvState>>,
    video_connected: Arc<Mutex<String>>,
    audio_connected: Arc<Mutex<String>>,
    data_connected: Arc<Mutex<String>>,
    data_flow_id: String,
    video_flow_id: String,
    audio_flow_id: String,
    video_conn: Arc<ReceiverConnection<NormControl>>,
    audio_conn: Arc<ReceiverConnection<NormControl>>,
    data_conn: Arc<ReceiverConnection<NormControl>>,
    pipeline: pipeline::PipelineHandle,
}

fn spec(name: &str, kind: ParamType, readonly: bool) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly }
}

/// Gesamtzustand: der „schlechteste“ der beiden Zweige (error > blocked > convert > copy > waiting).
fn overall(a: &str, b: &str) -> &'static str {
    let rank = |s: &str| match s {
        "error" => 4,
        "blocked" => 3,
        "convert" => 2,
        "copy" => 1,
        _ => 0,
    };
    let pick = if rank(a) >= rank(b) { a } else { b };
    match pick {
        "error" => "error",
        "blocked" => "blocked",
        "convert" => "convert",
        "copy" => "copy",
        _ => "waiting",
    }
}

impl ParamStore for NormStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            // Kopie: 0 Bilder; Wandlung: ein Bild durch die Ausgangskette (Bereich deckt beides ab).
            latency: Some(LatencyInfo {
                video: Some(LatencyRange { min_latency_frames: 0, max_latency_frames: 1 }),
                audio: None,
                data: None,
                supports_delay_compensation: false,
            }),
            parameters: vec![
                spec("normalize.mode", ParamType::String, false),
                spec("normalize.houseFormat", ParamType::String, false),
                spec("normalize.audioMap", ParamType::String, false),
                spec("normalize.transferPolicy", ParamType::String, false),
                spec("normalize.mapBackend", ParamType::String, false),
                spec("normalize.state", ParamType::String, true),
                spec("normalize.videoState", ParamType::String, true),
                spec("normalize.audioState", ParamType::String, true),
                spec("normalize.inputFormat", ParamType::String, true),
                spec("normalize.deviations", ParamType::String, true),
                spec("normalize.stages", ParamType::String, true),
                spec("normalize.warnings", ParamType::String, true),
                spec("normalize.formatChanges", ParamType::Number, true),
                spec("normalize.lastError", ParamType::String, true),
                spec("avsync.mode", ParamType::String, false),
                spec("avsync.manualMs", ParamType::Number, false),
                spec("avsync.heldMs", ParamType::Number, false),
                spec("avsync.freeze", ParamType::Boolean, false),
                spec("avsync.maxSlewPermille", ParamType::Number, false),
                spec("avsync.deadbandMs", ParamType::Number, false),
                spec("avsync.appliedMs", ParamType::Number, true),
                spec("avsync.videoDelayFrames", ParamType::Number, true),
                spec("avsync.audioDelaySamples", ParamType::Number, true),
                spec("avsync.audioDelayCurrentSamples", ParamType::Number, true),
                spec("avsync.measuredMs", ParamType::Number, true),
                spec("avsync.confidence", ParamType::Number, true),
                spec("avsync.method", ParamType::String, true),
                spec("avsync.samples", ParamType::Number, true),
                spec("avsync.running", ParamType::String, true),
                spec("connectedVideoFlowId", ParamType::String, true),
                spec("connectedAudioFlowId", ParamType::String, true),
                spec("connectedDataFlowId", ParamType::String, true),
                spec("targetDataFlowId", ParamType::String, true),
                spec("normalize.dataState", ParamType::String, true),
                spec("normalize.dataFlowing", ParamType::Boolean, true),
                spec("targetVideoFlowId", ParamType::String, true),
                spec("targetAudioFlowId", ParamType::String, true),
            ],
            methods: vec![
                MethodSpec { name: "avsync.measure".to_string(), args: vec![MethodArg { name: "seconds".to_string(), kind: ParamType::Number }] },
                MethodSpec { name: "avsync.apply".to_string(), args: vec![] },
                MethodSpec { name: "avsync.reset".to_string(), args: vec![] },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let sh = &self.pipeline.shared;
        let v = sh.video.lock().expect("lock poisoned").clone();
        let a = sh.audio.lock().expect("lock poisoned").clone();
        match name {
            "normalize.mode" => Some(serde_json::json!(sh.mode.lock().expect("lock poisoned").as_str())),
            "normalize.houseFormat" => {
                Some(serde_json::json!(serde_json::to_string(&*sh.house.lock().expect("lock poisoned")).unwrap_or_default()))
            }
            "normalize.audioMap" => Some(serde_json::json!(serde_json::to_string(&*sh.audio_map.lock().expect("lock poisoned")).unwrap_or_default())),
            "normalize.transferPolicy" => Some(serde_json::json!(match *sh.transfer_policy.lock().expect("lock poisoned") {
                None => "house",
                Some(omp_normalizer::house::TransferPolicy::Warn) => "warn",
                Some(omp_normalizer::house::TransferPolicy::Block) => "block",
                Some(omp_normalizer::house::TransferPolicy::Map) => "map",
            })),
            "normalize.mapBackend" => Some(serde_json::json!(sh.map_backend.lock().expect("lock poisoned").clone())),
            "avsync.mode" => Some(serde_json::json!(sh.avsync.lock().expect("lock poisoned").mode.as_str())),
            "avsync.manualMs" => Some(serde_json::json!(sh.avsync.lock().expect("lock poisoned").manual_ms)),
            "avsync.heldMs" => Some(sh.avsync.lock().expect("lock poisoned").held_ms.map_or(Value::Null, |v| serde_json::json!(v))),
            "avsync.freeze" => Some(serde_json::json!(sh.avsync.lock().expect("lock poisoned").freeze)),
            "avsync.maxSlewPermille" => Some(serde_json::json!(sh.avsync.lock().expect("lock poisoned").max_slew_permille)),
            "avsync.deadbandMs" => Some(serde_json::json!(sh.avsync.lock().expect("lock poisoned").deadband_ms)),
            "avsync.appliedMs" => Some(serde_json::json!(sh.applied.lock().expect("lock poisoned").map_or(0.0, |a| a.offset_ms))),
            "avsync.videoDelayFrames" => Some(serde_json::json!(sh.delay.video_frames())),
            "avsync.audioDelaySamples" => Some(serde_json::json!(sh.delay.audio_target_samples())),
            "avsync.audioDelayCurrentSamples" => Some(serde_json::json!(sh.delay.audio_current_samples())),
            "avsync.measuredMs" => Some(self.avsync.lock().expect("lock poisoned").ms.map_or(Value::Null, |v| serde_json::json!(v))),
            "avsync.confidence" => Some(serde_json::json!(self.avsync.lock().expect("lock poisoned").confidence)),
            "avsync.method" => Some(serde_json::json!(self.avsync.lock().expect("lock poisoned").method)),
            "avsync.samples" => Some(serde_json::json!(self.avsync.lock().expect("lock poisoned").samples)),
            "avsync.running" => Some(serde_json::json!(if self.avsync.lock().expect("lock poisoned").running { "running" } else { "idle" })),
            "normalize.state" => Some(serde_json::json!(overall(v.state, a.state))),
            "normalize.videoState" => Some(serde_json::json!(v.state)),
            "normalize.audioState" => Some(serde_json::json!(a.state)),
            "normalize.inputFormat" => Some(serde_json::json!(serde_json::json!({"video": v.input, "audio": a.input}).to_string())),
            "normalize.deviations" => Some(serde_json::json!(serde_json::json!({"video": v.deviations, "audio": a.deviations}).to_string())),
            "normalize.stages" => Some(serde_json::json!(serde_json::json!({"video": v.stages, "audio": a.stages}).to_string())),
            "normalize.warnings" => Some(serde_json::json!(serde_json::json!({"video": v.warnings, "audio": a.warnings}).to_string())),
            "normalize.formatChanges" => Some(serde_json::json!(sh.format_changes.load(Ordering::Relaxed))),
            "normalize.lastError" => Some(serde_json::json!(sh.last_error.lock().expect("lock poisoned").clone())),
            "connectedVideoFlowId" => Some(serde_json::json!(self.video_connected.lock().expect("lock poisoned").clone())),
            "connectedAudioFlowId" => Some(serde_json::json!(self.audio_connected.lock().expect("lock poisoned").clone())),
            "connectedDataFlowId" => Some(serde_json::json!(self.data_connected.lock().expect("lock poisoned").clone())),
            "targetDataFlowId" => Some(serde_json::json!(self.data_flow_id)),
            "normalize.dataState" => Some(serde_json::json!(self.pipeline.shared.data_mode.lock().expect("lock poisoned").clone())),
            "normalize.dataFlowing" => Some(serde_json::json!(self.pipeline.shared.data_fresh())),
            "targetVideoFlowId" => Some(serde_json::json!(self.video_flow_id)),
            "targetAudioFlowId" => Some(serde_json::json!(self.audio_flow_id)),
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let sh = &self.pipeline.shared;
        match name {
            "normalize.mode" => {
                let m = value.as_str().and_then(pipeline::Mode::parse).ok_or_else(|| {
                    eprintln!("omp-normalizer: normalize.mode muss auto oder copyOnly sein");
                    SetError::Unknown
                })?;
                *sh.mode.lock().expect("lock poisoned") = m;
                self.pipeline.reconfigure();
                Ok(())
            }
            "normalize.houseFormat" => {
                let text = match &value {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                let h = HouseFormat::from_json(&text).map_err(|e| {
                    eprintln!("omp-normalizer: {e}");
                    SetError::Unknown
                })?;
                *sh.house.lock().expect("lock poisoned") = h;
                self.pipeline.reconfigure();
                Ok(())
            }
            "normalize.audioMap" => {
                let text = match &value {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                let map = AudioMap::from_json(&text).map_err(|e| {
                    eprintln!("omp-normalizer: {e}");
                    SetError::Unknown
                })?;
                *sh.audio_map.lock().expect("lock poisoned") = map;
                self.pipeline.reconfigure();
                Ok(())
            }
            "avsync.mode" | "avsync.manualMs" | "avsync.heldMs" | "avsync.freeze" | "avsync.maxSlewPermille" | "avsync.deadbandMs" => {
                let before = sh.avsync.lock().expect("lock poisoned").clone();
                {
                    let mut a = sh.avsync.lock().expect("lock poisoned");
                    match name {
                        "avsync.mode" => {
                            let m = value.as_str().and_then(|v| omp_normalizer::offset::AvsyncMode::parse(v).ok()).ok_or(SetError::Unknown)?;
                            if let Err(e) = m.check_supported() {
                                eprintln!("omp-normalizer: {e}");
                                return Err(SetError::Unknown);
                            }
                            a.mode = m;
                        }
                        "avsync.manualMs" => a.manual_ms = value.as_f64().ok_or(SetError::Unknown)?,
                        "avsync.heldMs" => a.held_ms = if value.is_null() { None } else { Some(value.as_f64().ok_or(SetError::Unknown)?) },
                        "avsync.freeze" => a.freeze = value.as_bool().ok_or(SetError::Unknown)?,
                        "avsync.maxSlewPermille" => a.max_slew_permille = value.as_f64().filter(|v| *v > 0.0).ok_or(SetError::Unknown)?,
                        _ => a.deadband_ms = value.as_f64().filter(|v| *v >= 0.0).ok_or(SetError::Unknown)?,
                    }
                }
                if let Err(e) = sh.recompute_avsync() {
                    eprintln!("omp-normalizer: {e}");
                    *sh.avsync.lock().expect("lock poisoned") = before;
                    return Err(SetError::Unknown);
                }
                Ok(())
            }
            "normalize.transferPolicy" => {
                use omp_normalizer::house::TransferPolicy as T;
                let p = match value.as_str() {
                    Some("house") | Some("") => None,
                    Some("warn") => Some(T::Warn),
                    Some("block") => Some(T::Block),
                    Some("map") => Some(T::Map),
                    _ => {
                        eprintln!("omp-normalizer: normalize.transferPolicy muss house, warn, block oder map sein");
                        return Err(SetError::Unknown);
                    }
                };
                *sh.transfer_policy.lock().expect("lock poisoned") = p;
                self.pipeline.reconfigure();
                Ok(())
            }
            "normalize.mapBackend" => {
                let name = value.as_str().ok_or(SetError::Unknown)?.trim().to_string();
                *sh.map_backend.lock().expect("lock poisoned") = if name.is_empty() { "builtin".into() } else { name };
                self.pipeline.reconfigure();
                Ok(())
            }
            n if self.get(n).is_some() => Err(SetError::ReadOnly),
            _ => Err(SetError::Unknown),
        }
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let sh = &self.pipeline.shared;
        match name {
            "avsync.apply" => {
                // Letzten Messwert übernehmen und halten (Modus `once`).
                let ms = self.avsync.lock().expect("lock poisoned").ms.ok_or_else(|| {
                    eprintln!("omp-normalizer: avsync.apply ohne Messwert");
                    InvokeError::Unknown
                })?;
                sh.avsync.lock().expect("lock poisoned").held_ms = Some(ms);
                return sh.recompute_avsync().map(|_| ()).map_err(|e| {
                    eprintln!("omp-normalizer: {e}");
                    InvokeError::Unknown
                });
            }
            "avsync.reset" => {
                sh.avsync.lock().expect("lock poisoned").held_ms = None;
                return sh.recompute_avsync().map(|_| ()).map_err(|_| InvokeError::Unknown);
            }
            "avsync.measure" => {}
            _ => return Err(InvokeError::Unknown),
        }
        let secs = args.get("seconds").and_then(Value::as_f64).unwrap_or(10.0).clamp(2.0, 120.0);
        let (vid, aid) = (self.video_connected.lock().expect("lock poisoned").clone(), self.audio_connected.lock().expect("lock poisoned").clone());
        if vid.is_empty() || aid.is_empty() {
            eprintln!("omp-normalizer: avsync.measure braucht verbundenes Bild und Ton");
            return Err(InvokeError::Unknown);
        }
        {
            let mut st = self.avsync.lock().expect("lock poisoned");
            if st.running {
                return Err(InvokeError::Unknown);
            }
            st.running = true;
        }
        let (state, domain) = (self.avsync.clone(), self.domain.clone());
        // Messung am Eingang (Etiketten der Quelle) in eigenem Thread, damit der Aufruf sofort zurückkehrt.
        std::thread::spawn(move || {
            let result = (|| -> Result<omp_mediaio::avmarker::Measurement, String> {
                let ctx = omp_mediaio::mxl::MxlContext::new(&domain)?;
                omp_mediaio::avmarker::measure(ctx.instance(), &vid, &aid, secs, 500.0, &AtomicBool::new(false))
            })();
            let mut st = state.lock().expect("lock poisoned");
            st.running = false;
            match result {
                Ok(m) => {
                    let mut est = omp_normalizer::offset::Estimator::new(64);
                    for v in &m.offsets_ms {
                        est.push(*v);
                    }
                    match est.estimate() {
                        Some(e) => {
                            st.method = "marker";
                            st.ms = Some(e.ms);
                            st.confidence = e.confidence;
                            st.samples = e.samples;
                        }
                        None => {
                            // Kein Marker erkannt: ausdrücklich kein Messwert.
                            st.method = "none";
                            st.ms = None;
                            st.confidence = 0.0;
                            st.samples = 0;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("omp-normalizer: avsync.measure: {e}");
                    st.method = "none";
                    st.ms = None;
                    st.confidence = 0.0;
                    st.samples = 0;
                }
            }
        });
        Ok(())
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        let (vid, aid, did) = (self.video_conn.id(), self.audio_conn.id(), self.data_conn.id());
        if let Some(r) = uibundle::route(method, path) {
            return Some(r);
        }
        root_discovery(method, path)
            .or_else(|| list_ids(method, path, "receivers", &[vid, aid, did]))
            .or_else(|| bulk_discovery(method, path))
            .or_else(|| {
                bulk_patch(method, path, "receivers", body, |id, params| {
                    if id == vid {
                        Some(self.video_conn.patch_staged(params).0)
                    } else if id == aid {
                        Some(self.audio_conn.patch_staged(params).0)
                    } else if id == did {
                        Some(self.data_conn.patch_staged(params).0)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| bulk_patch(method, path, "senders", body, |_, _| None))
            .or_else(|| self.video_conn.handle(method, path, body))
            .or_else(|| self.audio_conn.handle(method, path, body))
            .or_else(|| self.data_conn.handle(method, path, body))
            .map(to_raw)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.video_conn
            .cors_methods(path)
            .or_else(|| self.audio_conn.cors_methods(path))
            .or_else(|| self.data_conn.cors_methods(path))
            .or_else(|| bulk_cors_methods(path, "senders"))
            .or_else(|| bulk_cors_methods(path, "receivers"))
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Normalizer");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9395").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    // Hausformat: nur Startwert (Laufzeit: Parameter `normalize.houseFormat`). Kein Standardwert im Code: ohne Angabe gibt
    // es keine Anforderung und der Node reicht durch.
    let house_text = match std::env::var("OMP_HOUSE_FORMAT_FILE") {
        Ok(p) if !p.is_empty() => std::fs::read_to_string(&p).map_err(|e| format!("OMP_HOUSE_FORMAT_FILE {p}: {e}"))?,
        _ => env_or("OMP_HOUSE_FORMAT", ""),
    };
    let house = if house_text.trim().is_empty() { HouseFormat::default() } else { HouseFormat::from_json(&house_text)? };
    let mode = pipeline::Mode::parse(&env_or("OMP_NORMALIZE_MODE", "auto")).unwrap_or(pipeline::Mode::Auto);

    let video_receiver_id = omp_node_sdk::idgen::new_v4();
    let audio_receiver_id = omp_node_sdk::idgen::new_v4();
    let data_receiver_id = omp_node_sdk::idgen::new_v4();
    let video_flow_id = std::env::var("OMP_VIDEO_FLOW_ID").unwrap_or_else(|_| omp_node_sdk::idgen::new_v4());
    let audio_flow_id = std::env::var("OMP_AUDIO_FLOW_ID").unwrap_or_else(|_| omp_node_sdk::idgen::new_v4());
    let data_flow_id = std::env::var("OMP_DATA_FLOW_ID").unwrap_or_else(|_| omp_node_sdk::idgen::new_v4());

    // Für die Anmeldung im Register (IS-04) nennt der Node das Hausformat beim Start; spätere Änderungen wirken im MXL-Flow.
    let (decl_w, decl_h, decl_n, decl_d) = match &house.video {
        Some(v) => (v.width, v.height, v.rate.num, v.rate.den),
        None => (640, 360, 25, 1),
    };
    let (decl_rate, decl_channels) = match &house.audio {
        Some(a) => (a.sample_rate, a.channels),
        None => (48000, 2),
    };

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let config = pipeline::Config {
        domain,
        video_flow_id: video_flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        data_flow_id: data_flow_id.clone(),
        label: label.clone(),
        house,
        mode,
        audio_map: match std::env::var("OMP_AUDIO_MAP") {
            Ok(t) if !t.trim().is_empty() => AudioMap::from_json(&t)?,
            _ => AudioMap::default(),
        },
        rate_mode: omp_mediaio::framerate::RateMode::from_env(),
    };
    let pipeline_shutdown = shutdown.clone();
    let heartbeat = Arc::new(AtomicU64::new(0));
    let hb = heartbeat.clone();
    let pipeline_thread = std::thread::spawn(move || pipeline::run(config, tx, pipeline_shutdown, ready_tx, hb));
    let pipeline_handle = match ready_rx.await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            eprintln!("omp-normalizer: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => return Err("pipeline thread ended before reporting readiness".into()),
    };

    let video_connected = Arc::new(Mutex::new(String::new()));
    let audio_connected = Arc::new(Mutex::new(String::new()));
    let data_connected = Arc::new(Mutex::new(String::new()));
    let make = |id: &str, kind: Kind, connected: &Arc<Mutex<String>>| {
        Arc::new(ReceiverConnection::new(
            id.to_string(),
            NormControl {
                registry: RegistryClient::new(registry_url.clone()),
                pipeline: pipeline_handle.clone(),
                kind,
                connected: connected.clone(),
            },
        ))
    };
    let video_conn = make(&video_receiver_id, Kind::Video, &video_connected);
    let audio_conn = make(&audio_receiver_id, Kind::Audio, &audio_connected);
    let data_conn = make(&data_receiver_id, Kind::Data, &data_connected);
    let media_ready = pipeline_handle.clone();
    let store: Arc<dyn ParamStore> = Arc::new(NormStore {
        domain: env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl"),
        avsync: Arc::new(Mutex::new(AvState { method: "none", ..Default::default() })),
        video_connected,
        audio_connected,
        data_connected,
        data_flow_id: data_flow_id.clone(),
        video_flow_id: video_flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        video_conn,
        audio_conn,
        data_conn,
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
                        frame_width: decl_w,
                        frame_height: decl_h,
                        grain_rate_numerator: decl_n,
                        grain_rate_denominator: decl_d,
                    }),
                    ..Default::default()
                },
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Audio {
                        id: Some(audio_flow_id),
                        sample_rate_numerator: decl_rate,
                        channel_count: decl_channels,
                        media_type: "audio/float32".to_string(),
                        bit_depth: 32,
                        source_id: None,
                    }),
                    ..Default::default()
                },
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Data { id: Some(data_flow_id), grain_rate_numerator: decl_n, grain_rate_denominator: decl_d, did_sdid: vec![] }),
                    label: Some("Daten".to_string()),
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
                ReceiverSpec {
                    id: Some(data_receiver_id),
                    transport: Some(TRANSPORT_MXL.to_string()),
                    media_types: Some(vec!["video/smpte291".to_string()]),
                    label: Some("Daten".to_string()),
                    ..Default::default()
                },
            ],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_ready.media_ready())),
        },
        store,
    )
    .await?;
    handle.register_worker("pipeline", heartbeat);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    let message = omp_node_sdk::errcode::tag(&message);
                    eprintln!("omp-normalizer: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-normalizer: shutdown requested"),
        _ = events => eprintln!("omp-normalizer: pipeline thread ended"),
    }
    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();
    Ok(())
}
