//! GStreamer-Pipeline von `omp-multiviewer-custom` (Nutzerauftrag
//! 2026-08-20: "neues microservice multiviewer erstellen: layout editor,
//! selektierbare quellen, dynamische anzahl an pip's. tally und umd pro
//! pip") — Geschwister von `omp-multiviewer` (jetzt "Automatic
//! Multiviewer", gleicher Kommentar dort zur Umbenennung), aber MANUELL
//! konfiguriert statt automatischer Alle-Quellen-Discovery: ein
//! `compositor` mit einer frei positionierbaren/skalierbaren Kachel je
//! konfiguriertem `ResolvedPip` (`xpos`/`ypos`/`width`/`height`, gleiches
//! Muster wie `omp-video-mixer-me`s DVE-Box) statt eines automatischen
//! Quadrat-Rasters.
//!
//! **Tally per Property-Set, kein Rebuild.** Jede Kachel bekommt einen
//! zweiten Compositor-Sink-Pad darunter (`zorder` eins niedriger): einen
//! `videotestsrc pattern=solid-color`, etwas größer als die eigentliche
//! Kachel, sodass er als farbiger Rahmen sichtbar bleibt. Dessen
//! `foreground-color`-Property ist ein einfacher `guint` (kein GEnum,
//! anders als z. B. `valignment`, s. Kommentar unten) — `set_tally()`
//! ändert nur diese eine Property zur Laufzeit, exakt dieselbe
//! Effizienz-Überlegung wie `omp-video-mixer-me::apply_dve_box` (reine
//! Property-Sets statt eines teuren Pipeline-Neuaufbaus für einen
//! häufigen, zeitkritischen Zustandswechsel).
//!
//! Jede STRUKTURELLE Änderung (Kachel hinzugefügt/entfernt, Quelle/
//! Position/Größe/UMD-Text geändert) baut dagegen wie beim automatischen
//! Multiviewer/`omp-switcher` die GESAMTE Pipeline neu auf (kein
//! dynamisches Pad-Relinking, Projekt-Konvention) — `layout_changed()`
//! vergleicht dafür den kompletten Zustand, damit ein unveränderter
//! erneuter `set_layout()`-Aufruf (z. B. vom periodischen
//! Quellen-Re-Resolve in `main.rs`) nicht sichtbar flackert.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput, MxlVideoOutput};
use omp_mediaio::preview::{self, Broadcaster};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

const PREVIEW_FPS: i32 = 5;
const PREVIEW_JPEG_QUALITY: i32 = 70;
pub const DEFAULT_CANVAS_WIDTH: u32 = 1920;
pub const DEFAULT_CANVAS_HEIGHT: u32 = 1080;
/// Framerate des optionalen PGM-MXL-Ausgangs (s. `Config::pgm_flow_id`-
/// Doku) — bewusst fest, nicht an die MJPEG-Vorschau-Rate (`PREVIEW_FPS`,
/// absichtlich gedrosselt fürs Browser-Bandbreitenbudget) gekoppelt: ein
/// echtes Sendesignal für einen physischen Monitor braucht eine reguläre
/// Broadcast-Framerate. 25fps passt zum sonstigen Projekt-Default (s.
/// `omp-video-mixer-me::pipeline::FRAMERATE_NUMERATOR`).
const PGM_FRAMERATE_NUMERATOR: i32 = 25;
const PGM_FRAMERATE_DENOMINATOR: i32 = 1;
/// Kleinste erlaubte Kachel-Kantenlänge (`main.rs`s `/state`-Validierung) —
/// darunter hat weder der Tally-Rahmen noch der UMD-Text sinnvoll Platz.
pub const MIN_PIP_SIZE: u32 = 32;
const TALLY_BORDER_PX: i32 = 6;
/// Neutrales Dunkelgrau — Kachel-Rahmen ohne Tally (`foreground-color` ist
/// ein `0xAARRGGBB`-`guint`, kein GEnum, direkt per `.property()` setzbar).
const TALLY_COLOR_OFF: u32 = 0xFF3A3A3A;
/// Broadcast-übliches Tally-Rot.
const TALLY_COLOR_ON: u32 = 0xFFE53935;
const PLACEHOLDER_COLOR: u32 = 0xFF1A1A1A;

