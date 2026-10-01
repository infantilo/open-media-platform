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
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// Solo/PFL-Monitor-Bus (Nutzerwunsch 2026-07-29, END-GOAL-FEATURES
    /// Kapitel-10-Entscheidung K4 "Solo/PFL wird gebaut") — zweiter,
    /// eigenständiger MXL-Audio-Sender neben `flow_id`, s.
    /// `build()`/`pfl_mixer`.
    pub monitor_flow_id: String,
    /// Feste Aux-Slots (Kapitel 26): je ein eigener `audiomixer` + MXL-Ausgang,
    /// der inaktiv (Ventil zu) praktisch nichts kostet. `(slot_id, flow_id,
    /// label)`; IS-04-Sender entsteht erst bei Aktivierung (`main.rs`).
    pub aux_slots: Vec<(String, String, String)>,
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
    /// DSP-Zustand je Kanal (≈10 Hz): Gain-Reduction von Kompressor/Gate,
    /// Anteil von AutoMix/Ducking am Pegel und Detektor-Pegel. `None` =
    /// Master (nur Limiter-Reduktion).
    Dsp {
        channel_id: Option<String>,
        comp_gr_db: f64,
        gate_gr_db: f64,
        auto_db: f64,
        duck_db: f64,
        in_db: f64,
        on_air: bool,
    },
}

// `db_to_meter_level`/`parse_level_message` leben seit 2026-08-06 in
// `omp_mediaio::levels` (s. dortige Moduldoku "nach hier verschoben") —
// `omp-viewer`s neue dynamische Audio-Eingangs-Pegelanzeigen sind der
// zweite Verbraucher, der diese Verschiebung motiviert hat. Re-Export
// hier vermieden (Aufrufer unten nutzen `levels::`-Präfix direkt), reine
// Verschiebung ohne Verhaltensänderung.
use omp_mediaio::levels::parse_level_message;

use crate::dsp;

/// Woher ein Kanal sein Audio bezieht — `Internal` (Testton) oder
/// `External` (echter MXL-Audio-Flow, per `flow_id` adressiert; die
/// Sender→Flow-Auflösung passiert vorher in `main.rs`, hier ist nur noch
/// die fertige `flow_id` bekannt).
#[derive(Clone)]
pub enum ChannelSource {
    Internal { freq: f64 },
    External { flow_id: String },
}

#[allow(clippy::large_enum_variant)]
enum Command {
    AddChannel { id: String, source: ChannelSource },
    RemoveChannel(String),
    SetChannelSource { id: String, source: ChannelSource },
    SetGain { id: String, db: f64 },
    SetMute { id: String, muted: bool },
    SetProc { id: String, params: dsp::ProcParams },
    SetMasterLimiter { params: dsp::CompParams },
    SetPfl { id: String, enabled: bool },
    SetAuxActive { aux: String, active: bool },
    SetAuxMaster { aux: String, db: f64, muted: bool },
    SetSend { channel: String, aux: String, enabled: bool, level_db: f64, post: bool },
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    flowed: Arc<AtomicBool>,
    shared: SharedMap,
}

impl PipelineHandle {
    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2): ob
    /// der Misch-Ausgang bereits mindestens einen echten Buffer
    /// geschrieben hat — unabhängig davon, ob/wie viele Kanäle aktuell
    /// angeschlossen sind (der Mixer produziert auch ohne Kanäle Stille).
    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }

    /// Aux-Bus (Slot) ein-/ausschalten: öffnet/schließt den MXL-Ausgang.
    pub fn set_aux_active(&self, aux: String, active: bool) {
        let _ = self.commands.send(Command::SetAuxActive { aux, active });
    }

    pub fn set_aux_master(&self, aux: String, db: f64, muted: bool) {
        let _ = self.commands.send(Command::SetAuxMaster { aux, db, muted });
    }

    /// Send eines Kanals auf einen Aux-Bus (Pre/Post-Fader, Pegel, an/aus).
    pub fn set_send(&self, channel: String, aux: String, enabled: bool, level_db: f64, post: bool) {
        let _ = self.commands.send(Command::SetSend { channel, aux, enabled, level_db, post });
    }

    /// Kanal-DSP-Zustände für die Automations-Engine.
    pub fn shared_map(&self) -> SharedMap {
        self.shared.clone()
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

    /// Komplette Bearbeitungsparameter eines Kanals (EQ/Gate/Comp/Delay/Pan,
    /// `dsp::ProcParams`) — wirkt über Pad-Probe direkt im Audio-Thread.
    pub fn set_proc(&self, id: String, params: dsp::ProcParams) {
        let _ = self.commands.send(Command::SetProc { id, params });
    }

    pub fn set_master_limiter(&self, params: dsp::CompParams) {
        let _ = self.commands.send(Command::SetMasterLimiter { params });
    }

    /// Solo/PFL (Nutzerwunsch 2026-07-29): schaltet den Prefader-Abhörweg
    /// dieses Kanals auf dem Monitor-Bus ein/aus — s. `Command::SetPfl`-
    /// Behandlung in `run()` für die "fällt auf Programm-Summe zurück,
    /// solange kein Kanal soloed ist"-Logik.
    pub fn set_pfl(&self, id: String, enabled: bool) {
        let _ = self.commands.send(Command::SetPfl { id, enabled });
    }
}


/// Bearbeitet einen F32LE-Buffer in place (nach `audioconvert`+Capsfilter
/// garantiert interleaved Stereo). Byte-weise Umwandlung statt
/// Zeiger-Umdeuten — kein `unsafe`, der Kopieraufwand (10 ms Audio) ist
/// vernachlässigbar.
fn with_f32_samples(buf: &mut gst::BufferRef, scratch: &mut Vec<f32>, f: impl FnOnce(&mut [f32])) {
    let Ok(mut map) = buf.map_writable() else {
        return;
    };
    let bytes = map.as_mut_slice();
    scratch.clear();
    scratch.extend(bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])));
    f(scratch);
    for (c, v) in bytes.chunks_exact_mut(4).zip(scratch.iter()) {
        c.copy_from_slice(&v.to_le_bytes());
    }
}

