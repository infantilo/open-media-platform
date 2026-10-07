//! Schlüssel (ULs) und lokale Tags — alle aus SMPTE ST 377-1:2019, ST 377-4:2021
//! (Tab. 1–6), ST 2067-8:2013 und ST 428-12:2013 übernommen (docs/ENTWURF-MXF-MCA.md).

pub type Ul = [u8; 16];
pub type Uuid = [u8; 16];

/// Partition Pack: `06 0E 2B 34 02 05 01 01 0D 01 02 01 01 <kind> <status> 00`.
pub const PARTITION_PREFIX: [u8; 13] = [0x06, 0x0E, 0x2B, 0x34, 0x02, 0x05, 0x01, 0x01, 0x0D, 0x01, 0x02, 0x01, 0x01];
pub const KIND_HEADER: u8 = 0x02;
pub const KIND_BODY: u8 = 0x03;
pub const KIND_FOOTER: u8 = 0x04;

/// Primer Pack (ST 377-1 Tab. 13).
pub const PRIMER_KEY: Ul = [0x06, 0x0E, 0x2B, 0x34, 0x02, 0x05, 0x01, 0x01, 0x0D, 0x01, 0x02, 0x01, 0x01, 0x05, 0x01, 0x00];
/// Random Index Pack (Tab. 13: Pack-Kind 11h).
pub const RIP_KEY: Ul = [0x06, 0x0E, 0x2B, 0x34, 0x02, 0x05, 0x01, 0x01, 0x0D, 0x01, 0x02, 0x01, 0x01, 0x11, 0x01, 0x00];
/// KLV-Fill (ST 377-1 §6.3.3). Byte 8 (Version) wird beim Vergleich ignoriert.
pub const FILL_KEY: Ul = [0x06, 0x0E, 0x2B, 0x34, 0x01, 0x01, 0x01, 0x02, 0x03, 0x01, 0x02, 0x10, 0x01, 0x00, 0x00, 0x00];

pub fn is_fill(key: &Ul) -> bool {
    key[..7] == FILL_KEY[..7] && key[8..] == FILL_KEY[8..]
}

/// Präfix aller MXF-Strukturmetadaten-Sets (Local Set, 2-Byte-Tag/2-Byte-Länge).
pub const SET_PREFIX: [u8; 14] = [0x06, 0x0E, 0x2B, 0x34, 0x02, 0x53, 0x01, 0x01, 0x0D, 0x01, 0x01, 0x01, 0x01, 0x01];

pub const fn set_key(kind: u8) -> Ul {
    let p = SET_PREFIX;
    [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10], p[11], p[12], p[13], kind, 0x00]
}

/// Wenn `key` ein Strukturmetadaten-Set ist, die Set-Kennung (Byte 15).
pub fn set_kind(key: &Ul) -> Option<u8> {
    (key[..14] == SET_PREFIX && key[15] == 0).then_some(key[14])
}

// Sets (Byte 15), s. ST 377-1 Annex A/B und ST 377-4 Tab. 2.
pub const SET_PREFACE: u8 = 0x2F;
pub const SET_CONTENT_STORAGE: u8 = 0x18;
pub const SET_MATERIAL_PACKAGE: u8 = 0x36;
pub const SET_SOURCE_PACKAGE: u8 = 0x37;
pub const SET_MULTIPLE_DESCRIPTOR: u8 = 0x44;
pub const SET_GENERIC_SOUND_DESCRIPTOR: u8 = 0x42;
pub const SET_AES3_DESCRIPTOR: u8 = 0x47;
pub const SET_WAVE_AUDIO_DESCRIPTOR: u8 = 0x48;
pub const SET_MCA_LABEL: u8 = 0x6A;
pub const SET_MCA_CHANNEL: u8 = 0x6B;
pub const SET_MCA_SOUNDFIELD: u8 = 0x6C;
pub const SET_MCA_GROUP: u8 = 0x6D;

/// Ist `kind` ein Audio-Descriptor, der MCA-SubDescriptors tragen kann?
pub fn is_sound_descriptor(kind: u8) -> bool {
    matches!(kind, SET_GENERIC_SOUND_DESCRIPTOR | SET_AES3_DESCRIPTOR | SET_WAVE_AUDIO_DESCRIPTOR)
}

// Statische Local Tags (ST 377-1 Annex A/B, im Text verifiziert).
pub const TAG_INSTANCE_UID: u16 = 0x3C0A;
pub const TAG_PACKAGES: u16 = 0x1901;
pub const TAG_TRACKS: u16 = 0x4403;
pub const TAG_PACKAGE_DESCRIPTOR: u16 = 0x4701;
pub const TAG_MULTI_SUBDESCRIPTORS: u16 = 0x3F01;
pub const TAG_LINKED_TRACK_ID: u16 = 0x3006;
pub const TAG_CHANNEL_COUNT: u16 = 0x3D07;
pub const TAG_SAMPLING_RATE: u16 = 0x3D03;
pub const TAG_TRACK_ID: u16 = 0x4801;

