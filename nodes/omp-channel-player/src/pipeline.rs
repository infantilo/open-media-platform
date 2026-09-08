//! omp-channel-player: einzweigige, Isel-freie "Kanal"-Wiedergabe
//! (Kapitel 6 Teil 6, `docs/decisions.md` neuer Nachtrag) — gedacht als
//! EINE von zwei physischen Quellen am Video-Mixer-Crosspoint für echten
//! Crossfade (`docs/END-GOAL-FEATURES.md:1203-1211`, "ehrliche v1-Grenze:
//! Xfade nur zwischen zwei Player-Instanzen"). `load()` reißt den
//! aktuellen Zweig komplett ab und baut den neuen direkt bis `Playing`
//! neu auf — kein `input-selector`, keine A/B-Slots, kein
//! Active-Pad-Umschalten. Exakt das Muster aus
//! `omp-mxf-player-direct::pipeline::build()` (dort für den EOS-Loop-
//! Zyklus bereits bewiesen: EINE fertig aufgebaute Pipeline, EIN
//! Sammel-Übergang nach `Playing`, kein mehrphasiger Preroll-Tanz nötig,
//! weil nie in eine bereits laufende, geteilte Pipeline hineingebaut
//! wird) — hier verallgemeinert von "immer dieselbe MXF-Datei" auf
//! `TestPattern`/`File`(MXF ODER generisch)/`Live`.
//!
//! **Element-Konstruktion pro Quellart wortgleich/angepasst übernommen**
//! (§0 Punkt 9 — kopiert, nicht neu hergeleitet):
//! - `TestPattern`/`File`(generisch, `uridecodebin`)/`Live` (`MxlVideoInput`/
//!   `MxlAudioInput`) aus `omp-player/src/pipeline.rs` — dort allerdings
//!   hinter einem `input-selector`-Sink-Pad, hier direkt vor die
//!   `MxlVideoOutput`/`MxlAudioOutput`-Kette verkabelt.
//! - `File`(MXF, `filesrc`!`mxfdemux`, Multi-Mono-Audiogruppen-Interleave
//!   "Audio-Shuffling") aus `omp-mxf-player-direct/src/pipeline.rs`,
//!   selbst wortgleich aus `omp-mxf-player/src/pipeline.rs::
//!   build_mxf_branch` — hier auf EINE feste Ausgabegruppe
//!   (Programmton/Stereo-Preset, s. `presets.rs`) verengt, weil dieser
//!   Node (anders als `omp-mxf-player[-direct]`) genau EINEN Video- +
//!   EINEN Audio-Sender hat (gleiche Kontraktform wie jeder andere
//!   Player-Node, s. `main.rs`).
//!
//! **Anlass:** Live-Diagnose im "Playout"-Workflow (clip→live→clip) ergab,
//! dass `omp-player`s `input-selector`-Active-Pad-Umschaltung das
//! ausgegebene Bild nach dem ersten Take dauerhaft einfriert (MXL-
//! Grain-Index läuft weiter, Bildinhalt nicht — bestätigt per `mxl-info`
//! und Viewer-Frame-Grab). Dieser Node hat strukturell kein
//! Active-Pad-Switching mehr, der Bug kann hier nicht auftreten.
//!
//! **EOS-Loop** (nur für `File`-Items relevant, `TestPattern`/`Live` sind
//! endlose Live-Quellen): wie bei `omp-mxf-player-direct` baut ein echtes
//! Dateiende den ZULETZT geladenen Zweig automatisch neu auf (dieselben
//! MXL-`flow_id`s bleiben über jeden Zyklus gleich) statt für immer
//! stillzustehen — bis das nächste `load()` etwas anderes vorgibt.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext, MxlVideoInput, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use crate::presets;

pub const DEFAULT_WIDTH: u32 = 1920;
pub const DEFAULT_HEIGHT: u32 = 1080;
pub const FRAMERATE_NUMERATOR: u32 = 25;
pub const FRAMERATE_DENOMINATOR: u32 = 1;
pub const SAMPLE_RATE: u32 = 48000;
pub const CHANNELS: u32 = 2;
/// Default-Pattern/-Ton für einen Live-Item ohne gefundenen Video- bzw.
/// Audio-Begleiter (s. `ItemSource::Live`-Doku) — gleicher "schwarz/
/// still"-Fallback wie `omp-player`s `EMPTY_PATTERN`/`EMPTY_TONE_FREQ`.
pub const EMPTY_PATTERN: &str = "black";
const EMPTY_TONE_FREQ: f64 = 0.0;
/// Programmgruppe, die dieser Node aus einer MXF-Datei ausspielt — dieser
/// Node hat (anders als `omp-mxf-player[-direct]`) nur EINEN Audio-
/// Sender, s. Moduldoku. "pt"/"stereo" ist derselbe Fallback wie
/// `omp-mxf-player-direct`s eigener Default.
const MXF_GROUP_ID: &str = "pt";
const MXF_PRESET_ID: &str = "stereo";

pub struct Config {
    pub domain: String,
    pub video_flow_id: String,
    pub audio_flow_id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
}

