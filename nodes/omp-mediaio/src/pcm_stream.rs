//! Rohes PCM-über-chunked-HTTP-Audio-Monitoring (2026-08-06,
//! `omp-audio-monitor`-Redesign, Nutzerwunsch: "es sollte wie der
//! viewer ohne einen html player auskommen, direkt das audio
//! ausgeben") — Ersatz für [`crate::audio_stream`]s MP3-Variante:
//! `lamemp3enc` fügt Encoder-Lookahead-Latenz hinzu (typisch mehrere
//! hundert ms bei einem Blockcodec), unnötig für reines Abhören, wo
//! niedrige Latenz wichtiger ist als Bandbreite. Rohes F32LE-PCM hat
//! keinen Encoder, nur die unvermeidliche Chunk-/Netzwerk-/Browser-
//! Decode-Latenz.
//!
//! **Fester Ausgabeformat statt Quellformat 1:1:** Quellen (MXL-Sender)
//! haben unterschiedliche Kanalzahlen (Stereo, 5.1 diskret bei
//! `omp-mxf-player`s `surround51`-Gruppe, ...) — rohes PCM hat anders
//! als WAV/Ogg keinen Selbstbeschreibungs-Header, ein Client müsste das
//! Format vorher aus einem Seitenkanal kennen. Einfachster Ausweg: JEDE
//! Quelle wird vor dem Versand über `audioconvert`/`audioresample` auf
//! dasselbe feste Format (F32LE, 48 kHz, Stereo) gebracht — der Client
//! (`AudioWorklet`, s. UI-Bundle) kennt das Format fest, kein
//! Discovery-Overhead. Kanal-Downmix (z. B. 5.1 → Stereo) übernimmt
//! `audioconvert` (Standard-GStreamer-Verhalten, keine Handarbeit).
//!
//! **Chunked HTTP statt WebSocket:** der generische Orchestrator-
//! Stream-Proxy (`orchestrator/internal/httpapi/proxy.go
//! handleNodeStreamProxy`), über den `preview`/`audio-stream`/`levels`
//! bereits laufen (Auth + Host-Kapselung, s. deren Moduldoku), spricht
//! nur HTTP-Request/-Antwort, kein Protokoll-Upgrade — eine WebSocket-
//! Variante hätte eine eigene, hier nicht gerechtfertigte
//! Orchestrator-Änderung gebraucht. Ein normaler, nie endender
//! GET-Antwortstrom (identisches Framing-Muster wie `audio_stream.rs`)
//! erreicht dasselbe Ziel (Browser liest per `fetch()` +
//! `ReadableStream`, s. UI-Bundle) ohne Protokoll-Upgrade.

use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use tiny_http::{Request, Response, Server};

pub const SAMPLE_RATE: u32 = 48000;
pub const CHANNELS: u32 = 2;

type Chunk = Arc<Vec<u8>>;

struct Client {
    tx: Sender<Chunk>,
}

/// Verteilt rohe PCM-Byte-Chunks vom Pipeline-Thread an beliebig viele
/// HTTP-Clients — identisches Muster zu
/// [`crate::audio_stream::Broadcaster`] (kein "letzter Chunk", ein neu
/// verbindender Client hört ab jetzt mit).
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

    pub fn publish(&self, pcm: &[u8]) {
        let chunk = Arc::new(pcm.to_vec());
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
                    if request.url() != "/pcm-stream" {
                        let _ = request.respond(Response::from_string("not found").with_status_code(404));
                        continue;
                    }
                    let broadcaster = broadcaster.clone();
                    std::thread::spawn(move || serve_client(request, &broadcaster));
                }
                Ok(None) => {}
                Err(e) => {
                    eprintln!("omp-mediaio(pcm_stream): accept failed: {e}");
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

    // Roh statt über `tiny_http::Response`/`respond()` geschrieben —
    // identisches Muster zu `audio_stream.rs`/`preview.rs` (ein
    // unendlicher Strom passt nicht in deren Einmal-Antwort-Modell).
    // Format (F32LE/48 kHz/Stereo) bewusst NICHT per Zusatz-Header
    // kommuniziert: der generische Orchestrator-Stream-Proxy
    // (`handleNodeStreamProxy`) reicht ausschließlich `Content-Type`
    // durch (per Quellcode geprüft, `orchestrator/internal/httpapi/
    // proxy.go`), jeder eigene `X-Audio-*`-Header würde also beim
    // Proxy-Hop stillschweigend verschluckt — Client (UI-Bundle) kennt
    // das feste Format stattdessen als eigene Konstante, genau wie hier.
    let header = "HTTP/1.1 200 OK\r\n\
                  Content-Type: application/octet-stream\r\n\
                  Cache-Control: no-cache\r\n\
                  Connection: close\r\n\r\n";
    if writer.write_all(header.as_bytes()).is_err() || writer.flush().is_err() {
        return;
    }

    while let Ok(chunk) = rx.recv() {
        if writer.write_all(&chunk).is_err() || writer.flush().is_err() {
            break;
        }
    }
}

/// Baut einen `audioconvert ! audioresample ! capsfilter(F32LE/48k/
/// stereo) ! appsink`-Zweig ab `upstream` (identisches Grundmuster zu
/// `audio_stream::build_mp3_branch`, ohne den Encoder).
pub fn build_pcm_branch(
    pipeline: &gst::Pipeline,
    upstream: &gst::Element,
    broadcaster: &Arc<Broadcaster>,
) -> Result<(), String> {
    let queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue (pcm): {e}"))?;
    let audioconvert = gst::ElementFactory::make("audioconvert")
        .build()
        .map_err(|e| format!("audioconvert (pcm): {e}"))?;
    let audioresample = gst::ElementFactory::make("audioresample")
        .build()
        .map_err(|e| format!("audioresample (pcm): {e}"))?;
    let caps = gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("rate", SAMPLE_RATE as i32)
        .field("channels", CHANNELS as i32)
        .field("layout", "interleaved")
        .build();
    let capsfilter = gst::ElementFactory::make("capsfilter")
        .property("caps", caps)
        .build()
        .map_err(|e| format!("capsfilter (pcm): {e}"))?;
    let appsink = gst::ElementFactory::make("appsink")
        .property("sync", false)
        .property("max-buffers", 8u32)
        .property("drop", false)
        .build()
        .map_err(|e| format!("appsink (pcm): {e}"))?;

    pipeline
        .add(&queue)
        .and_then(|()| pipeline.add(&audioconvert))
        .and_then(|()| pipeline.add(&audioresample))
        .and_then(|()| pipeline.add(&capsfilter))
        .and_then(|()| pipeline.add(&appsink))
        .map_err(|e| format!("add pcm elements: {e}"))?;

    gst::Element::link_many([upstream, &queue, &audioconvert, &audioresample, &capsfilter, &appsink])
        .map_err(|e| format!("link pcm branch: {e}"))?;

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
