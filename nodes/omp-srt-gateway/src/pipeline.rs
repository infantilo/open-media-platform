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

use gst::prelude::*;
use gstreamer as gst;
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

pub struct PipelineHandle {
    pipeline: gst::Pipeline,
}

impl PipelineHandle {
    pub fn shutdown(&self) {
        let _ = self.pipeline.set_state(gst::State::Null);
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
) -> Result<PipelineHandle, String> {
    gst::init().map_err(|e| format!("gst::init: {e}"))?;
    let pipeline = gst::Pipeline::new();

    match cfg.direction {
        Direction::Uplink => build_uplink(&pipeline, cfg)?,
        Direction::Downlink => build_downlink(&pipeline, cfg)?,
    }

    let bus = pipeline.bus().expect("pipeline always has a bus");
    let pipeline_weak = pipeline.downgrade();
    std::thread::spawn(move || {
        for msg in bus.iter_timed(gst::ClockTime::NONE) {
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
            if pipeline_weak.upgrade().is_none() {
                break;
            }
        }
    });

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("pipeline playing: {e}"))?;

    Ok(PipelineHandle { pipeline })
}

fn build_uplink(pipeline: &gst::Pipeline, cfg: &Config) -> Result<(), String> {
    let input = St2110VideoInput::new(
        pipeline,
        cfg.st2110_port,
        WIDTH,
        HEIGHT,
        FRAMERATE_NUMERATOR,
        FRAMERATE_DENOMINATOR,
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

    Ok(())
}

fn build_downlink(pipeline: &gst::Pipeline, cfg: &Config) -> Result<(), String> {
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

    Ok(())
}
