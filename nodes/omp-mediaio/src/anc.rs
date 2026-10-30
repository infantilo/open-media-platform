//! Ancillary-Daten (SMPTE ST 291): 10-Bit-Wörter mit Parität und Prüfsumme, RFC-8331-Pakete und der MXL-Daten-Grain
//! (`video/smpte291` = RFC-8331-Nutzlast ab dem Length-Feld, 4096 Byte). Gemeinsam genutzt von `omp-scte35` (SCTE 104),
//! `omp-subtitle-asr` (CEA-608 im CDP, Text-Cues) und den Empfängern (Viewer, Multiviewer). Reine Funktionen, keine Ein-/Ausgabe.

/// Feste Grain-Größe von `video/smpte291` in MXL.
pub const GRAIN_SIZE: usize = 4096;
/// Kopf des Grains: Length(16) | ANC_Count(8) | F(2) | reserviert(22).
pub const HEADER_LEN: usize = 6;

/// 8-Bit-Wert → 10-Bit-Wort: b8 = gerade Parität über b7…b0, b9 = nicht b8.
pub fn with_parity(v: u8) -> u16 {
    let b8 = (v.count_ones() & 1) as u16;
    (v as u16) | (b8 << 8) | ((b8 ^ 1) << 9)
}

/// ST-291-Prüfsumme: Summe der Bits b8…b0 von DID, SDID, DC und allen UDW (9 Bit), b9 = nicht b8.
pub fn checksum(words: &[u16]) -> u16 {
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

struct BitReader<'a> {
    d: &'a [u8],
    pos: usize,
}

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

pub fn strip_parity(w: u16) -> Result<u8, String> {
    let v = (w & 0xFF) as u8;
    if with_parity(v) != w {
        return Err(format!("Paritätsfehler im Wort 0x{w:03X}"));
    }
    Ok(v)
}

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


/// Ein Paket aus [`parse_mxl_grain_lenient`]: der Inhalt plus das Ergebnis der Prüfungen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAnc {
    pub packet: AncPacket,
    /// Datenstrom-Flag S und StreamNum aus dem Kopf (RFC 8331).
    pub s_flag: bool,
    pub stream_num: u8,
    /// Alle 10-Bit-Wörter (DID, SDID, DC, UDW) trugen gültige Parität.
    pub parity_ok: bool,
    pub checksum_ok: bool,
    /// Rohe 10-Bit-Wörter der Nutzdaten (für die Anzeige von Fehlern).
    pub words: usize,
}

/// Ergebnis von [`parse_mxl_grain_lenient`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LenientGrain {
    /// ANC_Count aus dem Kopf.
    pub declared_count: usize,
    pub packets: Vec<ParsedAnc>,
    /// Gesetzt, wenn die Struktur unlesbar ist (zu kurz, Length falsch, Paket abgeschnitten): ab dort sind keine Pakete mehr gelesen.
    pub error: Option<String>,
}

