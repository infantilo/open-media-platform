//! Live-Prüfung der PIP-Slots (Kapitel 87) gegen die echte Pipeline: drei einfarbige Quellen, drei Slots (zwei mit
//! `perspective`, einer ohne), Trapez, Drehung, z-Reihenfolge, Fokusfahrt. Eigene MXL-Domäne unter /dev/shm, berührt
//! keinen laufenden Stack. `LD_LIBRARY_PATH` muss `libmxl.so` enthalten (`deploy/dev/mxl.env`).
//!   source deploy/dev/mxl.env && nice cargo test -p omp-video-mixer-me pip_live -- --ignored --nocapture

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput, MxlVideoOutput};

use crate::pip::PipPose;
use crate::pipeline::{self, Config, DiscoveredInput, DveBox};

const W: u32 = 640;
const H: u32 = 360;

fn source(ctx: &Arc<MxlContext>, color_argb: u32, flow: &str) -> (gst::Pipeline, MxlVideoOutput) {
    source_sized(ctx, color_argb, flow, W, H)
}

/// Wie `source`, aber mit eigener Bildgröße (Betrieb: Quellen 640x480 an einem Mischer mit anderem Format).
fn source_sized(ctx: &Arc<MxlContext>, color_argb: u32, flow: &str, w: u32, h: u32) -> (gst::Pipeline, MxlVideoOutput) {
    let pipe = gst::Pipeline::new();
    let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).build().unwrap();
    src.set_property_from_str("pattern", "solid-color");
    src.set_property("foreground-color", color_argb);
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("video/x-raw").field("format", "RGBA").field("width", w as i32).field("height", h as i32).field("framerate", gst::Fraction::new(25, 1)).build())
        .build()
        .unwrap();
    pipe.add_many([&src, &caps]).unwrap();
    gst::Element::link_many([&src, &caps]).unwrap();
    let out = MxlVideoOutput::new_from_rgba(&pipe, &caps, ctx.clone(), flow, "test", w, h, 25, 1, Arc::new(AtomicU64::new(0))).expect("MxlVideoOutput");
    out.set_active(true);
    pipe.set_state(gst::State::Playing).unwrap();
    (pipe, out)
}

/// Ein Bild des Ausgangs-Flows als RGBA-Bytes.
fn grab(ctx: &Arc<MxlContext>, flow: &str) -> Vec<u8> {
    let pipe = gst::Pipeline::new();
    let input = MxlVideoInput::new(&pipe, ctx.clone(), flow).expect("MxlVideoInput");
    let conv = gst::ElementFactory::make("videoconvert").build().unwrap();
    let sink = gst_app::AppSink::builder()
        .caps(&gst::Caps::builder("video/x-raw").field("format", "RGBA").build())
        .sync(false)
        .build();
    pipe.add_many([&conv, sink.upcast_ref()]).unwrap();
    gst::Element::link_many([&input.tail, &conv, sink.upcast_ref()]).unwrap();
    pipe.set_state(gst::State::Playing).unwrap();
    // ein paar Bilder verwerfen, das letzte nehmen
    let mut last = None;
    for _ in 0..4 {
        if let Some(s) = sink.try_pull_sample(gst::ClockTime::from_seconds(5)) {
            last = Some(s);
        }
    }
    let data = last.expect("kein Bild vom Mischer").buffer().unwrap().map_readable().unwrap().as_slice().to_vec();
    input.stop();
    std::thread::sleep(Duration::from_millis(200));
    pipe.set_state(gst::State::Null).unwrap();
    data
}

fn px(d: &[u8], x: u32, y: u32) -> [u8; 3] {
    let i = ((y * W + x) * 4) as usize;
    [d[i], d[i + 1], d[i + 2]]
}

fn px_w(d: &[u8], x: u32, y: u32, width: u32) -> [u8; 3] {
    let i = ((y * width + x) * 4) as usize;
    [d[i], d[i + 1], d[i + 2]]
}

fn is(c: [u8; 3], want: [u8; 3]) -> bool {
    (0..3).all(|i| (c[i] as i32 - want[i] as i32).abs() < 40)
}

