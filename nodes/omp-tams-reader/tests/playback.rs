//! Ende-zu-Ende ohne MXL: echte GStreamer-Quellen → Schreiber (Segmenter, Warteschlange, Uploader) → Testserver, der die
//! TAMS-Regeln durchsetzt → Leser (Holen, Dekodieren, Takt, Lückenfüllung) → `appsink` statt MXL-Ausgang.
//! Geprüft werden die Zeiten, die am Ausgang ankommen (PTS-Takt und TAI-Meta), nicht Bildinhalte.
//!
//! Klein und kurz (Projektregel „CPU schonen“): 320×180, 25 Bilder/s, Segmente zu 2 s, 8 s Aufnahme; **eine** Aufnahme
//! für alle Prüfungen.

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::tai_reference_caps;
use omp_mediaio::timebase::tai_now_ns;
use omp_tams::auth::Auth;
use omp_tams::client::{Client, ClientConfig, RetryPolicy, SegmentQuery};
use omp_tams::index::{Rate, ns_to_index};
use omp_tams::testserver::Fake;
use omp_tams::time::{Bound, TimeRange, Timestamp};
use omp_tams_reader::lane::{self, Control, Course, GapMode, Sink, Stats};
use omp_tams_reader::plan;
use omp_tams_writer::segmenter::{self, Event, add_audio_branch, add_video_branch};
use omp_tams_writer::spool::Spool;
use omp_tams_writer::uploader::{FlowDef, FlowRegistry, Step, Uploader, audio_flow_body, video_flow_body};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const VFLOW: &str = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const AFLOW: &str = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const FPS: Rate = Rate { num: 25, den: 1 };
const AUDIO_RATE: Rate = Rate { num: 48000, den: 1 };
const S: i128 = 1_000_000_000;
const FRAME: i128 = 40_000_000;

fn client(f: &Fake) -> Arc<Client> {
    Arc::new(mk_client(f))
}

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

struct Rec {
    /// Ausgabe-TAI aus dem Meta (ns)
    tai: u64,
    /// Uhrzeit (TAI) beim Eintreffen am Ausgang
    arrived: u64,
}

struct Played {
    recs: Vec<Rec>,
    stats: Arc<Stats>,
}

