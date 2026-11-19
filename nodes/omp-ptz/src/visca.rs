//! VISCA über IP — reine Kodierung und Dekodierung (keine Ein-/Ausgabe, keine Zeit).
//!
//! Quelle: Befehlsliste „VISCA over IP“ und VISCA-Befehle einer Kamera-Familie des Herstellers Sony,
//! Dokument 5-042-055-04 (1), © 2022 (ILME-FR7). **VISCA ist keine Norm einer Normungsorganisation**, sondern eine
//! Herstellerspezifikation; die Byte-Folgen unten sind dieser Liste entnommen (Abschnitt „VISCA over IP“, Befehlsliste
//! Seiten 14–20). Wertebereiche, die die Liste je Kameramodell offen lässt (Pan/Tilt-Weg, Zoom-Ende), stehen **nicht** hier,
//! sondern im Gerät und werden zur Laufzeit abgefragt.
//!
//! **Paketkopf (8 Byte):** Nutzlasttyp (2) · Nutzlastlänge (2, Nutzlast 1…16 Byte) · Sequenznummer (4), alles Big-Endian; danach
//! die VISCA-Nachricht. UDP-Port 52381; Zustellbestätigung und Wiederholung liegen bei der Anwendung (`ptz.rs` nutzt dafür die
//! Antwort-Fristen, nicht erneutes Senden).
//!
//! **Nachrichten:** Befehl `8X 01 … FF`, Abfrage `8X 09 … FF` (`X` = 1 bei VISCA über IP), Antwort `Y0 4Z FF` (ACK),
//! `Y0 5Z … FF` (Abschluss, bei Abfragen mit Daten), `Y0 6Z EE FF` (Fehler); `Y` = 9, `Z` = Socketnummer.

pub const PORT: u16 = 52381;
pub const HEADER_LEN: usize = 8;
pub const MAX_PAYLOAD: usize = 16;

/// Nutzlasttypen des Paketkopfs.
pub mod payload_type {
    pub const COMMAND: u16 = 0x0100;
    pub const INQUIRY: u16 = 0x0110;
    pub const REPLY: u16 = 0x0111;
    #[allow(dead_code)]
    pub const DEVICE_SETTING: u16 = 0x0120;
    pub const CONTROL: u16 = 0x0200;
    pub const CONTROL_REPLY: u16 = 0x0201;
}

/// Nutzlast der Steuernachricht „RESET“ (Sequenznummer des Geräts auf 0 zurücksetzen).
pub const CONTROL_RESET: u8 = 0x01;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    pub kind: u16,
    pub seq: u32,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    TooShort,
    LengthMismatch { declared: usize, actual: usize },
    PayloadTooLong(usize),
}

pub fn frame(kind: u16, seq: u32, payload: &[u8]) -> Vec<u8> {
    debug_assert!(payload.len() <= MAX_PAYLOAD);
    let mut v = Vec::with_capacity(HEADER_LEN + payload.len());
    v.extend_from_slice(&kind.to_be_bytes());
    v.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    v.extend_from_slice(&seq.to_be_bytes());
    v.extend_from_slice(payload);
    v
}

pub fn parse(buf: &[u8]) -> Result<Packet, ParseError> {
    if buf.len() < HEADER_LEN {
        return Err(ParseError::TooShort);
    }
    let kind = u16::from_be_bytes([buf[0], buf[1]]);
    let declared = u16::from_be_bytes([buf[2], buf[3]]) as usize;
    let seq = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
    let actual = buf.len() - HEADER_LEN;
    if declared > MAX_PAYLOAD {
        return Err(ParseError::PayloadTooLong(declared));
    }
    if declared != actual {
        return Err(ParseError::LengthMismatch { declared, actual });
    }
    Ok(Packet { kind, seq, payload: buf[HEADER_LEN..].to_vec() })
}

// ───────────────────────── Werte-Kodierung ─────────────────────────

/// 16-Bit-Wert (Zweierkomplement) als vier Nibbles `0p 0p 0p 0p`, höchstes zuerst.
pub fn nibbles16(v: i16) -> [u8; 4] {
    let u = v as u16;
    [((u >> 12) & 0xF) as u8, ((u >> 8) & 0xF) as u8, ((u >> 4) & 0xF) as u8, (u & 0xF) as u8]
}

pub fn from_nibbles16(b: &[u8]) -> Option<i16> {
    if b.len() < 4 || b[..4].iter().any(|x| *x > 0x0F) {
        return None;
    }
    Some((((b[0] as u16) << 12) | ((b[1] as u16) << 8) | ((b[2] as u16) << 4) | b[3] as u16) as i16)
}

