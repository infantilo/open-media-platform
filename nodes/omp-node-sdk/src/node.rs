//! Hoher-Level-Einstiegspunkt des SDK: verbindet Descriptor-HTTP-Server
//! (`server`), IS-04-Registrierung+Heartbeat und NATS-Health-Publisher
//! (`health`) zu dem Lifecycle, den jeder Node braucht — Rust-Pendant zu
//! `main()` im Go-Mock-Node (`nodes/mock/main.go`), als wiederverwendbare
//! Funktion statt kopierbarem Beispielcode.
//!
//! `start()` gibt sofort ein [`NodeHandle`] zurück und hält
//! Registrierung/Heartbeat/Health-Publish als Hintergrund-Task am Laufen —
//! nötig, damit Nodes mit eigener Nutzlast (z. B. der Playout-Node mit
//! seiner GStreamer-Pipeline, `UMSETZUNG.md` C2) nebenläufig arbeiten und
//! zusätzliche Events (z. B. Alarme) über dieselbe NATS-Verbindung
//! veröffentlichen können. `run()` bleibt als einfacher Wrapper für Nodes
//! ohne eigene Nutzlast (z. B. `examples/hello_node.rs`).

use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use crate::health;
use crate::is04::{
    self, Device, Flow, HeartbeatError, NodeResource, Receiver, RegistryClient, Sender, Source,
};
use crate::server::{self, ParamStore};

type BoxError = Box<dyn Error + Send + Sync>;

/// Heartbeat-/Health-Publish-Intervall — wie beim Mock-Node (`UMSETZUNG.md`
/// A7: "alle 5s"), deutlich unter `registration_expiry_interval` (60s,
/// `deploy/nmos/registry.json`).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const REGISTER_RETRY_INTERVAL: Duration = Duration::from_secs(2);

/// Konfiguration eines Nodes: Label, Netzwerk-Adresse, Senders/Receivers,
/// Adressen von Registry und NATS.
pub struct NodeConfig {
    pub label: String,
    pub host: String,
    pub port: u16,
    pub registry_url: String,
    pub nats_url: String,
    pub senders: Vec<SenderSpec>,
    pub receivers: Vec<ReceiverSpec>,
}

/// Beschreibt einen einzelnen Sender. `id`/`manifest_href` sind optional:
/// ohne beides verhält sich ein Sender wie bisher (auto-generierte ID,
/// kein Manifest). Nodes, die ihre eigene Sender-ID vorab kennen müssen
/// (z. B. um `manifest_href` auf einen von der ID abhängigen Pfad wie
/// `.../senders/<id>/transportfile` zu setzen, `UMSETZUNG.md` C3), geben
/// `id` selbst vor (`crate::idgen::new_v4()`) statt es generieren zu
/// lassen. `transport` überschreibt den Default (RTP) — z. B.
/// `is04::TRANSPORT_MXL`. `flow` registriert zusätzlich eine Source+Flow
/// und setzt `flow_id` auf dem Sender (`UMSETZUNG.md` C4: Flow-UUID ==
/// MXL-`flow-id`-Konvention — `FlowSpec.id` sollte daher die tatsächliche
/// MXL-`flow-id` des Nodes sein, nicht separat generiert werden).
#[derive(Default)]
pub struct SenderSpec {
    pub id: Option<String>,
    pub manifest_href: Option<String>,
    pub transport: Option<String>,
    pub flow: Option<FlowSpec>,
}

/// Video-Flow-Angaben für einen MXL-Sender (`SenderSpec::flow`). `id` sollte
/// die MXL-`flow-id` des schreibenden Nodes sein (Konvention Flow-UUID ==
/// MXL-flow-id, `UMSETZUNG.md` C4) — ohne `id` wird eine neue UUID generiert,
/// die dann selbst als MXL-`flow-id` verwendet werden muss.
pub struct FlowSpec {
    pub id: Option<String>,
    pub frame_width: u32,
    pub frame_height: u32,
    pub grain_rate_numerator: u32,
    pub grain_rate_denominator: u32,
}

