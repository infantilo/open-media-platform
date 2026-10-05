//! Mitgelieferte Standardwerte: die fünf ORF-Programmgruppen, das 8-Spur-MXF-
//! Schema, die 13 ORF-„Shuffle“-Presets als Zuordnungsvorlagen und ein
//! Standard-Regelsatz. Alles nur Daten — im Editor sichtbar und änderbar.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::model::*;

/// Altes Preset-Format von `omp-mxf-player` (`presets.rs`), nur zum Import.
#[derive(Deserialize)]
struct OldSettings {
    presets: Vec<OldPreset>,
}

#[derive(Deserialize)]
struct OldPreset {
    id: String,
    label: String,
    routes: Vec<OldRoute>,
}

#[derive(Deserialize)]
struct OldRoute {
    #[serde(rename = "srcTrack")]
    src_track: u32,
    group: String,
    #[serde(rename = "groupChannel")]
    group_channel: usize,
}

pub(crate) fn group(id: &str, label: &str, layout: Layout, tags: &[&str]) -> TargetGroup {
    TargetGroup {
        id: id.to_string(),
        label: label.to_string(),
        layout,
        channels: vec![],
        tags: tags.iter().map(|t| t.to_string()).collect(),
        default_source: None,
    }
}

pub fn default_profile() -> OutputProfile {
    OutputProfile {
        groups: vec![
            group("pt", "Programmton", Layout::Stereo, &["role:pt"]),
            group("ad", "Hörfilm/AD", Layout::Stereo, &["role:ad"]),
            group("ot", "Originalton", Layout::Stereo, &["role:ot"]),
            // Dolby E wird als Bitstrom in PCM getragen: nur 1:1-Auswahl.
            group("dolbye", "Dolby E", Layout::Stereo, &["role:dolbye", "bitexact"]),
            group("surround51", "5.1 Diskret", Layout::Surround51, &["role:pt51"]),
        ],
    }
}

pub fn default_schemas() -> Vec<TrackSchema> {
    vec![TrackSchema {
        id: "orf-mxf-8".to_string(),
        matcher: SchemaMatch { format: Some("mxf".to_string()), tracks: Some(8), path_glob: None },
        tracks: (1..=8)
            .map(|n| SourceTrack { n, layout: Layout::Mono, channels: vec![], tags: vec![format!("pos:{n}")] })
            .collect(),
    }]
}

/// Die 13 ORF-Presets als Zuordnungen: je Gruppe die Quellspur pro Zielkanal.
pub fn default_mappings() -> Vec<Mapping> {
    let old: OldSettings = serde_json::from_str(include_str!("../defaults/orf-mxf-player.json")).expect("eingebettetes Preset-JSON ist gültig");
    old.presets
        .into_iter()
        .map(|p| {
            let mut per_group: BTreeMap<String, Vec<u32>> = BTreeMap::new();
            for r in &p.routes {
                let v = per_group.entry(r.group.clone()).or_default();
                if v.len() <= r.group_channel {
                    v.resize(r.group_channel + 1, 0);
                }
                v[r.group_channel] = r.src_track;
            }
            Mapping {
                id: p.id,
                label: p.label,
                groups: per_group.into_iter().map(|(g, tracks)| (g, SourceSpec { tracks: Some(tracks), ..Default::default() })).collect(),
            }
        })
        .collect()
}

pub(crate) fn select(expr: &str, via: Option<&str>) -> Action {
    Action { use_: Some(SourceSpec { select: Some(expr.to_string()), via: via.map(str::to_string), ..Default::default() }), ..Default::default() }
}

/// Standard-Ersatzketten (greifen nur, wenn die Vorgabe des Events nicht erfüllbar ist).
pub fn default_rules() -> RuleSet {
    RuleSet {
        rules: vec![
            Rule {
                id: "pt-aus-51".to_string(),
                group: "pt".to_string(),
                when: When::default(),
                then: vec![select("role:pt AND layout:stereo", None), select("layout:5.1", Some("downmix")), select("role:pt AND layout:mono", None)],
            },
            Rule {
                id: "51-aus-stereo".to_string(),
                group: "surround51".to_string(),
                when: When::default(),
                then: vec![
                    select("layout:5.1", None),
                    select("role:pt AND layout:stereo", Some("upmix51")),
                    Action { silence: true, warn: Some("kein 5.1-Ton und kein Stereo-Programmton, Gruppe bleibt still".to_string()), ..Default::default() },
                ],
            },
        ],
    }
}
