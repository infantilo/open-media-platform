//! Pipeline von `omp-contribution` (UMSETZUNG 106.6): SRT → MPEG-TS → Dekoder → MXL im **nativen** Format.
//!
//! Zwei Pipelines (Muster `omp-srt-gateway/src/autobridge.rs`):
//!
//! ```text
//! A: srtsrc ─ queue ─ tsdemux ─ video_* ─ decodebin ─► appsink (Rohbild, native Größe/Rate)
//!                             └ audio_PID ─ decodebin ─ audioconvert ─ audioresample ─ F32LE/48k/2ch ─► appsink je PID
//! B: appsrc(Video) ─ queue ─► MxlVideoOutput                (erst beim ersten Bild gebaut, bei Rasterwechsel neu,
//!    appsrc je Ton-PID ─ audiomixmatrix(2→2N) ─ audiomixer ─► MxlAudioOutput     mit GLEICHEN Flow-IDs)
//! ```
//!
//! **Zeitbezug:** Bild und Ton behalten ihre Strom-Zeitstempel (PTS aus dem TS). Beim ersten Bild wird EIN Versatz
//! (Laufzeit der Pipeline B minus PTS des ersten Bilds) bestimmt und auf Bild **und** Ton gleich angewandt; die
//! Lage von Bild zu Ton im Strom bleibt dadurch erhalten (Etiketten-Erhalt).
//!
//! Die Passphrase kommt nur aus einer Datei (≤ 0600), wird nie protokolliert und steht in keinem Parameter.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use crate::config::{SrtMode, Transport, parse_rist_uri, pid_from_pad_name, validate_line_uri};

const MIN_BACKOFF: Duration = Duration::from_secs(2);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// So lange wartet der Aufbau nach dem ersten Bild auf alle angekündigten Ton-PIDs.
const AUDIO_WAIT: Duration = Duration::from_secs(3);
pub const SAMPLE_RATE: i32 = 48000;

pub fn backoff(attempt: u32) -> Duration {
    MIN_BACKOFF.saturating_mul(1u32 << attempt.min(8)).min(MAX_BACKOFF)
}

/// Laufzeit-Einstellungen (Parameter `contrib.*`). Änderung → Neuaufbau mit gleichen Flow-IDs.
#[derive(Clone, Debug)]
pub struct Settings {
    pub uri: String,
    pub mode: SrtMode,
    pub latency_ms: u32,
    pub stream_id: String,
    /// Leer = alle Ton-PIDs in PID-Reihenfolge.
    pub audio_pids: Vec<u16>,
    /// Relay-Ziel (leer = aus): der Original-Transportstrom geht unverändert dorthin (`srt://…` oder `rist://host:port`).
    pub relay_uri: String,
    pub relay_mode: SrtMode,
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub rtt_ms: f64,
    pub loss_permille: f64,
    pub retransmits: u64,
    pub bitrate_kbps: f64,
}

pub struct Config {
    pub domain: String,
    pub flow_id: String,
    pub audio_flow_id: String,
    pub label: String,
    pub fallback_rate: (i32, i32),
    pub passphrase_file: Option<String>,
}

pub enum Event {
    Error(String),
}

#[derive(Clone)]
pub struct Shared {
    pub settings: Arc<Mutex<Settings>>,
    pub reconfigure: Arc<AtomicBool>,
    pub state: Arc<Mutex<String>>,
    pub last_error: Arc<Mutex<String>>,
    pub reconnects: Arc<AtomicU64>,
    pub video_total: Arc<AtomicU64>,
    /// Tonpuffer insgesamt (Fortschritt auch bei Strömen ohne Bild).
    pub audio_total: Arc<AtomicU64>,
    pub video_flowed: Arc<AtomicBool>,
    pub stats: Arc<Mutex<Stats>>,
    pub input_format: Arc<Mutex<String>>,
    pub audio_channels: Arc<AtomicU32>,
}

impl Shared {
    pub fn new(settings: Settings) -> Self {
        Shared {
            settings: Arc::new(Mutex::new(settings)),
            reconfigure: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new("connecting".into())),
            last_error: Arc::new(Mutex::new(String::new())),
            reconnects: Arc::new(AtomicU64::new(0)),
            video_total: Arc::new(AtomicU64::new(0)),
            audio_total: Arc::new(AtomicU64::new(0)),
            video_flowed: Arc::new(AtomicBool::new(false)),
            stats: Arc::new(Mutex::new(Stats::default())),
            input_format: Arc::new(Mutex::new(String::new())),
            audio_channels: Arc::new(AtomicU32::new(0)),
        }
    }
    fn set_state(&self, s: &str) {
        *self.state.lock().expect("lock poisoned") = s.to_string();
    }
    fn set_error(&self, s: &str) {
        *self.last_error.lock().expect("lock poisoned") = s.to_string();
    }
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory).build().map_err(|e| format!("{factory}: {e}"))
}

