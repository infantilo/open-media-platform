//! Anbieten eines Geräts als MXL-Flow (Kap. 34.3): je eingeschaltetem Gerät eine eigene
//! GStreamer-Pipeline `Quelle → MxlVideoOutput/MxlAudioOutput`. Eigene Pipeline je Gerät,
//! damit ein Fehler oder Abziehen nur dieses Gerät betrifft und Ein-/Ausschalten keine
//! Topologie einer gemeinsamen Pipeline ändert (GStreamer-Race-Erfahrung der Memory).
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext, MxlVideoOutput};

use crate::model::{Device, DeviceKind};

pub const SAMPLE_RATE: u32 = 48_000;
const MAX_CHANNELS: u32 = 8;

/// Was am NMOS-Sender angemeldet wird (aus den erkannten Modi abgeleitet).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Format {
    Video { width: u32, height: u32, fps: u32 },
    Audio { channels: u32 },
}

/// Wählt das Ausgabeformat: Video größte Auflösung bis 1080p (Bildrate ganzzahlig, 25 wenn
/// das Gerät mindestens 25 kann), Audio höchste Kanalzahl bis 8. Ohne bekannte Modi Standard.
pub fn choose_format(d: &Device) -> Format {
    match d.kind {
        DeviceKind::Video => {
            let best = d.video_modes.iter().filter(|m| m.width <= 1920 && m.height <= 1080).max_by_key(|m| (m.width, m.height));
            match best {
                Some(m) => {
                    let fps = if m.max_fps >= 25.0 { 25 } else { (m.max_fps.floor() as u32).max(1) };
                    Format::Video { width: m.width, height: m.height, fps }
                }
                None => Format::Video { width: 1280, height: 720, fps: 25 },
            }
        }
        DeviceKind::Audio => {
            let ch = d.audio_modes.iter().map(|m| m.channels).max().unwrap_or(2).clamp(1, MAX_CHANNELS);
            Format::Audio { channels: ch }
        }
    }
}

/// Stabile Sender-/Flow-IDs je Gerät: nach dem Wiederanstecken derselbe Sender, damit Kreuzschienen-
/// Verbindungen und Rollen nicht ins Leere zeigen.
pub fn sender_id(device_id: &str) -> String {
    omp_node_sdk::idgen::deterministic_v4(&format!("omp-device-hub:sender:{device_id}"))
}
pub fn flow_id(device_id: &str) -> String {
    omp_node_sdk::idgen::deterministic_v4(&format!("omp-device-hub:flow:{device_id}"))
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory).build().map_err(|e| format!("{factory}: {e}"))
}

/// Eine laufende Anbietung. Drop beendet die Pipeline und gibt den MXL-Flow frei.
pub struct Offer {
    pipeline: gst::Pipeline,
    video: Option<MxlVideoOutput>,
    audio: Option<MxlAudioOutput>,
    flowed: Arc<AtomicBool>,
    pub format: Format,
}