const RED: [u8; 3] = [255, 0, 0];
const GREEN: [u8; 3] = [0, 255, 0];
const BLUE: [u8; 3] = [0, 0, 255];
const BLACK: [u8; 3] = [0, 0, 0];

#[test]
#[ignore = "braucht libmxl (deploy/dev/mxl.env) und startet eine echte Pipeline"]
fn pip_live() {
    gst::init().unwrap();
    let domain = format!("/dev/shm/omp-pip-live-{}", std::process::id());
    std::fs::create_dir_all(&domain).unwrap();
    let ctx = Arc::new(MxlContext::new(&domain).expect("MxlContext"));

    let colors = [0xFFFF0000u32, 0xFF00FF00, 0xFF0000FF];
    let flows: Vec<String> = (0..3).map(|_| omp_node_sdk::idgen::new_v4()).collect();
    let sources: Vec<_> = colors.iter().zip(&flows).map(|(c, f)| source(&ctx, *c, f)).collect();
    let out_flow = omp_node_sdk::idgen::new_v4();

    let config = Config {
        domain: domain.clone(),
        flow_ids: vec![out_flow.clone()],
        label: "pip-live".into(),
        width: W,
        height: H,
        hwaccel: omp_mediaio::hwaccel::HwAccel::default(),
        stills: Arc::new(Mutex::new(Default::default())),
        pip_slots: 3,
        pip_2d_slots: 2,
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Receiver));
    let sd = shutdown.clone();
    let th = std::thread::spawn(move || pipeline::run(config, tx, sd, ready_tx, Arc::new(AtomicU64::new(0)), monitor));
    let h = ready_rx.blocking_recv().expect("ready").expect("pipeline");

    h.set_inputs(
        flows
            .iter()
            .enumerate()
            .map(|(i, f)| DiscoveredInput { sender_id: format!("s{i}"), label: format!("s{i}"), flow_id: f.clone(), device_id: String::new(), format: None })
            .collect(),
    );
    std::thread::sleep(Duration::from_secs(4));

    let rect = |x, y, w, hh| PipPose::from_box(&DveBox { x, y, width: w, height: hh });
    // Slot 0 (2D): Trapez — oben schmal, unten breit; Slot 1 (2D): um 45° gedrehtes Rechteck; Slot 2 (ohne 2D): Rechteck
    let trapez = PipPose { c: [[80.0, 20.0], [160.0, 20.0], [200.0, 140.0], [40.0, 140.0]] };
    let rotated = rect(300, 40, 120, 80).rotated(45.0);
    let plain = rect(480, 20, 140, 100);
    for (slot, pose) in [trapez, rotated, plain].into_iter().enumerate() {
        h.set_pip_source(0, slot, Some(format!("s{slot}")));
        h.set_dve_box(0, slot, pose);
        h.set_pip_enabled(0, slot, true);
    }
    std::thread::sleep(Duration::from_secs(2));
    let d = grab(&ctx, &out_flow);
    println!("Trapez Mitte {:?}, gedreht Mitte {:?}, Rechteck Mitte {:?}, Hintergrund {:?}", px(&d, 120, 80), px(&d, 360, 80), px(&d, 550, 70), px(&d, 5, 300));
    assert!(is(px(&d, 5, 300), BLACK), "Hintergrund muss schwarz bleiben (Außenpixel transparent)");
    assert!(is(px(&d, 120, 80), RED), "Trapez-Mitte rot");
    assert!(is(px(&d, 120, 25), RED), "Trapez-Oberkante schmal: innen rot");
    assert!(is(px(&d, 50, 30), BLACK), "oben links vom Trapez ist leer");
    assert!(is(px(&d, 190, 135), RED), "Trapez-Unterkante breit: rechts unten rot");
    assert!(is(px(&d, 360, 80), GREEN), "gedrehtes Rechteck: Mitte grün");
    assert!(is(px(&d, 302, 42), BLACK), "gedreht: ungedrehte Ecke ist leer");
    assert!(is(px(&d, 550, 70), BLUE), "Rechteck ohne 2D: blau");

    // z-Reihenfolge: Slot 2 (blau) unter Slot 0 (rot) legen, überlappend
    h.set_dve_box(0, 2, rect(100, 60, 140, 100)); // überdeckt den unteren Trapezteil
    h.set_pip_z(0, 2, 20);
    std::thread::sleep(Duration::from_millis(600));
    let d = grab(&ctx, &out_flow);
    assert!(is(px(&d, 150, 110), BLUE), "Slot 2 mit z=20 liegt über dem Trapez");
    h.set_pip_z(0, 2, 6); // Slot 0 hat z=4, Slot 2 bleibt trotzdem darüber (6 > 4)
    h.set_pip_z(0, 0, 30);
    std::thread::sleep(Duration::from_millis(600));
    let d = grab(&ctx, &out_flow);
    assert!(is(px(&d, 150, 110), RED), "Slot 0 mit z=30 liegt jetzt über Slot 2");

    // Fokusfahrt: Slot 1 (gedreht) fährt nach (fast) Vollbild, dann zurück
    let focus = crate::pip::default_focus_pose(W, H);
    h.pip_animate(0, 1, None, focus, 400, false, Some(200), Some(200));
    std::thread::sleep(Duration::from_millis(1200));
    let d = grab(&ctx, &out_flow);
    assert!(is(px(&d, 320, 180), GREEN), "fokussierter Slot deckt die Bildmitte");
    assert!(is(px(&d, 40, 40), GREEN), "fast Vollbild: links oben grün");
    h.pip_animate(0, 1, None, rotated, 400, false, None, Some(5));
    std::thread::sleep(Duration::from_millis(1200));
    let d = grab(&ctx, &out_flow);
    assert!(is(px(&d, 320, 180), BLACK), "nach der Rückfahrt ist die Mitte wieder frei");
    assert!(is(px(&d, 360, 80), GREEN), "zurück an der Ruheposition");

    // Ausschalten
    h.set_pip_enabled(0, 1, false);
    std::thread::sleep(Duration::from_millis(600));
    let d = grab(&ctx, &out_flow);
    assert!(is(px(&d, 360, 80), BLACK), "ausgeschalteter Slot unsichtbar");

    // Robustheit: Quellen mehrfach entfernen und wieder hinzufügen (Live-Abgriffe und Rebuild), danach müssen alle drei
    // Slots wieder an ihrer Pose stehen (Pose, z und Sichtbarkeit werden nach dem Umbau neu angewandt).
    h.set_pip_enabled(0, 1, true);
    let all: Vec<DiscoveredInput> = flows
        .iter()
        .enumerate()
        .map(|(i, f)| DiscoveredInput { sender_id: format!("s{i}"), label: format!("s{i}"), flow_id: f.clone(), device_id: String::new(), format: None })
        .collect();
    for round in 0..5 {
        h.set_inputs(all[..2].to_vec());
        std::thread::sleep(Duration::from_millis(800));
        h.set_inputs(all.clone());
        std::thread::sleep(Duration::from_millis(1500));
        let d = grab(&ctx, &out_flow);
        assert!(is(px(&d, 120, 80), RED), "Runde {round}: Slot 0 (Trapez) wieder da");
        assert!(is(px(&d, 360, 80), GREEN), "Runde {round}: Slot 1 (gedreht) wieder da");
        assert!(is(px(&d, 250, 100), BLUE) || is(px(&d, 150, 110), RED), "Runde {round}: Slot 2 an seiner Stelle oder verdeckt");
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = th.join();
    while rx.try_recv().is_ok() {}
    for (p, _o) in sources {
        let _ = p.set_state(gst::State::Null);
    }
    let _ = std::fs::remove_dir_all(&domain);
}

