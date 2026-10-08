//! GStreamer-Pipeline von `omp-recorder` (`UMSETZUNG.md` C22,
//! `ARCHITECTURE.md` §24.7): zwei unabhängige MXL-Receiver (Video/Audio,
//! IS-05-PATCH-wählbar wie bei `omp-viewer`, C6) — aber anders als dort
//! bauen `ConnectVideo`/`ConnectAudio` **keine** Lese-Pipeline auf, sie
//! merken sich nur den zuletzt gewählten `flow_id`. Die eigentliche
//! Lese-/Encode-/Mux-Pipeline entsteht ausschließlich zwischen
//! `record.start`/`record.stop` — "warm, unabonniert" bis zum Start,
//! dasselbe Muster, das für Hot-Standby vorgesehen ist
//! (`docs/END-GOAL-FEATURES.md` §7.4 Teil 4): kein Rendering-/Lese-
//! Overhead im Leerlauf, kein dynamisches Pad-Relinking einer laufenden
//! Pipeline (Projekt-Konvention: bei jeder Zustandsänderung komplett neu
//! aufbauen, s. `omp-viewer`/`omp-switcher`).
//!
//! Encoder-/Muxer-Wahl spiegelt PIPELINE CONTROLLERs `lib/OutputEngine.js`
//! `file`-Sink 1:1 (Muster übernommen, nicht geraten — `UMSETZUNG.md` §0
//! Punkt 9): `x264enc tune=zerolatency speed-preset=veryfast bitrate=…
//! key-int-max=50 ! h264parse config-interval=1` für Video, `avenc_aac
//! bitrate=192000 ! aacparse` für Audio, `matroskamux streamable=true`
//! als Muxer. `streamable=true` ist hier bewusst wichtig: anders als
//! `mp4mux` braucht Matroska keinen abschließenden Header-Rewrite mit
//! bekannter Gesamtdauer — die Datei bleibt auch bei einem harten
//! Prozess-Abbruch (kein vorheriges `record.stop()`) abspielbar, nicht
//! nur bei sauberem EOS. `record.stop()` schickt trotzdem ein echtes EOS
//! und wartet bis zu drei Sekunden darauf (gleiche Frist wie PIPELINE
//! CONTROLLERs `pipeline.stop(3000)`), bevor es die Pipeline hart auf
//! `Null` setzt — sauberer Regelfall, robuster Rückfall.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::mxl::{MxlAudioInput, MxlContext, MxlVideoInput};
use tokio::sync::mpsc::UnboundedSender as TokioUnboundedSender;
use tokio::sync::oneshot;

const VIDEO_BITRATE_KBPS: u32 = 4000;
const AUDIO_BITRATE_BPS: i32 = 192_000;
const STOP_EOS_TIMEOUT: Duration = Duration::from_secs(3);
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(200);


/// Diagnose (`OMP_AV_MARKER_TAP=1`, mit der Marker-Quelle von `omp-source`): misst direkt hinter
/// den MXL-Eingängen die PTS-Differenz Ton-Tick − Marker-Bild und gibt den Median beim Stoppen
/// aus (`Drop` des Tap) — trennt Lese-Kette von Encoder/Muxer (Lip-Sync-Suche 2026-10-05).
struct MarkerTap {
    vflips: Arc<Mutex<Vec<u64>>>,
    aticks: Arc<Mutex<Vec<u64>>>,
}

