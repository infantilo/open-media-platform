//! Sync-Generator mit kleinen Blöcken: schreibt einen Stereo-MXL-Audio-Flow in die Live-Domain — Stille mit je Sekunde einem
//! 5-ms-Tick (1 kHz, 0,8) — in Blöcken von `block` Rahmen (Standard 48 = 1 ms) mit absoluten Fälligkeitszeiten. Gegenstück zu
//! `omp-source` (die schreibt 10-ms-Blöcke und taugt deshalb nicht, um Wege unter 10 ms zu messen). Index = Stand der MXL-Uhr.
//!
//!   OMP_MXL_DOMAIN=/dev/shm/omp-mxl cargo run --release -p omp-mediaio --features mxl --example tick_flow_gen -- <flow-uuid> [block=48] [sekunden=30]
use std::time::{Duration, Instant};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let flow_id = a.get(1).expect("Aufruf: <flow-uuid> [block] [sekunden]");
    let block: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(48);
    let secs: u64 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(30);
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/omp-mxl".into());
    let api = mxl::load_api("libmxl.so").expect("libmxl");
    let inst = mxl::MxlInstance::new(api, &domain, "").expect("instance");
    let rate = mxl_sys::Rational { numerator: 48_000, denominator: 1 };
    let def = omp_mediaio::mxl::audio_flow_def(flow_id, "Tick-Generator", 48_000, 2);
    let (fw, _c, _) = inst.create_flow_writer(&def, None).expect("writer");
    let sw = fw.to_samples_writer().expect("samples writer");
    let period = Duration::from_nanos(block as u64 * 1_000_000_000 / 48_000);
    let mut next = Instant::now() + period;
    let (mut n, mut last_end): (u64, Option<u64>) = (0, None);
    let end_time = Instant::now() + Duration::from_secs(secs);
    println!("Tick-Generator: Flow {flow_id}, Block {block} Rahmen ({:.2} ms), {secs} s", block as f64 / 48.0);
    while Instant::now() < end_time {
        let now = Instant::now();
        if next > now + Duration::from_micros(200) {
            std::thread::sleep(next - now - Duration::from_micros(200));
        }
        while Instant::now() < next {
            std::hint::spin_loop();
        }
        let cur = inst.get_current_index(&rate);
        let end = match last_end {
            Some(l) if (cur as i64 - (l + block as u64) as i64).abs() <= 4 * block as i64 => l + block as u64,
            _ => cur,
        };
        if let Ok(mut acc) = sw.open_samples(end, block) {
            let first_sample = end + 1 - block as u64; // Sample-Nummer des ersten Rahmens
            for c in 0..acc.channels().min(2) {
                if let Ok((d1, d2)) = acc.channel_data_mut(c) {
                    let mut i = 0u64;
                    for dst in d1.chunks_exact_mut(4).chain(d2.chunks_exact_mut(4)) {
                        let s = first_sample + i;
                        let in_sec = s % 48_000;
                        let v = if in_sec < 240 { 0.8 * (2.0 * std::f32::consts::PI * 1000.0 * in_sec as f32 / 48_000.0).sin() } else { 0.0 };
                        dst.copy_from_slice(&v.to_le_bytes());
                        i += 1;
                    }
                }
            }
            if acc.commit().is_ok() {
                last_end = Some(end);
            }
        }
        n += 1;
        next += period;
    }
    println!("fertig, {n} Blöcke");
}
