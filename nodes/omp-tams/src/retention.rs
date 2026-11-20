//! Aufbewahrung von Segmenten (AppNote 0019, „Segment Retention“): Der Flow trägt das Tag `segment_retention_offset`
//! (ein Timestamp); ein Segment darf gelöscht werden, wenn **Ende + Offset ≤ jetzt**. Der einfachste Löschlauf ist ein
//! `DELETE /flows/{id}/segments?timerange=_<jetzt − Offset>)` — der Dienst löscht nur vollständig abgedeckte Segmente.

use crate::time::{Bound, TimeRange, Timestamp};

/// Name des Tags am Flow (Segmente).
pub const TAG: &str = "segment_retention_offset";
/// Name des Tags am Flow (ganzer Flow, „Flow Retention“).
pub const FLOW_TAG: &str = "flow_retention_offset";

/// Wert des Tags für `seconds` Sekunden (Timestamp ohne Nanosekunden-Anteil).
pub fn offset_tag(seconds: u64) -> String {
    format!("{seconds}:0")
}

/// Bereich, der jetzt gelöscht werden darf: alles, was vor `jetzt − Offset` endet. `None`, wenn die Zeit davor negativ wäre.
pub fn cutoff_range(now_tai_ns: u64, offset_s: u64) -> Option<TimeRange> {
    let cut = (now_tai_ns as i128).checked_sub(offset_s as i128 * 1_000_000_000)?;
    (cut > 0).then(|| TimeRange::new(None, Some(Bound { ts: Timestamp::from_ns(cut), inclusive: false })))
}

/// RFC-3339-Zeit (`2026-11-20T09:00:00Z`, auch mit Bruchteil und Versatz) → Nanosekunden seit 1970 (UTC). Reicht für die
/// `*_updated`-Felder eines Flows; auf Stunden gerechnet spielt der Unterschied TAI/UTC (37 s) keine Rolle.
pub fn parse_rfc3339_ns(s: &str) -> Option<i128> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't' || b[10] == b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut i = 19;
    let mut frac_ns: i128 = 0;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        i = start;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        let digits = &s[start..i];
        if digits.is_empty() {
            return None;
        }
        let nine: String = digits.chars().chain(std::iter::repeat('0')).take(9).collect();
        frac_ns = nine.parse().ok()?;
    }
    let offset_s: i64 = match b.get(i) {
        Some(b'Z') | Some(b'z') if i + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if b.len() == i + 6 && b[i + 3] == b':' => {
            let (oh, om) = (num(i + 1, i + 3)?, num(i + 4, i + 6)?);
            let v = oh * 3600 + om * 60;
            if *sign == b'-' { -v } else { v }
        }
        _ => return None,
    };
    // Tage seit 1970 (Hinnant, days_from_civil)
    let (yy, mm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 + se - offset_s;
    Some(secs as i128 * 1_000_000_000 + frac_ns)
}

/// Seit wann (ns, UTC) ist der Flow unverändert: das Spätere von `metadata_updated` und `segments_updated` (AppNote 0019).
pub fn last_change_ns(flow: &serde_json::Value) -> Option<i128> {
    ["metadata_updated", "segments_updated"].iter().filter_map(|k| flow.get(*k)?.as_str().and_then(parse_rfc3339_ns)).max()
}

/// Wert des Tags `flow_retention_offset` in Sekunden (Timestamp `S:N`); nur ganze, nicht negative Offsets.
pub fn flow_offset_s(flow: &serde_json::Value) -> Option<u64> {
    let t = flow.get("tags")?.get(FLOW_TAG)?.as_str()?;
    let ts = Timestamp::parse(t).ok()?;
    u64::try_from(ts.ns() / 1_000_000_000).ok()
}

/// Ob ein Flow nach der „Flow Retention“ gelöscht werden darf: Tag vorhanden und `letzte Änderung + Offset ≤ jetzt`.
pub fn flow_expired(flow: &serde_json::Value, now_unix_ns: i128) -> bool {
    match (flow_offset_s(flow), last_change_ns(flow)) {
        (Some(off), Some(last)) => last + off as i128 * 1_000_000_000 <= now_unix_ns,
        _ => false,
    }
}

