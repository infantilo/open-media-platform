//! Kapitel 30.3: echte `omp-recorder`-Pipeline (Quelltext per `#[path]`
//! eingebunden) gegen zwei Echtzeit-Schreiber (Video 320x180@25 + Audio
//! 48 kHz mono, korrekt etikettiert) — nimmt N Sekunden auf und gibt den
//! Dateipfad aus. Mit/ohne Sync-Group (`OMP_MXL_SYNCGROUP=0` schaltet ab).
//!   cargo run -p omp-recorder --example sync_live_check -- <sekunden>
#[path = "../src/pipeline.rs"]
#[allow(dead_code)]
mod pipeline;

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};

fn uuid(salt: u128) -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let h = format!("{:032x}", n ^ salt);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn main() {
    gst::init().unwrap();
    let secs: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(6);
    let domain = format!("/dev/shm/omp-mxl-reccheck-{}", std::process::id());
    let media = format!("/tmp/omp-reccheck-{}", std::process::id());
    std::fs::create_dir_all(&domain).unwrap();
    std::fs::create_dir_all(&media).unwrap();
    let ctx = Arc::new(MxlContext::new(&domain).unwrap());
    let (vid, aid) = (uuid(1), uuid(2));

    let wp = gst::Pipeline::new();
    let vsrc = gst_app::AppSrc::builder().is_live(true).format(gst::Format::Time)
        .caps(&gst::Caps::builder("video/x-raw").field("format", "I420").field("width", 320i32).field("height", 180i32).field("framerate", gst::Fraction::new(0, 1)).build()).build();
    let asrc = gst_app::AppSrc::builder().is_live(true).format(gst::Format::Time)
        .caps(&gst::Caps::builder("audio/x-raw").field("format", "F32LE").field("rate", 48000i32).field("channels", 1i32).field("layout", "interleaved").build()).build();
    wp.add_many([&vsrc, &asrc]).unwrap();
    let vout = MxlVideoOutput::new(&wp, vsrc.upcast_ref(), ctx.clone(), &vid, "rc-video", 320, 180, 25, 1, Arc::new(AtomicU64::new(0))).unwrap();
    let aout = MxlAudioOutput::new(&wp, asrc.upcast_ref(), ctx.clone(), &aid, "rc-audio", 48000, 1).unwrap();
    omp_mediaio::Output::set_active(&vout, true);
    omp_mediaio::Output::set_active(&aout, true);
    wp.set_state(gst::State::Playing).unwrap();
    let start = Instant::now();
    let total = (secs as f64 + 4.0) * 1000.0;
    let feed = |src: gst_app::AppSrc, step: f64, bytes: usize, byte: u8| {
        std::thread::spawn(move || {
            let (mut n, mut c) = (0u64, 0.0f64);
            while c < total {
                let t = start + Duration::from_micros(((c + 10.0) * 1000.0) as u64);
                if t > Instant::now() { std::thread::sleep(t - Instant::now()); }
                let mut b = gst::Buffer::from_slice(vec![byte; bytes]);
                { let m = b.get_mut().unwrap(); m.set_pts(gst::ClockTime::from_nseconds((c * 1e6) as u64)); m.set_duration(gst::ClockTime::from_nseconds((step * 1e6) as u64)); }
                if src.push_buffer(b).is_err() { break; }
                n += 1; c = n as f64 * step;
            }
        })
    };
    let _f1 = feed(vsrc, 40.0, 320 * 180 * 3 / 2, 100);
    let _f2 = feed(asrc, 10.0, 480 * 4, 0);
    std::thread::sleep(Duration::from_millis(1500));

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let cfg = pipeline::Config { domain: domain.clone(), media_dir: media.clone() };
    let sd = shutdown.clone();
    let th = std::thread::spawn(move || pipeline::run(cfg, tx, sd, ready_tx, Arc::new(AtomicU64::new(0))));
    let h = ready_rx.blocking_recv().unwrap().unwrap();
    h.connect_video(vid);
    h.connect_audio(aid);
    std::thread::sleep(Duration::from_millis(500));
    h.start_recording("reccheck.mkv".into()).unwrap();
    std::thread::sleep(Duration::from_secs(secs));
    println!("duration_ms={} flowed/media_ready={}", h.duration_ms(), h.media_ready());
    h.stop_recording().unwrap();
    shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = th.join();
    wp.set_state(gst::State::Null).unwrap();
    println!("file: {media}/reccheck.mkv");
    let _ = std::fs::remove_dir_all(&domain);
}
