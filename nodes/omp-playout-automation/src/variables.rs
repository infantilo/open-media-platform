//! Variablen für Child Events: Werte aus Playlist-Events (Titel, Zeiten, Medien-Metadaten von
//! Vorgänger / aktuellem / Nachfolger / gesuchtem Event) in Daten und Parameter einsetzen.
//!
//! REINE Logik (keine Uhr, kein Netz, kein State): alles, was sie braucht, steht im [`Ctx`]. Der
//! Automator baut den Kontext zum Zeitpunkt des Child-Starts (`main.rs`), damit „Zeit bis zum Ende“
//! und Ähnliches auf den tatsächlichen Startmoment des Kindes bezogen sind.
//!
//! Schreibweise: `{{bezug.feld|format|format:argument}}`
//!
//! * **Bezug:** `current` (das Event, zu dem das Child gehört), `prev`, `prev2`, `next`, `next2`, …,
//!   `onair` (läuft gerade), `first`, `last`, `at(N)` (Position), `item(ID)`,
//!   `find(Bedingung)` (erstes passendes Event NACH dem aktuellen), `findprev(Bedingung)` (nächstes
//!   passendes DAVOR). Trenner zum Feld ist `.` oder `:` (`{{next:title}}` aus Kapitel 6 gilt weiter).
//! * **Feld:** siehe [`FIELDS`]; Medien-Metadaten als `meta.<schlüssel>` (sucht in allen Abschnitten)
//!   oder `meta.<abschnitt>.<schlüssel>`.
//! * **Format:** je Werttyp (Zeitpunkt, Dauer, Zahl, Text), siehe [`catalog`]; mehrere mit `|` verkettbar.
//! * **Bedingung** (`find`): Klauseln mit `&` verknüpft, z. B. `type=CLIP & title~Nachrichten`;
//!   Operatoren `= != ~ !~ ^ $ > >= < <= ?` (enthält, enthält nicht, beginnt, endet, vorhanden).
//!
//! Ein Platzhalter, der nichts findet (kein nächstes Event, Metadatum fehlt), ergibt einen leeren
//! Text oder den Wert von `|default:…` — nie den sichtbaren Platzhalter auf der Grafik.

use chrono::{Datelike, Local, TimeZone, Timelike};
use serde_json::{json, Value};

/// Ein Event der Playlist, so wie die Variablen es sehen.
#[derive(Debug, Clone, Default)]
pub struct EventFacts {
    pub id: String,
    pub title: String,
    /// `CLIP`, `LIVE`, `IMAGE`, `HOLD`, `JUMP`, `BLACK`, `PATTERN`.
    pub kind: String,
    /// 1-basiert; 0 = nicht in der Playlist (Cart).
    pub index: usize,
    pub duration_ms: u64,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub start_type: String,
    pub source: String,
    pub file: String,
    pub note: String,
    pub ad_class: String,
    /// Asset-Metadaten aus dem Asset-System (`{title, description, descriptive:{…}, …}`), sonst `Null`.
    pub meta: Value,
}

#[derive(Debug, Clone)]
pub struct Ctx {
    /// Bezugszeitpunkt (UTC-ms): der geplante Startmoment des Kindes.
    pub now_ms: i64,
    /// Bildrate (Zähler, Nenner) für `frames`/`tc`.
    pub fps: (u32, u32),
    /// Alle Events der Playlist in Reihenfolge.
    pub events: Vec<EventFacts>,
    /// Position des Besitzers in `events`; `None` bei Carts (dann gilt `owner_extra`).
    pub owner: Option<usize>,
    pub owner_extra: Option<EventFacts>,
    /// Position des laufenden Events.
    pub onair: Option<usize>,
    /// Abweichende Zeitzone in Sekunden Versatz (nur Tests); `None` = Ortszeit des Rechners.
    pub tz_offset_secs: Option<i32>,
}

impl Ctx {
    pub fn empty(now_ms: i64) -> Ctx {
        Ctx { now_ms, fps: (25, 1), events: Vec::new(), owner: None, owner_extra: None, onair: None, tz_offset_secs: None }
    }

