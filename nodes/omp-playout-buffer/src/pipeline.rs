//! GStreamer-Teil von `omp-playout-buffer` (Kapitel 39.3).
//!
//! **Zwei getrennte Seiten, die sich nie gegenseitig neu aufbauen:**
//!
//! * *Ausgang* (dauerhaft, wird nie neu gebaut): `appsrc → MxlVideoOutput` und `appsrc → MxlAudioOutput`
//!   im festen Zielformat. Ein Ausgabe-Thread (`output_loop`) taktet auf eigener Uhr ein Bild je Bildtakt
//!   und einen 10-ms-Tonblock je Tonschritt aus [`Playout`] — auch wenn gar kein Eingang verbunden ist
//!   (dann Schwarz + Stille), damit der nachgelagerte Sink nie abreißt.
//! * *Eingänge* (je Video und Audio eine eigene kleine Pipeline, dürfen jederzeit sterben/neu entstehen):
//!   `MxlVideoInput → videoscale → videoconvert → videorate → v210-Zielformat → appsink` bzw.
//!   `MxlAudioInput → audioconvert → audioresample → F32LE-Zielformat → appsink`. Der `appsink`-Callback
//!   kopiert jedes Bild/jeden Block in einen eigenen Speicher (keine Pool-Buffer des Eingangs werden
//!   gehalten) und legt es mit seiner **Ursprungszeit** (MXL-TAI-Meta, sonst Ankunftszeit) in den Ring.
//!
//! Quellwechsel/Absturz des Vorgängers ändern damit nichts am Ausgang; ein Wächter baut einen Eingang neu
//! auf, wenn er trotz Verbindung länger als `STALL_MS` nichts liefert (Neustart des Vorgängers).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext, MxlVideoInput, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use crate::buffer::{self, HoldMode, Playout, VideoOut};

/// Tonblockgröße des Ausgangs (wie `MxlAudioOutput`: 10 ms).
const AUDIO_BLOCK_MS: u64 = 10;
/// Ohne Daten trotz Verbindung länger als dies → Eingang neu aufbauen.
const STALL_MS: u64 = 3000;
/// Wartezeit zwischen Wiederholversuchen bei fehlgeschlagenem Aufbau.
const RETRY_MS: u64 = 2000;
/// Obergrenze der wachsenden Wartezeit zwischen Neuaufbauten eines toten Eingangs.
const RETRY_MAX_MS: u64 = 4_000;

pub struct Config {
    pub domain: String,
    pub label: String,
    pub video_flow_id: String,
    pub audio_flow_id: String,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub sample_rate: u32,
    pub channels: u32,
    pub buffer_ms: u64,
    pub resume_ms: Option<u64>,
    pub hold_mode: HoldMode,
    /// Wiederauffüll-Rate in ‰ (0 = aus, Standard 10 = 1 %).
    pub refill_permille: u32,
    /// Harte Obergrenze des Bild-Rings in MiB (Schutz gegen versehentlich riesige Zieltiefen).
    pub max_video_mib: u64,
}

pub enum Event {
    Error(String),
}

enum Command {
    ConnectVideo(String),
    DisconnectVideo,
    ConnectAudio(String),
    DisconnectAudio,
}

/// Bildpuffer: referenzgezählt, damit „Bild halten“ nichts kopiert.
#[derive(Clone)]
pub struct Frame(Arc<Vec<u8>>);

impl AsRef<[u8]> for Frame {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

#[derive(Default)]
struct Counters {
    video_in: AtomicU64,
    audio_in: AtomicU64,
    video_ts_origin: AtomicU64,
    video_ts_arrival: AtomicU64,
    audio_ts_origin: AtomicU64,
    audio_ts_arrival: AtomicU64,
    video_out: AtomicU64,
    audio_out: AtomicU64,
    rebuilds_video: AtomicU64,
    rebuilds_audio: AtomicU64,
    /// Millisekunden seit `start` des letzten Eingangsbildes/-blocks (0 = noch nie).
    last_video_in_ms: AtomicU64,
    last_audio_in_ms: AtomicU64,
}

struct Shared {
    context: Arc<MxlContext>,
    playout: Mutex<Playout<Frame>>,
    counters: Counters,
    start: Instant,
    black: Frame,
    frame_bytes: usize,
    period_ns: u64,
    fps_num: u32,
    fps_den: u32,
    sample_rate: u32,
    channels: u32,
    /// Basis-Zieltiefe (`bufferMs`) und Delay-Ausgleich (Bilder) — zusammen ergibt sich die wirksame Tiefe.
    buffer_ms: AtomicU64,
    delay_frames: AtomicU64,
    max_video_bytes_hard: usize,
    video_selected: AtomicBool,
    audio_selected: AtomicBool,
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64 + 1
    }