/// Regression (Nutzerfund 2026-11-05): eine Szene mit Einfahrt muss das PIP tatsächlich ins Bild fahren. Vorher kam `Enable`
/// nach `Animate`, zählte den Animationszähler hoch und brach die Einfahrt ab — das PIP blieb an der Startposition außerhalb
/// des Bildes. Der Test spielt dieselben Aktionen ab wie `pip.applyPreset` und prüft das gerenderte Bild.
#[test]
#[ignore = "braucht libmxl (deploy/dev/mxl.env) und startet eine echte Pipeline"]
fn pip_scene_with_entry_animation_appears() {
    use crate::pipstate::{LevelPips, PipEntry, PipPreset};
    gst::init().unwrap();
    let domain = format!("/dev/shm/omp-pip-scene-{}", std::process::id());
    std::fs::create_dir_all(&domain).unwrap();
    let ctx = Arc::new(MxlContext::new(&domain).expect("MxlContext"));
    let flow = omp_node_sdk::idgen::new_v4();
    let (src_pipe, _out) = source(&ctx, 0xFFFF0000, &flow);
    let out_flow = omp_node_sdk::idgen::new_v4();
    let config = Config {
        domain: domain.clone(),
        flow_ids: vec![out_flow.clone()],
        label: "pip-scene".into(),
        width: W,
        height: H,
        hwaccel: omp_mediaio::hwaccel::HwAccel::default(),
        stills: Arc::new(Mutex::new(Default::default())),
        pip_slots: 2,
        pip_2d_slots: 0,
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Receiver));
    let sd = shutdown.clone();
    let th = std::thread::spawn(move || pipeline::run(config, tx, sd, ready_tx, Arc::new(AtomicU64::new(0)), monitor));
    let h = ready_rx.blocking_recv().expect("ready").expect("pipeline");
    h.set_inputs(vec![DiscoveredInput { sender_id: "s0".into(), label: "s0".into(), flow_id: flow.clone(), device_id: String::new(), format: None }]);
    std::thread::sleep(Duration::from_secs(4));

    let rect = |x, y, w, hh| PipPose::from_box(&DveBox { x, y, width: w, height: hh });
    let target = rect(40, 40, 200, 120);
    let entry = PipEntry {
        slot: 0,
        sender_id: Some("s0".into()),
        pose: target,
        start: Some(rect(W as i32 + 50, 40, 200, 120)), // vollständig rechts außerhalb des Bildes
        end: None,
        in_ms: 400,
        out_ms: 0,
        z: None,
        focus: None,
    };
    let mut pips = LevelPips::new(2, 0, W, H);
    let actions = pips.plan_apply(&PipPreset { id: "t".into(), name: "t".into(), entries: vec![entry] });
    actions.iter().for_each(|a| a.run(&h, 0));
    std::thread::sleep(Duration::from_millis(1800));
    let d = grab(&ctx, &out_flow);
    println!("Mitte des PIP {:?}", px(&d, 140, 100));
    assert!(is(px(&d, 140, 100), RED), "das PIP muss nach der Einfahrt an seiner Zielposition stehen");

    shutdown.store(true, Ordering::Relaxed);
    let _ = th.join();
    while rx.try_recv().is_ok() {}
    let _ = src_pipe.set_state(gst::State::Null);
    let _ = std::fs::remove_dir_all(&domain);
}

