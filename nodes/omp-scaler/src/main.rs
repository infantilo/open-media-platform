//! omp-scaler (Nutzerwunsch 2026-07-28: "einfaches Scaler/Framerate-
//! Converter-Node"): liest eine per Drag & Drop verbundene MXL-
//! Videoquelle beliebiger Auflösung/Framerate und schreibt sie als
//! zweiten MXL-Flow in einem fest konfigurierten Zielformat zurück —
//! ergänzt die einstellbaren Standard-Formate pro Rolle
//! (`orchestrator/internal/workflows/formats.go`, Nachtrag 109): eine
//! Quelle mit z. B. `480p25` lässt sich damit hochskalieren, bevor sie
//! z. B. einen `1080p50`-Bildmischer erreicht, oder umgekehrt.
//!
//! Kein eigener Konvertierungs-Code: `omp_mediaio::mxl::MxlVideoOutput`
//! baut die Skalier-/Rate-Kette bereits selbst (s. `pipeline.rs`-
//! Moduldoku) — dieser Node ist nur die Verkabelung MXL-Eingang →
//! MXL-Ausgang im Zielformat.

mod pipeline;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, LatencyInfo, LatencyRange, NodeConfig, ParamSpec, ParamStore,
    ParamType, RawResponse, ReceiverSpec, SenderSpec, SetError,
};
use serde_json::Value;

/// Setzt IS-05-PATCHes (Quellwahl) auf die Pipeline um — identisches
/// Muster zu `omp-viewer::main::ViewerControl`: löst `sender_id` über
/// die Registry-Query-API zu einer MXL-`flow_id` auf und lässt die
/// Pipeline neu aufbauen. Ein leerer/abwesender `sender_id` (oder
/// `master_enable=false`) trennt.
struct ScalerControl {
    registry: RegistryClient,
    pipeline: pipeline::PipelineHandle,
    connected_flow_id: Arc<Mutex<String>>,
}

impl ReceiverControl for ScalerControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        self.pipeline.connect(flow_id);
                    }
                    None => eprintln!("omp-scaler: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-scaler: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected_flow_id.lock().expect("lock poisoned") = String::new();
                self.pipeline.disconnect();
            }
        }
    }
}

struct ScalerStore {
    connected_flow_id: Arc<Mutex<String>>,
    target_flow_id: String,
    target_width: u32,
    target_height: u32,
    target_framerate_numerator: u32,
    target_framerate_denominator: u32,
    connection: Arc<ReceiverConnection<ScalerControl>>,
}

