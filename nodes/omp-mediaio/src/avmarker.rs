//! A/V-Versatzmessung an Marker-Signalen (UMSETZUNG 106.4): Bildflanke und Tonimpuls erkennen und in
//! **Normkonvention** auswerten (EBU R 37 / ITU-R BT.1359, siehe `docs/entwuerfe/ENTWURF-MCR.md` §1):
//!
//! **positiv = Ton eilt dem Bild voraus** (Ton früh), also `Bild-Zeit − Ton-Zeit`.
//!
//! Marker-Signal (Blip/Flash, wie in R 37 beschrieben): ein einzelnes helles Vollbild und gleichzeitig ein Tonimpuls,
//! zum Beispiel einmal je Sekunde. **Eindeutigkeitsgrenze:** `|Versatz| < halbe Impulsperiode` (bei 1 Impuls/s 500 ms);
//! größere Versätze würden dem Nachbarimpuls zugeordnet. Der reine Erkennungsteil hat keine MXL-Abhängigkeit.

/// Tonimpuls-Erkennung: erster Ausschlag über der Schwelle nach mindestens `quiet_samples` Stille.
#[derive(Clone, Debug)]
pub struct TickDetector {
    threshold: f32,
    quiet_samples: u64,
    since_loud: u64,
}

impl TickDetector {
    /// Schwelle 0,05 (≈ −26 dBFS), Ruhe 0,5 s vor dem Impuls.
    pub fn new(sample_rate: u32) -> Self {
        TickDetector { threshold: 0.05, quiet_samples: sample_rate as u64 / 2, since_loud: u64::MAX }
    }
    /// `first_index` = Sample-Index des ersten Werts in `samples`. Gibt die Sample-Indizes der Impulsanfänge zurück.
    pub fn feed(&mut self, first_index: u64, samples: &[f32]) -> Vec<u64> {
        let mut ticks = Vec::new();
        for (i, s) in samples.iter().enumerate() {
            if s.abs() > self.threshold {
                if self.since_loud > self.quiet_samples {
                    ticks.push(first_index + i as u64);
                }
                self.since_loud = 0;
            } else {
                self.since_loud = self.since_loud.saturating_add(1);
            }
        }
        ticks
    }
}

/// Bildflanken dunkel → hell aus `(Zeit in ns, mittlere Helligkeit)`. Schwelle = Mitte zwischen kleinstem und größtem
/// Mittelwert; bei weniger als `min_contrast` Unterschied gibt es **keine** Flanken (kein Marker im Bild).
pub fn video_flips(means: &[(u64, f64)], min_contrast: f64) -> Vec<u64> {
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    for (_, m) in means {
        lo = lo.min(*m);
        hi = hi.max(*m);
    }
    if means.is_empty() || hi - lo < min_contrast {
        return Vec::new();
    }
    let thr = (lo + hi) / 2.0;
    let mut flips = Vec::new();
    let mut prev: Option<bool> = None;
    for (ts, m) in means {
        let bright = *m > thr;
        if prev == Some(false) && bright {
            flips.push(*ts);
        }
        prev = Some(bright);
    }
    flips
}

/// Versatz je Tonimpuls in ms, **Normkonvention (positiv = Ton früh)**: `Bild-Flanke − Ton-Impuls` des nächstliegenden
/// Paars. Paare weiter als `max_abs_ms` auseinander werden verworfen.
pub fn offsets_ms(flip_ns: &[u64], tick_ns: &[u64], max_abs_ms: f64) -> Vec<f64> {
    let mut out = Vec::new();
    for t in tick_ns {
        if let Some(f) = flip_ns.iter().min_by_key(|f| (**f as i64 - *t as i64).abs()) {
            let d = (*f as i64 - *t as i64) as f64 / 1e6;
            if d.abs() < max_abs_ms {
                out.push(d);
            }
        }
    }
    out
}

/// Ergebnis einer Messung am MXL-Eingang.
#[derive(Clone, Debug, Default)]
pub struct Measurement {
    pub offsets_ms: Vec<f64>,
    pub flips: usize,
    pub ticks: usize,
    pub video_grains: usize,
}

