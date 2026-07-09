//! Verbindet einen Node mit dem NATS-Event-Bus: veröffentlicht periodisch
//! den Health-Status auf `omp.health.<id>` — Rust-Pendant zu
//! `nodes/mock/internal/health` (Go) — sowie bei Bedarf Alarme auf
//! `omp.alert.<id>` (`UMSETZUNG.md` C2; der Orchestrator abonniert bereits
//! den ganzen `omp.>`-Baum generisch, `internal/eventbus`, daher kein
//! neues Subject-Handling dort nötig). Nutzt den offiziellen
//! `async-nats`-Client, gleiche Ausnahme von der Minimal-Dependency-Regel wie
//! bei `nats.go` im Orchestrator/Mock-Node (`docs/decisions.md`, Schritt A6):
//! ein selbst geschriebener NATS-Client wäre reine Protokoll-Neuimplementierung
//! ohne Gegenwert.

use std::fmt;

use serde::Serialize;

/// Auf `omp.health.<node_id>` veröffentlichter Payload — identisches
/// JSON-Schema wie `health.Status` im Go-Mock-Node.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub node_id: String,
    pub label: String,
    pub status: String,
    pub senders: usize,
    pub receivers: usize,
}

/// Auf `omp.alert.<node_id>` veröffentlichter Payload — ein Node meldet
/// damit einen Fehler (z. B. eine gebrochene GStreamer-Pipeline), ohne den
/// Health-Status selbst zu verfälschen.
#[derive(Debug, Clone, Serialize)]
pub struct Alert {
    pub node_id: String,
    pub message: String,
}

#[derive(Debug)]
pub enum PublishError {
    Encode(serde_json::Error),
    Nats(async_nats::PublishError),
    Flush(async_nats::client::FlushError),
}

impl fmt::Display for PublishError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PublishError::Encode(e) => write!(f, "health publish: encode: {e}"),
            PublishError::Nats(e) => write!(f, "health publish: {e}"),
            PublishError::Flush(e) => write!(f, "health publish: flush: {e}"),
        }
    }
}

impl std::error::Error for PublishError {}

/// Verbindene NATS-Verbindung, über die Health-Snapshots veröffentlicht
/// werden.
pub struct Publisher {
    client: async_nats::Client,
}

impl Publisher {
    /// Stellt die Verbindung her. Ein initial nicht erreichbares NATS ist
    /// nicht fatal (`retry_on_initial_connect` + unbegrenzte Reconnects) —
    /// gleiche Resilienz-Linie wie beim Go-Mock-Node und dem Orchestrator
    /// (`internal/eventbus`).
    pub async fn connect(url: &str) -> Result<Self, async_nats::ConnectError> {
        let client = async_nats::ConnectOptions::new()
            .retry_on_initial_connect()
            .max_reconnects(None)
            .name("omp-node-sdk")
            .connect(url)
            .await?;
        Ok(Publisher { client })
    }

    /// Veröffentlicht status auf `omp.health.<status.node_id>`.
    pub async fn publish(&self, status: &Status) -> Result<(), PublishError> {
        let subject = format!("omp.health.{}", status.node_id);
        let payload = serde_json::to_vec(status).map_err(PublishError::Encode)?;
        self.client
            .publish(subject, payload.into())
            .await
            .map_err(PublishError::Nats)
    }

    /// Veröffentlicht einen Alarm auf `omp.alert.<alert.node_id>` und
    /// wartet auf `flush()`, bevor die Funktion zurückkehrt. Anders als bei
    /// `publish()` (periodischer Health-Herzschlag, nächster Tick holt
    /// Verzögerungen von selbst auf) ist ein Alarm oft das letzte, was ein
    /// Node vor dem Beenden meldet (z. B. ein Pipeline-Fehler,
    /// `UMSETZUNG.md` C2) — `async-nats` puffert Publishes intern und
    /// schreibt sie asynchron; ohne `flush()` kann der Prozess beendet
    /// werden, bevor die Bytes den Socket überhaupt verlassen haben.
    pub async fn publish_alert(&self, alert: &Alert) -> Result<(), PublishError> {
        let subject = format!("omp.alert.{}", alert.node_id);
        let payload = serde_json::to_vec(alert).map_err(PublishError::Encode)?;
        self.client
            .publish(subject, payload.into())
            .await
            .map_err(PublishError::Nats)?;
        self.client.flush().await.map_err(PublishError::Flush)
    }
}
