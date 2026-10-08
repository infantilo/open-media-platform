//! omp-device-hub (Kap. 34): erkennt lokale Video-/Audio-Geräte (V4L2, ALSA/USB) und
//! hält je Geräte-ID fest, ob das Gerät im DMF/MXL angeboten werden soll. 34.2 liefert
//! Erkennung, Parameter `devices` und die Schalter (persistent); das tatsächliche Anbieten
//! als MXL-Flow/NMOS-Sender folgt in 34.3.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_device_hub::model::Device;
use omp_device_hub::state::{self, Offered};
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, SetError,
};
use serde_json::Value;

const POLL: Duration = Duration::from_secs(3);

struct Hub {
    devices: Vec<Device>,
    offered: Offered,
    state_file: PathBuf,
}

struct HubStore {
    hub: Arc<Mutex<Hub>>,
    rescan: Arc<AtomicBool>,
}

impl ParamStore for HubStore {
    fn descriptor(&self) -> Descriptor {
        let ro = |name: &str, kind| ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly: true };
        Descriptor {
            latency: None,
            parameters: vec![ro("devices", ParamType::String), ro("offeredCount", ParamType::Number)],
            methods: vec![
                MethodSpec {
                    name: "setOffered".to_string(),
                    args: vec![
                        MethodArg { name: "id".to_string(), kind: ParamType::String },
                        MethodArg { name: "on".to_string(), kind: ParamType::Boolean },
                    ],
                },
                MethodSpec { name: "rescan".to_string(), args: vec![] },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let hub = self.hub.lock().expect("lock poisoned");
        match name {
            "devices" => Some(serde_json::to_value(state::view(&hub.devices, &hub.offered)).expect("serialize")),
            "offeredCount" => Some(serde_json::json!(hub.offered.offered.len())),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "setOffered" => {
                let id = args.get("id").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let on = args.get("on").and_then(Value::as_bool).ok_or(InvokeError::Unknown)?;
                let mut hub = self.hub.lock().expect("lock poisoned");
                let devices = hub.devices.clone();
                if !hub.offered.set(id, on, &devices) {
                    return Err(InvokeError::Message(format!("unbekanntes Gerät: {id}")));
                }
                hub.offered
                    .save(&hub.state_file)
                    .map_err(|e| InvokeError::Message(format!("Zustand nicht gespeichert: {e}")))
            }
            "rescan" => {
                self.rescan.store(true, Ordering::Relaxed);
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

/// Zustandsdatei je Host (nicht je Instanz): die Geräte gehören dem Rechner.
fn default_state_file() -> PathBuf {
    let base = std::env::var("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|h| Path::new(&h).join(".local/state")))
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("omp/device-hub.json")
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Device Hub");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9440").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let root = PathBuf::from(env_or("OMP_DEVICE_ROOT", "/"));
    let state_file = std::env::var("OMP_DEVICE_HUB_STATE").map(PathBuf::from).unwrap_or_else(|_| default_state_file());

    let hub = Arc::new(Mutex::new(Hub { devices: Vec::new(), offered: Offered::load(&state_file), state_file }));
    let rescan = Arc::new(AtomicBool::new(true));
    let shutdown = Arc::new(AtomicBool::new(false));

    // Hotplug per Abfrage: die billige sysfs-Sicht alle POLL; nur bei geänderter ID-Menge (oder
    // `rescan`) läuft die teure Fähigkeitsabfrage über GStreamer.
    let scanner = {
        let (hub, rescan, shutdown) = (hub.clone(), rescan.clone(), shutdown.clone());
        std::thread::spawn(move || {
            let mut last: Option<Vec<String>> = None;
            while !shutdown.load(Ordering::Relaxed) {
                let ids: Vec<String> = omp_device_hub::scan_candidates(&root).into_iter().map(|d| d.id).collect();
                if rescan.swap(false, Ordering::Relaxed) || last.as_ref() != Some(&ids) {
                    let devices = omp_device_hub::scan(&root);
                    eprintln!("omp-device-hub: {} Gerät(e) erkannt", devices.len());
                    hub.lock().expect("lock poisoned").devices = devices;
                    last = Some(ids);
                }
                // Kurze Schritte, damit `shutdown`/`rescan` zügig wirken; Abfrage nur alle POLL.
                let mut waited = Duration::ZERO;
                while waited < POLL && !shutdown.load(Ordering::Relaxed) && !rescan.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(100));
                    waited += Duration::from_millis(100);
                }
            }
        })
    };

    let store: Arc<dyn ParamStore> = Arc::new(HubStore { hub, rescan });
    let _handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![],
            receivers: vec![],
            instance_id: std::env::var("OMP_INSTANCE_ID").ok(),
            media_ready: omp_node_sdk::MediaReadySource::NotApplicable,
        },
        store,
    )
    .await?;

    tokio::signal::ctrl_c().await?;
    eprintln!("omp-device-hub: shutdown requested");
    shutdown.store(true, Ordering::Relaxed);
    let _ = scanner.join();
    Ok(())
}
