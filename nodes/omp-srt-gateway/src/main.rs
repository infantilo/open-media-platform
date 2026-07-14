//! `omp-srt-gateway` (`UMSETZUNG.md` D4, `ARCHITECTURE.md` §6):
//! bidirektionale Brücke ST 2110 (LAN) ⇄ SRT (WAN) — Referenz-
//! Implementierung der in §6 beschriebenen Cloud-Gateway-Node.
//! Gerichtet je Instanz (`OMP_SRT_GATEWAY_DIRECTION=uplink|downlink`,
//! gleiches Muster wie `omp-player`s `OMP_PLAYER_PROFILE`), nicht
//! bidirektional in einem Prozess — mirrort die in `ARCHITECTURE.md`
//! §6.5 für NDI/RTSP-Gateways festgelegte Richtungs-Trennung.
//!
//! **Bewusst kein Live-Parameter/keine Methode:** Richtung/Endpunkte
//! sind Prozess-Start-Konfiguration (Env-Variablen), nicht zur Laufzeit
//! änderbar — ein Gateway ist hier als "einmal konfiguriert, dauerhaft
//! aktiv" modelliert (wie ein Hardware-Gateway), kein Cue/Take-Workflow
//! nötig. Der generische Parameter-Proxy (A8) bleibt trotzdem nutzbar
//! (readonly Status-Parameter), nur eben ohne Schreibpfad.

mod pipeline;

use std::sync::Arc;

use omp_node_sdk::{Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, SetError};
use pipeline::{Config, Direction};
use serde_json::Value;

struct GatewayStore {
    direction: Direction,
    st2110_host: String,
    st2110_port: u16,
    srt_uri: String,
}

impl ParamStore for GatewayStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                ParamSpec {
                    name: "direction".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "st2110Endpoint".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "srtUri".to_string(),
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
            "direction" => Some(serde_json::json!(match self.direction {
                Direction::Uplink => "uplink",
                Direction::Downlink => "downlink",
            })),
            "st2110Endpoint" => Some(serde_json::json!(format!(
                "{}:{}",
                self.st2110_host, self.st2110_port
            ))),
            "srtUri" => Some(serde_json::json!(self.srt_uri)),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, _name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "SRT-Gateway");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9390").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let direction = match env_or("OMP_SRT_GATEWAY_DIRECTION", "uplink").as_str() {
        "downlink" => Direction::Downlink,
        _ => Direction::Uplink,
    };
    // Uplink: st2110_host/port ist der lokale Empfangsport (st2110_host
    // wird dafür nicht gebraucht, bleibt aber Teil der Config-Struct für
    // beide Richtungen — einfacher als zwei Config-Typen).
    // Downlink: st2110_host/port ist das Ziel, an das der erzeugte
    // 2110-Strom geschickt wird.
    let st2110_host = env_or("OMP_SRT_GATEWAY_ST2110_HOST", "127.0.0.1");
    let st2110_port: u16 = env_or("OMP_SRT_GATEWAY_ST2110_PORT", "6000").parse()?;
    let srt_uri = env_or("OMP_SRT_GATEWAY_SRT_URI", "srt://127.0.0.1:7000");

    let cfg = Config {
        direction,
        st2110_host: st2110_host.clone(),
        st2110_port,
        srt_uri: srt_uri.clone(),
    };

    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
    let pipeline_handle = pipeline::build(&cfg, events_tx)
        .map_err(|e| format!("omp-srt-gateway: pipeline build failed: {e}"))?;

    let store: Arc<dyn ParamStore> = Arc::new(GatewayStore {
        direction,
        st2110_host,
        st2110_port,
        srt_uri,
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![],
            receivers: vec![],
            instance_id,
            // Hat echtes Medien-I/O, aber noch keine Bereitschafts-Probe
            // verdrahtet (dokumentierte Folgearbeit, ARCHITECTURE.md §5
            // Punkt 6, docs/decisions.md D5-prep) - meldet konservativ nie
            // "bereit", statt eine ungeprüfte Bereitschaft vorzutäuschen.
            media_ready: omp_node_sdk::MediaReadySource::Unknown,
        },
        store,
    )
    .await?;

    let events = async {
        while let Some(event) = events_rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-srt-gateway: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-srt-gateway: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-srt-gateway: pipeline thread ended");
        }
    }

    pipeline_handle.shutdown();

    Ok(())
}
