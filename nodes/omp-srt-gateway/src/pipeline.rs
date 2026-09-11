//! Zwei Pipeline-Formen, je nach `Direction` (`UMSETZUNG.md` D4,
//! `ARCHITECTURE.md` §6: "Cloud-Gateway-Node bridged ST 2110 ⇄
//! SRT/RIST"). Beide bauen auf `omp_mediaio::st2110` auf, statt die
//! RTP/2110-Payload-Logik zu duplizieren:
//!
//! - **Uplink** (LAN → WAN): `St2110VideoInput` (liest einen echten
//!   ST-2110-Strom aus dem LAN) liefert `tail` (rohes Videosignal); von
//!   dort baut dieses Modul selbst weiter zu `rtpvrawpay ! srtsink` —
//!   derselbe RTP-Payload wie auf der LAN-Seite, nur über SRT statt UDP
//!   transportiert (RTP-über-SRT ist ein reales, in der
//!   Rundfunk-Branche übliches Contribution-Muster, keine Erfindung
//!   dieses Projekts).
//! - **Downlink** (WAN → LAN): `srtsrc ! rtpjitterbuffer ! rtpvrawdepay`
//!   liefert das letzte Element als `upstream` an
//!   `St2110VideoOutput::new` — reine Wiederverwendung, keine eigene
//!   Sender-Logik.
//!
//! **Bewusst nicht Teil dieser Stufe** (dokumentierter Scope, siehe
//! `docs/decisions.md` D4): dynamische IS-05-Verbindungsverwaltung für
//! die 2110-Seite (Ziel/Quelle sind Prozess-Start-Konfiguration statt
//! Laufzeit-PATCH, analog zur bewussten Vereinfachung in
//! `omp-switcher`, C7, "0 Receiver in v0") — Operator konfiguriert
//! Host/Port/SRT-URI beim Start, kein Drag&Drop auf die WAN-Seite.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::MediaFlow;
use omp_mediaio::Output;
use omp_mediaio::st2110::{St2110VideoInput, St2110VideoOutput};

pub const WIDTH: i32 = 640;
pub const HEIGHT: i32 = 480;
pub const FRAMERATE_NUMERATOR: i32 = 25;
pub const FRAMERATE_DENOMINATOR: i32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// LAN (ST 2110) → WAN (SRT).
    Uplink,
    /// WAN (SRT) → LAN (ST 2110).
    Downlink,
}

pub enum Event {
    Error(String),
}

/// Konfiguration eines Gateway-Laufs — welche Richtung, welche
/// Endpunkte. `st2110_port` ist beim Uplink der lokale Empfangsport, beim
/// Downlink der Zielport für den erzeugten 2110-Strom.
pub struct Config {
    pub direction: Direction,
    pub st2110_host: String,
    pub st2110_port: u16,
    pub srt_uri: String,
}

/// Der jeweils eine 2110-Endpunkt, den diese Richtung tatsächlich betreibt
/// (Uplink liest 2110, Downlink schreibt 2110) — gehalten, damit sein
/// `has_flowed()` (`omp_mediaio::MediaFlow`) nach Prozess-Start weiter
/// abfragbar bleibt (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2);
/// würde sonst mit dem Rückgabewert von `build_uplink`/`build_downlink`
/// verworfen, obwohl die zugehörigen Pipeline-Elemente weiterlaufen.
/// Trägt zusätzlich die `srtsink`/`srtsrc`-Elemente (+ bei Downlink den
/// separaten `rtpjitterbuffer`) für den BCP-008-Monitor-Tick (`main.rs`,
/// `docs/decisions.md` BCP-008-Nachtrag) — echte SRT-/RTP-Statistiken
/// statt erfundener Werte.
enum ActiveEndpoint {
    Uplink { input: St2110VideoInput, srtsink: gst::Element },
    Downlink { output: St2110VideoOutput, srtsrc: gst::Element, jitterbuffer: gst::Element },
}

impl ActiveEndpoint {
    fn has_flowed(&self) -> bool {
        match self {
            ActiveEndpoint::Uplink { input, .. } => input.has_flowed(),
            ActiveEndpoint::Downlink { output, .. } => output.has_flowed(),
        }
    }
}

pub struct PipelineHandle {
    pipeline: gst::Pipeline,
    endpoint: ActiveEndpoint,
}

