//! Misst, ob ein SCTE-104-Marker (ANC-Flow) auf dasselbe Bild zeigt, in dem der Mischer wirklich schneidet
//! (Kap. 37): liest einen Video-Flow (Programmausgang) und den ANC-Flow gleichzeitig.
//! - Video: Bildindizes, bei denen sich der Bildinhalt sprunghaft ändert (Mittelwert des Grains, Schwelle
//!   `PROBE_JUMP`, Standard 2.0).
//! - ANC: je Marker der Grain-Index der Sendung und der daraus berechnete Schnittindex (`pre_roll_time` ÷ Bildperiode).
//! Ausgabe: beide Listen, dazu für jeden Marker der Abstand zum nächstgelegenen Bildsprung in Bildern.
//!
//!   cargo run -p omp-mediaio --features mxl --example anc_cut_probe -- <domain> <video_flow> <anc_flow> <sekunden>
use std::time::{Duration, Instant};

fn rate(def: &serde_json::Value) -> mxl_sys::Rational {
    mxl_sys::Rational { numerator: def["grain_rate"]["numerator"].as_i64().unwrap(), denominator: def["grain_rate"]["denominator"].as_i64().unwrap_or(1) }
}

/// Liest 10-Bit-Wörter ab Bitposition `pos` aus `d`.
fn bits(d: &[u8], pos: usize, n: usize) -> u32 {
    let mut v = 0u32;
    for i in 0..n {
        v = (v << 1) | ((d[(pos + i) / 8] >> (7 - (pos + i) % 8)) & 1) as u32;
    }
    v
}

/// Nachrichtenbytes (ohne Payload Descriptor) des ersten ANC-Pakets eines Grains.
fn first_message(g: &[u8]) -> Option<Vec<u8>> {
    if g.len() < 10 || g[2] == 0 {
        return None;
    }
    let p = &g[6..];
    let dc = (bits(p, 32 + 20, 10) & 0xFF) as usize;
    let mut out = Vec::new();
    for i in 0..dc {
        out.push((bits(p, 32 + 30 + i * 10, 10) & 0xFF) as u8);
    }
    (!out.is_empty()).then(|| out[1..].to_vec())
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (domain, vflow, aflow) = (&a[1], &a[2], &a[3]);
    let secs: u64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(30);
    let jump: f64 = std::env::var("PROBE_JUMP").ok().and_then(|v| v.parse().ok()).unwrap_or(2.0);
    let api = mxl::load_api("libmxl.so").expect("libmxl");
    let inst = mxl::MxlInstance::new(api, domain, "").expect("instance");
    let vdef: serde_json::Value = serde_json::from_str(&inst.get_flow_def(vflow).unwrap()).unwrap();
    let adef: serde_json::Value = serde_json::from_str(&inst.get_flow_def(aflow).unwrap()).unwrap();
    let (vrate, arate) = (rate(&vdef), rate(&adef));
    let vr = inst.create_flow_reader(vflow).unwrap().to_grain_reader().unwrap();
    let ar = inst.create_flow_reader(aflow).unwrap().to_grain_reader().unwrap();
    let mut vidx = inst.get_current_index(&vrate);
    let mut aidx = inst.get_current_index(&arate);
    let period_ms = 1000.0 * arate.denominator as f64 / arate.numerator as f64;
    let mut prev: Option<f64> = None;
    let mut jumps: Vec<(u64, f64)> = Vec::new();
    let mut markers: Vec<(u64, u64, String)> = Vec::new();
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        let mut idle = true;
        match vr.get_grain_non_blocking(vidx) {
            Ok(g) if g.index == vidx => {
                let p = &g.payload[..g.payload.len().min(1 << 17)];
                let m = p.iter().map(|&b| b as f64).sum::<f64>() / p.len() as f64;
                if let Some(pm) = prev
                    && (m - pm).abs() > jump
                {
                    jumps.push((vidx, m - pm));
                }
                prev = Some(m);
                vidx += 1;
                idle = false;
            }
            Ok(_) | Err(mxl::Error::OutOfRangeTooLate) => vidx = inst.get_current_index(&vrate),
            Err(_) => {}
        }
        match ar.get_grain_non_blocking(aidx) {
            Ok(g) if g.index == aidx => {
                if let Some(msg) = first_message(&g.payload) {
                    // multiple_operation_message: Kopf 12 Byte, dann opID(2) len(2) und splice_request_data.
                    if msg.len() >= 12 + 4 + 15 && msg[12] == 0x01 && msg[13] == 0x01 {
                        let d = &msg[16..];
                        let pre = u16::from_be_bytes([d[7], d[8]]) as f64;
                        let dup = first_message_is_dup(&g.payload);
                        if !dup {
                            let cut = aidx + (pre / period_ms).round() as u64;
                            markers.push((aidx, cut, format!("type={} pre_roll={pre} ms event={}", d[0], u32::from_be_bytes([d[1], d[2], d[3], d[4]]))));
                        }
                    }
                }
                aidx += 1;
                idle = false;
            }
            Ok(_) | Err(mxl::Error::OutOfRangeTooLate) => aidx = inst.get_current_index(&arate),
            Err(_) => {}
        }
        if idle {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    println!("Bildsprünge im Video ({} gesamt):", jumps.len());
    for (i, d) in &jumps {
        println!("  Bild {i}  Δ Mittelwert {d:+.1}");
    }
    println!("SCTE-104-Marker ({}):", markers.len());
    for (sent, cut, info) in &markers {
        let near = jumps.iter().map(|(i, _)| *i as i64 - *cut as i64).min_by_key(|d| d.abs());
        match near {
            Some(d) => println!("  gesendet in Bild {sent}, Schnitt laut Marker = Bild {cut} ({info}); nächster Bildsprung {d:+} Bilder"),
            None => println!("  gesendet in Bild {sent}, Schnitt laut Marker = Bild {cut} ({info}); kein Bildsprung gelesen"),
        }
    }
}

fn first_message_is_dup(g: &[u8]) -> bool {
    let p = &g[6..];
    (bits(p, 32 + 30, 10) & 0xFF) as u8 & 1 == 1
}
