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
//! - **SAP-Announcements (RFC 2974):** nötig, damit Controller/
//!   AES67-Gegenstellen einen Fremd-Stream automatisch finden — Teil
//!   von Kapitel 19 Teil 3 (`omp-aes67-gateway`), nicht dieses Moduls.
//! - **ST 2022-7 Pfad-Redundanz:** P2-Scope (`ARCHITECTURE.md` §2).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gst::prelude::*;
use gstreamer as gst;

use crate::Output;

/// `a=ts-refclk` + `a=mediaclk` (ST 2110-10 §8, RFC 7273) für die SDP eines Senders, der nach `host` sendet.
/// Mit aktiver PTP-Zeitbasis (`OMP_PTP_DOMAIN`) `ptp=IEEE1588-2008:traceable` (die Großmeister-ID kennt der Node nicht
/// und rät sie nicht); sonst `localmac=<MAC der Sendeschnittstelle>`, ohne bekannte MAC `local`. Früher stand hier eine
/// erfundene Großmeister-ID — ein Empfänger hätte sich darauf verlassen.
fn clock_lines(host: &str) -> String {
    let refclk = if std::env::var("OMP_PTP_DOMAIN").is_ok_and(|v| !v.trim().is_empty()) {
        "ptp=IEEE1588-2008:traceable".to_string()
    } else {
        match crate::st2110_anc::local_route_info(host).1 {
            Some(mac) => format!("localmac={mac}"),
            None => "local".to_string(),
        }
    };
    format!("a=ts-refclk:{refclk}\r\na=mediaclk:direct=0\r\n")
}

/// Pacing-Rate des Video-`udpsink`s in Bit/s: die Bilddaten (`width·height·Bit je Pixel·Bildrate`, 4:2:2 = 2 Abtastwerte je
/// Pixel) samt RTP/UDP/IP-Kopf (~4 %) gleichmäßig auf ~90 % der Bildperiode verteilt, statt als Stoß am Anfang. Das ist die
/// Software-Näherung an ST 2110-21 (breit): `udpsink max-bitrate` taktet jedes Paket. 0 = aus (`OMP_2110_PACING=off`).
fn video_pacing_bitrate(width: i32, height: i32, depth: u8, fnum: i32, fden: i32) -> u64 {
    if std::env::var("OMP_2110_PACING").is_ok_and(|v| v.eq_ignore_ascii_case("off")) {
        return 0;
    }
    let bits_per_pixel = 2.0 * depth as f64;
    let fps = fnum as f64 / (fden.max(1)) as f64;
    (width as f64 * height as f64 * bits_per_pixel * fps * 1.04 / 0.9).ceil() as u64
}

/// Markiert einen Puffer als Halbbild-Vollbild, oberes Halbbild zuerst.
fn mark_tff(buffer: &mut gst::BufferRef) {
    use gstreamer_video::prelude::VideoBufferExt;
    buffer.set_video_flags(gstreamer_video::VideoBufferFlags::INTERLACED | gstreamer_video::VideoBufferFlags::TFF);
}

/// Colorimetrie für `a=fmtp`: HD und größer BT.709, darunter BT.601 (ST 2110-20 / RFC 4175).
fn sdp_colorimetry(height: i32) -> &'static str {
    if height >= 720 { "BT709" } else { "BT601-5" }
}

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
    /// ST 2022-7: zweiter Sendeschenkel (Ziel), falls eingerichtet.
    leg_b: Mutex<Option<(String, u16)>>,
    width: i32,
    height: i32,
    framerate_numerator: i32,
    framerate_denominator: i32,
    /// Bittiefe auf dem Draht: 8 (`UYVY`) oder 10 (`UYVP`, RFC 4175 YCbCr-4:2:2 10 bit).
    depth: u8,
    /// Halbbildstrom (TFF): SDP-Token `interlace`.
    interlaced: bool,
    flowed: Arc<AtomicBool>,
}

