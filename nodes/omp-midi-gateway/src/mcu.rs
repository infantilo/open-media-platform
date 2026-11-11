//! Mackie-Control-Codec (Kapitel 93) — Rust-Gegenstück zu `ui/shell/midi/mcu.ts`, gegen dieselben Prüfwerte getestet
//! (`docs/midi/golden.json`). Quelle und Prüfstatus: `docs/CONTRACT-MIDI.md` §2.

pub const DEVICE_ID_MCU: u8 = 0x14;
pub const FADER_MAX: i32 = 16383;

pub const NOTE_REC: u8 = 0;
pub const NOTE_SOLO: u8 = 8;
pub const NOTE_MUTE: u8 = 16;
pub const NOTE_SELECT: u8 = 24;
pub const NOTE_VPOT_PUSH: u8 = 32;
pub const NOTE_TOUCH: u8 = 104;
pub const NOTE_MASTER_TOUCH: u8 = 112;

/// Funktionstasten: Name → Note.
pub const BUTTONS: &[(&str, u8)] = &[
    ("assignTrack", 40), ("assignSend", 41), ("assignPan", 42), ("assignPlugin", 43), ("assignEq", 44), ("assignInstrument", 45),
    ("bankLeft", 46), ("bankRight", 47), ("channelLeft", 48), ("channelRight", 49), ("flip", 50), ("global", 51),
    ("nameValue", 52), ("smpteBeats", 53),
    ("f1", 54), ("f2", 55), ("f3", 56), ("f4", 57), ("f5", 58), ("f6", 59), ("f7", 60), ("f8", 61),
    ("midiTracks", 62), ("inputs", 63), ("audioTracks", 64), ("audioInstruments", 65), ("aux", 66), ("busses", 67), ("outputs", 68), ("user", 69),
    ("shift", 70), ("option", 71), ("control", 72), ("alt", 73),
    ("readOff", 74), ("write", 75), ("trim", 76), ("touch", 77), ("latch", 78), ("group", 79),
    ("save", 80), ("undo", 81), ("cancel", 82), ("enter", 83),
    ("markers", 84), ("nudge", 85), ("cycle", 86), ("drop", 87), ("replace", 88), ("click", 89), ("soloGlobal", 90),
    ("rewind", 91), ("forward", 92), ("stop", 93), ("play", 94), ("record", 95),
    ("up", 96), ("down", 97), ("left", 98), ("right", 99), ("zoom", 100), ("scrub", 101),
    ("userSwitch1", 102), ("userSwitch2", 103),
];

pub const BANK_LEFT: u8 = 46;
pub const BANK_RIGHT: u8 = 47;
pub const CHANNEL_LEFT: u8 = 48;
pub const CHANNEL_RIGHT: u8 = 49;
pub const NAME_VALUE: u8 = 52;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Led {
    Off,
    Blink,
    On,
}

/// Name einer Note: `rec3`, `solo1`, `mute8`, `select2`, `vpotPush5`, `touch9` oder Funktionstaste.
pub fn note_name(note: u8) -> Option<String> {
    for (n, base) in [("rec", NOTE_REC), ("solo", NOTE_SOLO), ("mute", NOTE_MUTE), ("select", NOTE_SELECT), ("vpotPush", NOTE_VPOT_PUSH)] {
        if note >= base && note < base + 8 {
            return Some(format!("{n}{}", note - base + 1));
        }
    }
    if (NOTE_TOUCH..=NOTE_MASTER_TOUCH).contains(&note) {
        return Some(format!("touch{}", note - NOTE_TOUCH + 1));
    }
    // Noten ohne Namen im Protokoll (frei belegbare Pads, „Navi“, „Focus“): `note<N>`, damit sie sich beobachten und belegen lassen
    BUTTONS.iter().find(|(_, v)| *v == note).map(|(k, _)| k.to_string()).or_else(|| (note <= 127).then(|| format!("note{note}")))
}

