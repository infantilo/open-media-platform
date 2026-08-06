//! GStreamer-Pipeline von `omp-mxf-player` — A/B-Slot-Cue/Take-Architektur
//! 1:1 von `omp-player` übernommen (`omp-player/src/pipeline.rs`s
//! Moduldoku gilt inhaltlich genauso: zwei feste `input-selector`-Sink-
//! Pads pro Ausgang, `cue()` baut nur den Zweig hinter dem nicht-on-air
//! Pad neu, `take()` schaltet ausschließlich `active-pad` um), hier auf
//! MEHRERE gleichzeitig aktive Audio-Ausgänge verallgemeinert: statt
//! einem `input-selector` für Video + einem für Audio gibt es einen für
//! Video + einen JE PROGRAMMGRUPPE (`Config::groups`, laufzeit-geladen —
//! standardmäßig 5: Programmton/Hörfilm-AD/Originalton/Dolby E/5.1
//! diskret, s. `presets.rs`/`orchestrator_settings.rs`).
//!
//! **Warum kein `uridecodebin`:** `omp-player`s Datei-Zweig nutzt
//! `uridecodebin(expose-all-streams=false)` — liefert genau EINEN
//! Audio-Pad. Reale MXF-Dateien aus dem ORF-Umfeld tragen die 8
//! Tonspuren aber als 8 SEPARATE MONO-Essenzspuren (`ffprobe` gegen
//! `/home/infantilo/PIPELINE CONTROLLER/media/ET270438.mxf` live
//! verifiziert: 8× `pcm_s24le, channels=1`), die alle gleichzeitig
//! gebraucht werden. Dieser Node nutzt daher `filesrc ! mxfdemux`
//! direkt: `mxfdemux`s Src-Pad-Template `track_%u` liefert PCM-Audio
//! bereits als `audio/x-raw` (kein Zusatz-Decoder nötig), nur die
//! Videospur läuft zusätzlich durch `decodebin` (Codec generisch,
//! automatisch — MPEG-2 heute, XAVC-100/300 künftig ohne Code-Änderung,
//! solange der passende GStreamer-Decoder installiert ist).
//!
//! **Track-Zuordnung**: `mxfdemux`s dynamische `pad-added`-Signale
//! liefern die Audiospuren in unbestimmter Reihenfolge relativ
//! zueinander — deshalb werden sie erst gesammelt (Track-Nummer aus dem
//! Pad-Namen `track_<N>` geparst) und erst bei `no-more-pads`
//! (Standard-GStreamer-Demuxer-Signal: "alle Pads für diese
//! Streamkonfiguration liegen jetzt vor") aufsteigend sortiert als
//! Tonspur 1..N interpretiert — robust auch für Dateien mit weniger als
//! 8 Spuren (ältere/kleinere Files): `presets::matrix_for` überspringt
//! Routes auf nicht existierende Spuren statt zu fehlern.
//!
//! **Kein Element trägt einen festen `.name(...)`** außer den EINMALIGEN
//! Pipeline-weiten iseln (`video_isel`, `isel_<group>`) — alle
//! transienten Pro-Slot-/Pro-Cue-Elemente (mxfdemux, decodebin,
//! interleave, tee, audiomixmatrix, …) bleiben unbenannt (GStreamer
//! vergibt automatisch eindeutige Namen). Grund: `omp-mediaio::mxl::
//! MxlAudioOutput`s eigener Kommentar dokumentiert einen live gefundenen
//! Bug — zwei Instanzen mit demselben festen Namen in derselben Pipeline
//! lassen `pipeline.add()` bei der zweiten mit "Failed to add element"
//! scheitern. Dieser Node hat davon fünf (`MxlAudioOutput` je Gruppe)
//! plus potenziell zwei Slots mit jeweils eigenem `audiomixmatrix` je
//! Gruppe gleichzeitig in der Pipeline — dieselbe Kollisionsklasse, hier
//! konsequent vermieden.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use crate::presets;

pub const DEFAULT_WIDTH: u32 = 1920;
pub const DEFAULT_HEIGHT: u32 = 1080;
pub const FRAMERATE_NUMERATOR: u32 = 25;
pub const FRAMERATE_DENOMINATOR: u32 = 1;
pub const SAMPLE_RATE: u32 = 48000;

const EMPTY_PATTERN: &str = "black";

