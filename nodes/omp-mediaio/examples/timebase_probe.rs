//! Mess-Sonde für LIVE-Flows (docs/decisions.md Nachtrag 271): hängt sich
//! als zusätzlicher Leser an einen bestehenden MXL-Video-Flow (nur lesend,
//! wie ein weiterer Viewer) und misst
//!   - über `MxlVideoInput` → `appsink sync=true` (Darstellung wie
//!     omp-viewer): Render-Intervalle, Standbilder, identische
//!     Folgebilder (Frame-Hash),
//!   - roh über libmxl: Index-Lücken und identische Inhalte in
//!     aufeinanderfolgenden Grains (was der SCHREIBER tatsächlich in den
//!     Flow legt).
//!
//! Voraussetzung für "identische Folgebilder": eine sich in jedem Bild
//! ändernde Quelle (omp-source-Testbild mit Bewegung).
//!
//! Aufruf:
//!   OMP_MXL_DOMAIN=/dev/shm/omp-mxl cargo run --release -p omp-mediaio --features mxl --example timebase_probe -- <flow-id> <sekunden>
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput};

fn hash(b: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    // Stichprobe reicht und ist billig.
    for chunk in b.chunks(997) {
        chunk[0].hash(&mut h);
    }
    b.len().hash(&mut h);
    h.finish()
}

fn percentile(v: &mut [f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() - 1) as f64 * p).round() as usize]
}

fn main() {
    gst::init().unwrap();
    let args: Vec<String> = std::env::args().collect();
    let flow_id = args.get(1).expect("flow-id").clone();
    let secs: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(20);
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/omp-mxl".into());
    let ctx = Arc::new(MxlContext::new(&domain).expect("MxlContext"));
    let flow_def: serde_json::Value = serde_json::from_str(&ctx.flow_def(&flow_id).expect("flow_def")).unwrap();
    let num = flow_def["grain_rate"]["numerator"].as_i64().unwrap();
    let den = flow_def["grain_rate"]["denominator"].as_i64().unwrap_or(1);

    let raw = {
        let fid = flow_id.clone();
        let dom = domain.clone();
        std::thread::spawn(move || {
            let api = mxl::load_api("libmxl.so").unwrap();
            let inst = mxl::MxlInstance::new(api, &dom, "").unwrap();
            let reader = inst.create_flow_reader(&fid).unwrap().to_grain_reader().unwrap();
            let rate = mxl_sys::Rational { numerator: num, denominator: den };
            let mut index = inst.get_current_index(&rate);
            let (mut grains, mut gaps, mut same, mut last): (u64, u64, u64, Option<(u64, u64)>) = (0, 0, 0, None);
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_secs(secs) {
                match reader.get_grain_non_blocking(index) {
                    Ok(g) if g.index == index => {
                        let h = hash(g.payload);
                        if let Some((li, lh)) = last {
                            if index != li + 1 {
                                gaps += 1;
                            }
                            if h == lh {
                                same += 1;
                            }
                        }
                        last = Some((index, h));
                        grains += 1;
                        index += 1;
                    }
                    Ok(_) => index += 1,
                    Err(mxl::Error::OutOfRangeTooLate) => index = inst.get_current_index(&rate),
                    Err(_) => std::thread::sleep(Duration::from_millis(2)),
                }
            }
            (grains, gaps, same)
        })
    };

    let pipe = gst::Pipeline::new();
    let input = MxlVideoInput::new(&pipe, ctx.clone(), &flow_id).expect("MxlVideoInput");
    let sink = gst_app::AppSink::builder().sync(true).max_buffers(2).drop(false).build();
    pipe.add(&sink).unwrap();
    input.tail.link(&sink).unwrap();
    pipe.set_state(gst::State::Playing).unwrap();

    let t0 = Instant::now();
    let mut rows: Vec<(f64, u64)> = Vec::new();
    while t0.elapsed() < Duration::from_secs(secs) {
        let Some(s) = sink.try_pull_sample(gst::ClockTime::from_mseconds(500)) else { continue };
        let wall = t0.elapsed().as_secs_f64() * 1000.0;
        let map = s.buffer().unwrap().map_readable().unwrap();
        rows.push((wall, hash(map.as_slice())));
    }
    pipe.set_state(gst::State::Null).unwrap();
    let (grains, gaps, same) = raw.join().unwrap();

    // Anlaufphase (erste 2 s) nicht werten.
    let rows: Vec<_> = rows.into_iter().filter(|r| r.0 > 2000.0).collect();
    let mut iv: Vec<f64> = rows.windows(2).map(|w| w[1].0 - w[0].0).collect();
    let period = 1000.0 * den as f64 / num as f64;
    let stalls = iv.iter().filter(|d| **d > 3.0 * period).count();
    let repeats = rows.windows(2).filter(|w| w[1].1 == w[0].1).count();
    println!(
        "PROBE flow={flow_id} rendered={} render-interval ms p50={:.1} p95={:.1} p99={:.1} max={:.1} stalls(>3 periods)={stalls} identical-consecutive-rendered={repeats}",
        rows.len(),
        percentile(&mut iv.clone(), 0.5),
        percentile(&mut iv.clone(), 0.95),
        percentile(&mut iv.clone(), 0.99),
        percentile(&mut iv, 1.0)
    );
    println!("RAW grains={grains} index-gaps={gaps} identical-consecutive-grains={same}");
}
