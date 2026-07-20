//! Minimaler, isolierter Reproduktionsversuch für den in
//! `docs/decisions.md` Nachtrag 51 dokumentierten OOM-Bug (Kapitel 15
//! Teil 3 Rest 2, `omp-video-mixer-me`s Auflösungs-Hot-Swap) — bewusst
//! NICHT der volle Mixer-Node (fg/bg-Doppelpool, Compositor, Tally-Bus,
//! HTTP/Tokio), sondern nur der verdächtige Kern: ein `input-selector`
//! mit einem inaktiven Zweig plus derselbe Pad-Block-Hot-Swap-Mechanismus
//! wie `pipeline.rs::swap_input_resolution`. Nutzerentscheidung
//! 2026-07-20: dedizierte künftige Sitzung, NEUE Herangehensweise statt
//! desselben Live-Tests gegen den vollen Node.
//!
//! **Root-Cause-Ergebnis dieser Sitzung** (`docs/decisions.md` Nachtrag
//! 58): `MxlVideoInput`/`MxlAudioInput` (`omp-mediaio::mxl`) riefen
//! `sync_state_with_parent()` nie für ihre eigenen vier intern
//! angelegten Elemente auf — bei einem Hot-Swap in eine bereits
//! `PLAYING`-Pipeline blieben sie dadurch manchmal dauerhaft in `NULL`
//! hängen (per `Element::state()`-Abfrage hier live nachgewiesen).
//! Zusätzlich (unabhängig vom ersten Fund, per `GST_DEBUG=appsrc:5`
//! bestätigt): `appsrc` hatte kein `leaky-type`/`max-buffers` gesetzt —
//! seine interne Warteschlange wuchs dadurch in einem beobachteten Fall
//! unbegrenzt weiter, während stromabwärts nichts mehr ankam. Beide
//! Fixes sitzen jetzt in `omp-mediaio::mxl` (nicht in dieser Datei) und
//! gelten automatisch für `omp-switcher` mit. Live mit diesem Programm
//! UND dem echten `omp-video-mixer-me`-Node bestätigt: die interne
//! `appsrc`-Warteschlange bleibt jetzt auch bei vielen aufeinander-
//! folgenden Swaps hart gedeckelt (kein Wachstum mehr über wenige KB
//! hinaus, vorher +522 MB nach einem einzigen `autoTrans()`) — ein
//! davon **unabhängiger**, noch nicht root-gecauster Folgefehler bleibt
//! aber offen: der Pad-Block bei einem Swap auf denselben `isel`-
//! Sink-Pad, der bereits mindestens einmal zuvor erfolgreich getauscht
//! wurde, läuft nicht mehr zuverlässig in einen Timeout (der alte Zweig
//! bleibt dann unverändert bestehen, keine Auflösungsänderung, aber
//! auch kein Speicherverlust/Absturz) — für eine künftige Sitzung.
//!
//! Braucht zwei echte, aktiv laufende MXL-Video-Flows (z. B. ein
//! `omp-source` mit aktivierter Lowres-Vorschau, `activateLowresPreview`-
//! Methode). Aufruf:
//!   OMP_MXL_DOMAIN=/dev/shm/omp-mxl \
//!   cargo run --example oom_repro --features omp-mediaio/mxl -- \
//!     <flow-a-id> <flow-b-id>
//!
//! `OOM_REPRO_SWAPS` (Default 10) steuert die Anzahl der Swaps. Misst
//! RSS (`/proc/self/status` VmRSS) an mehreren Messpunkten: (1) direkt
//! nach dem Aufbau (Zweig liegt inaktiv auf `sink_1`), (2) nach 5s
//! Leerlauf (testet: wächst ein rein inaktiver Zweig von selbst,
//! unabhängig von jedem Swap? — nein, per Test widerlegt), (3-N) nach
//! jedem Swap zwischen Flow A und Flow B (mirror von "take, autoTrans,
//! take" aus dem Originalbefund).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use gstreamer as gst;
use gstreamer::prelude::*;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput};

const SWAP_BLOCK_TIMEOUT: Duration = Duration::from_millis(500);
const OLD_WRITER_DRAIN: Duration = Duration::from_millis(300);

fn rss_kb() -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").expect("read /proc/self/status");
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            return rest.trim().trim_end_matches(" kB").trim().parse().unwrap_or(0);
        }
    }
    0
}

fn report(label: &str, baseline_kb: u64) {
    let now = rss_kb();
    let delta = now as i64 - baseline_kb as i64;
    println!("[{label}] RSS = {now} kB (delta since start: {delta:+} kB)");
}

