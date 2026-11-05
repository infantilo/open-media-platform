//! Audio- und Bildmischer aus den Vorgaben des Channels einrichten (Vertrag: docs/CONTRACT-MIXER-SETUP.md).
//!
//! Der Channel legt im Audio-Ausgabe-Dokument fest, welche Programme (Ausgabegruppen: Programmton,
//! Hörfilm, Originalton, Dolby E, 5.1 …) seine Player ausgeben. Jede Gruppe ist ein eigener Sender der
//! Player. Für jede Kombination Player × Gruppe braucht der Tonmischer einen Kanal, dessen Quelle dieser
//! Sender ist und der dem Bild des jeweiligen Players folgt („Audio folgt Video“).
//!
//! Der Plan ist rein additiv und wiederholbar: ein Kanal, dessen Quelle schon ein Mischerkanal nutzt (oder
//! dessen Name schon vergeben ist), wird nie angefasst oder doppelt angelegt; es wird nichts gelöscht.

use serde_json::Value;

/// Ausgabegruppe aus dem Audio-Ausgabe-Dokument des Channels.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub label: String,
    /// Tags der Gruppe in der Schreibweise des Dokuments (`role:pt`).
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlayerSender {
    pub id: String,
    pub label: String,
    /// Entdeckte Tags der Registry (`role.pt`).
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Player {
    pub label: String,
    pub node_id: String,
    pub senders: Vec<PlayerSender>,
}

/// Ein vorhandener Mischerkanal.
#[derive(Debug, Clone, PartialEq)]
pub struct Existing {
    pub label: String,
    pub source: String,
}

/// Ein anzulegender Kanal.
#[derive(Debug, Clone, PartialEq)]
pub struct Wanted {
    pub label: String,
    pub sender_id: String,
    /// Node, dessen Bild den Kanal öffnet.
    pub follow_node_id: String,
}

fn norm(tag: &str) -> String {
    tag.replace(':', ".")
}

/// Gruppen aus dem Dokument (`outputProfile.groups`); Gruppen ohne Tags kann niemand zuordnen.
pub fn groups_from_doc(doc: &Value) -> Vec<Group> {
    let groups = doc
        .pointer("/rules/outputProfile/groups")
        .or_else(|| doc.pointer("/outputProfile/groups"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    groups
        .iter()
        .filter_map(|g| {
            let label = g.get("label").and_then(Value::as_str).or_else(|| g.get("id").and_then(Value::as_str))?.to_string();
            let tags: Vec<String> = g.get("tags")?.as_array()?.iter().filter_map(|t| t.as_str().map(str::to_string)).collect();
            (!tags.is_empty()).then_some(Group { label, tags })
        })
        .collect()
}

/// Welche Kanäle fehlen noch? Reihenfolge: je Player alle Gruppen in Dokumentreihenfolge.
pub fn plan(groups: &[Group], players: &[Player], existing: &[Existing]) -> Vec<Wanted> {
    let mut taken_sources: Vec<&str> = existing.iter().map(|e| e.source.as_str()).filter(|s| !s.is_empty()).collect();
    let mut taken_labels: Vec<String> = existing.iter().map(|e| e.label.clone()).collect();
    let mut out = Vec::new();
    for p in players {
        for g in groups {
            // Maßgeblich sind die Rollen-Tags (`role:pt`); Eigenschaften wie `bitexact` tragen die Sender nicht.
            let all: Vec<String> = g.tags.iter().map(|t| norm(t)).collect();
            let roles: Vec<String> = all.iter().filter(|t| t.starts_with("role.")).cloned().collect();
            let want = if roles.is_empty() { all } else { roles };
            // Der Sender, der alle Tags der Gruppe trägt (Registry-Tags `role.pt`).
            let Some(s) = p.senders.iter().find(|s| want.iter().all(|w| s.tags.iter().any(|t| norm(t) == *w))) else { continue };
            let label = format!("{} {}", p.label, g.label);
            if taken_sources.contains(&s.id.as_str()) || taken_labels.contains(&label) {
                continue;
            }
            taken_sources.push(&s.id);
            taken_labels.push(label.clone());
            out.push(Wanted { label, sender_id: s.id.clone(), follow_node_id: p.node_id.clone() });
        }
    }
    out
}

/// Welche der Player-Video-Sender sind im Bildmischer noch nicht angeheftet?
pub fn plan_video(senders: &[String], pinned: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in senders {
        if !pinned.contains(s) && !out.contains(s) {
            out.push(s.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn player(label: &str, node: &str) -> Player {
        let s = |id: &str, tag: &str| PlayerSender { id: format!("{label}-{id}"), label: id.to_string(), tags: vec![tag.to_string()] };
        Player { label: label.into(), node_id: node.into(), senders: vec![s("pt", "role.pt"), s("ad", "role.ad"), s("ot", "role.ot")] }
    }

    fn groups() -> Vec<Group> {
        groups_from_doc(&json!({"rules": {"outputProfile": {"groups": [
            {"id": "pt", "label": "Stereo Programmton", "tags": ["role:pt"]},
            {"id": "ad", "label": "Stereo Audiodescription", "tags": ["role:ad"]},
            {"id": "x", "label": "ohne Tags"},
            {"id": "ot", "label": "Stereo Originalton", "tags": ["role:ot"]},
            {"id": "dolbye", "label": "Dolby E", "tags": ["role:dolbye", "bitexact"]},
        ]}}}))
    }

    #[test]
    fn video_pins_only_missing_sources() {
        let all = vec!["a".to_string(), "b".to_string()];
        assert_eq!(plan_video(&all, &["a".to_string()]), vec!["b".to_string()]);
        assert!(plan_video(&all, &all).is_empty());
    }

    #[test]
    fn groups_without_tags_are_dropped() {
        assert_eq!(groups().len(), 4);
        assert_eq!(groups_from_doc(&json!({})).len(), 0);
    }

    #[test]
    fn every_player_and_group_gets_a_channel() {
        let p = plan(&groups(), &[player("Player A", "na"), player("Player B", "nb")], &[]);
        let labels: Vec<_> = p.iter().map(|w| w.label.as_str()).collect();
        // Dolby E hat in diesen Test-Playern keinen Sender → kein Kanal.
        assert_eq!(labels.len(), 6);
        assert_eq!(labels[0], "Player A Stereo Programmton");
        assert_eq!(p[0].follow_node_id, "na");
        assert_eq!(p[3].follow_node_id, "nb");
        assert_eq!(p[0].sender_id, "Player A-pt");
    }

    #[test]
    fn modifier_tags_do_not_block_the_match() {
        let mut p = player("Player A", "na");
        p.senders.push(PlayerSender { id: "dolby".into(), label: "Dolby E".into(), tags: vec!["role.dolbye".into()] });
        let w = plan(&groups(), &[p], &[]);
        assert!(w.iter().any(|w| w.label == "Player A Dolby E" && w.sender_id == "dolby"));
    }

    #[test]
    fn existing_channels_are_never_duplicated() {
        let ex = [
            Existing { label: "Mein Name".into(), source: "Player A-pt".into() },
            Existing { label: "Player B Stereo Originalton".into(), source: String::new() },
        ];
        let p = plan(&groups(), &[player("Player A", "na"), player("Player B", "nb")], &ex);
        assert_eq!(p.len(), 4);
        assert!(p.iter().all(|w| w.sender_id != "Player A-pt" && w.label != "Player B Stereo Originalton"));
        // Zweiter Lauf ohne Änderung: nichts mehr zu tun.
        let again: Vec<Existing> = ex.iter().cloned().chain(p.iter().map(|w| Existing { label: w.label.clone(), source: w.sender_id.clone() })).collect();
        assert!(plan(&groups(), &[player("Player A", "na"), player("Player B", "nb")], &again).is_empty());
    }
}
