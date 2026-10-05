//! Dynamischer Loudness-Normalizer (EBU R128 / ITU-R BS.1770) für den Verarbeitungsschritt `loudness`.
//!
//! Misst die Lautheit des ankommenden Signals (Short-Term, 3-s-Fenster, K-gewichtet; bis dahin
//! Momentary) und führt einen Zusatz-Gain sanft nach, sodass das Ausgangssignal in Richtung
//! `target_lufs` liegt. Gedacht für Live-/Playout-Betrieb: kein Vorab-Scan der Datei, deshalb ein
//! Regler mit begrenzter Geschwindigkeit statt eines Sprungs.
//!
//! * Absenken geht schneller (`FALL_DB_PER_S`) als Anheben (`RISE_DB_PER_S`) — zu laute Passagen
//!   sollen schnell gebändigt werden, Anheben darf träge sein.
//! * `max_gain_db` begrenzt Absenken und Anheben symmetrisch.
//! * `ceiling_dbfs`: der Gain wird so begrenzt, dass der zuletzt gesehene Sample-Spitzenwert diese
//!   Obergrenze nicht überschreitet (kein Clipping durch Anheben). Das ist KEIN True-Peak-Limiter;
//!   Zwischenspitzen zwischen den Samples erfasst es nicht.
//! * Stille/zu leise (< -70 LUFS, absolutes Gate) hält den Gain.

use ebur128::{EbuR128, Mode};

const FALL_DB_PER_S: f64 = 6.0;
const RISE_DB_PER_S: f64 = 1.0;
/// Absolutes Gate nach BS.1770.
const GATE_LUFS: f64 = -70.0;
/// Der Spitzenwert wird zunächst `PEAK_HOLD_S` voll gehalten (die Obergrenze bleibt zwischen seltenen
/// Spitzen wirksam) und klingt danach mit dieser Halbwertszeit ab.
const PEAK_HOLD_S: f64 = 3.0;
const PEAK_HALF_LIFE_S: f64 = 5.0;
/// Fällt die Momentary-Lautheit so weit unter die Short-Term-Lautheit, läuft das Signal gerade aus
/// (Stille/Pause): dann Gain halten statt das auslaufende Messfenster als „zu leise“ zu deuten.
const DROPOUT_DB: f64 = 15.0;
/// Anheben nur, wenn die Momentary-Lautheit nicht deutlich unter der Short-Term-Lautheit liegt —
/// sonst deutet man ein gerade auslaufendes (mit Stille durchsetztes) Messfenster als „zu leise“.
const RISE_BLOCK_DB: f64 = 3.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoudnessParams {
    pub target_lufs: f64,
    pub max_gain_db: f64,
    pub ceiling_dbfs: f64,
}

impl Default for LoudnessParams {
    fn default() -> Self {
        Self { target_lufs: -23.0, max_gain_db: 12.0, ceiling_dbfs: -1.0 }
    }
}

pub struct Normalizer {
    ebu: EbuR128,
    params: LoudnessParams,
    rate: u32,
    channels: usize,
    gain_db: f64,
    peak_hold: f64,
    /// Sekunden seit der letzten neuen Spitze.
    peak_age: f64,
}

impl Normalizer {
    pub fn new(channels: u32, rate: u32, params: LoudnessParams) -> Result<Self, String> {
        let ebu = EbuR128::new(channels, rate, Mode::M | Mode::S).map_err(|e| format!("ebur128: {e}"))?;
        Ok(Self { ebu, params, rate, channels: channels as usize, gain_db: 0.0, peak_hold: 0.0, peak_age: 0.0 })
    }

    /// Aktueller Zusatz-Gain in dB.
    pub fn gain_db(&self) -> f64 {
        self.gain_db
    }

