//! Durchgehende Zeitbasis im MXL-Verbund (docs/decisions.md Nachtrag 271,
//! Nutzer-Direktive 2026-09-22: "durchgehende, konsistente Zeitbasis im
//! gesamten DMF/MXL-Verbund ist oberste Prämisse").
//!
//! Modell wie bei ST 2110/NMOS: **Medienzeit = Grain-Index auf TAI**, von
//! Ende zu Ende.
//!   - Schreiben: der Index eines Bildes/Samples kommt aus seinem PTS
//!     (über die Pipeline-Uhr nach TAI umgerechnet), nicht aus dem
//!     Moment, in dem der Schreib-Thread es zufällig abholt.
//!   - Lesen: der PTS eines Grains kommt aus seinem Index (TAI → Pipeline-
//!     Laufzeit) plus einer kleinen, adaptiven Latenz — nicht aus dem
//!     Ankunftsmoment (`do-timestamp`).
//!
//! Alle Umrechnungen sind UHR-UNABHÄNGIG: sie arbeiten mit dem aktuell
//! gemessenen Abstand zwischen Pipeline-Uhr und TAI (`MxlContext::now_ns`,
//! dieselbe `CLOCK_TAI`, die libmxl für Indizes nutzt). Eine Pipeline mit
//! Monotonic-Systemuhr, TAI-Systemuhr oder (ST 2110/AES67-Gateways)
//! `PtpClock` rechnet damit identisch — PTP ersetzt später nur die Quelle
//! der TAI-Zeit, nicht diese Logik.
//!
//! Reine Funktionen/Strukturen ohne GStreamer/MXL-Abhängigkeit, damit sie
//! per Unit-Test prüfbar sind.

/// Pipeline-Laufzeit eines Puffers → TAI-Nanosekunden.
///
/// `base_time`/`clock_now` stammen von der Pipeline-Uhr (beliebiger Typ),
/// `tai_now` ist die zur selben Zeit gelesene TAI-Zeit. Der Puffer lag bei
/// Uhrzeit `base_time + running`; relativ zu "jetzt" ist das
/// `clock_now - (base_time + running)` her — dieselbe Spanne vor `tai_now`.
pub fn running_to_tai(running: u64, base_time: u64, clock_now: u64, tai_now: u64) -> Option<u64> {
    let v = tai_now as i128 - (clock_now as i128 - (base_time as i128 + running as i128));
    (v >= 0).then_some(v as u64)
}

/// TAI-Nanosekunden → Pipeline-Laufzeit (Umkehrung von
/// [`running_to_tai`]), plus `latency`. `None`, wenn das Ergebnis vor dem
/// Pipeline-Start läge.
pub fn tai_to_running(tai: u64, base_time: u64, clock_now: u64, tai_now: u64, latency: u64) -> Option<u64> {
    let v = tai as i128 - tai_now as i128 + clock_now as i128 - base_time as i128 + latency as i128;
    (v >= 0).then_some(v as u64)
}

/// Plausibilitätsgrenze für PTS-abgeleitete Schreib-Indizes relativ zum
/// aktuellen Wallclock-Index: ein Puffer, dessen PTS mehr als
/// `max_ahead` Grains in der Zukunft oder mehr als `max_behind` Grains in
/// der Vergangenheit liegt, hat keinen verwertbaren Echtzeit-PTS (z. B.
/// eine nicht live getaktete Quelle, deren PTS bei 0 beginnt) — dann
/// bleibt es beim bisherigen Wallclock-Index.
pub fn plausible_index(candidate: u64, now_index: u64, max_ahead: u64, max_behind: u64) -> bool {
    candidate <= now_index + max_ahead && candidate + max_behind >= now_index
}

/// Kontinuitäts-Einrasten: liegt die TAI-Zeit eines Puffers weniger als
/// `half_window` von der erwarteten Fortsetzung (`expected_tai`, TAI des
/// Index `letzter + step`) entfernt, gilt er als lückenlose Fortsetzung.
/// Grund: PTS→TAI→Index hat µs-Rauschen (zwei Uhren werden nacheinander
/// gelesen); landet ein Bild genau auf einer Grain-/Sample-Grenze, kippt
/// der ganzzahlige Index sonst sporadisch um 1 — bei Video ein
/// übersprungenes Grain, bei Audio eine Ein-Sample-Lücke (Knacken).
/// Echte Sprünge (Aussetzer der Quelle) sind größer und bleiben erhalten.
pub fn continues(tai: u64, expected_tai: u64, half_window: u64) -> bool {
    tai.abs_diff(expected_tai) < half_window
}

