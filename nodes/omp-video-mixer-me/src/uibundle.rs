//! `/ui/manifest.json` + `/ui/bundle.js` des Mixers (`ARCHITECTURE.md`
//! §4.5, `UMSETZUNG.md` C10) — Rust-Pendant zu `omp-switcher/src/
//! uibundle.rs` (C7): `include_str!` bindet die Dateien zur Compile-Zeit
//! ein, das generische B6-Panel könnte die JSON-Array-/Objekt-Parameter
//! (`crosspoint.inputs`, `dve.box`) ohnehin nicht sinnvoll darstellen.

use omp_node_sdk::RawResponse;

const MANIFEST: &str = include_str!("../ui/manifest.json");
const BUNDLE: &str = include_str!("../ui/bundle.js");

pub fn route(method: &str, path: &str) -> Option<RawResponse> {
    if method != "GET" {
        return None;
    }
    // s. omp-audio-mixer/src/uibundle.rs für die Herleitung: der Orchestrator
    // hängt `?access_token=` an, dieser Schnitt macht den exakten Pfad-
    // vergleich unten davon unabhängig.
    let path = path.split('?').next().unwrap_or(path);
    match path {
        "/ui/manifest.json" => Some(RawResponse {
            status: 200,
            content_type: "application/json",
            body: MANIFEST.as_bytes().to_vec(),
        }),
        "/ui/bundle.js" => Some(RawResponse {
            status: 200,
            content_type: "text/javascript",
            body: BUNDLE.as_bytes().to_vec(),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Live-Test-Fund (Demo-Sitzung 2026-07-22): der Orchestrator hängt beim
    // Bundle-Import aus dem Browser `?access_token=<jwt>` an
    // (`ui/shell/ui-bundle.ts`) und reicht die Query unverändert an den
    // Node durch (`proxy.go::handleNodeProxy`) — ohne den Schnitt in
    // `route()` liefert jeder authentifizierte Bundle-Import ein 404 vom
    // Node selbst, unsichtbar hinter dem generischen Orchestrator-Fehler.
    #[test]
    fn bundle_js_matches_with_query_string() {
        assert!(route("GET", "/ui/bundle.js?access_token=abc.def.ghi").is_some());
        assert!(route("GET", "/ui/manifest.json?access_token=abc.def.ghi").is_some());
    }

    #[test]
    fn bundle_js_matches_without_query_string() {
        assert!(route("GET", "/ui/bundle.js").is_some());
        assert!(route("GET", "/ui/manifest.json").is_some());
    }

    #[test]
    fn unknown_path_is_none() {
        assert!(route("GET", "/ui/other.js").is_none());
    }
}
