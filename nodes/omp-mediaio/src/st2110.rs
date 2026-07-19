//! ST 2110-20-artige (Software-)Implementierung von [`crate::Output`] +
//! ein dazu passender Empfänger (`UMSETZUNG.md` D4). Generalisiert
//! [`crate::rtp::RtpVideoOutput`] (C3, feste 640×480, nur Sender) auf
//! konfigurierbare Auflösung/Framerate **und** ergänzt die bisher
//! fehlende Empfänger-Seite — `rtp.rs` bleibt unverändert (Playout, C1–C3,
//! "kein Rückbau"), dieses Modul ist eine eigenständige, zweite
//! `Output`-Implementierung für neue Nodes (z. B. den SRT-Gateway).
//!
//! Payload-Format exakt am echten `gst-launch-1.0`-Testlauf verifiziert,
//! nicht geraten (`docs/decisions.md`, 2026-07-13): `rtpvrawpay`/
//! `rtpvrawdepay` implementieren RFC 4175 (Uncompressed Video über RTP),
//! dieselbe Payload-Struktur, auf der SMPTE ST 2110-20 aufbaut — die
//! RTP-Caps tragen `width`/`height`/`depth` als **String**-Felder (nicht
//! int), `sampling`/`colorimetry` als String-Enums.
//!
//! **Audio (ST 2110-30/AES67) seit Kapitel 19 Teil 0** (`docs/
//! END-GOAL-FEATURES.md` §19.3a/§19.4, `docs/decisions.md`) —
//! [`St2110AudioOutput`]/[`St2110AudioInput`] unten, gleiches Muster wie
//! die Video-Typen: `rtpL24pay`/`rtpL24depay` (RFC 3190, L24/PCM über
//! RTP — Payload-Familie am echten `gst-inspect-1.0`-Lauf verifiziert,
//! nicht geraten: Sink-Caps `audio/x-raw,format=S24BE,layout=
//! interleaved`, Src-Caps `application/x-rtp,encoding-name=L24`).
//! `min-ptime`/`max-ptime` auf 1ms (1.000.000ns) gesetzt — AES67-
//! Konformitätsstufe A **und** ST-2110-30-Standardprofil verlangen
//! exakt 1ms-Pakete (`docs/END-GOAL-FEATURES.md` §19.3c: dieselben
//! Bausteine bedienen beide Standards, deckungsgleiches Profil).
//!
//! **Bewusst nicht Teil dieses Moduls (UMSETZUNG.md D4, dokumentierter
//! Restscope):**
//! - **PTP-Zeitbasis:** GStreamer hat eingebaute PTP-Unterstützung
//!   (`gstreamer-net`/`GstPtpClock`), aber echte Synchronität lässt sich
//!   auf der Single-Host-Dev-Maschine ohne zweiten PTP-Host nicht
//!   sinnvoll verifizieren (`ARCHITECTURE.md` §8: "Free-Run-Modus
//!   tolerieren"). Dieses Modul läuft im GStreamer-Systemtakt
//!   (Free-Run) — derselbe Default wie `rtp.rs` heute schon. Kapitel 19
//!   Teil 2 (Opt-in-PTP-Clock) bleibt eigener Schritt.
//! - **SAP-Announcements (RFC 2974):** nötig, damit Dante-Controller/
//!   AES67-Gegenstellen einen Fremd-Stream automatisch finden — Teil
//!   von Kapitel 19 Teil 3 (`omp-aes67-gateway`), nicht dieses Moduls.
//! - **ST 2022-7 Pfad-Redundanz:** P2-Scope (`ARCHITECTURE.md` §2).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gst::prelude::*;
use gstreamer as gst;

use crate::Output;

/// Ein ST-2110-20-Sender: `upstream ! videoconvert ! videoscale !
/// capsfilter(UYVY,W,H,fps) ! rtpvrawpay ! valve ! udpsink`. Anders als
/// [`crate::rtp::RtpVideoOutput`] sind Breite/Höhe/Framerate
/// Konstruktor-Parameter statt fest verdrahtet — jeder Node wählt sein
/// eigenes Format, statt sich (wie der C3-Playout-Node) auf 640×480
/// festzulegen.
pub struct St2110VideoOutput {
    valve: gst::Element,
    udpsink: gst::Element,
    destination: Mutex<(String, u16)>,
    width: i32,
    height: i32,
    framerate_numerator: i32,
    framerate_denominator: i32,
    flowed: Arc<AtomicBool>,
}

