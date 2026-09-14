//! Audio-Zweig von `omp-scope`: EIN per IS-05-Receiver-PATCH gewählter
//! MXL-Audio-Flow (anders als `omp-viewer`s dynamisch vermehrbare
//! Audio-Eingänge — ein Messgerät braucht hier nur einen festen
//! Messpunkt, kein Kreuzschienen-Sammelbecken). Zwei parallele Zweige ab
//! `MxlAudioInput.tail` über ein `tee`:
//!
//! - **Pegel** (Peak/RMS): `level`-Element, exakt `omp-viewer::
//!   audio_meters`s bereits bewährtes Muster (`appsink` statt
//!   `fakesink` — dort live gefunden, dass `fakesink` den MXL-Reader-
//!   Thread in `futex_wait` hängen lässt), Bus-Message über
//!   `omp_mediaio::levels::parse_level_message` in dasselbe `/levels`-
//!   SSE-Format `{inputId,rms,peak}` (hier immer `inputId="audio"`,
//!   `<omp-meter>`-Kit-Element im UI-Bundle).
//! - **Lautheit** (EBU R128 M/S/I/LRA): roher interleaved-F32-Sample-Tap
//!   über einen zweiten `appsink`, gefüttert in `ebur128::EbuR128`
//!   (`Cargo.toml`-Kommentar begründet die Bibliothekswahl). Kanalzahl/
//!   Abtastrate werden NICHT geraten, sondern aus den tatsächlich
//!   verhandelten Caps des ersten Samples gelesen — `EbuR128` wird erst
//!   dann lazily konstruiert.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ebur128::{EbuR128, Mode};
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use omp_mediaio::levels::parse_level_message;
use omp_mediaio::mxl::{MxlAudioInput, MxlContext};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub const METER_INPUT_ID: &str = "audio";
const LEVEL_INTERVAL_NS: u64 = 50_000_000;

#[derive(Clone, Copy, Default)]
pub struct LoudnessSnapshot {
    pub momentary_lufs: Option<f64>,
    pub short_term_lufs: Option<f64>,
    pub integrated_lufs: Option<f64>,
    pub range_lu: Option<f64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
}

pub enum Event {
    LevelMeter { rms: f64, peak: f64 },
}

enum Command {
    Connect(String),
    Disconnect,
}

#[derive(Clone)]
pub struct AudioHandle {
    commands: Sender<Command>,
    loudness: Arc<Mutex<LoudnessSnapshot>>,
    flowed: Arc<AtomicBool>,
}

impl AudioHandle {
    pub fn connect(&self, flow_id: String) {
        self.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::Connect(flow_id));
    }

    pub fn disconnect(&self) {
        self.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::Disconnect);
    }

    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }

    pub fn loudness(&self) -> LoudnessSnapshot {
        *self.loudness.lock().expect("lock poisoned")
    }
}

struct ActiveBranch {
    pipeline: gst::Pipeline,
    _input: MxlAudioInput,
    /// Signalisiert dem Bus-Watcher-Thread unten (`build()`), dass diese
    /// Branch abgebaut wird — `gst::Bus::timed_pop_filtered` liefert nach
    /// dem Abbau der Pipeline für immer nur noch Timeouts (kein
    /// zuverlässiges "Bus tot"-Signal in den Bindings verfügbar), ohne
    /// dieses Flag würde der Watcher-Thread bei jedem Connect/Disconnect-
    /// Zyklus verwaisen statt sich zu beenden.
    watcher_alive: Arc<AtomicBool>,
}

impl Drop for ActiveBranch {
    fn drop(&mut self) {
        self.watcher_alive.store(false, Ordering::Relaxed);
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn build(
    context: &Arc<MxlContext>,
    flow_id: &str,
    tx: UnboundedSender<Event>,
    loudness: Arc<Mutex<LoudnessSnapshot>>,
    flowed: Arc<AtomicBool>,
) -> Result<ActiveBranch, String> {
    let pipeline = gst::Pipeline::new();
    let input = MxlAudioInput::new(&pipeline, context.clone(), flow_id)?;

    let flowed_probe = flowed.clone();
    let tail_src_pad = input.tail.static_pad("src").expect("tail has a src pad");
    tail_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        flowed_probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Ok
    });

