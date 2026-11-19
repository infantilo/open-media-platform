//! `Timestamp` und `TimeRange` nach TAMS (Schemas `timestamp`/`timerange`, AppNote 0008 und 0012).
//!
//! * Timestamp `{vorzeichen?}{sekunden}:{nanosekunden}`; beide Teile ohne führende Nullen, Nanosekunden 0…999999999.
//!   Intern Nanosekunden als `i128`. Sekunden sind auf 48 Bit begrenzt (PTP-Umfang, AppNote 0008).
//! * TimeRange `[a_b)`, `(a_`, `_a]`, `_` (ewig), `()` (leer), `[a]` (ein Punkt, nur mit `[` `]`).
//!
//! **Lücke der Norm:** Ein Bereich mit beiden Zeitstempeln, bei dem ein Klammerzeichen fehlt (`0:0_10:0`), ist im
//! Schema-Regex erlaubt, aber nirgends bedeutungsmäßig festgelegt. Wir **lehnen ihn ab** (Fehler `MarkerFehlt`) und
//! erzeugen ihn nie. Zu klären, falls ein Dienst solche Werte liefert.

use std::cmp::Ordering;
use std::fmt;

/// Obergrenze der Sekunden: 48 Bit wie bei PTP (AppNote 0008).
pub const MAX_SECONDS: u64 = (1 << 48) - 1;
const NS: i128 = 1_000_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Leere Zeichenkette oder falsche Form.
    Form(String),
    /// Führende Null, Nanosekunden > 999999999, Sekunden > 2^48−1 usw.
    Zahl(String),
    /// Beide Zeitstempel da, aber ein Klammerzeichen fehlt (Lücke der Norm, siehe Moduldoku).
    MarkerFehlt(String),
    /// Einzelpunkt mit `(` oder `)`.
    PunktExklusiv(String),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Form(s) => write!(f, "ungültige Form: {s:?}"),
            Self::Zahl(s) => write!(f, "ungültige Zahl: {s:?}"),
            Self::MarkerFehlt(s) => write!(f, "Klammerzeichen fehlt (von der Norm nicht festgelegt): {s:?}"),
            Self::PunktExklusiv(s) => write!(f, "Einzelpunkt darf nicht exklusiv sein: {s:?}"),
        }
    }
}
impl std::error::Error for ParseError {}

/// Nanosekunden seit der Epoche (negativ erlaubt).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(i128);

impl Timestamp {
    pub const ZERO: Timestamp = Timestamp(0);

    pub fn from_ns(ns: i128) -> Self {
        Timestamp(ns)
    }
    pub fn ns(self) -> i128 {
        self.0
    }
    /// `None`, wenn die Sekunden die 48-Bit-Grenze überschreiten.
    pub fn from_parts(negative: bool, seconds: u64, nanos: u32) -> Option<Self> {
        if seconds > MAX_SECONDS || nanos > 999_999_999 {
            return None;
        }
        let v = seconds as i128 * NS + nanos as i128;
        Some(Timestamp(if negative { -v } else { v }))
    }
    /// Verschiebt um `offset` (z. B. `ts_offset`: Segmentzeit = Objektzeit + ts_offset).
    pub fn plus(self, offset: Timestamp) -> Timestamp {
        Timestamp(self.0 + offset.0)
    }
    pub fn minus(self, offset: Timestamp) -> Timestamp {
        Timestamp(self.0 - offset.0)
    }

    pub fn parse(s: &str) -> Result<Self, ParseError> {
        let bad = || ParseError::Form(s.to_string());
        let (neg, rest) = match s.strip_prefix('-') {
            Some(r) => (true, r),
            None => (false, s),
        };
        let (sec, nano) = rest.split_once(':').ok_or_else(bad)?;
        let num = |t: &str| -> Result<u64, ParseError> {
            if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
                return Err(bad());
            }
            if t.len() > 1 && t.starts_with('0') {
                return Err(ParseError::Zahl(s.to_string()));
            }
            t.parse::<u64>().map_err(|_| ParseError::Zahl(s.to_string()))
        };
        let seconds = num(sec)?;
        let nanos = num(nano)?;
        if nano.len() > 9 || nanos > 999_999_999 {
            return Err(ParseError::Zahl(s.to_string()));
        }
        Timestamp::from_parts(neg, seconds, nanos as u32).ok_or_else(|| ParseError::Zahl(s.to_string()))
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let a = self.0.unsigned_abs();
        let sign = if self.0 < 0 { "-" } else { "" };
        write!(f, "{sign}{}:{}", a / NS as u128, a % NS as u128)
    }
}