pub struct Config {
    pub domain: String,
    /// Nutzerauftrag 2026-08-20: "der multiviewer braucht optional ...
    /// einen output um das signal auch zb auf ein gateway routen zu
    /// können" — zusätzlich zur MJPEG-Vorschau (Browser-Monitoring)
    /// registriert der Node einen zweiten, echten MXL-Video-Sender für
    /// dieselbe komponierte Leinwand, den z. B. ein `omp-decklink` in
    /// Ausgabe-Richtung oder `omp-2110-gateway` unverändert abgreifen
    /// kann (physischer Monitor statt Browser-Tab). "Optional" heißt
    /// hier: der Sender existiert immer in der NMOS-Registry (wie jeder
    /// andere Sender-Node), MUSS aber von niemandem verbunden werden —
    /// unbenutzte Sender sind der NMOS-Normalfall, kein Sonderzustand.
    /// Stabile Flow-ID über die gesamte Prozesslaufzeit (von `main.rs`
    /// einmalig erzeugt, gleiches Muster wie `omp-decklink`s
    /// `flow_id`) — Breite/Höhe des Flows folgen dagegen bei jedem
    /// strukturellen Rebuild der jeweils AKTUELLEN Leinwandgröße
    /// (`Layout::canvas_width/-height`, per Editor änderbar); ein bereits
    /// verbundener Empfänger sieht die neue Auflösung dann wie bei jeder
    /// anderen Auflösungsänderung im Graph (kein Sonderfall dieses Nodes).
    pub pgm_flow_id: String,
    pub label: String,
}

/// Eine vollständig aufgelöste Kachel, wie `pipeline::run` sie braucht —
/// `main.rs` löst `sender_id`→`flow_id`/`node_id` VOR dem Aufruf auf
/// (Registry-Zugriff bleibt komplett in `main.rs`, gleiche Trennung wie
/// beim automatischen Multiviewer). `flow_id: None` bedeutet entweder
/// "keine Quelle zugewiesen" oder "zugewiesene Quelle gerade nicht
/// auflösbar" — beide zeigen dieselbe Platzhalter-Kachel (kein
/// Unterschied für die Pipeline, `main.rs` loggt den Unterschied bereits).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPip {
    pub id: String,
    pub flow_id: Option<String>,
    /// IS-04-Sender-Label der zugewiesenen Quelle (NICHT die Sender-UID
    /// — Nutzerfund 2026-08-20: "source label (nicht die source uid)
    /// anzeigen") — `None` ohne zugewiesene/auflösbare Quelle, zeigt dann
    /// denselben "kein Signal"-Text wie zuvor der leere `umd`-Fallback.
    pub source_label: Option<String>,
    /// Freier, vom Bediener editierbarer UMD-Text (Nutzeranforderung
    /// "umd pro pip") — UNABHÄNGIG von `source_label`, beide werden
    /// gleichzeitig angezeigt (Nutzerfund 2026-08-20: "zusätzlich zum
    /// umd (freitext) auch die source label anzeigen" — vorher überschrieb
    /// ein leerer UMD-Text den Quellen-Namen ersatzlos, s. `build_tile`).
    pub umd: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq)]
struct Layout {
    canvas_width: u32,
    canvas_height: u32,
    pips: Vec<ResolvedPip>,
}

pub enum Event {
    Error(String),
}

enum Command {
    SetLayout { canvas_width: u32, canvas_height: u32, pips: Vec<ResolvedPip> },
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    /// "media-ready"-Flags nur der Kacheln MIT zugewiesener Quelle (s.
    /// `PipelineHandle::media_ready`-Doku).
    flowed: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
    /// Kachel-ID → Tally-Rahmen-Element, für `set_tally()`s reinen
    /// Property-Set-Pfad (s. Moduldoku) — bei jedem strukturellen Rebuild
    /// neu befüllt.
    tally_borders: Arc<Mutex<HashMap<String, gst::Element>>>,
}

impl PipelineHandle {
    pub fn set_layout(&self, canvas_width: u32, canvas_height: u32, pips: Vec<ResolvedPip>) {
        let _ = self.commands.send(Command::SetLayout { canvas_width, canvas_height, pips });
    }

