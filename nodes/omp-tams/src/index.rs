//! MXL-Grain-/Sample-Index ↔ TAMS-Timestamp.
//!
//! MXL zählt Indizes auf der TAI-Zeit (`mxlIndexToTimestamp`/`mxlTimestampToIndex`). TAMS verlangt ebenfalls eine
//! lineare Zeit auf TAI/PTP-Basis (AppNote 0008). Die Umrechnung ist daher **verlustfrei in der Zeitbasis**; nur die
//! Rundung auf ganze Nanosekunden bzw. Indizes ist zu beachten.
//!
//! Die Formeln sind **bitgleich** zu `third_party/mxl/lib/internal/include/mxl-internal/IndexConversion.hpp`
//! (128-Bit-Rechnung, Rundung auf den nächsten Wert); sie werden hier ohne MXL-Bibliothek nachgebildet, damit das
//! Crate rein bleibt. Ein Abgleich mit der echten Bibliothek steht in 105.3 an (Verifikation dort).

use crate::time::Timestamp;

/// Bildrate / Abtastrate als Bruch (`60000/1001`, `48000/1`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rate {
    pub num: u32,
    pub den: u32,
}

impl Rate {
    pub fn new(num: u32, den: u32) -> Option<Rate> {
        (num != 0 && den != 0).then_some(Rate { num, den })
    }
}

/// MXL-Zeit (TAI, ns) des Beginns von `index` (`mxlIndexToTimestamp`).
pub fn index_to_ns(index: u64, rate: Rate) -> u64 {
    let n = rate.num as u128;
    let d = rate.den as u128;
    ((index as u128 * d * 1_000_000_000 + n / 2) / n) as u64
}

/// Index, in dem die MXL-Zeit `ns` liegt (`mxlTimestampToIndex`, rundet auf den **nächsten** Index).
pub fn ns_to_index(ns: u64, rate: Rate) -> u64 {
    let n = rate.num as u128;
    let d = rate.den as u128;
    ((ns as u128 * n + 500_000_000 * d) / (1_000_000_000 * d)) as u64
}

/// TAMS-Timestamp des Anfangs von `index`.
pub fn index_to_timestamp(index: u64, rate: Rate) -> Timestamp {
    Timestamp::from_ns(index_to_ns(index, rate) as i128)
}

/// Index zu einem TAMS-Timestamp. `None` bei negativer Zeit (MXL kennt keine).
pub fn timestamp_to_index(ts: Timestamp, rate: Rate) -> Option<u64> {
    u64::try_from(ts.ns()).ok().map(|ns| ns_to_index(ns, rate))
}

/// Zeit auf das Raster der Rate legen (AppNote 0008, „Timestamp regularisation“): Timestamp → Index → Timestamp.
pub fn regularise(ts: Timestamp, rate: Rate) -> Option<Timestamp> {
    timestamp_to_index(ts, rate).map(|i| index_to_timestamp(i, rate))
}

