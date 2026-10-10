//! `omp-xy-panel` (Kapitel 38, Nutzerauftrag 2026-10-09): X/Y-Kreuzschiene als
//! Bedienpanel — jede Quelle auf jede Senke schalten, Navigation über
//! Workflows/Gruppen/Nicht zugewiesen, Bouquets und tag-basierte Schaltung.
//!
//! Bewusst **ohne eigene Medienpipeline und ohne eigene Schaltlogik im
//! Backend**: der Node hat weder Sender noch Receiver. Alles Fachliche (Katalog
//! aus `/api/v1/sources` + `/api/v1/sinks`, Gruppenbaum aus dem Layout, Schalten
//! über `POST /api/v1/graph/edges`, Bouquets im Layout-Speicher) läuft im
//! UI-Bundle gegen die Orchestrator-API — damit gelten Rechteprüfung, Audit und
//! Routing-Schleifenschutz des Kerns unverändert, und es gibt keinen zweiten
//! Weg, auf dem eine Verbindung entstehen könnte.

mod uibundle;

use std::sync::Arc;

use omp_node_sdk::{
    Descriptor, InvokeError, MediaReadySource, NodeConfig, ParamStore, RawResponse, SetError,
};
use serde_json::Value;

struct PanelStore;

impl ParamStore for PanelStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![],
            methods: vec![],
            latency: None,
        }
    }

    fn get(&self, _name: &str) -> Option<Value> {
        None
    }

    fn set(&self, name: &str, _value: Value) -> Result<(), SetError> {
        let _ = name;
        Err(SetError::Unknown)
    }

    fn invoke(
        &self,
        _name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
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
    let label = env_or("OMP_LABEL", "X/Y-Panel");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9450").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let store: Arc<dyn ParamStore> = Arc::new(PanelStore);
    let _handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![],
            receivers: vec![],
            instance_id,
            // Kein Medien-I/O, nichts abzuwarten (ARCHITECTURE.md §5 Punkt 6).
            media_ready: MediaReadySource::NotApplicable,
        },
        store,
    )
    .await?;

    tokio::signal::ctrl_c().await?;
    eprintln!("omp-xy-panel: shutdown requested");
    Ok(())
}
