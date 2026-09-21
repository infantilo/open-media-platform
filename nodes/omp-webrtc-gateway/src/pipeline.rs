//! WebRTC-Ingest (Smartphone-Kamera → MXL), Nachtrag 240/241.
//!
//! Aufbau: EINE dauerhafte Pipeline mit den MXL-Ausgängen (Video + Audio)
//! und je einem `identity` als festem Andockpunkt davor. Jede WHIP-Sitzung
//! fügt ihr eigenes `webrtcbin` samt Depayloader/Decoder zur laufenden
//! Pipeline hinzu und entfernt es beim Beenden wieder — die MXL-Flows
//! bleiben dabei bestehen (kein Flow-Neuaufbau bei jedem Handy-Reconnect;
//! Mixer/Viewer, die den Flow schon kennen, sehen nur eine Pause).
//!
//! Codec: Video H.264 (Handys kodieren hardwarebeschleunigt), Audio Opus.
//! Die WHIP-Signalisierung (POST SDP-Offer → SDP-Answer) ist selbst
//! gebaut, weil die gst-plugins-rs-Elemente (`whipserversrc`) hier nicht
//! installiert sind. Nicht-Trickle: die Antwort enthält alle lokalen
//! ICE-Kandidaten (im LAN nach Millisekunden fertig).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer_sdp as gst_sdp;
use gstreamer_video as gst_video;
use gstreamer_video::prelude::*;
use gstreamer_webrtc as gst_webrtc;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;

pub enum Event {
    Error(String),
}

pub struct Config {
    pub domain: String,
    pub flow_id: String,
    pub audio_flow_id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub sample_rate: u32,
    pub channels: u32,
    /// webrtcbin-Jitterbuffer in ms — der eigentliche Latenz-Regler
    /// (Default von webrtcbin: 200 ms, für LAN zu viel).
    pub latency_ms: u32,
}

// ---------------------------------------------------------------------
// Latenzmessung (Schritt 2): Zeitstempel-Streifen im Bild
// ---------------------------------------------------------------------

/// Anzahl Zellen des Zeitstempel-Streifens: 1 Marker (immer hell) + 44 Bit
/// Server-Epoch-Millisekunden + 4 Bit Prüfsumme (Summe der 11 Nibbles
/// mod 16). Die Sendeseite (`camera.html`) zeichnet den Streifen über die
/// volle Bildbreite in die oberste 1/40 der Bildhöhe; weil er relativ zur
/// Bildgröße gezeichnet wird, übersteht er eine vom Browser verkleinerte
/// Auflösung.
const STRIP_CELLS: usize = 49;
const STRIP_HEIGHT_DIVISOR: usize = 40;

/// Liest den Zeitstempel-Streifen aus der Luma-Ebene eines Bildes. `None`,
/// wenn Marker oder Prüfsumme nicht stimmen (kein Streifen im Bild oder
/// von der Kompression zerstört).
fn decode_timestamp_strip(luma: &[u8], stride: usize, width: usize, height: usize) -> Option<u64> {
    if width < STRIP_CELLS * 2 || height < STRIP_HEIGHT_DIVISOR {
        return None;
    }
    let y0 = (height / STRIP_HEIGHT_DIVISOR / 2).max(1);
    let cell_w = width as f64 / STRIP_CELLS as f64;
    let half = ((cell_w / 4.0) as usize).max(1);
    let mut bits = [false; STRIP_CELLS];
    for (i, bit) in bits.iter_mut().enumerate() {
        let cx = ((i as f64 + 0.5) * cell_w) as usize;
        let (mut sum, mut n) = (0u32, 0u32);
        for y in y0.saturating_sub(1)..=(y0 + 1).min(height - 1) {
            for x in cx.saturating_sub(half)..=(cx + half).min(width - 1) {
                sum += u32::from(*luma.get(y * stride + x)?);
                n += 1;
            }
        }
        // Schwelle mittig zwischen Schwarz (16) und Weiß (235), Limited Range.
        *bit = sum / n.max(1) > 126;
    }
    if !bits[0] {
        return None;
    }
    let ts = bits[1..45]
        .iter()
        .fold(0u64, |acc, b| (acc << 1) | u64::from(*b));
    let chk = bits[45..49]
        .iter()
        .fold(0u64, |acc, b| (acc << 1) | u64::from(*b));
    let nibble_sum: u64 = (0..11).map(|k| (ts >> (4 * k)) & 0xf).sum();
    (nibble_sum % 16 == chk).then_some(ts)
}

