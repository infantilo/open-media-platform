//! Automatisches Laden und Starten der Sendung zur Sendezeit (Kapitel 89, Radio-Konsole). Reine Entscheidung ohne Netz und Uhr:
//! aus den freigegebenen Sendungen in Reichweite folgt, ob und wie der Log geladen wird. Das Modul `radio` des Orchestrators schaltet
//! den Status; diese Logik liest nur.

use serde_json::Value;

/// Ergebnis einer Prüfung.
#[derive(Debug, PartialEq)]
pub enum Decision {
    /// Nichts zu tun (keine Sendung in Reichweite, schon behandelt, Automation läuft).
    Nothing,
    /// Log und Hotkeys laden; `start_unix_ms` = Beginn des Zeitfensters (in der Zukunft), sonst nur laden und manuell starten lassen.
    Load { show_id: String, key: String, title: String, log: Value, carts: Value, start_unix_ms: Option<i64>, late: bool },
    /// Hinweis für die Anzeige (z. B. Sendung ohne Log).
    Note(String),
}

/// `key` einer Sendung: gleiche Sendung + gleicher Stand = schon behandelt.
pub fn key_of(show: &Value) -> String {
    format!("{}:{}", show.get("id").and_then(Value::as_str).unwrap_or(""), show.get("rowVersion").and_then(Value::as_i64).unwrap_or(0))
}

/// RFC-3339-Zeit in Unix-ms (nur die in der Praxis vorkommenden Formen `…Z` und `…±hh:mm`, ggf. mit Sekundenbruchteil).
pub fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() < 20 {
        return None;
    }
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-');
    let (y, mo, da): (i64, i64, i64) = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    // Zeitzonenteil abtrennen
    let (clock, off_s) = if let Some(p) = rest.find('Z') {
        (&rest[..p], 0i64)
    } else {
        let p = rest.rfind(['+', '-'])?;
        let (c, o) = rest.split_at(p);
        let sign = if o.starts_with('-') { -1 } else { 1 };
        let (oh, om) = o[1..].split_once(':')?;
        (c, sign * (oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60))
    };
    let (hms, frac) = clock.split_once('.').unwrap_or((clock, ""));
    let mut t = hms.split(':');
    let (h, mi, se): (i64, i64, i64) = (t.next()?.parse().ok()?, t.next()?.parse().ok()?, t.next()?.parse().ok()?);
    let ms: i64 = if frac.is_empty() { 0 } else { format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()? };
    // Tage seit 1970 (bürgerlicher Kalender, Algorithmus von H. Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60 + se - off_s) * 1000) + ms)
}