    pub fn current(&self) -> Option<&EventFacts> {
        match self.owner {
            Some(i) => self.events.get(i),
            None => self.owner_extra.as_ref(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Werte

#[derive(Debug, Clone, PartialEq)]
enum Val {
    Text(String),
    Num(f64),
    /// Dauer in ms (kann negativ sein).
    Dur(i64),
    /// Zeitpunkt in UTC-ms.
    At(i64),
    Bool(bool),
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ty {
    Text,
    Num,
    Dur,
    At,
}

/// Feldkatalog: (Schlüssel, Alias, Typ, Beschriftung de, Beschriftung en, Beispiel).
pub const FIELDS: &[(&str, &str, &str, &str, &str, &str)] = &[
    ("title", "label", "text", "Titel", "Title", "Tagesschau"),
    ("id", "", "text", "Event-ID", "Event ID", "item12"),
    ("type", "", "text", "Event-Typ (CLIP, LIVE, …)", "Event type (CLIP, LIVE, …)", "CLIP"),
    ("index", "position", "num", "Position in der Playlist", "Position in playlist", "4"),
    ("source", "", "text", "Quelle (Datei oder Live-Quelle)", "Source (file or live source)", "/media/news.mxf"),
    ("file", "", "text", "Dateiname", "File name", "news.mxf"),
    ("note", "", "text", "Notiz des Events", "Event note", ""),
    ("adClass", "", "text", "Werbeklasse", "Ad class", "commercial"),
    ("startType", "", "text", "Startart (sequence, manual, fixtime)", "Start type", "sequence"),
    ("start", "", "at", "Startzeit (geplant)", "Start time (planned)", "20:15:00"),
    ("end", "", "at", "Endzeit (geplant)", "End time (planned)", "20:45:00"),
    ("duration", "", "dur", "Dauer", "Duration", "00:30:00"),
    ("untilStart", "", "dur", "Zeit bis zum Start", "Time until start", "00:05:00"),
    ("untilEnd", "remaining", "dur", "Zeit bis zum Ende", "Time until end", "00:25:00"),
    ("elapsed", "", "dur", "Seit dem Start vergangen", "Elapsed since start", "00:02:10"),
    ("meta.<Schlüssel>", "", "text", "Medien-Metadatum (z. B. meta.artist)", "Media metadata (e.g. meta.artist)", ""),
];

const REFS: &[(&str, &str, &str)] = &[
    ("prev", "Voriges Event", "Previous event"),
    ("current", "Aktuelles Event (dieses Child)", "Current event (this child)"),
    ("next", "Nächstes Event", "Next event"),
    ("onair", "Event, das gerade läuft", "Event on air right now"),
    ("first", "Erstes Event der Liste", "First event in list"),
    ("last", "Letztes Event der Liste", "Last event in list"),
];

fn field_ty(name: &str) -> Option<Ty> {
    FIELDS.iter().find(|f| f.0 == name || (!f.1.is_empty() && f.1 == name)).map(|f| match f.2 {
        "num" => Ty::Num,
        "dur" => Ty::Dur,
        "at" => Ty::At,
        _ => Ty::Text,
    })
}

fn canonical_field(name: &str) -> Option<&'static str> {
    FIELDS.iter().find(|f| f.0 == name || (!f.1.is_empty() && f.1 == name)).map(|f| f.0)
}

fn event_field(ev: &EventFacts, ctx: &Ctx, field: &str) -> Val {
    let txt = |s: &str| if s.is_empty() { Val::None } else { Val::Text(s.to_string()) };
    if let Some(path) = field.strip_prefix("meta.") {
        return meta_lookup(&ev.meta, path);
    }
    match canonical_field(field).unwrap_or("") {
        "title" => txt(&ev.title),
        "id" => txt(&ev.id),
        "type" => txt(&ev.kind),
        "index" => {
            if ev.index > 0 {
                Val::Num(ev.index as f64)
            } else {
                Val::None
            }
        }
        "source" => txt(&ev.source),
        "file" => txt(&ev.file),
        "note" => txt(&ev.note),
        "adClass" => txt(&ev.ad_class),
        "startType" => txt(&ev.start_type),
        "start" => ev.start_ms.map_or(Val::None, Val::At),
        "end" => ev.end_ms.map_or(Val::None, Val::At),
        "duration" => {
            if ev.duration_ms > 0 {
                Val::Dur(ev.duration_ms as i64)
            } else {
                Val::None
            }
        }
        "untilStart" => ev.start_ms.map_or(Val::None, |s| Val::Dur(s - ctx.now_ms)),
        "untilEnd" => ev.end_ms.map_or(Val::None, |e| Val::Dur(e - ctx.now_ms)),
        "elapsed" => ev.start_ms.map_or(Val::None, |s| Val::Dur(ctx.now_ms - s)),
        _ => Val::None,
    }
}

fn json_to_val(v: &Value) -> Val {
    match v {
        Value::Null => Val::None,
        Value::String(s) if s.is_empty() => Val::None,
        Value::String(s) => Val::Text(s.clone()),
        Value::Number(n) => Val::Num(n.as_f64().unwrap_or(0.0)),
        Value::Bool(b) => Val::Bool(*b),
        Value::Array(a) => Val::Text(a.iter().map(|x| val_text(&json_to_val(x), &Ctx::empty(0))).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", ")),
        Value::Object(_) => Val::Text(v.to_string()),
    }
}

/// `meta.<schlüssel>`: erst als Pfad (`descriptive.artist`), sonst in den Abschnitten der Reihe nach.
fn meta_lookup(meta: &Value, path: &str) -> Val {
    if meta.is_null() || path.is_empty() {
        return Val::None;
    }
    let walk = |root: &Value, p: &str| -> Option<Value> {
        let mut cur = root;
        for part in p.split('.') {
            cur = cur.get(part)?;
        }
        Some(cur.clone())
    };
    if let Some(v) = walk(meta, path) {
        return json_to_val(&v);
    }
    for section in ["descriptive", "editorial", "custom", "technical", "system", "ai"] {
        if let Some(v) = meta.get(section).and_then(|s| walk(s, path)) {
            return json_to_val(&v);
        }
    }
    Val::None
}

/// Alle bekannten Metadaten-Schlüssel (für die Auswahl in der Oberfläche), `abschnitt.schlüssel`.
pub fn meta_keys(events: &[EventFacts]) -> Vec<String> {
    let mut keys = std::collections::BTreeSet::new();
    for ev in events {
        for section in ["descriptive", "editorial", "custom", "technical", "system", "ai"] {
            if let Some(Value::Object(map)) = ev.meta.get(section) {
                for k in map.keys() {
                    keys.insert(format!("{section}.{k}"));
                }
            }
        }
        if let Value::Object(map) = &ev.meta {
            for (k, v) in map {
                if !v.is_object() && !v.is_array() {
                    keys.insert(k.clone());
                }
            }
        }
    }
    keys.into_iter().collect()
}

// ---------------------------------------------------------------------------------------------
// Bezüge und Suche

#[derive(Debug, Clone, PartialEq)]
enum RefKind {
    Current,
    Prev(usize),
    Next(usize),
    OnAir,
    First,
    Last,
    At(usize),
    Item(String),
    Find(Vec<Clause>),
    FindPrev(Vec<Clause>),
}

#[derive(Debug, Clone, PartialEq)]
struct Clause {
    field: String,
    op: String,
    value: String,
}

/// Teilt `name(inhalt)` in `(name, Some(inhalt))`.
fn split_call(s: &str) -> (&str, Option<&str>) {
    match s.find('(') {
        Some(i) if s.ends_with(')') => (&s[..i], Some(&s[i + 1..s.len() - 1])),
        _ => (s, None),
    }
}

fn parse_ref(s: &str) -> Result<RefKind, String> {
    let s = s.trim();
    let (name, arg) = split_call(s);
    let name_l = name.to_ascii_lowercase();
    if let Some(arg) = arg {
        return match name_l.as_str() {
            "item" => Ok(RefKind::Item(arg.trim().trim_matches('"').to_string())),
            "at" => arg.trim().parse::<usize>().ok().filter(|n| *n >= 1).map(RefKind::At).ok_or_else(|| format!("at({arg}): Position muss eine Zahl ab 1 sein")),
            "find" => parse_query(arg).map(RefKind::Find),
            "findprev" => parse_query(arg).map(RefKind::FindPrev),
            _ => Err(format!("Bezug „{name}(…)“ unbekannt (item, at, find, findprev)")),
        };
    }
    let counted = |base: &str| -> Option<usize> {
        let rest = name_l.strip_prefix(base)?;
        if rest.is_empty() {
            Some(1)
        } else {
            rest.parse::<usize>().ok().filter(|n| *n >= 1)
        }
    };
    Ok(match name_l.as_str() {
        "current" | "self" | "this" | "aktuell" => RefKind::Current,
        "onair" => RefKind::OnAir,
        "first" => RefKind::First,
        "last" => RefKind::Last,
        _ => {
            if let Some(n) = counted("prev") {
                RefKind::Prev(n)
            } else if let Some(n) = counted("next") {
                RefKind::Next(n)
            } else {
                return Err(format!("Bezug „{name}“ unbekannt (prev, current, next, onair, first, last, at(N), item(ID), find(…), findprev(…))"));
            }
        }
    })
}

/// Zerlegt `a=b & c~"d & e"` an `&` außerhalb von Anführungszeichen.
fn parse_query(q: &str) -> Result<Vec<Clause>, String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for ch in q.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                cur.push(ch);
            }
            '&' if !quoted => parts.push(std::mem::take(&mut cur)),
            _ => cur.push(ch),
        }
    }
    parts.push(cur);
    let mut out = Vec::new();
    for p in parts {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        // Operatoren, längere zuerst
        let ops = ["!=", "!~", ">=", "<=", "=", "~", "^", "$", ">", "<", "?"];
        let mut found = None;
        let mut quoted = false;
        'scan: for (i, ch) in p.char_indices() {
            if ch == '"' {
                quoted = !quoted;
            }
            if quoted {
                continue;
            }
            for op in ops {
                if p[i..].starts_with(op) {
                    found = Some((i, op));
                    break 'scan;
                }
            }
        }
        let Some((i, op)) = found else { return Err(format!("Bedingung „{p}“: Operator fehlt (= != ~ !~ ^ $ > >= < <= ?)")) };
        let field = p[..i].trim().to_string();
        let value = p[i + op.len()..].trim().trim_matches('"').to_string();
        if field.is_empty() {
            return Err(format!("Bedingung „{p}“: Feldname fehlt"));
        }
        if !field.starts_with("meta.") && canonical_field(&field).is_none() {
            return Err(format!("Bedingung „{p}“: Feld „{field}“ unbekannt"));
        }
        if op != "?" && value.is_empty() && !matches!(op, "=" | "!=") {
            return Err(format!("Bedingung „{p}“: Vergleichswert fehlt"));
        }
        out.push(Clause { field, op: op.to_string(), value });
    }
    if out.is_empty() {
        return Err("Suchbedingung ist leer".to_string());
    }
    Ok(out)
}

