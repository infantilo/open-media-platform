//! Misch-Kern des Studio-Mischers (rein, ohne E/A): Eingangsstreifen (Stereo, aus Mono wird L=R) → Sends → Busse (Stereo).
//!
//! Gewollt klein: Pegel, Mute, Send-Matrix (daraus ergeben sich Mix-minus und In-Ear-Busse), Bus-Pegel/-Mute, Spitzenpegel.
//! Kein EQ, keine Dynamik — jede Stufe kostet Latenz oder Rechenzeit, und dieser Pfad lebt von beidem so wenig wie möglich.
//! Alle Änderungen werden über **einen Block** linear ausgeblendet (kein Knacken, kein Zipper-Rauschen).
//!
//! Die Zielwerte liegen als Atomics in [`Shared`]; der Echtzeit-Thread liest sie am Blockanfang ohne Sperre.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

pub const MAX_STRIPS: usize = 32;
pub const MAX_BUSES: usize = 16;

/// dB → linear; −90 dB und darunter ist aus (0).
pub fn db_to_lin(db: f64) -> f32 {
    if db <= -90.0 { 0.0 } else { 10f64.powf(db / 20.0) as f32 }
}

/// linear → dB (Anzeige), −90 für Stille.
pub fn lin_to_db(lin: f32) -> f64 {
    if lin <= 0.000_031_6 { -90.0 } else { (20.0 * (lin as f64).log10() * 10.0).round() / 10.0 }
}

fn af(v: f32) -> AtomicU32 {
    AtomicU32::new(v.to_bits())
}

/// Vom Steuerthread geschriebene Zielwerte und vom Echtzeit-Thread geschriebene Pegel.
pub struct Shared {
    pub strips: usize,
    pub buses: usize,
    pub strip_gain: Vec<AtomicU32>,
    pub strip_mute: Vec<AtomicBool>,
    /// Send-Pegel `[strip * buses + bus]`, linear.
    pub send: Vec<AtomicU32>,
    pub bus_gain: Vec<AtomicU32>,
    pub bus_mute: Vec<AtomicBool>,
    pub strip_peak: Vec<AtomicU32>,
    pub bus_peak: Vec<AtomicU32>,
}

impl Shared {
    pub fn new(strips: usize, buses: usize) -> Self {
        assert!((1..=MAX_STRIPS).contains(&strips) && (1..=MAX_BUSES).contains(&buses));
        Self {
            strips,
            buses,
            strip_gain: (0..strips).map(|_| af(1.0)).collect(),
            strip_mute: (0..strips).map(|_| AtomicBool::new(false)).collect(),
            // Standard: jeder Streifen nur auf Bus 1 (Hauptmix)
            send: (0..strips * buses).map(|i| af(if i % buses == 0 { 1.0 } else { 0.0 })).collect(),
            bus_gain: (0..buses).map(|_| af(1.0)).collect(),
            bus_mute: (0..buses).map(|_| AtomicBool::new(false)).collect(),
            strip_peak: (0..strips).map(|_| af(0.0)).collect(),
            bus_peak: (0..buses).map(|_| af(0.0)).collect(),
        }
    }

    pub fn set_send(&self, strip: usize, bus: usize, lin: f32) {
        self.send[strip * self.buses + bus].store(lin.to_bits(), Ordering::Relaxed);
    }

    pub fn peak_of(a: &AtomicU32) -> f32 {
        f32::from_bits(a.load(Ordering::Relaxed))
    }
}

/// Ein Eingangsblock (Stereo, planar). `present = false` → Stille (Quelle fehlt oder verstummt).
pub struct StripIn<'a> {
    pub l: &'a [f32],
    pub r: &'a [f32],
    pub present: bool,
}

pub struct Engine {
    block: usize,
    shared: std::sync::Arc<Shared>,
    cur_strip_gain: Vec<f32>,
    cur_send: Vec<f32>,
    cur_bus_gain: Vec<f32>,
    tmp_l: Vec<f32>,
    tmp_r: Vec<f32>,
    ramp: Vec<f32>,
}

/// Abklingfaktor der Spitzenanzeige je Block (≈ 300 ms bei 1-ms-Blöcken).
fn peak_decay(block: usize) -> f32 {
    0.9967f32.powf(block as f32 / 48.0)
}

impl Engine {
    pub fn new(block: usize, shared: std::sync::Arc<Shared>) -> Self {
        let (ns, nb) = (shared.strips, shared.buses);
        Self {
            block,
            cur_strip_gain: (0..ns).map(|i| if shared.strip_mute[i].load(Ordering::Relaxed) { 0.0 } else { f32::from_bits(shared.strip_gain[i].load(Ordering::Relaxed)) }).collect(),
            cur_send: (0..ns * nb).map(|i| f32::from_bits(shared.send[i].load(Ordering::Relaxed))).collect(),
            cur_bus_gain: (0..nb).map(|i| if shared.bus_mute[i].load(Ordering::Relaxed) { 0.0 } else { f32::from_bits(shared.bus_gain[i].load(Ordering::Relaxed)) }).collect(),
            shared,
            tmp_l: vec![0.0; block],
            tmp_r: vec![0.0; block],
            ramp: (0..block).map(|i| (i + 1) as f32 / block as f32).collect(),
        }
    }

