//! Kandidatensuche über `/sys` und `/proc/asound`. `root` ist im Betrieb `/`.
use std::fs;
use std::path::{Path, PathBuf};

use crate::model::{AudioMode, Device, DeviceKind, Direction, Transport, UsbInfo};

fn read(p: &Path) -> String {
    fs::read_to_string(p).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// Vom Geräteverzeichnis (`…/device`-Link) aufwärts zum USB-Gerät (hat `idVendor`).
fn usb_parent(device_link: &Path, root: &Path) -> Option<PathBuf> {
    let mut dir = fs::canonicalize(device_link).ok()?;
    let root = fs::canonicalize(root).ok()?;
    while dir.starts_with(&root) && dir != root {
        if dir.join("idVendor").is_file() {
            return Some(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn usb_info(dir: &Path) -> UsbInfo {
    UsbInfo {
        vendor_id: read(&dir.join("idVendor")),
        product_id: read(&dir.join("idProduct")),
        serial: read(&dir.join("serial")),
        manufacturer: read(&dir.join("manufacturer")),
        product: read(&dir.join("product")),
        bus_path: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

/// Stabile ID: Seriennummer wenn vorhanden (überlebt Umstecken), sonst Bus-Position.
fn usb_id(u: &UsbInfo) -> String {
    let tail = if u.serial.is_empty() { u.bus_path.as_str() } else { u.serial.as_str() };
    format!("usb-{}:{}-{}", u.vendor_id, u.product_id, tail)
}

fn transport_of(device_link: &Path) -> (Transport, String) {
    let target = fs::canonicalize(device_link).unwrap_or_default();
    let s = target.to_string_lossy().into_owned();
    let base = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if s.contains("/pci") {
        (Transport::Pci, base)
    } else {
        (Transport::Other, base)
    }
}

/// V4L2-Knoten. UVC legt zusätzlich Metadaten-Knoten an — die filtert erst [`crate::caps::enrich`]
/// (sysfs kennt die Capabilities nicht); ohne GStreamer bleiben sie als Kandidaten stehen.
pub fn scan_video(root: &Path) -> Vec<Device> {
    let class = root.join("sys/class/video4linux");
    let Ok(rd) = fs::read_dir(&class) else { return Vec::new() };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let fname = e.file_name().to_string_lossy().into_owned();
        let Some(num) = fname.strip_prefix("video").and_then(|n| n.parse::<u32>().ok()) else { continue };
        let dir = e.path();
        let name = read(&dir.join("name"));
        let index = read(&dir.join("index")).parse().unwrap_or(0);
        let link = dir.join("device");
        let (transport, usb, id) = match usb_parent(&link, root) {
            Some(u) => {
                let info = usb_info(&u);
                let id = format!("{}-v{index}", usb_id(&info));
                (Transport::Usb, Some(info), id)
            }
            None => {
                let (t, base) = transport_of(&link);
                (t, None, format!("{}-{base}-v{index}", if t == Transport::Pci { "pci" } else { "dev" }))
            }
        };
        out.push(Device {
            id,
            kind: DeviceKind::Video,
            direction: Direction::Input,
            name,
            transport,
            usb,
            node: format!("/dev/video{num}"),
            index,
            video_modes: Vec::new(),
            audio_modes: Vec::new(),
            caps_known: false,
        });
    }
    out
}

/// ALSA-Karten mit mindestens einem Capture-PCM (`/dev/snd/pcmC<n>D<m>c`) → Quellen.
pub fn scan_audio(root: &Path) -> Vec<Device> {
    scan_cards(root, Direction::Input)
}

/// ALSA-Karten mit mindestens einem Playback-PCM (`/dev/snd/pcmC<n>D<m>p`) → Senken (Ausgänge).
pub fn scan_playback(root: &Path) -> Vec<Device> {
    scan_cards(root, Direction::Output)
}

fn scan_cards(root: &Path, dir_kind: Direction) -> Vec<Device> {
    let class = root.join("sys/class/sound");
    let Ok(rd) = fs::read_dir(&class) else { return Vec::new() };
    let (suffix, id_tail, header) = match dir_kind {
        Direction::Input => ('c', "a", "Capture:"),
        Direction::Output => ('p', "o", "Playback:"),
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let fname = e.file_name().to_string_lossy().into_owned();
        let Some(num) = fname.strip_prefix("card").and_then(|n| n.parse::<u32>().ok()) else { continue };
        if !has_pcm(root, num, suffix) {
            continue;
        }
        let dir = e.path();
        let link = dir.join("device");
        let card_id = read(&dir.join("id"));
        let name = card_long_name(root, num).unwrap_or_else(|| card_id.clone());
        let (transport, usb, id) = match usb_parent(&link, root) {
            Some(u) => {
                let info = usb_info(&u);
                let id = format!("{}-{id_tail}", usb_id(&info));
                (Transport::Usb, Some(info), id)
            }
            None => {
                let (t, base) = transport_of(&link);
                (t, None, format!("{}-{base}-{id_tail}", if t == Transport::Pci { "pci" } else { "dev" }))
            }
        };
        let audio_modes = parse_stream(&read_stream(root, num), header);
        out.push(Device {
            id,
            kind: DeviceKind::Audio,
            direction: dir_kind,
            name,
            transport,
            usb,
            node: format!("hw:{num}"),
            index: 0,
            video_modes: Vec::new(),
            audio_modes,
            caps_known: false,
        });
    }
    out
}

fn has_pcm(root: &Path, card: u32, suffix: char) -> bool {
    let prefix = format!("pcmC{card}D");
    fs::read_dir(root.join("dev/snd"))
        .map(|rd| rd.flatten().any(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.starts_with(&prefix) && n.ends_with(suffix)
        }))
        .unwrap_or(false)
}

/// Zweite Zeile der `/proc/asound/cards`-Karte: „Langname at usb-…“; sonst `None`.
fn card_long_name(root: &Path, card: u32) -> Option<String> {
    let text = fs::read_to_string(root.join("proc/asound/cards")).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    let head = format!("{card:>2} [");
    let i = lines.iter().position(|l| l.starts_with(&head))?;
    let first = lines[i].split_once(" - ").map(|(_, n)| n.trim().to_string());
    first.filter(|s| !s.is_empty())
}

fn read_stream(root: &Path, card: u32) -> String {
    // USB-Audio legt je Stream-Gruppe `stream0`, `stream1`, … an.
    let dir = root.join(format!("proc/asound/card{card}"));
    let Ok(rd) = fs::read_dir(&dir) else { return String::new() };
    let mut names: Vec<String> = rd
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("stream"))
        .collect();
    names.sort();
    names.iter().map(|n| read(&dir.join(n))).collect::<Vec<_>>().join("\n")
}

/// Capture-Abschnitte von `/proc/asound/cardN/stream*` (Quellen).
pub fn parse_stream_capture(text: &str) -> Vec<AudioMode> {
    parse_stream(text, "Capture:")
}

/// Liest aus dem Text von `/proc/asound/cardN/stream*` die Abschnitte unter `header` (`Capture:` bzw.
/// `Playback:`): je Alt-Setting (`Format:`, `Channels:`, `Rates:`); gleiche Kanalzahl wird zusammengefasst.
pub fn parse_stream(text: &str, header: &str) -> Vec<AudioMode> {
    let mut modes: Vec<AudioMode> = Vec::new();
    let mut in_capture = false;
    let mut cur = AudioMode { channels: 0, rates: Vec::new(), formats: Vec::new() };
    for line in text.lines() {
        let t = line.trim();
        if t == "Capture:" || t == "Playback:" {
            commit(&mut cur, &mut modes);
            in_capture = t == header;
        } else if in_capture {
            if let Some(v) = t.strip_prefix("Format:") {
                // Ein neues Alt-Setting beginnt mit `Format:` (nach `Channels:`/`Rates:` des vorigen).
                if cur.channels > 0 {
                    commit(&mut cur, &mut modes);
                }
                cur.formats = v.split_whitespace().map(str::to_string).collect();
            } else if let Some(v) = t.strip_prefix("Channels:") {
                cur.channels = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = t.strip_prefix("Rates:") {
                cur.rates = v.split(',').filter_map(|r| r.trim().parse().ok()).collect();
            }
        }
    }
    commit(&mut cur, &mut modes);
    modes.sort_by_key(|m| m.channels);
    for m in &mut modes {
        m.rates.sort_unstable();
    }
    modes
}

fn commit(cur: &mut AudioMode, modes: &mut Vec<AudioMode>) {
    let done = std::mem::replace(cur, AudioMode { channels: 0, rates: Vec::new(), formats: Vec::new() });
    if done.channels == 0 {
        return;
    }
    if let Some(m) = modes.iter_mut().find(|m| m.channels == done.channels) {
        for r in done.rates {
            if !m.rates.contains(&r) {
                m.rates.push(r);
            }
        }
        for f in done.formats {
            if !m.formats.contains(&f) {
                m.formats.push(f);
            }
        }
    } else {
        modes.push(done);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Tree(PathBuf);
    impl Tree {
        fn new(tag: &str) -> Tree {
            let p = std::env::temp_dir().join(format!("omp-dev-hub-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            Tree(p)
        }
        fn w(&self, rel: &str, content: &str) {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, content).unwrap();
        }
        fn link(&self, rel: &str, target_rel_to_link_dir: &str) {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            symlink(target_rel_to_link_dir, p).unwrap();
        }
        /// USB-Gerät `1-2` mit Interface `1-2:1.0` unter einem Root-Hub.
        fn usb(&self, serial: &str) {
            self.w("sys/devices/pci0000:00/0000:00:14.0/usb1/1-2/idVendor", "046d\n");
            self.w("sys/devices/pci0000:00/0000:00:14.0/usb1/1-2/idProduct", "0825\n");
            self.w("sys/devices/pci0000:00/0000:00:14.0/usb1/1-2/manufacturer", "Acme\n");
            self.w("sys/devices/pci0000:00/0000:00:14.0/usb1/1-2/product", "Webcam\n");
            if !serial.is_empty() {
                self.w("sys/devices/pci0000:00/0000:00:14.0/usb1/1-2/serial", serial);
            }
            fs::create_dir_all(self.0.join("sys/devices/pci0000:00/0000:00:14.0/usb1/1-2/1-2:1.0")).unwrap();
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn usb_webcam_id_uses_serial_and_ignores_video_number() {
        let t = Tree::new("cam");
        t.usb("SN123");
        for (n, idx) in [(0, "0"), (1, "1")] {
            t.w(&format!("sys/class/video4linux/video{n}/name"), "Webcam: Webcam\n");
            t.w(&format!("sys/class/video4linux/video{n}/index"), idx);
            t.link(&format!("sys/class/video4linux/video{n}/device"), "../../../devices/pci0000:00/0000:00:14.0/usb1/1-2/1-2:1.0");
        }
        let mut d = scan_video(&t.0);
        d.sort_by(|a, b| a.node.cmp(&b.node));
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].id, "usb-046d:0825-SN123-v0");
        assert_eq!(d[1].id, "usb-046d:0825-SN123-v1");
        assert_eq!(d[0].transport, Transport::Usb);
        assert_eq!(d[0].node, "/dev/video0");
        assert_eq!(d[0].usb.as_ref().unwrap().manufacturer, "Acme");
    }

    #[test]
    fn usb_without_serial_falls_back_to_bus_path() {
        let t = Tree::new("noserial");
        t.usb("");
        t.w("sys/class/video4linux/video4/name", "Cam\n");
        t.w("sys/class/video4linux/video4/index", "0");
        t.link("sys/class/video4linux/video4/device", "../../../devices/pci0000:00/0000:00:14.0/usb1/1-2/1-2:1.0");
        let d = scan_video(&t.0);
        assert_eq!(d[0].id, "usb-046d:0825-1-2-v0");
        assert_eq!(d[0].node, "/dev/video4");
    }

    #[test]
    fn non_usb_audio_card_and_playback_only_skipped() {
        let t = Tree::new("snd");
        fs::create_dir_all(t.0.join("sys/devices/pci0000:00/0000:00:0a.0/sound/card0")).unwrap();
        t.w("sys/class/sound/card0/id", "SoundCard\n");
        t.link("sys/class/sound/card0/device", "../../../devices/pci0000:00/0000:00:0a.0");
        t.w("dev/snd/pcmC0D0c", "");
        t.w("dev/snd/pcmC0D0p", "");
        // card1: nur Wiedergabe
        t.w("sys/class/sound/card1/id", "Out\n");
        t.w("dev/snd/pcmC1D0p", "");
        t.w("proc/asound/cards", " 0 [SoundCard      ]: virtio-snd - VirtIO SoundCard\n                      VirtIO SoundCard at pci/0000:00:0a.0\n");
        let d = scan_audio(&t.0);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].id, "pci-0000:00:0a.0-a");
        assert_eq!(d[0].name, "VirtIO SoundCard");
        assert_eq!(d[0].node, "hw:0");
        assert_eq!(d[0].transport, Transport::Pci);
    }

    #[test]
    fn usb_audio_stream_text_capture_only() {
        let text = "Acme USB Headset at usb-0000:00:14.0-2, full speed : USB Audio\n\nPlayback:\n  Status: Stop\n  Interface 1\n    Altset 1\n    Format: S16_LE\n    Channels: 2\n    Endpoint: 0x01 (1 OUT) (ADAPTIVE)\n    Rates: 44100, 48000\n\nCapture:\n  Status: Stop\n  Interface 2\n    Altset 1\n    Format: S16_LE\n    Channels: 1\n    Endpoint: 0x82 (2 IN) (ASYNC)\n    Rates: 16000, 48000\n  Interface 2\n    Altset 2\n    Format: S24_3LE\n    Channels: 2\n    Rates: 48000, 96000\n  Interface 3\n    Altset 1\n    Format: S16_LE\n    Channels: 1\n    Rates: 44100\n";
        let m = parse_stream_capture(text);
        assert_eq!(m.len(), 2);
        assert_eq!((m[0].channels, m[0].rates.clone(), m[0].formats.clone()), (1, vec![16000, 44100, 48000], vec!["S16_LE".to_string()]));
        assert_eq!((m[1].channels, m[1].rates.clone(), m[1].formats.clone()), (2, vec![48000, 96000], vec!["S24_3LE".to_string()]));
    }

    #[test]
    fn playback_cards_are_outputs_with_own_id_and_playback_modes() {
        let t = Tree::new("play");
        t.usb("SN9");
        // USB-Headset: Capture UND Playback → je ein Eintrag (Quelle -a, Senke -o).
        t.w("sys/class/sound/card2/id", "Headset\n");
        t.link("sys/class/sound/card2/device", "../../../devices/pci0000:00/0000:00:14.0/usb1/1-2/1-2:1.0");
        t.w("dev/snd/pcmC2D0c", "");
        t.w("dev/snd/pcmC2D0p", "");
        t.w("proc/asound/cards", " 2 [Headset         ]: USB-Audio - Acme Headset\n                      Acme Headset at usb-0000:00:14.0-2\n");
        t.w(
            "proc/asound/card2/stream0",
            "Acme Headset\n\nPlayback:\n  Interface 1\n    Altset 1\n    Format: S16_LE\n    Channels: 2\n    Rates: 44100, 48000\n\nCapture:\n  Interface 2\n    Altset 1\n    Format: S16_LE\n    Channels: 1\n    Rates: 16000\n",
        );
        // card3: nur Capture
        t.w("sys/class/sound/card3/id", "Mic\n");
        t.w("dev/snd/pcmC3D0c", "");
        let out = scan_playback(&t.0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "usb-046d:0825-SN9-o");
        assert_eq!(out[0].direction, Direction::Output);
        assert_eq!((out[0].audio_modes[0].channels, out[0].audio_modes[0].rates.clone()), (2, vec![44100, 48000]));
        let inp = scan_audio(&t.0);
        let ids: Vec<&str> = inp.iter().map(|d| d.id.as_str()).collect();
        assert!(ids.contains(&"usb-046d:0825-SN9-a"), "{ids:?}");
        let head = inp.iter().find(|d| d.id.ends_with("SN9-a")).unwrap();
        assert_eq!(head.audio_modes[0].channels, 1);
        assert_eq!(head.direction, Direction::Input);
    }
}
