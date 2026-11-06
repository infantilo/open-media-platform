//! Bildseite des Havarieumschalters (Fernsehen): je Quelle ein Speicher mit dem **letzten Bild** im Zielformat (v210) samt Analyse
//! (Standbild = unveränderte Bilder, Schwarz = zu dunkel), ein Standbild aus einer Datei und ein dauerhafter MXL-Videoausgang.
//! Muster: `omp-playout-buffer/src/pipeline.rs` (Ausgang auf dem MXL-Raster mit Ursprungszeit). Der Umschalter puffert nichts: zu jedem Bildtakt
//! geht das letzte Bild der aktiven Quelle hinaus; bleibt es aus, wird das letzte Bild wiederholt (Standbild — das erkennt der Wächter).

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput, MxlVideoOutput};

use crate::failover::N;

/// Analysebild: klein, aber groß genug, dass eine laufende Uhr in einer Ecke das Bild verändert.
const AN_W: i32 = 160;
const AN_H: i32 = 90;
/// Ein Pixel gilt als „hell“, wenn seine Helligkeit (0–255) mindestens so hoch ist (Schwarzwert 16 bei begrenztem Bereich).
pub const BRIGHT_LUMA: u8 = 32;
/// Ein Bild gilt als **schwarz**, wenn höchstens so viele der 160×90 Analysepixel hell sind (≈ 0,1 %). Dunkle Inhalte (Nachtszenen, ein kleiner Ball auf
/// schwarzem Grund) bleiben damit „Bild“; ein Schwarzbild mit eingeblendetem Logo gilt ebenfalls als Bild (bekannte Grenze).
pub const BLACK_MAX_BRIGHT_PIXELS: usize = 14;

#[derive(Clone, Copy, Debug)]
pub struct VideoCfg {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
}

impl VideoCfg {
    pub fn period_ns(&self) -> u64 {
        1_000_000_000u64 * self.fps_den as u64 / self.fps_num as u64
    }
    pub fn frame_bytes(&self) -> usize {
        (self.width as usize).div_ceil(48) * 128 * self.height as usize
    }
}

/// Bildspeicher, der als Puffer-Inhalt geteilt werden kann.
#[derive(Clone)]
pub struct Frame(pub Arc<Vec<u8>>);
impl AsRef<[u8]> for Frame {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

fn now_ms() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64 + 1
}

struct ActiveV {
    pipeline: gst::Pipeline,
    _input: Option<MxlVideoInput>,
}

