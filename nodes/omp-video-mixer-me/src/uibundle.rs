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
