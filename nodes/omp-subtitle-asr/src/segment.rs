//! Sprachsegmentierung für die automatische Untertitelung: schneidet den Dauer-Audiostrom (16 kHz, mono) an Sprechpausen in
//! Stücke, die einzeln erkannt werden. Rein rechnerisch (Pegel je 20-ms-Rahmen gegen einen mitlaufenden Grundrauschpegel),
//! ohne Modell — die Spracherkennung selbst sitzt hinter `engine::Engine`.
//!
//! Ein Segment beginnt mit einer kurzen Vorlaufstrecke (damit der Wortanfang nicht fehlt) und endet nach `end_silence_ms`
//! Stille oder spätestens bei `max_segment_ms` (lange Redeflüsse werden hart geteilt, damit die Untertitel nicht minutenlang
//! auf sich warten lassen).

pub const SAMPLE_RATE: u32 = 16_000;
const FRAME: usize = (SAMPLE_RATE as usize) / 50; // 20 ms

#[derive(Debug, Clone)]
pub struct Config {
    /// Stille am Ende, die ein Segment abschließt.
    pub end_silence_ms: u32,
    /// Längstes Segment; danach wird hart geteilt.
    pub max_segment_ms: u32,
    /// Kürzere Sprachstücke (Klicks, Husten) werden verworfen.
    pub min_speech_ms: u32,
    /// Vorlauf vor dem ersten Sprachrahmen.
    pub preroll_ms: u32,
    /// Absolute Untergrenze der Sprachschwelle in dBFS.
    pub min_threshold_db: f32,
    /// Abstand der Sprachschwelle über dem Grundrauschen in dB.
    pub margin_db: f32,
}

impl Default for Config {
    fn default() -> Self {
        Config { end_silence_ms: 600, max_segment_ms: 8_000, min_speech_ms: 250, preroll_ms: 300, min_threshold_db: -48.0, margin_db: 10.0 }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    /// Zeitpunkt des ersten Samples (UTC, ms).
    pub start_ms: i64,
    /// Zeitpunkt nach dem letzten Sample (UTC, ms).
    pub end_ms: i64,
    pub samples: Vec<i16>,
}

pub struct Segmenter {
    cfg: Config,
    pending: Vec<i16>,
    /// Zeitpunkt (UTC, ms) des ersten Samples seit Start, gesetzt beim ersten `push`.
    t0_ms: Option<i64>,
    /// Anzahl der bisher als Rahmen verarbeiteten Samples.
    consumed: u64,
    noise_db: f32,
    preroll: std::collections::VecDeque<Vec<i16>>,
    current: Option<Current>,
}

struct Current {
    start_sample: u64,
    samples: Vec<i16>,
    speech_frames: u32,
    silence_frames: u32,
}

fn level_db(frame: &[i16]) -> f32 {
    let sum: f64 = frame.iter().map(|s| (*s as f64 / 32768.0).powi(2)).sum();
    let rms = (sum / frame.len().max(1) as f64).sqrt();
    if rms <= 1e-9 { -120.0 } else { (20.0 * rms.log10()) as f32 }
}

impl Segmenter {
    pub fn new(cfg: Config) -> Self {
        Segmenter { cfg, pending: Vec::new(), t0_ms: None, consumed: 0, noise_db: -70.0, preroll: Default::default(), current: None }
    }

    fn ms_of(&self, sample: u64) -> i64 {
        self.t0_ms.unwrap_or(0) + (sample * 1000 / SAMPLE_RATE as u64) as i64
    }

    /// Nimmt PCM entgegen (`now_ms` = Ankunftszeit des letzten Samples dieses Stücks) und liefert fertige Segmente.
    pub fn push(&mut self, pcm: &[i16], now_ms: i64) -> Vec<Segment> {
        if self.t0_ms.is_none() {
            self.t0_ms = Some(now_ms - (pcm.len() as i64 * 1000 / SAMPLE_RATE as i64));
        }
        self.pending.extend_from_slice(pcm);
        let mut out = Vec::new();
        while self.pending.len() >= FRAME {
            let frame: Vec<i16> = self.pending.drain(..FRAME).collect();
            self.frame(frame, &mut out);
        }
        out
    }

