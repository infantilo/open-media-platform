//! Fragmentiertes MP4 (ISO BMFF, „CMAF-artig“) für TAMS-Objects mit Initialisierungssegment (AppNote 0024).
//!
//! Aufbau eines fragmentierten Stroms: `ftyp` + `moov` (= **Init-Segment**), dann je Fragment `moof` + `mdat` (= **Medien-Segment**),
//! am Ende optional `mfra`. TAMS legt das Init-Segment als eigenes Object ab und verweist von jedem Segment darauf
//! (`init_object_id`); Zeit: `Flow-Zeit = ts_offset + Objektzeit`, die Objektzeit des ersten Samples ist
//! `(tfdt + kleinster Kompositionsversatz) / Zeitskala` (AppNote 0002/0008 sinngemäß).
//!
//! **Grenze:** das ist ISO-BMFF-Fragmentierung, wie sie GStreamers `qtmux` erzeugt, **keine** auf CMAF-Marken (`cmfc`) geprüfte
//! Ausgabe; der CMAF-Muxer `cmafmux` ist auf diesem Rechner nicht vorhanden (Entwurf TAMS §5, D-T1).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoxRef {
    pub typ: [u8; 4],
    /// Beginn des Kastens (inkl. Kopf) in den Daten.
    pub start: usize,
    /// Gesamtgröße inkl. Kopf.
    pub size: usize,
    /// Länge des Kopfes (8 oder 16).
    pub header: usize,
}

impl BoxRef {
    pub fn body<'a>(&self, d: &'a [u8]) -> &'a [u8] {
        &d[self.start + self.header..self.start + self.size]
    }
    pub fn bytes<'a>(&self, d: &'a [u8]) -> &'a [u8] {
        &d[self.start..self.start + self.size]
    }
}

/// Der Kasten bei `at` (muss vollständig in `d[..end]` liegen).
fn box_at(d: &[u8], at: usize, end: usize) -> Option<BoxRef> {
    let h = d.get(at..at.checked_add(8)?)?;
    let mut size = u32::from_be_bytes(h[0..4].try_into().ok()?) as usize;
    let typ: [u8; 4] = h[4..8].try_into().ok()?;
    let mut header = 8;
    if size == 1 {
        let b = d.get(at + 8..at + 16)?;
        size = usize::try_from(u64::from_be_bytes(b.try_into().ok()?)).ok()?;
        header = 16;
    } else if size == 0 {
        size = end.checked_sub(at)?; // erstreckt sich bis zum Ende
    }
    (size >= header && at.checked_add(size)? <= end).then_some(BoxRef { typ, start: at, size, header })
}

/// Alle Kästen einer Ebene. `None`, wenn sie sich nicht sauber bis zum Ende aufteilen lässt.
pub fn boxes(d: &[u8]) -> Option<Vec<BoxRef>> {
    children(d, 0, d.len())
}

fn children(d: &[u8], from: usize, to: usize) -> Option<Vec<BoxRef>> {
    let mut out = Vec::new();
    let mut i = from;
    while i < to {
        let b = box_at(d, i, to)?;
        i += b.size;
        out.push(b);
    }
    Some(out)
}

fn find<'a>(list: &'a [BoxRef], typ: &[u8; 4]) -> Option<&'a BoxRef> {
    list.iter().find(|b| &b.typ == typ)
}

/// Sieht der Anfang wie fragmentiertes MP4 aus (`ftyp`, `styp` oder `moof` als erster Kasten)?
pub fn looks_like_mp4(d: &[u8]) -> bool {
    d.len() >= 8 && matches!(&d[4..8], b"ftyp" | b"styp" | b"moof" | b"moov")
}

/// Zerlegt `data` in Init-Segment (alles vor dem ersten `moof`: `ftyp` + `moov`) und Medien-Segment (`moof`/`mdat`-Paare; ein
/// abschließendes `mfra` entfällt). `None`, wenn kein `moov` oder kein `moof` darin liegt.
pub fn split(data: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let list = boxes(data)?;
    let first_moof = list.iter().position(|b| &b.typ == b"moof")?;
    find(&list[..first_moof], b"moov")?;
    let init: Vec<u8> = list[..first_moof].iter().flat_map(|b| b.bytes(data).iter().copied()).collect();
    let media: Vec<u8> = list[first_moof..].iter().filter(|b| matches!(&b.typ, b"moof" | b"mdat" | b"styp" | b"sidx")).flat_map(|b| b.bytes(data).iter().copied()).collect();
    Some((init, media))
}