impl Drop for ActiveV {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

#[derive(Default)]
pub struct VSlot {
    latest: Mutex<Option<Frame>>,
    last_ms: AtomicU64,
    /// Zahl aufeinanderfolgender Bilder, die dem Vorgänger exakt gleichen.
    same_run: AtomicU32,
    prev_hash: AtomicU64,
    black: AtomicBool,
    /// MXL-Flow bzw. Dateipfad, leer = nicht verbunden.
    source: Mutex<String>,
    active: Mutex<Option<ActiveV>>,
}

pub struct VideoIo {
    ctx: Arc<MxlContext>,
    pub cfg: VideoCfg,
    slots: Vec<VSlot>,
    out_pipeline: gst::Pipeline,
    out_src: gst_app::AppSrc,
    out_flowed: Arc<AtomicBool>,
    _writer: MxlVideoOutput,
    t0_ns: u64,
    start_running: gst::ClockTime,
    pub black: Frame,
    /// Ausgegebene Bilder und davon wiederholte (kein neues Bild der aktiven Quelle).
    pub frames_out: AtomicU64,
    pub repeats_out: AtomicU64,
}

impl Drop for VideoIo {
    fn drop(&mut self) {
        let _ = self.out_pipeline.set_state(gst::State::Null);
    }
}

fn running_time(p: &gst::Pipeline) -> gst::ClockTime {
    p.clock().zip(p.base_time()).map(|(c, b)| c.time().saturating_sub(b)).unwrap_or(gst::ClockTime::ZERO)
}

fn mk(name: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(name).build().map_err(|e| format!("{name}: {e}"))
}

/// Schwarzes v210-Bild (Y = 64, C = 512 im 10-Bit-Raum), wie `omp-playout-buffer::buffer::black_v210`.
fn black_v210(cfg: &VideoCfg) -> Vec<u8> {
    let stride = (cfg.width as usize).div_ceil(48) * 128;
    let (y, c) = (64u32, 512u32);
    let w = [c | (y << 10) | (c << 20), y | (c << 10) | (y << 20), c | (y << 10) | (c << 20), y | (c << 10) | (y << 20)];
    let mut group = [0u8; 16];
    for (i, word) in w.iter().enumerate() {
        group[i * 4..i * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    let mut row = vec![0u8; stride];
    for chunk in row.chunks_exact_mut(16) {
        chunk.copy_from_slice(&group);
    }
    let mut out = Vec::with_capacity(stride * cfg.height as usize);
    for _ in 0..cfg.height {
        out.extend_from_slice(&row);
    }
    out
}

impl VideoIo {
    pub fn new(ctx: Arc<MxlContext>, cfg: VideoCfg, out_flow_id: &str, label: &str) -> Result<Arc<Self>, String> {
        let pipeline = gst::Pipeline::new();
        let src = gst_app::AppSrc::builder()
            .is_live(true)
            .format(gst::Format::Time)
            .do_timestamp(false)
            .block(false)
            .caps(
                &gst::Caps::builder("video/x-raw")
                    .field("format", "v210")
                    .field("width", cfg.width as i32)
                    .field("height", cfg.height as i32)
                    .field("framerate", gst::Fraction::new(cfg.fps_num as i32, cfg.fps_den as i32))
                    .build(),
            )
            .build();
        src.set_property_from_str("leaky-type", "downstream");
        src.set_property("max-buffers", 8u64);
        pipeline.add(src.upcast_ref::<gst::Element>()).map_err(|e| format!("add appsrc: {e}"))?;
        let writer = MxlVideoOutput::new(&pipeline, src.upcast_ref::<gst::Element>(), ctx.clone(), out_flow_id, label, cfg.width, cfg.height, cfg.fps_num, cfg.fps_den, Arc::new(AtomicU64::new(0)))
            .map_err(|e| format!("MxlVideoOutput: {e}"))?;
        writer.set_active(true);
        let flowed = writer.flowed_handle();
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("Ausgang Bild: {e}"))?;
        let slots = (0..N).map(|_| VSlot::default()).collect();
        let black = Frame(Arc::new(black_v210(&cfg)));
        Ok(Arc::new(Self { t0_ns: ctx.now_ns(), start_running: running_time(&pipeline), ctx, cfg, slots, out_pipeline: pipeline, out_src: src, out_flowed: flowed, _writer: writer, black, frames_out: AtomicU64::new(0), repeats_out: AtomicU64::new(0) }))
    }

    pub fn out_flowed(&self) -> bool {
        self.out_flowed.load(Ordering::Relaxed)
    }

    pub fn source_of(&self, slot: usize) -> String {
        self.slots.get(slot).map(|s| s.source.lock().expect("lock poisoned").clone()).unwrap_or_default()
    }

    pub fn present(&self, slot: usize, window_ms: u64) -> bool {
        let Some(s) = self.slots.get(slot) else { return false };
        let last = s.last_ms.load(Ordering::Relaxed);
        last != 0 && now_ms().saturating_sub(last) <= window_ms
    }

    /// Standbild: mindestens `min_same` aufeinanderfolgende identische Bilder.
    pub fn frozen(&self, slot: usize, min_same: u32) -> bool {
        self.slots.get(slot).is_some_and(|s| s.same_run.load(Ordering::Relaxed) >= min_same)
    }

    pub fn is_black(&self, slot: usize) -> bool {
        self.slots.get(slot).is_some_and(|s| s.black.load(Ordering::Relaxed))
    }

    pub fn latest(&self, slot: usize) -> Option<Frame> {
        self.slots.get(slot).and_then(|s| s.latest.lock().expect("lock poisoned").clone())
    }

    /// Hängt an `upstream` (Quelle roher Bilder) die beiden Zweige: Bildspeicher im Zielformat und Analysebild.
    /// `sync = true` für Dateiquellen (Wiedergabe in Echtzeit statt so schnell wie möglich).
    pub fn attach_branches(self: &Arc<Self>, pipeline: &gst::Pipeline, slot: usize, upstream: &gst::Element, sync: bool) -> Result<(), String> {
        let cfg = self.cfg;
        let tee = mk("tee")?;
        let q1 = gst::ElementFactory::make("queue").property("max-size-buffers", 2u32).property_from_str("leaky", "downstream").build().map_err(|e| e.to_string())?;
        let scale = mk("videoscale")?;
        let conv = mk("videoconvert")?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", gst::Caps::builder("video/x-raw").field("format", "v210").field("width", cfg.width as i32).field("height", cfg.height as i32).build())
            .build()
            .map_err(|e| e.to_string())?;
        let sink = gst_app::AppSink::builder().sync(sync).max_buffers(2).drop(true).build();
        let q2 = gst::ElementFactory::make("queue").property("max-size-buffers", 2u32).property_from_str("leaky", "downstream").build().map_err(|e| e.to_string())?;
        let scale2 = mk("videoscale")?;
        let conv2 = mk("videoconvert")?;
        let caps2 = gst::ElementFactory::make("capsfilter")
            .property("caps", gst::Caps::builder("video/x-raw").field("format", "GRAY8").field("width", AN_W).field("height", AN_H).build())
            .build()
            .map_err(|e| e.to_string())?;
        let an = gst_app::AppSink::builder().sync(sync).max_buffers(2).drop(true).build();
        pipeline.add_many([&tee, &q1, &scale, &conv, &caps, sink.upcast_ref::<gst::Element>(), &q2, &scale2, &conv2, &caps2, an.upcast_ref::<gst::Element>()]).map_err(|e| format!("add: {e}"))?;
        gst::Element::link_many([upstream, &tee]).map_err(|e| format!("link tee: {e}"))?;
        gst::Element::link_many([&tee, &q1, &scale, &conv, &caps, sink.upcast_ref::<gst::Element>()]).map_err(|e| format!("link Zweig 1: {e}"))?;
        gst::Element::link_many([&tee, &q2, &scale2, &conv2, &caps2, an.upcast_ref::<gst::Element>()]).map_err(|e| format!("link Zweig 2: {e}"))?;
        for e in [&tee, &q1, &scale, &conv, &caps, sink.upcast_ref::<gst::Element>(), &q2, &scale2, &conv2, &caps2, an.upcast_ref::<gst::Element>()] {
            let _ = e.sync_state_with_parent();
        }
        let me = self.clone();
        sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |a| {
                    let sample = a.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    if let Some(buffer) = sample.buffer() {
                        if let Ok(map) = buffer.map_readable() {
                            let s = &me.slots[slot];
                            *s.latest.lock().expect("lock poisoned") = Some(Frame(Arc::new(map.as_slice().to_vec())));
                            s.last_ms.store(now_ms(), Ordering::Relaxed);
                        }
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        let me = self.clone();
        an.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |a| {
                    let sample = a.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    if let Some(buffer) = sample.buffer() {
                        if let Ok(map) = buffer.map_readable() {
                            let data = map.as_slice();
                            let s = &me.slots[slot];
                            let (mut h, mut bright) = (0xcbf2_9ce4_8422_2325u64, 0usize);
                            for &b in data {
                                h = (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3);
                                if b >= BRIGHT_LUMA {
                                    bright += 1;
                                }
                            }
                            if s.prev_hash.swap(h, Ordering::Relaxed) == h {
                                s.same_run.fetch_add(1, Ordering::Relaxed);
                            } else {
                                s.same_run.store(0, Ordering::Relaxed);
                            }
                            s.black.store(bright <= BLACK_MAX_BRIGHT_PIXELS, Ordering::Relaxed);
                        }
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        Ok(())
    }

    /// Verbindet einen MXL-Videoeingang mit einem Flow (leer = trennen) und hält die Verbindung (Wiederaufbau bei Neuentstehung des Flows).
    pub fn connect_input(self: &Arc<Self>, slot: usize, flow_id: String) {
        let me = self.clone();
        std::thread::spawn(move || {
            let s = &me.slots[slot];
            *s.source.lock().expect("lock poisoned") = flow_id.clone();
            s.last_ms.store(0, Ordering::Relaxed);
            s.same_run.store(0, Ordering::Relaxed);
            *s.latest.lock().expect("lock poisoned") = None;
            *s.active.lock().expect("lock poisoned") = None;
            if flow_id.is_empty() {
                return;
            }
            let wanted = || *s.source.lock().expect("lock poisoned") == flow_id;
            let mut warned = false;
            while wanted() {
                let have = s.active.lock().expect("lock poisoned").is_some();
                if !have {
                    match me.build_input(slot, &flow_id) {
                        Ok(a) => {
                            *s.active.lock().expect("lock poisoned") = Some(a);
                            warned = false;
                        }
                        Err(e) => {
                            if !warned {
                                eprintln!("omp-failover: Bild-Eingang {slot}: {e} — versuche weiter");
                                warned = true;
                            }
                        }
                    }
                } else {
                    let last = s.last_ms.load(Ordering::Relaxed);
                    if last != 0 && now_ms().saturating_sub(last) > 3000 {
                        *s.active.lock().expect("lock poisoned") = None; // Flow neu entstanden: Pipeline neu aufbauen
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        });
    }

    fn build_input(self: &Arc<Self>, slot: usize, flow_id: &str) -> Result<ActiveV, String> {
        let pipeline = gst::Pipeline::new();
        let input = MxlVideoInput::new_unsynced(&pipeline, self.ctx.clone(), flow_id)?;
        self.attach_branches(&pipeline, slot, &input.tail, false)?;
        input.activate()?;
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("playing: {e}"))?;
        Ok(ActiveV { pipeline, _input: Some(input) })
    }

    /// Standbild aus einer Bilddatei (leer = keins). Das Bild wird einmal in das Zielformat gebracht und dann dauerhaft als „letztes Bild“ gehalten.
    pub fn set_still(self: &Arc<Self>, path: String) {
        let s = &self.slots[crate::failover::SOURCES.iter().position(|x| *x == "still").expect("still")];
        *s.source.lock().expect("lock poisoned") = path.clone();
        s.last_ms.store(0, Ordering::Relaxed);
        *s.latest.lock().expect("lock poisoned") = None;
        s.same_run.store(0, Ordering::Relaxed);
        if path.is_empty() {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || match me.render_still(&path) {
            Ok(frame) => {
                let s = &me.slots[crate::failover::SOURCES.iter().position(|x| *x == "still").expect("still")];
                if *s.source.lock().expect("lock poisoned") != path {
                    return;
                }
                // Helligkeit des Bildes für die Schwarzprüfung nicht nötig: ein Standbild wird nie als „Standbild“ gestört gemeldet
                *s.latest.lock().expect("lock poisoned") = Some(frame);
                // Das Bild bleibt dauerhaft „frisch“: ein Wächter-Thread erneuert den Zeitstempel
                let s2 = me.clone();
                let p2 = path.clone();
                std::thread::spawn(move || {
                    let idx = crate::failover::SOURCES.iter().position(|x| *x == "still").expect("still");
                    loop {
                        let s = &s2.slots[idx];
                        if *s.source.lock().expect("lock poisoned") != p2 {
                            break;
                        }
                        s.last_ms.store(now_ms(), Ordering::Relaxed);
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                });
            }
            Err(e) => eprintln!("omp-failover: Standbild „{path}“: {e}"),
        });
    }

    fn render_still(&self, path: &str) -> Result<Frame, String> {
        let uri = gst::glib::filename_to_uri(path, None).map_err(|e| e.to_string())?;
        let pipeline = gst::Pipeline::new();
        let src = mk("uridecodebin")?;
        src.set_property("uri", uri.as_str());
        let freeze = mk("imagefreeze")?;
        let _ = freeze.set_property("num-buffers", 1i32);
        let conv = mk("videoconvert")?;
        let scale = mk("videoscale")?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", gst::Caps::builder("video/x-raw").field("format", "v210").field("width", self.cfg.width as i32).field("height", self.cfg.height as i32).build())
            .build()
            .map_err(|e| e.to_string())?;
        let sink = gst_app::AppSink::builder().sync(false).max_buffers(1).build();
        pipeline.add_many([&src, &freeze, &conv, &scale, &caps, sink.upcast_ref::<gst::Element>()]).map_err(|e| e.to_string())?;
        gst::Element::link_many([&freeze, &conv, &scale, &caps, sink.upcast_ref::<gst::Element>()]).map_err(|e| format!("link: {e}"))?;
        let fsink = freeze.static_pad("sink").ok_or("imagefreeze ohne sink")?;
        src.connect_pad_added(move |_, pad| {
            if !fsink.is_linked() {
                let _ = pad.link(&fsink);
            }
        });
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("playing: {e}"))?;
        let sample = sink.try_pull_sample(gst::ClockTime::from_seconds(10)).ok_or("kein Bild aus der Datei")?;
        let buf = sample.buffer().ok_or("kein Puffer")?;
        let data = buf.map_readable().map_err(|e| e.to_string())?.as_slice().to_vec();
        let _ = pipeline.set_state(gst::State::Null);
        if data.len() != self.cfg.frame_bytes() {
            return Err(format!("Bildgröße {} ≠ erwartet {}", data.len(), self.cfg.frame_bytes()));
        }
        Ok(Frame(Arc::new(data)))
    }

    /// Ein Bild an den Ausgang (Ursprungszeit `ts_ns` auf dem MXL-Raster).
    pub fn push_frame(&self, frame: &Frame, ts_ns: u64) {
        let mut buf = gst::Buffer::from_slice(frame.clone());
        if let Some(b) = buf.get_mut() {
            b.set_pts(self.start_running + gst::ClockTime::from_nseconds(ts_ns.saturating_sub(self.t0_ns)));
            b.set_duration(gst::ClockTime::from_nseconds(self.cfg.period_ns()));
            gst::ReferenceTimestampMeta::add(b, &omp_mediaio::mxl::tai_reference_caps(), gst::ClockTime::from_nseconds(ts_ns), gst::ClockTime::NONE);
        }
        let _ = self.out_src.push_buffer(buf);
    }

    pub fn context(&self) -> Arc<MxlContext> {
        self.ctx.clone()
    }
}
