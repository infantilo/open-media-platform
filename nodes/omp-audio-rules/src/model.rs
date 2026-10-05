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