/// Adaptive Leselatenz (Jitterbuffer-Prinzip) in ganzen Grain-Perioden.
///
/// Ein Leser rendert Grain `i` zur Zeit TAI(i) + L. Kommt ein Grain erst
/// später an (Verzug = Ankunft − TAI(i)), wäre es zu spät. `observe`
/// meldet, ob L vergrößert (sofort, um so viele Perioden wie nötig) oder
/// verkleinert (langsam, eine Periode, erst nach `shrink_after`
/// Beobachtungen mit reichlich Reserve) werden soll. Einzelne sehr
/// späte Ausreißer (echte Aussetzer der Quelle) sollen L NICHT dauerhaft
/// aufblähen: vergrößert wird erst, wenn `grow_hits` der letzten
/// `window` Grains zu spät kamen — ein einzelner Aussetzer zeigt sich als
/// kurzes Standbild, danach läuft das Bild wieder pünktlich weiter.
#[derive(Debug, Clone)]
pub struct LatencyTracker {
    period_ns: u64,
    pub latency_periods: u64,
    min_periods: u64,
    max_periods: u64,
    window: std::collections::VecDeque<i64>,
    window_len: usize,
    grow_hits: usize,
    shrink_after: u32,
    comfortable_streak: u32,
}

/// Mindestdauer ununterbrochen reichlicher Reserve, bevor die Latenz um
/// eine Periode sinkt.
const SHRINK_AFTER_NS: u64 = 30_000_000_000;

#[derive(Debug, PartialEq, Eq)]
pub enum LatencyChange {
    None,
    /// L um n Perioden vergrößert (nächster PTS springt vor → Downstream
    /// wiederholt das letzte Bild, kein Rückwärts-PTS).
    Grow(u64),
    /// L um eine Periode verkleinert — der Aufrufer muss GENAU EIN Grain
    /// überspringen, damit der PTS monoton bleibt.
    Shrink,
}

impl LatencyTracker {
    pub fn new(period_ns: u64, initial_periods: u64, min_periods: u64, max_periods: u64) -> Self {
        LatencyTracker {
            period_ns,
            latency_periods: initial_periods.clamp(min_periods, max_periods),
            min_periods,
            max_periods,
            window: std::collections::VecDeque::new(),
            window_len: 25,
            grow_hits: 3,
            // Zeit-, nicht zählbasiert (Audio-Harness, Nachtrag 271): 250
            // Beobachtungen waren bei Video 10 s, bei 10-ms-Audioblöcken nur
            // 2,5 s — jedes Verkleinern verwirft einen Block, bei Audio ein
            // hörbares Knacken alle 2,5 s. Jetzt frühestens alle 30 s.
            shrink_after: (SHRINK_AFTER_NS / period_ns.max(1)).max(1) as u32,
            comfortable_streak: 0,
        }
    }

    pub fn latency_ns(&self) -> u64 {
        self.latency_periods * self.period_ns
    }

    /// Nötige Perioden, damit ein Grain mit diesem Verzug noch mit einer
    /// halben Periode Reserve rechtzeitig ist.
    fn needed_periods(&self, lag_ns: i64) -> u64 {
        if lag_ns <= 0 {
            return self.min_periods;
        }
        let needed = (lag_ns as u64 + self.period_ns / 2).div_ceil(self.period_ns);
        needed.clamp(self.min_periods, self.max_periods)
    }