fn clause_matches(c: &Clause, ev: &EventFacts, ctx: &Ctx) -> bool {
    let v = event_field(ev, ctx, &c.field);
    if c.op == "?" {
        return v != Val::None;
    }
    let ty = if c.field.starts_with("meta.") { Ty::Text } else { field_ty(&c.field).unwrap_or(Ty::Text) };
    // Zahlen-/Zeitvergleich
    let cmp: Option<std::cmp::Ordering> = match (&v, ty) {
        (Val::Dur(a), _) => parse_duration(&c.value).map(|b| a.cmp(&b)),
        (Val::At(a), _) => parse_instant(&c.value, ctx, *a).map(|b| a.cmp(&b)),
        (Val::Num(a), _) => c.value.trim().replace(',', ".").parse::<f64>().ok().and_then(|b| a.partial_cmp(&b)),
        _ => None,
    };
    let text = val_text(&v, ctx);
    let (tl, vl) = (text.to_lowercase(), c.value.to_lowercase());
    match c.op.as_str() {
        "=" => cmp.map_or(tl == vl, |o| o.is_eq()),
        "!=" => cmp.map_or(tl != vl, |o| o.is_ne()),
        "~" => tl.contains(&vl),
        "!~" => !tl.contains(&vl),
        "^" => tl.starts_with(&vl),
        "$" => tl.ends_with(&vl),
        ">" => cmp.is_some_and(|o| o.is_gt()),
        ">=" => cmp.is_some_and(|o| o.is_ge()),
        "<" => cmp.is_some_and(|o| o.is_lt()),
        "<=" => cmp.is_some_and(|o| o.is_le()),
        _ => false,
    }
}

fn query_matches(q: &[Clause], ev: &EventFacts, ctx: &Ctx) -> bool {
    q.iter().all(|c| clause_matches(c, ev, ctx))
}

fn resolve_ref<'a>(r: &RefKind, ctx: &'a Ctx) -> Option<&'a EventFacts> {
    let at = |i: Option<usize>| i.and_then(|i| ctx.events.get(i));
    match r {
        RefKind::Current => ctx.current(),
        RefKind::Prev(n) => at(ctx.owner.and_then(|o| o.checked_sub(*n))),
        RefKind::Next(n) => at(ctx.owner.map(|o| o + n)),
        RefKind::OnAir => at(ctx.onair),
        RefKind::First => ctx.events.first(),
        RefKind::Last => ctx.events.last(),
        RefKind::At(n) => ctx.events.get(n - 1),
        RefKind::Item(id) => ctx.events.iter().find(|e| &e.id == id).or_else(|| ctx.owner_extra.as_ref().filter(|e| &e.id == id)),
        RefKind::Find(q) => {
            let from = ctx.owner.map_or(0, |o| o + 1);
            ctx.events.iter().skip(from).find(|e| query_matches(q, e, ctx))
        }
        RefKind::FindPrev(q) => {
            let to = ctx.owner.unwrap_or(ctx.events.len());
            ctx.events.iter().take(to).rev().find(|e| query_matches(q, e, ctx))
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Zeit: Eingabe

/// `90`, `90s`, `1:30`, `01:02:03`, `1h30m`, `500ms`, `1,5s` → ms.
pub fn parse_duration(s: &str) -> Option<i64> {
    let s = s.trim().to_ascii_lowercase().replace(',', ".");
    if s.is_empty() {
        return None;
    }
    let neg = s.starts_with('-');
    let s = s.trim_start_matches('-');
    let ms = if s.contains(':') {
        let parts: Vec<&str> = s.split(':').collect();
        let mut secs = 0.0;
        for p in &parts {
            secs = secs * 60.0 + p.parse::<f64>().ok()?;
        }
        if parts.len() > 3 {
            return None;
        }
        secs * 1000.0
    } else if s.contains(|c: char| c.is_ascii_alphabetic()) {
        // 1h30m10s, 2min, 500ms, 1,5s
        let mut total = 0.0;
        let mut num = String::new();
        let mut unit = String::new();
        let flush = |num: &mut String, unit: &mut String, total: &mut f64| -> Option<()> {
            let n: f64 = num.parse().ok()?;
            *total += n * match unit.as_str() {
                "h" | "std" => 3_600_000.0,
                "m" | "min" => 60_000.0,
                "s" | "sec" | "sek" => 1000.0,
                "ms" => 1.0,
                _ => return None,
            };
            num.clear();
            unit.clear();
            Some(())
        };
        for c in s.chars() {
            if c.is_ascii_digit() || c == '.' {
                if !unit.is_empty() {
                    flush(&mut num, &mut unit, &mut total)?;
                }
                num.push(c);
            } else if c.is_ascii_alphabetic() {
                unit.push(c);
            } else if c != ' ' {
                return None;
            }
        }
        flush(&mut num, &mut unit, &mut total)?;
        total
    } else {
        s.parse::<f64>().ok()? * 1000.0
    };
    let ms = ms.round() as i64;
    Some(if neg { -ms } else { ms })
}

fn tz_parts(ms: i64, ctx: &Ctx) -> Option<chrono::NaiveDateTime> {
    match ctx.tz_offset_secs {
        Some(off) => chrono::DateTime::from_timestamp_millis(ms).map(|d| d.naive_utc() + chrono::Duration::seconds(off as i64)),
        None => Local.timestamp_millis_opt(ms).single().map(|d| d.naive_local()),
    }
}

fn from_local_naive(n: chrono::NaiveDateTime, ctx: &Ctx) -> Option<i64> {
    match ctx.tz_offset_secs {
        Some(off) => Some(n.and_utc().timestamp_millis() - off as i64 * 1000),
        None => Local.from_local_datetime(&n).earliest().map(|d| d.timestamp_millis()),
    }
}

/// `20:15`, `20:15:30` (heute; liegt es vor `reference`, gilt es als dieselbe Tageszeit am Tag von `reference`),
/// `2026-11-12 20:15`, RFC 3339 → UTC-ms.
fn parse_instant(s: &str, ctx: &Ctx, reference: i64) -> Option<i64> {
    let s = s.trim();
    if let Some(ms) = omp_playout_core::schedule::parse_start_at(s) {
        return Some(ms);
    }
    let day = tz_parts(reference, ctx)?.date();
    let (date, time_s) = match s.split_once(' ') {
        Some((d, t)) if d.contains('-') => (chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()?, t),
        _ => (day, s),
    };
    let mut it = time_s.split(':');
    let h: u32 = it.next()?.parse().ok()?;
    let m: u32 = it.next().unwrap_or("0").parse().ok()?;
    let sec: u32 = it.next().unwrap_or("0").parse().ok()?;
    from_local_naive(date.and_hms_opt(h, m, sec)?, ctx)
}

// ---------------------------------------------------------------------------------------------
// Zeit: Ausgabe

const DAYS_DE: [&str; 7] = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const DAYS_EN: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS_DE: [&str; 12] = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const MONTHS_EN: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

fn frames_of(ms_in_second: i64, fps: (u32, u32)) -> i64 {
    (ms_in_second * fps.0 as i64 / (fps.1.max(1) as i64 * 1000)).max(0)
}

fn fps_width(fps: (u32, u32)) -> usize {
    let n = (fps.0 as f64 / fps.1.max(1) as f64).ceil() as u32;
    if n >= 100 { 3 } else { 2 }
}

/// Muster mit `yyyy yy MMMM MMM MM dd EEEE EEE HH hh mm ss SSS ff a` (Rest unverändert; `'…'` = wörtlich).
fn format_pattern(ms: i64, ctx: &Ctx, pat: &str, en: bool) -> String {
    let Some(t) = tz_parts(ms, ctx) else { return String::new() };
    let wd = t.weekday().num_days_from_monday() as usize;
    let mo = t.month0() as usize;
    let (days, months) = if en { (&DAYS_EN, &MONTHS_EN) } else { (&DAYS_DE, &MONTHS_DE) };
    let ms_in_sec = ms.rem_euclid(1000);
    let chars: Vec<char> = pat.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' {
            i += 1;
            while i < chars.len() && chars[i] != '\'' {
                out.push(chars[i]);
                i += 1;
            }
            i += 1;
            continue;
        }
        let mut n = 1;
        while i + n < chars.len() && chars[i + n] == c {
            n += 1;
        }
        let tok_ok = matches!(c, 'y' | 'M' | 'd' | 'E' | 'H' | 'h' | 'm' | 's' | 'S' | 'f' | 'a');
        if !tok_ok {
            out.push(c);
            i += 1;
            continue;
        }
        match (c, n) {
            ('y', n) if n >= 3 => out.push_str(&format!("{:04}", t.year())),
            ('y', _) => out.push_str(&format!("{:02}", t.year().rem_euclid(100))),
            ('M', 1) => out.push_str(&(mo + 1).to_string()),
            ('M', 2) => out.push_str(&format!("{:02}", mo + 1)),
            ('M', 3) => out.push_str(&months[mo].chars().take(3).collect::<String>()),
            ('M', _) => out.push_str(months[mo]),
            ('d', 1) => out.push_str(&t.day().to_string()),
            ('d', _) => out.push_str(&format!("{:02}", t.day())),
            ('E', n) if n >= 4 => out.push_str(days[wd]),
            ('E', _) => out.push_str(&days[wd].chars().take(2).collect::<String>()),
            ('H', 1) => out.push_str(&t.hour().to_string()),
            ('H', _) => out.push_str(&format!("{:02}", t.hour())),
            ('h', k) => {
                let h = if t.hour() % 12 == 0 { 12 } else { t.hour() % 12 };
                out.push_str(&if k == 1 { h.to_string() } else { format!("{h:02}") });
            }
            ('m', 1) => out.push_str(&t.minute().to_string()),
            ('m', _) => out.push_str(&format!("{:02}", t.minute())),
            ('s', 1) => out.push_str(&t.second().to_string()),
            ('s', _) => out.push_str(&format!("{:02}", t.second())),
            ('S', _) => out.push_str(&format!("{ms_in_sec:03}")),
            ('f', _) => out.push_str(&format!("{:0w$}", frames_of(ms_in_sec, ctx.fps), w = fps_width(ctx.fps))),
            ('a', _) => out.push_str(if t.hour() < 12 { "AM" } else { "PM" }),
            _ => {}
        }
        i += n;
    }
    out
}