    /// Färbt den Tally-Rahmen einer Kachel um — No-op, wenn `pip_id`
    /// gerade nicht existiert (z. B. ein spätes Tally-Event für eine seit
    /// dem letzten Rebuild entfernte Kachel).
    pub fn set_tally(&self, pip_id: &str, on: bool) {
        let borders = self.tally_borders.lock().expect("lock poisoned");
        if let Some(el) = borders.get(pip_id) {
            el.set_property("foreground-color", if on { TALLY_COLOR_ON } else { TALLY_COLOR_OFF });
        }
    }

    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6): keine Kachel MIT
    /// zugewiesener Quelle konfiguriert (leeres Layout ODER jede Kachel
    /// ohne Quelle) hat nichts abzuwarten (vakuos "bereit", gleiche
    /// Begründung wie `omp-multiviewer::PipelineHandle::media_ready`);
    /// sind Quellen zugewiesen, genügt mindestens eine tatsächlich
    /// fließende Kachel.
    pub fn media_ready(&self) -> bool {
        let flowed = self.flowed.lock().expect("lock poisoned");
        flowed.is_empty() || flowed.iter().any(|f| f.load(Ordering::Relaxed))
    }
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    _inputs: Vec<MxlVideoInput>,
    flowed: Vec<Arc<AtomicBool>>,
    tally_borders: HashMap<String, gst::Element>,
    // Optionaler PGM-MXL-Ausgang (s. Config::pgm_flow_id-Doku) — nur
    // gehalten, damit sein Schreib-Thread über die Lebensdauer dieser
    // ActivePipeline läuft (kein weiterer Zugriff nötig, „_"-Präfix wie
    // bei `_inputs`).
    _pgm_output: MxlVideoOutput,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        // Dieselbe gstreamer-rs-Falle wie omp-decklink/omp-multiviewer —
        // Pipeline::Drop räumt NICHT automatisch über NULL ab.
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Baut den Tally-Rahmen einer Kachel (`videotestsrc pattern=solid-color`,
/// exakt kachelgroß, `zorder` eins UNTER der eigentlichen Kachel — der
/// `TALLY_BORDER_PX`-Einzug der Kachel selbst lässt ihn ringsum sichtbar
/// hervorschauen, s. Moduldoku) und verlinkt ihn an einen neuen
/// Compositor-Sink-Pad.
fn build_tally_border(pipeline: &gst::Pipeline, comp: &gst::Element, pip: &ResolvedPip, sink_index: usize) -> Result<gst::Element, String> {
    let src = gst::ElementFactory::make("videotestsrc")
        .property("is-live", true)
        .build()
        .map_err(|e| format!("videotestsrc (tally border): {e}"))?;
    src.set_property_from_str("pattern", "solid-color");
    src.set_property("foreground-color", TALLY_COLOR_OFF);
    let caps = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("width", pip.width as i32)
                .field("height", pip.height as i32)
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter (tally border): {e}"))?;
    pipeline
        .add(&src)
        .and_then(|()| pipeline.add(&caps))
        .map_err(|e| format!("add tally border elements: {e}"))?;
    gst::Element::link_many([&src, &caps]).map_err(|e| format!("link tally border chain: {e}"))?;

    let pad = comp
        .request_pad_simple(&format!("sink_{sink_index}"))
        .ok_or_else(|| format!("compositor: request sink_{sink_index} (tally border) failed"))?;
    caps.static_pad("src")
        .ok_or("tally border capsfilter: no src pad")?
        .link(&pad)
        .map_err(|e| format!("link tally border to compositor: {e}"))?;
    pad.set_property("xpos", pip.x);
    pad.set_property("ypos", pip.y);
    pad.set_property("width", pip.width as i32);
    pad.set_property("height", pip.height as i32);
    pad.set_property("zorder", sink_index as u32);

    Ok(src)
}

/// Höhe der Label-Leiste UNTERHALB des Videos (Nutzerfund 2026-08-20:
/// "umd/source name muss unterhalb des videos, zentriert gerendert
/// werden" — vorher lagen beide Texte als transparentes Overlay AUF dem
/// Bild, jetzt bekommen sie einen eigenen, vom Video getrennten
/// Compositor-Sink-Pad darunter). Nimmt höchstens ein Drittel der
/// Kachelhöhe ein (`build_tile`), damit auch sehr kleine Kacheln noch
/// überwiegend Bild statt Label zeigen.
const LABEL_STRIP_PX: u32 = 30;
/// Hintergrund der Label-Leiste — dunkles, fast schwarzes Grau (kein
/// reines Schwarz, damit die Leiste sich sichtbar vom `compositor`s
/// eigenem Schwarz-Hintergrund zwischen Kacheln abhebt).
const LABEL_BG_COLOR: u32 = 0xFF16181B;

/// Baut die eigentliche Kachel: bei zugewiesener Quelle den echten
/// MXL-Videopfad, sonst eine Platzhalter-Kachel — in beiden Fällen mit
/// einer eigenen Label-Leiste UNTERHALB des Bildes (Quellen-Label immer,
/// UMD-Freitext optional als zweite Zeile, beide horizontal zentriert,
/// s. `ResolvedPip`-Doku), zeigt den konfigurierten UMD-Text also schon
/// VOR einer Quellzuweisung (nützlich beim Einrichten, s. Moduldoku
/// "flow_id: None"). Um `TALLY_BORDER_PX` eingezogen, damit der
/// Tally-Rahmen darunter ringsum sichtbar bleibt.
fn build_tile(
    pipeline: &gst::Pipeline,
    context: &Arc<MxlContext>,
    comp: &gst::Element,
    pip: &ResolvedPip,
    video_sink_index: usize,
    label_sink_index: usize,
) -> Result<(Option<MxlVideoInput>, Option<Arc<AtomicBool>>), String> {
    let inner_width = pip.width.saturating_sub(2 * TALLY_BORDER_PX as u32).max(1);
    let inner_height = pip.height.saturating_sub(2 * TALLY_BORDER_PX as u32).max(1);
    let inner_x = pip.x + TALLY_BORDER_PX;
    let inner_y = pip.y + TALLY_BORDER_PX;
    // Höchstens ein Drittel der Kachel für die Label-Leiste (s.
    // LABEL_STRIP_PX-Doku) — der Rest bleibt IMMER Video, auch bei sehr
    // niedrigen Kacheln.
    let label_height = LABEL_STRIP_PX.min(inner_height / 3).max(1);
    let video_height = inner_height.saturating_sub(label_height).max(1);

    let tail: gst::Element;
    let mut mxl_input = None;
    let mut flowed_handle = None;

    if let Some(flow_id) = &pip.flow_id {
        let input = MxlVideoInput::new(pipeline, context.clone(), flow_id)
            .map_err(|e| format!("MxlVideoInput({}, pip {}): {e}", flow_id, pip.id))?;
        let videoconvert = gst::ElementFactory::make("videoconvert")
            .build()
            .map_err(|e| format!("videoconvert (pip {}): {e}", pip.id))?;
        let videoscale = gst::ElementFactory::make("videoscale")
            .build()
            .map_err(|e| format!("videoscale (pip {}): {e}", pip.id))?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field("width", inner_width as i32)
                    .field("height", video_height as i32)
                    .build(),
            )
            .build()
            .map_err(|e| format!("capsfilter (pip {}): {e}", pip.id))?;
        pipeline
            .add(&videoconvert)
            .and_then(|()| pipeline.add(&videoscale))
            .and_then(|()| pipeline.add(&caps))
            .map_err(|e| format!("add pip {} elements: {e}", pip.id))?;
        gst::Element::link_many([&input.tail, &videoconvert, &videoscale, &caps])
            .map_err(|e| format!("link pip {} chain: {e}", pip.id))?;
        tail = caps;
        flowed_handle = Some(input.flowed_handle());
        mxl_input = Some(input);
    } else {
        let placeholder = gst::ElementFactory::make("videotestsrc")
            .property("is-live", true)
            .build()
            .map_err(|e| format!("videotestsrc (placeholder, pip {}): {e}", pip.id))?;
        placeholder.set_property_from_str("pattern", "solid-color");
        placeholder.set_property("foreground-color", PLACEHOLDER_COLOR);
        let caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field("width", inner_width as i32)
                    .field("height", video_height as i32)
                    .build(),
            )
            .build()
            .map_err(|e| format!("capsfilter (placeholder, pip {}): {e}", pip.id))?;
        pipeline
            .add(&placeholder)
            .and_then(|()| pipeline.add(&caps))
            .map_err(|e| format!("add placeholder pip {} elements: {e}", pip.id))?;
        gst::Element::link_many([&placeholder, &caps])
            .map_err(|e| format!("link placeholder pip {} chain: {e}", pip.id))?;
        tail = caps;
    }

    let video_pad = comp
        .request_pad_simple(&format!("sink_{video_sink_index}"))
        .ok_or_else(|| format!("compositor: request sink_{video_sink_index} (pip {}) failed", pip.id))?;
    tail.static_pad("src")
        .ok_or("pip video chain: no src pad")?
        .link(&video_pad)
        .map_err(|e| format!("link pip {} video to compositor: {e}", pip.id))?;
    video_pad.set_property("xpos", inner_x);
    video_pad.set_property("ypos", inner_y);
    video_pad.set_property("width", inner_width as i32);
    video_pad.set_property("height", video_height as i32);
    video_pad.set_property("zorder", video_sink_index as u32);

    // Eigene Label-Leiste UNTERHALB des Videos (Nutzerfund 2026-08-20) —
    // ein eigener Compositor-Sink-Pad statt eines Overlays AUF dem Bild:
    // Quellen-Label (NIE die UID, s. `ResolvedPip::source_label`-Doku)
    // immer als erste Zeile, UMD-Freitext optional als zweite — beide in
    // EINEM `textoverlay` (Mehrzeilentext per `\n`), horizontal UND
    // vertikal innerhalb der Leiste zentriert.
    let source_label_text = pip.source_label.as_deref().unwrap_or("— kein Signal —");
    let (label_text, font_desc) = if pip.umd.trim().is_empty() {
        (source_label_text.to_string(), "Sans 9")
    } else {
        (format!("{source_label_text}\n{}", pip.umd), "Sans 7")
    };

    let label_bg = gst::ElementFactory::make("videotestsrc")
        .property("is-live", true)
        .build()
        .map_err(|e| format!("videotestsrc (label bg, pip {}): {e}", pip.id))?;
    label_bg.set_property_from_str("pattern", "solid-color");
    label_bg.set_property("foreground-color", LABEL_BG_COLOR);
    let label_caps = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("width", inner_width as i32)
                .field("height", label_height as i32)
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter (label, pip {}): {e}", pip.id))?;
    let label_overlay = gst::ElementFactory::make("textoverlay")
        .property("text", label_text.as_str())
        .property("font-desc", font_desc)
        .build()
        .map_err(|e| format!("textoverlay (label, pip {}): {e}", pip.id))?;
    // GEnums sind nur zur Laufzeit aufgelöst (`gstreamer enum properties
    // are runtime-only`, per Absturz gefunden) — `set_property_from_str`,
    // kein `.property()`.
    label_overlay.set_property_from_str("valignment", "center");
    label_overlay.set_property_from_str("halignment", "center");
    pipeline
        .add(&label_bg)
        .and_then(|()| pipeline.add(&label_caps))
        .and_then(|()| pipeline.add(&label_overlay))
        .map_err(|e| format!("add pip {} label elements: {e}", pip.id))?;
    gst::Element::link_many([&label_bg, &label_caps, &label_overlay])
        .map_err(|e| format!("link pip {} label chain: {e}", pip.id))?;

    let label_pad = comp
        .request_pad_simple(&format!("sink_{label_sink_index}"))
        .ok_or_else(|| format!("compositor: request sink_{label_sink_index} (pip {}) failed", pip.id))?;
    label_overlay
        .static_pad("src")
        .ok_or("pip label overlay: no src pad")?
        .link(&label_pad)
        .map_err(|e| format!("link pip {} label to compositor: {e}", pip.id))?;
    label_pad.set_property("xpos", inner_x);
    label_pad.set_property("ypos", inner_y + video_height as i32);
    label_pad.set_property("width", inner_width as i32);
    label_pad.set_property("height", label_height as i32);
    label_pad.set_property("zorder", label_sink_index as u32);

    Ok((mxl_input, flowed_handle))
}

