//! Herstellererkennung für Capture-Hardware (Kap. 76): Magewell Pro Capture (PCIe, Magewell-
//! Treiber stellt V4L2 + ALSA bereit) und Elgato Cam Link (UVC) laufen ohne eigenen Treiberpfad
//! über den Hub; hier steht nur, was *über* sie bekannt ist — Anzeigename, Familie und die
//! Capture-Karten-Regel „Bildrate kommt vom Eingangssignal, nicht vom Hub".
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    /// Kamera/Webcam o. Ä.: Bildrate frei wählbar (Hub nimmt 25).
    #[default]
    Generic,
    /// Capture-Karte/-Stick: das Eingangssignal bestimmt die Bildrate.
    Capture,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Vendor {
    pub name: &'static str,
    pub family: Family,
}

const MAGEWELL: Vendor = Vendor { name: "Magewell", family: Family::Capture };
const ELGATO: Vendor = Vendor { name: "Elgato", family: Family::Capture };

/// USB-Hersteller-ID (hex, klein, ohne `0x`).
pub fn from_usb(vendor_id: &str) -> Option<Vendor> {
    match vendor_id.trim().trim_start_matches("0x").to_ascii_lowercase().as_str() {
        "2935" => Some(MAGEWELL), // Magewell USB Capture
        "0fd9" => Some(ELGATO),   // Elgato (Cam Link, HD60, Game Capture)
        _ => None,
    }
}

/// PCI-Hersteller-ID (sysfs `vendor`, z. B. `0x1cd7`).
pub fn from_pci(vendor_id: &str) -> Option<Vendor> {
    match vendor_id.trim().trim_start_matches("0x").to_ascii_lowercase().as_str() {
        "1cd7" => Some(MAGEWELL), // Magewell Pro Capture (Nanjing Magewell)
        _ => None,
    }
}

/// Rückfall über den V4L2-Kartennamen, wenn weder USB- noch PCI-ID lesbar waren
/// (z. B. Container ohne sysfs-Geräteverknüpfung).
pub fn from_name(name: &str) -> Option<Vendor> {
    let n = name.to_ascii_lowercase();
    if n.contains("magewell") || n.contains("pro capture") || n.contains("eco capture") || n.contains("usb capture") && n.contains("mw") {
        Some(MAGEWELL)
    } else if n.contains("cam link") || n.contains("elgato") {
        Some(ELGATO)
    } else {
        None
    }
}

/// Bildrate für Capture-Familie: nächste ganze Zahl der höchsten gemeldeten Rate
/// (59,94 → 60). Der Hub wählt keine andere Rate als das Signal liefert.
pub fn capture_fps(max_fps: f64) -> u32 {
    (max_fps.round() as u32).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_names() {
        assert_eq!(from_usb("0FD9").unwrap().name, "Elgato");
        assert_eq!(from_usb("0x2935").unwrap().name, "Magewell");
        assert_eq!(from_pci("0x1cd7\n").unwrap().family, Family::Capture);
        assert!(from_usb("046d").is_none());
        assert_eq!(from_name("Cam Link 4K: Cam Link 4K").unwrap().name, "Elgato");
        assert_eq!(from_name("Pro Capture HDMI 4K+").unwrap().name, "Magewell");
        assert!(from_name("Webcam C920").is_none());
    }

    #[test]
    fn fps_rounds() {
        assert_eq!(capture_fps(59.94), 60);
        assert_eq!(capture_fps(29.97), 30);
        assert_eq!(capture_fps(0.0), 1);
    }
}
