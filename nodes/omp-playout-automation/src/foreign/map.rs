//! Abbildung Zwischenmodell → Playlist-Items (formatunabhängiger Kern, `docs/ENTWURF-FREMDPLAYLIST-UND-DURCHLAUF.md` §3).
//!
//! Rein: erzeugt je Fremd-Event die Argumente der vorhandenen Methoden `append` und `updateItem` (so greifen
//! alle bestehenden Prüfungen) plus einen Bericht. Nichts verschwindet stillschweigend: was nicht
//! abgebildet werden kann, steht in `dropped`, was nur angenähert ist, in `approximated`.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::{EndMode, ForeignEvent, ForeignList, Kind, StartMode};
use crate::schedule::format_start_at;

#[derive(Debug, Clone)]
pub struct MapConfig {
    /// Dateiname aus der Medienkennung; `{name}` wird ersetzt.
    pub media_template: String,
    /// Logische Live-Quelle → Selektor-JSON (`omp_resolver::Selector`). Ohne Eintrag: `required: [<Name>]`.
    pub live_map: BTreeMap<String, Value>,
    /// Fremder Kind-Typ → Vorlage eines Child Events (JSON, `children.rs`); `delayMs`/`durationMs` werden gesetzt.
    pub child_map: BTreeMap<String, Value>,
    /// Bereits gelaufene Events (Fremdzustand `Done`) auslassen.
    pub skip_done: bool,
    /// Event bekommt das Freigabe-Flag (Kap. 74.3).
    pub require_release: bool,
}

impl Default for MapConfig {
    fn default() -> Self {
        Self { media_template: "{name}".into(), live_map: BTreeMap::new(), child_map: BTreeMap::new(), skip_done: true, require_release: false }
    }
}

impl MapConfig {
    /// Liest die Plugin-Konfiguration (unbekannte/fehlende Felder → Standard).
    pub fn from_json(v: &Value) -> Self {
        let mut c = Self::default();
        if let Some(s) = v.get("mediaTemplate").and_then(Value::as_str).filter(|s| s.contains("{name}")) {
            c.media_template = s.to_string();
        }
        for (key, dst) in [("liveMap", &mut c.live_map), ("childMap", &mut c.child_map)] {
            if let Some(o) = v.get(key).and_then(Value::as_object) {
                *dst = o.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            }
        }
        if let Some(b) = v.get("skipDone").and_then(Value::as_bool) {
            c.skip_done = b;
        }
        if let Some(b) = v.get("requireRelease").and_then(Value::as_bool) {
            c.require_release = b;
        }
        c
    }
}

#[derive(Debug, Clone)]
pub struct PlanItem {
    pub uid: String,
    pub reconcile_key: Option<String>,
    /// Argumente für `append`.
    pub append: Map<String, Value>,
    /// Patch für `updateItem` (`patchJson`); leer = nichts zu patchen.
    pub patch: Map<String, Value>,
    /// Medienkennung des Fremdsystems (für Abgleich/Freigabe).
    pub media_name: Option<String>,
    pub title: String,
    pub is_live: bool,
    /// Geplante Zeiten aus der Fremdliste (UTC ms).
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
}

#[derive(Debug, Default)]
pub struct Plan {
    pub items: Vec<PlanItem>,
    pub approximated: Vec<String>,
    pub dropped: Vec<String>,
    pub skipped_done: usize,
}

fn transition(t: &str) -> (&'static str, bool) {
    match t {
        "Cut" => ("cut", false),
        "Mix" => ("mix", false),
        _ => ("mix", true), // Fade Cut, V-Fade, … → weich
    }
}

fn effective_duration(e: &ForeignEvent) -> Option<i64> {
    match (e.duration_ms, e.start_ms, e.end_ms) {
        (Some(d), ..) if e.end_mode == EndMode::Duration && d > 0 => Some(d),
        (_, Some(s), Some(en)) if en > s => Some(en - s),
        _ => None,
    }
}

