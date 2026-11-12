//! Eingangsring mit Drift-Regelung. Ein Erzeuger (MXL-Leser, RTP-Empfänger, …) schiebt Rahmen hinein, der Misch-Takt holt je Tick
//! genau einen Block. Beide laufen auf **verschiedenen Uhren**; ohne Ausgleich liefe der Ring über oder leer.
//!
//! Regelung (kein Resampler, keine Hörbarkeit): Der Ring beobachtet über 100 ms den kleinsten Füllstand nach dem Abholen.
//! Liegt er über dem Sicherheitsabstand, wird beim nächsten Tick ein Rahmen mehr verbraucht, liegt er darunter, einer weniger;
//! der Block wird dann linear über die Länge gestreckt (ein Rahmen auf einen Block, ≈ 0,02 % Tonhöhe, nicht hörbar).
//! Das kann bis zu 10 Rahmen/s ausgleichen (≈ 200 ppm, Quarze liegen bei 20–100 ppm). Ein großer Überschuss (z. B. nach dem
//! Start) wird einmal abgeschnitten. Läuft der Ring leer, wächst der Sicherheitsabstand um einen Block (bis zu einer Grenze) —
//! so findet jede Quelle ihren eigenen kleinsten stabilen Abstand (eine Quelle mit 10-ms-Blöcken braucht mehr als eine mit 1 ms).

use std::collections::VecDeque;

#[derive(Debug, Default, Clone)]
pub struct RingStats {
    pub underruns: u64,
    pub overruns: u64,
    /// Ein Rahmen mehr verbraucht (Erzeuger war schneller).
    pub slips_drop: u64,
    /// Ein Rahmen weniger verbraucht (Erzeuger war langsamer).
    pub slips_insert: u64,
    /// Großer Überschuss abgeschnitten.
    pub trims: u64,
    pub grown: u64,
    pub shrunk: u64,
}

pub struct InRing {
    ch: usize,
    block: usize,
    data: VecDeque<f32>,
    safety: usize,
    base_safety: usize,
    max_safety: usize,
    /// Ticks seit dem letzten Unterlauf (für den Rückbau der Reserve)
    quiet_ticks: u64,
    adaptive: bool,
    primed: bool,
    window_min: usize,
    window_ticks: u32,
    window_len: u32,
    pending_adj: i32,
    scratch: Vec<f32>,
    pub stats: RingStats,
}

const RATE_HZ: u64 = 48_000;

/// Wie viele tolerierte Rahmen Abweichung, bevor die Regelung eingreift.
const TOLERANCE: usize = 4;

impl InRing {
    /// `safety_frames`: gewünschter Mindest-Rest nach dem Abholen (Latenz-Reserve), `max_safety_frames`: Wachstumsgrenze.
    pub fn new(channels: usize, block: usize, safety_frames: usize, max_safety_frames: usize, adaptive: bool) -> Self {
        assert!(channels >= 1 && block >= 1);
        Self {
            ch: channels,
            block,
            data: VecDeque::new(),
            safety: safety_frames,
            base_safety: safety_frames,
            quiet_ticks: 0,
            max_safety: max_safety_frames.max(safety_frames),
            adaptive,
            primed: false,
            window_min: usize::MAX,
            window_ticks: 0,
            window_len: (4800 / block as u32).max(4),
            pending_adj: 0,
            scratch: Vec::new(),
            stats: RingStats::default(),
        }
    }

    pub fn fill_frames(&self) -> usize {
        self.data.len() / self.ch
    }

    pub fn is_primed(&self) -> bool {
        self.primed
    }

    /// Leert den Ring (Quelle wurde getrennt oder neu verbunden).
    pub fn reset(&mut self) {
        self.data.clear();
        self.primed = false;
        self.window_min = usize::MAX;
        self.window_ticks = 0;
        self.pending_adj = 0;
    }

    /// Interleaved Rahmen anhängen.
    pub fn push(&mut self, interleaved: &[f32]) {
        debug_assert!(interleaved.len().is_multiple_of(self.ch));
        self.data.extend(interleaved.iter().copied());
        // Obergrenze: Reserve + 8 Blöcke + 20 ms; mehr ist nur Latenz (Erzeuger läuft weg, z. B. nach Ruhephase)
        let cap = (self.max_safety + self.block * 8 + 960) * self.ch;
        if self.data.len() > cap {
            let keep = (self.safety + self.block) * self.ch;
            let drop = self.data.len() - keep;
            self.data.drain(..drop);
            self.stats.overruns += 1;
        }
    }

