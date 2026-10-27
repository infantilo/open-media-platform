//! Node-API-Token (Audit 2026-10-23 B1): die HTTP-API eines Nodes nahm Parameteränderungen, Methodenaufrufe und IS-05-Verbindungen von
//! jedem erreichbaren Absender an. Der Orchestrator gibt jedem Node, den er startet, `OMP_NODE_API_TOKEN` mit; ist die Variable
//! gesetzt, verlangt der Server in jeder Anfrage den Header `X-OMP-Node-Token` mit genau diesem Wert (sonst 401). Nodes senden
//! es an andere Nodes (`peer.rs`), der Orchestrator an alle Nodes. Ohne die Variable bleibt alles offen (Entwicklung, Tests,
//! extern gestartete Nodes).
//!
//! Bewusst offen bleiben: CORS-Preflight (`OPTIONS`), `GET /https-info`, lesende NMOS-Routen (`GET /x-nmos/…`, laut Spezifikation
//! öffentlich) und Routen, die ein Node selbst als öffentlich erklärt, weil er sie mit einer eigenen Berechtigung schützt
//! (`ParamStore::public_route`, z. B. Einladungs-Token der WebRTC-Seiten).

use std::sync::OnceLock;

/// Name des Headers (und der Umgebungsvariable `OMP_NODE_API_TOKEN`, s. [`token`]).
pub const HEADER: &str = "x-omp-node-token";

/// Das Token dieses Prozesses; `None`, wenn nicht gesetzt oder leer.
pub fn token() -> Option<&'static str> {
    static TOKEN: OnceLock<Option<String>> = OnceLock::new();
    TOKEN.get_or_init(|| std::env::var("OMP_NODE_API_TOKEN").ok().filter(|t| !t.is_empty())).as_deref()
}

/// Vergleich in konstanter Zeit (Längenunterschied verrät nur die Länge).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Prüft die Anfrage gegen `want` (`None` = kein Token verlangt). `headers`: Namen klein geschrieben.
pub fn authorized(want: Option<&str>, headers: &[(String, String)]) -> bool {
    let Some(want) = want else { return true };
    headers.iter().any(|(k, v)| k == HEADER && ct_eq(v.as_bytes(), want.as_bytes()))
}

/// Pfade, die immer offen sind (ohne Query).
pub fn always_open(method: &str, path: &str) -> bool {
    let bare = path.split('?').next().unwrap_or(path);
    method.eq_ignore_ascii_case("OPTIONS")
        || (method.eq_ignore_ascii_case("GET") && (bare == "/https-info" || bare == "/x-nmos" || bare.starts_with("/x-nmos/")))
}

/// Hängt das Token (falls gesetzt) an eine ausgehende `ureq`-Anfrage an Nodes.
pub fn with_token<B>(req: ureq::RequestBuilder<B>) -> ureq::RequestBuilder<B> {
    match token() {
        Some(t) => req.header("X-OMP-Node-Token", t),
        None => req,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(v: &str) -> Vec<(String, String)> {
        vec![(HEADER.to_string(), v.to_string())]
    }

    #[test]
    fn no_token_wanted_allows_all() {
        assert!(authorized(None, &[]));
    }

    #[test]
    fn token_must_match_exactly() {
        assert!(authorized(Some("abc"), &h("abc")));
        assert!(!authorized(Some("abc"), &h("abd")));
        assert!(!authorized(Some("abc"), &h("ab")));
        assert!(!authorized(Some("abc"), &[]));
        assert!(!authorized(Some("abc"), &h("")));
    }

    #[test]
    fn open_paths() {
        assert!(always_open("OPTIONS", "/params/x"));
        assert!(always_open("GET", "/https-info"));
        assert!(always_open("GET", "/x-nmos/node/v1.3/self"));
        assert!(!always_open("PATCH", "/x-nmos/connection/v1.1/single/receivers/1/staged"));
        assert!(!always_open("GET", "/params/x"));
        assert!(!always_open("POST", "/methods/x"));
        assert!(!always_open("GET", "/descriptor.json"));
    }
}
