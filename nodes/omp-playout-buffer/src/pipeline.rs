//! GStreamer-Teil von `omp-playout-buffer` (Kapitel 39.3).
//!
//! **Zwei getrennte Seiten, die sich nie gegenseitig neu aufbauen:**
//!
//! * *Ausgang* (dauerhaft, wird nie neu gebaut): je Spur eine kleine Pipeline `appsrc → MxlVideoOutput`
//!   bzw. `appsrc → MxlAudioOutput` im festen Zielformat. Ein Ausgabe-Thread (`output_loop`) taktet auf
//!   eigener Uhr ein Bild je Bildtakt und einen 10-ms-Tonblock je Tonschritt aus [`Playout`] — für **alle**
//!   Spuren im Gleichtakt, auch wenn gar kein Eingang verbunden ist (dann Schwarz + Stille), damit der
//!   nachgelagerte Sink nie abreißt. Die Spurzahl (Bild und Ton getrennt) ist zur Laufzeit änderbar
//!   ([`PipelineHandle::set_tracks`]); bestehende Spuren laufen dabei unberührt weiter.
//! * *Eingänge* (je Spur eine eigene kleine Pipeline, dürfen jederzeit sterben/neu entstehen):
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
    /// Ausgangs-Flow je Bildspur / Tonspur (Länge = Anfangs-Spurzahl, mindestens 1).
    pub video_flow_ids: Vec<String>,
    pub audio_flow_ids: Vec<String>,
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
    /// Harte Obergrenze **je Bildspur** in MiB (Schutz gegen versehentlich riesige Zieltiefen).
    pub max_video_mib: u64,
}

pub enum Event {
    Error(String),
}

enum Command {
    ConnectVideo(usize, String),
    DisconnectVideo(usize),
    ConnectAudio(usize, String),
    DisconnectAudio(usize),
    /// Neue Spurzahl: die Listen sind die Ausgangs-Flow-IDs je Spur (Länge = Spurzahl).
    Resize(Vec<String>, Vec<String>),
}

/// Bildpuffer: referenzgezählt, damit „Bild halten“ nichts kopiert.
#[derive(Clone)]
pub struct Frame(Arc<Vec<u8>>);

impl AsRef<[u8]> for Frame {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// Zähler einer Spur (Eingang) — der Eingangs-Callback hält einen eigenen `Arc`, braucht also keine Sperre.
#[derive(Default)]
struct TrackCounters {
    selected: AtomicBool,
    in_count: AtomicU64,
    ts_origin: AtomicU64,
    ts_arrival: AtomicU64,
    out_count: AtomicU64,
    rebuilds: AtomicU64,
    /// Millisekunden seit `start` des letzten Eingangsbildes/-blocks (0 = noch nie).
    last_in_ms: AtomicU64,
}

#[derive(Default)]
struct Counters {
    video_out: AtomicU64,
    audio_out: AtomicU64,
}

struct Shared {
    context: Arc<MxlContext>,
    playout: Mutex<Playout<Frame>>,
    counters: Counters,
    vtracks: Mutex<Vec<Arc<TrackCounters>>>,
    atracks: Mutex<Vec<Arc<TrackCounters>>>,
    outputs: Mutex<Outputs>,
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
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64 + 1
    }

    /// Wirksame Zieltiefe in ns: `bufferMs` + zugewiesener Delay-Ausgleich.
    fn effective_target_ns(&self) -> u64 {
        self.buffer_ms.load(Ordering::Relaxed) * 1_000_000 + self.delay_frames.load(Ordering::Relaxed) * self.period_ns
    }

