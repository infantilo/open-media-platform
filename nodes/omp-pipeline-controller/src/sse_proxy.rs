//! Echtes Streaming für PIPELINE CONTROLLERs SSE-Kanal (`/events`) —
//! `proxy.rs`s Haupt-Proxy kann das nicht liefern (dessen `RawResponse`
//! ist gepuffert, dasselbe Problem wie `omp_node_sdk::server`s Single-
//! Thread-Accept-Loop), s. dortige Moduldoku: `/events` beantwortete
//! `proxy()` bislang bewusst mit `501`, damit der EINE Antwort-Thread des
//! Adapters nicht an einem nie endenden `text/event-stream`-Body
//! feststeckt — funktional bedeutete das aber: `ui.html`s `EventSource`
//! bekam nie eine echte Verbindung, der "OFFLINE"-Badge/"Server
//! gestoppt"-Overlay blieb dauerhaft sichtbar (live im Browser via CDP
//! geprüft, nicht nur per API/curl — genau das hatte die letzte Runde
//! übersehen).
//!
//! Fix: ein zweiter, eigener `tiny_http`-Listener (exakt dasselbe Muster
//! wie `omp-mediaio::preview` für die MJPEG-Vorschau von omp-viewer/
//! omp-multiviewer — Thread pro Verbindung statt der gemeinsamen
//! Descriptor-Accept-Loop, damit eine dauerhaft offene Antwort nicht den
//! Rest blockiert), der jede Verbindung zu `{pc_base}/events` real
//! streamt: `ureq`s `BodyReader` (`io::Read`) wird chunkweise gelesen und
//! sofort an den tiny_http-Rohschreiber weitergereicht, statt (wie
//! `proxy()`) auf ein vollständiges `read_to_vec()` zu warten.

use std::io::{Read, Write};

use tiny_http::{Response, Server};

/// Bindet addr synchron (Bind-Fehler sofort sichtbar) und verschiebt die
/// Accept-Loop in einen eigenen Thread — liefert den tatsächlich
/// gebundenen Port zurück (addr-Port `0` → vom OS zugewiesen), den
/// `main.rs` für den neuen `eventsUrl`-Parameter braucht.
pub fn spawn(addr: &str, pc_base: String) -> std::io::Result<u16> {
    let server = Server::http(addr).map_err(std::io::Error::other)?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|socket_addr| socket_addr.port())
        .unwrap_or(0);
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let pc_base = pc_base.clone();
            std::thread::spawn(move || serve_client(request, &pc_base));
        }
    });
    Ok(port)
}

fn serve_client(request: tiny_http::Request, pc_base: &str) {
    let target = format!("{pc_base}/events");
    let agent = ureq::Agent::new_with_defaults();
    let resp = match agent.get(&target).call() {
        Ok(r) => r,
        Err(e) => {
            let _ = request.respond(
                Response::from_string(format!("omp-pipeline-controller: /events upstream failed: {e}"))
                    .with_status_code(502),
            );
            return;
        }
    };

    let mut writer = request.into_writer();
    let header = "HTTP/1.1 200 OK\r\n\
                  Content-Type: text/event-stream\r\n\
                  Cache-Control: no-cache\r\n\
                  Connection: close\r\n\
                  Access-Control-Allow-Origin: *\r\n\r\n";
    if writer.write_all(header.as_bytes()).is_err() || writer.flush().is_err() {
        return;
    }

    // Chunkweise durchreichen statt read_to_vec(): jedes SSE-`data: ...`
    // muss beim Client ankommen, sobald PIPELINE CONTROLLER es schreibt,
    // nicht erst wenn der Stream (der nie) endet.
    let mut reader = resp.into_body().into_reader();
    let mut buf = [0u8; 4096];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        if writer.write_all(&buf[..n]).is_err() || writer.flush().is_err() {
            break;
        }
    }
}