fn build(config: &Config, context: &Arc<MxlContext>, broadcaster: &Arc<Broadcaster>, layout: &Layout) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let comp = gst::ElementFactory::make("compositor")
        .name("grid")
        .build()
        .map_err(|e| format!("compositor: {e}"))?;
    pipeline.add(&comp).map_err(|e| format!("add compositor: {e}"))?;
    // Kacheln decken bei einem freien Layout nicht notwendigerweise die
    // gesamte Leinwand ab (anders als `omp-multiviewer`s exaktes
    // Quadrat-Raster) — ohne dies wäre die Lücke standardmäßig ein
    // Schachbrett-Muster statt eines sauberen Schwarzbilds.
    comp.set_property_from_str("background", "black");
    // Erzwingt die konfigurierte Leinwandgröße unabhängig davon, ob die
    // Kacheln sie tatsächlich lückenlos ausfüllen (`compositor` würde
    // sonst seine Ausgabegröße aus der Vereinigung der Sink-Pad-Boxen
    // ableiten — bei einem freien Layout i. A. NICHT dasselbe wie
    // `layout.canvas_width`/`-height`, was die xpos/ypos-Rechnung der
    // Kacheln sichtbar verzerren würde).
    let canvas_caps = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("width", layout.canvas_width as i32)
                .field("height", layout.canvas_height as i32)
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter (canvas): {e}"))?;
    pipeline.add(&canvas_caps).map_err(|e| format!("add canvas capsfilter: {e}"))?;
    comp.link(&canvas_caps).map_err(|e| format!("link compositor to canvas capsfilter: {e}"))?;

    let mut mxl_inputs = Vec::new();
    let mut flowed = Vec::new();
    let mut tally_borders = HashMap::new();

    if layout.pips.is_empty() {
        // Gleiche Begründung wie `omp-multiviewer::build`s
        // `EMPTY_CANVAS_TILES`: ein leeres Layout zeigt ein einzelnes
        // Schwarzbild statt einer leeren/fehlerhaften Kompositions-Kette
        // (ein `compositor` ohne jeden Sink-Pad liefert keine Buffer).
        let black = gst::ElementFactory::make("videotestsrc")
            .property("is-live", true)
            .build()
            .map_err(|e| format!("videotestsrc (black): {e}"))?;
        black.set_property_from_str("pattern", "black");
        pipeline.add(&black).map_err(|e| format!("add black source: {e}"))?;
        let pad = comp.request_pad_simple("sink_0").ok_or("compositor: request sink_0 failed")?;
        black
            .static_pad("src")
            .ok_or("black source: no src pad")?
            .link(&pad)
            .map_err(|e| format!("link black source to compositor: {e}"))?;
    } else {
        for (i, pip) in layout.pips.iter().enumerate() {
            // Drei Compositor-Sink-Pads pro Kachel seit der Label-Leiste
            // (Nutzerfund 2026-08-20): Tally-Rahmen, Video, Label —
            // vorher waren es zwei (Rahmen + Video-mit-Overlay-Textur).
            let border_index = i * 3;
            let video_index = i * 3 + 1;
            let label_index = i * 3 + 2;
            let border = build_tally_border(&pipeline, &comp, pip, border_index)?;
            tally_borders.insert(pip.id.clone(), border);
            let (input, flowed_handle) = build_tile(&pipeline, context, &comp, pip, video_index, label_index)?;
            if let Some(input) = input {
                mxl_inputs.push(input);
            }
            if let Some(handle) = flowed_handle {
                flowed.push(handle);
            }
        }
    }

    // Fan-out der komponierten Leinwand auf ZWEI unabhängige Abnehmer
    // (Nutzerauftrag 2026-08-20, s. Config::pgm_flow_id-Doku): die
    // bestehende MJPEG-Vorschau (Browser-Monitoring) UND ein echter
    // PGM-MXL-Sender (physischer Monitor/Gateway-Routing). `compositor`s
    // einzelner Src-Pad kann nicht zweimal direkt verlinkt werden — `tee`
    // ist das Standard-GStreamer-Muster dafür (gleiche Idee wie
    // `omp-source`s/`omp-ograf`s Lowres-/Fill-Tee-Zweige), je ein eigener
    // `queue` pro Zweig entkoppelt sie (ein langsamer Abnehmer blockiert
    // sonst über den gemeinsamen `tee` auch den anderen).
    let tee = gst::ElementFactory::make("tee").build().map_err(|e| format!("tee (canvas fan-out): {e}"))?;
    pipeline.add(&tee).map_err(|e| format!("add canvas tee: {e}"))?;
    canvas_caps.link(&tee).map_err(|e| format!("link canvas capsfilter to tee: {e}"))?;

    let mjpeg_queue = gst::ElementFactory::make("queue").build().map_err(|e| format!("queue (mjpeg branch): {e}"))?;
    pipeline.add(&mjpeg_queue).map_err(|e| format!("add mjpeg branch queue: {e}"))?;
    tee.link(&mjpeg_queue).map_err(|e| format!("link tee to mjpeg branch queue: {e}"))?;
    preview::build_mjpeg_branch(
        &pipeline,
        &mjpeg_queue,
        broadcaster,
        layout.canvas_width,
        layout.canvas_height,
        PREVIEW_FPS,
        PREVIEW_JPEG_QUALITY,
    )?;

    let pgm_queue = gst::ElementFactory::make("queue").build().map_err(|e| format!("queue (pgm branch): {e}"))?;
    pipeline.add(&pgm_queue).map_err(|e| format!("add pgm branch queue: {e}"))?;
    tee.link(&pgm_queue).map_err(|e| format!("link tee to pgm branch queue: {e}"))?;
    let pgm_output = MxlVideoOutput::new(
        &pipeline,
        &pgm_queue,
        context.clone(),
        &config.pgm_flow_id,
        &config.label,
        layout.canvas_width,
        layout.canvas_height,
        PGM_FRAMERATE_NUMERATOR as u32,
        PGM_FRAMERATE_DENOMINATOR as u32,
        // Kein Delay-Bedarf (wie omp-decklink/-source): dieser Node setzt
        // selbst den Ursprung, keine MXL-Eingangsseite zum Abgleichen.
        Arc::new(AtomicU64::new(0)),
    )
    .map_err(|e| format!("MxlVideoOutput (pgm): {e}"))?;
    pgm_output.set_active(true);

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActivePipeline { pipeline, _inputs: mxl_inputs, flowed, tally_borders, _pgm_output: pgm_output })
}