/// Woher ein geladenes Item seine Essenz bezieht — deckungsgleich mit
/// `omp-player`s `ItemMedia`/`pipeline::ItemSource` (C21), s. Moduldoku.
#[derive(Clone, Debug)]
pub enum ItemSource {
    TestPattern { pattern: String, tone_freq: f64 },
    /// Absoluter Dateipfad (Auflösung/Traversal-Schutz passiert in
    /// `main.rs`, s. dortiges `resolve_media_path`) — `.mxf`
    /// (Groß-/Kleinschreibung egal) wählt den MXF-Pfad
    /// (`build_mxf_file`), alles andere den generischen
    /// `uridecodebin`-Pfad (`build_generic_file`).
    File { path: String },
    /// Bereits von `main.rs` (`discovery::resolve`) zu MXL-Flow-IDs
    /// aufgelöste Live-Quelle — `pipeline.rs` bleibt registry-agnostisch
    /// (gleiche Trennung wie `omp-player`). `None` fällt auf
    /// schwarz/stumm zurück, kein harter Fehler.
    Live { video_flow_id: Option<String>, audio_flow_id: Option<String> },
}

fn media_type_str(source: &ItemSource) -> &'static str {
    match source {
        ItemSource::TestPattern { .. } => "pattern",
        ItemSource::File { path } if path.to_ascii_lowercase().ends_with(".mxf") => "mxf",
        ItemSource::File { .. } => "file",
        ItemSource::Live { .. } => "live",
    }
}

#[derive(Clone, Debug)]
pub struct Item {
    pub label: String,
    pub source: ItemSource,
    /// Vorab bekannte Dauer (z. B. vom Aufrufer mitgeschickt oder per
    /// `gst_pbutils::Discoverer` vorab ermittelt, s. `main.rs`) — `None`
    /// lässt `durationMs` bei `0`, bis der Positions-/Dauer-Poll-Tick
    /// (nur MXF/generische Datei, s. `run()`) einen echten Wert liefert.
    pub duration_hint_ms: Option<i64>,
}

pub enum Event {
    Error(String),
}

enum Command {
    Load(Item),
}

/// Vereinigt externe Kommandos UND das interne "Zyklus zu Ende"-Signal in
/// EINEM Kanal — identisches Muster wie `omp-mxf-player-direct::pipeline::
/// LoopEvent`.
enum LoopEvent {
    CycleDone,
    Cmd(Command),
}

struct SharedState {
    label: String,
    media_type: String,
    // Vom jeweils AKTUELLEN Baulauf übernommen (s. `omp-mxf-player-direct`s
    // identisches Muster) — ein fester Wert wäre nach jedem `load()`/
    // EOS-Neuaufbau bereits veraltet (neue `MxlVideoOutput`/
    // `MxlAudioOutput`-Instanz, neues `AtomicBool`).
    video_flowed: Arc<AtomicBool>,
    audio_flowed: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct PipelineHandle {
    events: std::sync::mpsc::Sender<LoopEvent>,
    shared: Arc<Mutex<SharedState>>,
    position_ms: Arc<AtomicI64>,
    duration_ms: Arc<AtomicI64>,
}

impl PipelineHandle {
    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6) — Video- UND
    /// Audio-Ausgang müssen jeweils mindestens einmal geflossen sein.
    pub fn media_ready(&self) -> bool {
        let s = self.shared.lock().expect("lock poisoned");
        s.video_flowed.load(Ordering::Relaxed) && s.audio_flowed.load(Ordering::Relaxed)
    }

    pub fn load(&self, item: Item) {
        let _ = self.events.send(LoopEvent::Cmd(Command::Load(item)));
    }

    pub fn current_label(&self) -> String {
        self.shared.lock().expect("lock poisoned").label.clone()
    }

    pub fn media_type(&self) -> String {
        self.shared.lock().expect("lock poisoned").media_type.clone()
    }

    pub fn position_ms(&self) -> i64 {
        self.position_ms.load(Ordering::Relaxed)
    }

    pub fn duration_ms(&self) -> i64 {
        self.duration_ms.load(Ordering::Relaxed)
    }
}

fn video_caps(width: u32, height: u32) -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("width", width as i32)
        .field("height", height as i32)
        .field("framerate", gst::Fraction::new(FRAMERATE_NUMERATOR as i32, FRAMERATE_DENOMINATOR as i32))
        .build()
}

fn audio_caps() -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("rate", SAMPLE_RATE as i32)
        .field("channels", CHANNELS as i32)
        .field("layout", "interleaved")
        .build()
}

/// S. `omp-mxf-player-direct/src/pipeline.rs`s gleichnamige Funktion —
/// wortgleich übernommen (reine Werteumformung).
fn matrix_to_gst_array(matrix: &[Vec<f64>]) -> gst::Array {
    gst::Array::new(matrix.iter().map(|row| gst::Array::new(row.iter().copied())))
}

