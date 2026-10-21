//! MXL-Anbindung des Intercoms (Kapitel 47.9): Programm-Eingänge (IS-05-Receiver, speisen einen Teilnehmer mit
//! `mxl_in`) und Kanalmix-Ausgänge (MXL-Sender, tragen das Hörsignal eines Teilnehmers mit `mxl_out`, z. B. für
//! einen Studiolautsprecher oder eine Aufnahme).
//!
//! Ohne `libmxl` oder ohne die Domain läuft der Node trotzdem (ohne Eingänge/Ausgänge) — Intercom braucht MXL nicht.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext};
use omp_node_sdk::connection::{ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::RegistryClient;

use crate::mix::FRAME;

const MAX_RING_FRAMES: usize = 6;

struct ActiveInput {
    pipeline: gst::Pipeline,
    _input: MxlAudioInput,
}

impl Drop for ActiveInput {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

struct InputSlot {
    ring: Arc<Mutex<VecDeque<f32>>>,
    flow: Mutex<String>,
    active: Mutex<Option<ActiveInput>>,
    flowed: Arc<AtomicBool>,
}

struct OutputSlot {
    flow_id: String,
    pipeline: gst::Pipeline,
    appsrc: gst_app::AppSrc,
    _output: MxlAudioOutput,
    base_ns: Mutex<(Option<u64>, u64)>,
    pushed: AtomicU64,
}

impl Drop for OutputSlot {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

pub struct MxlIo {
    ctx: Arc<MxlContext>,
    inputs: Vec<InputSlot>,
    outputs: Vec<OutputSlot>,
}

fn stereo_caps() -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("layout", "interleaved")
        .field("rate", 48_000i32)
        .field("channels", 2i32)
        .field("channel-mask", gst::Bitmask::new(0x3))
        .build()
}

impl MxlIo {
    /// Öffnet die MXL-Domain und legt die Ausgänge an (`output_flow_ids` = vorab vergebene Flow-IDs der Sender).
    pub fn new(domain: &str, inputs: usize, output_flow_ids: &[String]) -> Result<Arc<Self>, String> {
        let ctx = Arc::new(MxlContext::new(domain)?);
        let mut outs = Vec::new();
        for (i, flow_id) in output_flow_ids.iter().enumerate() {
            let pipeline = gst::Pipeline::new();
            let appsrc = gst_app::AppSrc::builder()
                .caps(&stereo_caps())
                .format(gst::Format::Time)
                .is_live(true)
                .do_timestamp(false)
                .max_bytes((FRAME * 8 * 8) as u64)
                .build();
            appsrc.set_property_from_str("leaky-type", "downstream");
            pipeline.add(&appsrc).map_err(|e| e.to_string())?;
            let output = MxlAudioOutput::new(&pipeline, appsrc.upcast_ref(), ctx.clone(), flow_id, &format!("Intercom Mix {}", i + 1), 48_000, 2)?;
            output.set_active(true);
            pipeline.set_state(gst::State::Playing).map_err(|e| format!("Ausgang {}: {e}", i + 1))?;
            outs.push(OutputSlot { flow_id: flow_id.clone(), pipeline, appsrc, _output: output, base_ns: Mutex::new((None, 0)), pushed: AtomicU64::new(0) });
        }
        let ins = (0..inputs)
            .map(|_| InputSlot {
                ring: Arc::new(Mutex::new(VecDeque::new())),
                flow: Mutex::new(String::new()),
                active: Mutex::new(None),
                flowed: Arc::new(AtomicBool::new(false)),
            })
            .collect();
        Ok(Arc::new(Self { ctx, inputs: ins, outputs: outs }))
    }

    pub fn input_count(&self) -> usize {
        self.inputs.len()
    }

    pub fn output_count(&self) -> usize {
        self.outputs.len()
    }

    pub fn output_flow(&self, slot: usize) -> Option<&str> {
        self.outputs.get(slot).map(|o| o.flow_id.as_str())
    }

    pub fn input_flow(&self, slot: usize) -> String {
        self.inputs.get(slot).map(|s| s.flow.lock().expect("lock poisoned").clone()).unwrap_or_default()
    }

    pub fn input_flowed(&self, slot: usize) -> bool {
        self.inputs.get(slot).map(|s| s.flowed.load(Ordering::Relaxed)).unwrap_or(false)
    }

    /// Verbindet einen Eingang mit einem MXL-Audio-Flow (leer = trennen). Baut die Pipeline in eigenem Thread.
    pub fn connect_input(self: &Arc<Self>, slot: usize, flow_id: String) {
        if slot >= self.inputs.len() {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            let s = &me.inputs[slot];
            *s.flow.lock().expect("lock poisoned") = flow_id.clone();
            s.flowed.store(false, Ordering::Relaxed);
            s.ring.lock().expect("lock poisoned").clear();
            let mut active = s.active.lock().expect("lock poisoned");
            *active = None; // alte Pipeline zuerst beenden
            if flow_id.is_empty() {
                return;
            }
            match me.build_input(slot, &flow_id) {
                Ok(a) => *active = Some(a),
                Err(e) => eprintln!("omp-intercom: Programm-Eingang {}: {e}", slot + 1),
            }
        });
    }

    fn build_input(&self, slot: usize, flow_id: &str) -> Result<ActiveInput, String> {
        let s = &self.inputs[slot];
        let pipeline = gst::Pipeline::new();
        let input = MxlAudioInput::new(&pipeline, self.ctx.clone(), flow_id)?;
        let conv = gst::ElementFactory::make("audioconvert").build().map_err(|e| e.to_string())?;
        let resample = gst::ElementFactory::make("audioresample").build().map_err(|e| e.to_string())?;
        let caps = gst::Caps::builder("audio/x-raw").field("format", "F32LE").field("layout", "interleaved").field("rate", 48_000i32).field("channels", 1i32).build();
        let filter = gst::ElementFactory::make("capsfilter").property("caps", &caps).build().map_err(|e| e.to_string())?;
        let sink = gst_app::AppSink::builder().sync(false).max_buffers(16).drop(true).build();
        let chain = [&conv, &resample, &filter, sink.upcast_ref::<gst::Element>()];
        pipeline.add_many(chain).map_err(|e| e.to_string())?;
        gst::Element::link_many([&input.tail, &conv, &resample, &filter, sink.upcast_ref::<gst::Element>()]).map_err(|e| format!("link: {e}"))?;
        let ring = s.ring.clone();
        let flowed = s.flowed.clone();
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
                    // Programm läuft taktgenau: ein größerer Rückstau ist nur Latenz.
                    if q.len() > FRAME * MAX_RING_FRAMES {
                        let excess = q.len() - FRAME * 2;
                        q.drain(..excess);
                    }
                    flowed.store(true, Ordering::Relaxed);
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("Playing: {e}"))?;
        Ok(ActiveInput { pipeline, _input: input })
    }

    /// Ein Mono-Frame vom Eingang (`None`, solange nichts anliegt).
    pub fn pull_input(&self, slot: usize) -> Option<Vec<f32>> {
        let s = self.inputs.get(slot)?;
        let mut q = s.ring.lock().expect("lock poisoned");
        if q.len() < FRAME {
            return None;
        }
        Some(q.drain(..FRAME).collect())
    }

    /// Ein Stereo-Frame an den Ausgang.
    pub fn push_output(&self, slot: usize, left: &[f32], right: &[f32]) {
        let Some(o) = self.outputs.get(slot) else { return };
        let mut bytes = Vec::with_capacity(FRAME * 8);
        for i in 0..FRAME {
            bytes.extend_from_slice(&left[i].to_le_bytes());
            bytes.extend_from_slice(&right[i].to_le_bytes());
        }
        let mut buffer = gst::Buffer::from_slice(bytes);
        {
            let now_ns = o.pipeline.current_running_time().map(|t| t.nseconds()).unwrap_or(0);
            let mut c = o.base_ns.lock().expect("lock poisoned");
            let step = 20_000_000u64;
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
        if o.appsrc.push_buffer(buffer).is_ok() {
            o.pushed.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// IS-05-Steuerung eines Programm-Eingangs: löst den Sender zur Flow-ID auf und verbindet.
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
                    None => eprintln!("omp-intercom: Sender {sender_id} hat keinen Flow"),
                },
                Err(e) => eprintln!("omp-intercom: Sender {sender_id} nicht auflösbar: {e}"),
            },
            _ => self.io.connect_input(self.slot, String::new()),
        }
    }
}
