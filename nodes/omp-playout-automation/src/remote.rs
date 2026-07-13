//! Ruft die generische Descriptor-API **eines anderen, bereits laufenden
//! Nodes** direkt an dessen eigenem `href` auf (`GET /params/<name>`,
//! `POST /methods/<name>`) — exakt dasselbe Wire-Format, das die
//! Flow-Editor-UI seit B6 über den Orchestrator-Proxy spricht
//! (`omp-node-sdk::server`), hier aber node-zu-node statt browser-zu-
//! Orchestrator. Bewusst kein neuer Mechanismus, nur ein zweiter Client
//! für dieselbe, längst bestehende API (`ARCHITECTURE.md` §13.1/§13.2/
//! §13.3: "dieselben IS-12/14-Methoden … keine zweite API").
//!
//! Kein Umweg über den Orchestrator: jeder Node bringt seinen eigenen
//! Descriptor-Server bereits mit (`omp_node_sdk::server`), der
//! Orchestrator-Proxy (A8) ist nur die Browser-Fassade davon. Ein
//! Controller-Node kann denselben `href` direkt ansprechen, den auch die
//! IS-04-Registry für ihn führt — kein zusätzliches Wissen nötig.

use std::fmt;

use omp_node_sdk::is04::RegistryClient;
use serde_json::Value;

#[derive(Debug)]
pub enum RemoteError {
    Request(String),
    Status(u16),
    UnexpectedBody,
}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RemoteError::Request(e) => write!(f, "remote: {e}"),
            RemoteError::Status(code) => write!(f, "remote: unexpected status {code}"),
            RemoteError::UnexpectedBody => write!(f, "remote: unexpected response body"),
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

    /// Gleiches `ureq::get(...).call()`-Muster wie
    /// `omp_node_sdk::is04::RegistryClient` (kein eigenes Timeout-Setup —
    /// ureqs Default reicht für Anfragen an Nodes im selben Facility-Netz,
    /// gleiche Annahme wie beim bestehenden Registry-Client).
    pub fn get_param(&self, name: &str) -> Result<Value, RemoteError> {
        let url = format!("{}/params/{}", self.base_url, name);
        match ureq::get(&url).call() {
            Ok(mut resp) => {
                let body: Value = resp
                    .body_mut()
                    .read_json()
                    .map_err(|e| RemoteError::Request(e.to_string()))?;
                body.get("value")
                    .cloned()
                    .ok_or(RemoteError::UnexpectedBody)
            }
            Err(ureq::Error::StatusCode(code)) => Err(RemoteError::Status(code)),
            Err(e) => Err(RemoteError::Request(e.to_string())),
        }
    }

    /// `args` ist ein flaches JSON-Objekt (kann `serde_json::json!({})` für
    /// argumentlose Methoden wie `take` sein) — dasselbe Format, das
    /// `omp_node_sdk::server::route` erwartet.
    pub fn invoke(&self, name: &str, args: Value) -> Result<(), RemoteError> {
        let url = format!("{}/methods/{}", self.base_url, name);
        match ureq::post(&url).send_json(args) {
            Ok(_) => Ok(()),
            Err(ureq::Error::StatusCode(code)) => Err(RemoteError::Status(code)),
            Err(e) => Err(RemoteError::Request(e.to_string())),
        }
    }
}

/// Löst ein per Operator-Label konfiguriertes Ziel (`targetPlayerLabel`/
/// `targetMixerLabel`, `main.rs`) zu dessen aktuellem IS-04-`href` auf —
/// Grundlage dafür, dass der Node kein hartkodiertes Wissen über
/// Adressen/Ports anderer Instanzen braucht (Nutzeranforderung "so
/// dynamisch wie möglich"). Liefert `None`, wenn kein Node mit exakt
/// diesem Label registriert ist (z. B. noch nicht gestartet) — der
/// Aufrufer behandelt das als "noch nicht verbunden", kein harter Fehler.
pub fn resolve_href_by_label(registry: &RegistryClient, label: &str) -> Option<String> {
    if label.is_empty() {
        return None;
    }
    let nodes = registry.list_nodes().ok()?;
    nodes.into_iter().find(|n| n.label == label).map(|n| n.href)
}