/// Eine Grenze: Zeit und ob sie eingeschlossen ist.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bound {
    pub ts: Timestamp,
    pub inclusive: bool,
}

/// Zeitbereich. `start`/`end` = `None` bedeutet unendlich. Leer ist ein eigener Fall.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeRange {
    Empty,
    Range { start: Option<Bound>, end: Option<Bound> },
}

impl TimeRange {
    pub const ETERNITY: TimeRange = TimeRange::Range { start: None, end: None };

    /// Normalisiert: Ende vor Start oder gleiche Zeit mit einer exklusiven Grenze → leer.
    pub fn new(start: Option<Bound>, end: Option<Bound>) -> Self {
        if let (Some(s), Some(e)) = (start, end) {
            match s.ts.cmp(&e.ts) {
                Ordering::Greater => return TimeRange::Empty,
                Ordering::Equal if !(s.inclusive && e.inclusive) => return TimeRange::Empty,
                _ => {}
            }
        }
        TimeRange::Range { start, end }
    }
    /// `[start_end)` — die übliche Form eines Segments.
    pub fn half_open(start: Timestamp, end: Timestamp) -> Self {
        Self::new(Some(Bound { ts: start, inclusive: true }), Some(Bound { ts: end, inclusive: false }))
    }
    /// `[t]`.
    pub fn instant(t: Timestamp) -> Self {
        Self::new(Some(Bound { ts: t, inclusive: true }), Some(Bound { ts: t, inclusive: true }))
    }
    pub fn is_empty(&self) -> bool {
        matches!(self, TimeRange::Empty)
    }

    pub fn contains(&self, t: Timestamp) -> bool {
        let TimeRange::Range { start, end } = self else { return false };
        let after = start.is_none_or(|s| if s.inclusive { t >= s.ts } else { t > s.ts });
        let before = end.is_none_or(|e| if e.inclusive { t <= e.ts } else { t < e.ts });
        after && before
    }

    /// Schnittmenge (normalisiert).
    pub fn intersect(&self, other: &TimeRange) -> TimeRange {
        let (TimeRange::Range { start: s1, end: e1 }, TimeRange::Range { start: s2, end: e2 }) = (self, other) else {
            return TimeRange::Empty;
        };
        // späterer Start gewinnt; bei gleicher Zeit gewinnt die exklusive Grenze
        let start = match (s1, s2) {
            (None, x) | (x, None) => *x,
            (Some(a), Some(b)) => Some(match a.ts.cmp(&b.ts) {
                Ordering::Greater => *a,
                Ordering::Less => *b,
                Ordering::Equal => Bound { ts: a.ts, inclusive: a.inclusive && b.inclusive },
            }),
        };
        // früheres Ende gewinnt; bei gleicher Zeit gewinnt die exklusive Grenze
        let end = match (e1, e2) {
            (None, x) | (x, None) => *x,
            (Some(a), Some(b)) => Some(match a.ts.cmp(&b.ts) {
                Ordering::Less => *a,
                Ordering::Greater => *b,
                Ordering::Equal => Bound { ts: a.ts, inclusive: a.inclusive && b.inclusive },
            }),
        };
        TimeRange::new(start, end)
    }

    /// Überlappen sich die Bereiche (Segmente eines Flows dürfen es nicht)?
    pub fn overlaps(&self, other: &TimeRange) -> bool {
        !self.intersect(other).is_empty()
    }

    /// Liegt `other` vollständig in `self`? (Ein leerer Bereich liegt in jedem.)
    pub fn contains_range(&self, other: &TimeRange) -> bool {
        other.is_empty() || self.intersect(other) == *other
    }

    /// Alle Zeiten um `offset` verschieben (z. B. Objektzeit → Flow-Zeit mit `ts_offset`).
    pub fn shift(&self, offset: Timestamp) -> TimeRange {
        match self {
            TimeRange::Empty => TimeRange::Empty,
            TimeRange::Range { start, end } => TimeRange::Range {
                start: start.map(|b| Bound { ts: b.ts.plus(offset), ..b }),
                end: end.map(|b| Bound { ts: b.ts.plus(offset), ..b }),
            },
        }
    }

    /// Dauer, wenn beide Grenzen endlich sind.
    pub fn duration_ns(&self) -> Option<i128> {
        match self {
            TimeRange::Empty => Some(0),
            TimeRange::Range { start: Some(s), end: Some(e) } => Some(e.ts.ns() - s.ts.ns()),
            _ => None,
        }
    }