impl St2110VideoOutput {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pipeline: &gst::Pipeline,
        upstream: &gst::Element,
        initial_host: &str,
        initial_port: u16,
        width: i32,
        height: i32,
        framerate_numerator: i32,
        framerate_denominator: i32,
    ) -> Result<Self, String> {
        let videoconvert = gst::ElementFactory::make("videoconvert")
            .build()
            .map_err(|e| format!("videoconvert: {e}"))?;
        let videoscale = gst::ElementFactory::make("videoscale")
            .build()
            .map_err(|e| format!("videoscale: {e}"))?;
        let videorate = gst::ElementFactory::make("videorate")
            .build()
            .map_err(|e| format!("videorate: {e}"))?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field("format", "UYVY")
                    .field("width", width)
                    .field("height", height)
                    .field(
                        "framerate",
                        gst::Fraction::new(framerate_numerator, framerate_denominator),
                    )
                    .build(),
            )
            .build()
            .map_err(|e| format!("capsfilter(UYVY): {e}"))?;
        let payloader = gst::ElementFactory::make("rtpvrawpay")
            .build()
            .map_err(|e| format!("rtpvrawpay: {e}"))?;
        let valve = gst::ElementFactory::make("valve")
            .name("st2110_video_valve")
            .property("drop", true)
            .build()
            .map_err(|e| format!("valve: {e}"))?;
        let udpsink = gst::ElementFactory::make("udpsink")
            .name("st2110_video_sink")
            .property("host", initial_host)
            .property("port", initial_port as i32)
            .property("sync", true)
            .property("async", false)
            .build()
            .map_err(|e| format!("udpsink: {e}"))?;

        pipeline
            .add(&videoconvert)
            .and_then(|()| pipeline.add(&videoscale))
            .and_then(|()| pipeline.add(&videorate))
            .and_then(|()| pipeline.add(&caps))
            .and_then(|()| pipeline.add(&payloader))
            .and_then(|()| pipeline.add(&valve))
            .and_then(|()| pipeline.add(&udpsink))
            .map_err(|e| format!("add st2110 output elements: {e}"))?;

        gst::Element::link_many([
            upstream,
            &videoconvert,
            &videoscale,
            &videorate,
            &caps,
            &payloader,
            &valve,
            &udpsink,
        ])
        .map_err(|e| format!("link st2110 output chain: {e}"))?;

        // Probe auf dem Src-Pad des Valve, nicht dem Sink-Pad — gleiche
        // Begründung wie bei RtpVideoOutput (rtp.rs): ein `drop=true`
        // geschalteter Valve lässt Buffer an seinem Sink-Pad ankommen,
        // bevor sie intern verworfen werden.
        let flowed = Arc::new(AtomicBool::new(false));
        let flowed_probe = flowed.clone();
        let valve_src_pad = valve.static_pad("src").expect("valve has a src pad");
        valve_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            flowed_probe.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Remove
        });

        Ok(St2110VideoOutput {
            valve,
            udpsink,
            destination: Mutex::new((initial_host.to_string(), initial_port)),
            width,
            height,
            framerate_numerator,
            framerate_denominator,
            flowed,
        })
    }

    pub fn set_destination(&self, host: &str, port: u16) {
        self.udpsink.set_property("host", host);
        self.udpsink.set_property("port", port as i32);
        *self.destination.lock().expect("lock poisoned") = (host.to_string(), port);
    }

    pub fn destination(&self) -> (String, u16) {
        self.destination.lock().expect("lock poisoned").clone()
    }

    /// SDP-Beschreibung (ST 2110-20 SDP-Parameter nach SMPTE ST
    /// 2110-20/RFC 4175 `a=fmtp`-Konvention) — Inhalt von
    /// `.../transportfile` (IS-05).
    pub fn sdp(&self) -> String {
        let (host, port) = self.destination();
        format!(
            "v=0\r\n\
             o=- 0 0 IN IP4 {host}\r\n\
             s=OpenMediaPlatform ST2110\r\n\
             c=IN IP4 {host}\r\n\
             t=0 0\r\n\
             m=video {port} RTP/AVP 96\r\n\
             a=rtpmap:96 raw/{num}\r\n\
             a=fmtp:96 sampling=YCbCr-4:2:2; depth=8; width={w}; height={h}; \
             exactframerate={num}/{den}; colorimetry=BT601-5\r\n",
            w = self.width,
            h = self.height,
            num = self.framerate_numerator,
            den = self.framerate_denominator,
        )
    }
}

