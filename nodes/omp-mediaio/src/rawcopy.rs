//! Direkter Grain-Kopierer zwischen zwei MXL-Domains (Kap. 103, `omp-mxl-bridge`): liest die Grains eines Video-Flows aus
//! einer Domain und schreibt sie UNVERÄNDERT als eigenen Flow in eine andere — ohne GStreamer, ohne v210-Wandlung,
//! ohne Skalierung. Das ist der billige Weg einer Brücke (ein Speicherkopie je Bild, im Test < 5 % statt ≈ 70 % eines Kerns
//! beim Wandeln); er gilt nur, wenn das Quellformat dem Zielformat entspricht.
//!
//! Der Grain-Index bleibt erhalten (beide Domains teilen dieselbe TAI-Zeit): Bild und Ton einer Quelle bleiben nach der
//! Brücke zueinander ausgerichtet.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::mxl::MxlContext;

/// Wie lange ohne ein einziges Grain, bis der Kopierer sich selbst als tot meldet (die Quelle ist weg oder wurde neu
/// angelegt; der Aufrufer baut dann neu auf) — er ruft dazu `on_dead` auf.
const STALL: Duration = Duration::from_secs(3);

/// Wartezeit eines blockierenden Lesens (Futex); danach wird kurz die Stopp-Bedingung geprüft und erneut gewartet.
const READ_TIMEOUT: Duration = Duration::from_millis(100);

/// Laufzeit-Steuerung des A/V-Ausgleichs im Kopierpfad (UMSETZUNG 106.5). Alle Werte sind jederzeit änderbar.
///
/// - Ton: Verzögerung in Samples. Ganzzahlig und stationär bleibt der Pfad **bitgleich** (nur gelesener Index verschoben).
///   Bei Änderung gleitet die Verzögerung mit höchstens `slew_permille` (‰ = ms je s) zum Ziel, dazwischen wird linear
///   interpoliert (kein Sprung im Ton). Datenkanäle (`data_channels`) werden nie interpoliert, nur ganzzahlig versetzt.
/// - Bild: Verzögerung in ganzen Bildern über einen lokalen Ring; bei Änderung springt das Bild um ganze Bilder.
pub struct AvDelay {
    audio_target: std::sync::atomic::AtomicU64,
    audio_current: std::sync::atomic::AtomicU64,
    slew_permille: std::sync::atomic::AtomicU64,
    video_frames: std::sync::atomic::AtomicU32,
    max_video_frames: u32,
    data_channels: Mutex<Vec<usize>>,
}

impl AvDelay {
    pub fn new(max_video_frames: u32) -> Arc<AvDelay> {
        Arc::new(AvDelay {
            audio_target: std::sync::atomic::AtomicU64::new(0f64.to_bits()),
            audio_current: std::sync::atomic::AtomicU64::new(0f64.to_bits()),
            slew_permille: std::sync::atomic::AtomicU64::new(5.0f64.to_bits()),
            video_frames: std::sync::atomic::AtomicU32::new(0),
            max_video_frames,
            data_channels: Mutex::new(Vec::new()),
        })
    }
    /// Zielverzögerung des Tons in Samples (auf ganze Samples gerundet, ≥ 0).
    pub fn set_audio_delay_samples(&self, samples: f64) {
        let v = if samples.is_finite() { samples.round().max(0.0) } else { 0.0 };
        self.audio_target.store(v.to_bits(), Ordering::Relaxed);
    }
    pub fn audio_target_samples(&self) -> f64 {
        f64::from_bits(self.audio_target.load(Ordering::Relaxed))
    }
    /// Aktuell wirksame Tonverzögerung (gleitet zum Ziel).
    pub fn audio_current_samples(&self) -> f64 {
        f64::from_bits(self.audio_current.load(Ordering::Relaxed))
    }
    pub fn set_slew_permille(&self, p: f64) {
        self.slew_permille.store(p.clamp(0.01, 1000.0).to_bits(), Ordering::Relaxed);
    }
    pub fn set_video_frames(&self, n: u32) {
        self.video_frames.store(n.min(self.max_video_frames), Ordering::Relaxed);
    }
    pub fn max_frames(&self) -> u32 {
        self.max_video_frames
    }
    pub fn video_frames(&self) -> u32 {
        self.video_frames.load(Ordering::Relaxed)
    }
    pub fn set_data_channels(&self, ch: Vec<usize>) {
        *self.data_channels.lock().expect("lock poisoned") = ch;
    }
}

/// Das Zielformat, dem die Quelle entsprechen muss.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoFormat {
    pub width: u32,
    pub height: u32,
    pub rate_num: u32,
    pub rate_den: u32,
}

