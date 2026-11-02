//! Transportformat des SRT-Gateways (Kapitel 79).
//!
//! * `raw` — unkomprimiertes Video als RTP (RFC 4175, `rtpvrawpay`) über SRT. Bisheriges Verhalten und
//!   Standard; braucht je nach Auflösung sehr viel Bandbreite (PAL-SD ≈ 150 Mbit/s, HD ≈ 1 Gbit/s).
//! * `h264`, `hevc` — komprimiert, als **MPEG-2-Transportstrom über SRT** (ISO/IEC 13818-1): das übliche
//!   Contribution-Muster mit SRT, von Encodern, Decodern und Servern verstanden. 10 Bit (`bitDepth=10`)
//!   nutzt H.264 High 10 bzw. HEVC Main 10.
//!
//! **Bewusst nicht dabei:** AV1 (auf dieser Installation kein Decoder und `mpegtsmux` ohne AV1-Eingang) und
//! lernbasierte („KI“-)Codecs: für sie gibt es keinen standardisierten, einsetzbaren Strom. Neue Codecs
//! kommen als weitere Variante von [`Codec`] mit Encoder-/Decoder-Kette hinzu, der Rest bleibt unverändert.

use gst::prelude::*;
use gstreamer as gst;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    Raw,
    H264,
    Hevc,
}

impl Codec {
    pub fn parse(s: &str) -> Option<Codec> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "raw" => Some(Codec::Raw),
            "h264" | "avc" => Some(Codec::H264),
            "hevc" | "h265" => Some(Codec::Hevc),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Codec::Raw => "raw",
            Codec::H264 => "h264",
            Codec::Hevc => "hevc",
        }
    }
}

/// Bildraster des Gateways: **beliebige** Breite/Höhe/Rate (je Instanz, weil das ST-2110-SDP sie fest
/// vorgibt). Gebrochene Raten wie 30000/1001 sind ausdrücklich möglich.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Raster {
    pub width: i32,
    pub height: i32,
    pub fps_n: i32,
    pub fps_d: i32,
}

impl Raster {
    /// Breite/Höhe: gerade (4:2:2/4:2:0), 16 … 16384.
    pub fn new(width: i32, height: i32, fps_n: i32, fps_d: i32) -> Result<Raster, String> {
        if !(16..=16384).contains(&width) || !(16..=16384).contains(&height) || width % 2 != 0 || height % 2 != 0 {
            return Err(format!("Auflösung {width}×{height} ungültig (gerade Werte von 16 bis 16384)"));
        }
        if fps_n <= 0 || fps_d <= 0 || (fps_n as f64 / fps_d as f64) > 480.0 {
            return Err(format!("Bildrate {fps_n}/{fps_d} ungültig"));
        }
        Ok(Raster { width, height, fps_n, fps_d })
    }

    pub fn fps(&self) -> f64 {
        self.fps_n as f64 / self.fps_d as f64
    }

    /// Richtwert für die Datenrate komprimierter Ströme (Bit je Pixel: H.264 0,10, HEVC 0,07), mindestens 500 kbit/s.
    pub fn auto_bitrate_kbps(&self, codec: Codec) -> u32 {
        let bpp = if codec == Codec::Hevc { 0.07 } else { 0.10 };
        ((self.width as f64 * self.height as f64 * self.fps() * bpp / 1000.0) as u32).max(500)
    }
}

/// Bildrate aus Text: `25`, `30000/1001`, `29.97`, `59.94` (übliche Dezimalschreibweisen werden auf den exakten
/// Bruch abgebildet), sonst Dezimalzahl mit Nenner 1000.
pub fn parse_rate(s: &str) -> Result<(i32, i32), String> {
    let s = s.trim();
    if let Some((a, b)) = s.split_once('/') {
        let n: i32 = a.trim().parse().map_err(|_| format!("Bildrate „{s}“ nicht lesbar"))?;
        let d: i32 = b.trim().parse().map_err(|_| format!("Bildrate „{s}“ nicht lesbar"))?;
        return Ok((n, d));
    }
    let f: f64 = s.parse().map_err(|_| format!("Bildrate „{s}“ nicht lesbar"))?;
    for (n, d) in [(24000, 1001), (30000, 1001), (60000, 1001), (120000, 1001)] {
        if (f - n as f64 / d as f64).abs() < 0.005 {
            return Ok((n, d));
        }
    }
    if (f - f.round()).abs() < 1e-9 {
        return Ok((f as i32, 1));
    }
    Ok(((f * 1000.0).round() as i32, 1000))
}

