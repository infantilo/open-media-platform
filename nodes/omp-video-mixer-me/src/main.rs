//! omp-video-mixer-me: erster §13.1-Referenzknoten (`UMSETZUNG.md` C10) —
//! ein M/E-Bank-Prozess mit Crosspoint (Program-/Preset-Bus, Take/Cut/
//! AutoTrans), einem DVE-Kanal und einem Keyer als `NcWorker`-Members
//! desselben `NcBlock` (§11.1/§13.1-Methodik), nicht als separate
//! MXL-verkettete Nodes. Baut auf `omp-switcher`s (C7) IS-04-Discovery-
//! Muster auf, erweitert um Sender→Device→Node-Auflösung fürs
//! Tally-Event.
//!
//! **Deskriptor-Namensraum:** Das v0-Descriptor-Schema
//! (`docs/descriptor-v0.schema.json`) kennt keine `NcBlock`/`NcWorker`-
//! Verschachtelung (nur eine flache Parameter-/Methodenliste je Node,
//! siehe `omp-node-sdk/src/descriptor.rs`) — die drei `NcWorker` aus der
//! §13.1-Skizze (`Crosspoint`, `DveChannel`, `Keyer`) werden deshalb per
//! Namenskonvention `<worker>.<name>` abgebildet (`crosspoint.select`,
//! `dve.setBox`, `keyer.setEnabled`, …), keine Protokollerweiterung.
//! `StillStore` (§13.1) ist nicht Teil dieses Minimalausbaus (C10-Text:
//! „hier nur so viel, dass Take/Cut/AutoTrans/… vorführbar sind").
//!
//! **MS-05-02 gegen Standardklassen geprüft (`UMSETZUNG.md` §0 Punkt 6,
//! 2026-07-11 recherchiert):** Der MS-05-02-Kernstandard definiert nur
//! das Metamodell (`NcObject`/`NcBlock`/`NcWorker`/`NcManager` + Methoden-
//! /Property-Framework), keine konkreten Domänenklassen; das dafür
//! vorgesehene Folgedokument MS-05-03 „Control Block Specs" ist Stand
//! Juli 2026 „Work In Progress" ohne veröffentlichte Crosspoint-/DVE-/
//! Keyer-Blockspecs. Eigene Klassen für `Crosspoint`/`DveChannel`/`Keyer`
//! sind damit nach §11.1 Punkt 3 („Custom-Klassen nur für das
//! domänen-Eigene") korrekt, kein Standard wird dupliziert.

mod pipeline;
mod uibundle;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_node_sdk::is04;
use omp_node_sdk::is04::{RegistryClient, Sender, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, LatencyInfo, LatencyRange, MethodArg, MethodSpec, NodeConfig,
    ParamSpec, ParamStore, ParamType, RawResponse, SenderSpec, SetError,
};
use pipeline::{DEFAULT_TRANS_RATE_FRAMES, DiscoveredInput, DiscoveredKeyFill, DveBox};
use serde_json::Value;

/// Kapitel 15 Teil 3 (Rest 2, docs/END-GOAL-FEATURES.md §15.3b/§15.4):
/// identisch zu `omp-switcher::GROUPHINT_TAG`/`omp-multiviewer`, bewusst
/// dupliziert (jeder Node ein eigenständiges Binary, s. dortige Doku).
const GROUPHINT_TAG: &str = "urn:x-nmos:tag:grouphint/v1.0";

/// Ein `MixerStore`-Feld je M/E-Ebene (Nutzerwunsch 2026-08-14: "dynamische
/// Anzahl an Mischerebenen... jede mit eigenem Output") — Länge =
/// `level_count`, Index = 0-basierter Ebenen-Index (`level_name`/
/// `parse_level` rechnen dagegen mit 1-basierten Namen `level1.…`,
/// `level2.…`). Länge 1 entspricht exakt dem Vor-Ebenen-Verhalten (Feld
/// enthält dann genau einen Eintrag, `descriptor()`/`get()`/`invoke()`
/// nutzen dafür weiterhin den unpräfigierten Namen).
type PerLevel<T> = Vec<Arc<Mutex<T>>>;

struct MixerStore {
    /// Geteilter Quellen-Pool (Nutzerwunsch 2026-08-14: "teilen sich
    /// denselben Quellen-Pool") — EIN Eintrag für alle Ebenen, nicht
    /// `PerLevel`. Enthält seit dem Nachtrag 2026-08-14 ("Mastereben
    /// braucht feste Buttons für die Ausgänge der anderen Ebenen, wie bei
    /// einem Hardware-Bildmischer mit mehreren M/E-Bänken") AUCH die
    /// eigenen PGM-Ausgänge dieses Nodes — `discover()` schließt sie
    /// nicht mehr aus. Nur die Selbstreferenz EINER Ebene auf sich selbst
    /// bleibt gesperrt, gefiltert beim Lesen in `level_get`s
    /// "crosspoint.inputs"-Zweig per `sender_ids[level]`, s. dort.
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
    /// Eigene NMOS-Sender-IDs, ein Eintrag je Ebene (Index = Ebene,
    /// gleiche Reihenfolge wie bei der Registrierung in `main()`) — nur
    /// für die Selbstausschluss-Filterung in `level_get` gebraucht, s.
    /// `inputs`-Doku oben.
    sender_ids: Vec<String>,
    program: PerLevel<Option<String>>,
    preset: PerLevel<Option<String>>,
    dve_box: PerLevel<DveBox>,
    keyer_enabled: PerLevel<bool>,
    /// Geteilt wie `inputs` — dieselben Fill+Key-Kandidaten stehen jeder
    /// Ebene zur Auswahl.
    keyfill_inputs: Arc<Mutex<Vec<DiscoveredKeyFill>>>,
    keyer_source: PerLevel<Option<String>>,
    /// PIP-Layer (Nutzerwunsch 2026-07-22, s. `pipeline.rs`-Moduldoku
    /// "PIP als eigenständiger Layer") — gleiches Muster wie
    /// `keyer_enabled`/`keyer_source`.
    pip_enabled: PerLevel<bool>,
    pip_source: PerLevel<Option<String>>,
    /// Kuratierte Kreuzschiene (Nutzerwunsch 2026-07-22): welche
    /// entdeckten Quellen der Operator sich per "+" als dauerhafte PGM/
    /// PST-Tasten angelegt hat — bewusst getrennt von `inputs` (dem
    /// vollen Discovery-Satz, weiterhin die Grundlage für "+"s
    /// Auswahlliste). Reine Buchführung, keine Pipeline-Wirkung:
    /// `crosspoint.select`/`take` funktionieren unverändert mit jeder
    /// entdeckten `senderId`, unabhängig vom Pin-Status. Je Ebene
    /// unabhängig (Nutzerwunsch 2026-08-14: "jede wählt unabhängig
    /// PGM/PST/Keyer/PIP").
    pinned: PerLevel<Vec<String>>,
    /// `crosspoint.transRate` (Bug 4, vormals ausgegraut — s.
    /// `ui/bundle.js`-Moduldoku "K3-Teil-2"): Rampendauer für
    /// `crosspoint.autoTrans`, in Frames @25fps (6/12/25/50, s.
    /// `ui/bundle.js::RATES`). Nur Buchführung fürs `get()`, die
    /// eigentliche Umrechnung/Anwendung läuft über
    /// `pipeline::PipelineHandle::set_trans_rate`.
    trans_rate: PerLevel<i32>,
    pipeline: pipeline::PipelineHandle,
}

