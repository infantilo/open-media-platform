//! GStreamer-Pipeline von `omp-player` (`UMSETZUNG.md` C12, `ARCHITECTURE.md`
//! §13.3): generalisiertes `PlaylistController`-Muster (§11.1) für Musik-/
//! Jingle-Player und Videoplayer in einer Codebasis, manueller Cue/Take-
//! Betrieb (Automation erst C14/C15).
//!
//! **Zwei feste Slots (A/B) statt N dynamischer Zweige:** anders als
//! `omp-switcher`/`omp-video-mixer-me`s Crosspoint (C7/C10, dort so viele
//! Zweige wie entdeckte Quellen) hat ein Player-Cue/Take-Paar strukturell
//! immer genau zwei Rollen — "on air" und "cued" — also zwei feste
//! `input-selector`-Sink-Pads (Video optional, Audio immer), deren Pad-
//! Objekte über die gesamte Prozesslaufzeit bestehen bleiben. `cue()`
//! ersetzt nur den Elementzweig hinter dem jeweils NICHT on-air-Pad
//! (`replace_slot`, analog zu C11s `add_channel_branch`/
//! `remove_channel_branch`, aber ohne Pad-Request/Release, weil die Pads
//! selbst fix bleiben). `take()` schaltet ausschließlich `active-pad` um
//! (kein Rebuild, gleiche Technik wie C7s `apply_selection`) — danach ist
//! der bisherige On-Air-Slot frei für den nächsten `cue()`.
//!
//! **Clips sind Software-Testmittel** (`UMSETZUNG.md` §0 Punkt 7): kein
//! Dateizugriff, jedes Item ist ein `videotestsrc`-Pattern (nur Video-
//! Profil) plus ein `audiotestsrc`-Ton (immer, auch beim reinen
//! Videoplayer — Slate-Ton-Ersatz statt echtem Audiotrack). Beide laufen
//! ohne `num-buffers`-Limit dauerhaft — `durationMs` (siehe `main.rs`) ist
//! bewusst nur Metadaten für die `playheadPosition`-Anzeige, kein
//! erzwungenes Clip-Ende: automatisches Vorrücken am Clip-Ende ist
//! Automations-Scope (C14/C15, `ARCHITECTURE.md` §13.3), ein EOS-Pfad für
//! den aktuell On-Air-Zweig würde hier nur unnötiges Fehlerrisiko ohne
//! Gegenwert einbauen.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
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

/// Default-Pattern/-Ton für einen frisch aufgebauten, noch nicht
/// gecuten Slot ("schwarz/still" statt eines dritten isel-Fallback-Zweigs
/// wie C7s `black_pad` — hier trägt jeder der zwei Slots seinen eigenen
/// Default, bis er zum ersten Mal per `cue()` überschrieben wird).
const EMPTY_PATTERN: &str = "black";
const EMPTY_TONE_FREQ: f64 = 0.0;

pub struct Config {
    pub domain: String,
    pub has_video: bool,
    pub video_flow_id: String,
    pub audio_flow_id: String,
    pub label: String,
}

#[derive(Clone, Debug)]
pub struct Item {
    pub pattern: String,
    pub tone_freq: f64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Slot {
    A,
    B,
}

impl Slot {
    pub fn other(self) -> Slot {
        match self {
            Slot::A => Slot::B,
            Slot::B => Slot::A,
        }
    }

    fn pad_index(self) -> u32 {
        match self {
            Slot::A => 0,
            Slot::B => 1,
        }
    }
}

enum Command {
    LoadSlot { slot: Slot, item: Item },
    SetActive(Slot),
}

pub enum Event {
    Error(String),
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
}

impl PipelineHandle {
    pub fn load_slot(&self, slot: Slot, item: Item) {
        let _ = self.commands.send(Command::LoadSlot { slot, item });
    }

