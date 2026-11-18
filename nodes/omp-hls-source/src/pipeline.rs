//! GStreamer-Pipeline von `omp-hls-source`: HLS-Stream (HTTP Live Streaming, RFC 8216) → MXL-Video- und
//! -Audio-Flow. Eingang `uridecodebin` (wählt für `http(s)://….m3u8` den Adaptiv-Demuxer `hlsdemux2`/`hlsdemux`
//! und den passenden Decoder); die dynamischen Pads laufen je Medienart in eine feste Kette:
//!
//! ```text
//! uridecodebin ─ video ─► queue ─► tee ─┬─► queue ─► MxlVideoOutput (skaliert/konvertiert/ratet auf das Flow-Format)
//!                                       └─► MJPEG-Vorschau
//!              └ audio ─► queue ─► MxlAudioOutput (wandelt auf 48 kHz, Kanäle)
//! ```
//!
//! **Wiederverbinden:** Netzfehler, Server-Ende (EOS) und Stillstand (keine Bilder für `stall_secs`) bauen die
//! GANZE Pipeline mit denselben Flow-IDs neu auf (mit Wartezeit, die sich bis `MAX_BACKOFF` verdoppelt). Die
//! MXL-Flows verschwinden dabei kurz; Leser nehmen sie über das späte Auftauchen wieder auf (wie nach jedem
//! Neustart eines Nodes). Ein Wiederaufbau nur der Quelle bei laufender Senke wurde bewusst nicht gewählt: neue
//! Zeitstempel einer neuen Quelle in einer laufenden Pipeline sind eine bekannte Falle (MXL-Raster, `videorate`).
//!
//! Das Flow-Format (Breite/Höhe/Bildrate) ist Konfiguration (`OMP_WIDTH`/…), nicht der Stream: die NMOS-Sender
//! müssen es vor dem ersten Bild deklarieren. Ein Stream mit anderer Größe/Rate wird skaliert bzw. per `videorate`
//! angepasst. Hat der Stream keinen Ton, liefert ein Stumm-Zweig `audiotestsrc wave=silence` den Audio-Flow (Parameter `hasAudio` = false); ohne ihn hielte die Audio-Senke die Pipeline im Preroll.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};
use omp_mediaio::preview;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

const PREVIEW_WIDTH: u32 = 320;
const PREVIEW_HEIGHT: u32 = 180;
const PREVIEW_FPS: i32 = 5;
const PREVIEW_JPEG_QUALITY: i32 = 70;

pub const DEFAULT_WIDTH: u32 = 1280;
pub const DEFAULT_HEIGHT: u32 = 720;
pub const FRAMERATE_NUMERATOR: u32 = 25;
pub const FRAMERATE_DENOMINATOR: u32 = 1;
pub const SAMPLE_RATE: u32 = 48000;
pub const CHANNELS: u32 = 2;

/// Wartezeit vor dem ersten Wiederverbinden und Obergrenze der Verdopplung.
const MIN_BACKOFF: Duration = Duration::from_secs(2);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Bis zum ersten Bild darf der Aufbau (Playlist laden, Segment holen, Decoder) länger dauern als ein Stillstand
/// mitten im Betrieb.
const FIRST_FRAME_GRACE: Duration = Duration::from_secs(30);

pub struct Config {
    pub domain: String,
    pub flow_id: String,
    pub audio_flow_id: String,
    pub label: String,
    /// `http://…` oder `https://…` (Medienplaylist oder Master-Playlist).
    pub uri: String,
    pub width: u32,
    pub height: u32,
    pub framerate_numerator: u32,
    pub framerate_denominator: u32,
    /// Obergrenze für die Auswahl der Varianten (kbit/s), 0 = keine.
    pub max_bitrate_kbps: u32,
    /// Sekunden ohne neues Bild, nach denen neu verbunden wird (0 = nie).
    pub stall_secs: u64,
    pub preview_broadcaster: Arc<preview::Broadcaster>,
}

pub enum Event {
    Fps(f64),
    Error(String),
}

