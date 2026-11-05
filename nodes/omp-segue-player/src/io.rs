//! MXL-Ausgang von `omp-segue-player` (Kapitel 89/RB3). Muster: `omp-intercom/src/mxl_io.rs` — `appsrc` → `MxlAudioOutput`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext};

use crate::mix::{BLOCK, CH, SR};

pub struct MxlOut {
    pipeline: gst::Pipeline,
    appsrc: gst_app::AppSrc,
    flowed: Arc<AtomicBool>,
    _output: MxlAudioOutput,
    base: Mutex<(Option<u64>, u64)>,
}

impl Drop for MxlOut {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn stereo_caps() -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("layout", "interleaved")
        .field("rate", SR as i32)
        .field("channels", CH as i32)
        .field("channel-mask", gst::Bitmask::new(0x3))
        .build()
}

impl MxlOut {
    pub fn new(domain: &str, flow_id: &str, label: &str) -> Result<Arc<Self>, String> {
        let ctx = Arc::new(MxlContext::new(domain)?);
        let pipeline = gst::Pipeline::new();
        let appsrc = gst_app::AppSrc::builder()
            .caps(&stereo_caps())
            .format(gst::Format::Time)
            .is_live(true)
            .do_timestamp(false)
            .max_bytes((BLOCK * CH * 4 * 16) as u64)
            .build();
        appsrc.set_property_from_str("leaky-type", "downstream");
        pipeline.add(&appsrc).map_err(|e| e.to_string())?;
        let output = MxlAudioOutput::new(&pipeline, appsrc.upcast_ref(), ctx, flow_id, label, SR, CH as u32)?;
        output.set_active(true);
        let flowed = output.flowed_handle();
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("Ausgang: {e}"))?;
        Ok(Arc::new(Self { pipeline, appsrc, flowed, _output: output, base: Mutex::new((None, 0)) }))
    }

    pub fn flowed(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }

    /// Einen Block (`BLOCK` Frames, interleaved Stereo) an den Ausgang.
    pub fn push(&self, block: &[f32]) {
        let mut bytes = Vec::with_capacity(block.len() * 4);
        for v in block {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let mut buffer = gst::Buffer::from_slice(bytes);
        {
            let now_ns = self.pipeline.current_running_time().map(|t| t.nseconds()).unwrap_or(0);
            let mut c = self.base.lock().expect("lock poisoned");
            let step = 10_000_000u64;
            let base = *c.0.get_or_insert(now_ns);
            let mut pts = base + c.1 * step;
            if pts + 3 * step < now_ns || pts > now_ns + 3 * step {
                c.0 = Some(now_ns);
                c.1 = 0;
                pts = now_ns;
            }
            c.1 += 1;
            let b = buffer.get_mut().expect("neuer Puffer");
            b.set_pts(gst::ClockTime::from_nseconds(pts));
            b.set_duration(gst::ClockTime::from_nseconds(step));
        }
        let _ = self.appsrc.push_buffer(buffer);
    }
}
