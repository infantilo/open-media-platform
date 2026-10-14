//! Tally für die Handy-Kamera (Nutzerwunsch 2026-10-14: "tally muss sich bis zur Webseite
//! durchschlagen"). Der Node hört den NATS-Tally-Baum (`omp.tally.>`) ab; Ereignisse für den
//! EIGENEN Node (`omp.tally.<eigene node_id>`, vom Bildmischer/Switcher beim Programm-Wechsel
//! gesendet) setzen den Zustand, den die Sendeseite per `GET /tally` abfragt.
//!
//! Auslöser: `OMP_TALLY_SOURCES` (kommagetrennt, Node-ID ODER Node-Name; leer = jeder Node).
//! Tally ist an, solange mindestens ein zugelassener Auslöser "on" meldet.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use omp_node_sdk::is04::RegistryClient;

pub struct TallyState {
    node_id: OnceLock<String>,
    filter: Vec<String>,
    /// Auslöser (Node-ID, "" = unbekannt/älterer Publisher) → "on".
    on: Mutex<HashMap<String, bool>>,
    /// node_id → Name, für den Filter nach Namen und die Anzeige.
    names: Mutex<HashMap<String, String>>,
}

impl TallyState {
    pub fn new(filter_csv: &str) -> Arc<Self> {
        Arc::new(Self {
            node_id: OnceLock::new(),
            filter: filter_csv.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect(),
            on: Mutex::new(HashMap::new()),
            names: Mutex::new(HashMap::new()),
        })
    }

    pub fn set_node_id(&self, id: &str) {
        let _ = self.node_id.set(id.to_string());
    }

    fn allowed(&self, src: &str, name: Option<&str>) -> bool {
        self.filter.is_empty()
            || self.filter.iter().any(|f| f == &src.to_lowercase() || name.is_some_and(|n| f == &n.to_lowercase()))
    }

    /// `GET /tally`-Antwort.
    pub fn json(&self) -> serde_json::Value {
        let on = self.on.lock().expect("lock poisoned");
        let names = self.names.lock().expect("lock poisoned");
        let mut sources: Vec<String> =
            on.iter().filter(|(_, v)| **v).map(|(k, _)| names.get(k).cloned().unwrap_or_else(|| k.clone())).collect();
        sources.sort();
        serde_json::json!({"on": !sources.is_empty(), "sources": sources})
    }
}

/// Abonniert den Tally-Bus und pflegt `state` (läuft bis der Task beendet wird).
pub async fn run(state: Arc<TallyState>, nats_url: String, registry_url: String) {
    let mut sub = match omp_node_sdk::health::subscribe_tally(&nats_url, &omp_node_sdk::health::NatsTlsConfig::from_env()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("omp-webrtc-gateway: tally subscribe failed, Tally inaktiv: {e}");
            return;
        }
    };
    let mut unresolvable: HashSet<String> = HashSet::new();
    while let Some(ev) = sub.next_event().await {
        if state.node_id.get().map(String::as_str) != Some(ev.target.as_str()) {
            continue;
        }
        let src = ev.src.unwrap_or_default();
        let mut name = state.names.lock().expect("lock poisoned").get(&src).cloned();
        if name.is_none() && !src.is_empty() && !unresolvable.contains(&src) {
            let (reg, id) = (RegistryClient::new(registry_url.clone()), src.clone());
            match tokio::task::spawn_blocking(move || reg.get_node(&id)).await {
                Ok(Ok(n)) => {
                    state.names.lock().expect("lock poisoned").insert(src.clone(), n.label.clone());
                    name = Some(n.label);
                }
                _ => {
                    unresolvable.insert(src.clone());
                }
            }
        }
        if !state.allowed(&src, name.as_deref()) {
            continue;
        }
        let mut on = state.on.lock().expect("lock poisoned");
        if ev.on {
            on.insert(src, true);
        } else {
            on.remove(&src);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_by_id_or_name_and_multi_source() {
        let s = TallyState::new(" Mixer A , abc ");
        assert!(s.allowed("xyz", Some("mixer a")));
        assert!(s.allowed("ABC", None));
        assert!(!s.allowed("xyz", Some("switcher")));
        assert!(TallyState::new("").allowed("anything", None));
        s.on.lock().unwrap().insert("abc".into(), true);
        assert_eq!(s.json()["on"], true);
    }
}
