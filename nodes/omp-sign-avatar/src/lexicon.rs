//! Lexikon: Gebärden als Daten (JSON), damit Fachleute sie ohne Code ändern können (docs/GEBAERDENSPRACHE.md §4).
//!
//! ```json
//! { "version": 1,
//!   "signs": [ { "gloss": "HALLO", "pos": "other", "verified": true,
//!                "keys": [ { "ms": 0,   "pose": { "dom": { "hand": "B", "shoulder": [-1.2,0,-0.3] } } },
//!                          { "ms": 500, "pose": { "dom": { "hand": "B", "wrist": [0,0,0.4] } } } ] } ],
//!   "lemmas": { "hallo": "HALLO", "hallos": "HALLO" } }
//! ```
//! Eine Haltung (`pose`) beginnt bei `base` (`"sign"` = Unterarm vor dem Gesicht, Standard; `"rest"` = Ruhe) und überschreibt
//! dann je Arm (`dom` = rechts im Bild, `off` = links) die genannten Felder; `hand` setzt zuerst eine Handform aus dem
//! Fingeralphabet (A–Z, 0–9). Winkel im Bogenmaß.
//!
//! **Freigabe:** nur Einträge mit `"verified": true` (von Gebärdenden geprüft) dürfen auf Sendung; alle anderen behandelt der
//! Node wie unbekannte Wörter (Buchstabieren/Text), es sei denn, `allowUnverified` ist ausdrücklich eingeschaltet (nur für Tests).

use std::collections::HashMap;

use serde_json::Value;

use crate::alphabet;
use crate::avatar::{ArmPose, Pose};
use crate::player::Timeline;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pos {
    Noun,
    Verb,
    Time,
    Negation,
    Question,
    Other,
}

#[derive(Clone, Debug)]
pub struct Sign {
    pub gloss: String,
    pub pos: Pos,
    pub verified: bool,
    pub keys: Vec<(f32, Pose)>,
}

#[derive(Clone, Debug, Default)]
pub struct Lexicon {
    pub signs: HashMap<String, Sign>,
    /// Kleingeschriebene Wortform → Glosse.
    pub lemmas: HashMap<String, String>,
}

const MAX_ANGLE: f64 = 3.6;

fn num(v: &Value, what: &str) -> Result<f32, String> {
    let n = v.as_f64().ok_or_else(|| format!("{what}: Zahl erwartet"))?;
    if !n.is_finite() {
        return Err(format!("{what}: keine endliche Zahl"));
    }
    Ok(n as f32)
}

fn angles(v: &Value, what: &str) -> Result<[f32; 3], String> {
    let a = v.as_array().filter(|a| a.len() == 3).ok_or_else(|| format!("{what}: drei Zahlen erwartet"))?;
    let mut out = [0.0; 3];
    for i in 0..3 {
        out[i] = num(&a[i], what)?;
        if (out[i] as f64).abs() > MAX_ANGLE {
            return Err(format!("{what}: Winkel {} außerhalb ±{MAX_ANGLE}", out[i]));
        }
    }
    Ok(out)
}

fn in_range(x: f32, lo: f32, hi: f32, what: &str) -> Result<f32, String> {
    if x < lo || x > hi {
        return Err(format!("{what}: {x} außerhalb [{lo}, {hi}]"));
    }
    Ok(x)
}

fn arm_from_json(arm: &mut ArmPose, v: &Value, what: &str) -> Result<(), String> {
    let o = v.as_object().ok_or_else(|| format!("{what}: Objekt erwartet"))?;
    if let Some(h) = o.get("hand") {
        let c = h.as_str().and_then(|s| s.chars().next()).ok_or_else(|| format!("{what}.hand: Buchstabe/Ziffer erwartet"))?;
        if !alphabet::apply_hand(arm, c) {
            return Err(format!("{what}.hand: unbekannte Handform „{c}“"));
        }
    }
    for k in o.keys() {
        if !["hand", "shoulder", "elbow", "twist", "wrist", "curl", "thumbAbd", "spread"].contains(&k.as_str()) {
            return Err(format!("{what}: unbekanntes Feld „{k}“"));
        }
    }
    if let Some(x) = o.get("shoulder") {
        arm.shoulder = angles(x, &format!("{what}.shoulder"))?;
    }
    if let Some(x) = o.get("elbow") {
        arm.elbow = in_range(num(x, &format!("{what}.elbow"))?, -MAX_ANGLE as f32, MAX_ANGLE as f32, &format!("{what}.elbow"))?;
    }
    if let Some(x) = o.get("twist") {
        arm.twist = in_range(num(x, &format!("{what}.twist"))?, -MAX_ANGLE as f32, MAX_ANGLE as f32, &format!("{what}.twist"))?;
    }
    if let Some(x) = o.get("wrist") {
        arm.wrist = angles(x, &format!("{what}.wrist"))?;
    }
    if let Some(x) = o.get("curl") {
        let a = x.as_array().filter(|a| a.len() == 5).ok_or_else(|| format!("{what}.curl: fünf Zahlen erwartet"))?;
        for i in 0..5 {
            arm.curl[i] = in_range(num(&a[i], &format!("{what}.curl"))?, 0.0, 1.0, &format!("{what}.curl"))?;
        }
    }
    if let Some(x) = o.get("thumbAbd") {
        arm.thumb_abd = in_range(num(x, &format!("{what}.thumbAbd"))?, 0.0, 1.0, &format!("{what}.thumbAbd"))?;
    }
    if let Some(x) = o.get("spread") {
        arm.spread = in_range(num(x, &format!("{what}.spread"))?, -1.0, 1.5, &format!("{what}.spread"))?;
    }
    Ok(())
}

