//! Hilfswerkzeug: einen MXL-Video-Flow N Sekunden lang als PNG-Folge (5 fps) speichern.
//!   cargo run -p omp-mediaio --features mxl --example mxl_frames -- <domain> <flow_id> <out_pattern %03d.png> <sekunden>
use std::sync::Arc;
use std::time::Duration;

use gstreamer as gst;
use gstreamer::prelude::*;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput};

fn main() {
    gst::init().unwrap();
    let a: Vec<String> = std::env::args().collect();
    let (domain, flow, out) = (&a[1], &a[2], &a[3]);
    let secs: u64 = a[4].parse().unwrap();
    let ctx = Arc::new(MxlContext::new(domain).expect("MxlContext"));
    let pipe = gst::Pipeline::new();
    let input = MxlVideoInput::new(&pipe, ctx, flow).expect("MxlVideoInput");
    let conv = gst::ElementFactory::make("videoconvert").build().unwrap();
    let scale = gst::ElementFactory::make("videoscale").build().unwrap();
    let rate = gst::ElementFactory::make("videorate").build().unwrap();
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("video/x-raw").field("framerate", gst::Fraction::new(5, 1)).field("width", 320i32).field("height", 180i32).build())
        .build()
        .unwrap();
    let png = gst::ElementFactory::make("pngenc").build().unwrap();
    let sink = gst::ElementFactory::make("multifilesink").property("location", out.as_str()).property("sync", false).build().unwrap();
    pipe.add_many([&conv, &scale, &rate, &caps, &png, &sink]).unwrap();
    gst::Element::link_many([&input.tail, &conv, &scale, &rate, &caps, &png, &sink]).unwrap();
    pipe.set_state(gst::State::Playing).unwrap();
    std::thread::sleep(Duration::from_secs(secs));
    input.stop();
    std::thread::sleep(Duration::from_millis(300));
    pipe.set_state(gst::State::Null).unwrap();
}
