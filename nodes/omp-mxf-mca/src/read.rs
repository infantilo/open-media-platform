//! MCA-Labels aus MXF-Header-Metadaten lesen.

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;

use crate::keys::{self, Ul, Uuid};
use crate::klv;
use crate::model::{LabelKind, McaFile, McaItems, McaLabel, SoundDescriptor};
use crate::mxf::{self, HeaderMetadata, MxfError, Primer, RawSet};

#[derive(Debug, Clone, Copy)]
pub(crate) enum Item {
    DictionaryId,
    LinkId,
    TagSymbol,
    TagName,
    ChannelId,
    SoundfieldGroupLinkId,
    GroupLinkIds,
    Text(&'static str),
}

/// UL → Item. Die Textfelder tragen den Namen aus `model::ITEM_GETTERS`.
pub(crate) const ITEM_ULS: &[(Ul, Item)] = &[
    (keys::UL_DICTIONARY_ID, Item::DictionaryId),
    (keys::UL_LINK_ID, Item::LinkId),
    (keys::UL_TAG_SYMBOL, Item::TagSymbol),
    (keys::UL_TAG_NAME, Item::TagName),
    (keys::UL_CHANNEL_ID, Item::ChannelId),
    (keys::UL_SOUNDFIELD_GROUP_LINK_ID, Item::SoundfieldGroupLinkId),
    (keys::UL_GROUP_OF_SOUNDFIELD_GROUPS_LINK_ID, Item::GroupLinkIds),
    (keys::UL_SPOKEN_LANGUAGE, Item::Text("spokenLanguage")),
    (keys::UL_TITLE, Item::Text("title")),
    (keys::UL_TITLE_VERSION, Item::Text("titleVersion")),
    (keys::UL_TITLE_SUB_VERSION, Item::Text("titleSubVersion")),
    (keys::UL_EPISODE, Item::Text("episode")),
    (keys::UL_PARTITION_KIND, Item::Text("partitionKind")),
    (keys::UL_PARTITION_NUMBER, Item::Text("partitionNumber")),
    (keys::UL_AUDIO_CONTENT_KIND, Item::Text("audioContentKind")),
    (keys::UL_AUDIO_ELEMENT_KIND, Item::Text("audioElementKind")),
    (keys::UL_CONTENT, Item::Text("content")),
    (keys::UL_USE_CLASS, Item::Text("useClass")),
    (keys::UL_CONTENT_SUBTYPE, Item::Text("contentSubtype")),
    (keys::UL_CONTENT_DIFFERENTIATOR, Item::Text("contentDifferentiator")),
    (keys::UL_SPOKEN_LANGUAGE_ATTRIBUTE, Item::Text("spokenLanguageAttribute")),
    (keys::UL_ADDITIONAL_LANGUAGES, Item::Text("additionalLanguages")),
    (keys::UL_ADDITIONAL_LANGUAGE_ATTRIBUTES, Item::Text("additionalLanguageAttributes")),
];

/// Items, die nach ST 377-4 als ISO7-Strings (einbyte) statt UTF-16 gespeichert werden.
pub(crate) fn is_iso7(name: &str) -> bool {
    matches!(name, "spokenLanguage" | "spokenLanguageAttribute" | "additionalLanguages" | "additionalLanguageAttributes")
}

fn tag_map(primer: &Primer) -> HashMap<u16, Item> {
    primer.entries.iter().filter_map(|(tag, ul)| ITEM_ULS.iter().find(|(u, _)| u == ul).map(|(_, it)| (*tag, *it))).collect()
}

fn uuid16(v: &[u8]) -> Option<Uuid> {
    v.try_into().ok()
}

fn u32be(v: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(v.try_into().ok()?))
}

/// Batch/Array von 16-Byte-Werten (`u32 Anzahl`, `u32 16`, Werte).
pub(crate) fn batch16(v: &[u8]) -> Vec<[u8; 16]> {
    if v.len() < 8 {
        return Vec::new();
    }
    let n = u32::from_be_bytes([v[0], v[1], v[2], v[3]]) as usize;
    let sz = u32::from_be_bytes([v[4], v[5], v[6], v[7]]) as usize;
    if sz != 16 || v.len() < 8 + n * 16 {
        return Vec::new();
    }
    (0..n).map(|i| v[8 + i * 16..24 + i * 16].try_into().unwrap()).collect()
}

