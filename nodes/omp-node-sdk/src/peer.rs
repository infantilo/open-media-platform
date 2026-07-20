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
}

impl PeerClient {
    pub fn new(href: impl Into<String>) -> Self {
        let mut base_url = href.into();
        while base_url.ends_with('/') {
            base_url.pop();
        }
        PeerClient { base_url }
    }

    /// Argumentloser Methodenaufruf (z. B. `activateLowresPreview`,
    /// Kapitel 15 Teil 3) — `{}` als leerer JSON-Body, dasselbe Format,
    /// das `omp_node_sdk::server::route` für `POST /methods/<name>`
    /// erwartet.
    pub fn invoke(&self, name: &str) -> Result<(), RemoteError> {
        let url = format!("{}/methods/{}", self.base_url, name);
        match ureq::post(&url).send_json(serde_json::json!({})) {
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
        let mut response = match ureq::get(&url).call() {
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
