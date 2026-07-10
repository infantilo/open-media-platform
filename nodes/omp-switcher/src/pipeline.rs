//! GStreamer-Pipeline von `omp-switcher` (`UMSETZUNG.md` C7), übernommen
//! aus PIPELINE CONTROLLERs `MasterPipeline.js`, nicht neu erfunden:
//! `input-selector name=isel sync-streams=false`, `sink_0` permanent ein
//! Schwarzbild-Fallback (`videotestsrc is-live=true pattern=black`,
//! damit der Ausgang auch bei null entdeckten Quellen läuft), ein Zweig
//! pro entdeckter Quelle (`MxlVideoInput(flow) ! isel.sink_N`), danach
//! `isel ! MxlVideoOutput` unter der eigenen, über Neuaufbauten hinweg
//! konstanten `flow_id` (`Config::flow_id`) — MXLs `create_flow_writer`
//! erkennt einen bereits existierenden Flow und öffnet ihn erneut (siehe
//! `omp_mediaio::mxl`-Kommentar "reusing existing flow"), daher bleiben
//! angeschlossene Viewer über einen Neuaufbau hinweg gültig.
//!
//! Jeder Zweig (Schwarzbild wie Quellen) läuft vor `isel` durch
//! `videoconvert ! videoscale ! videorate ! capsfilter` auf dieselben
//! festen Maße/Framerate (`WIDTH`/`HEIGHT`/`FRAMERATE_*`, identisch zu
//! `omp-source`s Konstanten) — `input-selector` schaltet nur zwischen
//! bereits kompatiblen Caps um, ohne dass der Ausgang bei jedem Wechsel
//! neu verhandeln müsste.
//!
//! **Zwei getrennte Änderungsarten:** ändert sich die entdeckte
//! Quellenmenge (`Command::SetInputs`), wird die **gesamte Pipeline neu
//! aufgebaut** (PIPELINE CONTROLLERs eigene Antwort auf einen geänderten
//! Live-Quellen-Satz). Ein Klick auf einen Auswahl-Button
//! (`Command::Select`) ändert dagegen nur `isel`s `active-pad`-Property
//! auf der laufenden Pipeline — kein Neuaufbau nötig.

use std::collections::HashMap;
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

pub const WIDTH: u32 = 640;
pub const HEIGHT: u32 = 480;
pub const FRAMERATE_NUMERATOR: u32 = 25;
pub const FRAMERATE_DENOMINATOR: u32 = 1;

/// Beim `MxlVideoOutput`/`MxlVideoInput`-Schreib-/Lese-Thread (`C4`) wird
/// beim `Drop` nur ein Stop-Flag gesetzt, nicht auf das tatsächliche
/// Threadende gewartet (kein `JoinHandle` gehalten) — der jeweilige
/// Loop-Durchlauf endet erst nach seinem eigenen Poll-Timeout (200/500ms).
/// Vor dem Öffnen eines neuen Writers auf denselben `flow_id` (Rebuild)
/// wird deshalb kurz gewartet, damit nicht zwei Writer-Threads
/// überlappend in denselben Flow schreiben.
const OLD_WRITER_DRAIN: Duration = Duration::from_millis(300);

pub struct Config {
    pub domain: String,
    pub flow_id: String,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct DiscoveredInput {
    pub sender_id: String,
    pub label: String,
    pub flow_id: String,
}

pub enum Event {
    Error(String),
    /// `None` = Schwarzbild aktiv. Sowohl nach einem `Select` als auch
    /// nach einem Rebuild geschickt (im zweiten Fall ggf. abweichend vom
    /// zuletzt gewünschten `senderId`, wenn die Quelle verschwunden ist).
    ActiveChanged(Option<String>),
}

enum Command {
    SetInputs(Vec<DiscoveredInput>),
    Select(Option<String>),
}

/// Griff für den async Node-Lifecycle: meldet die aktuell entdeckten
/// Quellen (`main.rs`s Discovery-Loop) bzw. eine Auswahl (`select`-Methode).
#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
}

impl PipelineHandle {
    pub fn set_inputs(&self, inputs: Vec<DiscoveredInput>) {
        let _ = self.commands.send(Command::SetInputs(inputs));
    }

    pub fn select(&self, sender_id: Option<String>) {
        let _ = self.commands.send(Command::Select(sender_id));
    }
}

