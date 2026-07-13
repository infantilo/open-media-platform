//! Sequenzierungs-Logik (`UMSETZUNG.md` C14/C15), wiederverwendet von
//! `c4-playlist-wip:nodes/playout/src/playlist.rs` (reine Logik, 12 Tests,
//! unverändert brauchbar laut `UMSETZUNG.md` C3) — bewusst **ohne** jedes
//! Wissen über HTTP/IS-04/eine Medienpipeline, damit sie wie beim
//! ursprünglichen Playout-Ansatz isoliert testbar bleibt.
//!
//! Einzige inhaltliche Änderung gegenüber dem Original: items waren dort
//! Clip-**URIs**, die der Node selbst in seine eigene Pipeline lud. Dieser
//! Node hat keine eigene Pipeline (`ARCHITECTURE.md` §13.3-Vorgabe für
//! C14/C15: "ruft dieselben IS-12/14-Methoden von Player/Mixer auf, statt
//! gegen eine eigene Pipeline") — items sind hier stattdessen die
//! Item-**IDs**, die der ferngesteuerte `omp-player` (C12) beim `append`/
//! `load` selbst vergibt (siehe `main.rs`). Die Sequenzierungs-Regeln
//! (cue/take/advance/Mode) bleiben identisch, nur die Bedeutung des
//! opaken `String` ändert sich — deshalb keine Wiederholung der Tests aus
//! dem Original, nur eine neue Methode (`replace_all`, s. u.) plus deren
//! eigene Tests.
//!
//! Begriffe unverändert: **cue** wählt nur den Index aus (`current_index`),
//! ohne on-air zu gehen. **take** schaltet den aktuell gecuten Eintrag auf
//! Sendung. `advance()` wird hier nicht bei einem Pipeline-EOS aufgerufen
//! (das gibt es nicht, `omp-player`s Items laufen bis zum nächsten Cue/Take
//! endlos, `UMSETZUNG.md` C14/C15-Detailplan), sondern von einem
//! Dauer-Timer in `main.rs`, sobald die deklarierte `durationMs` des
//! on-air Items abgelaufen ist.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Auto,
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

/// Ergebnis einer Operation, die den Aufrufer zum Handeln veranlassen muss
/// (z. B. `take()`/`cue()`/`advance()` beim ferngesteuerten Player
/// nachvollziehen). `None`, wenn nichts zu tun ist.
pub type TakeAction = Option<String>;

#[derive(Debug, Default)]
pub struct Playlist {
    items: Vec<String>,
    current_index: Option<usize>,
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

    /// Hängt eine Item-ID an. Ist die Playlist leer, wird sie zugleich
    /// gecued.
    pub fn append(&mut self, id: String) {
        self.items.push(id);
        if self.current_index.is_none() {
            self.current_index = Some(0);
        }
    }

    /// Ersetzt die komplette Playlist (`main.rs`s `load`-Methode, die den
    /// Ziel-Player per Bulk-`load()` neu befüllt und danach dessen
    /// tatsächlich vergebene IDs hier nachträgt — das ursprüngliche
    /// `playlist.rs::load()` kannte nur ein einzelnes Item und passt daher
    /// nicht mehr, s. Moduldoku oben). Cued Index 0, falls nicht leer,
    /// beendet die Sendung (Aufrufer muss `take()` separat rufen).
    pub fn replace_all(&mut self, ids: Vec<String>) {
        self.current_index = if ids.is_empty() { None } else { Some(0) };
        self.items = ids;
        self.on_air = false;
    }

    /// Entfernt die Item-ID an `index`. Zeigte `current_index` auf oder
    /// hinter den entfernten Eintrag, wird er angepasst (geclampt, `None`
    /// wenn leer); zeigt er auf den gerade on-air befindlichen Eintrag,
    /// endet die Sendung (`on_air = false`).
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