fn midnight_diff_days(ms: i64, ctx: &Ctx) -> Option<i64> {
    let a = tz_parts(ms, ctx)?.date();
    let b = tz_parts(ctx.now_ms, ctx)?.date();
    Some((a - b).num_days())
}

fn day_word(ms: i64, ctx: &Ctx, en: bool) -> String {
    match midnight_diff_days(ms, ctx) {
        Some(0) => if en { "today" } else { "heute" }.to_string(),
        Some(1) => if en { "tomorrow" } else { "morgen" }.to_string(),
        Some(2) if !en => "übermorgen".to_string(),
        Some(-1) => if en { "yesterday" } else { "gestern" }.to_string(),
        Some(-2) if !en => "vorgestern".to_string(),
        Some(d) if (3..7).contains(&d) => format_pattern(ms, ctx, "EEEE", en),
        _ => format_pattern(ms, ctx, if en { "MMM d" } else { "dd.MM." }, en),
    }
}

fn hms(ms: i64) -> String {
    let neg = ms < 0;
    let s = ms.abs() / 1000;
    format!("{}{:02}:{:02}:{:02}", if neg { "-" } else { "" }, s / 3600, s / 60 % 60, s % 60)
}

fn human_dur(ms: i64, en: bool) -> String {
    let s = ms.abs() / 1000;
    let (h, m, sec) = (s / 3600, s / 60 % 60, s % 60);
    let mut parts = Vec::new();
    if h > 0 {
        parts.push(format!("{h} {}", if en { "h" } else { "Std" }));
    }
    if m > 0 {
        parts.push(format!("{m} {}", if en { "min" } else { "Min" }));
    }
    if sec > 0 || parts.is_empty() {
        parts.push(format!("{sec} {}", if en { "sec" } else { "Sek" }));
    }
    // Bei Stunden die Sekunden weglassen (lesbarer)
    if h > 0 && parts.len() == 3 {
        parts.pop();
    }
    parts.join(" ")
}

fn human_rel(ms: i64, en: bool) -> String {
    if ms.abs() < 1000 {
        return if en { "now" } else { "jetzt" }.to_string();
    }
    let d = human_dur(ms, en);
    match (ms > 0, en) {
        (true, true) => format!("in {d}"),
        (true, false) => format!("in {d}"),
        (false, true) => format!("{d} ago"),
        (false, false) => format!("vor {d}"),
    }
}

