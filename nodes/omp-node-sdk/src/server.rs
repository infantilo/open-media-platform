//! Descriptor-Self-Describe-HTTP-API (`GET /descriptor.json`,
//! `GET`/`PATCH /params/<name>`, `POST /methods/<name>`) — Rust-Pendant zu
//! `nodes/mock/internal/descriptor.Handler` (Go), gleiches Wire-Format.
//!
//! `tiny_http` statt eines Async-Frameworks (axum/hyper direkt): das
//! Descriptor-API ist bewusst simpel (vier Routen, kein Streaming, kein
//! Concurrency-kritischer Pfad), ein blockierender Server in einem eigenen
//! Thread reicht — zusätzliche Framework-Tiefe (Router-Makros,
//! Middleware-Stack, Tokio-Runtime-Kopplung nur für diesen Teil) wäre
//! Overhead ohne Gegenwert (Minimal-Dependency-Regel, `docs/decisions.md`).

use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tiny_http::{Header, Method, Request, Response, ResponseBox, Server};

use crate::descriptor::Descriptor;

/// Grund, warum `ParamStore::set` fehlschlug.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetError {
    Unknown,
    ReadOnly,
}

/// Grund, warum `ParamStore::invoke` fehlschlug. `Unknown` bleibt der
/// knappe Default (unbekannte Methode oder ein Node, der keine genauere
/// Ursache mitgeben will/kann) — `Message` ist für Nodes, die bereits
/// eine konkrete, fürs Debugging wertvolle Fehlermeldung selbst gebaut
/// haben (z. B. `omp-playout-automation`s `AutomationStore::invoke`,
/// das jeden `Result<(), String>`-Fehler intern schon über `self.
/// report()` loggt): live gefunden, dass der generische Proxy-Pfad
/// diese Meldung bislang IMMER zur nichtssagenden "unknown method"-
/// 404 abflachte — ein echter 403 (fehlende Workflow-/Rollenbindung
/// des aufrufenden Service-Tokens auf den Ziel-Node) sah dadurch aus
/// wie ein simpler Tippfehler im Methodennamen, kostete beim Debuggen
/// dieses genauen Falls unnötig Zeit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvokeError {
    Unknown,
    Message(String),
}

/// Antwort auf eine node-eigene Zusatzroute (siehe
/// `ParamStore::extra_route`) — transportunabhängig, kein `tiny_http`-Typ
/// in der Trait-Signatur.
pub struct RawResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

/// Eine Anfrage an `ParamStore::extra_route_ext`.
pub struct RouteRequest<'a> {
    pub method: &'a str,
    /// Pfad samt Query.
    pub path: &'a str,
    /// Anfrage-Header (Name klein geschrieben, Wert unverändert).
    pub headers: &'a [(String, String)],
    pub body: &'a [u8],
}