/// Master-Limiter-Parameter + Gain-Reduction-Anzeige (Audio-Thread liest/schreibt).
/// Geteilte Kanalzustände (Pipeline-Thread schreibt/legt an, Engine liest).
pub type SharedMap = Arc<Mutex<HashMap<String, Arc<dsp::ChannelShared>>>>;

struct MasterShared {
    params: std::sync::Mutex<dsp::CompParams>,
    version: AtomicU64,
    gr_db: dsp::AtomicF32,
}

/// Ein Aux-Send-Zweig: `tee → queue(+Gain-Probe) → Aux-Mixer`.
struct SendBranch {
    queue: gst::Element,
    tee_pad: gst::Pad,
    mixer_pad: gst::Pad,
}

/// Laufzeitteile eines Aux-Slots.
struct AuxRt {
    mixer: gst::Element,
    master: gst::Element,
    output: MxlAudioOutput,
}

struct ChannelBranch {
    /// Alle Elemente dieses Zweigs, in Verkettungsreihenfolge (Quelle …
    /// `eq`) — für sauberes chirurgisches Entfernen (`remove_channel_
    /// branch`) statt der früheren Peer-Pad-Suche, die nur für den
    /// Testton-Fall funktionierte. Bei externer Quelle stammen die
    /// vorderen Elemente aus `MxlAudioInput::elements`.
    elements: Vec<gst::Element>,
    mixer_pad: gst::Pad,
    /// Solo/PFL-Prefader-Abgriff (Nutzerwunsch 2026-07-29): `volume`-
    /// Element zwischen dem Kanal-`tee` (nach `level`, vor `mixer_pad` —
    /// derselbe Punkt, an dem heute schon post-EQ/Kompressor, aber noch
    /// vor Gain/Mute gemessen wird, s. `level`-Kommentar in
    /// `add_channel_branch`) und `pfl_mixer.sink_%u`. `0.0` = nicht
    /// soloed (Default), `1.0` = soloed — umgeschaltet über
    /// `Command::SetPfl`, das auch `pfl_enabled` unten pflegt, um die
    /// Rückfall-auf-Programm-Logik am Master-Zweig neu zu berechnen.
    pfl_gain: gst::Element,
    pfl_pad: gst::Pad,
    pfl_enabled: bool,
    /// Abgriffspunkt (nach Bearbeitung, vor Fader): speist Haupt-, PFL- und
    /// alle Aux-Zweige. Aux-Zweige werden lazy beim ersten Aktivieren
    /// eines Sends angehängt.
    tee: gst::Element,
    sends: HashMap<String, SendBranch>,
    /// Hält den Lese-Thread einer externen Quelle am Leben (`Drop`
    /// stoppt ihn) — `None` beim internen Testton.
    _external_input: Option<MxlAudioInput>,
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    mixer: gst::Element,
    channels: HashMap<String, ChannelBranch>,
    /// Master-Limiter (Kompressor-Kern aus `dsp.rs`, Pad-Probe zwischen
    /// `mixer` und `level_master`) — Parameter hinter Mutex+Versionszähler.
    master_params: Arc<MasterShared>,
    /// Kanal-DSP-Zustände über Quellwechsel hinweg (Kapitel 26) — auch für
    /// die Automations-Engine sichtbar (`engine.rs`).
    shared: SharedMap,
    aux: HashMap<String, AuxRt>,
    _mxl_output: MxlAudioOutput,
    /// Solo/PFL-Monitor-Bus (Nutzerwunsch 2026-07-29) — separater
    /// `audiomixer`, den jeder Kanalzweig über seinen `pfl_gain` sowie
    /// der Master-Zweig über `master_pfl_gain` bespeist (s. `build()`).
    pfl_mixer: gst::Element,
    /// Programm-Summe-Rückfall auf dem Monitor-Bus: `1.0` solange KEIN
    /// Kanal soloed ist (Monitor spiegelt dann das Programm), `0.0`
    /// sobald mindestens ein Kanal `pfl_enabled` ist (Monitor hört dann
    /// exklusiv die solo(t)en Kanäle) — s. `recompute_master_pfl_gain`.
    master_pfl_gain: gst::Element,
    _pfl_output: MxlAudioOutput,
    flowed: Arc<AtomicBool>,
}