/// Läuft auf einem eigenen Thread (analog `omp-multiviewer::pipeline::run`):
/// baut sofort ein leeres (Schwarzbild-)Layout, wartet danach auf
/// `SetLayout`-Kommandos und baut bei strukturellen Änderungen komplett
/// neu.
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

    let flowed_slot: Arc<Mutex<Vec<Arc<AtomicBool>>>> = Arc::new(Mutex::new(Vec::new()));
    let tally_borders_slot: Arc<Mutex<HashMap<String, gst::Element>>> = Arc::new(Mutex::new(HashMap::new()));

    let mut current_layout = Layout { canvas_width: DEFAULT_CANVAS_WIDTH, canvas_height: DEFAULT_CANVAS_HEIGHT, pips: Vec::new() };
    let mut active = match build(&config, &context, &broadcaster, &current_layout) {
        Ok(p) => {
            *flowed_slot.lock().expect("lock poisoned") = p.flowed.clone();
            *tally_borders_slot.lock().expect("lock poisoned") = p.tally_borders.clone();
            Some(p)
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("initial build failed: {e}")));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        flowed: flowed_slot.clone(),
        tally_borders: tally_borders_slot.clone(),
    }));

    loop {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::SetLayout { canvas_width, canvas_height, pips }) => {
                let new_layout = Layout { canvas_width, canvas_height, pips };
                if new_layout != current_layout {
                    current_layout = new_layout;
                    active = None; // Reader-Threads/State-Null vor dem Neuaufbau stoppen.
                    match build(&config, &context, &broadcaster, &current_layout) {
                        Ok(p) => {
                            *flowed_slot.lock().expect("lock poisoned") = p.flowed.clone();
                            *tally_borders_slot.lock().expect("lock poisoned") = p.tally_borders.clone();
                            active = Some(p);
                        }
                        Err(e) => {
                            let _ = tx.send(Event::Error(format!(
                                "rebuild with {} pips failed: {e}",
                                current_layout.pips.len()
                            )));
                            // Tally-Rahmen der gescheiterten Kompositions-
                            // schließen weder alte Property-Handles noch
                            // eine leere Map — set_tally() bleibt bis zum
                            // nächsten erfolgreichen Rebuild ein No-op statt
                            // gegen tote Elemente zu schreiben.
                            *tally_borders_slot.lock().expect("lock poisoned") = HashMap::new();
                        }
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