/// Wie `pip_scene_with_entry_animation_appears`, aber mit der Szene aus dem Betrieb ("PIP 1"): drei Einträge, alle mit Einfahrt
/// aus drei verschiedenen Richtungen, Slot 0 und 1 mit 2D-Transform (`perspective`), Slot 2 ohne. Alle drei müssen stehen.
#[test]
#[ignore = "braucht libmxl (deploy/dev/mxl.env) und startet eine echte Pipeline"]
fn pip_scene_three_slots_with_2d_entry_animation_all_appear() {
    use crate::pipstate::{LevelPips, PipEntry, PipPreset};
    gst::init().unwrap();
    let domain = format!("/dev/shm/omp-pip-scene3-{}", std::process::id());
    std::fs::create_dir_all(&domain).unwrap();
    let ctx = Arc::new(MxlContext::new(&domain).expect("MxlContext"));
    let colors = [0xFFFF0000u32, 0xFF00FF00, 0xFF0000FF];
    let flows: Vec<String> = (0..3).map(|_| omp_node_sdk::idgen::new_v4()).collect();
    // Wie im Betrieb: Quellen im Format 4:3 an einem 16:9-Mischer (Eingang als „Format weicht ab“ markiert).
    let sources: Vec<_> = colors.iter().zip(&flows).map(|(c, f)| source_sized(&ctx, *c, f, 640, 480)).collect();
    let out_flow = omp_node_sdk::idgen::new_v4();
    let config = Config {
        domain: domain.clone(),
        flow_ids: vec![out_flow.clone()],
        label: "pip-scene3".into(),
        width: 1280,
        height: 720,
        hwaccel: omp_mediaio::hwaccel::HwAccel::default(),
        stills: Arc::new(Mutex::new(Default::default())),
        pip_slots: 4,
        pip_2d_slots: 2,
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Receiver));
    let sd = shutdown.clone();
    let th = std::thread::spawn(move || pipeline::run(config, tx, sd, ready_tx, Arc::new(AtomicU64::new(0)), monitor));
    let h = ready_rx.blocking_recv().expect("ready").expect("pipeline");
    h.set_inputs(
        flows
            .iter()
            .enumerate()
            .map(|(i, f)| DiscoveredInput { sender_id: format!("s{i}"), label: format!("s{i}"), flow_id: f.clone(), device_id: String::new(), format: None })
            .collect(),
    );
    std::thread::sleep(Duration::from_secs(4));

    // Maße der Betriebsszene (1280x720) halbiert auf 640x360
    let r = |x, y, w, hh| PipPose::from_box(&DveBox { x, y, width: w, height: hh });
    let entry = |slot: usize, pose: PipPose, start: PipPose| PipEntry {
        slot,
        sender_id: Some(format!("s{slot}")),
        pose,
        start: Some(start),
        end: None,
        in_ms: 800,
        out_ms: 800,
        z: Some(4 + slot as u32),
        focus: None,
    };
    let entries = vec![
        entry(0, r(0, 467, 427, 240), r(1280, 467, 427, 240)),    // von rechts
        entry(1, r(442, 199, 427, 240), r(443, -240, 427, 240)), // von oben
        entry(2, r(847, 453, 427, 240), r(-427, 472, 427, 240)), // von links
    ];
    let mut pips = LevelPips::new(4, 2, 1280, 720);
    let actions = pips.plan_apply(&PipPreset { id: "p1".into(), name: "PIP 1".into(), entries });
    actions.iter().for_each(|a| a.run(&h, 0));
    std::thread::sleep(Duration::from_millis(2500));
    let d = grab(&ctx, &out_flow);
    let (a, b, c) = (px_w(&d, 213, 587, 1280), px_w(&d, 655, 319, 1280), px_w(&d, 1060, 573, 1280));
    println!("Slot0 {a:?}, Slot1 {b:?}, Slot2 {c:?}");
    assert!(is(a, RED), "Slot 0 (2D, von rechts) muss unten links stehen");
    assert!(is(b, GREEN), "Slot 1 (2D, von oben) muss in der Mitte stehen");
    assert!(is(c, BLUE), "Slot 2 (ohne 2D, von links) muss unten rechts stehen");

    shutdown.store(true, Ordering::Relaxed);
    let _ = th.join();
    while rx.try_recv().is_ok() {}
    for (p, _o) in sources {
        let _ = p.set_state(gst::State::Null);
    }
    let _ = std::fs::remove_dir_all(&domain);
}

