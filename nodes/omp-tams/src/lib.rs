//! TAMS (Time-addressable Media Store) — Bausteine für Aufnahme und Wiedergabe (Kapitel 105).
//!
//! Normlage: TAMS-API **Version 8.2** (Repository `bbc/tams`, Commit `16c1db08`, Apache 2.0), AppNotes 0002, 0008, 0012.
//! Entwurf und Entscheidungen: `docs/entwuerfe/ENTWURF-TAMS.md`.
//!
//! Dieses Crate ist **rein** (kein GStreamer, kein MXL, kein Netz). Der HTTP-Client folgt in 105.2.
//!
//! * [`time`]   — `Timestamp` und `TimeRange` (Format, Vergleich, Überlappung, Verschiebung).
//! * [`index`]  — MXL-Index ↔ Timestamp, bitgleich zur MXL-Bibliothek (`IndexConversion.hpp`).
//! * [`mpegts`] — MPEG-TS-Zeit: `ts_offset` und PTS-Überlauf (AppNote 0002).
//! * [`types`]  — Nutzlasten (Flow, Segment, Storage, Dienst) für die JSON-API.

pub mod index;
pub mod mpegts;
pub mod time;
pub mod types;

/// API-Version, gegen die dieses Crate gebaut ist (Entscheidung D-T4).
pub const API_VERSION: &str = "8.2";
/// Hauptversion; ein Dienst mit anderer Hauptversion wird abgelehnt (D-T4).
pub const API_MAJOR: u32 = 8;

/// Ergebnis der Versionsprüfung nach D-T4.
#[derive(Debug, PartialEq, Eq)]
pub enum VersionCheck {
    /// Gleiche Haupt- und Nebenversion oder ältere Nebenversion.
    Ok,
    /// Gleiche Hauptversion, aber der Dienst ist neuer: läuft, mit Warnung.
    NewerMinor,
    /// Andere Hauptversion oder nicht lesbar: ablehnen.
    Reject(String),
}

/// Prüft `api_version` aus `GET /service` (Format `Major.Minor`) nach D-T4.
pub fn check_api_version(service_version: &str) -> VersionCheck {
    let mut it = service_version.trim().split('.');
    let (Some(a), Some(b), None) = (it.next(), it.next(), it.next()) else {
        return VersionCheck::Reject(format!("api_version {service_version:?} nicht im Format Haupt.Neben"));
    };
    let (Ok(major), Ok(minor)) = (a.parse::<u32>(), b.parse::<u32>()) else {
        return VersionCheck::Reject(format!("api_version {service_version:?} nicht im Format Haupt.Neben"));
    };
    let own_minor: u32 = API_VERSION.split('.').nth(1).and_then(|m| m.parse().ok()).unwrap_or(0);
    if major != API_MAJOR {
        VersionCheck::Reject(format!("TAMS-Hauptversion {major} wird nicht unterstützt (erwartet {API_MAJOR})"))
    } else if minor > own_minor {
        VersionCheck::NewerMinor
    } else {
        VersionCheck::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_rules() {
        assert_eq!(check_api_version("8.2"), VersionCheck::Ok);
        assert_eq!(check_api_version("8.0"), VersionCheck::Ok);
        assert_eq!(check_api_version("8.3"), VersionCheck::NewerMinor);
        assert!(matches!(check_api_version("9.0"), VersionCheck::Reject(_)));
        assert!(matches!(check_api_version("7.9"), VersionCheck::Reject(_)));
        assert!(matches!(check_api_version("8"), VersionCheck::Reject(_)));
        assert!(matches!(check_api_version("8.x"), VersionCheck::Reject(_)));
        assert!(matches!(check_api_version("8.2.1"), VersionCheck::Reject(_)));
    }
}