pub fn note_by_name(name: &str) -> Option<u8> {
    for (n, base) in [("rec", NOTE_REC), ("solo", NOTE_SOLO), ("mute", NOTE_MUTE), ("select", NOTE_SELECT), ("vpotPush", NOTE_VPOT_PUSH), ("touch", NOTE_TOUCH)] {
        if let Some(rest) = name.strip_prefix(n) {
            if let Ok(i) = rest.parse::<u8>() {
                let max = if n == "touch" { 9 } else { 8 };
                return if (1..=max).contains(&i) { Some(base + i - 1) } else { None };
            }
        }
    }
    if let Some(n) = name.strip_prefix("note").and_then(|r| r.parse::<u8>().ok()) {
        return (n <= 127).then_some(n);
    }
    BUTTONS.iter().find(|(k, _)| *k == name).map(|(_, v)| *v)
}

/// Strom-Parser: Laufstatus, SysEx über Blöcke; Echtzeitbytes werden verworfen.
#[derive(Default)]
pub struct MidiParser {
    status: u8,
    data: Vec<u8>,
    need: usize,
    sysex: Option<Vec<u8>>,
}

impl MidiParser {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        for &b in bytes {
            if b >= 0xf8 {
                continue;
            }
            if b == 0xf0 {
                self.sysex = Some(vec![0xf0]);
                self.status = 0;
                continue;
            }
            if b == 0xf7 {
                if let Some(mut s) = self.sysex.take() {
                    s.push(0xf7);
                    out.push(s);
                }
                continue;
            }
            if b & 0x80 != 0 {
                self.sysex = None;
                if b >= 0xf1 {
                    self.status = 0;
                    continue;
                }
                self.status = b;
                self.data.clear();
                self.need = if matches!(b & 0xf0, 0xc0 | 0xd0) { 1 } else { 2 };
                continue;
            }
            if let Some(s) = self.sysex.as_mut() {
                s.push(b);
                continue;
            }
            if self.status == 0 {
                continue;
            }
            self.data.push(b);
            if self.data.len() == self.need {
                let mut m = vec![self.status];
                m.extend_from_slice(&self.data);
                out.push(m);
                self.data.clear();
            }
        }
        out
    }
}

#[derive(Clone, PartialEq, Debug)]
pub enum McuEvent {
    Button { note: u8, name: Option<String>, down: bool },
    Touch { strip: u8, down: bool },
    Fader { strip: u8, value: i32 },
    Vpot { strip: u8, delta: i32 },
    Jog { delta: i32 },
    External { value: u8 },
    Sysex { device_id: u8, cmd: u8, data: Vec<u8> },
    Other(Vec<u8>),
}

/// Vorzeichen-Betrag: Bit 6 = gegen den Uhrzeigersinn, Bits 0–5 = Schritte.
pub fn decode_relative(v: u8) -> i32 {
    let mag = (v & 0x3f) as i32;
    if v & 0x40 != 0 { -mag } else { mag }
}

pub fn decode_from_surface(msg: &[u8]) -> McuEvent {
    if msg.is_empty() {
        return McuEvent::Other(vec![]);
    }
    let st = msg[0] & 0xf0;
    let ch = msg[0] & 0x0f;
    if msg[0] == 0xf0 {
        if msg.len() >= 7 && msg[1] == 0 && msg[2] == 0 && msg[3] == 0x66 {
            return McuEvent::Sysex { device_id: msg[4], cmd: msg[5], data: msg[6..msg.len() - 1].to_vec() };
        }
        return McuEvent::Other(msg.to_vec());
    }
    // Tasten, Drehgeber und Jog gelten nur auf MIDI-Kanal 1; alles andere (frei belegte Pads, Regler) bleibt `Other`
    if (st == 0x90 || st == 0x80) && ch == 0 && msg.len() >= 3 {
        let note = msg[1];
        let down = st == 0x90 && msg[2] > 0;
        if (NOTE_TOUCH..=NOTE_MASTER_TOUCH).contains(&note) {
            return McuEvent::Touch { strip: note - NOTE_TOUCH, down };
        }
        return McuEvent::Button { note, name: note_name(note), down };
    }
    if st == 0xe0 && ch <= 8 && msg.len() >= 3 {
        return McuEvent::Fader { strip: ch, value: ((msg[2] as i32) << 7) | msg[1] as i32 };
    }
    if st == 0xb0 && ch == 0 && msg.len() >= 3 {
        let cc = msg[1];
        if (0x10..=0x17).contains(&cc) {
            return McuEvent::Vpot { strip: cc - 0x10, delta: decode_relative(msg[2]) };
        }
        if cc == 0x3c {
            return McuEvent::Jog { delta: decode_relative(msg[2]) };
        }
        if cc == 0x2e {
            return McuEvent::External { value: msg[2] };
        }
    }
    McuEvent::Other(msg.to_vec())
}