/// Anzahl M/E-Ebenen dieses `MixerStore` — jedes `PerLevel`-Feld hat
/// dieselbe Länge, `program` ist als Referenz beliebig.
fn level_count(store: &MixerStore) -> usize {
    store.program.len()
}

/// Param-/Methodenname für Ebene `level` (0-basiert): unpräfigiert bei
/// genau einer Ebene (Rückwärtskompatibilität — bestehende Presets/UI-
/// Aufrufe bleiben gültig), sonst `level<N>.`-präfigiert (1-basiert in
/// der öffentlichen Benennung, "level1" = erste Ebene).
fn level_name(level_count: usize, level: usize, base: &str) -> String {
    if level_count <= 1 {
        base.to_string()
    } else {
        format!("level{}.{base}", level + 1)
    }
}

/// Kehrrichtung zu `level_name`: zerlegt einen ankommenden Param-/
/// Methodennamen in (Ebenen-Index, Basisname). Bei `level_count <= 1`
/// wird `name` unverändert als Ebene 0 interpretiert (kein Präfix
/// erwartet). Liefert `None` bei einem unbekannten/außerhalb des
/// gültigen Bereichs liegenden Ebenen-Präfix, statt zu raten.
fn parse_level<'a>(name: &'a str, level_count: usize) -> Option<(usize, &'a str)> {
    if level_count <= 1 {
        return Some((0, name));
    }
    let rest = name.strip_prefix("level")?;
    let dot = rest.find('.')?;
    let level: usize = rest[..dot].parse().ok()?;
    if level == 0 || level > level_count {
        return None;
    }
    Some((level - 1, &rest[dot + 1..]))
}

fn json_number(args: &serde_json::Map<String, Value>, name: &str) -> Result<i32, InvokeError> {
    args.get(name)
        .and_then(Value::as_f64)
        .map(|v| v as i32)
        .ok_or(InvokeError::Unknown)
}

impl ParamStore for MixerStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            // D8 Teil 1 (UMSETZUNG.md, ARCHITECTURE.md §15.1 Punkt 1/4): live
            // per Kopf-Index/Wallclock-Skew-Verfahren gemessen (5 Samples
            // eines echten Testworkflows, `docs/decisions.md` Nachtrag zu D8
            // Teil 1). Anders als `omp-scaler` reicht der Mixer den MXL-
            // Origin-Index NICHT durch (Compositing kombiniert mehrere
            // Eingänge zu einem Ausgangs-Grain — nach Definition ein neuer
            // Ursprung, ARCHITECTURE.md §15.1 Punkt 4 letzter Absatz) —
            // gemessen wurde deshalb die eigene Kopfindex-Distanz zur
            // Wallclock, nicht die kumulierte Latenz gegenüber dem
            // Scaler-Eingang. Beobachtete Streuung 0-2 Grains (Queue-/
            // Compositor-Jitter, s. `docs/decisions.md` Nachtrag 63).
            // supportsDelayCompensation: true seit D8 Teil 3 (ARCHITECTURE.md
            // §15.1 Punkt 3) — `setOutputDelay(frames)` unten real
            // implementiert. Der Mixer setzt beim Compositing zwar einen
            // NEUEN Ursprung (s. o.), §15.1 Punkt 4 letzter Absatz definiert
            // "Ausgangs-Grain(N) = Eingangs-Grain(N) + D" für diesen Fall
            // gegenüber der Wallclock statt eines durchgereichten Origin-
            // Index — genau das rechnet `omp-mediaio::mxl::write_loop`s
            // Freilauf-Zähler-Zweig um.
            latency: Some(LatencyInfo {
                video: Some(LatencyRange { min_latency_frames: 0, max_latency_frames: 2 }),
                audio: None,
                data: None,
                supports_delay_compensation: true,
            }),
            parameters: (0..level_count(self))
                .flat_map(|level| level_param_specs(level_count(self), level))
                .collect(),
            methods: (0..level_count(self))
                .flat_map(|level| level_method_specs(level_count(self), level))
                // D8 Teil 3 (ARCHITECTURE.md §15.1 Punkt 3): vom
                // Orchestrator beim Start aufgerufen — bewusst NICHT
                // Ebenen-präfigiert (der Orchestrator ruft den festen
                // Namen `"setOutputDelay"` fest verdrahtet auf, s.
                // `orchestrator/internal/workflows/delayassignment.go`),
                // wirkt bei mehreren Ebenen nur auf Ebene 1 — Delay-
                // Kompensation je einzelner Ebene ist eine spätere
                // Erweiterung (Orchestrator müsste dafür Ebenen kennen).
                .chain(std::iter::once(MethodSpec {
                    name: "setOutputDelay".to_string(),
                    args: vec![MethodArg {
                        name: "frames".to_string(),
                        kind: ParamType::Number,
                    }],
                }))
                .collect(),
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        level_get(self, name)
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        level_invoke(self, name, args)
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if method == "GET" && path == "/state" {
            let payload = serde_json::to_vec(&serde_json::json!({ "state": self.capture_state() }))
                .unwrap_or_default();
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
            self.restore_state(&state);
            return Some(RawResponse { status: 200, content_type: "application/json", body: br#"{"ok":true}"#.to_vec() });
        }
        uibundle::route(method, path)
    }
}

