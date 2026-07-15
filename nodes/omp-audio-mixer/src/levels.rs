//! `GET /levels` als Server-Sent-Events-Strom (K4-Teil-1, `docs/END-
//! GOAL-FEATURES.md` §4.3a: "`level`-Element (post-fader) pro Kanal/
//! Gruppe/Master ... → Bus-Messages → node-lokaler SSE-Endpunkt").
//!
//! **Eigener `tiny_http`-Listener statt Erweiterung des generischen
//! Descriptor-Servers** (`omp_node_sdk::server`): dessen eigener
//! Modulkommentar erklärt bewusst "kein Streaming, kein Concurrency-
//! kritischer Pfad" — eine dauerhaft offene SSE-Antwort würde den
//! Single-Thread-Accept-Loop für alle anderen Descriptor-Aufrufe
//! blockieren. Gleiches Muster wie `omp_mediaio::preview`s MJPEG-Port
//! (C6, von §4.3a selbst als Präzedenzfall genannt): eigener Port,
//! Thread-pro-Verbindung, kein `Content-Length` (SSE ist inhärent
//! endlos-strömend).
//!
//! Bewusst node-lokal statt in `omp-mediaio` verallgemeinert — anders
//! als MJPEG-Preview (von `omp-viewer` UND `omp-multiviewer` genutzt)
//! braucht aktuell nur `omp-audio-mixer` SSE-Metering; eine Verschiebung
//! nach `omp-mediaio` folgt erst, wenn ein zweiter Node dasselbe
//! braucht (keine spekulative Abstraktion vorab).

use std::io::Write;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

use tiny_http::{Request, Response, Server};

type Frame = Arc<String>;

struct Client {
    tx: Sender<Frame>,
}

pub struct Broadcaster {
    clients: Mutex<Vec<Client>>,
}

impl Broadcaster {
    pub fn new() -> Self {
        Broadcaster {
            clients: Mutex::new(Vec::new()),
        }
    }

    /// Veröffentlicht eine JSON-Zeile (ohne Zeilenumbruch) an alle
    /// verbundenen Clients, entfernt dabei getrennte Clients — gleiches
    /// Muster wie `preview::Broadcaster::publish`.
    pub fn publish(&self, json: &str) {
        let frame = Arc::new(json.to_string());
        self.clients
            .lock()
            .expect("lock poisoned")
            .retain(|c| c.tx.send(frame.clone()).is_ok());
    }

    fn subscribe(&self) -> Receiver<Frame> {
        let (tx, rx) = channel();
        self.clients.lock().expect("lock poisoned").push(Client { tx });
        rx
    }
}

pub fn spawn(addr: &str, broadcaster: Arc<Broadcaster>) -> std::io::Result<u16> {
    let server = Server::http(addr).map_err(std::io::Error::other)?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|socket_addr| socket_addr.port())
        .unwrap_or(0);
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            if request.url() != "/levels" {
                let _ = request.respond(Response::from_string("not found").with_status_code(404));
                continue;
            }
            let broadcaster = broadcaster.clone();
            std::thread::spawn(move || serve_client(request, &broadcaster));
        }
    });
    Ok(port)
}

fn serve_client(request: Request, broadcaster: &Broadcaster) {
    let rx = broadcaster.subscribe();
    let mut writer = request.into_writer();

    // `Access-Control-Allow-Origin: *` nötig (anders als `preview.rs`s
    // MJPEG-Port, der nur über `<img src>` eingebunden wird — dafür gilt
    // keine CORS-Prüfung): das UI-Bundle läuft im Origin des
    // Orchestrators (`localhost:8000`), `EventSource` erzwingt CORS auch
    // für einfaches Lesen, ohne Header bricht die Verbindung sofort mit
    // "blocked by CORS policy" ab (per CDP-Klicktest gefunden — der
    // Master-Meter blieb bei 0, obwohl `curl` direkt gegen den Port
    // funktionierte). Kein Auth-relevanter Inhalt hier (nur Pegelwerte),
    // `*` ist unproblematisch, gleiche Abwägung wie bei anderen rein
    // lesenden Metrik-Endpunkten im Projekt.
    let header = "HTTP/1.1 200 OK\r\n\
                  Content-Type: text/event-stream\r\n\
                  Cache-Control: no-cache\r\n\
                  Access-Control-Allow-Origin: *\r\n\
                  Connection: close\r\n\r\n";
    // Explizit flushen, statt auf das erste `write_event()` zu warten:
    // ohne Cache-Frame (anders als bei `preview::Broadcaster`, das immer
    // ein `last_frame` vorhält) blockiert `rx.recv()` unten sonst auf
    // unbestimmte Zeit, bevor der Header den Client je erreicht — ein
    // per Live-Test gefundener Bug (Client sah 0 Bytes, obwohl die
    // Verbindung angenommen wurde).
    if writer.write_all(header.as_bytes()).is_err() || writer.flush().is_err() {
        return;
    }

    while let Ok(frame) = rx.recv() {
        if write_event(&mut writer, &frame).is_err() {
            break;
        }
    }
}

fn write_event(writer: &mut dyn Write, json: &str) -> std::io::Result<()> {
    write!(writer, "data: {json}\n\n")?;
    writer.flush()
}