/// Prüft die `flow_def` der Quelle gegen das Zielformat. `Ok(def)` = direkt kopierbar, `Err(grund)` = Wandlung nötig.
pub fn check_passthrough(
    source_flow_def: &str,
    target: VideoFormat,
) -> Result<serde_json::Value, String> {
    let v: serde_json::Value =
        serde_json::from_str(source_flow_def).map_err(|e| format!("flow_def: {e}"))?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let n = |k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    if s("media_type") != "video/v210" {
        return Err(format!(
            "Medientyp {} (nur video/v210 wird direkt kopiert)",
            s("media_type")
        ));
    }
    if v.get("interlace_mode")
        .and_then(|x| x.as_str())
        .unwrap_or("progressive")
        != "progressive"
    {
        return Err("Zeilensprung (nicht progressiv)".to_string());
    }
    let (w, h) = (n("frame_width") as u32, n("frame_height") as u32);
    let rate = v.get("grain_rate");
    let rn = rate
        .and_then(|r| r.get("numerator"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let rd = rate
        .and_then(|r| r.get("denominator"))
        .and_then(|x| x.as_u64())
        .unwrap_or(1)
        .max(1);
    if (w, h) != (target.width, target.height) {
        return Err(format!(
            "Größe {w}×{h} statt {}×{}",
            target.width, target.height
        ));
    }
    // Bildraten gleichwertig? (z. B. 50/2 = 25/1)
    if rn * target.rate_den as u64 != target.rate_num as u64 * rd {
        return Err(format!(
            "Bildrate {rn}/{rd} statt {}/{}",
            target.rate_num, target.rate_den
        ));
    }
    Ok(v)
}

/// Zielformat des Tons, dem die Quelle entsprechen muss.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u32,
}

/// Prüft die `flow_def` eines Ton-Flows: `audio/float32`, gleiche Abtastrate und Kanalzahl.
pub fn check_audio_passthrough(source_flow_def: &str, target: AudioFormat) -> Result<serde_json::Value, String> {
    let v: serde_json::Value = serde_json::from_str(source_flow_def).map_err(|e| format!("flow_def: {e}"))?;
    let media = v.get("media_type").and_then(|x| x.as_str()).unwrap_or("");
    if media != "audio/float32" {
        return Err(format!("Medientyp {media} (nur audio/float32 wird direkt kopiert)"));
    }
    let rate = v.get("sample_rate").and_then(|r| r.get("numerator")).and_then(|x| x.as_u64()).unwrap_or(0);
    let channels = v.get("channel_count").and_then(|x| x.as_u64()).unwrap_or(0);
    if rate != target.sample_rate as u64 {
        return Err(format!("Abtastrate {rate} Hz statt {} Hz", target.sample_rate));
    }
    if channels != target.channels as u64 {
        return Err(format!("{channels} Kanäle statt {}", target.channels));
    }
    Ok(v)
}

/// Kopiert die Bytes eines in zwei Fragmente (Ringpuffer-Umbruch) geteilten Quellbereichs in einen ebenso geteilten Zielbereich.
fn copy_fragments(src: (&[u8], &[u8]), dst: (&mut [u8], &mut [u8])) {
    let total = src.0.len() + src.1.len();
    let cap = dst.0.len() + dst.1.len();
    let n = total.min(cap);
    let mut copied = 0usize;
    for part in [src.0, src.1] {
        let mut off = 0;
        while off < part.len() && copied < n {
            let take = (part.len() - off).min(n - copied);
            // Zielposition in den zwei Fragmenten
            if copied < dst.0.len() {
                let room = dst.0.len() - copied;
                let t = take.min(room);
                dst.0[copied..copied + t].copy_from_slice(&part[off..off + t]);
                off += t;
                copied += t;
            } else {
                let o = copied - dst.0.len();
                dst.1[o..o + take].copy_from_slice(&part[off..off + take]);
                off += take;
                copied += take;
            }
        }
    }
}

/// Samples je Kopierschritt (10 ms bei 48 kHz) — wie die Ausgangskette der übrigen Nodes.
const AUDIO_BATCH: usize = 480;

pub struct RawAudioCopy {
    running: Arc<AtomicBool>,
    dead: Arc<AtomicBool>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl RawAudioCopy {
    pub fn start(
        in_ctx: Arc<MxlContext>,
        out_ctx: Arc<MxlContext>,
        source_flow_id: &str,
        source_def: serde_json::Value,
        out_flow_id: &str,
        label: &str,
        target: AudioFormat,
        flowed: Arc<AtomicBool>,
        on_dead: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, String> {
        Self::start_delayed(in_ctx, out_ctx, source_flow_id, source_def, out_flow_id, label, target, flowed, on_dead, None)
    }

    /// Wie [`start`](Self::start), mit optionaler Laufzeit-Verzögerung (`AvDelay`). Ohne Steuerung oder bei Verzögerung 0
    /// ist der Pfad derselbe bitgleiche Kopierer.
    pub fn start_delayed(
        in_ctx: Arc<MxlContext>,
        out_ctx: Arc<MxlContext>,
        source_flow_id: &str,
        source_def: serde_json::Value,
        out_flow_id: &str,
        label: &str,
        target: AudioFormat,
        flowed: Arc<AtomicBool>,
        on_dead: Arc<dyn Fn() + Send + Sync>,
        ctl: Option<Arc<AvDelay>>,
    ) -> Result<Self, String> {
        let mut def = source_def;
        if let Some(o) = def.as_object_mut() {
            o.insert("id".into(), out_flow_id.into());
            o.insert("label".into(), label.into());
            o.insert("description".into(), format!("OpenMediaPlatform: {label}").into());
            o.insert(
                "tags".into(),
                serde_json::json!({"urn:x-nmos:tag:grouphint/v1.0": [crate::group::tag_value("Audio", out_flow_id)]}),
            );
        }
        let (writer, _cfg, _created) = out_ctx
            .instance()
            .create_flow_writer(&def.to_string(), None)
            .map_err(|e| format!("create_flow_writer: {e}"))?;
        let samples_writer = writer.to_samples_writer().map_err(|e| format!("to_samples_writer: {e}"))?;
        let samples_reader = in_ctx
            .instance()
            .create_flow_reader(source_flow_id)
            .and_then(|r| r.to_samples_reader())
            .map_err(|e| format!("create_flow_reader({source_flow_id}): {e}"))?;
        let running = Arc::new(AtomicBool::new(true));
        let dead = Arc::new(AtomicBool::new(false));
        let (run, dd) = (running.clone(), dead.clone());
        let handle = thread::Builder::new()
            .name("mxl-rawcopy-a".into())
            .spawn(move || {
                let now_index = || in_ctx.ns_to_index(in_ctx.now_ns(), target.sample_rate, 1).unwrap_or(0);
                let batch = AUDIO_BATCH as u64;
                let mut index = now_index().saturating_sub(batch * 3);
                let mut last_ok = Instant::now();
                let mut cur_delay = 0.0f64;
                while run.load(Ordering::Relaxed) {
                    let (target_d, slew) = match &ctl {
                        Some(c) => (c.audio_target_samples(), f64::from_bits(c.slew_permille.load(Ordering::Relaxed)) / 1000.0),
                        None => (0.0, 0.0),
                    };
                    let stationary = (cur_delay - target_d).abs() < 1e-9 && cur_delay.fract() == 0.0;
                    if ctl.is_some() && !stationary {
                        // Gleitende Verzögerung: pro Sample um höchstens `slew` Samples zum Ziel, linear interpoliert.
                        let data_ch = ctl.as_ref().map(|c| c.data_channels.lock().expect("lock poisoned").clone()).unwrap_or_default();
                        let mut d = Vec::with_capacity(AUDIO_BATCH);
                        // Auf einer Kopie rechnen: scheitert das Lesen (Timeout), wird derselbe Block wiederholt, ohne dass die
                        // Verzögerung schon weitergelaufen ist (sonst fehlen Samples im Ton).
                        let mut next_delay = cur_delay;
                        for _ in 0..AUDIO_BATCH {
                            let step = (target_d - next_delay).clamp(-slew, slew);
                            next_delay += step;
                            if (next_delay - target_d).abs() < 1e-9 {
                                next_delay = target_d;
                            }
                            d.push(next_delay);
                        }
                        // MXL adressiert einen Sample-Block über seinen LETZTEN Index: der Block `index` umfasst [index−479, index].
                        let w0 = (index + 1).saturating_sub(AUDIO_BATCH as u64);
                        let pos = |i: usize| (w0 + i as u64) as f64 - d[i];
                        let lo_f = pos(0).min(pos(AUDIO_BATCH - 1)).floor();
                        let hi_f = pos(0).max(pos(AUDIO_BATCH - 1)).floor() + 1.0;
                        if lo_f < 0.0 {
                            index += batch;
                            continue;
                        }
                        let (lo, len) = (lo_f as u64, (hi_f - lo_f) as usize + 1);
                        match samples_reader.get_samples(lo + len as u64 - 1, len, READ_TIMEOUT) {
                            Ok(data) => {
                                if let Ok(mut access) = samples_writer.open_samples(index, AUDIO_BATCH) {
                                    for ch in 0..data.num_of_channels().min(access.channels()) {
                                        let Ok(src) = data.channel_data(ch) else { continue };
                                        let words: Vec<u32> = src.0.chunks_exact(4).chain(src.1.chunks_exact(4)).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
                                        let mut out = Vec::with_capacity(AUDIO_BATCH * 4);
                                        for i in 0..AUDIO_BATCH {
                                            let p = pos(i);
                                            let k = (p.floor() as u64).saturating_sub(lo) as usize;
                                            let w = if data_ch.contains(&ch) {
                                                // Datenkanal: nie interpolieren, nur ganzzahlig versetzt.
                                                words.get((p.round() as u64).saturating_sub(lo) as usize).copied().unwrap_or(0)
                                            } else {
                                                let frac = (p - p.floor()) as f32;
                                                let a = f32::from_bits(words.get(k).copied().unwrap_or(0));
                                                let b = f32::from_bits(words.get(k + 1).copied().unwrap_or(0));
                                                (a + (b - a) * frac).to_bits()
                                            };
                                            out.extend_from_slice(&w.to_le_bytes());
                                        }
                                        if let Ok(dst) = access.channel_data_mut(ch) {
                                            copy_fragments((&out, &[]), dst);
                                        }
                                    }
                                    if access.commit().is_ok() {
                                        flowed.store(true, Ordering::Relaxed);
                                        last_ok = Instant::now();
                                    }
                                }
                                index += batch;
                                cur_delay = next_delay;
                            }
                            Err(mxl::Error::Timeout) => {}
                            Err(mxl::Error::OutOfRangeTooLate) => index = index.max(now_index().saturating_sub(batch * 2)),
                            Err(mxl::Error::OutOfRangeTooEarly) => thread::sleep(Duration::from_millis(2)),
                            Err(_) => thread::sleep(Duration::from_millis(20)),
                        }
                        if let Some(c) = &ctl {
                            c.audio_current.store(cur_delay.to_bits(), Ordering::Relaxed);
                        }
                        if last_ok.elapsed() > STALL {
                            dd.store(true, Ordering::Relaxed);
                            on_dead();
                            break;
                        }
                        continue;
                    }
                    if let Some(c) = &ctl {
                        c.audio_current.store(cur_delay.to_bits(), Ordering::Relaxed);
                    }
                    // Stationär (auch Verzögerung 0): bitgleiche Kopie, gelesen wird um die ganzzahlige Verzögerung früher.
                    let read_at = index.saturating_sub(cur_delay as u64);
                    match samples_reader.get_samples(read_at, AUDIO_BATCH, READ_TIMEOUT) {
                        Ok(data) => {
                            match samples_writer.open_samples(index, AUDIO_BATCH) {
                                Ok(mut access) => {
                                    for ch in 0..data.num_of_channels().min(access.channels()) {
                                        if let (Ok(src), Ok(dst)) = (data.channel_data(ch), access.channel_data_mut(ch)) {
                                            copy_fragments(src, dst);
                                        }
                                    }
                                    if access.commit().is_ok() {
                                        flowed.store(true, Ordering::Relaxed);
                                        last_ok = Instant::now();
                                    }
                                }
                                Err(e) => eprintln!("omp-mediaio(rawcopy): open_samples {index} failed: {e}"),
                            }
                            index += batch;
                        }
                        Err(mxl::Error::Timeout) => {}
                        Err(mxl::Error::OutOfRangeTooLate) => index = index.max(now_index().saturating_sub(batch * 2)),
                        Err(mxl::Error::OutOfRangeTooEarly) => thread::sleep(Duration::from_millis(2)),
                        Err(_) => thread::sleep(Duration::from_millis(20)),
                    }
                    if last_ok.elapsed() > STALL {
                        dd.store(true, Ordering::Relaxed);
                        on_dead(); // den Aufrufer wecken (kein Nachsehen im Takt auf seiner Seite)
                        break;
                    }
                }
            })
            .map_err(|e| format!("thread: {e}"))?;
        Ok(RawAudioCopy { running, dead, handle: Mutex::new(Some(handle)) })
    }

    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed)
    }
}

impl Drop for RawAudioCopy {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(h) = self.handle.lock().expect("lock poisoned").take() {
            let _ = h.join();
        }
    }
}

