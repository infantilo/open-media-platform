//! Lebenszyklus der Aufnahme (eigener Thread, wie `omp-recorder`): bis `tams.start` merkt er sich nur die gewählten
//! MXL-Flows; die Pipeline (MXL-Eingang → Encoder → Segmente) entsteht erst zwischen Start und Stopp.
//! Hochladen macht der [`crate::uploader::Uploader`] auf einem eigenen Thread, unabhängig davon — auch nach dem Stopp
//! und über Neustarts hinweg arbeitet er die Warteschlange ab.

use crate::segmenter::{self, Branch, Event as SegEvent, OriginFn};
use crate::spool::Spool;
use crate::uploader::{FlowDef, FlowRegistry, audio_flow_body, video_flow_body};
use gstreamer as gst;
use gstreamer::prelude::*;
use omp_mediaio::mxl::{MxlAudioInput, MxlContext, MxlVideoInput, buffer_origin_index};
use omp_tams::index::Rate;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender as TokioUnboundedSender;
use tokio::sync::oneshot;

const COMMAND_POLL: Duration = Duration::from_millis(100);

#[derive(Clone)]
pub struct Config {
    pub domain: String,
    pub spool: Arc<Spool>,
    pub registry: Arc<FlowRegistry>,
    pub segment_s: u32,
    pub video_kbps: u32,
    pub audio_bps: i32,
    pub uploader_status: Arc<crate::uploader::UploaderStatus>,
    /// Aufbewahrung in Sekunden (0 = aus): wird als Tag `segment_retention_offset` an die Flows geschrieben (AppNote 0019).
    pub retention_s: u64,
    /// Aufbewahrung ganzer Flows in Sekunden (0 = aus): Tag `flow_retention_offset` (AppNote 0019).
    pub flow_retention_s: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecStatus {
    Idle,
    Recording,
    Error,
}
impl RecStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RecStatus::Idle => "idle",
            RecStatus::Recording => "recording",
            RecStatus::Error => "error",
        }
    }
}

pub enum Event {
    Warning(String),
}

enum Command {
    ConnectVideo(String),
    DisconnectVideo,
    ConnectAudio(String),
    DisconnectAudio,
    Start(Sender<Result<(), String>>),
    Stop(Sender<Result<(), String>>),
}

#[derive(Default)]
pub struct Counters {
    pub segments_written: AtomicU64,
    pub segments_dropped: AtomicU64,
}

#[derive(Clone)]
pub struct Handle {
    commands: Sender<Command>,
    status: Arc<Mutex<RecStatus>>,
    flowed: Arc<AtomicBool>,
    pub counters: Arc<Counters>,
}

impl Handle {
    pub fn connect_video(&self, flow_id: String) {
        let _ = self.commands.send(Command::ConnectVideo(flow_id));
    }
    pub fn disconnect_video(&self) {
        let _ = self.commands.send(Command::DisconnectVideo);
    }
    pub fn connect_audio(&self, flow_id: String) {
        let _ = self.commands.send(Command::ConnectAudio(flow_id));
    }
    pub fn disconnect_audio(&self) {
        let _ = self.commands.send(Command::DisconnectAudio);
    }
    pub fn start(&self) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.commands.send(Command::Start(tx)).map_err(|_| "Aufnahme-Thread beendet".to_string())?;
        rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "Zeitüberschreitung beim Starten".to_string())?
    }
    pub fn stop(&self) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.commands.send(Command::Stop(tx)).map_err(|_| "Aufnahme-Thread beendet".to_string())?;
        rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "Zeitüberschreitung beim Stoppen".to_string())?
    }
    pub fn status(&self) -> RecStatus {
        *self.status.lock().expect("lock poisoned")
    }
    /// Seit dem letzten Start hat mindestens ein Segment-Puffer den Encoder erreicht.
    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

struct Active {
    pipeline: gst::Pipeline,
    branches: Vec<Arc<Branch>>,
    _video: Option<MxlVideoInput>,
    _audio: Option<MxlAudioInput>,
}

fn json_u32(v: &serde_json::Value, path: &[&str]) -> Option<u32> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p)?;
    }
    cur.as_u64().map(|n| n as u32)
}

