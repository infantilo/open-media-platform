//! `/ui/manifest.json` + `/ui/bundle.js` des Automatic Multiviewers: zeigt das Kachelbild
//! (`previewUrl`) groß im Property-Panel, wie der Viewer. `include_str!` bindet die Dateien
//! zur Compile-Zeit ein.

use omp_node_sdk::RawResponse;

const MANIFEST: &str = include_str!("../ui/manifest.json");
const BUNDLE: &str = include_str!("../ui/bundle.js");

pub fn route(method: &str, path: &str) -> Option<RawResponse> {
    if method != "GET" {
        return None;
    }
    // Der Orchestrator hängt `?access_token=` an — Pfadvergleich davon unabhängig.
    let path = path.split('?').next().unwrap_or(path);
    match path {
        "/ui/manifest.json" => Some(RawResponse { status: 200, content_type: "application/json", body: MANIFEST.as_bytes().to_vec() }),
        "/ui/bundle.js" => Some(RawResponse { status: 200, content_type: "text/javascript", body: BUNDLE.as_bytes().to_vec() }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_bundle_and_manifest() {
        assert!(route("GET", "/ui/bundle.js?access_token=x").is_some());
        assert!(route("GET", "/ui/manifest.json").is_some());
        assert!(route("POST", "/ui/bundle.js").is_none());
        assert!(route("GET", "/other").is_none());
    }
}