/// Ein Ausgang des Tonteilers ([`RawAudioSplit`]): eigener Flow aus ausgewählten Eingangskanälen.
#[derive(Clone, Debug)]
pub struct SplitOutput {
    pub flow_id: String,
    pub label: String,
    /// Eingangskanäle (1-basiert) in der Reihenfolge der Ausgangskanäle.
    pub channels: Vec<usize>,
}

/// Prüft die `flow_def` der Quelle für den Tonteiler: `audio/float32`, Abtastrate, mindestens `min_channels` Kanäle.
/// Gibt die Definition und die Kanalzahl der Quelle zurück.
pub fn check_split_source(source_flow_def: &str, sample_rate: u32, min_channels: u32) -> Result<(serde_json::Value, u32), String> {
    let v: serde_json::Value = serde_json::from_str(source_flow_def).map_err(|e| format!("flow_def: {e}"))?;
    let media = v.get("media_type").and_then(|x| x.as_str()).unwrap_or("");
    if media != "audio/float32" {
        return Err(format!("Medientyp {media} (nur audio/float32 wird geteilt)"));
    }
    let rate = v.get("sample_rate").and_then(|r| r.get("numerator")).and_then(|x| x.as_u64()).unwrap_or(0);
    if rate != sample_rate as u64 {
        return Err(format!("Abtastrate {rate} Hz statt {sample_rate} Hz"));
    }
    let channels = v.get("channel_count").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    if channels < min_channels {
        return Err(format!("Quelle hat {channels} Kanäle, die Ausgänge brauchen mindestens {min_channels}"));
    }
    Ok((v, channels))
}