    /// Wirksame Zieltiefe in ns: `bufferMs` + zugewiesener Delay-Ausgleich.
    fn effective_target_ns(&self) -> u64 {
        self.buffer_ms.load(Ordering::Relaxed) * 1_000_000 + self.delay_frames.load(Ordering::Relaxed) * self.period_ns
    }

    /// Speichergrenzen aus der Zieltiefe: Bild-Ring = 1,5 × Tiefe + 2 Bilder (mind.), Ton ebenso.
    fn limits_for(&self, target_ns: u64) -> (usize, usize) {
        let frames = (target_ns as f64 * 1.5 / self.period_ns as f64).ceil() as usize + 2;
        let video = (frames * self.frame_bytes).min(self.max_video_bytes_hard);
        let audio_ms = (target_ns / 1_000_000) * 3 / 2 + 200;
        let audio = (audio_ms as usize * self.sample_rate as usize / 1000) * self.channels as usize * 4;
        (video.max(self.frame_bytes * 2), audio)
    }

    fn apply_target(&self) {
        let target = self.effective_target_ns();
        let (v, a) = self.limits_for(target);
        let mut p = self.playout.lock().expect("lock poisoned");
        p.set_target(target);
        p.set_limits(v, a);
    }
}

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub state: &'static str,
    pub video_frames: usize,
    pub video_fill_ms: u64,
    pub audio_fill_ms: u64,
    pub front_age_ms: u64,
    pub buffer_bytes: usize,
    pub max_bytes: usize,
    pub target_ms: u64,
    pub dropped_video: u64,
    pub dropped_audio_bytes: u64,
    pub trimmed_video: u64,
    pub underruns: u64,
    pub resumes: u64,
    pub hold_ticks: u64,
    pub silent_blocks: u64,
    pub audio_seeks: u64,
    pub audio_gap_samples: u64,
    pub audio_skipped_samples: u64,
    pub refilling: bool,
    pub refill_frames: u64,
    pub refill_samples: u64,
    pub video_ts_jumps: u64,
    pub audio_ts_jumps: u64,
    pub video_in: u64,
    pub audio_in: u64,
    pub video_out: u64,
    pub audio_out: u64,
    pub video_origin_ts_pct: u64,
    pub audio_origin_ts_pct: u64,
    pub rebuilds_video: u64,
    pub rebuilds_audio: u64,
    pub video_input_age_ms: u64,
    pub audio_input_age_ms: u64,
}

/// Griff für den async Node-Lifecycle.
#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    shared: Arc<Shared>,
}

impl PipelineHandle {
    pub fn connect_video(&self, flow_id: String) {
        self.shared.video_selected.store(true, Ordering::Relaxed);
        self.sync_connected();
        let _ = self.commands.send(Command::ConnectVideo(flow_id));
    }

    pub fn disconnect_video(&self) {
        self.shared.video_selected.store(false, Ordering::Relaxed);
        self.sync_connected();
        let _ = self.commands.send(Command::DisconnectVideo);
    }

    pub fn connect_audio(&self, flow_id: String) {
        self.shared.audio_selected.store(true, Ordering::Relaxed);
        self.sync_connected();
        let _ = self.commands.send(Command::ConnectAudio(flow_id));
    }

    pub fn disconnect_audio(&self) {
        self.shared.audio_selected.store(false, Ordering::Relaxed);
        self.sync_connected();
        let _ = self.commands.send(Command::DisconnectAudio);
    }

    fn sync_connected(&self) {
        let s = &self.shared;
        s.playout
            .lock()
            .expect("lock poisoned")
            .set_connected(s.video_selected.load(Ordering::Relaxed), s.audio_selected.load(Ordering::Relaxed));
    }

