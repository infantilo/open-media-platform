//! GStreamer-Pipeline von `omp-source`: `videotestsrc is-live=true
//! pattern=<p>` über einen `tee` in zwei Zweige — `fakesink` (FPS-Messung,
//! wie `playout`s C2-Muster) und `MxlVideoOutput` (`UMSETZUNG.md` C4).
//! Kein Valve/IS-05-Sender-Connection in v0 (Fable-Plan, `docs/decisions.md`
//! 2026-07-09): der Flow wird geschrieben, sobald die Pipeline läuft, ohne
//! extra Scharfschaltung — ein Test-Quell-Node hat nichts, das er "stumm"
//! schalten müsste, das nicht schon `omp-switcher`s Auswahl übernimmt.
//! `pattern` ist live per GStreamer-Property änderbar (keine Topologie-
//! Änderung, siehe `UMSETZUNG.md` C5).
//!
//! **Audio-Begleitton (nachgezogen, 2026-07-12):** ein zweiter, fester
//! `audiotestsrc`-Zweig läuft immer mit (kein Pattern-Wechsel wie beim
//! Video, ein Testton reicht als Software-Testmittel) und wird als
//! eigener MXL-Audio-Sender registriert — gleiches `MxlAudioOutput`-
//! Muster wie `omp-player`/`omp-audio-mixer` (C11/C12), damit z. B. der
//! Audiomischer echte externe Testquellen statt nur des internen
//! Testtons zur Auswahl hat.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

/// Fallback, falls `main.rs` keine `OMP_WIDTH`/`OMP_HEIGHT`-Umgebungs-
/// variable findet (Kapitel 15, docs/END-GOAL-FEATURES.md §15.3c,
/// 2026-07-17: Workflow-Auflösungs-Setting) — `Config::width`/`height`
/// tragen den tatsächlich verwendeten Wert, diese Konstanten sind nur
/// noch der Default dafür, keine feste Pipeline-Vorgabe mehr.
pub const DEFAULT_WIDTH: u32 = 640;
pub const DEFAULT_HEIGHT: u32 = 480;
pub const FRAMERATE_NUMERATOR: u32 = 25;
pub const FRAMERATE_DENOMINATOR: u32 = 1;
pub const SAMPLE_RATE: u32 = 48000;
pub const CHANNELS: u32 = 2;
/// Feste Lowres-Vorschau-Zielauflösung (Kapitel 15 Teil 2,
/// docs/END-GOAL-FEATURES.md §15.4, Entscheidung 2026-07-19: fest statt
/// pro Workflow konfigurierbar — kleinster Schritt, s.
/// `docs/decisions.md` Nachtrag 37).
pub const LOWRES_WIDTH: u32 = 320;
pub const LOWRES_HEIGHT: u32 = 180;
/// Fixer Begleitton — akustisch unterscheidbar von den 220 Hz-Vielfachen,
/// die C11/C12s dynamisch angelegte Kanäle/Items verwenden, damit ein
/// Source-Testton im Mix erkennbar bleibt.
const TONE_FREQ_HZ: f64 = 330.0;

pub struct Config {
    pub domain: String,
    pub flow_id: String,
    pub audio_flow_id: String,
    /// Kapitel 15 Teil 2 (docs/END-GOAL-FEATURES.md §15.4): zweiter,
    /// eigenständiger MXL-Flow in `LOWRES_WIDTH`×`LOWRES_HEIGHT` —
    /// dieselbe Flow-UUID-== MXL-flow-id-Konvention wie `flow_id`.
    pub lowres_flow_id: String,
    pub label: String,
    pub initial_pattern: String,
    pub width: u32,
    pub height: u32,
}

pub enum Event {
    Fps(f64),
    Error(String),
}

struct PipelineError(String);

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

