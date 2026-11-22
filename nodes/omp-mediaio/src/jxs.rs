//! Optionales Videoprofil JPEG XS (ISO/IEC 21122) für ST 2110-22 — Nutzerauftrag 2026-11-22, Punkt 1 der Recherche.
//!
//! **Opt-in, nichts Bestehendes ändert sich:** `video/raw` (ST 2110-20) bleibt Standard. JPEG XS ist ein zusätzliches
//! Netzwerkprofil für den Rand (Gateway, WAN, Monitorwand); im MXL-Ring bleibt V210, MXL kennt kein JPEG XS.
//! Es gibt keine Build-Abhängigkeit: die GStreamer-Elemente werden zur Laufzeit gesucht ([`availability`]):
//! Encoder/Decoder `svtjpegxsenc`/`svtjpegxsdec` (gst-plugins-bad, SVT-JPEG-XS) und Payloader/Depayloader
//! `rtpjxsvpay`/`rtpjxsvdepay` (gst-plugins-rs, RFC 9134). Fehlen sie, melden [`build_tx`]/[`build_rx`] einen klaren
//! Fehler und der Aufrufer bleibt bei `video/raw`.
//!
//! Normen: SMPTE ST 2110-22 (Constant-Bit-Rate-Kompressionsvideo, SSN `ST2110-22:2019`), RFC 9134 (RTP-Payload,
//! `a=rtpmap:<pt> jxsv/90000`, fmtp-Parameter), AMWA BCP-006-01 (NMOS: Medientyp `video/jxsv`, Profil/Level/Sublevel).
//! Die Parameterwerte (Profil, Level, Sublevel) stammen aus RFC 9134 §7.1 und sind an echter Gegenstelle noch zu belegen.

use gstreamer as gst;
use gst::prelude::*;

pub const ENCODER: &str = "svtjpegxsenc";
pub const DECODER: &str = "svtjpegxsdec";
pub const PAYLOADER: &str = "rtpjxsvpay";
pub const DEPAYLOADER: &str = "rtpjxsvdepay";
/// NMOS-/IANA-Medientyp (BCP-006-01).
pub const MEDIA_TYPE: &str = "video/jxsv";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Availability {
    pub encoder: bool,
    pub decoder: bool,
    pub payloader: bool,
    pub depayloader: bool,
}

impl Availability {
    pub fn can_send(&self) -> bool {
        self.encoder && self.payloader
    }
    pub fn can_receive(&self) -> bool {
        self.decoder && self.depayloader
    }
    /// Fehlende Elemente als Text (leer = alles da), für Fehlermeldungen und Parameter.
    pub fn missing(&self) -> Vec<&'static str> {
        [(self.encoder, ENCODER), (self.decoder, DECODER), (self.payloader, PAYLOADER), (self.depayloader, DEPAYLOADER)]
            .into_iter()
            .filter(|(ok, _)| !ok)
            .map(|(_, n)| n)
            .collect()
    }
}

/// Sucht die Elemente in der Registry (ruft `gst::init` selbst auf).
pub fn availability() -> Availability {
    let _ = gst::init();
    let has = |n: &str| gst::ElementFactory::find(n).is_some();
    Availability { encoder: has(ENCODER), decoder: has(DECODER), payloader: has(PAYLOADER), depayloader: has(DEPAYLOADER) }
}

/// Parameter eines JPEG-XS-Stroms (RFC 9134 / ST 2110-22).
#[derive(Clone, Debug, PartialEq)]
pub struct JxsParams {
    pub width: i32,
    pub height: i32,
    pub fps_n: i32,
    pub fps_d: i32,
    pub depth: u8,
    /// Zielrate des Codestroms in Mbit/s (konstante Bitrate, ST 2110-22).
    pub bitrate_mbps: u32,
    pub interlaced: bool,
}