// ───────── Rechner → Pult ─────────

pub fn led_note(note: u8, state: Led) -> Vec<u8> {
    vec![0x90, note, match state { Led::On => 0x7f, Led::Blink => 0x01, Led::Off => 0x00 }]
}

pub fn fader_move(strip: u8, value: i32) -> Vec<u8> {
    let v = value.clamp(0, FADER_MAX);
    vec![0xe0 | strip, (v & 0x7f) as u8, (v >> 7) as u8]
}

/// Alle vier Kranzarten des Pults; der Mischer-Anschluss braucht nur `Dot` (Pan), die übrigen gehören zum Codec.
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RingMode {
    Dot,
    Boost,
    Wrap,
    Spread,
}

pub fn vpot_ring(strip: u8, mode: RingMode, value: i32, led: bool) -> Vec<u8> {
    let m = match mode { RingMode::Dot => 0, RingMode::Boost => 1, RingMode::Wrap => 2, RingMode::Spread => 3 };
    vec![0xb0, 0x30 + strip, (if led { 0x40 } else { 0 }) | (m << 4) | (value.clamp(0, 11) as u8 & 0x0f)]
}

pub fn meter_level(strip: u8, level: i32) -> Vec<u8> {
    vec![0xd0, ((strip & 7) << 4) | (level.clamp(0, 15) as u8 & 0x0f)]
}

/// Pegel 0…1 → Stufe 0…12 (nie 0 bei hörbarem Signal).
pub fn meter_step(level01: f64) -> i32 {
    if level01 <= 0.005 { 0 } else { ((level01 * 12.0).round() as i32).clamp(1, 12) }
}

fn sysex(device_id: u8, cmd: u8, data: &[u8]) -> Vec<u8> {
    let mut v = vec![0xf0, 0x00, 0x00, 0x66, device_id, cmd];
    v.extend_from_slice(data);
    v.push(0xf7);
    v
}

pub fn device_query(id: u8) -> Vec<u8> {
    sysex(id, 0x00, &[])
}

/// Antwortcode auf die Anmeldeaufforderung (docs/CONTRACT-MIDI.md §2.4).
pub fn connection_response(c: [u8; 4]) -> [u8; 4] {
    let (c0, c1, c2, c3) = (c[0] as i32, c[1] as i32, c[2] as i32, c[3] as i32);
    [
        (0x7f & (c0 + (c1 ^ 0x0a) - c3)) as u8,
        (0x7f & ((c2 >> 4) ^ (c0 + c3))) as u8,
        (0x7f & ((c3 - (c2 << 2)) ^ (c0 | c1))) as u8,
        (0x7f & (c1 - c2 + (0xf0 ^ (c3 << 4)))) as u8,
    ]
}

pub fn host_connection_reply(device_id: u8, cmd: u8, data: &[u8]) -> Option<Vec<u8>> {
    if cmd != 0x01 || data.len() < 11 {
        return None;
    }
    let r = connection_response([data[7], data[8], data[9], data[10]]);
    let mut d = data[..7].to_vec();
    d.extend_from_slice(&r);
    Some(sysex(device_id, 0x02, &d))
}

pub fn lcd_ascii(s: &str) -> String {
    let mut r = String::new();
    for ch in s.chars() {
        let rep: &str = match ch {
            'ä' => "ae", 'ö' => "oe", 'ü' => "ue", 'Ä' => "Ae", 'Ö' => "Oe", 'Ü' => "Ue", 'ß' => "ss", '°' => "o", '–' | '—' => "-",
            _ => "",
        };
        if !rep.is_empty() {
            r.push_str(rep);
        } else if (0x20..=0x7e).contains(&(ch as u32)) {
            r.push(ch);
        } else {
            r.push('?');
        }
    }
    r
}

