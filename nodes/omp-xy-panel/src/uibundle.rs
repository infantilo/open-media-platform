//! `/ui/manifest.json` + `/ui/bundle.js` des X/Y-Panels. Das Bundle ist die
//! Verkettung aus `logic.js` (reine Logik, per `deno test` geprüft) und
//! `panel.js` (Custom Element) — ein Node-Bundle darf keine Imports nutzen.

use omp_node_sdk::RawResponse;

const MANIFEST: &str = include_str!("../ui/manifest.json");
const LOGIC: &str = include_str!("../ui/logic.js");
const PANEL: &str = include_str!("../ui/panel.js");

pub fn route(method: &str, path: &str) -> Option<RawResponse> {
    if method != "GET" {
        return None;
    }
    // Der Orchestrator hängt `?access_token=` an (s. omp-audio-mixer/src/uibundle.rs).
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
            body: format!("{LOGIC}\n{PANEL}").into_bytes(),
        }),
        _ => None,
    }
}