/// Param-Deklarationen EINER M/E-Ebene, mit `level_name` auf diese Ebene
/// präfigiert — `descriptor()` ruft das `level_count`-mal auf (einmal je
/// Ebene) und hängt die Ergebnisse aneinander.
fn level_param_specs(level_count: usize, level: usize) -> Vec<ParamSpec> {
    let n = |base: &str| level_name(level_count, level, base);
    vec![
        // Wie bei omp-switcher (C7): "inputs" ist ein JSON-Array,
        // das v0-Schema kennt keinen Array-Typ — der Wert wird
        // trotzdem als solcher geliefert, gelesen vom eigenen
        // UI-Bundle (uibundle.rs), nicht vom generischen B6-Panel.
        ParamSpec {
            name: n("crosspoint.inputs"),
            kind: ParamType::String,
            unit: None,
            range: None,
            readonly: true,
        },
        ParamSpec {
            name: n("crosspoint.programInput"),
            kind: ParamType::String,
            unit: None,
            range: None,
            readonly: true,
        },
        ParamSpec {
            name: n("crosspoint.presetInput"),
            kind: ParamType::String,
            unit: None,
            range: None,
            readonly: true,
        },
        // JSON-Objekt {x,y,width,height}, gleiche Array-/Objekt-
        // Ausnahme wie "crosspoint.inputs".
        ParamSpec {
            name: n("dve.box"),
            kind: ParamType::String,
            unit: None,
            range: None,
            readonly: true,
        },
        ParamSpec {
            name: n("keyer.enabled"),
            kind: ParamType::Boolean,
            unit: None,
            range: None,
            readonly: true,
        },
        // Fill+Key-Senderpaare (`omp-ograf` o. Ä., s.
        // `pipeline::DiscoveredKeyFill`-Doku) — JSON-Array, gleiche
        // Array-Ausnahme wie "crosspoint.inputs".
        ParamSpec {
            name: n("keyer.inputs"),
            kind: ParamType::String,
            unit: None,
            range: None,
            readonly: true,
        },
        ParamSpec {
            name: n("keyer.source"),
            kind: ParamType::String,
            unit: None,
            range: None,
            readonly: true,
        },
        ParamSpec {
            name: n("pip.enabled"),
            kind: ParamType::Boolean,
            unit: None,
            range: None,
            readonly: true,
        },
        ParamSpec {
            name: n("pip.source"),
            kind: ParamType::String,
            unit: None,
            range: None,
            readonly: true,
        },
        // Kuratierte Kreuzschiene (Nutzerwunsch 2026-07-22): vom
        // Operator per "+" angepinnte `senderId`s — JSON-Array,
        // gleiche Array-Ausnahme wie "crosspoint.inputs".
        // Bug 4 (vormals "K3-Teil-2", s. `ui/bundle.js`-Moduldoku):
        // aktuelle Rampendauer für `crosspoint.autoTrans`, in
        // Frames @25fps — Mutation über die Methode
        // `crosspoint.setTransRate` unten, gleiche Konvention wie
        // die übrigen `readonly:true`-Parameter hier (s.
        // Modul-Doku zu MS-05-02/eigenen Klassen oben).
        ParamSpec {
            name: n("crosspoint.transRate"),
            kind: ParamType::Number,
            unit: Some("frames".to_string()),
            range: None,
            readonly: true,
        },
        ParamSpec {
            name: n("crosspoint.pinnedSenderIds"),
            kind: ParamType::String,
            unit: None,
            range: None,
            readonly: true,
        },
    ]
}

/// Methoden-Deklarationen EINER M/E-Ebene — s. `level_param_specs`-Doku.
fn level_method_specs(level_count: usize, level: usize) -> Vec<MethodSpec> {
    let n = |base: &str| level_name(level_count, level, base);
    vec![
        MethodSpec {
            name: n("crosspoint.select"),
            args: vec![MethodArg {
                name: "senderId".to_string(),
                kind: ParamType::String,
            }],
        },
        MethodSpec {
            name: n("crosspoint.cut"),
            args: vec![],
        },
        MethodSpec {
            name: n("crosspoint.take"),
            args: vec![MethodArg {
                name: "senderId".to_string(),
                kind: ParamType::String,
            }],
        },
        MethodSpec {
            name: n("crosspoint.autoTrans"),
            args: vec![],
        },
        MethodSpec {
            name: n("dve.setBox"),
            args: vec![
                MethodArg {
                    name: "x".to_string(),
                    kind: ParamType::Number,
                },
                MethodArg {
                    name: "y".to_string(),
                    kind: ParamType::Number,
                },
                MethodArg {
                    name: "width".to_string(),
                    kind: ParamType::Number,
                },
                MethodArg {
                    name: "height".to_string(),
                    kind: ParamType::Number,
                },
            ],
        },
        MethodSpec {
            name: n("dve.reset"),
            args: vec![],
        },
        MethodSpec {
            name: n("keyer.setEnabled"),
            args: vec![MethodArg {
                name: "enabled".to_string(),
                kind: ParamType::Boolean,
            }],
        },
        // Leerer String wählt die synthetische Test-Farbfläche
        // (Default) ab statt einer echten Fill+Key-Quelle, gleiche
        // Konvention wie "crosspoint.select"/"crosspoint.take".
        MethodSpec {
            name: n("keyer.setSource"),
            args: vec![MethodArg {
                name: "senderId".to_string(),
                kind: ParamType::String,
            }],
        },
        MethodSpec {
            name: n("pip.setEnabled"),
            args: vec![MethodArg {
                name: "enabled".to_string(),
                kind: ParamType::Boolean,
            }],
        },
        // Leerer String wählt Schwarz ab (kein PIP-Bild), gleiche
        // Konvention wie "keyer.setSource".
        MethodSpec {
            name: n("pip.setSource"),
            args: vec![MethodArg {
                name: "senderId".to_string(),
                kind: ParamType::String,
            }],
        },
        MethodSpec {
            name: n("crosspoint.pin"),
            args: vec![MethodArg {
                name: "senderId".to_string(),
                kind: ParamType::String,
            }],
        },
        MethodSpec {
            name: n("crosspoint.unpin"),
            args: vec![MethodArg {
                name: "senderId".to_string(),
                kind: ParamType::String,
            }],
        },
        // Bug 4: Rate-Wahl-Tasten in der UI (6f/12f/25f/50f, s.
        // `ui/bundle.js::RATES`) — Frames statt Millisekunden, um
        // dieselben Werte wie ein "echtes Pult" (PGM-Tasten-
        // Beschriftung, §3.3) zu zeigen.
        MethodSpec {
            name: n("crosspoint.setTransRate"),
            args: vec![MethodArg {
                name: "frames".to_string(),
                kind: ParamType::Number,
            }],
        },
    ]
}

