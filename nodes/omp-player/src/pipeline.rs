//! GStreamer-Pipeline von `omp-player` (`UMSETZUNG.md` C12/K2-Teil-1,
//! `ARCHITECTURE.md` §13.3): generalisiertes `PlaylistController`-Muster
//! (§11.1) für Musik-/Jingle-Player und Videoplayer in einer Codebasis,
//! manueller Cue/Take-Betrieb (Automation erst C14/C15).
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
//! **Zwei Item-Quellen (`ItemSource`, K2-Teil-1, `docs/END-GOAL-
//! FEATURES.md` §2.3):** `TestPattern` ist der ursprüngliche Stand
//! (`videotestsrc`/`audiotestsrc`, Software-Testmittel, `UMSETZUNG.md`
//! §0 Punkt 7 — bleibt das CI-Testmittel, kein Dateizugriff nötig) und
//! neu `File` (echte MP4/MOV-Wiedergabe über `uridecodebin`). MXF
//! (mxfdemux-Workaround, Multi-Mono-Audio-Downmix, SOM/EOM-Trim) ist
//! bewusst K2-Teil-2, hier nicht enthalten.
//!
//! **EOS ist bei `File`-Items erstklassig, bei `TestPattern` weiterhin
//! irrelevant:** `videotestsrc`/`audiotestsrc` laufen endlos (kein EOS),
//! ein Datei-Zweig aber erreicht real das Dateiende. Da dieselbe
//! Pipeline dauerhaft beide Slots bedient, darf ein EOS niemals bis zum
//! Bus/den MXL-Ausgängen durchschlagen (sonst ginge die gesamte Pipeline
//! in den EOS-Zustand über, inklusive des jeweils anderen Slots) — ein
//! `EVENT_DOWNSTREAM`-Pad-Probe direkt vor dem isel-Sink-Pad verwirft
//! das EOS-Event immer und meldet `Event::ItemEnded` nur dann nach
//! außen, wenn der betroffene Slot zum Zeitpunkt des EOS tatsächlich
//! on-air war (`onair_slot`, per `Arc<AtomicU8>` aus dem Kommando-Pfad
//! gespiegelt) — ein bereits abgelaufenes, aber nie genommenes Cue soll
//! keinen Event auslösen.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

/// Fallback, falls `main.rs` keine `OMP_WIDTH`/`OMP_HEIGHT`-Umgebungs-
/// variable findet (Kapitel 15, docs/END-GOAL-FEATURES.md §15.3c,
/// 2026-07-17: Workflow-Auflösungs-Setting) — `Config::width`/`height`
/// tragen den tatsächlich verwendeten Wert, diese Konstanten sind nur
/// noch der Default dafür, keine feste Pipeline-Vorgabe mehr.
pub const DEFAULT_WIDTH: u32 = 640;
pub const DEFAULT_HEIGHT: u32 = 480;
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
    pub width: u32,
    pub height: u32,
}

/// Woher ein Item seine Essenz bezieht — additiv zum ursprünglichen
/// `TestPattern`-Feldpaar (K2-Teil-1, `docs/END-GOAL-FEATURES.md` §2.3).
#[derive(Clone, Debug)]
pub enum ItemSource {
    TestPattern { pattern: String, tone_freq: f64 },
    File { uri: String },
}

#[derive(Clone, Debug)]
pub struct Item {
    /// Nur für `File`-Items ausgewertet (EOS→`Event::ItemEnded`-
    /// Zuordnung) — bei `TestPattern`-Items (inkl. der internen
    /// "schwarz/still"-Defaults) bedeutungslos, da dort nie EOS auftritt.
    pub id: String,
    pub source: ItemSource,
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

    fn code(self) -> u8 {
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
    /// EOS des On-Air-Zweigs eines `File`-Items (`item.id`) — s.
    /// Moduldoku. `main.rs` veröffentlicht daraus
    /// `omp.player.<node_id>.itemEnded`.
    ItemEnded { item_id: String },
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    video_flowed: Option<Arc<AtomicBool>>,
    audio_flowed: Arc<AtomicBool>,
}

impl PipelineHandle {
    pub fn load_slot(&self, slot: Slot, item: Item) {
        let _ = self.commands.send(Command::LoadSlot { slot, item });
    }

