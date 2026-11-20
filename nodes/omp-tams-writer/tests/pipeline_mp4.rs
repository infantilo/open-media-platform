//! Fragmentiertes MP4 mit Init-Segment (Kapitel 105.3b, AppNote 0024): echte GStreamer-Quellen → `qtmux` → Segmente +
//! wiederverwendetes Init-Object → Testserver. Geprüft mit `ffprobe` an der Verkettung Init + Segment.

use gstreamer as gst;
use gstreamer::prelude::*;
use omp_tams::auth::Auth;
use omp_tams::client::{Client, ClientConfig, RetryPolicy, SegmentQuery};
use omp_tams::index::{Rate, ns_to_index};
use omp_tams::testserver::Fake;
use omp_tams::time::{TimeRange, Timestamp};
use omp_tams_writer::segmenter::{self, Event, add_audio_branch_mp4, add_video_branch_mp4};
use omp_tams_writer::spool::Spool;
use omp_tams_writer::uploader::{FlowDef, FlowRegistry, Step, Uploader, audio_flow_body, to_mp4_body, video_flow_body};
use std::sync::Arc;
use std::time::{Duration, Instant};

const VFLOW: &str = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const AFLOW: &str = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const BASE_TAI_NS: u64 = 1_790_000_000_000_000_000;
const FPS: Rate = Rate { num: 25, den: 1 };
const AUDIO_RATE: Rate = Rate { num: 48000, den: 1 };

fn client(f: &Fake) -> Client {
    let mut cfg = ClientConfig::new(f.api(), Auth::None);
    cfg.retry = RetryPolicy { attempts: 2, base_delay: Duration::from_millis(5), max_delay: Duration::from_millis(10) };
    cfg.timeout = Duration::from_secs(5);
    Client::new(cfg).unwrap()
}

fn flows() -> Vec<FlowDef> {
    let (vb, vc) = to_mp4_body(video_flow_body(VFLOW, "cccccccc-3333-4333-8333-cccccccccccc", "V", 320, 180, 25, 1, Some("progressive"), 2, 500), false);
    let (ab, ac) = to_mp4_body(audio_flow_body(AFLOW, "dddddddd-4444-4444-8444-dddddddddddd", "A", 48000, 2, 2, 96), true);
    vec![FlowDef { flow_id: VFLOW.into(), body: vb, container: vc }, FlowDef { flow_id: AFLOW.into(), body: ab, container: ac }]
}

fn record(spool: Arc<Spool>, seconds: u64) -> Vec<Event> {
    gst::init().unwrap();
    let pipeline = gst::Pipeline::new();
    let vsrc = gst::parse::bin_from_description("videotestsrc is-live=true pattern=ball ! video/x-raw,width=320,height=180,framerate=25/1 ! identity", true).unwrap();
    let asrc = gst::parse::bin_from_description("audiotestsrc is-live=true wave=sine ! audio/x-raw,rate=48000,channels=2 ! identity", true).unwrap();
    pipeline.add_many([&vsrc, &asrc]).unwrap();
    let (vbase, abase) = (ns_to_index(BASE_TAI_NS, FPS), ns_to_index(BASE_TAI_NS, AUDIO_RATE));
    let vorigin: segmenter::OriginFn = Arc::new(move |b| b.pts().map(|p| vbase + p.nseconds() * 25 / 1_000_000_000));
    let aorigin: segmenter::OriginFn = Arc::new(move |b| b.pts().map(|p| abase + (p.nseconds() as u128 * 48000 / 1_000_000_000) as u64));
    let v = add_video_branch_mp4(&pipeline, vsrc.upcast_ref(), VFLOW, FPS, 2_000_000_000, 500, spool.clone(), vorigin).unwrap();
    let a = add_audio_branch_mp4(&pipeline, asrc.upcast_ref(), AFLOW, 48000, 2_000_000_000, 96_000, spool, aorigin).unwrap();
    pipeline.set_state(gst::State::Playing).unwrap();
    let bus = pipeline.bus().unwrap();
    let mut events = Vec::new();
    let mut drain = |until: Instant, stop_on_eos: bool| {
        while Instant::now() < until {
            if let Some(m) = bus.timed_pop(gst::ClockTime::from_mseconds(100)) {
                match m.view() {
                    gst::MessageView::Error(e) => panic!("Pipeline-Fehler: {} ({:?})", e.error(), e.debug()),
                    gst::MessageView::Eos(_) if stop_on_eos => {
                        events.extend(v.drain_events());
                        events.extend(a.drain_events());
                        return;
                    }
                    _ => {}
                }
            }
            events.extend(v.drain_events());
            events.extend(a.drain_events());
        }
    };
    drain(Instant::now() + Duration::from_secs(seconds), false);
    pipeline.send_event(gst::event::Eos::new());
    drain(Instant::now() + segmenter::STOP_EOS_TIMEOUT, true);
    drain(Instant::now() + Duration::from_millis(500), false);
    pipeline.set_state(gst::State::Null).unwrap();
    events
}

