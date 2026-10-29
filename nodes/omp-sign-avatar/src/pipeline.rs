//! Ausgabe: zwei `appsrc` (Fill BGRA, Key GRAY8) → `MxlVideoOutput` (wandelt nach v210, taktet, schreibt).
//! Fill und Key sind getrennte v210-Flows wie bei `omp-ograf` (kein natives v210a, s. dortige Begründung).
//! Gerendert wird nur bei geänderter Haltung und nur, solange ein Leser den Flow liest.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlContext, MxlVideoOutput};

use crate::player::Timeline;
use crate::{Renderer, FPS};

pub struct Config {
    pub domain: String,
    pub fill_flow_id: String,
    pub key_flow_id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub ss: usize,
}

/// Was gerade gebärdet wird; von der Node-API gesetzt, vom Render-Thread gelesen.
#[derive(Default)]
pub struct Playback {
    pub timeline: Option<Timeline>,
    pub started: Option<Instant>,
    pub text: String,
    pub looping: bool,
}

pub struct Shared {
    pub playback: Mutex<Playback>,
    /// Mittlere Renderzeit je neu gezeichnetem Bild in Mikrosekunden (gleitend), für die Anzeige.
    pub render_us: AtomicU64,
    pub frames_out: AtomicU64,
    pub running: AtomicBool,
    pub heartbeat: Arc<AtomicU64>,
}

fn caps(format: &str, w: u32, h: u32) -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("format", format)
        .field("width", w as i32)
        .field("height", h as i32)
        .field("framerate", gst::Fraction::new(FPS as i32, 1))
        .build()
}

fn appsrc(pipeline: &gst::Pipeline, format: &str, w: u32, h: u32) -> Result<gst_app::AppSrc, String> {
    let el = gst::ElementFactory::make("appsrc")
        .property("format", gst::Format::Time)
        .property("caps", caps(format, w, h))
        .build()
        .map_err(|e| format!("appsrc: {e}"))?;
    pipeline.add(&el).map_err(|e| format!("add appsrc: {e}"))?;
    el.dynamic_cast::<gst_app::AppSrc>().map_err(|_| "appsrc cast".to_string())
}

pub struct Running {
    pipeline: gst::Pipeline,
    pub shared: Arc<Shared>,
    thread: Option<std::thread::JoinHandle<()>>,
    _fill: MxlVideoOutput,
    _key: MxlVideoOutput,
}

impl Running {
    pub fn start(config: &Config) -> Result<Running, String> {
        if config.width % 4 != 0 {
            return Err(format!("Breite {} nicht durch 4 teilbar (GRAY8-Key)", config.width));
        }
        gst::init().map_err(|e| format!("gst init: {e}"))?;
        let pipeline = gst::Pipeline::new();
        let fill_src = appsrc(&pipeline, "BGRA", config.width, config.height)?;
        let key_src = appsrc(&pipeline, "GRAY8", config.width, config.height)?;
        let ctx = Arc::new(MxlContext::new(&config.domain).map_err(|e| format!("MxlContext: {e}"))?);
        let mk = |src: &gst_app::AppSrc, flow: &str, what: &str| {
            MxlVideoOutput::new(
                &pipeline,
                src.upcast_ref(),
                ctx.clone(),
                flow,
                &format!("{} {what}", config.label),
                config.width,
                config.height,
                FPS,
                1,
                Arc::new(AtomicU64::new(0)),
            )
        };
        let fill = mk(&fill_src, &config.fill_flow_id, "Fill")?;
        let key = mk(&key_src, &config.key_flow_id, "Key")?;
        fill.set_active(true);
        key.set_active(true);
        // Ohne Leser parkt der Ausgang (Ventil vor der Wandlung); der Render-Thread rechnet dann nicht.
        fill.gate_on_consumers(ctx.clone(), &config.fill_flow_id)?;
        key.gate_on_consumers(ctx.clone(), &config.key_flow_id)?;
        let parked = (fill.parked_handle(), key.parked_handle());

        pipeline.set_state(gst::State::Playing).map_err(|e| format!("Playing: {e}"))?;
        let (res, _, _) = pipeline.state(gst::ClockTime::from_seconds(5));
        res.map_err(|e| format!("Pipeline erreicht PLAYING nicht: {e:?}"))?;

        let shared = Arc::new(Shared {
            playback: Mutex::new(Playback::default()),
            render_us: AtomicU64::new(0),
            frames_out: AtomicU64::new(0),
            running: AtomicBool::new(true),
            heartbeat: Arc::new(AtomicU64::new(0)),
        });
        let sh = shared.clone();
        let (w, h, ss) = (config.width as usize, config.height as usize, config.ss);
        let thread = std::thread::Builder::new()
            .name("omp-sign-avatar-render".into())
            .spawn(move || render_loop(sh, fill_src, key_src, parked, w, h, ss))
            .map_err(|e| format!("Render-Thread: {e}"))?;
        Ok(Running { pipeline, shared, thread: Some(thread), _fill: fill, _key: key })
    }