/// Beschreibt einen einzelnen Receiver. `id` optional wie bei
/// [`SenderSpec`]: Nodes, die vorab eine eigene IS-05-Receiver-Connection-
/// API dafür anbieten müssen (z. B. `omp-viewer`, `UMSETZUNG.md` C6, über
/// `crate::connection::ReceiverConnection`), geben `id` selbst vor
/// (`crate::idgen::new_v4()`), damit sie den `ReceiverConnection`-Endpoint
/// vor dem Aufruf von `start()` unter der endgültigen ID verdrahten
/// können — gleiches Henne-Ei-Problem wie bei `SenderSpec::id`/
/// `manifest_href`. `transport`/`media_types` überschreiben die RTP-
/// Defaults (z. B. `is04::TRANSPORT_MXL` + `["video/v210"]`).
#[derive(Default)]
pub struct ReceiverSpec {
    pub id: Option<String>,
    pub transport: Option<String>,
    pub media_types: Option<Vec<String>>,
}

/// Griff auf einen laufenden Node: Identität + (falls NATS erreichbar war)
/// die Möglichkeit, zusätzliche Events wie Alarme zu veröffentlichen.
#[derive(Clone)]
pub struct NodeHandle {
    pub node_id: String,
    publisher: Option<Arc<health::Publisher>>,
}

impl NodeHandle {
    /// Veröffentlicht einen Alarm auf `omp.alert.<node_id>` (z. B. bei
    /// einem Pipeline-Fehler, `UMSETZUNG.md` C2). Kein NATS verbunden ⇒
    /// stiller No-Op, nur eine Log-Zeile — Alarme sind Zusatzinformation,
    /// kein Ersatz für den Health-Mechanismus.
    pub async fn publish_alert(&self, message: impl Into<String>) {
        let Some(publisher) = &self.publisher else {
            eprintln!(
                "omp-node-sdk: alert dropped (no nats connection): {}",
                message.into()
            );
            return;
        };
        let alert = health::Alert {
            node_id: self.node_id.clone(),
            message: message.into(),
        };
        if let Err(e) = publisher.publish_alert(&alert).await {
            eprintln!("omp-node-sdk: alert publish failed: {e}");
        }
    }
}

/// Baut IS-04-Resources, registriert sie, startet den Descriptor-Server und
/// hält Heartbeat + Health-Publish als Hintergrund-Task am Laufen. `store`
/// ist die einzige Node-spezifische Eingabe. Gibt sofort nach erfolgreicher
/// Erstregistrierung zurück.
pub async fn start(config: NodeConfig, store: Arc<dyn ParamStore>) -> Result<NodeHandle, BoxError> {
    let node_id = crate::idgen::new_v4();
    let device_id = crate::idgen::new_v4();
    let sender_ids: Vec<String> = config
        .senders
        .iter()
        .map(|spec| spec.id.clone().unwrap_or_else(crate::idgen::new_v4))
        .collect();
    let receiver_ids: Vec<String> = config
        .receivers
        .iter()
        .map(|spec| spec.id.clone().unwrap_or_else(crate::idgen::new_v4))
        .collect();

    let node_res = NodeResource::new(&node_id, &config.label, &config.host, config.port);
    let device_res = Device::new(
        &device_id,
        &format!("{} Device", config.label),
        &node_id,
        sender_ids.clone(),
        receiver_ids.clone(),
    );
    let mut sources: Vec<Source> = vec![];
    let mut flows: Vec<Flow> = vec![];
    let senders: Vec<Sender> = sender_ids
        .iter()
        .zip(&config.senders)
        .enumerate()
        .map(|(i, (id, spec))| {
            let label = format!("{} Sender {}", config.label, i + 1);
            let mut sender = Sender::new(id, &label, &device_id);
            sender.manifest_href = spec.manifest_href.clone();
            if let Some(transport) = &spec.transport {
                sender.transport = transport.clone();
            }
            if let Some(flow_spec) = &spec.flow {
                let source_id = crate::idgen::new_v4();
                let flow_id = flow_spec.id.clone().unwrap_or_else(crate::idgen::new_v4);
                sources.push(Source::new_video(&source_id, &label, &device_id));
                flows.push(Flow::new_video(
                    &flow_id,
                    &label,
                    &device_id,
                    &source_id,
                    flow_spec.frame_width,
                    flow_spec.frame_height,
                    flow_spec.grain_rate_numerator,
                    flow_spec.grain_rate_denominator,
                ));
                sender.flow_id = Some(flow_id);
            }
            sender
        })
        .collect();
    let sender_count = senders.len();
    let receiver_count = config.receivers.len();
    let receivers: Vec<Receiver> = receiver_ids
        .iter()
        .zip(&config.receivers)
        .enumerate()
        .map(|(i, (id, spec))| {
            let mut receiver = Receiver::new(
                id,
                &format!("{} Receiver {}", config.label, i + 1),
                &device_id,
            );
            if let Some(transport) = &spec.transport {
                receiver.transport = transport.clone();
            }
            if let Some(media_types) = &spec.media_types {
                receiver.caps.media_types = media_types.clone();
            }
            receiver
        })
        .collect();

    let registry = RegistryClient::new(config.registry_url.clone());

    let bind_addr = format!("0.0.0.0:{}", config.port);
    server::spawn(&bind_addr, store)?;

    register_with_retry(
        &registry,
        &node_res,
        &device_res,
        &sources,
        &flows,
        &senders,
        &receivers,
    )
    .await;
    eprintln!("omp-node-sdk: node registered: {node_id}");

    let publisher = match health::Publisher::connect(&config.nats_url).await {
        Ok(p) => Some(Arc::new(p)),
        Err(e) => {
            eprintln!(
                "omp-node-sdk: nats connect failed, continuing without health publishing: {e}"
            );
            None
        }
    };

    let handle = NodeHandle {
        node_id: node_id.clone(),
        publisher: publisher.clone(),
    };

    tokio::spawn(heartbeat_loop(
        registry,
        node_id,
        node_res,
        device_res,
        sources,
        flows,
        senders,
        receivers,
        publisher,
        config.label,
        sender_count,
        receiver_count,
    ));

    Ok(handle)
}