    /// Findet den Index einer Item-ID — Hilfsfunktion für `main.rs`s
    /// `cue(itemId)`/`remove(itemId)`-Methoden, die (wie beim ferngesteuerten
    /// Player, §13.3) über die ID adressieren, nicht über den Index.
    pub fn index_of(&self, id: &str) -> Option<usize> {
        self.items.iter().position(|it| it == id)
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

    /// Nimmt den aktuell gecuten Eintrag auf Sendung. Liefert dessen ID,
    /// damit der Aufrufer den Ziel-Player/-Mixer entsprechend umschalten
    /// kann.
    pub fn take(&mut self) -> Result<TakeAction, PlaylistError> {
        let index = self.current_index.ok_or(PlaylistError::EmptyPlaylist)?;
        self.on_air = true;
        Ok(self.items.get(index).cloned())
    }

    /// Wird vom Dauer-Timer in `main.rs` aufgerufen, sobald die
    /// `durationMs` des on-air Items abgelaufen ist. Im `Auto`-Modus cued
    /// und nimmt den nächsten Eintrag automatisch auf Sendung (liefert
    /// dessen ID); gibt es keinen nächsten Eintrag oder ist `mode ==
    /// Hold`, endet die Sendung ohne automatischen Übergang (liefert
    /// `None`).
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
        p.append("item1".to_string());
        assert_eq!(p.current_index(), Some(0));
        assert!(!p.on_air());
    }

    #[test]
    fn take_returns_current_id_and_sets_on_air() {
        let mut p = Playlist::new();
        p.append("item1".to_string());
        let id = p.take().unwrap();
        assert_eq!(id.as_deref(), Some("item1"));
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
        p.append("item1".to_string());
        p.append("item2".to_string());
        p.take().unwrap();
        p.cue(1).unwrap();
        assert_eq!(p.current_index(), Some(1));
        assert!(!p.on_air());
    }

    #[test]
    fn cue_out_of_bounds_is_an_error() {
        let mut p = Playlist::new();
        p.append("item1".to_string());
        assert_eq!(p.cue(5), Err(PlaylistError::IndexOutOfBounds));
    }

    #[test]
    fn advance_in_auto_mode_takes_next_item() {
        let mut p = Playlist::new();
        p.append("item1".to_string());
        p.append("item2".to_string());
        p.take().unwrap();
        let next = p.advance();
        assert_eq!(next.as_deref(), Some("item2"));
        assert_eq!(p.current_index(), Some(1));
        assert!(p.on_air());
    }

    #[test]
    fn advance_past_last_item_ends_on_air_without_looping() {
        let mut p = Playlist::new();
        p.append("item1".to_string());
        p.take().unwrap();
        let next = p.advance();
        assert_eq!(next, None);
        assert!(!p.on_air());
    }

    #[test]
    fn advance_in_hold_mode_never_transitions() {
        let mut p = Playlist::new();
        p.append("item1".to_string());
        p.append("item2".to_string());
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
        p.append("item1".to_string());
        p.append("item2".to_string());
        p.take().unwrap();
        p.remove(0).unwrap();
        assert!(!p.on_air());
        assert_eq!(p.items(), ["item2"]);
        assert_eq!(p.current_index(), Some(0));
    }

    #[test]
    fn remove_last_item_clears_current_index() {
        let mut p = Playlist::new();
        p.append("item1".to_string());
        p.remove(0).unwrap();
        assert_eq!(p.current_index(), None);
        assert!(p.items().is_empty());
    }

    #[test]
    fn remove_out_of_bounds_is_an_error() {
        let mut p = Playlist::new();
        assert_eq!(p.remove(0), Err(PlaylistError::IndexOutOfBounds));
    }

    #[test]
    fn index_of_finds_known_id_and_none_for_unknown() {
        let mut p = Playlist::new();
        p.append("item1".to_string());
        p.append("item2".to_string());
        assert_eq!(p.index_of("item2"), Some(1));
        assert_eq!(p.index_of("nope"), None);
    }

    #[test]
    fn replace_all_sets_items_and_cues_first_without_taking() {
        let mut p = Playlist::new();
        p.append("old".to_string());
        p.take().unwrap();
        p.replace_all(vec!["a".to_string(), "b".to_string()]);
        assert_eq!(p.items(), ["a", "b"]);
        assert_eq!(p.current_index(), Some(0));
        assert!(!p.on_air());
    }

    #[test]
    fn replace_all_with_empty_list_clears_current_index() {
        let mut p = Playlist::new();
        p.append("old".to_string());
        p.replace_all(vec![]);
        assert_eq!(p.current_index(), None);
        assert!(p.items().is_empty());
    }
}
