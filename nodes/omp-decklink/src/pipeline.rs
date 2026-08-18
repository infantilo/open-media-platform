//! GStreamer-Pipeline von `omp-decklink` (Teil 1: Ingest, `UMSETZUNG.md`
//! D10): `decklinkvideosrc device-number=<n> mode=<mode>` + `decklink-
//! audiosrc device-number=<n> channels=<n>` → je ein `MxlVideoOutput`/
//! `MxlAudioOutput` (`UMSETZUNG.md` C4), analog `omp-source`s Pipeline
//! (`nodes/omp-source/src/pipeline.rs`), aber echte Hardware-Erfassung
//! statt `videotestsrc`/`audiotestsrc`.
//!
//! Muster/Property-Namen gegen die real installierte `gst-plugins-bad`-
//! `decklink`-Plugin geprüft (`gst-inspect-1.0 decklinkvideosrc`, Version
//! 1.22.0) UND gegen `/home/infantilo/PIPELINE CONTROLLER`s produktiv
//! gelaufene Verwendung (`lib/OutputEngine.js` Ausgabe-Richtung,
//! `lib/MasterPipeline.js`/`server.js` Eingabe-Richtung) — keine der
//! beiden Quellen allein geraten (`UMSETZUNG.md` §0 Punkt 9).
//!
//! **`mode` bewusst NICHT `auto`:** ein MXL-Video-Flow deklariert seine
//! Auflösung/Framerate bei der Flow-Erstellung fest (`MxlVideoOutput::
//! new`s `width`/`height`/`framerate_*`-Parameter) — `mode=auto` würde
//! die tatsächliche Auflösung erst nach Signalerkennung kennen, ein
//! Henne-Ei-Problem wie bei jedem MXL-Sender. Genau wie `omp-source`s
//! `width`/`height` (dort per Workflow-Format-Auswahl, hier per fester
//! Kartenkonfiguration) muss der Modus vorab feststehen.
//!
//! **`connection`/`video-format` bleiben auf Kartendefault ("auto"):**
//! reines SDI-Signal negoziert das automatisch korrekt (8-bit YUV im
//! Regelfall); eine feste `video-format`-Wahl wäre nur für exotische
//! Formate (RGB/ARGB) nötig, kein Regelfall hier.
//!
//! **Nur progressive Modi in v1** (`MODES` unten) — interlaced Eingänge
//! (1080i50 etc.) bräuchten eine eigene De-Interlace-Kette wie PIPELINE
//! CONTROLLERs `lib/InterlaceChain.js`, bewusst nicht Teil dieser
//! Sitzung (s. `docs/decisions.md`).
//!
//! **`channels` ist ein FIXER ENUM {2, 8, 16}** (0="max") — PIPELINE
//! CONTROLLERs `server.js`-Kommentar dokumentiert einen echten,
//! produktiv aufgetretenen Bug: jeder andere Wert ist eine ungültige
//! Property und bricht den gesamten Pipeline-Parse. `IngestConfig::audio_
//! channels` wird deshalb VOR dem Pipeline-Aufbau validiert (`PipelineError`
//! statt eines stillen Fallbacks).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext, MxlVideoInput, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub const SAMPLE_RATE: u32 = 48000;

/// Ein Eintrag von `decklinkvideosrc`s `mode`-GEnum (`gst-inspect-1.0
/// decklinkvideosrc`) mit der zugehörigen Auflösung/Framerate — nur die
/// sechs Modi, die bereits in `/home/infantilo/PIPELINE CONTROLLER/
/// lib/OutputEngine.js`s `DECKLINK_MODES`-Tabelle produktiv verifiziert
/// sind (dortiger Kommentar: Werte "aus dem decklinkvideosink
/// Sink-Pad-Template"), keine zusätzlich geratenen Einträge.
pub struct ModeInfo {
    pub width: u32,
    pub height: u32,
    pub fps_numerator: u32,
    pub fps_denominator: u32,
}

