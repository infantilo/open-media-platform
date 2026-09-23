//! Mess-Harness für den Zeitbasis-Bug (docs/decisions.md Nachtrag 253-257,
//! 271): speist einen MXL-Video-Flow über `MxlVideoOutput` mit Bildern,
//! deren ANKUNFT wie bei einer Handy-Kamera über WebRTC schwankt
//! (Netz-Bursts, Aussetzer, 30-fps-Quelle in 25-fps-Flow), und misst auf
//! der Leseseite (`MxlVideoInput` → `appsink sync=true`, wie ein Viewer),
//! wie gleichmäßig, in welcher Reihenfolge und mit welcher Latenz die
//! Bilder tatsächlich dargestellt werden. Die Bildnummer steckt im
//! Bildinhalt (Luma zweier Flächen), damit Rücksprünge (veraltete
//! Ringpuffer-Slots) und Wiederholungen sichtbar werden.
//!
//! Läuft in einer eigenen MXL-Domain (kein Eingriff in den Live-Betrieb).
//!
//! Aufruf:
//!   cargo run --release -p omp-mediaio --features mxl --example timebase_harness -- <steady|phone|gaps> <sekunden>
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput, MxlVideoOutput};

const W: usize = 320;
const H: usize = 180;

fn frame(counter: u64) -> Vec<u8> {
    // I420: Y-Ebene links = Zähler mod 200, rechts = Zähler / 200 mod 200.
    let mut buf = vec![128u8; W * H * 3 / 2];
    let lo = 16 + (counter % 200) as u8;
    let hi = 16 + ((counter / 200) % 200) as u8;
    for y in 0..H {
        for x in 0..W {
            buf[y * W + x] = if x < W / 2 { lo } else { hi };
        }
    }
    buf
}

fn decode(y_plane: &[u8], stride: usize) -> u64 {
    let lo = y_plane[(H / 2) * stride + W / 4] as i64 - 16;
    let hi = y_plane[(H / 2) * stride + 3 * W / 4] as i64 - 16;
    (hi.clamp(0, 199) as u64) * 200 + lo.clamp(0, 199) as u64
}

struct Pattern {
    capture_interval_ms: f64,
    // (capture_ms) -> arrival_ms
    arrival: Box<dyn Fn(f64, u64) -> f64 + Send>,
}

fn pattern(name: &str) -> Pattern {
    match name {
        "steady" => Pattern { capture_interval_ms: 40.0, arrival: Box::new(|c, _| c + 20.0) },
        // Handy über WebRTC: 30 fps, Netz hält alle 300 ms ~120 ms zurück
        // und gibt dann im Burst frei, dazu kleiner Jitter.
        "phone" => Pattern {
            capture_interval_ms: 1000.0 / 30.0,
            arrival: Box::new(|c, n| {
                let base = c + 20.0 + ((n * 7919) % 11) as f64; // 0-10 ms Jitter
                let phase = c % 300.0;
                if phase < 120.0 { c - phase + 120.0 + 20.0 } else { base }
            }),
        },
        // Wie "phone", zusätzlich alle 7 s ein 700-ms-Aussetzer (WLAN-Hänger).
        "gaps" => Pattern {
            capture_interval_ms: 1000.0 / 30.0,
            arrival: Box::new(|c, n| {
                let base = c + 20.0 + ((n * 7919) % 11) as f64;
                let phase = c % 300.0;
                let a = if phase < 120.0 { c - phase + 140.0 } else { base };
                let g = c % 7000.0;
                if g < 700.0 { c - g + 720.0 } else { a }
            }),
        },
        other => panic!("unknown scenario {other}"),
    }
}

fn pseudo_uuid() -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let h = format!("{:032x}", n ^ 0x5a5a_1234_9876_abcd_0000_ffff_1111_2222u128);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn percentile(v: &mut [f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() - 1) as f64 * p).round() as usize]
}

