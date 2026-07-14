//! `omp-mediaio` — Transport-Abstraktion für Media-Ausgänge/-Eingänge
//! (`ARCHITECTURE.md` §10 Punkt 1, in `UMSETZUNG.md` als "§10.1" referenziert):
//! kein Node spricht eine Transport-API direkt, jeder Node spricht gegen
//! den [`Output`]-Trait. Implementierungen: [`rtp::RtpVideoOutput`]
//! (`UMSETZUNG.md` C3 — pragmatischer Entwicklungs-Codec, feste
//! 640×480, nur Sender, unverändert für den Playout-Node),
//! [`st2110::St2110VideoOutput`]/[`st2110::St2110VideoInput`]
//! (`UMSETZUNG.md` D4 — echtes RFC-4175/ST-2110-20-Payload-Format,
//! konfigurierbare Auflösung/Framerate, Sender **und** Empfänger) und
//! [`mxl::MxlVideoOutput`]/[`mxl::MxlVideoInput`] (`UMSETZUNG.md` C4 —
//! Zero-Copy-Transport, Feature-Flag `mxl`).
//!
//! `Output` selbst kennt nur Aktivierung (`set_active`/`is_active`) —
//! zielspezifische Details wie ein RTP-Host/Port oder eine MXL-`flow-id`
//! sind transportspezifisch und liegen als inhärente Methoden an der
//! jeweiligen Implementierung (`docs/decisions.md`, 2026-07-09: MXL hat
//! keine "Zieladresse" im RTP-Sinn, nur eine feste Flow-ID+Domain).

pub mod rtp;
pub mod st2110;

#[cfg(feature = "mxl")]
pub mod mxl;

#[cfg(feature = "preview")]
pub mod preview;

/// Ein Media-Ausgang, den ein Node über IS-05 (Start/Stop) steuert.
pub trait Output: Send + Sync {
    /// Schaltet den Ausgang scharf (`true`) oder stumm (`false`).
    fn set_active(&self, active: bool);
    /// Ob der Ausgang aktuell aktiv ist.
    fn is_active(&self) -> bool;
}

/// Ob durch diesen Ein-/Ausgang bereits mindestens ein echtes
/// Medien-Sample geflossen ist — Grundlage für das "media-ready"-Signal
/// aus dem Node-Contract (`ARCHITECTURE.md` §5 Punkt 6, `UMSETZUNG.md`
/// D5-prep/D5-prep-2). Getrennt von [`Output::is_active`]: `is_active` ist
/// eine gewollte Schaltung (IS-05), `has_flowed` ist eine Beobachtung
/// ("ist tatsächlich etwas angekommen") — beide können unabhängig
/// auseinanderfallen (aktiv geschaltet, aber noch kein Buffer gesehen).
/// Implementiert von jedem Ausgang/Eingang in diesem Crate, nicht nur
/// von [`Output`]-Implementierungen (auch reine Eingänge wie
/// `MxlVideoInput`/`St2110VideoInput`, die kein `Output` sind).
pub trait MediaFlow: Send + Sync {
    fn has_flowed(&self) -> bool;
}
