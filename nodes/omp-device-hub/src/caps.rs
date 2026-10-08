//! Fähigkeiten und Capture-Filter über die GStreamer-Geräteanbieter (`v4l2deviceprovider`,
//! `alsadeviceprovider`). Die Anbieter listen nur echte Capture-Quellen — UVC-Metadaten-
//! Knoten und reine Wiedergabekarten fallen dadurch heraus.
use gstreamer as gst;
use gst::prelude::*;

use crate::model::{AudioMode, Device, DeviceKind, Direction, VideoMode};

/// Ergänzt `devices` um Fähigkeiten. Video-Kandidaten, die der Anbieter nicht als
/// Capture-Quelle kennt, werden entfernt (sofern der Anbieter überhaupt antwortet).
pub fn enrich(devices: &mut Vec<Device>) {
    if gst::init().is_err() {
        return;
    }
    let video = monitor("Video/Source", "video/x-raw");
    if let Some(found) = video {
        devices.retain(|d| d.kind != DeviceKind::Video || found.iter().any(|f| f.path == d.node));
        for d in devices.iter_mut().filter(|d| d.kind == DeviceKind::Video) {
            if let Some(f) = found.iter().find(|f| f.path == d.node) {
                d.video_modes = video_modes(&f.caps);
                d.caps_known = true;
            }
        }
    }
    // Audio: Kanäle/Raten kommen bei USB schon aus `/proc/asound`; der ALSA-Anbieter bestätigt/ergänzt.
    // Quellen (Capture) und Senken (Playback) haben getrennte Geräteklassen.
    for (class, dir) in [("Audio/Source", Direction::Input), ("Audio/Sink", Direction::Output)] {
        let Some(found) = monitor(class, "audio/x-raw") else { continue };
        for d in devices.iter_mut().filter(|d| d.kind == DeviceKind::Audio && d.direction == dir) {
            let Some(card) = d.node.strip_prefix("hw:") else { continue };
            if let Some(f) = found.iter().find(|f| f.alsa_card.as_deref() == Some(card)) {
                // Die Caps der Anbieter sind meist weit offen (1–32 Kanäle); nur der angegebene
                // Standardmodus des Geräts ist eine belastbare Angabe.
                if let (true, Some((ch, rate))) = (d.audio_modes.is_empty(), f.default_mode) {
                    d.audio_modes = vec![AudioMode { channels: ch, rates: vec![rate], formats: Vec::new() }];
                }
                d.caps_known = true;
            }
        }
    }
}

struct Found {
    path: String,
    alsa_card: Option<String>,
    default_mode: Option<(u32, u32)>,
    caps: gst::Caps,
}

fn monitor(class: &str, media: &str) -> Option<Vec<Found>> {
    let mon = gst::DeviceMonitor::new();
    mon.add_filter(Some(class), Some(&gst::Caps::new_empty_simple(media)));
    mon.start().ok()?;
    let list = mon.devices();
    mon.stop();
    Some(
        list.iter()
            .filter_map(|d| {
                let props = d.properties()?;
                let text = |k: &str| props.get::<String>(k).ok();
                // Monitor-Knoten (Mithören einer Senke) sind keine Aufnahmegeräte.
                if text("device.class").as_deref() == Some("monitor") {
                    return None;
                }
                let alsa_card = props
                    .get::<i32>("alsa.card")
                    .ok()
                    .map(|c| c.to_string())
                    .or_else(|| text("alsa.card"))
                    .or_else(|| text("api.alsa.path").as_deref().and_then(card_of_hw_path));
                let default_mode = match (
                    text("audio.channels").and_then(|c| c.parse().ok()),
                    text("audio.rate").and_then(|r| r.parse().ok()),
                ) {
                    (Some(c), Some(r)) => Some((c, r)),
                    _ => None,
                };
                Some(Found {
                    path: text("device.path").or_else(|| text("api.v4l2.path")).unwrap_or_default(),
                    alsa_card,
                    default_mode,
                    caps: d.caps().unwrap_or_else(gst::Caps::new_empty),
                })
            })
            .collect(),
    )
}

