//! omp-audio-monitor (Nutzerwunsch 2026-07-29: "wir müssen auch das
//! audio abhören können. kann der viewer auch audio oder brauchen wir
//! ein audio monitoring node?"): liest eine per Drag & Drop (oder per
//! `selectSource`-Gruppenwahl-Dropdown, s. u.) verbundene MXL-
//! Audioquelle beliebigen Kanal-/Abtastformats und stellt sie zum
//! Abhören im Browser bereit — exaktes Strukturmuster von `omp-viewer`
//! (MJPEG-Vorschau), hier Audio statt Video. Eigener Node statt
//! Audio-Ausgabe direkt in `omp-viewer`: Letzterer liefert Video als
//! MJPEG-Bildstrom zum Browser — ein grundverschiedener
//! Transportmechanismus, der sich nicht einfach um Audio erweitern
//! lässt (`omp-viewer`s eigene, 2026-08-06 hinzugekommene dynamische
//! Audio-Eingänge liefern bewusst nur Pegelanzeigen, kein hörbares
//! Audio — genau diese Lücke füllt dieser Node).
//!
//! **2026-08-06 redesignt** (Nutzerwunsch: "der audio monitor ... sollte
//! wie der viewer ohne einen html player auskommen, direkt das audio
//! ausgeben"): rohes PCM-über-chunked-HTTP (`omp_mediaio::pcm_stream`)
//! statt MP3, im UI-Bundle per `AudioContext`+`AudioWorklet` abgespielt
//! statt eines sichtbaren `<audio controls>`-Elements — niedrigere
//! Latenz (kein Encoder-Lookahead) und dieselbe nahtlose, unsichtbare
//! Wiedergabe-Erfahrung wie `omp-viewer`s `<img>`. Zusätzlich ein
//! Live-Discovery-Dropdown ("Gruppenwahl") im eigenen Panel, das die
//! Quelle per `selectSource`-Methode umschaltet, ohne den Flow-Editor-
//! Graph neu verkabeln zu müssen.
//!
//! Deckt außerdem die bereits in `docs/decisions.md`
//! (2026-07-14-Entscheidungssitzung, K4) getroffene, bis jetzt nicht
//! umgesetzte Entscheidung "Solo/PFL wird gebaut (Monitor-Summe +
//! lokale Wiedergabe)" ab: `omp-audio-mixer`s Monitor-Bus (Pre-Listen,
//! s. dortiges `channel.<id>.pfl`) ist bereits ein ganz normaler MXL-
//! Audio-Sender und taucht damit automatisch im `selectSource`-Dropdown
//! auf, keine Sonderfall-Logik nötig.

mod pipeline;
mod uibundle;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use omp_mediaio::pcm_stream;
use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::{self, RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    RawResponse, ReceiverSpec, SetError,
};
use serde_json::Value;

/// Gemeinsame Verbindungslogik zwischen einem echten IS-05-PATCH
/// (`MonitorControl::apply`, per Drag & Drop im Flow-Editor) und der
/// neuen direkten `selectSource`-Methode (2026-08-06, Nutzerwunsch
/// "Gruppenwahl": ein Live-Discovery-Dropdown im eigenen Panel statt
/// manuellem Neu-Verkabeln bei jedem Quellwechsel) — beide lösen
/// `sender_id` über dieselbe Registry-Query-API zur `flow_id` auf und
/// verbinden dieselbe Pipeline; nur der Auslöser unterscheidet sich.
fn connect_to_sender(
    registry: &RegistryClient,
    pipeline: &pipeline::PipelineHandle,
    connected_flow_id: &Mutex<String>,
    connected_label: &Mutex<String>,
    sender_id: &str,
) {
    match registry.get_sender(sender_id) {
        Ok(sender) => match sender.flow_id {
            Some(flow_id) => {
                *connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                *connected_label.lock().expect("lock poisoned") = sender.label;
                pipeline.connect(flow_id);
            }
            None => eprintln!("omp-audio-monitor: sender {sender_id} has no flow_id"),
        },
        Err(e) => eprintln!("omp-audio-monitor: resolve sender {sender_id} failed: {e}"),
    }
}