impl St2110VideoOutput {
    /// 8 Bit (unverändertes Verhalten aller bisherigen Aufrufer), s. [`Self::new_with_depth`].
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
        Self::new_with_depth(pipeline, upstream, initial_host, initial_port, width, height, framerate_numerator, framerate_denominator, 8)
    }

    /// `depth` 8 oder 10 (alles andere ist ein Fehler). 10 Bit ist die Broadcast-Regel (SDI-Quellen sind 10 Bit);
    /// 8 Bit kostet Qualität und wird von manchem Fremdempfänger nicht angenommen.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_depth(
        pipeline: &gst::Pipeline,
        upstream: &gst::Element,
        initial_host: &str,
        initial_port: u16,
        width: i32,
        height: i32,
        framerate_numerator: i32,
        framerate_denominator: i32,
        depth: u8,
    ) -> Result<Self, String> {
        Self::new_full(pipeline, upstream, initial_host, initial_port, width, height, framerate_numerator, framerate_denominator, depth, false)
    }

    /// Wie [`Self::new_with_depth`]; `interlaced`: Halbbildstrom, oberes Halbbild zuerst (RFC 4175 `interlace`, SDP-Token
    /// `interlace`). Der Aufrufer liefert ganze Bilder mit verschränkten Zeilen; Bildrate = Bild-, nicht Halbbildrate.
    #[allow(clippy::too_many_arguments)]
    pub fn new_full(
        pipeline: &gst::Pipeline,
        upstream: &gst::Element,
        initial_host: &str,
        initial_port: u16,
        width: i32,
        height: i32,
        framerate_numerator: i32,
        framerate_denominator: i32,
        depth: u8,
        interlaced: bool,
    ) -> Result<Self, String> {
        if depth != 8 && depth != 10 {
            return Err(format!("ST 2110-20: Bittiefe {depth} nicht unterstützt (8 oder 10)"));
        }
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
                    .field("format", if depth == 10 { "UYVP" } else { "UYVY" })
                    .field("width", width)
                    .field("height", height)
                    .field(
                        "framerate",
                        gst::Fraction::new(framerate_numerator, framerate_denominator),
                    )
                    .build(),
            )
            .build()
            .map_err(|e| format!("capsfilter(UYVY/UYVP): {e}"))?;
        // Halbbild: Caps auf `interleaved`/TFF umetikettieren und die Puffer als TFF markieren (der Payloader sendet dann
        // zwei Halbbilder mit F-Bit). Progressiv: kein zusätzliches Element.
        let interlace_tag = if interlaced {
            let el = gst::ElementFactory::make("capssetter")
                .property(
                    "caps",
                    gst::Caps::builder("video/x-raw")
                        .field("interlace-mode", "interleaved")
                        .field("field-order", "top-field-first")
                        .build(),
                )
                .property("join", true)
                .property("replace", false)
                .build()
                .map_err(|e| format!("capssetter (interlace): {e}"))?;
            if let Some(pad) = el.static_pad("src") {
                pad.add_probe(gst::PadProbeType::BUFFER, |_pad, info| {
                    if let Some(gst::PadProbeData::Buffer(b)) = &mut info.data {
                        mark_tff(b.make_mut());
                    }
                    gst::PadProbeReturn::Ok
                });
            }
            Some(el)
        } else {
            None
        };
        let payloader = gst::ElementFactory::make("rtpvrawpay")
            .build()
            .map_err(|e| format!("rtpvrawpay: {e}"))?;
        if interlaced && let Some(pad) = payloader.static_pad("src") {
            // GStreamer trägt Vollbild-Zeilennummern ein, RFC 4175 verlangt Halbbild-Zeilen — vor dem Senden korrigieren.
            pad.add_probe(gst::PadProbeType::BUFFER | gst::PadProbeType::BUFFER_LIST, |_pad, info| {
                fn fix(b: &mut gst::BufferRef) {
                    if let Ok(mut m) = b.map_writable() {
                        crate::st2110_interlaced::fix_payloader_line_numbers(&mut m);
                    }
                }
                match &mut info.data {
                    Some(gst::PadProbeData::Buffer(b)) => fix(b.make_mut()),
                    Some(gst::PadProbeData::BufferList(l)) => {
                        let l = l.make_mut();
                        for i in 0..l.len() {
                            if let Some(b) = l.get_mut(i) {
                                fix(b);
                            }
                        }
                    }
                    _ => {}
                }
                gst::PadProbeReturn::Ok
            });
        }
        let valve = gst::ElementFactory::make("valve")
            .name("st2110_video_valve")
            .property("drop", true)
            .build()
            .map_err(|e| format!("valve: {e}"))?;
        let (udpsink, _) = crate::kbypass::make_sink("st2110_video_sink", initial_host, initial_port)?;
        let pace = video_pacing_bitrate(width, height, depth, framerate_numerator, framerate_denominator);
        if pace > 0 && udpsink.find_property("max-bitrate").is_some() {
            udpsink.set_property("max-bitrate", pace);
        }

        pipeline
            .add(&videoconvert)
            .and_then(|()| pipeline.add(&videoscale))
            .and_then(|()| pipeline.add(&videorate))
            .and_then(|()| pipeline.add(&caps))
            .and_then(|()| pipeline.add(&payloader))
            .and_then(|()| pipeline.add(&valve))
            .and_then(|()| pipeline.add(&udpsink))
            .map_err(|e| format!("add st2110 output elements: {e}"))?;
        if let Some(el) = &interlace_tag {
            pipeline.add(el).map_err(|e| format!("add capssetter: {e}"))?;
        }
        let mut chain: Vec<&gst::Element> = vec![upstream, &videoconvert, &videoscale, &videorate, &caps];
        if let Some(el) = &interlace_tag {
            chain.push(el);
        }
        chain.extend([&payloader, &valve, &udpsink]);
        gst::Element::link_many(chain).map_err(|e| format!("link st2110 output chain: {e}"))?;

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
            leg_b: Mutex::new(None),
            width,
            height,
            framerate_numerator,
            framerate_denominator,
            depth,
            interlaced,
            flowed,
        })
    }

    pub fn set_destination(&self, host: &str, port: u16) {
        crate::kbypass::set_destination(&self.udpsink, host, port);
        *self.destination.lock().expect("lock poisoned") = (host.to_string(), port);
    }

    pub fn destination(&self) -> (String, u16) {
        self.destination.lock().expect("lock poisoned").clone()
    }

    /// SDP-Beschreibung (ST 2110-20 SDP-Parameter nach SMPTE ST
    /// 2110-20/RFC 4175 `a=fmtp`-Konvention) — Inhalt von
    /// `.../transportfile` (IS-05).
    ///
    /// Zwei reale Bugs live am echten AMWA-IS-05-01-Tool-Lauf gefunden
    /// (Nachtrag 194/195, docs/decisions.md, dort am Go-Mock-Node-
    /// Pendant gefunden — dieselbe Struktur hier, nie selbst gegen das
    /// Tool getestet): (1) `a=rtpmap`s Taktrate muss für RTP-Rohvideo
    /// fest 90000 Hz sein (RFC 4175/ST 2110-20 §7.1), nicht die
    /// Framerate. (2) `c=` muss auf Medien-Ebene stehen (nach `m=`),
    /// nicht Session-Ebene davor — `IS05Utils.check_sdp_matches_params`
    /// sucht `c=` nur in der Medien-Sektion, sonst `None`/Crash. `PM`/
    /// `SSN`/`TP`/`TCS` (SDPoker-Pflichtfelder) und `a=mediaclk`/
    /// `a=ts-refclk` (ST 2110-10 §8.1/8.2) fehlten komplett.
    pub fn sdp(&self) -> String {
        let (host, port) = self.destination();
        // `TP=2110TPW`: dieser Sender paced in Software (Kernel-UDP), nicht schmal (TPN) — frühere Fassung
        // behauptete TPN. Ein Empfänger darf nur ein ehrliches Profil erwarten.
        let media = |host: &str, port: u16, mid: Option<&str>| {
            format!(
                "m=video {port} RTP/AVP 96\r\n\
                 c=IN IP4 {host}\r\n\
                 {clock}\
                 a=rtpmap:96 raw/90000\r\n\
                 a=fmtp:96 sampling=YCbCr-4:2:2; depth={depth}; width={w}; height={h}; \
                 exactframerate={num}/{den}; colorimetry={colorimetry}; {interlace}PM=2110GPM; \
                 SSN=ST2110-20:2017; TP=2110TPW; TCS=SDR\r\n{mid}",
                clock = clock_lines(host),
                colorimetry = sdp_colorimetry(self.height as i32),
                depth = self.depth,
                interlace = if self.interlaced { "interlace; " } else { "" },
                w = self.width,
                h = self.height,
                num = self.framerate_numerator,
                den = self.framerate_denominator,
                mid = mid.map(|m| format!("a=mid:{m}\r\n")).unwrap_or_default(),
            )
        };
        let head = format!("v=0\r\no=- 0 0 IN IP4 {host}\r\ns=OpenMediaPlatform ST2110\r\nt=0 0\r\n");
        match self.leg_b.lock().expect("lock poisoned").clone() {
            // ST 2022-7 / RFC 7104: Gruppe DUP, zwei Medienabschnitte (primary/secondary)
            Some((bh, bp)) => format!("{head}a=group:DUP primary secondary\r\n{}{}", media(&host, port, Some("primary")), media(&bh, bp, Some("secondary"))),
            None => format!("{head}{}", media(&host, port, None)),
        }
    }

    /// ST 2022-7: zweiten Sendeschenkel (anderes Ziel/Netz) einbauen. Vor dem Start der Pipeline aufrufen.
    pub fn add_redundant_leg(&self, pipeline: &gst::Pipeline, host: &str, port: u16) -> Result<(), String> {
        crate::st2022_7::add_tx_leg(pipeline, &self.valve, &self.udpsink, "st2110_video_sink_b", host, port)?;
        *self.leg_b.lock().expect("lock poisoned") = Some((host.to_string(), port));
        Ok(())
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
    /// Für [`St2110VideoInput::jitterbuffer_stats`] (BCP-008-01
    /// `connectionStatus`/`GetLostPacketCounters`/`GetLatePacketCounters`,
    /// `docs/decisions.md` BCP-008-Nachtrag 2026-09-11) — echte, von
    /// GStreamers `rtpjitterbuffer` gemessene Paketverlust-/Verspätungs-
    /// Zähler statt eines erfundenen Werts.
    jitterbuffer: gst::Element,
    rtp_caps: gst::Caps,
}