    pub fn parse(s: &str) -> Result<Self, ParseError> {
        let bad = || ParseError::Form(s.to_string());
        if s == "_" {
            return Ok(TimeRange::ETERNITY);
        }
        if s == "()" {
            return Ok(TimeRange::Empty);
        }
        let mut body = s;
        let open = match body.chars().next() {
            Some(c @ ('[' | '(')) => {
                body = &body[1..];
                Some(c)
            }
            _ => None,
        };
        let close = match body.chars().last() {
            Some(c @ (']' | ')')) => {
                body = &body[..body.len() - 1];
                Some(c)
            }
            _ => None,
        };
        if body.is_empty() && (open.is_some() || close.is_some()) {
            return Err(bad());
        }
        let Some((a, b)) = body.split_once('_') else {
            // ein einzelner Zeitstempel: nur ohne Klammern oder mit [ ]
            if body.is_empty() {
                return Err(bad());
            }
            if open == Some('(') || close == Some(')') {
                return Err(ParseError::PunktExklusiv(s.to_string()));
            }
            if open.is_some() != close.is_some() {
                return Err(bad());
            }
            return Ok(TimeRange::instant(Timestamp::parse(body)?));
        };
        let incl = |c: Option<char>, want: char| c == Some(want);
        let start = if a.is_empty() {
            None
        } else {
            let inclusive = match open {
                Some('[') => true,
                Some('(') => false,
                _ => return Err(ParseError::MarkerFehlt(s.to_string())),
            };
            Some(Bound { ts: Timestamp::parse(a)?, inclusive })
        };
        let end = if b.is_empty() {
            None
        } else {
            let inclusive = if incl(close, ']') {
                true
            } else if incl(close, ')') {
                false
            } else {
                return Err(ParseError::MarkerFehlt(s.to_string()));
            };
            Some(Bound { ts: Timestamp::parse(b)?, inclusive })
        };
        Ok(TimeRange::new(start, end))
    }
}