impl RouteRequest<'_> {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// Verbindet einen Node mit dem generischen Descriptor-Proxy des
/// Orchestrators (A8): jeder Node-Autor implementiert nur diesen Trait,
/// keine eigene HTTP-Logik nötig.
pub trait ParamStore: Send + Sync + 'static {
    fn descriptor(&self) -> Descriptor;
    fn get(&self, name: &str) -> Option<Value>;
    fn set(&self, name: &str, value: Value) -> Result<(), SetError>;

    /// `args` ist ein flaches JSON-Objekt Argumentname → Wert (leer, wenn
    /// die Methode keine Argumente hat oder der Aufrufer keinen Body
    /// mitschickt) — genau das Wire-Format, das die Flow-Editor-UI seit
    /// B6 bereits sendet (`ui/graph/flow-canvas.ts#invokeMethod`).
    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError>;

    /// Fallback für Pfade jenseits der vier generischen Routen
    /// (`/descriptor.json`, `/params/<name>`, `/methods/<name>`) — z. B.
    /// eine node-eigene IS-05-Sender-Connection-API + SDP
    /// (`UMSETZUNG.md` C3, `crate::connection`). Default: keine
    /// Zusatzrouten, bestehende Nodes brauchen keine Änderung.
    fn extra_route(&self, _method: &str, _path: &str, _body: &[u8]) -> Option<RawResponse> {
        None
    }

    /// Wie [`ParamStore::extra_route`], aber mit den Anfrage-Headern und mit zusätzlichen Antwort-Headern — für Nodes, die
    /// einen Dienst anbieten (Kapitel 48: Identität und Dienst-Geheimnis kommen als Header, der Audit-Hinweis geht als
    /// Antwort-Header zurück). Default: ruft `extra_route` und fügt keine Header hinzu. Header-Namen sind klein geschrieben.
    fn extra_route_ext(&self, req: &RouteRequest<'_>) -> Option<(RawResponse, Vec<(String, String)>)> {
        self.extra_route(req.method, req.path, req.body).map(|r| (r, Vec::new()))
    }

    /// Erklärt eine Route für öffentlich, also ohne Node-API-Token erreichbar (`crate::nodeauth`). Nur für Routen, die der Node selbst
    /// mit einer eigenen Berechtigung schützt, weil Browser oder Handys sie direkt aufrufen (Einladungs-Token der WebRTC-Seiten).
    /// `path` trägt einen Query-String mit. Default: keine.
    fn public_route(&self, _method: &str, _path: &str) -> bool {
        false
    }

    /// CORS-Preflight (`OPTIONS`) für eine `extra_route`-Zusatzroute —
    /// getrennt von `RawResponse` statt eines neuen Felds darauf
    /// (Nachtrag 197): `RawResponse` wird an ~50 Stellen (v. a.
    /// `uibundle.rs`-Module) als Struct-Literal ohne
    /// `..Default::default()` konstruiert, ein neues Pflichtfeld hätte
    /// dort überall gebrochen, obwohl keine dieser Stellen je CORS-
    /// Preflight braucht. `Some(methods)` liefert die an `path` gültigen
    /// Methoden (ohne `OPTIONS` selbst) für `Access-Control-Allow-
    /// Methods` — `route()` beantwortet dann direkt mit 200 plus den
    /// nötigen CORS-Headern, ohne `extra_route` zu erreichen. Default
    /// `None`: kein Pflichtpunkt, bestehende Nodes brauchen keine
    /// Änderung.
    fn extra_options(&self, _path: &str) -> Option<Vec<&'static str>> {
        None
    }

    /// Optionale Plugin-Host-Erweiterung des Node-Contracts
    /// (`ARCHITECTURE.md` §24.4, `UMSETZUNG.md` C19, `crate::plugins`) —
    /// `Some(&registry)` exponiert automatisch `GET /plugins`/`PATCH
    /// /plugins/<id>` (s. `route` unten). Default `None`: kein
    /// Pflichtpunkt, bestehende Nodes brauchen keine Änderung.
    fn plugins(&self) -> Option<&crate::plugins::PluginRegistry> {
        None
    }
}

/// Startet den Descriptor-HTTP-Server auf addr und blockiert den
/// aufrufenden Thread mit der Accept-Loop.
pub fn serve(addr: &str, store: Arc<dyn ParamStore>) -> std::io::Result<()> {
    let server = Server::http(addr).map_err(|e| std::io::Error::other(e.to_string()))?;
    accept_loop(server, store);
    Ok(())
}

