//! GStreamer-Pipeline des Playout-Node. Video läuft über einen `tee` in
//! zwei Zweige: ein `fakesink` (FPS-Messung/Health, `UMSETZUNG.md` C2)
//! und der RTP-Netzausgang (`omp_mediaio::rtp::RtpVideoOutput`,
//! `UMSETZUNG.md` C3) — beide bleiben unabhängig davon bestehen, ob IS-05
//! den Netzausgang gerade scharf geschaltet hat. Audio bleibt vorerst nur
//! `fakesink` (kein Netzausgang gefordert, siehe C3-Verifikationstext).
//! Läuft bewusst auf einem eigenen `std::thread` (nicht in der
//! Tokio-Runtime des SDK) — GStreamers Bus-Polling ist blockierend, das
//! soll die async Registrierungs-/Heartbeat-Schleife nicht stören.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::rtp::RtpVideoOutput;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

/// Konfiguration der Testsignal-Elemente — über Env konfigurierbar, damit
/// die C2-Verifikation ("ungültiges Element per Env") ohne Code-Änderung
/// einen Fehler provozieren kann.
pub struct Config {
    pub video_element: String,
    pub audio_element: String,
    pub framerate_numerator: i32,
    pub framerate_denominator: i32,
    pub initial_destination_host: String,
    pub initial_destination_port: u16,
}

/// Ereignis, das der Pipeline-Thread an den async Node-Lifecycle meldet.
pub enum Event {
    /// Über das letzte Poll-Intervall gemessene Video-Bildrate (Buffer/s
    /// am Video-Fakesink).
    Fps(f64),
    /// Ein Pipeline-Fehler (Konstruktion oder Bus-ERROR-Message) — wird
    /// vom Aufrufer als NATS-Alarm veröffentlicht.
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
    video_buffers: Arc<AtomicU64>,
    rtp_output: Arc<RtpVideoOutput>,
}

impl Pipeline {
    fn build(config: &Config) -> Result<Self, PipelineError> {
        gst::init().map_err(|e| PipelineError(format!("gst init failed: {e}")))?;

        let pipeline = gst::Pipeline::new();

        let videosrc = gst::ElementFactory::make(&config.video_element)
            .name("videosrc")
            .build()
            .map_err(|e| PipelineError(format!("video-element '{}': {e}", config.video_element)))?;
        let video_caps = gst::ElementFactory::make("capsfilter")
            .name("video_caps")
            .property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field(
                        "framerate",
                        gst::Fraction::new(
                            config.framerate_numerator,
                            config.framerate_denominator,
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
            .map_err(|e| PipelineError(format!("fakesink (video): {e}")))?;

        let rtp_queue = gst::ElementFactory::make("queue")
            .build()
            .map_err(|e| PipelineError(format!("queue (rtp): {e}")))?;

        let audiosrc = gst::ElementFactory::make(&config.audio_element)
            .name("audiosrc")
            .build()
            .map_err(|e| PipelineError(format!("audio-element '{}': {e}", config.audio_element)))?;
        let audiosink = gst::ElementFactory::make("fakesink")
            .name("audiosink")
            .property("sync", true)
            .build()
            .map_err(|e| PipelineError(format!("fakesink (audio): {e}")))?;

        pipeline
            .add(&videosrc)
            .and_then(|()| pipeline.add(&video_caps))
            .and_then(|()| pipeline.add(&tee))
            .and_then(|()| pipeline.add(&fps_queue))
            .and_then(|()| pipeline.add(&videosink))
            .and_then(|()| pipeline.add(&rtp_queue))
            .and_then(|()| pipeline.add(&audiosrc))
            .and_then(|()| pipeline.add(&audiosink))
            .map_err(|e| PipelineError(format!("add elements: {e}")))?;

        gst::Element::link_many([&videosrc, &video_caps, &tee])
            .map_err(|e| PipelineError(format!("link video source chain: {e}")))?;
        gst::Element::link_many([&tee, &fps_queue, &videosink])
            .map_err(|e| PipelineError(format!("link video fps/health branch: {e}")))?;
        gst::Element::link_many([&tee, &rtp_queue])
            .map_err(|e| PipelineError(format!("link video rtp branch: {e}")))?;
        gst::Element::link_many([&audiosrc, &audiosink])
            .map_err(|e| PipelineError(format!("link audio chain: {e}")))?;

        let rtp_output = RtpVideoOutput::new(
            &pipeline,
            &rtp_queue,
            &config.initial_destination_host,
            config.initial_destination_port,
            config.framerate_numerator,
            config.framerate_denominator,
        )
        .map_err(PipelineError)?;

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
            video_buffers,
            rtp_output: Arc::new(rtp_output),
        })
    }

    /// Wartet bis zu `timeout` auf eine Bus-ERROR-Message.
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

    /// Liest den Video-Buffer-Zähler seit dem letzten Aufruf und setzt ihn
    /// zurück — bei Aufruf im ~1s-Takt ergibt das direkt die Bildrate.
    fn take_video_fps(&self) -> f64 {
        self.video_buffers.swap(0, Ordering::Relaxed) as f64
    }

    fn shutdown(&self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Baut und betreibt die Pipeline bis `shutdown` gesetzt wird oder ein
/// Bus-Fehler auftritt; meldet FPS/Fehler über `tx`. Meldet den
/// RTP-Ausgang (oder den Baufehler) einmalig über `ready`, sobald bekannt
/// — der Aufrufer (async Haupt-Task) braucht ihn, um die IS-05-Sender-
/// Connection zu verdrahten, bevor die Node-Registrierung läuft. Für
/// einen eigenen Thread gedacht (siehe Modul-Doku).
pub fn run(
    config: Config,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<Arc<RtpVideoOutput>, String>>,
) {
    let pipeline = match Pipeline::build(&config) {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.send(Event::Error(e.to_string()));
            let _ = ready.send(Err(e.to_string()));
            return;
        }
    };

    let _ = ready.send(Ok(pipeline.rtp_output.clone()));

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
