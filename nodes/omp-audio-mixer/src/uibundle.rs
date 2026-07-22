//! `/ui/manifest.json` + `/ui/bundle.js` des Audiomischers
//! (`ARCHITECTURE.md` §4.5, `UMSETZUNG.md` C11) — Rust-Pendant zu
//! `omp-video-mixer-me/src/uibundle.rs` (C10): `include_str!` bindet die
//! Dateien zur Compile-Zeit ein, das generische B6-Panel kann eine
//! dynamische Kanalliste ohnehin nicht sinnvoll darstellen.

use omp_node_sdk::RawResponse;

const MANIFEST: &str = include_str!("../ui/manifest.json");
const BUNDLE: &str = include_str!("../ui/bundle.js");

pub fn route(method: &str, path: &str) -> Option<RawResponse> {
    if method != "GET" {
        return None;
    }
    // Der Orchestrator hängt bei UI-Bundle-Aufrufen aus dem Browser
    // `?access_token=` an (`ui-bundle.ts`, natives `import()` kann keinen
    // Authorization-Header setzen) und reicht die Query unverändert an
    // den Node durch (`proxy.go::handleNodeProxy`) — ohne diesen Schnitt
    // matcht der exakte Pfadvergleich unten nie, jeder authentifizierte
    // Bundle-Import bekam bisher fälschlich 404 vom Node selbst.
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
