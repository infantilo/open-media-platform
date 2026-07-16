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
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    RawResponse, SenderSpec, SetError,
};
use pipeline::{DiscoveredInput, DveBox};
use serde_json::Value;

struct MixerStore {
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
    program: Arc<Mutex<Option<String>>>,
    preset: Arc<Mutex<Option<String>>>,
    dve_box: Arc<Mutex<DveBox>>,
    keyer_enabled: Arc<Mutex<bool>>,
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
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, _body: &[u8]) -> Option<RawResponse> {
        uibundle::route(method, path)
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

    let sender_id = omp_node_sdk::idgen::new_v4();
    let flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        flow_id: flow_id.clone(),
        label: label.clone(),
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
    let dve_box = Arc::new(Mutex::new(DveBox::default()));
    let keyer_enabled = Arc::new(Mutex::new(false));

    let store: Arc<dyn ParamStore> = Arc::new(MixerStore {
        inputs: inputs.clone(),
        program: program.clone(),
        preset: preset.clone(),
        dve_box: dve_box.clone(),
        keyer_enabled: keyer_enabled.clone(),
        pipeline: pipeline_handle.clone(),
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url: registry_url.clone(),
            nats_url,
            senders: vec![SenderSpec {
                id: Some(sender_id.clone()),
                transport: Some(TRANSPORT_MXL.to_string()),
                flow: Some(FlowSpec::Video {
                    id: Some(flow_id),
                    frame_width: pipeline::WIDTH,
                    frame_height: pipeline::HEIGHT,
                    grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
                    grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
                }),
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
        }
    }
}

/// Wie bei `omp-switcher` (C7): pollt alle 2s die IS-04-Query-API nach
/// MXL-Sendern, filtert den eigenen Sender heraus. Zusätzlich zu C7:
/// nimmt `device_id` mit (für die Tally-Node-Auflösung, s. o.).
async fn discovery_loop(
    registry_url: String,
    own_sender_id: String,
    pipeline: pipeline::PipelineHandle,
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
) {
    let registry = RegistryClient::new(registry_url);
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    loop {
        interval.tick().await;
        let registry = registry.clone();
        let own_sender_id = own_sender_id.clone();
        // Filter + `get_flow_format`-Nachschlag laufen in derselben
        // `spawn_blocking`-Aufgabe wie `list_senders()` (mehrere
        // synchrone `ureq`-Aufrufe hintereinander, sonst würde jeder
        // einzeln den async-Executor-Thread blockieren). Seit
        // `omp-audio-mixer` (`UMSETZUNG.md` C11) melden auch Audio-Nodes
        // MXL-Sender an — nur `transport==MXL` filtern würde versuchen,
        // deren Flow als Video-Eingang zu öffnen.
        let result = tokio::task::spawn_blocking(move || -> Result<Vec<DiscoveredInput>, String> {
            let senders = registry.list_senders().map_err(|e| e.to_string())?;
            Ok(senders
                .into_iter()
                .filter(|s| s.transport == TRANSPORT_MXL && s.id != own_sender_id)
                .filter_map(|s| s.flow_id.map(|flow_id| (s.id, s.label, flow_id, s.device_id)))
                .filter(|(_, _, flow_id, _)| {
                    matches!(registry.get_flow_format(flow_id), Ok(format) if format == is04::FORMAT_VIDEO)
                })
                .map(|(sender_id, label, flow_id, device_id)| DiscoveredInput {
                    sender_id,
                    label,
                    flow_id,
                    device_id,
                })
                .collect())
        })
        .await;

        let discovered = match result {
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

        *inputs.lock().expect("lock poisoned") = discovered.clone();
        pipeline.set_inputs(discovered);
    }
}