    pub fn buffer_ms(&self) -> u64 {
        self.shared.buffer_ms.load(Ordering::Relaxed)
    }

    pub fn set_buffer_ms(&self, ms: u64) {
        self.shared.buffer_ms.store(ms, Ordering::Relaxed);
        self.shared.apply_target();
    }

    /// `setOutputDelay` (D8): der Ausgleich wird zur Zieltiefe addiert — Bild UND Ton verschieben sich
    /// gemeinsam, ohne dass der MXL-Schreibpfad (nur Video-Delay) berührt wird.
    pub fn set_output_delay(&self, frames: u64) {
        self.shared.delay_frames.store(frames, Ordering::Relaxed);
        self.shared.apply_target();
    }

    pub fn set_resume_ms(&self, ms: u64) {
        self.shared.playout.lock().expect("lock poisoned").set_resume(ms * 1_000_000);
    }

    pub fn resume_ms(&self) -> u64 {
        self.shared.playout.lock().expect("lock poisoned").config().resume_ns / 1_000_000
    }

    pub fn set_refill_permille(&self, permille: u32) {
        self.shared.playout.lock().expect("lock poisoned").set_refill_ppm(permille.min(100) * 1000);
    }

    pub fn refill_permille(&self) -> u32 {
        self.shared.playout.lock().expect("lock poisoned").config().refill_ppm / 1000
    }

    pub fn set_hold_mode(&self, mode: HoldMode) {
        self.shared.playout.lock().expect("lock poisoned").set_hold_mode(mode);
    }

    pub fn hold_mode(&self) -> HoldMode {
        self.shared.playout.lock().expect("lock poisoned").config().hold_mode
    }

    pub fn delay_frames(&self) -> u64 {
        self.shared.delay_frames.load(Ordering::Relaxed)
    }

    /// "media-ready": der Ausgang schreibt immer (Schwarz/Stille, solange nichts anliegt).
    pub fn media_ready(&self) -> bool {
        self.shared.counters.video_out.load(Ordering::Relaxed) > 0
    }

    pub fn snapshot(&self) -> Snapshot {
        let s = &self.shared;
        let now = s.context.now_ns();
        let p = s.playout.lock().expect("lock poisoned");
        let c = &s.counters;
        let pct = |origin: u64, arrival: u64| (origin * 100).checked_div(origin + arrival).unwrap_or(0);
        let age = |last: u64| {
            if last == 0 { 0 } else { s.now_ms().saturating_sub(last) }
        };
        Snapshot {
            state: p.state().as_str(),
            video_frames: p.video_len(),
            video_fill_ms: p.video_fill_ms(),
            audio_fill_ms: p.audio_fill_ms(),
            front_age_ms: p.front_age_ms(now),
            buffer_bytes: p.video_bytes() + p.audio_bytes(),
            max_bytes: p.config().max_video_bytes + p.config().max_audio_bytes,
            target_ms: p.config().target_ns / 1_000_000,
            dropped_video: p.stats.dropped_video,
            dropped_audio_bytes: p.stats.dropped_audio_bytes,
            trimmed_video: p.stats.trimmed_video,
            underruns: p.stats.underruns,
            resumes: p.stats.resumes,
            hold_ticks: p.stats.hold_ticks,
            silent_blocks: p.stats.silent_blocks,
            audio_seeks: p.stats.audio_seeks,
            audio_gap_samples: p.stats.audio_gap_samples,
            audio_skipped_samples: p.stats.audio_skipped_samples,
            refilling: p.refilling(),
            refill_frames: p.stats.refill_frames,
            refill_samples: p.stats.refill_samples,
            video_ts_jumps: p.stats.video_ts_jumps,
            audio_ts_jumps: p.stats.audio_ts_jumps,
            video_in: c.video_in.load(Ordering::Relaxed),
            audio_in: c.audio_in.load(Ordering::Relaxed),
            video_out: c.video_out.load(Ordering::Relaxed),
            audio_out: c.audio_out.load(Ordering::Relaxed),
            video_origin_ts_pct: pct(c.video_ts_origin.load(Ordering::Relaxed), c.video_ts_arrival.load(Ordering::Relaxed)),
            audio_origin_ts_pct: pct(c.audio_ts_origin.load(Ordering::Relaxed), c.audio_ts_arrival.load(Ordering::Relaxed)),
            rebuilds_video: c.rebuilds_video.load(Ordering::Relaxed),
            rebuilds_audio: c.rebuilds_audio.load(Ordering::Relaxed),
            video_input_age_ms: age(c.last_video_in_ms.load(Ordering::Relaxed)),
            audio_input_age_ms: age(c.last_audio_in_ms.load(Ordering::Relaxed)),
        }
    }
}

