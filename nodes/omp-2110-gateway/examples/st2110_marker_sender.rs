//! Test-Sender für 106.8: Marker-Bild (weiß, je Sekunde) und Marker-Ton (Tick je Sekunde), als ST-2110-20/-30 gesendet, mit
//! RTP-Zeitstempeln nach ST 2059-1 auf die **Systemuhr** gebunden (Ersatz ohne PTP-Karte, nur zum Testen). Der Ton kann
//! künstlich verspätet zugestellt werden (`queue min-threshold-time`): die RTP-Zeitstempel bleiben dabei richtig, nur die
//! Ankunft verschiebt sich.
//!
//!   cargo run -p omp-2110-gateway --example st2110_marker_sender -- <host> <video_port> <audio_port> <audio_delay_ms> <sekunden>
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::st2110::{St2110AudioOutput, St2110VideoOutput};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let host = a.get(1).cloned().unwrap_or("127.0.0.1".into());
    let vport: u16 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(6000);
    let aport: u16 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(6002);
    let delay_ms: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
    let secs: u64 = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(30);
    gst::init().unwrap();
    let pipeline = gst::Pipeline::new();

    let vsrc = gst::ElementFactory::make("videotestsrc").property("is-live", true).property_from_str("pattern", "black").build().unwrap();
    let vcaps = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("video/x-raw").field("format", "I420").field("width", 320i32).field("height", 180i32).field("framerate", gst::Fraction::new(25, 1)).build())
        .build()
        .unwrap();
    vcaps.static_pad("src").unwrap().add_probe(gst::PadProbeType::BUFFER, |_p, info| {
        if let Some(gst::PadProbeData::Buffer(buf)) = &mut info.data
            && buf.pts().is_some_and(|p| p.nseconds() % 1_000_000_000 < 40_000_000)
        {
            let b = buf.make_mut();
            if let Ok(mut m) = b.map_writable() {
                m.as_mut_slice().fill(235);
            }
        }
        gst::PadProbeReturn::Ok
    });
    let vconv = gst::ElementFactory::make("videoconvert").build().unwrap();
    pipeline.add_many([&vsrc, &vcaps, &vconv]).unwrap();
    gst::Element::link_many([&vsrc, &vcaps, &vconv]).unwrap();
    let vout = St2110VideoOutput::new(&pipeline, &vconv, &host, vport, 320, 180, 25, 1).unwrap();
    vout.set_active(true);

    let asrc = gst::ElementFactory::make("audiotestsrc").property("is-live", true).property("volume", 0.5f64).property("samplesperbuffer", 480i32).build().unwrap();
    asrc.set_property_from_str("wave", "ticks");
    let aconv = gst::ElementFactory::make("audioconvert").build().unwrap();
    let acaps = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("audio/x-raw").field("rate", 48000i32).field("channels", 2i32).build())
        .build()
        .unwrap();
    let q = gst::ElementFactory::make("queue").property("max-size-time", 3_000_000_000u64).property("max-size-buffers", 0u32).property("max-size-bytes", 0u32).build().unwrap();
    q.set_property("min-threshold-time", delay_ms * 1_000_000);
    pipeline.add_many([&asrc, &aconv, &acaps, &q]).unwrap();
    gst::Element::link_many([&asrc, &aconv, &acaps, &q]).unwrap();
    let aout = St2110AudioOutput::new(&pipeline, &q, &host, aport, 48000, 2).unwrap();
    aout.set_active(true);

    // ST 2059-1: Basiszeit = Uhrzeit, RTP-Zeitstempel = Uhrzeit in Ticks. Hier die Systemuhr (Ersatz).
    let clock = gst::SystemClock::obtain();
    if a.get(6).map(|s| s.as_str()) != Some("noalign") {
        omp_mediaio::ptp::align_rtp_with_clock_time(&pipeline, clock.time(), 48000).unwrap();
    }
    let r = pipeline.set_state(gst::State::Playing);
    eprintln!("Playing: {r:?}");
    let bus = pipeline.bus().unwrap();
    let end = std::time::Instant::now() + Duration::from_secs(secs);
    while std::time::Instant::now() < end {
        if let Some(m) = bus.timed_pop(gst::ClockTime::from_mseconds(200)) {
            match m.view() {
                gst::MessageView::Error(e) => eprintln!("FEHLER: {} ({:?})", e.error(), e.debug()),
                gst::MessageView::Warning(e) => eprintln!("WARNUNG: {}", e.error()),
                _ => {}
            }
        }
    }
    eprintln!("Zustand am Ende: {:?}", pipeline.state(gst::ClockTime::from_mseconds(10)));
    let _ = pipeline.set_state(gst::State::Null);
}
