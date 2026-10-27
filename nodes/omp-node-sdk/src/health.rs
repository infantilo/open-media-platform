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
    /// "media-ready"-Signal (`ARCHITECTURE.md` §5 Punkt 6, `UMSETZUNG.md`
    /// D5-prep): ob der Node — zusätzlich zu "Prozess lebt/ist
    /// registriert" (`status`) — tatsächlich Medien produziert/konsumiert.
    /// Ausgewertet von [`crate::node::MediaReadySource`].
    pub media_ready: bool,
    /// Raten-Kennzahlen (z. B. `video_fps`), s. [`crate::kpi`]; leer = nicht gesendet.
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub kpis: std::collections::BTreeMap<String, f64>,
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
    /// Auslöser: Node-ID des Publishers (Mischer, Switcher, Gateway …).
    /// Optional und abwärtskompatibel — ältere Publisher senden nur `on`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
}

/// Vollständiges Tally-Ereignis aus [`TallySubscription::next_event`].
#[derive(Debug, Clone)]
pub struct TallyEvent {
    /// Node, dessen Kachel/Kamera getallyt wird (Subject-Suffix).
    pub target: String,
    pub on: bool,
    /// Auslösender Node, falls der Publisher ihn mitgesendet hat.
    pub src: Option<String>,
}

/// Sammelt Tally-Ereignisse **je Geber** (Kapitel 51): eine Quelle kann von mehreren Gebern (z. B. zwei Bildmischern)
/// gleichzeitig auf Sendung geschaltet sein. Sie gilt als „on“, solange mindestens ein Geber „on“ gemeldet hat — meldet ein
/// Geber „off“, während ein anderer noch „on“ ist, bleibt sie an. Ereignisse ohne Geber (ältere Publisher) zählen als ein
/// gemeinsamer, namenloser Geber.
#[derive(Debug, Default)]
pub struct TallyBoard {
    givers: std::collections::HashMap<String, std::collections::BTreeSet<String>>,
    /// Quellen, über die schon einmal etwas gemeldet wurde: das erste Ereignis ist immer eine Änderung (ein Konsument kennt
    /// den Zustand der Quelle noch nicht — z. B. ein „off“ nach dem Neustart des Audiomischers muss ankommen).
    seen: std::collections::HashSet<String>,
}

impl TallyBoard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Übernimmt ein Ereignis. `Some(on)`, wenn sich der **Gesamtzustand** der Quelle geändert hat (erster Geber an /
    /// letzter Geber aus), sonst `None` — Aufrufer müssen nur dann reagieren.
    pub fn apply(&mut self, ev: &TallyEvent) -> Option<bool> {
        let was = self.is_on(&ev.target);
        let set = self.givers.entry(ev.target.clone()).or_default();
        let giver = ev.src.clone().unwrap_or_default();
        if ev.on {
            set.insert(giver);
        } else {
            set.remove(&giver);
        }
        if set.is_empty() {
            self.givers.remove(&ev.target);
        }
        let now = self.is_on(&ev.target);
        let first = self.seen.insert(ev.target.clone());
        (first || now != was).then_some(now)
    }

    pub fn is_on(&self, target: &str) -> bool {
        self.givers.get(target).is_some_and(|s| !s.is_empty())
    }

    /// Geber, die die Quelle gerade auf Sendung haben (Node-IDs; `""` = unbekannter Geber), sortiert.
    pub fn givers(&self, target: &str) -> Vec<String> {
        self.givers.get(target).map(|s| s.iter().cloned().collect()).unwrap_or_default()
    }

    /// Ein Geber ist verschwunden (Node beendet, ohne „off“ zu senden): alle seine Einträge entfernen. Liefert die Quellen,
    /// deren Gesamtzustand dadurch auf „off“ fiel.
    pub fn drop_giver(&mut self, giver: &str) -> Vec<String> {
        let mut went_off = Vec::new();
        self.givers.retain(|target, set| {
            if set.remove(giver) && set.is_empty() {
                went_off.push(target.clone());
            }
            !set.is_empty()
        });
        went_off
    }
}

