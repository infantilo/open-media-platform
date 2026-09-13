//! GStreamer-Pipelines von `omp-2110-gateway` (Kapitel 19 Teil 1,
//! `docs/END-GOAL-FEATURES.md` §19.3a Punkt 4/§19.4) — zwei Richtungen,
//! **anders als `omp-srt-gateway`** (reines Protokoll-zu-Protokoll-
//! Gateway, kein MXL-Bezug) berührt hier genau eine Seite den
//! OMP-internen Fabric:
//!
//! - **Ingest** (2110-Multicast → MXL-Flow): `St2110VideoInput !
//!   MxlVideoOutput`. Fix beim Prozessstart konfiguriert, kein Cue/Take
//!   (gleiche "einmal konfiguriert, dauerhaft aktiv"-Philosophie wie
//!   `omp-srt-gateway`, `main.rs`-Moduldoku dort) — ein 2110-Gateway ist
//!   wie ein Hardware-Gateway modelliert, nicht wie eine per Flow-Editor
//!   umschaltbare Quelle.
//! - **Output** (MXL-Flow → 2110-Multicast): `MxlVideoInput !
//!   St2110VideoOutput`, Quellwahl per echtem IS-05-Receiver-PATCH
//!   (gleiches Rebuild-bei-Connect-Muster wie `omp-viewer::pipeline`,
//!   nicht `omp-srt-gateway`s feste Env-Var-Konfiguration — hier ist die
//!   MXL-Seite die variable, per Flow-Editor drag&drop wählbare Seite).
//!   Ziel-Endpunkt (2110-Netzwerkadresse) bleibt fix (Env-Var), nur die
//!   MXL-Quelle ist dynamisch.
//!
//! **Audio-Ingest/-Output (D21, `UMSETZUNG.md`):** war bis dahin
//! komplett ausgeklammert ("Video-only... folgt als eigener Schritt,
//! sobald ein konkreter Bedarf für synchronisierten Video+Audio-
//! Gateway-Betrieb besteht") — der Bedarf ist jetzt AMWA IS-08 auf
//! diesem Node. Zwei unterschiedliche Kopplungsgrade, bewusst je nach
//! Richtung verschieden gewählt:
//!
//! - **Ingest:** Video- UND Audio-Zweig teilen sich EIN `gst::Pipeline`-
//!   Objekt (wie `omp-decklink::pipeline::run_ingest`s Video+Audio-
//!   Branches) — beide sind "einmal konfiguriert, dauerhaft aktiv" (kein
//!   Reconnect-Unterschied zwischen den Essenzen), ein gemeinsamer PTP-
//!   Clock-Apply auf dieselbe Pipeline ist ohnehin die korrekte Semantik
//!   für "synchronisiert".
//! - **Output:** Video (bestehend, unverändert) und Audio (neu) bleiben
//!   ZWEI unabhängige `gst::Pipeline`-Objekte mit eigenem Connect/
//!   Disconnect-Lebenszyklus (wie `omp-aes67-gateway::pipeline::
//!   run_source`) — anders als bei `omp-decklink` (eine einzelne SDI-
//!   Ausgangskarte kann physisch nicht "nur Ton, kein Bild" senden) ist
//!   ein ST2110-Netzwerkausgang genau das ein reales, unabhängiges
//!   Deployment-Szenario (z. B. ein reiner Audio-Embedder/-De-Embedder);
//!   "Video als Anker-Verbindung" (`omp-decklink`s Modell) würde hier
//!   eine Hardware-Beschränkung erfinden, die es nicht gibt.
//!
//! IS-08 (`omp_node_sdk::channelmapping`, `UMSETZUNG.md` D17/D18) sitzt
//! in beiden Fällen als `audiomixmatrix` zwischen dem Audio-Eingang und
//! dessen MXL-/2110-Ausgang, exakt wie bei `omp-aes67-gateway`/
//! `omp-decklink` (`main.rs` verdrahtet die Aktivierung).

use std::collections::BTreeMap;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext, MxlVideoInput, MxlVideoOutput};
use omp_mediaio::st2110::{St2110AudioInput, St2110AudioOutput, St2110VideoInput, St2110VideoOutput};
use omp_node_sdk::channelmapping::MapEntry;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub enum Event {
    Error(String),
}

