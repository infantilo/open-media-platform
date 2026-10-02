//! Kapitel 27 / P8: Event-Bereitschaft und Medien-Preflight — REINE Logik (keine Uhr, kein HTTP), damit die
//! Zeitrechnung („wann muss die Bereitstellung spätestens starten?“) und die Ausfallrichtlinien isoliert
//! testbar bleiben. Die Aufrufe an den Orchestrator (Verfügbarkeit, Materialisierung als OMP-Prozess) liegen
//! in `main.rs`. Spec §67–73, §181–185.

use serde::{Deserialize, Serialize};

/// Verweis auf ein Asset des OMP-Asset-Systems (Spec §68) — nie nur ein roher Dateipfad.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetRef {
    #[serde(rename = "assetId", default)]
    pub asset_id: String,
    #[serde(rename = "versionId", default, skip_serializing_if = "String::is_empty")]
    pub version_id: String,
    /// Gewünschter Representation-Typ (z. B. „playout“); leer = beste verfügbare.
    #[serde(rename = "representationType", default, skip_serializing_if = "String::is_empty")]
    pub representation_type: String,
}

/// Was geschieht, wenn das Medium zur Sendezeit nicht bereit ist (Spec §73).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MissingPolicy {
    /// Nichts laden: das aktuelle Programm bleibt stehen, der Take schlägt mit Begründung fehl (Standard).
    #[default]
    Hold,
    /// Schwarz senden und den Automatikmodus anhalten (Operator muss entscheiden).
    Stop,
    /// Dieses Event überspringen: das laufende Programm bleibt (HOLD-Steuerevent).
    Skip,
    Black,
    /// Ersatzdatei des Events (`fallbackFile`).
    Fallback,
    /// Standard-Filler des Channels (Parameter `defaultFiller`), sonst Schwarz.
    DefaultFiller,
}

impl MissingPolicy {
    pub fn parse(s: &str) -> Option<MissingPolicy> {
        Some(match s.trim().to_ascii_uppercase().as_str() {
            "" => return None,
            "HOLD" => MissingPolicy::Hold,
            "STOP" => MissingPolicy::Stop,
            "SKIP" => MissingPolicy::Skip,
            "BLACK" => MissingPolicy::Black,
            "FALLBACK" => MissingPolicy::Fallback,
            "DEFAULT_FILLER" => MissingPolicy::DefaultFiller,
            _ => return None,
        })
    }
}

/// Womit ein nicht bereites Medium ersetzt wird.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Substitute {
    /// Gar nichts laden (Fehler mit Begründung).
    Fail,
    Black,
    /// Steuerevent HOLD: Programm unverändert.
    HoldProgram,
    File(String),
}

/// Ergebnis der Richtlinie: Ersatz + ob der Automatikmodus anzuhalten ist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyOutcome {
    pub substitute: Substitute,
    pub stop_auto: bool,
    pub note: String,
}

