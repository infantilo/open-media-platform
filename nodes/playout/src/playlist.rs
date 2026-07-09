//! Playlist-Logik (`UMSETZUNG.md` C4): Clips laden, cuen, takes — bewusst
//! ohne jedes GStreamer-Wissen, damit die Logik ohne Pipeline testbar ist
//! (siehe C4-Verifikation: "Unit-Tests für die Playlist-Logik, Logik von
//! Pipeline getrennt halten"). Parameter/Methoden-Namen folgen dem
//! `NcBlock "Playout"`-Beispiel aus `ARCHITECTURE.md` §11.1
//! (`PlaylistController`: `items`, `currentIndex`, `playheadPosition`,
//! `mode`; `load`/`append`/`remove`/`cue`/`take`).
//!
//! Begriffe: **cue** wählt nur den Index aus (`currentIndex`), ohne die
//! Wiedergabe zu beeinflussen. **take** schaltet den aktuell gecuten Clip
//! auf Sendung (setzt `on_air`, `playheadPosition` beginnt bei 0). Endet
//! der auf Sendung befindliche Clip (EOS von der Pipeline gemeldet, siehe
//! `pipeline.rs`), entscheidet `mode` über das Verhalten: `Auto` cued und
//! nimmt automatisch den nächsten Clip, `Hold` bleibt auf dem letzten
//! Bild stehen (kein automatischer Übergang).

use serde::{Deserialize, Serialize};

/// Steuert das Verhalten am Ende eines auf Sendung befindlichen Clips.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Automatischer Übergang zum nächsten Clip (Standard).
    #[default]
    Auto,
    /// Bleibt auf dem letzten Bild des Clips stehen, kein automatischer
    /// Übergang — nächster `take()` muss manuell ausgelöst werden.
    Hold,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaylistError {
    IndexOutOfBounds,
    EmptyPlaylist,
}

impl std::fmt::Display for PlaylistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlaylistError::IndexOutOfBounds => write!(f, "playlist: index out of bounds"),
            PlaylistError::EmptyPlaylist => write!(f, "playlist: empty"),
        }
    }
}

/// Ergebnis einer Playlist-Operation, die die Pipeline zum Handeln
/// veranlassen muss (z. B. einen neuen Clip laden). `None`, wenn nichts
/// abzuspielen ist (z. B. `take()` auf eine leere Playlist).
pub type TakeAction = Option<String>;

#[derive(Debug, Default)]
pub struct Playlist {
    items: Vec<String>,
    /// Ausgewählter, aber nicht zwangsläufig auf Sendung befindlicher Index.
    current_index: Option<usize>,
    /// Ob der durch `current_index` referenzierte Clip gerade auf Sendung ist.
    on_air: bool,
    mode: Mode,
}

impl Playlist {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn items(&self) -> &[String] {
        &self.items
    }

    pub fn current_index(&self) -> Option<usize> {
        self.current_index
    }

    pub fn on_air(&self) -> bool {
        self.on_air
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
    }

    /// Ersetzt die komplette Playlist durch einen einzelnen Clip und cued
    /// ihn (Index 0) — beendet laufende Wiedergabe (`on_air = false`, der
    /// Aufrufer muss `take()` separat rufen, um ihn on air zu nehmen).
    pub fn load(&mut self, uri: String) {
        self.items = vec![uri];
        self.current_index = Some(0);
        self.on_air = false;
    }

    /// Hängt einen Clip an. Ist die Playlist leer, wird er zugleich gecued.
    pub fn append(&mut self, uri: String) {
        self.items.push(uri);
        if self.current_index.is_none() {
            self.current_index = Some(0);
        }
    }

    /// Entfernt den Clip an `index`. Zeigte `current_index` auf oder hinter
    /// den entfernten Clip, wird er angepasst (geclampt, `None` wenn leer);
    /// zeigt er auf den gerade auf Sendung befindlichen Clip, endet die
    /// Sendung (`on_air = false`).
    pub fn remove(&mut self, index: usize) -> Result<(), PlaylistError> {
        if index >= self.items.len() {
            return Err(PlaylistError::IndexOutOfBounds);
        }
        self.items.remove(index);

        if let Some(current) = self.current_index {
            if index == current {
                self.on_air = false;
            }
            if self.items.is_empty() {
                self.current_index = None;
                self.on_air = false;
            } else if current >= self.items.len() {
                self.current_index = Some(self.items.len() - 1);
            }
        }
        Ok(())
    }

    /// Wählt `index` aus, ohne die Wiedergabe zu beeinflussen.
    pub fn cue(&mut self, index: usize) -> Result<(), PlaylistError> {
        if index >= self.items.len() {
            return Err(PlaylistError::IndexOutOfBounds);
        }
        self.current_index = Some(index);
        self.on_air = false;
        Ok(())
    }