impl MarkerTap {
    fn attach(video_tail: Option<&gst::Element>, audio_tail: Option<&gst::Element>) -> Option<MarkerTap> {
        if !std::env::var("OMP_AV_MARKER_TAP").is_ok_and(|v| v == "1") {
            return None;
        }
        let vflips = Arc::new(Mutex::new(Vec::new()));
        let aticks = Arc::new(Mutex::new(Vec::new()));
        if let Some(pad) = video_tail.and_then(|e| e.static_pad("src")) {
            let v = vflips.clone();
            let bright = Arc::new(AtomicBool::new(false));
            pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, info| {
                if let Some(gst::PadProbeData::Buffer(b)) = &info.data
                    && let (Some(pts), Ok(map)) = (b.pts(), b.map_readable())
                {
                    let n = map.len().min(1 << 15);
                    let mean = map[..n].iter().map(|&x| x as f64).sum::<f64>() / n as f64;
                    let now_bright = mean > 100.0;
                    if now_bright && !bright.swap(now_bright, Ordering::Relaxed) {
                        v.lock().unwrap().push(pts.nseconds());
                    } else {
                        bright.store(now_bright, Ordering::Relaxed);
                    }
                }
                gst::PadProbeReturn::Ok
            });
        }
        if let Some(pad) = audio_tail.and_then(|e| e.static_pad("src")) {
            let a = aticks.clone();
            let quiet = Arc::new(std::sync::atomic::AtomicU64::new(u64::MAX / 2));
            pad.add_probe(gst::PadProbeType::BUFFER, move |pad, info| {
                if let Some(gst::PadProbeData::Buffer(b)) = &info.data
                    && let (Some(pts), Ok(map)) = (b.pts(), b.map_readable())
                {
                    let ch = pad.current_caps().and_then(|c| c.structure(0).and_then(|s| s.get::<i32>("channels").ok())).unwrap_or(1).max(1) as usize;
                    for (i, c) in map.chunks_exact(4 * ch).enumerate() {
                        let x = f32::from_le_bytes(c[..4].try_into().unwrap());
                        if x.abs() > 0.05 {
                            if quiet.load(Ordering::Relaxed) > 24_000 {
                                a.lock().unwrap().push(pts.nseconds() + i as u64 * 1_000_000_000 / 48_000);
                            }
                            quiet.store(0, Ordering::Relaxed);
                        } else {
                            quiet.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
                gst::PadProbeReturn::Ok
            });
        }
        Some(MarkerTap { vflips, aticks })
    }
}

impl Drop for MarkerTap {
    fn drop(&mut self) {
        let (v, a) = (self.vflips.lock().unwrap(), self.aticks.lock().unwrap());
        let mut d: Vec<f64> = a.iter().filter_map(|t| v.iter().min_by_key(|f| (**f as i64 - *t as i64).abs()).map(|f| (*t as i64 - *f as i64) as f64 / 1e6)).filter(|d| d.abs() < 500.0).collect();
        d.sort_by(|x, y| x.partial_cmp(y).unwrap());
        eprintln!("MARKERTAP flips={} ticks={} median PTS_a - PTS_v = {:.1} ms", v.len(), a.len(), d.get(d.len() / 2).copied().unwrap_or(f64::NAN));
    }
}

pub struct Config {
    pub domain: String,
    pub media_dir: String,
}

pub enum Event {
    /// Nicht fatal für den Node-Prozess (anders als bei `omp-viewer`
    /// o. Ä. läuft `omp-recorder` bei einem Aufnahme-Fehler einfach mit
    /// `record.status == "error"` weiter) — nur zur NATS-Alarmierung
    /// (`handle.publish_alert`, `main.rs`).
    Warning(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordStatus {
    Idle,
    Recording,
    Error,
}

impl RecordStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RecordStatus::Idle => "idle",
            RecordStatus::Recording => "recording",
            RecordStatus::Error => "error",
        }
    }
}

enum Command {
    ConnectVideo(String),
    DisconnectVideo,
    ConnectAudio(String),
    DisconnectAudio,
    StartRecording(String, Option<String>, Sender<Result<(), String>>),
    StopRecording(Sender<Result<(), String>>),
}

/// Griff für den async Node-Lifecycle (`main.rs`): reine Befehls-
/// Weiterleitung an den Pipeline-Thread, plus lock-freies Auslesen von
/// Status/Dauer für die `ParamStore::get`-Antworten.
#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    status: Arc<Mutex<RecordStatus>>,
    started_at: Arc<Mutex<Option<Instant>>>,
    frozen_duration_ms: Arc<AtomicU64>,
    flowed: Arc<AtomicBool>,
}

impl PipelineHandle {
    pub fn connect_video(&self, flow_id: String) {
        let _ = self.commands.send(Command::ConnectVideo(flow_id));
    }