    pub fn set_active(&self, slot: Slot) {
        let _ = self.commands.send(Command::SetActive(slot));
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

/// Ein Slot-Zweig: die Elemente einer Medienart (Video oder Audio) hinter
/// einem festen isel-Sink-Pad. `elements[0]` ist immer die Quelle
/// (`videotestsrc`/`audiotestsrc`), `elements.last()` verlinkt auf `pad`.
struct Branch {
    elements: Vec<gst::Element>,
    pad: gst::Pad,
}

fn build_video_branch(
    pipeline: &gst::Pipeline,
    pad: gst::Pad,
    pattern: &str,
) -> Result<Branch, String> {
    let src = gst::ElementFactory::make("videotestsrc")
        .property("is-live", true)
        .build()
        .map_err(|e| format!("videotestsrc: {e}"))?;
    src.set_property_from_str("pattern", pattern);
    let convert = gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(|e| format!("videoconvert: {e}"))?;
    let scale = gst::ElementFactory::make("videoscale")
        .build()
        .map_err(|e| format!("videoscale: {e}"))?;
    let rate = gst::ElementFactory::make("videorate")
        .build()
        .map_err(|e| format!("videorate: {e}"))?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", video_caps())
        .build()
        .map_err(|e| format!("capsfilter: {e}"))?;

    pipeline
        .add(&src)
        .and_then(|()| pipeline.add(&convert))
        .and_then(|()| pipeline.add(&scale))
        .and_then(|()| pipeline.add(&rate))
        .and_then(|()| pipeline.add(&caps))
        .map_err(|e| format!("add video branch: {e}"))?;
    gst::Element::link_many([&src, &convert, &scale, &rate, &caps])
        .map_err(|e| format!("link video branch: {e}"))?;
    caps.static_pad("src")
        .ok_or("video branch: no src pad")?
        .link(&pad)
        .map_err(|e| format!("link video branch to isel: {e}"))?;

    let elements = vec![src, convert, scale, rate, caps];
    for el in &elements {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync_state_with_parent (video): {e}"))?;
    }
    Ok(Branch { elements, pad })
}

fn build_audio_branch(
    pipeline: &gst::Pipeline,
    pad: gst::Pad,
    freq: f64,
) -> Result<Branch, String> {
    let src = gst::ElementFactory::make("audiotestsrc")
        .property("is-live", true)
        .property("freq", freq.max(1.0))
        .property("volume", if freq > 0.0 { 0.3 } else { 0.0 })
        .build()
        .map_err(|e| format!("audiotestsrc: {e}"))?;
    src.set_property_from_str("wave", "sine");
    let convert = gst::ElementFactory::make("audioconvert")
        .build()
        .map_err(|e| format!("audioconvert: {e}"))?;

    pipeline
        .add(&src)
        .and_then(|()| pipeline.add(&convert))
        .map_err(|e| format!("add audio branch: {e}"))?;
    gst::Element::link_many([&src, &convert]).map_err(|e| format!("link audio branch: {e}"))?;
    convert
        .static_pad("src")
        .ok_or("audio branch: no src pad")?
        .link(&pad)
        .map_err(|e| format!("link audio branch to isel: {e}"))?;

    let elements = vec![src, convert];
    for el in &elements {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync_state_with_parent (audio): {e}"))?;
    }
    Ok(Branch { elements, pad })
}

/// Entfernt die Elemente eines Zweigs (State Null + aus der Pipeline
/// entfernen) — das dazugehörige isel-Sink-Pad bleibt bestehen (anders als
/// C11s `remove_channel_branch`, das den Pad selbst freigibt), damit
/// `replace_slot` denselben Pad-Referenzwert wiederverwenden kann.
fn teardown_branch(pipeline: &gst::Pipeline, branch: &Branch) {
    if let Some(src_pad) = branch.elements.last().and_then(|el| el.static_pad("src")) {
        let _ = src_pad.unlink(&branch.pad);
    }
    for el in &branch.elements {
        let _ = el.set_state(gst::State::Null);
        let _ = pipeline.remove(el);
    }
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    video_isel: Option<gst::Element>,
    audio_isel: gst::Element,
    video_branches: HashMap<Slot, Branch>,
    audio_branches: HashMap<Slot, Branch>,
    _mxl_video_output: Option<MxlVideoOutput>,
    _mxl_audio_output: MxlAudioOutput,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn replace_slot(active: &mut ActivePipeline, slot: Slot, item: &Item) -> Result<(), String> {
    if active.video_isel.is_some()
        && let Some(old) = active.video_branches.remove(&slot)
    {
        let pad = old.pad.clone();
        teardown_branch(&active.pipeline, &old);
        let branch = build_video_branch(&active.pipeline, pad, &item.pattern)?;
        active.video_branches.insert(slot, branch);
    }
    if let Some(old) = active.audio_branches.remove(&slot) {
        let pad = old.pad.clone();
        teardown_branch(&active.pipeline, &old);
        let branch = build_audio_branch(&active.pipeline, pad, item.tone_freq)?;
        active.audio_branches.insert(slot, branch);
    }
    Ok(())
}

fn apply_active(active: &ActivePipeline, slot: Slot) {
    if let Some(isel) = &active.video_isel
        && let Some(branch) = active.video_branches.get(&slot)
    {
        isel.set_property("active-pad", &branch.pad);
    }
    if let Some(branch) = active.audio_branches.get(&slot) {
        active
            .audio_isel
            .set_property("active-pad", &branch.pad);
    }
}

fn build(context: &Arc<MxlContext>, config: &Config) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let video_isel = if config.has_video {
        let isel = gst::ElementFactory::make("input-selector")
            .name("video_isel")
            .property("sync-streams", false)
            .build()
            .map_err(|e| format!("video input-selector: {e}"))?;
        pipeline
            .add(&isel)
            .map_err(|e| format!("add video isel: {e}"))?;
        Some(isel)
    } else {
        None
    };

    let audio_isel = gst::ElementFactory::make("input-selector")
        .name("audio_isel")
        .property("sync-streams", false)
        .build()
        .map_err(|e| format!("audio input-selector: {e}"))?;
    pipeline
        .add(&audio_isel)
        .map_err(|e| format!("add audio isel: {e}"))?;

    let empty_item = Item {
        pattern: EMPTY_PATTERN.to_string(),
        tone_freq: EMPTY_TONE_FREQ,
    };

    let mut video_branches = HashMap::new();
    let mut audio_branches = HashMap::new();
    for slot in [Slot::A, Slot::B] {
        if let Some(isel) = &video_isel {
            let pad = isel
                .request_pad_simple(&format!("sink_{}", slot.pad_index()))
                .ok_or_else(|| format!("video isel: request sink_{} failed", slot.pad_index()))?;
            let branch = build_video_branch(&pipeline, pad, &empty_item.pattern)?;
            video_branches.insert(slot, branch);
        }
        let pad = audio_isel
            .request_pad_simple(&format!("sink_{}", slot.pad_index()))
            .ok_or_else(|| format!("audio isel: request sink_{} failed", slot.pad_index()))?;
        let branch = build_audio_branch(&pipeline, pad, empty_item.tone_freq)?;
        audio_branches.insert(slot, branch);
    }

    let mxl_video_output = if let Some(isel) = &video_isel {
        let output = MxlVideoOutput::new(
            &pipeline,
            isel,
            context.clone(),
            &config.video_flow_id,
            &config.label,
            WIDTH,
            HEIGHT,
            FRAMERATE_NUMERATOR,
            FRAMERATE_DENOMINATOR,
        )
        .map_err(|e| format!("MxlVideoOutput: {e}"))?;
        output.set_active(true);
        Some(output)
    } else {
        None
    };

    let mxl_audio_output = MxlAudioOutput::new(
        &pipeline,
        &audio_isel,
        context.clone(),
        &config.audio_flow_id,
        &config.label,
        SAMPLE_RATE,
        CHANNELS,
    )
    .map_err(|e| format!("MxlAudioOutput: {e}"))?;
    mxl_audio_output.set_active(true);

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    // Slot A ist initial aktiv (beide Slots sind zu diesem Zeitpunkt noch
    // "schwarz/still" — s. `EMPTY_PATTERN`/`EMPTY_TONE_FREQ`), damit die
    // `active-pad`-Property von Anfang an einen definierten Wert hat statt
    // GStreamers Default (erster requesteter Pad, zufällig deckungsgleich,
    // aber nicht explizit).
    if let Some(isel) = &video_isel {
        isel.set_property("active-pad", &video_branches[&Slot::A].pad);
    }
    audio_isel.set_property("active-pad", &audio_branches[&Slot::A].pad);

    Ok(ActivePipeline {
        pipeline,
        video_isel,
        audio_isel,
        video_branches,
        audio_branches,
        _mxl_video_output: mxl_video_output,
        _mxl_audio_output: mxl_audio_output,
    })
}

/// Läuft auf einem eigenen Thread (analog `omp-audio-mixer`s `pipeline::run`,
/// C11) — ein dauerhafter `build()`-Aufruf, Slots werden dynamisch
/// umgebaut, kein Pipeline-Rebuild-auf-Kommando-Pfad.
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

    let mut active = match build(&context, &config) {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("initial build failed: {e}")));
            let _ = ready.send(Err(e));
            return;
        }
    };

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
            Ok(Command::LoadSlot { slot, item }) => {
                if let Err(e) = replace_slot(&mut active, slot, &item) {
                    let _ = tx.send(Event::Error(format!("cue into slot {slot:?} failed: {e}")));
                }
            }
            Ok(Command::SetActive(slot)) => {
                apply_active(&active, slot);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