/// (Breite, Höhe, Rate Zähler, Rate Nenner)
type RasterKey = (i32, i32, i32, i32);

struct Side {
    pipeline: gst::Pipeline,
    /// `None`: Strom ohne Bild (nur Ton), dann gibt es keinen Video-Fluss.
    vsrc: Option<gst_app::AppSrc>,
    asrcs: BTreeMap<u16, gst_app::AppSrc>,
    key: Option<RasterKey>,
    /// PTS-Versatz (ns), beim ersten Bild bestimmt.
    offset: Option<i64>,
    _vout: Option<MxlVideoOutput>,
    _aout: Option<MxlAudioOutput>,
}

struct Bridge {
    ctx: Arc<MxlContext>,
    flow_id: String,
    audio_flow_id: String,
    label: String,
    fallback_rate: (i32, i32),
    wanted: Vec<u16>,
    shared: Shared,
    side: Mutex<Option<Side>>,
    /// PID → Tonkette hat schon Daten geliefert.
    slots: Mutex<BTreeMap<u16, bool>>,
    expected_known: AtomicBool,
    first_video: Mutex<Option<Instant>>,
    first_audio: Mutex<Option<Instant>>,
    video_seen: AtomicBool,
}

impl Bridge {
    fn key_of(&self, caps: &gst::CapsRef) -> Option<RasterKey> {
        let s = caps.structure(0)?;
        let (w, h) = (s.get::<i32>("width").ok()?, s.get::<i32>("height").ok()?);
        let (n, d) = match s.get::<gst::Fraction>("framerate").ok() {
            Some(f) if f.numer() > 0 && f.denom() > 0 => (f.numer(), f.denom()),
            _ => self.fallback_rate,
        };
        Some((w, h, n, d))
    }

    /// Tonketten in Ausgabereihenfolge.
    fn audio_order(&self) -> Vec<u16> {
        let slots = self.slots.lock().expect("lock poisoned");
        if self.wanted.is_empty() {
            slots.keys().copied().collect()
        } else {
            self.wanted.iter().copied().filter(|p| slots.contains_key(p)).collect()
        }
    }

    fn audio_ready(&self) -> bool {
        if !self.expected_known.load(Ordering::Relaxed) {
            return false;
        }
        let slots = self.slots.lock().expect("lock poisoned");
        slots.values().all(|seen| *seen)
    }

