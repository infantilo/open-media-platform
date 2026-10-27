//! Diagnose-Anbieter eines Nodes (UMSETZUNG.md Kap. 72.7): `GET /diag/pipelines` liefert den Zustand der registrierten
//! Medien-Pipelines (Elemente, Zustände, Verbindungen, Füllstände), damit der Support sieht, WO Daten stehen bleiben.
//!
//! Das SDK kennt GStreamer nicht: ein Node registriert eine Funktion, die ein JSON-Dokument liefert (für GStreamer-Pipelines
//! `omp_mediaio::diag::snapshot`). Ein Name wird beim erneuten Registrieren ersetzt — baut ein Node seine Pipeline neu, gilt
//! automatisch die neue.

use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Value, json};

/// Liefert den aktuellen Zustand einer Pipeline als JSON.
pub type Provider = Arc<dyn Fn() -> Value + Send + Sync>;

fn registry() -> &'static Mutex<Vec<(String, Provider)>> {
    static R: OnceLock<Mutex<Vec<(String, Provider)>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Vec::new()))
}

/// Meldet eine Pipeline unter `name` an (ersetzt eine frühere Anmeldung mit demselben Namen).
pub fn register(name: &str, provider: Provider) {
    let mut r = registry().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(slot) = r.iter_mut().find(|(n, _)| n == name) {
        slot.1 = provider;
    } else {
        r.push((name.to_string(), provider));
    }
}

/// Antwort von `GET /diag/pipelines`: `{"pipelines": [{"name": …, …Zustand…}]}`. Ohne Anmeldung eine leere Liste.
pub fn snapshot() -> Value {
    // Anbieter außerhalb der Sperre aufrufen: ein langsamer Anbieter blockiert so keine Neuanmeldung.
    let providers: Vec<(String, Provider)> = registry().lock().unwrap_or_else(|p| p.into_inner()).clone();
    let list: Vec<Value> = providers
        .into_iter()
        .map(|(name, p)| {
            let mut v = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p())).unwrap_or_else(|_| json!({"error": "provider panicked"}));
            if let Some(o) = v.as_object_mut() {
                o.insert("name".into(), Value::String(name));
            }
            v
        })
        .collect();
    json!({ "pipelines": list })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_replaces_by_name_and_snapshot_names_entries() {
        register("t-main", Arc::new(|| json!({"state": "Playing"})));
        register("t-main", Arc::new(|| json!({"state": "Paused"})));
        register("t-boom", Arc::new(|| panic!("kaputt")));
        let s = snapshot();
        let list = s["pipelines"].as_array().unwrap();
        let main = list.iter().find(|p| p["name"] == "t-main").unwrap();
        assert_eq!(main["state"], "Paused");
        assert_eq!(list.iter().filter(|p| p["name"] == "t-main").count(), 1);
        let boom = list.iter().find(|p| p["name"] == "t-boom").unwrap();
        assert_eq!(boom["error"], "provider panicked");
    }
}
