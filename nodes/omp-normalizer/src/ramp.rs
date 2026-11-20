//! Rampenplaner für die Verzögerung: ein geänderter Zielwert wird nie als Sprung übernommen, sondern mit begrenzter
//! Änderungsrate (‰ = ms Verzögerungsänderung je Sekunde). Einfrieren hält den Ist-Wert.

#[derive(Clone, Copy, Debug)]
pub struct Ramp {
    current_ms: f64,
    target_ms: f64,
    max_permille: f64,
    frozen: bool,
}

impl Ramp {
    pub fn new(current_ms: f64, max_permille: f64) -> Self {
        Ramp {
            current_ms,
            target_ms: current_ms,
            max_permille: max_permille.max(0.0),
            frozen: false,
        }
    }
    pub fn set_target(&mut self, ms: f64) {
        if ms.is_finite() {
            self.target_ms = ms.max(0.0);
        }
    }
    pub fn set_max_permille(&mut self, p: f64) {
        self.max_permille = p.max(0.0);
    }
    pub fn freeze(&mut self, on: bool) {
        self.frozen = on;
    }
    pub fn current_ms(&self) -> f64 {
        self.current_ms
    }
    pub fn target_ms(&self) -> f64 {
        self.target_ms
    }
    pub fn is_settled(&self) -> bool {
        (self.target_ms - self.current_ms).abs() < 1e-9
    }

    /// Ein Zeitschritt von `dt_s` Sekunden; gibt die neue Verzögerung zurück. Höchstens `max_permille · dt_s` ms.
    pub fn step(&mut self, dt_s: f64) -> f64 {
        if self.frozen || dt_s <= 0.0 {
            return self.current_ms;
        }
        let max_change = self.max_permille * dt_s; // ‰ = ms/s
        let diff = self.target_ms - self.current_ms;
        self.current_ms += diff.clamp(-max_change, max_change);
        self.current_ms
    }
}

/// Verzögerung eines Datenkanals (nicht-PCM): nur in ganzen Samples, nie interpoliert.
pub fn data_channel_samples(delay_ms: f64, sample_rate: u32) -> u64 {
    (delay_ms.max(0.0) * sample_rate as f64 / 1000.0).round() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn achtzig_ms_bei_ein_promille_dauern_mindestens_achtzig_sekunden() {
        let mut r = Ramp::new(0.0, 1.0);
        r.set_target(80.0);
        let mut t = 0.0;
        let mut prev = 0.0;
        while !r.is_settled() {
            let cur = r.step(1.0);
            assert!(cur - prev <= 1.0 + 1e-9, "kein Schritt > 1 ms/s");
            prev = cur;
            t += 1.0;
            assert!(t < 1000.0);
        }
        assert!(t >= 80.0, "{t}");
        assert!((r.current_ms() - 80.0).abs() < 1e-9);
    }

    #[test]
    fn einfrieren_haelt_den_wert() {
        let mut r = Ramp::new(10.0, 5.0);
        r.set_target(50.0);
        r.step(2.0);
        let held = r.current_ms();
        r.freeze(true);
        for _ in 0..10 {
            r.step(1.0);
        }
        assert_eq!(r.current_ms(), held);
        r.freeze(false);
        r.step(1.0);
        assert!(r.current_ms() > held);
    }

    #[test]
    fn rueckwaerts_und_kein_ueberschwingen() {
        let mut r = Ramp::new(40.0, 10.0);
        r.set_target(38.0);
        assert_eq!(r.step(1.0), 38.0, "nicht über das Ziel hinaus");
        r.set_target(0.0);
        assert_eq!(r.step(1.0), 28.0);
    }

    #[test]
    fn datenkanal_nur_ganze_samples() {
        assert_eq!(data_channel_samples(1.0, 48000), 48);
        assert_eq!(data_channel_samples(0.0105, 48000), 1);
        assert_eq!(data_channel_samples(-5.0, 48000), 0);
        let a = data_channel_samples(20.0, 48000);
        let b = data_channel_samples(20.01, 48000);
        assert!(b >= a && (b - a) <= 1);
    }
}
