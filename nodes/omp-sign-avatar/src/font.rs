//! Kleine eingebaute Bitmap-Schrift (5×7) für den Text-Rückfall im Bild (docs/GEBAERDENSPRACHE.md §3 Punkt 5): ist ein Satz nicht
//! gebärdbar, erscheint er als Text. Nur Großbuchstaben, Ziffern und Satzzeichen; Umlaute werden zu AE/OE/UE, ß zu SS.

/// Zeilen von oben nach unten, Bit 4 = linke Spalte.
fn glyph(c: char) -> [u8; 7] {
    match c {
        'A' => [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'B' => [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
        'C' => [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
        'D' => [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
        'E' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F],
        'F' => [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
        'G' => [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F],
        'H' => [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
        'I' => [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E],
        'J' => [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
        'K' => [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
        'L' => [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
        'M' => [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
        'N' => [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
        'O' => [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'P' => [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
        'Q' => [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
        'R' => [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
        'S' => [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
        'T' => [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
        'U' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
        'V' => [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
        'W' => [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A],
        'X' => [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
        'Y' => [0x11, 0x11, 0x11, 0x0A, 0x04, 0x04, 0x04],
        'Z' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
        '0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        '1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
        '3' => [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        '6' => [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
        '.' => [0, 0, 0, 0, 0, 0x0C, 0x0C],
        ',' => [0, 0, 0, 0, 0x0C, 0x04, 0x08],
        '!' => [0x04, 0x04, 0x04, 0x04, 0x04, 0, 0x04],
        '?' => [0x0E, 0x11, 0x01, 0x02, 0x04, 0, 0x04],
        '-' => [0, 0, 0, 0x1F, 0, 0, 0],
        ':' => [0, 0x0C, 0x0C, 0, 0x0C, 0x0C, 0],
        '\'' => [0x04, 0x04, 0x08, 0, 0, 0, 0],
        '%' => [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
        '/' => [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
        '(' => [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
        ')' => [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
        _ => [0; 7],
    }
}

fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            'ä' | 'Ä' => out.push_str("AE"),
            'ö' | 'Ö' => out.push_str("OE"),
            'ü' | 'Ü' => out.push_str("UE"),
            'ß' => out.push_str("SS"),
            '„' | '“' | '”' | '"' | '»' | '«' => out.push('\''),
            '–' | '—' => out.push('-'),
            c if c.is_whitespace() => out.push(' '),
            c => out.extend(c.to_uppercase()),
        }
    }
    out
}

/// Bricht auf Zeilen mit höchstens `cols` Zeichen (an Leerzeichen; zu lange Wörter werden getrennt), höchstens `max_lines`
/// Zeilen (der Rest wird mit „…“ → „..“ gekürzt).
pub fn wrap(text: &str, cols: usize, max_lines: usize) -> Vec<String> {
    let cols = cols.max(4);
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    for word in normalize(text).split(' ').filter(|w| !w.is_empty()) {
        let mut w = word.to_string();
        while w.chars().count() > cols {
            if !cur.is_empty() {
                lines.push(std::mem::take(&mut cur));
            }
            let head: String = w.chars().take(cols - 1).collect();
            lines.push(format!("{head}-"));
            w = w.chars().skip(cols - 1).collect();
        }
        let need = if cur.is_empty() { w.chars().count() } else { cur.chars().count() + 1 + w.chars().count() };
        if need > cols {
            lines.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(&w);
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    if lines.len() > max_lines {
        lines.truncate(max_lines);
        if let Some(l) = lines.last_mut() {
            let keep = l.chars().count().min(cols.saturating_sub(2));
            *l = format!("{}..", l.chars().take(keep).collect::<String>());
        }
    }
    lines
}

/// Rechtecke (x, y, Breite, Höhe in Bildpunkten) aller gesetzten Pixel einer Zeile, `cell` Bildpunkte je Schriftpixel,
/// links oben bei (x0, y0). Waagerecht zusammenhängende Pixel sind zu einem Rechteck verschmolzen.
pub fn line_rects(line: &str, x0: i32, y0: i32, cell: i32) -> Vec<(i32, i32, i32, i32)> {
    let mut out = Vec::new();
    for (ci, c) in line.chars().enumerate() {
        let g = glyph(c);
        let gx = x0 + ci as i32 * 6 * cell;
        for (row, bits) in g.iter().enumerate() {
            let mut col = 0;
            while col < 5 {
                if bits & (0x10 >> col) != 0 {
                    let start = col;
                    while col < 5 && bits & (0x10 >> col) != 0 {
                        col += 1;
                    }
                    out.push((gx + start * cell, y0 + row as i32 * cell, (col - start) * cell, cell));
                } else {
                    col += 1;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_at_word_boundaries_and_splits_long_words() {
        assert_eq!(wrap("Hallo schöne Welt", 10, 4), vec!["HALLO", "SCHOENE", "WELT"]);
        assert_eq!(wrap("aaa bbb ccc", 7, 4), vec!["AAA BBB", "CCC"]);
        assert_eq!(wrap("Donaudampfschifffahrt", 8, 4), vec!["DONAUDA-", "MPFSCHI-", "FFFAHRT"]);
    }

    #[test]
    fn too_many_lines_are_shortened_with_dots() {
        let l = wrap("eins zwei drei vier fünf sechs", 5, 2);
        assert_eq!(l.len(), 2);
        assert!(l[1].ends_with(".."));
    }

    #[test]
    fn glyph_rects_cover_exactly_the_set_pixels() {
        // „I“: Kopf- und Fußbalken breit (3 Pixel), Mitte ein Pixel
        let r = line_rects("I", 0, 0, 2);
        assert!(r.contains(&(2, 0, 6, 2)));
        assert!(r.contains(&(4, 6, 2, 2)));
        let pixels: i32 = r.iter().map(|(_, _, w, h)| w / 2 * (h / 2)).sum();
        assert_eq!(pixels, 3 + 5 + 3); // Balken oben, fünf Mittelpixel, Balken unten
    }
}