/// Tonteiler: liest einen Mehrkanal-Ton-Flow und schreibt je Ausgang einen **eigenen** Flow aus den gewählten Kanälen
/// (z. B. 16 Kanäle → Stereo 1/2 Programm, 3/4 internationaler Ton, …). Reiner Kanalkopierer: je Kanal eine bitgleiche
/// Speicherkopie, der Sample-Index bleibt erhalten (Bild/Ton/Daten bleiben ausgerichtet). Nicht-PCM-Datenkanäle gehen so
/// unverändert durch. Ein Quellkanal darf in mehreren Ausgängen vorkommen; nicht gewählte Kanäle werden verworfen.
pub struct RawAudioSplit {
    running: Arc<AtomicBool>,
    dead: Arc<AtomicBool>,
    handle: Mutex<Option<JoinHandle<()>>>,
    map: Arc<std::sync::RwLock<Vec<Vec<usize>>>>,
}

impl RawAudioSplit {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        in_ctx: Arc<MxlContext>,
        out_ctx: Arc<MxlContext>,
        source_flow_id: &str,
        source_def: serde_json::Value,
        outputs: &[SplitOutput],
        sample_rate: u32,
        flowed: Arc<AtomicBool>,
        on_dead: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, String> {
        if outputs.is_empty() {
            return Err("keine Ausgänge".into());
        }
        let mut writers = Vec::with_capacity(outputs.len());
        for o in outputs {
            let mut def = source_def.clone();
            if let Some(m) = def.as_object_mut() {
                m.insert("id".into(), o.flow_id.clone().into());
                m.insert("label".into(), o.label.clone().into());
                m.insert("description".into(), format!("OpenMediaPlatform: {}", o.label).into());
                m.insert("channel_count".into(), (o.channels.len() as u64).into());
                m.insert("tags".into(), serde_json::json!({"urn:x-nmos:tag:grouphint/v1.0": [crate::group::tag_value("Audio", &o.flow_id)]}));
            }
            let (writer, _cfg, _created) = out_ctx.instance().create_flow_writer(&def.to_string(), None).map_err(|e| format!("create_flow_writer({}): {e}", o.label))?;
            writers.push(writer.to_samples_writer().map_err(|e| format!("to_samples_writer({}): {e}", o.label))?);
        }
        let samples_reader = in_ctx
            .instance()
            .create_flow_reader(source_flow_id)
            .and_then(|r| r.to_samples_reader())
            .map_err(|e| format!("create_flow_reader({source_flow_id}): {e}"))?;
        let map = Arc::new(std::sync::RwLock::new(outputs.iter().map(|o| o.channels.clone()).collect::<Vec<_>>()));
        let running = Arc::new(AtomicBool::new(true));
        let dead = Arc::new(AtomicBool::new(false));
        let (run, dd, mp) = (running.clone(), dead.clone(), map.clone());
        let handle = thread::Builder::new()
            .name("mxl-audio-split".into())
            .spawn(move || {
                let now_index = || in_ctx.ns_to_index(in_ctx.now_ns(), sample_rate, 1).unwrap_or(0);
                let batch = AUDIO_BATCH as u64;
                let mut index = now_index().saturating_sub(batch * 3);
                let mut last_ok = Instant::now();
                while run.load(Ordering::Relaxed) {
                    match samples_reader.get_samples(index, AUDIO_BATCH, READ_TIMEOUT) {
                        Ok(data) => {
                            let channels = mp.read().map(|g| g.clone()).unwrap_or_default();
                            let mut wrote = false;
                            for (o, writer) in writers.iter().enumerate() {
                                match writer.open_samples(index, AUDIO_BATCH) {
                                    Ok(mut access) => {
                                        for (k, &ch) in channels.get(o).into_iter().flatten().enumerate() {
                                            if ch >= 1 && ch <= data.num_of_channels() && k < access.channels() {
                                                if let (Ok(src), Ok(dst)) = (data.channel_data(ch - 1), access.channel_data_mut(k)) {
                                                    copy_fragments(src, dst);
                                                }
                                            }
                                        }
                                        wrote |= access.commit().is_ok();
                                    }
                                    Err(e) => eprintln!("omp-mediaio(split): open_samples {index} (Ausgang {o}) failed: {e}"),
                                }
                            }
                            if wrote {
                                flowed.store(true, Ordering::Relaxed);
                                last_ok = Instant::now();
                            }
                            index += batch;
                        }
                        Err(mxl::Error::Timeout) => {}
                        Err(mxl::Error::OutOfRangeTooLate) => index = index.max(now_index().saturating_sub(batch * 2)),
                        Err(mxl::Error::OutOfRangeTooEarly) => thread::sleep(Duration::from_millis(2)),
                        Err(_) => thread::sleep(Duration::from_millis(20)),
                    }
                    if last_ok.elapsed() > STALL {
                        dd.store(true, Ordering::Relaxed);
                        on_dead();
                        break;
                    }
                }
            })
            .map_err(|e| format!("thread: {e}"))?;
        Ok(RawAudioSplit { running, dead, handle: Mutex::new(Some(handle)), map })
    }

