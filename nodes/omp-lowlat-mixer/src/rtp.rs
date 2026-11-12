//! RTP-Audio für AES67-Strecken des Studio-Mischers (rein, ohne E/A).
//!
//! Norm-Stand (Regel 10, `UMSETZUNG.md` §0): RTP nach **RFC 3550** (Kopf 12 Byte, Version 2), Nutzlast **L24** nach **RFC 3190**
//! bzw. **L16** nach **RFC 3551** (Netzwerk-Bytefolge, Kanäle verschränkt), Uhr 48 kHz, SDP nach **RFC 4566**, `ts-refclk`/
//! `mediaclk` nach **RFC 7273**. Die AES67-Norm selbst (AES67-2018) und SMPTE ST 2110-30 sind kostenpflichtig und **wurden hier
//! nicht gelesen**; was daraus verwendet wird (48 kHz, Paketzeit 1 ms bzw. 0,125/0,25/0,333/4 ms, bis 8 Kanäle bei 1 ms, DSCP EF,
//! RTP-Zeitstempel aus der PTP-Zeit) stammt aus dem Plattform-Wissen in `omp-aes67-gateway` und ist gegen echte Geräte **ungeprüft**.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    L16,
    L24,
}

impl Format {
    pub fn parse(s: &str) -> Option<Format> {
        match s.trim().to_ascii_uppercase().as_str() {
            "L16" => Some(Format::L16),
            "L24" => Some(Format::L24),
            _ => None,
        }
    }

    pub fn bytes(self) -> usize {
        match self {
            Format::L16 => 2,
            Format::L24 => 3,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Format::L16 => "L16",
            Format::L24 => "L24",
        }
    }
}

pub const SAMPLE_RATE: u32 = 48_000;
pub const HEADER: usize = 12;

/// Paketzeit in ms als SDP-Text (`a=ptime`) für eine Rahmenzahl bei 48 kHz.
pub fn ptime_text(frames: usize) -> String {
    match frames {
        6 => "0.125".into(),
        12 => "0.25".into(),
        16 => "0.333".into(),
        48 => "1".into(),
        192 => "4".into(),
        n => format!("{:.3}", n as f64 * 1000.0 / SAMPLE_RATE as f64),
    }
}

