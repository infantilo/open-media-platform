//! Baukasten für kleine, synthetische MXF-Dateien (Tests und Werkzeuge):
//! Header-Partition mit Primer/Sets, Body-Partition mit Dummy-Essence,
//! Footer-Partition und optional Random Index Pack.

use crate::keys::{self, Uuid};
use crate::klv;
use crate::model::{McaLabel, SoundDescriptor};
use crate::mxf::{HeaderItem, HeaderMetadata, PartitionPack, Primer, RawSet, fill};
use crate::write::{label_to_set, uid_batch};

pub struct Spec {
    pub kag: u32,
    pub descriptors: Vec<SoundDescriptor>,
    pub multiple_descriptor: bool,
    pub footer_metadata: bool,
    pub rip: bool,
    /// Wie reale Encoder: KLV-Fill zwischen Partition Pack und Primer (auf das KAG-Raster).
    pub fill_after_pack: bool,
}

impl Default for Spec {
    fn default() -> Self {
        Spec { kag: 512, descriptors: Vec::new(), multiple_descriptor: true, footer_metadata: true, rip: true, fill_after_pack: true }
    }
}

pub fn uid(n: u8) -> Uuid {
    let mut u = [0xA0; 16];
    u[15] = n;
    u
}

fn set(kind: u8, items: Vec<(u16, Vec<u8>)>) -> RawSet {
    RawSet { key: keys::set_key(kind), items }
}

pub fn header_metadata(spec: &Spec) -> HeaderMetadata {
    let mut primer = Primer::default();
    let mut items: Vec<HeaderItem> = Vec::new();
    let sub_tag = primer.ensure(&keys::UL_SUBDESCRIPTORS).unwrap();
    let mut desc_sets = Vec::new();
    let mut label_sets = Vec::new();
    let mut desc_uids = Vec::new();
    for d in &spec.descriptors {
        let mut subs = Vec::new();
        for l in &d.labels {
            label_sets.push(label_to_set(l, &mut primer).unwrap());
            subs.push(l.instance_uid);
        }
        let mut dset = set(
            d.set_kind,
            vec![
                (keys::TAG_INSTANCE_UID, d.instance_uid.to_vec()),
                (keys::TAG_LINKED_TRACK_ID, d.linked_track_id.unwrap_or(0).to_be_bytes().to_vec()),
                (keys::TAG_CHANNEL_COUNT, d.channel_count.to_be_bytes().to_vec()),
            ],
        );
        if !subs.is_empty() {
            dset.items.push((sub_tag, uid_batch(&subs)));
        }
        desc_uids.push(d.instance_uid);
        desc_sets.push(dset);
    }
    let pkg_uid = uid(0xF1);
    let top_desc_uid = if spec.multiple_descriptor { uid(0xF2) } else { desc_uids[0] };
    let content_uid = uid(0xF3);
    items.push(HeaderItem::Set(set(keys::SET_PREFACE, vec![(keys::TAG_INSTANCE_UID, uid(0xF0).to_vec())])));
    items.push(HeaderItem::Set(set(keys::SET_CONTENT_STORAGE, vec![(keys::TAG_INSTANCE_UID, content_uid.to_vec()), (keys::TAG_PACKAGES, uid_batch(&[pkg_uid]))])));
    items.push(HeaderItem::Set(set(keys::SET_SOURCE_PACKAGE, vec![(keys::TAG_INSTANCE_UID, pkg_uid.to_vec()), (keys::TAG_PACKAGE_DESCRIPTOR, top_desc_uid.to_vec())])));
    if spec.multiple_descriptor {
        items.push(HeaderItem::Set(set(keys::SET_MULTIPLE_DESCRIPTOR, vec![(keys::TAG_INSTANCE_UID, top_desc_uid.to_vec()), (keys::TAG_MULTI_SUBDESCRIPTORS, uid_batch(&desc_uids))])));
    }
    for d in desc_sets {
        items.push(HeaderItem::Set(d));
    }
    for l in label_sets {
        items.push(HeaderItem::Set(l));
    }
    HeaderMetadata { primer, items }
}

const ESSENCE_KEY: keys::Ul = [0x06, 0x0E, 0x2B, 0x34, 0x01, 0x02, 0x01, 0x01, 0x0D, 0x01, 0x03, 0x01, 0x16, 0x01, 0x03, 0x00];

