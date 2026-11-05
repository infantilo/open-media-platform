//! Reine Mischlogik von `omp-segue-player` (Radio, Kapitel 89/RB3): N Stimmen werden **sample-genau** auf einer gemeinsamen
//! Ausgabeuhr summiert. Ohne GStreamer/MXL und vollständig testbar.
//!
//! **Zeit:** Die Ausgabeuhr zählt Frames (`n`, 48 kHz). Jede Stimme trägt ihren Startframe `start_n` auf dieser Uhr; die Umrechnung
//! von TAI-Zeitpunkten auf `n` macht der Aufrufer (`io.rs`/`main.rs`). Eine Stimme beginnt exakt im Frame `start_n`, auch mitten
//! in einem Block.
//!
//! **Hüllkurven:** Jede Stimme hat einen Grundpegel und eine Folge von Rampen (`Ramp`: ab Frame `at`, Länge `len`, Pegel `from` → `to`,
//! Kurve). Ein *steigender* Verlauf folgt der Kurve vorwärts, ein *fallender* spiegelt sie (Kosinus: Ein = sin, Aus = cos — gleiche
//! Leistung beim Überblenden). Eine Rampe auf 0 mit `stop` beendet die Stimme.

use std::sync::Arc;

pub const SR: u32 = 48_000;
pub const CH: usize = 2;
pub const BLOCK: usize = 480;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Curve {
    Linear,
    /// Gleichleistung (sin/cos).
    Cosine,
    /// Logarithmisch: −60 dB → 0 dB (fühlt sich bei Ausblendungen natürlich an).
    Log,
}

