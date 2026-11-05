//! Reine Verzögerungslogik von `omp-audio-delay` (Radio, Kapitel 89/RA3) — ohne GStreamer und MXL, vollständig testbar.
//!
//! **Modell** (wie `omp-playout-buffer/buffer.rs`, nur für reinen Ton): Der Ausgang läuft auf einer **eigenen Uhr** (ein Block je
//! Takt) und wird nie vom Eingang getrieben. Zwischen beiden liegt ein Ring, dessen Füllstand die **Verzögerung** ist.
//!
//! * `Fill`: Vorlauf. Der Ausgang liefert Notquelle bzw. Stille, bis der Ring `target` Frames hält.
//! * `Run`: je Takt ein Block aus dem Ring (Verzögerung = Füllstand).
//! * `Hold`: Der Ring ist leer gelaufen (Eingang weg). Der Ausgang liefert Notquelle bzw. Stille, bis der Ring wieder `target` hält.
//!
//! **Dump** (Sprung nach vorn): wirft die ältesten `ms` weg — die Verzögerung schrumpft sofort, der Übergang wird über wenige
//! Millisekunden überblendet (kein Knacken). **Wiederaufbau:** liegt der Füllstand unter dem Ziel, liest `Run` mit
//! `1 − permille/1000` der Eingangsgeschwindigkeit (lineare Interpolation, ±1 % Tonhöhe, Standard 10 ‰): das Material wird
//! gedehnt, der Ring füllt sich wieder — ohne Lücke, bis das Ziel erreicht ist. Liegt der Füllstand über dem Ziel (Ziel wurde gesenkt),
//! läuft derselbe Mechanismus rückwärts (1 + permille/1000).
//!
//! Alle Frames sind **Stereo, interleaved, f32**.

use std::collections::VecDeque;

/// Kanalzahl (Stereo-Programmton).
pub const CH: usize = 2;
/// Länge der Überblendung bei Sprüngen und Übergängen (Frames, 5 ms bei 48 kHz).
const XFADE: usize = 240;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Fill,
    Run,
    Hold,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Fill => "fill",
            State::Run => "run",
            State::Hold => "hold",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub sample_rate: u32,
    /// Ziel-Verzögerung in ms.
    pub target_ms: u64,
    /// Obergrenze des Rings in ms (Speicher fest begrenzt, mindestens Ziel + Reserve).
    pub max_ms: u64,
    /// Geschwindigkeitsabweichung beim Wiederaufbau in Promille (10 = 1 %).
    pub rebuild_permille: u32,
}

#[derive(Default, Clone, Debug)]
pub struct Stats {
    pub dumped_frames: u64,
    pub overflow_dropped_frames: u64,
    pub underruns: u64,
}

struct Fade {
    /// Die Frames, die ohne Sprung als Nächstes gespielt worden wären (interleaved).
    tail: Vec<f32>,
    done: usize,
}

pub struct DelayLine {
    cfg: Config,
    ring: VecDeque<f32>,
    state: State,
    target_frames: usize,
    /// Bruchteil zwischen `ring[0]` und `ring[1]` (Lesestelle beim Wiederaufbau).
    pos: f64,
    fade: Option<Fade>,
    /// Einblende-Rampe nach Fill/Hold (Frames verbleibend).
    fade_in: usize,
    /// Füllstand zu Beginn des letzten Ausgangsblocks = Verzögerung des ersten Ausgangsframes (Frames).
    delay_frames: usize,
    pub stats: Stats,
}

impl DelayLine {
    pub fn new(cfg: Config) -> DelayLine {
        let target_frames = Self::ms_to_frames(&cfg, cfg.target_ms);
        DelayLine { cfg, ring: VecDeque::new(), state: State::Fill, target_frames, pos: 0.0, fade: None, fade_in: 0, delay_frames: 0, stats: Stats::default() }
    }

    fn ms_to_frames(cfg: &Config, ms: u64) -> usize {
        (ms as u128 * cfg.sample_rate as u128 / 1000) as usize
    }

