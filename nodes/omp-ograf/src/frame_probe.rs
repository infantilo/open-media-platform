//! Messung der bildgenauen Einblendung (nur Test): liest den Fill-Flow eines laufenden Grafik-Nodes Grain für Grain, bestimmt das
//! erste Bild, das sich gegenüber dem Leerbild verändert, und rechnet dessen Zeitpunkt in UTC um. Verglichen mit der Sollzeit
//! (`atUtcMs` des `show`-Aufrufs) ergibt das die tatsächliche Verzögerung bis zum sichtbaren Bild. Treiber: `tools/ograf-frame-e2e`.
//!
//! `OMP_TEST_FLOW=<Fill-Flow-ID> OMP_TEST_SECONDS=14 cargo test --release -p omp-ograf -- --ignored --nocapture first_changed_frame`
//! (MXL-Umgebung wie beim Dev-Stack; der Grafik-Node läuft mit `OMP_OGRAF_KEEPALIVE=1`, damit der Fluss auch ohne Grafik läuft).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_mediaio::mxl::{MxlContext, MxlDataInput};

fn utc_now_ns() -> i128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as i128)
}

/// Anzahl abweichender Stichproben-Bytes (jedes 61. Byte) gegenüber dem Leerbild.
fn diff(a: &[u8], b: &[u8]) -> usize {
    a.iter().zip(b.iter()).step_by(61).filter(|(x, y)| x != y).count()
}

#[test]
#[ignore = "braucht einen laufenden Grafik-Node (OMP_OGRAF_KEEPALIVE=1) und MXL-Umgebung"]
fn first_changed_frame() {
    let flow = std::env::var("OMP_TEST_FLOW").expect("OMP_TEST_FLOW");
    let seconds: u64 = std::env::var("OMP_TEST_SECONDS").ok().and_then(|v| v.parse().ok()).unwrap_or(14);
    let ctx = Arc::new(MxlContext::new(&std::env::var("OMP_MXL_DOMAIN").unwrap_or("/dev/shm/omp-mxl".into())).unwrap());
    let def: serde_json::Value = serde_json::from_str(&ctx.flow_def(&flow).unwrap()).unwrap();
    let num = def["grain_rate"]["numerator"].as_u64().unwrap() as u32;
    let den = def["grain_rate"]["denominator"].as_u64().unwrap_or(1) as u32;
    // Versatz TAI → UTC (ns), einmal bestimmt
    let offset_ns = ctx.now_ns() as i128 - utc_now_ns();

    // (Leerbild, bisher erkannte Wechsel: Index, UTC-ms, Unterschied)
    type State = (Option<Vec<u8>>, Vec<(u64, f64, usize)>);
    let state: Arc<Mutex<State>> = Arc::new(Mutex::new((None, Vec::new())));
    let st = state.clone();
    let ctx_cb = ctx.clone();
    let _input = MxlDataInput::new_indexed(ctx.clone(), &flow, move |index, payload| {
        let mut s = st.lock().unwrap();
        let Some(base) = s.0.clone() else {
            s.0 = Some(payload.to_vec());
            return;
        };
        let d = diff(&base, payload);
        let ts_ns = ctx_cb.index_to_ns(index, num, den).unwrap_or(0) as i128 - offset_ns;
        s.1.push((index, ts_ns as f64 / 1e6, d));
    })
    .unwrap();
    std::thread::sleep(Duration::from_secs(seconds));
    let s = state.lock().unwrap();
    let frame_ms = 1000.0 * den as f64 / num as f64;
    // Der Treiber zeigt die Grafik einmal und blendet sie später aus: erster Wechsel nach dem Leerbild und erste Rückkehr
    let first = s.1.iter().find(|(_, _, d)| *d > 20);
    match first {
        Some((idx, ms, d)) => {
            println!("FIRST_CHANGE_UTC_MS={ms:.1} INDEX={idx} DIFF={d} FRAME_MS={frame_ms:.2} FRAMES_SEEN={}", s.1.len());
            let back = s.1.iter().skip_while(|(i, _, _)| i <= idx).find(|(_, _, d)| *d <= 20);
            if let Some((bi, bms, _)) = back {
                println!("BACK_TO_EMPTY_UTC_MS={bms:.1} INDEX={bi}");
            }
        }
        None => println!("NO_CHANGE FRAMES_SEEN={}", s.1.len()),
    }
    assert!(first.is_some(), "kein verändertes Bild gesehen");
}
