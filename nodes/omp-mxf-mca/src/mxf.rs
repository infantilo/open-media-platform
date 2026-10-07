//! MXF-Rohstruktur: Partition Packs, Primer Pack, Header-Metadaten-Sets
//! (SMPTE ST 377-1:2019 §7, §9). Sets werden byte-genau erhalten (unbekannte
//! Items bleiben unverändert), damit der Schreib-Teil (`write.rs`) fremde
//! Dateien nicht verändert.

use std::fmt;
use std::io::{Read, Seek, SeekFrom};

use crate::keys::{self, Ul};
use crate::klv::{self, Klv};

#[derive(Debug)]
pub enum MxfError {
    Io(std::io::Error),
    /// Kein Partition Pack am Dateianfang (auch nicht nach Run-In).
    NotMxf,
    Corrupt(String),
}

impl fmt::Display for MxfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MxfError::Io(e) => write!(f, "E/A-Fehler: {e}"),
            MxfError::NotMxf => write!(f, "keine MXF-Datei (kein Partition Pack gefunden)"),
            MxfError::Corrupt(m) => write!(f, "MXF beschädigt: {m}"),
        }
    }
}

impl std::error::Error for MxfError {}

impl From<std::io::Error> for MxfError {
    fn from(e: std::io::Error) -> Self {
        MxfError::Io(e)
    }
}

fn corrupt<T>(m: impl Into<String>) -> Result<T, MxfError> {
    Err(MxfError::Corrupt(m.into()))
}

// ---------------------------------------------------------------- Partition Pack

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartitionPack {
    pub kind: u8,
    /// 01 open/incomplete, 02 closed/incomplete, 03 open/complete, 04 closed/complete.
    pub status: u8,
    pub major: u16,
    pub minor: u16,
    pub kag_size: u32,
    pub this_partition: u64,
    pub previous_partition: u64,
    pub footer_partition: u64,
    pub header_byte_count: u64,
    pub index_byte_count: u64,
    pub index_sid: u32,
    pub body_offset: u64,
    pub body_sid: u32,
    pub operational_pattern: Ul,
    pub essence_containers: Vec<Ul>,
}

pub fn is_partition_key(key: &Ul) -> bool {
    key[..13] == keys::PARTITION_PREFIX && matches!(key[13], keys::KIND_HEADER | keys::KIND_BODY | keys::KIND_FOOTER) && key[15] == 0
}

impl PartitionPack {
    pub fn parse(key: &Ul, v: &[u8]) -> Result<Self, MxfError> {
        if !is_partition_key(key) || v.len() < 88 {
            return corrupt("Partition Pack zu kurz oder ungültiger Schlüssel");
        }
        let u16at = |o: usize| u16::from_be_bytes([v[o], v[o + 1]]);
        let u32at = |o: usize| u32::from_be_bytes([v[o], v[o + 1], v[o + 2], v[o + 3]]);
        let u64at = |o: usize| u64::from_be_bytes(v[o..o + 8].try_into().unwrap());
        let mut op = [0u8; 16];
        op.copy_from_slice(&v[64..80]);
        let count = u32at(80) as usize;
        let item = u32at(84) as usize;
        if item != 16 || v.len() < 88 + count * 16 {
            return corrupt("EssenceContainers-Batch ungültig");
        }
        let essence_containers = (0..count)
            .map(|i| {
                let mut u = [0u8; 16];
                u.copy_from_slice(&v[88 + i * 16..104 + i * 16]);
                u
            })
            .collect();
        Ok(PartitionPack {
            kind: key[13],
            status: key[14],
            major: u16at(0),
            minor: u16at(2),
            kag_size: u32at(4),
            this_partition: u64at(8),
            previous_partition: u64at(16),
            footer_partition: u64at(24),
            header_byte_count: u64at(32),
            index_byte_count: u64at(40),
            index_sid: u32at(48),
            body_offset: u64at(52),
            body_sid: u32at(60),
            operational_pattern: op,
            essence_containers,
        })
    }