    pub fn state(&self) -> State {
        self.state
    }

    /// Füllstand in Frames (= aktuelle Verzögerung des nächsten Ausgangsframes).
    pub fn level_frames(&self) -> usize {
        self.ring.len() / CH
    }

    /// Verzögerung des zuletzt ausgegebenen Blocks in Frames: Füllstand **vor** dem Lesen (Eingangsstand − erste gelesene Stelle).
    /// Im Gleichgewicht ist sie das Ziel; sie ist die Größe, nach der Aufbau und Abbau entscheiden.
    #[cfg(test)]
    pub fn delay_frames(&self) -> usize {
        self.delay_frames
    }

    pub fn delay_ms(&self) -> f64 {
        self.delay_frames as f64 * 1000.0 / self.cfg.sample_rate as f64
    }

    pub fn rebuild_permille(&self) -> u32 {
        self.cfg.rebuild_permille
    }

    pub fn set_rebuild_permille(&mut self, p: u32) {
        self.cfg.rebuild_permille = p.clamp(1, 50);
    }

    pub fn target_ms(&self) -> u64 {
        self.cfg.target_ms
    }

    /// Wiederaufbau (oder Abbau) läuft: die Verzögerung liegt außerhalb des Toleranzbands (±5 ms) um das Ziel.
    pub fn rebuilding(&self) -> bool {
        self.state == State::Run && self.rate_for(self.delay_frames) != 1.0
    }

    /// Neues Ziel. Wirkt über Wiederaufbau bzw. Abbau (kein Sprung); für einen Sprung `dump`.
    pub fn set_target_ms(&mut self, ms: u64) {
        self.cfg.target_ms = ms;
        self.target_frames = Self::ms_to_frames(&self.cfg, ms);
        if self.cfg.max_ms < ms + 1000 {
            self.cfg.max_ms = ms + 1000;
        }
    }

    /// Eingang: interleaved Stereo-Frames anhängen. Läuft der Ring über seine Grenze, fällt das Älteste weg (gezählt).
    pub fn push(&mut self, frames: &[f32]) {
        self.ring.extend(frames.iter().copied());
        let max = Self::ms_to_frames(&self.cfg, self.cfg.max_ms) * CH;
        if self.ring.len() > max {
            let drop = self.ring.len() - max;
            self.ring.drain(..drop);
            self.stats.overflow_dropped_frames += (drop / CH) as u64;
        }
    }

    /// Sprung nach vorn: wirft höchstens `ms` der ältesten Frames weg (es bleiben mindestens 2 Überblendlängen);
    /// liefert die tatsächlich verworfenen Frames. Der nächste Ausgang blendet über `XFADE` Frames vom alten auf den neuen Stand.
    pub fn dump(&mut self, ms: u64) -> usize {
        if self.state != State::Run {
            return 0;
        }
        let want = Self::ms_to_frames(&self.cfg, ms);
        let keep = XFADE * 2;
        let can = self.level_frames().saturating_sub(keep);
        let n = want.min(can);
        if n == 0 {
            return 0;
        }
        let tail_frames = XFADE.min(self.level_frames());
        let tail: Vec<f32> = self.ring.iter().take(tail_frames * CH).copied().collect();
        self.ring.drain(..n * CH);
        self.pos = 0.0;
        self.fade = Some(Fade { tail, done: 0 });
        self.stats.dumped_frames += n as u64;
        n
    }