fn main() {
    gst::init().unwrap();
    let args: Vec<String> = std::env::args().collect();
    let scenario = args.get(1).map(String::as_str).unwrap_or("phone").to_string();
    let secs: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(20);
    let domain = "/dev/shm/omp-mxl-timebase-harness";
    std::fs::create_dir_all(domain).unwrap();
    let ctx = Arc::new(MxlContext::new(domain).expect("MxlContext"));
    let flow_id = pseudo_uuid();

    // ---- Schreibseite ------------------------------------------------------------------------
    let wpipe = gst::Pipeline::new();
    let appsrc = gst_app::AppSrc::builder()
        .is_live(true)
        .format(gst::Format::Time)
        .caps(
            &gst::Caps::builder("video/x-raw")
                .field("format", "I420")
                .field("width", W as i32)
                .field("height", H as i32)
                .field("framerate", gst::Fraction::new(0, 1))
                .build(),
        )
        .build();
    wpipe.add(&appsrc).unwrap();
    let _out = MxlVideoOutput::new(
        &wpipe,
        appsrc.upcast_ref(),
        ctx.clone(),
        &flow_id,
        "timebase-harness",
        W as u32,
        H as u32,
        25,
        1,
        Arc::new(AtomicU64::new(0)),
    )
    .expect("MxlVideoOutput");
    omp_mediaio::Output::set_active(&_out, true);
    wpipe.set_state(gst::State::Playing).unwrap();

    let start = Instant::now();
    let capture_wall: Arc<Mutex<HashMap<u64, f64>>> = Arc::new(Mutex::new(HashMap::new()));
    let pat = pattern(&scenario);
    let cw = capture_wall.clone();
    let total_ms = secs as f64 * 1000.0 + 2000.0;
    let feeder = std::thread::spawn(move || {
        // Pro Bild: Aufnahmezeit c, Ankunftszeit a(c) — Bilder werden in
        // Ankunfts-Reihenfolge (monoton) übergeben, PTS = Aufnahmezeit
        // (so liefert ein RTP-Jitterbuffer die Zeitstempel).
        let mut n = 0u64;
        let mut events: Vec<(f64, f64, u64)> = Vec::new();
        let mut c = 0.0;
        while c < total_ms {
            events.push(((pat.arrival)(c, n), c, n));
            c += pat.capture_interval_ms;
            n += 1;
        }
        let mut last_arrival = 0.0f64;
        for (a, c, n) in events {
            let a = a.max(last_arrival);
            last_arrival = a;
            let target = start + Duration::from_micros((a * 1000.0) as u64);
            let now = Instant::now();
            if target > now {
                std::thread::sleep(target - now);
            }
            cw.lock().unwrap().insert(n, c);
            let mut b = gst::Buffer::from_slice(frame(n));
            {
                let bm = b.get_mut().unwrap();
                bm.set_pts(gst::ClockTime::from_nseconds((c * 1e6) as u64));
                bm.set_duration(gst::ClockTime::from_nseconds((pat.capture_interval_ms * 1e6) as u64));
            }
            if appsrc.push_buffer(b).is_err() {
                break;
            }
        }
    });

    // Flow muss existieren, bevor der Leser ihn öffnet.
    std::thread::sleep(Duration::from_millis(1500));

    // Optional: Durchreich-Hop wie ein omp-switcher (liest A, schreibt B
    // in EINER eigenen Pipeline); gemessen wird dann B.
    let hop = std::env::var("HARNESS_HOP").is_ok();
    let (flow_id, _hop_keep) = if hop {
        let b_id = pseudo_uuid();
        let hpipe = gst::Pipeline::new();
        let hin = MxlVideoInput::new(&hpipe, ctx.clone(), &flow_id).expect("hop MxlVideoInput");
        let hout = MxlVideoOutput::new(&hpipe, &hin.tail, ctx.clone(), &b_id, "timebase-hop", W as u32, H as u32, 25, 1, Arc::new(AtomicU64::new(0)))
            .expect("hop MxlVideoOutput");
        omp_mediaio::Output::set_active(&hout, true);
        hpipe.set_state(gst::State::Playing).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        (b_id, Some((hpipe, hin, hout)))
    } else {
        (flow_id, None)
    };
    if hop {
        let api = mxl::load_api("libmxl.so").unwrap();
        let inst = mxl::MxlInstance::new(api, domain, "").unwrap();
        let rate = mxl_sys::Rational { numerator: 25, denominator: 1 };
        println!("HOP flow B created; now_index={}", inst.get_current_index(&rate));
    }

    // Optional: Roh-Leser direkt über libmxl (ohne GStreamer) — welcher
    // Bildzähler steht in welchem Grain-Index? Trennt Schreib- von
    // Lese-Effekten.
    let raw = std::env::var("HARNESS_RAW").is_ok().then(|| {
        let fid = flow_id.clone();
        std::thread::spawn(move || {
            let api = mxl::load_api("libmxl.so").unwrap();
            let inst = mxl::MxlInstance::new(api, domain, "").unwrap();
            let reader = inst.create_flow_reader(&fid).unwrap().to_grain_reader().unwrap();
            let rate = mxl_sys::Rational { numerator: 25, denominator: 1 };
            let mut index = inst.get_current_index(&rate);
            let mut out: Vec<(u64, u64)> = Vec::new();
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_secs(8) {
                match reader.get_grain_non_blocking(index) {
                    Ok(g) if g.index == index => {
                        // v210: Zeilen-Stride = ceil(W/48)*128; Y0 in Bits 10-19 des 1. Worts je 16-Byte-Block.
                        let stride = W.div_ceil(48) * 128;
                        let y_at = |x: usize| {
                            let off = (H / 2) * stride + (x / 6) * 16;
                            let w = u32::from_le_bytes(g.payload[off..off + 4].try_into().unwrap());
                            (((w >> 10) & 0x3ff) as i64 + 2) / 4 - 16
                        };
                        let c = (y_at(3 * W / 4).clamp(0, 199) as u64) * 200 + y_at(W / 4).clamp(0, 199) as u64;
                        out.push((index, c));
                        index += 1;
                    }
                    Ok(_) => index += 1,
                    Err(mxl::Error::OutOfRangeTooLate) => index = inst.get_current_index(&rate),
                    Err(_) => std::thread::sleep(Duration::from_millis(2)),
                }
            }
            out
        })
    });

    // ---- Leseseite (wie omp-viewer) ----------------------------------------------------------
    let rpipe = gst::Pipeline::new();
    let input = MxlVideoInput::new(&rpipe, ctx.clone(), &flow_id).expect("MxlVideoInput");
    let conv = gst::ElementFactory::make("videoconvert").build().unwrap();
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("video/x-raw").field("format", "I420").build())
        .build()
        .unwrap();
    let sink = gst_app::AppSink::builder().sync(true).max_buffers(2).drop(false).build();
    rpipe.add_many([&conv, &caps, sink.upcast_ref()]).unwrap();
    gst::Element::link_many([&input.tail, &conv, &caps, sink.upcast_ref()]).unwrap();
    let src_pts: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let sp = src_pts.clone();
        input.elements[0].static_pad("src").unwrap().add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            if let Some(b) = info.buffer() {
                sp.lock().unwrap().push(b.pts().map(|p| p.nseconds()).unwrap_or(0));
            }
            gst::PadProbeReturn::Ok
        });
    }
    rpipe.set_state(gst::State::Playing).unwrap();

    let measure_from = Instant::now();
    let mut rows: Vec<(f64, u64, u64)> = Vec::new(); // (wall_ms, pts_ns, counter)
    while measure_from.elapsed() < Duration::from_secs(secs) {
        let Some(sample) = sink.try_pull_sample(gst::ClockTime::from_mseconds(500)) else { continue };
        let wall = start.elapsed().as_secs_f64() * 1000.0;
        let buf = sample.buffer().unwrap();
        let map = buf.map_readable().unwrap();
        // I420, Breite 320 (durch 4 teilbar) → Y-Stride = Breite.
        let counter = decode(map.as_slice(), W);
        rows.push((wall, buf.pts().map(|p| p.nseconds()).unwrap_or(0), counter));
    }
    if let Some(h) = raw {
        let v = h.join().unwrap();
        let dups = v.windows(2).filter(|w| w[1].1 == w[0].1).count();
        let gaps = v.windows(2).filter(|w| w[1].0 != w[0].0 + 1).count();
        println!("RAW mxl grains={} same-content-in-consecutive-grains={dups} index-gaps={gaps}", v.len());
        println!("RAW sample: {:?}", v[40.min(v.len())..80.min(v.len())].iter().map(|x| x.1).collect::<Vec<_>>());
    }
    {
        let v = src_pts.lock().unwrap();
        let steps: Vec<i64> = v.windows(2).map(|w| (w[1] as i64 - w[0] as i64) / 1_000_000).collect();
        let mut hist: std::collections::BTreeMap<i64, usize> = Default::default();
        for st in &steps { *hist.entry(*st).or_default() += 1; }
        println!("appsrc-out buffers={} pts-step-ms histogram={hist:?}", v.len());
        let vr = &input.tail;
        println!("reader videorate: in={} out={} drop={} duplicate={}", vr.property::<u64>("in"), vr.property::<u64>("out"), vr.property::<u64>("drop"), vr.property::<u64>("duplicate"));
    }
    rpipe.set_state(gst::State::Null).unwrap();
    wpipe.set_state(gst::State::Null).unwrap();
    drop(feeder);

    // ---- Auswertung --------------------------------------------------------------------------
    let caps_map = capture_wall.lock().unwrap();
    let mut intervals: Vec<f64> = rows.windows(2).map(|w| w[1].0 - w[0].0).collect();
    let stalls: Vec<f64> = intervals.iter().copied().filter(|d| *d > 120.0).collect();
    let backward = rows.windows(2).filter(|w| w[1].2 < w[0].2).count();
    let repeats = rows.windows(2).filter(|w| w[1].2 == w[0].2).count();
    let mut lat: Vec<f64> = rows.iter().filter_map(|r| caps_map.get(&r.2).map(|c| r.0 - c)).collect();
    let pts_ms: Vec<f64> = rows.iter().map(|r| r.1 as f64 / 1e6).collect();
    let mut pts_dev: Vec<f64> = rows.windows(2).zip(pts_ms.windows(2)).map(|(w, p)| ((w[1].0 - w[0].0) - (p[1] - p[0])).abs()).collect();
    let dur = rows.last().map(|r| r.0).unwrap_or(0.0) - rows.first().map(|r| r.0).unwrap_or(0.0);
    println!("scenario={scenario} frames={} fps={:.2}", rows.len(), rows.len() as f64 / (dur / 1000.0).max(0.001));
    println!(
        "render interval ms: p50={:.1} p95={:.1} p99={:.1} max={:.1}",
        percentile(&mut intervals.clone(), 0.5),
        percentile(&mut intervals.clone(), 0.95),
        percentile(&mut intervals.clone(), 0.99),
        percentile(&mut intervals, 1.0)
    );
    println!("stalls >120ms: {} (total {:.0} ms)", stalls.len(), stalls.iter().sum::<f64>());
    println!("backward jumps (stale frames): {backward}   repeats: {repeats}");
    println!("pts-vs-wall mismatch ms: p95={:.1} max={:.1}", percentile(&mut pts_dev.clone(), 0.95), percentile(&mut pts_dev, 1.0));
    println!("latency capture->render ms: p50={:.0} p95={:.0} max={:.0}", percentile(&mut lat.clone(), 0.5), percentile(&mut lat.clone(), 0.95), percentile(&mut lat, 1.0));
    if std::env::var("HARNESS_DUMP").is_ok() {
        for r in &rows {
            println!("ROW {:.1} {} {}", r.0, r.1, r.2);
        }
    }
}
