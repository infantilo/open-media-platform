//! Misst, ob blockierendes Lesen (`get_complete_grain(index, timeout)`) mit mehreren gleichzeitigen Lesern auf einem Flow
//! in der HEUTIGEN MXL-Version (1.1.0 GA) zuverlässig ist und wie viel CPU es spart gegenüber dem Abfragen
//! (`get_grain_non_blocking` + Schlafen). Hintergrund: der dokumentierte "MXL-Read-Livelock" (docs/decisions.md 2026-07-09/
//! 2026-07-17: Aufruf kehrt trotz Timeout nicht zurück, ein Thread dreht bei 100 % CPU) — hier wird er gezielt gesucht.
//!
//!   OMP_MXL_DOMAIN=/dev/shm/omp-mxl cargo run --release -p omp-mediaio --example blocking_read_probe --features mxl -- \
//!     <flow-id> <leser> <sekunden> <block|poll> [timeout_ms]
//!
//! Ausgabe je Leser: gelesene Grains, längste Aufrufdauer, Aufrufe die das Timeout um mehr als 100 ms überschritten
//! (= Livelock-Signatur), CPU-Zeit des Threads.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

fn thread_cpu_ms() -> f64 {
    // CLOCK_THREAD_CPUTIME_ID des aufrufenden Threads
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as f64 * 1000.0 + ts.tv_nsec as f64 / 1e6
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 5 {
        eprintln!("usage: blocking_read_probe <flow-id> <leser> <sekunden> <block|poll> [timeout_ms]");
        std::process::exit(2);
    }
    let flow_id = a[1].clone();
    let readers: usize = a[2].parse().expect("leser");
    let secs: u64 = a[3].parse().expect("sekunden");
    let churn = a[4] == "churn"; // Leser ständig neu anlegen/schließen (der Auslöser des alten Livelocks: Quellwahl im Viewer)
    let block = a[4] == "block" || churn;
    let timeout_ms: u64 = a.get(5).and_then(|v| v.parse().ok()).unwrap_or(100);
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/omp-mxl".to_string());

    let api = mxl::load_api("libmxl.so").expect("load_api");
    let instance = Arc::new(mxl::MxlInstance::new(api, &domain, "").expect("MxlInstance::new"));
    let stop = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::new();
    for n in 0..readers {
        let (instance, stop, flow_id) = (instance.clone(), stop.clone(), flow_id.clone());
        handles.push(thread::spawn(move || {
            let mut reader = instance.create_flow_reader(&flow_id).expect("create_flow_reader").to_grain_reader().expect("to_grain_reader");
            let rate = reader.get_config_info().expect("cfg").common().grain_rate().expect("rate");
            let mut index = instance.get_current_index(&rate).saturating_sub(2);
            let mut since_open = 0u32;
            let (mut got, mut longest, mut over, mut timeouts, mut errs) = (0u64, Duration::ZERO, 0u64, 0u64, 0u64);
            let cpu0 = thread_cpu_ms();
            while !stop.load(Ordering::Relaxed) {
                let t = Instant::now();
                let res = if block {
                    reader.get_complete_grain(index, Duration::from_millis(timeout_ms)).map(|g| g.index)
                } else {
                    reader.get_grain_non_blocking(index).map(|g| g.index)
                };
                let d = t.elapsed();
                longest = longest.max(d);
                if block && d > Duration::from_millis(timeout_ms + 100) {
                    over += 1;
                }
                if churn {
                    since_open += 1;
                    if since_open >= 8 {
                        // alten Leser verwerfen und sofort einen neuen öffnen
                        drop(reader);
                        reader = instance.create_flow_reader(&flow_id).expect("create_flow_reader").to_grain_reader().expect("to_grain_reader");
                        index = instance.get_current_index(&rate).saturating_sub(2);
                        since_open = 0;
                    }
                }
                match res {
                    Ok(i) if i == index => {
                        got += 1;
                        index += 1;
                    }
                    Ok(i) if i > index => index = instance.get_current_index(&rate).saturating_sub(1),
                    Ok(_) => {}
                    Err(mxl::Error::Timeout) => timeouts += 1,
                    Err(mxl::Error::OutOfRangeTooLate) => index = instance.get_current_index(&rate).saturating_sub(1),
                    Err(mxl::Error::OutOfRangeTooEarly) => {
                        if !block {
                            thread::sleep(Duration::from_millis(2));
                        }
                    }
                    Err(_) => {
                        errs += 1;
                        thread::sleep(Duration::from_millis(20));
                    }
                }
                if !block && res_is_wait(got) {
                    // nach jedem Grain bis kurz vor das nächste schlafen (wie rawcopy)
                    thread::sleep(Duration::from_millis(25));
                }
            }
            let cpu = thread_cpu_ms() - cpu0;
            println!(
                "Leser {n}: {got} Grains, längster Aufruf {:.0} ms, {over} Aufrufe > Timeout+100 ms, {timeouts} Timeouts, {errs} Fehler, CPU {cpu:.0} ms",
                longest.as_secs_f64() * 1000.0
            );
            (got, over, cpu)
        }));
    }
    thread::sleep(Duration::from_secs(secs));
    stop.store(true, Ordering::Relaxed);
    let (mut got, mut over, mut cpu) = (0u64, 0u64, 0f64);
    for h in handles {
        let (g, o, c) = h.join().expect("join");
        got += g;
        over += o;
        cpu += c;
    }
    println!(
        "== {} Leser, Modus {}, {secs} s: {got} Grains gesamt ({:.1}/s je Leser), Überschreitungen {over}, CPU gesamt {cpu:.0} ms = {:.1} % eines Kerns",
        readers,
        if block { "blockierend" } else { "abfragend" },
        got as f64 / readers as f64 / secs as f64,
        cpu / (secs as f64 * 10.0)
    );
}

fn res_is_wait(_got: u64) -> bool {
    true
}
