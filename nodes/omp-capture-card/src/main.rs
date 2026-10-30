//! omp-capture-card: SDI/IP-Capture-Karte ⇄ MXL (`UMSETZUNG.md` D10, Kap. 76).
//!
//! **Eine Instanz je Karte, alle gewählten Ports** (wie der Geräte-Hub): `OMP_CARD_PORTS="0:in,0:out,1:in"`
//! erzeugt je Eingang einen Video- und einen Audio-Sender (Karte → MXL) und je Ausgang drei IS-05-Empfänger
//! (Video, Audio, ANC/Untertitel; MXL → Karte). Duplex-Ports bekommen Eingang UND Ausgang gleichzeitig.
//! Die Auswahl trifft der Start-Assistent anhand der erkannten, freien Anschlüsse.
//!
//! Hersteller (`OMP_CARD_VENDOR=decklink|aja|custom`, s. `card.rs`): dieselbe Pipeline-Logik für Blackmagic
//! DeckLink, AJA und SDK-Karten mit eigenem GStreamer-Plugin (Matrox). `--list-cards` gibt die erkannten
//! Anschlüsse als JSON aus (Host-Agent, `detect.rs`).
//!
//! Zustand (BCP-008): ein gemeinsamer Monitor je Instanz — mit Eingängen als Empfänger (Link = alle Eingänge
//! haben Signal), sonst als Sender. Einzelwerte je Port stehen als `in<N>.…`/`out<N>.…`-Parameter.

mod captions;
mod card;
mod detect;
mod pipeline;
mod ports;

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_node_sdk::channelmapping::{
    Channel, ChannelMapApply, ChannelMapping, InputSpec, MapEntry, OutputSpec, CONTROL_TYPE as CM_CONTROL_TYPE,
};
use omp_node_sdk::connection::{
    bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery, ReceiverConnection,
    ReceiverControl, ReceiverResource,
};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, LatencyInfo, LatencyRange, NodeConfig, ParamSpec, ParamStore,
    ParamType, Range, RawResponse, ReceiverSpec, SenderSpec, SetError,
};
use pipeline::SAMPLE_RATE;
use ports::{Dir, PortSel};
use serde_json::Value;

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

/// AMWA IS-08 (`UMSETZUNG.md` D18) — s. `omp-aes67-gateway::main::generic_channels`-Doku.
fn generic_channels(count: u32) -> Vec<Channel> {
    (1..=count.max(1)).map(|n| Channel { label: format!("Channel {n}") }).collect()
}

/// IS-08-Ausgänge aller Ports in einer Zuordnung: die Ausgangs-ID (`mxl-audio-out-<N>` bzw. `sdi-out-<N>`)
/// bestimmt, welche Pipeline die Matrix bekommt.
struct MatrixApply {
    ingest: HashMap<String, pipeline::IngestHandle>,
    output: HashMap<String, pipeline::OutputPipelineHandle>,
}
impl ChannelMapApply for MatrixApply {
    fn apply(&self, output_id: &str, map: &BTreeMap<u32, MapEntry>) {
        if let Some(h) = self.ingest.get(output_id) {
            h.set_channel_map(map);
        } else if let Some(h) = self.output.get(output_id) {
            h.set_channel_map(map.clone());
        }
    }
}

// ---------------------------------------------------------------------
// Ausgang: IS-05-Empfänger
// ---------------------------------------------------------------------

/// Gemeinsam für Video- und Audio-Receiver eines Ausgangs-Ports — löst `sender_id` über die Registry auf eine
/// MXL-`flow_id` auf (wie `omp-2110-gateway::OutputControl`/`omp-recorder`).
struct OutputControl {
    registry: RegistryClient,
    pipeline: pipeline::OutputPipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
    is_video: bool,
    /// Video ist die Anker-Verbindung des Ports: `true` bei Connect, `false` bei Disconnect (Aktivitätszähler).
    on_video: Arc<dyn Fn(bool) + Send + Sync>,
}

impl ReceiverControl for OutputControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        if self.is_video {
                            self.pipeline.connect_video(flow_id);
                            (self.on_video)(true);
                        } else {
                            self.pipeline.connect_audio(flow_id);
                        }
                    }
                    None => eprintln!("omp-capture-card: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-capture-card: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                if self.is_video {
                    self.pipeline.disconnect_video();
                    (self.on_video)(false);
                } else {
                    self.pipeline.disconnect_audio();
                }
            }
        }
    }
}