    /// Holt einen Block (interleaved, `block * channels`). `false` = Unterlauf bzw. noch nicht gefüllt (Ausgabe: Stille).
    pub fn pull(&mut self, out: &mut [f32]) -> bool {
        let (n, ch) = (self.block, self.ch);
        debug_assert_eq!(out.len(), n * ch);
        let fill = self.fill_frames();
        if !self.primed {
            if fill >= self.safety + n {
                self.primed = true;
            } else {
                out.fill(0.0);
                return false;
            }
        }
        if fill < n {
            self.stats.underruns += 1;
            self.quiet_ticks = 0;
            self.primed = false;
            self.window_min = usize::MAX;
            self.window_ticks = 0;
            self.pending_adj = 0;
            if self.adaptive && self.safety < self.max_safety {
                self.safety = (self.safety + n).min(self.max_safety);
                self.stats.grown += 1;
            }
            out.fill(0.0);
            return false;
        }
        let want = (n as i64 + self.pending_adj as i64).max(1) as usize;
        let take = if fill >= want { want } else { n };
        self.pending_adj = 0;
        if take == n {
            for (i, v) in self.data.drain(..n * ch).enumerate() {
                out[i] = v;
            }
        } else {
            self.scratch.clear();
            self.scratch.extend(self.data.drain(..take * ch));
            stretch(&self.scratch, take, out, n, ch);
        }
        // Auswertung über 100 ms: kleinster Rest nach dem Abholen
        self.window_min = self.window_min.min(self.fill_frames());
        self.window_ticks += 1;
        self.quiet_ticks += 1;
        if self.window_ticks >= self.window_len {
            let m = self.window_min;
            // 60 s ohne Unterlauf: Reserve um einen Block zurück Richtung Grundwert (Aussetzer der Rechners sind nicht von Dauer)
            let shrink_after = 60 * RATE_HZ / n as u64;
            if self.adaptive && self.safety > self.base_safety && self.quiet_ticks > shrink_after {
                self.safety = self.safety.saturating_sub(n).max(self.base_safety);
                self.quiet_ticks = 0;
                self.stats.shrunk += 1;
            }
            if m > self.safety + 2 * n {
                // großer Überschuss (Start, Ruhephase): einmal abschneiden
                let cut = (m - self.safety) * ch;
                self.data.drain(..cut);
                self.stats.trims += 1;
            } else if m > self.safety + TOLERANCE {
                self.pending_adj = 1;
                self.stats.slips_drop += 1;
            } else if m + TOLERANCE < self.safety {
                self.pending_adj = -1;
                self.stats.slips_insert += 1;
            }
            self.window_min = usize::MAX;
            self.window_ticks = 0;
        }
        true
    }
}