/// Diagnose gegen einen LAUFENDEN Mischer (nur lesen): holt ein Bild des Programm-Flows und schreibt es als PPM nach
/// `OMP_DIAG_OUT`. `OMP_DIAG_DOMAIN` und `OMP_DIAG_FLOW` nennen Domäne und Flow-ID. Kein Teil der Regressionstests.
#[test]
#[ignore = "Diagnose am laufenden Stack: OMP_DIAG_DOMAIN, OMP_DIAG_FLOW, OMP_DIAG_OUT"]
fn diag_grab_running_pgm() {
    gst::init().unwrap();
    let domain = std::env::var("OMP_DIAG_DOMAIN").unwrap();
    let flow = std::env::var("OMP_DIAG_FLOW").unwrap();
    let out = std::env::var("OMP_DIAG_OUT").unwrap();
    let ctx = Arc::new(MxlContext::new(&domain).expect("MxlContext"));
    let pipe = gst::Pipeline::new();
    let input = MxlVideoInput::new(&pipe, ctx.clone(), &flow).expect("MxlVideoInput");
    let conv = gst::ElementFactory::make("videoconvert").build().unwrap();
    let sink = gst_app::AppSink::builder().caps(&gst::Caps::builder("video/x-raw").field("format", "RGBA").build()).sync(false).build();
    pipe.add_many([&conv, sink.upcast_ref()]).unwrap();
    gst::Element::link_many([&input.tail, &conv, sink.upcast_ref()]).unwrap();
    pipe.set_state(gst::State::Playing).unwrap();
    let mut last = None;
    for _ in 0..6 {
        if let Some(s) = sink.try_pull_sample(gst::ClockTime::from_seconds(5)) {
            last = Some(s);
        }
    }
    let s = last.expect("kein Bild");
    let caps = s.caps().unwrap().structure(0).unwrap().to_owned();
    let (w, h) = (caps.get::<i32>("width").unwrap() as usize, caps.get::<i32>("height").unwrap() as usize);
    let data = s.buffer().unwrap().map_readable().unwrap().as_slice().to_vec();
    let mut ppm = format!("P6\n{w} {h}\n255\n").into_bytes();
    for px in data.chunks(4) {
        ppm.extend_from_slice(&px[..3]);
    }
    std::fs::write(&out, ppm).unwrap();
    println!("{w}x{h} -> {out}");
    input.stop();
    let _ = pipe.set_state(gst::State::Null);
}

