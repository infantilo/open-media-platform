//! omp-audio-split: teilt einen Mehrkanal-Ton-Flow (z. B. 16 Spuren) in einzelne Ausgangs-Flows (z. B. 1/2 Programm, 3/4
//! internationaler Ton, 9 Kommentar), damit z. B. ein Audiomischer jeden Ausgang einzeln über IS-05 beziehen kann. Reiner
//! Kanalkopierer (bitgleich, Sample-Index bleibt). Die Ausgänge stehen beim Start fest (`OMP_SPLIT_OUTPUTS`, JSON, siehe
//! `outputs.rs`); die Kanäle eines Ausgangs lassen sich zur Laufzeit umhängen (`split.outputs`). Details: `pipeline.rs`.

mod outputs;
mod pipeline;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource, bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, ReceiverSpec, SenderSpec, SetError};
use serde_json::Value;

struct SplitControl {
    registry: RegistryClient,
    pipeline: pipeline::PipelineHandle,
    connected: Arc<Mutex<String>>,
}

impl ReceiverControl for SplitControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected.lock().expect("lock poisoned") = flow_id.clone();
                        self.pipeline.connect(flow_id);
                    }
                    None => eprintln!("omp-audio-split: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-audio-split: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                *self.connected.lock().expect("lock poisoned") = String::new();
                self.pipeline.disconnect();
            }
        }
    }
}

struct SplitStore {
    in_domain: String,
    out_domain: String,
    flow_ids: Vec<(String, String)>, // (Name, Flow-ID)
    connected: Arc<Mutex<String>>,
    conn: Arc<ReceiverConnection<SplitControl>>,
    pipeline: pipeline::PipelineHandle,
}

fn ro(name: &str, kind: ParamType) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly: true }
}

