//! HTTP-Client für die TAMS-API 8.2 (Kapitel 105.2). Blockierend (`ureq`), für Worker-Threads der Nodes.
//!
//! Regeln (Entscheidungen D-T3/D-T4, Spezifikation 8.2):
//! * Beim Aufbau wird **TLS verlangt**, außer die Adresse ist Loopback (Tests).
//! * Keine Weiterleitungen (sonst würden Zugangsdaten an fremde Ursprünge gehen).
//! * Zugangsdaten gehen nur an den **gleichen Ursprung** wie die API-Adresse. Für Adressen fremder Ursprünge
//!   (z. B. vorab signierte Objekt-Adressen) werden sie nie mitgeschickt. Eine `Link`-Adresse eines fremden
//!   Ursprungs beim Seitenabruf ist ein Fehler.
//! * Wiederholungen (Rückstau) nur bei Verbindungsfehlern und `408/429/500/502/503/504` und nur für Abläufe, die ohne
//!   Nebenwirkung wiederholbar sind (Lesen, Objekt hochladen, Flow anlegen, Löschen). **Segmente registrieren
//!   wiederholt der Client nicht selbst**: ob das erneut zulässig ist, entscheidet der Schreiber (105.3).
//! * Fehlermeldungen enthalten kein Token ([`crate::auth::redact_url`]).

use crate::auth::{Auth, URL_TOKEN_PARAM, redact_url};
use crate::time::TimeRange;
use crate::types::{BulkFailure, MediaObjectSlot, Segment, SegmentPost, ServiceInfo, StorageRequest, StorageResponse, WebhookPost};
use crate::{VersionCheck, check_api_version};
use serde::Serialize;
use std::fmt;
use std::time::Duration;

#[derive(Debug)]
pub enum Error {
    /// Ungültige Einstellung (Adresse, TLS-Pflicht, …).
    Config(String),
    /// Verbindung/Zeitüberschreitung/TLS.
    Transport(String),
    /// Der Dienst hat mit einem Fehlerstatus geantwortet.
    Status { code: u16, detail: String },
    /// Antwort nicht lesbar oder gegen die Spezifikation.
    Protocol(String),
    /// Hauptversion des Dienstes wird nicht unterstützt (D-T4).
    Version(String),
}

impl Error {
    /// Lohnt sich ein erneuter Versuch?
    pub fn is_retryable(&self) -> bool {
        match self {
            Error::Transport(_) => true,
            Error::Status { code, .. } => matches!(code, 408 | 429 | 500 | 502 | 503 | 504),
            _ => false,
        }
    }
    pub fn status(&self) -> Option<u16> {
        if let Error::Status { code, .. } = self { Some(*code) } else { None }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Config(s) => write!(f, "TAMS-Einstellung: {s}"),
            Error::Transport(s) => write!(f, "TAMS-Verbindung: {s}"),
            Error::Status { code, detail } => write!(f, "TAMS antwortet {code}: {detail}"),
            Error::Protocol(s) => write!(f, "TAMS-Antwort: {s}"),
            Error::Version(s) => write!(f, "TAMS-Version: {s}"),
        }
    }
}
impl std::error::Error for Error {}

/// Wiederholung mit Rückstau (verdoppelt sich je Versuch, gedeckelt).
#[derive(Clone, Copy, Debug)]
pub struct RetryPolicy {
    pub attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
}
impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy { attempts: 3, base_delay: Duration::from_millis(200), max_delay: Duration::from_secs(5) }
    }
}
impl RetryPolicy {
    pub fn none() -> Self {
        RetryPolicy { attempts: 1, ..Default::default() }
    }
    pub(crate) fn delay(&self, failed_attempt: u32) -> Duration {
        self.base_delay.saturating_mul(1u32 << failed_attempt.min(16)).min(self.max_delay)
    }
}