/// Wendet die Richtlinie an. `fallback_file` = Ersatzdatei des Events, `default_filler` = Channel-Filler.
pub fn apply_policy(policy: MissingPolicy, fallback_file: Option<&str>, default_filler: Option<&str>, why: &str) -> PolicyOutcome {
    let non_empty = |s: Option<&str>| s.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    match policy {
        MissingPolicy::Hold => PolicyOutcome { substitute: Substitute::Fail, stop_auto: false, note: format!("Medium nicht bereit ({why}) — Event gehalten, Programm bleibt") },
        MissingPolicy::Stop => PolicyOutcome { substitute: Substitute::Black, stop_auto: true, note: format!("Medium nicht bereit ({why}) — STOP: Schwarz, Automatik angehalten") },
        MissingPolicy::Skip => PolicyOutcome { substitute: Substitute::HoldProgram, stop_auto: false, note: format!("Medium nicht bereit ({why}) — Event übersprungen, Programm bleibt") },
        MissingPolicy::Black => PolicyOutcome { substitute: Substitute::Black, stop_auto: false, note: format!("Medium nicht bereit ({why}) — Schwarz") },
        MissingPolicy::Fallback => match non_empty(fallback_file) {
            Some(f) => PolicyOutcome { substitute: Substitute::File(f.clone()), stop_auto: false, note: format!("Medium nicht bereit ({why}) — Ersatzdatei „{f}\u{201c}") },
            None => PolicyOutcome { substitute: Substitute::Fail, stop_auto: false, note: format!("Medium nicht bereit ({why}) und keine Ersatzdatei (fallbackFile) gesetzt — Event gehalten") },
        },
        MissingPolicy::DefaultFiller => match non_empty(default_filler) {
            Some(f) => PolicyOutcome { substitute: Substitute::File(f.clone()), stop_auto: false, note: format!("Medium nicht bereit ({why}) — Standard-Filler „{f}\u{201c}") },
            None => PolicyOutcome { substitute: Substitute::Black, stop_auto: false, note: format!("Medium nicht bereit ({why}) — kein Standard-Filler gesetzt, Schwarz") },
        },
    }
}

/// Medien-Bezug eines Events (Kapitel 27 / P8): optionale Asset-Referenz, Ausfallrichtlinie, Ersatzdatei.
/// Flach in den Item-Metadaten (`asset`, `onMissing`, `fallbackFile`) — Altbestände laden unverändert.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<AssetRef>,
    #[serde(rename = "onMissing", default)]
    pub on_missing: MissingPolicy,
    #[serde(rename = "fallbackFile", default, skip_serializing_if = "Option::is_none")]
    pub fallback_file: Option<String>,
}

/// Event-Bereitschaft (Spec §184).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Readiness {
    Ready,
    NotReady,
    Unknown,
}

/// Bildet den Verfügbarkeitszustand des Orchestrators auf die Event-Bereitschaft ab.
pub fn readiness_of(state: &str) -> Readiness {
    match state {
        "READY" => Readiness::Ready,
        "REMOTE_ONLY" | "TRANSFERRING" | "FAILED" | "MISSING" => Readiness::NotReady,
        _ => Readiness::Unknown,
    }
}

/// Sicherheitsabstand zwischen „bereit“ und Sendezeit (Spec §71).
pub const DEFAULT_SAFETY_MARGIN_MS: i64 = 10_000;

/// Entscheidung der Preflight-Schleife für ein noch nicht bereites Medium.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Außerhalb des Preflight-Fensters oder noch genug Zeit: abwarten.
    Wait,
    /// Jetzt starten, um rechtzeitig fertig zu sein.
    Start,
    /// Starten, aber es reicht voraussichtlich nicht mehr (Sendezeit zu nah) — Warnung.
    StartLate { short_by_ms: i64 },
}