/// Zeitskala (Ticks je Sekunde) der ersten Spur aus dem Init-Segment (`moov/trak/mdia/mdhd`).
pub fn timescale(init: &[u8]) -> Option<u32> {
    let top = boxes(init)?;
    let moov = find(&top, b"moov")?;
    let m = children(init, moov.start + moov.header, moov.start + moov.size)?;
    let trak = find(&m, b"trak")?;
    let t = children(init, trak.start + trak.header, trak.start + trak.size)?;
    let mdia = find(&t, b"mdia")?;
    let md = children(init, mdia.start + mdia.header, mdia.start + mdia.size)?;
    let mdhd = find(&md, b"mdhd")?.body(init);
    // Version 0: Version/Flags(4) Erstellt(4) Geändert(4) Zeitskala(4); Version 1: 4 + 8 + 8 + Zeitskala(4)
    let off = if *mdhd.first()? == 1 { 20 } else { 12 };
    let ts = u32::from_be_bytes(mdhd.get(off..off + 4)?.try_into().ok()?);
    (ts > 0).then_some(ts)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fragment {
    /// `tfdt`: Dekodierzeit des ersten Samples in Ticks.
    pub base_decode_time: u64,
    /// Summe der `trun`-Sampleanzahlen.
    pub sample_count: u64,
    /// Summe der Sampledauern in Ticks (aus `trun` bzw. `tfhd`-Standard).
    pub duration_ticks: u64,
    /// Kleinster Kompositionsversatz (Ticks); 0 ohne B-Bilder.
    pub min_cts_offset: i64,
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// Liest ein Medien-Segment (`moof`/`mdat`-Paare einer Spur). Mehrere `moof` werden zusammengezählt, `tfdt` ist das des ersten.
pub fn fragment_info(media: &[u8]) -> Option<Fragment> {
    let list = boxes(media)?;
    let mut base = None;
    let (mut count, mut dur, mut min_cts) = (0u64, 0u64, i64::MAX);
    for moof in list.iter().filter(|b| &b.typ == b"moof") {
        let m = children(media, moof.start + moof.header, moof.start + moof.size)?;
        for traf in m.iter().filter(|b| &b.typ == b"traf") {
            let t = children(media, traf.start + traf.header, traf.start + traf.size)?;
            let tfhd = find(&t, b"tfhd")?.body(media);
            let tfhd_flags = be32(tfhd, 0)? & 0x00ff_ffff;
            // track_id(4); dann je nach Flags: base_data_offset(8) 0x1, sample_description_index(4) 0x2, default_sample_duration(4) 0x8
            let mut p = 8;
            if tfhd_flags & 0x1 != 0 {
                p += 8;
            }
            if tfhd_flags & 0x2 != 0 {
                p += 4;
            }
            let default_dur = if tfhd_flags & 0x8 != 0 { be32(tfhd, p)? as u64 } else { 0 };
            if base.is_none() {
                let tfdt = find(&t, b"tfdt")?.body(media);
                base = Some(if *tfdt.first()? == 1 { u64::from_be_bytes(tfdt.get(4..12)?.try_into().ok()?) } else { be32(tfdt, 4)? as u64 });
            }
            for trun in t.iter().filter(|b| &b.typ == b"trun") {
                let b = trun.body(media);
                let version = *b.first()?;
                let flags = be32(b, 0)? & 0x00ff_ffff;
                let n = be32(b, 4)? as u64;
                let mut q = 8;
                if flags & 0x1 != 0 {
                    q += 4;
                }
                if flags & 0x4 != 0 {
                    q += 4;
                }
                let per = [0x100u32, 0x200, 0x400, 0x800].iter().filter(|f| flags & **f != 0).count() * 4;
                for i in 0..n as usize {
                    let mut r = q + i * per;
                    let mut d = default_dur;
                    if flags & 0x100 != 0 {
                        d = be32(b, r)? as u64;
                        r += 4;
                    }
                    if flags & 0x200 != 0 {
                        r += 4;
                    }
                    if flags & 0x400 != 0 {
                        r += 4;
                    }
                    if flags & 0x800 != 0 {
                        let raw = be32(b, r)?;
                        let cts = if version == 0 { raw as i64 } else { raw as i32 as i64 };
                        min_cts = min_cts.min(cts);
                    }
                    dur += d;
                }
                count += n;
            }
        }
    }
    Some(Fragment { base_decode_time: base?, sample_count: count, duration_ticks: dur, min_cts_offset: if min_cts == i64::MAX { 0 } else { min_cts } })
}

/// Verschiebt die `tfdt`-Werte **aller** Fragmente in `media` um `delta_ticks` (für das Zusammensetzen mehrerer Segmente zu einem
/// durchgehenden Strom). `false`, wenn ein `tfdt` fehlt, nicht lesbar ist oder der neue Wert nicht in die Version des Kastens
/// passt (Version 0 = 32 Bit, kein negativer Wert).
pub fn shift_base_decode_time(media: &mut [u8], delta_ticks: i64) -> bool {
    let Some(list) = boxes(media) else { return false };
    let mut edits: Vec<(usize, bool, u64)> = Vec::new();
    for moof in list.iter().filter(|b| &b.typ == b"moof") {
        let Some(m) = children(media, moof.start + moof.header, moof.start + moof.size) else { return false };
        for traf in m.iter().filter(|b| &b.typ == b"traf") {
            let Some(t) = children(media, traf.start + traf.header, traf.start + traf.size) else { return false };
            let Some(tfdt) = find(&t, b"tfdt") else { return false };
            let body_at = tfdt.start + tfdt.header;
            let body = tfdt.body(media);
            let v1 = body.first() == Some(&1);
            let old = if v1 { body.get(4..12).and_then(|b| b.try_into().ok()).map(u64::from_be_bytes) } else { be32(body, 4).map(u64::from) };
            let Some(old) = old else { return false };
            let new = old as i128 + delta_ticks as i128;
            if new < 0 || (!v1 && new > u32::MAX as i128) || new > u64::MAX as i128 {
                return false;
            }
            edits.push((body_at + 4, v1, new as u64));
        }
    }
    for (at, v1, v) in edits {
        if v1 {
            media[at..at + 8].copy_from_slice(&v.to_be_bytes());
        } else {
            media[at..at + 4].copy_from_slice(&(v as u32).to_be_bytes());
        }
    }
    true
}

/// Objektzeit des ersten abgespielten Samples in ns: `(tfdt + kleinster Kompositionsversatz) / Zeitskala`.
pub fn first_pts_ns(init: &[u8], media: &[u8]) -> Option<i128> {
    let ts = timescale(init)? as i128;
    let f = fragment_info(media)?;
    Some((f.base_decode_time as i128 + f.min_cts_offset as i128) * 1_000_000_000 / ts)
}

/// Ein vollständiger Kasten der obersten Ebene: Typ und Bytes.
pub type TopBox = ([u8; 4], Vec<u8>);

/// Sammelt einen Bytestrom und gibt vollständige Kästen der obersten Ebene heraus (für den `appsink` hinter `qtmux`).
#[derive(Default)]
pub struct BoxStream {
    buf: Vec<u8>,
}

impl BoxStream {
    /// Hängt Bytes an; liefert die jetzt vollständigen Kästen (Typ, Bytes). `Err`, wenn der Strom kein MP4 ist.
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<TopBox>, String> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        let mut at = 0;
        while self.buf.len() - at >= 8 {
            let size = u32::from_be_bytes(self.buf[at..at + 4].try_into().expect("4 Byte")) as usize;
            let typ: [u8; 4] = self.buf[at + 4..at + 8].try_into().expect("4 Byte");
            if !typ.iter().all(|c| c.is_ascii_alphanumeric() || *c == b' ') || size < 8 {
                return Err(format!("kein MP4-Strom (Kasten {typ:?}, Größe {size})"));
            }
            if self.buf.len() - at < size {
                break;
            }
            out.push((typ, self.buf[at..at + size].to_vec()));
            at += size;
        }
        self.buf.drain(..at);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bx(t: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(t);
        v.extend_from_slice(body);
        v
    }
    fn full(t: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
        let mut b = vec![version];
        b.extend_from_slice(&flags.to_be_bytes()[1..]);
        b.extend_from_slice(body);
        bx(t, &b)
    }
    fn init(timescale: u32) -> Vec<u8> {
        let mut mdhd = vec![0u8; 8]; // erstellt, geändert
        mdhd.extend_from_slice(&timescale.to_be_bytes());
        mdhd.extend_from_slice(&[0u8; 8]); // Dauer, Sprache …
        let mdia = bx(b"mdia", &full(b"mdhd", 0, 0, &mdhd));
        let moov = bx(b"moov", &bx(b"trak", &mdia));
        [bx(b"ftyp", b"iso5\0\0\0\0"), moov].concat()
    }
    /// Fragment mit `n` Samples zu je `dur` Ticks ab `tfdt` (Version 0), optional mit Kompositionsversätzen (Version 1).
    fn fragment(tfdt: u32, n: u32, dur: u32, cts: Option<&[i32]>) -> Vec<u8> {
        let tfhd = full(b"tfhd", 0, 0, &1u32.to_be_bytes());
        let tfdt = full(b"tfdt", 0, 0, &tfdt.to_be_bytes());
        let mut flags = 0x1 | 0x100 | 0x200;
        if cts.is_some() {
            flags |= 0x800;
        }
        let mut body = n.to_be_bytes().to_vec();
        body.extend_from_slice(&0u32.to_be_bytes()); // data_offset
        for i in 0..n as usize {
            body.extend_from_slice(&dur.to_be_bytes());
            body.extend_from_slice(&100u32.to_be_bytes());
            if let Some(c) = cts {
                body.extend_from_slice(&(c[i] as u32).to_be_bytes());
            }
        }
        let trun = full(b"trun", if cts.is_some() { 1 } else { 0 }, flags, &body);
        let moof = bx(b"moof", &bx(b"traf", &[tfhd, tfdt, trun].concat()));
        [moof, bx(b"mdat", &[0u8; 16])].concat()
    }

    #[test]
    fn splits_init_and_media_and_drops_mfra() {
        let stream = [init(90_000), fragment(0, 50, 1800, None), fragment(90_000, 50, 1800, None), bx(b"mfra", b"xxxx")].concat();
        let (i, m) = split(&stream).unwrap();
        assert_eq!(i, init(90_000));
        assert_eq!(m, [fragment(0, 50, 1800, None), fragment(90_000, 50, 1800, None)].concat());
        assert!(split(&init(1)).is_none(), "ohne Fragment");
        assert!(split(b"garbage!").is_none());
    }

    #[test]
    fn reads_timescale_and_fragment_timing() {
        let i = init(90_000);
        assert_eq!(timescale(&i), Some(90_000));
        let m = fragment(180_000, 50, 1800, None);
        let f = fragment_info(&m).unwrap();
        assert_eq!((f.base_decode_time, f.sample_count, f.duration_ticks, f.min_cts_offset), (180_000, 50, 90_000, 0));
        assert_eq!(first_pts_ns(&i, &m), Some(2_000_000_000));
        // Kompositionsversatz (B-Bilder): kleinster Versatz zählt, auch negativ (Version 1)
        let m = fragment(90_000, 4, 3600, Some(&[3600, 7200, 0, 3600]));
        assert_eq!(first_pts_ns(&init(90_000), &m), Some(1_000_000_000));
        let m = fragment(90_000, 2, 3600, Some(&[-3600, 0]));
        assert_eq!(first_pts_ns(&init(90_000), &m), Some(960_000_000));
        // 48-kHz-Ton: 93 Rahmen zu 1024 Ticks
        let m = fragment(0, 93, 1024, None);
        let f = fragment_info(&m).unwrap();
        assert_eq!((f.sample_count, f.duration_ticks), (93, 95_232));
    }

    #[test]
    fn shifting_tfdt_changes_only_the_time() {
        let mut m = fragment(180_000, 50, 1800, None);
        let orig = m.clone();
        assert!(shift_base_decode_time(&mut m, -90_000));
        assert_eq!(fragment_info(&m).unwrap().base_decode_time, 90_000);
        assert_eq!(m.len(), orig.len());
        assert!(shift_base_decode_time(&mut m, 90_000));
        assert_eq!(m, orig, "zurückverschoben = Original");
        // Version 0 passt nicht für negative oder zu große Werte
        let mut m2 = fragment(10, 1, 1800, None);
        assert!(!shift_base_decode_time(&mut m2, -11));
        assert!(!shift_base_decode_time(&mut m2, i64::from(u32::MAX)));
        assert!(!shift_base_decode_time(&mut [0u8; 4], 1));
    }

    #[test]
    fn box_stream_returns_only_complete_boxes_and_rejects_garbage() {
        let all = [init(90_000), fragment(0, 2, 1800, None)].concat();
        let mut s = BoxStream::default();
        let mut got = Vec::new();
        for chunk in all.chunks(7) {
            got.extend(s.push(chunk).unwrap());
        }
        assert_eq!(got.iter().map(|(t, _)| *t).collect::<Vec<_>>(), vec![*b"ftyp", *b"moov", *b"moof", *b"mdat"]);
        assert_eq!(got.iter().flat_map(|(_, b)| b.clone()).collect::<Vec<_>>(), all);
        assert!(BoxStream::default().push(&[0xff; 32]).is_err());
        assert!(looks_like_mp4(&all) && !looks_like_mp4(&[0x47, 0, 0, 0x10, 0, 0, 0, 0, 0]));
    }

    #[test]
    fn truncated_or_inconsistent_data_is_none_not_a_panic() {
        let m = fragment(0, 5, 1800, None);
        for cut in [3, 9, 20, m.len() - 5] {
            assert!(fragment_info(&m[..cut]).is_none() || cut == m.len(), "cut {cut}");
        }
        assert!(timescale(&init(90_000)[..30]).is_none());
        assert!(boxes(&[0, 0, 0, 4, b'f', b'r', b'e', b'e']).is_none(), "Größe kleiner als der Kopf");
    }
}
