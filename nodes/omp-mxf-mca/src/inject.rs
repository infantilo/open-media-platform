//! MCA-Labels in eine bestehende MXF-Datei einfügen (ST 377-4).
//!
//! Vorgehen: alle Partitionen mit Header-Metadaten werden neu kodiert (die
//! Labels sind in Header- und Footer-Partition identisch); passt das Ergebnis
//! in den vorhandenen Platz (Fill), wird die Datei an Ort und Stelle
//! überschrieben. Andernfalls wird die Datei neu geschrieben: Essence- und
//! Index-Bytes bleiben unverändert (ihre Offsets sind relativ zum Essence
//! Container), nur Partition-Packs (ThisPartition/PreviousPartition/
//! FooterPartition/HeaderByteCount) und das Random Index Pack werden
//! angepasst. Wachstum erfolgt in Vielfachen des KAG, damit das Raster
//! erhalten bleibt.

use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use crate::keys::{self, Ul, Uuid};
use crate::klv;
use crate::model::{LabelKind, McaItems, McaLabel};
use crate::mxf::{self, HeaderItem, HeaderMetadata, MxfError, PartitionPack, RawSet};
use crate::read;
use crate::vocab;
use crate::write::{label_to_set, uid_batch};

#[derive(Debug)]
pub enum InjectError {
    Mxf(MxfError),
    Plan(String),
}

impl fmt::Display for InjectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InjectError::Mxf(e) => write!(f, "{e}"),
            InjectError::Plan(m) => write!(f, "Label-Plan ungültig: {m}"),
        }
    }
}

impl std::error::Error for InjectError {}

impl From<MxfError> for InjectError {
    fn from(e: MxfError) -> Self {
        InjectError::Mxf(e)
    }
}

impl From<std::io::Error> for InjectError {
    fn from(e: std::io::Error) -> Self {
        InjectError::Mxf(MxfError::Io(e))
    }
}

fn plan_err<T>(m: impl Into<String>) -> Result<T, InjectError> {
    Err(InjectError::Plan(m.into()))
}

// ---------------------------------------------------------------- Plan

#[derive(Debug, Clone)]
pub struct PlanChannel {
    /// Laufende Kanalnummer über alle Audio-Descriptoren der Datei (0-basiert).
    pub index: usize,
    pub dictionary_id: Ul,
    pub symbol: String,
    pub name: Option<String>,
    pub items: McaItems,
    /// Index in `Plan::soundfield_groups`.
    pub soundfield_group: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct PlanGroup {
    pub dictionary_id: Ul,
    pub symbol: String,
    pub name: Option<String>,
    pub items: McaItems,
    /// Nur Soundfield Groups: Indizes in `Plan::groups` (Gruppen von Soundfield Groups).
    pub groups: Vec<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub channels: Vec<PlanChannel>,
    pub soundfield_groups: Vec<PlanGroup>,
    pub groups: Vec<PlanGroup>,
    /// Vorhandene MCA-Labels vorher entfernen (Standard in `Plan::new`).
    pub replace_existing: bool,
}

impl Plan {
    pub fn new() -> Self {
        Plan { replace_existing: true, ..Default::default() }
    }