    fn build_side(&self, video: Option<(&gst::CapsRef, RasterKey)>) -> Result<Side, String> {
        let pipeline = gst::Pipeline::new();
        let (vsrc, vout) = match video {
            Some((caps, key)) => {
                let vsrc = gst_app::AppSrc::builder().caps(&caps.to_owned()).format(gst::Format::Time).is_live(true).build();
                vsrc.set_property("max-buffers", 8u64);
                let vq = make("queue")?;
                pipeline.add_many([vsrc.upcast_ref::<gst::Element>(), &vq]).map_err(|e| format!("add: {e}"))?;
                vsrc.link(&vq).map_err(|e| format!("link: {e}"))?;
                let vout = MxlVideoOutput::new(
                    &pipeline,
                    &vq,
                    self.ctx.clone(),
                    &self.flow_id,
                    &self.label,
                    key.0 as u32,
                    key.1 as u32,
                    key.2 as u32,
                    key.3 as u32,
                    Arc::new(AtomicU64::new(0)),
                )?;
                vout.set_active(true);
                (Some(vsrc), Some(vout))
            }
            None => (None, None),
        };
        let key = video.map(|(_, k)| k);

        let order = self.audio_order();
        let n = order.len();
        let mut asrcs = BTreeMap::new();
        let (aout, channels) = if n == 0 {
            // Kein Ton im Strom: Stumm-Zweig, damit der Tonfluss existiert (sonst hält die Senke die Pipeline im Preroll).
            let silence = make("audiotestsrc")?;
            silence.set_property("is-live", true);
            silence.set_property_from_str("wave", "silence");
            let caps = gst::ElementFactory::make("capsfilter")
                .property("caps", gst::Caps::builder("audio/x-raw").field("rate", SAMPLE_RATE).field("channels", 2i32).build())
                .build()
                .map_err(|e| e.to_string())?;
            pipeline.add_many([&silence, &caps]).map_err(|e| e.to_string())?;
            gst::Element::link_many([&silence, &caps]).map_err(|e| e.to_string())?;
            let out = MxlAudioOutput::new(&pipeline, &caps, self.ctx.clone(), &self.audio_flow_id, &self.label, SAMPLE_RATE as u32, 2)?;
            (out, 2u32)
        } else {
            let total = (n * 2) as u32;
            let tail: gst::Element = if n == 1 {
                let (pid, _) = (order[0], 0);
                let src = audio_appsrc();
                let conv = make("audioconvert")?;
                pipeline.add_many([src.upcast_ref::<gst::Element>(), &conv]).map_err(|e| e.to_string())?;
                src.link(&conv).map_err(|e| e.to_string())?;
                asrcs.insert(pid, src);
                conv
            } else {
                let mixer = make("audiomixer")?;
                mixer.set_property("latency", 60_000_000u64);
                pipeline.add(&mixer).map_err(|e| e.to_string())?;
                for (i, pid) in order.iter().enumerate() {
                    let src = audio_appsrc();
                    let mix = make("audiomixmatrix")?;
                    mix.set_property("in-channels", 2u32);
                    mix.set_property("out-channels", total);
                    mix.set_property_from_str("mode", "manual");
                    let rows: Vec<gst::glib::SendValue> = (0..total as usize)
                        .map(|out| {
                            let row: Vec<f64> = (0..2usize).map(|inp| if out == i * 2 + inp { 1.0 } else { 0.0 }).collect();
                            gst::Array::new(row).to_send_value()
                        })
                        .collect();
                    mix.set_property("matrix", gst::Array::from_values(rows));
                    pipeline.add(&mix).map_err(|e| e.to_string())?;
                    pipeline.add(src.upcast_ref::<gst::Element>()).map_err(|e| e.to_string())?;
                    src.link(&mix).map_err(|e| e.to_string())?;
                    mix.link(&mixer).map_err(|e| format!("link mixer: {e}"))?;
                    asrcs.insert(*pid, src);
                }
                let want = make("capssetter")?;
                want.set_property("caps", gst::Caps::builder("audio/x-raw").field("channel-mask", gst::Bitmask::new(0)).build());
                pipeline.add(&want).map_err(|e| e.to_string())?;
                mixer.link(&want).map_err(|e| e.to_string())?;
                want
            };
            let out = MxlAudioOutput::new(&pipeline, &tail, self.ctx.clone(), &self.audio_flow_id, &self.label, SAMPLE_RATE as u32, total)?;
            (out, total)
        };
        aout.set_active(true);
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("Pipeline B: {e}"))?;
        self.shared.audio_channels.store(channels, Ordering::Relaxed);
        Ok(Side { pipeline, vsrc, asrcs, key, offset: None, _vout: vout, _aout: Some(aout) })
    }

    fn push_video(&self, sample: &gst::Sample) {
        let (Some(caps), Some(buf)) = (sample.caps(), sample.buffer()) else { return };
        let Some(key) = self.key_of(caps) else { return };
        if self.shared.video_total.fetch_add(1, Ordering::Relaxed) == 0 && std::env::var("OMP_CONTRIB_DEBUG").is_ok() { eprintln!("erstes Rohbild {:?} audio_ready={}", key, self.audio_ready()); }
        let mut first = self.first_video.lock().expect("lock poisoned");
        let t0 = *first.get_or_insert_with(Instant::now);
        let mut guard = self.side.lock().expect("lock poisoned");
        if guard.as_ref().is_none_or(|s| s.key != Some(key)) {
            // Bauen erst, wenn alle angekündigten Ton-PIDs da sind (oder die Wartezeit um ist).
            if guard.is_none() && !self.audio_ready() && t0.elapsed() < AUDIO_WAIT {
                return;
            }
            if let Some(old) = guard.take() {
                let _ = old.pipeline.set_state(gst::State::Null);
            }
            match self.build_side(Some((caps, key))) {
                Ok(side) => {
                    *self.shared.input_format.lock().expect("lock poisoned") = format!("{}x{}@{}/{}", key.0, key.1, key.2, key.3);
                    eprintln!("omp-contribution: Raster erkannt {}x{}@{}/{}, Ausgang gebaut ({} Ton-PIDs)", key.0, key.1, key.2, key.3, side.asrcs.len());
                    *guard = Some(side);
                }
                Err(e) => {
                    eprintln!("omp-contribution: Ausgang konnte nicht gebaut werden: {e}");
                    self.shared.set_error(&e);
                    return;
                }
            }
        }
        let Some(side) = guard.as_mut() else { return };
        let Some(pts) = buf.pts() else { return };
        if side.offset.is_none() {
            let now = side.pipeline.current_running_time().map_or(0, |t| t.nseconds() as i64);
            side.offset = Some(now - pts.nseconds() as i64);
        }
        let off = side.offset.unwrap_or(0);
        let mut b = buf.copy();
        if let Some(bm) = b.get_mut() {
            let v = pts.nseconds() as i64 + off;
            if v < 0 {
                return;
            }
            bm.set_pts(gst::ClockTime::from_nseconds(v as u64));
            bm.set_dts(gst::ClockTime::NONE);
        }
        if let Some(v) = &side.vsrc {
            let _ = v.push_buffer(b);
        }
        self.shared.video_flowed.store(true, Ordering::Relaxed);
    }

    fn push_audio(&self, pid: u16, sample: &gst::Sample) {
        self.shared.audio_total.fetch_add(1, Ordering::Relaxed);
        if let Some(seen) = self.slots.lock().expect("lock poisoned").get_mut(&pid) {
            *seen = true;
        }
        let Some(buf) = sample.buffer() else { return };
        let t0 = *self.first_audio.lock().expect("lock poisoned").get_or_insert_with(Instant::now);
        let mut guard = self.side.lock().expect("lock poisoned");
        // Strom ohne Bild (nach „no-more-pads“ kein Video-Pad): Ausgang nur mit Ton bauen, sobald alle Ton-PIDs da sind.
        if guard.is_none() && self.expected_known.load(Ordering::Relaxed) && !self.video_seen.load(Ordering::Relaxed) && (self.audio_ready() || t0.elapsed() >= AUDIO_WAIT) {
            match self.build_side(None) {
                Ok(side) => {
                    *self.shared.input_format.lock().expect("lock poisoned") = "nur Ton".to_string();
                    eprintln!("omp-contribution: Strom ohne Bild, Ausgang nur mit Ton gebaut ({} Ton-PIDs)", side.asrcs.len());
                    *guard = Some(side);
                    self.shared.video_flowed.store(true, Ordering::Relaxed);
                }
                Err(e) => {
                    eprintln!("omp-contribution: Ausgang konnte nicht gebaut werden: {e}");
                    self.shared.set_error(&e);
                    return;
                }
            }
        }
        let Some(side) = guard.as_mut() else { return };
        let Some(pts) = buf.pts() else { return };
        if side.offset.is_none() && side.vsrc.is_none() {
            // Ohne Bild bestimmt der erste Ton den Versatz.
            let now = side.pipeline.current_running_time().map_or(0, |t| t.nseconds() as i64);
            side.offset = Some(now - pts.nseconds() as i64);
        }
        let Some(off) = side.offset else { return };
        let Some(src) = side.asrcs.get(&pid) else { return };
        let v = pts.nseconds() as i64 + off;
        if v < 0 {
            return;
        }
        let mut b = buf.copy();
        if let Some(bm) = b.get_mut() {
            bm.set_pts(gst::ClockTime::from_nseconds(v as u64));
            bm.set_dts(gst::ClockTime::NONE);
        }
        let _ = src.push_buffer(b);
    }

    fn shutdown(&self) {
        if let Some(s) = self.side.lock().expect("lock poisoned").take() {
            let _ = s.pipeline.set_state(gst::State::Null);
        }
    }
}

