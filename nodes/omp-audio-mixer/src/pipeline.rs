//! GStreamer-Pipeline von `omp-audio-mixer` (`UMSETZUNG.md` C11,
//! `ARCHITECTURE.md` §13.2).
//!
//! **Kanal-Audioquelle: intern per Default, extern per MXL wählbar
//! (2026-07-11 nachgezogen).** Jeder neu angelegte Kanal startet mit
//! einem internen `audiotestsrc`-Testton (unterschiedliche Frequenz je
//! Kanal, Software-Testmittel-Linie, `UMSETZUNG.md` §0 Punkt 7) — zum
//! Zeitpunkt des ursprünglichen C11-Minimalausbaus gab es noch keinen
//! MXL-Audio-erzeugenden Node im System (`omp-source`, C5, ist reines
//! Video), ein extern wählbarer Eingang wäre ein Henne-Ei-Problem
//! gewesen (`docs/decisions.md` 2026-07-11). Inzwischen kann derselbe
//! Node selbst als Quelle dienen (sein `MxlAudioOutput`-Sender ist über
//! IS-04 discoverbar) — `channel.<id>.setSource` schaltet einen Kanal
//! deshalb auf einen per Discovery gefundenen externen MXL-Audio-Sender
//! um (`omp_mediaio::mxl::MxlAudioInput`, neu) oder zurück auf den
//! internen Testton (`senderId=""`). Der **Ausgang** war von Anfang an
//! ein echter MXL-Audio-Flow (`omp_mediaio::mxl::MxlAudioOutput`).
//!
//! **Dynamische Kanalzahl ohne Pipeline-Rebuild:** anders als
//! `omp-switcher`/`omp-video-mixer-me` (C7/C10, dort zwingt eine
//! *externe* Quellenmenge-Änderung einen Neuaufbau, weil `MxlVideoInput`
//! ohnehin bei jedem discovery-Tick neu bewertet wird) baut `addChannel`/
//! `removeChannel` hier nur den betroffenen Zweig dynamisch an die schon
//! laufende Pipeline an/ab (`GstAggregator`-Sink-Pads — hier
//! `audiomixer.sink_%u` — unterstützen Request/Release im Zustand
//! PLAYING, `gst-inspect-1.0 audiomixer`: `Availability: On request`,
//! kein Parse-Zeit-Vorbehalt wie beim Compositor-Pad-Property-Fall in
//! C10). Das ist exakt die in §13.2 geforderte „Kanalzahl als
//! Laufzeit-Eigenschaft, keine Neustart-/Konfigurationsfrage".
//!
//! **Gain/Mute als Pad-Property, EQ als eigenes Element:** wie in C10
//! (`gst-inspect-1.0 audiomixer`: Sink-Pads haben `volume`/`mute` als
//! `controllable`-Properties) — kein separates `volume`-Element pro
//! Kanal nötig. 3-Band-EQ ist dagegen ein eigener Filter
//! (`equalizer-3bands`, `band0`/`band1`/`band2` = Low/Mid/High in dB),
//! den es als Pad-Property nicht gibt.
//!
//! **Standardklassen geprüft, nicht angenommen (`UMSETZUNG.md` §0 Punkt
//! 6, 2026-07-11 am MS-05-02-Quellrepo verifiziert):** der komplette
//! MS-05-02-Kernklassenbaum (`github.com/AMWA-TV/ms-05-02`,
//! `models/classes/*.json`) umfasst nur sechs Klassen — `NcObject`,
//! `NcBlock`, `NcWorker`, `NcManager`, `NcDeviceManager`,
//! `NcClassManager` — keine `NcGain`/`NcMute`/EQ-Klasse. Die in
//! `ARCHITECTURE.md` §11.1/§13.2 erwähnte AES70/OCA-Analogie bezieht sich
//! auf ein verwandtes, aber separates Standardmodell, nicht auf im
//! MS-05-02-Kern tatsächlich vorhandene Klassen; MS-05-03 (das
//! vorgesehene Blockspec-Folgedokument) ist weiterhin „Work In Progress"
//! ohne veröffentlichte Audio-Blockspecs (bereits für C10 verifiziert).
//! Eigene `gain`/`mute`/`eq*`-Properties pro Kanal sind damit nach §11.1
//! Punkt 3 korrekt, kein Standard wird dupliziert.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub const SAMPLE_RATE: u32 = 48000;
pub const CHANNELS: u32 = 2;

