//! Snapshot-über-HTTP-Vorschau (`UMSETZUNG.md` C6, nach `omp-mediaio`
//! verschoben in C-Nachtrag 2026-07-12 für `omp-multiviewer`-
//! Wiederverwendung) — eigener, zweiter `tiny_http`-Listener auf einem
//! eigenen Thread (z. B. `OMP_VIEWER_PREVIEW_PORT`), unabhängig vom
//! Descriptor-Server (`omp_node_sdk::server`). `GET /preview` liefert das
//! zuletzt über [`Broadcaster::publish`] eingespeiste JPEG-Frame als
//! normale `image/jpeg`-Antwort (ein Bild pro Request, sofort
//! geschlossen); der Client pollt. Node-agnostisch (kein Wissen über
//! Pipeline-Interna) — genutzt von `omp-viewer` (ein Bild) und
//! `omp-multiviewer` (das bereits zum Grid komponierte Gesamtbild).
//!
//! **War ursprünglich `multipart/x-mixed-replace` (PIPELINE CONTROLLERs
//! `lib/PreviewPipeline.js`-Muster, dauerhaft offene Verbindung, Server
//! pusht jedes Frame).** Auf `mxf-player`→Viewer/Multiviewer 2026-08-21
//! per CDP-Test root-caused: aktuelles Chromium (151) rendert
//! `multipart/x-mixed-replace` überhaupt nicht mehr — weder in einem
//! `<img>` noch bei direkter Top-Level-Navigation auf die Stream-URL
//! bleibt es schwarz, ohne `load`/`error`-Event. Kein OMP-Bug, sondern
//! eine inzwischen von Chrome fallengelassene Legacy-Technik. Deshalb auf
//! Einzelbild-Polling umgestellt (s. `ui/graph/flow-canvas.ts`,
//! `nodes/omp-viewer/ui/bundle.js`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use tiny_http::{Header, Response, Server};

type Frame = Arc<Vec<u8>>;

/// Hält das zuletzt vom Pipeline-Thread encodierte JPEG-Frame vor; jeder
/// `GET /preview` liefert genau dieses eine Bild (s. Moduldoku).
pub struct Broadcaster {
    last_frame: Mutex<Option<Frame>>,
}

impl Broadcaster {
    pub fn new() -> Self {
        Broadcaster {
            last_frame: Mutex::new(None),
        }
    }

    /// Vom Pipeline-Thread aufgerufen: hinterlegt das neueste JPEG-Frame.
    pub fn publish(&self, jpeg: &[u8]) {
        *self.last_frame.lock().expect("lock poisoned") = Some(Arc::new(jpeg.to_vec()));
    }

    /// Beim Trennen (`ReceiverControl::apply` ohne aktiven Sender): kein
    /// veraltetes letztes Bild mehr für künftige Requests vorhalten.
    pub fn reset(&self) {
        *self.last_frame.lock().expect("lock poisoned") = None;
    }

    fn snapshot(&self) -> Option<Frame> {
        self.last_frame.lock().expect("lock poisoned").clone()
    }
}

/// Bindet addr synchron (Bind-Fehler sofort sichtbar) und verschiebt die
/// Accept-Loop in einen eigenen Thread. Liefert den tatsächlich
/// gebundenen Port zurück: bei `addr`s Port `0` (`UMSETZUNG.md` C8, für
/// mehrere gleichzeitig vom Instanz-Launcher gestartete Viewer nötig,
/// da sie sich sonst einen festen Preview-Port teilen müssten) weist
/// das OS einen freien Port zu, den `main.rs` für `previewUrl` braucht.
pub fn spawn(addr: &str, broadcaster: Arc<Broadcaster>, heartbeat: Arc<AtomicU64>) -> std::io::Result<u16> {
    let server = Server::http(addr).map_err(std::io::Error::other)?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|socket_addr| socket_addr.port())
        .unwrap_or(0);
    std::thread::spawn(move || {
        // Umgestellt von `server.incoming_requests()` (blockiert
        // unbegrenzt bis zur nächsten Anfrage) auf eine 1s-Poll-
        // Schleife — omp_node_sdk::liveness::LivenessMonitor
        // (docs/decisions.md Nachtrag 130-133) braucht einen Tick auch
        // während einer ruhigen Accept-Loop ohne verbundene Clients;
        // funktional unverändert (`recv_timeout` liefert `Ok(None)` bei
        // Timeout, dieselbe Anfragebehandlung wie zuvor sonst).
        loop {
            heartbeat.fetch_add(1, Ordering::Relaxed);
            match server.recv_timeout(Duration::from_secs(1)) {
                Ok(Some(request)) => {
                    if request.url() != "/preview" {
                        let _ = request.respond(Response::from_string("not found").with_status_code(404));
                        continue;
                    }
                    // Ein Request = ein Snapshot, sofort beantwortet
                    // (kein Push-Thread mehr nötig, s. Moduldoku) —
                    // bleibt trotzdem im eigenen Thread, damit ein
                    // langsamer Client (Netzwerk-Backpressure beim
                    // `respond()`) nicht die Accept-Loop blockiert.
                    let broadcaster = broadcaster.clone();
                    std::thread::spawn(move || {
                        let jpeg_header = Header::from_bytes(&b"Content-Type"[..], &b"image/jpeg"[..])
                            .expect("static header");
                        let no_store =
                            Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).expect("static header");
                        match broadcaster.snapshot() {
                            Some(frame) => {
                                let response = Response::from_data(frame.as_slice())
                                    .with_header(jpeg_header)
                                    .with_header(no_store);
                                let _ = request.respond(response);
                            }
                            None => {
                                let _ = request.respond(
                                    Response::from_string("no frame yet").with_status_code(503),
                                );
                            }
                        }
                    });
                }
                Ok(None) => {}
                Err(e) => {
                    eprintln!("omp-mediaio(preview): accept failed: {e}");
                    break;
                }
            }
        }
    });
    Ok(port)
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
