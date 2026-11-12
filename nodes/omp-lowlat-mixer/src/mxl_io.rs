//! MXL-Ein-/Ausgang **ohne GStreamer**, kleine Blöcke. Eingang: ein Leser-Thread holt je Streifen alle bereitliegenden Blöcke
//! nicht blockierend (blockierendes Warten kostete auf der Entwicklungs-VM ≈ 4 ms Weckverzug, `mxl_small_block_probe`) und
//! legt sie in den Eingangsring ([`crate::ring::InRing`]). Ausgang: der Misch-Takt schreibt je Bus einen Block mit dem Index
//! der MXL-Uhr; weicht der Misch-Takt langsam von der MXL-Uhr ab, wird ein Block um einen Rahmen gestreckt/gestaucht, damit der
//! Sample-Index lückenlos bleibt.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_mediaio::mxl::{MxlContext, audio_flow_def};

use crate::ring::{InRing, stretch};

pub const RATE: i64 = 48_000;

fn rate() -> mxl_sys::Rational {
    mxl_sys::Rational { numerator: RATE, denominator: 1 }
}

pub struct InSlot {
    pub flow: Mutex<String>,
    pub ring: Arc<Mutex<InRing>>,
    pub flowed: AtomicBool,
    /// Wird bei jeder (Neu-)Verbindung erhöht, damit der Leser-Thread den Leser neu aufbaut.
    pub gen_: AtomicU64,
    pub resyncs: AtomicU64,
    pub last_error: Mutex<String>,
}

pub struct MxlIn {
    pub slots: Vec<Arc<InSlot>>,
    shutdown: Arc<AtomicBool>,
}

impl Drop for MxlIn {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
    }
}

struct Active {
    reader: mxl::SamplesReader,
    flow: String,
    gen_: u64,
    channels: usize,
    idx: u64,
}

impl MxlIn {
    pub fn new(ctx: Arc<MxlContext>, rings: Vec<Arc<Mutex<InRing>>>, block: usize) -> Arc<Self> {
        let slots: Vec<Arc<InSlot>> = rings
            .into_iter()
            .map(|ring| Arc::new(InSlot { flow: Mutex::new(String::new()), ring, flowed: AtomicBool::new(false), gen_: AtomicU64::new(0), resyncs: AtomicU64::new(0), last_error: Mutex::new(String::new()) }))
            .collect();
        let shutdown = Arc::new(AtomicBool::new(false));
        let me = Arc::new(Self { slots: slots.clone(), shutdown: shutdown.clone() });
        std::thread::Builder::new()
            .name("ll-mxl-in".into())
            .spawn(move || poll_loop(ctx, slots, block, shutdown))
            .expect("Leser-Thread");
        me
    }

    /// Verbindet einen Streifen mit einem MXL-Audio-Flow (leer = trennen).
    pub fn connect(&self, slot: usize, flow_id: &str) {
        let Some(s) = self.slots.get(slot) else { return };
        *s.flow.lock().expect("lock poisoned") = flow_id.to_string();
        s.flowed.store(false, Ordering::Relaxed);
        s.ring.lock().expect("lock poisoned").reset();
        s.gen_.fetch_add(1, Ordering::SeqCst);
    }

    pub fn flow_of(&self, slot: usize) -> String {
        self.slots.get(slot).map(|s| s.flow.lock().expect("lock poisoned").clone()).unwrap_or_default()
    }
}

fn open(ctx: &MxlContext, flow: &str, block: usize) -> Result<(mxl::SamplesReader, usize, u64), String> {
    let inst = ctx.instance();
    let def: serde_json::Value = serde_json::from_str(&inst.get_flow_def(flow).map_err(|e| format!("flow_def: {e:?}"))?).map_err(|e| e.to_string())?;
    if def["format"].as_str() != Some("urn:x-nmos:format:audio") {
        return Err("kein Audio-Flow".into());
    }
    let sr = def["sample_rate"]["numerator"].as_i64().unwrap_or(0);
    if sr != RATE {
        return Err(format!("Abtastrate {sr} Hz nicht unterstützt (nur 48000)"));
    }
    let channels = def["channel_count"].as_u64().unwrap_or(1) as usize;
    let reader = inst.create_flow_reader(flow).map_err(|e| format!("reader: {e:?}"))?.to_samples_reader().map_err(|e| format!("samples reader: {e:?}"))?;
    let now = inst.get_current_index(&rate());
    Ok((reader, channels, now.saturating_sub(2 * block as u64)))
}

