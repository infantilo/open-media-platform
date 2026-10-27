//! Fehlercodes (UMSETZUNG.md Kap. 72.8): `[OMP-nnnn]` vor eine Fehlermeldung setzen, damit Oberfläche und Support sie ohne
//! Mustersuche im Freitext einem Eintrag des Katalogs (Ursache, Lösungsschritte) zuordnen können.
//!
//! Die Zuordnung kommt aus derselben Quelle wie im Orchestrator: `errcodes_table.rs` wird aus dem Go-Katalog erzeugt
//! (`orchestrator/internal/errcodes`), die Schlüsselwörter sind einfache Teilstrings — keine Regex-Bibliothek, keine zweite Regelliste.

use crate::errcodes_table::TABLE;

/// Der Code zu einer Meldung (Schlüsselwort-Treffer, Reihenfolge des Katalogs), sonst `None`.
pub fn classify(message: &str) -> Option<&'static str> {
    let lower = message.to_lowercase();
    TABLE.iter().find(|(_, words)| words.iter().any(|w| lower.contains(w))).map(|(code, _)| *code)
}

/// Stellt der Meldung ihren Code voran („[OMP-3003] …“). Trägt sie schon einen Code oder passt nichts, bleibt sie unverändert.
pub fn tag(message: &str) -> String {
    if has_code(message) {
        return message.to_string();
    }
    match classify(message) {
        Some(code) => format!("[{code}] {message}"),
        None => message.to_string(),
    }
}

fn has_code(message: &str) -> bool {
    message.match_indices("OMP-").any(|(i, _)| {
        let digits = &message.as_bytes()[i + 4..];
        digits.len() >= 4 && digits[..4].iter().all(u8::is_ascii_digit)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_known_pipeline_and_os_errors() {
        for (msg, code) in [
            ("streaming stopped, reason not-negotiated (-4)", "OMP-3003"),
            ("Internal data stream error.", "OMP-3004"),
            ("videotestsrc: Failed to find element factory with name 'x264enc' for creating element", "OMP-3009"),
            ("[writer] open_grain 42 failed: boom", "OMP-3010"),
            ("write /dev/shm/omp-mxl/x: No space left on device", "OMP-1005"),
            ("open flow_def.json: ENOENT", "OMP-3001"),
            ("Could not open /dev/video0: No such device", "OMP-3005"),
            ("kein Video-Buffer von der verbundenen Quelle", "OMP-3006"),
        ] {
            assert_eq!(classify(msg), Some(code), "{msg}");
        }
        assert_eq!(classify("measured video fps ~= 25.0"), None);
    }

    #[test]
    fn tag_prefixes_once_and_leaves_the_rest_alone() {
        assert_eq!(tag("Internal data stream error."), "[OMP-3004] Internal data stream error.");
        assert_eq!(tag("[OMP-3004] schon markiert"), "[OMP-3004] schon markiert");
        assert_eq!(tag("Code OMP-3001 steht im Text"), "Code OMP-3001 steht im Text");
        assert_eq!(tag("nichts Bekanntes"), "nichts Bekanntes");
        // „OMP-“ ohne vier Ziffern zählt nicht als Code
        assert_eq!(tag("OMP-x Internal data stream error."), "[OMP-3004] OMP-x Internal data stream error.");
    }

    #[test]
    fn table_codes_have_the_catalog_format() {
        for (code, words) in TABLE {
            assert!(code.starts_with("OMP-") && code.len() == 8, "{code}");
            assert!(!words.is_empty());
            assert!(words.iter().all(|w| *w == w.to_lowercase()), "{code}: Schlüsselwörter müssen klein geschrieben sein");
        }
    }
}
