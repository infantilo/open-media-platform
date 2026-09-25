//! Einladungslinks/-Tokens für `/whip` und `/whep` (Nutzerwunsch
//! 2026-09-23: "nur mit diesen darf sich jemand verbinden (security!)").
//!
//! **Bisheriger Zustand (live gefunden, nicht mehr tragbar):** `/whip`/
//! `/whep` nahmen JEDE Verbindung an, die den Node-Port erreichte — wer
//! die URL/den Port kannte (z. B. per Portweiterhang fürs Handy übers
//! Internet erreichbar gemacht, s. Nachtrag 240/244), konnte ohne
//! jede Prüfung Kamera-Video einspeisen bzw. den Monitor-Stream
//! abgreifen.
//!
//! **Neues Modell:** ein In-Memory-Satz aus Einladungs-Tokens (128-Bit-
//! Zufall über [`omp_node_sdk::idgen::new_v4`], keine Persistenz über
//! einen Neustart hinaus — ein neu gestarteter Node hat bewusst noch
//! KEINE gültige Einladung, s. u.). `/whip`/`/whep` (POST **und**
//! DELETE, s. dortige Doku) verlangen jetzt `?token=<Token>` als
//! Query-Parameter auf dem Pfad selbst — NICHT als `Authorization`-
//! Header, weil [`omp_node_sdk::ParamStore::extra_route`] keinen
//! Zugriff auf Request-Header hat (bewusst kein SDK-weiter
//! Signatur-Umbau für diesen einen Node). Query-Parameter-Tokens auf
//! dem Pfad sind in diesem Codebase bereits ein etabliertes Muster
//! (`uibundle.rs`: "der Orchestrator hängt `?access_token=` an").
//!
//! **Sicher-per-Default:** ein leerer Einladungssatz (frisch
//! gestarteter Node, oder alle Einladungen widerrufen) lehnt JEDEN
//! Verbindungsversuch ab — kein stillschweigender Rückfall auf das
//! alte, offene Verhalten. Die Bedienoberfläche (`uibundle.rs`)
//! erzeugt neue Einladungen samt fertigem Link + QR-Code.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use omp_node_sdk::RawResponse;
use qrcode::QrCode;
use serde_json::Value;

/// Eine einzelne Einladung.
#[derive(Clone)]
pub struct Invite {
    pub token: String,
    pub label: String,
    /// Unix-Millisekunden — reicht für die reine Anzeige in der
    /// Bedienoberfläche, keine Zeitzonen-/Präzisions-Anforderung.
    pub created_at_ms: u64,
}

/// Verwaltet den Satz gültiger Einladungs-Tokens dieser Node-Instanz.
pub struct InviteStore {
    invites: Mutex<Vec<Invite>>,
}

impl InviteStore {
    pub fn new() -> Self {
        Self { invites: Mutex::new(Vec::new()) }
    }

    /// Erzeugt eine neue Einladung mit optionalem Label (z. B. "Kamera
    /// Regie 1" — reine Gedächtnisstütze für die Bedienoberfläche, hat
    /// keine sicherheitsrelevante Bedeutung).
    pub fn create(&self, label: String) -> Invite {
        let token = omp_node_sdk::idgen::new_v4();
        let created_at_ms = now_ms();
        let invite = Invite { token, label, created_at_ms };
        self.invites.lock().expect("lock poisoned").push(invite.clone());
        invite
    }

    pub fn list(&self) -> Vec<Invite> {
        self.invites.lock().expect("lock poisoned").clone()
    }

    /// Widerruft eine Einladung — idempotent, `true` nur wenn tatsächlich
    /// eine Zeile entfernt wurde (für eine ehrliche 404 vs. 200-Antwort
    /// im Aufrufer).
    pub fn revoke(&self, token: &str) -> bool {
        let mut guard = self.invites.lock().expect("lock poisoned");
        let before = guard.len();
        guard.retain(|i| i.token != token);
        guard.len() != before
    }

