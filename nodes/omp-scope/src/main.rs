//! omp-scope: Messgerät-Node für Video-/Audio-/Metadaten-Analyse
//! (Nutzerauftrag 2026-09-14, zweiter Teil von "ein modernstes und
//! kreatives intuitives Messgerät ... um Video, Audio und Daten
//! messtechnisch zu analysieren", nach dem BCP-008-Fleet-Dashboard im
//! selben Auftrag). Passiver Tap (kein Sender, s. `AskUserQuestion`-
//! Entscheidung "Passiver Tap/Monitor-Node") auf ZWEI unabhängige,
//! optionale IS-05-Receiver — ein Video- und ein Audio-Flow, beide wie
//! bei `omp-viewer` per Drag & Drop im Flow-Editor verbindbar.
//!
//! **Video:** Waveform (Luma-Dichtehistogramm) + Vektorskop
//! (Cb/Cr-Streudiagramm) als ein kombiniertes Bild, über dieselbe
//! JPEG-über-HTTP-Infrastruktur wie `omp-viewer`s Vorschau gestreamt
//! (`video_pipeline.rs`, Pixel-Mathematik in `scope_image.rs`).
//!
//! **Audio:** Peak/RMS-Pegel (`level`-Element, exakt `omp-viewer::
//! audio_meters`s bewährtes Muster) + echte EBU-R128-Lautheit
//! (Momentary/Short-term/Integrated/Range über die `ebur128`-Bibliothek,
//! `audio_pipeline.rs`).
//!
//! **Daten:** gemessene (nicht geratene) technische Ist-Werte aus den
//! tatsächlich verhandelten GStreamer-Caps bzw. Bus-Messages — Auflösung/
//! Framerate/gemessene fps für Video, Abtastrate/Kanalzahl für Audio.
//!
//! **Bewusst nicht Teil dieser Runde** (s. `docs/decisions.md`-Eintrag):
//! kein AMWA-BCP-008-Monitor (dieser Node ist ein reiner Analyse-Tap,
//! kein Sender/Receiver im eigentlichen Signalweg-Sinn); kein rotiertes
//! SMPTE-Vektorskop-Graticule mit R/G/B/Cy/Mg/Ye-Zielboxen (reines
//! unrotiertes Cb/Cr-Streudiagramm, s. `scope_image.rs`-Moduldoku);
//! keine gegatete Integrated-Loudness-Sonderbehandlung über die von
//! `ebur128` bereits gelieferte hinaus.

mod audio_pipeline;
mod scope_image;
mod uibundle;
mod video_pipeline;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use omp_mediaio::levels;
use omp_mediaio::mxl::MxlContext;
use omp_mediaio::preview;
use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, SetError};
use serde_json::Value;

struct VideoControl {
    registry: RegistryClient,
    pipeline: video_pipeline::PipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
    connected_label: Arc<Mutex<String>>,
}

impl ReceiverControl for VideoControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        *self.connected_label.lock().expect("lock poisoned") = sender.label.clone();
                        self.pipeline.connect(flow_id, sender.label);
                    }
                    None => eprintln!("omp-scope: video sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-scope: resolve video sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                *self.connected_label.lock().expect("lock poisoned") = String::new();
                self.pipeline.disconnect();
            }
        }
    }
}

struct AudioControl {
    registry: RegistryClient,
    handle: audio_pipeline::AudioHandle,
    connected_flow_id: Arc<Mutex<String>>,
    connected_label: Arc<Mutex<String>>,
}

impl ReceiverControl for AudioControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        *self.connected_label.lock().expect("lock poisoned") = sender.label.clone();
                        self.handle.connect(flow_id);
                    }
                    None => eprintln!("omp-scope: audio sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-scope: resolve audio sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                *self.connected_label.lock().expect("lock poisoned") = String::new();
                self.handle.disconnect();
            }
        }
    }
}

struct ScopeStore {
    preview_url: String,
    levels_url: String,
    video_connection: Arc<ReceiverConnection<VideoControl>>,
    audio_connection: Arc<ReceiverConnection<AudioControl>>,
    video_connected_flow_id: Arc<Mutex<String>>,
    video_connected_label: Arc<Mutex<String>>,
    audio_connected_flow_id: Arc<Mutex<String>>,
    audio_connected_label: Arc<Mutex<String>>,
    video_format: Arc<Mutex<Option<video_pipeline::Event>>>,
    video_measured_fps: Arc<Mutex<f64>>,
    audio_handle: audio_pipeline::AudioHandle,
}

