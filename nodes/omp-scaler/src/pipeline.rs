//! GStreamer-Pipeline von `omp-scaler` (Nutzerwunsch 2026-07-28:
//! "einfaches Scaler/Framerate-Converter-Node"): liest einen per
//! IS-05-Receiver-PATCH gewählten MXL-Flow (`MxlVideoInput`, beliebige
//! native Auflösung/Framerate) und schreibt ihn als zweiten,
//! eigenständigen MXL-Flow in einem fest konfigurierten Zielformat
//! zurück (`MxlVideoOutput`).
//!
//! **Kein eigener Scale-/Rate-Code nötig:** `omp_mediaio::mxl::
//! MxlVideoOutput::new` baut bereits intern `videoconvert ! videoscale !
//! videorate ! capsfilter(Zielformat)` vor dem eigentlichen MXL-Schreiben
//! auf (s. `omp-mediaio/src/mxl.rs`) — genau die Kette, die ein
//! Scaler/Framerate-Converter braucht. Dieser Node ist deshalb nur die
//! Verkabelung `MxlVideoInput → MxlVideoOutput(Zielformat)`, kein neuer
//! Konvertierungs-Mechanismus.
//!
//! Quellwahl per Drag & Drop wie bei `omp-viewer`/`omp-recorder` (nicht
//! per Kommandozeile) — bei jedem Quellwechsel wird die gesamte
//! Pipeline neu aufgebaut (kein dynamisches Pad-Relinking), exakt
//! dasselbe Muster wie `omp-viewer::pipeline`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub struct Config {
    pub domain: String,
    pub target_flow_id: String,
    pub label: String,
    pub target_width: u32,
    pub target_height: u32,
    pub target_framerate_numerator: u32,
    pub target_framerate_denominator: u32,
}

pub enum Event {
    Error(String),
}

enum Command {
    Connect(String),
    Disconnect,
}

/// Griff für den async Node-Lifecycle: schickt Connect-/
/// Disconnect-Befehle an den Pipeline-Thread (gleiches Muster wie
/// `omp-viewer::pipeline::PipelineHandle`).
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
    /// verbundene Quelle (falls vorhanden) bereits mindestens einen
    /// echten, skalierten Ausgangs-Buffer geliefert hat. `false` sowohl
    /// vor dem ersten `connect()` als auch direkt nach einem
    /// Quellwechsel, bis der neu aufgebaute Ausgang nachweislich
    /// schreibt (s. `connect()`/`disconnect()` oben, die das Flag
    /// zurücksetzen — dieselbe Begründung wie bei `omp-viewer`: das
    /// interne `MxlVideoOutput`-Flag stirbt mit jedem Pipeline-Rebuild,
    /// dieses hier überlebt es bewusst).
    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    _input: MxlVideoInput,
    _output: MxlVideoOutput,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        // Pipeline zuerst auf Null setzen (der MXL-Eingangs-Reader-Thread
        // bricht daraufhin selbst aus seiner Lese-Schleife) — Felder
        // droppen danach in Deklarationsreihenfolge, gleiches Muster wie
        // `omp-viewer::pipeline::ActivePipeline`.
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn build(
    context: &Arc<MxlContext>,
    source_flow_id: &str,
    config: &Config,
    flowed: Arc<AtomicBool>,
) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let input = MxlVideoInput::new(&pipeline, context.clone(), source_flow_id)?;

    let queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue: {e}"))?;
    pipeline
        .add(&queue)
        .map_err(|e| format!("add queue: {e}"))?;
    gst::Element::link_many([&input.tail, &queue]).map_err(|e| format!("link input to queue: {e}"))?;

    // Die eigentliche Skalierung/Framerate-Konvertierung passiert intern
    // in `MxlVideoOutput::new` (s. Moduldoku oben) — hier nur Ziel-
    // Auflösung/-Framerate übergeben.
    let output = MxlVideoOutput::new(
        &pipeline,
        &queue,
        context.clone(),
        &config.target_flow_id,
        &config.label,
        config.target_width,
        config.target_height,
        config.target_framerate_numerator,
        config.target_framerate_denominator,
    )
    .map_err(|e| format!("MxlVideoOutput: {e}"))?;
    output.set_active(true);

    // "media-ready": Probe direkt hinter dem MXL-Eingang statt auf
    // `output.has_flowed()` — der Eingang ist der Teil, der bei einem
    // Quellwechsel wirklich neu verbindet, und ein Buffer, der bis
    // hierhin kommt, durchläuft danach nur noch feste, bereits als
    // funktionierend verifizierte `MxlVideoOutput`-interne Elemente
    // (gleiche Argumentation wie bei `omp-viewer`).
    let flowed_probe = flowed.clone();
    let input_tail_src_pad = input.tail.static_pad("src").expect("tail has a src pad");
    input_tail_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        flowed_probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Remove
    });

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActivePipeline {
        pipeline,
        _input: input,
        _output: output,
    })
}

/// Läuft auf einem eigenen Thread (analog `omp-viewer::pipeline::run`):
/// baut initial keine Pipeline (noch keine Quelle gewählt, aber der
/// Ziel-MXL-Sender ist über die IS-04-Registrierung bereits bekannt),
/// wartet auf `Command`s aus `PipelineHandle` und baut bei jedem
/// Connect/Disconnect die Pipeline komplett neu auf.
pub fn run(
    config: Config,
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
    let flowed = Arc::new(AtomicBool::new(false));
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        flowed: flowed.clone(),
    }));

    let mut active: Option<ActivePipeline> = None;
    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::Connect(source_flow_id)) => {
                // Alte Pipeline zuerst abbauen (Drop stoppt den
                // Eingangs-Reader-Thread), bevor die neue denselben
                // MxlContext für einen neuen Reader/Writer nutzt.
                active = None;
                match build(&context, &source_flow_id, &config, flowed.clone()) {
                    Ok(p) => active = Some(p),
                    Err(e) => {
                        let _ =
                            tx.send(Event::Error(format!("connect {source_flow_id} failed: {e}")));
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
