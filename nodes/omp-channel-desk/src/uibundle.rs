//! `/ui/manifest.json` + `/ui/bundle.js` der Mehrkanal-Übersicht. Das Bundle wird von `make ui` aus
//! `ui/modules/channel-desk/panel.ts` gebaut und hier eingebettet (`include_str!`) — ein Node-Bundle
//! darf keine Imports nutzen.

use omp_node_sdk::RawResponse;

const MANIFEST: &str = include_str!("../ui/manifest.json");
const BUNDLE: &str = include_str!("../ui/bundle.js");

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
            body: BUNDLE.as_bytes().to_vec(),
        }),
        _ => None,
    }
}