struct Pipeline {
    pipeline: gst::Pipeline,
    videotestsrc: gst::Element,
    video_buffers: Arc<AtomicU64>,
    /// Sticky-Flag, einmalig gesetzt beim ersten beobachteten Video-Buffer
    /// — anders als `video_buffers` (bei jedem `take_video_fps()`-Aufruf
    /// zurückgesetzt) bleibt dies wahr, sobald die Pipeline nachweislich
    /// einmal Medien produziert hat. Grundlage des "media-ready"-Signals
    /// (`ARCHITECTURE.md` §5 Punkt 6, `UMSETZUNG.md` D5-prep) — misst nur
    /// den Video-Zweig (gleicher Umfang wie die bestehende FPS-Messung),
    /// der `tee` verteilt an den MXL-Zweig gleichzeitig, der Audio-Zweig
    /// wird nicht separat geprüft (dokumentierte Vereinfachung).
    video_flowed: Arc<AtomicBool>,
    _mxl_output: MxlVideoOutput,
    _mxl_audio_output: MxlAudioOutput,
    /// `Arc`, weil `PipelineHandle` (anderer Thread) darauf `set_active`
    /// aufrufen muss (Kapitel 15 Teil 2) — `Pipeline` selbst hält die
    /// zweite Referenz nur, damit der Writer-Thread/die MXL-Flow-
    /// Ressource am Leben bleibt (`Drop`), s. `_mxl_output` oben.
    lowres_output: Arc<MxlVideoOutput>,
    lowres_active_count: Arc<AtomicUsize>,
}

impl Pipeline {
    fn build(config: &Config) -> Result<Self, PipelineError> {
        gst::init().map_err(|e| PipelineError(format!("gst init failed: {e}")))?;

        let pipeline = gst::Pipeline::new();

        let videotestsrc = gst::ElementFactory::make("videotestsrc")
            .name("videotestsrc")
            .property("is-live", true)
            .build()
            .map_err(|e| PipelineError(format!("videotestsrc: {e}")))?;
        videotestsrc.set_property_from_str("pattern", &config.initial_pattern);

        let caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field("width", config.width as i32)
                    .field("height", config.height as i32)
                    .field(
                        "framerate",
                        gst::Fraction::new(
                            FRAMERATE_NUMERATOR as i32,
                            FRAMERATE_DENOMINATOR as i32,
                        ),
                    )
                    .build(),
            )
            .build()
            .map_err(|e| PipelineError(format!("capsfilter: {e}")))?;
        let tee = gst::ElementFactory::make("tee")
            .name("video_tee")
            .build()
            .map_err(|e| PipelineError(format!("tee: {e}")))?;

        let fps_queue = gst::ElementFactory::make("queue")
            .build()
            .map_err(|e| PipelineError(format!("queue: {e}")))?;
        let videosink = gst::ElementFactory::make("fakesink")
            .name("videosink")
            .property("sync", true)
            .build()
            .map_err(|e| PipelineError(format!("fakesink: {e}")))?;

        let mxl_queue = gst::ElementFactory::make("queue")
            .build()
            .map_err(|e| PipelineError(format!("queue (mxl): {e}")))?;
        let lowres_queue = gst::ElementFactory::make("queue")
            .build()
            .map_err(|e| PipelineError(format!("queue (lowres): {e}")))?;

        pipeline
            .add(&videotestsrc)
            .and_then(|()| pipeline.add(&caps))
            .and_then(|()| pipeline.add(&tee))
            .and_then(|()| pipeline.add(&fps_queue))
            .and_then(|()| pipeline.add(&videosink))
            .and_then(|()| pipeline.add(&mxl_queue))
            .and_then(|()| pipeline.add(&lowres_queue))
            .map_err(|e| PipelineError(format!("add elements: {e}")))?;