impl ParamStore for ScopeStore {
    fn descriptor(&self) -> Descriptor {
        let readonly_string = |name: &str| ParamSpec {
            name: name.to_string(),
            kind: ParamType::String,
            unit: None,
            range: None,
            readonly: true,
        };
        let readonly_number = |name: &str, unit: Option<&str>| ParamSpec {
            name: name.to_string(),
            kind: ParamType::Number,
            unit: unit.map(str::to_string),
            range: None,
            readonly: true,
        };
        let parameters = vec![
            readonly_string("previewUrl"),
            readonly_string("levelsUrl"),
            readonly_string("videoConnectedFlowId"),
            readonly_string("videoSourceLabel"),
            readonly_number("videoWidth", Some("px")),
            readonly_number("videoHeight", Some("px")),
            readonly_string("videoFramerate"),
            readonly_number("videoMeasuredFps", Some("fps")),
            readonly_string("audioConnectedFlowId"),
            readonly_string("audioSourceLabel"),
            readonly_number("audioSampleRate", Some("Hz")),
            readonly_number("audioChannels", None),
            readonly_number("loudnessMomentaryLufs", Some("LUFS")),
            readonly_number("loudnessShortTermLufs", Some("LUFS")),
            readonly_number("loudnessIntegratedLufs", Some("LUFS")),
            readonly_number("loudnessRangeLu", Some("LU")),
        ];
        Descriptor { latency: None, parameters, methods: vec![] }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "previewUrl" => Some(serde_json::json!(self.preview_url)),
            "levelsUrl" => Some(serde_json::json!(self.levels_url)),
            "videoConnectedFlowId" => Some(serde_json::json!(*self.video_connected_flow_id.lock().expect("lock poisoned"))),
            "videoSourceLabel" => Some(serde_json::json!(*self.video_connected_label.lock().expect("lock poisoned"))),
            // `Option<Value>::None` bedeutet für `ParamStore::get`
            // (`omp_node_sdk::server`) "kein Parameter mit diesem Namen"
            // (→ HTTP 404 "unknown parameter") — NICHT "Wert noch nicht
            // gemessen". Live gefunden (echter GET gegen einen laufenden
            // Node, bevor das erste Analyse-Frame durch war): alle drei
            // Video-Format-Parameter lieferten "unknown parameter" statt
            // eines vorläufigen `null`, obwohl sie im Descriptor gelistet
            // sind. Fix: für noch fehlende Messwerte `Some(Value::Null)`
            // statt `None` — `videoConnectedFlowId`/`videoSourceLabel`
            // (leerer String als Default) waren davon nicht betroffen,
            // s. `ViewerStore::get` in `omp-viewer` für dasselbe Muster.
            "videoWidth" => Some(video_format_field(&self.video_format, |f| serde_json::json!(f.0))),
            "videoHeight" => Some(video_format_field(&self.video_format, |f| serde_json::json!(f.1))),
            "videoFramerate" => Some(video_format_field(&self.video_format, |f| serde_json::json!(format!("{}/{}", f.2.0, f.2.1)))),
            "videoMeasuredFps" => Some(serde_json::json!(*self.video_measured_fps.lock().expect("lock poisoned"))),
            "audioConnectedFlowId" => Some(serde_json::json!(*self.audio_connected_flow_id.lock().expect("lock poisoned"))),
            "audioSourceLabel" => Some(serde_json::json!(*self.audio_connected_label.lock().expect("lock poisoned"))),
            "audioSampleRate" => Some(opt_u32_json(self.audio_handle.loudness().sample_rate)),
            "audioChannels" => Some(opt_u32_json(self.audio_handle.loudness().channels)),
            "loudnessMomentaryLufs" => Some(opt_f64_json(self.audio_handle.loudness().momentary_lufs)),
            "loudnessShortTermLufs" => Some(opt_f64_json(self.audio_handle.loudness().short_term_lufs)),
            "loudnessIntegratedLufs" => Some(opt_f64_json(self.audio_handle.loudness().integrated_lufs)),
            "loudnessRangeLu" => Some(opt_f64_json(self.audio_handle.loudness().range_lu)),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, _name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if let Some((status, content_type, body)) = self.video_connection.handle(method, path, body) {
            return Some(RawResponse { status, content_type, body });
        }
        if let Some((status, content_type, body)) = self.audio_connection.handle(method, path, body) {
            return Some(RawResponse { status, content_type, body });
        }
        uibundle::route(method, path)
    }
}

fn opt_u32_json(v: Option<u32>) -> Value {
    v.map(|v| serde_json::json!(v)).unwrap_or(Value::Null)
}