/// Wie `start()`, hält den aufrufenden Task danach aber unbegrenzt am
/// Laufen — für Nodes ohne eigene Nutzlast (z. B. `hello_node`), die
/// selbst nichts anderes zu tun haben, als registriert zu bleiben.
pub async fn run(config: NodeConfig, store: Arc<dyn ParamStore>) -> Result<(), BoxError> {
    let _handle = start(config, store).await?;
    std::future::pending().await
}

#[allow(clippy::too_many_arguments)]
async fn heartbeat_loop(
    registry: RegistryClient,
    node_id: String,
    node_res: NodeResource,
    device_res: Device,
    sources: Vec<Source>,
    flows: Vec<Flow>,
    senders: Vec<Sender>,
    receivers: Vec<Receiver>,
    publisher: Option<Arc<health::Publisher>>,
    label: String,
    sender_count: usize,
    receiver_count: usize,
) {
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
                register_with_retry(
                    &registry,
                    &node_res,
                    &device_res,
                    &sources,
                    &flows,
                    &senders,
                    &receivers,
                )
                .await;
            }
            Ok(Err(e)) => eprintln!("omp-node-sdk: heartbeat failed: {e}"),
            Err(e) => eprintln!("omp-node-sdk: heartbeat task panicked: {e}"),
        }

        if let Some(publisher) = &publisher {
            let status = health::Status {
                node_id: node_id.clone(),
                label: label.clone(),
                status: "ok".to_string(),
                senders: sender_count,
                receivers: receiver_count,
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
#[allow(clippy::too_many_arguments)]
async fn register_with_retry(
    registry: &RegistryClient,
    node: &NodeResource,
    device: &Device,
    sources: &[Source],
    flows: &[Flow],
    senders: &[Sender],
    receivers: &[Receiver],
) {
    loop {
        let registry = registry.clone();
        let node = node.clone();
        let device = device.clone();
        let sources = sources.to_vec();
        let flows = flows.to_vec();
        let senders = senders.to_vec();
        let receivers = receivers.to_vec();

        let result = tokio::task::spawn_blocking(move || -> Result<(), is04::RegisterError> {
            registry.register("node", &node)?;
            registry.register("device", &device)?;
            for s in &sources {
                registry.register("source", s)?;
            }
            for f in &flows {
                registry.register("flow", f)?;
            }
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
