//! `GET /levels` als Server-Sent-Events-Strom (K4-Teil-1, `docs/END-
//! GOAL-FEATURES.md` §4.3a: "`level`-Element (post-fader) pro Kanal/
//! Gruppe/Master ... → Bus-Messages → node-lokaler SSE-Endpunkt").
//!
//! **Eigener `tiny_http`-Listener statt Erweiterung des generischen
//! Descriptor-Servers** (`omp_node_sdk::server`): dessen eigener
//! Modulkommentar erklärt bewusst "kein Streaming, kein Concurrency-
//! kritischer Pfad" — eine dauerhaft offene SSE-Antwort würde den
//! Single-Thread-Accept-Loop für alle anderen Descriptor-Aufrufe
//! blockieren. Gleiches Muster wie `preview`s MJPEG-Port: eigener Port,
//! Thread-pro-Verbindung, kein `Content-Length` (SSE ist inhärent
//! endlos-strömend).
//!
//! **Nach hier verschoben (2026-08-06):** ursprünglich `omp-audio-
//! mixer`-lokal (dessen eigener Modulkommentar sagte explizit "eine
//! Verschiebung nach `omp-mediaio` folgt erst, wenn ein zweiter Node
//! dasselbe braucht, keine spekulative Abstraktion vorab") — `omp-
//! viewer`s neue dynamische Audio-Eingangs-Pegelanzeigen sind genau
//! dieser zweite Verbraucher, deshalb jetzt hierher gehoben statt
//! dupliziert. Verhalten unverändert, nur der Ort.

use std::io::Write;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

use gstreamer as gst;
use tiny_http::{Request, Response, Server};

type Frame = Arc<String>;

struct Client {
    tx: Sender<Frame>,
}

pub struct Broadcaster {
    clients: Mutex<Vec<Client>>,
}

impl Default for Broadcaster {
    fn default() -> Self {
        Self::new()
    }
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

    // `Access-Control-Allow-Origin: *` nötig (s. omp-audio-mixer-
    // Vorgänger-Fund per CDP-Klicktest: das UI-Bundle läuft im Origin
    // des Orchestrators, `EventSource` erzwingt CORS auch für einfaches
    // Lesen). Kein Auth-relevanter Inhalt hier (nur Pegelwerte).
    let header = "HTTP/1.1 200 OK\r\n\
                  Content-Type: text/event-stream\r\n\
                  Cache-Control: no-cache\r\n\
                  Access-Control-Allow-Origin: *\r\n\
                  Connection: close\r\n\r\n";
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

/// dB → 0..1-Näherung fürs `<omp-meter>`-Kit-Element (0 dBFS = 1.0,
/// alles darunter linear kleiner) — dieselbe Formel wie `db_to_linear`
/// im Audio-Mixer, hier separat benannt, weil sie fachlich etwas
/// anderes ausdrückt (Anzeige-Pegel, nicht Fader-Gain).
pub fn db_to_meter_level(db: f64) -> f64 {
    10f64.powf(db / 20.0).clamp(0.0, 1.0)
}

/// Liest die `rms`/`peak`-Arrays aus einem `level`-Element-Bus-Message
/// und mittelt sie zu einem einzelnen Wert — das Kit-Meter zeigt einen
/// Balken pro Kanalzug, keine getrennte L/R-Anzeige. **Typ ist
/// `glib::ValueArray` (`GValueArray`), nicht `gst::Array`
/// (`GST_TYPE_ARRAY`)** — per Live-Test mit `gst-launch-1.0 -m`
/// verifiziert (`omp-audio-mixer`s ursprüngliche C4.3a-Sitzung, s.
/// docs/decisions.md), nicht angenommen: mit `gst::Array` schlug
/// `structure.get()` still fehl (kein Panic, nur `Err` → `?` → `None`).
pub fn parse_level_message(structure: &gst::StructureRef) -> Option<(f64, f64)> {
    let rms = structure.get::<gst::glib::ValueArray>("rms").ok()?;
    let peak = structure.get::<gst::glib::ValueArray>("peak").ok()?;
    let avg = |arr: &gst::glib::ValueArray| -> f64 {
        let values: Vec<f64> = arr.iter().filter_map(|v| v.get::<f64>().ok()).collect();
        if values.is_empty() {
            f64::NEG_INFINITY
        } else {
            values.iter().sum::<f64>() / values.len() as f64
        }
    };
    Some((db_to_meter_level(avg(&rms)), db_to_meter_level(avg(&peak))))
}
