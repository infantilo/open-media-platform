//! GStreamer-Pipelines von `omp-aes67-gateway` (Kapitel 19 Teil 3,
//! `docs/END-GOAL-FEATURES.md` §19.3c/§19.4) — Audio-Pendant zu
//! `omp-2110-gateway/src/pipeline.rs`, gleiches Grundmuster (eine Seite
//! berührt den OMP-internen MXL-Fabric, fix bei Prozessstart
//! konfiguriert, kein Cue/Take):
//!
//! - **Sink**-Rolle (AES67/RTP-Multicast → MXL-Flow): `St2110AudioInput
//!   ! MxlAudioOutput`. "Sink" bezeichnet hier die Rolle **dieses
//!   Nodes** im AES67-Sinne (er nimmt einen extern gesendeten Strom
//!   entgegen), nicht `omp-2110-gateway`s "ingest/output"-Wortwahl —
//!   beide meinen dieselbe Richtung.
//! - **Source**-Rolle (MXL-Flow → AES67/RTP-Multicast): `MxlAudioInput
//!   ! St2110AudioOutput`, Quellwahl per echtem IS-05-Receiver-PATCH
//!   (gleiches Rebuild-bei-Connect-Muster wie `omp-2110-gateway`s
//!   Output-Rolle). Zusätzlich zum reinen 2110-Gateway sendet die
//!   Source-Rolle periodische SAP-Announcements (`sap.rs`) — AES67-/
//!   Dante-Geräte im AES67-Modus finden Fremdströme ausschließlich über
//!   SAP, nicht durch aktives Scannen von Adressbereichen.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext};
use omp_mediaio::st2110::{St2110AudioInput, St2110AudioOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub enum Event {
    Error(String),
}

// ---------------------------------------------------------------------
// Sink: AES67/RTP-Multicast → MXL-Flow
// ---------------------------------------------------------------------

pub struct SinkConfig {
    pub domain: String,
    pub flow_id: String,
    pub label: String,
    pub listen_port: u16,
    pub multicast_group: Option<String>,
    pub sample_rate: i32,
    pub channels: i32,
    /// Kapitel 19 Teil 2 (opt-in, `OMP_PTP_DOMAIN`) — `None` heißt
    /// unverändertes Free-Run-Verhalten wie bisher.
    pub ptp_domain: Option<u32>,
}

pub struct SinkHandle {
    pipeline: gst::Pipeline,
    _input: St2110AudioInput,
    _output: MxlAudioOutput,
    flowed: Arc<AtomicBool>,
    ptp_clock: Option<gstreamer_net::PtpClock>,
}

impl SinkHandle {
    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }

    /// S. `omp-2110-gateway::pipeline::IngestHandle::ptp_synced`-Doku.
    pub fn ptp_synced(&self) -> Option<bool> {
        self.ptp_clock.as_ref().map(|c| c.is_synced())
    }
}

impl Drop for SinkHandle {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

pub fn run_sink(
    config: SinkConfig,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<SinkHandle, String>>,
) {
    if let Err(e) = gst::init() {
        let msg = format!("gst init failed: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }

    let context = match MxlContext::new(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let pipeline = gst::Pipeline::new();

    let input = match St2110AudioInput::new(
        &pipeline,
        config.listen_port,
        config.sample_rate,
        config.channels,
        config.multicast_group.as_deref(),
    ) {
        Ok(i) => i,
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let output = match MxlAudioOutput::new(
        &pipeline,
        &input.tail,
        context,
        &config.flow_id,
        &config.label,
        config.sample_rate as u32,
        config.channels as u32,
    ) {
        Ok(o) => o,
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };
    output.set_active(true);

    let flowed = Arc::new(AtomicBool::new(false));
    let flowed_probe = flowed.clone();
    let input_tail_src_pad = input.tail.static_pad("src").expect("tail has a src pad");
    input_tail_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        flowed_probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Remove
    });

    // S. omp-2110-gateway::pipeline::run_ingest-Kommentar zur selben Stelle.
    let ptp_clock = match config.ptp_domain {
        Some(domain) => match omp_mediaio::ptp::apply_ptp_clock(&pipeline, domain, gst::ClockTime::from_seconds(5)) {
            Ok(clock) => Some(clock),
            Err(e) => {
                let _ = tx.send(Event::Error(format!("PTP-Domain {domain}: {e}")));
                None
            }
        },
        None => None,
    };

    if let Err(e) = pipeline.set_state(gst::State::Playing) {
        let msg = format!("set state playing: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }

    let _ = ready.send(Ok(SinkHandle {
        pipeline: pipeline.clone(),
        _input: input,
        _output: output,
        flowed,
        ptp_clock,
    }));

    while !shutdown.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(500));
    }
}

// ---------------------------------------------------------------------
// Source: MXL-Flow → AES67/RTP-Multicast
// ---------------------------------------------------------------------

pub struct SourceConfig {
    pub domain: String,
    pub destination_host: String,
    pub destination_port: u16,
    pub sample_rate: i32,
    pub channels: i32,
    /// S. `SinkConfig::ptp_domain`-Doku.
    pub ptp_domain: Option<u32>,
}

enum Command {
    Connect(String),
    Disconnect,
}

#[derive(Clone)]
pub struct SourcePipelineHandle {
    commands: Sender<Command>,
    flowed: Arc<AtomicBool>,
    /// Aktuelles SDP der Ausgangsseite — konstant über die Prozess-
    /// laufzeit (Ziel-Endpunkt ist fix), unabhängig von der gerade
    /// verbundenen MXL-Quelle. `main.rs` reicht das an den
    /// SAP-`Announcer` weiter.
    sdp: String,
    /// S. `omp-2110-gateway::pipeline::OutputPipelineHandle::ptp_synced`-
    /// Doku (gleiche geteilte Zelle wegen Pipeline-Rebuild bei jedem
    /// Connect/Disconnect).
    ptp_synced: Arc<Mutex<Option<bool>>>,
}

impl SourcePipelineHandle {
    pub fn connect(&self, flow_id: String) {
        self.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::Connect(flow_id));
    }

    pub fn disconnect(&self) {
        self.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::Disconnect);
    }

    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }

