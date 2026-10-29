//! Ancillary-Daten für SCTE 104 (Kapitel 37): SMPTE ST 291 (10-Bit-Wörter, Parität, Prüfsumme),
//! Abbildung nach ST 2010 (DID 0x41 / SDID 0x07, Payload Descriptor, Aufteilung langer Nachrichten)
//! und der MXL-Daten-Grain (`video/smpte291` = RFC-8331-Nutzlast ab dem Length-Feld, 4096 Byte).
//! Reine Funktionen, keine Ein-/Ausgabe.

pub const DID_SCTE104: u8 = 0x41;
pub const SDID_SCTE104: u8 = 0x07;
pub use omp_mediaio::anc::{AncPacket, GRAIN_SIZE, mxl_grain, rfc8331_packet, with_parity};
#[cfg(test)]
pub use omp_mediaio::anc::{HEADER_LEN, parse_mxl_grain};

/// Nutzdaten (Nachrichtenbytes) je ANC-Paket: 255 Wörter minus Payload Descriptor.
pub const MAX_MESSAGE_BYTES_PER_PACKET: usize = 254;

/// Payload Descriptor (ST 2010 Tab. 1): Version 01 in Bit 4/3, Bit 2 fortgesetzt, Bit 1 Folgepaket, Bit 0 Duplikat.
pub fn payload_descriptor(continued: bool, following: bool, duplicate: bool) -> u8 {
    0x08 | ((continued as u8) << 2) | ((following as u8) << 1) | duplicate as u8
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