    pub fn set_active(&self, slot: Slot) {
        let _ = self.commands.send(Command::SetActive(slot));
    }

    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2):
    /// Audio-Ausgang immer erforderlich, Video nur im Video-Profil
    /// (`config.has_video` — im Jingle-Profil gibt es keinen
    /// MxlVideoOutput, s. `build()`, dann zählt nur Audio).
    pub fn media_ready(&self) -> bool {
        self.audio_flowed.load(Ordering::Relaxed)
            && self
                .video_flowed
                .as_ref()
                .is_none_or(|f| f.load(Ordering::Relaxed))
    }
}

fn video_caps(width: u32, height: u32) -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("width", width as i32)
        .field("height", height as i32)
        .field(
            "framerate",
            gst::Fraction::new(FRAMERATE_NUMERATOR as i32, FRAMERATE_DENOMINATOR as i32),
        )
        .build()
}

/// Konform-Caps für `File`-Audiozweige (`docs/END-GOAL-FEATURES.md`
/// §2.3: "audioconvert ! audioresample ! capsfilter(F32/48k/2ch)").
/// `build_audio_branch` (TestPattern) braucht das nicht — `audiotestsrc`
/// liefert bereits passendes Rohformat —, aber ein Datei-Zweig sollte vor
/// dem isel bereits konform sein, damit ein `take()`-Wechsel zwischen
/// unterschiedlich formatierten Zweigen kein Renegotiation-Risiko am
/// isel-Sink-Pad birgt (`MxlAudioOutput` normalisiert zwar selbst noch
/// einmal danach, s. `omp-mediaio::mxl::audio_caps`, das ersetzt aber
/// nicht die Konformität der einzelnen Zweige untereinander).
fn audio_caps() -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("rate", SAMPLE_RATE as i32)
        .field("channels", CHANNELS as i32)
        .field("layout", "interleaved")
        .build()
}

/// Ein Slot-Zweig: die Elemente einer Medienart (Video oder Audio) hinter
/// einem festen isel-Sink-Pad. Bei `TestPattern`-Zweigen ist
/// `elements[0]` immer die Quelle (`videotestsrc`/`audiotestsrc`); bei
/// `File`-Zweigen (K2-Teil-1) teilen sich Video- und Audio-Branch EIN
/// `uridecodebin` — dessen Ownership liegt bewusst beim Audio-Branch
/// (immer vorhanden, anders als der optionale Video-Branch im
/// Jingle-Profil), s. `build_file_branches`. `elements.last()` ist immer
/// das Element, dessen Src-Pad auf `pad` verlinkt ist.
struct Branch {
    elements: Vec<gst::Element>,
    pad: gst::Pad,
}

fn build_video_branch(
    pipeline: &gst::Pipeline,
    pad: gst::Pad,
    pattern: &str,
    width: u32,
    height: u32,
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
        .property("caps", video_caps(width, height))
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

/// Hängt einen Pad-Probe ans `EVENT_DOWNSTREAM`-Signal von `pad` (der
/// isel-seitige Src-Pad eines `File`-Zweigs), der jedes EOS-Event
/// verwirft (s. Moduldoku) und — höchstens einmal pro Branch-Paar
/// (`reported`, gemeinsam von Video- und Audio-Probe geteilt, da beide
/// vom selben `uridecodebin` etwa zeitgleich EOS bekommen) — bei
/// aktuell on-air stehendem Slot `Event::ItemEnded` nach außen meldet.
fn add_eos_probe(
    pad: &gst::Pad,
    tx: UnboundedSender<Event>,
    slot: Slot,
    item_id: String,
    onair_slot: Arc<AtomicU8>,
    reported: Arc<AtomicBool>,
) {
    let slot_code = slot.code();
    pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_pad, info| {
        if let Some(event) = info.event()
            && let gst::EventView::Eos(_) = event.view()
        {
            if !reported.swap(true, Ordering::SeqCst) && onair_slot.load(Ordering::Relaxed) == slot_code {
                let _ = tx.send(Event::ItemEnded {
                    item_id: item_id.clone(),
                });
            }
            return gst::PadProbeReturn::Drop;
        }
        gst::PadProbeReturn::Ok
    });
}

