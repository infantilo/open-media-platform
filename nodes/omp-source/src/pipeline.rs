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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub const WIDTH: u32 = 640;
pub const HEIGHT: u32 = 480;
pub const FRAMERATE_NUMERATOR: u32 = 25;
pub const FRAMERATE_DENOMINATOR: u32 = 1;
pub const SAMPLE_RATE: u32 = 48000;
pub const CHANNELS: u32 = 2;
/// Fixer Begleitton — akustisch unterscheidbar von den 220 Hz-Vielfachen,
/// die C11/C12s dynamisch angelegte Kanäle/Items verwenden, damit ein
/// Source-Testton im Mix erkennbar bleibt.
const TONE_FREQ_HZ: f64 = 330.0;

pub struct Config {
    pub domain: String,
    pub flow_id: String,
    pub audio_flow_id: String,
    pub label: String,
    pub initial_pattern: String,
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
    _mxl_output: MxlVideoOutput,
    _mxl_audio_output: MxlAudioOutput,
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
                    .field("width", WIDTH as i32)
                    .field("height", HEIGHT as i32)
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

        pipeline
            .add(&videotestsrc)
            .and_then(|()| pipeline.add(&caps))
            .and_then(|()| pipeline.add(&tee))
            .and_then(|()| pipeline.add(&fps_queue))
            .and_then(|()| pipeline.add(&videosink))
            .and_then(|()| pipeline.add(&mxl_queue))
            .map_err(|e| PipelineError(format!("add elements: {e}")))?;

        gst::Element::link_many([&videotestsrc, &caps, &tee])
            .map_err(|e| PipelineError(format!("link video source chain: {e}")))?;
        gst::Element::link_many([&tee, &fps_queue, &videosink])
            .map_err(|e| PipelineError(format!("link fps branch: {e}")))?;
        gst::Element::link_many([&tee, &mxl_queue])
            .map_err(|e| PipelineError(format!("link mxl branch: {e}")))?;

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
            WIDTH,
            HEIGHT,
            FRAMERATE_NUMERATOR,
            FRAMERATE_DENOMINATOR,
        )
        .map_err(PipelineError)?;
        mxl_output.set_active(true);

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
        let counter = video_buffers.clone();
        let video_sink_pad = videosink
            .static_pad("sink")
            .expect("fakesink has a sink pad");
        video_sink_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            counter.fetch_add(1, Ordering::Relaxed);
            gst::PadProbeReturn::Ok
        });

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| PipelineError(format!("set state playing: {e}")))?;

        Ok(Pipeline {
            pipeline,
            videotestsrc,
            video_buffers,
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

    fn take_video_fps(&self) -> f64 {
        self.video_buffers.swap(0, Ordering::Relaxed) as f64
    }

    fn shutdown(&self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Griff auf die laufende Pipeline für den async Node-Lifecycle: erlaubt,
/// `pattern` live zu ändern (Property-Set, kein Pipeline-Neuaufbau).
#[derive(Clone)]
pub struct PipelineHandle {
    videotestsrc: gst::Element,
}

impl PipelineHandle {
    pub fn set_pattern(&self, pattern: &str) {
        self.videotestsrc.set_property_from_str("pattern", pattern);
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