pub struct Config {
    pub domain: String,
    pub video_flow_id: String,
    /// Reihenfolge == `groups`.
    pub group_flow_ids: Vec<String>,
    /// Vom Orchestrator geladen oder `presets::default_settings()`-
    /// Fallback (main.rs) — nicht mehr `presets::GROUPS` (Nutzerwunsch
    /// 2026-08-06, s. presets.rs-Moduldoku).
    pub groups: Vec<presets::ProgramGroup>,
    pub presets: Vec<presets::AudioPreset>,
    pub label: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug)]
pub enum ItemSource {
    /// Leerer/schwarzer+stiller Default (frisch gebauter, noch nicht
    /// gecuter Slot) — s. `omp-player::pipeline`-Vorbild.
    TestPattern,
    Mxf { path: String, preset_id: String },
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
    LoadSlot { slot: Slot, source: ItemSource },
    SetActive(Slot),
}

pub enum Event {
    Error(String),
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    video_flowed: Arc<AtomicBool>,
    group_flowed: Vec<Arc<AtomicBool>>,
}

impl PipelineHandle {
    pub fn load_slot(&self, slot: Slot, source: ItemSource) {
        let _ = self.commands.send(Command::LoadSlot { slot, source });
    }

    pub fn set_active(&self, slot: Slot) {
        let _ = self.commands.send(Command::SetActive(slot));
    }

    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6): Video- UND alle
    /// Gruppen-Ausgänge müssen jeweils mindestens einmal geflossen sein.
    pub fn media_ready(&self) -> bool {
        self.video_flowed.load(Ordering::Relaxed)
            && self.group_flowed.iter().all(|f| f.load(Ordering::Relaxed))
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

fn group_audio_caps(channels: u32) -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("rate", SAMPLE_RATE as i32)
        .field("channels", channels as i32)
        .field("layout", "interleaved")
        .build()
}

/// Konvertiert eine Zeilen-Matrix (Ausgabekanal → Eingabekanal-
/// Koeffizienten, s. `presets::matrix_for`) in GStreamers eigenes
/// `GstValueArray-of-GstValueArray`-Property-Format (`gst::Array` von
/// `gst::Array`, s. `gst-inspect-1.0 audiomixmatrix`).
fn matrix_to_gst_array(matrix: &[Vec<f64>]) -> gst::Array {
    gst::Array::new(matrix.iter().map(|row| gst::Array::new(row.iter().copied())))
}

/// Ein Terminal-Zweig: eine Elementkette, deren letztes Element per
/// `src`-Pad an einen FESTEN isel-Sink-Pad gelinkt ist. `sink_pad` ist der
/// isel-seitige Pad (bleibt über `replace_slot`-Zyklen hinweg bestehen),
/// `tail_src_pad` der zugehörige Quell-Pad auf der anderen Seite (fürs
/// saubere `unlink()` bei `teardown_branch` — Reihenfolge Unlink-vs-
/// State-Null ist kritisch, s. `omp-player::pipeline::teardown_branch`s
/// ausführliche Doku dazu, hier identisch übernommen).
struct Terminal {
    sink_pad: gst::Pad,
    tail_src_pad: gst::Pad,
}

/// Ein Slot-Zweig: alle für DIESEN Slot bei `cue()` neu angelegten
/// Elemente (Video-Decodekette + gesamte Audio-Demux-/Routing-Kette),
/// plus die Terminals, in die er mündet (Video + je Gruppe eines).
/// `elements` ist `Arc<Mutex<…>>` statt eines schlichten `Vec`, weil
/// `build_mxf_branch`s `no-more-pads`-Handler (läuft asynchron, NACH
/// Rückgabe des `Branch`, s. dortige Doku) selbst noch pro Tonspur ein
/// `queue`-Element nachträgt (Deadlock-Fix, s. dort) — dieser geteilte
/// Speicher ist die einzige Stelle, an der `teardown_branch` diese
/// nachträglich entstandenen Elemente wiederfindet.
struct Branch {
    elements: Arc<Mutex<Vec<gst::Element>>>,
    video: Terminal,
    /// Reihenfolge == die `groups`-Liste, mit der dieser Branch gebaut wurde.
    groups: Vec<Terminal>,
}