fn trim_num(x: f64) -> String {
    if (x - x.round()).abs() < 1e-9 {
        format!("{}", x.round() as i64)
    } else {
        let s = format!("{x:.3}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn val_text(v: &Val, ctx: &Ctx) -> String {
    match v {
        Val::Text(s) => s.clone(),
        Val::Num(n) => trim_num(*n),
        Val::Dur(d) => hms(*d),
        Val::At(ms) => format_pattern(*ms, ctx, "HH:mm:ss", false),
        Val::Bool(b) => b.to_string(),
        Val::None => String::new(),
    }
}

// ---------------------------------------------------------------------------------------------
// Formate

/// Formatkatalog: (Name, gilt für, Argument, Beschriftung de, Beschriftung en, Beispiel).
pub const FORMATS: &[(&str, &str, &str, &str, &str, &str)] = &[
    // Zeitpunkte
    ("time", "at", "", "Uhrzeit hh:mm:ss", "Clock time hh:mm:ss", "20:15:00"),
    ("short", "at", "", "Uhrzeit hh:mm", "Clock time hh:mm", "20:15"),
    ("date", "at", "", "Datum tt.mm.jjjj", "Date dd.mm.yyyy", "12.11.2026"),
    ("datetime", "at", "", "Datum und Uhrzeit", "Date and time", "12.11.2026 20:15"),
    ("day", "at", "", "heute / morgen / Wochentag / Datum", "today / tomorrow / weekday / date", "morgen"),
    ("daytime", "at", "", "z. B. „heute 20:15“", "e.g. “today 20:15”", "heute 20:15"),
    ("weekday", "at", "", "Wochentag", "Weekday", "Donnerstag"),
    ("tc", "at", "", "Timecode hh:mm:ss:ff", "Timecode hh:mm:ss:ff", "20:15:00:12"),
    ("frames", "at", "", "Bilder seit Mitternacht", "Frames since midnight", "1818750"),
    ("iso", "at", "", "ISO 8601 (Ortszeit)", "ISO 8601 (local)", "2026-11-12T20:15:00+01:00"),
    ("utc", "at", "", "ISO 8601 (UTC)", "ISO 8601 (UTC)", "2026-11-12T19:15:00Z"),
    ("unix", "at", "", "Unix-Sekunden", "Unix seconds", "1794510900"),
    ("unixms", "at", "", "Unix-Millisekunden", "Unix milliseconds", "1794510900000"),
    ("pattern", "at", "Muster", "Eigenes Muster (yyyy MM dd HH mm ss ff EEEE …)", "Custom pattern (yyyy MM dd HH mm ss ff EEEE …)", "HH:mm"),
    // Dauern (und Zeitpunkte als Abstand zum Startmoment: human)
    ("hms", "dur", "", "hh:mm:ss", "hh:mm:ss", "00:05:30"),
    ("hmsf", "dur", "", "hh:mm:ss:ff (Timecode)", "hh:mm:ss:ff (timecode)", "00:05:30:12"),
    ("mmss", "dur", "", "mm:ss (Minuten können über 59 gehen)", "mm:ss (minutes may exceed 59)", "05:30"),
    ("auto", "dur", "", "automatisch: m:ss oder h:mm:ss", "automatic: m:ss or h:mm:ss", "5:30"),
    ("seconds", "dur", "", "Sekunden", "Seconds", "330"),
    ("millis", "dur", "", "Millisekunden", "Milliseconds", "330000"),
    ("minutes", "dur", "", "Minuten", "Minutes", "5.5"),
    ("hours", "dur", "", "Stunden", "Hours", "0.09"),
    ("frames", "dur", "", "Bilder", "Frames", "8250"),
    ("human", "dur,at", "", "Klartext („5 Min 30 Sek“, bei Zeitpunkt „in 5 Min“)", "Plain text (“5 min 30 sec”, for instants “in 5 min”)", "5 Min 30 Sek"),
    // Zahlen
    ("int", "num,dur", "", "ganze Zahl", "Integer", "4"),
    ("fixed", "num,dur", "Stellen", "feste Nachkommastellen", "Fixed decimals", "4.50"),
    ("pad", "num", "Breite", "mit Nullen auffüllen", "Zero-padded", "004"),
    // Text
    ("upper", "text", "", "GROSSBUCHSTABEN", "UPPERCASE", "NEWS"),
    ("lower", "text", "", "kleinbuchstaben", "lowercase", "news"),
    ("trim", "text", "", "Leerzeichen am Rand entfernen", "Trim whitespace", "News"),
    ("max", "text", "Zeichen", "auf n Zeichen kürzen (mit …)", "Truncate to n characters (with …)", "Nachrich…"),
    ("prefix", "all", "Text", "Text davorsetzen (nur wenn Wert vorhanden)", "Prepend text (only if value exists)", "Danach: News"),
    ("suffix", "all", "Text", "Text anhängen (nur wenn Wert vorhanden)", "Append text (only if value exists)", "News Uhr"),
    ("default", "all", "Text", "Ersatz, wenn kein Wert vorhanden", "Fallback if no value", "–"),
    // Typ der Ausgabe (nur wenn der Platzhalter allein im Feld steht)
    ("num", "all", "", "als JSON-Zahl ausgeben (für Zahlenfelder)", "Output as JSON number (for number fields)", "42"),
    ("bool", "all", "", "als Wahr/Falsch ausgeben (Wert vorhanden)", "Output as true/false (value present)", "true"),
    ("en", "all", "", "englische Wochentage/Monate/Klartext", "English weekdays/months/text", ""),
];

fn format_known(name: &str) -> bool {
    FORMATS.iter().any(|f| f.0 == name)
}

#[derive(Debug, Clone)]
struct Out {
    val: Val,
    /// Letztes Format hat einen Zahlentyp bzw. Bool erzwungen (für reine Platzhalter).
    typed: Option<Value>,
    en: bool,
}

fn apply_format(mut out: Out, name: &str, arg: &str, ctx: &Ctx) -> Result<Out, String> {
    let en = out.en;
    // Zahl aus Argument
    let n_arg = || arg.trim().parse::<usize>().map_err(|_| format!("Format „{name}“ braucht eine Zahl als Argument (|{name}:3)"));
    match name {
        "default" => {
            if out.val == Val::None || val_text(&out.val, ctx).is_empty() {
                out.val = Val::Text(arg.to_string());
            }
            return Ok(out);
        }
        "en" => {
            out.en = true;
            return Ok(out);
        }
        "prefix" | "suffix" => {
            if out.val != Val::None {
                let t = val_text(&out.val, ctx);
                if !t.is_empty() {
                    out.val = Val::Text(if name == "prefix" { format!("{arg}{t}") } else { format!("{t}{arg}") });
                }
            }
            return Ok(out);
        }
        "bool" => {
            let present = out.val != Val::None && !val_text(&out.val, ctx).is_empty();
            out.typed = Some(Value::Bool(present));
            out.val = Val::Bool(present);
            return Ok(out);
        }
        _ => {}
    }
    if out.val == Val::None {
        return Ok(out); // fehlender Wert bleibt fehlend (default greift am Ende)
    }
    let bad = |what: &str| Err(format!("Format „{name}“ gilt nicht für {what} — passend: {}", suggest_for(&out.val)));
    out.val = match (&out.val, name) {
        // ---- Zeitpunkt
        (Val::At(ms), "time") => Val::Text(format_pattern(*ms, ctx, "HH:mm:ss", en)),
        (Val::At(ms), "short") => Val::Text(format_pattern(*ms, ctx, "HH:mm", en)),
        (Val::At(ms), "date") => Val::Text(format_pattern(*ms, ctx, if en { "yyyy-MM-dd" } else { "dd.MM.yyyy" }, en)),
        (Val::At(ms), "datetime") => Val::Text(format_pattern(*ms, ctx, if en { "yyyy-MM-dd HH:mm" } else { "dd.MM.yyyy HH:mm" }, en)),
        (Val::At(ms), "day") => Val::Text(day_word(*ms, ctx, en)),
        (Val::At(ms), "daytime") => Val::Text(format!("{} {}", day_word(*ms, ctx, en), format_pattern(*ms, ctx, "HH:mm", en))),
        (Val::At(ms), "weekday") => Val::Text(format_pattern(*ms, ctx, "EEEE", en)),
        (Val::At(ms), "tc") => Val::Text(format_pattern(*ms, ctx, "HH:mm:ss:ff", en)),
        (Val::At(ms), "frames") => {
            let t = tz_parts(*ms, ctx).ok_or("Zeit nicht darstellbar")?;
            let secs = t.hour() as i64 * 3600 + t.minute() as i64 * 60 + t.second() as i64;
            let f = (secs * 1000 + ms.rem_euclid(1000)) * ctx.fps.0 as i64 / (ctx.fps.1.max(1) as i64 * 1000);
            Val::Num(f as f64)
        }
        (Val::At(ms), "iso") => {
            let t = tz_parts(*ms, ctx).ok_or("Zeit nicht darstellbar")?;
            let off = ctx.tz_offset_secs.unwrap_or_else(|| Local.timestamp_millis_opt(*ms).single().map_or(0, |d| d.offset().local_minus_utc()));
            Val::Text(format!("{}{}{:02}:{:02}", t.format("%Y-%m-%dT%H:%M:%S"), if off < 0 { "-" } else { "+" }, off.abs() / 3600, off.abs() / 60 % 60))
        }
        (Val::At(ms), "utc") => Val::Text(omp_playout_core::schedule::format_start_at(*ms).split('.').next().unwrap_or("").to_string() + "Z"),
        (Val::At(ms), "unix") => Val::Num((*ms / 1000) as f64),
        (Val::At(ms), "unixms") => Val::Num(*ms as f64),
        (Val::At(ms), "pattern") => {
            if arg.is_empty() {
                return Err("Format „pattern“ braucht ein Muster (|pattern:HH:mm)".to_string());
            }
            Val::Text(format_pattern(*ms, ctx, arg, en))
        }
        (Val::At(ms), "human") => Val::Text(human_rel(*ms - ctx.now_ms, en)),
        (Val::At(_), _) => return bad("einen Zeitpunkt"),
        // ---- Dauer
        (Val::Dur(d), "hms") => Val::Text(hms(*d)),
        (Val::Dur(d), "hmsf") => {
            let a = d.abs();
            Val::Text(format!("{}:{:0w$}", hms(*d), frames_of(a % 1000, ctx.fps), w = fps_width(ctx.fps)))
        }
        (Val::Dur(d), "mmss") => {
            let s = d.abs() / 1000;
            Val::Text(format!("{}{:02}:{:02}", if *d < 0 { "-" } else { "" }, s / 60, s % 60))
        }
        (Val::Dur(d), "auto") => {
            let s = d.abs() / 1000;
            let sign = if *d < 0 { "-" } else { "" };
            Val::Text(if s >= 3600 { format!("{sign}{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{sign}{}:{:02}", s / 60, s % 60) })
        }
        (Val::Dur(d), "seconds") => Val::Num(*d as f64 / 1000.0),
        (Val::Dur(d), "millis") => Val::Num(*d as f64),
        (Val::Dur(d), "minutes") => Val::Num(*d as f64 / 60_000.0),
        (Val::Dur(d), "hours") => Val::Num(*d as f64 / 3_600_000.0),
        (Val::Dur(d), "frames") => Val::Num((d * ctx.fps.0 as i64 / (ctx.fps.1.max(1) as i64 * 1000)) as f64),
        (Val::Dur(d), "human") => Val::Text(human_dur(*d, en)),
        (Val::Dur(d), "int") => Val::Num((*d as f64 / 1000.0).trunc()),
        (Val::Dur(d), "fixed") => Val::Text(format!("{:.*}", n_arg()?, *d as f64 / 1000.0)),
        (Val::Dur(_), _) => return bad("eine Dauer"),
        // ---- Zahl
        (Val::Num(n), "int") => Val::Num(n.trunc()),
        (Val::Num(n), "fixed") => Val::Text(format!("{:.*}", n_arg()?, n)),
        (Val::Num(n), "pad") => Val::Text(format!("{:0w$}", n.trunc() as i64, w = n_arg()?)),
        (Val::Num(_), "num") => out.val.clone(),
        (Val::Text(s), "num") => Val::Num(s.trim().replace(',', ".").parse::<f64>().map_err(|_| format!("Format „num“: „{s}“ ist keine Zahl"))?),
        (Val::Num(_), "upper" | "lower" | "trim" | "max") => {
            let t = val_text(&out.val, ctx);
            return apply_format(Out { val: Val::Text(t), ..out }, name, arg, ctx);
        }
        (Val::Num(_), _) => return bad("eine Zahl"),
        // ---- Text
        (Val::Text(s), "upper") => Val::Text(s.to_uppercase()),
        (Val::Text(s), "lower") => Val::Text(s.to_lowercase()),
        (Val::Text(s), "trim") => Val::Text(s.trim().to_string()),
        (Val::Text(s), "max") => {
            let n = n_arg()?;
            if s.chars().count() > n {
                Val::Text(format!("{}…", s.chars().take(n.saturating_sub(1)).collect::<String>().trim_end()))
            } else {
                Val::Text(s.clone())
            }
        }
        (Val::Text(s), "int" | "fixed" | "pad") => {
            let x: f64 = s.trim().replace(',', ".").parse().map_err(|_| format!("Format „{name}“: „{s}“ ist keine Zahl"))?;
            return apply_format(Out { val: Val::Num(x), ..out }, name, arg, ctx);
        }
        (Val::Text(_), _) => return bad("einen Text"),
        (Val::Bool(_), _) => return bad("Wahr/Falsch"),
        (Val::None, _) => Val::None,
    };
    if matches!(name, "num" | "int") && let Val::Num(n) = &out.val {
        out.typed = if n.fract() == 0.0 && n.abs() < 9e15 { Some(Value::Number((*n as i64).into())) } else { serde_json::Number::from_f64(*n).map(Value::Number) };
    }
    Ok(out)
}

fn suggest_for(v: &Val) -> String {
    let want = match v {
        Val::At(_) => "at",
        Val::Dur(_) => "dur",
        Val::Num(_) => "num",
        _ => "text",
    };
    FORMATS.iter().filter(|f| f.1.split(',').any(|t| t == want || t == "all")).map(|f| f.0).collect::<Vec<_>>().join(", ")
}

// ---------------------------------------------------------------------------------------------
// Platzhalter in Texten

#[derive(Debug, Clone, PartialEq)]
struct Placeholder {
    reference: RefKind,
    field: String,
    formats: Vec<(String, String)>,
}

/// Findet `{{…}}`-Abschnitte: (Beginn, Ende exklusiv, Inhalt).
fn spans(s: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(a) = s[i..].find("{{") {
        let start = i + a;
        match s[start + 2..].find("}}") {
            Some(b) => {
                let end = start + 2 + b + 2;
                out.push((start, end, s[start + 2..end - 2].trim().to_string()));
                i = end;
            }
            None => break,
        }
    }
    out
}

fn parse_placeholder(inner: &str) -> Result<Placeholder, String> {
    // Formate hinter dem ersten `|` außerhalb von Klammern
    let mut depth = 0i32;
    let mut quoted = false;
    let mut cut = None;
    for (i, ch) in inner.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => depth -= 1,
            '|' if depth == 0 && !quoted => {
                cut = Some(i);
                break;
            }
            _ => {}
        }
    }
    let (head, tail) = match cut {
        Some(i) => (&inner[..i], &inner[i + 1..]),
        None => (inner, ""),
    };
    let head = head.trim();
    // Bezug: bis zum ersten `.`/`:` außerhalb von Klammern
    let mut depth = 0i32;
    let mut quoted = false;
    let mut sep = None;
    for (i, ch) in head.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => depth -= 1,
            '.' | ':' if depth == 0 && !quoted => {
                sep = Some(i);
                break;
            }
            _ => {}
        }
    }
    let Some(sep) = sep else {
        return Err(format!("„{{{{{inner}}}}}“: Bezug und Feld fehlen (Beispiel: {{{{next.title}}}})"));
    };
    let reference = parse_ref(&head[..sep])?;
    let field = head[sep + 1..].trim().to_string();
    if field.is_empty() {
        return Err(format!("„{{{{{inner}}}}}“: Feld fehlt (Beispiel: {{{{next.title}}}})"));
    }
    if !field.starts_with("meta.") && canonical_field(&field).is_none() {
        return Err(format!("Feld „{field}“ unbekannt — erlaubt: {}", FIELDS.iter().map(|f| f.0).collect::<Vec<_>>().join(", ")));
    }
    let mut formats = Vec::new();
    for f in tail.split('|') {
        let f = f.trim_start();
        if f.trim().is_empty() {
            continue;
        }
        // Das Argument bleibt unverändert (Leerzeichen am Ende gehören dazu: `|prefix:Danach: `).
        let (name, arg) = f.split_once(':').map_or((f.trim(), ""), |(n, a)| (n.trim(), a));
        if !format_known(name) {
            return Err(format!("Format „{name}“ unbekannt — erlaubt: {}", FORMATS.iter().map(|f| f.0).collect::<Vec<_>>().join(", ")));
        }
        formats.push((name.to_string(), arg.to_string()));
    }
    Ok(Placeholder { reference, field, formats })
}