fn build(ctx: &Arc<MxlContext>, cfg: &Config, vflow: Option<&str>, aflow: Option<&str>, flowed: Arc<AtomicBool>) -> Result<Active, String> {
    if vflow.is_none() && aflow.is_none() {
        return Err("keine Quelle verbunden (Video-/Audio-Receiver)".into());
    }
    let pipeline = gst::Pipeline::new();
    let segment_ns = cfg.segment_s as u64 * 1_000_000_000;
    let mut branches = Vec::new();
    let mut defs: Vec<FlowDef> = Vec::new();

    let video = match vflow {
        Some(id) => {
            let input = MxlVideoInput::new(&pipeline, ctx.clone(), id).map_err(|e| format!("MxlVideoInput({id}): {e}"))?;
            let fps = Rate::new(input.framerate_numerator, input.framerate_denominator).ok_or("Video-Flow ohne Bildrate")?;
            let def: serde_json::Value = serde_json::from_str(&ctx.flow_def(id)?).map_err(|e| format!("Flow-Definition {id}: {e}"))?;
            let label = def.get("label").and_then(|l| l.as_str()).unwrap_or("Video").to_string();
            let interlace = def.get("interlace_mode").and_then(|l| l.as_str()).map(str::to_string);
            let (num, den) = (input.framerate_numerator as i64, input.framerate_denominator as i64);
            let c = ctx.clone();
            let origin: OriginFn = Arc::new(move |b| buffer_origin_index(&c, b, num, den));
            let b = segmenter::add_video_branch(&pipeline, &input.tail, id, fps, segment_ns, cfg.video_kbps, cfg.spool.clone(), origin)?;
            branches.push(b);
            defs.push(FlowDef {
                flow_id: id.to_string(),
                body: video_flow_body(id, &omp_node_sdk::idgen::deterministic_v4(&format!("omp-tams-source:{id}")), &label, input.width, input.height, fps.num, fps.den, interlace.as_deref(), cfg.segment_s, cfg.video_kbps),
                container: omp_tams::types::CONTAINER_MPEGTS.into(),
            });
            Some(input)
        }
        None => None,
    };
    let audio = match aflow {
        Some(id) => {
            let input = MxlAudioInput::new(&pipeline, ctx.clone(), id).map_err(|e| format!("MxlAudioInput({id}): {e}"))?;
            let def: serde_json::Value = serde_json::from_str(&ctx.flow_def(id)?).map_err(|e| format!("Flow-Definition {id}: {e}"))?;
            let sample_rate = json_u32(&def, &["sample_rate", "numerator"]).unwrap_or(48000);
            let label = def.get("label").and_then(|l| l.as_str()).unwrap_or("Audio").to_string();
            let c = ctx.clone();
            let origin: OriginFn = Arc::new(move |b| buffer_origin_index(&c, b, sample_rate as i64, 1));
            let b = segmenter::add_audio_branch(&pipeline, &input.tail, id, sample_rate, segment_ns, cfg.audio_bps, cfg.spool.clone(), origin)?;
            branches.push(b);
            defs.push(FlowDef {
                flow_id: id.to_string(),
                body: audio_flow_body(id, &omp_node_sdk::idgen::deterministic_v4(&format!("omp-tams-source:{id}")), &label, sample_rate, input.channels, cfg.segment_s, cfg.audio_bps as u32 / 1000),
                container: omp_tams::types::CONTAINER_MPEGTS.into(),
            });
            Some(input)
        }
        None => None,
    };
    for mut d in defs {
        let mut tags = serde_json::Map::new();
        if cfg.retention_s > 0 {
            tags.insert(omp_tams::retention::TAG.into(), omp_tams::retention::offset_tag(cfg.retention_s).into());
        }
        if cfg.flow_retention_s > 0 {
            tags.insert(omp_tams::retention::FLOW_TAG.into(), omp_tams::retention::offset_tag(cfg.flow_retention_s).into());
        }
        if !tags.is_empty() {
            d.body["tags"] = serde_json::Value::Object(tags);
        }
        cfg.registry.register(d);
    }
    // „media-ready“: sobald ein Puffer den Encoder erreicht hat
    if let Some(v) = &video {
        let f = flowed.clone();
        if let Some(pad) = v.tail.static_pad("src") {
            pad.add_probe(gst::PadProbeType::BUFFER, move |_p, _i| {
                f.store(true, Ordering::Relaxed);
                gst::PadProbeReturn::Remove
            });
        }
    } else if let Some(a) = &audio
        && let Some(pad) = a.tail.static_pad("src")
    {
        let f = flowed.clone();
        pad.add_probe(gst::PadProbeType::BUFFER, move |_p, _i| {
            f.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Remove
        });
    }
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("Pipeline starten: {e}"))?;
    Ok(Active { pipeline, branches, _video: video, _audio: audio })
}

