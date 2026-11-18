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
/// angelegt; der Aufrufer baut dann neu auf).
const STALL: Duration = Duration::from_secs(3);

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
                while run.load(Ordering::Relaxed) {
                    match samples_reader.get_samples_non_blocking(index, AUDIO_BATCH) {
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
                            // Ein Batch dauert 10 ms: bis kurz davor schlafen statt jede Millisekunde nachzusehen.
                            thread::sleep(Duration::from_millis(6));
                        }
                        Err(mxl::Error::OutOfRangeTooEarly) => thread::sleep(Duration::from_millis(1)),
                        Err(mxl::Error::OutOfRangeTooLate) => index = index.max(now_index().saturating_sub(batch * 2)),
                        Err(_) => thread::sleep(Duration::from_millis(20)),
                    }
                    if last_ok.elapsed() > STALL {
                        dd.store(true, Ordering::Relaxed);
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
                let period_us = 1_000_000u64 * target.rate_den.max(1) as u64 / target.rate_num.max(1) as u64;
                let mut index = now_index().saturating_sub(2);
                let mut last_ok = Instant::now();
                while run.load(Ordering::Relaxed) {
                    match grain_reader.get_grain_non_blocking(index) {
                        Ok(g) if g.index == index && g.payload.len() == g.total_size => {
                            match grain_writer.open_grain(index) {
                                Ok(mut access) => {
                                    let payload = access.payload_mut();
                                    let n = payload.len().min(g.payload.len());
                                    payload[..n].copy_from_slice(&g.payload[..n]);
                                    let total = access.total_slices();
                                    if access.commit(total).is_ok() {
                                        flowed.store(true, Ordering::Relaxed);
                                        last_ok = Instant::now();
                                    }
                                }
                                Err(e) => eprintln!(
                                    "omp-mediaio(rawcopy): open_grain {index} failed: {e}"
                                ),
                            }
                            index += 1;
                            // Das nächste Grain kommt frühestens in einer Bildperiode: bis kurz davor schlafen statt
                            // alle 2 ms nachzusehen (5/8 Periode, den Rest übernimmt das kurze Abfragen unten).
                            thread::sleep(Duration::from_micros(period_us * 5 / 8));
                        }
                        // Der Ringplatz enthält ein NEUERES Grain: der Schreiber ist uns davongelaufen → aufschließen.
                        Ok(g) if g.index > index => {
                            index = index.max(now_index().saturating_sub(1))
                        }
                        // Noch nicht (vollständig) geschrieben: kurz warten, gleiches Grain erneut.
                        Ok(_) | Err(mxl::Error::OutOfRangeTooEarly) => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        // Zu spät (aus dem Ring gefallen): aufschließen.
                        Err(mxl::Error::OutOfRangeTooLate) => {
                            index = index.max(now_index().saturating_sub(1))
                        }
                        Err(_) => thread::sleep(Duration::from_millis(20)),
                    }
                    if last_ok.elapsed() > STALL {
                        dd.store(true, Ordering::Relaxed);
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
