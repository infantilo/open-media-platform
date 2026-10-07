//! Datenmodell der MCA-Labels (ST 377-4 §5/§6) und die aufgelöste Sicht
//! (Vorrangregeln §5.1.1.2 / §5.1.2.2 / §5.1.3.2).

use serde::Serialize;

use crate::keys::{Ul, Uuid};
use crate::vocab::{self, Facet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LabelKind {
    AudioChannel,
    SoundfieldGroup,
    GroupOfSoundfieldGroups,
}

impl LabelKind {
    pub fn set_kind(self) -> u8 {
        match self {
            LabelKind::AudioChannel => crate::keys::SET_MCA_CHANNEL,
            LabelKind::SoundfieldGroup => crate::keys::SET_MCA_SOUNDFIELD,
            LabelKind::GroupOfSoundfieldGroups => crate::keys::SET_MCA_GROUP,
        }
    }

    pub fn from_set_kind(k: u8) -> Option<Self> {
        Some(match k {
            crate::keys::SET_MCA_CHANNEL => LabelKind::AudioChannel,
            crate::keys::SET_MCA_SOUNDFIELD => LabelKind::SoundfieldGroup,
            crate::keys::SET_MCA_GROUP => LabelKind::GroupOfSoundfieldGroups,
            _ => return None,
        })
    }

    pub fn facet(self) -> Facet {
        match self {
            LabelKind::AudioChannel => Facet::Channel,
            LabelKind::SoundfieldGroup => Facet::SoundfieldGroup,
            LabelKind::GroupOfSoundfieldGroups => Facet::GroupOfSoundfieldGroups,
        }
    }
}

/// Die optionalen Text-Items eines Labels (alle in ST 377-4 Tab. 3).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McaItems {
    pub spoken_language: Option<String>,
    pub title: Option<String>,
    pub title_version: Option<String>,
    pub title_sub_version: Option<String>,
    pub episode: Option<String>,
    pub partition_kind: Option<String>,
    pub partition_number: Option<String>,
    pub audio_content_kind: Option<String>,
    pub audio_element_kind: Option<String>,
    pub content: Option<String>,
    pub use_class: Option<String>,
    pub content_subtype: Option<String>,
    pub content_differentiator: Option<String>,
    pub spoken_language_attribute: Option<String>,
    pub additional_languages: Option<String>,
    pub additional_language_attributes: Option<String>,
}

/// Ein Feld aus `McaItems` per Zugriffsfunktion — für Vorrang und Vergleich.
type Getter = fn(&McaItems) -> &Option<String>;

pub const ITEM_GETTERS: &[(&str, Getter)] = &[
    ("spokenLanguage", |i| &i.spoken_language),
    ("title", |i| &i.title),
    ("titleVersion", |i| &i.title_version),
    ("titleSubVersion", |i| &i.title_sub_version),
    ("episode", |i| &i.episode),
    ("partitionKind", |i| &i.partition_kind),
    ("partitionNumber", |i| &i.partition_number),
    ("audioContentKind", |i| &i.audio_content_kind),
    ("audioElementKind", |i| &i.audio_element_kind),
    ("content", |i| &i.content),
    ("useClass", |i| &i.use_class),
    ("contentSubtype", |i| &i.content_subtype),
    ("contentDifferentiator", |i| &i.content_differentiator),
    ("spokenLanguageAttribute", |i| &i.spoken_language_attribute),
    ("additionalLanguages", |i| &i.additional_languages),
    ("additionalLanguageAttributes", |i| &i.additional_language_attributes),
];