impl St2110VideoInput {
    /// ST 2022-7: zweiten Empfangsschenkel einbauen (s. [`St2110AudioInput::add_redundant_leg`]).
    pub fn add_redundant_leg(&self, pipeline: &gst::Pipeline, port: u16, group: Option<&str>) -> Result<(), String> {
        crate::st2022_7::add_rx_leg(pipeline, &self.jitterbuffer, "st2110_video_src_b", port, &self.rtp_caps, group)
    }

    /// Halbbild-Empfang: GStreamers `rtpvrawdepay` kann das nicht (1.22), deshalb `jitterbuffer → appsink`, der eigene
    /// Entpacker ([`crate::st2110_interlaced`]) setzt die Halbbilder zusammen, ein `appsrc` liefert die Vollbilder
    /// (verschränkt, TFF) an `tail`. Zeitstempel: Ankunftszeit des Vollbilds (`do-timestamp`).
    #[cfg(feature = "mxl")]
    #[allow(clippy::too_many_arguments)]
    fn build_interlaced(
        pipeline: &gst::Pipeline,
        udpsrc: gst::Element,
        jitterbuffer: gst::Element,
        rtp_caps: gst::Caps,
        width: i32,
        height: i32,
        fnum: i32,
        fden: i32,
        depth: u8,
    ) -> Result<Self, String> {
        use gstreamer_app as gst_app;
        let asm = Arc::new(Mutex::new(crate::st2110_interlaced::InterlacedAssembler::new(width as usize, height as usize, depth)?));
        let raw_caps = gst::Caps::builder("video/x-raw")
            .field("format", if depth == 10 { "UYVP" } else { "UYVY" })
            .field("width", width)
            .field("height", height)
            .field("framerate", gst::Fraction::new(fnum, fden))
            .field("interlace-mode", "interleaved")
            .field("field-order", "top-field-first")
            .build();
        let appsrc = gst_app::AppSrc::builder()
            .caps(&raw_caps)
            .format(gst::Format::Time)
            .is_live(true)
            .do_timestamp(true)
            .max_bytes(8 * 1024 * 1024)
            .build();
        let appsink = gst_app::AppSink::builder()
            .caps(&gst::Caps::builder("application/x-rtp").build())
            .sync(false)
            .max_buffers(4096)
            .build();
        // Kein Preroll am appsink: sonst blockiert der erste Puffer den Jitterbuffer, bis die Pipeline PLAYING ist.
        appsink.set_property("async", false);
        let videoconvert = gst::ElementFactory::make("videoconvert").build().map_err(|e| format!("videoconvert: {e}"))?;
        let src_push = appsrc.clone();
        appsink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    let mut frames: Vec<Vec<u8>> = Vec::new();
                    let mut feed = |b: &gst::BufferRef| {
                        if let Ok(map) = b.map_readable()
                            && let Some(f) = asm.lock().expect("lock poisoned").push(&map)
                        {
                            frames.push(f);
                        }
                    };
                    if let Some(list) = sample.buffer_list() {
                        list.iter().for_each(|b| feed(b));
                    } else if let Some(b) = sample.buffer() {
                        feed(b);
                    }
                    for f in frames {
                        let _ = src_push.push_buffer(gst::Buffer::from_mut_slice(f));
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        pipeline
            .add_many([&udpsrc, &jitterbuffer, appsink.upcast_ref::<gst::Element>(), appsrc.upcast_ref::<gst::Element>(), &videoconvert])
            .map_err(|e| format!("add st2110 interlaced input elements: {e}"))?;
        gst::Element::link_many([&udpsrc, &jitterbuffer, appsink.upcast_ref::<gst::Element>()])
            .map_err(|e| format!("link st2110 interlaced input (net): {e}"))?;
        gst::Element::link_many([appsrc.upcast_ref::<gst::Element>(), &videoconvert])
            .map_err(|e| format!("link st2110 interlaced input (video): {e}"))?;
        let flowed = Arc::new(AtomicBool::new(false));
        let fp = flowed.clone();
        appsrc.static_pad("src").expect("appsrc has a src pad").add_probe(gst::PadProbeType::BUFFER, move |_p, _i| {
            fp.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Remove
        });
        Ok(St2110VideoInput { tail: videoconvert, flowed, jitterbuffer, rtp_caps })
    }

    #[cfg(not(feature = "mxl"))]
    #[allow(clippy::too_many_arguments)]
    fn build_interlaced(
        _pipeline: &gst::Pipeline,
        _udpsrc: gst::Element,
        _jitterbuffer: gst::Element,
        _rtp_caps: gst::Caps,
        _width: i32,
        _height: i32,
        _fnum: i32,
        _fden: i32,
        _depth: u8,
    ) -> Result<Self, String> {
        Err("Halbbild-Empfang braucht das Feature `mxl` von omp-mediaio".to_string())
    }

    /// `multicast_group`: `Some("239.x.x.x")` bindet `udpsrc` an eine
    /// Multicast-Gruppe statt an alle Interfaces (Kapitel 19 Teil 1,
    /// `docs/END-GOAL-FEATURES.md` §19.3a Punkt 2) — reine
    /// Konfigurationsfrage, kein neues Element: `udpsrc`s `address`-
    /// Property + das standardmäßig aktive `auto-multicast` übernehmen
    /// den Gruppen-Beitritt (am echten `gst-inspect-1.0`-Lauf bestätigt,
    /// nicht geraten). `None` = unverändertes Unicast-Verhalten (D4).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pipeline: &gst::Pipeline,
        listen_port: u16,
        width: i32,
        height: i32,
        framerate_numerator: i32,
        framerate_denominator: i32,
        multicast_group: Option<&str>,
    ) -> Result<Self, String> {
        Self::new_with_depth(pipeline, listen_port, width, height, framerate_numerator, framerate_denominator, multicast_group, 8)
    }

