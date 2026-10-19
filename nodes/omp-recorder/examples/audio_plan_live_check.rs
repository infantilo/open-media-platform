//! Kanalplan-Prüfung mit echten MXL-Flows (Kapitel 45), s. `main`. Aufruf (MXL-Umgebung sourcen):
//! `cargo run -p omp-recorder --example audio_plan_live_check [Sekunden]`.
#[path = "../src/audio_plan.rs"]
#[allow(dead_code)]
mod audio_plan;
#[path = "../src/pipeline.rs"]
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

/// Kanalplan-Prüfung mit echten MXL-Flows (Kapitel 45): Quelle A (Video + 2 Kanäle: 0,1 / 0,3 konstant) und Quelle B (1 Kanal: 0,5) →
/// Datei mit vier Kanälen [A2, B1 −6 dB, Stille, A1]. Gibt den Dateipfad aus; `ffmpeg … astats` prüft die Pegel je Kanal.
fn main() {
    gst::init().unwrap();
    let secs: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(5);
    let domain = format!("/dev/shm/omp-mxl-apcheck-{}", std::process::id());
    let media = format!("/tmp/omp-apcheck-{}", std::process::id());
    std::fs::create_dir_all(&domain).unwrap();
    std::fs::create_dir_all(&media).unwrap();
    let ctx = Arc::new(MxlContext::new(&domain).unwrap());
    let (vid, a_id, b_id) = (uuid(1), uuid(2), uuid(3));

    let wp = gst::Pipeline::new();
    let vsrc = gst_app::AppSrc::builder().is_live(true).format(gst::Format::Time)
        .caps(&gst::Caps::builder("video/x-raw").field("format", "I420").field("width", 320i32).field("height", 180i32).field("framerate", gst::Fraction::new(0, 1)).build()).build();
    let audio_src = |ch: i32| gst_app::AppSrc::builder().is_live(true).format(gst::Format::Time)
        .caps(&gst::Caps::builder("audio/x-raw").field("format", "F32LE").field("rate", 48000i32).field("channels", ch).field("layout", "interleaved").build()).build();
    let (asrc, bsrc) = (audio_src(2), audio_src(1));
    wp.add_many([&vsrc, &asrc, &bsrc]).unwrap();
    let vout = MxlVideoOutput::new(&wp, vsrc.upcast_ref(), ctx.clone(), &vid, "ap-video", 320, 180, 25, 1, Arc::new(AtomicU64::new(0))).unwrap();
    let aout = MxlAudioOutput::new(&wp, asrc.upcast_ref(), ctx.clone(), &a_id, "ap-a", 48000, 2).unwrap();
    let bout = MxlAudioOutput::new(&wp, bsrc.upcast_ref(), ctx.clone(), &b_id, "ap-b", 48000, 1).unwrap();
    omp_mediaio::Output::set_active(&vout, true);
    omp_mediaio::Output::set_active(&aout, true);
    omp_mediaio::Output::set_active(&bout, true);
    wp.set_state(gst::State::Playing).unwrap();
    let start = Instant::now();
    let total = (secs as f64 + 4.0) * 1000.0;
    let feed = |src: gst_app::AppSrc, step: f64, data: Vec<u8>| {
        std::thread::spawn(move || {
            let (mut n, mut c) = (0u64, 0.0f64);
            while c < total {
                let t = start + Duration::from_micros(((c + 10.0) * 1000.0) as u64);
                if t > Instant::now() { std::thread::sleep(t - Instant::now()); }
                let mut b = gst::Buffer::from_slice(data.clone());
                { let m = b.get_mut().unwrap(); m.set_pts(gst::ClockTime::from_nseconds((c * 1e6) as u64)); m.set_duration(gst::ClockTime::from_nseconds((step * 1e6) as u64)); }
                if src.push_buffer(b).is_err() { break; }
                n += 1; c = n as f64 * step;
            }
        })
    };
    let f32s = |v: &[f32]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let a_frame: Vec<f32> = (0..480).flat_map(|_| [0.1f32, 0.3]).collect();
    let b_frame: Vec<f32> = vec![0.5; 480];
    let _f1 = feed(vsrc, 40.0, vec![100u8; 320 * 180 * 3 / 2]);
    let _f2 = feed(asrc, 10.0, f32s(&a_frame));
    let _f3 = feed(bsrc, 10.0, f32s(&b_frame));
    std::thread::sleep(Duration::from_millis(1500));

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let cfg = pipeline::Config { domain: domain.clone(), media_dir: media.clone(), audio_inputs: 2 };
    let sd = shutdown.clone();
    let th = std::thread::spawn(move || pipeline::run(cfg, tx, sd, ready_tx, Arc::new(AtomicU64::new(0))));
    let h = ready_rx.blocking_recv().unwrap().unwrap();
    h.connect_video(vid);
    h.connect_audio(0, a_id);
    h.connect_audio(1, b_id);
    std::thread::sleep(Duration::from_millis(500));
    let plan = r#"{"channels":[{"input":0,"channel":1},{"input":1,"channel":0,"gainDb":-6.0206},{"input":null},{"input":0,"channel":0}]}"#;
    h.start_recording("apcheck.mxf".to_string(), None, Some(plan.to_string())).unwrap();
    std::thread::sleep(Duration::from_secs(secs));
    println!("duration_ms={} media_ready={}", h.duration_ms(), h.media_ready());
    h.stop_recording().unwrap();
    shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = th.join();
    wp.set_state(gst::State::Null).unwrap();
    println!("file: {media}/apcheck.mxf");
    let _ = std::fs::remove_dir_all(&domain);
}
