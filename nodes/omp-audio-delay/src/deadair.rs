//! Dead-Air-Wächter (Radio-Plan RB6): Liegt der Pegel des Eingangs länger als `hold_ms` unter der Schwelle, übernimmt die Notquelle;
//! sie geht erst zurück, wenn der Eingang wieder `return_ms` lang über der Schwelle liegt (kein Flattern an Pausen).
//! Schwelle und Haltezeiten sind eine **Eigenlösung** (keine Norm legt sie fest); Standard −60 dBFS / 5 s / 2 s.

#[derive(Clone, Debug)]
pub struct Settings {
    pub enabled: bool,
    pub threshold_db: f64,
    pub hold_ms: u64,
    pub return_ms: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { enabled: true, threshold_db: -60.0, hold_ms: 5000, return_ms: 2000 }
    }
}

#[derive(Default, Debug)]
pub struct Watch {
    active: bool,
    below_ms: f64,
    above_ms: f64,
    /// Zahl der Übernahmen und ihre Gesamtdauer (Kennzahl „Dead-Air-Sekunden").
    pub takeovers: u64,
    pub total_ms: f64,
}

impl Watch {
    pub fn active(&self) -> bool {
        self.active
    }

    /// Ein Block mit Spitzenpegel `peak_db` und Dauer `block_ms`; Ergebnis: Notquelle verwenden?
    pub fn feed(&mut self, s: &Settings, peak_db: f64, block_ms: f64) -> bool {
        if !s.enabled {
            self.active = false;
            self.below_ms = 0.0;
            self.above_ms = 0.0;
            return false;
        }
        if peak_db < s.threshold_db {
            self.below_ms += block_ms;
            self.above_ms = 0.0;
            if !self.active && self.below_ms >= s.hold_ms as f64 {
                self.active = true;
                self.takeovers += 1;
            }
        } else {
            self.above_ms += block_ms;
            self.below_ms = 0.0;
            if self.active && self.above_ms >= s.return_ms as f64 {
                self.active = false;
            }
        }
        if self.active {
            self.total_ms += block_ms;
        }
        self.active
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(w: &mut Watch, s: &Settings, db: f64, ms: u64) -> bool {
        let mut last = w.active();
        for _ in 0..(ms / 10) {
            last = w.feed(s, db, 10.0);
        }
        last
    }

    #[test]
    fn takes_over_after_hold_and_not_before() {
        let (s, mut w) = (Settings::default(), Watch::default());
        assert!(!run(&mut w, &s, -90.0, 4900));
        assert!(run(&mut w, &s, -90.0, 200));
        assert_eq!(w.takeovers, 1);
    }

    #[test]
    fn short_pause_does_not_trigger_and_resets_the_hold() {
        let (s, mut w) = (Settings::default(), Watch::default());
        run(&mut w, &s, -90.0, 4000);
        run(&mut w, &s, -20.0, 10); // kurzer Ton setzt die Zeit zurück
        assert!(!run(&mut w, &s, -90.0, 4000));
        assert_eq!(w.takeovers, 0);
    }

    #[test]
    fn returns_only_after_signal_is_stable() {
        let (s, mut w) = (Settings::default(), Watch::default());
        run(&mut w, &s, -90.0, 5100);
        assert!(run(&mut w, &s, -20.0, 1500), "noch in der Rückkehr-Haltezeit");
        // Flattern: Signal geht wieder weg → bleibt Notquelle, Rückkehr-Zeit beginnt von vorn
        assert!(run(&mut w, &s, -90.0, 100));
        assert!(run(&mut w, &s, -20.0, 1500));
        assert!(!run(&mut w, &s, -20.0, 600));
    }

    #[test]
    fn disabled_never_triggers_and_counts_duration() {
        let mut w = Watch::default();
        let off = Settings { enabled: false, ..Settings::default() };
        assert!(!run(&mut w, &off, -90.0, 20_000));
        let on = Settings::default();
        run(&mut w, &on, -90.0, 6000);
        assert!(w.total_ms > 900.0 && w.total_ms < 1100.0, "{}", w.total_ms);
    }
}
