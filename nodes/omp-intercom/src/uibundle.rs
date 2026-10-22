//! `/ui/manifest.json` + `/ui/bundle.js` (`ARCHITECTURE.md` §4.5) für `omp-intercom`.

use omp_node_sdk::RawResponse;

const MANIFEST: &str = include_str!("../ui/manifest.json");
const BUNDLE: &str = include_str!("../ui/bundle.js");
/// Einrichtungs-Ansicht und Kachel (ESM-Bundle, gebaut aus `ui/modules/intercom` — `make ui` kopiert es hierher). Das
/// Dienst-Gateway liefert sie unter `/api/v1/ext/intercom/_ui/admin.js` aus (Manifest: Bundle „admin.js“).
const ADMIN: &str = include_str!("../ui/admin.js");

/// Datei der Dienst-Oberfläche (`/service/ui/<name>`).
pub fn asset(name: &str) -> Option<&'static str> {
    match name {
        "admin.js" => Some(ADMIN),
        _ => None,
    }
}

pub fn route(method: &str, path: &str) -> Option<RawResponse> {
    if method != "GET" {
        return None;
    }
    match path {
        "/ui/manifest.json" => Some(RawResponse { status: 200, content_type: "application/json", body: MANIFEST.as_bytes().to_vec() }),
        "/ui/bundle.js" => Some(RawResponse { status: 200, content_type: "text/javascript", body: BUNDLE.as_bytes().to_vec() }),
        _ => None,
    }
}
