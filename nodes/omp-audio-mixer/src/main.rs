//! omp-audio-mixer: zweiter §13-Referenzknoten (`UMSETZUNG.md` C11) —
//! ein `NcBlock` mit dynamischer `ChannelStrip`-Anzahl
//! (`addChannel`/`removeChannel`), Gain/EQ pro Kanal und Audio-Follow-
//! Video gegen den von `omp-video-mixer-me` (C10) bespielten
//! `omp.tally.<node_id>`-NATS-Bus — kein neuer Sync-Mechanismus
//! (`ARCHITECTURE.md` §13.2).
//!
//! **Deskriptor-Namensraum** wie bei C10 (v0-Schema kennt keine
//! `NcBlock`/`NcWorker`-Verschachtelung, `omp-node-sdk/src/
//! descriptor.rs`): `channel.<id>.<name>` pro dynamischem `ChannelStrip`.
//! Anders als C10s feste Worker ist die Kanalliste hier zur Laufzeit
//! veränderlich — der Descriptor wird bei jedem `GET /descriptor.json`
//! frisch aus der aktuellen Kanalliste generiert (`descriptor()` unten),
//! B6/das eigene UI-Bundle re-fetchen entsprechend (kein Push-Mechanismus
//! nötig, `ARCHITECTURE.md` §13.2).

mod automation;
mod dsp;
mod engine;
mod media;
mod model;
mod pipeline;
mod routing;
mod rules;
mod uibundle;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_mediaio::levels;
use omp_node_sdk::health;
use omp_node_sdk::is04::{self, RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    Range, RawResponse, SenderSpec, SetError,
};
use model::{DuckState, GroupState};
use rules::{AudioContext, ChannelAutomation, ContextRule};
use pipeline::PipelineHandle;
use serde_json::Value;

/// Feste Crossfade-Dauer für `followMode=crossfade` (Minimalausbau, keine
/// pro-Kanal-konfigurierbare Zeit — §13.2 nennt `crossfadeMs` als
/// Konzept, nicht als Pflicht-Parameter; volle Konfigurierbarkeit bleibt
/// wie Kompressor/Limiter/Aux/Gruppen Community-Vertiefung).
const FOLLOW_CROSSFADE_MS: u64 = 500;
const FOLLOW_CROSSFADE_STEPS: u64 = 12;

/// Bearbeitungsparameter-Tabelle (Kapitel 26): Name, Typ, Wertebereich.
/// Einzige Quelle für Descriptor, `get` und State-Dokument — die
/// Parameternamen der Altfassung (`eqLow`, `eqLowFreq`, `compThreshold`, …)
/// bleiben unverändert, neue kommen dazu.
type ProcParamSpec = (&'static str, ParamType, Option<(f64, f64)>);
const PROC_PARAMS: &[ProcParamSpec] = &[
    ("eqBypass", ParamType::Boolean, None),
    ("eqHpEnabled", ParamType::Boolean, None),
    ("eqHpFreq", ParamType::Number, Some((20.0, 500.0))),
    ("eqLow", ParamType::Number, Some((-24.0, 12.0))),
    ("eqMid", ParamType::Number, Some((-24.0, 12.0))),
    ("eqMid2", ParamType::Number, Some((-24.0, 12.0))),
    ("eqHigh", ParamType::Number, Some((-24.0, 12.0))),
    ("eqLowFreq", ParamType::Number, Some((20.0, 20000.0))),
    ("eqMidFreq", ParamType::Number, Some((20.0, 20000.0))),
    ("eqMid2Freq", ParamType::Number, Some((20.0, 20000.0))),
    ("eqHighFreq", ParamType::Number, Some((20.0, 20000.0))),
    ("eqLowWidth", ParamType::Number, Some((10.0, 20000.0))),
    ("eqMidWidth", ParamType::Number, Some((10.0, 20000.0))),
    ("eqMid2Width", ParamType::Number, Some((10.0, 20000.0))),
    ("eqHighWidth", ParamType::Number, Some((10.0, 20000.0))),
    ("compEnabled", ParamType::Boolean, None),
    ("compThreshold", ParamType::Number, Some((-60.0, 0.0))),
    ("compRatio", ParamType::Number, Some((1.0, 20.0))),
    ("compMakeup", ParamType::Number, Some((0.0, 24.0))),
    ("compAttack", ParamType::Number, Some((0.1, 200.0))),
    ("compRelease", ParamType::Number, Some((5.0, 2000.0))),
    ("compKnee", ParamType::Number, Some((0.0, 24.0))),
    ("compRms", ParamType::Boolean, None),
    ("gateEnabled", ParamType::Boolean, None),
    ("gateThreshold", ParamType::Number, Some((-90.0, 0.0))),
    ("gateRange", ParamType::Number, Some((-90.0, 0.0))),
    ("gateRatio", ParamType::Number, Some((1.0, 100.0))),
    ("gateAttack", ParamType::Number, Some((0.1, 200.0))),
    ("gateHold", ParamType::Number, Some((0.0, 2000.0))),
    ("gateRelease", ParamType::Number, Some((5.0, 4000.0))),
    ("gateHysteresis", ParamType::Number, Some((0.0, 20.0))),
    ("delayEnabled", ParamType::Boolean, None),
    ("delayMs", ParamType::Number, Some((0.0, 2000.0))),
    ("pan", ParamType::Number, Some((-1.0, 1.0))),
    ("phaseInvert", ParamType::Boolean, None),
];

fn proc_get(p: &dsp::ProcParams, prop: &str) -> Option<Value> {
    let band = |i: usize| p.eq.bands[i];
    let width = |i: usize| band(i).freq / band(i).q.max(0.01);
    Some(match prop {
        "eqBypass" => p.eq.bypass.into(),
        "eqHpEnabled" => p.eq.hp_enabled.into(),
        "eqHpFreq" => p.eq.hp_freq.into(),
        "eqLow" => band(0).gain_db.into(),
        "eqMid" => band(1).gain_db.into(),
        "eqMid2" => band(2).gain_db.into(),
        "eqHigh" => band(3).gain_db.into(),
        "eqLowFreq" => band(0).freq.into(),
        "eqMidFreq" => band(1).freq.into(),
        "eqMid2Freq" => band(2).freq.into(),
        "eqHighFreq" => band(3).freq.into(),
        "eqLowWidth" => width(0).into(),
        "eqMidWidth" => width(1).into(),
        "eqMid2Width" => width(2).into(),
        "eqHighWidth" => width(3).into(),
        "compEnabled" => p.comp.enabled.into(),
        "compThreshold" => p.comp.threshold_db.into(),
        "compRatio" => p.comp.ratio.into(),
        "compMakeup" => p.comp.makeup_db.into(),
        "compAttack" => p.comp.attack_ms.into(),
        "compRelease" => p.comp.release_ms.into(),
        "compKnee" => p.comp.knee_db.into(),
        "compRms" => p.comp.rms.into(),
        "gateEnabled" => p.gate.enabled.into(),
        "gateThreshold" => p.gate.threshold_db.into(),
        "gateRange" => p.gate.range_db.into(),
        "gateRatio" => p.gate.ratio.into(),
        "gateAttack" => p.gate.attack_ms.into(),
        "gateHold" => p.gate.hold_ms.into(),
        "gateRelease" => p.gate.release_ms.into(),
        "gateHysteresis" => p.gate.hysteresis_db.into(),
        "delayEnabled" => p.delay_enabled.into(),
        "delayMs" => p.delay_ms.into(),
        "pan" => p.pan.into(),
        "phaseInvert" => p.phase_invert.into(),
        _ => return None,
    })
}

/// Schreibt einen Parameterwert (mit Bereichsbegrenzung) in `p`; `false`
/// bei unbekanntem Namen/falschem Typ.
fn proc_set(p: &mut dsp::ProcParams, prop: &str, v: &Value) -> bool {
    let Some(&(_, kind, range)) = PROC_PARAMS.iter().find(|(n, _, _)| *n == prop) else {
        return false;
    };
    let num = |v: &Value| -> Option<f64> {
        let x = v.as_f64()?;
        Some(match range {
            Some((lo, hi)) => x.clamp(lo, hi),
            None => x,
        })
    };
    let q_of = |freq: f64, width: f64| dsp::bandwidth_to_q(freq, width);
    macro_rules! n {
        () => {
            match num(v) {
                Some(x) => x,
                None => return false,
            }
        };
    }
    macro_rules! b {
        () => {
            match v.as_bool() {
                Some(x) => x,
                None => return false,
            }
        };
    }
    let _ = kind;
    match prop {
        "eqBypass" => p.eq.bypass = b!(),
        "eqHpEnabled" => p.eq.hp_enabled = b!(),
        "eqHpFreq" => p.eq.hp_freq = n!(),
        "eqLow" => p.eq.bands[0].gain_db = n!(),
        "eqMid" => p.eq.bands[1].gain_db = n!(),
        "eqMid2" => p.eq.bands[2].gain_db = n!(),
        "eqHigh" => p.eq.bands[3].gain_db = n!(),
        "eqLowFreq" => p.eq.bands[0].freq = n!(),
        "eqMidFreq" => p.eq.bands[1].freq = n!(),
        "eqMid2Freq" => p.eq.bands[2].freq = n!(),
        "eqHighFreq" => p.eq.bands[3].freq = n!(),
        "eqLowWidth" | "eqMidWidth" | "eqMid2Width" | "eqHighWidth" => {
            let i = match prop {
                "eqLowWidth" => 0,
                "eqMidWidth" => 1,
                "eqMid2Width" => 2,
                _ => 3,
            };
            let w = n!();
            p.eq.bands[i].q = q_of(p.eq.bands[i].freq, w);
        }
        "compEnabled" => p.comp.enabled = b!(),
        "compThreshold" => p.comp.threshold_db = n!(),
        "compRatio" => p.comp.ratio = n!(),
        "compMakeup" => p.comp.makeup_db = n!(),
        "compAttack" => p.comp.attack_ms = n!(),
        "compRelease" => p.comp.release_ms = n!(),
        "compKnee" => p.comp.knee_db = n!(),
        "compRms" => p.comp.rms = b!(),
        "gateEnabled" => p.gate.enabled = b!(),
        "gateThreshold" => p.gate.threshold_db = n!(),
        "gateRange" => p.gate.range_db = n!(),
        "gateRatio" => p.gate.ratio = n!(),
        "gateAttack" => p.gate.attack_ms = n!(),
        "gateHold" => p.gate.hold_ms = n!(),
        "gateRelease" => p.gate.release_ms = n!(),
        "gateHysteresis" => p.gate.hysteresis_db = n!(),
        "delayEnabled" => p.delay_enabled = b!(),
        "delayMs" => p.delay_ms = n!(),
        "pan" => p.pan = n!(),
        "phaseInvert" => p.phase_invert = b!(),
        _ => return false,
    }
    true
}

/// Wendet alle im JSON-Objekt vorhandenen Bearbeitungsparameter an
/// (fehlende bleiben beim Ausgangswert — Rückwärtskompatibilität alter
/// Presets, die die neuen Felder nicht kennen).
fn proc_from_json(base: dsp::ProcParams, doc: &Value) -> dsp::ProcParams {
    let mut p = base;
    for (name, _, _) in PROC_PARAMS {
        if let Some(v) = doc.get(*name) {
            proc_set(&mut p, name, v);
        }
    }
    p
}

fn proc_to_json(p: &dsp::ProcParams, out: &mut serde_json::Map<String, Value>) {
    for (name, _, _) in PROC_PARAMS {
        if let Some(v) = proc_get(p, name) {
            out.insert((*name).to_string(), v);
        }
    }
}

/// Aux-Bus (fester Slot, `pipeline::Config::aux_slots`). `kind == "n1"`:
/// Mix-Minus — alle Kanäle außer `exclude` laufen automatisch post-Fader
/// (Pegel 0 dB, individuell anpassbar) auf den Bus; das Signal des
/// ausgeschlossenen Kanals ist *strukturell* nie enthalten (kein Send
/// möglich), nicht bloß stummgeschaltet.
#[derive(Clone)]
struct AuxState {
    id: String,
    sender_id: String,
    flow_id: String,
    label: String,
    active: bool,
    kind: String,
    exclude: String,
    master_db: f64,
    muted: bool,
    /// Kanalzahl des MXL-Ausgangs (Kap. 31.1; Aux/N-1 = Stereo).
    channels: u32,
    /// Bereits mit dieser Kanalzahl gebauter MXL-Ausgang (0 = noch nie gebaut);
    /// ein gebauter Slot behält seine Kanalzahl für die Pipeline-Lebensdauer.
    built_channels: u32,
    /// Nur `kind == "group"`: Gruppenname (Tag `role.<group>` am Sender).
    group: String,
}

/// Layout-Name → Kanalzahl der unterstützten diskreten Layouts (Kap. 31.1).
fn layout_channels(layout: &str) -> Option<u32> {
    match layout {
        "mono" => Some(1),
        "stereo" => Some(2),
        "5.1" => Some(6),
        "7.1" => Some(8),
        _ => None,
    }
}

fn channels_layout(channels: u32) -> &'static str {
    match channels {
        1 => "mono",
        6 => "5.1",
        8 => "7.1",
        _ => "stereo",
    }
}