impl ParamStore for SplitStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                ro("inputDomain", ParamType::String),
                ro("outputDomain", ParamType::String),
                ro("connectedFlowId", ParamType::String),
                ro("inputChannels", ParamType::Number),
                ro("outputFlowIds", ParamType::String),
                ro("mode", ParamType::String),
                ro("flowing", ParamType::Boolean),
                // JSON-Liste der Ausgänge; schreibbar nur als Neuzuordnung der Kanäle (Namen, Zahl und Kanalzahl bleiben).
                ParamSpec { name: "split.outputs".to_string(), kind: ParamType::String, unit: None, range: None, readonly: false },
            ],
            methods: vec![],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let sh = &self.pipeline.shared;
        match name {
            "inputDomain" => Some(serde_json::json!(self.in_domain)),
            "outputDomain" => Some(serde_json::json!(self.out_domain)),
            "connectedFlowId" => Some(serde_json::json!(self.connected.lock().expect("lock poisoned").clone())),
            "inputChannels" => Some(serde_json::json!(sh.input_channels.load(Ordering::Relaxed))),
            "outputFlowIds" => Some(serde_json::json!(serde_json::to_string(&self.flow_ids.iter().map(|(n, f)| serde_json::json!({"name": n, "flowId": f})).collect::<Vec<_>>()).unwrap_or_default())),
            "mode" => Some(serde_json::json!(sh.mode.lock().expect("lock poisoned").clone())),
            "flowing" => Some(serde_json::json!(self.pipeline.flowing())),
            "split.outputs" => Some(serde_json::json!(serde_json::to_string(&*sh.outputs.lock().expect("lock poisoned")).unwrap_or_default())),
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        match name {
            "split.outputs" => {
                let text = match &value {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                let new = outputs::parse(&text).map_err(|e| {
                    eprintln!("omp-audio-split: {e}");
                    SetError::Unknown
                })?;
                self.pipeline.remap(new).map_err(|e| {
                    eprintln!("omp-audio-split: {e}");
                    SetError::Unknown
                })
            }
            n if self.get(n).is_some() => Err(SetError::ReadOnly),
            _ => Err(SetError::Unknown),
        }
    }

    fn invoke(&self, _name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        let id = self.conn.id();
        root_discovery(method, path)
            .or_else(|| list_ids(method, path, "receivers", &[id]))
            .or_else(|| bulk_discovery(method, path))
            .or_else(|| bulk_patch(method, path, "receivers", body, |rid, params| if rid == id { Some(self.conn.patch_staged(params).0) } else { None }))
            .or_else(|| bulk_patch(method, path, "senders", body, |_, _| None))
            .or_else(|| self.conn.handle(method, path, body))
            .map(to_raw)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.conn.cors_methods(path).or_else(|| bulk_cors_methods(path, "senders")).or_else(|| bulk_cors_methods(path, "receivers"))
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Tonteiler");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9396").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let in_domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let out_domain = match env_or("OMP_MXL_TARGET_DOMAIN", "") {
        d if d.is_empty() => in_domain.clone(),
        d => d,
    };
    // Ausgänge: ausdrücklich (JSON) oder je zwei Kanäle ein Ausgang aus der erwarteten Kanalzahl (Standard 16).
    let outs = match std::env::var("OMP_SPLIT_OUTPUTS").ok().filter(|v| !v.trim().is_empty()) {
        Some(j) => outputs::parse(&j).map_err(|e| {
            eprintln!("omp-audio-split: OMP_SPLIT_OUTPUTS: {e}");
            e
        })?,
        None => outputs::default_pairs(env_or("OMP_SPLIT_INPUT_CHANNELS", "16").parse().unwrap_or(16)),
    };
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let receiver_id = omp_node_sdk::idgen::new_v4();
    let with_flows: Vec<(outputs::Output, String)> = outs.iter().map(|o| (o.clone(), omp_node_sdk::idgen::new_v4())).collect();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let config = pipeline::Config { in_domain: in_domain.clone(), out_domain: out_domain.clone(), label: label.clone(), outputs: with_flows.clone() };
    let pipeline_shutdown = shutdown.clone();
    let heartbeat = Arc::new(AtomicU64::new(0));
    let hb = heartbeat.clone();
    let pipeline_thread = std::thread::spawn(move || pipeline::run(config, tx, pipeline_shutdown, ready_tx, hb));
    let handle_pipe = match ready_rx.await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            eprintln!("omp-audio-split: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => return Err("pipeline thread ended before reporting readiness".into()),
    };

    let connected = Arc::new(Mutex::new(String::new()));
    let conn = Arc::new(ReceiverConnection::new(receiver_id.clone(), SplitControl { registry: RegistryClient::new(registry_url.clone()), pipeline: handle_pipe.clone(), connected: connected.clone() }));
    let flowing = handle_pipe.clone();
    let store: Arc<dyn ParamStore> = Arc::new(SplitStore {
        in_domain,
        out_domain,
        flow_ids: with_flows.iter().map(|(o, f)| (o.name.clone(), f.clone())).collect(),
        connected,
        conn,
        pipeline: handle_pipe,
    });

    // Ein Sender je Ausgang, bezeichnet mit dem Ausgangsnamen (so verdrahtet der MCR und so erscheint er im Audiomischer).
    let senders: Vec<SenderSpec> = with_flows
        .iter()
        .map(|(o, flow)| SenderSpec {
            transport: Some(TRANSPORT_MXL.to_string()),
            flow: Some(FlowSpec::Audio { id: Some(flow.clone()), sample_rate_numerator: pipeline::SAMPLE_RATE, channel_count: o.channels.len() as u32, media_type: "audio/float32".to_string(), bit_depth: 32, source_id: None }),
            label: Some(o.name.clone()),
            ..Default::default()
        })
        .collect();
    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders,
            receivers: vec![ReceiverSpec { id: Some(receiver_id), transport: Some(TRANSPORT_MXL.to_string()), media_types: Some(vec!["audio/float32".to_string()]), ..Default::default() }],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || flowing.flowing())),
        },
        store,
    )
    .await?;
    handle.register_worker("pipeline", heartbeat);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    let message = omp_node_sdk::errcode::tag(&message);
                    eprintln!("omp-audio-split: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-audio-split: shutdown requested"),
        _ = events => eprintln!("omp-audio-split: pipeline thread ended"),
    }
    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();
    Ok(())
}