        gst::Element::link_many([&videotestsrc, &caps, &tee])
            .map_err(|e| PipelineError(format!("link video source chain: {e}")))?;
        gst::Element::link_many([&tee, &fps_queue, &videosink])
            .map_err(|e| PipelineError(format!("link fps branch: {e}")))?;
        gst::Element::link_many([&tee, &mxl_queue])
            .map_err(|e| PipelineError(format!("link mxl branch: {e}")))?;
        // Kapitel 15 Teil 2: dritter `tee`-Zweig für die Lowres-Vorschau —
        // `MxlVideoOutput::new` unten baut selbst `videoscale`/`videorate`/
        // `capsfilter` auf `LOWRES_WIDTH`×`LOWRES_HEIGHT` ein (s. dessen
        // Doku in `omp-mediaio::mxl`), hier reicht ein reiner `queue`-Tap.
        gst::Element::link_many([&tee, &lowres_queue])
            .map_err(|e| PipelineError(format!("link lowres branch: {e}")))?;

        let mxl_context = Arc::new(
            MxlContext::new(&config.domain)
                .map_err(|e| PipelineError(format!("MxlContext::new: {e}")))?,
        );
        let mxl_output = MxlVideoOutput::new(
            &pipeline,
            &mxl_queue,
            mxl_context.clone(),
            &config.flow_id,
            &config.label,
            config.width,
            config.height,
            FRAMERATE_NUMERATOR,
            FRAMERATE_DENOMINATOR,
        )
        .map_err(PipelineError)?;
        mxl_output.set_active(true);

        // Kapitel 15 Teil 2 (docs/END-GOAL-FEATURES.md §15.4,
        // docs/decisions.md Nachtrag 37): der Lowres-Sender wird bewusst
        // NICHT `set_active(true)` — der Valve bleibt in seinem
        // `MxlVideoOutput::new`-Default (`drop=true`) zu, bis
        // `PipelineHandle::activate_lowres_preview()` (referenzgezählt)
        // ihn öffnet ("nur bei aktivem Vorschau-Bedarf zugeschaltet",
        // Nutzerentscheidung). Der MXL-Flow selbst existiert/ist
        // registriert ab hier (SDK-Grenze, s. docs/decisions.md) — nur
        // das tatsächliche Schreiben von Grains ist gated.
        let lowres_output = Arc::new(
            MxlVideoOutput::new(
                &pipeline,
                &lowres_queue,
                mxl_context.clone(),
                &config.lowres_flow_id,
                &format!("{} Lowres", config.label),
                LOWRES_WIDTH,
                LOWRES_HEIGHT,
                FRAMERATE_NUMERATOR,
                FRAMERATE_DENOMINATOR,
            )
            .map_err(PipelineError)?,
        );

        let audiotestsrc = gst::ElementFactory::make("audiotestsrc")
            .property("is-live", true)
            .property("freq", TONE_FREQ_HZ)
            .property("volume", 0.3f64)
            .build()
            .map_err(|e| PipelineError(format!("audiotestsrc: {e}")))?;
        audiotestsrc.set_property_from_str("wave", "sine");
        let audioconvert = gst::ElementFactory::make("audioconvert")
            .build()
            .map_err(|e| PipelineError(format!("audioconvert: {e}")))?;
        pipeline
            .add(&audiotestsrc)
            .and_then(|()| pipeline.add(&audioconvert))
            .map_err(|e| PipelineError(format!("add audio elements: {e}")))?;
        gst::Element::link_many([&audiotestsrc, &audioconvert])
            .map_err(|e| PipelineError(format!("link audio chain: {e}")))?;

        let mxl_audio_output = MxlAudioOutput::new(
            &pipeline,
            &audioconvert,
            mxl_context,
            &config.audio_flow_id,
            &config.label,
            SAMPLE_RATE,
            CHANNELS,
        )
        .map_err(PipelineError)?;
        mxl_audio_output.set_active(true);