#[derive(Debug, Clone, Copy)]
pub struct EncodeParams {
    pub bitrate_kbps: u32,
    pub ten_bit: bool,
    pub fps: i32,
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory).build().map_err(|e| format!("{factory}: {e}"))
}

/// Senderkette ab Rohvideo bis zum Transportstrom: `videoconvert ! capsfilter ! Encoder ! Parser ! mpegtsmux`.
/// Gibt die Elemente in Verbindungsreihenfolge zurück; das letzte liefert den Transportstrom.
pub fn encode_chain(codec: Codec, p: EncodeParams) -> Result<Vec<gst::Element>, String> {
    let format = if p.ten_bit { "I420_10LE" } else { "I420" };
    let convert = make("videoconvert")?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("video/x-raw").field("format", format).build())
        .build()
        .map_err(|e| format!("capsfilter: {e}"))?;
    let keyint = (p.fps.max(1) * 2) as u32; // alle 2 s ein Einstiegspunkt
    let (enc, parse) = match codec {
        Codec::H264 => {
            let e = make("x264enc")?;
            e.set_property("bitrate", p.bitrate_kbps);
            e.set_property("key-int-max", keyint);
            e.set_property("bframes", 0u32);
            e.set_property_from_str("tune", "zerolatency");
            e.set_property_from_str("speed-preset", "ultrafast");
            let pa = make("h264parse")?;
            pa.set_property("config-interval", -1i32);
            (e, pa)
        }
        Codec::Hevc => {
            let e = make("x265enc")?;
            e.set_property("bitrate", p.bitrate_kbps);
            e.set_property("key-int-max", keyint as i32);
            e.set_property_from_str("tune", "zerolatency");
            e.set_property_from_str("speed-preset", "ultrafast");
            let pa = make("h265parse")?;
            pa.set_property("config-interval", -1i32);
            (e, pa)
        }
        Codec::Raw => return Err("raw hat keine Encoder-Kette".to_string()),
    };
    let mux = make("mpegtsmux")?;
    mux.set_property("alignment", 7i32); // 7 TS-Pakete = 1316 Byte, passt in ein SRT-Paket
    Ok(vec![convert, caps, enc, parse, mux])
}