fn video_caps() -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("width", WIDTH as i32)
        .field("height", HEIGHT as i32)
        .field(
            "framerate",
            gst::Fraction::new(FRAMERATE_NUMERATOR as i32, FRAMERATE_DENOMINATOR as i32),
        )
        .build()
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    isel: gst::Element,
    black_pad: gst::Pad,
    source_pads: HashMap<String, gst::Pad>,
    _inputs: Vec<MxlVideoInput>,
    _mxl_output: MxlVideoOutput,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Wendet `selected` auf die laufende Pipeline an (fällt auf Schwarzbild
/// zurück, wenn `selected` keinem aktuell bekannten `source_pads`-Eintrag
/// entspricht) und liefert die tatsächlich aktiv geschaltete `senderId`
/// zurück (`None` = Schwarzbild).
fn apply_selection(active: &ActivePipeline, selected: &Option<String>) -> Option<String> {
    let pad = selected
        .as_ref()
        .and_then(|id| active.source_pads.get(id).map(|pad| (id.clone(), pad)));
    match pad {
        Some((id, pad)) => {
            active.isel.set_property("active-pad", pad);
            Some(id)
        }
        None => {
            active.isel.set_property("active-pad", &active.black_pad);
            None
        }
    }
}

fn build(
    context: &Arc<MxlContext>,
    config: &Config,
    inputs: &[DiscoveredInput],
) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let isel = gst::ElementFactory::make("input-selector")
        .name("isel")
        .property("sync-streams", false)
        .build()
        .map_err(|e| format!("input-selector: {e}"))?;
    pipeline.add(&isel).map_err(|e| format!("add isel: {e}"))?;

    let black_src = gst::ElementFactory::make("videotestsrc")
        .property("is-live", true)
        .build()
        .map_err(|e| format!("videotestsrc (black): {e}"))?;
    black_src.set_property_from_str("pattern", "black");
    let black_caps = gst::ElementFactory::make("capsfilter")
        .property("caps", video_caps())
        .build()
        .map_err(|e| format!("capsfilter (black): {e}"))?;
    pipeline
        .add(&black_src)
        .and_then(|()| pipeline.add(&black_caps))
        .map_err(|e| format!("add black branch: {e}"))?;
    gst::Element::link_many([&black_src, &black_caps])
        .map_err(|e| format!("link black branch: {e}"))?;
    let black_pad = isel
        .request_pad_simple("sink_0")
        .ok_or("isel: request sink_0 failed")?;
    black_caps
        .static_pad("src")
        .ok_or("black capsfilter: no src pad")?
        .link(&black_pad)
        .map_err(|e| format!("link black branch to isel: {e}"))?;

    let mut source_pads = HashMap::with_capacity(inputs.len());
    let mut mxl_inputs = Vec::with_capacity(inputs.len());
    for (i, input) in inputs.iter().enumerate() {
        let pad_index = i + 1;
        let mxl_input = MxlVideoInput::new(&pipeline, context.clone(), &input.flow_id)
            .map_err(|e| format!("MxlVideoInput({}): {e}", input.sender_id))?;

        let videoconvert = gst::ElementFactory::make("videoconvert")
            .build()
            .map_err(|e| format!("videoconvert (input {pad_index}): {e}"))?;
        let videoscale = gst::ElementFactory::make("videoscale")
            .build()
            .map_err(|e| format!("videoscale (input {pad_index}): {e}"))?;
        let videorate = gst::ElementFactory::make("videorate")
            .build()
            .map_err(|e| format!("videorate (input {pad_index}): {e}"))?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", video_caps())
            .build()
            .map_err(|e| format!("capsfilter (input {pad_index}): {e}"))?;

        pipeline
            .add(&videoconvert)
            .and_then(|()| pipeline.add(&videoscale))
            .and_then(|()| pipeline.add(&videorate))
            .and_then(|()| pipeline.add(&caps))
            .map_err(|e| format!("add input {pad_index} elements: {e}"))?;
        gst::Element::link_many([
            &mxl_input.tail,
            &videoconvert,
            &videoscale,
            &videorate,
            &caps,
        ])
        .map_err(|e| format!("link input {pad_index} chain: {e}"))?;

        let pad = isel
            .request_pad_simple(&format!("sink_{pad_index}"))
            .ok_or_else(|| format!("isel: request sink_{pad_index} failed"))?;
        caps.static_pad("src")
            .ok_or("input capsfilter: no src pad")?
            .link(&pad)
            .map_err(|e| format!("link input {pad_index} to isel: {e}"))?;

        source_pads.insert(input.sender_id.clone(), pad);
        mxl_inputs.push(mxl_input);
    }

    let mxl_output = MxlVideoOutput::new(
        &pipeline,
        &isel,
        context.clone(),
        &config.flow_id,
        &config.label,
        WIDTH,
        HEIGHT,
        FRAMERATE_NUMERATOR,
        FRAMERATE_DENOMINATOR,
    )
    .map_err(|e| format!("MxlVideoOutput: {e}"))?;
    mxl_output.set_active(true);

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActivePipeline {
        pipeline,
        isel,
        black_pad,
        source_pads,
        _inputs: mxl_inputs,
        _mxl_output: mxl_output,
    })
}