// ---- Eingänge ------------------------------------------------------------------------------------

struct InVideo {
    pipeline: gst::Pipeline,
    _input: MxlVideoInput,
}

impl Drop for InVideo {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

struct InAudio {
    pipeline: gst::Pipeline,
    _input: MxlAudioInput,
}

impl Drop for InAudio {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn origin_ts(buffer: &gst::BufferRef, reference: &gst::Caps) -> Option<u64> {
    let meta = buffer.meta::<gst::ReferenceTimestampMeta>()?;
    if meta.reference() != reference.as_ref() {
        return None;
    }
    Some(meta.timestamp().nseconds())
}

fn build_video_input(shared: &Arc<Shared>, cfg: &Config, flow_id: &str) -> Result<InVideo, String> {
    let pipeline = gst::Pipeline::new();
    let input = MxlVideoInput::new_unsynced(&pipeline, shared.context.clone(), flow_id)?;
    let mk = |name: &str| gst::ElementFactory::make(name).build().map_err(|e| format!("{name}: {e}"));
    let scale = mk("videoscale")?;
    let convert = mk("videoconvert")?;
    let rate = gst::ElementFactory::make("videorate")
        .property("max-duplication-time", 1_000_000_000u64)
        .build()
        .map_err(|e| format!("videorate: {e}"))?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("format", "v210")
                .field("width", cfg.width as i32)
                .field("height", cfg.height as i32)
                .field("framerate", gst::Fraction::new(cfg.fps_num as i32, cfg.fps_den as i32))
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter: {e}"))?;
    let sink = gst_app::AppSink::builder().sync(false).max_buffers(4).drop(true).build();
    sink.set_property("async", false);
    pipeline
        .add_many([&scale, &convert, &rate, &caps, sink.upcast_ref::<gst::Element>()])
        .map_err(|e| format!("add: {e}"))?;
    gst::Element::link_many([&input.tail, &scale, &convert, &rate, &caps, sink.upcast_ref::<gst::Element>()])
        .map_err(|e| format!("link: {e}"))?;

    let reference = omp_mediaio::mxl::tai_reference_caps();
    let sh = shared.clone();
    sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let Some(buffer) = sample.buffer() else { return Ok(gst::FlowSuccess::Ok) };
                let Ok(map) = buffer.map_readable() else { return Ok(gst::FlowSuccess::Ok) };
                let ts = match origin_ts(buffer, &reference) {
                    Some(t) => {
                        sh.counters.video_ts_origin.fetch_add(1, Ordering::Relaxed);
                        t
                    }
                    None => {
                        sh.counters.video_ts_arrival.fetch_add(1, Ordering::Relaxed);
                        sh.context.now_ns()
                    }
                };
                let data = Frame(Arc::new(map.as_slice().to_vec()));
                let len = data.0.len();
                sh.counters.video_in.fetch_add(1, Ordering::Relaxed);
                sh.counters.last_video_in_ms.store(sh.now_ms(), Ordering::Relaxed);
                sh.playout.lock().expect("lock poisoned").push_video(ts, len, data);
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    input.activate()?;
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("playing: {e}"))?;
    Ok(InVideo { pipeline, _input: input })
}

fn build_audio_input(shared: &Arc<Shared>, cfg: &Config, flow_id: &str) -> Result<InAudio, String> {
    let pipeline = gst::Pipeline::new();
    let input = MxlAudioInput::new_unsynced(&pipeline, shared.context.clone(), flow_id)?;
    let mk = |name: &str| gst::ElementFactory::make(name).build().map_err(|e| format!("{name}: {e}"));
    let convert = mk("audioconvert")?;
    let resample = mk("audioresample")?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("rate", cfg.sample_rate as i32)
                .field("channels", cfg.channels as i32)
                .field("layout", "interleaved")
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter: {e}"))?;
    let sink = gst_app::AppSink::builder().sync(false).max_buffers(200).drop(true).build();
    sink.set_property("async", false);
    pipeline
        .add_many([&convert, &resample, &caps, sink.upcast_ref::<gst::Element>()])
        .map_err(|e| format!("add: {e}"))?;
    gst::Element::link_many([&input.tail, &convert, &resample, &caps, sink.upcast_ref::<gst::Element>()])
        .map_err(|e| format!("link: {e}"))?;

    let reference = omp_mediaio::mxl::tai_reference_caps();
    let sh = shared.clone();
    let rate = cfg.sample_rate as u64;
    let bpf = cfg.channels as u64 * 4;
    sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let Some(buffer) = sample.buffer() else { return Ok(gst::FlowSuccess::Ok) };
                let Ok(map) = buffer.map_readable() else { return Ok(gst::FlowSuccess::Ok) };
                let bytes = map.as_slice().to_vec();
                let (ts, exact) = match origin_ts(buffer, &reference) {
                    Some(t) => {
                        sh.counters.audio_ts_origin.fetch_add(1, Ordering::Relaxed);
                        (t, true)
                    }
                    None => {
                        sh.counters.audio_ts_arrival.fetch_add(1, Ordering::Relaxed);
                        // Ankunft = Ende des Blocks → Beginn = Ankunft − Dauer.
                        let dur = bytes.len() as u64 / bpf * 1_000_000_000 / rate;
                        (sh.context.now_ns().saturating_sub(dur), false)
                    }
                };
                sh.counters.audio_in.fetch_add(1, Ordering::Relaxed);
                sh.counters.last_audio_in_ms.store(sh.now_ms(), Ordering::Relaxed);
                sh.playout.lock().expect("lock poisoned").push_audio(ts, exact, bytes);
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    input.activate()?;
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("playing: {e}"))?;
    Ok(InAudio { pipeline, _input: input })
}