/// `level`-Element-Meldeintervall (K4-Teil-1, §4.3a: "50 ms").
const LEVEL_INTERVAL_NS: u64 = 50_000_000;

pub struct Config {
    pub domain: String,
    pub flow_id: String,
    pub label: String,
}

pub enum Event {
    Error(String),
    /// Ein `level`-Bus-Message, bereits auf 0..1 (linear, wie
    /// `omp-kit`s `<omp-meter>` es erwartet) umgerechnet — `channel_id
    /// == None` ist der Master (K4-Teil-1, `docs/END-GOAL-FEATURES.md`
    /// §4.3a). `main.rs` reicht das an `levels::Broadcaster` weiter.
    Level {
        channel_id: Option<String>,
        rms: f64,
        peak: f64,
    },
}

/// dB → 0..1-Näherung fürs `<omp-meter>`-Kit-Element (0 dBFS = 1.0,
/// alles darunter linear kleiner) — dieselbe Formel wie `db_to_linear`
/// unten, hier separat benannt, weil sie fachlich etwas anderes
/// ausdrückt (Anzeige-Pegel, nicht Fader-Gain).
fn db_to_meter_level(db: f64) -> f64 {
    10f64.powf(db / 20.0).clamp(0.0, 1.0)
}

/// Liest die `rms`/`peak`-Arrays aus einem `level`-Element-Bus-Message
/// und mittelt sie zu einem einzelnen Wert — das Kit-Meter zeigt einen
/// Balken pro Kanalzug, keine getrennte L/R-Anzeige (Teil 1). **Typ ist
/// `glib::ValueArray` (`GValueArray`), nicht `gst::Array`
/// (`GST_TYPE_ARRAY`)** — per Live-Test mit `gst-launch-1.0 -m`
/// verifiziert (`rms=(GValueArray)< ... >` in der Bus-Message-Ausgabe),
/// nicht angenommen: mit `gst::Array` schlug `structure.get()` still
/// fehl (kein Panic, nur `Err` → `?` → `None`), sodass nie ein Level-
/// Event verschickt wurde, obwohl die Bus-Messages selbst ankamen — ein
/// per Live-Verifikation (`curl`/rohes TCP gegen `/levels`, 0 Bytes
/// Body trotz erfolgreicher Verbindung) gefundener Bug.
fn parse_level_message(structure: &gst::StructureRef) -> Option<(f64, f64)> {
    let rms = structure.get::<gst::glib::ValueArray>("rms").ok()?;
    let peak = structure.get::<gst::glib::ValueArray>("peak").ok()?;
    let avg = |arr: &gst::glib::ValueArray| -> f64 {
        let values: Vec<f64> = arr.iter().filter_map(|v| v.get::<f64>().ok()).collect();
        if values.is_empty() {
            f64::NEG_INFINITY
        } else {
            values.iter().sum::<f64>() / values.len() as f64
        }
    };
    Some((db_to_meter_level(avg(&rms)), db_to_meter_level(avg(&peak))))
}

/// Woher ein Kanal sein Audio bezieht — `Internal` (Testton) oder
/// `External` (echter MXL-Audio-Flow, per `flow_id` adressiert; die
/// Sender→Flow-Auflösung passiert vorher in `main.rs`, hier ist nur noch
/// die fertige `flow_id` bekannt).
#[derive(Clone)]
pub enum ChannelSource {
    Internal { freq: f64 },
    External { flow_id: String },
}