    let tee = gst::ElementFactory::make("tee").build().map_err(|e| format!("tee: {e}"))?;
    pipeline.add(&tee).map_err(|e| format!("add tee: {e}"))?;
    gst::Element::link_many([&input.tail, &tee]).map_err(|e| format!("link input to tee: {e}"))?;

    // Pegel-Zweig (Peak/RMS über `level`, s. Moduldoku).
    let level_queue = gst::ElementFactory::make("queue").build().map_err(|e| format!("queue (level): {e}"))?;
    let level = gst::ElementFactory::make("level")
        .property("interval", LEVEL_INTERVAL_NS)
        .build()
        .map_err(|e| format!("level: {e}"))?;
    let level_sink = gst::ElementFactory::make("appsink")
        .property("sync", false)
        .property("async", false)
        .property("max-buffers", 8u32)
        .property("drop", true)
        .build()
        .map_err(|e| format!("appsink (level): {e}"))?;
    pipeline
        .add(&level_queue)
        .and_then(|()| pipeline.add(&level))
        .and_then(|()| pipeline.add(&level_sink))
        .map_err(|e| format!("add level branch: {e}"))?;
    gst::Element::link_many([&tee, &level_queue, &level, &level_sink]).map_err(|e| format!("link level branch: {e}"))?;
    let level_app_sink: gst_app::AppSink = level_sink.dynamic_cast().map_err(|_| "level appsink cast failed".to_string())?;
    level_app_sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(|sink| {
                let _ = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    // `level` meldet nicht per `new_sample` (der Zweig oben holt nur die
    // Buffer aus dem Weg), sondern per Bus-Element-Message — ein
    // Bus-Watcher-Thread liest sie unten in `run()`, exakt wie
    // `omp-viewer::audio_meters::run`.
    let level_name = level.name().to_string();

    // Lautheits-Zweig (roher interleaved-F32-Sample-Tap für `ebur128`).
    let ebur_queue = gst::ElementFactory::make("queue").build().map_err(|e| format!("queue (ebur128): {e}"))?;
    let convert = gst::ElementFactory::make("audioconvert").build().map_err(|e| format!("audioconvert (ebur128): {e}"))?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            gst::Caps::builder("audio/x-raw")
                .field("format", "F32LE")
                .field("layout", "interleaved")
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter (ebur128): {e}"))?;
    let ebur_sink = gst::ElementFactory::make("appsink")
        .property("sync", false)
        .property("max-buffers", 8u32)
        .property("drop", true)
        .build()
        .map_err(|e| format!("appsink (ebur128): {e}"))?;
    pipeline
        .add(&ebur_queue)
        .and_then(|()| pipeline.add(&convert))
        .and_then(|()| pipeline.add(&caps))
        .and_then(|()| pipeline.add(&ebur_sink))
        .map_err(|e| format!("add loudness branch: {e}"))?;
    gst::Element::link_many([&tee, &ebur_queue, &convert, &caps, &ebur_sink]).map_err(|e| format!("link loudness branch: {e}"))?;

    let ebur_app_sink: gst_app::AppSink = ebur_sink.dynamic_cast().map_err(|_| "ebur128 appsink cast failed".to_string())?;
    let mut meter: Option<EbuR128> = None;
    ebur_app_sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let Some(caps) = sample.caps() else { return Ok(gst::FlowSuccess::Ok) };
                let Some(rate_val) = caps.structure(0).and_then(|s| s.get::<i32>("rate").ok()) else {
                    return Ok(gst::FlowSuccess::Ok);
                };
                let Some(channels_val) = caps.structure(0).and_then(|s| s.get::<i32>("channels").ok()) else {
                    return Ok(gst::FlowSuccess::Ok);
                };
                if meter.is_none() {
                    match EbuR128::new(channels_val as u32, rate_val as u32, Mode::M | Mode::S | Mode::I | Mode::LRA) {
                        Ok(m) => meter = Some(m),
                        Err(e) => {
                            eprintln!("omp-scope: ebur128 init failed (channels={channels_val}, rate={rate_val}): {e:?}");
                            return Ok(gst::FlowSuccess::Ok);
                        }
                    }
                    let mut snap = loudness.lock().expect("lock poisoned");
                    snap.sample_rate = Some(rate_val as u32);
                    snap.channels = Some(channels_val as u32);
                }
                let Some(buffer) = sample.buffer() else { return Ok(gst::FlowSuccess::Ok) };
                let Ok(map) = buffer.map_readable() else { return Ok(gst::FlowSuccess::Ok) };
                // `map.as_slice()` ist `&[u8]`; F32LE interleaved -> 4
                // Bytes/Sample, native Endianness auf allen hier
                // relevanten Zielplattformen (x86_64/aarch64) = Little
                // Endian, deckt sich mit der erzwungenen `F32LE`-Caps.
                let bytes = map.as_slice();
                let sample_count = bytes.len() / 4;
                let mut samples = Vec::with_capacity(sample_count);
                for chunk in bytes.chunks_exact(4) {
                    samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
                }
                if let Some(m) = meter.as_mut() {
                    let _ = m.add_frames_f32(&samples);
                    let mut snap = loudness.lock().expect("lock poisoned");
                    snap.momentary_lufs = m.loudness_momentary().ok();
                    snap.short_term_lufs = m.loudness_shortterm().ok();
                    snap.integrated_lufs = m.loudness_global().ok();
                    snap.range_lu = m.loudness_range().ok();
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    // Bus-Watcher für die `level`-Element-Message (gleiches Muster wie
    // `omp-viewer::audio_meters::run`, hier lokal statt in der äußeren
    // Kommando-Schleife, weil `run()` unten mehrere Verbindungen über
    // ihre Lebenszeit hinweg bedient — der Watcher lebt nur so lange wie
    // diese eine `ActiveBranch`).
    let watcher_alive = Arc::new(AtomicBool::new(true));
    {
        let bus = pipeline.bus().expect("pipeline has a bus");
        let tx = tx.clone();
        let watcher_alive = watcher_alive.clone();
        std::thread::spawn(move || {
            loop {
                if !watcher_alive.load(Ordering::Relaxed) {
                    break;
                }
                let Some(msg) = bus.timed_pop_filtered(gst::ClockTime::from_mseconds(500), &[gst::MessageType::Element, gst::MessageType::Eos]) else {
                    continue;
                };
                if matches!(msg.view(), gst::MessageView::Eos(_)) {
                    break;
                }
                let gst::MessageView::Element(el) = msg.view() else { continue };
                let Some(structure) = el.structure() else { continue };
                if structure.name() != "level" {
                    continue;
                }
                let name = msg.src().map(|o| o.name().to_string()).unwrap_or_default();
                if name != level_name {
                    continue;
                }
                let Some((rms, peak)) = parse_level_message(structure) else { continue };
                let _ = tx.send(Event::LevelMeter { rms, peak });
            }
        });
    }

    pipeline.set_state(gst::State::Playing).map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActiveBranch { pipeline, _input: input, watcher_alive })
}

pub fn run(
    context: Arc<MxlContext>,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<AudioHandle, String>>,
    heartbeat: Arc<AtomicU64>,
) {
    if gst::init().is_err() {
        let _ = ready.send(Err("gst init failed (audio)".to_string()));
        return;
    }

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let flowed = Arc::new(AtomicBool::new(false));
    let loudness = Arc::new(Mutex::new(LoudnessSnapshot::default()));
    let _ = ready.send(Ok(AudioHandle { commands: commands_tx, loudness: loudness.clone(), flowed: flowed.clone() }));

    let mut active: Option<ActiveBranch> = None;
    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::Connect(flow_id)) => {
                active = None;
                *loudness.lock().expect("lock poisoned") = LoudnessSnapshot::default();
                match build(&context, &flow_id, tx.clone(), loudness.clone(), flowed.clone()) {
                    Ok(branch) => active = Some(branch),
                    Err(e) => eprintln!("omp-scope: audio connect {flow_id} failed: {e}"),
                }
            }
            Ok(Command::Disconnect) => {
                active = None;
                *loudness.lock().expect("lock poisoned") = LoudnessSnapshot::default();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
