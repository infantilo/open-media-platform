//! Wörterbücher: Label-Dictionary-IDs (ST 428-12, ST 2067-8) und das
//! kontrollierte Vokabular für MCA-Items (ST 377-41:2023).

use crate::keys::{Ul, label_ul};
use crate::model::McaItems;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Facet {
    Channel,
    SoundfieldGroup,
    GroupOfSoundfieldGroups,
}

#[derive(Debug, Clone, Copy)]
pub struct LabelDef {
    pub facet: Facet,
    pub ul: Ul,
    pub symbol: &'static str,
    pub name: &'static str,
    /// Quelle: "428-12" oder "2067-8".
    pub source: &'static str,
}

const fn d(facet: Facet, ul: Ul, symbol: &'static str, name: &'static str, source: &'static str) -> LabelDef {
    LabelDef { facet, ul, symbol, name, source }
}

use Facet::{Channel as C, GroupOfSoundfieldGroups as G, SoundfieldGroup as S};

/// Alle bekannten Label-Dictionary-IDs.
pub const LABELS: &[LabelDef] = &[
    // ST 428-12 Tab. 1 (Byte 12 = Kanal)
    d(C, label_ul(1, 0x01, 0, 0), "L", "Left", "428-12"),
    d(C, label_ul(1, 0x02, 0, 0), "R", "Right", "428-12"),
    d(C, label_ul(1, 0x03, 0, 0), "C", "Center", "428-12"),
    d(C, label_ul(1, 0x04, 0, 0), "LFE", "LFE", "428-12"),
    d(C, label_ul(1, 0x05, 0, 0), "Ls", "Left Surround", "428-12"),
    d(C, label_ul(1, 0x06, 0, 0), "Rs", "Right Surround", "428-12"),
    d(C, label_ul(1, 0x07, 0, 0), "Lss", "Left Side Surround", "428-12"),
    d(C, label_ul(1, 0x08, 0, 0), "Rss", "Right Side Surround", "428-12"),
    d(C, label_ul(1, 0x09, 0, 0), "Lrs", "Left Rear Surround", "428-12"),
    d(C, label_ul(1, 0x0A, 0, 0), "Rrs", "Right Rear Surround", "428-12"),
    d(C, label_ul(1, 0x0B, 0, 0), "Lc", "Left Center", "428-12"),
    d(C, label_ul(1, 0x0C, 0, 0), "Rc", "Right Center", "428-12"),
    d(C, label_ul(1, 0x0D, 0, 0), "Cs", "Center Surround", "428-12"),
    d(C, label_ul(1, 0x0E, 0, 0), "HI", "Hearing Impaired", "428-12"),
    d(C, label_ul(1, 0x0F, 0, 0), "VIN", "Visually Impaired - Narrative", "428-12"),
    // ST 2067-8 Tab. 1 (Byte 12 = 20h, Byte 13 = Kanal)
    d(C, label_ul(1, 0x20, 0x01, 0), "M1", "Mono One", "2067-8"),
    d(C, label_ul(1, 0x20, 0x02, 0), "M2", "Mono Two", "2067-8"),
    d(C, label_ul(1, 0x20, 0x03, 0), "Lt", "Left Total", "2067-8"),
    d(C, label_ul(1, 0x20, 0x04, 0), "Rt", "Right Total", "2067-8"),
    d(C, label_ul(1, 0x20, 0x05, 0), "Lst", "Left Surround Total", "2067-8"),
    d(C, label_ul(1, 0x20, 0x06, 0), "Rst", "Right Surround Total", "2067-8"),
    d(C, label_ul(1, 0x20, 0x07, 0), "S", "Surround", "2067-8"),
    // ST 428-12 Tab. 3 (Soundfield Groups, Byte 12)
    d(S, label_ul(2, 0x01, 0, 0), "51", "5.1", "428-12"),
    d(S, label_ul(2, 0x02, 0, 0), "71", "7.1DS", "428-12"),
    d(S, label_ul(2, 0x03, 0, 0), "SDS", "7.1SDS", "428-12"),
    d(S, label_ul(2, 0x04, 0, 0), "61", "6.1", "428-12"),
    d(S, label_ul(2, 0x05, 0, 0), "M", "1.0 Monaural", "428-12"),
    // ST 2067-8 Tab. 3 (Byte 12 = 20h, Byte 13 = Gruppe)
    d(S, label_ul(2, 0x20, 0x01, 0), "ST", "Standard Stereo", "2067-8"),
    d(S, label_ul(2, 0x20, 0x02, 0), "DM", "Dual Mono", "2067-8"),
    d(S, label_ul(2, 0x20, 0x03, 0), "DNS", "Discrete Numbered Sources", "2067-8"),
    d(S, label_ul(2, 0x20, 0x04, 0), "30", "3.0", "2067-8"),
    d(S, label_ul(2, 0x20, 0x05, 0), "40", "4.0", "2067-8"),
    d(S, label_ul(2, 0x20, 0x06, 0), "50", "5.0", "2067-8"),
    d(S, label_ul(2, 0x20, 0x07, 0), "60", "6.0", "2067-8"),
    d(S, label_ul(2, 0x20, 0x08, 0), "70", "7.0DS", "2067-8"),
    d(S, label_ul(2, 0x20, 0x09, 0), "LtRt", "Lt-Rt", "2067-8"),
    d(S, label_ul(2, 0x20, 0x0A, 0), "51EX", "5.1 EX", "2067-8"),
    d(S, label_ul(2, 0x20, 0x0B, 0), "HA", "Hearing Accessibility", "2067-8"),
    d(S, label_ul(2, 0x20, 0x0C, 0), "VA", "Visual Accessibility", "2067-8"),
    // ST 2067-8 Tab. 5 (Gruppen von Soundfield Groups)
    d(G, label_ul(3, 0x20, 0x01, 0), "MPg", "Main Program", "2067-8"),
    d(G, label_ul(3, 0x20, 0x02, 0), "DVS", "Descriptive Video Service", "2067-8"),
    d(G, label_ul(3, 0x20, 0x03, 0), "Dcm", "Dialog Centric Mix", "2067-8"),
];

