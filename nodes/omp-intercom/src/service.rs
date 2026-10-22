//! Dienst-Schnittstelle des Intercom-Nodes (UMSETZUNG.md Kapitel 48): Manifest für das Dienst-Gateway des Orchestrators,
//! Routen-Zuordnung, Identität aus den Gateway-Headern, Panel-Link und Metriken. Reine Funktionen ohne Hub-Zugriff.

use serde_json::{Value, json};

pub const FEAT_USE: &str = "intercom.use";
pub const FEAT_ADMIN: &str = "intercom.admin";
/// Gast-Zugänge ausstellen und widerrufen (z. B. beim Einladen einer Handy-Kamera), ohne die Einrichtung zu verwalten.
pub const FEAT_GUEST: &str = "intercom.guest";

/// Header, die das Gateway setzt. Der Node vertraut ihnen nur mit gültigem Dienst-Geheimnis.
pub const H_TOKEN: &str = "x-omp-service-token";
pub const H_USER: &str = "x-omp-user";
pub const H_GROUPS: &str = "x-omp-groups";
pub const H_FEATURES: &str = "x-omp-features";
pub const H_REQUEST_HOST: &str = "x-omp-request-host";
pub const H_NODE_BASE: &str = "x-omp-node-base";
/// Antwort-Header: Audit-Hinweis (JSON `{"object":…,"action":…,"details":…}`), den das Gateway ins Audit-Log schreibt.
pub const H_AUDIT: &str = "x-omp-audit";

/// Die Aktionen des Dienstes.
#[derive(Debug, PartialEq)]
pub enum Op {
    GetConfig,
    PutConfig,
    Rotate(u32),
    /// Vertragsrolle `channels`: Kanäle zur Auswahl (z. B. beim Einladen).
    Channels,
    ListGuests,
    CreateGuest,
    DeleteGuest(u32),
    Panels,
    Status,
    Metrics,
    /// Datei der Dienst-Oberfläche (Bundle der Einrichtung/Kachel).
    Ui(String),
    /// Vertragsrolle `deck.state` / `deck.command`: Zustand bzw. Befehl einer Sprechstelle (Stream Deck, Anzeigen).
    DeckState(u32),
    DeckCommand(u32),
    /// Nur für den Orchestrator (einmaliger Import der Altkonfiguration), nicht im Manifest, nicht über das Gateway.
    Import,
    /// Nur für den Orchestrator: vollständige Konfiguration samt Token als Sicherungskopie (landet in dessen Datenbank).
    Backup,
}

/// Ordnet Methode und Pfad (ohne Query, ohne Präfix `/service`) einer Aktion zu.
pub fn route(method: &str, path: &str) -> Option<Op> {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let id = |s: &str| s.parse::<u32>().ok();
    Some(match (method, parts.as_slice()) {
        ("GET", ["config"]) => Op::GetConfig,
        ("PUT", ["config"]) => Op::PutConfig,
        ("POST", ["parties", p, "rotate-token"]) => Op::Rotate(id(p)?),
        ("GET", ["channels"]) => Op::Channels,
        ("GET", ["guests"]) => Op::ListGuests,
        ("POST", ["guests"]) => Op::CreateGuest,
        ("DELETE", ["guests", g]) => Op::DeleteGuest(id(g)?),
        ("GET", ["panels"]) => Op::Panels,
        ("GET", ["status"]) => Op::Status,
        ("GET", ["metrics"]) => Op::Metrics,
        ("GET", ["ui", file]) if !file.contains("..") => Op::Ui((*file).to_string()),
        ("GET", ["deck", p]) => Op::DeckState(id(p)?),
        ("POST", ["deck", p, "command"]) => Op::DeckCommand(id(p)?),
        ("POST", ["import"]) => Op::Import,
        ("GET", ["backup"]) => Op::Backup,
        _ => return None,
    })
}

/// Wer ruft? Aus den Gateway-Headern.
#[derive(Debug, Default, PartialEq)]
pub struct Identity {
    pub user: String,
    pub groups: Vec<String>,
    pub features: Vec<String>,
}

impl Identity {
    pub fn from_headers(get: impl Fn(&str) -> Option<String>) -> Self {
        let list = |name| get(name).map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
        Identity { user: get(H_USER).unwrap_or_default(), groups: list(H_GROUPS), features: list(H_FEATURES) }
    }

