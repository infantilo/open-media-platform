//! `omp-channel-desk` (Kapitel 96, Nutzerwunsch 2026-11-12): Mehrkanal-Platz für Operatoren, die mehrere
//! Playout-Channels betreuen — Übersicht mit Zeitleisten, Gruppen-Start, schneller Channel-Wechsel.
//!
//! Wie `omp-channel-desk` **ohne Medienpipeline und ohne Backend-Logik**: Das UI-Bundle liest die dem Nutzer
//! zugewiesenen Konsolen (`/api/v1/me/consoles`) und bedient die Channel-Nodes über die Orchestrator-API;
//! Rechteprüfung und Audit bleiben damit unverändert beim Kern. Ein Operator bekommt das Panel wie jede
//! andere Konsole per Rollenbindung und sieht darin nur die Channels, die er bedienen darf.

mod uibundle;

use std::sync::Arc;

use omp_node_sdk::{
    Descriptor, InvokeError, MediaReadySource, NodeConfig, ParamStore, RawResponse, SetError,
};
use serde_json::Value;

struct DeskStore;

impl ParamStore for DeskStore {
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
    let label = env_or("OMP_LABEL", "Mehrkanal-Platz");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9451").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let store: Arc<dyn ParamStore> = Arc::new(DeskStore);
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
    eprintln!("omp-channel-desk: shutdown requested");
    Ok(())
}
