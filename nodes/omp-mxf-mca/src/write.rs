//! Labels → MXF-Sets (Schreib-Primitive). Die Datei-Ebene (Einfügen in
//! bestehende Dateien) folgt in `inject.rs`.

use crate::keys::{self, Uuid};
use crate::klv;
use crate::model::{ITEM_GETTERS, LabelKind, McaLabel};
use crate::mxf::{MxfError, Primer, RawSet};
use crate::read::{ITEM_ULS, Item, is_iso7};

fn ul_for_text(name: &str) -> Option<keys::Ul> {
    ITEM_ULS.iter().find_map(|(ul, it)| matches!(it, Item::Text(n) if *n == name).then_some(*ul))
}

fn batch16(items: &[[u8; 16]]) -> Vec<u8> {
    let mut v = Vec::with_capacity(8 + items.len() * 16);
    v.extend((items.len() as u32).to_be_bytes());
    v.extend(16u32.to_be_bytes());
    for i in items {
        v.extend(i);
    }
    v
}

/// Ein Label als Local Set kodieren; dynamische Tags werden im Primer ergänzt.
/// Pflicht-Items nach ST 377-4 Tab. 3: Dictionary ID, Link ID, Tag Symbol.
pub fn label_to_set(l: &McaLabel, primer: &mut Primer) -> Result<RawSet, MxfError> {
    let set = label_to_set_inner(l, primer)?;
    // Local-Set-Items tragen eine 2-Byte-Länge (ST 377-1 §9.3).
    if let Some((_, v)) = set.items.iter().find(|(_, v)| v.len() > 0xFFFF) {
        return Err(MxfError::Corrupt(format!("MCA-Item von {} Bytes ist zu lang (max. 65535)", v.len())));
    }
    Ok(set)
}

fn label_to_set_inner(l: &McaLabel, primer: &mut Primer) -> Result<RawSet, MxfError> {
    let mut set = RawSet { key: keys::set_key(l.kind.set_kind()), items: Vec::new() };
    set.items.push((keys::TAG_INSTANCE_UID, l.instance_uid.to_vec()));
    set.items.push((primer.ensure(&keys::UL_DICTIONARY_ID)?, l.dictionary_id.to_vec()));
    set.items.push((primer.ensure(&keys::UL_LINK_ID)?, l.link_id.to_vec()));
    set.items.push((primer.ensure(&keys::UL_TAG_SYMBOL)?, klv::utf16be_encode(&l.tag_symbol)));
    if let Some(n) = &l.tag_name {
        set.items.push((primer.ensure(&keys::UL_TAG_NAME)?, klv::utf16be_encode(n)));
    }
    if let Some(c) = l.channel_id {
        set.items.push((primer.ensure(&keys::UL_CHANNEL_ID)?, c.to_be_bytes().to_vec()));
    }
    for (name, get) in ITEM_GETTERS {
        let Some(v) = get(&l.items) else { continue };
        let ul = ul_for_text(name).expect("jedes Text-Item hat eine UL");
        let bytes = if is_iso7(name) { v.as_bytes().to_vec() } else { klv::utf16be_encode(v) };
        set.items.push((primer.ensure(&ul)?, bytes));
    }
    match l.kind {
        LabelKind::AudioChannel => {
            if let Some(sg) = l.soundfield_group_link_id {
                set.items.push((primer.ensure(&keys::UL_SOUNDFIELD_GROUP_LINK_ID)?, sg.to_vec()));
            }
        }
        LabelKind::SoundfieldGroup => {
            if !l.group_link_ids.is_empty() {
                set.items.push((primer.ensure(&keys::UL_GROUP_OF_SOUNDFIELD_GROUPS_LINK_ID)?, batch16(&l.group_link_ids)));
            }
        }
        LabelKind::GroupOfSoundfieldGroups => {}
    }
    Ok(set)
}

/// Strong-Reference-Batch kodieren (für `SubDescriptors`).
pub fn uid_batch(uids: &[Uuid]) -> Vec<u8> {
    batch16(uids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::McaItems;

    #[test]
    fn channel_label_golden_bytes() {
        let l = McaLabel {
            kind: LabelKind::AudioChannel,
            instance_uid: [1; 16],
            dictionary_id: crate::keys::label_ul(1, 0x01, 0, 0),
            link_id: [2; 16],
            tag_symbol: "chL".into(),
            tag_name: None,
            channel_id: Some(1),
            soundfield_group_link_id: Some([3; 16]),
            group_link_ids: vec![],
            items: McaItems { spoken_language: Some("de".into()), ..Default::default() },
        };
        let mut primer = Primer::default();
        let set = label_to_set(&l, &mut primer).unwrap();
        // Set-Key laut ST 377-4 Tab. 1/2 für AudioChannelLabelSubDescriptor.
        assert_eq!(set.key, [0x06, 0x0E, 0x2B, 0x34, 0x02, 0x53, 0x01, 0x01, 0x0D, 0x01, 0x01, 0x01, 0x01, 0x01, 0x6B, 0x00]);
        // MCA Link ID: UL aus Tab. 3, Wert = 16 Byte UUID unverändert.
        let link_tag = primer.tag_for(&[0x06, 0x0E, 0x2B, 0x34, 0x01, 0x01, 0x01, 0x0E, 0x01, 0x03, 0x07, 0x01, 0x05, 0, 0, 0]).unwrap();
        assert_eq!(set.get(link_tag), Some(&[2u8; 16][..]));
        // Tag Symbol als UTF-16BE.
        let sym_tag = primer.tag_for(&keys::UL_TAG_SYMBOL).unwrap();
        assert_eq!(set.get(sym_tag), Some(&[0, b'c', 0, b'h', 0, b'L'][..]));
        // Spoken Language als ISO7 (einbyte) mit Registry-Version 0D.
        let lang_tag = primer.tag_for(&[0x06, 0x0E, 0x2B, 0x34, 0x01, 0x01, 0x01, 0x0D, 0x03, 0x01, 0x01, 0x02, 0x03, 0x15, 0, 0]).unwrap();
        assert_eq!(set.get(lang_tag), Some(&b"de"[..]));
        assert!(primer.entries.iter().all(|(t, _)| *t >= 0x8000), "MCA-Tags sind dynamisch");
    }
}