/// Zähler und Zustand, die Wiederaufbauten überleben (der Node-Rahmen hält Griffe darauf).
#[derive(Clone)]
pub struct Shared {
    /// Bilder seit dem letzten `take_video_fps`.
    pub video_buffers: Arc<AtomicU64>,
    pub video_total: Arc<AtomicU64>,
    /// Sticky: es ist mindestens ein Bild geflossen (media-ready).
    pub video_flowed: Arc<AtomicBool>,
    /// Ob in der aktuellen Verbindung ein Audio-Pad erschien.
    pub audio_seen: Arc<AtomicBool>,
    pub reconnects: Arc<AtomicU64>,
    /// "connecting" | "playing" | "reconnecting" — nur Anzeige.
    pub state: Arc<Mutex<String>>,
    /// Letzte Fehlermeldung (leer = keine) — nur Anzeige.
    pub last_error: Arc<Mutex<String>>,
}

impl Shared {
    pub fn new() -> Self {
        Shared {
            video_buffers: Arc::new(AtomicU64::new(0)),
            video_total: Arc::new(AtomicU64::new(0)),
            video_flowed: Arc::new(AtomicBool::new(false)),
            audio_seen: Arc::new(AtomicBool::new(false)),
            reconnects: Arc::new(AtomicU64::new(0)),
            state: Arc::new(Mutex::new("connecting".to_string())),
            last_error: Arc::new(Mutex::new(String::new())),
        }
    }
    fn set_state(&self, s: &str) {
        *self.state.lock().expect("lock poisoned") = s.to_string();
    }
    fn set_error(&self, s: &str) {
        *self.last_error.lock().expect("lock poisoned") = s.to_string();
    }
}

struct Pipeline {
    pipeline: gst::Pipeline,
    _mxl_output: MxlVideoOutput,
    _mxl_audio_output: MxlAudioOutput,
    _mjpeg_elements: Vec<gst::Element>,
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory)
        .build()
        .map_err(|e| format!("{factory}: {e}"))
}

/// Nur http/https: die URL kommt aus der Konfiguration, aber ein Dateipfad oder ein anderes Schema hätte hier
/// nichts zu suchen (kein Lesen lokaler Dateien über diesen Node).
pub fn validate_uri(uri: &str) -> Result<(), String> {
    let lower = uri.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!(
            "HLS-Adresse muss mit http:// oder https:// beginnen (war: {uri:?})"
        ));
    }
    let rest = &uri[uri.find("://").unwrap_or(0) + 3..];
    if rest.is_empty() || rest.starts_with('/') {
        return Err("HLS-Adresse ohne Servername".to_string());
    }
    Ok(())
}

