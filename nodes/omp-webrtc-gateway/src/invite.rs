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
//! KEINE gültige Einladung, s. u.). **Seit Kap. 81 (Nutzerfund
//! 2026-11-02, "bei einem Handy-Gateway-Neustart gehen die Einladungslinks
//! verloren") ist das überholt:** [`InviteStore::persistent`] legt den
//! Satz in einer Datei (Rechte 0600, atomar geschrieben) ab und lädt ihn
//! beim Start. Ohne Datei (Tests) bleibt es rein im Speicher. `/whip`/`/whep` (POST **und**
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

use std::path::PathBuf;
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
    /// Ablage für den Satz; `None` = nur im Speicher.
    file: Option<PathBuf>,
}

impl InviteStore {
    pub fn new() -> Self {
        Self { invites: Mutex::new(Vec::new()), file: None }
    }

    /// Wie [`Self::new`], aber mit Ablage in `file`: lädt vorhandene
    /// Einladungen und schreibt jede Änderung zurück. Eine fehlende Datei
    /// ist ein leerer Satz; eine unlesbare/kaputte Datei wird gemeldet und
    /// NICHT überschrieben, solange nichts geändert wird (sicher-per-Default
    /// bleibt: dann gibt es eben keine Einladung).
    pub fn persistent(file: PathBuf) -> Self {
        let invites = match std::fs::read(&file) {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(v) => parse_invites(&v),
                Err(e) => {
                    eprintln!("omp-webrtc-gateway: Einladungsdatei {} ist kaputt, ignoriert: {e}", file.display());
                    Vec::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                eprintln!("omp-webrtc-gateway: Einladungsdatei {} nicht lesbar: {e}", file.display());
                Vec::new()
            }
        };
        Self { invites: Mutex::new(invites), file: Some(file) }
    }

    /// Schreibt den Satz atomar (Nachbardatei + Umbenennen), Rechte 0600,
    /// weil die Tokens Zugangsdaten sind.
    fn save(&self, invites: &[Invite]) {
        let Some(path) = &self.file else { return };
        let doc = serde_json::json!({
            "invites": invites.iter().map(|i| serde_json::json!({
                "token": i.token, "label": i.label, "createdAtMs": i.created_at_ms
            })).collect::<Vec<_>>()
        });
        let result = (|| -> std::io::Result<()> {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            if let Some(dir) = path.parent() {
                if !dir.as_os_str().is_empty() {
                    std::fs::create_dir_all(dir)?;
                }
            }
            let tmp = path.with_extension("json.tmp");
            let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
            f.write_all(doc.to_string().as_bytes())?;
            f.sync_all()?;
            std::fs::rename(&tmp, path)
        })();
        if let Err(e) = result {
            eprintln!("omp-webrtc-gateway: Einladungen nicht gespeichert ({}): {e}", path.display());
        }
    }

    /// Erzeugt eine neue Einladung mit optionalem Label (z. B. "Kamera
    /// Regie 1" — reine Gedächtnisstütze für die Bedienoberfläche, hat
    /// keine sicherheitsrelevante Bedeutung).
    pub fn create(&self, label: String) -> Invite {
        let token = omp_node_sdk::idgen::new_v4();
        let created_at_ms = now_ms();
        let invite = Invite { token, label, created_at_ms };
        let mut guard = self.invites.lock().expect("lock poisoned");
        guard.push(invite.clone());
        self.save(&guard);
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
        let removed = guard.len() != before;
        if removed {
            self.save(&guard);
        }
        removed
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

/// Kehrdienst (Kap. 81): löscht in `dir` Einladungsdateien (`invites-*.json`,
/// auch liegengebliebene `.json.tmp`) anderer Instanzen, die seit `max_age`
/// nicht verändert wurden. Die eigene Datei (`keep`) bleibt immer. Gibt die
/// Zahl der gelöschten Dateien zurück. Laufende Instanzen halten ihre Datei
/// frisch (s. [`spawn_housekeeping`]), sie werden also nicht erwischt.
pub fn sweep_stale(dir: &std::path::Path, keep: &std::path::Path, max_age: std::time::Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let now = SystemTime::now();
    let mut removed = 0;
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        let ours = name.starts_with("invites-") && (name.ends_with(".json") || name.ends_with(".json.tmp"));
        if !ours || path == keep {
            continue;
        }
        let old = e
            .metadata()
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > max_age);
        if old && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Räumt beim Start alte Dateien anderer Instanzen weg und schreibt die eigene
/// Datei danach täglich neu, damit ihr Änderungsdatum frisch bleibt (sonst
/// würde eine lange laufende, unveränderte Instanz von der Aufräumung einer
/// anderen erwischt). Nur mit Ablage; sonst ohne Wirkung.
pub fn spawn_housekeeping(store: std::sync::Arc<InviteStore>, max_age: std::time::Duration) {
    let Some(file) = store.file.clone() else { return };
    if let Some(dir) = file.parent() {
        let n = sweep_stale(dir, &file, max_age);
        if n > 0 {
            eprintln!("omp-webrtc-gateway: {n} alte Einladungsdatei(en) in {} aufgeräumt", dir.display());
        }
    }
    let _ = std::thread::Builder::new().name("invite-housekeeping".into()).spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(24 * 3600));
        let snapshot = store.list();
        store.save(&snapshot);
    });
}