impl Output for St2110VideoOutput {
    fn set_active(&self, active: bool) {
        self.valve.set_property("drop", !active);
    }

    fn is_active(&self) -> bool {
        !self.valve.property::<bool>("drop")
    }
}

impl crate::MediaFlow for St2110VideoOutput {
    fn has_flowed(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

/// Ein ST-2110-20-Empfänger: `udpsrc(caps) ! rtpjitterbuffer !
/// rtpvrawdepay ! videoconvert`. `tail` ist das letzte Element (wie
/// `MxlVideoInput::tail`, `mxl.rs`) — der Aufrufer verlinkt seine eigene
/// Weiterverarbeitung dahinter, dieses Modul kennt die
/// Downstream-Pipeline des Aufrufers nicht.
///
/// Muss die Breite/Höhe/Framerate der erwarteten Quelle **kennen**
/// (Konstruktor-Parameter) — anders als bei einem Datei-Container trägt
/// eine reine RTP-Payload-Caps-Verhandlung keine verlässliche
/// Framerate-Rückmeldung (am echten Testlauf verifiziert: `rtpvrawdepay`
/// liefert `framerate=(fraction)0/1`, wenn sie nicht separat gesetzt
/// wird) — ein nachgeschaltetes `videorate` + `capsfilter` erzwingt die
/// bekannte Ziel-Framerate, damit Downstream-Elemente (z. B. ein
/// live-sync-`sink`) eine sinnvolle Framerate sehen.
pub struct St2110VideoInput {
    pub tail: gst::Element,
    flowed: Arc<AtomicBool>,
}

impl St2110VideoInput {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pipeline: &gst::Pipeline,
        listen_port: u16,
        width: i32,
        height: i32,
        framerate_numerator: i32,
        framerate_denominator: i32,
    ) -> Result<Self, String> {
        let rtp_caps = gst::Caps::builder("application/x-rtp")
            .field("media", "video")
            .field("clock-rate", 90000)
            .field("encoding-name", "RAW")
            .field("sampling", "YCbCr-4:2:2")
            .field("depth", "8")
            .field("width", width.to_string())
            .field("height", height.to_string())
            .field("payload", 96)
            .build();

        let udpsrc = gst::ElementFactory::make("udpsrc")
            .name("st2110_video_src")
            .property("port", listen_port as i32)
            .property("caps", rtp_caps)
            .build()
            .map_err(|e| format!("udpsrc: {e}"))?;
        let jitterbuffer = gst::ElementFactory::make("rtpjitterbuffer")
            .build()
            .map_err(|e| format!("rtpjitterbuffer: {e}"))?;
        let depayloader = gst::ElementFactory::make("rtpvrawdepay")
            .build()
            .map_err(|e| format!("rtpvrawdepay: {e}"))?;
        let videorate = gst::ElementFactory::make("videorate")
            .build()
            .map_err(|e| format!("videorate: {e}"))?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field(
                        "framerate",
                        gst::Fraction::new(framerate_numerator, framerate_denominator),
                    )
                    .build(),
            )
            .build()
            .map_err(|e| format!("capsfilter(framerate): {e}"))?;
        let videoconvert = gst::ElementFactory::make("videoconvert")
            .build()
            .map_err(|e| format!("videoconvert: {e}"))?;

        pipeline
            .add(&udpsrc)
            .and_then(|()| pipeline.add(&jitterbuffer))
            .and_then(|()| pipeline.add(&depayloader))
            .and_then(|()| pipeline.add(&videorate))
            .and_then(|()| pipeline.add(&caps))
            .and_then(|()| pipeline.add(&videoconvert))
            .map_err(|e| format!("add st2110 input elements: {e}"))?;

        gst::Element::link_many([
            &udpsrc,
            &jitterbuffer,
            &depayloader,
            &videorate,
            &caps,
            &videoconvert,
        ])
        .map_err(|e| format!("link st2110 input chain: {e}"))?;

        // Probe hinter dem Depayloader (nicht auf `udpsrc` selbst): ein
        // ankommendes UDP-Paket allein beweist noch keinen gültigen
        // RTP-Payload — erst nach `rtpvrawdepay` ist sichergestellt, dass
        // wirklich ein dekodiertes Videobild vorliegt.
        let flowed = Arc::new(AtomicBool::new(false));
        let flowed_probe = flowed.clone();
        let depay_src_pad = depayloader.static_pad("src").expect("depayloader has a src pad");
        depay_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            flowed_probe.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Remove
        });

        Ok(St2110VideoInput {
            tail: videoconvert,
            flowed,
        })
    }
}

