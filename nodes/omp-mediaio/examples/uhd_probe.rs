//! Minimaler UHD-Test (Kapitel 79): ein Schreiber, ein Leser, wenige Sekunden bei niedriger Bildrate — prüft, dass
//! OMPs MXL-Pfad UHD-Bilder (v210, 10 Bit 4:2:2) überhaupt trägt, und misst Rechenzeit und Speicherbedarf.
//! Absichtlich klein: ein Testbild, 2 Bilder/s, 6 s (das Gerät ist langsam und wird heiß).
//!
//!   OMP_MXL_DOMAIN=/dev/shm/claude-uhd nice -n 19 \
//!   cargo run --release -p omp-mediaio --example uhd_probe --features mxl -- 3840 2160 2 6
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput, MxlVideoOutput};

/// CPU-Zeit (Nutzer + System) dieses Prozesses in Sekunden aus /proc/self/stat.
fn cpu_seconds() -> f64 {
    let s = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let rest = s.rsplit(") ").next().unwrap_or("");
    let f: Vec<&str> = rest.split_whitespace().collect();
    let t = |i: usize| f.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    (t(11) + t(12)) / 100.0 // utime, stime (Felder 14/15, nach dem „) “-Schnitt Index 11/12)
}

fn rss_mib() -> f64 {
    let s = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    s.lines().find(|l| l.starts_with("VmHWM:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) / 1024.0
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let num = |i: usize, d: i64| a.get(i).and_then(|v| v.parse::<i64>().ok()).unwrap_or(d);
    let (w, h, fps, secs) = (num(1, 3840) as u32, num(2, 2160) as u32, num(3, 2) as u32, num(4, 6) as u64);
    gst::init().unwrap();
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/claude-uhd".into());
    std::fs::create_dir_all(&domain).unwrap();
    let flow_id = "5d1a2b3c-0000-4000-8000-00000000fa12";

    let wctx = Arc::new(MxlContext::new(&domain).unwrap());
    let wp = gst::Pipeline::new();
    let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).property_from_str("pattern", "smpte").build().unwrap();
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("video/x-raw").field("width", w as i32).field("height", h as i32).field("format", "I420").field("framerate", gst::Fraction::new(fps as i32, 1)).build())
        .build()
        .unwrap();
    wp.add_many([&src, &caps]).unwrap();
    src.link(&caps).unwrap();
    let out = MxlVideoOutput::new(&wp, &caps, wctx.clone(), flow_id, "uhd-probe", w, h, fps, 1, Arc::new(AtomicU64::new(0))).expect("MxlVideoOutput");
    out.set_active(true);
    wp.set_state(gst::State::Playing).unwrap();

    let rctx = Arc::new(MxlContext::new(&domain).unwrap());
    let rp = gst::Pipeline::new();
    let input = MxlVideoInput::new(&rp, rctx, flow_id).expect("MxlVideoInput");
    let sink = gst::ElementFactory::make("fakesink").property("sync", false).build().unwrap();
    rp.add(&sink).unwrap();
    input.tail.link(&sink).unwrap();
    let frames = Arc::new(AtomicU64::new(0));
    let f = frames.clone();
    let size = Arc::new(std::sync::Mutex::new((0i32, 0i32)));
    let s2 = size.clone();
    sink.static_pad("sink").unwrap().add_probe(gst::PadProbeType::BUFFER, move |pad, _| {
        f.fetch_add(1, Ordering::Relaxed);
        if let Some(st) = pad.current_caps().and_then(|c| c.structure(0).map(|s| s.to_owned())) {
            *s2.lock().unwrap() = (st.get::<i32>("width").unwrap_or(0), st.get::<i32>("height").unwrap_or(0));
        }
        gst::PadProbeReturn::Ok
    });
    rp.set_state(gst::State::Playing).unwrap();

    let (cpu0, t0) = (cpu_seconds(), Instant::now());
    std::thread::sleep(Duration::from_secs(secs));
    let wall = t0.elapsed().as_secs_f64();
    let cpu = cpu_seconds() - cpu0;
    let n = frames.load(Ordering::Relaxed);
    let (rw, rh) = *size.lock().unwrap();
    let frame_mib = (w as f64 * h as f64 * 128.0 / 6.0 / 8.0) / 1048576.0; // v210: 128 Bit je 6 Pixel
    println!("Raster geschrieben {w}x{h}@{fps}, vom Leser gesehen {rw}x{rh}");
    println!("Bilder beim Leser: {n} in {wall:.1} s ({:.2}/s, Soll {fps})", n as f64 / wall);
    println!("v210-Bildgröße: {frame_mib:.1} MiB, Datenrate beim Soll {:.0} MiB/s", frame_mib * fps as f64);
    println!("CPU-Zeit des Prozesses: {cpu:.2} s in {wall:.1} s Wanduhr ({:.0} % eines Kerns); Spitzenspeicher {:.0} MiB", cpu / wall * 100.0, rss_mib());
    rp.set_state(gst::State::Null).unwrap();
    wp.set_state(gst::State::Null).unwrap();
    let _ = std::fs::remove_dir_all(&domain);
}
