//! Reine Ablaufrechnung der Radio-Automation: aus Log, Startzeit und Jetztzeit folgt, welche Stimmen jetzt an den Segue-Player
//! zu schicken sind. Kein Netz, keine Uhr (Zeit kommt als Argument) — damit vollständig testbar.

use std::collections::HashSet;

use omp_playout_core::backtime;
use omp_playout_core::segue::{self, Config, Item, Placed};
use serde::{Deserialize, Serialize};

/// Ein Element des Logs in der Drahtform (Dateiname und Marken in ms).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogItem {
    pub id: String,
    pub kind: segue::Kind,
    pub file: String,
    pub duration_ms: i64,
    #[serde(default)]
    pub som_ms: i64,
    #[serde(default)]
    pub intro_ms: Option<i64>,
    #[serde(default)]
    pub outro_ms: Option<i64>,
    #[serde(default)]
    pub gain_db: f64,
    #[serde(default)]
    pub optional: bool,
    /// Übergang vom Vorgänger in dieses Element (Segue-Editor, RB7); leer = Standardblende.
    #[serde(default, skip_serializing_if = "segue::Transition::is_empty")]
    pub transition: segue::Transition,
    /// Harte Marke: dieses Element soll zu dieser Uhrzeit (Unix-ms) einsetzen (Backtiming, RB5).
    #[serde(default)]
    pub fix_at_unix_ms: Option<i64>,
    /// Anzeigename (nur Bedienfeld).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Blockname (z. B. Werbeblock); aufeinanderfolgende Elemente mit gleichem Namen bilden einen Block (nur Bedienfeld).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
}

/// Soll-Länge eines Blocks (nur Bedienfeld).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockSpec {
    pub name: String,
    pub target_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Log {
    pub log_id: String,
    pub items: Vec<LogItem>,
    /// Füllkandidaten für das Backtiming (werden nur bei Bedarf eingefügt).
    #[serde(default)]
    pub fillers: Vec<LogItem>,
    #[serde(default)]
    pub blocks: Vec<BlockSpec>,
}

/// Ein Aufruf `play` an den Segue-Player.
#[derive(Clone, Debug, PartialEq)]
pub struct PlayCall {
    pub index: usize,
    pub item_id: String,
    pub voice_id: String,
    pub file: String,
    pub start_at_tai_ns: u64,
    pub placed: Placed,
}

impl PlayCall {
    pub fn args(&self) -> serde_json::Value {
        let p = &self.placed;
        let mut v = serde_json::json!({
            "voiceId": self.voice_id,
            "file": self.file,
            "startAt": self.start_at_tai_ns,
            "gainDb": p.gain_db,
            "offsetMs": p.offset_ms,
            "fadeInMs": p.fade_in_ms,
            "fadeInCurve": p.fade_in_curve.as_str(),
            "fadeOutMs": p.fade_out_ms,
            "fadeOutCurve": p.fade_out_curve.as_str(),
            "label": self.item_id,
        });
        if let Some(s) = p.stop_at_ms {
            v["stopAtMs"] = serde_json::json!(s);
        }
        v
    }
}

fn to_item(i: &LogItem) -> Item {
    Item { id: i.id.clone(), kind: i.kind, duration_ms: i.duration_ms, som_ms: i.som_ms, intro_ms: i.intro_ms, outro_ms: i.outro_ms, gain_db: i.gain_db, optional: i.optional, transition: i.transition.clone() }
}

/// Backtiming beim Start: Für jede harte Marke (`fixAtUnixMs`) wird der Ablauf davor angepasst (Füllkandidaten weglassen/einfügen, Segue-Punkte
/// verschieben). Ergebnis: angepasster Log, Entscheidungen als Text, größter Rest in ms.
pub fn apply_fixtimes(log: &Log, start_unix_ms: i64, cfg: &Config, params: &backtime::Params) -> Result<(Log, Vec<String>, i64), String> {
    let mut cur = log.clone();
    let mut decisions = Vec::new();
    let mut worst = 0i64;
    let marks: Vec<String> = cur.items.iter().filter(|i| i.fix_at_unix_ms.is_some()).map(|i| i.id.clone()).collect();
    for id in marks {
        let idx = cur.items.iter().position(|i| i.id == id).ok_or("Marke verschwunden")?;
        let at = cur.items[idx].fix_at_unix_ms.unwrap_or(0) - start_unix_ms;
        let items: Vec<Item> = cur.items.iter().map(to_item).collect();
        let fillers: Vec<Item> = cur.fillers.iter().map(to_item).collect();
        let fit = backtime::fit(&items, idx, at, 0, &fillers, cfg, params)?;
        let mut pool: Vec<LogItem> = cur.items.iter().chain(cur.fillers.iter()).cloned().collect();
        let mut out = Vec::with_capacity(fit.items.len());
        for it in &fit.items {
            let pos = pool.iter().position(|x| x.id == it.id).ok_or("Element nicht gefunden")?;
            let mut li = pool[pos].clone();
            li.outro_ms = it.outro_ms;
            out.push(li);
            pool.remove(pos);
        }
        cur.fillers = cur.fillers.into_iter().filter(|f| !out.iter().any(|o| o.id == f.id)).collect();
        cur.items = out;
        decisions.extend(fit.decisions.iter().map(|d| format!("{id}: {d}")));
        if fit.residual_ms.abs() > worst.abs() {
            worst = fit.residual_ms;
        }
    }
    Ok((cur, decisions, worst))
}

