//! Misst den RMS je Kanal eines (Mehrkanal-)MXL-Audio-Flows über ein Zeitfenster — für Panner-Tests (Kap. 32).
//!   cargo run -p omp-mediaio --features mxl --example bus_level_probe -- <domain> <audio_flow> <sekunden>
use std::time::{Duration, Instant};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (domain, flow) = (&a[1], &a[2]);
    let secs: f64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let api = mxl::load_api("libmxl.so").expect("libmxl");
    let inst = mxl::MxlInstance::new(api, domain, "").expect("instance");
    let def: serde_json::Value = serde_json::from_str(&inst.get_flow_def(flow).unwrap()).unwrap();
    let rate = mxl_sys::Rational { numerator: def["sample_rate"]["numerator"].as_i64().unwrap(), denominator: 1 };
    let reader = inst.create_flow_reader(flow).unwrap().to_samples_reader().unwrap();
    let mut idx = inst.get_current_index(&rate);
    let (mut sum, mut n): (Vec<f64>, u64) = (Vec::new(), 0);
    let t0 = Instant::now();
    while t0.elapsed().as_secs_f64() < secs {
        match reader.get_samples_non_blocking(idx, 480) {
            Ok(d) => {
                let ch = d.num_of_channels();
                sum.resize(ch, 0.0);
                for c in 0..ch {
                    if let Ok((d1, d2)) = d.channel_data(c) {
                        for b in d1.chunks_exact(4).chain(d2.chunks_exact(4)) {
                            let v = f32::from_le_bytes(b.try_into().unwrap()) as f64;
                            sum[c] += v * v;
                        }
                    }
                }
                n += 480;
                idx += 480;
            }
            Err(mxl::Error::OutOfRangeTooLate) => idx = inst.get_current_index(&rate),
            Err(_) => std::thread::sleep(Duration::from_millis(2)),
        }
    }
    let rms: Vec<String> = sum.iter().map(|s| format!("{:.3}", (s / n.max(1) as f64).sqrt())).collect();
    println!("RMS je Kanal: [{}]", rms.join(", "));
}
