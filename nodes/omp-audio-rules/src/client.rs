//! Lädt das Dokument `audio-rules` beim Start vom Orchestrator (Feature `client`).
//!
//! Gleiches Service-Token-Muster wie `omp-playout-automation::remote` (`OMP_LAUNCH_SECRET` gegen ein
//! Bearer-Token tauschen). Jeder Fehler (kein Launcher, nicht erreichbar, ungültig) fällt mit
//! Log-Zeile auf die eingebauten Standardwerte zurück, damit der Node immer startet.

use crate::{AudioSettings, defaults};

fn service_token(orchestrator_url: &str, instance_id: &str, launch_secret: &str) -> Result<String, String> {
    let url = format!("{}/api/v1/instances/{}/service-token", orchestrator_url.trim_end_matches('/'), instance_id);
    let mut resp = ureq::post(&url).send_json(serde_json::json!({ "launchSecret": launch_secret })).map_err(|e| format!("service-token request failed: {e}"))?;
    let body: serde_json::Value = resp.body_mut().read_json().map_err(|e| format!("service-token response: {e}"))?;
    body.get("token").and_then(|v| v.as_str()).map(str::to_string).ok_or_else(|| "service-token response missing 'token' field".to_string())
}

/// Strenger Abruf: jeder Fehler (kein Launcher, nicht erreichbar, ungültiges Dokument) ist ein `Err`.
/// Für „Neu laden“ im laufenden Betrieb, wo ein Fehler sichtbar werden soll statt still auf Standard zu fallen.
pub fn fetch_settings(orchestrator_url: &str, instance_id: Option<&str>, launch_secret: &str) -> Result<AudioSettings, String> {
    // Entwicklungs-/Testhilfe: `OMP_AUDIO_RULES_FILE` zeigt auf ein Dokument, das statt des Orchestrator-Stands gilt.
    if let Ok(path) = std::env::var("OMP_AUDIO_RULES_FILE") {
        let s: AudioSettings = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?).map_err(|e| format!("{path}: {e}"))?;
        let errs = s.validate();
        return if errs.is_empty() { Ok(s) } else { Err(format!("{path} ungültig ({})", errs.join("; "))) };
    }
    let instance_id = instance_id.filter(|_| !launch_secret.is_empty()).ok_or("OMP_INSTANCE_ID/OMP_LAUNCH_SECRET fehlen")?;
    let token = service_token(orchestrator_url, instance_id, launch_secret)?;
    let url = format!("{}/api/v1/audio-rules", orchestrator_url.trim_end_matches('/'));
    let s = ureq::get(&url)
        .header("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("Abruf fehlgeschlagen: {e}"))
        .and_then(|mut r| r.body_mut().read_json::<AudioSettings>().map_err(|e| format!("Antwort ungültig: {e}")))?;
    let errs = s.validate();
    if errs.is_empty() { Ok(s) } else { Err(format!("Dokument ungültig ({})", errs.join("; "))) }
}

/// `node` ist nur der Präfix der Log-Zeilen (z. B. "omp-channel-player"). Beim Start: jeder Fehler
/// fällt mit Log-Zeile auf die eingebauten Standardwerte zurück.
pub fn load_settings(node: &str, orchestrator_url: &str, instance_id: Option<&str>, launch_secret: &str) -> AudioSettings {
    match fetch_settings(orchestrator_url, instance_id, launch_secret) {
        Ok(s) => {
            eprintln!("{node}: Audio-Einstellungen geladen ({} Zielgruppen, {} Zuordnungen)", s.output_profile.groups.len(), s.mappings.len());
            s
        }
        Err(why) => {
            eprintln!("{node}: Audio-Einstellungen: {why} — verwende eingebaute Standardwerte");
            defaults::default_settings()
        }
    }
}
