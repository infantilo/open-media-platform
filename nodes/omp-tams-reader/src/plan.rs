//! Reine Zeitrechnung der Wiedergabe (ohne GStreamer, ohne Netz).
//!
//! Drei Zeitachsen: **Container** (PTS im Object, 90 kHz), **Flow-Zeit** (TAMS, TAI der Aufnahme) und **TAI jetzt**
//! (Ausgabe). Es gilt: `Flow-Zeit = ts_offset + Container-Zeit` (AppNote 0002) und `Ausgabe-TAI = Flow-Zeit + shift`.
//! `shift` ist für alle Essenzen einer Wiedergabe gleich — so bleiben Bild und Ton zueinander synchron.

use omp_tams::mpegts::ticks_to_ns;
use omp_tams::time::{TimeRange, Timestamp};

/// Anfang und Ende eines Zeitbereichs in ns (`None` = offen). `None` insgesamt bei leerem Bereich. Ob die Grenze
/// eingeschlossen ist, spielt hier keine Rolle: Segmente liegen auf dem Raster, wir vergleichen `Anfang ≤ t < Ende`.
pub fn bounds_ns(r: &TimeRange) -> Option<(Option<i128>, Option<i128>)> {
    match r {
        TimeRange::Empty => None,
        TimeRange::Range { start, end } => Some((start.map(|b| b.ts.ns()), end.map(|b| b.ts.ns()))),
    }
}

/// Flow-Zeit der Containerzeit 0 eines Segments plus Container-Zeit des ersten Pakets:
/// `ts_offset` (fehlt er, gilt 0) + erster PTS. `None` bei unlesbarem `ts_offset`.
pub fn segment_base_ns(ts_offset: Option<&str>, first_pts_ticks: u64) -> Option<i128> {
    let off = match ts_offset {
        Some(s) => Timestamp::parse(s).ok()?.ns(),
        None => 0,
    };
    Some(off + ticks_to_ns(first_pts_ticks))
}

/// Wie [`segment_base_ns`], mit der Objektzeit des ersten Samples in ns (fragmentiertes MP4: `tfdt`/Zeitskala).
pub fn segment_base_ns_from(ts_offset: Option<&str>, first_ns: i128) -> Option<i128> {
    let off = match ts_offset {
        Some(s) => Timestamp::parse(s).ok()?.ns(),
        None => 0,
    };
    Some(off + first_ns)
}

/// Flow-Zeit eines Bildes: Basis des Segments plus Abstand zum ersten dekodierten Bild.
pub fn frame_time_ns(base_ns: i128, rel_ns: u64) -> i128 {
    base_ns + rel_ns as i128
}

/// Ausgabe-TAI (ns) zu einer Flow-Zeit. `None`, wenn sie negativ wäre.
pub fn to_tai(flow_ns: i128, shift_ns: i128) -> Option<u64> {
    u64::try_from(flow_ns + shift_ns).ok()
}

/// Dauer eines Bildes bzw. Blocks in ns (gerundet).
pub fn period_ns(num: u32, den: u32) -> i128 {
    let (n, d) = (num.max(1) as i128, den.max(1) as i128);
    (d * 1_000_000_000 + n / 2) / n
}

/// Wie viele Bilder fehlen zwischen dem zuletzt ausgegebenen (`last`) und dem nächsten (`next`)? Toleranz: ein halbes
/// Bild Jitter. Obergrenze `cap` schützt vor Stunden-Lücken (dann springt die Wiedergabe, statt Stunden zu füllen).
pub fn gap_fill_count(last_ns: i128, next_ns: i128, frame_ns: i128, cap: u64) -> u64 {
    if frame_ns <= 0 || next_ns <= last_ns {
        return 0;
    }
    let steps = (next_ns - last_ns + frame_ns / 2) / frame_ns;
    let missing = (steps - 1).max(0) as u64;
    if missing > cap { 0 } else { missing }
}

/// `start ≤ t < end` (offene Grenzen gelten als unbegrenzt).
pub fn within(t: i128, start: Option<i128>, end: Option<i128>) -> bool {
    start.is_none_or(|s| t >= s) && end.is_none_or(|e| t < e)
}