impl JxsParams {
    /// Richtwert: ~ 1/8 der Rohdatenrate (visuell verlustfrei im Sinne der Norm), mindestens 20 Mbit/s.
    pub fn with_default_rate(width: i32, height: i32, fps_n: i32, fps_d: i32, depth: u8, interlaced: bool) -> Self {
        let raw_bps = width as f64 * height as f64 * 2.0 * depth as f64 * fps_n as f64 / fps_d.max(1) as f64;
        JxsParams { width, height, fps_n, fps_d, depth, bitrate_mbps: ((raw_bps / 8.0 / 1e6).round() as u32).max(20), interlaced }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.width <= 0 || self.height <= 0 || self.fps_n <= 0 || self.fps_d <= 0 {
            return Err("JPEG XS: Bildmaße und Bildrate müssen positiv sein".into());
        }
        if !matches!(self.depth, 8 | 10 | 12) {
            return Err(format!("JPEG XS: Bittiefe {} nicht unterstützt (8, 10, 12)", self.depth));
        }
        if !(1..=10_000).contains(&self.bitrate_mbps) {
            return Err("JPEG XS: Bitrate außerhalb 1–10000 Mbit/s".into());
        }
        Ok(())
    }
}

/// `a=rtpmap`/`a=fmtp`-Zeilen (ohne `m=`/`c=`) für den Medienabschnitt.
pub fn sdp_lines(p: &JxsParams, pt: u8) -> String {
    format!(
        "a=rtpmap:{pt} jxsv/90000\r\n\
         a=fmtp:{pt} packetmode=0; profile=High444.12; level=2k-1; sublevel=Sublev3bpp; sampling=YCbCr-4:2:2; \
         width={w}; height={h}; exactframerate={n}/{d}; depth={depth}; colorimetry=BT709; {il}\
         TCS=SDR; RANGE=NARROW; SSN=ST2110-22:2019; TP=2110TPW\r\n",
        w = p.width,
        h = p.height,
        n = p.fps_n,
        d = p.fps_d,
        depth = p.depth,
        il = if p.interlaced { "interlace; " } else { "" },
    )
}

/// Ob ein SDP einen JPEG-XS-Strom beschreibt (`a=rtpmap:<pt> jxsv/…`, Groß-/Kleinschreibung egal).
pub fn sdp_is_jxs(sdp: &str) -> bool {
    sdp.lines().any(|l| {
        let l = l.trim().to_ascii_lowercase();
        l.starts_with("a=rtpmap:") && l.contains(" jxsv/")
    })
}

/// NMOS-Receiver-Fähigkeit (BCP-004-01, `constraint_sets`) für `video/jxsv` — nur Medientyp und Bildmaße; Profil/Level
/// werden nicht eingeschränkt (der Decoder nimmt, was SVT-JPEG-XS kann).
pub fn nmos_caps_media_type() -> &'static str {
    MEDIA_TYPE
}

fn make(name: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(name).build().map_err(|e| format!("{name}: {e}"))
}

/// Sendekette `upstream → videoconvert → I422_10LE → svtjpegxsenc → rtpjxsvpay`; Rückgabe: Elemente in Reihenfolge
/// (letztes = Payloader, dahinter hängt der Aufrufer Valve/Socket). Fehlen Elemente: Fehler mit Namen.
pub fn build_tx(pipeline: &gst::Pipeline, upstream: &gst::Element, p: &JxsParams) -> Result<Vec<gst::Element>, String> {
    p.validate()?;
    let a = availability();
    if !a.can_send() {
        return Err(format!("JPEG XS (senden) nicht verfügbar, es fehlen: {}", a.missing().into_iter().filter(|n| *n == ENCODER || *n == PAYLOADER).collect::<Vec<_>>().join(", ")));
    }
    let convert = make("videoconvert")?;
    let format = match p.depth {
        8 => "I422_8",
        10 => "I422_10LE",
        _ => "I422_12LE",
    };
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("video/x-raw").field("format", format).field("width", p.width).field("height", p.height).field("framerate", gst::Fraction::new(p.fps_n, p.fps_d)).build())
        .build()
        .map_err(|e| format!("capsfilter: {e}"))?;
    let enc = make(ENCODER)?;
    // Eigenschaftsnamen nur setzen, wenn das Element sie kennt (Version des Plugins unbekannt).
    if enc.find_property("bitrate").is_some() {
        enc.set_property_from_str("bitrate", &(p.bitrate_mbps as u64 * 1_000_000).to_string());
    }
    let pay = make(PAYLOADER)?;
    let mut chain = vec![upstream.clone(), convert, caps, enc, pay];
    for el in &chain[1..] {
        pipeline.add(el).map_err(|e| format!("JPEG XS: add: {e}"))?;
    }
    gst::Element::link_many(chain.iter()).map_err(|e| format!("JPEG XS: link tx: {e}"))?;
    chain.remove(0);
    Ok(chain)
}