    pub fn stop(&mut self) {
        self.shared.running.store(false, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop();
    }
}

fn render_loop(
    shared: Arc<Shared>,
    fill_src: gst_app::AppSrc,
    key_src: gst_app::AppSrc,
    parked: (Arc<AtomicBool>, Arc<AtomicBool>),
    w: usize,
    h: usize,
    ss: usize,
) {
    let mut renderer = Renderer::new(w, h, ss);
    // Dauerhafte Puffer (Rasterizer schreibt nur geänderte Zeilen, s. Raster::resolve)
    let (mut bgra, mut key) = (vec![0u8; w * h * 4], vec![0u8; w * h]);
    let mut last: Option<(gst::Buffer, gst::Buffer)> = None;
    let frame = Duration::from_micros(1_000_000 / FPS as u64);
    let t0 = Instant::now();
    let mut n: u64 = 0;
    while shared.running.load(Ordering::Relaxed) {
        shared.heartbeat.fetch_add(1, Ordering::Relaxed);
        let deadline = t0 + frame * n as u32;
        let now = Instant::now();
        if deadline > now {
            std::thread::sleep(deadline - now);
        }
        let is_parked = parked.0.load(Ordering::Relaxed) && parked.1.load(Ordering::Relaxed);
        let pose = {
            let mut pb = shared.playback.lock().expect("lock poisoned");
            let (t_ms, finished) = match (&pb.timeline, pb.started) {
                (Some(tl), Some(st)) => {
                    let t = st.elapsed().as_secs_f32() * 1000.0;
                    (t, tl.is_finished(t))
                }
                _ => (0.0, false),
            };
            if finished {
                if pb.looping {
                    pb.started = Some(Instant::now());
                } else {
                    pb.timeline = None;
                    pb.started = None;
                }
            }
            match &pb.timeline {
                Some(tl) => tl.pose_at(t_ms),
                None => crate::avatar::Pose::REST,
            }
        };
        let pts = gst::ClockTime::from_nseconds(frame.as_nanos() as u64 * n);
        // Geparkt: nichts neu zeichnen (die Puffer des letzten Bildes laufen weiter, damit ein neuer Leser anlaufen kann).
        let changed = if is_parked && last.is_some() {
            false
        } else {
            let t = Instant::now();
            let changed = renderer.render(&pose, &mut bgra, &mut key);
            if changed {
                let us = t.elapsed().as_micros() as u64;
                let old = shared.render_us.load(Ordering::Relaxed);
                shared.render_us.store(if old == 0 { us } else { (old * 7 + us) / 8 }, Ordering::Relaxed);
            }
            changed
        };
        if changed || last.is_none() {
            last = Some((gst::Buffer::from_slice(bgra.clone()), gst::Buffer::from_slice(key.clone())));
        }
        if let Some((f, k)) = &last {
            for (src, buf) in [(&fill_src, f), (&key_src, k)] {
                let mut b = buf.copy(); // flach: teilt die Daten, nur Zeitstempel neu
                {
                    let m = b.get_mut().expect("frische Kopie ist beschreibbar");
                    m.set_pts(pts);
                    m.set_duration(gst::ClockTime::from_nseconds(frame.as_nanos() as u64));
                }
                let _ = src.push_buffer(b);
            }
            shared.frames_out.fetch_add(1, Ordering::Relaxed);
        }
        n += 1;
    }
    let _ = fill_src.end_of_stream();
    let _ = key_src.end_of_stream();
}