    /// Ausgang: füllt `out` (interleaved, ganze Frames). `emergency` liefert bei Fill/Hold die Notquelle (sonst Stille).
    pub fn pull(&mut self, out: &mut [f32], emergency: Option<&mut dyn FnMut(&mut [f32])>) {
        debug_assert_eq!(out.len() % CH, 0);
        let n = out.len() / CH;
        if self.state == State::Fill && self.level_frames() >= self.target_frames {
            self.enter_run();
        }
        if self.state == State::Hold && self.level_frames() >= self.target_frames.max(1) {
            self.enter_run();
        }
        self.delay_frames = self.level_frames();
        if self.state == State::Run {
            let rate = self.rate_for(self.delay_frames);
            // Frames, die dieser Block mindestens braucht (+1 für die Interpolation)
            let need = (self.pos + n as f64 * rate).ceil() as usize + 2;
            if self.level_frames() < need {
                self.stats.underruns += 1;
                self.state = State::Hold;
                self.fade = None;
            }
        }
        match self.state {
            State::Run => self.read_block(out, n),
            State::Fill | State::Hold => {
                match emergency {
                    Some(f) => f(out),
                    None => out.fill(0.0),
                }
            }
        }
    }

    fn enter_run(&mut self) {
        self.state = State::Run;
        self.pos = 0.0;
        self.fade_in = XFADE;
    }

    /// Lesegeschwindigkeit gegenüber dem Eingang: < 1 = Aufbau (Dehnen), > 1 = Abbau (Raffen), 1 = Ziel erreicht.
    fn rate_for(&self, level: usize) -> f64 {
        let step = self.cfg.rebuild_permille as f64 / 1000.0;
        if level + XFADE < self.target_frames {
            1.0 - step
        } else if level > self.target_frames + XFADE {
            1.0 + step
        } else {
            1.0
        }
    }