/// `serde_json::json!` würde ein NaN/Infinity (z. B. -inf LUFS bei
/// digitaler Stille) mangels gültiger JSON-Zahl zu `null` verstümmeln
/// UND das für die eigentliche Absenz eines Messwerts genutzte `null`
/// wäre davon nicht mehr unterscheidbar — explizit behandelt statt
/// zufällig gleich auszusehen.
fn opt_f64_json(v: Option<f64>) -> Value {
    match v {
        Some(v) if v.is_finite() => serde_json::json!(v),
        _ => Value::Null,
    }
}

fn video_format_field(
    video_format: &Mutex<Option<video_pipeline::Event>>,
    extract: impl Fn((i32, i32, (i32, i32))) -> Value,
) -> Value {
    match video_format.lock().expect("lock poisoned").as_ref() {
        Some(video_pipeline::Event::SourceFormat { width, height, framerate }) => extract((*width, *height, *framerate)),
        _ => Value::Null,
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Scope");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9360").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let preview_port: u16 = env_or("OMP_SCOPE_PREVIEW_PORT", "0").parse()?;
    let levels_port: u16 = env_or("OMP_SCOPE_LEVELS_PORT", "0").parse()?;
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let video_receiver_id = omp_node_sdk::idgen::new_v4();
    let audio_receiver_id = omp_node_sdk::idgen::new_v4();

    let broadcaster = Arc::new(preview::Broadcaster::new());
    let preview_heartbeat = Arc::new(AtomicU64::new(0));
    let actual_preview_port = preview::spawn(&format!("0.0.0.0:{preview_port}"), broadcaster.clone(), preview_heartbeat.clone())?;
    let preview_url = format!("http://{host}:{actual_preview_port}/preview");

    let levels_broadcaster = Arc::new(levels::Broadcaster::new());
    let levels_heartbeat = Arc::new(AtomicU64::new(0));
    let actual_levels_port = levels::spawn(&format!("0.0.0.0:{levels_port}"), levels_broadcaster.clone(), levels_heartbeat.clone())?;
    let levels_url = format!("http://{host}:{actual_levels_port}/levels");

    // EIN `MxlContext` für den ganzen Prozess (2026-08-07-Erkenntnis aus
    // `omp-viewer::audio_meters`-Moduldoku: zwei unabhängige Pipeline-
    // Threads dürfen sich dieselbe MXL-Domain-Instanz nicht je selbst ein
    // zweites Mal öffnen).
    let mxl_context = match MxlContext::new(&domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            eprintln!("omp-scope: MxlContext::new failed: {e}");
            return Err(e.into());
        }
    };

    let (video_tx, mut video_rx) = tokio::sync::mpsc::unbounded_channel::<video_pipeline::Event>();
    let video_shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (video_ready_tx, video_ready_rx) = tokio::sync::oneshot::channel();
    let video_heartbeat = Arc::new(AtomicU64::new(0));
    let video_heartbeat_thread = video_heartbeat.clone();
    let video_context = mxl_context.clone();
    let video_broadcaster = broadcaster.clone();
    let video_shutdown_thread = video_shutdown.clone();
    let video_thread = std::thread::spawn(move || {
        video_pipeline::run(video_context, video_broadcaster, video_tx, video_shutdown_thread, video_ready_tx, video_heartbeat_thread)
    });
    let video_handle = match video_ready_rx.await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            eprintln!("omp-scope: video pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => return Err("video pipeline thread ended before reporting readiness".into()),
    };

    let (audio_tx, mut audio_rx) = tokio::sync::mpsc::unbounded_channel::<audio_pipeline::Event>();
    let audio_shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (audio_ready_tx, audio_ready_rx) = tokio::sync::oneshot::channel();
    let audio_heartbeat = Arc::new(AtomicU64::new(0));
    let audio_heartbeat_thread = audio_heartbeat.clone();
    let audio_context = mxl_context.clone();
    let audio_shutdown_thread = audio_shutdown.clone();
    let audio_thread = std::thread::spawn(move || audio_pipeline::run(audio_context, audio_tx, audio_shutdown_thread, audio_ready_tx, audio_heartbeat_thread));
    let audio_handle = match audio_ready_rx.await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            eprintln!("omp-scope: audio pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => return Err("audio pipeline thread ended before reporting readiness".into()),
    };

    let video_connected_flow_id = Arc::new(Mutex::new(String::new()));
    let video_connected_label = Arc::new(Mutex::new(String::new()));
    let audio_connected_flow_id = Arc::new(Mutex::new(String::new()));
    let audio_connected_label = Arc::new(Mutex::new(String::new()));
    let video_format: Arc<Mutex<Option<video_pipeline::Event>>> = Arc::new(Mutex::new(None));
    let video_measured_fps = Arc::new(Mutex::new(0.0f64));

    tokio::spawn({
        let video_format = video_format.clone();
        let video_measured_fps = video_measured_fps.clone();
        async move {
            while let Some(event) = video_rx.recv().await {
                match event {
                    video_pipeline::Event::Error(message) => eprintln!("omp-scope: video pipeline error: {message}"),
                    video_pipeline::Event::MeasuredFps(fps) => *video_measured_fps.lock().expect("lock poisoned") = fps,
                    fmt @ video_pipeline::Event::SourceFormat { .. } => {
                        *video_format.lock().expect("lock poisoned") = Some(fmt);
                    }
                }
            }
        }
    });

    tokio::spawn({
        let levels_broadcaster = levels_broadcaster.clone();
        async move {
            while let Some(event) = audio_rx.recv().await {
                match event {
                    audio_pipeline::Event::LevelMeter { rms, peak } => {
                        let json = serde_json::json!({ "inputId": audio_pipeline::METER_INPUT_ID, "rms": rms, "peak": peak }).to_string();
                        levels_broadcaster.publish(&json);
                    }
                }
            }
        }
    });

    let video_connection = Arc::new(ReceiverConnection::new(
        video_receiver_id.clone(),
        VideoControl {
            registry: RegistryClient::new(registry_url.clone()),
            pipeline: video_handle.clone(),
            connected_flow_id: video_connected_flow_id.clone(),
            connected_label: video_connected_label.clone(),
        },
    ));
    let audio_connection = Arc::new(ReceiverConnection::new(
        audio_receiver_id.clone(),
        AudioControl {
            registry: RegistryClient::new(registry_url.clone()),
            handle: audio_handle.clone(),
            connected_flow_id: audio_connected_flow_id.clone(),
            connected_label: audio_connected_label.clone(),
        },
    ));

    let media_ready_video = video_handle.clone();
    let media_ready_audio = audio_handle.clone();

    let store: Arc<dyn ParamStore> = Arc::new(ScopeStore {
        preview_url,
        levels_url,
        video_connection,
        audio_connection,
        video_connected_flow_id,
        video_connected_label,
        audio_connected_flow_id,
        audio_connected_label,
        video_format,
        video_measured_fps,
        audio_handle: audio_handle.clone(),
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![],
            receivers: vec![
                omp_node_sdk::ReceiverSpec {
                    id: Some(video_receiver_id),
                    transport: Some(TRANSPORT_MXL.to_string()),
                    media_types: Some(vec!["video/v210".to_string()]),
                    ..Default::default()
                },
                omp_node_sdk::ReceiverSpec {
                    id: Some(audio_receiver_id),
                    transport: Some(TRANSPORT_MXL.to_string()),
                    media_types: Some(vec!["audio/float32".to_string()]),
                    ..Default::default()
                },
            ],
            instance_id,
            // "media-ready" (ARCHITECTURE.md §5 Punkt 6): bereits nützlich,
            // sobald MINDESTENS einer der beiden unabhängigen Taps ein
            // echtes Signal liefert — ein Messgerät mit nur Video ODER nur
            // Audio verbunden zeigt trotzdem sinnvolle Messwerte an.
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_ready_video.media_ready() || media_ready_audio.media_ready())),
        },
        store,
    )
    .await?;

    handle.register_worker("video-pipeline", video_heartbeat);
    handle.register_worker("audio-pipeline", audio_heartbeat);
    handle.register_worker("preview-accept", preview_heartbeat);
    handle.register_worker("levels-accept", levels_heartbeat);

    // Gleiches Muster wie `omp-viewer::main` (dort zusätzlich gegen ein
    // "Pipeline-Thread endete"-Event racend — hier bewusst vereinfacht
    // auf reines SIGINT/SIGTERM-Warten, da beide Pipeline-Threads erst
    // nach explizitem `shutdown`-Flag enden, nie von selbst).
    let _ = tokio::signal::ctrl_c().await;
    eprintln!("omp-scope: shutdown requested");
    video_shutdown.store(true, Ordering::Relaxed);
    audio_shutdown.store(true, Ordering::Relaxed);
    let _ = video_thread.join();
    let _ = audio_thread.join();
    drop(handle);
    Ok(())
}
