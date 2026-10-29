//! Regelbasierte Satzaufbereitung „Untertitel → Glossenfolge“ (docs/GEBAERDENSPRACHE.md §3), ohne KI und ohne Raten:
//! Sätze trennen, Wörter auf Gebärden abbilden, Füllwörter weglassen, Zeitangaben nach vorn, Verb nach hinten, Verneinung
//! hinter das Verb, Fragewort ans Ende; unbekannte Wörter werden buchstabiert, Zahlen als Zahlgebärden; ist ein Satz zu
//! mehr als `maxUnknownRatio` unbekannt, wird er nicht gebärdet, sondern als Text eingeblendet.
//!
//! **Die Regeln sind ein Entwurf** und müssen von Gehörlosen-Fachleuten geprüft werden. Sie liegen deshalb als Datei vor
//! (`OMP_SIGN_RULES`, JSON), die Standardregeln stehen in `DEFAULT_RULES`.

use std::collections::HashSet;

use serde_json::Value;

use crate::lexicon::{Lexicon, Pos};

pub const DEFAULT_RULES: &str = r#"{
  "version": 1,
  "drop": ["der","die","das","den","dem","des","ein","eine","einen","einem","einer","eines","ist","sind","war","waren","wird","werden","wurde","wurden","hat","haben","hatte","hatten","wurde","sein","zu","von","im","am","um","und","dass","auch","sehr","noch","schon"],
  "timeWords": ["heute","gestern","morgen","jetzt","gleich","später","früher","bald","montag","dienstag","mittwoch","donnerstag","freitag","samstag","sonntag","abend","nachmittag","vormittag","nacht"],
  "negations": ["nicht","kein","keine","keinen","keinem","nie","niemals","nichts"],
  "questionWords": ["wer","was","wo","wann","wie","warum","wieso","weshalb","welche","welcher","welches","wohin","woher"],
  "maxUnknownRatio": 0.5,
  "spellUnknown": true
}"#;

#[derive(Clone, Debug)]
pub struct Rules {
    pub drop: HashSet<String>,
    pub time_words: HashSet<String>,
    pub negations: HashSet<String>,
    pub question_words: HashSet<String>,
    pub max_unknown_ratio: f32,
    pub spell_unknown: bool,
}

fn set(v: &Value, key: &str) -> Result<HashSet<String>, String> {
    let a = v.get(key).and_then(Value::as_array).ok_or_else(|| format!("{key}: Liste erwartet"))?;
    a.iter().map(|x| x.as_str().map(|s| s.to_lowercase()).ok_or_else(|| format!("{key}: Texte erwartet"))).collect()
}

impl Rules {
    pub fn from_json(text: &str) -> Result<Rules, String> {
        let v: Value = serde_json::from_str(text).map_err(|e| format!("Regeln: kein gültiges JSON: {e}"))?;
        if v.get("version").and_then(Value::as_u64) != Some(1) {
            return Err("Regeln: version 1 erwartet".into());
        }
        let ratio = v.get("maxUnknownRatio").and_then(Value::as_f64).unwrap_or(0.5);
        if !(0.0..=1.0).contains(&ratio) {
            return Err("Regeln: maxUnknownRatio außerhalb [0,1]".into());
        }
        Ok(Rules {
            drop: set(&v, "drop")?,
            time_words: set(&v, "timeWords")?,
            negations: set(&v, "negations")?,
            question_words: set(&v, "questionWords")?,
            max_unknown_ratio: ratio as f32,
            spell_unknown: v.get("spellUnknown").and_then(Value::as_bool).unwrap_or(true),
        })
    }

