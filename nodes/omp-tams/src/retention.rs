//! Aufbewahrung von Segmenten (AppNote 0019, „Segment Retention“): Der Flow trägt das Tag `segment_retention_offset`
//! (ein Timestamp); ein Segment darf gelöscht werden, wenn **Ende + Offset ≤ jetzt**. Der einfachste Löschlauf ist ein
//! `DELETE /flows/{id}/segments?timerange=_<jetzt − Offset>)` — der Dienst löscht nur vollständig abgedeckte Segmente.

use crate::time::{Bound, TimeRange, Timestamp};

/// Name des Tags am Flow.
pub const TAG: &str = "segment_retention_offset";

/// Wert des Tags für `seconds` Sekunden (Timestamp ohne Nanosekunden-Anteil).
pub fn offset_tag(seconds: u64) -> String {
    format!("{seconds}:0")
}

/// Bereich, der jetzt gelöscht werden darf: alles, was vor `jetzt − Offset` endet. `None`, wenn die Zeit davor negativ wäre.
pub fn cutoff_range(now_tai_ns: u64, offset_s: u64) -> Option<TimeRange> {
    let cut = (now_tai_ns as i128).checked_sub(offset_s as i128 * 1_000_000_000)?;
    (cut > 0).then(|| TimeRange::new(None, Some(Bound { ts: Timestamp::from_ns(cut), inclusive: false })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_value_and_cutoff_follow_the_appnote() {
        assert_eq!(offset_tag(3600), "3600:0");
        let r = cutoff_range(10_000_000_000_000, 3600).unwrap();
        assert_eq!(r.to_string(), "_6400:0)");
        // Segment [6300_6400) liegt vollständig davor, [6399_6401) nicht
        assert!(r.contains_range(&TimeRange::parse("[6300:0_6400:0)").unwrap()));
        assert!(!r.contains_range(&TimeRange::parse("[6399:0_6401:0)").unwrap()));
        assert!(cutoff_range(1_000_000_000, 3600).is_none(), "vor der Epoche: nichts zu löschen");
    }
}