fn eval(p: &Placeholder, ctx: &Ctx) -> Result<Out, String> {
    let v = match resolve_ref(&p.reference, ctx) {
        Some(ev) => event_field(ev, ctx, &p.field),
        None => Val::None,
    };
    let mut out = Out { val: v, typed: None, en: false };
    // `en` zuerst anwenden, egal wo es steht
    if p.formats.iter().any(|f| f.0 == "en") {
        out.en = true;
    }
    for (name, arg) in &p.formats {
        out = apply_format(out, name, arg, ctx)?;
    }
    Ok(out)
}

/// Prüft die Schreibweise aller Platzhalter eines Textes (ohne Kontext); Fehler im Klartext.
pub fn validate_text(s: &str) -> Vec<String> {
    let mut errs = Vec::new();
    for (_, _, inner) in spans(s) {
        if let Err(e) = parse_placeholder(&inner) {
            errs.push(e);
        }
    }
    if s.matches("{{").count() != s.matches("}}").count() {
        errs.push("Klammern „{{“ und „}}“ passen nicht zusammen".to_string());
    }
    errs
}

/// Prüft alle Strings eines JSON-Werts; Fehler mit Pfad.
pub fn validate_value(v: &Value, path: &str) -> Vec<String> {
    let mut errs = Vec::new();
    match v {
        Value::String(s) => errs.extend(validate_text(s).into_iter().map(|e| format!("{path}: {e}"))),
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                errs.extend(validate_value(x, &format!("{path}[{i}]")));
            }
        }
        Value::Object(m) => {
            for (k, x) in m {
                errs.extend(validate_value(x, &if path.is_empty() { k.clone() } else { format!("{path}.{k}") }));
            }
        }
        _ => {}
    }
    errs
}

pub fn has_placeholders(v: &Value) -> bool {
    match v {
        Value::String(s) => s.contains("{{"),
        Value::Array(a) => a.iter().any(has_placeholders),
        Value::Object(m) => m.values().any(has_placeholders),
        _ => false,
    }
}

