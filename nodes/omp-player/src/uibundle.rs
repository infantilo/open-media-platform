//! `/ui/manifest.json` + `/ui/bundle.js` von `omp-player` (`UMSETZUNG.md`
//! C12, `ARCHITECTURE.md` §13.3, §4.5): zwei kompilierte Varianten
//! (Videoplayer-Cue/Take-Ansicht, Jingle-Cart-Wall), zur Laufzeit anhand
//! von `has_video` (aus `OMP_PLAYER_PROFILE`, `main.rs`) ausgewählt — beide
//! sprechen dieselbe Descriptor-API (`append`/`load`/`remove`/`cue`/
//! `take`), nur die Darstellung unterscheidet sich. `include_str!` bindet
//! die Dateien wie bei C10/C11 zur Compile-Zeit ein.

use omp_node_sdk::RawResponse;

const MANIFEST_VIDEO: &str = include_str!("../ui/manifest-video.json");
const MANIFEST_JINGLE: &str = include_str!("../ui/manifest-jingle.json");
const BUNDLE_VIDEO: &str = include_str!("../ui/bundle-video.js");
const BUNDLE_JINGLE: &str = include_str!("../ui/bundle-jingle.js");

pub fn route(method: &str, path: &str, has_video: bool) -> Option<RawResponse> {
    if method != "GET" {
        return None;
    }
    // s. omp-audio-mixer/src/uibundle.rs für die Herleitung: der Orchestrator
    // hängt `?access_token=` an, dieser Schnitt macht den exakten Pfad-
    // vergleich unten davon unabhängig.
    let path = path.split('?').next().unwrap_or(path);
    match path {
        "/ui/manifest.json" => Some(RawResponse {
            status: 200,
            content_type: "application/json",
            body: (if has_video { MANIFEST_VIDEO } else { MANIFEST_JINGLE })
                .as_bytes()
                .to_vec(),
        }),
        "/ui/bundle.js" => Some(RawResponse {
            status: 200,
            content_type: "text/javascript",
            body: (if has_video { BUNDLE_VIDEO } else { BUNDLE_JINGLE })
                .as_bytes()
                .to_vec(),
        }),
        _ => None,
    }
}
