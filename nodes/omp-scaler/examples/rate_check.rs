//! Prüft die Bildratenwandlung des Scalers (`videorate` gegen `blend`) mit der
//! echten Scaler-Pipeline: ein Echtzeit-Schreiber (Luma-Sägezahn, 640x360) →
//! `omp-scaler` (Ziel 25 fps) → Leser, der Bilder und Luma-Werte zählt.
//!   OMP_FRAMERATE_CONVERSION=blend GST_PLUGIN_PATH=<Plugin-Verzeichnis> \
//!   OMP_REC_FPS=30000/1001 cargo run -p omp-scaler --example rate_check -- <sekunden>
//! Ausgabe: Bilder/s am Ausgang, Anzahl gleicher Nachbarbilder (Duplikate),
//! Anteil "Zwischenwerte" (Luma, die in der Quelle nie vorkamen = Überblendung).
//! `OMP_RC_MODE=latency`: alle 50 Eingangsbilder ein 3 Bilder langer Blitz (Luma 235, sonst 16; lang genug, dass auch videorate beim Herunterrechnen ihn nicht verschluckt); gemessen wird die
//! Zeit vom Einspeisen des Blitzes bis zu seinem Auftauchen am Ausgang (Median/Min/Max in ms) —
//! nur zum Vergleich der Modi untereinander (enthält die feste Lese-/Schreib-Abfrage des Transports).
#[path = "../src/pipeline.rs"]
#[allow(dead_code)]
mod pipeline;

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput, MxlVideoOutput};

