//! RTP-Dev-Implementierung von [`crate::Output`] (`UMSETZUNG.md` C3:
//! "RTP, 2110-vorbereitet") — pragmatischer Entwicklungs-Codec statt
//! echtem ST 2110, hinter demselben Trait wie eine spätere 2110/MXL-
//! Implementierung. `videoconvert` (Farbraum), `videoscale` (Auflösung)
//! und `capsfilter` erzwingen gemeinsam ein festes, RFC-4175-kompatibles
//! Rohbildformat (UYVY, 640×480) unabhängig vom nativen Format/Auflösung
//! der Quelle — `videoconvert` allein wandelt nur den Farbraum, ohne
//! `videoscale` bliebe die native Auflösung der Quelle erhalten und die
//! Caps-Verhandlung vor `rtpvrawpay` würde fehlschlagen, sobald sie von
//! 640×480 abweicht.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gst::prelude::*;
use gstreamer as gst;

use crate::Output;

const WIDTH: i32 = 640;
const HEIGHT: i32 = 480;

/// `videoconvert ! capsfilter(UYVY) ! rtpvrawpay ! valve ! udpsink`,
/// angehängt an einen vom Aufrufer bereitgestellten Pipeline-Zweig (z. B.
/// ein Tee-Ausgang hinter der Testquelle). `valve` schaltet den Ausgang
/// über die `drop`-Property scharf/stumm, ohne Pads mitten im Betrieb
/// um- oder abzuhängen; `udpsink` trägt das aktuelle Ziel als Property.
pub struct RtpVideoOutput {
    valve: gst::Element,
    udpsink: gst::Element,
    destination: Mutex<(String, u16)>,
    framerate_numerator: i32,
    framerate_denominator: i32,
    flowed: Arc<AtomicBool>,
}

impl RtpVideoOutput {
    /// Baut die Elemente, hängt sie an `pipeline` und verlinkt sie hinter
    /// `upstream`. Startet inaktiv (`drop=true`) mit `initial_host`/
    /// `initial_port` als Ziel. Muss aufgerufen werden, bevor `pipeline`
    /// in den Playing-Zustand wechselt (kein dynamisches Nachrüsten in
    /// eine bereits laufende Pipeline — vereinfacht Zustands-Sync).
    pub fn new(
        pipeline: &gst::Pipeline,
        upstream: &gst::Element,
        initial_host: &str,
        initial_port: u16,
        framerate_numerator: i32,
        framerate_denominator: i32,
    ) -> Result<Self, String> {
        let videoconvert = gst::ElementFactory::make("videoconvert")
            .build()
            .map_err(|e| format!("videoconvert: {e}"))?;
        let videoscale = gst::ElementFactory::make("videoscale")
            .build()
            .map_err(|e| format!("videoscale: {e}"))?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field("format", "UYVY")
                    .field("width", WIDTH)
                    .field("height", HEIGHT)
                    .build(),
            )
            .build()
            .map_err(|e| format!("capsfilter(UYVY): {e}"))?;
        let payloader = gst::ElementFactory::make("rtpvrawpay")
            .build()
            .map_err(|e| format!("rtpvrawpay: {e}"))?;
        let valve = gst::ElementFactory::make("valve")
            .name("video_valve")
            .property("drop", true)
            .build()
            .map_err(|e| format!("valve: {e}"))?;
        let udpsink = gst::ElementFactory::make("udpsink")
            .name("video_sink")
            .property("host", initial_host)
            .property("port", initial_port as i32)
            .property("sync", true)
            .property("async", false)
            .build()
            .map_err(|e| format!("udpsink: {e}"))?;

        pipeline
            .add(&videoconvert)
            .and_then(|()| pipeline.add(&videoscale))
            .and_then(|()| pipeline.add(&caps))
            .and_then(|()| pipeline.add(&payloader))
            .and_then(|()| pipeline.add(&valve))
            .and_then(|()| pipeline.add(&udpsink))
            .map_err(|e| format!("add rtp output elements: {e}"))?;

        gst::Element::link_many([
            upstream,
            &videoconvert,
            &videoscale,
            &caps,
            &payloader,
            &valve,
            &udpsink,
        ])
        .map_err(|e| format!("link rtp output chain: {e}"))?;