/// Liest `secs` Sekunden lang Bild- und Ton-Flow und misst den Versatz der **Etiketten** (Zeit aus Grain- bzw.
/// Sample-Index). Bricht ab, wenn `stop` gesetzt wird.
#[cfg(feature = "mxl")]
pub fn measure(
    inst: &mxl::MxlInstance,
    video_flow: &str,
    audio_flow: &str,
    secs: f64,
    max_abs_ms: f64,
    stop: &std::sync::atomic::AtomicBool,
) -> Result<Measurement, String> {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let rate = |def: &serde_json::Value, key: &str| -> Result<mxl_sys::Rational, String> {
        Ok(mxl_sys::Rational {
            numerator: def[key]["numerator"].as_i64().ok_or_else(|| format!("{key} fehlt"))?,
            denominator: def[key]["denominator"].as_i64().unwrap_or(1),
        })
    };
    let vdef: serde_json::Value = serde_json::from_str(&inst.get_flow_def(video_flow).map_err(|e| format!("{e:?}"))?).map_err(|e| e.to_string())?;
    let adef: serde_json::Value = serde_json::from_str(&inst.get_flow_def(audio_flow).map_err(|e| format!("{e:?}"))?).map_err(|e| e.to_string())?;
    let vrate = rate(&vdef, "grain_rate")?;
    let arate = rate(&adef, "sample_rate")?;
    let vr = inst.create_flow_reader(video_flow).map_err(|e| format!("{e:?}"))?.to_grain_reader().map_err(|e| format!("{e:?}"))?;
    let ar = inst.create_flow_reader(audio_flow).map_err(|e| format!("{e:?}"))?.to_samples_reader().map_err(|e| format!("{e:?}"))?;
    let mut vidx = inst.get_current_index(&vrate);
    let mut aidx = inst.get_current_index(&arate);
    const BATCH: u64 = 480;
    let mut det = TickDetector::new(arate.numerator as u32);
    let mut means: Vec<(u64, f64)> = Vec::new();
    let mut ticks: Vec<u64> = Vec::new();
    let t0 = Instant::now();
    while t0.elapsed().as_secs_f64() < secs && !stop.load(Ordering::Relaxed) {
        let mut idle = true;
        match vr.get_grain_non_blocking(vidx) {
            Ok(g) if g.index == vidx && crate::mxl::grain_invalid(g.flags) => {
                vidx += 1;
                idle = false;
            }
            Ok(g) if g.index == vidx => {
                let p = &g.payload[..g.payload.len().min(1 << 16)];
                let mean = p.iter().map(|&b| b as f64).sum::<f64>() / p.len().max(1) as f64;
                if let Ok(ts) = inst.index_to_timestamp(vidx, &vrate) {
                    means.push((ts, mean));
                }
                vidx += 1;
                idle = false;
            }
            Ok(_) | Err(mxl::Error::OutOfRangeTooLate) => vidx = inst.get_current_index(&vrate),
            Err(_) => {}
        }
        match ar.get_samples_non_blocking(aidx, BATCH as usize) {
            Ok(d) => {
                if let Ok((d1, d2)) = d.channel_data(0) {
                    let samples: Vec<f32> = d1.chunks_exact(4).chain(d2.chunks_exact(4)).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
                    for idx in det.feed(aidx, &samples) {
                        if let Ok(ts) = inst.index_to_timestamp(idx, &arate) {
                            ticks.push(ts);
                        }
                    }
                }
                aidx += BATCH;
                idle = false;
            }
            Err(mxl::Error::OutOfRangeTooLate) => aidx = inst.get_current_index(&arate),
            Err(_) => {}
        }
        if idle {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    let flips = video_flips(&means, 8.0);
    Ok(Measurement { offsets_ms: offsets_ms(&flips, &ticks, max_abs_ms), flips: flips.len(), ticks: ticks.len(), video_grains: means.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_found_at_known_sample_after_silence() {
        let mut d = TickDetector::new(48_000);
        let mut buf = vec![0.0f32; 48_000];
        for s in buf.iter_mut().skip(30_000).take(48) {
            *s = 0.5;
        }
        // in zwei Stücken einspeisen: Erkennung darf nicht von der Stückelung abhängen
        let mut t = d.feed(1_000, &buf[..20_000]);
        t.extend(d.feed(21_000, &buf[20_000..]));
        assert_eq!(t, vec![31_000]);
    }

    #[test]
    fn tone_burst_gives_one_tick_not_many() {
        let mut d = TickDetector::new(48_000);
        let mut buf = vec![0.0f32; 48_000];
        for (i, s) in buf.iter_mut().enumerate().skip(24_000).take(2_000) {
            *s = if i % 2 == 0 { 0.4 } else { -0.4 };
        }
        assert_eq!(d.feed(0, &buf).len(), 1);
    }

    #[test]
    fn flip_at_known_frame() {
        let means: Vec<(u64, f64)> = (0..50u64).map(|i| (i * 40_000_000, if i == 25 { 200.0 } else { 16.0 })).collect();
        assert_eq!(video_flips(&means, 8.0), vec![25 * 40_000_000]);
    }

    #[test]
    fn no_marker_no_flips_no_invented_value() {
        let means: Vec<(u64, f64)> = (0..50u64).map(|i| (i * 40_000_000, 100.0 + (i % 2) as f64)).collect();
        assert!(video_flips(&means, 8.0).is_empty());
        assert!(offsets_ms(&[], &[1_000_000], 500.0).is_empty());
    }

    #[test]
    fn sign_is_norm_convention_positive_means_sound_early() {
        let flip = 1_000_000_000u64;
        // Ton 60 ms früher als das Bild → +60
        let early = offsets_ms(&[flip], &[flip - 60_000_000], 500.0);
        assert!((early[0] - 60.0).abs() < 1e-9);
        // Ton 80 ms später → −80
        let late = offsets_ms(&[flip], &[flip + 80_000_000], 500.0);
        assert!((late[0] + 80.0).abs() < 1e-9);
    }

    #[test]
    fn beyond_half_period_is_discarded() {
        assert!(offsets_ms(&[1_000_000_000], &[1_600_000_000], 500.0).is_empty());
    }
}