pub fn pose_from_json(v: &Value, what: &str) -> Result<Pose, String> {
    let o = v.as_object().ok_or_else(|| format!("{what}: Objekt erwartet"))?;
    for k in o.keys() {
        if !["base", "dom", "off", "head"].contains(&k.as_str()) {
            return Err(format!("{what}: unbekanntes Feld „{k}“"));
        }
    }
    let mut pose = match o.get("base").and_then(Value::as_str).unwrap_or("sign") {
        "sign" => alphabet::signing_pose(),
        "rest" => Pose::REST,
        other => return Err(format!("{what}.base: „{other}“ unbekannt (sign|rest)")),
    };
    if let Some(d) = o.get("dom") {
        arm_from_json(&mut pose.dom, d, &format!("{what}.dom"))?;
    }
    if let Some(d) = o.get("off") {
        arm_from_json(&mut pose.off, d, &format!("{what}.off"))?;
    }
    if let Some(h) = o.get("head") {
        pose.head = angles(h, &format!("{what}.head"))?;
    }
    Ok(pose)
}

fn pos_from(s: &str) -> Result<Pos, String> {
    Ok(match s {
        "noun" => Pos::Noun,
        "verb" => Pos::Verb,
        "time" => Pos::Time,
        "negation" => Pos::Negation,
        "question" => Pos::Question,
        "other" | "" => Pos::Other,
        o => return Err(format!("pos „{o}“ unbekannt (noun|verb|time|negation|question|other)")),
    })
}

impl Lexicon {
    pub fn from_json(text: &str) -> Result<Lexicon, String> {
        let v: Value = serde_json::from_str(text).map_err(|e| format!("kein gültiges JSON: {e}"))?;
        if v.get("version").and_then(Value::as_u64) != Some(1) {
            return Err("version 1 erwartet".into());
        }
        let mut lex = Lexicon::default();
        for (n, s) in v.get("signs").and_then(Value::as_array).ok_or("signs: Liste erwartet")?.iter().enumerate() {
            let gloss = s.get("gloss").and_then(Value::as_str).filter(|g| !g.is_empty()).ok_or_else(|| format!("signs[{n}].gloss fehlt"))?.to_string();
            let what = format!("signs[{n}] {gloss}");
            if lex.signs.contains_key(&gloss) {
                return Err(format!("{what}: Glosse doppelt"));
            }
            let pos = pos_from(s.get("pos").and_then(Value::as_str).unwrap_or("other")).map_err(|e| format!("{what}: {e}"))?;
            let verified = s.get("verified").and_then(Value::as_bool).unwrap_or(false);
            let mut keys: Vec<(f32, Pose)> = Vec::new();
            for (i, k) in s.get("keys").and_then(Value::as_array).ok_or_else(|| format!("{what}.keys: Liste erwartet"))?.iter().enumerate() {
                let ms = num(k.get("ms").ok_or_else(|| format!("{what}.keys[{i}].ms fehlt"))?, &format!("{what}.keys[{i}].ms"))?;
                if ms < 0.0 || keys.last().is_some_and(|l| ms < l.0) {
                    return Err(format!("{what}.keys[{i}].ms: Zeiten müssen aufsteigend und ≥ 0 sein"));
                }
                let pose = pose_from_json(k.get("pose").ok_or_else(|| format!("{what}.keys[{i}].pose fehlt"))?, &format!("{what}.keys[{i}].pose"))?;
                keys.push((ms, pose));
            }
            if keys.is_empty() {
                return Err(format!("{what}: mindestens ein Schlüssel nötig"));
            }
            lex.lemmas.insert(gloss.to_lowercase(), gloss.clone());
            lex.signs.insert(gloss.clone(), Sign { gloss, pos, verified, keys });
        }
        if let Some(l) = v.get("lemmas").and_then(Value::as_object) {
            for (word, g) in l {
                let g = g.as_str().ok_or_else(|| format!("lemmas.{word}: Glosse erwartet"))?;
                if !lex.signs.contains_key(g) {
                    return Err(format!("lemmas.{word}: Glosse „{g}“ nicht im Lexikon"));
                }
                lex.lemmas.insert(word.to_lowercase(), g.to_string());
            }
        }
        Ok(lex)
    }