pub fn lookup_label(ul: &Ul) -> Option<&'static LabelDef> {
    LABELS.iter().find(|l| &l.ul == ul)
}

/// Numerierter Quellkanal NSC001–NSC127 (ST 2067-8 Tab. 1: Byte 12 = 20h,
/// Byte 13 = 08h, Byte 14 = Nummer).
pub fn nsc_channel(ul: &Ul) -> Option<u8> {
    let base = label_ul(1, 0x20, 0x08, 0);
    (ul[..13] == base[..13] && ul[13] >= 1 && ul[13] <= 127 && ul[14] == 0 && ul[15] == 0).then_some(ul[13])
}

// ------------------------------------------------------------ ST 377-41

pub const PARTITION_KINDS: &[&str] = &["FL", "REEL", "ACT", "PART"];
pub const CONTENTS: &[&str] = &[
    "PRM", "SAP", "HI", "DV", "DX", "MX", "FX", "FFX", "ME", "OP", "MESP", "DME", "NDME", "PNAR", "ONAR", "VO", "VI", "CM", "LCM", "MOS",
    "ADR", "GRP", "WLA", "CRD", "VOC", "FOL", "BG",
];
pub const USE_CLASSES: &[&str] = &["FCMP", "ICMP", "SMPL", "SING"];
pub const CONTENT_SUBTYPES: &[&str] = &["DIR", "TECH", "WRT", "CAST", "ANN", "CTR", "FS", "PRP", "CL", "OTHER"];
pub const LANGUAGE_ATTRIBUTES: &[&str] = &["ORIGINAL", "DUBBED"];

