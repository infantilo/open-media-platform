//! Ruft die generische Descriptor-API **eines anderen, bereits laufenden
//! Nodes** direkt an dessen eigenem `href` auf (`GET /params/<name>`,
//! `POST /methods/<name>`) — exakt dasselbe Wire-Format, das die
//! Flow-Editor-UI seit B6 über den Orchestrator-Proxy spricht
//! (`omp_node_sdk::server`), hier aber node-zu-node statt browser-zu-
//! Orchestrator. Bewusst kein neuer Mechanismus, nur ein zweiter Client
//! für dieselbe, längst bestehende API (`ARCHITECTURE.md` §13.1/§13.2/
//! §13.3: "dieselben IS-12/14-Methoden … keine zweite API") — identisches
//! Muster/identische Begründung wie `omp-playout-automation/src/
//! remote.rs::PeerClient` (C14/C15), hier ins SDK gehoben, weil Kapitel
//! 15 Teil 3 (`omp-multiviewer`) einen zweiten Konsumenten braucht und
//! `omp-node-sdk` bereits `ureq` als Abhängigkeit mitbringt (keine neue
//! Abhängigkeit in `omp-multiviewer`, Minimal-Dependency-Regel,
//! `UMSETZUNG.md` §0 Punkt 5). `omp-playout-automation`s eigene Kopie
//! bleibt unverändert (nicht angefasst, um dieses bereits ausgelieferte
//! Binary in dieser Sitzung keinem Regressionsrisiko auszusetzen) — die
//! kleine Duplikation ist dokumentiert, s. `docs/decisions.md`.

use std::fmt;

use crate::is04::RegistryClient;

#[derive(Debug)]
pub enum RemoteError {
    Request(String),
    Status(u16),
}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RemoteError::Request(e) => write!(f, "remote: {e}"),
            RemoteError::Status(code) => write!(f, "remote: unexpected status {code}"),
        }
    }
}

impl std::error::Error for RemoteError {}

/// Client für die Descriptor-API eines einzelnen fremden Nodes (dessen
/// IS-04-`href`). Billig klonbar wie `RegistryClient` (nur eine
/// Basis-URL), damit er problemlos in `spawn_blocking`-Tasks wandert.
#[derive(Debug, Clone)]
pub struct PeerClient {
    base_url: String,
    /// Mit Zeitgrenze (`with_timeout`): ein hängender Gegenstand blockiert den Aufrufer dann nicht dauerhaft.
    agent: Option<ureq::Agent>,
}

impl PeerClient {
    pub fn new(href: impl Into<String>) -> Self {
        let mut base_url = rewrite_loopback(&href.into(), std::env::var("OMP_LOOPBACK_ALIAS").ok().as_deref());
        while base_url.ends_with('/') {
            base_url.pop();
        }
        PeerClient { base_url, agent: None }
    }

    /// Setzt eine Gesamt-Zeitgrenze je Aufruf. Ohne sie wartet `ureq` unbegrenzt — für Dauerschleifen (z. B. die
    /// Layout-Kopplung von OGraf, die den Mischer alle 40 ms abfragt) friert ein einziger hängender Aufruf sonst alles ein.
    pub fn with_timeout(mut self, timeout: std::time::Duration) -> Self {
        self.agent = Some(ureq::Agent::config_builder().timeout_global(Some(timeout)).build().into());
        self
    }

    fn get(&self, url: &str) -> ureq::RequestBuilder<ureq::typestate::WithoutBody> {
        match &self.agent {
            Some(a) => a.get(url),
            None => ureq::get(url),
        }
    }

    fn post(&self, url: &str) -> ureq::RequestBuilder<ureq::typestate::WithBody> {
        match &self.agent {
            Some(a) => a.post(url),
            None => ureq::post(url),
        }
    }

    /// Argumentloser Methodenaufruf (z. B. `activateLowresPreview`,
    /// Kapitel 15 Teil 3) — `{}` als leerer JSON-Body, dasselbe Format,
    /// das `omp_node_sdk::server::route` für `POST /methods/<name>`
    /// erwartet.
    pub fn invoke(&self, name: &str) -> Result<(), RemoteError> {
        let url = format!("{}/methods/{}", self.base_url, name);
        match crate::nodeauth::with_token(self.post(&url)).send_json(serde_json::json!({})) {
            Ok(_) => Ok(()),
            Err(ureq::Error::StatusCode(code)) => Err(RemoteError::Status(code)),
            Err(e) => Err(RemoteError::Request(e.to_string())),
        }
    }

    /// Methodenaufruf mit Argumenten (flaches JSON-Objekt wie bei `omp_node_sdk::server::route`).
    pub fn invoke_with(&self, name: &str, args: serde_json::Value) -> Result<(), RemoteError> {
        let url = format!("{}/methods/{}", self.base_url, name);
        match crate::nodeauth::with_token(self.post(&url)).send_json(args) {
            Ok(_) => Ok(()),
            Err(ureq::Error::StatusCode(code)) => Err(RemoteError::Status(code)),
            Err(e) => Err(RemoteError::Request(e.to_string())),
        }
    }