    pub fn disconnect_video(&self) {
        let _ = self.commands.send(Command::DisconnectVideo);
    }

    pub fn connect_audio(&self, flow_id: String) {
        let _ = self.commands.send(Command::ConnectAudio(flow_id));
    }

    pub fn disconnect_audio(&self) {
        let _ = self.commands.send(Command::DisconnectAudio);
    }

    /// Blockiert (Pipeline-Thread braucht nur wenige ms für den
    /// Pipeline-Aufbau) — `ParamStore::invoke` ist selbst synchron
    /// (`tiny_http`, ein Request nach dem anderen je Node-Prozess, s.
    /// `omp-node-sdk/src/server.rs`), ein kurzer Block hier ist also
    /// unbedenklich.
    pub fn start_recording(&self, file_name: String, mca_plan: Option<String>) -> Result<(), String> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.commands
            .send(Command::StartRecording(file_name, mca_plan, reply_tx))
            .map_err(|_| "Pipeline-Thread nicht erreichbar".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "Pipeline-Thread hat nicht geantwortet".to_string())?
    }

    /// Blockiert bis zu `STOP_EOS_TIMEOUT` (EOS-Bestätigung abwarten,
    /// s. Moduldoku oben) — bewusst in Kauf genommene kurze Blockade
    /// aller anderen Anfragen an diesen Node-Prozess währenddessen,
    /// gleiche Abwägung wie bei PIPELINE CONTROLLERs `pipeline.stop(3000)`.
    pub fn stop_recording(&self) -> Result<(), String> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.commands
            .send(Command::StopRecording(reply_tx))
            .map_err(|_| "Pipeline-Thread nicht erreichbar".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "Pipeline-Thread hat nicht geantwortet".to_string())?
    }

    pub fn status(&self) -> RecordStatus {
        *self.status.lock().expect("lock poisoned")
    }

    pub fn duration_ms(&self) -> u64 {
        match *self.started_at.lock().expect("lock poisoned") {
            Some(t) => t.elapsed().as_millis() as u64,
            None => self.frozen_duration_ms.load(Ordering::Relaxed),
        }
    }

    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6): true, sobald seit dem
    /// letzten `record.start` mindestens ein echter Buffer den Muxer
    /// erreicht hat — false im Leerlauf (kein Sender-Pendant hier, s.
    /// `senders: vec![]` in `main.rs`) und direkt nach jedem Start, bis
    /// nachgewiesen.
    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

struct ActiveRecording {
    pipeline: gst::Pipeline,
    // Nur am Leben halten (Reader-Threads hängen an diesen Werten, s.
    // `MxlVideoInput`/`MxlAudioInput`-Doku in `omp-mediaio`) — nie
    // gelesen.
    _video_input: Option<MxlVideoInput>,
    _audio_input: Option<MxlAudioInput>,
    _marker_tap: Option<MarkerTap>,
    /// MXF-Ausgabe: Zieldatei + Label-Plan, der nach dem Finalisieren per Injektor
    /// (`omp-mxf-mca`, Kap. 33.2) in die Datei geschrieben wird — `mxfmux` selbst
    /// schreibt keine MCA-Sub-Descriptors.
    mca: Option<(PathBuf, omp_mxf_mca::inject::Plan)>,
}

fn is_mxf(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("mxf"))
}

/// Nimmt einen vom Operator frei eingegebenen Dateinamen (`record.start`-
/// Methodenargument, über die generische Parameter-Panel-`prompt()` im
/// UI oder direkt per HTTP) entgegen und liefert einen sicheren
/// Zielpfad **innerhalb** von `media_dir` — Pfad-Traversal (`../…`,
/// absolute Pfade) wird verworfen, nicht toleriert. Hängt `.mkv` an,
/// falls der Nutzer keine Endung mitgegeben hat.
fn safe_target_path(media_dir: &str, file_name: &str) -> Result<PathBuf, String> {
    let requested = Path::new(file_name);
    let base = requested
        .file_name()
        .ok_or_else(|| "Dateiname leer oder ungültig".to_string())?;
    // `Path::file_name()` liefert bereits nur die letzte Komponente
    // (kein "/", kein "..") — trotzdem defensiv die volle Komponenten-
    // liste prüfen, falls sich das Verhalten je ändert.
    if requested.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("Dateiname darf keine Pfadangaben enthalten".to_string());
    }
    let mut path = PathBuf::from(media_dir);
    path.push(base);
    if path.extension().is_none() {
        path.set_extension("mkv");
    }
    Ok(path)
}

