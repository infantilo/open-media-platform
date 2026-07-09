//! Hoher-Level-Einstiegspunkt des SDK: verbindet Descriptor-HTTP-Server
//! (`server`), IS-04-Registrierung+Heartbeat und NATS-Health-Publisher
//! (`health`) zu dem Lifecycle, den jeder Node braucht — Rust-Pendant zu
//! `main()` im Go-Mock-Node (`nodes/mock/main.go`), als wiederverwendbare
//! Funktion statt kopierbarem Beispielcode.

use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use crate::health;
use crate::is04::{self, Device, HeartbeatError, NodeResource, Receiver, RegistryClient, Sender};
use crate::server::{self, ParamStore};

type BoxError = Box<dyn Error + Send + Sync>;

/// Heartbeat-/Health-Publish-Intervall — wie beim Mock-Node (`UMSETZUNG.md`
/// A7: "alle 5s"), deutlich unter `registration_expiry_interval` (60s,
/// `deploy/nmos/registry.json`).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const REGISTER_RETRY_INTERVAL: Duration = Duration::from_secs(2);

/// Konfiguration eines Nodes: Label, Netzwerk-Adresse, Anzahl simulierter
/// Senders/Receivers, Adressen von Registry und NATS.
pub struct NodeConfig {
    pub label: String,
    pub host: String,
    pub port: u16,
    pub registry_url: String,
    pub nats_url: String,
    pub senders: usize,
    pub receivers: usize,
}

/// Baut IS-04-Resources, registriert sie, startet den Descriptor-Server und
/// hält Heartbeat + Health-Publish am Laufen, bis der Prozess beendet wird.
/// `store` ist die einzige Node-spezifische Eingabe.
pub async fn run(config: NodeConfig, store: Arc<dyn ParamStore>) -> Result<(), BoxError> {
    let node_id = crate::idgen::new_v4();
    let device_id = crate::idgen::new_v4();
    let sender_ids: Vec<String> = (0..config.senders)
        .map(|_| crate::idgen::new_v4())
        .collect();
    let receiver_ids: Vec<String> = (0..config.receivers)
        .map(|_| crate::idgen::new_v4())
        .collect();

    let node_res = NodeResource::new(&node_id, &config.label, &config.host, config.port);
    let device_res = Device::new(
        &device_id,
        &format!("{} Device", config.label),
        &node_id,
        sender_ids.clone(),
        receiver_ids.clone(),
    );
    let senders: Vec<Sender> = sender_ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            Sender::new(
                id,
                &format!("{} Sender {}", config.label, i + 1),
                &device_id,
            )
        })
        .collect();
    let receivers: Vec<Receiver> = receiver_ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            Receiver::new(
                id,
                &format!("{} Receiver {}", config.label, i + 1),
                &device_id,
            )
        })
        .collect();

    let registry = RegistryClient::new(config.registry_url.clone());

    let bind_addr = format!("0.0.0.0:{}", config.port);
    server::spawn(&bind_addr, store)?;

    register_with_retry(&registry, &node_res, &device_res, &senders, &receivers).await;
    eprintln!("omp-node-sdk: node registered: {node_id}");

    let publisher = match health::Publisher::connect(&config.nats_url).await {
        Ok(p) => Some(p),
        Err(e) => {
            eprintln!(
                "omp-node-sdk: nats connect failed, continuing without health publishing: {e}"
            );
            None
        }
    };

    let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
    loop {
        interval.tick().await;

        let registry_clone = registry.clone();
        let node_id_clone = node_id.clone();
        let heartbeat_result =
            tokio::task::spawn_blocking(move || registry_clone.heartbeat(&node_id_clone)).await;
        match heartbeat_result {
            Ok(Ok(())) => {}
            Ok(Err(HeartbeatError::NotRegistered)) => {
                register_with_retry(&registry, &node_res, &device_res, &senders, &receivers).await;
            }
            Ok(Err(e)) => eprintln!("omp-node-sdk: heartbeat failed: {e}"),
            Err(e) => eprintln!("omp-node-sdk: heartbeat task panicked: {e}"),
        }

        if let Some(publisher) = &publisher {
            let status = health::Status {
                node_id: node_id.clone(),
                label: config.label.clone(),
                status: "ok".to_string(),
                senders: config.senders,
                receivers: config.receivers,
            };
            if let Err(e) = publisher.publish(&status).await {
                eprintln!("omp-node-sdk: health publish failed: {e}");
            }
        }
    }
}

/// Registriert Node, Device und alle Senders/Receivers; wiederholt bei
/// Fehlern bis zum Erfolg (verhindert, dass eine kurzzeitig nicht
/// erreichbare Registry den Node abstürzen lässt — gleiche Resilienz-Linie
/// wie `registerWithRetry` im Go-Mock-Node).
async fn register_with_retry(
    registry: &RegistryClient,
    node: &NodeResource,
    device: &Device,
    senders: &[Sender],
    receivers: &[Receiver],
) {
    loop {
        let registry = registry.clone();
        let node = node.clone();
        let device = device.clone();
        let senders = senders.to_vec();
        let receivers = receivers.to_vec();

        let result = tokio::task::spawn_blocking(move || -> Result<(), is04::RegisterError> {
            registry.register("node", &node)?;
            registry.register("device", &device)?;
            for s in &senders {
                registry.register("sender", s)?;
            }
            for r in &receivers {
                registry.register("receiver", r)?;
            }
            Ok(())
        })
        .await;

        match result {
            Ok(Ok(())) => return,
            Ok(Err(e)) => eprintln!("omp-node-sdk: registration failed, retrying: {e}"),
            Err(e) => eprintln!("omp-node-sdk: registration task panicked, retrying: {e}"),
        }
        tokio::time::sleep(REGISTER_RETRY_INTERVAL).await;
    }
}