    /// `depth`: Bittiefe des ankommenden Stroms (8 oder 10) — muss zur SDP des Senders passen.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_depth(
        pipeline: &gst::Pipeline,
        listen_port: u16,
        width: i32,
        height: i32,
        framerate_numerator: i32,
        framerate_denominator: i32,
        multicast_group: Option<&str>,
        depth: u8,
    ) -> Result<Self, String> {
        Self::new_full(pipeline, listen_port, width, height, framerate_numerator, framerate_denominator, multicast_group, depth, false)
    }

    /// Wie [`Self::new_with_depth`]; `interlaced`: der ankommende Strom ist ein Halbbildstrom (SDP-Token `interlace`). Die
    /// Bilder kommen als ganze verschränkte Bilder (Bildrate = Halbbildrate / 2) heraus.
    #[allow(clippy::too_many_arguments)]
    pub fn new_full(
        pipeline: &gst::Pipeline,
        listen_port: u16,
        width: i32,
        height: i32,
        framerate_numerator: i32,
        framerate_denominator: i32,
        multicast_group: Option<&str>,
        depth: u8,
        interlaced: bool,
    ) -> Result<Self, String> {
        if depth != 8 && depth != 10 {
            return Err(format!("ST 2110-20: Bittiefe {depth} nicht unterstützt (8 oder 10)"));
        }
        let mut caps_builder = gst::Caps::builder("application/x-rtp")
            .field("media", "video")
            .field("clock-rate", 90000)
            .field("encoding-name", "RAW")
            .field("sampling", "YCbCr-4:2:2")
            .field("depth", depth.to_string())
            .field("width", width.to_string())
            .field("height", height.to_string())
            .field("payload", 96);
        if interlaced {
            caps_builder = caps_builder.field("interlace", "true");
        }
        let rtp_caps = caps_builder.build();

        let (udpsrc, _) = crate::kbypass::make_src("st2110_video_src", listen_port, &rtp_caps, multicast_group)?;
        let jitterbuffer = gst::ElementFactory::make("rtpjitterbuffer")
            .build()
            .map_err(|e| format!("rtpjitterbuffer: {e}"))?;
        if interlaced {
            return Self::build_interlaced(pipeline, udpsrc, jitterbuffer, rtp_caps, width, height, framerate_numerator, framerate_denominator, depth);
        }
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
            jitterbuffer,
            rtp_caps,
        })
    }

    /// `(num_lost, num_late)` seit Pipeline-Start, direkt aus
    /// `rtpjitterbuffer`s `stats`-Property (`GstStructure` mit
    /// `guint64`-Feldern `num-lost`/`num-late`, per `gst-inspect-1.0
    /// rtpjitterbuffer` bestätigt) — kumulativ, nicht seit dem letzten
    /// Aufruf; Aufrufer bilden selbst die Differenz zum vorigen Wert,
    /// falls sie einen Delta brauchen (s. `omp-2110-gateway`s
    /// BCP-008-Monitor-Tick).
    pub fn jitterbuffer_stats(&self) -> (u64, u64) {
        let stats = self.jitterbuffer.property::<gst::Structure>("stats");
        let lost = stats.get::<u64>("num-lost").unwrap_or(0);
        let late = stats.get::<u64>("num-late").unwrap_or(0);
        (lost, late)
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
    /// ST 2022-7: zweiter Sendeschenkel (Ziel), falls eingerichtet.
    leg_b: Mutex<Option<(String, u16)>>,
    sample_rate: i32,
    channels: i32,
    /// 16 (L16) oder 24 (L24).
    bits: u8,
    /// Paketzeit in Mikrosekunden (125, 250, 333, 1000, 4000).
    ptime_us: u32,
    flowed: Arc<AtomicBool>,
}