const LATENCY_WINDOW: usize = 50;
/// Ohne neue Messung länger als so lange → Wert gilt als veraltet (`null`).
const LATENCY_STALE: Duration = Duration::from_secs(3);

/// Gleitendes Fenster der zuletzt gemessenen Glas-zu-Glas-Latenzen (ms).
#[derive(Default)]
pub struct LatencyStats {
    inner: Mutex<LatencyInner>,
}

#[derive(Default)]
struct LatencyInner {
    window: VecDeque<f64>,
    last_at: Option<Instant>,
}

impl LatencyStats {
    fn record(&self, ms: f64) {
        let mut g = self.inner.lock().expect("lock poisoned");
        if g.window.len() == LATENCY_WINDOW {
            g.window.pop_front();
        }
        g.window.push_back(ms);
        g.last_at = Some(Instant::now());
    }

    /// (Mittel, Letzter, Maximum) über das Fenster; `None`, wenn keine
    /// frische Messung vorliegt.
    pub fn snapshot(&self) -> Option<(f64, f64, f64)> {
        let g = self.inner.lock().expect("lock poisoned");
        if g.last_at?.elapsed() > LATENCY_STALE || g.window.is_empty() {
            return None;
        }
        let avg = g.window.iter().sum::<f64>() / g.window.len() as f64;
        let max = g.window.iter().cloned().fold(f64::MIN, f64::max);
        Some((avg, *g.window.back()?, max))
    }
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Server-Uhrzeit für die Uhrenabgleich-Route der Sendeseite.
pub fn server_epoch_ms() -> u64 {
    now_epoch_ms()
}

fn install_latency_probe(decoder_src: &gst::Pad, stats: Arc<LatencyStats>) {
    decoder_src.add_probe(gst::PadProbeType::BUFFER, move |pad, info| {
        let Some(buffer) = info.buffer() else {
            return gst::PadProbeReturn::Ok;
        };
        let Some(caps) = pad.current_caps() else {
            return gst::PadProbeReturn::Ok;
        };
        let Ok(vinfo) = gst_video::VideoInfo::from_caps(&caps) else {
            return gst::PadProbeReturn::Ok;
        };
        if let Ok(frame) = gst_video::VideoFrameRef::from_buffer_ref_readable(buffer, &vinfo)
            && let Ok(luma) = frame.plane_data(0)
            && let Some(ts) = decode_timestamp_strip(
                luma,
                frame.plane_stride()[0] as usize,
                vinfo.width() as usize,
                vinfo.height() as usize,
            )
        {
            let lat = now_epoch_ms() as f64 - ts as f64;
            if lat.abs() < 60_000.0 {
                stats.record(lat);
            }
        }
        gst::PadProbeReturn::Ok
    });
}

/// Ein laufender WHIP-Peer: sein `webrtcbin` plus alle für ihn zur
/// Pipeline hinzugefügten Elemente (zum sauberen Entfernen).
struct Session {
    webrtcbin: gst::Element,
    elements: Arc<Mutex<Vec<gst::Element>>>,
}

pub struct Gateway {
    pipeline: gst::Pipeline,
    video_tail: gst::Element,
    audio_tail: gst::Element,
    _video_out: MxlVideoOutput,
    _audio_out: MxlAudioOutput,
    session: Mutex<Option<Session>>,
    connection_state: Arc<Mutex<String>>,
    latency_ms: u32,
    pub heartbeat: Arc<AtomicU64>,
    shutdown: Arc<AtomicBool>,
    latency: Arc<LatencyStats>,
}

impl Gateway {
    pub fn new(config: Config, tx: UnboundedSender<Event>) -> Result<Arc<Self>, String> {
        gst::init().map_err(|e| format!("gst init failed: {e}"))?;
        let context = Arc::new(MxlContext::new(&config.domain)?);
        let pipeline = gst::Pipeline::new();

        let make = |name: &str| {
            gst::ElementFactory::make(name)
                .build()
                .map_err(|e| format!("{name}: {e}"))
        };
        let video_tail = make("identity")?;
        let audio_tail = make("identity")?;
        pipeline
            .add_many([&video_tail, &audio_tail])
            .map_err(|e| format!("pipeline add: {e}"))?;

        let video_out = MxlVideoOutput::new(
            &pipeline,
            &video_tail,
            context.clone(),
            &config.flow_id,
            &config.label,
            config.width,
            config.height,
            config.fps_num,
            config.fps_den,
            Arc::new(AtomicU64::new(0)),
        )?;
        video_out.set_active(true);
        let audio_out = MxlAudioOutput::new(
            &pipeline,
            &audio_tail,
            context,
            &config.audio_flow_id,
            &format!("{} Audio", config.label),
            config.sample_rate,
            config.channels,
        )?;
        audio_out.set_active(true);

        // Ohne eingehende Daten prerollen die MXL-Appsinks nie (der
        // Audio-Appsink in omp-mediaio ist bewusst `async`) — die Pipeline
        // bliebe bei einem ASYNC-Zustandswechsel in READY hängen, bekäme
        // keine Clock, und der webrtcbin-Jitterbuffer gäbe nie ein Bild
        // aus (live gefunden, Nachtrag 241). Deshalb hier (nicht in der
        // gemeinsamen Bibliothek) alle Appsinks auf `async=false`.
        for el in pipeline.iterate_elements().into_iter().flatten() {
            if el.factory().is_some_and(|f| f.name() == "appsink") {
                el.set_property("async", false);
            }
        }
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("set state playing: {e}"))?;

