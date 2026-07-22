//! Zeitplan-Berechnung für die Hauptplaylist (`ARCHITECTURE.md` §24.5,
//! `UMSETZUNG.md` C20) — reine Logik wie `playlist.rs`, kennt weder HTTP
//! noch `ItemMeta`/`AutomationState` (nimmt Item-Dauern als `&[u64]`
//! entgegen), damit sie isoliert testbar bleibt.
//!
//! **Antipattern aus PIPELINE CONTROLLERs `calcTimeline()` bewusst NICHT
//! mitportiert** (`ARCHITECTURE.md` §24.5): kein Full-Recompute der
//! gesamten Liste bei jeder Anfrage (dort ~25 Call-Sites, jede ein
//! kompletter Durchlauf — der vom Nutzer erinnerte "rendert zu weit in
//! die Zukunft und wird langsam"-Bug). Stattdessen zwei Bausteine:
//!
//! 1. **Cache kumulierter Item-Startzeiten**, der bei einer strukturellen
//!    Änderung (Entfernen, kompletter Ersatz) nur AB dem betroffenen
//!    Index invalidiert wird ([`TimelineCache::invalidate_from`]), nicht
//!    komplett. Ein reines Anhängen ans Ende braucht gar keine
//!    Invalidierung — der Cache bleibt für alle bestehenden Indizes
//!    gültig.
//! 2. **Jede Anfrage ist gefenstert** ([`TimelineCache::window`]): es
//!    wird höchstens bis zum Ende des angefragten Fensters
//!    nachberechnet, nie die ganze (potenziell stundenlange) Liste.
//!
//! Zusammen bedeutet das: die Kosten nach einer Änderung sind an die
//! Größe des als Nächstes angefragten Fensters gebunden, nicht an die
//! Playlist-Gesamtlänge — solange Anfragen (wie in der UI üblich)
//! selbst gefenstert bleiben (nur der sichtbare Bereich), ist das
//! deutlich sub-linear zur Gesamtlänge. Bewusst **kein**
//! Fenwick-Tree/keine Order-Statistics-Struktur: unsere Playlist ist
//! rein sequenziell (keine Fixtimes/Gaps/Xfades wie im PC-Original, s.
//! `playlist.rs`-Moduldoku zu C14/C15), ein einfacher, ab dem
//! Änderungspunkt neu befüllter Präfixsummen-Cache reicht für die
//! erwartete Playlist-Größenordnung (Rundown-Länge, keine
//! Millionen-Item-Skala) und bleibt deutlich einfacher zu verifizieren.

/// Ein einzelner Zeitplan-Eintrag — `index` bezieht sich auf
/// `Playlist::items()`, die Item-ID selbst hängt der Aufrufer
/// (`main.rs`, kennt `playlist.items()`) nach dem Zusammenbau an, dieses
/// Modul kennt nur Positionen und Dauern.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimelineEntry {
    pub index: usize,
    pub start_ms: u64,
    pub duration_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Default)]
pub struct TimelineCache {
    /// `cum_start_ms[i]` = Startzeitpunkt (ms ab Playlist-Beginn) von
    /// Item `i` — nur die ersten `valid_len` Einträge sind vertrauens-
    /// würdig.
    cum_start_ms: Vec<u64>,
    valid_len: usize,
}

