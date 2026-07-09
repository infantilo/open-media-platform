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

/// Grund, warum `ParamStore::invoke` fehlschlug.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvokeError {
    Unknown,
}

/// Antwort auf eine node-eigene Zusatzroute (siehe
/// `ParamStore::extra_route`) — transportunabhängig, kein `tiny_http`-Typ
/// in der Trait-Signatur.
pub struct RawResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

/// Verbindet einen Node mit dem generischen Descriptor-Proxy des
/// Orchestrators (A8): jeder Node-Autor implementiert nur diesen Trait,
/// keine eigene HTTP-Logik nötig.
pub trait ParamStore: Send + Sync + 'static {
    fn descriptor(&self) -> Descriptor;
    fn get(&self, name: &str) -> Option<Value>;
    fn set(&self, name: &str, value: Value) -> Result<(), SetError>;
    fn invoke(&self, name: &str) -> Result<(), InvokeError>;

    /// Fallback für Pfade jenseits der vier generischen Routen
    /// (`/descriptor.json`, `/params/<name>`, `/methods/<name>`) — z. B.
    /// eine node-eigene IS-05-Sender-Connection-API + SDP
    /// (`UMSETZUNG.md` C3, `crate::connection`). Default: keine
    /// Zusatzrouten, bestehende Nodes brauchen keine Änderung.
    fn extra_route(&self, _method: &str, _path: &str, _body: &[u8]) -> Option<RawResponse> {
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
pub fn spawn(
    addr: &str,
    store: Arc<dyn ParamStore>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    let server = Server::http(addr).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(std::thread::spawn(move || accept_loop(server, store)))
}

fn accept_loop(server: Server, store: Arc<dyn ParamStore>) {
    for request in server.incoming_requests() {
        handle(request, &store);
    }
}

fn handle(mut request: Request, store: &Arc<dyn ParamStore>) {
    let method = request.method().clone();
    let url = request.url().to_string();

    let mut body = Vec::new();
    let _ = request.as_reader().read_to_end(&mut body);

    let response = route(&method, &url, &body, store);
    let _ = request.respond(response);
}

fn route(method: &Method, url: &str, body: &[u8], store: &Arc<dyn ParamStore>) -> ResponseBox {
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
        return match store.invoke(name) {
            Ok(()) => json_response(200, &serde_json::json!({"ok": true})),
            Err(_) => error_response(404, "unknown method"),
        };
    }

    if let Some(extra) = store.extra_route(method.as_str(), url, body) {
        return Response::from_data(extra.body)
            .with_status_code(extra.status)
            .with_header(
                Header::from_bytes(&b"Content-Type"[..], extra.content_type.as_bytes())
                    .expect("valid content-type header value"),
            )
            .boxed();
    }

    error_response(404, "not found")
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