        let shutdown = Arc::new(AtomicBool::new(false));
        let heartbeat = Arc::new(AtomicU64::new(0));

        // Bus-Wächter ohne GLib-MainLoop: meldet Pipeline-Fehler und tickt
        // den Liveness-Heartbeat.
        let bus = pipeline.bus().ok_or("pipeline has no bus")?;
        {
            let shutdown = shutdown.clone();
            let heartbeat = heartbeat.clone();
            std::thread::spawn(move || {
                while !shutdown.load(Ordering::Relaxed) {
                    heartbeat.fetch_add(1, Ordering::Relaxed);
                    if let Some(msg) = bus.timed_pop_filtered(
                        gst::ClockTime::from_mseconds(500),
                        &[gst::MessageType::Error],
                    ) && let gst::MessageView::Error(err) = msg.view()
                    {
                        let _ = tx.send(Event::Error(format!(
                            "{}: {}",
                            err.src()
                                .map(|s| s.path_string().to_string())
                                .unwrap_or_default(),
                            err.error()
                        )));
                    }
                }
            });
        }

        Ok(Arc::new(Self {
            pipeline,
            video_tail,
            audio_tail,
            _video_out: video_out,
            _audio_out: audio_out,
            session: Mutex::new(None),
            connection_state: Arc::new(Mutex::new("none".to_string())),
            latency_ms: config.latency_ms,
            heartbeat,
            shutdown,
            latency: Arc::new(LatencyStats::default()),
        }))
    }

    pub fn media_ready(&self) -> bool {
        self._video_out.flowed_handle().load(Ordering::Relaxed)
    }

    pub fn connection_state(&self) -> String {
        self.connection_state.lock().expect("lock poisoned").clone()
    }

