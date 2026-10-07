//! End-to-End-Messung ohne Kenntnis des Take-Zeitpunkts (Kap. 31.4): liest den Programmausgang eines
//! Bildmischers und eines Tonmischers und listet jeden Bildwechsel (Mittelwert springt) und jeden
//! Tonwechsel (laut ↔ Stille) mit TAI-Zeit. Je Take sollten beide innerhalb desselben Bildes liegen
//! (Ton-Kante = Bildanfang + ≤ 1 ms, weil die Automation 0,5 ms hinter die Bildgrenze rundet).
//!
//!   cargo run -p omp-mediaio --features mxl --example edge_probe -- <domain> <video_flow> <audio_flow> <sekunden>
use std::time::{Duration, Instant};

fn rate(def: &serde_json::Value, key: &str) -> mxl_sys::Rational {
    mxl_sys::Rational {
        numerator: def[key]["numerator"].as_i64().unwrap(),
        denominator: def[key]["denominator"].as_i64().unwrap_or(1),
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (domain, vflow, aflow) = (&a[1], &a[2], &a[3]);
    let secs: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(30);
    let api = mxl::load_api("libmxl.so").expect("libmxl");
    let inst = mxl::MxlInstance::new(api, domain, "").expect("instance");
    let vdef: serde_json::Value = serde_json::from_str(&inst.get_flow_def(vflow).unwrap()).unwrap();
    let adef: serde_json::Value = serde_json::from_str(&inst.get_flow_def(aflow).unwrap()).unwrap();
    let vrate = rate(&vdef, "grain_rate");
    let arate = rate(&adef, "sample_rate");
    let vr = inst.create_flow_reader(vflow).unwrap().to_grain_reader().unwrap();
    let ar = inst.create_flow_reader(aflow).unwrap().to_samples_reader().unwrap();
    let mut vidx = inst.get_current_index(&vrate);
    let mut aidx = inst.get_current_index(&arate);
    const BATCH: u64 = 480;
    let mut prev_mean: Option<f64> = None;
    let mut vedges: Vec<(u64, f64)> = Vec::new();
    let mut quiet_run = 0u64;
    let mut state_loud: Option<bool> = None;
    let mut aedges: Vec<(u64, bool)> = Vec::new();
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        let mut idle = true;
        match vr.get_grain_non_blocking(vidx) {
            Ok(g) if g.index == vidx => {
                let p = &g.payload[..g.payload.len().min(1 << 16)];
                let m = p.iter().map(|&b| b as f64).sum::<f64>() / p.len() as f64;
                if prev_mean.is_some_and(|pm| (m - pm).abs() > 5.0) {
                    vedges.push((vidx, m));
                }
                prev_mean = Some(m);
                vidx += 1;
                idle = false;
            }
            Ok(_) | Err(mxl::Error::OutOfRangeTooLate) => vidx = inst.get_current_index(&vrate),
            Err(_) => {}
        }
        match ar.get_samples_non_blocking(aidx, BATCH as usize) {
            Ok(d) => {
                if let Ok((d1, d2)) = d.channel_data(0) {
                    let samples: Vec<f32> = d1.chunks_exact(4).chain(d2.chunks_exact(4)).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
                    for (i, s) in samples.iter().enumerate() {
                        let idx = aidx + i as u64;
                        if s.abs() < 1e-4 {
                            quiet_run += 1;
                            if quiet_run == 480 && state_loud != Some(false) {
                                if state_loud.is_some() {
                                    aedges.push((idx + 1 - 480, false));
                                }
                                state_loud = Some(false);
                            }
                        } else {
                            if s.abs() > 0.01 && state_loud == Some(false) {
                                aedges.push((idx, true));
                                state_loud = Some(true);
                            } else if s.abs() > 0.01 && state_loud.is_none() {
                                state_loud = Some(true);
                            }
                            quiet_run = 0;
                        }
                    }
                }
                aidx += BATCH;
                idle = false;
            }
            Err(mxl::Error::OutOfRangeTooLate) => aidx = inst.get_current_index(&arate),
            Err(_) => {}
        }
        if idle {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    let vts: Vec<u64> = vedges.iter().map(|(i, _)| inst.index_to_timestamp(*i, &vrate).unwrap()).collect();
    println!("Bildwechsel: {}, Tonwechsel: {}", vts.len(), aedges.len());
    for (i, loud) in &aedges {
        let t = inst.index_to_timestamp(*i, &arate).unwrap();
        match vts.iter().min_by_key(|v| (**v as i64 - t as i64).abs()) {
            Some(v) => println!("Ton {} @ {t}: nächster Bildwechsel {:+.2} ms (Ton minus Bildanfang)", if *loud { "an " } else { "aus" }, (t as i64 - *v as i64) as f64 / 1e6),
            None => println!("Ton {} @ {t}: kein Bildwechsel", if *loud { "an " } else { "aus" }),
        }
    }
    for v in &vts {
        println!("Bild @ {v}");
    }
}
