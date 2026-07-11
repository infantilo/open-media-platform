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

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

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

/// Auf `omp.tally.<node_id>` veröffentlichter Payload — Body-Schema laut
/// `docs/decisions.md` (2026-07-07, B4) `{"on": bool}`, `node_id` steckt
/// nur im Subject, nicht im Body. Färbt die Kachel des referenzierten
/// Nodes rot, solange `on == true`. Der veröffentlichte `node_id` ist hier
/// bewusst nicht der eigene Node (anders als bei `Status`/`Alert`),
/// sondern der einer fremden Kachel — `omp-video-mixer-me`
/// (`UMSETZUNG.md` C10) veröffentlicht bei jedem Crosspoint-Wechsel ein
/// Tally-Off für den zuvor aktiven und ein Tally-On für den neu aktiven
/// Quell-Node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tally {
    pub on: bool,
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

    /// Veröffentlicht ein Tally-Event auf `omp.tally.<node_id>` und
    /// wartet auf `flush()` — gleiche Begründung wie bei `publish_alert`:
    /// ein Crosspoint-Wechsel ist ein diskretes, zeitkritisches Ereignis
    /// (Operator erwartet sofortiges visuelles Feedback im Graph), kein
    /// periodischer Herzschlag, der einen verzögerten Publish von selbst
    /// aufholen würde.
    pub async fn publish_tally(&self, node_id: &str, on: bool) -> Result<(), PublishError> {
        let subject = format!("omp.tally.{node_id}");
        let payload = serde_json::to_vec(&Tally { on }).map_err(PublishError::Encode)?;
        self.client
            .publish(subject, payload.into())
            .await
            .map_err(PublishError::Nats)?;
        self.client.flush().await.map_err(PublishError::Flush)
    }
}

/// Abonniert den gesamten Tally-Baum (`omp.tally.>`) — Gegenstück zu
/// [`Publisher::publish_tally`], erste Nutzung durch `omp-audio-mixer`s
/// Audio-Follow-Video (`UMSETZUNG.md` C11, `ARCHITECTURE.md` §13.2: „kein
/// neuer Sync-Mechanismus … derselbe Tally-Mechanismus, der heute schon
/// Kacheln im Flow-Editor rot färbt"). Eigene NATS-Verbindung, unabhängig
/// vom `Publisher` (den `NodeHandle` intern für Health/Alert/Tally-Publish
/// hält) — Abonnieren ist ein grundsätzlich anderer Nutzungspfad
/// (Empfangs- statt Sende-Richtung) und nicht jeder Node braucht ihn.
pub async fn subscribe_tally(url: &str) -> Result<TallySubscription, SubscribeError> {
    let client = async_nats::ConnectOptions::new()
        .retry_on_initial_connect()
        .max_reconnects(None)
        .name("omp-node-sdk-tally-sub")
        .connect(url)
        .await
        .map_err(SubscribeError::Connect)?;
    let subscriber = client
        .subscribe("omp.tally.>")
        .await
        .map_err(SubscribeError::Subscribe)?;
    Ok(TallySubscription {
        _client: client,
        subscriber,
    })
}

#[derive(Debug)]
pub enum SubscribeError {
    Connect(async_nats::ConnectError),
    Subscribe(async_nats::SubscribeError),
}

impl fmt::Display for SubscribeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SubscribeError::Connect(e) => write!(f, "tally subscribe: connect: {e}"),
            SubscribeError::Subscribe(e) => write!(f, "tally subscribe: {e}"),
        }
    }
}

impl std::error::Error for SubscribeError {}

/// Offenes Tally-Abonnement. `_client` wird nur gehalten, damit die
/// NATS-Verbindung offen bleibt (kein `Drop`-Sonderverhalten nötig).
pub struct TallySubscription {
    _client: async_nats::Client,
    subscriber: async_nats::Subscriber,
}

impl TallySubscription {
    /// Liefert das nächste Tally-Event als `(node_id, on)`, extrahiert aus
    /// Subject (`omp.tally.<node_id>`) und Body (`{"on": bool}`).
    /// Überspringt Nachrichten, die nicht zum erwarteten Schema passen
    /// (z. B. während eines künftigen Schema-Wechsels), statt den Node
    /// daran abstürzen zu lassen. `None`, wenn die Verbindung endet.
    pub async fn next(&mut self) -> Option<(String, bool)> {
        loop {
            let msg = self.subscriber.next().await?;
            let Some(node_id) = msg.subject.as_str().strip_prefix("omp.tally.") else {
                continue;
            };
            let Ok(tally) = serde_json::from_slice::<Tally>(&msg.payload) else {
                continue;
            };
            return Some((node_id.to_string(), tally.on));
        }
    }
}