fn parse_invites(v: &Value) -> Vec<Invite> {
    v.get("invites")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    let token = x.get("token")?.as_str()?.to_string();
                    if token.is_empty() {
                        return None;
                    }
                    Some(Invite {
                        token,
                        label: x.get("label").and_then(Value::as_str).unwrap_or_default().to_string(),
                        created_at_ms: x.get("createdAtMs").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
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

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omp-invite-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("sub").join("invites.json")
    }

    #[test]
    fn persistent_store_survives_restart_and_revoke() {
        let file = temp_file("roundtrip");
        let a = InviteStore::persistent(file.clone());
        let one = a.create("Kamera 1".into());
        let two = a.create("Kamera 2".into());
        drop(a);

        let b = InviteStore::persistent(file.clone());
        assert!(b.is_valid(&one.token) && b.is_valid(&two.token));
        let listed = b.list();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].label, "Kamera 1");
        assert_eq!(listed[0].created_at_ms, one.created_at_ms);
        assert!(b.revoke(&one.token));
        drop(b);

        let c = InviteStore::persistent(file.clone());
        assert!(!c.is_valid(&one.token) && c.is_valid(&two.token));

        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(file.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn persistent_store_with_broken_or_missing_file_starts_empty() {
        let file = temp_file("broken");
        assert!(InviteStore::persistent(file.clone()).list().is_empty());
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"{kaputt").unwrap();
        let s = InviteStore::persistent(file.clone());
        assert!(s.list().is_empty());
        assert!(!s.is_valid(""));
        // Leere Tokens aus einer Datei werden nie gültig.
        std::fs::write(&file, br#"{"invites":[{"token":"","label":"x"}]}"#).unwrap();
        assert!(InviteStore::persistent(file.clone()).list().is_empty());
        let _ = std::fs::remove_dir_all(file.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn sweep_removes_only_old_foreign_invite_files() {
        let dir = std::env::temp_dir().join(format!("omp-invite-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let keep = dir.join("invites-camera-eigene.json");
        let old = dir.join("invites-camera-alt.json");
        let old_tmp = dir.join("invites-monitor-alt.json.tmp");
        let young = dir.join("invites-camera-jung.json");
        let other = dir.join("etwas-anderes.json");
        for f in [&keep, &old, &old_tmp, &young, &other] {
            std::fs::write(f, b"{}").unwrap();
        }
        let ancient = SystemTime::now() - std::time::Duration::from_secs(200 * 24 * 3600);
        for f in [&keep, &old, &old_tmp, &other] {
            std::fs::File::options().write(true).open(f).unwrap().set_modified(ancient).unwrap();
        }
        let n = sweep_stale(&dir, &keep, std::time::Duration::from_secs(90 * 24 * 3600));
        assert_eq!(n, 2);
        assert!(keep.exists() && young.exists() && other.exists());
        assert!(!old.exists() && !old_tmp.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