fn audio_appsrc() -> gst_app::AppSrc {
    gst_app::AppSrc::builder()
        .caps(
            &gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("rate", SAMPLE_RATE)
                .field("channels", 2i32)
                .field("layout", "interleaved")
                .field("channel-mask", gst::Bitmask::new(0))
                .build(),
        )
        .format(gst::Format::Time)
        .is_live(true)
        .build()
}

fn add_sync(pipeline: &gst::Pipeline, els: &[&gst::Element]) -> Result<(), String> {
    for e in els {
        pipeline.add(*e).map_err(|er| format!("add: {er}"))?;
    }
    for e in els {
        // Pipeline A läuft immer nach PLAYING; Elemente, die mitten im Zustandswechsel dazukommen, gleich dorthin bringen.
        e.set_state(gst::State::Playing).map_err(|er| format!("sync: {er}"))?;
    }
    Ok(())
}

struct ActiveA {
    pipeline: gst::Pipeline,
    srt: gst::Element,
    bridge: Arc<Bridge>,
}

fn build_a(config: &Config, shared: &Shared, ctx: Arc<MxlContext>) -> Result<ActiveA, String> {
    let st = shared.settings.lock().expect("lock poisoned").clone();
    let pipeline = gst::Pipeline::new();
    let (transport, _) = validate_line_uri(&st.uri)?;
    // Kopf: liefert den Original-Transportstrom (Bytes des TS) an `ts_tail`.
    let (srt, ts_tail): (gst::Element, gst::Element) = match transport {
        Transport::Srt => {
            let srt = make("srtsrc")?;
            srt.set_property("uri", &st.uri);
            srt.set_property_from_str("mode", st.mode.as_str());
            srt.set_property("latency", st.latency_ms as i32);
            if !st.stream_id.is_empty() {
                srt.set_property("streamid", &st.stream_id);
            }
            if let Some(path) = &config.passphrase_file {
                let pass = crate::config::read_passphrase_file(path)?;
                srt.set_property("passphrase", &pass);
                srt.set_property_from_str("pbkeylen", "16");
            }
            // Caller: Fehler (Ablehnung, falsche Passphrase) sollen sichtbar werden und über unseren Rückstau laufen.
            srt.set_property("auto-reconnect", st.mode != SrtMode::Caller);
            pipeline.add(&srt).map_err(|e| format!("add: {e}"))?;
            (srt.clone(), srt)
        }
        Transport::Rist => {
            // RIST Simple Profile (VSF TR-06-1) über `ristsrc`; Bündelung über `bonding-addresses`.
            let links = parse_rist_uri(&st.uri)?;
            let rist = make("ristsrc")?;
            if links.len() == 1 {
                rist.set_property("address", &links[0].0);
                rist.set_property("port", links[0].1 as u32);
            } else {
                let list = links.iter().map(|(h, p)| format!("{h}:{p}")).collect::<Vec<_>>().join(",");
                rist.set_property("bonding-addresses", &list);
            }
            rist.set_property("receiver-buffer", st.latency_ms);
            let caps = make("capsfilter")?;
            caps.set_property("caps", gst::Caps::builder("application/x-rtp").field("media", "video").field("clock-rate", 90000i32).field("encoding-name", "MP2T").build());
            let depay = make("rtpmp2tdepay")?;
            pipeline.add_many([&rist, &caps, &depay]).map_err(|e| format!("add: {e}"))?;
            gst::Element::link_many([&rist, &caps, &depay]).map_err(|e| format!("link: {e}"))?;
            (rist, depay)
        }
    };
    let tee = make("tee")?;
    let q = make("queue")?;
    let demux = make("tsdemux")?;
    pipeline.add_many([&tee, &q, &demux]).map_err(|e| format!("add: {e}"))?;
    ts_tail.link(&tee).map_err(|e| format!("link: {e}"))?;
    gst::Element::link_many([&tee, &q, &demux]).map_err(|e| format!("link: {e}"))?;
    // Relay: derselbe Transportstrom, unverändert, aus einem eigenen Zweig (berührt Dekodierung und MXL-Ausgang nicht).
    if !st.relay_uri.is_empty() {
        let rq = make("queue")?;
        // Ein langsames Relay-Ziel darf die Leitung nicht aufhalten: lieber Pakete im Relay verlieren.
        rq.set_property_from_str("leaky", "downstream");
        rq.set_property("max-size-buffers", 2000u32);
        pipeline.add(&rq).map_err(|e| format!("add: {e}"))?;
        tee.link(&rq).map_err(|e| format!("link: {e}"))?;
        let (rt, _) = validate_line_uri(&st.relay_uri)?;
        match rt {
            Transport::Srt => {
                let sink = make("srtsink")?;
                sink.set_property("uri", &st.relay_uri);
                sink.set_property_from_str("mode", st.relay_mode.as_str());
                sink.set_property("wait-for-connection", false);
                sink.set_property("sync", false);
                pipeline.add(&sink).map_err(|e| format!("add: {e}"))?;
                rq.link(&sink).map_err(|e| format!("link: {e}"))?;
            }
            Transport::Rist => {
                let l = parse_rist_uri(&st.relay_uri)?;
                let pay = make("rtpmp2tpay")?;
                let sink = make("ristsink")?;
                sink.set_property("address", &l[0].0);
                sink.set_property("port", l[0].1 as u32);
                sink.set_property("sync", false);
                pipeline.add_many([&pay, &sink]).map_err(|e| format!("add: {e}"))?;
                gst::Element::link_many([&rq, &pay, &sink]).map_err(|e| format!("link: {e}"))?;
            }
        }
    }

    let bridge = Arc::new(Bridge {
        ctx,
        flow_id: config.flow_id.clone(),
        audio_flow_id: config.audio_flow_id.clone(),
        label: config.label.clone(),
        fallback_rate: config.fallback_rate,
        wanted: st.audio_pids.clone(),
        shared: shared.clone(),
        side: Mutex::new(None),
        slots: Mutex::new(BTreeMap::new()),
        expected_known: AtomicBool::new(false),
        first_video: Mutex::new(None),
        first_audio: Mutex::new(None),
        video_seen: AtomicBool::new(false),
    });

    let weak = pipeline.downgrade();
    let b = bridge.clone();
    let video_linked = Arc::new(AtomicBool::new(false));
    demux.connect_pad_added(move |_d, pad| {
        let Some(pipeline) = weak.upgrade() else { return };
        let name = pad.name().to_string();
        if std::env::var("OMP_CONTRIB_DEBUG").is_ok() { eprintln!("tsdemux pad {name}"); }
        let res = (|| -> Result<(), String> {
            if name.starts_with("video") {
                b.video_seen.store(true, Ordering::Relaxed);
                if video_linked.swap(true, Ordering::Relaxed) {
                    return Err("zweiter Video-Strom ignoriert".into());
                }
                let dbin = make("decodebin")?;
                add_sync(&pipeline, &[&dbin])?;
                pad.link(&dbin.static_pad("sink").ok_or("decodebin ohne sink")?).map_err(|e| format!("link: {e:?}"))?;
                let (pl, b2) = (pipeline.downgrade(), b.clone());
                dbin.connect_no_more_pads(|_| eprintln!("decodebin(video) no-more-pads"));
                dbin.connect_pad_added(move |_d, dpad| {
                    let Some(pl) = pl.upgrade() else { return };
                    if std::env::var("OMP_CONTRIB_DEBUG").is_ok() { eprintln!("decodebin(video) pad {} caps {:?}", dpad.name(), dpad.current_caps()); }
                    let is_video = dpad.current_caps().or_else(|| Some(dpad.query_caps(None))).and_then(|c| c.structure(0).map(|s| s.name().starts_with("video/x-raw"))).unwrap_or(false);
                    if !is_video {
                        return;
                    }
                    let sink = gst_app::AppSink::builder().sync(false).max_buffers(4).drop(true).caps(&gst::Caps::builder("video/x-raw").build()).build();
                    sink.set_property("async", false);
                    let b3 = b2.clone();
                    sink.set_callbacks(
                        gst_app::AppSinkCallbacks::builder()
                            .new_sample(move |s| {
                                let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                                b3.push_video(&sample);
                                Ok(gst::FlowSuccess::Ok)
                            })
                            .build(),
                    );
                    match add_sync(&pl, &[sink.upcast_ref()]) {
                        Ok(()) => match sink.static_pad("sink") {
                            Some(sp) => {
                                if let Err(e) = dpad.link(&sp) {
                                    eprintln!("omp-contribution: Video-Pad nicht verbunden: {e:?}");
                                }
                            }
                            None => eprintln!("omp-contribution: appsink ohne Pad"),
                        },
                        Err(e) => eprintln!("omp-contribution: appsink: {e}"),
                    }
                });
            } else if name.starts_with("audio") {
                let Some(pid) = pid_from_pad_name(&name) else { return Err("PID unlesbar".into()) };
                let wanted = b.wanted.is_empty() || b.wanted.contains(&pid);
                if !wanted {
                    let fs = make("fakesink")?;
                    fs.set_property("sync", false);
                    fs.set_property("async", false);
                    add_sync(&pipeline, &[&fs])?;
                    pad.link(&fs.static_pad("sink").ok_or("fakesink")?).map_err(|e| format!("link: {e:?}"))?;
                    return Ok(());
                }
                b.slots.lock().expect("lock poisoned").insert(pid, false);
                let dbin = make("decodebin")?;
                add_sync(&pipeline, &[&dbin])?;
                pad.link(&dbin.static_pad("sink").ok_or("decodebin ohne sink")?).map_err(|e| format!("link: {e:?}"))?;
                let (pl, b2) = (pipeline.downgrade(), b.clone());
                dbin.connect_pad_added(move |_d, dpad| {
                    let Some(pl) = pl.upgrade() else { return };
                    if std::env::var("OMP_CONTRIB_DEBUG").is_ok() { eprintln!("decodebin(audio {pid:x}) pad {} caps {:?}", dpad.name(), dpad.current_caps()); }
                    let is_audio = dpad.current_caps().or_else(|| Some(dpad.query_caps(None))).and_then(|c| c.structure(0).map(|s| s.name().starts_with("audio/x-raw"))).unwrap_or(false);
                    if !is_audio {
                        return;
                    }
                    let (Ok(conv), Ok(res), Ok(cf)) = (make("audioconvert"), make("audioresample"), make("capsfilter")) else { return };
                    cf.set_property(
                        "caps",
                        gst::Caps::builder("audio/x-raw").field("format", "F32LE").field("rate", SAMPLE_RATE).field("channels", 2i32).field("layout", "interleaved").build(),
                    );
                    let sink = gst_app::AppSink::builder().sync(false).max_buffers(8).drop(false).build();
                    sink.set_property("async", false);
                    let b3 = b2.clone();
                    sink.set_callbacks(
                        gst_app::AppSinkCallbacks::builder()
                            .new_sample(move |s| {
                                let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                                b3.push_audio(pid, &sample);
                                Ok(gst::FlowSuccess::Ok)
                            })
                            .build(),
                    );
                    let r1 = add_sync(&pl, &[&conv, &res, &cf, sink.upcast_ref()]);
                    let r2 = gst::Element::link_many([&conv, &res, &cf, sink.upcast_ref()]);
                    let r3 = dpad.link(&conv.static_pad("sink").expect("sink"));
                    if std::env::var("OMP_CONTRIB_DEBUG").is_ok() { eprintln!("audio {pid:x}: add={r1:?} link={r2:?} pad={r3:?}"); }
                });
            }
            Ok(())
        })();
        if let Err(e) = res {
            eprintln!("omp-contribution: Pad {name}: {e}");
        }
    });
    let b = bridge.clone();
    demux.connect_no_more_pads(move |_d| b.expected_known.store(true, Ordering::Relaxed));

    pipeline.set_state(gst::State::Playing).map_err(|e| format!("Pipeline A: {e}"))?;
    Ok(ActiveA { pipeline, srt, bridge })
}