/// Unix-ms als RFC 3339 in UTC (`2026-11-12T06:00:00Z`).
pub fn fmt_rfc3339_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    // Kalenderdatum aus Tagen seit 1970 (Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Entscheidet anhand der freigegebenen Sendung (`show` mit Inhalt, früheste in Reichweite), der Jetztzeit und dem Zustand der Automation.
pub fn decide(show: Option<&Value>, now_unix_ms: i64, lead_ms: i64, running: bool, handled_key: &str) -> Decision {
    let Some(show) = show else { return Decision::Nothing };
    if running {
        return Decision::Nothing;
    }
    let key = key_of(show);
    if key == handled_key {
        return Decision::Nothing;
    }
    let status = show.get("status").and_then(Value::as_str).unwrap_or("");
    if status != "ready" && status != "live" {
        return Decision::Nothing;
    }
    let title = show.get("title").and_then(Value::as_str).unwrap_or("").to_string();
    let start = show.get("slotStart").and_then(Value::as_str).and_then(parse_rfc3339_ms);
    let Some(start) = start else { return Decision::Nothing };
    if start - now_unix_ms > lead_ms {
        return Decision::Nothing; // noch zu früh
    }
    let content = show.get("content").cloned().unwrap_or(Value::Null);
    let log = content.get("log").cloned().unwrap_or(Value::Null);
    if log.get("items").and_then(Value::as_array).is_none_or(|a| a.is_empty()) {
        return Decision::Note(format!("Sendung „{title}“ hat keinen Log — nicht geladen"));
    }
    let carts = content.get("carts").cloned().unwrap_or(Value::Array(vec![]));
    let id = show.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let late = start <= now_unix_ms + 2000;
    Decision::Load { show_id: id, key, title, log, carts, start_unix_ms: if late { None } else { Some(start) }, late }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn show(status: &str, start: &str, items: usize) -> Value {
        json!({"id": "s1", "rowVersion": 3, "title": "Morgenshow", "status": status, "slotStart": start,
               "content": {"log": {"logId": "m", "items": (0..items).map(|i| json!({"id": format!("e{i}")})).collect::<Vec<_>>()}, "carts": [{"label": "J"}]}})
    }

    #[test]
    fn rfc3339_forms() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("2026-11-12T07:00:00+01:00"), Some(1_794_463_200_000)); // 06:00 UTC
        assert_eq!(parse_rfc3339_ms("2026-11-12T06:00:00.250Z"), Some(1_794_463_200_250));
        assert_eq!(parse_rfc3339_ms("2026-11-12T01:00:00-05:00"), Some(1_794_463_200_000));
        assert_eq!(parse_rfc3339_ms("quatsch"), None);
    }

    #[test]
    fn rfc3339_roundtrip() {
        for ms in [0i64, 1_794_463_200_000, 1_709_164_800_000 /* 29.02.2024 */, 951_782_400_000 /* 29.02.2000 */] {
            assert_eq!(parse_rfc3339_ms(&fmt_rfc3339_ms(ms)), Some(ms), "{}", fmt_rfc3339_ms(ms));
        }
        assert_eq!(fmt_rfc3339_ms(1_794_463_200_000), "2026-11-12T06:00:00Z");
    }

    #[test]
    fn loads_with_start_when_within_lead() {
        let now = parse_rfc3339_ms("2026-11-12T05:58:30Z").unwrap(); // 90 s vor 06:00 UTC
        let s = show("ready", "2026-11-12T07:00:00+01:00", 3);
        match decide(Some(&s), now, 120_000, false, "") {
            Decision::Load { start_unix_ms, late, key, .. } => {
                assert_eq!(start_unix_ms, Some(1_794_463_200_000));
                assert!(!late);
                assert_eq!(key, "s1:3");
            }
            d => panic!("{d:?}"),
        }
    }

    #[test]
    fn too_early_handled_running_and_wrong_status_do_nothing() {
        let s = show("ready", "2026-11-12T07:00:00+01:00", 3);
        let early = parse_rfc3339_ms("2026-11-12T05:00:00Z").unwrap();
        assert_eq!(decide(Some(&s), early, 120_000, false, ""), Decision::Nothing);
        let near = parse_rfc3339_ms("2026-11-12T05:59:00Z").unwrap();
        assert_eq!(decide(Some(&s), near, 120_000, false, "s1:3"), Decision::Nothing, "schon behandelt");
        assert_eq!(decide(Some(&s), near, 120_000, true, ""), Decision::Nothing, "Automation läuft");
        assert_eq!(decide(Some(&show("draft", "2026-11-12T07:00:00+01:00", 3)), near, 120_000, false, ""), Decision::Nothing);
        assert_eq!(decide(None, near, 120_000, false, ""), Decision::Nothing);
        // neuer Stand derselben Sendung wird erneut geladen
        assert!(matches!(decide(Some(&s), near, 120_000, false, "s1:2"), Decision::Load { .. }));
    }

    #[test]
    fn late_loads_without_start() {
        let s = show("live", "2026-11-12T07:00:00+01:00", 2);
        let now = parse_rfc3339_ms("2026-11-12T06:10:00Z").unwrap();
        match decide(Some(&s), now, 120_000, false, "") {
            Decision::Load { start_unix_ms, late, .. } => assert!(start_unix_ms.is_none() && late),
            d => panic!("{d:?}"),
        }
    }

    #[test]
    fn show_without_log_gives_note() {
        let s = show("ready", "2026-11-12T07:00:00+01:00", 0);
        let near = parse_rfc3339_ms("2026-11-12T05:59:00Z").unwrap();
        assert!(matches!(decide(Some(&s), near, 120_000, false, ""), Decision::Note(_)));
    }
}
