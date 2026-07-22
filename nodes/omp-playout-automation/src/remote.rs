//! Ruft die generische Descriptor-API **eines anderen, bereits laufenden
//! Nodes** über den Orchestrator-Proxy auf (`GET /api/v1/nodes/<id>/
//! params/<name>`, `POST /api/v1/nodes/<id>/methods/<name>`) — exakt
//! dasselbe Wire-Format, das die Flow-Editor-UI seit B6 spricht
//! (`omp-node-sdk::server`, A8), hier vom Control-Plane-Node statt vom
//! Browser aus.
//!
//! **Seit `ARCHITECTURE.md` §24.1 / `UMSETZUNG.md` C16 bewusst NICHT
//! mehr node-zu-node direkt** (frühere Fassung dieses Moduls sprach den
//! `href` eines Ziel-Nodes unmittelbar an) — der direkte Pfad umging die
//! einzige Durchsetzungsstelle des Systems (`orchestrator/internal/
//! httpapi.requireVerbOnNode`, workflow-gescopte `authz`-Prüfung) und
//! hätte jedem netzwerkseitig erreichbaren Prozess erlaubt, einen
//! beliebigen Node fernzusteuern, unabhängig von dessen Workflow-
//! Zugehörigkeit. Dieser Node holt sich stattdessen beim Start (und
//! periodisch erneuert, s. `OrchestratorAuth`) ein Bearer-Service-Token
//! (`POST /api/v1/instances/<eigene-id>/service-token`, Nachweis über
//! das eigene `OMP_LAUNCH_SECRET`) und spricht damit denselben Proxy an,
//! den auch das Operator-UI nutzt — keine zweite API, s. Moduldoku in
//! `main.rs`.

use std::fmt;
use std::sync::{Arc, Mutex};

use omp_node_sdk::is04::RegistryClient;
use serde::Deserialize;
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

#[derive(Deserialize)]
struct ServiceTokenResponse {
    token: String,
}

/// Tauscht das eigene `OMP_LAUNCH_SECRET` gegen ein Bearer-Service-Token
/// (`ARCHITECTURE.md` §24.1) — `instance_id`/`launch_secret` sind vom
/// Orchestrator-Launcher als `OMP_INSTANCE_ID`/`OMP_LAUNCH_SECRET`
/// vorgegeben (leer, wenn der Node außerhalb des Launchers gestartet
/// wurde, z. B. lokale `cargo run`-Entwicklung — dann liefert dieser
/// Aufruf konsequent einen Fehler, kein stiller Fallback auf den alten
/// Direktpfad).
pub fn fetch_service_token(
    orchestrator_url: &str,
    instance_id: &str,
    launch_secret: &str,
) -> Result<String, RemoteError> {
    let url = format!(
        "{}/api/v1/instances/{}/service-token",
        orchestrator_url.trim_end_matches('/'),
        instance_id
    );
    match ureq::post(&url).send_json(serde_json::json!({ "launchSecret": launch_secret })) {
        Ok(mut resp) => {
            let body: ServiceTokenResponse = resp
                .body_mut()
                .read_json()
                .map_err(|e| RemoteError::Request(e.to_string()))?;
            Ok(body.token)
        }
        Err(ureq::Error::StatusCode(code)) => Err(RemoteError::Status(code)),
        Err(e) => Err(RemoteError::Request(e.to_string())),
    }
}

/// Hält das aktuell gültige Service-Token für alle `ProxyClient`-
/// Instanzen gemeinsam vor (`Arc`-geteilt) — ein Hintergrund-Task
/// (`main.rs::token_refresh_loop`) tauscht es lange vor Ablauf
/// (`auth.ServiceTokenTTL` im Orchestrator, 24h) neu ein, damit ein
/// langlebiger Workflow nicht plötzlich die Steuerungsfähigkeit
/// verliert. Bewusst kein 401-getriebenes Reactive-Refresh (würde jeden
/// Aufrufer mit Retry-Logik verkomplizieren) — ein rein zeitbasierter
/// Refresh reicht, weil die TTL bekannt und die Facility-Uhr
/// (Systemzeit) ohnehin für IS-04/NMOS-Zeitstempel synchron sein muss.
#[derive(Debug, Clone, Default)]
pub struct OrchestratorAuth {
    token: Arc<Mutex<Option<String>>>,
}

