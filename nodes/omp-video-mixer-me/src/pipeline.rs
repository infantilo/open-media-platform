//! GStreamer-Pipeline von `omp-video-mixer-me` (`UMSETZUNG.md` C10,
//! `ARCHITECTURE.md` §13.1) — Crossfade-/DVE-/Keyer-Topologie aus
//! PIPELINE CONTROLLERs `MasterPipeline.js` übernommen (nicht neu
//! erfunden, `UMSETZUNG.md` §0 Punkt 9): `isel` = Programm-Bus (fg),
//! `isel_bg` = Preset-Mirror (bg, während einer Transition sichtbar),
//! `compositor` mit fg auf `zorder=2` über bg auf `zorder=1`, ein
//! Keyer-Layer auf `zorder=3` obenauf. Jeder Eingang wird zweimal per
//! `MxlVideoInput` gelesen (einmal für `isel`, einmal für `isel_bg`) —
//! Spiegel des Vorbilds, das denselben `intervideosrc`-Kanal zweimal
//! liest; MXLs Ring-Buffer ist für mehrere unabhängige Reader ausgelegt
//! (bereits produktiv: `omp-viewer` + `omp-switcher` lesen denselben
//! `omp-source`-Flow prozessübergreifend).
//!
//! **Vereinfachung ggü. dem Vorbild:** dort werden DVE-Box/Alpha über
//! zusätzliche `videobox`/`alpha`-Elemente gesetzt, weil die dortige
//! JS-Bindung (`gst-kit`) `GstCompositorPad`-Properties nur zur Parse-Zeit
//! setzen kann (Kommentar dort: „kann NICHT zur Laufzeit setzen"). Diese
//! Einschränkung gilt für `gstreamer-rs` nicht (siehe `gst-inspect-1.0
//! compositor`: `xpos`/`ypos`/`width`/`height`/`alpha`/`zorder` sind alle
//! `controllable`, zur Laufzeit setzbar) — hier direkt als Properties auf
//! den `comp`-Request-Pads gesetzt, keine Zusatzelemente nötig.
//!
//! **Crosspoint-Semantik:** `select(senderId)` setzt nur die
//! Preset-Bus-Auswahl, ändert das Programmbild nicht. `cut()` schaltet
//! Preset sofort hart auf Programm. `autoTrans()` überblendet über
//! `TRANS_DURATION_MS` in `STEP_MS`-Schritten (40ms ≙ eine Bildperiode
//! @25fps, wie im Vorbild). Läuft bereits eine Transition, werden weitere
//! `cut()`/`autoTrans()`-Aufrufe ignoriert (`fading`-Sperre) — ausreichend
//! fürs manuelle Bedienen; alles darüber hinaus (Warteschlange, weitere
//! Transitionsarten) ist wie volle DVE/Keyer-Tiefe Community-Scope
//! (`UMSETZUNG.md` C10). **Wipe-Transition bewusst nicht implementiert**
//! (kein erprobtes Muster in PIPELINE CONTROLLER vorhanden, `docs/
//! decisions.md` 2026-07-11) — nur Cut + Mix-AutoTrans.
//!
//! **Keyer:** kein Chroma-/Luma-Keying eines externen Eingangs (dafür
//! fehlt im Dev-Sandbox mangels Kamera/Greenscreen-Footage ein
//! sinnvolles Testsignal, `UMSETZUNG.md` §0 Punkt 7), sondern ein
//! DSK-artiger fester Farbflächen-Layer (`videotestsrc
//! pattern=solid-color`), per/via `keyer.setEnabled` ein-/ausblendbar —
//! deckt exakt die C10-Verifikation „Farbfläche über Hintergrund" ab.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
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

/// Eine Bildperiode @25fps — Animationsschrittweite für `autoTrans()`,
/// identisch zu PIPELINE CONTROLLERs `STEP_MS`.
const STEP_MS: u64 = 40;
const TRANS_DURATION_MS: u64 = 1000;

/// Feste DSK-Farbfläche des Keyers (ARGB, big-endian, wie
/// `videotestsrc::foreground-color`): kräftiges Magenta, im Viewer klar
/// vom SMPTE-/Quellbild unterscheidbar.
const KEYER_COLOR_ARGB: u32 = 0xFFFF00FF;
const KEYER_WIDTH: i32 = (WIDTH / 3) as i32;
const KEYER_HEIGHT: i32 = (HEIGHT / 3) as i32;

