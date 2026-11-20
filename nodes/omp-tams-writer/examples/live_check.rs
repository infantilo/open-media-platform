//! Livetest 105.3 mit **echtem MXL**: zwei Echtzeit-Schreiber (Video 320×180@25, Audio 48 kHz) → MXL-Domain →
//! `omp-tams-writer`-Laufzeit (Quelltext der Bibliothek) → Warteschlange → Uploader → Testserver mit den TAMS-Regeln.
//! Prüft Zeitachse (lückenlos, ohne Überlappung), Zeitbezug zur MXL-Uhr und die Formeln gegen `libmxl`.
//!
//!   cargo run -p omp-tams-writer --example live_check -- <sekunden>
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};
use omp_tams::auth::Auth;
use omp_tams::client::{Client, ClientConfig, SegmentQuery};
use omp_tams::index::{Rate, index_to_ns};
use omp_tams::testserver::Fake;
use omp_tams::time::{TimeRange, Timestamp};
use omp_tams_writer::runtime;
use omp_tams_writer::spool::Spool;
use omp_tams_writer::uploader::{FlowRegistry, Step, Uploader};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

fn uuid(salt: u128) -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let h = format!("{:032x}", n ^ salt);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn main() {
    gst::init().unwrap();
    let secs: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(8);
    let domain = format!("/dev/shm/omp-mxl-tamscheck-{}", std::process::id());
    let spool_dir = format!("/tmp/omp-tamscheck-{}", std::process::id());
    std::fs::create_dir_all(&domain).unwrap();
    let ctx = Arc::new(MxlContext::new(&domain).unwrap());
    let (vid, aid) = (uuid(11), uuid(12));

    // --- Formeln gegen libmxl (Stichprobe über übliche Raten) ---
    for (n, d) in [(25u32, 1u32), (50, 1), (30000, 1001), (60000, 1001), (48000, 1)] {
        let rate = Rate::new(n, d).unwrap();
        for idx in [0u64, 1, 2, 1000, 123_456_789, 1_790_000_000u64 * n as u64 / d as u64] {
            let lib = ctx.index_to_ns(idx, n, d).expect("libmxl index_to_ns");
            assert_eq!(index_to_ns(idx, rate), lib, "index_to_ns weicht von libmxl ab ({n}/{d}, Index {idx})");
            let back_lib = ctx.ns_to_index(lib, n, d).unwrap();
            assert_eq!(omp_tams::index::ns_to_index(lib, rate), back_lib, "ns_to_index weicht ab ({n}/{d})");
        }
        for ns in [0u64, 1, 19_999_999, 20_000_000, 33_366_666, 1_790_000_000_123_456_789] {
            assert_eq!(omp_tams::index::ns_to_index(ns, rate), ctx.ns_to_index(ns, n, d).unwrap(), "ns_to_index({ns}) bei {n}/{d}");
        }
    }
    println!("OK: index_to_ns/ns_to_index stimmen mit libmxl überein");

    // --- Quellen: Echtzeit-Schreiber in die MXL-Domain ---
    let wp = gst::Pipeline::new();
    let vsrc = gst_app::AppSrc::builder().is_live(true).format(gst::Format::Time)
        .caps(&gst::Caps::builder("video/x-raw").field("format", "I420").field("width", 320i32).field("height", 180i32).field("framerate", gst::Fraction::new(0, 1)).build()).build();
    let asrc = gst_app::AppSrc::builder().is_live(true).format(gst::Format::Time)
        .caps(&gst::Caps::builder("audio/x-raw").field("format", "F32LE").field("rate", 48000i32).field("channels", 2i32).field("layout", "interleaved").build()).build();
    wp.add_many([&vsrc, &asrc]).unwrap();
    let vout = MxlVideoOutput::new(&wp, vsrc.upcast_ref(), ctx.clone(), &vid, "tams-video", 320, 180, 25, 1, Arc::new(AtomicU64::new(0))).unwrap();
    let aout = MxlAudioOutput::new(&wp, asrc.upcast_ref(), ctx.clone(), &aid, "tams-audio", 48000, 2).unwrap();
    omp_mediaio::Output::set_active(&vout, true);
    omp_mediaio::Output::set_active(&aout, true);
    wp.set_state(gst::State::Playing).unwrap();
    let start = Instant::now();
    let total = (secs as f64 + 6.0) * 1000.0;
    let feed = |src: gst_app::AppSrc, step: f64, bytes: usize, grey: u8| {
        std::thread::spawn(move || {
            let (mut n, mut c) = (0u64, 0.0f64);
            while c < total {
                let t = start + Duration::from_micros(((c + 10.0) * 1000.0) as u64);
                if t > Instant::now() {
                    std::thread::sleep(t - Instant::now());
                }
                let mut b = gst::Buffer::from_slice(vec![grey.wrapping_add((n % 200) as u8); bytes]);
                {
                    let m = b.get_mut().unwrap();
                    m.set_pts(gst::ClockTime::from_nseconds((c * 1e6) as u64));
                    m.set_duration(gst::ClockTime::from_nseconds((step * 1e6) as u64));
                }
                if src.push_buffer(b).is_err() {
                    break;
                }
                n += 1;
                c = n as f64 * step;
            }
        })
    };
    let _f1 = feed(vsrc, 40.0, 320 * 180 * 3 / 2, 40);
    let _f2 = feed(asrc, 10.0, 480 * 2 * 4, 0);
    std::thread::sleep(Duration::from_millis(1500));

    // --- Schreiber-Laufzeit + Testserver ---
    let fake = Fake::start();
    let spool = Arc::new(Spool::open(&spool_dir, 256 << 20).unwrap());
    let registry = FlowRegistry::new(spool.clone(), vec![]);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<runtime::Event>();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let cfg = runtime::Config { domain: domain.clone(), spool: spool.clone(), registry: registry.clone(), segment_s: 2, retention_s: 0, flow_retention_s: 0, video_kbps: 500, audio_bps: 96_000, uploader_status: Default::default() };
    let sd = shutdown.clone();
    let th = std::thread::spawn(move || runtime::run(cfg, tx, sd, ready_tx, Arc::new(AtomicU64::new(0))));
    let h = ready_rx.blocking_recv().unwrap().unwrap();
    h.connect_video(vid.clone());
    h.connect_audio(aid.clone());
    std::thread::sleep(Duration::from_millis(500));
    let tai_before = omp_mediaio::timebase::tai_now_ns();
    h.start().unwrap();
    std::thread::sleep(Duration::from_secs(secs));
    println!("status={} media_ready={}", h.status().as_str(), h.media_ready());
    h.stop().unwrap();
    let tai_after = omp_mediaio::timebase::tai_now_ns();
    shutdown.store(true, Ordering::Relaxed);
    let _ = th.join();
    wp.set_state(gst::State::Null).unwrap();
    while let Ok(runtime::Event::Warning(w)) = rx.try_recv() {
        println!("Warnung: {w}");
    }
    println!("Segmente geschrieben: {}, verworfen: {}", h.counters.segments_written.load(Ordering::Relaxed), h.counters.segments_dropped.load(Ordering::Relaxed));

    // --- Hochladen ---
    let mut cfgc = ClientConfig::new(fake.api(), Auth::None);
    cfgc.timeout = Duration::from_secs(5);
    let mut up = Uploader::new(Client::new(cfgc.clone()).unwrap(), spool.clone(), registry, Box::new(omp_mediaio::timebase::tai_now_ns));
    let mut ok = 0;
    loop {
        match up.step() {
            Step::Idle => break,
            Step::Registered => ok += 1,
            other => panic!("Uploader: {other:?}"),
        }
    }
    println!("registriert: {ok}, Lag {} ms", up.status.lag_ms.load(Ordering::Relaxed));
    assert!(ok >= 4, "zu wenige Segmente: {ok}");

    // --- Prüfung ---
    let c = Client::new(cfgc).unwrap();
    for (flow, name, rate) in [(&vid, "Video", Rate::new(25, 1).unwrap()), (&aid, "Audio", Rate::new(48000, 1).unwrap())] {
        let segs = c.list_segments(flow, &SegmentQuery::default(), 1000).unwrap();
        let mut prev_end: Option<u64> = None;
        let mut starts = vec![];
        for s in &segs {
            let TimeRange::Range { start: Some(a), end: Some(b) } = TimeRange::parse(&s.timerange).unwrap() else { panic!() };
            let (a, b) = (a.ts.ns() as u64, b.ts.ns() as u64);
            if let Some(p) = prev_end {
                assert_eq!(p, a, "{name}: Lücke/Überlappung bei {}", s.timerange);
            }
            assert_eq!(index_to_ns(omp_tams::index::ns_to_index(a, rate), rate), a, "{name}: nicht auf dem Raster");
            prev_end = Some(b);
            starts.push(a);
            println!("  {name} {} → Anfang {:+.3} s, Ende {:+.3} s (relativ zum Start der Aufnahme)", s.timerange, (a as f64 - tai_before as f64) / 1e9, (b as f64 - tai_before as f64) / 1e9);
        }
        let first = starts[0];
        // Zeitbezug zur MXL-Uhr: erstes Segment beginnt kurz nach dem Start der Aufnahme (und nicht in der Zukunft)
        assert!(first + 2_000_000_000 >= tai_before && first <= tai_after + 2_000_000_000, "{name}: Anfang {first} liegt nicht im Aufnahmefenster [{tai_before}, {tai_after}]");
        let covered = prev_end.unwrap() - first;
        println!("{name}: {} Segmente, {:.2} s abgedeckt, Anfang {:.3} s nach Start", segs.len(), covered as f64 / 1e9, (first as f64 - tai_before as f64) / 1e9);
        assert!(covered as f64 / 1e9 > secs as f64 * 0.7, "{name}: zu wenig abgedeckt");
    }
    // Video und Audio liegen auf derselben Zeitachse
    let v0 = c.list_segments(&vid, &SegmentQuery::default(), 10).unwrap()[0].timerange.clone();
    let a0 = c.list_segments(&aid, &SegmentQuery::default(), 10).unwrap()[0].timerange.clone();
    let st = |s: &str| match TimeRange::parse(s).unwrap() { TimeRange::Range { start: Some(a), .. } => a.ts, _ => Timestamp::ZERO };
    let diff = (st(&v0).ns() - st(&a0).ns()).abs();
    println!("Anfang Video − Audio: {:.1} ms", diff as f64 / 1e6);
    assert!(diff < 1_000_000_000, "Video und Audio beginnen mehr als 1 s auseinander");
    println!("LIVETEST OK");
    let _ = std::fs::remove_dir_all(&domain);
    let _ = std::fs::remove_dir_all(&spool_dir);
}