/// `gst::Element::set_property_from_str` panikt INTERN (kein `Result`,
/// kein per `?` fangbarer Fehler), wenn `nick` kein gültiger Wert der
/// Ziel-Enum-Property ist — live gefunden: ein Tippfehler im
/// `pattern`-Argument von `invoke("load", ...)` (z. B. `"ebu"` statt
/// `"ebu-bars"`) riss den kompletten Pipeline-Thread mit runter, der
/// Node blieb danach dauerhaft unbedienbar (kein Prozess-Crash, nur ein
/// still gestorbener Thread — dieselbe Fallen-Kategorie wie das
/// dokumentierte "HTTP-Erfolg heißt nur enqueued"-Muster andernorts in
/// diesem Projekt). Hier vorab per `glib::EnumClass` geprüft, ein
/// unbekannter Wert wird als regulärer `Err` gemeldet statt den Prozess
/// zu gefährden.
fn set_enum_property_checked(el: &gst::Element, prop: &str, nick: &str) -> Result<(), String> {
    let pspec = el.find_property(prop).ok_or_else(|| format!("{prop}: unbekannte Property"))?;
    let enum_class = gst::glib::EnumClass::with_type(pspec.value_type()).ok_or_else(|| format!("{prop}: keine Enum-Property"))?;
    if enum_class.value_by_nick(nick).is_none() {
        return Err(format!("{prop}: unbekannter Wert {nick:?}"));
    }
    el.set_property_from_str(prop, nick);
    Ok(())
}

/// `TestPattern`-Videozweig — aus `omp-player::build_video_branch`
/// übernommen, ohne den dortigen isel-Sink-Pad-Link (hier gibt der
/// Aufrufer den `caps`-Tail direkt an `MxlVideoOutput::new_paced`
/// weiter). Auch als "schwarz"-Fallback für `ItemSource::Live` ohne
/// gefundenen Video-Begleiter verwendet.
fn build_testpattern_video(pipeline: &gst::Pipeline, pattern: &str, width: u32, height: u32) -> Result<gst::Element, String> {
    let src = gst::ElementFactory::make("videotestsrc")
        .property("is-live", true)
        .build()
        .map_err(|e| format!("videotestsrc: {e}"))?;
    set_enum_property_checked(&src, "pattern", pattern)?;
    let convert = gst::ElementFactory::make("videoconvert").build().map_err(|e| format!("videoconvert: {e}"))?;
    let scale = gst::ElementFactory::make("videoscale").build().map_err(|e| format!("videoscale: {e}"))?;
    let rate = gst::ElementFactory::make("videorate").build().map_err(|e| format!("videorate: {e}"))?;
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
        .map_err(|e| format!("add testpattern video: {e}"))?;
    gst::Element::link_many([&src, &convert, &scale, &rate, &caps]).map_err(|e| format!("link testpattern video: {e}"))?;
    Ok(caps.upcast())
}

/// `TestPattern`-Audiozweig — aus `omp-player::build_audio_branch`
/// übernommen, ohne isel-Sink-Pad-Link. Auch als "still"-Fallback für
/// `ItemSource::Live` ohne gefundenen Audio-Begleiter verwendet.
fn build_testpattern_audio(pipeline: &gst::Pipeline, tone_freq: f64) -> Result<gst::Element, String> {
    let src = gst::ElementFactory::make("audiotestsrc")
        .property("is-live", true)
        .property("freq", tone_freq.max(1.0))
        .property("volume", if tone_freq > 0.0 { 0.3 } else { 0.0 })
        .build()
        .map_err(|e| format!("audiotestsrc: {e}"))?;
    src.set_property_from_str("wave", "sine");
    let convert = gst::ElementFactory::make("audioconvert").build().map_err(|e| format!("audioconvert: {e}"))?;

    pipeline
        .add(&src)
        .and_then(|()| pipeline.add(&convert))
        .map_err(|e| format!("add testpattern audio: {e}"))?;
    gst::Element::link_many([&src, &convert]).map_err(|e| format!("link testpattern audio: {e}"))?;
    Ok(convert.upcast())
}

