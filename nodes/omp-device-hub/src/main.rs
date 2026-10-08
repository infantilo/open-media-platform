//! omp-device-hub (Kap. 34): erkennt lokale Video-/Audio-Geräte (V4L2, ALSA/USB) und
//! hält je Geräte-ID fest, ob das Gerät im DMF/MXL angeboten werden soll. 34.2 liefert
//! Erkennung, Parameter `devices` und die Schalter (persistent); das tatsächliche Anbieten
//! als MXL-Flow/NMOS-Sender folgt in 34.3.

mod uibundle;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_device_hub::model::Device;
use omp_device_hub::offer::{self, Format, Offer};
use omp_device_hub::state::{self, Offered};
use omp_mediaio::mxl::MxlContext;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, SenderSpec, SetError,
};
use serde_json::Value;

const POLL: Duration = Duration::from_secs(1);

struct Hub {
    devices: Vec<Device>,
    offered: Offered,
    state_file: PathBuf,
    /// Laufzeitstatus je Geräte-ID (`flowing`/`error: …`), vom Abgleich gepflegt.
    status: HashMap<String, String>,
}

/// Änderungen an der NMOS-Senderliste (der Abgleich läuft auf einem eigenen Thread,
/// `add_sender` ist async) — Muster wie `omp-audio-mixer`.
enum SenderChange {
    Add { sender_id: String, flow_id: String, label: String, format: Format, tags: Vec<String> },
    Remove { sender_id: String },
}

struct HubStore {
    hub: Arc<Mutex<Hub>>,
    rescan: Arc<AtomicBool>,
    /// Weckt den Abgleich nach `setOffered`.
    wake: Arc<AtomicBool>,
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
            "devices" => Some(serde_json::to_value(state::view(&hub.devices, &hub.offered, &hub.status)).expect("serialize")),
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
                hub.status.remove(id); // frischer Versuch, auch nach einem Fehler
                let saved = hub
                    .offered
                    .save(&hub.state_file)
                    .map_err(|e| InvokeError::Message(format!("Zustand nicht gespeichert: {e}")));
                self.wake.store(true, Ordering::Relaxed);
                saved
            }
            "rescan" => {
                self.hub.lock().expect("lock poisoned").status.retain(|_, v| !v.starts_with("error"));
                self.rescan.store(true, Ordering::Relaxed);
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, _body: &[u8]) -> Option<omp_node_sdk::RawResponse> {
        uibundle::route(method, path)
    }
}

