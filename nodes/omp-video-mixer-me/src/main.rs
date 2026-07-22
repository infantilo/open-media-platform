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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_node_sdk::is04;
use omp_node_sdk::is04::{RegistryClient, Sender, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    PeerClient, RawResponse, SenderSpec, SetError, resolve_owning_node_href,
};
use pipeline::{DiscoveredInput, DiscoveredKeyFill, DveBox};
use serde_json::Value;

/// Kapitel 15 Teil 3 (Rest 2, docs/END-GOAL-FEATURES.md §15.3b/§15.4):
/// identisch zu `omp-switcher::GROUPHINT_TAG`/`omp-multiviewer`, bewusst
/// dupliziert (jeder Node ein eigenständiges Binary, s. dortige Doku).
const GROUPHINT_TAG: &str = "urn:x-nmos:tag:grouphint/v1.0";

struct MixerStore {
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
    program: Arc<Mutex<Option<String>>>,
    preset: Arc<Mutex<Option<String>>>,
    dve_box: Arc<Mutex<DveBox>>,
    keyer_enabled: Arc<Mutex<bool>>,
    keyfill_inputs: Arc<Mutex<Vec<DiscoveredKeyFill>>>,
    keyer_source: Arc<Mutex<Option<String>>>,
    /// PIP-Layer (Nutzerwunsch 2026-07-22, s. `pipeline.rs`-Moduldoku
    /// "PIP als eigenständiger Layer") — gleiches Muster wie
    /// `keyer_enabled`/`keyer_source`.
    pip_enabled: Arc<Mutex<bool>>,
    pip_source: Arc<Mutex<Option<String>>>,
    /// Kuratierte Kreuzschiene (Nutzerwunsch 2026-07-22): welche
    /// entdeckten Quellen der Operator sich per "+" als dauerhafte PGM/
    /// PST-Tasten angelegt hat — bewusst getrennt von `inputs` (dem
    /// vollen Discovery-Satz, weiterhin die Grundlage für "+"s
    /// Auswahlliste). Reine Buchführung, keine Pipeline-Wirkung:
    /// `crosspoint.select`/`take` funktionieren unverändert mit jeder
    /// entdeckten `senderId`, unabhängig vom Pin-Status.
    pinned: Arc<Mutex<Vec<String>>>,
    pipeline: pipeline::PipelineHandle,
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
            parameters: vec![
                // Wie bei omp-switcher (C7): "inputs" ist ein JSON-Array,
                // das v0-Schema kennt keinen Array-Typ — der Wert wird
                // trotzdem als solcher geliefert, gelesen vom eigenen
                // UI-Bundle (uibundle.rs), nicht vom generischen B6-Panel.
                ParamSpec {
                    name: "crosspoint.inputs".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "crosspoint.programInput".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "crosspoint.presetInput".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                // JSON-Objekt {x,y,width,height}, gleiche Array-/Objekt-
                // Ausnahme wie "crosspoint.inputs".
                ParamSpec {
                    name: "dve.box".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "keyer.enabled".to_string(),
                    kind: ParamType::Boolean,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                // Fill+Key-Senderpaare (`omp-ograf` o. Ä., s.
                // `pipeline::DiscoveredKeyFill`-Doku) — JSON-Array, gleiche
                // Array-Ausnahme wie "crosspoint.inputs".
                ParamSpec {
                    name: "keyer.inputs".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "keyer.source".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "pip.enabled".to_string(),
                    kind: ParamType::Boolean,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "pip.source".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                // Kuratierte Kreuzschiene (Nutzerwunsch 2026-07-22): vom
                // Operator per "+" angepinnte `senderId`s — JSON-Array,
                // gleiche Array-Ausnahme wie "crosspoint.inputs".
                ParamSpec {
                    name: "crosspoint.pinnedSenderIds".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
            ],
            methods: vec![
                MethodSpec {
                    name: "crosspoint.select".to_string(),
                    args: vec![MethodArg {
                        name: "senderId".to_string(),
                        kind: ParamType::String,
                    }],
                },
                MethodSpec {
                    name: "crosspoint.cut".to_string(),
                    args: vec![],
                },
                MethodSpec {
                    name: "crosspoint.take".to_string(),
                    args: vec![MethodArg {
                        name: "senderId".to_string(),
                        kind: ParamType::String,
                    }],
                },
                MethodSpec {
                    name: "crosspoint.autoTrans".to_string(),
                    args: vec![],
                },
                MethodSpec {
                    name: "dve.setBox".to_string(),
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
                    name: "dve.reset".to_string(),
                    args: vec![],
                },
                MethodSpec {
                    name: "keyer.setEnabled".to_string(),
                    args: vec![MethodArg {
                        name: "enabled".to_string(),
                        kind: ParamType::Boolean,
                    }],
                },
                // Leerer String wählt die synthetische Test-Farbfläche
                // (Default) ab statt einer echten Fill+Key-Quelle, gleiche
                // Konvention wie "crosspoint.select"/"crosspoint.take".
                MethodSpec {
                    name: "keyer.setSource".to_string(),
                    args: vec![MethodArg {
                        name: "senderId".to_string(),
                        kind: ParamType::String,
                    }],
                },
                MethodSpec {
                    name: "pip.setEnabled".to_string(),
                    args: vec![MethodArg {
                        name: "enabled".to_string(),
                        kind: ParamType::Boolean,
                    }],
                },
                // Leerer String wählt Schwarz ab (kein PIP-Bild), gleiche
                // Konvention wie "keyer.setSource".
                MethodSpec {
                    name: "pip.setSource".to_string(),
                    args: vec![MethodArg {
                        name: "senderId".to_string(),
                        kind: ParamType::String,
                    }],
                },
                MethodSpec {
                    name: "crosspoint.pin".to_string(),
                    args: vec![MethodArg {
                        name: "senderId".to_string(),
                        kind: ParamType::String,
                    }],
                },
                MethodSpec {
                    name: "crosspoint.unpin".to_string(),
                    args: vec![MethodArg {
                        name: "senderId".to_string(),
                        kind: ParamType::String,
                    }],
                },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "crosspoint.inputs" => {
                let inputs = self.inputs.lock().expect("lock poisoned");
                Some(serde_json::json!(
                    inputs
                        .iter()
                        .map(|i| serde_json::json!({"senderId": i.sender_id, "label": i.label}))
                        .collect::<Vec<_>>()
                ))
            }
            "crosspoint.programInput" => Some(serde_json::json!(
                self.program
                    .lock()
                    .expect("lock poisoned")
                    .clone()
                    .unwrap_or_default()
            )),
            "crosspoint.presetInput" => Some(serde_json::json!(
                self.preset
                    .lock()
                    .expect("lock poisoned")
                    .clone()
                    .unwrap_or_default()
            )),
            "dve.box" => {
                let b = *self.dve_box.lock().expect("lock poisoned");
                Some(serde_json::json!({"x": b.x, "y": b.y, "width": b.width, "height": b.height}))
            }
            "keyer.enabled" => Some(serde_json::json!(
                *self.keyer_enabled.lock().expect("lock poisoned")
            )),
            "keyer.inputs" => {
                let inputs = self.keyfill_inputs.lock().expect("lock poisoned");
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
                self.keyer_source.lock().expect("lock poisoned").clone().unwrap_or_default()
            )),
            "pip.enabled" => Some(serde_json::json!(
                *self.pip_enabled.lock().expect("lock poisoned")
            )),
            "pip.source" => Some(serde_json::json!(
                self.pip_source.lock().expect("lock poisoned").clone().unwrap_or_default()
            )),
            "crosspoint.pinnedSenderIds" => Some(serde_json::json!(
                self.pinned.lock().expect("lock poisoned").clone()
            )),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "crosspoint.select" => {
                let sender_id = args
                    .get("senderId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let selected = if sender_id.is_empty() {
                    None
                } else {
                    Some(sender_id.to_string())
                };
                self.pipeline.select_preset(selected);
                Ok(())
            }
            "crosspoint.cut" => {
                self.pipeline.cut();
                Ok(())
            }
            "crosspoint.take" => {
                let sender_id = args
                    .get("senderId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let selected = if sender_id.is_empty() {
                    None
                } else {
                    Some(sender_id.to_string())
                };
                self.pipeline.take(selected);
                Ok(())
            }
            "crosspoint.autoTrans" => {
                self.pipeline.auto_trans();
                Ok(())
            }
            "dve.setBox" => {
                let box_ = DveBox {
                    x: json_number(args, "x")?,
                    y: json_number(args, "y")?,
                    width: json_number(args, "width")?,
                    height: json_number(args, "height")?,
                };
                self.pipeline.set_dve_box(box_);
                Ok(())
            }
            "dve.reset" => {
                self.pipeline.reset_dve();
                Ok(())
            }
            "keyer.setEnabled" => {
                let enabled = args
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or(InvokeError::Unknown)?;
                self.pipeline.set_keyer_enabled(enabled);
                Ok(())
            }
            "keyer.setSource" => {
                let sender_id = args
                    .get("senderId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let selected = if sender_id.is_empty() {
                    None
                } else {
                    Some(sender_id.to_string())
                };
                *self.keyer_source.lock().expect("lock poisoned") = selected.clone();
                self.pipeline.set_keyer_source(selected);
                Ok(())
            }
            "pip.setEnabled" => {
                let enabled = args
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or(InvokeError::Unknown)?;
                self.pipeline.set_pip_enabled(enabled);
                Ok(())
            }
            "pip.setSource" => {
                let sender_id = args
                    .get("senderId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let selected = if sender_id.is_empty() {
                    None
                } else {
                    Some(sender_id.to_string())
                };
                *self.pip_source.lock().expect("lock poisoned") = selected.clone();
                self.pipeline.set_pip_source(selected);
                Ok(())
            }
            "crosspoint.pin" => {
                let sender_id = args
                    .get("senderId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let mut pinned = self.pinned.lock().expect("lock poisoned");
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
                self.pinned.lock().expect("lock poisoned").retain(|s| s != sender_id);
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
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

impl MixerStore {
    /// Node-eigener Vollzustand (§4.6 Punkt 4, `docs/END-GOAL-FEATURES.md`
    /// "Mixer-Presets", `docs/decisions.md` Nachtrag 40) hinter `GET
    /// /state` — dasselbe Node-Contract-Muster wie `omp-audio-mixer`
    /// (gleicher Grund: alle Parameter hier sind `readonly:true`, s.
    /// Modul-Doku oben zu MS-05-02/eigenen Klassen, Mutation läuft nur
    /// über `crosspoint.*`/`dve.*`/`keyer.*`-Methoden).
    fn capture_state(&self) -> Value {
        let box_ = *self.dve_box.lock().expect("lock poisoned");
        serde_json::json!({
            "programSenderId": self.program.lock().expect("lock poisoned").clone(),
            "presetSenderId": self.preset.lock().expect("lock poisoned").clone(),
            "dveBox": {"x": box_.x, "y": box_.y, "width": box_.width, "height": box_.height},
            "keyerEnabled": *self.keyer_enabled.lock().expect("lock poisoned"),
            "keyerSourceSenderId": self.keyer_source.lock().expect("lock poisoned").clone(),
            "pipEnabled": *self.pip_enabled.lock().expect("lock poisoned"),
            "pipSourceSenderId": self.pip_source.lock().expect("lock poisoned").clone(),
            "pinnedSenderIds": self.pinned.lock().expect("lock poisoned").clone(),
        })
    }

    /// Kehrseite von `capture_state`: Preset-Bus zuerst gesetzt
    /// (`select_preset`), Programm-Bus danach direkt per PGM-Hot-Cut
    /// (`take`, s. `pipeline.rs`-Doku dort — berührt den Preset-Wert
    /// bewusst nicht), damit beide Busse unabhängig auf den gespeicherten
    /// Stand zurückkehren, genau wie sie unabhängig erfasst wurden.
    fn restore_state(&self, doc: &Value) {
        let program = doc.get("programSenderId").and_then(Value::as_str).map(str::to_string);
        let preset = doc.get("presetSenderId").and_then(Value::as_str).map(str::to_string);
        self.pipeline.select_preset(preset);
        self.pipeline.take(program);

        if let Some(b) = doc.get("dveBox") {
            let box_ = DveBox {
                x: b.get("x").and_then(Value::as_i64).unwrap_or(0) as i32,
                y: b.get("y").and_then(Value::as_i64).unwrap_or(0) as i32,
                width: b.get("width").and_then(Value::as_i64).unwrap_or(0) as i32,
                height: b.get("height").and_then(Value::as_i64).unwrap_or(0) as i32,
            };
            self.pipeline.set_dve_box(box_);
        }
        if let Some(enabled) = doc.get("keyerEnabled").and_then(Value::as_bool) {
            self.pipeline.set_keyer_enabled(enabled);
        }
        if let Some(source) = doc.get("keyerSourceSenderId").and_then(Value::as_str).map(str::to_string) {
            *self.keyer_source.lock().expect("lock poisoned") = Some(source.clone());
            self.pipeline.set_keyer_source(Some(source));
        }
        if let Some(enabled) = doc.get("pipEnabled").and_then(Value::as_bool) {
            self.pipeline.set_pip_enabled(enabled);
        }
        if let Some(source) = doc.get("pipSourceSenderId").and_then(Value::as_str).map(str::to_string) {
            *self.pip_source.lock().expect("lock poisoned") = Some(source.clone());
            self.pipeline.set_pip_source(Some(source));
        }
        if let Some(pinned) = doc.get("pinnedSenderIds").and_then(Value::as_array) {
            *self.pinned.lock().expect("lock poisoned") = pinned
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
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

    let sender_id = omp_node_sdk::idgen::new_v4();
    let flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        flow_id: flow_id.clone(),
        label: label.clone(),
        width,
        height,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_thread =
        std::thread::spawn(move || pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx));

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
    let program = Arc::new(Mutex::new(None::<String>));
    let preset = Arc::new(Mutex::new(None::<String>));
    let dve_box = Arc::new(Mutex::new(DveBox::full_frame(width, height)));
    let keyer_enabled = Arc::new(Mutex::new(false));
    let keyfill_inputs = Arc::new(Mutex::new(Vec::<DiscoveredKeyFill>::new()));
    let keyer_source = Arc::new(Mutex::new(None::<String>));
    let pip_enabled = Arc::new(Mutex::new(false));
    let pip_source = Arc::new(Mutex::new(None::<String>));
    let pinned = Arc::new(Mutex::new(Vec::<String>::new()));

    let store: Arc<dyn ParamStore> = Arc::new(MixerStore {
        inputs: inputs.clone(),
        program: program.clone(),
        preset: preset.clone(),
        dve_box: dve_box.clone(),
        keyer_enabled: keyer_enabled.clone(),
        keyfill_inputs: keyfill_inputs.clone(),
        keyer_source: keyer_source.clone(),
        pip_enabled: pip_enabled.clone(),
        pip_source: pip_source.clone(),
        pinned: pinned.clone(),
        pipeline: pipeline_handle.clone(),
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url: registry_url.clone(),
            nats_url,
            // Port-Label "PGM" (Nutzerfund 2026-07-16, §22 Flow-Editor-
            // Lesbarkeit): der generische "<Label> Sender 1" verriet an
            // der Kachel nicht, dass dieser einzelne Ausgang der
            // Programm-Bus ist (relevant sobald ein zweiter, PST-
            // benannter Ausgang hinzukommt, s. docs/decisions.md
            // 2026-07-16 Nachtrag 2 — noch nicht umgesetzt).
            senders: vec![SenderSpec {
                id: Some(sender_id.clone()),
                transport: Some(TRANSPORT_MXL.to_string()),
                flow: Some(FlowSpec::Video {
                    id: Some(flow_id),
                    frame_width: width,
                    frame_height: height,
                    grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
                    grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
                }),
                label: Some("PGM".to_string()),
                ..Default::default()
            }],
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

    // Sender→Device→Node-Auflösung fürs Tally-Event (`omp.tally.<node_id>`,
    // C10-Moduldoku `pipeline.rs`): pro `device_id` höchstens einmal
    // abgefragt, danach aus dem Cache bedient — Devices/Nodes ändern sich
    // nicht, solange derselbe Prozess läuft (der jeweilige `omp-source`
    // müsste dafür neu starten, was ohnehin eine neue `device_id` erzeugt).
    let node_id_cache: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

    let discovery = discovery_loop(
        registry_url.clone(),
        sender_id,
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
    program: Arc<Mutex<Option<String>>>,
    preset: Arc<Mutex<Option<String>>>,
    dve_box: Arc<Mutex<DveBox>>,
    keyer_enabled: Arc<Mutex<bool>>,
    pip_enabled: Arc<Mutex<bool>>,
) {
    while let Some(event) = rx.recv().await {
        match event {
            pipeline::Event::Error(message) => {
                eprintln!("omp-video-mixer-me: pipeline error: {message}");
                handle.publish_alert(message).await;
            }
            pipeline::Event::ProgramChanged { previous, current } => {
                *program.lock().expect("lock poisoned") = current.clone();
                let device_id_of = |sender_id: &str| -> Option<String> {
                    inputs
                        .lock()
                        .expect("lock poisoned")
                        .iter()
                        .find(|i| i.sender_id == sender_id)
                        .map(|i| i.device_id.clone())
                };
                if let Some(prev_sender) = &previous {
                    if Some(prev_sender) != current.as_ref() {
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
            pipeline::Event::PresetChanged(sender_id) => {
                *preset.lock().expect("lock poisoned") = sender_id;
            }
            pipeline::Event::DveBoxChanged(box_) => {
                *dve_box.lock().expect("lock poisoned") = box_;
            }
            pipeline::Event::KeyerChanged(enabled) => {
                *keyer_enabled.lock().expect("lock poisoned") = enabled;
            }
            pipeline::Event::PipChanged(enabled) => {
                *pip_enabled.lock().expect("lock poisoned") = enabled;
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

/// Baut `group-name -> (lowres sender_id, lowres flow_id)` aus dem vollen
/// Sender-Satz — ein Durchlauf, kein zusätzlicher Registry-Umlauf.
fn lowres_by_group(senders: &[Sender]) -> HashMap<String, (String, String)> {
    let mut map = HashMap::new();
    for s in senders {
        let Some(flow_id) = &s.flow_id else { continue };
        let Some(values) = s.tags.get(GROUPHINT_TAG) else { continue };
        for v in values {
            if let Some((group, "low")) = parse_grouphint(v) {
                map.insert(group.to_string(), (s.id.clone(), flow_id.clone()));
            }
        }
    }
    map
}

/// Ob `s` selbst ein Lowres-Begleit-Sender ist (Rolle `low`) — solche
/// Sender bekommen keinen eigenen Eingangs-Button, sie werden nur über
/// `DiscoveredInput::lowres_flow_id` ihres Highres-Geschwisters gelesen.
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
/// filtern würde versuchen, deren Flow als Video-Eingang zu öffnen),
/// zusätzlich Kapitel 15 Teil 3 (Rest 2): pro Eingang den Lowres-
/// Begleit-Sender (falls vorhanden) verlinken, Lowres-Sender selbst
/// nicht als eigenen Eingang führen.
fn discover(
    registry: &RegistryClient,
    own_sender_id: &str,
) -> Result<(Vec<DiscoveredInput>, Vec<DiscoveredKeyFill>), String> {
    let senders = registry.list_senders().map_err(|e| e.to_string())?;
    let lowres_map = lowres_by_group(&senders);

    let mut discovered = Vec::new();
    for s in &senders {
        if s.transport != TRANSPORT_MXL || s.id == own_sender_id || is_lowres_companion(s) {
            continue;
        }
        let Some(flow_id) = &s.flow_id else { continue };
        if !matches!(registry.get_flow_format(flow_id), Ok(format) if format == is04::FORMAT_VIDEO) {
            continue;
        }

        let group = s
            .tags
            .get(GROUPHINT_TAG)
            .and_then(|values| values.first())
            .and_then(|v| parse_grouphint(v))
            .map(|(group, _)| group.to_string());
        let lowres = group.and_then(|g| lowres_map.get(&g).cloned());

        discovered.push(DiscoveredInput {
            sender_id: s.id.clone(),
            label: s.label.clone(),
            flow_id: flow_id.clone(),
            device_id: s.device_id.clone(),
            lowres_sender_id: lowres.as_ref().map(|(id, _)| id.clone()),
            lowres_flow_id: lowres.map(|(_, fid)| fid),
        });
    }
    Ok((discovered, discover_keyfill(&senders, own_sender_id)))
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
fn discover_keyfill(senders: &[Sender], own_sender_id: &str) -> Vec<DiscoveredKeyFill> {
    let mut by_device: HashMap<&str, Vec<&Sender>> = HashMap::new();
    for s in senders {
        if s.transport != TRANSPORT_MXL || s.id == own_sender_id {
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
/// Kapitel 15 Teil 3 (Rest 2): gleicht zusätzlich bei jedem Poll die beim
/// jeweiligen Quell-Node aktivierten Lowres-Sender an die aktuelle
/// Eingangs-Menge an (`activateLowresPreview`/`releaseLowresPreview`,
/// exakt dasselbe Muster wie `omp-switcher::main::discovery_loop`) —
/// `activated_lowres` merkt den Aktivierungsstand über Polls hinweg. Wie
/// beim Switcher entscheidet **nicht** diese Schleife, welcher Eingang
/// gerade Lowres liest (das macht `pipeline::run`s Cut/Take/AutoTrans-
/// Behandlung anhand des Programm-Status) — die Aktivierung läuft für
/// jeden entdeckten Eingang mit Lowres-Begleiter, unabhängig davon, ob er
/// gerade Programm ist.
async fn discovery_loop(
    registry_url: String,
    own_sender_id: String,
    pipeline: pipeline::PipelineHandle,
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
    keyfill_inputs: Arc<Mutex<Vec<DiscoveredKeyFill>>>,
) {
    let registry = RegistryClient::new(registry_url);
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    let mut activated_lowres: HashMap<String, String> = HashMap::new();

    loop {
        interval.tick().await;
        let registry_for_poll = registry.clone();
        let own_sender_id_for_poll = own_sender_id.clone();
        let result =
            tokio::task::spawn_blocking(move || discover(&registry_for_poll, &own_sender_id_for_poll)).await;

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

        let mut discovered = discovered;
        let wanted_ids: std::collections::HashSet<&str> =
            discovered.iter().filter_map(|i| i.lowres_sender_id.as_deref()).collect();
        let stale: Vec<(String, String)> = activated_lowres
            .iter()
            .filter(|(id, _)| !wanted_ids.contains(id.as_str()))
            .map(|(id, href)| (id.clone(), href.clone()))
            .collect();
        for (lowres_sender_id, href) in stale {
            let result = tokio::task::spawn_blocking(move || PeerClient::new(href).invoke("releaseLowresPreview")).await;
            if let Ok(Err(e)) = result {
                eprintln!("omp-video-mixer-me: releaseLowresPreview({lowres_sender_id}) failed: {e}");
            }
            activated_lowres.remove(&lowres_sender_id);
        }

        for input in discovered.iter_mut() {
            let Some(lowres_sender_id) = input.lowres_sender_id.clone() else { continue };
            if activated_lowres.contains_key(&lowres_sender_id) {
                continue;
            }
            let registry_for_resolve = registry.clone();
            let sender_id_for_resolve = lowres_sender_id.clone();
            let href = tokio::task::spawn_blocking(move || {
                resolve_owning_node_href(&registry_for_resolve, &sender_id_for_resolve)
            })
            .await
            .ok()
            .flatten();
            let Some(href) = href else {
                eprintln!(
                    "omp-video-mixer-me: owning node for lowres sender {lowres_sender_id} not resolvable, falling back to highres"
                );
                input.lowres_sender_id = None;
                input.lowres_flow_id = None;
                continue;
            };
            let href_for_call = href.clone();
            let activate_result =
                tokio::task::spawn_blocking(move || PeerClient::new(href_for_call).invoke("activateLowresPreview")).await;
            match activate_result {
                Ok(Ok(())) => {
                    activated_lowres.insert(lowres_sender_id, href);
                }
                Ok(Err(e)) => {
                    eprintln!("omp-video-mixer-me: activateLowresPreview({lowres_sender_id}) failed: {e}, falling back to highres");
                    input.lowres_sender_id = None;
                    input.lowres_flow_id = None;
                }
                Err(e) => {
                    eprintln!("omp-video-mixer-me: activateLowresPreview({lowres_sender_id}) task panicked: {e}, falling back to highres");
                    input.lowres_sender_id = None;
                    input.lowres_flow_id = None;
                }
            }
        }

        *inputs.lock().expect("lock poisoned") = discovered.clone();
        pipeline.set_inputs(discovered);
    }
}