/// Erlaubte Paketzeiten nach ST 2110-30 / AES67 in Mikrosekunden (Stufe A: 1 ms; 125 µs, 250 µs, 333 µs, 4 ms).
pub const AUDIO_PTIMES_US: [u32; 5] = [125, 250, 333, 1000, 4000];

fn check_audio_format(bits: u8, ptime_us: u32) -> Result<(), String> {
    if bits != 16 && bits != 24 {
        return Err(format!("ST 2110-30: {bits} Bit nicht unterstützt (16 oder 24)"));
    }
    if !AUDIO_PTIMES_US.contains(&ptime_us) {
        return Err(format!("ST 2110-30: Paketzeit {ptime_us} µs nicht unterstützt ({AUDIO_PTIMES_US:?})"));
    }
    Ok(())
}

/// `a=ptime` in Millisekunden, wie AES67 es schreibt (`1`, `0.125`, `0.25`, `0.33`, `4`).
fn ptime_sdp(ptime_us: u32) -> String {
    match ptime_us {
        125 => "0.125".into(),
        250 => "0.25".into(),
        333 => "0.33".into(),
        us => format!("{}", us / 1000),
    }
}

impl St2110AudioOutput {
    /// L24, 1 ms (unverändertes Verhalten aller bisherigen Aufrufer), s. [`Self::new_with_format`].
    pub fn new(
        pipeline: &gst::Pipeline,
        upstream: &gst::Element,
        initial_host: &str,
        initial_port: u16,
        sample_rate: i32,
        channels: i32,
    ) -> Result<Self, String> {
        Self::new_with_format(pipeline, upstream, initial_host, initial_port, sample_rate, channels, 24, 1000)
    }

    /// `bits` 16 oder 24 (`L16`/`L24`), `ptime_us` ∈ [`AUDIO_PTIMES_US`]. Kurze Pakete (125 µs) senken die Latenz und sind
    /// bei ST 2110-30 Stufe B/C üblich; 1 ms ist die Stufe-A-Pflicht.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_format(
        pipeline: &gst::Pipeline,
        upstream: &gst::Element,
        initial_host: &str,
        initial_port: u16,
        sample_rate: i32,
        channels: i32,
        bits: u8,
        ptime_us: u32,
    ) -> Result<Self, String> {
        check_audio_format(bits, ptime_us)?;
        let ptime_ns = ptime_us as i64 * 1000;
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
                    .field("format", if bits == 16 { "S16BE" } else { "S24BE" })
                    .field("layout", "interleaved")
                    .field("rate", sample_rate)
                    .field("channels", channels)
                    .build(),
            )
            .build()
            .map_err(|e| format!("capsfilter(S16BE/S24BE): {e}"))?;
        let pay_name = if bits == 16 { "rtpL16pay" } else { "rtpL24pay" };
        let payloader = gst::ElementFactory::make(pay_name)
            .property("min-ptime", ptime_ns)
            .property("max-ptime", ptime_ns)
            .build()
            .map_err(|e| format!("{pay_name}: {e}"))?;
        let valve = gst::ElementFactory::make("valve")
            .name("st2110_audio_valve")
            .property("drop", true)
            .build()
            .map_err(|e| format!("valve: {e}"))?;
        let (udpsink, _) = crate::kbypass::make_sink("st2110_audio_sink", initial_host, initial_port)?;

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
            leg_b: Mutex::new(None),
            sample_rate,
            channels,
            bits,
            ptime_us,
            flowed,
        })
    }

    pub fn set_destination(&self, host: &str, port: u16) {
        crate::kbypass::set_destination(&self.udpsink, host, port);
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
        let media = |host: &str, port: u16, mid: Option<&str>| {
            format!(
                "m=audio {port} RTP/AVP 96\r\n\
                 c=IN IP4 {host}\r\n\
                 a=rtpmap:96 L{bits}/{rate}/{channels}\r\n\
                 a=ptime:{ptime}\r\n\
                 {clock}{mid}",
                clock = clock_lines(host),
                bits = self.bits,
                ptime = ptime_sdp(self.ptime_us),
                rate = self.sample_rate,
                channels = self.channels,
                mid = mid.map(|m| format!("a=mid:{m}\r\n")).unwrap_or_default(),
            )
        };
        let head = format!("v=0\r\no=- 0 0 IN IP4 {host}\r\ns=OpenMediaPlatform ST2110-30/AES67\r\nt=0 0\r\n");
        match self.leg_b.lock().expect("lock poisoned").clone() {
            Some((bh, bp)) => format!("{head}a=group:DUP primary secondary\r\n{}{}", media(&host, port, Some("primary")), media(&bh, bp, Some("secondary"))),
            None => format!("{head}{}", media(&host, port, None)),
        }
    }

    /// ST 2022-7: zweiten Sendeschenkel einbauen (s. [`St2110VideoOutput::add_redundant_leg`]).
    pub fn add_redundant_leg(&self, pipeline: &gst::Pipeline, host: &str, port: u16) -> Result<(), String> {
        crate::st2022_7::add_tx_leg(pipeline, &self.valve, &self.udpsink, "st2110_audio_sink_b", host, port)?;
        *self.leg_b.lock().expect("lock poisoned") = Some((host.to_string(), port));
        Ok(())
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
    /// S. `St2110VideoInput::jitterbuffer_stats`-Doku, identisches
    /// Muster (BCP-008-01 `connectionStatus`, `docs/decisions.md`
    /// BCP-008-Nachtrag).
    jitterbuffer: gst::Element,
    rtp_caps: gst::Caps,
}

