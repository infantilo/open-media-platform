//! Zeit in MPEG-TS-Segmenten (TAMS-AppNote 0002).
//!
//! PTS/DTS sind 33 Bit auf einer 90-kHz-Zeitbasis (ISO/IEC 13818-1) und laufen etwa alle 26,5 Stunden über.
//! TAMS trägt die oberen Bits im `ts_offset` des Segments: absolute Zeit = `ts_offset + PTS/90000`.
//!
//! * Schreiben: [`ts_offset_for`] bildet aus der absoluten Zeit des ersten Bildes den `ts_offset`
//!   (`C_offset = C_abs − (C_abs & 0x1_FFFF_FFFF)`).
//! * Lesen: [`PtsUnwrapper`] setzt PTS-Werte wieder zu absoluten Zeiten zusammen und erkennt einen Überlauf
//!   mitten im Segment (PTS wird kleiner, vorheriger Wert > 2^33 − 2^31).
//!
//! **Abweichung vom Beispielcode der AppNote:** Dort wird bei einem Überlauf `(2^33−1)/90000` Sekunden addiert. Der
//! 33-Bit-Zähler läuft aber nach **2^33** Ticks über, und `C_offset` ist ein Vielfaches von 2^33 (siehe oben).
//! Wir addieren deshalb **2^33 Ticks**; mit 2^33−1 wäre die Zeit nach einem Überlauf um einen Tick (11 µs) falsch.

use crate::time::Timestamp;

/// Zeitbasis in Hz.
pub const PTS_HZ: u64 = 90_000;
/// 33-Bit-Zähler: Anzahl der Werte.
pub const PTS_MODULUS: u64 = 1 << 33;
const PTS_MASK: u64 = PTS_MODULUS - 1;

/// Ticks (90 kHz) → Nanosekunden, auf die nächste Nanosekunde gerundet.
pub fn ticks_to_ns(ticks: u64) -> i128 {
    ((ticks as i128) * 1_000_000_000 + (PTS_HZ as i128) / 2) / PTS_HZ as i128
}

/// Nanosekunden → Ticks (90 kHz), auf den nächsten Tick gerundet. `None` bei negativer Zeit.
pub fn ns_to_ticks(ns: i128) -> Option<u64> {
    if ns < 0 {
        return None;
    }
    let t = (ns * PTS_HZ as i128 + 500_000_000) / 1_000_000_000;
    u64::try_from(t).ok()
}

/// `ts_offset` für ein Segment, dessen erstes Bild die absolute Präsentationszeit `first_pts_abs` hat.
/// Es gilt dann `ts_offset + (first_pts_abs & 33 Bit)/90000 ≈ first_pts_abs`.
pub fn ts_offset_for(first_pts_abs: Timestamp) -> Option<Timestamp> {
    let abs_ticks = ns_to_ticks(first_pts_abs.ns())?;
    let offset_ticks = abs_ticks - (abs_ticks & PTS_MASK);
    Some(Timestamp::from_ns(ticks_to_ns(offset_ticks)))
}

/// Der PTS-Wert (33 Bit), mit dem ein Schreiber die absolute Zeit in den Strom schreibt.
pub fn pts_for(abs: Timestamp) -> Option<u64> {
    ns_to_ticks(abs.ns()).map(|t| t & PTS_MASK)
}

/// Rekonstruiert absolute Zeiten aus PTS/DTS-Werten eines Segments (Reihenfolge der Präsentation oder des Stroms).
#[derive(Debug, Clone)]
pub struct PtsUnwrapper {
    base_ticks: u64,
    last: Option<u64>,
}

impl PtsUnwrapper {
    /// `ts_offset` aus dem Segment. `None` bei negativem Wert.
    pub fn new(ts_offset: Timestamp) -> Option<Self> {
        Some(PtsUnwrapper { base_ticks: ns_to_ticks(ts_offset.ns())?, last: None })
    }

