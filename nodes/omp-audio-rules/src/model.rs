//! Datenmodell (alles JSON, camelCase wie die übrigen Einstellungsdokumente).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Kanal-Layout einer Zielgruppe bzw. einer Quellspur.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Layout {
    #[default]
    #[serde(rename = "mono")]
    Mono,
    #[serde(rename = "stereo")]
    Stereo,
    #[serde(rename = "5.1")]
    Surround51,
    #[serde(rename = "7.1")]
    Surround71,
    /// Kanalnamen kommen aus `channels` des Eintrags.
    #[serde(rename = "custom")]
    Custom,
}

impl Layout {
    pub fn name(self) -> &'static str {
        match self {
            Layout::Mono => "mono",
            Layout::Stereo => "stereo",
            Layout::Surround51 => "5.1",
            Layout::Surround71 => "7.1",
            Layout::Custom => "custom",
        }
    }

    /// Standard-Kanalnamen (SMPTE-Reihenfolge); `Custom` hat keine.
    pub fn default_channels(self) -> Vec<String> {
        let v: &[&str] = match self {
            Layout::Mono => &["M"],
            Layout::Stereo => &["L", "R"],
            Layout::Surround51 => &["L", "R", "C", "LFE", "Ls", "Rs"],
            Layout::Surround71 => &["L", "R", "C", "LFE", "Ls", "Rs", "Lb", "Rb"],
            Layout::Custom => &[],
        };
        v.iter().map(|s| s.to_string()).collect()
    }
}

fn channel_names(layout: Layout, explicit: &[String]) -> Vec<String> {
    if explicit.is_empty() { layout.default_channels() } else { explicit.to_vec() }
}

/// Quellvorgabe: entweder explizite Spurliste oder Tag-Auswahl, optional mit
/// Prozessor (`via`) und Verarbeitungskette (`chain`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SourceSpec {
    /// Spurnummern (1-basiert), ihre Kanäle werden der Reihe nach den
    /// Zielkanälen zugeordnet. `0` = Stille für diesen Platz; dieselbe Spur
    /// darf mehrfach vorkommen (Mono → L und R).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracks: Option<Vec<u32>>,
    /// Tag-Ausdruck; die passenden Spuren (nach Spurnummer) liefern die Kanäle.
    /// Tragen die Spuren `ch:<Kanalname>`-Tags, gilt der Name statt der Reihenfolge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub select: Option<String>,
    /// Matrix-Prozessor (`upmix51`, `downmix`, `mono-to-stereo`, …); fehlt er, gilt `auto`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    /// DSP-Verarbeitungskette (nicht als Matrix darstellbar, z. B. `dialog-enhance`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chain: Vec<ProcessorRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcessorRef {
    pub name: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, serde_json::Value>,
}

/// Eine Zielgruppe des Ausgabeprofils (wird ein eigener MXL-Audio-Flow).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TargetGroup {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub layout: Layout,
    /// Kanalnamen; leer = Standardnamen des Layouts (bei `custom` Pflicht).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub channels: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Vorgabe, wenn weder Event-Zuordnung noch Vorlage diese Gruppe nennt.
    #[serde(default, rename = "default", skip_serializing_if = "Option::is_none")]
    pub default_source: Option<SourceSpec>,
}

impl TargetGroup {
    pub fn channel_names(&self) -> Vec<String> {
        channel_names(self.layout, &self.channels)
    }