/// ANC-Eingang des SDI-Ausgangs: ein MXL-Daten-Flow (`video/smpte291`); seine CEA-708-CDPs werden als Untertitel in die
/// VANC-Zeile eingebettet (`captions.rs`). Nur CDPs — andere ANC-Typen kann `decklinkvideosink` nicht einbetten.
struct AncControl {
    registry: RegistryClient,
    context: Arc<omp_mediaio::mxl::MxlContext>,
    queue: Arc<captions::CaptionQueue>,
    connected_flow_id: Arc<Mutex<String>>,
    input: Mutex<Option<omp_mediaio::mxl::MxlDataInput>>,
}

impl ReceiverControl for AncControl {
    fn apply(&self, resource: &ReceiverResource) {
        let flow_id = match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => sender.flow_id,
                Err(e) => {
                    eprintln!("omp-capture-card: resolve anc sender {sender_id} failed: {e}");
                    return;
                }
            },
            _ => None,
        };
        let mut input = self.input.lock().expect("lock poisoned");
        *input = None;
        self.queue.clear();
        *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
        if let Some(flow_id) = flow_id {
            let queue = self.queue.clone();
            match omp_mediaio::mxl::MxlDataInput::new(self.context.clone(), &flow_id, move |grain| queue.feed_grain(grain)) {
                Ok(i) => {
                    *input = Some(i);
                    *self.connected_flow_id.lock().expect("lock poisoned") = flow_id;
                }
                Err(e) => eprintln!("omp-capture-card: anc connect {flow_id} failed: {e}"),
            }
        }
    }
}


// ---------------------------------------------------------------------
// Laufzeitzustand je Port
// ---------------------------------------------------------------------

struct InPort {
    device: i32,
    flow_id: String,
    audio_flow_id: String,
    signal: Arc<AtomicBool>,
    handle: pipeline::IngestHandle,
}

struct OutPort {
    device: i32,
    video: Arc<ReceiverConnection<OutputControl>>,
    audio: Arc<ReceiverConnection<OutputControl>>,
    anc: Arc<ReceiverConnection<AncControl>>,
    connected_video: Arc<Mutex<String>>,
    connected_audio: Arc<Mutex<String>>,
    connected_anc: Arc<Mutex<String>>,
    captions: Arc<captions::CaptionQueue>,
}

/// Teilt `in3.signal` in `("in", 3, "signal")`; `None` bei allem anderen.
fn split_port_param(name: &str) -> Option<(&str, i32, &str)> {
    let (head, rest) = name.split_once('.')?;
    let (kind, num) = if let Some(n) = head.strip_prefix("in") {
        ("in", n)
    } else if let Some(n) = head.strip_prefix("out") {
        ("out", n)
    } else {
        return None;
    };
    Some((kind, num.parse().ok()?, rest))
}

fn spec(name: String, kind: ParamType) -> ParamSpec {
    ParamSpec { name, kind, unit: None, range: None, readonly: true }
}

struct CardStore<A: ChannelMapApply> {
    vendor: String,
    mode: String,
    audio_channels: u32,
    ports_text: String,
    ins: Vec<InPort>,
    outs: Vec<OutPort>,
    monitor: Arc<omp_node_sdk::Monitor>,
    channel_mapping: Arc<ChannelMapping<A>>,
}