    /// `lag_ns` = Ankunftszeit − TAI(Grain-Index), in TAI-Nanosekunden.
    pub fn observe(&mut self, lag_ns: i64) -> LatencyChange {
        self.window.push_back(lag_ns);
        if self.window.len() > self.window_len {
            self.window.pop_front();
        }
        let late: Vec<u64> = self
            .window
            .iter()
            .map(|l| self.needed_periods(*l))
            .filter(|n| *n > self.latency_periods)
            .collect();
        if late.len() >= self.grow_hits {
            // Auf den kleinsten Wert anheben, der die Mehrheit der
            // verspäteten Grains abdeckt (nicht den größten Ausreißer).
            let mut sorted = late;
            sorted.sort_unstable();
            let target = sorted[sorted.len() / 2].max(self.latency_periods + 1);
            let grow = target - self.latency_periods;
            self.latency_periods = target;
            self.window.clear();
            self.comfortable_streak = 0;
            return LatencyChange::Grow(grow);
        }
        if self.needed_periods(lag_ns) + 1 < self.latency_periods {
            self.comfortable_streak += 1;
            if self.comfortable_streak >= self.shrink_after && self.latency_periods > self.min_periods {
                self.latency_periods -= 1;
                self.comfortable_streak = 0;
                self.window.clear();
                return LatencyChange::Shrink;
            }
        } else {
            self.comfortable_streak = 0;
        }
        LatencyChange::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: u64 = 40_000_000; // 25 fps

    #[test]
    fn running_tai_round_trip_is_clock_independent() {
        // Pipeline-Uhr läuft 5 s hinter TAI (z. B. Monotonic seit Boot).
        let (base, clock_now, tai_now) = (1_000_000_000u64, 9_000_000_000u64, 14_000_000_000u64);
        let running = 7_500_000_000u64; // Puffer lag 0,5 s vor "jetzt"
        let tai = running_to_tai(running, base, clock_now, tai_now).unwrap();
        assert_eq!(tai, 13_500_000_000);
        assert_eq!(tai_to_running(tai, base, clock_now, tai_now, 0), Some(running));
        assert_eq!(tai_to_running(tai, base, clock_now, tai_now, P), Some(running + P));
        assert_eq!(tai_to_running(0, base, clock_now, tai_now, 0), None);
    }

    #[test]
    fn continues_snaps_only_small_deviations() {
        assert!(continues(1_000_010_000, 1_000_000_000, P / 2));
        assert!(continues(999_990_000, 1_000_000_000, P / 2));
        assert!(!continues(1_000_000_000 + P, 1_000_000_000, P / 2));
    }

    #[test]
    fn plausible_index_bounds() {
        assert!(plausible_index(1000, 1000, 25, 250));
        assert!(plausible_index(1025, 1000, 25, 250));
        assert!(!plausible_index(1026, 1000, 25, 250));
        assert!(plausible_index(750, 1000, 25, 250));
        assert!(!plausible_index(749, 1000, 25, 250));
    }

    #[test]
    fn tracker_grows_on_persistent_lateness_not_on_single_outlier() {
        let mut t = LatencyTracker::new(P, 2, 1, 25);
        // Einzelner Aussetzer (700 ms) → kein Wachstum.
        assert_eq!(t.observe(700_000_000), LatencyChange::None);
        // Fenster (25) läuft weiter, der Ausreißer fällt heraus.
        for _ in 0..30 {
            assert_eq!(t.observe(30_000_000), LatencyChange::None);
        }
        assert_eq!(t.latency_periods, 2);
        // Bursts: wiederholt ~130 ms Verzug → Wachstum auf 4 Perioden.
        assert_eq!(t.observe(130_000_000), LatencyChange::None);
        assert_eq!(t.observe(130_000_000), LatencyChange::None);
        assert_eq!(t.observe(130_000_000), LatencyChange::Grow(2));
        assert_eq!(t.latency_periods, 4);
        assert_eq!(t.latency_ns(), 4 * P);
    }

    #[test]
    fn tracker_shrinks_slowly_one_period_at_a_time() {
        let mut t = LatencyTracker::new(P, 6, 1, 25);
        let mut shrinks = 0;
        // 30 s bei 40 ms = 750 Beobachtungen je Stufe.
        for _ in 0..1600 {
            if t.observe(10_000_000) == LatencyChange::Shrink {
                shrinks += 1;
            }
        }
        assert_eq!(shrinks, 2, "750 Beobachtungen (30 s) je Stufe");
        assert_eq!(t.latency_periods, 4);
        // Audio (10-ms-Blöcke): ebenfalls erst nach 30 s = 3000 Blöcken.
        let mut a = LatencyTracker::new(10_000_000, 6, 1, 100);
        let first = (1..=4000).find(|_| a.observe(1_000_000) == LatencyChange::Shrink);
        assert_eq!(first, Some(3000));
    }

    #[test]
    fn tracker_clamps_to_bounds() {
        let mut t = LatencyTracker::new(P, 0, 1, 5);
        assert_eq!(t.latency_periods, 1);
        for _ in 0..3 {
            t.observe(10_000_000_000);
        }
        assert_eq!(t.latency_periods, 5);
    }
}