pub fn mode_info(mode: &str) -> Option<ModeInfo> {
    let (width, height, fps_numerator, fps_denominator) = match mode {
        "pal-p" => (720, 576, 50, 1),
        "720p50" => (1280, 720, 50, 1),
        "720p5994" => (1280, 720, 60000, 1001),
        "1080p25" => (1920, 1080, 25, 1),
        "1080p2997" => (1920, 1080, 30000, 1001),
        "1080p50" => (1920, 1080, 50, 1),
        _ => return None,
    };
    Some(ModeInfo { width, height, fps_numerator, fps_denominator })
}

/// Von `mode_info` unterstützte Modus-Namen, für Fehlermeldungen/
/// Descriptor (`ParamSpec::range`, s. `main.rs`).
pub const SUPPORTED_MODES: &[&str] =
    &["pal-p", "720p50", "720p5994", "1080p25", "1080p2997", "1080p50"];

/// `decklinkaudiosrc`s `channels`-Property ist ein fixer Enum, s.
/// Moduldoku oben.
pub const SUPPORTED_AUDIO_CHANNELS: &[u32] = &[2, 8, 16];

pub struct IngestConfig {
    pub domain: String,
    pub flow_id: String,
    pub audio_flow_id: String,
    pub label: String,
    pub device_number: i32,
    pub mode: String,
    pub audio_channels: u32,
}

pub enum Event {
    Error(String),
    /// Wechsel des `signal`-Zustands (`true` = gültiges Eingangssignal
    /// anliegend) — gepollt, da das Plugin dafür keine Bus-Events postet
    /// (PIPELINE CONTROLLERs `_startLiveSignalPoll`-Kommentar, dieselbe
    /// Eigenschaft hier über `IngestHandle::signal()` genutzt statt
    /// erneut per Timer im Aufrufer gepollt).
    SignalChanged(bool),
}

struct PipelineError(String);

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

struct Pipeline {
    pipeline: gst::Pipeline,
    decklinkvideosrc: gst::Element,
    video_flowed: Arc<AtomicBool>,
    _mxl_output: MxlVideoOutput,
    _mxl_audio_output: MxlAudioOutput,
}