/// Generischer Datei-Zweig (MP4/MOV/…, `uridecodebin`) — aus
/// `omp-player::build_file_branches` übernommen, ohne isel-Sink-Pad-Link
/// und ohne die dortige explizite `sync_state_with_parent()`-
/// Reihenfolge: diese Pipeline wird IMMER frisch gebaut und geht danach
/// als Ganzes EINMAL nach `Playing` (s. Moduldoku) — GStreamers eigene
/// Zustands-Kaskadierung reicht dafür, die dort nötige manuelle
/// Konsument-vor-Quelle-Reihenfolge ist nur bei einer bereits laufenden
/// Zielpipeline (dortiger Anwendungsfall: Branch in eine geteilte,
/// laufende Pipeline einfügen) erforderlich.
/// Rückgabe: (`uridecodebin`-Element für Positions-/Dauer-Query,
/// Video-Tail, Audio-Tail).
fn build_generic_file(pipeline: &gst::Pipeline, uri: &str, width: u32, height: u32) -> Result<(gst::Element, gst::Element, gst::Element), String> {
    let vconvert = gst::ElementFactory::make("videoconvert").build().map_err(|e| format!("videoconvert: {e}"))?;
    let vscale = gst::ElementFactory::make("videoscale").build().map_err(|e| format!("videoscale: {e}"))?;
    let vrate = gst::ElementFactory::make("videorate").build().map_err(|e| format!("videorate: {e}"))?;
    let vcaps = gst::ElementFactory::make("capsfilter")
        .property("caps", video_caps(width, height))
        .build()
        .map_err(|e| format!("capsfilter(video): {e}"))?;
    pipeline
        .add(&vconvert)
        .and_then(|()| pipeline.add(&vscale))
        .and_then(|()| pipeline.add(&vrate))
        .and_then(|()| pipeline.add(&vcaps))
        .map_err(|e| format!("add file video chain: {e}"))?;
    gst::Element::link_many([&vconvert, &vscale, &vrate, &vcaps]).map_err(|e| format!("link file video chain: {e}"))?;

    let aconvert = gst::ElementFactory::make("audioconvert").build().map_err(|e| format!("audioconvert: {e}"))?;
    let aresample = gst::ElementFactory::make("audioresample").build().map_err(|e| format!("audioresample: {e}"))?;
    let acaps = gst::ElementFactory::make("capsfilter")
        .property("caps", audio_caps())
        .build()
        .map_err(|e| format!("capsfilter(audio): {e}"))?;
    pipeline
        .add(&aconvert)
        .and_then(|()| pipeline.add(&aresample))
        .and_then(|()| pipeline.add(&acaps))
        .map_err(|e| format!("add file audio chain: {e}"))?;
    gst::Element::link_many([&aconvert, &aresample, &acaps]).map_err(|e| format!("link file audio chain: {e}"))?;

    let src = gst::ElementFactory::make("uridecodebin")
        .property("uri", uri)
        .property("expose-all-streams", false)
        .build()
        .map_err(|e| format!("uridecodebin: {e}"))?;
    pipeline.add(&src).map_err(|e| format!("add uridecodebin: {e}"))?;

    let video_sink_pad = vconvert.static_pad("sink").ok_or("videoconvert: no sink pad")?;
    let audio_sink_pad = aconvert.static_pad("sink").ok_or("audioconvert: no sink pad")?;
    src.connect_pad_added(move |_src, new_pad| {
        let Some(caps) = new_pad.current_caps() else { return };
        let Some(structure) = caps.structure(0) else { return };
        let name = structure.name();
        let target = if name.starts_with("video/") {
            Some(&video_sink_pad)
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
            eprintln!("omp-channel-player: uridecodebin pad-added link failed: {e:?}");
        }
    });

    Ok((src, vcaps.upcast(), acaps.upcast()))
}