impl Curve {
    pub fn parse(s: &str) -> Option<Curve> {
        match s {
            "linear" => Some(Curve::Linear),
            "cosine" | "equal-power" => Some(Curve::Cosine),
            "log" => Some(Curve::Log),
            _ => None,
        }
    }
    /// Anstieg 0 → 1 über x ∈ [0, 1].
    fn rise(self, x: f32) -> f32 {
        let x = x.clamp(0.0, 1.0);
        match self {
            Curve::Linear => x,
            Curve::Cosine => (x * std::f32::consts::FRAC_PI_2).sin(),
            Curve::Log => {
                if x <= 0.0 {
                    0.0
                } else {
                    10f32.powf((x - 1.0) * 3.0) // −60 dB … 0 dB
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Ramp {
    /// Startframe auf der Ausgabeuhr.
    pub at: i64,
    pub len: i64,
    pub from: f32,
    pub to: f32,
    pub curve: Curve,
    /// Nach Abschluss die Stimme beenden (Ausblenden/Stopp).
    pub stop: bool,
}

impl Ramp {
    /// Pegel im Frame `n` (nur für `at <= n < at + len` sinnvoll).
    fn level(&self, n: i64) -> f32 {
        if self.len <= 0 {
            return self.to;
        }
        let x = ((n - self.at) as f32 / self.len as f32).clamp(0.0, 1.0);
        if self.to >= self.from {
            self.from + (self.to - self.from) * self.curve.rise(x)
        } else {
            self.to + (self.from - self.to) * self.curve.rise(1.0 - x)
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VoiceState {
    Pending,
    Playing,
    Ended,
}

pub struct Voice {
    pub id: u64,
    pub samples: Arc<Vec<f32>>,
    /// Beginn der Wiedergabe innerhalb der Datei (Frames).
    pub offset: usize,
    pub start_n: i64,
    pub state: VoiceState,
    /// Frames, die seit dem Start gespielt wurden.
    pub played: usize,
    /// Grundpegel (linear, z. B. aus Lautheitsmetadaten).
    pub gain: f32,
    pub ramps: Vec<Ramp>,
    /// Pegel nach der letzten abgeschlossenen Rampe.
    level: f32,
}

impl Voice {
    pub fn new(id: u64, samples: Arc<Vec<f32>>, offset_frames: usize, start_n: i64, gain: f32) -> Voice {
        Voice { id, samples, offset: offset_frames, start_n, state: VoiceState::Pending, played: 0, gain, ramps: Vec::new(), level: 1.0 }
    }

    pub fn len_frames(&self) -> usize {
        self.samples.len() / CH
    }

    /// Position in der Datei (Frames).
    pub fn position(&self) -> usize {
        self.offset + self.played
    }

    /// Pegel (ohne Grundpegel) im Frame `n` nach den Rampen.
    fn env(&mut self, n: i64) -> (f32, bool) {
        // abgeschlossene Rampen abstreifen (Pegel übernehmen)
        while let Some(r) = self.ramps.first() {
            if n >= r.at + r.len {
                self.level = r.to;
                let stop = r.stop;
                self.ramps.remove(0);
                if stop {
                    return (self.level, true);
                }
            } else {
                break;
            }
        }
        match self.ramps.first() {
            Some(r) if n >= r.at => (r.level(n), false),
            _ => (self.level, false),
        }
    }
}

#[derive(Default)]
pub struct Mixer {
    pub voices: Vec<Voice>,
    next_id: u64,
    pub max_voices: usize,
}

impl Mixer {
    pub fn new(max_voices: usize) -> Mixer {
        Mixer { voices: Vec::new(), next_id: 1, max_voices }
    }

    /// Neue Stimme; `None`, wenn alle Stimmen belegt sind.
    pub fn add(&mut self, samples: Arc<Vec<f32>>, offset_frames: usize, start_n: i64, gain: f32) -> Option<u64> {
        self.voices.retain(|v| v.state != VoiceState::Ended);
        if self.voices.len() >= self.max_voices {
            return None;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.voices.push(Voice::new(id, samples, offset_frames, start_n, gain));
        Some(id)
    }

    pub fn voice_mut(&mut self, id: u64) -> Option<&mut Voice> {
        self.voices.iter_mut().find(|v| v.id == id && v.state != VoiceState::Ended)
    }

    /// Einblenden ab dem Start der Stimme.
    pub fn fade_in(&mut self, id: u64, len: i64, curve: Curve) -> bool {
        let Some(v) = self.voice_mut(id) else { return false };
        let at = v.start_n;
        v.ramps.insert(0, Ramp { at, len, from: 0.0, to: 1.0, curve, stop: false });
        true
    }

    /// Ausblenden ab Frame `at` und danach beenden.
    pub fn stop(&mut self, id: u64, at: i64, len: i64, curve: Curve) -> bool {
        let Some(v) = self.voice_mut(id) else { return false };
        // frühere, noch nicht begonnene Stopp-Rampen ersetzen
        v.ramps.retain(|r| !r.stop);
        v.ramps.push(Ramp { at, len: len.max(0), from: 1.0, to: 0.0, curve, stop: true });
        true
    }

    /// Pegel ab Frame `at` über `len` Frames auf `to` (linear, relativ zum Grundpegel) fahren.
    pub fn fade_to(&mut self, id: u64, at: i64, len: i64, to: f32, curve: Curve) -> bool {
        let Some(v) = self.voice_mut(id) else { return false };
        let from = v.level_at(at);
        v.ramps.retain(|r| r.stop || r.at < at);
        v.ramps.push(Ramp { at, len: len.max(0), from, to, curve, stop: false });
        v.ramps.sort_by_key(|r| r.at);
        true
    }

    /// Einen Block ab Frame `block_n` in `out` (interleaved Stereo, wird überschrieben) rechnen.
    pub fn render(&mut self, block_n: i64, out: &mut [f32]) {
        out.fill(0.0);
        let frames = out.len() / CH;
        for v in &mut self.voices {
            if v.state == VoiceState::Ended {
                continue;
            }
            if v.state == VoiceState::Pending && v.start_n >= block_n + frames as i64 {
                continue;
            }
            let total = v.len_frames();
            for i in 0..frames {
                let n = block_n + i as i64;
                if v.state == VoiceState::Pending {
                    if n < v.start_n {
                        continue;
                    }
                    v.state = VoiceState::Playing;
                }
                let pos = v.offset + v.played;
                if pos >= total {
                    v.state = VoiceState::Ended;
                    break;
                }
                let (level, stop) = v.env(n);
                if stop {
                    v.state = VoiceState::Ended;
                    break;
                }
                let g = v.gain * level;
                out[i * CH] += v.samples[pos * CH] * g;
                out[i * CH + 1] += v.samples[pos * CH + 1] * g;
                v.played += 1;
            }
        }
    }
}

impl Voice {
    /// Hüllkurvenpegel, der im Frame `n` gälte (für Rampen, die dort ansetzen).
    fn level_at(&self, n: i64) -> f32 {
        let mut level = self.level;
        for r in &self.ramps {
            if n >= r.at + r.len {
                level = r.to;
            } else if n >= r.at {
                return r.level(n);
            } else {
                break;
            }
        }
        level
    }
}

/// dB → linear.
pub fn db_to_gain(db: f64) -> f32 {
    10f64.powf(db / 20.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Datei aus Konstante `v` (links) / `-v` (rechts), `frames` lang.
    fn tone(frames: usize, v: f32) -> Arc<Vec<f32>> {
        let mut d = Vec::with_capacity(frames * CH);
        for _ in 0..frames {
            d.push(v);
            d.push(-v);
        }
        Arc::new(d)
    }

    /// Datei, deren Frame k den Wert k trägt (Position ablesbar).
    fn ramp(frames: usize) -> Arc<Vec<f32>> {
        Arc::new((0..frames).flat_map(|k| [k as f32, -(k as f32)]).collect())
    }

    #[test]
    fn voice_starts_in_exactly_the_requested_frame_even_mid_block() {
        let mut m = Mixer::new(4);
        m.add(tone(2000, 0.5), 0, 1000 + 137, 1.0).unwrap();
        let mut out = vec![0.0f32; BLOCK * CH];
        m.render(1000, &mut out);
        for i in 0..137 {
            assert_eq!(out[i * CH], 0.0, "Frame {i} vor dem Start muss still sein");
        }
        assert_eq!(out[137 * CH], 0.5, "Startframe");
        assert_eq!(out[137 * CH + 1], -0.5);
        assert_eq!(out[(BLOCK - 1) * CH], 0.5);
    }

    #[test]
    fn start_in_a_later_block_and_offset_into_the_file() {
        let mut m = Mixer::new(4);
        m.add(ramp(10_000), 500, 3 * BLOCK as i64 + 7, 1.0).unwrap();
        let mut out = vec![0.0f32; BLOCK * CH];
        for b in 0..3 {
            m.render(b * BLOCK as i64, &mut out);
            assert!(out.iter().all(|v| *v == 0.0), "Block {b} noch still");
        }
        m.render(3 * BLOCK as i64, &mut out);
        assert_eq!(out[6 * CH], 0.0);
        assert_eq!(out[7 * CH], 500.0, "erstes gespieltes Sample = Dateiposition 500");
        assert_eq!(out[8 * CH], 501.0);
    }

    #[test]
    fn two_voices_sum_and_gain_applies() {
        let mut m = Mixer::new(4);
        m.add(tone(1000, 0.25), 0, 0, 1.0).unwrap();
        m.add(tone(1000, 0.5), 0, 0, db_to_gain(-6.0206)).unwrap(); // ≈ 0,5
        let mut out = vec![0.0f32; BLOCK * CH];
        m.render(0, &mut out);
        assert!((out[0] - 0.5).abs() < 1e-4, "0,25 + 0,5·0,5 = 0,5, war {}", out[0]);
    }

    #[test]
    fn fade_in_and_fade_out_curves_are_exact_and_equal_power() {
        // Cosinus: Ein = sin, Aus = cos → Leistung über die ganze Überblendung konstant (sin² + cos² = 1)
        let mut m = Mixer::new(4);
        let a = m.add(tone(10_000, 1.0), 0, 0, 1.0).unwrap();
        let b = m.add(tone(10_000, 1.0), 0, 0, 1.0).unwrap();
        m.stop(a, 0, 960, Curve::Cosine);
        m.fade_in(b, 960, Curve::Cosine);
        let mut out = vec![0.0f32; 960 * CH];
        // zwei Blöcke à 480
        let mut buf = vec![0.0f32; BLOCK * CH];
        m.render(0, &mut buf);
        out[..BLOCK * CH].copy_from_slice(&buf);
        m.render(BLOCK as i64, &mut buf);
        out[BLOCK * CH..].copy_from_slice(&buf);
        // einzelne Stimmen getrennt nachrechnen: Summe der Pegel a (cos) + b (sin) bei x = i/960
        for i in [0usize, 100, 480, 700, 959] {
            let x = i as f32 / 960.0;
            let want = (x * std::f32::consts::FRAC_PI_2).cos() + (x * std::f32::consts::FRAC_PI_2).sin();
            assert!((out[i * CH] - want).abs() < 1e-4, "Frame {i}: {} statt {}", out[i * CH], want);
        }
        // nach der Rampe: a beendet, b voll
        m.render(2 * BLOCK as i64, &mut buf);
        assert!((buf[0] - 1.0).abs() < 1e-4);
        assert_eq!(m.voices.iter().filter(|v| v.state == VoiceState::Ended).count(), 1);
    }

    #[test]
    fn linear_and_log_fades() {
        let mut m = Mixer::new(2);
        let a = m.add(tone(5000, 1.0), 0, 0, 1.0).unwrap();
        m.stop(a, 0, 480, Curve::Linear);
        let mut buf = vec![0.0f32; BLOCK * CH];
        m.render(0, &mut buf);
        assert!((buf[0] - 1.0).abs() < 1e-6);
        assert!((buf[240 * CH] - 0.5).abs() < 1e-4, "Mitte der linearen Ausblendung {}", buf[240 * CH]);
        let mut m = Mixer::new(2);
        let a = m.add(tone(5000, 1.0), 0, 0, 1.0).unwrap();
        m.stop(a, 0, 480, Curve::Log);
        m.render(0, &mut buf);
        // −60 dB ≈ 0,001 am Ende, −30 dB ≈ 0,0316 in der Mitte (Spiegelung des Anstiegs)
        assert!((buf[240 * CH] - 0.0316).abs() < 0.003, "log Mitte {}", buf[240 * CH]);
        assert!(buf[479 * CH] < 0.0025);
    }

    #[test]
    fn stop_ends_the_voice_and_a_ended_voice_frees_the_slot() {
        let mut m = Mixer::new(1);
        let a = m.add(tone(5000, 1.0), 0, 0, 1.0).unwrap();
        assert!(m.add(tone(10, 1.0), 0, 0, 1.0).is_none(), "alle Stimmen belegt");
        m.stop(a, 100, 0, Curve::Linear); // hart bei Frame 100
        let mut buf = vec![0.0f32; BLOCK * CH];
        m.render(0, &mut buf);
        assert_eq!(buf[99 * CH], 1.0);
        assert_eq!(buf[100 * CH], 0.0);
        assert!(m.add(tone(10, 1.0), 0, 0, 1.0).is_some(), "Platz wieder frei");
    }

    #[test]
    fn voice_ends_at_the_file_end() {
        let mut m = Mixer::new(2);
        let a = m.add(tone(600, 1.0), 0, 0, 1.0).unwrap();
        let mut buf = vec![0.0f32; BLOCK * CH];
        m.render(0, &mut buf);
        m.render(BLOCK as i64, &mut buf);
        assert_eq!(buf[119 * CH], 1.0);
        assert_eq!(buf[120 * CH], 0.0);
        assert!(m.voices.iter().any(|v| v.id == a && v.state == VoiceState::Ended));
    }

    #[test]
    fn fade_to_changes_level_without_restart() {
        let mut m = Mixer::new(2);
        let a = m.add(tone(5000, 1.0), 0, 0, 1.0).unwrap();
        m.fade_to(a, 100, 100, 0.5, Curve::Linear);
        let mut buf = vec![0.0f32; BLOCK * CH];
        m.render(0, &mut buf);
        assert_eq!(buf[99 * CH], 1.0);
        assert!((buf[150 * CH] - 0.75).abs() < 1e-4);
        assert!((buf[250 * CH] - 0.5).abs() < 1e-6, "danach bleibt der Pegel 0,5");
        m.render(BLOCK as i64, &mut buf);
        assert!((buf[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn four_voices_overlap_without_artifacts() {
        let mut m = Mixer::new(4);
        for k in 0..4 {
            m.add(tone(48_000, 0.1), 0, (k * 4800) as i64, 1.0).unwrap();
        }
        let mut buf = vec![0.0f32; BLOCK * CH];
        let mut peak = 0.0f32;
        for b in 0..120 {
            m.render(b * BLOCK as i64, &mut buf);
            peak = buf.iter().fold(peak, |p, v| p.max(v.abs()));
        }
        assert!((peak - 0.4).abs() < 1e-4, "vier Stimmen à 0,1 ergeben höchstens 0,4: {peak}");
    }
}
