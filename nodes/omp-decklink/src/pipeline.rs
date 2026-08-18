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
//! Property und bricht den gesamten Pipeline-Parse. `Config::audio_
//! channels` wird deshalb VOR dem Pipeline-Aufbau validiert (`PipelineError`
//! statt eines stillen Fallbacks).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};
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

pub struct Config {
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
    /// Eigenschaft hier über `PipelineHandle::signal()` genutzt statt
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
    fn build(config: &Config) -> Result<Self, PipelineError> {
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
pub struct PipelineHandle {
    decklinkvideosrc: gst::Element,
    video_flowed: Arc<AtomicBool>,
}

impl PipelineHandle {
    /// Ob mindestens ein echter Video-Buffer geflossen ist — genutzt als
    /// `MediaReadySource::Probe` (wie `omp-source`).
    pub fn media_ready(&self) -> bool {
        self.video_flowed.load(Ordering::Relaxed)
    }

    pub fn signal(&self) -> bool {
        self.decklinkvideosrc.property::<bool>("signal")
    }
}

pub fn run(
    config: Config,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
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

    let _ = ready.send(Ok(PipelineHandle {
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