    /// Nimmt den aktuell gecuten Clip auf Sendung. Liefert dessen URI, damit
    /// der Aufrufer die Pipeline entsprechend umschalten kann.
    pub fn take(&mut self) -> Result<TakeAction, PlaylistError> {
        let index = self.current_index.ok_or(PlaylistError::EmptyPlaylist)?;
        self.on_air = true;
        Ok(self.items.get(index).cloned())
    }

    /// Wird bei EOS des auf Sendung befindlichen Clips aufgerufen. Im
    /// `Auto`-Modus cued und nimmt den nächsten Clip automatisch auf
    /// Sendung (liefert dessen URI); gibt es keinen nächsten Clip oder ist
    /// `mode == Hold`, endet die Sendung ohne automatischen Übergang
    /// (liefert `None`).
    pub fn advance(&mut self) -> TakeAction {
        if self.mode == Mode::Hold {
            self.on_air = false;
            return None;
        }
        let next = self.current_index.map(|i| i + 1).unwrap_or(0);
        if next >= self.items.len() {
            self.on_air = false;
            return None;
        }
        self.current_index = Some(next);
        self.on_air = true;
        self.items.get(next).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_to_empty_playlist_cues_first_item() {
        let mut p = Playlist::new();
        p.append("a.mp4".to_string());
        assert_eq!(p.current_index(), Some(0));
        assert!(!p.on_air());
    }

    #[test]
    fn load_replaces_items_and_cues_without_taking() {
        let mut p = Playlist::new();
        p.append("a.mp4".to_string());
        p.append("b.mp4".to_string());
        p.load("c.mp4".to_string());
        assert_eq!(p.items(), ["c.mp4"]);
        assert_eq!(p.current_index(), Some(0));
        assert!(!p.on_air());
    }

    #[test]
    fn take_returns_current_uri_and_sets_on_air() {
        let mut p = Playlist::new();
        p.append("a.mp4".to_string());
        let uri = p.take().unwrap();
        assert_eq!(uri.as_deref(), Some("a.mp4"));
        assert!(p.on_air());
    }

    #[test]
    fn take_on_empty_playlist_is_an_error() {
        let mut p = Playlist::new();
        assert_eq!(p.take(), Err(PlaylistError::EmptyPlaylist));
    }

    #[test]
    fn cue_selects_without_taking() {
        let mut p = Playlist::new();
        p.append("a.mp4".to_string());
        p.append("b.mp4".to_string());
        p.take().unwrap();
        p.cue(1).unwrap();
        assert_eq!(p.current_index(), Some(1));
        assert!(!p.on_air());
    }

    #[test]
    fn cue_out_of_bounds_is_an_error() {
        let mut p = Playlist::new();
        p.append("a.mp4".to_string());
        assert_eq!(p.cue(5), Err(PlaylistError::IndexOutOfBounds));
    }

    #[test]
    fn advance_in_auto_mode_takes_next_item() {
        let mut p = Playlist::new();
        p.append("a.mp4".to_string());
        p.append("b.mp4".to_string());
        p.take().unwrap();
        let next = p.advance();
        assert_eq!(next.as_deref(), Some("b.mp4"));
        assert_eq!(p.current_index(), Some(1));
        assert!(p.on_air());
    }

    #[test]
    fn advance_past_last_item_ends_on_air_without_looping() {
        let mut p = Playlist::new();
        p.append("a.mp4".to_string());
        p.take().unwrap();
        let next = p.advance();
        assert_eq!(next, None);
        assert!(!p.on_air());
    }

    #[test]
    fn advance_in_hold_mode_never_transitions() {
        let mut p = Playlist::new();
        p.append("a.mp4".to_string());
        p.append("b.mp4".to_string());
        p.set_mode(Mode::Hold);
        p.take().unwrap();
        let next = p.advance();
        assert_eq!(next, None);
        assert!(!p.on_air());
        assert_eq!(p.current_index(), Some(0));
    }

    #[test]
    fn remove_current_item_ends_on_air() {
        let mut p = Playlist::new();
        p.append("a.mp4".to_string());
        p.append("b.mp4".to_string());
        p.take().unwrap();
        p.remove(0).unwrap();
        assert!(!p.on_air());
        assert_eq!(p.items(), ["b.mp4"]);
        assert_eq!(p.current_index(), Some(0));
    }

    #[test]
    fn remove_last_item_clears_current_index() {
        let mut p = Playlist::new();
        p.append("a.mp4".to_string());
        p.remove(0).unwrap();
        assert_eq!(p.current_index(), None);
        assert!(p.items().is_empty());
    }

    #[test]
    fn remove_out_of_bounds_is_an_error() {
        let mut p = Playlist::new();
        assert_eq!(p.remove(0), Err(PlaylistError::IndexOutOfBounds));
    }
}