fn build(
    context: &Arc<MxlContext>,
    video_flow_id: Option<&str>,
    audio_flow_id: Option<&str>,
    media_dir: &str,
    file_name: &str,
    mca_plan: Option<&str>,
    flowed: Arc<AtomicBool>,
) -> Result<ActiveRecording, String> {
    let target = safe_target_path(media_dir, file_name)?;
    let mxf = is_mxf(&target);
    let plan = match mca_plan.map(str::trim).filter(|p| !p.is_empty()) {
        None => None,
        Some(_) if !mxf => return Err("MCA-Labels brauchen eine .mxf-Zieldatei".to_string()),
        Some(text) => Some(omp_mxf_mca::inject::Plan::from_json(text).map_err(|e| format!("MCA-Plan: {e}"))?),
    };

    let pipeline = gst::Pipeline::new();

    let muxer = gst::ElementFactory::make(if mxf { "mxfmux" } else { "matroskamux" });
    let muxer = if mxf { muxer } else { muxer.property("streamable", true) }
        .build()
        .map_err(|e| format!("muxer: {e}"))?;
    let filesink = gst::ElementFactory::make("filesink")
        .property("location", target.to_string_lossy().to_string())
        .property("sync", false)
        .build()
        .map_err(|e| format!("filesink: {e}"))?;
    pipeline
        .add(&muxer)
        .and_then(|()| pipeline.add(&filesink))
        .map_err(|e| format!("add muxer/filesink: {e}"))?;
    gst::Element::link(&muxer, &filesink).map_err(|e| format!("link muxer to filesink: {e}"))?;

    let mut flowed_armed = false;
    let mut arm_flowed_probe = |tail_pad: &gst::Pad| {
        if flowed_armed {
            return;
        }
        flowed_armed = true;
        let flowed = flowed.clone();
        tail_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            flowed.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Remove
        });
    };

    let video_input = match video_flow_id {
        Some(flow_id) => {
            let input = MxlVideoInput::new(&pipeline, context.clone(), flow_id)
                .map_err(|e| format!("MxlVideoInput({flow_id}): {e}"))?;
            let videoconvert = gst::ElementFactory::make("videoconvert")
                .build()
                .map_err(|e| format!("videoconvert: {e}"))?;
            let x264enc = gst::ElementFactory::make("x264enc")
                .property("bitrate", VIDEO_BITRATE_KBPS)
                .property("key-int-max", 50u32)
                .build()
                .map_err(|e| format!("x264enc: {e}"))?;
            // GEnum/GFlags — Laufzeit-Registrierung, `.property()` mit
            // einem Rust-Wert schlägt hier fehl (bereits bekannter
            // Fund, s. Projekt-Memory "GStreamer enum properties are
            // runtime-only").
            x264enc.set_property_from_str("speed-preset", "veryfast");
            x264enc.set_property_from_str("tune", "zerolatency");
            let h264parse = gst::ElementFactory::make("h264parse")
                .property("config-interval", 1i32)
                .build()
                .map_err(|e| format!("h264parse: {e}"))?;
            let queue = gst::ElementFactory::make("queue")
                .build()
                .map_err(|e| format!("queue (video): {e}"))?;
            // mxfmux nimmt H.264 nur als Byte-Stream mit AU-Alignment.
            let mxf_caps = gst::ElementFactory::make("capsfilter")
                .property("caps", gst::Caps::builder("video/x-h264").field("stream-format", "byte-stream").field("alignment", "au").build())
                .build()
                .map_err(|e| format!("capsfilter (video): {e}"))?;

            pipeline
                .add(&videoconvert)
                .and_then(|()| pipeline.add(&x264enc))
                .and_then(|()| pipeline.add(&h264parse))
                .and_then(|()| pipeline.add(&queue))
                .map_err(|e| format!("add video branch: {e}"))?;
            if mxf {
                pipeline.add(&mxf_caps).map_err(|e| format!("add video caps: {e}"))?;
                gst::Element::link_many([&input.tail, &videoconvert, &x264enc, &h264parse, &mxf_caps, &queue])
            } else {
                gst::Element::link_many([&input.tail, &videoconvert, &x264enc, &h264parse, &queue])
            }
            .map_err(|e| format!("link video branch: {e}"))?;

            let mux_pad = muxer
                .request_pad_simple(if mxf { "mpeg_video_sink_%u" } else { "video_%u" })
                .ok_or("muxer: request video pad failed")?;
            queue
                .static_pad("src")
                .ok_or("queue (video): no src pad")?
                .link(&mux_pad)
                .map_err(|e| format!("link video queue to muxer: {e}"))?;

            arm_flowed_probe(&queue.static_pad("src").expect("queue has src pad"));
            Some(input)
        }
        None => None,
    };

    let audio_input = match audio_flow_id {
        Some(flow_id) => {
            let input = MxlAudioInput::new(&pipeline, context.clone(), flow_id)
                .map_err(|e| format!("MxlAudioInput({flow_id}): {e}"))?;
            let audioconvert = gst::ElementFactory::make("audioconvert")
                .build()
                .map_err(|e| format!("audioconvert: {e}"))?;
            let audioresample = gst::ElementFactory::make("audioresample")
                .build()
                .map_err(|e| format!("audioresample: {e}"))?;
            // `OMP_RECORDER_RAW_AUDIO=1` (Diagnose): unkomprimierter PCM-Ton statt AAC — trennt
            // Encoder-/Dekoder-Vorlauf von echtem Versatz bei der A/V-Messung.
            // MXF (BWF-Audio) trägt immer unkomprimierten PCM (24 Bit), nie AAC.
            let raw_audio = mxf || std::env::var("OMP_RECORDER_RAW_AUDIO").is_ok_and(|v| v == "1");
            let avenc_aac = gst::ElementFactory::make(if raw_audio { "identity" } else { "avenc_aac" })
                .build()
                .map_err(|e| format!("audio encoder: {e}"))?;
            if !raw_audio {
                avenc_aac.set_property("bitrate", AUDIO_BITRATE_BPS);
            }
            let aacparse = gst::ElementFactory::make(if raw_audio { "identity" } else { "aacparse" })
                .build()
                .map_err(|e| format!("aacparse: {e}"))?;
            let queue = gst::ElementFactory::make("queue")
                .build()
                .map_err(|e| format!("queue (audio): {e}"))?;
            let pcm_caps = gst::ElementFactory::make("capsfilter")
                .property("caps", gst::Caps::builder("audio/x-raw").field("format", "S24LE").field("layout", "interleaved").build())
                .build()
                .map_err(|e| format!("capsfilter (audio): {e}"))?;

            pipeline
                .add(&audioconvert)
                .and_then(|()| pipeline.add(&audioresample))
                .and_then(|()| pipeline.add(&avenc_aac))
                .and_then(|()| pipeline.add(&aacparse))
                .and_then(|()| pipeline.add(&queue))
                .map_err(|e| format!("add audio branch: {e}"))?;
            if mxf {
                pipeline.add(&pcm_caps).map_err(|e| format!("add audio caps: {e}"))?;
                gst::Element::link_many([&input.tail, &audioconvert, &audioresample, &pcm_caps, &queue])
            } else {
                gst::Element::link_many([&input.tail, &audioconvert, &audioresample, &avenc_aac, &aacparse, &queue])
            }
            .map_err(|e| format!("link audio branch: {e}"))?;

            let mux_pad = muxer
                .request_pad_simple(if mxf { "bwf_audio_sink_%u" } else { "audio_%u" })
                .ok_or("muxer: request audio pad failed")?;
            queue
                .static_pad("src")
                .ok_or("queue (audio): no src pad")?
                .link(&mux_pad)
                .map_err(|e| format!("link audio queue to muxer: {e}"))?;

            arm_flowed_probe(&queue.static_pad("src").expect("queue has src pad"));
            Some(input)
        }
        None => None,
    };

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    let marker_tap = MarkerTap::attach(video_input.as_ref().map(|i| &i.tail), audio_input.as_ref().map(|i| &i.tail));
    Ok(ActiveRecording {
        pipeline,
        _video_input: video_input,
        _audio_input: audio_input,
        _marker_tap: marker_tap,
        mca: plan.map(|p| (target, p)),
    })
}