fn u64_field(structure: &gst::Structure, name: &str) -> u64 {
    structure.get::<u64>(name).unwrap_or(0)
}

fn i32_field(structure: &gst::Structure, name: &str) -> i32 {
    structure.get::<i32>(name).unwrap_or(0)
}

impl PipelineHandle {
    pub fn shutdown(&self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }

    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6): ob der 2110-Endpunkt
    /// dieser Richtung bereits mindestens einen echten Buffer
    /// gesendet/empfangen hat.
    pub fn media_ready(&self) -> bool {
        self.endpoint.has_flowed()
    }

    /// Nur bei `Direction::Uplink` `Some` — echte SRT-Sendestatistik aus
    /// `srtsink`s `stats`-Property (`bytes_sent_total`,
    /// `packets_sent_lost`, `packets_retransmitted`; live per
    /// `gst-inspect-1.0`/Testpipeline geprüfte Feldnamen des GStreamer-
    /// SRT-Plugins, nicht geraten — die einzelnen Caller-Substrukturen
    /// (`callers`-`GValueArray`, nur bei `srtsrc` im Listener-Modus
    /// relevant) bleiben bewusst unberücksichtigt, s. `main.rs`s
    /// Monitor-Tick-Doku zur Kosten/Nutzen-Abwägung).
    pub fn srt_send_stats(&self) -> Option<(u64, i32, i32)> {
        match &self.endpoint {
            ActiveEndpoint::Uplink { srtsink, .. } => {
                let stats = srtsink.property::<gst::Structure>("stats");
                Some((
                    u64_field(&stats, "bytes-sent-total"),
                    i32_field(&stats, "packets-sent-lost"),
                    i32_field(&stats, "packets-retransmitted"),
                ))
            }
            ActiveEndpoint::Downlink { .. } => None,
        }
    }

    /// Nur bei `Direction::Downlink` `Some` — `bytes-received-total` aus
    /// `srtsrc`s `stats`-Property (Top-Level-Feld, s. `srt_send_stats`-
    /// Doku zur bewusst ausgeklammerten Caller-Liste).
    pub fn srt_receive_bytes_total(&self) -> Option<u64> {
        match &self.endpoint {
            ActiveEndpoint::Downlink { srtsrc, .. } => {
                let stats = srtsrc.property::<gst::Structure>("stats");
                Some(u64_field(&stats, "bytes-received-total"))
            }
            ActiveEndpoint::Uplink { .. } => None,
        }
    }

    /// Der lokal (nicht über SRT) inspizierbare RTP-Jitterbuffer dieser
    /// Richtung: bei Uplink der von `St2110VideoInput` (LAN-Empfang, vor
    /// dem SRT-Versand — BCP-008 `essenceStatus`), bei Downlink der
    /// separate, zwischen `srtsrc` und dem Depayloader sitzende (nach
    /// dem SRT-Empfang, vor der lokalen 2110-Ausgabe — `connectionStatus`).
    pub fn local_jitterbuffer_stats(&self) -> (u64, u64) {
        match &self.endpoint {
            ActiveEndpoint::Uplink { input, .. } => input.jitterbuffer_stats(),
            ActiveEndpoint::Downlink { jitterbuffer, .. } => {
                let stats = jitterbuffer.property::<gst::Structure>("stats");
                (u64_field(&stats, "num-lost"), u64_field(&stats, "num-late"))
            }
        }
    }
}

