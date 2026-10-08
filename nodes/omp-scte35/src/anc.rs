//! Ancillary-Daten für SCTE 104 (Kapitel 37): SMPTE ST 291 (10-Bit-Wörter, Parität, Prüfsumme),
//! Abbildung nach ST 2010 (DID 0x41 / SDID 0x07, Payload Descriptor, Aufteilung langer Nachrichten)
//! und der MXL-Daten-Grain (`video/smpte291` = RFC-8331-Nutzlast ab dem Length-Feld, 4096 Byte).
//! Reine Funktionen, keine Ein-/Ausgabe.

pub const DID_SCTE104: u8 = 0x41;
pub const SDID_SCTE104: u8 = 0x07;
/// Feste Grain-Größe von `video/smpte291` in MXL.
pub const GRAIN_SIZE: usize = 4096;
/// Nutzdaten (Nachrichtenbytes) je ANC-Paket: 255 Wörter minus Payload Descriptor.
/// Kopf des Grains: Length(16) | ANC_Count(8) | F(2) | reserviert(22).
#[allow(dead_code)]
pub const HEADER_LEN: usize = 6;
pub const MAX_MESSAGE_BYTES_PER_PACKET: usize = 254;

/// Payload Descriptor (ST 2010 Tab. 1): Version 01 in Bit 4/3, Bit 2 fortgesetzt, Bit 1 Folgepaket, Bit 0 Duplikat.
pub fn payload_descriptor(continued: bool, following: bool, duplicate: bool) -> u8 {
    0x08 | ((continued as u8) << 2) | ((following as u8) << 1) | duplicate as u8
}

/// 8-Bit-Wert → 10-Bit-Wort: b8 = gerade Parität über b7…b0, b9 = nicht b8.
pub fn with_parity(v: u8) -> u16 {
    let b8 = (v.count_ones() & 1) as u16;
    (v as u16) | (b8 << 8) | ((b8 ^ 1) << 9)
}

/// ST-291-Prüfsumme: Summe der Bits b8…b0 von DID, SDID, DC und allen UDW (9 Bit), b9 = nicht b8.
fn checksum(words: &[u16]) -> u16 {
    let sum: u32 = words.iter().map(|w| (w & 0x1FF) as u32).sum::<u32>() & 0x1FF;
    let b8 = (sum >> 8) & 1;
    (sum as u16) | (((b8 ^ 1) as u16) << 9)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AncPacket {
    pub c_not_y: bool,
    pub line: u16,
    pub offset: u16,
    pub did: u8,
    pub sdid: u8,
    /// Nutzdatenbytes (8 Bit, ohne Parität).
    pub udw: Vec<u8>,
}

/// Teilt eine SCTE-104-Nachricht in ANC-Pakete nach ST 2010 (§5.2/5.4).
pub fn scte104_packets(message: &[u8], line: u16, offset: u16, duplicate: bool) -> Vec<AncPacket> {
    let chunks: Vec<&[u8]> = message.chunks(MAX_MESSAGE_BYTES_PER_PACKET).collect();
    let n = chunks.len();
    chunks
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let mut udw = Vec::with_capacity(c.len() + 1);
            udw.push(payload_descriptor(i + 1 < n, i > 0, duplicate));
            udw.extend_from_slice(c);
            AncPacket { c_not_y: false, line, offset, did: DID_SCTE104, sdid: SDID_SCTE104, udw }
        })
        .collect()
}

#[cfg(test)]
/// Setzt die Nachricht aus den Paketen (in Reihenfolge) wieder zusammen — Gegenstück für Prüfung und Tests.
pub fn reassemble_scte104(packets: &[AncPacket]) -> Result<(Vec<u8>, bool), String> {
    let mut out = Vec::new();
    let mut duplicate = false;
    for (i, p) in packets.iter().enumerate() {
        if (p.did, p.sdid) != (DID_SCTE104, SDID_SCTE104) {
            return Err("kein SCTE-104-Paket (DID/SDID)".to_string());
        }
        let pd = *p.udw.first().ok_or("leeres Paket")?;
        if pd & 0x18 != 0x08 || pd & 0xE0 != 0 {
            return Err(format!("Payload Descriptor 0x{pd:02X}: Version/Reserve falsch"));
        }
        let (continued, following) = (pd & 4 != 0, pd & 2 != 0);
        if following != (i > 0) || continued != (i + 1 < packets.len()) {
            return Err("Fortsetzungs-Flags passen nicht zur Paketfolge".to_string());
        }
        duplicate |= pd & 1 != 0;
        out.extend_from_slice(&p.udw[1..]);
    }
    Ok((out, duplicate))
}

struct BitWriter {
    out: Vec<u8>,
    acc: u64,
    nbits: u32,
}

