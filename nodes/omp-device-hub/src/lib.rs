//! Geräte-Erkennung für den `omp-device-hub` (Kap. 34.1).
//!
//! - [`sysfs`]: Kandidaten aus `/sys` + `/proc/asound` (stabile ID, USB-Herkunft); die
//!   Wurzel ist injizierbar, damit Tests ohne Hardware laufen.
//! - [`caps`]: Fähigkeiten (Auflösungen/Fps, Kanäle/Raten) über die GStreamer-Geräteanbieter;
//!   filtert außerdem Nicht-Capture-Knoten (z. B. UVC-Metadaten) heraus.
pub mod caps;
pub mod model;
pub mod offer;
pub mod state;
pub mod sysfs;

pub use model::{AudioMode, Device, DeviceKind, Transport, UsbInfo, VideoMode};

/// Erkennt alle lokalen Capture-Geräte unter `root` (`/` im Normalbetrieb) und reichert sie
/// mit GStreamer-Fähigkeiten an. Ist GStreamer nicht initialisierbar, bleiben die
/// sysfs-Angaben ohne Fähigkeiten stehen (`caps_known = false`).
/// Nur die billige sysfs-Sicht (ohne GStreamer) — zum schnellen Erkennen von Änderungen.
pub fn scan_candidates(root: &std::path::Path) -> Vec<Device> {
    let mut devices = sysfs::scan_video(root);
    devices.extend(sysfs::scan_audio(root));
    devices.sort_by(|a, b| a.id.cmp(&b.id));
    devices
}

pub fn scan(root: &std::path::Path) -> Vec<Device> {
    let mut devices = sysfs::scan_video(root);
    devices.extend(sysfs::scan_audio(root));
    caps::enrich(&mut devices);
    devices.sort_by(|a, b| a.id.cmp(&b.id));
    devices
}