/// Ob ein Flow ein „leerer Flow“ ist, der älter als `age_s` ist (AppNote 0019, „Empty Flow Clean-up“): keine Segmente
/// (`timerange` fehlt oder ist `()`), und beide `*_updated`-Zeiten liegen mehr als `age_s` zurück.
pub fn empty_flow_expired(flow: &serde_json::Value, age_s: u64, now_unix_ns: i128) -> bool {
    let empty = match flow.get("timerange").and_then(|v| v.as_str()) {
        None => true,
        Some(t) => matches!(TimeRange::parse(t), Ok(TimeRange::Empty)),
    };
    let times: Vec<i128> = ["metadata_updated", "segments_updated"].iter().filter_map(|k| flow.get(*k)?.as_str().and_then(parse_rfc3339_ns)).collect();
    empty && !times.is_empty() && times.iter().all(|t| *t + age_s as i128 * 1_000_000_000 <= now_unix_ns)
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

    #[test]
    fn rfc3339_parsing() {
        assert_eq!(parse_rfc3339_ns("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ns("2000-03-01T00:00:00Z"), Some(951_868_800_000_000_000));
        assert_eq!(parse_rfc3339_ns("2026-11-20T09:00:00.5Z"), Some(1_795_165_200_500_000_000));
        assert_eq!(parse_rfc3339_ns("2026-11-20T11:00:00+02:00"), parse_rfc3339_ns("2026-11-20T09:00:00Z"));
        assert_eq!(parse_rfc3339_ns("2024-02-29T12:00:00Z").map(|n| n / 1_000_000_000), Some(1_709_208_000));
        for bad in ["", "2026-11-20", "2026-13-20T09:00:00Z", "2026-11-20T09:00:00", "2026-11-20T09:00:00.Z", "x026-11-20T09:00:00Z"] {
            assert_eq!(parse_rfc3339_ns(bad), None, "{bad}");
        }
    }

    #[test]
    fn flow_retention_uses_the_later_update_and_the_tag() {
        let now = parse_rfc3339_ns("2026-11-20T12:00:00Z").unwrap();
        let mk = |meta: &str, segs: &str, tag: Option<&str>| {
            let mut v = serde_json::json!({"metadata_updated": meta, "segments_updated": segs, "timerange": "[1:0_2:0)"});
            if let Some(t) = tag {
                v["tags"] = serde_json::json!({ FLOW_TAG: t });
            }
            v
        };
        // 1 h Offset; letzte Änderung (Segmente) vor 30 min → nicht fällig, obwohl Metadaten alt sind
        assert!(!flow_expired(&mk("2026-11-19T00:00:00Z", "2026-11-20T11:30:00Z", Some("3600:0")), now));
        // beide vor mehr als 1 h → fällig
        assert!(flow_expired(&mk("2026-11-19T00:00:00Z", "2026-11-20T10:30:00Z", Some("3600:0")), now));
        // ohne Tag nie
        assert!(!flow_expired(&mk("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", None), now));
        // Offset nicht lesbar → nie
        assert!(!flow_expired(&mk("2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", Some("abc")), now));
    }

    #[test]
    fn empty_flows_need_no_segments_and_old_updates() {
        let now = parse_rfc3339_ns("2026-11-20T12:00:00Z").unwrap();
        let f = |tr: Option<&str>, a: &str, b: &str| {
            let mut v = serde_json::json!({"metadata_updated": a, "segments_updated": b});
            if let Some(t) = tr {
                v["timerange"] = t.into();
            }
            v
        };
        assert!(empty_flow_expired(&f(Some("()"), "2026-11-18T00:00:00Z", "2026-11-18T00:00:00Z"), 86_400, now));
        assert!(empty_flow_expired(&f(None, "2026-11-18T00:00:00Z", "2026-11-18T00:00:00Z"), 86_400, now));
        assert!(!empty_flow_expired(&f(Some("[1:0_2:0)"), "2026-11-18T00:00:00Z", "2026-11-18T00:00:00Z"), 86_400, now), "mit Segmenten nicht leer");
        assert!(!empty_flow_expired(&f(Some("()"), "2026-11-18T00:00:00Z", "2026-11-20T11:00:00Z"), 86_400, now), "kürzlich geändert");
    }
}
