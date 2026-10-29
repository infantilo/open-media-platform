//! Zeitliche Abfolge der Anzeigeeinheiten eines Ausgangs: jede Einheit steht für ihre Lesedauer, die nächste folgt nahtlos,
//! nach der letzten wird gelöscht. Staut sich Text (Erkennung lag zurück), werden die Einheiten auf das Minimum gekürzt,
//! um aufzuholen. Reine Logik mit Zeit als Argument — jeder Ausgang (Live-Grafik, Text-Strom, CEA-608) führt seine eigene.

use std::collections::VecDeque;

use crate::output::Cue;

const MIN_MS: i64 = 1_200;

#[derive(Default)]
pub struct Playout {
    queue: VecDeque<Cue>,
    until_ms: Option<i64>,
}

impl Playout {
    pub fn push(&mut self, cues: Vec<Cue>) {
        self.queue.extend(cues);
    }

    /// Verwirft Wartendes und das Angezeigte (z. B. bei „Liste leeren“); liefert `Some(None)`, wenn etwas zu löschen ist.
    #[allow(dead_code)]
    pub fn reset(&mut self) -> Option<Option<String>> {
        self.queue.clear();
        self.until_ms.take().map(|_| None)
    }

    /// `Some(Some(text))` = neuen Text zeigen, `Some(None)` = Anzeige löschen, `None` = nichts zu tun.
    pub fn tick(&mut self, now_ms: i64) -> Option<Option<String>> {
        if self.until_ms.is_some_and(|t| now_ms < t) {
            return None;
        }
        if let Some(cue) = self.queue.pop_front() {
            let mut dur = (cue.end_ms - cue.start_ms).max(MIN_MS);
            if self.queue.len() >= 2 {
                dur = MIN_MS;
            }
            self.until_ms = Some(now_ms + dur);
            return Some(Some(cue.text));
        }
        self.until_ms.take().map(|_| None)
    }

    /// Zeitpunkt, zu dem der nächste Wechsel fällig ist (für die Wartezeit der Schleife).
    pub fn next_due_ms(&self) -> Option<i64> {
        self.until_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(t: &str, ms: i64) -> Cue {
        Cue { start_ms: 0, end_ms: ms, text: t.to_string() }
    }

    #[test]
    fn units_follow_each_other_and_the_display_is_cleared_after_the_last() {
        let mut p = Playout::default();
        assert_eq!(p.tick(0), None);
        p.push(vec![cue("a", 2000), cue("b", 2000)]);
        assert_eq!(p.tick(100), Some(Some("a".into())));
        assert_eq!(p.tick(2000), None);
        assert_eq!(p.tick(2100), Some(Some("b".into())));
        assert_eq!(p.tick(4000), None);
        assert_eq!(p.tick(4100), Some(None));
        assert_eq!(p.tick(4200), None);
    }

    #[test]
    fn a_backlog_shortens_the_units_to_the_minimum() {
        let mut p = Playout::default();
        p.push(vec![cue("a", 5000), cue("b", 5000), cue("c", 5000)]);
        assert_eq!(p.tick(0), Some(Some("a".into())));
        assert_eq!(p.next_due_ms(), Some(1200));
    }

    #[test]
    fn reset_clears_a_shown_text() {
        let mut p = Playout::default();
        p.push(vec![cue("a", 2000)]);
        p.tick(0);
        assert_eq!(p.reset(), Some(None));
        assert_eq!(p.reset(), None);
    }
}
