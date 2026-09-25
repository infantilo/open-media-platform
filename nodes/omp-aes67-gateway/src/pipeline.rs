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

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext};
use omp_mediaio::st2110::{St2110AudioInput, St2110AudioOutput};
use omp_node_sdk::channelmapping::MapEntry;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub enum Event {
    Error(String),
}

/// `channels`-große Diagonalmatrix (Kanal `i` → Kanal `i`, unverändert)
/// — sicherer Startzustand für `audiomixmatrix`, bevor die erste echte
/// IS-08-Aktivierung (`UMSETZUNG.md` D17) eintrifft. Ohne das bliebe das
/// Element auf seinem leeren Default (`gst-inspect-1.0 audiomixmatrix`:
/// `matrix: "<  >"`) hängen — kompletter Stille statt unverändertem
/// Durchreichen, bis `ChannelMapping::new()`s eigener Identitäts-Default
/// (`omp_node_sdk::channelmapping`) den ersten `apply()`-Aufruf macht.
fn identity_matrix_value(channels: i32) -> gst::Array {
    gst::Array::new((0..channels).map(|out_ch| {
        gst::Array::new((0..channels).map(move |in_ch| if in_ch == out_ch { 1.0_f64 } else { 0.0_f64 }))
    }))
}

/// Baut die `audiomixmatrix`-Property aus einer IS-08-Map. Vereinfacht
/// gegenüber dem allgemeinen IS-08-Modell (das beliebig viele Inputs pro
/// Output erlaubt): dieser Node hat pro Richtung immer genau EINEN
/// Input, `channelmapping::ChannelMapping::post_activation` lehnt jeden
/// anderen `input`-Wert bereits mit 400 ab (s. dort) — ein
/// `entry.input.is_some()` bedeutet hier also immer "von unserem einen
/// Input", der Vergleich der Input-ID selbst ist überflüssig. `None`
/// (unrouted) bleibt eine Nullzeile = Stille auf diesem Ausgangskanal.
fn matrix_value_from_map(channels: i32, map: &BTreeMap<u32, MapEntry>) -> gst::Array {
    gst::Array::new((0..channels as u32).map(|out_ch| {
        let source_channel = map.get(&out_ch).and_then(|e| if e.input.is_some() { e.channel_index } else { None });
        gst::Array::new(
            (0..channels as u32).map(move |in_ch| if Some(in_ch) == source_channel { 1.0_f64 } else { 0.0_f64 }),
        )
    }))
}

fn build_channel_matrix(pipeline: &gst::Pipeline, upstream: &gst::Element, channels: i32) -> Result<gst::Element, String> {
    let mixmatrix = gst::ElementFactory::make("audiomixmatrix")
        .property("in-channels", channels as u32)
        .property("out-channels", channels as u32)
        .property("matrix", identity_matrix_value(channels))
        .build()
        .map_err(|e| format!("audiomixmatrix: {e}"))?;
    pipeline.add(&mixmatrix).map_err(|e| format!("add audiomixmatrix: {e}"))?;
    upstream.link(&mixmatrix).map_err(|e| format!("link to audiomixmatrix: {e}"))?;
    Ok(mixmatrix)
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
    input: St2110AudioInput,
    _output: MxlAudioOutput,
    flowed: Arc<AtomicBool>,
    ptp_clock: Option<gstreamer_net::PtpClock>,
    mixmatrix: gst::Element,
    channels: i32,
}

impl SinkHandle {
    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }

    /// S. `omp-2110-gateway::pipeline::IngestHandle::ptp_synced`-Doku.
    pub fn ptp_synced(&self) -> Option<bool> {
        self.ptp_clock.as_ref().map(|c| c.is_synced())
    }

    /// S. `St2110AudioInput::jitterbuffer_stats`-Doku — für den
    /// BCP-008-Monitor-Tick (`main.rs`).
    pub fn jitterbuffer_stats(&self) -> (u64, u64) {
        self.input.jitterbuffer_stats()
    }

    /// NMOS IS-08 (`UMSETZUNG.md` D17) — setzt die `audiomixmatrix`-
    /// Property live neu, während die Pipeline läuft (kein Rebuild
    /// nötig: Kanalzahl/Caps bleiben unverändert, nur die
    /// Routing-Koeffizienten ändern sich).
    pub fn set_channel_map(&self, map: &BTreeMap<u32, MapEntry>) {
        self.mixmatrix.set_property("matrix", matrix_value_from_map(self.channels, map));
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
    heartbeat: Arc<AtomicU64>,
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

    let mixmatrix = match build_channel_matrix(&pipeline, &input.tail, config.channels) {
        Ok(e) => e,
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let output = match MxlAudioOutput::new(
        &pipeline,
        &mixmatrix,
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
        input,
        _output: output,
        flowed,
        ptp_clock,
        mixmatrix,
        channels: config.channels,
    }));

    while !shutdown.load(Ordering::Relaxed) {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
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
    channels: i32,
    /// NMOS IS-08 (`UMSETZUNG.md` D17) — die zuletzt aktivierte Map,
    /// unabhängig vom Pipeline-Lebenszyklus: ein `Connect` NACH einer
    /// Aktivierung muss dieselbe Map sofort wieder anwenden statt auf
    /// die Identität zurückzufallen (Rebuild bei jedem Connect/
    /// Disconnect, s. Moduldoku oben). `mixmatrix` ist `None`, solange
    /// keine MXL-Quelle verbunden ist — `set_channel_map` speichert dann
    /// nur `desired_map`, ohne ein Element zum sofortigen Anwenden zu
    /// haben (die nächste `build_source`-Ausführung liest `desired_map`
    /// selbst).
    desired_map: Arc<Mutex<BTreeMap<u32, MapEntry>>>,
    mixmatrix: Arc<Mutex<Option<gst::Element>>>,
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

    /// S. `SinkHandle::set_channel_map`-Doku — hier zusätzlich über
    /// Connect/Disconnect hinweg gemerkt (`desired_map`), weil die
    /// Pipeline selbst bei jedem Connect neu gebaut wird.
    pub fn set_channel_map(&self, map: BTreeMap<u32, MapEntry>) {
        if let Some(element) = &*self.mixmatrix.lock().expect("lock poisoned") {
            element.set_property("matrix", matrix_value_from_map(self.channels, &map));
        }
        *self.desired_map.lock().expect("lock poisoned") = map;
    }
}