/// Nach jeder `SetPfl`/`RemoveChannel`-Änderung neu berechnet (s.
/// `run()`): der Master-Zweig ist auf dem Monitor-Bus nur hörbar, wenn
/// KEIN Kanal aktuell soloed ist — genau die "Monitor-Summe (Default) +
/// Solo schaltet auf den/die solo(t)en Kanal/Kanäle um"-Semantik eines
/// klassischen Konsolen-PFL-Wegs.
fn recompute_master_pfl_gain(active: &ActivePipeline) {
    let any_active = active.channels.values().any(|b| b.pfl_enabled);
    active
        .master_pfl_gain
        .set_property("volume", if any_active { 0.0f64 } else { 1.0f64 });
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
            // `new_unsynced()` statt `new()` (`docs/decisions.md`
            // Nachtrag 272): dieser chirurgische Hot-Swap in die bereits
            // laufende Pipeline verlinkt `tail` erst unten (über `convert`
            // bis zu `audiomixer`s Sink-Pad) weiter — mit dem einphasigen
            // `new()` zog dessen interne Kette schon VOR dieser
            // Verlinkung auf den Zustand der Eltern-Pipeline hoch, was am
            // WHEP-Monitor (strukturell identischer Fall) reproduzierbar
            // zu einem permanenten `not-linked` führte. Der bestehende
            // `sync_state_with_parent()`-Sammellauf weiter unten (nach
            // vollständiger Verlinkung bis zu den Mixer-Pads) deckt
            // `input.elements` bereits mit ab — kein separater
            // `activate()`-Aufruf nötig.
            let input = MxlAudioInput::new_unsynced(&active.pipeline, context.clone(), flow_id)
                .map_err(|e| format!("MxlAudioInput ({id}, flow {flow_id}): {e}"))?;
            (input.tail.clone(), input.elements.clone(), Some(input))
        }
    };

    let convert = gst::ElementFactory::make("audioconvert")
        .build()
        .map_err(|e| format!("audioconvert ({id}): {e}"))?;
    let resample = gst::ElementFactory::make("audioresample")
        .build()
        .map_err(|e| format!("audioresample ({id}): {e}"))?;
    // Eigenes DSP (Kapitel 26, `dsp.rs`): ab hier garantiert F32LE/48k/
    // Stereo-interleaved, damit die Probes direkt auf Samples rechnen.
    let caps = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("layout", "interleaved")
                .field("rate", SAMPLE_RATE as i32)
                .field("channels", CHANNELS as i32)
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter ({id}): {e}"))?;
    // Probe A (Bearbeitung): HPF → EQ → Detektor → Gate → Kompressor →
    // Delay → Pan. Hängt an einem `identity`, damit die Stufe ein eigenes
    // Element im Zweig ist (sauberes Entfernen mit dem Zweig).
    let proc_el = gst::ElementFactory::make("identity")
        .name(format!("proc-{id}"))
        .build()
        .map_err(|e| format!("identity/proc ({id}): {e}"))?;

    let shared = shared_for(active, id);
    {
        let shared = shared.clone();
        let stage = Mutex::new((dsp::ProcStage::new(), 0u64, Vec::<f32>::new()));
        let pad = proc_el.static_pad("src").ok_or("proc: no src pad")?;
        pad.add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            if let Some(gst::PadProbeData::Buffer(buffer)) = info.data.as_mut() {
                let mut guard = stage.lock().expect("lock poisoned");
                let (stage, seen, scratch) = &mut *guard;
                shared.refresh(stage, seen);
                with_f32_samples(buffer.make_mut(), scratch, |samples| {
                    stage.process(samples, &shared.meters)
                });
            }
            gst::PadProbeReturn::Ok
        });
    }

    // Probe B (Fader-Stufe, vor dem Mixer-Pad): Fader · Mute · AutoMix ·
    // Ducking als ein geglätteter Gain. Ersetzt Pad-Volume/-Mute des
    // `audiomixer` — API (`setGain`/`setMute`) unverändert.
    let fader_el = gst::ElementFactory::make("identity")
        .name(format!("fader-{id}"))
        .build()
        .map_err(|e| format!("identity/fader ({id}): {e}"))?;
    {
        let shared = shared.clone();
        let stage = Mutex::new((dsp::FaderStage::new(), Vec::<f32>::new()));
        let pad = fader_el.static_pad("src").ok_or("fader: no src pad")?;
        pad.add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            if let Some(gst::PadProbeData::Buffer(buffer)) = info.data.as_mut() {
                let mut guard = stage.lock().expect("lock poisoned");
                let (stage, scratch) = &mut *guard;
                let target = shared.main_gain();
                with_f32_samples(buffer.make_mut(), scratch, |samples| stage.process(samples, target));
            }
            gst::PadProbeReturn::Ok
        });
    }

    // Metering (K4-Teil-1, `docs/END-GOAL-FEATURES.md` §4.3a): nach der
    // Bearbeitung, vor dem Fader (zeigt den klangformenden Signalpfad).
    let level = gst::ElementFactory::make("level")
        .name(format!("level-{id}"))
        .property("interval", LEVEL_INTERVAL_NS)
        .build()
        .map_err(|e| format!("level ({id}): {e}"))?;

    active
        .pipeline
        .add(&convert)
        .and_then(|()| active.pipeline.add(&resample))
        .and_then(|()| active.pipeline.add(&caps))
        .and_then(|()| active.pipeline.add(&proc_el))
        .and_then(|()| active.pipeline.add(&fader_el))
        .and_then(|()| active.pipeline.add(&level))
        .map_err(|e| format!("add channel elements ({id}): {e}"))?;
    gst::Element::link_many([&tail, &convert, &resample, &caps, &proc_el, &level])
        .map_err(|e| format!("link channel chain ({id}): {e}"))?;
    elements.push(convert);
    elements.push(resample.clone());
    elements.push(caps.clone());

    // Solo/PFL-Abzweig (Nutzerwunsch 2026-07-29): ein `tee` direkt hinter
    // `level` speist zusätzlich zum unveränderten Haupt-Pfad
    // (`mixer_pad`, mit Gain/Mute) einen zweiten, eigenen `queue+volume`-
    // Zweig zum Monitor-Bus (`pfl_mixer`) — exakt der Punkt zwischen
    // "klangformend" (EQ/Kompressor, bereits durchlaufen) und "Fader"
    // (Gain/Mute, noch nicht erreicht), also echtes Prefader-Signal.
    let pfl_tee = gst::ElementFactory::make("tee")
        .name(format!("pfl-tee-{id}"))
        .build()
        .map_err(|e| format!("tee (pfl, {id}): {e}"))?;
    let main_queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue (main, {id}): {e}"))?;
    let pfl_queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue (pfl, {id}): {e}"))?;
    let pfl_gain = gst::ElementFactory::make("volume")
        .name(format!("pfl-gain-{id}"))
        .property("volume", 0.0f64)
        .build()
        .map_err(|e| format!("volume (pfl, {id}): {e}"))?;

    active
        .pipeline
        .add(&pfl_tee)
        .and_then(|()| active.pipeline.add(&main_queue))
        .and_then(|()| active.pipeline.add(&pfl_queue))
        .and_then(|()| active.pipeline.add(&pfl_gain))
        .map_err(|e| format!("add pfl elements ({id}): {e}"))?;
    gst::Element::link_many([&level, &pfl_tee]).map_err(|e| format!("link level to pfl tee ({id}): {e}"))?;
    gst::Element::link_many([&pfl_tee, &main_queue, &fader_el])
        .map_err(|e| format!("link pfl tee to main queue ({id}): {e}"))?;
    gst::Element::link_many([&pfl_tee, &pfl_queue, &pfl_gain])
        .map_err(|e| format!("link pfl tee to pfl gain ({id}): {e}"))?;

    let mixer_pad = active
        .mixer
        .request_pad_simple("sink_%u")
        .ok_or_else(|| format!("audiomixer: request sink pad failed ({id})"))?;
    fader_el
        .static_pad("src")
        .ok_or("fader: no src pad")?
        .link(&mixer_pad)
        .map_err(|e| format!("link main queue to mixer ({id}): {e}"))?;

    let pfl_pad = active
        .pfl_mixer
        .request_pad_simple("sink_%u")
        .ok_or_else(|| format!("pfl_mixer: request sink pad failed ({id})"))?;
    pfl_gain
        .static_pad("src")
        .ok_or("pfl_gain: no src pad")?
        .link(&pfl_pad)
        .map_err(|e| format!("link pfl gain to pfl mixer ({id}): {e}"))?;

    // Neue Elemente in einer bereits laufenden (PLAYING) Pipeline müssen
    // ihren Zustand explizit an den Elternzustand angleichen — sonst
    // bleiben sie in NULL/READY hängen und liefern nie Daten.
    //
    // Reihenfolge: von der SENKE zur QUELLE (Live-Befund 2026-10-01). Wird die
    // Live-Quelle zuerst auf PLAYING gebracht, schiebt sie schon Daten in noch
    // nicht laufende Elemente; ein `basesrc` pausiert dann bei FLUSHING still
    // und dauerhaft — der Kanal liefert nie einen Buffer (zufällig 1 von 8
    // Kanälen, je länger die Kette, desto wahrscheinlicher).
    let downstream_first: Vec<&gst::Element> = [&pfl_gain, &pfl_queue, &fader_el, &main_queue, &pfl_tee, &level, &proc_el]
        .into_iter()
        .chain(elements.iter().rev())
        .collect();
    for el in downstream_first {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync_state_with_parent ({id}): {e}"))?;
    }

    elements.push(proc_el);
    elements.push(fader_el);
    elements.push(level.clone());
    elements.push(pfl_tee.clone());
    elements.push(main_queue);
    elements.push(pfl_queue);
    elements.push(pfl_gain.clone());
    active.channels.insert(
        id.to_string(),
        ChannelBranch {
            elements,
            mixer_pad,
            pfl_gain,
            pfl_pad,
            pfl_enabled: false,
            tee: pfl_tee,
            sends: HashMap::new(),
            _external_input: external_input,
        },
    );
    // Nach einem Quellwechsel (Zweig neu gebaut) bereits eingeschaltete
    // Sends wieder anhängen.
    for aux_id in shared.enabled_sends() {
        if let Err(e) = ensure_send_branch(active, id, &aux_id) {
            return Err(format!("send {aux_id}: {e}"));
        }
    }
    Ok(())
}