/// MXF-Datei-Zweig — Element-Konstruktion wortgleich aus
/// `omp-mxf-player-direct/src/pipeline.rs::build()` übernommen (dort
/// selbst wortgleich aus `omp-mxf-player`), auf EINE feste Ausgabegruppe
/// (`MXF_GROUP_ID`/`MXF_PRESET_ID`) verengt statt aller `presets::
/// default_settings()`-Gruppen — dieser Node hat nur einen Audio-Sender,
/// s. Moduldoku. Rückgabe: (`mxfdemux`-Element für Positions-/Dauer-
/// Query, Video-Tail, Audio-Tail).
fn build_mxf_file(pipeline: &gst::Pipeline, path: &str, width: u32, height: u32) -> Result<(gst::Element, gst::Element, gst::Element), String> {
    let filesrc = gst::ElementFactory::make("filesrc")
        .property("location", path)
        .build()
        .map_err(|e| format!("filesrc: {e}"))?;
    let demux = gst::ElementFactory::make("mxfdemux").build().map_err(|e| format!("mxfdemux: {e}"))?;
    pipeline
        .add(&filesrc)
        .and_then(|()| pipeline.add(&demux))
        .map_err(|e| format!("add filesrc/mxfdemux: {e}"))?;
    gst::Element::link(&filesrc, &demux).map_err(|e| format!("link filesrc to mxfdemux: {e}"))?;

    let decodebin = gst::ElementFactory::make("decodebin").build().map_err(|e| format!("decodebin: {e}"))?;
    let vconvert = gst::ElementFactory::make("videoconvert").build().map_err(|e| format!("videoconvert: {e}"))?;
    let vscale = gst::ElementFactory::make("videoscale").build().map_err(|e| format!("videoscale: {e}"))?;
    let vrate = gst::ElementFactory::make("videorate").build().map_err(|e| format!("videorate: {e}"))?;
    let vcaps = gst::ElementFactory::make("capsfilter")
        .property("caps", video_caps(width, height))
        .build()
        .map_err(|e| format!("capsfilter(video): {e}"))?;
    let vqueue = gst::ElementFactory::make("queue").build().map_err(|e| format!("queue(video): {e}"))?;
    pipeline
        .add(&decodebin)
        .and_then(|()| pipeline.add(&vconvert))
        .and_then(|()| pipeline.add(&vscale))
        .and_then(|()| pipeline.add(&vrate))
        .and_then(|()| pipeline.add(&vcaps))
        .and_then(|()| pipeline.add(&vqueue))
        .map_err(|e| format!("add video chain: {e}"))?;
    gst::Element::link_many([&vconvert, &vscale, &vrate, &vcaps, &vqueue]).map_err(|e| format!("link video chain: {e}"))?;

    let decodebin_sink = vconvert.static_pad("sink").ok_or("videoconvert: no sink pad")?;
    decodebin.connect_pad_added(move |_db, new_pad| {
        let Some(caps) = new_pad.current_caps() else { return };
        let Some(structure) = caps.structure(0) else { return };
        if structure.name().starts_with("video/") && !decodebin_sink.is_linked()
            && let Err(e) = new_pad.link(&decodebin_sink) {
                eprintln!("omp-channel-player: decodebin pad-added link failed: {e:?}");
            }
    });

    let interleave = gst::ElementFactory::make("interleave").build().map_err(|e| format!("interleave: {e}"))?;
    let aconvert = gst::ElementFactory::make("audioconvert").build().map_err(|e| format!("audioconvert(bridge): {e}"))?;
    let matrix = gst::ElementFactory::make("audiomixmatrix").build().map_err(|e| format!("audiomixmatrix: {e}"))?;
    // Reihenfolge kritisch (s. omp-mxf-player-direct-Vorbild): erst
    // bauen, dann sequenziell setzen, sonst validiert audiomixmatrix die
    // Matrixform gegen die (0/0)-Default-Werte.
    matrix.set_property("out-channels", CHANNELS);
    matrix.set_property("in-channels", 1u32);
    matrix.set_property("matrix", matrix_to_gst_array(&vec![vec![0.0f64; 1]; CHANNELS as usize]));
    let acaps = gst::ElementFactory::make("capsfilter")
        .property("caps", audio_caps())
        .build()
        .map_err(|e| format!("capsfilter(audio): {e}"))?;
    pipeline
        .add(&interleave)
        .and_then(|()| pipeline.add(&aconvert))
        .and_then(|()| pipeline.add(&matrix))
        .and_then(|()| pipeline.add(&acaps))
        .map_err(|e| format!("add audio backbone: {e}"))?;
    gst::Element::link_many([&interleave, &aconvert, &matrix, &acaps]).map_err(|e| format!("link audio backbone: {e}"))?;

    let pending: Arc<Mutex<Vec<(u32, gst::Pad)>>> = Arc::new(Mutex::new(Vec::new()));
    let pending_pad_added = pending.clone();
    demux.connect_pad_added(move |_demux, new_pad| {
        let Some(caps) = new_pad.current_caps() else { return };
        let Some(structure) = caps.structure(0) else { return };
        if !structure.name().starts_with("audio/") {
            return;
        }
        let pad_name = new_pad.name();
        let track_num: u32 = pad_name.rsplit('_').next().and_then(|s| s.parse().ok()).unwrap_or(0);
        pending_pad_added.lock().expect("lock poisoned").push((track_num, new_pad.clone()));
    });

    let decodebin_sink_target = decodebin.static_pad("sink").ok_or("decodebin: no sink pad")?;
    demux.connect_pad_added(move |_demux, new_pad| {
        let Some(caps) = new_pad.current_caps() else { return };
        let Some(structure) = caps.structure(0) else { return };
        if structure.name().starts_with("video/") && !decodebin_sink_target.is_linked()
            && let Err(e) = new_pad.link(&decodebin_sink_target) {
                eprintln!("omp-channel-player: mxfdemux video pad link failed: {e:?}");
            }
    });

    let settings = presets::default_settings();
    let preset = presets::find_preset(&settings.presets, MXF_PRESET_ID)
        .cloned()
        .ok_or_else(|| format!("kein '{MXF_PRESET_ID}'-Preset in presets::default_settings()"))?;
    // SCHWACHE Referenz statt `pipeline.clone()` (Nutzerfund
    // `omp-mxf-player-direct`, s. dortige ausführliche Doku): dieser Node
    // baut wie jener die ganze Pipeline pro EOS-Zyklus neu auf — ein
    // starker Klon hier wäre derselbe GObject-Referenzzirkel.
    let pipeline_weak = pipeline.downgrade();
    demux.connect_no_more_pads(move |_demux| {
        let Some(pipeline_for_nmp) = pipeline_weak.upgrade() else { return };
        let mut sorted = std::mem::take(&mut *pending.lock().expect("lock poisoned"));
        sorted.sort_by_key(|(track, _)| *track);
        let input_channels = sorted.len() as u32;

        for (rank, (_, pad)) in sorted.iter().enumerate() {
            let Some(sink) = interleave.request_pad_simple(&format!("sink_{rank}")) else {
                eprintln!("omp-channel-player: interleave: request sink_{rank} failed");
                continue;
            };
            let queue = match gst::ElementFactory::make("queue").build() {
                Ok(q) => q,
                Err(e) => {
                    eprintln!("omp-channel-player: queue(track {rank}): {e}");
                    continue;
                }
            };
            if let Err(e) = pipeline_for_nmp.add(&queue) {
                eprintln!("omp-channel-player: add queue(track {rank}) failed: {e:?}");
                continue;
            }
            if let Err(e) = queue.sync_state_with_parent() {
                eprintln!("omp-channel-player: sync queue(track {rank}) failed: {e:?}");
                continue;
            }
            let Some(queue_sink) = queue.static_pad("sink") else { continue };
            let Some(queue_src) = queue.static_pad("src") else { continue };
            if let Err(e) = pad.link(&queue_sink) {
                eprintln!("omp-channel-player: link mxfdemux track {rank} to queue failed: {e:?}");
                continue;
            }
            if let Err(e) = queue_src.link(&sink) {
                eprintln!("omp-channel-player: link queue to interleave (track {rank}) failed: {e:?}");
            }
        }

        let coeffs = presets::matrix_for(&preset, MXF_GROUP_ID, CHANNELS, input_channels.max(1));
        matrix.set_property("in-channels", input_channels.max(1));
        matrix.set_property("out-channels", CHANNELS);
        matrix.set_property("matrix", matrix_to_gst_array(&coeffs));
    });

    Ok((demux, vqueue.upcast(), acaps.upcast()))
}

