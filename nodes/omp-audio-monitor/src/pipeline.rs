//! GStreamer-Pipeline von `omp-audio-monitor` (Nutzerwunsch 2026-07-29:
//! "wir müssen auch das audio abhören können"): liest einen per IS-05-
//! Receiver-PATCH gewählten MXL-Audio-Flow über
//! `omp_mediaio::mxl::MxlAudioInput` und speist ihn in einen rohen
//! PCM-über-HTTP-Zweig (`omp_mediaio::pcm_stream`, 2026-08-06 an
//! Stelle des ursprünglichen MP3-Zweigs — s. dortige Moduldoku:
//! spürbar geringere Latenz ohne Encoder-Lookahead) — exaktes
//! Strukturmuster von `omp-viewer::pipeline` (MJPEG statt PCM, Video
//! statt Audio), inkl. desselben "gesamte Pipeline neu aufbauen statt
//! Pad-Relinking"-Musters bei jedem Quellwechsel.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::mxl::{MxlAudioInput, MxlContext};
use omp_mediaio::pcm_stream::{self, Broadcaster};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub struct Config {
    pub domain: String,
}

pub enum Event {
    Error(String),
}

enum Command {
    Connect(String),
    Disconnect,
}

/// Griff für den async Node-Lifecycle: schickt Connect-/
/// Disconnect-Befehle an den Pipeline-Thread — identisches Muster zu
/// `omp-viewer::pipeline::PipelineHandle`.
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

    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6) — ob die aktuell
    /// verbundene Quelle bereits mindestens einen echten Audio-Buffer
    /// geliefert hat, s. `omp-viewer::pipeline::PipelineHandle::
    /// media_ready` für dieselbe Begründung (Flag überlebt Pipeline-
    /// Rebuilds bewusst, anders als `MxlAudioInput`s internes Flag).
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

fn build(
    context: &Arc<MxlContext>,
    flow_id: &str,
    broadcaster: &Arc<Broadcaster>,
    flowed: Arc<AtomicBool>,
) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let input = MxlAudioInput::new(&pipeline, context.clone(), flow_id)?;

    let flowed_probe = flowed.clone();
    let input_tail_src_pad = input.tail.static_pad("src").expect("tail has a src pad");
    input_tail_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        flowed_probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Remove
    });

    pcm_stream::build_pcm_branch(&pipeline, &input.tail, broadcaster)?;

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActivePipeline {
        pipeline,
        _input: input,
    })
}

/// Läuft auf einem eigenen Thread (analog `omp-viewer::pipeline::run`):
/// baut initial keine Pipeline, wartet auf `Command`s aus
/// `PipelineHandle` und baut bei jedem Connect/Disconnect die Pipeline
/// komplett neu auf.
pub fn run(
    config: Config,
    broadcaster: Arc<Broadcaster>,
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

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) =
        std::sync::mpsc::channel();
    let flowed = Arc::new(AtomicBool::new(false));
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        flowed: flowed.clone(),
    }));

    let mut active: Option<ActivePipeline> = None;
    loop {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::Connect(flow_id)) => {
                // Alte Pipeline zuerst abbauen (Drop stoppt den
                // MXL-Reader-Thread), bevor die neue denselben
                // MxlContext für einen neuen Reader nutzt.
                active = None;
                match build(&context, &flow_id, &broadcaster, flowed.clone()) {
                    Ok(p) => active = Some(p),
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("connect {flow_id} failed: {e}")));
                    }
                }
            }
            Ok(Command::Disconnect) => {
                active = None;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