/// Schickt ein echtes EOS und wartet bis zu `STOP_EOS_TIMEOUT` auf dessen
/// Ankunft am Bus, bevor die Pipeline hart auf `Null` gesetzt wird —
/// s. Moduldoku für die Begründung (Matroska `streamable=true` toleriert
/// den Timeout-Fall, ist also kein harter Fehler, nur eine Warnung).
fn stop_gracefully(pipeline: &gst::Pipeline) -> Option<String> {
    let warning = match pipeline.bus() {
        None => {
            Some("Pipeline ohne Bus — Datei möglicherweise nicht sauber finalisiert".to_string())
        }
        Some(bus) => {
            pipeline.send_event(gst::event::Eos::new());
            match bus.timed_pop_filtered(
                gst::ClockTime::from_mseconds(STOP_EOS_TIMEOUT.as_millis() as u64),
                &[gst::MessageType::Eos, gst::MessageType::Error],
            ) {
                Some(msg) => match msg.view() {
                    gst::MessageView::Eos(_) => None,
                    gst::MessageView::Error(err) => Some(format!(
                        "Pipeline-Fehler beim Stoppen: {} ({})",
                        err.error(),
                        err.debug().unwrap_or_default()
                    )),
                    _ => None,
                },
                None => Some(format!(
                    "kein EOS innerhalb von {}s — Datei bleibt dank streamable=true trotzdem abspielbar",
                    STOP_EOS_TIMEOUT.as_secs()
                )),
            }
        }
    };
    let _ = pipeline.set_state(gst::State::Null);
    warning
}