/// `hw:1` / `hw:1,0` / `plughw:CARD=x` → Kartennummer (nur die numerische Form).
fn card_of_hw_path(p: &str) -> Option<String> {
    let rest = p.strip_prefix("hw:").or_else(|| p.strip_prefix("plughw:"))?;
    let n = rest.split(',').next()?;
    n.parse::<u32>().ok().map(|n| n.to_string())
}

/// Zerlegt Caps in Modi (Format × Größe, höchste Bildrate).
pub fn video_modes(caps: &gst::CapsRef) -> Vec<VideoMode> {
    let mut out: Vec<VideoMode> = Vec::new();
    for s in caps.iter() {
        let (Some(w), Some(h)) = (max_int(s, "width"), max_int(s, "height")) else { continue };
        let format = s.get::<String>("format").unwrap_or_else(|_| s.name().to_string());
        let fps = max_fraction(s, "framerate");
        let m = VideoMode { format, width: w as u32, height: h as u32, max_fps: fps };
        if !out.contains(&m) {
            out.push(m);
        }
    }
    out.sort_by(|a, b| (b.width, b.height).cmp(&(a.width, a.height)).then(a.format.cmp(&b.format)));
    out
}

pub fn audio_modes(caps: &gst::CapsRef) -> Vec<AudioMode> {
    let mut out: Vec<AudioMode> = Vec::new();
    for s in caps.iter() {
        let Some(ch) = max_int(s, "channels") else { continue };
        let rate = max_int(s, "rate").map(|r| r as u32);
        let m = AudioMode { channels: ch as u32, rates: rate.into_iter().collect(), formats: Vec::new() };
        if !out.contains(&m) {
            out.push(m);
        }
    }
    out
}

fn max_int(s: &gst::StructureRef, field: &str) -> Option<i32> {
    let v = s.value(field).ok()?;
    if let Ok(i) = v.get::<i32>() {
        return Some(i);
    }
    if let Ok(r) = v.get::<gst::IntRange<i32>>() {
        return Some(r.max());
    }
    if let Ok(l) = v.get::<gst::List>() {
        return l.iter().filter_map(|x| x.get::<i32>().ok()).max();
    }
    None
}

fn max_fraction(s: &gst::StructureRef, field: &str) -> f64 {
    let Ok(v) = s.value(field) else { return 0.0 };
    let f = |fr: gst::Fraction| if fr.denom() == 0 { 0.0 } else { fr.numer() as f64 / fr.denom() as f64 };
    if let Ok(fr) = v.get::<gst::Fraction>() {
        return f(fr);
    }
    if let Ok(r) = v.get::<gst::FractionRange>() {
        return f(r.max());
    }
    if let Ok(l) = v.get::<gst::List>() {
        return l.iter().filter_map(|x| x.get::<gst::Fraction>().ok()).map(f).fold(0.0, f64::max);
    }
    0.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn video_modes_from_uvc_like_caps() {
        gst::init().unwrap();
        let caps = gst::Caps::from_str(
            "video/x-raw, format=YUY2, width=1920, height=1080, framerate={ 5/1, 30/1 }; \
             video/x-raw, format=YUY2, width=[ 160, 640 ], height=[ 120, 480 ], framerate=[ 1/1, 60/1 ]",
        )
        .unwrap();
        let m = video_modes(&caps);
        assert_eq!(m.len(), 2);
        assert_eq!((m[0].width, m[0].height, m[0].max_fps), (1920, 1080, 30.0));
        assert_eq!((m[1].width, m[1].height, m[1].max_fps), (640, 480, 60.0));
        assert_eq!(m[0].format, "YUY2");
    }

    #[test]
    fn card_number_from_hw_paths() {
        assert_eq!(card_of_hw_path("hw:0").as_deref(), Some("0"));
        assert_eq!(card_of_hw_path("hw:2,1").as_deref(), Some("2"));
        assert_eq!(card_of_hw_path("hw:CARD=Foo"), None);
    }

    #[test]
    fn audio_modes_from_alsa_caps() {
        gst::init().unwrap();
        let caps = gst::Caps::from_str("audio/x-raw, format=S16LE, rate=[ 8000, 48000 ], channels=[ 1, 2 ]").unwrap();
        let m = audio_modes(&caps);
        assert_eq!(m, vec![AudioMode { channels: 2, rates: vec![48000], formats: Vec::new() }]);
    }
}
