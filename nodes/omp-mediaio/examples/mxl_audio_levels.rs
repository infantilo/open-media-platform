//! Hilfswerkzeug: Pegel (RMS in dBFS) je Kanal eines MXL-Audio-Flows über einige Sekunden.
//!   cargo run -p omp-mediaio --features mxl --example mxl_audio_levels -- <domain> <flow_id> [sekunden]
use std::sync::Arc;
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use omp_mediaio::mxl::{MxlAudioInput, MxlContext};

fn main() {
    gst::init().unwrap();
    let a: Vec<String> = std::env::args().collect();
    let (domain, flow) = (&a[1], &a[2]);
    let secs: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(3);
    let ctx = Arc::new(MxlContext::new(domain).expect("MxlContext"));
    let pipe = gst::Pipeline::new();
    let input = MxlAudioInput::new(&pipe, ctx, flow).expect("MxlAudioInput");
    let level = gst::ElementFactory::make("level").property("post-messages", true).property("interval", 250_000_000u64).build().unwrap();
    let sink = gst::ElementFactory::make("fakesink").property("sync", false).build().unwrap();
    // audioconvert: manche Flows (z. B. 6 Kanäle) tragen keine Kanalmaske, `level` verlangt aber Kanalpositionen.
    let conv = gst::ElementFactory::make("audioconvert").build().unwrap();
    pipe.add_many([&conv, &level, &sink]).unwrap();
    if std::env::var("NOLEVEL").is_ok() {
        // Nur Spitzenwerte aus den Rohdaten (kein level/audioconvert dazwischen).
        let fs = gst::ElementFactory::make("fakesink").property("sync", false).build().unwrap();
        pipe.add(&fs).unwrap();
        input.tail.link(&fs).unwrap();
    } else {
        gst::Element::link_many([&input.tail, &conv, &level, &sink]).unwrap();
    }
    // Zusätzlich Spitzenwert je Kanal direkt aus den Samples (unabhängig von `level`).
    let peaks = Arc::new(std::sync::Mutex::new((0u32, Vec::<f32>::new())));
    let peaks_probe = peaks.clone();
    input.tail.static_pad("src").unwrap().add_probe(gst::PadProbeType::BUFFER, move |pad, info| {
        if let Some(buf) = info.buffer()
            && let Some(ch) = pad.current_caps().and_then(|c| c.structure(0).and_then(|s| s.get::<i32>("channels").ok()))
            && let Ok(map) = buf.map_readable()
        {
            let mut g = peaks_probe.lock().unwrap();
            g.0 += 1;
            if g.1.len() != ch as usize {
                g.1 = vec![0.0; ch as usize];
            }
            for (i, x) in map.as_slice().chunks_exact(4).enumerate() {
                let v = f32::from_le_bytes([x[0], x[1], x[2], x[3]]).abs();
                let c = i % ch as usize;
                if v > g.1[c] {
                    g.1[c] = v;
                }
            }
        }
        gst::PadProbeReturn::Ok
    });
    pipe.set_state(gst::State::Playing).unwrap();
    let bus = pipe.bus().unwrap();
    let end = Instant::now() + Duration::from_secs(secs);
    let mut sum: Vec<f64> = Vec::new();
    let mut n = 0u32;
    while Instant::now() < end {
        let Some(msg) = bus.timed_pop_filtered(gst::ClockTime::from_mseconds(300), &[gst::MessageType::Element, gst::MessageType::Error]) else { continue };
        if let gst::MessageView::Element(e) = msg.view()
            && let Some(s) = e.structure()
            && s.name() == "level"
            && let Ok(rms) = s.get::<gst::glib::ValueArray>("rms")
        {
            let v: Vec<f64> = rms.iter().filter_map(|x| x.get::<f64>().ok()).collect();
            if sum.len() < v.len() {
                sum.resize(v.len(), 0.0);
            }
            for (i, x) in v.iter().enumerate() {
                sum[i] += x.max(-120.0);
            }
            n += 1;
        }
    }
    let avg: Vec<String> = sum.iter().map(|s| format!("{:.1}", s / n.max(1) as f64)).collect();
    println!("{flow}: {} Messungen, RMS dBFS je Kanal: [{}]", n, avg.join(", "));
    let g = peaks.lock().unwrap();
    let pk: Vec<String> = g.1.iter().map(|v| if *v > 0.0 { format!("{:.1}", 20.0 * v.log10()) } else { "-inf".to_string() }).collect();
    println!("  Puffer {}, Spitze dBFS je Kanal: [{}]", g.0, pk.join(", "));
    input.stop();
    pipe.set_state(gst::State::Null).unwrap();
}
