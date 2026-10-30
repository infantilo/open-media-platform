//! Allgemeiner, fehlertoleranter Decoder für SCTE 104 (in ANC, ST 2010) und SCTE 35 (`splice_info_section`) — für Messgeräte.
//!
//! Anders als die Erzeuger-Parser in `omp-scte35` liest dieser Decoder **beliebige** Nachrichten: unbekannte Operationen,
//! Befehle und Descriptoren erscheinen mit ID und Rohdaten, Längenfehler werden als Warnung gemeldet, ohne den Rest zu verwerfen.
//! Reine Funktionen, keine Ein-/Ausgabe, keine Abhängigkeiten.
//!
//! Geprüft nur gegen selbst erzeugte Nachrichten und die Tabellen der Normen aus dem Gedächtnis der Autoren — **nicht** gegen
//! Aufzeichnungen fremder Geräte.

pub const DID_SCTE104: u8 = 0x41;
pub const SDID_SCTE104: u8 = 0x07;

/// Ein entschlüsselter Block: Titel, Feldliste, Unterblöcke (z. B. Operationen oder Descriptoren), Warnungen.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Decoded {
    pub title: String,
    pub fields: Vec<(String, String)>,
    pub children: Vec<Decoded>,
    pub warnings: Vec<String>,
}

impl Decoded {
    fn new(title: impl Into<String>) -> Self {
        Decoded { title: title.into(), ..Default::default() }
    }
    fn f(&mut self, k: &str, v: impl ToString) {
        self.fields.push((k.to_string(), v.to_string()));
    }
    fn warn(&mut self, w: impl Into<String>) {
        self.warnings.push(w.into());
    }
    /// Alle Warnungen samt der Unterblöcke.
    pub fn all_warnings(&self) -> Vec<String> {
        let mut v = self.warnings.clone();
        for c in &self.children {
            v.extend(c.all_warnings());
        }
        v
    }
    /// Wert eines Feldes (erstes Vorkommen).
    pub fn get(&self, key: &str) -> Option<&str> {
        self.fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join(" ")
}

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

/// Leser mit Grenzprüfung.
struct Rd<'a> {
    d: &'a [u8],
    pos: usize,
}

impl<'a> Rd<'a> {
    fn new(d: &'a [u8]) -> Self {
        Rd { d, pos: 0 }
    }
    fn left(&self) -> usize {
        self.d.len().saturating_sub(self.pos)
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.left() < n {
            return None;
        }
        let s = &self.d[self.pos..self.pos + n];
        self.pos += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|b| u16::from_be_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn rest(&mut self) -> &'a [u8] {
        let s = &self.d[self.pos.min(self.d.len())..];
        self.pos = self.d.len();
        s
    }
}

// ---------------------------------------------------------------------------
// SCTE 104
// ---------------------------------------------------------------------------

/// Setzt SCTE-104-Nachrichten aus ANC-Paketen (ST 2010) zusammen. Der Payload Descriptor steht im ersten Nutzdatenbyte:
/// Bit 4/3 Version, Bit 2 „fortgesetzt“, Bit 1 „Folgepaket“, Bit 0 Duplikat.
#[derive(Default)]
pub struct Scte104Assembler {
    buf: Vec<u8>,
    open: bool,
    duplicate: bool,
    dropped_previous: bool,
}

/// Eine fertige Nachricht (Bytes) samt Duplikat-Flag.
pub struct Scte104Message {
    pub bytes: Vec<u8>,
    pub duplicate: bool,
    /// Vor dieser Nachricht ging eine unvollständige verloren (neuer Anfang, ohne dass die vorige endete).
    pub dropped_previous: bool,
}

impl Scte104Assembler {
    /// Ein Paket (`udw` = Nutzdaten des ANC-Pakets). `Ok(Some)` = Nachricht komplett; `Err` = Paket unbrauchbar.
    pub fn feed(&mut self, udw: &[u8]) -> Result<Option<Scte104Message>, String> {
        let Some((&pd, data)) = udw.split_first() else {
            return Err("leeres SCTE-104-Paket".to_string());
        };
        let (continued, following, dup) = (pd & 4 != 0, pd & 2 != 0, pd & 1 != 0);
        if pd & 0x18 != 0x08 || pd & 0xE0 != 0 {
            return Err(format!("Payload Descriptor 0x{pd:02X}: Version/Reserve ungewöhnlich"));
        }
        if !following {
            if self.open {
                self.dropped_previous = true;
            }
            self.buf.clear();
            self.duplicate = false;
            self.open = true;
        } else if !self.open {
            return Err("Folgepaket ohne Anfang".to_string());
        }
        self.duplicate |= dup;
        self.buf.extend_from_slice(data);
        if continued {
            return Ok(None);
        }
        self.open = false;
        Ok(Some(Scte104Message { bytes: std::mem::take(&mut self.buf), duplicate: self.duplicate, dropped_previous: std::mem::take(&mut self.dropped_previous) }))
    }
}