/// Hängt (falls nötig) den Aux-Send-Zweig `Kanal → Aux-Bus` an die laufende
/// Pipeline: `tee → queue → aux.mixer`. Der Gain (Level, Pre/Post, Fader-
/// Folge) wird in einer Pad-Probe an der Queue angewandt, geglättet über
/// `dsp::FaderStage`. Existiert der Kanalzweig oder der Aux-Slot (noch)
/// nicht, passiert nichts — `add_channel_branch` holt es später nach.
fn ensure_send_branch(active: &mut ActivePipeline, ch_id: &str, aux_id: &str) -> Result<(), String> {
    let Some(aux) = active.aux.get(aux_id) else {
        return Ok(());
    };
    let aux_mixer = aux.mixer.clone();
    let shared = shared_for(active, ch_id);
    let Some(branch) = active.channels.get_mut(ch_id) else {
        return Ok(());
    };
    if branch.sends.contains_key(aux_id) {
        return Ok(());
    }
    let queue = gst::ElementFactory::make("queue")
        .name(format!("send-{ch_id}-{aux_id}"))
        .build()
        .map_err(|e| format!("queue (send {ch_id}->{aux_id}): {e}"))?;
    active.pipeline.add(&queue).map_err(|e| format!("add send queue: {e}"))?;

    let send = shared.send(aux_id);
    {
        let stage = Mutex::new((dsp::FaderStage::new(), Vec::<f32>::new()));
        let shared = shared.clone();
        let pad = queue.static_pad("src").ok_or("send queue: no src pad")?;
        pad.add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            if let Some(gst::PadProbeData::Buffer(buffer)) = info.data.as_mut() {
                let mut guard = stage.lock().expect("lock poisoned");
                let (stage, scratch) = &mut *guard;
                let target = send.target_gain(&shared);
                with_f32_samples(buffer.make_mut(), scratch, |samples| stage.process(samples, target));
            }
            gst::PadProbeReturn::Ok
        });
    }

    // Reihenfolge und Blockade (Live-Befund 2026-10-01: ohne sie standen
    // zufällig 1–3 von 8 Kanälen dauerhaft, sobald mehrere Sends gleichzeitig
    // an laufende `tee`s gehängt wurden — gleiche Ursache wie das Memory
    // "GStreamer tee request-pad race"):
    //   1. Queue → Aux-Mixer verlinken und Queue auf PLAYING bringen (noch ohne Daten),
    //   2. den Datenstrom am `tee`-Eingang per BLOCK-Probe anhalten,
    //   3. erst dann Src-Pad anfordern und verlinken,
    //   4. Probe entfernen (Strom läuft weiter).
    let mut mixer_pad_slot: Option<gst::Pad> = None;
    let attempt = (|| -> Result<gst::Pad, String> {
        let mixer_pad = aux_mixer.request_pad_simple("sink_%u").ok_or("aux mixer: request sink pad failed")?;
        mixer_pad_slot = Some(mixer_pad.clone());
        queue
            .static_pad("src")
            .ok_or("send queue: no src pad")?
            .link(&mixer_pad)
            .map_err(|e| format!("link send queue to aux mixer: {e}"))?;
        queue.sync_state_with_parent().map_err(|e| format!("sync send queue: {e}"))?;

        let tee_sink = branch.tee.static_pad("sink").ok_or("tee: no sink pad")?;
        let (blocked_tx, blocked_rx) = std::sync::mpsc::channel::<()>();
        let probe = tee_sink.add_probe(gst::PadProbeType::BLOCK_DOWNSTREAM, move |_, _| {
            let _ = blocked_tx.send(());
            gst::PadProbeReturn::Ok // Pad bleibt blockiert, bis die Probe entfernt wird
        });
        // Kommt kein Buffer (Quelle liefert gerade nichts), nach kurzer Frist ohne
        // Blockade fortfahren — der Kanal läuft dann ohnehin nicht.
        let _ = blocked_rx.recv_timeout(Duration::from_millis(500));
        let link_result = (|| -> Result<gst::Pad, String> {
            let tee_pad = branch.tee.request_pad_simple("src_%u").ok_or("tee: request src pad failed")?;
            tee_pad
                .link(&queue.static_pad("sink").ok_or("send queue: no sink pad")?)
                .map_err(|e| format!("link tee to send queue: {e}"))?;
            Ok(tee_pad)
        })();
        if let Some(id) = probe {
            tee_sink.remove_probe(id);
        }
        link_result
    })();
    let tee_pad = match attempt {
        Ok(p) => p,
        Err(e) => {
            // Aufräumen: sonst bleibt eine halb verlinkte Queue in der Pipeline, und
            // jeder weitere Versuch scheitert zusätzlich an doppeltem Elementnamen.
            if let Some(p) = mixer_pad_slot.take() {
                aux_mixer.release_request_pad(&p);
            }
            let _ = queue.set_state(gst::State::Null);
            let _ = active.pipeline.remove(&queue);
            return Err(e);
        }
    };
    let mixer_pad = mixer_pad_slot.take().expect("gesetzt im Erfolgsfall");
    branch.sends.insert(aux_id.to_string(), SendBranch { queue, tee_pad, mixer_pad });
    Ok(())
}

