//! Medienseite des Havarieumschalters: vier MXL-Audio-Eingänge (Hauptsignal, Notquelle 1–3), ein eingebauter Notclip (Datei in Schleife)
//! und ein dauerhafter MXL-Audio-Ausgang. Muster von `omp-audio-delay/src/io.rs`: Eingang über GStreamer in einen Ring, Ausgang über
//! `appsrc` → `MxlAudioOutput`, Eingänge halten ihre Verbindung (Wiederaufbau, wenn der Flow neu entsteht).

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

pub const SAMPLE_RATE: u32 = 48_000;
pub const CH: usize = 2;
/// Taktlänge: 10 ms.
pub const BLOCK: usize = 480;
/// Anzahl MXL-Eingänge (Hauptsignal + 3 Notquellen); der Notclip hat Platz 4.
pub const MXL_INPUTS: usize = 4;
pub const CLIP_SLOT: usize = 4;
/// Ring je Quelle: über 60 ms zurückgestaute Daten sind nur Latenz und werden verworfen (der Umschalter soll nichts puffern).
const RING_CAP_FRAMES: usize = SAMPLE_RATE as usize * 60 / 1000;

fn now_ms() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64 + 1
}

struct ActiveInput {
    pipeline: gst::Pipeline,
    _input: Option<MxlAudioInput>,
}

impl Drop for ActiveInput {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

struct Slot {
    last_data_ms: Arc<AtomicU64>,
    ring: Arc<Mutex<VecDeque<f32>>>,
    /// MXL-Flow bzw. Dateipfad (Notclip), leer = nicht verbunden.
    source: Mutex<String>,
    active: Mutex<Option<ActiveInput>>,
}

pub struct MxlIo {
    ctx: Arc<MxlContext>,
    slots: Vec<Slot>,
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

/// Appsink, der Stereo-Blöcke in den Ring der Quelle schiebt.
fn ring_sink(slot: &Slot, sync: bool) -> gst_app::AppSink {
    let sink = gst_app::AppSink::builder().sync(sync).max_buffers(32).drop(true).build();
    let ring = slot.ring.clone();
    let last = slot.last_data_ms.clone();
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
                let cap = RING_CAP_FRAMES * CH;
                if q.len() > cap {
                    let excess = q.len() - cap;
                    q.drain(..excess);
                }
                last.store(now_ms(), Ordering::Relaxed);
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    sink
}

impl MxlIo {
    pub fn new(domain: &str, out_flow_id: &str, label: &str) -> Result<Arc<Self>, String> {
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
        let slots = (0..=CLIP_SLOT)
            .map(|_| Slot { last_data_ms: Arc::new(AtomicU64::new(0)), ring: Arc::new(Mutex::new(VecDeque::new())), source: Mutex::new(String::new()), active: Mutex::new(None) })
            .collect();
        Ok(Arc::new(Self { ctx, slots, out_pipeline: pipeline, out_appsrc: appsrc, out_flowed: flowed, _output: output, base: Mutex::new((None, 0)) }))
    }

    pub fn out_flowed(&self) -> bool {
        self.out_flowed.load(Ordering::Relaxed)
    }

    pub fn source_of(&self, slot: usize) -> String {
        self.slots.get(slot).map(|s| s.source.lock().expect("lock poisoned").clone()).unwrap_or_default()
    }

    /// Kamen innerhalb der letzten `window_ms` Daten an?
    pub fn present(&self, slot: usize, window_ms: u64) -> bool {
        let Some(s) = self.slots.get(slot) else { return false };
        let last = s.last_data_ms.load(Ordering::Relaxed);
        last != 0 && now_ms().saturating_sub(last) <= window_ms
    }