/// Baut Video- (falls `video_pad` gesetzt) und Audio-Zweig für ein
/// `File`-Item aus einem gemeinsamen `uridecodebin` (K2-Teil-1,
/// proven-Pattern-Referenz `PIPELINE CONTROLLER/lib/PlayerPipeline.js`:
/// `uridecodebin name=db uri="…" expose-all-streams=false`, s.
/// `UMSETZUNG.md` §0 Punkt 9 — der dortige `mxfdemux`-Doppel-Play-
/// Workaround ist K2-Teil-2-Scope, hier nicht nachgebaut). Dynamische
/// Pads werden per `pad-added` an die vorab aufgebauten Konform-Ketten
/// gebunden (Standard-GStreamer-Muster, in diesem Rust-Codebase neu für
/// dieses Crate). Ownership des `uridecodebin` liegt beim Audio-Branch
/// (`elements[0]`) — s. `Branch`-Doc.
#[allow(clippy::too_many_arguments)]
fn build_file_branches(
    pipeline: &gst::Pipeline,
    video_pad: Option<gst::Pad>,
    audio_pad: gst::Pad,
    uri: &str,
    item_id: String,
    slot: Slot,
    onair_slot: Arc<AtomicU8>,
    tx: UnboundedSender<Event>,
    width: u32,
    height: u32,
) -> Result<(Option<Branch>, Branch), String> {
    let video_chain = if let Some(pad) = video_pad {
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
            .property("caps", video_caps(width, height))
            .build()
            .map_err(|e| format!("capsfilter(video): {e}"))?;
        // `queue` statt Direktverlinkung auf `pad` (K2-Teil-1 Nachtrag,
        // docs/decisions.md): erzeugt eine echte Thread-Grenze zwischen
        // `uridecodebin`s internem `multiqueue`-Streaming-Thread und dem
        // EOS-Probe unten. Ohne diese Grenze liegt der Probe auf
        // demselben Thread wie `uridecodebin`s eigene, rekursive
        // `gst_pad_forward`-EOS-Verteilung an seine internen Ghost-Pads
        // — ein per gdb reproduzierter `gst_mini_object_unref`-Crash
        // (Use-after-free auf dem EOS-Event) trat genau dort auf, nie
        // ohne den Probe. Ein `queue` dahinter behebt das (Standard-
        // GStreamer-Pattern für "einen Zweig unabhängig von seiner
        // Quelle EOS-behandeln"), kein Sonderfall für dieses Crate.
        let queue = gst::ElementFactory::make("queue")
            .build()
            .map_err(|e| format!("queue(video): {e}"))?;
        pipeline
            .add(&convert)
            .and_then(|()| pipeline.add(&scale))
            .and_then(|()| pipeline.add(&rate))
            .and_then(|()| pipeline.add(&caps))
            .and_then(|()| pipeline.add(&queue))
            .map_err(|e| format!("add file video chain: {e}"))?;
        gst::Element::link_many([&convert, &scale, &rate, &caps, &queue])
            .map_err(|e| format!("link file video chain: {e}"))?;
        queue
            .static_pad("src")
            .ok_or("file video chain: no src pad")?
            .link(&pad)
            .map_err(|e| format!("link file video chain to isel: {e}"))?;
        Some((vec![convert, scale, rate, caps, queue.clone()], queue, pad))
    } else {
        None
    };

    let a_convert = gst::ElementFactory::make("audioconvert")
        .build()
        .map_err(|e| format!("audioconvert: {e}"))?;
    let a_resample = gst::ElementFactory::make("audioresample")
        .build()
        .map_err(|e| format!("audioresample: {e}"))?;
    let a_caps = gst::ElementFactory::make("capsfilter")
        .property("caps", audio_caps())
        .build()
        .map_err(|e| format!("capsfilter(audio): {e}"))?;
    // s. Kommentar an der Video-`queue` oben — dieselbe Thread-
    // Entkopplung ist für den Audio-Zweig genauso nötig.
    let a_queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue(audio): {e}"))?;
    pipeline
        .add(&a_convert)
        .and_then(|()| pipeline.add(&a_resample))
        .and_then(|()| pipeline.add(&a_caps))
        .and_then(|()| pipeline.add(&a_queue))
        .map_err(|e| format!("add file audio chain: {e}"))?;
    gst::Element::link_many([&a_convert, &a_resample, &a_caps, &a_queue])
        .map_err(|e| format!("link file audio chain: {e}"))?;
    a_queue
        .static_pad("src")
        .ok_or("file audio chain: no src pad")?
        .link(&audio_pad)
        .map_err(|e| format!("link file audio chain to isel: {e}"))?;

    let src = gst::ElementFactory::make("uridecodebin")
        .property("uri", uri)
        .property("expose-all-streams", false)
        .build()
        .map_err(|e| format!("uridecodebin: {e}"))?;
    pipeline
        .add(&src)
        .map_err(|e| format!("add uridecodebin: {e}"))?;

    let video_sink_pad = video_chain
        .as_ref()
        .and_then(|(elements, _, _)| elements.first())
        .and_then(|convert| convert.static_pad("sink"));
    let audio_sink_pad = a_convert.static_pad("sink").ok_or("audioconvert: no sink pad")?;
    src.connect_pad_added(move |_src, new_pad| {
        // `expose-all-streams=false` liefert nur dekodierte
        // audio/video-Rohpads (kein Subtitle o. ä.) — welche
        // Medienart, steht nur in den ausgehandelten Caps, nicht im
        // generischen "src_%u"-Padnamen (s. `UMSETZUNG.md` §0 Punkt 9:
        // "db.src_<N>"-Adressierung ist grundsätzlich falsch).
        let Some(caps) = new_pad.current_caps() else {
            return;
        };
        let Some(structure) = caps.structure(0) else {
            return;
        };
        let name = structure.name();
        let target = if name.starts_with("video/") {
            video_sink_pad.as_ref()
        } else if name.starts_with("audio/") {
            Some(&audio_sink_pad)
        } else {
            None
        };
        let Some(target) = target else { return };
        if target.is_linked() {
            return;
        }
        if let Err(e) = new_pad.link(target) {
            eprintln!("omp-player: uridecodebin pad-added link failed: {e:?}");
        }
    });

    // Datei enthält eine Spur, für die kein Ziel existiert (z. B.
    // Video-Track im Jingle-Profil ohne Video-isel): bleibt unverlinkt.
    // `uridecodebin`/`decodebin3` behandeln das intern (eigener
    // Streaming-Thread je Pad) — kein Blocker für die andere Spur, aber
    // eine dokumentierte Grenze (`docs/END-GOAL-FEATURES.md` §2.3
    // "Ehrliche Grenzen").

    let reported = Arc::new(AtomicBool::new(false));
    if let Some((_, queue_el, _)) = &video_chain {
        let pad = queue_el.static_pad("src").ok_or("file video chain: no src pad (probe)")?;
        add_eos_probe(&pad, tx.clone(), slot, item_id.clone(), onair_slot.clone(), reported.clone());
    }
    {
        let pad = a_queue.static_pad("src").ok_or("file audio chain: no src pad (probe)")?;
        add_eos_probe(&pad, tx, slot, item_id, onair_slot, reported);
    }

    src.sync_state_with_parent()
        .map_err(|e| format!("sync_state_with_parent (uridecodebin): {e}"))?;

    let video_branch = video_chain.map(|(elements, _, pad)| Branch { elements, pad });
    for el in video_branch.iter().flat_map(|b| &b.elements) {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync_state_with_parent (file video): {e}"))?;
    }

    let mut audio_elements = vec![src];
    audio_elements.extend([a_convert, a_resample, a_caps, a_queue]);
    for el in &audio_elements {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync_state_with_parent (file audio): {e}"))?;
    }
    let audio_branch = Branch {
        elements: audio_elements,
        pad: audio_pad,
    };

    Ok((video_branch, audio_branch))
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
    width: u32,
    height: u32,
    _mxl_video_output: Option<MxlVideoOutput>,
    _mxl_audio_output: MxlAudioOutput,
    video_flowed: Option<Arc<AtomicBool>>,
    audio_flowed: Arc<AtomicBool>,
    /// Spiegelt, welcher Slot gerade on-air ist — von `apply_active()`
    /// gepflegt, von den EOS-Probes aus `build_file_branches` gelesen
    /// (s. Moduldoku). Kein Mutex nötig, ein einzelnes Byte reicht.
    onair_slot: Arc<AtomicU8>,
    event_tx: UnboundedSender<Event>,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn replace_slot(active: &mut ActivePipeline, slot: Slot, item: &Item) -> Result<(), String> {
    let old_video_pad = if active.video_isel.is_some() {
        active.video_branches.remove(&slot).map(|old| {
            let pad = old.pad.clone();
            teardown_branch(&active.pipeline, &old);
            pad
        })
    } else {
        None
    };
    let old_audio = active
        .audio_branches
        .remove(&slot)
        .ok_or("replace_slot: audio branch missing")?;
    let audio_pad = old_audio.pad.clone();
    teardown_branch(&active.pipeline, &old_audio);

    match &item.source {
        ItemSource::TestPattern { pattern, tone_freq } => {
            if let Some(pad) = old_video_pad {
                let branch =
                    build_video_branch(&active.pipeline, pad, pattern, active.width, active.height)?;
                active.video_branches.insert(slot, branch);
            }
            let branch = build_audio_branch(&active.pipeline, audio_pad, *tone_freq)?;
            active.audio_branches.insert(slot, branch);
        }
        ItemSource::File { uri } => {
            let (video_branch, audio_branch) = build_file_branches(
                &active.pipeline,
                old_video_pad,
                audio_pad,
                uri,
                item.id.clone(),
                slot,
                active.onair_slot.clone(),
                active.event_tx.clone(),
                active.width,
                active.height,
            )?;
            if let Some(branch) = video_branch {
                active.video_branches.insert(slot, branch);
            }
            active.audio_branches.insert(slot, audio_branch);
        }
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
    active.onair_slot.store(slot.code(), Ordering::Relaxed);
}

fn build(
    context: &Arc<MxlContext>,
    config: &Config,
    event_tx: UnboundedSender<Event>,
) -> Result<ActivePipeline, String> {
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
        id: String::new(),
        source: ItemSource::TestPattern {
            pattern: EMPTY_PATTERN.to_string(),
            tone_freq: EMPTY_TONE_FREQ,
        },
    };
    let ItemSource::TestPattern {
        pattern: empty_pattern,
        tone_freq: empty_tone_freq,
    } = &empty_item.source
    else {
        unreachable!("empty_item is always TestPattern")
    };

    let mut video_branches = HashMap::new();
    let mut audio_branches = HashMap::new();
    for slot in [Slot::A, Slot::B] {
        if let Some(isel) = &video_isel {
            let pad = isel
                .request_pad_simple(&format!("sink_{}", slot.pad_index()))
                .ok_or_else(|| format!("video isel: request sink_{} failed", slot.pad_index()))?;
            let branch = build_video_branch(&pipeline, pad, empty_pattern, config.width, config.height)?;
            video_branches.insert(slot, branch);
        }
        let pad = audio_isel
            .request_pad_simple(&format!("sink_{}", slot.pad_index()))
            .ok_or_else(|| format!("audio isel: request sink_{} failed", slot.pad_index()))?;
        let branch = build_audio_branch(&pipeline, pad, *empty_tone_freq)?;
        audio_branches.insert(slot, branch);
    }

    let mxl_video_output = if let Some(isel) = &video_isel {
        let output = MxlVideoOutput::new(
            &pipeline,
            isel,
            context.clone(),
            &config.video_flow_id,
            &config.label,
            config.width,
            config.height,
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

    let video_flowed = mxl_video_output.as_ref().map(|o| o.flowed_handle());
    let audio_flowed = mxl_audio_output.flowed_handle();

    Ok(ActivePipeline {
        pipeline,
        video_isel,
        audio_isel,
        video_branches,
        audio_branches,
        width: config.width,
        height: config.height,
        _mxl_video_output: mxl_video_output,
        _mxl_audio_output: mxl_audio_output,
        video_flowed,
        audio_flowed,
        onair_slot: Arc::new(AtomicU8::new(Slot::A.code())),
        event_tx,
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

    let mut active = match build(&context, &config, tx.clone()) {
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
        video_flowed: active.video_flowed.clone(),
        audio_flowed: active.audio_flowed.clone(),
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