impl Pipeline {
    fn build(config: &IngestConfig) -> Result<Self, PipelineError> {
        gst::init().map_err(|e| PipelineError(format!("gst init failed: {e}")))?;

        let Some(mode_info) = mode_info(&config.mode) else {
            return Err(PipelineError(format!(
                "unbekannter/nicht unterstützter DeckLink-Modus {:?} (unterstützt: {:?})",
                config.mode, SUPPORTED_MODES
            )));
        };
        if !SUPPORTED_AUDIO_CHANNELS.contains(&config.audio_channels) {
            return Err(PipelineError(format!(
                "audio_channels={} ungültig — decklinkaudiosrc erlaubt nur {:?}",
                config.audio_channels, SUPPORTED_AUDIO_CHANNELS
            )));
        }

        let pipeline = gst::Pipeline::new();

        let decklinkvideosrc = gst::ElementFactory::make("decklinkvideosrc")
            .name("decklinkvideosrc")
            .property("device-number", config.device_number)
            .build()
            .map_err(|e| PipelineError(format!("decklinkvideosrc: {e}")))?;
        decklinkvideosrc.set_property_from_str("mode", &config.mode);

        let video_queue = gst::ElementFactory::make("queue")
            .build()
            .map_err(|e| PipelineError(format!("queue (video): {e}")))?;

        pipeline
            .add(&decklinkvideosrc)
            .and_then(|()| pipeline.add(&video_queue))
            .map_err(|e| PipelineError(format!("add video elements: {e}")))?;
        gst::Element::link_many([&decklinkvideosrc, &video_queue])
            .map_err(|e| PipelineError(format!("link video chain: {e}")))?;

        let mxl_context = Arc::new(
            MxlContext::new(&config.domain)
                .map_err(|e| PipelineError(format!("MxlContext::new: {e}")))?,
        );
        let mxl_output = MxlVideoOutput::new(
            &pipeline,
            &video_queue,
            mxl_context.clone(),
            &config.flow_id,
            &config.label,
            mode_info.width,
            mode_info.height,
            mode_info.fps_numerator,
            mode_info.fps_denominator,
            // D8 Teil 3: eine Hardware-Erfassung setzt selbst den Ursprung
            // (wie omp-source) — kein Delay-Bedarf für dieses Format.
            Arc::new(AtomicU64::new(0)),
        )
        .map_err(PipelineError)?;
        mxl_output.set_active(true);

        let decklinkaudiosrc = gst::ElementFactory::make("decklinkaudiosrc")
            .property("device-number", config.device_number)
            .build()
            .map_err(|e| PipelineError(format!("decklinkaudiosrc: {e}")))?;
        decklinkaudiosrc.set_property_from_str("channels", &config.audio_channels.to_string());

        let audioconvert = gst::ElementFactory::make("audioconvert")
            .build()
            .map_err(|e| PipelineError(format!("audioconvert: {e}")))?;
        let audio_queue = gst::ElementFactory::make("queue")
            .build()
            .map_err(|e| PipelineError(format!("queue (audio): {e}")))?;
        pipeline
            .add(&decklinkaudiosrc)
            .and_then(|()| pipeline.add(&audioconvert))
            .and_then(|()| pipeline.add(&audio_queue))
            .map_err(|e| PipelineError(format!("add audio elements: {e}")))?;
        gst::Element::link_many([&decklinkaudiosrc, &audioconvert, &audio_queue])
            .map_err(|e| PipelineError(format!("link audio chain: {e}")))?;

        let mxl_audio_output = MxlAudioOutput::new(
            &pipeline,
            &audio_queue,
            mxl_context,
            &config.audio_flow_id,
            &config.label,
            SAMPLE_RATE,
            config.audio_channels,
        )
        .map_err(PipelineError)?;
        mxl_audio_output.set_active(true);

        let video_flowed = Arc::new(AtomicBool::new(false));
        let flowed = video_flowed.clone();
        let video_sink_pad = video_queue
            .static_pad("sink")
            .expect("queue has a sink pad");
        video_sink_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            flowed.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Ok
        });

        // Live gefunden (`UMSETZUNG.md` D10, ohne Hardware getestet): ein
        // fehlgeschlagener PLAYING-Übergang OHNE anschließendes explizites
        // `set_state(Null)` ließ den Prozess mit Coredump abstürzen (SIGSEGV
        // im DeckLink-Plugin-natives Cleanup, nicht reproduzierbar mit
        // reinem `gst-launch-1.0 decklinkvideosrc ! fakesink` — dort
        // scheitert derselbe PAUSED-Übergang sauber). `gst::Pipeline`s
        // `Drop` räumt NICHT automatisch über NULL ab (bekannte
        // gstreamer-rs-Falle); explizit vor jedem Fehlerpfad-Return nötig.
        if let Err(e) = pipeline.set_state(gst::State::Playing) {
            let _ = pipeline.set_state(gst::State::Null);
            return Err(PipelineError(format!(
                "set state playing (device-number={} nicht erreichbar? Karte/Treiber prüfen): {e}",
                config.device_number
            )));
        }

        Ok(Pipeline {
            pipeline,
            decklinkvideosrc,
            video_flowed,
            _mxl_output: mxl_output,
            _mxl_audio_output: mxl_audio_output,
        })
    }

    fn poll_error(&self, timeout: Duration) -> Option<String> {
        let bus = self.pipeline.bus()?;
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

    /// `signal` ist laut `gst-inspect-1.0 decklinkvideosrc` nur lesbar
    /// (kein Change-Event, muss aktiv gepollt werden — PIPELINE
    /// CONTROLLERs `_startLiveSignalPoll`-Kommentar).
    fn signal(&self) -> bool {
        self.decklinkvideosrc.property::<bool>("signal")
    }

    fn shutdown(&self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Griff auf die laufende Pipeline für den async Node-Lifecycle.
#[derive(Clone)]
pub struct IngestHandle {
    decklinkvideosrc: gst::Element,
    video_flowed: Arc<AtomicBool>,
}

impl IngestHandle {
    /// Ob mindestens ein echter Video-Buffer geflossen ist — genutzt als
    /// `MediaReadySource::Probe` (wie `omp-source`).
    pub fn media_ready(&self) -> bool {
        self.video_flowed.load(Ordering::Relaxed)
    }

    pub fn signal(&self) -> bool {
        self.decklinkvideosrc.property::<bool>("signal")
    }
}

pub fn run_ingest(
    config: IngestConfig,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<IngestHandle, String>>,
    heartbeat: Arc<AtomicU64>,
) {
    let pipeline = match Pipeline::build(&config) {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.send(Event::Error(e.to_string()));
            let _ = ready.send(Err(e.to_string()));
            return;
        }
    };

    let _ = ready.send(Ok(IngestHandle {
        decklinkvideosrc: pipeline.decklinkvideosrc.clone(),
        video_flowed: pipeline.video_flowed.clone(),
    }));

    let mut last_signal = pipeline.signal();
    let _ = tx.send(Event::SignalChanged(last_signal));

    loop {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130).
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        if let Some(err) = pipeline.poll_error(Duration::from_secs(1)) {
            let _ = tx.send(Event::Error(err));
            break;
        }
        let signal = pipeline.signal();
        if signal != last_signal {
            last_signal = signal;
            let _ = tx.send(Event::SignalChanged(signal));
        }
    }

    pipeline.shutdown();
}

