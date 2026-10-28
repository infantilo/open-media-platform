//! Kapitel 74: Fremdplaylist-Adapter (`docs/ENTWURF-FREMDPLAYLIST-UND-DURCHLAUF.md`).
//!
//! Zwei Schichten: ein **Adapter** je Fremdformat (dieses Modul definiert die Schnittstelle [`ForeignFormat`]
//! und das neutrale Zwischenmodell [`ForeignList`]) und ein formatunabhängiger **Kern** (Abbildung auf
//! Playlist-Items, Watchfolder, Abgleich — folgende Module). Ein neuer Adapter ist eine Datei plus eine
//! Zeile in [`adapters`]. Das Zwischenmodell ist serialisierbar, damit ein Adapter später auch außerhalb des
//! Prozesses laufen kann.
//!
//! Zeiten sind absolute UTC-Millisekunden; der Adapter rechnet Frames anhand der Bildrate exakt um
//! (ganzzahlig, gerundet) und reicht die Bildrate im Ergebnis weiter.

#![allow(dead_code)] // wird schrittweise angebunden (74.1 Adapter, 74.2+ Kern)

pub mod mpl3;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Bildrate als Bruch (25/1, 30000/1001, …).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fps {
    pub num: u32,
    pub den: u32,
}

impl Fps {
    pub const PAL: Fps = Fps { num: 25, den: 1 };

    /// Frames → Millisekunden, kaufmännisch gerundet (bei 25 fps exakt).
    pub fn frames_to_ms(&self, frames: i64) -> i64 {
        let n = frames as i128 * 1000 * self.den as i128;
        let d = self.num.max(1) as i128;
        ((n + if n >= 0 { d / 2 } else { -(d / 2) }) / d) as i64
    }
}

/// Parameter für [`ForeignFormat::parse`].
#[derive(Debug, Clone)]
pub struct ParseCtx {
    pub fps: Fps,
}

impl Default for ParseCtx {
    fn default() -> Self {
        Self { fps: Fps::PAL }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum Kind {
    /// Datei (Medienkennung, kein Pfad).
    Clip,
    /// Live-Quelle (logischer Name).
    Live,
    BlockStart,
    BlockEnd,
    Comment,
    /// Kind-Event (Logo, Grafik, Audio-Preset, …) mit dem Fremdtyp.
    Child(String),
    Other(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StartMode {
    /// Feste Uhrzeit.
    Fixed,
    /// Direkt nach dem Vorgänger.
    Sequential,
    /// Gleichzeitig mit dem Eltern-Event (Kinder).
    ParentStart,
    /// Relativ zum Ende des Eltern-Events (Kinder).
    ParentEnd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EndMode {
    Duration,
    /// Läuft bis zur manuellen Weiterschaltung.
    Hold,
    ParentEnd,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignEvent {
    pub uid: String,
    /// Schlüssel des Planungssystems (für Abgleich/Rückmeldung).
    pub reconcile_key: Option<String>,
    pub kind: Kind,
    pub enabled: bool,
    pub title: String,
    pub comment: Option<String>,
    /// Medienkennung (Clip/Child), nie ein Pfad.
    pub media_name: Option<String>,
    /// Start-of-Material in ms (Timecode-Anfang der Datei), falls angegeben.
    pub som_ms: Option<i64>,
    /// Logische Live-Quelle und Rückfallquelle.
    pub source: Option<String>,
    pub backup_source: Option<String>,
    pub start_mode: StartMode,
    pub end_mode: EndMode,
    /// Geplanter Start/Ende (UTC ms), soweit das Fremdsystem sie berechnet hat.
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    /// Dauer aus dem Event (nur bei `EndMode::Duration`); bei Kindern Versatz-Ende `-ParentEnd` getrennt in `end_offset_ms`.
    pub duration_ms: Option<i64>,
    pub end_offset_ms: Option<i64>,
    pub transition: Option<String>,
    pub transition_rate: Option<String>,
    /// Fremder Laufzeitzustand (nur lesen, nie übernehmen).
    pub state: String,
    /// Merkmale (Loudness, VPS, Subtitle, AudioShuffle, AFD, …) → Wert.
    pub features: BTreeMap<String, String>,
    /// Klassifikation, Nutzdatenfelder, Grafik-Felder usw.
    pub meta: BTreeMap<String, String>,
    pub children: Vec<ForeignEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignList {
    pub format: String,
    pub channel: String,
    pub fps: Fps,
    /// Zeitpunkt des Schreibens der Liste (Hausuhr, UTC ms).
    pub house_time_ms: Option<i64>,
    /// Ortszeitversatz in ms (nur Anzeige).
    pub local_offset_ms: i64,
    pub list_state: String,
    pub focus_index: Option<usize>,
    pub events: Vec<ForeignEvent>,
    /// Hinweise des Adapters (Unbekanntes, Unstimmiges) — nichts verschwindet stillschweigend.
    pub warnings: Vec<String>,
}

impl ForeignList {
    /// Alle Events inklusive Kinder (Tiefensuche).
    pub fn count_all(&self) -> usize {
        fn n(e: &ForeignEvent) -> usize {
            1 + e.children.iter().map(n).sum::<usize>()
        }
        self.events.iter().map(n).sum()
    }
}

/// Ein Fremdformat. Implementierungen sind zustandslos.
pub trait ForeignFormat: Send + Sync {
    /// Kennung (`mpl3`), Teil der Plugin-ID `foreign-<id>`.
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    /// Erkennt das Format am Dateianfang.
    fn sniff(&self, head: &[u8]) -> bool;
    /// Ist die Datei vollständig geschrieben und wohlgeformt? (Watchfolder: nie eine halbe Datei laden.)
    fn is_complete(&self, bytes: &[u8]) -> bool;
    fn parse(&self, bytes: &[u8], ctx: &ParseCtx) -> Result<ForeignList, String>;
}

/// Alle eingebauten Adapter.
pub fn adapters() -> Vec<Box<dyn ForeignFormat>> {
    vec![Box::new(mpl3::Mpl3)]
}

pub fn adapter(id: &str) -> Option<Box<dyn ForeignFormat>> {
    adapters().into_iter().find(|a| a.id() == id)
}