fn splice_insert_type(b: u8) -> String {
    match b {
        1 => "spliceStart_normal",
        2 => "spliceStart_immediate",
        3 => "spliceEnd_normal",
        4 => "spliceEnd_immediate",
        5 => "splice_cancel",
        _ => "reserviert",
    }
    .to_string()
}

fn op_name(id: u16) -> &'static str {
    match id {
        0x0101 => "splice_request_data",
        0x0102 => "splice_null_request_data",
        0x0103 => "start_schedule_download_request_data",
        0x0104 => "time_signal_request_data",
        0x0105 => "transmit_schedule_request_data",
        0x0106 => "component_mode_DPI_request_data",
        0x0107 => "encrypted_DPI_request_data",
        0x0108 => "insert_descriptor_request_data",
        0x0109 => "insert_DTMF_descriptor_request_data",
        0x010A => "insert_avail_descriptor_request_data",
        0x010B => "insert_segmentation_descriptor_request_data",
        0x010C => "proprietary_command_request_data",
        0x010D => "schedule_component_mode_request_data",
        0x010E => "schedule_definition_data_request",
        0x010F => "insert_tier_data",
        0x0110 => "insert_time_descriptor_request_data",
        0x0001 => "inject_response_data",
        0x0002 => "inject_complete_response_data",
        0x0003 => "inject_user_data_response",
        0x0004 => "init_request_data / alive_request",
        _ => "unbekannte Operation",
    }
}

fn decode_op(id: u16, d: &[u8]) -> Decoded {
    let mut o = Decoded::new(format!("{} (0x{id:04X})", op_name(id)));
    o.f("Datenlänge", d.len());
    let mut r = Rd::new(d);
    let short = |o: &mut Decoded| o.warn("Operationsdaten kürzer als erwartet");
    match id {
        0x0101 => {
            let (Some(t), Some(ev), Some(upid), Some(pre), Some(dur), Some(an), Some(ae), Some(ar)) =
                (r.u8(), r.u32(), r.u16(), r.u16(), r.u16(), r.u8(), r.u8(), r.u8())
            else {
                short(&mut o);
                o.f("Rohdaten", hex(d));
                return o;
            };
            o.f("splice_insert_type", format!("{t} ({})", splice_insert_type(t)));
            o.f("splice_event_id", ev);
            o.f("unique_program_id", upid);
            o.f("pre_roll_time", format!("{pre} ms"));
            o.f("break_duration", format!("{:.1} s", dur as f64 / 10.0));
            o.f("avail_num / avails_expected", format!("{an} / {ae}"));
            o.f("auto_return_flag", ar != 0);
            if r.left() > 0 {
                o.f("weitere Felder", hex(r.rest()));
            }
        }
        0x0104 => match r.u16() {
            Some(pre) => o.f("pre_roll_time", format!("{pre} ms")),
            None => short(&mut o),
        },
        0x010B => {
            let (Some(ev), Some(cancel), Some(dur), Some(ut), Some(ul)) = (r.u32(), r.u8(), r.u16(), r.u8(), r.u8()) else {
                short(&mut o);
                o.f("Rohdaten", hex(d));
                return o;
            };
            o.f("segmentation_event_id", ev);
            o.f("segmentation_event_cancel_indicator", cancel != 0);
            o.f("duration", format!("{dur} s"));
            o.f("segmentation_upid_type", format!("{ut} ({})", upid_type_name(ut)));
            match r.take(ul as usize) {
                Some(u) => o.f("segmentation_upid", upid_text(ut, u)),
                None => {
                    o.warn("UPID länger als die Daten");
                    o.f("Rohdaten", hex(r.rest()));
                    return o;
                }
            }
            if let (Some(ty), Some(sn), Some(se)) = (r.u8(), r.u8(), r.u8()) {
                o.f("segmentation_type_id", format!("0x{ty:02X} ({})", segmentation_type_name(ty)));
                o.f("segment_num / segments_expected", format!("{sn} / {se}"));
                let rest = r.rest();
                if !rest.is_empty() {
                    let names = [
                        "duration_extension_frames",
                        "delivery_not_restricted_flag",
                        "web_delivery_allowed_flag",
                        "no_regional_blackout_flag",
                        "archive_allowed_flag",
                        "device_restrictions",
                        "insert_sub_segment_info",
                        "sub_segment_num",
                        "sub_segments_expected",
                    ];
                    for (n, v) in names.iter().zip(rest) {
                        o.f(n, v);
                    }
                    if rest.len() > names.len() {
                        o.f("weitere Felder", hex(&rest[names.len()..]));
                    }
                }
            } else {
                short(&mut o);
            }
        }
        0x0102 => {}
        _ => {
            if !d.is_empty() {
                o.f("Rohdaten", hex(d));
            }
        }
    }
    o
}