/// `channels`-große Diagonalmatrix — s. `omp-aes67-gateway::pipeline::
/// identity_matrix_value`-Doku (identische Begründung/Implementierung,
/// bewusst dupliziert statt geteilt, gleiches Prinzip wie überall sonst
/// zwischen diesen unabhängigen Gateway-Nodes).
fn identity_matrix_value(channels: i32) -> gst::Array {
    gst::Array::new((0..channels).map(|out_ch| {
        gst::Array::new((0..channels).map(move |in_ch| if in_ch == out_ch { 1.0_f64 } else { 0.0_f64 }))
    }))
}

/// S. `omp-aes67-gateway::pipeline::matrix_value_from_map`-Doku
/// (identisch: genau ein Input pro Richtung, `ChannelMapping::
/// post_activation` erzwingt das bereits serverseitig).
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
// Ingest: 2110-Multicast → MXL-Flow
// ---------------------------------------------------------------------

pub struct IngestConfig {
    pub domain: String,
    pub flow_id: String,
    pub label: String,
    pub listen_port: u16,
    pub multicast_group: Option<String>,
    pub width: i32,
    pub height: i32,
    pub framerate_numerator: i32,
    pub framerate_denominator: i32,
    /// Kapitel 19 Teil 2 (opt-in, `OMP_PTP_DOMAIN`) — `None` heißt
    /// unverändertes Free-Run-Verhalten wie bisher.
    pub ptp_domain: Option<u32>,
    /// D21 (Audio-Ingest, s. Moduldoku oben).
    pub audio_flow_id: String,
    pub audio_listen_port: u16,
    pub audio_multicast_group: Option<String>,
    pub audio_sample_rate: i32,
    pub audio_channels: i32,
}

/// Griff auf die laufende Ingest-Pipeline — hält `pipeline`/`_input`/
/// `_output` am Leben (gleiche Drop-Reihenfolge-Überlegung wie
/// `omp-viewer::pipeline::ActivePipeline`: Pipeline zuerst auf Null,
/// die MXL-/2110-Objekte räumen sich danach selbst auf) und liefert das
/// "media-ready"-Flag nach außen.
pub struct IngestHandle {
    pipeline: gst::Pipeline,
    input: St2110VideoInput,
    _output: MxlVideoOutput,
    flowed: Arc<AtomicBool>,
    ptp_clock: Option<gstreamer_net::PtpClock>,
    /// D21: eigener Audio-Zweig in DERSELBEN Pipeline (Moduldoku oben).
    audio_input: St2110AudioInput,
    _audio_output: MxlAudioOutput,
    audio_flowed: Arc<AtomicBool>,
    audio_mixmatrix: gst::Element,
    audio_channels: i32,
}

impl IngestHandle {
    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }

    /// S. `media_ready`-Doku — Audio-Pendant, eigene Probe (s.
    /// `run_ingest`), unabhängig vom Video-Zweig.
    pub fn audio_media_ready(&self) -> bool {
        self.audio_flowed.load(Ordering::Relaxed)
    }

    /// `None`, wenn keine PTP-Domain konfiguriert ist (Free-Run) —
    /// sonst der echte, abfragbare Sync-Zustand statt einer
    /// stillschweigenden Annahme (gleiches Prinzip wie `media_ready`).
    pub fn ptp_synced(&self) -> Option<bool> {
        self.ptp_clock.as_ref().map(|c| c.is_synced())
    }

    /// S. `St2110VideoInput::jitterbuffer_stats`-Doku — echte, kumulative
    /// Paketverlust-/Verspätungszähler für den BCP-008-Monitor-Tick
    /// (`main.rs`).
    pub fn jitterbuffer_stats(&self) -> (u64, u64) {
        self.input.jitterbuffer_stats()
    }

    /// Audio-Pendant zu `jitterbuffer_stats` — eigener, unabhängiger
    /// RTP-Jitterbuffer (separater 2110-30/AES67-Strom, eigener Port).
    pub fn audio_jitterbuffer_stats(&self) -> (u64, u64) {
        self.audio_input.jitterbuffer_stats()
    }

    /// NMOS IS-08 (`UMSETZUNG.md` D17/D18/D21) — s.
    /// `omp-aes67-gateway::pipeline::SinkHandle::set_channel_map`-Doku
    /// (identisches Muster: live `g_object_set` während `PLAYING`, kein
    /// Rebuild nötig).
    pub fn set_channel_map(&self, map: &BTreeMap<u32, MapEntry>) {
        self.audio_mixmatrix.set_property("matrix", matrix_value_from_map(self.audio_channels, map));
    }
}