/// Hängt einen RTP-Kopf und die Nutzlast an `buf` (vorher geleert). `frames` = interleaved f32, Länge `n * ch`.
pub fn build_packet(buf: &mut Vec<u8>, pt: u8, seq: u16, ts: u32, ssrc: u32, fmt: Format, frames: &[f32]) {
    buf.clear();
    buf.push(0x80); // V=2, P=0, X=0, CC=0
    buf.push(pt & 0x7F); // M=0
    buf.extend_from_slice(&seq.to_be_bytes());
    buf.extend_from_slice(&ts.to_be_bytes());
    buf.extend_from_slice(&ssrc.to_be_bytes());
    match fmt {
        Format::L24 => {
            for v in frames {
                let s = (v.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
                buf.extend_from_slice(&s.to_be_bytes()[1..4]);
            }
        }
        Format::L16 => {
            for v in frames {
                let s = (v.clamp(-1.0, 1.0) * 32_767.0).round() as i16;
                buf.extend_from_slice(&s.to_be_bytes());
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Parsed<'a> {
    pub seq: u16,
    pub ts: u32,
    pub ssrc: u32,
    pub payload: &'a [u8],
}

/// Prüft Version 2, Nutzlasttyp, ohne Erweiterung/Padding-Spezialfälle (CSRC werden übersprungen).
pub fn parse_packet(data: &[u8], pt: u8) -> Option<Parsed<'_>> {
    if data.len() < HEADER || data[0] >> 6 != 2 {
        return None;
    }
    if data[1] & 0x7F != pt & 0x7F {
        return None;
    }
    let cc = (data[0] & 0x0F) as usize;
    let mut off = HEADER + cc * 4;
    if data[0] & 0x10 != 0 {
        // Kopferweiterung überspringen
        if data.len() < off + 4 {
            return None;
        }
        off += 4 + u16::from_be_bytes([data[off + 2], data[off + 3]]) as usize * 4;
    }
    let mut end = data.len();
    if data[0] & 0x20 != 0 {
        end = end.checked_sub(*data.last()? as usize)?;
    }
    if off > end {
        return None;
    }
    Some(Parsed { seq: u16::from_be_bytes([data[2], data[3]]), ts: u32::from_be_bytes([data[4], data[5], data[6], data[7]]), ssrc: u32::from_be_bytes([data[8], data[9], data[10], data[11]]), payload: &data[off..end] })
}

/// Nutzlast → interleaved f32 (hängt an `out`). Gibt die Rahmenzahl zurück; ein unvollständiger Rahmen am Ende wird verworfen.
pub fn decode_payload(payload: &[u8], fmt: Format, ch: usize, out: &mut Vec<f32>) -> usize {
    let bps = fmt.bytes();
    let frames = payload.len() / (bps * ch);
    out.reserve(frames * ch);
    match fmt {
        Format::L24 => {
            for c in payload[..frames * ch * 3].chunks_exact(3) {
                let v = ((c[0] as i32) << 24 | (c[1] as i32) << 16 | (c[2] as i32) << 8) >> 8;
                out.push(v as f32 / 8_388_608.0);
            }
        }
        Format::L16 => {
            for c in payload[..frames * ch * 2].chunks_exact(2) {
                out.push(i16::from_be_bytes([c[0], c[1]]) as f32 / 32_768.0);
            }
        }
    }
    frames
}

/// SDP-Beschreibung eines gesendeten Stroms (RFC 4566 + RFC 7273). `origin_ip` = Quelladresse des Hosts.
#[allow(clippy::too_many_arguments)]
pub fn sdp(label: &str, session_id: u64, origin_ip: &str, dest_ip: &str, ttl: u32, port: u16, pt: u8, fmt: Format, ch: usize, frames: usize, mac: &str) -> String {
    let is_mcast = dest_ip.split('.').next().and_then(|f| f.parse::<u8>().ok()).is_some_and(|f| (224..=239).contains(&f));
    let conn = if is_mcast { format!("{dest_ip}/{ttl}") } else { dest_ip.to_string() };
    format!(
        "v=0\r\no=- {session_id} {session_id} IN IP4 {origin_ip}\r\ns={label}\r\nc=IN IP4 {conn}\r\nt=0 0\r\nm=audio {port} RTP/AVP {pt}\r\n\
         a=rtpmap:{pt} {}/{}/{ch}\r\na=ptime:{}\r\na=ts-refclk:localmac={mac}\r\na=mediaclk:direct=0\r\na=sendonly\r\n",
        fmt.name(),
        SAMPLE_RATE,
        ptime_text(frames)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn l24_roundtrip_within_one_lsb() {
        let src: Vec<f32> = (0..96).map(|i| ((i as f32) / 96.0 * 2.0 - 1.0) * 0.9).collect();
        let mut buf = Vec::new();
        build_packet(&mut buf, 97, 7, 1000, 0xDEADBEEF, Format::L24, &src);
        assert_eq!(buf.len(), HEADER + 96 * 3);
        let p = parse_packet(&buf, 97).unwrap();
        assert_eq!((p.seq, p.ts, p.ssrc), (7, 1000, 0xDEADBEEF));
        let mut out = Vec::new();
        assert_eq!(decode_payload(p.payload, Format::L24, 2, &mut out), 48);
        for (a, b) in src.iter().zip(&out) {
            assert!((a - b).abs() < 2.0 / 8_388_608.0, "{a} {b}");
        }
    }

    #[test]
    fn l16_roundtrip_and_clipping() {
        let src = vec![1.5f32, -1.5, 0.25, -0.25];
        let mut buf = Vec::new();
        build_packet(&mut buf, 98, 0, 0, 1, Format::L16, &src);
        let mut out = Vec::new();
        decode_payload(parse_packet(&buf, 98).unwrap().payload, Format::L16, 2, &mut out);
        assert!((out[0] - 0.99997).abs() < 1e-4 && (out[1] + 1.0).abs() < 1e-4);
        assert!((out[2] - 0.25).abs() < 1e-4);
    }

    #[test]
    fn network_byte_order_is_big_endian() {
        let mut buf = Vec::new();
        build_packet(&mut buf, 97, 0, 0, 0, Format::L24, &[0.5]);
        // 0.5 * 8388607 = 4194303.5 → 4194304 = 0x400000
        assert_eq!(&buf[HEADER..], &[0x40, 0x00, 0x00]);
        build_packet(&mut buf, 97, 0, 0, 0, Format::L24, &[-0.5]);
        assert_eq!(&buf[HEADER..], &[0xC0, 0x00, 0x00]);
    }

    #[test]
    fn parser_rejects_foreign_packets() {
        let mut buf = Vec::new();
        build_packet(&mut buf, 97, 1, 1, 1, Format::L24, &[0.0; 4]);
        assert!(parse_packet(&buf, 96).is_none(), "falscher Nutzlasttyp");
        let mut bad = buf.clone();
        bad[0] = 0x40;
        assert!(parse_packet(&bad, 97).is_none(), "Version 1");
        assert!(parse_packet(&buf[..8], 97).is_none(), "zu kurz");
    }

    #[test]
    fn partial_frame_is_dropped() {
        let mut out = Vec::new();
        assert_eq!(decode_payload(&[0; 7], Format::L24, 1, &mut out), 2);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn sdp_has_required_lines() {
        let s = sdp("Studio", 1, "10.0.0.5", "239.69.1.1", 32, 5004, 97, Format::L24, 8, 48, "aa-bb-cc-dd-ee-ff");
        for l in ["c=IN IP4 239.69.1.1/32", "m=audio 5004 RTP/AVP 97", "a=rtpmap:97 L24/48000/8", "a=ptime:1", "a=mediaclk:direct=0", "a=ts-refclk:localmac=aa-bb-cc-dd-ee-ff"] {
            assert!(s.contains(l), "{l} fehlt in {s}");
        }
        let u = sdp("Studio", 1, "10.0.0.5", "10.0.0.9", 32, 5004, 97, Format::L16, 2, 16, "m");
        assert!(u.contains("c=IN IP4 10.0.0.9\r\n") && u.contains("a=ptime:0.333") && u.contains("L16/48000/2"));
    }
}