/// Entschlüsselt eine SCTE-104-Nachricht (`multiple_operation_message` oder `single_operation_message`).
pub fn scte104(m: &[u8]) -> Decoded {
    let mut r = Rd::new(m);
    let Some(first) = r.u16() else {
        let mut d = Decoded::new("SCTE 104 (unlesbar)");
        d.warn("Nachricht kürzer als 2 Byte");
        return d;
    };
    if first == 0xFFFF {
        let mut d = Decoded::new("SCTE 104 multiple_operation_message");
        let (Some(size), Some(proto), Some(asi), Some(num), Some(dpi), Some(s35), Some(tt)) = (r.u16(), r.u8(), r.u8(), r.u8(), r.u16(), r.u8(), r.u8())
        else {
            d.warn("Kopf abgeschnitten");
            d.f("Rohdaten", hex(m));
            return d;
        };
        d.f("messageSize", size);
        if size as usize != m.len() {
            d.warn(format!("messageSize {size} passt nicht zu {} Byte", m.len()));
        }
        d.f("protocol_version", proto);
        d.f("AS_index", asi);
        d.f("message_number", num);
        d.f("DPI_PID_index", dpi);
        d.f("SCTE35_protocol_version", s35);
        match tt {
            0 => d.f("timestamp", "keiner (sofort)"),
            1 => match (r.u32(), r.u16()) {
                (Some(s), Some(us)) => d.f("timestamp (UTC)", format!("{s} s + {us} µs seit 1970")),
                _ => d.warn("Zeitstempel abgeschnitten"),
            },
            2 => match r.take(4) {
                Some(v) => d.f("timestamp (VITC)", format!("{:02}:{:02}:{:02}:{:02}", v[0], v[1], v[2], v[3])),
                None => d.warn("Zeitstempel abgeschnitten"),
            },
            3 => match (r.u8(), r.u8()) {
                (Some(n), Some(e)) => d.f("timestamp (GPI)", format!("Nr. {n}, Flanke {e}")),
                _ => d.warn("Zeitstempel abgeschnitten"),
            },
            other => d.warn(format!("time_type {other} unbekannt")),
        }
        let Some(n) = r.u8() else {
            d.warn("num_ops fehlt");
            return d;
        };
        d.f("num_ops", n);
        for i in 0..n {
            let (Some(id), Some(len)) = (r.u16(), r.u16()) else {
                d.warn(format!("Operation {} von {n} abgeschnitten", i + 1));
                break;
            };
            let Some(data) = r.take(len as usize) else {
                d.warn(format!("Operation {} (0x{id:04X}): Daten ({len} Byte) reichen über die Nachricht hinaus", i + 1));
                d.children.push(decode_op(id, r.rest()));
                break;
            };
            d.children.push(decode_op(id, data));
        }
        if r.left() > 0 {
            d.warn(format!("{} Byte nach der letzten Operation", r.left()));
        }
        d
    } else {
        let mut d = Decoded::new(format!("SCTE 104 single_operation_message (opID 0x{first:04X}, {})", op_name(first)));
        let (Some(size), Some(result), Some(ext), Some(proto), Some(asi), Some(num), Some(dpi)) = (r.u16(), r.u16(), r.u16(), r.u8(), r.u8(), r.u8(), r.u16())
        else {
            d.warn("Kopf abgeschnitten");
            d.f("Rohdaten", hex(m));
            return d;
        };
        d.f("messageSize", size);
        if size as usize != m.len() {
            d.warn(format!("messageSize {size} passt nicht zu {} Byte", m.len()));
        }
        d.f("result", format!("0x{result:04X}"));
        d.f("result_extension", ext);
        d.f("protocol_version", proto);
        d.f("AS_index", asi);
        d.f("message_number", num);
        d.f("DPI_PID_index", dpi);
        let data = r.rest();
        d.children.push(decode_op(first, data));
        d
    }
}

// ---------------------------------------------------------------------------
// SCTE 35
// ---------------------------------------------------------------------------

pub fn upid_type_name(t: u8) -> &'static str {
    match t {
        0x00 => "keine",
        0x01 => "benutzerdefiniert (veraltet)",
        0x02 => "ISCI",
        0x03 => "Ad-ID",
        0x04 => "UMID",
        0x05 => "ISAN (veraltet)",
        0x06 => "ISAN",
        0x07 => "TID",
        0x08 => "TI",
        0x09 => "ADI",
        0x0A => "EIDR",
        0x0B => "ATSC-Inhalts-ID",
        0x0C => "MPU",
        0x0D => "MID",
        0x0E => "ADS-Information",
        0x0F => "URI",
        0x10 => "UUID",
        0x11 => "SCR",
        _ => "unbekannt",
    }
}

fn upid_text(t: u8, u: &[u8]) -> String {
    let printable = !u.is_empty() && u.iter().all(|b| (0x20..0x7F).contains(b));
    if printable && matches!(t, 0x01 | 0x02 | 0x03 | 0x07 | 0x08 | 0x09 | 0x0A | 0x0F | 0x0E) {
        format!("\"{}\"", String::from_utf8_lossy(u))
    } else {
        hex(u)
    }
}