    /// Speichergrenzen **je Spur** aus der Zieltiefe: Bild-Ring = 1,5 × Tiefe + 2 Bilder (mind.), Ton ebenso.
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

/// Anzeige-Werte einer Spur.
#[derive(Clone, Debug, Default)]
pub struct TrackStatus {
    pub connected: bool,
    pub fill_ms: u64,
    /// Bilder im Ring (nur Bildspur).
    pub frames: usize,
    pub bytes: usize,
    pub in_count: u64,
    pub out_count: u64,
    pub rebuilds: u64,
    pub origin_ts_pct: u64,
    pub input_age_ms: u64,
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
    /// Summen über alle Spuren.
    pub video_in: u64,
    pub audio_in: u64,
    pub video_out: u64,
    pub audio_out: u64,
    pub video_origin_ts_pct: u64,
    pub audio_origin_ts_pct: u64,
    pub rebuilds_video: u64,
    pub rebuilds_audio: u64,
    /// Älteste Stille über alle verbundenen Spuren.
    pub video_input_age_ms: u64,
    pub audio_input_age_ms: u64,
    pub video_tracks: Vec<TrackStatus>,
    pub audio_tracks: Vec<TrackStatus>,
}

/// Griff für den async Node-Lifecycle.
#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    shared: Arc<Shared>,
}

impl PipelineHandle {
    fn video_track(&self, track: usize) -> Option<Arc<TrackCounters>> {
        self.shared.vtracks.lock().expect("lock poisoned").get(track).cloned()
    }

    fn audio_track(&self, track: usize) -> Option<Arc<TrackCounters>> {
        self.shared.atracks.lock().expect("lock poisoned").get(track).cloned()
    }

    pub fn connect_video(&self, track: usize, flow_id: String) {
        let Some(c) = self.video_track(track) else { return };
        c.selected.store(true, Ordering::Relaxed);
        self.shared.playout.lock().expect("lock poisoned").set_video_connected(track, true);
        let _ = self.commands.send(Command::ConnectVideo(track, flow_id));
    }

    pub fn disconnect_video(&self, track: usize) {
        let Some(c) = self.video_track(track) else { return };
        c.selected.store(false, Ordering::Relaxed);
        self.shared.playout.lock().expect("lock poisoned").set_video_connected(track, false);
        let _ = self.commands.send(Command::DisconnectVideo(track));
    }

    pub fn connect_audio(&self, track: usize, flow_id: String) {
        let Some(c) = self.audio_track(track) else { return };
        c.selected.store(true, Ordering::Relaxed);
        self.shared.playout.lock().expect("lock poisoned").set_audio_connected(track, true);
        let _ = self.commands.send(Command::ConnectAudio(track, flow_id));
    }

    pub fn disconnect_audio(&self, track: usize) {
        let Some(c) = self.audio_track(track) else { return };
        c.selected.store(false, Ordering::Relaxed);
        self.shared.playout.lock().expect("lock poisoned").set_audio_connected(track, false);
        let _ = self.commands.send(Command::DisconnectAudio(track));
    }

    /// Spurzahl zur Laufzeit ändern: die Listen sind die Ausgangs-Flow-IDs je Spur (Länge = neue Spurzahl,
    /// mindestens je 1). Bestehende Spuren behalten Eingang, Ausgang und Puffer; neue starten leer (Schwarz /
    /// Stille am Ausgang), wegfallende geben Eingang, Ausgang und Speicher frei.
    pub fn set_tracks(&self, video_flow_ids: Vec<String>, audio_flow_ids: Vec<String>) {
        let _ = self.commands.send(Command::Resize(video_flow_ids, audio_flow_ids));
    }

