//! Clip-Export gegen den Testserver mit echter Aufnahme und echtem ffmpeg. (Aufnahme wie in `playback.rs`.)
//! Ursprung der Vorlage: echte GStreamer-Quellen → Schreiber (Segmenter, Warteschlange, Uploader) → Testserver, der die
//! TAMS-Regeln durchsetzt → Leser (Holen, Dekodieren, Takt, Lückenfüllung) → `appsink` statt MXL-Ausgang.
//! Geprüft werden die Zeiten, die am Ausgang ankommen (PTS-Takt und TAI-Meta), nicht Bildinhalte.
//!
//! Klein und kurz (Projektregel „CPU schonen“): 320×180, 25 Bilder/s, Segmente zu 2 s, 8 s Aufnahme; **eine** Aufnahme
//! für alle Prüfungen.

use gstreamer as gst;
use gstreamer::prelude::*;
use omp_mediaio::timebase::tai_now_ns;
use omp_tams::auth::Auth;
use omp_tams::client::{Client, ClientConfig, RetryPolicy, SegmentQuery};
use omp_tams::index::{Rate, ns_to_index};
use omp_tams::testserver::Fake;
use omp_tams::time::{Bound, TimeRange, Timestamp};
use omp_tams_reader::export::{Request, export};
use omp_tams_writer::segmenter::{self, Event, add_audio_branch, add_video_branch};
use omp_tams_writer::spool::Spool;
use omp_tams_writer::uploader::{FlowDef, FlowRegistry, Step, Uploader, audio_flow_body, video_flow_body};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

const VFLOW: &str = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const AFLOW: &str = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const FPS: Rate = Rate { num: 25, den: 1 };
const AUDIO_RATE: Rate = Rate { num: 48000, den: 1 };
const S: i128 = 1_000_000_000;

fn mk_client(f: &Fake) -> Client {
    let mut cfg = ClientConfig::new(f.api(), Auth::None);
    cfg.retry = RetryPolicy { attempts: 2, base_delay: Duration::from_millis(5), max_delay: Duration::from_millis(10) };
    cfg.timeout = Duration::from_secs(5);
    Client::new(cfg).unwrap()
}

/// Nimmt `seconds` auf; der Ursprungs-Index ist die **echte** TAI-Zeit des Starts plus Laufzeit.
fn record(spool: Arc<Spool>, seconds: u64) -> u64 {
    gst::init().unwrap();
    let pipeline = gst::Pipeline::new();
    let vsrc = gst::parse::bin_from_description("videotestsrc is-live=true pattern=ball ! video/x-raw,width=320,height=180,framerate=25/1 ! identity", true).unwrap();
    let asrc = gst::parse::bin_from_description("audiotestsrc is-live=true wave=sine ! audio/x-raw,rate=48000,channels=2 ! identity", true).unwrap();
    pipeline.add_many([&vsrc, &asrc]).unwrap();
    let t0 = tai_now_ns();
    let (vbase, abase) = (ns_to_index(t0, FPS), ns_to_index(t0, AUDIO_RATE));
    let vorigin: segmenter::OriginFn = Arc::new(move |b| b.pts().map(|p| vbase + p.nseconds() * 25 / 1_000_000_000));
    let aorigin: segmenter::OriginFn = Arc::new(move |b| b.pts().map(|p| abase + (p.nseconds() as u128 * 48000 / 1_000_000_000) as u64));
    let v = add_video_branch(&pipeline, vsrc.upcast_ref(), VFLOW, FPS, 2_000_000_000, 500, spool.clone(), vorigin).unwrap();
    let a = add_audio_branch(&pipeline, asrc.upcast_ref(), AFLOW, 48000, 2_000_000_000, 96_000, spool, aorigin).unwrap();
    pipeline.set_state(gst::State::Playing).unwrap();
    let bus = pipeline.bus().unwrap();
    let mut written = 0;
    let mut drain = |until: Instant, stop_on_eos: bool| {
        while Instant::now() < until {
            let Some(m) = bus.timed_pop(gst::ClockTime::from_mseconds(100)) else { continue };
            match m.view() {
                gst::MessageView::Error(e) => panic!("Pipeline-Fehler: {} ({:?})", e.error(), e.debug()),
                gst::MessageView::Eos(_) if stop_on_eos => return,
                _ => {}
            }
            for ev in v.handle_message(&m).into_iter().chain(a.handle_message(&m)) {
                if matches!(ev, Event::Segment { .. }) {
                    written += 1;
                }
            }
        }
    };
    drain(Instant::now() + Duration::from_secs(seconds), false);
    pipeline.send_event(gst::event::Eos::new());
    drain(Instant::now() + segmenter::STOP_EOS_TIMEOUT, true);
    drain(Instant::now() + Duration::from_millis(500), false);
    pipeline.set_state(gst::State::Null).unwrap();
    assert!(written >= 6, "zu wenige Segmente: {written}");
    t0
}


fn probe(file: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("ffprobe").args(["-v", "error"]).args(args).arg(file).output().expect("ffprobe");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}
fn num(s: &str) -> f64 {
    s.lines().next().unwrap_or("").trim().trim_end_matches(',').parse().unwrap_or(f64::NAN)
}
fn frames(file: &std::path::Path) -> u64 {
    num(&probe(file, &["-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"])) as u64
}
fn dur(file: &std::path::Path, stream: &str) -> f64 {
    // Dauer aus den Paketen (Container-Dauer kann gerundet sein): letzter pts_time + duration_time
    let o = probe(file, &["-select_streams", stream, "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0"]);
    let (mut first, mut last_end) = (f64::MAX, 0f64);
    for l in o.lines() {
        let mut it = l.split(',');
        let (Some(p), Some(d)) = (it.next().and_then(|x| x.parse::<f64>().ok()), it.next().and_then(|x| x.parse::<f64>().ok())) else { continue };
        first = first.min(p);
        last_end = last_end.max(p + d);
    }
    last_end - first
}