fn num_field(s: &gst::Structure, name: &str) -> Option<f64> {
    s.get::<f64>(name).ok().or_else(|| s.get::<i32>(name).ok().map(f64::from)).or_else(|| s.get::<i64>(name).ok().map(|v| v as f64)).or_else(|| s.get::<u64>(name).ok().map(|v| v as f64)).or_else(|| s.get::<u32>(name).ok().map(f64::from))
}

/// Liest die SRT-Statistik der Quelle (Feldnamen des GStreamer-SRT-Plugins, live geprüft).
fn read_stats(srt: &gst::Element, prev: &mut (f64, Instant), out: &mut Stats) {
    let s = srt.property::<gst::Structure>("stats");
    if std::env::var("OMP_CONTRIB_DEBUG_STATS").is_ok() { eprintln!("SRT-Stats: {s}"); }
    if s.name() == "rist/x-receiver-stats" {
        // RIST (TR-06-1, GStreamer ristsrc): Pakete statt Bytes; ein Paket = 7 TS-Pakete (1316 Byte Nutzlast), also Näherung.
        let received = num_field(&s, "received").unwrap_or(0.0);
        let dt = prev.1.elapsed().as_secs_f64();
        if dt > 0.5 {
            out.bitrate_kbps = ((received - prev.0).max(0.0) * 1316.0 * 8.0 / 1000.0) / dt;
            *prev = (received, Instant::now());
        }
        out.retransmits = num_field(&s, "retransmission-requests-sent").unwrap_or(0.0) as u64;
        out.rtt_ms = num_field(&s, "rtx-roundtrip-time").unwrap_or(0.0);
        let lost = num_field(&s, "permanently-lost").unwrap_or(0.0);
        out.loss_permille = if received + lost > 0.0 { 1000.0 * lost / (received + lost) } else { 0.0 };
        return;
    }
    let bytes = num_field(&s, "bytes-received-total").unwrap_or(0.0);
    let dt = prev.1.elapsed().as_secs_f64();
    if dt > 0.5 {
        out.bitrate_kbps = ((bytes - prev.0).max(0.0) * 8.0 / 1000.0) / dt;
        *prev = (bytes, Instant::now());
    }
    // Im Listener-Modus stehen die Werte je Gegenstelle in `callers`, im Caller-Modus oben.
    let per_link: gst::Structure = s
        .get::<gst::glib::ValueArray>("callers")
        .ok()
        .and_then(|a| a.first().and_then(|v| v.get::<gst::Structure>().ok()))
        .unwrap_or_else(|| s.clone());
    // Wiederholungsanforderungen des Empfängers (NAK) bzw. beim Sender erneut gesendete Pakete.
    out.retransmits = num_field(&per_link, "packet-nack-sent").or_else(|| num_field(&per_link, "packets-retransmitted")).unwrap_or(0.0) as u64;
    out.rtt_ms = num_field(&per_link, "rtt-ms").unwrap_or(0.0);
    let recv = num_field(&per_link, "packets-received").unwrap_or(0.0);
    let lost = num_field(&per_link, "packets-received-lost").unwrap_or(0.0);
    out.loss_permille = if recv + lost > 0.0 { 1000.0 * lost / (recv + lost) } else { 0.0 };
}

