//! `omp-tams-writer`: MXL-Quelle → Segmente → TAMS-Speicher (Kapitel 105.3).
//!
//! * [`spool`]     — Warteschlange auf der Platte (zugleich Puffer bei Speicherausfall).
//! * [`uploader`]  — Hochladen und Registrieren (eigener Thread, Rückstau, Bestätigung unklarer Ausgänge).
//! * [`runtime`]   — Lebenszyklus der Aufnahme (Start/Stopp, MXL-Eingänge, Pipeline).
//! * [`segmenter`] — GStreamer: Encoder → GOP-genaue MPEG-TS-Segmente, Zeitbereich aus dem MXL-Ursprungs-Index.

pub mod runtime;
pub mod segmenter;
pub mod spool;
pub mod uploader;