    fn read_block(&mut self, out: &mut [f32], n: usize) {
        let rate = self.rate_for(self.delay_frames);
        for i in 0..n {
            // ring[0] und ring[1] sind garantiert vorhanden (need-Prüfung in pull)
            let (a0, a1) = (self.ring[0], self.ring[1]);
            let (b0, b1) = (self.ring[CH], self.ring[CH + 1]);
            let t = self.pos as f32;
            let mut l = a0 + (b0 - a0) * t;
            let mut r = a1 + (b1 - a1) * t;
            if let Some(f) = &mut self.fade {
                let k = f.done;
                if k < f.tail.len() / CH {
                    let w = (k as f32 + 1.0) / (XFADE as f32 + 1.0);
                    l = f.tail[k * CH] * (1.0 - w) + l * w;
                    r = f.tail[k * CH + 1] * (1.0 - w) + r * w;
                }
                f.done += 1;
                if f.done >= XFADE.min(f.tail.len() / CH) {
                    self.fade = None;
                }
            }
            if self.fade_in > 0 {
                let g = 1.0 - self.fade_in as f32 / (XFADE as f32 + 1.0);
                l *= g;
                r *= g;
                self.fade_in -= 1;
            }
            out[i * CH] = l;
            out[i * CH + 1] = r;
            self.pos += rate;
            while self.pos >= 1.0 {
                self.ring.drain(..CH);
                self.pos -= 1.0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;
    const BLK: usize = 480;

    fn cfg(target_ms: u64) -> Config {
        Config { sample_rate: SR, target_ms, max_ms: 30_000, rebuild_permille: 10 }
    }

    /// Eingang: Rampe — Frame k trägt den Wert k (links) und −k (rechts); damit lässt sich die Verzögerung exakt ablesen.
    struct Sim {
        d: DelayLine,
        next: u64,
        out: Vec<f32>,
    }

    impl Sim {
        fn new(target_ms: u64) -> Sim {
            Sim { d: DelayLine::new(cfg(target_ms)), next: 0, out: vec![0.0; BLK * CH] }
        }
        /// Ein Takt: Eingang liefert einen Block, der Ausgang holt einen.
        fn tick(&mut self, feed: bool) -> &[f32] {
            if feed {
                let mut b = Vec::with_capacity(BLK * CH);
                for _ in 0..BLK {
                    b.push(self.next as f32);
                    b.push(-(self.next as f32));
                    self.next += 1;
                }
                self.d.push(&b);
            }
            let mut o = std::mem::take(&mut self.out);
            self.d.pull(&mut o, None);
            self.out = o;
            &self.out
        }
        fn run(&mut self, ticks: usize) {
            for _ in 0..ticks {
                self.tick(true);
            }
        }
    }

    #[test]
    fn fills_then_delays_exactly_by_target() {
        let mut s = Sim::new(1000); // 48 000 Frames
        // Vorlauf: bis der Ring das Ziel hält, liefert der Ausgang Stille
        for _ in 0..100 {
            let o = s.tick(true).to_vec();
            if s.d.state() == State::Fill {
                assert!(o.iter().all(|v| *v == 0.0));
            }
        }
        assert_eq!(s.d.state(), State::Run);
        // Danach: Ausgang = Eingang um genau 48 000 Frames verzögert (Eingangsstand − erste gelesene Stelle)
        for _ in 0..60 {
            let o = s.tick(true).to_vec();
            if o[0] != 0.0 {
                assert_eq!(s.next - o[0] as u64, 48_000, "Verzögerung muss im Lauf konstant bleiben");
                // jeder Frame des Blocks hat dieselbe Verzögerung (kein Dehnen im Gleichgewicht)
                assert_eq!(o[(BLK - 1) * CH] - o[0], (BLK - 1) as f32);
                // Rechts = −Links (Kanäle bleiben zusammen)
                assert_eq!(o[1], -o[0]);
            }
        }
        assert_eq!(s.d.delay_frames(), 48_000);
        assert!(!s.d.rebuilding());
    }

    #[test]
    fn dump_shortens_delay_by_exactly_the_dumped_time_without_click() {
        let mut s = Sim::new(2000);
        s.run(300); // 3 s: Run, Füllstand 2 s
        assert_eq!(s.d.state(), State::Run);
        let before = s.d.level_frames();
        let n = s.d.dump(500);
        assert_eq!(n, 24_000);
        assert_eq!(s.d.level_frames(), before - 24_000);
        // der nächste Ausgangsblock überblendet; danach gilt: Ausgang springt um n Frames nach vorn
        let mut last = f32::NAN;
        let mut max_jump = 0.0f32;
        let mut first_after_fade = None;
        for k in 0..6 {
            let o = s.tick(true).to_vec();
            for i in 0..BLK {
                let v = o[i * CH];
                if !last.is_nan() {
                    max_jump = max_jump.max((v - last).abs());
                }
                last = v;
            }
            if k == 3 {
                first_after_fade = Some(o[0]);
            }
        }
        assert!(max_jump <= 24_001.0, "Überblendung: Sprung {max_jump}"); // ohne Überblendung wäre er genau 24 000+ in einem Frame
        // nach der Überblendung ist die Rampe wieder glatt (Schrittweite ≈ 1 bzw. 0,99 beim Aufbau)
        let o = s.tick(true).to_vec();
        for i in 1..BLK {
            let step = o[i * CH] - o[(i - 1) * CH];
            assert!((0.95..=1.05).contains(&step), "nach der Überblendung Schritt {step}");
        }
        assert!(first_after_fade.is_some());
    }

    #[test]
    fn dump_smooths_the_cut_with_a_crossfade_not_a_hard_jump() {
        let mut s = Sim::new(1000);
        s.run(200);
        s.d.dump(300);
        let o = s.tick(true).to_vec();
        // Überblendung über 240 Frames: Zwischenwerte liegen zwischen altem und neuem Stand (monoton steigend, kein Einzelsprung)
        let mut biggest = 0.0f32;
        for i in 1..XFADE {
            biggest = biggest.max((o[i * CH] - o[(i - 1) * CH]).abs());
        }
        assert!(biggest < 14_400.0 * 1.2, "größter Einzelschritt {biggest} (Gesamtsprung 14 400 über 240 Frames ≈ 60/Frame)");
        assert!(biggest < 200.0, "kein harter Sprung: {biggest}");
    }

    #[test]
    fn rebuild_after_dump_grows_the_delay_by_one_percent_and_stops_at_target() {
        let mut s = Sim::new(2000);
        s.run(300);
        assert_eq!(s.d.dump(500), 24_000);
        s.run(5);
        let l0 = s.d.delay_frames();
        assert!(s.d.rebuilding());
        // 10 s Echtzeit (1000 Takte): Aufbau um 1 % = 100 ms = 4 800 Frames
        s.run(1000);
        let gained = s.d.delay_frames() - l0;
        assert!((4_700..=4_900).contains(&gained), "Aufbau in 10 s: {gained} Frames (erwartet ≈ 4 800)");
        // bis zum Ziel: 500 ms bei 1 %/s → 50 s Gesamtzeit; danach hält der Füllstand das Ziel
        s.run(5000);
        let d = s.d.delay_frames();
        assert!((96_000 - XFADE..=96_000).contains(&d), "Ziel erreicht (Toleranzband ±5 ms): {d}");
        assert!(!s.d.rebuilding());
        let o = s.tick(true).to_vec();
        for i in 1..BLK {
            assert_eq!(o[i * CH] - o[(i - 1) * CH], 1.0, "nach dem Aufbau Wiedergabe in Originalgeschwindigkeit");
        }
    }

    #[test]
    fn lowering_the_target_shrinks_gradually() {
        let mut s = Sim::new(2000);
        s.run(300);
        s.d.set_target_ms(1000);
        s.run(1000); // 10 s
        let lost = 96_000 - s.d.delay_frames();
        assert!((4_700..=4_900).contains(&lost), "Abbau in 10 s: {lost} (erwartet ≈ 4 800)");
    }

    #[test]
    fn input_loss_plays_buffer_then_emergency_then_recovers() {
        let mut s = Sim::new(500); // 24 000 Frames
        s.run(100);
        assert_eq!(s.d.state(), State::Run);
        // Eingang weg: der Ring wird noch ~500 ms abgespielt (Überbrückung), dann Hold mit Notquelle
        let mut played_from_buffer = 0;
        let mut emergency_seen = false;
        let mut emerg = |o: &mut [f32]| o.fill(0.25);
        for _ in 0..80 {
            let mut o = vec![0.0f32; BLK * CH];
            s.d.pull(&mut o, Some(&mut emerg));
            if s.d.state() == State::Run {
                played_from_buffer += 1;
            } else if o.iter().all(|v| *v == 0.25) {
                emergency_seen = true;
            }
        }
        assert!((45..=50).contains(&played_from_buffer), "Überbrückung ≈ 50 Blöcke (500 ms), war {played_from_buffer}");
        assert!(emergency_seen);
        assert_eq!(s.d.state(), State::Hold);
        assert_eq!(s.d.stats.underruns, 1);
        // Eingang kommt zurück: erst wieder auffüllen (Notquelle läuft weiter), dann Run
        let mut steps = 0;
        while s.d.state() != State::Run && steps < 200 {
            s.tick(true);
            steps += 1;
        }
        assert_eq!(s.d.state(), State::Run);
        assert!((48..=52).contains(&steps), "Wiederaufbau auf 500 ms dauert ≈ 50 Takte, war {steps}");
    }

    #[test]
    fn ring_is_bounded() {
        let mut d = DelayLine::new(Config { sample_rate: SR, target_ms: 1000, max_ms: 2000, rebuild_permille: 10 });
        d.push(&vec![0.5; 48_000 * 5 * CH]); // 5 s auf einmal
        assert_eq!(d.level_frames(), 96_000);
        assert_eq!(d.stats.overflow_dropped_frames, 144_000);
    }

    #[test]
    fn dump_is_refused_outside_run_and_keeps_a_reserve() {
        let mut d = DelayLine::new(cfg(1000));
        assert_eq!(d.dump(500), 0, "im Fill kein Dump");
        let mut s = Sim::new(1000);
        s.run(120);
        let n = s.d.dump(10_000); // mehr als da ist
        assert!(n <= 48_000 - 2 * XFADE);
        assert!(s.d.level_frames() >= 2 * XFADE);
    }
}