/// Ein EQ-Band von `equalizer-nbands` (§4.6, docs/END-GOAL-FEATURES.md
/// 2026-07-17 Nachtrag): per Live-Introspektion verifiziert (nicht
/// geraten, `UMSETZUNG.md` §0 Punkt 6) — `num-bands=3` weist den drei
/// `GstIirEqualizerBand`-Kindobjekten automatisch Low-Shelf/Peak/
/// High-Shelf zu (Reihenfolge 0/1/2), passend zur bisherigen Low/Mid/
/// High-Benennung, jetzt mit einstellbarer Frequenz+Bandbreite statt
/// nur Gain.
#[derive(Clone, Copy)]
pub enum EqBand {
    Low,
    Mid,
    High,
}

impl EqBand {
    fn child_index(self) -> u32 {
        match self {
            EqBand::Low => 0,
            EqBand::Mid => 1,
            EqBand::High => 2,
        }
    }
}

/// Kompressor-Parameter (§4.6 Teil 2, ein `audiodynamic`-Element pro
/// Kanal bzw. auf dem Master-Bus). `threshold_db`/`makeup_db` sind
/// Anwender-Einheiten (dB) — die Rust-Seite rechnet `threshold`
/// (`audiodynamic` erwartet **linear** 0..1, kein dB, live per
/// `gst-inspect-1.0 audiodynamic` verifiziert) und `makeup_db` (eigenes
/// `volume`-Element danach, `audiodynamic` selbst hat keine Makeup-
/// Gain-Eigenschaft) um. `enabled=false` erzwingt `ratio=1.0`
/// (Bypass ohne das Element aus der Pipeline zu entfernen — bei
/// `ratio=1` ist die Wirkung unabhängig vom Threshold ein No-Op).
#[derive(Clone, Copy)]
pub struct CompParams {
    pub enabled: bool,
    pub threshold_db: f64,
    pub ratio: f64,
    pub makeup_db: f64,
}

enum Command {
    AddChannel { id: String, source: ChannelSource },
    RemoveChannel(String),
    SetChannelSource { id: String, source: ChannelSource },
    SetGain { id: String, db: f64 },
    SetMute { id: String, muted: bool },
    SetEq { id: String, low: f64, mid: f64, high: f64 },
    SetEqBand { id: String, band: EqBand, freq: f64, width: f64 },
    SetComp { id: String, params: CompParams },
    SetMasterLimiter { params: CompParams },
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    flowed: Arc<AtomicBool>,
}

impl PipelineHandle {
    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2): ob
    /// der Misch-Ausgang bereits mindestens einen echten Buffer
    /// geschrieben hat — unabhängig davon, ob/wie viele Kanäle aktuell
    /// angeschlossen sind (der Mixer produziert auch ohne Kanäle Stille).
    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }

    pub fn add_channel(&self, id: String, source: ChannelSource) {
        let _ = self.commands.send(Command::AddChannel { id, source });
    }

    pub fn remove_channel(&self, id: String) {
        let _ = self.commands.send(Command::RemoveChannel(id));
    }

    pub fn set_channel_source(&self, id: String, source: ChannelSource) {
        let _ = self
            .commands
            .send(Command::SetChannelSource { id, source });
    }

    pub fn set_gain(&self, id: String, db: f64) {
        let _ = self.commands.send(Command::SetGain { id, db });
    }

    pub fn set_mute(&self, id: String, muted: bool) {
        let _ = self.commands.send(Command::SetMute { id, muted });
    }

    pub fn set_eq(&self, id: String, low: f64, mid: f64, high: f64) {
        let _ = self
            .commands
            .send(Command::SetEq { id, low, mid, high });
    }

    pub fn set_eq_band(&self, id: String, band: EqBand, freq: f64, width: f64) {
        let _ = self.commands.send(Command::SetEqBand { id, band, freq, width });
    }

    pub fn set_comp(&self, id: String, params: CompParams) {
        let _ = self.commands.send(Command::SetComp { id, params });
    }

    pub fn set_master_limiter(&self, params: CompParams) {
        let _ = self.commands.send(Command::SetMasterLimiter { params });
    }
}

