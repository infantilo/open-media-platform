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
    let pipe = gst::Pipeline::new();
    let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).build().unwrap();
    src.set_property_from_str("pattern", "solid-color");
    src.set_property("foreground-color", color_argb);
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("video/x-raw").field("format", "RGBA").field("width", W as i32).field("height", H as i32).field("framerate", gst::Fraction::new(25, 1)).build())
        .build()
        .unwrap();
    pipe.add_many([&src, &caps]).unwrap();
    gst::Element::link_many([&src, &caps]).unwrap();
    let out = MxlVideoOutput::new_from_rgba(&pipe, &caps, ctx.clone(), flow, "test", W, H, 25, 1, Arc::new(AtomicU64::new(0))).expect("MxlVideoOutput");
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