#[cfg(test)]
mod tally_board_tests {
    use super::*;

    fn ev(target: &str, on: bool, src: Option<&str>) -> TallyEvent {
        TallyEvent { target: target.into(), on, src: src.map(str::to_string) }
    }

    #[test]
    fn two_givers_one_source_stays_on_until_the_last_one_drops() {
        let mut b = TallyBoard::new();
        assert_eq!(b.apply(&ev("cam", true, Some("mixA"))), Some(true));
        assert_eq!(b.apply(&ev("cam", true, Some("mixB"))), None, "schon an: keine Änderung");
        assert_eq!(b.givers("cam"), ["mixA", "mixB"]);
        assert_eq!(b.apply(&ev("cam", false, Some("mixA"))), None, "mixB hält die Quelle noch auf Sendung");
        assert!(b.is_on("cam"));
        assert_eq!(b.apply(&ev("cam", false, Some("mixB"))), Some(false));
        assert!(!b.is_on("cam"));
        assert!(b.givers("cam").is_empty());
    }

    #[test]
    fn repeated_events_and_unknown_off_are_harmless() {
        let mut b = TallyBoard::new();
        assert_eq!(b.apply(&ev("cam", false, Some("x"))), Some(false), "erste Meldung zu einer Quelle kommt immer an");
        assert_eq!(b.apply(&ev("cam", false, Some("x"))), None);
        assert_eq!(b.apply(&ev("cam", true, Some("x"))), Some(true));
        assert_eq!(b.apply(&ev("cam", true, Some("x"))), None);
    }

    #[test]
    fn publishers_without_giver_count_as_one_anonymous_giver() {
        let mut b = TallyBoard::new();
        assert_eq!(b.apply(&ev("cam", true, None)), Some(true));
        assert_eq!(b.apply(&ev("cam", true, Some("mixB"))), None);
        assert_eq!(b.apply(&ev("cam", false, None)), None);
        assert_eq!(b.givers("cam"), ["mixB"]);
    }

    #[test]
    fn sources_are_independent_and_a_vanished_giver_is_dropped() {
        let mut b = TallyBoard::new();
        b.apply(&ev("cam1", true, Some("mixA")));
        b.apply(&ev("cam2", true, Some("mixA")));
        b.apply(&ev("cam2", true, Some("mixB")));
        let mut off = b.drop_giver("mixA");
        off.sort();
        assert_eq!(off, ["cam1"], "cam2 bleibt durch mixB an");
        assert!(!b.is_on("cam1") && b.is_on("cam2"));
    }
}

