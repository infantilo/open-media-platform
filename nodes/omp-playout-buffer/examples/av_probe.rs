//! Messwerkzeug (Kap. 39.3): liest die beiden Ausgangs-Flows des Puffers und meldet
//! Marker-Ereignisse mit ihrer MXL-Zeit (aus dem Schreibindex der Ausgabe):
//!   `V <ms>` = Marker-Bild (weißes Bild der Marker-Quelle: `OMP_SOURCE_VIDEO_MARKER=1`,
//!   `OMP_SOURCE_PATTERN=black`, `OMP_SOURCE_AUDIO_WAVE=ticks`), aufsteigende Flanke;
//!   `A <ms>` = Ton-Tick, erster Ausschlag nach Stille;
//!   `H <ms> <n>` = n aufeinanderfolgende identische Bilder (Standbild/Hold), nur bei n ≥ 5.
//! Aufruf: `av_probe <video_flow> <audio_flow> <sekunden> [kanäle]`. Zeiten in ms ab Start (TAI-Differenz).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlAudioInput, MxlContext, MxlVideoInput, tai_reference_caps};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (vf, af) = (args[1].clone(), args[2].clone());
    let secs: u64 = args[3].parse().unwrap();
    gst::init().unwrap();
    let ctx = Arc::new(MxlContext::new(&std::env::var("OMP_MXL_DOMAIN").unwrap_or("/dev/shm/omp-mxl".into())).unwrap());
    let t0 = ctx.now_ns();
    let reference = tai_reference_caps();
    let events: Arc<Mutex<Vec<(u64, String)>>> = Arc::new(Mutex::new(Vec::new()));

    let vp = gst::Pipeline::new();
    let vin = MxlVideoInput::new_unsynced(&vp, ctx.clone(), &vf).unwrap();
    let vsink = gst_app::AppSink::builder().sync(false).max_buffers(50).drop(false).build();
    vp.add(vsink.upcast_ref::<gst::Element>()).unwrap();
    vin.tail.link(vsink.upcast_ref::<gst::Element>()).unwrap();
    let (ev, r1) = (events.clone(), reference.clone());
    let state = Arc::new(Mutex::new((false, 0u64, 0u32, 0u64))); // (white, hash, run, run_start)
    vsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |s| {
                let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let b = sample.buffer().unwrap();
                let ts = b.meta::<gst::ReferenceTimestampMeta>().filter(|m| m.reference() == r1.as_ref()).map(|m| m.timestamp().nseconds()).unwrap_or(0);
                let map = b.map_readable().unwrap();
                let d = map.as_slice();
                // Beliebiges Wort aus der Bildmitte; weiß = Y deutlich über Schwarz (64)
                let mid = (d.len() / 2) & !3;
                let w = u32::from_le_bytes(d[mid..mid + 4].try_into().unwrap());
                let y = (w >> 10) & 0x3ff;
                let white = y > 500;
                let mut h: u64 = 1469598103934665603;
                for c in d.iter().step_by(509) {
                    h = (h ^ *c as u64).wrapping_mul(1099511628211);
                }
                let mut st = state.lock().unwrap();
                if white && !st.0 {
                    ev.lock().unwrap().push((ts, "V".into()));
                }
                st.0 = white;
                if h == st.1 {
                    st.2 += 1;
                    if st.2 == 5 {
                        let start = st.3;
                        ev.lock().unwrap().push((start, "H-start".into()));
                    }
                } else {
                    if st.2 >= 5 {
                        ev.lock().unwrap().push((ts, format!("H-end {}", st.2 + 1)));
                    }
                    st.1 = h;
                    st.2 = 0;
                    st.3 = ts;
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    vin.activate().unwrap();
    vp.set_state(gst::State::Playing).unwrap();

    let ap = gst::Pipeline::new();
    let ain = MxlAudioInput::new_unsynced(&ap, ctx.clone(), &af).unwrap();
    let asink = gst_app::AppSink::builder().sync(false).max_buffers(500).drop(false).build();
    ap.add(asink.upcast_ref::<gst::Element>()).unwrap();
    ain.tail.link(asink.upcast_ref::<gst::Element>()).unwrap();
    let ch: usize = args.get(4).and_then(|c| c.parse().ok()).unwrap_or(2);
    let (ev, r2) = (events.clone(), reference.clone());
    let quiet = Arc::new(Mutex::new(u64::MAX / 2));
    asink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |s| {
                let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let b = sample.buffer().unwrap();
                let ts = b.meta::<gst::ReferenceTimestampMeta>().filter(|m| m.reference() == r2.as_ref()).map(|m| m.timestamp().nseconds()).unwrap_or(0);
                let map = b.map_readable().unwrap();
                let mut q = quiet.lock().unwrap();
                for (i, c) in map.as_slice().chunks_exact(4 * ch).enumerate() {
                    let x = f32::from_le_bytes(c[..4].try_into().unwrap());
                    if x.abs() > 0.05 {
                        if *q > 24_000 {
                            ev.lock().unwrap().push((ts + i as u64 * 1_000_000_000 / 48_000, "A".into()));
                        }
                        *q = 0;
                    } else {
                        *q += 1;
                    }
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    ain.activate().unwrap();
    ap.set_state(gst::State::Playing).unwrap();

    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(secs) {
        std::thread::sleep(Duration::from_millis(200));
    }
    let mut ev = events.lock().unwrap().clone();
    ev.sort_by_key(|e| e.0);
    for (ts, kind) in ev {
        if ts >= t0 {
            println!("{kind} {:.1}", (ts - t0) as f64 / 1e6);
        }
    }
    vp.set_state(gst::State::Null).unwrap();
    ap.set_state(gst::State::Null).unwrap();
    drop((vin, ain));
}