/// Erlaubte Use Classes je Content (Tab. 4, über die Superscript-Zuordnung
/// Tab. 5 aufgelöst). `None`: Content hat in Tab. 4 nur ein einzelnes X ohne
/// Superscript (HI, DV, PNAR, ONAR, LCM, VO, VI, MOS) — die Spalte ist im
/// Text nicht eindeutig lesbar, daher nicht eingeschränkt.
pub fn allowed_use_classes(content: &str) -> Option<&'static [&'static str]> {
    Some(match content {
        "PRM" | "SAP" => &["FCMP", "SMPL"],
        "CM" => &["FCMP", "SING"],
        "DX" | "MX" | "FX" | "ME" | "OP" | "MESP" | "DME" | "NDME" | "FFX" | "VOC" => &["ICMP", "SMPL"],
        "ADR" | "GRP" | "CRD" | "WLA" | "FOL" | "BG" => &["ICMP"],
        _ => return None,
    })
}

/// Benutzerdefinierter Content: `x-` gefolgt von 1–4 Zeichen.
pub fn is_custom_content(s: &str) -> bool {
    s.strip_prefix("x-").is_some_and(|r| (1..=4).contains(&r.chars().count()))
}

fn split_ws(s: &str) -> Vec<&str> {
    s.split([' ', '\t', '\r', '\n']).filter(|x| !x.is_empty()).collect()
}

/// Prüft die ST-377-41-Regeln und die Abhängigkeiten aus ST 377-4 §6.3 für
/// die Items EINES Labels; liefert verständliche Hinweise (leer = ok).
pub fn validate_items(it: &McaItems) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(k) = &it.partition_kind
        && !PARTITION_KINDS.contains(&k.as_str())
    {
        out.push(format!("MCA Partition Kind „{k}“ ist nicht im Vokabular (FL, REEL, ACT, PART)"));
    }
    match (&it.partition_kind, &it.partition_number) {
        (Some(_), None) | (None, Some(_)) => out.push("MCA Partition Kind und Partition Number müssen gemeinsam vorhanden sein".into()),
        (Some(k), Some(n)) if k == "FL" && n != "1" => out.push("bei Partition Kind FL muss die Partition Number 1 sein".into()),
        _ => {}
    }
    if let Some(n) = &it.partition_number
        && !n.chars().all(|c| c.is_ascii_alphanumeric())
    {
        out.push("MCA Partition Number darf nur aus 0-9, A-Z, a-z bestehen".into());
    }
    if let Some(c) = &it.content
        && !CONTENTS.contains(&c.as_str())
        && !is_custom_content(c)
    {
        out.push(format!("MCA Content „{c}“ ist nicht im Vokabular (ST 377-41 Tab. 2)"));
    }
    if let Some(u) = &it.use_class
        && !USE_CLASSES.contains(&u.as_str())
    {
        out.push(format!("MCA Use Class „{u}“ ist nicht im Vokabular (FCMP, ICMP, SMPL, SING)"));
    }
    match (&it.content, &it.use_class) {
        (Some(_), None) => out.push("MCA Content darf nur zusammen mit MCA Use Class vorkommen".into()),
        (None, Some(_)) => out.push("MCA Use Class darf nur zusammen mit MCA Content vorkommen".into()),
        (Some(c), Some(u)) => {
            if let Some(allowed) = allowed_use_classes(c)
                && !allowed.contains(&u.as_str())
            {
                out.push(format!("MCA Content {c} erlaubt nur die Use Class {} (Tab. 4)", allowed.join("/")));
            }
        }
        _ => {}
    }
    if let Some(s) = &it.content_subtype
        && !CONTENT_SUBTYPES.contains(&s.as_str())
    {
        out.push(format!("MCA Content Subtype „{s}“ ist nicht im Vokabular (Tab. 6)"));
    }
    if matches!(it.content.as_deref(), Some("CM" | "LCM")) && it.content_subtype.is_none() {
        out.push("bei MCA Content CM/LCM ist ein MCA Content Subtype Pflicht".into());
    }
    if it.audio_content_kind.is_some() || it.audio_element_kind.is_some() {
        out.push("MCA Audio Content Kind / Element Kind sind veraltet (durch Content/Use Class ersetzt) und sollen nicht vorhanden sein".into());
    }
    if let Some(a) = &it.spoken_language_attribute {
        if !LANGUAGE_ATTRIBUTES.contains(&a.as_str()) {
            out.push(format!("MCA Spoken Language Attribute „{a}“ ist nicht ORIGINAL/DUBBED"));
        }
        if it.spoken_language.as_deref().is_none_or(str::is_empty) {
            out.push("MCA Spoken Language Attribute setzt eine RFC 5646 Spoken Language voraus".into());
        }
    }
    if it.additional_languages.is_some() && it.spoken_language.as_deref().is_none_or(str::is_empty) {
        out.push("RFC 5646 Additional Spoken Languages setzt eine RFC 5646 Spoken Language voraus".into());
    }
    if let Some(attrs) = &it.additional_language_attributes {
        let langs = split_ws(it.additional_languages.as_deref().unwrap_or(""));
        let a = split_ws(attrs);
        if langs.is_empty() {
            out.push("MCA Additional Language Attributes setzt Additional Spoken Languages voraus".into());
        } else if a.len() != langs.len() {
            out.push("MCA Additional Language Attributes braucht je Zusatzsprache genau einen Eintrag".into());
        }
        if a.iter().any(|x| !LANGUAGE_ATTRIBUTES.contains(x)) {
            out.push("MCA Additional Language Attributes dürfen nur ORIGINAL/DUBBED enthalten".into());
        }
    }
    out
}