fn video_caps(width: u32, height: u32) -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("format", "RGBA")
        .field("width", width as i32)
        .field("height", height as i32)
        .field("framerate", gst::Fraction::new(25, 1))
        .build()
}

/// Ein normalisierter Zweig — Kopie von
/// `pipeline.rs::build_normalized_branch`, liefert alle vier selbst
/// hinzugefügten Elemente zurück (Teardown-Symmetrie mit dem Original).
fn build_branch(pipeline: &gst::Pipeline, tail: &gst::Element, width: u32, height: u32) -> (gst::Element, Vec<gst::Element>) {
    let videoconvert = gst::ElementFactory::make("videoconvert").build().unwrap();
    let videoscale = gst::ElementFactory::make("videoscale").build().unwrap();
    let videorate = gst::ElementFactory::make("videorate").build().unwrap();
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", video_caps(width, height))
        .build()
        .unwrap();
    pipeline.add(&videoconvert).unwrap();
    pipeline.add(&videoscale).unwrap();
    pipeline.add(&videorate).unwrap();
    pipeline.add(&caps).unwrap();
    gst::Element::link_many([tail, &videoconvert, &videoscale, &videorate, &caps]).unwrap();
    for el in [&videoconvert, &videoscale, &videorate, &caps] {
        el.sync_state_with_parent().unwrap();
    }
    for el in [&videoconvert, &videoscale, &videorate, &caps] {
        let (result, state, _pending) = el.state(gst::ClockTime::from_seconds(2));
        if result.is_err() {
            println!("    WARNING: {} did not settle: {state:?}", el.name());
        }
    }
    (caps.clone(), vec![videoconvert, videoscale, videorate, caps])
}

fn teardown_mxl_input(pipeline: &gst::Pipeline, input: MxlVideoInput) {
    for el in &input.elements {
        let _ = el.set_state(gst::State::Null);
        let _ = pipeline.remove(el);
    }
    drop(input);
}

fn teardown_chain(pipeline: &gst::Pipeline, elements: &[gst::Element]) {
    for el in elements {
        let _ = el.set_state(gst::State::Null);
        let _ = pipeline.remove(el);
    }
}

struct Branch {
    mxl_input: MxlVideoInput,
    chain: Vec<gst::Element>,
}

fn build_test_branch(pipeline: &gst::Pipeline, context: &Arc<MxlContext>, flow_id: &str, width: u32, height: u32) -> (Branch, gst::Element) {
    let mxl_input = MxlVideoInput::new(pipeline, context.clone(), flow_id).expect("MxlVideoInput::new");
    let (caps, chain) = build_branch(pipeline, &mxl_input.tail, width, height);
    (Branch { mxl_input, chain }, caps)
}

