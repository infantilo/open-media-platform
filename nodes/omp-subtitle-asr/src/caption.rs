//! CEA-608-Untertitel (Pop-on, Kanal CC1) im Caption Distribution Packet (CDP, SMPTE 334-2 / CEA-708) für den ANC-Ausgang.
//!
//! Je Bild wird genau ein Byte-Paar (Feld 1) gesendet; ein neuer Untertitel wird als Pop-on-Folge aufgebaut (Speicher löschen,
//! Zeilen laden, am Ende „End of Caption“ = Anzeige), ein leerer Text löscht die Anzeige. Steuercodes gehen doppelt (so schreibt
//! es CEA-608 vor, Empfänger ignorieren das zweite Exemplar). Zeilenbreite 32 Zeichen, höchstens zwei Zeilen.
//!
//! Zeichensatz: ASCII soweit CEA-608 es kennt, Umlaute und ß über die erweiterten Zeichen (mit Ersatzzeichen davor), übrige
//! Akzentbuchstaben ohne Akzent, sonst `?`.

use std::collections::VecDeque;

pub const LINE_WIDTH: usize = 32;
/// DID/SDID des CDP im ANC-Paket (SMPTE 334-2).
pub const DID_CDP: u8 = 0x61;
pub const SDID_CDP: u8 = 0x01;

/// Ungerade Parität (Bit 7), wie CEA-608 sie je Byte verlangt.
pub fn odd(b: u8) -> u8 {
    let b = b & 0x7F;
    if b.count_ones() % 2 == 0 { b | 0x80 } else { b }
}

/// CDP-Bildratencode (SMPTE 334-2 Tab. 3).
pub fn rate_code(num: u32, den: u32) -> Option<u8> {
    match (num, den) {
        (24000, 1001) => Some(1),
        (24, 1) => Some(2),
        (25, 1) => Some(3),
        (30000, 1001) => Some(4),
        (30, 1) => Some(5),
        (50, 1) => Some(6),
        (60000, 1001) => Some(7),
        (60, 1) => Some(8),
        _ => None,
    }
}

/// Bytes für ein Zeichen: erst das Zeichen, bei erweiterten Zeichen danach das Code-Paar (`ext`).
struct Glyph {
    first: u8,
    ext: Option<(u8, u8)>,
}

fn glyph(c: char) -> Glyph {
    let basic = |b: u8| Glyph { first: b, ext: None };
    let ext = |fallback: u8, a: u8, b: u8| Glyph { first: fallback, ext: Some((a, b)) };
    match c {
        'á' => basic(0x2A),
        'é' => basic(0x5C),
        'í' => basic(0x5E),
        'ó' => basic(0x5F),
        'ú' => basic(0x60),
        'ç' => basic(0x7B),
        'Ñ' => basic(0x7D),
        'ñ' => basic(0x7E),
        'Ä' => ext(b'A', 0x13, 0x30),
        'ä' => ext(b'a', 0x13, 0x31),
        'Ö' => ext(b'O', 0x13, 0x32),
        'ö' => ext(b'o', 0x13, 0x33),
        'ß' => ext(b's', 0x13, 0x34),
        'Ü' => ext(b'U', 0x12, 0x24),
        'ü' => ext(b'u', 0x12, 0x25),
        '«' => ext(b'<', 0x12, 0x3E),
        '»' => ext(b'>', 0x12, 0x3F),
        // ASCII-Stellen, die CEA-608 anders belegt: Ersatz
        '*' => basic(b'-'),
        '\\' => basic(b'/'),
        '^' => basic(b'-'),
        '_' => basic(b'-'),
        '`' | '’' | '‘' => basic(b'\''),
        '{' => basic(b'('),
        '}' => basic(b')'),
        '|' => basic(b'/'),
        '~' => basic(b'-'),
        '“' | '”' | '„' => basic(b'"'),
        '–' | '—' => basic(b'-'),
        '€' => basic(b'E'),
        c if (' '..='~').contains(&c) => basic(c as u8),
        // Akzentbuchstaben ohne Akzent
        'à' | 'â' | 'å' => basic(b'a'),
        'è' | 'ê' | 'ë' => basic(b'e'),
        'ì' | 'î' | 'ï' => basic(b'i'),
        'ò' | 'ô' | 'õ' | 'ø' => basic(b'o'),
        'ù' | 'û' => basic(b'u'),
        'À' | 'Á' | 'Â' | 'Å' => basic(b'A'),
        'È' | 'É' | 'Ê' | 'Ë' => basic(b'E'),
        'Ì' | 'Í' | 'Î' | 'Ï' => basic(b'I'),
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ø' => basic(b'O'),
        'Ù' | 'Ú' | 'Û' => basic(b'U'),
        'Ç' => basic(b'C'),
        'ÿ' | 'ý' => basic(b'y'),
        _ => basic(b'?'),
    }
}

