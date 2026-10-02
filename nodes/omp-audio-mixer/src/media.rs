//! Ausführung der Media-Automation (Kapitel 26): übersetzt die abstrakten
//! Aktionen aus `rules.rs` (`play`/`resume`/`pause`/`stop`) auf Methoden eines
//! Ziel-Nodes (Media Player) über den **Orchestrator-Proxy** — derselbe
//! Mechanismus wie bei `omp-playout-automation` (`ARCHITECTURE.md` §24.1:
//! Service-Token statt Direktzugriff auf andere Nodes; die Durchsetzung
//! liegt am Proxy). Dies ist eine bewusst schlanke Kopie von dessen
//! `remote.rs` (nur die hier gebrauchten Teile); eine Zusammenführung im
//! `omp-node-sdk` ist ein späterer Aufräumschritt.
//!
//! Fail-Safe (Vorgabe "Media Player reagiert nicht"): Fehler werden nur
//! protokolliert/angezeigt ([`MediaStatus`]); sie verändern nie den
//! Audiozustand eines Kanals. Kurze Timeouts, damit ein hängender Player
//! die Automation nicht blockiert.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_node_sdk::is04::RegistryClient;
use serde_json::Value;

use crate::rules::Action;

const CALL_TIMEOUT: Duration = Duration::from_secs(4);
const DESCRIPTOR_TTL: Duration = Duration::from_secs(30);

/// Letztes Ergebnis einer Automation für einen Kanal (für die UI-Anzeige).
#[derive(Clone, Debug, Default)]
pub struct MediaStatus {
    pub action: String,
    pub method: String,
    pub ok: bool,
    pub error: String,
    pub at_ms: u64,
}

impl MediaStatus {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "action": self.action, "method": self.method, "ok": self.ok,
            "error": self.error, "atMs": self.at_ms,
        })
    }
}

/// Geteiltes Bearer-Token (vom Orchestrator gegen `OMP_LAUNCH_SECRET` getauscht).
#[derive(Clone, Default)]
pub struct OrchestratorAuth {
    token: Arc<Mutex<Option<String>>>,
}

impl OrchestratorAuth {
    pub fn set(&self, token: String) {
        *self.token.lock().expect("lock poisoned") = Some(token);
    }
    pub fn header(&self) -> Option<String> {
        self.token.lock().expect("lock poisoned").as_ref().map(|t| format!("Bearer {t}"))
    }
}

pub fn fetch_service_token(orchestrator_url: &str, instance_id: &str, launch_secret: &str) -> Result<String, String> {
    let url = format!("{}/api/v1/instances/{}/service-token", orchestrator_url.trim_end_matches('/'), instance_id);
    match ureq::post(&url).send_json(serde_json::json!({ "launchSecret": launch_secret })) {
        Ok(mut resp) => {
            let body: Value = resp.body_mut().read_json().map_err(|e| e.to_string())?;
            body.get("token").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "kein token in Antwort".to_string())
        }
        Err(ureq::Error::StatusCode(code)) => Err(format!("HTTP {code}")),
        Err(e) => Err(e.to_string()),
    }
}

/// Wählt aus den Kandidaten einer Aktion den ersten, den das Ziel kennt.
pub fn pick_method(action: Action, available: &[String]) -> Option<(&'static str, Value)> {
    action.candidates().into_iter().find(|(name, _)| available.iter().any(|m| m == name))
}

pub struct MediaExecutor {
    registry: RegistryClient,
    orchestrator_url: String,
    auth: OrchestratorAuth,
    /// node_id → (Methodenliste, Zeitpunkt)
    descriptors: Mutex<HashMap<String, (Vec<String>, Instant)>>,
    pub status: Arc<Mutex<HashMap<String, MediaStatus>>>,
}