/// dB → lineares `volume`-Pad-Property (0 dB = 1.0), Standardformel.
fn db_to_linear(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// Setzt Frequenz+Bandbreite (Hz) eines `equalizer-nbands`-Bands über
/// `GstChildProxy` — Gain bleibt unangetastet (eigener, unveränderter
/// `SetEq`-Pfad, s. Moduldoku bei `EqBand`).
fn apply_eq_band(eq: &gst::Element, band: EqBand, freq: f64, width: f64) {
    let Some(proxy) = eq.dynamic_cast_ref::<gst::ChildProxy>() else {
        return;
    };
    let Some(child) = proxy.child_by_index(band.child_index()) else {
        return;
    };
    child.set_property("freq", freq);
    child.set_property("bandwidth", width);
}

fn apply_eq_gain(eq: &gst::Element, low: f64, mid: f64, high: f64) {
    let Some(proxy) = eq.dynamic_cast_ref::<gst::ChildProxy>() else {
        return;
    };
    for (index, gain) in [(0u32, low), (1, mid), (2, high)] {
        if let Some(child) = proxy.child_by_index(index) {
            child.set_property("gain", gain);
        }
    }
}

/// Übernimmt Kompressor-Parameter auf ein `audiodynamic`-Element plus
/// das direkt danach verkettete Makeup-`volume`-Element (s. `CompParams`-
/// Doku: `enabled=false` erzwingt `ratio=1.0`, kein Pipeline-Umbau).
fn apply_comp_params(comp: &gst::Element, makeup: &gst::Element, params: &CompParams) {
    let ratio = if params.enabled { params.ratio.max(1.0) } else { 1.0 };
    comp.set_property("ratio", ratio as f32);
    comp.set_property("threshold", db_to_linear(params.threshold_db).clamp(0.0, 1.0) as f32);
    makeup.set_property("volume", db_to_linear(params.makeup_db));
}

struct ChannelBranch {
    /// Alle Elemente dieses Zweigs, in Verkettungsreihenfolge (Quelle …
    /// `eq`) — für sauberes chirurgisches Entfernen (`remove_channel_
    /// branch`) statt der früheren Peer-Pad-Suche, die nur für den
    /// Testton-Fall funktionierte. Bei externer Quelle stammen die
    /// vorderen Elemente aus `MxlAudioInput::elements`.
    elements: Vec<gst::Element>,
    eq: gst::Element,
    /// Kompressor + Makeup-Gain (§4.6 Teil 2) — separat von `elements`
    /// referenziert, weil Kommandos gezielt genau diese beiden
    /// Elemente ansprechen (analog `eq` oben).
    comp: gst::Element,
    comp_makeup: gst::Element,
    mixer_pad: gst::Pad,
    /// Hält den Lese-Thread einer externen Quelle am Leben (`Drop`
    /// stoppt ihn) — `None` beim internen Testton.
    _external_input: Option<MxlAudioInput>,
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    mixer: gst::Element,
    channels: HashMap<String, ChannelBranch>,
    /// Master-Limiter + Makeup-Gain (§4.6 Teil 2), zwischen `mixer` und
    /// `level_master` — s. `build()`.
    master_limiter: gst::Element,
    master_makeup: gst::Element,
    _mxl_output: MxlAudioOutput,
    flowed: Arc<AtomicBool>,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn add_channel_branch(
    active: &mut ActivePipeline,
    context: &Arc<MxlContext>,
    id: &str,
    source: &ChannelSource,
) -> Result<(), String> {
    if active.channels.contains_key(id) {
        return Ok(());
    }

    // `tail` = letztes Element der Quelle (verlinkt gleich auf `convert`),
    // `elements` sammelt alles, was dieser Zweig selbst zur Pipeline
    // hinzugefügt hat (für `remove_channel_branch`) — bei externer Quelle
    // bereits von `MxlAudioInput::new` zur Pipeline hinzugefügt, hier nur
    // übernommen, nicht erneut `pipeline.add()`.
    let (tail, mut elements, external_input) = match source {
        ChannelSource::Internal { freq } => {
            let src = gst::ElementFactory::make("audiotestsrc")
                .property("is-live", true)
                .property("freq", *freq)
                .property("volume", 0.3f64)
                .build()
                .map_err(|e| format!("audiotestsrc ({id}): {e}"))?;
            src.set_property_from_str("wave", "sine");
            active
                .pipeline
                .add(&src)
                .map_err(|e| format!("add audiotestsrc ({id}): {e}"))?;
            (src.clone(), vec![src], None)
        }
        ChannelSource::External { flow_id } => {
            let input = MxlAudioInput::new(&active.pipeline, context.clone(), flow_id)
                .map_err(|e| format!("MxlAudioInput ({id}, flow {flow_id}): {e}"))?;
            (input.tail.clone(), input.elements.clone(), Some(input))
        }
    };

    let convert = gst::ElementFactory::make("audioconvert")
        .build()
        .map_err(|e| format!("audioconvert ({id}): {e}"))?;
    // §4.6 (docs/END-GOAL-FEATURES.md, 2026-07-17): `equalizer-nbands`
    // statt `equalizer-3bands` — bei `num-bands=3` weisen sich die drei
    // Kindobjekte automatisch Low-Shelf/Peak/High-Shelf zu (per
    // Live-Introspektion verifiziert, s. `EqBand`-Doku), macht Low/Mid/
    // High jetzt frequenz-/bandbreiten-einstellbar statt nur im Gain.
    let eq = gst::ElementFactory::make("equalizer-nbands")
        .name(format!("eq-{id}"))
        .property("num-bands", 3u32)
        .build()
        .map_err(|e| format!("equalizer-nbands ({id}): {e}"))?;
    apply_eq_band(&eq, EqBand::Low, 100.0, 200.0);
    apply_eq_band(&eq, EqBand::Mid, 1000.0, 1000.0);
    apply_eq_band(&eq, EqBand::High, 8000.0, 4000.0);

    // Kompressor + Makeup-Gain (§4.6 Teil 2) — startet deaktiviert
    // (`ratio=1`, No-Op, s. `apply_comp_params`), damit ein neuer Kanal
    // sich klanglich nicht von vor diesem Schritt unterscheidet.
    let comp = gst::ElementFactory::make("audiodynamic")
        .name(format!("comp-{id}"))
        .build()
        .map_err(|e| format!("audiodynamic ({id}): {e}"))?;
    let comp_makeup = gst::ElementFactory::make("volume")
        .name(format!("comp-makeup-{id}"))
        .build()
        .map_err(|e| format!("volume/makeup ({id}): {e}"))?;
    apply_comp_params(
        &comp,
        &comp_makeup,
        &CompParams { enabled: false, threshold_db: 0.0, ratio: 1.0, makeup_db: 0.0 },
    );

    // Metering (K4-Teil-1, `docs/END-GOAL-FEATURES.md` §4.3a): **nach**
    // EQ+Kompressor, weiterhin **vor** dem Fader (Gain/Mute bleiben
    // `audiomixer`-Sink-Pad-Properties, s. Moduldoku "Gain/Mute als
    // Pad-Property") — zeigt jetzt den tatsächlich klangformenden
    // Signalpfad inklusive Kompressor, nicht mehr nur den EQ'ten Pegel.
    let level = gst::ElementFactory::make("level")
        .name(format!("level-{id}"))
        .property("interval", LEVEL_INTERVAL_NS)
        .build()
        .map_err(|e| format!("level ({id}): {e}"))?;

    active
        .pipeline
        .add(&convert)
        .and_then(|()| active.pipeline.add(&eq))
        .and_then(|()| active.pipeline.add(&comp))
        .and_then(|()| active.pipeline.add(&comp_makeup))
        .and_then(|()| active.pipeline.add(&level))
        .map_err(|e| format!("add channel elements ({id}): {e}"))?;
    gst::Element::link_many([&tail, &convert, &eq, &comp, &comp_makeup, &level])
        .map_err(|e| format!("link channel chain ({id}): {e}"))?;
    elements.push(convert);

    let mixer_pad = active
        .mixer
        .request_pad_simple("sink_%u")
        .ok_or_else(|| format!("audiomixer: request sink pad failed ({id})"))?;
    level
        .static_pad("src")
        .ok_or("level: no src pad")?
        .link(&mixer_pad)
        .map_err(|e| format!("link level to mixer ({id}): {e}"))?;

    // Neue Elemente in einer bereits laufenden (PLAYING) Pipeline müssen
    // ihren Zustand explizit an den Elternzustand angleichen — sonst
    // bleiben sie in NULL/READY hängen und liefern nie Daten.
    for el in elements.iter().chain([&eq, &comp, &comp_makeup, &level]) {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync_state_with_parent ({id}): {e}"))?;
    }

    elements.push(eq.clone());
    elements.push(comp.clone());
    elements.push(comp_makeup.clone());
    elements.push(level.clone());
    active.channels.insert(
        id.to_string(),
        ChannelBranch {
            elements,
            eq,
            comp,
            comp_makeup,
            mixer_pad,
            _external_input: external_input,
        },
    );
    Ok(())
}

fn remove_channel_branch(active: &mut ActivePipeline, id: &str) {
    let Some(branch) = active.channels.remove(id) else {
        return;
    };
    // Reihenfolge: erst den Mixer-Pad freigeben (stoppt den Datenfluss in
    // den Mixer sauber), dann jedes Zweig-Element auf NULL setzen und aus
    // der Pipeline entfernen — Gegenrichtung des Aufbaus in
    // `add_channel_branch`. `_external_input` wird beim Drop von `branch`
    // am Ende dieser Funktion automatisch verworfen, was den Lese-Thread
    // stoppt (aber nicht dessen Pipeline-Elemente entfernt — die stehen
    // bereits in `elements` und werden hier explizit aufgeräumt).
    active.mixer.release_request_pad(&branch.mixer_pad);
    for el in &branch.elements {
        let _ = el.set_state(gst::State::Null);
        let _ = active.pipeline.remove(el);
    }
}

fn build(context: &Arc<MxlContext>, config: &Config) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let mixer = gst::ElementFactory::make("audiomixer")
        .name("mixer")
        .build()
        .map_err(|e| format!("audiomixer: {e}"))?;
    // Master-Limiter + Makeup-Gain (§4.6 Teil 2) — startet deaktiviert,
    // gleiches No-Op-Prinzip wie pro Kanal (`apply_comp_params`).
    let master_limiter = gst::ElementFactory::make("audiodynamic")
        .name("master-limiter")
        .build()
        .map_err(|e| format!("audiodynamic (master): {e}"))?;
    let master_makeup = gst::ElementFactory::make("volume")
        .name("master-makeup")
        .build()
        .map_err(|e| format!("volume/makeup (master): {e}"))?;
    apply_comp_params(
        &master_limiter,
        &master_makeup,
        &CompParams { enabled: false, threshold_db: 0.0, ratio: 1.0, makeup_db: 0.0 },
    );
    // Master-Meter (K4-Teil-1, §4.3a) — **nach** dem Limiter: zeigt den
    // tatsächlich gesendeten Pegel, nicht den unlimitierten Mix (echtes
    // Post-Fader-Metering, der Master-Ausgang hat keinen separaten
    // Fader-Mechanismus, den `level` umgehen müsste).
    let level_master = gst::ElementFactory::make("level")
        .name("level-master")
        .property("interval", LEVEL_INTERVAL_NS)
        .build()
        .map_err(|e| format!("level (master): {e}"))?;
    pipeline
        .add(&mixer)
        .and_then(|()| pipeline.add(&master_limiter))
        .and_then(|()| pipeline.add(&master_makeup))
        .and_then(|()| pipeline.add(&level_master))
        .map_err(|e| format!("add audiomixer/limiter/level: {e}"))?;
    gst::Element::link_many([&mixer, &master_limiter, &master_makeup, &level_master])
        .map_err(|e| format!("link mixer to level (master): {e}"))?;

    let mxl_output = MxlAudioOutput::new(
        &pipeline,
        &level_master,
        context.clone(),
        &config.flow_id,
        &config.label,
        SAMPLE_RATE,
        CHANNELS,
    )
    .map_err(|e| format!("MxlAudioOutput: {e}"))?;
    mxl_output.set_active(true);
    let flowed = mxl_output.flowed_handle();

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActivePipeline {
        pipeline,
        mixer,
        channels: HashMap::new(),
        master_limiter,
        master_makeup,
        _mxl_output: mxl_output,
        flowed,
    })
}

