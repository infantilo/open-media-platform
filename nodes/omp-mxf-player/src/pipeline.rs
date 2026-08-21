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
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicU8, Ordering};
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
    /// Jog/Shuttle/Seek (Nutzerauftrag 2026-08-21) — wirken immer auf den
    /// aktuell On-Air-Zweig (`ActivePipeline::onair_slot`), nicht auf
    /// einen explizit übergebenen Slot: ein Bedienpult scrubbt das
    /// laufende Programm, nicht einen im Hintergrund gecuten Zweig.
    /// `Seek`: absolute Zielposition in ms. `Step`: relative Framezahl
    /// (±, Jog). `SetRate`: Shuttle-Geschwindigkeit — bewusst NICHT als
    /// echter GStreamer-Segment-Rate-Seek umgesetzt (Rückwärts-Decoding
    /// ist bei `mxfdemux`/MPEG-2-Software-Decodern kein verlässlich
    /// unterstützter Pfad, s. `run()`s Shuttle-Tick-Kommentar) — stattdessen
    /// per getakteten Einzel-Seeks simuliert, die immer vorwärts mit
    /// Rate 1.0 decodieren.
    Seek(i64),
    Step(i64),
    SetRate(f64),
}

pub enum Event {
    Error(String),
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    video_flowed: Arc<AtomicBool>,
    group_flowed: Vec<Arc<AtomicBool>>,
    position_ms: Arc<AtomicI64>,
    rate_milli: Arc<AtomicI64>,
}

impl PipelineHandle {
    pub fn load_slot(&self, slot: Slot, source: ItemSource) {
        let _ = self.commands.send(Command::LoadSlot { slot, source });
    }

    pub fn set_active(&self, slot: Slot) {
        let _ = self.commands.send(Command::SetActive(slot));
    }

    /// Absoluter Sprung zur Zielposition (ms) im On-Air-Zweig.
    pub fn seek(&self, position_ms: i64) {
        let _ = self.commands.send(Command::Seek(position_ms));
    }

    /// Jog: relativer Sprung um `frames` Bilder (± = rückwärts/vorwärts)
    /// gegenüber der aktuellen Position.
    pub fn step(&self, frames: i64) {
        let _ = self.commands.send(Command::Step(frames));
    }

    /// Shuttle: Such-Geschwindigkeit als Vielfaches der Normalgeschwindigkeit
    /// (negativ = rückwärts, `1.0` = normale Wiedergabe). `0.0` kehrt zur
    /// normalen Vorwärtswiedergabe zurück (kein echtes Anhalten/Standbild —
    /// s. `Command::SetRate`-Doku).
    pub fn set_rate(&self, rate: f64) {
        let _ = self.commands.send(Command::SetRate(rate));
    }

    /// Aktuelle Position im On-Air-Zweig in ms — echte Pipeline-Position
    /// (`query_position`), keine Wanduhr mehr (Bugfix 2026-08-21: die
    /// bisherige `Instant::now() - onair_since`-Berechnung in `main.rs`
    /// lief nach jedem Seek/Shuttle sofort auseinander).
    pub fn position_ms(&self) -> i64 {
        self.position_ms.load(Ordering::Relaxed)
    }