impl BitWriter {
    fn new() -> Self {
        BitWriter { out: Vec::new(), acc: 0, nbits: 0 }
    }
    fn put(&mut self, value: u32, bits: u32) {
        self.acc = (self.acc << bits) | (value as u64 & ((1u64 << bits) - 1));
        self.nbits += bits;
        while self.nbits >= 8 {
            self.nbits -= 8;
            self.out.push((self.acc >> self.nbits) as u8);
        }
    }
    fn align32(&mut self) {
        if self.nbits > 0 {
            self.put(0, 8 - self.nbits);
        }
        while self.out.len() % 4 != 0 {
            self.out.push(0);
        }
    }
}

/// Ein ANC-Paket im RFC-8331-Format (C, Zeile, Offset, S, StreamNum, DID, SDID, DC, UDW, Prüfsumme, auf 32 Bit aufgefüllt).
pub fn rfc8331_packet(p: &AncPacket) -> Result<Vec<u8>, String> {
    if p.udw.len() > 255 {
        return Err("mehr als 255 Nutzdatenwörter".to_string());
    }
    if p.line > 0x7FF || p.offset > 0xFFF {
        return Err("Zeile/Offset außerhalb des Bereichs".to_string());
    }
    let did = with_parity(p.did);
    let sdid = with_parity(p.sdid);
    let dc = with_parity(p.udw.len() as u8);
    let udw: Vec<u16> = p.udw.iter().map(|b| with_parity(*b)).collect();
    let mut sum_in = vec![did, sdid, dc];
    sum_in.extend_from_slice(&udw);
    let cs = checksum(&sum_in);
    let mut w = BitWriter::new();
    w.put(p.c_not_y as u32, 1);
    w.put(p.line as u32, 11);
    w.put(p.offset as u32, 12);
    w.put(0, 1); // S: Datenstrom-Flag
    w.put(0, 7); // StreamNum
    for x in [did, sdid, dc] {
        w.put(x as u32, 10);
    }
    for x in &udw {
        w.put(*x as u32, 10);
    }
    w.put(cs as u32, 10);
    w.align32();
    Ok(w.out)
}

/// MXL-Daten-Grain (4096 Byte) aus Paketen: Length(16) | ANC_Count(8) | F(2)+reserviert(22) | Pakete | Nullen.
pub fn mxl_grain(packets: &[AncPacket]) -> Result<Vec<u8>, String> {
    if packets.len() > 255 {
        return Err("mehr als 255 ANC-Pakete in einem Grain".to_string());
    }
    let mut body = Vec::new();
    for p in packets {
        body.extend_from_slice(&rfc8331_packet(p)?);
    }
    let mut g = Vec::with_capacity(GRAIN_SIZE);
    g.extend_from_slice(&u16::try_from(body.len()).map_err(|_| "Length-Überlauf".to_string())?.to_be_bytes());
    g.push(packets.len() as u8);
    g.extend_from_slice(&[0, 0, 0]); // F + reserviert
    g.extend_from_slice(&body);
    if g.len() > GRAIN_SIZE {
        return Err(format!("ANC-Nutzlast {} Byte passt nicht in einen Grain ({GRAIN_SIZE})", g.len()));
    }
    g.resize(GRAIN_SIZE, 0);
    Ok(g)
}

#[cfg(test)]
struct BitReader<'a> {
    d: &'a [u8],
    pos: usize,
}

#[cfg(test)]
impl BitReader<'_> {
    fn get(&mut self, bits: usize) -> Result<u32, String> {
        if self.pos + bits > self.d.len() * 8 {
            return Err("Paket abgeschnitten".to_string());
        }
        let mut v = 0u32;
        for _ in 0..bits {
            v = (v << 1) | ((self.d[self.pos / 8] >> (7 - self.pos % 8)) & 1) as u32;
            self.pos += 1;
        }
        Ok(v)
    }
}

#[cfg(test)]
fn strip_parity(w: u16) -> Result<u8, String> {
    let v = (w & 0xFF) as u8;
    if with_parity(v) != w {
        return Err(format!("Paritätsfehler im Wort 0x{w:03X}"));
    }
    Ok(v)
}