/// Streckt/staucht `src` (`n_in` Rahmen) linear auf `n_out` Rahmen (interleaved, `ch` Kanäle).
pub fn stretch(src: &[f32], n_in: usize, out: &mut [f32], n_out: usize, ch: usize) {
    debug_assert!(src.len() >= n_in * ch && out.len() >= n_out * ch);
    if n_out == 1 || n_in == 1 {
        out[..ch].copy_from_slice(&src[..ch]);
        for i in 1..n_out {
            for c in 0..ch {
                out[i * ch + c] = out[c];
            }
        }
        return;
    }
    let step = (n_in - 1) as f64 / (n_out - 1) as f64;
    for i in 0..n_out {
        let pos = i as f64 * step;
        let i0 = (pos.floor() as usize).min(n_in - 1);
        let i1 = (i0 + 1).min(n_in - 1);
        let frac = (pos - i0 as f64) as f32;
        for c in 0..ch {
            let (a, b) = (src[i0 * ch + c], src[i1 * ch + c]);
            out[i * ch + c] = a + (b - a) * frac;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Simuliert `ticks` Blöcke (je `block` Rahmen); der Erzeuger liefert `ratio`-mal so schnell in Stößen von `burst` Rahmen.
    fn simulate(ratio: f64, burst: usize, block: usize, safety: usize, ticks: usize, adaptive: bool) -> InRing {
        let mut r = InRing::new(2, block, safety, 2400, adaptive);
        let mut produced = 0.0f64;
        let mut delivered = 0usize;
        let mut out = vec![0.0f32; block * 2];
        for t in 0..ticks {
            produced += block as f64 * ratio;
            while produced - delivered as f64 >= burst as f64 {
                r.push(&vec![0.5f32; burst * 2]);
                delivered += burst;
            }
            // etwas Zeitversatz: Erzeuger und Verbraucher liegen nie im selben Moment
            let _ = t;
            r.pull(&mut out);
        }
        r
    }

    #[test]
    fn steady_equal_clocks_no_underruns_after_priming() {
        // 1-ms-Blöcke, Erzeuger in 1-ms-Stößen, Reserve = ein Stoß
        let r = simulate(1.0, 48, 48, 60, 20_000, false);
        assert_eq!(r.stats.underruns, 0, "{:?}", r.stats);
        assert_eq!(r.stats.overruns, 0);
    }

    #[test]
    fn faster_producer_is_absorbed_by_slips() {
        // +200 ppm über 30 s (≈ 29 Rahmen/s mehr als der Verbraucher) — der Füllstand darf nicht weglaufen
        let r = simulate(1.0002, 48, 48, 60, 30_000, false);
        assert_eq!(r.stats.overruns, 0, "{:?}", r.stats);
        assert_eq!(r.stats.underruns, 0, "{:?}", r.stats);
        assert!(r.fill_frames() < 60 + 3 * 48, "Füllstand {} bleibt beschränkt", r.fill_frames());
        assert!(r.stats.slips_drop > 0 || r.stats.trims > 0, "{:?}", r.stats);
    }

    #[test]
    fn slower_producer_is_absorbed_by_inserts() {
        // −200 ppm: ohne Ausgleich liefe der Ring in 30 s ≈ 29 Rahmen leer; mit Reserve 60 darf kein Unterlauf entstehen
        let r = simulate(0.9998, 48, 48, 60, 30_000, false);
        assert_eq!(r.stats.underruns, 0, "{:?}", r.stats);
        assert!(r.fill_frames() >= 12, "Füllstand {} bleibt über dem Minimum", r.fill_frames());
    }

    #[test]
    fn bursty_source_converges_to_its_own_reserve() {
        // Quelle liefert 480-Rahmen-Stöße; die Reserve (24) ist kleiner als der Stoß. Der Ring darf danach nicht mehr unterlaufen,
        // und die Regelung schiebt den Füllstand-Boden Richtung Reserve (Einfügen), statt dagegen anzukämpfen.
        let r = simulate(1.0, 480, 48, 24, 60_000, true);
        assert_eq!(r.stats.underruns, 0, "{:?}", r.stats);
        assert!(r.stats.slips_insert > 0, "{:?}", r.stats);
    }

    #[test]
    fn underrun_grows_the_reserve_when_adaptive() {
        // Stöße von 480 mit Aussetzer in der Mitte: Unterlauf → Reserve wächst um einen Block
        let mut r = InRing::new(1, 48, 24, 480, true);
        r.push(&vec![0.1; 48 * 4]);
        let mut out = vec![0.0; 48];
        let mut grown = false;
        for _ in 0..40 {
            r.pull(&mut out);
            grown |= r.stats.grown > 0;
        }
        assert!(grown && r.stats.underruns >= 1, "{:?}", r.stats);
    }

    #[test]
    fn reserve_shrinks_back_after_quiet_minute() {
        let mut r = InRing::new(1, 48, 24, 480, true);
        let mut out = vec![0.0; 48];
        // Unterlauf provozieren → Reserve wächst
        r.push(&vec![0.1; 48 * 4]);
        for _ in 0..10 {
            r.pull(&mut out);
        }
        assert!(r.stats.grown >= 1);
        let grown_to = r.safety;
        // danach 80 s lang gleichmäßig beliefern (1 Block je Tick) → Rückbau
        for _ in 0..(80 * 48_000 / 48) {
            r.push(&[0.1; 48]);
            r.pull(&mut out);
        }
        assert!(r.stats.shrunk >= 1 && r.safety < grown_to, "{:?} safety {} (vorher {grown_to})", r.stats, r.safety);
    }

    #[test]
    fn large_excess_is_trimmed_once() {
        // 200 ms Rückstand (z. B. Erzeuger lief während einer Ruhephase weiter): nach dem ersten 100-ms-Fenster einmal abschneiden
        let mut r = InRing::new(1, 48, 24, 12_000, false);
        r.push(&vec![0.1; 48 * 200]);
        let mut out = vec![0.0; 48];
        for _ in 0..150 {
            r.pull(&mut out);
        }
        assert!(r.stats.trims >= 1 && r.fill_frames() < 24 + 48 * 3, "{:?} fill {}", r.stats, r.fill_frames());
    }

    #[test]
    fn stretch_keeps_ends_and_is_linear() {
        let src: Vec<f32> = (0..5).map(|i| i as f32).collect(); // 0..4, mono
        let mut out = vec![0.0; 4];
        stretch(&src, 5, &mut out, 4, 1);
        assert!((out[0] - 0.0).abs() < 1e-6 && (out[3] - 4.0).abs() < 1e-6);
        assert!(out.windows(2).all(|w| w[1] > w[0]));
        let mut out2 = vec![0.0; 6];
        stretch(&src, 5, &mut out2, 6, 1);
        assert!((out2[5] - 4.0).abs() < 1e-6 && (out2[1] - 0.8).abs() < 1e-5);
    }

    #[test]
    fn not_primed_gives_silence() {
        let mut r = InRing::new(1, 48, 24, 480, false);
        r.push(&[1.0; 20]);
        let mut out = vec![9.0; 48];
        assert!(!r.pull(&mut out) && out.iter().all(|v| *v == 0.0));
        assert!(!r.is_primed());
    }
}