pub fn lcd_cell(s: &str, width: usize) -> String {
    let a: String = lcd_ascii(s).chars().take(width).collect();
    format!("{a:<width$}")
}

pub fn lcd_write(line: u8, col: usize, text: &str, id: u8) -> Vec<u8> {
    let t = lcd_ascii(text);
    let off = (if line == 0 { 0x00usize } else { 0x38usize }) + col;
    let room = (if line == 0 { 0x38usize } else { 0x70usize }).saturating_sub(off);
    let mut d = vec![off as u8];
    d.extend(t.bytes().take(room));
    sysex(id, 0x12, &d)
}

pub fn lcd_cells(top: &[String], bottom: &[String], id: u8) -> Vec<Vec<u8>> {
    let row = |c: &[String]| (0..8).map(|i| lcd_cell(c.get(i).map(String::as_str).unwrap_or(""), 6) + " ").collect::<String>();
    vec![lcd_write(0, 0, &row(top), id), lcd_write(1, 0, &row(bottom), id)]
}

pub fn seven_seg_cc(ch: char, dot: bool) -> u8 {
    let mut c = ch.to_ascii_uppercase() as u32;
    if !(0x20..=0x5f).contains(&c) {
        c = 0x20;
    }
    (if dot { 0x40 } else { 0 }) | (c as u8 & 0x3f)
}

