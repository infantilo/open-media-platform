//! MXL-Ein-/Ausgang von `omp-audio-delay` (Kapitel 89/RA3). Muster: `omp-intercom/src/mxl_io.rs` (Eingang über GStreamer in einen
//! Ring, Ausgang über `appsrc` → `MxlAudioOutput`), hier Stereo mit zwei Eingängen (Programm, Notquelle) und einem Ausgang.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext};
use omp_node_sdk::connection::{ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::RegistryClient;

use crate::delay::CH;

pub const SAMPLE_RATE: u32 = 48_000;
/// Taktlänge: 10 ms.
pub const BLOCK: usize = 480;
/// Ein Eingangsring über dieser Tiefe (Frames) wird gekappt (Eingang läuft vor — nur Latenz, kein Inhalt).
const MAX_INPUT_FRAMES: usize = SAMPLE_RATE as usize * 30;

struct ActiveInput {
    pipeline: gst::Pipeline,
    _input: MxlAudioInput,
}

impl Drop for ActiveInput {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Millisekunden seit Prozessstart (monoton) — für die Wächter-Schleife der Eingänge.
fn now_ms() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64
}

struct InputSlot {
    /// Zeitpunkt des letzten angekommenen Tons (0 = noch nie)
    last_data_ms: Arc<std::sync::atomic::AtomicU64>,
    ring: Arc<Mutex<VecDeque<f32>>>,
    flow: Mutex<String>,
    active: Mutex<Option<ActiveInput>>,
    flowed: Arc<AtomicBool>,
}

pub struct MxlIo {
    ctx: Arc<MxlContext>,
    inputs: Vec<InputSlot>,
    out_pipeline: gst::Pipeline,
    out_appsrc: gst_app::AppSrc,
    out_flowed: Arc<AtomicBool>,
    _output: MxlAudioOutput,
    base: Mutex<(Option<u64>, u64)>,
}

impl Drop for MxlIo {
    fn drop(&mut self) {
        let _ = self.out_pipeline.set_state(gst::State::Null);
    }
}

fn stereo_caps() -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("layout", "interleaved")
        .field("rate", SAMPLE_RATE as i32)
        .field("channels", CH as i32)
        .field("channel-mask", gst::Bitmask::new(0x3))
        .build()
}