/// Setzt alle Platzhalter eines Textes ein. Fehler (Schreibweise, Format) kommen in `warnings`;
/// der betroffene Platzhalter wird dann leer.
pub fn render_text(s: &str, ctx: &Ctx, warnings: &mut Vec<String>) -> String {
    render_typed(s, ctx, warnings).0
}

/// Wie [`render_text`]; steht der Platzhalter allein im Feld und erzwingt `num`/`int`/`bool` einen Typ,
/// kommt zusätzlich der typisierte JSON-Wert zurück.
fn render_typed(s: &str, ctx: &Ctx, warnings: &mut Vec<String>) -> (String, Option<Value>) {
    let sp = spans(s);
    if sp.is_empty() {
        return (s.to_string(), None);
    }
    let mut out = String::new();
    let mut last = 0;
    let mut typed = None;
    for (a, b, inner) in &sp {
        out.push_str(&s[last..*a]);
        last = *b;
        match parse_placeholder(inner).and_then(|p| eval(&p, ctx)) {
            Ok(o) => {
                out.push_str(&val_text(&o.val, ctx));
                if sp.len() == 1 && *a == 0 && *b == s.len() {
                    typed = o.typed;
                }
            }
            Err(e) => warnings.push(e),
        }
    }
    out.push_str(&s[last..]);
    (out, typed)
}

/// Setzt Platzhalter in allen Strings eines JSON-Werts ein (rekursiv); Rest bleibt unverändert.
pub fn render_value(v: &Value, ctx: &Ctx, warnings: &mut Vec<String>) -> Value {
    match v {
        Value::String(s) if s.contains("{{") => {
            let (text, typed) = render_typed(s, ctx, warnings);
            typed.unwrap_or(Value::String(text))
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| render_value(x, ctx, warnings)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), render_value(x, ctx, warnings))).collect()),
        other => other.clone(),
    }
}

