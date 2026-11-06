//! `/ui/manifest.json` + `/ui/bundle.js` (`UMSETZUNG.md` C14/C15,
//! `ARCHITECTURE.md` §4.5) — gleiches `include_str!`-Muster wie
//! `omp-player`/`omp-video-mixer-me` (C10/C12).

use omp_node_sdk::RawResponse;

const MANIFEST: &str = include_str!("../ui/manifest.json");
const BUNDLE: &str = include_str!("../ui/bundle.js");
/// Segue-Editor (RB7.3): eingecheckte, gebaute Kopie von `ui/modules/segue-editor` (Makefile `ui`), damit `cargo build` ohne deno läuft.
const SEGUE_EDITOR: &str = include_str!("../ui/segue-editor.js");

pub fn route(method: &str, path: &str) -> Option<RawResponse> {
    if method != "GET" {
        return None;
    }
    // s. omp-playout-automation/src/uibundle.rs für die Herleitung: der Orchestrator
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
        "/ui/segue-editor.js" => Some(RawResponse {
            status: 200,
            content_type: "text/javascript",
            body: SEGUE_EDITOR.as_bytes().to_vec(),
        }),
        _ => None,
    }
}
