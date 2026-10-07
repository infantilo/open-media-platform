//! Messung des Take-Zeitpunkts an MXL-Flows (Kap. 31.4/31.5): liest Video- und Audio-Flow direkt und
//! meldet die TAI-Zeit des ersten/letzten hellen Bildes bzw. des ersten/letzten Tonsamples (Test-MXF
//! mit weißem erstem/letztem Bild und Gleichspannung als Ton). Mit `take_at` (TAI ns) zusätzlich die
//! Differenz in Frames bzw. Samples.
//!
//!   cargo run -p omp-mediaio --features mxl --example take_probe -- <domain> <video_flow> <audio_flow> <sekunden> [take_at_ns]
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
    let secs: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(10);
    let take_at: Option<u64> = a.get(5).and_then(|s| s.parse().ok());
    let api = mxl::load_api("libmxl.so").expect("libmxl");
    let inst = mxl::MxlInstance::new(api, domain, "").expect("instance");
    let vdef: serde_json::Value = serde_json::from_str(&inst.get_flow_def(vflow).unwrap()).unwrap();
    let adef: serde_json::Value = serde_json::from_str(&inst.get_flow_def(aflow).unwrap()).unwrap();
    let vrate = rate(&vdef, "grain_rate");
    let arate = rate(&adef, "sample_rate");
    let vr = inst.create_flow_reader(vflow).unwrap().to_grain_reader().unwrap();
    let ar = inst.create_flow_reader(aflow).unwrap().to_samples_reader().unwrap();
    let a_start = inst.get_current_index(&arate);
    let mut a_resets = 0u32;
    // Mit take_at direkt dort aufsetzen (zwei Takte davor): der Schreiber springt beim Start auf den
    // Take-Zeitpunkt, ein weit davor wartender Leser fiele sonst aus dem Ring („zu spät“) und
    // übersprünge den Anfang.
    let mut vidx = take_at.map_or_else(|| inst.get_current_index(&vrate), |at| inst.timestamp_to_index(at, &vrate).unwrap() - 2);
    let mut aidx = take_at.map_or_else(|| inst.get_current_index(&arate), |at| inst.timestamp_to_index(at, &arate).unwrap() - 960);
    const BATCH: u64 = 480;
    let mut vmeans: Vec<(u64, f64)> = Vec::new();
    let mut a_marks: [(Option<u64>, Option<u64>); 5] = [(None, None); 5];
    let mut a_all: std::collections::BTreeMap<u64, f32> = Default::default();
    let (mut a_first, mut a_last): (Option<u64>, Option<u64>) = (None, None);
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        let mut idle = true;
        match vr.get_grain_non_blocking(vidx) {
            Ok(g) if g.index == vidx => {
                let p = &g.payload[..g.payload.len().min(1 << 16)];
                vmeans.push((vidx, p.iter().map(|&b| b as f64).sum::<f64>() / p.len() as f64));
                vidx += 1;
                idle = false;
            }
            Ok(_) | Err(mxl::Error::OutOfRangeTooLate) => {
                // Mit take_at nie hinter den Take zurück-/vorspringen (sonst fehlt das erste Bild).
                vidx = take_at.map_or_else(|| inst.get_current_index(&vrate), |at| inst.timestamp_to_index(at, &vrate).unwrap())
            }
            Err(_) => {}
        }
        match ar.get_samples_non_blocking(aidx, BATCH as usize) {
            Ok(d) => {
                if let Ok((d1, d2)) = d.channel_data(0) {
                    let samples: Vec<f32> = d1.chunks_exact(4).chain(d2.chunks_exact(4)).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
                    if take_at.is_some() {
                        for (i, s) in samples.iter().enumerate() {
                            a_all.insert(aidx + i as u64, *s);
                        }
                    }
                    for (i, s) in samples.iter().enumerate() {
                        for (k, th) in [0.001f32, 0.1, 0.25, 0.45, 0.49].iter().enumerate() {
                            if s.abs() > *th {
                                a_marks[k].0.get_or_insert(aidx + i as u64);
                                a_marks[k].1 = Some(aidx + i as u64);
                            }
                        }
                        if s.abs() > 0.1 {
                            let idx = aidx + i as u64;
                            a_first.get_or_insert(idx);
                            a_last = Some(idx);
                        }
                    }
                }
                aidx += BATCH;
                idle = false;
            }
            Err(mxl::Error::OutOfRangeTooLate) => {
                a_resets += 1;
                aidx = inst.get_current_index(&arate)
            }
            Err(_) => {}
        }
        if idle {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    // Marker-Bilder = Ausreißer gegenüber dem Median (v210-Bytemittel: Weiß liegt knapp neben Grau).
    let mut sorted: Vec<f64> = vmeans.iter().map(|(_, m)| *m).collect();
    sorted.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let median = sorted.get(sorted.len() / 2).copied().unwrap_or(0.0);
    let (vmin, vmax) = (sorted.first().copied().unwrap_or(0.0), sorted.last().copied().unwrap_or(0.0));
    let bright: Vec<u64> = vmeans.iter().filter(|(_, m)| (*m - median).abs() > 1.0).map(|(i, _)| *i).collect();
    let ts = |idx: u64, r: &mxl_sys::Rational| inst.index_to_timestamp(idx, r).unwrap();
    let vframe_ns = 1_000_000_000f64 * vrate.denominator as f64 / vrate.numerator as f64;
    if std::env::var("PROBE_DUMP").is_ok() {
        println!("means: {:?}", vmeans.iter().map(|(_, m)| m.round() as i64).collect::<Vec<_>>());
    }
    if let (Some(at), Some((first, _))) = (take_at, vmeans.first()) {
        println!("erstes gelesenes Grain: {:+} Frames zu take_at (Index), Mittel {:.0}", *first as i64 - inst.timestamp_to_index(at, &vrate).unwrap() as i64, vmeans[0].1);
    }
    if let (Some(at), Some((_, m0))) = (take_at, vmeans.first()) {
        // Wechsel-Messung (Mischer): erstes Bild, dessen Mittelwert vom ersten gelesenen abweicht.
        let at_v = inst.timestamp_to_index(at, &vrate).unwrap() as i64;
        match vmeans.iter().find(|(_, m)| (m - m0).abs() > 0.5) {
            Some((i, m1)) => {
                let flicker = vmeans.iter().filter(|(j, m)| j > i && (m - m1).abs() > 0.5).count();
                println!("WECHSEL Bild: erstes verändertes Grain {:+} Frames zu take_at, Rückfälle danach: {flicker}", *i as i64 - at_v)
            }
            None => println!("WECHSEL Bild: keiner"),
        }
        // Ton: erster Sample nach lautem Signal, ab dem 480 Samples lang Stille herrscht.
        let at_a = inst.timestamp_to_index(at, &arate).unwrap() as i64;
        let keys: Vec<u64> = a_all.keys().copied().collect();
        let mut loud = false;
        let mut cut = None;
        for (n, k) in keys.iter().enumerate() {
            let v = a_all[k].abs();
            if v > 0.01 {
                loud = true;
            } else if loud && n + 480 < keys.len() && keys[n..n + 480].iter().all(|kk| a_all[kk].abs() < 1e-4) {
                cut = Some(*k);
                break;
            }
        }
        match cut {
            Some(k) => println!("WECHSEL Ton: erster stiller Sample {:+} Samples zu take_at ({:+.2} ms)", k as i64 - at_a, (k as i64 - at_a) as f64 / 48.0),
            None => println!("WECHSEL Ton: keiner"),
        }
    }
    println!("video grains={} (mean {vmin:.0}..{vmax:.0}), Marker-Bilder={}", vmeans.len(), bright.len());
    let report = |name: &str, tai: Option<u64>, unit_ns: f64, unit: &str| match (tai, take_at) {
        (Some(t), Some(at)) => println!("{name}: TAI {t}  Δ zu take_at = {:+.3} {unit} ({:+.2} ms)", (t as f64 - at as f64) / unit_ns, (t as f64 - at as f64) / 1e6),
        (Some(t), None) => println!("{name}: TAI {t}"),
        (None, _) => println!("{name}: —"),
    };
    report("erstes Marker-Bild  ", bright.first().map(|i| ts(*i, &vrate)), vframe_ns, "Frames");
    report("letztes Marker-Bild", bright.last().map(|i| ts(*i, &vrate)), vframe_ns, "Frames");
    let sample_ns = 1e9 / arate.numerator as f64;
    report("erster Tonsample   ", a_first.map(|i| ts(i, &arate)), sample_ns, "Samples");
    report("letzter Tonsample  ", a_last.map(|i| ts(i, &arate)), sample_ns, "Samples");
    if let (Some(f), Some(l)) = (bright.first(), bright.last()) {
        println!("Bildabstand erstes→letztes Marker-Bild: {} Frames", l - f);
    }
    if let Some(at) = take_at {
        println!("Probe-Start {:+} Samples vor take_at, Audio-Resets (zu spät gelesen): {a_resets}", inst.timestamp_to_index(at, &arate).unwrap() as i64 - a_start as i64);
    }
    if let Some(at) = take_at {
        let at_idx = inst.timestamp_to_index(at, &arate).unwrap();
        let around: Vec<String> = (-3i64..8).map(|k| format!("{:+}:{:.2}", k * 40, a_all.get(&((at_idx as i64 + k * 40) as u64)).copied().unwrap_or(f32::NAN))).collect();
        println!("Ton um take_at (Offset:Wert): {}", around.join(" "));
        let end = at_idx + 192000;
        let tail: Vec<String> = (-8i64..3).map(|k| format!("{:+}:{:.2}", k * 40, a_all.get(&((end as i64 + k * 40) as u64)).copied().unwrap_or(f32::NAN))).collect();
        println!("Ton um Ende (Offset:Wert): {}", tail.join(" "));
    }
    for (k, th) in [0.001f32, 0.1, 0.25, 0.45, 0.49].iter().enumerate() {
        if let (Some(f), Some(l), Some(at)) = (a_marks[k].0, a_marks[k].1, take_at) {
            let at_idx = inst.timestamp_to_index(at, &arate).unwrap() as i64;
            println!("Ton > {th}: erster {:+} Samples, letzter {:+} Samples (zu take_at)", f as i64 - at_idx, l as i64 - at_idx - 192000);
        }
    }
    if let (Some(f), Some(l)) = (a_first, a_last) {
        println!("Tonlänge: {} Samples", l - f + 1);
    }
}
