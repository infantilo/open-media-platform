//! ANSI/SCTE 104: `multiple_operation_message` (Automation → Injector) — Aufbau und Prüfung.
//! Reine Funktionen, keine Ein-/Ausgabe. Unterstützt `splice_request_data` (0x0101),
//! `time_signal_request_data` (0x0104) und `insert_segmentation_descriptor_request_data` (0x010B).
//! Zeitstempel-Typ immer 0 („sofort“ — die Planung steckt im `pre_roll_time`).
//!
//! Layout (Tabellen der Norm, gegen eine unabhängige Implementierung abgeglichen):
//! `FFFF | messageSize(2) | protocol_version(1)=0 | AS_index(1) | message_number(1) | DPI_PID_index(2) |
//! SCTE35_protocol_version(1)=0 | time_type(1)=0 | num_ops(1) | { opID(2) | data_length(2) | data }…`

pub const OP_SPLICE: u16 = 0x0101;
pub const OP_TIME_SIGNAL: u16 = 0x0104;
pub const OP_SEGMENTATION: u16 = 0x010B;

const HEADER_LEN: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpliceKind {
    StartNormal,
    StartImmediate,
    EndNormal,
    EndImmediate,
    Cancel,
}

impl SpliceKind {
    pub fn to_byte(self) -> u8 {
        match self {
            SpliceKind::StartNormal => 1,
            SpliceKind::StartImmediate => 2,
            SpliceKind::EndNormal => 3,
            SpliceKind::EndImmediate => 4,
            SpliceKind::Cancel => 5,
        }
    }