// ---- Ausgang -------------------------------------------------------------------------------------

struct OutputSide {
    pipeline: gst::Pipeline,
    video_src: gst_app::AppSrc,
    audio_src: gst_app::AppSrc,
    _video_out: MxlVideoOutput,
    _audio_out: MxlAudioOutput,
}

impl Drop for OutputSide {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn build_output(shared: &Arc<Shared>, cfg: &Config) -> Result<OutputSide, String> {
    let pipeline = gst::Pipeline::new();
    let video_src = gst_app::AppSrc::builder()
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
    video_src.set_property_from_str("leaky-type", "downstream");
    video_src.set_property("max-buffers", 8u64);
    let mut audio_caps = gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("rate", cfg.sample_rate as i32)
        .field("channels", cfg.channels as i32)
        .field("layout", "interleaved");
    if cfg.channels > 2 {
        audio_caps = audio_caps.field("channel-mask", gst::Bitmask::new(0));
    }
    let audio_src = gst_app::AppSrc::builder()
        .is_live(true)
        .format(gst::Format::Time)
        .do_timestamp(false)
        .block(false)
        .caps(&audio_caps.build())
        .build();
    audio_src.set_property_from_str("leaky-type", "downstream");
    audio_src.set_property("max-buffers", 100u64);
    pipeline
        .add_many([video_src.upcast_ref::<gst::Element>(), audio_src.upcast_ref::<gst::Element>()])
        .map_err(|e| format!("add appsrc: {e}"))?;

    let video_out = MxlVideoOutput::new(
        &pipeline,
        video_src.upcast_ref::<gst::Element>(),
        shared.context.clone(),
        &cfg.video_flow_id,
        &cfg.label,
        cfg.width,
        cfg.height,
        cfg.fps_num,
        cfg.fps_den,
        Arc::new(AtomicU64::new(0)),
    )
    .map_err(|e| format!("MxlVideoOutput: {e}"))?;
    video_out.set_active(true);
    let audio_out = MxlAudioOutput::new(
        &pipeline,
        audio_src.upcast_ref::<gst::Element>(),
        shared.context.clone(),
        &cfg.audio_flow_id,
        &cfg.label,
        cfg.sample_rate,
        cfg.channels,
    )
    .map_err(|e| format!("MxlAudioOutput: {e}"))?;
    audio_out.set_active(true);
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("playing: {e}"))?;
    Ok(OutputSide { pipeline, video_src, audio_src, _video_out: video_out, _audio_out: audio_out })
}

