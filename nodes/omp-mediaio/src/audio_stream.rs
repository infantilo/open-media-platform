//! MP3-über-HTTP-Audio-Monitoring (Nutzerwunsch 2026-07-29: "wir müssen
//! auch das audio abhören können") — `omp-audio-monitor`s Gegenstück zu
//! [`crate::preview`]s MJPEG-Vorschau, node-agnostisch nach hier
//! ausgelagert nach demselben Muster (kein Wissen über Pipeline-Interna).
//!
//! **MP3 statt Ogg/Opus, bewusst (Framing-Grund, nicht Qualität):** Ogg
//! braucht pro Stream feste BOS/Header-Seiten am Anfang — ein Client, der
//! erst nach Streamstart verbindet, sähe ohne eigenen Header-Replay-
//! Mechanismus nie gültige Daten (klassisches Icecast-Relay-Problem).
//! MP3-Frames sind dagegen einzeln selbstständig decodierbar (kein
//! globaler Header nötig) — genau das Verhalten, das Internet-Radio seit
//! Jahrzehnten nutzt: ein `<audio src="...">` kann an JEDEM Frame
//! einsteigen. Dadurch reicht ein einfacher Byte-Dauerstrom-Broadcaster
//! (kein Multipart-Framing wie bei MJPEG, keine "letztes Bild"-
//! Vorhaltung wie dort — ein neu verbindender Client hört einfach ab
//! jetzt mit, exakt wie bei echtem Internet-Radio).

use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use tiny_http::{Request, Response, Server};

type Chunk = Arc<Vec<u8>>;

struct Client {
    tx: Sender<Chunk>,
}

/// Verteilt MP3-Byte-Chunks vom Pipeline-Thread an beliebig viele HTTP-
/// Clients — kein "letzter Chunk" wie bei [`crate::preview::Broadcaster`],
/// da ein MP3-Frame allein (anders als ein einzelnes JPEG-Vorschaubild)
/// kein sinnvolles Sofortbild für einen frisch verbindenden Client ist.
pub struct Broadcaster {
    clients: Mutex<Vec<Client>>,
}

impl Broadcaster {
    pub fn new() -> Self {
        Broadcaster {
            clients: Mutex::new(Vec::new()),
        }
    }

    /// Vom Pipeline-Thread aufgerufen: verteilt einen neuen MP3-Chunk an
    /// alle verbundenen Clients, entfernt dabei getrennte Clients.
    pub fn publish(&self, mp3: &[u8]) {
        let chunk = Arc::new(mp3.to_vec());
        self.clients
            .lock()
            .expect("lock poisoned")
            .retain(|c| c.tx.send(chunk.clone()).is_ok());
    }

    fn subscribe(&self) -> Receiver<Chunk> {
        let (tx, rx) = channel();
        self.clients.lock().expect("lock poisoned").push(Client { tx });
        rx
    }
}

/// Bindet addr synchron, Accept-Loop auf eigenem Thread — identisches
/// Muster zu [`crate::preview::spawn`] (s. dortige Begründung: eine
/// dauerhaft offene Antwort pro Client darf den Listener nicht blockieren).
pub fn spawn(addr: &str, broadcaster: Arc<Broadcaster>, heartbeat: Arc<AtomicU64>) -> std::io::Result<u16> {
    let server = Server::http(addr).map_err(std::io::Error::other)?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|socket_addr| socket_addr.port())
        .unwrap_or(0);
    std::thread::spawn(move || {
        // S. `omp_mediaio::preview::spawn` — dieselbe Umstellung, gleicher
        // Grund (docs/decisions.md Nachtrag 130-133).
        loop {
            heartbeat.fetch_add(1, Ordering::Relaxed);
            match server.recv_timeout(Duration::from_secs(1)) {
                Ok(Some(request)) => {
                    if request.url() != "/audio-stream" {
                        let _ = request.respond(Response::from_string("not found").with_status_code(404));
                        continue;
                    }
                    let broadcaster = broadcaster.clone();
                    std::thread::spawn(move || serve_client(request, &broadcaster));
                }
                Ok(None) => {}
                Err(e) => {
                    eprintln!("omp-mediaio(audio_stream): accept failed: {e}");
                    break;
                }
            }
        }
    });
    Ok(port)
}

fn serve_client(request: Request, broadcaster: &Broadcaster) {
    let rx = broadcaster.subscribe();
    let mut writer = request.into_writer();

    let header = "HTTP/1.1 200 OK\r\n\
                  Content-Type: audio/mpeg\r\n\
                  Cache-Control: no-cache\r\n\
                  Connection: close\r\n\r\n";
    // Sofort flushen statt auf den ersten Chunk zu warten — derselbe
    // live gefundene Grund wie bei preview.rs::serve_client (ein Node
    // ohne aktuell verbundene Quelle würde den Header sonst nie
    // schreiben, der Browser sähe nicht einmal einen 200-Status).
    if writer.write_all(header.as_bytes()).is_err() || writer.flush().is_err() {
        return;
    }

    while let Ok(chunk) = rx.recv() {
        if writer.write_all(&chunk).is_err() || writer.flush().is_err() {
            break;
        }
    }
}

/// Baut einen `audioconvert ! audioresample ! lamemp3enc ! appsink`-Zweig
/// ab `upstream` und speist jeden encodierten MP3-Chunk in `broadcaster`.
/// `upstream` muss bereits Teil von `pipeline` sein und eine `src`-Pad
/// haben (z. B. `MxlAudioInput::tail` oder ein `tee`).
pub fn build_mp3_branch(
    pipeline: &gst::Pipeline,
    upstream: &gst::Element,
    broadcaster: &Arc<Broadcaster>,
) -> Result<(), String> {
    let queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue (mp3): {e}"))?;
    let audioconvert = gst::ElementFactory::make("audioconvert")
        .build()
        .map_err(|e| format!("audioconvert (mp3): {e}"))?;
    let audioresample = gst::ElementFactory::make("audioresample")
        .build()
        .map_err(|e| format!("audioresample (mp3): {e}"))?;
    // 128 kbit/s: für Abhörzwecke (nicht Archivqualität) ein etablierter
    // Mittelwert, hält Latenz/Bandbreite niedrig.
    let mp3enc = gst::ElementFactory::make("lamemp3enc")
        .property("bitrate", 128i32)
        .build()
        .map_err(|e| format!("lamemp3enc: {e}"))?;
    let appsink = gst::ElementFactory::make("appsink")
        .property("sync", false)
        .property("max-buffers", 8u32)
        .property("drop", false)
        .build()
        .map_err(|e| format!("appsink (mp3): {e}"))?;

    pipeline
        .add(&queue)
        .and_then(|()| pipeline.add(&audioconvert))
        .and_then(|()| pipeline.add(&audioresample))
        .and_then(|()| pipeline.add(&mp3enc))
        .and_then(|()| pipeline.add(&appsink))
        .map_err(|e| format!("add mp3 elements: {e}"))?;

    gst::Element::link_many([upstream, &queue, &audioconvert, &audioresample, &mp3enc, &appsink])
        .map_err(|e| format!("link mp3 branch: {e}"))?;

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
