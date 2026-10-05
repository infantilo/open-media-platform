//! Kapitel 30.1: misst, ob die MXL-Flow-Synchronization-Group (Lese-Tor,
//! `OMP_MXL_SYNCGROUP=1`) die Ankunftszeiten zusammengehöriger Video-/
//! Audio-Daten am Leser angleicht. Schreibseite: Video (320x180, 25 fps,
//! Ankunft = Aufnahme + 20 ms) und Audio (48 kHz mono, 10-ms-Blöcke,
//! Ankunft = Aufnahme + `<audio_delay_ms>`) — der Schreibseiten-Versatz ist
//! absichtlich da, damit ein Gate etwas ausrichten kann. Leseseite:
//! `MxlVideoInput` + `MxlAudioInput`, je ein `appsink sync=false`; je
//! Videobild wird die Wanduhr-Differenz zum ersten Audio-Block mit
//! Ursprung >= Bild-TAI gemessen.
//!
//! Aufruf (mit/ohne Gate vergleichen, kurz halten):
//!   [OMP_MXL_SYNCGROUP=1] cargo run -p omp-mediaio --features mxl --example sync_group_probe -- <sekunden> <audio_delay_ms>
use std::collections::BTreeMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext, MxlVideoInput, MxlVideoOutput};

const W: usize = 320;
const H: usize = 180;
const RATE: u64 = 48_000;
const CHUNK: u64 = 480;

fn pseudo_uuid(salt: u128) -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let h = format!("{:032x}", n ^ salt);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn ref_ts(buf: &gst::BufferRef) -> Option<u64> {
    buf.iter_meta::<gst::meta::ReferenceTimestampMeta>().next().map(|m| m.timestamp().nseconds())
}

fn sleep_until(t: Instant) {
    let now = Instant::now();
    if t > now {
        std::thread::sleep(t - now);
    }
}

