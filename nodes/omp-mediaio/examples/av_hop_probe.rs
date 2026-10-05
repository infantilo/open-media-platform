//! Misst, wo in einer Lese-Kette A/V verschoben wird: liest Marker-Flows (s.
//! `av_marker_probe`) über `MxlVideoInput`/`MxlAudioInput` (gemeinsamer Kontext, gemeinsame
//! Latenz) und vergleicht am Ende JEDER Teilstrecke die PTS von Marker-Bild und Tick:
//!   Stufe 1: direkt hinter dem Eingang (`input.tail`)
//!   Stufe 2: hinter videoconvert/videoscale/videorate bzw. audioconvert/audioresample (wie im channel-player)
//!   cargo run -p omp-mediaio --features mxl --example av_hop_probe -- <domain> <video_flow> <audio_flow> [sekunden]
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlAudioInput, MxlContext, MxlVideoInput};

#[derive(Default)]
struct Stage {
    vflips: Vec<u64>,
    aticks: Vec<u64>,
    vlast_bright: bool,
    quiet: u64,
}

fn tap(stage: Arc<Mutex<Stage>>, video: bool, sink: &gst_app::AppSink) {
    sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |s| {
                let smp = s.pull_sample().map_err(|_| gst::FlowError::Error)?;
                let buf = smp.buffer().unwrap();
                let Some(pts) = buf.pts() else { return Ok(gst::FlowSuccess::Ok) };
                let map = buf.map_readable().unwrap();
                let mut st = stage.lock().unwrap();
                if video {
                    // I420/Y-Ebene: Mittelwert der ersten Bytes
                    let n = map.len().min(1 << 15);
                    let mean = map[..n].iter().map(|&b| b as f64).sum::<f64>() / n as f64;
                    let bright = mean > 100.0;
                    if bright && !st.vlast_bright {
                        st.vflips.push(pts.nseconds());
                    }
                    st.vlast_bright = bright;
                } else {
                    // S16/F32? Caps im Sample prüfen
                    let fmt = smp.caps().and_then(|c| c.structure(0).map(|s| s.get::<String>("format").unwrap_or_default())).unwrap_or_default();
                    let ch = smp.caps().and_then(|c| c.structure(0).map(|s| s.get::<i32>("channels").unwrap_or(1))).unwrap_or(1) as usize;
                    let rate = smp.caps().and_then(|c| c.structure(0).map(|s| s.get::<i32>("rate").unwrap_or(48000))).unwrap_or(48000) as u64;
                    let vals: Vec<f32> = if fmt.starts_with("F32") {
                        map.chunks_exact(4 * ch).map(|c| f32::from_le_bytes(c[..4].try_into().unwrap())).collect()
                    } else {
                        map.chunks_exact(2 * ch).map(|c| i16::from_le_bytes(c[..2].try_into().unwrap()) as f32 / 32768.0).collect()
                    };
                    for (i, v) in vals.iter().enumerate() {
                        if v.abs() > 0.05 {
                            if st.quiet > rate / 2 {
                                st.aticks.push(pts.nseconds() + i as u64 * 1_000_000_000 / rate);
                            }
                            st.quiet = 0;
                        } else {
                            st.quiet += 1;
                        }
                    }
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
}

fn main() {
    gst::init().unwrap();
    let a: Vec<String> = std::env::args().collect();
    let (domain, vflow, aflow) = (&a[1], &a[2], &a[3]);
    let secs: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(14);
    let ctx = Arc::new(MxlContext::new_av_aligned(domain).unwrap());
    let pipe = gst::Pipeline::new();
    let vin = MxlVideoInput::new(&pipe, ctx.clone(), vflow).unwrap();
    let ain = MxlAudioInput::new(&pipe, ctx.clone(), aflow).unwrap();
    let mut stages = Vec::new();
    for (name, extra) in [("1 direkt hinter MxlInput", false), ("2 nach convert/scale/rate (channel-player-Kette)", true)] {
        let st = Arc::new(Mutex::new(Stage::default()));
        let (vtail, atail): (gst::Element, gst::Element) = if extra {
            let vc = gst::ElementFactory::make("videoconvert").build().unwrap();
            let vs = gst::ElementFactory::make("videoscale").build().unwrap();
            let vr = gst::ElementFactory::make("videorate").build().unwrap();
            let vcaps = gst::ElementFactory::make("capsfilter").property("caps", gst::Caps::builder("video/x-raw").field("format", "I420").field("framerate", gst::Fraction::new(25, 1)).build()).build().unwrap();
            let ac = gst::ElementFactory::make("audioconvert").build().unwrap();
            let ar = gst::ElementFactory::make("audioresample").build().unwrap();
            let acaps = gst::ElementFactory::make("capsfilter").property("caps", gst::Caps::builder("audio/x-raw").field("format", "F32LE").field("rate", 48000i32).build()).build().unwrap();
            pipe.add_many([&vc, &vs, &vr, &vcaps, &ac, &ar, &acaps]).unwrap();
            let t1 = gst::ElementFactory::make("tee").build().unwrap();
            let t2 = gst::ElementFactory::make("tee").build().unwrap();
            pipe.add_many([&t1, &t2]).unwrap();
            // Eingang → tee → (Stufe 1 | Stufe 2)
            let _ = (&t1, &t2);
            gst::Element::link_many([&vc, &vs, &vr, &vcaps]).unwrap();
            gst::Element::link_many([&ac, &ar, &acaps]).unwrap();
            // Die tees werden unten verlinkt (Eingänge liegen in `vin.tail`/`ain.tail`).
            vc.set_property("qos", false);
            // Rückgabe: Anfang für Verlinkung = vc/ac; Ende = vcaps/acaps
            // (wir geben das Ende zurück; der Anfang wird über `heads` verknüpft)
            stages.push((name, st.clone(), Some((vc, ac)), (vcaps, acaps)));
            continue;
        } else {
            (vin.tail.clone(), ain.tail.clone())
        };
        stages.push((name, st.clone(), None, (vtail, atail)));
    }
    // tees nach den Eingängen
    let vt = gst::ElementFactory::make("tee").build().unwrap();
    let at = gst::ElementFactory::make("tee").build().unwrap();
    pipe.add_many([&vt, &at]).unwrap();
    vin.tail.link(&vt).unwrap();
    ain.tail.link(&at).unwrap();
    for (_, st, heads, (vend, aend)) in &stages {
        let vq = gst::ElementFactory::make("queue").build().unwrap();
        let aq = gst::ElementFactory::make("queue").build().unwrap();
        let vsink = gst_app::AppSink::builder().sync(false).max_buffers(50).build();
        let asink = gst_app::AppSink::builder().sync(false).max_buffers(200).build();
        pipe.add_many([&vq, &aq, vsink.upcast_ref::<gst::Element>(), asink.upcast_ref()]).unwrap();
        vt.link(&vq).unwrap();
        at.link(&aq).unwrap();
        if let Some((vh, ah)) = heads {
            vq.link(vh).unwrap();
            aq.link(ah).unwrap();
        }
        let (vsrc, asrc) = if heads.is_some() { (vend.clone(), aend.clone()) } else { (vq.clone(), aq.clone()) };
        vsrc.link(&vsink).unwrap();
        asrc.link(&asink).unwrap();
        tap(st.clone(), true, &vsink);
        tap(st.clone(), false, &asink);
    }
    vin.activate().unwrap();
    ain.activate().unwrap();
    pipe.set_state(gst::State::Playing).unwrap();
    std::thread::sleep(Duration::from_secs(secs));
    for (name, st, _, _) in &stages {
        let s = st.lock().unwrap();
        let mut d: Vec<f64> = s.aticks.iter().filter_map(|t| s.vflips.iter().min_by_key(|v| (**v as i64 - *t as i64).abs()).map(|v| (*t as i64 - *v as i64) as f64 / 1e6)).filter(|d| d.abs() < 500.0).collect();
        d.sort_by(|x, y| x.partial_cmp(y).unwrap());
        println!("Stufe {name}: Marker-Bilder={}, Ticks={}, Median PTS_a - PTS_v = {:.1} ms", s.vflips.len(), s.aticks.len(), d.get(d.len() / 2).copied().unwrap_or(f64::NAN));
    }
    vin.stop();
    ain.stop();
    std::thread::sleep(Duration::from_millis(300));
    pipe.set_state(gst::State::Null).unwrap();
}