impl Drop for IngestHandle {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

pub fn run_ingest(
    config: IngestConfig,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<IngestHandle, String>>,
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

    let input = match St2110VideoInput::new(
        &pipeline,
        config.listen_port,
        config.width,
        config.height,
        config.framerate_numerator,
        config.framerate_denominator,
        config.multicast_group.as_deref(),
    ) {
        Ok(i) => i,
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let output = match MxlVideoOutput::new(
        &pipeline,
        &input.tail,
        context.clone(),
        &config.flow_id,
        &config.label,
        config.width as u32,
        config.height as u32,
        config.framerate_numerator as u32,
        config.framerate_denominator as u32,
        // D8 Teil 3: kein Delay-Bedarf für dieses Ausgangsformat.
        Arc::new(AtomicU64::new(0)),
    ) {
        Ok(o) => o,
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };
    output.set_active(true);

    // "media-ready" (ARCHITECTURE.md §5 Punkt 6): echte 2110-Pakete
    // gesehen, nicht nur "Pipeline läuft" — Probe hinter dem 2110-
    // Empfänger, nicht hinter dem MXL-Schreiber (gleiche Begründung wie
    // überall sonst in diesem Crate: ein aktiver Valve/Writer allein
    // beweist noch keinen echten Dateninhalt).
    let flowed = Arc::new(AtomicBool::new(false));
    let flowed_probe = flowed.clone();
    let input_tail_src_pad = input.tail.static_pad("src").expect("tail has a src pad");
    input_tail_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        flowed_probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Remove
    });

    // D21 (Audio-Ingest, Moduldoku oben): eigener Zweig in DERSELBEN
    // Pipeline, eigener Port/eigener RTP-Jitterbuffer, `audiomixmatrix`
    // für IS-08 zwischen Eingang und MXL-Ausgang (identisches Muster wie
    // `omp-aes67-gateway::pipeline::run_sink`).
    let audio_input = match St2110AudioInput::new(
        &pipeline,
        config.audio_listen_port,
        config.audio_sample_rate,
        config.audio_channels,
        config.audio_multicast_group.as_deref(),
    ) {
        Ok(i) => i,
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };
    let audio_mixmatrix = match build_channel_matrix(&pipeline, &audio_input.tail, config.audio_channels) {
        Ok(e) => e,
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };
    let audio_output = match MxlAudioOutput::new(
        &pipeline,
        &audio_mixmatrix,
        context,
        &config.audio_flow_id,
        &format!("{} Audio", config.label),
        config.audio_sample_rate as u32,
        config.audio_channels as u32,
    ) {
        Ok(o) => o,
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };
    audio_output.set_active(true);

    let audio_flowed = Arc::new(AtomicBool::new(false));
    let audio_flowed_probe = audio_flowed.clone();
    let audio_input_tail_src_pad = audio_input.tail.static_pad("src").expect("tail has a src pad");
    audio_input_tail_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        audio_flowed_probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Remove
    });

    // Kapitel 19 Teil 2 (opt-in): Clock vor dem Playing-Übergang setzen,
    // sonst müsste die Pipeline für den Wechsel kurz erneut pausiert
    // werden. `wait_for_sync` blockiert bewusst (fester, kurzer
    // Timeout) statt die Pipeline unsynchronisiert sofort laufen zu
    // lassen — GStreamer schaltet danach ohnehin automatisch um, sobald
    // ein Master gefunden wird (s. `omp_mediaio::ptp`-Moduldoku), ein
    // etwas späterer Playing-Übergang beim ersten Start ist dafür ein
    // akzeptabler Kompromiss.
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

    let _ = ready.send(Ok(IngestHandle {
        pipeline: pipeline.clone(),
        input,
        _output: output,
        flowed,
        ptp_clock,
        audio_input,
        _audio_output: audio_output,
        audio_flowed,
        audio_mixmatrix,
        audio_channels: config.audio_channels,
    }));

    // Kein Reconnect-Kommandokanal nötig (fix konfiguriert) — reine
    // Warteschleife bis zum Shutdown, gleiche Poll-Kadenz wie
    // `omp-viewer::pipeline::run`s Command-Loop.
    while !shutdown.load(Ordering::Relaxed) {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(500));
    }
}

// ---------------------------------------------------------------------
// Output: MXL-Flow → 2110-Multicast
// ---------------------------------------------------------------------

pub struct OutputConfig {
    pub domain: String,
    pub destination_host: String,
    pub destination_port: u16,
    pub width: i32,
    pub height: i32,
    pub framerate_numerator: i32,
    pub framerate_denominator: i32,
    /// S. `IngestConfig::ptp_domain`-Doku.
    pub ptp_domain: Option<u32>,
}