    /// Ordnet die Kanäle eines Ausgangs neu zu (gleiche Kanalzahl; wirkt ab dem nächsten Block).
    pub fn set_channels(&self, output: usize, channels: Vec<usize>) -> Result<(), String> {
        let mut g = self.map.write().map_err(|_| "vergiftet".to_string())?;
        let cur = g.get_mut(output).ok_or_else(|| format!("Ausgang {output} gibt es nicht"))?;
        if cur.len() != channels.len() {
            return Err(format!("Ausgang {output}: Kanalzahl {} statt {} (nur Neuzuordnung, keine andere Kanalzahl)", channels.len(), cur.len()));
        }
        *cur = channels;
        Ok(())
    }

    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed)
    }
}

impl Drop for RawAudioSplit {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(h) = self.handle.lock().expect("lock poisoned").take() {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod split_tests {
    use super::*;

    fn def(media: &str, rate: u64, ch: u64) -> String {
        serde_json::json!({"media_type": media, "sample_rate": {"numerator": rate}, "channel_count": ch}).to_string()
    }

    #[test]
    fn split_source_check() {
        assert_eq!(check_split_source(&def("audio/float32", 48000, 16), 48000, 8).unwrap().1, 16);
        assert!(check_split_source(&def("audio/float32", 48000, 4), 48000, 8).unwrap_err().contains("mindestens 8"));
        assert!(check_split_source(&def("audio/float32", 44100, 16), 48000, 2).unwrap_err().contains("Abtastrate"));
        assert!(check_split_source(&def("video/v210", 48000, 16), 48000, 2).unwrap_err().contains("Medientyp"));
    }