    /// Aktuelle Spurzahl (Bild, Ton).
    pub fn track_counts(&self) -> (usize, usize) {
        (self.shared.vtracks.lock().expect("lock poisoned").len(), self.shared.atracks.lock().expect("lock poisoned").len())
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
        let vt: Vec<Arc<TrackCounters>> = s.vtracks.lock().expect("lock poisoned").clone();
        let at: Vec<Arc<TrackCounters>> = s.atracks.lock().expect("lock poisoned").clone();
        let p = s.playout.lock().expect("lock poisoned");
        let c = &s.counters;
        let pct = |origin: u64, arrival: u64| (origin * 100).checked_div(origin + arrival).unwrap_or(0);
        let age = |last: u64| {
            if last == 0 { 0 } else { s.now_ms().saturating_sub(last) }
        };
        let status = |t: &TrackCounters, fill: buffer::TrackFill| TrackStatus {
            connected: fill.connected,
            fill_ms: fill.fill_ms,
            frames: fill.frames,
            bytes: fill.bytes,
            in_count: t.in_count.load(Ordering::Relaxed),
            out_count: t.out_count.load(Ordering::Relaxed),
            rebuilds: t.rebuilds.load(Ordering::Relaxed),
            origin_ts_pct: pct(t.ts_origin.load(Ordering::Relaxed), t.ts_arrival.load(Ordering::Relaxed)),
            input_age_ms: age(t.last_in_ms.load(Ordering::Relaxed)),
        };
        let video_tracks: Vec<TrackStatus> = vt.iter().enumerate().map(|(i, t)| status(t, p.video_track_fill(i))).collect();
        let audio_tracks: Vec<TrackStatus> = at.iter().enumerate().map(|(i, t)| status(t, p.audio_track_fill(i))).collect();
        let sum = |ts: &[Arc<TrackCounters>], f: fn(&TrackCounters) -> &AtomicU64| ts.iter().map(|t| f(t).load(Ordering::Relaxed)).sum::<u64>();
        let oldest = |tr: &[TrackStatus]| tr.iter().filter(|t| t.connected).map(|t| t.input_age_ms).max().unwrap_or(0);
        Snapshot {
            state: p.state().as_str(),
            video_frames: p.video_len(),
            video_fill_ms: p.video_fill_ms(),
            audio_fill_ms: p.audio_fill_ms(),
            front_age_ms: p.front_age_ms(now),
            buffer_bytes: p.video_bytes() + p.audio_bytes(),
            max_bytes: p.config().max_video_bytes * vt.len() + p.config().max_audio_bytes * at.len(),
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
            video_in: sum(&vt, |t| &t.in_count),
            audio_in: sum(&at, |t| &t.in_count),
            video_out: c.video_out.load(Ordering::Relaxed),
            audio_out: c.audio_out.load(Ordering::Relaxed),
            video_origin_ts_pct: pct(sum(&vt, |t| &t.ts_origin), sum(&vt, |t| &t.ts_arrival)),
            audio_origin_ts_pct: pct(sum(&at, |t| &t.ts_origin), sum(&at, |t| &t.ts_arrival)),
            rebuilds_video: sum(&vt, |t| &t.rebuilds),
            rebuilds_audio: sum(&at, |t| &t.rebuilds),
            video_input_age_ms: oldest(&video_tracks),
            audio_input_age_ms: oldest(&audio_tracks),
            video_tracks,
            audio_tracks,
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

fn build_video_input(
    shared: &Arc<Shared>,
    cfg: &Config,
    track: usize,
    counters: Arc<TrackCounters>,
    flow_id: &str,
) -> Result<InVideo, String> {
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
                        counters.ts_origin.fetch_add(1, Ordering::Relaxed);
                        t
                    }
                    None => {
                        counters.ts_arrival.fetch_add(1, Ordering::Relaxed);
                        sh.context.now_ns()
                    }
                };
                let data = Frame(Arc::new(map.as_slice().to_vec()));
                let len = data.0.len();
                counters.in_count.fetch_add(1, Ordering::Relaxed);
                counters.last_in_ms.store(sh.now_ms(), Ordering::Relaxed);
                sh.playout.lock().expect("lock poisoned").push_video_to(track, ts, len, data);
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    input.activate()?;
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("playing: {e}"))?;
    Ok(InVideo { pipeline, _input: input })
}

fn build_audio_input(
    shared: &Arc<Shared>,
    cfg: &Config,
    track: usize,
    counters: Arc<TrackCounters>,
    flow_id: &str,
) -> Result<InAudio, String> {
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
                        counters.ts_origin.fetch_add(1, Ordering::Relaxed);
                        (t, true)
                    }
                    None => {
                        counters.ts_arrival.fetch_add(1, Ordering::Relaxed);
                        // Ankunft = Ende des Blocks → Beginn = Ankunft − Dauer.
                        let dur = bytes.len() as u64 / bpf * 1_000_000_000 / rate;
                        (sh.context.now_ns().saturating_sub(dur), false)
                    }
                };
                counters.in_count.fetch_add(1, Ordering::Relaxed);
                counters.last_in_ms.store(sh.now_ms(), Ordering::Relaxed);
                sh.playout.lock().expect("lock poisoned").push_audio_to(track, ts, exact, bytes);
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    input.activate()?;
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("playing: {e}"))?;
    Ok(InAudio { pipeline, _input: input })
}


