//! Klangbearbeitung des Studio-Mischers: je Streifen Hochpass → EQ (4 Bänder) → Gate/Expander → Kompressor, je Bus ein Limiter.
//!
//! **Alles ohne Vorausschau — das Signal wird nicht verzögert.** Biquad-Filter und Hüllkurvenregler rechnen Rahmen für Rahmen
//! und geben sofort aus; das kostet Rechenzeit, aber keine Latenz. (Ein Limiter mit Vorausschau wäre „dichter“, würde aber genau
//! die Millisekunden kosten, für die dieser Node da ist.) Der Limiter hier greift deshalb im selben Rahmen mit sofortigem
//! Anstieg der Absenkung: der Ausgang überschreitet die Obergrenze nie, ein sehr schneller Impuls klingt dafür etwas härter.
//!
//! Rechenkerne (Biquad nach dem RBJ-Audio-EQ-Cookbook, Kompressorkennlinie mit weichem Knie nach Giannoulis/Massberg/Reiss
//! „Digital Dynamic Range Compressor Design“, JAES 2012) entsprechen denen des Audiomischers (`omp-audio-mixer/src/dsp.rs`,
//! Kapitel 26), hier auf planaren Blöcken und ohne Verzögerungs-/Pan-Stufe.

use std::f64::consts::{FRAC_1_SQRT_2, PI};

pub const FS: f64 = 48_000.0;
pub const EQ_BANDS: usize = 4;

