//! Lädt `presets::Settings` beim Start vom Orchestrator
//! (`GET /api/v1/node-types/omp-mxf-player/settings`, Postgres-gestützt,
//! s. `orchestrator/internal/httpapi/node_settings_handlers.go`) statt
//! sie fest in `presets.rs` zu codieren (Nutzerwunsch 2026-08-06).
//!
//! Gleiches Service-Token-Muster wie `nodes/omp-playout-automation/src/
//! remote.rs::fetch_service_token` (ARCHITECTURE.md §24.1: kein
//! direkter Node-zu-Node-/Node-zu-Orchestrator-Zugriff ohne Nachweis,
//! `OMP_LAUNCH_SECRET` gegen ein Bearer-Service-Token tauschen) — hier
//! bewusst NICHT die volle `ProxyClient`/`OrchestratorAuth`-Maschinerie
//! aus jenem Modul übernommen (Token-Refresh-Loop, geteilter State über
//! mehrere spätere Aufrufe): dieser Node braucht das Token nur EINMAL,
//! beim Start, um die Einstellungen zu laden — kein langlebiger
//! Steuerkanal wie bei omp-playout-automation.
//!
//! Jeder Fehler (Env-Variablen fehlen — z. B. lokale `cargo run`-
//! Entwicklung ohne Launcher —, Orchestrator nicht erreichbar,
//! Nicht-200-Antwort, ungültiges JSON) fällt auf
//! `presets::default_settings()` zurück statt den Node am Start zu
//! hindern; jeweils mit einer eindeutigen Log-Zeile, welcher Pfad
//! tatsächlich genommen wurde (Diagnostizierbarkeit).

use crate::presets::{self, Settings};

/// Tauscht `launch_secret` gegen ein Bearer-Service-Token — identisches
/// Wire-Format wie `omp-playout-automation::remote::fetch_service_token`
/// (`POST {orchestrator_url}/api/v1/instances/{instance_id}/
/// service-token`, Body `{"launchSecret": ...}`).
fn fetch_service_token(orchestrator_url: &str, instance_id: &str, launch_secret: &str) -> Result<String, String> {
    let url = format!(
        "{}/api/v1/instances/{}/service-token",
        orchestrator_url.trim_end_matches('/'),
        instance_id
    );
    let mut resp = ureq::post(&url)
        .send_json(serde_json::json!({ "launchSecret": launch_secret }))
        .map_err(|e| format!("service-token request failed: {e}"))?;
    let body: serde_json::Value = resp.body_mut().read_json().map_err(|e| format!("service-token response: {e}"))?;
    body.get("token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "service-token response missing 'token' field".to_string())
}

/// Holt das aktuelle Settings-Dokument mit einem bereits gültigen
/// Service-Token.
fn fetch_settings(orchestrator_url: &str, token: &str) -> Result<Settings, String> {
    let url = format!("{}/api/v1/node-types/omp-mxf-player/settings", orchestrator_url.trim_end_matches('/'));
    let mut resp = ureq::get(&url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("settings request failed: {e}"))?;
    resp.body_mut().read_json::<Settings>().map_err(|e| format!("settings response: {e}"))
}

/// Orchestriert Token-Abruf + Settings-Abruf; fällt bei jedem Fehler auf
/// `presets::default_settings()` zurück (s. Moduldoku).
pub fn load_settings(orchestrator_url: &str, instance_id: Option<&str>, launch_secret: &str) -> Settings {
    let Some(instance_id) = instance_id.filter(|_| !launch_secret.is_empty()) else {
        eprintln!(
            "omp-mxf-player: OMP_INSTANCE_ID/OMP_LAUNCH_SECRET fehlen — kein Orchestrator-Abruf möglich, \
             verwende eingebaute ORF-Standard-Presets/-Programmgruppen"
        );
        return presets::default_settings();
    };

    let token = match fetch_service_token(orchestrator_url, instance_id, launch_secret) {
        Ok(token) => token,
        Err(e) => {
            eprintln!("omp-mxf-player: Service-Token-Abruf fehlgeschlagen ({e}) — verwende eingebaute ORF-Standard-Presets/-Programmgruppen");
            return presets::default_settings();
        }
    };

    match fetch_settings(orchestrator_url, &token) {
        Ok(settings) => {
            eprintln!(
                "omp-mxf-player: Einstellungen vom Orchestrator geladen ({} Programmgruppen, {} Presets)",
                settings.groups.len(),
                settings.presets.len()
            );
            settings
        }
        Err(e) => {
            eprintln!("omp-mxf-player: Einstellungen vom Orchestrator konnten nicht geladen werden ({e}) — verwende eingebaute ORF-Standard-Presets/-Programmgruppen");
            presets::default_settings()
        }
    }
}
