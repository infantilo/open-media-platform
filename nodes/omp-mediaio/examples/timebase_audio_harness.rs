//! Audio-Gegenstück zu `timebase_harness` (docs/decisions.md Nachtrag
//! 271): 48 kHz mono, jedes Sample trägt seine laufende Nummer (Rampe,
//! exakt in f32 bis 2^24). Schreibseite bekommt 10-ms-Blöcke mit
//! Handy/WebRTC-artiger Ankunft (Stau alle 300 ms, Jitter), PTS =
//! Aufnahmezeit. Leseseite `MxlAudioInput` → `appsink sync=true` misst
//! Sample-Kontinuität (Sprünge = Knacken/fehlende Samples, Wiederholungen
//! = veraltete Daten), PTS-Kontinuität (Lücken/Überlappungen → Resync
//! bzw. Nachregeln der Audio-Sinks, "Roboterstimme") und Render-Jitter.
//!
//! Aufruf:
//!   cargo run --release -p omp-mediaio --features mxl --example timebase_audio_harness -- <steady|phone> <sekunden>
use std::sync::Arc;
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext};

const RATE: u64 = 48_000;
const CHUNK: u64 = 480; // 10 ms

fn pseudo_uuid() -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let h = format!("{:032x}", n ^ 0x1a2b_3c4d_5e6f_7081_92a3_b4c5_d6e7_f809u128);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn percentile(v: &mut [f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() - 1) as f64 * p).round() as usize]
}

fn caps(layout: &str) -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("rate", RATE as i32)
        .field("channels", 1i32)
        .field("layout", layout)
        .build()
}

fn main() {
    gst::init().unwrap();
    let args: Vec<String> = std::env::args().collect();
    let scenario = args.get(1).cloned().unwrap_or_else(|| "phone".into());
    let secs: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(15);
    let domain = "/dev/shm/omp-mxl-timebase-harness";
    std::fs::create_dir_all(domain).unwrap();
    let ctx = Arc::new(MxlContext::new(domain).expect("MxlContext"));
    let flow_id = pseudo_uuid();

    let wpipe = gst::Pipeline::new();
    let appsrc = gst_app::AppSrc::builder().is_live(true).format(gst::Format::Time).caps(&caps("interleaved")).build();
    wpipe.add(&appsrc).unwrap();
    let out = MxlAudioOutput::new(&wpipe, appsrc.upcast_ref(), ctx.clone(), &flow_id, "timebase-audio-harness", RATE as u32, 1)
        .expect("MxlAudioOutput");
    omp_mediaio::Output::set_active(&out, true);
    wpipe.set_state(gst::State::Playing).unwrap();

    let start = Instant::now();
    let phone = scenario == "phone";
    let total_chunks = (secs + 3) * RATE / CHUNK;
    let feeder = std::thread::spawn(move || {
        let mut last_a = 0.0f64;
        for k in 0..total_chunks {
            let c = (k * CHUNK) as f64 * 1000.0 / RATE as f64; // Aufnahmezeit ms
            let mut a = c + 20.0 + ((k * 7919) % 7) as f64;
            if phone {
                let phase = c % 300.0;
                if phase < 120.0 {
                    a = c - phase + 140.0;
                }
            }
            let a = a.max(last_a);
            last_a = a;
            let target = start + Duration::from_micros((a * 1000.0) as u64);
            let now = Instant::now();
            if target > now {
                std::thread::sleep(target - now);
            }
            let mut data = Vec::with_capacity((CHUNK * 4) as usize);
            for i in 0..CHUNK {
                data.extend_from_slice(&((k * CHUNK + i) as f32).to_le_bytes());
            }
            let mut b = gst::Buffer::from_slice(data);
            {
                let bm = b.get_mut().unwrap();
                bm.set_pts(gst::ClockTime::from_nseconds((c * 1e6) as u64));
                bm.set_duration(gst::ClockTime::from_mseconds(10));
            }
            if appsrc.push_buffer(b).is_err() {
                break;
            }
        }
    });
    std::thread::sleep(Duration::from_millis(1500));

    let rpipe = gst::Pipeline::new();
    let input = MxlAudioInput::new(&rpipe, ctx.clone(), &flow_id).expect("MxlAudioInput");
    let sink = gst_app::AppSink::builder().sync(true).caps(&caps("interleaved")).max_buffers(4).drop(false).build();
    rpipe.add(&sink).unwrap();
    input.tail.link(&sink).unwrap();
    rpipe.set_state(gst::State::Playing).unwrap();

    let t0 = Instant::now();
    let mut prev_last: Option<f32> = None;
    let mut prev_end: Option<u64> = None;
    let (mut jumps, mut missing, mut repeats, mut pts_gaps, mut pts_overlaps, mut n_bufs) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    let mut render_dev: Vec<f64> = Vec::new();
    let mut first_map: Option<(f64, f64)> = None; // (wall_ms, pts_ms)
    let mut events: Vec<String> = Vec::new();
    while t0.elapsed() < Duration::from_secs(secs) {
        let Some(sample) = sink.try_pull_sample(gst::ClockTime::from_mseconds(500)) else { continue };
        let wall = start.elapsed().as_secs_f64() * 1000.0;
        let buf = sample.buffer().unwrap();
        let map = buf.map_readable().unwrap();
        let vals: Vec<f32> = map.as_slice().chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
        n_bufs += 1;
        for v in &vals {
            if let Some(p) = prev_last {
                if *v != p + 1.0 && events.len() < 6 {
                    events.push(format!("t={:.0}ms buf#{n_bufs} prev={p} got={v}", start.elapsed().as_secs_f64() * 1000.0));
                }
                if *v != p + 1.0 {
                    if *v > p + 1.0 {
                        jumps += 1;
                        missing += (*v - p - 1.0) as u64;
                    } else {
                        repeats += 1;
                    }
                }
            }
            prev_last = Some(*v);
        }
        if let (Some(pts), Some(dur)) = (buf.pts(), buf.duration()) {
            if let Some(end) = prev_end {
                let d = pts.nseconds() as i64 - end as i64;
                if d > 1_000_000 {
                    pts_gaps += 1;
                } else if d < -1_000_000 {
                    pts_overlaps += 1;
                }
            }
            prev_end = Some(pts.nseconds() + dur.nseconds());
            let pts_ms = pts.nseconds() as f64 / 1e6;
            let (w0, p0) = *first_map.get_or_insert((wall, pts_ms));
            render_dev.push(((wall - w0) - (pts_ms - p0)).abs());
        }
    }
    rpipe.set_state(gst::State::Null).unwrap();
    wpipe.set_state(gst::State::Null).unwrap();
    drop(feeder);
    for e in &events {
        println!("EVENT {e}");
    }
    println!(
        "audio scenario={scenario} buffers={n_bufs} sample-jumps={jumps} (missing samples {missing}) sample-repeats/backsteps={repeats} pts-gaps={pts_gaps} pts-overlaps={pts_overlaps} render-vs-pts dev ms p95={:.1} max={:.1}",
        percentile(&mut render_dev.clone(), 0.95),
        percentile(&mut render_dev, 1.0)
    );
}