// ---- Ausgang -------------------------------------------------------------------------------------

/// Ausgang einer Spur: eigene kleine Pipeline `appsrc → Mxl*Output`.
struct OutTrack {
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
    counters: Arc<TrackCounters>,
    /// Ursprungszeit (TAI-ns) ↔ Pipeline-Laufzeit beim Bau: PTS = Laufzeit₀ + (Tick-Zeit − Zeit₀) →
    /// streng monoton, lückenlos.
    t0_ns: u64,
    start_running: gst::ClockTime,
    /// Hält den MXL-Schreiber am Leben.
    _writer: Box<dyn std::any::Any + Send>,
}

impl OutTrack {
    fn pts_of(&self, ts: u64) -> gst::ClockTime {
        self.start_running + gst::ClockTime::from_nseconds(ts.saturating_sub(self.t0_ns))
    }
}

impl Drop for OutTrack {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Ausgänge aller Spuren (`None` = Aufbau dieser Spur fehlgeschlagen; der Index bleibt belegt).
#[derive(Default)]
struct Outputs {
    video: Vec<Option<OutTrack>>,
    audio: Vec<Option<OutTrack>>,
}

fn running_time(pipeline: &gst::Pipeline) -> gst::ClockTime {
    pipeline
        .clock()
        .zip(pipeline.base_time())
        .map(|(c, b)| c.time().saturating_sub(b))
        .unwrap_or(gst::ClockTime::ZERO)
}

fn track_label(base: &str, kind: &str, index: usize) -> String {
    if index == 0 { base.to_string() } else { format!("{base} {kind} {}", index + 1) }
}

fn build_video_output(
    shared: &Arc<Shared>,
    cfg: &Config,
    index: usize,
    flow_id: &str,
    counters: Arc<TrackCounters>,
) -> Result<OutTrack, String> {
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
    pipeline.add(video_src.upcast_ref::<gst::Element>()).map_err(|e| format!("add appsrc: {e}"))?;
    let video_out = MxlVideoOutput::new(
        &pipeline,
        video_src.upcast_ref::<gst::Element>(),
        shared.context.clone(),
        flow_id,
        &track_label(&cfg.label, "Video", index),
        cfg.width,
        cfg.height,
        cfg.fps_num,
        cfg.fps_den,
        Arc::new(AtomicU64::new(0)),
    )
    .map_err(|e| format!("MxlVideoOutput: {e}"))?;
    video_out.set_active(true);
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("playing: {e}"))?;
    Ok(OutTrack {
        start_running: running_time(&pipeline),
        t0_ns: shared.context.now_ns(),
        pipeline,
        src: video_src,
        counters,
        _writer: Box::new(video_out),
    })
}

