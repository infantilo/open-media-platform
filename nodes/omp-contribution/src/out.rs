//! Rückleitung (UMSETZUNG 106.11): MXL-Flows → Kodierung → MPEG-TS → SRT/RIST. Gleiches Binary wie der Leitungseingang
//! (`OMP_CONTRIB_DIRECTION=out`). Zweck: Kommentator-Rückweg und PGM-Rückweg zum Veranstaltungsort.
//!
//! ```text
//! MxlAudioInput ─ audioconvert ─ audioresample ─ avenc_aac ─ aacparse ─┐
//!                                                                      ├─ mpegtsmux ─ srtsink | rtpmp2tpay ─ ristsink
//! MxlVideoInput ─ videoconvert ─ x264enc ─ h264parse (optional) ──────┘
//! ```
//!
//! Ton ist Pflicht (ohne verbundenen Ton läuft nichts), Bild optional (`contrib.videoEnabled`). Jede Änderung baut die
//! Pipeline neu (Ziel, Betriebsart, Bitraten, Verbindung). Die Passphrase kommt nur aus einer Datei (≤ 0600).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::mxl::{MxlAudioInput, MxlContext, MxlVideoInput};
use tokio::sync::mpsc::UnboundedSender;

use crate::config::{SrtMode, Transport, parse_rist_uri, validate_line_uri};
use crate::pipeline::{Event, backoff};

#[derive(Clone, Debug)]
pub struct OutSettings {
    pub uri: String,
    pub mode: SrtMode,
    pub latency_ms: u32,
    pub stream_id: String,
    pub audio_kbps: u32,
    pub video_enabled: bool,
    pub video_kbps: u32,
}

#[derive(Clone, Debug, Default)]
pub struct OutStats {
    pub bitrate_kbps: f64,
    pub retransmits: u64,
    pub loss_permille: f64,
    pub rtt_ms: f64,
}

#[derive(Clone)]
pub struct OutShared {
    pub settings: Arc<Mutex<OutSettings>>,
    pub audio_flow: Arc<Mutex<String>>,
    pub video_flow: Arc<Mutex<String>>,
    pub reconfigure: Arc<AtomicBool>,
    pub state: Arc<Mutex<String>>,
    pub last_error: Arc<Mutex<String>>,
    pub reconnects: Arc<AtomicU64>,
    pub stats: Arc<Mutex<OutStats>>,
    pub has_video: Arc<AtomicBool>,
}

impl OutShared {
    pub fn new(settings: OutSettings) -> Self {
        OutShared {
            settings: Arc::new(Mutex::new(settings)),
            audio_flow: Arc::new(Mutex::new(String::new())),
            video_flow: Arc::new(Mutex::new(String::new())),
            reconfigure: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new("waiting".into())),
            last_error: Arc::new(Mutex::new(String::new())),
            reconnects: Arc::new(AtomicU64::new(0)),
            stats: Arc::new(Mutex::new(OutStats::default())),
            has_video: Arc::new(AtomicBool::new(false)),
        }
    }
    fn set_state(&self, s: &str) {
        *self.state.lock().expect("lock poisoned") = s.to_string();
    }
    fn set_error(&self, s: &str) {
        *self.last_error.lock().expect("lock poisoned") = s.to_string();
    }
}

pub struct OutConfig {
    pub domain: String,
    pub passphrase_file: Option<String>,
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory).build().map_err(|e| format!("{factory}: {e}"))
}

struct Active {
    pipeline: gst::Pipeline,
    sink: gst::Element,
    _audio: MxlAudioInput,
    _video: Option<MxlVideoInput>,
    /// Gesendete Bytes aus einem Probe am Multiplexer-Ausgang (gilt für SRT und RIST gleich).
    bytes: Arc<AtomicU64>,
}