impl crate::MediaFlow for St2110VideoInput {
    fn has_flowed(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

/// 1ms in Nanosekunden — AES67-Konformitätsstufe-A-/ST-2110-30-
/// Standardprofil (s. Moduldoku), auf `rtpL24pay`s `min-ptime`/
/// `max-ptime` angewendet, damit die Paketierung nicht dem GStreamer-
/// Default (`-1`, unbegrenzt bis MTU) überlassen bleibt.
const AES67_PTIME_NS: i64 = 1_000_000;

/// Ein ST-2110-30/AES67-Sender: `upstream ! audioconvert !
/// audioresample ! capsfilter(S24BE,rate,channels) ! rtpL24pay(ptime=1ms)
/// ! valve ! udpsink`. Gleiche Struktur wie [`St2110VideoOutput`], nur
/// die Audio-Payloader-Kette statt der Video-Kette — beide Standards
/// sind hier bewusst als eigenständige, parallele Typen umgesetzt statt
/// eines generischen "Medienausgangs" (Video/Audio haben genug
/// unterschiedliche Caps-Vokabeln, dass eine gemeinsame Abstraktion mehr
/// verschleiern als vereinfachen würde — gleiche Designentscheidung wie
/// bei den bestehenden Video-Typen).
pub struct St2110AudioOutput {
    valve: gst::Element,
    udpsink: gst::Element,
    destination: Mutex<(String, u16)>,
    sample_rate: i32,
    channels: i32,
    flowed: Arc<AtomicBool>,
}

impl St2110AudioOutput {
    pub fn new(
        pipeline: &gst::Pipeline,
        upstream: &gst::Element,
        initial_host: &str,
        initial_port: u16,
        sample_rate: i32,
        channels: i32,
    ) -> Result<Self, String> {
        let audioconvert = gst::ElementFactory::make("audioconvert")
            .build()
            .map_err(|e| format!("audioconvert: {e}"))?;
        let audioresample = gst::ElementFactory::make("audioresample")
            .build()
            .map_err(|e| format!("audioresample: {e}"))?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("audio/x-raw")
                    .field("format", "S24BE")
                    .field("layout", "interleaved")
                    .field("rate", sample_rate)
                    .field("channels", channels)
                    .build(),
            )
            .build()
            .map_err(|e| format!("capsfilter(S24BE): {e}"))?;
        let payloader = gst::ElementFactory::make("rtpL24pay")
            .property("min-ptime", AES67_PTIME_NS)
            .property("max-ptime", AES67_PTIME_NS)
            .build()
            .map_err(|e| format!("rtpL24pay: {e}"))?;
        let valve = gst::ElementFactory::make("valve")
            .name("st2110_audio_valve")
            .property("drop", true)
            .build()
            .map_err(|e| format!("valve: {e}"))?;
        let udpsink = gst::ElementFactory::make("udpsink")
            .name("st2110_audio_sink")
            .property("host", initial_host)
            .property("port", initial_port as i32)
            .property("sync", true)
            .property("async", false)
            .build()
            .map_err(|e| format!("udpsink: {e}"))?;

        pipeline
            .add(&audioconvert)
            .and_then(|()| pipeline.add(&audioresample))
            .and_then(|()| pipeline.add(&caps))
            .and_then(|()| pipeline.add(&payloader))
            .and_then(|()| pipeline.add(&valve))
            .and_then(|()| pipeline.add(&udpsink))
            .map_err(|e| format!("add st2110 audio output elements: {e}"))?;

        gst::Element::link_many([upstream, &audioconvert, &audioresample, &caps, &payloader, &valve, &udpsink])
            .map_err(|e| format!("link st2110 audio output chain: {e}"))?;

        // Gleiche Begründung wie St2110VideoOutput: Probe auf dem
        // Valve-Src-Pad, nicht dem Sink-Pad (Buffer kommen dort schon
        // an, bevor `drop=true` sie intern verwirft).
        let flowed = Arc::new(AtomicBool::new(false));
        let flowed_probe = flowed.clone();
        let valve_src_pad = valve.static_pad("src").expect("valve has a src pad");
        valve_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            flowed_probe.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Remove
        });