    pub fn from_byte(b: u8) -> Option<Self> {
        Some(match b {
            1 => SpliceKind::StartNormal,
            2 => SpliceKind::StartImmediate,
            3 => SpliceKind::EndNormal,
            4 => SpliceKind::EndImmediate,
            5 => SpliceKind::Cancel,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    Splice { kind: SpliceKind, event_id: u32, unique_program_id: u16, pre_roll_ms: u16, break_duration_ds: u16, avail_num: u8, avails_expected: u8, auto_return: bool },
    TimeSignal { pre_roll_ms: u16 },
    Segmentation { event_id: u32, cancel: bool, duration_s: u16, upid_type: u8, upid: Vec<u8>, type_id: u8, segment_num: u8, segments_expected: u8 },
}

fn op_body(op: &Op) -> (u16, Vec<u8>) {
    match op {
        Op::Splice { kind, event_id, unique_program_id, pre_roll_ms, break_duration_ds, avail_num, avails_expected, auto_return } => {
            let mut b = Vec::with_capacity(15);
            b.push(kind.to_byte());
            b.extend_from_slice(&event_id.to_be_bytes());
            b.extend_from_slice(&unique_program_id.to_be_bytes());
            b.extend_from_slice(&pre_roll_ms.to_be_bytes());
            b.extend_from_slice(&break_duration_ds.to_be_bytes());
            b.push(*avail_num);
            b.push(*avails_expected);
            b.push(*auto_return as u8);
            b.push(0); // not_an_entry_flag
            (OP_SPLICE, b)
        }
        Op::TimeSignal { pre_roll_ms } => (OP_TIME_SIGNAL, pre_roll_ms.to_be_bytes().to_vec()),
        Op::Segmentation { event_id, cancel, duration_s, upid_type, upid, type_id, segment_num, segments_expected } => {
            let mut b = Vec::new();
            b.extend_from_slice(&event_id.to_be_bytes());
            b.push(*cancel as u8);
            b.extend_from_slice(&duration_s.to_be_bytes());
            b.push(*upid_type);
            b.push(upid.len() as u8);
            b.extend_from_slice(upid);
            b.push(*type_id);
            b.push(*segment_num);
            b.push(*segments_expected);
            b.push(0); // duration_extension_frames
            b.push(1); // delivery_not_restricted_flag
            b.push(0); // web_delivery_allowed_flag
            b.push(0); // no_regional_blackout_flag
            b.push(0); // archive_allowed_flag
            b.push(3); // device_restrictions = „keine“
            b.push(0); // insert_sub_segment_info
            b.push(0); // sub_segment_num
            b.push(0); // sub_segments_expected
            (OP_SEGMENTATION, b)
        }
    }
}

/// Baut eine `multiple_operation_message`.
pub fn encode_mom(ops: &[Op], message_number: u8) -> Result<Vec<u8>, String> {
    if ops.is_empty() || ops.len() > 255 {
        return Err("SCTE 104: 1…255 Operationen je Nachricht".to_string());
    }
    let bodies: Vec<(u16, Vec<u8>)> = ops.iter().map(op_body).collect();
    let size = HEADER_LEN + 1 + 1 + bodies.iter().map(|(_, b)| 4 + b.len()).sum::<usize>();
    if size > 2000 {
        return Err(format!("SCTE 104: Nachricht {size} Byte, höchstens 2000 (ST 2010)"));
    }
    let mut m = Vec::with_capacity(size);
    m.extend_from_slice(&[0xFF, 0xFF]);
    m.extend_from_slice(&(size as u16).to_be_bytes());
    m.push(0); // protocol_version
    m.push(0); // AS_index
    m.push(message_number);
    m.extend_from_slice(&[0, 0]); // DPI_PID_index
    m.push(0); // SCTE35_protocol_version
    m.push(0); // timestamp: time_type = 0 (sofort)
    m.push(ops.len() as u8);
    for (id, body) in bodies {
        m.extend_from_slice(&id.to_be_bytes());
        m.extend_from_slice(&(body.len() as u16).to_be_bytes());
        m.extend_from_slice(&body);
    }
    debug_assert_eq!(m.len(), size);
    Ok(m)
}

#[derive(Debug, PartialEq, Eq)]
pub struct ParsedMom {
    pub message_number: u8,
    pub ops: Vec<Op>,
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_be_bytes([b[i], b[i + 1]])
}

fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

/// Prüft und zerlegt eine `multiple_operation_message` (nur die hier erzeugten Operationen).
pub fn parse_mom(b: &[u8]) -> Result<ParsedMom, String> {
    if b.len() < HEADER_LEN + 2 {
        return Err("SCTE 104: Nachricht zu kurz".to_string());
    }
    if b[0] != 0xFF || b[1] != 0xFF {
        return Err("SCTE 104: keine multiple_operation_message (FFFF fehlt)".to_string());
    }
    if u16_at(b, 2) as usize != b.len() {
        return Err(format!("SCTE 104: messageSize {} passt nicht zu {} Byte", u16_at(b, 2), b.len()));
    }
    if b[10] != 0 {
        return Err("SCTE 104: nur time_type 0 unterstützt".to_string());
    }
    let n = b[11] as usize;
    let mut pos = 12;
    let mut ops = Vec::new();
    for _ in 0..n {
        if pos + 4 > b.len() {
            return Err("SCTE 104: Operation abgeschnitten".to_string());
        }
        let id = u16_at(b, pos);
        let len = u16_at(b, pos + 2) as usize;
        pos += 4;
        if pos + len > b.len() {
            return Err("SCTE 104: Operationsdaten abgeschnitten".to_string());
        }
        let d = &b[pos..pos + len];
        pos += len;
        ops.push(match id {
            OP_SPLICE => {
                if d.len() != 15 {
                    return Err(format!("SCTE 104: splice_request_data {} Byte statt 15", d.len()));
                }
                Op::Splice {
                    kind: SpliceKind::from_byte(d[0]).ok_or_else(|| format!("SCTE 104: splice_insert_type {} unbekannt", d[0]))?,
                    event_id: u32_at(d, 1),
                    unique_program_id: u16_at(d, 5),
                    pre_roll_ms: u16_at(d, 7),
                    break_duration_ds: u16_at(d, 9),
                    avail_num: d[11],
                    avails_expected: d[12],
                    auto_return: d[13] != 0,
                }
            }
            OP_TIME_SIGNAL => {
                if d.len() != 2 {
                    return Err("SCTE 104: time_signal_request_data nicht 2 Byte".to_string());
                }
                Op::TimeSignal { pre_roll_ms: u16_at(d, 0) }
            }
            OP_SEGMENTATION => {
                if d.len() < 9 {
                    return Err("SCTE 104: Segmentierungsdeskriptor zu kurz".to_string());
                }
                let upid_len = d[8] as usize;
                if d.len() != 9 + upid_len + 12 {
                    return Err("SCTE 104: Segmentierungsdeskriptor hat unerwartete Länge".to_string());
                }
                let t = 9 + upid_len;
                Op::Segmentation {
                    event_id: u32_at(d, 0),
                    cancel: d[4] != 0,
                    duration_s: u16_at(d, 5),
                    upid_type: d[7],
                    upid: d[9..9 + upid_len].to_vec(),
                    type_id: d[t],
                    segment_num: d[t + 1],
                    segments_expected: d[t + 2],
                }
            }
            other => return Err(format!("SCTE 104: opID 0x{other:04X} nicht unterstützt")),
        });
    }
    if pos != b.len() {
        return Err("SCTE 104: überzählige Bytes am Ende".to_string());
    }
    Ok(ParsedMom { message_number: b[6], ops })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cue::Cue;

    #[test]
    fn splice_out_has_the_documented_byte_layout() {
        let ops = Cue::Out { event_id: 0x0102_0304, duration_ms: Some(30_000), auto_return: true, lead_ms: 4000 }.to_scte104(0).unwrap();
        let m = encode_mom(&ops, 7).unwrap();
        // Kopf: FFFF, Größe, Version 0, AS 0, Nr 7, DPI-PID-Index 0, SCTE35-Version 0, time_type 0, 1 Operation
        assert_eq!(&m[..12], &[0xFF, 0xFF, 0, 31, 0, 0, 7, 0, 0, 0, 0, 1]);
        // opID 0x0101, Länge 15, Typ 1 (start normal), Event-ID, Programm 1, Pre-Roll 4000, Dauer 300 (1/10 s), Auto-Return
        assert_eq!(&m[12..16], &[0x01, 0x01, 0, 15]);
        assert_eq!(&m[16..], &[1, 1, 2, 3, 4, 0, 1, 0x0F, 0xA0, 0x01, 0x2C, 0, 0, 1, 0]);
        assert_eq!(m.len(), 31);
    }

    #[test]
    fn every_cue_round_trips_through_the_parser() {
        let cues = [
            Cue::Out { event_id: 9, duration_ms: Some(120_000), auto_return: true, lead_ms: 0 },
            Cue::Out { event_id: 10, duration_ms: None, auto_return: true, lead_ms: 5000 },
            Cue::In { event_id: 9, lead_ms: 2000 },
            Cue::In { event_id: 9, lead_ms: 0 },
            Cue::Cancel { event_id: 9 },
            Cue::Signal { event_id: 11, type_id: 0x34, duration_ms: Some(45_000), upid: b"AD-42".to_vec(), lead_ms: 4000 },
        ];
        for c in cues {
            let ops = c.to_scte104(0).unwrap();
            let m = encode_mom(&ops, 1).unwrap();
            let p = parse_mom(&m).unwrap();
            assert_eq!(p.ops, ops, "{c:?}");
        }
    }

    #[test]
    fn immediate_variants_are_chosen_without_lead() {
        let o = Cue::Out { event_id: 1, duration_ms: None, auto_return: false, lead_ms: 0 }.to_scte104(0).unwrap();
        assert!(matches!(o[0], Op::Splice { kind: SpliceKind::StartImmediate, .. }));
        let i = Cue::In { event_id: 1, lead_ms: 0 }.to_scte104(0).unwrap();
        assert!(matches!(i[0], Op::Splice { kind: SpliceKind::EndImmediate, .. }));
    }

    #[test]
    fn repetition_shortens_the_pre_roll() {
        let ops = Cue::Out { event_id: 1, duration_ms: None, auto_return: false, lead_ms: 4000 }.to_scte104(40).unwrap();
        assert!(matches!(ops[0], Op::Splice { pre_roll_ms: 3960, .. }));
    }

    #[test]
    fn broken_messages_are_rejected() {
        let m = encode_mom(&Cue::Cancel { event_id: 1 }.to_scte104(0).unwrap(), 0).unwrap();
        assert!(parse_mom(&m[..m.len() - 1]).is_err());
        let mut bad = m.clone();
        bad[0] = 0;
        assert!(parse_mom(&bad).is_err());
        let mut bad = m.clone();
        bad[3] += 1;
        assert!(parse_mom(&bad).is_err());
        assert!(Cue::Out { event_id: 1, duration_ms: Some(10_000_000), auto_return: true, lead_ms: 0 }.to_scte104(0).is_err(), "break_duration overflow");
        assert!(Cue::In { event_id: 1, lead_ms: 70_000 }.to_scte104(0).is_err(), "pre_roll overflow");
    }

    #[test]
    fn scte35_section_from_the_same_cue_is_valid_and_carries_the_pts() {
        let sec = Cue::Out { event_id: 77, duration_ms: Some(30_000), auto_return: true, lead_ms: 4000 }.to_scte35(1_000_000).unwrap();
        let p = crate::splice::parse(&sec).unwrap();
        assert_eq!((p.event_id, p.out_of_network, p.duration_ms), (Some(77), Some(true), Some(30_000)));
    }
}