#[cfg(test)]
/// Liest einen Grain zurück (Prüfung: Length, ANC_Count, Parität, Prüfsumme). Gegenstück zu [`mxl_grain`].
pub fn parse_mxl_grain(g: &[u8]) -> Result<Vec<AncPacket>, String> {
    if g.len() < HEADER_LEN {
        return Err("Grain zu kurz".to_string());
    }
    let length = u16::from_be_bytes([g[0], g[1]]) as usize;
    let count = g[2] as usize;
    if HEADER_LEN + length > g.len() {
        return Err("Length reicht über den Grain hinaus".to_string());
    }
    let mut r = BitReader { d: &g[HEADER_LEN..HEADER_LEN + length], pos: 0 };
    let mut out = Vec::new();
    for _ in 0..count {
        let start = r.pos;
        let c = r.get(1)? == 1;
        let line = r.get(11)? as u16;
        let offset = r.get(12)? as u16;
        r.get(8)?; // S + StreamNum
        let did_w = r.get(10)? as u16;
        let sdid_w = r.get(10)? as u16;
        let dc_w = r.get(10)? as u16;
        let did = strip_parity(did_w)?;
        let sdid = strip_parity(sdid_w)?;
        let dc = strip_parity(dc_w)? as usize;
        let mut words = vec![did_w, sdid_w, dc_w];
        let mut udw = Vec::with_capacity(dc);
        for _ in 0..dc {
            let w = r.get(10)? as u16;
            words.push(w);
            udw.push(strip_parity(w)?);
        }
        let cs = r.get(10)? as u16;
        if cs != checksum(&words) {
            return Err("ANC-Prüfsumme falsch".to_string());
        }
        // auf 32 Bit aufgefüllt
        let used = r.pos - start;
        r.pos = start + used.div_ceil(32) * 32;
        out.push(AncPacket { c_not_y: c, line, offset, did, sdid, udw });
    }
    if r.pos / 8 != length {
        return Err(format!("Length {length} passt nicht zu den {} gelesenen Byte", r.pos / 8));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parity_words_follow_st291() {
        // 0x00: gerade Parität → b8=0, b9=1; 0x01: ungerade → b8=1, b9=0
        assert_eq!(with_parity(0x00), 0x200);
        assert_eq!(with_parity(0x01), 0x101);
        assert_eq!(with_parity(0x41), 0x241); // zwei Einsen → gerade → b8=0, b9=1
        assert_eq!(with_parity(0x07), 0x107); // drei Einsen → ungerade → b8=1, b9=0
    }

    #[test]
    fn payload_descriptor_values_match_st2010() {
        assert_eq!(payload_descriptor(false, false, false), 0x08);
        assert_eq!(payload_descriptor(true, false, false), 0x0C);
        assert_eq!(payload_descriptor(true, true, false), 0x0E);
        assert_eq!(payload_descriptor(false, true, true), 0x0B);
    }

    #[test]
    fn short_message_is_one_packet_with_descriptor_08() {
        let msg: Vec<u8> = (0..40).collect();
        let p = scte104_packets(&msg, 9, 0, false);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].udw[0], 0x08);
        assert_eq!(&p[0].udw[1..], msg.as_slice());
        assert_eq!((p[0].did, p[0].sdid), (0x41, 0x07));
    }

    #[test]
    fn long_message_is_split_with_continuation_flags_and_reassembles() {
        let msg: Vec<u8> = (0..600u32).map(|i| (i % 251) as u8).collect();
        let p = scte104_packets(&msg, 9, 0, true);
        assert_eq!(p.len(), 3);
        assert_eq!([p[0].udw[0], p[1].udw[0], p[2].udw[0]], [0x0D, 0x0F, 0x0B]);
        assert!(p.iter().all(|x| x.udw.len() <= 255));
        let (back, dup) = reassemble_scte104(&p).unwrap();
        assert_eq!(back, msg);
        assert!(dup);
    }

    #[test]
    fn grain_has_rfc8331_header_and_round_trips() {
        let msg = crate::scte104::encode_mom(&crate::cue::Cue::Out { event_id: 5, duration_ms: Some(30_000), auto_return: true, lead_ms: 4000 }.to_scte104(0).unwrap(), 3).unwrap();
        let packets = scte104_packets(&msg, 9, 0, false);
        let g = mxl_grain(&packets).unwrap();
        assert_eq!(g.len(), GRAIN_SIZE);
        assert_eq!(g[2], 1, "ANC_Count");
        let length = u16::from_be_bytes([g[0], g[1]]) as usize;
        assert_eq!(length % 4, 0, "Pakete sind auf 32 Bit aufgefüllt");
        assert!(g[HEADER_LEN + length..].iter().all(|b| *b == 0));
        let back = parse_mxl_grain(&g).unwrap();
        assert_eq!(back, packets);
        let (m2, _) = reassemble_scte104(&back).unwrap();
        assert_eq!(crate::scte104::parse_mom(&m2).unwrap().message_number, 3);
    }

    #[test]
    fn empty_grain_is_valid() {
        let g = mxl_grain(&[]).unwrap();
        assert_eq!(&g[..HEADER_LEN], &[0, 0, 0, 0, 0, 0]);
        assert!(parse_mxl_grain(&g).unwrap().is_empty());
    }

    #[test]
    fn corrupted_checksum_or_parity_is_detected() {
        let packets = scte104_packets(&[0xFF, 0xFF, 0, 12], 9, 0, false);
        let mut g = mxl_grain(&packets).unwrap();
        g[HEADER_LEN + 5] ^= 0x40; // Bit im DID-Wort
        assert!(parse_mxl_grain(&g).is_err());
    }

    #[test]
    fn bad_values_are_rejected() {
        let mut p = scte104_packets(&[1], 9, 0, false).remove(0);
        p.line = 0x800;
        assert!(rfc8331_packet(&p).is_err());
    }
}