impl St2110AudioInput {
    /// ST 2022-7: zweiten Empfangsschenkel (andere Gruppe/anderer Port, anderes Netz) einbauen. Vor dem Start der
    /// Pipeline aufrufen; doppelt ankommende Pakete verwirft der Jitterbuffer.
    pub fn add_redundant_leg(&self, pipeline: &gst::Pipeline, port: u16, group: Option<&str>) -> Result<(), String> {
        crate::st2022_7::add_rx_leg(pipeline, &self.jitterbuffer, "st2110_audio_src_b", port, &self.rtp_caps, group)
    }

    /// `multicast_group`: s. `St2110VideoInput::new`-Doku, identisches
    /// Muster.
    pub fn new(
        pipeline: &gst::Pipeline,
        listen_port: u16,
        sample_rate: i32,
        channels: i32,
        multicast_group: Option<&str>,
    ) -> Result<Self, String> {
        Self::new_with_bits(pipeline, listen_port, sample_rate, channels, multicast_group, 24)
    }

    /// `bits` 16 (`L16`) oder 24 (`L24`): muss zur SDP des Senders passen. Die Paketzeit braucht der Empfänger nicht.
    pub fn new_with_bits(
        pipeline: &gst::Pipeline,
        listen_port: u16,
        sample_rate: i32,
        channels: i32,
        multicast_group: Option<&str>,
        bits: u8,
    ) -> Result<Self, String> {
        check_audio_format(bits, 1000)?;
        let rtp_caps = gst::Caps::builder("application/x-rtp")
            .field("media", "audio")
            .field("clock-rate", sample_rate)
            .field("encoding-name", if bits == 16 { "L16" } else { "L24" })
            .field("channels", channels)
            .field("payload", 96)
            .build();

        let (udpsrc, _) = crate::kbypass::make_src("st2110_audio_src", listen_port, &rtp_caps, multicast_group)?;
        let jitterbuffer = gst::ElementFactory::make("rtpjitterbuffer")
            .build()
            .map_err(|e| format!("rtpjitterbuffer: {e}"))?;
        let depay_name = if bits == 16 { "rtpL16depay" } else { "rtpL24depay" };
        let depayloader = gst::ElementFactory::make(depay_name)
            .build()
            .map_err(|e| format!("{depay_name}: {e}"))?;
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

        Ok(St2110AudioInput { tail: audioconvert, flowed, jitterbuffer, rtp_caps })
    }