impl TimelineCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Muss nach jeder strukturellen Änderung aufgerufen werden, die
    /// Dauern vor Index `from_index` NICHT betrifft, aber ab dort
    /// (Entfernen, Neuladen mit `from_index = 0`) — ein reines Anhängen
    /// ans Ende braucht **keinen** Aufruf, s. Moduldoku.
    pub fn invalidate_from(&mut self, from_index: usize) {
        self.valid_len = self.valid_len.min(from_index);
    }

    /// Liefert das Zeitfenster `[from_index, from_index + count)` —
    /// berechnet dafür höchstens bis `from_index + count` neu (nicht
    /// `durations_ms.len()`), ausgehend vom letzten gültigen
    /// Cache-Stand. Ein `from_index` jenseits der Liste liefert ein
    /// leeres Ergebnis, kein Fehler (gleiche Nachsicht wie an anderen
    /// Stellen dieses Nodes).
    pub fn window(&mut self, durations_ms: &[u64], from_index: usize, count: usize) -> Vec<TimelineEntry> {
        let end = from_index.saturating_add(count).min(durations_ms.len());
        self.ensure_valid_up_to(end, durations_ms);
        if from_index >= end {
            return Vec::new();
        }
        (from_index..end)
            .map(|i| {
                let start_ms = self.cum_start_ms[i];
                let duration_ms = durations_ms[i];
                TimelineEntry { index: i, start_ms, duration_ms, end_ms: start_ms + duration_ms }
            })
            .collect()
    }

    fn ensure_valid_up_to(&mut self, target_len: usize, durations_ms: &[u64]) {
        let target_len = target_len.min(durations_ms.len());
        if target_len <= self.valid_len {
            return;
        }
        self.cum_start_ms.truncate(self.valid_len);
        let mut running = if self.valid_len == 0 {
            0u64
        } else {
            self.cum_start_ms[self.valid_len - 1] + durations_ms[self.valid_len - 1]
        };
        for &duration in &durations_ms[self.valid_len..target_len] {
            self.cum_start_ms.push(running);
            running += duration;
        }
        self.valid_len = target_len;
    }

    #[cfg(test)]
    fn valid_len(&self) -> usize {
        self.valid_len
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_computes_sequential_start_end_times() {
        let mut tl = TimelineCache::new();
        let durations = [1000u64, 2000, 3000];
        let entries = tl.window(&durations, 0, 3);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0], TimelineEntry { index: 0, start_ms: 0, duration_ms: 1000, end_ms: 1000 });
        assert_eq!(entries[1], TimelineEntry { index: 1, start_ms: 1000, duration_ms: 2000, end_ms: 3000 });
        assert_eq!(entries[2], TimelineEntry { index: 2, start_ms: 3000, duration_ms: 3000, end_ms: 6000 });
    }

    #[test]
    fn window_narrower_than_list_only_computes_up_to_its_end() {
        let mut tl = TimelineCache::new();
        let durations = [1000u64; 10];
        let entries = tl.window(&durations, 1, 1);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].index, 1);
        // Gefenstert: nicht die ganze 10-Item-Liste, nur bis Fensterende
        // (Index 2) berechnet.
        assert_eq!(tl.valid_len(), 2, "window() must not compute beyond its own end");
    }

    #[test]
    fn window_beyond_list_end_returns_empty() {
        let mut tl = TimelineCache::new();
        let durations = [1000u64, 2000];
        assert_eq!(tl.window(&durations, 5, 3), Vec::new());
        assert_eq!(tl.window(&durations, 0, 0), Vec::new());
    }

    #[test]
    fn repeated_identical_window_is_a_cache_hit() {
        let mut tl = TimelineCache::new();
        let durations = [1000u64; 5];
        let first = tl.window(&durations, 0, 5);
        assert_eq!(tl.valid_len(), 5);
        let second = tl.window(&durations, 0, 5);
        assert_eq!(first, second);
        assert_eq!(tl.valid_len(), 5, "second identical query must not need to recompute anything");
    }

    #[test]
    fn append_needs_no_invalidation() {
        let mut tl = TimelineCache::new();
        let mut durations = vec![1000u64, 1000];
        tl.window(&durations, 0, 2); // fully cache the first two
        assert_eq!(tl.valid_len(), 2);

        durations.push(1000); // append at the end, no invalidate_from() call
        let entries = tl.window(&durations, 0, 3);
        assert_eq!(entries[2], TimelineEntry { index: 2, start_ms: 2000, duration_ms: 1000, end_ms: 3000 });
    }

    #[test]
    fn invalidate_from_only_forces_recompute_from_that_point_on() {
        let mut tl = TimelineCache::new();
        let mut durations = vec![1000u64, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000];
        tl.window(&durations, 0, 10); // fully cache all 10
        assert_eq!(tl.valid_len(), 10);

        // Simuliert das Entfernen von Item 2 (durationMs jetzt kürzer ab
        // Index 2) — nur Index 2 an aufwärts ist betroffen.
        durations[2] = 500;
        tl.invalidate_from(2);
        assert_eq!(tl.valid_len(), 2, "invalidate must not touch anything before the edit point");

        // Ein anschließendes kleines Fenster nahe der Änderung
        // rekonstruiert nur bis zum Fensterende, nicht bis Item 10 —
        // die eigentliche "sub-linear zur Gesamtlänge"-Eigenschaft:
        // Kosten sind an die Fenstergröße gebunden, nicht an die
        // Playlist-Länge.
        let window = tl.window(&durations, 2, 3);
        assert_eq!(tl.valid_len(), 5, "recompute must stop at the requested window's end, not run to the list end");
        assert_eq!(window[0], TimelineEntry { index: 2, start_ms: 2000, duration_ms: 500, end_ms: 2500 });
        assert_eq!(window[1], TimelineEntry { index: 3, start_ms: 2500, duration_ms: 1000, end_ms: 3500 });
    }

    /// Direkter Nachweis der `UMSETZUNG.md` C20-Testbarkeitszeile: eine
    /// Änderung an Item 3 in einer 500-Item-Playlist triggert beim
    /// nächsten (gefensterten) Zugriff keinen Full-Scan. `valid_len()`
    /// nach dem Fenster-Aufruf ist ein exakter, deterministischer Beleg
    /// dafür, wie viele Einträge tatsächlich neu berechnet wurden —
    /// robuster als eine Zeitmessung (die auf einer geteilten
    /// Testmaschine schwanken kann).
    #[test]
    fn edit_near_start_of_500_items_does_not_trigger_full_recompute() {
        let mut tl = TimelineCache::new();
        let mut durations = vec![1000u64; 500];
        tl.window(&durations, 0, 500); // einmal komplett füllen
        assert_eq!(tl.valid_len(), 500);

        durations[3] = 250; // "Item 3" bearbeitet
        tl.invalidate_from(3);
        assert_eq!(tl.valid_len(), 3, "invalidation must not itself touch the rest of the list");

        // Die UI fragt danach (wie üblich) nur ein kleines Fenster nahe
        // der Änderung an, nicht die ganze Liste.
        let window = tl.window(&durations, 3, 10);
        assert_eq!(window.len(), 10);
        assert_eq!(window[0].duration_ms, 250);
        assert_eq!(
            tl.valid_len(),
            13,
            "must recompute only up to the requested window's end (13), not all 500 items"
        );
    }

    #[test]
    fn invalidate_from_zero_forces_a_full_recompute_on_next_window() {
        let mut tl = TimelineCache::new();
        let durations = [1000u64, 1000, 1000];
        tl.window(&durations, 0, 3);
        tl.invalidate_from(0);
        assert_eq!(tl.valid_len(), 0);
        let entries = tl.window(&durations, 0, 3);
        assert_eq!(entries[2].start_ms, 2000);
    }
}