fn main() {
    gst::init().unwrap();
    let args: Vec<String> = std::env::args().collect();
    let secs: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(10);
    let audio_delay: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(90.0);
    let domain = format!("/dev/shm/omp-mxl-syncgroup-probe-{}", std::process::id());
    std::fs::create_dir_all(&domain).unwrap();
    let ctx = Arc::new(MxlContext::new(&domain).expect("MxlContext"));
    let (vid, aid) = (pseudo_uuid(0x11), pseudo_uuid(0x22));

    // ---- Schreiber ----
    let wpipe = gst::Pipeline::new();
    let vsrc = gst_app::AppSrc::builder()
        .is_live(true)
        .format(gst::Format::Time)
        .caps(&gst::Caps::builder("video/x-raw").field("format", "I420").field("width", W as i32).field("height", H as i32).field("framerate", gst::Fraction::new(0, 1)).build())
        .build();
    let asrc = gst_app::AppSrc::builder()
        .is_live(true)
        .format(gst::Format::Time)
        .caps(&gst::Caps::builder("audio/x-raw").field("format", "F32LE").field("rate", RATE as i32).field("channels", 1i32).field("layout", "interleaved").build())
        .build();
    wpipe.add_many([&vsrc, &asrc]).unwrap();
    let vout = MxlVideoOutput::new(&wpipe, vsrc.upcast_ref(), ctx.clone(), &vid, "sgp-video", W as u32, H as u32, 25, 1, Arc::new(AtomicU64::new(0))).expect("video out");
    let aout = MxlAudioOutput::new(&wpipe, asrc.upcast_ref(), ctx.clone(), &aid, "sgp-audio", RATE as u32, 1).expect("audio out");
    omp_mediaio::Output::set_active(&vout, true);
    omp_mediaio::Output::set_active(&aout, true);
    wpipe.set_state(gst::State::Playing).unwrap();

    let start = Instant::now();
    let total_ms = secs as f64 * 1000.0 + 2500.0;
    let vfeed = std::thread::spawn(move || {
        let (mut n, mut c) = (0u64, 0.0f64);
        while c < total_ms {
            sleep_until(start + Duration::from_micros(((c + 20.0) * 1000.0) as u64));
            let mut b = gst::Buffer::from_slice(vec![128u8; W * H * 3 / 2]);
            {
                let bm = b.get_mut().unwrap();
                bm.set_pts(gst::ClockTime::from_nseconds((c * 1e6) as u64));
                bm.set_duration(gst::ClockTime::from_mseconds(40));
            }
            if vsrc.push_buffer(b).is_err() {
                break;
            }
            n += 1;
            c = n as f64 * 40.0;
        }
    });
    let afeed = std::thread::spawn(move || {
        let (mut k, mut c) = (0u64, 0.0f64);
        while c < total_ms {
            sleep_until(start + Duration::from_micros(((c + audio_delay) * 1000.0) as u64));
            let mut b = gst::Buffer::from_slice(vec![0u8; (CHUNK * 4) as usize]);
            {
                let bm = b.get_mut().unwrap();
                bm.set_pts(gst::ClockTime::from_nseconds((c * 1e6) as u64));
                bm.set_duration(gst::ClockTime::from_mseconds(10));
            }
            if asrc.push_buffer(b).is_err() {
                break;
            }
            k += 1;
            c = k as f64 * 10.0;
        }
    });
    std::thread::sleep(Duration::from_millis(1500));

    // ---- Leser ----
    let rpipe = gst::Pipeline::new();
    let vin = MxlVideoInput::new(&rpipe, ctx.clone(), &vid).expect("video in");
    let ain = MxlAudioInput::new(&rpipe, ctx.clone(), &aid).expect("audio in");
    let vsink = gst_app::AppSink::builder().sync(false).max_buffers(8).drop(true).build();
    let asink = gst_app::AppSink::builder().sync(false).max_buffers(64).drop(true).build();
    rpipe.add_many([vsink.upcast_ref::<gst::Element>(), asink.upcast_ref()]).unwrap();
    vin.tail.link(&vsink).unwrap();
    ain.tail.link(&asink).unwrap();

    let vlog: Arc<Mutex<Vec<(u64, f64)>>> = Arc::new(Mutex::new(Vec::new()));
    let alog: Arc<Mutex<BTreeMap<u64, f64>>> = Arc::new(Mutex::new(BTreeMap::new()));
    let t0 = Instant::now();
    {
        let vlog = vlog.clone();
        vsink.set_callbacks(gst_app::AppSinkCallbacks::builder().new_sample(move |s| {
            if let Ok(smp) = s.pull_sample() && let Some(ts) = smp.buffer().and_then(ref_ts) {
                vlog.lock().unwrap().push((ts, t0.elapsed().as_secs_f64() * 1000.0));
            }
            Ok(gst::FlowSuccess::Ok)
        }).build());
        let alog = alog.clone();
        asink.set_callbacks(gst_app::AppSinkCallbacks::builder().new_sample(move |s| {
            if let Ok(smp) = s.pull_sample() && let Some(ts) = smp.buffer().and_then(ref_ts) {
                alog.lock().unwrap().insert(ts, t0.elapsed().as_secs_f64() * 1000.0);
            }
            Ok(gst::FlowSuccess::Ok)
        }).build());
    }
    rpipe.set_state(gst::State::Playing).unwrap();
    std::thread::sleep(Duration::from_secs(secs));
    rpipe.set_state(gst::State::Null).unwrap();
    wpipe.set_state(gst::State::Null).unwrap();
    drop((vfeed, afeed));

    let v = vlog.lock().unwrap();
    let a = alog.lock().unwrap();
    let mut skew: Vec<f64> = Vec::new();
    for (ts, vw) in v.iter() {
        if let Some((_, aw)) = a.range(*ts..*ts + 20_000_000).next() {
            skew.push(aw - vw); // >0: Audio kommt nach dem Bild an
        }
    }
    skew.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let q = |p: f64| if skew.is_empty() { f64::NAN } else { skew[((skew.len() - 1) as f64 * p).round() as usize] };
    println!(
        "syncgroup={} audio_delay={audio_delay}ms video_frames={} audio_blocks={} matched={} arrival skew audio-video ms: p05={:.1} p50={:.1} p95={:.1} spread(p95-p05)={:.1}",
        omp_mediaio::mxl::sync_group_enabled(),
        v.len(),
        a.len(),
        skew.len(),
        q(0.05),
        q(0.5),
        q(0.95),
        q(0.95) - q(0.05)
    );
    let _ = std::fs::remove_dir_all(&domain);
}