    /// Verarbeitet einen Block interleaved F32-Samples und liefert den linearen Zusatz-Gain, der ab
    /// jetzt gelten soll (relativ zur unveränderten Eingabe).
    pub fn process(&mut self, interleaved: &[f32]) -> f64 {
        if interleaved.is_empty() || self.channels == 0 {
            return db_to_lin(self.gain_db);
        }
        let secs = interleaved.len() as f64 / self.channels as f64 / f64::from(self.rate);
        let _ = self.ebu.add_frames_f32(interleaved);

        let block_peak = interleaved.iter().fold(0.0f32, |m, v| m.max(v.abs())) as f64;
        self.peak_age += secs;
        if self.peak_age > PEAK_HOLD_S {
            self.peak_hold *= 0.5f64.powf(secs / PEAK_HALF_LIFE_S);
        }
        if block_peak >= self.peak_hold {
            self.peak_hold = block_peak;
            self.peak_age = 0.0;
        }

        let short = self.ebu.loudness_shortterm().ok().filter(|l| l.is_finite() && *l > GATE_LUFS);
        let momentary = self.ebu.loudness_momentary().ok().filter(|l| l.is_finite() && *l > GATE_LUFS);
        // Ausgelaufenes Signal (Momentary weg oder weit unter Short-Term): Gain halten.
        let fading = match (short, momentary) {
            (_, None) => true,
            (Some(s), Some(m)) => m < s - DROPOUT_DB,
            (None, Some(_)) => false,
        };
        let measured = if fading { None } else { short.or(momentary) };
        let rise_blocked = matches!((short, momentary), (Some(s), Some(m)) if m < s - RISE_BLOCK_DB);
        if let Some(l) = measured {
            let mut desired = (self.params.target_lufs - l).clamp(-self.params.max_gain_db, self.params.max_gain_db);
            if self.peak_hold > 0.0 {
                desired = desired.min(self.params.ceiling_dbfs - lin_to_db(self.peak_hold));
            }
            if desired < self.gain_db {
                self.gain_db = desired.max(self.gain_db - FALL_DB_PER_S * secs);
            } else if !rise_blocked {
                self.gain_db = desired.min(self.gain_db + RISE_DB_PER_S * secs);
            }
        }
        // Obergrenze gilt hart, auch beim Halten (kein langsames Nachziehen nach einer neuen Spitze).
        if self.peak_hold > 0.0 {
            self.gain_db = self.gain_db.min(self.params.ceiling_dbfs - lin_to_db(self.peak_hold));
        }
        db_to_lin(self.gain_db)
    }
}

fn db_to_lin(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

fn lin_to_db(lin: f64) -> f64 {
    20.0 * lin.log10()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stereo-Sinus (1 kHz) mit Spitze `dbfs` auf beiden Kanälen: BS.1770 liefert dafür ≈ dbfs LUFS.
    fn sine_block(dbfs: f64, start: usize, frames: usize, rate: u32) -> Vec<f32> {
        let amp = db_to_lin(dbfs);
        (0..frames)
            .flat_map(|i| {
                let v = (amp * (2.0 * std::f64::consts::PI * 1000.0 * (start + i) as f64 / f64::from(rate)).sin()) as f32;
                [v, v]
            })
            .collect()
    }

    fn run(n: &mut Normalizer, dbfs: f64, seconds: usize) -> f64 {
        let rate = 48_000u32;
        let mut gain = 1.0;
        for k in 0..seconds * 100 {
            gain = n.process(&sine_block(dbfs, k * 480, 480, rate));
        }
        gain
    }

    #[test]
    fn loud_signal_is_pulled_down_to_the_target() {
        let mut n = Normalizer::new(2, 48_000, LoudnessParams::default()).unwrap();
        run(&mut n, -20.0, 20);
        // -20 LUFS → Ziel -23: ca. -3 dB
        assert!((n.gain_db() + 3.0).abs() < 0.5, "gain_db = {}", n.gain_db());
    }

    #[test]
    fn quiet_signal_is_raised_but_limited_by_max_gain() {
        let mut n = Normalizer::new(2, 48_000, LoudnessParams { max_gain_db: 6.0, ..Default::default() }).unwrap();
        run(&mut n, -35.0, 30);
        // Wunsch +12 dB, begrenzt auf +6
        assert!((n.gain_db() - 6.0).abs() < 0.2, "gain_db = {}", n.gain_db());
    }

    #[test]
    fn peak_ceiling_stops_a_boost_that_would_clip() {
        // Leises Signal (≈ -30 LUFS) mit regelmäßigen Vollaussteuerungs-Spitzen: Anheben um +7 dB würde clippen.
        let rate = 48_000u32;
        let mut n = Normalizer::new(2, rate, LoudnessParams::default()).unwrap();
        for k in 0..3000 {
            let mut b = sine_block(-30.0, k * 480, 480, rate);
            if k % 50 == 0 {
                b[0] = 1.0;
            }
            n.process(&b);
        }
        assert!(n.gain_db() <= -0.9, "Gain {} dB würde die Spitzen über die Obergrenze heben", n.gain_db());
    }

    #[test]
    fn silence_holds_the_gain() {
        let mut n = Normalizer::new(2, 48_000, LoudnessParams::default()).unwrap();
        run(&mut n, -20.0, 15);
        let before = n.gain_db();
        for _ in 0..500 {
            n.process(&vec![0.0f32; 960]);
        }
        assert!((n.gain_db() - before).abs() < 0.3, "Gain wanderte von {before} auf {}", n.gain_db());
    }

    #[test]
    fn gain_moves_gradually_not_in_a_jump() {
        let mut n = Normalizer::new(2, 48_000, LoudnessParams::default()).unwrap();
        run(&mut n, -20.0, 4);
        let a = n.gain_db();
        n.process(&sine_block(-20.0, 0, 480, 48_000));
        assert!((n.gain_db() - a).abs() < 0.2, "Sprung von {a} auf {}", n.gain_db());
    }
}