pub fn segmentation_type_name(t: u8) -> &'static str {
    match t {
        0x00 => "nicht angegeben",
        0x01 => "Content Identification",
        0x10 => "Program Start",
        0x11 => "Program End",
        0x12 => "Program Early Termination",
        0x13 => "Program Breakaway",
        0x14 => "Program Resumption",
        0x15 => "Program Runover Planned",
        0x16 => "Program Runover Unplanned",
        0x17 => "Program Overlap Start",
        0x18 => "Program Blackout Override",
        0x19 => "Program Start – In Progress",
        0x20 => "Chapter Start",
        0x21 => "Chapter End",
        0x22 => "Break Start",
        0x23 => "Break End",
        0x24 => "Opening Credit Start",
        0x25 => "Opening Credit End",
        0x26 => "Closing Credit Start",
        0x27 => "Closing Credit End",
        0x30 => "Provider Advertisement Start",
        0x31 => "Provider Advertisement End",
        0x32 => "Distributor Advertisement Start",
        0x33 => "Distributor Advertisement End",
        0x34 => "Provider Placement Opportunity Start",
        0x35 => "Provider Placement Opportunity End",
        0x36 => "Distributor Placement Opportunity Start",
        0x37 => "Distributor Placement Opportunity End",
        0x38 => "Provider Overlay Placement Opportunity Start",
        0x39 => "Provider Overlay Placement Opportunity End",
        0x3A => "Distributor Overlay Placement Opportunity Start",
        0x3B => "Distributor Overlay Placement Opportunity End",
        0x40 => "Unscheduled Event Start",
        0x41 => "Unscheduled Event End",
        0x50 => "Network Start",
        0x51 => "Network End",
        _ => "unbekannt",
    }
}

fn pts(v: u64) -> String {
    format!("{v} ({:.3} s)", v as f64 / 90_000.0)
}

/// `splice_time()`: time_specified_flag(1) [reserved(6) pts_time(33)] | reserved(7).
fn splice_time(r: &mut Rd) -> Option<Option<u64>> {
    let b = r.u8()?;
    if b & 0x80 != 0 {
        let rest = r.take(4)?;
        Some(Some((((b & 1) as u64) << 32) | u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) as u64))
    } else {
        Some(None)
    }
}

fn be40(b: &[u8]) -> u64 {
    b.iter().take(5).fold(0u64, |a, x| (a << 8) | *x as u64)
}

fn decode_splice_insert(cmd: &[u8], d: &mut Decoded) {
    let mut r = Rd::new(cmd);
    let Some(id) = r.u32() else {
        d.warn("splice_insert zu kurz");
        return;
    };
    d.f("splice_event_id", id);
    let Some(c) = r.u8() else { return };
    d.f("splice_event_cancel_indicator", c & 0x80 != 0);
    if c & 0x80 != 0 {
        return;
    }
    let Some(f) = r.u8() else {
        d.warn("splice_insert abgeschnitten");
        return;
    };
    let (oon, prog, dur, imm) = (f & 0x80 != 0, f & 0x40 != 0, f & 0x20 != 0, f & 0x10 != 0);
    d.f("out_of_network_indicator", format!("{oon} ({})", if oon { "aus dem Netz heraus" } else { "zurück ins Netz" }));
    d.f("program_splice_flag", prog);
    d.f("duration_flag", dur);
    d.f("splice_immediate_flag", imm);
    if prog && !imm {
        match splice_time(&mut r) {
            Some(Some(p)) => d.f("pts_time", pts(p)),
            Some(None) => d.f("pts_time", "nicht angegeben"),
            None => d.warn("splice_time abgeschnitten"),
        }
    }
    if !prog {
        let n = r.u8().unwrap_or(0);
        d.f("component_count", n);
        for _ in 0..n {
            let tag = r.u8();
            let t = if imm { None } else { splice_time(&mut r).flatten() };
            d.f("Komponente", format!("tag {:?}, pts {:?}", tag, t));
        }
    }
    if dur {
        match r.take(5) {
            Some(b) => {
                d.f("auto_return", b[0] & 0x80 != 0);
                d.f("break_duration", format!("{} ({:.3} s)", be40(b) & ((1 << 33) - 1), (be40(b) & ((1 << 33) - 1)) as f64 / 90_000.0));
            }
            None => d.warn("break_duration abgeschnitten"),
        }
    }
    if let (Some(u), Some(a), Some(e)) = (r.u16(), r.u8(), r.u8()) {
        d.f("unique_program_id", u);
        d.f("avail_num / avails_expected", format!("{a} / {e}"));
    } else {
        d.warn("unique_program_id/avail_num abgeschnitten");
    }
}