    /// Aktuelle Shuttle-Rate (s. `set_rate`).
    pub fn rate(&self) -> f64 {
        self.rate_milli.load(Ordering::Relaxed) as f64 / 1000.0
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
    /// `mxfdemux`-Element dieses Zweigs (Jog/Shuttle/Seek, Nutzerauftrag
    /// 2026-08-21) — `None` beim "schwarz/stumm"-Leerlaufzweig
    /// (`build_empty_branch`, kein Datei-Decode, nichts zu seeken).
    /// `seek()` auf `demux` statt auf die gesamte `pipeline` gerufen:
    /// betrifft dadurch garantiert nur DIESEN Zweig, nicht den parallel
    /// im anderen Slot laufenden (s. `build()`-Moduldoku zum
    /// A/B-Slot-Modell — beide Zweige laufen unabhängig durch dieselbe
    /// `pipeline`, ein `pipeline`-weiter Seek würde fälschlich beide treffen).
    demux: Option<gst::Element>,
    /// `interleave`-Element dieses Zweigs (Nachtrag 157, 2026-08-21) —
    /// `None` beim Leerlaufzweig. Einziger Zweck: `teardown_branch` kann
    /// vor jedem Element-Stop per Pad-Probe auf DESSEN Src-Pad
    /// nachweislich abwarten, dass `interleave`s `GstCollectPads` alle
    /// 8 Tonspuren wirklich vollständig eingesammelt hat — s. dortige
    /// Doku für den Deadlock, den das sonst verursacht.
    interleave: Option<gst::Element>,
    /// Woraus dieser Zweig gebaut wurde (Nachtrag 159, 2026-08-21) —
    /// einziger Zweck: `maybe_revive_onair_branch` kann denselben Zweig
    /// 1:1 neu aufbauen, wenn `mxfdemux`s Pull-Task nach echtem EOS
    /// bereits gestoppt hat und ein Seek/Jog ihn deshalb nicht mehr
    /// erreicht (s. docs/decisions.md Nachtrag 158 — ein reiner
    /// `PAUSED`→`PLAYING`-Zyklus reicht bei `mxfdemux` dafür
    /// nachweislich NICHT aus).
    source: ItemSource,
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

/// Startup-Pendant zu `stop_element_and_wait` oben: ruft
/// `sync_state_with_parent()` und wartet auf den TATSÄCHLICHEN Abschluss
/// eines dabei angestoßenen `Async`-Übergangs, statt ihn zu verwerfen.
///
/// Per `GST_DEBUG` belegt (docs/decisions.md Nachtrag 155, "Position
/// bleibt kurz nach `take()` stehen"): ein neu in eine bereits PLAYING-
/// laufende Pipeline eingefügtes `decodebin` geht dabei sichtbar
/// `ASYNC` ("lost state of PLAYING, new PAUSED", hier ~76ms bis
/// `async-done`) — ohne auf diesen Abschluss zu warten, begann `mxfdemux`
/// (dank "Konsument vor Produzent"-Reihenfolge zwar SPÄTER als
/// `decodebin`, aber trotzdem zu früh) direkt danach mit dem Pushen von
/// Daten, bevor `decodebin`s Sink-Pad wirklich aufnahmebereit war.
/// `gst_mxf_demux_loop` meldete daraufhin "Internal data stream
/// error"/`GST_FLOW_ERROR` und stoppte seine GESAMTE Schleife dauerhaft
/// (Video UND Audio zusammen, da beide über denselben Loop laufen,
/// s. Moduldoku oben) — reproduzierbar ab dem zweiten `cue()`/
/// `take()`-Zyklus (mehr Elemente in der Pipeline zu diesem Zeitpunkt,
/// der Übergang dadurch eher wirklich asynchron statt synchron/sofort).
fn start_element_and_wait(el: &gst::Element) -> Result<(), String> {
    // `sync_state_with_parent()` liefert (anders als `set_state()`) nur
    // `Result<(), BoolError>` — ob der Übergang dabei synchron oder
    // `ASYNC` verlief, ist am Rückgabetyp nicht sichtbar. Deshalb hier
    // IMMER anschließend per `state(timeout)` bestätigen, statt wie bei
    // `stop_element_and_wait` nur im Async-Fall.
    el.sync_state_with_parent()
        .map_err(|e| format!("sync_state_with_parent ({}): {e}", el.name()))?;
    if el.state(gst::ClockTime::from_mseconds(500)).0.is_ok() {
        return Ok(());
    }
    // Gleiches Muster wie `stop_element_and_wait`: erster Versuch nicht
    // innerhalb 500ms bestätigt, derselbe bereits angestoßene Übergang
    // läuft weiter (kein erneuter Aufruf nötig), nur mit deutlich
    // längerem Timeout erneut abgefragt.
    if el.state(gst::ClockTime::from_seconds(3)).0.is_err() {
        return Err(format!(
            "{} erreichte den Ziel-Zustand nicht innerhalb ~3.5s",
            el.name()
        ));
    }
    Ok(())
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
        demux: None,
        interleave: None,
        source: ItemSource::TestPattern,
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
    // Pipeline-Zustand syncen, `mxfdemux`/`filesrc` erst danach. Nicht nur
    // ANSTOSSEN, sondern per `start_element_and_wait` auch den TATSÄCHLICHEN
    // Abschluss abwarten (s. dortige Doku) — sonst kann `mxfdemux` unten zu
    // früh zu pushen beginnen, während z. B. `decodebin` noch mitten in
    // einem `ASYNC`-Übergang steckt.
    for el in elements.iter().skip(2) {
        start_element_and_wait(el)?;
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
    // Geklont, damit die ursprüngliche `interleave`-Variable NICHT vom
    // Closure verschluckt wird — wird unten für `Branch::interleave`
    // gebraucht (Nachtrag 157, `drain_interleave`).
    let interleave_for_nmp = interleave.clone();
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
            let Some(sink) = interleave_for_nmp.request_pad_simple(&format!("sink_{rank}")) else {
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
    start_element_and_wait(&filesrc)?;
    start_element_and_wait(&demux)?;

    Ok(Branch {
        elements,
        video: Terminal { sink_pad: video_pad, tail_src_pad: video_tail_pad },
        groups: group_terminals,
        demux: Some(demux),
        interleave: Some(interleave),
        source: ItemSource::Mxf { path: path.to_string(), preset_id: preset.id.clone() },
    })
}

/// Führt `f` auf einem eigenen Thread aus und wartet höchstens `timeout`
/// darauf — Sicherheitsnetz gegen echte GStreamer-interne Deadlocks
/// (docs/decisions.md Nachtrag 157: `interleave`s `GstCollectPads` kann
/// beim Teardown eines Zweigs, dessen `mxfdemux` bereits vorher gestoppt
/// wurde, für immer auf ein nie ankommendes Geschwister-Track-Event
/// warten — per `gdb` an zwei verschiedenen Stellen bestätigt, einmal
/// sogar im eigens dagegen eingebauten Flush-Versuch selbst). Ohne
/// dieses Sicherheitsnetz legt ein einzelner solcher Hänger den
/// GESAMTEN Pipeline-Kommando-Thread für immer lahm (der Node meldet
/// sich dauerhaft `degraded`, jeder künftige Cue/Take/Seek bleibt
/// wirkungslos). Bei Timeout wird der Hilfs-Thread NICHT abgebrochen
/// (kein sicherer Weg, einen blockierten OS-/GStreamer-Thread von außen
/// zu unterbrechen) — er läuft im Hintergrund weiter und wird beim
/// nächsten Erfolg einfach fallengelassen; ein gelegentlicher
/// Leck-Thread ist der klar kleinere Schaden gegenüber einem dauerhaft
/// eingefrorenen Node.
fn run_with_timeout<F: FnOnce() + Send + 'static>(timeout: Duration, f: F) -> bool {
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        f();
        let _ = done_tx.send(());
    });
    done_rx.recv_timeout(timeout).is_ok()
}

/// Löst ein FRISCHES, selbst ausgelöstes EOS an `demux` aus und wartet
/// PER PAD-PROBE (nicht per Zeitschätzung) darauf, dass es tatsächlich
/// `interleave`s Src-Pad passiert, bevor `teardown_branch` überhaupt ein
/// einziges Element anfasst — GStreamers eigenes empfohlenes Muster für
/// "Teilbaum sicher aus laufender Pipeline entfernen" (docs/
/// decisions.md Nachtrag 157, zweiter Anlauf nach einem verworfenen
/// reinen Flush-Versuch).
///
/// **Warum ein SELBST ausgelöstes EOS statt auf das natürliche
/// Datei-Ende zu warten:** deckt zwei Fälle gleichermaßen ab, die vorher
/// nicht unterschieden wurden — (a) ein Item, das bereits real
/// durchgelaufen ist (dessen natürliches EOS könnte schon vorbei sein,
/// als reines Zeit-Warten unzuverlässig bestätigt), UND (b) ein Item,
/// das noch MITTEN in der Wiedergabe steckt und jetzt durch einen neuen
/// `cue()` vorzeitig abgebrochen wird (dort gibt es GAR KEIN
/// natürliches EOS abzuwarten). `gst_element_send_event` auf ein
/// Sink-seitiges Element wie `mxfdemux` ist der dokumentierte,
/// idiomatische Weg, einer Quelle "hör jetzt auf" zu signalisieren.
///
/// **Warum eine Pad-Probe statt (wie im ersten Anlauf) ein direkter
/// Flush:** ein Flush-Event AKTIV an `interleave`s Pads SENDEN
/// (`pad.send_event`) kollidiert nachweislich mit `GstCollectPads`
/// eigenem internen Lock, wenn gleichzeitig noch ein Producer-Thread
/// mitten in einem Push steckt (per `gdb` an genau dieser Stelle
/// zweite, andere Deadlock-Variante gefunden). Eine Probe dagegen
/// BEOBACHTET nur passiv, was ohnehin durch den Pad fließt — kein
/// eigener Lock-Erwerb im kritischen Pfad, keine Kollision möglich.
fn drain_interleave(demux: &gst::Element, interleave: &gst::Element, timeout: Duration) {
    let Some(src_pad) = interleave.static_pad("src") else { return };
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let tx = Mutex::new(Some(tx));
    let probe_id = src_pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_pad, info| {
        if info.event().is_some_and(|ev| ev.type_() == gst::EventType::Eos)
            && let Some(tx) = tx.lock().expect("lock poisoned").take()
        {
            let _ = tx.send(());
        }
        gst::PadProbeReturn::Ok
    });

