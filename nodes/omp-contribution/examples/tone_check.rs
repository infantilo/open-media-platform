//! Prüft einen Ton-Fluss: Kanalzahl, Pegel (RMS in dBFS je Kanal) und Frequenz (Nulldurchgänge).
//!   cargo run -p omp-contribution --example tone_check -- <domain> <flow> <sekunden>
use std::time::{Duration, Instant};

use omp_mediaio::mxl::MxlContext;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let ctx = MxlContext::new(&a[1]).unwrap();
    let secs: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(4);
    let def: serde_json::Value = serde_json::from_str(&ctx.flow_def(&a[2]).unwrap()).unwrap();
    let ch = def["channel_count"].as_u64().unwrap() as usize;
    let rd = ctx.instance().create_flow_reader(&a[2]).and_then(|r| r.to_samples_reader()).unwrap();
    let mut idx = ctx.ns_to_index(ctx.now_ns(), 48_000, 1).unwrap();
    let mut sum2 = vec![0f64; ch];
    let mut zc = vec![0u64; ch];
    let mut prev = vec![0f32; ch];
    let mut n = 0u64;
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        match rd.get_samples_non_blocking(idx, 480) {
            Ok(d) => {
                for c in 0..ch {
                    if let Ok((x, y)) = d.channel_data(c) {
                        for b in x.chunks_exact(4).chain(y.chunks_exact(4)) {
                            let v = f32::from_le_bytes(b.try_into().unwrap());
                            sum2[c] += (v as f64) * (v as f64);
                            if prev[c] <= 0.0 && v > 0.0 {
                                zc[c] += 1;
                            }
                            prev[c] = v;
                        }
                    }
                }
                n += 480;
                idx += 480;
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(2));
                let now = ctx.ns_to_index(ctx.now_ns(), 48_000, 1).unwrap();
                if now > idx + 48_000 {
                    idx = now;
                }
            }
        }
    }
    println!("Kanäle: {ch}, Samples: {n}");
    for c in 0..ch {
        let rms = (sum2[c] / n.max(1) as f64).sqrt();
        let db = 20.0 * rms.max(1e-9).log10();
        let hz = zc[c] as f64 * 48_000.0 / n.max(1) as f64;
        println!("Kanal {}: Pegel {:.2} dBFS, Frequenz ≈ {:.0} Hz", c + 1, db, hz);
    }
}
