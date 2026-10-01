//! Eigenes Echtzeit-DSP des Audiomischers (Kapitel 26, `docs/AUDIOMIXER-PLAN.md`).
//!
//! Warum eigener Code statt GStreamer-Elementen: auf dem Zielsystem sind
//! keine LADSPA/LV2-Plugins installiert, `audiodynamic` hat weder
//! Attack/Release/Knee noch Gain-Reduction-Auslesung, und es gibt weder
//! Gate/Expander, Kanal-Delay noch HPF im Standardumfang. Die Stufen hier
//! sind reine Rechenkerne auf interleaved-F32-Stereo (kein GStreamer-Bezug,
//! daher per Unit-Test prüfbar); `pipeline.rs` hängt sie als Pad-Probes in
//! den Streaming-Thread — dieselbe Realtime-Infrastruktur wie vorher, kein
//! zweiter Audio-Pfad.
//!
//! Kette pro Kanal: [`ProcStage`] (HPF → EQ → Detektor → Gate → Kompressor →
//! Delay → Pan) und danach [`FaderStage`] (Fader · Mute · AutoMix · Ducking,
//! geglättet). Fader steht bewusst *nach* der Bearbeitung und als eigene
//! Stufe, damit Pre-/Post-Fader-Abgriffe (Aux) echte unterschiedliche
//! Signalpunkte sind.

use std::f64::consts::{FRAC_1_SQRT_2, PI};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

pub const FS: f64 = 48000.0;
pub const CH: usize = 2;
const MAX_DELAY_MS: f64 = 2000.0;
/// Anzahl EQ-Bänder: Low-Shelf, Mid 1, Mid 2, High-Shelf (+ HPF separat).
pub const EQ_BANDS: usize = 4;

pub fn db_to_lin(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

pub fn lin_to_db(lin: f64) -> f64 {
    20.0 * lin.max(1e-9).log10()
}

/// `f32` in einem `AtomicU32` — Meter-/Zielwerte zwischen Audio-Thread und
/// Engine/UI ohne Lock.
#[derive(Default)]
pub struct AtomicF32(AtomicU32);

impl AtomicF32 {
    pub fn new(v: f32) -> Self {
        AtomicF32(AtomicU32::new(v.to_bits()))
    }
    pub fn get(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }
    pub fn set(&self, v: f32) {
        self.0.store(v.to_bits(), Ordering::Relaxed);
    }
}

// ───────────────────────────── Biquad / EQ ─────────────────────────────

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
    z1: [f64; CH],
    z2: [f64; CH],
}

impl Biquad {
    fn identity() -> Self {
        Biquad { b0: 1.0, ..Default::default() }
    }

    /// RBJ-Audio-EQ-Cookbook.
    fn design(kind: FilterKind, freq: f64, q: f64, gain_db: f64) -> (f64, f64, f64, f64, f64) {
        let f = freq.clamp(10.0, FS * 0.45);
        let q = q.clamp(0.1, 20.0);
        let w0 = 2.0 * PI * f / FS;
        let (sw, cw) = w0.sin_cos();
        let alpha = sw / (2.0 * q);
        let a = 10f64.powf(gain_db / 40.0);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            FilterKind::HighPass => {
                ((1.0 + cw) / 2.0, -(1.0 + cw), (1.0 + cw) / 2.0, 1.0 + alpha, -2.0 * cw, 1.0 - alpha)
            }
            FilterKind::Peak => (
                1.0 + alpha * a,
                -2.0 * cw,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cw,
                1.0 - alpha / a,
            ),
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
        // Transponierte Direktform II.
        let y = self.b0 * x + self.z1[c];
        self.z1[c] = self.b1 * x - self.a1 * y + self.z2[c];
        self.z2[c] = self.b2 * x - self.a2 * y;
        y
    }
}

