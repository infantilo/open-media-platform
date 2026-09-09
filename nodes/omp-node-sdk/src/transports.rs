//! NMOS-"Transports"-Parameter-Register (AMWA-TV/nmos-parameter-registers,
//! Abschnitt "transports") — seit IS-05 v1.2.0 die kanonische Quelle für
//! Transport-Typ-URNs, statt fest in der Spec definiert (docs/decisions.md
//! Nachtrag 189). Bildet die vier von der Registry aktuell geführten
//! Standard-Einträge ab, plus die projekteigene proprietäre MXL-Erweiterung
//! ([`crate::is04::TRANSPORT_MXL`]) — kein Node dieses Projekts braucht
//! mqtt/websocket/dash aktiv, diese Tabelle ist die eine Stelle, an der ein
//! künftiger echter Bedarf ergänzt würde statt an verstreuten
//! String-Literalen. Go-Pendant: `nodes/mock/internal/connection/
//! transports.go`.

use crate::is04::{TRANSPORT_MXL, TRANSPORT_RTP};

pub struct TransportEntry {
    pub urn: &'static str,
    pub label: &'static str,
    pub deprecated: bool,
}

pub const TRANSPORTS: &[TransportEntry] = &[
    TransportEntry {
        urn: TRANSPORT_RTP,
        label: "RTP",
        deprecated: false,
    },
    TransportEntry {
        urn: "urn:x-nmos:transport:mqtt",
        label: "MQTT",
        deprecated: false,
    },
    TransportEntry {
        urn: "urn:x-nmos:transport:websocket",
        label: "Websocket",
        deprecated: false,
    },
    TransportEntry {
        urn: "urn:x-nmos:transport:dash",
        label: "DASH",
        deprecated: false,
    },
    TransportEntry {
        urn: TRANSPORT_MXL,
        label: "MXL (OMP-proprietär)",
        deprecated: false,
    },
];

/// Prüft, ob `urn` im Register steht — eine Validierungsstelle statt
/// verstreuter String-Vergleiche. Aufgerufen von
/// [`crate::connection::SenderConnection::with_transport`]/
/// [`crate::connection::ReceiverConnection::with_transport`], damit ein
/// Tippfehler in einem Node-`main.rs` beim Start auffällt statt erst beim
/// nächsten AMWA-Testlauf.
pub fn is_known_transport(urn: &str) -> bool {
    TRANSPORTS.iter().any(|t| t.urn == urn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_rtp_and_mxl() {
        assert!(is_known_transport(TRANSPORT_RTP));
        assert!(is_known_transport(TRANSPORT_MXL));
    }

    #[test]
    fn rejects_unknown_urn() {
        assert!(!is_known_transport("urn:x-nmos:transport:bogus"));
    }
}