impl Drop for Active {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn build(config: &OutConfig, shared: &OutShared, ctx: &Arc<MxlContext>, audio_flow: &str, video_flow: Option<&str>) -> Result<Active, String> {
    let st = shared.settings.lock().expect("lock poisoned").clone();
    let (transport, _) = validate_line_uri(&st.uri)?;
    let pipeline = gst::Pipeline::new();
    let mux = make("mpegtsmux")?;
    pipeline.add(&mux).map_err(|e| format!("add: {e}"))?;

    // Ton
    let audio = MxlAudioInput::new(&pipeline, ctx.clone(), audio_flow)?;
    let conv = make("audioconvert")?;
    let res = make("audioresample")?;
    let enc = make("avenc_aac")?;
    enc.set_property("bitrate", (st.audio_kbps.max(16) * 1000) as i32);
    let parse = make("aacparse")?;
    let aq = make("queue")?;
    pipeline.add_many([&conv, &res, &enc, &parse, &aq]).map_err(|e| format!("add: {e}"))?;
    let tail = audio.tail.clone();
    gst::Element::link_many([&tail, &conv, &res, &enc, &parse, &aq, &mux]).map_err(|e| format!("link Ton: {e}"))?;

    // Bild (optional)
    let video = match video_flow {
        Some(vf) if st.video_enabled => {
            let v = MxlVideoInput::new(&pipeline, ctx.clone(), vf)?;
            let vc = make("videoconvert")?;
            let x = make("x264enc")?;
            x.set_property("bitrate", st.video_kbps.max(100));
            x.set_property_from_str("tune", "zerolatency");
            x.set_property_from_str("speed-preset", "ultrafast");
            x.set_property("key-int-max", 25u32);
            let hp = make("h264parse")?;
            hp.set_property("config-interval", -1i32);
            let caps = gst::ElementFactory::make("capsfilter")
                .property("caps", gst::Caps::builder("video/x-h264").field("stream-format", "byte-stream").field("alignment", "au").build())
                .build()
                .map_err(|e| e.to_string())?;
            let vq = make("queue")?;
            pipeline.add_many([&vc, &x, &hp, &caps, &vq]).map_err(|e| format!("add: {e}"))?;
            let vt = v.tail.clone();
            gst::Element::link_many([&vt, &vc, &x, &hp, &caps, &vq, &mux]).map_err(|e| format!("link Bild: {e}"))?;
            Some(v)
        }
        _ => None,
    };
    shared.has_video.store(video.is_some(), Ordering::Relaxed);