fn db_to_lin(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

fn lin_to_db(lin: f64) -> f64 {
    if lin <= 1e-9 { -180.0 } else { 20.0 * lin.log10() }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum FilterKind {
    HighPass,
    LowShelf,
    Peak,
    HighShelf,
}

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: [f64; 2],
    z2: [f64; 2],
}

impl Biquad {
    fn identity() -> Self {
        Biquad { b0: 1.0, ..Default::default() }
    }

    /// Koeffizienten (b0, b1, b2, a1, a2), auf a0 = 1 normiert.
    pub fn design(kind: FilterKind, freq: f64, q: f64, gain_db: f64) -> (f64, f64, f64, f64, f64) {
        let f = freq.clamp(10.0, FS * 0.45);
        let q = q.clamp(0.1, 20.0);
        let w0 = 2.0 * PI * f / FS;
        let (sw, cw) = w0.sin_cos();
        let alpha = sw / (2.0 * q);
        let a = 10f64.powf(gain_db / 40.0);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            FilterKind::HighPass => ((1.0 + cw) / 2.0, -(1.0 + cw), (1.0 + cw) / 2.0, 1.0 + alpha, -2.0 * cw, 1.0 - alpha),
            FilterKind::Peak => (1.0 + alpha * a, -2.0 * cw, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cw, 1.0 - alpha / a),
            FilterKind::LowShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cw + s),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cw),
                    a * ((a + 1.0) - (a - 1.0) * cw - s),
                    (a + 1.0) + (a - 1.0) * cw + s,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cw),
                    (a + 1.0) + (a - 1.0) * cw - s,
                )
            }
            FilterKind::HighShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cw + s),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cw),
                    a * ((a + 1.0) + (a - 1.0) * cw - s),
                    (a + 1.0) - (a - 1.0) * cw + s,
                    2.0 * ((a - 1.0) - (a + 1.0) * cw),
                    (a + 1.0) - (a - 1.0) * cw - s,
                )
            }
        };
        (b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
    }

    fn set(&mut self, kind: FilterKind, freq: f64, q: f64, gain_db: f64) {
        let (b0, b1, b2, a1, a2) = Self::design(kind, freq, q, gain_db);
        self.b0 = b0;
        self.b1 = b1;
        self.b2 = b2;
        self.a1 = a1;
        self.a2 = a2;
    }

    #[inline]
    fn process(&mut self, c: usize, x: f64) -> f64 {
        // transponierte Direktform II
        let y = self.b0 * x + self.z1[c];
        self.z1[c] = self.b1 * x - self.a1 * y + self.z2[c];
        self.z2[c] = self.b2 * x - self.a2 * y;
        y
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct EqBand {
    pub freq: f64,
    pub q: f64,
    pub gain_db: f64,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct EqParams {
    pub bypass: bool,
    pub hp_enabled: bool,
    pub hp_freq: f64,
    pub bands: [EqBand; EQ_BANDS],
}

impl Default for EqParams {
    /// Tief-Regal 100 Hz, Glocke 1 kHz, Glocke 3,5 kHz, Hoch-Regal 8 kHz — wie im Audiomischer.
    fn default() -> Self {
        EqParams {
            bypass: false,
            hp_enabled: false,
            hp_freq: 80.0,
            bands: [
                EqBand { freq: 100.0, q: 0.5, gain_db: 0.0 },
                EqBand { freq: 1000.0, q: 1.0, gain_db: 0.0 },
                EqBand { freq: 3500.0, q: 1.0, gain_db: 0.0 },
                EqBand { freq: 8000.0, q: 2.0, gain_db: 0.0 },
            ],
        }
    }
}

const BAND_KINDS: [FilterKind; EQ_BANDS] = [FilterKind::LowShelf, FilterKind::Peak, FilterKind::Peak, FilterKind::HighShelf];

struct Eq {
    p: EqParams,
    hp: Biquad,
    bands: [Biquad; EQ_BANDS],
    active: [bool; EQ_BANDS],
}

impl Eq {
    fn new() -> Self {
        let mut e = Eq { p: EqParams::default(), hp: Biquad::identity(), bands: [Biquad::identity(); EQ_BANDS], active: [false; EQ_BANDS] };
        e.set(EqParams::default());
        e
    }

    fn set(&mut self, p: EqParams) {
        self.p = p;
        self.hp.set(FilterKind::HighPass, p.hp_freq, FRAC_1_SQRT_2, 0.0);
        for (i, b) in p.bands.iter().enumerate() {
            self.bands[i].set(BAND_KINDS[i], b.freq, b.q, b.gain_db);
            self.active[i] = b.gain_db.abs() > 0.01; // flaches Band = exakt neutral, überspringen
        }
    }

    #[inline]
    fn process(&mut self, c: usize, mut x: f64) -> f64 {
        if self.p.bypass {
            return x;
        }
        if self.p.hp_enabled {
            x = self.hp.process(c, x);
        }
        for i in 0..EQ_BANDS {
            if self.active[i] {
                x = self.bands[i].process(c, x);
            }
        }
        x
    }
}

fn smooth(ms: f64) -> f64 {
    (-1.0 / (ms.max(0.01) * 0.001 * FS)).exp()
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct CompParams {
    pub enabled: bool,
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub knee_db: f64,
    pub makeup_db: f64,
    pub rms: bool,
}

impl Default for CompParams {
    fn default() -> Self {
        CompParams { enabled: false, threshold_db: -20.0, ratio: 2.0, attack_ms: 15.0, release_ms: 150.0, knee_db: 6.0, makeup_db: 0.0, rms: true }
    }
}

struct Compressor {
    p: CompParams,
    att: f64,
    rel: f64,
    rms_k: f64,
    sq: f64,
    gr_db: f64,
}

impl Compressor {
    fn new() -> Self {
        let mut c = Compressor { p: CompParams::default(), att: 0.0, rel: 0.0, rms_k: smooth(10.0), sq: 0.0, gr_db: 0.0 };
        c.set(CompParams::default());
        c
    }

    fn set(&mut self, p: CompParams) {
        self.p = p;
        self.att = smooth(p.attack_ms);
        self.rel = smooth(p.release_ms);
    }

    fn static_gain_db(&self, level_db: f64) -> f64 {
        let (t, r, w) = (self.p.threshold_db, self.p.ratio.max(1.0), self.p.knee_db.max(0.0));
        let over = level_db - t;
        let out = if 2.0 * over < -w {
            level_db
        } else if 2.0 * over.abs() <= w {
            level_db + (1.0 / r - 1.0) * (over + w / 2.0).powi(2) / (2.0 * w.max(1e-9))
        } else {
            t + over / r
        };
        out - level_db
    }

    #[inline]
    fn frame(&mut self, l: f64, r: f64) -> f64 {
        if !self.p.enabled {
            self.gr_db *= self.rel;
            if self.gr_db > -0.001 {
                self.gr_db = 0.0;
            }
            return db_to_lin(self.gr_db);
        }
        let level = if self.p.rms {
            let e = 0.5 * (l * l + r * r);
            self.sq = self.rms_k * self.sq + (1.0 - self.rms_k) * e;
            lin_to_db(self.sq.sqrt())
        } else {
            lin_to_db(l.abs().max(r.abs()))
        };
        let target = self.static_gain_db(level);
        let k = if target < self.gr_db { self.att } else { self.rel };
        self.gr_db = k * self.gr_db + (1.0 - k) * target;
        db_to_lin(self.gr_db + self.p.makeup_db)
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct GateParams {
    pub enabled: bool,
    pub threshold_db: f64,
    pub range_db: f64,
    /// ≥ 20 = Gate, darunter Expander (sanfter, für Sprache)
    pub ratio: f64,
    pub attack_ms: f64,
    pub hold_ms: f64,
    pub release_ms: f64,
    pub hysteresis_db: f64,
}

impl Default for GateParams {
    fn default() -> Self {
        GateParams { enabled: false, threshold_db: -55.0, range_db: -30.0, ratio: 2.0, attack_ms: 5.0, hold_ms: 80.0, release_ms: 300.0, hysteresis_db: 4.0 }
    }
}

struct Gate {
    p: GateParams,
    att: f64,
    rel: f64,
    env: f64,
    open: bool,
    hold_left: f64,
    gain_db: f64,
}

impl Gate {
    fn new() -> Self {
        let mut g = Gate { p: GateParams::default(), att: 0.0, rel: 0.0, env: 0.0, open: true, hold_left: 0.0, gain_db: 0.0 };
        g.set(GateParams::default());
        g
    }

    fn set(&mut self, p: GateParams) {
        self.p = p;
        self.att = smooth(p.attack_ms);
        self.rel = smooth(p.release_ms);
    }

    #[inline]
    fn frame(&mut self, l: f64, r: f64) -> f64 {
        if !self.p.enabled {
            self.gain_db *= self.att;
            if self.gain_db > -0.001 {
                self.gain_db = 0.0;
            }
            self.open = true;
            return db_to_lin(self.gain_db);
        }
        let x = l.abs().max(r.abs());
        self.env = if x > self.env { x } else { self.env * 0.9995 + x * 0.0005 };
        let level = lin_to_db(self.env);
        let thr = self.p.threshold_db;
        if level > thr {
            self.open = true;
            self.hold_left = self.p.hold_ms * 0.001 * FS;
        } else if self.open && level < thr - self.p.hysteresis_db {
            if self.hold_left > 0.0 {
                self.hold_left -= 1.0;
            } else {
                self.open = false;
            }
        }
        let range = self.p.range_db.min(0.0);
        let target = if self.open {
            0.0
        } else if self.p.ratio >= 20.0 {
            range
        } else {
            ((level - thr) * (self.p.ratio.max(1.0) - 1.0)).clamp(range, 0.0)
        };
        let k = if target > self.gain_db { self.att } else { self.rel };
        self.gain_db = k * self.gain_db + (1.0 - k) * target;
        db_to_lin(self.gain_db)
    }
}

/// Alle Bearbeitungsparameter eines Streifens.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct ProcParams {
    pub phase_invert: bool,
    pub eq: EqParams,
    pub gate: GateParams,
    pub comp: CompParams,
}

impl ProcParams {
    /// Läuft überhaupt etwas? (Ohne aktive Stufe wird der Streifen unverändert durchgereicht.)
    pub fn is_neutral(&self) -> bool {
        !self.phase_invert
            && !self.gate.enabled
            && !self.comp.enabled
            && (self.eq.bypass || (!self.eq.hp_enabled && self.eq.bands.iter().all(|b| b.gain_db.abs() <= 0.01)))
    }
}

pub struct ProcStage {
    eq: Eq,
    gate: Gate,
    comp: Compressor,
    p: ProcParams,
}

/// Stärkste Absenkung des Blocks (dB, ≤ 0) von Gate und Kompressor — Anzeige.
#[derive(Clone, Copy, Default, Debug)]
pub struct Reduction {
    pub gate_db: f32,
    pub comp_db: f32,
}

impl Default for ProcStage {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcStage {
    pub fn new() -> Self {
        ProcStage { eq: Eq::new(), gate: Gate::new(), comp: Compressor::new(), p: ProcParams::default() }
    }

    pub fn set_params(&mut self, p: ProcParams) {
        if p.eq != self.p.eq {
            self.eq.set(p.eq);
        }
        if p.gate != self.p.gate {
            self.gate.set(p.gate);
        }
        if p.comp != self.p.comp {
            self.comp.set(p.comp);
        }
        self.p = p;
    }

    /// Bearbeitet einen Block (planar) in place.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) -> Reduction {
        if self.p.is_neutral() && self.gate.gain_db == 0.0 && self.comp.gr_db == 0.0 {
            return Reduction::default();
        }
        let pol = if self.p.phase_invert { -1.0 } else { 1.0 };
        let (mut min_gate, mut min_comp) = (0f64, 0f64);
        for i in 0..l.len().min(r.len()) {
            let xl = self.eq.process(0, l[i] as f64 * pol);
            let xr = self.eq.process(1, r[i] as f64 * pol);
            let gg = self.gate.frame(xl, xr);
            let (gl, gr) = (xl * gg, xr * gg);
            let gc = self.comp.frame(gl, gr);
            min_gate = min_gate.min(self.gate.gain_db);
            min_comp = min_comp.min(self.comp.gr_db);
            l[i] = (gl * gc) as f32;
            r[i] = (gr * gc) as f32;
        }
        Reduction { gate_db: min_gate as f32, comp_db: min_comp as f32 }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct LimParams {
    pub enabled: bool,
    pub ceiling_db: f64,
    pub release_ms: f64,
}

impl Default for LimParams {
    fn default() -> Self {
        LimParams { enabled: false, ceiling_db: -3.0, release_ms: 100.0 }
    }
}

/// Limiter ohne Vorausschau: die Absenkung steigt im selben Rahmen sofort auf den nötigen Wert, fällt danach mit `release_ms`
/// zurück. Der Ausgang liegt nie über der Obergrenze (Kopfhörerschutz bei In-Ear-Wegen).
pub struct Limiter {
    p: LimParams,
    rel: f64,
    gain: f64,
}

impl Default for Limiter {
    fn default() -> Self {
        Self::new()
    }
}

impl Limiter {
    pub fn new() -> Self {
        Limiter { p: LimParams::default(), rel: smooth(100.0), gain: 1.0 }
    }

    pub fn set_params(&mut self, p: LimParams) {
        self.p = p;
        self.rel = smooth(p.release_ms);
    }

    /// Bearbeitet einen Block in place; liefert die stärkste Absenkung in dB (≤ 0).
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) -> f32 {
        if !self.p.enabled {
            if self.gain >= 1.0 {
                return 0.0;
            }
            // beim Ausschalten sanft auf 1 zurücklaufen
            for i in 0..l.len().min(r.len()) {
                self.gain = 1.0 - (1.0 - self.gain) * self.rel;
                l[i] *= self.gain as f32;
                r[i] *= self.gain as f32;
            }
            return lin_to_db(self.gain) as f32;
        }
        let ceil = db_to_lin(self.p.ceiling_db.min(0.0));
        let mut min_g = 1.0f64;
        for i in 0..l.len().min(r.len()) {
            let peak = (l[i] as f64).abs().max((r[i] as f64).abs());
            let need = if peak > ceil { ceil / peak } else { 1.0 };
            self.gain = if need < self.gain { need } else { 1.0 - (1.0 - self.gain) * self.rel };
            if self.gain > 1.0 {
                self.gain = 1.0;
            }
            let g = self.gain as f32;
            l[i] *= g;
            r[i] *= g;
            min_g = min_g.min(self.gain);
        }
        lin_to_db(min_g) as f32
    }
}

/// Betragsgang eines Bandes (dB) bei `f` Hz — Gegenprobe der Entwurfsformel in den Tests.
#[cfg(test)]
pub fn band_response_db(kind: FilterKind, freq: f64, q: f64, gain_db: f64, f: f64) -> f64 {
    let (b0, b1, b2, a1, a2) = Biquad::design(kind, freq, q, gain_db);
    let w = 2.0 * PI * f / FS;
    let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
    let (nr, ni) = (b0 + b1 * c1 + b2 * c2, -(b1 * s1 + b2 * s2));
    let (dr, di) = (1.0 + a1 * c1 + a2 * c2, -(a1 * s1 + a2 * s2));
    10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;

    fn sine(freq: f64, amp_db: f64, n: usize) -> Vec<f32> {
        let a = db_to_lin(amp_db);
        (0..n).map(|i| (a * (2.0 * PI * freq * i as f64 / FS).sin()) as f32).collect()
    }

    fn rms_db(x: &[f32]) -> f64 {
        lin_to_db((x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt())
    }

    /// Eingeschwungener Pegel nach dem Durchlauf in 48er-Blöcken (letzte Sekunde).
    fn run(stage: &mut ProcStage, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::new();
        for chunk in input.chunks(48) {
            let (mut l, mut r) = (chunk.to_vec(), chunk.to_vec());
            stage.process(&mut l, &mut r);
            out.extend_from_slice(&l);
        }
        out
    }

    #[test]
    fn neutral_stage_is_bit_exact_and_instant() {
        let mut s = ProcStage::new();
        let x = sine(1000.0, -12.0, 4800);
        let y = run(&mut s, &x);
        assert_eq!(x, y, "ohne aktive Stufe unverändert");
        // keine Verzögerung: ein Impuls am ersten Rahmen erscheint am ersten Rahmen (auch mit aktivem EQ)
        let mut p = ProcParams::default();
        p.eq.bands[1].gain_db = 6.0;
        s.set_params(p);
        let mut l = vec![0.0f32; 48];
        l[0] = 1.0;
        let mut r = l.clone();
        s.process(&mut l, &mut r);
        assert!(l[0].abs() > 0.5, "Impuls kommt sofort, keine Latenz: {}", l[0]);
    }

    #[test]
    fn eq_peak_boosts_at_center_and_leaves_far_frequencies() {
        let mut p = ProcParams::default();
        p.eq.bands[1] = EqBand { freq: 1000.0, q: 1.0, gain_db: 6.0 };
        let mut s = ProcStage::new();
        s.set_params(p);
        let x = sine(1000.0, -20.0, 48_000);
        let y = run(&mut s, &x);
        let gain = rms_db(&y[24_000..]) - rms_db(&x[24_000..]);
        assert!((gain - 6.0).abs() < 0.3, "Anhebung bei der Mittenfrequenz: {gain}");
        let far = sine(100.0, -20.0, 48_000);
        let yf = run(&mut s, &far);
        let gf = rms_db(&yf[24_000..]) - rms_db(&far[24_000..]);
        assert!(gf.abs() < 0.8, "weit entfernt kaum betroffen: {gf}");
        // Kurve aus der Entwurfsformel stimmt mit der Messung überein
        let calc = band_response_db(FilterKind::Peak, 1000.0, 1.0, 6.0, 1000.0);
        assert!((calc - 6.0).abs() < 0.01, "{calc}");
    }

    #[test]
    fn highpass_cuts_rumble_not_voice() {
        let mut p = ProcParams::default();
        p.eq.hp_enabled = true;
        p.eq.hp_freq = 100.0;
        let mut s = ProcStage::new();
        s.set_params(p);
        let low = sine(20.0, -10.0, 48_000);
        let g_low = rms_db(&run(&mut s, &low)[24_000..]) - rms_db(&low[24_000..]);
        assert!(g_low < -20.0, "20 Hz stark gedämpft: {g_low}");
        let mid = sine(1000.0, -10.0, 48_000);
        let g_mid = rms_db(&run(&mut s, &mid)[24_000..]) - rms_db(&mid[24_000..]);
        assert!(g_mid.abs() < 0.2, "1 kHz unberührt: {g_mid}");
    }

    #[test]
    fn eq_bypass_overrides_bands() {
        let mut p = ProcParams::default();
        p.eq.bands[1].gain_db = 12.0;
        p.eq.bypass = true;
        assert!(p.is_neutral());
        let mut s = ProcStage::new();
        s.set_params(p);
        let x = sine(1000.0, -20.0, 4800);
        assert_eq!(run(&mut s, &x), x);
    }

    #[test]
    fn compressor_follows_static_curve_in_steady_state() {
        // Schwelle −20 dB, 4:1, hartes Knie, Spitzenerkennung: Sinus mit −10 dB Spitze → Ausgang ≈ −20 + 10/4 = −17,5 dB Spitze
        let mut p = ProcParams::default();
        p.comp = CompParams { enabled: true, threshold_db: -20.0, ratio: 4.0, attack_ms: 1.0, release_ms: 50.0, knee_db: 0.0, makeup_db: 0.0, rms: false };
        let mut s = ProcStage::new();
        s.set_params(p);
        let x = sine(1000.0, -10.0, 96_000);
        let y = run(&mut s, &x);
        let peak_out = y[72_000..].iter().fold(0f32, |m, v| m.max(v.abs())) as f64;
        let db = lin_to_db(peak_out);
        assert!((db + 17.5).abs() < 0.8, "Spitzenpegel nach dem Kompressor: {db}");
        // unter der Schwelle unverändert
        let quiet = sine(1000.0, -40.0, 48_000);
        let yq = run(&mut s, &quiet);
        assert!((rms_db(&yq[24_000..]) - rms_db(&quiet[24_000..])).abs() < 0.3);
    }

    #[test]
    fn compressor_reports_reduction_and_releases() {
        let mut p = ProcParams::default();
        p.comp = CompParams { enabled: true, threshold_db: -30.0, ratio: 10.0, attack_ms: 1.0, release_ms: 20.0, knee_db: 0.0, makeup_db: 0.0, rms: false };
        let mut s = ProcStage::new();
        s.set_params(p);
        let loud = sine(1000.0, -6.0, 9600);
        let mut red = Reduction::default();
        for c in loud.chunks(48) {
            let (mut l, mut r) = (c.to_vec(), c.to_vec());
            red = s.process(&mut l, &mut r);
        }
        assert!(red.comp_db < -10.0, "starke Absenkung gemeldet: {}", red.comp_db);
        // danach Stille: Absenkung läuft zurück
        for _ in 0..200 {
            let (mut l, mut r) = (vec![0.0f32; 48], vec![0.0f32; 48]);
            red = s.process(&mut l, &mut r);
        }
        assert!(red.comp_db > -0.5, "Absenkung gelöst: {}", red.comp_db);
    }

    #[test]
    fn gate_closes_on_noise_and_opens_on_speech_level() {
        let mut p = ProcParams::default();
        p.gate = GateParams { enabled: true, threshold_db: -40.0, range_db: -30.0, ratio: 20.0, attack_ms: 1.0, hold_ms: 10.0, release_ms: 20.0, hysteresis_db: 3.0 };
        let mut s = ProcStage::new();
        s.set_params(p);
        let noise = sine(500.0, -60.0, 48_000);
        let yn = run(&mut s, &noise);
        let g = rms_db(&yn[24_000..]) - rms_db(&noise[24_000..]);
        assert!(g < -25.0, "Rauschen unter der Schwelle um den Bereich abgesenkt: {g}");
        let speech = sine(500.0, -20.0, 48_000);
        let ys = run(&mut s, &speech);
        let g2 = rms_db(&ys[24_000..]) - rms_db(&speech[24_000..]);
        assert!(g2.abs() < 0.5, "Pegel über der Schwelle unberührt: {g2}");
    }

    #[test]
    fn limiter_never_exceeds_ceiling_and_has_no_delay() {
        let mut lim = Limiter::new();
        lim.set_params(LimParams { enabled: true, ceiling_db: -6.0, release_ms: 50.0 });
        let ceil = db_to_lin(-6.0) as f32;
        // Pegelsprung von −30 auf +6 dBFS (Übersteuerung)
        let mut worst = 0f32;
        for blk in 0..300 {
            let amp = if blk < 50 { db_to_lin(-30.0) } else { db_to_lin(6.0) } as f32;
            let mut l: Vec<f32> = (0..48).map(|i| amp * (2.0 * std::f32::consts::PI * 1000.0 * (blk * 48 + i) as f32 / 48_000.0).sin()).collect();
            let mut r = l.clone();
            lim.process(&mut l, &mut r);
            if blk >= 50 {
                worst = worst.max(l.iter().chain(r.iter()).fold(0.0, |m, v| m.max(v.abs())));
            }
        }
        assert!(worst <= ceil * 1.0001, "Obergrenze eingehalten: {worst} > {ceil}");
        // unter der Obergrenze unverändert
        let mut lim2 = Limiter::new();
        lim2.set_params(LimParams { enabled: true, ceiling_db: -6.0, release_ms: 50.0 });
        let x = sine(1000.0, -20.0, 480);
        let (mut l, mut r) = (x.clone(), x.clone());
        let gr = lim2.process(&mut l, &mut r);
        assert_eq!(l, x);
        assert_eq!(gr, 0.0);
    }

    #[test]
    fn limiter_disabled_is_transparent() {
        let mut lim = Limiter::new();
        let x = sine(1000.0, 3.0, 480);
        let (mut l, mut r) = (x.clone(), x.clone());
        lim.process(&mut l, &mut r);
        assert_eq!(l, x);
    }
}