    pub fn key(&self) -> Ul {
        let mut k = [0u8; 16];
        k[..13].copy_from_slice(&keys::PARTITION_PREFIX);
        k[13] = self.kind;
        k[14] = self.status;
        k
    }

    pub fn value(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(88 + self.essence_containers.len() * 16);
        v.extend(self.major.to_be_bytes());
        v.extend(self.minor.to_be_bytes());
        v.extend(self.kag_size.to_be_bytes());
        v.extend(self.this_partition.to_be_bytes());
        v.extend(self.previous_partition.to_be_bytes());
        v.extend(self.footer_partition.to_be_bytes());
        v.extend(self.header_byte_count.to_be_bytes());
        v.extend(self.index_byte_count.to_be_bytes());
        v.extend(self.index_sid.to_be_bytes());
        v.extend(self.body_offset.to_be_bytes());
        v.extend(self.body_sid.to_be_bytes());
        v.extend(self.operational_pattern);
        v.extend((self.essence_containers.len() as u32).to_be_bytes());
        v.extend(16u32.to_be_bytes());
        for e in &self.essence_containers {
            v.extend(e);
        }
        v
    }

    /// Serialisieren (Key + BER-Länge + Wert) mit minimaler BER-Länge.
    pub fn encode(&self) -> Vec<u8> {
        self.encode_with(0)
    }

    /// Wie `encode`, mit mindestens `ber_bytes` Längen-Bytes (z. B. um die
    /// Länge eines vorhandenen Packs zu erhalten, wenn der Encoder 4-Byte-BER nutzte).
    pub fn encode_with(&self, ber_bytes: usize) -> Vec<u8> {
        klv::write_klv(&self.key(), &self.value(), ber_bytes)
    }
}

// ---------------------------------------------------------------- Primer

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Primer {
    pub entries: Vec<(u16, Ul)>,
}

impl Primer {
    pub fn parse(v: &[u8]) -> Result<Self, MxfError> {
        if v.len() < 8 {
            return corrupt("Primer Pack zu kurz");
        }
        let count = u32::from_be_bytes([v[0], v[1], v[2], v[3]]) as usize;
        let item = u32::from_be_bytes([v[4], v[5], v[6], v[7]]) as usize;
        if item != 18 || v.len() < 8 + count * 18 {
            return corrupt("Primer-Batch ungültig");
        }
        let entries = (0..count)
            .map(|i| {
                let o = 8 + i * 18;
                let mut ul = [0u8; 16];
                ul.copy_from_slice(&v[o + 2..o + 18]);
                (u16::from_be_bytes([v[o], v[o + 1]]), ul)
            })
            .collect();
        Ok(Primer { entries })
    }

    pub fn value(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(8 + self.entries.len() * 18);
        v.extend((self.entries.len() as u32).to_be_bytes());
        v.extend(18u32.to_be_bytes());
        for (t, ul) in &self.entries {
            v.extend(t.to_be_bytes());
            v.extend(ul);
        }
        v
    }

    pub fn ul_for(&self, tag: u16) -> Option<&Ul> {
        self.entries.iter().find(|(t, _)| *t == tag).map(|(_, u)| u)
    }

    pub fn tag_for(&self, ul: &Ul) -> Option<u16> {
        self.entries.iter().find(|(_, u)| u == ul).map(|(t, _)| *t)
    }

    /// Tag für `ul` liefern; fehlt der Eintrag, einen dynamischen Tag
    /// (0x8000–0xFFFF, ST 377-1 §9.2.2) vergeben und eintragen.
    pub fn ensure(&mut self, ul: &Ul) -> Result<u16, MxfError> {
        if let Some(t) = self.tag_for(ul) {
            return Ok(t);
        }
        let used: std::collections::HashSet<u16> = self.entries.iter().map(|(t, _)| *t).collect();
        let tag = (0x8000u16..=0xFFFF).find(|t| !used.contains(t)).ok_or_else(|| MxfError::Corrupt("keine dynamischen Local Tags mehr frei".into()))?;
        self.entries.push((tag, *ul));
        Ok(tag)
    }
}

