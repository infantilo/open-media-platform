//! Dynamische Audio-Zuordnung und Regel-Engine (docs/ENTWURF-AUDIO-REGELN.md).
//!
//! Ein Event beschreibt, welche Quellspuren in welche Zielgruppe gehen
//! ([`Mapping`]); fehlt etwas, greifen die [`Rule`]s (Ersatzspur, Up-/Downmix,
//! Verarbeitung, Stille). Ergebnis ist ein [`AudioPlan`] mit Matrizen je Gruppe.

pub mod defaults;
pub mod model;
pub mod processors;
pub mod resolve;
pub mod tagexpr;

pub use model::*;
pub use resolve::{resolve, select_schema, validate};
