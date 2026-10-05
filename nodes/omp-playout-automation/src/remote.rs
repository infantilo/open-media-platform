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
use std::time::Duration;

use omp_node_sdk::is04::RegistryClient;
use serde::Deserialize;
use serde_json::Value;

/// Harte Obergrenze für `get_param`/`invoke`-Aufrufe gegen einen
/// Ziel-Node (`ureq`s Default ist unbegrenzt, `Timeouts::default()`
/// lässt `recv_response`/`global` auf `None` — geprüft gegen den
/// vendorten Crate-Quellcode). Ohne diesen Deckel hängt ein Aufruf, der
/// im Ziel-Node auf einen blockierenden Handler trifft (z. B. ein
/// steckengebliebenes GStreamer-Plugin im `append()`-Pfad von
/// `omp-player`/`omp-mxf-player`, s. dortige `probe_duration_ms`-Doku),
/// unbegrenzt lang — und blockiert damit, da dieser Node selbst nur
/// einen einzigen Accept-Loop-Thread hat
/// (`omp_node_sdk::server::accept_loop`), JEDE weitere Anfrage an
/// DIESEN Node (Polls, cue, take, …), nicht nur den einen Aufruf. Eher
/// großzügig gewählt (langsame, aber legitime Operationen wie eine
/// echte Dauer-Probe sollen nicht künstlich abgebrochen werden), aber
/// endlich.
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

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
    pub(crate) fn header_value(&self) -> Option<String> {
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
        match ureq::get(&url)
            .config()
            .timeout_global(Some(CALL_TIMEOUT))
            .build()
            .header("Authorization", &auth_header)
            .call()
        {
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
        match ureq::post(&url)
            .config()
            .timeout_global(Some(CALL_TIMEOUT))
            .build()
            .header("Authorization", &auth_header)
            .send_json(args)
        {
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

/// Alle aktuell in der Registry bekannten Node-Labels, `own_label`
/// ausgeschlossen (dieser Node selbst ist nie ein sinnvolles Player-/
/// Mixer-Ziel) und sortiert — Grundlage für `availableNodes` (`main.rs`),
/// das `targetPlayerLabel`/`targetMixerLabel` von Freitext-Feldern auf
/// eine Auswahl aus tatsächlich vorhandenen Nodes umstellt (Nutzerwunsch
/// 2026-07-22: "wie beim Video-Mixer DSK", dessen Quellauswahl ebenfalls
/// aus Discovery statt manueller Eingabe kommt). Kennt selbst keine
/// Node-Typen (die NMOS-Registrierung führt dafür keine — s.
/// `resolve_node_id_by_label`-Doku, dieselbe Einschränkung): zeigt jeden
/// erreichbaren Node, der Operator wählt anhand des Labels selbst den
/// richtigen aus, genau wie bei jeder anderen Discovery-Liste in diesem
/// Projekt (z. B. `omp-video-mixer-me::discover_keyfill`).
pub fn list_node_labels(registry: &RegistryClient, own_label: &str) -> Vec<String> {
    let mut labels: Vec<String> = registry
        .list_nodes()
        .unwrap_or_default()
        .into_iter()
        .map(|n| n.label)
        .filter(|label| label != own_label)
        .collect();
    labels.sort();
    labels.dedup();
    labels
}

/// Kapitel 27 / P4c: alle Quellen mit Tags aus der einheitlichen Sicht des
/// Orchestrators (`GET /api/v1/sources`) — dieselbe Quelle der Wahrheit wie
/// Playlist-Editor und Mixer (Spec §254/§255), keine eigene Discovery.
pub fn fetch_sources(orchestrator_url: &str, auth: &OrchestratorAuth) -> Result<Vec<omp_resolver::Source>, RemoteError> {
    let header = auth
        .header_value()
        .ok_or_else(|| RemoteError::Request("kein Service-Token verfügbar (Orchestrator noch nicht erreicht?)".to_string()))?;
    let url = format!("{}/api/v1/sources", orchestrator_url.trim_end_matches('/'));
    match ureq::get(&url)
        .config()
        .timeout_global(Some(CALL_TIMEOUT))
        .build()
        .header("Authorization", &header)
        .call()
    {
        Ok(mut resp) => resp.body_mut().read_json().map_err(|e| RemoteError::Request(e.to_string())),
        Err(ureq::Error::StatusCode(code)) => Err(RemoteError::Status(code)),
        Err(e) => Err(RemoteError::Request(e.to_string())),
    }
}

/// POST gegen die Orchestrator-API (nicht den Node-Proxy) mit dem Service-Token (Kapitel 27 / P7:
/// Trigger senden/quittieren). Liefert den JSON-Body; bei einem Fehlerstatus den Fehlertext des
/// Servers (z. B. „darf nicht steuern“), damit der Operator ihn sieht.
pub fn post_json(orchestrator_url: &str, auth: &OrchestratorAuth, path: &str, body: &Value) -> Result<Value, String> {
    let header = auth.header_value().ok_or_else(|| "kein Service-Token verfügbar (Orchestrator noch nicht erreicht?)".to_string())?;
    let url = format!("{}{}", orchestrator_url.trim_end_matches('/'), path);
    let mut resp = ureq::post(&url)
        .config()
        .timeout_global(Some(CALL_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .header("Authorization", &header)
        .send_json(body.clone())
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if (200..300).contains(&status) {
        return resp.body_mut().read_json::<Value>().map_err(|e| e.to_string());
    }
    // 403 mit Zustellungen im Body: Detailtext herausziehen.
    let text = resp.body_mut().read_to_string().unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| {
            v.get("deliveries")?.as_array()?.iter().find_map(|d| d.get("detail")?.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| text.trim().to_string());
    Err(format!("{} (HTTP {status})", if detail.is_empty() { "abgelehnt".to_string() } else { detail }))
}

/// Alle Nodes mit ID und Label, so wie der Orchestrator sie kennt (`GET /api/v1/nodes`): über alle Hosts hinweg.
/// Die lokale Registry kennt auf einem anderen Host oft nur die eigenen Nodes; ein Player oder Mischer von
/// einem anderen Host fehlte dann in der Zielauswahl der Automation.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NodeIndex {
    nodes: Vec<(String, String)>,
}

impl NodeIndex {
    pub fn from_pairs(nodes: Vec<(String, String)>) -> Self {
        Self { nodes }
    }

    /// Node-ID zum exakten Label (leeres Label → `None`).
    pub fn resolve(&self, label: &str) -> Option<String> {
        if label.is_empty() {
            return None;
        }
        self.nodes.iter().find(|(_, l)| l == label).map(|(id, _)| id.clone())
    }

    /// Alle Labels außer `own_label`, sortiert und ohne Doppelte.
    pub fn labels(&self, own_label: &str) -> Vec<String> {
        let mut labels: Vec<String> = self.nodes.iter().map(|(_, l)| l.clone()).filter(|l| l != own_label).collect();
        labels.sort();
        labels.dedup();
        labels
    }
}

/// Node-Liste vom Orchestrator; schlägt der Abruf fehl (kein Token, nicht erreichbar), fällt der Aufrufer auf
/// die lokale Registry zurück ([`node_index_from_registry`]).
pub fn fetch_node_index(orchestrator_url: &str, auth: &OrchestratorAuth) -> Result<NodeIndex, RemoteError> {
    let header = auth
        .header_value()
        .ok_or_else(|| RemoteError::Request("kein Service-Token verfügbar (Orchestrator noch nicht erreicht?)".to_string()))?;
    let url = format!("{}/api/v1/nodes", orchestrator_url.trim_end_matches('/'));
    let mut resp = ureq::get(&url)
        .config()
        .timeout_global(Some(CALL_TIMEOUT))
        .build()
        .header("Authorization", &header)
        .call()
        .map_err(|e| match e {
            ureq::Error::StatusCode(code) => RemoteError::Status(code),
            e => RemoteError::Request(e.to_string()),
        })?;
    let body: Value = resp.body_mut().read_json().map_err(|e| RemoteError::Request(e.to_string()))?;
    Ok(parse_node_index(&body))
}

fn parse_node_index(body: &Value) -> NodeIndex {
    let items = body.as_array().cloned().or_else(|| body.get("nodes").and_then(Value::as_array).cloned()).unwrap_or_default();
    NodeIndex::from_pairs(
        items
            .iter()
            .filter_map(|n| Some((n.get("id")?.as_str()?.to_string(), n.get("label")?.as_str()?.to_string())))
            .collect(),
    )
}

/// Rückfall: Nodes der lokalen NMOS-Registry.
pub fn node_index_from_registry(registry: &RegistryClient) -> NodeIndex {
    NodeIndex::from_pairs(registry.list_nodes().unwrap_or_default().into_iter().map(|n| (n.id, n.label)).collect())
}

#[cfg(test)]
mod node_index_tests {
    use super::*;

    #[test]
    fn resolves_by_exact_label_and_lists_other_labels() {
        let idx = parse_node_index(&serde_json::json!([
            {"id": "a", "label": "Kanal-Player A"},
            {"id": "b", "label": "Kanal-Player B"},
            {"id": "c", "label": "Automation"},
            {"id": "d", "label": "Kanal-Player A"},
            {"label": "ohne id"},
        ]));
        assert_eq!(idx.resolve("Kanal-Player B").as_deref(), Some("b"));
        assert_eq!(idx.resolve("Kanal-Player A").as_deref(), Some("a"), "bei Doppelung gewinnt der erste");
        assert_eq!(idx.resolve(""), None);
        assert_eq!(idx.resolve("gibt es nicht"), None);
        assert_eq!(idx.labels("Automation"), vec!["Kanal-Player A".to_string(), "Kanal-Player B".to_string()]);
    }

    #[test]
    fn accepts_a_wrapped_list() {
        let idx = parse_node_index(&serde_json::json!({"nodes": [{"id": "x", "label": "L"}]}));
        assert_eq!(idx.resolve("L").as_deref(), Some("x"));
    }
}
