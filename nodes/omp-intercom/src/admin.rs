//! Konfigurationskern des Intercom-Dienstes (UMSETZUNG.md Kapitel 48): Kanäle, Teilnehmer, Vorlagen, Gäste — Modell,
//! Prüfung (alle Probleme auf einmal), Token, Layout-Auflösung und das Dokument, das der Hub ([`crate::hub`]) erwartet.
//! Vorher lag das als Orchestrator-Modul (`internal/modules/intercom`); jetzt gehört es dem Dienst selbst.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Kanal-IDs ab `CALL_BASE` (hub) belegt der Node für Rufe; Gäste bekommen Teilnehmer-IDs ab `GUEST_BASE`.
pub const MAX_CHANNEL_ID: u32 = 999_999;
pub const GUEST_BASE: u32 = 100_000;
const MAX_PAGES: usize = 8;
const MAX_KEYS_PER_PAGE: usize = 48;

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}
fn is_zero_f64(v: &f64) -> bool {
    *v == 0.0
}
fn is_false(v: &bool) -> bool {
    !*v
}

/// Ein Teilnehmer ↔ Kanal (Sprechen/Hören erlaubt, Startpegel und -lage).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Route {
    pub ch: u32,
    #[serde(default)]
    pub talk: bool,
    #[serde(default)]
    pub listen: bool,
    #[serde(default, skip_serializing_if = "is_zero_f64")]
    pub level: f64,
    #[serde(default, skip_serializing_if = "is_zero_f64")]
    pub pan: f64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub vox: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Channel {
    pub id: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub color: String,
    /// "party" (Partyline) oder "ifb" (Programm + Unterbrechung).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// Dämpfung der Programmquellen, solange jemand in den Kanal spricht (IFB).
    #[serde(default, skip_serializing_if = "is_zero_f64")]
    pub duck_db: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Vox {
    pub threshold_db: f64,
    pub hold_ms: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Key {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub ch: u32,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub party: u32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub style: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Page {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub keys: Vec<Key>,
}

/// Ordnet die Tasten eines Panels auf Seiten. Fehlt es, zeigt das Panel alle zugeteilten Kanäle der Reihe nach.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Layout {
    #[serde(default)]
    pub pages: Vec<Page>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Template {
    pub id: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub layout: Layout,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Party {
    pub id: u32,
    #[serde(default)]
    pub name: String,
    /// "human" (Panel), "seat" (Rollenplatz), "program" (Programmquelle), "port" (Hardware-/MXL-Anbindung).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub priority: u32,
    /// Darf andere zwangs-stumm schalten und Alle-Ruf auslösen.
    #[serde(default, skip_serializing_if = "is_false")]
    pub force: bool,
    /// Mikrofon gesperrt, solange On Air gemeldet wird.
    #[serde(default, skip_serializing_if = "is_false")]
    pub onair_lock: bool,
    /// Wer dieses Panel öffnen darf; `open`: jede Person mit Recht „intercom.use“ (Rollenplatz zum Anmelden).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub users: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub open: bool,
    #[serde(default)]
    pub routes: Vec<Route>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vox: Option<Vox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_gain: Option<f64>,
    /// Programmeingang bzw. Mix-Ausgang des Nodes (1-basiert, 0 = keiner), für Arten „program“ und „port“.
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub mxl_in: u32,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub mxl_out: u32,
    /// Eigenes Panel-Layout; `template`: ID einer Vorlage (gilt, wenn kein eigenes Layout gesetzt ist).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<Layout>,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub template: u32,
    /// Wird nur serverseitig vergeben und nie über die Konfigurations-API ausgeliefert.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token: String,
}

/// Befristeter Zugang per Link (Telefon/Browser ohne Konto).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Guest {
    pub id: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token: String,
    /// Ablauf in Unix-Sekunden; im JSON als RFC 3339 (wie die Oberfläche es kennt), beim Einlesen auch Zahlen.
    #[serde(with = "rfc3339")]
    pub expires: i64,
    #[serde(default)]
    pub routes: Vec<Route>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub created_by: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub channels: Vec<Channel>,
    #[serde(default)]
    pub parties: Vec<Party>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub templates: Vec<Template>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guests: Vec<Guest>,
}

// ---------- Zeit: RFC 3339 ohne Zusatz-Abhängigkeit ----------

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Unix-Sekunden → `2026-10-22T12:00:00Z`.
pub fn format_rfc3339(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// `2026-10-22T12:00:00[.123]Z` / `…+02:00` → Unix-Sekunden.
pub fn parse_rfc3339(s: &str) -> Option<i64> {
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
    if b.get(i) == Some(&b'.') {
        i += 1;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
    }
    let offset = match b.get(i)? {
        b'Z' | b'z' if i + 1 == b.len() => 0,
        sign @ (b'+' | b'-') if i + 6 == b.len() && b[i + 3] == b':' => {
            let oh = num(i + 1, i + 3)?;
            let om = num(i + 4, i + 6)?;
            let o = oh * 3600 + om * 60;
            if *sign == b'+' { o } else { -o }
        }
        _ => return None,
    };
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se - offset)
}

mod rfc3339 {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    use serde_json::Value;

    pub fn serialize<S: Serializer>(v: &i64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&super::format_rfc3339(*v))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
        match Value::deserialize(d)? {
            Value::Number(n) => n.as_i64().ok_or_else(|| D::Error::custom("expires: keine ganze Zahl")),
            Value::String(s) => super::parse_rfc3339(&s).ok_or_else(|| D::Error::custom(format!("expires: {s:?} ist kein RFC-3339-Zeitpunkt"))),
            _ => Err(D::Error::custom("expires fehlt")),
        }
    }
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 48 Hex-Zeichen aus dem Betriebssystem-Zufall.
pub fn new_token() -> String {
    let mut b = [0u8; 24];
    getrandom::fill(&mut b).expect("OS-Zufallszahlen nicht verfügbar");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------- Prüfung ----------

fn valid_routes(owner: &str, routes: &[Route], channels: &BTreeSet<u32>, p: &mut Vec<String>) {
    let mut seen = BTreeSet::new();
    for r in routes {
        if !channels.contains(&r.ch) {
            p.push(format!("{owner}: Route auf unbekannten Kanal {}", r.ch));
        }
        if !seen.insert(r.ch) {
            p.push(format!("{owner}: Kanal {} doppelt", r.ch));
        }
        if !(-1.0..=1.0).contains(&r.pan) {
            p.push(format!("{owner}: Lage bei Kanal {} außerhalb −1…1", r.ch));
        }
        if !(0.0..=2.0).contains(&r.level) {
            p.push(format!("{owner}: Pegel bei Kanal {} außerhalb 0…2", r.ch));
        }
    }
}

fn valid_layout(owner: &str, l: &Layout, channels: &BTreeSet<u32>, parties: &BTreeSet<u32>, p: &mut Vec<String>) {
    if l.pages.is_empty() {
        p.push(format!("{owner}: Layout ohne Seite"));
    }
    if l.pages.len() > MAX_PAGES {
        p.push(format!("{owner}: mehr als {MAX_PAGES} Seiten"));
    }
    for (i, pg) in l.pages.iter().enumerate() {
        if pg.keys.len() > MAX_KEYS_PER_PAGE {
            p.push(format!("{owner}: Seite {} hat mehr als {MAX_KEYS_PER_PAGE} Tasten", i + 1));
        }
        if pg.name.len() > 40 {
            p.push(format!("{owner}: Seitenname {} zu lang", i + 1));
        }
        for (j, k) in pg.keys.iter().enumerate() {
            let at = format!("{owner}, Seite {}, Taste {}", i + 1, j + 1);
            if k.label.len() > 40 {
                p.push(format!("{at}: Beschriftung zu lang"));
            }
            match k.kind.as_str() {
                "channel" => {
                    if !channels.contains(&k.ch) {
                        p.push(format!("{at}: unbekannter Kanal {}", k.ch));
                    }
                    if !matches!(k.style.as_str(), "" | "strip" | "key") {
                        p.push(format!("{at}: Stil {:?} unbekannt", k.style));
                    }
                }
                "call" => {
                    if !parties.contains(&k.party) {
                        p.push(format!("{at}: unbekannter Teilnehmer {}", k.party));
                    }
                }
                "all" | "reply" | "mute" | "dnd" => {}
                other => p.push(format!("{at}: Tastenart {other:?} unbekannt")),
            }
        }
    }
}

impl Config {
    /// Prüft die gesamte Konfiguration; alle Probleme auf einmal.
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut p: Vec<String> = Vec::new();
        let mut channels = BTreeSet::new();
        let mut names = BTreeSet::new();
        for ch in &self.channels {
            if ch.id == 0 || ch.id > MAX_CHANNEL_ID {
                p.push(format!("Kanal {:?}: ID {} ungültig (1…{MAX_CHANNEL_ID})", ch.name, ch.id));
            } else if channels.contains(&ch.id) {
                p.push(format!("Kanal-ID {} doppelt", ch.id));
            }
            if ch.name.trim().is_empty() {
                p.push(format!("Kanal {} ohne Namen", ch.id));
            }
            if !names.insert(ch.name.to_lowercase()) {
                p.push(format!("Kanalname {:?} doppelt", ch.name));
            }
            if !matches!(ch.kind.as_str(), "" | "party" | "ifb") {
                p.push(format!("Kanal {:?}: Art {:?} unbekannt", ch.name, ch.kind));
            }
            if !(0.0..=60.0).contains(&ch.duck_db) {
                p.push(format!("Kanal {:?}: Dämpfung außerhalb 0…60 dB", ch.name));
            }
            channels.insert(ch.id);
        }
        let mut ids = BTreeSet::new();
        let mut pnames = BTreeSet::new();
        let (mut used_in, mut used_out): (BTreeMap<u32, &str>, BTreeMap<u32, &str>) = (BTreeMap::new(), BTreeMap::new());
        for pt in &self.parties {
            if pt.id == 0 || pt.id >= GUEST_BASE {
                p.push(format!("Teilnehmer {:?}: ID {} ungültig (1…{})", pt.name, pt.id, GUEST_BASE - 1));
            }
            if !ids.insert(pt.id) {
                p.push(format!("Teilnehmer-ID {} doppelt", pt.id));
            }
            if pt.name.trim().is_empty() {
                p.push(format!("Teilnehmer {} ohne Namen", pt.id));
            }
            if !pnames.insert(pt.name.to_lowercase()) {
                p.push(format!("Teilnehmername {:?} doppelt", pt.name));
            }
            if !matches!(pt.kind.as_str(), "" | "human" | "seat" | "program" | "port") {
                p.push(format!("Teilnehmer {:?}: Art {:?} unbekannt", pt.name, pt.kind));
            }
            if pt.priority > 9 {
                p.push(format!("Teilnehmer {:?}: Priorität außerhalb 0…9", pt.name));
            }
            if let Some(v) = &pt.vox {
                if v.threshold_db > 0.0 || v.threshold_db < -80.0 || v.hold_ms < 0 || v.hold_ms > 5000 {
                    p.push(format!("Teilnehmer {:?}: Sprachaktivierung außerhalb des Bereichs", pt.name));
                }
            }
            valid_routes(&format!("Teilnehmer {:?}", pt.name), &pt.routes, &channels, &mut p);
            if pt.mxl_in > 16 || pt.mxl_out > 16 {
                p.push(format!("Teilnehmer {:?}: MXL-Anschluss außerhalb 0…16", pt.name));
            }
            if (pt.mxl_in > 0 || pt.mxl_out > 0) && pt.kind != "program" && pt.kind != "port" {
                p.push(format!("Teilnehmer {:?}: MXL-Anschluss nur bei Art „Programmquelle“ oder „Anbindung“", pt.name));
            }
            for (n, used, what) in [(pt.mxl_in, &mut used_in, "Programmeingang"), (pt.mxl_out, &mut used_out, "Mix-Ausgang")] {
                if n == 0 {
                    continue;
                }
                if let Some(other) = used.get(&n) {
                    p.push(format!("{what} {n} doppelt belegt ({other:?} und {:?})", pt.name));
                }
                used.insert(n, pt.name.as_str());
            }
        }
        let mut tmpl = BTreeSet::new();
        for t in &self.templates {
            if t.id == 0 || !tmpl.insert(t.id) {
                p.push(format!("Vorlage {:?}: ID {} ungültig oder doppelt", t.name, t.id));
            }
            if t.name.trim().is_empty() {
                p.push(format!("Vorlage {} ohne Namen", t.id));
            }
            valid_layout(&format!("Vorlage {:?}", t.name), &t.layout, &channels, &ids, &mut p);
        }
        for pt in &self.parties {
            if pt.template != 0 && !tmpl.contains(&pt.template) {
                p.push(format!("Teilnehmer {:?}: unbekannte Vorlage {}", pt.name, pt.template));
            }
            if let Some(l) = &pt.layout {
                valid_layout(&format!("Teilnehmer {:?}", pt.name), l, &channels, &ids, &mut p);
            }
        }
        for g in &self.guests {
            if g.id < GUEST_BASE {
                p.push(format!("Gast {:?}: ID {} ungültig", g.name, g.id));
            }
            valid_routes(&format!("Gast {:?}", g.name), &g.routes, &channels, &mut p);
        }
        if p.is_empty() { Ok(()) } else { Err(p) }
    }

    /// Übernimmt die Token der bisherigen Konfiguration (gleiche ID) und vergibt neue für neue Teilnehmer. Clients dürfen
    /// Token nie setzen; Gäste kommen nur über die Gast-Endpunkte (bestehende bleiben unverändert).
    pub fn with_tokens(mut self, old: &Config) -> Config {
        let tokens: BTreeMap<u32, &str> = old.parties.iter().map(|p| (p.id, p.token.as_str())).collect();
        for p in &mut self.parties {
            p.token = match tokens.get(&p.id) {
                Some(t) if !t.is_empty() => (*t).to_string(),
                _ => new_token(),
            };
        }
        self.guests = old.guests.clone();
        self
    }

    /// Ohne Token (für die Auslieferung an die Oberfläche).
    pub fn redacted(&self) -> Config {
        let mut out = self.clone();
        for p in &mut out.parties {
            p.token.clear();
        }
        for g in &mut out.guests {
            g.token.clear();
        }
        out
    }

    pub fn active_guests(&self, now: i64) -> Vec<&Guest> {
        self.guests.iter().filter(|g| g.expires > now).collect()
    }

    /// Das eigene Layout des Teilnehmers, sonst das seiner Vorlage, sonst `None` (Standardansicht).
    pub fn effective_layout<'a>(&'a self, p: &'a Party) -> Option<&'a Layout> {
        if let Some(l) = &p.layout {
            if !l.pages.is_empty() {
                return Some(l);
            }
        }
        self.templates.iter().find(|t| t.id == p.template && !t.layout.pages.is_empty()).map(|t| &t.layout)
    }

    /// Die Teilnehmer, deren Panel die Person öffnen darf.
    pub fn parties_for(&self, user: &str, groups: &[String]) -> Vec<&Party> {
        self.parties
            .iter()
            .filter(|p| p.kind != "program" && p.kind != "port")
            .filter(|p| p.open || p.users.iter().any(|u| u.eq_ignore_ascii_case(user)) || p.groups.iter().any(|g| groups.contains(g)))
            .collect()
    }

    /// Alle Teilnehmer, die ein Panel haben können (Bootstrap-Modus ohne Personen).
    pub fn panel_parties(&self) -> Vec<&Party> {
        self.parties.iter().filter(|p| p.kind != "program" && p.kind != "port").collect()
    }

    /// Das Dokument, das `Core::apply_config` erwartet (aktive Gäste als Teilnehmer, Layouts aufgelöst).
    pub fn node_config(&self, now: i64) -> Value {
        let route = |r: &Route| {
            let mut m = json!({"ch": r.ch, "talk": r.talk, "listen": r.listen});
            if r.level > 0.0 {
                m["level"] = json!(r.level);
            }
            if r.pan != 0.0 {
                m["pan"] = json!(r.pan);
            }
            if r.vox {
                m["vox"] = json!(true);
            }
            m
        };
        let channels: Vec<Value> = self
            .channels
            .iter()
            .map(|c| {
                let kind = if c.kind.is_empty() { "party" } else { c.kind.as_str() };
                json!({"id": c.id, "name": c.name, "color": c.color, "kind": kind, "duck_db": c.duck_db})
            })
            .collect();
        let mut parties: Vec<Value> = self
            .parties
            .iter()
            .map(|p| {
                let kind = if p.kind.is_empty() || p.kind == "seat" { "human" } else { p.kind.as_str() };
                let mut m = json!({"id": p.id, "name": p.name, "kind": kind, "token": p.token, "priority": p.priority,
                    "force": p.force, "onair_lock": p.onair_lock, "routes": p.routes.iter().map(route).collect::<Vec<_>>()});
                if let Some(v) = &p.vox {
                    m["vox"] = json!({"threshold_db": v.threshold_db, "hold_ms": v.hold_ms});
                }
                if let Some(g) = p.mic_gain {
                    m["mic_gain"] = json!(g);
                }
                if let Some(l) = self.effective_layout(p) {
                    m["layout"] = serde_json::to_value(l).unwrap_or(Value::Null);
                }
                if p.mxl_in > 0 {
                    m["mxl_in"] = json!(p.mxl_in);
                }
                if p.mxl_out > 0 {
                    m["mxl_out"] = json!(p.mxl_out);
                }
                m
            })
            .collect();
        for g in self.active_guests(now) {
            parties.push(json!({"id": g.id, "name": g.name, "kind": "human", "token": g.token,
                "routes": g.routes.iter().map(route).collect::<Vec<_>>()}));
        }
        json!({"channels": channels, "parties": parties})
    }
}

// ---------- Dienst: Datei, Änderungen, Gäste ----------

/// Fehler einer Änderung: Prüfung (alle Probleme), nicht gefunden, interner Fehler.
#[derive(Debug, PartialEq)]
pub enum AdminError {
    Invalid(Vec<String>),
    NotFound,
    Internal(String),
}

/// Hinweis fürs Audit-Log des Orchestrators (geht als Antwort-Header zurück; das Gateway schreibt den Eintrag).
#[derive(Debug, Clone, PartialEq)]
pub struct AuditNote {
    pub id: String,
    pub action: &'static str,
    pub details: Value,
}

/// Die Konfiguration samt Datei. Reine Daten und Dateizugriff; das Anwenden auf den Hub macht der Aufrufer
/// (damit die Sperre des Hubs nie unter der Sperre dieser Struktur gehalten wird).
pub struct Admin {
    pub cfg: Config,
    path: Option<PathBuf>,
}

impl Admin {
    /// Lädt die Datei (fehlt sie oder ist sie leer: leere Konfiguration). Eine unlesbare Datei ist ein Fehler — sie wird
    /// nie stillschweigend durch eine leere ersetzt.
    pub fn open(path: Option<PathBuf>) -> Result<Self, String> {
        let cfg = match &path {
            Some(p) => match std::fs::read(p) {
                Ok(raw) if raw.iter().all(u8::is_ascii_whitespace) => Config::default(),
                Ok(raw) => serde_json::from_slice(&raw).map_err(|e| format!("{}: {e}", p.display()))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config::default(),
                Err(e) => return Err(format!("{}: {e}", p.display())),
            },
            None => Config::default(),
        };
        Ok(Self { cfg, path })
    }

    pub fn is_empty(&self) -> bool {
        self.cfg.channels.is_empty() && self.cfg.parties.is_empty() && self.cfg.templates.is_empty() && self.cfg.guests.is_empty()
    }

    fn save(&self) -> Result<(), AdminError> {
        let Some(path) = &self.path else { return Ok(()) };
        write_atomic(path, &serde_json::to_vec_pretty(&self.cfg).map_err(|e| AdminError::Internal(e.to_string()))?)
            .map_err(|e| AdminError::Internal(format!("{}: {e}", path.display())))
    }

    /// Ersetzt Kanäle, Teilnehmer und Vorlagen (Token und Gäste bleiben beim Dienst).
    pub fn update(&mut self, actor: &str, input: Config) -> Result<AuditNote, AdminError> {
        input.validate().map_err(AdminError::Invalid)?;
        let next = input.with_tokens(&self.cfg);
        let prev = std::mem::replace(&mut self.cfg, next);
        if let Err(e) = self.save() {
            self.cfg = prev;
            return Err(e);
        }
        Ok(AuditNote {
            id: "config".into(),
            action: "update",
            details: json!({"actor": actor, "channels": self.cfg.channels.len(), "parties": self.cfg.parties.len()}),
        })
    }

    /// Einmaliger Import einer vollständigen Konfiguration (mit Token und Gästen) — nur in eine leere.
    pub fn import(&mut self, input: Config) -> Result<AuditNote, AdminError> {
        if !self.is_empty() {
            return Err(AdminError::Invalid(vec!["Konfiguration ist nicht leer — Import abgelehnt".into()]));
        }
        input.validate().map_err(AdminError::Invalid)?;
        let mut next = input;
        for p in &mut next.parties {
            if p.token.is_empty() {
                p.token = new_token();
            }
        }
        self.cfg = next;
        if let Err(e) = self.save() {
            self.cfg = Config::default();
            return Err(e);
        }
        Ok(AuditNote { id: "config".into(), action: "import", details: json!({"channels": self.cfg.channels.len(), "parties": self.cfg.parties.len()}) })
    }

    /// Neuer Zugangstoken für einen Teilnehmer (alter Link wird ungültig, offene Sitzung bleibt bis zum Abbruch).
    pub fn rotate_token(&mut self, party: u32) -> Result<AuditNote, AdminError> {
        let p = self.cfg.parties.iter_mut().find(|p| p.id == party).ok_or(AdminError::NotFound)?;
        let old = std::mem::replace(&mut p.token, new_token());
        if let Err(e) = self.save() {
            if let Some(p) = self.cfg.parties.iter_mut().find(|p| p.id == party) {
                p.token = old;
            }
            return Err(e);
        }
        Ok(AuditNote { id: party.to_string(), action: "rotate-token", details: Value::Null })
    }

    pub fn create_guest(&mut self, actor: &str, name: &str, routes: Vec<Route>, ttl_minutes: i64, now: i64) -> Result<(Guest, AuditNote), AdminError> {
        if name.trim().is_empty() {
            return Err(AdminError::Invalid(vec!["Gast ohne Namen".into()]));
        }
        if !(1..=7 * 24 * 60).contains(&ttl_minutes) {
            return Err(AdminError::Invalid(vec!["Gültigkeit muss zwischen 1 Minute und 7 Tagen liegen".into()]));
        }
        let mut next_id = GUEST_BASE;
        for g in &self.cfg.guests {
            next_id = next_id.max(g.id + 1);
        }
        let g = Guest { id: next_id, name: name.to_string(), token: new_token(), expires: now + ttl_minutes * 60, routes, created_by: actor.to_string() };
        let mut cand = self.cfg.clone();
        cand.guests.retain(|x| x.expires > now);
        cand.guests.push(g.clone());
        cand.validate().map_err(AdminError::Invalid)?;
        let prev = std::mem::replace(&mut self.cfg, cand);
        if let Err(e) = self.save() {
            self.cfg = prev;
            return Err(e);
        }
        let note = AuditNote { id: g.id.to_string(), action: "guest-create", details: json!({"name": name, "expires": format_rfc3339(g.expires)}) };
        Ok((g, note))
    }

    pub fn delete_guest(&mut self, id: u32) -> Result<AuditNote, AdminError> {
        if !self.cfg.guests.iter().any(|g| g.id == id) {
            return Err(AdminError::NotFound);
        }
        let prev = self.cfg.clone();
        self.cfg.guests.retain(|g| g.id != id);
        if let Err(e) = self.save() {
            self.cfg = prev;
            return Err(e);
        }
        Ok(AuditNote { id: id.to_string(), action: "guest-delete", details: Value::Null })
    }

    /// Entfernt abgelaufene Gäste; `true`, wenn sich etwas geändert hat.
    pub fn prune_guests(&mut self, now: i64) -> bool {
        let before = self.cfg.guests.len();
        self.cfg.guests.retain(|g| g.expires > now);
        let changed = self.cfg.guests.len() != before;
        if changed {
            let _ = self.save();
        }
        changed
    }
}

/// Schreibt erst in eine Nachbardatei und benennt dann um: nie eine halbe Datei.
pub fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir)?;
        }
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Config {
        serde_json::from_value(json!({
            "channels": [{"id": 1, "name": "Regie", "color": "#19d3f3"}, {"id": 2, "name": "IFB", "kind": "ifb", "duck_db": 12.0}],
            "parties": [
                {"id": 1, "name": "Regie 1", "kind": "human", "force": true, "users": ["anna"], "routes": [{"ch": 1, "talk": true, "listen": true}]},
                {"id": 2, "name": "Kamera 1", "kind": "seat", "open": true, "routes": [{"ch": 1, "talk": true, "listen": true, "pan": -0.5, "level": 0.8}]},
                {"id": 3, "name": "Programm", "kind": "program", "mxl_in": 1, "routes": [{"ch": 2, "talk": true, "listen": false}]}
            ]
        }))
        .unwrap()
    }

    fn problems(c: &Config) -> Vec<String> {
        c.validate().err().unwrap_or_default()
    }

    #[test]
    fn rfc3339_round_trip_and_offsets() {
        let t = 1_792_670_400; // 2026-10-22T12:00:00Z
        assert_eq!(format_rfc3339(t), "2026-10-22T12:00:00Z");
        assert_eq!(parse_rfc3339("2026-10-22T12:00:00Z"), Some(t));
        assert_eq!(parse_rfc3339("2026-10-22T14:00:00+02:00"), Some(t));
        assert_eq!(parse_rfc3339("2026-10-22T12:00:00.123456789Z"), Some(t));
        assert_eq!(parse_rfc3339("2026-10-22T07:00:00-05:00"), Some(t));
        assert_eq!(parse_rfc3339("morgen"), None);
        assert_eq!(parse_rfc3339("2026-13-01T00:00:00Z"), None);
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn validate_accepts_sample_and_collects_all_problems() {
        assert!(sample().validate().is_ok());
        let mut bad = sample();
        bad.channels.push(Channel { id: 1, name: "regie".into(), ..Default::default() });
        bad.parties[0].routes.push(Route { ch: 9, talk: true, ..Default::default() });
        bad.parties[1].priority = 12;
        bad.parties[1].name = "  ".into();
        let p = problems(&bad);
        assert!(p.iter().any(|x| x.contains("Kanal-ID 1 doppelt")), "{p:?}");
        assert!(p.iter().any(|x| x.contains("Kanalname")), "{p:?}");
        assert!(p.iter().any(|x| x.contains("unbekannten Kanal 9")), "{p:?}");
        assert!(p.iter().any(|x| x.contains("Priorität")), "{p:?}");
        assert!(p.iter().any(|x| x.contains("Teilnehmer 2 ohne Namen")), "{p:?}");
        assert!(p.len() >= 5);
    }

    #[test]
    fn route_ranges_and_vox_are_checked() {
        let mut c = sample();
        c.parties[0].routes[0].pan = 1.5;
        c.parties[0].routes[0].level = 3.0;
        c.parties[0].vox = Some(Vox { threshold_db: 5.0, hold_ms: 100 });
        let p = problems(&c);
        assert!(p.iter().any(|x| x.contains("Lage")) && p.iter().any(|x| x.contains("Pegel")) && p.iter().any(|x| x.contains("Sprachaktivierung")), "{p:?}");
    }

    #[test]
    fn mxl_ports_validated() {
        let mut c = sample();
        c.parties.push(Party { id: 4, name: "Zweite".into(), kind: "program".into(), mxl_in: 1, ..Default::default() });
        assert!(problems(&c).iter().any(|x| x.contains("Programmeingang 1 doppelt")));
        let mut c = sample();
        c.parties[0].mxl_out = 2;
        assert!(problems(&c).iter().any(|x| x.contains("MXL-Anschluss nur bei Art")));
        let mut c = sample();
        c.parties[2].mxl_out = 17;
        assert!(problems(&c).iter().any(|x| x.contains("außerhalb 0…16")));
    }

    #[test]
    fn layout_validation_templates_and_effective_layout() {
        let mut c = sample();
        c.templates.push(Template {
            id: 1,
            name: "Kamera".into(),
            layout: Layout { pages: vec![Page { name: "1".into(), keys: vec![Key { kind: "channel".into(), ch: 1, style: "key".into(), ..Default::default() }, Key { kind: "mute".into(), ..Default::default() }] }] },
        });
        c.parties[1].template = 1;
        assert!(c.validate().is_ok());
        assert!(c.effective_layout(&c.parties[1]).is_some());
        assert!(c.effective_layout(&c.parties[0]).is_none());
        c.parties[1].layout = Some(Layout { pages: vec![Page { name: "own".into(), keys: vec![Key { kind: "call".into(), party: 1, ..Default::default() }] }] });
        assert_eq!(c.effective_layout(&c.parties[1]).unwrap().pages[0].name, "own");
        let mut bad = c.clone();
        bad.templates[0].layout.pages[0].keys.push(Key { kind: "channel".into(), ch: 77, ..Default::default() });
        bad.templates[0].layout.pages[0].keys.push(Key { kind: "wild".into(), ..Default::default() });
        bad.parties[0].template = 5;
        let p = problems(&bad);
        assert!(p.iter().any(|x| x.contains("unbekannter Kanal 77")) && p.iter().any(|x| x.contains("Tastenart")) && p.iter().any(|x| x.contains("unbekannte Vorlage 5")), "{p:?}");
        let mut empty = c.clone();
        empty.templates[0].layout.pages.clear();
        assert!(problems(&empty).iter().any(|x| x.contains("Layout ohne Seite")));
    }

    #[test]
    fn tokens_are_stable_and_never_taken_from_clients() {
        let first = sample().with_tokens(&Config::default());
        assert!(first.parties.iter().all(|p| p.token.len() == 48));
        let mut again = sample();
        again.parties[0].token = "vom-client".into();
        let next = again.with_tokens(&first);
        assert_eq!(next.parties[0].token, first.parties[0].token);
        assert!(first.redacted().parties.iter().all(|p| p.token.is_empty()));
        let mut grown = sample();
        grown.parties.push(Party { id: 9, name: "Neu".into(), ..Default::default() });
        let grown = grown.with_tokens(&first);
        assert_ne!(grown.parties[3].token, "");
        assert_ne!(grown.parties[3].token, first.parties[0].token);
    }

    #[test]
    fn redacted_keeps_templates() {
        let mut c = sample();
        c.templates.push(Template { id: 1, name: "V".into(), layout: Layout { pages: vec![Page::default()] } });
        assert_eq!(c.redacted().templates.len(), 1);
    }

    #[test]
    fn node_config_maps_kinds_guests_and_expiry() {
        let mut c = sample().with_tokens(&Config::default());
        let now = 1000;
        c.guests = vec![
            Guest { id: GUEST_BASE, name: "Gast".into(), token: "g1".into(), expires: now + 60, routes: vec![Route { ch: 1, talk: true, listen: true, ..Default::default() }], created_by: "x".into() },
            Guest { id: GUEST_BASE + 1, name: "Alt".into(), token: "g2".into(), expires: now - 1, ..Default::default() },
        ];
        let doc = c.node_config(now);
        let parties = doc["parties"].as_array().unwrap();
        assert_eq!(parties.len(), 4, "drei Teilnehmer + ein aktiver Gast");
        assert_eq!(parties[1]["kind"], "human", "Rollenplatz läuft als Mensch");
        assert_eq!(parties[2]["kind"], "program");
        assert_eq!(parties[2]["mxl_in"], 1);
        assert_eq!(parties[3]["token"], "g1");
        assert_eq!(doc["channels"][0]["kind"], "party");
        assert_eq!(parties[1]["routes"][0]["pan"], -0.5);
        assert!(parties[0]["routes"][0].get("pan").is_none());
    }

    #[test]
    fn parties_for_user_group_and_open_seat() {
        let mut c = sample();
        c.parties.push(Party { id: 4, name: "Tech".into(), groups: vec!["g-tech".into()], ..Default::default() });
        let names = |v: Vec<&Party>| v.iter().map(|p| p.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(c.parties_for("ANNA", &[])), ["Regie 1", "Kamera 1"]);
        assert_eq!(names(c.parties_for("bob", &["g-tech".into()])), ["Kamera 1", "Tech"]);
        assert_eq!(names(c.parties_for("", &[])), ["Kamera 1"]);
        assert!(!names(c.panel_parties()).contains(&"Programm".to_string()));
    }

    #[test]
    fn json_shape_matches_the_ui_contract() {
        let c = sample().with_tokens(&Config::default());
        let v = serde_json::to_value(c.redacted()).unwrap();
        let p0 = &v["parties"][0];
        assert!(p0.get("token").is_none(), "Token nie ausliefern");
        assert!(p0.get("open").is_none() && p0.get("mxl_in").is_none(), "leere Felder fehlen wie bisher");
        assert_eq!(p0["users"][0], "anna");
        assert_eq!(v["channels"][1]["duck_db"], 12.0);
        let g = Guest { id: GUEST_BASE, name: "G".into(), expires: 0, ..Default::default() };
        assert_eq!(serde_json::to_value(&g).unwrap()["expires"], "1970-01-01T00:00:00Z");
        let back: Guest = serde_json::from_value(json!({"id": 100000, "name": "G", "expires": "2026-10-22T14:00:00.5+02:00", "routes": []})).unwrap();
        assert_eq!(back.expires, 1_792_670_400);
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("omp-intercom-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d.join("cfg.json")
    }

    #[test]
    fn update_persists_keeps_tokens_and_rejects_invalid() {
        let path = tmp("update");
        let mut a = Admin::open(Some(path.clone())).unwrap();
        assert!(a.is_empty());
        a.update("anna", sample()).unwrap();
        let tokens: Vec<String> = a.cfg.parties.iter().map(|p| p.token.clone()).collect();
        assert!(tokens.iter().all(|t| !t.is_empty()));
        a.update("anna", sample()).unwrap();
        assert_eq!(a.cfg.parties.iter().map(|p| p.token.clone()).collect::<Vec<_>>(), tokens, "Token bleiben");
        let mut bad = sample();
        bad.channels[0].name.clear();
        assert!(matches!(a.update("anna", bad), Err(AdminError::Invalid(_))));
        assert_eq!(a.cfg.channels[0].name, "Regie", "alte Konfiguration bleibt");
        let reopened = Admin::open(Some(path.clone())).unwrap();
        assert_eq!(reopened.cfg, a.cfg, "Datei enthält den letzten gültigen Stand");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn broken_file_is_an_error_not_an_empty_config() {
        let path = tmp("broken");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{kaputt").unwrap();
        assert!(Admin::open(Some(path.clone())).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn guest_lifecycle_and_expiry_pruning() {
        let mut a = Admin::open(None).unwrap();
        a.update("x", sample()).unwrap();
        let now = 10_000;
        let routes = vec![Route { ch: 1, talk: true, listen: true, ..Default::default() }];
        assert!(matches!(a.create_guest("x", " ", routes.clone(), 30, now), Err(AdminError::Invalid(_))));
        assert!(matches!(a.create_guest("x", "G", routes.clone(), 0, now), Err(AdminError::Invalid(_))));
        assert!(matches!(a.create_guest("x", "G", routes.clone(), 8 * 24 * 60, now), Err(AdminError::Invalid(_))));
        assert!(matches!(a.create_guest("x", "G", vec![Route { ch: 99, ..Default::default() }], 30, now), Err(AdminError::Invalid(_))));
        let (g1, _) = a.create_guest("x", "Gast 1", routes.clone(), 30, now).unwrap();
        assert_eq!(g1.id, GUEST_BASE);
        assert_eq!(g1.expires, now + 1800);
        let (g2, _) = a.create_guest("x", "Gast 2", routes, 60, now).unwrap();
        assert_eq!(g2.id, GUEST_BASE + 1);
        assert!(a.delete_guest(12345).is_err());
        a.delete_guest(g1.id).unwrap();
        assert_eq!(a.cfg.guests.len(), 1);
        assert!(!a.prune_guests(now));
        assert!(a.prune_guests(now + 7200));
        assert!(a.cfg.guests.is_empty());
        let mut after_update = sample();
        after_update.guests = vec![Guest { id: GUEST_BASE, name: "vom Client".into(), expires: 1 << 40, ..Default::default() }];
        a.update("x", after_update).unwrap();
        assert!(a.cfg.guests.is_empty(), "Gäste ändert nur der Gast-Endpunkt");
    }

    #[test]
    fn rotate_token_and_import() {
        let mut a = Admin::open(None).unwrap();
        a.update("x", sample()).unwrap();
        let before = a.cfg.parties[0].token.clone();
        a.rotate_token(1).unwrap();
        assert_ne!(a.cfg.parties[0].token, before);
        assert_eq!(a.rotate_token(77), Err(AdminError::NotFound));
        let mut b = Admin::open(None).unwrap();
        let mut full = sample();
        full.parties[0].token = "alt-token".into();
        b.import(full.clone()).unwrap();
        assert_eq!(b.cfg.parties[0].token, "alt-token", "Links bleiben gültig");
        assert!(!b.cfg.parties[1].token.is_empty());
        assert!(matches!(b.import(full), Err(AdminError::Invalid(_))), "nur in eine leere Konfiguration");
    }
}