    pub fn default_rules() -> Rules {
        Rules::from_json(DEFAULT_RULES).expect("Standardregeln gültig")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    /// Glosse einer Gebärde aus dem Lexikon.
    Sign(String),
    /// Buchstabieren (Eigenname/unbekanntes Wort).
    Spell(String),
    /// Zahl als Ziffernfolge.
    Digits(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Gloss {
    pub item: Item,
    /// Verneinung: Kopfschütteln während dieses Elements.
    pub negation: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sentence {
    pub text: String,
    pub glosses: Vec<Gloss>,
    /// Fragesatz (Fragezeichen oder Fragewort): Frage-Kopfhaltung.
    pub question: bool,
    /// Anteil unbekannter Wörter unter den gebärdbaren Wörtern.
    pub unknown_ratio: f32,
    /// Nicht gebärden, sondern als Text zeigen.
    pub text_fallback: bool,
}

/// Endet der Satzanfang auf eine gängige Abkürzung („z. B.“, „d. h.“, „ca.“ …), ist der Punkt kein Satzende.
fn abbreviation_end(cur: &str, rest: &[char]) -> bool {
    let low = cur.trim_end().to_lowercase();
    const ABBR: [&str; 14] = ["z. b.", "d. h.", "u. a.", "o. ä.", "u. ä.", "i. d. r.", "ca.", "bzw.", "ggf.", "evtl.", "vgl.", "nr.", "dr.", "prof."];
    // „z.“ vor „B.“: Einzelbuchstabe mit Punkt, danach wieder Einzelbuchstabe mit Punkt
    let r: Vec<char> = rest.iter().copied().skip_while(|c| c.is_whitespace()).take(2).collect();
    let single = low.ends_with('.') && low.trim_end_matches('.').chars().last().is_some_and(char::is_alphabetic) && low.trim_end_matches('.').chars().rev().nth(1).is_none_or(|c| !c.is_alphanumeric());
    if single && r.len() == 2 && r[0].is_alphabetic() && r[1] == '.' {
        return true;
    }
    ABBR.iter().any(|a| low.ends_with(a) && low[..low.len() - a.len()].chars().last().is_none_or(|c| !c.is_alphanumeric()))
}

/// Teilt in Sätze (. ! ? und Zeilenumbruch); das Satzzeichen bleibt am Satz.
pub fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if c == '\n' {
            if !cur.trim().is_empty() {
                out.push(cur.trim().to_string());
            }
            cur.clear();
            continue;
        }
        cur.push(c);
        // Satzende: .!? gefolgt von Leerraum/Ende; „3.5“ oder „z. B.“ nicht (Ziffer davor und danach / Kleinbuchstabe danach)
        if matches!(c, '.' | '!' | '?') {
            let next = chars.get(i + 1);
            let prev_digit = i > 0 && chars[i - 1].is_ascii_digit();
            let ends = !abbreviation_end(&cur, &chars[i + 1..]) && match next {
                None => true,
                Some(n) if n.is_whitespace() => {
                    let after = chars[i + 1..].iter().find(|x| !x.is_whitespace());
                    !(c == '.' && after.is_some_and(|a| a.is_lowercase() || (prev_digit && a.is_ascii_digit())))
                }
                _ => false,
            };
            if ends {
                out.push(cur.trim().to_string());
                cur.clear();
            }
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

fn words(sentence: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in sentence.chars() {
        if c.is_alphanumeric() || (c == '-' && !cur.is_empty()) {
            cur.push(c);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur).trim_end_matches('-').to_string());
        }
    }
    if !cur.is_empty() {
        out.push(cur.trim_end_matches('-').to_string());
    }
    out.retain(|w| !w.is_empty());
    out
}

#[derive(PartialEq, Clone, Copy)]
enum Class {
    Time,
    Other,
    Verb,
    Negation,
    Question,
}

pub fn translate(text: &str, lex: &Lexicon, rules: &Rules, allow_unverified: bool) -> Vec<Sentence> {
    let mut out = Vec::new();
    for s in split_sentences(text) {
        let mut entries: Vec<(Class, Gloss)> = Vec::new();
        let (mut known, mut unknown) = (0usize, 0usize);
        let mut question = s.trim_end().ends_with('?');
        for w in words(&s) {
            let lw = w.to_lowercase();
            if rules.drop.contains(&lw) && lex.lookup(&lw, allow_unverified).is_none() {
                continue;
            }
            let digits = w.chars().all(|c| c.is_ascii_digit());
            let sign = lex.lookup(&lw, allow_unverified);
            let mut class = match sign.map(|g| g.pos) {
                Some(Pos::Time) => Class::Time,
                Some(Pos::Verb) => Class::Verb,
                Some(Pos::Negation) => Class::Negation,
                Some(Pos::Question) => Class::Question,
                _ => Class::Other,
            };
            if rules.time_words.contains(&lw) {
                class = Class::Time;
            } else if rules.negations.contains(&lw) {
                class = Class::Negation;
            } else if rules.question_words.contains(&lw) {
                class = Class::Question;
                question = true;
            }
            let item = if digits {
                known += 1;
                Item::Digits(w.clone())
            } else if let Some(sg) = sign {
                known += 1;
                Item::Sign(sg.gloss.clone())
            } else {
                unknown += 1;
                if !rules.spell_unknown {
                    continue;
                }
                Item::Spell(w.clone())
            };
            entries.push((class, Gloss { item, negation: class == Class::Negation }));
        }
        if entries.is_empty() {
            continue;
        }
        let total = known + unknown;
        let ratio = if total == 0 { 0.0 } else { unknown as f32 / total as f32 };
        // Reihenfolge: Zeit, übrige (in Satzfolge), Verben, Verneinung, Fragewort
        let mut glosses = Vec::new();
        for class in [Class::Time, Class::Other, Class::Verb, Class::Negation, Class::Question] {
            glosses.extend(entries.iter().filter(|(c, _)| *c == class).map(|(_, g)| g.clone()));
        }
        out.push(Sentence { text: s, glosses, question, unknown_ratio: ratio, text_fallback: ratio > rules.max_unknown_ratio });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lex() -> Lexicon {
        Lexicon::from_json(
            r#"{"version":1,"signs":[
              {"gloss":"HEUTE","pos":"time","verified":true,"keys":[{"ms":0,"pose":{}}]},
              {"gloss":"REGEN","pos":"noun","verified":true,"keys":[{"ms":0,"pose":{}}]},
              {"gloss":"KOMMEN","pos":"verb","verified":true,"keys":[{"ms":0,"pose":{}}]},
              {"gloss":"NICHT","pos":"negation","verified":true,"keys":[{"ms":0,"pose":{}}]},
              {"gloss":"WETTER","pos":"noun","verified":true,"keys":[{"ms":0,"pose":{}}]},
              {"gloss":"WIE","pos":"question","verified":true,"keys":[{"ms":0,"pose":{}}]},
              {"gloss":"SCHNEE","pos":"noun","verified":false,"keys":[{"ms":0,"pose":{}}]}
            ],"lemmas":{"regnet":"REGEN","kommt":"KOMMEN","kommen":"KOMMEN"}}"#,
        )
        .unwrap()
    }

    fn glosses(s: &Sentence) -> Vec<String> {
        s.glosses
            .iter()
            .map(|g| match &g.item {
                Item::Sign(x) => x.clone(),
                Item::Spell(x) => format!("buchstabiert:{x}"),
                Item::Digits(x) => format!("zahl:{x}"),
            })
            .collect()
    }

    #[test]
    fn sentences_split_without_breaking_numbers_and_abbreviations() {
        assert_eq!(split_sentences("Hallo Welt. Wie geht es? Gut!"), vec!["Hallo Welt.", "Wie geht es?", "Gut!"]);
        assert_eq!(split_sentences("Es kostet 3.5 Euro und z. B. mehr."), vec!["Es kostet 3.5 Euro und z. B. mehr."]);
        assert_eq!(split_sentences("Zeile eins\nZeile zwei"), vec!["Zeile eins", "Zeile zwei"]);
    }

    #[test]
    fn time_first_verb_late_negation_after_verb() {
        let r = Rules::default_rules();
        let s = &translate("Der Regen kommt heute nicht.", &lex(), &r, false)[0];
        assert_eq!(glosses(s), vec!["HEUTE", "REGEN", "KOMMEN", "NICHT"]);
        assert!(s.glosses[3].negation && !s.glosses[2].negation);
        assert!(!s.text_fallback && s.unknown_ratio == 0.0 && !s.question);
    }

    #[test]
    fn question_word_goes_last_and_marks_the_sentence() {
        let r = Rules::default_rules();
        let s = &translate("Wie ist das Wetter heute?", &lex(), &r, false)[0];
        assert_eq!(glosses(s), vec!["HEUTE", "WETTER", "WIE"]);
        assert!(s.question);
        assert!(translate("Regen heute?", &lex(), &r, false)[0].question); // Fragezeichen allein genügt
    }

    #[test]
    fn unknown_words_are_spelled_and_numbers_become_digits() {
        let r = Rules::default_rules();
        let s = &translate("Müller kommt 12 Uhr", &lex(), &r, false)[0];
        assert_eq!(glosses(s), vec!["buchstabiert:Müller", "zahl:12", "buchstabiert:Uhr", "KOMMEN"]);
        assert!((s.unknown_ratio - 0.5).abs() < 1e-6); // 2 von 4
        assert!(!s.text_fallback); // genau an der Grenze (nicht darüber)
    }

    #[test]
    fn mostly_unknown_sentences_fall_back_to_text_not_to_guessing() {
        let r = Rules::default_rules();
        let s = &translate("Der Bundeskanzler eröffnete die Ausstellung heute", &lex(), &r, false)[0];
        assert!(s.text_fallback);
        assert!(s.unknown_ratio > 0.5);
    }

    #[test]
    fn unverified_signs_count_as_unknown_unless_allowed() {
        let r = Rules::default_rules();
        let strict = &translate("Schnee", &lex(), &r, false)[0];
        assert_eq!(glosses(strict), vec!["buchstabiert:Schnee"]);
        let lax = &translate("Schnee", &lex(), &r, true)[0];
        assert_eq!(glosses(lax), vec!["SCHNEE"]);
    }

    #[test]
    fn filler_words_vanish_but_a_sign_in_the_lexicon_beats_the_drop_list() {
        let r = Rules::default_rules();
        assert!(translate("Der die das ist", &lex(), &r, false).is_empty());
    }

    #[test]
    fn rules_file_is_validated() {
        assert!(Rules::from_json("{").is_err());
        assert!(Rules::from_json(r#"{"version":1,"drop":[],"timeWords":[],"negations":[],"questionWords":[],"maxUnknownRatio":2}"#).is_err());
        assert!(Rules::from_json(r#"{"version":1,"drop":["x"]}"#).is_err());
    }
}