/// Hängt die Ursprungszeit an einen Ausgabepuffer: der MXL-Schreibpfad nimmt sie als Schreib-Index
/// (`origin_index_from_buffer`) — Bild und Ton landen damit exakt auf dem MXL-Raster, unabhängig von
/// Thread-Verzug und Kettenlatenz der Ausgabeelemente.
fn stamp_origin(buf: &mut gst::Buffer, ts_ns: u64, reference: &gst::Caps) {
    if let Some(b) = buf.get_mut() {
        gst::ReferenceTimestampMeta::add(b, reference, gst::ClockTime::from_nseconds(ts_ns), gst::ClockTime::NONE);
    }
}

/// Ausgabe-Takt: ein Bild je Bildraster-Index, ein Block je 10 ms — beides **auf dem MXL-Raster** (Index →
/// TAI-Zeit), nie vom Eingang getrieben. Die Tick-Zeit (nicht die Wanduhr beim Aufwachen) geht in die
/// Pufferlogik und als Ursprungszeit an den Schreibpfad, sodass Bild und Ton exakt gleich zeitlich liegen.
fn output_loop(shared: Arc<Shared>, out: OutputSide, shutdown: Arc<AtomicBool>, heartbeat: Arc<AtomicU64>) {
    let ctx = shared.context.clone();
    let (fps_num, fps_den) = (shared.fps_num, shared.fps_den);
    let rate = shared.sample_rate;
    let block_samples = (rate as u64 * AUDIO_BLOCK_MS / 1000).max(1);
    let reference = omp_mediaio::mxl::tai_reference_caps();
    let now0 = ctx.now_ns();
    // Erste Takte kurz in der Zukunft, Audio auf Blockgrenze (Vielfaches von `block_samples`).
    let mut kv = ctx.ns_to_index(now0 + 100_000_000, fps_num, fps_den).unwrap_or(0) + 1;
    let mut ka = ctx.ns_to_index(now0 + 100_000_000, rate, 1).unwrap_or(0).div_ceil(block_samples) * block_samples;
    let tv0 = ctx.index_to_ns(kv, fps_num, fps_den).unwrap_or(now0);
    // Gemeinsame Startzeit auf der Pipeline-Uhr (Laufzeit), damit Bild und Ton dieselbe Zeitleiste teilen;
    // PTS = Laufzeit + (Tick-Zeit − erste Tick-Zeit) → streng monoton, lückenlos.
    let start_running = out
        .pipeline
        .clock()
        .zip(out.pipeline.base_time())
        .map(|(c, b)| c.time().saturating_sub(b))
        .unwrap_or(gst::ClockTime::ZERO);
    let pts_of = |ts: u64| start_running + gst::ClockTime::from_nseconds(ts.saturating_sub(tv0));
    let mut tv = ctx.index_to_ns(kv, fps_num, fps_den).unwrap_or(now0);
    let mut ta = ctx.index_to_ns(ka, rate, 1).unwrap_or(now0);
    while !shutdown.load(Ordering::Relaxed) {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        let now = ctx.now_ns();
        if now >= tv {
            let decision = shared.playout.lock().expect("lock poisoned").tick_video(tv);
            let frame = match decision {
                VideoOut::Frame(f) | VideoOut::Repeat(f) => f,
                VideoOut::Black => shared.black.clone(),
            };
            let mut buf = gst::Buffer::from_slice(frame);
            if let Some(b) = buf.get_mut() {
                b.set_pts(pts_of(tv));
                b.set_duration(gst::ClockTime::from_nseconds(shared.period_ns));
            }
            stamp_origin(&mut buf, tv, &reference);
            if out.video_src.push_buffer(buf).is_ok() {
                shared.counters.video_out.fetch_add(1, Ordering::Relaxed);
            }
            kv += 1;
            // Bei längerem Stillstand (Prozess angehalten) neu aufsetzen statt aufzuholen.
            if now > tv + shared.period_ns * 5 {
                kv = ctx.ns_to_index(now, fps_num, fps_den).unwrap_or(kv) + 1;
            }
            tv = ctx.index_to_ns(kv, fps_num, fps_den).unwrap_or(tv + shared.period_ns);
        }
        if now >= ta {
            let (bytes, _silent) = shared.playout.lock().expect("lock poisoned").tick_audio(ta, block_samples as usize);
            let mut buf = gst::Buffer::from_mut_slice(bytes);
            if let Some(b) = buf.get_mut() {
                b.set_pts(pts_of(ta));
                b.set_duration(gst::ClockTime::from_mseconds(AUDIO_BLOCK_MS));
            }
            stamp_origin(&mut buf, ta, &reference);
            if out.audio_src.push_buffer(buf).is_ok() {
                shared.counters.audio_out.fetch_add(1, Ordering::Relaxed);
            }
            ka += block_samples;
            if now > ta + 20 * AUDIO_BLOCK_MS * 1_000_000 {
                ka = ctx.ns_to_index(now, rate, 1).unwrap_or(ka).div_ceil(block_samples) * block_samples;
            }
            ta = ctx.index_to_ns(ka, rate, 1).unwrap_or(ta + AUDIO_BLOCK_MS * 1_000_000);
        }
        let next = tv.min(ta);
        let now = ctx.now_ns();
        if next > now {
            std::thread::sleep(Duration::from_nanos((next - now).min(5_000_000)));
        }
    }
    let _ = out.video_src.end_of_stream();
    let _ = out.audio_src.end_of_stream();
}

