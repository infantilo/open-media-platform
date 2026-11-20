//! Latenz einer Strecke aus Tonimpulsen: liest zwei Audio-Flows (Quelle und Empfang, gleiche Domain und Zeitbasis), findet die
//! Impulse und gibt den Median von „Empfang − Quelle“ aus (positiv = Empfang später). Zeit aus dem Sample-Index (TAI).
//!   cargo run -p omp-contribution --example tick_latency -- <domain> <quell_flow> <empfangs_flow> <sekunden>
use std::time::{Duration, Instant};

use omp_mediaio::avmarker::TickDetector;
use omp_mediaio::mxl::MxlContext;

fn collect(ctx: &MxlContext, flow: &str, secs: u64) -> Vec<u64> {
    let rd = ctx.instance().create_flow_reader(flow).and_then(|r| r.to_samples_reader()).expect("Leser");
    let rate = 48_000u32;
    let mut idx = ctx.ns_to_index(ctx.now_ns(), rate, 1).unwrap();
    let mut det = TickDetector::new(rate);
    let mut ticks = Vec::new();
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        match rd.get_samples_non_blocking(idx, 480) {
            Ok(d) => {
                if let Ok((a, b)) = d.channel_data(0) {
                    let s: Vec<f32> = a.chunks_exact(4).chain(b.chunks_exact(4)).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
                    // MXL: Blockindex = LETZTER Index; erster Sample = idx − 479
                    for t in det.feed(idx + 1 - 480, &s) {
                        ticks.push(t);
                    }
                }
                idx += 480;
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(2));
                let now = ctx.ns_to_index(ctx.now_ns(), rate, 1).unwrap();
                if now > idx + 48_000 {
                    idx = now;
                }
            }
        }
    }
    ticks
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let ctx = MxlContext::new(&a[1]).unwrap();
    let secs: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(12);
    // beide Flows parallel lesen
    let (c2, f2) = (MxlContext::new(&a[1]).unwrap(), a[3].clone());
    let h = std::thread::spawn(move || collect(&c2, &f2, secs));
    let src = collect(&ctx, &a[2], secs);
    let rx = h.join().unwrap();
    println!("Impulse: Quelle {}, Empfang {}", src.len(), rx.len());
    let mut d: Vec<f64> = Vec::new();
    for r in &rx {
        if let Some(s) = src.iter().filter(|s| **s <= *r + 24_000).max() {
            let ms = (*r as i64 - *s as i64) as f64 * 1000.0 / 48_000.0;
            if (0.0..1500.0).contains(&ms) {
                d.push(ms);
            }
        }
    }
    d.sort_by(|x, y| x.total_cmp(y));
    println!("Latenz je Impuls [ms]: {:?}", d.iter().map(|v| (v * 10.0).round() / 10.0).collect::<Vec<_>>());
    if !d.is_empty() {
        println!("Median Latenz = {:.1} ms", d[d.len() / 2]);
    }
}
