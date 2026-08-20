//! `/ui/manifest.json` + `/ui/bundle.js` von `omp-mxf-player` (Nutzer-
//! auftrag 2026-08-20, s. `main.rs`-Moduldoku) — `include_str!` bindet die
//! Dateien zur Compile-Zeit ein, identisches Muster wie
//! `omp-player/src/uibundle.rs` (dort zwei Varianten, hier nur eine — der
//! Node hat kein Jingle-Pendant).

use omp_node_sdk::RawResponse;

const MANIFEST: &str = include_str!("../ui/manifest.json");
const BUNDLE: &str = include_str!("../ui/bundle.js");

pub fn route(method: &str, path: &str) -> Option<RawResponse> {
    if method != "GET" {
        return None;
    }
    // Der Orchestrator hängt `?access_token=` an (s. omp-audio-mixer/src/
    // uibundle.rs für die Herleitung) — dieser Schnitt macht den exakten
    // Pfadvergleich unten davon unabhängig.
    let path = path.split('?').next().unwrap_or(path);
    match path {
        "/ui/manifest.json" => Some(RawResponse { status: 200, content_type: "application/json", body: MANIFEST.as_bytes().to_vec() }),
        "/ui/bundle.js" => Some(RawResponse { status: 200, content_type: "text/javascript", body: BUNDLE.as_bytes().to_vec() }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