/// MCA Tag Symbol: 2–8 alphanumerische Zeichen, beginnt mit einem Buchstaben (ST 377-4 §6.3.3).
pub fn valid_tag_symbol(s: &str) -> bool {
    let n = s.chars().count();
    (2..=8).contains(&n) && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && s.chars().all(|c| c.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictionary_lookup_and_nsc() {
        let l = lookup_label(&label_ul(1, 0x03, 0, 0)).unwrap();
        assert_eq!((l.symbol, l.name), ("C", "Center"));
        assert_eq!(lookup_label(&label_ul(2, 0x20, 0x01, 0)).unwrap().symbol, "ST");
        assert_eq!(lookup_label(&label_ul(3, 0x20, 0x03, 0)).unwrap().symbol, "Dcm");
        assert!(lookup_label(&label_ul(1, 0x77, 0, 0)).is_none());
        assert_eq!(nsc_channel(&label_ul(1, 0x20, 0x08, 25)), Some(25));
        assert_eq!(nsc_channel(&label_ul(1, 0x20, 0x08, 0)), None);
        // keine doppelten ULs
        for (i, a) in LABELS.iter().enumerate() {
            assert!(LABELS[i + 1..].iter().all(|b| a.ul != b.ul), "doppelt: {}", a.symbol);
        }
    }

    #[test]
    fn vocabulary_rules() {
        let ok = McaItems { content: Some("DX".into()), use_class: Some("ICMP".into()), spoken_language: Some("de".into()), spoken_language_attribute: Some("ORIGINAL".into()), ..Default::default() };
        assert!(validate_items(&ok).is_empty(), "{:?}", validate_items(&ok));
        let bad = McaItems { content: Some("DX".into()), use_class: Some("FCMP".into()), ..Default::default() };
        assert!(validate_items(&bad).iter().any(|m| m.contains("erlaubt nur")));
        let half = McaItems { content: Some("PRM".into()), ..Default::default() };
        assert!(validate_items(&half).iter().any(|m| m.contains("zusammen")));
        let cm = McaItems { content: Some("CM".into()), use_class: Some("SING".into()), ..Default::default() };
        assert!(validate_items(&cm).iter().any(|m| m.contains("Subtype")));
        let attr = McaItems { spoken_language_attribute: Some("DUBBED".into()), ..Default::default() };
        assert!(validate_items(&attr).iter().any(|m| m.contains("Spoken Language voraus")));
        let custom = McaItems { content: Some("x-ab".into()), use_class: Some("SING".into()), ..Default::default() };
        assert!(validate_items(&custom).is_empty());
        let fl = McaItems { partition_kind: Some("FL".into()), partition_number: Some("2".into()), ..Default::default() };
        assert!(validate_items(&fl).iter().any(|m| m.contains("Number 1")));
        assert!(valid_tag_symbol("chL") && valid_tag_symbol("sg51") && !valid_tag_symbol("5.1") && !valid_tag_symbol("a") && !valid_tag_symbol("abcdefghi"));
    }
}
