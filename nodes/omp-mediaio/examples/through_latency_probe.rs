//! Durchlaufzeit Eingang → Ausgang eines Knotens (Bild- oder Audiomischer), gemessen an Markern.
//!
//! Die Quelle liefert je Sekunde ein Marker-Ereignis (`OMP_SOURCE_PATTERN=black`,
//! `OMP_SOURCE_VIDEO_MARKER=1` → ein weißes Bild je Sekunde; `OMP_SOURCE_AUDIO_WAVE=ticks` → ein
//! Tick je Sekunde). Das Programm liest den Quell-Flow (Eingang) und den Mischer-Ausgang
//! gleichzeitig, merkt sich je Marker den Zeitpunkt, zu dem er im jeweiligen Flow **ankam**
//! (MXL-Uhr, TAI), und gibt die Differenz Ausgang − Eingang aus.
//!
//! Zwei Zahlen je Marker:
//!   * Ankunft: Ausgang − Eingang = echte Durchlaufzeit (Mischer-Verarbeitung + Schreib-/Weckzeit),
//!     Auflösung ≈ 1 ms (Bild: je Grain; Audio: 1-ms-Häppchen).
//!   * Etikett: Zeitstempel des Markers im Flow (Grain-/Sample-Index → TAI). Trägt der Knoten die
//!     Ursprungszeit durch, ist die Etikett-Differenz ≈ 0 — dann zeigt NUR die Ankunft die Laufzeit.
//!
//!   cargo run --release -p omp-mediaio --features mxl --example through_latency_probe -- \
//!       <domain> <video|audio> <eingang_flow_id> <ausgang_flow_id> [sekunden]
use std::time::{Duration, Instant};

struct Rec {
    arrive: u64,
    label: u64,
    level: f64,
}

fn rate(def: &serde_json::Value, key: &str) -> mxl_sys::Rational {
    mxl_sys::Rational {
        numerator: def[key]["numerator"].as_i64().unwrap(),
        denominator: def[key]["denominator"].as_i64().unwrap_or(1),
    }
}

/// Marker-Ereignisse: erster Wert über der Schwelle nach ≥ `quiet_ns` Ruhe. Schwelle = Mitte zwischen Min und Max.
fn events(recs: &[Rec], quiet_ns: u64) -> Vec<(u64, u64)> {
    let lo = recs.iter().map(|r| r.level).fold(f64::MAX, f64::min);
    let hi = recs.iter().map(|r| r.level).fold(f64::MIN, f64::max);
    let thr = lo + (hi - lo) * 0.5;
    let mut out = Vec::new();
    let mut last_loud: Option<u64> = None;
    for r in recs {
        if hi - lo > 0.0 && r.level > thr {
            if last_loud.is_none_or(|t| r.label.saturating_sub(t) > quiet_ns) {
                out.push((r.arrive, r.label));
            }
            last_loud = Some(r.label);
        }
    }
    out
}