// ───────────────────────── Befehle ─────────────────────────

/// Adressbyte bei VISCA über IP: fest `0x81`.
const ADDR: u8 = 0x81;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanDir {
    Left,
    Right,
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TiltDir {
    Up,
    Down,
    Stop,
}

/// Pan-Tilt-Fahrt (`8x 01 06 01 vv ww pp tt FF`). Geschwindigkeiten ab 1; für eine stehende Achse gilt 1 mit Richtung „Stop“.
pub fn pan_tilt_drive(pan_speed: u8, tilt_speed: u8, pan: PanDir, tilt: TiltDir) -> Vec<u8> {
    let p = match pan {
        PanDir::Left => 0x01,
        PanDir::Right => 0x02,
        PanDir::Stop => 0x03,
    };
    let t = match tilt {
        TiltDir::Up => 0x01,
        TiltDir::Down => 0x02,
        TiltDir::Stop => 0x03,
    };
    vec![ADDR, 0x01, 0x06, 0x01, pan_speed.max(1), tilt_speed.max(1), p, t, 0xFF]
}

pub fn pan_tilt_stop() -> Vec<u8> {
    pan_tilt_drive(1, 1, PanDir::Stop, TiltDir::Stop)
}

/// Absolute Position (`8x 01 06 02 vv ww 0p0p0p0p 0t0t0t0t FF`). Die Liste lässt die Wertebereiche modellabhängig.
pub fn pan_tilt_absolute(pan_speed: u8, tilt_speed: u8, pan: i16, tilt: i16) -> Vec<u8> {
    let mut v = vec![ADDR, 0x01, 0x06, 0x02, pan_speed.max(1), tilt_speed.max(1)];
    v.extend_from_slice(&nibbles16(pan));
    v.extend_from_slice(&nibbles16(tilt));
    v.push(0xFF);
    v
}

pub fn pan_tilt_home() -> Vec<u8> {
    vec![ADDR, 0x01, 0x06, 0x04, 0xFF]
}

/// Zoom stoppen (`8x 01 04 07 00 FF`).
pub fn zoom_stop() -> Vec<u8> {
    vec![ADDR, 0x01, 0x04, 0x07, 0x00, 0xFF]
}

/// Zoom mit veränderlicher Geschwindigkeit `0…7` (`8x 01 04 07 2p FF` Tele, `3p` Weit).
pub fn zoom_variable(tele: bool, speed: u8) -> Vec<u8> {
    let p = speed.min(7);
    vec![ADDR, 0x01, 0x04, 0x07, if tele { 0x20 | p } else { 0x30 | p }, 0xFF]
}

/// Zoom auf Position (`8x 01 04 47 0z0z0z0z FF`); die Liste nennt für das beschriebene Modell 0000…6000.
pub fn zoom_direct(pos: u16) -> Vec<u8> {
    let n = nibbles16(pos as i16);
    vec![ADDR, 0x01, 0x04, 0x47, n[0], n[1], n[2], n[3], 0xFF]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresetOp {
    Reset = 0x00,
    Set = 0x01,
    Recall = 0x02,
}

/// Preset (`8x 01 04 3F 00|01|02 pp FF`); `pp` zählt ab 0 (die Liste nennt 00…63).
pub fn preset(op: PresetOp, number: u8) -> Vec<u8> {
    vec![ADDR, 0x01, 0x04, 0x3F, op as u8, number, 0xFF]
}

pub fn inq_pan_tilt_position() -> Vec<u8> {
    vec![ADDR, 0x09, 0x06, 0x12, 0xFF]
}

pub fn inq_zoom_position() -> Vec<u8> {
    vec![ADDR, 0x09, 0x04, 0x47, 0xFF]
}

pub fn inq_version() -> Vec<u8> {
    vec![ADDR, 0x09, 0x00, 0x02, 0xFF]
}

// ───────────────────────── Antworten ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Ack { socket: u8 },
    /// Abschluss; bei Abfragen mit den Daten zwischen `Y0 5Z` und `FF`.
    Completion { socket: u8, data: Vec<u8> },
    Error { socket: u8, code: u8 },
}

/// Fehlercodes `Y0 6Z ee FF` laut Liste.
pub fn error_text(code: u8) -> &'static str {
    match code {
        0x01 => "Nachrichtenlänge falsch",
        0x02 => "Syntaxfehler",
        0x03 => "Befehlspuffer voll",
        0x04 => "Befehl abgebrochen",
        0x05 => "Kein Socket (Abbruch)",
        0x41 => "Befehl jetzt nicht ausführbar",
        _ => "unbekannter Fehler",
    }
}