/// `get()`-Implementierung: `name` per `parse_level` in (Ebene, Basisname)
/// zerlegt, dann exakt dieselbe Logik wie vor den M/E-Ebenen, nur je
/// Ebene indiziert. `inputs`/`keyfill_inputs` sind geteilt (kein Index
/// nötig) — jede Ebene liest denselben Wert.
fn level_get(store: &MixerStore, name: &str) -> Option<Value> {
    let (level, base) = parse_level(name, level_count(store))?;
    match base {
        "crosspoint.inputs" => {
            // Seit Nachtrag 2026-08-14 enthält der geteilte Pool auch die
            // eigenen PGM-Ausgänge dieses Nodes (s. `MixerStore::inputs`-
            // Doku) — nur die Selbstreferenz DIESER Ebene auf sich selbst
            // wird hier ausgefiltert, jede ANDERE Ebene bleibt sichtbar
            // (Mastereben kann so z. B. Ebene 2 als Quelle wählen).
            let own_id = &store.sender_ids[level];
            let inputs = store.inputs.lock().expect("lock poisoned");
            Some(serde_json::json!(
                inputs
                    .iter()
                    .filter(|i| &i.sender_id != own_id)
                    .map(|i| serde_json::json!({"senderId": i.sender_id, "label": i.label}))
                    .collect::<Vec<_>>()
            ))
        }
        "crosspoint.programInput" => Some(serde_json::json!(
            store.program[level].lock().expect("lock poisoned").clone().unwrap_or_default()
        )),
        "crosspoint.presetInput" => Some(serde_json::json!(
            store.preset[level].lock().expect("lock poisoned").clone().unwrap_or_default()
        )),
        "dve.box" => {
            let b = *store.dve_box[level].lock().expect("lock poisoned");
            Some(serde_json::json!({"x": b.x, "y": b.y, "width": b.width, "height": b.height}))
        }
        "keyer.enabled" => Some(serde_json::json!(
            *store.keyer_enabled[level].lock().expect("lock poisoned")
        )),
        "keyer.inputs" => {
            let inputs = store.keyfill_inputs.lock().expect("lock poisoned");
            Some(serde_json::json!(
                inputs
                    .iter()
                    .map(|k| serde_json::json!({
                        "senderId": k.fill_sender_id,
                        "label": k.label,
                        "deviceId": k.device_id,
                    }))
                    .collect::<Vec<_>>()
            ))
        }
        "keyer.source" => Some(serde_json::json!(
            store.keyer_source[level].lock().expect("lock poisoned").clone().unwrap_or_default()
        )),
        "pip.enabled" => Some(serde_json::json!(
            *store.pip_enabled[level].lock().expect("lock poisoned")
        )),
        "pip.source" => Some(serde_json::json!(
            store.pip_source[level].lock().expect("lock poisoned").clone().unwrap_or_default()
        )),
        "crosspoint.pinnedSenderIds" => Some(serde_json::json!(
            store.pinned[level].lock().expect("lock poisoned").clone()
        )),
        "crosspoint.transRate" => Some(serde_json::json!(
            *store.trans_rate[level].lock().expect("lock poisoned")
        )),
        _ => None,
    }
}

/// `invoke()`-Implementierung — s. `level_get`-Doku zur Level-Auflösung.
/// `setOutputDelay` bleibt bewusst UNPRÄFIGIERT (s. `descriptor()`-Doku)
/// und wirkt immer auf Ebene 0.
fn level_invoke(store: &MixerStore, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
    if name == "setOutputDelay" {
        let frames = args
            .get("frames")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(|v| v as u64)
            .ok_or(InvokeError::Unknown)?;
        store.pipeline.set_output_delay(0, frames);
        return Ok(());
    }
    let (level, base) = parse_level(name, level_count(store)).ok_or(InvokeError::Unknown)?;
    match base {
        "crosspoint.select" => {
            let sender_id = args
                .get("senderId")
                .and_then(Value::as_str)
                .ok_or(InvokeError::Unknown)?;
            let selected = if sender_id.is_empty() { None } else { Some(sender_id.to_string()) };
            store.pipeline.select_preset(level, selected);
            Ok(())
        }
        "crosspoint.cut" => {
            store.pipeline.cut(level);
            Ok(())
        }
        "crosspoint.take" => {
            let sender_id = args
                .get("senderId")
                .and_then(Value::as_str)
                .ok_or(InvokeError::Unknown)?;
            let selected = if sender_id.is_empty() { None } else { Some(sender_id.to_string()) };
            store.pipeline.take(level, selected);
            Ok(())
        }
        "crosspoint.autoTrans" => {
            store.pipeline.auto_trans(level);
            Ok(())
        }
        // Bug 4: Rate-Wahl-Tasten (6f/12f/25f/50f) — wirkt erst auf den
        // NÄCHSTEN `autoTrans()`, s. `PipelineHandle::set_trans_rate`-
        // Doku. Obergrenze 250 Frames (10s @25fps) ist eine reine
        // Plausibilitätsschranke, keine UI-/Standardvorgabe.
        "crosspoint.setTransRate" => {
            let frames = args
                .get("frames")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v >= 1.0 && *v <= 250.0)
                .map(|v| v as i32)
                .ok_or(InvokeError::Unknown)?;
            *store.trans_rate[level].lock().expect("lock poisoned") = frames;
            store.pipeline.set_trans_rate(level, frames as u32);
            Ok(())
        }
        "dve.setBox" => {
            let box_ = DveBox {
                x: json_number(args, "x")?,
                y: json_number(args, "y")?,
                width: json_number(args, "width")?,
                height: json_number(args, "height")?,
            };
            store.pipeline.set_dve_box(level, box_);
            Ok(())
        }
        "dve.reset" => {
            store.pipeline.reset_dve(level);
            Ok(())
        }
        "keyer.setEnabled" => {
            let enabled = args.get("enabled").and_then(Value::as_bool).ok_or(InvokeError::Unknown)?;
            store.pipeline.set_keyer_enabled(level, enabled);
            Ok(())
        }
        "keyer.setSource" => {
            let sender_id = args
                .get("senderId")
                .and_then(Value::as_str)
                .ok_or(InvokeError::Unknown)?;
            let selected = if sender_id.is_empty() { None } else { Some(sender_id.to_string()) };
            *store.keyer_source[level].lock().expect("lock poisoned") = selected.clone();
            store.pipeline.set_keyer_source(level, selected);
            Ok(())
        }
        "pip.setEnabled" => {
            let enabled = args.get("enabled").and_then(Value::as_bool).ok_or(InvokeError::Unknown)?;
            store.pipeline.set_pip_enabled(level, enabled);
            Ok(())
        }
        "pip.setSource" => {
            let sender_id = args
                .get("senderId")
                .and_then(Value::as_str)
                .ok_or(InvokeError::Unknown)?;
            let selected = if sender_id.is_empty() { None } else { Some(sender_id.to_string()) };
            *store.pip_source[level].lock().expect("lock poisoned") = selected.clone();
            store.pipeline.set_pip_source(level, selected);
            Ok(())
        }
        "crosspoint.pin" => {
            let sender_id = args
                .get("senderId")
                .and_then(Value::as_str)
                .ok_or(InvokeError::Unknown)?;
            let mut pinned = store.pinned[level].lock().expect("lock poisoned");
            if !pinned.iter().any(|s| s == sender_id) {
                pinned.push(sender_id.to_string());
            }
            Ok(())
        }
        "crosspoint.unpin" => {
            let sender_id = args
                .get("senderId")
                .and_then(Value::as_str)
                .ok_or(InvokeError::Unknown)?;
            store.pinned[level].lock().expect("lock poisoned").retain(|s| s != sender_id);
            Ok(())
        }
        _ => Err(InvokeError::Unknown),
    }
}