/// Entfernt einen Send-Zweig sauber (Pads freigeben, Queue entfernen).
fn drop_send_branch(pipeline: &gst::Pipeline, tee: &gst::Element, aux_mixer: Option<&gst::Element>, sb: SendBranch) {
    if let Some(mixer) = aux_mixer {
        mixer.release_request_pad(&sb.mixer_pad);
    }
    tee.release_request_pad(&sb.tee_pad);
    let _ = sb.queue.set_state(gst::State::Null);
    let _ = pipeline.remove(&sb.queue);
}

fn shared_for(active: &ActivePipeline, id: &str) -> Arc<dsp::ChannelShared> {
    active
        .shared
        .lock()
        .expect("lock poisoned")
        .entry(id.to_string())
        .or_insert_with(|| Arc::new(dsp::ChannelShared::new()))
        .clone()
}

fn remove_channel_branch(active: &mut ActivePipeline, id: &str) {
    let Some(branch) = active.channels.remove(id) else {
        return;
    };
    let was_pfl_enabled = branch.pfl_enabled;
    let mut branch = branch;
    for (aux_id, sb) in std::mem::take(&mut branch.sends) {
        let mixer = active.aux.get(&aux_id).map(|a| a.mixer.clone());
        drop_send_branch(&active.pipeline, &branch.tee, mixer.as_ref(), sb);
    }
    // Reihenfolge: erst beide Mixer-Pads freigeben (stoppt den Datenfluss
    // in Haupt- UND Monitor-Bus sauber), dann jedes Zweig-Element auf
    // NULL setzen und aus der Pipeline entfernen — Gegenrichtung des
    // Aufbaus in `add_channel_branch`. `_external_input` wird beim Drop
    // von `branch` am Ende dieser Funktion automatisch verworfen, was den
    // Lese-Thread stoppt (aber nicht dessen Pipeline-Elemente entfernt —
    // die stehen bereits in `elements` und werden hier explizit
    // aufgeräumt).
    active.mixer.release_request_pad(&branch.mixer_pad);
    active.pfl_mixer.release_request_pad(&branch.pfl_pad);
    for el in &branch.elements {
        let _ = el.set_state(gst::State::Null);
        let _ = active.pipeline.remove(el);
    }
    // Ein entfernter, zuvor soloed Kanal kann der letzte gewesen sein —
    // Monitor muss dann auf die Programm-Summe zurückfallen.
    if was_pfl_enabled {
        recompute_master_pfl_gain(active);
    }
}