impl ParamStore for ScalerStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            // D8 Teil 1 (UMSETZUNG.md, ARCHITECTURE.md §15.1 Punkt 1/4): live
            // per Kopf-Index-Vergleich gemessen (5 Samples eines echten
            // Testworkflows `src(25fps)->scaler->mix`, `docs/decisions.md`
            // Nachtrag zu D8 Teil 1) — `omp-scaler` reicht den MXL-Origin-
            // Index unverändert durch (C13-Nachtrag 2), der Scaler-Ausgang
            // lag deshalb in allen 5 Samples exakt einen Grain (=1 Frame der
            // Ziel-Framerate) hinter dem Eingang zurück, deterministisch
            // (min==max). Ergänzende `omp-video-mixer-me`/`omp-audio-mixer`-
            // Vermessung: `nodes/omp-video-mixer-me/src/main.rs`,
            // `nodes/omp-audio-mixer/src/main.rs`.
            latency: Some(LatencyInfo {
                video: Some(LatencyRange { min_latency_frames: 1, max_latency_frames: 1 }),
                audio: None,
                data: None,
                supports_delay_compensation: false,
            }),
            parameters: vec![
                ParamSpec {
                    name: "connectedFlowId".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "targetFlowId".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "targetWidth".to_string(),
                    kind: ParamType::Number,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "targetHeight".to_string(),
                    kind: ParamType::Number,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "targetFramerate".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
            ],
            methods: vec![],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "connectedFlowId" => Some(serde_json::json!(
                *self.connected_flow_id.lock().expect("lock poisoned")
            )),
            "targetFlowId" => Some(serde_json::json!(self.target_flow_id)),
            "targetWidth" => Some(serde_json::json!(self.target_width)),
            "targetHeight" => Some(serde_json::json!(self.target_height)),
            "targetFramerate" => Some(serde_json::json!(format!(
                "{}/{}",
                self.target_framerate_numerator, self.target_framerate_denominator
            ))),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(
        &self,
        _name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        self.connection.handle(method, path, body).map(|(status, content_type, body)| RawResponse {
            status,
            content_type,
            body,
        })
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Scaler");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9380").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Zielformat wie bei `omp-source` (Nachtrag 109): dieselben
    // OMP_WIDTH/OMP_HEIGHT/OMP_FRAMERATE_NUM/OMP_FRAMERATE_DEN-
    // Umgebungsvariablen, gesetzt aus derselben Rollen-Formatwahl
    // (orchestrator/internal/workflows/formats.go) — ein unkonfigurierter
    // Scaler verhält sich wie eine unkonfigurierte Source (640×480@25).
    let target_width: u32 = env_or("OMP_WIDTH", "").parse().unwrap_or(640);
    let target_height: u32 = env_or("OMP_HEIGHT", "").parse().unwrap_or(480);
    let target_framerate_numerator: u32 = env_or("OMP_FRAMERATE_NUM", "").parse().unwrap_or(25);
    let target_framerate_denominator: u32 = env_or("OMP_FRAMERATE_DEN", "").parse().unwrap_or(1);
    // Vom Instanz-Launcher gesetzt (`UMSETZUNG.md` C8), sonst leer bei
    // manuellem Start.
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    // Wie bei omp-viewer/omp-recorder: die Receiver-ID wird hier erzeugt,
    // weil der IS-05-Receiver-Connection-Endpoint (ReceiverConnection)
    // schon vor start() unter der endgültigen ID verdrahtet sein muss.
    let receiver_id = omp_node_sdk::idgen::new_v4();
    // Flow-UUID == MXL-flow-id-Konvention (`UMSETZUNG.md` C4), wie bei
    // omp-source.
    let target_flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        target_flow_id: target_flow_id.clone(),
        label: label.clone(),
        target_width,
        target_height,
        target_framerate_numerator,
        target_framerate_denominator,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_thread =
        std::thread::spawn(move || pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx));

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-scaler: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-scaler: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let media_ready_pipeline = pipeline_handle.clone();
    let connected_flow_id = Arc::new(Mutex::new(String::new()));
    let connection = Arc::new(ReceiverConnection::new(
        receiver_id.clone(),
        ScalerControl {
            registry: RegistryClient::new(registry_url.clone()),
            pipeline: pipeline_handle,
            connected_flow_id: connected_flow_id.clone(),
        },
    ));

    let store: Arc<dyn ParamStore> = Arc::new(ScalerStore {
        connected_flow_id,
        target_flow_id: target_flow_id.clone(),
        target_width,
        target_height,
        target_framerate_numerator,
        target_framerate_denominator,
        connection,
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![SenderSpec {
                transport: Some(TRANSPORT_MXL.to_string()),
                flow: Some(FlowSpec::Video {
                    id: Some(target_flow_id),
                    frame_width: target_width,
                    frame_height: target_height,
                    grain_rate_numerator: target_framerate_numerator,
                    grain_rate_denominator: target_framerate_denominator,
                }),
                ..Default::default()
            }],
            receivers: vec![ReceiverSpec {
                id: Some(receiver_id),
                transport: Some(TRANSPORT_MXL.to_string()),
                media_types: Some(vec!["video/v210".to_string()]),
                ..Default::default()
            }],
            instance_id,
            // "media-ready" (ARCHITECTURE.md §5 Punkt 6) über
            // PipelineHandle::media_ready() — false vor dem ersten
            // Connect und direkt nach jedem Quellwechsel, bis der neu
            // aufgebaute Ausgang nachweislich schreibt.
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
                    eprintln!("omp-scaler: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-scaler: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-scaler: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}