/// Wie [`parse_mxl_grain`], bricht aber bei Paritäts-/Prüfsummenfehlern **nicht** ab: das Paket wird mit Markierung geliefert (für
/// Messgeräte). Nur wenn der Aufbau selbst nicht mehr stimmt, endet das Lesen und `error` sagt warum.
pub fn parse_mxl_grain_lenient(g: &[u8]) -> LenientGrain {
    let mut out = LenientGrain::default();
    if g.len() < HEADER_LEN {
        out.error = Some("Grain kürzer als der Kopf".to_string());
        return out;
    }
    let length = u16::from_be_bytes([g[0], g[1]]) as usize;
    out.declared_count = g[2] as usize;
    if HEADER_LEN + length > g.len() {
        out.error = Some(format!("Length {length} reicht über den Grain ({}) hinaus", g.len()));
        return out;
    }
    let mut r = BitReader { d: &g[HEADER_LEN..HEADER_LEN + length], pos: 0 };
    for i in 0..out.declared_count {
        let start = r.pos;
        let read = (|| -> Result<ParsedAnc, String> {
            let c = r.get(1)? == 1;
            let line = r.get(11)? as u16;
            let offset = r.get(12)? as u16;
            let s_flag = r.get(1)? == 1;
            let stream_num = r.get(7)? as u8;
            let did_w = r.get(10)? as u16;
            let sdid_w = r.get(10)? as u16;
            let dc_w = r.get(10)? as u16;
            let mut parity_ok = true;
            let mut byte = |w: u16| {
                strip_parity(w).unwrap_or_else(|_| {
                    parity_ok = false;
                    (w & 0xFF) as u8
                })
            };
            let (did, sdid, dc) = (byte(did_w), byte(sdid_w), byte(dc_w) as usize);
            let mut words = vec![did_w, sdid_w, dc_w];
            let mut udw = Vec::with_capacity(dc);
            for _ in 0..dc {
                let w = r.get(10)? as u16;
                words.push(w);
                udw.push(byte(w));
            }
            let cs = r.get(10)? as u16;
            let used = r.pos - start;
            r.pos = start + used.div_ceil(32) * 32;
            Ok(ParsedAnc { packet: AncPacket { c_not_y: c, line, offset, did, sdid, udw }, s_flag, stream_num, parity_ok, checksum_ok: cs == checksum(&words), words: dc })
        })();
        match read {
            Ok(p) => out.packets.push(p),
            Err(e) => {
                out.error = Some(format!("Paket {} von {}: {e}", i + 1, out.declared_count));
                break;
            }
        }
    }
    if out.error.is_none() && r.pos / 8 != length {
        out.error = Some(format!("Length {length} passt nicht zu den {} gelesenen Byte", r.pos / 8));
    }
    out
}



// ---------------------------------------------------------------------------
// Text-Cue-Paket (privat): Untertitel als verdrahtbarer Strom für Viewer/Multiviewer
// ---------------------------------------------------------------------------

/// Private DID/SDID des OMP-Text-Cue-Pakets (kein Standard; Gateways betten sie nicht in SDI ein).
pub const DID_OMP_TEXT: u8 = 0x5E;
pub const SDID_OMP_TEXT: u8 = 0x01;
/// Version des Paketaufbaus: `[Version][Folge hi][Folge lo][UTF-8-Text …]`.
const TEXT_VERSION: u8 = 1;
/// Längster Text (Bytes) in einem Paket: 255 Nutzdatenwörter minus 3 Kopfbytes.
pub const MAX_TEXT_BYTES: usize = 252;