/// Empfangskette `rtpjxsvdepay → svtjpegxsdec → videoconvert`; Rückgabe `(erstes, letztes)` Element. Der Aufrufer hängt
/// den Jitterbuffer davor und liest Rohbilder hinten ab.
pub fn build_rx(pipeline: &gst::Pipeline) -> Result<(gst::Element, gst::Element), String> {
    let a = availability();
    if !a.can_receive() {
        return Err(format!("JPEG XS (empfangen) nicht verfügbar, es fehlen: {}", a.missing().into_iter().filter(|n| *n == DECODER || *n == DEPAYLOADER).collect::<Vec<_>>().join(", ")));
    }
    let depay = make(DEPAYLOADER)?;
    let dec = make(DECODER)?;
    let convert = make("videoconvert")?;
    for el in [&depay, &dec, &convert] {
        pipeline.add(el).map_err(|e| format!("JPEG XS: add: {e}"))?;
    }
    gst::Element::link_many([&depay, &dec, &convert]).map_err(|e| format!("JPEG XS: link rx: {e}"))?;
    Ok((depay, convert))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_rate_is_about_an_eighth_of_raw() {
        let p = JxsParams::with_default_rate(1920, 1080, 50, 1, 10, false);
        // raw 4:2:2 10 Bit 1080p50 ≈ 2,07 Gbit/s → ≈ 259 Mbit/s
        assert!((250..=270).contains(&p.bitrate_mbps), "{}", p.bitrate_mbps);
        let small = JxsParams::with_default_rate(320, 180, 25, 1, 10, false);
        assert_eq!(small.bitrate_mbps, 20);
    }

    #[test]
    fn sdp_has_rfc9134_and_st2110_22_markers() {
        let s = sdp_lines(&JxsParams::with_default_rate(1920, 1080, 50, 1, 10, true), 98);
        assert!(s.contains("a=rtpmap:98 jxsv/90000"));
        assert!(s.contains("SSN=ST2110-22:2019"));
        assert!(s.contains("packetmode=0"));
        assert!(s.contains("exactframerate=50/1") && s.contains("interlace; "));
        assert!(sdp_is_jxs(&format!("m=video 5004 RTP/AVP 98\r\n{s}")));
        assert!(!sdp_is_jxs("a=rtpmap:96 raw/90000\r\n"));
    }

    #[test]
    fn validation_rejects_bad_values() {
        let mut p = JxsParams::with_default_rate(1920, 1080, 25, 1, 10, false);
        assert!(p.validate().is_ok());
        p.depth = 9;
        assert!(p.validate().is_err());
        p.depth = 10;
        p.bitrate_mbps = 0;
        assert!(p.validate().is_err());
    }

    #[test]
    fn missing_elements_give_a_clear_error_not_a_panic() {
        let a = Availability { encoder: false, decoder: true, payloader: true, depayloader: false };
        assert!(!a.can_send() && !a.can_receive());
        assert_eq!(a.missing(), vec![ENCODER, DEPAYLOADER]);
        let _ = gst::init();
        if !availability().can_send() {
            let pl = gst::Pipeline::new();
            let src = gst::ElementFactory::make("videotestsrc").build().unwrap();
            let e = build_tx(&pl, &src, &JxsParams::with_default_rate(320, 180, 25, 1, 10, false)).unwrap_err();
            assert!(e.contains("nicht verfügbar"), "{e}");
        }
    }
}