    /// Absolute Zeit für den nächsten PTS-Wert (0…2^33−1). Werte außerhalb des Bereichs werden abgeschnitten.
    pub fn absolute(&mut self, pts: u64) -> Timestamp {
        let pts = pts & PTS_MASK;
        if let Some(last) = self.last
            && pts < last
            && last > PTS_MODULUS - (1 << 31)
        {
            self.base_ticks += PTS_MODULUS;
        }
        self.last = Some(pts);
        Timestamp::from_ns(ticks_to_ns(self.base_ticks + pts))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollover_period_is_about_26_5_hours() {
        let secs = PTS_MODULUS as f64 / PTS_HZ as f64;
        assert!((secs / 3600.0 - 26.5).abs() < 0.1, "{}", secs / 3600.0);
    }

    #[test]
    fn tick_conversions() {
        assert_eq!(ticks_to_ns(90_000), 1_000_000_000);
        assert_eq!(ticks_to_ns(1), 11_111); // 11 111,1 ns
        assert_eq!(ns_to_ticks(1_000_000_000), Some(90_000));
        assert_eq!(ns_to_ticks(-1), None);
        // ein 25-Hz-Bild = 3600 Ticks
        assert_eq!(ns_to_ticks(40_000_000), Some(3600));
    }

    #[test]
    fn offset_and_pts_reconstruct_the_absolute_time() {
        // heutige TAI-Zeit, auf 25-Hz-Bildraster
        for secs in [0u64, 1, 95_443, 1_790_000_000, 1_790_000_123] {
            for frame in [0u64, 1, 7, 24] {
                let abs = Timestamp::from_ns(secs as i128 * 1_000_000_000 + frame as i128 * 40_000_000);
                let off = ts_offset_for(abs).unwrap();
                let pts = pts_for(abs).unwrap();
                let mut u = PtsUnwrapper::new(off).unwrap();
                let back = u.absolute(pts);
                // gleiche Rundung auf Ticks → Abweichung höchstens 1 ns (Tick-Auflösung 11 µs wird gerundet)
                let tick_ns = 11_112i128;
                assert!((back.ns() - abs.ns()).abs() <= tick_ns / 2 + 1, "{secs} {frame}: {back} vs {abs}");
            }
        }
    }

    #[test]
    fn offset_is_a_multiple_of_the_rollover_period() {
        let abs = Timestamp::from_ns(1_790_000_000_000_000_000);
        let off = ts_offset_for(abs).unwrap();
        let ticks = ns_to_ticks(off.ns()).unwrap();
        assert_eq!(ticks % PTS_MODULUS, 0);
        // und es liegt höchstens eine Periode unter der absoluten Zeit
        assert!(off.ns() <= abs.ns());
        assert!(abs.ns() - off.ns() < ticks_to_ns(PTS_MODULUS) + 1);
    }

    #[test]
    fn rollover_in_the_middle_of_a_segment_is_continuous() {
        // Segment beginnt 0,2 s vor dem Überlauf; Bilder alle 40 ms (3600 Ticks)
        let start_ticks: u64 = 5 * PTS_MODULUS + PTS_MODULUS - 18_000; // absolute Ticks
        let abs0 = Timestamp::from_ns(ticks_to_ns(start_ticks));
        let off = ts_offset_for(abs0).unwrap();
        let mut u = PtsUnwrapper::new(off).unwrap();
        let mut prev = i128::MIN;
        for n in 0..20u64 {
            let abs_ticks = start_ticks + n * 3600;
            let pts = abs_ticks & PTS_MASK; // was der Strom enthält (wird bei n=5 wieder klein)
            let t = u.absolute(pts);
            assert_eq!(t.ns(), ticks_to_ns(abs_ticks), "Bild {n}");
            assert!(t.ns() > prev, "Zeit muss steigen, Bild {n}");
            prev = t.ns();
        }
    }

    #[test]
    fn small_backwards_steps_are_not_rollover() {
        // B-Bilder: PTS darf wenig zurückspringen, ohne dass ein Überlauf angenommen wird
        let mut u = PtsUnwrapper::new(Timestamp::ZERO).unwrap();
        let a = u.absolute(1_000_000);
        let b = u.absolute(1_000_000 - 3600);
        assert!(b.ns() < a.ns());
        assert_eq!(b.ns(), ticks_to_ns(1_000_000 - 3600));
    }

    #[test]
    fn rejects_negative_times() {
        assert!(ts_offset_for(Timestamp::from_ns(-1)).is_none());
        assert!(PtsUnwrapper::new(Timestamp::from_ns(-5)).is_none());
        assert!(pts_for(Timestamp::from_ns(-5)).is_none());
    }
}
