//! `/ui/manifest.json` + `/ui/bundle.js` von omp-ograf (`ARCHITECTURE.md`
//! §4.5), gleiches Muster wie `omp-video-mixer-me`/`omp-switcher`
//! (siehe dortige `uibundle.rs`): das generische, aus dem Descriptor
//! erzeugte Panel kann `templates` (ein JSON-Array von Template-Infos
//! inkl. verschachteltem JSON-Schema) nicht sinnvoll darstellen (v0-
//! Descriptor-Schema kennt keinen Array-Typ) — landete dort bisher als
//! `String(value)` eines Objekt-Arrays, sichtbar als "[object Object]".
//! `include_str!` bindet die Dateien zur Compile-Zeit ein.

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