impl MixerStore {
    /// Node-eigener Vollzustand (§4.6 Punkt 4, `docs/END-GOAL-FEATURES.md`
    /// "Mixer-Presets", `docs/decisions.md` Nachtrag 40) hinter `GET
    /// /state` — dasselbe Node-Contract-Muster wie `omp-audio-mixer`
    /// (gleicher Grund: alle Parameter hier sind `readonly:true`, s.
    /// Modul-Doku oben zu MS-05-02/eigenen Klassen, Mutation läuft nur
    /// über `crosspoint.*`/`dve.*`/`keyer.*`-Methoden).
    /// Bei genau einer Ebene (Default) exakt das flache Vor-Ebenen-Schema
    /// (Rückwärtskompatibilität bestehender Presets); bei mehreren Ebenen
    /// (Nutzerwunsch 2026-08-14) ein `levels`-Array, ein Eintrag je
    /// Ebene, gleiches Schema wie bisher pro Eintrag.
    fn capture_state(&self) -> Value {
        if level_count(self) <= 1 {
            return self.capture_level_state(0);
        }
        serde_json::json!({ "levels": (0..level_count(self)).map(|l| self.capture_level_state(l)).collect::<Vec<_>>() })
    }

    fn capture_level_state(&self, level: usize) -> Value {
        let box_ = *self.dve_box[level].lock().expect("lock poisoned");
        serde_json::json!({
            "programSenderId": self.program[level].lock().expect("lock poisoned").clone(),
            "presetSenderId": self.preset[level].lock().expect("lock poisoned").clone(),
            "dveBox": {"x": box_.x, "y": box_.y, "width": box_.width, "height": box_.height},
            "keyerEnabled": *self.keyer_enabled[level].lock().expect("lock poisoned"),
            "keyerSourceSenderId": self.keyer_source[level].lock().expect("lock poisoned").clone(),
            "pipEnabled": *self.pip_enabled[level].lock().expect("lock poisoned"),
            "pipSourceSenderId": self.pip_source[level].lock().expect("lock poisoned").clone(),
            "pinnedSenderIds": self.pinned[level].lock().expect("lock poisoned").clone(),
            "transRateFrames": *self.trans_rate[level].lock().expect("lock poisoned"),
        })
    }

    /// Kehrseite von `capture_state` — s. dortige Doku zum Schema-
    /// Unterschied nach Ebenen-Anzahl.
    fn restore_state(&self, doc: &Value) {
        if level_count(self) <= 1 {
            self.restore_level_state(0, doc);
            return;
        }
        if let Some(levels) = doc.get("levels").and_then(Value::as_array) {
            for (level, entry) in levels.iter().enumerate().take(level_count(self)) {
                self.restore_level_state(level, entry);
            }
        }
    }