fn disconnect(pipeline: &pipeline::PipelineHandle, connected_flow_id: &Mutex<String>, connected_label: &Mutex<String>) {
    *connected_flow_id.lock().expect("lock poisoned") = String::new();
    *connected_label.lock().expect("lock poisoned") = String::new();
    pipeline.disconnect();
}

/// Setzt IS-05-PATCHes (Quellwahl per Drag & Drop) auf die Pipeline um —
/// identisches Muster zu `omp-viewer::main::ViewerControl`. Ein leerer/
/// abwesender `sender_id` (oder `master_enable=false`) trennt.
struct MonitorControl {
    registry: RegistryClient,
    pipeline: pipeline::PipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
    connected_label: Arc<Mutex<String>>,
}

impl ReceiverControl for MonitorControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => connect_to_sender(
                &self.registry,
                &self.pipeline,
                &self.connected_flow_id,
                &self.connected_label,
                sender_id,
            ),
            _ => disconnect(&self.pipeline, &self.connected_flow_id, &self.connected_label),
        }
    }
}

/// Discovery aller aktuell registrierten MXL-Audio-Sender, die sich als
/// Abhörquelle eignen (2026-08-06, "Gruppenwahl"-Dropdown) — identisches
/// Filtermuster zu `omp-player::discovery::discover` (dort separat
/// gehalten statt eines gemeinsamen SDK-Helfers, s. dortige Moduldoku
/// "eine vierte, bewusst separate Kopie" — dieser Node ist die fünfte,
/// aus demselben Grund: keine verfrühte Abstraktion). Bewusst
/// synchron/blockierend (läuft auf dem `tiny_http`-Worker-Thread des
/// `GET /params/availableSources`-Aufrufs, nicht auf dem Tokio-Runtime-
/// Thread) statt eines eigenen Hintergrund-Poll-Threads — derselbe
/// Aufrufkontext, in dem `MonitorControl::apply` bereits synchron gegen
/// die Registry auflöst.
fn discover_audio_sources(registry: &RegistryClient) -> Vec<(String, String)> {
    let Ok(senders) = registry.list_senders() else { return Vec::new() };
    senders
        .into_iter()
        .filter(|s| s.transport == TRANSPORT_MXL)
        .filter_map(|s| {
            let flow_id = s.flow_id.as_ref()?;
            if !matches!(registry.get_flow_format(flow_id), Ok(f) if f == is04::FORMAT_AUDIO) {
                return None;
            }
            Some((s.id, s.label))
        })
        .collect()
}

struct MonitorStore {
    connected_flow_id: Arc<Mutex<String>>,
    connected_label: Arc<Mutex<String>>,
    audio_stream_url: String,
    connection: Arc<ReceiverConnection<MonitorControl>>,
    registry: RegistryClient,
    own_receiver_id: String,
}