    /// Nur reine 1:1-Auswahl erlaubt (z. B. Dolby E).
    pub fn bit_exact(&self) -> bool {
        self.tags.iter().any(|t| t.eq_ignore_ascii_case("bitexact"))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OutputProfile {
    pub groups: Vec<TargetGroup>,
}

/// Eine Quellspur (bei MXF meist mono; bei Live-Capabilities ein ganzer Flow).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceTrack {
    /// 1-basierte Spurnummer, eindeutig je Quelle.
    pub n: u32,
    #[serde(default)]
    pub layout: Layout,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub channels: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

impl SourceTrack {
    pub fn channel_names(&self) -> Vec<String> {
        channel_names(self.layout, &self.channels)
    }

    /// Tags der Spur plus abgeleitete (`layout:<name>`, `channels:<n>`).
    pub fn all_tags(&self) -> Vec<String> {
        let mut t = self.tags.clone();
        t.push(format!("layout:{}", self.layout.name()));
        t.push(format!("channels:{}", self.channel_names().len()));
        t
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    #[default]
    File,
    Live,
}

/// Beschreibung der Quelle eines Events: ihre Spuren.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SourceDesc {
    #[serde(default)]
    pub kind: SourceKind,
    pub tracks: Vec<SourceTrack>,
}

/// Was die Spuren einer Quellklasse bedeuten; `match` wählt es automatisch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackSchema {
    pub id: String,
    #[serde(default, rename = "match")]
    pub matcher: SchemaMatch,
    pub tracks: Vec<SourceTrack>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SchemaMatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// Anzahl der Spuren der Datei.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracks: Option<u32>,
    /// Einfaches Muster mit `*` für den Dateipfad.
    #[serde(default, rename = "path", skip_serializing_if = "Option::is_none")]
    pub path_glob: Option<String>,
}

/// Messwerte einer Datei (Probe), gegen die ein Schema gewählt wird.
#[derive(Debug, Clone, Default)]
pub struct ProbeInfo {
    pub format: String,
    pub track_count: u32,
    pub path: String,
}

/// Zuordnungsvorlage (heute „Shuffle-Preset“).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Mapping {
    pub id: String,
    #[serde(default)]
    pub label: String,
    /// Zielgruppen-ID → Quellvorgabe.
    #[serde(default)]
    pub groups: BTreeMap<String, SourceSpec>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct When {
    /// Regel gilt nur, wenn KEINE Spur diesen Ausdruck erfüllt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing: Option<String>,
    /// Regel gilt nur, wenn mindestens eine Spur diesen Ausdruck erfüllt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceKind>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Action {
    #[serde(default, rename = "use", skip_serializing_if = "Option::is_none")]
    pub use_: Option<SourceSpec>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub silence: bool,
    /// Event darf so nicht auf Sendung (Alarm).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fail: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warn: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rule {
    #[serde(default)]
    pub id: String,
    /// Zielgruppen-ID oder `*`.
    pub group: String,
    #[serde(default)]
    pub when: When,
    pub then: Vec<Action>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RuleSet {
    pub rules: Vec<Rule>,
}

/// Ergebnis für eine Zielgruppe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupPlan {
    pub group: String,
    /// Zeilen = Zielkanäle, Spalten = Quellkanäle (flach über alle Spuren in Spurreihenfolge).
    pub matrix: Vec<Vec<f32>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chain: Vec<ProcessorRef>,
    /// Stille Gruppe (Matrix nur Nullen).
    pub silent: bool,
    /// Welche Regel gegriffen hat (`None` = Vorgabe des Events/der Vorlage).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    pub warnings: Vec<String>,
    /// Gruppe darf so nicht senden (`fail`-Aktion).
    pub failed: bool,
}

/// Quellkanal in flacher Reihenfolge (Spalte der Matrizen).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SrcChannel {
    pub track: u32,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioPlan {
    pub src_channels: Vec<SrcChannel>,
    pub groups: Vec<GroupPlan>,
    pub warnings: Vec<String>,
    /// Kein `failed` in einer Gruppe.
    pub ok: bool,
}

/// Ergebnis von [`AudioSettings::mxf_source_probed`].
#[derive(Debug, Clone)]
pub struct ProbedSource {
    pub source: SourceDesc,
    /// Kurzer Hinweis, wenn MCA-Labels verwendet wurden.
    pub note: Option<String>,
    /// Prüfhinweise (Vokabular/Verweise) bzw. ignorierte Labels.
    pub warnings: Vec<String>,
    /// Aufgelöste MCA-Sicht der Datei (nur wenn Labels verwendet wurden).
    pub mca: Option<omp_mxf_mca::McaSummary>,
}

/// Das gesamte, vom Orchestrator gespeicherte Einstellungsdokument.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AudioSettings {
    #[serde(rename = "outputProfile")]
    pub output_profile: OutputProfile,
    #[serde(rename = "trackSchemas", default)]
    pub track_schemas: Vec<TrackSchema>,
    #[serde(default)]
    pub mappings: Vec<Mapping>,
    #[serde(rename = "ruleSet", default)]
    pub rule_set: RuleSet,
}