    /// 16-Kanal-Quelle (Kanal c trägt den Wert c/100) → Ausgänge 1/2, 3/4 und Mono 9; Werte und Kanalzahlen müssen stimmen.
    #[test]
    #[ignore = "braucht die MXL-Laufzeit (libmxl, siehe deploy/dev/mxl.env)"]
    fn live_split_16_channels_into_separate_flows() {
        let dir = format!("/dev/shm/omp-split-test-{}", std::process::id());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = Arc::new(MxlContext::new(&dir).unwrap());
        let (src, o1, o2, o3) = ("00000000-0000-4000-8000-0000000000b0", "00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000b3");
        let (w, _, _) = ctx.instance().create_flow_writer(&crate::mxl::audio_flow_def(src, "Quelle", 48000, 16), None).unwrap();
        let writer = w.to_samples_writer().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let (st, c2) = (stop.clone(), ctx.clone());
        let feeder = thread::spawn(move || {
            let mut idx = c2.ns_to_index(c2.now_ns(), 48000, 1).unwrap().saturating_sub(AUDIO_BATCH as u64 * 6);
            while !st.load(Ordering::Relaxed) {
                if let Ok(mut a) = writer.open_samples(idx, AUDIO_BATCH) {
                    for ch in 0..16usize {
                        if let Ok(dst) = a.channel_data_mut(ch) {
                            let word = ((ch + 1) as f32 / 100.0).to_le_bytes();
                            let buf: Vec<u8> = (0..AUDIO_BATCH).flat_map(|_| word).collect();
                            copy_fragments((&buf, &[]), dst);
                        }
                    }
                    let _ = a.commit();
                }
                idx += AUDIO_BATCH as u64;
                while c2.ns_to_index(c2.now_ns(), 48000, 1).unwrap() + (AUDIO_BATCH as u64) < idx {
                    thread::sleep(Duration::from_millis(5));
                }
            }
        });
        thread::sleep(Duration::from_millis(300));
        let (def, n) = check_split_source(&ctx.flow_def(src).unwrap(), 48000, 9).unwrap();
        assert_eq!(n, 16);
        let outs = vec![
            SplitOutput { flow_id: o1.into(), label: "Programm".into(), channels: vec![1, 2] },
            SplitOutput { flow_id: o2.into(), label: "IT".into(), channels: vec![3, 4] },
            SplitOutput { flow_id: o3.into(), label: "Kommentar".into(), channels: vec![9] },
        ];
        let flowed = Arc::new(AtomicBool::new(false));
        let split = RawAudioSplit::start(ctx.clone(), ctx.clone(), src, def, &outs, 48000, flowed.clone(), Arc::new(|| {})).unwrap();
        thread::sleep(Duration::from_millis(1200));
        assert!(flowed.load(Ordering::Relaxed), "nichts geschrieben");
        let first = |flow: &str, ch: usize| -> (u32, f32) {
            let r = ctx.instance().create_flow_reader(flow).and_then(|r| r.to_samples_reader()).unwrap();
            let index = ctx.ns_to_index(ctx.now_ns(), 48000, 1).unwrap().saturating_sub(AUDIO_BATCH as u64 * 2);
            let d = r.get_samples(index, AUDIO_BATCH, Duration::from_millis(500)).unwrap();
            let (a, b) = d.channel_data(ch).unwrap();
            let bytes: Vec<u8> = a.iter().chain(b.iter()).copied().collect();
            (d.num_of_channels() as u32, f32::from_le_bytes(bytes[..4].try_into().unwrap()))
        };
        let near = |a: f32, b: f32| (a - b).abs() < 1e-6;
        let (n1, v10) = first(o1, 0);
        let (_, v11) = first(o1, 1);
        assert_eq!(n1, 2);
        assert!(near(v10, 0.01) && near(v11, 0.02), "Programm: {v10} {v11}");
        let (n2, v20) = first(o2, 0);
        let (_, v21) = first(o2, 1);
        assert_eq!(n2, 2);
        assert!(near(v20, 0.03) && near(v21, 0.04), "IT: {v20} {v21}");
        let (n3, v30) = first(o3, 0);
        assert_eq!(n3, 1);
        assert!(near(v30, 0.09), "Kommentar: {v30}");
        // Neuzuordnung zur Laufzeit: IT = Kanäle 5/6.
        split.set_channels(1, vec![5, 6]).unwrap();
        assert!(split.set_channels(1, vec![5]).is_err(), "andere Kanalzahl muss abgelehnt werden");
        thread::sleep(Duration::from_millis(600));
        let (_, v) = first(o2, 0);
        assert!(near(v, 0.05), "nach Neuzuordnung: {v}");
        drop(split);
        stop.store(true, Ordering::Relaxed);
        let _ = feeder.join();
        let _ = std::fs::remove_dir_all(&dir);
    }
}

pub struct RawVideoCopy {
    running: Arc<AtomicBool>,
    dead: Arc<AtomicBool>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl RawVideoCopy {
    /// Startet den Kopierer. `source_def` stammt aus [`check_passthrough`]. Schreibt den Flow `out_flow_id` (Beschriftung
    /// `label`) in `out_ctx`.
    pub fn start(
        in_ctx: Arc<MxlContext>,
        out_ctx: Arc<MxlContext>,
        source_flow_id: &str,
        source_def: serde_json::Value,
        out_flow_id: &str,
        label: &str,
        target: VideoFormat,
        flowed: Arc<AtomicBool>,
        on_dead: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self, String> {
        Self::start_delayed(in_ctx, out_ctx, source_flow_id, source_def, out_flow_id, label, target, flowed, on_dead, None)
    }

    /// Wie [`start`](Self::start), mit optionaler Bildverzögerung in ganzen Bildern (lokaler Ring, `AvDelay`).
    pub fn start_delayed(
        in_ctx: Arc<MxlContext>,
        out_ctx: Arc<MxlContext>,
        source_flow_id: &str,
        source_def: serde_json::Value,
        out_flow_id: &str,
        label: &str,
        target: VideoFormat,
        flowed: Arc<AtomicBool>,
        on_dead: Arc<dyn Fn() + Send + Sync>,
        ctl: Option<Arc<AvDelay>>,
    ) -> Result<Self, String> {
        let mut def = source_def;
        if let Some(o) = def.as_object_mut() {
            o.insert("id".into(), out_flow_id.into());
            o.insert("label".into(), label.into());
            o.insert(
                "description".into(),
                format!("OpenMediaPlatform: {label}").into(),
            );
            // Pflichttag "<gruppe>:<rolle>" (FlowParser.cpp) — Gruppe wie bei den eigenen Ausgängen.
            o.insert(
                "tags".into(),
                serde_json::json!({"urn:x-nmos:tag:grouphint/v1.0": [crate::group::tag_value("Video", out_flow_id)]}),
            );
        }
        let def_json = def.to_string();
        let (writer, _cfg, _created) = out_ctx
            .instance()
            .create_flow_writer(&def_json, None)
            .map_err(|e| format!("create_flow_writer: {e}"))?;
        let grain_writer = writer
            .to_grain_writer()
            .map_err(|e| format!("to_grain_writer: {e}"))?;
        let grain_reader = in_ctx
            .instance()
            .create_flow_reader(source_flow_id)
            .and_then(|r| r.to_grain_reader())
            .map_err(|e| format!("create_flow_reader({source_flow_id}): {e}"))?;

        let running = Arc::new(AtomicBool::new(true));
        let dead = Arc::new(AtomicBool::new(false));
        let (run, dd) = (running.clone(), dead.clone());
        let handle = thread::Builder::new()
            .name("mxl-rawcopy".into())
            .spawn(move || {
                let now_index = || {
                    in_ctx
                        .ns_to_index(in_ctx.now_ns(), target.rate_num, target.rate_den)
                        .unwrap_or(0)
                };
                // Zwei Bilder hinter der Uhr beginnen: die Quelle hat dort sicher fertig geschrieben.
                let mut index = now_index().saturating_sub(2);
                let mut last_ok = Instant::now();
                let mut ring: std::collections::VecDeque<Vec<u8>> = std::collections::VecDeque::new();
                while run.load(Ordering::Relaxed) {
                    // Blockierend: der Aufruf kehrt zurück, sobald der Schreiber das Grain fertig committet hat (Futex), oder
                    // nach dem Timeout — kein Nachsehen im Takt. Gemessen (blocking_read_probe, MXL 1.1.0 GA): auch mit 8
                    // Lesern und ständigem Öffnen/Schließen kein Hängen über das Timeout hinaus.
                    match grain_reader.get_complete_grain(index, READ_TIMEOUT) {
                        Ok(g) if g.index == index => {
                            match grain_writer.open_grain(index) {
                                Ok(mut access) => {
                                    let payload = access.payload_mut();
                                    let k = ctl.as_ref().map_or(0, |c| c.video_frames()) as usize;
                                    if k == 0 {
                                        ring.clear();
                                    } else {
                                        // Lokaler Ring: das Bild von vor `k` Bildern ausgeben (solange der Ring noch nicht reicht, das älteste).
                                        ring.push_back(g.payload.to_vec());
                                        while ring.len() > k + 1 {
                                            ring.pop_front();
                                        }
                                    }
                                    let src: &[u8] = if k == 0 { &g.payload[..] } else { &ring[0][..] };
                                    let n = payload.len().min(src.len());
                                    payload[..n].copy_from_slice(&src[..n]);
                                    let total = access.total_slices();
                                    if access.commit(total).is_ok() {
                                        flowed.store(true, Ordering::Relaxed);
                                        last_ok = Instant::now();
                                    }
                                }
                                Err(e) => eprintln!("omp-mediaio(rawcopy): open_grain {index} failed: {e}"),
                            }
                            index += 1;
                        }
                        // Der Ringplatz enthält ein NEUERES Grain: der Schreiber ist uns davongelaufen → aufschließen.
                        Ok(g) if g.index > index => index = index.max(now_index().saturating_sub(1)),
                        Ok(_) | Err(mxl::Error::Timeout) => {}
                        // Zu spät (aus dem Ring gefallen): aufschließen.
                        Err(mxl::Error::OutOfRangeTooLate) => index = index.max(now_index().saturating_sub(1)),
                        // Index liegt zu weit in der Zukunft: kurz warten, der Takt holt auf.
                        Err(mxl::Error::OutOfRangeTooEarly) => thread::sleep(Duration::from_millis(2)),
                        Err(_) => thread::sleep(Duration::from_millis(20)),
                    }
                    if last_ok.elapsed() > STALL {
                        dd.store(true, Ordering::Relaxed);
                        on_dead(); // den Aufrufer wecken (kein Nachsehen im Takt auf seiner Seite)
                        break;
                    }
                }
            })
            .map_err(|e| format!("thread: {e}"))?;
        Ok(RawVideoCopy {
            running,
            dead,
            handle: Mutex::new(Some(handle)),
        })
    }

    /// Die Quelle lieferte lange kein Grain mehr — der Aufrufer soll neu aufbauen.
    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed)
    }
}

impl Drop for RawVideoCopy {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(h) = self.handle.lock().expect("lock poisoned").take() {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FMT: VideoFormat = VideoFormat {
        width: 640,
        height: 360,
        rate_num: 25,
        rate_den: 1,
    };

