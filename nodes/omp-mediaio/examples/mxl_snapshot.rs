//! Hilfswerkzeug: ein Bild eines MXL-Video-Flows als PNG speichern.
//!   cargo run -p omp-mediaio --features mxl --example mxl_snapshot -- <domain> <flow_id> <out.png>
use std::sync::Arc;
use std::time::Duration;

use gstreamer as gst;
use gstreamer::prelude::*;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput};

fn main() {
    gst::init().unwrap();
    let a: Vec<String> = std::env::args().collect();
    let (domain, flow, out) = (&a[1], &a[2], &a[3]);
    let ctx = Arc::new(MxlContext::new(domain).expect("MxlContext"));
    let pipe = gst::Pipeline::new();
    let input = MxlVideoInput::new(&pipe, ctx, flow).expect("MxlVideoInput");
    let conv = gst::ElementFactory::make("videoconvert").build().unwrap();
    let png = gst::ElementFactory::make("pngenc").property("snapshot", true).build().unwrap();
    let sink = gst::ElementFactory::make("filesink").property("location", out.as_str()).property("sync", false).build().unwrap();
    pipe.add_many([&conv, &png, &sink]).unwrap();
    gst::Element::link_many([&input.tail, &conv, &png, &sink]).unwrap();
    pipe.set_state(gst::State::Playing).unwrap();
    let bus = pipe.bus().unwrap();
    let _ = bus.timed_pop_filtered(gst::ClockTime::from_seconds(8), &[gst::MessageType::Eos, gst::MessageType::Error]);
    std::thread::sleep(Duration::from_millis(200));
    input.stop();
    std::thread::sleep(Duration::from_millis(300));
    pipe.set_state(gst::State::Null).unwrap();
}