    /// Mischt einen Block. `out_l/out_r[bus]` werden überschrieben (Länge `block`).
    pub fn process(&mut self, strips: &[StripIn<'_>], out_l: &mut [Vec<f32>], out_r: &mut [Vec<f32>]) {
        let (ns, nb, n) = (self.shared.strips, self.shared.buses, self.block);
        for b in 0..nb {
            out_l[b][..n].fill(0.0);
            out_r[b][..n].fill(0.0);
        }
        let decay = peak_decay(n);
        for s in 0..ns {
            let target_g = if self.shared.strip_mute[s].load(Ordering::Relaxed) { 0.0 } else { f32::from_bits(self.shared.strip_gain[s].load(Ordering::Relaxed)) };
            let g0 = self.cur_strip_gain[s];
            let input = strips.get(s);
            let mut peak = 0f32;
            match input {
                Some(inp) if inp.present && inp.l.len() >= n && inp.r.len() >= n => {
                    for i in 0..n {
                        let g = g0 + (target_g - g0) * self.ramp[i];
                        self.tmp_l[i] = inp.l[i] * g;
                        self.tmp_r[i] = inp.r[i] * g;
                        peak = peak.max(self.tmp_l[i].abs()).max(self.tmp_r[i].abs());
                    }
                }
                _ => {
                    self.tmp_l.fill(0.0);
                    self.tmp_r.fill(0.0);
                }
            }
            self.cur_strip_gain[s] = target_g;
            let old = f32::from_bits(self.shared.strip_peak[s].load(Ordering::Relaxed)) * decay;
            self.shared.strip_peak[s].store(peak.max(old).to_bits(), Ordering::Relaxed);
            for b in 0..nb {
                let idx = s * nb + b;
                let t = f32::from_bits(self.shared.send[idx].load(Ordering::Relaxed));
                let c = self.cur_send[idx];
                if c == 0.0 && t == 0.0 {
                    continue;
                }
                for i in 0..n {
                    let g = c + (t - c) * self.ramp[i];
                    out_l[b][i] += self.tmp_l[i] * g;
                    out_r[b][i] += self.tmp_r[i] * g;
                }
                self.cur_send[idx] = t;
            }
        }
        for b in 0..nb {
            let target = if self.shared.bus_mute[b].load(Ordering::Relaxed) { 0.0 } else { f32::from_bits(self.shared.bus_gain[b].load(Ordering::Relaxed)) };
            let g0 = self.cur_bus_gain[b];
            let mut peak = 0f32;
            for i in 0..n {
                let g = g0 + (target - g0) * self.ramp[i];
                out_l[b][i] *= g;
                out_r[b][i] *= g;
                peak = peak.max(out_l[b][i].abs()).max(out_r[b][i].abs());
            }
            self.cur_bus_gain[b] = target;
            let old = f32::from_bits(self.shared.bus_peak[b].load(Ordering::Relaxed)) * decay;
            self.shared.bus_peak[b].store(peak.max(old).to_bits(), Ordering::Relaxed);
        }
    }
}

/// Quelle eines Streifens (Zeichenkette `off`, `mxl`, `alsa:K`, `alsa:K-L`, `aes:K`, `aes:K-L`; Kanäle ab 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Off,
    /// Über den NMOS-Empfänger bzw. `setFlow` des Streifens verbundener MXL-Flow.
    Mxl,
    Alsa { first: usize, stereo: bool },
    Aes { first: usize, stereo: bool },
}

impl Source {
    pub fn parse(s: &str) -> Option<Source> {
        let s = s.trim().to_ascii_lowercase();
        match s.as_str() {
            "" | "off" => return Some(Source::Off),
            "mxl" => return Some(Source::Mxl),
            _ => {}
        }
        let (kind, rest) = s.split_once(':')?;
        let (first, stereo) = match rest.split_once('-') {
            Some((a, b)) => {
                let (a, b): (usize, usize) = (a.parse().ok()?, b.parse().ok()?);
                if b != a + 1 {
                    return None; // nur benachbarte Paare
                }
                (a, true)
            }
            None => (rest.parse().ok()?, false),
        };
        if first == 0 || first > 64 {
            return None;
        }
        match kind {
            "alsa" => Some(Source::Alsa { first, stereo }),
            "aes" => Some(Source::Aes { first, stereo }),
            _ => None,
        }
    }

