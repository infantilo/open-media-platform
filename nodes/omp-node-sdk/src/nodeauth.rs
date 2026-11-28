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

/// Peer-Token (`OMP_NODE_PEER_TOKEN`) der Betriebsart "Token je Host": öffnet bei fremden Nodes nur die Aufrufe aus
/// [`peer_allowed`]; das eigene volle Token dieses Prozesses kennen andere Nodes nicht.
pub fn peer_token() -> Option<&'static str> {
    static TOKEN: OnceLock<Option<String>> = OnceLock::new();
    TOKEN.get_or_init(|| std::env::var("OMP_NODE_PEER_TOKEN").ok().filter(|t| !t.is_empty())).as_deref()
}

/// Parameter, die ein Node bei einem anderen mit dem Peer-Token lesen darf (auch mit Präfix, z. B. `me1.pip.canvas`).
const PEER_PARAMS: &[&str] = &["fabricsTargetInfo", "layers", "subtitle", "keyer.inputs", "keyer.source", "keyer.enabled", "pip.canvas", "pip.slots"];
/// Methoden, die ein Node bei einem anderen mit dem Peer-Token aufrufen darf (ebenso mit Präfix).
const PEER_METHODS: &[&str] = &[
    "activateLowresPreview", "releaseLowresPreview",
    "pip.setAnimDelay", "pip.setSource", "pip.setPose", "pip.setEnabled", "crosspoint.setTransWindow",
    "keyer.setSource", "keyer.setEnabled",
    "show", "hide", "update",
];

/// Ist das ein Aufruf, den Nodes untereinander brauchen? Wer hier einen neuen `PeerClient`-Aufruf ergänzt, muss ihn
/// in die Listen oben aufnehmen, sonst antwortet das Ziel in der Betriebsart "Token je Host" mit 401.
pub fn peer_allowed(method: &str, path: &str) -> bool {
    let bare = path.split('?').next().unwrap_or(path);
    let (prefix, list) = if method.eq_ignore_ascii_case("GET") {
        ("/params/", PEER_PARAMS)
    } else if method.eq_ignore_ascii_case("POST") {
        ("/methods/", PEER_METHODS)
    } else {
        return false;
    };
    let Some(name) = bare.strip_prefix(prefix) else { return false };
    !name.contains(['/', '%'])
        && list.iter().any(|allowed| name == *allowed || name.strip_suffix(allowed).is_some_and(|p| p.ends_with('.')))
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
    // Punkt-Segmente (auch kodiert) machen aus dem offenen Präfix nie einen offenen Pfad. Der Server löst sie heute nicht
    // auf; die Prüfung hält das auch dann, wenn ein Handler oder ein vorgeschalteter Proxy es täte.
    let dotted = bare.split('/').any(|seg| matches!(seg.to_ascii_lowercase().replace("%2e", ".").as_str(), "." | "..")) || bare.to_ascii_lowercase().contains("%2f");
    method.eq_ignore_ascii_case("OPTIONS")
        || (method.eq_ignore_ascii_case("GET") && !dotted && (bare == "/https-info" || bare == "/x-nmos" || bare.starts_with("/x-nmos/")))
}

/// Hängt das Token (falls gesetzt) an eine ausgehende `ureq`-Anfrage an Nodes: das Peer-Token, wenn es eines gibt.
pub fn with_token<B>(req: ureq::RequestBuilder<B>) -> ureq::RequestBuilder<B> {
    match peer_token().or_else(token) {
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
    fn peer_token_opens_only_the_listed_calls() {
        for (m, p) in [("GET", "/params/layers"), ("GET", "/params/me1.pip.canvas?x=1"), ("POST", "/methods/activateLowresPreview"), ("POST", "/methods/me2.keyer.setSource"), ("POST", "/methods/show")] {
            assert!(peer_allowed(m, p), "{m} {p}");
        }
        for (m, p) in [
            ("PATCH", "/params/layers"), ("POST", "/params/layers"), ("GET", "/methods/show"), ("POST", "/methods/take"),
            ("POST", "/methods/crosspoint.take"), ("POST", "/methods/xshow"), ("POST", "/methods/show/x"), ("POST", "/methods/..%2fshow"),
            ("GET", "/params/config"), ("PATCH", "/x-nmos/connection/v1.2/single/receivers/1/staged"), ("POST", "/state"),
        ] {
            assert!(!peer_allowed(m, p), "{m} {p}");
        }
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
        for path in ["/x-nmos/../params", "/x-nmos/%2e%2e/params", "/x-nmos/.%2E/params", "/x-nmos/./node", "/x-nmos/..%2fparams"] {
            assert!(!always_open("GET", path), "{path}");
        }
        // Punkte in Namen und in der Anfrage bleiben erlaubt
        assert!(always_open("GET", "/x-nmos/connection/v1.1/single/senders/s/transportfile?x=../y"));
    }
}
