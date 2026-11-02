//! Automatisches Raster im Downlink (Kapitel 79, optional: `OMP_SRT_GATEWAY_RASTER=auto`).
//!
//! Das ST-2110-Ausgabeende braucht Breite, Höhe und Rate schon beim Bauen (sie stehen im SDP). Bei komprimiertem
//! Video kennt man sie aber erst, wenn das erste Bild dekodiert ist. Deshalb zwei Pipelines: Pipeline A
//! (`srtsrc → tsdemux → Decoder → appsink`) liefert Rohbilder; beim **ersten** Bild baut diese Brücke Pipeline B
//! (`appsrc → St2110VideoOutput`) mit dem erkannten Raster und schiebt danach jedes Bild hinüber. Ändert der Sender
//! mittendrin Auflösung oder Rate, wird Pipeline B mit dem neuen Raster neu gebaut (der 2110-Strom bekommt dann ein
//! neues SDP — Empfänger müssen das mitmachen).
//!
//! Gilt nur für **Downlink + komprimiert**: beim Uplink und bei Rohvideo kennt der 2110-Empfänger/Depayloader das Raster
//! nicht von selbst (es steht im SDP des Stroms bzw. im RTP-Kopf), dort bleibt die Angabe nötig.

use std::sync::{Arc, Mutex};

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use omp_mediaio::MediaFlow;
use omp_mediaio::Output;
use omp_mediaio::st2110::St2110VideoOutput;

/// (Breite, Höhe, Rate Zähler, Rate Nenner)
pub type RasterKey = (i32, i32, i32, i32);

struct Side {
    pipeline: gst::Pipeline,
    appsrc: gst_app::AppSrc,
    output: St2110VideoOutput,
    key: RasterKey,
}

pub struct AutoBridge {
    host: String,
    port: u16,
    fallback_fps: (i32, i32),
    side: Mutex<Option<Side>>,
}

impl AutoBridge {
    pub fn new(host: &str, port: u16, fallback_fps: (i32, i32)) -> Arc<AutoBridge> {
        Arc::new(AutoBridge { host: host.to_string(), port, fallback_fps, side: Mutex::new(None) })
    }