impl MxlIo {
    /// Öffnet die MXL-Domain, legt den Ausgang an (`out_flow_id`) und `inputs` Eingangsplätze.
    pub fn new(domain: &str, inputs: usize, out_flow_id: &str, label: &str) -> Result<Arc<Self>, String> {
        let ctx = Arc::new(MxlContext::new(domain)?);
        let pipeline = gst::Pipeline::new();
        let appsrc = gst_app::AppSrc::builder()
            .caps(&stereo_caps())
            .format(gst::Format::Time)
            .is_live(true)
            .do_timestamp(false)
            .max_bytes((BLOCK * CH * 4 * 16) as u64)
            .build();
        appsrc.set_property_from_str("leaky-type", "downstream");
        pipeline.add(&appsrc).map_err(|e| e.to_string())?;
        let output = MxlAudioOutput::new(&pipeline, appsrc.upcast_ref(), ctx.clone(), out_flow_id, label, SAMPLE_RATE, CH as u32)?;
        output.set_active(true);
        let flowed = output.flowed_handle();
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("Ausgang: {e}"))?;
        let ins = (0..inputs)
            .map(|_| InputSlot {
                last_data_ms: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                ring: Arc::new(Mutex::new(VecDeque::new())),
                flow: Mutex::new(String::new()),
                active: Mutex::new(None),
                flowed: Arc::new(AtomicBool::new(false)),
            })
            .collect();
        Ok(Arc::new(Self { ctx, inputs: ins, out_pipeline: pipeline, out_appsrc: appsrc, out_flowed: flowed, _output: output, base: Mutex::new((None, 0)) }))
    }

    pub fn out_flowed(&self) -> bool {
        self.out_flowed.load(Ordering::Relaxed)
    }

    pub fn input_flow(&self, slot: usize) -> String {
        self.inputs.get(slot).map(|s| s.flow.lock().expect("lock poisoned").clone()).unwrap_or_default()
    }

    pub fn input_flowed(&self, slot: usize) -> bool {
        self.inputs.get(slot).map(|s| s.flowed.load(Ordering::Relaxed)).unwrap_or(false)
    }

    /// Verbindet einen Eingang mit einem MXL-Audio-Flow (leer = trennen). Der Aufbau läuft in eigenem Thread und **hält die
    /// Verbindung**: gibt es den Flow noch nicht (Quelle startet später, Player lädt erst) oder verstummt er (Quelle baut neu auf),
    /// versucht der Thread es erneut, solange diese Flow-ID gewünscht ist.
    pub fn connect_input(self: &Arc<Self>, slot: usize, flow_id: String) {
        if slot >= self.inputs.len() {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            let s = &me.inputs[slot];
            *s.flow.lock().expect("lock poisoned") = flow_id.clone();
            s.flowed.store(false, Ordering::Relaxed);
            s.last_data_ms.store(0, Ordering::Relaxed);
            s.ring.lock().expect("lock poisoned").clear();
            *s.active.lock().expect("lock poisoned") = None; // alte Pipeline zuerst beenden
            if flow_id.is_empty() {
                return;
            }
            let wanted = || *s.flow.lock().expect("lock poisoned") == flow_id;
            let mut warned = false;
            while wanted() {
                let built = if s.active.lock().expect("lock poisoned").is_none() { Some(me.build_input(slot, &flow_id)) } else { None };
                match built {
                    Some(Ok(a)) => {
                        s.last_data_ms.store(now_ms(), Ordering::Relaxed);
                        *s.active.lock().expect("lock poisoned") = Some(a);
                        warned = false;
                    }
                    Some(Err(e)) => {
                        if !warned {
                            eprintln!("omp-audio-delay: Eingang {}: {e} — versuche weiter", slot + 1);
                            warned = true;
                        }
                    }
                    None => {
                        // Wächter: seit 3 s kein Ton mehr → Pipeline abreißen und neu aufbauen (Flow wurde neu erzeugt)
                        if now_ms().saturating_sub(s.last_data_ms.load(Ordering::Relaxed)) > 3000 {
                            *s.active.lock().expect("lock poisoned") = None;
                            s.flowed.store(false, Ordering::Relaxed);
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        });
    }

    fn build_input(&self, slot: usize, flow_id: &str) -> Result<ActiveInput, String> {
        let s = &self.inputs[slot];
        let pipeline = gst::Pipeline::new();
        let input = MxlAudioInput::new(&pipeline, self.ctx.clone(), flow_id)?;
        let conv = gst::ElementFactory::make("audioconvert").build().map_err(|e| e.to_string())?;
        let resample = gst::ElementFactory::make("audioresample").build().map_err(|e| e.to_string())?;
        let filter = gst::ElementFactory::make("capsfilter").property("caps", &stereo_caps()).build().map_err(|e| e.to_string())?;
        let sink = gst_app::AppSink::builder().sync(false).max_buffers(32).drop(true).build();
        let chain = [&conv, &resample, &filter, sink.upcast_ref::<gst::Element>()];
        pipeline.add_many(chain).map_err(|e| e.to_string())?;
        gst::Element::link_many([&input.tail, &conv, &resample, &filter, sink.upcast_ref::<gst::Element>()]).map_err(|e| format!("link: {e}"))?;
        let ring = s.ring.clone();
        let flowed = s.flowed.clone();
        let last = s.last_data_ms.clone();
        sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |a| {
                    let sample = a.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    let buf = sample.buffer().ok_or(gst::FlowError::Error)?;
                    let map = buf.map_readable().map_err(|_| gst::FlowError::Error)?;
                    let mut q = ring.lock().expect("lock poisoned");
                    for c in map.as_slice().chunks_exact(4) {
                        q.push_back(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
                    }
                    if q.len() > MAX_INPUT_FRAMES * CH {
                        let excess = q.len() - MAX_INPUT_FRAMES * CH;
                        q.drain(..excess);
                    }
                    flowed.store(true, Ordering::Relaxed);
                    last.store(now_ms(), Ordering::Relaxed);
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("Playing: {e}"))?;
        Ok(ActiveInput { pipeline, _input: input })
    }

    /// Alles, was am Eingang bereitliegt (interleaved Stereo).
    pub fn drain_input(&self, slot: usize) -> Vec<f32> {
        let Some(s) = self.inputs.get(slot) else { return Vec::new() };
        let mut q = s.ring.lock().expect("lock poisoned");
        q.drain(..).collect()
    }

    /// Höchstens `frames` Frames vom Eingang (für die Notquelle, die im Takt des Ausgangs gelesen wird); fehlendes wird mit Stille aufgefüllt.
    pub fn take_input(&self, slot: usize, frames: usize, out: &mut [f32]) {
        out.fill(0.0);
        let Some(s) = self.inputs.get(slot) else { return };
        let mut q = s.ring.lock().expect("lock poisoned");
        let n = (frames * CH).min(q.len());
        for (i, v) in q.drain(..n).enumerate() {
            out[i] = v;
        }
        // Notquelle läuft im Takt: ein Rückstau über 200 ms ist nur Latenz
        let cap = SAMPLE_RATE as usize / 5 * CH;
        if q.len() > cap {
            let excess = q.len() - cap;
            q.drain(..excess);
        }
    }

    /// Einen Block (`BLOCK` Frames, interleaved Stereo) an den Ausgang.
    pub fn push_output(&self, block: &[f32]) {
        let mut bytes = Vec::with_capacity(block.len() * 4);
        for v in block {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let mut buffer = gst::Buffer::from_slice(bytes);
        {
            let now_ns = self.out_pipeline.current_running_time().map(|t| t.nseconds()).unwrap_or(0);
            let mut c = self.base.lock().expect("lock poisoned");
            let step = 10_000_000u64;
            let base = *c.0.get_or_insert(now_ns);
            let mut pts = base + c.1 * step;
            if pts + 3 * step < now_ns || pts > now_ns + 3 * step {
                c.0 = Some(now_ns);
                c.1 = 0;
                pts = now_ns;
            }
            c.1 += 1;
            let b = buffer.get_mut().expect("neuer Puffer");
            b.set_pts(gst::ClockTime::from_nseconds(pts));
            b.set_duration(gst::ClockTime::from_nseconds(step));
        }
        let _ = self.out_appsrc.push_buffer(buffer);
    }
}

/// IS-05-Steuerung eines Eingangs: löst den Sender zur Flow-ID auf und verbindet.
pub struct InputControl {
    pub io: Arc<MxlIo>,
    pub slot: usize,
    pub registry: RegistryClient,
}

impl ReceiverControl for InputControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => self.io.connect_input(self.slot, flow_id),
                    None => eprintln!("omp-audio-delay: Sender {sender_id} hat keinen Flow"),
                },
                Err(e) => eprintln!("omp-audio-delay: Sender {sender_id} nicht auflösbar: {e}"),
            },
            _ => self.io.connect_input(self.slot, String::new()),
        }
    }
}