    /// Verbindet einen MXL-Eingang mit einem Flow (leer = trennen) und **hält** die Verbindung (Wiederaufbau, wenn der Flow neu entsteht).
    pub fn connect_input(self: &Arc<Self>, slot: usize, flow_id: String) {
        if slot >= MXL_INPUTS {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            let s = &me.slots[slot];
            *s.source.lock().expect("lock poisoned") = flow_id.clone();
            s.last_data_ms.store(0, Ordering::Relaxed);
            s.ring.lock().expect("lock poisoned").clear();
            *s.active.lock().expect("lock poisoned") = None;
            if flow_id.is_empty() {
                return;
            }
            let wanted = || *s.source.lock().expect("lock poisoned") == flow_id;
            let mut warned = false;
            while wanted() {
                let have = s.active.lock().expect("lock poisoned").is_some();
                if !have {
                    match me.build_mxl_input(slot, &flow_id) {
                        Ok(a) => {
                            *s.active.lock().expect("lock poisoned") = Some(a);
                            warned = false;
                        }
                        Err(e) => {
                            if !warned {
                                eprintln!("omp-failover: Eingang {}: {e} — versuche weiter", slot + 1);
                                warned = true;
                            }
                        }
                    }
                } else {
                    // seit 3 s kein Ton: Pipeline abreißen und neu aufbauen (Flow wurde neu erzeugt)
                    let last = s.last_data_ms.load(Ordering::Relaxed);
                    if last != 0 && now_ms().saturating_sub(last) > 3000 {
                        *s.active.lock().expect("lock poisoned") = None;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        });
    }

    fn build_mxl_input(&self, slot: usize, flow_id: &str) -> Result<ActiveInput, String> {
        let s = &self.slots[slot];
        let pipeline = gst::Pipeline::new();
        let input = MxlAudioInput::new(&pipeline, self.ctx.clone(), flow_id)?;
        let conv = gst::ElementFactory::make("audioconvert").build().map_err(|e| e.to_string())?;
        let resample = gst::ElementFactory::make("audioresample").build().map_err(|e| e.to_string())?;
        let filter = gst::ElementFactory::make("capsfilter").property("caps", &stereo_caps()).build().map_err(|e| e.to_string())?;
        let sink = ring_sink(s, false);
        pipeline.add_many([&conv, &resample, &filter, sink.upcast_ref::<gst::Element>()]).map_err(|e| e.to_string())?;
        gst::Element::link_many([&input.tail, &conv, &resample, &filter, sink.upcast_ref::<gst::Element>()]).map_err(|e| format!("link: {e}"))?;
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("Playing: {e}"))?;
        Ok(ActiveInput { pipeline, _input: Some(input) })
    }

    /// Notclip: Datei decodieren und in Schleife in Echtzeit in den Ring der Quelle `CLIP_SLOT` schieben (leer = aus).
    pub fn set_clip(self: &Arc<Self>, path: String) {
        let me = self.clone();
        std::thread::spawn(move || {
            let s = &me.slots[CLIP_SLOT];
            *s.source.lock().expect("lock poisoned") = path.clone();
            s.last_data_ms.store(0, Ordering::Relaxed);
            s.ring.lock().expect("lock poisoned").clear();
            *s.active.lock().expect("lock poisoned") = None;
            if path.is_empty() {
                return;
            }
            let wanted = || *s.source.lock().expect("lock poisoned") == path;
            let mut warned = false;
            while wanted() {
                match me.build_clip(&path) {
                    Ok(a) => {
                        warned = false;
                        let bus = a.pipeline.bus().expect("Bus");
                        let mut failed = false;
                        // Schleife: bei Ende der Datei zurückspringen; bei Fehler neu aufbauen
                        while wanted() && !failed {
                            if let Some(msg) = bus.timed_pop(gst::ClockTime::from_mseconds(200)) {
                                match msg.view() {
                                    gst::MessageView::Eos(_) => {
                                        if a.pipeline.seek_simple(gst::SeekFlags::FLUSH, gst::ClockTime::ZERO).is_err() {
                                            failed = true;
                                        }
                                    }
                                    gst::MessageView::Error(e) => {
                                        eprintln!("omp-failover: Notclip: {} — baue neu auf", e.error());
                                        failed = true;
                                    }
                                    _ => {}
                                }
                            }
                        }
                        *s.active.lock().expect("lock poisoned") = None;
                    }
                    Err(e) => {
                        if !warned {
                            eprintln!("omp-failover: Notclip „{path}“: {e} — versuche weiter");
                            warned = true;
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(1000));
            }
        });
    }

    fn build_clip(&self, path: &str) -> Result<ActiveInput, String> {
        let s = &self.slots[CLIP_SLOT];
        let uri = gst::glib::filename_to_uri(path, None).map_err(|e| e.to_string())?;
        let pipeline = gst::Pipeline::new();
        let src = gst::ElementFactory::make("uridecodebin").property("uri", uri.as_str()).build().map_err(|e| e.to_string())?;
        let conv = gst::ElementFactory::make("audioconvert").build().map_err(|e| e.to_string())?;
        let resample = gst::ElementFactory::make("audioresample").build().map_err(|e| e.to_string())?;
        let filter = gst::ElementFactory::make("capsfilter").property("caps", &stereo_caps()).build().map_err(|e| e.to_string())?;
        // sync=true: die Datei läuft in Echtzeit (nicht so schnell wie möglich) und füllt den Ring im Takt
        let sink = ring_sink(s, true);
        pipeline.add_many([&src, &conv, &resample, &filter, sink.upcast_ref::<gst::Element>()]).map_err(|e| e.to_string())?;
        gst::Element::link_many([&conv, &resample, &filter, sink.upcast_ref::<gst::Element>()]).map_err(|e| format!("link: {e}"))?;
        let conv_sink = conv.static_pad("sink").ok_or("audioconvert ohne sink")?;
        src.connect_pad_added(move |_, pad| {
            if conv_sink.is_linked() {
                return;
            }
            let is_audio = pad.current_caps().or_else(|| Some(pad.query_caps(None))).map(|c| c.structure(0).is_some_and(|st| st.name().starts_with("audio/"))).unwrap_or(false);
            if is_audio {
                let _ = pad.link(&conv_sink);
            }
        });
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("Playing: {e}"))?;
        Ok(ActiveInput { pipeline, _input: None })
    }

    /// Genau `BLOCK` Frames der Quelle (interleaved Stereo) in `out`; fehlendes wird mit Stille aufgefüllt. Rückgabe: wie viele Frames echt waren.
    pub fn take(&self, slot: usize, out: &mut [f32]) -> usize {
        out.fill(0.0);
        let Some(s) = self.slots.get(slot) else { return 0 };
        let mut q = s.ring.lock().expect("lock poisoned");
        let n = (BLOCK * CH).min(q.len());
        for (i, v) in q.drain(..n).enumerate() {
            out[i] = v;
        }
        n / CH
    }

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
                    None => eprintln!("omp-failover: Sender {sender_id} hat keinen Flow"),
                },
                Err(e) => eprintln!("omp-failover: Sender {sender_id} nicht auflösbar: {e}"),
            },
            _ => self.io.connect_input(self.slot, String::new()),
        }
    }
}