    fn frame(&mut self, frame: Vec<i16>, out: &mut Vec<Segment>) {
        let db = level_db(&frame);
        let frame_start = self.consumed;
        self.consumed += FRAME as u64;
        let threshold = (self.noise_db + self.cfg.margin_db).max(self.cfg.min_threshold_db);
        let speech = db > threshold;
        // Grundrauschen: schnell nach unten, sehr langsam nach oben; nur außerhalb von Sprache nachführen.
        if !speech || self.current.is_none() {
            let k = if db < self.noise_db { 0.2 } else { 0.01 };
            if !speech {
                self.noise_db += (db - self.noise_db) * k;
            }
        }
        let silence_limit = (self.cfg.end_silence_ms as usize / 20).max(1) as u32;
        let max_frames = (self.cfg.max_segment_ms as usize / 20).max(1);
        match self.current.take() {
            None => {
                if speech {
                    let mut samples: Vec<i16> = self.preroll.drain(..).flatten().collect();
                    let start_sample = frame_start - samples.len() as u64;
                    samples.extend_from_slice(&frame);
                    self.current = Some(Current { start_sample, samples, speech_frames: 1, silence_frames: 0 });
                } else {
                    self.preroll.push_back(frame);
                    while self.preroll.len() > (self.cfg.preroll_ms as usize / 20).max(1) {
                        self.preroll.pop_front();
                    }
                }
            }
            Some(mut cur) => {
                cur.samples.extend_from_slice(&frame);
                if speech {
                    cur.speech_frames += 1;
                    cur.silence_frames = 0;
                } else {
                    cur.silence_frames += 1;
                }
                let too_long = cur.samples.len() / FRAME >= max_frames;
                if cur.silence_frames >= silence_limit || too_long {
                    self.finish(cur, out);
                } else {
                    self.current = Some(cur);
                }
            }
        }
    }

    fn finish(&mut self, mut cur: Current, out: &mut Vec<Segment>) {
        // Stille am Ende bis auf einen kurzen Nachlauf abschneiden.
        let keep_tail = (200 * SAMPLE_RATE as usize / 1000).min(cur.silence_frames as usize * FRAME);
        let drop = (cur.silence_frames as usize * FRAME).saturating_sub(keep_tail);
        cur.samples.truncate(cur.samples.len() - drop);
        if (cur.speech_frames as usize) * 20 < self.cfg.min_speech_ms as usize {
            return;
        }
        let start_ms = self.ms_of(cur.start_sample);
        let end_ms = start_ms + (cur.samples.len() as u64 * 1000 / SAMPLE_RATE as u64) as i64;
        out.push(Segment { start_ms, end_ms, samples: cur.samples });
    }

    /// Schließt ein laufendes Segment ab (Quelle getrennt / Beenden).
    pub fn flush(&mut self) -> Vec<Segment> {
        let mut out = Vec::new();
        if let Some(cur) = self.current.take() {
            self.finish(cur, &mut out);
        }
        self.pending.clear();
        self.preroll.clear();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(ms: usize, amp: f32) -> Vec<i16> {
        (0..ms * 16).map(|i| ((i as f32 * 0.3).sin() * amp * 32767.0) as i16).collect()
    }
    fn silence(ms: usize) -> Vec<i16> {
        vec![0; ms * 16]
    }
    fn run(parts: &[Vec<i16>]) -> Vec<Segment> {
        let mut s = Segmenter::new(Config::default());
        let mut now = 1_000_000;
        let mut out = Vec::new();
        for p in parts {
            for chunk in p.chunks(1600) {
                now += chunk.len() as i64 / 16;
                out.extend(s.push(chunk, now));
            }
        }
        out.extend(s.flush());
        out
    }

    #[test]
    fn silence_gives_no_segment() {
        assert!(run(&[silence(5000)]).is_empty());
    }

    #[test]
    fn speech_between_pauses_is_one_segment_with_preroll_and_short_tail() {
        let segs = run(&[silence(1000), tone(1500, 0.3), silence(2000)]);
        assert_eq!(segs.len(), 1);
        let ms = segs[0].samples.len() / 16;
        assert!((1700..=2200).contains(&ms), "{ms} ms");
        // Beginn ≈ 1000 ms nach Start abzüglich Vorlauf
        let rel = segs[0].start_ms - 1_000_000;
        assert!((600..=800).contains(&rel), "{rel}");
    }

    #[test]
    fn two_phrases_with_a_pause_are_two_segments() {
        let segs = run(&[silence(500), tone(1000, 0.3), silence(900), tone(1000, 0.3), silence(1000)]);
        assert_eq!(segs.len(), 2);
        assert!(segs[1].start_ms > segs[0].end_ms);
    }

    #[test]
    fn continuous_speech_is_split_at_the_maximum_length() {
        let segs = run(&[tone(20_000, 0.3), silence(1000)]);
        assert!(segs.len() >= 3, "{}", segs.len());
        assert!(segs.iter().all(|s| s.samples.len() / 16 <= 8_100));
    }

    #[test]
    fn a_click_is_discarded() {
        assert!(run(&[silence(1000), tone(100, 0.5), silence(2000)]).is_empty());
    }

    #[test]
    fn quiet_background_noise_below_the_floor_is_not_speech() {
        let noise: Vec<i16> = (0..16 * 5000).map(|i| ((i * 7919) % 200) as i16 - 100).collect();
        assert!(run(&[noise]).is_empty());
    }
}
