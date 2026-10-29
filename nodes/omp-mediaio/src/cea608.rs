//! Minimaler CEA-608-Leser (Pop-on, CC1) für Empfänger, die den Untertitel eines CDP-Stroms (DID 0x61 / SDID 0x01) anzeigen sollen,
//! etwa wenn ein Viewer statt am Text-Strom am CEA-608-Ausgang des Untertitel-Nodes hängt. Roll-up/Paint-on werden nicht ausgewertet.

/// Zeichen aus den erweiterten Sätzen (0x12/0x13 nach dem Steuerbyte), soweit hier gebraucht.
fn extended(a: u8, b: u8) -> char {
    match (a, b) {
        (0x13, 0x30) => 'Ä',
        (0x13, 0x31) => 'ä',
        (0x13, 0x32) => 'Ö',
        (0x13, 0x33) => 'ö',
        (0x13, 0x34) => 'ß',
        (0x12, 0x24) => 'Ü',
        (0x12, 0x25) => 'ü',
        _ => '?',
    }
}

#[derive(Default)]
pub struct Cea608Decoder {
    mem: Vec<(u8, String)>,
    shown: Vec<(u8, String)>,
    last_ctl: Option<[u8; 2]>,
}

impl Cea608Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Verarbeitet ein CDP (Nutzdaten des ANC-Pakets); liest die 608-Paare des Feldes 1.
    pub fn feed_cdp(&mut self, cdp: &[u8]) {
        if cdp.len() < 9 || cdp[0] != 0x96 || cdp[1] != 0x69 {
            return;
        }
        let mut i = 7; // hinter Kopf: Kennung(2) Länge Rate Flags Folge(2)
        while i < cdp.len() {
            match cdp[i] {
                0x72 => {
                    let Some(&count) = cdp.get(i + 1) else { return };
                    let n = (count & 0x1F) as usize;
                    for k in 0..n {
                        let at = i + 2 + k * 3;
                        let Some(t) = cdp.get(at..at + 3) else { return };
                        if t[0] & 0x04 != 0 && t[0] & 0x03 == 0 {
                            self.pair(t[1], t[2]);
                        }
                    }
                    return;
                }
                0x71 => i += 2 + 4, // Zeitcode-Abschnitt
                _ => return,
            }
        }
    }

    fn pair(&mut self, raw_a: u8, raw_b: u8) {
        let (a, b) = (raw_a & 0x7F, raw_b & 0x7F);
        if a == 0 {
            return; // Füllpaar
        }
        if (0x10..=0x1F).contains(&a) {
            if self.last_ctl == Some([a, b]) {
                self.last_ctl = None;
                return; // doppelt gesendeter Befehl
            }
            self.last_ctl = Some([a, b]);
            match (a, b) {
                (0x14, 0x2E) => self.mem.clear(),
                (0x14, 0x2F) => self.shown = self.mem.clone(),
                (0x14, 0x2C) => self.shown.clear(),
                (0x12 | 0x13, _) => {
                    if let Some((_, t)) = self.mem.last_mut() {
                        t.pop();
                        t.push(extended(a, b));
                    }
                }
                (0x14, s) if s >= 0x40 => {
                    let row = if s >= 0x60 { 15 } else { 14 };
                    self.mem.push((row, " ".repeat(((s & 0x0E) >> 1) as usize * 4)));
                }
                _ => {}
            }
            return;
        }
        self.last_ctl = None;
        if let Some((_, line)) = self.mem.last_mut() {
            for c in [a, b] {
                if c >= 0x20 {
                    line.push(c as char);
                }
            }
        }
    }

    /// Aktuell angezeigter Text; mehrere Zeilen mit Leerzeichen verbunden, leer = nichts sichtbar.
    pub fn text(&self) -> String {
        self.shown.iter().map(|(_, t)| t.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn odd(b: u8) -> u8 {
        if b.count_ones() % 2 == 0 { b | 0x80 } else { b }
    }

    fn cdp(pair: [u8; 2]) -> Vec<u8> {
        let mut v = vec![0x96, 0x69, 0, 0x3F, 0x43, 0, 1, 0x72, 0xE2, 0xFC, pair[0], pair[1], 0xFD, 0x80, 0x80, 0x74, 0, 1, 0];
        v[2] = v.len() as u8;
        v
    }

    fn feed(d: &mut Cea608Decoder, pairs: &[[u8; 2]]) {
        for p in pairs {
            d.feed_cdp(&cdp([odd(p[0]), odd(p[1])]));
        }
    }

    #[test]
    fn pop_on_text_appears_after_eoc_and_erase_clears_it() {
        let mut d = Cea608Decoder::new();
        let mut pairs = vec![[0x14, 0x2E], [0x14, 0x2E], [0x14, 0x70], [0x14, 0x70]];
        pairs.extend(b"Hallo Welt!".chunks(2).map(|c| [c[0], *c.get(1).unwrap_or(&0)]));
        pairs.extend([[0x14, 0x2F], [0x14, 0x2F]]);
        feed(&mut d, &pairs[..pairs.len() - 2]);
        assert_eq!(d.text(), "", "vor EOC noch nichts sichtbar");
        feed(&mut d, &pairs[pairs.len() - 2..]);
        assert_eq!(d.text(), "Hallo Welt!");
        feed(&mut d, &[[0x14, 0x2C], [0x14, 0x2C]]);
        assert_eq!(d.text(), "");
    }

    #[test]
    fn extended_umlaut_replaces_the_preceding_placeholder() {
        let mut d = Cea608Decoder::new();
        feed(&mut d, &[[0x14, 0x2E], [0x14, 0x70], [b'S', b'c'], [b'h', b'o'], [0x13, 0x33], [b'n', 0], [0x14, 0x2F]]);
        assert_eq!(d.text(), "Schön");
    }
}