/// Live-Videozweig — aus `omp-player::build_live_video_branch`
/// übernommen, ohne isel-Sink-Pad-Link.
fn build_live_video(pipeline: &gst::Pipeline, context: Arc<MxlContext>, flow_id: &str, width: u32, height: u32) -> Result<(gst::Element, MxlVideoInput), String> {
    let mxl_input = MxlVideoInput::new(pipeline, context, flow_id).map_err(|e| format!("MxlVideoInput({flow_id}): {e}"))?;
    let convert = gst::ElementFactory::make("videoconvert").build().map_err(|e| format!("videoconvert (live video): {e}"))?;
    let scale = gst::ElementFactory::make("videoscale").build().map_err(|e| format!("videoscale (live video): {e}"))?;
    let rate = gst::ElementFactory::make("videorate").build().map_err(|e| format!("videorate (live video): {e}"))?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", video_caps(width, height))
        .build()
        .map_err(|e| format!("capsfilter (live video): {e}"))?;
    pipeline
        .add(&convert)
        .and_then(|()| pipeline.add(&scale))
        .and_then(|()| pipeline.add(&rate))
        .and_then(|()| pipeline.add(&caps))
        .map_err(|e| format!("add live video branch: {e}"))?;
    gst::Element::link_many([&mxl_input.tail, &convert, &scale, &rate, &caps]).map_err(|e| format!("link live video branch: {e}"))?;
    Ok((caps.upcast(), mxl_input))
}

/// Live-Audiozweig — aus `omp-player::build_live_audio_branch`
/// übernommen, ohne isel-Sink-Pad-Link.
fn build_live_audio(pipeline: &gst::Pipeline, context: Arc<MxlContext>, flow_id: &str) -> Result<(gst::Element, MxlAudioInput), String> {
    let mxl_input = MxlAudioInput::new(pipeline, context, flow_id).map_err(|e| format!("MxlAudioInput({flow_id}): {e}"))?;
    let convert = gst::ElementFactory::make("audioconvert").build().map_err(|e| format!("audioconvert (live audio): {e}"))?;
    let resample = gst::ElementFactory::make("audioresample").build().map_err(|e| format!("audioresample (live audio): {e}"))?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", audio_caps())
        .build()
        .map_err(|e| format!("capsfilter (live audio): {e}"))?;
    pipeline
        .add(&convert)
        .and_then(|()| pipeline.add(&resample))
        .and_then(|()| pipeline.add(&caps))
        .map_err(|e| format!("add live audio branch: {e}"))?;
    gst::Element::link_many([&mxl_input.tail, &convert, &resample, &caps]).map_err(|e| format!("link live audio branch: {e}"))?;
    Ok((caps.upcast(), mxl_input))
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    /// `mxfdemux`/`uridecodebin`-Element für Positions-/Dauer-Query
    /// (`run()`s Tick) — `None` bei `TestPattern`/`Live` (kein
    /// Positions-Konzept).
    query_el: Option<gst::Element>,
    video_flowed: Arc<AtomicBool>,
    audio_flowed: Arc<AtomicBool>,
    // MÜSSEN für die Lebensdauer der Pipeline gehalten werden — beide
    // Output-Typen setzen in ihrem `Drop` `running=false`, s.
    // `omp-mxf-player-direct::ActivePipeline`-Doku.
    _mxl_video_output: MxlVideoOutput,
    _mxl_audio_output: MxlAudioOutput,
    // Dito für Live-Empfang (`read_loop`-Thread).
    _mxl_video_input: Option<MxlVideoInput>,
    _mxl_audio_input: Option<MxlAudioInput>,
}

impl ActivePipeline {
    /// S. `omp-mxf-player-direct::ActivePipeline::teardown` — identisches
    /// Muster: EIN `set_state(Null)` reicht, weil hier (anders als
    /// `omp-player`) immer die GANZE Pipeline abgebaut wird, nie nur ein
    /// Zweig neben einem weiterlaufenden zweiten.
    fn teardown(&self) {
        if let Err(e) = self.pipeline.set_state(gst::State::Null) {
            eprintln!("omp-channel-player: Pipeline-Teardown (set_state Null) fehlgeschlagen: {e}");
            return;
        }
        let (result, state, _pending) = self.pipeline.state(gst::ClockTime::from_seconds(3));
        if result.is_err() || state != gst::State::Null {
            eprintln!("omp-channel-player: Pipeline erreichte NULL nicht innerhalb 3s beim Teardown (state={state:?}) — möglicher Ressourcen-Leak");
        }
    }
}