fn poll_loop(ctx: Arc<MxlContext>, slots: Vec<Arc<InSlot>>, block: usize, shutdown: Arc<AtomicBool>) {
    let mut active: Vec<Option<Active>> = slots.iter().map(|_| None).collect();
    let mut retry_at: Vec<std::time::Instant> = slots.iter().map(|_| std::time::Instant::now()).collect();
    let inst = ctx.instance();
    let mut buf: Vec<f32> = Vec::with_capacity(block * 2 * 64);
    while !shutdown.load(Ordering::Relaxed) {
        let mut progress = false;
        for (i, slot) in slots.iter().enumerate() {
            let want = slot.flow.lock().expect("lock poisoned").clone();
            let gen_ = slot.gen_.load(Ordering::SeqCst);
            if active[i].as_ref().is_some_and(|a| a.gen_ != gen_ || a.flow != want) {
                active[i] = None;
            }
            if want.is_empty() {
                continue;
            }
            if active[i].is_none() {
                if std::time::Instant::now() < retry_at[i] {
                    continue;
                }
                match open(&ctx, &want, block) {
                    Ok((reader, channels, idx)) => {
                        slot.last_error.lock().expect("lock poisoned").clear();
                        active[i] = Some(Active { reader, flow: want.clone(), gen_, channels, idx });
                    }
                    Err(e) => {
                        *slot.last_error.lock().expect("lock poisoned") = e;
                        retry_at[i] = std::time::Instant::now() + Duration::from_millis(500);
                        continue;
                    }
                }
            }
            let a = active[i].as_mut().expect("aktiv");
            buf.clear();
            let mut blocks = 0;
            let mut drop_reader = false;
            while blocks < 64 {
                match a.reader.get_samples_non_blocking(a.idx, block) {
                    Ok(d) => {
                        let nch = d.num_of_channels().min(a.channels).max(1);
                        let mut planar: [Vec<f32>; 2] = [Vec::with_capacity(block), Vec::with_capacity(block)];
                        for (c, p) in planar.iter_mut().enumerate().take(nch.min(2)) {
                            if let Ok((d1, d2)) = d.channel_data(c) {
                                p.extend(d1.chunks_exact(4).chain(d2.chunks_exact(4)).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
                            }
                        }
                        let (l, r) = if nch >= 2 { (&planar[0], &planar[1]) } else { (&planar[0], &planar[0]) };
                        for k in 0..l.len().min(r.len()) {
                            buf.push(l[k]);
                            buf.push(r[k]);
                        }
                        a.idx += block as u64;
                        blocks += 1;
                    }
                    Err(mxl::Error::OutOfRangeTooEarly) => break,
                    Err(mxl::Error::OutOfRangeTooLate) => {
                        a.idx = inst.get_current_index(&rate()).saturating_sub(2 * block as u64);
                        slot.resyncs.fetch_add(1, Ordering::Relaxed);
                        break;
                    }
                    Err(e) => {
                        *slot.last_error.lock().expect("lock poisoned") = format!("{e:?}");
                        retry_at[i] = std::time::Instant::now() + Duration::from_millis(500);
                        drop_reader = true;
                        break;
                    }
                }
            }
            if drop_reader {
                active[i] = None;
                slot.flowed.store(false, Ordering::Relaxed);
                continue;
            }
            // Leser läuft dem Schreiber weit voraus (Index in der Zukunft, z. B. nach Uhrsprung): neu aufsetzen
            if a.idx > inst.get_current_index(&rate()) + 20 * block as u64 {
                a.idx = inst.get_current_index(&rate()).saturating_sub(2 * block as u64);
                slot.resyncs.fetch_add(1, Ordering::Relaxed);
            }
            if blocks > 0 {
                progress = true;
                slot.flowed.store(true, Ordering::Relaxed);
                slot.ring.lock().expect("lock poisoned").push(&buf);
            }
        }
        if !progress {
            std::thread::sleep(Duration::from_micros(100));
        }
    }
}

/// Ausgang eines Busses.
pub struct MxlOut {
    writer: mxl::SamplesWriter,
    block: usize,
    last_end: Option<u64>,
    pub flowed: Arc<AtomicBool>,
    pub resyncs: u64,
    pub stretched: u64,
    scratch: [Vec<f32>; 2],
}

impl MxlOut {
    pub fn new(ctx: &MxlContext, flow_id: &str, label: &str, block: usize) -> Result<Self, String> {
        let def = audio_flow_def(flow_id, label, RATE as u32, 2);
        let (writer, _cfg, _created) = ctx.instance().create_flow_writer(&def, None).map_err(|e| format!("create_flow_writer: {e:?}"))?;
        let writer = writer.to_samples_writer().map_err(|e| format!("to_samples_writer: {e:?}"))?;
        Ok(Self { writer, block, last_end: None, flowed: Arc::new(AtomicBool::new(false)), resyncs: 0, stretched: 0, scratch: [vec![0.0; block + 2], vec![0.0; block + 2]] })
    }

    /// Schreibt einen Block (planar). Index = Stand der MXL-Uhr; Abweichung ≥ 2 Rahmen wird über Strecken ausgeglichen.
    pub fn write(&mut self, ctx: &MxlContext, l: &[f32], r: &[f32]) {
        let n = self.block;
        let now = ctx.instance().get_current_index(&rate());
        let (end, n_out) = match self.last_end {
            None => (now, n),
            Some(last) => {
                let expect = last + n as u64;
                let err = now as i64 - expect as i64;
                if err.abs() > 4 * n as i64 {
                    self.resyncs += 1;
                    (now, n)
                } else if err >= 2 {
                    (expect + 1, n + 1)
                } else if err <= -2 && n > 2 {
                    (expect - 1, n - 1)
                } else {
                    (expect, n)
                }
            }
        };
        let (a, b): (&[f32], &[f32]) = if n_out == n {
            (&l[..n], &r[..n])
        } else {
            self.stretched += 1;
            stretch(&l[..n], n, &mut self.scratch[0], n_out, 1);
            stretch(&r[..n], n, &mut self.scratch[1], n_out, 1);
            (&self.scratch[0][..n_out], &self.scratch[1][..n_out])
        };
        match self.writer.open_samples(end, n_out) {
            Ok(mut acc) => {
                for (c, src) in [a, b].iter().enumerate().take(acc.channels().min(2)) {
                    if let Ok((d1, d2)) = acc.channel_data_mut(c) {
                        let mut it = src.iter();
                        for dst in d1.chunks_exact_mut(4).chain(d2.chunks_exact_mut(4)) {
                            dst.copy_from_slice(&it.next().copied().unwrap_or(0.0).to_le_bytes());
                        }
                    }
                }
                if acc.commit().is_ok() {
                    self.flowed.store(true, Ordering::Relaxed);
                    self.last_end = Some(end);
                } else {
                    self.last_end = None;
                }
            }
            Err(_) => self.last_end = None,
        }
    }
}