/// Baut und startet die Pipeline für `cfg.direction`, meldet
/// Bus-Fehler über `events` (gleiches Muster wie `omp-source`/`playout`:
/// ein Hintergrund-Thread beobachtet den GStreamer-Bus, damit ein
/// Pipeline-Fehler als NATS-Alarm sichtbar wird statt den Prozess still
/// hängen zu lassen).
pub fn build(
    cfg: &Config,
    events: tokio::sync::mpsc::UnboundedSender<Event>,
    heartbeat: Arc<AtomicU64>,
) -> Result<PipelineHandle, String> {
    gst::init().map_err(|e| format!("gst::init: {e}"))?;
    let pipeline = gst::Pipeline::new();

    let endpoint = match cfg.direction {
        Direction::Uplink => {
            let (input, srtsink) = build_uplink(&pipeline, cfg)?;
            ActiveEndpoint::Uplink { input, srtsink }
        }
        Direction::Downlink => {
            let (output, srtsrc, jitterbuffer) = build_downlink(&pipeline, cfg)?;
            ActiveEndpoint::Downlink { output, srtsrc, jitterbuffer }
        }
    };

    let bus = pipeline.bus().expect("pipeline always has a bus");
    let pipeline_weak = pipeline.downgrade();
    std::thread::spawn(move || {
        // Umgestellt von `bus.iter_timed(ClockTime::NONE)` (blockiert
        // unbegrenzt bis zur nächsten Nachricht) auf eine 1s-Poll-
        // Schleife — omp_node_sdk::liveness::LivenessMonitor
        // (docs/decisions.md Nachtrag 130/131) braucht einen Tick auch
        // während einer ruhigen, gesunden Pipeline ohne Bus-Traffic;
        // dieselbe `timed_pop`-Poll-Kadenz wie z. B. `omp-source::
        // pipeline::poll_error`, funktional unverändert (Error/Eos wie
        // zuvor behandelt, nur ohne unbegrenztes Blockieren dazwischen).
        loop {
            heartbeat.fetch_add(1, Ordering::Relaxed);
            if let Some(msg) = bus.timed_pop(gst::ClockTime::from_seconds(1)) {
                use gst::MessageView;
                match msg.view() {
                    MessageView::Error(err) => {
                        let _ = events.send(Event::Error(format!(
                            "{} ({})",
                            err.error(),
                            err.debug().unwrap_or_default()
                        )));
                    }
                    MessageView::Eos(_) => break,
                    _ => {}
                }
            }
            if pipeline_weak.upgrade().is_none() {
                break;
            }
        }
    });

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("pipeline playing: {e}"))?;

    Ok(PipelineHandle { pipeline, endpoint })
}

fn build_uplink(pipeline: &gst::Pipeline, cfg: &Config) -> Result<(St2110VideoInput, gst::Element), String> {
    let input = St2110VideoInput::new(
        pipeline,
        cfg.st2110_port,
        WIDTH,
        HEIGHT,
        FRAMERATE_NUMERATOR,
        FRAMERATE_DENOMINATOR,
        None,
    )?;

    let payloader = gst::ElementFactory::make("rtpvrawpay")
        .build()
        .map_err(|e| format!("rtpvrawpay: {e}"))?;
    let srtsink = gst::ElementFactory::make("srtsink")
        .property("uri", &cfg.srt_uri)
        .build()
        .map_err(|e| format!("srtsink: {e}"))?;

    pipeline
        .add(&payloader)
        .and_then(|()| pipeline.add(&srtsink))
        .map_err(|e| format!("add uplink elements: {e}"))?;
    gst::Element::link_many([&input.tail, &payloader, &srtsink])
        .map_err(|e| format!("link uplink chain: {e}"))?;

    Ok((input, srtsink))
}

fn build_downlink(pipeline: &gst::Pipeline, cfg: &Config) -> Result<(St2110VideoOutput, gst::Element, gst::Element), String> {
    let srtsrc = gst::ElementFactory::make("srtsrc")
        .property("uri", &cfg.srt_uri)
        .build()
        .map_err(|e| format!("srtsrc: {e}"))?;
    let jitterbuffer = gst::ElementFactory::make("rtpjitterbuffer")
        .build()
        .map_err(|e| format!("rtpjitterbuffer: {e}"))?;
    let depayloader = gst::ElementFactory::make("rtpvrawdepay")
        .build()
        .map_err(|e| format!("rtpvrawdepay: {e}"))?;

    pipeline
        .add(&srtsrc)
        .and_then(|()| pipeline.add(&jitterbuffer))
        .and_then(|()| pipeline.add(&depayloader))
        .map_err(|e| format!("add downlink elements: {e}"))?;
    gst::Element::link_many([&srtsrc, &jitterbuffer, &depayloader])
        .map_err(|e| format!("link downlink chain: {e}"))?;

    let output = St2110VideoOutput::new(
        pipeline,
        &depayloader,
        &cfg.st2110_host,
        cfg.st2110_port,
        WIDTH,
        HEIGHT,
        FRAMERATE_NUMERATOR,
        FRAMERATE_DENOMINATOR,
    )?;
    output.set_active(true);

    Ok((output, srtsrc, jitterbuffer))
}