/// Läuft auf einem eigenen Thread (analog `omp-switcher`/
/// `omp-video-mixer-me`s `pipeline::run`) — anders als dort **ein**
/// dauerhafter `build()`-Aufruf, kein Rebuild-auf-Kommando-Pfad (s.
/// Moduldoku): Kanäle werden dynamisch an die laufende Pipeline an-/
/// abgebaut.
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
        flowed: active.flowed.clone(),
    }));

    let bus = active.pipeline.bus().expect("pipeline always has a bus");

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        // Kürzeres Timeout als bei `omp-player`/`omp-source` (dort
        // 500 ms/1 s): das `level`-Meldeintervall ist 50 ms
        // (`LEVEL_INTERVAL_NS`), ein Kommando-Wartezyklus drainiert die
        // Bus-Queue gleich mit (unten) statt einen zweiten Loop/Thread
        // dafür zu brauchen.
        match commands_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Command::AddChannel { id, source }) => {
                if let Err(e) = add_channel_branch(&mut active, &context, &id, &source) {
                    let _ = tx.send(Event::Error(format!("addChannel({id}) failed: {e}")));
                }
            }
            Ok(Command::RemoveChannel(id)) => {
                remove_channel_branch(&mut active, &id);
            }
            Ok(Command::SetChannelSource { id, source }) => {
                // Nur ersetzen, wenn der Kanal (noch) existiert — ein
                // `removeChannel` kurz zuvor darf hier keinen neuen Zweig
                // ohne zugehörigen Kanal-Zustand in `main.rs` entstehen
                // lassen.
                if active.channels.contains_key(&id) {
                    remove_channel_branch(&mut active, &id);
                    if let Err(e) = add_channel_branch(&mut active, &context, &id, &source) {
                        let _ = tx.send(Event::Error(format!("setSource({id}) failed: {e}")));
                    }
                }
            }
            Ok(Command::SetGain { id, db }) => {
                if let Some(branch) = active.channels.get(&id) {
                    branch.mixer_pad.set_property("volume", db_to_linear(db));
                }
            }
            Ok(Command::SetMute { id, muted }) => {
                if let Some(branch) = active.channels.get(&id) {
                    branch.mixer_pad.set_property("mute", muted);
                }
            }
            Ok(Command::SetEq { id, low, mid, high }) => {
                if let Some(branch) = active.channels.get(&id) {
                    apply_eq_gain(&branch.eq, low, mid, high);
                }
            }
            Ok(Command::SetEqBand { id, band, freq, width }) => {
                if let Some(branch) = active.channels.get(&id) {
                    apply_eq_band(&branch.eq, band, freq, width);
                }
            }
            Ok(Command::SetComp { id, params }) => {
                if let Some(branch) = active.channels.get(&id) {
                    apply_comp_params(&branch.comp, &branch.comp_makeup, &params);
                }
            }
            Ok(Command::SetMasterLimiter { params }) => {
                apply_comp_params(&active.master_limiter, &active.master_makeup, &params);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }

        // Nicht-blockierend alle wartenden `level`-Bus-Messages
        // abholen (K4-Teil-1) — `pop_filtered` statt `timed_pop_filtered`,
        // damit dieser Schritt den nächsten Kommando-Wartezyklus nicht
        // zusätzlich verzögert.
        while let Some(msg) = bus.pop_filtered(&[gst::MessageType::Element]) {
            let gst::MessageView::Element(el) = msg.view() else {
                continue;
            };
            let Some(structure) = el.structure() else {
                continue;
            };
            if structure.name() != "level" {
                continue;
            }
            let Some((rms, peak)) = parse_level_message(structure) else {
                continue;
            };
            let name = msg.src().map(|o| o.name().to_string()).unwrap_or_default();
            let channel_id = if name == "level-master" {
                None
            } else {
                match name.strip_prefix("level-") {
                    Some(id) => Some(id.to_string()),
                    None => continue,
                }
            };
            let _ = tx.send(Event::Level { channel_id, rms, peak });
        }
    }

    drop(active);
}