/// Versatz für „Zeitbereich abspielen“: der Anfang des Bereichs erscheint `lead_ns` nach „jetzt“ am Ausgang
/// (Vorlauf für Holen und Dekodieren).
pub fn play_shift(range_start_ns: i128, now_tai_ns: u64, lead_ns: i128) -> i128 {
    now_tai_ns as i128 + lead_ns - range_start_ns
}

/// Anfang des Bereichs für „vor N Sekunden“ bzw. „mit Verzögerung“: was jetzt am Ausgang stehen soll, wurde
/// `delay_ns` früher aufgenommen.
pub fn follow_start(now_tai_ns: u64, delay_ns: i128) -> i128 {
    now_tai_ns as i128 - delay_ns
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: i128 = 1_000_000_000;

    #[test]
    fn bounds_of_ranges() {
        let r = TimeRange::parse("[10:0_12:0)").unwrap();
        assert_eq!(bounds_ns(&r), Some((Some(10 * S), Some(12 * S))));
        assert_eq!(bounds_ns(&TimeRange::parse("()").unwrap()), None);
        assert_eq!(bounds_ns(&TimeRange::parse("_").unwrap()), Some((None, None)));
        assert_eq!(bounds_ns(&TimeRange::parse("[5:0_").unwrap()), Some((Some(5 * S), None)));
    }

    #[test]
    fn base_adds_offset_and_first_pts() {
        // erster PTS = 1 s (90000 Ticks), ts_offset = 100:0 → Flow-Zeit 101 s
        assert_eq!(segment_base_ns(Some("100:0"), 90_000), Some(101 * S));
        // ts_offset fehlt → 0
        assert_eq!(segment_base_ns(None, 45_000), Some(S / 2));
        // negativer ts_offset ist erlaubt (Vorzeichen)
        assert_eq!(segment_base_ns(Some("-1:0"), 180_000), Some(S));
        assert_eq!(segment_base_ns(Some("Quatsch"), 0), None);
    }

    #[test]
    fn tai_mapping_is_shift_and_rejects_negative() {
        assert_eq!(to_tai(10 * S, 5 * S), Some(15_000_000_000));
        assert_eq!(to_tai(10 * S, -5 * S), Some(5_000_000_000));
        assert_eq!(to_tai(1, -2), None);
    }

    #[test]
    fn periods() {
        assert_eq!(period_ns(25, 1), 40_000_000);
        assert_eq!(period_ns(30000, 1001), 33_366_667);
        assert_eq!(period_ns(0, 0), 1_000_000_000);
    }

    #[test]
    fn gaps_are_counted_in_frames_with_jitter_tolerance() {
        let f = period_ns(25, 1);
        assert_eq!(gap_fill_count(0, f, f, 1000), 0, "lückenlos");
        assert_eq!(gap_fill_count(0, f + 3_000_000, f, 1000), 0, "3 ms Jitter ist keine Lücke");
        assert_eq!(gap_fill_count(0, 2 * f, f, 1000), 1);
        assert_eq!(gap_fill_count(0, 5 * f - 1_000_000, f, 1000), 4, "5 Schritte = 4 fehlende Bilder");
        assert_eq!(gap_fill_count(5 * f, 0, f, 1000), 0, "rückwärts: nichts füllen");
        assert_eq!(gap_fill_count(0, 3600 * S, f, 1000), 0, "Stundenlücke: springen statt füllen");
    }

    #[test]
    fn range_membership() {
        assert!(within(5, Some(5), Some(6)));
        assert!(!within(6, Some(5), Some(6)), "Ende ausgeschlossen");
        assert!(!within(4, Some(5), None));
        assert!(within(i128::MAX, None, None));
    }

    #[test]
    fn shifts() {
        // Bereich ab 1000 s, jetzt = 5000 s, Vorlauf 2 s: Bereichsanfang erscheint bei 5002 s
        let sh = play_shift(1000 * S, 5000 * S as u64, 2 * S);
        assert_eq!(to_tai(1000 * S, sh), Some(5002 * S as u64));
        assert_eq!(to_tai(1010 * S, sh), Some(5012 * S as u64));
        // Zeitverschiebung 10 s: was vor 10 s aufgenommen wurde, steht jetzt
        let start = follow_start(5000 * S as u64, 10 * S);
        assert_eq!(start, 4990 * S);
        assert_eq!(to_tai(start, 10 * S), Some(5000 * S as u64));
    }
}