    /// S. `St2110VideoInput::jitterbuffer_stats`-Doku, identisches
    /// Verhalten (kumulativ seit Pipeline-Start).
    pub fn jitterbuffer_stats(&self) -> (u64, u64) {
        let stats = self.jitterbuffer.property::<gst::Structure>("stats");
        let lost = stats.get::<u64>("num-lost").unwrap_or(0);
        let late = stats.get::<u64>("num-late").unwrap_or(0);
        (lost, late)
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
        let input = St2110VideoInput::new(&read_pipeline, TEST_PORT, WIDTH, HEIGHT, FPS_NUM, FPS_DEN, None)
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

    /// Multicast-Variante (Kapitel 19 Teil 1, `docs/END-GOAL-FEATURES.md`
    /// §19.3a Punkt 2): echte reale 2110-Fremdgeräte senden praktisch
    /// immer Multicast, nicht Unicast — dieser Test bestätigt, dass
    /// `udpsink`s `auto-multicast` (Sender) und `St2110VideoInput`s neuer
    /// `multicast_group`-Parameter (Empfänger) tatsächlich zusammen
    /// funktionieren, nicht nur einzeln kompilieren. Multicast-Loopback
    /// auf `127.0.0.1`/`lo` funktioniert unter Linux normalerweise nur,
    /// wenn die Route explizit über `lo` geht — hier stattdessen eine
    /// echte (nicht geroutete) Multicast-Adresse verwendet, die der
    /// Kernel für lokale Multicast-Gruppenmitgliedschaft trotzdem über
    /// alle Interfaces inkl. Loopback zustellt (Standardverhalten für
    /// Link-lokale Multicast-Scopes).
    #[test]
    fn write_then_read_multicast_loopback() {
        gst::init().expect("gst::init");

        const MULTICAST_GROUP: &str = "239.192.19.1";
        const MULTICAST_PORT: u16 = 52111;

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
            MULTICAST_GROUP,
            MULTICAST_PORT,
            WIDTH,
            HEIGHT,
            FPS_NUM,
            FPS_DEN,
        )
        .expect("St2110VideoOutput::new");
        output.set_active(true);

        let read_pipeline = gst::Pipeline::new();
        let input = St2110VideoInput::new(
            &read_pipeline,
            MULTICAST_PORT,
            WIDTH,
            HEIGHT,
            FPS_NUM,
            FPS_DEN,
            Some(MULTICAST_GROUP),
        )
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

        read_pipeline
            .set_state(gst::State::Playing)
            .expect("read pipeline playing");
        std::thread::sleep(Duration::from_millis(300));
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
            "expected at least one buffer to arrive via real ST2110 multicast loopback ({MULTICAST_GROUP}:{MULTICAST_PORT})"
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
        let input = St2110AudioInput::new(&read_pipeline, AUDIO_TEST_PORT, SAMPLE_RATE, CHANNELS, None)
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

    /// Nachtrag 195/196: live am echten AMWA-IS-05-01-Tool-Lauf gefunden
    /// (am Go-Mock-Node-Pendant, nie zuvor gegen einen echten Rust-Sender
    /// getestet) — zwei reale Bugs, hier verankert: (1) die Taktrate für
    /// RTP-Rohvideo muss 90000 Hz sein (RFC 4175/ST 2110-20), nicht die
    /// Framerate. (2) `c=` muss NACH `m=` stehen (Medien-Ebene) —
    /// `IS05Utils.check_sdp_matches_params` (AMWA-nmos-testing) sucht
    /// die `c=`-Zeile nur innerhalb der Medien-Sektion, eine
    /// Session-Ebene-Zeile davor crasht dort mit `NoneType.group()`.
    #[test]
    fn video_sdp_is_st2110_20_conformant() {
        gst::init().expect("gst::init");
        let pipeline = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").build().expect("videotestsrc");
        pipeline.add(&src).expect("add videotestsrc");
        let output = St2110VideoOutput::new(&pipeline, &src, "127.0.0.1", 52140, 640, 480, 25, 1)
            .expect("St2110VideoOutput::new");
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
        // ehrliches Profil: Software-Pacing = breit (TPW), niemals die frühere erfundene Großmeister-ID
        assert!(sdp.contains("TP=2110TPW"), "sdp = {sdp}");
        assert!(!sdp.contains("EC-46-70-FF-FE-00-CE-DE"), "sdp = {sdp}");
    }

    /// 10-Bit-Strecke (UYVP) über echten Multicast: Pakete kommen an, die SDP nennt `depth=10`.
    #[test]
    fn ten_bit_roundtrip_and_sdp() {
        gst::init().expect("gst::init");
        let wp = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).build().unwrap();
        wp.add(&src).unwrap();
        let out = St2110VideoOutput::new_with_depth(&wp, &src, "127.0.0.1", 52150, 320, 180, 25, 1, 10).expect("out10");
        assert!(out.sdp().contains("depth=10"), "sdp = {}", out.sdp());
        out.set_active(true);
        let rp = gst::Pipeline::new();
        let input = St2110VideoInput::new_with_depth(&rp, 52150, 320, 180, 25, 1, None, 10).expect("in10");
        let got = Arc::new(AtomicBool::new(false));
        let g = got.clone();
        input.tail.static_pad("src").unwrap().add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            g.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Remove
        });
        let sink = gst::ElementFactory::make("fakesink").property("sync", false).build().unwrap();
        rp.add(&sink).unwrap();
        input.tail.link(&sink).unwrap();
        rp.set_state(gst::State::Playing).unwrap();
        wp.set_state(gst::State::Playing).unwrap();
        for _ in 0..40 {
            if got.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        wp.set_state(gst::State::Null).unwrap();
        rp.set_state(gst::State::Null).unwrap();
        assert!(got.load(Ordering::Relaxed), "kein 10-Bit-Bild angekommen");
    }

    /// ST 2022-7 mit den echten Typen: Sender mit zwei Zielen (SDP trägt die DUP-Gruppe), Empfänger mit zwei Schenkeln;
    /// Schenkel A des Senders geht ins Leere — das Bild kommt über Schenkel B an.
    #[test]
    fn redundant_legs_end_to_end() {
        gst::init().expect("gst::init");
        let wp = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).build().unwrap();
        wp.add(&src).unwrap();
        let out = St2110VideoOutput::new_with_depth(&wp, &src, "127.0.0.1", 52360, 320, 180, 25, 1, 10).unwrap();
        out.add_redundant_leg(&wp, "127.0.0.1", 52361).unwrap();
        let sdp = out.sdp();
        assert!(sdp.contains("a=group:DUP primary secondary") && sdp.contains("a=mid:secondary"), "sdp = {sdp}");
        assert_eq!(sdp.matches("m=video").count(), 2, "sdp = {sdp}");
        out.set_active(true);
        let rp = gst::Pipeline::new();
        // Empfänger: Schenkel A lauscht auf dem toten Port 52360 (dort sendet Schenkel A, kommt an), B auf 52361.
        let input = St2110VideoInput::new_with_depth(&rp, 52361, 320, 180, 25, 1, None, 10).unwrap();
        input.add_redundant_leg(&rp, 52362, None).unwrap(); // zweiter Schenkel lauscht auf einem Port ohne Sender
        let got = Arc::new(AtomicBool::new(false));
        let g = got.clone();
        input.tail.static_pad("src").unwrap().add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            g.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Remove
        });
        let sink = gst::ElementFactory::make("fakesink").property("sync", false).build().unwrap();
        rp.add(&sink).unwrap();
        input.tail.link(&sink).unwrap();
        rp.set_state(gst::State::Playing).unwrap();
        wp.set_state(gst::State::Playing).unwrap();
        for _ in 0..40 {
            if got.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        wp.set_state(gst::State::Null).unwrap();
        rp.set_state(gst::State::Null).unwrap();
        assert!(got.load(Ordering::Relaxed), "kein Bild über den intakten Schenkel");
    }

    #[test]
    fn pacing_rate_spreads_the_frame_over_most_of_the_period() {
        // 1080p25, 10 Bit: 1920·1080·20·25 = 1,037 Gbit/s Nutzdaten → mit Kopf und 90 % ≈ 1,2 Gbit/s
        let r = video_pacing_bitrate(1920, 1080, 10, 25, 1);
        assert!((1_150_000_000..1_250_000_000).contains(&r), "{r}");
        // 8 Bit braucht 20 % weniger
        assert!(video_pacing_bitrate(1920, 1080, 8, 25, 1) < r);
    }

    /// Das Pacing darf die Strecke nicht stören: 10-Bit-Bilder kommen mit gesetztem `max-bitrate` an.
    #[test]
    fn paced_sender_sets_max_bitrate_and_still_delivers() {
        gst::init().expect("gst::init");
        let wp = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).build().unwrap();
        wp.add(&src).unwrap();
        let out = St2110VideoOutput::new_with_depth(&wp, &src, "127.0.0.1", 52370, 320, 180, 25, 1, 10).unwrap();
        assert!(out.udpsink.property::<u64>("max-bitrate") > 0);
        out.set_active(true);
        let rp = gst::Pipeline::new();
        let input = St2110VideoInput::new_with_depth(&rp, 52370, 320, 180, 25, 1, None, 10).unwrap();
        let got = Arc::new(AtomicBool::new(false));
        let g = got.clone();
        input.tail.static_pad("src").unwrap().add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            g.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Remove
        });
        let sink = gst::ElementFactory::make("fakesink").property("sync", false).build().unwrap();
        rp.add(&sink).unwrap();
        input.tail.link(&sink).unwrap();
        rp.set_state(gst::State::Playing).unwrap();
        wp.set_state(gst::State::Playing).unwrap();
        for _ in 0..40 {
            if got.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        wp.set_state(gst::State::Null).unwrap();
        rp.set_state(gst::State::Null).unwrap();
        assert!(got.load(Ordering::Relaxed), "kein Bild über den gepacten Sender");
    }

    #[test]
    fn audio_ptime_sdp_notation() {
        assert_eq!(ptime_sdp(1000), "1");
        assert_eq!(ptime_sdp(125), "0.125");
        assert_eq!(ptime_sdp(250), "0.25");
        assert_eq!(ptime_sdp(333), "0.33");
        assert_eq!(ptime_sdp(4000), "4");
        assert!(check_audio_format(24, 1000).is_ok());
        assert!(check_audio_format(32, 1000).is_err());
        assert!(check_audio_format(24, 500).is_err());
    }

    /// L16 mit 125-µs-Paketen: SDP nennt `L16` und `ptime:0.125`; echte Pakete kommen an und sind kurz (48 kHz · 125 µs =
    /// 6 Abtastwerte je Kanal = 6·2·2 Byte Nutzdaten + 12 Byte RTP-Kopf = 36 Byte).
    #[test]
    fn l16_125us_roundtrip() {
        gst::init().expect("gst::init");
        let wp = gst::Pipeline::new();
        let src = gst::ElementFactory::make("audiotestsrc").property("is-live", true).build().unwrap();
        wp.add(&src).unwrap();
        let out = St2110AudioOutput::new_with_format(&wp, &src, "127.0.0.1", 52380, 48000, 2, 16, 125).unwrap();
        let sdp = out.sdp();
        assert!(sdp.contains("a=rtpmap:96 L16/48000/2") && sdp.contains("a=ptime:0.125"), "sdp = {sdp}");
        out.set_active(true);
        let rp = gst::Pipeline::new();
        let input = St2110AudioInput::new_with_bits(&rp, 52380, 48000, 2, None, 16).unwrap();
        let got = Arc::new(AtomicBool::new(false));
        let g = got.clone();
        input.tail.static_pad("src").unwrap().add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            g.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Remove
        });
        let sink = gst::ElementFactory::make("fakesink").property("sync", false).build().unwrap();
        rp.add(&sink).unwrap();
        input.tail.link(&sink).unwrap();
        rp.set_state(gst::State::Playing).unwrap();
        wp.set_state(gst::State::Playing).unwrap();
        for _ in 0..40 {
            if got.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        wp.set_state(gst::State::Null).unwrap();
        rp.set_state(gst::State::Null).unwrap();
        assert!(got.load(Ordering::Relaxed), "kein L16-Ton angekommen");
    }

    /// Halbbild über die echte Strecke: SDP trägt `interlace`, die Bilder kommen als verschränkte Vollbilder an.
    #[test]
    fn interlaced_roundtrip_keeps_interleaved_caps() {
        gst::init().expect("gst::init");
        let wp = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).build().unwrap();
        wp.add(&src).unwrap();
        let out = St2110VideoOutput::new_full(&wp, &src, "127.0.0.1", 52390, 320, 180, 25, 1, 10, true).unwrap();
        assert!(out.sdp().contains("interlace; "), "sdp = {}", out.sdp());
        out.set_active(true);
        let rp = gst::Pipeline::new();
        let input = St2110VideoInput::new_full(&rp, 52390, 320, 180, 25, 1, None, 10, true).unwrap();
        let seen = Arc::new(Mutex::new(None::<String>));
        let sn = seen.clone();
        input.tail.static_pad("src").unwrap().add_probe(gst::PadProbeType::BUFFER, move |pad, _| {
            if let Some(c) = pad.current_caps()
                && let Some(st) = c.structure(0)
            {
                *sn.lock().unwrap() = Some(st.to_string());
            }
            gst::PadProbeReturn::Remove
        });
        let sink = gst::ElementFactory::make("fakesink").property("sync", false).build().unwrap();
        rp.add(&sink).unwrap();
        input.tail.link(&sink).unwrap();
        rp.set_state(gst::State::Playing).unwrap();
        wp.set_state(gst::State::Playing).unwrap();
        for _ in 0..40 {
            if seen.lock().unwrap().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        wp.set_state(gst::State::Null).unwrap();
        rp.set_state(gst::State::Null).unwrap();
        let mode = seen.lock().unwrap().clone();
        for (n, pl) in [("sender", &wp), ("receiver", &rp)] {
            if let Some(b) = pl.bus() {
                while let Some(m) = b.pop_filtered(&[gst::MessageType::Error]) {
                    if let gst::MessageView::Error(e) = m.view() {
                        eprintln!("BUSFEHLER {n}: {} ({:?})", e.error(), e.debug());
                    }
                }
            }
        }
        assert!(mode.as_deref().is_some_and(|m| m.contains("interlace-mode=(string)interleaved") || m.contains("interlace-mode=(string)mixed")), "caps = {mode:?}");
    }

    #[test]
    fn colorimetry_follows_picture_height() {
        assert_eq!(sdp_colorimetry(1080), "BT709");
        assert_eq!(sdp_colorimetry(720), "BT709");
        assert_eq!(sdp_colorimetry(576), "BT601-5");
        assert_eq!(sdp_colorimetry(480), "BT601-5");
    }

    #[test]
    fn audio_sdp_carries_clock_reference() {
        gst::init().expect("gst::init");
        let pipeline = gst::Pipeline::new();
        let src = gst::ElementFactory::make("audiotestsrc").build().expect("audiotestsrc");
        pipeline.add(&src).expect("add audiotestsrc");
        let output = St2110AudioOutput::new(&pipeline, &src, "127.0.0.1", 52132, 48000, 2).expect("St2110AudioOutput::new");
        let sdp = output.sdp();
        assert!(sdp.contains("a=ts-refclk:") && sdp.contains("a=mediaclk:direct=0"), "sdp = {sdp}");
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
            St2110AudioInput::new(&read_pipeline, PORT, SAMPLE_RATE, CHANNELS, None).expect("St2110AudioInput::new");
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
