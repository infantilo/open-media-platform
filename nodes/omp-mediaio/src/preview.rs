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

impl Default for Broadcaster {
    fn default() -> Self {
        Self::new()
    }
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
///
/// Liefert die sechs erzeugten Elemente in Verlinkungsreihenfolge zurück
/// (Nutzerauftrag 2026-09-03, `omp-viewer`: FPS zur Laufzeit einstellbar
/// machen) — ruft der Aufrufer das später erneut mit geänderten `fps`
/// auf (z. B. weil ein Operator die Vorschau-Bildrate live ändert),
/// braucht er diese Referenzen, um den ALTEN Zweig sauber abzubauen
/// (`set_state(Null)` + Unlink + `pipeline.remove()`), bevor der neue
/// entsteht — sonst blieben pro FPS-Wechsel verwaiste Elemente in der
/// Pipeline zurück. Bestehende Aufrufer (`omp-multiviewer`,
/// `omp-multiviewer-custom`), die den Zweig nie neu aufbauen, ignorieren
/// den Rückgabewert einfach (`?;` allein, kein `#[must_use]` auf `Vec`).
///
/// **`upstream`-Pad wird BLOCKIERT verlinkt, dann werden die neuen
/// Elemente auf den Elternzustand synchronisiert, erst danach wird
/// entblockt** (Nutzerauftrag: "ändern der framerate bei viewer führt zu
/// freeze"). Root Cause live gefunden, identisch zum bereits
/// dokumentierten Fallstrick in `omp-webrtc-gateway/src/monitor.rs`
/// (docs/decisions.md Nachtrag 250, "Retourbild-Stall"): wird ein neuer
/// Zweig an ein bereits PLAYING `upstream`-Element (typischerweise ein
/// `tee`, s. `omp-viewer::pipeline::rebuild_mjpeg_branch`) verlinkt,
/// BEVOR seine Elemente PLAYING erreicht haben, schiebt `upstream` auf
/// seinem eigenen Streaming-Thread sofort Puffer in die neue Kette. Ein
/// `queue` im Zustand NULL/READY beantwortet den ersten `chain()`-Aufruf
/// mit einem Flow-Fehler statt ihn zu puffern — dieser Fehler läuft bei
/// einem `tee` (anders als bei einem einzelnen Sink) bis in dessen
/// GEMEINSAME Sink-Chain-Funktion zurück und reißt damit ALLE Zweige mit
/// (auch den eigentlichen Ausgabepfad, hier: den Zufluss vom
/// Switcher/`MxlVideoInput`) — die gesamte Pipeline friert bis zu einem
/// vollständigen Neuaufbau (Verbindung trennen/neu herstellen) ein, ohne
/// GStreamer-Fehlermeldung. `upstream` ist bei den bisherigen NICHT-
/// dynamischen Aufrufern (`omp-multiviewer(-custom)`, `omp-scope`, sowie
/// `omp-viewer`s eigener initialer `build()`) noch nicht PLAYING, wenn
/// diese Funktion läuft — der Block/Unblock-Umweg ist dort ein
/// No-Op-Sicherheitsnetz, kein Verhaltensunterschied.
pub fn build_mjpeg_branch(
    pipeline: &gst::Pipeline,
    upstream: &gst::Element,
    broadcaster: &Arc<Broadcaster>,
    width: u32,
    height: u32,
    fps: i32,
    quality: i32,
) -> Result<Vec<gst::Element>, String> {
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

    // `upstream`s freien Src-Pad selbst finden statt `Element::link_many`
    // den kompletten Zweig inkl. `upstream` verlinken zu lassen — nur so
    // lässt sich der Pad VOR dem Verlinken blockieren (s. Funktionsdoku).
    // Statischer Pad zuerst (z. B. `compositor` bei `omp-multiviewer`,
    // genau ein Src-Pad, kein Request-Template), sonst Request-Pad (z. B.
    // `tee` bei `omp-viewer`) — deckt beide bisherigen `upstream`-Arten ab.
    let upstream_pad = upstream
        .static_pad("src")
        .or_else(|| upstream.request_pad_simple("src_%u"))
        .ok_or_else(|| "upstream: no free src pad".to_string())?;
    let block_id = upstream_pad
        .add_probe(
            gst::PadProbeType::BLOCK | gst::PadProbeType::BUFFER | gst::PadProbeType::BUFFER_LIST,
            |_, _| gst::PadProbeReturn::Ok,
        )
        .ok_or("upstream pad block probe")?;

    let queue_sink = queue.static_pad("sink").ok_or("queue: no sink pad")?;
    upstream_pad
        .link(&queue_sink)
        .map_err(|e| format!("link upstream to queue: {e:?}"))?;
    gst::Element::link_many([&queue, &videoscale, &videorate, &caps, &jpegenc, &appsink])
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

    let appsink: gst::Element = app_sink.upcast();
    for el in [&queue, &videoscale, &videorate, &caps, &jpegenc, &appsink] {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync_state_with_parent (mjpeg branch, {}): {e}", el.name()))?;
    }
    // Block ERST JETZT lösen (Puffer dürfen jetzt fließen) — `appsink`
    // braucht einen echten Puffer, um seinen ASYNC READY→PAUSED-Übergang
    // (Preroll) überhaupt abschließen zu können; `pipeline.state()`
    // direkt danach kann sonst gar nichts auflösen (s. u.).
    upstream_pad.remove_probe(block_id);
    // Aggregierten Pipeline-Zustand JETZT auflösen lassen (statt nur den
    // der einzelnen Kinder oben) — root-ursächlich gefundenes Problem
    // (2026-09-24, letzter Teil desselben Freeze-Bugs, live per
    // Instrumentierung bewiesen): `appsink`s READY→PAUSED ist wegen
    // Preroll ASYNC; bleibt dieser Vorgang bei einer SPÄTEREN, schnell
    // aufeinanderfolgenden Zweig-Erstellung noch offen, liefert die
    // `gst::Pipeline` (anders als deren Kinder einzeln) für IHREN eigenen
    // Zielzustand weiterhin PAUSED statt PLAYING — jede künftige
    // `sync_state_with_parent()` einer neuen Kette bekommt dann nie mehr
    // PLAYING, ohne jede Fehlermeldung. `pipeline.state()` (mit Timeout)
    // ist die von GStreamer selbst vorgesehene Synchronisationsstelle
    // dafür (intern über die Eltern-Kind-Zustandsverwaltung des Bins) —
    // MUSS aber NACH dem Entblocken oben stehen, sonst kann `appsink`
    // mangels Puffer nie preroll'en und der Aufruf verstreicht wirkungslos
    // bis zum Timeout (live als Regression gefunden: mit `pipeline.
    // state()` VOR dem Entblocken fror bereits der ALLERERSTE
    // `previewFps`-Wechsel die Vorschau ein, nicht erst der zweite). Live
    // verifiziert (nach der Korrektur): zwei `previewFps`-Wechsel
    // innerhalb von ~300ms (z. B. schnelles Ziehen am Bildrate-Regler)
    // froren die Vorschau trotz der beiden Block-Pad-Probe-Fixes oben
    // dauerhaft ein; mit diesem expliziten Warten (in dieser Reihenfolge)
    // nicht mehr (per `/preview`-MD5 gegen eine echte, sich bewegende
    // Testquelle über mehrere aufeinanderfolgende Wechsel hinweg
    // verifiziert).
    let _ = pipeline.state(gst::ClockTime::from_mseconds(500));

    Ok(vec![queue, videoscale, videorate, caps, jpegenc, appsink])
}