impl AudioSettings {
    /// Quelle ohne Mehrspur-Container (Live, Testton, Standbild, generische Datei): ein Programmton-Stream.
    pub fn stereo_program_source(kind: SourceKind) -> SourceDesc {
        SourceDesc { kind, tracks: vec![SourceTrack { n: 1, layout: Layout::Stereo, channels: vec![], tags: vec!["role:pt".to_string()] }] }
    }

    /// MXF-Datei mit `track_count` Spuren: zuerst die MCA-Labels der Datei
    /// (SMPTE ST 377-4/-41, s. `omp_mxf_mca::tags`), dann ein Spurschema per
    /// Probe, sonst `pos:N`-Mono-Spuren. Meldungen gehen nach stderr.
    pub fn mxf_source(&self, track_count: u32, path: &str) -> SourceDesc {
        let probed = self.mxf_source_probed(track_count, path);
        if let Some(n) = &probed.note {
            eprintln!("audio-rules: {n}");
        }
        for w in &probed.warnings {
            eprintln!("audio-rules: MCA: {w}");
        }
        probed.source
    }

    /// Wie [`Self::mxf_source`], liefert zusätzlich Hinweise und die MCA-Sicht.
    pub fn mxf_source_probed(&self, track_count: u32, path: &str) -> ProbedSource {
        let mut warnings = Vec::new();
        let mut note = None;
        if let Ok(mca) = omp_mxf_mca::read::read_file(std::path::Path::new(path))
            && !mca.is_empty()
        {
            let sum = mca.summarize();
            let total = sum.channels.len() + sum.unlabeled_channels.len();
            if total == track_count as usize {
                let mut by_index: Vec<Option<&omp_mxf_mca::model::ChannelSummary>> = vec![None; total];
                for c in &sum.channels {
                    by_index[c.index] = Some(c);
                }
                let tracks = by_index
                    .iter()
                    .enumerate()
                    .map(|(i, c)| {
                        let n = i as u32 + 1;
                        let mut tags = vec![format!("pos:{n}")];
                        if let Some(c) = c {
                            tags.extend(omp_mxf_mca::tags::channel_tags(c));
                        }
                        SourceTrack { n, layout: Layout::Mono, channels: vec![], tags }
                    })
                    .collect();
                note = Some(format!("Datei trägt MCA-Labels ({} von {} Kanälen beschriftet) — sie ersetzen das Spurschema", sum.channels.len(), total));
                warnings = sum.issues.clone();
                return ProbedSource { source: SourceDesc { kind: SourceKind::File, tracks }, note, warnings, mca: Some(sum) };
            }
            warnings.push(format!("MCA-Labels beschreiben {total} Kanäle, die Datei liefert {track_count} Spuren — Labels werden ignoriert"));
        }
        let source = self.mxf_source_unlabeled(track_count, path);
        ProbedSource { source, note, warnings, mca: None }
    }

    /// Spurschema per Probe, sonst `pos:N`-Mono-Spuren (ohne MCA-Labels).
    pub fn mxf_source_unlabeled(&self, track_count: u32, path: &str) -> SourceDesc {
        let probe = ProbeInfo { format: "mxf".to_string(), track_count, path: path.to_string() };
        if let Some(schema) = crate::resolve::select_schema(&self.track_schemas, &probe) {
            return SourceDesc { kind: SourceKind::File, tracks: schema.tracks.clone() };
        }
        let tracks = (1..=track_count).map(|n| SourceTrack { n, layout: Layout::Mono, channels: vec![], tags: vec![format!("pos:{n}")] }).collect();
        SourceDesc { kind: SourceKind::File, tracks }
    }