fn stats(name: &str, v: &mut Vec<f64>) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() {
        println!("{name}: keine Paare");
        return;
    }
    let med = v[v.len() / 2];
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    println!("{name}: n={} Median {med:.1} ms, Mittel {mean:.1} ms, min {:.1}, max {:.1}", v.len(), v[0], v[v.len() - 1]);
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 5 {
        eprintln!("Aufruf: <domain> <video|audio> <eingang_flow> <ausgang_flow> [sekunden]");
        std::process::exit(2);
    }
    let (domain, kind, fin, fout) = (&a[1], a[2].as_str(), &a[3], &a[4]);
    let secs: u64 = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(10);
    let api = mxl::load_api("libmxl.so").expect("libmxl");
    let inst = mxl::MxlInstance::new(api, domain, "").expect("instance");
    let mut recs: [Vec<Rec>; 2] = [Vec::new(), Vec::new()];
    let t0 = Instant::now();

    if kind == "video" {
        let defs: Vec<serde_json::Value> = [fin, fout].iter().map(|f| serde_json::from_str(&inst.get_flow_def(f).unwrap()).unwrap()).collect();
        let rates = [rate(&defs[0], "grain_rate"), rate(&defs[1], "grain_rate")];
        let readers = [
            inst.create_flow_reader(fin).unwrap().to_grain_reader().unwrap(),
            inst.create_flow_reader(fout).unwrap().to_grain_reader().unwrap(),
        ];
        let mut idx = [inst.get_current_index(&rates[0]), inst.get_current_index(&rates[1])];
        while t0.elapsed() < Duration::from_secs(secs) {
            let mut idle = true;
            for k in 0..2 {
                match readers[k].get_grain_non_blocking(idx[k]) {
                    Ok(g) if g.index == idx[k] => {
                        let arrive = inst.get_time();
                        // Mittelwert über das ganze Bild in groben Schritten (Rand/Letterbox mittelt sich heraus, Marker bleibt klar)
                        let p = g.payload;
                        let step = (p.len() / 4096).max(1);
                        let (mut sum, mut n) = (0f64, 0f64);
                        let mut i = 0;
                        while i < p.len() {
                            sum += p[i] as f64;
                            n += 1.0;
                            i += step;
                        }
                        recs[k].push(Rec { arrive, label: inst.index_to_timestamp(idx[k], &rates[k]).unwrap(), level: sum / n });
                        idx[k] += 1;
                        idle = false;
                    }
                    Ok(_) | Err(mxl::Error::OutOfRangeTooLate) => idx[k] = inst.get_current_index(&rates[k]),
                    Err(_) => {}
                }
            }
            if idle {
                std::thread::sleep(Duration::from_micros(500));
            }
        }
    } else {
        let defs: Vec<serde_json::Value> = [fin, fout].iter().map(|f| serde_json::from_str(&inst.get_flow_def(f).unwrap()).unwrap()).collect();
        let rates = [rate(&defs[0], "sample_rate"), rate(&defs[1], "sample_rate")];
        let readers = [
            inst.create_flow_reader(fin).unwrap().to_samples_reader().unwrap(),
            inst.create_flow_reader(fout).unwrap().to_samples_reader().unwrap(),
        ];
        let batch = [(rates[0].numerator / 1000) as u64, (rates[1].numerator / 1000) as u64]; // ≈ 1 ms
        let mut idx = [inst.get_current_index(&rates[0]), inst.get_current_index(&rates[1])];
        while t0.elapsed() < Duration::from_secs(secs) {
            let mut idle = true;
            for k in 0..2 {
                match readers[k].get_samples_non_blocking(idx[k], batch[k] as usize) {
                    Ok(d) => {
                        let arrive = inst.get_time();
                        let mut peak = 0f32;
                        // alle Kanäle: ein Tick kann in einem beliebigen Kanal liegen
                        let mut ch = 0;
                        while let Ok((d1, d2)) = d.channel_data(ch) {
                            for c in d1.chunks_exact(4).chain(d2.chunks_exact(4)) {
                                peak = peak.max(f32::from_le_bytes(c.try_into().unwrap()).abs());
                            }
                            ch += 1;
                        }
                        recs[k].push(Rec { arrive, label: inst.index_to_timestamp(idx[k], &rates[k]).unwrap(), level: peak as f64 });
                        idx[k] += batch[k];
                        idle = false;
                    }
                    Err(mxl::Error::OutOfRangeTooLate) => idx[k] = inst.get_current_index(&rates[k]),
                    Err(_) => {}
                }
            }
            if idle {
                std::thread::sleep(Duration::from_micros(300));
            }
        }
    }

    let ein = events(&recs[0], 500_000_000);
    let aus = events(&recs[1], 500_000_000);
    println!("{kind}: Eingang {} Marker ({} Messpunkte), Ausgang {} Marker ({} Messpunkte)", ein.len(), recs[0].len(), aus.len(), recs[1].len());
    let (mut arr, mut lab) = (Vec::new(), Vec::new());
    for (ea, el) in &ein {
        // erster Ausgangs-Marker, der nicht vor dem Eingangs-Marker ankam und höchstens 900 ms später
        if let Some((oa, ol)) = aus.iter().find(|(oa, _)| *oa >= *ea && *oa - *ea < 900_000_000) {
            arr.push((*oa - *ea) as f64 / 1e6);
            lab.push(*ol as f64 / 1e6 - *el as f64 / 1e6);
        }
    }
    println!("Durchlaufzeit je Marker (Ankunft Ausgang − Eingang) [ms]: {:?}", arr.iter().map(|d| (d * 10.0).round() / 10.0).collect::<Vec<_>>());
    stats("DURCHLAUF Ankunft", &mut arr);
    stats("DURCHLAUF Etikett", &mut lab);
}