    pub fn sdp(&self) -> &str {
        &self.sdp
    }

    pub fn ptp_synced(&self) -> Option<bool> {
        *self.ptp_synced.lock().expect("lock poisoned")
    }
}

struct ActiveSourcePipeline {
    pipeline: gst::Pipeline,
    _input: MxlAudioInput,
    _output: St2110AudioOutput,
    _ptp_clock: Option<gstreamer_net::PtpClock>,
}

impl Drop for ActiveSourcePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

#[allow(clippy::too_many_arguments)]
fn build_source(
    context: &Arc<MxlContext>,
    flow_id: &str,
    destination_host: &str,
    destination_port: u16,
    sample_rate: i32,
    channels: i32,
    flowed: Arc<AtomicBool>,
    ptp_domain: Option<u32>,
    ptp_synced_cell: &Arc<Mutex<Option<bool>>>,
) -> Result<ActiveSourcePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let input = MxlAudioInput::new(&pipeline, context.clone(), flow_id)?;
    let flowed_probe = flowed.clone();
    let input_tail_src_pad = input.tail.static_pad("src").expect("tail has a src pad");
    input_tail_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        flowed_probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Remove
    });

    let ptp_clock = match ptp_domain {
        Some(domain) => match omp_mediaio::ptp::apply_ptp_clock(&pipeline, domain, gst::ClockTime::from_seconds(5)) {
            Ok(clock) => {
                *ptp_synced_cell.lock().expect("lock poisoned") = Some(clock.is_synced());
                Some(clock)
            }
            Err(e) => {
                eprintln!("omp-aes67-gateway: PTP-Domain {domain}: {e}");
                *ptp_synced_cell.lock().expect("lock poisoned") = None;
                None
            }
        },
        None => None,
    };

    let output =
        St2110AudioOutput::new(&pipeline, &input.tail, destination_host, destination_port, sample_rate, channels)?;
    output.set_active(true);

    pipeline.set_state(gst::State::Playing).map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActiveSourcePipeline { pipeline, _input: input, _output: output, _ptp_clock: ptp_clock })
}

/// Baut initial nur den festen Ausgang (2110-Ziel + SDP stehen ab
/// Prozessstart fest, unabhängig davon, ob schon eine MXL-Quelle
/// gewählt wurde) — `main.rs` startet den SAP-`Announcer` deshalb schon
/// vor dem ersten `Connect`.
pub fn run_source(
    config: SourceConfig,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<SourcePipelineHandle, String>>,
) {
    if let Err(e) = gst::init() {
        let msg = format!("gst init failed: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }

    let context = match MxlContext::new(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let sdp = format!(
        "v=0\r\n\
         o=- 0 0 IN IP4 {host}\r\n\
         s=OpenMediaPlatform ST2110-30/AES67\r\n\
         c=IN IP4 {host}\r\n\
         t=0 0\r\n\
         m=audio {port} RTP/AVP 96\r\n\
         a=rtpmap:96 L24/{rate}/{channels}\r\n\
         a=ptime:1\r\n",
        host = config.destination_host,
        port = config.destination_port,
        rate = config.sample_rate,
        channels = config.channels,
    );

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let flowed = Arc::new(AtomicBool::new(false));
    let ptp_synced = Arc::new(Mutex::new(None));
    let _ = ready.send(Ok(SourcePipelineHandle {
        commands: commands_tx,
        flowed: flowed.clone(),
        sdp,
        ptp_synced: ptp_synced.clone(),
    }));

    let mut active: Option<ActiveSourcePipeline> = None;
    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::Connect(flow_id)) => {
                active = None;
                match build_source(
                    &context,
                    &flow_id,
                    &config.destination_host,
                    config.destination_port,
                    config.sample_rate,
                    config.channels,
                    flowed.clone(),
                    config.ptp_domain,
                    &ptp_synced,
                ) {
                    Ok(p) => active = Some(p),
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("connect {flow_id} failed: {e}")));
                    }
                }
            }
            Ok(Command::Disconnect) => {
                active = None;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