/// Baut einen Aux-Bus (Slot) in die bereits laufende Pipeline:
/// `audiomixer → volume(Master) → level → MxlAudioOutput`, dazu eine
/// dauerhafte Stille-Quelle (ohne Eingang liefert ein Mixer nie Daten).
///
/// Bewusst erst bei der ersten Aktivierung statt beim Start (Live-Befund
/// 2026-10-01): schon beim Start vorhandene, ungenutzte Aux-Mixer machten die
/// Pipeline "live", bevor der erste Kanal existierte, und der Programm-Mixer
/// lieferte danach nur noch Stille. Wie die Kanalzweige wird der Bus
/// erst verlinkt und dann (von unten nach oben) auf den Pipelinezustand gebracht.
/// Elemente von `MxlAudioOutput` bleiben für die Pipelinelebensdauer
/// bestehen (kein Entfernen möglich) — ein deaktivierter Slot wird bei
/// erneuter Aktivierung wiederverwendet.
/// Live-Stille-Quelle mit FESTEN Caps (F32LE/48 kHz/Stereo): ohne sie gibt der
/// `audiotestsrc`-Standard (Mono, 44,1 kHz) dem Mixer das Ausgangsformat vor,
/// und später angehängte Stereo-Kanäle lassen sich zufällig nicht mehr
/// verlinken ("Pads do not have common format", Live-Befund 2026-10-01).
/// Rückgabe: (Quelle, Capsfilter) — der Capsfilter ist das Element zum Verlinken.
fn silence_source(name: &str) -> Result<(gst::Element, gst::Element), String> {
    let src = gst::ElementFactory::make("audiotestsrc")
        .name(format!("{name}-src"))
        .property("is-live", true)
        .property("samplesperbuffer", 480i32)
        .build()
        .map_err(|e| format!("audiotestsrc ({name}): {e}"))?;
    src.set_property_from_str("wave", "silence");
    let caps = gst::ElementFactory::make("capsfilter")
        .name(format!("{name}-caps"))
        .property(
            "caps",
            gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("layout", "interleaved")
                .field("rate", SAMPLE_RATE as i32)
                .field("channels", CHANNELS as i32)
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter ({name}): {e}"))?;
    Ok((src, caps))
}

fn build_aux(
    active: &mut ActivePipeline,
    context: &Arc<MxlContext>,
    slot_id: &str,
    flow_id: &str,
    label: &str,
) -> Result<(), String> {
    if active.aux.contains_key(slot_id) {
        return Ok(());
    }
    let pipeline = active.pipeline.clone();
    let mixer = gst::ElementFactory::make("audiomixer")
        .name(format!("aux-mixer-{slot_id}"))
        .build()
        .map_err(|e| format!("audiomixer (aux {slot_id}): {e}"))?;
    let master = gst::ElementFactory::make("volume")
        .name(format!("aux-master-{slot_id}"))
        .build()
        .map_err(|e| format!("volume (aux {slot_id}): {e}"))?;
    let level = gst::ElementFactory::make("level")
        .name(format!("level-aux-{slot_id}"))
        .property("interval", LEVEL_INTERVAL_NS)
        .build()
        .map_err(|e| format!("level (aux {slot_id}): {e}"))?;
    let (silence_src, silence) = silence_source(&format!("aux-silence-{slot_id}"))?;
    pipeline
        .add(&mixer)
        .and_then(|()| pipeline.add(&master))
        .and_then(|()| pipeline.add(&level))
        .and_then(|()| pipeline.add(&silence_src))
        .and_then(|()| pipeline.add(&silence))
        .map_err(|e| format!("add aux elements ({slot_id}): {e}"))?;
    gst::Element::link_many([&silence_src, &silence]).map_err(|e| format!("link aux silence caps ({slot_id}): {e}"))?;
    gst::Element::link_many([&mixer, &master, &level]).map_err(|e| format!("link aux ({slot_id}): {e}"))?;
    let silence_pad = mixer.request_pad_simple("sink_%u").ok_or("aux mixer: request silence pad failed")?;
    silence
        .static_pad("src")
        .ok_or("aux silence: no src pad")?
        .link(&silence_pad)
        .map_err(|e| format!("link aux silence ({slot_id}): {e}"))?;
    let output = MxlAudioOutput::new(&pipeline, &level, context.clone(), flow_id, label, SAMPLE_RATE, CHANNELS)
        .map_err(|e| format!("MxlAudioOutput (aux {slot_id}): {e}"))?;
    // Ventil bleibt beim Bau OFFEN (Live-Befund 2026-10-01): der Aufrufer
    // (`SetAuxActive`) stellt es unmittelbar danach ohnehin ein. Ein hier
    // geschlossenes Ventil ließ die Stille-Quelle zufällig mit "not-linked"
    // sterben, wenn ihr erster Buffer in das Fenster bis zum Öffnen fiel.
    output.set_active(true);

    // Zustand angleichen: ALLES außer der Live-Quelle zuerst (die internen
    // Elemente von `MxlAudioOutput::new` UND meine eigenen noch auf NULL
    // stehenden Elemente liegen hier in beliebiger Iterationsreihenfolge), die
    // Quelle ganz zuletzt. Live-Befund 2026-10-01: wurde die Stille-Quelle vor
    // dem Mixer auf PLAYING gesetzt, endete sie mit "not-linked" und riss die
    // Pipeline mit (jeder zweite bis dritte Neustart mit Aux).
    for el in pipeline.iterate_elements().into_iter().flatten() {
        if el.current_state() == gst::State::Null && el != silence_src && el != silence {
            el.sync_state_with_parent().map_err(|e| format!("sync aux element: {e}"))?;
        }
    }
    silence.sync_state_with_parent().map_err(|e| format!("sync aux silence caps ({slot_id}): {e}"))?;
    silence_src.sync_state_with_parent().map_err(|e| format!("sync aux silence ({slot_id}): {e}"))?;
    active.aux.insert(slot_id.to_string(), AuxRt { mixer, master, output });
    Ok(())
}

fn build(context: &Arc<MxlContext>, config: &Config, shared: &SharedMap) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let mixer = gst::ElementFactory::make("audiomixer")
        .name("mixer")
        .build()
        .map_err(|e| format!("audiomixer: {e}"))?;
    // Master-Limiter (Kompressor-Kern aus `dsp.rs`, Pad-Probe) — startet
    // deaktiviert (No-Op). Capsfilter davor: Probe rechnet auf F32LE-Stereo.
    let master_caps = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("layout", "interleaved")
                .field("rate", SAMPLE_RATE as i32)
                .field("channels", CHANNELS as i32)
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter (master): {e}"))?;
    let master_el = gst::ElementFactory::make("identity")
        .name("master-limiter")
        .build()
        .map_err(|e| format!("identity (master): {e}"))?;
    let master_params = Arc::new(MasterShared {
        params: std::sync::Mutex::new(dsp::CompParams::default()),
        version: AtomicU64::new(1),
        gr_db: dsp::AtomicF32::new(0.0),
    });
    {
        let shared = master_params.clone();
        let stage = Mutex::new((dsp::MasterStage::new(), 0u64, Vec::<f32>::new()));
        let pad = master_el.static_pad("src").ok_or("master: no src pad")?;
        pad.add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            if let Some(gst::PadProbeData::Buffer(buffer)) = info.data.as_mut() {
                let mut guard = stage.lock().expect("lock poisoned");
                let (stage, seen, scratch) = &mut *guard;
                let v = shared.version.load(Ordering::Acquire);
                if v != *seen {
                    stage.set(*shared.params.lock().expect("lock poisoned"));
                    *seen = v;
                }
                with_f32_samples(buffer.make_mut(), scratch, |samples| stage.process(samples, &shared.gr_db));
            }
            gst::PadProbeReturn::Ok
        });
    }
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
        .and_then(|()| pipeline.add(&master_caps))
        .and_then(|()| pipeline.add(&master_el))
        .and_then(|()| pipeline.add(&level_master))
        .map_err(|e| format!("add audiomixer/limiter/level: {e}"))?;
    gst::Element::link_many([&mixer, &master_caps, &master_el, &level_master])
        .map_err(|e| format!("link mixer to level (master): {e}"))?;

    // Dauerhafte Live-Stille-Quelle am Programm-Mixer (Fund 2026-10-01, Stress-
    // test: ohne sie kam es bei ~50 % der Starts zu einer dauerhaft stehenden
    // Pipeline). Ohne Live-Quelle ist die Pipeline beim Start nicht "live";
    // der `async` MXL-Appsink am Ausgang wartet dann auf einen Preroll-Buffer,
    // den der pad-lose Mixer nur zufällig rechtzeitig liefert. Mit einer
    // Live-Quelle meldet der Zustandswechsel NO_PREROLL und die Pipeline läuft
    // sofort deterministisch in PLAYING.
    let (main_silence, main_silence_caps) = silence_source("main-silence")?;
    pipeline
        .add(&main_silence)
        .and_then(|()| pipeline.add(&main_silence_caps))
        .map_err(|e| format!("add main silence: {e}"))?;
    gst::Element::link_many([&main_silence, &main_silence_caps]).map_err(|e| format!("link main silence caps: {e}"))?;
    let main_silence_pad = mixer.request_pad_simple("sink_%u").ok_or("mixer: request silence pad failed")?;
    main_silence_caps
        .static_pad("src")
        .ok_or("main silence: no src pad")?
        .link(&main_silence_pad)
        .map_err(|e| format!("link main silence: {e}"))?;

    // Solo/PFL-Monitor-Bus (Nutzerwunsch 2026-07-29, K4-Entscheidung
    // "Monitor-Summe + lokale Wiedergabe"): ein `tee` NACH `level_master`
    // speist zusätzlich zum unveränderten Haupt-Pfad (`master_out_queue`
    // → `mxl_output`, exakt wie zuvor `level_master` direkt) einen
    // zweiten Zweig zum Monitor-Bus (`pfl_mixer`, gespeist außerdem von
    // jedem Kanal über dessen Prefader-`pfl_gain`, s.
    // `add_channel_branch`) — `master_pfl_gain` ist per Default (kein
    // Kanal soloed) hörbar und schaltet stumm, sobald mindestens ein
    // Kanal soloed wird (`recompute_master_pfl_gain`). Bewusst VOR dem
    // ersten `MxlAudioOutput::new`-Aufruf aufgebaut (statt hinterher per
    // Unlink/Relink umzuverdrahten) — `MxlAudioOutput::new` verlinkt sein
    // `upstream`-Argument bereits intern, ein sauberer Tee-Vorbau ist
    // einfacher als das Ergebnis nachträglich aufzutrennen.
    let pfl_mixer = gst::ElementFactory::make("audiomixer")
        .name("pfl-mixer")
        .build()
        .map_err(|e| format!("audiomixer (pfl): {e}"))?;
    let master_pfl_tee = gst::ElementFactory::make("tee")
        .name("master-pfl-tee")
        .build()
        .map_err(|e| format!("tee (master pfl): {e}"))?;
    let master_out_queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue (master out): {e}"))?;
    let master_pfl_queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue (master pfl): {e}"))?;
    let master_pfl_gain = gst::ElementFactory::make("volume")
        .name("master-pfl-gain")
        .property("volume", 1.0f64)
        .build()
        .map_err(|e| format!("volume (master pfl): {e}"))?;

    pipeline
        .add(&pfl_mixer)
        .and_then(|()| pipeline.add(&master_pfl_tee))
        .and_then(|()| pipeline.add(&master_out_queue))
        .and_then(|()| pipeline.add(&master_pfl_queue))
        .and_then(|()| pipeline.add(&master_pfl_gain))
        .map_err(|e| format!("add pfl elements (master): {e}"))?;

    gst::Element::link_many([&level_master, &master_pfl_tee])
        .map_err(|e| format!("link level_master to master pfl tee: {e}"))?;
    gst::Element::link_many([&master_pfl_tee, &master_out_queue])
        .map_err(|e| format!("link master pfl tee to master out queue: {e}"))?;
    gst::Element::link_many([&master_pfl_tee, &master_pfl_queue, &master_pfl_gain])
        .map_err(|e| format!("link master pfl tee to master pfl gain: {e}"))?;

    let master_pfl_pad = pfl_mixer
        .request_pad_simple("sink_%u")
        .ok_or("pfl_mixer: request sink pad failed (master)")?;
    master_pfl_gain
        .static_pad("src")
        .ok_or("master_pfl_gain: no src pad")?
        .link(&master_pfl_pad)
        .map_err(|e| format!("link master pfl gain to pfl mixer: {e}"))?;

    let mxl_output = MxlAudioOutput::new(
        &pipeline,
        &master_out_queue,
        context.clone(),
        &config.flow_id,
        &config.label,
        SAMPLE_RATE,
        CHANNELS,
    )
    .map_err(|e| format!("MxlAudioOutput: {e}"))?;
    mxl_output.set_active(true);
    let flowed = mxl_output.flowed_handle();

    let pfl_output = MxlAudioOutput::new(
        &pipeline,
        &pfl_mixer,
        context.clone(),
        &config.monitor_flow_id,
        &format!("{} Monitor", config.label),
        SAMPLE_RATE,
        CHANNELS,
    )
    .map_err(|e| format!("MxlAudioOutput (pfl): {e}"))?;
    pfl_output.set_active(true);

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;
    Ok(ActivePipeline {
        pipeline,
        mixer,
        channels: HashMap::new(),
        master_params,
        shared: shared.clone(),
        aux: HashMap::new(),
        _mxl_output: mxl_output,
        pfl_mixer,
        master_pfl_gain,
        _pfl_output: pfl_output,
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

    let shared: SharedMap = Arc::new(Mutex::new(HashMap::new()));
    let mut active = match build(&context, &config, &shared) {
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
        shared: shared.clone(),
    }));

    let bus = active.pipeline.bus().expect("pipeline always has a bus");

    // Root-Cause-Fund Bugliste 2026-09-25 #3 (gleiches Muster wie
    // `omp-viewer::pipeline::run`): `add_channel_branch` schlägt fehl,
    // wenn der externe MXL-Flow im Moment von `AddChannel`/
    // `SetChannelSource` noch nicht existiert (Quelle erzeugt, aber noch
    // nichts geschrieben) — bisher OHNE Retry, der Kanal blieb dann
    // dauerhaft ohne Zweig in `active.channels`, selbst nachdem die
    // Quelle später zu schreiben begann. `pending_channels` merkt sich
    // die gewünschte, noch nicht erfolgreich gebaute `(id, source)`-
    // Zuordnung für den Timeout-Retry unten.
    let mut pending_channels: HashMap<String, ChannelSource> = HashMap::new();

    let mut last_dsp_report = std::time::Instant::now();
    loop {
        if last_dsp_report.elapsed() >= Duration::from_millis(100) {
            last_dsp_report = std::time::Instant::now();
            let snapshot: Vec<(String, Arc<dsp::ChannelShared>)> =
                active.shared.lock().expect("lock poisoned").iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            for (id, sh) in &snapshot {
                let m = &sh.meters;
                let _ = tx.send(Event::Dsp {
                    channel_id: Some(id.clone()),
                    comp_gr_db: m.comp_gr_db.get() as f64,
                    gate_gr_db: m.gate_gr_db.get() as f64,
                    auto_db: sh.auto_db.get() as f64,
                    duck_db: sh.duck_db.get() as f64,
                    in_db: m.rms_db.get() as f64,
                    on_air: sh.on_air.load(Ordering::Relaxed),
                });
            }
            let _ = tx.send(Event::Dsp {
                channel_id: None,
                comp_gr_db: active.master_params.gr_db.get() as f64,
                gate_gr_db: 0.0,
                auto_db: 0.0,
                duck_db: 0.0,
                in_db: 0.0,
                on_air: false,
            });
        }
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
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
                match add_channel_branch(&mut active, &context, &id, &source) {
                    Ok(()) => {
                        pending_channels.remove(&id);
                    }
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("addChannel({id}) failed: {e}")));
                        pending_channels.insert(id, source);
                    }
                }
            }
            Ok(Command::RemoveChannel(id)) => {
                pending_channels.remove(&id);
                active.shared.lock().expect("lock poisoned").remove(&id);
                remove_channel_branch(&mut active, &id);
            }
            Ok(Command::SetChannelSource { id, source }) => {
                // Nur ersetzen, wenn der Kanal (noch) existiert ODER
                // bereits als `pending` (fehlgeschlagen, wartet auf Retry)
                // gemerkt ist — ein `removeChannel` kurz zuvor darf hier
                // keinen neuen Zweig ohne zugehörigen Kanal-Zustand in
                // `main.rs` entstehen lassen.
                if active.channels.contains_key(&id) || pending_channels.contains_key(&id) {
                    remove_channel_branch(&mut active, &id);
                    match add_channel_branch(&mut active, &context, &id, &source) {
                        Ok(()) => {
                            pending_channels.remove(&id);
                        }
                        Err(e) => {
                            let _ = tx.send(Event::Error(format!("setSource({id}) failed: {e}")));
                            pending_channels.insert(id, source);
                        }
                    }
                }
            }
            // Gain/Mute/Parameter landen im geteilten Kanalzustand (auch vor
            // dem ersten erfolgreichen Zweigaufbau, z. B. bei noch nicht
            // vorhandenem externem Flow) — die Probes im Audio-Thread lesen
            // ihn bei jedem Buffer.
            Ok(Command::SetGain { id, db }) => {
                shared_for(&active, &id).fader_db.set(db as f32);
            }
            Ok(Command::SetMute { id, muted }) => {
                shared_for(&active, &id).muted.store(muted, Ordering::Relaxed);
            }
            Ok(Command::SetProc { id, params }) => {
                shared_for(&active, &id).set_params(params);
            }
            Ok(Command::SetMasterLimiter { params }) => {
                *active.master_params.params.lock().expect("lock poisoned") = params;
                active.master_params.version.fetch_add(1, Ordering::Release);
            }
            Ok(Command::SetAuxActive { aux, active: on }) => {
                if on
                    && !active.aux.contains_key(&aux)
                    && let Some((_, flow_id, label)) = config.aux_slots.iter().find(|(id, _, _)| *id == aux).cloned()
                    && let Err(e) = build_aux(&mut active, &context, &aux, &flow_id, &label)
                {
                    let _ = tx.send(Event::Error(format!("aux {aux} build failed: {e}")));
                }
                if let Some(rt) = active.aux.get(&aux) {
                    rt.output.set_active(on);
                }
            }
            Ok(Command::SetAuxMaster { aux, db, muted }) => {
                if let Some(rt) = active.aux.get(&aux) {
                    rt.master.set_property("volume", dsp::db_to_lin(db));
                    rt.master.set_property("mute", muted);
                }
            }
            Ok(Command::SetSend { channel, aux, enabled, level_db, post }) => {
                let sh = shared_for(&active, &channel);
                let send = sh.send(&aux);
                send.level_db.set(level_db as f32);
                send.post.store(post, Ordering::Relaxed);
                send.enabled.store(enabled, Ordering::Relaxed);
                if enabled && let Err(e) = ensure_send_branch(&mut active, &channel, &aux) {
                    let _ = tx.send(Event::Error(format!("setSend({channel}->{aux}) failed: {e}")));
                }
            }
            Ok(Command::SetPfl { id, enabled }) => {
                let changed = if let Some(branch) = active.channels.get_mut(&id) {
                    branch.pfl_gain.set_property("volume", if enabled { 1.0f64 } else { 0.0f64 });
                    branch.pfl_enabled = enabled;
                    true
                } else {
                    false
                };
                if changed {
                    recompute_master_pfl_gain(&active);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if !pending_channels.is_empty() {
                    let retry: Vec<(String, ChannelSource)> = pending_channels
                        .iter()
                        .map(|(id, source)| (id.clone(), source.clone()))
                        .collect();
                    for (id, source) in retry {
                        if add_channel_branch(&mut active, &context, &id, &source).is_ok() {
                            pending_channels.remove(&id);
                        }
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }

        // Nicht-blockierend alle wartenden `level`-Bus-Messages
        // abholen (K4-Teil-1) — `pop_filtered` statt `timed_pop_filtered`,
        // damit dieser Schritt den nächsten Kommando-Wartezyklus nicht
        // zusätzlich verzögert.
        while let Some(msg) = bus.pop_filtered(&[gst::MessageType::Element, gst::MessageType::Error]) {
            if let gst::MessageView::Error(err) = msg.view() {
                let src = msg.src().map(|o| o.path_string().to_string()).unwrap_or_default();
                let _ = tx.send(Event::Error(format!("GStreamer {src}: {} ({:?})", err.error(), err.debug())));
                continue;
            }
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
