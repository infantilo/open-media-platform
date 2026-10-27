//! Node-API-Token für die Stream-Listener (Vorschau, Pegel, PCM, Audio): Audit 2026-10-23 B1. Gleiche Regel wie
//! `omp_node_sdk::nodeauth` (hier ohne Abhängigkeit zum SDK nachgebaut): ist `OMP_NODE_API_TOKEN` gesetzt, bedient ein Listener nur
//! Anfragen mit dem Header `X-OMP-Node-Token`. Die Streams erreichen Browser ausschließlich über den Orchestrator-Proxy, der das Token sendet.

use std::sync::OnceLock;

fn token() -> Option<&'static str> {
    static TOKEN: OnceLock<Option<String>> = OnceLock::new();
    TOKEN.get_or_init(|| std::env::var("OMP_NODE_API_TOKEN").ok().filter(|t| !t.is_empty())).as_deref()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Prüft den Header gegen `want` (`None` = kein Token verlangt).
pub fn header_ok(want: Option<&str>, header_value: Option<&str>) -> bool {
    match want {
        None => true,
        Some(w) => header_value.is_some_and(|v| ct_eq(v.as_bytes(), w.as_bytes())),
    }
}

/// Darf diese Anfrage bedient werden? Sonst hat der Aufrufer mit 401 zu antworten ([`deny`]).
pub fn allowed(request: &tiny_http::Request) -> bool {
    let value = request.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("x-omp-node-token")).map(|h| h.value.as_str());
    header_ok(token(), value)
}

/// Antwortet mit 401.
pub fn deny(request: tiny_http::Request) {
    let _ = request.respond(tiny_http::Response::from_string("node api token required").with_status_code(401));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_rules() {
        assert!(header_ok(None, None));
        assert!(header_ok(Some("t"), Some("t")));
        assert!(!header_ok(Some("t"), Some("u")));
        assert!(!header_ok(Some("t"), None));
        assert!(!header_ok(Some("t"), Some("")));
    }
}