    // Ziel
    let sink: gst::Element = match transport {
        Transport::Srt => {
            let s = make("srtsink")?;
            s.set_property("uri", &st.uri);
            s.set_property_from_str("mode", st.mode.as_str());
            s.set_property("latency", st.latency_ms as i32);
            if !st.stream_id.is_empty() {
                s.set_property("streamid", &st.stream_id);
            }
            if let Some(path) = &config.passphrase_file {
                let pass = crate::config::read_passphrase_file(path)?;
                s.set_property("passphrase", &pass);
                s.set_property_from_str("pbkeylen", "16");
            }
            // Listener ohne Gegenstelle: weiterlaufen (Gegenstelle verbindet später). Caller: Fehler sichtbar machen.
            s.set_property("wait-for-connection", st.mode == SrtMode::Listener);
            s.set_property("sync", false);
            // SRT (Live-Modus) trägt höchstens 1316 Byte je Nachricht = 7 TS-Pakete: den Multiplexer-Ausgang in solche Stücke teilen,
            // sonst werden große Bildpuffer abgeschnitten und der Strom ist beim Empfänger zerstört.
            let ts = make("tsparse")?;
            ts.set_property("alignment", 7u32);
            pipeline.add_many([&ts, &s]).map_err(|e| format!("add: {e}"))?;
            gst::Element::link_many([&mux, &ts, &s]).map_err(|e| format!("link Ziel: {e}"))?;
            s
        }
        Transport::Rist => {
            let links = parse_rist_uri(&st.uri)?;
            let pay = make("rtpmp2tpay")?;
            let s = make("ristsink")?;
            if links.len() == 1 {
                s.set_property("address", &links[0].0);
                s.set_property("port", links[0].1 as u32);
            } else {
                let list = links.iter().map(|(h, p)| format!("{h}:{p}")).collect::<Vec<_>>().join(",");
                s.set_property("bonding-addresses", &list);
                s.set_property_from_str("bonding-method", "broadcast");
            }
            s.set_property("sync", false);
            pipeline.add_many([&pay, &s]).map_err(|e| format!("add: {e}"))?;
            gst::Element::link_many([&mux, &pay, &s]).map_err(|e| format!("link Ziel: {e}"))?;
            s
        }
    };
    let bytes = Arc::new(AtomicU64::new(0));
    let b = bytes.clone();
    mux.static_pad("src").ok_or("mpegtsmux ohne src")?.add_probe(gst::PadProbeType::BUFFER | gst::PadProbeType::BUFFER_LIST, move |_p, info| {
        match &info.data {
            Some(gst::PadProbeData::Buffer(buf)) => {
                b.fetch_add(buf.size() as u64, Ordering::Relaxed);
            }
            Some(gst::PadProbeData::BufferList(l)) => {
                b.fetch_add(l.iter().map(|x| x.size() as u64).sum::<u64>(), Ordering::Relaxed);
            }
            _ => {}
        }
        gst::PadProbeReturn::Ok
    });
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("Playing: {e}"))?;
    Ok(Active { pipeline, sink, _audio: audio, _video: video, bytes })
}

fn num(s: &gst::Structure, k: &str) -> Option<f64> {
    s.get::<f64>(k).ok().or_else(|| s.get::<i32>(k).ok().map(f64::from)).or_else(|| s.get::<i64>(k).ok().map(|v| v as f64)).or_else(|| s.get::<u64>(k).ok().map(|v| v as f64))
}

/// Statistik des Senders (SRT: `stats`; RIST: `rist/x-sender-stats`). Bitrate aus den gesendeten TS-Bytes.
fn read_stats(a: &Active, prev: &mut (u64, Instant), out: &mut OutStats) {
    let b = a.bytes.load(Ordering::Relaxed);
    let dt = prev.1.elapsed().as_secs_f64();
    if dt > 0.5 {
        out.bitrate_kbps = (b.saturating_sub(prev.0) as f64 * 8.0 / 1000.0) / dt;
        *prev = (b, Instant::now());
    }
    let s = a.sink.property::<gst::Structure>("stats");
    if s.name() == "rist/x-sender-stats" {
        out.retransmits = num(&s, "retransmitted").unwrap_or(0.0) as u64;
        out.rtt_ms = num(&s, "round-trip-time").unwrap_or(0.0);
        return;
    }
    let link: gst::Structure = s
        .get::<gst::glib::ValueArray>("callers")
        .ok()
        .and_then(|v| v.first().and_then(|x| x.get::<gst::Structure>().ok()))
        .unwrap_or_else(|| s.clone());
    out.retransmits = num(&link, "packets-retransmitted").unwrap_or(0.0) as u64;
    out.rtt_ms = num(&link, "rtt-ms").unwrap_or(0.0);
    let sent = num(&link, "packets-sent").unwrap_or(0.0);
    let lost = num(&link, "packets-sent-lost").unwrap_or(0.0);
    out.loss_permille = if sent + lost > 0.0 { 1000.0 * lost / (sent + lost) } else { 0.0 };
}

fn poll_problem(p: &gst::Pipeline, timeout: Duration) -> Option<String> {
    let bus = p.bus()?;
    let msg = bus.timed_pop_filtered(gst::ClockTime::from_mseconds(timeout.as_millis() as u64), &[gst::MessageType::Error, gst::MessageType::Eos])?;
    match msg.view() {
        gst::MessageView::Error(e) => Some(format!("{}", e.error())),
        gst::MessageView::Eos(_) => Some("Strom beendet (EOS)".to_string()),
        _ => None,
    }
}

