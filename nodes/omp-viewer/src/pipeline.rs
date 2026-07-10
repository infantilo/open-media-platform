//! GStreamer-Pipeline von `omp-viewer` (`UMSETZUNG.md` C6): liest einen
//! MXL-Flow über `omp_mediaio::mxl::MxlVideoInput` und speist ihn in
//! einen `tee`, der einen MJPEG-Zweig (PIPELINE CONTROLLERs bewährtes
//! Preview-Muster, `lib/PreviewPipeline.js`: `videoscale 640×360 !
//! videorate 5/1 ! jpegenc quality=70 ! appsink`) sowie optional einen
//! `autovideosink`-Zweig speist (`OMP_VIEWER_SINK`, Terminal-Start).
//! `sync=false` durchgehend — umgeht die Timestamp-Frage aus C4 für
//! diesen Pfad vollständig (`UMSETZUNG.md` C6).
//!
//! Die Quelle (`flow_id`) wird per IS-05-Receiver-PATCH gewählt
//! (`main.rs`s `ViewerControl`), nicht per Kommandozeile — bei jedem
//! Quellwechsel wird die **gesamte Pipeline neu aufgebaut** (kein
//! dynamisches Pad-Relinking), analog PIPELINE CONTROLLERs eigener
//! Antwort auf einen geänderten Live-Quellen-Satz (`MasterPipeline.js`,
//! hier auf einen einzelnen Input übertragen, `UMSETZUNG.md` C6/C7).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use crate::preview::Broadcaster;

const PREVIEW_WIDTH: u32 = 640;
const PREVIEW_HEIGHT: u32 = 360;
const PREVIEW_FPS: i32 = 5;
const PREVIEW_JPEG_QUALITY: i32 = 70;

pub struct Config {
    pub domain: String,
    pub sink_element: Option<String>,
}

pub enum Event {
    Error(String),
}

enum Command {
    Connect(String),
    Disconnect,
}

/// Griff für den async Node-Lifecycle: schickt Connect-/
/// Disconnect-Befehle an den Pipeline-Thread.
#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
}

impl PipelineHandle {
    pub fn connect(&self, flow_id: String) {
        let _ = self.commands.send(Command::Connect(flow_id));
    }

    pub fn disconnect(&self) {
        let _ = self.commands.send(Command::Disconnect);
    }
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    _input: MxlVideoInput,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        // Pipeline zuerst auf Null setzen (appsrc nimmt keine Buffer mehr
        // an, der Reader-Thread in _input bricht daraufhin selbst aus
        // seiner push_buffer-Schleife) — Felder droppen danach in
        // Deklarationsreihenfolge (_input nach pipeline).
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn build(
    context: &Arc<MxlContext>,
    flow_id: &str,
    broadcaster: &Arc<Broadcaster>,
    sink_element: Option<&str>,
) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let input = MxlVideoInput::new(&pipeline, context.clone(), flow_id)?;

    let tee = gst::ElementFactory::make("tee")
        .name("preview_tee")
        .build()
        .map_err(|e| format!("tee: {e}"))?;
    pipeline.add(&tee).map_err(|e| format!("add tee: {e}"))?;
    input
        .tail
        .link(&tee)
        .map_err(|e| format!("link input to tee: {e}"))?;

    build_mjpeg_branch(&pipeline, &tee, broadcaster)?;
    if let Some(sink_name) = sink_element {
        build_sink_branch(&pipeline, &tee, sink_name)?;
    }

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActivePipeline {
        pipeline,
        _input: input,
    })
}

fn build_mjpeg_branch(
    pipeline: &gst::Pipeline,
    tee: &gst::Element,
    broadcaster: &Arc<Broadcaster>,
) -> Result<(), String> {
    let queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue (mjpeg): {e}"))?;
    let videoscale = gst::ElementFactory::make("videoscale")
        .build()
        .map_err(|e| format!("videoscale: {e}"))?;
    let videorate = gst::ElementFactory::make("videorate")
        .build()
        .map_err(|e| format!("videorate: {e}"))?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("width", PREVIEW_WIDTH as i32)
                .field("height", PREVIEW_HEIGHT as i32)
                .field("framerate", gst::Fraction::new(PREVIEW_FPS, 1))
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter (mjpeg): {e}"))?;
    let jpegenc = gst::ElementFactory::make("jpegenc")
        .property("quality", PREVIEW_JPEG_QUALITY)
        .build()
        .map_err(|e| format!("jpegenc: {e}"))?;
    let appsink = gst::ElementFactory::make("appsink")
        .property("sync", false)
        .property("max-buffers", 2u32)
        .property("drop", true)
        .build()
        .map_err(|e| format!("appsink (mjpeg): {e}"))?;

    pipeline
        .add(&queue)
        .and_then(|()| pipeline.add(&videoscale))
        .and_then(|()| pipeline.add(&videorate))
        .and_then(|()| pipeline.add(&caps))
        .and_then(|()| pipeline.add(&jpegenc))
        .and_then(|()| pipeline.add(&appsink))
        .map_err(|e| format!("add mjpeg elements: {e}"))?;

    gst::Element::link_many([
        tee,
        &queue,
        &videoscale,
        &videorate,
        &caps,
        &jpegenc,
        &appsink,
    ])
    .map_err(|e| format!("link mjpeg branch: {e}"))?;

    let app_sink: gst_app::AppSink = appsink
        .dynamic_cast()
        .map_err(|_| "appsink: cast to AppSink failed".to_string())?;
    let broadcaster = broadcaster.clone();
    app_sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                if let Some(buffer) = sample.buffer()
                    && let Ok(map) = buffer.map_readable()
                {
                    broadcaster.publish(map.as_slice());
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    Ok(())
}

fn build_sink_branch(
    pipeline: &gst::Pipeline,
    tee: &gst::Element,
    sink_name: &str,
) -> Result<(), String> {
    let queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue (sink): {e}"))?;
    let videoconvert = gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(|e| format!("videoconvert (sink): {e}"))?;
    let sink = gst::ElementFactory::make(sink_name)
        .property("sync", false)
        .build()
        .map_err(|e| format!("{sink_name}: {e}"))?;

    pipeline
        .add(&queue)
        .and_then(|()| pipeline.add(&videoconvert))
        .and_then(|()| pipeline.add(&sink))
        .map_err(|e| format!("add sink elements: {e}"))?;

    gst::Element::link_many([tee, &queue, &videoconvert, &sink])
        .map_err(|e| format!("link sink branch: {e}"))?;

    Ok(())
}

/// Läuft auf einem eigenen Thread (analog `omp-source::pipeline::run`):
/// baut initial keine Pipeline (noch keine Quelle gewählt), wartet auf
/// `Command`s aus `PipelineHandle` und baut bei jedem Connect/Disconnect
/// die Pipeline komplett neu auf.
pub fn run(
    config: Config,
    broadcaster: Arc<Broadcaster>,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
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

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) =
        std::sync::mpsc::channel();
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
    }));

    let mut active: Option<ActivePipeline> = None;
    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::Connect(flow_id)) => {
                // Alte Pipeline zuerst abbauen (Drop stoppt Reader-Thread
                // + setzt State Null), bevor die neue denselben
                // MxlContext für einen neuen Reader nutzt.
                active = None;
                match build(
                    &context,
                    &flow_id,
                    &broadcaster,
                    config.sink_element.as_deref(),
                ) {
                    Ok(p) => active = Some(p),
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("connect {flow_id} failed: {e}")));
                    }
                }
            }
            Ok(Command::Disconnect) => {
                active = None;
                broadcaster.reset();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