/// Bringt `el` auf `GST_STATE_NULL` und wartet auf den TATSÄCHLICHEN
/// Abschluss des Übergangs, statt das Ergebnis von `set_state()` zu
/// verwerfen. Live gefunden (2026-08-06, exakt dieselbe Bug-Klasse wie
/// der PIPELINE-CONTROLLER-`gst-kit`-Fund derselben Sitzung, s.
/// docs/decisions.md Nachtrag 119): `set_state(Null)` kann `Async`
/// liefern — der Übergang läuft dann im Hintergrund weiter, u. a. weil
/// `mxfdemux`s interne Streaming-Schleife (Moduldoku oben) noch
/// beendet werden muss. Der bisherige Code (`let _ =
/// el.set_state(Null)`) wertete das nie aus und entfernte das Element
/// sofort aus der Pipeline (`pipeline.remove()`, vormals direkt im
/// Anschluss) — bei einer noch laufenden Streaming-Schleife blieb
/// deren Thread dabei orphaned zurück (spinnt weiter, versucht in eine
/// entfernte/ungelinkte Pipeline zu schreiben). Reproduzierbar live
/// beobachtet: zweiter `cue()`/`take()`-Zyklus auf derselben Instanz
/// ließ `node`-Prozess-CPU auf 500-700% springen UND den neu gebauten
/// Branch komplett ohne fließende Daten stehen (`mxl-info`s "Head
/// index" blieb über mehrere Sekunden exakt konstant, während der
/// ERSTE Zyklus auf einer frisch gestarteten Instanz denselben Wert
/// nachweislich kontinuierlich vorantrieb) — der Leak vom ersten Zyklus
/// (dessen Branch nur den harmlosen `videotestsrc`/`audiotestsrc`-
/// Leerlauf-Zweig betraf, keine komplexe Streaming-Schleife) fiel dabei
/// noch nicht auf, der zweite (echter `mxfdemux`) schon.
fn stop_element_and_wait(el: &gst::Element) {
    let confirmed = match el.set_state(gst::State::Null) {
        Ok(gst::StateChangeSuccess::Success) => true,
        _ => el.state(gst::ClockTime::from_mseconds(500)).0.is_ok(),
    };
    if confirmed {
        return;
    }
    // Erster Versuch nicht innerhalb 500ms bestätigt — derselbe bereits
    // angestoßene Übergang läuft weiter (kein erneuter set_state()
    // nötig), nur mit deutlich längerem Timeout erneut abgefragt.
    if el.state(gst::ClockTime::from_seconds(3)).0.is_err() {
        eprintln!(
            "omp-mxf-player: {} erreichte GST_STATE_NULL nicht innerhalb ~3.5s — möglicher Thread-/Ressourcen-Leak",
            el.name()
        );
    }
}

fn remove_elements(pipeline: &gst::Pipeline, elements: &[gst::Element]) {
    for el in elements {
        let _ = pipeline.remove(el);
    }
}

/// Baut den "schwarz/stumm"-Default-Zweig eines frisch angelegten oder
/// gerade zurückgesetzten Slots — `videotestsrc(black)` + je Gruppe
/// `audiotestsrc(silence)`, direkt analog `omp-player::pipeline::
/// build_video_branch`/`build_audio_branch`.
fn build_empty_branch(
    pipeline: &gst::Pipeline,
    video_pad: gst::Pad,
    group_pads: Vec<gst::Pad>,
    groups: &[presets::ProgramGroup],
    width: u32,
    height: u32,
) -> Result<Branch, String> {
    let mut elements = Vec::new();

    let vsrc = gst::ElementFactory::make("videotestsrc")
        .property("is-live", true)
        .build()
        .map_err(|e| format!("videotestsrc: {e}"))?;
    vsrc.set_property_from_str("pattern", EMPTY_PATTERN);
    let vconvert = gst::ElementFactory::make("videoconvert").build().map_err(|e| format!("videoconvert: {e}"))?;
    let vscale = gst::ElementFactory::make("videoscale").build().map_err(|e| format!("videoscale: {e}"))?;
    let vrate = gst::ElementFactory::make("videorate").build().map_err(|e| format!("videorate: {e}"))?;
    let vcaps = gst::ElementFactory::make("capsfilter")
        .property("caps", video_caps(width, height))
        .build()
        .map_err(|e| format!("capsfilter(video): {e}"))?;
    pipeline
        .add(&vsrc)
        .and_then(|()| pipeline.add(&vconvert))
        .and_then(|()| pipeline.add(&vscale))
        .and_then(|()| pipeline.add(&vrate))
        .and_then(|()| pipeline.add(&vcaps))
        .map_err(|e| format!("add empty video branch: {e}"))?;
    gst::Element::link_many([&vsrc, &vconvert, &vscale, &vrate, &vcaps])
        .map_err(|e| format!("link empty video branch: {e}"))?;
    let video_tail_pad = vcaps.static_pad("src").ok_or("empty video branch: no src pad")?;
    video_tail_pad
        .link(&video_pad)
        .map_err(|e| format!("link empty video branch to isel: {e}"))?;
    elements.extend([vsrc, vconvert, vscale, vrate, vcaps]);

    let mut group_terminals = Vec::with_capacity(group_pads.len());
    for (group, pad) in groups.iter().zip(group_pads.into_iter()) {
        let asrc = gst::ElementFactory::make("audiotestsrc")
            .property("is-live", true)
            .property("volume", 0.0)
            .build()
            .map_err(|e| format!("audiotestsrc({}): {e}", group.id))?;
        asrc.set_property_from_str("wave", "silence");
        let acaps = gst::ElementFactory::make("capsfilter")
            .property("caps", group_audio_caps(group.channels))
            .build()
            .map_err(|e| format!("capsfilter(audio {}): {e}", group.id))?;
        pipeline
            .add(&asrc)
            .and_then(|()| pipeline.add(&acaps))
            .map_err(|e| format!("add empty audio branch ({}): {e}", group.id))?;
        gst::Element::link(&asrc, &acaps).map_err(|e| format!("link empty audio branch ({}): {e}", group.id))?;
        let tail_pad = acaps
            .static_pad("src")
            .ok_or_else(|| format!("empty audio branch ({}): no src pad", group.id))?;
        tail_pad
            .link(&pad)
            .map_err(|e| format!("link empty audio branch ({}) to isel: {e}", group.id))?;
        elements.extend([asrc, acaps]);
        group_terminals.push(Terminal { sink_pad: pad, tail_src_pad: tail_pad });
    }

    for el in &elements {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync_state_with_parent (empty branch): {e}"))?;
    }

    Ok(Branch {
        elements: Arc::new(Mutex::new(elements)),
        video: Terminal { sink_pad: video_pad, tail_src_pad: video_tail_pad },
        groups: group_terminals,
    })
}

