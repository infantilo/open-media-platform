//! Prüft `MxlVideoOutput::gate_on_consumers`: Schreiber parkt ohne Leser;
//! ein NEUER Leser (eigene Instanz) muss den Ausgang wieder aktivieren und
//! Bilder bekommen. Misst die Zeit bis zum ersten Bild und das erneute
//! Parken nach dem Entfernen des Lesers.
//!
//!   OMP_MXL_DOMAIN=/dev/shm/claude-mxltest nice -n 15 \
//!   cargo run -p omp-mediaio --example gate_probe --features mxl
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput, MxlVideoOutput};

fn main() {
    gst::init().unwrap();
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/claude-mxltest".into());
    std::fs::create_dir_all(&domain).unwrap();
    let flow_id = "5d1a2b3c-0000-4000-8000-00000000fa11";

    let wctx = Arc::new(MxlContext::new(&domain).unwrap());
    let wp = gst::Pipeline::new();
    let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).build().unwrap();
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("video/x-raw").field("width", 640i32).field("height", 360i32).field("format", "I420").field("framerate", gst::Fraction::new(25, 1)).build())
        .build()
        .unwrap();
    wp.add_many([&src, &caps]).unwrap();
    src.link(&caps).unwrap();
    let out = MxlVideoOutput::new(&wp, &caps, wctx.clone(), flow_id, "gate-probe", 640, 360, 25, 1, Arc::new(AtomicU64::new(0))).unwrap();
    out.set_active(true);
    out.gate_on_consumers(wctx.clone(), flow_id).unwrap();
    wp.set_state(gst::State::Playing).unwrap();
    let t0 = Instant::now();
    println!("[{:>5.1}s] Schreiber läuft, kein Leser", t0.elapsed().as_secs_f32());

    // Phase 1: parken lassen
    std::thread::sleep(Duration::from_secs(14));
    println!("[{:>5.1}s] valve drop={} (erwartet true = geparkt)", t0.elapsed().as_secs_f32(), !out.is_active());

    for round in 1..=2 {
        // Phase 2: Leser starten
        let rctx = Arc::new(MxlContext::new(&domain).unwrap());
        let rp = gst::Pipeline::new();
        let input = MxlVideoInput::new(&rp, rctx.clone(), flow_id).unwrap();
        let sink = gst::ElementFactory::make("fakesink").property("sync", false).build().unwrap();
        rp.add(&sink).unwrap();
        input.tail.link(&sink).unwrap();
        let frames = Arc::new(AtomicU64::new(0));
        let f = frames.clone();
        sink.static_pad("sink").unwrap().add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            f.fetch_add(1, Ordering::Relaxed);
            gst::PadProbeReturn::Ok
        });
        rp.set_state(gst::State::Playing).unwrap();
        let start = Instant::now();
        println!("[{:>5.1}s] Runde {round}: Leser gestartet", t0.elapsed().as_secs_f32());
        let mut first = None;
        while start.elapsed() < Duration::from_secs(15) {
            std::thread::sleep(Duration::from_millis(100));
            if first.is_none() && frames.load(Ordering::Relaxed) > 0 {
                first = Some(start.elapsed());
            }
        }
        match first {
            Some(d) => println!("[{:>5.1}s] Runde {round}: erstes Bild nach {:.1}s, nach 15s {} Bilder, valve drop={}", t0.elapsed().as_secs_f32(), d.as_secs_f32(), frames.load(Ordering::Relaxed), !out.is_active()),
            None => println!("[{:>5.1}s] Runde {round}: KEIN Bild in 15s (Deadlock!)", t0.elapsed().as_secs_f32()),
        }
        rp.set_state(gst::State::Null).unwrap();
        drop(input);
        drop(rp);
        // Phase 3: Leser weg -> erneut parken
        std::thread::sleep(Duration::from_secs(16));
        println!("[{:>5.1}s] Runde {round}: ohne Leser, valve drop={} (erwartet true)", t0.elapsed().as_secs_f32(), !out.is_active());
    }
    wp.set_state(gst::State::Null).unwrap();
}