    /// Prüft einen von `/whip`/`/whep` mitgegebenen Token — leerer/
    /// fehlender Token ist NIE gültig (verhindert, dass ein leerer
    /// Query-Parameter versehentlich gegen einen ebenfalls leeren
    /// Vergleich durchrutscht).
    pub fn is_valid(&self, token: &str) -> bool {
        if token.is_empty() {
            return false;
        }
        self.invites.lock().expect("lock poisoned").iter().any(|i| i.token == token)
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Liest `token=` aus einer Query-String (alles nach `?` in einem Pfad
/// wie `/whip?token=abc`) — keine volle URL-Parsing-Bibliothek nötig für
/// diesen einen, immer gleich geformten Parameter (Tokens sind reine
/// UUIDs, brauchen kein Prozent-Decoding).
pub fn token_from_query(path: &str) -> &str {
    query_param(path, "token")
}

fn query_param<'a>(path: &'a str, name: &str) -> &'a str {
    let Some((_, query)) = path.split_once('?') else {
        return "";
    };
    let prefix = format!("{name}=");
    for pair in query.split('&') {
        if let Some(value) = pair.strip_prefix(prefix.as_str()) {
            return value;
        }
    }
    ""
}

/// Minimales Prozent-Decoding (nur `%XX` und `+`) — reicht für den
/// einen `data=`-Parameter unten (die vom Bedien-UI per
/// `encodeURIComponent()` kodierte volle Einladungs-URL), keine externe
/// URL-Bibliothek nötig für diesen einzigen Anwendungsfall.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Rendert einen QR-Code für `data` als eigenständiges SVG (kein
/// `<image>`-Datenblock, direkt einbettbares Markup) — von Hand aus den
/// rohen QR-Modulen gebaut statt über das `svg`-Feature der `qrcode`-
/// Kiste, um deren zusätzliche transitive Abhängigkeiten zu vermeiden
/// (Minimal-Dependency-Regel, s. Cargo.toml-Kommentar; `cargo tree`
/// bestätigt: mit `default-features=false` hat `qrcode` selbst KEINE
/// transitiven Abhängigkeiten).
pub fn render_svg(data: &str) -> Result<String, String> {
    let code = QrCode::new(data.as_bytes()).map_err(|e| format!("QR-Code: {e}"))?;
    let width = code.width();
    // Eine helle Randzone (quiet zone) gehört zum QR-Standard — ohne sie
    // lesen manche Scanner (v. a. bei knappem Kameraausschnitt) den Code
    // nicht zuverlässig.
    const QUIET: i32 = 4;
    let size = width as i32 + 2 * QUIET;
    let mut svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" shape-rendering="crispEdges">"#
    );
    // Kein Raw-String hier (anders als die Zeile oben): eine bare `#`
    // (Farb-Hex) direkt nach `"` bildet zufällig `"#`, das GENAU die
    // `r#"…"#`-Endesequenz ist und den Raw-String vorzeitig
    // abschließt — live als Compile-Fehler gefunden, nicht geraten.
    svg.push_str(&format!("<rect width=\"{size}\" height=\"{size}\" fill=\"#ffffff\"/>"));
    for y in 0..width {
        for x in 0..width {
            if code[(x, y)] == qrcode::Color::Dark {
                svg.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"1\" height=\"1\" fill=\"#000000\"/>",
                    x as i32 + QUIET,
                    y as i32 + QUIET
                ));
            }
        }
    }
    svg.push_str("</svg>");
    Ok(svg)
}