/// Baut eine vollständige Datei und liefert Bytes.
pub fn build(spec: &Spec) -> Vec<u8> {
    let hm = header_metadata(spec);
    let proto = PartitionPack {
        kind: keys::KIND_HEADER,
        status: 0x04,
        major: 1,
        minor: 3,
        kag_size: spec.kag,
        this_partition: 0,
        previous_partition: 0,
        footer_partition: 0,
        header_byte_count: 0,
        index_byte_count: 0,
        index_sid: 0,
        body_offset: 0,
        body_sid: 0,
        operational_pattern: [0x06, 0x0E, 0x2B, 0x34, 0x04, 0x01, 0x01, 0x01, 0x0D, 0x01, 0x02, 0x01, 0x01, 0x01, 0x09, 0x00],
        essence_containers: vec![[0x06, 0x0E, 0x2B, 0x34, 0x04, 0x01, 0x01, 0x01, 0x0D, 0x01, 0x03, 0x01, 0x02, 0x06, 0x01, 0x00]],
    };
    let pack_len = proto.encode().len();
    let lead_fill = if spec.fill_after_pack && spec.kag > 1 { (spec.kag as usize - pack_len % spec.kag as usize) % spec.kag as usize } else { 0 };
    let lead_fill = if lead_fill > 0 && lead_fill < 20 { lead_fill + spec.kag as usize } else { lead_fill };
    let meta = hm.encode((pack_len + lead_fill) as u64, spec.kag, 0);
    // Header-Partition
    let mut out = Vec::new();
    let mut header = proto.clone();
    header.header_byte_count = meta.len() as u64;
    // Body- und Footer-Offsets sind unabhängig von den Pack-Inhalten (feste Längen), also vorab bestimmbar.
    let header_len = pack_len + lead_fill + meta.len();
    let mut body_bytes = Vec::new();
    let body_proto = PartitionPack { kind: keys::KIND_BODY, status: 0x04, this_partition: header_len as u64, previous_partition: 0, body_sid: 1, ..proto.clone() };
    let body_pack_len = body_proto.encode().len();
    body_bytes.extend(vec![0u8; body_pack_len]); // Platzhalter
    body_bytes.extend(klv::write_klv(&ESSENCE_KEY, &vec![0x11; 1000], 4));
    // KAG-Raster relativ zum Dateianfang
    let mut abs = header_len + body_bytes.len();
    if spec.kag > 1 {
        let k = spec.kag as usize;
        let mut pad = (k - abs % k) % k;
        if pad > 0 && pad < 20 {
            pad += k;
        }
        if pad > 0 {
            body_bytes.extend(fill(pad));
            abs += pad;
        }
    }
    let footer_off = abs as u64;
    let mut footer = PartitionPack { kind: keys::KIND_FOOTER, status: 0x04, this_partition: footer_off, previous_partition: header_len as u64, footer_partition: footer_off, body_sid: 0, ..proto.clone() };
    if spec.footer_metadata {
        footer.header_byte_count = hm.encode(0, 0, 0).len() as u64; // wird unten exakt gesetzt
    }
    header.footer_partition = footer_off;
    let mut body = body_proto;
    body.footer_partition = footer_off;
    body.previous_partition = 0;
    // Zusammenbau
    out.extend(header.encode());
    if lead_fill > 0 {
        out.extend(fill(lead_fill));
    }
    out.extend(&meta);
    let mut b = body.encode();
    b.extend(&body_bytes[body_pack_len..]);
    out.extend(b);
    debug_assert_eq!(out.len() as u64, footer_off);
    if spec.footer_metadata {
        let flen = footer.encode().len() as u64;
        let flead = if spec.fill_after_pack && spec.kag > 1 { let k = u64::from(spec.kag); let l = (k - (footer_off + flen) % k) % k; if l > 0 && l < 20 { l + k } else { l } } else { 0 };
        let fmeta = hm.encode(footer_off + flen + flead, spec.kag, 0);
        footer.header_byte_count = fmeta.len() as u64;
        out.extend(footer.encode());
        if flead > 0 {
            out.extend(fill(flead as usize));
        }
        out.extend(fmeta);
    } else {
        out.extend(footer.encode());
    }
    if spec.rip {
        let mut v = Vec::new();
        for (sid, off) in [(0u32, 0u64), (1, header_len as u64), (0, footer_off)] {
            v.extend(sid.to_be_bytes());
            v.extend(off.to_be_bytes());
        }
        v.extend(0u32.to_be_bytes()); // Platzhalter für die Gesamtlänge
        let mut rip = klv::write_klv(&keys::RIP_KEY, &v, 0);
        let overall = rip.len() as u32;
        let n = rip.len();
        rip[n - 4..].copy_from_slice(&overall.to_be_bytes());
        out.extend(rip);
    }
    out
}