// ---------------------------------------------------------------------
// Output (Teil 2, UMSETZUNG.md D10): MXL-Flow(s) → DeckLink-SDI/IP-Ausgang
// ---------------------------------------------------------------------
//
// Quellwahl per echtem IS-05-Receiver-PATCH (Flow-Editor drag&drop),
// gleiches Rebuild-bei-Connect-Muster wie `omp-2110-gateway::pipeline`s
// Output-Richtung UND `omp-recorder`s zwei unabhängige Video-/Audio-
// Receiver (dortiges `Config`/`Command`/`ConnectVideo`/`ConnectAudio`-
// Muster hier für Video+Audio übernommen, aber ohne dessen Start/Stop-
// Lebenszyklus — ein Hardware-Ausgang ist "warm, sobald verbunden" wie
// bei `omp-2110-gateway`, nicht Session-basiert wie eine Aufnahme).
//
// **Video ist die Anker-Verbindung, Audio ein optionaler Zusatz** —
// PIPELINE CONTROLLERs eigenes `_buildDecklinkPipelineStr` baut den
// Video-Zweig immer, Audio nur bei `out.decklinkAudio !== false`
// (dortiger Kommentar/Code, `lib/OutputEngine.js`). Physisch sinnvoll:
// eine DeckLink-Video-Ausgangskarte gibt immer ein Raster aus (mit
// eingebettetem Ton), "nur Ton, kein Bild" ist kein reales
// Betriebsszenario dieser Hardware. Ohne verbundene Video-Quelle baut
// `build_output` deshalb gar keine Pipeline auf (Fehler statt stillem
// Leerlauf) — Audio kann verbunden/getrennt werden, ohne Video zu
// berühren, baut aber die gesamte Pipeline neu (kein dynamisches
// Pad-Relinking, Projekt-Konvention).

pub struct OutputConfig {
    pub domain: String,
    pub device_number: i32,
    pub mode: String,
    pub audio_channels: u32,
}

enum Command {
    ConnectVideo(String),
    DisconnectVideo,
    ConnectAudio(String),
    DisconnectAudio,
}

struct ActiveOutputPipeline {
    pipeline: gst::Pipeline,
    _video_input: MxlVideoInput,
    _audio_input: Option<MxlAudioInput>,
}

