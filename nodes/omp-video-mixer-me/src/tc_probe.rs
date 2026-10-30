//! Messung des Versatzes zwischen Zeitcode und Bild (nur Test): liest einen Video-Flow und einen Zeitcode-Flow Grain für Grain und
//! vergleicht je Grain-Index den Bildzähler im Bild (16 Balken in der obersten Zeile, `tools/tc-offset/make-clip.sh`) mit dem
//! Zeitcode desselben Grains. Ergebnis: Zeitcode minus Bildzähler in Bildern — 0 = Zeitcode und Bild gehören zusammen, positiv =
//! der Zeitcode eilt dem Bild voraus. Treiber: `tools/tc-offset/measure.py`.
//!
//! `OMP_TEST_VIDEO_FLOW=<id> OMP_TEST_TC_FLOW=<id> OMP_TEST_SECONDS=20 cargo test --release -p omp-video-mixer-me -- --ignored --nocapture tc_offset`

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_mediaio::anc;
use omp_mediaio::mxl::{MxlContext, MxlDataInput};

const BARS: usize = 16;

/// Y-Wert (10 Bit) des Pixels `x` in Zeile `row` eines v210-Bildes der Breite `width` (Zeilenlänge aus der Nutzlast).
fn v210_luma(payload: &[u8], height: usize, row: usize, x: usize) -> Option<u16> {
    let stride = payload.len() / height;
    let g = x / 6;
    let base = row * stride + g * 16;
    let w = |i: usize| -> Option<u32> { Some(u32::from_le_bytes(payload.get(base + i * 4..base + i * 4 + 4)?.try_into().ok()?)) };
    let v = match x % 6 {
        0 => (w(0)? >> 10) & 0x3ff,
        1 => w(1)? & 0x3ff,
        2 => (w(1)? >> 20) & 0x3ff,
        3 => (w(2)? >> 10) & 0x3ff,
        4 => w(3)? & 0x3ff,
        _ => (w(3)? >> 20) & 0x3ff,
    };
    Some(v as u16)
}

/// Bildzähler aus den 16 Balken (Mitte jedes Balkens, Zeile 6); `None`, wenn ein Balken weder klar schwarz noch klar weiß ist.
fn counter(payload: &[u8], width: usize, height: usize) -> Option<u32> {
    let bar = width / BARS;
    let mut n = 0u32;
    for k in 0..BARS {
        let y = v210_luma(payload, height, 6, k * bar + bar / 2)?;
        if y > 800 {
            n |= 1 << k;
        } else if y > 200 {
            return None;
        }
    }
    Some(n)
}

fn tc_frames(a: &anc::AtcInfo, fps: u32) -> i64 {
    let t = &a.timecode;
    ((t.hours as i64 * 60 + t.minutes as i64) * 60 + t.seconds as i64) * fps as i64 + t.frames as i64
}

#[test]
#[ignore = "braucht laufende Nodes (Video-Flow mit Bildzähler + Zeitcode-Flow) und MXL-Umgebung"]
fn tc_offset() {
    let video = std::env::var("OMP_TEST_VIDEO_FLOW").expect("OMP_TEST_VIDEO_FLOW");
    let tcflow = std::env::var("OMP_TEST_TC_FLOW").expect("OMP_TEST_TC_FLOW");
    let seconds: u64 = std::env::var("OMP_TEST_SECONDS").ok().and_then(|v| v.parse().ok()).unwrap_or(20);
    let ctx = Arc::new(MxlContext::new(&std::env::var("OMP_MXL_DOMAIN").unwrap_or("/dev/shm/omp-mxl".into())).unwrap());
    let def: serde_json::Value = serde_json::from_str(&ctx.flow_def(&video).unwrap()).unwrap();
    let width = def["frame_width"].as_u64().unwrap() as usize;
    let height = def["frame_height"].as_u64().unwrap() as usize;
    let fps = def["grain_rate"]["numerator"].as_u64().unwrap() as u32;

    let pics: Arc<Mutex<BTreeMap<u64, Option<u32>>>> = Arc::new(Mutex::new(BTreeMap::new()));
    let tcs: Arc<Mutex<BTreeMap<u64, Option<i64>>>> = Arc::new(Mutex::new(BTreeMap::new()));
    let p = pics.clone();
    let _v = MxlDataInput::new_indexed(ctx.clone(), &video, move |i, g| {
        p.lock().unwrap().insert(i, counter(g, width, height));
    })
    .unwrap();
    let t = tcs.clone();
    let _t = MxlDataInput::new_indexed(ctx.clone(), &tcflow, move |i, g| {
        t.lock().unwrap().insert(i, anc::parse_atc_grain(g).map(|a| tc_frames(&a, fps)));
    })
    .unwrap();
    std::thread::sleep(Duration::from_secs(seconds));

    let pics = pics.lock().unwrap();
    let tcs = tcs.lock().unwrap();
    let mut diffs: Vec<i64> = Vec::new();
    let (mut no_pic, mut no_tc) = (0, 0);
    for (i, pic) in pics.iter() {
        let Some(tc) = tcs.get(i) else { continue };
        match (pic, tc) {
            (Some(n), Some(f)) => diffs.push(*f - *n as i64),
            (None, _) => no_pic += 1,
            (_, None) => no_tc += 1,
        }
    }
    // Bildzähler muss je Grain um 1 steigen (sonst ist die Messung wertlos: Bilder doppelt/ausgelassen)
    let seq: Vec<u32> = pics.values().filter_map(|n| *n).collect();
    let jumps = seq.windows(2).filter(|w| w[1] != w[0] + 1).count();
    let mut hist: BTreeMap<i64, usize> = BTreeMap::new();
    for d in &diffs {
        *hist.entry(*d).or_default() += 1;
    }
    println!("GRAINS video={} tc={} verglichen={} ohne_bild={no_pic} ohne_zeitcode={no_tc} bildzaehler_spruenge={jumps}", pics.len(), tcs.len(), diffs.len());
    println!("OFFSET_FRAMES_HISTOGRAM {hist:?}");
    if !diffs.is_empty() {
        let mut s = diffs.clone();
        s.sort();
        println!("OFFSET_FRAMES median={} min={} max={} (positiv = Zeitcode eilt dem Bild voraus; 1 Bild = {:.1} ms)", s[s.len() / 2], s[0], s[s.len() - 1], 1000.0 / fps as f64);
    }
    assert!(!diffs.is_empty(), "keine vergleichbaren Grains (Bildzähler nicht lesbar oder kein Zeitcode)");
}