impl<A: ChannelMapApply> ParamStore for CardStore<A> {
    fn descriptor(&self) -> Descriptor {
        let mut parameters = vec![
            spec("vendor".into(), ParamType::String),
            ParamSpec {
                name: "mode".to_string(),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum { values: pipeline::SUPPORTED_MODES.iter().map(|m| m.to_string()).collect() }),
                readonly: true,
            },
            spec("audioChannels".into(), ParamType::Number),
            spec("ports".into(), ParamType::String),
        ];
        for p in &self.ins {
            let d = p.device;
            parameters.push(spec(format!("in{d}.signal"), ParamType::Boolean));
            parameters.push(spec(format!("in{d}.flowId"), ParamType::String));
            parameters.push(spec(format!("in{d}.audioFlowId"), ParamType::String));
        }
        for p in &self.outs {
            let d = p.device;
            parameters.push(spec(format!("out{d}.connectedVideoFlowId"), ParamType::String));
            parameters.push(spec(format!("out{d}.connectedAudioFlowId"), ParamType::String));
            parameters.push(spec(format!("out{d}.connectedAncFlowId"), ParamType::String));
            parameters.push(spec(format!("out{d}.ancStats"), ParamType::String));
        }
        parameters.extend(self.monitor.param_specs("monitor"));
        Descriptor {
            // Eine Hardware-Erfassung setzt selbst den Ursprung, wie omp-source.
            latency: (!self.ins.is_empty()).then(|| LatencyInfo {
                video: Some(LatencyRange { min_latency_frames: 0, max_latency_frames: 0 }),
                audio: None,
                data: None,
                supports_delay_compensation: false,
            }),
            parameters,
            methods: self.monitor.method_specs("monitor"),
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "vendor" => return Some(serde_json::json!(self.vendor)),
            "mode" => return Some(serde_json::json!(self.mode)),
            "audioChannels" => return Some(serde_json::json!(self.audio_channels)),
            "ports" => return Some(serde_json::json!(self.ports_text)),
            _ => {}
        }
        if let Some((kind, dev, field)) = split_port_param(name) {
            let s = |m: &Mutex<String>| serde_json::json!(*m.lock().expect("lock poisoned"));
            return match kind {
                "in" => {
                    let p = self.ins.iter().find(|p| p.device == dev)?;
                    match field {
                        "signal" => Some(serde_json::json!(p.signal.load(Ordering::Relaxed))),
                        "flowId" => Some(serde_json::json!(p.flow_id)),
                        "audioFlowId" => Some(serde_json::json!(p.audio_flow_id)),
                        _ => None,
                    }
                }
                _ => {
                    let p = self.outs.iter().find(|p| p.device == dev)?;
                    match field {
                        "connectedVideoFlowId" => Some(s(&p.connected_video)),
                        "connectedAudioFlowId" => Some(s(&p.connected_audio)),
                        "connectedAncFlowId" => Some(s(&p.connected_anc)),
                        "ancStats" => Some(serde_json::json!(
                            serde_json::json!({
                                "embedded": p.captions.embedded.load(Ordering::Relaxed),
                                "dropped": p.captions.dropped.load(Ordering::Relaxed),
                            })
                            .to_string()
                        )),
                        _ => None,
                    }
                }
            };
        }
        // Keine Paketverlust-Erkennung auf SDI/IP-Hardware-Ebene — leere Zählerliste statt erfundener Werte.
        self.monitor.get("monitor", name, None, Vec::new)
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        match self.monitor.set("monitor", name, &value) {
            Some(true) => Ok(()),
            Some(false) => Err(SetError::Unknown),
            None => Err(SetError::Unknown),
        }
    }

    fn invoke(&self, name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        if self.monitor.invoke("monitor", name) { Ok(()) } else { Err(InvokeError::Unknown) }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        if !self.outs.is_empty() {
            let ids: Vec<String> = self
                .outs
                .iter()
                .flat_map(|o| [o.video.id().to_string(), o.audio.id().to_string(), o.anc.id().to_string()])
                .collect();
            let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
            let found = root_discovery(method, path)
                .or_else(|| list_ids(method, path, "receivers", &id_refs))
                .or_else(|| bulk_discovery(method, path))
                .or_else(|| {
                    bulk_patch(method, path, "receivers", body, |id, params| {
                        for o in &self.outs {
                            if o.video.id() == id {
                                return Some(o.video.patch_staged(params).0);
                            }
                            if o.audio.id() == id {
                                return Some(o.audio.patch_staged(params).0);
                            }
                            if o.anc.id() == id {
                                return Some(o.anc.patch_staged(params).0);
                            }
                        }
                        None
                    })
                })
                .or_else(|| bulk_patch(method, path, "senders", body, |_, _| None))
                .or_else(|| {
                    self.outs.iter().find_map(|o| {
                        o.video.handle(method, path, body).or_else(|| o.audio.handle(method, path, body)).or_else(|| o.anc.handle(method, path, body))
                    })
                });
            if let Some(r) = found {
                return Some(to_raw(r));
            }
        }
        self.channel_mapping.handle(method, path, body).map(to_raw)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.outs
            .iter()
            .find_map(|o| o.video.cors_methods(path).or_else(|| o.audio.cors_methods(path)).or_else(|| o.anc.cors_methods(path)))
            .or_else(|| if self.outs.is_empty() { None } else { bulk_cors_methods(path, "senders").or_else(|| bulk_cors_methods(path, "receivers")) })
            .or_else(|| self.channel_mapping.cors_methods(path))
    }
}