/// Behandelt `/invites`+`/invites/qr` — von `CameraStore`/`MonitorStore`
/// aus deren jeweiligem `extra_route` aufgerufen (BEIDE Richtungen
/// brauchen identische Einladungsverwaltung, daher hier gebündelt statt
/// dupliziert). `None`, wenn `path` (ohne Query-String) zu keiner
/// dieser Routen passt — der Aufrufer prüft dann seine eigenen Routen
/// weiter.
///
/// `on_revoke` (Bugliste 2026-09-25 #1, "bei 'widerrufen' muss (optional
/// durch Abfrage) die bestehende Verbindung getrennt werden können"):
/// wird NUR nach einem erfolgreichen `DELETE /invites` aufgerufen, mit
/// dem widerrufenen Token und dem `disconnect=true`-Query-Flag (von der
/// Bedienoberfläche gesetzt, NACHDEM der Bediener die Rückfrage bestätigt
/// hat — "optional durch Abfrage", nicht automatisch bei jedem Widerruf).
/// Der Aufrufer (`CameraStore`/`MonitorStore`) entscheidet selbst, ob der
/// widerrufene Token zur AKTUELL aktiven Sitzung gehört (`active_token`)
/// und trennt in dem Fall per `gateway.teardown()`/`monitor.teardown()`
/// — `invite.rs` kennt keine Sitzungen, nur Tokens.
pub fn route(
    store: &InviteStore,
    method: &str,
    path: &str,
    body: &[u8],
    on_revoke: impl FnOnce(&str, bool),
) -> Option<RawResponse> {
    let text = |status: u16, msg: &str| RawResponse { status, content_type: "text/plain", body: msg.as_bytes().to_vec() };
    let bare_path = path.split('?').next().unwrap_or(path);
    match (method, bare_path) {
        ("POST", "/invites") => {
            // Kein eigener Deserialize-Typ (spart die `serde`-Derive-
            // Abhängigkeit für dieses eine optionale Feld) — direkt über
            // den bereits vorhandenen `serde_json::Value`.
            let label = std::str::from_utf8(body)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .and_then(|v| v.get("label").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default();
            let invite = store.create(label);
            Some(RawResponse {
                status: 201,
                content_type: "application/json",
                body: serde_json::json!({"token": invite.token, "label": invite.label, "createdAtMs": invite.created_at_ms})
                    .to_string()
                    .into_bytes(),
            })
        }
        ("GET", "/invites") => {
            let list: Vec<_> = store
                .list()
                .into_iter()
                .map(|i| serde_json::json!({"token": i.token, "label": i.label, "createdAtMs": i.created_at_ms}))
                .collect();
            Some(RawResponse {
                status: 200,
                content_type: "application/json",
                body: serde_json::json!(list).to_string().into_bytes(),
            })
        }
        ("DELETE", "/invites") => {
            let token = query_param(path, "token");
            if store.revoke(token) {
                let also_disconnect = query_param(path, "disconnect") == "true";
                on_revoke(token, also_disconnect);
                Some(text(200, "ok"))
            } else {
                Some(text(404, "unknown token"))
            }
        }
        ("GET", "/invites/qr") => {
            let data = percent_decode(query_param(path, "data"));
            if data.is_empty() {
                return Some(text(400, "data required"));
            }
            Some(match render_svg(&data) {
                Ok(svg) => RawResponse { status: 200, content_type: "image/svg+xml", body: svg.into_bytes() },
                Err(e) => text(500, &e),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_store_accepts_no_token_secure_by_default() {
        let store = InviteStore::new();
        assert!(!store.is_valid(""));
        assert!(!store.is_valid("anything"));
    }

    #[test]
    fn create_then_valid_then_revoke_then_invalid() {
        let store = InviteStore::new();
        let invite = store.create("Kamera Regie 1".to_string());
        assert!(store.is_valid(&invite.token));
        assert_eq!(store.list().len(), 1);

        assert!(store.revoke(&invite.token));
        assert!(!store.is_valid(&invite.token));
        assert!(store.list().is_empty());
    }

    #[test]
    fn revoke_unknown_token_is_false_not_panic() {
        let store = InviteStore::new();
        assert!(!store.revoke("does-not-exist"));
    }

    #[test]
    fn empty_token_is_never_valid_even_if_somehow_listed() {
        // Verteidigungslinie gegen einen (aktuell nicht möglichen) leeren
        // Token in der Liste — ein fehlender Query-Parameter liefert ""
        // von `token_from_query`, das darf NIE als "irgendeine gültige
        // Einladung" durchrutschen.
        let store = InviteStore::new();
        store.create(String::new());
        assert!(!store.is_valid(""));
    }

    #[test]
    fn token_from_query_extracts_exact_value() {
        assert_eq!(token_from_query("/whip?token=abc-123"), "abc-123");
        assert_eq!(token_from_query("/whip"), "");
        assert_eq!(token_from_query("/whip?other=1&token=xyz"), "xyz");
        assert_eq!(token_from_query("/whip?token=xyz&other=1"), "xyz");
    }

    #[test]
    fn percent_decode_handles_typical_encoded_url() {
        // Das Bedien-UI kodiert die volle Einladungs-URL per
        // `encodeURIComponent()`, bevor sie als `data=`-Parameter an
        // `/invites/qr` geht.
        let encoded = "https%3A%2F%2F192.168.1.5%3A9441%2F%3Ftoken%3Dabc";
        assert_eq!(percent_decode(encoded), "https://192.168.1.5:9441/?token=abc");
    }

    #[test]
    fn render_svg_produces_well_formed_svg_with_expected_module_count() {
        let svg = render_svg("https://example.test/?token=abc").expect("render_svg");
        assert!(svg.starts_with("<svg"));
        assert!(svg.ends_with("</svg>"));
        // Mindestens die weiße Hintergrundfläche plus tatsächliche
        // Module — kein leeres/kaputtes Ergebnis.
        assert!(svg.matches("<rect").count() > 10);
    }

    #[test]
    fn route_create_list_revoke_roundtrip() {
        let store = InviteStore::new();

        let created = route(&store, "POST", "/invites", br#"{"label":"Test"}"#, |_, _| {}).expect("create response");
        assert_eq!(created.status, 201);
        let created_json: Value = serde_json::from_slice(&created.body).expect("json");
        let token = created_json["token"].as_str().expect("token").to_string();
        assert_eq!(created_json["label"], "Test");

        let listed = route(&store, "GET", "/invites", b"", |_, _| {}).expect("list response");
        let list_json: Value = serde_json::from_slice(&listed.body).expect("json");
        assert_eq!(list_json.as_array().expect("array").len(), 1);

        let revoke_path = format!("/invites?token={token}");
        let revoked = route(&store, "DELETE", &revoke_path, b"", |_, _| {}).expect("revoke response");
        assert_eq!(revoked.status, 200);
        assert!(!store.is_valid(&token));

        // Widerruf eines bereits widerrufenen Tokens ist ein ehrliches
        // 404, kein stiller Erfolg.
        let revoked_again = route(&store, "DELETE", &revoke_path, b"", |_, _| {}).expect("second revoke response");
        assert_eq!(revoked_again.status, 404);
    }

    #[test]
    fn route_revoke_calls_on_revoke_with_token_and_disconnect_flag() {
        let store = InviteStore::new();
        let invite = store.create("Kamera".to_string());

        let mut seen: Option<(String, bool)> = None;
        let revoke_path = format!("/invites?token={}&disconnect=true", invite.token);
        let revoked = route(&store, "DELETE", &revoke_path, b"", |token, disconnect| {
            seen = Some((token.to_string(), disconnect));
        })
        .expect("revoke response");
        assert_eq!(revoked.status, 200);
        assert_eq!(seen, Some((invite.token, true)));
    }

    #[test]
    fn route_revoke_unknown_token_never_calls_on_revoke() {
        let store = InviteStore::new();
        let mut called = false;
        let revoked = route(&store, "DELETE", "/invites?token=nope", b"", |_, _| called = true).expect("revoke response");
        assert_eq!(revoked.status, 404);
        assert!(!called);
    }

    #[test]
    fn route_qr_requires_data_param() {
        let store = InviteStore::new();
        let missing = route(&store, "GET", "/invites/qr", b"", |_, _| {}).expect("response");
        assert_eq!(missing.status, 400);

        let ok = route(&store, "GET", "/invites/qr?data=https%3A%2F%2Fexample.test%2F", b"", |_, _| {}).expect("response");
        assert_eq!(ok.status, 200);
        assert_eq!(ok.content_type, "image/svg+xml");
    }

    #[test]
    fn route_unknown_path_returns_none() {
        let store = InviteStore::new();
        assert!(route(&store, "GET", "/something-else", b"", |_, _| {}).is_none());
    }
}