enum Command {
    Connect(String),
    Disconnect,
}

/// Griff für den async Node-Lifecycle (gleiches Muster wie
/// `omp-viewer::pipeline::PipelineHandle`): schickt Connect-/
/// Disconnect-Befehle an den Pipeline-Thread, der bei jedem Wechsel die
/// gesamte Pipeline neu aufbaut (kein dynamisches Pad-Relinking).
#[derive(Clone)]
pub struct OutputPipelineHandle {
    commands: Sender<Command>,
    flowed: Arc<AtomicBool>,
    /// S. `IngestHandle::ptp_synced`-Doku — hier über eine geteilte
    /// Zelle statt eines direkten Feldzugriffs, weil die Pipeline (und
    /// damit die Clock) bei jedem Connect/Disconnect komplett neu
    /// aufgebaut wird (anders als bei `IngestHandle`, die einmalig
    /// lebt), der Handle selbst aber über alle Rebuilds hinweg bestehen
    /// bleibt.
    ptp_synced: Arc<Mutex<Option<bool>>>,
}

impl OutputPipelineHandle {
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

    pub fn ptp_synced(&self) -> Option<bool> {
        *self.ptp_synced.lock().expect("lock poisoned")
    }
}

struct ActiveOutputPipeline {
    pipeline: gst::Pipeline,
    _input: MxlVideoInput,
    _output: St2110VideoOutput,
    _ptp_clock: Option<gstreamer_net::PtpClock>,
}

impl Drop for ActiveOutputPipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

#[allow(clippy::too_many_arguments)]
fn build_output(
    context: &Arc<MxlContext>,
    flow_id: &str,
    destination_host: &str,
    destination_port: u16,
    width: i32,
    height: i32,
    framerate_numerator: i32,
    framerate_denominator: i32,
    flowed: Arc<AtomicBool>,
    ptp_domain: Option<u32>,
    ptp_synced_cell: &Arc<Mutex<Option<bool>>>,
) -> Result<ActiveOutputPipeline, String> {
    let pipeline = gst::Pipeline::new();

    let input = MxlVideoInput::new(&pipeline, context.clone(), flow_id)?;
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
                eprintln!("omp-2110-gateway: PTP-Domain {domain}: {e}");
                *ptp_synced_cell.lock().expect("lock poisoned") = None;
                None
            }
        },
        None => None,
    };

    let output = St2110VideoOutput::new(
        &pipeline,
        &input.tail,
        destination_host,
        destination_port,
        width,
        height,
        framerate_numerator,
        framerate_denominator,
    )?;
    output.set_active(true);

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActiveOutputPipeline {
        pipeline,
        _input: input,
        _output: output,
        _ptp_clock: ptp_clock,
    })
}