fn query_position_ms(el: &gst::Element) -> Option<i64> {
    el.query_position::<gst::ClockTime>().map(|t| t.mseconds() as i64)
}

fn query_duration_ms(el: &gst::Element) -> Option<i64> {
    el.query_duration::<gst::ClockTime>().map(|t| t.mseconds() as i64)
}

/// Baut den vollständigen Graphen für `item` und fordert EINMAL `Playing`
/// für die gesamte Pipeline an (s. Moduldoku "kein mehrphasiger
/// Preroll-Tanz nötig"). `new_paced` (statt `new`) passt sich derselben
/// Begründung wie bei `omp-mxf-player-direct` an: Datei-Decode-Quellen
/// produzieren nicht von sich aus in Echtzeit.
fn build(config: &Config, item: &Item, tx: UnboundedSender<Event>, events: std::sync::mpsc::Sender<LoopEvent>) -> Result<ActivePipeline, String> {
    let context = Arc::new(MxlContext::new(&config.domain)?);
    let pipeline = gst::Pipeline::new();

    let mut query_el: Option<gst::Element> = None;
    let mut mxl_video_input: Option<MxlVideoInput> = None;
    let mut mxl_audio_input: Option<MxlAudioInput> = None;

    let (video_tail, audio_tail) = match &item.source {
        ItemSource::TestPattern { pattern, tone_freq } => {
            let v = build_testpattern_video(&pipeline, pattern, config.width, config.height)?;
            let a = build_testpattern_audio(&pipeline, *tone_freq)?;
            (v, a)
        }
        ItemSource::File { path } => {
            if path.to_ascii_lowercase().ends_with(".mxf") {
                let (demux, v, a) = build_mxf_file(&pipeline, path, config.width, config.height)?;
                query_el = Some(demux);
                (v, a)
            } else {
                let uri = gst::glib::filename_to_uri(path, None).map_err(|e| format!("filename_to_uri({path}): {e}"))?;
                let (src, v, a) = build_generic_file(&pipeline, uri.as_str(), config.width, config.height)?;
                query_el = Some(src);
                (v, a)
            }
        }
        ItemSource::Live { video_flow_id, audio_flow_id } => {
            let (v, mv) = match video_flow_id {
                Some(flow_id) => {
                    let (tail, input) = build_live_video(&pipeline, context.clone(), flow_id, config.width, config.height)?;
                    (tail, Some(input))
                }
                None => (build_testpattern_video(&pipeline, EMPTY_PATTERN, config.width, config.height)?, None),
            };
            let (a, ma) = match audio_flow_id {
                Some(flow_id) => {
                    let (tail, input) = build_live_audio(&pipeline, context.clone(), flow_id)?;
                    (tail, Some(input))
                }
                None => (build_testpattern_audio(&pipeline, EMPTY_TONE_FREQ)?, None),
            };
            mxl_video_input = mv;
            mxl_audio_input = ma;
            (v, a)
        }
    };

    let mxl_video_output = MxlVideoOutput::new_paced(
        &pipeline,
        &video_tail,
        context.clone(),
        &config.video_flow_id,
        &config.label,
        config.width,
        config.height,
        FRAMERATE_NUMERATOR,
        FRAMERATE_DENOMINATOR,
        Arc::new(AtomicU64::new(0)),
    )
    .map_err(|e| {
        let _ = pipeline.set_state(gst::State::Null);
        format!("MxlVideoOutput: {e}")
    })?;
    mxl_video_output.set_active(true);
    let video_flowed = mxl_video_output.flowed_handle();

    let mxl_audio_output = MxlAudioOutput::new_paced(&pipeline, &audio_tail, context.clone(), &config.audio_flow_id, &config.label, SAMPLE_RATE, CHANNELS).map_err(|e| {
        let _ = pipeline.set_state(gst::State::Null);
        format!("MxlAudioOutput: {e}")
    })?;
    mxl_audio_output.set_active(true);
    let audio_flowed = mxl_audio_output.flowed_handle();

    pipeline.set_state(gst::State::Playing).map_err(|e| format!("set state playing: {e}"))?;
    let (result, state, _pending) = pipeline.state(gst::ClockTime::from_seconds(8));
    if result.is_err() || state != gst::State::Playing {
        let _ = pipeline.set_state(gst::State::Null);
        return Err(format!("pipeline erreichte Playing nicht innerhalb 8s (state={state:?})"));
    }

    // EOS ist bei `File`-Items erstklassig (Loop-Neuaufbau, s.
    // Moduldoku), bei `TestPattern`/`Live` irrelevant (nie erreicht).
    let bus = pipeline.bus().expect("pipeline has no bus");
    let tx_for_bus = tx.clone();
    std::thread::spawn(move || {
        for msg in bus.iter_timed(gst::ClockTime::NONE) {
            use gst::MessageView;
            match msg.view() {
                MessageView::Error(err) => {
                    let _ = tx_for_bus.send(Event::Error(format!("{} ({:?})", err.error(), err.debug())));
                    let _ = events.send(LoopEvent::CycleDone);
                    return;
                }
                MessageView::Eos(_) => {
                    let _ = events.send(LoopEvent::CycleDone);
                    return;
                }
                _ => {}
            }
        }
    });

    Ok(ActivePipeline {
        pipeline,
        query_el,
        video_flowed,
        audio_flowed,
        _mxl_video_output: mxl_video_output,
        _mxl_audio_output: mxl_audio_output,
        _mxl_video_input: mxl_video_input,
        _mxl_audio_input: mxl_audio_input,
    })
}