/// Eine Spur über die echte Leser-Kette abspielen, bis sie fertig ist (oder `stop_after` Einträge da sind).
fn play(client: Arc<Client>, flow: &str, video: bool, course: Course, shift: i128, gap: GapMode, stop_after: Option<usize>) -> Played {
    gst::init().unwrap();
    let pipeline = gst::Pipeline::new();
    let src = gst_app::AppSrc::builder().build();
    src.set_format(gst::Format::Time);
    src.set_is_live(true);
    src.set_block(true);
    src.set_do_timestamp(false);
    src.set_max_bytes(1 << 20);
    let ident = gst::ElementFactory::make("identity").property("sync", true).build().unwrap();
    let appsink = gst_app::AppSink::builder().sync(false).build();
    pipeline.add_many([src.upcast_ref::<gst::Element>(), &ident, appsink.upcast_ref()]).unwrap();
    gst::Element::link_many([src.upcast_ref::<gst::Element>(), &ident, appsink.upcast_ref()]).unwrap();
    let recs = Arc::new(Mutex::new(Vec::<Rec>::new()));
    let r2 = recs.clone();
    appsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |s| {
                let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let b = sample.buffer().ok_or(gst::FlowError::Error)?;
                let m = b.meta::<gst::ReferenceTimestampMeta>().ok_or(gst::FlowError::Error)?;
                assert!(m.reference() == tai_reference_caps().as_ref());
                r2.lock().unwrap().push(Rec { tai: m.timestamp().nseconds(), arrived: tai_now_ns() });
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    pipeline.set_state(gst::State::Playing).unwrap();
    let ctl = Arc::new(Control { stop: AtomicBool::new(false) });
    let stats = Arc::new(Stats::default());
    let sink = Sink { pipeline: pipeline.clone(), src, shift_ns: shift, course, ctl: ctl.clone(), stats: stats.clone() };
    let (tx, rx) = sync_channel(2);
    let (c, ctl2, st2, fl) = (client, ctl.clone(), stats.clone(), flow.to_string());
    let fetch = std::thread::spawn(move || lane::fetch_loop(&c, &fl, course, &tx, &ctl2, &st2));
    let play = std::thread::spawn(move || if video { lane::play_video(&sink, rx, FRAME, gap) } else { lane::play_audio(&sink, rx, 48000, 2) });
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        let n = recs.lock().unwrap().len();
        let done = stats.lanes_done.load(Ordering::Relaxed) >= 1;
        if (stop_after.is_some_and(|k| n >= k)) || (done && stop_after.is_none()) || Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // Ausgabe leerlaufen lassen: bis zur Zeit des letzten ausgegebenen Bildes (der `appsrc` puffert voraus)
    let wait_until = Instant::now() + Duration::from_secs(8);
    while Instant::now() < wait_until && stop_after.is_none() && tai_now_ns() < stats.last_tai.load(Ordering::Relaxed) + 300_000_000 {
        std::thread::sleep(Duration::from_millis(50));
    }
    ctl.stop.store(true, Ordering::Relaxed);
    pipeline.set_state(gst::State::Null).unwrap();
    let _ = play.join();
    let _ = fetch.join();
    let recs = std::mem::take(&mut *recs.lock().unwrap());
    Played { recs, stats }
}

fn range_ns(c: &Client, flow: &str) -> (i128, i128) {
    let segs = c.list_segments(flow, &SegmentQuery::default(), 1000).unwrap();
    let (mut lo, mut hi) = (i128::MAX, 0);
    for s in segs {
        let (a, b) = plan::bounds_ns(&TimeRange::parse(&s.timerange).unwrap()).map(|(a, b)| (a.unwrap(), b.unwrap())).unwrap();
        lo = lo.min(a);
        hi = hi.max(b);
    }
    (lo, hi)
}

fn assert_cadence(recs: &[Rec], step: i128, what: &str) {
    for w in recs.windows(2) {
        let d = w[1].tai as i128 - w[0].tai as i128;
        assert!((d - step).abs() <= step / 2, "{what}: Abstand {d} ns statt {step} ns");
    }
}

#[test]
fn record_then_replay_gap_fill_and_time_shift() {
    let dir = std::env::temp_dir().join(format!("omp-tams-reader-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let spool = Arc::new(Spool::open(&dir, 64 << 20).unwrap());
    let fake = Fake::start();
    let t0 = record(spool.clone(), 8);
    let flows = vec![
        FlowDef { flow_id: VFLOW.into(), body: video_flow_body(VFLOW, "cccccccc-3333-4333-8333-cccccccccccc", "V", 320, 180, 25, 1, Some("progressive"), 2, 500), container: "video/mp2t".into() },
        FlowDef { flow_id: AFLOW.into(), body: audio_flow_body(AFLOW, "dddddddd-4444-4444-8444-dddddddddddd", "A", 48000, 2, 2, 96), container: "video/mp2t".into() },
    ];
    let mut up = Uploader::new(mk_client(&fake), spool.clone(), FlowRegistry::new(spool.clone(), flows), Box::new(tai_now_ns));
    for _ in 0..200 {
        if matches!(up.step(), Step::Idle) {
            break;
        }
    }
    let c = client(&fake);
    let (vlo, vhi) = range_ns(&c, VFLOW);
    assert!((vlo - t0 as i128).abs() < S, "Aufnahme beginnt bei {vlo}, Start war {t0}");
    assert!(vhi - vlo >= 6 * S);

    // ---- 1. Bereich abspielen: 4 s aus der Mitte, Video und Ton -------------------------------------------------
    let start = vlo + 2 * S;
    let end = start + 4 * S;
    let course = Course { start_ns: start, end_ns: Some(end) };
    let lead = 2 * S;
    let shift = plan::play_shift(start, tai_now_ns(), lead);
    let t_play = Instant::now();
    let (cv, ca) = (c.clone(), c.clone());
    let v = std::thread::spawn(move || play(cv, VFLOW, true, course, shift, GapMode::Hold, None));
    let a = std::thread::spawn(move || play(ca, AFLOW, false, course, shift, GapMode::Hold, None));
    let (v, a) = (v.join().unwrap(), a.join().unwrap());
    let took = t_play.elapsed();
    assert_eq!(v.recs.len(), 100, "4 s · 25 Bilder/s; Fehler: {:?}", v.stats.last_error.lock().unwrap());
    assert_cadence(&v.recs, FRAME, "Video");
    assert_eq!(v.stats.frames_out.load(Ordering::Relaxed), 100);
    // erstes Bild: Bereichsanfang + Versatz, auf ein Bild genau
    assert!((v.recs[0].tai as i128 - (start + shift)).abs() <= FRAME, "erstes Bild bei {} statt {}", v.recs[0].tai, start + shift);
    // Takt: Ankunft am Ausgang liegt nahe an der Ausgabezeit (nicht früher, höchstens 200 ms später)
    for r in &v.recs {
        let late = r.arrived as i128 - r.tai as i128;
        assert!((-60_000_000..200_000_000).contains(&late), "Bild kam {late} ns nach seiner Ausgabezeit");
    }
    // Dauer: Vorlauf + 4 s, nicht schneller als Echtzeit
    assert!(took > Duration::from_millis(5500) && took < Duration::from_secs(12), "Wiedergabe dauerte {took:?}");
    // Ton: Blöcke lückenlos, erster Block ± 1 AAC-Rahmen (21 ms) am Bereichsanfang; Video und Ton gleicher Versatz
    assert!(a.recs.len() >= 180 && a.recs.len() <= 200, "Tonblöcke: {}", a.recs.len());
    let d0 = a.recs[0].tai as i128 - v.recs[0].tai as i128;
    assert!(d0.abs() <= 60_000_000, "Video/Ton-Versatz am Anfang: {d0} ns");
    assert_eq!(a.stats.errors.load(Ordering::Relaxed) + v.stats.errors.load(Ordering::Relaxed), 0);

    // ---- 2. Lücke: ein Segment fehlt → Bilder werden wiederholt, Kadenz bleibt ---------------------------------
    let hole = TimeRange::new(Some(Bound { ts: Timestamp::from_ns(vlo + 2 * S), inclusive: true }), Some(Bound { ts: Timestamp::from_ns(vlo + 4 * S), inclusive: false }));
    c.delete_segments(VFLOW, &hole).unwrap();
    let course = Course { start_ns: vlo, end_ns: Some(vlo + 6 * S) };
    let g = play(c.clone(), VFLOW, true, course, plan::play_shift(vlo, tai_now_ns(), S), GapMode::Hold, None);
    assert_eq!(g.recs.len(), 150, "6 s Bereich mit 2-s-Lücke muss 150 Bilder ergeben (50 gefüllt); Fehler {:?}", g.stats.last_error.lock().unwrap());
    assert_eq!(g.stats.gaps_filled.load(Ordering::Relaxed), 50);
    assert_cadence(&g.recs, FRAME, "Video mit Lücke");
    // Schwarz statt Wiederholen: gleiche Zahlen
    let g2 = play(c.clone(), VFLOW, true, course, plan::play_shift(vlo, tai_now_ns(), S), GapMode::Black, None);
    assert_eq!(g2.recs.len(), 150);

    // ---- 3. Zeitverschiebung: Ausgabe liegt genau `delay` hinter der Aufnahme ----------------------------------
    // Neue Daten für das Mitlaufen: der Flow ist bis vlo+8 s gefüllt (Lücke bei 2–4 s). Die Verzögerung wird so
    // gewählt, dass das Ende der Aufnahme gerade jetzt zu sehen ist; geprüft wird der Versatz im Meta.
    let now = tai_now_ns();
    let delay = (now as i128 - (vlo + 4 * S)).max(S) + S; // Anfang des Mitlaufens liegt bei vlo + 3 s → Lücke wird übersprungen
    let f = play(c.clone(), VFLOW, true, Course { start_ns: plan::follow_start(now, delay), end_ns: Some(vhi) }, delay, GapMode::Hold, Some(40));
    assert!(f.recs.len() >= 40, "nur {} Bilder, Fehler {:?}", f.recs.len(), f.stats.last_error.lock().unwrap());
    let first_flow = f.recs[0].tai as i128 - delay;
    assert!(first_flow >= plan::follow_start(now, delay) - FRAME, "Mitlaufen beginnt zu früh");
    assert_cadence(&f.recs, FRAME, "Mitlaufen");
    std::fs::remove_dir_all(&dir).ok();
}
