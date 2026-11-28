//! Playlist als Datei (Panel „Laden / Anhängen / Speichern“): Parameter `playlistDocument` liefert die
//! komplette Liste, die Methode `playlist.import` liest sie wieder ein (`replace` | `append`).
//!
//! Format = die Item-Einträge des Persistenz-Snapshots (`persist::SnapItem`), damit nichts verloren geht
//! (Children, Audio, Asset-Bezug, Fixzeiten). Item-IDs gelten nur innerhalb der Datei: beim Einlesen
//! werden neue vergeben und Sprungziele mitgezogen.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::persist::SnapItem;
use crate::{AutomationState, AutomationStore, ItemMedia};

const FORMAT: &str = "omp-playlist";
const VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct Document {
    format: String,
    version: u32,
    items: Vec<SnapItem>,
}

pub fn export(state: &AutomationState) -> String {
    let items = state
        .playlist
        .items()
        .iter()
        .filter_map(|id| state.metadata.get(id).map(|m| SnapItem { id: id.clone(), meta: m.clone() }))
        .collect();
    let doc = Document { format: FORMAT.to_string(), version: VERSION, items };
    serde_json::to_string(&doc).unwrap_or_default()
}

/// Prüft die Datei vollständig, bevor irgendetwas am Zustand geändert wird.
fn parse(json: &str) -> Result<Vec<SnapItem>, String> {
    let mut doc: Document = serde_json::from_str(json).map_err(|e| format!("keine gültige Playlist-Datei: {e}"))?;
    if doc.format != FORMAT || doc.version != VERSION {
        return Err(format!("Format „{}“ Version {} wird nicht unterstützt (erwartet {FORMAT} Version {VERSION})", doc.format, doc.version));
    }
    let mut ids = HashSet::new();
    if let Some(it) = doc.items.iter().find(|it| !ids.insert(it.id.clone())) {
        return Err(format!("Item-ID „{}“ kommt doppelt vor", it.id));
    }
    for (n, it) in doc.items.iter_mut().enumerate() {
        if let ItemMedia::Jump { target_id } = &it.meta.media
            && (*target_id == it.id || !ids.contains(target_id))
        {
            return Err(format!("Item {n}: Sprungziel „{target_id}“ ungültig"));
        }
        for c in &mut it.meta.children {
            c.validate().map_err(|e| format!("Item {n}, Child „{}“: {e}", c.id))?;
        }
    }
    Ok(doc.items)
}

impl AutomationStore {
    pub(crate) fn do_import_playlist(&self, json: &str, mode: &str) -> Result<(), String> {
        let append = match mode {
            "append" => true,
            "replace" => false,
            other => return Err(format!("mode „{other}“ unbekannt (replace | append)")),
        };
        let items = parse(json)?;
        import(&mut self.state.lock().expect("lock poisoned"), items, append);
        Ok(())
    }
}

fn import(state: &mut AutomationState, items: Vec<SnapItem>, append: bool) {
    let mut new_ids = HashMap::with_capacity(items.len());
    for it in &items {
        state.next_item_seq += 1;
        new_ids.insert(it.id.clone(), format!("item{}", state.next_item_seq));
    }
    let mut ids = Vec::with_capacity(items.len());
    let mut metadata = HashMap::with_capacity(items.len());
    for SnapItem { id, mut meta } in items {
        if let ItemMedia::Jump { target_id } = &mut meta.media {
            *target_id = new_ids[target_id.as_str()].clone();
        }
        let id = new_ids[&id].clone();
        metadata.insert(id.clone(), meta);
        ids.push(id);
    }
    if append {
        // Anhängen ändert bestehende Indizes nicht, der Zeitplan-Cache bleibt gültig.
        for id in ids {
            state.playlist.append(id);
        }
        state.metadata.extend(metadata);
    } else {
        crate::replace_playlist(state, ids, metadata, "Playlist ersetzt (Datei)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> AutomationState {
        AutomationState::new(String::new(), String::new(), String::new(), String::new())
    }

    const DOC: &str = r#"{"format":"omp-playlist","version":1,"items":[
        {"id":"x","meta":{"label":"Clip","media":{"kind":"file","path":"a.mp4"},"duration_ms":5000,"start_type":"sequence","fixtime_hms":null,"transition":"cut","transition_rate_frames":null,"children":[]}},
        {"id":"y","meta":{"label":"Loop","media":{"kind":"jump","target_id":"x"},"duration_ms":0,"start_type":"sequence","fixtime_hms":null,"transition":"cut","transition_rate_frames":null,"children":[]}}]}"#;

    fn labels(st: &AutomationState) -> Vec<String> {
        st.playlist.items().iter().map(|id| st.metadata[id].label.clone()).collect()
    }

    #[test]
    fn append_keeps_existing_items_and_remaps_jump_targets() {
        let mut st = state();
        import(&mut st, parse(DOC).unwrap(), false);
        import(&mut st, parse(DOC).unwrap(), true);
        assert_eq!(labels(&st), ["Clip", "Loop", "Clip", "Loop"]);
        let ids = st.playlist.items().to_vec();
        assert!(matches!(&st.metadata[&ids[3]].media, ItemMedia::Jump { target_id } if *target_id == ids[2]));
    }

    #[test]
    fn export_then_replace_is_lossless() {
        let mut st = state();
        import(&mut st, parse(DOC).unwrap(), false);
        let saved = export(&st);
        import(&mut st, parse(&saved).unwrap(), false);
        assert_eq!(labels(&st), ["Clip", "Loop"]);
        assert_eq!(st.metadata.len(), 2);
    }

    #[test]
    fn broken_files_are_rejected() {
        assert!(parse("{}").is_err());
        assert!(parse(&DOC.replace("\"version\":1", "\"version\":2")).is_err());
        assert!(parse(&DOC.replace("\"target_id\":\"x\"", "\"target_id\":\"missing\"")).is_err());
        assert!(parse(&DOC.replace("\"id\":\"y\"", "\"id\":\"x\"")).is_err());
    }
}
