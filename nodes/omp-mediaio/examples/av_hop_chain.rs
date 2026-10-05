//! Baut die Kette des channel-player-Live-Pfads nach (MxlInput → convert/scale/rate →
//! MxlOutput `new_paced`) mit Marker-Flows als Quelle und schreibt NEUE Flows; die
//! Flow-IDs werden ausgegeben, dann läuft die Kette `<sekunden>`, damit
//! `av_marker_probe` die Ausgänge messen kann.
//!   [HOP_VARIANT=plain|paced] cargo run ... --example av_hop_chain -- <domain> <video_flow> <audio_flow> [sekunden]
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use gstreamer as gst;
use gstreamer::prelude::*;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext, MxlVideoInput, MxlVideoOutput};
use omp_mediaio::Output;

fn uuid(salt: u128) -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let h = format!("{:032x}", n ^ salt);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn main() {
    gst::init().unwrap();
    let a: Vec<String> = std::env::args().collect();
    let (domain, vflow, aflow) = (&a[1], &a[2], &a[3]);
    let secs: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(40);
    let paced = std::env::var("HOP_VARIANT").map_or(true, |v| v != "plain");
    let ctx = Arc::new(MxlContext::new_av_aligned(domain).unwrap());
    let pipe = gst::Pipeline::new();
    let vin = MxlVideoInput::new(&pipe, ctx.clone(), vflow).unwrap();
    let ain = MxlAudioInput::new(&pipe, ctx.clone(), aflow).unwrap();
    let vc = gst::ElementFactory::make("videoconvert").build().unwrap();
    let vs = gst::ElementFactory::make("videoscale").build().unwrap();
    let vr = gst::ElementFactory::make("videorate").build().unwrap();
    let vcaps = gst::ElementFactory::make("capsfilter").property("caps", gst::Caps::builder("video/x-raw").field("format", "I420").field("width", 640i32).field("height", 480i32).field("framerate", gst::Fraction::new(25, 1)).build()).build().unwrap();
    let ac = gst::ElementFactory::make("audioconvert").build().unwrap();
    let ar = gst::ElementFactory::make("audioresample").build().unwrap();
    let acaps = gst::ElementFactory::make("capsfilter").property("caps", gst::Caps::builder("audio/x-raw").field("format", "F32LE").field("rate", 48000i32).field("channels", 2i32).field("layout", "interleaved").build()).build().unwrap();
    pipe.add_many([&vc, &vs, &vr, &vcaps, &ac, &ar, &acaps]).unwrap();
    gst::Element::link_many([&vin.tail, &vc, &vs, &vr, &vcaps]).unwrap();
    gst::Element::link_many([&ain.tail, &ac, &ar, &acaps]).unwrap();
    // Diagnose: wo geht die Ursprungs-Meta (`timestamp/x-mxl-tai`) verloren?
    for (name, el) in [("vin.tail(videorate in MxlVideoInput)", &vin.tail), ("videoconvert", &vc), ("videoscale", &vs), ("videorate", &vr), ("vcaps", &vcaps), ("ain.tail", &ain.tail), ("audioconvert", &ac), ("audioresample", &ar), ("acaps", &acaps)] {
        if let Some(pad) = el.static_pad("src") {
            let name = name.to_string();
            let count = Arc::new(AtomicU64::new(0));
            pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, info| {
                if let Some(gst::PadProbeData::Buffer(b)) = &info.data {
                    let n = count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if n % 100 == 50 {
                        let meta = b.meta::<gst::ReferenceTimestampMeta>().map(|m| m.timestamp().nseconds());
                        eprintln!("META {name:40} pts={:?} refmeta={:?}", b.pts().map(|p| p.nseconds()), meta);
                    }
                }
                gst::PadProbeReturn::Ok
            });
        }
    }
    let (ovid, oaud) = (uuid(0xA1), uuid(0xB2));
    let vout = if paced {
        MxlVideoOutput::new_paced(&pipe, &vcaps, ctx.clone(), &ovid, "hop-v", 640, 480, 25, 1, Arc::new(AtomicU64::new(0)))
    } else {
        MxlVideoOutput::new(&pipe, &vcaps, ctx.clone(), &ovid, "hop-v", 640, 480, 25, 1, Arc::new(AtomicU64::new(0)))
    }
    .unwrap();
    let aout = if paced {
        MxlAudioOutput::new_paced(&pipe, &acaps, ctx.clone(), &oaud, "hop-a", 48000, 2)
    } else {
        MxlAudioOutput::new(&pipe, &acaps, ctx.clone(), &oaud, "hop-a", 48000, 2)
    }
    .unwrap();
    vout.set_active(true);
    aout.set_active(true);
    vin.activate().unwrap();
    ain.activate().unwrap();
    pipe.set_state(gst::State::Playing).unwrap();
    println!("OUT {ovid} {oaud}");
    use std::io::Write;
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_secs(secs));
    vin.stop();
    ain.stop();
    std::thread::sleep(Duration::from_millis(300));
    pipe.set_state(gst::State::Null).unwrap();
}
