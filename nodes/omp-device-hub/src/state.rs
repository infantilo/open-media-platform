//! Persistenter Anbieten-Zustand je Geräte-ID (Kap. 34.2) und die Sicht auf die Geräteliste.
//! Reine Logik ohne GStreamer/Netz — Datei-I/O nur über `load`/`save`.
use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::model::{Device, DeviceKind, Transport};

/// Was von einem eingeschalteten Gerät gemerkt wird, damit es auch in der Liste steht,
/// solange es nicht angesteckt ist (und beim Wiederanstecken sofort wieder angeboten wird).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Remembered {
    pub name: String,
    pub kind: DeviceKind,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offered {
    #[serde(default)]
    pub offered: BTreeMap<String, Remembered>,
}

impl Offered {
    pub fn load(path: &Path) -> Offered {
        std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// Schreibt atomar (Temp-Datei + Umbenennen), damit ein Absturz keine halbe Datei hinterlässt.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).expect("serialize"))?;
        std::fs::rename(tmp, path)
    }

    pub fn is_offered(&self, id: &str) -> bool {
        self.offered.contains_key(id)
    }

    /// Schaltet ein/aus. Einschalten braucht Name/Art (aus der aktuellen Geräteliste);
    /// `false`, wenn das Gerät dafür unbekannt ist. Ausschalten ist immer erlaubt.
    pub fn set(&mut self, id: &str, on: bool, devices: &[Device]) -> bool {
        if !on {
            self.offered.remove(id);
            return true;
        }
        match devices.iter().find(|d| d.id == id) {
            Some(d) => {
                self.offered.insert(id.to_string(), Remembered { name: d.name.clone(), kind: d.kind });
                true
            }
            None => self.offered.contains_key(id),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeviceView {
    #[serde(flatten)]
    pub device: Device,
    pub offered: bool,
    /// `false`: eingeschaltet, aber gerade nicht angesteckt.
    pub present: bool,
    /// `off` | `starting` | `flowing` | `absent` | `error: <Meldung>` (vom Anbieter-Abgleich).
    pub status: String,
}

/// Geräteliste für das Panel: erkannte Geräte plus eingeschaltete, aber fehlende.
pub fn view(devices: &[Device], state: &Offered, status: &std::collections::HashMap<String, String>) -> Vec<DeviceView> {
    let st = |id: &str, offered: bool, present: bool| {
        status.get(id).cloned().unwrap_or_else(|| match (offered, present) {
            (false, _) => "off".to_string(),
            (true, false) => "absent".to_string(),
            (true, true) => "starting".to_string(),
        })
    };
    let mut out: Vec<DeviceView> = devices
        .iter()
        .map(|d| {
            let offered = state.is_offered(&d.id);
            DeviceView { device: d.clone(), offered, present: true, status: st(&d.id, offered, true) }
        })
        .collect();
    for (id, r) in &state.offered {
        if !devices.iter().any(|d| &d.id == id) {
            out.push(DeviceView {
                device: Device {
                    id: id.clone(),
                    kind: r.kind,
                    name: r.name.clone(),
                    transport: if id.starts_with("usb-") { Transport::Usb } else { Transport::Other },
                    usb: None,
                    node: String::new(),
                    index: 0,
                    video_modes: Vec::new(),
                    audio_modes: Vec::new(),
                    caps_known: false,
                },
                offered: true,
                present: false,
                status: st(id, true, false),
            });
        }
    }
    out.sort_by(|a, b| a.device.id.cmp(&b.device.id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(id: &str, kind: DeviceKind) -> Device {
        Device {
            id: id.into(),
            kind,
            name: format!("Name {id}"),
            transport: Transport::Usb,
            usb: None,
            node: "/dev/video0".into(),
            index: 0,
            video_modes: Vec::new(),
            audio_modes: Vec::new(),
            caps_known: true,
        }
    }

    #[test]
    fn default_is_all_off_and_toggle_works() {
        let devs = vec![dev("usb-a-v0", DeviceKind::Video)];
        let mut st = Offered::default();
        assert!(!view(&devs, &st, &Default::default())[0].offered);
        assert!(st.set("usb-a-v0", true, &devs));
        assert!(view(&devs, &st, &Default::default())[0].offered);
        assert!(st.set("usb-a-v0", false, &devs));
        assert!(!view(&devs, &st, &Default::default())[0].offered);
    }

    #[test]
    fn unknown_device_cannot_be_switched_on() {
        let mut st = Offered::default();
        assert!(!st.set("usb-x-a", true, &[]));
        assert!(st.offered.is_empty());
    }

    #[test]
    fn offered_but_unplugged_stays_listed_as_absent() {
        let devs = vec![dev("usb-a-v0", DeviceKind::Video)];
        let mut st = Offered::default();
        st.set("usb-a-v0", true, &devs);
        let v = view(&[], &st, &Default::default());
        assert_eq!(v.len(), 1);
        assert!(v[0].offered && !v[0].present);
        assert_eq!(v[0].status, "absent");
        assert_eq!(v[0].device.name, "Name usb-a-v0");
        // Wiederanstecken: wieder present und weiterhin angeboten.
        let v = view(&devs, &st, &Default::default());
        assert!(v[0].offered && v[0].present);
    }

    #[test]
    fn state_survives_save_and_load() {
        let devs = vec![dev("usb-a-a", DeviceKind::Audio)];
        let mut st = Offered::default();
        st.set("usb-a-a", true, &devs);
        let p = std::env::temp_dir().join(format!("omp-hub-state-{}/s.json", std::process::id()));
        st.save(&p).unwrap();
        assert_eq!(Offered::load(&p), st);
        let _ = std::fs::remove_dir_all(p.parent().unwrap());
        assert_eq!(Offered::load(&p), Offered::default()); // fehlende Datei → alles aus
    }
}