/// Auf `omp.player.<node_id>.itemEnded` veröffentlicht (K2-Teil-1,
/// `docs/END-GOAL-FEATURES.md` §2.3 "EOS wird erstklassig") — ein
/// `omp-player`-Node meldet damit, dass die Essenz des zuletzt genommenen
/// (on-air) Items das natürliche Ende erreicht hat. Automations-Scope
/// (K6/C14-C15) konsumiert dieses Event später für automatisches
/// Vorrücken; in K2-Teil-1 selbst hat es noch keinen Abonnenten außer der
/// Verifikation.
#[derive(Debug, Clone, Serialize)]
pub struct ItemEnded {
    pub item_id: String,
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

/// Zerlegt eine ggf. kommagetrennte `OMP_NATS_URL` in einzelne Server-
/// Adressen (ARCHITECTURE.md §19.3 Punkt 7/UMSETZUNG.md D14, NATS-
/// Clustering) — spiegelt `nats.go`s `processUrlString` (Orchestrator/
/// Host-Agent, dieselbe Env-Var), damit ein und derselbe `OMP_NATS_URL`-
/// Wert für Go- UND Rust-Prozesse identisch funktioniert. Nötig, weil
/// `async-nats`s `impl ToServerAddrs for str` die GESAMTE Zeichenkette
/// als EINE Adresse parst, anders als `nats.go` nicht selbst auf Kommas
/// aufteilt (live an einem echten Parse-Fehler bei einer 3-Adressen-URL
/// gefunden, nicht vermutet) — `Vec<String>` nutzt stattdessen
/// `impl<T: AsRef<str>> ToServerAddrs for Vec<T>`. Ein einzelner Eintrag
/// (kein Komma) funktioniert unverändert wie zuvor.
fn parse_server_addrs(url: &str) -> Vec<String> {
    url.split(',')
        .map(|s| s.trim().trim_end_matches('/'))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Optionale mTLS-Konfiguration für die NATS-Verbindung
/// (`ARCHITECTURE.md` §20.4 Restlücke "mTLS für die zehn echten
/// Rust-Node-Typen") — `None`-Felder lassen `apply_tls` unten die
/// jeweilige `async-nats`-Option einfach weg, kein Feld ist Pflicht.
/// Erwartet EIN geteiltes "nats-client"-Zertifikat für jede
/// Rust-Node-Instanz (Scope-Vereinfachung, keine echte Pro-Instanz-
/// Identität, s. `deploy/dev/mtls-issue-cert.sh`-Aufruf in
/// `make mtls-issue-certs` und dieselbe Doku in
/// `orchestrator/internal/config`/`host-agent/main.go`).
#[derive(Debug, Clone, Default)]
pub struct NatsTlsConfig {
    pub cert_file: Option<String>,
    pub key_file: Option<String>,
    pub ca_file: Option<String>,
}

impl NatsTlsConfig {
    /// Liest `OMP_NATS_TLS_CERT_FILE`/`_KEY_FILE`/`_CA_FILE` — aber NUR,
    /// wenn `OMP_NATS_TLS_ENABLED` wahr ist (`1`/`true`, wie beim
    /// Orchestrator, `config.go`). Bugfund 2026-09-30 ("AFV funktioniert
    /// nicht mehr"): `start-omp.sh` exportiert die Pfad-Variablen IMMER
    /// (Defaults unter `.run/mtls`), und `apply_tls` erzwang TLS schon
    /// bei gesetzten Pfaden — gegen einen Klartext-NATS-Cluster (Default,
    /// `make up`) verband sich dadurch KEIN Node mehr; `flush()` in
    /// `publish_tally` hing für immer, Tally und damit Audio-Follow-Video
    /// fielen still aus. Ohne das Enabled-Flag: Klartext, wie dokumentiert.
    pub fn from_env() -> Self {
        let enabled = std::env::var("OMP_NATS_TLS_ENABLED")
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        if !enabled {
            return NatsTlsConfig { cert_file: None, key_file: None, ca_file: None };
        }
        NatsTlsConfig {
            cert_file: std::env::var("OMP_NATS_TLS_CERT_FILE").ok(),
            key_file: std::env::var("OMP_NATS_TLS_KEY_FILE").ok(),
            ca_file: std::env::var("OMP_NATS_TLS_CA_FILE").ok(),
        }
    }
}

/// Wendet `tls` auf `opts` an — nur die tatsächlich gesetzten Felder,
/// `require_tls(true)` nur, wenn mindestens ein Client-Zertifikat
/// konfiguriert ist (sonst bliebe ein NATS-Server, der TLS selbst gar
/// nicht anbietet, unerreichbar; die eigentliche Durchsetzung "muss
/// TLS sein" passiert serverseitig über `--tlsverify`, s. `make
/// nats-tls-up`).
fn apply_tls(
    mut opts: async_nats::ConnectOptions,
    tls: &NatsTlsConfig,
) -> async_nats::ConnectOptions {
    if let Some(ca) = &tls.ca_file {
        opts = opts.add_root_certificates(ca.into());
    }
    if let (Some(cert), Some(key)) = (&tls.cert_file, &tls.key_file) {
        opts = opts.add_client_certificate(cert.into(), key.into());
        opts = opts.require_tls(true);
    }
    opts
}

impl Publisher {
    /// Stellt die Verbindung her. Ein initial nicht erreichbares NATS ist
    /// nicht fatal (`retry_on_initial_connect` + unbegrenzte Reconnects) —
    /// gleiche Resilienz-Linie wie beim Go-Mock-Node und dem Orchestrator
    /// (`internal/eventbus`). `url` darf eine kommagetrennte Liste mehrerer
    /// Server-Adressen sein (s. `parse_server_addrs`) — der Client wählt
    /// dann selbst einen erreichbaren Server und failt automatisch auf
    /// einen anderen um, falls der verbundene Server ausfällt.
    pub async fn connect(url: &str, tls: &NatsTlsConfig) -> Result<Self, async_nats::ConnectError> {
        let opts = apply_tls(
            async_nats::ConnectOptions::new()
                .retry_on_initial_connect()
                .max_reconnects(None)
                .name("omp-node-sdk"),
            tls,
        );
        let client = opts.connect(parse_server_addrs(url)).await?;
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
    pub async fn publish_tally(&self, node_id: &str, on: bool, src: Option<&str>) -> Result<(), PublishError> {
        let subject = format!("omp.tally.{node_id}");
        let payload = serde_json::to_vec(&Tally { on, src: src.map(str::to_string) }).map_err(PublishError::Encode)?;
        self.client
            .publish(subject, payload.into())
            .await
            .map_err(PublishError::Nats)?;
        self.client.flush().await.map_err(PublishError::Flush)
    }

    /// Veröffentlicht ein `ItemEnded`-Event auf
    /// `omp.player.<node_id>.itemEnded` und wartet auf `flush()` — ein
    /// EOS ist wie ein Tally-Wechsel ein diskretes, zeitkritisches
    /// Ereignis (s. `publish_tally`), keine periodische Aktualisierung.
    pub async fn publish_item_ended(
        &self,
        node_id: &str,
        item_id: &str,
    ) -> Result<(), PublishError> {
        let subject = format!("omp.player.{node_id}.itemEnded");
        let payload = serde_json::to_vec(&ItemEnded {
            item_id: item_id.to_string(),
        })
        .map_err(PublishError::Encode)?;
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
pub async fn subscribe_tally(
    url: &str,
    tls: &NatsTlsConfig,
) -> Result<TallySubscription, SubscribeError> {
    let opts = apply_tls(
        async_nats::ConnectOptions::new()
            .retry_on_initial_connect()
            .max_reconnects(None)
            .name("omp-node-sdk-tally-sub"),
        tls,
    );
    let client = opts
        .connect(parse_server_addrs(url))
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
    /// Wie [`Self::next`], aber inklusive des auslösenden Nodes (`src`).
    pub async fn next_event(&mut self) -> Option<TallyEvent> {
        loop {
            let msg = self.subscriber.next().await?;
            let Some(target) = msg.subject.as_str().strip_prefix("omp.tally.") else {
                continue;
            };
            let Ok(tally) = serde_json::from_slice::<Tally>(&msg.payload) else {
                continue;
            };
            return Some(TallyEvent { target: target.to_string(), on: tally.on, src: tally.src });
        }
    }

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

#[cfg(test)]
mod parse_server_addrs_tests {
    use super::*;

    #[test]
    fn single_address_unchanged() {
        assert_eq!(
            parse_server_addrs("nats://localhost:4222"),
            vec!["nats://localhost:4222".to_string()]
        );
    }

    #[test]
    fn splits_comma_separated_addresses() {
        assert_eq!(
            parse_server_addrs("nats://a:4222,nats://b:4222,nats://c:4222"),
            vec![
                "nats://a:4222".to_string(),
                "nats://b:4222".to_string(),
                "nats://c:4222".to_string(),
            ]
        );
    }

    #[test]
    fn trims_whitespace_and_trailing_slash() {
        assert_eq!(
            parse_server_addrs(" nats://a:4222/ , nats://b:4222 "),
            vec!["nats://a:4222".to_string(), "nats://b:4222".to_string()]
        );
    }

    #[test]
    fn drops_empty_entries() {
        assert_eq!(
            parse_server_addrs("nats://a:4222,,nats://b:4222"),
            vec!["nats://a:4222".to_string(), "nats://b:4222".to_string()]
        );
    }
}
