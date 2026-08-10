//! omp-viewer: MXL → Bild (`UMSETZUNG.md` C6). Zweiter der drei
//! MXL-Demo-Services (`docs/decisions.md`, 2026-07-09): zeigt einen per
//! IS-05-Receiver-PATCH gewählten MXL-Flow headless über MJPEG-über-HTTP
//! an (PIPELINE CONTROLLERs bewährtes Preview-Muster,
//! `lib/PreviewPipeline.js`). Quellwahl über `sender_id` (nicht per
//! Kommandozeile) — dadurch funktioniert Drag & Drop im bestehenden
//! Flow-Editor (B3) sofort, ohne Orchestrator-Änderung.

mod audio_meters;
mod pipeline;
mod uibundle;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use omp_mediaio::levels;
use omp_mediaio::mxl::MxlContext;
use omp_mediaio::preview;
use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, NodeHandle, ParamSpec, ParamStore,
    ParamType, RawResponse, ReceiverSpec, SetError,
};
use serde_json::Value;

/// Setzt IS-05-PATCHes (Quellwahl) auf die Pipeline um: löst `sender_id`
/// über die Registry-Query-API zu einer MXL-`flow_id` auf (Konvention
/// Flow-UUID == MXL-`flow-id`, `UMSETZUNG.md` C4) und lässt die Pipeline
/// neu aufbauen. Ein leerer/abwesender `sender_id` (oder
/// `master_enable=false`) trennt.
struct ViewerControl {
    registry: RegistryClient,
    pipeline: pipeline::PipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
}

impl ReceiverControl for ViewerControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        self.pipeline.connect(flow_id, sender.label);
                    }
                    None => eprintln!("omp-viewer: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-viewer: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                self.pipeline.disconnect();
            }
        }
    }
}

/// Setzt IS-05-PATCHes auf einen dynamisch per `addAudioInput`
/// angelegten Audio-Eingang um (2026-08-06) — gleiches Muster wie
/// `ViewerControl`, aber ohne Pipeline-Neuaufbau: `AudioMeterHandle::
/// add_input`/`remove_input` bauen nur den EINEN betroffenen
/// Meter-Zweig chirurgisch an-/ab (s. `audio_meters.rs`-Moduldoku).
struct AudioInputControl {
    input_id: String,
    registry: RegistryClient,
    meter: audio_meters::AudioMeterHandle,
}

impl ReceiverControl for AudioInputControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => self.meter.add_input(self.input_id.clone(), flow_id),
                    None => eprintln!("omp-viewer: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-viewer: resolve sender {sender_id} failed: {e}"),
            },
            _ => self.meter.remove_input(self.input_id.clone()),
        }
    }
}

struct AudioInputEntry {
    label: String,
    connection: Arc<ReceiverConnection<AudioInputControl>>,
}

/// Kommandos von `ViewerStore::invoke` (synchroner HTTP-Handler-Kontext,
/// s. `omp_node_sdk::server`) an `audio_input_worker` (asynchroner Task
/// auf demselben `current_thread`-Runtime wie `main()`) — `add_receiver`/
/// `remove_receiver` sind async (registrieren bei der Registry über
/// `spawn_blocking`), `ParamStore::invoke` selbst ist aber bewusst
/// synchron (Trait-Signatur, `omp_node_sdk::server`) und läuft auf einem
/// `tiny_http`-Worker-Thread, nicht auf dem Tokio-Runtime-Thread — ein
/// `Handle::block_on` von dort auf einen `current_thread`-Runtime würde
/// dort zuverlässig fehlschlagen (nur der Thread, der den Runtime
/// ursprünglich getrieben hat, darf `block_on`en). Tokios
/// `UnboundedSender::send` ist dagegen ein normaler synchroner Aufruf,
/// von jedem Thread sicher nutzbar — dieselbe Brücke, die `pipeline.rs`
/// bereits für `pipeline::Event` in die andere Richtung nutzt.
enum ViewerCommand {
    AddAudioInput { label: Option<String> },
    RemoveAudioInput { id: String },
}