        // Probe auf dem **Src**-Pad des Valve, nicht dem Sink-Pad: ein
        // `valve` mit `drop=true` lässt Buffer trotzdem an seinem
        // Sink-Pad ankommen (sie werden erst intern verworfen) — ein
        // Sink-Pad-Probe würde "media-ready" fälschlich melden, obwohl
        // der Ausgang stumm geschaltet ist und nichts wirklich das Netz
        // erreicht (ARCHITECTURE.md §5 Punkt 6: "tatsächlich Medien
        // produziert"). Selbstentfernend (`PadProbeReturn::Remove`) nach
        // dem ersten Treffer — `has_flowed` ist ein Sticky-Flag, der
        // Probe wird danach nicht mehr gebraucht.
        let flowed = Arc::new(AtomicBool::new(false));
        let flowed_probe = flowed.clone();
        let valve_src_pad = valve.static_pad("src").expect("valve has a src pad");
        valve_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            flowed_probe.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Remove
        });

        Ok(RtpVideoOutput {
            valve,
            udpsink,
            destination: Mutex::new((initial_host.to_string(), initial_port)),
            framerate_numerator,
            framerate_denominator,
            flowed,
        })
    }

    /// Setzt/ändert das Ziel. RTP-spezifisch (Host+Port) — kein Teil des
    /// generischen `Output`-Traits (siehe `lib.rs`).
    pub fn set_destination(&self, host: &str, port: u16) {
        self.udpsink.set_property("host", host);
        self.udpsink.set_property("port", port as i32);
        *self.destination.lock().expect("lock poisoned") = (host.to_string(), port);
    }

    /// Aktuelles Ziel (Host, Port).
    pub fn destination(&self) -> (String, u16) {
        self.destination.lock().expect("lock poisoned").clone()
    }

    /// SDP-Beschreibung des aktuellen Ziels/Formats (RFC 4175 / ST
    /// 2110-20-artig) — Inhalt von `.../transportfile` (IS-05).
    ///
    /// Zwei reale Bugs live am echten AMWA-IS-05-01-Tool-Lauf gefunden
    /// (Nachtrag 194/195, docs/decisions.md) — nie vorher aufgefallen,
    /// weil IS-05-01 nie gegen einen echten Rust-Sender lief, nur gegen
    /// den Go-Mock-Node:
    /// 1. `a=rtpmap`s Taktrate MUSS für RTP-Rohvideo laut RFC 4175/
    ///    ST 2110-20 §7.1 fest 90000 Hz sein, nicht die Framerate — die
    ///    Framerate steht separat in `a=fmtp`s `exactframerate`.
    /// 2. `c=` muss NACH `m=` stehen (Medien-Ebene). Beide Positionen
    ///    sind gültiges SDP, aber der AMWA-SDP-Parser
    ///    (`IS05Utils.check_sdp_matches_params`) sucht `c=` nur in der
    ///    Medien-Sektion — eine Session-Ebene-`c=`-Zeile davor liefert
    ///    dort `None`, `.group()` darauf crasht mit einer unbehandelten
    ///    Python-Exception.
    ///
    /// `a=fmtp` fehlten außerdem `colorimetry`/`PM`/`SSN`/`TP`
    /// (SDPoker-Pflichtfelder), `a=mediaclk`/`a=ts-refclk` (ST 2110-10
    /// §8.1/8.2) komplett.
    pub fn sdp(&self) -> String {
        let (host, port) = self.destination();
        format!(
            "v=0\r\n\
             o=- 0 0 IN IP4 {host}\r\n\
             s=OpenMediaPlatform Playout\r\n\
             t=0 0\r\n\
             m=video {port} RTP/AVP 96\r\n\
             c=IN IP4 {host}\r\n\
             a=ts-refclk:ptp=IEEE1588-2008:EC-46-70-FF-FE-00-CE-DE:0\r\n\
             a=mediaclk:direct=0\r\n\
             a=rtpmap:96 raw/90000\r\n\
             a=fmtp:96 sampling=YCbCr-4:2:2; depth=8; width={WIDTH}; height={HEIGHT}; \
             colorimetry=BT709; PM=2110GPM; SSN=ST2110-20:2017; TP=2110TPN; TCS=SDR; \
             exactframerate={num}/{den}\r\n",
            num = self.framerate_numerator,
            den = self.framerate_denominator,
        )
    }
}

impl Output for RtpVideoOutput {
    fn set_active(&self, active: bool) {
        self.valve.set_property("drop", !active);
    }

    fn is_active(&self) -> bool {
        !self.valve.property::<bool>("drop")
    }
}

impl crate::MediaFlow for RtpVideoOutput {
    fn has_flowed(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Nachtrag 195/196: live am echten AMWA-IS-05-01-Tool-Lauf gefunden
    /// (am Go-Mock-Node-Pendant, nie zuvor gegen einen echten Rust-Sender
    /// getestet) — zwei reale Bugs, hier verankert: (1) die Taktrate für
    /// RTP-Rohvideo muss 90000 Hz sein (RFC 4175/ST 2110-20), nicht die
    /// Framerate. (2) `c=` muss NACH `m=` stehen (Medien-Ebene) —
    /// `IS05Utils.check_sdp_matches_params` (AMWA-nmos-testing) sucht
    /// die `c=`-Zeile nur innerhalb der Medien-Sektion, eine
    /// Session-Ebene-Zeile davor crasht dort mit `NoneType.group()`.
    #[test]
    fn sdp_is_st2110_20_conformant() {
        gst::init().expect("gst::init");
        let pipeline = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").build().expect("videotestsrc");
        pipeline.add(&src).expect("add videotestsrc");
        let output = RtpVideoOutput::new(&pipeline, &src, "127.0.0.1", 52141, 25, 1)
            .expect("RtpVideoOutput::new");
        let sdp = output.sdp();

        assert!(sdp.contains("a=rtpmap:96 raw/90000"), "sdp = {sdp}");
        assert!(
            !sdp.contains("a=rtpmap:96 raw/25"),
            "clock rate must not be the framerate: sdp = {sdp}"
        );
        let m_index = sdp.find("m=video").expect("m=video line present");
        let c_index = sdp.find("c=IN IP4").expect("c= line present");
        assert!(
            c_index > m_index,
            "c= must come AFTER m= (media-level, not session-level): sdp = {sdp}"
        );
        for required in ["a=mediaclk:", "a=ts-refclk:", "PM=", "SSN=", "TP="] {
            assert!(sdp.contains(required), "missing {required:?}: sdp = {sdp}");
        }
    }
}
