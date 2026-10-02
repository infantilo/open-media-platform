//! Build-Stempel eines Node-Binaries (Kapitel 28 / Node-Versionierung).
//!
//! Zwei Wege, die Version zu erfahren:
//! * **Laufzeit:** der Node meldet sie als IS-04-Tag [`BUILD_TAG`]
//!   (`[version, commit, builtAt]`) — der Orchestrator zeigt sie je Instanz.
//! * **Datei:** [`BUILD_MARKER`] ist ein festes, im Binary auffindbares Literal.
//!   Der Orchestrator liest die Version eines Binaries daraus, OHNE es
//!   auszuführen (Versionsspeicher, hochgeladene Pakete).
//!
//! Gestempelt wird nur bei Release-/Bundle-Builds (`OMP_BUILD_VERSION=…`, siehe
//! `build.rs`); sonst steht dort "dev".

/// IS-04-Tag-Name (Go-Gegenstück: `orchestrator/internal/registry`).
pub const BUILD_TAG: &str = "urn:x-omp:build";

pub const VERSION: &str = env!("OMP_SDK_BUILD_VERSION");
pub const COMMIT: &str = env!("OMP_SDK_BUILD_COMMIT");
pub const BUILT_AT: &str = env!("OMP_SDK_BUILD_AT");

/// Im Binary auffindbar: `OMPBUILD1{"version":…}OMPBUILD1END`.
pub static BUILD_MARKER: &str = concat!(
    "OMPBUILD1{\"version\":\"",
    env!("OMP_SDK_BUILD_VERSION"),
    "\",\"commit\":\"",
    env!("OMP_SDK_BUILD_COMMIT"),
    "\",\"builtAt\":\"",
    env!("OMP_SDK_BUILD_AT"),
    "\"}OMPBUILD1END"
);

/// Tag-Wert für die Registrierung. Liest den Marker mit `black_box`, damit der
/// Linker das Literal nicht entfernt.
pub fn tag_values() -> Vec<String> {
    std::hint::black_box(BUILD_MARKER);
    vec![VERSION.to_string(), COMMIT.to_string(), BUILT_AT.to_string()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_is_well_formed_json_between_the_delimiters() {
        let inner = BUILD_MARKER.strip_prefix("OMPBUILD1").and_then(|s| s.strip_suffix("OMPBUILD1END")).unwrap();
        let v: serde_json::Value = serde_json::from_str(inner).unwrap();
        assert_eq!(v["version"], VERSION);
        assert_eq!(tag_values().len(), 3);
    }
}