#[derive(Clone, Debug)]
pub struct ClientConfig {
    /// Basisadresse **einschließlich** Versionspfad, z. B. `https://tams.example/tams/v8.2`.
    pub base_url: String,
    pub auth: Auth,
    pub timeout: Duration,
    pub retry: RetryPolicy,
    /// Obergrenze für Antworten der API (JSON), Byte.
    pub max_api_response: u64,
}

impl ClientConfig {
    pub fn new(base_url: impl Into<String>, auth: Auth) -> Self {
        ClientConfig { base_url: base_url.into(), auth, timeout: Duration::from_secs(30), retry: RetryPolicy::default(), max_api_response: 16 << 20 }
    }
}

/// Ergebnis von „Segmente registrieren“.
#[derive(Debug, PartialEq)]
pub enum Registered {
    /// 201: alle Segmente angelegt.
    All,
    /// 200: einzelne Segmente abgelehnt (Rest ist angelegt).
    Partial(BulkFailure),
}

/// Ergebnis von „Segmente löschen“.
#[derive(Debug, PartialEq, Eq)]
pub enum Deleted {
    /// 204.
    Done,
    /// 202: läuft im Hintergrund; `Location` verweist auf die Löschanfrage.
    Accepted { location: Option<String> },
}

/// Eine Seite Segmente.
#[derive(Debug)]
pub struct SegmentPage {
    pub segments: Vec<Segment>,
    /// Adresse der nächsten Seite (aus `Link`, sonst aus `X-Paging-NextKey` gebildet).
    pub next: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SegmentQuery {
    pub timerange: Option<TimeRange>,
    pub reverse_order: bool,
    /// `accept_get_urls`: Bezeichner der gewünschten Adressen (leer = keine Adressen anfordern).
    pub accept_get_urls: Option<Vec<String>>,
    pub presigned: Option<bool>,
    pub limit: Option<u32>,
    pub include_object_timerange: bool,
}

#[derive(Debug)]
struct Resp {
    status: u16,
    link: Option<String>,
    next_key: Option<String>,
    location: Option<String>,
    body: Vec<u8>,
}

pub struct Client {
    cfg: ClientConfig,
    base: String,
    origin: String,
    agent: ureq::Agent,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Client({})", redact_url(&self.base))
    }
}