fn probe(args: &[&str], file: &std::path::Path) -> String {
    let out = std::process::Command::new("ffprobe").args(["-v", "error"]).args(args).arg(file).output().expect("ffprobe");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn fragmented_mp4_with_reused_init_segment() {
    let dir = std::env::temp_dir().join(format!("omp-tams-mp4-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let spool = Arc::new(Spool::open(&dir, 64 << 20).unwrap());
    let fake = Fake::start();
    let events = record(spool.clone(), 8);
    let dropped: Vec<_> = events.iter().filter(|e| matches!(e, Event::Dropped { .. })).collect();
    assert!(dropped.is_empty(), "verworfen: {dropped:?}");
    let written = events.iter().filter(|e| matches!(e, Event::Segment { .. })).count();
    assert!(written >= 6, "erwartet mindestens 3 Video- und 3 Audio-Segmente, waren {written}: {events:?}");

    let mut up = Uploader::new(client(&fake), spool.clone(), FlowRegistry::new(spool.clone(), flows()), Box::new(|| BASE_TAI_NS + 10_000_000_000));
    let mut ok = 0;
    for _ in 0..200 {
        match up.step() {
            Step::Idle => break,
            Step::Registered => ok += 1,
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(ok, written);
    assert_eq!(spool.pending().len(), 0);
    assert!(std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).all(|e| e.path().extension().is_none_or(|x| x != "init")), "Init-Dateien müssen nach dem letzten Verweis weg sein");

    let c = client(&fake);
    let check = dir.join("check");
    std::fs::create_dir_all(&check).unwrap();
    for (flow, is_video) in [(VFLOW, true), (AFLOW, false)] {
        let st = fake.state.lock().unwrap();
        assert_eq!(st.flows[flow].json["container"], if is_video { "video/mp4" } else { "audio/mp4" });
        assert_eq!(st.flows[flow].json["essence_parameters"]["init_segments"], true);
        drop(st);
        let segs = c.list_segments(flow, &SegmentQuery::default(), 100).unwrap();
        assert!(segs.len() >= 3);
        // Init-Object wird wiederverwendet: alle Segmente zeigen auf dasselbe
        let init_ids: std::collections::BTreeSet<_> = segs.iter().map(|s| s.init_object.as_ref().and_then(|o| o["object_id"].as_str()).expect("init_object").to_string()).collect();
        assert_eq!(init_ids.len(), 1, "{flow}: Init-Segment muss wiederverwendet werden: {init_ids:?}");
        // Zeitbezug: das erste Segment beginnt kurz nach dem Start der Quelle (synthetische Ursprungszeit = BASE_TAI)
        let first_start = match TimeRange::parse(&segs[0].timerange).unwrap() { TimeRange::Range { start: Some(a), .. } => a.ts.ns(), r => panic!("{r}") };
        assert!((first_start - BASE_TAI_NS as i128).abs() < 1_000_000_000, "{flow}: erstes Segment bei {first_start}, Quelle begann bei {BASE_TAI_NS}");
        // lückenlos, überlappungsfrei
        let ranges: Vec<(i128, i128)> = segs.iter().map(|s| match TimeRange::parse(&s.timerange).unwrap() { TimeRange::Range { start: Some(a), end: Some(b) } => (a.ts.ns(), b.ts.ns()), r => panic!("{r}") }).collect();
        for w in ranges.windows(2) {
            assert_eq!(w[0].1, w[1].0, "{flow}: Lücke/Überlappung {:?} {:?}", w[0], w[1]);
        }
        // Init + Segment zusammengesetzt = abspielbar; Dauer und Bildzahl stimmen, ts_offset + Objektzeit = Segmentanfang
        let init_url = segs[0].init_object.as_ref().and_then(|o| o["get_urls"][0]["url"].as_str()).expect("init_object mit Adresse").to_string();
        let init = c.download_object(&init_url, 1 << 20).unwrap();
        assert_eq!(&init[4..8], b"ftyp");
        assert!(omp_tams::mp4::timescale(&init).is_some());
        for (i, s) in segs.iter().enumerate() {
            let media = c.download_object(&s.get_urls[0].url, 64 << 20).unwrap();
            assert_eq!(&media[4..8], b"moof", "Segmentobjekt darf kein Init enthalten");
            let first = omp_tams::mp4::first_pts_ns(&init, &media).unwrap();
            let off = Timestamp::parse(s.ts_offset.as_deref().unwrap()).unwrap().ns();
            assert_eq!(off + first, ranges[i].0, "ts_offset + Objektzeit muss den Segmentanfang ergeben");
            let p = check.join(format!("{}{i}.mp4", if is_video { "v" } else { "a" }));
            std::fs::write(&p, [init.clone(), media].concat()).unwrap();
            if is_video {
                let n: u64 = probe(&["-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"], &p).lines().next().unwrap().trim().trim_end_matches(',').parse().unwrap();
                assert_eq!(n as i128, (ranges[i].1 - ranges[i].0) / 40_000_000, "Bildzahl {i}");
                let k = probe(&["-select_streams", "v:0", "-read_intervals", "%+#1", "-show_entries", "frame=key_frame", "-of", "csv=p=0"], &p);
                assert!(k.starts_with('1'), "Segment {i} beginnt nicht mit Schlüsselbild: {k:?}");
            } else {
                let samples = (ranges[i].1 - ranges[i].0) * 48_000 / 1_000_000_000;
                let f = omp_tams::mp4::fragment_info(&std::fs::read(&p).unwrap()[init.len()..]).unwrap();
                assert!((samples - (f.sample_count as i128) * 1024).abs() <= 1, "Tonlänge {samples} ≠ {} Rahmen", f.sample_count);
            }
        }
    }
    // Objekte: je Flow ein Init + N Medien (nicht je Segment ein Init)
    let total_objects = fake.state.lock().unwrap().objects.len();
    assert_eq!(total_objects, written + 2, "{written} Segmente + je 1 Init-Object je Flow");
    std::fs::remove_dir_all(&dir).ok();
}
