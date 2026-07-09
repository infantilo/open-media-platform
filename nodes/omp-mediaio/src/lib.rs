//! `omp-mediaio` — Transport-Abstraktion für Media-Ausgänge
//! (`ARCHITECTURE.md` §10 Punkt 1, in `UMSETZUNG.md` als "§10.1" referenziert):
//! kein Node spricht eine Transport-API direkt, jeder Node spricht gegen
//! den [`Output`]-Trait. Heute nur eine RTP-Dev-Implementierung
//! ([`rtp::RtpVideoOutput`], `UMSETZUNG.md` C3 — pragmatischer
//! Entwicklungs-Codec statt echtem ST 2110); MXL/2110-Implementierungen
//! später als weitere `Output`-Implementierungen, ohne Node-Code zu
//! ändern.

pub mod rtp;

/// Ein Media-Ausgang, den ein Node über IS-05 (Ziel, Start/Stop) steuert.
pub trait Output: Send + Sync {
    /// Schaltet den Ausgang scharf (`true`) oder stumm (`false`).
    fn set_active(&self, active: bool);
    /// Setzt/ändert das Ziel.
    fn set_destination(&self, host: &str, port: u16);
    /// Ob der Ausgang aktuell aktiv ist.
    fn is_active(&self) -> bool;
    /// Aktuelles Ziel (Host, Port).
    fn destination(&self) -> (String, u16);
}