    let _ = demux.send_event(gst::event::Eos::new());

    if rx.recv_timeout(timeout).is_err() {
        eprintln!(
            "omp-mxf-player: interleave lieferte kein EOS innerhalb {timeout:?} — fahre trotzdem mit dem Teardown fort (Nachtrag 157, der äußere run_with_timeout-Watchdog greift notfalls zusätzlich)"
        );
    }
    if let Some(id) = probe_id {
        src_pad.remove_probe(id);
    }
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
    // Nachtrag 157 (2026-08-21, echter Live-Deadlock per `gdb` gefunden,
    // reproduzierbar spätestens ab dem zweiten `cue()`/`take()`-Zyklus
    // auf einem Item, das bereits echtes EOS erreicht hatte): `interleave`
    // sammelt (GstCollectPads) auf ALLEN seinen Sink-Pads, bevor es
    // irgendetwas weiterreicht — auch das EOS-Event. Stand ein Track-
    // Queue (z. B. `queue0`) mitten in `gst_pad_push_event()` (schiebt
    // sein eigenes EOS in `interleave`), während `mxfdemux` (der EINZIGE
    // Produzent für ALLE 8 Tracks) bereits weiter unten in dieser
    // Funktion auf Null gesetzt wird, kommt das fehlende EOS eines
    // Geschwister-Tracks NIE mehr an — `interleave`s Collect wartet für
    // immer, `queue0`s Task-Thread bleibt für immer in diesem Push
    // hängen, und der SPÄTERE `stop_element_and_wait(queue0)` weiter
    // unten blockiert dann seinerseits für immer beim Versuch,
    // `gst_pad_stop_task()` auf diesen nie endenden Thread anzuwenden —
    // der komplette Pipeline-Kommando-Thread hängt, `LivenessMonitor`
    // meldet den Node dauerhaft "degraded". Fix: `drain_interleave`
    // GARANTIERT (per Pad-Probe, nicht per Zeitschätzung) abwarten, dass
    // `interleave`s Collect wirklich fertig ist, bevor auch nur ein
    // einziges `set_state(Null)` versucht wird.
    if let (Some(demux), Some(interleave)) = (&branch.demux, &branch.interleave) {
        drain_interleave(demux, interleave, Duration::from_secs(2));
    }
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
    // `run_with_timeout` statt eines direkten Aufrufs (Nachtrag 157, s.
    // dortige Doku): ein hängender Teardown darf NIEMALS den gesamten
    // Kommando-Thread mitreißen. Bei Timeout wird DIESER Cue-Versuch mit
    // einer klaren Fehlermeldung abgebrochen (statt eines stillen
    // Dauerhängers) — der betroffene Slot bleibt danach ohne Zweig
    // (kein automatisches Selbstheilen, s. Doku), der ANDERE Slot und
    // alle übrigen Kommandos (Seek/Shuttle/Take auf den bereits aktiven
    // Zweig) bleiben aber uneingeschränkt bedienbar.
    let pipeline_for_teardown = active.pipeline.clone();
    if !run_with_timeout(Duration::from_secs(5), move || {
        teardown_branch(&pipeline_for_teardown, old);
    }) {
        return Err(format!(
            "teardown von Slot {slot:?} nach 5s abgebrochen (vermutlich GStreamer-Deadlock, docs/decisions.md Nachtrag 157) — {slot:?} bleibt vorerst ohne Zweig"
        ));
    }

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