struct ViewerStore {
    connected_flow_id: Arc<Mutex<String>>,
    preview_url: String,
    connection: Arc<ReceiverConnection<ViewerControl>>,
    levels_url: String,
    audio_inputs: Arc<Mutex<HashMap<String, AudioInputEntry>>>,
    commands: tokio::sync::mpsc::UnboundedSender<ViewerCommand>,
}

impl ParamStore for ViewerStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                ParamSpec {
                    name: "connectedFlowId".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "previewUrl".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                // JSON-SSE-Strom {inputId,rms,peak} — ein Port für ALLE
                // dynamischen Audio-Eingänge (s. audio_meters.rs-
                // Moduldoku "teilen sich EINEN Broadcaster").
                ParamSpec {
                    name: "levelsUrl".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                // JSON-Array [{id,label}] — die aktuell angelegten
                // Audio-Eingänge (2026-08-06, dynamische Eingangszahl).
                ParamSpec {
                    name: "audioInputs".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
            ],
            methods: vec![
                MethodSpec {
                    name: "addAudioInput".to_string(),
                    args: vec![MethodArg { name: "label".to_string(), kind: ParamType::String }],
                },
                MethodSpec {
                    name: "removeAudioInput".to_string(),
                    args: vec![MethodArg { name: "id".to_string(), kind: ParamType::String }],
                },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "connectedFlowId" => Some(serde_json::json!(
                *self.connected_flow_id.lock().expect("lock poisoned")
            )),
            "previewUrl" => Some(serde_json::json!(self.preview_url)),
            "levelsUrl" => Some(serde_json::json!(self.levels_url)),
            "audioInputs" => Some(serde_json::json!(
                self.audio_inputs
                    .lock()
                    .expect("lock poisoned")
                    .iter()
                    .map(|(id, entry)| serde_json::json!({"id": id, "label": entry.label}))
                    .collect::<Vec<_>>()
            )),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "addAudioInput" => {
                let label = args
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                self.commands
                    .send(ViewerCommand::AddAudioInput { label })
                    .map_err(|_| InvokeError::Unknown)
            }
            "removeAudioInput" => {
                let id = args.get("id").and_then(Value::as_str).ok_or(InvokeError::Unknown)?.to_string();
                self.commands
                    .send(ViewerCommand::RemoveAudioInput { id })
                    .map_err(|_| InvokeError::Unknown)
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if let Some((status, content_type, body)) = self.connection.handle(method, path, body) {
            return Some(RawResponse {
                status,
                content_type,
                body,
            });
        }
        {
            let audio_inputs = self.audio_inputs.lock().expect("lock poisoned");
            for entry in audio_inputs.values() {
                if let Some((status, content_type, body)) = entry.connection.handle(method, path, body) {
                    return Some(RawResponse {
                        status,
                        content_type,
                        body,
                    });
                }
            }
        }
        uibundle::route(method, path)
    }
}

/// Verarbeitet `ViewerCommand`s asynchron (s. dortige Doku) — läuft als
/// eigener Tokio-Task auf demselben `current_thread`-Runtime wie
/// `main()`, solange der Node lebt.
async fn audio_input_worker(
    mut commands: tokio::sync::mpsc::UnboundedReceiver<ViewerCommand>,
    handle: NodeHandle,
    registry: RegistryClient,
    meter: audio_meters::AudioMeterHandle,
    audio_inputs: Arc<Mutex<HashMap<String, AudioInputEntry>>>,
) {
    while let Some(cmd) = commands.recv().await {
        match cmd {
            ViewerCommand::AddAudioInput { label } => {
                let receiver_id = omp_node_sdk::idgen::new_v4();
                let spec = ReceiverSpec {
                    id: Some(receiver_id.clone()),
                    transport: Some(TRANSPORT_MXL.to_string()),
                    media_types: Some(vec!["audio/float32".to_string()]),
                    label,
                };
                match handle.add_receiver(spec).await {
                    Ok(receiver) => {
                        let connection = Arc::new(ReceiverConnection::new(
                            receiver_id.clone(),
                            AudioInputControl {
                                input_id: receiver_id.clone(),
                                registry: registry.clone(),
                                meter: meter.clone(),
                            },
                        ));
                        audio_inputs.lock().expect("lock poisoned").insert(
                            receiver_id,
                            AudioInputEntry { label: receiver.label, connection },
                        );
                    }
                    Err(e) => eprintln!("omp-viewer: addAudioInput failed: {e}"),
                }
            }
            ViewerCommand::RemoveAudioInput { id } => {
                audio_inputs.lock().expect("lock poisoned").remove(&id);
                meter.remove_input(id.clone());
                if let Err(e) = handle.remove_receiver(&id).await {
                    eprintln!("omp-viewer: removeAudioInput failed: {e}");
                }
            }
        }
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Viewer");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9340").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Default 0 (freier Port vom OS) statt eines festen Ports: mehrere
    // vom Instanz-Launcher gestartete Viewer (`UMSETZUNG.md` C8) dürfen
    // sich sonst genau wie bei `OMP_PORT` keinen festen Port teilen.
    // `previewUrl` (unten) macht den tatsächlichen Port für die UI
    // ohnehin dynamisch sichtbar, ein fester Default hätte hier keinen
    // Mehrwert mehr.
    let preview_port: u16 = env_or("OMP_VIEWER_PREVIEW_PORT", "0").parse()?;
    let sink_element = std::env::var("OMP_VIEWER_SINK").ok();
    // Vom Instanz-Launcher gesetzt (`UMSETZUNG.md` C8), sonst leer bei
    // manuellem Start.
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    // Wie bei playouts Sender-ID (C3): die Receiver-ID wird hier erzeugt,
    // weil der IS-05-Receiver-Connection-Endpoint (ReceiverConnection)
    // schon vor start() unter der endgültigen ID verdrahtet sein muss.
    let receiver_id = omp_node_sdk::idgen::new_v4();

    let broadcaster = Arc::new(preview::Broadcaster::new());
    let actual_preview_port =
        preview::spawn(&format!("0.0.0.0:{preview_port}"), broadcaster.clone())?;
    let preview_url = format!("http://{host}:{actual_preview_port}/preview");

    // Eigener SSE-Port für die Pegelanzeigen dynamischer Audio-Eingänge
    // (2026-08-06, s. `audio_meters.rs`-Moduldoku) — dieselbe, bereits
    // etablierte Wahl (`omp_mediaio::levels`) wie bei `omp-audio-mixer`.
    let levels_port: u16 = env_or("OMP_VIEWER_LEVELS_PORT", "0").parse()?;
    let levels_broadcaster = Arc::new(levels::Broadcaster::new());
    let actual_levels_port = levels::spawn(&format!("0.0.0.0:{levels_port}"), levels_broadcaster.clone())?;
    let levels_url = format!("http://{host}:{actual_levels_port}/levels");

    // EIN `MxlContext` für den ganzen Prozess (2026-08-07, root-caused
    // Fix für den zuvor offenen Meter-Rest-Bug, s. `audio_meters.rs`-
    // Moduldoku): `pipeline::run` und `audio_meters::run` laufen auf
    // getrennten Threads, dürfen sich die MXL-Domain-Instanz aber NICHT
    // je selbst ein zweites Mal öffnen — s. dortige Doku.
    let mxl_context = match MxlContext::new(&domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            eprintln!("omp-viewer: MxlContext::new failed: {e}");
            return Err(e.into());
        }
    };

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config { sink_element };
    let pipeline_shutdown = shutdown.clone();
    let broadcaster_for_pipeline = broadcaster.clone();
    let context_for_pipeline = mxl_context.clone();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(
            pipeline_config,
            context_for_pipeline,
            broadcaster_for_pipeline,
            tx,
            pipeline_shutdown,
            ready_tx,
            pipeline_heartbeat_thread,
        )
    });

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-viewer: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-viewer: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let media_ready_pipeline = pipeline_handle.clone();
    let connected_flow_id = Arc::new(Mutex::new(String::new()));
    let connection = Arc::new(ReceiverConnection::new(
        receiver_id.clone(),
        ViewerControl {
            registry: RegistryClient::new(registry_url.clone()),
            pipeline: pipeline_handle,
            connected_flow_id: connected_flow_id.clone(),
        },
    ));

    let audio_inputs: Arc<Mutex<HashMap<String, AudioInputEntry>>> = Arc::new(Mutex::new(HashMap::new()));
    let (commands_tx, commands_rx) = tokio::sync::mpsc::unbounded_channel::<ViewerCommand>();

    let store: Arc<dyn ParamStore> = Arc::new(ViewerStore {
        connected_flow_id,
        preview_url,
        connection,
        levels_url,
        audio_inputs: audio_inputs.clone(),
        commands: commands_tx,
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url: registry_url.clone(),
            nats_url,
            senders: vec![],
            receivers: vec![ReceiverSpec {
                id: Some(receiver_id),
                transport: Some(TRANSPORT_MXL.to_string()),
                media_types: Some(vec!["video/v210".to_string()]),
                ..Default::default()
            }],
            instance_id,
            // "media-ready" über PipelineHandle::media_ready()
            // (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2) — false vor
            // dem ersten Connect und direkt nach jedem Quellwechsel, bis
            // der neu verbundene Input nachweislich einen Buffer liefert.
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready_pipeline.media_ready()
            })),
        },
        store,
    )
    .await?;

    // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
    // Nachtrag 130/131).
    handle.register_worker("pipeline", pipeline_heartbeat);

    // Zweite, unabhängige Pipeline nur für Audio-Eingangs-Pegel (s.
    // `audio_meters.rs`-Moduldoku, warum getrennt vom Video-Pfad oben).
    // Bug 2026-08-07 (docs/decisions.md Nachtrag 123, `LivenessMonitor`
    // seit 2026-08-10): dieser Thread-Spawn wurde extra bis NACH
    // `omp_node_sdk::start()` verschoben (vorher direkt nach dem
    // `MxlContext`-Aufbau, vor `start()`), damit `handle.register_worker`
    // unten zur Verfügung steht — die genau hier lebende Reader-Thread-
    // Klasse war der Auslöser für den Liveness-Mechanismus.
    let (level_tx, mut level_rx) = tokio::sync::mpsc::unbounded_channel::<audio_meters::LevelEvent>();
    let meter_shutdown = shutdown.clone();
    let (meter_ready_tx, meter_ready_rx) = tokio::sync::oneshot::channel();
    let meter_node_handle = handle.clone();
    let meter_thread = std::thread::spawn(move || {
        audio_meters::run(mxl_context, level_tx, meter_shutdown, meter_ready_tx, meter_node_handle)
    });
    let meter_handle = match meter_ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-viewer: audio meter pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-viewer: audio meter thread ended before reporting readiness");
            return Err("audio meter thread ended before reporting readiness".into());
        }
    };
    tokio::spawn(async move {
        while let Some(event) = level_rx.recv().await {
            let json = serde_json::json!({
                "inputId": event.input_id,
                "rms": event.rms,
                "peak": event.peak,
            })
            .to_string();
            levels_broadcaster.publish(&json);
        }
    });

    // Erst jetzt verfügbar (braucht `handle` aus `start()`) — s.
    // `ViewerCommand`-Doku zur Sync/Async-Brücke.
    tokio::spawn(audio_input_worker(
        commands_rx,
        handle.clone(),
        RegistryClient::new(registry_url),
        meter_handle,
        audio_inputs,
    ));

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-viewer: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-viewer: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-viewer: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();
    let _ = meter_thread.join();

    Ok(())
}