fn poll_problem(p: &gst::Pipeline, timeout: Duration) -> Option<String> {
    let bus = p.bus()?;
    let msg = bus.timed_pop_filtered(gst::ClockTime::from_mseconds(timeout.as_millis() as u64), &[gst::MessageType::Error, gst::MessageType::Eos])?;
    match msg.view() {
        gst::MessageView::Error(err) => Some(format!("{}", err.error())),
        gst::MessageView::Eos(_) => Some("Strom beendet (EOS)".to_string()),
        _ => None,
    }
}

pub fn run(config: Config, tx: UnboundedSender<Event>, shutdown: Arc<AtomicBool>, ready: oneshot::Sender<Result<Shared, String>>, heartbeat: Arc<AtomicU64>, shared: Shared) {
    if let Err(e) = gst::init() {
        let _ = ready.send(Err(format!("gst init: {e}")));
        return;
    }
    let ctx = match MxlContext::new(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(shared.clone()));
    let mut attempt: u32 = 0;
    while !shutdown.load(Ordering::Relaxed) {
        shared.reconfigure.store(false, Ordering::Relaxed);
        shared.set_state(if attempt == 0 { "connecting" } else { "reconnecting" });
        let a = match build_a(&config, &shared, ctx.clone()) {
            Ok(a) => a,
            Err(e) => {
                shared.set_state("error");
                shared.set_error(&e);
                let _ = tx.send(Event::Error(e));
                if !sleep_interruptible(backoff(attempt), &shutdown, &heartbeat, &shared) {
                    break;
                }
                attempt = attempt.saturating_add(1);
                continue;
            }
        };
        let progress = || shared.video_total.load(Ordering::Relaxed) + shared.audio_total.load(Ordering::Relaxed);
        let mut last_total = progress();
        let mut last_change = Instant::now();
        let mut seen = false;
        let mut prev = (0.0, Instant::now());
        let mut problem: Option<String> = None;
        loop {
            heartbeat.fetch_add(1, Ordering::Relaxed);
            if shutdown.load(Ordering::Relaxed) || shared.reconfigure.load(Ordering::Relaxed) {
                break;
            }
            if let Some(p) = poll_problem(&a.pipeline, Duration::from_millis(500)) {
                problem = Some(p);
                break;
            }
            let total = progress();
            if total != last_total {
                last_total = total;
                last_change = Instant::now();
                if !seen {
                    seen = true;
                    shared.set_state("playing");
                    shared.set_error("");
                    attempt = 0;
                }
            } else if seen && last_change.elapsed() > Duration::from_secs(8) {
                problem = Some(format!("keine Daten seit {} s", last_change.elapsed().as_secs()));
                break;
            }
            if std::env::var("OMP_CONTRIB_DEBUG").is_ok() { eprintln!("A-Zustand {:?} video={}", a.pipeline.state(gst::ClockTime::from_mseconds(10)), shared.video_total.load(Ordering::Relaxed)); }
            let mut st = shared.stats.lock().expect("lock poisoned");
            read_stats(&a.srt, &mut prev, &mut st);
        }
        a.bridge.shutdown();
        let _ = a.pipeline.set_state(gst::State::Null);
        drop(a);
        let Some(problem) = problem else {
            if shared.reconfigure.load(Ordering::Relaxed) {
                attempt = 0;
                continue;
            }
            break;
        };
        shared.reconnects.fetch_add(1, Ordering::Relaxed);
        shared.set_error(&problem);
        shared.set_state(if seen { "reconnecting" } else { "error" });
        eprintln!("omp-contribution: {problem} — verbinde in {} s neu", backoff(attempt).as_secs());
        let _ = tx.send(Event::Error(format!("{problem} — verbinde neu")));
        if !sleep_interruptible(backoff(attempt), &shutdown, &heartbeat, &shared) {
            break;
        }
        attempt = attempt.saturating_add(1);
    }
}

fn sleep_interruptible(d: Duration, shutdown: &AtomicBool, heartbeat: &AtomicU64, shared: &Shared) -> bool {
    let end = Instant::now() + d;
    while Instant::now() < end {
        if shutdown.load(Ordering::Relaxed) {
            return false;
        }
        if shared.reconfigure.load(Ordering::Relaxed) {
            return true;
        }
        heartbeat.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(250));
    }
    !shutdown.load(Ordering::Relaxed)
}
