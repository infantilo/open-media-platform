//! Test-Ton für 106.11: schreibt einen Stereo-Ton als MXL-Fluss. `wave` = sine (1 kHz) oder ticks.
//!   cargo run -p omp-contribution --example tone_source -- <domain> <flow_id> <wave> <sekunden>
use std::sync::Arc;
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (domain, flow, wave) = (&a[1], &a[2], a.get(3).map(String::as_str).unwrap_or("sine"));
    let secs: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(30);
    gst::init().unwrap();
    let ctx = Arc::new(MxlContext::new(domain).unwrap());
    let pl = gst::Pipeline::new();
    let src = gst::ElementFactory::make("audiotestsrc").property("is-live", true).property("freq", 1000.0f64).property("volume", 0.1f64).build().unwrap();
    src.set_property_from_str("wave", wave);
    let conv = gst::ElementFactory::make("audioconvert").build().unwrap();
    let caps = gst::ElementFactory::make("capsfilter").property("caps", gst::Caps::builder("audio/x-raw").field("rate", 48000i32).field("channels", 2i32).build()).build().unwrap();
    let q = gst::ElementFactory::make("queue").build().unwrap();
    pl.add_many([&src, &conv, &caps, &q]).unwrap();
    gst::Element::link_many([&src, &conv, &caps, &q]).unwrap();
    let out = MxlAudioOutput::new(&pl, &q, ctx, flow, "tone", 48000, 2).unwrap();
    out.set_active(true);
    pl.set_state(gst::State::Playing).unwrap();
    std::thread::sleep(Duration::from_secs(secs));
    let _ = pl.set_state(gst::State::Null);
}