/// Gemeinsamer Zustand zwischen `mxfdemux`s `pad-added`-Callback (läuft
/// auf GStreamers Streaming-Thread) und dem `no-more-pads`-Callback, der
/// die gesammelten Audiospuren tatsächlich verlinkt — s. Moduldoku zur
/// Track-Sammel-Strategie.
struct PendingAudio {
    pads: Vec<(u32, gst::Pad)>,
}

/// Baut den Wiedergabe-Zweig eines MXF-Items: `filesrc ! mxfdemux`,
/// Video über `decodebin` (Codec generisch), Audio über
/// `interleave ! audioconvert ! tee` mit je Gruppe einem
/// `audiomixmatrix` (Koeffizienten aus `preset`, s. `presets::
/// matrix_for`). Track-Zuordnung erst bei `no-more-pads` (Moduldoku).
fn build_mxf_branch(
    pipeline: &gst::Pipeline,
    video_pad: gst::Pad,
    group_pads: Vec<gst::Pad>,
    groups: &[presets::ProgramGroup],
    path: &str,
    preset: &presets::AudioPreset,
    width: u32,
    height: u32,
) -> Result<Branch, String> {
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

    // Video-Kette: decodebin (Codec generisch) → Konform-Kette → video_pad.
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
    gst::Element::link_many([&vconvert, &vscale, &vrate, &vcaps, &vqueue])
        .map_err(|e| format!("link video chain: {e}"))?;
    let video_tail_pad = vqueue.static_pad("src").ok_or("video chain: no src pad")?;
    video_tail_pad
        .link(&video_pad)
        .map_err(|e| format!("link video chain to isel: {e}"))?;
    let decodebin_sink = vconvert.static_pad("sink").ok_or("videoconvert: no sink pad")?;
    decodebin.connect_pad_added(move |_db, new_pad| {
        let Some(caps) = new_pad.current_caps() else { return };
        let Some(structure) = caps.structure(0) else { return };
        if structure.name().starts_with("video/") && !decodebin_sink.is_linked() {
            if let Err(e) = new_pad.link(&decodebin_sink) {
                eprintln!("omp-mxf-player: decodebin pad-added link failed: {e:?}");
            }
        }
    });

    // Audio-Backbone: interleave sammelt die N Mono-Tonspuren zu einem
    // interleaved Strom, tee speist je Gruppe ein eigenes
    // audiomixmatrix. Alle hier bereits angelegt (out-channels/matrix
    // stehen fest, in-channels/Matrix-Inhalt kommen erst bei
    // `no-more-pads` nach — Property-Änderung an einem noch nicht
    // datenführenden Element ist unproblematisch).
    let interleave = gst::ElementFactory::make("interleave").build().map_err(|e| format!("interleave: {e}"))?;
    let aconvert = gst::ElementFactory::make("audioconvert").build().map_err(|e| format!("audioconvert(bridge): {e}"))?;
    let atee = gst::ElementFactory::make("tee").build().map_err(|e| format!("tee(audio): {e}"))?;
    pipeline
        .add(&interleave)
        .and_then(|()| pipeline.add(&aconvert))
        .and_then(|()| pipeline.add(&atee))
        .map_err(|e| format!("add audio backbone: {e}"))?;
    gst::Element::link_many([&interleave, &aconvert, &atee]).map_err(|e| format!("link audio backbone: {e}"))?;

    let mut elements = vec![filesrc.clone(), demux.clone(), decodebin, vconvert, vscale, vrate, vcaps, vqueue];
    elements.extend([interleave.clone(), aconvert, atee.clone()]);

    let mut group_terminals = Vec::with_capacity(group_pads.len());
    let mut matrix_elements = Vec::with_capacity(group_pads.len());
    for (group, pad) in groups.iter().zip(group_pads.into_iter()) {
        let queue = gst::ElementFactory::make("queue").build().map_err(|e| format!("queue({}): {e}", group.id))?;
        // Reihenfolge kritisch (live gefunden): der Builder-Kette
        // (`.property().property()…build()`) ist NICHT garantiert, dass
        // GObject-Properties in Aufrufreihenfolge gesetzt werden — landet
        // `matrix` vor `out-channels`/`in-channels`, validiert
        // `audiomixmatrix` die Matrixform noch gegen die Default-Werte
        // (0/0) und lehnt jede nichtleere Matrix ab ("property 'matrix'
        // … invalid or out of range"). Fix: erst bauen, dann explizit
        // sequenziell setzen (`set_property` garantiert Aufrufreihenfolge).
        let matrix = gst::ElementFactory::make("audiomixmatrix")
            .build()
            .map_err(|e| format!("audiomixmatrix({}): {e}", group.id))?;
        matrix.set_property("out-channels", group.channels);
        matrix.set_property("in-channels", 1u32);
        matrix.set_property("matrix", matrix_to_gst_array(&vec![vec![0.0f64; 1]; group.channels as usize]));
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", group_audio_caps(group.channels))
            .build()
            .map_err(|e| format!("capsfilter({}): {e}", group.id))?;
        pipeline
            .add(&queue)
            .and_then(|()| pipeline.add(&matrix))
            .and_then(|()| pipeline.add(&caps))
            .map_err(|e| format!("add group chain ({}): {e}", group.id))?;
        gst::Element::link_many([&atee, &queue, &matrix, &caps])
            .map_err(|e| format!("link group chain ({}): {e}", group.id))?;
        let tail_pad = caps
            .static_pad("src")
            .ok_or_else(|| format!("group chain ({}): no src pad", group.id))?;
        tail_pad
            .link(&pad)
            .map_err(|e| format!("link group chain ({}) to isel: {e}", group.id))?;
        elements.extend([queue, matrix.clone(), caps]);
        group_terminals.push(Terminal { sink_pad: pad, tail_src_pad: tail_pad });
        matrix_elements.push((group.id.clone(), group.channels, matrix));
    }

    // "Konsument vor Produzent" (omp-player::pipeline-Lektion, s. dortige
    // Moduldoku): alles stromabwärts von mxfdemux zuerst auf den
    // Pipeline-Zustand syncen, `mxfdemux`/`filesrc` erst danach.
    for el in elements.iter().skip(2) {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync_state_with_parent (mxf branch): {e}"))?;
    }
    let elements = Arc::new(Mutex::new(elements));

    let pending = Arc::new(Mutex::new(PendingAudio { pads: Vec::new() }));
    let pending_pad_added = pending.clone();
    demux.connect_pad_added(move |_demux, new_pad| {
        let Some(caps) = new_pad.current_caps() else { return };
        let Some(structure) = caps.structure(0) else { return };
        // Video ist bereits über den `decodebin`-eigenen `pad-added`-
        // Handler oben abgedeckt (dort verlinkt `mxfdemux`s Video-Pad
        // direkt an `decodebin`s Sink — kein zweiter Handler nötig, DIESER
        // Handler behandelt nur Audio-Tonspuren).
        if !structure.name().starts_with("audio/") {
            return;
        }
        // Tonspur-Nummer aus dem `track_<N>`-Padnamen (Moduldoku) — fällt
        // bei unerwartetem Namen defensiv auf 0 zurück (Route würde dann
        // nie greifen statt falsch zu routen).
        let pad_name = new_pad.name();
        let track_num: u32 = pad_name.rsplit('_').next().and_then(|s| s.parse().ok()).unwrap_or(0);
        pending_pad_added.lock().expect("lock poisoned").pads.push((track_num, new_pad.clone()));
    });

    // `mxfdemux`s Video-Pad separat behandeln: dessen `pad-added` liefert
    // Video UND Audio über dasselbe Signal, der `decodebin`-Handler oben
    // reagiert nur auf Video-Caps — hier zusätzlich direkt am `mxfdemux`
    // registriert (zweiter Listener auf demselben Signal, GStreamer
    // unterstützt beliebig viele `connect_pad_added`-Handler).
    let decodebin_sink_target = elements.lock().expect("lock poisoned")[2]
        .static_pad("sink")
        .ok_or("decodebin: no sink pad")?;
    demux.connect_pad_added(move |_demux, new_pad| {
        let Some(caps) = new_pad.current_caps() else { return };
        let Some(structure) = caps.structure(0) else { return };
        if structure.name().starts_with("video/") && !decodebin_sink_target.is_linked() {
            if let Err(e) = new_pad.link(&decodebin_sink_target) {
                eprintln!("omp-mxf-player: mxfdemux video pad link failed: {e:?}");
            }
        }
    });

    // Geklonter, owned Preset statt eines erneuten Id-Lookups im Closure
    // (vor der Umstellung auf laufzeit-ladbare Settings war `preset` ein
    // `&'static AudioPreset` aus der festen `PRESETS`-Konstante — ein
    // GStreamer-Signal-Closure muss 'static sein, ein Klon des bereits
    // vorliegenden Presets ist hier einfacher und robuster als eine
    // erneute Id-Suche in einer geklonten Presets-Liste, s. presets.rs).
    let preset_owned = preset.clone();
    let pipeline_for_nmp = pipeline.clone();
    let elements_for_nmp = elements.clone();
    demux.connect_no_more_pads(move |_demux| {
        let mut sorted = std::mem::take(&mut pending.lock().expect("lock poisoned").pads);
        sorted.sort_by_key(|(track, _)| *track);
        let input_channels = sorted.len() as u32;

        // `mxfdemux` demultiplext über EINE einzige interne Streaming-
        // Schleife sequenziell auf alle Track-Pads (live per `gst-launch`-
        // Fehlermeldung `gst_mxf_demux_loop()` bestätigt — kein Thread pro
        // Pad, anders als z. B. `uridecodebin`). Direkt an `interleave`
        // verlinkt (ohne Puffer dazwischen) blockiert das: `interleave`
        // sammelt (wie `audiomixer`/`compositor`) Daten von ALLEN
        // Sink-Pads, bevor es einen kombinierten Puffer ausgibt — der
        // erste `gst_pad_push()` von `mxfdemux`s einziger Schleife auf
        // Pad 0 blockiert dann für immer, weil `interleave` auf Pad 1..7
        // wartet, die dieselbe Schleife nie erreicht (live per Python/
        // GStreamer-Diagnose isoliert: ohne Queue kam auf 7 von 8
        // `interleave`-Sink-Pads nicht einmal das `stream-start`-Event
        // an). Fix: je Tonspur ein `queue` als Thread-Entkopplung,
        // Standard-GStreamer-Pattern für "Ein-Thread-Multi-Pad-Quelle
        // speist synchronisierenden Collector".
        for (rank, (_, pad)) in sorted.iter().enumerate() {
            let Some(sink) = interleave.request_pad_simple(&format!("sink_{rank}")) else {
                eprintln!("omp-mxf-player: interleave: request sink_{rank} failed");
                continue;
            };
            let queue = match gst::ElementFactory::make("queue").build() {
                Ok(q) => q,
                Err(e) => {
                    eprintln!("omp-mxf-player: queue(track {rank}): {e}");
                    continue;
                }
            };
            if let Err(e) = pipeline_for_nmp.add(&queue) {
                eprintln!("omp-mxf-player: add queue(track {rank}) failed: {e:?}");
                continue;
            }
            if let Err(e) = queue.sync_state_with_parent() {
                eprintln!("omp-mxf-player: sync_state_with_parent (queue track {rank}) failed: {e:?}");
                continue;
            }
            let Some(queue_sink) = queue.static_pad("sink") else { continue };
            let Some(queue_src) = queue.static_pad("src") else { continue };
            if let Err(e) = pad.link(&queue_sink) {
                eprintln!("omp-mxf-player: link mxfdemux track {rank} to queue failed: {e:?}");
                continue;
            }
            if let Err(e) = queue_src.link(&sink) {
                eprintln!("omp-mxf-player: link queue to interleave (track {rank}) failed: {e:?}");
                continue;
            }
            elements_for_nmp.lock().expect("lock poisoned").push(queue);
        }

        for (group_id, group_channels, matrix_el) in &matrix_elements {
            let coeffs = presets::matrix_for(&preset_owned, group_id, *group_channels, input_channels.max(1));
            matrix_el.set_property("in-channels", input_channels.max(1));
            matrix_el.set_property("out-channels", *group_channels);
            matrix_el.set_property("matrix", matrix_to_gst_array(&coeffs));
        }
    });

    // `filesrc`/`mxfdemux` erst jetzt starten (s. Sync-Reihenfolge-
    // Kommentar oben) — alle stromabwärtigen Konform-Ketten stehen
    // bereits auf PLAYING/PAUSED.
    filesrc
        .sync_state_with_parent()
        .map_err(|e| format!("sync_state_with_parent (filesrc): {e}"))?;
    demux
        .sync_state_with_parent()
        .map_err(|e| format!("sync_state_with_parent (mxfdemux): {e}"))?;

    Ok(Branch {
        elements,
        video: Terminal { sink_pad: video_pad, tail_src_pad: video_tail_pad },
        groups: group_terminals,
    })
}

