//! `/ui/manifest.json` + `/ui/bundle.js` — Flow-Editor-Kachelpanel, zeigt
//! PIPELINE CONTROLLERs eigenes Web-UI eingebettet als `<iframe>` (s.
//! `proxy.rs`, `ui/bundle.js`). Gleiches `include_str!`-Muster wie
//! `omp-ograf`/`omp-video-mixer-me`.

use omp_node_sdk::RawResponse;

const MANIFEST: &str = include_str!("../ui/manifest.json");
const BUNDLE: &str = include_str!("../ui/bundle.js");

pub fn route(method: &str, path: &str) -> Option<RawResponse> {
    if method != "GET" {
        return None;
    }
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
