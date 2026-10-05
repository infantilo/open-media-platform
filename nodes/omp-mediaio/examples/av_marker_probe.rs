//! Echte A/V-Versatzmessung an den MXL-Etiketten einer Quelle (Marker statt
//! Latenzdifferenz): Quelle mit `OMP_SOURCE_PATTERN=black`, `OMP_SOURCE_VIDEO_MARKER=1` (ein
//! weißes Bild je Sekunde) und `OMP_SOURCE_AUDIO_WAVE=ticks` (Tick je Sekunde). Das Programm
//! liest Video- und Audio-Flow direkt, bestimmt den TAI-Zeitstempel (Grain-/
//! Sample-Index → `mxlIndexToTimestamp`) des Bildwechsels und des Tick-
//! Beginns und gibt Ta − Tv aus. 0 = Etiketten stimmen; > 0 = Ton-Etikett
//! liegt nach dem Bild-Etikett (Ton hinkt nach), < 0 = Ton eilt voraus.
//!
//!   cargo run -p omp-mediaio --features mxl --example av_marker_probe -- <domain> <video_flow> <audio_flow> [sekunden]
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
    let secs: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(14);
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

    let (mut vlast_class, mut alast_loud_ago): (Option<bool>, u64) = (None, u64::MAX);
    let mut vflips: Vec<u64> = Vec::new(); // TAI ns
    let mut aticks: Vec<u64> = Vec::new();
    let mut vmin = f64::MAX;
    let mut vmax = f64::MIN;
    let mut vmeans: Vec<(u64, f64)> = Vec::new();
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        let mut idle = true;
        match vr.get_grain_non_blocking(vidx) {
            Ok(g) if g.index == vidx => {
                let p = &g.payload[..g.payload.len().min(1 << 16)];
                let mean = p.iter().map(|&b| b as f64).sum::<f64>() / p.len() as f64;
                vmeans.push((inst.index_to_timestamp(vidx, &vrate).unwrap(), mean));
                vmin = vmin.min(mean);
                vmax = vmax.max(mean);
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
                        if s.abs() > 0.05 {
                            if alast_loud_ago > arate.numerator as u64 / 2 {
                                // erster lauter Sample nach >0,5 s Ruhe = Tick-Beginn
                                aticks.push(inst.index_to_timestamp(aidx + i as u64, &arate).unwrap());
                            }
                            alast_loud_ago = 0;
                        } else {
                            alast_loud_ago = alast_loud_ago.saturating_add(1);
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
    // Klassen (hell/dunkel) aus den gemessenen Mittelwerten, dann Wechsel suchen.
    let thr = (vmin + vmax) / 2.0;
    for (ts, m) in &vmeans {
        let class = *m > thr;
        if let Some(prev) = vlast_class {
            if !prev && class {
                vflips.push(*ts); // nur Übergang dunkel → hell (Marker-Bild)
            }
        }
        vlast_class = Some(class);
    }
    println!("video grains={} (mean {vmin:.0}..{vmax:.0}), Bildwechsel={}, Audio-Ticks={}", vmeans.len(), vflips.len(), aticks.len());
    // Absolute Lage der Etiketten innerhalb der Sekunde (ms, Median): zeigt, WELCHER der beiden
    // Flows gegenüber einem Referenzlauf verschoben ist (die Differenz beider ist Ta−Tv).
    let phase = |v: &Vec<u64>| -> f64 {
        let mut p: Vec<f64> = v.iter().map(|t| (*t % 1_000_000_000) as f64 / 1e6).collect();
        p.sort_by(|a, b| a.partial_cmp(b).unwrap());
        p.get(p.len() / 2).copied().unwrap_or(f64::NAN)
    };
    println!("Phase in der Sekunde: Audio-Tick {:.1} ms, Video-Marker {:.1} ms", phase(&aticks), phase(&vflips));
    let mut deltas: Vec<f64> = Vec::new();
    if let Some(t) = aticks.first() {
        println!("Phase des Tick-Etiketts auf dem 40-ms-Raster: {:.2} ms", (*t % 40_000_000) as f64 / 1e6);
    }
    for t in &aticks {
        if let Some(nearest) = vflips.iter().min_by_key(|v| (**v as i64 - *t as i64).abs()) {
            let d = (*t as i64 - *nearest as i64) as f64 / 1e6;
            if d.abs() < 500.0 {
                deltas.push(d);
            }
        }
    }
    deltas.sort_by(|x, y| x.partial_cmp(y).unwrap());
    println!("Ta-Tv [ms] je Tick: {:?}", deltas.iter().map(|d| (d * 10.0).round() / 10.0).collect::<Vec<_>>());
    if !deltas.is_empty() {
        println!("Median Ta-Tv = {:.1} ms  (Ton-Etikett minus Bild-Etikett; Video-Grain = {:.1} ms lang)", deltas[deltas.len() / 2], 1000.0 * vrate.denominator as f64 / vrate.numerator as f64);
    }
}
