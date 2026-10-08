//! Neutrale Beschreibung eines Markers (Kapitel 37): was der Automator will, unabhängig vom
//! Ausgabeweg. Aus einem [`Cue`] entstehen der SCTE-35-Abschnitt (`splice`), die SCTE-104-Nachricht
//! (`scte104`) und damit die ANC-Pakete (`anc`) bzw. der Transportstrom (`ts`). Reine Funktionen.

use crate::{scte104, splice};

#[derive(Debug, Clone, PartialEq)]
pub enum Cue {
    /// Werbeblock beginnt (Out of Network).
    Out { event_id: u32, duration_ms: Option<u64>, auto_return: bool, lead_ms: u64 },
    /// Rückkehr ins Netz.
    In { event_id: u32, lead_ms: u64 },
    /// Nimmt ein früheres Event zurück.
    Cancel { event_id: u32 },
    /// `time_signal` mit Segmentation Descriptor.
    Signal { event_id: u32, type_id: u8, duration_ms: Option<u64>, upid: Vec<u8>, lead_ms: u64 },
}

impl Cue {
    pub fn event_id(&self) -> u32 {
        match self {
            Cue::Out { event_id, .. } | Cue::In { event_id, .. } | Cue::Cancel { event_id } | Cue::Signal { event_id, .. } => *event_id,
        }
    }

    pub fn lead_ms(&self) -> u64 {
        match self {
            Cue::Out { lead_ms, .. } | Cue::In { lead_ms, .. } | Cue::Signal { lead_ms, .. } => *lead_ms,
            Cue::Cancel { .. } => 0,
        }
    }