/// Misst die **Bewegung** der Einfahrt, nicht nur den Endzustand: ein Leser holt während der Szene fortlaufend Bilder des
/// Programm-Flows; je Bild wird festgehalten, wo die Farbfläche jedes Slots im Band seiner Zeile steht. Slot 0 (rot, 2D) fährt
/// von rechts, Slot 1 (grün, 2D) von oben, Slot 2 (blau, ohne 2D) von links. Jeder Slot muss unterwegs Zwischenstellungen zeigen.
#[test]
#[ignore = "braucht libmxl (deploy/dev/mxl.env) und startet eine echte Pipeline"]
fn pip_scene_entry_moves_every_slot() {
    use crate::pipstate::{LevelPips, PipEntry, PipPreset};
    gst::init().unwrap();
    let domain = format!("/dev/shm/omp-pip-move-{}", std::process::id());
    std::fs::create_dir_all(&domain).unwrap();
    let ctx = Arc::new(MxlContext::new(&domain).expect("MxlContext"));
    let colors = [0xFFFF0000u32, 0xFF00FF00, 0xFF0000FF];
    let flows: Vec<String> = (0..3).map(|_| omp_node_sdk::idgen::new_v4()).collect();
    let sources: Vec<_> = colors.iter().zip(&flows).map(|(c, f)| source_sized(&ctx, *c, f, 640, 480)).collect();
    let out_flow = omp_node_sdk::idgen::new_v4();
    let config = Config {
        domain: domain.clone(),
        flow_ids: vec![out_flow.clone()],
        label: "pip-move".into(),
        width: 1280,
        height: 720,
        hwaccel: omp_mediaio::hwaccel::HwAccel::default(),
        stills: Arc::new(Mutex::new(Default::default())),
        pip_slots: 4,
        pip_2d_slots: 2,
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let monitor = Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Receiver));
    let sd = shutdown.clone();
    let th = std::thread::spawn(move || pipeline::run(config, tx, sd, ready_tx, Arc::new(AtomicU64::new(0)), monitor));
    let h = ready_rx.blocking_recv().expect("ready").expect("pipeline");
    h.set_inputs(
        flows
            .iter()
            .enumerate()
            .map(|(i, f)| DiscoveredInput { sender_id: format!("s{i}"), label: format!("s{i}"), flow_id: f.clone(), device_id: String::new(), format: None })
            .collect(),
    );
    std::thread::sleep(Duration::from_secs(4));

    // Leser auf den Programm-Flow
    let rpipe = gst::Pipeline::new();
    let input = MxlVideoInput::new(&rpipe, ctx.clone(), &out_flow).expect("MxlVideoInput");
    let conv = gst::ElementFactory::make("videoconvert").build().unwrap();
    let sink = gst_app::AppSink::builder().caps(&gst::Caps::builder("video/x-raw").field("format", "RGBA").build()).sync(false).build();
    rpipe.add_many([&conv, sink.upcast_ref()]).unwrap();
    gst::Element::link_many([&input.tail, &conv, sink.upcast_ref()]).unwrap();
    rpipe.set_state(gst::State::Playing).unwrap();
    let _ = sink.try_pull_sample(gst::ClockTime::from_seconds(5)); // Leser läuft

    let r = |x, y, w, hh| PipPose::from_box(&DveBox { x, y, width: w, height: hh });
    let entry = |slot: usize, pose: PipPose, start: PipPose| PipEntry {
        slot,
        sender_id: Some(format!("s{slot}")),
        pose,
        start: Some(start),
        end: None,
        in_ms: 800,
        out_ms: 800,
        z: Some(4 + slot as u32),
        focus: None,
    };
    let entries = vec![
        entry(0, r(0, 467, 427, 240), r(1280, 467, 427, 240)),
        entry(1, r(442, 199, 427, 240), r(443, -240, 427, 240)),
        entry(2, r(847, 453, 427, 240), r(-427, 472, 427, 240)),
    ];
    let mut pips = LevelPips::new(4, 2, 1280, 720);
    let actions = pips.plan_apply(&PipPreset { id: "p1".into(), name: "PIP 1".into(), entries });
    let t0 = std::time::Instant::now();
    actions.iter().for_each(|a| a.run(&h, 0));

    // je Bild: Schwerpunkt der Farbpixel je Slot (rot: x im Band y 440..720; grün: y im Band x 400..900; blau: x im Band y 440..720)
    let mut frames: Vec<(u128, Option<f64>, Option<f64>, Option<f64>)> = Vec::new();
    while t0.elapsed() < Duration::from_millis(2200) {
        let Some(s) = sink.try_pull_sample(gst::ClockTime::from_mseconds(500)) else { continue };
        let ms = t0.elapsed().as_millis();
        let data = s.buffer().unwrap().map_readable().unwrap();
        let d = data.as_slice();
        let (mut rx_sum, mut rn) = (0f64, 0f64);
        let (mut gy_sum, mut gn) = (0f64, 0f64);
        let (mut bx_sum, mut bn) = (0f64, 0f64);
        for y in (0..720u32).step_by(6) {
            for x in (0..1280u32).step_by(6) {
                let c = px_w(d, x, y, 1280);
                if is(c, RED) && y >= 440 {
                    rx_sum += x as f64;
                    rn += 1.0;
                } else if is(c, GREEN) && (400..900).contains(&x) {
                    gy_sum += y as f64;
                    gn += 1.0;
                } else if is(c, BLUE) && y >= 440 {
                    bx_sum += x as f64;
                    bn += 1.0;
                }
            }
        }
        let avg = |sum: f64, n: f64| if n >= 4.0 { Some(sum / n) } else { None };
        frames.push((ms, avg(rx_sum, rn), avg(gy_sum, gn), avg(bx_sum, bn)));
    }
    let show = |v: Option<f64>| v.map_or("  –  ".to_string(), |x| format!("{x:5.0}"));
    for (ms, a, b, c) in frames.iter().step_by(3) {
        println!("{ms:5} ms  rot x={}  grün y={}  blau x={}", show(*a), show(*b), show(*c));
    }
    // Zwischenstellungen: Rot fährt von x≈1280 nach ≈213 (Mitte der Zielfläche), Grün von y≈-120 nach ≈320, Blau von x≈-213 nach ≈1060
    let mid = |sel: fn(&(u128, Option<f64>, Option<f64>, Option<f64>)) -> Option<f64>, lo: f64, hi: f64| frames.iter().filter_map(sel).any(|v| v > lo && v < hi);
    let red_moves = mid(|f| f.1, 300.0, 1000.0);
    let green_moves = mid(|f| f.2, -50.0, 280.0) || frames.iter().filter_map(|f| f.2).any(|y| y < 300.0);
    let blue_moves = mid(|f| f.3, 100.0, 950.0);
    println!("Slot 0 fährt: {red_moves}, Slot 1 fährt: {green_moves}, Slot 2 fährt: {blue_moves}");
    assert!(blue_moves, "Slot 2 (ohne 2D) fährt von links ein");
    assert!(red_moves, "Slot 0 (2D) muss von rechts einfahren, nicht springen");
    assert!(green_moves, "Slot 1 (2D) muss von oben einfahren, nicht springen");

    input.stop();
    let _ = rpipe.set_state(gst::State::Null);
    shutdown.store(true, Ordering::Relaxed);
    let _ = th.join();
    while rx.try_recv().is_ok() {}
    for (p, _o) in sources {
        let _ = p.set_state(gst::State::Null);
    }
    let _ = std::fs::remove_dir_all(&domain);
}