/// BCP-008-Tick (1 s). Mit Eingängen: Link/Stream = alle Eingänge haben Signal. Nur Ausgänge: Inhalt = Bilder
/// gehen an die Karte (nur solange ein Ausgang verbunden ist — sonst ist der Monitor `Neutral`).
fn spawn_monitor_tick(
    monitor: Arc<omp_node_sdk::Monitor>,
    signals: Vec<(i32, Arc<AtomicBool>)>,
    outs: Vec<pipeline::OutputPipelineHandle>,
) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let delay = monitor.status_reporting_delay();
            if !signals.is_empty() {
                let missing: Vec<String> =
                    signals.iter().filter(|(_, s)| !s.load(Ordering::Relaxed)).map(|(d, _)| d.to_string()).collect();
                let level = if missing.is_empty() { omp_node_sdk::HealthLevel::Healthy } else { omp_node_sdk::HealthLevel::Unhealthy };
                let msg = format!("kein Eingangssignal an Eingang {}", missing.join(", "));
                monitor.link.observe(level, delay, Some(&msg));
                monitor.content.observe(level, delay, Some(&msg));
                monitor.activity.observe(omp_node_sdk::HealthLevel::Healthy, delay, None);
            } else if monitor.overall() != omp_node_sdk::HealthLevel::Neutral {
                let level = if outs.iter().all(|o| o.media_ready()) { omp_node_sdk::HealthLevel::Healthy } else { omp_node_sdk::HealthLevel::Unhealthy };
                monitor.content.observe(level, delay, Some("keine Bilder an die Karte seit dem letzten Tick"));
                monitor.activity.observe(omp_node_sdk::HealthLevel::Healthy, delay, None);
            }
        }
    });
}

enum NodeEvent {
    Error(String),
    Signal(i32, bool),
}