    pub fn can(&self, feature: &str) -> bool {
        self.features.iter().any(|f| f == feature)
    }

    /// Wer in den Anmeldemodus ohne Personen fällt (Bootstrap): Gateway meldet keinen Nutzer, aber alle Rechte.
    pub fn is_bootstrap(&self) -> bool {
        self.user.is_empty()
    }
}

/// Vergleich ohne Zeitunterschied bei verschiedenen Längen des gemeinsamen Präfixes.
pub fn secrets_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn is_loopback(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']');
    h == "localhost" || h.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// `http://host:port[/…]` → (host ohne Klammern, Port).
fn split_base(base: &str) -> Option<(String, String)> {
    let rest = base.split_once("://").map(|(_, r)| r).unwrap_or(base);
    let authority = rest.split('/').next()?;
    if let Some(inner) = authority.strip_prefix('[') {
        let (host, tail) = inner.split_once(']')?;
        return Some((host.to_string(), tail.strip_prefix(':').unwrap_or("").to_string()));
    }
    Some(match authority.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.to_string()),
        None => (authority.to_string(), String::new()),
    })
}

fn join_host_port(host: &str, port: &str) -> String {
    let h = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
    if port.is_empty() { h } else { format!("{h}:{port}") }
}

pub fn query_escape(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// Link zum Panel eines Teilnehmers. `node_base`: so erreicht der Orchestrator den Node; `request_host`: so erreicht die
/// Person den Orchestrator (für Nodes, die nur auf localhost lauschen); `https`: Antwort von `omp_node_sdk::https_info()`.
pub fn panel_url(node_base: &str, request_host: &str, token: &str, https: &Value) -> String {
    let (mut host, base_port) = split_base(node_base).unwrap_or_else(|| ("127.0.0.1".into(), String::new()));
    let node_loopback = is_loopback(&host);
    let req_host = split_base(request_host).map(|(h, _)| h).unwrap_or_default();
    let q = format!("/panel?token={}", query_escape(token));
    // Browser und Node auf demselben Rechner: einfaches HTTP über den normalen Node-Port. `localhost` gilt für das Mikrofon
    // als sicherer Kontext, die Zertifikats-Rückfrage des selbst signierten HTTPS entfällt.
    if node_loopback && is_loopback(&req_host) {
        return format!("http://{}{q}", join_host_port(&req_host, &base_port));
    }
    if node_loopback && !req_host.is_empty() {
        host = req_host;
    }
    let (mut scheme, mut port) = ("http", base_port);
    if https.get("enabled").and_then(Value::as_bool) == Some(true) {
        if let Some(p) = https.get("port").and_then(Value::as_u64).filter(|p| *p > 0) {
            scheme = "https";
            port = p.to_string();
        }
    }
    format!("{scheme}://{}{q}", join_host_port(&host, &port))
}

/// Kennzahlen im Prometheus-Textformat.
pub fn metrics_text(online: usize, total: usize, underruns: i64, late_ticks: u64, max_tick_us: u64) -> String {
    format!(
        "# HELP omp_intercom_parties Intercom-Teilnehmer\n# TYPE omp_intercom_parties gauge\n\
         omp_intercom_parties{{state=\"online\"}} {online}\nomp_intercom_parties{{state=\"total\"}} {total}\n\
         # HELP omp_intercom_late_ticks_total Verspätete 20-ms-Mischtakte\n# TYPE omp_intercom_late_ticks_total counter\nomp_intercom_late_ticks_total {late_ticks}\n\
         # HELP omp_intercom_max_tick_seconds Längster Mischdurchlauf\n# TYPE omp_intercom_max_tick_seconds gauge\nomp_intercom_max_tick_seconds {}\n\
         # HELP omp_intercom_underruns_total Eingangspuffer leer beim Abholen (Aussetzer)\n# TYPE omp_intercom_underruns_total counter\nomp_intercom_underruns_total {underruns}\n",
        max_tick_us as f64 / 1e6
    )
}

fn l(de: &str, en: &str) -> Value {
    json!({"de": de, "en": en})
}

/// Dienst-Manifest (`GET /service.json`): was das Gateway über den Dienst wissen muss — Name, Funktionsrechte, Routen mit
/// nötigem Recht (alles andere ist verboten), Oberfläche, Metrikpfad und die Altdaten, die es einmalig übernehmen kann.
/// `importable`: die Konfiguration ist leer, ein Import wäre möglich.
pub fn manifest(importable: bool) -> Value {
    let grp = l("Intercom", "Intercom");
    let route = |method: &str, path: &str, features: &[&str]| json!({"method": method, "path": path, "features": features});
    // Route mit Rolle im Vertrag des Diensttyps „intercom“ (docs/CONTRACT-INTERCOM.md).
    let role = |method: &str, path: &str, features: &[&str], role: &str| json!({"method": method, "path": path, "features": features, "role": role});
    json!({
        "name": "intercom",
        "kind": "intercom",
        "version": 1,
        "base": "/service",
        "features": [
            {"id": FEAT_USE, "group": grp, "label": l("Intercom nutzen", "Use intercom"),
             "description": l("Eigene Sprechstelle (Panel) öffnen und sprechen/hören.", "Open the own intercom panel and talk/listen.")},
            {"id": FEAT_GUEST, "group": grp, "label": l("Intercom-Gäste einladen", "Invite intercom guests"),
             "description": l("Befristete Gast-Zugänge ausstellen und widerrufen (z. B. für eine Handy-Kamera).", "Issue and revoke time-limited guest access (e.g. for a phone camera).")},
            {"id": FEAT_ADMIN, "group": grp, "label": l("Intercom einrichten", "Configure intercom"),
             "description": l("Kanäle, Teilnehmer, Rollenplätze und Gast-Zugänge verwalten.", "Manage channels, parties, seats and guest access.")},
        ],
        "routes": [
            route("GET", "/config", &[FEAT_ADMIN]),
            route("PUT", "/config", &[FEAT_ADMIN]),
            route("POST", "/parties/{id}/rotate-token", &[FEAT_ADMIN]),
            route("GET", "/guests", &[FEAT_ADMIN]),
            role("POST", "/guests", &[FEAT_ADMIN, FEAT_GUEST], "guest.create"),
            role("DELETE", "/guests/{id}", &[FEAT_ADMIN, FEAT_GUEST], "guest.revoke"),
            role("GET", "/channels", &[FEAT_USE, FEAT_ADMIN, FEAT_GUEST], "channels"),
            role("GET", "/panels", &[FEAT_USE, FEAT_ADMIN], "panels"),
            role("GET", "/status", &[FEAT_USE, FEAT_ADMIN], "status"),
            role("GET", "/deck/{party}", &[FEAT_USE, FEAT_ADMIN], "deck.state"),
            role("POST", "/deck/{party}/command", &[FEAT_USE, FEAT_ADMIN], "deck.command"),
        ],
        "ui": [{
            "id": "intercom", "placement": "admin:production",
            "group": l("Produktion", "Production"), "label": l("Intercom", "Intercom"),
            "element": "omp-intercom-admin", "bundle": "admin.js",
        }],
        "tiles": [{
            "id": "intercom", "label": l("Intercom", "Intercom"), "needs": [FEAT_USE],
            "element": "omp-intercom-tile", "bundle": "admin.js",
        }],
        "metrics": "/metrics",
        // Altdaten, die das Gateway einmalig übernimmt (Einstellungsspeicher des Orchestrators → Datei des Dienstes).
        "import": {"settings_key": "intercom.config", "path": "/import", "importable": importable},
        // Sicherungskopie: das Gateway holt sie regelmäßig in die Datenbank des Orchestrators (Datensicherung) und spielt
        // sie ein, wenn der Dienst leer startet (Datei verloren, Node auf anderem Host).
        "backup": "/backup",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_map_and_reject() {
        assert_eq!(route("GET", "/config"), Some(Op::GetConfig));
        assert_eq!(route("PUT", "/config"), Some(Op::PutConfig));
        assert_eq!(route("POST", "/parties/7/rotate-token"), Some(Op::Rotate(7)));
        assert_eq!(route("DELETE", "/guests/100001"), Some(Op::DeleteGuest(100001)));
        assert_eq!(route("POST", "/guests"), Some(Op::CreateGuest));
        assert_eq!(route("DELETE", "/guests/abc"), None);
        assert_eq!(route("GET", "/ui/admin.js"), Some(Op::Ui("admin.js".into())));
        assert_eq!(route("GET", "/ui/..%2fx"), None, "kein Ausbruch aus ui/");
        assert_eq!(route("GET", "/channels"), Some(Op::Channels));
        assert_eq!(route("GET", "/deck/3"), Some(Op::DeckState(3)));
        assert_eq!(route("POST", "/deck/3/command"), Some(Op::DeckCommand(3)));
        assert_eq!(route("POST", "/deck/x/command"), None);
        assert_eq!(route("DELETE", "/config"), None);
        assert_eq!(route("GET", "/parties/7/rotate-token"), None);
    }

    #[test]
    fn manifest_routes_are_all_served_and_import_is_not_exposed() {
        let m = manifest(true);
        for r in m["routes"].as_array().unwrap() {
            let path = r["path"].as_str().unwrap().replace("{id}", "5").replace("{party}", "5");
            assert!(route(r["method"].as_str().unwrap(), &path).is_some(), "Route {r} nicht umgesetzt");
            assert!(!r["features"].as_array().unwrap().is_empty(), "jede Route verlangt ein Recht");
        }
        assert!(m["routes"].as_array().unwrap().iter().all(|r| r["path"] != "/import" && r["path"] != "/backup"));
        assert_eq!(route("GET", "/backup"), Some(Op::Backup));
        assert_eq!(m["backup"], "/backup");
        assert_eq!(m["import"]["importable"], true);
        assert_eq!(m["kind"], "intercom");
        let roles: Vec<&str> = m["routes"].as_array().unwrap().iter().filter_map(|r| r["role"].as_str()).collect();
        assert_eq!(roles, ["guest.create", "guest.revoke", "channels", "panels", "status", "deck.state", "deck.command"]);
        let ids: Vec<&str> = m["features"].as_array().unwrap().iter().map(|f| f["id"].as_str().unwrap()).collect();
        assert_eq!(ids, [FEAT_USE, FEAT_GUEST, FEAT_ADMIN]);
    }

    #[test]
    fn identity_from_headers() {
        let h = |n: &str| match n {
            H_USER => Some("anna".to_string()),
            H_GROUPS => Some("g1, g2".to_string()),
            H_FEATURES => Some("intercom.use".to_string()),
            _ => None,
        };
        let id = Identity::from_headers(h);
        assert_eq!(id, Identity { user: "anna".into(), groups: vec!["g1".into(), "g2".into()], features: vec!["intercom.use".into()] });
        assert!(id.can(FEAT_USE) && !id.can(FEAT_ADMIN) && !id.is_bootstrap());
        assert!(Identity::from_headers(|_| None).is_bootstrap());
    }

    #[test]
    fn secret_comparison() {
        assert!(secrets_equal("abc", "abc"));
        assert!(!secrets_equal("abc", "abd") && !secrets_equal("abc", "ab"));
    }

    #[test]
    fn panel_url_https_port_and_request_host_for_loopback_node() {
        let https = json!({"enabled": true, "port": 9445});
        assert_eq!(panel_url("http://127.0.0.1:7001", "studio.lan:8080", "tok", &https), "https://studio.lan:9445/panel?token=tok");
        assert_eq!(panel_url("http://10.0.0.5:7001", "studio.lan:8080", "tok", &https), "https://10.0.0.5:9445/panel?token=tok");
        assert_eq!(panel_url("http://10.0.0.5:7001", "studio.lan", "tok", &json!({"enabled": false})), "http://10.0.0.5:7001/panel?token=tok");
    }

    #[test]
    fn panel_url_uses_plain_http_when_browser_and_node_share_the_machine() {
        let https = json!({"enabled": true, "port": 9445});
        assert_eq!(panel_url("http://127.0.0.1:7001", "localhost:8080", "t", &https), "http://localhost:7001/panel?token=t");
        assert_eq!(panel_url("http://127.0.0.1:7001", "127.0.0.1:8080", "t", &https), "http://127.0.0.1:7001/panel?token=t");
        assert_eq!(panel_url("http://[::1]:7001", "[::1]:8080", "a b", &https), "http://[::1]:7001/panel?token=a%20b");
    }

    #[test]
    fn metrics_text_has_all_series() {
        let t = metrics_text(2, 5, 3, 7, 1500);
        for s in ["omp_intercom_parties{state=\"online\"} 2", "state=\"total\"} 5", "late_ticks_total 7", "max_tick_seconds 0.0015", "underruns_total 3"] {
            assert!(t.contains(s), "{s}\n{t}");
        }
    }
}