impl Pipeline {
    fn build(config: &Config, shared: &Shared) -> Result<Self, String> {
        gst::init().map_err(|e| format!("gst init failed: {e}"))?;
        let pipeline = gst::Pipeline::new();
        {
            let diag_pipeline = pipeline.clone();
            omp_node_sdk::diag::register(
                "main",
                Arc::new(move || omp_mediaio::diag::snapshot(&diag_pipeline)),
            );
        }

        let src = make("uridecodebin")?;
        src.set_property("uri", &config.uri);
        // Eingebaute Puffer klein halten: Live-Quelle, Latenz geht vor Glättung langer Netzstaus.
        src.set_property("use-buffering", false);
        let max_bps = u64::from(config.max_bitrate_kbps) * 1000;
        src.downcast_ref::<gst::Bin>()
            .ok_or("uridecodebin ist kein Bin")?
            .connect_deep_element_added(move |_bin, _sub, element| {
                let name = element
                    .factory()
                    .map(|f| f.name().to_string())
                    .unwrap_or_default();
                if (name == "hlsdemux2" || name == "hlsdemux") && max_bps > 0 {
                    element.set_property("max-bitrate", max_bps as u32);
                }
            });

        let video_q = make("queue")?;
        // Takt: HLS liefert segmentweise (alle 2-6 s ein ganzer Block Bilder auf einmal), die MXL-Ausgänge schreiben
        // ohne eigenen Takt (appsink sync=false). Ohne diesen Schritt springt der Flow-Kopf alle Segmentlängen um
        // ein ganzes Segment und steht dazwischen (gemessen 2026-11-18: 0 0 0 0 51 0 0 …). `identity sync=true`
        // gibt jeden Puffer erst zu seiner Zeit weiter; die Latenz entspricht damit einem Segment (HLS-typisch).
        let video_sync = gst::ElementFactory::make("identity")
            .property("sync", true)
            .build()
            .map_err(|e| format!("identity (video): {e}"))?;
        let audio_sync = gst::ElementFactory::make("identity")
            .property("sync", true)
            .build()
            .map_err(|e| format!("identity (audio): {e}"))?;
        let tee = make("tee")?;
        let mxl_queue = make("queue")?;
        let audio_q = make("queue")?;
        pipeline
            .add_many([
                &src,
                &video_q,
                &video_sync,
                &tee,
                &mxl_queue,
                &audio_q,
                &audio_sync,
            ])
            .map_err(|e| format!("add elements: {e}"))?;
        gst::Element::link_many([&video_q, &video_sync, &tee])
            .map_err(|e| format!("link video: {e}"))?;
        gst::Element::link_many([&tee, &mxl_queue]).map_err(|e| format!("link mxl branch: {e}"))?;

        let mjpeg_elements = preview::build_mjpeg_branch(
            &pipeline,
            &tee,
            &config.preview_broadcaster,
            PREVIEW_WIDTH,
            PREVIEW_HEIGHT,
            PREVIEW_FPS,
            PREVIEW_JPEG_QUALITY,
        )?;

        // Bildzähler hinter dem Takt (vor dem Teiler): misst, was der Stream wirklich liefert.
        {
            let counter = shared.video_buffers.clone();
            let total = shared.video_total.clone();
            let flowed = shared.video_flowed.clone();
            let pad = video_sync
                .static_pad("src")
                .ok_or("video identity ohne src-Pad")?;
            pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
                counter.fetch_add(1, Ordering::Relaxed);
                total.fetch_add(1, Ordering::Relaxed);
                flowed.store(true, Ordering::Relaxed);
                gst::PadProbeReturn::Ok
            });
        }

        // Dynamische Pads des Decoders an die festen Ketten hängen; je Medienart nur das erste.
        {
            let video_q = video_q.clone();
            let audio_q = audio_q.clone();
            let audio_seen = shared.audio_seen.clone();
            src.connect_pad_added(move |_el, pad| {
                let Some(caps) = pad.current_caps().or_else(|| Some(pad.query_caps(None))) else {
                    return;
                };
                let Some(name) = caps.structure(0).map(|s| s.name().to_string()) else {
                    return;
                };
                let (target, is_audio) = if name.starts_with("video/") {
                    (video_q.clone(), false)
                } else if name.starts_with("audio/") {
                    (audio_q.clone(), true)
                } else {
                    return;
                };
                let Some(sink) = target.static_pad("sink") else {
                    return;
                };
                if sink.is_linked() {
                    return;
                }
                if pad.link(&sink).is_ok() && is_audio {
                    audio_seen.store(true, Ordering::Relaxed);
                }
            });
        }

        // Hat der Stream keinen Ton (kein Audio-Pad bis "no-more-pads"), speist ein Stumm-Zweig den Audio-Flow:
        // ohne Daten hielte die Audio-Senke die Pipeline im Preroll (nur ein einziges Bild käme durch, gemessen
        // 2026-11-18 mit einem Strom ohne Tonspur) und ein nachgeschalteter Mischer fände keinen gültigen Flow.
        {
            let weak = pipeline.downgrade();
            let audio_q = audio_q.clone();
            let audio_seen = shared.audio_seen.clone();
            src.connect_no_more_pads(move |_el| {
                if audio_seen.load(Ordering::Relaxed) {
                    return;
                }
                let Some(pipeline) = weak.upgrade() else {
                    return;
                };
                let Some(sink) = audio_q.static_pad("sink") else {
                    return;
                };
                if sink.is_linked() {
                    return;
                }
                let Ok(silence) = make("audiotestsrc") else {
                    return;
                };
                silence.set_property("is-live", true);
                silence.set_property_from_str("wave", "silence");
                if pipeline.add(&silence).is_err() {
                    return;
                }
                if let Some(pad) = silence.static_pad("src")
                    && pad.link(&sink).is_ok()
                {
                    let _ = silence.sync_state_with_parent();
                } else {
                    let _ = pipeline.remove(&silence);
                }
            });
        }

        let mxl_context =
            Arc::new(MxlContext::new(&config.domain).map_err(|e| format!("MxlContext::new: {e}"))?);
        let mxl_output = MxlVideoOutput::new(
            &pipeline,
            &mxl_queue,
            mxl_context.clone(),
            &config.flow_id,
            &config.label,
            config.width,
            config.height,
            config.framerate_numerator,
            config.framerate_denominator,
            Arc::new(AtomicU64::new(0)),
        )?;
        mxl_output.set_active(true);
        gst::Element::link_many([&audio_q, &audio_sync]).map_err(|e| format!("link audio: {e}"))?;
        let mxl_audio_output = MxlAudioOutput::new(
            &pipeline,
            &audio_sync,
            mxl_context,
            &config.audio_flow_id,
            &config.label,
            SAMPLE_RATE,
            CHANNELS,
        )?;
        mxl_audio_output.set_active(true);

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("set state playing: {e}"))?;
        Ok(Pipeline {
            pipeline,
            _mxl_output: mxl_output,
            _mxl_audio_output: mxl_audio_output,
            _mjpeg_elements: mjpeg_elements,
        })
    }

    /// Fehler oder Ende des Streams (EOS) innerhalb von `timeout`; `None` = nichts passiert.
    fn poll_problem(&self, timeout: Duration) -> Option<String> {
        let bus = self.pipeline.bus()?;
        let msg = bus.timed_pop_filtered(
            gst::ClockTime::from_mseconds(timeout.as_millis() as u64),
            &[gst::MessageType::Error, gst::MessageType::Eos],
        )?;
        match msg.view() {
            gst::MessageView::Error(err) => Some(format!(
                "{} ({})",
                err.error(),
                err.debug().unwrap_or_default()
            )),
            gst::MessageView::Eos(_) => Some("Stream beendet (EOS)".to_string()),
            _ => None,
        }
    }

    fn shutdown(&self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Wartezeit für den n-ten Wiederholungsversuch in Folge (0-basiert): 2 s, 4 s, 8 s … höchstens 30 s.
pub fn backoff(attempt: u32) -> Duration {
    MIN_BACKOFF
        .saturating_mul(1u32 << attempt.min(8))
        .min(MAX_BACKOFF)
}

/// Ob die Verbindung als hängend gilt: seit `since` kein neues Bild, länger als die Schonfrist.
/// `stall_secs == 0` schaltet die Überwachung ab; vor dem ersten Bild gilt `FIRST_FRAME_GRACE`.
pub fn is_stalled(stall_secs: u64, since_last_frame: Duration, seen_frame: bool) -> bool {
    if stall_secs == 0 {
        return false;
    }
    let limit = if seen_frame {
        Duration::from_secs(stall_secs)
    } else {
        Duration::from_secs(stall_secs).max(FIRST_FRAME_GRACE)
    };
    since_last_frame > limit
}

pub fn run(
    config: Config,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<Shared, String>>,
    heartbeat: Arc<AtomicU64>,
    shared: Shared,
) {
    if let Err(e) = validate_uri(&config.uri) {
        let _ = tx.send(Event::Error(e.clone()));
        let _ = ready.send(Err(e));
        return;
    }
    let mut ready = Some(ready);
    let mut attempt: u32 = 0;
    while !shutdown.load(Ordering::Relaxed) {
        shared.set_state(if attempt == 0 {
            "connecting"
        } else {
            "reconnecting"
        });
        let pipeline = match Pipeline::build(&config, &shared) {
            Ok(p) => p,
            Err(e) => {
                // Ein Aufbaufehler beim allerersten Versuch (kaputte Konfiguration, MXL-Domain) beendet den Node
                // wie bei den anderen Quellen; später (Netz) wird weiter versucht.
                if let Some(r) = ready.take() {
                    let _ = tx.send(Event::Error(e.clone()));
                    let _ = r.send(Err(e));
                    return;
                }
                shared.set_error(&e);
                let _ = tx.send(Event::Error(e));
                if !sleep_interruptible(backoff(attempt), &shutdown, &heartbeat) {
                    break;
                }
                attempt = attempt.saturating_add(1);
                continue;
            }
        };
        if let Some(r) = ready.take() {
            let _ = r.send(Ok(shared.clone()));
        }
        // Der Pfad ist erst "playing", wenn ein Bild kam.
        let mut last_total = shared.video_total.load(Ordering::Relaxed);
        let mut last_change = Instant::now();
        let mut seen_frame = false;
        let mut fps_since = Instant::now();
        let mut problem: Option<String> = None;
        loop {
            heartbeat.fetch_add(1, Ordering::Relaxed);
            if shutdown.load(Ordering::Relaxed) {
                break;
            }
            if let Some(p) = pipeline.poll_problem(Duration::from_secs(1)) {
                problem = Some(p);
                break;
            }
            let total = shared.video_total.load(Ordering::Relaxed);
            if total != last_total {
                last_total = total;
                last_change = Instant::now();
                if !seen_frame {
                    seen_frame = true;
                    shared.set_state("playing");
                    eprintln!("omp-hls-source: erstes Bild nach der Verbindung, Stream läuft");
                    shared.set_error("");
                    attempt = 0; // erst ein echtes Bild zählt als erfolgreiche Verbindung
                }
            } else if is_stalled(config.stall_secs, last_change.elapsed(), seen_frame) {
                problem = Some(format!(
                    "keine Bilder seit {} s",
                    last_change.elapsed().as_secs()
                ));
                break;
            }
            // Bildrate über die tatsächlich vergangene Zeit (die Schleife läuft nicht exakt im Sekundentakt).
            let dt = fps_since.elapsed();
            if dt >= Duration::from_millis(900) {
                let n = shared.video_buffers.swap(0, Ordering::Relaxed) as f64;
                let _ = tx.send(Event::Fps(n / dt.as_secs_f64()));
                fps_since = Instant::now();
            }
        }
        pipeline.shutdown();
        drop(pipeline);
        shared.audio_seen.store(false, Ordering::Relaxed);
        let Some(problem) = problem else { break };
        shared.reconnects.fetch_add(1, Ordering::Relaxed);
        shared.set_error(&problem);
        eprintln!(
            "omp-hls-source: {problem} — verbinde in {} s neu",
            backoff(attempt).as_secs()
        );
        let _ = tx.send(Event::Error(format!("{problem} — verbinde neu")));
        shared.set_state("reconnecting");
        if !sleep_interruptible(backoff(attempt), &shutdown, &heartbeat) {
            break;
        }
        attempt = attempt.saturating_add(1);
    }
}

/// Schläft `d`, tickt dabei den Herzschlag; `false`, wenn währenddessen das Beenden verlangt wurde.
fn sleep_interruptible(d: Duration, shutdown: &AtomicBool, heartbeat: &AtomicU64) -> bool {
    let end = Instant::now() + d;
    while Instant::now() < end {
        if shutdown.load(Ordering::Relaxed) {
            return false;
        }
        heartbeat.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(250));
    }
    !shutdown.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_validation() {
        assert!(validate_uri("https://example.com/live/index.m3u8").is_ok());
        assert!(validate_uri("HTTP://host:8080/a.m3u8").is_ok());
        assert!(validate_uri("file:///etc/passwd").is_err());
        assert!(validate_uri("rtsp://x/y").is_err());
        assert!(validate_uri("/etc/passwd").is_err());
        assert!(validate_uri("http://").is_err());
        assert!(validate_uri("http:///nohost").is_err());
    }

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff(0), Duration::from_secs(2));
        assert_eq!(backoff(1), Duration::from_secs(4));
        assert_eq!(backoff(3), Duration::from_secs(16));
        assert_eq!(backoff(4), Duration::from_secs(30));
        assert_eq!(backoff(100), Duration::from_secs(30));
    }

    #[test]
    fn stall_rules() {
        // aus
        assert!(!is_stalled(0, Duration::from_secs(999), true));
        // mitten im Betrieb: strikt die eingestellte Zeit
        assert!(!is_stalled(10, Duration::from_secs(10), true));
        assert!(is_stalled(10, Duration::from_secs(11), true));
        // vor dem ersten Bild: mindestens die Schonfrist
        assert!(!is_stalled(10, Duration::from_secs(29), false));
        assert!(is_stalled(10, Duration::from_secs(31), false));
        assert!(!is_stalled(60, Duration::from_secs(59), false));
    }
}