/// Zeichenfolge → Byte-Paare (Paritätswerte noch nicht gesetzt); ungerade Länge wird mit Null aufgefüllt.
fn text_bytes(line: &str) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    for c in line.chars() {
        let g = glyph(c);
        out.push(g.first);
        if let Some((a, b)) = g.ext {
            if out.len() % 2 == 1 {
                out.push(0x00);
            }
            out.push(a);
            out.push(b);
        }
    }
    if out.len() % 2 == 1 {
        out.push(0x00);
    }
    out
}

fn control(pairs: &mut Vec<[u8; 2]>, a: u8, b: u8) {
    pairs.push([odd(a), odd(b)]);
    pairs.push([odd(a), odd(b)]); // Steuercodes doppelt
}

/// Pop-on-Folge für ein bis zwei Zeilen (jede höchstens [`LINE_WIDTH`] Zeichen).
pub fn pop_on_pairs(lines: &[String]) -> Vec<[u8; 2]> {
    let mut pairs = Vec::new();
    control(&mut pairs, 0x14, 0x20); // RCL: Pop-on-Modus
    control(&mut pairs, 0x14, 0x2E); // ENM: nicht angezeigten Speicher löschen
    let n = lines.len().min(2);
    for (i, line) in lines.iter().take(2).enumerate() {
        let row15 = n == 1 || i == 1; // eine Zeile steht unten (Zeile 15), zwei Zeilen auf 14 und 15
        let len = line.chars().count().min(LINE_WIDTH);
        let indent = ((LINE_WIDTH - len) / 2) / 4 * 4; // nur Vielfache von 4 (PAC-Einrückung)
        let second = (if row15 { 0x70 } else { 0x50 }) | (((indent / 4) as u8) << 1);
        control(&mut pairs, 0x14, second); // PAC
        for chunk in text_bytes(line).chunks(2) {
            pairs.push([odd(chunk[0]), odd(chunk[1])]);
        }
    }
    control(&mut pairs, 0x14, 0x2F); // EOC: Speicher tauschen = anzeigen
    pairs
}

/// Anzeige löschen (EDM).
pub fn erase_pairs() -> Vec<[u8; 2]> {
    let mut p = Vec::new();
    control(&mut p, 0x14, 0x2C);
    p
}

/// CDP mit einem 608-Paar (Feld 1) und einem Nullpaar (Feld 2).
pub fn cdp(seq: u16, rate_code: u8, pair: [u8; 2]) -> Vec<u8> {
    let mut v = vec![0x96, 0x69, 0, (rate_code << 4) | 0x0F, 0x43, (seq >> 8) as u8, seq as u8, 0x72, 0xE0 | 2];
    v.extend_from_slice(&[0xFC, pair[0], pair[1]]);
    v.extend_from_slice(&[0xFD, 0x80, 0x80]);
    v.extend_from_slice(&[0x74, (seq >> 8) as u8, seq as u8]);
    v.push(0);
    let len = v.len() as u8;
    v[2] = len;
    let sum: u32 = v.iter().map(|b| *b as u32).sum();
    let last = v.len() - 1;
    v[last] = ((256 - (sum % 256)) % 256) as u8;
    v
}

