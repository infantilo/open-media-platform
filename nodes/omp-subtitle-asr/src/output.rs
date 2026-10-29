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
    fn srt_block_is_relative_to_track_start() {
        let c = Cue { start_ms: 4_000_500, end_ms: 4_003_000, text: "Hallo".into() };
        assert_eq!(srt_block(3, &c, 4_000_000), "3\n00:00:00,500 --> 00:00:03,000\nHallo\n\n");
    }
}
