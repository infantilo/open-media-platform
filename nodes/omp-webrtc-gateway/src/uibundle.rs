//! `/ui/manifest.json` + `/ui/bundle.js` (`ARCHITECTURE.md` §4.5) für
//! `omp-webrtc-gateway` (Nutzerwunsch 2026-09-23: Bedienoberfläche für
//! Einladungslinks/QR-Codes, Kamera- UND Monitor-Richtung identisch —
//! s. `invite.rs`). Rust-Pendant zu `omp-switcher/src/uibundle.rs`
//! (identisches `include_str!`-Muster).

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