        Ok(St2110AudioOutput {
            valve,
            udpsink,
            destination: Mutex::new((initial_host.to_string(), initial_port)),
            sample_rate,
            channels,
            flowed,
        })
    }

    pub fn set_destination(&self, host: &str, port: u16) {
        self.udpsink.set_property("host", host);
        self.udpsink.set_property("port", port as i32);
        *self.destination.lock().expect("lock poisoned") = (host.to_string(), port);
    }

    pub fn destination(&self) -> (String, u16) {
        self.destination.lock().expect("lock poisoned").clone()
    }

    /// SDP-Beschreibung nach RFC 3190 (`L24`-RTP-Payload)/AES67-
    /// Konformitätsstufe A — `a=ptime:1` passend zu `AES67_PTIME_NS`.
    /// Der RTP-`clock-rate` ist bei linearem PCM-Audio identisch mit der
    /// Sample-Rate (anders als bei Video, wo `St2110VideoOutput::sdp`
    /// den festen 90000Hz-RTP-Takt nutzt) — Standardkonvention, nicht
    /// node-spezifisch.
    pub fn sdp(&self) -> String {
        let (host, port) = self.destination();
        format!(
            "v=0\r\n\
             o=- 0 0 IN IP4 {host}\r\n\
             s=OpenMediaPlatform ST2110-30/AES67\r\n\
             c=IN IP4 {host}\r\n\
             t=0 0\r\n\
             m=audio {port} RTP/AVP 96\r\n\
             a=rtpmap:96 L24/{rate}/{channels}\r\n\
             a=ptime:1\r\n",
            rate = self.sample_rate,
            channels = self.channels,
        )
    }
}

impl Output for St2110AudioOutput {
    fn set_active(&self, active: bool) {
        self.valve.set_property("drop", !active);
    }

    fn is_active(&self) -> bool {
        !self.valve.property::<bool>("drop")
    }
}