/// Diagnose am LAUFENDEN Mischer (nur lesen): misst `OMP_DIAG_MS` lang je Bild den Schwerpunkt der blauen Fläche (x, unteres
/// Band) und der weißen Fläche (y, mittleres Band). `OMP_DIAG_DOMAIN`, `OMP_DIAG_FLOW`.
#[test]
#[ignore = "Diagnose am laufenden Stack"]
fn diag_watch_running_pgm() {
    gst::init().unwrap();
    let domain = std::env::var("OMP_DIAG_DOMAIN").unwrap();
    let flow = std::env::var("OMP_DIAG_FLOW").unwrap();
    let ms: u64 = std::env::var("OMP_DIAG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000);
    let ctx = Arc::new(MxlContext::new(&domain).expect("MxlContext"));
    let pipe = gst::Pipeline::new();
    let input = MxlVideoInput::new(&pipe, ctx.clone(), &flow).expect("MxlVideoInput");
    let conv = gst::ElementFactory::make("videoconvert").build().unwrap();
    let sink = gst_app::AppSink::builder().caps(&gst::Caps::builder("video/x-raw").field("format", "RGBA").build()).sync(false).build();
    pipe.add_many([&conv, sink.upcast_ref()]).unwrap();
    gst::Element::link_many([&input.tail, &conv, sink.upcast_ref()]).unwrap();
    pipe.set_state(gst::State::Playing).unwrap();
    let t0 = std::time::Instant::now();
    let mut n = 0;
    while t0.elapsed() < Duration::from_millis(ms) {
        let Some(s) = sink.try_pull_sample(gst::ClockTime::from_mseconds(500)) else { continue };
        let data = s.buffer().unwrap().map_readable().unwrap();
        let d = data.as_slice();
        let (mut bx, mut bn, mut wy, mut wn) = (0f64, 0f64, 0f64, 0f64);
        for y in (0..720u32).step_by(6) {
            for x in (0..1280u32).step_by(6) {
                let c = px_w(d, x, y, 1280);
                let near = |a: [u8; 3], b: [u8; 3]| a.iter().zip(b).all(|(p, q)| (*p as i32 - q as i32).abs() < 40);
                if near(c, [0, 0, 255]) && y >= 440 {
                    bx += x as f64;
                    bn += 1.0;
                } else if near(c, [255, 255, 255]) && (400..900).contains(&x) {
                    wy += y as f64;
                    wn += 1.0;
                }
            }
        }
        n += 1;
        if n % 2 == 0 || n < 4 {
            let f = |s: f64, c: f64| if c >= 4.0 { format!("{:5.0}", s / c) } else { "  –  ".into() };
            println!("{:5} ms  blau(Slot0) x={}  weiß(Slot1) y={}", t0.elapsed().as_millis(), f(bx, bn), f(wy, wn));
        }
    }
    println!("Bilder gesamt: {n}");
    input.stop();
    let _ = pipe.set_state(gst::State::Null);
}