    let mut active = match build(&context, &config, tx.clone()) {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("initial build failed: {e}")));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let position_ms = Arc::new(AtomicI64::new(0));
    // 1000 == Rate 1.0 ("normal"), s. `Command::SetRate`-Doku.
    let rate_milli = Arc::new(AtomicI64::new(1000));
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        video_flowed: active.video_flowed.clone(),
        group_flowed: active.group_flowed.clone(),
        position_ms: position_ms.clone(),
        rate_milli: rate_milli.clone(),
    }));

    // Tick-Intervall von vormals 500ms auf 200ms verkürzt: sowohl für
    // spürbar reaktionsschnelleres Shuttle (s. unten) als auch für
    // aktuellere `position_ms`-Werte — der Heartbeat (LivenessMonitor)
    // feuert dabei einfach häufiger, das ist unschädlich.
    const TICK: Duration = Duration::from_millis(200);
    loop {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(TICK) {
            Ok(Command::LoadSlot { slot, source }) => {
                if let Err(e) = replace_slot(&mut active, slot, &source) {
                    let _ = tx.send(Event::Error(format!("cue into slot {slot:?} failed: {e}")));
                }
            }
            Ok(Command::SetActive(slot)) => {
                apply_active(&active, slot);
            }
            Ok(Command::Seek(target_ms)) => {
                seek_onair_with_revive(&mut active, target_ms.max(0) as u64);
            }
            Ok(Command::Step(frames)) => {
                if let Some(current) = onair_demux(&active).and_then(query_position_ms) {
                    let delta_ms = frames * 1000 * FRAMERATE_DENOMINATOR as i64 / FRAMERATE_NUMERATOR as i64;
                    let target = (current + delta_ms).max(0) as u64;
                    seek_onair_with_revive(&mut active, target);
                }
            }
            Ok(Command::SetRate(rate)) => {
                rate_milli.store((rate * 1000.0).round() as i64, Ordering::Relaxed);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if let Some(pos_ms) = onair_demux(&active).and_then(query_position_ms) {
            position_ms.store(pos_ms, Ordering::Relaxed);

            // Shuttle (Nutzerauftrag 2026-08-21): bewusst KEIN echter
            // GStreamer-Segment-Rate-Seek (Rückwärts-Decoding ist bei
            // `mxfdemux`/MPEG-2-Software-Decodern kein verlässlich
            // unterstützter Pfad) — stattdessen simuliert per getakteten
            // Einzel-Seeks, die IMMER vorwärts mit Rate 1.0 decodieren:
            // jeden Tick um `rate × TICK` weiterspringen. Rate `1.0`
            // ("normal") tickt bewusst NICHT — dort läuft die Pipeline
            // ungestört durch statt alle 200ms neu zu seeken.
            let rate = rate_milli.load(Ordering::Relaxed) as f64 / 1000.0;
            if rate != 1.0 {
                let delta_ms = (rate * TICK.as_millis() as f64) as i64;
                let target = (pos_ms + delta_ms).max(0) as u64;
                seek_onair_with_revive(&mut active, target);
            }
        }
    }

    drop(active);
}

/// `mxfdemux`-Element des aktuell On-Air-Zweigs (`None` beim
/// "schwarz/stumm"-Leerlaufzweig oder falls das Item bereits ausgetauscht
/// wurde, während `onair_slot` noch den alten Wert trägt — reiner
/// Best-Effort-Zugriff, kein Fehlerfall).
fn onair_demux(active: &ActivePipeline) -> Option<&gst::Element> {
    let slot = if active.onair_slot.load(Ordering::Relaxed) == Slot::A.code() {
        Slot::A
    } else {
        Slot::B
    };
    active.branches.get(&slot)?.demux.as_ref()
}

fn query_position_ms(demux: &gst::Element) -> Option<i64> {
    demux.query_position::<gst::ClockTime>().map(|t| t.mseconds() as i64)
}

/// Absoluter, flushender, framegenauer Seek auf `target_ms` — immer mit
/// Rate 1.0 vorwärts (s. `Command::SetRate`-Doku, gilt für `Seek`, `Step`
/// UND den Shuttle-Tick oben gleichermaßen). Fehler werden bewusst
/// verschluckt: ein Seek über das Dateiende hinaus (Shuttle/Jog am
/// Item-Ende) soll nicht den gesamten Node-Prozess mit einer
/// `Event::Error`-Meldung überschwemmen, sondern schlicht wirkungslos
/// bleiben (`mxfdemux` ignoriert einen Seek jenseits der Dauer bereits
/// selbst, meist ohne Fehler — dieses `let _ =` deckt nur die übrigen,
/// seltenen Fehlerfälle ab, z. B. noch nicht preroll-fertige Elemente).
fn seek_to(demux: &gst::Element, target_ms: u64) {
    let _ = demux.seek(
        1.0,
        gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
        gst::SeekType::Set,
        gst::ClockTime::from_mseconds(target_ms),
        gst::SeekType::None,
        gst::ClockTime::NONE,
    );
    // 2026-08-21 root-caused per Diagnose-Build (Nutzerfund "seek und
    // einfaches play geht nicht" — bestätigt an der laufenden Instanz):
    // `demux.seek()` liefert `Ok(())` und meldet damit Erfolg, sobald
    // aber `mxfdemux`s eigener Pull-Mode-Task nach echtem Datei-EOS
    // bereits selbst gestoppt hat (`gst_pad_pause_task()`), bewirkt der
    // Seek NICHTS — der Task läuft nie wieder an, um das neue Ziel
    // überhaupt zu bemerken (`GST_ELEMENT(demux)`s Zustand bleibt dabei
    // unverändert PLAYING, ein einfaches "nochmal auf Playing setzen"
    // wäre daher ein GStreamer-seitiges No-Op). Ein expliziter
    // PAUSED→PLAYING-Zyklus zwingt GStreamers normale
    // Zustandsübergangs-Maschinerie dazu, `gst_pad_start_task()` für
    // den Sink-Pad-Task erneut aufzurufen — anders als der reine
    // Seek-Aufruf allein.
    //
    // Live-Test-Fund (direkt beim Verifizieren dieses Fixes, dieselbe
    // Sitzung): ein reines Hintereinander-`set_state()` ohne auf den
    // Abschluss von PAUSED zu warten, war selbst noch unzuverlässig
    // (mal wirkte der Seek, mal nicht — exakt dieselbe Bug-Klasse wie
    // `start_element_and_wait`/`stop_element_and_wait` an anderer
    // Stelle: ein `set_state()`-Aufruf kann `Async` liefern, der
    // NÄCHSTE `set_state()`-Aufruf trifft dann auf einen noch
    // laufenden Übergang). Jetzt wird auf PAUSED echt gewartet, bevor
    // PLAYING erneut angefordert wird.
    let _ = demux.set_state(gst::State::Paused);
    let _ = demux.state(gst::ClockTime::from_mseconds(500));
    let _ = demux.set_state(gst::State::Playing);
}

/// Führt einen Seek auf den aktuellen On-Air-Zweig aus und baut ihn bei
/// Bedarf automatisch neu auf (Nachtrag 159, 2026-08-21). Hintergrund:
/// `seek_to`s PAUSED→PLAYING-Zyklus reicht nachweislich NICHT aus, um
/// `mxfdemux`s Pull-Task nach echtem Datei-EOS wieder anlaufen zu lassen
/// (per `gdb` an der laufenden Instanz bestätigt, 5 Wiederholungen, s.
/// `seek_to`-Doku) — ein Seek/Jog danach bliebe sonst für immer
/// wirkungslos. Erkennung bewusst simpel und ohne GStreamer-interne
/// Zustände abzufragen (die laut gdb-Befund dabei PLAYING bleiben, also
/// kein brauchbares Signal liefern): Position vor und nach dem Seek
/// vergleichen — bewegt sie sich trotz eines eigentlich nötigen Sprungs
/// nicht, war der Task tot. Der Neuaufbau nutzt bewusst denselben Weg wie
/// `cue()`/`take()` (`replace_slot`/`build_mxf_branch`), der in dieser
/// Sitzung bereits über 18 Zyklen hinweg live verifiziert wurde (Nachtrag
/// 157) — kein neuer, unabhängig zu verifizierender Codepfad. Gilt für
/// `Seek`, `Step` UND den Shuttle-Tick gleichermaßen (alle drei rufen
/// diese Funktion statt `seek_to` direkt).
fn seek_onair_with_revive(active: &mut ActivePipeline, target_ms: u64) {
    let slot = if active.onair_slot.load(Ordering::Relaxed) == Slot::A.code() {
        Slot::A
    } else {
        Slot::B
    };
    let Some(branch) = active.branches.get(&slot) else { return };
    let Some(demux) = branch.demux.clone() else {
        // Leerlaufzweig (`build_empty_branch`, kein Datei-Decode) — nichts zu seeken.
        return;
    };
    let source = branch.source.clone();
    // `branch`-Ausleihe endet hier (letzte Verwendung oben) — ab jetzt
    // wieder frei für die `&mut active`-Aufrufe unten (`replace_slot`).

    let before_pos = query_position_ms(&demux);
    seek_to(&demux, target_ms);
    // Live-Test-Fund: ein lebendiger Task reagiert auf einen Seek nahezu
    // sofort (<100ms bis sich die Position bewegt) — 250ms Toleranz
    // reicht für eine zuverlässige Erkennung, ohne Jog/Shuttle spürbar zu
    // verlangsamen.
    std::thread::sleep(Duration::from_millis(250));
    let after_pos = query_position_ms(&demux);
    let seek_was_needed = before_pos != Some(target_ms as i64);
    let stuck = seek_was_needed && before_pos.is_some() && after_pos == before_pos;
    if !stuck {
        return;
    }

    eprintln!(
        "omp-mxf-player: Seek auf Slot {slot:?} (Ziel {target_ms}ms) wirkungslos — mxfdemux-Task vermutlich nach EOS gestoppt, baue Zweig neu auf (Nachtrag 159)"
    );
    if let Err(e) = replace_slot(active, slot, &source) {
        eprintln!("omp-mxf-player: Zweig-Neuaufbau für Seek fehlgeschlagen: {e}");
        return;
    }
    if let Some(new_demux) = active.branches.get(&slot).and_then(|b| b.demux.as_ref()) {
        seek_to(new_demux, target_ms);
    }
}