/// Erzeugt je Bild ein CDP.
pub struct CaptionEncoder {
    queue: VecDeque<[u8; 2]>,
    seq: u16,
    rate_code: u8,
}

impl CaptionEncoder {
    pub fn new(num: u32, den: u32) -> Result<Self, String> {
        Ok(CaptionEncoder { queue: VecDeque::new(), seq: 0, rate_code: rate_code(num, den).ok_or_else(|| format!("Bildrate {num}/{den} kennt das CDP nicht"))? })
    }

    /// Neuer Untertitel (Zeilenumbrüche im Text werden zu Leerzeichen, die Zeilen neu auf 32 Zeichen umbrochen).
    pub fn show(&mut self, text: &str) {
        let mut lines = crate::output::wrap(text, LINE_WIDTH);
        lines.truncate(2);
        self.queue = pop_on_pairs(&lines).into();
    }

    pub fn clear(&mut self) {
        self.queue = erase_pairs().into();
    }

    /// Nächstes CDP (ein Paar aus der Warteschlange, sonst Nullpaar).
    pub fn next_cdp(&mut self) -> Vec<u8> {
        let pair = self.queue.pop_front().unwrap_or([0x80, 0x80]);
        let out = cdp(self.seq, self.rate_code, pair);
        self.seq = self.seq.wrapping_add(1);
        out
    }

