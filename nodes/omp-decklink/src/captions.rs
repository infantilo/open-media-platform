//! ANC → SDI: Untertitel (CEA-708-CDP, DID 0x61/SDID 0x01) aus einem MXL-Daten-Flow in die Video-Bilder des DeckLink-Ausgangs.
//!
//! `decklinkvideosink` bettet Untertitel ein, wenn der Puffer ein `GstVideoCaptionMeta` trägt (Property `cc-line` = VANC-Zeile).
//! Mehr kann das GStreamer-Element nicht: **andere ANC-Typen (SCTE-104, Zeitcode-Pakete, private Pakete …) lassen sich damit nicht
//! einbetten** — dafür wäre die DeckLink-SDK-Schnittstelle für Ancillary-Pakete nötig. Nicht an echter Hardware geprüft.
//!
//! Ein Grain je Bild; die CDPs laufen durch eine kleine Warteschlange, jedes Video-Bild nimmt das älteste (kein Doppeln, kein
//! Überspringen bei kleinem Takt-Versatz zwischen Daten-Flow und Video).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_video as gst_video;
use omp_mediaio::anc;

/// Höchstens so viele CDPs warten; darüber wird das älteste verworfen (Daten-Flow schneller als Video).
const MAX_QUEUED: usize = 8;
/// VANC-Zeile für Untertitel (CEA-708 üblich Zeile 9 bei 525/625 Zeilen und HD).
pub const DEFAULT_CC_LINE: i32 = 9;

#[derive(Default)]
pub struct CaptionQueue {
    q: Mutex<VecDeque<Vec<u8>>>,
    pub embedded: std::sync::atomic::AtomicU64,
    pub dropped: std::sync::atomic::AtomicU64,
}

impl CaptionQueue {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn push(&self, cdp: Vec<u8>) {
        let mut q = self.q.lock().expect("lock poisoned");
        if q.len() >= MAX_QUEUED {
            q.pop_front();
            self.dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        q.push_back(cdp);
    }

    pub fn pop(&self) -> Option<Vec<u8>> {
        self.q.lock().expect("lock poisoned").pop_front()
    }

    pub fn clear(&self) {
        self.q.lock().expect("lock poisoned").clear();
    }

    /// Ein MXL-Daten-Grain: die CDP-Pakete (DID 0x61/SDID 0x01) in die Warteschlange. Andere Pakete bleiben unberücksichtigt.
    pub fn feed_grain(&self, grain: &[u8]) {
        for p in anc::parse_mxl_grain(grain).unwrap_or_default() {
            if p.did == 0x61 && p.sdid == 0x01 && !p.udw.is_empty() {
                self.push(p.udw);
            }
        }
    }
}

/// Hängt an `pad` (Eingang von `decklinkvideosink`) eine Sonde, die jedem Video-Puffer das nächste CDP als `GstVideoCaptionMeta`
/// mitgibt.
pub fn attach(pad: &gst::Pad, queue: Arc<CaptionQueue>) {
    pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, info| {
        if let Some(gst::PadProbeData::Buffer(buffer)) = &mut info.data
            && let Some(cdp) = queue.pop()
        {
            gst_video::VideoCaptionMeta::add(buffer.make_mut(), gst_video::VideoCaptionType::Cea708Cdp, &cdp);
            queue.embedded.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        gst::PadProbeReturn::Ok
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use omp_mediaio::anc::AncPacket;

    fn cdp_grain(n: u8) -> Vec<u8> {
        anc::mxl_grain(&[AncPacket { c_not_y: false, line: 9, offset: 0, did: 0x61, sdid: 0x01, udw: vec![0x96, 0x69, n, 1, 2, 3] }]).unwrap()
    }

    #[test]
    fn only_cdp_packets_are_queued() {
        let q = CaptionQueue::new();
        q.feed_grain(&cdp_grain(7));
        q.feed_grain(&anc::mxl_grain(&[anc::text_packet("x", 1, 9)]).unwrap()); // privates Text-Paket: nicht einbettbar
        q.feed_grain(&anc::mxl_grain(&[]).unwrap());
        assert_eq!(q.pop().unwrap()[2], 7);
        assert!(q.pop().is_none());
    }

    #[test]
    fn sink_accepts_the_cc_line_property() {
        gst::init().unwrap();
        let Ok(sink) = gst::ElementFactory::make("decklinkvideosink").build() else { return };
        sink.set_property("cc-line", DEFAULT_CC_LINE);
        assert_eq!(sink.property::<i32>("cc-line"), DEFAULT_CC_LINE);
    }

    #[test]
    fn queue_drops_oldest_when_full() {
        let q = CaptionQueue::new();
        for i in 0..12u8 {
            q.feed_grain(&cdp_grain(i));
        }
        assert_eq!(q.pop().unwrap()[2], 4, "älteste vier verworfen");
        assert_eq!(q.dropped.load(std::sync::atomic::Ordering::Relaxed), 4);
    }

    #[test]
    fn probe_attaches_caption_meta_in_order() {
        gst::init().unwrap();
        let q = CaptionQueue::new();
        for i in 0..3u8 {
            q.feed_grain(&cdp_grain(i));
        }
        let pipeline = gst::parse::launch("videotestsrc num-buffers=6 ! video/x-raw,width=64,height=36,framerate=25/1 ! fakesink name=sink sync=false").unwrap();
        let pipeline = pipeline.downcast::<gst::Pipeline>().unwrap();
        let sink = pipeline.by_name("sink").unwrap();
        let pad = sink.static_pad("sink").unwrap();
        attach(&pad, q.clone());
        let seen = Arc::new(Mutex::new(Vec::<Option<u8>>::new()));
        let seen_p = seen.clone();
        pad.add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            if let Some(gst::PadProbeData::Buffer(b)) = &info.data {
                let m = b.meta::<gst_video::VideoCaptionMeta>().map(|m| {
                    assert_eq!(m.caption_type(), gst_video::VideoCaptionType::Cea708Cdp);
                    m.data()[2]
                });
                seen_p.lock().unwrap().push(m);
            }
            gst::PadProbeReturn::Ok
        });
        pipeline.set_state(gst::State::Playing).unwrap();
        let bus = pipeline.bus().unwrap();
        bus.timed_pop_filtered(gst::ClockTime::from_seconds(5), &[gst::MessageType::Eos, gst::MessageType::Error]);
        pipeline.set_state(gst::State::Null).unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![Some(0), Some(1), Some(2), None, None, None]);
        assert_eq!(q.embedded.load(std::sync::atomic::Ordering::Relaxed), 3);
    }
}
