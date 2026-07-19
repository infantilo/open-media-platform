//! GStreamer-Pipelines von `omp-2110-gateway` (Kapitel 19 Teil 1,
//! `docs/END-GOAL-FEATURES.md` §19.3a Punkt 4/§19.4) — zwei Richtungen,
//! **anders als `omp-srt-gateway`** (reines Protokoll-zu-Protokoll-
//! Gateway, kein MXL-Bezug) berührt hier genau eine Seite den
//! OMP-internen Fabric:
//!
//! - **Ingest** (2110-Multicast → MXL-Flow): `St2110VideoInput !
//!   MxlVideoOutput`. Fix beim Prozessstart konfiguriert, kein Cue/Take
//!   (gleiche "einmal konfiguriert, dauerhaft aktiv"-Philosophie wie
//!   `omp-srt-gateway`, `main.rs`-Moduldoku dort) — ein 2110-Gateway ist
//!   wie ein Hardware-Gateway modelliert, nicht wie eine per Flow-Editor
//!   umschaltbare Quelle.
//! - **Output** (MXL-Flow → 2110-Multicast): `MxlVideoInput !
//!   St2110VideoOutput`, Quellwahl per echtem IS-05-Receiver-PATCH
//!   (gleiches Rebuild-bei-Connect-Muster wie `omp-viewer::pipeline`,
//!   nicht `omp-srt-gateway`s feste Env-Var-Konfiguration — hier ist die
//!   MXL-Seite die variable, per Flow-Editor drag&drop wählbare Seite).
//!   Ziel-Endpunkt (2110-Netzwerkadresse) bleibt fix (Env-Var), nur die
//!   MXL-Quelle ist dynamisch.
//!
//! Video-only in dieser Scheibe (dokumentierte Einschränkung, s.
//! `docs/decisions.md`) — Audio-Ingest/-Output folgt als eigener
//! Schritt, sobald ein konkreter Bedarf für synchronisierten
//! Video+Audio-Gateway-Betrieb besteht.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput, MxlVideoOutput};
use omp_mediaio::st2110::{St2110VideoInput, St2110VideoOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub enum Event {
    Error(String),
}

// ---------------------------------------------------------------------
// Ingest: 2110-Multicast → MXL-Flow
// ---------------------------------------------------------------------

pub struct IngestConfig {
    pub domain: String,
    pub flow_id: String,
    pub label: String,
    pub listen_port: u16,
    pub multicast_group: Option<String>,
    pub width: i32,
    pub height: i32,
    pub framerate_numerator: i32,
    pub framerate_denominator: i32,
}

/// Griff auf die laufende Ingest-Pipeline — hält `pipeline`/`_input`/
/// `_output` am Leben (gleiche Drop-Reihenfolge-Überlegung wie
/// `omp-viewer::pipeline::ActivePipeline`: Pipeline zuerst auf Null,
/// die MXL-/2110-Objekte räumen sich danach selbst auf) und liefert das
/// "media-ready"-Flag nach außen.
pub struct IngestHandle {
    pipeline: gst::Pipeline,
    _input: St2110VideoInput,
    _output: MxlVideoOutput,
    flowed: Arc<AtomicBool>,
}

impl IngestHandle {
    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

impl Drop for IngestHandle {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

pub fn run_ingest(
    config: IngestConfig,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<IngestHandle, String>>,
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

    let pipeline = gst::Pipeline::new();

    let input = match St2110VideoInput::new(
        &pipeline,
        config.listen_port,
        config.width,
        config.height,
        config.framerate_numerator,
        config.framerate_denominator,
        config.multicast_group.as_deref(),
    ) {
        Ok(i) => i,
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let output = match MxlVideoOutput::new(
        &pipeline,
        &input.tail,
        context,
        &config.flow_id,
        &config.label,
        config.width as u32,
        config.height as u32,
        config.framerate_numerator as u32,
        config.framerate_denominator as u32,
    ) {
        Ok(o) => o,
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };
    output.set_active(true);

    // "media-ready" (ARCHITECTURE.md §5 Punkt 6): echte 2110-Pakete
    // gesehen, nicht nur "Pipeline läuft" — Probe hinter dem 2110-
    // Empfänger, nicht hinter dem MXL-Schreiber (gleiche Begründung wie
    // überall sonst in diesem Crate: ein aktiver Valve/Writer allein
    // beweist noch keinen echten Dateninhalt).
    let flowed = Arc::new(AtomicBool::new(false));
    let flowed_probe = flowed.clone();
    let input_tail_src_pad = input.tail.static_pad("src").expect("tail has a src pad");
    input_tail_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        flowed_probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Remove
    });

    if let Err(e) = pipeline.set_state(gst::State::Playing) {
        let msg = format!("set state playing: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }

    let _ = ready.send(Ok(IngestHandle {
        pipeline: pipeline.clone(),
        _input: input,
        _output: output,
        flowed,
    }));

    // Kein Reconnect-Kommandokanal nötig (fix konfiguriert) — reine
    // Warteschleife bis zum Shutdown, gleiche Poll-Kadenz wie
    // `omp-viewer::pipeline::run`s Command-Loop.
    while !shutdown.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(500));
    }
}

// ---------------------------------------------------------------------
// Output: MXL-Flow → 2110-Multicast
// ---------------------------------------------------------------------

pub struct OutputConfig {
    pub domain: String,
    pub destination_host: String,
    pub destination_port: u16,
    pub width: i32,
    pub height: i32,
    pub framerate_numerator: i32,
    pub framerate_denominator: i32,
}

enum Command {
    Connect(String),
    Disconnect,
}

/// Griff für den async Node-Lifecycle (gleiches Muster wie
/// `omp-viewer::pipeline::PipelineHandle`): schickt Connect-/
/// Disconnect-Befehle an den Pipeline-Thread, der bei jedem Wechsel die
/// gesamte Pipeline neu aufbaut (kein dynamisches Pad-Relinking).
#[derive(Clone)]
pub struct OutputPipelineHandle {
    commands: Sender<Command>,
    flowed: Arc<AtomicBool>,
}

impl OutputPipelineHandle {
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

struct ActiveOutputPipeline {
    pipeline: gst::Pipeline,
    _input: MxlVideoInput,
    _output: St2110VideoOutput,
}

impl Drop for ActiveOutputPipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

#[allow(clippy::too_many_arguments)]
fn build_output(
    context: &Arc<MxlContext>,
    flow_id: &str,
    destination_host: &str,
    destination_port: u16,
    width: i32,
    height: i32,
    framerate_numerator: i32,
    framerate_denominator: i32,
    flowed: Arc<AtomicBool>,
) -> Result<ActiveOutputPipeline, String> {
    let pipeline = gst::Pipeline::new();

    let input = MxlVideoInput::new(&pipeline, context.clone(), flow_id)?;
    let flowed_probe = flowed.clone();
    let input_tail_src_pad = input.tail.static_pad("src").expect("tail has a src pad");
    input_tail_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        flowed_probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Remove
    });

    let output = St2110VideoOutput::new(
        &pipeline,
        &input.tail,
        destination_host,
        destination_port,
        width,
        height,
        framerate_numerator,
        framerate_denominator,
    )?;
    output.set_active(true);

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActiveOutputPipeline {
        pipeline,
        _input: input,
        _output: output,
    })
}

/// Läuft auf einem eigenen Thread (analog `omp-viewer::pipeline::run`):
/// baut initial keine Pipeline (noch keine Quelle gewählt), wartet auf
/// `Command`s und baut bei jedem Connect/Disconnect komplett neu.
pub fn run_output(
    config: OutputConfig,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<OutputPipelineHandle, String>>,
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
    let _ = ready.send(Ok(OutputPipelineHandle {
        commands: commands_tx,
        flowed: flowed.clone(),
    }));

    let mut active: Option<ActiveOutputPipeline> = None;
    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::Connect(flow_id)) => {
                // Alte Pipeline zuerst abbauen (Drop stoppt den MXL-
                // Reader-Thread + setzt State Null), bevor die neue
                // denselben MxlContext für einen neuen Reader nutzt.
                active = None;
                match build_output(
                    &context,
                    &flow_id,
                    &config.destination_host,
                    config.destination_port,
                    config.width,
                    config.height,
                    config.framerate_numerator,
                    config.framerate_denominator,
                    flowed.clone(),
                ) {
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