/// Nachrichten verteilen; Fehler der Pipeline zurückgeben.
fn pump(active: &Active, timeout: Duration, tx: &TokioUnboundedSender<Event>, counters: &Counters) -> Option<String> {
    let bus = active.pipeline.bus()?;
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let msg = bus.timed_pop(gst::ClockTime::from_mseconds(left.as_millis().min(50) as u64));
        if let Some(m) = msg {
            if let gst::MessageView::Error(e) = m.view() {
                return Some(format!("{} ({})", e.error(), e.debug().unwrap_or_default()));
            }
            for b in &active.branches {
                match b.handle_message(&m) {
                    Some(SegEvent::Segment { .. }) => {
                        counters.segments_written.fetch_add(1, Ordering::Relaxed);
                    }
                    Some(SegEvent::Dropped { reason, flow_id }) => {
                        counters.segments_dropped.fetch_add(1, Ordering::Relaxed);
                        let _ = tx.send(Event::Warning(format!("Segment verworfen ({flow_id}): {reason}")));
                    }
                    None => {}
                }
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
    }
}

fn stop_pipeline(active: &Active, tx: &TokioUnboundedSender<Event>, counters: &Counters) -> Option<String> {
    active.pipeline.send_event(gst::event::Eos::new());
    let deadline = Instant::now() + segmenter::STOP_EOS_TIMEOUT;
    let bus = active.pipeline.bus();
    let mut warning = None;
    let mut eos = false;
    while Instant::now() < deadline && !eos {
        let Some(m) = bus.as_ref().and_then(|b| b.timed_pop(gst::ClockTime::from_mseconds(100))) else { continue };
        match m.view() {
            gst::MessageView::Eos(_) => eos = true,
            gst::MessageView::Error(e) => {
                warning = Some(format!("Pipeline-Fehler beim Stoppen: {}", e.error()));
                break;
            }
            _ => {}
        }
        for b in &active.branches {
            if let Some(SegEvent::Segment { .. }) = b.handle_message(&m) {
                counters.segments_written.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    if !eos && warning.is_none() {
        warning = Some(format!("kein EOS innerhalb von {} s — letztes Segment kann fehlen", segmenter::STOP_EOS_TIMEOUT.as_secs()));
    }
    // letzte Schließ-Meldungen nach EOS
    let _ = pump(active, Duration::from_millis(300), tx, counters);
    let _ = active.pipeline.set_state(gst::State::Null);
    warning
}

/// Läuft auf einem eigenen Thread.
pub fn run(config: Config, tx: TokioUnboundedSender<Event>, shutdown: Arc<AtomicBool>, ready: oneshot::Sender<Result<Handle, String>>, heartbeat: Arc<AtomicU64>) {
    if let Err(e) = gst::init() {
        let _ = ready.send(Err(format!("gst init: {e}")));
        return;
    }
    let ctx = match MxlContext::new_synced(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let status = Arc::new(Mutex::new(RecStatus::Idle));
    let flowed = Arc::new(AtomicBool::new(false));
    let counters = Arc::new(Counters::default());
    let _ = ready.send(Ok(Handle { commands: commands_tx, status: status.clone(), flowed: flowed.clone(), counters: counters.clone() }));

    let (mut vflow, mut aflow): (Option<String>, Option<String>) = (None, None);
    let mut active: Option<Active> = None;
    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        if let Some(a) = &active {
            // Platzgrenze der Warteschlange durchsetzen: nur Verwerfen, nie Blockieren
            let dropped = config.spool.enforce_limit();
            if dropped.segments > 0 {
                config.uploader_status.dropped_overflow.fetch_add(dropped.segments as u64, Ordering::Relaxed);
                let _ = tx.send(Event::Warning(format!("Warteschlange voll: {} Segmente ({} Byte) verworfen — Lücke in der Zeitachse", dropped.segments, dropped.bytes)));
            }
            if let Some(err) = pump(a, Duration::from_millis(50), &tx, &counters) {
                let _ = a.pipeline.set_state(gst::State::Null);
                active = None;
                *status.lock().expect("lock poisoned") = RecStatus::Error;
                let _ = tx.send(Event::Warning(format!("Aufnahme abgebrochen: {err}")));
            }
        }
        match commands_rx.recv_timeout(COMMAND_POLL) {
            Ok(Command::ConnectVideo(f)) => vflow = Some(f),
            Ok(Command::DisconnectVideo) => vflow = None,
            Ok(Command::ConnectAudio(f)) => aflow = Some(f),
            Ok(Command::DisconnectAudio) => aflow = None,
            Ok(Command::Start(reply)) => {
                let r = if active.is_some() {
                    Err("Aufnahme läuft bereits — erst tams.stop".to_string())
                } else {
                    flowed.store(false, Ordering::Relaxed);
                    build(&ctx, &config, vflow.as_deref(), aflow.as_deref(), flowed.clone()).map(|a| {
                        active = Some(a);
                        *status.lock().expect("lock poisoned") = RecStatus::Recording;
                    })
                };
                if let Err(e) = &r {
                    *status.lock().expect("lock poisoned") = RecStatus::Error;
                    let _ = tx.send(Event::Warning(format!("tams.start: {e}")));
                }
                let _ = reply.send(r);
            }
            Ok(Command::Stop(reply)) => {
                let r = match active.take() {
                    Some(a) => {
                        if let Some(w) = stop_pipeline(&a, &tx, &counters) {
                            let _ = tx.send(Event::Warning(w));
                        }
                        Ok(())
                    }
                    None => Err("keine Aufnahme aktiv".to_string()),
                };
                if r.is_ok() {
                    *status.lock().expect("lock poisoned") = RecStatus::Idle;
                }
                let _ = reply.send(r);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    if let Some(a) = active.take() {
        let _ = stop_pipeline(&a, &tx, &counters);
    }
}