fn inputs_changed(current: &[DiscoveredInput], new: &[DiscoveredInput]) -> bool {
    if current.len() != new.len() {
        return true;
    }
    let mut current_ids: Vec<&str> = current.iter().map(|i| i.sender_id.as_str()).collect();
    let mut new_ids: Vec<&str> = new.iter().map(|i| i.sender_id.as_str()).collect();
    current_ids.sort_unstable();
    new_ids.sort_unstable();
    current_ids != new_ids
}

/// Läuft auf einem eigenen Thread (analog `omp-source`/`omp-viewer`s
/// `pipeline::run`): baut sofort eine erste Pipeline ohne Quellen
/// (Schwarzbild-Fallback läuft ab dem ersten Moment), wartet danach auf
/// `Command`s.
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

    let mut current_inputs: Vec<DiscoveredInput> = Vec::new();
    let mut active = match build(&context, &config, &current_inputs) {
        Ok(p) => Some(p),
        Err(e) => {
            let _ = tx.send(Event::Error(format!("initial build failed: {e}")));
            let _ = ready.send(Err(e));
            return;
        }
    };
    let mut selected: Option<String> = None;

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) =
        std::sync::mpsc::channel();
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
    }));

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::SetInputs(inputs)) => {
                if inputs_changed(&current_inputs, &inputs) {
                    // current_inputs merkt sich den *versuchten* Stand,
                    // auch wenn der Rebuild unten fehlschlägt — verhindert
                    // Rebuild-Spam bei jedem 2s-Poll, solange die
                    // Registry denselben (kaputten, z. B. verwaisten)
                    // Stand meldet; ein späterer, tatsächlich
                    // abweichender Poll (Quelle verschwindet endgültig
                    // aus der Registry) löst dann erneut aus.
                    current_inputs = inputs;
                    // Alte Pipeline zuerst abbauen (Drop stoppt die
                    // Reader-Threads + setzt State Null), bevor der neue
                    // MxlVideoOutput denselben flow_id erneut öffnet.
                    active = None;
                    std::thread::sleep(OLD_WRITER_DRAIN);
                    match build(&context, &config, &current_inputs) {
                        Ok(p) => {
                            let applied = apply_selection(&p, &selected);
                            active = Some(p);
                            let _ = tx.send(Event::ActiveChanged(applied));
                        }
                        Err(e) => {
                            // Ein einzelner kaputter/verwaister Eingang
                            // (z. B. Registry-Eintrag eines gerade erst
                            // beendeten Nodes, noch nicht per
                            // registration_expiry_interval verfallen)
                            // darf den Switcher nicht abschießen — der
                            // Ausgang muss laut C7 auch bei null Quellen
                            // laufen. Fallback auf eine Schwarzbild-
                            // Pipeline statt den Thread zu beenden.
                            let _ = tx.send(Event::Error(format!(
                                "rebuild with {} inputs failed: {e} — falling back to black",
                                current_inputs.len()
                            )));
                            match build(&context, &config, &[]) {
                                Ok(p) => {
                                    let applied = apply_selection(&p, &selected);
                                    active = Some(p);
                                    let _ = tx.send(Event::ActiveChanged(applied));
                                }
                                Err(e2) => {
                                    let _ = tx.send(Event::Error(format!(
                                        "fallback black-only build also failed: {e2}"
                                    )));
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Ok(Command::Select(sender_id)) => {
                selected = sender_id;
                if let Some(p) = &active {
                    let applied = apply_selection(p, &selected);
                    let _ = tx.send(Event::ActiveChanged(applied));
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
