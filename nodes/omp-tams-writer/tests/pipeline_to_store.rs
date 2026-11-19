//! Ende-zu-Ende ohne MXL: echte GStreamer-Quellen → Encoder → MPEG-TS-Segmente → Warteschlange → Uploader →
//! Testserver, der die TAMS-Regeln durchsetzt. Der MXL-Ursprungs-Index wird aus der Laufzeit nachgebildet
//! (`BASE_TAI` + Laufzeit); die echte MXL-Anbindung prüft der Livetest im Node (105.3, siehe UMSETZUNG).
//!
//! Klein und kurz (Projektregel „CPU schonen“): 320×180, 25 Bilder/s, Segmente zu 2 s, knapp 8 s Laufzeit.

use gstreamer as gst;
use gstreamer::prelude::*;
use omp_tams::auth::Auth;
use omp_tams::client::{Client, ClientConfig, RetryPolicy, SegmentQuery};
use omp_tams::index::{Rate, ns_to_index};
use omp_tams::mpegts::{first_pts, ticks_to_ns};
use omp_tams::testserver::Fake;
use omp_tams::time::{TimeRange, Timestamp};
use omp_tams_writer::segmenter::{self, Event, add_audio_branch, add_video_branch};
use omp_tams_writer::spool::Spool;
use omp_tams_writer::uploader::{FlowDef, FlowRegistry, Step, Uploader, audio_flow_body, video_flow_body};
use std::sync::Arc;
use std::time::{Duration, Instant};

const VFLOW: &str = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const AFLOW: &str = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const BASE_TAI_NS: u64 = 1_790_000_000_000_000_000;
const FPS: Rate = Rate { num: 25, den: 1 };
const AUDIO_RATE: Rate = Rate { num: 48000, den: 1 };

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("omp-tams-it-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn client(f: &Fake) -> Client {
    let mut cfg = ClientConfig::new(f.api(), Auth::None);
    cfg.retry = RetryPolicy { attempts: 2, base_delay: Duration::from_millis(5), max_delay: Duration::from_millis(10) };
    cfg.timeout = Duration::from_secs(5);
    Client::new(cfg).unwrap()
}

fn flows() -> Vec<FlowDef> {
    vec![
        FlowDef { flow_id: VFLOW.into(), body: video_flow_body(VFLOW, "cccccccc-3333-4333-8333-cccccccccccc", "Test Video", 320, 180, 25, 1, Some("progressive"), 2, 500), container: "video/mp2t".into() },
        FlowDef { flow_id: AFLOW.into(), body: audio_flow_body(AFLOW, "dddddddd-4444-4444-8444-dddddddddddd", "Test Audio", 48000, 2, 2, 96), container: "video/mp2t".into() },
    ]
}

/// Pipeline mit synthetischem Ursprungs-Index; liefert die Zweige. Läuft `seconds`, dann EOS und Abholen aller Meldungen.
fn record(spool: Arc<Spool>, seconds: u64) -> Vec<Event> {
    gst::init().unwrap();
    let pipeline = gst::Pipeline::new();
    let vsrc = gst::parse::bin_from_description("videotestsrc is-live=true pattern=ball ! video/x-raw,width=320,height=180,framerate=25/1 ! identity", true).unwrap();
    let asrc = gst::parse::bin_from_description("audiotestsrc is-live=true wave=sine ! audio/x-raw,rate=48000,channels=2 ! identity", true).unwrap();
    pipeline.add_many([&vsrc, &asrc]).unwrap();
    let vbase = ns_to_index(BASE_TAI_NS, FPS);
    let abase = ns_to_index(BASE_TAI_NS, AUDIO_RATE);
    let vorigin: segmenter::OriginFn = Arc::new(move |b| b.pts().map(|p| vbase + p.nseconds() * 25 / 1_000_000_000));
    let aorigin: segmenter::OriginFn = Arc::new(move |b| b.pts().map(|p| abase + (p.nseconds() as u128 * 48000 / 1_000_000_000) as u64));
    let v = add_video_branch(&pipeline, vsrc.upcast_ref(), VFLOW, FPS, 2_000_000_000, 500, spool.clone(), vorigin).unwrap();
    let a = add_audio_branch(&pipeline, asrc.upcast_ref(), AFLOW, 48000, 2_000_000_000, 96_000, spool, aorigin).unwrap();
    pipeline.set_state(gst::State::Playing).unwrap();
    let bus = pipeline.bus().unwrap();
    let mut events = Vec::new();
    let mut drain = |until: Instant, stop_on_eos: bool| {
        while Instant::now() < until {
            let Some(m) = bus.timed_pop(gst::ClockTime::from_mseconds(100)) else { continue };
            match m.view() {
                gst::MessageView::Error(e) => panic!("Pipeline-Fehler: {} ({:?})", e.error(), e.debug()),
                gst::MessageView::Eos(_) if stop_on_eos => return,
                _ => {}
            }
            events.extend(v.handle_message(&m));
            events.extend(a.handle_message(&m));
        }
    };
    drain(Instant::now() + Duration::from_secs(seconds), false);
    pipeline.send_event(gst::event::Eos::new());
    drain(Instant::now() + segmenter::STOP_EOS_TIMEOUT, true);
    // letzte Meldungen (Schließen nach EOS) abholen
    drain(Instant::now() + Duration::from_millis(500), false);
    pipeline.set_state(gst::State::Null).unwrap();
    events
}