/// Zeitbereich eines Segments aus `count` Samples ab `first_index`: `[Anfang_Ende)`, wobei das Ende der Anfang des
/// ersten Samples **nach** dem Segment ist (Samples haben Dauer, Spezifikation: Ende exklusiv).
pub fn segment_range(first_index: u64, count: u64, rate: Rate) -> crate::time::TimeRange {
    crate::time::TimeRange::half_open(index_to_timestamp(first_index, rate), index_to_timestamp(first_index + count, rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    const R25: Rate = Rate { num: 25, den: 1 };
    const R50: Rate = Rate { num: 50, den: 1 };
    const R2997: Rate = Rate { num: 30000, den: 1001 };
    const R5994: Rate = Rate { num: 60000, den: 1001 };
    const A48K: Rate = Rate { num: 48000, den: 1 };

    #[test]
    fn schema_example_27th_frame_at_25hz() {
        // Schema timestamp: "1:40000000" ist das 27. Bild bei 25 Hz (Index 26) mit Ursprung 0:0
        assert_eq!(index_to_timestamp(26, R25).to_string(), "1:40000000");
        assert_eq!(timestamp_to_index(Timestamp::parse("1:40000000").unwrap(), R25), Some(26));
    }

    #[test]
    fn known_values_of_the_mxl_formula() {
        assert_eq!(index_to_ns(0, R25), 0);
        assert_eq!(index_to_ns(1, R25), 40_000_000);
        assert_eq!(index_to_ns(1, R50), 20_000_000);
        // 30000/1001: 1001·1e9/30000 = 33 366 666,67 → gerundet 33 366 667
        assert_eq!(index_to_ns(1, R2997), 33_366_667);
        assert_eq!(index_to_ns(30000, R2997), 1_001_000_000_000);
        assert_eq!(index_to_ns(1, R5994), 16_683_333);
        // Audio: ein Sample bei 48 kHz = 20 833,33 ns → 20 833
        assert_eq!(index_to_ns(1, A48K), 20_833);
        assert_eq!(index_to_ns(48000, A48K), 1_000_000_000);
    }

    #[test]
    fn round_trip_index_for_all_common_rates() {
        for rate in [R25, R50, R2997, R5994, A48K, Rate { num: 24000, den: 1001 }, Rate { num: 96000, den: 1 }] {
            // Heute (TAI ≈ 1,7·10^9 s) und kleine Werte, jeweils eine Reihe aufeinanderfolgender Indizes
            let base_now = ns_to_index(1_790_000_000_000_000_000, rate);
            for base in [0u64, 1, 12345, base_now] {
                for i in base..base + 2000 {
                    let ns = index_to_ns(i, rate);
                    assert_eq!(ns_to_index(ns, rate), i, "Rundlauf bei {rate:?}, Index {i}");
                }
            }
        }
    }

    #[test]
    fn indices_are_strictly_monotonic_in_time() {
        for rate in [R2997, R5994, A48K] {
            let mut last = index_to_ns(0, rate);
            for i in 1..5000 {
                let t = index_to_ns(i, rate);
                assert!(t > last);
                last = t;
            }
        }
    }

    #[test]
    fn regularise_snaps_to_grid() {
        let off = Timestamp::parse("1:40000001").unwrap(); // 1 ns neben dem Raster
        assert_eq!(regularise(off, R25).unwrap().to_string(), "1:40000000");
        let half = Timestamp::from_ns(1_040_000_000 + 20_000_000); // genau halbes Bild → rundet auf
        assert_eq!(regularise(half, R25).unwrap().ns(), 1_080_000_000);
        // schon auf dem Raster: unverändert
        let on = index_to_timestamp(777, R5994);
        assert_eq!(regularise(on, R5994), Some(on));
        assert_eq!(regularise(Timestamp::from_ns(-1), R25), None);
    }

    #[test]
    fn segment_ranges_chain_without_overlap() {
        // zwei Segmente zu je 100 Bildern bei 29,97 Bildern/s: lückenlos und ohne Überlappung
        let a = segment_range(5_000_000, 100, R2997);
        let b = segment_range(5_000_100, 100, R2997);
        assert!(!a.overlaps(&b));
        // Ende von a = Anfang von b
        let (crate::time::TimeRange::Range { end: Some(ea), .. }, crate::time::TimeRange::Range { start: Some(sb), .. }) = (a, b) else {
            panic!()
        };
        assert_eq!(ea.ts, sb.ts);
    }

    #[test]
    fn large_values_do_not_overflow() {
        // 2^48 s in ns passt in u64 nicht (2,8·10^23) — MXL-Zeit ist u64, also gilt: bis ~584 Jahre
        let big = u64::MAX / 2;
        let i = ns_to_index(big, R5994);
        let back = index_to_ns(i, R5994);
        assert!(back.abs_diff(big) <= 16_683_334);
    }

    #[test]
    fn rate_rejects_zero() {
        assert!(Rate::new(0, 1).is_none());
        assert!(Rate::new(25, 0).is_none());
        assert!(Rate::new(25, 1).is_some());
    }
}