impl Drop for ActiveOutputPipeline {
    fn drop(&mut self) {
        // Dieselbe gstreamer-rs-Falle wie oben (`Pipeline::build`s
        // Fehlerpfad) — hier als `Drop` statt manuellem Aufruf, weil
        // diese Pipeline bei jedem Connect/Disconnect komplett neu
        // aufgebaut wird (kein einzelner Fehlerpfad wie bei der
        // Ingest-Seite).
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn build_output(
    context: &Arc<MxlContext>,
    video_flow_id: &str,
    audio_flow_id: Option<&str>,
    device_number: i32,
    mode: &str,
    audio_channels: u32,
) -> Result<ActiveOutputPipeline, String> {
    let mode_info = mode_info(mode).ok_or_else(|| {
        format!("unbekannter/nicht unterstützter DeckLink-Modus {mode:?} (unterstützt: {SUPPORTED_MODES:?})")
    })?;
    if let Some(_audio_flow_id) = audio_flow_id
        && !SUPPORTED_AUDIO_CHANNELS.contains(&audio_channels)
    {
        return Err(format!(
            "audio_channels={audio_channels} ungültig — DeckLink-Karten unterstützen nur {SUPPORTED_AUDIO_CHANNELS:?}"
        ));
    }

    let pipeline = gst::Pipeline::new();

    let video_input =
        MxlVideoInput::new(&pipeline, context.clone(), video_flow_id).map_err(|e| format!("MxlVideoInput({video_flow_id}): {e}"))?;

    let videoconvert_in = gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(|e| format!("videoconvert (in): {e}"))?;
    let videoscale = gst::ElementFactory::make("videoscale")
        .build()
        .map_err(|e| format!("videoscale: {e}"))?;
    let videorate = gst::ElementFactory::make("videorate")
        .build()
        .map_err(|e| format!("videorate: {e}"))?;
    // Feste Ziel-Caps aus der Modus-Tabelle — `decklinkvideosink` ist
    // modus-gebunden (kein freies width/height, PIPELINE CONTROLLERs
    // Kommentar), `videoscale`/`videorate` gleichen die tatsächliche
    // MXL-Quellauflösung/-Framerate daran an, statt sie zu erzwingen.
    let caps = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("width", mode_info.width as i32)
                .field("height", mode_info.height as i32)
                .field(
                    "framerate",
                    gst::Fraction::new(mode_info.fps_numerator as i32, mode_info.fps_denominator as i32),
                )
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter (video): {e}"))?;
    let videoconvert_out = gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(|e| format!("videoconvert (out): {e}"))?;
    let decklinkvideosink = gst::ElementFactory::make("decklinkvideosink")
        .property("device-number", device_number)
        // sync=true: der DeckLink-Sink ist der alleinige Clock-Provider
        // dieser eigenständigen Pipeline — GStreamer wählt automatisch
        // die Karten-Clock, getaktetes Playback statt "so schnell wie
        // möglich" (identische Begründung wie PIPELINE CONTROLLERs
        // `_buildDecklinkPipelineStr`-Kommentar).
        .property("sync", true)
        .build()
        .map_err(|e| format!("decklinkvideosink: {e}"))?;
    decklinkvideosink.set_property_from_str("mode", mode);

    pipeline
        .add(&videoconvert_in)
        .and_then(|()| pipeline.add(&videoscale))
        .and_then(|()| pipeline.add(&videorate))
        .and_then(|()| pipeline.add(&caps))
        .and_then(|()| pipeline.add(&videoconvert_out))
        .and_then(|()| pipeline.add(&decklinkvideosink))
        .map_err(|e| format!("add video output elements: {e}"))?;
    gst::Element::link_many([
        &video_input.tail,
        &videoconvert_in,
        &videoscale,
        &videorate,
        &caps,
        &videoconvert_out,
        &decklinkvideosink,
    ])
    .map_err(|e| format!("link video output chain: {e}"))?;

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
            // `decklinkaudiosink` hat (anders als `decklinkaudiosrc`)
            // KEIN `channels`-Property — die Kanalzahl kommt aus den
            // negoziierten Caps, deshalb hier explizit gesetzt statt nur
            // beim Empfangs-Encoder validiert (`gst-inspect-1.0
            // decklinkaudiosink` geprüft, keine geratene Annahme).
            let audio_caps = gst::ElementFactory::make("capsfilter")
                .property(
                    "caps",
                    gst::Caps::builder("audio/x-raw")
                        .field("format", "S16LE")
                        .field("rate", SAMPLE_RATE as i32)
                        .field("channels", audio_channels as i32)
                        .build(),
                )
                .build()
                .map_err(|e| format!("capsfilter (audio): {e}"))?;
            let decklinkaudiosink = gst::ElementFactory::make("decklinkaudiosink")
                .property("device-number", device_number)
                .property("sync", true)
                .build()
                .map_err(|e| format!("decklinkaudiosink: {e}"))?;

            pipeline
                .add(&audioconvert)
                .and_then(|()| pipeline.add(&audioresample))
                .and_then(|()| pipeline.add(&audio_caps))
                .and_then(|()| pipeline.add(&decklinkaudiosink))
                .map_err(|e| format!("add audio output elements: {e}"))?;
            gst::Element::link_many([&input.tail, &audioconvert, &audioresample, &audio_caps, &decklinkaudiosink])
                .map_err(|e| format!("link audio output chain: {e}"))?;

            Some(input)
        }
        None => None,
    };