impl Client {
    pub fn new(cfg: ClientConfig) -> Result<Client, Error> {
        let base = cfg.base_url.trim().trim_end_matches('/').to_string();
        let origin = origin_of(&base).ok_or_else(|| Error::Config(format!("Adresse {:?} ist keine gültige http(s)-Adresse ohne Benutzerinfo", redact_url(&base))))?;
        if origin.starts_with("http://") && !is_loopback(&origin) {
            return Err(Error::Config("TLS ist Pflicht: http:// nur für Loopback (localhost, 127.x, ::1)".into()));
        }
        if base.contains('?') || base.contains('#') {
            return Err(Error::Config("Adresse darf keine Query enthalten; Token gehören in die Zugangsdaten".into()));
        }
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(cfg.timeout))
            .build()
            .into();
        Ok(Client { cfg, base, origin, agent })
    }

    // ---- Dienst -------------------------------------------------------------------------------------------------

    /// `GET /service` und Versionsprüfung (D-T4): andere Hauptversion → [`Error::Version`].
    pub fn service(&self) -> Result<(ServiceInfo, VersionCheck), Error> {
        let r = self.call("GET", &format!("{}/service", self.base), None, true, self.cfg.max_api_response)?;
        if r.status != 200 {
            return Err(unexpected(r.status, &r));
        }
        let info: ServiceInfo = decode(&r)?;
        match check_api_version(&info.api_version) {
            VersionCheck::Reject(msg) => Err(Error::Version(msg)),
            v => Ok((info, v)),
        }
    }

    // ---- Flows --------------------------------------------------------------------------------------------------

    /// `PUT /flows/{id}`: `true` = neu angelegt (201), `false` = aktualisiert (204).
    pub fn put_flow<T: Serialize>(&self, flow_id: &str, flow: &T) -> Result<bool, Error> {
        check_id(flow_id)?;
        let body = serde_json::to_vec(flow).map_err(|e| Error::Protocol(format!("Flow nicht darstellbar: {e}")))?;
        let r = self.call("PUT", &format!("{}/flows/{flow_id}", self.base), Some(("application/json", &body)), true, self.cfg.max_api_response)?;
        match r.status {
            201 => Ok(true),
            200 | 204 => Ok(false),
            s => Err(unexpected(s, &r)),
        }
    }

    /// `GET /flows/{id}`: Beschreibung eines Flows (als JSON, damit auch unbekannte Felder erhalten bleiben).
    pub fn get_flow(&self, flow_id: &str) -> Result<serde_json::Value, Error> {
        check_id(flow_id)?;
        let r = self.call("GET", &format!("{}/flows/{flow_id}", self.base), None, true, self.cfg.max_api_response)?;
        if r.status != 200 {
            return Err(unexpected(r.status, &r));
        }
        decode(&r)
    }

    /// `POST /flows/{id}/storage`: Plätze für neue Objects.
    pub fn request_storage(&self, flow_id: &str, req: &StorageRequest) -> Result<StorageResponse, Error> {
        check_id(flow_id)?;
        let body = serde_json::to_vec(req).map_err(|e| Error::Protocol(e.to_string()))?;
        // Nicht wiederholbar ohne Nebenwirkung: jeder Aufruf reserviert neue Object-IDs (unbenutzte werden vom Dienst verworfen).
        let r = self.call("POST", &format!("{}/flows/{flow_id}/storage", self.base), Some(("application/json", &body)), false, self.cfg.max_api_response)?;
        if r.status != 201 {
            return Err(unexpected(r.status, &r));
        }
        decode(&r)
    }

    /// Object hochladen (`PUT` auf die vom Dienst genannte Adresse). Zugangsdaten nur bei gleichem Ursprung.
    pub fn upload_object(&self, slot: &MediaObjectSlot, content_type: &str, data: &[u8]) -> Result<(), Error> {
        let ct = slot.put_url.content_type.as_deref().unwrap_or(content_type);
        let url = &slot.put_url.url;
        let extra: Vec<(String, String)> = slot.put_url.headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let r = self.call_full("PUT", url, Some((ct, data)), true, 64 << 10, &extra)?;
        if (200..300).contains(&r.status) { Ok(()) } else { Err(unexpected(r.status, &r)) }
    }

    /// `POST /flows/{id}/segments` (ein Feld von Segmenten). Nicht automatisch wiederholt (siehe Moduldoku).
    pub fn register_segments(&self, flow_id: &str, segments: &[SegmentPost]) -> Result<Registered, Error> {
        check_id(flow_id)?;
        if segments.is_empty() {
            return Ok(Registered::All);
        }
        let body = serde_json::to_vec(segments).map_err(|e| Error::Protocol(e.to_string()))?;
        let r = self.call("POST", &format!("{}/flows/{flow_id}/segments", self.base), Some(("application/json", &body)), false, self.cfg.max_api_response)?;
        match r.status {
            201 => Ok(Registered::All),
            200 => Ok(Registered::Partial(decode(&r)?)),
            s => Err(unexpected(s, &r)),
        }
    }

    /// Eine Seite von `GET /flows/{id}/segments`. `page` = Adresse aus [`SegmentPage::next`] (oder `None` für die erste).
    pub fn segments_page(&self, flow_id: &str, q: &SegmentQuery, page: Option<&str>) -> Result<SegmentPage, Error> {
        check_id(flow_id)?;
        let url = match page {
            Some(p) => {
                // Nur Adressen des eigenen Ursprungs: keine Zugangsdaten an Fremde, kein Umlenken auf interne Ziele.
                if origin_of(p).as_deref() != Some(self.origin.as_str()) {
                    return Err(Error::Protocol(format!("Folgeseite zeigt auf fremden Ursprung: {}", redact_url(p))));
                }
                p.to_string()
            }
            None => format!("{}/flows/{flow_id}/segments{}", self.base, query_string(q)),
        };
        let r = self.call("GET", &url, None, true, self.cfg.max_api_response)?;
        if r.status != 200 {
            return Err(unexpected(r.status, &r));
        }
        let segments: Vec<Segment> = decode(&r)?;
        let next = match (&r.link, &r.next_key) {
            (Some(l), _) => parse_link_next(l).map(|u| absolute(&self.origin, &u)),
            (None, Some(k)) => Some(add_query(&url_without_page(&url), "page", k)),
            _ => None,
        };
        Ok(SegmentPage { segments, next })
    }

    /// Alle Segmente (folgt den Seiten). `max_segments` schützt vor unbegrenzten Antworten.
    pub fn list_segments(&self, flow_id: &str, q: &SegmentQuery, max_segments: usize) -> Result<Vec<Segment>, Error> {
        let mut all = Vec::new();
        let mut page: Option<String> = None;
        let mut seen: Vec<String> = Vec::new();
        loop {
            let p = self.segments_page(flow_id, q, page.as_deref())?;
            all.extend(p.segments);
            if all.len() > max_segments {
                return Err(Error::Protocol(format!("mehr als {max_segments} Segmente in der Antwort")));
            }
            match p.next {
                Some(n) => {
                    if seen.contains(&n) {
                        return Err(Error::Protocol("Seitenabruf dreht sich im Kreis".into()));
                    }
                    seen.push(n.clone());
                    page = Some(n);
                }
                None => return Ok(all),
            }
        }
    }

    /// Object laden. `url` = eine der `get_urls` eines Segments. `max_bytes` begrenzt die Größe.
    pub fn download_object(&self, url: &str, max_bytes: u64) -> Result<Vec<u8>, Error> {
        let r = self.call_full("GET", url, None, true, max_bytes, &[])?;
        if r.status == 200 { Ok(r.body) } else { Err(unexpected(r.status, &r)) }
    }

    /// `DELETE /flows/{id}`: ganzen Flow löschen (204, oder 202 bei längerer Dauer).
    pub fn delete_flow(&self, flow_id: &str) -> Result<Deleted, Error> {
        check_id(flow_id)?;
        let r = self.call("DELETE", &format!("{}/flows/{flow_id}", self.base), None, true, self.cfg.max_api_response)?;
        match r.status {
            204 => Ok(Deleted::Done),
            202 => Ok(Deleted::Accepted { location: r.location }),
            s => Err(unexpected(s, &r)),
        }
    }

    /// `DELETE /flows/{id}/segments?timerange=…` (nur vollständig abgedeckte Segmente).
    pub fn delete_segments(&self, flow_id: &str, range: &TimeRange) -> Result<Deleted, Error> {
        check_id(flow_id)?;
        let url = format!("{}/flows/{flow_id}/segments?timerange={}", self.base, pct(&range.to_string()));
        let r = self.call("DELETE", &url, None, true, self.cfg.max_api_response)?;
        match r.status {
            204 => Ok(Deleted::Done),
            202 => Ok(Deleted::Accepted { location: r.location }),
            s => Err(unexpected(s, &r)),
        }
    }

    /// `POST /service/webhooks` (201). Ein 404 bedeutet: der Dienst unterstützt keine Webhooks.
    pub fn register_webhook(&self, hook: &WebhookPost) -> Result<(), Error> {
        let body = serde_json::to_vec(hook).map_err(|e| Error::Protocol(e.to_string()))?;
        let r = self.call("POST", &format!("{}/service/webhooks", self.base), Some(("application/json", &body)), false, self.cfg.max_api_response)?;
        if r.status == 201 { Ok(()) } else { Err(unexpected(r.status, &r)) }
    }

    // ---- Unterbau -----------------------------------------------------------------------------------------------

    fn call(&self, method: &str, url: &str, body: Option<(&str, &[u8])>, retry: bool, limit: u64) -> Result<Resp, Error> {
        self.call_full(method, url, body, retry, limit, &[])
    }

    fn call_full(&self, method: &str, url: &str, body: Option<(&str, &[u8])>, retry: bool, limit: u64, extra: &[(String, String)]) -> Result<Resp, Error> {
        let attempts = if retry { self.cfg.retry.attempts.max(1) } else { 1 };
        let mut last = None;
        for n in 0..attempts {
            match self.once(method, url, body, limit, extra) {
                Ok(r) if matches!(r.status, 408 | 429 | 500 | 502 | 503 | 504) && n + 1 < attempts => {
                    last = Some(Error::Status { code: r.status, detail: summarise(&r.body) });
                }
                Ok(r) => return Ok(r),
                Err(e) if e.is_retryable() && n + 1 < attempts => last = Some(e),
                Err(e) => return Err(e),
            }
            std::thread::sleep(self.cfg.retry.delay(n));
        }
        Err(last.unwrap_or_else(|| Error::Transport("keine Antwort".into())))
    }

    fn once(&self, method: &str, url: &str, body: Option<(&str, &[u8])>, limit: u64, extra: &[(String, String)]) -> Result<Resp, Error> {
        let same_origin = origin_of(url).as_deref() == Some(self.origin.as_str());
        if origin_of(url).is_none() {
            return Err(Error::Protocol(format!("ungültige Adresse: {}", redact_url(url))));
        }
        if origin_of(url).is_some_and(|o| o.starts_with("http://") && !is_loopback(&o)) {
            return Err(Error::Config("TLS ist Pflicht: Adresse des Dienstes ist http:// (nicht Loopback)".into()));
        }
        let mut full = url.to_string();
        if same_origin && let Some(t) = self.cfg.auth.url_token() && !has_query_param(url, URL_TOKEN_PARAM) {
            full = add_query(url, URL_TOKEN_PARAM, &pct(t));
        }
        let mut b = ureq::http::Request::builder().method(method).uri(full.as_str());
        if same_origin && let Some(h) = self.cfg.auth.header() {
            b = b.header("Authorization", h);
        }
        for (k, v) in extra {
            b = b.header(k.as_str(), v.as_str());
        }
        let resp = match body {
            Some((ct, data)) => {
                let req = b.header("Content-Type", ct).body(data).map_err(|e| Error::Protocol(format!("Anfrage: {e}")))?;
                self.agent.run(req)
            }
            None => {
                let req = b.body(()).map_err(|e| Error::Protocol(format!("Anfrage: {e}")))?;
                self.agent.run(req)
            }
        };
        let mut resp = resp.map_err(|e| Error::Transport(redact_url(&e.to_string())))?;
        let header = |n: &str| resp.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
        let (link, next_key, location) = (header("link"), header("x-paging-nextkey"), header("location"));
        let status = resp.status().as_u16();
        let body = resp
            .body_mut()
            .with_config()
            .limit(limit)
            .read_to_vec()
            .map_err(|e| Error::Transport(redact_url(&e.to_string())))?;
        Ok(Resp { status, link, next_key, location, body })
    }
}

