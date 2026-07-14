//! omp-switcher: MXL ×N → Buttons → MXL (`UMSETZUNG.md` C7). Dritter der
//! drei MXL-Demo-Services: der „Videomixer" mit dynamischer
//! Quellen-Auswahl per Button. Discovery **rein über IS-04** (kein
//! Orchestrator-Sonderwissen): alle ~2 s werden alle registrierten
//! MXL-Sender abgefragt, der eigene ausgeschlossen — neue
//! `omp-source`-Instanzen erscheinen dadurch automatisch als wählbare
//! Eingänge, ohne Neustart des Switchers.

mod pipeline;
mod uibundle;

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
use pipeline::DiscoveredInput;
use serde_json::Value;

struct SwitcherStore {
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
    active: Arc<Mutex<Option<String>>>,
    pipeline: pipeline::PipelineHandle,
}

impl ParamStore for SwitcherStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                ParamSpec {
                    name: "inputs".to_string(),
                    // Das v0-Descriptor-Schema kennt keinen Array-/Objekt-
                    // Typ (docs/descriptor-v0.schema.json) — der Wert ist
                    // trotzdem ein JSON-Array [{senderId,label}], gelesen
                    // vom eigenen UI-Bundle (uibundle.rs), nicht vom
                    // generischen B6-Panel.
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "activeInput".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
            ],
            methods: vec![MethodSpec {
                name: "select".to_string(),
                args: vec![MethodArg {
                    name: "senderId".to_string(),
                    kind: ParamType::String,
                }],
            }],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "inputs" => {
                let inputs = self.inputs.lock().expect("lock poisoned");
                Some(serde_json::json!(
                    inputs
                        .iter()
                        .map(|i| serde_json::json!({"senderId": i.sender_id, "label": i.label}))
                        .collect::<Vec<_>>()
                ))
            }
            "activeInput" => Some(serde_json::json!(
                self.active
                    .lock()
                    .expect("lock poisoned")
                    .clone()
                    .unwrap_or_default()
            )),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        if name != "select" {
            return Err(InvokeError::Unknown);
        }
        let sender_id = args
            .get("senderId")
            .and_then(Value::as_str)
            .ok_or(InvokeError::Unknown)?;
        let selected = if sender_id.is_empty() {
            None
        } else {
            Some(sender_id.to_string())
        };
        self.pipeline.select(selected);
        Ok(())
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
    let label = env_or("OMP_LABEL", "Switcher");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9350").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Vom Instanz-Launcher gesetzt (`UMSETZUNG.md` C8), sonst leer bei
    // manuellem Start.
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    // Wie bei omp-source/playout (C5/C3): eigene Sender-/Flow-ID vorab
    // erzeugen — die Discovery (unten) muss den eigenen Sender aus der
    // Query-API-Antwort ausschließen können, und es gilt Flow-UUID ==
    // MXL-flow-id (`UMSETZUNG.md` C4).
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
            eprintln!("omp-switcher: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-switcher: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let inputs = Arc::new(Mutex::new(Vec::<DiscoveredInput>::new()));
    let active = Arc::new(Mutex::new(None::<String>));

    let store: Arc<dyn ParamStore> = Arc::new(SwitcherStore {
        inputs: inputs.clone(),
        active: active.clone(),
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
            // Hat echtes Medien-I/O, aber noch keine Bereitschafts-Probe
            // verdrahtet (dokumentierte Folgearbeit, ARCHITECTURE.md §5
            // Punkt 6, docs/decisions.md D5-prep) - meldet konservativ nie
            // "bereit", statt eine ungeprüfte Bereitschaft vorzutäuschen.
            media_ready: omp_node_sdk::MediaReadySource::Unknown,
        },
        store,
    )
    .await?;

    let discovery = discovery_loop(registry_url, sender_id, pipeline_handle, inputs);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-switcher: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
                pipeline::Event::ActiveChanged(sender_id) => {
                    *active.lock().expect("lock poisoned") = sender_id;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-switcher: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-switcher: pipeline thread ended");
        }
        _ = discovery => {
            eprintln!("omp-switcher: discovery loop ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}

/// Pollt alle 2s die IS-04-Query-API nach MXL-Sendern (gleicher Poll-Stil
/// wie A5), filtert den eigenen Sender heraus und meldet das Ergebnis an
/// den Pipeline-Thread. Der Pipeline-Thread selbst entscheidet, ob sich
/// die Quellenmenge tatsächlich geändert hat (`pipeline::inputs_changed`)
/// — hier wird bewusst bei jedem Tick unverändert weitergemeldet, kein
/// Diffing auf dieser Seite.
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
        // Filter + `get_flow_format`-Nachschlag in derselben
        // `spawn_blocking`-Aufgabe (mehrere synchrone `ureq`-Aufrufe
        // hintereinander). Seit `omp-audio-mixer` (`UMSETZUNG.md` C11)
        // melden auch Audio-Nodes MXL-Sender an — nur `transport==MXL`
        // filtern würde versuchen, deren Flow als Video-Eingang zu
        // öffnen.
        let result = tokio::task::spawn_blocking(move || -> Result<Vec<DiscoveredInput>, String> {
            let senders = registry.list_senders().map_err(|e| e.to_string())?;
            Ok(senders
                .into_iter()
                .filter(|s| s.transport == TRANSPORT_MXL && s.id != own_sender_id)
                .filter_map(|s| s.flow_id.map(|flow_id| (s.id, s.label, flow_id)))
                .filter(|(_, _, flow_id)| {
                    matches!(registry.get_flow_format(flow_id), Ok(format) if format == is04::FORMAT_VIDEO)
                })
                .map(|(sender_id, label, flow_id)| DiscoveredInput {
                    sender_id,
                    label,
                    flow_id,
                })
                .collect())
        })
        .await;

        let discovered = match result {
            Ok(Ok(discovered)) => discovered,
            Ok(Err(e)) => {
                eprintln!("omp-switcher: discovery poll failed: {e}");
                continue;
            }
            Err(e) => {
                eprintln!("omp-switcher: discovery poll task panicked: {e}");
                continue;
            }
        };

        *inputs.lock().expect("lock poisoned") = discovered.clone();
        pipeline.set_inputs(discovered);
    }
}
