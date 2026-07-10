//! MJPEG-über-HTTP-Vorschau (`UMSETZUNG.md` C6) — PIPELINE CONTROLLERs
//! bewährtes Preview-Muster (`lib/PreviewPipeline.js` + `server.js`s
//! `/preview`-Route), hier als eigener, zweiter `tiny_http`-Listener auf
//! einem eigenen Thread (`OMP_VIEWER_PREVIEW_PORT`), unabhängig vom
//! Descriptor-Server (`omp_node_sdk::server`, `main.rs`). `GET /preview`
//! liefert `multipart/x-mixed-replace; boundary=frame`; jedes vom
//! Pipeline-Thread (`pipeline.rs`s appsink-Callback) über
//! [`Broadcaster::publish`] eingespeiste JPEG-Frame geht an alle
//! verbundenen Clients.
//!
//! Ein Thread pro Verbindung, nicht `omp_node_sdk::server`s Single-
//! Thread-Accept-Loop: eine MJPEG-Antwort bleibt dauerhaft offen (kein
//! `Content-Length`, `into_writer()` roh geschrieben) und würde sonst den
//! Listener für alle weiteren Clients blockieren.

use std::io::Write;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

use tiny_http::{Request, Response, Server};

type Frame = Arc<Vec<u8>>;

struct Client {
    tx: Sender<Frame>,
}

/// Verteilt JPEG-Frames vom Pipeline-Thread an beliebig viele
/// MJPEG-HTTP-Clients. Hält zusätzlich das zuletzt gesendete Frame vor,
/// damit ein neu verbindender Client sofort ein Bild sieht statt auf das
/// nächste zu warten (analog `PreviewPipeline.addClient`).
pub struct Broadcaster {
    clients: Mutex<Vec<Client>>,
    last_frame: Mutex<Option<Frame>>,
}

impl Broadcaster {
    pub fn new() -> Self {
        Broadcaster {
            clients: Mutex::new(Vec::new()),
            last_frame: Mutex::new(None),
        }
    }

    /// Vom Pipeline-Thread aufgerufen: verteilt ein neues JPEG-Frame an
    /// alle verbundenen Clients, entfernt dabei getrennte Clients.
    pub fn publish(&self, jpeg: &[u8]) {
        let frame = Arc::new(jpeg.to_vec());
        *self.last_frame.lock().expect("lock poisoned") = Some(frame.clone());
        self.clients
            .lock()
            .expect("lock poisoned")
            .retain(|c| c.tx.send(frame.clone()).is_ok());
    }

    /// Beim Trennen (`ReceiverControl::apply` ohne aktiven Sender): kein
    /// veraltetes letztes Bild mehr für künftige Clients vorhalten.
    pub fn reset(&self) {
        *self.last_frame.lock().expect("lock poisoned") = None;
    }

    fn subscribe(&self) -> (Receiver<Frame>, Option<Frame>) {
        let (tx, rx) = channel();
        let last = self.last_frame.lock().expect("lock poisoned").clone();
        self.clients
            .lock()
            .expect("lock poisoned")
            .push(Client { tx });
        (rx, last)
    }
}

/// Bindet addr synchron (Bind-Fehler sofort sichtbar) und verschiebt die
/// Accept-Loop in einen eigenen Thread.
pub fn spawn(addr: &str, broadcaster: Arc<Broadcaster>) -> std::io::Result<()> {
    let server = Server::http(addr).map_err(std::io::Error::other)?;
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            if request.url() != "/preview" {
                let _ = request.respond(Response::from_string("not found").with_status_code(404));
                continue;
            }
            let broadcaster = broadcaster.clone();
            std::thread::spawn(move || serve_client(request, &broadcaster));
        }
    });
    Ok(())
}

fn serve_client(request: Request, broadcaster: &Broadcaster) {
    let (rx, last) = broadcaster.subscribe();
    let mut writer = request.into_writer();

    let header = "HTTP/1.1 200 OK\r\n\
                  Content-Type: multipart/x-mixed-replace; boundary=frame\r\n\
                  Cache-Control: no-cache\r\n\
                  Connection: close\r\n\r\n";
    if writer.write_all(header.as_bytes()).is_err() {
        return;
    }

    if let Some(frame) = last
        && write_frame(&mut writer, &frame).is_err()
    {
        return;
    }

    while let Ok(frame) = rx.recv() {
        if write_frame(&mut writer, &frame).is_err() {
            break;
        }
    }
}

fn write_frame(writer: &mut dyn Write, jpeg: &[u8]) -> std::io::Result<()> {
    write!(
        writer,
        "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
        jpeg.len()
    )?;
    writer.write_all(jpeg)?;
    writer.write_all(b"\r\n")?;
    writer.flush()
}