pub fn run(config: OutConfig, tx: UnboundedSender<Event>, shutdown: Arc<AtomicBool>, heartbeat: Arc<AtomicU64>, shared: OutShared) {
    if let Err(e) = gst::init() {
        let _ = tx.send(Event::Error(format!("gst init: {e}")));
        return;
    }
    let ctx = match MxlContext::new(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = tx.send(Event::Error(e));
            return;
        }
    };
    let mut attempt: u32 = 0;
    while !shutdown.load(Ordering::Relaxed) {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        shared.reconfigure.store(false, Ordering::Relaxed);
        let af = shared.audio_flow.lock().expect("lock poisoned").clone();
        let vf = shared.video_flow.lock().expect("lock poisoned").clone();
        if af.is_empty() {
            shared.set_state("waiting");
            std::thread::sleep(Duration::from_millis(300));
            continue;
        }
        shared.set_state("connecting");
        let active = match build(&config, &shared, &ctx, &af, if vf.is_empty() { None } else { Some(&vf) }) {
            Ok(a) => a,
            Err(e) => {
                shared.set_state("error");
                shared.set_error(&e);
                let _ = tx.send(Event::Error(e));
                if !sleep(backoff(attempt), &shutdown, &heartbeat, &shared) {
                    break;
                }
                attempt = attempt.saturating_add(1);
                continue;
            }
        };
        let started = Instant::now();
        let mut prev = (0u64, Instant::now());
        let mut problem: Option<String> = None;
        let mut playing = false;
        loop {
            heartbeat.fetch_add(1, Ordering::Relaxed);
            if shutdown.load(Ordering::Relaxed) || shared.reconfigure.load(Ordering::Relaxed) {
                break;
            }
            if let Some(p) = poll_problem(&active.pipeline, Duration::from_millis(500)) {
                problem = Some(p);
                break;
            }
            if !playing && active.bytes.load(Ordering::Relaxed) > 0 {
                playing = true;
                shared.set_state("playing");
                shared.set_error("");
                attempt = 0;
            }
            if !playing && started.elapsed() > Duration::from_secs(20) {
                problem = Some("keine Daten am Ausgang (Ton nicht verbunden oder Quelle liefert nichts)".into());
                break;
            }
            if std::env::var("OMP_CONTRIB_DEBUG").is_ok() {
                eprintln!("out: Zustand {:?} bytes={}", active.pipeline.state(gst::ClockTime::from_mseconds(10)), active.bytes.load(Ordering::Relaxed));
            }
            read_stats(&active, &mut prev, &mut shared.stats.lock().expect("lock poisoned"));
        }
        drop(active);
        let Some(problem) = problem else {
            if shared.reconfigure.load(Ordering::Relaxed) {
                attempt = 0;
                continue;
            }
            break;
        };
        shared.reconnects.fetch_add(1, Ordering::Relaxed);
        shared.set_error(&problem);
        shared.set_state(if playing { "reconnecting" } else { "error" });
        let _ = tx.send(Event::Error(format!("{problem} — verbinde neu")));
        if !sleep(backoff(attempt), &shutdown, &heartbeat, &shared) {
            break;
        }
        attempt = attempt.saturating_add(1);
    }
}

fn sleep(d: Duration, shutdown: &AtomicBool, hb: &AtomicU64, shared: &OutShared) -> bool {
    let end = Instant::now() + d;
    while Instant::now() < end {
        if shutdown.load(Ordering::Relaxed) {
            return false;
        }
        if shared.reconfigure.load(Ordering::Relaxed) {
            return true;
        }
        hb.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(250));
    }
    !shutdown.load(Ordering::Relaxed)
}
