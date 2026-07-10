//! `/ui/manifest.json` + `/ui/bundle.js` des Viewers (`ARCHITECTURE.md`
//! §4.5, `UMSETZUNG.md` C6): ein `<img>`, das auf `previewUrl` aus dem
//! Descriptor zeigt (`main.rs`) — kein generisches Parameter-Panel nötig,
//! die zwei readonly-Felder sind für einen Operator uninteressant.
//! Rust-Pendant zu `nodes/mock/internal/uibundle` (Go, `go:embed`):
//! `include_str!` bindet die Dateien zur Compile-Zeit ein, keine
//! Laufzeit-Dateisystem-Abhängigkeit.

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
