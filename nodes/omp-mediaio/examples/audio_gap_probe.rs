//! Sucht Aussetzer (Stille-Läufe ≥ 1 ms mitten in einem lauten Signal) in einem MXL-Audio-Flow und meldet
//! TAI-Zeit und Länge. Nur zum Messen von Tonlücken (Kap. 31).
//!   cargo run -p omp-mediaio --features mxl --example audio_gap_probe -- <domain> <audio_flow> <sekunden>
use std::time::{Duration, Instant};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (domain, aflow) = (&a[1], &a[2]);
    let secs: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(30);
    let api = mxl::load_api("libmxl.so").expect("libmxl");
    let inst = mxl::MxlInstance::new(api, domain, "").expect("instance");
    let adef: serde_json::Value = serde_json::from_str(&inst.get_flow_def(aflow).unwrap()).unwrap();
    let arate = mxl_sys::Rational { numerator: adef["sample_rate"]["numerator"].as_i64().unwrap(), denominator: 1 };
    let ar = inst.create_flow_reader(aflow).unwrap().to_samples_reader().unwrap();
    let mut aidx = inst.get_current_index(&arate);
    const BATCH: u64 = 480;
    let (mut run, mut loud_seen, mut resets, mut total) = (0u64, false, 0u32, 0u64);
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        match ar.get_samples_non_blocking(aidx, BATCH as usize) {
            Ok(d) => {
                if let Ok((d1, d2)) = d.channel_data(0) {
                    for (i, c) in d1.chunks_exact(4).chain(d2.chunks_exact(4)).enumerate() {
                        let s = f32::from_le_bytes(c.try_into().unwrap());
                        if s.abs() < 1e-4 {
                            run += 1;
                        } else {
                            if loud_seen && run >= 48 {
                                let at = aidx + i as u64 - run;
                                println!("LÜCKE {} Samples ({:.1} ms) @ TAI {}", run, run as f64 / 48.0, inst.index_to_timestamp(at, &arate).unwrap());
                            }
                            if s.abs() > 0.01 {
                                loud_seen = true;
                            }
                            run = 0;
                        }
                    }
                }
                aidx += BATCH;
                total += BATCH;
            }
            Err(mxl::Error::OutOfRangeTooLate) => {
                resets += 1;
                aidx = inst.get_current_index(&arate);
            }
            Err(_) => std::thread::sleep(Duration::from_millis(2)),
        }
    }
    println!("fertig: {} s gelesen, Reader-Resets {resets}", total / 48000);
}