/// Leitet die Ereignisse einer Pipeline (ohne Port-Angabe) mit Portnummer an den gemeinsamen Kanal weiter.
fn forward(device: i32, all: tokio::sync::mpsc::UnboundedSender<NodeEvent>) -> tokio::sync::mpsc::UnboundedSender<pipeline::Event> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    tokio::spawn(async move {
        while let Some(e) = rx.recv().await {
            let _ = all.send(match e {
                pipeline::Event::Error(m) => NodeEvent::Error(m),
                pipeline::Event::SignalChanged(ok) => NodeEvent::Signal(device, ok),
            });
        }
    });
    tx
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if std::env::args().any(|a| a == "--list-cards") {
        println!("{}", detect::to_json(&detect::scan()));
        return Ok(());
    }
    card::set_backend_from_env()?;
    let label = env_or(
        "OMP_LABEL",
        match card::backend().vendor.as_str() {
            "aja" => "AJA",
            "custom" => "Capture card",
            _ => "DeckLink",
        },
    );
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9330").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let selected: Vec<PortSel> = ports::parse_ports(&env_or("OMP_CARD_PORTS", ""))?;
    let ports_text = ports::format_ports(&selected);
    // Duplex-Karten (DeckLink IP, SDI-Profile `*-full`) erfassen und geben gleichzeitig aus. `PERSISTENT_ID` (hat
    // Vorrang vor der Gerätenummer) gilt nur, wenn die Instanz genau ein Gerät bedient; `PROFILE` wählt das
    // Duplex-Profil der Karte (leer/`default` = unverändert).
    let persistent_id: Option<i64> = match env_or("OMP_CARD_PERSISTENT_ID", "").trim() {
        "" => None,
        v => Some(v.parse()?),
    };
    let devices: std::collections::BTreeSet<i32> = selected.iter().map(|s| s.device).collect();
    let profile = env_or("OMP_CARD_PROFILE", "default");
    pipeline::set_device_select(pipeline::DeviceSelect {
        persistent_id: if devices.len() == 1 { persistent_id } else { None },
        profile: if profile.trim().is_empty() { "default".to_string() } else { profile.trim().to_string() },
    })?;
    let mode = env_or("OMP_CARD_MODE", "1080p25");
    let audio_channels: u32 = env_or("OMP_CARD_AUDIO_CHANNELS", "2").parse()?;
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let mode_info = pipeline::mode_info(&mode).ok_or_else(|| {
        format!("OMP_CARD_MODE={mode:?} nicht unterstützt (unterstützt: {:?})", pipeline::SUPPORTED_MODES)
    })?;

    let (all_tx, mut all_rx) = tokio::sync::mpsc::unbounded_channel::<NodeEvent>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let control_host = host.clone();
    let multi = selected.len() > 1;
    let has_ingest = selected.iter().any(|s| s.dir == Dir::In);

    let monitor = Arc::new(omp_node_sdk::Monitor::new(if has_ingest {
        omp_node_sdk::MonitorKind::Receiver
    } else {
        omp_node_sdk::MonitorKind::Sender
    }));
    if has_ingest {
        monitor.activate();
    } else {
        monitor.deactivate();
    }
    let connected_outs = Arc::new(AtomicUsize::new(0));

    let registry = RegistryClient::new(registry_url.clone());
    let mut threads: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let mut workers: Vec<(String, Arc<AtomicU64>)> = Vec::new();
    let mut ins: Vec<InPort> = Vec::new();
    let mut outs: Vec<OutPort> = Vec::new();
    let mut out_handles: Vec<pipeline::OutputPipelineHandle> = Vec::new();
    let mut senders: Vec<SenderSpec> = Vec::new();
    let mut receivers: Vec<ReceiverSpec> = Vec::new();
    let mut cm_inputs: Vec<InputSpec> = Vec::new();
    let mut cm_outputs: Vec<OutputSpec> = Vec::new();
    let mut apply = MatrixApply { ingest: HashMap::new(), output: HashMap::new() };
    let fail = |threads: Vec<std::thread::JoinHandle<()>>, shutdown: &AtomicBool, msg: String| -> Box<dyn std::error::Error + Send + Sync> {
        shutdown.store(true, Ordering::Relaxed);
        for t in threads {
            let _ = t.join();
        }
        msg.into()
    };

    for sel in &selected {
        let d = sel.device;
        let port_label = if multi { format!("{label} {d}") } else { label.clone() };
        let ptx = forward(d, all_tx.clone());
        let heartbeat = Arc::new(AtomicU64::new(0));
        match sel.dir {
            Dir::In => {
                let flow_id = omp_node_sdk::idgen::new_v4();
                let audio_flow_id = omp_node_sdk::idgen::new_v4();
                let audio_source_id = omp_node_sdk::idgen::new_v4();
                let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
                let cfg = pipeline::IngestConfig {
                    domain: domain.clone(),
                    flow_id: flow_id.clone(),
                    audio_flow_id: audio_flow_id.clone(),
                    label: port_label.clone(),
                    device_number: d,
                    mode: mode.clone(),
                    audio_channels,
                };
                let (sd, hb) = (shutdown.clone(), heartbeat.clone());
                threads.push(std::thread::spawn(move || pipeline::run_ingest(cfg, ptx, sd, ready_tx, hb)));
                let handle = match ready_rx.await {
                    Ok(Ok(h)) => h,
                    Ok(Err(e)) => {
                        eprintln!("omp-capture-card: Eingang {d} (mode={mode}): {e}");
                        return Err(fail(threads, &shutdown, e));
                    }
                    Err(_) => return Err(fail(threads, &shutdown, format!("Eingang {d}: Pipeline-Thread vor Bereitschaft beendet"))),
                };
                let signal = Arc::new(AtomicBool::new(handle.signal()));
                let sdi_in = format!("sdi-in-{d}");
                let mxl_out = format!("mxl-audio-out-{d}");
                cm_inputs.push(InputSpec {
                    id: sdi_in.clone(),
                    name: format!("SDI Embedded Audio {d}"),
                    description: "Eingebettete SDI-Audiokanäle der Karte".to_string(),
                    channels: generic_channels(audio_channels),
                    parent_id: None,
                    parent_type: None,
                    reordering: true,
                    block_size: 1,
                });
                cm_outputs.push(OutputSpec {
                    id: mxl_out.clone(),
                    name: format!("MXL Audio Output {d}"),
                    description: "Ausgehender MXL-Audio-Flow".to_string(),
                    channels: generic_channels(audio_channels),
                    source_id: Some(audio_source_id.clone()),
                    routable_inputs: Some(vec![Some(sdi_in), None]),
                });
                apply.ingest.insert(mxl_out, handle.clone());
                senders.push(SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Video {
                        id: Some(flow_id.clone()),
                        frame_width: mode_info.width,
                        frame_height: mode_info.height,
                        grain_rate_numerator: mode_info.fps_numerator,
                        grain_rate_denominator: mode_info.fps_denominator,
                    }),
                    label: multi.then(|| format!("Eingang {d} – Video")),
                    tags: HashMap::new(),
                    ..Default::default()
                });
                senders.push(SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Audio {
                        id: Some(audio_flow_id.clone()),
                        sample_rate_numerator: SAMPLE_RATE,
                        channel_count: audio_channels,
                        media_type: "audio/float32".to_string(),
                        bit_depth: 32,
                        source_id: Some(audio_source_id),
                    }),
                    label: multi.then(|| format!("Eingang {d} – Audio")),
                    ..Default::default()
                });
                workers.push((format!("pipeline-in{d}"), heartbeat));
                ins.push(InPort { device: d, flow_id, audio_flow_id, signal, handle });
            }
            Dir::Out => {
                let captions = captions::CaptionQueue::new();
                let anc_context = Arc::new(omp_mediaio::mxl::MxlContext::new(&domain)?);
                let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
                let cfg = pipeline::OutputConfig {
                    domain: domain.clone(),
                    device_number: d,
                    mode: mode.clone(),
                    audio_channels,
                    captions: captions.clone(),
                };
                let (sd, hb) = (shutdown.clone(), heartbeat.clone());
                threads.push(std::thread::spawn(move || pipeline::run_output(cfg, ptx, sd, ready_tx, hb)));
                let handle = match ready_rx.await {
                    Ok(Ok(h)) => h,
                    Ok(Err(e)) => {
                        eprintln!("omp-capture-card: Ausgang {d}: {e}");
                        return Err(fail(threads, &shutdown, e));
                    }
                    Err(_) => return Err(fail(threads, &shutdown, format!("Ausgang {d}: Pipeline-Thread vor Bereitschaft beendet"))),
                };
                let (video_id, audio_id, anc_id) =
                    (omp_node_sdk::idgen::new_v4(), omp_node_sdk::idgen::new_v4(), omp_node_sdk::idgen::new_v4());
                let (connected_video, connected_audio, connected_anc) =
                    (Arc::new(Mutex::new(String::new())), Arc::new(Mutex::new(String::new())), Arc::new(Mutex::new(String::new())));
                // Aktivität: mit Eingängen immer aktiv; nur mit Ausgängen aktiv, solange mindestens ein Video verbunden ist.
                let was = Arc::new(AtomicBool::new(false));
                let on_video: Arc<dyn Fn(bool) + Send + Sync> = {
                    let (monitor, connected_outs, was) = (monitor.clone(), connected_outs.clone(), was.clone());
                    Arc::new(move |on| {
                        if was.swap(on, Ordering::Relaxed) == on {
                            return;
                        }
                        let n = if on { connected_outs.fetch_add(1, Ordering::Relaxed) + 1 } else { connected_outs.fetch_sub(1, Ordering::Relaxed) - 1 };
                        if !has_ingest {
                            if n > 0 { monitor.activate() } else { monitor.deactivate() }
                        }
                    })
                };
                let video = Arc::new(ReceiverConnection::new(
                    video_id.clone(),
                    OutputControl {
                        registry: registry.clone(),
                        pipeline: handle.clone(),
                        connected_flow_id: connected_video.clone(),
                        is_video: true,
                        on_video,
                    },
                ));
                let audio = Arc::new(ReceiverConnection::new(
                    audio_id.clone(),
                    OutputControl {
                        registry: registry.clone(),
                        pipeline: handle.clone(),
                        connected_flow_id: connected_audio.clone(),
                        is_video: false,
                        on_video: Arc::new(|_| {}),
                    },
                ));
                let anc = Arc::new(ReceiverConnection::new(
                    anc_id.clone(),
                    AncControl {
                        registry: registry.clone(),
                        context: anc_context,
                        queue: captions.clone(),
                        connected_flow_id: connected_anc.clone(),
                        input: Mutex::new(None),
                    },
                ));
                let mxl_in = format!("mxl-audio-in-{d}");
                let sdi_out = format!("sdi-out-{d}");
                // IS-08: "mxl-audio-in" hängt am registrierten IS-04-Audio-Receiver (`parent`); "sdi-out" hat keine
                // Source (die Karte ist ein physischer Ausgang, keine NMOS-Ressource).
                cm_inputs.push(InputSpec {
                    id: mxl_in.clone(),
                    name: format!("MXL Audio Input {d}"),
                    description: "Ausgewählte MXL-Audioquelle".to_string(),
                    channels: generic_channels(audio_channels),
                    parent_id: Some(audio_id.clone()),
                    parent_type: Some("receiver"),
                    reordering: true,
                    block_size: 1,
                });
                cm_outputs.push(OutputSpec {
                    id: sdi_out.clone(),
                    name: format!("SDI Embedded Audio Output {d}"),
                    description: "Eingebettete SDI-Audiokanäle der Karte".to_string(),
                    channels: generic_channels(audio_channels),
                    source_id: None,
                    routable_inputs: Some(vec![Some(mxl_in), None]),
                });
                apply.output.insert(sdi_out, handle.clone());
                let rl = |what: &str| if multi { Some(format!("Ausgang {d} – {what}")) } else { Some(what.to_string()) };
                for (id, mt, what) in [
                    (video_id, "video/v210", "Video"),
                    (audio_id, "audio/L24", "Audio"),
                    (anc_id, "video/smpte291", "ANC / Untertitel"),
                ] {
                    receivers.push(ReceiverSpec {
                        id: Some(id),
                        transport: Some(TRANSPORT_MXL.to_string()),
                        media_types: Some(vec![mt.to_string()]),
                        label: rl(what),
                        ..Default::default()
                    });
                }
                workers.push((format!("pipeline-out{d}"), heartbeat));
                out_handles.push(handle);
                outs.push(OutPort { device: d, video, audio, anc, connected_video, connected_audio, connected_anc, captions });
            }
        }
    }
    drop(all_tx);

    spawn_monitor_tick(monitor.clone(), ins.iter().map(|p| (p.device, p.signal.clone())).collect(), out_handles.clone());

    let signals: HashMap<i32, Arc<AtomicBool>> = ins.iter().map(|p| (p.device, p.signal.clone())).collect();
    let ready_handles: Vec<pipeline::IngestHandle> = ins.iter().map(|p| p.handle.clone()).collect();
    let channel_mapping = Arc::new(ChannelMapping::new(cm_inputs, cm_outputs, apply));
    let store: Arc<dyn ParamStore> = Arc::new(CardStore {
        vendor: card::backend().vendor.clone(),
        mode: mode.clone(),
        audio_channels,
        ports_text,
        ins,
        outs,
        monitor: monitor.clone(),
        channel_mapping,
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders,
            receivers,
            instance_id,
            // Echter Nachweis geflossener Buffer: jeder Eingang hat ein Bild gesehen; Ausgänge sind im Leerlauf bereit.
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                ready_handles.iter().all(|h| h.media_ready()) && out_handles.iter().all(|h| h.media_ready())
            })),
        },
        store,
    )
    .await?;

    // AMWA IS-08 (`UMSETZUNG.md` D18) — erst nach `start()` möglich (`handle.port` steht dann fest).
    if let Err(e) = handle
        .add_device_control(serde_json::json!({
            "type": CM_CONTROL_TYPE,
            "href": format!("http://{control_host}:{}/x-nmos/channelmapping/v1.0/", handle.port),
        }))
        .await
    {
        eprintln!("omp-capture-card: announcing channelmapping control failed: {e}");
    }
    for (name, hb) in workers {
        handle.register_worker(name, hb);
    }

    let events = async {
        while let Some(event) = all_rx.recv().await {
            match event {
                NodeEvent::Error(message) => {
                    // Fehlercode [OMP-nnnn] voranstellen, wenn die Meldung einem Katalogeintrag entspricht (Kap. 72.8)
                    let message = omp_node_sdk::errcode::tag(&message);
                    eprintln!("omp-capture-card: pipeline error: {message}");
                    if monitor.overall() != omp_node_sdk::HealthLevel::Neutral {
                        monitor.activity.observe(omp_node_sdk::HealthLevel::Unhealthy, monitor.status_reporting_delay(), Some(&message));
                    }
                    handle.publish_alert(message).await;
                }
                NodeEvent::Signal(device, ok) => {
                    if let Some(s) = signals.get(&device) {
                        s.store(ok, Ordering::Relaxed);
                    }
                    eprintln!("omp-capture-card: signal [{device}]: {}", if ok { "OK" } else { "KEIN SIGNAL" });
                    if !ok {
                        handle.publish_alert(format!("Capture-Karte, Eingang {device}: kein Eingangssignal")).await;
                    }
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-capture-card: shutdown requested"),
        _ = events => eprintln!("omp-capture-card: pipeline threads ended"),
    }

    shutdown.store(true, Ordering::Relaxed);
    for t in threads {
        let _ = t.join();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoopApply;
    impl ChannelMapApply for NoopApply {
        fn apply(&self, _output_id: &str, _map: &BTreeMap<u32, MapEntry>) {}
    }

    fn store() -> CardStore<NoopApply> {
        CardStore {
            vendor: "decklink".to_string(),
            mode: "1080p25".to_string(),
            audio_channels: 2,
            ports_text: "0:in".to_string(),
            ins: vec![],
            outs: vec![],
            monitor: Arc::new(omp_node_sdk::Monitor::new(omp_node_sdk::MonitorKind::Receiver)),
            channel_mapping: Arc::new(ChannelMapping::new(vec![], vec![], NoopApply)),
        }
    }

    #[test]
    fn descriptor_includes_bcp008_monitor_params_and_methods() {
        let d = store().descriptor();
        let names: Vec<&str> = d.parameters.iter().map(|p| p.name.as_str()).collect();
        for n in ["monitor.overallStatus", "monitor.connectionStatus", "monitor.streamStatus", "monitor.linkStatus", "monitor.statusReportingDelay", "vendor", "ports"] {
            assert!(names.contains(&n), "{n} fehlt");
        }
        assert_eq!(d.methods.len(), 1);
        assert_eq!(d.methods[0].name, "monitor.resetCountersAndMessages");
    }

    #[test]
    fn get_dispatches_own_and_monitor_params() {
        let s = store();
        assert_eq!(s.get("vendor"), Some(serde_json::json!("decklink")));
        assert_eq!(s.get("in0.signal"), None, "Port ohne Eingang");
        s.monitor.activate();
        assert_eq!(s.get("monitor.overallStatus"), Some(serde_json::json!("Healthy")));
        assert_eq!(s.get("monitor.lostPacketCounters"), Some(serde_json::json!([])));
    }

    #[test]
    fn set_and_invoke_reach_the_monitor() {
        let s = store();
        assert!(s.set("monitor.statusReportingDelay", serde_json::json!(5000)).is_ok());
        assert_eq!(s.monitor.status_reporting_delay(), Duration::from_millis(5000));
        assert!(matches!(s.set("monitor.overallStatus", serde_json::json!("Healthy")), Err(SetError::Unknown)));
        s.monitor.link.observe(omp_node_sdk::HealthLevel::Unhealthy, Duration::ZERO, Some("no cable"));
        assert!(s.invoke("monitor.resetCountersAndMessages", &serde_json::Map::new()).is_ok());
        assert_eq!(s.monitor.link.transition_counter(), 0);
        assert!(matches!(s.invoke("unknownMethod", &serde_json::Map::new()), Err(InvokeError::Unknown)));
    }

    #[test]
    fn port_params_split() {
        assert_eq!(split_port_param("in3.signal"), Some(("in", 3, "signal")));
        assert_eq!(split_port_param("out12.ancStats"), Some(("out", 12, "ancStats")));
        assert_eq!(split_port_param("monitor.overallStatus"), None);
        assert_eq!(split_port_param("inx.signal"), None);
    }

    #[test]
    fn matrix_apply_routes_by_output_id_without_panicking() {
        let a = MatrixApply { ingest: HashMap::new(), output: HashMap::new() };
        a.apply("unbekannt", &BTreeMap::new());
    }
}