    /// Gebärde zu einem Wort (Grundform-Tabelle, sonst Glosse in Großbuchstaben); unverifizierte nur mit `allow_unverified`.
    pub fn lookup(&self, word: &str, allow_unverified: bool) -> Option<&Sign> {
        let g = self.lemmas.get(&word.to_lowercase())?;
        self.signs.get(g).filter(|s| s.verified || allow_unverified)
    }

    pub fn verified_count(&self) -> usize {
        self.signs.values().filter(|s| s.verified).count()
    }
}

impl Sign {
    /// Hängt die Gebärde an: weiche Annäherung an den ersten Schlüssel, dann die eigenen Abstände, kurzes Halten am Ende.
    pub fn push_into(&self, tl: &mut Timeline, speed: f32) {
        let speed = speed.clamp(0.25, 4.0);
        let mut prev = 0.0;
        for (i, (ms, pose)) in self.keys.iter().enumerate() {
            let dt = if i == 0 { 220.0 / speed } else { (ms - prev) / speed };
            tl.push(dt, 0.0, *pose);
            prev = *ms;
        }
        tl.push(0.0, 150.0 / speed, self.keys.last().unwrap().1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEX: &str = r#"{ "version": 1, "signs": [
      { "gloss": "HALLO", "verified": true, "keys": [
        { "ms": 0, "pose": { "dom": { "hand": "B" } } },
        { "ms": 400, "pose": { "dom": { "hand": "B", "wrist": [0, 0, 0.4] } } } ] },
      { "gloss": "TEST", "pos": "verb", "keys": [ { "ms": 0, "pose": { "base": "rest" } } ] } ],
      "lemmas": { "hallos": "HALLO" } }"#;

    #[test]
    fn parses_signs_lemmas_and_hand_shapes() {
        let l = Lexicon::from_json(LEX).unwrap();
        assert_eq!(l.signs.len(), 2);
        let h = &l.signs["HALLO"];
        assert_eq!(h.keys.len(), 2);
        assert_eq!(h.keys[0].1.dom.curl, alphabet::pose_for('B').unwrap().dom.curl);
        assert!((h.keys[1].1.dom.wrist[2] - alphabet::pose_for('B').unwrap().dom.wrist[2] - 0.4).abs() < 1e-6 || h.keys[1].1.dom.wrist[2] == 0.4);
        assert_eq!(l.signs["TEST"].pos, Pos::Verb);
        assert_eq!(l.lookup("Hallos", true).unwrap().gloss, "HALLO");
        assert_eq!(l.lookup("hallo", false).unwrap().gloss, "HALLO");
    }

    #[test]
    fn unverified_signs_are_hidden_unless_explicitly_allowed() {
        let l = Lexicon::from_json(LEX).unwrap();
        assert!(l.lookup("test", false).is_none());
        assert!(l.lookup("test", true).is_some());
        assert_eq!(l.verified_count(), 1);
    }

    #[test]
    fn rejects_bad_data_with_a_precise_message() {
        let bad = |s: &str| Lexicon::from_json(s).unwrap_err();
        assert!(bad("{").contains("JSON"));
        assert!(bad(r#"{"version":2,"signs":[]}"#).contains("version"));
        assert!(bad(r#"{"version":1,"signs":[{"gloss":"A","keys":[]}]}"#).contains("Schlüssel"));
        assert!(bad(r#"{"version":1,"signs":[{"gloss":"A","keys":[{"ms":5,"pose":{}},{"ms":1,"pose":{}}]}]}"#).contains("aufsteigend"));
        assert!(bad(r#"{"version":1,"signs":[{"gloss":"A","keys":[{"ms":0,"pose":{"dom":{"curl":[2,0,0,0,0]}}}]}]}"#).contains("curl"));
        assert!(bad(r#"{"version":1,"signs":[{"gloss":"A","keys":[{"ms":0,"pose":{"dom":{"hand":"?"}}}]}]}"#).contains("Handform"));
        assert!(bad(r#"{"version":1,"signs":[{"gloss":"A","keys":[{"ms":0,"pose":{"dom":{"shoulder":[9,0,0]}}}]}]}"#).contains("Winkel"));
        assert!(bad(r#"{"version":1,"signs":[{"gloss":"A","keys":[{"ms":0,"pose":{"dom":{"elbo":1}}}]}]}"#).contains("elbo"));
        assert!(bad(r#"{"version":1,"signs":[],"lemmas":{"x":"NIX"}}"#).contains("NIX"));
        assert!(bad(r#"{"version":1,"signs":[{"gloss":"A","keys":[{"ms":0,"pose":{}}]},{"gloss":"A","keys":[{"ms":0,"pose":{}}]}]}"#).contains("doppelt"));
    }

    #[test]
    fn a_sign_plays_through_its_keys() {
        let l = Lexicon::from_json(LEX).unwrap();
        let mut tl = Timeline::new(0.0);
        l.signs["HALLO"].push_into(&mut tl, 1.0);
        let end = tl.total_ms();
        assert!(end > 220.0 + 400.0);
        assert_eq!(tl.pose_at(end), l.signs["HALLO"].keys[1].1);
    }
}