    /// Liest einen einzelnen Parameterwert (`GET /params/<name>`,
    /// zweiter Konsument nach `invoke` — Kapitel 16 Teil 2,
    /// `omp-fabrics-gateway`: die Initiator-Rolle muss den per HTTP
    /// exportierten `fabricsTargetInfo`-String der Target-Rolle auf dem
    /// jeweils anderen Host abholen, ein reiner Werte-Abruf ohne
    /// Methodenaufruf-Semantik). Antwortformat identisch zu
    /// `server::route`s `{"value": ...}`-Hülle.
    pub fn get_param(&self, name: &str) -> Result<serde_json::Value, RemoteError> {
        let url = format!("{}/params/{}", self.base_url, name);
        let mut response = match crate::nodeauth::with_token(self.get(&url)).call() {
            Ok(r) => r,
            Err(ureq::Error::StatusCode(code)) => return Err(RemoteError::Status(code)),
            Err(e) => return Err(RemoteError::Request(e.to_string())),
        };
        let body: serde_json::Value = response
            .body_mut()
            .read_json()
            .map_err(|e| RemoteError::Request(e.to_string()))?;
        body.get("value")
            .cloned()
            .ok_or_else(|| RemoteError::Request("response missing 'value' field".to_string()))
    }
}

/// Läuft der Node in einem Container, ist `127.0.0.1` dort der Container selbst: Die Hrefs anderer Nodes (so in der Registry
/// eingetragen, vom Host aus gesehen) werden dann auf den vom Launcher gesetzten Host-Alias (`OMP_LOOPBACK_ALIAS`, z. B.
/// `host.containers.internal`) umgeschrieben. Ohne Alias (Prozess-Node) bleibt alles unverändert.
pub fn rewrite_loopback(url: &str, alias: Option<&str>) -> String {
    let Some(alias) = alias.filter(|a| !a.is_empty()) else { return url.to_string() };
    for host in ["127.0.0.1", "localhost"] {
        if let Some(rest) = url.strip_prefix("http://").and_then(|r| r.strip_prefix(host)) {
            if rest.is_empty() || rest.starts_with(':') || rest.starts_with('/') {
                return format!("http://{alias}{rest}");
            }
        }
    }
    url.to_string()
}

/// Löst den `href` des Node auf, der den gegebenen Sender besitzt
/// (Sender → Device → Node, Kapitel 15 Teil 3) — `None` bei jedem
/// Fehlschlag auf dem Weg (Sender/Device/Node inzwischen verschwunden,
/// Registry kurzzeitig nicht erreichbar), der Aufrufer behandelt das als
/// "gerade nicht auflösbar", kein harter Fehler (gleiche Nachsicht wie
/// `resolve_href_by_label` in `omp-playout-automation`).
pub fn resolve_owning_node_href(registry: &RegistryClient, sender_id: &str) -> Option<String> {
    let sender = registry.get_sender(sender_id).ok()?;
    let device = registry.get_device(&sender.device_id).ok()?;
    let node = registry.get_node(&device.node_id).ok()?;
    Some(node.href)
}

#[cfg(test)]
mod tests {
    use super::{rewrite_loopback, PeerClient, RemoteError};

    #[test]
    fn loopback_hosts_are_rewritten_only_with_an_alias() {
        let a = Some("host.containers.internal");
        assert_eq!(rewrite_loopback("http://127.0.0.1:9398/", a), "http://host.containers.internal:9398/");
        assert_eq!(rewrite_loopback("http://localhost:80", a), "http://host.containers.internal:80");
        assert_eq!(rewrite_loopback("http://10.0.0.5:9398/", a), "http://10.0.0.5:9398/");
        assert_eq!(rewrite_loopback("http://127.0.0.10:1/", a), "http://127.0.0.10:1/", "kein Präfix-Treffer");
        assert_eq!(rewrite_loopback("http://127.0.0.1:9398/", None), "http://127.0.0.1:9398/");
        assert_eq!(rewrite_loopback("http://127.0.0.1:9398/", Some("")), "http://127.0.0.1:9398/");
    }

    /// Ein Gegenstand, der die Verbindung annimmt, aber nie antwortet, darf den Aufrufer nicht dauerhaft blockieren.
    #[test]
    fn hanging_peer_times_out_instead_of_blocking_forever() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let keep = std::thread::spawn(move || {
            let held: Vec<_> = listener.incoming().take(2).flatten().collect();
            std::thread::sleep(std::time::Duration::from_secs(3));
            drop(held);
        });
        let peer = PeerClient::new(format!("http://127.0.0.1:{port}/")).with_timeout(std::time::Duration::from_millis(300));
        let t = std::time::Instant::now();
        assert!(matches!(peer.get_param("x"), Err(RemoteError::Request(_))));
        assert!(matches!(peer.invoke_with("m", serde_json::json!({})), Err(RemoteError::Request(_))));
        assert!(t.elapsed() < std::time::Duration::from_secs(2), "Zeitgrenze greift nicht: {:?}", t.elapsed());
        keep.join().unwrap();
    }
}
