//! Testet gezielt, ob **zwei gleichzeitig offene** `GrainReader` auf
//! demselben Flow (nicht: nacheinander wie `mxl_reopen_repro`) das in
//! `mxl_reopen_repro` NICHT reproduzierte Crash-Verhalten auslösen —
//! Hypothese: `MxlVideoInput::Drop` setzt in `omp-mediaio` nur ein
//! Stop-Flag für den Lese-Thread, wartet aber nicht (`join()`) auf sein
//! tatsächliches Ende, bevor ein Aufrufer einen neuen Reader auf
//! denselben Flow eröffnet (`swap_input_resolution`s feste
//! `OLD_WRITER_DRAIN`-Sleep ist nur eine Heuristik, keine echte
//! Synchronisation) — ein spät geplanter alter Lese-Thread könnte seinen
//! `GrainReader` noch halten, während bereits ein neuer für denselben
//! Flow existiert.
//!
//! Aufruf:
//!   OMP_MXL_DOMAIN=/dev/shm/omp-mxl \
//!   cargo run --package omp-mediaio --example mxl_concurrent_reader_repro --features mxl -- \
//!     <flow-id>

use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: mxl_concurrent_reader_repro <flow-id>");
        std::process::exit(2);
    }
    let flow_id = args[1].clone();
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/omp-mxl".to_string());

    let api = mxl::load_api("libmxl.so").expect("load_api");
    let instance = mxl::MxlInstance::new(api, &domain, "").expect("MxlInstance::new");

    println!("=== opening reader 1 on {flow_id} (kept alive) ===");
    let reader1 = instance.create_flow_reader(&flow_id).expect("create_flow_reader(1)");
    let grain_reader1 = reader1.to_grain_reader().expect("to_grain_reader(1)");
    let rate = grain_reader1
        .get_config_info()
        .expect("get_config_info")
        .common()
        .grain_rate()
        .expect("grain_rate");
    let index1 = instance.get_current_index(&rate);
    match grain_reader1.get_grain_non_blocking(index1) {
        Ok(g) => println!("reader 1: read ok, {} bytes", g.payload.len()),
        Err(e) => println!("reader 1: read failed: {e}"),
    }

    println!("=== reader 1 still alive, now opening reader 2 on the SAME flow ===");
    let reader2 = instance.create_flow_reader(&flow_id).expect("create_flow_reader(2)");
    let grain_reader2 = reader2.to_grain_reader().expect("to_grain_reader(2)");
    let index2 = instance.get_current_index(&rate);
    match grain_reader2.get_grain_non_blocking(index2) {
        Ok(g) => println!("reader 2: read ok, {} bytes", g.payload.len()),
        Err(e) => println!("reader 2: read failed: {e}"),
    }

    println!("=== both readers alive simultaneously, reading a few more grains from each ===");
    let mut i1 = index1;
    let mut i2 = index2;
    for round in 0..20 {
        match grain_reader1.get_grain_non_blocking(i1) {
            Ok(g) => {
                i1 += 1;
                let _ = g.payload.len();
            }
            Err(_) => std::thread::sleep(Duration::from_millis(5)),
        }
        match grain_reader2.get_grain_non_blocking(i2) {
            Ok(g) => {
                i2 += 1;
                let _ = g.payload.len();
            }
            Err(_) => std::thread::sleep(Duration::from_millis(5)),
        }
        println!("round {round}: reader1 idx={i1}, reader2 idx={i2}");
    }

    println!("=== dropping reader 1 while reader 2 stays alive ===");
    drop(grain_reader1);
    for round in 0..10 {
        match grain_reader2.get_grain_non_blocking(i2) {
            Ok(g) => {
                i2 += 1;
                let _ = g.payload.len();
            }
            Err(_) => std::thread::sleep(Duration::from_millis(5)),
        }
        println!("post-drop round {round}: reader2 idx={i2}");
    }

    println!("=== completed without crashing ===");
    drop(grain_reader2);
}
