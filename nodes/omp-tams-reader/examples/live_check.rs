//! Livetest 105.4 mit **echtem MXL**: Aufnahme (synthetische Quellen, Segmenter des Schreibers) → Testserver mit den
//! TAMS-Regeln → `omp-tams-reader`-Laufzeit (Quelltext der Bibliothek) → MXL-Domain. Gemessen wird der Kopf des
//! Video-Flows in der MXL-Domain: wie viele Grains kommen an, und wie weit liegt der Kopf hinter der TAI-Uhr?
//!
//!   source deploy/dev/mxl.env && cargo run -p omp-tams-reader --example live_check
use gstreamer as gst;
use gstreamer::prelude::*;
use omp_mediaio::mxl::MxlContext;
use omp_mediaio::timebase::tai_now_ns;
use omp_tams::auth::Auth;
use omp_tams::client::{Client, ClientConfig, SegmentQuery};
use omp_tams::index::{Rate, ns_to_index};
use omp_tams::testserver::Fake;
use omp_tams::time::TimeRange;
use omp_tams_reader::lane::GapMode;
use omp_tams_reader::plan;
use omp_tams_reader::runtime::{self, Config, Request};
use omp_tams_writer::segmenter::{self, add_audio_branch, add_video_branch};
use omp_tams_writer::spool::Spool;
use omp_tams_writer::uploader::{FlowDef, FlowRegistry, Step, Uploader, audio_flow_body, video_flow_body};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::time::{Duration, Instant};

const VFLOW: &str = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const AFLOW: &str = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const FPS: Rate = Rate { num: 25, den: 1 };
const AR: Rate = Rate { num: 48000, den: 1 };

fn mk(f: &Fake) -> Client {
    Client::new(ClientConfig::new(f.api(), Auth::None)).unwrap()
}

fn record(spool: Arc<Spool>, seconds: u64) -> u64 {
    let pipeline = gst::Pipeline::new();
    let vsrc = gst::parse::bin_from_description("videotestsrc is-live=true pattern=ball ! video/x-raw,width=320,height=180,framerate=25/1 ! identity", true).unwrap();
    let asrc = gst::parse::bin_from_description("audiotestsrc is-live=true wave=sine ! audio/x-raw,rate=48000,channels=2 ! identity", true).unwrap();
    pipeline.add_many([&vsrc, &asrc]).unwrap();
    let t0 = tai_now_ns();
    let (vb, ab) = (ns_to_index(t0, FPS), ns_to_index(t0, AR));
    let vo: segmenter::OriginFn = Arc::new(move |b| b.pts().map(|p| vb + p.nseconds() * 25 / 1_000_000_000));
    let ao: segmenter::OriginFn = Arc::new(move |b| b.pts().map(|p| ab + (p.nseconds() as u128 * 48000 / 1_000_000_000) as u64));
    let v = add_video_branch(&pipeline, vsrc.upcast_ref(), VFLOW, FPS, 2_000_000_000, 500, spool.clone(), vo).unwrap();
    let a = add_audio_branch(&pipeline, asrc.upcast_ref(), AFLOW, 48000, 2_000_000_000, 96_000, spool, ao).unwrap();
    pipeline.set_state(gst::State::Playing).unwrap();
    let bus = pipeline.bus().unwrap();
    let drain = |until: Instant, eos: bool| {
        while Instant::now() < until {
            let Some(m) = bus.timed_pop(gst::ClockTime::from_mseconds(100)) else { continue };
            if matches!(m.view(), gst::MessageView::Eos(_)) && eos {
                return;
            }
            let _ = (v.handle_message(&m), a.handle_message(&m));
        }
    };
    drain(Instant::now() + Duration::from_secs(seconds), false);
    pipeline.send_event(gst::event::Eos::new());
    drain(Instant::now() + segmenter::STOP_EOS_TIMEOUT, true);
    drain(Instant::now() + Duration::from_millis(500), false);
    pipeline.set_state(gst::State::Null).unwrap();
    t0
}