// ---- Hilfen -----------------------------------------------------------------------------------------------------

fn decode<T: serde::de::DeserializeOwned>(r: &Resp) -> Result<T, Error> {
    serde_json::from_slice(&r.body).map_err(|e| Error::Protocol(format!("JSON nicht lesbar: {e}")))
}

fn unexpected(status: u16, r: &Resp) -> Error {
    Error::Status { code: status, detail: summarise(&r.body) }
}

/// Kurzfassung des Fehlerkörpers (`summary` aus dem Fehlerschema, sonst die ersten Zeichen), ohne Token.
fn summarise(body: &[u8]) -> String {
    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(body)
        && let Some(s) = v.get("summary").and_then(|s| s.as_str())
    {
        return redact_url(&s.chars().take(300).collect::<String>());
    }
    redact_url(&String::from_utf8_lossy(&body[..body.len().min(200)]))
}

fn check_id(id: &str) -> Result<(), Error> {
    // Flow-IDs sind UUIDs (Schema `uuid`); wir lassen nur Zeichen zu, die nie einen Pfad verändern.
    if !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        Ok(())
    } else {
        Err(Error::Config(format!("ungültige ID {id:?}")))
    }
}

/// `scheme://authority` (klein geschrieben); `None` bei fremdem Schema oder Benutzerinfo.
pub(crate) fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() || authority.contains('@') || authority.contains(char::is_whitespace) {
        return None;
    }
    Some(format!("{scheme}://{}", authority.to_ascii_lowercase()))
}