/// `voiceId` des Elements: Log-ID und Platz; nur erlaubte Zeichen, höchstens 40.
pub fn voice_id(log_id: &str, index: usize) -> String {
    let clean: String = log_id.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' }).collect();
    let suffix = format!("-{index}");
    let keep = 40usize.saturating_sub(suffix.len());
    format!("{}{}", clean.chars().take(keep).collect::<String>(), suffix)
}

pub fn plan(log: &Log, cfg: &Config) -> Result<Vec<Placed>, String> {
    let items: Vec<Item> = log.items.iter().map(to_item).collect();
    segue::plan(&items, 0, cfg)
}

/// Welche Stimmen sind jetzt zu senden? Alle, deren Start innerhalb von `lookahead_ms` liegt (oder schon verstrichen ist, solange
/// sie nicht beendet wäre) und die noch nicht gesendet wurden.
pub fn due(log: &Log, placed: &[Placed], start_tai_ns: u64, now_tai_ns: u64, lookahead_ms: u64, sent: &HashSet<usize>) -> Vec<PlayCall> {
    let mut out = Vec::new();
    for (i, p) in placed.iter().enumerate() {
        if sent.contains(&i) {
            continue;
        }
        let start = start_tai_ns as i128 + p.start_ms as i128 * 1_000_000;
        let end = start_tai_ns as i128 + p.end_ms as i128 * 1_000_000;
        if end <= now_tai_ns as i128 {
            continue; // verpasst und vorbei: nicht mehr senden
        }
        if start - now_tai_ns as i128 > lookahead_ms as i128 * 1_000_000 {
            break; // spätere Elemente liegen noch weiter weg
        }
        out.push(PlayCall { index: i, item_id: p.id.clone(), voice_id: voice_id(&log.log_id, i), file: log.items[i].file.clone(), start_at_tai_ns: start.max(0) as u64, placed: p.clone() });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use segue::Kind;

    fn item(id: &str, kind: Kind, dur: i64, outro: Option<i64>) -> LogItem {
        LogItem { id: id.into(), kind, file: format!("/m/{id}.wav"), duration_ms: dur, som_ms: 0, intro_ms: None, outro_ms: outro, gain_db: -1.5, optional: false, transition: Default::default(), fix_at_unix_ms: None, title: None, block: None }
    }
    fn log() -> Log {
        Log { log_id: "tag 1".into(), fillers: vec![], blocks: vec![], items: vec![item("a", Kind::Song, 200_000, Some(195_000)), item("j", Kind::Jingle, 6_000, None), item("b", Kind::Song, 180_000, None)] }
    }

    #[test]
    fn voice_id_is_clean_and_bounded() {
        assert_eq!(voice_id("tag 1", 2), "tag_1-2");
        assert!(voice_id(&"x".repeat(100), 12345).len() <= 40);
    }

    #[test]
    fn only_voices_inside_lookahead_are_due() {
        let l = log();
        let p = plan(&l, &Config::default()).unwrap();
        let start = 10_000_000_000u64;
        let d = due(&l, &p, start, start, 30_000, &HashSet::new());
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].start_at_tai_ns, start);
        // 170 s später: Jingle (ab 195 s) im Vorlauf, Titel b (ab 200,5 s) noch nicht
        let d = due(&l, &p, start, start + 170_000_000_000, 30_000, &[0].into());
        assert_eq!(d.iter().map(|c| c.index).collect::<Vec<_>>(), vec![1]);
    }

    #[test]
    fn sent_voices_are_not_repeated() {
        let l = log();
        let p = plan(&l, &Config::default()).unwrap();
        let sent: HashSet<usize> = [0].into();
        assert!(due(&l, &p, 0, 1, 1000, &sent).is_empty());
    }

    #[test]
    fn finished_items_are_skipped_after_a_restart() {
        let l = log();
        let p = plan(&l, &Config::default()).unwrap();
        // Jetztzeit 300 s nach Start: Titel a und Jingle sind vorbei, b läuft (Beginn bei 200,5 s)
        let d = due(&l, &p, 0, 300_000_000_000, 30_000, &HashSet::new());
        assert_eq!(d.iter().map(|c| c.index).collect::<Vec<_>>(), vec![2]);
    }

    #[test]
    fn fixtime_drops_optional_and_keeps_files() {
        let mut l = log();
        let mut x = item("x", Kind::Song, 100_000, Some(95_000));
        x.optional = true;
        l.items.insert(1, x);
        // a (Segue 195 s) → x (Segue 95 s) → j → b: ohne Marke startet j bei 290 s; Marke auf j bei 195 s Logzeit
        let n = l.items.iter().position(|i| i.id == "j").unwrap();
        l.items[n].fix_at_unix_ms = Some(1_000_000 + 195_000);
        let (out, notes, residual) = apply_fixtimes(&l, 1_000_000, &Config::default(), &backtime::Params::default()).unwrap();
        assert_eq!(out.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["a", "j", "b"]);
        assert_eq!(out.items[0].file, "/m/a.wav");
        assert_eq!(residual, 0);
        assert!(notes[0].starts_with("j: "));
    }

    #[test]
    fn play_args_carry_the_plan() {
        let l = log();
        let p = plan(&l, &Config::default()).unwrap();
        let d = due(&l, &p, 5_000_000_000, 5_000_000_000, 1000, &HashSet::new());
        let a = d[0].args();
        assert_eq!(a["voiceId"], "tag_1-0");
        assert_eq!(a["stopAtMs"], 195_000);
        assert_eq!(a["fadeOutMs"], 1500);
        assert_eq!(a["gainDb"], -1.5);
        assert_eq!(a["startAt"], 5_000_000_000u64);
    }
}