/// Kleine Hilfen zum Erzeugen von Labels.
pub fn channel(symbol: &str, ch_ul: keys::Ul, channel_id: u32, link: u8, sg: Option<u8>) -> McaLabel {
    McaLabel {
        kind: crate::model::LabelKind::AudioChannel,
        instance_uid: uid(0x10 + link),
        dictionary_id: ch_ul,
        link_id: uid(0x40 + link),
        tag_symbol: symbol.into(),
        tag_name: None,
        channel_id: Some(channel_id),
        soundfield_group_link_id: sg.map(|n| uid(0x40 + n)),
        group_link_ids: vec![],
        items: Default::default(),
    }
}

pub fn group(kind: crate::model::LabelKind, symbol: &str, ul: keys::Ul, link: u8, gsgs: &[u8]) -> McaLabel {
    McaLabel {
        kind,
        instance_uid: uid(0x10 + link),
        dictionary_id: ul,
        link_id: uid(0x40 + link),
        tag_symbol: symbol.into(),
        tag_name: None,
        channel_id: None,
        soundfield_group_link_id: None,
        group_link_ids: gsgs.iter().map(|n| uid(0x40 + n)).collect(),
        items: Default::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::label_ul;
    use crate::model::LabelKind::{AudioChannel, GroupOfSoundfieldGroups, SoundfieldGroup};
    use crate::read::{from_header_metadata, read_file};

    fn temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("omp-mxf-mca-{}-{name}.mxf", std::process::id()));
        std::fs::write(&p, bytes).unwrap();
        p
    }

    /// 5.1 als eine Soundfield Group in einer Gruppe „Main Program“; ein
    /// Descriptor mit 6 Kanälen (interleaved).
    fn spec_51() -> Spec {
        let mut chans = vec![
            channel("chL", label_ul(1, 1, 0, 0), 1, 1, Some(20)),
            channel("chR", label_ul(1, 2, 0, 0), 2, 2, Some(20)),
            channel("chC", label_ul(1, 3, 0, 0), 3, 3, Some(20)),
            channel("chLFE", label_ul(1, 4, 0, 0), 4, 4, Some(20)),
            channel("chLs", label_ul(1, 5, 0, 0), 5, 5, Some(20)),
            channel("chRs", label_ul(1, 6, 0, 0), 6, 6, Some(20)),
        ];
        let mut sg = group(SoundfieldGroup, "sg51", label_ul(2, 1, 0, 0), 20, &[30]);
        sg.items.content = Some("PRM".into());
        sg.items.use_class = Some("FCMP".into());
        let mut gsg = group(GroupOfSoundfieldGroups, "MPg", label_ul(3, 0x20, 1, 0), 30, &[]);
        gsg.items.spoken_language = Some("de".into());
        gsg.items.spoken_language_attribute = Some("ORIGINAL".into());
        chans[2].items.spoken_language = Some("en".into()); // Kanalwert hat Vorrang
        let mut labels = chans;
        labels.push(sg);
        labels.push(gsg);
        Spec { descriptors: vec![SoundDescriptor { instance_uid: uid(0xD0), set_kind: keys::SET_WAVE_AUDIO_DESCRIPTOR, linked_track_id: Some(2), channel_count: 6, labels }], ..Default::default() }
    }

    #[test]
    fn reads_51_labels_with_precedence() {
        let p = temp("51", &build(&spec_51()));
        let mca = read_file(&p).unwrap();
        let sum = mca.summarize();
        assert!(sum.issues.is_empty(), "{:?}", sum.issues);
        assert_eq!(sum.channels.len(), 6);
        let c = &sum.channels[2];
        assert_eq!((c.label.symbol.as_str(), c.label.meaning.as_deref(), c.track_id, c.channel_id), ("chC", Some("Center"), Some(2), Some(3)));
        // Kanal C trägt „en“ selbst, alle anderen erben „de“ (GSG → SG → Kanal) und ORIGINAL.
        assert_eq!(c.label.items.spoken_language.as_deref(), Some("en"));
        assert_eq!(sum.channels[0].label.items.spoken_language.as_deref(), Some("de"));
        assert_eq!(sum.channels[0].label.items.spoken_language_attribute.as_deref(), Some("ORIGINAL"));
        assert_eq!(sum.channels[5].label.items.content.as_deref(), Some("PRM"));
        let sg = sum.channels[0].soundfield_group.as_ref().unwrap();
        assert_eq!((sg.symbol.as_str(), sg.name.as_deref()), ("sg51", Some("5.1")));
        assert_eq!(sum.channels[0].groups[0].symbol, "MPg");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn multi_mono_descriptors_and_unlabeled_channels() {
        let mk = |n: u8, sym: &str, ul, lang: &str| {
            let mut l = channel(sym, ul, 1, n, None);
            l.items.spoken_language = Some(lang.into());
            SoundDescriptor { instance_uid: uid(0xD0 + n), set_kind: keys::SET_AES3_DESCRIPTOR, linked_track_id: Some(u32::from(n)), channel_count: 1, labels: vec![l] }
        };
        let bare = SoundDescriptor { instance_uid: uid(0xDF), set_kind: keys::SET_WAVE_AUDIO_DESCRIPTOR, linked_track_id: Some(9), channel_count: 2, labels: vec![] };
        let spec = Spec { descriptors: vec![mk(1, "chL", label_ul(1, 1, 0, 0), "de"), mk(2, "chR", label_ul(1, 2, 0, 0), "fr"), bare], ..Default::default() };
        let mca = read_file(&temp("mono", &build(&spec))).unwrap();
        let sum = mca.summarize();
        assert_eq!(sum.channels.len(), 2);
        assert_eq!((sum.channels[0].track_id, sum.channels[1].track_id), (Some(1), Some(2)));
        assert_eq!(sum.channels[1].label.items.spoken_language.as_deref(), Some("fr"));
        assert_eq!(sum.unlabeled_channels, vec![2, 3]);
    }

    #[test]
    fn works_without_rip_and_with_header_only_metadata() {
        for (rip, footer) in [(false, true), (false, false), (true, false)] {
            let spec = Spec { rip, footer_metadata: footer, ..spec_51() };
            let mca = read_file(&temp(&format!("v{rip}{footer}"), &build(&spec))).unwrap();
            assert_eq!(mca.summarize().channels.len(), 6, "rip={rip} footer={footer}");
        }
    }

    #[test]
    fn file_without_mca_is_empty_and_non_mxf_is_rejected() {
        let spec = Spec { descriptors: vec![SoundDescriptor { instance_uid: uid(0xD0), set_kind: keys::SET_WAVE_AUDIO_DESCRIPTOR, linked_track_id: Some(1), channel_count: 2, labels: vec![] }], ..Default::default() };
        let mca = read_file(&temp("none", &build(&spec))).unwrap();
        assert!(mca.is_empty());
        assert_eq!(mca.summarize().unlabeled_channels, vec![0, 1]);
        let p = temp("junk", b"das ist keine mxf datei, nur text, mehr als 64 byte lang, wirklich ........");
        assert!(matches!(read_file(&p), Err(crate::mxf::MxfError::NotMxf)));
    }

    #[test]
    fn header_metadata_round_trips_byte_exact_sets() {
        let spec = spec_51();
        let hm = header_metadata(&spec);
        let bytes = hm.encode(0, 512, 0);
        assert_eq!(bytes.len() % 512, 0);
        let again = HeaderMetadata::parse(&bytes).unwrap();
        assert_eq!(again, hm);
        assert_eq!(from_header_metadata(&again).descriptors[0].labels.len(), 8);
        let _ = (AudioChannel,);
    }

    #[test]
    fn partition_layout_is_consistent() {
        let bytes = build(&spec_51());
        let mut c = std::io::Cursor::new(bytes);
        let offs = crate::mxf::partition_offsets(&mut c, 0).unwrap();
        assert_eq!(offs.len(), 3);
        // KAG-Raster: jede Partition beginnt auf einem 512-Byte-Raster (Fill sorgt dafür).
        for o in &offs {
            assert_eq!(o % 512, 0, "Partition bei {o} nicht auf dem Raster");
        }
    }
}