fn is_loopback(origin: &str) -> bool {
    let host = origin.split_once("://").map(|(_, a)| a).unwrap_or(origin);
    let host = if let Some(h) = host.strip_prefix('[') { h.split(']').next().unwrap_or("") } else { host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host) };
    host == "localhost" || host == "::1" || host.starts_with("127.")
}

fn has_query_param(url: &str, name: &str) -> bool {
    url.split_once('?').is_some_and(|(_, q)| q.split('&').any(|p| p.split('=').next() == Some(name)))
}

fn add_query(url: &str, name: &str, value: &str) -> String {
    format!("{url}{}{name}={value}", if url.contains('?') { '&' } else { '?' })
}

fn url_without_page(url: &str) -> String {
    match url.split_once('?') {
        None => url.to_string(),
        Some((path, q)) => {
            let kept: Vec<&str> = q.split('&').filter(|p| p.split('=').next() != Some("page")).collect();
            if kept.is_empty() { path.to_string() } else { format!("{path}?{}", kept.join("&")) }
        }
    }
}

fn absolute(origin: &str, url: &str) -> String {
    if url.starts_with('/') { format!("{origin}{url}") } else { url.to_string() }
}

/// Prozent-Kodierung für Query-Werte (alles außer unreservierten Zeichen).
pub(crate) fn pct(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

fn query_string(q: &SegmentQuery) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = &q.timerange {
        parts.push(format!("timerange={}", pct(&t.to_string())));
    }
    if q.reverse_order {
        parts.push("reverse_order=true".into());
    }
    if let Some(l) = &q.accept_get_urls {
        parts.push(format!("accept_get_urls={}", pct(&l.join(","))));
    }
    if let Some(p) = q.presigned {
        parts.push(format!("presigned={p}"));
    }
    if let Some(l) = q.limit {
        parts.push(format!("limit={l}"));
    }
    if q.include_object_timerange {
        parts.push("include_object_timerange=true".into());
    }
    if parts.is_empty() { String::new() } else { format!("?{}", parts.join("&")) }
}