    /// Semantische Prüfung (s. [`crate::validate`]); leer = gültig.
    pub fn validate(&self) -> Vec<String> {
        crate::resolve::validate(&self.output_profile, &self.track_schemas, &self.mappings, &self.rule_set)
    }
}

#[cfg(test)]
mod mca_tests {
    use super::*;
    use omp_mxf_mca::keys::{self, label_ul};
    use omp_mxf_mca::model::{LabelKind, SoundDescriptor};
    use omp_mxf_mca::testkit::{Spec, build, channel, group, uid};

    fn write(name: &str, spec: &Spec) -> String {
        let p = std::env::temp_dir().join(format!("omp-audio-rules-mca-{}-{name}.mxf", std::process::id()));
        std::fs::write(&p, build(spec)).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn doc() -> AudioSettings {
        crate::defaults::default_settings()
    }

    fn stereo_pt_plus_ad() -> Spec {
        let mut l = channel("chL", label_ul(1, 1, 0, 0), 1, 1, Some(20));
        l.items.spoken_language = Some("de".into());
        let mut sg = group(LabelKind::SoundfieldGroup, "sgST", label_ul(2, 0x20, 1, 0), 20, &[]);
        sg.items.content = Some("PRM".into());
        sg.items.use_class = Some("FCMP".into());
        let r = channel("chR", label_ul(1, 2, 0, 0), 2, 2, Some(20));
        let vin = channel("chVIN", label_ul(1, 0x0F, 0, 0), 1, 3, None);
        Spec {
            descriptors: vec![
                SoundDescriptor { instance_uid: uid(0xD1), set_kind: keys::SET_WAVE_AUDIO_DESCRIPTOR, linked_track_id: Some(1), channel_count: 2, labels: vec![l, r, sg] },
                SoundDescriptor { instance_uid: uid(0xD2), set_kind: keys::SET_WAVE_AUDIO_DESCRIPTOR, linked_track_id: Some(2), channel_count: 1, labels: vec![vin] },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn mca_labels_replace_the_schema_and_feed_the_rules() {
        let path = write("mca", &stereo_pt_plus_ad());
        let p = doc().mxf_source_probed(3, &path);
        assert!(p.note.is_some() && p.mca.is_some(), "{p:?}");
        let tags = |n: usize| p.source.tracks[n].all_tags();
        assert!(tags(0).contains(&"role:pt".to_string()) && tags(0).contains(&"ch:L".to_string()) && tags(0).contains(&"lang:de".to_string()), "{:?}", tags(0));
        assert!(tags(1).contains(&"role:pt".to_string()) && tags(1).contains(&"ch:R".to_string()));
        assert!(tags(2).contains(&"role:ad".to_string()));
        // Der Plan der Standard-Ausgabegruppen wählt daraus Programmton (L/R) und Hörfilm (VIN).
        let mapping = Mapping { id: "m".into(), label: String::new(), groups: [("ad".to_string(), SourceSpec { select: Some("role:ad".into()), ..Default::default() })].into_iter().collect() };
        let plan = crate::resolve(&doc().output_profile, &p.source, Some(&mapping), &doc().rule_set);
        let g = |id: &str| plan.groups.iter().find(|g| g.group == id).unwrap();
        assert!(!g("pt").silent && !g("pt").failed, "{:?}", g("pt"));
        assert!(!g("ad").silent, "{:?}", g("ad"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn mismatching_count_or_missing_labels_fall_back() {
        let path = write("fallback", &stereo_pt_plus_ad());
        let p = doc().mxf_source_probed(8, &path);
        assert!(p.mca.is_none() && p.note.is_none());
        assert!(p.warnings.iter().any(|w| w.contains("ignoriert")), "{:?}", p.warnings);
        assert_eq!(p.source.tracks.len(), 8);
        assert!(p.source.tracks[0].tags.contains(&"pos:1".to_string()));
        let nothing = doc().mxf_source_probed(8, "/nicht/vorhanden.mxf");
        assert_eq!(nothing.source.tracks.len(), 8);
        let _ = std::fs::remove_file(path);
    }
}
