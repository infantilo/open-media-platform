//! Etiketten aus RTP-Zeitstempeln (UMSETZUNG 106.8): Ein Probe hinter dem `rtpjitterbuffer` ersetzt den Pufferzeitstempel
//! (sonst aus der **Ankunft**) durch die Zeit, die der Sender im RTP-Zeitstempel trägt (ST 2110-10/ST 2059-1: PTP-Zeit der
//! Abtastung). Bild und Ton verschiedener Wege behalten so ihre Lage zueinander, auch wenn sie unterschiedlich lange
//! unterwegs waren. Nur sinnvoll, wenn Sender und Empfänger **dieselbe Uhr** benutzen (synchrone PTP-Uhr).
//!
//! Ist die Uhr nicht synchron oder passt der Zeitstempel nicht zur Uhr (`rtptime::ClockMismatch`), bleibt der Puffer
//! unverändert (Rückfall auf Ankunft); das wird gezählt (`fallbacks`) und einmal gemeldet.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gst::prelude::*;
use gstreamer as gst;

use crate::rtptime::rtp_to_clock_ns;

/// Zustand und Zähler eines Etiketten-Probes.
pub struct RtpLabels {
    /// `true` = aus RTP-Zeitstempel (Standard), `false` = Ankunft (Probe lässt alles durch).
    pub use_rtp: AtomicBool,
    /// Sprünge der abgeleiteten Zeit gegenüber dem Vorgänger (> 1 s oder rückwärts um mehr als 100 ms).
    pub jumps: AtomicU64,
    /// Pakete, die auf Ankunft zurückfielen (Uhr nicht synchron oder Zeitstempel passt nicht).
    pub fallbacks: AtomicU64,
    /// Das zuletzt bearbeitete Paket trug eine RTP-Etikette.
    pub rtp_active: AtomicBool,
    last_msg: Mutex<String>,
}

impl RtpLabels {
    pub fn new(use_rtp: bool) -> Arc<RtpLabels> {
        Arc::new(RtpLabels { use_rtp: AtomicBool::new(use_rtp), jumps: AtomicU64::new(0), fallbacks: AtomicU64::new(0), rtp_active: AtomicBool::new(false), last_msg: Mutex::new(String::new()) })
    }
    pub fn last_message(&self) -> String {
        self.last_msg.lock().expect("lock poisoned").clone()
    }
}

/// Liefert die aktuelle Zeit der gemeinsamen Uhr in ns, oder `None`, wenn sie nicht benutzbar ist (nicht synchron).
pub type ClockFn = Arc<dyn Fn() -> Option<u64> + Send + Sync>;

/// Hängt den Probe an die Quelle des `rtpjitterbuffer` (`jitterbuffer`), vor dem Depayloader.
/// `max_skew_ns`: größte erlaubte Abweichung des Zeitstempels von der aktuellen Zeit.
pub fn attach(jitterbuffer: &gst::Element, pipeline: &gst::Pipeline, clock_rate: u32, labels: Arc<RtpLabels>, clock: ClockFn, max_skew_ns: u64) -> Result<(), String> {
    let pad = jitterbuffer.static_pad("src").ok_or("rtpjitterbuffer ohne src-Pad")?;
    let weak = pipeline.downgrade();
    let last: Mutex<Option<u64>> = Mutex::new(None);
    pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, info| {
        if !labels.use_rtp.load(Ordering::Relaxed) {
            labels.rtp_active.store(false, Ordering::Relaxed);
            return gst::PadProbeReturn::Ok;
        }
        let Some(gst::PadProbeData::Buffer(ref mut buf)) = info.data else { return gst::PadProbeReturn::Ok };
        let ts = {
            let Ok(map) = buf.map_readable() else { return gst::PadProbeReturn::Ok };
            let d = map.as_slice();
            if d.len() < 12 || d[0] >> 6 != 2 {
                return gst::PadProbeReturn::Ok;
            }
            u32::from_be_bytes([d[4], d[5], d[6], d[7]])
        };
        let fallback = |why: String| {
            labels.rtp_active.store(false, Ordering::Relaxed);
            if labels.fallbacks.fetch_add(1, Ordering::Relaxed) == 0 {
                eprintln!("omp-mediaio(rtplabel): Rückfall auf Ankunftszeit: {why}");
            }
            *labels.last_msg.lock().expect("lock poisoned") = why;
        };
        let Some(now) = clock() else {
            fallback("Uhr nicht synchron".into());
            return gst::PadProbeReturn::Ok;
        };
        let ns = match rtp_to_clock_ns(ts, clock_rate, now, max_skew_ns) {
            Ok(v) => v,
            Err(e) => {
                fallback(format!("{e:?}"));
                return gst::PadProbeReturn::Ok;
            }
        };
        let Some(pl) = weak.upgrade() else { return gst::PadProbeReturn::Ok };
        let Some(base) = pl.base_time() else { return gst::PadProbeReturn::Ok };
        if ns < base.nseconds() {
            fallback("Zeitstempel vor Pipeline-Start".into());
            return gst::PadProbeReturn::Ok;
        }
        let pts = ns - base.nseconds();
        {
            let mut l = last.lock().expect("lock poisoned");
            if let Some(prev) = *l
                && (pts > prev + 1_000_000_000 || pts + 100_000_000 < prev)
            {
                labels.jumps.fetch_add(1, Ordering::Relaxed);
            }
            *l = Some(pts);
        }
        if let Some(b) = buf.get_mut() {
            b.set_pts(gst::ClockTime::from_nseconds(pts));
        }
        labels.rtp_active.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Ok
    });
    Ok(())
}