/// `Link: <url>; rel="next"` (auch mehrere, durch Komma getrennt) → Adresse für `rel=next`.
pub(crate) fn parse_link_next(header: &str) -> Option<String> {
    for part in header.split(',') {
        let part = part.trim();
        let (target, params) = part.split_once('>')?;
        let url = target.trim().strip_prefix('<')?;
        let is_next = params.split(';').any(|p| {
            let p = p.trim();
            p.strip_prefix("rel=").is_some_and(|v| v.trim_matches('"').split_whitespace().any(|r| r.eq_ignore_ascii_case("next")))
        });
        if is_next {
            return Some(url.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        assert_eq!(origin_of("https://Host.Example/tams/v8.2").as_deref(), Some("https://host.example"));
        assert_eq!(origin_of("http://127.0.0.1:8080/x?y=1").as_deref(), Some("http://127.0.0.1:8080"));
        assert_eq!(origin_of("ftp://x/"), None);
        assert_eq!(origin_of("https://user:pw@host/"), None);
        assert_eq!(origin_of("/relativ"), None);
        assert_eq!(origin_of("https:///x"), None);
    }

    #[test]
    fn loopback_detection() {
        for o in ["http://localhost:1", "http://127.0.0.1:80", "http://[::1]:9000", "http://127.1.2.3"] {
            assert!(is_loopback(o), "{o}");
        }
        for o in ["http://example.com", "http://10.0.0.1:80", "http://localhost.evil.com", "http://[2001:db8::1]:80"] {
            assert!(!is_loopback(o), "{o}");
        }
    }

    #[test]
    fn tls_is_required_except_loopback() {
        let c = |u: &str| Client::new(ClientConfig::new(u, Auth::None));
        assert!(c("https://tams.example/v8.2").is_ok());
        assert!(c("http://127.0.0.1:4010").is_ok());
        assert!(matches!(c("http://tams.example/v8.2"), Err(Error::Config(_))));
        assert!(matches!(c("tams.example"), Err(Error::Config(_))));
        assert!(matches!(c("https://tams.example/v8.2?access_token=x"), Err(Error::Config(_))));
    }

    #[test]
    fn percent_encoding_of_timeranges() {
        assert_eq!(pct("[0:0_10:0)"), "%5B0%3A0_10%3A0%29");
        let q = SegmentQuery { timerange: Some(TimeRange::parse("[1:0_2:0)").unwrap()), limit: Some(50), ..Default::default() };
        assert_eq!(query_string(&q), "?timerange=%5B1%3A0_2%3A0%29&limit=50");
        let q = SegmentQuery { accept_get_urls: Some(vec![]), ..Default::default() };
        assert_eq!(query_string(&q), "?accept_get_urls=");
        assert_eq!(query_string(&SegmentQuery::default()), "");
    }

    #[test]
    fn link_header_parsing() {
        assert_eq!(parse_link_next("<https://h/a?page=2>; rel=\"next\"").as_deref(), Some("https://h/a?page=2"));
        assert_eq!(parse_link_next("<https://h/p>; rel=\"prev\", <https://h/n>; rel=\"next\"").as_deref(), Some("https://h/n"));
        assert_eq!(parse_link_next("<https://h/p>; rel=\"prev\""), None);
        assert_eq!(parse_link_next("kaputt"), None);
    }

    #[test]
    fn page_helpers() {
        assert_eq!(url_without_page("https://h/s?a=1&page=3&b=2"), "https://h/s?a=1&b=2");
        assert_eq!(url_without_page("https://h/s?page=3"), "https://h/s");
        assert_eq!(add_query("https://h/s", "page", "k"), "https://h/s?page=k");
        assert_eq!(add_query("https://h/s?a=1", "page", "k"), "https://h/s?a=1&page=k");
        assert_eq!(absolute("https://h", "/x?y=1"), "https://h/x?y=1");
    }

    #[test]
    fn ids_cannot_alter_the_path() {
        assert!(check_id("0f3c1a4e-9b1e-4d6f-8a77-0a1b2c3d4e5f").is_ok());
        for bad in ["", "../x", "a/b", "a?b", "a b", "a%2f"] {
            assert!(check_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn retry_delays_double_and_cap() {
        let p = RetryPolicy { attempts: 5, base_delay: Duration::from_millis(100), max_delay: Duration::from_millis(500) };
        assert_eq!(p.delay(0), Duration::from_millis(100));
        assert_eq!(p.delay(1), Duration::from_millis(200));
        assert_eq!(p.delay(2), Duration::from_millis(400));
        assert_eq!(p.delay(3), Duration::from_millis(500));
        assert_eq!(p.delay(30), Duration::from_millis(500));
    }

    #[test]
    fn errors_classify_retryability() {
        assert!(Error::Transport("x".into()).is_retryable());
        assert!(Error::Status { code: 503, detail: String::new() }.is_retryable());
        assert!(Error::Status { code: 429, detail: String::new() }.is_retryable());
        assert!(!Error::Status { code: 400, detail: String::new() }.is_retryable());
        assert!(!Error::Status { code: 403, detail: String::new() }.is_retryable());
        assert!(!Error::Version("x".into()).is_retryable());
    }
}
