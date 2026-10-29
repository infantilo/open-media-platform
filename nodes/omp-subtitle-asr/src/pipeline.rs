//! GStreamer-Pipeline von `omp-subtitle-asr`: liest einen per IS-05-Receiver gewählten MXL-Audio-Flow
//! (`omp_mediaio::mxl::MxlAudioInput`), mischt auf mono, wandelt auf 16 kHz und reicht die Samples als `i16` an den
//! Segmentierer weiter. Aufbau und Quellwechsel („Pipeline komplett neu statt Pad-Relinking“) wie `omp-audio-monitor::pipeline`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlAudioInput, MxlContext};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub struct Config {
    pub domain: String,
}

pub enum Event {
    Error(String),
}

/// Rückrufe in den Rest des Nodes.
pub struct Sinks {
    /// Neues PCM (16 kHz, mono) — läuft auf dem GStreamer-Streaming-Thread, darf nicht blockieren.
    pub on_pcm: Arc<dyn Fn(&[i16]) + Send + Sync>,
    /// Quelle getrennt/gewechselt: laufendes Segment abschließen.
    pub on_stop: Arc<dyn Fn() + Send + Sync>,
}

enum Command {
    Connect(String),
    Disconnect,
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    flowed: Arc<AtomicBool>,
}

impl PipelineHandle {
    pub fn connect(&self, flow_id: String) {
        self.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::Connect(flow_id));
    }

    pub fn disconnect(&self) {
        self.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::Disconnect);
    }

    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    _input: MxlAudioInput,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn build(context: &Arc<MxlContext>, flow_id: &str, sinks: &Sinks, flowed: Arc<AtomicBool>) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();
    {
        let diag_pipeline = pipeline.clone();
        omp_node_sdk::diag::register("main", Arc::new(move || omp_mediaio::diag::snapshot(&diag_pipeline)));
    }
    let input = MxlAudioInput::new(&pipeline, context.clone(), flow_id)?;

    let src_pad = input.tail.static_pad("src").expect("tail has a src pad");
    let flowed_probe = flowed.clone();
    src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        flowed_probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Remove
    });

    let make = |factory: &str| gst::ElementFactory::make(factory).build().map_err(|e| format!("{factory}: {e}"));
    let queue = make("queue")?;
    let convert = make("audioconvert")?;
    let resample = make("audioresample")?;
    let caps = gst::Caps::builder("audio/x-raw")
        .field("format", "S16LE")
        .field("rate", crate::segment::SAMPLE_RATE as i32)
        .field("channels", 1i32)
        .field("layout", "interleaved")
        .build();
    let capsfilter = gst::ElementFactory::make("capsfilter").property("caps", caps).build().map_err(|e| format!("capsfilter: {e}"))?;
    let appsink = gst::ElementFactory::make("appsink")
        .property("sync", false)
        .property("max-buffers", 64u32)
        .property("drop", false)
        .build()
        .map_err(|e| format!("appsink: {e}"))?;
    pipeline
        .add(&queue)
        .and_then(|()| pipeline.add(&convert))
        .and_then(|()| pipeline.add(&resample))
        .and_then(|()| pipeline.add(&capsfilter))
        .and_then(|()| pipeline.add(&appsink))
        .map_err(|e| format!("add elements: {e}"))?;
    gst::Element::link_many([&input.tail, &queue, &convert, &resample, &capsfilter, &appsink]).map_err(|e| format!("link: {e}"))?;

    let app_sink: gst_app::AppSink = appsink.dynamic_cast().map_err(|_| "appsink: cast failed".to_string())?;
    let on_pcm = sinks.on_pcm.clone();
    app_sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                if let Some(buffer) = sample.buffer()
                    && let Ok(map) = buffer.map_readable()
                {
                    let pcm: Vec<i16> = map.as_slice().chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
                    on_pcm(&pcm);
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    pipeline.set_state(gst::State::Playing).map_err(|e| format!("set state playing: {e}"))?;
    Ok(ActivePipeline { pipeline, _input: input })
}

pub fn run(
    config: Config,
    sinks: Sinks,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
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
    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let flowed = Arc::new(AtomicBool::new(false));
    let _ = ready.send(Ok(PipelineHandle { commands: commands_tx, flowed: flowed.clone() }));

    let mut active: Option<ActivePipeline> = None;
    let mut retry_target: Option<String> = None;
    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::Connect(flow_id)) => {
                active = None;
                (sinks.on_stop)();
                match build(&context, &flow_id, &sinks, flowed.clone()) {
                    Ok(p) => {
                        active = Some(p);
                        retry_target = None;
                    }
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("connect {flow_id} failed: {e}")));
                        retry_target = Some(flow_id);
                    }
                }
            }
            Ok(Command::Disconnect) => {
                active = None;
                retry_target = None;
                (sinks.on_stop)();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if active.is_none()
                    && let Some(flow_id) = retry_target.clone()
                    && let Ok(p) = build(&context, &flow_id, &sinks, flowed.clone())
                {
                    active = Some(p);
                    retry_target = None;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(active);
}