/// `GenericDescriptor::SubDescriptors` (dynamischer Tag; UL aus ST 377-1 B.2).
pub const UL_SUBDESCRIPTORS: Ul = [0x06, 0x0E, 0x2B, 0x34, 0x01, 0x01, 0x01, 0x09, 0x06, 0x01, 0x01, 0x04, 0x06, 0x10, 0x00, 0x00];

const fn mca_ul(tail: [u8; 8]) -> Ul {
    [0x06, 0x0E, 0x2B, 0x34, 0x01, 0x01, 0x01, 0x0E, tail[0], tail[1], tail[2], tail[3], tail[4], tail[5], tail[6], tail[7]]
}

// MCA-Items (ST 377-4 Tab. 3–5). Alle mit dynamischen Local Tags.
pub const UL_DICTIONARY_ID: Ul = mca_ul([0x01, 0x03, 0x07, 0x01, 0x01, 0, 0, 0]);
pub const UL_LINK_ID: Ul = mca_ul([0x01, 0x03, 0x07, 0x01, 0x05, 0, 0, 0]);
pub const UL_TAG_SYMBOL: Ul = mca_ul([0x01, 0x03, 0x07, 0x01, 0x02, 0, 0, 0]);
pub const UL_TAG_NAME: Ul = mca_ul([0x01, 0x03, 0x07, 0x01, 0x03, 0, 0, 0]);
pub const UL_CHANNEL_ID: Ul = mca_ul([0x01, 0x03, 0x04, 0x0A, 0, 0, 0, 0]);
/// Spoken Language: Registry-Version 0D (nicht 0E!) laut ST 377-4 Tab. 3.
pub const UL_SPOKEN_LANGUAGE: Ul = [0x06, 0x0E, 0x2B, 0x34, 0x01, 0x01, 0x01, 0x0D, 0x03, 0x01, 0x01, 0x02, 0x03, 0x15, 0x00, 0x00];
pub const UL_TITLE: Ul = mca_ul([0x01, 0x05, 0x10, 0, 0, 0, 0, 0]);
pub const UL_TITLE_VERSION: Ul = mca_ul([0x01, 0x05, 0x11, 0, 0, 0, 0, 0]);
pub const UL_TITLE_SUB_VERSION: Ul = mca_ul([0x01, 0x05, 0x12, 0, 0, 0, 0, 0]);
pub const UL_EPISODE: Ul = mca_ul([0x01, 0x05, 0x13, 0, 0, 0, 0, 0]);
pub const UL_PARTITION_KIND: Ul = mca_ul([0x01, 0x04, 0x01, 0x05, 0, 0, 0, 0]);
pub const UL_PARTITION_NUMBER: Ul = mca_ul([0x01, 0x04, 0x01, 0x06, 0, 0, 0, 0]);
pub const UL_AUDIO_CONTENT_KIND: Ul = mca_ul([0x03, 0x02, 0x01, 0x02, 0x20, 0, 0, 0]);
pub const UL_AUDIO_ELEMENT_KIND: Ul = mca_ul([0x03, 0x02, 0x01, 0x02, 0x21, 0, 0, 0]);
pub const UL_CONTENT: Ul = mca_ul([0x03, 0x02, 0x01, 0x02, 0x22, 0, 0, 0]);
pub const UL_USE_CLASS: Ul = mca_ul([0x03, 0x02, 0x01, 0x02, 0x23, 0, 0, 0]);
pub const UL_CONTENT_SUBTYPE: Ul = mca_ul([0x03, 0x02, 0x01, 0x02, 0x24, 0, 0, 0]);
pub const UL_CONTENT_DIFFERENTIATOR: Ul = mca_ul([0x03, 0x02, 0x01, 0x02, 0x25, 0, 0, 0]);
pub const UL_SPOKEN_LANGUAGE_ATTRIBUTE: Ul = mca_ul([0x03, 0x02, 0x01, 0x02, 0x26, 0, 0, 0]);
pub const UL_ADDITIONAL_LANGUAGES: Ul = mca_ul([0x03, 0x02, 0x01, 0x02, 0x27, 0, 0, 0]);
pub const UL_ADDITIONAL_LANGUAGE_ATTRIBUTES: Ul = mca_ul([0x03, 0x02, 0x01, 0x02, 0x28, 0, 0, 0]);
pub const UL_SOUNDFIELD_GROUP_LINK_ID: Ul = mca_ul([0x01, 0x03, 0x07, 0x01, 0x06, 0, 0, 0]);
pub const UL_GROUP_OF_SOUNDFIELD_GROUPS_LINK_ID: Ul = mca_ul([0x01, 0x03, 0x07, 0x01, 0x04, 0, 0, 0]);

/// Label-Dictionary-IDs: Kanäle (ST 428-12 Tab. 1/2 und ST 2067-8 Tab. 1/2),
/// Soundfield Groups (428-12 Tab. 3/4, 2067-8 Tab. 3/4) und Gruppen von
/// Soundfield Groups (2067-8 Tab. 5/6). `facet`: 01 Kanal, 02 SG, 03 GSG.
pub const fn label_ul(facet: u8, b12: u8, b13: u8, b14: u8) -> Ul {
    [0x06, 0x0E, 0x2B, 0x34, 0x04, 0x01, 0x01, 0x0D, 0x03, 0x02, facet, b12, b13, b14, 0x00, 0x00]
}