    #[allow(dead_code)]
    pub fn idle(&self) -> bool {
        self.queue.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(b: u8) -> u8 {
        assert_eq!(odd(b), b, "Parität von 0x{b:02X}");
        b & 0x7F
    }

    /// Minimaler Pop-on-Decoder für die Prüfung: liefert (Zeile, Text) der angezeigten Zeilen nach EOC.
    fn decode(pairs: &[[u8; 2]]) -> Vec<(u8, String)> {
        let mut shown = Vec::new();
        let mut mem: Vec<(u8, String)> = Vec::new();
        let mut row = 15u8;
        let mut last_ctl: Option<[u8; 2]> = None;
        for p in pairs {
            let (a, b) = (strip(p[0]), strip(p[1]));
            if (0x10..=0x1F).contains(&a) {
                if last_ctl == Some([a, b]) {
                    last_ctl = None;
                    continue; // doppeltes Exemplar
                }
                last_ctl = Some([a, b]);
                match (a, b) {
                    (0x14, 0x2E) => mem.clear(),
                    (0x14, 0x2F) => shown = mem.clone(),
                    (0x14, 0x2C) => shown.clear(),
                    (0x14, 0x20) => {}
                    (0x12 | 0x13, _) => {
                        // erweitertes Zeichen: ersetzt das Zeichen davor
                        let c = match (a, b) {
                            (0x13, 0x30) => 'Ä', (0x13, 0x31) => 'ä', (0x13, 0x32) => 'Ö', (0x13, 0x33) => 'ö', (0x13, 0x34) => 'ß',
                            (0x12, 0x24) => 'Ü', (0x12, 0x25) => 'ü', _ => '?',
                        };
                        if let Some((_, t)) = mem.last_mut() {
                            t.pop();
                            t.push(c);
                        }
                    }
                    (0x14, s) if s >= 0x40 => {
                        row = if s >= 0x60 { 15 } else { 14 };
                        mem.push((row, " ".repeat(((s & 0x0E) >> 1) as usize * 4)));
                    }
                    _ => {}
                }
                continue;
            }
            last_ctl = None;
            for c in [a, b] {
                if c >= 0x20 {
                    mem.last_mut().expect("PAC vor Text").1.push(c as char);
                }
            }
        }
        shown
    }

    #[test]
    fn two_lines_decode_to_the_original_text_on_rows_14_and_15() {
        let lines = vec!["Guten Abend, meine Damen".to_string(), "und Herren.".to_string()];
        let d = decode(&pop_on_pairs(&lines));
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].0, 14);
        assert_eq!(d[1].0, 15);
        assert_eq!(d[0].1.trim(), "Guten Abend, meine Damen");
        assert_eq!(d[1].1.trim(), "und Herren.");
    }

    #[test]
    fn single_line_sits_on_row_15_and_is_centred_in_steps_of_four() {
        let d = decode(&pop_on_pairs(&["Hallo".to_string()]));
        assert_eq!(d[0].0, 15);
        assert_eq!(d[0].1.len() - d[0].1.trim_start().len(), 12); // (32-5)/2=13 → 12
    }

    #[test]
    fn umlauts_use_extended_characters_and_stay_aligned_to_pairs() {
        let lines = vec!["Schöne Grüße für Äpfel ß".to_string()];
        let pairs = pop_on_pairs(&lines);
        assert_eq!(decode(&pairs)[0].1.trim(), "Schöne Grüße für Äpfel ß");
        // jedes Paar ist vollständig mit Parität versehen
        assert!(pairs.iter().all(|p| odd(p[0]) == p[0] && odd(p[1]) == p[1]));
    }

    #[test]
    fn control_codes_are_sent_twice_and_erase_clears_the_display() {
        let e = erase_pairs();
        assert_eq!(e.len(), 2);
        assert_eq!(e[0], e[1]);
        let mut all = pop_on_pairs(&["x".to_string()]);
        all.extend(erase_pairs());
        assert!(decode(&all).is_empty());
    }

    #[test]
    fn cdp_is_well_formed_with_zero_checksum() {
        let c = cdp(0x0102, 3, [odd(b'H'), odd(b'i')]);
        assert_eq!(&c[..2], &[0x96, 0x69]);
        assert_eq!(c[2] as usize, c.len());
        assert_eq!(c[3] >> 4, 3);
        assert_eq!(&c[5..7], &[0x01, 0x02]);
        assert_eq!(c.iter().map(|b| *b as u32).sum::<u32>() % 256, 0);
        assert_eq!(&c[7..9], &[0x72, 0xE2]);
        assert_eq!(c[9], 0xFC);
    }

    #[test]
    fn encoder_emits_one_cdp_per_frame_and_counts_sequence() {
        let mut e = CaptionEncoder::new(25, 1).unwrap();
        e.show("Hallo Welt");
        let mut n = 0;
        while !e.idle() {
            let c = e.next_cdp();
            assert_eq!(u16::from_be_bytes([c[5], c[6]]), n);
            n += 1;
        }
        assert!(n >= 8, "{n}");
        assert_eq!(e.next_cdp()[10], 0x80, "danach Nullpaare");
        assert!(CaptionEncoder::new(7, 3).is_err());
    }

    #[test]
    fn unknown_characters_degrade_instead_of_breaking() {
        let d = decode(&pop_on_pairs(&["Cafï 日本 * _".to_string()]));
        assert_eq!(d[0].1.trim(), "Cafi ?? - -");
    }

    #[test]
    fn media_io_reader_decodes_what_the_encoder_sends() {
        let mut enc = CaptionEncoder::new(25, 1).unwrap();
        enc.show("Guten Abend, schöne Grüße");
        let mut dec = omp_mediaio::cea608::Cea608Decoder::new();
        for _ in 0..60 {
            dec.feed_cdp(&enc.next_cdp());
        }
        assert_eq!(dec.text(), "Guten Abend, schöne Grüße");
        enc.clear();
        for _ in 0..10 {
            dec.feed_cdp(&enc.next_cdp());
        }
        assert_eq!(dec.text(), "");
    }
}
