//! Datenmodell der erkannten Geräte (JSON-Sicht für Node-Parameter `devices`).
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    Video,
    Audio,
}

/// Richtung des Geräts aus Sicht der Plattform: `Input` = Quelle (Aufnahme → MXL), `Output` = Senke
/// (MXL → Wiedergabe, z. B. Kopfhörerausgang einer Soundkarte).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    #[default]
    Input,
    Output,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Usb,
    Pci,
    Other,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsbInfo {
    pub vendor_id: String,
    pub product_id: String,
    pub serial: String,
    pub manufacturer: String,
    pub product: String,
    /// Position am Bus, z. B. `1-2.3` — ändert sich beim Umstecken.
    pub bus_path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VideoMode {
    pub format: String,
    pub width: u32,
    pub height: u32,
    /// Höchste Bildrate in Hz (0 = unbekannt).
    pub max_fps: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioMode {
    pub channels: u32,
    pub rates: Vec<u32>,
    pub formats: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Device {
    /// Stabile ID, überlebt Neustart/Umnummerieren (`usb-<vid>:<pid>-<serial|buspfad>-v0` / `-a`).
    pub id: String,
    pub kind: DeviceKind,
    #[serde(default)]
    pub direction: Direction,
    pub name: String,
    pub transport: Transport,
    pub usb: Option<UsbInfo>,
    /// Zugriffspfad: `/dev/videoN` bzw. `hw:N` (ALSA-Karte).
    pub node: String,
    /// V4L2: Index am selben USB-Gerät (0 = Hauptknoten).
    pub index: u32,
    pub video_modes: Vec<VideoMode>,
    pub audio_modes: Vec<AudioMode>,
    /// `true`, wenn die Fähigkeiten von GStreamer bestätigt wurden.
    pub caps_known: bool,
}