/// Gleicht laufende Anbietungen mit dem Soll ab und pflegt `Hub::status`.
fn reconcile(
    hub: &Mutex<Hub>,
    running: &mut HashMap<String, Offer>,
    ctx: Option<&Arc<MxlContext>>,
    hub_label: &str,
    test_source: bool,
    senders: &tokio::sync::mpsc::UnboundedSender<SenderChange>,
) {
    let (devices, wanted): (Vec<Device>, HashSet<String>) = {
        let h = hub.lock().expect("lock poisoned");
        let present: HashSet<&str> = h.devices.iter().map(|d| d.id.as_str()).collect();
        let wanted = h.offered.offered.keys().filter(|id| present.contains(id.as_str())).cloned().collect();
        (h.devices.clone(), wanted)
    };
    let mut status: HashMap<String, String> = HashMap::new();

    // Ausfälle erkennen (Gerät abgezogen/Pipeline-Fehler) und aufräumen.
    let mut failed: Vec<(String, String)> = Vec::new();
    for (id, o) in running.iter() {
        if let Some(e) = o.poll_error() {
            failed.push((id.clone(), e));
        }
    }
    for (id, e) in failed {
        eprintln!("omp-device-hub: {id} ausgefallen: {e}");
        running.remove(&id);
        let _ = senders.send(SenderChange::Remove { sender_id: offer::sender_id(&id) });
        status.insert(id, format!("error: {e}"));
    }
    // Ausschalten / nicht mehr angesteckt.
    let stale: Vec<String> = running.keys().filter(|id| !wanted.contains(*id)).cloned().collect();
    for id in stale {
        running.remove(&id);
        let _ = senders.send(SenderChange::Remove { sender_id: offer::sender_id(&id) });
    }
    // Einschalten.
    for id in &wanted {
        if running.contains_key(id) {
            continue;
        }
        // Bereits gemeldeter Fehler bleibt stehen, bis `setOffered`/`rescan` ihn löscht.
        if let Some(prev) = hub.lock().expect("lock poisoned").status.get(id).filter(|s| s.starts_with("error")) {
            status.insert(id.clone(), prev.clone());
            continue;
        }
        if status.contains_key(id) {
            continue;
        }
        let Some(ctx) = ctx else {
            status.insert(id.clone(), "error: MXL nicht verfügbar".to_string());
            continue;
        };
        let Some(d) = devices.iter().find(|d| &d.id == id) else { continue };
        let label = format!("{hub_label} {}", d.name);
        match Offer::start(ctx.clone(), d, &label, test_source) {
            Ok(o) => {
                let tags = vec!["source.live".to_string(), format!("device.{}", if d.kind == omp_device_hub::DeviceKind::Video { "video" } else { "audio" })];
                let _ = senders.send(SenderChange::Add {
                    sender_id: offer::sender_id(id),
                    flow_id: offer::flow_id(id),
                    label,
                    format: o.format.clone(),
                    tags,
                });
                running.insert(id.clone(), o);
            }
            Err(e) => {
                eprintln!("omp-device-hub: {id} lässt sich nicht anbieten: {e}");
                status.insert(id.clone(), format!("error: {e}"));
            }
        }
    }
    for (id, o) in running.iter() {
        status.entry(id.clone()).or_insert_with(|| if o.flowing() { "flowing" } else { "starting" }.to_string());
    }
    hub.lock().expect("lock poisoned").status = status;
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

    let hub = Arc::new(Mutex::new(Hub {
        devices: Vec::new(),
        offered: Offered::load(&state_file),
        state_file,
        status: HashMap::new(),
    }));
    let rescan = Arc::new(AtomicBool::new(true));
    let wake = Arc::new(AtomicBool::new(false));
    let shutdown = Arc::new(AtomicBool::new(false));
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let test_source = env_or("OMP_DEVICE_HUB_TEST_SRC", "0") == "1";
    let hub_label = label.clone();
    let (sender_tx, mut sender_rx) = tokio::sync::mpsc::unbounded_channel::<SenderChange>();

    // Abgleich: Soll (eingeschaltet ∧ angesteckt) gegen laufende Anbietungen. Hotplug per
    // Abfrage: die billige sysfs-Sicht alle POLL; nur bei geänderter ID-Menge (oder `rescan`)
    // läuft die teure Fähigkeitsabfrage über GStreamer.
    let scanner = {
        let (hub, rescan, wake, shutdown) = (hub.clone(), rescan.clone(), wake.clone(), shutdown.clone());
        std::thread::spawn(move || {
            let ctx = match MxlContext::new(&domain) {
                Ok(c) => Some(Arc::new(c)),
                Err(e) => {
                    eprintln!("omp-device-hub: MXL nicht verfügbar ({e}) — Geräte werden erkannt, aber nicht angeboten");
                    None
                }
            };
            let mut running: HashMap<String, Offer> = HashMap::new();
            let mut last: Option<Vec<String>> = None;
            while !shutdown.load(Ordering::Relaxed) {
                let ids: Vec<String> = omp_device_hub::scan_candidates(&root).into_iter().map(|d| d.id).collect();
                if rescan.swap(false, Ordering::Relaxed) || last.as_ref() != Some(&ids) {
                    let devices = omp_device_hub::scan(&root);
                    eprintln!("omp-device-hub: {} Gerät(e) erkannt", devices.len());
                    hub.lock().expect("lock poisoned").devices = devices;
                    last = Some(ids);
                }
                wake.store(false, Ordering::Relaxed);
                reconcile(&hub, &mut running, ctx.as_ref(), &hub_label, test_source, &sender_tx);
                // Kurze Schritte, damit `shutdown`/`rescan`/`wake` zügig wirken.
                let mut waited = Duration::ZERO;
                while waited < POLL
                    && !shutdown.load(Ordering::Relaxed)
                    && !rescan.load(Ordering::Relaxed)
                    && !wake.load(Ordering::Relaxed)
                {
                    std::thread::sleep(Duration::from_millis(100));
                    waited += Duration::from_millis(100);
                }
            }
            for (id, _offer) in running.drain() {
                let _ = sender_tx.send(SenderChange::Remove { sender_id: offer::sender_id(&id) });
            }
        })
    };

    let store: Arc<dyn ParamStore> = Arc::new(HubStore { hub, rescan, wake });
    let handle = omp_node_sdk::start(
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

    let sender_worker = async {
        while let Some(change) = sender_rx.recv().await {
            let result = match change {
                SenderChange::Add { sender_id, flow_id, label, format, tags } => {
                    let flow = match format {
                        Format::Video { width, height, fps } => omp_node_sdk::node::FlowSpec::Video {
                            id: Some(flow_id),
                            frame_width: width,
                            frame_height: height,
                            grain_rate_numerator: fps,
                            grain_rate_denominator: 1,
                        },
                        Format::Audio { channels } => omp_node_sdk::node::FlowSpec::Audio {
                            id: Some(flow_id),
                            sample_rate_numerator: offer::SAMPLE_RATE,
                            channel_count: channels,
                            media_type: "audio/float32".to_string(),
                            bit_depth: 32,
                            source_id: None,
                        },
                    };
                    handle
                        .add_sender(SenderSpec {
                            id: Some(sender_id),
                            transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
                            flow: Some(flow),
                            label: Some(label),
                            tags: HashMap::from([("urn:x-omp:tags".to_string(), tags)]),
                            ..Default::default()
                        })
                        .await
                        .map(|_| ())
                }
                SenderChange::Remove { sender_id } => handle.remove_sender(&sender_id).await,
            };
            if let Err(e) = result {
                eprintln!("omp-device-hub: Sender-Änderung fehlgeschlagen: {e}");
                handle.publish_alert(format!("Sender-Änderung fehlgeschlagen: {e}")).await;
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-device-hub: shutdown requested"),
        _ = sender_worker => {}
    }
    shutdown.store(true, Ordering::Relaxed);
    let _ = scanner.join();
    Ok(())
}
