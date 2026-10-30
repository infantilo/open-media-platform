//! Untertitel-Aufbereitung: Text in Zeilen (≤ 42 Zeichen) und Anzeigeeinheiten (≤ 2 Zeilen) brechen, Anzeigedauer nach
//! Lesegeschwindigkeit, SRT-Ausgabe. Die Anzeigeregeln folgen den üblichen Rundfunk-Vorgaben (2 Zeilen, ~42 Zeichen, 15–17
//! Zeichen/s, mindestens 1,2 s, höchstens 7 s).

pub const MAX_LINE: usize = 42;
const MAX_LINES: usize = 2;
const CHARS_PER_SECOND: f64 = 15.0;
const MIN_MS: i64 = 1_200;
const MAX_MS: i64 = 7_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start_ms: i64,
    pub end_ms: i64,
    /// Zeilen mit `\n` getrennt.
    pub text: String,
}

/// Bricht Text an Wortgrenzen in Zeilen von höchstens `max` Zeichen.
pub fn wrap(text: &str, max: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    for word in text.split_whitespace() {
        if !cur.is_empty() && cur.chars().count() + 1 + word.chars().count() > max {
            lines.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(word);
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}

/// Lesedauer in ms für einen Text.
pub fn reading_ms(text: &str) -> i64 {
    ((text.chars().count() as f64 / CHARS_PER_SECOND) * 1000.0) as i64
}

/// Zerlegt erkannten Text in Anzeigeeinheiten ab `start_ms`; jede Einheit läuft nach Lesedauer, die nächste schließt nahtlos an.
pub fn cues_for(text: &str, start_ms: i64) -> Vec<Cue> {
    cues_for_width(text, start_ms, MAX_LINE)
}

/// Wie [`cues_for`] mit eigener Zeilenbreite (CEA-608: 32 Zeichen).
pub fn cues_for_width(text: &str, start_ms: i64, width: usize) -> Vec<Cue> {
    let lines = wrap(text, width);
    let mut cues = Vec::new();
    let mut t = start_ms;
    for group in lines.chunks(MAX_LINES) {
        let body = group.join("\n");
        let dur = reading_ms(&body).clamp(MIN_MS, MAX_MS);
        cues.push(Cue { start_ms: t, end_ms: t + dur, text: body });
        t += dur;
    }
    cues
}

/// Zerlegt Text in Anzeigeeinheiten innerhalb eines gegebenen Zeitfensters (Datei-Untertitel: die Sprechzeit steht fest, anders als bei
/// Live). Die Dauer verteilt sich nach Zeichenzahl auf die Einheiten (je mindestens 700 ms, das Fenster wächst notfalls darüber hinaus).
pub fn cues_between(text: &str, start_ms: i64, end_ms: i64) -> Vec<Cue> {
    let lines = wrap(text, MAX_LINE);
    let groups: Vec<String> = lines.chunks(MAX_LINES).map(|g| g.join("\n")).collect();
    if groups.is_empty() {
        return Vec::new();
    }
    const FLOOR_MS: i64 = 700;
    let total = (end_ms - start_ms).max(FLOOR_MS * groups.len() as i64);
    let weight: usize = groups.iter().map(|g| g.chars().count().max(1)).sum();
    let mut out = Vec::with_capacity(groups.len());
    let mut t = start_ms;
    let mut left = total;
    for (i, g) in groups.iter().enumerate() {
        let remaining = (groups.len() - i - 1) as i64;
        let share = if remaining == 0 { left } else { ((total as f64 * g.chars().count().max(1) as f64 / weight as f64) as i64).clamp(FLOOR_MS, left - FLOOR_MS * remaining) };
        out.push(Cue { start_ms: t, end_ms: t + share, text: g.clone() });
        t += share;
        left -= share;
    }
    out
}

/// Ordnet Einheiten nach Beginn und beseitigt Überlappungen (z. B. Sprecher, die durcheinander reden): die frühere Einheit wird
/// gekürzt (nicht unter 500 ms), reicht das nicht, rückt die spätere nach hinten. Danach hat jede Einheit Ende > Beginn.
pub fn tidy(cues: &mut Vec<Cue>) {
    cues.sort_by_key(|c| (c.start_ms, c.end_ms));
    for i in 1..cues.len() {
        let (head, tail) = cues.split_at_mut(i);
        let (prev, cur) = (&mut head[i - 1], &mut tail[0]);
        if cur.start_ms < prev.end_ms {
            let cut = cur.start_ms.max(prev.start_ms + 500);
            prev.end_ms = cut;
            if cur.start_ms < prev.end_ms {
                let len = cur.end_ms - cur.start_ms;
                cur.start_ms = prev.end_ms;
                cur.end_ms = cur.start_ms + len.max(1);
            }
        }
    }
}

/// Komplette SRT-Datei (Nummerierung ab 1, Zeiten ab Dateibeginn).
pub fn srt_file(cues: &[Cue]) -> String {
    cues.iter().enumerate().map(|(i, c)| srt_block(i + 1, c, 0)).collect()
}

fn stamp(ms: i64) -> String {
    let ms = ms.max(0);
    format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

/// Ein SRT-Block (Nummer ab 1) mit Zeiten relativ zu `track_start_ms`.
pub fn srt_block(index: usize, cue: &Cue, track_start_ms: i64) -> String {
    format!("{index}\n{} --> {}\n{}\n\n", stamp(cue.start_ms - track_start_ms), stamp(cue.end_ms - track_start_ms), cue.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_at_word_boundaries() {
        let l = wrap("Das ist ein ziemlich langer Satz, der sicher nicht in eine einzige Zeile passt.", 42);
        assert_eq!(l.len(), 2);
        assert!(l.iter().all(|x| x.chars().count() <= 42));
        assert_eq!(l.join(" "), "Das ist ein ziemlich langer Satz, der sicher nicht in eine einzige Zeile passt.");
    }

    #[test]
    fn long_text_becomes_several_cues_back_to_back() {
        let text = "Wort ".repeat(60);
        let cues = cues_for(&text, 10_000);
        assert!(cues.len() >= 2);
        for w in cues.windows(2) {
            assert_eq!(w[0].end_ms, w[1].start_ms);
        }
        assert!(cues.iter().all(|c| c.text.lines().count() <= 2));
    }

    #[test]
    fn short_text_gets_the_minimum_duration() {
        let c = &cues_for("Ja.", 0)[0];
        assert_eq!(c.end_ms - c.start_ms, 1_200);
    }

    #[test]
    fn cues_between_fills_the_window_proportionally() {
        let text = "Wort ".repeat(40);
        let c = cues_between(text.trim(), 1_000, 11_000);
        assert!(c.len() >= 2);
        assert_eq!(c[0].start_ms, 1_000);
        assert_eq!(c.last().unwrap().end_ms, 11_000, "das Fenster wird genau ausgefüllt");
        for w in c.windows(2) {
            assert_eq!(w[0].end_ms, w[1].start_ms);
        }
        assert!(c.iter().all(|x| x.end_ms - x.start_ms >= 700));
        // sehr kurzes Fenster: Mindestdauer je Einheit hat Vorrang
        let tight = cues_between(text.trim(), 0, 500);
        assert!(tight.last().unwrap().end_ms >= 700 * tight.len() as i64);
        assert!(cues_between("   ", 0, 1000).is_empty());
    }

    #[test]
    fn tidy_removes_overlaps_and_keeps_order() {
        let mut v = vec![
            Cue { start_ms: 3_000, end_ms: 5_000, text: "B".into() },
            Cue { start_ms: 0, end_ms: 4_000, text: "A".into() },
            Cue { start_ms: 4_100, end_ms: 4_300, text: "C".into() },
        ];
        tidy(&mut v);
        assert_eq!(v.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["A", "B", "C"]);
        for w in v.windows(2) {
            assert!(w[0].end_ms <= w[1].start_ms, "{w:?}");
            assert!(w[0].end_ms > w[0].start_ms);
        }
        assert_eq!(v[0].end_ms, 3_000, "A endet, wo B beginnt");
    }

    #[test]
    fn srt_file_numbers_from_one() {
        let s = srt_file(&[Cue { start_ms: 0, end_ms: 1500, text: "Eins".into() }, Cue { start_ms: 2000, end_ms: 3000, text: "Zwei".into() }]);
        assert_eq!(s, "1\n00:00:00,000 --> 00:00:01,500\nEins\n\n2\n00:00:02,000 --> 00:00:03,000\nZwei\n\n");
    }

    #[test]
    fn srt_block_is_relative_to_track_start() {
        let c = Cue { start_ms: 4_000_500, end_ms: 4_003_000, text: "Hallo".into() };
        assert_eq!(srt_block(3, &c, 4_000_000), "3\n00:00:00,500 --> 00:00:03,000\nHallo\n\n");
    }
}
