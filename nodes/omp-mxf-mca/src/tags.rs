//! MCA-Labels → Tags der Audio-Regeln (`omp-audio-rules`). Die Tags folgen
//! dem dortigen Schema `schlüssel:wert` (nicht groß-/kleinschreibungsempfindlich).
//!
//! | Tag | Quelle |
//! |---|---|
//! | `mca` | Kanal trägt ein MCA-Label |
//! | `ch:<Symbol>` | Dictionary-Symbol des Kanal-Labels (L, R, C, LFE, Ls, Rs, M1, NSC025 …) |
//! | `lang:<RFC 5646>` | effektive Spoken Language |
//! | `langattr:original\|dubbed` | MCA Spoken Language Attribute |
//! | `content:<X>` / `useclass:<X>` / `subtype:<X>` | ST 377-41 Vokabular |
//! | `sg:<Symbol>` / `gsg:<Symbol>` | Dictionary-Symbol der Soundfield Group / der Gruppen |
//! | `role:ad` | Content DV oder VI, oder Kanal-Label VIN (Hörfilm / Audiodeskription) |
//! | `role:hi` | Content HI oder Kanal-Label HI |
//! | `role:pt` | Content PRM oder SAP (Programmton) |
//!
//! Mehr wird bewusst nicht in `role:` übersetzt — wo die Normwerte keine
//! eindeutige Entsprechung haben (z. B. „Originalton“), wählen Ausdrücke wie
//! `content:PRM AND lang:de AND langattr:original`.

use crate::model::ChannelSummary;

pub fn channel_tags(c: &ChannelSummary) -> Vec<String> {
    let mut t = vec!["mca".to_string()];
    let mut add = |s: String| {
        if !t.contains(&s) {
            t.push(s);
        }
    };
    if let Some(sym) = &c.label.dictionary_symbol {
        add(format!("ch:{sym}"));
    }
    let it = &c.label.items;
    if let Some(l) = it.spoken_language.as_deref().filter(|l| !l.is_empty()) {
        add(format!("lang:{l}"));
    }
    if let Some(a) = &it.spoken_language_attribute {
        add(format!("langattr:{}", a.to_ascii_lowercase()));
    }
    if let Some(v) = &it.content {
        add(format!("content:{v}"));
    }
    if let Some(v) = &it.use_class {
        add(format!("useclass:{v}"));
    }
    if let Some(v) = &it.content_subtype {
        add(format!("subtype:{v}"));
    }
    if let Some(sg) = &c.soundfield_group {
        add(format!("sg:{}", sg.dictionary_symbol.as_deref().unwrap_or(&sg.symbol)));
    }
    for g in &c.groups {
        add(format!("gsg:{}", g.dictionary_symbol.as_deref().unwrap_or(&g.symbol)));
    }
    let content = it.content.as_deref();
    if matches!(content, Some("DV" | "VI")) || c.label.dictionary_symbol.as_deref() == Some("VIN") {
        add("role:ad".into());
    }
    if content == Some("HI") || c.label.dictionary_symbol.as_deref() == Some("HI") {
        add("role:hi".into());
    }
    if matches!(content, Some("PRM" | "SAP")) {
        add("role:pt".into());
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::label_ul;
    use crate::model::LabelKind::{AudioChannel, GroupOfSoundfieldGroups, SoundfieldGroup};
    use crate::model::SoundDescriptor;
    use crate::testkit::{channel, group, uid};

    #[test]
    fn tags_from_inherited_values() {
        let mut ch = channel("chL", label_ul(1, 1, 0, 0), 1, 1, Some(20));
        ch.items.spoken_language = Some("de".into());
        let mut sg = group(SoundfieldGroup, "sgST", label_ul(2, 0x20, 1, 0), 20, &[30]);
        sg.items.content = Some("PRM".into());
        sg.items.use_class = Some("FCMP".into());
        let mut gsg = group(GroupOfSoundfieldGroups, "MPg", label_ul(3, 0x20, 1, 0), 30, &[]);
        gsg.items.spoken_language_attribute = Some("ORIGINAL".into());
        let vin = channel("chVIN", label_ul(1, 0x0F, 0, 0), 2, 2, None);
        let file = crate::McaFile {
            descriptors: vec![SoundDescriptor { instance_uid: uid(0xD0), set_kind: crate::keys::SET_WAVE_AUDIO_DESCRIPTOR, linked_track_id: Some(1), channel_count: 2, labels: vec![ch, vin, sg, gsg] }],
        };
        let sum = file.summarize();
        let l = channel_tags(&sum.channels[0]);
        for want in ["mca", "ch:L", "lang:de", "langattr:original", "content:PRM", "useclass:FCMP", "sg:ST", "gsg:MPg", "role:pt"] {
            assert!(l.iter().any(|t| t == want), "{want} fehlt in {l:?}");
        }
        let v = channel_tags(&sum.channels[1]);
        assert!(v.contains(&"role:ad".to_string()) && v.contains(&"ch:VIN".to_string()), "{v:?}");
        assert!(!v.contains(&"role:pt".to_string()));
        let _ = AudioChannel;
    }
}