    /// Hängt den `appsink` hinter `upstream` (rohes Video) in Pipeline A.
    pub fn attach(self: &Arc<Self>, pipeline: &gst::Pipeline, upstream: &gst::Element) -> Result<(), String> {
        let sink = gst_app::AppSink::builder().sync(false).max_buffers(4).drop(true).caps(&gst::Caps::builder("video/x-raw").build()).build();
        pipeline.add(&sink).map_err(|e| format!("add appsink: {e}"))?;
        upstream.link(&sink).map_err(|e| format!("link appsink: {e}"))?;
        let me = self.clone();
        sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |s| {
                    let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    me.push(&sample);
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        Ok(())
    }

    fn key_of(&self, caps: &gst::CapsRef) -> Option<RasterKey> {
        let s = caps.structure(0)?;
        let (w, h) = (s.get::<i32>("width").ok()?, s.get::<i32>("height").ok()?);
        let fr = s.get::<gst::Fraction>("framerate").ok();
        let (n, d) = match fr {
            Some(f) if f.numer() > 0 && f.denom() > 0 => (f.numer(), f.denom()),
            _ => self.fallback_fps, // Strom ohne Bildraten-Angabe
        };
        Some((w, h, n, d))
    }

    fn build_side(&self, caps: &gst::CapsRef, key: RasterKey) -> Result<Side, String> {
        let pipeline = gst::Pipeline::new();
        let appsrc = gst_app::AppSrc::builder()
            .caps(&caps.to_owned())
            .format(gst::Format::Time)
            .is_live(true)
            .do_timestamp(true)
            .build();
        appsrc.set_property("max-buffers", 4u64);
        pipeline.add(&appsrc).map_err(|e| format!("add appsrc: {e}"))?;
        let output = St2110VideoOutput::new(&pipeline, appsrc.upcast_ref(), &self.host, self.port, key.0, key.1, key.2, key.3)?;
        output.set_active(true);
        pipeline.set_state(gst::State::Playing).map_err(|e| format!("pipeline B playing: {e}"))?;
        Ok(Side { pipeline, appsrc, output, key })
    }

    fn push(&self, sample: &gst::Sample) {
        let Some(caps) = sample.caps() else { return };
        let Some(key) = self.key_of(caps) else { return };
        let mut guard = self.side.lock().expect("lock poisoned");
        if guard.as_ref().is_none_or(|s| s.key != key) {
            if let Some(old) = guard.take() {
                let _ = old.pipeline.set_state(gst::State::Null);
            }
            match self.build_side(caps, key) {
                Ok(side) => {
                    eprintln!("omp-srt-gateway: Raster erkannt {}x{}@{}/{} — 2110-Ausgang gebaut", key.0, key.1, key.2, key.3);
                    *guard = Some(side);
                }
                Err(e) => {
                    eprintln!("omp-srt-gateway: 2110-Ausgang konnte nicht gebaut werden: {e}");
                    return;
                }
            }
        }
        if let (Some(side), Some(buf)) = (guard.as_ref(), sample.buffer_owned()) {
            let _ = side.appsrc.push_buffer(buf);
        }
    }

    pub fn has_flowed(&self) -> bool {
        self.side.lock().expect("lock poisoned").as_ref().is_some_and(|s| s.output.has_flowed())
    }

    /// Das zuletzt erkannte Raster.
    pub fn current(&self) -> Option<RasterKey> {
        self.side.lock().expect("lock poisoned").as_ref().map(|s| s.key)
    }

    pub fn shutdown(&self) {
        if let Some(s) = self.side.lock().expect("lock poisoned").take() {
            let _ = s.pipeline.set_state(gst::State::Null);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Testbild 320×180@10 → H.264 → Decoder → AutoBridge → ST-2110-Ausgang (UDP localhost). Ein Empfänger mit den
    /// RTP-Kaps genau dieses Rasters muss Bilder bekommen — das beweist, dass der Ausgang mit dem erkannten Raster
    /// gebaut wurde (konfiguriert ist keins).
    #[test]
    #[ignore = "Netzwerk/CPU: gezielt starten (cargo test -- --ignored auto_raster)"]
    fn auto_raster_detects_and_outputs() {
        gst::init().unwrap();
        let rx = gst::Pipeline::new();
        let udp = gst::ElementFactory::make("udpsrc")
            .property("port", 6417i32)
            .property(
                "caps",
                gst::Caps::builder("application/x-rtp")
                    .field("media", "video")
                    .field("clock-rate", 90000i32)
                    .field("encoding-name", "RAW")
                    .field("sampling", "YCbCr-4:2:2")
                    .field("depth", "8")
                    .field("width", "320")
                    .field("height", "180")
                    .field("colorimetry", "BT709-2")
                    .build(),
            )
            .build()
            .unwrap();
        let jb = gst::ElementFactory::make("rtpjitterbuffer").build().unwrap();
        let depay = gst::ElementFactory::make("rtpvrawdepay").build().unwrap();
        let fake = gst::ElementFactory::make("fakesink").property("signal-handoffs", true).property("sync", false).build().unwrap();
        rx.add_many([&udp, &jb, &depay, &fake]).unwrap();
        gst::Element::link_many([&udp, &jb, &depay, &fake]).unwrap();
        let n = Arc::new(AtomicU64::new(0));
        let n2 = n.clone();
        fake.connect("handoff", false, move |_| {
            n2.fetch_add(1, Ordering::Relaxed);
            None
        });
        rx.set_state(gst::State::Playing).unwrap();

        let a = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).build().unwrap();
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", gst::Caps::builder("video/x-raw").field("width", 320i32).field("height", 180i32).field("framerate", gst::Fraction::new(10, 1)).build())
            .build()
            .unwrap();
        let chain = crate::codec::encode_chain(crate::codec::Codec::H264, crate::codec::EncodeParams { bitrate_kbps: 800, ten_bit: false, fps: 10 }).unwrap();
        // statt MPEG-TS: direkt zum Decoder (die Brücke selbst ist Gegenstand des Tests, nicht der Transport)
        let enc = chain[2].clone();
        let parse = chain[3].clone();
        let dec = gst::ElementFactory::make("avdec_h264").build().unwrap();
        let conv = gst::ElementFactory::make("videoconvert").build().unwrap();
        a.add_many([&src, &caps, &enc, &parse, &dec, &conv]).unwrap();
        let conv0 = chain[0].clone();
        let capsf = chain[1].clone();
        a.add_many([&conv0, &capsf]).unwrap();
        gst::Element::link_many([&src, &caps, &conv0, &capsf, &enc, &parse, &dec, &conv]).unwrap();
        let bridge = AutoBridge::new("127.0.0.1", 6417, (25, 1));
        bridge.attach(&a, &conv).unwrap();
        a.set_state(gst::State::Playing).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(4));
        let got = n.load(Ordering::Relaxed);
        let detected = bridge.current();
        let flowed = bridge.has_flowed();
        let _ = a.set_state(gst::State::Null);
        bridge.shutdown();
        let _ = rx.set_state(gst::State::Null);
        assert_eq!(detected, Some((320, 180, 10, 1)));
        assert!(flowed, "Ausgang hat nichts gesendet");
        assert!(got >= 10, "nur {got} Bilder am 2110-Empfänger");
    }
}
