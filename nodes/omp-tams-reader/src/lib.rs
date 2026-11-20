//! omp-tams-reader (Kapitel 105.4): Wiedergabe und Zeitverschiebung aus einem TAMS-Speicher (API 8.2) → MXL.
//!
//! * [`plan`]    — reine Zeitrechnung (Segment → Flow-Zeit → TAI, Lücken, Zeitbereich); ohne GStreamer.
//! * [`export`]  — Clip-Export in eine Datei (ffmpeg, Stream-Copy oder exakt neu kodiert).
//! * [`decode`]  — ein MPEG-TS-Object dekodieren (kleine Pipeline je Segment).
//! * [`lane`]    — je Essenz (Video/Ton): Holen (Vorlauf) und Wiedergeben (Takt, Lückenfüllung).
//! * [`runtime`] — Lebenszyklus: Ausgangs-Pipeline mit MXL-Ausgängen, Befehle `play`/`follow`/`stop`.

pub mod decode;
pub mod export;
pub mod lane;
pub mod plan;
pub mod runtime;