fn poll_error(pipeline: &gst::Pipeline, timeout: Duration) -> Option<String> {
    let bus = pipeline.bus()?;
    let msg = bus.timed_pop_filtered(
        gst::ClockTime::from_mseconds(timeout.as_millis() as u64),
        &[gst::MessageType::Error],
    )?;
    match msg.view() {
        gst::MessageView::Error(err) => Some(format!(
            "{} ({})",
            err.error(),
            err.debug().unwrap_or_default()
        )),
        _ => None,
    }
}

/// Läuft auf einem eigenen Thread (analog `omp-viewer::pipeline::run`):
/// verwaltet nur die zuletzt gewählten Video-/Audio-`flow_id`s, bis
/// `record.start` die eigentliche Pipeline aufbaut.
pub fn run(
    config: Config,
    tx: TokioUnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
    heartbeat: Arc<AtomicU64>,
) {
    if let Err(e) = gst::init() {
        let msg = format!("gst init failed: {e}");
        let _ = ready.send(Err(msg));
        return;
    }

    let context = match MxlContext::new_synced(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) =
        std::sync::mpsc::channel();
    let status = Arc::new(Mutex::new(RecordStatus::Idle));
    let started_at = Arc::new(Mutex::new(None::<Instant>));
    let frozen_duration_ms = Arc::new(AtomicU64::new(0));
    let flowed = Arc::new(AtomicBool::new(false));

    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        status: status.clone(),
        started_at: started_at.clone(),
        frozen_duration_ms: frozen_duration_ms.clone(),
        flowed: flowed.clone(),
    }));

    let mut video_flow_id: Option<String> = None;
    let mut audio_flow_id: Option<String> = None;
    let mut active: Option<ActiveRecording> = None;

    let freeze_duration = |started_at: &Mutex<Option<Instant>>, frozen: &AtomicU64| {
        if let Some(t) = started_at.lock().expect("lock poisoned").take() {
            frozen.store(t.elapsed().as_millis() as u64, Ordering::Relaxed);
        }
    };

    loop {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }

        if let Some(rec) = &active
            && let Some(err) = poll_error(&rec.pipeline, Duration::from_millis(50))
        {
            let _ = rec.pipeline.set_state(gst::State::Null);
            active = None;
            *status.lock().expect("lock poisoned") = RecordStatus::Error;
            freeze_duration(&started_at, &frozen_duration_ms);
            let _ = tx.send(Event::Warning(format!("Aufnahme abgebrochen: {err}")));
        }

        match commands_rx.recv_timeout(COMMAND_POLL_INTERVAL) {
            Ok(Command::ConnectVideo(flow_id)) => video_flow_id = Some(flow_id),
            Ok(Command::DisconnectVideo) => video_flow_id = None,
            Ok(Command::ConnectAudio(flow_id)) => audio_flow_id = Some(flow_id),
            Ok(Command::DisconnectAudio) => audio_flow_id = None,
            Ok(Command::StartRecording(file_name, mca_plan, reply)) => {
                let result = if active.is_some() {
                    Err("Aufnahme läuft bereits — erst record.stop".to_string())
                } else if video_flow_id.is_none() && audio_flow_id.is_none() {
                    Err("keine Quelle verbunden (Video-/Audio-Receiver)".to_string())
                } else {
                    flowed.store(false, Ordering::Relaxed);
                    build(
                        &context,
                        video_flow_id.as_deref(),
                        audio_flow_id.as_deref(),
                        &config.media_dir,
                        &file_name,
                        mca_plan.as_deref(),
                        flowed.clone(),
                    )
                };
                match result {
                    Ok(rec) => {
                        active = Some(rec);
                        *status.lock().expect("lock poisoned") = RecordStatus::Recording;
                        *started_at.lock().expect("lock poisoned") = Some(Instant::now());
                        let _ = reply.send(Ok(()));
                    }
                    Err(e) => {
                        *status.lock().expect("lock poisoned") = RecordStatus::Error;
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Ok(Command::StopRecording(reply)) => match active.take() {
                None => {
                    let _ = reply.send(Err("keine laufende Aufnahme".to_string()));
                }
                Some(rec) => {
                    let mut warning = stop_gracefully(&rec.pipeline);
                    if let Some((path, plan)) = &rec.mca {
                        match omp_mxf_mca::inject::inject(path, path, plan) {
                            Ok(r) => eprintln!("omp-recorder: {} MCA-Label(s) in {} geschrieben (in place: {})", r.labels_written, path.display(), r.in_place),
                            Err(e) => warning = Some(format!("MCA-Labels nicht geschrieben ({}): {e}", path.display())),
                        }
                    }
                    freeze_duration(&started_at, &frozen_duration_ms);
                    *status.lock().expect("lock poisoned") = RecordStatus::Idle;
                    if let Some(w) = warning {
                        let _ = tx.send(Event::Warning(w));
                    }
                    let _ = reply.send(Ok(()));
                }
            },
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if let Some(rec) = active.take() {
        stop_gracefully(&rec.pipeline);
    }
}

#[cfg(test)]
mod tests {
    use super::safe_target_path;

    #[test]
    fn plain_name_gets_media_dir_prefix_and_mkv_extension() {
        let path = safe_target_path("/data", "clip1").unwrap();
        assert_eq!(path, std::path::PathBuf::from("/data/clip1.mkv"));
    }

    #[test]
    fn existing_extension_is_kept() {
        let path = safe_target_path("/data", "clip1.mkv").unwrap();
        assert_eq!(path, std::path::PathBuf::from("/data/clip1.mkv"));
    }

    #[test]
    fn parent_dir_traversal_is_rejected() {
        assert!(safe_target_path("/data", "../../etc/passwd").is_err());
    }

    #[test]
    fn absolute_path_is_rejected() {
        assert!(safe_target_path("/data", "/etc/passwd").is_err());
    }

    #[test]
    fn empty_name_is_rejected() {
        assert!(safe_target_path("/data", "").is_err());
    }
}
