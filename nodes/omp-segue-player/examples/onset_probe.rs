//! Messwerkzeug: liest einen MXL-Audio-Flow direkt aus der Domain und meldet die MXL-Zeit (TAI, ns) der **ersten Probe über der
//! Schwelle** nach einem Startzeitpunkt — Grundlage der Messung „Startabweichung des Segue-Players“ (Kapitel 89/RB3).
//!
//! `onset_probe <flow-id> <seit-TAI-ns> [Sekunden=15] [Schwelle=0.05] [Domain=/dev/shm/omp-mxl]`
//! Ausgabe je Einsatz: `ONSET <tai_ns>`; mit mehreren Einsätzen (Pause > 0,3 s dazwischen) mehrere Zeilen.

use omp_mediaio::mxl::MxlContext;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let flow = a.get(1).expect("flow-id");
    let since: u64 = a.get(2).expect("seit-TAI-ns").parse().expect("Zahl");
    let secs: f64 = a.get(3).map_or(15.0, |s| s.parse().unwrap_or(15.0));
    let thr: f32 = a.get(4).map_or(0.05, |s| s.parse().unwrap_or(0.05));
    let domain = a.get(5).cloned().unwrap_or_else(|| "/dev/shm/omp-mxl".into());
    let ctx = MxlContext::new(&domain).expect("MXL-Domain");
    let reader = ctx.instance().create_flow_reader(flow).expect("Flow").to_samples_reader().expect("Samples-Leser");
    let rate = mxl_sys::Rational { numerator: 48_000, denominator: 1 };
    let batch = 48u64; // 1 ms
    // MXL adressiert einen Sample-Block über den Index seines LETZTEN Samples
    let mut index = ctx.ns_to_index(since, 48_000, 1).expect("Index") + batch - 1;
    let end = std::time::Instant::now() + std::time::Duration::from_secs_f64(secs);
    let mut quiet_since: Option<u64> = None;
    let mut in_tone = false;
    while std::time::Instant::now() < end {
        match reader.get_samples_non_blocking(index, batch as usize) {
            Ok(data) => {
                let mut first: Option<u64> = None;
                if let Ok((d1, d2)) = data.channel_data(0) {
                    for (i, c) in d1.chunks_exact(4).chain(d2.chunks_exact(4)).enumerate() {
                        let v = f32::from_le_bytes([c[0], c[1], c[2], c[3]]).abs();
                        if v > thr {
                            first.get_or_insert(index + 1 - batch + i as u64);
                        }
                    }
                }
                match first {
                    Some(i) => {
                        if !in_tone {
                            if let Some(ns) = ctx.index_to_ns(i, 48_000, 1) {
                                println!("ONSET {ns}");
                            }
                            in_tone = true;
                        }
                        quiet_since = None;
                    }
                    None => {
                        let q = *quiet_since.get_or_insert(index);
                        if index - q > 48_000 * 3 / 10 {
                            in_tone = false;
                        }
                    }
                }
                index += batch;
            }
            Err(mxl::Error::OutOfRangeTooLate) => index = ctx.instance().get_current_index(&rate),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(1)), // noch nicht geschrieben: warten
        }
    }
}