/// Bindet addr synchron (Bind-Fehler sind sofort sichtbar) und verschiebt
/// die Accept-Loop danach in einen eigenen Thread — für `node::run`, das
/// selbst in einer async-Runtime läuft und nicht blockiert werden darf.
/// Liefert zusätzlich den tatsächlich gebundenen Port: bei `addr`s Port
/// `0` (`UMSETZUNG.md` C8, launcherfreundliches Multi-Instanz-Binden)
/// weist das OS einen freien Port zu, den der Aufrufer (`node::start`)
/// zur Registrierung braucht, da er im `addr`-String selbst nicht mehr
/// steht.
pub fn spawn(
    addr: &str,
    store: Arc<dyn ParamStore>,
) -> std::io::Result<(u16, std::thread::JoinHandle<()>)> {
    let server = Server::http(addr).map_err(|e| std::io::Error::other(e.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|socket_addr| socket_addr.port())
        .unwrap_or(0);
    Ok((port, std::thread::spawn(move || accept_loop(server, store))))
}

/// Wie [`spawn`], aber mit TLS (selbst signiertes Zertifikat, s. `https.rs`) — gleiche Routen/Store.
pub fn spawn_tls(
    addr: &str,
    store: Arc<dyn ParamStore>,
    certificate: Vec<u8>,
    private_key: Vec<u8>,
) -> std::io::Result<(u16, std::thread::JoinHandle<()>)> {
    let server = Server::https(addr, tiny_http::SslConfig { certificate, private_key })
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    Ok((port, std::thread::spawn(move || accept_loop(server, store))))
}

/// Größte angenommene Anfrage (Audit 2026-10-23 H8): vorher las der Server jeden Body unbegrenzt in den Speicher.
const MAX_BODY_BYTES: usize = 64 << 20;

/// Höchstzahl gleichzeitig bearbeiteter Anfragen (Audit 2026-10-23 H8): vorher bediente EIN Thread alle nacheinander — ein
/// langsamer oder hängender Client blockierte den ganzen Node-Server. Darüber hinaus: 503 statt unbegrenzt viele Threads.
const MAX_IN_FLIGHT: usize = 64;

static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Gibt beim Verlassen des Anfrage-Threads (auch beim Panic) den Platz in `IN_FLIGHT` frei.
struct InFlightGuard<'a>(&'a AtomicUsize);

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn accept_loop(server: Server, store: Arc<dyn ParamStore>) {
    for request in server.incoming_requests() {
        if IN_FLIGHT.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
            IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
            let _ = request.respond(Response::from_string("too many concurrent requests").with_status_code(503));
            continue;
        }
        let store = Arc::clone(&store);
        let spawned = std::thread::Builder::new().name("omp-http-req".into()).spawn(move || {
            // Der Zähler muss auch bei einem Panic im Handler sinken (Audit H9): sonst blockierte der Node nach 64 Panics alle Anfragen mit 503.
            let _slot = InFlightGuard(&IN_FLIGHT);
            handle(request, &store);
        });
        if spawned.is_err() {
            IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

fn handle(mut request: Request, store: &Arc<dyn ParamStore>) {
    let method = request.method().clone();
    let url = request.url().to_string();

    if request.body_length().is_some_and(|n| n > MAX_BODY_BYTES) {
        let _ = request.respond(Response::from_string("request body too large").with_status_code(413));
        return;
    }
    let mut body = Vec::new();
    let _ = std::io::Read::take(request.as_reader(), MAX_BODY_BYTES as u64 + 1).read_to_end(&mut body);
    if body.len() > MAX_BODY_BYTES {
        let _ = request.respond(Response::from_string("request body too large").with_status_code(413));
        return;
    }

    // Nachtrag 197: `Access-Control-Allow-Origin` fehlte für JEDE
    // Antwort dieses Servers komplett — genau der Bug, den der
    // Go-Mock-Node schon bei D9 hatte (`nodes/mock/main.go withCORS`,
    // live an elf AMWA-Tests gefunden) und der hier nie auffiel, weil
    // IS-05-01 nie gegen einen echten Rust-Node lief. Global an dieser
    // einen Stelle statt pro Response-Konstruktionsstelle (~50 über
    // `RawResponse`-Literale verteilt, s. `uibundle.rs`-Module) —
    // dieselbe "eine Middleware statt viele Handler" Begründung wie bei
    // Go.
    let headers: Vec<(String, String)> =
        request.headers().iter().map(|h| (h.field.as_str().as_str().to_ascii_lowercase(), h.value.as_str().to_string())).collect();
    let response = route_with_headers(&method, &url, &headers, &body, store).with_header(
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).expect("static header"),
    );
    let _ = request.respond(response);
}

#[cfg(test)]
fn route(method: &Method, url: &str, body: &[u8], store: &Arc<dyn ParamStore>) -> ResponseBox {
    route_with_headers(method, url, &[], body, store)
}

fn route_with_headers(method: &Method, url: &str, headers: &[(String, String)], body: &[u8], store: &Arc<dyn ParamStore>) -> ResponseBox {
    // Audit 2026-10-23 B1: mit gesetztem OMP_NODE_API_TOKEN nur Anfragen mit dem Token (s. crate::nodeauth).
    if let Some(denied) = gate(crate::nodeauth::token(), method, url, headers, store) {
        return denied;
    }
    // Zustand der angemeldeten Medien-Pipelines (Support, Kap. 72.7); hinter derselben Zugangsprüfung wie alles andere.
    if *method == Method::Get && url == "/diag/pipelines" {
        return json_response(200, &crate::diag::snapshot());
    }
    if *method == Method::Get && url == "/https-info" {
        return json_response(200, &crate::https::info_json());
    }
    // Instanz umbenennen ohne Neustart (orchestrator: PATCH /api/v1/instances/{id}).
    if *method == Method::Post && url == "/label" {
        let label = serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|v| v.get("label").and_then(|l| l.as_str()).map(|l| l.trim().to_string()))
            .filter(|l| !l.is_empty());
        return match label {
            Some(label) => {
                crate::node::request_relabel(label);
                json_response(202, &serde_json::json!({"ok": true}))
            }
            None => error_response(400, "body must be {\"label\": \"<non-empty>\"}"),
        };
    }

    if *method == Method::Get && url == "/descriptor.json" {
        return json_response(200, &store.descriptor());
    }

    if let Some(name) = url.strip_prefix("/params/") {
        if *method == Method::Get {
            return match store.get(name) {
                Some(value) => json_response(200, &serde_json::json!({"value": value})),
                None => error_response(404, "unknown parameter"),
            };
        }
        if *method == Method::Patch {
            let parsed: Result<Value, _> = serde_json::from_slice(body);
            let value = match parsed {
                Ok(v) => v.get("value").cloned().unwrap_or(Value::Null),
                Err(_) => return error_response(400, "invalid JSON body"),
            };
            return match store.set(name, value.clone()) {
                Ok(()) => json_response(200, &serde_json::json!({"value": value})),
                Err(_) => error_response(404, "unknown or readonly parameter"),
            };
        }
    }

    if *method == Method::Post
        && let Some(name) = url.strip_prefix("/methods/")
    {
        let args = if body.is_empty() {
            serde_json::Map::new()
        } else {
            match serde_json::from_slice::<Value>(body) {
                Ok(Value::Object(map)) => map,
                Ok(_) => return error_response(400, "method body must be a JSON object"),
                Err(_) => return error_response(400, "invalid JSON body"),
            }
        };
        return match store.invoke(name, &args) {
            Ok(()) => json_response(200, &serde_json::json!({"ok": true})),
            Err(InvokeError::Unknown) => error_response(404, "unknown method"),
            Err(InvokeError::Message(msg)) => error_response(400, &msg),
        };
    }

    // C19 (ARCHITECTURE.md §24.4): generischer Plugin-Host, nur aktiv
    // für Nodes, deren ParamStore::plugins() Some liefert — vor
    // extra_route geprüft, damit ein Node nicht zusätzlich selbst
    // /plugins in seinem eigenen extra_route behandeln muss.
    if *method == Method::Get && url == "/plugins" {
        return match store.plugins() {
            Some(registry) => json_response(200, &registry.list()),
            None => error_response(404, "plugins not supported"),
        };
    }
    if *method == Method::Patch
        && let Some(id) = url.strip_prefix("/plugins/")
    {
        let Some(registry) = store.plugins() else {
            return error_response(404, "plugins not supported");
        };
        if registry.get(id).is_none() {
            return error_response(404, "unknown plugin");
        }
        #[derive(serde::Deserialize, Default)]
        struct PluginPatch {
            enabled: Option<bool>,
            config: Option<Value>,
        }
        let patch: PluginPatch = if body.is_empty() {
            PluginPatch::default()
        } else {
            match serde_json::from_slice(body) {
                Ok(p) => p,
                Err(_) => return error_response(400, "invalid JSON body"),
            }
        };
        if let Some(enabled) = patch.enabled {
            registry.set_enabled(id, enabled);
        }
        if let Some(config) = patch.config {
            registry.set_config(id, config);
        }
        return json_response(200, &registry.get(id).expect("checked above"));
    }

    if *method == Method::Options
        && let Some(methods) = store.extra_options(url)
    {
        return Response::from_data(Vec::new())
            .with_status_code(200)
            .with_header(
                Header::from_bytes(
                    &b"Access-Control-Allow-Methods"[..],
                    methods.join(", ").as_bytes(),
                )
                .expect("valid header value"),
            )
            .with_header(
                Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type"[..])
                    .expect("static header"),
            )
            .boxed();
    }

    if let Some((extra, more)) = store.extra_route_ext(&RouteRequest { method: method.as_str(), path: url, headers, body }) {
        let mut resp = Response::from_data(extra.body).with_status_code(extra.status).with_header(
            Header::from_bytes(&b"Content-Type"[..], extra.content_type.as_bytes()).expect("valid content-type header value"),
        );
        for (k, v) in more {
            if let Ok(h) = Header::from_bytes(k.as_bytes(), v.as_bytes()) {
                resp = resp.with_header(h);
            }
        }
        return resp.boxed();
    }

    error_response(404, "not found")
}