    pub fn to_text(self) -> String {
        match self {
            Source::Off => "off".into(),
            Source::Mxl => "mxl".into(),
            Source::Alsa { first, stereo } => if stereo { format!("alsa:{first}-{}", first + 1) } else { format!("alsa:{first}") },
            Source::Aes { first, stereo } => if stereo { format!("aes:{first}-{}", first + 1) } else { format!("aes:{first}") },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn run(e: &mut Engine, ins: &[(Vec<f32>, Vec<f32>)], nb: usize, n: usize) -> (Vec<Vec<f32>>, Vec<Vec<f32>>) {
        let strips: Vec<StripIn> = ins.iter().map(|(l, r)| StripIn { l, r, present: true }).collect();
        let mut ol = vec![vec![0.0; n]; nb];
        let mut or = vec![vec![0.0; n]; nb];
        e.process(&strips, &mut ol, &mut or);
        (ol, or)
    }

    #[test]
    fn unity_goes_to_bus_one_only() {
        let sh = Arc::new(Shared::new(2, 3));
        let mut e = Engine::new(48, sh);
        let ins = vec![(vec![0.5; 48], vec![0.25; 48]), (vec![0.1; 48], vec![0.1; 48])];
        let (l, r) = run(&mut e, &ins, 3, 48);
        assert!((l[0][47] - 0.6).abs() < 1e-6 && (r[0][47] - 0.35).abs() < 1e-6, "{} {}", l[0][47], r[0][47]);
        assert!(l[1].iter().chain(l[2].iter()).all(|v| *v == 0.0));
    }

    #[test]
    fn mix_minus_excludes_own_strip() {
        // Gast = Streifen 1: Bus 2 (Rückweg) enthält alle außer dem Gast
        let sh = Arc::new(Shared::new(3, 2));
        for s in 0..3 {
            sh.set_send(s, 1, if s == 1 { 0.0 } else { 1.0 });
        }
        let mut e = Engine::new(48, sh);
        let ins = vec![(vec![0.1; 48], vec![0.1; 48]), (vec![0.4; 48], vec![0.4; 48]), (vec![0.2; 48], vec![0.2; 48])];
        let (l, _) = run(&mut e, &ins, 2, 48);
        assert!((l[1][47] - 0.3).abs() < 1e-6, "Mix-minus = 0,1 + 0,2, nicht der Gast: {}", l[1][47]);
        assert!((l[0][47] - 0.7).abs() < 1e-6);
    }

    #[test]
    fn gain_change_is_ramped_over_one_block() {
        let sh = Arc::new(Shared::new(1, 1));
        let mut e = Engine::new(48, sh.clone());
        let ins = vec![(vec![1.0; 48], vec![1.0; 48])];
        run(&mut e, &ins, 1, 48);
        sh.strip_mute[0].store(true, Ordering::Relaxed);
        let (l, _) = run(&mut e, &ins, 1, 48);
        assert!(l[0][0] > 0.9 && l[0][47] == 0.0, "Ausblenden statt Sprung: {} .. {}", l[0][0], l[0][47]);
        assert!(l[0].windows(2).all(|w| w[1] <= w[0]), "monoton fallend");
        let (l2, _) = run(&mut e, &ins, 1, 48);
        assert!(l2[0].iter().all(|v| *v == 0.0));
    }

    #[test]
    fn absent_strip_is_silent_and_peaks_decay() {
        let sh = Arc::new(Shared::new(1, 1));
        let mut e = Engine::new(48, sh.clone());
        let ins = vec![(vec![0.8; 48], vec![0.8; 48])];
        run(&mut e, &ins, 1, 48);
        let p1 = Shared::peak_of(&sh.strip_peak[0]);
        assert!((p1 - 0.8).abs() < 1e-6);
        let silent = [StripIn { l: &[], r: &[], present: false }];
        let mut ol = vec![vec![0.0; 48]];
        let mut or = vec![vec![0.0; 48]];
        e.process(&silent, &mut ol, &mut or);
        assert!(ol[0].iter().all(|v| *v == 0.0));
        let p2 = Shared::peak_of(&sh.strip_peak[0]);
        assert!(p2 < p1 && p2 > 0.7, "langsam abklingend: {p2}");
    }

    #[test]
    fn db_conversions() {
        assert_eq!(db_to_lin(-90.0), 0.0);
        assert!((db_to_lin(0.0) - 1.0).abs() < 1e-6);
        assert!((db_to_lin(-6.0206) - 0.5).abs() < 1e-3);
        assert_eq!(lin_to_db(0.0), -90.0);
        assert!((lin_to_db(1.0)).abs() < 1e-9);
    }

    #[test]
    fn source_parse_roundtrip() {
        assert_eq!(Source::parse("off"), Some(Source::Off));
        assert_eq!(Source::parse("MXL"), Some(Source::Mxl));
        assert_eq!(Source::parse("alsa:3"), Some(Source::Alsa { first: 3, stereo: false }));
        assert_eq!(Source::parse("aes:1-2"), Some(Source::Aes { first: 1, stereo: true }));
        assert_eq!(Source::parse("aes:1-3"), None);
        assert_eq!(Source::parse("alsa:0"), None);
        assert_eq!(Source::parse("usb:1"), None);
        for t in ["off", "mxl", "alsa:3", "aes:1-2"] {
            assert_eq!(Source::parse(t).unwrap().to_text(), t);
        }
    }
}