pub fn set_item(items: &mut McaItems, name: &str, v: Option<String>) {
    match name {
        "spokenLanguage" => items.spoken_language = v,
        "title" => items.title = v,
        "titleVersion" => items.title_version = v,
        "titleSubVersion" => items.title_sub_version = v,
        "episode" => items.episode = v,
        "partitionKind" => items.partition_kind = v,
        "partitionNumber" => items.partition_number = v,
        "audioContentKind" => items.audio_content_kind = v,
        "audioElementKind" => items.audio_element_kind = v,
        "content" => items.content = v,
        "useClass" => items.use_class = v,
        "contentSubtype" => items.content_subtype = v,
        "contentDifferentiator" => items.content_differentiator = v,
        "spokenLanguageAttribute" => items.spoken_language_attribute = v,
        "additionalLanguages" => items.additional_languages = v,
        "additionalLanguageAttributes" => items.additional_language_attributes = v,
        _ => {}
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McaLabel {
    pub kind: LabelKind,
    pub instance_uid: Uuid,
    pub dictionary_id: Ul,
    pub link_id: Uuid,
    pub tag_symbol: String,
    pub tag_name: Option<String>,
    pub channel_id: Option<u32>,
    /// Nur Kanal-Label: Link-ID der Soundfield Group.
    pub soundfield_group_link_id: Option<Uuid>,
    /// Nur Soundfield-Group-Label: Link-IDs der Gruppen von Soundfield Groups.
    pub group_link_ids: Vec<Uuid>,
    pub items: McaItems,
}

/// Ein Audio-Descriptor des File Package mit seinen MCA-SubDescriptors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SoundDescriptor {
    pub instance_uid: Uuid,
    pub set_kind: u8,
    pub linked_track_id: Option<u32>,
    pub channel_count: u32,
    pub labels: Vec<McaLabel>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct McaFile {
    pub descriptors: Vec<SoundDescriptor>,
}

// ------------------------------------------------------------ aufgelöste Sicht

pub fn uuid_text(u: &[u8; 16]) -> String {
    let h: Vec<String> = u.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", h[0..4].concat(), h[4..6].concat(), h[6..8].concat(), h[8..10].concat(), h[10..16].concat())
}

pub fn ul_text(u: &[u8; 16]) -> String {
    u.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(".")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelSummary {
    pub link_id: String,
    pub symbol: String,
    pub name: Option<String>,
    /// Bedeutung laut Label-Dictionary (ST 428-12 / 2067-8), falls bekannt.
    pub meaning: Option<String>,
    pub dictionary_id: String,
    /// Effektive Items nach Vorrang (Kanal > SG > GSG).
    pub items: McaItems,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSummary {
    /// Laufende Nummer über alle Audiokanäle der Datei (0-basiert, Reihenfolge der Descriptoren).
    pub index: usize,
    pub track_id: Option<u32>,
    /// MCA Channel ID (1-basiert im Descriptor), falls angegeben.
    pub channel_id: Option<u32>,
    pub label: LabelSummary,
    pub soundfield_group: Option<LabelSummary>,
    pub groups: Vec<LabelSummary>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McaSummary {
    pub channels: Vec<ChannelSummary>,
    /// Kanäle ohne Label (z. B. Descriptor ohne MCA).
    pub unlabeled_channels: Vec<usize>,
    pub issues: Vec<String>,
}

fn meaning(def: Option<&vocab::LabelDef>, ul: &Ul) -> Option<String> {
    def.map(|d| d.name.to_string()).or_else(|| vocab::nsc_channel(ul).map(|n| format!("Numbered Source Channel {n:03}")))
}

fn same_value(vals: &[Option<&String>]) -> Option<String> {
    let first = (*vals.first()?)?;
    vals.iter().all(|v| *v == Some(first)).then(|| first.clone())
}

/// Vorrangregeln anwenden: `lower` zuerst (Kanal), dann die übergeordneten.
fn effective(own: &McaItems, parents: &[&McaItems]) -> McaItems {
    let mut out = McaItems::default();
    for (name, get) in ITEM_GETTERS {
        let mut v = get(own).clone();
        if v.is_none() {
            // erster Elternwert, sofern alle vorhandenen Elternwerte gleich sind
            let vals: Vec<Option<&String>> = parents.iter().map(|p| get(p).as_ref()).filter(|x| x.is_some()).collect();
            v = same_value(&vals);
        }
        set_item(&mut out, name, v);
    }
    out
}

/// Aus untergeordneten Labels abgeleiteter Wert, wenn der Wert im Label selbst fehlt (§5.1.2.2/§5.1.3.2).
fn inferred(own: &McaItems, children: &[&McaItems]) -> McaItems {
    let mut out = McaItems::default();
    for (name, get) in ITEM_GETTERS {
        let mut v = get(own).clone();
        if v.is_none() {
            let vals: Vec<Option<&String>> = children.iter().map(|c| get(c).as_ref()).collect();
            v = same_value(&vals);
        }
        set_item(&mut out, name, v);
    }
    out
}

impl McaFile {
    pub fn is_empty(&self) -> bool {
        self.descriptors.iter().all(|d| d.labels.is_empty())
    }

    fn all_labels(&self) -> impl Iterator<Item = &McaLabel> {
        self.descriptors.iter().flat_map(|d| d.labels.iter())
    }

    fn find(&self, kind: LabelKind, link: &Uuid) -> Option<&McaLabel> {
        self.all_labels().find(|l| l.kind == kind && &l.link_id == link)
    }

    fn summary_of(&self, l: &McaLabel, items: McaItems) -> LabelSummary {
        let def = vocab::lookup_label(&l.dictionary_id);
        LabelSummary {
            link_id: uuid_text(&l.link_id),
            symbol: l.tag_symbol.clone(),
            name: l.tag_name.clone().or_else(|| def.map(|d| d.name.to_string())),
            meaning: meaning(def, &l.dictionary_id),
            dictionary_id: ul_text(&l.dictionary_id),
            items,
        }
    }

    /// Aufgelöste Sicht: je Audiokanal das Kanal-Label, seine Soundfield
    /// Group und Gruppen mit den effektiven Items.
    pub fn summarize(&self) -> McaSummary {
        let mut sum = McaSummary::default();
        let mut index = 0usize;
        for d in &self.descriptors {
            let chan_labels: Vec<&McaLabel> = d.labels.iter().filter(|l| l.kind == LabelKind::AudioChannel).collect();
            for ch in 0..d.channel_count.max(1) {
                let ch_id = ch + 1;
                // Zuordnung per MCA Channel ID; ohne ID bei genau einem Kanal pro Descriptor das einzige Label.
                let label = chan_labels
                    .iter()
                    .copied()
                    .find(|l| l.channel_id == Some(ch_id))
                    .or_else(|| (d.channel_count <= 1 && chan_labels.len() == 1 && chan_labels[0].channel_id.is_none()).then(|| chan_labels[0]));
                let Some(label) = label else {
                    sum.unlabeled_channels.push(index);
                    index += 1;
                    continue;
                };
                let sg = label.soundfield_group_link_id.and_then(|id| self.find(LabelKind::SoundfieldGroup, &id));
                let gsgs: Vec<&McaLabel> = sg.map(|s| s.group_link_ids.iter().filter_map(|id| self.find(LabelKind::GroupOfSoundfieldGroups, id)).collect()).unwrap_or_default();
                let mut parents: Vec<&McaItems> = Vec::new();
                if let Some(s) = sg {
                    parents.push(&s.items);
                }
                // GSG-Werte gelten nur, wenn die SG selbst keinen hat.
                let gsg_items: Vec<&McaItems> = gsgs.iter().map(|g| &g.items).collect();
                let sg_eff = sg.map(|s| effective(&s.items, &gsg_items));
                let items = match (&sg_eff, sg) {
                    (Some(e), Some(_)) => effective(&label.items, &[e]),
                    _ => effective(&label.items, &gsg_items),
                };
                sum.channels.push(ChannelSummary {
                    index,
                    track_id: d.linked_track_id,
                    channel_id: label.channel_id,
                    label: self.summary_of(label, items),
                    soundfield_group: sg.map(|s| {
                        let chs: Vec<&McaItems> = self.all_labels().filter(|c| c.kind == LabelKind::AudioChannel && c.soundfield_group_link_id == Some(s.link_id)).map(|c| &c.items).collect();
                        let eff = effective(&inferred(&s.items, &chs), &gsg_items);
                        self.summary_of(s, eff)
                    }),
                    groups: gsgs
                        .iter()
                        .map(|g| {
                            let sgs: Vec<&McaItems> = self.all_labels().filter(|s| s.kind == LabelKind::SoundfieldGroup && s.group_link_ids.contains(&g.link_id)).map(|s| &s.items).collect();
                            self.summary_of(g, inferred(&g.items, &sgs))
                        })
                        .collect(),
                });
                index += 1;
            }
        }
        // Konsistenz: verwaiste Verweise / Pflichtregeln
        for l in self.all_labels() {
            if l.kind == LabelKind::AudioChannel
                && let Some(id) = l.soundfield_group_link_id
                && self.find(LabelKind::SoundfieldGroup, &id).is_none()
            {
                sum.issues.push(format!("Kanal-Label {} verweist auf eine unbekannte Soundfield Group", l.tag_symbol));
            }
            if l.kind == LabelKind::SoundfieldGroup {
                for id in &l.group_link_ids {
                    if self.find(LabelKind::GroupOfSoundfieldGroups, id).is_none() {
                        sum.issues.push(format!("Soundfield Group {} verweist auf eine unbekannte Gruppe von Soundfield Groups", l.tag_symbol));
                    }
                }
            }
            if !vocab::valid_tag_symbol(&l.tag_symbol) {
                sum.issues.push(format!("MCA Tag Symbol „{}“ ist ungültig (2–8 alphanumerische Zeichen, Buchstabe zuerst)", l.tag_symbol));
            }
            for m in vocab::validate_items(&l.items) {
                sum.issues.push(format!("{}: {m}", l.tag_symbol));
            }
        }
        sum
    }
}