/// Läuft auf einem eigenen Thread (analog `omp-viewer::pipeline::run`):
/// baut initial keine Pipeline (noch keine Quelle gewählt), wartet auf
/// `Command`s und baut bei jedem Connect/Disconnect komplett neu.
pub fn run_output(
    config: OutputConfig,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<OutputPipelineHandle, String>>,
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

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let flowed = Arc::new(AtomicBool::new(false));
    let ptp_synced = Arc::new(Mutex::new(None));
    let _ = ready.send(Ok(OutputPipelineHandle {
        commands: commands_tx,
        flowed: flowed.clone(),
        ptp_synced: ptp_synced.clone(),
    }));

    let mut active: Option<ActiveOutputPipeline> = None;
    loop {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::Connect(flow_id)) => {
                // Alte Pipeline zuerst abbauen (Drop stoppt den MXL-
                // Reader-Thread + setzt State Null), bevor die neue
                // denselben MxlContext für einen neuen Reader nutzt.
                active = None;
                match build_output(
                    &context,
                    &flow_id,
                    &config.destination_host,
                    config.destination_port,
                    config.width,
                    config.height,
                    config.framerate_numerator,
                    config.framerate_denominator,
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

// ---------------------------------------------------------------------
// Audio-Output: MXL-Flow → 2110/AES67-Multicast (D21) — bewusst EIGENE,
// vom Video-Ausgang unabhängige Pipeline/Verbindung, s. Moduldoku oben
// ("Video als Anker-Verbindung" passt hier nicht, anders als bei
// `omp-decklink`). Struktur exakt nach dem Vorbild von
// `omp-aes67-gateway::pipeline::{SourceConfig, SourcePipelineHandle,
// ActiveSourcePipeline, build_source, run_source}` — bewusst dupliziert
// statt geteilt (jeder Gateway-Node bleibt ein unabhängiges Binary,
// gleiches Prinzip wie `is_multicast` in `main.rs`).
// ---------------------------------------------------------------------

pub struct AudioOutputConfig {
    pub domain: String,
    pub destination_host: String,
    pub destination_port: u16,
    pub sample_rate: i32,
    pub channels: i32,
    /// S. `OutputConfig::ptp_domain`-Doku.
    pub ptp_domain: Option<u32>,
}

enum AudioCommand {
    Connect(String),
    Disconnect,
}

#[derive(Clone)]
pub struct AudioOutputPipelineHandle {
    commands: Sender<AudioCommand>,
    flowed: Arc<AtomicBool>,
    ptp_synced: Arc<Mutex<Option<bool>>>,
    channels: i32,
    /// S. `omp-aes67-gateway::pipeline::SourcePipelineHandle::
    /// desired_map`-Doku — dieselbe Rebuild-bei-Connect-Problematik
    /// (unabhängige Pipeline pro Connect/Disconnect).
    desired_map: Arc<Mutex<BTreeMap<u32, MapEntry>>>,
    mixmatrix: Arc<Mutex<Option<gst::Element>>>,
}

impl AudioOutputPipelineHandle {
    pub fn connect(&self, flow_id: String) {
        self.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(AudioCommand::Connect(flow_id));
    }

    pub fn disconnect(&self) {
        self.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(AudioCommand::Disconnect);
    }

    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }

    pub fn ptp_synced(&self) -> Option<bool> {
        *self.ptp_synced.lock().expect("lock poisoned")
    }

    /// S. `IngestHandle::set_channel_map`-Doku — hier zusätzlich über
    /// Connect/Disconnect hinweg gemerkt (`desired_map`), weil die
    /// Pipeline bei jedem Connect/Disconnect komplett neu gebaut wird.
    pub fn set_channel_map(&self, map: BTreeMap<u32, MapEntry>) {
        if let Some(element) = &*self.mixmatrix.lock().expect("lock poisoned") {
            element.set_property("matrix", matrix_value_from_map(self.channels, &map));
        }
        *self.desired_map.lock().expect("lock poisoned") = map;
    }
}

struct ActiveAudioOutputPipeline {
    pipeline: gst::Pipeline,
    _input: MxlAudioInput,
    _output: St2110AudioOutput,
    _ptp_clock: Option<gstreamer_net::PtpClock>,
    mixmatrix_cell: Arc<Mutex<Option<gst::Element>>>,
}

impl Drop for ActiveAudioOutputPipeline {
    fn drop(&mut self) {
        *self.mixmatrix_cell.lock().expect("lock poisoned") = None;
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

#[allow(clippy::too_many_arguments)]
fn build_audio_output(
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
) -> Result<ActiveAudioOutputPipeline, String> {
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
                eprintln!("omp-2110-gateway: audio PTP-Domain {domain}: {e}");
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

    Ok(ActiveAudioOutputPipeline {
        pipeline,
        _input: input,
        _output: output,
        _ptp_clock: ptp_clock,
        mixmatrix_cell: mixmatrix_cell.clone(),
    })
}

/// Läuft auf einem eigenen Thread (analog `run_output`), unabhängig vom
/// Video-Ausgang — s. Moduldoku oben.
pub fn run_audio_output(
    config: AudioOutputConfig,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<AudioOutputPipelineHandle, String>>,
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

    let (commands_tx, commands_rx): (Sender<AudioCommand>, Receiver<AudioCommand>) = std::sync::mpsc::channel();
    let flowed = Arc::new(AtomicBool::new(false));
    let ptp_synced = Arc::new(Mutex::new(None));
    let desired_map = Arc::new(Mutex::new(BTreeMap::new()));
    let mixmatrix_cell = Arc::new(Mutex::new(None));
    let _ = ready.send(Ok(AudioOutputPipelineHandle {
        commands: commands_tx,
        flowed: flowed.clone(),
        ptp_synced: ptp_synced.clone(),
        channels: config.channels,
        desired_map: desired_map.clone(),
        mixmatrix: mixmatrix_cell.clone(),
    }));

    let mut active: Option<ActiveAudioOutputPipeline> = None;
    loop {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(AudioCommand::Connect(flow_id)) => {
                active = None;
                match build_audio_output(
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
                    Ok(p) => active = Some(p),
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("audio connect {flow_id} failed: {e}")));
                    }
                }
            }
            Ok(AudioCommand::Disconnect) => {
                active = None;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