pub fn parse_reply(msg: &[u8]) -> Option<Reply> {
    if msg.len() < 3 || *msg.last()? != 0xFF || msg[0] & 0x0F != 0 || msg[0] < 0x90 {
        return None;
    }
    let (class, socket) = (msg[1] >> 4, msg[1] & 0x0F);
    match class {
        4 if msg.len() == 3 => Some(Reply::Ack { socket }),
        5 => Some(Reply::Completion { socket, data: msg[2..msg.len() - 1].to_vec() }),
        6 if msg.len() == 4 => Some(Reply::Error { socket, code: msg[2] }),
        _ => None,
    }
}

/// Antwort auf `inq_pan_tilt_position`: (pan, tilt).
pub fn decode_pan_tilt(data: &[u8]) -> Option<(i16, i16)> {
    if data.len() != 8 {
        return None;
    }
    Some((from_nibbles16(&data[0..4])?, from_nibbles16(&data[4..8])?))
}

pub fn decode_zoom(data: &[u8]) -> Option<u16> {
    if data.len() != 4 {
        return None;
    }
    from_nibbles16(data).map(|v| v as u16)
}

/// Antwort auf `inq_version`: (Hersteller, Modell, ROM-Stand, Socketzahl).
pub fn decode_version(data: &[u8]) -> Option<(u16, u16, u16, u8)> {
    if data.len() != 7 {
        return None;
    }
    Some((u16::from_be_bytes([data[0], data[1]]), u16::from_be_bytes([data[2], data[3]]), u16::from_be_bytes([data[4], data[5]]), data[6]))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Die Gegenstücke stehen in der Befehlsliste (Seiten 14–20); die Bytes sind dort wörtlich so angegeben.
    #[test]
    fn befehle_wie_in_der_liste() {
        assert_eq!(pan_tilt_drive(0x0A, 0x05, PanDir::Left, TiltDir::Up), [0x81, 0x01, 0x06, 0x01, 0x0A, 0x05, 0x01, 0x01, 0xFF]);
        assert_eq!(pan_tilt_drive(3, 3, PanDir::Right, TiltDir::Down), [0x81, 0x01, 0x06, 0x01, 3, 3, 0x02, 0x02, 0xFF]);
        assert_eq!(pan_tilt_stop(), [0x81, 0x01, 0x06, 0x01, 0x01, 0x01, 0x03, 0x03, 0xFF]);
        assert_eq!(pan_tilt_home(), [0x81, 0x01, 0x06, 0x04, 0xFF]);
        assert_eq!(zoom_stop(), [0x81, 0x01, 0x04, 0x07, 0x00, 0xFF]);
        assert_eq!(zoom_variable(true, 5), [0x81, 0x01, 0x04, 0x07, 0x25, 0xFF]);
        assert_eq!(zoom_variable(false, 7), [0x81, 0x01, 0x04, 0x07, 0x37, 0xFF]);
        assert_eq!(zoom_variable(true, 99), [0x81, 0x01, 0x04, 0x07, 0x27, 0xFF]); // Geschwindigkeit wird auf 7 begrenzt
        assert_eq!(zoom_direct(0x6000), [0x81, 0x01, 0x04, 0x47, 0x06, 0x00, 0x00, 0x00, 0xFF]);
        assert_eq!(preset(PresetOp::Set, 5), [0x81, 0x01, 0x04, 0x3F, 0x01, 0x05, 0xFF]);
        assert_eq!(preset(PresetOp::Recall, 63), [0x81, 0x01, 0x04, 0x3F, 0x02, 63, 0xFF]);
        assert_eq!(preset(PresetOp::Reset, 0), [0x81, 0x01, 0x04, 0x3F, 0x00, 0x00, 0xFF]);
        assert_eq!(inq_pan_tilt_position(), [0x81, 0x09, 0x06, 0x12, 0xFF]);
        assert_eq!(inq_zoom_position(), [0x81, 0x09, 0x04, 0x47, 0xFF]);
        assert_eq!(inq_version(), [0x81, 0x09, 0x00, 0x02, 0xFF]);
    }

    #[test]
    fn geschwindigkeit_null_wird_eins() {
        assert_eq!(pan_tilt_drive(0, 0, PanDir::Left, TiltDir::Stop)[4..6], [1, 1]);
    }

    #[test]
    fn absolute_position_mit_vorzeichen() {
        let c = pan_tilt_absolute(0x18, 0x14, -1, 0x0123);
        assert_eq!(c, [0x81, 0x01, 0x06, 0x02, 0x18, 0x14, 0x0F, 0x0F, 0x0F, 0x0F, 0x00, 0x01, 0x02, 0x03, 0xFF]);
    }

    #[test]
    fn nibbles_rund() {
        for v in [0i16, 1, -1, 2448, -2448, i16::MAX, i16::MIN, 0x1234] {
            assert_eq!(from_nibbles16(&nibbles16(v)), Some(v));
        }
        assert_eq!(from_nibbles16(&[0, 0, 0x10, 0]), None);
        assert_eq!(from_nibbles16(&[0, 0, 0]), None);
    }

    // Beispiel aus der Herstellerdokumentation der Abfrage: `01 10 00 05 00 00 00 00 81 09 06 12 FF`.
    #[test]
    fn paketkopf_beispiel_abfrage() {
        let f = frame(payload_type::INQUIRY, 0, &inq_pan_tilt_position());
        assert_eq!(f, [0x01, 0x10, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x81, 0x09, 0x06, 0x12, 0xFF]);
        let p = parse(&f).unwrap();
        assert_eq!((p.kind, p.seq, p.payload), (0x0110, 0, inq_pan_tilt_position()));
    }

    #[test]
    fn paketkopf_sequenz_und_fehler() {
        let f = frame(payload_type::COMMAND, 0x0102_0304, &zoom_stop());
        assert_eq!(&f[..8], [0x01, 0x00, 0x00, 0x06, 0x01, 0x02, 0x03, 0x04]);
        assert_eq!(parse(&f[..5]), Err(ParseError::TooShort));
        assert_eq!(parse(&f[..f.len() - 1]), Err(ParseError::LengthMismatch { declared: 6, actual: 5 }));
        let mut lang = frame(payload_type::COMMAND, 1, &[0u8; 16]);
        lang[3] = 17;
        assert_eq!(parse(&lang), Err(ParseError::PayloadTooLong(17)));
    }

    #[test]
    fn antworten() {
        assert_eq!(parse_reply(&[0x90, 0x41, 0xFF]), Some(Reply::Ack { socket: 1 }));
        assert_eq!(parse_reply(&[0x90, 0x52, 0xFF]), Some(Reply::Completion { socket: 2, data: vec![] }));
        assert_eq!(parse_reply(&[0x90, 0x60, 0x02, 0xFF]), Some(Reply::Error { socket: 0, code: 0x02 }));
        assert_eq!(parse_reply(&[0x90, 0x62, 0x41, 0xFF]), Some(Reply::Error { socket: 2, code: 0x41 }));
        assert_eq!(parse_reply(&[0x90, 0x50, 0x00, 0x00, 0x0A, 0x0B, 0xFF]), Some(Reply::Completion { socket: 0, data: vec![0, 0, 0x0A, 0x0B] }));
        assert_eq!(parse_reply(&[0x90, 0x41]), None); // ohne Ende
        assert_eq!(parse_reply(&[0x81, 0x41, 0xFF]), None); // kein Antwortbyte
        assert_eq!(parse_reply(&[0x90, 0x70, 0xFF]), None);
    }

    #[test]
    fn abfrage_antworten_dekodieren() {
        let mut d = Vec::new();
        d.extend_from_slice(&nibbles16(-300));
        d.extend_from_slice(&nibbles16(120));
        assert_eq!(decode_pan_tilt(&d), Some((-300, 120)));
        assert_eq!(decode_pan_tilt(&d[..7]), None);
        assert_eq!(decode_zoom(&nibbles16(0x4000)), Some(0x4000));
        // Version laut Liste: Y0 50 GGGG HHHH JJJJ KK FF, Hersteller 0001, Modell z. B. 051E, Sockets 02
        assert_eq!(decode_version(&[0x00, 0x01, 0x05, 0x1E, 0x01, 0x02, 0x02]), Some((1, 0x051E, 0x0102, 2)));
    }

    #[test]
    fn fehlertexte() {
        assert_eq!(error_text(0x41), "Befehl jetzt nicht ausführbar");
        assert_eq!(error_text(0x99), "unbekannter Fehler");
    }
}