    /// Kopie mit anderem Vorlauf (Cancel hat keinen).
    pub fn with_lead(&self, lead: u64) -> Cue {
        let mut c = self.clone();
        match &mut c {
            Cue::Out { lead_ms, .. } | Cue::In { lead_ms, .. } | Cue::Signal { lead_ms, .. } => *lead_ms = lead,
            Cue::Cancel { .. } => {}
        }
        c
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Cue::Out { .. } => "splice_insert OUT",
            Cue::In { .. } => "splice_insert IN",
            Cue::Cancel { .. } => "splice_insert CANCEL",
            Cue::Signal { .. } => "time_signal",
        }
    }

    pub fn summary(&self) -> String {
        match self {
            Cue::Out { duration_ms, auto_return, lead_ms, .. } => {
                format!("Out of Network, Dauer {} ms, Auto-Return {}, Vorlauf {} ms", duration_ms.map_or("—".to_string(), |d| d.to_string()), auto_return, lead_ms)
            }
            Cue::In { lead_ms, .. } => format!("Rückkehr ins Netz, Vorlauf {lead_ms} ms"),
            Cue::Cancel { .. } => "Event zurückgenommen".to_string(),
            Cue::Signal { type_id, lead_ms, .. } => format!("segmentation_type_id 0x{type_id:02X}, Vorlauf {lead_ms} ms"),
        }
    }

    /// SCTE-35-Abschnitt. `now_90k`: aktuelle Zeit in der 90-kHz-Uhr des Ausgangs; bei Vorlauf
    /// > 0 wird daraus der Spleißpunkt (`pts_time`), bei 0 ist der Marker „sofort“.
    pub fn to_scte35(&self, now_90k: u64) -> Result<Vec<u8>, String> {
        let pts = |lead: u64| (lead > 0).then(|| (now_90k + splice::ms_to_90k(lead)) & ((1u64 << 33) - 1));
        match self {
            Cue::Out { event_id, duration_ms, auto_return, lead_ms } => splice::splice_insert(&splice::SpliceInsert {
                event_id: *event_id,
                out_of_network: true,
                duration_ms: *duration_ms,
                auto_return: *auto_return,
                pts_90k: pts(*lead_ms),
                unique_program_id: 1,
                avail_num: 0,
                avails_expected: 0,
            }),
            Cue::In { event_id, lead_ms } => splice::splice_insert(&splice::SpliceInsert {
                event_id: *event_id,
                out_of_network: false,
                duration_ms: None,
                auto_return: false,
                pts_90k: pts(*lead_ms),
                unique_program_id: 1,
                avail_num: 0,
                avails_expected: 0,
            }),
            Cue::Cancel { event_id } => Ok(splice::splice_cancel(*event_id)),
            Cue::Signal { event_id, type_id, duration_ms, upid, lead_ms } => splice::time_signal(&splice::Segmentation {
                event_id: *event_id,
                type_id: *type_id,
                duration_ms: *duration_ms,
                upid_type: if upid.is_empty() { 0 } else { 1 },
                upid: upid.clone(),
                segment_num: 1,
                segments_expected: 1,
                pts_90k: pts(*lead_ms),
            }),
        }
    }

    /// SCTE-104-Operationen für diesen Marker. `lead_ms` wird als `pre_roll_time` (16 Bit) geführt;
    /// `lead_reduce_ms` verkürzt ihn für Wiederholungen in späteren Bildern.
    pub fn to_scte104(&self, lead_reduce_ms: u64) -> Result<Vec<scte104::Op>, String> {
        use scte104::{Op, SpliceKind};
        let pre = |lead: u64| -> Result<u16, String> {
            u16::try_from(lead.saturating_sub(lead_reduce_ms)).map_err(|_| format!("Vorlauf {lead} ms zu groß für pre_roll_time (max. 65535 ms)"))
        };
        match self {
            Cue::Out { event_id, duration_ms, auto_return, lead_ms } => {
                let pre_roll = pre(*lead_ms)?;
                let break_duration = match duration_ms {
                    Some(d) => u16::try_from(d / 100).map_err(|_| format!("Dauer {d} ms zu groß für break_duration (max. 6553,5 s)"))?,
                    None => 0,
                };
                Ok(vec![Op::Splice {
                    kind: if *lead_ms == 0 { SpliceKind::StartImmediate } else { SpliceKind::StartNormal },
                    event_id: *event_id,
                    unique_program_id: 1,
                    pre_roll_ms: pre_roll,
                    break_duration_ds: break_duration,
                    avail_num: 0,
                    avails_expected: 0,
                    auto_return: *auto_return && duration_ms.is_some(),
                }])
            }
            Cue::In { event_id, lead_ms } => Ok(vec![Op::Splice {
                kind: if *lead_ms == 0 { SpliceKind::EndImmediate } else { SpliceKind::EndNormal },
                event_id: *event_id,
                unique_program_id: 1,
                pre_roll_ms: pre(*lead_ms)?,
                break_duration_ds: 0,
                avail_num: 0,
                avails_expected: 0,
                auto_return: false,
            }]),
            Cue::Cancel { event_id } => Ok(vec![Op::Splice {
                kind: SpliceKind::Cancel,
                event_id: *event_id,
                unique_program_id: 1,
                pre_roll_ms: 0,
                break_duration_ds: 0,
                avail_num: 0,
                avails_expected: 0,
                auto_return: false,
            }]),
            Cue::Signal { event_id, type_id, duration_ms, upid, lead_ms } => {
                if upid.len() > 255 {
                    return Err("UPID länger als 255 Byte".to_string());
                }
                let duration_s = match duration_ms {
                    Some(d) => u16::try_from(d.div_ceil(1000)).map_err(|_| format!("Dauer {d} ms zu groß für die Segmentierungsdauer (max. 65535 s)"))?,
                    None => 0,
                };
                Ok(vec![
                    Op::TimeSignal { pre_roll_ms: pre(*lead_ms)? },
                    Op::Segmentation {
                        event_id: *event_id,
                        cancel: false,
                        duration_s,
                        upid_type: if upid.is_empty() { 0 } else { 1 },
                        upid: upid.clone(),
                        type_id: *type_id,
                        segment_num: 1,
                        segments_expected: 1,
                    },
                ])
            }
        }
    }
}