fn build_audio_output(
    shared: &Arc<Shared>,
    cfg: &Config,
    index: usize,
    flow_id: &str,
    counters: Arc<TrackCounters>,
) -> Result<OutTrack, String> {
    let pipeline = gst::Pipeline::new();
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
    pipeline.add(audio_src.upcast_ref::<gst::Element>()).map_err(|e| format!("add appsrc: {e}"))?;
    let audio_out = MxlAudioOutput::new(
        &pipeline,
        audio_src.upcast_ref::<gst::Element>(),
        shared.context.clone(),
        flow_id,
        &track_label(&cfg.label, "Audio", index),
        cfg.sample_rate,
        cfg.channels,
    )
    .map_err(|e| format!("MxlAudioOutput: {e}"))?;
    audio_out.set_active(true);
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("playing: {e}"))?;
    Ok(OutTrack {
        start_running: running_time(&pipeline),
        t0_ns: shared.context.now_ns(),
        pipeline,
        src: audio_src,
        counters,
        _writer: Box::new(audio_out),
    })
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
/// Pufferlogik und als Ursprungszeit an den Schreibpfad, sodass Bild und Ton (und alle Spuren) exakt gleich
/// zeitlich liegen.
fn output_loop(shared: Arc<Shared>, shutdown: Arc<AtomicBool>, heartbeat: Arc<AtomicU64>) {
    let ctx = shared.context.clone();
    let (fps_num, fps_den) = (shared.fps_num, shared.fps_den);
    let rate = shared.sample_rate;
    let block_samples = (rate as u64 * AUDIO_BLOCK_MS / 1000).max(1);
    let reference = omp_mediaio::mxl::tai_reference_caps();
    let now0 = ctx.now_ns();
    // Erste Takte kurz in der Zukunft, Audio auf Blockgrenze (Vielfaches von `block_samples`).
    let mut kv = ctx.ns_to_index(now0 + 100_000_000, fps_num, fps_den).unwrap_or(0) + 1;
    let mut ka = ctx.ns_to_index(now0 + 100_000_000, rate, 1).unwrap_or(0).div_ceil(block_samples) * block_samples;
    let mut tv = ctx.index_to_ns(kv, fps_num, fps_den).unwrap_or(now0);
    let mut ta = ctx.index_to_ns(ka, rate, 1).unwrap_or(now0);
    while !shutdown.load(Ordering::Relaxed) {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        let now = ctx.now_ns();
        if now >= tv {
            let decisions = shared.playout.lock().expect("lock poisoned").tick_video_all(tv);
            let mut outs = shared.outputs.lock().expect("lock poisoned");
            for (i, decision) in decisions.into_iter().enumerate() {
                let Some(Some(out)) = outs.video.get_mut(i) else { continue };
                let frame = match decision {
                    VideoOut::Frame(f) | VideoOut::Repeat(f) => f,
                    VideoOut::Black => shared.black.clone(),
                };
                let mut buf = gst::Buffer::from_slice(frame);
                if let Some(b) = buf.get_mut() {
                    b.set_pts(out.pts_of(tv));
                    b.set_duration(gst::ClockTime::from_nseconds(shared.period_ns));
                }
                stamp_origin(&mut buf, tv, &reference);
                if out.src.push_buffer(buf).is_ok() {
                    out.counters.out_count.fetch_add(1, Ordering::Relaxed);
                    if i == 0 {
                        shared.counters.video_out.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            drop(outs);
            kv += 1;
            // Bei längerem Stillstand (Prozess angehalten) neu aufsetzen statt aufzuholen.
            if now > tv + shared.period_ns * 5 {
                kv = ctx.ns_to_index(now, fps_num, fps_den).unwrap_or(kv) + 1;
            }
            tv = ctx.index_to_ns(kv, fps_num, fps_den).unwrap_or(tv + shared.period_ns);
        }
        if now >= ta {
            let blocks = shared.playout.lock().expect("lock poisoned").tick_audio_all(ta, block_samples as usize);
            let mut outs = shared.outputs.lock().expect("lock poisoned");
            for (i, (bytes, _silent)) in blocks.into_iter().enumerate() {
                let Some(Some(out)) = outs.audio.get_mut(i) else { continue };
                let mut buf = gst::Buffer::from_mut_slice(bytes);
                if let Some(b) = buf.get_mut() {
                    b.set_pts(out.pts_of(ta));
                    b.set_duration(gst::ClockTime::from_mseconds(AUDIO_BLOCK_MS));
                }
                stamp_origin(&mut buf, ta, &reference);
                if out.src.push_buffer(buf).is_ok() {
                    out.counters.out_count.fetch_add(1, Ordering::Relaxed);
                    if i == 0 {
                        shared.counters.audio_out.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            drop(outs);
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
    let outs = shared.outputs.lock().expect("lock poisoned");
    for o in outs.video.iter().chain(outs.audio.iter()).flatten() {
        let _ = o.src.end_of_stream();
    }
}

// ---- Eingangs-Verwaltung -------------------------------------------------------------------------

/// Verwaltungszustand eines Eingangs (eine Spur).
struct Slot<I> {
    input: Option<I>,
    want: Option<String>,
    last_try: Instant,
    /// Wartezeit bis zum nächsten Neuaufbau eines still gewordenen Eingangs: verdoppelt sich bei jedem
    /// erfolglosen Versuch (bis `RETRY_MAX_MS`) und springt zurück, sobald wieder Daten kommen — ein
    /// dauerhaft toter Vorgänger soll nicht alle 3 s eine Pipeline bauen und abreißen.
    gap: u64,
    seen: u64,
}

impl<I> Slot<I> {
    fn new() -> Self {
        Slot { input: None, want: None, last_try: Instant::now() - Duration::from_millis(RETRY_MS), gap: RETRY_MS, seen: 0 }
    }

    fn connect(&mut self, flow_id: String) {
        self.input = None;
        self.want = Some(flow_id);
        self.gap = RETRY_MS;
        self.last_try = Instant::now() - Duration::from_millis(self.gap);
    }

    fn disconnect(&mut self) {
        self.input = None;
        self.want = None;
    }

    /// Wächter + Wiederaufbau: verbunden, aber seit `STALL_MS` nichts gekommen → Eingang neu aufbauen.
    fn service(
        &mut self,
        shared: &Shared,
        c: &TrackCounters,
        tx: &UnboundedSender<Event>,
        what: &str,
        build: impl FnOnce(&str) -> Result<I, String>,
    ) {
        let last = c.last_in_ms.load(Ordering::Relaxed);
        if last != self.seen {
            self.seen = last;
            self.gap = RETRY_MS;
        }
        // Stille = Zeit seit den letzten Daten, höchstens aber seit dem letzten Neuaufbau: ein frisch
        // gebauter Eingang bekommt die volle Frist, statt wegen alter Zeitstempel sofort wieder zu fallen.
        let since_ms = self.last_try.elapsed().as_millis() as u64;
        let quiet = if last == 0 { since_ms } else { shared.now_ms().saturating_sub(last).min(since_ms) };
        if self.input.is_some() && self.want.is_some() && quiet > STALL_MS {
            self.input = None;
            c.rebuilds.fetch_add(1, Ordering::Relaxed);
            self.gap = (self.gap * 2).min(RETRY_MAX_MS);
            self.last_try = Instant::now();
        }
        if self.input.is_none()
            && let Some(f) = self.want.clone()
            && self.last_try.elapsed() >= Duration::from_millis(self.gap)
        {
            self.last_try = Instant::now();
            match build(&f) {
                Ok(i) => self.input = Some(i),
                Err(e) => {
                    self.gap = (self.gap * 2).min(RETRY_MAX_MS);
                    let _ = tx.send(Event::Error(format!("{what} input {f}: {e}")));
                }
            }
        }
    }
}

/// Spurzahl anpassen (läuft auf dem Eingangs-Thread; siehe [`PipelineHandle::set_tracks`]).
fn resize(
    shared: &Arc<Shared>,
    config: &Config,
    tx: &UnboundedSender<Event>,
    video_flows: &[String],
    audio_flows: &[String],
    vslots: &mut Vec<Slot<InVideo>>,
    aslots: &mut Vec<Slot<InAudio>>,
) {
    let (nv, na) = (video_flows.len().max(1), audio_flows.len().max(1));
    // Wegfallende Spuren zuerst: Ausgang und Eingang schließen, dann die Pufferlogik verkleinern.
    {
        let mut o = shared.outputs.lock().expect("lock poisoned");
        o.video.truncate(nv);
        o.audio.truncate(na);
    }
    vslots.truncate(nv);
    aslots.truncate(na);
    shared.vtracks.lock().expect("lock poisoned").truncate(nv);
    shared.atracks.lock().expect("lock poisoned").truncate(na);
    shared.playout.lock().expect("lock poisoned").set_tracks(nv, na);
    // Neue Spuren: Zähler, Slot, Ausgang (ein fehlgeschlagener Ausgang belegt den Index trotzdem).
    while vslots.len() < nv {
        let i = vslots.len();
        let counters = Arc::new(TrackCounters::default());
        shared.vtracks.lock().expect("lock poisoned").push(counters.clone());
        vslots.push(Slot::new());
        let out = build_video_output(shared, config, i, &video_flows[i], counters)
            .map_err(|e| {
                let _ = tx.send(Event::Error(format!("video output {}: {e}", i + 1)));
            })
            .ok();
        shared.outputs.lock().expect("lock poisoned").video.push(out);
    }
    while aslots.len() < na {
        let i = aslots.len();
        let counters = Arc::new(TrackCounters::default());
        shared.atracks.lock().expect("lock poisoned").push(counters.clone());
        aslots.push(Slot::new());
        let out = build_audio_output(shared, config, i, &audio_flows[i], counters)
            .map_err(|e| {
                let _ = tx.send(Event::Error(format!("audio output {}: {e}", i + 1)));
            })
            .ok();
        shared.outputs.lock().expect("lock poisoned").audio.push(out);
    }
}

/// Läuft auf einem eigenen Thread: baut die Ausgänge, startet den Takt-Thread und verwaltet die Eingänge.
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
        vtracks: Mutex::new(Vec::new()),
        atracks: Mutex::new(Vec::new()),
        outputs: Mutex::new(Outputs::default()),
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
    });
    shared.apply_target();

    let mut vslots: Vec<Slot<InVideo>> = Vec::new();
    let mut aslots: Vec<Slot<InAudio>> = Vec::new();
    resize(&shared, &config, &tx, &config.video_flow_ids, &config.audio_flow_ids, &mut vslots, &mut aslots);
    // Die ersten Ausgänge müssen stehen — sonst gibt es keinen Node.
    {
        let o = shared.outputs.lock().expect("lock poisoned");
        if o.video.iter().chain(o.audio.iter()).any(Option::is_none) {
            drop(o);
            let msg = "output setup failed".to_string();
            let _ = ready.send(Err(msg));
            return;
        }
    }
    let out_shared = shared.clone();
    let out_shutdown = shutdown.clone();
    let out_thread = std::thread::spawn(move || output_loop(out_shared, out_shutdown, output_heartbeat));

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let _ = ready.send(Ok(PipelineHandle { commands: commands_tx, shared: shared.clone() }));

    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Command::ConnectVideo(i, f)) => {
                if let Some(s) = vslots.get_mut(i) {
                    s.connect(f);
                }
            }
            Ok(Command::DisconnectVideo(i)) => {
                if let Some(s) = vslots.get_mut(i) {
                    s.disconnect();
                }
            }
            Ok(Command::ConnectAudio(i, f)) => {
                if let Some(s) = aslots.get_mut(i) {
                    s.connect(f);
                }
            }
            Ok(Command::DisconnectAudio(i)) => {
                if let Some(s) = aslots.get_mut(i) {
                    s.disconnect();
                }
            }
            Ok(Command::Resize(vf, af)) => resize(&shared, &config, &tx, &vf, &af, &mut vslots, &mut aslots),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        let vcounters: Vec<Arc<TrackCounters>> = shared.vtracks.lock().expect("lock poisoned").clone();
        let acounters: Vec<Arc<TrackCounters>> = shared.atracks.lock().expect("lock poisoned").clone();
        for (i, slot) in vslots.iter_mut().enumerate() {
            let Some(c) = vcounters.get(i) else { continue };
            slot.service(&shared, c, &tx, "video", |f| build_video_input(&shared, &config, i, c.clone(), f));
        }
        for (i, slot) in aslots.iter_mut().enumerate() {
            let Some(c) = acounters.get(i) else { continue };
            slot.service(&shared, c, &tx, "audio", |f| build_audio_input(&shared, &config, i, c.clone(), f));
        }
    }
    drop(vslots);
    drop(aslots);
    shutdown.store(true, Ordering::Relaxed);
    let _ = out_thread.join();
}