fn decode_segmentation(body: &[u8], d: &mut Decoded) {
    let mut r = Rd::new(body);
    let (Some(id), Some(c)) = (r.u32(), r.u8()) else {
        d.warn("Segmentierungsdescriptor zu kurz");
        return;
    };
    d.f("segmentation_event_id", id);
    d.f("segmentation_event_cancel_indicator", c & 0x80 != 0);
    if c & 0x80 != 0 {
        return;
    }
    let Some(f) = r.u8() else {
        d.warn("Flags fehlen");
        return;
    };
    let (prog, dur, dnr) = (f & 0x80 != 0, f & 0x40 != 0, f & 0x20 != 0);
    d.f("program_segmentation_flag", prog);
    d.f("delivery_not_restricted_flag", dnr);
    if !dnr {
        d.f("web_delivery_allowed_flag", f & 0x10 != 0);
        d.f("no_regional_blackout_flag", f & 0x08 != 0);
        d.f("archive_allowed_flag", f & 0x04 != 0);
        d.f("device_restrictions", f & 3);
    }
    if !prog {
        let n = r.u8().unwrap_or(0);
        for _ in 0..n {
            if let (Some(tag), Some(b)) = (r.u8(), r.take(5)) {
                d.f("Komponente", format!("tag {tag}, pts_offset {}", pts(be40(b) & ((1 << 33) - 1))));
            }
        }
    }
    if dur {
        match r.take(5) {
            Some(b) => d.f("segmentation_duration", pts(be40(b))),
            None => d.warn("segmentation_duration abgeschnitten"),
        }
    }
    let (Some(ut), Some(ul)) = (r.u8(), r.u8()) else {
        d.warn("UPID abgeschnitten");
        return;
    };
    d.f("segmentation_upid_type", format!("0x{ut:02X} ({})", upid_type_name(ut)));
    match r.take(ul as usize) {
        Some(u) => d.f("segmentation_upid", upid_text(ut, u)),
        None => {
            d.warn("UPID länger als der Descriptor");
            return;
        }
    }
    if let (Some(t), Some(n), Some(e)) = (r.u8(), r.u8(), r.u8()) {
        d.f("segmentation_type_id", format!("0x{t:02X} ({})", segmentation_type_name(t)));
        d.f("segment_num / segments_expected", format!("{n} / {e}"));
        if matches!(t, 0x34 | 0x36 | 0x38 | 0x3A)
            && let (Some(a), Some(b)) = (r.u8(), r.u8())
        {
            d.f("sub_segment_num / sub_segments_expected", format!("{a} / {b}"));
        }
    } else {
        d.warn("segmentation_type_id abgeschnitten");
    }
}

fn decode_descriptors(mut r: Rd, parent: &mut Decoded) {
    while r.left() > 0 {
        let (Some(tag), Some(len)) = (r.u8(), r.u8()) else {
            parent.warn("Descriptor-Kopf abgeschnitten");
            return;
        };
        let name = match tag {
            0x00 => "avail_descriptor",
            0x01 => "DTMF_descriptor",
            0x02 => "segmentation_descriptor",
            0x03 => "time_descriptor",
            0x04 => "audio_descriptor",
            _ => "unbekannter Descriptor",
        };
        let mut c = Decoded::new(format!("{name} (0x{tag:02X})"));
        let Some(body) = r.take(len as usize) else {
            c.warn(format!("Länge {len} reicht über die Descriptor-Schleife hinaus"));
            c.f("Rohdaten", hex(r.rest()));
            parent.children.push(c);
            return;
        };
        if body.len() < 4 {
            c.warn("Descriptor kürzer als die Kennung");
            c.f("Rohdaten", hex(body));
        } else {
            let ident = String::from_utf8_lossy(&body[..4]).to_string();
            c.f("identifier", &ident);
            if ident != "CUEI" {
                c.warn("identifier ist nicht CUEI");
            }
            let b = &body[4..];
            match tag {
                0x02 => decode_segmentation(b, &mut c),
                0x00 if b.len() >= 4 => c.f("provider_avail_id", u32::from_be_bytes([b[0], b[1], b[2], b[3]])),
                0x03 if b.len() >= 12 => {
                    let tai_s = u64::from_be_bytes([0, 0, b[0], b[1], b[2], b[3], b[4], b[5]]);
                    let ns = u32::from_be_bytes([b[6], b[7], b[8], b[9]]);
                    let off = u16::from_be_bytes([b[10], b[11]]);
                    c.f("TAI_seconds", tai_s);
                    c.f("TAI_ns", ns);
                    c.f("UTC_offset", off);
                }
                _ => c.f("Rohdaten", hex(b)),
            }
        }
        parent.children.push(c);
    }
}