fn uuid(salt: u128) -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let h = format!("{:032x}", n ^ salt);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn main() {
    gst::init().unwrap();
    let secs: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(8);
    let fps = std::env::var("OMP_REC_FPS").unwrap_or_else(|_| "30000/1001".into());
    let (fn_, fd): (u32, u32) = fps.split_once('/').map(|(n, d)| (n.parse().unwrap(), d.parse().unwrap())).unwrap_or((30, 1));
    let (tn, td): (u32, u32) = std::env::var("OMP_TARGET_FPS").ok().and_then(|f| f.split_once('/').map(|(n, d)| (n.parse().unwrap(), d.parse().unwrap()))).unwrap_or((25, 1));
    let (w, h) = (640u32, 360u32);
    let latency_mode = std::env::var("OMP_RC_MODE").as_deref() == Ok("latency");
    let flashes: Arc<Mutex<Vec<Instant>>> = Arc::new(Mutex::new(Vec::new()));
    let flashes_w = flashes.clone();
    let domain = format!("/dev/shm/omp-mxl-ratecheck-{}", std::process::id());
    std::fs::create_dir_all(&domain).unwrap();
    let ctx = Arc::new(MxlContext::new(&domain).unwrap());
    let (src_id, dst_id) = (uuid(1), uuid(2));

    // Schreiber: Luma-Sägezahn 16..236 in 12 Stufen, pro Bild eine Stufe weiter.
    let wp = gst::Pipeline::new();
    let vsrc = gst_app::AppSrc::builder().is_live(true).format(gst::Format::Time)
        .caps(&gst::Caps::builder("video/x-raw").field("format", "I420").field("width", w as i32).field("height", h as i32).field("framerate", gst::Fraction::new(0, 1)).build()).build();
    wp.add(&vsrc).unwrap();
    let vout = MxlVideoOutput::new(&wp, vsrc.upcast_ref(), ctx.clone(), &src_id, "rc-src", w, h, fn_, fd, Arc::new(AtomicU64::new(0))).unwrap();
    omp_mediaio::Output::set_active(&vout, true);
    wp.set_state(gst::State::Playing).unwrap();
    let start = Instant::now();
    let total = (secs as f64 + 6.0) * 1000.0;
    let step = 1000.0 * fd as f64 / fn_ as f64;
    let feeder = std::thread::spawn(move || {
        let (mut n, mut c) = (0u64, 0.0f64);
        while c < total {
            let t = start + Duration::from_micros(((c + 10.0) * 1000.0) as u64);
            if t > Instant::now() { std::thread::sleep(t - Instant::now()); }
            let y = if latency_mode { if (25..28).contains(&(n % 50)) { 235 } else { 16 } } else { 16 + (n % 12) as u8 * 20 };
            if latency_mode && n % 50 == 25 { flashes_w.lock().unwrap().push(Instant::now()); }
            let mut data = vec![128u8; (w * h * 3 / 2) as usize];
            data[..(w * h) as usize].fill(y);
            let mut b = gst::Buffer::from_slice(data);
            { let m = b.get_mut().unwrap(); m.set_pts(gst::ClockTime::from_nseconds((c * 1e6) as u64)); m.set_duration(gst::ClockTime::from_nseconds((step * 1e6) as u64)); }
            if vsrc.push_buffer(b).is_err() { break; }
            n += 1; c = n as f64 * step;
        }
    });
    std::thread::sleep(Duration::from_millis(1500));

    // Scaler (echte Pipeline).
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let mode = omp_mediaio::framerate::RateMode::from_env();
    let cfg = pipeline::Config {
        domain: domain.clone(), target_flow_id: dst_id.clone(), label: "rc-dst".into(),
        target_width: w, target_height: h, target_framerate_numerator: tn, target_framerate_denominator: td, rate_mode: mode,
    };
    let sd = shutdown.clone();
    let th = std::thread::spawn(move || pipeline::run(cfg, tx, sd, ready_tx, Arc::new(AtomicU64::new(0))));
    let handle = ready_rx.blocking_recv().unwrap().unwrap();
    handle.connect(src_id);
    std::thread::sleep(Duration::from_millis(1500));

    // Leser am Scaler-Ausgang: Luma der Bildmitte je Bild.
    let rp = gst::Pipeline::new();
    let input = MxlVideoInput::new(&rp, ctx.clone(), &dst_id).unwrap();
    let conv = gst::ElementFactory::make("videoconvert").build().unwrap();
    let caps = gst::ElementFactory::make("capsfilter").property("caps", gst::Caps::builder("video/x-raw").field("format", "GRAY8").build()).build().unwrap();
    let sink = gst_app::AppSink::builder().sync(false).max_buffers(200).build();
    rp.add_many([&conv, &caps, sink.upcast_ref::<gst::Element>()]).unwrap();
    gst::Element::link_many([&input.tail, &conv, &caps, sink.upcast_ref::<gst::Element>()]).unwrap();
    let seen: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let seen2 = seen.clone();
    let arrivals: Arc<Mutex<Vec<(Instant, u8)>>> = Arc::new(Mutex::new(Vec::new()));
    let arrivals2 = arrivals.clone();
    sink.set_callbacks(gst_app::AppSinkCallbacks::builder().new_sample(move |s| {
        let smp = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
        let buf = smp.buffer().ok_or(gst::FlowError::Error)?;
        let m = buf.map_readable().map_err(|_| gst::FlowError::Error)?;
        seen2.lock().unwrap().push(m[m.len() / 2]);
        arrivals2.lock().unwrap().push((Instant::now(), m[m.len() / 2]));
        Ok(gst::FlowSuccess::Ok)
    }).build());
    rp.set_state(gst::State::Playing).unwrap();
    std::thread::sleep(Duration::from_secs(2)); // Einschwingen
    seen.lock().unwrap().clear();
    arrivals.lock().unwrap().clear();
    flashes.lock().unwrap().clear();
    std::thread::sleep(Duration::from_secs(secs));
    let v = seen.lock().unwrap().clone();
    if latency_mode {
        let (fl, ar) = (flashes.lock().unwrap().clone(), arrivals.lock().unwrap().clone());
        let mut lat: Vec<f64> = fl.iter().filter_map(|t| ar.iter().find(|(a, y)| a > t && *y > 60).map(|(a, _)| a.duration_since(*t).as_secs_f64() * 1000.0)).collect();
        lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if lat.is_empty() { println!("latency: keine Blitze erkannt"); } else {
            println!("latency conversion={} in={}/{} out={}/{} flashes={} median={:.0} ms min={:.0} max={:.0}", omp_mediaio::framerate::resolve(mode).name(), fn_, fd, tn, td, lat.len(), lat[lat.len() / 2], lat[0], lat[lat.len() - 1]);
        }
    }
    rp.set_state(gst::State::Null).unwrap();
    shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = th.join();
    wp.set_state(gst::State::Null).unwrap();
    drop(feeder);

    let dups = v.windows(2).filter(|p| p[0] == p[1]).count();
    let source_levels: Vec<u8> = (0..12).map(|i| 16 + i as u8 * 20).collect();
    let mixed = v.iter().filter(|y| !source_levels.contains(y)).count();
    println!("conversion={} in={}/{} out={}/{} frames={} per_s={:.2} duplicates={} blended_values={} ({:.0}%)",
        omp_mediaio::framerate::resolve(mode).name(), fn_, fd, tn, td, v.len(), v.len() as f64 / secs as f64, dups, mixed,
        100.0 * mixed as f64 / v.len().max(1) as f64);
    let _ = std::fs::remove_dir_all(&domain);
}
