//! Kapitel 30.4: Gruppe NUR für ein Eingangspaar (`new_unsynced_in_group`).
//! Drei Video-Flows: A und B (Paar, B wird nach 4 s angehalten), C
//! (ungruppiert). Erwartung: C wird nie gebremst, A läuft nach B-Ausfall
//! dank Tor-Sicherung weiter.
//!   cargo run -p omp-mediaio --features mxl --example sync_pair_probe -- <sekunden>
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput, MxlVideoOutput};

const W: usize = 160;
const H: usize = 90;

fn uuid(salt: u128) -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let h = format!("{:032x}", n ^ salt);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn main() {
    gst::init().unwrap();
    let secs: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(10);
    let domain = format!("/dev/shm/omp-mxl-pairprobe-{}", std::process::id());
    std::fs::create_dir_all(&domain).unwrap();
    let ctx = Arc::new(MxlContext::new(&domain).unwrap());
    let ids = [uuid(1), uuid(2), uuid(3)];
    let wp = gst::Pipeline::new();
    let start = Instant::now();
    let total = (secs as f64 + 3.0) * 1000.0;
    let mut outs = Vec::new();
    let mut feeders = Vec::new();
    for (i, id) in ids.iter().enumerate() {
        let src = gst_app::AppSrc::builder().is_live(true).format(gst::Format::Time)
            .caps(&gst::Caps::builder("video/x-raw").field("format", "I420").field("width", W as i32).field("height", H as i32).field("framerate", gst::Fraction::new(0, 1)).build()).build();
        wp.add(&src).unwrap();
        let out = MxlVideoOutput::new(&wp, src.upcast_ref(), ctx.clone(), id, &format!("pp{i}"), W as u32, H as u32, 25, 1, Arc::new(AtomicU64::new(0))).unwrap();
        omp_mediaio::Output::set_active(&out, true);
        outs.push(out);
        let stop = if i == 1 { 4000.0 } else { f64::MAX }; // B fällt nach 4 s aus
        feeders.push(std::thread::spawn(move || {
            let (mut n, mut c) = (0u64, 0.0f64);
            while c < total.min(stop) {
                let t = start + Duration::from_micros(((c + 10.0) * 1000.0) as u64);
                if t > Instant::now() { std::thread::sleep(t - Instant::now()); }
                let mut b = gst::Buffer::from_slice(vec![100u8; W * H * 3 / 2]);
                { let m = b.get_mut().unwrap(); m.set_pts(gst::ClockTime::from_nseconds((c * 1e6) as u64)); m.set_duration(gst::ClockTime::from_mseconds(40)); }
                if src.push_buffer(b).is_err() { break; }
                n += 1; c = n as f64 * 40.0;
            }
        }));
    }
    wp.set_state(gst::State::Playing).unwrap();
    std::thread::sleep(Duration::from_millis(1500));

    let rp = gst::Pipeline::new();
    let group = ctx.create_sync_group();
    let counts: Vec<Arc<AtomicU64>> = (0..3).map(|_| Arc::new(AtomicU64::new(0))).collect();
    let mut inputs = Vec::new();
    for (i, id) in ids.iter().enumerate() {
        let g = if i < 2 { group.clone() } else { None };
        let inp = MxlVideoInput::new_unsynced_in_group(&rp, ctx.clone(), id, g).unwrap();
        let sink = gst_app::AppSink::builder().sync(false).max_buffers(8).drop(true).build();
        rp.add(&sink).unwrap();
        inp.tail.link(&sink).unwrap();
        let c = counts[i].clone();
        sink.set_callbacks(gst_app::AppSinkCallbacks::builder().new_sample(move |s| {
            let _ = s.pull_sample();
            c.fetch_add(1, Ordering::Relaxed);
            Ok(gst::FlowSuccess::Ok)
        }).build());
        inputs.push(inp);
    }
    rp.set_state(gst::State::Playing).unwrap();
    for inp in &inputs { inp.activate().unwrap(); }
    std::thread::sleep(Duration::from_secs(secs));
    rp.set_state(gst::State::Null).unwrap();
    wp.set_state(gst::State::Null).unwrap();
    println!(
        "frames A(pair)={} B(pair, stops after 4s)={} C(ungrouped)={} over {secs}s",
        counts[0].load(Ordering::Relaxed), counts[1].load(Ordering::Relaxed), counts[2].load(Ordering::Relaxed)
    );
    drop(feeders);
    let _ = std::fs::remove_dir_all(&domain);
}