/// Entschlüsselt eine `splice_info_section` (ab `table_id`, mit CRC).
pub fn scte35(sec: &[u8]) -> Decoded {
    let mut d = Decoded::new("SCTE 35 splice_info_section");
    if sec.len() < 14 {
        d.warn("Abschnitt kürzer als der Kopf (14 Byte)");
        d.f("Rohdaten", hex(sec));
        return d;
    }
    if sec[0] != 0xFC {
        d.warn(format!("table_id 0x{:02X} statt 0xFC", sec[0]));
    }
    let section_length = (((sec[1] & 0x0F) as usize) << 8) | sec[2] as usize;
    d.f("section_length", section_length);
    if section_length + 3 != sec.len() {
        d.warn(format!("section_length {section_length} passt nicht zur Länge {}", sec.len()));
    }
    let crc_ok = crc32_mpeg(sec) == 0;
    d.f("CRC-32", if crc_ok { "gültig" } else { "FALSCH" });
    if !crc_ok {
        d.warn("CRC-32 falsch");
    }
    d.f("protocol_version", sec[3]);
    let encrypted = sec[4] & 0x80 != 0;
    d.f("encrypted_packet", encrypted);
    let adj = (((sec[4] & 1) as u64) << 32) | u32::from_be_bytes([sec[5], sec[6], sec[7], sec[8]]) as u64;
    d.f("pts_adjustment", pts(adj));
    d.f("cw_index", sec[9]);
    let tier = ((sec[10] as u16) << 4) | (sec[11] >> 4) as u16;
    d.f("tier", format!("0x{tier:03X}"));
    let cmd_len = (((sec[11] & 0x0F) as usize) << 8) | sec[12] as usize;
    let cmd_type = sec[13];
    let name = match cmd_type {
        0x00 => "splice_null",
        0x04 => "splice_schedule",
        0x05 => "splice_insert",
        0x06 => "time_signal",
        0x07 => "bandwidth_reservation",
        0xFF => "private_command",
        _ => "unbekannter Befehl",
    };
    d.f("splice_command_type", format!("0x{cmd_type:02X} ({name})"));
    d.f("splice_command_length", cmd_len);
    if encrypted {
        d.warn("verschlüsselt: Befehl und Descriptoren nicht lesbar");
        return d;
    }
    let body_end = sec.len().saturating_sub(4);
    let cmd_start = 14;
    if cmd_start + cmd_len > body_end {
        d.warn("splice_command_length reicht über den Abschnitt hinaus");
        return d;
    }
    let cmd = &sec[cmd_start..cmd_start + cmd_len];
    let mut c = Decoded::new(format!("Befehl {name}"));
    match cmd_type {
        0x05 => decode_splice_insert(cmd, &mut c),
        0x06 => match splice_time(&mut Rd::new(cmd)) {
            Some(Some(p)) => c.f("pts_time", pts(p)),
            Some(None) => c.f("pts_time", "nicht angegeben (sofort)"),
            None => c.warn("splice_time abgeschnitten"),
        },
        0x00 | 0x07 => {}
        _ if !cmd.is_empty() => c.f("Rohdaten", hex(cmd)),
        _ => {}
    }
    d.children.push(c);
    let mut r = Rd::new(&sec[cmd_start + cmd_len..body_end]);
    let Some(dl) = r.u16() else {
        d.warn("descriptor_loop_length fehlt");
        return d;
    };
    d.f("descriptor_loop_length", dl);
    let Some(loop_bytes) = r.take(dl as usize) else {
        d.warn("descriptor_loop_length reicht über den Abschnitt hinaus");
        return d;
    };
    decode_descriptors(Rd::new(loop_bytes), &mut d);
    d
}