pub fn plan(list: &ForeignList, cfg: &MapConfig) -> Plan {
    let mut out = Plan::default();
    let mut pending_block: Option<String> = None;
    let mut pending_notes: Vec<String> = Vec::new();
    for e in &list.events {
        match &e.kind {
            Kind::BlockStart => {
                pending_block = Some(if !e.title.is_empty() { e.title.clone() } else { e.meta.get("block").cloned().unwrap_or_default() });
                continue;
            }
            Kind::BlockEnd => {
                pending_block = None;
                continue;
            }
            Kind::Comment => {
                if let Some(c) = &e.comment {
                    pending_notes.push(c.clone());
                }
                continue;
            }
            Kind::Other(t) => {
                out.dropped.push(format!("{}: unbekannter Typ „{t}“", e.uid));
                continue;
            }
            Kind::Child(t) => {
                out.dropped.push(format!("{}: Kind-Typ „{t}“ in der Hauptliste", e.uid));
                continue;
            }
            Kind::Clip | Kind::Live => {}
        }
        if !e.enabled {
            out.dropped.push(format!("{} „{}“: deaktiviert", e.uid, e.title));
            continue;
        }
        if cfg.skip_done && e.state == "Done" {
            out.skipped_done += 1;
            continue;
        }
        let mut append = Map::new();
        let mut patch = Map::new();
        let label = if e.title.is_empty() { e.media_name.clone().unwrap_or_else(|| format!("Event {}", e.uid)) } else { e.title.clone() };
        append.insert("label".into(), json!(label));
        match &e.kind {
            Kind::Clip => match &e.media_name {
                Some(m) => {
                    append.insert("file".into(), json!(cfg.media_template.replace("{name}", m)));
                }
                None => {
                    out.dropped.push(format!("{} „{label}“: Datei-Event ohne Medienkennung", e.uid));
                    continue;
                }
            },
            _ => {
                let name = e.source.clone().unwrap_or_default();
                let sel = cfg.live_map.get(&name).cloned().unwrap_or_else(|| {
                    out.approximated.push(format!("{} „{label}“: Live-Quelle „{name}“ ist nicht zugeordnet (liveMap) — Auswahl nach Tag „{name}“", e.uid));
                    json!({ "required": [name] })
                });
                append.insert("eventType".into(), json!("LIVE"));
                append.insert("sourceSelectorJson".into(), json!(sel.to_string()));
                if let Some(b) = &e.backup_source {
                    out.approximated.push(format!("{} „{label}“: Rückfallquelle „{b}“ nicht abgebildet", e.uid));
                }
            }
        }
        if let Some(d) = effective_duration(e) {
            append.insert("durationMs".into(), json!(d));
        }
        match (e.start_mode, e.start_ms) {
            (StartMode::Fixed, Some(ms)) => {
                patch.insert("startType".into(), json!("fixtime"));
                patch.insert("startAt".into(), json!(format_start_at(ms)));
            }
            (StartMode::Fixed, None) => out.approximated.push(format!("{} „{label}“: Fixzeit ohne Zeitpunkt, als Folgestart gelesen", e.uid)),
            _ => {}
        }
        if e.end_mode == EndMode::Hold {
            // Läuft bis zur manuellen Weiterschaltung: ohne Dauer bleibt das Event stehen.
            out.approximated.push(format!("{} „{label}“: „Hold“ — Event endet erst durch Bedienung", e.uid));
        }
        if let Some(t) = &e.transition {
            let (tr, soft) = transition(t);
            patch.insert("transition".into(), json!(tr));
            if soft && t != "Mix" {
                out.approximated.push(format!("{} „{label}“: Übergang „{t}“ als Mix", e.uid));
            }
        }
        if cfg.require_release {
            patch.insert("requireRelease".into(), json!(true));
        }
        let mut notes = std::mem::take(&mut pending_notes);
        if let Some(b) = &pending_block {
            notes.insert(0, format!("Block: {b}"));
        }
        if !notes.is_empty() {
            patch.insert("note".into(), json!(notes.join(" | ")));
        }
        // Kinder
        let mut kids = Vec::new();
        for c in &e.children {
            let Kind::Child(t) = &c.kind else { continue };
            let Some(tpl) = cfg.child_map.get(t) else {
                out.dropped.push(format!("{} „{label}“: Kind „{t}“ ohne Eintrag in childMap", c.uid));
                continue;
            };
            let mut k = tpl.clone();
            if let Some(o) = k.as_object_mut() {
                let delay = match (c.start_ms, e.start_ms) {
                    (Some(cs), Some(ps)) if cs >= ps => (cs - ps) as u64,
                    _ => 0,
                };
                o.insert("delayMs".into(), json!(delay));
                let dur = match (c.start_ms, c.end_ms) {
                    (Some(s), Some(en)) if en > s => (en - s) as u64,
                    _ => 0, // 0 = bis zum Ende des Primary
                };
                o.entry("durationMs").or_insert(json!(dur));
                for (k2, v) in &c.meta {
                    if let Some(f) = k2.strip_prefix("cg.") {
                        o.entry("data").or_insert_with(|| json!({})).as_object_mut().map(|d| d.insert(f.to_string(), json!(v)));
                    }
                }
                if let Some(m) = &c.media_name {
                    o.entry("templateId").or_insert(json!(m));
                }
            }
            kids.push(k);
        }
        if !kids.is_empty() {
            patch.insert("children".into(), Value::Array(kids));
        }
        for f in ["Loudness", "AudioShuffle", "Subtitle"] {
            if let Some(v) = e.features.get(f).filter(|v| !v.is_empty()) {
                out.approximated.push(format!("{} „{label}“: {f} „{v}“ nicht abgebildet", e.uid));
            }
        }
        out.items.push(PlanItem {
            uid: e.uid.clone(),
            reconcile_key: e.reconcile_key.clone(),
            append,
            patch,
            media_name: e.media_name.clone(),
            title: label.clone(),
            is_live: e.kind == Kind::Live,
            start_ms: e.start_ms,
            end_ms: e.end_ms,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::foreign::{mpl3::Mpl3, ForeignFormat, ParseCtx};

    fn list() -> ForeignList {
        Mpl3.parse(include_str!("fixtures/mini.mpl").as_bytes(), &ParseCtx::default()).unwrap()
    }

    #[test]
    fn clip_live_und_bericht() {
        let p = plan(&list(), &MapConfig::default());
        assert_eq!(p.items.len(), 2);
        let c = &p.items[0];
        assert_eq!(c.append["file"], "MEDIA0001");
        assert_eq!(c.append["label"], "Beispielsendung");
        assert_eq!(c.append["durationMs"], 60_560);
        assert_eq!(c.patch["transition"], "mix");
        assert_eq!(c.patch["note"], "Block: Block eins");
        assert!(p.approximated.iter().any(|a| a.contains("Fade Cut")));
        assert!(p.approximated.iter().any(|a| a.contains("Loudness")));
        // Kinder ohne childMap werden gemeldet, nicht verschluckt.
        assert_eq!(p.dropped.len(), 2);
        let l = &p.items[1];
        assert_eq!(l.append["eventType"], "LIVE");
        assert_eq!(l.patch["startType"], "fixtime");
        assert!(l.patch["startAt"].as_str().unwrap().ends_with('Z'));
        assert!(p.approximated.iter().any(|a| a.contains("RP21") && a.contains("liveMap")));
        // Der Kommentar vor dem Blockende hängt an keinem Folge-Event → bleibt für das nächste (hier keines).
    }

    #[test]
    fn template_livemap_childmap() {
        let cfg = MapConfig::from_json(&json!({
            "mediaTemplate": "{name}.mxf",
            "liveMap": {"RP21": {"exactId": "abc"}},
            "childMap": {"LogoHD": {"type": "GRAPHICS", "templateId": "logo"}, "VIZ": {"type": "GRAPHICS"}},
        }));
        let p = plan(&list(), &cfg);
        assert_eq!(p.items[0].append["file"], "MEDIA0001.mxf");
        assert_eq!(p.items[1].append["sourceSelectorJson"], "{\"exactId\":\"abc\"}");
        let kids = p.items[0].patch["children"].as_array().unwrap();
        assert_eq!(kids.len(), 2);
        assert_eq!(kids[0]["templateId"], "logo");
        assert_eq!(kids[0]["delayMs"], 0);
        assert_eq!(kids[1]["data"]["Titel"], "Ein Titel");
        assert!(p.dropped.is_empty());
    }

    #[test]
    fn freigabe_flag_wird_gesetzt() {
        let p = plan(&list(), &MapConfig::from_json(&json!({"requireRelease": true})));
        assert!(p.items.iter().all(|i| i.patch["requireRelease"] == true));
        let p = plan(&list(), &MapConfig::default());
        assert!(p.items.iter().all(|i| !i.patch.contains_key("requireRelease")));
    }

    #[test]
    fn fertige_und_ohne_kennung() {
        let mut l = list();
        l.events[1].state = "Done".into();
        assert_eq!(plan(&l, &MapConfig::default()).skipped_done, 1);
        assert_eq!(plan(&l, &MapConfig { skip_done: false, ..Default::default() }).items.len(), 2);
        l.events[1].media_name = None;
        let p = plan(&l, &MapConfig { skip_done: false, ..Default::default() });
        assert_eq!(p.items.len(), 1);
        assert!(p.dropped.iter().any(|d| d.contains("Medienkennung")));
    }

    #[test]
    fn echtdateien_plan() {
        let Ok(v) = std::env::var("OMP_TEST_MPL") else { return };
        for f in v.split(':') {
            let l = Mpl3.parse(&std::fs::read(f).unwrap(), &ParseCtx::default()).unwrap();
            let p = plan(&l, &MapConfig::default());
            eprintln!("{f}: {} Items, {} fertig, {} angenähert, {} verworfen", p.items.len(), p.skipped_done, p.approximated.len(), p.dropped.len());
            assert!(!p.items.is_empty());
        }
    }
}