fn parse_label(set: &RawSet, map: &HashMap<u16, Item>) -> Option<McaLabel> {
    let kind = LabelKind::from_set_kind(keys::set_kind(&set.key)?)?;
    let mut l = McaLabel {
        kind,
        instance_uid: set.instance_uid().unwrap_or([0; 16]),
        dictionary_id: [0; 16],
        link_id: [0; 16],
        tag_symbol: String::new(),
        tag_name: None,
        channel_id: None,
        soundfield_group_link_id: None,
        group_link_ids: Vec::new(),
        items: McaItems::default(),
    };
    for (tag, value) in &set.items {
        let Some(item) = map.get(tag) else { continue };
        match item {
            Item::DictionaryId => l.dictionary_id = value.as_slice().try_into().unwrap_or([0; 16]),
            Item::LinkId => l.link_id = uuid16(value).unwrap_or([0; 16]),
            Item::TagSymbol => l.tag_symbol = klv::utf16be_decode(value),
            Item::TagName => l.tag_name = Some(klv::utf16be_decode(value)),
            Item::ChannelId => l.channel_id = u32be(value),
            Item::SoundfieldGroupLinkId => l.soundfield_group_link_id = uuid16(value),
            Item::GroupLinkIds => l.group_link_ids = batch16(value),
            Item::Text(name) => {
                let s = if is_iso7(name) { String::from_utf8_lossy(value).trim_end_matches('\0').to_string() } else { klv::utf16be_decode(value) };
                crate::model::set_item(&mut l.items, name, Some(s));
            }
        }
    }
    Some(l)
}

/// Die Audio-Descriptoren des (ersten) Source Package, das solche enthält,
/// in Dateireihenfolge (MultipleDescriptor-Reihenfolge bzw. der einzelne Descriptor).
pub fn sound_descriptors(hm: &HeaderMetadata) -> Vec<&RawSet> {
    for pkg in hm.sets().filter(|s| s.kind() == Some(keys::SET_SOURCE_PACKAGE)) {
        let Some(desc) = pkg.get(keys::TAG_PACKAGE_DESCRIPTOR).and_then(uuid16).and_then(|u| hm.find_by_uid(&u)) else { continue };
        let leaves: Vec<&RawSet> = if desc.kind() == Some(keys::SET_MULTIPLE_DESCRIPTOR) {
            desc.get(keys::TAG_MULTI_SUBDESCRIPTORS).map(batch16).unwrap_or_default().iter().filter_map(|u| hm.find_by_uid(u)).collect()
        } else {
            vec![desc]
        };
        let sound: Vec<&RawSet> = leaves.into_iter().filter(|d| d.kind().is_some_and(keys::is_sound_descriptor)).collect();
        if !sound.is_empty() {
            return sound;
        }
    }
    Vec::new()
}

/// MCA-Labels aus bereits geparsten Header-Metadaten extrahieren.
pub fn from_header_metadata(hm: &HeaderMetadata) -> McaFile {
    let map = tag_map(&hm.primer);
    let sub_tag = hm.primer.tag_for(&keys::UL_SUBDESCRIPTORS);
    let mut file = McaFile::default();
    for d in sound_descriptors(hm) {
        let labels = sub_tag.and_then(|t| d.get(t)).map(batch16).unwrap_or_default().iter().filter_map(|u| hm.find_by_uid(u)).filter_map(|s| parse_label(s, &map)).collect();
        file.descriptors.push(SoundDescriptor {
            instance_uid: d.instance_uid().unwrap_or([0; 16]),
            set_kind: d.kind().unwrap_or(0),
            linked_track_id: d.get(keys::TAG_LINKED_TRACK_ID).and_then(u32be),
            channel_count: d.get(keys::TAG_CHANNEL_COUNT).and_then(u32be).unwrap_or(0),
            labels,
        });
    }
    file
}

/// Datei öffnen und die MCA-Labels lesen. Bevorzugt die Header-Partition;
/// enthält sie keine (vollständigen) Metadaten, die Footer-Partition.
pub fn read_file(path: &Path) -> Result<McaFile, MxfError> {
    let mut f = File::open(path)?;
    let header_pos = mxf::find_header_partition(&mut f)?;
    let offsets = mxf::partition_offsets(&mut f, header_pos)?;
    let mut best: Option<McaFile> = None;
    // Reihenfolge: Header zuerst; ein Footer mit Metadaten überschreibt, wenn der Header unvollständig war.
    for off in offsets {
        let Some((pack, hm)) = mxf::read_partition_metadata(&mut f, header_pos, off)? else { continue };
        let mca = from_header_metadata(&hm);
        let complete = matches!(pack.status, 0x02 | 0x04);
        if best.is_none() || complete {
            best = Some(mca);
        }
        if complete && !best.as_ref().unwrap().descriptors.is_empty() {
            break;
        }
    }
    Ok(best.unwrap_or_default())
}