#[test]
fn export_clip_copy_exact_and_gaps() {
    let dir = std::env::temp_dir().join(format!("omp-tams-export-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let spool = Arc::new(Spool::open(dir.join("spool"), 64 << 20).unwrap());
    let fake = Fake::start();
    let t0 = record(spool.clone(), 8);
    let flows = vec![
        FlowDef { flow_id: VFLOW.into(), body: video_flow_body(VFLOW, "cccccccc-3333-4333-8333-cccccccccccc", "V", 320, 180, 25, 1, Some("progressive"), 2, 500), container: "video/mp2t".into() },
        FlowDef { flow_id: AFLOW.into(), body: audio_flow_body(AFLOW, "dddddddd-4444-4444-8444-dddddddddddd", "A", 48000, 2, 2, 96), container: "video/mp2t".into() },
    ];
    let mut up = Uploader::new(mk_client(&fake), spool.clone(), FlowRegistry::new(spool.clone(), flows), Box::new(tai_now_ns));
    while !matches!(up.step(), Step::Idle) {}
    let c = mk_client(&fake);
    let segs = c.list_segments(VFLOW, &SegmentQuery::default(), 100).unwrap();
    let lo = omp_tams_reader::plan::bounds_ns(&TimeRange::parse(&segs[0].timerange).unwrap()).unwrap().0.unwrap();
    assert!((lo - t0 as i128).abs() < S);
    let out = dir.join("out");
    let stop = AtomicBool::new(false);

    // ---- 1. Stream-Copy: 2 ganze Segmente (4 s), Video + Ton ----------------------------------------------------------
    let req = Request { video: Some(VFLOW.into()), audio: Some(AFLOW.into()), start_ns: lo + 2 * S, end_ns: lo + 6 * S, exact: false };
    let r = export(&c, "ffmpeg", &req, &out, "clip", &stop).unwrap();
    assert!(r.path.ends_with("clip.mp4") && r.path.exists());
    assert_eq!(r.gaps, 0);
    assert_eq!(frames(&r.path), 100, "4 s · 25 Bilder/s");
    let (dv, da) = (dur(&r.path, "v:0"), dur(&r.path, "a:0"));
    assert!((dv - 4.0).abs() < 0.1, "Videodauer {dv}");
    assert!((da - 4.0).abs() < 0.15, "Tondauer {da}");
    assert!((r.to_ns - r.from_ns - 4 * S).abs() < 100_000_000, "Bericht {} ns", r.to_ns - r.from_ns);
    // Zeit läuft lückenlos: Video-Zeitstempel monoton mit 40 ms Raster
    let pts = probe(&r.path, &["-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0"]);
    let v: Vec<f64> = pts.lines().filter_map(|l| l.trim().parse().ok()).collect();
    let mut sorted = v.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    for w in sorted.windows(2) {
        assert!((w[1] - w[0] - 0.04).abs() < 0.005, "Sprung in der Zeitachse: {} → {}", w[0], w[1]);
    }
    assert!(!std::fs::read_dir(&out).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with(".work")), "Arbeitsverzeichnis muss weg sein");

    // ---- 2. exakt: 3 s aus der Mitte, neu kodiert, als MKV ----------------------------------------------------------
    let req = Request { video: Some(VFLOW.into()), audio: Some(AFLOW.into()), start_ns: lo + 2_500_000_000, end_ns: lo + 5_500_000_000, exact: true };
    let r = export(&c, "ffmpeg", &req, &out, "exakt.mkv", &stop).unwrap();
    let n = frames(&r.path);
    assert!((74..=76).contains(&n), "exakt: {n} Bilder statt 75");
    assert!((dur(&r.path, "v:0") - 3.0).abs() < 0.1);

    // ---- 3. Lücke: ein Segment fehlt → eine Lücke wird gemeldet, Datei entsprechend kürzer ------------------------------
    let hole = TimeRange::new(Some(Bound { ts: Timestamp::from_ns(lo + 2 * S), inclusive: true }), Some(Bound { ts: Timestamp::from_ns(lo + 4 * S), inclusive: false }));
    c.delete_segments(VFLOW, &hole).unwrap();
    let req = Request { video: Some(VFLOW.into()), audio: None, start_ns: lo, end_ns: lo + 6 * S, exact: false };
    let r = export(&c, "ffmpeg", &req, &out, "luecke.ts", &stop).unwrap();
    assert_eq!(r.gaps, 1);
    assert_eq!(frames(&r.path), 100, "2 Segmente (4 s) statt 3");

    // ---- 4. Fehlerfälle ----------------------------------------------------------------------------------------------------
    let bad = Request { video: Some(VFLOW.into()), audio: None, start_ns: lo + 100 * S, end_ns: lo + 101 * S, exact: false };
    assert!(export(&c, "ffmpeg", &bad, &out, "leer.mp4", &stop).unwrap_err().contains("keine Aufnahme"));
    assert!(!out.join("leer.mp4").exists());
    assert!(export(&c, "ffmpeg", &req, &out, "../x.mp4", &stop).is_err());
    assert!(export(&c, "/gibt/es/nicht", &req, &out, "y.mp4", &stop).unwrap_err().contains("ffmpeg nicht startbar"));
    std::fs::remove_dir_all(&dir).ok();
}