fn drain_uploader(up: &mut Uploader) -> (u32, Vec<String>) {
    let mut ok = 0;
    let mut notes = vec![];
    for _ in 0..200 {
        match up.step() {
            Step::Idle => break,
            Step::Registered => ok += 1,
            Step::Rejected(m) | Step::Retry(m) => notes.push(m),
        }
    }
    (ok, notes)
}

fn probe(args: &[&str], file: &std::path::Path) -> String {
    let out = std::process::Command::new("ffprobe").args(["-v", "error"]).args(args).arg(file).output().expect("ffprobe");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn check_flow(c: &Client, flow: &str, rate: Rate, expect_min: usize) -> Vec<(u64, u64, omp_tams::types::Segment)> {
    let segs = c.list_segments(flow, &SegmentQuery::default(), 1000).unwrap();
    assert!(segs.len() >= expect_min, "{flow}: nur {} Segmente", segs.len());
    let mut out = vec![];
    for s in segs {
        let r = TimeRange::parse(&s.timerange).unwrap();
        let TimeRange::Range { start: Some(a), end: Some(b) } = r else { panic!("{r}") };
        out.push((a.ts.ns() as u64, b.ts.ns() as u64, s));
    }
    for w in out.windows(2) {
        assert!(w[0].1 <= w[1].0, "{flow}: Überlappung {} / {}", w[0].2.timerange, w[1].2.timerange);
        assert_eq!(w[0].1, w[1].0, "{flow}: Lücke zwischen {} und {}", w[0].2.timerange, w[1].2.timerange);
    }
    for (a, _b, s) in &out {
        // Anfang liegt auf dem Raster der Rate, Dauer ist ein Vielfaches der Rate (AAC: Rahmen)
        assert_eq!(omp_tams::index::index_to_ns(ns_to_index(*a, rate), rate), *a, "Anfang nicht auf dem Raster: {}", s.timerange);
    }
    out
}

#[test]
fn record_upload_and_read_back_a_continuous_timeline() {
    let dir = tmp("e2e");
    let spool = Arc::new(Spool::open(&dir, 64 << 20).unwrap());
    let fake = Fake::start();
    let events = record(spool.clone(), 8);
    let written = events.iter().filter(|e| matches!(e, Event::Segment { .. })).count();
    let dropped: Vec<_> = events.iter().filter(|e| matches!(e, Event::Dropped { .. })).collect();
    assert!(dropped.is_empty(), "verworfen: {dropped:?}");
    assert!(written >= 6, "erwartet mindestens 3 Video- und 3 Audio-Segmente, waren {written}: {events:?}");

    let mut up = Uploader::new(client(&fake), spool.clone(), FlowRegistry::new(spool.clone(), flows()), Box::new(|| BASE_TAI_NS + 10_000_000_000));
    let (ok, notes) = drain_uploader(&mut up);
    assert_eq!(ok as usize, written, "{notes:?}");
    assert!(notes.is_empty(), "{notes:?}");
    assert_eq!(spool.pending().len(), 0, "Warteschlange muss leer sein");
    assert!(up.status.connected.load(std::sync::atomic::Ordering::Relaxed));

    let c = client(&fake);
    let v = check_flow(&c, VFLOW, FPS, 3);
    let a = check_flow(&c, AFLOW, AUDIO_RATE, 3);
    // Beide Flows liegen auf derselben TAI-Zeit: ihre Anfänge unterscheiden sich um weniger als eine Sekunde
    assert!(v[0].0.abs_diff(a[0].0) < 1_000_000_000, "Video/Audio-Zeitbezug: {} vs {}", v[0].0, a[0].0);
    // Dauer der Video-Segmente: GOP = 50 Bilder = 2 s
    let full: Vec<u64> = v[..v.len() - 1].iter().map(|(s, e, _)| (e - s) / 1_000_000).collect();

    // Objects prüfen: gültiges MPEG-TS, Video beginnt mit Schlüsselbild, ts_offset passt zum echten Container-PTS
    let objdir = dir.join("check");
    std::fs::create_dir_all(&objdir).unwrap();
    for (i, (start, end, seg)) in v.iter().chain(a.iter()).enumerate() {
        let data = c.download_object(&seg.get_urls[0].url, 64 << 20).unwrap();
        let p = objdir.join(format!("o{i}.ts"));
        std::fs::write(&p, &data).unwrap();
        let pts = first_pts(&data).expect("PTS im Object");
        let offset = Timestamp::parse(seg.ts_offset.as_deref().unwrap()).unwrap();
        let abs = offset.ns() + ticks_to_ns(pts);
        assert_eq!(abs, *start as i128, "ts_offset + Container-PTS muss den Segmentanfang ergeben");
        // unabhängige Gegenprobe mit ffprobe: Containerzeit des ersten Pakets
        let st: f64 = probe(&["-show_entries", "format=start_time", "-of", "csv=p=0"], &p).parse().unwrap();
        assert!((st - pts as f64 / 90_000.0).abs() < 0.05, "ffprobe start_time {st} vs PTS {}", pts as f64 / 90_000.0);
        let is_video = seg.timerange == v.iter().find(|x| x.2.object_id == seg.object_id).map(|x| x.2.timerange.clone()).unwrap_or_default();
        if !is_video {
            // Ton: Länge = ganze AAC-Rahmen (1024 Samples) und stimmt mit dem Inhalt der Datei überein
            let samples = (*end as u128 * 48000 / 1_000_000_000) - (*start as u128 * 48000 / 1_000_000_000);
            let frames = omp_tams::mpegts::aac_frame_count(&data).unwrap() as u128;
            assert!(samples.abs_diff(frames * 1024) <= 1, "Tonlänge {samples} Samples ≠ {frames} Rahmen · 1024 in {}", seg.timerange);
        }
        if is_video {
            let first = probe(&["-select_streams", "v:0", "-read_intervals", "%+#1", "-show_entries", "frame=pict_type,key_frame", "-of", "csv=p=0"], &p);
            assert!(first.contains("I") && first.starts_with("1"), "Segment beginnt nicht mit Schlüsselbild: {first:?}");
            let raw = probe(&["-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"], &p);
            let nb: u64 = raw.lines().map(str::trim).find(|l| !l.is_empty()).and_then(|l| l.trim_end_matches(',').parse().ok()).unwrap_or(0);
            let expect = (end - start) / 40_000_000;
            eprintln!("Objekt {}: {nb} Bilder, Dauer {} ms", seg.timerange, (end - start) / 1_000_000);
            assert_eq!(nb, expect, "Bildzahl im Object {} ≠ Dauer des Segments (ffprobe: {raw:?}, Datei {})", seg.timerange, p.display());
        }
    }
    assert!(full.iter().all(|d| *d == 2000), "volle Video-Segmente sind GOP-lang: {full:?}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn storage_outage_is_buffered_on_disk_and_drained_afterwards() {
    let dir = tmp("outage");
    let spool = Arc::new(Spool::open(&dir, 64 << 20).unwrap());
    let fake = Fake::start();
    // Ausfall: jedes Hochladen scheitert mit 503, solange der Eintrag in `fail_next` steht
    fake.state.lock().unwrap().fail_next = vec![("PUT /objects/".into(), 503); 10_000];
    let events = record(spool.clone(), 6);
    let written = events.iter().filter(|e| matches!(e, Event::Segment { .. })).count();
    assert!(written >= 4);

    let mut up = Uploader::new(client(&fake), spool.clone(), FlowRegistry::new(spool.clone(), flows()), Box::new(|| BASE_TAI_NS));
    for _ in 0..3 {
        assert!(matches!(up.step(), Step::Retry(_)), "bei Ausfall: Rückstau, kein Verwerfen");
    }
    assert_eq!(spool.pending().len(), written, "nichts darf verloren gehen");
    assert!(!up.status.connected.load(std::sync::atomic::Ordering::Relaxed));
    assert!(up.status.queue_bytes.load(std::sync::atomic::Ordering::Relaxed) > 0);

    // Ausfall behoben
    fake.state.lock().unwrap().fail_next.clear();
    let (ok, notes) = drain_uploader(&mut up);
    assert_eq!(ok as usize, written, "{notes:?}");
    assert_eq!(spool.pending().len(), 0);
    let c = client(&fake);
    check_flow(&c, VFLOW, FPS, 2);
    check_flow(&c, AFLOW, AUDIO_RATE, 2);

    // Neustart mit Rest in der Warteschlange: neuer Uploader, neue Spool-Instanz
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn queue_survives_a_restart() {
    let dir = tmp("restart");
    let spool = Arc::new(Spool::open(&dir, 64 << 20).unwrap());
    let fake = Fake::start();
    let events = record(spool.clone(), 5);
    let written = events.iter().filter(|e| matches!(e, Event::Segment { .. })).count();
    drop(spool);
    // „Neustart“: Warteschlange von der Platte neu öffnen
    let spool = Arc::new(Spool::open(&dir, 64 << 20).unwrap());
    assert_eq!(spool.pending().len(), written);
    let mut up = Uploader::new(client(&fake), spool.clone(), FlowRegistry::new(spool.clone(), flows()), Box::new(|| BASE_TAI_NS));
    let (ok, notes) = drain_uploader(&mut up);
    assert_eq!(ok as usize, written, "{notes:?}");
    assert!(notes.is_empty(), "{notes:?}");
    std::fs::remove_dir_all(&dir).ok();
}

/// Der Node bricht nach dem Registrieren ab, bevor er die Datei löscht: beim nächsten Start steht das Segment
/// noch in der Warteschlange (mit demselben reservierten Platz). Der Dienst lehnt die zweite Registrierung als
/// Überlappung ab; der Uploader fragt nach, findet das Segment (gleiches Object) und gilt es als erledigt.
#[test]
fn registration_with_unknown_outcome_is_confirmed_not_rejected() {
    let dir = tmp("confirm");
    let spool = Arc::new(Spool::open(&dir, 64 << 20).unwrap());
    let fake = Fake::start();
    let events = record(spool.clone(), 4);
    let written = events.iter().filter(|e| matches!(e, Event::Segment { .. })).count();
    let mut up = Uploader::new(client(&fake), spool.clone(), FlowRegistry::new(spool.clone(), flows()), Box::new(|| BASE_TAI_NS));
    let (ok, _) = drain_uploader(&mut up);
    assert_eq!(ok as usize, written);

    // das erste Video-Segment „kommt zurück“: Datei und Metadaten samt altem Platz
    let c = client(&fake);
    let seg = c.list_segments(VFLOW, &SegmentQuery::default(), 100).unwrap().remove(0);
    let data = c.download_object(&seg.get_urls[0].url, 64 << 20).unwrap();
    let TimeRange::Range { start: Some(a), end: Some(b) } = TimeRange::parse(&seg.timerange).unwrap() else { panic!() };
    let file = "again.ts".to_string();
    std::fs::write(spool.file_path(&file), &data).unwrap();
    let put_url = omp_tams::types::HttpRequest { url: seg.get_urls[0].url.clone(), content_type: Some("video/mp2t".into()), headers: Default::default() };
    let now_s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let meta = omp_tams_writer::spool::SegmentMeta {
        flow_id: VFLOW.into(),
        file,
        start_ns: a.ts.ns() as u64,
        end_ns: b.ts.ns() as u64,
        key_frame_count: 1,
        size: data.len() as u64,
        slot: Some(omp_tams_writer::spool::SlotMeta { object_id: seg.object_id.clone(), put_url, reserved_at: now_s }),
    };
    spool.add(&meta).unwrap();
    // der Testserver lässt PUT nur für reservierte Objects zu: dieses ist es schon
    let before = fake.state.lock().unwrap().flows[VFLOW].segments.len();
    assert_eq!(up.step(), Step::Registered, "bestätigt statt abgelehnt");
    assert_eq!(up.status.rejected.load(std::sync::atomic::Ordering::Relaxed), 0);
    assert_eq!(fake.state.lock().unwrap().flows[VFLOW].segments.len(), before, "kein Doppeleintrag");
    assert_eq!(spool.pending().len(), 0);

    // dagegen: ein Segment mit anderem Object im selben Zeitbereich ist eine echte Überlappung → verworfen, gemeldet
    let c2 = client(&fake);
    let slot = c2.request_storage(VFLOW, &omp_tams::types::StorageRequest { limit: Some(1), ..Default::default() }).unwrap().media_objects.remove(0);
    std::fs::write(spool.file_path("clash.ts"), &data).unwrap();
    spool
        .add(&omp_tams_writer::spool::SegmentMeta {
            flow_id: VFLOW.into(),
            file: "clash.ts".into(),
            start_ns: a.ts.ns() as u64,
            end_ns: b.ts.ns() as u64,
            key_frame_count: 1,
            size: data.len() as u64,
            slot: Some(omp_tams_writer::spool::SlotMeta { object_id: slot.object_id, put_url: slot.put_url, reserved_at: now_s }),
        })
        .unwrap();
    match up.step() {
        Step::Rejected(m) => assert!(m.contains("überlappt"), "{m}"),
        other => panic!("erwartet Verwerfen wegen Überlappung, war {other:?}"),
    }
    assert_eq!(up.status.rejected.load(std::sync::atomic::Ordering::Relaxed), 1);
    assert_eq!(spool.pending().len(), 0, "abgelehntes Segment darf die Warteschlange nicht blockieren");
    std::fs::remove_dir_all(&dir).ok();
}