/// Empfängerkette ab Transportstrom: `tsdemux` (dynamische Pads) → Parser → Decoder → `videoconvert`.
/// Gibt `(erstes Element, letztes Element)` zurück; die Teilkette dazwischen verbindet sich beim Auftauchen des
/// Videopads selbst.
pub fn decode_chain(codec: Codec, pipeline: &gst::Pipeline) -> Result<(gst::Element, gst::Element), String> {
    let (parse_name, dec_name) = match codec {
        Codec::H264 => ("h264parse", "avdec_h264"),
        Codec::Hevc => ("h265parse", "avdec_h265"),
        Codec::Raw => return Err("raw hat keine Decoder-Kette".to_string()),
    };
    let demux = make("tsdemux")?;
    let parse = make(parse_name)?;
    let dec = make(dec_name)?;
    let convert = make("videoconvert")?;
    pipeline
        .add_many([&demux, &parse, &dec, &convert])
        .map_err(|e| format!("add decode elements: {e}"))?;
    gst::Element::link_many([&parse, &dec, &convert]).map_err(|e| format!("link decode chain: {e}"))?;
    let parse_weak = parse.downgrade();
    demux.connect_pad_added(move |_, pad| {
        let Some(parse) = parse_weak.upgrade() else { return };
        let is_video = pad.current_caps().or_else(|| Some(pad.query_caps(None))).and_then(|c| c.structure(0).map(|s| s.name().starts_with("video/"))).unwrap_or(false);
        if !is_video {
            return;
        }
        if let Some(sink) = parse.static_pad("sink")
            && !sink.is_linked()
        {
            let _ = pad.link(&sink);
        }
    });
    Ok((demux, convert))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_names() {
        assert_eq!(Codec::parse(""), Some(Codec::Raw));
        assert_eq!(Codec::parse("RAW"), Some(Codec::Raw));
        assert_eq!(Codec::parse("h265"), Some(Codec::Hevc));
        assert_eq!(Codec::parse("avc"), Some(Codec::H264));
        assert_eq!(Codec::parse("av1"), None);
        assert_eq!(Codec::parse("neural"), None);
    }

    #[test]
    fn rates_and_rasters() {
        assert_eq!(parse_rate("25").unwrap(), (25, 1));
        assert_eq!(parse_rate("30000/1001").unwrap(), (30000, 1001));
        assert_eq!(parse_rate("29.97").unwrap(), (30000, 1001));
        assert_eq!(parse_rate("23.976").unwrap(), (24000, 1001));
        assert_eq!(parse_rate("59.94").unwrap(), (60000, 1001));
        assert_eq!(parse_rate("12.5").unwrap(), (12500, 1000));
        assert!(parse_rate("abc").is_err());
        assert!(Raster::new(3840, 2160, 50, 1).is_ok());
        assert!(Raster::new(7680, 4320, 60000, 1001).is_ok());
        assert!(Raster::new(720, 576, 25, 1).is_ok());
        assert!(Raster::new(1919, 1080, 25, 1).is_err());
        assert!(Raster::new(1920, 1080, 0, 1).is_err());
        let uhd = Raster::new(3840, 2160, 50, 1).unwrap();
        assert!(uhd.auto_bitrate_kbps(Codec::Hevc) > 25_000);
        assert!(Raster::new(64, 64, 1, 1).unwrap().auto_bitrate_kbps(Codec::H264) == 500);
    }

    #[test]
    fn chains_can_be_built() {
        gst::init().unwrap();
        for c in [Codec::H264, Codec::Hevc] {
            let ch = encode_chain(c, EncodeParams { bitrate_kbps: 1000, ten_bit: false, fps: 25 }).unwrap();
            assert_eq!(ch.len(), 5);
            let p = gst::Pipeline::new();
            decode_chain(c, &p).unwrap();
        }
        assert!(encode_chain(Codec::Raw, EncodeParams { bitrate_kbps: 1, ten_bit: false, fps: 25 }).is_err());
    }

    /// Echter Rundlauf über SRT auf localhost (kleines Bild, wenige Sekunden): Testbild → Encoder → TS → SRT →
    /// Decoder → Bilder. Prüft, dass wirklich dekodierte Bilder der erwarteten Größe ankommen.
    fn roundtrip(codec: Codec, ten_bit: bool, port: u16) -> (u64, i32, i32) {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};
        gst::init().unwrap();
        let uri_l = format!("srt://127.0.0.1:{port}?mode=listener");
        let uri_c = format!("srt://127.0.0.1:{port}?mode=caller");

        let tx = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).build().unwrap();
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", gst::Caps::builder("video/x-raw").field("width", 320i32).field("height", 180i32).field("framerate", gst::Fraction::new(10, 1)).build())
            .build()
            .unwrap();
        let chain = encode_chain(codec, EncodeParams { bitrate_kbps: 800, ten_bit, fps: 10 }).unwrap();
        let sink = gst::ElementFactory::make("srtsink").property("uri", &uri_l).build().unwrap();
        tx.add_many([&src, &caps]).unwrap();
        tx.add_many(chain.iter()).unwrap();
        tx.add(&sink).unwrap();
        let mut all = vec![src.clone(), caps.clone()];
        all.extend(chain.iter().cloned());
        all.push(sink.clone());
        gst::Element::link_many(all.iter()).unwrap();

        let rx = gst::Pipeline::new();
        let srtsrc = gst::ElementFactory::make("srtsrc").property("uri", &uri_c).build().unwrap();
        rx.add(&srtsrc).unwrap();
        let (first, last) = decode_chain(codec, &rx).unwrap();
        let appsink = gst::ElementFactory::make("fakesink").property("signal-handoffs", true).property("sync", false).build().unwrap();
        rx.add(&appsink).unwrap();
        gst::Element::link_many([&srtsrc, &first]).unwrap();
        last.link(&appsink).unwrap();
        let count = Arc::new(AtomicU64::new(0));
        let c2 = count.clone();
        appsink.connect("handoff", false, move |_| {
            c2.fetch_add(1, Ordering::Relaxed);
            None
        });
        let dims = Arc::new(std::sync::Mutex::new((0i32, 0i32)));
        let d2 = dims.clone();
        last.static_pad("src").unwrap().add_probe(gst::PadProbeType::BUFFER, move |pad, _| {
            if let Some(s) = pad.current_caps().and_then(|c| c.structure(0).map(|s| s.to_owned())) {
                *d2.lock().unwrap() = (s.get::<i32>("width").unwrap_or(0), s.get::<i32>("height").unwrap_or(0));
            }
            gst::PadProbeReturn::Ok
        });

        tx.set_state(gst::State::Playing).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        rx.set_state(gst::State::Playing).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(4));
        let n = count.load(Ordering::Relaxed);
        let (w, h) = *dims.lock().unwrap();
        let _ = rx.set_state(gst::State::Null);
        let _ = tx.set_state(gst::State::Null);
        (n, w, h)
    }

    #[test]
    #[ignore = "Netzwerk/CPU: gezielt starten (cargo test -- --ignored srt_roundtrip)"]
    fn srt_roundtrip_h264() {
        let (n, w, h) = roundtrip(Codec::H264, false, 7311);
        assert!(n >= 10, "nur {n} Bilder");
        assert_eq!((w, h), (320, 180));
    }

    #[test]
    #[ignore = "Netzwerk/CPU: gezielt starten (cargo test -- --ignored srt_roundtrip)"]
    fn srt_roundtrip_hevc() {
        let (n, w, h) = roundtrip(Codec::Hevc, false, 7312);
        assert!(n >= 10, "nur {n} Bilder");
        assert_eq!((w, h), (320, 180));
    }

    #[test]
    #[ignore = "Netzwerk/CPU: gezielt starten (cargo test -- --ignored srt_roundtrip)"]
    fn srt_roundtrip_hevc_10bit() {
        let (n, _, _) = roundtrip(Codec::Hevc, true, 7313);
        assert!(n >= 10, "nur {n} Bilder");
    }

    /// Rohvideo (RTP RFC 4175 über SRT) mit untypischem Raster: 400×226 bei 29,97 — die Empfangskaps kommen aus dem
    /// Raster, wie im Gateway (`pipeline::build_downlink`).
    #[test]
    #[ignore = "Netzwerk/CPU: gezielt starten (cargo test -- --ignored srt_roundtrip)"]
    fn srt_roundtrip_raw_odd_raster() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};
        gst::init().unwrap();
        let r = Raster::new(400, 226, 30000, 1001).unwrap();
        let tx = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).build().unwrap();
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", gst::Caps::builder("video/x-raw").field("format", "UYVY").field("width", r.width).field("height", r.height).field("framerate", gst::Fraction::new(r.fps_n, r.fps_d)).build())
            .build()
            .unwrap();
        let pay = gst::ElementFactory::make("rtpvrawpay").build().unwrap();
        let sink = gst::ElementFactory::make("srtsink").property("uri", "srt://127.0.0.1:7314?mode=listener").build().unwrap();
        tx.add_many([&src, &caps, &pay, &sink]).unwrap();
        gst::Element::link_many([&src, &caps, &pay, &sink]).unwrap();

        let rx = gst::Pipeline::new();
        let srtsrc = gst::ElementFactory::make("srtsrc").property("uri", "srt://127.0.0.1:7314?mode=caller").build().unwrap();
        let rtp_filter = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                &gst::Caps::builder("application/x-rtp")
                .field("media", "video")
                .field("clock-rate", 90000i32)
                .field("encoding-name", "RAW")
                .field("sampling", "YCbCr-4:2:2")
                .field("depth", "8")
                .field("width", r.width.to_string())
                .field("height", r.height.to_string())
                .field("colorimetry", "BT709-2")
                .build(),
            )
            .build()
            .unwrap();
        let jb = gst::ElementFactory::make("rtpjitterbuffer").build().unwrap();
        let depay = gst::ElementFactory::make("rtpvrawdepay").build().unwrap();
        let fake = gst::ElementFactory::make("fakesink").property("signal-handoffs", true).property("sync", false).build().unwrap();
        rx.add_many([&srtsrc, &rtp_filter, &jb, &depay, &fake]).unwrap();
        gst::Element::link_many([&srtsrc, &rtp_filter, &jb, &depay, &fake]).unwrap();
        let n = Arc::new(AtomicU64::new(0));
        let n2 = n.clone();
        fake.connect("handoff", false, move |_| {
            n2.fetch_add(1, Ordering::Relaxed);
            None
        });
        tx.set_state(gst::State::Playing).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        rx.set_state(gst::State::Playing).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(4));
        let got = n.load(Ordering::Relaxed);
        let _ = rx.set_state(gst::State::Null);
        let _ = tx.set_state(gst::State::Null);
        assert!(got >= 20, "nur {got} Bilder");
    }
}