    /// Preset-Bus zuerst gesetzt (`select_preset`), Programm-Bus danach
    /// direkt per PGM-Hot-Cut (`take`, s. `pipeline.rs`-Doku dort —
    /// berührt den Preset-Wert bewusst nicht), damit beide Busse
    /// unabhängig auf den gespeicherten Stand zurückkehren, genau wie sie
    /// unabhängig erfasst wurden.
    fn restore_level_state(&self, level: usize, doc: &Value) {
        let program = doc.get("programSenderId").and_then(Value::as_str).map(str::to_string);
        let preset = doc.get("presetSenderId").and_then(Value::as_str).map(str::to_string);
        self.pipeline.select_preset(level, preset);
        self.pipeline.take(level, program);

        if let Some(b) = doc.get("dveBox") {
            let box_ = DveBox {
                x: b.get("x").and_then(Value::as_i64).unwrap_or(0) as i32,
                y: b.get("y").and_then(Value::as_i64).unwrap_or(0) as i32,
                width: b.get("width").and_then(Value::as_i64).unwrap_or(0) as i32,
                height: b.get("height").and_then(Value::as_i64).unwrap_or(0) as i32,
            };
            self.pipeline.set_dve_box(level, box_);
        }
        if let Some(enabled) = doc.get("keyerEnabled").and_then(Value::as_bool) {
            self.pipeline.set_keyer_enabled(level, enabled);
        }
        if let Some(source) = doc.get("keyerSourceSenderId").and_then(Value::as_str).map(str::to_string) {
            *self.keyer_source[level].lock().expect("lock poisoned") = Some(source.clone());
            self.pipeline.set_keyer_source(level, Some(source));
        }
        if let Some(enabled) = doc.get("pipEnabled").and_then(Value::as_bool) {
            self.pipeline.set_pip_enabled(level, enabled);
        }
        if let Some(source) = doc.get("pipSourceSenderId").and_then(Value::as_str).map(str::to_string) {
            *self.pip_source[level].lock().expect("lock poisoned") = Some(source.clone());
            self.pipeline.set_pip_source(level, Some(source));
        }
        if let Some(pinned) = doc.get("pinnedSenderIds").and_then(Value::as_array) {
            *self.pinned[level].lock().expect("lock poisoned") = pinned
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
        }
        if let Some(frames) = doc.get("transRateFrames").and_then(Value::as_f64) {
            let frames = frames as i32;
            *self.trans_rate[level].lock().expect("lock poisoned") = frames;
            self.pipeline.set_trans_rate(level, frames as u32);
        }
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "VideoMixerME");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9360").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    // Kapitel 15 (docs/END-GOAL-FEATURES.md §15.3c): Workflow-Auflösungs-
    // Setting landet hier als OMP_WIDTH/OMP_HEIGHT (orchestrator/internal/
    // workflows/service.go runStart) — ungültige oder fehlende Werte
    // fallen ohne Fehler auf den Node-eigenen Default zurück.
    let width: u32 = env_or("OMP_WIDTH", "")
        .parse()
        .unwrap_or(pipeline::DEFAULT_WIDTH);
    let height: u32 = env_or("OMP_HEIGHT", "")
        .parse()
        .unwrap_or(pipeline::DEFAULT_HEIGHT);
    // Nutzerwunsch 2026-08-14 ("dynamische Anzahl an Mischerebenen... jede
    // mit eigenem Output"): fest bei Workflow-Start, wie OMP_WIDTH/
    // OMP_HEIGHT (Teil 3 verdrahtet ein Workflow-Rollen-Setting dafür,
    // s. UMSETZUNG.md-Plan) — 0/fehlend/ungültig fällt auf 1 zurück, nie
    // ein Fehler.
    let level_count: usize = env_or("OMP_ME_LEVELS", "1").parse().unwrap_or(1).max(1);

