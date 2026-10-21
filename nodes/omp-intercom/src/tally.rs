//! On-Air aus dem Tally-Bus (Kapitel 47.9): sobald einer der konfigurierten Auslöser (`OMP_INTERCOM_ONAIR_SOURCES`,
//! Node-ID oder Name, z. B. der Bildmischer) irgendeine Quelle auf Programm hat, gilt das Studio als On Air —
//! Teilnehmer mit „Mikrofon gesperrt bei On Air“ werden dann stummgeschaltet. Ohne Auslöser wirkt nur der
//! manuell setzbare Parameter `onAir` (kein stilles Auslösen durch irgendeinen Node).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use omp_node_sdk::is04::RegistryClient;

use crate::hub::Hub;

pub struct TriggerFilter {
    filter: Vec<String>,
}

impl TriggerFilter {
    pub fn new(csv: &str) -> Self {
        Self { filter: csv.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect() }
    }

    pub fn is_empty(&self) -> bool {
        self.filter.is_empty()
    }

    pub fn allowed(&self, src: &str, name: Option<&str>) -> bool {
        self.filter.iter().any(|f| f == &src.to_lowercase() || name.is_some_and(|n| f == &n.to_lowercase()))
    }
}

/// Zustand der Auslöser: (Auslöser, Ziel) → an.
#[derive(Default)]
pub struct AirState {
    on: HashSet<(String, String)>,
}

impl AirState {
    pub fn update(&mut self, src: &str, target: &str, on: bool) -> bool {
        let key = (src.to_string(), target.to_string());
        if on {
            self.on.insert(key);
        } else {
            self.on.remove(&key);
        }
        !self.on.is_empty()
    }
}

pub async fn run(hub: Arc<Hub>, filter: TriggerFilter, nats_url: String, registry_url: String) {
    if filter.is_empty() {
        return;
    }
    let mut sub = match omp_node_sdk::health::subscribe_tally(&nats_url, &omp_node_sdk::health::NatsTlsConfig::from_env()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("omp-intercom: Tally nicht abonniert, On-Air nur manuell: {e}");
            return;
        }
    };
    let names: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
    let mut unresolvable: HashSet<String> = HashSet::new();
    let mut state = AirState::default();
    while let Some(ev) = sub.next_event().await {
        let src = ev.src.unwrap_or_default();
        let mut name = names.lock().expect("lock poisoned").get(&src).cloned();
        if name.is_none() && !src.is_empty() && !unresolvable.contains(&src) {
            let (reg, id) = (RegistryClient::new(registry_url.clone()), src.clone());
            match tokio::task::spawn_blocking(move || reg.get_node(&id)).await {
                Ok(Ok(n)) => {
                    names.lock().expect("lock poisoned").insert(src.clone(), n.label.clone());
                    name = Some(n.label);
                }
                _ => {
                    unresolvable.insert(src.clone());
                }
            }
        }
        if !filter.allowed(&src, name.as_deref()) {
            continue;
        }
        let any = state.update(&src, &ev.target, ev.on);
        hub.core.lock().expect("lock poisoned").set_tally_air(any);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_matches_id_or_name_and_empty_filter_matches_nothing() {
        let f = TriggerFilter::new(" Bildmischer , abc ");
        assert!(f.allowed("x", Some("bildmischer")));
        assert!(f.allowed("ABC", None));
        assert!(!f.allowed("x", Some("switcher")));
        assert!(TriggerFilter::new("").is_empty());
        assert!(!TriggerFilter::new("").allowed("x", Some("y")));
    }

    #[test]
    fn on_air_while_any_source_is_on_program() {
        let mut s = AirState::default();
        assert!(s.update("mixer", "cam1", true));
        assert!(s.update("mixer", "cam2", true));
        assert!(s.update("mixer", "cam1", false), "cam2 ist noch an");
        assert!(!s.update("mixer", "cam2", false));
        assert!(!s.update("mixer", "cam3", false), "Aus ohne vorheriges An bleibt aus");
    }
}