impl Offer {
    /// `test_source`: statt echter Hardware `videotestsrc`/`audiotestsrc` (nur für Tests
    /// des MXL-/Sender-Lebenszyklus ohne Gerät, `OMP_DEVICE_HUB_TEST_SRC=1`).
    pub fn start(ctx: Arc<MxlContext>, d: &Device, label: &str, test_source: bool) -> Result<Offer, String> {
        gst::init().map_err(|e| e.to_string())?;
        let format = choose_format(d);
        let pipeline = gst::Pipeline::new();
        let flow = flow_id(&d.id);
        let (video, audio, flowed) = match &format {
            Format::Video { width, height, fps } => {
                let src = if test_source {
                    gst::ElementFactory::make("videotestsrc").property("is-live", true).build().map_err(|e| e.to_string())?
                } else {
                    gst::ElementFactory::make("v4l2src").property("device", d.node.as_str()).build().map_err(|e| format!("v4l2src: {e}"))?
                };
                // Größe vorgeben, Format offen lassen (YUY2 oder MJPEG → decodebin); Bildrate regelt der Ausgang.
                let caps = gst::ElementFactory::make("capsfilter")
                    .property(
                        "caps",
                        gst::Caps::builder_full()
                            .structure(gst::Structure::builder("video/x-raw").field("width", *width as i32).field("height", *height as i32).build())
                            .structure(gst::Structure::builder("image/jpeg").field("width", *width as i32).field("height", *height as i32).build())
                            .build(),
                    )
                    .build()
                    .map_err(|e| e.to_string())?;
                let decode = make("decodebin")?;
                let convert = make("videoconvert")?;
                let queue = make("queue")?;
                pipeline.add_many([&src, &caps, &decode, &convert, &queue]).map_err(|e| e.to_string())?;
                src.link(&caps).map_err(|e| e.to_string())?;
                caps.link(&decode).map_err(|e| e.to_string())?;
                convert.link(&queue).map_err(|e| e.to_string())?;
                let conv = convert.clone();
                decode.connect_pad_added(move |_, pad| {
                    if let Some(sink) = conv.static_pad("sink")
                        && !sink.is_linked()
                    {
                        let _ = pad.link(&sink);
                    }
                });
                let out = MxlVideoOutput::new(&pipeline, &queue, ctx, &flow, label, *width, *height, *fps, 1, Arc::new(AtomicU64::new(0)))?;
                out.set_active(true);
                let f = out.flowed_handle();
                (Some(out), None, f)
            }
            Format::Audio { channels } => {
                let src = if test_source {
                    gst::ElementFactory::make("audiotestsrc").property("is-live", true).property("volume", 0.2f64).build().map_err(|e| e.to_string())?
                } else {
                    gst::ElementFactory::make("alsasrc").property("device", format!("plug{}", d.node)).build().map_err(|e| format!("alsasrc: {e}"))?
                };
                let convert = make("audioconvert")?;
                let resample = make("audioresample")?;
                let caps = gst::ElementFactory::make("capsfilter")
                    .property(
                        "caps",
                        gst::Caps::builder("audio/x-raw").field("rate", SAMPLE_RATE as i32).field("channels", *channels as i32).build(),
                    )
                    .build()
                    .map_err(|e| e.to_string())?;
                pipeline.add_many([&src, &convert, &resample, &caps]).map_err(|e| e.to_string())?;
                gst::Element::link_many([&src, &convert, &resample, &caps]).map_err(|e| e.to_string())?;
                let out = MxlAudioOutput::new(&pipeline, &caps, ctx, &flow, label, SAMPLE_RATE, *channels)?;
                out.set_active(true);
                let f = out.flowed_handle();
                (None, Some(out), f)
            }
        };
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("Pipeline startet nicht: {e}"))?;
        Ok(Offer { pipeline, video, audio, flowed, format })
    }

    /// Fehlermeldung des Busses, falls die Quelle ausgefallen ist (z. B. Gerät abgezogen).
    pub fn poll_error(&self) -> Option<String> {
        let bus = self.pipeline.bus()?;
        let msg = bus.pop_filtered(&[gst::MessageType::Error])?;
        match msg.view() {
            gst::MessageView::Error(e) => Some(e.error().to_string()),
            _ => None,
        }
    }

    pub fn flowing(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

impl Drop for Offer {
    fn drop(&mut self) {
        if let Some(v) = &self.video {
            v.set_active(false);
        }
        if let Some(a) = &self.audio {
            a.set_active(false);
        }
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Wiedergabe eines MXL-Audio-Flows über die Soundkarte (Kap. 34.5): `MxlAudioInput → Wandlung → alsasink`.
/// Entsteht, wenn der Empfänger des Ausgangs per IS-05 verbunden wird; Drop beendet die Pipeline.
pub struct Playback {
    pipeline: gst::Pipeline,
    input: MxlAudioInput,
    pub channels: u32,
}

impl Playback {
    /// `test_sink`: statt der Karte ein `fakesink` (Test des Empfangs-/Verbindungs-Lebenszyklus ohne Gerät,
    /// `OMP_DEVICE_HUB_TEST_SRC=1`).
    pub fn start(ctx: Arc<MxlContext>, d: &Device, flow_id: &str, test_sink: bool) -> Result<Playback, String> {
        gst::init().map_err(|e| e.to_string())?;
        // Kanalzahl der Karte (Stereo, wenn unbekannt); der Wandler mischt den Flow darauf.
        let channels = d.audio_modes.iter().map(|m| m.channels).max().unwrap_or(2).clamp(1, MAX_CHANNELS);
        let pipeline = gst::Pipeline::new();
        let input = MxlAudioInput::new(&pipeline, ctx, flow_id).map_err(|e| format!("MxlAudioInput({flow_id}): {e}"))?;
        let queue = make("queue")?;
        let convert = make("audioconvert")?;
        let resample = make("audioresample")?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", gst::Caps::builder("audio/x-raw").field("channels", channels as i32).build())
            .build()
            .map_err(|e| e.to_string())?;
        let sink = if test_sink {
            gst::ElementFactory::make("fakesink").property("sync", true).build().map_err(|e| e.to_string())?
        } else {
            gst::ElementFactory::make("alsasink")
                .property("device", format!("plug{}", d.node))
                .property("sync", true)
                .build()
                .map_err(|e| format!("alsasink: {e}"))?
        };
        pipeline.add_many([&queue, &convert, &resample, &caps, &sink]).map_err(|e| e.to_string())?;
        gst::Element::link_many([&input.tail, &queue, &convert, &resample, &caps, &sink]).map_err(|e| format!("link: {e}"))?;
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("Wiedergabe startet nicht: {e}"))?;
        Ok(Playback { pipeline, input, channels })
    }

    /// Fehlermeldung des Busses (z. B. Karte belegt oder abgezogen).
    pub fn poll_error(&self) -> Option<String> {
        let bus = self.pipeline.bus()?;
        let msg = bus.pop_filtered(&[gst::MessageType::Error])?;
        match msg.view() {
            gst::MessageView::Error(e) => Some(e.error().to_string()),
            _ => None,
        }
    }

    /// `true`, sobald Samples des Flows gelesen wurden.
    pub fn flowing(&self) -> bool {
        self.input.flowed_handle().load(Ordering::Relaxed)
    }
}

impl Drop for Playback {
    fn drop(&mut self) {
        self.input.stop();
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Stabile Empfänger-ID je Ausgangsgerät (wie bei den Sendern: nach dem Wiederanstecken derselbe Empfänger).
pub fn receiver_id(device_id: &str) -> String {
    omp_node_sdk::idgen::deterministic_v4(&format!("omp-device-hub:receiver:{device_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AudioMode, Direction, Transport, VideoMode};

    fn dev(kind: DeviceKind) -> Device {
        Device {
            id: "usb-a-v0".into(),
            kind,
            direction: Direction::Input,
            name: "x".into(),
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
    fn video_format_prefers_largest_up_to_1080p() {
        let mut d = dev(DeviceKind::Video);
        let m = |w, h, f| VideoMode { format: "YUY2".into(), width: w, height: h, max_fps: f };
        d.video_modes = vec![m(3840, 2160, 30.0), m(1920, 1080, 30.0), m(1280, 720, 60.0)];
        assert_eq!(choose_format(&d), Format::Video { width: 1920, height: 1080, fps: 25 });
        d.video_modes = vec![m(640, 480, 15.0)];
        assert_eq!(choose_format(&d), Format::Video { width: 640, height: 480, fps: 15 });
        d.video_modes.clear();
        assert_eq!(choose_format(&d), Format::Video { width: 1280, height: 720, fps: 25 });
    }

    #[test]
    fn audio_format_takes_max_channels_capped() {
        let mut d = dev(DeviceKind::Audio);
        assert_eq!(choose_format(&d), Format::Audio { channels: 2 });
        d.audio_modes = vec![AudioMode { channels: 1, rates: vec![], formats: vec![] }, AudioMode { channels: 32, rates: vec![], formats: vec![] }];
        assert_eq!(choose_format(&d), Format::Audio { channels: 8 });
    }

    #[test]
    fn receiver_ids_are_stable_and_distinct_from_sender_ids() {
        assert_eq!(receiver_id("usb-a-o"), receiver_id("usb-a-o"));
        assert_ne!(receiver_id("usb-a-o"), sender_id("usb-a-o"));
    }

    #[test]
    fn ids_are_stable_and_distinct() {
        assert_eq!(sender_id("usb-a-v0"), sender_id("usb-a-v0"));
        assert_ne!(sender_id("usb-a-v0"), flow_id("usb-a-v0"));
        assert_ne!(sender_id("usb-a-v0"), sender_id("usb-a-a"));
    }
}