impl crate::MediaFlow for St2110AudioOutput {
    fn has_flowed(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

/// Ein ST-2110-30/AES67-Empfänger: `udpsrc(caps) ! rtpjitterbuffer !
/// rtpL24depay ! audioconvert`. `tail` ist das letzte Element (gleiche
/// Konvention wie [`St2110VideoInput::tail`]).
pub struct St2110AudioInput {
    pub tail: gst::Element,
    flowed: Arc<AtomicBool>,
}

impl St2110AudioInput {
    pub fn new(
        pipeline: &gst::Pipeline,
        listen_port: u16,
        sample_rate: i32,
        channels: i32,
    ) -> Result<Self, String> {
        let rtp_caps = gst::Caps::builder("application/x-rtp")
            .field("media", "audio")
            .field("clock-rate", sample_rate)
            .field("encoding-name", "L24")
            .field("channels", channels)
            .field("payload", 96)
            .build();

        let udpsrc = gst::ElementFactory::make("udpsrc")
            .name("st2110_audio_src")
            .property("port", listen_port as i32)
            .property("caps", rtp_caps)
            .build()
            .map_err(|e| format!("udpsrc: {e}"))?;
        let jitterbuffer = gst::ElementFactory::make("rtpjitterbuffer")
            .build()
            .map_err(|e| format!("rtpjitterbuffer: {e}"))?;
        let depayloader = gst::ElementFactory::make("rtpL24depay")
            .build()
            .map_err(|e| format!("rtpL24depay: {e}"))?;
        let audioconvert = gst::ElementFactory::make("audioconvert")
            .build()
            .map_err(|e| format!("audioconvert: {e}"))?;

        pipeline
            .add(&udpsrc)
            .and_then(|()| pipeline.add(&jitterbuffer))
            .and_then(|()| pipeline.add(&depayloader))
            .and_then(|()| pipeline.add(&audioconvert))
            .map_err(|e| format!("add st2110 audio input elements: {e}"))?;

        gst::Element::link_many([&udpsrc, &jitterbuffer, &depayloader, &audioconvert])
            .map_err(|e| format!("link st2110 audio input chain: {e}"))?;

        // Gleiche Begründung wie St2110VideoInput: Probe hinter dem
        // Depayloader, nicht auf `udpsrc` (ein UDP-Paket allein beweist
        // noch keinen gültigen RTP/L24-Payload).
        let flowed = Arc::new(AtomicBool::new(false));
        let flowed_probe = flowed.clone();
        let depay_src_pad = depayloader.static_pad("src").expect("depayloader has a src pad");
        depay_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            flowed_probe.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Remove
        });

        Ok(St2110AudioInput { tail: audioconvert, flowed })
    }
}

impl crate::MediaFlow for St2110AudioInput {
    fn has_flowed(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    //! End-to-End-Loopback-Test (gleiches Muster wie `mxl.rs`s
    //! `write_then_read_loopback`, UMSETZUNG.md D4-Verifikation): sendet
    //! einige Frames über `St2110VideoOutput` per echtem UDP-Loopback
    //! (127.0.0.1) an `St2110VideoInput`, zählt angekommene Buffer.
    //! Braucht keinen externen Prozess/Dienst — reines GStreamer, anders
    //! als der `mxl`-Feature-Test kein `libmxl.so` nötig.
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    use crate::MediaFlow;
    use std::time::Duration;

    use super::*;

    const TEST_PORT: u16 = 52110;
    const WIDTH: i32 = 320;
    const HEIGHT: i32 = 240;
    const FPS_NUM: i32 = 25;
    const FPS_DEN: i32 = 1;

    #[test]
    fn write_then_read_loopback() {
        gst::init().expect("gst::init");

        let write_pipeline = gst::Pipeline::new();
        let videotestsrc = gst::ElementFactory::make("videotestsrc")
            .property("is-live", true)
            .property("num-buffers", 50i32)
            .property_from_str("pattern", "smpte")
            .build()
            .expect("videotestsrc");
        write_pipeline.add(&videotestsrc).expect("add videotestsrc");

        let output = St2110VideoOutput::new(
            &write_pipeline,
            &videotestsrc,
            "127.0.0.1",
            TEST_PORT,
            WIDTH,
            HEIGHT,
            FPS_NUM,
            FPS_DEN,
        )
        .expect("St2110VideoOutput::new");
        output.set_active(true);
        assert!(output.is_active());

        let read_pipeline = gst::Pipeline::new();
        let input = St2110VideoInput::new(&read_pipeline, TEST_PORT, WIDTH, HEIGHT, FPS_NUM, FPS_DEN)
            .expect("St2110VideoInput::new");
        let fakesink = gst::ElementFactory::make("fakesink")
            .property("sync", false)
            .build()
            .expect("fakesink");
        read_pipeline.add(&fakesink).expect("add fakesink");
        input.tail.link(&fakesink).expect("link tail to fakesink");

        let received = Arc::new(AtomicU32::new(0));
        let received_probe = received.clone();
        fakesink
            .static_pad("sink")
            .expect("fakesink sink pad")
            .add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
                received_probe.fetch_add(1, Ordering::Relaxed);
                gst::PadProbeReturn::Ok
            });

