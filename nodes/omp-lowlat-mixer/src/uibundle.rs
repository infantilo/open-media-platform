//! `/ui/manifest.json` + `/ui/bundle.js` des Studio-Mischers (Muster: `omp-audio-monitor/src/uibundle.rs`). Das Bundle wird zur
//! Übersetzungszeit eingebettet (`include_str!`) — nach Änderungen an `ui/bundle.js` neu bauen und den Node neu starten.

use omp_node_sdk::RawResponse;

const MANIFEST: &str = include_str!("../ui/manifest.json");
const BUNDLE: &str = include_str!("../ui/bundle.js");

pub fn route(method: &str, path: &str) -> Option<RawResponse> {
    if method != "GET" {
        return None;
    }
    // Der Orchestrator hängt `?access_token=` an; der Pfadvergleich soll davon unabhängig sein.
    let path = path.split('?').next().unwrap_or(path);
    match path {
        "/ui/manifest.json" => Some(RawResponse { status: 200, content_type: "application/json", body: MANIFEST.as_bytes().to_vec() }),
        "/ui/bundle.js" => Some(RawResponse { status: 200, content_type: "text/javascript", body: BUNDLE.as_bytes().to_vec() }),
        _ => None,
    }
}
