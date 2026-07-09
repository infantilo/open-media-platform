//! `omp-mediaio` — Transport-Abstraktion für Media-Ausgänge/-Eingänge
//! (`ARCHITECTURE.md` §10 Punkt 1, in `UMSETZUNG.md` als "§10.1" referenziert):
//! kein Node spricht eine Transport-API direkt, jeder Node spricht gegen
//! den [`Output`]-Trait. Zwei Implementierungen: [`rtp::RtpVideoOutput`]
//! (`UMSETZUNG.md` C3 — pragmatischer Entwicklungs-Codec statt echtem
//! ST 2110) und [`mxl::MxlVideoOutput`]/[`mxl::MxlVideoInput`]
//! (`UMSETZUNG.md` C4 — Zero-Copy-Transport, Feature-Flag `mxl`).
//!
//! `Output` selbst kennt nur Aktivierung (`set_active`/`is_active`) —
//! zielspezifische Details wie ein RTP-Host/Port oder eine MXL-`flow-id`
//! sind transportspezifisch und liegen als inhärente Methoden an der
//! jeweiligen Implementierung (`docs/decisions.md`, 2026-07-09: MXL hat
//! keine "Zieladresse" im RTP-Sinn, nur eine feste Flow-ID+Domain).

pub mod rtp;

#[cfg(feature = "mxl")]
pub mod mxl;

/// Ein Media-Ausgang, den ein Node über IS-05 (Start/Stop) steuert.
pub trait Output: Send + Sync {
    /// Schaltet den Ausgang scharf (`true`) oder stumm (`false`).
    fn set_active(&self, active: bool);
    /// Ob der Ausgang aktuell aktiv ist.
    fn is_active(&self) -> bool;
}