/// 12 Stellen (Stelle 1 = ganz rechts = CC 0x40), `.` setzt den Punkt der davor stehenden Stelle.
pub fn seven_seg_text(text: &str) -> Vec<Vec<u8>> {
    let mut digits: Vec<(char, bool)> = Vec::new();
    for ch in text.chars() {
        if ch == '.' && !digits.is_empty() {
            digits.last_mut().unwrap().1 = true;
        } else {
            digits.push((ch, false));
        }
    }
    let start = digits.len().saturating_sub(12);
    let mut d: Vec<(char, bool)> = digits[start..].to_vec();
    while d.len() < 12 {
        d.insert(0, (' ', false));
    }
    d.reverse();
    d.iter().enumerate().map(|(i, (c, dot))| vec![0xb0, 0x40 + i as u8, seven_seg_cc(*c, *dot)]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../docs/midi/golden.json")).unwrap()
    }
    fn bytes(v: &Value) -> Vec<u8> {
        v.as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect()
    }

    #[test]
    fn encode_golden() {
        for c in golden()["encode"].as_array().unwrap() {
            let a = c["args"].as_array().unwrap();
            let got = match c["fn"].as_str().unwrap() {
                "ledNote" => led_note(a[0].as_u64().unwrap() as u8, match a[1].as_str().unwrap() { "on" => Led::On, "blink" => Led::Blink, _ => Led::Off }),
                "faderMove" => fader_move(a[0].as_u64().unwrap() as u8, a[1].as_i64().unwrap() as i32),
                "vpotRing" => vpot_ring(
                    a[0].as_u64().unwrap() as u8,
                    match a[1].as_str().unwrap() { "wrap" => RingMode::Wrap, "spread" => RingMode::Spread, "boost" => RingMode::Boost, _ => RingMode::Dot },
                    a[2].as_i64().unwrap() as i32,
                    a[3].as_bool().unwrap(),
                ),
                "meterLevel" => meter_level(a[0].as_u64().unwrap() as u8, a[1].as_i64().unwrap() as i32),
                "lcdWrite" => lcd_write(a[0].as_u64().unwrap() as u8, a[1].as_u64().unwrap() as usize, a[2].as_str().unwrap(), DEVICE_ID_MCU),
                "deviceQuery" => device_query(DEVICE_ID_MCU),
                f => panic!("unbekannte Funktion {f}"),
            };
            assert_eq!(got, bytes(&c["bytes"]), "{c}");
        }
    }

    #[test]
    fn decode_golden() {
        for c in golden()["decode"].as_array().unwrap() {
            let ev = decode_from_surface(&bytes(&c["bytes"]));
            let e = &c["event"];
            let want = match e["t"].as_str().unwrap() {
                "vpot" => McuEvent::Vpot { strip: e["strip"].as_u64().unwrap() as u8, delta: e["delta"].as_i64().unwrap() as i32 },
                "fader" => McuEvent::Fader { strip: e["strip"].as_u64().unwrap() as u8, value: e["value"].as_i64().unwrap() as i32 },
                "touch" => McuEvent::Touch { strip: e["strip"].as_u64().unwrap() as u8, down: e["down"].as_bool().unwrap() },
                "button" => McuEvent::Button { note: e["note"].as_u64().unwrap() as u8, name: Some(e["name"].as_str().unwrap().to_string()), down: e["down"].as_bool().unwrap() },
                "jog" => McuEvent::Jog { delta: e["delta"].as_i64().unwrap() as i32 },
                t => panic!("unbekannter Typ {t}"),
            };
            assert_eq!(ev, want, "{c}");
        }
    }

    #[test]
    fn connection_response_golden() {
        for c in golden()["connectionResponse"].as_array().unwrap() {
            let ch = bytes(&c["challenge"]);
            assert_eq!(connection_response([ch[0], ch[1], ch[2], ch[3]]).to_vec(), bytes(&c["response"]));
        }
    }

    #[test]
    fn stream_golden() {
        let g = golden();
        let mut p = MidiParser::default();
        let mut out = Vec::new();
        for ch in g["stream"]["chunks"].as_array().unwrap() {
            out.extend(p.push(&bytes(ch)));
        }
        let want: Vec<Vec<u8>> = g["stream"]["messages"].as_array().unwrap().iter().map(bytes).collect();
        assert_eq!(out, want);
        assert_eq!(MidiParser::default().push(&[0xf0, 0, 0, 0x90, 1, 2]), vec![vec![0x90, 1, 2]]);
    }

    #[test]
    fn names_and_reply() {
        assert_eq!(note_name(0).as_deref(), Some("rec1"));
        assert_eq!(note_name(112).as_deref(), Some("touch9"));
        assert_eq!(note_name(94).as_deref(), Some("play"));
        assert_eq!(note_name(120).as_deref(), Some("note120"));
        assert_eq!(note_by_name("note120"), Some(120));
        assert_eq!(note_by_name("note128"), None);
        assert!(matches!(decode_from_surface(&[0x91, 5, 127]), McuEvent::Other(_)));
        assert!(matches!(decode_from_surface(&[0xb2, 16, 5]), McuEvent::Other(_)));
        for n in 0..=112u8 {
            if let Some(name) = note_name(n) {
                assert_eq!(note_by_name(&name), Some(n), "{name}");
            }
        }
        assert_eq!(note_by_name("mute9"), None);
        let q = [65, 66, 67, 68, 69, 70, 71, 1, 2, 3, 4];
        assert_eq!(host_connection_reply(0x14, 0x01, &q).unwrap(), vec![0xf0, 0, 0, 0x66, 0x14, 0x02, 65, 66, 67, 68, 69, 70, 71, 5, 5, 123, 47, 0xf7]);
        assert!(host_connection_reply(0x14, 0x00, &q).is_none());
    }

    #[test]
    fn lcd_and_segments() {
        assert_eq!(lcd_ascii("Größe ä€"), "Groesse ae?");
        assert_eq!(lcd_cell("Mikrofon 1", 6), "Mikrof");
        let c = lcd_cells(&["Mic1".to_string()], &["-3.5dB".to_string()], 0x14);
        assert_eq!(c[0].len(), 7 + 56 + 1);
        assert_eq!(c[1][6], 0x38);
        assert_eq!(&c[0][7..14], b"Mic1   ");
        let m = seven_seg_text("01.02");
        assert_eq!(m.len(), 12);
        assert_eq!(m[0], vec![0xb0, 0x40, 0x32]);
        assert_eq!(m[2], vec![0xb0, 0x42, 0x40 | 0x31]);
        assert_eq!(m[11], vec![0xb0, 0x4b, 0x20]);
        assert_eq!(meter_step(0.0), 0);
        assert_eq!(meter_step(0.01), 1);
        assert_eq!(meter_step(1.0), 12);
        assert_eq!(meter_step(0.5), 6);
    }
}