    pub fn latency_stats(&self) -> Option<(f64, f64, f64)> {
        self.latency.snapshot()
    }

    pub fn latency_ms(&self) -> u32 {
        self.latency_ms
    }

    /// Beendet die laufende Sitzung (falls vorhanden). Die MXL-Flows
    /// bleiben bestehen.
    pub fn teardown(&self) {
        let Some(session) = self.session.lock().expect("lock poisoned").take() else {
            return;
        };
        let _ = session.webrtcbin.set_state(gst::State::Null);
        for el in session.elements.lock().expect("lock poisoned").drain(..) {
            let _ = el.set_state(gst::State::Null);
            let _ = self.pipeline.remove(&el);
        }
        let _ = self.pipeline.remove(&session.webrtcbin);
        *self.connection_state.lock().expect("lock poisoned") = "none".to_string();
    }

    /// WHIP: nimmt ein SDP-Offer an und liefert das SDP-Answer. Eine
    /// bereits laufende Sitzung wird ersetzt (eine Kamera je Node).
    pub fn whip_offer(&self, offer_sdp: &str) -> Result<String, String> {
        self.teardown();

        let offer = gst_sdp::SDPMessage::parse_buffer(offer_sdp.as_bytes())
            .map_err(|_| "invalid SDP offer".to_string())?;
        let media_kinds: Vec<String> = (0..offer.medias_len())
            .map(|i| {
                offer
                    .media(i)
                    .and_then(|m| m.media())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();

        let webrtcbin = gst::ElementFactory::make("webrtcbin")
            .property_from_str("bundle-policy", "max-bundle")
            .property("latency", self.latency_ms)
            .build()
            .map_err(|e| format!("webrtcbin: {e}"))?;
        let elements: Arc<Mutex<Vec<gst::Element>>> = Arc::new(Mutex::new(Vec::new()));

        {
            let pipeline = self.pipeline.clone();
            let video_tail = self.video_tail.clone();
            let audio_tail = self.audio_tail.clone();
            let elements = elements.clone();
            let latency = self.latency.clone();
            webrtcbin.connect_pad_added(move |_, pad| {
                if pad.direction() != gst::PadDirection::Src {
                    return;
                }
                if let Err(e) = attach_receive_chain(
                    &pipeline,
                    pad,
                    &video_tail,
                    &audio_tail,
                    &elements,
                    &latency,
                ) {
                    eprintln!("omp-webrtc-gateway: receive chain failed: {e}");
                }
            });
        }
        {
            let state = self.connection_state.clone();
            webrtcbin.connect_notify(Some("connection-state"), move |el, _| {
                let s = el.property::<gst_webrtc::WebRTCPeerConnectionState>("connection-state");
                *state.lock().expect("lock poisoned") = format!("{s:?}").to_lowercase();
            });
        }

        crate::ice::configure(&webrtcbin);
        self.pipeline
            .add(&webrtcbin)
            .map_err(|e| format!("pipeline add webrtcbin: {e}"))?;
        webrtcbin
            .sync_state_with_parent()
            .map_err(|e| format!("webrtcbin sync state: {e}"))?;
        *self.session.lock().expect("lock poisoned") = Some(Session {
            webrtcbin: webrtcbin.clone(),
            elements,
        });

        let result = negotiate(&webrtcbin, offer, &media_kinds)
            .map(|sdp| crate::ice::rewrite_candidates(&sdp));
        if result.is_err() {
            self.teardown();
        }
        result
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        self.teardown();
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn wait_promise(
    webrtcbin: &gst::Element,
    signal: &str,
    desc: &gst_webrtc::WebRTCSessionDescription,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let promise = gst::Promise::with_change_func(move |_| {
        let _ = tx.send(());
    });
    webrtcbin.emit_by_name::<()>(signal, &[desc, &promise]);
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| format!("{signal} timed out"))
}

fn negotiate(
    webrtcbin: &gst::Element,
    offer: gst_sdp::SDPMessage,
    media_kinds: &[String],
) -> Result<String, String> {
    // Empfangs-Transceiver je m-Line VOR set-remote-description anlegen
    // (webrtcbin 1.22 legt sonst erst beim Answer welche an, ein
    // Codec-Wunsch griffe ins Leere): genau H.264 bzw. Opus, damit nichts
    // anderes ausgehandelt wird. Reihenfolge = m-Line-Reihenfolge.
    for kind in media_kinds {
        let caps = match kind.as_str() {
            "video" => gst::Caps::builder("application/x-rtp")
                .field("media", "video")
                .field("encoding-name", "H264")
                .field("clock-rate", 90000i32)
                .build(),
            "audio" => gst::Caps::builder("application/x-rtp")
                .field("media", "audio")
                .field("encoding-name", "OPUS")
                .field("clock-rate", 48000i32)
                .build(),
            other => return Err(format!("unsupported media in offer: {other}")),
        };
        let _tr = webrtcbin.emit_by_name::<gst_webrtc::WebRTCRTPTransceiver>(
            "add-transceiver",
            &[&gst_webrtc::WebRTCRTPTransceiverDirection::Recvonly, &caps],
        );
    }

    let offer_desc =
        gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Offer, offer);
    wait_promise(webrtcbin, "set-remote-description", &offer_desc)?;

    let (tx, rx) = mpsc::channel();
    let promise = gst::Promise::with_change_func(move |reply| {
        let answer = reply
            .ok()
            .flatten()
            .and_then(|s| s.get::<gst_webrtc::WebRTCSessionDescription>("answer").ok());
        let _ = tx.send(answer);
    });
    webrtcbin.emit_by_name::<()>("create-answer", &[&None::<gst::Structure>, &promise]);
    let answer = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "create-answer timed out".to_string())?
        .ok_or("create-answer returned no answer (no common codec? need H.264 + Opus)")?;
    wait_promise(webrtcbin, "set-local-description", &answer)?;

    // Nicht-Trickle: auf abgeschlossenes ICE-Gathering warten.
    let deadline = Instant::now() + Duration::from_secs(5);
    while webrtcbin.property::<gst_webrtc::WebRTCICEGatheringState>("ice-gathering-state")
        != gst_webrtc::WebRTCICEGatheringState::Complete
    {
        if Instant::now() > deadline {
            return Err("ICE gathering timed out".to_string());
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let local = webrtcbin
        .property::<Option<gst_webrtc::WebRTCSessionDescription>>("local-description")
        .ok_or("no local description")?;
    local
        .sdp()
        .as_text()
        .map_err(|e| format!("sdp as_text: {e}"))
}

/// Hängt an einen neuen webrtcbin-Src-Pad die passende Empfangskette
/// (Depayloader → [Parser →] Decoder) und verbindet sie mit dem festen
/// Andockpunkt der MXL-Ausgänge.
fn attach_receive_chain(
    pipeline: &gst::Pipeline,
    pad: &gst::Pad,
    video_tail: &gst::Element,
    audio_tail: &gst::Element,
    elements: &Arc<Mutex<Vec<gst::Element>>>,
    latency: &Arc<LatencyStats>,
) -> Result<(), String> {
    let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
    let structure = caps.structure(0).ok_or("pad without caps")?;
    let media = structure
        .get::<&str>("media")
        .map_err(|e| format!("media: {e}"))?;

    let make = |name: &str| -> Result<gst::Element, String> {
        gst::ElementFactory::make(name)
            .build()
            .map_err(|e| format!("{name}: {e}"))
    };

    let (chain, tail): (Vec<gst::Element>, &gst::Element) = match media {
        "video" => (
            vec![
                make("rtph264depay")?,
                make("h264parse")?,
                // max-threads=1: Frame-Threading würde mehrere Bilder
                // Latenz einbauen.
                gst::ElementFactory::make("avdec_h264")
                    .property("max-threads", 1i32)
                    .build()
                    .map_err(|e| format!("avdec_h264: {e}"))?,
            ],
            video_tail,
        ),
        "audio" => (vec![make("rtpopusdepay")?, make("opusdec")?], audio_tail),
        other => return Err(format!("unsupported media {other}")),
    };

    let refs: Vec<&gst::Element> = chain.iter().collect();
    pipeline
        .add_many(refs.iter().copied())
        .map_err(|e| format!("add chain: {e}"))?;
    gst::Element::link_many(refs.iter().copied()).map_err(|e| format!("link chain: {e}"))?;
    chain
        .last()
        .expect("non-empty")
        .link(tail)
        .map_err(|e| format!("link tail: {e}"))?;
    for el in &chain {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync chain: {e}"))?;
    }
    let first_sink = chain[0]
        .static_pad("sink")
        .ok_or("depay without sink pad")?;
    pad.link(&first_sink)
        .map_err(|e| format!("link pad: {e:?}"))?;
    if media == "video"
        && let Some(src) = chain.last().and_then(|d| d.static_pad("src"))
    {
        install_latency_probe(&src, latency.clone());
    }
    elements.lock().expect("lock poisoned").extend(chain);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Zeichnet einen Streifen wie `camera.html` (Luma 16/235) in ein Bild.
    fn draw_strip(width: usize, height: usize, ts: u64) -> Vec<u8> {
        let mut luma = vec![100u8; width * height];
        let nibble_sum: u64 = (0..11).map(|k| (ts >> (4 * k)) & 0xf).sum();
        let mut bits = vec![true];
        bits.extend((0..44).rev().map(|i| (ts >> i) & 1 == 1));
        bits.extend((0..4).rev().map(|i| ((nibble_sum % 16) >> i) & 1 == 1));
        let cell_w = width as f64 / STRIP_CELLS as f64;
        for y in 0..height / STRIP_HEIGHT_DIVISOR {
            for x in 0..width {
                let cell = ((x as f64 / cell_w) as usize).min(STRIP_CELLS - 1);
                luma[y * width + x] = if bits[cell] { 235 } else { 16 };
            }
        }
        luma
    }

    #[test]
    fn strip_roundtrips_at_several_resolutions() {
        let ts = 1_790_000_123_456u64;
        for (w, h) in [(1280, 720), (640, 360), (1920, 1080), (960, 540)] {
            let luma = draw_strip(w, h, ts);
            assert_eq!(decode_timestamp_strip(&luma, w, w, h), Some(ts), "{w}x{h}");
        }
    }

    #[test]
    fn strip_rejects_missing_or_corrupt_pattern() {
        let flat = vec![100u8; 1280 * 720];
        assert_eq!(decode_timestamp_strip(&flat, 1280, 1280, 720), None);
        let mut luma = draw_strip(1280, 720, 1_790_000_123_456);
        // Ein Datenbit (Zelle 10) komplett kippen → Prüfsumme muss anschlagen.
        let cell_w = 1280.0 / STRIP_CELLS as f64;
        let (x0, x1) = ((10.0 * cell_w) as usize + 1, (11.0 * cell_w) as usize - 1);
        let flipped = if luma[(x0 + x1) / 2] == 235 { 16 } else { 235 };
        for y in 0..720 / STRIP_HEIGHT_DIVISOR {
            for x in x0..x1 {
                luma[y * 1280 + x] = flipped;
            }
        }
        assert_eq!(decode_timestamp_strip(&luma, 1280, 1280, 720), None);
    }

    #[test]
    fn stats_window_reports_avg_last_max() {
        let s = LatencyStats::default();
        assert!(s.snapshot().is_none());
        for v in [10.0, 20.0, 30.0] {
            s.record(v);
        }
        assert_eq!(s.snapshot(), Some((20.0, 30.0, 30.0)));
    }
}