const TICK: std::time::Duration = std::time::Duration::from_millis(200);

/// Läuft in einer Endlosschleife, kommandogesteuert (nur `Load`, s.
/// Moduldoku — kein Cue/Take/Seek/Play/Stop wie bei `omp-mxf-player[-
/// direct]`, dieser Node kennt nur "zeig jetzt X"). **Kein Autoplay beim
/// Prozessstart** (gleiches Muster wie `omp-mxf-player-direct`, dort
/// Nutzerfund 2026-09-03): `active` startet `None`, die
/// `PipelineHandle` wird sofort an `ready` gesendet, nicht erst nach dem
/// ersten erfolgreichen Aufbau — der Node registriert sich im Leerlauf,
/// Wiedergabe beginnt erst auf das erste `load()`.
pub fn run(config: Config, tx: UnboundedSender<Event>, ready: oneshot::Sender<Result<PipelineHandle, String>>) {
    if let Err(e) = gst::init() {
        let msg = format!("gst init failed: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }

    let (event_tx, event_rx) = std::sync::mpsc::channel::<LoopEvent>();
    let shared = Arc::new(Mutex::new(SharedState {
        label: String::new(),
        media_type: "none".to_string(),
        video_flowed: Arc::new(AtomicBool::new(false)),
        audio_flowed: Arc::new(AtomicBool::new(false)),
    }));
    let position_ms = Arc::new(AtomicI64::new(0));
    let duration_ms = Arc::new(AtomicI64::new(0));

    let _ = ready.send(Ok(PipelineHandle {
        events: event_tx.clone(),
        shared: shared.clone(),
        position_ms: position_ms.clone(),
        duration_ms: duration_ms.clone(),
    }));

    let mut active: Option<ActivePipeline> = None;
    let mut current_item: Option<Item> = None;

    loop {
        match event_rx.recv_timeout(TICK) {
            Ok(LoopEvent::CycleDone) => {
                if let Some(a) = active.take() {
                    a.teardown();
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
                if let Some(item) = current_item.clone() {
                    match build(&config, &item, tx.clone(), event_tx.clone()) {
                        Ok(p) => {
                            let mut s = shared.lock().expect("lock poisoned");
                            s.video_flowed = p.video_flowed.clone();
                            s.audio_flowed = p.audio_flowed.clone();
                            drop(s);
                            active = Some(p);
                        }
                        Err(e) => {
                            let _ = tx.send(Event::Error(format!("build failed (loop): {e}")));
                        }
                    }
                }
            }
            Ok(LoopEvent::Cmd(Command::Load(item))) => {
                if let Some(a) = active.take() {
                    a.teardown();
                }
                position_ms.store(0, Ordering::Relaxed);
                duration_ms.store(item.duration_hint_ms.unwrap_or(0), Ordering::Relaxed);
                match build(&config, &item, tx.clone(), event_tx.clone()) {
                    Ok(p) => {
                        let mut s = shared.lock().expect("lock poisoned");
                        s.label = item.label.clone();
                        s.media_type = media_type_str(&item.source).to_string();
                        s.video_flowed = p.video_flowed.clone();
                        s.audio_flowed = p.audio_flowed.clone();
                        drop(s);
                        active = Some(p);
                        current_item = Some(item);
                    }
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("load failed: {e}")));
                        current_item = None;
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        }

        if let Some(a) = &active
            && let Some(el) = &a.query_el
        {
            if let Some(pos) = query_position_ms(el) {
                position_ms.store(pos, Ordering::Relaxed);
            }
            if let Some(dur) = query_duration_ms(el)
                && dur > 0
            {
                duration_ms.store(dur, Ordering::Relaxed);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_type_str_distinguishes_mxf_from_generic_file() {
        assert_eq!(media_type_str(&ItemSource::TestPattern { pattern: "smpte".to_string(), tone_freq: 0.0 }), "pattern");
        assert_eq!(media_type_str(&ItemSource::File { path: "/media/clip.MXF".to_string() }), "mxf");
        assert_eq!(media_type_str(&ItemSource::File { path: "/media/clip.mp4".to_string() }), "file");
        assert_eq!(media_type_str(&ItemSource::Live { video_flow_id: None, audio_flow_id: None }), "live");
    }

    #[test]
    fn matrix_to_gst_array_preserves_shape() {
        let _ = gst::init();
        let matrix = vec![vec![1.0, 0.0], vec![0.0, 1.0]];
        let array = matrix_to_gst_array(&matrix);
        assert_eq!(array.as_slice().len(), 2);
    }
}