    /// Prüft den Plan nach ST 377-4/-41; die Fehlertexte sind für Menschen gedacht.
    pub fn validate(&self, total_channels: usize) -> Result<(), InjectError> {
        let mut seen = std::collections::HashSet::new();
        for c in &self.channels {
            if c.index >= total_channels {
                return plan_err(format!("Kanal {} existiert nicht (Datei hat {total_channels} Audiokanäle)", c.index + 1));
            }
            if !seen.insert(c.index) {
                return plan_err(format!("Kanal {} ist mehrfach beschrieben", c.index + 1));
            }
            if let Some(g) = c.soundfield_group
                && g >= self.soundfield_groups.len()
            {
                return plan_err(format!("Kanal {}: unbekannte Soundfield Group {g}", c.index + 1));
            }
        }
        let labels = self.channels.iter().map(|c| (&c.symbol, &c.items)).chain(self.soundfield_groups.iter().chain(&self.groups).map(|g| (&g.symbol, &g.items)));
        for (sym, items) in labels {
            if !vocab::valid_tag_symbol(sym) {
                return plan_err(format!("MCA Tag Symbol „{sym}“ ist ungültig (2–8 alphanumerische Zeichen, Buchstabe zuerst)"));
            }
            if let Some(m) = vocab::validate_items(items).first() {
                return plan_err(format!("{sym}: {m}"));
            }
        }
        for g in &self.soundfield_groups {
            if g.groups.iter().any(|i| *i >= self.groups.len()) {
                return plan_err(format!("Soundfield Group {}: unbekannte Gruppe von Soundfield Groups", g.symbol));
            }
        }
        for (i, g) in self.soundfield_groups.iter().enumerate() {
            if !self.channels.iter().any(|c| c.soundfield_group == Some(i)) {
                return plan_err(format!("Soundfield Group {} enthält keinen Kanal", g.symbol));
            }
        }
        for (i, g) in self.groups.iter().enumerate() {
            if !self.soundfield_groups.iter().any(|s| s.groups.contains(&i)) {
                return plan_err(format!("Gruppe {} enthält keine Soundfield Group", g.symbol));
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- UUIDs

fn random_uuid() -> Uuid {
    let mut b = [0u8; 16];
    let ok = File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_ok();
    if !ok {
        use std::hash::{BuildHasher, Hasher};
        for (i, chunk) in b.chunks_mut(8).enumerate() {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()) + i as u128);
            chunk.copy_from_slice(&h.finish().to_be_bytes());
        }
    }
    // RFC 4122 Version 4; Byte 8 hat damit das 65. Bit = 1 (ST 377-1 Tab. 2: UUID).
    b[6] = (b[6] & 0x0F) | 0x40;
    b[8] = (b[8] & 0x3F) | 0x80;
    b
}

// ---------------------------------------------------------------- Plan → Labels

struct Resolved {
    labels: Vec<McaLabel>,
    /// Index des Audio-Descriptors (in Dateireihenfolge) je Label.
    descriptor_of: Vec<usize>,
}

fn resolve(plan: &Plan, channel_counts: &[u32]) -> Result<Resolved, InjectError> {
    let total: usize = channel_counts.iter().map(|c| *c as usize).sum();
    plan.validate(total)?;
    // Kanalnummer → (Descriptor, Kanal im Descriptor 1-basiert)
    let mut place = Vec::with_capacity(total);
    for (di, n) in channel_counts.iter().enumerate() {
        for c in 0..*n {
            place.push((di, c + 1));
        }
    }
    let sg_link: Vec<Uuid> = plan.soundfield_groups.iter().map(|_| random_uuid()).collect();
    let gsg_link: Vec<Uuid> = plan.groups.iter().map(|_| random_uuid()).collect();
    let mut labels = Vec::new();
    let mut descriptor_of = Vec::new();
    for c in &plan.channels {
        let (di, cid) = place[c.index];
        labels.push(McaLabel {
            kind: LabelKind::AudioChannel,
            instance_uid: random_uuid(),
            dictionary_id: c.dictionary_id,
            link_id: random_uuid(),
            tag_symbol: c.symbol.clone(),
            tag_name: c.name.clone(),
            channel_id: Some(cid),
            soundfield_group_link_id: c.soundfield_group.map(|g| sg_link[g]),
            group_link_ids: Vec::new(),
            items: c.items.clone(),
        });
        descriptor_of.push(di);
    }
    for (i, g) in plan.soundfield_groups.iter().enumerate() {
        // Descriptor des ersten Kanals dieser Gruppe trägt das Gruppen-Label.
        let di = plan.channels.iter().filter(|c| c.soundfield_group == Some(i)).map(|c| place[c.index].0).min().unwrap();
        labels.push(McaLabel {
            kind: LabelKind::SoundfieldGroup,
            instance_uid: random_uuid(),
            dictionary_id: g.dictionary_id,
            link_id: sg_link[i],
            tag_symbol: g.symbol.clone(),
            tag_name: g.name.clone(),
            channel_id: None,
            soundfield_group_link_id: None,
            group_link_ids: g.groups.iter().map(|x| gsg_link[*x]).collect(),
            items: g.items.clone(),
        });
        descriptor_of.push(di);
    }
    for (i, g) in plan.groups.iter().enumerate() {
        let di = plan
            .soundfield_groups
            .iter()
            .enumerate()
            .filter(|(_, s)| s.groups.contains(&i))
            .flat_map(|(si, _)| plan.channels.iter().filter(move |c| c.soundfield_group == Some(si)).map(|c| place[c.index].0))
            .min()
            .unwrap();
        labels.push(McaLabel {
            kind: LabelKind::GroupOfSoundfieldGroups,
            instance_uid: random_uuid(),
            dictionary_id: g.dictionary_id,
            link_id: gsg_link[i],
            tag_symbol: g.symbol.clone(),
            tag_name: g.name.clone(),
            channel_id: None,
            soundfield_group_link_id: None,
            group_link_ids: Vec::new(),
            items: g.items.clone(),
        });
        descriptor_of.push(di);
    }
    Ok(Resolved { labels, descriptor_of })
}

// ---------------------------------------------------------------- Header-Metadaten ändern

fn is_mca_set(s: &RawSet) -> bool {
    matches!(s.kind(), Some(keys::SET_MCA_LABEL | keys::SET_MCA_CHANNEL | keys::SET_MCA_SOUNDFIELD | keys::SET_MCA_GROUP))
}

/// Anzahl der Audiokanäle je Descriptor.
fn channel_counts(hm: &HeaderMetadata) -> Result<Vec<u32>, InjectError> {
    let d = read::sound_descriptors(hm);
    if d.is_empty() {
        return plan_err("die Datei enthält keinen Audio-Descriptor");
    }
    Ok(d.iter().map(|s| s.get(keys::TAG_CHANNEL_COUNT).and_then(|v| <[u8; 4]>::try_from(v).ok()).map_or(1, |b| u32::from_be_bytes(b).max(1))).collect())
}

fn apply(hm: &mut HeaderMetadata, resolved: &Resolved, replace: bool) -> Result<(), InjectError> {
    let sub_tag = hm.primer.ensure(&keys::UL_SUBDESCRIPTORS)?;
    let desc_uids: Vec<Uuid> = read::sound_descriptors(hm).iter().filter_map(|d| d.instance_uid()).collect();
    // 1. vorhandene MCA-Sets der Descriptoren entfernen (und aus deren SubDescriptors austragen)
    let mut remove: Vec<Uuid> = Vec::new();
    let mut kept: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for du in &desc_uids {
        let refs = hm.find_by_uid(du).and_then(|d| d.get(sub_tag)).map(read::batch16).unwrap_or_default();
        let mut keep = Vec::new();
        for r in refs {
            let is_mca = hm.find_by_uid(&r).is_some_and(is_mca_set);
            if is_mca && replace {
                remove.push(r);
            } else {
                keep.push(r);
            }
        }
        kept.insert(*du, keep);
    }
    hm.items.retain(|i| !matches!(i, HeaderItem::Set(s) if s.instance_uid().is_some_and(|u| remove.contains(&u))));
    // 2. neue Sets anhängen und in den SubDescriptors verankern
    let mut add: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for (l, di) in resolved.labels.iter().zip(&resolved.descriptor_of) {
        let set = label_to_set(l, &mut hm.primer)?;
        hm.items.push(HeaderItem::Set(set));
        add.entry(desc_uids[*di]).or_default().push(l.instance_uid);
    }
    for du in &desc_uids {
        let mut refs = kept.remove(du).unwrap_or_default();
        refs.extend(add.remove(du).unwrap_or_default());
        let Some(d) = hm.sets_mut().find(|s| s.instance_uid().as_ref() == Some(du)) else { continue };
        if refs.is_empty() {
            d.items.retain(|(t, _)| *t != sub_tag);
        } else {
            d.set(sub_tag, uid_batch(&refs));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- Datei-Ebene

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectReport {
    pub labels_written: usize,
    pub partitions_rewritten: usize,
    /// true: nur die Header-Metadaten wurden an Ort und Stelle überschrieben.
    pub in_place: bool,
    pub bytes_added: u64,
}

struct PartInfo {
    old_off: u64,
    pack: PartitionPack,
    pack_len: u64,
    /// Anzahl der BER-Längen-Bytes des vorhandenen Packs (bleibt erhalten).
    pack_ber: usize,
    /// Länge des Fill zwischen Pack und Primer.
    lead_fill: u64,
    /// Alte Länge der Header-Metadaten (HeaderByteCount).
    meta_len: u64,
    /// Ende des Partition-Segments (exklusiv, absolut).
    seg_end: u64,
    hm: Option<HeaderMetadata>,
}

/// Random Index Pack: Position und Einträge (BodySID, Offset).
type Rip = Option<(u64, Vec<(u32, u64)>)>;

fn load_partitions(f: &mut File, header_pos: u64, file_len: u64) -> Result<(Vec<PartInfo>, Rip), InjectError> {
    let offsets = mxf::partition_offsets(f, header_pos)?;
    // RIP lesen (Position + Einträge), um ihn später anzupassen und das Segmentende zu kennen.
    let mut rip = None;
    if file_len >= header_pos + 24 {
        f.seek(SeekFrom::Start(file_len - 4))?;
        let mut l4 = [0u8; 4];
        f.read_exact(&mut l4)?;
        let rl = u64::from(u32::from_be_bytes(l4));
        if rl >= 20 && rl <= file_len - header_pos {
            let (k, v, _) = mxf::read_klv_at(f, file_len - rl)?;
            if k == keys::RIP_KEY && v.len() >= 4 && (v.len() - 4) % 12 == 0 {
                let entries = v[..v.len() - 4].chunks_exact(12).map(|e| (u32::from_be_bytes(e[..4].try_into().unwrap()), u64::from_be_bytes(e[4..].try_into().unwrap()))).collect();
                rip = Some((file_len - rl, entries));
            }
        }
    }
    let end_of_parts = rip.as_ref().map_or(file_len, |(p, _)| *p);
    let mut parts = Vec::new();
    for (i, off) in offsets.iter().enumerate() {
        let abs = header_pos + off;
        let (key, value, after_pack) = mxf::read_klv_at(f, abs)?;
        let pack = PartitionPack::parse(&key, &value)?;
        if matches!(pack.status, 0x01 | 0x03) && pack.kind != keys::KIND_BODY {
            return Err(InjectError::Plan("die Datei ist nicht abgeschlossen (open partition) — Labels nur in fertige Dateien einfügen".into()));
        }
        let seg_end = offsets.get(i + 1).map_or(end_of_parts, |n| header_pos + n);
        let mut lead = 0u64;
        let mut hm = None;
        if pack.header_byte_count > 0 {
            let mut p = after_pack;
            loop {
                f.seek(SeekFrom::Start(p))?;
                let mut head = [0u8; 25];
                let mut n = 0;
                while n < head.len() {
                    let k = f.read(&mut head[n..])?;
                    if k == 0 {
                        break;
                    }
                    n += k;
                }
                if n < 17 || !keys::is_fill(head[..16].try_into().unwrap()) {
                    break;
                }
                let Some((len, ln)) = klv::read_ber(&head[16..n]) else { return Err(MxfError::Corrupt("BER im Fill".into()).into()) };
                p += 16 + ln as u64 + len;
            }
            lead = p - after_pack;
            f.seek(SeekFrom::Start(p))?;
            let mut buf = vec![0u8; pack.header_byte_count as usize];
            f.read_exact(&mut buf)?;
            hm = Some(HeaderMetadata::parse(&buf)?);
        }
        parts.push(PartInfo { old_off: *off, pack_len: after_pack - abs, pack_ber: (after_pack - abs) as usize - 16 - value.len(), lead_fill: lead, meta_len: parts_meta_len(&pack), pack, seg_end, hm });
    }
    Ok((parts, rip))
}

fn parts_meta_len(p: &PartitionPack) -> u64 {
    p.header_byte_count
}

/// Labels in `src` einfügen und nach `dst` schreiben (`dst == src` erlaubt;
/// dann wird in place gepatcht bzw. über eine temporäre Datei ersetzt).
pub fn inject(src: &Path, dst: &Path, plan: &Plan) -> Result<InjectReport, InjectError> {
    let mut f = File::open(src)?;
    let file_len = f.metadata()?.len();
    let header_pos = mxf::find_header_partition(&mut f)?;
    let (mut parts, rip) = load_partitions(&mut f, header_pos, file_len)?;
    let first_meta = parts.iter().position(|p| p.hm.is_some()).ok_or_else(|| InjectError::Plan("die Datei enthält keine Header-Metadaten".into()))?;
    let counts = channel_counts(parts[first_meta].hm.as_ref().unwrap())?;
    let resolved = resolve(plan, &counts)?;
    // Header-Metadaten aller Partitionen ändern, neu kodieren, Verschiebung berechnen
    let mut new_meta: Vec<Option<Vec<u8>>> = Vec::new();
    let mut shift = 0i64;
    let mut new_off: HashMap<u64, u64> = HashMap::new();
    let mut in_place = true;
    for p in parts.iter_mut() {
        let off = (p.old_off as i64 + shift) as u64;
        new_off.insert(p.old_off, off);
        if let Some(hm) = p.hm.as_mut() {
            apply(hm, &resolved, plan.replace_existing)?;
            let abs_start = off + p.pack_len + p.lead_fill;
            let bytes = hm.encode(abs_start, p.pack.kag_size, p.meta_len as usize);
            let d = bytes.len() as i64 - p.meta_len as i64;
            if d != 0 {
                in_place = false;
            }
            shift += d;
            new_meta.push(Some(bytes));
        } else {
            new_meta.push(None);
        }
    }
    let report = InjectReport { labels_written: resolved.labels.len(), partitions_rewritten: new_meta.iter().flatten().count(), in_place, bytes_added: shift.max(0) as u64 };
    if in_place {
        drop(f);
        if src != dst {
            fs::copy(src, dst)?;
        }
        let mut w = OpenOptions::new().write(true).open(dst)?;
        for (p, nm) in parts.iter().zip(&new_meta) {
            if let Some(bytes) = nm {
                w.seek(SeekFrom::Start(header_pos + p.old_off + p.pack_len + p.lead_fill))?;
                w.write_all(bytes)?;
            }
        }
        w.flush()?;
        return Ok(report);
    }
    // Neu schreiben
    let tmp = dst.with_extension("mxf.tmp-inject");
    {
        let mut out = BufWriter::new(File::create(&tmp)?);
        // Run-In unverändert
        copy_range(&mut f, &mut out, 0, header_pos)?;
        for (p, nm) in parts.iter().zip(&new_meta) {
            let mut pack = p.pack.clone();
            pack.this_partition = new_off[&p.old_off];
            if p.old_off == 0 {
                pack.this_partition = 0;
            }
            let map = |v: u64| if v == 0 && p.pack.kind == keys::KIND_HEADER { 0 } else { new_off.get(&v).copied().unwrap_or(v) };
            pack.previous_partition = map(p.pack.previous_partition);
            pack.footer_partition = map(p.pack.footer_partition);
            if let Some(b) = nm {
                pack.header_byte_count = b.len() as u64;
            }
            out.write_all(&pack.encode_with(p.pack_ber))?;
            let abs = header_pos + p.old_off;
            // Fill zwischen Pack und Primer unverändert
            copy_range(&mut f, &mut out, abs + p.pack_len, abs + p.pack_len + p.lead_fill)?;
            let rest_from = if let Some(b) = nm {
                out.write_all(b)?;
                abs + p.pack_len + p.lead_fill + p.meta_len
            } else {
                abs + p.pack_len
            };
            copy_range(&mut f, &mut out, rest_from, p.seg_end)?;
        }
        if let Some((_, entries)) = &rip {
            let mut v = Vec::new();
            for (sid, off) in entries {
                v.extend(sid.to_be_bytes());
                v.extend(new_off.get(off).copied().unwrap_or(*off).to_be_bytes());
            }
            let overall = (16 + klv::write_ber(v.len() as u64 + 4, 0).len() + v.len() + 4) as u32;
            v.extend(overall.to_be_bytes());
            out.write_all(&klv::write_klv(&keys::RIP_KEY, &v, 0))?;
        }
        out.flush()?;
    }
    drop(f);
    fs::rename(&tmp, dst)?;
    Ok(report)
}

fn copy_range<W: Write>(f: &mut File, out: &mut W, from: u64, to: u64) -> Result<(), InjectError> {
    if to <= from {
        return Ok(());
    }
    f.seek(SeekFrom::Start(from))?;
    let n = std::io::copy(&mut f.take(to - from), out)?;
    if n != to - from {
        return Err(MxfError::Corrupt("Datei kürzer als erwartet".into()).into());
    }
    Ok(())
}
