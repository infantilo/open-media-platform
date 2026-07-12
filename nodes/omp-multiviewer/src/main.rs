//! omp-multiviewer: dynamische Eingangszahl, Grid-Monitoring aller
//! entdeckten MXL-Video-Sender (Nutzeranforderung 2026-07-12, gleiche
//! §13-Produktions-Microservice-Einordnung wie C10-C12). Discovery rein
//! über IS-04 (gleicher Poll-Stil wie `omp-switcher`, C7): alle ~2s
//! werden alle registrierten MXL-Video-Sender abgefragt, jeder erscheint
//! automatisch als Kachel im Grid — kein manuelles Patchen pro Quelle
//! nötig. Reiner Monitor: kein MXL-Sende-Ausgang, nur MJPEG-über-HTTP
//! (`omp_mediaio::preview`, aus `omp-viewer`/C6 hierher extrahiert) —
//! ein Multiviewer speist in der Praxis eine Bedienplatz-Anzeige, kein
//! weiterverkettbares Programmsignal.

mod pipeline;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_mediaio::preview;
use omp_node_sdk::is04::{self, RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, SetError};
use pipeline::DiscoveredInput;
use serde_json::Value;

struct MultiviewerStore {
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
    preview_url: String,
}

impl ParamStore for MultiviewerStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                // JSON-Array [{senderId,label}] — gleiche Array-Ausnahme
                // wie omp-switchers "inputs" (v0-Schema kennt keinen
                // Array-Typ, docs/descriptor-v0.schema.json).
                ParamSpec {
                    name: "inputs".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                // Generischer Parametername wie omp-viewer (C6) — die
                // Flow-Editor-Kachel (flow-canvas.ts) zeigt jeden Node mit
                // diesem Parameter automatisch als Inline-Vorschau,
                // unabhängig vom Node-Typ (Nutzeranforderung 2026-07-12).
                ParamSpec {
                    name: "previewUrl".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
            ],
            methods: vec![],
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
            "previewUrl" => Some(serde_json::json!(self.preview_url)),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(
        &self,
        _name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Multiviewer");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9380").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Default 0 (freier Port vom OS), gleicher Grund wie omp-viewer C6/C8:
    // mehrere vom Instanz-Launcher gestartete Multiviewer dürfen sich
    // keinen festen Preview-Port teilen.
    let preview_port: u16 = env_or("OMP_MULTIVIEWER_PREVIEW_PORT", "0").parse()?;
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let broadcaster = Arc::new(preview::Broadcaster::new());
    let actual_preview_port =
        preview::spawn(&format!("0.0.0.0:{preview_port}"), broadcaster.clone())?;
    let preview_url = format!("http://{host}:{actual_preview_port}/preview");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config { domain };
    let pipeline_shutdown = shutdown.clone();
    let broadcaster_for_pipeline = broadcaster.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(
            pipeline_config,
            broadcaster_for_pipeline,
            tx,
            pipeline_shutdown,
            ready_tx,
        )
    });

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-multiviewer: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-multiviewer: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let inputs = Arc::new(Mutex::new(Vec::<DiscoveredInput>::new()));

    let store: Arc<dyn ParamStore> = Arc::new(MultiviewerStore {
        inputs: inputs.clone(),
        preview_url,
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url: registry_url.clone(),
            nats_url,
            senders: vec![],
            receivers: vec![],
            instance_id,
        },
        store,
    )
    .await?;

    let discovery = discovery_loop(registry_url, pipeline_handle, inputs);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-multiviewer: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-multiviewer: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-multiviewer: pipeline thread ended");
        }
        _ = discovery => {
            eprintln!("omp-multiviewer: discovery loop ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}

/// Pollt alle 2s die IS-04-Query-API nach MXL-Video-Sendern (gleicher
/// Poll-/Filter-Stil wie `omp-switcher`, C7/C11: `get_flow_format`-Filter
/// auf `format==video`, sonst würden Audio-Sender als Grid-Kacheln
/// auftauchen) — kein Selbstausschluss nötig, der Multiviewer registriert
/// selbst keinen MXL-Sender.
async fn discovery_loop(
    registry_url: String,
    pipeline: pipeline::PipelineHandle,
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
) {
    let registry = RegistryClient::new(registry_url);
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    loop {
        interval.tick().await;
        let registry = registry.clone();
        let result = tokio::task::spawn_blocking(move || -> Result<Vec<DiscoveredInput>, String> {
            let senders = registry.list_senders().map_err(|e| e.to_string())?;
            Ok(senders
                .into_iter()
                .filter(|s| s.transport == TRANSPORT_MXL)
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
                eprintln!("omp-multiviewer: discovery poll failed: {e}");
                continue;
            }
            Err(e) => {
                eprintln!("omp-multiviewer: discovery poll task panicked: {e}");
                continue;
            }
        };

        *inputs.lock().expect("lock poisoned") = discovered.clone();
        pipeline.set_inputs(discovered);
    }
}