/// Bandbreite in Hz (Altformat von `equalizer-nbands`, bleibt API) → Q.
pub fn bandwidth_to_q(freq: f64, width_hz: f64) -> f64 {
    (freq / width_hz.max(1.0)).clamp(0.1, 20.0)
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct EqBandParams {
    pub freq: f64,
    pub q: f64,
    pub gain_db: f64,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct EqParams {
    pub bypass: bool,
    pub hp_enabled: bool,
    pub hp_freq: f64,
    pub bands: [EqBandParams; EQ_BANDS],
}

impl Default for EqParams {
    /// Frequenzen/Q der drei Altbänder wie vor Kapitel 26
    /// (Low 100/200 Hz, Mid 1000/1000 Hz, High 8000/4000 Hz Bandbreite).
    fn default() -> Self {
        EqParams {
            bypass: false,
            hp_enabled: false,
            hp_freq: 80.0,
            bands: [
                EqBandParams { freq: 100.0, q: bandwidth_to_q(100.0, 200.0), gain_db: 0.0 },
                EqBandParams { freq: 1000.0, q: bandwidth_to_q(1000.0, 1000.0), gain_db: 0.0 },
                EqBandParams { freq: 3500.0, q: 1.0, gain_db: 0.0 },
                EqBandParams { freq: 8000.0, q: bandwidth_to_q(8000.0, 4000.0), gain_db: 0.0 },
            ],
        }
    }
}

const BAND_KINDS: [FilterKind; EQ_BANDS] =
    [FilterKind::LowShelf, FilterKind::Peak, FilterKind::Peak, FilterKind::HighShelf];

struct Eq {
    params: EqParams,
    hp: Biquad,
    bands: [Biquad; EQ_BANDS],
    active: [bool; EQ_BANDS],
}

impl Eq {
    fn new() -> Self {
        let mut e = Eq {
            params: EqParams::default(),
            hp: Biquad::identity(),
            bands: [Biquad::identity(); EQ_BANDS],
            active: [false; EQ_BANDS],
        };
        e.set(EqParams::default());
        e
    }

    fn set(&mut self, p: EqParams) {
        self.params = p;
        self.hp.set(FilterKind::HighPass, p.hp_freq, FRAC_1_SQRT_2, 0.0);
        for (i, b) in p.bands.iter().enumerate() {
            self.bands[i].set(BAND_KINDS[i], b.freq, b.q, b.gain_db);
            // Flache Bänder überspringen (Gain 0 dB = exakt neutral).
            self.active[i] = b.gain_db.abs() > 0.01;
        }
    }

    #[inline]
    fn process(&mut self, c: usize, mut x: f64) -> f64 {
        if self.params.bypass {
            return x;
        }
        if self.params.hp_enabled {
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

// ───────────────────────────── Dynamik ─────────────────────────────

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct CompParams {
    pub enabled: bool,
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub knee_db: f64,
    pub makeup_db: f64,
    /// `false` = Peak-, `true` = RMS-Detektion.
    pub rms: bool,
}

impl Default for CompParams {
    /// Threshold/Ratio wie der Altzustand (`-20 dB`, `2:1`), sonst moderate
    /// Rundfunk-Werte (nicht aggressiv).
    fn default() -> Self {
        CompParams {
            enabled: false,
            threshold_db: -20.0,
            ratio: 2.0,
            attack_ms: 15.0,
            release_ms: 150.0,
            knee_db: 6.0,
            makeup_db: 0.0,
            rms: true,
        }
    }
}

fn smooth_coeff(ms: f64) -> f64 {
    (-1.0 / (ms.max(0.01) * 0.001 * FS)).exp()
}

struct Compressor {
    p: CompParams,
    att: f64,
    rel: f64,
    rms_coeff: f64,
    sq: f64,
    /// Geglättete Gain-Reduction in dB (≤ 0).
    gr_db: f64,
}

impl Compressor {
    fn new() -> Self {
        let mut c = Compressor {
            p: CompParams::default(),
            att: 0.0,
            rel: 0.0,
            rms_coeff: smooth_coeff(10.0),
            sq: 0.0,
            gr_db: 0.0,
        };
        c.set(CompParams::default());
        c
    }

    fn set(&mut self, p: CompParams) {
        self.p = p;
        self.att = smooth_coeff(p.attack_ms);
        self.rel = smooth_coeff(p.release_ms);
    }

    /// Statische Kennlinie (Soft-Knee nach Giannoulis/Massberg/Reiss).
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

    /// Verarbeitet einen Frame (verlinkt, gleiche Reduktion für beide Kanäle).
    #[inline]
    fn frame(&mut self, l: f64, r: f64) -> f64 {
        if !self.p.enabled {
            // Reduktion sanft auf 0 zurücklaufen lassen (kein Sprung bei Bypass).
            self.gr_db *= self.rel;
            if self.gr_db > -0.001 {
                self.gr_db = 0.0;
            }
            return db_to_lin(self.gr_db);
        }
        let level = if self.p.rms {
            let e = 0.5 * (l * l + r * r);
            self.sq = self.rms_coeff * self.sq + (1.0 - self.rms_coeff) * e;
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
    /// Maximale Absenkung in dB (negativ).
    pub range_db: f64,
    /// `>= 20` = klassisches Gate, darunter Expander (sanfter, für Sprache).
    pub ratio: f64,
    pub attack_ms: f64,
    pub hold_ms: f64,
    pub release_ms: f64,
    pub hysteresis_db: f64,
}

impl Default for GateParams {
    /// Sprach-tauglich: Expander 2:1, begrenzte Absenkung.
    fn default() -> Self {
        GateParams {
            enabled: false,
            threshold_db: -55.0,
            range_db: -30.0,
            ratio: 2.0,
            attack_ms: 5.0,
            hold_ms: 80.0,
            release_ms: 300.0,
            hysteresis_db: 4.0,
        }
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
        self.att = smooth_coeff(p.attack_ms);
        self.rel = smooth_coeff(p.release_ms);
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
        // Peak-Hüllkurve mit schnellem Anstieg und langsamem Abfall.
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
        // Öffnen = Attack (Gain steigt), Schließen = Release.
        let k = if target > self.gain_db { self.att } else { self.rel };
        self.gain_db = k * self.gain_db + (1.0 - k) * target;
        db_to_lin(self.gain_db)
    }
}

// ───────────────────────────── Delay / Pan ─────────────────────────────

struct Delay {
    buf: Vec<f32>,
    cap: usize,
    pos: usize,
    cur: usize,
    tgt: usize,
    xfade: usize,
    enabled: bool,
}

const DELAY_XFADE: usize = 480;

impl Delay {
    fn new() -> Self {
        let cap = (MAX_DELAY_MS * 0.001 * FS) as usize + 2;
        Delay { buf: vec![0.0; cap * CH], cap, pos: 0, cur: 0, tgt: 0, xfade: 0, enabled: false }
    }

    fn set(&mut self, enabled: bool, ms: f64) {
        let samples = ((ms.clamp(0.0, MAX_DELAY_MS) * 0.001 * FS) as usize).min(self.cap - 1);
        let tgt = if enabled { samples } else { 0 };
        self.enabled = enabled;
        if tgt != self.tgt {
            // Laufende Überblendung abschließen (auf alten Zielwert springen
            // wäre ein Klick), dann neue starten.
            if self.xfade > 0 {
                self.cur = self.tgt;
            }
            self.tgt = tgt;
            self.xfade = DELAY_XFADE;
        }
    }

    #[inline]
    fn read(&self, back: usize, c: usize) -> f32 {
        let idx = (self.pos + self.cap - back) % self.cap;
        self.buf[idx * CH + c]
    }

    /// `frame` ist ein Frame (L,R); schreibt, liest verzögert.
    #[inline]
    fn frame(&mut self, f: [f32; CH]) -> [f32; CH] {
        self.buf[self.pos * CH] = f[0];
        self.buf[self.pos * CH + 1] = f[1];
        let mut out = [0f32; CH];
        if self.cur == 0 && self.tgt == 0 && self.xfade == 0 {
            out = f;
        } else if self.xfade > 0 {
            let x = 1.0 - self.xfade as f32 / DELAY_XFADE as f32;
            for (c, o) in out.iter_mut().enumerate() {
                *o = self.read(self.cur, c) * (1.0 - x) + self.read(self.tgt, c) * x;
            }
            self.xfade -= 1;
            if self.xfade == 0 {
                self.cur = self.tgt;
            }
        } else {
            for (c, o) in out.iter_mut().enumerate() {
                *o = self.read(self.cur, c);
            }
        }
        self.pos = (self.pos + 1) % self.cap;
        out
    }
}

/// Balance-Gesetz für Stereo-Quellen: Mitte = Unity (bestehendes Verhalten
/// bleibt unverändert), zur Seite wird die Gegenseite mit Cosinus
/// abgesenkt. `pan` −1 (links) … +1 (rechts).
pub fn pan_gains(pan: f64) -> (f64, f64) {
    let p = pan.clamp(-1.0, 1.0);
    if p >= 0.0 {
        (((p * PI / 2.0).cos()).max(0.0), 1.0)
    } else {
        (1.0, ((-p * PI / 2.0).cos()).max(0.0))
    }
}

// ───────────────────────────── Meter / Detektor ─────────────────────────────

/// Detektorwerte eines Kanals (dB, FS = 0 dB) — vom Audio-Thread
/// geschrieben, von AutoMix/Ducking/UI gelesen. Alle Werte stammen aus dem
/// Signal *nach* HPF/EQ, aber *vor* Gate/Kompressor/Fader.
#[derive(Default)]
pub struct Meters {
    pub peak_db: AtomicF32,
    /// ~50 ms RMS.
    pub rms_db: AtomicF32,
    /// ~400 ms (Short-Term-Energie).
    pub short_db: AtomicF32,
    /// RMS im Sprachband (300–3400 Hz).
    pub speech_db: AtomicF32,
    pub comp_gr_db: AtomicF32,
    pub gate_gr_db: AtomicF32,
    /// Pegel nach der Bearbeitung (vor Fader).
    pub post_rms_db: AtomicF32,
    /// Zeitstempel der letzten Aktualisierung (ms, monotone Uhr) — dient
    /// der Engine als Ausfallerkennung des Detektors.
    pub updated_ms: AtomicU64,
}

pub fn now_ms() -> u64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static T0: OnceLock<Instant> = OnceLock::new();
    // Offset, damit 0 als "noch nie" (z. B. `engine_beat_ms`) unterscheidbar bleibt.
    T0.get_or_init(Instant::now).elapsed().as_millis() as u64 + 100_000
}

impl Meters {
    pub fn new() -> Self {
        let m = Meters::default();
        for a in [&m.peak_db, &m.rms_db, &m.short_db, &m.speech_db, &m.post_rms_db] {
            a.set(-120.0);
        }
        m
    }
}

struct Detector {
    sq_fast: f64,
    sq_short: f64,
    sq_speech: f64,
    speech_hp: Biquad,
    speech_lp: Biquad,
    k_fast: f64,
    k_short: f64,
}

impl Detector {
    fn new() -> Self {
        let mut hp = Biquad::identity();
        hp.set(FilterKind::HighPass, 300.0, FRAC_1_SQRT_2, 0.0);
        // Tiefpass als gespiegelter Hochpass ist nicht nötig: einfacher
        // Sprachband-Näherung genügt hier ein zweiter Hochpass bei 3400 Hz
        // abgezogen — wir nutzen stattdessen ein HighShelf-Dämpfen.
        let mut lp = Biquad::identity();
        lp.set(FilterKind::HighShelf, 3400.0, FRAC_1_SQRT_2, -18.0);
        Detector {
            sq_fast: 0.0,
            sq_short: 0.0,
            sq_speech: 0.0,
            speech_hp: hp,
            speech_lp: lp,
            k_fast: smooth_coeff(50.0),
            k_short: smooth_coeff(400.0),
        }
    }
}

// ───────────────────────────── Verarbeitungsstufe ─────────────────────────────

/// Alle Bearbeitungsparameter eines Kanals (Config + Audio-State, ohne
/// Fader/Routing).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct ProcParams {
    pub eq: EqParams,
    pub comp: CompParams,
    pub gate: GateParams,
    pub delay_enabled: bool,
    pub delay_ms: f64,
    pub pan: f64,
    /// Polaritätsumkehr (Phase) am Kanaleingang.
    pub phase_invert: bool,
}

impl Default for ProcParams {
    fn default() -> Self {
        ProcParams {
            eq: EqParams::default(),
            comp: CompParams::default(),
            gate: GateParams::default(),
            delay_enabled: false,
            delay_ms: 0.0,
            pan: 0.0,
            phase_invert: false,
        }
    }
}

pub struct ProcStage {
    eq: Eq,
    gate: Gate,
    comp: Compressor,
    delay: Delay,
    det: Detector,
    pan_l: f64,
    pan_r: f64,
    params: ProcParams,
}

impl ProcStage {
    pub fn new() -> Self {
        ProcStage {
            eq: Eq::new(),
            gate: Gate::new(),
            comp: Compressor::new(),
            delay: Delay::new(),
            det: Detector::new(),
            pan_l: 1.0,
            pan_r: 1.0,
            params: ProcParams::default(),
        }
    }

    pub fn set_params(&mut self, p: ProcParams) {
        if p.eq != self.params.eq {
            self.eq.set(p.eq);
        }
        if p.gate != self.params.gate {
            self.gate.set(p.gate);
        }
        if p.comp != self.params.comp {
            self.comp.set(p.comp);
        }
        if p.delay_enabled != self.params.delay_enabled || p.delay_ms != self.params.delay_ms {
            self.delay.set(p.delay_enabled, p.delay_ms);
        }
        self.params = p;
    }

    /// Bearbeitet `buf` (interleaved L/R) in place und aktualisiert `meters`.
    pub fn process(&mut self, buf: &mut [f32], meters: &Meters) {
        let frames = buf.len() / CH;
        if frames == 0 {
            return;
        }
        let (tl, tr) = pan_gains(self.params.pan);
        let (mut gl, mut gr) = (self.pan_l, self.pan_r);
        let (dl, dr) = ((tl - gl) / frames as f64, (tr - gr) / frames as f64);
        let mut peak = 0f64;
        let mut sum_pre = 0f64;
        let mut sum_post = 0f64;
        let mut min_comp = 0f64;
        let mut min_gate = 0f64;
        for n in 0..frames {
            let pol = if self.params.phase_invert { -1.0 } else { 1.0 };
            let l = self.eq.process(0, buf[n * CH] as f64 * pol);
            let r = self.eq.process(1, buf[n * CH + 1] as f64 * pol);

            // Detektor (vor Dynamik).
            peak = peak.max(l.abs()).max(r.abs());
            let e = 0.5 * (l * l + r * r);
            sum_pre += e;
            let d = &mut self.det;
            d.sq_fast = d.k_fast * d.sq_fast + (1.0 - d.k_fast) * e;
            d.sq_short = d.k_short * d.sq_short + (1.0 - d.k_short) * e;
            let m = 0.5 * (l + r);
            let s = d.speech_lp.process(0, d.speech_hp.process(0, m));
            d.sq_speech = d.k_fast * d.sq_speech + (1.0 - d.k_fast) * s * s;

            let g_gate = self.gate.frame(l, r);
            let (l2, r2) = (l * g_gate, r * g_gate);
            let g_comp = self.comp.frame(l2, r2);
            min_gate = min_gate.min(self.gate.gain_db);
            min_comp = min_comp.min(self.comp.gr_db);
            let out = self.delay.frame([(l2 * g_comp) as f32, (r2 * g_comp) as f32]);
            gl += dl;
            gr += dr;
            let (ol, or) = (out[0] as f64 * gl, out[1] as f64 * gr);
            sum_post += 0.5 * (ol * ol + or * or);
            buf[n * CH] = ol as f32;
            buf[n * CH + 1] = or as f32;
        }
        self.pan_l = tl;
        self.pan_r = tr;
        let nf = frames as f64;
        meters.peak_db.set(lin_to_db(peak) as f32);
        meters.rms_db.set(lin_to_db((self.det.sq_fast).sqrt()) as f32);
        meters.short_db.set(lin_to_db((self.det.sq_short).sqrt()) as f32);
        meters.speech_db.set(lin_to_db((self.det.sq_speech).sqrt()) as f32);
        meters.post_rms_db.set(lin_to_db((sum_post / nf).sqrt()) as f32);
        let _ = sum_pre;
        meters.comp_gr_db.set(min_comp as f32);
        meters.gate_gr_db.set(min_gate as f32);
        meters.updated_ms.store(now_ms(), Ordering::Relaxed);
    }
}

/// Zwischen Control-Pfad, Engine-Thread und Audio-Thread geteilter
/// Kanalzustand. Audio-Thread liest nur (Parameter hinter kurzem Lock mit
/// Versionszähler, Gains als Atomics) und schreibt die Meter.
pub struct ChannelShared {
    params: std::sync::Mutex<ProcParams>,
    version: AtomicU64,
    pub meters: Meters,
    /// Manueller Fader (dB).
    pub fader_db: AtomicF32,
    pub muted: std::sync::atomic::AtomicBool,
    /// Anteil des AutoMix (dB, ≤ 0) und des Duckings (dB, ≤ 0) — von der
    /// Engine geschrieben, getrennt vom Fader, damit die UI die Ursache
    /// einer Pegeländerung unterscheiden kann.
    pub auto_db: AtomicF32,
    pub duck_db: AtomicF32,
    /// Gruppen-Fader/-Mute (von der Engine aus der Gruppenkonfiguration
    /// geschrieben) — additiv zum individuellen Fader, der unverändert bleibt.
    pub group_db: AtomicF32,
    pub group_muted: std::sync::atomic::AtomicBool,
    /// Lebenszeichen der Automations-Engine (ms, `now_ms`). Ist es älter als
    /// [`ENGINE_TIMEOUT_MS`], ignoriert die Fader-Stufe AutoMix/Ducking
    /// (Fail-Safe: Fader bleibt der manuelle Wert, keine hängenden Anteile).
    pub engine_beat_ms: AtomicU64,
    /// Kanal ist auf den Programm-Bus geroutet. Aux-Sends bleiben davon
    /// unberührt (ein Kanal kann nur auf Aux/N-1 laufen).
    pub main_route: std::sync::atomic::AtomicBool,
    /// Abgeleitet (Engine): tatsächlich hörbar im Programm (`rules::on_air`).
    pub on_air: std::sync::atomic::AtomicBool,
    /// Aux-Sends dieses Kanals (Schlüssel = Aux-ID).
    sends: std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<SendShared>>>,
}

pub const ENGINE_TIMEOUT_MS: u64 = 1000;

/// Zustand eines Aux-Sends (Kanal → Aux-Bus), vom Audio-Thread der
/// Send-Probe gelesen. Es gibt nur einen Abgriff (nach der Bearbeitung,
/// vor dem Fader): *Pre-Fader* nutzt das Signal unverändert, *Post-Fader*
/// multipliziert den aktuellen Fader-Gesamtgain (Fader · Mute · AutoMix ·
/// Ducking · Gruppe) darauf — dadurch folgt ein Post-Send exakt dem, was
/// im Programm hörbar ist, und ein Pre-Send bleibt davon unberührt.
pub struct SendShared {
    pub enabled: std::sync::atomic::AtomicBool,
    pub level_db: AtomicF32,
    pub post: std::sync::atomic::AtomicBool,
}

impl SendShared {
    pub fn new() -> Self {
        SendShared {
            enabled: std::sync::atomic::AtomicBool::new(false),
            level_db: AtomicF32::new(0.0),
            post: std::sync::atomic::AtomicBool::new(true),
        }
    }

    /// Ziel-Gain (linear) dieses Sends für den aktuellen Kanalzustand.
    pub fn target_gain(&self, ch: &ChannelShared) -> f64 {
        if !self.enabled.load(Ordering::Relaxed) {
            return 0.0;
        }
        let post = if self.post.load(Ordering::Relaxed) { ch.total_gain() } else { 1.0 };
        db_to_lin(self.level_db.get() as f64) * post
    }
}

impl Default for SendShared {
    fn default() -> Self {
        Self::new()
    }
}

impl ChannelShared {
    pub fn new() -> Self {
        ChannelShared {
            params: std::sync::Mutex::new(ProcParams::default()),
            version: AtomicU64::new(1),
            meters: Meters::new(),
            fader_db: AtomicF32::new(0.0),
            muted: std::sync::atomic::AtomicBool::new(false),
            auto_db: AtomicF32::new(0.0),
            duck_db: AtomicF32::new(0.0),
            group_db: AtomicF32::new(0.0),
            group_muted: std::sync::atomic::AtomicBool::new(false),
            engine_beat_ms: AtomicU64::new(0),
            main_route: std::sync::atomic::AtomicBool::new(true),
            on_air: std::sync::atomic::AtomicBool::new(false),
            sends: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Send-Zustand für `aux_id` (wird bei Bedarf angelegt).
    pub fn send(&self, aux_id: &str) -> std::sync::Arc<SendShared> {
        self.sends
            .lock()
            .expect("lock poisoned")
            .entry(aux_id.to_string())
            .or_insert_with(|| std::sync::Arc::new(SendShared::new()))
            .clone()
    }

    /// Alle Sends, die aktuell eingeschaltet sind (Aux-ID).
    pub fn enabled_sends(&self) -> Vec<String> {
        self.sends
            .lock()
            .expect("lock poisoned")
            .iter()
            .filter(|(_, s)| s.enabled.load(Ordering::Relaxed))
            .map(|(k, _)| k.clone())
            .collect()
    }

    pub fn set_params(&self, p: ProcParams) {
        *self.params.lock().expect("lock poisoned") = p;
        self.version.fetch_add(1, Ordering::Release);
    }

    /// Audio-Thread: übernimmt neue Parameter, falls sich die Version geändert hat.
    pub fn refresh(&self, stage: &mut ProcStage, seen: &mut u64) {
        let v = self.version.load(Ordering::Acquire);
        if v != *seen {
            let p = *self.params.lock().expect("lock poisoned");
            stage.set_params(p);
            *seen = v;
        }
    }

    /// Lebt die Automations-Engine (für diesen Kanal)?
    pub fn engine_alive(&self) -> bool {
        now_ms().saturating_sub(self.engine_beat_ms.load(Ordering::Relaxed)) < ENGINE_TIMEOUT_MS
    }

    /// Gain Richtung Programm-Bus: wie [`total_gain`](Self::total_gain),
    /// aber 0 ohne Programm-Routing.
    pub fn main_gain(&self) -> f64 {
        if self.main_route.load(Ordering::Relaxed) { self.total_gain() } else { 0.0 }
    }

    /// Effektiver Pegel (dB) im Programm vor dem Routing: Fader + Gruppe +
    /// AutoMix + Ducking (`-inf`-Ersatz −120 bei Mute) — Eingang der On-Air-Ableitung.
    pub fn effective_db(&self) -> f64 {
        let g = self.total_gain();
        if g <= 0.0 { -120.0 } else { lin_to_db(g) }
    }

    /// Gesamtgain der Fader-Stufe (linear): Fader + Gruppe (+ AutoMix +
    /// Ducking, solange die Engine lebt). Mute (Kanal oder Gruppe) = Stille.
    pub fn total_gain(&self) -> f64 {
        if self.muted.load(Ordering::Relaxed) || self.group_muted.load(Ordering::Relaxed) {
            return 0.0;
        }
        let mut db = self.fader_db.get() as f64;
        if self.engine_alive() {
            db += self.group_db.get() as f64 + self.auto_db.get() as f64 + self.duck_db.get() as f64;
        }
        db_to_lin(db)
    }
}

// ───────────────────────────── Fader-Stufe ─────────────────────────────

/// Geglätteter Endgain: Fader · Mute · AutoMix · Ducking. Die vier
/// Anteile bleiben getrennt lesbar (UI: manuell ≠ AutoMix ≠ Duck).
pub struct FaderStage {
    last: f64,
}

impl FaderStage {
    pub fn new() -> Self {
        FaderStage { last: 1.0 }
    }

    /// Rampt linear über den Buffer vom letzten zum neuen Gesamtgain
    /// (kein Zipper-Rauschen bei Fader-/Engine-Änderungen).
    pub fn process(&mut self, buf: &mut [f32], target: f64) {
        let frames = buf.len() / CH;
        if frames == 0 {
            return;
        }
        if (target - self.last).abs() < 1e-9 && (target - 1.0).abs() < 1e-9 {
            return;
        }
        let step = (target - self.last) / frames as f64;
        let mut g = self.last;
        for n in 0..frames {
            g += step;
            buf[n * CH] = (buf[n * CH] as f64 * g) as f32;
            buf[n * CH + 1] = (buf[n * CH + 1] as f64 * g) as f32;
        }
        self.last = target;
    }
}

/// Master-Limiter/-Kompressor (gleiche Kompressor-Mathematik wie pro Kanal).
pub struct MasterStage {
    comp: Compressor,
    params: CompParams,
}

impl MasterStage {
    pub fn new() -> Self {
        MasterStage { comp: Compressor::new(), params: CompParams::default() }
    }
    pub fn set(&mut self, p: CompParams) {
        if p != self.params {
            self.comp.set(p);
            self.params = p;
        }
    }
    pub fn process(&mut self, buf: &mut [f32], gr_out: &AtomicF32) {
        let frames = buf.len() / CH;
        let mut min_gr = 0f64;
        for n in 0..frames {
            let g = self.comp.frame(buf[n * CH] as f64, buf[n * CH + 1] as f64);
            min_gr = min_gr.min(self.comp.gr_db);
            buf[n * CH] = (buf[n * CH] as f64 * g) as f32;
            buf[n * CH + 1] = (buf[n * CH + 1] as f64 * g) as f32;
        }
        gr_out.set(min_gr as f32);
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;

    fn sine(freq: f64, amp: f64, frames: usize, offset: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|n| {
                let v = (amp * (2.0 * PI * freq * (n + offset) as f64 / FS).sin()) as f32;
                [v, v]
            })
            .collect()
    }

    fn rms_db(buf: &[f32]) -> f64 {
        let s: f64 = buf.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / buf.len() as f64;
        lin_to_db(s.sqrt())
    }

    /// Lässt `stage` ~1 s Signal verarbeiten und liefert den RMS-Pegel des letzten Buffers.
    fn run(stage: &mut ProcStage, freq: f64, amp: f64) -> f64 {
        let meters = Meters::new();
        let mut last = vec![];
        for i in 0..100 {
            let mut b = sine(freq, amp, 480, i * 480);
            stage.process(&mut b, &meters);
            last = b;
        }
        rms_db(&last)
    }

    #[test]
    fn phase_invert_flips_polarity_exactly() {
        let mut p = ProcParams::default();
        p.phase_invert = true;
        let mut s = ProcStage::new();
        s.set_params(p);
        let input = sine(440.0, 0.5, 480, 0);
        let mut b = input.clone();
        s.process(&mut b, &Meters::new());
        for (a, b) in input.iter().zip(&b) {
            assert!((a + b).abs() < 1e-6);
        }
    }

    #[test]
    fn neutral_stage_is_transparent() {
        let mut s = ProcStage::new();
        let input = sine(1000.0, 0.5, 480, 0);
        let mut b = input.clone();
        s.process(&mut b, &Meters::new());
        for (a, b) in input.iter().zip(&b) {
            assert!((a - b).abs() < 1e-6);
        }
    }

    #[test]
    fn eq_peak_boosts_at_center_frequency() {
        let mut s = ProcStage::new();
        let mut p = ProcParams::default();
        p.eq.bands[1].gain_db = 9.0;
        s.set_params(p);
        let flat = rms_db(&sine(1000.0, 0.1, 480, 0));
        let boosted = run(&mut s, 1000.0, 0.1);
        assert!((boosted - flat - 9.0).abs() < 0.6, "boost {}", boosted - flat);
    }

    #[test]
    fn eq_shelves_act_on_their_side() {
        let mut p = ProcParams::default();
        p.eq.bands[0].gain_db = -12.0;
        p.eq.bands[3].gain_db = 6.0;
        let mut s = ProcStage::new();
        s.set_params(p);
        let low = run(&mut s, 30.0, 0.1) - rms_db(&sine(30.0, 0.1, 480, 0));
        let mut s = ProcStage::new();
        s.set_params(p);
        let high = run(&mut s, 15000.0, 0.1) - rms_db(&sine(15000.0, 0.1, 480, 0));
        assert!(low < -9.0, "low {low}");
        assert!(high > 4.0, "high {high}");
    }

    #[test]
    fn eq_highpass_attenuates_below_cutoff_and_bypass_disables() {
        let mut p = ProcParams::default();
        p.eq.hp_enabled = true;
        p.eq.hp_freq = 200.0;
        let mut s = ProcStage::new();
        s.set_params(p);
        let atten = run(&mut s, 50.0, 0.1) - rms_db(&sine(50.0, 0.1, 480, 0));
        assert!(atten < -20.0, "{atten}");
        p.eq.bypass = true;
        let mut s = ProcStage::new();
        s.set_params(p);
        let through = run(&mut s, 50.0, 0.1) - rms_db(&sine(50.0, 0.1, 480, 0));
        assert!(through.abs() < 0.1);
    }

    #[test]
    fn compressor_reduces_by_ratio_and_reports_gr() {
        let mut p = ProcParams::default();
        p.comp = CompParams {
            enabled: true,
            threshold_db: -20.0,
            ratio: 4.0,
            attack_ms: 1.0,
            release_ms: 50.0,
            knee_db: 0.0,
            makeup_db: 0.0,
            rms: true,
        };
        let mut s = ProcStage::new();
        s.set_params(p);
        let meters = Meters::new();
        let amp = db_to_lin(-6.0 + 3.0103); // RMS −6 dBFS (Sinus: Amp = RMS·√2)
        let mut last = vec![];
        for i in 0..200 {
            let mut b = sine(1000.0, amp, 480, i * 480);
            s.process(&mut b, &meters);
            last = b;
        }
        // Eingang −6 dB RMS, 14 dB über Threshold → bei 4:1 bleiben 3.5 dB → −16.5 dB.
        let out = rms_db(&last);
        assert!((out - (-16.5)).abs() < 1.0, "out {out}");
        assert!(meters.comp_gr_db.get() < -9.0, "gr {}", meters.comp_gr_db.get());
    }

    #[test]
    fn compressor_makeup_and_bypass() {
        let mut p = ProcParams::default();
        p.comp.enabled = true;
        p.comp.threshold_db = 0.0; // nichts über Threshold
        p.comp.makeup_db = 6.0;
        let mut s = ProcStage::new();
        s.set_params(p);
        let up = run(&mut s, 1000.0, 0.05) - rms_db(&sine(1000.0, 0.05, 480, 0));
        assert!((up - 6.0).abs() < 0.3, "{up}");
        p.comp.enabled = false;
        let mut s = ProcStage::new();
        s.set_params(p);
        let off = run(&mut s, 1000.0, 0.05) - rms_db(&sine(1000.0, 0.05, 480, 0));
        assert!(off.abs() < 0.1);
    }

    #[test]
    fn compressor_soft_knee_is_between_hard_and_none() {
        let mut c = Compressor::new();
        let mut p = CompParams::default();
        p.threshold_db = -20.0;
        p.ratio = 4.0;
        p.knee_db = 10.0;
        c.set(p);
        let at_thr = c.static_gain_db(-20.0);
        assert!(at_thr < 0.0 && at_thr > -1.0, "{at_thr}");
        assert_eq!(c.static_gain_db(-40.0), 0.0);
        p.knee_db = 0.0;
        c.set(p);
        assert!((c.static_gain_db(0.0) - (-15.0)).abs() < 1e-9);
    }

    #[test]
    fn gate_closes_below_threshold_with_range_and_opens_again() {
        let mut p = ProcParams::default();
        p.gate = GateParams {
            enabled: true,
            threshold_db: -40.0,
            range_db: -30.0,
            ratio: 100.0,
            attack_ms: 1.0,
            hold_ms: 10.0,
            release_ms: 20.0,
            hysteresis_db: 3.0,
        };
        let mut s = ProcStage::new();
        s.set_params(p);
        let quiet = run(&mut s, 1000.0, db_to_lin(-60.0));
        let quiet_in = -60.0 - 3.0103;
        assert!((quiet - (quiet_in - 30.0)).abs() < 2.0, "quiet {quiet}");
        let loud = run(&mut s, 1000.0, 0.3);
        assert!((loud - rms_db(&sine(1000.0, 0.3, 480, 0))).abs() < 0.5, "loud {loud}");
    }

    #[test]
    fn expander_is_gentler_than_gate() {
        let mut gp = ProcParams::default();
        gp.gate = GateParams { enabled: true, threshold_db: -40.0, range_db: -40.0, ratio: 100.0, ..GateParams::default() };
        let mut ep = gp;
        ep.gate.ratio = 1.5;
        let amp = db_to_lin(-50.0);
        let mut a = ProcStage::new();
        a.set_params(gp);
        let mut b = ProcStage::new();
        b.set_params(ep);
        assert!(run(&mut b, 1000.0, amp) > run(&mut a, 1000.0, amp) + 5.0);
    }

    #[test]
    fn delay_shifts_signal_by_exact_samples() {
        let mut p = ProcParams::default();
        p.delay_enabled = true;
        p.delay_ms = 10.0; // 480 Samples
        let mut s = ProcStage::new();
        s.set_params(p);
        let meters = Meters::new();
        let mut out_all = vec![];
        let mut in_all = vec![];
        for i in 0..20 {
            let mut b = sine(440.0, 0.5, 480, i * 480);
            in_all.extend_from_slice(&b);
            s.process(&mut b, &meters);
            out_all.extend_from_slice(&b);
        }
        // Nach Abschluss der Überblendung (480 Frames) entspricht out[n] = in[n−480].
        let n0 = 5000;
        for n in n0..n0 + 100 {
            assert!((out_all[n * CH] - in_all[(n - 480) * CH]).abs() < 1e-4);
        }
    }

    #[test]
    fn delay_disabled_is_bit_transparent() {
        let mut p = ProcParams::default();
        p.delay_ms = 100.0;
        p.delay_enabled = false;
        let mut s = ProcStage::new();
        s.set_params(p);
        let input = sine(440.0, 0.5, 480, 0);
        let mut b = input.clone();
        s.process(&mut b, &Meters::new());
        assert_eq!(input, b);
    }

    #[test]
    fn pan_center_left_right_and_continuous() {
        assert_eq!(pan_gains(0.0), (1.0, 1.0));
        let (l, r) = pan_gains(-1.0);
        assert_eq!(l, 1.0);
        assert!(r < 1e-9);
        let (l, r) = pan_gains(1.0);
        assert!(l < 1e-9 && r == 1.0);
        let (l, _) = pan_gains(0.5);
        assert!(l > 0.0 && l < 1.0);
        let mut p = ProcParams::default();
        p.pan = 1.0;
        let mut s = ProcStage::new();
        s.set_params(p);
        let meters = Meters::new();
        let mut last = vec![];
        for i in 0..10 {
            let mut b = sine(440.0, 0.5, 480, i * 480);
            s.process(&mut b, &meters);
            last = b;
        }
        let left: Vec<f32> = last.iter().step_by(2).cloned().collect();
        assert!(left.iter().all(|x| x.abs() < 1e-3));
    }

    #[test]
    fn fader_stage_ramps_without_jump() {
        let mut f = FaderStage::new();
        let mut b = vec![1.0f32; 960];
        f.process(&mut b, 0.0);
        assert!(b[0] > 0.99);
        assert!(b[b.len() - 2].abs() < 0.01);
        // monoton fallend
        for w in b.chunks(2).collect::<Vec<_>>().windows(2) {
            assert!(w[1][0] <= w[0][0] + 1e-6);
        }
        let mut b2 = vec![1.0f32; 960];
        f.process(&mut b2, 0.0);
        assert!(b2.iter().all(|x| x.abs() < 1e-6));
    }

    #[test]
    fn total_gain_adds_parts_while_engine_lives_and_falls_back_to_fader_when_it_dies() {
        let sh = ChannelShared::new();
        sh.fader_db.set(-6.0);
        sh.auto_db.set(-10.0);
        sh.duck_db.set(-4.0);
        // Engine nie gestartet / ausgefallen → nur manueller Fader.
        assert!((lin_to_db(sh.total_gain()) - -6.0).abs() < 1e-4);
        sh.engine_beat_ms.store(now_ms(), Ordering::Relaxed);
        assert!((lin_to_db(sh.total_gain()) - -20.0).abs() < 1e-3);
        // Gruppe additiv, Mute dominiert.
        sh.group_db.set(-3.0);
        assert!((lin_to_db(sh.total_gain()) - -23.0).abs() < 1e-3);
        sh.group_muted.store(true, Ordering::Relaxed);
        assert_eq!(sh.total_gain(), 0.0);
        sh.group_muted.store(false, Ordering::Relaxed);
        sh.muted.store(true, Ordering::Relaxed);
        assert_eq!(sh.total_gain(), 0.0);
    }

    #[test]
    fn main_route_silences_program_but_not_post_sends() {
        let sh = ChannelShared::new();
        assert!((sh.main_gain() - 1.0).abs() < 1e-9);
        sh.main_route.store(false, Ordering::Relaxed);
        assert_eq!(sh.main_gain(), 0.0, "nicht auf Programm geroutet");
        let send = SendShared::new();
        send.enabled.store(true, Ordering::Relaxed);
        assert!((send.target_gain(&sh) - 1.0).abs() < 1e-9, "Post-Aux folgt weiter dem Fader");
        sh.muted.store(true, Ordering::Relaxed);
        assert_eq!(sh.effective_db(), -120.0);
    }

    #[test]
    fn send_pre_ignores_fader_and_mute_post_follows_them() {
        let ch = ChannelShared::new();
        let pre = SendShared::new();
        pre.enabled.store(true, Ordering::Relaxed);
        pre.post.store(false, Ordering::Relaxed);
        pre.level_db.set(-6.0);
        let post = SendShared::new();
        post.enabled.store(true, Ordering::Relaxed);
        post.post.store(true, Ordering::Relaxed);
        post.level_db.set(-6.0);

        let want = db_to_lin(-6.0);
        ch.fader_db.set(-20.0);
        assert!((pre.target_gain(&ch) - want).abs() < 1e-9, "Pre unabhängig vom Fader");
        assert!((post.target_gain(&ch) - want * db_to_lin(-20.0)).abs() < 1e-9, "Post folgt dem Fader");
        ch.muted.store(true, Ordering::Relaxed);
        assert!((pre.target_gain(&ch) - want).abs() < 1e-9, "Pre hört auch bei Mute");
        assert_eq!(post.target_gain(&ch), 0.0, "Post stumm bei Mute");
        pre.enabled.store(false, Ordering::Relaxed);
        assert_eq!(pre.target_gain(&ch), 0.0);
        // Post folgt auch AutoMix/Ducking, solange die Engine lebt.
        ch.muted.store(false, Ordering::Relaxed);
        ch.fader_db.set(0.0);
        ch.auto_db.set(-10.0);
        ch.engine_beat_ms.store(now_ms(), Ordering::Relaxed);
        assert!((post.target_gain(&ch) - want * db_to_lin(-10.0)).abs() < 1e-9);
    }

    #[test]
    fn detector_reports_levels_and_freshness() {
        let mut s = ProcStage::new();
        let meters = Meters::new();
        for i in 0..50 {
            let mut b = sine(1000.0, 0.5, 480, i * 480);
            s.process(&mut b, &meters);
        }
        assert!((meters.rms_db.get() as f64 - (-9.0)).abs() < 0.5);
        assert!(meters.peak_db.get() > -7.0);
        assert!(meters.speech_db.get() > -20.0);
        assert!(now_ms() - meters.updated_ms.load(Ordering::Relaxed) < 1000);
    }
}

