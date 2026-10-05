//! SCTE-35 `splice_info_section` (ANSI/SCTE 35): Aufbau und Prüfung. Reine Funktionen, keine
//! Ein-/Ausgabe. Unterstützt `splice_insert` (Out of Network / Rückkehr, optional mit Dauer und
//! Auto-Return) und `time_signal` mit `segmentation_descriptor` (Placement Opportunities,
//! Programm-/Kapitel-Grenzen). Verschlüsselung, Komponenten-Splices, Bandwidth-Reservation und
//! weitere Descriptor-Typen sind bewusst nicht enthalten.

/// MPEG-2-CRC-32 (Polynom 0x04C11DB7, Start 0xFFFFFFFF, ohne Spiegelung, ohne Endverknüpfung).
pub fn crc32_mpeg(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= (b as u32) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 { (crc << 1) ^ 0x04C1_1DB7 } else { crc << 1 };
        }
    }
    crc
}

const MAX_33: u64 = (1u64 << 33) - 1;
const MAX_40: u64 = (1u64 << 40) - 1;

/// Millisekunden → 90-kHz-Takte (SCTE-35-Zeitbasis).
pub fn ms_to_90k(ms: u64) -> u64 {
    ms * 90
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpliceInsert {
    pub event_id: u32,
    /// `true` = aus dem Netz heraus (Werbeblock beginnt), `false` = zurück ins Netz.
    pub out_of_network: bool,
    /// Dauer des Breaks in Millisekunden (nur sinnvoll bei Out).
    pub duration_ms: Option<u64>,
    pub auto_return: bool,
    /// `None` = sofort (`splice_immediate_flag`), sonst PTS (90 kHz) des Spleißpunkts.
    pub pts_90k: Option<u64>,
    pub unique_program_id: u16,
    pub avail_num: u8,
    pub avails_expected: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Segmentation {
    pub event_id: u32,
    /// `segmentation_type_id` (z. B. 0x34 Provider Placement Opportunity Start, 0x35 End,
    /// 0x36/0x37 Distributor, 0x10/0x11 Program Start/End, 0x22/0x23 Break Start/End).
    pub type_id: u8,
    pub duration_ms: Option<u64>,
    pub upid_type: u8,
    pub upid: Vec<u8>,
    pub segment_num: u8,
    pub segments_expected: u8,
    pub pts_90k: Option<u64>,
}

fn push_bits_40(out: &mut Vec<u8>, first_bit: bool, value: u64) {
    // 1 Bit + 6 reservierte Einsen + 33 Bit Wert
    let v = ((first_bit as u64) << 39) | (0x3F << 33) | (value & MAX_33);
    out.extend_from_slice(&v.to_be_bytes()[3..8]);
}

fn splice_time(out: &mut Vec<u8>, pts: Option<u64>) {
    match pts {
        Some(p) => push_bits_40(out, true, p),
        None => out.push(0x7F), // time_specified_flag = 0, 7 reservierte Bits
    }
}

fn wrap(command_type: u8, command: &[u8], descriptors: &[u8]) -> Vec<u8> {
    let mut s = Vec::new();
    s.push(0xFC); // table_id
    let section_length = 11 + command.len() + 2 + descriptors.len() + 4;
    s.push(0x30 | ((section_length >> 8) as u8 & 0x0F)); // syntax=0, private=0, sap_type=3
    s.push((section_length & 0xFF) as u8);
    s.push(0); // protocol_version
    s.extend_from_slice(&[0, 0, 0, 0, 0]); // encrypted_packet, encryption_algorithm, pts_adjustment = 0
    s.push(0); // cw_index
    let cl = command.len();
    s.push(0xFF); // tier (12 Bit, 0xFFF) obere 8 Bit
    s.push(0xF0 | ((cl >> 8) as u8 & 0x0F)); // tier untere 4 Bit + command_length obere 4 Bit
    s.push((cl & 0xFF) as u8);
    s.push(command_type);
    s.extend_from_slice(command);
    s.extend_from_slice(&(descriptors.len() as u16).to_be_bytes());
    s.extend_from_slice(descriptors);
    let crc = crc32_mpeg(&s);
    s.extend_from_slice(&crc.to_be_bytes());
    s
}

pub fn splice_insert(c: &SpliceInsert) -> Result<Vec<u8>, String> {
    if let Some(d) = c.duration_ms
        && ms_to_90k(d) > MAX_33
    {
        return Err("Dauer zu groß (33 Bit bei 90 kHz)".to_string());
    }
    if c.pts_90k.is_some_and(|p| p > MAX_33) {
        return Err("PTS zu groß (33 Bit)".to_string());
    }
    let mut cmd = Vec::new();
    cmd.extend_from_slice(&c.event_id.to_be_bytes());
    cmd.push(0x7F); // cancel=0 + 7 reservierte Bits
    let program_splice = true;
    let duration_flag = c.duration_ms.is_some();
    let immediate = c.pts_90k.is_none();
    cmd.push(((c.out_of_network as u8) << 7) | ((program_splice as u8) << 6) | ((duration_flag as u8) << 5) | ((immediate as u8) << 4) | 0x0F);
    if !immediate {
        splice_time(&mut cmd, c.pts_90k);
    }
    if let Some(d) = c.duration_ms {
        push_bits_40(&mut cmd, c.auto_return, ms_to_90k(d));
    }
    cmd.extend_from_slice(&c.unique_program_id.to_be_bytes());
    cmd.push(c.avail_num);
    cmd.push(c.avails_expected);
    Ok(wrap(0x05, &cmd, &[]))
}

/// `splice_insert` mit gesetztem `splice_event_cancel_indicator` (nimmt ein früheres Event zurück).
pub fn splice_cancel(event_id: u32) -> Vec<u8> {
    let mut cmd = Vec::new();
    cmd.extend_from_slice(&event_id.to_be_bytes());
    cmd.push(0xFF); // cancel=1 + reservierte Bits
    wrap(0x05, &cmd, &[])
}

pub fn time_signal(c: &Segmentation) -> Result<Vec<u8>, String> {
    if c.upid.len() > 255 {
        return Err("UPID länger als 255 Byte".to_string());
    }
    if let Some(d) = c.duration_ms
        && ms_to_90k(d) > MAX_40
    {
        return Err("Dauer zu groß (40 Bit bei 90 kHz)".to_string());
    }
    let mut cmd = Vec::new();
    splice_time(&mut cmd, c.pts_90k);

    let mut d = Vec::new();
    d.extend_from_slice(b"CUEI");
    d.extend_from_slice(&c.event_id.to_be_bytes());
    d.push(0x7F); // cancel=0
    let duration_flag = c.duration_ms.is_some();
    // program_segmentation_flag=1, duration_flag, delivery_not_restricted_flag=1, 5 reservierte Bits
    d.push(0x80 | ((duration_flag as u8) << 6) | 0x20 | 0x1F);
    if let Some(ms) = c.duration_ms {
        d.extend_from_slice(&ms_to_90k(ms).to_be_bytes()[3..8]);
    }
    d.push(c.upid_type);
    d.push(c.upid.len() as u8);
    d.extend_from_slice(&c.upid);
    d.push(c.type_id);
    d.push(c.segment_num);
    d.push(c.segments_expected);
    if matches!(c.type_id, 0x34 | 0x36 | 0x38 | 0x3A) {
        d.extend_from_slice(&[0, 0]); // sub_segment_num, sub_segments_expected
    }
    let mut desc = vec![0x02, d.len() as u8];
    desc.extend_from_slice(&d);
    Ok(wrap(0x06, &cmd, &desc))
}

/// Ergebnis der Prüfung eines Abschnitts.
#[derive(Debug, PartialEq)]
pub struct Parsed {
    pub command_type: u8,
    pub event_id: Option<u32>,
    pub out_of_network: Option<bool>,
    pub duration_ms: Option<u64>,
    pub immediate: Option<bool>,
    pub cancel: bool,
    pub segmentation_type_id: Option<u8>,
}

/// Prüft Länge und CRC und liest die wichtigsten Felder (für Tests und die Anzeige im Node).
pub fn parse(sec: &[u8]) -> Result<Parsed, String> {
    if sec.len() < 18 || sec[0] != 0xFC {
        return Err("kein splice_info_section (table_id ≠ 0xFC)".to_string());
    }
    let section_length = (((sec[1] & 0x0F) as usize) << 8) | sec[2] as usize;
    if section_length + 3 != sec.len() {
        return Err(format!("section_length {section_length} passt nicht zur Länge {}", sec.len()));
    }
    if crc32_mpeg(sec) != 0 {
        return Err("CRC-32 falsch".to_string());
    }
    let cmd_len = (((sec[11] & 0x0F) as usize) << 8) | sec[12] as usize;
    let cmd_type = sec[13];
    let cmd = &sec[14..14 + cmd_len];
    let mut p = Parsed { command_type: cmd_type, event_id: None, out_of_network: None, duration_ms: None, immediate: None, cancel: false, segmentation_type_id: None };
    if cmd_type == 0x05 {
        p.event_id = Some(u32::from_be_bytes([cmd[0], cmd[1], cmd[2], cmd[3]]));
        p.cancel = cmd[4] & 0x80 != 0;
        if !p.cancel {
            let f = cmd[5];
            p.out_of_network = Some(f & 0x80 != 0);
            p.immediate = Some(f & 0x10 != 0);
            let mut i = 6;
            if f & 0x40 != 0 && f & 0x10 == 0 {
                i += if cmd[i] & 0x80 != 0 { 5 } else { 1 };
            }
            if f & 0x20 != 0 {
                let v = u64::from_be_bytes([0, 0, 0, cmd[i], cmd[i + 1], cmd[i + 2], cmd[i + 3], cmd[i + 4]]) & MAX_33;
                p.duration_ms = Some(v / 90);
            }
        }
    }
    if cmd_type == 0x06 {
        let desc_off = 14 + cmd_len;
        let dl = u16::from_be_bytes([sec[desc_off], sec[desc_off + 1]]) as usize;
        let d = &sec[desc_off + 2..desc_off + 2 + dl];
        if d.len() > 2 && d[0] == 0x02 {
            p.event_id = Some(u32::from_be_bytes([d[6], d[7], d[8], d[9]]));
            let flags = d[11];
            let mut i = 12;
            if flags & 0x40 != 0 {
                p.duration_ms = Some(u64::from_be_bytes([0, 0, 0, d[i], d[i + 1], d[i + 2], d[i + 3], d[i + 4]]) / 90);
                i += 5;
            }
            let upid_len = d[i + 1] as usize;
            p.segmentation_type_id = Some(d[i + 2 + upid_len]);
        }
    }
    Ok(p)
}

pub fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect()
}

pub fn to_base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for ch in b.chunks(3) {
        let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if ch.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if ch.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn from_base64(s: &str) -> Option<Vec<u8>> {
    let mut v = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes().filter(|c| *c != b'=') {
        let d = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32;
        buf = buf << 6 | d;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            v.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Beispielabschnitte aus der Praxis/Spezifikation (splice_insert und time_signal): unser CRC
    /// und Parser müssen sie als gültig erkennen — unabhängige Referenz für die eigene Kodierung.
    #[test]
    fn known_reference_sections_have_a_valid_crc_and_parse() {
        let a = from_base64("/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=").unwrap();
        assert_eq!(crc32_mpeg(&a), 0, "CRC der Referenz (splice_insert mit Descriptor)");
        let p = parse(&a).unwrap();
        assert_eq!((p.command_type, p.event_id), (0x05, Some(0x4800008F)));
        let b = from_base64("/DAlAAAAAAAAAP/wFAUAAAABf+/+LRQrAP4BI9MIAAEBAQAAfxV6SQ==").unwrap();
        assert_eq!(crc32_mpeg(&b), 0, "CRC der Referenz (splice_insert)");
    }

    #[test]
    fn splice_insert_out_with_duration_roundtrips() {
        let s = splice_insert(&SpliceInsert { event_id: 4711, out_of_network: true, duration_ms: Some(30_000), auto_return: true, pts_90k: None, unique_program_id: 1, avail_num: 0, avails_expected: 0 }).unwrap();
        let p = parse(&s).unwrap();
        assert_eq!((p.command_type, p.event_id, p.out_of_network, p.duration_ms, p.immediate), (0x05, Some(4711), Some(true), Some(30_000), Some(true)));
        assert!(!p.cancel);
        assert_eq!(s[0], 0xFC);
    }

    #[test]
    fn splice_insert_with_pts_and_return_and_cancel() {
        let s = splice_insert(&SpliceInsert { event_id: 9, out_of_network: false, duration_ms: None, auto_return: false, pts_90k: Some(123_456_789), unique_program_id: 7, avail_num: 1, avails_expected: 2 }).unwrap();
        let p = parse(&s).unwrap();
        assert_eq!((p.out_of_network, p.immediate, p.duration_ms), (Some(false), Some(false), None));
        let c = parse(&splice_cancel(9)).unwrap();
        assert!(c.cancel && c.event_id == Some(9));
    }

    #[test]
    fn time_signal_with_segmentation_descriptor_roundtrips() {
        let s = time_signal(&Segmentation { event_id: 77, type_id: 0x34, duration_ms: Some(60_000), upid_type: 0, upid: vec![], segment_num: 1, segments_expected: 1, pts_90k: None }).unwrap();
        let p = parse(&s).unwrap();
        assert_eq!((p.command_type, p.event_id, p.duration_ms, p.segmentation_type_id), (0x06, Some(77), Some(60_000), Some(0x34)));
        let e = time_signal(&Segmentation { event_id: 77, type_id: 0x35, duration_ms: None, upid_type: 0, upid: vec![], segment_num: 1, segments_expected: 1, pts_90k: Some(900_000) }).unwrap();
        assert_eq!(parse(&e).unwrap().segmentation_type_id, Some(0x35));
    }

    #[test]
    fn corruption_and_limits_are_detected() {
        let mut s = splice_cancel(1);
        let n = s.len();
        s[n - 6] ^= 0x01;
        assert!(parse(&s).unwrap_err().contains("CRC"));
        assert!(splice_insert(&SpliceInsert { event_id: 1, out_of_network: true, duration_ms: Some(u64::MAX / 200), auto_return: true, pts_90k: None, unique_program_id: 0, avail_num: 0, avails_expected: 0 }).is_err());
    }

    #[test]
    fn base64_roundtrip() {
        let s = splice_cancel(5);
        assert_eq!(from_base64(&to_base64(&s)).unwrap(), s);
        assert_eq!(to_hex(&[0xFC, 0x0A]), "FC0A");
    }
}