fn main() {
    gst::init().unwrap();
    let domain = format!("/dev/shm/omp-mxl-tamsreader-{}", std::process::id());
    let dir = format!("/tmp/omp-tamsreader-{}", std::process::id());
    std::fs::create_dir_all(&domain).unwrap();
    let spool = Arc::new(Spool::open(&dir, 64 << 20).unwrap());
    let fake = Fake::start();
    let t0 = record(spool.clone(), 8);
    let flows = vec![
        FlowDef { flow_id: VFLOW.into(), body: video_flow_body(VFLOW, "cccccccc-3333-4333-8333-cccccccccccc", "V", 320, 180, 25, 1, Some("progressive"), 2, 500), container: "video/mp2t".into() },
        FlowDef { flow_id: AFLOW.into(), body: audio_flow_body(AFLOW, "dddddddd-4444-4444-8444-dddddddddddd", "A", 48000, 2, 2, 96), container: "video/mp2t".into() },
    ];
    let mut up = Uploader::new(mk(&fake), spool.clone(), FlowRegistry::new(spool.clone(), flows), Box::new(tai_now_ns));
    while !matches!(up.step(), Step::Idle) {}
    let c = mk(&fake);
    let segs = c.list_segments(VFLOW, &SegmentQuery::default(), 100).unwrap();
    let lo = plan::bounds_ns(&TimeRange::parse(&segs[0].timerange).unwrap()).unwrap().0.unwrap();
    println!("Aufnahme: {} Segmente, Anfang {} ns nach dem Start", segs.len(), lo - t0 as i128);

    let (vid, aid) = ("11111111-1111-4111-8111-111111111111".to_string(), "22222222-2222-4222-8222-222222222222".to_string());
    let cfg = Config {
        domain: domain.clone(), client: Arc::new(mk(&fake)), label: "tams-reader-check".into(), video_flow_id: vid.clone(), audio_flow_id: aid.clone(),
        width: 320, height: 180, fps_num: 25, fps_den: 1, sample_rate: 48000, channels: 2, gap: GapMode::Hold, lead_ms: 2000,
    };
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let (rtx, rrx) = tokio::sync::oneshot::channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let sd = shutdown.clone();
    let th = std::thread::spawn(move || runtime::run(cfg, tx, sd, rtx, Arc::new(AtomicU64::new(0))));
    let handle = rrx.blocking_recv().unwrap().unwrap();
    let ctx = MxlContext::new(&domain).unwrap();

    let (start, end) = (lo + 2 * 1_000_000_000, lo + 6 * 1_000_000_000);
    handle.start(Request::Play { video: Some(VFLOW.into()), audio: Some(AFLOW.into()), start_ns: start, end_ns: Some(end) }).unwrap();
    let t_start = Instant::now();
    let reader = loop {
        if let Ok(r) = ctx.instance().create_flow_reader(&vid) {
            break r.to_grain_reader().unwrap();
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut samples: Vec<(u64, u64)> = Vec::new();
    while t_start.elapsed() < Duration::from_secs(9) {
        if let Ok(info) = reader.get_runtime_info() {
            samples.push((tai_now_ns(), info.headIndex));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let moving: Vec<&(u64, u64)> = samples.iter().filter(|(_, h)| *h > 0).collect();
    let first = moving.first().expect("kein Grain geschrieben");
    let last = moving.last().unwrap();
    let grains = last.1 - first.1 + 1;
    println!("Status {:?}; Grains im MXL-Flow: {grains} (erwartet 100; ±4 durch die 100-ms-Abtastung am Anfang); Bilder ausgegeben: {}", handle.status(), handle.stats().frames_out.load(std::sync::atomic::Ordering::Relaxed));
    // Kopf gegen die TAI-Uhr: der Kopf darf nicht vor „jetzt“ liegen und nicht weit dahinter
    let mut lags: Vec<i64> = moving.iter().filter(|(_, h)| *h < last.1).map(|(w, h)| *w as i64 - ctx.index_to_ns(*h, 25, 1).unwrap() as i64).collect();
    lags.sort();
    println!("Abstand Uhr − Kopf: Median {} ms, 90 % {} ms, Höchstwert {} ms ({} Messungen)", lags[lags.len() / 2] / 1_000_000, lags[lags.len() * 9 / 10] / 1_000_000, lags[lags.len() - 1] / 1_000_000, lags.len());
    let mut worst_ahead = i64::MIN;
    let mut worst_behind = i64::MIN;
    // nur solange der Kopf läuft (nach dem Ende steht er, die Uhr nicht)
    for (wall, head) in moving.iter().filter(|(_, h)| *h < last.1) {
        let head_ns = ctx.index_to_ns(*head, 25, 1).unwrap() as i64;
        let lag = *wall as i64 - head_ns;
        worst_behind = worst_behind.max(lag);
        worst_ahead = worst_ahead.max(-lag);
    }
    println!("Kopf liegt höchstens {} ms hinter und höchstens {} ms vor der TAI-Uhr", worst_behind / 1_000_000, worst_ahead / 1_000_000);
    assert!((96..=103).contains(&grains), "Grainzahl {grains}");
    assert!(worst_ahead < 60_000_000, "Kopf läuft der Uhr voraus");
    assert!(lags[lags.len() / 2] < 200_000_000, "Kopf hinkt im Median hinterher");
    println!("OK: Wiedergabe in echten MXL-Flow, Takt stimmt");
    shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = th.join();
    let _ = std::fs::remove_dir_all(&domain);
    let _ = std::fs::remove_dir_all(&dir);
}