/// Läuft auf einem eigenen Thread: baut den Ausgang, startet den Takt-Thread und verwaltet die Eingänge.
pub fn run(
    config: Config,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
    heartbeat: Arc<AtomicU64>,
    output_heartbeat: Arc<AtomicU64>,
) {
    if let Err(e) = gst::init() {
        let msg = format!("gst init failed: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }
    let context = match MxlContext::new(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };
    let period_ns = (1_000_000_000u128 * config.fps_den as u128 / config.fps_num.max(1) as u128) as u64;
    let frame_bytes = buffer::v210_frame_bytes(config.width, config.height);
    let target_ns = config.buffer_ms * 1_000_000;
    let hard = (config.max_video_mib as usize).saturating_mul(1024 * 1024);
    let pcfg = buffer::Config {
        sample_rate: config.sample_rate,
        channels: config.channels,
        target_ns,
        resume_ns: config.resume_ms.map(|m| m * 1_000_000).unwrap_or(target_ns),
        slack_ns: (target_ns / 10).max(200_000_000),
        hold_mode: config.hold_mode,
        max_video_bytes: frame_bytes * 4,
        max_audio_bytes: 1 << 20,
        refill_ppm: config.refill_permille.min(100) * 1000,
    };
    let shared = Arc::new(Shared {
        context: context.clone(),
        playout: Mutex::new(Playout::new(pcfg, period_ns)),
        counters: Counters::default(),
        start: Instant::now(),
        black: Frame(Arc::new(buffer::black_v210(config.width, config.height))),
        frame_bytes,
        period_ns,
        fps_num: config.fps_num,
        fps_den: config.fps_den,
        sample_rate: config.sample_rate,
        channels: config.channels,
        buffer_ms: AtomicU64::new(config.buffer_ms),
        delay_frames: AtomicU64::new(0),
        max_video_bytes_hard: hard,
        video_selected: AtomicBool::new(false),
        audio_selected: AtomicBool::new(false),
    });
    shared.apply_target();

    let out = match build_output(&shared, &config) {
        Ok(o) => o,
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };
    let out_shared = shared.clone();
    let out_shutdown = shutdown.clone();
    let out_thread = std::thread::spawn(move || output_loop(out_shared, out, out_shutdown, output_heartbeat));

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let _ = ready.send(Ok(PipelineHandle { commands: commands_tx, shared: shared.clone() }));

    let mut video: Option<InVideo> = None;
    let mut audio: Option<InAudio> = None;
    let mut want_video: Option<String> = None;
    let mut want_audio: Option<String> = None;
    let mut last_try_v = Instant::now() - Duration::from_millis(RETRY_MS);
    let mut last_try_a = Instant::now() - Duration::from_millis(RETRY_MS);
    // Wartezeit bis zum nächsten Neuaufbau eines still gewordenen Eingangs: verdoppelt sich bei jedem erfolglosen
    // Versuch (bis `RETRY_MAX_MS`) und springt zurück, sobald wieder Daten kommen — ein dauerhaft toter Vorgänger
    // soll nicht alle 3 s eine Pipeline bauen und abreißen.
    let (mut gap_v, mut gap_a) = (RETRY_MS, RETRY_MS);
    let (mut seen_v, mut seen_a) = (0u64, 0u64);
    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Command::ConnectVideo(f)) => {
                video = None;
                want_video = Some(f);
                gap_v = RETRY_MS;
                last_try_v = Instant::now() - Duration::from_millis(gap_v);
            }
            Ok(Command::DisconnectVideo) => {
                video = None;
                want_video = None;
            }
            Ok(Command::ConnectAudio(f)) => {
                audio = None;
                want_audio = Some(f);
                gap_a = RETRY_MS;
                last_try_a = Instant::now() - Duration::from_millis(gap_a);
            }
            Ok(Command::DisconnectAudio) => {
                audio = None;
                want_audio = None;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        // Wächter: verbunden, aber seit STALL_MS nichts gekommen → Eingang neu aufbauen.
        let c = &shared.counters;
        let stalled = |last: u64, since: Instant| {
            // Stille = Zeit seit den letzten Daten, höchstens aber seit dem letzten Neuaufbau (`since`): ein frisch
            // gebauter Eingang bekommt die volle Frist, statt wegen alter Zeitstempel sofort wieder zu fallen.
            let since_ms = since.elapsed().as_millis() as u64;
            let quiet = if last == 0 { since_ms } else { shared.now_ms().saturating_sub(last).min(since_ms) };
            quiet > STALL_MS
        };
        let (lv, la) = (c.last_video_in_ms.load(Ordering::Relaxed), c.last_audio_in_ms.load(Ordering::Relaxed));
        if lv != seen_v {
            seen_v = lv;
            gap_v = RETRY_MS;
        }
        if la != seen_a {
            seen_a = la;
            gap_a = RETRY_MS;
        }
        if video.is_some() && want_video.is_some() && stalled(lv, last_try_v) {
            video = None;
            c.rebuilds_video.fetch_add(1, Ordering::Relaxed);
            gap_v = (gap_v * 2).min(RETRY_MAX_MS);
            last_try_v = Instant::now() - Duration::from_millis(0);
        }
        if audio.is_some() && want_audio.is_some() && stalled(la, last_try_a) {
            audio = None;
            c.rebuilds_audio.fetch_add(1, Ordering::Relaxed);
            gap_a = (gap_a * 2).min(RETRY_MAX_MS);
            last_try_a = Instant::now() - Duration::from_millis(0);
        }
        if video.is_none()
            && let Some(f) = want_video.clone()
            && last_try_v.elapsed() >= Duration::from_millis(gap_v)
        {
            last_try_v = Instant::now();
            match build_video_input(&shared, &config, &f) {
                Ok(v) => video = Some(v),
                Err(e) => {
                    gap_v = (gap_v * 2).min(RETRY_MAX_MS);
                    let _ = tx.send(Event::Error(format!("video input {f}: {e}")));
                }
            }
        }
        if audio.is_none()
            && let Some(f) = want_audio.clone()
            && last_try_a.elapsed() >= Duration::from_millis(gap_a)
        {
            last_try_a = Instant::now();
            match build_audio_input(&shared, &config, &f) {
                Ok(a) => audio = Some(a),
                Err(e) => {
                    gap_a = (gap_a * 2).min(RETRY_MAX_MS);
                    let _ = tx.send(Event::Error(format!("audio input {f}: {e}")));
                }
            }
        }
    }
    drop(video);
    drop(audio);
    shutdown.store(true, Ordering::Relaxed);
    let _ = out_thread.join();
}