// ---------------------------------------------------------------- Header-Metadaten

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawSet {
    pub key: Ul,
    pub items: Vec<(u16, Vec<u8>)>,
}

impl RawSet {
    pub fn kind(&self) -> Option<u8> {
        keys::set_kind(&self.key)
    }

    pub fn get(&self, tag: u16) -> Option<&[u8]> {
        self.items.iter().find(|(t, _)| *t == tag).map(|(_, v)| v.as_slice())
    }

    pub fn instance_uid(&self) -> Option<[u8; 16]> {
        self.get(keys::TAG_INSTANCE_UID).and_then(|v| v.try_into().ok())
    }

    pub fn set(&mut self, tag: u16, value: Vec<u8>) {
        if let Some(slot) = self.items.iter_mut().find(|(t, _)| *t == tag) {
            slot.1 = value;
        } else {
            self.items.push((tag, value));
        }
    }

    pub fn value(&self) -> Vec<u8> {
        let mut v = Vec::new();
        for (t, d) in &self.items {
            v.extend(t.to_be_bytes());
            v.extend((d.len() as u16).to_be_bytes());
            v.extend(d);
        }
        v
    }

    pub fn encode(&self) -> Vec<u8> {
        klv::write_klv(&self.key, &self.value(), 4)
    }

    fn parse(key: Ul, v: &[u8]) -> Result<Self, MxfError> {
        let mut items = Vec::new();
        let mut p = 0;
        while p < v.len() {
            if p + 4 > v.len() {
                return corrupt("Set-Item abgeschnitten (Tag/Länge)");
            }
            let tag = u16::from_be_bytes([v[p], v[p + 1]]);
            let len = u16::from_be_bytes([v[p + 2], v[p + 3]]) as usize;
            p += 4;
            if p + len > v.len() {
                return corrupt("Set-Item überschreitet die Set-Länge");
            }
            items.push((tag, v[p..p + len].to_vec()));
            p += len;
        }
        Ok(RawSet { key, items })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderItem {
    Set(RawSet),
    /// Unbekanntes KLV (Dark Metadata, andere Set-Arten) — unverändert erhalten.
    Other { key: Ul, value: Vec<u8> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeaderMetadata {
    pub primer: Primer,
    pub items: Vec<HeaderItem>,
}

impl HeaderMetadata {
    /// `bytes` beginnt am Primer Pack (HeaderByteCount Bytes inkl. Fill).
    pub fn parse(bytes: &[u8]) -> Result<Self, MxfError> {
        let first = klv::read_klv(bytes).ok_or_else(|| MxfError::Corrupt("Primer Pack fehlt".into()))?;
        if first.key != keys::PRIMER_KEY {
            return corrupt("Header-Metadaten beginnen nicht mit dem Primer Pack");
        }
        let primer = Primer::parse(first.value)?;
        let mut items = Vec::new();
        let mut pos = first.total;
        while pos < bytes.len() {
            let Some(Klv { key, value, total }) = klv::read_klv(&bytes[pos..]) else {
                return corrupt("KLV in den Header-Metadaten abgeschnitten");
            };
            pos += total;
            if keys::is_fill(&key) {
                continue;
            }
            if keys::set_kind(&key).is_some() {
                items.push(HeaderItem::Set(RawSet::parse(key, value)?));
            } else {
                items.push(HeaderItem::Other { key, value: value.to_vec() });
            }
        }
        Ok(HeaderMetadata { primer, items })
    }

    /// Serialisieren (Primer + Sets), optional mit Fill auf KAG-Raster.
    /// `abs_start`: absolute Dateiposition des Primer-Beginns (relativ zum
    /// Header-Partition-Start), `kag`: Raster (0/1 = keins). Das Ende wird per
    /// KLV-Fill auf das Raster aufgefüllt; `min_total` stellt eine Mindestlänge
    /// sicher (z. B. um den alten Platz nicht zu unterschreiten).
    pub fn encode(&self, abs_start: u64, kag: u32, min_total: usize) -> Vec<u8> {
        let mut out = klv::write_klv(&keys::PRIMER_KEY, &self.primer.value(), 4);
        for it in &self.items {
            match it {
                HeaderItem::Set(s) => out.extend(s.encode()),
                HeaderItem::Other { key, value } => out.extend(klv::write_klv(key, value, 4)),
            }
        }
        let mut total = out.len().max(min_total);
        if kag > 1 {
            let k = u64::from(kag);
            let end = abs_start + total as u64;
            let aligned = end.div_ceil(k) * k;
            total = (aligned - abs_start) as usize;
        }
        if total > out.len() {
            let mut pad = total - out.len();
            if pad < 20 {
                // Ein Fill braucht mindestens 16 (Key) + 4 (BER mit 4 Byte) = 20 Byte;
                // bei Raster ein weiteres Rasterfeld, sonst genau 20.
                pad = if kag > 1 {
                    let k = kag as usize;
                    pad + k * (20 - pad).div_ceil(k)
                } else {
                    20
                };
            }
            out.extend(fill(pad));
        }
        out
    }

    pub fn sets(&self) -> impl Iterator<Item = &RawSet> {
        self.items.iter().filter_map(|i| if let HeaderItem::Set(s) = i { Some(s) } else { None })
    }

    pub fn sets_mut(&mut self) -> impl Iterator<Item = &mut RawSet> {
        self.items.iter_mut().filter_map(|i| if let HeaderItem::Set(s) = i { Some(s) } else { None })
    }

    pub fn find_by_uid(&self, uid: &[u8; 16]) -> Option<&RawSet> {
        self.sets().find(|s| s.instance_uid().as_ref() == Some(uid))
    }
}

/// KLV-Fill mit genau `total` Bytes Gesamtlänge (>= 20).
pub fn fill(total: usize) -> Vec<u8> {
    debug_assert!(total >= 20);
    let value_len = total - 16 - 4;
    klv::write_klv(&keys::FILL_KEY, &vec![0u8; value_len], 4)
}

// ---------------------------------------------------------------- Dateiebene

/// Maximaler Suchbereich für das erste Partition Pack (Run-In, ST 377-1 §6.4).
const RUN_IN_MAX: usize = 65_536;

/// Position des Header-Partition-Packs (nach einem eventuellen Run-In).
pub fn find_header_partition<R: Read + Seek>(r: &mut R) -> Result<u64, MxfError> {
    r.seek(SeekFrom::Start(0))?;
    let mut buf = Vec::new();
    r.take(RUN_IN_MAX as u64 + 16).read_to_end(&mut buf)?;
    let probe = &keys::PARTITION_PREFIX;
    let mut i = 0;
    while i + 16 <= buf.len() {
        if buf[i..i + 13] == probe[..] && buf[i + 13] == keys::KIND_HEADER && buf[i + 15] == 0 {
            return Ok(i as u64);
        }
        i += 1;
    }
    Err(MxfError::NotMxf)
}

/// Ein KLV-Paket (Key + Länge + Wert) an `pos` aus einer Datei lesen.
pub fn read_klv_at<R: Read + Seek>(r: &mut R, pos: u64) -> Result<(Ul, Vec<u8>, u64), MxfError> {
    r.seek(SeekFrom::Start(pos))?;
    let mut head = [0u8; 16 + 9];
    let n = read_up_to(r, &mut head)?;
    if n < 17 {
        return corrupt(format!("KLV bei {pos} abgeschnitten"));
    }
    let mut key = [0u8; 16];
    key.copy_from_slice(&head[..16]);
    let Some((len, ln)) = klv::read_ber(&head[16..n]) else {
        return corrupt(format!("ungültige BER-Länge bei {pos}"));
    };
    let start = pos + 16 + ln as u64;
    r.seek(SeekFrom::Start(start))?;
    let mut value = vec![0u8; usize::try_from(len).map_err(|_| MxfError::Corrupt("KLV zu groß".into()))?];
    r.read_exact(&mut value)?;
    Ok((key, value, start + len))
}

fn read_up_to<R: Read>(r: &mut R, buf: &mut [u8]) -> Result<usize, MxfError> {
    let mut n = 0;
    while n < buf.len() {
        let k = r.read(&mut buf[n..])?;
        if k == 0 {
            break;
        }
        n += k;
    }
    Ok(n)
}

/// Partition-Offsets aller Partitionen (relativ zum Header-Partition-Start):
/// bevorzugt per Random Index Pack, sonst über die FooterPartition-/
/// PreviousPartition-Kette vom Footer rückwärts.
pub fn partition_offsets<R: Read + Seek>(r: &mut R, header_pos: u64) -> Result<Vec<u64>, MxfError> {
    let (key, value, _) = read_klv_at(r, header_pos)?;
    let header = PartitionPack::parse(&key, &value)?;
    let mut offs = vec![0u64];
    let len = r.seek(SeekFrom::End(0))?;
    // 1) Random Index Pack
    if len >= header_pos + 4 + 20 {
        r.seek(SeekFrom::Start(len - 4))?;
        let mut l4 = [0u8; 4];
        r.read_exact(&mut l4)?;
        let rip_len = u64::from(u32::from_be_bytes(l4));
        if rip_len >= 20 && rip_len <= len - header_pos {
            let (k, v, _) = read_klv_at(r, len - rip_len)?;
            if k == keys::RIP_KEY && v.len() >= 4 && (v.len() - 4) % 12 == 0 {
                for e in v[..v.len() - 4].chunks_exact(12) {
                    offs.push(u64::from_be_bytes(e[4..12].try_into().unwrap()));
                }
                offs.sort_unstable();
                offs.dedup();
                return Ok(offs);
            }
        }
    }
    // 2) Kette ab Footer
    let mut cur = header.footer_partition;
    let mut guard = 0;
    while cur != 0 && guard < 100_000 {
        guard += 1;
        offs.push(cur);
        let (k, v, _) = read_klv_at(r, header_pos + cur)?;
        let p = PartitionPack::parse(&k, &v)?;
        if p.previous_partition >= cur {
            break;
        }
        cur = p.previous_partition;
    }
    offs.sort_unstable();
    offs.dedup();
    Ok(offs)
}

/// Header-Metadaten einer Partition lesen (None, wenn sie keine enthält).
pub fn read_partition_metadata<R: Read + Seek>(r: &mut R, header_pos: u64, offset: u64) -> Result<Option<(PartitionPack, HeaderMetadata)>, MxfError> {
    let (key, value, end) = read_klv_at(r, header_pos + offset)?;
    let pack = PartitionPack::parse(&key, &value)?;
    if pack.header_byte_count == 0 {
        return Ok(None);
    }
    // Ein Fill zwischen Partition Pack und Primer überspringen (§6.4 Punkt i);
    // HeaderByteCount beginnt erst am Primer Pack.
    let mut start = end;
    loop {
        r.seek(SeekFrom::Start(start))?;
        let mut head = [0u8; 16 + 9];
        let n = read_up_to(r, &mut head)?;
        if n < 17 || !keys::is_fill(head[..16].try_into().unwrap()) {
            break;
        }
        let Some((len, ln)) = klv::read_ber(&head[16..n]) else { return corrupt("ungültige BER-Länge im Fill") };
        start += 16 + ln as u64 + len;
    }
    r.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0u8; usize::try_from(pack.header_byte_count).map_err(|_| MxfError::Corrupt("HeaderByteCount zu groß".into()))?];
    r.read_exact(&mut buf)?;
    Ok(Some((pack, HeaderMetadata::parse(&buf)?)))
}