    let sender_ids: Vec<String> = (0..level_count).map(|_| omp_node_sdk::idgen::new_v4()).collect();
    let flow_ids: Vec<String> = (0..level_count).map(|_| omp_node_sdk::idgen::new_v4()).collect();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        flow_ids: flow_ids.clone(),
        label: label.clone(),
        width,
        height,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx, pipeline_heartbeat_thread)
    });

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-video-mixer-me: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-video-mixer-me: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let inputs = Arc::new(Mutex::new(Vec::<DiscoveredInput>::new()));
    let keyfill_inputs = Arc::new(Mutex::new(Vec::<DiscoveredKeyFill>::new()));
    let program: PerLevel<Option<String>> = (0..level_count).map(|_| Arc::new(Mutex::new(None))).collect();
    let preset: PerLevel<Option<String>> = (0..level_count).map(|_| Arc::new(Mutex::new(None))).collect();
    let dve_box: PerLevel<DveBox> =
        (0..level_count).map(|_| Arc::new(Mutex::new(DveBox::full_frame(width, height)))).collect();
    let keyer_enabled: PerLevel<bool> = (0..level_count).map(|_| Arc::new(Mutex::new(false))).collect();
    let keyer_source: PerLevel<Option<String>> = (0..level_count).map(|_| Arc::new(Mutex::new(None))).collect();
    let pip_enabled: PerLevel<bool> = (0..level_count).map(|_| Arc::new(Mutex::new(false))).collect();
    let pip_source: PerLevel<Option<String>> = (0..level_count).map(|_| Arc::new(Mutex::new(None))).collect();
    let pinned: PerLevel<Vec<String>> = (0..level_count).map(|_| Arc::new(Mutex::new(Vec::new()))).collect();
    let trans_rate: PerLevel<i32> =
        (0..level_count).map(|_| Arc::new(Mutex::new(DEFAULT_TRANS_RATE_FRAMES as i32))).collect();

    let store: Arc<dyn ParamStore> = Arc::new(MixerStore {
        inputs: inputs.clone(),
        sender_ids: sender_ids.clone(),
        program: program.clone(),
        preset: preset.clone(),
        dve_box: dve_box.clone(),
        keyer_enabled: keyer_enabled.clone(),
        keyfill_inputs: keyfill_inputs.clone(),
        keyer_source: keyer_source.clone(),
        pip_enabled: pip_enabled.clone(),
        pip_source: pip_source.clone(),
        pinned: pinned.clone(),
        trans_rate: trans_rate.clone(),
        pipeline: pipeline_handle.clone(),
    });

    // Port-Label "PGM"/"PGM {n}" (Nutzerfund 2026-07-16, §22 Flow-Editor-
    // Lesbarkeit, erweitert 2026-08-14 um mehrere Ebenen): der generische
    // "<Label> Sender N" verriet an der Kachel nicht, dass dieser Ausgang
    // der Programm-Bus ist. Ein Sender je Ebene (Nutzerwunsch: "jede
    // Mischerebene soll eigenen Output erzeugen").
    let senders: Vec<SenderSpec> = sender_ids
        .iter()
        .zip(flow_ids.iter())
        .enumerate()
        .map(|(level, (sender_id, flow_id))| SenderSpec {
            id: Some(sender_id.clone()),
            transport: Some(TRANSPORT_MXL.to_string()),
            flow: Some(FlowSpec::Video {
                id: Some(flow_id.clone()),
                frame_width: width,
                frame_height: height,
                grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
                grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
            }),
            label: Some(if level_count <= 1 { "PGM".to_string() } else { format!("PGM {}", level + 1) }),
            ..Default::default()
        })
        .collect();

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url: registry_url.clone(),
            nats_url,
            senders,
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
    // Nachtrag 130/131).
    handle.register_worker("pipeline", pipeline_heartbeat);

    // Sender→Device→Node-Auflösung fürs Tally-Event (`omp.tally.<node_id>`,
    // C10-Moduldoku `pipeline.rs`): pro `device_id` höchstens einmal
    // abgefragt, danach aus dem Cache bedient — Devices/Nodes ändern sich
    // nicht, solange derselbe Prozess läuft (der jeweilige `omp-source`
    // müsste dafür neu starten, was ohnehin eine neue `device_id` erzeugt).
    let node_id_cache: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

    let discovery = discovery_loop(
        registry_url.clone(),
        sender_ids,
        pipeline_handle,
        inputs.clone(),
        keyfill_inputs,
    );

    let events = handle_events(
        &mut rx,
        &handle,
        registry_url,
        node_id_cache,
        inputs,
        program,
        preset,
        dve_box,
        keyer_enabled,
        pip_enabled,
    );

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-video-mixer-me: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-video-mixer-me: pipeline thread ended");
        }
        _ = discovery => {
            eprintln!("omp-video-mixer-me: discovery loop ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}

/// Löst `device_id` per IS-04-Query-API zu `node_id` auf (gecacht) — nötig,
/// weil die Sender-Liste (`discovery_loop`) nur `device_id` liefert, das
/// Tally-Event aber die Node-Kachel im Graph adressieren muss.
async fn resolve_node_id(
    registry_url: &str,
    device_id: &str,
    cache: &Arc<Mutex<HashMap<String, String>>>,
) -> Option<String> {
    if let Some(cached) = cache.lock().expect("lock poisoned").get(device_id) {
        return Some(cached.clone());
    }
    let registry = RegistryClient::new(registry_url.to_string());
    let device_id = device_id.to_string();
    let result =
        tokio::task::spawn_blocking(move || registry.get_device(&device_id)).await;
    match result {
        Ok(Ok(device)) => {
            cache
                .lock()
                .expect("lock poisoned")
                .insert(device.id.clone(), device.node_id.clone());
            Some(device.node_id)
        }
        Ok(Err(e)) => {
            eprintln!("omp-video-mixer-me: get_device failed: {e}");
            None
        }
        Err(e) => {
            eprintln!("omp-video-mixer-me: get_device task panicked: {e}");
            None
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_events(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<pipeline::Event>,
    handle: &omp_node_sdk::NodeHandle,
    registry_url: String,
    node_id_cache: Arc<Mutex<HashMap<String, String>>>,
    // Derselbe Arc wie `MixerStore.inputs`/`discovery_loop` — für die
    // Sender→Device-Auflösung beim Tally-Publish gebraucht.
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
    program: PerLevel<Option<String>>,
    preset: PerLevel<Option<String>>,
    dve_box: PerLevel<DveBox>,
    keyer_enabled: PerLevel<bool>,
    pip_enabled: PerLevel<bool>,
) {
    while let Some(event) = rx.recv().await {
        match event {
            pipeline::Event::Error(message) => {
                eprintln!("omp-video-mixer-me: pipeline error: {message}");
                handle.publish_alert(message).await;
            }
            pipeline::Event::ProgramChanged { level, previous, current } => {
                let Some(program_l) = program.get(level) else { continue };
                *program_l.lock().expect("lock poisoned") = current.clone();
                let device_id_of = |sender_id: &str| -> Option<String> {
                    inputs
                        .lock()
                        .expect("lock poisoned")
                        .iter()
                        .find(|i| i.sender_id == sender_id)
                        .map(|i| i.device_id.clone())
                };
                // Nutzerwunsch 2026-08-14 ("mehrere Mischerebenen"):
                // Tally-AUS für `prev_sender` nur, wenn KEINE andere
                // Ebene ihn noch als Programm führt — sonst würde z. B.
                // ein Cut auf Ebene 2 weg von Quelle X das Tally-Licht
                // von X löschen, obwohl Ebene 1 X immer noch sendet.
                if let Some(prev_sender) = &previous {
                    if Some(prev_sender) != current.as_ref()
                        && !program.iter().enumerate().any(|(i, p)| {
                            i != level && p.lock().expect("lock poisoned").as_deref() == Some(prev_sender.as_str())
                        })
                    {
                        if let Some(device_id) = device_id_of(prev_sender) {
                            if let Some(node_id) =
                                resolve_node_id(&registry_url, &device_id, &node_id_cache).await
                            {
                                handle.publish_tally(&node_id, false).await;
                            }
                        }
                    }
                }
                if let Some(cur_sender) = &current {
                    if let Some(device_id) = device_id_of(cur_sender) {
                        if let Some(node_id) =
                            resolve_node_id(&registry_url, &device_id, &node_id_cache).await
                        {
                            handle.publish_tally(&node_id, true).await;
                        }
                    }
                }
            }
            pipeline::Event::PresetChanged { level, preset: sender_id } => {
                if let Some(p) = preset.get(level) {
                    *p.lock().expect("lock poisoned") = sender_id;
                }
            }
            pipeline::Event::DveBoxChanged { level, box_ } => {
                if let Some(b) = dve_box.get(level) {
                    *b.lock().expect("lock poisoned") = box_;
                }
            }
            pipeline::Event::KeyerChanged { level, enabled } => {
                if let Some(e) = keyer_enabled.get(level) {
                    *e.lock().expect("lock poisoned") = enabled;
                }
            }
            pipeline::Event::PipChanged { level, enabled } => {
                if let Some(e) = pip_enabled.get(level) {
                    *e.lock().expect("lock poisoned") = enabled;
                }
            }
        }
    }
}

/// Splittet einen Grouphint-Tag-Wert (`"<group>:<role>[:<scope>]"`) in
/// `(group, role)` — identisch zu `omp-switcher`/`omp-multiviewer`s
/// gleichnamiger Funktion, bewusst dupliziert statt geteilt.
fn parse_grouphint(value: &str) -> Option<(&str, &str)> {
    let mut parts = value.splitn(3, ':');
    let group = parts.next()?;
    let role = parts.next()?;
    Some((group, role))
}

/// Ob `s` selbst ein Lowres-Begleit-Sender ist (Rolle `low`) — solche
/// Sender bekommen keinen eigenen Eingangs-Button in der Kreuzschiene
/// (auch wenn dieser Node ihre Lowres-Flows seit 2026-07-23, s.
/// `pipeline.rs`-Moduldoku "Kapitel 15 Teil 3 (Rest 2) rückgebaut", nie
/// mehr selbst liest).
fn is_lowres_companion(s: &Sender) -> bool {
    s.tags
        .get(GROUPHINT_TAG)
        .map(|values| values.iter().any(|v| matches!(parse_grouphint(v), Some((_, "low")))))
        .unwrap_or(false)
}

/// Ein Discovery-Durchlauf (blockierend, s. `spawn_blocking`-Aufrufer):
/// gleicher Filter-Stil wie zuvor (`transport==MXL`, `format==video`,
/// eigener Sender ausgeschlossen — seit `omp-audio-mixer`, `UMSETZUNG.md`
/// C11, melden auch Audio-Nodes MXL-Sender an, nur `transport==MXL`
/// filtern würde versuchen, deren Flow als Video-Eingang zu öffnen).
fn discover(
    registry: &RegistryClient,
    // Nachtrag 2026-08-14 ("Mastereben braucht feste Buttons für die
    // Ausgänge der anderen Ebenen, wie bei einem Hardware-Bildmischer mit
    // mehreren M/E-Bänken"): die eigenen PGM-Ausgänge dieses Nodes werden
    // HIER nicht mehr ausgeschlossen — nur `discover_keyfill` unten
    // filtert sie weiterhin komplett heraus (der eigene PGM-Ausgang taugt
    // nicht als DSK-Fill/Key-Quelle). Die Selbstreferenz EINER Ebene auf
    // sich selbst wird stattdessen erst beim Lesen gefiltert
    // (`level_get`s "crosspoint.inputs"-Zweig, per `sender_ids[level]`).
    own_sender_ids: &[String],
) -> Result<(Vec<DiscoveredInput>, Vec<DiscoveredKeyFill>), String> {
    let senders = registry.list_senders().map_err(|e| e.to_string())?;

    let mut discovered = Vec::new();
    for s in &senders {
        if s.transport != TRANSPORT_MXL || is_lowres_companion(s) {
            continue;
        }
        let Some(flow_id) = &s.flow_id else { continue };
        if !matches!(registry.get_flow_format(flow_id), Ok(format) if format == is04::FORMAT_VIDEO) {
            continue;
        }

        discovered.push(DiscoveredInput {
            sender_id: s.id.clone(),
            label: s.label.clone(),
            flow_id: flow_id.clone(),
            device_id: s.device_id.clone(),
        });
    }
    Ok((discovered, discover_keyfill(&senders, own_sender_ids)))
}

/// Findet Fill+Key-Senderpaare je NMOS-Device (Keyer-DSK-Kandidaten, s.
/// `pipeline::DiscoveredKeyFill`-Doku) in einer bereits abgerufenen
/// Sender-Liste — arbeitet bewusst auf demselben `senders`-Schnappschuss
/// wie die Crosspoint-Eingangs-Erkennung oben (ein `list_senders()`-Ruf
/// pro Poll reicht). Namenskonvention exakt wie von `omp-ograf`
/// veröffentlicht: `"<Label> Fill"` + `"<Label> Key"` auf demselben
/// `device_id` (die dritte, `"<Label> Fill Lowres"`, ist bewusst
/// ausgeschlossen — nur eine reine Vorschau, s. `omp-ograf`s Kapitel-15-
/// Teil-4-Moduldoku).
fn discover_keyfill(senders: &[Sender], own_sender_ids: &[String]) -> Vec<DiscoveredKeyFill> {
    let mut by_device: HashMap<&str, Vec<&Sender>> = HashMap::new();
    for s in senders {
        if s.transport != TRANSPORT_MXL || own_sender_ids.iter().any(|id| id == &s.id) {
            continue;
        }
        by_device.entry(s.device_id.as_str()).or_default().push(s);
    }

    let mut result = Vec::new();
    for (device_id, group) in by_device {
        let fill = group.iter().find(|s| s.label.ends_with(" Fill"));
        let key = group.iter().find(|s| s.label.ends_with(" Key"));
        let (Some(fill), Some(key)) = (fill, key) else { continue };
        let (Some(fill_flow_id), Some(key_flow_id)) = (&fill.flow_id, &key.flow_id) else { continue };
        let label = fill.label.strip_suffix(" Fill").unwrap_or(&fill.label).to_string();
        result.push(DiscoveredKeyFill {
            device_id: device_id.to_string(),
            label,
            fill_sender_id: fill.id.clone(),
            fill_flow_id: fill_flow_id.clone(),
            key_sender_id: key.id.clone(),
            key_flow_id: key_flow_id.clone(),
        });
    }
    result
}

/// Wie bei `omp-switcher` (C7): pollt alle 2s die IS-04-Query-API nach
/// MXL-Sendern, filtert den eigenen Sender heraus. Zusätzlich zu C7:
/// nimmt `device_id` mit (für die Tally-Node-Auflösung, s. o.).
///
/// Aktiviert seit 2026-07-23 (s. `pipeline.rs`-Moduldoku "Kapitel 15 Teil
/// 3 (Rest 2) rückgebaut") KEINE Lowres-Begleit-Sender mehr — dieser Node
/// liest nie mehr etwas anderes als die Highres-Flows seiner Eingänge,
/// die frühere `activateLowresPreview`/`releaseLowresPreview`-Buchführung
/// entfällt ersatzlos.
async fn discovery_loop(
    registry_url: String,
    own_sender_ids: Vec<String>,
    pipeline: pipeline::PipelineHandle,
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
    keyfill_inputs: Arc<Mutex<Vec<DiscoveredKeyFill>>>,
) {
    let registry = RegistryClient::new(registry_url);
    let mut interval = tokio::time::interval(Duration::from_secs(2));

    loop {
        interval.tick().await;
        let registry_for_poll = registry.clone();
        let own_sender_ids_for_poll = own_sender_ids.clone();
        let result =
            tokio::task::spawn_blocking(move || discover(&registry_for_poll, &own_sender_ids_for_poll)).await;

        let (discovered, discovered_keyfill) = match result {
            Ok(Ok(discovered)) => discovered,
            Ok(Err(e)) => {
                eprintln!("omp-video-mixer-me: discovery poll failed: {e}");
                continue;
            }
            Err(e) => {
                eprintln!("omp-video-mixer-me: discovery poll task panicked: {e}");
                continue;
            }
        };
        *keyfill_inputs.lock().expect("lock poisoned") = discovered_keyfill.clone();
        pipeline.set_keyfill_inputs(discovered_keyfill);

        *inputs.lock().expect("lock poisoned") = discovered.clone();
        pipeline.set_inputs(discovered);
    }
}
