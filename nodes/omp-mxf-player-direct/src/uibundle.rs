//! `/ui/manifest.json` + `/ui/bundle.js` (Nutzerauftrag 2026-09-03: "mxf
//! player (direkt ohne playliste) braucht noch ein ui zum laden des
//! clips, seeking, play, stop... und audioshuffle selection") —
//! identisches Muster wie `omp-mxf-player/src/uibundle.rs`
//! (`include_str!` bindet die Dateien zur Compile-Zeit ein).

use omp_node_sdk::RawResponse;

const MANIFEST: &str = include_str!("../ui/manifest.json");
const BUNDLE: &str = include_str!("../ui/bundle.js");

pub fn route(method: &str, path: &str) -> Option<RawResponse> {
    if method != "GET" {
        return None;
    }
    // Der Orchestrator hängt `?access_token=` an (s. omp-mxf-player/src/
    // uibundle.rs) — dieser Schnitt macht den exakten Pfadvergleich unten
    // davon unabhängig.
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