/// Spec §71: `bereit-bis = start − margin`; `start-spätestens = bereit-bis − geschätzte Dauer`.
/// `window_ms`: Preflight-Fenster (Spec §72) — davor wird nichts bewegt (kein Dauerkopieren auf Verdacht).
pub fn plan_materialization(now_ms: i64, on_air_ms: i64, estimate_ms: i64, margin_ms: i64, window_ms: i64) -> Plan {
    let until_air = on_air_ms - now_ms;
    if until_air > window_ms {
        return Plan::Wait;
    }
    let ready_by = on_air_ms - margin_ms;
    let start_by = ready_by - estimate_ms;
    if now_ms < start_by - 2_000 && until_air > window_ms / 2 {
        // Genug Puffer: erst in der zweiten Fensterhälfte oder kurz vor `start_by` loslaufen.
        return Plan::Wait;
    }
    let finish = now_ms + estimate_ms;
    if finish > ready_by {
        Plan::StartLate { short_by_ms: finish - ready_by }
    } else {
        Plan::Start
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_parsing() {
        assert_eq!(MissingPolicy::parse("fallback"), Some(MissingPolicy::Fallback));
        assert_eq!(MissingPolicy::parse(" DEFAULT_FILLER "), Some(MissingPolicy::DefaultFiller));
        assert_eq!(MissingPolicy::parse(""), None);
        assert_eq!(MissingPolicy::parse("egal"), None);
        assert_eq!(MissingPolicy::default(), MissingPolicy::Hold);
    }

    #[test]
    fn every_policy_has_a_defined_outcome() {
        let o = |p, fb, df| apply_policy(p, fb, df, "fehlt");
        assert_eq!(o(MissingPolicy::Hold, None, None).substitute, Substitute::Fail);
        let stop = o(MissingPolicy::Stop, None, None);
        assert_eq!((stop.substitute, stop.stop_auto), (Substitute::Black, true));
        assert_eq!(o(MissingPolicy::Skip, None, None).substitute, Substitute::HoldProgram);
        assert_eq!(o(MissingPolicy::Black, None, None).substitute, Substitute::Black);
        assert_eq!(o(MissingPolicy::Fallback, Some("ersatz.mxf"), None).substitute, Substitute::File("ersatz.mxf".into()));
        assert_eq!(o(MissingPolicy::DefaultFiller, None, Some("filler.mxf")).substitute, Substitute::File("filler.mxf".into()));
    }

    #[test]
    fn missing_fallback_never_pretends() {
        // Ohne Ersatzdatei: gehalten statt Phantasie-Ersatz.
        let f = apply_policy(MissingPolicy::Fallback, Some("  "), None, "x");
        assert_eq!(f.substitute, Substitute::Fail);
        assert!(f.note.contains("keine Ersatzdatei"));
        // Ohne Filler: ausdrücklich Schwarz (steht in der Notiz).
        let d = apply_policy(MissingPolicy::DefaultFiller, None, None, "x");
        assert_eq!(d.substitute, Substitute::Black);
        assert!(d.note.contains("kein Standard-Filler"));
    }

    #[test]
    fn readiness_mapping() {
        assert_eq!(readiness_of("READY"), Readiness::Ready);
        for s in ["REMOTE_ONLY", "TRANSFERRING", "FAILED", "MISSING"] {
            assert_eq!(readiness_of(s), Readiness::NotReady, "{s}");
        }
        assert_eq!(readiness_of("???"), Readiness::Unknown);
    }

    const MIN: i64 = 60_000;

    #[test]
    fn waits_outside_the_preflight_window() {
        assert_eq!(plan_materialization(0, 60 * MIN, 20_000, 10_000, 15 * MIN), Plan::Wait);
    }

    #[test]
    fn spec_example_start_exactly_early_enough() {
        // Sendung 10:00, Transfer 20 s, Sicherheitsabstand 10 s → spätestens 09:59:30.
        let air = 10 * 3600 * 1000;
        let at = |t: i64| plan_materialization(t, air, 20_000, 10_000, 15 * MIN);
        assert_eq!(at(air - 14 * MIN), Plan::Wait, "im Fenster, aber noch reichlich Puffer");
        assert_eq!(at(air - 7 * MIN), Plan::Start, "zweite Fensterhälfte: loslaufen");
        assert_eq!(at(air - 30_000), Plan::Start, "genau am Limit (09:59:30)");
    }

    #[test]
    fn too_late_still_starts_and_reports_the_shortfall() {
        let air = 1_000_000;
        // Noch 15 s bis zur Sendung, Transfer braucht 20 s + 10 s Abstand → 15 s zu knapp.
        assert_eq!(plan_materialization(air - 15_000, air, 20_000, 10_000, 15 * MIN), Plan::StartLate { short_by_ms: 15_000 });
        // Sendezeit schon vorbei: sofort, Fehlbetrag = Dauer + Abstand + Verspätung.
        assert!(matches!(plan_materialization(air + 5_000, air, 20_000, 10_000, 15 * MIN), Plan::StartLate { .. }));
    }
}
