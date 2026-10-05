//! Ansicht des gemeinsamen Audio-Dokuments (`omp-audio-rules`, docs/ENTWURF-AUDIO-REGELN.md, A8) für
//! die Parameter und das UI dieses Nodes: Programmgruppen und „Shuffle-Presets“ (jetzt Zuordnungs-
//! vorlagen). Die Matrizen berechnet die Engine (`omp_audio_rules::resolve`); hier stehen nur die
//! Datentypen der bisherigen Parameter `programGroups`/`shufflePresets` und die Umrechnung aus dem
//! Dokument. Die frühere feste Preset-Tabelle (13 ORF-Status) und `matrix_for` entfallen — die
//! ORF-Presets sind als mitgelieferte Vorlagen im Dokument enthalten (`omp_audio_rules::defaults`).

use omp_audio_rules::AudioSettings;
use serde::{Deserialize, Serialize};

/// Eine dauerhaft aktive Audio-Ausgangsgruppe (ein NMOS-Sender), Kanalzahl aus dem Layout.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProgramGroup {
    pub id: String,
    pub label: String,
    pub channels: u32,
}

/// Eine Route ordnet EINE Quell-Tonspur (1-basiert) einem Ausgabekanal einer Gruppe zu — nur zur Anzeige
/// im Referenz-Panel; Vorlagen mit Tag-Auswahl haben keine festen Routen.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Route {
    #[serde(rename = "srcTrack")]
    pub src_track: u8,
    pub group: String,
    #[serde(rename = "groupChannel")]
    pub group_channel: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioPreset {
    pub id: String,
    pub label: String,
    pub routes: Vec<Route>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub groups: Vec<ProgramGroup>,
    pub presets: Vec<AudioPreset>,
}

/// Gruppen und Vorlagen des Dokuments in die Parameter-Sicht dieses Nodes umrechnen.
pub fn from_audio_settings(doc: &AudioSettings) -> Settings {
    let groups = doc
        .output_profile
        .groups
        .iter()
        .map(|g| ProgramGroup { id: g.id.clone(), label: g.label.clone(), channels: g.channel_names().len() as u32 })
        .collect();
    let presets = doc
        .mappings
        .iter()
        .map(|m| {
            let mut routes = Vec::new();
            for (gid, spec) in &m.groups {
                for (channel, &track) in spec.tracks.iter().flatten().enumerate() {
                    if track > 0 {
                        routes.push(Route { src_track: track.min(255) as u8, group: gid.clone(), group_channel: channel as u8 });
                    }
                }
            }
            AudioPreset { id: m.id.clone(), label: if m.label.is_empty() { m.id.clone() } else { m.label.clone() }, routes }
        })
        .collect();
    Settings { groups, presets }
}

pub fn find_preset<'a>(presets: &'a [AudioPreset], id: &str) -> Option<&'a AudioPreset> {
    presets.iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> Settings {
        from_audio_settings(&omp_audio_rules::defaults::default_settings())
    }

    #[test]
    fn default_document_has_five_groups_and_thirteen_presets() {
        let s = defaults();
        assert_eq!(s.groups.len(), 5);
        assert_eq!(s.presets.len(), 13);
        assert_eq!(s.groups.iter().find(|g| g.id == "surround51").unwrap().channels, 6);
    }

    #[test]
    fn find_preset_finds_by_id_and_none_for_unknown() {
        let s = defaults();
        assert!(find_preset(&s.presets, "stereo").is_some());
        assert!(find_preset(&s.presets, "does-not-exist").is_none());
    }

    #[test]
    fn stereo_preset_shows_the_two_program_routes() {
        let s = defaults();
        let p = find_preset(&s.presets, "stereo").unwrap();
        let mut r: Vec<(u8, &str, u8)> = p.routes.iter().map(|r| (r.src_track, r.group.as_str(), r.group_channel)).collect();
        r.sort();
        assert_eq!(r, vec![(1, "pt", 0), (2, "pt", 1)]);
    }
}