struct ActiveSourcePipeline {
    pipeline: gst::Pipeline,
    _input: MxlAudioInput,
    _output: St2110AudioOutput,
    _ptp_clock: Option<gstreamer_net::PtpClock>,
    mixmatrix_cell: Arc<Mutex<Option<gst::Element>>>,
}

impl Drop for ActiveSourcePipeline {
    fn drop(&mut self) {
        // Kein gültiges Element mehr, sobald die Pipeline auf `Null`
        // geht — `set_channel_map` muss ab jetzt wieder auf `desired_map`
        // ausweichen statt auf ein totes Element zu schreiben.
        *self.mixmatrix_cell.lock().expect("lock poisoned") = None;
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
    desired_map: &Arc<Mutex<BTreeMap<u32, MapEntry>>>,
    mixmatrix_cell: &Arc<Mutex<Option<gst::Element>>>,
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

    let mixmatrix = build_channel_matrix(&pipeline, &input.tail, channels)?;
    {
        let desired = desired_map.lock().expect("lock poisoned");
        if !desired.is_empty() {
            mixmatrix.set_property("matrix", matrix_value_from_map(channels, &desired));
        }
    }
    *mixmatrix_cell.lock().expect("lock poisoned") = Some(mixmatrix.clone());

    let output =
        St2110AudioOutput::new(&pipeline, &mixmatrix, destination_host, destination_port, sample_rate, channels)?;
    output.set_active(true);

    pipeline.set_state(gst::State::Playing).map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActiveSourcePipeline {
        pipeline,
        _input: input,
        _output: output,
        _ptp_clock: ptp_clock,
        mixmatrix_cell: mixmatrix_cell.clone(),
    })
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
    heartbeat: Arc<AtomicU64>,
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
    let desired_map = Arc::new(Mutex::new(BTreeMap::new()));
    let mixmatrix_cell = Arc::new(Mutex::new(None));
    let _ = ready.send(Ok(SourcePipelineHandle {
        commands: commands_tx,
        flowed: flowed.clone(),
        sdp,
        ptp_synced: ptp_synced.clone(),
        channels: config.channels,
        desired_map: desired_map.clone(),
        mixmatrix: mixmatrix_cell.clone(),
    }));

    let mut active: Option<ActiveSourcePipeline> = None;
    // Root-Cause-Fund Bugliste 2026-09-25 #3 (gleiches Muster wie
    // `omp-viewer::pipeline::run`): merkt sich die zuletzt gewünschte,
    // noch nicht erfolgreich verbundene Quelle für den Timeout-Retry
    // unten.
    let mut retry_target: Option<String> = None;
    loop {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
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
                    &desired_map,
                    &mixmatrix_cell,
                ) {
                    Ok(p) => {
                        active = Some(p);
                        retry_target = None;
                    }
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("connect {flow_id} failed: {e}")));
                        retry_target = Some(flow_id);
                    }
                }
            }
            Ok(Command::Disconnect) => {
                active = None;
                retry_target = None;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if active.is_none()
                    && let Some(flow_id) = retry_target.clone()
                    && let Ok(p) = build_source(
                        &context,
                        &flow_id,
                        &config.destination_host,
                        config.destination_port,
                        config.sample_rate,
                        config.channels,
                        flowed.clone(),
                        config.ptp_domain,
                        &ptp_synced,
                        &desired_map,
                        &mixmatrix_cell,
                    )
                {
                    active = Some(p);
                    retry_target = None;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
