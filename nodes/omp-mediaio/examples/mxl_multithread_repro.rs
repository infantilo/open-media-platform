//! Testet gezielt echte Multi-Thread-Nebenläufigkeit gegen dieselbe
//! `MxlInstance` — anders als `mxl_concurrent_reader_repro` (zwei
//! Reader, aber beide sequentiell vom selben Thread aus erzeugt/gelesen)
//! spawnt dieses Programm für jeden Reader einen **echten eigenen
//! OS-Thread** (wie `MxlVideoInput::new`s `read_loop`-Thread) und lässt
//! einen Thread kontinuierlich Grains lesen, während der Haupt-Thread
//! *währenddessen* einen weiteren Reader auf einem ANDEREN Flow anlegt
//! und wieder freigibt, im Loop — `InstanceContext` ist als
//! `unsafe impl Send + Sync` markiert mit dem Kommentar "MXL API ist
//! auf Instanz-Ebene thread-safe" (`third_party/mxl/rust/mxl/src/
//! instance.rs`); dieser Test prüft diese Annahme empirisch statt sie
//! zu übernehmen.
//!
//! Aufruf:
//!   OMP_MXL_DOMAIN=/dev/shm/omp-mxl \
//!   cargo run --package omp-mediaio --example mxl_multithread_repro --features mxl -- \
//!     <flow-a-id> <flow-b-id>

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: mxl_multithread_repro <flow-a-id> <flow-b-id>");
        std::process::exit(2);
    }
    let flow_a = args[1].clone();
    let flow_b = args[2].clone();
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/omp-mxl".to_string());

    let api = mxl::load_api("libmxl.so").expect("load_api");
    let instance = Arc::new(mxl::MxlInstance::new(api, &domain, "").expect("MxlInstance::new"));

    let running = Arc::new(AtomicBool::new(true));

    // Hintergrund-Thread: liest kontinuierlich Flow A, exakt wie
    // `read_loop` in omp-mediaio::mxl (eigener GrainReader, eigener
    // Thread, kein Join beim Beenden — hier bewusst per JoinHandle
    // beobachtet, um zu sehen, WANN er wirklich endet, nicht nur wann
    // wir es ihm sagen).
    let reader_instance = instance.clone();
    let reader_flow = flow_a.clone();
    let reader_running = running.clone();
    let reader_thread = std::thread::spawn(move || {
        let reader = reader_instance.create_flow_reader(&reader_flow).expect("create_flow_reader(bg)");
        let grain_reader = reader.to_grain_reader().expect("to_grain_reader(bg)");
        let rate = grain_reader.get_config_info().unwrap().common().grain_rate().unwrap();
        let mut index = reader_instance.get_current_index(&rate);
        let mut reads = 0u64;
        while reader_running.load(Ordering::Relaxed) {
            match grain_reader.get_grain_non_blocking(index) {
                Ok(g) => {
                    let _ = g.payload.len();
                    index += 1;
                    reads += 1;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        println!("background thread: stopping after {reads} reads, dropping its GrainReader now");
        drop(grain_reader);
        println!("background thread: GrainReader dropped, thread exiting");
    });

    // Haupt-Thread: legt WÄHREND der Hintergrund-Thread aktiv liest
    // wiederholt einen Reader auf Flow B an und gibt ihn sofort wieder
    // frei — echte Multi-Thread-Nebenläufigkeit gegen dieselbe Instanz,
    // kein `join()` zwischen den beiden Threads.
    for cycle in 1..=20 {
        let reader = instance.create_flow_reader(&flow_b).expect("create_flow_reader(main)");
        let grain_reader = reader.to_grain_reader().expect("to_grain_reader(main)");
        let rate = grain_reader.get_config_info().unwrap().common().grain_rate().unwrap();
        let index = instance.get_current_index(&rate);
        let _ = grain_reader.get_grain_non_blocking(index);
        drop(grain_reader);
        println!("main thread: cycle {cycle} on flow B done (background thread still reading flow A concurrently)");
        std::thread::sleep(Duration::from_millis(20));
    }

    println!("=== signalling background thread to stop, WITHOUT waiting for it (mirrors MxlVideoInput::Drop) ===");
    running.store(false, Ordering::Relaxed);
    // Bewusst KEIN join() hier zuerst — stattdessen sofort einen neuen
    // Reader auf Flow A (denselben Flow, den der Hintergrund-Thread
    // gerade noch offen haben könnte) anlegen, exakt die Situation, die
    // `swap_input_resolution`s feste Sleep-Heuristik nur *hofft*
    // rechtzeitig aufzulösen.
    println!("=== immediately (no sleep) opening a NEW reader on flow A from the main thread ===");
    let reader2 = instance.create_flow_reader(&flow_a).expect("create_flow_reader(A again, racing)");
    let grain_reader2 = reader2.to_grain_reader().expect("to_grain_reader(A again, racing)");
    let rate2 = grain_reader2.get_config_info().unwrap().common().grain_rate().unwrap();
    let index2 = instance.get_current_index(&rate2);
    match grain_reader2.get_grain_non_blocking(index2) {
        Ok(g) => println!("new reader on flow A: read ok, {} bytes", g.payload.len()),
        Err(e) => println!("new reader on flow A: read failed: {e}"),
    }

    println!("=== now joining the background thread ===");
    reader_thread.join().expect("background thread join");

    println!("=== completed without crashing ===");
    drop(grain_reader2);
}
