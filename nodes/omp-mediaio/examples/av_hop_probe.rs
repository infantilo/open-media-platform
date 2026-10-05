//! (Mit `REC_FILE=/pfad.mkv` zusätzlich Aufnahme wie omp-recorder aus denselben Eingängen: x264enc/avenc_aac → matroskamux.)
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
    let mut mux_opt = None;
    if let Ok(path) = std::env::var("REC_FILE") {
        let mux = gst::ElementFactory::make("matroskamux").property("streamable", true).build().unwrap();
        let fs = gst::ElementFactory::make("filesink").property("location", path.as_str()).property("sync", false).build().unwrap();
        let vq0 = gst::ElementFactory::make("queue").build().unwrap();
        let vc = gst::ElementFactory::make("videoconvert").build().unwrap();
        let enc = gst::ElementFactory::make("x264enc").property("bitrate", 4000u32).property("key-int-max", 50u32).build().unwrap();
        if std::env::var("REC_THREADS1").is_ok() { enc.set_property("threads", 1u32); }
        if std::env::var("REC_SLICED").is_ok() { enc.set_property("sliced-threads", true); }
        enc.set_property_from_str("speed-preset", "veryfast");
        enc.set_property_from_str("tune", "zerolatency");
        let parse = gst::ElementFactory::make("h264parse").property("config-interval", 1i32).build().unwrap();
        let vq1 = gst::ElementFactory::make("queue").build().unwrap();
        let aq0 = gst::ElementFactory::make("queue").build().unwrap();
        let ac = gst::ElementFactory::make("audioconvert").build().unwrap();
        let ars = gst::ElementFactory::make("audioresample").build().unwrap();
        let raw = std::env::var("REC_RAW").is_ok();
        let aenc = if raw { gst::ElementFactory::make("identity").build().unwrap() } else { gst::ElementFactory::make("avenc_aac").property("bitrate", 192000i32).build().unwrap() };
        let aparse = if raw { gst::ElementFactory::make("identity").build().unwrap() } else { gst::ElementFactory::make("aacparse").build().unwrap() };
        let aq1 = gst::ElementFactory::make("queue").build().unwrap();
        pipe.add_many([&mux, &fs, &vq0, &vc, &enc, &parse, &vq1, &aq0, &ac, &ars, &aenc, &aparse, &aq1]).unwrap();
        mux.link(&fs).unwrap();
        // REC_NOQ=1: wie omp-recorder KEINE Queues vor den Encodern (Tee → direkt convert).
        if std::env::var("REC_NOQ").is_ok() {
            vt.link(&vc).unwrap();
            gst::Element::link_many([&vc, &enc, &parse, &vq1]).unwrap();
            at.link(&ac).unwrap();
            gst::Element::link_many([&ac, &ars, &aenc, &aparse, &aq1]).unwrap();
        } else {
            vt.link(&vq0).unwrap();
            gst::Element::link_many([&vq0, &vc, &enc, &parse, &vq1]).unwrap();
            at.link(&aq0).unwrap();
            gst::Element::link_many([&aq0, &ac, &ars, &aenc, &aparse, &aq1]).unwrap();
        }
        for (name, el) in [("enc-in", &vc), ("enc-out", &parse)] {
            let cnt = Arc::new(std::sync::atomic::AtomicU32::new(0));
            let name = name.to_string();
            let pad = if name == "enc-in" { el.static_pad("sink").unwrap() } else { el.static_pad("src").unwrap() };
            pad.add_probe(gst::PadProbeType::BUFFER, move |_p, info| {
                if let Some(gst::PadProbeData::Buffer(b)) = &info.data
                    && cnt.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < 4
                {
                    eprintln!("VENC {name} pts={:?} dts={:?}", b.pts(), b.dts());
                }
                gst::PadProbeReturn::Ok
            });
        }
        for (name, q) in [("video", &vq1), ("audio", &aq1)] {
            let first = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let name = name.to_string();
            q.static_pad("src").unwrap().add_probe(gst::PadProbeType::BUFFER, move |_p, info| {
                if let Some(gst::PadProbeData::Buffer(b)) = &info.data
                    && !first.swap(true, std::sync::atomic::Ordering::Relaxed)
                {
                    eprintln!("MUXIN {name} first pts={:?} dts={:?}", b.pts(), b.dts());
                }
                gst::PadProbeReturn::Ok
            });
        }
        vq1.static_pad("src").unwrap().link(&mux.request_pad_simple("video_%u").unwrap()).unwrap();
        aq1.static_pad("src").unwrap().link(&mux.request_pad_simple("audio_%u").unwrap()).unwrap();
        mux_opt = Some(mux);
    }
    vin.activate().unwrap();
    ain.activate().unwrap();
    pipe.set_state(gst::State::Playing).unwrap();
    std::thread::sleep(Duration::from_secs(secs));
    for (name, st, _, _) in &stages {
        let s = st.lock().unwrap();
        let mut d: Vec<f64> = s.aticks.iter().filter_map(|t| s.vflips.iter().min_by_key(|v| (**v as i64 - *t as i64).abs()).map(|v| (*t as i64 - *v as i64) as f64 / 1e6)).filter(|d| d.abs() < 500.0).collect();
        d.sort_by(|x, y| x.partial_cmp(y).unwrap());
        println!("abs PTS first flips(s) {:?} ticks {:?}", s.vflips.iter().take(4).map(|v| *v as f64 / 1e9).collect::<Vec<_>>(), s.aticks.iter().take(4).map(|v| *v as f64 / 1e9).collect::<Vec<_>>());
        println!("Stufe {name}: Marker-Bilder={}, Ticks={}, Median PTS_a - PTS_v = {:.1} ms", s.vflips.len(), s.aticks.len(), d.get(d.len() / 2).copied().unwrap_or(f64::NAN));
    }
    if mux_opt.is_some() {
        pipe.send_event(gst::event::Eos::new());
        let _ = pipe.bus().unwrap().timed_pop_filtered(gst::ClockTime::from_seconds(5), &[gst::MessageType::Eos, gst::MessageType::Error]);
    }
    vin.stop();
    ain.stop();
    std::thread::sleep(Duration::from_millis(300));
    pipe.set_state(gst::State::Null).unwrap();
}