        // Empfänger zuerst starten (udpsrc muss den Port gebunden haben,
        // bevor der Sender lospaketet), dann den Sender.
        read_pipeline
            .set_state(gst::State::Playing)
            .expect("read pipeline playing");
        std::thread::sleep(Duration::from_millis(200));
        write_pipeline
            .set_state(gst::State::Playing)
            .expect("write pipeline playing");

        std::thread::sleep(Duration::from_secs(3));

        write_pipeline
            .set_state(gst::State::Null)
            .expect("write pipeline null");
        read_pipeline
            .set_state(gst::State::Null)
            .expect("read pipeline null");

        assert!(
            received.load(Ordering::Relaxed) > 0,
            "expected at least one buffer to arrive at the reader's fakesink via ST2110 UDP loopback"
        );
    }

    /// Analoger Loopback-Test für den Audio-Pfad (Kapitel 19 Teil 0) —
    /// gleiches Muster wie `write_then_read_loopback` oben, nur
    /// `audiotestsrc` statt `videotestsrc` und die L24/AES67-Kette.
    #[test]
    fn write_then_read_audio_loopback() {
        gst::init().expect("gst::init");

        const AUDIO_TEST_PORT: u16 = 52130;
        const SAMPLE_RATE: i32 = 48000;
        const CHANNELS: i32 = 2;

        let write_pipeline = gst::Pipeline::new();
        let audiotestsrc = gst::ElementFactory::make("audiotestsrc")
            .property("is-live", true)
            .property("num-buffers", 100i32)
            .build()
            .expect("audiotestsrc");
        write_pipeline.add(&audiotestsrc).expect("add audiotestsrc");

        let output = St2110AudioOutput::new(
            &write_pipeline,
            &audiotestsrc,
            "127.0.0.1",
            AUDIO_TEST_PORT,
            SAMPLE_RATE,
            CHANNELS,
        )
        .expect("St2110AudioOutput::new");
        output.set_active(true);
        assert!(output.is_active());

        let read_pipeline = gst::Pipeline::new();
        let input = St2110AudioInput::new(&read_pipeline, AUDIO_TEST_PORT, SAMPLE_RATE, CHANNELS)
            .expect("St2110AudioInput::new");
        let fakesink = gst::ElementFactory::make("fakesink")
            .property("sync", false)
            .build()
            .expect("fakesink");
        read_pipeline.add(&fakesink).expect("add fakesink");
        input.tail.link(&fakesink).expect("link tail to fakesink");

        let received = Arc::new(AtomicU32::new(0));
        let received_probe = received.clone();
        fakesink
            .static_pad("sink")
            .expect("fakesink sink pad")
            .add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
                received_probe.fetch_add(1, Ordering::Relaxed);
                gst::PadProbeReturn::Ok
            });

        read_pipeline
            .set_state(gst::State::Playing)
            .expect("read pipeline playing");
        std::thread::sleep(Duration::from_millis(200));
        write_pipeline
            .set_state(gst::State::Playing)
            .expect("write pipeline playing");

        std::thread::sleep(Duration::from_secs(3));

        write_pipeline
            .set_state(gst::State::Null)
            .expect("write pipeline null");
        read_pipeline
            .set_state(gst::State::Null)
            .expect("read pipeline null");

        assert!(
            received.load(Ordering::Relaxed) > 0,
            "expected at least one buffer to arrive at the reader's fakesink via ST2110-30/AES67 UDP loopback"
        );
        assert!(input.has_flowed(), "St2110AudioInput should report has_flowed() after real packets arrived");
    }

    /// SDP-Regressionstest: `a=ptime:1` (AES67-Konformitätsstufe A) und
    /// `L24/<rate>/<channels>` müssen exakt in dieser Form auftauchen —
    /// Fremdgeräte/-Software parsen das SDP wörtlich, kein Spielraum für
    /// Formatierungsdrift.
    #[test]
    fn audio_sdp_matches_aes67_profile_a() {
        gst::init().expect("gst::init");
        let pipeline = gst::Pipeline::new();
        let src = gst::ElementFactory::make("audiotestsrc").build().expect("audiotestsrc");
        pipeline.add(&src).expect("add audiotestsrc");
        let output = St2110AudioOutput::new(&pipeline, &src, "127.0.0.1", 52131, 48000, 2)
            .expect("St2110AudioOutput::new");
        let sdp = output.sdp();
        assert!(sdp.contains("a=rtpmap:96 L24/48000/2"), "sdp = {sdp}");
        assert!(sdp.contains("a=ptime:1"), "sdp = {sdp}");
        assert!(sdp.contains("m=audio 52131 RTP/AVP 96"), "sdp = {sdp}");
    }

    /// Echte Fremd-Gegenprobe (Kapitel 19 Teil 0 Verifikationskriterium,
    /// `docs/END-GOAL-FEATURES.md` §19.4: "Gegenprobe mit FFmpeg als
    /// Fremd-Empfänger/-Sender derselben SDP"): ein echter `ffmpeg`-
    /// Prozess sendet einen echten 1kHz-Sinuston als L24/RTP an
    /// `St2110AudioInput` — nicht nur "kommen Pakete an" (das deckt
    /// `write_then_read_audio_loopback` mit dem eigenen Sender schon ab),
    /// sondern "erkennt ein unabhängiges, standardkonformes Werkzeug
    /// dieselbe SDP/denselben Payload richtig" — der eigentliche
    /// Interop-Nachweis: `rtpjitterbuffer`/`rtpL24depay` akzeptieren und
    /// dekodieren nur echten, korrekt geformten RTP/L24-Payload — ein
    /// Format-/Caps-Mismatch würde die Pakete stillschweigend verwerfen,
    /// `has_flowed()` bliebe `false`. `#[ignore]`, weil er `ffmpeg` im
    /// PATH voraussetzt; gezielt aufrufen mit `cargo test -p
    /// omp-mediaio st2110::tests::real_ffmpeg_sends_aes67_audio --
    /// --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_ffmpeg_sends_aes67_audio() {
        gst::init().expect("gst::init");
        const PORT: u16 = 52140;
        const SAMPLE_RATE: i32 = 48000;
        const CHANNELS: i32 = 2;

        let read_pipeline = gst::Pipeline::new();
        let input =
            St2110AudioInput::new(&read_pipeline, PORT, SAMPLE_RATE, CHANNELS).expect("St2110AudioInput::new");
        let fakesink = gst::ElementFactory::make("fakesink")
            .property("sync", false)
            .build()
            .expect("fakesink");
        read_pipeline.add(&fakesink).expect("add fakesink");
        input.tail.link(&fakesink).expect("link tail -> fakesink");

        read_pipeline
            .set_state(gst::State::Playing)
            .expect("read pipeline playing");
        std::thread::sleep(Duration::from_millis(300));

        // Ein echter, unabhängiger 1kHz-Sinuston als L24/RTP, exakt der
        // Payload-Typ/das Format, das `St2110AudioOutput::sdp` auch
        // ankündigt (`-sdp_file` bewusst weggelassen: ffmpeg interpretiert
        // dort keinen "-" als stdout, sondern legt live entdeckt eine
        // gleichnamige Datei im aktuellen Arbeitsverzeichnis an — hier
        // nicht gebraucht, der Payload-Typ-Abgleich passiert bereits über
        // `audio_sdp_matches_aes67_profile_a` oben).
        let mut ffmpeg = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:sample_rate=48000:duration=3",
                "-ac",
                "2",
                "-acodec",
                "pcm_s24be",
                "-payload_type",
                "96",
                "-f",
                "rtp",
                &format!("rtp://127.0.0.1:{PORT}"),
            ])
            .spawn()
            .expect("spawn ffmpeg (im PATH?)");
        let ffmpeg_status = ffmpeg.wait().expect("wait for ffmpeg");
        assert!(ffmpeg_status.success(), "ffmpeg exited with {ffmpeg_status}");

        std::thread::sleep(Duration::from_millis(300));
        read_pipeline
            .set_state(gst::State::Null)
            .expect("read pipeline null");

        assert!(
            input.has_flowed(),
            "St2110AudioInput sollte echte, von ffmpeg gesendete L24/RTP-Pakete erfolgreich dekodiert haben"
        );
    }
}