impl ParamStore for MonitorStore {
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
                    name: "connectedLabel".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "audioStreamUrl".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                // JSON-Array [{senderId,label}] — "Gruppenwahl"-Dropdown
                // (2026-08-06): alle aktuell discoverbaren MXL-Audio-
                // Sender, unabhängig davon, ob per Flow-Editor-Graph
                // verbunden (s. `selectSource` unten).
                ParamSpec {
                    name: "availableSources".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
            ],
            methods: vec![MethodSpec {
                name: "selectSource".to_string(),
                args: vec![MethodArg { name: "senderId".to_string(), kind: ParamType::String }],
            }],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "connectedFlowId" => Some(serde_json::json!(
                *self.connected_flow_id.lock().expect("lock poisoned")
            )),
            "connectedLabel" => Some(serde_json::json!(
                *self.connected_label.lock().expect("lock poisoned")
            )),
            "audioStreamUrl" => Some(serde_json::json!(self.audio_stream_url)),
            "availableSources" => Some(serde_json::json!(
                discover_audio_sources(&self.registry)
                    .into_iter()
                    .map(|(sender_id, label)| serde_json::json!({"senderId": sender_id, "label": label}))
                    .collect::<Vec<_>>()
            )),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        if name != "selectSource" {
            return Err(InvokeError::Unknown);
        }
        let sender_id = args.get("senderId").and_then(Value::as_str).unwrap_or("");
        // Über den echten IS-05-`PATCH .../staged`-Pfad statt direkt
        // `connect_to_sender()` aufzurufen: hält den Connection-Zustand
        // (`staged`/`active`, von `ReceiverConnection` selbst geführt)
        // konsistent mit der tatsächlichen Verbindung — sonst zeigt ein
        // danach geöffnetes generisches Panel (liest `GET .../single/
        // receivers/<id>/active`) eine veraltete `sender_id`.
        // `master_enable` synthetisch gesetzt: dieselbe Semantik wie ein
        // echter Drag&Drop-Connect im Flow-Editor.
        let body = serde_json::json!({
            "sender_id": if sender_id.is_empty() { None } else { Some(sender_id) },
            "master_enable": !sender_id.is_empty(),
            "activation": {"mode": "activate_immediate"},
        });
        let path = format!("/x-nmos/connection/v1.1/single/receivers/{}/staged", self.own_receiver_id);
        match self.connection.handle("PATCH", &path, &serde_json::to_vec(&body).unwrap_or_default()) {
            Some(_) => Ok(()),
            None => Err(InvokeError::Unknown),
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
        uibundle::route(method, path)
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Audio Monitor");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9390").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Default 0 (freier Port vom OS) — mehrere vom Instanz-Launcher
    // gestartete Monitore dürfen sich sonst keinen festen Port teilen,
    // gleicher Grund wie `omp-viewer`s OMP_VIEWER_PREVIEW_PORT.
    let stream_port: u16 = env_or("OMP_AUDIO_MONITOR_STREAM_PORT", "0").parse()?;
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let receiver_id = omp_node_sdk::idgen::new_v4();

    let broadcaster = Arc::new(pcm_stream::Broadcaster::new());
    let actual_stream_port =
        pcm_stream::spawn(&format!("0.0.0.0:{stream_port}"), broadcaster.clone())?;
    let audio_stream_url = format!("http://{host}:{actual_stream_port}/pcm-stream");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config { domain };
    let pipeline_shutdown = shutdown.clone();
    let broadcaster_for_pipeline = broadcaster.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(
            pipeline_config,
            broadcaster_for_pipeline,
            tx,
            pipeline_shutdown,
            ready_tx,
        )
    });

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-audio-monitor: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-audio-monitor: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let media_ready_pipeline = pipeline_handle.clone();
    let connected_flow_id = Arc::new(Mutex::new(String::new()));
    let connected_label = Arc::new(Mutex::new(String::new()));
    let connection = Arc::new(ReceiverConnection::new(
        receiver_id.clone(),
        MonitorControl {
            registry: RegistryClient::new(registry_url.clone()),
            pipeline: pipeline_handle,
            connected_flow_id: connected_flow_id.clone(),
            connected_label: connected_label.clone(),
        },
    ));

    let store: Arc<dyn ParamStore> = Arc::new(MonitorStore {
        connected_flow_id,
        connected_label,
        audio_stream_url,
        connection,
        registry: RegistryClient::new(registry_url.clone()),
        own_receiver_id: receiver_id.clone(),
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![],
            receivers: vec![ReceiverSpec {
                id: Some(receiver_id),
                transport: Some(TRANSPORT_MXL.to_string()),
                media_types: Some(vec!["audio/float32".to_string()]),
                ..Default::default()
            }],
            instance_id,
            // "media-ready" (ARCHITECTURE.md §5 Punkt 6) über
            // PipelineHandle::media_ready() — false vor dem ersten
            // Connect und direkt nach jedem Quellwechsel, bis der neu
            // verbundene Input nachweislich einen Buffer liefert.
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready_pipeline.media_ready()
            })),
        },
        store,
    )
    .await?;

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-audio-monitor: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-audio-monitor: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-audio-monitor: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}