impl MediaExecutor {
    pub fn new(registry: RegistryClient, orchestrator_url: String, auth: OrchestratorAuth) -> Self {
        MediaExecutor {
            registry,
            orchestrator_url: orchestrator_url.trim_end_matches('/').to_string(),
            auth,
            descriptors: Mutex::new(HashMap::new()),
            status: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn resolve(&self, label: &str) -> Option<String> {
        self.registry.list_nodes().ok()?.into_iter().find(|n| n.label == label).map(|n| n.id)
    }

    fn methods_of(&self, node_id: &str, auth: &str) -> Result<Vec<String>, String> {
        if let Some((m, at)) = self.descriptors.lock().expect("lock poisoned").get(node_id)
            && at.elapsed() < DESCRIPTOR_TTL
        {
            return Ok(m.clone());
        }
        let url = format!("{}/api/v1/nodes/{}/descriptor", self.orchestrator_url, node_id);
        let mut resp = ureq::get(&url)
            .config()
            .timeout_global(Some(CALL_TIMEOUT))
            .build()
            .header("Authorization", auth)
            .call()
            .map_err(|e| e.to_string())?;
        let body: Value = resp.body_mut().read_json().map_err(|e| e.to_string())?;
        let methods: Vec<String> = body
            .get("methods")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|m| m.get("name").and_then(Value::as_str).map(str::to_string)).collect())
            .unwrap_or_default();
        self.descriptors.lock().expect("lock poisoned").insert(node_id.to_string(), (methods.clone(), Instant::now()));
        Ok(methods)
    }

    /// Führt `action` auf dem Ziel mit Label `target` aus und merkt das Ergebnis je Kanal.
    pub fn run(&self, channel_id: &str, target: &str, action: Action, now_ms: u64) {
        let result = self.try_run(target, action);
        let st = match result {
            Ok(method) => MediaStatus { action: action.as_str().into(), method, ok: true, error: String::new(), at_ms: now_ms },
            Err(e) => {
                eprintln!("omp-audio-mixer: Media-Automation {channel_id} → {target}/{}: {e}", action.as_str());
                MediaStatus { action: action.as_str().into(), method: String::new(), ok: false, error: e, at_ms: now_ms }
            }
        };
        self.status.lock().expect("lock poisoned").insert(channel_id.to_string(), st);
    }

    fn try_run(&self, target: &str, action: Action) -> Result<String, String> {
        let auth = self.auth.header().ok_or("kein Service-Token (Orchestrator nicht erreicht?)")?;
        let node_id = self.resolve(target).ok_or_else(|| format!("Ziel \"{target}\" nicht gefunden"))?;
        let methods = self.methods_of(&node_id, &auth)?;
        let (method, args) = pick_method(action, &methods)
            .ok_or_else(|| format!("Ziel kennt keine passende Methode für {}", action.as_str()))?;
        let url = format!("{}/api/v1/nodes/{}/methods/{}", self.orchestrator_url, node_id, method);
        match ureq::post(&url)
            .config()
            .timeout_global(Some(CALL_TIMEOUT))
            .build()
            .header("Authorization", &auth)
            .send_json(args)
        {
            Ok(_) => Ok(method.to_string()),
            Err(ureq::Error::StatusCode(code)) => Err(format!("HTTP {code}")),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn picks_first_supported_method_per_player_type() {
        // omp-mxf-player-direct: play/stop
        let direct = names(&["play", "stop", "load", "seek"]);
        assert_eq!(pick_method(Action::Play, &direct).unwrap().0, "play");
        assert_eq!(pick_method(Action::Stop, &direct).unwrap().0, "stop");
        assert_eq!(pick_method(Action::Resume, &direct).unwrap().0, "play", "Resume fällt auf play zurück");
        assert!(pick_method(Action::Pause, &direct).is_none(), "kein Pause → sicher: nichts tun");
        // omp-mxf-player: take/setRate
        let playlist = names(&["take", "cue", "setRate", "seek"]);
        assert_eq!(pick_method(Action::Play, &playlist).unwrap().0, "take");
        let (m, args) = pick_method(Action::Pause, &playlist).unwrap();
        assert_eq!((m, args), ("setRate", serde_json::json!({"rate": 0.0})));
        let (m, args) = pick_method(Action::Resume, &playlist).unwrap();
        assert_eq!((m, args), ("setRate", serde_json::json!({"rate": 1.0})));
        assert!(pick_method(Action::None, &playlist).is_none());
    }

    #[test]
    fn missing_token_or_target_is_reported_not_fatal() {
        let ex = MediaExecutor::new(
            RegistryClient::new("http://127.0.0.1:1".to_string()),
            "http://127.0.0.1:1".to_string(),
            OrchestratorAuth::default(),
        );
        ex.run("ch1", "Player 1", Action::Play, 5);
        let st = ex.status.lock().unwrap().get("ch1").cloned().unwrap();
        assert!(!st.ok);
        assert!(st.error.contains("Service-Token"), "{}", st.error);
        assert_eq!(st.action, "play");
    }
}