impl fmt::Display for TimeRange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TimeRange::Empty => write!(f, "()"),
            TimeRange::Range { start: None, end: None } => write!(f, "_"),
            TimeRange::Range { start: Some(s), end: Some(e) } if s.ts == e.ts => write!(f, "[{}]", s.ts),
            TimeRange::Range { start, end } => {
                if let Some(s) = start {
                    write!(f, "{}{}", if s.inclusive { '[' } else { '(' }, s.ts)?;
                }
                write!(f, "_")?;
                if let Some(e) = end {
                    write!(f, "{}{}", e.ts, if e.inclusive { ']' } else { ')' })?;
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(s: &str) -> Timestamp {
        Timestamp::parse(s).unwrap()
    }
    fn tr(s: &str) -> TimeRange {
        TimeRange::parse(s).unwrap()
    }

    #[test]
    fn timestamp_examples_from_the_schema() {
        // "1:40000000" = 27. Bild bei 25 Hz (Schema-Text)
        assert_eq!(ts("1:40000000").ns(), 1_040_000_000);
        assert_eq!(ts("1694429247:40000000").ns(), 1_694_429_247_040_000_000);
        assert_eq!(ts("0:0"), Timestamp::ZERO);
        assert_eq!(ts("-1:500").ns(), -1_000_000_500);
        assert_eq!(ts("-0:5").ns(), -5);
    }

    #[test]
    fn timestamp_round_trip_and_format() {
        for s in ["0:0", "1:40000000", "-3:999999999", "281474976710655:999999999", "10:1"] {
            assert_eq!(ts(s).to_string(), s);
        }
        // Zeitstempel -0 gibt es nicht
        assert_eq!(Timestamp::from_ns(0).to_string(), "0:0");
    }

    #[test]
    fn timestamp_rejects_invalid() {
        for s in ["", ":", "1", "1:", ":1", "01:0", "1:01", "1:1000000000", "1:0000", "+1:0", "1.5:0", "-:1", "--1:0", "1:2:3", " 1:0", "a:b"] {
            assert!(Timestamp::parse(s).is_err(), "{s:?} müsste abgelehnt werden");
        }
        // 2^48 Sekunden ist zu viel, 2^48−1 geht
        assert!(Timestamp::parse("281474976710656:0").is_err());
        assert!(Timestamp::parse("281474976710655:0").is_ok());
    }

    #[test]
    fn timerange_examples_from_the_schema() {
        assert_eq!(tr("[0:0_10:0)").duration_ns(), Some(10_000_000_000)); // 10 s ab 0:0
        let r = tr("(5:0_"); // ab 5:0 exklusiv bis in alle Ewigkeit
        assert!(!r.contains(ts("5:0")) && r.contains(ts("5:1")) && r.contains(ts("999999:0")));
        assert_eq!(tr("_"), TimeRange::ETERNITY);
        assert!(tr("()").is_empty());
        // eine Sekunde TAI
        assert_eq!(tr("[1694429247:0_1694429248:0)").duration_ns(), Some(1_000_000_000));
        // [t] gleich [t_t]
        assert_eq!(tr("[1694429247:0]"), tr("[1694429247:0_1694429247:0]"));
        assert_eq!(tr("[10:0]"), TimeRange::instant(ts("10:0")));
        assert!(tr("[10:0]").contains(ts("10:0")) && !tr("[10:0]").contains(ts("10:1")));
    }

    #[test]
    fn timerange_format_is_canonical() {
        for s in ["[0:0_10:0)", "(5:0_", "_5:0]", "_", "()", "[10:0]", "(1:0_2:0]", "[-5:0_5:0)"] {
            assert_eq!(tr(s).to_string(), s, "{s}");
        }
        // [a_a] wird als [a] ausgegeben (kurze Form ist laut Schema vorzuziehen)
        assert_eq!(tr("[10:0_10:0]").to_string(), "[10:0]");
    }

    #[test]
    fn timerange_empty_rules() {
        // Ende vor Start → leer; gleiche Zeit mit exklusiver Grenze → leer
        assert!(tr("[10:0_5:0)").is_empty());
        assert!(tr("[5:0_5:0)").is_empty());
        assert!(tr("(5:0_5:0]").is_empty());
        assert!(!tr("[5:0_5:0]").is_empty());
        assert!(tr("()").intersect(&TimeRange::ETERNITY).is_empty());
    }

    #[test]
    fn timerange_rejects_invalid() {
        for s in ["", "[", "[]", "(5:0)", "[5:0)", "(5:0]", "0:0_10:0", "[0:0_10:0", "0:0_10:0)", "[0:0_", "_x", "[x_5:0)", "[1:0_2:0]]"] {
            // Hinweis: "[0:0_" (Start mit Klammer, offenes Ende) ist gültig, siehe unten
            let r = TimeRange::parse(s);
            if s == "[0:0_" {
                assert!(r.is_ok());
            } else {
                assert!(r.is_err(), "{s:?} müsste abgelehnt werden, war {r:?}");
            }
        }
    }

    #[test]
    fn missing_marker_with_two_timestamps_is_an_explicit_error() {
        assert!(matches!(TimeRange::parse("0:0_10:0"), Err(ParseError::MarkerFehlt(_))));
        assert!(matches!(TimeRange::parse("(5:0)"), Err(ParseError::PunktExklusiv(_))));
    }

    #[test]
    fn adjacent_half_open_segments_do_not_overlap() {
        let a = tr("[0:0_2:0)");
        let b = tr("[2:0_4:0)");
        assert!(!a.overlaps(&b) && !b.overlaps(&a));
        // ein Nanosekunden-Überstand ist eine Überlappung
        assert!(tr("[0:0_2:1)").overlaps(&b));
        // geschlossenes Ende berührt den Anfang des Nachbarn
        assert!(tr("[0:0_2:0]").overlaps(&b));
        // offene Bereiche
        assert!(tr("(5:0_").overlaps(&tr("[100:0_101:0)")));
        assert!(!tr("_5:0)").overlaps(&tr("[5:0_6:0)")));
        assert!(TimeRange::ETERNITY.overlaps(&a));
    }

    #[test]
    fn intersect_and_contains_range() {
        assert_eq!(tr("[0:0_10:0)").intersect(&tr("[5:0_20:0)")), tr("[5:0_10:0)"));
        assert_eq!(tr("[0:0_10:0)").intersect(&tr("(0:0_10:0]")), tr("(0:0_10:0)"));
        // Segment (nach ts_offset) muss vollständig im Objektbereich liegen (Spezifikation, POST segments)
        let object = tr("[100:0_110:0)");
        assert!(object.contains_range(&tr("[100:0_105:0)")));
        assert!(object.contains_range(&tr("[100:0_110:0)")));
        assert!(!object.contains_range(&tr("[100:0_110:1)")));
        assert!(!object.contains_range(&tr("[99:999999999_105:0)")));
        assert!(object.contains_range(&tr("()")));
        assert!(TimeRange::ETERNITY.contains_range(&object));
    }

    #[test]
    fn shift_with_ts_offset() {
        // ts_offset = Segmentzeit − Objektzeit
        let object_range = tr("[0:0_2:0)");
        let ts_offset = ts("1694429247:0");
        assert_eq!(object_range.shift(ts_offset), tr("[1694429247:0_1694429249:0)"));
        assert_eq!(tr("[5:0_").shift(ts("-3:0")), tr("[2:0_"));
        assert!(TimeRange::Empty.shift(ts_offset).is_empty());
    }
}