/// Entfernt die Elemente eines Zweigs (Unlink + State Null + aus der
/// Pipeline entfernen) — die isel-Sink-Pads selbst (`Terminal::sink_pad`)
/// bleiben bestehen, damit `replace_slot` denselben Pad-Referenzwert
/// wiederverwenden kann. Reihenfolge (State-Null vor Unlink, alle
/// Elemente vor jedem `pipeline.remove()`) exakt wie
/// `omp-player::pipeline::teardown_branch` — dort ausführlich per `gdb`
/// hergeleitet (Use-after-free, wenn ein noch aktiver Streaming-Thread
/// eines `queue`-Elements während des Unlink schiebt), hier identisch
/// übernommen statt riskant neu zu erfinden.
fn teardown_branch(pipeline: &gst::Pipeline, branch: Branch) {
    let elements = branch.elements.lock().expect("lock poisoned");
    // State-Null MUSS vor dem Unlink passieren (Reihenfolge exakt wie
    // vor diesem Fix, `omp-player::pipeline::teardown_branch`-Lektion:
    // Use-after-free, wenn ein noch aktiver Streaming-Thread eines
    // `queue`-Elements während des Unlink schiebt) — jetzt zusätzlich
    // mit ECHTEM Warten auf den Abschluss statt eines verworfenen
    // `set_state()`-Ergebnisses, s. `stop_element_and_wait`-Doku.
    for el in elements.iter() {
        stop_element_and_wait(el);
    }
    let _ = branch.video.tail_src_pad.unlink(&branch.video.sink_pad);
    for terminal in &branch.groups {
        let _ = terminal.tail_src_pad.unlink(&terminal.sink_pad);
    }
    remove_elements(pipeline, &elements);
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    video_isel: gst::Element,
    group_isels: Vec<gst::Element>,
    branches: HashMap<Slot, Branch>,
    groups: Vec<presets::ProgramGroup>,
    presets: Vec<presets::AudioPreset>,
    width: u32,
    height: u32,
    _mxl_video_output: MxlVideoOutput,
    _mxl_group_outputs: Vec<MxlAudioOutput>,
    video_flowed: Arc<AtomicBool>,
    group_flowed: Vec<Arc<AtomicBool>>,
    onair_slot: Arc<AtomicU8>,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn replace_slot(active: &mut ActivePipeline, slot: Slot, source: &ItemSource) -> Result<(), String> {
    let old = active.branches.remove(&slot).ok_or("replace_slot: branch missing")?;
    let video_pad = old.video.sink_pad.clone();
    let group_pads: Vec<gst::Pad> = old.groups.iter().map(|t| t.sink_pad.clone()).collect();
    teardown_branch(&active.pipeline, old);

    let branch = match source {
        ItemSource::TestPattern => {
            build_empty_branch(&active.pipeline, video_pad, group_pads, &active.groups, active.width, active.height)?
        }
        ItemSource::Mxf { path, preset_id } => {
            let preset = presets::find_preset(&active.presets, preset_id).ok_or_else(|| format!("unknown preset: {preset_id}"))?;
            build_mxf_branch(&active.pipeline, video_pad, group_pads, &active.groups, path, preset, active.width, active.height)?
        }
    };
    active.branches.insert(slot, branch);
    Ok(())
}

fn apply_active(active: &ActivePipeline, slot: Slot) {
    let Some(branch) = active.branches.get(&slot) else { return };
    active.video_isel.set_property("active-pad", &branch.video.sink_pad);
    for (isel, terminal) in active.group_isels.iter().zip(branch.groups.iter()) {
        isel.set_property("active-pad", &terminal.sink_pad);
    }
    active.onair_slot.store(slot.code(), Ordering::Relaxed);
}

fn build(context: &Arc<MxlContext>, config: &Config, _event_tx: UnboundedSender<Event>) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let video_isel = gst::ElementFactory::make("input-selector")
        .name("video_isel")
        .property("sync-streams", false)
        .build()
        .map_err(|e| format!("video input-selector: {e}"))?;
    pipeline.add(&video_isel).map_err(|e| format!("add video isel: {e}"))?;

    let mut group_isels = Vec::with_capacity(config.groups.len());
    for group in &config.groups {
        let isel = gst::ElementFactory::make("input-selector")
            .name(format!("isel_{}", group.id))
            .property("sync-streams", false)
            .build()
            .map_err(|e| format!("isel({}): {e}", group.id))?;
        pipeline.add(&isel).map_err(|e| format!("add isel({}): {e}", group.id))?;
        group_isels.push(isel);
    }

    let mut branches = HashMap::new();
    for slot in [Slot::A, Slot::B] {
        let video_pad = video_isel
            .request_pad_simple(&format!("sink_{}", slot.pad_index()))
            .ok_or_else(|| format!("video isel: request sink_{} failed", slot.pad_index()))?;
        let mut group_pads = Vec::with_capacity(group_isels.len());
        for (isel, group) in group_isels.iter().zip(config.groups.iter()) {
            let pad = isel
                .request_pad_simple(&format!("sink_{}", slot.pad_index()))
                .ok_or_else(|| format!("isel({}): request sink_{} failed", group.id, slot.pad_index()))?;
            group_pads.push(pad);
        }
        let branch = build_empty_branch(&pipeline, video_pad, group_pads, &config.groups, config.width, config.height)?;
        branches.insert(slot, branch);
    }

    let mxl_video_output = MxlVideoOutput::new(
        &pipeline,
        &video_isel,
        context.clone(),
        &config.video_flow_id,
        &config.label,
        config.width,
        config.height,
        FRAMERATE_NUMERATOR,
        FRAMERATE_DENOMINATOR,
        Arc::new(AtomicU64::new(0)),
    )
    .map_err(|e| format!("MxlVideoOutput: {e}"))?;
    mxl_video_output.set_active(true);

    let mut mxl_group_outputs = Vec::with_capacity(group_isels.len());
    for i in 0..group_isels.len() {
        let isel = &group_isels[i];
        let group = &config.groups[i];
        let flow_id = &config.group_flow_ids[i];
        let output = MxlAudioOutput::new(
            &pipeline,
            isel,
            context.clone(),
            flow_id,
            &format!("{} {}", config.label, group.label),
            SAMPLE_RATE,
            group.channels,
        )
        .map_err(|e| format!("MxlAudioOutput({}): {e}", group.id))?;
        output.set_active(true);
        mxl_group_outputs.push(output);
    }

    pipeline.set_state(gst::State::Playing).map_err(|e| format!("set state playing: {e}"))?;

    video_isel.set_property("active-pad", &branches[&Slot::A].video.sink_pad);
    for (isel, terminal) in group_isels.iter().zip(branches[&Slot::A].groups.iter()) {
        isel.set_property("active-pad", &terminal.sink_pad);
    }

    let video_flowed = mxl_video_output.flowed_handle();
    let group_flowed = mxl_group_outputs.iter().map(|o| o.flowed_handle()).collect();

    Ok(ActivePipeline {
        pipeline,
        video_isel,
        group_isels,
        branches,
        groups: config.groups.clone(),
        presets: config.presets.clone(),
        width: config.width,
        height: config.height,
        _mxl_video_output: mxl_video_output,
        _mxl_group_outputs: mxl_group_outputs,
        video_flowed,
        group_flowed,
        onair_slot: Arc::new(AtomicU8::new(Slot::A.code())),
    })
}

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

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        video_flowed: active.video_flowed.clone(),
        group_flowed: active.group_flowed.clone(),
    }));

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::LoadSlot { slot, source }) => {
                if let Err(e) = replace_slot(&mut active, slot, &source) {
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