/// Paket mit dem aktuell anzuzeigenden Text. `seq` zählt Änderungen (Leser erkennen so ein neues Cue auch bei gleichem Text).
pub fn text_packet(text: &str, seq: u16, line: u16) -> AncPacket {
    let mut end = text.len().min(MAX_TEXT_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut udw = vec![TEXT_VERSION, (seq >> 8) as u8, seq as u8];
    udw.extend_from_slice(&text.as_bytes()[..end]);
    AncPacket { c_not_y: false, line, offset: 0, did: DID_OMP_TEXT, sdid: SDID_OMP_TEXT, udw }
}

/// Liest den Text aus einem Grain: `Some((seq, text))`, wenn ein Text-Cue-Paket enthalten ist; `None` = nichts anzuzeigen
/// (leerer Grain oder nur fremde Pakete).
pub fn parse_text_grain(grain: &[u8]) -> Option<(u16, String)> {
    let packets = parse_mxl_grain(grain).ok()?;
    let p = packets.into_iter().find(|p| p.did == DID_OMP_TEXT && p.sdid == SDID_OMP_TEXT)?;
    if p.udw.len() < 3 || p.udw[0] != TEXT_VERSION {
        return None;
    }
    Some((u16::from_be_bytes([p.udw[1], p.udw[2]]), String::from_utf8_lossy(&p.udw[3..]).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parity_words_follow_st291() {
        assert_eq!(with_parity(0x00), 0x200);
        assert_eq!(with_parity(0x01), 0x101);
        assert_eq!(with_parity(0x41), 0x241);
        assert_eq!(with_parity(0x07), 0x107);
    }

    #[test]
    fn grain_round_trips_and_detects_corruption() {
        let p = AncPacket { c_not_y: false, line: 9, offset: 0, did: 0x61, sdid: 0x01, udw: (0..40).collect() };
        let g = mxl_grain(&[p.clone()]).unwrap();
        assert_eq!(g.len(), GRAIN_SIZE);
        assert_eq!(parse_mxl_grain(&g).unwrap(), vec![p]);
        let mut bad = g.clone();
        bad[HEADER_LEN + 5] ^= 0x40;
        assert!(parse_mxl_grain(&bad).is_err());
    }

    #[test]
    fn empty_grain_is_valid() {
        assert!(parse_mxl_grain(&mxl_grain(&[]).unwrap()).unwrap().is_empty());
    }

    #[test]
    fn text_cue_round_trips_with_umlauts_and_empty_means_none() {
        let g = mxl_grain(&[text_packet("Guten Abend, schön, dass Sie da sind.", 513, 9)]).unwrap();
        assert_eq!(parse_text_grain(&g), Some((513, "Guten Abend, schön, dass Sie da sind.".to_string())));
        assert_eq!(parse_text_grain(&mxl_grain(&[]).unwrap()), None);
    }

    #[test]
    fn long_text_is_cut_on_a_char_boundary() {
        let long = "ä".repeat(200); // 400 Byte
        let (_, t) = parse_text_grain(&mxl_grain(&[text_packet(&long, 1, 9)]).unwrap()).unwrap();
        assert!(t.len() <= MAX_TEXT_BYTES && t.chars().all(|c| c == 'ä'));
    }

    #[test]
    fn lenient_reports_bad_parity_and_checksum_without_aborting() {
        let a = AncPacket { c_not_y: false, line: 9, offset: 0, did: 0x61, sdid: 0x01, udw: vec![1, 2, 3, 4] };
        let b = AncPacket { c_not_y: true, line: 12, offset: 5, did: 0x41, sdid: 0x05, udw: vec![0x28] };
        let mut g = mxl_grain(&[a.clone(), b.clone()]).unwrap();
        let ok = parse_mxl_grain_lenient(&g);
        assert!(ok.error.is_none() && ok.packets.len() == 2);
        assert!(ok.packets.iter().all(|p| p.parity_ok && p.checksum_ok));
        assert_eq!(ok.packets[1].packet, b);
        // Prüfsumme des ersten Pakets zerstören: letztes Wort der Daten liegt vor der Füllung — Byte im Rumpf ändern
        let first_len = rfc8331_packet(&a).unwrap().len();
        g[HEADER_LEN + first_len - 3] ^= 0x01; // niedrige Bits des Prüfsummenworts (die letzten zwei Byte sind Füllung)
        let bad = parse_mxl_grain_lenient(&g);
        assert_eq!(bad.packets.len(), 2, "zweites Paket wird trotzdem gelesen");
        assert!(!bad.packets[0].checksum_ok && bad.packets[1].checksum_ok);
        assert!(parse_mxl_grain(&g).is_err(), "der strenge Leser bricht ab");
    }

    #[test]
    fn lenient_flags_parity_errors_and_structure_errors() {
        let a = AncPacket { c_not_y: false, line: 9, offset: 0, did: 0x61, sdid: 0x01, udw: vec![1] };
        let mut g = mxl_grain(&[a]).unwrap();
        g[HEADER_LEN + 4] ^= 0xC0; // Paritätsbits der DID-Wörter
        let r = parse_mxl_grain_lenient(&g);
        assert!(!r.packets[0].parity_ok);
        let short = parse_mxl_grain_lenient(&[0, 9]);
        assert!(short.error.is_some() && short.packets.is_empty());
        let mut over = mxl_grain(&[]).unwrap();
        over[0] = 0xFF;
        over[1] = 0xFF;
        assert!(parse_mxl_grain_lenient(&over).error.is_some());
        let mut cut = mxl_grain(&[]).unwrap();
        cut[2] = 3; // behauptet drei Pakete, Length 0
        assert!(parse_mxl_grain_lenient(&cut).error.is_some());
    }
}
