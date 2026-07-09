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

/// Verbindet einen Node mit dem generischen Descriptor-Proxy des
/// Orchestrators (A8): jeder Node-Autor implementiert nur diesen Trait,
/// keine eigene HTTP-Logik nötig.
pub trait ParamStore: Send + Sync + 'static {
    fn descriptor(&self) -> Descriptor;
    fn get(&self, name: &str) -> Option<Value>;
    fn set(&self, name: &str, value: Value) -> Result<(), SetError>;
    fn invoke(&self, name: &str) -> Result<(), InvokeError>;
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
    let response = route(&mut request, &method, &url, store);
    let _ = request.respond(response);
}

fn route(
    request: &mut Request,
    method: &Method,
    url: &str,
    store: &Arc<dyn ParamStore>,
) -> ResponseBox {
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
            let mut body = String::new();
            if request.as_reader().read_to_string(&mut body).is_err() {
                return error_response(400, "invalid JSON body");
            }
            let parsed: Result<Value, _> = serde_json::from_str(&body);
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
