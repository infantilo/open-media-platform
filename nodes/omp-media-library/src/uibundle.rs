//! `/ui/manifest.json` + `/ui/bundle.js` (`UMSETZUNG.md` C17,
//! `ARCHITECTURE.md` §4.5) — gleiches `include_str!`-Muster wie
//! `omp-playout-automation` (C14/C15).

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
