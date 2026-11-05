//! MXL-Ausgang von `omp-segue-player` (Kapitel 89/RB3): schreibt die gemischten Blöcke **direkt** in den MXL-Audio-Flow (kein
//! GStreamer-Umweg). Der Sample-Index jedes Blocks folgt aus der eigenen Ausgabeuhr (`index = idx0 + n`), nicht aus einer
//! Ankunftszeit — damit ist ein Einsatz auf den Sample genau (gemessen: Streuung unter einem Sample).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use omp_mediaio::mxl::{MxlContext, audio_flow_def};

use crate::mix::{BLOCK, CH, SR};

/// Ausgabeverzug gegenüber der Echtzeit (ns): Block `n` trägt die MXL-Zeit `tai0 + n/SR − LAG` und wird erst gerechnet, wenn diese
/// Zeit schon vorbei ist — so liegen alle Schreibzeitpunkte in der Vergangenheit (kein Vorgriff über den Kopf des Flows).
pub const OUT_LAG_NS: u64 = 30_000_000;

pub struct MxlOut {
    ctx: Arc<MxlContext>,
    writer: Mutex<mxl::SamplesWriter>,
    flowed: AtomicBool,
}

impl MxlOut {
    pub fn new(domain: &str, flow_id: &str, label: &str) -> Result<Arc<Self>, String> {
        let ctx = Arc::new(MxlContext::new(domain)?);
        let def = audio_flow_def(flow_id, label, SR, CH as u32);
        let (writer, _cfg, _created) = ctx.instance().create_flow_writer(&def, None).map_err(|e| format!("create_flow_writer(audio): {e}"))?;
        let writer = writer.to_samples_writer().map_err(|e| format!("to_samples_writer: {e}"))?;
        Ok(Arc::new(Self { ctx, writer: Mutex::new(writer), flowed: AtomicBool::new(false) }))
    }

    pub fn flowed(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }

    /// Rundet eine TAI-Zeit auf die nächste Blockgrenze des Sample-Rasters auf (Vielfache von `BLOCK`), damit Zeitnullpunkt und
    /// Schreibraster zusammenfallen.
    pub fn align_tai(&self, tai_ns: u64) -> u64 {
        let Some(idx) = self.ctx.ns_to_index(tai_ns, SR, 1) else { return tai_ns };
        let aligned = idx.div_ceil(BLOCK as u64) * BLOCK as u64;
        self.ctx.index_to_ns(aligned, SR, 1).unwrap_or(tai_ns)
    }

    /// MXL-Sample-Index, in dem die TAI-Zeit liegt.
    pub fn index_of(&self, tai_ns: u64) -> Option<u64> {
        self.ctx.ns_to_index(tai_ns, SR, 1)
    }

    /// Schreibt einen Block (`BLOCK` Frames, interleaved Stereo), dessen **erster** Frame der Sample-Index `first_index` ist. MXL adressiert
    /// einen Sample-Block über den Index seines **letzten** Samples (wie der Kopf-Index des Flows) — daher `first_index + BLOCK − 1`.
    pub fn write(&self, block: &[f32], first_index: u64) -> Result<(), String> {
        let index = first_index + BLOCK as u64 - 1;
        let writer = self.writer.lock().expect("lock poisoned");
        let mut access = writer.open_samples(index, BLOCK).map_err(|e| format!("open_samples {index}: {e}"))?;
        for channel in 0..access.channels().min(CH) {
            let (d1, d2) = access.channel_data_mut(channel).map_err(|e| format!("channel_data_mut: {e}"))?;
            let mut i = 0usize;
            for dst in d1.chunks_exact_mut(4).chain(d2.chunks_exact_mut(4)) {
                let v = block.get(i * CH + channel).copied().unwrap_or(0.0);
                dst.copy_from_slice(&v.to_le_bytes());
                i += 1;
            }
        }
        access.commit().map_err(|e| format!("commit {index}: {e}"))?;
        self.flowed.store(true, Ordering::Relaxed);
        Ok(())
    }
}