impl OrchestratorAuth {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, token: String) {
        *self.token.lock().expect("lock poisoned") = Some(token);
    }

    /// `None`, solange noch kein Token geholt werden konnte (z. B. beim
    /// allerersten Start, bevor der Orchestrator erreichbar war) — jeder
    /// `ProxyClient`-Aufruf behandelt das wie einen normalen Fehler
    /// ("Ziel noch nicht aufgelöst"-Äquivalent), kein Sonderfall.
    fn header_value(&self) -> Option<String> {
        self.token
            .lock()
            .expect("lock poisoned")
            .as_ref()
            .map(|t| format!("Bearer {t}"))
    }
}

/// Client für die generische Descriptor-API eines fremden Nodes über den
/// Orchestrator-Proxy — `node_id` ist die NMOS-IS-04-Node-ID (nicht der
/// OMP-Launcher-`OMP_INSTANCE_ID`), exakt das, wonach
/// `orchestrator/internal/httpapi.handleNodeProxy` seinen `{id}`-Pfad-
/// Parameter auflöst (`registry.Store.Get` matcht gegen `NodeResource.id`,
/// s. `resolve_node_id_by_label` unten). Billig klonbar (nur zwei
/// Strings + ein geteiltes `OrchestratorAuth`), damit er problemlos in
/// `spawn_blocking`-Tasks wandert.
#[derive(Debug, Clone)]
pub struct ProxyClient {
    orchestrator_url: String,
    node_id: String,
    auth: OrchestratorAuth,
}

impl ProxyClient {
    pub fn new(orchestrator_url: impl Into<String>, node_id: impl Into<String>, auth: OrchestratorAuth) -> Self {
        let mut orchestrator_url = orchestrator_url.into();
        while orchestrator_url.ends_with('/') {
            orchestrator_url.pop();
        }
        ProxyClient { orchestrator_url, node_id: node_id.into(), auth }
    }

    fn require_auth_header(&self) -> Result<String, RemoteError> {
        self.auth
            .header_value()
            .ok_or_else(|| RemoteError::Request("kein Service-Token verfügbar (Orchestrator noch nicht erreicht?)".to_string()))
    }

    /// Gleiches `ureq::get(...).call()`-Muster wie zuvor (kein eigenes
    /// Timeout-Setup — ureqs Default reicht für Anfragen an den lokalen
    /// Orchestrator).
    pub fn get_param(&self, name: &str) -> Result<Value, RemoteError> {
        let auth_header = self.require_auth_header()?;
        let url = format!(
            "{}/api/v1/nodes/{}/params/{}",
            self.orchestrator_url, self.node_id, name
        );
        match ureq::get(&url).header("Authorization", &auth_header).call() {
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
        let auth_header = self.require_auth_header()?;
        let url = format!(
            "{}/api/v1/nodes/{}/methods/{}",
            self.orchestrator_url, self.node_id, name
        );
        match ureq::post(&url).header("Authorization", &auth_header).send_json(args) {
            Ok(_) => Ok(()),
            Err(ureq::Error::StatusCode(code)) => Err(RemoteError::Status(code)),
            Err(e) => Err(RemoteError::Request(e.to_string())),
        }
    }
}

/// Löst ein per Operator-Label konfiguriertes Ziel (`targetPlayerLabel`/
/// `targetMixerLabel`, `main.rs`) zu dessen aktueller NMOS-IS-04-
/// Node-ID auf — Grundlage dafür, dass der Node kein hartkodiertes
/// Wissen über Adressen/Ports anderer Instanzen braucht (Nutzer-
/// anforderung "so dynamisch wie möglich"). Liefert `None`, wenn kein
/// Node mit exakt diesem Label registriert ist (z. B. noch nicht
/// gestartet) — der Aufrufer behandelt das als "noch nicht verbunden",
/// kein harter Fehler.
///
/// Liefert seit C16 die Node-**ID** statt des `href` (früherer Name:
/// `resolve_href_by_label`) — der Proxy-Pfad adressiert Ziel-Nodes über
/// dieselbe ID, die auch `orchestrator/internal/registry.NodeView.ID`
/// führt, nicht mehr über deren direkt erreichbare Basis-URL.
pub fn resolve_node_id_by_label(registry: &RegistryClient, label: &str) -> Option<String> {
    if label.is_empty() {
        return None;
    }
    let nodes = registry.list_nodes().ok()?;
    nodes.into_iter().find(|n| n.label == label).map(|n| n.id)
}
