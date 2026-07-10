//! omp-source: Test-Videoquelle → MXL (`UMSETZUNG.md` C5). Erster der drei
//! MXL-Demo-Services (`docs/decisions.md`, 2026-07-09): publiziert ein
//! wählbares GStreamer-Testbild als MXL-Flow, mehrfach instanziierbar
//! (`OMP_LABEL`/`OMP_PORT` wie beim Mock-Node). Kein Playlist-, kein
//! IS-05-Sender-Connection-Kram — reine Live-Quelle.

mod pipeline;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use omp_node_sdk::is04::TRANSPORT_MXL;
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, Range, SenderSpec,
    SetError,
};
use serde_json::Value;

/// Kuratierte Teilmenge von GStreamers `videotestsrc`-Pattern-Nicknames —
/// dieselben Namen, die auch `tools/mxl-gst/testsrc.cpp`s `--pattern`
/// akzeptiert (dort 1:1 auf `videotestsrc`s `pattern`-GEnum abgebildet,
/// siehe `docs/decisions.md` 2026-07-09) — kein eigenes Namensschema.
const PATTERNS: &[&str] = &[
    "smpte",
    "snow",
    "black",
    "white",
    "red",
    "green",
    "blue",
    "ball",
    "checkers-1",
    "circular",
    "gradient",
    "colors",
];
const DEFAULT_PATTERN: &str = "smpte";

struct SourceStore {
    fps: Arc<Mutex<f64>>,
    flow_id: String,
    pattern: Arc<Mutex<String>>,
    pipeline: pipeline::PipelineHandle,
}

impl ParamStore for SourceStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                ParamSpec {
                    name: "pattern".to_string(),
                    kind: ParamType::Enum,
                    unit: None,
                    range: Some(Range::Enum {
                        values: PATTERNS.iter().map(|p| p.to_string()).collect(),
                    }),
                    readonly: false,
                },
                ParamSpec {
                    name: "fps".to_string(),
                    kind: ParamType::Number,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "flowId".to_string(),
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
            "fps" => Some(serde_json::json!(*self.fps.lock().expect("lock poisoned"))),
            "flowId" => Some(serde_json::json!(self.flow_id)),
            "pattern" => Some(serde_json::json!(
                *self.pattern.lock().expect("lock poisoned")
            )),
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        if name != "pattern" {
            return Err(SetError::Unknown);
        }
        let Some(pattern) = value.as_str() else {
            return Err(SetError::Unknown);
        };
        if !PATTERNS.contains(&pattern) {
            return Err(SetError::Unknown);
        }
        self.pipeline.set_pattern(pattern);
        *self.pattern.lock().expect("lock poisoned") = pattern.to_string();
        Ok(())
    }

    fn invoke(
        &self,
        _name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Source");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9320").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let initial_pattern = env_or("OMP_SOURCE_PATTERN", DEFAULT_PATTERN);
    // Für GET /params/pattern nachgehalten (Contract-Check UMSETZUNG.md
    // C9 fand den Bug: `set()` änderte bisher nur die Pipeline-Property,
    // `get()` kannte "pattern" gar nicht — PATCH schien zu funktionieren,
    // ein GET danach lieferte aber 404 statt des gesetzten Werts).
    let pattern = Arc::new(Mutex::new(initial_pattern.clone()));
    // Vom Instanz-Launcher gesetzt (`UMSETZUNG.md` C8), sonst leer bei
    // manuellem Start.
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    // Flow-UUID == MXL-flow-id-Konvention (`UMSETZUNG.md` C4): dieselbe ID
    // geht sowohl an `MxlVideoOutput` (tatsächlicher Flow in der Domain)
    // als auch an die IS-04-Flow-Registrierung (`SenderSpec::flow`).
    let flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        flow_id: flow_id.clone(),
        label: label.clone(),
        initial_pattern,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_thread =
        std::thread::spawn(move || pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx));

    let fps = Arc::new(Mutex::new(0.0));

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-source: pipeline build failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-source: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let store: Arc<dyn ParamStore> = Arc::new(SourceStore {
        fps: fps.clone(),
        flow_id: flow_id.clone(),
        pattern,
        pipeline: pipeline_handle,
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
                flow: Some(FlowSpec {
                    id: Some(flow_id),
                    frame_width: pipeline::WIDTH,
                    frame_height: pipeline::HEIGHT,
                    grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
                    grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
                }),
                ..Default::default()
            }],
            receivers: vec![],
            instance_id,
        },
        store,
    )
    .await?;

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Fps(measured) => {
                    *fps.lock().expect("lock poisoned") = measured;
                    eprintln!("omp-source: measured video fps ~= {measured:.1}");
                }
                pipeline::Event::Error(message) => {
                    eprintln!("omp-source: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-source: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-source: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}