    fn def(media: &str, w: u32, h: u32, rn: u32, rd: u32, interlace: &str) -> String {
        serde_json::json!({"media_type": media, "frame_width": w, "frame_height": h,
            "grain_rate": {"numerator": rn, "denominator": rd}, "interlace_mode": interlace})
        .to_string()
    }

    #[test]
    fn audio_passthrough_checks_format() {
        let t = AudioFormat { sample_rate: 48000, channels: 2 };
        let d = |media: &str, rate: u32, ch: u32| {
            serde_json::json!({"media_type": media, "sample_rate": {"numerator": rate, "denominator": 1}, "channel_count": ch}).to_string()
        };
        assert!(check_audio_passthrough(&d("audio/float32", 48000, 2), t).is_ok());
        assert!(check_audio_passthrough(&d("audio/float32", 44100, 2), t).is_err());
        assert!(check_audio_passthrough(&d("audio/float32", 48000, 6), t).is_err());
        assert!(check_audio_passthrough(&d("audio/L24", 48000, 2), t).is_err());
    }

    #[test]
    fn copy_fragments_handles_ring_wraps() {
        let src_all: Vec<u8> = (0u8..10).collect();
        // Quelle 4+6, Ziel 7+3 — die Bruchstellen liegen verschieden
        let (s1, s2) = src_all.split_at(4);
        let (mut d1, mut d2) = (vec![0u8; 7], vec![0u8; 3]);
        copy_fragments((s1, s2), (&mut d1, &mut d2));
        let got: Vec<u8> = d1.iter().chain(d2.iter()).copied().collect();
        assert_eq!(got, src_all);
        // Ziel kleiner als Quelle: nichts darüber hinaus
        let (mut e1, mut e2) = (vec![0u8; 3], vec![0u8; 2]);
        copy_fragments((s1, s2), (&mut e1, &mut e2));
        assert_eq!(e1.iter().chain(e2.iter()).copied().collect::<Vec<u8>>(), vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn passthrough_only_for_identical_format() {
        assert!(check_passthrough(&def("video/v210", 640, 360, 25, 1, "progressive"), FMT).is_ok());
        // gleichwertige Rate
        assert!(check_passthrough(&def("video/v210", 640, 360, 50, 2, "progressive"), FMT).is_ok());
        for (d, why) in [
            (def("video/v210", 1280, 720, 25, 1, "progressive"), "Größe"),
            (
                def("video/v210", 640, 360, 30000, 1001, "progressive"),
                "Bildrate",
            ),
            (
                def("video/v210", 640, 360, 25, 1, "interlaced_tff"),
                "Zeilensprung",
            ),
            (
                def("video/raw", 640, 360, 25, 1, "progressive"),
                "Medientyp",
            ),
        ] {
            let e = check_passthrough(&d, FMT).expect_err(why);
            assert!(!e.is_empty(), "{why}: {e}");
        }
        assert!(check_passthrough("kein json", FMT).is_err());
    }
}