/// Beschreibung für die Oberfläche: Bezüge, Felder, Formate (de/en), alles aus denselben Tabellen
/// wie die Auswertung — die Oberfläche kennt keine eigene Liste.
pub fn catalog() -> Value {
    json!({
        "refs": REFS.iter().map(|r| json!({"key": r.0, "de": r.1, "en": r.2})).chain([
            json!({"key": "prevN", "de": "N-tes Event davor (prev2, prev3, …)", "en": "N-th event before (prev2, prev3, …)", "counted": "prev"}),
            json!({"key": "nextN", "de": "N-tes Event danach (next2, next3, …)", "en": "N-th event after (next2, next3, …)", "counted": "next"}),
            json!({"key": "at", "de": "Event an Position N", "en": "Event at position N", "arg": "number"}),
            json!({"key": "item", "de": "Event mit bestimmter ID", "en": "Event with a given ID", "arg": "text"}),
            json!({"key": "find", "de": "Erstes passendes Event danach (Suche)", "en": "First matching event after (search)", "arg": "query"}),
            json!({"key": "findprev", "de": "Nächstes passendes Event davor (Suche)", "en": "Nearest matching event before (search)", "arg": "query"}),
        ]).collect::<Vec<_>>(),
        "fields": FIELDS.iter().map(|f| json!({"key": f.0, "alias": f.1, "type": f.2, "de": f.3, "en": f.4, "example": f.5})).collect::<Vec<_>>(),
        "formats": FORMATS.iter().map(|f| json!({"key": f.0, "for": f.1, "arg": f.2, "de": f.3, "en": f.4, "example": f.5})).collect::<Vec<_>>(),
        "operators": [
            {"key": "=", "de": "ist gleich", "en": "equals"},
            {"key": "!=", "de": "ist ungleich", "en": "not equal"},
            {"key": "~", "de": "enthält", "en": "contains"},
            {"key": "!~", "de": "enthält nicht", "en": "does not contain"},
            {"key": "^", "de": "beginnt mit", "en": "starts with"},
            {"key": "$", "de": "endet mit", "en": "ends with"},
            {"key": ">", "de": "größer als", "en": "greater than"},
            {"key": ">=", "de": "größer oder gleich", "en": "greater or equal"},
            {"key": "<", "de": "kleiner als", "en": "less than"},
            {"key": "<=", "de": "kleiner oder gleich", "en": "less or equal"},
            {"key": "?", "de": "ist vorhanden", "en": "exists"},
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-11-12 20:00:00 UTC; Zeitzone +1 h → Ortszeit 21:00
    const T0: i64 = 1_794_513_600_000;

    fn ev(i: usize, title: &str, kind: &str, start: Option<i64>, dur: u64) -> EventFacts {
        EventFacts {
            id: format!("item{i}"),
            title: title.to_string(),
            kind: kind.to_string(),
            index: i,
            duration_ms: dur,
            start_ms: start,
            end_ms: start.map(|s| s + dur as i64),
            start_type: "sequence".to_string(),
            file: format!("{title}.mxf"),
            meta: json!({"title": "Asset-Titel", "descriptive": {"artist": "Meier", "genre": "News"}, "technical": {"fps": 25}}),
            ..Default::default()
        }
    }

    /// 1 = Vorspann (läuft seit 60 s), 2 = Nachrichten (owner), 3 = Wetter, 4 = Film
    fn ctx() -> Ctx {
        let events = vec![
            ev(1, "Vorspann", "CLIP", Some(T0 - 60_000), 60_000),
            ev(2, "Nachrichten", "CLIP", Some(T0), 300_000),
            ev(3, "Wetter", "CLIP", Some(T0 + 300_000), 120_000),
            ev(4, "Spielfilm", "CLIP", Some(T0 + 420_000), 5_400_000),
        ];
        Ctx { now_ms: T0 + 10_000, fps: (25, 1), events, owner: Some(1), owner_extra: None, onair: Some(1), tz_offset_secs: Some(3600) }
    }

    fn r(t: &str) -> String {
        let mut w = Vec::new();
        let s = render_text(t, &ctx(), &mut w);
        assert!(w.is_empty(), "{t}: {w:?}");
        s
    }

    #[test]
    fn legacy_next_title_and_the_new_dot_syntax() {
        assert_eq!(r("Gleich: {{next:title}}"), "Gleich: Wetter");
        assert_eq!(r("{{next.title}}|{{prev.title}}|{{current.title}}"), "Wetter|Vorspann|Nachrichten");
        assert_eq!(r("{{next2.title}}"), "Spielfilm");
        assert_eq!(r("{{next3.title}}"), "", "kein drittes Event: leer statt Platzhalter");
        assert_eq!(r("{{prev2.title|default:–}}"), "–");
    }

    #[test]
    fn times_in_many_formats() {
        // Ortszeit = UTC+1 → Start Nachrichten 21:00:00
        assert_eq!(r("{{current.start}}"), "21:00:00");
        assert_eq!(r("{{current.start|short}}"), "21:00");
        assert_eq!(r("{{current.start|date}}"), "12.11.2026");
        assert_eq!(r("{{current.start|datetime}}"), "12.11.2026 21:00");
        assert_eq!(r("{{current.start|day}}"), "heute");
        assert_eq!(r("{{current.start|daytime}}"), "heute 21:00");
        assert_eq!(r("{{current.start|weekday}}"), "Donnerstag");
        assert_eq!(r("{{current.start|weekday|en}}"), "Thursday");
        assert_eq!(r("{{current.start|pattern:HH'h'mm}}"), "21h00");
        assert_eq!(r("{{current.start|iso}}"), "2026-11-12T21:00:00+01:00");
        assert_eq!(r("{{current.start|utc}}"), "2026-11-12T20:00:00Z");
        assert_eq!(r("{{current.start|unix}}"), "1794513600");
        assert_eq!(r("{{current.start|tc}}"), "21:00:00:00");
        assert_eq!(r("{{current.start|frames}}"), (21 * 3600 * 25).to_string());
        assert_eq!(r("{{current.end|short}}"), "21:05");
        assert_eq!(r("{{next.start|human}}"), "in 4 Min 50 Sek");
    }

    #[test]
    fn day_words_follow_the_calendar() {
        let mut c = ctx();
        c.events[2].start_ms = Some(T0 + 24 * 3_600_000);
        let mut w = Vec::new();
        assert_eq!(render_text("{{next.start|daytime}}", &c, &mut w), "morgen 21:00");
        c.events[2].start_ms = Some(T0 + 2 * 24 * 3_600_000);
        assert_eq!(render_text("{{next.start|day}}", &c, &mut w), "übermorgen");
        c.events[2].start_ms = Some(T0 + 4 * 24 * 3_600_000);
        assert_eq!(render_text("{{next.start|day}}", &c, &mut w), "Montag");
        c.events[2].start_ms = Some(T0 + 10 * 24 * 3_600_000);
        assert_eq!(render_text("{{next.start|day}}", &c, &mut w), "22.11.");
        assert!(w.is_empty());
    }

    #[test]
    fn durations_and_countdowns() {
        // jetzt = Start + 10 s
        assert_eq!(r("{{current.duration}}"), "00:05:00");
        assert_eq!(r("{{current.duration|mmss}}"), "05:00");
        assert_eq!(r("{{current.duration|auto}}"), "5:00");
        assert_eq!(r("{{next.duration|human}}"), "2 Min");
        assert_eq!(r("{{current.duration|seconds}}"), "300");
        assert_eq!(r("{{current.duration|millis}}"), "300000");
        assert_eq!(r("{{current.duration|minutes}}"), "5");
        assert_eq!(r("{{current.duration|frames}}"), "7500");
        assert_eq!(r("{{current.duration|hmsf}}"), "00:05:00:00");
        assert_eq!(r("{{current.elapsed|seconds}}"), "10");
        assert_eq!(r("{{current.untilEnd|hms}}"), "00:04:50");
        assert_eq!(r("{{current.remaining|auto}}"), "4:50");
        assert_eq!(r("{{next.untilStart|human}}"), "4 Min 50 Sek");
        assert_eq!(r("{{next.untilStart|seconds|fixed:1}}"), "290.0");
        assert_eq!(r("{{next2.duration|auto}}"), "1:30:00");
        assert_eq!(r("{{prev.untilEnd|human}}"), "10 Sek");
    }

    #[test]
    fn meta_text_and_number_formats() {
        assert_eq!(r("{{current.meta.artist}}"), "Meier");
        assert_eq!(r("{{current.meta.descriptive.genre|upper}}"), "NEWS");
        assert_eq!(r("{{current.meta.title}}"), "Asset-Titel");
        assert_eq!(r("{{current.meta.fps|pad:4}}"), "0025");
        assert_eq!(r("{{current.meta.nichtda|default:unbekannt}}"), "unbekannt");
        assert_eq!(r("{{current.title|max:6}}"), "Nachr…");
        assert_eq!(r("{{next.title|prefix:Danach: |suffix: Uhr}}"), "Danach: Wetter Uhr");
        assert_eq!(r("{{next3.title|prefix:Danach: }}"), "", "Präfix nur bei vorhandenem Wert");
        assert_eq!(r("{{current.index|pad:3}}"), "002");
    }

    #[test]
    fn search_finds_events_by_any_field() {
        assert_eq!(r("{{find(title~wett).start|short}}"), "21:05");
        assert_eq!(r("{{find(type=CLIP & duration>1h).title}}"), "Spielfilm");
        assert_eq!(r("{{find(meta.artist=Meier).title}}"), "Wetter");
        assert_eq!(r("{{find(title^Spiel).title}}"), "Spielfilm");
        assert_eq!(r("{{find(title!~wetter & title!~spiel).title|default:–}}"), "–");
        assert_eq!(r("{{find(duration<=2min & duration>1min).title}}"), "Wetter");
        assert_eq!(r("{{find(start>21:03).title}}"), "Wetter");
        assert_eq!(r("{{findprev(title~vor).title}}"), "Vorspann");
        assert_eq!(r("{{find(meta.artist?).title}}"), "Wetter");
        assert_eq!(r("{{at(4).title}}|{{first.title}}|{{last.title}}|{{item(item3).title}}|{{onair.title}}"), "Spielfilm|Vorspann|Spielfilm|Wetter|Nachrichten");
        // in Anführungszeichen darf & und = stehen
        assert_eq!(r("{{find(title=\"A & B\").title|default:nichts}}"), "nichts");
    }

    #[test]
    fn typed_output_for_number_fields() {
        let mut w = Vec::new();
        let v = render_value(&json!({"n": "{{current.duration|seconds|num}}", "s": "{{current.duration|seconds}}", "t": "Dauer {{current.duration|seconds|num}}", "b": "{{next.title|bool}}", "keep": 5}), &ctx(), &mut w);
        assert_eq!(v["n"], json!(300));
        assert_eq!(v["s"], json!("300"));
        assert_eq!(v["t"], json!("Dauer 300"));
        assert_eq!(v["b"], json!(true));
        assert_eq!(v["keep"], json!(5));
        assert!(w.is_empty());
    }

    #[test]
    fn cart_without_a_playlist_position_still_resolves_current() {
        let mut c = ctx();
        c.owner = None;
        c.owner_extra = Some(ev(0, "Jingle", "CLIP", None, 5_000));
        let mut w = Vec::new();
        assert_eq!(render_text("{{current.title}}|{{next.title|default:-}}|{{current.start|default:offen}}", &c, &mut w), "Jingle|-|offen");
    }

    #[test]
    fn mistakes_are_reported_in_plain_language() {
        for (t, needle) in [
            ("{{next}}", "Bezug und Feld"),
            ("{{next.titel}}", "Feld „titel“ unbekannt"),
            ("{{nxt.title}}", "Bezug „nxt“ unbekannt"),
            ("{{next.title|grossbuchstaben}}", "Format „grossbuchstaben“ unbekannt"),
            ("{{find(title).title}}", "Operator fehlt"),
            ("{{find(farbe=rot).title}}", "Feld „farbe“ unbekannt"),
            ("{{next.title", "passen nicht zusammen"),
        ] {
            let errs = validate_text(t);
            assert!(errs.iter().any(|e| e.contains(needle)), "{t}: {errs:?}");
        }
        assert!(validate_text("{{next:title}} {{current.start|pattern:HH:mm}}").is_empty());
        // falsche Format-Art zur Laufzeit
        let mut w = Vec::new();
        assert_eq!(render_text("a{{current.title|hms}}b", &ctx(), &mut w), "ab");
        assert!(w[0].contains("gilt nicht für einen Text"), "{w:?}");
        let errs = validate_value(&json!({"a": [{"b": "{{x.y}}"}]}), "data");
        assert!(errs[0].starts_with("data.a[0].b:"), "{errs:?}");
    }

    #[test]
    fn duration_input_accepts_common_spellings() {
        for (s, ms) in [("90", 90_000), ("90s", 90_000), ("1:30", 90_000), ("01:02:03", 3_723_000), ("1h30m", 5_400_000), ("500ms", 500), ("1,5s", 1_500), ("2min", 120_000), ("-5s", -5_000)] {
            assert_eq!(parse_duration(s), Some(ms), "{s}");
        }
        assert_eq!(parse_duration("abc"), None);
    }

    #[test]
    fn catalog_lists_every_format_and_field() {
        let c = catalog();
        assert!(c["formats"].as_array().unwrap().len() >= 30);
        for f in FORMATS {
            // jede Formatzeile ist auswertbar benannt
            assert!(format_known(f.0));
        }
        assert!(c["fields"].as_array().unwrap().iter().any(|f| f["key"] == "untilEnd"));
    }

    #[test]
    fn meta_keys_lists_sections() {
        let keys = meta_keys(&ctx().events);
        assert!(keys.contains(&"descriptive.artist".to_string()) && keys.contains(&"technical.fps".to_string()) && keys.contains(&"title".to_string()));
    }
}