/// `Some(401)`, wenn `want` ein Token verlangt und die Anfrage weder es trägt noch offen ist.
fn gate(want: Option<&str>, method: &Method, url: &str, headers: &[(String, String)], store: &Arc<dyn ParamStore>) -> Option<ResponseBox> {
    if crate::nodeauth::authorized(want, headers) || crate::nodeauth::always_open(method.as_str(), url) || store.public_route(method.as_str(), url) {
        return None;
    }
    Some(error_response(401, "node api token required"))
}

fn json_response(status: u16, body: &impl Serialize) -> ResponseBox {
    let data = serde_json::to_vec(body).unwrap_or_default();
    Response::from_data(data)
        .with_status_code(status)
        .with_header(
            Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .expect("static header"),
        )
        .boxed()
}

fn error_response(status: u16, message: &str) -> ResponseBox {
    Response::from_string(message)
        .with_status_code(status)
        .boxed()
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use crate::descriptor::Descriptor;
    use crate::plugins::PluginRegistry;

    use super::*;

    /// Minimaler `ParamStore` nur für die Plugin-Host-Routen (C19,
    /// `ARCHITECTURE.md` §24.4) — kein echter Node nötig, `route()`
    /// braucht nur den Trait, keinen echten `tiny_http::Server`.
    struct FakeStore {
        registry: Option<PluginRegistry>,
    }

    impl ParamStore for FakeStore {
        fn descriptor(&self) -> Descriptor {
            Descriptor {
                parameters: vec![],
                methods: vec![],
                latency: None,
            }
        }
        fn get(&self, _name: &str) -> Option<Value> {
            None
        }
        fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
            Err(SetError::Unknown)
        }
        fn invoke(
            &self,
            _name: &str,
            _args: &serde_json::Map<String, Value>,
        ) -> Result<(), InvokeError> {
            Err(InvokeError::Unknown)
        }
        fn plugins(&self) -> Option<&PluginRegistry> {
            self.registry.as_ref()
        }
    }

    /// Liefert Status + Body als JSON, wo vorhanden — `error_response`
    /// (404/400) liefert bewusst Klartext statt JSON (gleiche
    /// Konvention wie die bestehenden Params-/Methods-Fehlerantworten),
    /// dafür fällt dies auf `Value::Null` zurück statt zu paniken.
    fn body_of(resp: ResponseBox) -> (u16, Value) {
        let status = resp.status_code().0;
        let mut buf = Vec::new();
        resp.into_reader()
            .read_to_end(&mut buf)
            .expect("read response body");
        let value = serde_json::from_slice(&buf).unwrap_or(Value::Null);
        (status, value)
    }

    fn store_without_plugins() -> Arc<dyn ParamStore> {
        Arc::new(FakeStore { registry: None })
    }

    fn store_with_plugins() -> Arc<dyn ParamStore> {
        let registry = PluginRegistry::new();
        registry.register("scte35", "SCTE-35", serde_json::json!({"pid": 500}));
        Arc::new(FakeStore {
            registry: Some(registry),
        })
    }

    fn tok(v: &str) -> Vec<(String, String)> {
        vec![(crate::nodeauth::HEADER.to_string(), v.to_string())]
    }

    #[test]
    fn gate_blocks_without_token_and_passes_with_it() {
        let store = store_without_plugins();
        let denied = |m: Method, url: &str, h: &[(String, String)]| gate(Some("secret"), &m, url, h, &store).map(|r| r.status_code().0);
        assert_eq!(denied(Method::Patch, "/params/x", &[]), Some(401));
        assert_eq!(denied(Method::Post, "/methods/x", &tok("wrong")), Some(401));
        assert_eq!(denied(Method::Get, "/descriptor.json", &[]), Some(401));
        assert_eq!(denied(Method::Post, "/label", &[]), Some(401));
        assert_eq!(denied(Method::Post, "/methods/x", &tok("secret")), None);
        assert_eq!(denied(Method::Options, "/params/x", &[]), None);
        assert_eq!(denied(Method::Get, "/https-info", &[]), None);
        assert_eq!(denied(Method::Get, "/x-nmos/node/v1.3/self", &[]), None);
        assert_eq!(denied(Method::Patch, "/x-nmos/connection/v1.1/single/receivers/r/staged", &[]), Some(401));
    }

    #[test]
    fn in_flight_slot_is_released_even_when_the_handler_panics() {
        // Eigener Zähler: der globale wird von parallel laufenden Tests mitbenutzt.
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        COUNTER.fetch_add(1, Ordering::SeqCst);
        let r = std::thread::spawn(|| {
            let _slot = InFlightGuard(&COUNTER);
            panic!("Handler abgestürzt");
        })
        .join();
        assert!(r.is_err());
        assert_eq!(COUNTER.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn gate_is_off_without_a_configured_token() {
        let store = store_without_plugins();
        assert!(gate(None, &Method::Patch, "/params/x", &[], &store).is_none());
    }

    #[test]
    fn get_plugins_without_support_is_404() {
        let store = store_without_plugins();
        let (status, _) = body_of(route(&Method::Get, "/plugins", &[], &store));
        assert_eq!(status, 404);
    }

    #[test]
    fn get_plugins_lists_registered_plugins() {
        let store = store_with_plugins();
        let (status, body) = body_of(route(&Method::Get, "/plugins", &[], &store));
        assert_eq!(status, 200);
        let list = body.as_array().expect("array body");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], "scte35");
        assert_eq!(list[0]["enabled"], false);
    }

    #[test]
    fn patch_plugin_enables_and_updates_config() {
        let store = store_with_plugins();
        let body = br#"{"enabled":true,"config":{"pid":700}}"#;
        let (status, resp) = body_of(route(&Method::Patch, "/plugins/scte35", body, &store));
        assert_eq!(status, 200);
        assert_eq!(resp["enabled"], true);
        assert_eq!(resp["config"]["pid"], 700);
    }

    #[test]
    fn patch_plugin_partial_body_only_touches_given_fields() {
        let store = store_with_plugins();
        let (_, first) = body_of(route(
            &Method::Patch,
            "/plugins/scte35",
            br#"{"enabled":true}"#,
            &store,
        ));
        assert_eq!(first["enabled"], true);
        assert_eq!(
            first["config"]["pid"], 500,
            "config untouched by an enabled-only PATCH"
        );
    }

    #[test]
    fn patch_unknown_plugin_is_404() {
        let store = store_with_plugins();
        let (status, _) = body_of(route(
            &Method::Patch,
            "/plugins/does-not-exist",
            b"{}",
            &store,
        ));
        assert_eq!(status, 404);
    }

    #[test]
    fn patch_plugins_without_support_is_404() {
        let store = store_without_plugins();
        let (status, _) = body_of(route(&Method::Patch, "/plugins/anything", b"{}", &store));
        assert_eq!(status, 404);
    }

    #[test]
    fn patch_plugin_invalid_json_is_400() {
        let store = store_with_plugins();
        let (status, _) = body_of(route(
            &Method::Patch,
            "/plugins/scte35",
            b"not json",
            &store,
        ));
        assert_eq!(status, 400);
    }

    fn http_get(port: u16) -> String {
        use std::io::{Read, Write};
        let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        c.write_all(b"GET /descriptor.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = c.read_to_string(&mut out);
        out
    }

    // Audit 2026-10-23 H8: ein Client, der seinen Body nie fertig sendet, darf andere Anfragen nicht blockieren.
    #[test]
    fn slow_client_does_not_block_other_requests() {
        use std::io::Write;
        let (port, _h) = spawn("127.0.0.1:0", Arc::new(FakeStore { registry: None })).unwrap();
        let mut slow = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        slow.write_all(b"POST /params/x HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\npartial").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let started = std::time::Instant::now();
        let reply = http_get(port);
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(started.elapsed() < std::time::Duration::from_secs(3), "wurde vom langsamen Client aufgehalten");
        drop(slow);
    }

    #[test]
    fn oversized_body_is_rejected_with_413() {
        use std::io::{Read, Write};
        let (port, _h) = spawn("127.0.0.1:0", Arc::new(FakeStore { registry: None })).unwrap();
        let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let declared = MAX_BODY_BYTES + 1;
        c.write_all(format!("POST /methods/x HTTP/1.1\r\nHost: x\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
        let mut out = String::new();
        let _ = c.read_to_string(&mut out);
        assert!(out.starts_with("HTTP/1.1 413"), "{out}");
    }
}