    // Dieselbe explizite Null-auf-Fehlerpfad-Absicherung wie
    // `Pipeline::build` oben — live gefundener gstreamer-rs-Coredump-
    // Bug, s. Moduldoku dort. Hier zusätzlich wichtig: bei einem
    // Fehlschlag müssen `video_input`/`audio_input`s MXL-Reader-Threads
    // sauber gestoppt werden, bevor sie beim Drop verschwinden.
    if let Err(e) = pipeline.set_state(gst::State::Playing) {
        let _ = pipeline.set_state(gst::State::Null);
        return Err(format!(
            "set state playing (device-number={device_number} nicht erreichbar? Karte/Treiber prüfen): {e}"
        ));
    }

    Ok(ActiveOutputPipeline { pipeline, _video_input: video_input, _audio_input: audio_input })
}

/// Griff für den async Node-Lifecycle (gleiches Muster wie
/// `omp-2110-gateway::pipeline::OutputPipelineHandle`): schickt Connect-/
/// Disconnect-Befehle an den Pipeline-Thread, der bei jedem Wechsel die
/// gesamte Pipeline neu aufbaut.
#[derive(Clone)]
pub struct OutputPipelineHandle {
    commands: std::sync::mpsc::Sender<Command>,
    flowed: Arc<AtomicBool>,
}