/// Hex-Text („FC 30 …“, „FC30…“, „0xFC, …“) oder Base64 → Bytes. `None`, wenn beides nicht passt.
pub fn parse_section_text(s: &str) -> Option<Vec<u8>> {
    let t = s.trim();
    let hexchars: String = t.chars().filter(|c| !c.is_whitespace() && *c != ',').collect::<String>().replace("0x", "").replace("0X", "");
    if !hexchars.is_empty() && hexchars.len() % 2 == 0 && hexchars.chars().all(|c| c.is_ascii_hexdigit()) {
        return (0..hexchars.len()).step_by(2).map(|i| u8::from_str_radix(&hexchars[i..i + 2], 16).ok()).collect();
    }
    base64_decode(t)
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.chars().filter(|c| !c.is_whitespace()) {
        let v = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => return None,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// splice_insert (Out, 30 s, Auto-Return, pts 10 s) – von Hand nach SCTE 35 aufgebaut, CRC berechnet.
    fn splice_insert_section() -> Vec<u8> {
        let mut cmd = vec![];
        cmd.extend_from_slice(&0x0000_0101u32.to_be_bytes()); // event id
        cmd.push(0x00); // cancel=0
        cmd.push(0b1100_0000 | 0b0010_0000 | 0b0000_1111); // out_of_network, program_splice, duration, !immediate, reserved
        let p = 900_000u64; // 10 s
        cmd.extend_from_slice(&[0x80 | ((p >> 32) as u8 & 1) | 0x7E, (p >> 24) as u8, (p >> 16) as u8, (p >> 8) as u8, p as u8]);
        let d = 30 * 90_000u64;
        cmd.extend_from_slice(&[0x80 | 0x7E | ((d >> 32) as u8 & 1), (d >> 24) as u8, (d >> 16) as u8, (d >> 8) as u8, d as u8]);
        cmd.extend_from_slice(&7u16.to_be_bytes()); // unique_program_id
        cmd.extend_from_slice(&[1, 2]); // avail_num, avails_expected
        let mut s = vec![0xFC, 0x30, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0xFF, 0xFF, 0xF0 | (cmd.len() >> 8) as u8, cmd.len() as u8, 0x05];
        s.extend_from_slice(&cmd);
        s.extend_from_slice(&[0, 0]); // descriptor_loop_length
        let len = s.len() + 4 - 3;
        s[1] = 0x30 | (len >> 8) as u8;
        s[2] = len as u8;
        let crc = crc32_mpeg(&s);
        s.extend_from_slice(&crc.to_be_bytes());
        s
    }

    fn time_signal_with_segmentation() -> Vec<u8> {
        let mut desc = vec![0x02, 0x00]; // tag, len (später)
        desc.extend_from_slice(b"CUEI");
        desc.extend_from_slice(&0xABCDu32.to_be_bytes());
        desc.push(0x7F); // cancel=0
        desc.push(0b1100_0000 | 0b0010_0000 | 0b0001_1111); // program, duration, delivery_not_restricted
        desc.extend_from_slice(&[0, 0, 0x02, 0xA3, 0x00]); // duration 0x2A300 = 172800 = 1.92 s
        desc.extend_from_slice(&[0x0F, 0x03]); // upid type URI, length 3
        desc.extend_from_slice(b"abc");
        desc.extend_from_slice(&[0x34, 1, 2]); // type id 0x34, num, expected
        desc.extend_from_slice(&[0, 0]); // sub segments (0x34 braucht sie)
        desc[1] = (desc.len() - 2) as u8;
        let cmd = vec![0x80 | 0x7E, 0, 0, 0x27, 0x10]; // pts 0x2710
        let mut s = vec![0xFC, 0x30, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0xFF, 0xFF, 0xF0 | (cmd.len() >> 8) as u8, cmd.len() as u8, 0x06];
        s.extend_from_slice(&cmd);
        s.extend_from_slice(&(desc.len() as u16).to_be_bytes());
        s.extend_from_slice(&desc);
        let len = s.len() + 4 - 3;
        s[1] = 0x30 | (len >> 8) as u8;
        s[2] = len as u8;
        let crc = crc32_mpeg(&s);
        s.extend_from_slice(&crc.to_be_bytes());
        s
    }

    #[test]
    fn scte35_splice_insert_is_decoded_with_crc_ok() {
        let d = scte35(&splice_insert_section());
        assert!(d.all_warnings().is_empty(), "{:?}", d.all_warnings());
        assert_eq!(d.get("CRC-32"), Some("gültig"));
        let c = &d.children[0];
        assert_eq!(c.get("splice_event_id"), Some("257"));
        assert!(c.get("out_of_network_indicator").unwrap().starts_with("true"));
        assert!(c.get("pts_time").unwrap().contains("10.000 s"));
        assert!(c.get("break_duration").unwrap().contains("30.000 s"));
        assert_eq!(c.get("auto_return"), Some("true"));
        assert_eq!(c.get("unique_program_id"), Some("7"));
        assert_eq!(c.get("avail_num / avails_expected"), Some("1 / 2"));
    }

    #[test]
    fn scte35_time_signal_with_segmentation_descriptor() {
        let d = scte35(&time_signal_with_segmentation());
        assert!(d.all_warnings().is_empty(), "{:?}", d.all_warnings());
        assert!(d.children[0].get("pts_time").unwrap().contains("0.111 s"));
        let seg = &d.children[1];
        assert!(seg.title.contains("segmentation_descriptor"));
        assert_eq!(seg.get("identifier"), Some("CUEI"));
        assert_eq!(seg.get("segmentation_event_id"), Some("43981"));
        assert!(seg.get("segmentation_duration").unwrap().contains("1.920 s"));
        assert_eq!(seg.get("segmentation_upid"), Some("\"abc\""));
        assert!(seg.get("segmentation_type_id").unwrap().contains("Provider Placement Opportunity Start"));
        assert_eq!(seg.get("sub_segment_num / sub_segments_expected"), Some("0 / 0"));
    }

    #[test]
    fn scte35_bad_crc_and_truncation_are_reported_not_fatal() {
        let mut s = splice_insert_section();
        let n = s.len();
        s[n - 1] ^= 0xFF;
        let d = scte35(&s);
        assert_eq!(d.get("CRC-32"), Some("FALSCH"));
        assert!(d.all_warnings().iter().any(|w| w.contains("CRC")));
        assert!(!d.children.is_empty(), "Befehl wird trotzdem gelesen");
        let cut = scte35(&splice_insert_section()[..20]);
        assert!(!cut.all_warnings().is_empty());
        assert!(!scte35(&[0xFC, 0x30]).warnings.is_empty());
        let mut enc = splice_insert_section();
        enc[4] |= 0x80;
        assert!(scte35(&enc).all_warnings().iter().any(|w| w.contains("verschlüsselt")));
    }

    fn mom(ops: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut m = vec![0xFF, 0xFF, 0, 0, 0, 0, 5, 0, 0, 0, 0, ops.len() as u8];
        for (id, d) in ops {
            m.extend_from_slice(&id.to_be_bytes());
            m.extend_from_slice(&(d.len() as u16).to_be_bytes());
            m.extend_from_slice(d);
        }
        let n = m.len() as u16;
        m[2..4].copy_from_slice(&n.to_be_bytes());
        m
    }

    #[test]
    fn scte104_mom_with_known_and_unknown_operations() {
        let mut splice = vec![2];
        splice.extend_from_slice(&1234u32.to_be_bytes());
        splice.extend_from_slice(&1u16.to_be_bytes());
        splice.extend_from_slice(&4000u16.to_be_bytes());
        splice.extend_from_slice(&300u16.to_be_bytes());
        splice.extend_from_slice(&[1, 2, 1, 0]);
        let m = mom(&[(0x0101, splice), (0x0104, 2000u16.to_be_bytes().to_vec()), (0x7777, vec![1, 2, 3])]);
        let d = scte104(&m);
        assert!(d.all_warnings().is_empty(), "{:?}", d.all_warnings());
        assert_eq!(d.get("message_number"), Some("5"));
        assert_eq!(d.get("num_ops"), Some("3"));
        let s = &d.children[0];
        assert!(s.title.contains("splice_request_data"));
        assert!(s.get("splice_insert_type").unwrap().contains("spliceStart_immediate"));
        assert_eq!(s.get("splice_event_id"), Some("1234"));
        assert_eq!(s.get("pre_roll_time"), Some("4000 ms"));
        assert_eq!(s.get("break_duration"), Some("30.0 s"));
        assert_eq!(d.children[1].get("pre_roll_time"), Some("2000 ms"));
        assert!(d.children[2].title.contains("unbekannte Operation") && d.children[2].get("Rohdaten") == Some("01 02 03"));
    }

    #[test]
    fn scte104_segmentation_op_and_damaged_messages() {
        let mut seg = vec![];
        seg.extend_from_slice(&9u32.to_be_bytes());
        seg.push(0);
        seg.extend_from_slice(&90u16.to_be_bytes());
        seg.extend_from_slice(&[0x0F, 2]);
        seg.extend_from_slice(b"ab");
        seg.extend_from_slice(&[0x30, 1, 1, 0, 1, 0, 0, 0, 3, 0, 0, 0]);
        let d = scte104(&mom(&[(0x010B, seg)]));
        assert!(d.all_warnings().is_empty(), "{:?}", d.all_warnings());
        let s = &d.children[0];
        assert_eq!(s.get("duration"), Some("90 s"));
        assert!(s.get("segmentation_type_id").unwrap().contains("Provider Advertisement Start"));
        assert_eq!(s.get("device_restrictions"), Some("3"));

        let mut bad = mom(&[(0x0104, vec![0, 1])]);
        bad.truncate(bad.len() - 1);
        let w = scte104(&bad).all_warnings();
        assert!(w.iter().any(|x| x.contains("messageSize")) && w.iter().any(|x| x.contains("Operation")), "{w:?}");
        assert!(!scte104(&[0xFF]).warnings.is_empty());
    }

    #[test]
    fn scte104_single_operation_message_header() {
        let mut m = vec![0x01, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0];
        m.extend_from_slice(&500u16.to_be_bytes());
        let n = m.len() as u16;
        m[2..4].copy_from_slice(&n.to_be_bytes());
        let d = scte104(&m);
        assert!(d.title.contains("single_operation_message") && d.title.contains("time_signal"));
        assert_eq!(d.get("message_number"), Some("3"));
        assert_eq!(d.children[0].get("pre_roll_time"), Some("500 ms"));
    }

    #[test]
    fn assembler_joins_packets_and_flags_orphans() {
        let mut a = Scte104Assembler::default();
        assert!(a.feed(&[0x08 | 4, 1, 2]).unwrap().is_none());
        let m = a.feed(&[0x08 | 2 | 1, 3]).unwrap().unwrap();
        assert_eq!(m.bytes, vec![1, 2, 3]);
        assert!(m.duplicate);
        assert!(a.feed(&[0x08 | 2, 9]).is_err(), "Folgepaket ohne Anfang");
        assert!(a.feed(&[0x08 | 4, 1]).unwrap().is_none());
        let m = a.feed(&[0x08, 7]).unwrap().unwrap();
        assert!(m.dropped_previous && m.bytes == vec![7], "neuer Anfang verwirft den offenen und meldet es");
        assert!(!a.feed(&[0x08, 8]).unwrap().unwrap().dropped_previous);
        assert!(a.feed(&[0xE8, 1]).is_err(), "falsche Version");
        assert!(a.feed(&[]).is_err());
    }

    #[test]
    fn section_text_accepts_hex_and_base64() {
        let s = splice_insert_section();
        let hex_text = hex(&s);
        assert_eq!(parse_section_text(&hex_text).unwrap(), s);
        assert_eq!(parse_section_text(&format!("0x{}", s.iter().map(|b| format!("{b:02x}")).collect::<String>())).unwrap(), s);
        let b64 = {
            const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut o = String::new();
            for ch in s.chunks(3) {
                let n = ch.iter().enumerate().fold(0u32, |a, (i, b)| a | (*b as u32) << (16 - 8 * i));
                for i in 0..4 {
                    if i <= ch.len() {
                        o.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
                    } else {
                        o.push('=');
                    }
                }
            }
            o
        };
        assert_eq!(parse_section_text(&b64).unwrap(), s);
        assert!(parse_section_text("zzz###").is_none());
    }
}
