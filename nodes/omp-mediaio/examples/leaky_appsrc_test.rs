use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use std::time::Duration;

fn main() {
    gst::init().unwrap();
    let pipeline = gst::Pipeline::new();
    let appsrc = gst::ElementFactory::make("appsrc")
        .property("format", gst::Format::Time)
        .property("is-live", true)
        .property("do-timestamp", true)
        .property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("format", "RGBA")
                .field("width", 64i32)
                .field("height", 64i32)
                .field("framerate", gst::Fraction::new(25, 1))
                .build(),
        )
        .property_from_str("leaky-type", "upstream")
        .property("max-buffers", 5u64)
        .build()
        .unwrap();
    // Diesmal die Pipeline WIRKLICH auf PLAYING bringen, den Rueckstau aber
    // ueber eine dauerhaft blockierende Pad-Probe am Sink erzwingen - das
    // vermeidet den Stoerfaktor aus Testlauf 1 (READY = appsrc-Task laeuft
    // gar nicht erst), damit die reale omp-viewer-Situation naeher
    // nachgebildet wird.
    let fakesink = gst::ElementFactory::make("fakesink")
        .property("sync", false)
        .build()
        .unwrap();
    pipeline.add(&appsrc).unwrap();
    pipeline.add(&fakesink).unwrap();
    gst::Element::link(&appsrc, &fakesink).unwrap();

    let sink_pad = fakesink.static_pad("sink").unwrap();
    sink_pad.add_probe(gst::PadProbeType::BLOCK_DOWNSTREAM, |_pad, _info| {
        gst::PadProbeReturn::Ok
    });

    pipeline.set_state(gst::State::Playing).unwrap();
    std::thread::sleep(Duration::from_millis(200));

    let app_src: gst_app::AppSrc = appsrc.dynamic_cast().unwrap();
    for i in 0..15 {
        let buf = gst::Buffer::from_slice(vec![0u8; 64 * 64 * 4]);
        let result = app_src.push_buffer(buf);
        println!(
            "push {i}: {:?} (queued_bytes={})",
            result,
            app_src.current_level_bytes()
        );
        if result.is_err() {
            println!("STOPPED at push {i} with error: {:?}", result);
            break;
        }
    }
    println!("done");
    let _ = pipeline.set_state(gst::State::Null);
}