        let video_buffers = Arc::new(AtomicU64::new(0));
        let video_flowed = Arc::new(AtomicBool::new(false));
        let counter = video_buffers.clone();
        let flowed = video_flowed.clone();
        let video_sink_pad = videosink
            .static_pad("sink")
            .expect("fakesink has a sink pad");
        video_sink_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            counter.fetch_add(1, Ordering::Relaxed);
            flowed.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Ok
        });

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| PipelineError(format!("set state playing: {e}")))?;

        Ok(Pipeline {
            pipeline,
            videotestsrc,
            video_buffers,
            video_flowed,
            _mxl_output: mxl_output,
            _mxl_audio_output: mxl_audio_output,
            lowres_output,
            lowres_active_count: Arc::new(AtomicUsize::new(0)),
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

    fn take_video_fps(&self) -> f64 {
        self.video_buffers.swap(0, Ordering::Relaxed) as f64
    }

    fn shutdown(&self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Griff auf die laufende Pipeline für den async Node-Lifecycle: erlaubt,
/// `pattern` live zu ändern (Property-Set, kein Pipeline-Neuaufbau) und das
/// "media-ready"-Signal abzufragen (`ARCHITECTURE.md` §5 Punkt 6).
#[derive(Clone)]
pub struct PipelineHandle {
    videotestsrc: gst::Element,
    video_flowed: Arc<AtomicBool>,
    lowres_output: Arc<MxlVideoOutput>,
    lowres_active_count: Arc<AtomicUsize>,
}

impl PipelineHandle {
    pub fn set_pattern(&self, pattern: &str) {
        self.videotestsrc.set_property_from_str("pattern", pattern);
    }

    /// Ob mindestens ein echter Video-Buffer durch die Pipeline geflossen
    /// ist — genutzt als `MediaReadySource::Probe`, s. `main.rs`.
    pub fn media_ready(&self) -> bool {
        self.video_flowed.load(Ordering::Relaxed)
    }

    /// Aktiviert die Lowres-Vorschau referenzgezählt (Kapitel 15 Teil 2)
    /// — erst der Übergang 0→1 öffnet den Valve tatsächlich, jeder
    /// weitere Aufruf erhöht nur den Zähler. Mehrere gleichzeitige
    /// Vorschau-Konsumenten (z. B. künftig Bildmischer + Multiviewer,
    /// Teil 3) schließen den Valve dadurch erst, wenn wirklich niemand
    /// mehr zusieht.
    pub fn activate_lowres_preview(&self) {
        if self.lowres_active_count.fetch_add(1, Ordering::SeqCst) == 0 {
            self.lowres_output.set_active(true);
        }
    }

    /// Gibt eine Aktivierung wieder frei; schließt den Valve erst, wenn
    /// der Zähler auf 0 zurückfällt. Sättigt bei 0 statt zu unterlaufen
    /// (ein unbalancierter zusätzlicher `release`-Aufruf bleibt folgenlos
    /// statt den Zähler negativ/riesig zu wickeln).
    pub fn release_lowres_preview(&self) {
        let prev = self
            .lowres_active_count
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |c| {
                Some(c.saturating_sub(1))
            })
            .unwrap_or(0);
        if prev == 1 {
            self.lowres_output.set_active(false);
        }
    }

    pub fn lowres_preview_active(&self) -> bool {
        self.lowres_active_count.load(Ordering::SeqCst) > 0
    }
}

pub fn run(
    config: Config,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
) {
    let pipeline = match Pipeline::build(&config) {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.send(Event::Error(e.to_string()));
            let _ = ready.send(Err(e.to_string()));
            return;
        }
    };

    let _ = ready.send(Ok(PipelineHandle {
        videotestsrc: pipeline.videotestsrc.clone(),
        video_flowed: pipeline.video_flowed.clone(),
        lowres_output: pipeline.lowres_output.clone(),
        lowres_active_count: pipeline.lowres_active_count.clone(),
    }));

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        if let Some(err) = pipeline.poll_error(Duration::from_secs(1)) {
            let _ = tx.send(Event::Error(err));
            break;
        }
        let _ = tx.send(Event::Fps(pipeline.take_video_fps()));
    }

    pipeline.shutdown();
}
