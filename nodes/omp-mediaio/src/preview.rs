//! MJPEG-über-HTTP-Vorschau (`UMSETZUNG.md` C6, nach `omp-mediaio`
//! verschoben in C-Nachtrag 2026-07-12 für `omp-multiviewer`-
//! Wiederverwendung) — PIPELINE CONTROLLERs bewährtes Preview-Muster
//! (`lib/PreviewPipeline.js` + `server.js`s `/preview`-Route), hier als
//! eigener, zweiter `tiny_http`-Listener auf einem eigenen Thread (z. B.
//! `OMP_VIEWER_PREVIEW_PORT`), unabhängig vom Descriptor-Server
//! (`omp_node_sdk::server`). `GET /preview` liefert
//! `multipart/x-mixed-replace; boundary=frame`; jedes vom aufrufenden
//! Node über [`Broadcaster::publish`] eingespeiste JPEG-Frame geht an
//! alle verbundenen Clients. Node-agnostisch (kein Wissen über
//! Pipeline-Interna) — genutzt von `omp-viewer` (ein Bild) und
//! `omp-multiviewer` (das bereits zum Grid komponierte Gesamtbild).
//!
//! Ein Thread pro Verbindung, nicht `omp_node_sdk::server`s Single-
//! Thread-Accept-Loop: eine MJPEG-Antwort bleibt dauerhaft offen (kein
//! `Content-Length`, `into_writer()` roh geschrieben) und würde sonst den
//! Listener für alle weiteren Clients blockieren.

use std::io::Write;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
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
/// Accept-Loop in einen eigenen Thread. Liefert den tatsächlich
/// gebundenen Port zurück: bei `addr`s Port `0` (`UMSETZUNG.md` C8, für
/// mehrere gleichzeitig vom Instanz-Launcher gestartete Viewer nötig,
/// da sie sich sonst einen festen Preview-Port teilen müssten) weist
/// das OS einen freien Port zu, den `main.rs` für `previewUrl` braucht.
pub fn spawn(addr: &str, broadcaster: Arc<Broadcaster>) -> std::io::Result<u16> {
    let server = Server::http(addr).map_err(std::io::Error::other)?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|socket_addr| socket_addr.port())
        .unwrap_or(0);
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
    Ok(port)
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

/// Baut einen `videoscale ! videorate ! capsfilter ! jpegenc ! appsink`-
/// Zweig ab `upstream` und speist jedes so encodierte Frame in
/// `broadcaster` — ursprünglich `omp-viewer`s private `build_mjpeg_branch`
/// (`UMSETZUNG.md` C6), hierher verschoben (2026-07-12), damit
/// `omp-multiviewer` (C-Nachtrag) denselben Encode-Pfad auf dem
/// komponierten Grid-Gesamtbild nutzen kann, statt ihn zu duplizieren.
/// `upstream` muss bereits Teil von `pipeline` sein und eine `src`-Pad
/// haben (z. B. ein `tee` oder — beim Multiviewer — ein `compositor`).
pub fn build_mjpeg_branch(
    pipeline: &gst::Pipeline,
    upstream: &gst::Element,
    broadcaster: &Arc<Broadcaster>,
    width: u32,
    height: u32,
    fps: i32,
    quality: i32,
) -> Result<(), String> {
    let queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue (mjpeg): {e}"))?;
    let videoscale = gst::ElementFactory::make("videoscale")
        .build()
        .map_err(|e| format!("videoscale: {e}"))?;
    let videorate = gst::ElementFactory::make("videorate")
        .build()
        .map_err(|e| format!("videorate: {e}"))?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("width", width as i32)
                .field("height", height as i32)
                .field("framerate", gst::Fraction::new(fps, 1))
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter (mjpeg): {e}"))?;
    let jpegenc = gst::ElementFactory::make("jpegenc")
        .property("quality", quality)
        .build()
        .map_err(|e| format!("jpegenc: {e}"))?;
    let appsink = gst::ElementFactory::make("appsink")
        .property("sync", false)
        .property("max-buffers", 2u32)
        .property("drop", true)
        .build()
        .map_err(|e| format!("appsink (mjpeg): {e}"))?;

    pipeline
        .add(&queue)
        .and_then(|()| pipeline.add(&videoscale))
        .and_then(|()| pipeline.add(&videorate))
        .and_then(|()| pipeline.add(&caps))
        .and_then(|()| pipeline.add(&jpegenc))
        .and_then(|()| pipeline.add(&appsink))
        .map_err(|e| format!("add mjpeg elements: {e}"))?;

    gst::Element::link_many([upstream, &queue, &videoscale, &videorate, &caps, &jpegenc, &appsink])
        .map_err(|e| format!("link mjpeg branch: {e}"))?;

    let app_sink: gst_app::AppSink = appsink
        .dynamic_cast()
        .map_err(|_| "appsink: cast to AppSink failed".to_string())?;
    let broadcaster = broadcaster.clone();
    app_sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                if let Some(buffer) = sample.buffer()
                    && let Ok(map) = buffer.map_readable()
                {
                    broadcaster.publish(map.as_slice());
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    Ok(())
}