/// Gruppenname für den Tag `role.<group>`: klein, nur `a-z0-9_-`.
fn sanitize_group(s: &str) -> String {
    s.trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// IS-04-Tags des Sender eines Busses (`urn:x-omp:tags`, wie bei den Playern).
fn bus_sender_tags(a: &AuxState) -> Vec<String> {
    if a.kind != "group" {
        return vec![];
    }
    vec![format!("role.{}", a.group), format!("layout.{}", channels_layout(a.channels))]
}

#[derive(Clone, Copy)]
struct SendState {
    enabled: bool,
    level_db: f64,
    post: bool,
}

/// Gespeicherte Audio-Szene: Momentaufnahme des *Mix-Zustands* (Fader/Mute/
/// Routing/Gruppen/AutoMix/Ducking/Aux/Media-Automation, optional
/// Bearbeitung) für die vorhandenen Kanäle — keine Strukturänderung
/// (Kanäle werden nie angelegt/entfernt), deshalb ohne Audio-Aussetzer
/// aktivierbar. Gegenstück zu den Presets (`/state`), die die ganze
/// Kanalliste ersetzen.
#[derive(Clone)]
struct SceneState {
    id: String,
    label: String,
    doc: Value,
}

/// Änderungen an der NMOS-Senderliste (`invoke` läuft auf einem HTTP-Thread,
/// `add_sender` ist async) — gleiches Muster wie `omp-mxf-player-direct`.
enum SenderChange {
    Add { sender_id: String, flow_id: String, label: String, channels: u32, tags: Vec<String> },
    Remove { sender_id: String },
}

#[derive(Clone)]
struct ChannelState {
    id: String,
    label: String,
    gain_db: f64,
    mute: bool,
    /// Solo/PFL (Nutzerwunsch 2026-07-29, END-GOAL-FEATURES Kapitel-10-
    /// Entscheidung K4 "Solo/PFL wird gebaut"): schaltet diesen Kanal auf
    /// den separaten Monitor-Bus (`pipeline::PipelineHandle::set_pfl`) —
    /// bewusst NICHT Teil von `capture_state`/`restore_state`: Solo ist
    /// ein momentaner Abhör-Hilfsschalter, kein Mix-Parameter, ein
    /// wiederhergestelltes Preset soll den Monitor nicht überraschend
    /// auf einen längst irrelevanten Kanal stehen lassen (analog dazu,
    /// dass echte Konsolen Solo/PFL ebenfalls nicht in Szenen speichern).
    pfl: bool,
    /// EQ/Gate/Kompressor/Delay/Pan (`dsp::ProcParams`) — wirkt direkt in
    /// der DSP-Probe der Pipeline.
    proc: dsp::ProcParams,
    /// Gruppen-ID (`GroupState::id`), leer = keine Gruppe. Gruppen
    /// verändern die individuellen Kanalwerte nie, sie wirken additiv.
    group: String,
    /// Nimmt dieser Kanal am AutoMix seiner Gruppe teil?
    am_enabled: bool,
    /// Entscheidungsgewicht/Vorrang/Empfindlichkeit des AutoMix —
    /// beeinflussen die *Entscheidung*, sind kein Audio-Gain.
    am_weight: f64,
    am_priority: u8,
    am_sensitivity_db: f64,
    /// "Channel Manual": AutoMix und Ducking wirken nicht auf diesen Kanal
    /// (Override durch den Operator; die Engine schreibt nie Fader/Mute).
    manual: bool,
    /// Darf als Ducking-Ziel abgesenkt werden.
    duckable: bool,
    /// Aux-Sends (Schlüssel = Aux-ID); fehlender Eintrag = Standard des Bus-Typs.
    sends: HashMap<String, SendState>,
    /// Auf den Programm-Bus geroutet (Default ja). On-Air ≠ Unmuted: ein
    /// entstummter, aber nicht auf Programm gerouteter Kanal ist nicht on air.
    main_route: bool,
    /// Deklarative Media-Automation (`rules.rs`).
    automation: ChannelAutomation,
    /// Node-ID der zu verfolgenden Quelle (Tally-Bus-Subject,
    /// `omp.tally.<node_id>`) — leer = keine Kopplung.
    follow_target: String,
    /// "off" | "cut" | "crossfade".
    follow_mode: String,
    /// Manueller Override (§13.2): unterbricht die Kopplung für diesen
    /// Kanal, ohne den Automatismus anderer Kanäle zu beeinflussen.
    override_enabled: bool,
    /// Audio-Follow-Video-Pegel (§4.6 Nachtrag Punkt 3): `true` (Default)
    /// = bisheriges Verhalten unverändert — der "Aus"-Zustand ist echte
    /// Stille (`pipeline::set_mute`), der "An"-Zustand der reguläre
    /// Kanal-Fader (`gain_db`); `follow_on_level_db`/
    /// `follow_off_level_db`/`follow_transition_ms` bleiben dabei
    /// wirkungslos. `false` = AFV übernimmt Gain komplett eigenständig
    /// (der Fader wird währenddessen ignoriert): "An"/"Aus" rampen
    /// zwischen `follow_on_level_db`/`follow_off_level_db`, `mute`
    /// bleibt durchgehend `false` — die "Stille" entsteht rein über den
    /// Gain-Pegel. Kein `Option<f64>`/`-inf`-Sentinel: JSON kennt keine
    /// Unendlichkeit (`serde_json` würde das stillschweigend zu `null`
    /// machen), einfache, immer JSON-taugliche Felder sind hier klarer
    /// als ein nullbarer Sonderfall.
    follow_use_mute: bool,
    /// Ziel-Pegel des "An"-Zustands in dB, nur wirksam wenn
    /// `follow_use_mute == false`. Default 0dB (Unity, wie ein frischer
    /// Kanal ohne Follow-Konfiguration auch klingen würde).
    follow_on_level_db: f64,
    /// Ziel-Pegel des "Aus"-Zustands in dB, nur wirksam wenn
    /// `follow_use_mute == false` (s. dort). Default -20dB (Beispielwert
    /// aus `docs/END-GOAL-FEATURES.md` §4.6: "z. B. -20dB statt
    /// Vollstille").
    follow_off_level_db: f64,
    /// Crossfade-Dauer in ms, nur wirksam wenn `follow_use_mute ==
    /// false` und `follow_mode == "crossfade"` — ersetzt für diesen Pfad
    /// die feste `FOLLOW_CROSSFADE_MS`; der Mute-basierte Pfad
    /// (`follow_use_mute == true`) behält seine feste Dauer bei
    /// (bewusst unverändert, s. `follow_use_mute`-Doku). Default 500ms
    /// = derselbe Wert wie `FOLLOW_CROSSFADE_MS`.
    follow_transition_ms: u64,
    /// Testton-Frequenz, die dieser Kanal bei `addChannel` bekam — bleibt
    /// über einen Quellwechsel hin und her erhalten, damit `setSource("")`
    /// (zurück auf intern) immer denselben, wiedererkennbaren Ton liefert
    /// statt bei jedem Wechsel neu zu würfeln.
    internal_freq: f64,
    /// `senderId` der aktuell gewählten externen Quelle, leer = interner
    /// Testton (`pipeline::ChannelSource::Internal`).
    source: String,
}

impl ChannelState {
    fn new(id: String, label: String, internal_freq: f64) -> Self {
        ChannelState {
            id,
            label,
            gain_db: 0.0,
            mute: false,
            pfl: false,
            proc: dsp::ProcParams::default(),
            group: String::new(),
            am_enabled: false,
            am_weight: 1.0,
            am_priority: 0,
            am_sensitivity_db: -50.0,
            manual: false,
            duckable: true,
            sends: HashMap::new(),
            main_route: true,
            automation: ChannelAutomation::default(),
            follow_target: String::new(),
            follow_mode: "off".to_string(),
            override_enabled: false,
            follow_use_mute: true,
            follow_on_level_db: 0.0,
            follow_off_level_db: -20.0,
            follow_transition_ms: FOLLOW_CROSSFADE_MS,
            internal_freq,
            source: String::new(),
        }
    }
}

/// Ein per IS-04-Discovery gefundener externer MXL-Audio-Sender —
/// wählbar als Kanalquelle (`channel.<id>.setSource`).
#[derive(Debug, Clone)]
struct DiscoveredAudioSource {
    sender_id: String,
    label: String,
    flow_id: String,
}

struct AudioMixerStore {
    channels: Arc<Mutex<Vec<ChannelState>>>,
    available_sources: Arc<Mutex<Vec<DiscoveredAudioSource>>>,
    next_seq: Arc<AtomicU64>,
    pipeline: PipelineHandle,
    /// `http://<host>:<port>/levels` (K4-Teil-1) — gleiches Muster wie
    /// `omp-viewer`s `previewUrl` (C6): der tatsächlich gebundene Port
    /// steht erst nach `levels::spawn()` fest.
    levels_url: String,
    /// Master-Limiter-Zustand (§4.6 Teil 2) — im Gegensatz zu den
    /// Kanal-Kompressoren nicht Teil einer Liste, deshalb ein eigenes
    /// Feld statt eines `channel.<id>.*`-Eintrags.
    master_limiter: Mutex<dsp::CompParams>,
    /// Gruppen und Ducking-Regeln (Kapitel 26, `model.rs`).
    groups: Mutex<Vec<GroupState>>,
    ducks: Mutex<Vec<DuckState>>,
    /// Konfiguration der Automations-Engine (`engine.rs`) — wird nach jeder
    /// Änderung aus Kanälen/Gruppen/Regeln neu aufgebaut (`sync_engine`).
    engine_cfg: engine::ConfigCell,
    aux: Mutex<Vec<AuxState>>,
    sender_changes: tokio::sync::mpsc::UnboundedSender<SenderChange>,
    node_label: String,
    /// Audio-Szenen und Video→Audio-Kontext (Kapitel 26).
    scenes: Mutex<Vec<SceneState>>,
    contexts: Mutex<Vec<ContextRule>>,
    audio_ctx: Mutex<AudioContext>,
    /// Ereignisse für die Automations-Regeln (Engine, Szenen, Video-Tally).
    events_tx: std::sync::mpsc::Sender<rules::Event>,
    media_status: Arc<Mutex<HashMap<String, media::MediaStatus>>>,
    /// Labels aller bekannten Nodes (Auswahl für Media-Ziele).
    available_nodes: Arc<Mutex<Vec<String>>>,
    /// Semantisches Routing (Kapitel 27 / P6).
    routing: Mutex<routing::RoutingState>,
}

/// Testton-Frequenz pro Kanal — nur zur akustischen Unterscheidbarkeit im
/// Software-Testsignal (s. `pipeline.rs`-Moduldoku), keine funktionale
/// Bedeutung.
fn channel_freq(seq: u64) -> f64 {
    220.0 * (1 + (seq % 8)) as f64
}

/// `readonly: true` für alle Kanal-Parameter — Zustandsänderungen laufen
/// ausschließlich über die `channel.<id>.set*`-Methoden (Range-Prüfung,
/// `followMode`-Validierung etc.), nicht über generisches `PATCH
/// /params/<name>` (gleiche Konvention wie `omp-video-mixer-me`, C10:
/// `set()` gibt dort wie hier immer `SetError::ReadOnly` zurück — beim
/// C11-Verifikationslauf per `tools/contract-check` (C9) gefunden, das
/// `readonly: false` hier ursprünglich fälschlich als PATCH-fähig
/// deklariert hatte, während `set()` das nie unterstützt hat).
fn channel_param(worker: &str, name: &str, kind: ParamType, range: Option<Range>) -> ParamSpec {
    ParamSpec {
        name: format!("channel.{worker}.{name}"),
        kind,
        unit: None,
        range,
        readonly: true,
    }
}

impl ParamStore for AudioMixerStore {
    fn descriptor(&self) -> Descriptor {
        let channels = self.channels.lock().expect("lock poisoned");

        let mut parameters = vec![
            // JSON-Array [{id,label}], gleiche Array-Ausnahme wie
            // "crosspoint.inputs" bei omp-video-mixer-me (C10).
            ParamSpec {
                name: "channels".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            // JSON-Array [{senderId,label}] — per Discovery gefundene
            // externe MXL-Audio-Sender, wählbar über
            // `channel.<id>.setSource`.
            ParamSpec {
                name: "availableSources".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            // Kapitel 26: Gruppen und Ducking-Regeln als JSON-Arrays
            // (vollständige Objekte, `model.rs`), Änderung per
            // `group.<id>.*`/`duck.<id>.*`-Methoden.
            ParamSpec {
                name: "groups".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            // Kapitel 26: Aux-/N-1-Busse (feste Slots, `active` zeigt die belegten).
            ParamSpec {
                name: "auxBuses".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            // Kapitel 26: Szenen, Video→Audio-Kontext, Media-Ziele.
            // Gesamtzustand in EINEM Abruf (Konsolen-UI: ein Poll statt
            // Dutzenden Einzelparametern je Kanal, wichtig bei 32–128 Kanälen).
            ParamSpec { name: "mixState".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "scenes".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            // P6: Erwartungen, Quell-Kontext, letzter Plan samt Begründung/Konflikten.
            ParamSpec { name: "routing".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec {
                name: "contextRules".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "audioContext".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "availableNodes".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "duckRules".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            // K4-Teil-1: SSE-Endpunkt für Metering, s. `levels.rs`.
            ParamSpec {
                name: "levelsUrl".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            // §4.6 Teil 2: Master-Limiter, gleiche vier Werte wie ein
            // Kanal-Kompressor (s. `master_param` unten), aber ohne
            // `channel.<id>.`-Namensraum.
            ParamSpec {
                name: "masterLimiterEnabled".to_string(),
                kind: ParamType::Boolean,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "masterLimiterThreshold".to_string(),
                kind: ParamType::Number,
                unit: Some("dB".to_string()),
                range: Some(Range::Number { min: -60.0, max: 0.0 }),
                readonly: true,
            },
            ParamSpec {
                name: "masterLimiterRatio".to_string(),
                kind: ParamType::Number,
                unit: None,
                range: Some(Range::Number { min: 1.0, max: 20.0 }),
                readonly: true,
            },
            ParamSpec {
                name: "masterLimiterMakeup".to_string(),
                kind: ParamType::Number,
                unit: Some("dB".to_string()),
                range: Some(Range::Number { min: 0.0, max: 24.0 }),
                readonly: true,
            },
        ];
        let mut methods = vec![
            MethodSpec {
                name: "addChannel".to_string(),
                args: vec![MethodArg {
                    name: "label".to_string(),
                    kind: ParamType::String,
                }],
            },
            MethodSpec {
                name: "removeChannel".to_string(),
                args: vec![MethodArg {
                    name: "channelId".to_string(),
                    kind: ParamType::String,
                }],
            },
            MethodSpec {
                name: "addAux".to_string(),
                args: vec![
                    MethodArg { name: "label".to_string(), kind: ParamType::String },
                    MethodArg { name: "kind".to_string(), kind: ParamType::String },
                    MethodArg { name: "layout".to_string(), kind: ParamType::String },
                    MethodArg { name: "group".to_string(), kind: ParamType::String },
                ],
            },
            MethodSpec {
                name: "removeAux".to_string(),
                args: vec![MethodArg { name: "auxId".to_string(), kind: ParamType::String }],
            },
            MethodSpec {
                name: "setVideoContext".to_string(),
                args: vec![
                    MethodArg { name: "source".to_string(), kind: ParamType::String },
                    MethodArg { name: "active".to_string(), kind: ParamType::Boolean },
                ],
            },
            MethodSpec {
                name: "captureScene".to_string(),
                args: vec![
                    MethodArg { name: "label".to_string(), kind: ParamType::String },
                    MethodArg { name: "includeProcessing".to_string(), kind: ParamType::Boolean },
                ],
            },
            // P6: semantisches Routing. `ruleJson` = {"required":[],"preferred":[],"forbidden":[]}
            // (leer = Erwartung entfernen); `overridesJson` = {"ch1":{"capability":{"id":"commentator"}}}.
            MethodSpec {
                name: "setRouting".to_string(),
                args: vec![
                    MethodArg { name: "channelId".to_string(), kind: ParamType::String },
                    MethodArg { name: "ruleJson".to_string(), kind: ParamType::String },
                ],
            },
            MethodSpec {
                name: "setSourceContext".to_string(),
                args: vec![
                    MethodArg { name: "nodeId".to_string(), kind: ParamType::String },
                    MethodArg { name: "group".to_string(), kind: ParamType::String },
                    MethodArg { name: "label".to_string(), kind: ParamType::String },
                    MethodArg { name: "overridesJson".to_string(), kind: ParamType::String },
                ],
            },
            MethodSpec { name: "clearSourceContext".to_string(), args: vec![] },
            MethodSpec {
                name: "resetRouting".to_string(),
                args: vec![MethodArg { name: "channelId".to_string(), kind: ParamType::String }],
            },
            MethodSpec {
                name: "activateScene".to_string(),
                args: vec![MethodArg { name: "sceneId".to_string(), kind: ParamType::String }],
            },
            MethodSpec {
                name: "removeScene".to_string(),
                args: vec![MethodArg { name: "sceneId".to_string(), kind: ParamType::String }],
            },
            MethodSpec {
                name: "addContext".to_string(),
                args: vec![
                    MethodArg { name: "label".to_string(), kind: ParamType::String },
                    MethodArg { name: "source".to_string(), kind: ParamType::String },
                    MethodArg { name: "scene".to_string(), kind: ParamType::String },
                ],
            },
            MethodSpec {
                name: "removeContext".to_string(),
                args: vec![MethodArg { name: "contextId".to_string(), kind: ParamType::String }],
            },
            MethodSpec {
                name: "addGroup".to_string(),
                args: vec![MethodArg { name: "label".to_string(), kind: ParamType::String }],
            },
            MethodSpec {
                name: "removeGroup".to_string(),
                args: vec![MethodArg { name: "groupId".to_string(), kind: ParamType::String }],
            },
            MethodSpec {
                name: "addDuck".to_string(),
                args: vec![MethodArg { name: "label".to_string(), kind: ParamType::String }],
            },
            MethodSpec {
                name: "removeDuck".to_string(),
                args: vec![MethodArg { name: "duckId".to_string(), kind: ParamType::String }],
            },
            MethodSpec {
                name: "setMasterLimiter".to_string(),
                args: vec![
                    MethodArg { name: "enabled".to_string(), kind: ParamType::Boolean },
                    MethodArg { name: "thresholdDb".to_string(), kind: ParamType::Number },
                    MethodArg { name: "ratio".to_string(), kind: ParamType::Number },
                    MethodArg { name: "makeupDb".to_string(), kind: ParamType::Number },
                ],
            },
        ];

        for ch in channels.iter() {
            let id = &ch.id;
            parameters.push(ParamSpec {
                name: format!("channel.{id}.label"),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            });
            parameters.push(channel_param(
                id,
                "gain",
                ParamType::Number,
                Some(Range::Number { min: -60.0, max: 12.0 }),
            ));
            parameters.push(channel_param(id, "mute", ParamType::Boolean, None));
            parameters.push(channel_param(id, "pfl", ParamType::Boolean, None));
            // Kapitel 26: EQ (HPF + 4 Bänder), Kompressor, Gate/Expander,
            // Delay, Pan — Tabelle `PROC_PARAMS`, wirkt in der DSP-Probe.
            for (name, kind, range) in PROC_PARAMS {
                parameters.push(channel_param(
                    id,
                    name,
                    *kind,
                    range.map(|(min, max)| Range::Number { min, max }),
                ));
            }
            // Kapitel 26: Gruppe, AutoMix-Teilnahme/-Gewichtung, Manual-Override.
            parameters.push(channel_param(id, "group", ParamType::String, None));
            parameters.push(channel_param(id, "autoMixEnabled", ParamType::Boolean, None));
            parameters.push(channel_param(
                id,
                "autoMixWeight",
                ParamType::Number,
                Some(Range::Number { min: 0.1, max: 4.0 }),
            ));
            parameters.push(channel_param(
                id,
                "autoMixPriority",
                ParamType::Number,
                Some(Range::Number { min: 0.0, max: 2.0 }),
            ));
            parameters.push(channel_param(
                id,
                "autoMixSensitivity",
                ParamType::Number,
                Some(Range::Number { min: -90.0, max: -10.0 }),
            ));
            parameters.push(channel_param(id, "autoManual", ParamType::Boolean, None));
            parameters.push(channel_param(id, "sends", ParamType::String, None));
            parameters.push(channel_param(id, "mainRoute", ParamType::Boolean, None));
            parameters.push(channel_param(id, "onAir", ParamType::Boolean, None));
            parameters.push(channel_param(id, "automation", ParamType::String, None));
            parameters.push(channel_param(id, "mediaStatus", ParamType::String, None));
            parameters.push(channel_param(id, "duckable", ParamType::Boolean, None));
            // `senderId` der externen Quelle, leer = interner Testton.
            parameters.push(channel_param(id, "source", ParamType::String, None));
            parameters.push(channel_param(id, "followTarget", ParamType::String, None));
            parameters.push(channel_param(
                id,
                "followMode",
                ParamType::Enum,
                Some(Range::Enum {
                    values: vec!["off".to_string(), "cut".to_string(), "crossfade".to_string()],
                }),
            ));
            parameters.push(channel_param(
                id,
                "overrideEnabled",
                ParamType::Boolean,
                None,
            ));
            // §4.6 Nachtrag Punkt 3 (Audio-Follow-Video-Pegel: An-/Aus-
            // Pegel + Transition-Zeit, alle nur wirksam bei
            // `followUseMute == false`, s. ChannelState-Doku).
            parameters.push(channel_param(id, "followUseMute", ParamType::Boolean, None));
            parameters.push(channel_param(
                id,
                "followOnLevelDb",
                ParamType::Number,
                Some(Range::Number { min: -60.0, max: 12.0 }),
            ));
            parameters.push(channel_param(
                id,
                "followOffLevelDb",
                ParamType::Number,
                Some(Range::Number { min: -60.0, max: 12.0 }),
            ));
            parameters.push(channel_param(
                id,
                "followTransitionMs",
                ParamType::Number,
                Some(Range::Number { min: 0.0, max: 10000.0 }),
            ));

            methods.push(MethodSpec {
                name: format!("channel.{id}.setGain"),
                args: vec![MethodArg {
                    name: "db".to_string(),
                    kind: ParamType::Number,
                }],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setMute"),
                args: vec![MethodArg {
                    name: "muted".to_string(),
                    kind: ParamType::Boolean,
                }],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setPfl"),
                args: vec![MethodArg {
                    name: "enabled".to_string(),
                    kind: ParamType::Boolean,
                }],
            });
            let num = |n: &str| MethodArg { name: n.to_string(), kind: ParamType::Number };
            let flag = |n: &str| MethodArg { name: n.to_string(), kind: ParamType::Boolean };
            methods.push(MethodSpec {
                name: format!("channel.{id}.setEq"),
                args: vec![num("low"), num("mid"), num("high")],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setEqGain"),
                args: vec![MethodArg { name: "band".to_string(), kind: ParamType::String }, num("gainDb")],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setEqBand"),
                args: vec![
                    MethodArg { name: "band".to_string(), kind: ParamType::String },
                    num("freq"),
                    num("width"),
                ],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setEqHp"),
                args: vec![flag("enabled"), num("freq")],
            });
            methods.push(MethodSpec { name: format!("channel.{id}.setEqBypass"), args: vec![flag("bypass")] });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setComp"),
                args: vec![
                    flag("enabled"),
                    num("thresholdDb"),
                    num("ratio"),
                    num("makeupDb"),
                    num("attackMs"),
                    num("releaseMs"),
                    num("kneeDb"),
                    flag("rms"),
                ],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setGate"),
                args: vec![
                    flag("enabled"),
                    num("thresholdDb"),
                    num("rangeDb"),
                    num("ratio"),
                    num("attackMs"),
                    num("holdMs"),
                    num("releaseMs"),
                    num("hysteresisDb"),
                ],
            });
            methods.push(MethodSpec { name: format!("channel.{id}.setDelay"), args: vec![flag("enabled"), num("ms")] });
            methods.push(MethodSpec { name: format!("channel.{id}.setPan"), args: vec![num("pan")] });
            methods.push(MethodSpec { name: format!("channel.{id}.setPhase"), args: vec![flag("invert")] });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setLabel"),
                args: vec![MethodArg { name: "label".to_string(), kind: ParamType::String }],
            });
            methods.push(MethodSpec { name: format!("channel.{id}.setMainRoute"), args: vec![flag("routed")] });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setAutomation"),
                args: vec![
                    flag("enabled"),
                    MethodArg { name: "target".to_string(), kind: ParamType::String },
                    MethodArg { name: "rules".to_string(), kind: ParamType::String },
                ],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setSend"),
                args: vec![
                    MethodArg { name: "auxId".to_string(), kind: ParamType::String },
                    flag("enabled"),
                    num("levelDb"),
                    flag("post"),
                ],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setGroup"),
                args: vec![MethodArg { name: "groupId".to_string(), kind: ParamType::String }],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setAutoMix"),
                args: vec![flag("enabled"), num("weight"), num("priority"), num("sensitivityDb")],
            });
            methods.push(MethodSpec { name: format!("channel.{id}.setManual"), args: vec![flag("manual")] });
            methods.push(MethodSpec { name: format!("channel.{id}.setDuckable"), args: vec![flag("enabled")] });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setSource"),
                args: vec![MethodArg {
                    name: "senderId".to_string(),
                    kind: ParamType::String,
                }],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setFollow"),
                args: vec![
                    MethodArg {
                        name: "targetNodeId".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "mode".to_string(),
                        kind: ParamType::String,
                    },
                ],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setOverride"),
                args: vec![MethodArg {
                    name: "enabled".to_string(),
                    kind: ParamType::Boolean,
                }],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setFollowLevels"),
                args: vec![
                    MethodArg { name: "useMute".to_string(), kind: ParamType::Boolean },
                    MethodArg { name: "onLevelDb".to_string(), kind: ParamType::Number },
                    MethodArg { name: "offLevelDb".to_string(), kind: ParamType::Number },
                    MethodArg { name: "transitionMs".to_string(), kind: ParamType::Number },
                ],
            });
        }

        let n = |name: &str| MethodArg { name: name.to_string(), kind: ParamType::Number };
        let b = |name: &str| MethodArg { name: name.to_string(), kind: ParamType::Boolean };
        let t = |name: &str| MethodArg { name: name.to_string(), kind: ParamType::String };
        for g in self.groups.lock().expect("lock poisoned").iter() {
            let id = &g.id;
            methods.push(MethodSpec { name: format!("group.{id}.setLabel"), args: vec![t("label")] });
            methods.push(MethodSpec { name: format!("group.{id}.setGain"), args: vec![n("db")] });
            methods.push(MethodSpec { name: format!("group.{id}.setMute"), args: vec![b("muted")] });
            methods.push(MethodSpec {
                name: format!("group.{id}.setAutoMix"),
                args: vec![
                    b("enabled"),
                    n("attackMs"),
                    n("holdMs"),
                    n("releaseMs"),
                    n("maxAttenDb"),
                    n("sharing"),
                    t("detector"),
                ],
            });
        }
        for sc in self.scenes.lock().expect("lock poisoned").iter() {
            let id = &sc.id;
            methods.push(MethodSpec { name: format!("scene.{id}.update"), args: vec![b("includeProcessing")] });
            methods.push(MethodSpec { name: format!("scene.{id}.setLabel"), args: vec![t("label")] });
        }
        for c in self.contexts.lock().expect("lock poisoned").iter() {
            let id = &c.id;
            methods.push(MethodSpec {
                name: format!("context.{id}.set"),
                args: vec![b("enabled"), t("label"), t("source"), t("scene")],
            });
        }
        for a in self.aux.lock().expect("lock poisoned").iter().filter(|a| a.active) {
            let id = &a.id;
            methods.push(MethodSpec { name: format!("aux.{id}.setLabel"), args: vec![t("label")] });
            methods.push(MethodSpec { name: format!("aux.{id}.setMaster"), args: vec![n("db"), b("muted")] });
            methods.push(MethodSpec { name: format!("aux.{id}.setN1"), args: vec![t("exclude")] });
        }
        for d in self.ducks.lock().expect("lock poisoned").iter() {
            let id = &d.id;
            methods.push(MethodSpec { name: format!("duck.{id}.setLabel"), args: vec![t("label")] });
            methods.push(MethodSpec {
                name: format!("duck.{id}.set"),
                args: vec![
                    b("enabled"),
                    t("keys"),
                    t("targets"),
                    n("thresholdDb"),
                    n("hysteresisDb"),
                    n("amountDb"),
                    n("maxDb"),
                    n("attackMs"),
                    n("holdMs"),
                    n("releaseMs"),
                    n("minTriggerMs"),
                    t("detector"),
                ],
            });
        }

        Descriptor {
            parameters,
            methods,
            // D8 Teil 1 (UMSETZUNG.md, ARCHITECTURE.md §15.1 Punkt 4/5): live
            // per Kopf-Index/Wallclock-Skew-Verfahren gemessen (5 Testworkflow-
            // Samples, `docs/decisions.md` Nachtrag zu D8 Teil 1). Wie
            // `omp-video-mixer-me` setzt der Audiomixer einen neuen Ursprung
            // (kein durchgereichter Origin-Index von den Kanal-Quellen) —
            // gemessen wurde die eigene Kopfindex-Distanz zur Wallclock, nicht
            // die kumulierte Latenz eines Eingangspfads. Einheit: Samples der
            // Audio-Grain-Rate (48 kHz), nicht Video-Frames. Beobachtet:
            // -1098..-987 Samples (Head index bis zu einem Commit-Batch der
            // Wallclock voraus, Lookahead-Batch-Schreiben) — `maxLatencyFrames`
            // deshalb konservativ auf die tatsächliche Commit-Batch-Größe
            // (480 Samples, s. `mxl-info`s "Commit batch size") gesetzt, nicht
            // auf die wenigen Rohmesswerte, die nur diese Batch-Grenze zeigen.
            latency: Some(omp_node_sdk::LatencyInfo {
                video: None,
                audio: Some(omp_node_sdk::LatencyRange {
                    min_latency_frames: 0,
                    max_latency_frames: 480,
                }),
                data: None,
                supports_delay_compensation: false,
            }),
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        if name == "levelsUrl" {
            return Some(serde_json::json!(self.levels_url));
        }
        if name == "channels" {
            let channels = self.channels.lock().expect("lock poisoned");
            return Some(serde_json::json!(
                channels
                    .iter()
                    .map(|c| serde_json::json!({"id": c.id, "label": c.label}))
                    .collect::<Vec<_>>()
            ));
        }
        if name == "groups" {
            let groups = self.groups.lock().expect("lock poisoned");
            return Some(Value::Array(groups.iter().map(GroupState::to_json).collect()));
        }
        if name == "mixState" {
            return Some(self.mix_state());
        }
        if name == "routing" {
            return Some(self.routing.lock().expect("lock poisoned").view());
        }
        if name == "scenes" {
            let scenes = self.scenes.lock().expect("lock poisoned");
            return Some(Value::Array(
                scenes.iter().map(|s| serde_json::json!({"id": s.id, "label": s.label})).collect(),
            ));
        }
        if name == "contextRules" {
            let c = self.contexts.lock().expect("lock poisoned");
            return Some(Value::Array(c.iter().map(ContextRule::to_json).collect()));
        }
        if name == "audioContext" {
            let c = self.audio_ctx.lock().expect("lock poisoned");
            return Some(serde_json::json!({"activeSources": c.active_sources, "activeScene": c.active_scene}));
        }
        if name == "availableNodes" {
            return Some(serde_json::json!(*self.available_nodes.lock().expect("lock poisoned")));
        }
        if name == "auxBuses" {
            let aux = self.aux.lock().expect("lock poisoned");
            return Some(Value::Array(aux.iter().map(aux_json).collect()));
        }
        if name == "duckRules" {
            let ducks = self.ducks.lock().expect("lock poisoned");
            return Some(Value::Array(ducks.iter().map(DuckState::to_json).collect()));
        }
        if name == "availableSources" {
            let sources = self.available_sources.lock().expect("lock poisoned");
            return Some(serde_json::json!(
                sources
                    .iter()
                    .map(|s| serde_json::json!({"senderId": s.sender_id, "label": s.label}))
                    .collect::<Vec<_>>()
            ));
        }
        if let Some(v) = self.get_master_limiter(name) {
            return Some(v);
        }

        let (id, prop) = parse_channel_name(name)?;
        let channels = self.channels.lock().expect("lock poisoned");
        let ch = channels.iter().find(|c| c.id == id)?;
        match prop {
            "label" => Some(serde_json::json!(ch.label)),
            "gain" => Some(serde_json::json!(ch.gain_db)),
            "mute" => Some(serde_json::json!(ch.mute)),
            "pfl" => Some(serde_json::json!(ch.pfl)),
            other if proc_get(&ch.proc, other).is_some() => proc_get(&ch.proc, other),
            "sends" => {
                let aux = self.aux.lock().expect("lock poisoned");
                Some(Value::Array(
                    aux.iter()
                        .filter(|a| a.active)
                        .map(|a| {
                            let (enabled, level_db, post, locked) = effective_send(ch, a);
                            serde_json::json!({"auxId": a.id, "enabled": enabled, "levelDb": level_db, "post": post, "locked": locked})
                        })
                        .collect(),
                ))
            }
            "mainRoute" => Some(serde_json::json!(ch.main_route)),
            "onAir" => Some(serde_json::json!(
                self.pipeline
                    .shared_map()
                    .lock()
                    .expect("lock poisoned")
                    .get(&ch.id)
                    .is_some_and(|sh| sh.on_air.load(Ordering::Relaxed))
            )),
            "automation" => Some(ch.automation.to_json()),
            "mediaStatus" => Some(
                self.media_status
                    .lock()
                    .expect("lock poisoned")
                    .get(&ch.id)
                    .map_or(Value::Null, media::MediaStatus::to_json),
            ),
            "group" => Some(serde_json::json!(ch.group)),
            "autoMixEnabled" => Some(serde_json::json!(ch.am_enabled)),
            "autoMixWeight" => Some(serde_json::json!(ch.am_weight)),
            "autoMixPriority" => Some(serde_json::json!(ch.am_priority)),
            "autoMixSensitivity" => Some(serde_json::json!(ch.am_sensitivity_db)),
            "autoManual" => Some(serde_json::json!(ch.manual)),
            "duckable" => Some(serde_json::json!(ch.duckable)),
            "source" => Some(serde_json::json!(ch.source)),
            "followTarget" => Some(serde_json::json!(ch.follow_target)),
            "followMode" => Some(serde_json::json!(ch.follow_mode)),
            "overrideEnabled" => Some(serde_json::json!(ch.override_enabled)),
            "followUseMute" => Some(serde_json::json!(ch.follow_use_mute)),
            "followOnLevelDb" => Some(serde_json::json!(ch.follow_on_level_db)),
            "followOffLevelDb" => Some(serde_json::json!(ch.follow_off_level_db)),
            "followTransitionMs" => Some(serde_json::json!(ch.follow_transition_ms)),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let result = self.invoke_inner(name, args);
        if result.is_ok() {
            // Jede erfolgreiche Änderung kann Gruppen/Regeln/Kanalzuordnung
            // berühren — Engine-Konfiguration neu aufbauen (billig).
            self.sync_engine();
            let touches_sends = name == "addChannel"
                || name == "addAux"
                || name == "removeAux"
                || name.starts_with("aux.")
                || name.ends_with(".setSend")
                || name.ends_with(".setSource");
            if touches_sends {
                self.apply_sends();
            }
        }
        result
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if method == "GET" && path == "/state" {
            let state = self.capture_state();
            let payload = serde_json::to_vec(&serde_json::json!({ "state": state })).unwrap_or_default();
            return Some(RawResponse { status: 200, content_type: "application/json", body: payload });
        }
        if method == "POST" && path == "/state" {
            let parsed: Result<Value, _> = serde_json::from_slice(body);
            let state = match parsed {
                Ok(v) => v.get("state").cloned().unwrap_or(Value::Null),
                Err(_) => {
                    return Some(RawResponse {
                        status: 400,
                        content_type: "application/json",
                        body: br#"{"error":"invalid JSON body"}"#.to_vec(),
                    });
                }
            };
            return Some(match self.restore_state(&state) {
                Ok(()) => {
                    RawResponse { status: 200, content_type: "application/json", body: br#"{"ok":true}"#.to_vec() }
                }
                Err(()) => RawResponse {
                    status: 400,
                    content_type: "application/json",
                    body: br#"{"error":"invalid state document"}"#.to_vec(),
                },
            });
        }
        uibundle::route(method, path)
    }
}

/// Zerlegt `channel.<id>.<prop>` — `id` selbst kann kein `.` enthalten
/// (per `ch<seq>`-Generierung, `invoke()` oben), ein einfacher Split
/// reicht.
/// Limiter-Charakter für den Master: schnelle Peak-Detektion, kein Knee
/// (der Master-Limiter ist kein Klangformer, sondern Übersteuerungsschutz).
fn master_limiter_params(enabled: bool, threshold_db: f64, ratio: f64, makeup_db: f64) -> dsp::CompParams {
    dsp::CompParams {
        enabled,
        threshold_db,
        ratio,
        attack_ms: 1.0,
        release_ms: 120.0,
        knee_db: 0.0,
        makeup_db,
        rms: false,
    }
}

/// Überträgt vorhandene Methoden-Argumente (`(Argumentname, Parametername)`)
/// per `proc_set` auf `p`; fehlende Argumente bleiben unverändert, ein
/// Argument mit falschem Typ ist ein Fehler.
fn apply_args(
    p: &mut dsp::ProcParams,
    args: &serde_json::Map<String, Value>,
    map: &[(&str, &str)],
) -> Result<(), InvokeError> {
    // Frequenz-/Bandbreitenreihenfolge ist hier unkritisch (keine Q-Umrechnung).
    for (arg, param) in map {
        if let Some(v) = args.get(*arg)
            && !proc_set(p, param, v)
        {
            return Err(InvokeError::Unknown);
        }
    }
    if map.is_empty() || map.iter().all(|(a, _)| !args.contains_key(*a)) {
        return Err(InvokeError::Unknown);
    }
    Ok(())
}

/// Wirksamer Send eines Kanals auf einen Aux-Bus: (aktiv, Pegel dB, Post, gesperrt).
/// Nur hier wird die N-1-Regel erzwungen.
fn effective_send(ch: &ChannelState, aux: &AuxState) -> (bool, f64, bool, bool) {
    if !aux.active {
        return (false, 0.0, true, false);
    }
    if aux.kind == "n1" {
        if ch.id == aux.exclude {
            return (false, 0.0, true, true);
        }
        let s = ch.sends.get(&aux.id).copied().unwrap_or(SendState { enabled: true, level_db: 0.0, post: true });
        return (s.enabled, s.level_db, s.post, false);
    }
    let s = ch.sends.get(&aux.id).copied().unwrap_or(SendState { enabled: false, level_db: 0.0, post: true });
    (s.enabled, s.level_db, s.post, false)
}

fn aux_json(a: &AuxState) -> Value {
    serde_json::json!({
        "id": a.id, "label": a.label, "active": a.active, "kind": a.kind,
        "exclude": a.exclude, "masterDb": a.master_db, "mute": a.muted,
        "channels": a.channels, "layout": channels_layout(a.channels), "group": a.group,
    })
}

fn parse_channel_name(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix("channel.")?;
    rest.split_once('.')
}

impl AudioMixerStore {
    /// Node-eigener Vollzustand (§4.6 Punkt 4, `docs/END-GOAL-FEATURES.md`
    /// "Mixer-Presets", `docs/decisions.md` Nachtrag 40): alle Kanäle
    /// inkl. Gain/EQ/Kompressor/AFV + Master-Limiter als ein opakes
    /// JSON-Objekt hinter `GET /state` (Node-Contract-Erweiterung,
    /// `ARCHITECTURE.md` §5) — genau der Zustand, der wegen
    /// `readonly:true` (s. `channel_param`-Doku) nicht über den
    /// generischen Parameter-Proxy erfassbar ist. Kein Descriptor-Feld
    /// nötig: der Snapshot-Service probiert `GET <baseURL>/state` einfach
    /// aus, ein 404 (Nodes ohne diese Zusatzroute) fällt automatisch auf
    /// die bisherige Parameter-Enumeration zurück.
    fn capture_state(&self) -> Value {
        let channel_docs: Vec<Value> = {
            let channels = self.channels.lock().expect("lock poisoned");
            channels
                .iter()
                .map(|c| {
                    let mut doc = serde_json::Map::new();
                    proc_to_json(&c.proc, &mut doc);
                    let rest = serde_json::json!({
                        "id": c.id, "label": c.label, "internalFreq": c.internal_freq,
                        "gainDb": c.gain_db, "mute": c.mute,
                        "source": c.source,
                        "sends": c.sends.iter().map(|(k, v)| serde_json::json!({
                            "auxId": k, "enabled": v.enabled, "levelDb": v.level_db, "post": v.post,
                        })).collect::<Vec<_>>(),
                        "mainRoute": c.main_route, "automation": c.automation.to_json(),
                        "group": c.group, "autoMixEnabled": c.am_enabled,
                        "autoMixWeight": c.am_weight, "autoMixPriority": c.am_priority,
                        "autoMixSensitivity": c.am_sensitivity_db,
                        "autoManual": c.manual, "duckable": c.duckable,
                        "followTarget": c.follow_target, "followMode": c.follow_mode,
                        "overrideEnabled": c.override_enabled,
                        "followUseMute": c.follow_use_mute,
                        "followOnLevelDb": c.follow_on_level_db,
                        "followOffLevelDb": c.follow_off_level_db,
                        "followTransitionMs": c.follow_transition_ms,
                        "routingExpect": self.routing.lock().expect("lock poisoned").expects.get(&c.id)
                            .and_then(|r| serde_json::to_value(r).ok()).unwrap_or(Value::Null),
                    });
                    if let Value::Object(m) = rest {
                        doc.extend(m);
                    }
                    Value::Object(doc)
                })
                .collect()
        };
        let ml = *self.master_limiter.lock().expect("lock poisoned");
        let group_docs: Vec<Value> =
            self.groups.lock().expect("lock poisoned").iter().map(GroupState::to_json).collect();
        let duck_docs: Vec<Value> =
            self.ducks.lock().expect("lock poisoned").iter().map(DuckState::to_json).collect();
        serde_json::json!({
            "channels": channel_docs,
            "groups": group_docs,
            "duckRules": duck_docs,
            "scenes": self.scenes.lock().expect("lock poisoned").iter()
                .map(|s| serde_json::json!({"id": s.id, "label": s.label, "doc": s.doc})).collect::<Vec<_>>(),
            "contextRules": self.contexts.lock().expect("lock poisoned").iter().map(ContextRule::to_json).collect::<Vec<_>>(),
            "auxBuses": self.aux.lock().expect("lock poisoned").iter().filter(|a| a.active).map(aux_json).collect::<Vec<_>>(),
            "masterLimiter": {
                "enabled": ml.enabled, "thresholdDb": ml.threshold_db,
                "ratio": ml.ratio, "makeupDb": ml.makeup_db,
            },
        })
    }

    /// Kehrseite von `capture_state`: ersetzt die komplette Kanalliste
    /// durch die im State-Dokument beschriebene — nicht additiv/mergend,
    /// ein Mixer-Preset meint "genau diese Kanäle mit genau diesen
    /// Werten" (analog zu `addChannel`, nur alle Felder auf einmal statt
    /// einzeln über die üblichen `channel.<id>.set*`-Methoden). Eine beim
    /// Erfassungszeitpunkt vorhandene, inzwischen aber verschwundene
    /// externe Quelle fällt bewusst still auf den internen Testton
    /// zurück statt das gesamte Preset scheitern zu lassen — eine
    /// einzelne offline Quelle soll kein Preset-Apply blockieren.
    fn restore_state(&self, doc: &Value) -> Result<(), ()> {
        let channel_docs = doc.get("channels").and_then(Value::as_array).ok_or(())?;

        let existing_ids: Vec<String> = {
            let channels = self.channels.lock().expect("lock poisoned");
            channels.iter().map(|c| c.id.clone()).collect()
        };
        for id in existing_ids {
            self.pipeline.remove_channel(id);
        }
        self.channels.lock().expect("lock poisoned").clear();

        // Gruppen/Regeln ersetzen (fehlende Schlüssel in Alt-Presets → leer).
        *self.groups.lock().expect("lock poisoned") = doc
            .get("groups")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(GroupState::from_json).collect())
            .unwrap_or_default();
        *self.ducks.lock().expect("lock poisoned") = doc
            .get("duckRules")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(DuckState::from_json).collect())
            .unwrap_or_default();

        *self.scenes.lock().expect("lock poisoned") = doc
            .get("scenes")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|s| {
                        Some(SceneState {
                            id: s.get("id")?.as_str()?.to_string(),
                            label: s.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
                            doc: s.get("doc").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        *self.contexts.lock().expect("lock poisoned") = doc
            .get("contextRules")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(ContextRule::from_json).collect())
            .unwrap_or_default();

        // Aux-Busse abgleichen (fehlender Schlüssel in Alt-Presets → alle aus).
        {
            let docs: Vec<Value> = doc.get("auxBuses").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut aux = self.aux.lock().expect("lock poisoned");
            for a in aux.iter_mut() {
                let d = docs.iter().find(|d| d.get("id").and_then(Value::as_str) == Some(a.id.as_str()));
                match (d, a.active) {
                    (Some(d), was_active) => {
                        a.label = d.get("label").and_then(Value::as_str).unwrap_or(&a.label).to_string();
                        a.kind = d.get("kind").and_then(Value::as_str).unwrap_or("aux").to_string();
                        a.exclude = d.get("exclude").and_then(Value::as_str).unwrap_or("").to_string();
                        a.master_db = d.get("masterDb").and_then(Value::as_f64).unwrap_or(0.0);
                        a.muted = d.get("mute").and_then(Value::as_bool).unwrap_or(false);
                        a.group = d.get("group").and_then(Value::as_str).unwrap_or("").to_string();
                        let want = d.get("channels").and_then(Value::as_u64).map_or(2, |c| c as u32);
                        // Ein bereits gebauter Ausgang behält seine Kanalzahl.
                        if a.built_channels == 0 || a.built_channels == want {
                            a.channels = want;
                        }
                        a.active = true;
                        if !was_active {
                            let _ = self.sender_changes.send(SenderChange::Add {
                                sender_id: a.sender_id.clone(),
                                flow_id: a.flow_id.clone(),
                                label: format!("{} {}", self.node_label, a.label),
                                channels: a.channels,
                                tags: bus_sender_tags(a),
                            });
                        }
                    }
                    (None, true) => {
                        a.active = false;
                        let _ = self.sender_changes.send(SenderChange::Remove { sender_id: a.sender_id.clone() });
                    }
                    (None, false) => {}
                }
            }
        }

        let sources = self.available_sources.lock().expect("lock poisoned").clone();

        for cd in channel_docs {
            let id = cd.get("id").and_then(Value::as_str).ok_or(())?.to_string();
            let label = cd.get("label").and_then(Value::as_str).unwrap_or(&id).to_string();
            let internal_freq = cd.get("internalFreq").and_then(Value::as_f64).unwrap_or(220.0);

            let mut ch = ChannelState::new(id.clone(), label, internal_freq);
            self.pipeline
                .add_channel(id.clone(), pipeline::ChannelSource::Internal { freq: internal_freq });

            ch.gain_db = cd.get("gainDb").and_then(Value::as_f64).unwrap_or(0.0);
            ch.mute = cd.get("mute").and_then(Value::as_bool).unwrap_or(false);
            // Fehlende (neue) Felder bleiben auf Defaults — Presets aus der
            // Zeit vor Kapitel 26 laden unverändert.
            ch.proc = proc_from_json(ch.proc, cd);
            if let Some(list) = cd.get("sends").and_then(Value::as_array) {
                for sd in list {
                    let Some(aux_id) = sd.get("auxId").and_then(Value::as_str) else { continue };
                    ch.sends.insert(
                        aux_id.to_string(),
                        SendState {
                            enabled: sd.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                            level_db: sd.get("levelDb").and_then(Value::as_f64).unwrap_or(0.0),
                            post: sd.get("post").and_then(Value::as_bool).unwrap_or(true),
                        },
                    );
                }
            }
            ch.main_route = cd.get("mainRoute").and_then(Value::as_bool).unwrap_or(true);
            ch.automation = cd.get("automation").map(ChannelAutomation::from_json).unwrap_or_default();
            ch.group = cd.get("group").and_then(Value::as_str).unwrap_or("").to_string();
            ch.am_enabled = cd.get("autoMixEnabled").and_then(Value::as_bool).unwrap_or(false);
            ch.am_weight = cd.get("autoMixWeight").and_then(Value::as_f64).unwrap_or(1.0);
            ch.am_priority = cd.get("autoMixPriority").and_then(Value::as_u64).unwrap_or(0).min(2) as u8;
            ch.am_sensitivity_db = cd.get("autoMixSensitivity").and_then(Value::as_f64).unwrap_or(-50.0);
            ch.manual = cd.get("autoManual").and_then(Value::as_bool).unwrap_or(false);
            ch.duckable = cd.get("duckable").and_then(Value::as_bool).unwrap_or(true);
            ch.follow_target = cd.get("followTarget").and_then(Value::as_str).unwrap_or("").to_string();
            ch.follow_mode = cd.get("followMode").and_then(Value::as_str).unwrap_or("off").to_string();
            ch.override_enabled = cd.get("overrideEnabled").and_then(Value::as_bool).unwrap_or(false);
            ch.follow_use_mute = cd.get("followUseMute").and_then(Value::as_bool).unwrap_or(true);
            ch.follow_on_level_db = cd.get("followOnLevelDb").and_then(Value::as_f64).unwrap_or(0.0);
            ch.follow_off_level_db = cd.get("followOffLevelDb").and_then(Value::as_f64).unwrap_or(-20.0);
            ch.follow_transition_ms =
                cd.get("followTransitionMs").and_then(Value::as_u64).unwrap_or(FOLLOW_CROSSFADE_MS);
            {
                let mut r = self.routing.lock().expect("lock poisoned");
                match cd.get("routingExpect").and_then(routing::parse_rule) {
                    Some(rule) => {
                        r.expects.insert(id.clone(), rule);
                    }
                    None => {
                        r.expects.remove(&id);
                    }
                }
                r.restore.remove(&id);
                r.pinned.remove(&id);
            }

            let source = cd.get("source").and_then(Value::as_str).unwrap_or("");
            if !source.is_empty()
                && let Some(src) = sources.iter().find(|s| s.sender_id == source)
            {
                ch.source = source.to_string();
                self.pipeline.set_channel_source(
                    id.clone(),
                    pipeline::ChannelSource::External { flow_id: src.flow_id.clone() },
                );
            }

            self.pipeline.set_gain(id.clone(), ch.gain_db);
            self.pipeline.set_mute(id.clone(), ch.mute);
            self.pipeline.set_proc(id.clone(), ch.proc);

            self.channels.lock().expect("lock poisoned").push(ch);
        }

        if let Some(ml) = doc.get("masterLimiter") {
            let state = master_limiter_params(
                ml.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                ml.get("thresholdDb").and_then(Value::as_f64).unwrap_or(-20.0),
                ml.get("ratio").and_then(Value::as_f64).unwrap_or(2.0),
                ml.get("makeupDb").and_then(Value::as_f64).unwrap_or(0.0),
            );
            *self.master_limiter.lock().expect("lock poisoned") = state;
            self.pipeline.set_master_limiter(state);
        }

        // Neue IDs dürfen nicht mit wiederhergestellten kollidieren.
        let max_seq = self
            .channels
            .lock()
            .expect("lock poisoned")
            .iter()
            .map(|c| c.id.clone())
            .chain(self.groups.lock().expect("lock poisoned").iter().map(|g| g.id.clone()))
            .chain(self.ducks.lock().expect("lock poisoned").iter().map(|d| d.id.clone()))
            .chain(self.scenes.lock().expect("lock poisoned").iter().map(|s| s.id.clone()))
            .chain(self.contexts.lock().expect("lock poisoned").iter().map(|c| c.id.clone()))
            .filter_map(|id| id.trim_start_matches(|c: char| c.is_ascii_alphabetic()).parse::<u64>().ok())
            .max()
            .unwrap_or(0);
        self.next_seq.fetch_max(max_seq + 1, Ordering::Relaxed);
        self.sync_engine();
        self.apply_sends();
        Ok(())
    }

    fn invoke_inner(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "addChannel" => {
                let label = args
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
                let id = format!("ch{seq}");
                let label = label.unwrap_or_else(|| format!("Kanal {seq}"));
                let freq = channel_freq(seq);
                self.channels
                    .lock()
                    .expect("lock poisoned")
                    .push(ChannelState::new(id.clone(), label, freq));
                self.pipeline
                    .add_channel(id, pipeline::ChannelSource::Internal { freq });
                Ok(())
            }
            "removeChannel" => {
                let channel_id = args
                    .get("channelId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let mut channels = self.channels.lock().expect("lock poisoned");
                let before = channels.len();
                channels.retain(|c| c.id != channel_id);
                if channels.len() == before {
                    return Err(InvokeError::Unknown);
                }
                self.pipeline.remove_channel(channel_id.to_string());
                let mut r = self.routing.lock().expect("lock poisoned");
                r.expects.remove(channel_id);
                r.restore.remove(channel_id);
                r.pinned.remove(channel_id);
                Ok(())
            }
            "setMasterLimiter" => {
                let enabled = args.get("enabled").and_then(Value::as_bool).ok_or(InvokeError::Unknown)?;
                let threshold_db = args
                    .get("thresholdDb")
                    .and_then(Value::as_f64)
                    .ok_or(InvokeError::Unknown)?;
                let ratio = args.get("ratio").and_then(Value::as_f64).ok_or(InvokeError::Unknown)?;
                let makeup_db = args.get("makeupDb").and_then(Value::as_f64).ok_or(InvokeError::Unknown)?;
                let state = master_limiter_params(enabled, threshold_db, ratio, makeup_db);
                *self.master_limiter.lock().expect("lock poisoned") = state;
                self.pipeline.set_master_limiter(state);
                Ok(())
            }
            "addAux" => {
                let kind = args.get("kind").and_then(Value::as_str).unwrap_or("aux");
                if kind != "aux" && kind != "n1" && kind != "group" {
                    return Err(InvokeError::Unknown);
                }
                // Gruppen-Bus (Kap. 31.1): Layout + Gruppenname sind Konfiguration je Instanz.
                let (channels, group) = if kind == "group" {
                    let layout = args.get("layout").and_then(Value::as_str).unwrap_or("stereo");
                    let channels = layout_channels(layout).ok_or(InvokeError::Unknown)?;
                    let group = sanitize_group(args.get("group").and_then(Value::as_str).unwrap_or(""));
                    if group.is_empty() {
                        return Err(InvokeError::Unknown);
                    }
                    (channels, group)
                } else {
                    (2, String::new())
                };
                let mut aux = self.aux.lock().expect("lock poisoned");
                if kind == "group" && aux.iter().any(|a| a.active && a.kind == "group" && a.group == group) {
                    return Err(InvokeError::Unknown); // je Gruppe nur ein Bus
                }
                // Slot mit passender (oder noch ungebauter) Kanalzahl.
                let Some(slot) = aux.iter_mut().find(|a| !a.active && (a.built_channels == 0 || a.built_channels == channels)) else {
                    return Err(InvokeError::Unknown); // alle Slots belegt
                };
                let label = args
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map_or_else(
                        || match kind {
                            "n1" => format!("N-1 {}", slot.id),
                            "group" => format!("Bus {group}"),
                            _ => format!("Aux {}", slot.id),
                        },
                        str::to_string,
                    );
                slot.active = true;
                slot.channels = channels;
                slot.built_channels = channels;
                slot.group = group;
                slot.kind = kind.to_string();
                slot.label = label.clone();
                slot.exclude.clear();
                slot.master_db = 0.0;
                slot.muted = false;
                let _ = self.sender_changes.send(SenderChange::Add {
                    sender_id: slot.sender_id.clone(),
                    flow_id: slot.flow_id.clone(),
                    label: format!("{} {label}", self.node_label),
                    channels,
                    tags: bus_sender_tags(slot),
                });
                Ok(())
            }
            "removeAux" => {
                let id = args.get("auxId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let mut aux = self.aux.lock().expect("lock poisoned");
                let a = aux.iter_mut().find(|a| a.id == id && a.active).ok_or(InvokeError::Unknown)?;
                a.active = false;
                let _ = self.sender_changes.send(SenderChange::Remove { sender_id: a.sender_id.clone() });
                // Sends dieses Busses vergessen (Slot wird später ggf. neu belegt).
                let id = a.id.clone();
                drop(aux);
                for ch in self.channels.lock().expect("lock poisoned").iter_mut() {
                    ch.sends.remove(&id);
                }
                Ok(())
            }
            _ if name.starts_with("aux.") => {
                let (id, method) = name["aux.".len()..].split_once('.').ok_or(InvokeError::Unknown)?;
                // Kanalliste VOR dem Aux-Lock prüfen (Lock-Reihenfolge: nie aux → channels,
                // `setSend` hält channels → aux).
                let channel_ids: Vec<String> =
                    self.channels.lock().expect("lock poisoned").iter().map(|c| c.id.clone()).collect();
                let mut aux = self.aux.lock().expect("lock poisoned");
                let a = aux.iter_mut().find(|a| a.id == id && a.active).ok_or(InvokeError::Unknown)?;
                match method {
                    "setLabel" => {
                        a.label = args.get("label").and_then(Value::as_str).ok_or(InvokeError::Unknown)?.to_string();
                    }
                    "setMaster" => {
                        if let Some(v) = args.get("db") {
                            a.master_db = v.as_f64().ok_or(InvokeError::Unknown)?.clamp(-60.0, 12.0);
                        }
                        if let Some(v) = args.get("muted") {
                            a.muted = v.as_bool().ok_or(InvokeError::Unknown)?;
                        }
                    }
                    "setN1" => {
                        // Ausgeschlossener Kanal (leer = keiner); Bus wird zum N-1-Typ.
                        let ex = args.get("exclude").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                        if !ex.is_empty() && !channel_ids.iter().any(|c| c == ex) {
                            return Err(InvokeError::Unknown);
                        }
                        a.kind = "n1".to_string();
                        a.exclude = ex.to_string();
                    }
                    _ => return Err(InvokeError::Unknown),
                }
                Ok(())
            }
            // Video-Kontext manuell setzen (Probe/Proben ohne echte Videoquelle,
            // Notfall-Umschaltung): läuft durch denselben Pfad wie ein
            // Tally-Ereignis vom Bus.
            "setVideoContext" => {
                let source = args.get("source").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let active = args.get("active").and_then(Value::as_bool).ok_or(InvokeError::Unknown)?;
                self.on_video_tally(source, active);
                Ok(())
            }
            "captureScene" => {
                let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
                let label = args
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map_or_else(|| format!("Szene {seq}"), str::to_string);
                let with_proc = args.get("includeProcessing").and_then(Value::as_bool).unwrap_or(false);
                let doc = self.capture_scene_doc(with_proc);
                self.scenes.lock().expect("lock poisoned").push(SceneState { id: format!("s{seq}"), label, doc });
                Ok(())
            }
            "removeScene" => {
                let id = args.get("sceneId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let mut scenes = self.scenes.lock().expect("lock poisoned");
                let before = scenes.len();
                scenes.retain(|s| s.id != id);
                if scenes.len() == before { Err(InvokeError::Unknown) } else { Ok(()) }
            }
            "setRouting" => {
                let ch = args.get("channelId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                if !self.channels.lock().expect("lock poisoned").iter().any(|c| c.id == ch) {
                    return Err(InvokeError::Unknown);
                }
                let json = args.get("ruleJson").and_then(Value::as_str).unwrap_or("").trim();
                let rule = if json.is_empty() || json == "null" {
                    None
                } else {
                    routing::parse_rule(&serde_json::from_str::<Value>(json).map_err(|_| InvokeError::Unknown)?)
                };
                {
                    let mut r = self.routing.lock().expect("lock poisoned");
                    match rule {
                        Some(rule) => {
                            r.expects.insert(ch.to_string(), rule);
                        }
                        None => {
                            r.expects.remove(ch);
                        }
                    }
                }
                self.reapply_routing();
                Ok(())
            }
            "setSourceContext" => {
                let node_id = args.get("nodeId").and_then(Value::as_str).unwrap_or("").to_string();
                let group = args.get("group").and_then(Value::as_str).unwrap_or("").to_string();
                if node_id.is_empty() && group.is_empty() {
                    return Err(InvokeError::Unknown);
                }
                let label = args.get("label").and_then(Value::as_str).unwrap_or("").to_string();
                let json = args.get("overridesJson").and_then(Value::as_str).unwrap_or("").trim();
                let overrides = if json.is_empty() || json == "null" {
                    Default::default()
                } else {
                    serde_json::from_str(json).map_err(|_| InvokeError::Unknown)?
                };
                {
                    let mut r = self.routing.lock().expect("lock poisoned");
                    // Neuer Kontext = neue Entscheidungsrunde: Pins des alten Kontexts verfallen.
                    r.pinned.clear();
                    r.active = Some(routing::ActiveContext {
                        label,
                        context: omp_resolver::SourceContext { node_id, group },
                        overrides,
                    });
                }
                self.reapply_routing();
                Ok(())
            }
            "clearSourceContext" => {
                self.clear_routing_context();
                Ok(())
            }
            "resetRouting" => {
                let ch = args.get("channelId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                self.routing.lock().expect("lock poisoned").pinned.remove(ch);
                self.reapply_routing();
                Ok(())
            }
            "activateScene" => {
                let id = args.get("sceneId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                self.activate_scene(id, false)
            }
            _ if name.starts_with("scene.") => {
                let (id, method) = name["scene.".len()..].split_once('.').ok_or(InvokeError::Unknown)?;
                match method {
                    "update" => {
                        let with_proc = args.get("includeProcessing").and_then(Value::as_bool).unwrap_or(false);
                        let doc = self.capture_scene_doc(with_proc);
                        let mut scenes = self.scenes.lock().expect("lock poisoned");
                        scenes.iter_mut().find(|s| s.id == id).ok_or(InvokeError::Unknown)?.doc = doc;
                        Ok(())
                    }
                    "setLabel" => {
                        let l = args.get("label").and_then(Value::as_str).ok_or(InvokeError::Unknown)?.to_string();
                        let mut scenes = self.scenes.lock().expect("lock poisoned");
                        scenes.iter_mut().find(|s| s.id == id).ok_or(InvokeError::Unknown)?.label = l;
                        Ok(())
                    }
                    _ => Err(InvokeError::Unknown),
                }
            }
            "addContext" => {
                let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
                let text = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                self.contexts.lock().expect("lock poisoned").push(ContextRule {
                    id: format!("x{seq}"),
                    label: text("label"),
                    enabled: true,
                    source: text("source"),
                    scene: text("scene"),
                });
                Ok(())
            }
            "removeContext" => {
                let id = args.get("contextId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let mut ctx = self.contexts.lock().expect("lock poisoned");
                let before = ctx.len();
                ctx.retain(|c| c.id != id);
                if ctx.len() == before { Err(InvokeError::Unknown) } else { Ok(()) }
            }
            _ if name.starts_with("context.") => {
                let (id, method) = name["context.".len()..].split_once('.').ok_or(InvokeError::Unknown)?;
                if method != "set" {
                    return Err(InvokeError::Unknown);
                }
                let mut ctx = self.contexts.lock().expect("lock poisoned");
                let c = ctx.iter_mut().find(|c| c.id == id).ok_or(InvokeError::Unknown)?;
                if let Some(v) = args.get("enabled") {
                    c.enabled = v.as_bool().ok_or(InvokeError::Unknown)?;
                }
                for (k, field) in [("label", &mut c.label), ("source", &mut c.source), ("scene", &mut c.scene)] {
                    if let Some(v) = args.get(k) {
                        *field = v.as_str().ok_or(InvokeError::Unknown)?.to_string();
                    }
                }
                Ok(())
            }
            "addGroup" => {
                let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
                let id = format!("g{seq}");
                let label = args
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map_or_else(|| format!("Gruppe {seq}"), str::to_string);
                self.groups.lock().expect("lock poisoned").push(GroupState::new(id, label));
                Ok(())
            }
            "removeGroup" => {
                let gid = args.get("groupId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let mut groups = self.groups.lock().expect("lock poisoned");
                let before = groups.len();
                groups.retain(|g| g.id != gid);
                if groups.len() == before {
                    return Err(InvokeError::Unknown);
                }
                // Mitglieder behalten alle individuellen Werte, nur die Zuordnung entfällt.
                for ch in self.channels.lock().expect("lock poisoned").iter_mut() {
                    if ch.group == gid {
                        ch.group.clear();
                    }
                }
                Ok(())
            }
            "addDuck" => {
                let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
                let label = args
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map_or_else(|| format!("Ducking {seq}"), str::to_string);
                self.ducks.lock().expect("lock poisoned").push(DuckState::new(format!("d{seq}"), label));
                Ok(())
            }
            "removeDuck" => {
                let did = args.get("duckId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let mut ducks = self.ducks.lock().expect("lock poisoned");
                let before = ducks.len();
                ducks.retain(|d| d.id != did);
                if ducks.len() == before { Err(InvokeError::Unknown) } else { Ok(()) }
            }
            _ if name.starts_with("group.") => {
                let (id, method) = name["group.".len()..].split_once('.').ok_or(InvokeError::Unknown)?;
                let mut groups = self.groups.lock().expect("lock poisoned");
                groups.iter_mut().find(|g| g.id == id).ok_or(InvokeError::Unknown)?.invoke(method, args)
            }
            _ if name.starts_with("duck.") => {
                let (id, method) = name["duck.".len()..].split_once('.').ok_or(InvokeError::Unknown)?;
                let mut ducks = self.ducks.lock().expect("lock poisoned");
                ducks.iter_mut().find(|d| d.id == id).ok_or(InvokeError::Unknown)?.invoke(method, args)
            }
            _ => self.invoke_channel_method(name, args),
        }
    }

    /// Baut die Konfiguration der Automations-Engine aus Kanälen, Gruppen
    /// und Regeln neu auf. Reine Momentaufnahme (Arc-Tausch), die Engine
    /// liest sie im nächsten 10-ms-Takt.
    fn sync_engine(&self) {
        let chans: Vec<engine::ChanCfg> = self
            .channels
            .lock()
            .expect("lock poisoned")
            .iter()
            .map(|c| engine::ChanCfg {
                id: c.id.clone(),
                group: c.group.clone(),
                am_enabled: c.am_enabled,
                weight: c.am_weight,
                priority: c.am_priority,
                sensitivity_db: c.am_sensitivity_db,
                manual: c.manual,
                duckable: c.duckable,
                routed: c.main_route,
            })
            .collect();
        let groups = self
            .groups
            .lock()
            .expect("lock poisoned")
            .iter()
            .map(|g| engine::GroupCfg { id: g.id.clone(), gain_db: g.gain_db, muted: g.muted, automix: g.automix })
            .collect();
        let ducks = self
            .ducks
            .lock()
            .expect("lock poisoned")
            .iter()
            .map(|d| engine::DuckCfg {
                id: d.id.clone(),
                enabled: d.enabled,
                keys: d.keys.clone(),
                targets: d.targets.clone(),
                params: d.params.clone(),
            })
            .collect();
        *self.engine_cfg.lock().expect("lock poisoned") = Arc::new(engine::EngineConfig { groups, chans, ducks });
    }

    /// Überträgt alle wirksamen Sends/Master-Pegel in die Pipeline.
    /// Nur nach Änderungen an Sends/Aux/Kanälen aufgerufen (nicht bei
    /// jedem Fader), s. `invoke`.
    fn apply_sends(&self) {
        let aux = self.aux.lock().expect("lock poisoned").clone();
        let channels = self.channels.lock().expect("lock poisoned").clone();
        for a in &aux {
            self.pipeline.set_aux_active(a.id.clone(), a.active, a.channels);
            self.pipeline.set_aux_master(a.id.clone(), a.master_db, a.muted);
            for ch in &channels {
                let (enabled, level_db, post, _) = effective_send(ch, a);
                // Inaktive Busse: nichts senden (verhindert Zweige ohne Abnehmer).
                self.pipeline.set_send(ch.id.clone(), a.id.clone(), enabled && a.active, level_db, post);
            }
        }
    }

    /// Mix-Zustand der vorhandenen Kanäle als Szenen-Dokument. `with_proc`
    /// nimmt zusätzlich EQ/Dynamik/Delay/Pan auf.
    fn capture_scene_doc(&self, with_proc: bool) -> Value {
        let mut chans = serde_json::Map::new();
        for c in self.channels.lock().expect("lock poisoned").iter() {
            let mut d = serde_json::json!({
                "gainDb": c.gain_db, "mute": c.mute, "mainRoute": c.main_route, "group": c.group,
                "autoMixEnabled": c.am_enabled, "autoMixWeight": c.am_weight,
                "autoMixPriority": c.am_priority, "autoMixSensitivity": c.am_sensitivity_db,
                "autoManual": c.manual, "duckable": c.duckable,
                "automation": c.automation.to_json(),
                "sends": c.sends.iter().map(|(k, v)| serde_json::json!({
                    "auxId": k, "enabled": v.enabled, "levelDb": v.level_db, "post": v.post,
                })).collect::<Vec<_>>(),
            });
            if let Some(rule) = self.routing.lock().expect("lock poisoned").expects.get(&c.id) {
                d["routingExpect"] = serde_json::to_value(rule).unwrap_or(Value::Null);
            }
            if with_proc {
                let mut pm = serde_json::Map::new();
                proc_to_json(&c.proc, &mut pm);
                d["proc"] = Value::Object(pm);
            }
            chans.insert(c.id.clone(), d);
        }
        serde_json::json!({
            "channels": chans,
            "groups": self.groups.lock().expect("lock poisoned").iter().map(GroupState::to_json).collect::<Vec<_>>(),
            "duckRules": self.ducks.lock().expect("lock poisoned").iter().map(DuckState::to_json).collect::<Vec<_>>(),
        })
    }

    /// Wendet eine Szene auf die *vorhandenen* Kanäle an (ohne Strukturänderung,
    /// ohne Audio-Aussetzer). `from_context == true` (Automation, z. B. durch
    /// einen Videoquellen-Wechsel): Kanäle im Manual-Override des Operators
    /// bleiben unberührt — Automation überschreibt keinen manuellen Eingriff.
    fn apply_scene(&self, doc: &Value, from_context: bool) {
        let group_ids: Vec<String> = self.groups.lock().expect("lock poisoned").iter().map(|g| g.id.clone()).collect();
        let mut cmds: Vec<(String, f64, bool, Option<dsp::ProcParams>)> = Vec::new();
        let mut reroute = false;
        {
            let mut channels = self.channels.lock().expect("lock poisoned");
            if let Some(map) = doc.get("channels").and_then(Value::as_object) {
                for ch in channels.iter_mut() {
                    if from_context && ch.manual {
                        continue;
                    }
                    let Some(cd) = map.get(&ch.id) else { continue };
                    if let Some(rule) = cd.get("routingExpect").and_then(routing::parse_rule) {
                        self.routing.lock().expect("lock poisoned").expects.insert(ch.id.clone(), rule);
                        reroute = true;
                    }
                    if let Some(v) = cd.get("gainDb").and_then(Value::as_f64) {
                        ch.gain_db = v.clamp(-60.0, 12.0);
                    }
                    if let Some(v) = cd.get("mute").and_then(Value::as_bool) {
                        ch.mute = v;
                    }
                    if let Some(v) = cd.get("mainRoute").and_then(Value::as_bool) {
                        ch.main_route = v;
                    }
                    if let Some(g) = cd.get("group").and_then(Value::as_str) {
                        ch.group = if group_ids.iter().any(|x| x == g) { g.to_string() } else { String::new() };
                    }
                    if let Some(v) = cd.get("autoMixEnabled").and_then(Value::as_bool) {
                        ch.am_enabled = v;
                    }
                    if let Some(v) = cd.get("autoMixWeight").and_then(Value::as_f64) {
                        ch.am_weight = v.clamp(0.1, 4.0);
                    }
                    if let Some(v) = cd.get("autoMixPriority").and_then(Value::as_u64) {
                        ch.am_priority = v.min(2) as u8;
                    }
                    if let Some(v) = cd.get("autoMixSensitivity").and_then(Value::as_f64) {
                        ch.am_sensitivity_db = v.clamp(-90.0, -10.0);
                    }
                    if let Some(v) = cd.get("autoManual").and_then(Value::as_bool) {
                        ch.manual = v;
                    }
                    if let Some(v) = cd.get("duckable").and_then(Value::as_bool) {
                        ch.duckable = v;
                    }
                    if let Some(a) = cd.get("automation") {
                        ch.automation = ChannelAutomation::from_json(a);
                    }
                    if let Some(list) = cd.get("sends").and_then(Value::as_array) {
                        ch.sends.clear();
                        for sd in list {
                            if let Some(aux_id) = sd.get("auxId").and_then(Value::as_str) {
                                ch.sends.insert(
                                    aux_id.to_string(),
                                    SendState {
                                        enabled: sd.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                                        level_db: sd.get("levelDb").and_then(Value::as_f64).unwrap_or(0.0),
                                        post: sd.get("post").and_then(Value::as_bool).unwrap_or(true),
                                    },
                                );
                            }
                        }
                    }
                    let proc = cd.get("proc").map(|p| {
                        ch.proc = proc_from_json(ch.proc, p);
                        ch.proc
                    });
                    cmds.push((ch.id.clone(), ch.gain_db, ch.mute, proc));
                }
            }
        }
        // Gruppen und Regeln: vorhandene Einträge mit gleicher ID aktualisieren
        // (nie hinzufügen/entfernen).
        if let Some(list) = doc.get("groups").and_then(Value::as_array) {
            let mut groups = self.groups.lock().expect("lock poisoned");
            for gd in list {
                if let Some(new) = GroupState::from_json(gd)
                    && let Some(slot) = groups.iter_mut().find(|g| g.id == new.id)
                {
                    *slot = new;
                }
            }
        }
        if let Some(list) = doc.get("duckRules").and_then(Value::as_array) {
            let mut ducks = self.ducks.lock().expect("lock poisoned");
            for dd in list {
                if let Some(new) = DuckState::from_json(dd)
                    && let Some(slot) = ducks.iter_mut().find(|d| d.id == new.id)
                {
                    *slot = new;
                }
            }
        }
        for (id, gain, mute, proc) in cmds {
            self.pipeline.set_gain(id.clone(), gain);
            self.pipeline.set_mute(id.clone(), mute);
            if let Some(p) = proc {
                self.pipeline.set_proc(id, p);
            }
        }
        self.sync_engine();
        self.apply_sends();
        if reroute {
            self.reapply_routing();
        }
    }

    /// Quelle eines Kanals setzen (Handeingriff UND Auto-Routing, gleicher Pfad).
    /// `sender_id` leer = interner Testton.
    fn set_channel_source(&self, ch: &mut ChannelState, id: &str, sender_id: &str) -> Result<(), InvokeError> {
        if sender_id.is_empty() {
            ch.source.clear();
            self.pipeline.set_channel_source(id.to_string(), pipeline::ChannelSource::Internal { freq: ch.internal_freq });
        } else {
            let flow_id = self
                .available_sources
                .lock()
                .expect("lock poisoned")
                .iter()
                .find(|s| s.sender_id == sender_id)
                .map(|s| s.flow_id.clone())
                .ok_or(InvokeError::Unknown)?;
            ch.source = sender_id.to_string();
            self.pipeline.set_channel_source(id.to_string(), pipeline::ChannelSource::External { flow_id });
        }
        // Der neue Zweig startet mit Standardwerten — bereits konfigurierte Werte
        // erneut anwenden (FIFO-Kommandokanal der Pipeline garantiert die Reihenfolge).
        self.pipeline.set_gain(id.to_string(), ch.gain_db);
        self.pipeline.set_mute(id.to_string(), ch.mute);
        self.pipeline.set_pfl(id.to_string(), ch.pfl);
        self.pipeline.set_proc(id.to_string(), ch.proc);
        Ok(())
    }

    /// Plan neu berechnen und anwenden. Lock-Reihenfolge: `channels` → `routing`
    /// (hier nie `routing` gehalten, während `channels` genommen wird).
    fn reapply_routing(&self) {
        let (expects, active, sources, pinned) = {
            let r = self.routing.lock().expect("lock poisoned");
            (r.expects.clone(), r.active.clone(), r.sources.clone(), r.pinned.clone())
        };
        let Some(active) = active else {
            self.routing.lock().expect("lock poisoned").last_plan = None;
            return;
        };
        let plan = routing::plan(&expects, &active, &sources);
        let mut new_restore: Vec<(String, String)> = Vec::new();
        let restore_known = self.routing.lock().expect("lock poisoned").restore.clone();
        let mut changed = false;
        {
            let mut channels = self.channels.lock().expect("lock poisoned");
            for a in &plan.assignments {
                let Some(sender) = a.sender_id.as_deref() else { continue };
                if plan.in_conflict(&a.channel) || pinned.contains(&a.channel) {
                    continue;
                }
                let Some(ch) = channels.iter_mut().find(|c| c.id == a.channel) else { continue };
                if ch.source == sender {
                    continue;
                }
                let prev = ch.source.clone();
                if self.set_channel_source(ch, &a.channel, sender).is_ok() {
                    if !restore_known.contains_key(&a.channel) {
                        new_restore.push((a.channel.clone(), prev));
                    }
                    changed = true;
                }
            }
        }
        {
            let mut r = self.routing.lock().expect("lock poisoned");
            r.restore.extend(new_restore);
            // Nur speichern, wenn der Kontext zwischenzeitlich nicht beendet wurde.
            r.last_plan = r.active.is_some().then_some(plan);
        }
        if changed {
            self.apply_sends();
        }
    }

    /// Kontext beenden: von Auto gesetzte Kanäle zurück auf ihre manuelle Zuordnung
    /// (Spec §101). Vom Operator festgehaltene (gepinnte) Kanäle behalten seine Wahl.
    fn clear_routing_context(&self) {
        let (restore, pinned) = {
            let mut r = self.routing.lock().expect("lock poisoned");
            r.active = None;
            r.last_plan = None;
            (std::mem::take(&mut r.restore), std::mem::take(&mut r.pinned))
        };
        {
            let mut channels = self.channels.lock().expect("lock poisoned");
            for (ch_id, prev) in restore {
                if pinned.contains(&ch_id) {
                    continue;
                }
                let Some(ch) = channels.iter_mut().find(|c| c.id == ch_id) else { continue };
                // Ist die frühere Quelle inzwischen weg, bleibt nur der interne Testton.
                if self.set_channel_source(ch, &ch_id, &prev).is_err() {
                    let _ = self.set_channel_source(ch, &ch_id, "");
                }
            }
        }
        self.apply_sends();
    }

    fn activate_scene(&self, id: &str, from_context: bool) -> Result<(), InvokeError> {
        let doc = self
            .scenes
            .lock()
            .expect("lock poisoned")
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.doc.clone())
            .ok_or(InvokeError::Unknown)?;
        self.apply_scene(&doc, from_context);
        self.audio_ctx.lock().expect("lock poisoned").active_scene = id.to_string();
        let _ = self.events_tx.send(rules::Event::SceneActivated(id.to_string()));
        Ok(())
    }

    /// Tally-Meldung einer Videoquelle: aktualisiert den Audio-Kontext,
    /// aktiviert ggf. die zugeordnete Szene und meldet die Ereignisse an die
    /// Automation (Video→Audio-Kontext statt direkter Mute-Befehle).
    fn on_video_tally(&self, node: &str, on: bool) {
        let _ = self.events_tx.send(if on {
            rules::Event::VideoActive(node.to_string())
        } else {
            rules::Event::VideoInactive(node.to_string())
        });
        let rules_snapshot = self.contexts.lock().expect("lock poisoned").clone();
        let scene = self.audio_ctx.lock().expect("lock poisoned").on_video(&rules_snapshot, node, on);
        if let Some(scene) = scene
            && let Err(e) = self.activate_scene(&scene, true)
        {
            let _ = e;
            eprintln!("omp-audio-mixer: Kontext-Szene {scene} existiert nicht mehr");
        }
    }

    /// Alles, was die Konsolen-UI anzeigt, in einem Dokument. Reine Sicht auf
    /// den Zustand (kein Audiozugriff); Live-Werte (Pegel, GR, On-Air,
    /// AutoMix/Duck-Anteile) kommen über den SSE-Strom.
    fn mix_state(&self) -> Value {
        let aux = self.aux.lock().expect("lock poisoned").clone();
        let media = self.media_status.lock().expect("lock poisoned").clone();
        let channels: Vec<Value> = self
            .channels
            .lock()
            .expect("lock poisoned")
            .iter()
            .map(|c| {
                let mut proc = serde_json::Map::new();
                proc_to_json(&c.proc, &mut proc);
                let sends: Vec<Value> = aux
                    .iter()
                    .filter(|a| a.active)
                    .map(|a| {
                        let (enabled, level_db, post, locked) = effective_send(c, a);
                        serde_json::json!({"auxId": a.id, "enabled": enabled, "levelDb": level_db, "post": post, "locked": locked})
                    })
                    .collect();
                serde_json::json!({
                    "id": c.id, "label": c.label, "gainDb": c.gain_db, "mute": c.mute, "pfl": c.pfl,
                    "source": c.source, "proc": proc, "group": c.group,
                    "autoMix": {"enabled": c.am_enabled, "weight": c.am_weight, "priority": c.am_priority,
                                "sensitivityDb": c.am_sensitivity_db},
                    "manual": c.manual, "duckable": c.duckable, "mainRoute": c.main_route,
                    "sends": sends, "automation": c.automation.to_json(),
                    "mediaStatus": media.get(&c.id).map_or(Value::Null, media::MediaStatus::to_json),
                    "follow": {"target": c.follow_target, "mode": c.follow_mode, "override": c.override_enabled,
                               "useMute": c.follow_use_mute, "onLevelDb": c.follow_on_level_db,
                               "offLevelDb": c.follow_off_level_db, "transitionMs": c.follow_transition_ms},
                })
            })
            .collect();
        let ml = *self.master_limiter.lock().expect("lock poisoned");
        let ctx = self.audio_ctx.lock().expect("lock poisoned").clone();
        serde_json::json!({
            "channels": channels,
            "groups": self.groups.lock().expect("lock poisoned").iter().map(GroupState::to_json).collect::<Vec<_>>(),
            "duckRules": self.ducks.lock().expect("lock poisoned").iter().map(DuckState::to_json).collect::<Vec<_>>(),
            "auxBuses": aux.iter().filter(|a| a.active).map(aux_json).collect::<Vec<_>>(),
            "auxFree": aux.iter().filter(|a| !a.active).count(),
            "scenes": self.scenes.lock().expect("lock poisoned").iter()
                .map(|s| serde_json::json!({"id": s.id, "label": s.label})).collect::<Vec<_>>(),
            "contextRules": self.contexts.lock().expect("lock poisoned").iter().map(ContextRule::to_json).collect::<Vec<_>>(),
            "audioContext": {"activeSources": ctx.active_sources, "activeScene": ctx.active_scene},
            "availableSources": self.available_sources.lock().expect("lock poisoned").iter()
                .map(|s| serde_json::json!({"senderId": s.sender_id, "label": s.label})).collect::<Vec<_>>(),
            "availableNodes": *self.available_nodes.lock().expect("lock poisoned"),
            "routing": self.routing.lock().expect("lock poisoned").view(),
            "masterLimiter": {"enabled": ml.enabled, "thresholdDb": ml.threshold_db, "ratio": ml.ratio, "makeupDb": ml.makeup_db},
        })
    }

    fn get_master_limiter(&self, name: &str) -> Option<Value> {
        let state = *self.master_limiter.lock().expect("lock poisoned");
        match name {
            "masterLimiterEnabled" => Some(serde_json::json!(state.enabled)),
            "masterLimiterThreshold" => Some(serde_json::json!(state.threshold_db)),
            "masterLimiterRatio" => Some(serde_json::json!(state.ratio)),
            "masterLimiterMakeup" => Some(serde_json::json!(state.makeup_db)),
            _ => None,
        }
    }

    fn invoke_channel_method(
        &self,
        name: &str,
        args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        let rest = name.strip_prefix("channel.").ok_or(InvokeError::Unknown)?;
        let (id, method) = rest.split_once('.').ok_or(InvokeError::Unknown)?;

        let mut channels = self.channels.lock().expect("lock poisoned");
        let ch = channels
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or(InvokeError::Unknown)?;

        match method {
            "setGain" => {
                let db = args.get("db").and_then(Value::as_f64).ok_or(InvokeError::Unknown)?;
                ch.gain_db = db;
                self.pipeline.set_gain(id.to_string(), db);
                Ok(())
            }
            "setMute" => {
                let muted = args
                    .get("muted")
                    .and_then(Value::as_bool)
                    .ok_or(InvokeError::Unknown)?;
                ch.mute = muted;
                self.pipeline.set_mute(id.to_string(), muted);
                Ok(())
            }
            "setPfl" => {
                let enabled = args
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or(InvokeError::Unknown)?;
                ch.pfl = enabled;
                self.pipeline.set_pfl(id.to_string(), enabled);
                Ok(())
            }
            "setEq" => {
                let low = args.get("low").and_then(Value::as_f64).ok_or(InvokeError::Unknown)?;
                let mid = args.get("mid").and_then(Value::as_f64).ok_or(InvokeError::Unknown)?;
                let high = args.get("high").and_then(Value::as_f64).ok_or(InvokeError::Unknown)?;
                for (k, v) in [("eqLow", low), ("eqMid", mid), ("eqHigh", high)] {
                    proc_set(&mut ch.proc, k, &serde_json::json!(v));
                }
                self.pipeline.set_proc(id.to_string(), ch.proc);
                Ok(())
            }
            "setEqGain" => {
                let key = match args.get("band").and_then(Value::as_str) {
                    Some("low") => "eqLow",
                    Some("mid") => "eqMid",
                    Some("mid2") => "eqMid2",
                    Some("high") => "eqHigh",
                    _ => return Err(InvokeError::Unknown),
                };
                let g = args.get("gainDb").ok_or(InvokeError::Unknown)?;
                if !proc_set(&mut ch.proc, key, g) {
                    return Err(InvokeError::Unknown);
                }
                self.pipeline.set_proc(id.to_string(), ch.proc);
                Ok(())
            }
            "setEqBand" => {
                let (fk, wk) = match args.get("band").and_then(Value::as_str) {
                    Some("low") => ("eqLowFreq", "eqLowWidth"),
                    Some("mid") => ("eqMidFreq", "eqMidWidth"),
                    Some("mid2") => ("eqMid2Freq", "eqMid2Width"),
                    Some("high") => ("eqHighFreq", "eqHighWidth"),
                    _ => return Err(InvokeError::Unknown),
                };
                let freq = args.get("freq").ok_or(InvokeError::Unknown)?;
                let width = args.get("width").ok_or(InvokeError::Unknown)?;
                // Frequenz zuerst: die Bandbreite wird relativ zur neuen Frequenz in Q umgerechnet.
                if !proc_set(&mut ch.proc, fk, freq) || !proc_set(&mut ch.proc, wk, width) {
                    return Err(InvokeError::Unknown);
                }
                self.pipeline.set_proc(id.to_string(), ch.proc);
                Ok(())
            }
            "setEqHp" => {
                apply_args(&mut ch.proc, args, &[("enabled", "eqHpEnabled"), ("freq", "eqHpFreq")])?;
                self.pipeline.set_proc(id.to_string(), ch.proc);
                Ok(())
            }
            "setEqBypass" => {
                apply_args(&mut ch.proc, args, &[("bypass", "eqBypass")])?;
                self.pipeline.set_proc(id.to_string(), ch.proc);
                Ok(())
            }
            // Kompressor/Gate: nicht übergebene (optionale) Argumente behalten
            // ihren bisherigen Wert — Altaufrufer kennen nur die ersten vier.
            "setComp" => {
                apply_args(
                    &mut ch.proc,
                    args,
                    &[
                        ("enabled", "compEnabled"),
                        ("thresholdDb", "compThreshold"),
                        ("ratio", "compRatio"),
                        ("makeupDb", "compMakeup"),
                        ("attackMs", "compAttack"),
                        ("releaseMs", "compRelease"),
                        ("kneeDb", "compKnee"),
                        ("rms", "compRms"),
                    ],
                )?;
                self.pipeline.set_proc(id.to_string(), ch.proc);
                Ok(())
            }
            "setGate" => {
                apply_args(
                    &mut ch.proc,
                    args,
                    &[
                        ("enabled", "gateEnabled"),
                        ("thresholdDb", "gateThreshold"),
                        ("rangeDb", "gateRange"),
                        ("ratio", "gateRatio"),
                        ("attackMs", "gateAttack"),
                        ("holdMs", "gateHold"),
                        ("releaseMs", "gateRelease"),
                        ("hysteresisDb", "gateHysteresis"),
                    ],
                )?;
                self.pipeline.set_proc(id.to_string(), ch.proc);
                Ok(())
            }
            "setDelay" => {
                apply_args(&mut ch.proc, args, &[("enabled", "delayEnabled"), ("ms", "delayMs")])?;
                self.pipeline.set_proc(id.to_string(), ch.proc);
                Ok(())
            }
            "setPhase" => {
                apply_args(&mut ch.proc, args, &[("invert", "phaseInvert")])?;
                self.pipeline.set_proc(id.to_string(), ch.proc);
                Ok(())
            }
            "setLabel" => {
                let l = args.get("label").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or(InvokeError::Unknown)?;
                ch.label = l.to_string();
                Ok(())
            }
            "setPan" => {
                apply_args(&mut ch.proc, args, &[("pan", "pan")])?;
                self.pipeline.set_proc(id.to_string(), ch.proc);
                Ok(())
            }
            "setMainRoute" => {
                ch.main_route = args.get("routed").and_then(Value::as_bool).ok_or(InvokeError::Unknown)?;
                Ok(())
            }
            "setAutomation" => {
                let mut a = ch.automation.clone();
                if let Some(v) = args.get("enabled") {
                    a.enabled = v.as_bool().ok_or(InvokeError::Unknown)?;
                }
                if let Some(v) = args.get("target") {
                    a.target = v.as_str().ok_or(InvokeError::Unknown)?.to_string();
                }
                if let Some(v) = args.get("rules") {
                    // Regeln als JSON-Text (Methodenargumente sind skalar).
                    let text = v.as_str().ok_or(InvokeError::Unknown)?;
                    let parsed: Value = serde_json::from_str(text).map_err(|_| InvokeError::Unknown)?;
                    a.rules = ChannelAutomation::from_json(&serde_json::json!({ "rules": parsed })).rules;
                }
                ch.automation = a;
                Ok(())
            }
            "setSend" => {
                let aux_id = args.get("auxId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let aux = self
                    .aux
                    .lock()
                    .expect("lock poisoned")
                    .iter()
                    .find(|a| a.id == aux_id && a.active)
                    .cloned()
                    .ok_or(InvokeError::Unknown)?;
                if aux.kind == "n1" && aux.exclude == ch.id {
                    return Err(InvokeError::Unknown); // N-1: eigener Kanal gesperrt
                }
                let cur = effective_send(ch, &aux);
                let mut s = SendState { enabled: cur.0, level_db: cur.1, post: cur.2 };
                if let Some(v) = args.get("enabled") {
                    s.enabled = v.as_bool().ok_or(InvokeError::Unknown)?;
                }
                if let Some(v) = args.get("levelDb") {
                    s.level_db = v.as_f64().ok_or(InvokeError::Unknown)?.clamp(-60.0, 12.0);
                }
                if let Some(v) = args.get("post") {
                    s.post = v.as_bool().ok_or(InvokeError::Unknown)?;
                }
                ch.sends.insert(aux_id.to_string(), s);
                Ok(())
            }
            "setGroup" => {
                let gid = args.get("groupId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                if !gid.is_empty() && !self.groups.lock().expect("lock poisoned").iter().any(|g| g.id == gid) {
                    return Err(InvokeError::Unknown);
                }
                ch.group = gid.to_string();
                Ok(())
            }
            "setAutoMix" => {
                let get_f = |k: &str, cur: f64, lo: f64, hi: f64| -> Result<f64, InvokeError> {
                    match args.get(k) {
                        None => Ok(cur),
                        Some(v) => v.as_f64().map(|x| x.clamp(lo, hi)).ok_or(InvokeError::Unknown),
                    }
                };
                if let Some(v) = args.get("enabled") {
                    ch.am_enabled = v.as_bool().ok_or(InvokeError::Unknown)?;
                }
                ch.am_weight = get_f("weight", ch.am_weight, 0.1, 4.0)?;
                ch.am_priority = get_f("priority", ch.am_priority as f64, 0.0, 2.0)?.round() as u8;
                ch.am_sensitivity_db = get_f("sensitivityDb", ch.am_sensitivity_db, -90.0, -10.0)?;
                Ok(())
            }
            "setManual" => {
                ch.manual = args.get("manual").and_then(Value::as_bool).ok_or(InvokeError::Unknown)?;
                Ok(())
            }
            "setDuckable" => {
                ch.duckable = args.get("enabled").and_then(Value::as_bool).ok_or(InvokeError::Unknown)?;
                Ok(())
            }
            "setSource" => {
                let sender_id = args
                    .get("senderId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                self.set_channel_source(ch, id, sender_id)?;
                // Handeingriff gegen die Auto-Zuordnung: bleibt bestehen, bis der Kontext
                // endet oder `resetRouting` ihn aufhebt (Automation überschreibt keinen Operator).
                let mut r = self.routing.lock().expect("lock poisoned");
                if r.active.as_ref().is_some_and(|a| a.overrides.contains_key(id)) || (r.active.is_some() && r.expects.contains_key(id)) {
                    r.pinned.insert(id.to_string());
                }
                Ok(())
            }
            "setFollow" => {
                let target = args
                    .get("targetNodeId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let mode = args
                    .get("mode")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                if !["off", "cut", "crossfade"].contains(&mode) {
                    return Err(InvokeError::Unknown);
                }
                ch.follow_target = target.to_string();
                ch.follow_mode = mode.to_string();
                Ok(())
            }
            "setOverride" => {
                let enabled = args
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or(InvokeError::Unknown)?;
                ch.override_enabled = enabled;
                Ok(())
            }
            "setFollowLevels" => {
                let use_mute = args
                    .get("useMute")
                    .and_then(Value::as_bool)
                    .ok_or(InvokeError::Unknown)?;
                let on_level_db = args
                    .get("onLevelDb")
                    .and_then(Value::as_f64)
                    .ok_or(InvokeError::Unknown)?;
                let off_level_db = args
                    .get("offLevelDb")
                    .and_then(Value::as_f64)
                    .ok_or(InvokeError::Unknown)?;
                let transition_ms = args
                    .get("transitionMs")
                    .and_then(Value::as_f64)
                    .ok_or(InvokeError::Unknown)?;
                if transition_ms < 0.0 {
                    return Err(InvokeError::Unknown);
                }
                ch.follow_use_mute = use_mute;
                ch.follow_on_level_db = on_level_db;
                ch.follow_off_level_db = off_level_db;
                ch.follow_transition_ms = transition_ms as u64;
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "AudioMixer");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9370").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let sender_id = omp_node_sdk::idgen::new_v4();
    let flow_id = omp_node_sdk::idgen::new_v4();
    // Solo/PFL-Monitor-Bus (Nutzerwunsch 2026-07-29) — zweiter,
    // eigenständiger MXL-Audio-Sender neben dem Programm-Ausgang, s.
    // `pipeline::build`.
    let monitor_sender_id = omp_node_sdk::idgen::new_v4();
    let monitor_flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    // Aux-Slots (Kapitel 26): feste Anzahl, per Umgebung änderbar.
    let aux_slot_count: usize = env_or("OMP_AUDIO_MIXER_AUX_SLOTS", "10").parse()?;
    let aux_states: Vec<AuxState> = (1..=aux_slot_count)
        .map(|n| AuxState {
            id: format!("a{n}"),
            sender_id: omp_node_sdk::idgen::new_v4(),
            flow_id: omp_node_sdk::idgen::new_v4(),
            label: format!("Aux a{n}"),
            active: false,
            kind: "aux".to_string(),
            exclude: String::new(),
            master_db: 0.0,
            muted: false,
            channels: 2,
            built_channels: 0,
            group: String::new(),
        })
        .collect();
    let pipeline_config = pipeline::Config {
        domain,
        flow_id: flow_id.clone(),
        label: label.clone(),
        monitor_flow_id: monitor_flow_id.clone(),
        aux_slots: aux_states.iter().map(|a| (a.id.clone(), a.flow_id.clone(), format!("{label} {}", a.label))).collect(),
    };
    let (sender_changes_tx, mut sender_changes_rx) = tokio::sync::mpsc::unbounded_channel::<SenderChange>();
    let own_sender_ids: Vec<String> = [sender_id.clone(), monitor_sender_id.clone()]
        .into_iter()
        .chain(aux_states.iter().map(|a| a.sender_id.clone()))
        .collect();
    let pipeline_shutdown = shutdown.clone();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx, pipeline_heartbeat_thread)
    });

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-audio-mixer: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-audio-mixer: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let channels: Arc<Mutex<Vec<ChannelState>>> = Arc::new(Mutex::new(Vec::new()));
    let available_sources: Arc<Mutex<Vec<DiscoveredAudioSource>>> = Arc::new(Mutex::new(Vec::new()));

    // K4-Teil-1 Metering: eigener SSE-Port, Port 0 = vom OS zugewiesen
    // (mehrere gleichzeitig gestartete Audiomischer-Instanzen dürfen sich
    // sonst keinen festen Port teilen — gleiche Begründung wie
    // `OMP_VIEWER_PREVIEW_PORT`, C6/C8).
    let levels_port: u16 = env_or("OMP_AUDIO_MIXER_LEVELS_PORT", "0").parse()?;
    let levels_broadcaster = Arc::new(levels::Broadcaster::new());
    let levels_heartbeat = Arc::new(AtomicU64::new(0));
    let actual_levels_port = levels::spawn(
        &format!("0.0.0.0:{levels_port}"),
        levels_broadcaster.clone(),
        levels_heartbeat.clone(),
    )?;
    let levels_url = format!("http://{host}:{actual_levels_port}/levels");

    // Automations-Engine (AutoMix/Ducking, 10-ms-Takt, eigener Thread).
    let engine_cfg = engine::new_config_cell();
    let engine_heartbeat = Arc::new(AtomicU64::new(0));
    // Ereignisbus der Automation: Engine (Mute/Fader-Übergänge), Szenen, Video-Tally.
    let (rule_events_tx, rule_events_rx) = std::sync::mpsc::channel::<rules::Event>();
    let engine_thread = engine::spawn(
        engine_cfg.clone(),
        pipeline_handle.shared_map(),
        shutdown.clone(),
        engine_heartbeat.clone(),
        rule_events_tx.clone(),
    );
    // Media-Automation: Service-Token vom Orchestrator (wie omp-playout-automation).
    let orchestrator_url = env_or("OMP_ORCHESTRATOR_URL", "http://localhost:8000");
    let launch_secret = std::env::var("OMP_LAUNCH_SECRET").unwrap_or_default();
    let auth = media::OrchestratorAuth::default();
    let token_instance = instance_id.clone();
    if let (Some(id), false) = (token_instance.as_deref(), launch_secret.is_empty()) {
        match media::fetch_service_token(&orchestrator_url, id, &launch_secret) {
            Ok(t) => auth.set(t),
            Err(e) => eprintln!("omp-audio-mixer: initialer Service-Token-Abruf fehlgeschlagen: {e}"),
        }
    } else {
        eprintln!("omp-audio-mixer: OMP_INSTANCE_ID/OMP_LAUNCH_SECRET fehlen — Media-Automation bleibt wirkungslos");
    }
    let executor = Arc::new(media::MediaExecutor::new(
        RegistryClient::new(registry_url.clone()),
        orchestrator_url.clone(),
        auth.clone(),
    ));
    let media_status = executor.status.clone();
    let available_nodes: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let store_concrete = Arc::new(AudioMixerStore {
        channels: channels.clone(),
        available_sources: available_sources.clone(),
        next_seq: Arc::new(AtomicU64::new(1)),
        pipeline: pipeline_handle.clone(),
        levels_url,
        master_limiter: Mutex::new(dsp::CompParams::default()),
        groups: Mutex::new(Vec::new()),
        ducks: Mutex::new(Vec::new()),
        engine_cfg: engine_cfg.clone(),
        aux: Mutex::new(aux_states),
        sender_changes: sender_changes_tx,
        node_label: label.clone(),
        scenes: Mutex::new(Vec::new()),
        contexts: Mutex::new(Vec::new()),
        audio_ctx: Mutex::new(AudioContext::default()),
        events_tx: rule_events_tx,
        media_status,
        available_nodes: available_nodes.clone(),
        routing: Mutex::new(routing::RoutingState::default()),
    });
    let store: Arc<dyn ParamStore> = store_concrete.clone();

    // Automations-Worker: Ereignis → Regeln der Kanäle → Aktion → Ziel-Player.
    // Eigener Thread, damit ein träges Ziel weder Audio noch Engine bremst.
    let worker_channels = channels.clone();
    let worker_shutdown = shutdown.clone();
    let worker_heartbeat = Arc::new(AtomicU64::new(0));
    let worker_heartbeat_thread = worker_heartbeat.clone();
    let automation_thread = std::thread::spawn(move || {
        while !worker_shutdown.load(Ordering::Relaxed) {
            worker_heartbeat_thread.fetch_add(1, Ordering::Relaxed);
            let Ok(ev) = rule_events_rx.recv_timeout(Duration::from_millis(500)) else { continue };
            let jobs: Vec<(String, String, rules::Action)> = worker_channels
                .lock()
                .expect("lock poisoned")
                .iter()
                .flat_map(|c| {
                    c.automation
                        .actions_for(&c.id, &ev)
                        .into_iter()
                        .map(|a| (c.id.clone(), c.automation.target.clone(), a))
                        .collect::<Vec<_>>()
                })
                .collect();
            for (channel, target, action) in jobs {
                executor.run(&channel, &target, action, dsp::now_ms());
            }
        }
    });

    // Für die Discovery gebraucht (den eigenen Sender ausschließen) —
    // `sender_id` wird gleich in die `SenderSpec` verschoben, also vorher
    // klonen; `registry_url` ebenso, weil `NodeConfig` sie konsumiert.
    let own_sender_ids_for_discovery = own_sender_ids.clone();
    let node_label_for_discovery = label.clone();
    let discovery_registry_url = registry_url.clone();
    // `label` wird gleich per Shorthand-Feld in `NodeConfig` verschoben —
    // vorher klonen für den zweiten (Monitor-)Sender unten.
    let monitor_sender_label = format!("{label} Monitor");

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url: nats_url.clone(),
            senders: vec![
                SenderSpec {
                    id: Some(sender_id),
                    transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
                    flow: Some(omp_node_sdk::node::FlowSpec::Audio {
                        id: Some(flow_id),
                        sample_rate_numerator: pipeline::SAMPLE_RATE,
                        channel_count: pipeline::CHANNELS,
                        media_type: "audio/float32".to_string(),
                        bit_depth: 32,
                        source_id: None,
                    }),
                    ..Default::default()
                },
                // Solo/PFL-Monitor-Bus (Nutzerwunsch 2026-07-29) — zweiter
                // Sender, per Drag & Drop z. B. an `omp-audio-monitor`
                // anschließbar wie jeder andere MXL-Audio-Sender auch.
                SenderSpec {
                    id: Some(monitor_sender_id),
                    label: Some(monitor_sender_label),
                    transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
                    flow: Some(omp_node_sdk::node::FlowSpec::Audio {
                        id: Some(monitor_flow_id),
                        sample_rate_numerator: pipeline::SAMPLE_RATE,
                        channel_count: pipeline::CHANNELS,
                        media_type: "audio/float32".to_string(),
                        bit_depth: 32,
                        source_id: None,
                    }),
                    ..Default::default()
                },
            ],
            receivers: vec![],
            instance_id,
            // "media-ready" über PipelineHandle::media_ready()
            // (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2).
            media_ready: {
                let pipeline = pipeline_handle.clone();
                omp_node_sdk::MediaReadySource::Probe(Arc::new(move || pipeline.media_ready()))
            },
        },
        store,
    )
    .await?;

    // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
    // Nachtrag 130-133).
    handle.register_worker("pipeline", pipeline_heartbeat);
    handle.register_worker("levels-accept", levels_heartbeat);
    handle.register_worker("automation-engine", engine_heartbeat);
    handle.register_worker("media-automation", worker_heartbeat);

    let follow_video = audio_follow_video_loop(nats_url, channels, pipeline_handle, store_concrete.clone());
    let discovery = discovery_loop(
        discovery_registry_url,
        own_sender_ids_for_discovery,
        available_sources,
        available_nodes,
        node_label_for_discovery,
    );
    let routing_poll = routing_loop(store_concrete.clone(), orchestrator_url.clone(), auth.clone());
    let token_refresh = token_refresh_loop(orchestrator_url, token_instance, launch_secret, auth);

    let sender_worker = async {
        while let Some(change) = sender_changes_rx.recv().await {
            let result = match change {
                SenderChange::Add { sender_id, flow_id, label, channels, tags } => handle
                    .add_sender(SenderSpec {
                        id: Some(sender_id),
                        transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
                        flow: Some(omp_node_sdk::node::FlowSpec::Audio {
                            id: Some(flow_id),
                            sample_rate_numerator: pipeline::SAMPLE_RATE,
                            channel_count: channels,
                            media_type: "audio/float32".to_string(),
                            bit_depth: 32,
                            source_id: None,
                        }),
                        label: Some(label),
                        tags: if tags.is_empty() {
                            Default::default()
                        } else {
                            std::collections::HashMap::from([("urn:x-omp:tags".to_string(), tags)])
                        },
                        ..Default::default()
                    })
                    .await
                    .map(|_| ()),
                SenderChange::Remove { sender_id } => handle.remove_sender(&sender_id).await,
            };
            if let Err(e) = result {
                eprintln!("omp-audio-mixer: Aux-Sender-Änderung fehlgeschlagen: {e}");
                handle.publish_alert(format!("Aux-Sender-Änderung fehlgeschlagen: {e}")).await;
            }
        }
    };

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-audio-mixer: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
                pipeline::Event::Level { channel_id, rms, peak } => {
                    let json = serde_json::json!({
                        "channelId": channel_id,
                        "rms": rms,
                        "peak": peak,
                    })
                    .to_string();
                    levels_broadcaster.publish(&json);
                }
                pipeline::Event::Dsp { channel_id, comp_gr_db, gate_gr_db, auto_db, duck_db, in_db, on_air } => {
                    let json = serde_json::json!({
                        "type": "dsp", "channelId": channel_id,
                        "compGr": comp_gr_db, "gateGr": gate_gr_db,
                        "autoDb": auto_db, "duckDb": duck_db, "inDb": in_db, "onAir": on_air,
                    })
                    .to_string();
                    levels_broadcaster.publish(&json);
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-audio-mixer: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-audio-mixer: pipeline thread ended");
        }
        _ = follow_video => {
            eprintln!("omp-audio-mixer: audio-follow-video loop ended");
        }
        _ = discovery => {
            eprintln!("omp-audio-mixer: discovery loop ended");
        }
        _ = sender_worker => {
            eprintln!("omp-audio-mixer: sender worker ended");
        }
        _ = routing_poll => {
            eprintln!("omp-audio-mixer: routing loop ended");
        }
        _ = token_refresh => {
            eprintln!("omp-audio-mixer: token refresh ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();
    let _ = engine_thread.join();
    let _ = automation_thread.join();

    Ok(())
}

/// Audio-Follow-Video (`UMSETZUNG.md` C11, `ARCHITECTURE.md` §13.2):
/// abonniert den Tally-Bus, den `omp-video-mixer-me` (C10) bei jedem
/// Crosspoint-Wechsel bespielt, und schaltet passend konfigurierte Kanäle
/// automatisch stumm/auf — kein neuer Sync-Mechanismus, derselbe Bus, der
/// im Flow-Editor schon Kacheln rot färbt (B4).
async fn audio_follow_video_loop(
    nats_url: String,
    channels: Arc<Mutex<Vec<ChannelState>>>,
    pipeline: PipelineHandle,
    store: Arc<AudioMixerStore>,
) {
    let mut subscription = match health::subscribe_tally(&nats_url, &health::NatsTlsConfig::from_env()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("omp-audio-mixer: tally subscribe failed, Audio-Follow-Video inaktiv: {e}");
            return;
        }
    };

    // Pro Kanal höchstens eine laufende Crossfade-Rampe — verhindert,
    // dass zwei schnell aufeinanderfolgende Tally-Wechsel um denselben
    // Kanal konkurrieren (gleiche Nebenläufigkeits-Vorsicht wie C10s
    // `fading`-Sperre, hier pro Kanal statt global).
    let ramp_generation: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));

    while let Some((node_id, on)) = subscription.next().await {
        // Video→Audio-Kontext (Kapitel 26): Quelle aktiv → Audio-Szene und
        // Automations-Ereignisse. Läuft zusätzlich zum bestehenden
        // Audio-Follow-Video (Mute/Crossfade je Kanal) und ersetzt es nicht.
        store.on_video_tally(&node_id, on);
        let matches: Vec<(String, String, bool, f64, f64, u64)> = {
            let channels = channels.lock().expect("lock poisoned");
            channels
                .iter()
                .filter(|c| {
                    !c.override_enabled && c.follow_mode != "off" && c.follow_target == node_id
                })
                .map(|c| {
                    (
                        c.id.clone(),
                        c.follow_mode.clone(),
                        c.follow_use_mute,
                        c.follow_on_level_db,
                        c.follow_off_level_db,
                        c.follow_transition_ms,
                    )
                })
                .collect()
        };

        for (channel_id, follow_mode, follow_use_mute, follow_on_level_db, follow_off_level_db, follow_transition_ms) in matches {
            if follow_mode == "cut" {
                if follow_use_mute {
                    // Unverändertes Verhalten vor §4.6 Punkt 3: echte
                    // Stille über den GStreamer-`mute`-Pad, Gain bleibt
                    // unangetastet (der reguläre Fader bleibt maßgeblich).
                    let target_mute = !on;
                    {
                        let mut channels = channels.lock().expect("lock poisoned");
                        if let Some(ch) = channels.iter_mut().find(|c| c.id == channel_id) {
                            ch.mute = target_mute;
                        }
                    }
                    pipeline.set_mute(channel_id.clone(), target_mute);
                } else {
                    // Hörbarer "Aus"-Zustand: AFV übernimmt den Gain
                    // eigenständig (der reguläre Fader wird ignoriert,
                    // s. ChannelState::follow_use_mute-Doku), nie
                    // stummschalten.
                    pipeline.set_mute(channel_id.clone(), false);
                    pipeline.set_gain(
                        channel_id.clone(),
                        if on { follow_on_level_db } else { follow_off_level_db },
                    );
                }
                continue;
            }

            // "crossfade": Gain über die Transition-Zeit rampen statt hart
            // stummschalten — sanfteres Auf-/Abblenden beim Kamera-
            // /Quellwechsel. Läuft als eigener Tokio-Task (nur
            // Command-Sends, kein direkter GStreamer-Objektzugriff nötig
            // wie bei C10s Thread-Rampe, deshalb hier async statt
            // `std::thread`).
            let generation = {
                let mut gens = ramp_generation.lock().expect("lock poisoned");
                let g = gens.entry(channel_id.clone()).or_insert(0);
                *g += 1;
                *g
            };
            let pipeline = pipeline.clone();
            let channels = channels.clone();
            let ramp_generation = ramp_generation.clone();
            let channel_id_task = channel_id.clone();
            tokio::spawn(async move {
                // §4.6 Nachtrag Punkt 3: bei `follow_use_mute == false`
                // rampt die Rampe zwischen den eigenständigen AFV-Pegeln
                // (`follow_on_level_db`/`follow_off_level_db`) statt
                // zwischen Mute und dem regulären Kanal-Fader — `mute`
                // bleibt in dem Fall durchgehend `false`. Bei
                // `follow_use_mute == true` unverändertes Verhalten vor
                // diesem Schritt: Rampe zwischen -60dB und dem aktuellen
                // Fader (`gain_db`), feste `FOLLOW_CROSSFADE_MS`-Dauer.
                let (from, to, duration_ms) = if follow_use_mute {
                    let base_db = {
                        let ch = channels.lock().expect("lock poisoned");
                        ch.iter()
                            .find(|c| c.id == channel_id_task)
                            .map(|c| c.gain_db)
                            .unwrap_or(0.0)
                    };
                    pipeline.set_mute(channel_id_task.clone(), false);
                    (if on { -60.0 } else { base_db }, if on { base_db } else { -60.0 }, FOLLOW_CROSSFADE_MS)
                } else {
                    (
                        if on { follow_off_level_db } else { follow_on_level_db },
                        if on { follow_on_level_db } else { follow_off_level_db },
                        follow_transition_ms,
                    )
                };
                for step in 1..=FOLLOW_CROSSFADE_STEPS {
                    if *ramp_generation
                        .lock()
                        .expect("lock poisoned")
                        .get(&channel_id_task)
                        .unwrap_or(&0)
                        != generation
                    {
                        return; // von einer neueren Rampe überholt
                    }
                    let t = step as f64 / FOLLOW_CROSSFADE_STEPS as f64;
                    pipeline.set_gain(channel_id_task.clone(), from + (to - from) * t);
                    tokio::time::sleep(tokio::time::Duration::from_millis(
                        duration_ms / FOLLOW_CROSSFADE_STEPS,
                    ))
                    .await;
                }
                if follow_use_mute && !on {
                    pipeline.set_mute(channel_id_task, true);
                }
            });
        }
    }
}

/// Pollt alle 2s die IS-04-Query-API nach MXL-Audio-Sendern (gleicher
/// Poll-Stil wie `omp-switcher`/`omp-video-mixer-me`, C7/C10) — Grundlage
/// für `channel.<id>.setSource`, damit ein Kanal auf einen echten
/// externen MXL-Audio-Flow umschalten kann statt nur auf den internen
/// Testton. Filtert zusätzlich auf `format==audio`
/// (`RegistryClient::get_flow_format`, dieselbe Notwendigkeit, die C10/C7
/// erst nach Einführung dieses Nodes traf, s. `docs/decisions.md`
/// 2026-07-11) — sonst würde ein Video-Sender fälschlich als wählbare
/// Audioquelle auftauchen.
/// Erneuert das Service-Token regelmäßig (TTL im Orchestrator 24 h).
async fn token_refresh_loop(
    orchestrator_url: String,
    instance_id: Option<String>,
    launch_secret: String,
    auth: media::OrchestratorAuth,
) {
    let Some(id) = instance_id.filter(|_| !launch_secret.is_empty()) else {
        std::future::pending::<()>().await;
        return;
    };
    let mut interval = tokio::time::interval(Duration::from_secs(3600));
    interval.tick().await;
    loop {
        interval.tick().await;
        let (url, id, secret) = (orchestrator_url.clone(), id.clone(), launch_secret.clone());
        match tokio::task::spawn_blocking(move || media::fetch_service_token(&url, &id, &secret)).await {
            Ok(Ok(token)) => auth.set(token),
            Ok(Err(e)) => eprintln!("omp-audio-mixer: Service-Token-Refresh fehlgeschlagen: {e}"),
            Err(e) => eprintln!("omp-audio-mixer: Service-Token-Refresh-Task abgestürzt: {e}"),
        }
    }
}

/// P6: holt alle 2 s die Audio-Quellen samt Tags vom Orchestrator
/// (`GET /api/v1/sources`, Service-Token) und plant bei Änderung neu. Ohne Token
/// oder bei Fehlern bleibt die letzte bekannte Liste stehen — das Routing ändert
/// dann nichts (Fail-Safe), nur ein Neustart des Kontexts würde es anstoßen.
async fn routing_loop(store: Arc<AudioMixerStore>, orchestrator_url: String, auth: media::OrchestratorAuth) {
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    loop {
        interval.tick().await;
        let Some(header) = auth.header() else { continue };
        let url = format!("{}/api/v1/sources?mediaType=audio", orchestrator_url.trim_end_matches('/'));
        let fetched = tokio::task::spawn_blocking(move || -> Result<Vec<omp_resolver::Source>, String> {
            ureq::get(&url)
                .config()
                .timeout_global(Some(Duration::from_secs(4)))
                .build()
                .header("Authorization", &header)
                .call()
                .map_err(|e| e.to_string())?
                .body_mut()
                .read_json()
                .map_err(|e| e.to_string())
        })
        .await;
        let Ok(Ok(list)) = fetched else { continue };
        // Auch ohne Änderung neu planen: die IS-04-Discovery des Mixers (`available_sources`)
        // kann hinter dem Orchestrator herhinken, ein erster Versuch also scheitern.
        let active = {
            let mut r = store.routing.lock().expect("lock poisoned");
            if r.sources != list {
                r.sources = list;
            }
            r.sources_at_ms = dsp::now_ms();
            r.active.is_some()
        };
        if active {
            let st = store.clone();
            let _ = tokio::task::spawn_blocking(move || st.reapply_routing()).await;
        }
    }
}

async fn discovery_loop(
    registry_url: String,
    own_sender_ids: Vec<String>,
    sources: Arc<Mutex<Vec<DiscoveredAudioSource>>>,
    nodes: Arc<Mutex<Vec<String>>>,
    own_label: String,
) {
    let registry = RegistryClient::new(registry_url);
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    loop {
        interval.tick().await;
        let registry_for_sources = registry.clone();
        let own_sender_ids = own_sender_ids.clone();
        let result = tokio::task::spawn_blocking(
            move || -> Result<Vec<DiscoveredAudioSource>, String> {
                let registry = registry_for_sources;
                let senders = registry.list_senders().map_err(|e| e.to_string())?;
                Ok(senders
                    .into_iter()
                    .filter(|s| s.transport == TRANSPORT_MXL && !own_sender_ids.contains(&s.id))
                    .filter_map(|s| s.flow_id.map(|flow_id| (s.id, s.label, flow_id)))
                    .filter(|(_, _, flow_id)| {
                        matches!(registry.get_flow_format(flow_id), Ok(format) if format == is04::FORMAT_AUDIO)
                    })
                    .map(|(sender_id, label, flow_id)| DiscoveredAudioSource {
                        sender_id,
                        label,
                        flow_id,
                    })
                    .collect())
            },
        )
        .await;

        // Node-Labels für die Auswahl der Media-Ziele (best effort).
        let reg = registry.clone();
        let own = own_label.clone();
        if let Ok(Ok(mut labels)) = tokio::task::spawn_blocking(move || {
            reg.list_nodes().map(|n| n.into_iter().map(|n| n.label).filter(|l| *l != own).collect::<Vec<_>>())
        })
        .await
        {
            labels.sort();
            *nodes.lock().expect("lock poisoned") = labels;
        }

        match result {
            Ok(Ok(discovered)) => {
                *sources.lock().expect("lock poisoned") = discovered;
            }
            Ok(Err(e)) => eprintln!("omp-audio-mixer: discovery poll failed: {e}"),
            Err(e) => eprintln!("omp-audio-mixer: discovery poll task panicked: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aux(kind: &str, exclude: &str, active: bool) -> AuxState {
        AuxState {
            id: "a1".into(),
            sender_id: "s".into(),
            flow_id: "f".into(),
            label: "A".into(),
            active,
            kind: kind.into(),
            exclude: exclude.into(),
            master_db: 0.0,
            muted: false,
            channels: 2,
            built_channels: 0,
            group: String::new(),
        }
    }

    #[test]
    fn group_bus_layout_tags_and_sanitizing() {
        assert_eq!(layout_channels("5.1"), Some(6));
        assert_eq!(layout_channels("dolby-e"), None);
        assert_eq!(channels_layout(8), "7.1");
        assert_eq!(sanitize_group("  PT Main! "), "pt-main");
        let mut a = aux("group", "", true);
        a.group = "pt".into();
        a.channels = 6;
        assert_eq!(bus_sender_tags(&a), vec!["role.pt", "layout.5.1"]);
        assert!(bus_sender_tags(&aux("aux", "", true)).is_empty());
    }

    fn ch(id: &str) -> ChannelState {
        ChannelState::new(id.into(), id.into(), 220.0)
    }

    #[test]
    fn plain_aux_sends_default_off_and_follow_explicit_settings() {
        let a = aux("aux", "", true);
        let mut c = ch("ch1");
        assert!(!effective_send(&c, &a).0, "ohne Einstellung kein Send");
        c.sends.insert("a1".into(), SendState { enabled: true, level_db: -6.0, post: false });
        let (en, lvl, post, locked) = effective_send(&c, &a);
        assert!(en && lvl == -6.0 && !post && !locked, "Pre-Fader-Send mit Pegel");
    }

    #[test]
    fn inactive_aux_never_sends() {
        let a = aux("aux", "", false);
        let mut c = ch("ch1");
        c.sends.insert("a1".into(), SendState { enabled: true, level_db: 0.0, post: true });
        assert!(!effective_send(&c, &a).0);
    }

    #[test]
    fn n1_includes_everyone_post_fader_except_the_excluded_channel() {
        let a = aux("n1", "ch1", true);
        let commentator = ch("ch1");
        let other = ch("ch2");
        // Alle anderen laufen automatisch post-Fader mit 0 dB auf den Bus …
        let (en, lvl, post, locked) = effective_send(&other, &a);
        assert!(en && lvl == 0.0 && post && !locked);
        // … der Kommentator strukturell nicht: ausgeschaltet UND gesperrt.
        let (en, _, _, locked) = effective_send(&commentator, &a);
        assert!(!en && locked, "N-1: eigenes Signal ist nicht enthalten und nicht schaltbar");
    }

    #[test]
    fn n1_excluded_channel_cannot_be_enabled_by_stored_send() {
        let a = aux("n1", "ch1", true);
        let mut c = ch("ch1");
        // Selbst ein (z. B. aus einem alten Preset stammender) Send-Eintrag ändert nichts.
        c.sends.insert("a1".into(), SendState { enabled: true, level_db: 0.0, post: true });
        assert!(!effective_send(&c, &a).0);
    }

    #[test]
    fn n1_other_channels_can_be_trimmed_or_removed_from_the_mix() {
        let a = aux("n1", "ch1", true);
        let mut c = ch("ch2");
        c.sends.insert("a1".into(), SendState { enabled: true, level_db: -10.0, post: true });
        assert_eq!(effective_send(&c, &a).1, -10.0);
        c.sends.insert("a1".into(), SendState { enabled: false, level_db: 0.0, post: true });
        assert!(!effective_send(&c, &a).0);
    }

    #[test]
    fn proc_param_table_roundtrips_and_clamps() {
        let mut p = dsp::ProcParams::default();
        assert!(proc_set(&mut p, "pan", &serde_json::json!(5.0)));
        assert_eq!(p.pan, 1.0, "Bereichsbegrenzung");
        assert!(proc_set(&mut p, "delayMs", &serde_json::json!(250)));
        assert!(proc_set(&mut p, "delayEnabled", &serde_json::json!(true)));
        assert!(proc_set(&mut p, "eqMidFreq", &serde_json::json!(2000)));
        assert!(proc_set(&mut p, "eqMidWidth", &serde_json::json!(1000)));
        assert!(!proc_set(&mut p, "pan", &serde_json::json!("links")), "falscher Typ");
        assert!(!proc_set(&mut p, "nope", &serde_json::json!(1)));
        let mut doc = serde_json::Map::new();
        proc_to_json(&p, &mut doc);
        let back = proc_from_json(dsp::ProcParams::default(), &Value::Object(doc));
        assert_eq!(back, p);
        // Alt-Preset ohne neue Felder → Defaults bleiben.
        let old = proc_from_json(dsp::ProcParams::default(), &serde_json::json!({"eqLow": 3.0, "compEnabled": true}));
        assert_eq!(old.eq.bands[0].gain_db, 3.0);
        assert!(old.comp.enabled);
        assert_eq!(old.pan, 0.0);
        assert!(!old.gate.enabled);
    }
}