/// Ein einzelner Swap — 1:1-Nachbau von
/// `pipeline.rs::swap_input_resolution`s Kernlogik (Pad-Block-Probe,
/// Entlinken im Callback, Element-Auf-/Abbau strikt danach auf diesem
/// Thread), hier reduziert auf genau einen Zweig statt fg+bg.
fn swap(
    pipeline: &gst::Pipeline,
    context: &Arc<MxlContext>,
    isel_sink_pad: &gst::Pad,
    old_branch: Branch,
    new_flow_id: &str,
    width: u32,
    height: u32,
) -> Branch {
    let (unblocked_tx, unblocked_rx) = std::sync::mpsc::sync_channel::<()>(1);
    let task = Mutex::new(Some(unblocked_tx));
    let probe_id = isel_sink_pad
        .add_probe(gst::PadProbeType::BLOCK_DOWNSTREAM, move |pad, _info| {
            let Some(tx) = task.lock().unwrap().take() else {
                return gst::PadProbeReturn::Remove;
            };
            if let Some(peer) = pad.peer() {
                let _ = peer.unlink(pad);
            }
            let _ = tx.send(());
            gst::PadProbeReturn::Remove
        })
        .expect("add_probe");

    if unblocked_rx.recv_timeout(SWAP_BLOCK_TIMEOUT).is_err() {
        // Kein panic! hier (anders als eine frühere Fassung dieses
        // Reproduktionsversuchs) — die echte `swap_input_resolution`
        // in pipeline.rs behandelt einen Timeout genauso: loggen,
        // alten Zweig unangetastet zurückgeben, Prozess läuft normal
        // weiter. Ein panic! hier würde stattdessen den ganzen Prozess
        // mitten im Stack-Unwind beenden, während der alte Zweig noch
        // einen laufenden Hintergrund-Lese-Thread mit einer lebenden
        // Referenz auf ein Pipeline-Element hält (`MxlVideoInput::Drop`
        // wartet nicht auf dessen Ende) — das ist ein Artefakt des
        // Test-Kabelbaums, nicht des eigentlichen Mixer-Bugs.
        isel_sink_pad.remove_probe(probe_id);
        println!("  swap: TIMED OUT waiting for the blocked pad unlink, keeping old branch (flow unchanged)");
        return old_branch;
    }

    teardown_chain(pipeline, &old_branch.chain);
    teardown_mxl_input(pipeline, old_branch.mxl_input);
    std::thread::sleep(OLD_WRITER_DRAIN);

    let (new_branch, caps) = build_test_branch(pipeline, context, new_flow_id, width, height);
    caps.static_pad("src").unwrap().link(isel_sink_pad).expect("link swapped branch");
    for el in new_branch.mxl_input.elements.iter().chain(new_branch.chain.iter()) {
        let (result, state, _pending) = el.state(gst::ClockTime::from_seconds(2));
        if result.is_err() {
            println!("    WARNING: {} did not settle: {state:?}", el.name());
        }
    }
    new_branch
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: oom_repro <flow-a-id> <flow-b-id>");
        std::process::exit(2);
    }
    let flow_a = args[1].clone();
    let flow_b = args[2].clone();
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/omp-mxl".to_string());

    gst::init().expect("gst::init");
    let context = Arc::new(MxlContext::new(&domain).expect("MxlContext::new"));

    let pipeline = gst::Pipeline::new();
    let isel = gst::ElementFactory::make("input-selector")
        .property("sync-streams", false)
        .build()
        .unwrap();
    pipeline.add(&isel).unwrap();

    let width = 640u32;
    let height = 480u32;

    // sink_0: schwarzes Testbild, bleibt die ganze Zeit aktiv (hält die
    // Pipeline "am Leben" unabhängig vom eigentlichen Testzweig).
    let black = gst::ElementFactory::make("videotestsrc").property("is-live", true).build().unwrap();
    black.set_property_from_str("pattern", "black");
    pipeline.add(&black).unwrap();
    let (black_caps, _black_chain) = build_branch(&pipeline, &black, width, height);
    let black_pad = isel.request_pad_simple("sink_0").unwrap();
    black_caps.static_pad("src").unwrap().link(&black_pad).unwrap();

    // sink_1: der eigentliche Testzweig (Flow A) — bleibt INAKTIV
    // (isel's active-pad zeigt auf sink_0/black), exakt wie ein
    // unselektierter Preset-/bg-Zweig im echten Mixer.
    let (mut branch, caps_a) = build_test_branch(&pipeline, &context, &flow_a, width, height);
    let test_pad = isel.request_pad_simple("sink_1").unwrap();
    caps_a.static_pad("src").unwrap().link(&test_pad).unwrap();

    let fakesink = gst::ElementFactory::make("fakesink").property("sync", false).build().unwrap();
    pipeline.add(&fakesink).unwrap();
    gst::Element::link(&isel, &fakesink).unwrap();

    isel.set_property("active-pad", &black_pad);

    pipeline.set_state(gst::State::Playing).expect("set state playing");
    std::thread::sleep(Duration::from_millis(500)); // startup settle time

    let baseline = rss_kb();
    println!("=== Baseline (after build, test branch inactive on Flow A) ===");
    report("t=0s", baseline);

    println!("=== 5s idle (test branch stays inactive, Flow A keeps flowing) ===");
    for i in 1..=5 {
        std::thread::sleep(Duration::from_secs(1));
        report(&format!("idle t={i}s"), baseline);
    }

    let swaps: usize = std::env::var("OOM_REPRO_SWAPS").ok().and_then(|s| s.parse().ok()).unwrap_or(10);
    for n in 1..=swaps {
        let target = if n % 2 == 1 { &flow_b } else { &flow_a };
        let label = if n % 2 == 1 { "B" } else { "A" };
        println!("=== Swap {n}: -> Flow {label} ===");
        branch = swap(&pipeline, &context, &test_pad, branch, target, width, height);
        report(&format!("after swap {n}"), baseline);
        std::thread::sleep(Duration::from_millis(200));
    }

    println!("=== Done, 2s follow-up observation ===");
    for i in 1..=2 {
        std::thread::sleep(Duration::from_secs(1));
        report(&format!("post t={i}s"), baseline);
    }

    drop(branch);
    let _ = fakesink;
    pipeline.set_state(gst::State::Null).ok();
}