/// Wie beim Switcher (C7): Reader-/Writer-Threads setzen bei `Drop` nur
/// ein Stop-Flag, kein `JoinHandle`. Vor dem Öffnen eines neuen
/// `MxlVideoOutput`-Writers auf denselben `flow_id` (Rebuild) kurz warten,
/// damit nicht zwei Writer-Threads überlappend schreiben.
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
    /// IS-04-`device_id` des Senders — Grundlage für die Sender→Device→
    /// Node-Auflösung, die `main.rs` fürs Tally-Event braucht (Tally
    /// zielt auf die Node-Kachel, Discovery liefert nur `device_id`).
    pub device_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DveBox {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl DveBox {
    pub fn full_frame() -> Self {
        DveBox {
            x: 0,
            y: 0,
            width: WIDTH as i32,
            height: HEIGHT as i32,
        }
    }
}

impl Default for DveBox {
    fn default() -> Self {
        DveBox::full_frame()
    }
}

pub enum Event {
    Error(String),
    /// Programm hat wirklich umgeschaltet (nach `cut()` sofort, nach
    /// `autoTrans()` bei Transitionsbeginn — Tally soll im selben Moment
    /// rot werden, in dem der Operator die Aktion auslöst, nicht erst
    /// wenn die Überblendung optisch fertig ist).
    ProgramChanged {
        previous: Option<String>,
        current: Option<String>,
    },
    PresetChanged(Option<String>),
    DveBoxChanged(DveBox),
    KeyerChanged(bool),
}

enum Command {
    SetInputs(Vec<DiscoveredInput>),
    SelectPreset(Option<String>),
    Cut,
    Take(Option<String>),
    AutoTrans,
    SetDveBox(DveBox),
    ResetDve,
    SetKeyerEnabled(bool),
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    /// S. `omp-switcher::pipeline::PipelineHandle::flowed` — gleiche
    /// Begründung (Rebuild bei jeder Quellenmengen-Änderung, C10 folgt
    /// demselben Discovery-Muster wie C7).
    flowed: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl PipelineHandle {
    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2): der
    /// Programm-Ausgang produziert immer etwas (mindestens Schwarzbild),
    /// wird also i. d. R. kurz nach jedem (Re-)Build `true`.
    pub fn media_ready(&self) -> bool {
        self.flowed
            .lock()
            .expect("lock poisoned")
            .as_ref()
            .is_some_and(|f| f.load(Ordering::Relaxed))
    }

    pub fn set_inputs(&self, inputs: Vec<DiscoveredInput>) {
        let _ = self.commands.send(Command::SetInputs(inputs));
    }

    pub fn select_preset(&self, sender_id: Option<String>) {
        let _ = self.commands.send(Command::SelectPreset(sender_id));
    }

    pub fn cut(&self) {
        let _ = self.commands.send(Command::Cut);
    }

    /// PGM-Hot-Cut (K3-Teil-2, `docs/END-GOAL-FEATURES.md` §3.5 offene
    /// Frage 1, entschieden 2026-07-16: PGM-Bus-Buttons schalten direkt
    /// um): schaltet das Programm-Bild sofort auf `sender_id`, **ohne**
    /// den gestagten Preset-Wert zu berühren — anders als ein impliziter
    /// `select_preset` + `cut()`-Umweg, der die Preset-Auswahl
    /// überschreiben würde (genau das Risiko, das die ursprüngliche
    /// PGM-„nur Anzeige"-Entscheidung vermeiden wollte).
    pub fn take(&self, sender_id: Option<String>) {
        let _ = self.commands.send(Command::Take(sender_id));
    }

    pub fn auto_trans(&self) {
        let _ = self.commands.send(Command::AutoTrans);
    }

    pub fn set_dve_box(&self, box_: DveBox) {
        let _ = self.commands.send(Command::SetDveBox(box_));
    }

    pub fn reset_dve(&self) {
        let _ = self.commands.send(Command::ResetDve);
    }

    pub fn set_keyer_enabled(&self, enabled: bool) {
        let _ = self.commands.send(Command::SetKeyerEnabled(enabled));
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

fn rgba_caps() -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("format", "RGBA")
        .field("width", WIDTH as i32)
        .field("height", HEIGHT as i32)
        .field(
            "framerate",
            gst::Fraction::new(FRAMERATE_NUMERATOR as i32, FRAMERATE_DENOMINATOR as i32),
        )
        .build()
}

/// Ein normalisierter Zweig (`videoconvert ! videoscale ! videorate !
/// capsfilter(rgba)`) vor einem `input-selector`-Sink-Pad — gemeinsame
/// Bauvorschrift für Programm- und Preset-Zweig eines Eingangs. Gibt neben
/// dem `capsfilter` (Anschlusspunkt für den Aufrufer) auch alle vier
/// selbst hinzugefügten Elemente zurück, damit ein Aufrufer, der diesen
/// einen Zweig später wieder verwerfen muss (s. `build_one_input`), sie
/// gezielt aus der Pipeline entfernen kann statt sie verwaisen zu lassen.
fn build_normalized_branch(
    pipeline: &gst::Pipeline,
    tail: &gst::Element,
    name_suffix: &str,
) -> Result<(gst::Element, Vec<gst::Element>), String> {
    let videoconvert = gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(|e| format!("videoconvert ({name_suffix}): {e}"))?;
    let videoscale = gst::ElementFactory::make("videoscale")
        .build()
        .map_err(|e| format!("videoscale ({name_suffix}): {e}"))?;
    let videorate = gst::ElementFactory::make("videorate")
        .build()
        .map_err(|e| format!("videorate ({name_suffix}): {e}"))?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", rgba_caps())
        .build()
        .map_err(|e| format!("capsfilter ({name_suffix}): {e}"))?;

    pipeline
        .add(&videoconvert)
        .and_then(|()| pipeline.add(&videoscale))
        .and_then(|()| pipeline.add(&videorate))
        .and_then(|()| pipeline.add(&caps))
        .map_err(|e| format!("add branch elements ({name_suffix}): {e}"))?;
    gst::Element::link_many([tail, &videoconvert, &videoscale, &videorate, &caps])
        .map_err(|e| format!("link branch ({name_suffix}): {e}"))?;

    Ok((caps.clone(), vec![videoconvert, videoscale, videorate, caps]))
}

/// Entfernt zuvor per `pipeline.add()` hinzugefügte Elemente wieder
/// (`Null`-Zustand + `remove`) — Aufräumen für einen einzelnen, verworfenen
/// Eingang, s. `build_one_input`. Gleicher Verwaisungs-Schutz wie in
/// `omp-mediaio::mxl` (`docs/decisions.md` 2026-07-16 "Nachtrag 2",
/// Registry-Geist-OOM).
fn remove_elements(pipeline: &gst::Pipeline, elements: &[gst::Element]) {
    for el in elements {
        let _ = el.set_state(gst::State::Null);
        let _ = pipeline.remove(el);
    }
}

/// Baut fg+bg-Zweig für genau einen Eingang. Schlägt irgendein Schritt
/// fehl (z. B. `MxlVideoInput::new` gegen einen Registry-Geist-Sender,
/// dessen Flow bereits per `mxl-info -g` eingesammelt wurde), räumt diese
/// Funktion alles, was sie selbst für DIESEN Eingang bereits angelegt hat,
/// vollständig wieder ab, statt es im (bei anderen Eingängen weiterhin
/// erfolgreichen) `pipeline` verwaisen zu lassen — genau das war die
/// beobachtete OOM-Ursache: ein einzelner kaputter Sender riss früher den
/// GANZEN Build via `?` ab, was den Aufrufer zu wiederholten Voll-
/// Rebuild-Versuchen zwang, von denen jeder erneut denselben Geist traf.
#[allow(clippy::too_many_arguments)]
fn build_one_input(
    pipeline: &gst::Pipeline,
    context: &Arc<MxlContext>,
    isel: &gst::Element,
    isel_bg: &gst::Element,
    input: &DiscoveredInput,
    pad_index: usize,
) -> Result<(gst::Pad, gst::Pad, MxlVideoInput, MxlVideoInput), String> {
    let fg_input = MxlVideoInput::new(pipeline, context.clone(), &input.flow_id)
        .map_err(|e| format!("MxlVideoInput(fg, {}): {e}", input.sender_id))?;
    let (fg_caps, fg_branch_elements) = match build_normalized_branch(
        pipeline,
        &fg_input.tail,
        &format!("input-{pad_index}-fg"),
    ) {
        Ok(r) => r,
        Err(e) => {
            drop(fg_input);
            return Err(e);
        }
    };
    let fg_pad = match isel.request_pad_simple(&format!("sink_{pad_index}")) {
        Some(p) => p,
        None => {
            remove_elements(pipeline, &fg_branch_elements);
            drop(fg_input);
            return Err(format!("isel: request sink_{pad_index} failed"));
        }
    };
    if let Err(e) = fg_caps
        .static_pad("src")
        .ok_or_else(|| "input-fg capsfilter: no src pad".to_string())
        .and_then(|pad| pad.link(&fg_pad).map_err(|e| format!("link input-{pad_index}-fg to isel: {e}")))
    {
        isel.release_request_pad(&fg_pad);
        remove_elements(pipeline, &fg_branch_elements);
        drop(fg_input);
        return Err(e);
    }

    let bg_input = match MxlVideoInput::new(pipeline, context.clone(), &input.flow_id) {
        Ok(b) => b,
        Err(e) => {
            isel.release_request_pad(&fg_pad);
            remove_elements(pipeline, &fg_branch_elements);
            drop(fg_input);
            return Err(format!("MxlVideoInput(bg, {}): {e}", input.sender_id));
        }
    };
    let (bg_caps, bg_branch_elements) = match build_normalized_branch(
        pipeline,
        &bg_input.tail,
        &format!("input-{pad_index}-bg"),
    ) {
        Ok(r) => r,
        Err(e) => {
            isel.release_request_pad(&fg_pad);
            remove_elements(pipeline, &fg_branch_elements);
            drop(fg_input);
            drop(bg_input);
            return Err(e);
        }
    };
    let bg_pad = match isel_bg.request_pad_simple(&format!("sink_{pad_index}")) {
        Some(p) => p,
        None => {
            isel.release_request_pad(&fg_pad);
            remove_elements(pipeline, &fg_branch_elements);
            remove_elements(pipeline, &bg_branch_elements);
            drop(fg_input);
            drop(bg_input);
            return Err(format!("isel_bg: request sink_{pad_index} failed"));
        }
    };
    if let Err(e) = bg_caps
        .static_pad("src")
        .ok_or_else(|| "input-bg capsfilter: no src pad".to_string())
        .and_then(|pad| pad.link(&bg_pad).map_err(|e| format!("link input-{pad_index}-bg to isel_bg: {e}")))
    {
        isel.release_request_pad(&fg_pad);
        isel_bg.release_request_pad(&bg_pad);
        remove_elements(pipeline, &fg_branch_elements);
        remove_elements(pipeline, &bg_branch_elements);
        drop(fg_input);
        drop(bg_input);
        return Err(e);
    }

    Ok((fg_pad, bg_pad, fg_input, bg_input))
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    isel: gst::Element,
    isel_bg: gst::Element,
    black_pad_fg: gst::Pad,
    black_pad_bg: gst::Pad,
    source_pads_fg: HashMap<String, gst::Pad>,
    source_pads_bg: HashMap<String, gst::Pad>,
    comp_fg_pad: gst::Pad,
    comp_bg_pad: gst::Pad,
    comp_keyer_pad: gst::Pad,
    _fg_inputs: Vec<MxlVideoInput>,
    _bg_inputs: Vec<MxlVideoInput>,
    _mxl_output: MxlVideoOutput,
    flowed: Arc<AtomicBool>,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Setzt `isel`s `active-pad` auf den Eingang `selected` (Schwarzbild bei
/// `None` oder unbekannter `senderId`) und liefert die tatsächlich aktiv
/// geschaltete `senderId` zurück.
fn switch_isel(isel: &gst::Element, pads: &HashMap<String, gst::Pad>, black: &gst::Pad, selected: &Option<String>) -> Option<String> {
    let pad = selected
        .as_ref()
        .and_then(|id| pads.get(id).map(|pad| (id.clone(), pad)));
    match pad {
        Some((id, pad)) => {
            isel.set_property("active-pad", pad);
            Some(id)
        }
        None => {
            isel.set_property("active-pad", black);
            None
        }
    }
}

fn apply_dve_box(pad: &gst::Pad, box_: &DveBox) {
    pad.set_property("xpos", box_.x);
    pad.set_property("ypos", box_.y);
    pad.set_property("width", box_.width);
    pad.set_property("height", box_.height);
}

/// Baut die Mixer-Pipeline. Ein einzelner kaputter Eingang (z. B. ein
/// Registry-Geist-Sender, s. `build_one_input`) lässt den restlichen
/// Build nicht scheitern — er wird übersprungen und als Eintrag im
/// zweiten Rückgabewert gemeldet, den der Aufrufer (`run()`) als
/// `Event::Error` weiterreicht.
fn build(
    context: &Arc<MxlContext>,
    config: &Config,
    inputs: &[DiscoveredInput],
) -> Result<(ActivePipeline, Vec<String>), String> {
    let pipeline = gst::Pipeline::new();

    let isel = gst::ElementFactory::make("input-selector")
        .name("isel")
        .property("sync-streams", false)
        .build()
        .map_err(|e| format!("input-selector (fg): {e}"))?;
    let isel_bg = gst::ElementFactory::make("input-selector")
        .name("isel_bg")
        .property("sync-streams", false)
        .build()
        .map_err(|e| format!("input-selector (bg): {e}"))?;
    pipeline
        .add(&isel)
        .and_then(|()| pipeline.add(&isel_bg))
        .map_err(|e| format!("add isel: {e}"))?;

    let comp = gst::ElementFactory::make("compositor")
        .name("comp")
        .property_from_str("background", "black")
        .build()
        .map_err(|e| format!("compositor: {e}"))?;
    pipeline
        .add(&comp)
        .map_err(|e| format!("add compositor: {e}"))?;

    // ── Schwarzbild-Fallback, auf beiden Selektoren (fg + bg) verfügbar,
    //    exakt wie im Vorbild (dort black auf isel UND isel_bg gespiegelt).
    let black_src_fg = gst::ElementFactory::make("videotestsrc")
        .property("is-live", true)
        .build()
        .map_err(|e| format!("videotestsrc (black fg): {e}"))?;
    black_src_fg.set_property_from_str("pattern", "black");
    let black_src_bg = gst::ElementFactory::make("videotestsrc")
        .property("is-live", true)
        .build()
        .map_err(|e| format!("videotestsrc (black bg): {e}"))?;
    black_src_bg.set_property_from_str("pattern", "black");
    pipeline
        .add(&black_src_fg)
        .and_then(|()| pipeline.add(&black_src_bg))
        .map_err(|e| format!("add black sources: {e}"))?;
    let (black_caps_fg, _) = build_normalized_branch(&pipeline, &black_src_fg, "black-fg")?;
    let (black_caps_bg, _) = build_normalized_branch(&pipeline, &black_src_bg, "black-bg")?;

    let black_pad_fg = isel
        .request_pad_simple("sink_0")
        .ok_or("isel: request sink_0 failed")?;
    black_caps_fg
        .static_pad("src")
        .ok_or("black-fg capsfilter: no src pad")?
        .link(&black_pad_fg)
        .map_err(|e| format!("link black-fg to isel: {e}"))?;
    let black_pad_bg = isel_bg
        .request_pad_simple("sink_0")
        .ok_or("isel_bg: request sink_0 failed")?;
    black_caps_bg
        .static_pad("src")
        .ok_or("black-bg capsfilter: no src pad")?
        .link(&black_pad_bg)
        .map_err(|e| format!("link black-bg to isel_bg: {e}"))?;

    // ── Ein Eingang = zwei unabhängige MXL-Reader (fg + bg), siehe
    //    Modul-Dokumentation. Ein einzelner kaputter Eingang wird
    //    übersprungen (`build_one_input` räumt seinen eigenen Teilbau
    //    selbst ab) statt den ganzen Build abzureißen — s. Funktionsdoku.
    let mut source_pads_fg = HashMap::with_capacity(inputs.len());
    let mut source_pads_bg = HashMap::with_capacity(inputs.len());
    let mut fg_inputs = Vec::with_capacity(inputs.len());
    let mut bg_inputs = Vec::with_capacity(inputs.len());
    let mut warnings = Vec::new();
    for (i, input) in inputs.iter().enumerate() {
        let pad_index = i + 1;
        match build_one_input(&pipeline, context, &isel, &isel_bg, input, pad_index) {
            Ok((fg_pad, bg_pad, fg_input, bg_input)) => {
                source_pads_fg.insert(input.sender_id.clone(), fg_pad);
                source_pads_bg.insert(input.sender_id.clone(), bg_pad);
                fg_inputs.push(fg_input);
                bg_inputs.push(bg_input);
            }
            Err(e) => {
                warnings.push(format!(
                    "input {} ({}) übersprungen: {e}",
                    input.sender_id, input.label
                ));
            }
        }
    }

    // ── comp.sink_0 = Programm (fg, zorder 2, DVE-fähig — Box wird nach
    //    dem Build vom Aufrufer via `apply_dve_box` gesetzt).
    let comp_fg_pad = comp
        .request_pad_simple("sink_0")
        .ok_or("comp: request sink_0 (fg) failed")?;
    comp_fg_pad.set_property("zorder", 2u32);
    comp_fg_pad.set_property("alpha", 1.0f64);
    isel.static_pad("src")
        .ok_or("isel: no src pad")?
        .link(&comp_fg_pad)
        .map_err(|e| format!("link isel to comp.sink_0: {e}"))?;

    // ── comp.sink_1 = Preset-Mirror (bg, zorder 1, während normalem
    //    Betrieb transparent — alpha 0 —, während `autoTrans()` sichtbar).
    let comp_bg_pad = comp
        .request_pad_simple("sink_1")
        .ok_or("comp: request sink_1 (bg) failed")?;
    comp_bg_pad.set_property("zorder", 1u32);
    comp_bg_pad.set_property("alpha", 0.0f64);
    isel_bg
        .static_pad("src")
        .ok_or("isel_bg: no src pad")?
        .link(&comp_bg_pad)
        .map_err(|e| format!("link isel_bg to comp.sink_1: {e}"))?;

    // ── comp.sink_2 = Keyer-DSK-Farbfläche (zorder 3, obenauf, alpha vom
    //    Aufrufer nach dem Build per `keyer.enabled`-Zustand gesetzt).
    let keyer_src = gst::ElementFactory::make("videotestsrc")
        .property("is-live", true)
        .property("foreground-color", KEYER_COLOR_ARGB)
        .build()
        .map_err(|e| format!("videotestsrc (keyer): {e}"))?;
    keyer_src.set_property_from_str("pattern", "solid-color");
    pipeline
        .add(&keyer_src)
        .map_err(|e| format!("add keyer source: {e}"))?;
    let (keyer_caps, _) = build_normalized_branch(&pipeline, &keyer_src, "keyer")?;
    let comp_keyer_pad = comp
        .request_pad_simple("sink_2")
        .ok_or("comp: request sink_2 (keyer) failed")?;
    comp_keyer_pad.set_property("zorder", 3u32);
    comp_keyer_pad.set_property("alpha", 0.0f64);
    comp_keyer_pad.set_property("xpos", (WIDTH as i32 - KEYER_WIDTH) / 2);
    comp_keyer_pad.set_property("ypos", (HEIGHT as i32 - KEYER_HEIGHT) / 2);
    comp_keyer_pad.set_property("width", KEYER_WIDTH);
    comp_keyer_pad.set_property("height", KEYER_HEIGHT);
    keyer_caps
        .static_pad("src")
        .ok_or("keyer capsfilter: no src pad")?
        .link(&comp_keyer_pad)
        .map_err(|e| format!("link keyer to comp.sink_2: {e}"))?;

    let comp_out_caps = gst::ElementFactory::make("capsfilter")
        .property("caps", video_caps())
        .build()
        .map_err(|e| format!("capsfilter (comp out): {e}"))?;
    pipeline
        .add(&comp_out_caps)
        .map_err(|e| format!("add comp out capsfilter: {e}"))?;
    gst::Element::link(&comp, &comp_out_caps).map_err(|e| format!("link comp to caps: {e}"))?;

    let mxl_output = MxlVideoOutput::new(
        &pipeline,
        &comp_out_caps,
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
    let flowed = mxl_output.flowed_handle();

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok((
        ActivePipeline {
            pipeline,
            isel,
            isel_bg,
            black_pad_fg,
            black_pad_bg,
            source_pads_fg,
            source_pads_bg,
            comp_fg_pad,
            comp_bg_pad,
            comp_keyer_pad,
            _fg_inputs: fg_inputs,
            _bg_inputs: bg_inputs,
            _mxl_output: mxl_output,
            flowed,
        },
        warnings,
    ))
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

/// Führt eine Mix-Überblendung von `from` (Programm, aktuell auf fg) nach
/// `to` (Preset, aktuell nur auf bg gespiegelt) auf einem eigenen Thread
/// aus — direkte Pad-Property-Writes (`gst::Pad` ist `Send`+`Sync`,
/// GObject-Properties sind von jedem Thread aus setzbar), damit der
/// Command-Loop währenddessen weiter auf `recv_timeout` reagieren kann
/// (z. B. für einen parallelen `SetInputs`-Rebuild, der zuerst diesen
/// Thread joint). Erwartet, dass der Aufrufer `bg_pad`/`fg_pad`-Alpha
/// bereits synchron auf den Startzustand (bg=1, fg=0) gesetzt UND `isel`
/// bereits auf den neuen Eingang geschaltet hat (Reihenfolge-Grund siehe
/// `Command::AutoTrans`) — dieser Thread startet direkt mit der Rampe.
/// Nach Ablauf: bg stumm schalten (alpha 0), `isel_bg` auf den neuen
/// Programm-Eingang mitziehen (nächste Transition findet dort direkt ein
/// laufendes Bild vor, kein kalter Wechsel).
fn spawn_autotrans(
    fg_pad: gst::Pad,
    bg_pad: gst::Pad,
    isel_bg: gst::Element,
    bg_target_pad: gst::Pad,
    fading: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let steps = (TRANS_DURATION_MS / STEP_MS).max(2);
        let start = std::time::Instant::now();
        for i in 1..=steps {
            let target = Duration::from_millis(TRANS_DURATION_MS * i / steps);
            if let Some(wait) = target.checked_sub(start.elapsed()) {
                std::thread::sleep(wait);
            }
            let t = (start.elapsed().as_millis() as f64 / TRANS_DURATION_MS as f64).min(1.0);
            fg_pad.set_property("alpha", t);
        }
        fg_pad.set_property("alpha", 1.0f64);
        bg_pad.set_property("alpha", 0.0f64);
        isel_bg.set_property("active-pad", &bg_target_pad);

        fading.store(false, Ordering::Release);
    })
}

/// Läuft auf einem eigenen Thread (analog `omp-switcher`s `pipeline::run`).
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

    let flowed_slot: Arc<Mutex<Option<Arc<AtomicBool>>>> = Arc::new(Mutex::new(None));

    let mut current_inputs: Vec<DiscoveredInput> = Vec::new();
    let mut active = match build(&context, &config, &current_inputs) {
        Ok((p, _warnings)) => {
            *flowed_slot.lock().expect("lock poisoned") = Some(p.flowed.clone());
            Some(p)
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("initial build failed: {e}")));
            let _ = ready.send(Err(e));
            return;
        }
    };
    let mut program: Option<String> = None;
    let mut preset: Option<String> = None;
    let mut dve_box = DveBox::full_frame();
    let mut keyer_enabled = false;
    let fading = Arc::new(AtomicBool::new(false));
    let fade_thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) =
        std::sync::mpsc::channel();
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        flowed: flowed_slot.clone(),
    }));

    /// Wartet auf einen laufenden Transition-Thread, falls vorhanden —
    /// vor jedem Rebuild nötig, damit der Thread nicht auf Pads einer
    /// bereits zerstörten `ActivePipeline` schreibt.
    fn join_fade(fade_thread: &Arc<Mutex<Option<std::thread::JoinHandle<()>>>>) {
        if let Some(handle) = fade_thread.lock().expect("lock poisoned").take() {
            let _ = handle.join();
        }
    }

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::SetInputs(inputs)) => {
                if inputs_changed(&current_inputs, &inputs) {
                    current_inputs = inputs;
                    join_fade(&fade_thread);
                    fading.store(false, Ordering::Release);
                    active = None;
                    std::thread::sleep(OLD_WRITER_DRAIN);
                    match build(&context, &config, &current_inputs) {
                        Ok((p, warnings)) => {
                            for w in warnings {
                                let _ = tx.send(Event::Error(w));
                            }
                            let applied_program =
                                switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &program);
                            // isel_bg spiegelt außerhalb einer laufenden
                            // Transition immer das Programm (Invariante,
                            // siehe Moduldoku bei `spawn_autotrans`), nicht
                            // die Preset-Auswahl — sonst zeigt die nächste
                            // `autoTrans()` das falsche „Outgoing"-Bild.
                            switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &program);
                            apply_dve_box(&p.comp_fg_pad, &dve_box);
                            p.comp_keyer_pad
                                .set_property("alpha", if keyer_enabled { 1.0f64 } else { 0.0f64 });
                            let previous = program.clone();
                            program = applied_program;
                            *flowed_slot.lock().expect("lock poisoned") = Some(p.flowed.clone());
                            active = Some(p);
                            let _ = tx.send(Event::ProgramChanged {
                                previous,
                                current: program.clone(),
                            });
                        }
                        Err(e) => {
                            // Ein einzelner kaputter/verwaister Eingang darf
                            // den Mixer nicht abschießen — Fallback auf
                            // Schwarzbild-Pipeline statt Threadende (gleiche
                            // Linie wie omp-switcher, C7).
                            let _ = tx.send(Event::Error(format!(
                                "rebuild with {} inputs failed: {e} — falling back to black",
                                current_inputs.len()
                            )));
                            match build(&context, &config, &[]) {
                                Ok((p, _warnings)) => {
                                    apply_dve_box(&p.comp_fg_pad, &dve_box);
                                    let previous = program.take();
                                    preset = None;
                                    *flowed_slot.lock().expect("lock poisoned") =
                                        Some(p.flowed.clone());
                                    active = Some(p);
                                    let _ = tx.send(Event::ProgramChanged {
                                        previous,
                                        current: None,
                                    });
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
            Ok(Command::SelectPreset(sender_id)) => {
                // Reine Metadaten-Änderung, bewusst ohne Pipeline-
                // Seiteneffekt: `isel_bg` bleibt bis zu `cut()`/
                // `autoTrans()` auf dem Programm stehen (Invariante s.o.)
                // — die Preset-Auswahl wird erst beim Take/AutoTrans
                // wirksam, exakt die Programm-/Preset-Bus-Semantik eines
                // Bildmischers (§13.1).
                preset = sender_id;
                let _ = tx.send(Event::PresetChanged(preset.clone()));
            }
            Ok(Command::Cut) => {
                if fading.load(Ordering::Acquire) {
                    // Laufende Transition sofort abschließen statt
                    // überlagern (einfache Sperre, siehe Moduldoku).
                    continue;
                }
                if let Some(p) = &active {
                    let previous = program.clone();
                    let applied = switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &preset);
                    p.comp_fg_pad.set_property("alpha", 1.0f64);
                    p.comp_bg_pad.set_property("alpha", 0.0f64);
                    // isel_bg auf denselben Eingang mitziehen (nächste
                    // Transition findet dort ein laufendes Bild vor).
                    switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &preset);
                    program = applied;
                    let _ = tx.send(Event::ProgramChanged {
                        previous,
                        current: program.clone(),
                    });
                }
            }
            Ok(Command::Take(sender_id)) => {
                // PGM-Hot-Cut: identisch zu `Cut` (sofortiger fg/bg-
                // Pad-Wechsel, kein Fade), aber gegen `sender_id` statt
                // `preset` geschaltet — `preset`/`PresetChanged` bleiben
                // unverändert, exakt die Zusicherung aus `take()`s Doku.
                if fading.load(Ordering::Acquire) {
                    continue;
                }
                if let Some(p) = &active {
                    let previous = program.clone();
                    let applied =
                        switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &sender_id);
                    p.comp_fg_pad.set_property("alpha", 1.0f64);
                    p.comp_bg_pad.set_property("alpha", 0.0f64);
                    switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &sender_id);
                    program = applied;
                    let _ = tx.send(Event::ProgramChanged {
                        previous,
                        current: program.clone(),
                    });
                }
            }
            Ok(Command::AutoTrans) => {
                if fading.load(Ordering::Acquire) {
                    continue;
                }
                if let Some(p) = &active {
                    if preset == program {
                        // Nichts zu überblenden (Preset == Programm).
                        continue;
                    }
                    let previous = program.clone();
                    // Programm-Zustand gilt sofort als gewechselt (Tally
                    // reagiert im Moment des Auslösens, Moduldoku) — die
                    // sichtbare Überblendung läuft danach asynchron.
                    let target_pad_bg = preset
                        .as_ref()
                        .and_then(|id| p.source_pads_bg.get(id))
                        .cloned()
                        .unwrap_or_else(|| p.black_pad_bg.clone());
                    // Reihenfolge wie im Vorbild (MasterPipeline.js
                    // `xFadeTo`): erst bg sichtbar machen, dann fg
                    // unsichtbar, ERST DANACH isel auf den neuen Eingang
                    // schalten — sonst zeigt ein Frame lang das neue Bild
                    // bei altem (vollem) Alpha, bevor der Thread unten
                    // überhaupt zum Zug kommt.
                    p.comp_bg_pad.set_property("alpha", 1.0f64);
                    p.comp_fg_pad.set_property("alpha", 0.0f64);
                    switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &preset);
                    program = preset.clone();
                    fading.store(true, Ordering::Release);
                    let handle = spawn_autotrans(
                        p.comp_fg_pad.clone(),
                        p.comp_bg_pad.clone(),
                        p.isel_bg.clone(),
                        target_pad_bg,
                        fading.clone(),
                    );
                    *fade_thread.lock().expect("lock poisoned") = Some(handle);
                    let _ = tx.send(Event::ProgramChanged {
                        previous,
                        current: program.clone(),
                    });
                }
            }
            Ok(Command::SetDveBox(box_)) => {
                dve_box = box_;
                if let Some(p) = &active {
                    apply_dve_box(&p.comp_fg_pad, &dve_box);
                }
                let _ = tx.send(Event::DveBoxChanged(dve_box));
            }
            Ok(Command::ResetDve) => {
                dve_box = DveBox::full_frame();
                if let Some(p) = &active {
                    apply_dve_box(&p.comp_fg_pad, &dve_box);
                }
                let _ = tx.send(Event::DveBoxChanged(dve_box));
            }
            Ok(Command::SetKeyerEnabled(enabled)) => {
                keyer_enabled = enabled;
                if let Some(p) = &active {
                    p.comp_keyer_pad
                        .set_property("alpha", if enabled { 1.0f64 } else { 0.0f64 });
                }
                let _ = tx.send(Event::KeyerChanged(enabled));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    join_fade(&fade_thread);
    drop(active);
}
