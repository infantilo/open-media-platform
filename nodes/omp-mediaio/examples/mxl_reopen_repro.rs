//! Minimaler, GStreamer-freier Reproduktionsversuch: öffnet einen echten
//! MXL-`GrainReader` auf einen Flow, liest ein paar Grains, gibt ihn
//! wieder frei (`drop`), und öffnet danach — im selben Prozess, über
//! dieselbe `MxlInstance` — einen NEUEN Reader auf **denselben** Flow.
//! Isoliert die Frage, ob ein per-Prozess-Reopen desselben Flows
//! innerhalb von `libmxl.so` selbst ein Problem ist, komplett unabhängig
//! von GStreamer/appsrc/Pipeline-Komplexität (Kapitel 15 Teil 3 Rest 2,
//! `docs/decisions.md` Nachtrag 51 — dedizierte künftige Sitzung, neue
//! Herangehensweise statt desselben Live-Tests).
//!
//! Aufruf:
//!   OMP_MXL_DOMAIN=/dev/shm/omp-mxl \
//!   cargo run --package omp-mediaio --example mxl_reopen_repro --features mxl -- \
//!     <flow-id> [drain-ms]

use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: mxl_reopen_repro <flow-id> [drain-ms]");
        std::process::exit(2);
    }
    let flow_id = args[1].clone();
    let drain_ms: u64 = args.get(2).map(|s| s.parse().unwrap()).unwrap_or(300);
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/omp-mxl".to_string());

    let api = mxl::load_api("libmxl.so").expect("load_api");
    let instance = mxl::MxlInstance::new(api, &domain, "").expect("MxlInstance::new");

    for cycle in 1..=4 {
        println!("=== cycle {cycle}: open reader on {flow_id} ===");
        let reader = instance.create_flow_reader(&flow_id).expect("create_flow_reader");
        let grain_reader = reader.to_grain_reader().expect("to_grain_reader");
        let rate = grain_reader
            .get_config_info()
            .expect("get_config_info")
            .common()
            .grain_rate()
            .expect("grain_rate");
        let mut index = instance.get_current_index(&rate);
        let mut read_ok = 0;
        for _ in 0..10 {
            match grain_reader.get_grain_non_blocking(index) {
                Ok(g) => {
                    read_ok += 1;
                    let _ = g.payload.len();
                    index += 1;
                }
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
        println!("cycle {cycle}: read {read_ok}/10 grains ok, now dropping reader");
        drop(grain_reader);
        println!("cycle {cycle}: reader dropped, draining {drain_ms}ms before next open");
        std::thread::sleep(Duration::from_millis(drain_ms));
    }

    println!("=== all cycles completed without crashing ===");
}