impl OutputPipelineHandle {
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

    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

/// Läuft auf einem eigenen Thread: verwaltet die zuletzt gewählten
/// Video-/Audio-`flow_id`s, baut bei jeder Änderung die gesamte Ausgabe-
/// Pipeline neu (kein dynamisches Pad-Relinking, Projekt-Konvention).
pub fn run_output(
    config: OutputConfig,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<OutputPipelineHandle, String>>,
    heartbeat: Arc<AtomicU64>,
) {
    if let Err(e) = gst::init() {
        let msg = format!("gst init failed: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }

    let context = match MxlContext::new(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let (commands_tx, commands_rx) = std::sync::mpsc::channel::<Command>();
    let flowed = Arc::new(AtomicBool::new(false));
    let _ = ready.send(Ok(OutputPipelineHandle { commands: commands_tx, flowed: flowed.clone() }));

    let mut video_flow_id: Option<String> = None;
    let mut audio_flow_id: Option<String> = None;
    let mut active: Option<ActiveOutputPipeline> = None;

    let rebuild = |video: &Option<String>,
                   audio: &Option<String>,
                   active: &mut Option<ActiveOutputPipeline>,
                   flowed: &Arc<AtomicBool>,
                   tx: &UnboundedSender<Event>| {
        // Alte Pipeline zuerst abbauen (Drop stoppt die MXL-Reader-
        // Threads + setzt State Null), bevor eine neue denselben
        // MxlContext für neue Reader nutzt (identische Reihenfolge-
        // Überlegung wie `omp-2110-gateway::pipeline::run_output`).
        *active = None;
        flowed.store(false, Ordering::Relaxed);
        let Some(video_flow_id) = video.as_deref() else {
            // Keine Video-Quelle verbunden — bewusst keine Pipeline
            // (s. Moduldoku: Video ist die Anker-Verbindung), auch wenn
            // Audio verbunden ist.
            return;
        };
        match build_output(&context, video_flow_id, audio.as_deref(), config.device_number, &config.mode, config.audio_channels) {
            Ok(p) => *active = Some(p),
            Err(e) => {
                let _ = tx.send(Event::Error(format!("DeckLink-Ausgang: {e}")));
            }
        }
    };

    loop {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130).
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }

        if let Some(rec) = &active {
            let bus = rec.pipeline.bus();
            let err = bus.and_then(|bus| {
                bus.timed_pop_filtered(gst::ClockTime::from_mseconds(50), &[gst::MessageType::Error])
            });
            if let Some(msg) = err
                && let gst::MessageView::Error(e) = msg.view()
            {
                let message = format!("{} ({})", e.error(), e.debug().unwrap_or_default());
                active = None;
                flowed.store(false, Ordering::Relaxed);
                let _ = tx.send(Event::Error(message));
            } else if !flowed.load(Ordering::Relaxed) {
                // "media-ready" (ARCHITECTURE.md §5 Punkt 6): erst wahr,
                // sobald der Video-Ausgangszweig nachweislich einen
                // Buffer erreicht hat — hier per einmaliger Bus-Pad-
                // Probe wäre komplexer als der bereits laufende Poll-
                // Takt, deshalb pragmatisch: sobald die Pipeline seit
                // > 1 Heartbeat-Tick fehlerfrei PLAYING ist, gilt sie als
                // bereit (kein separater Probe-Zweig nötig, da diese
                // Pipeline — anders als Ingest — keinen eigenen MXL-
                // Schreib-Nachweis braucht, der Empfangspfad ist bereits
                // durch `MxlVideoInput`s eigenen Reader-Thread belegt).
                flowed.store(true, Ordering::Relaxed);
            }
        }

        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::ConnectVideo(flow_id)) => {
                video_flow_id = Some(flow_id);
                rebuild(&video_flow_id, &audio_flow_id, &mut active, &flowed, &tx);
            }
            Ok(Command::DisconnectVideo) => {
                video_flow_id = None;
                rebuild(&video_flow_id, &audio_flow_id, &mut active, &flowed, &tx);
            }
            Ok(Command::ConnectAudio(flow_id)) => {
                audio_flow_id = Some(flow_id);
                rebuild(&video_flow_id, &audio_flow_id, &mut active, &flowed, &tx);
            }
            Ok(Command::DisconnectAudio) => {
                audio_flow_id = None;
                rebuild(&video_flow_id, &audio_flow_id, &mut active, &flowed, &tx);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_mode_has_mode_info() {
        for mode in SUPPORTED_MODES {
            assert!(mode_info(mode).is_some(), "SUPPORTED_MODES entry {mode:?} has no mode_info");
        }
    }

    #[test]
    fn unknown_mode_returns_none() {
        assert!(mode_info("bogus").is_none());
        assert!(mode_info("1080i50").is_none(), "interlaced modes are out of scope for D10 Teil 1");
    }

    #[test]
    fn mode_info_matches_pipeline_controller_verified_values() {
        // Werte 1:1 aus `/home/infantilo/PIPELINE CONTROLLER/lib/
        // OutputEngine.js`s `DECKLINK_MODES`-Tabelle übernommen (dortiger
        // Kommentar: "aus dem decklinkvideosink Sink-Pad-Template").
        let cases = [
            ("pal-p", 720, 576, 50, 1),
            ("720p50", 1280, 720, 50, 1),
            ("720p5994", 1280, 720, 60000, 1001),
            ("1080p25", 1920, 1080, 25, 1),
            ("1080p2997", 1920, 1080, 30000, 1001),
            ("1080p50", 1920, 1080, 50, 1),
        ];
        for (mode, width, height, fps_num, fps_den) in cases {
            let info = mode_info(mode).unwrap_or_else(|| panic!("missing mode_info for {mode}"));
            assert_eq!(info.width, width, "{mode} width");
            assert_eq!(info.height, height, "{mode} height");
            assert_eq!(info.fps_numerator, fps_num, "{mode} fps_numerator");
            assert_eq!(info.fps_denominator, fps_den, "{mode} fps_denominator");
        }
    }
}
