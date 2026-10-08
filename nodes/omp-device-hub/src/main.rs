//! omp-device-hub (Kap. 34): erkennt lokale Video-/Audio-Geräte (V4L2, ALSA/USB) und
//! hält je Geräte-ID fest, ob das Gerät im DMF/MXL angeboten werden soll. 34.2 liefert
//! Erkennung, Parameter `devices` und die Schalter (persistent). Eingänge (Aufnahmegeräte)
//! werden als MXL-Flow + NMOS-Sender angeboten (34.3); Ausgänge (Wiedergabe der Soundkarte,
//! 34.5) als NMOS-Empfänger, dessen IS-05-Verbindung die Wiedergabe startet.

mod uibundle;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_device_hub::model::{Device, Direction};
use omp_device_hub::offer::{self, Format, Offer, Playback};
use omp_device_hub::state::{self, Offered};
use omp_mediaio::mxl::MxlContext;
use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, ReceiverSpec, SenderSpec,
    SetError,
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

/// Änderungen an der NMOS-Sender-/Empfängerliste (der Abgleich läuft auf einem eigenen Thread,
/// `add_sender`/`add_receiver` sind async) — Muster wie `omp-audio-mixer`/`omp-viewer`.
enum SenderChange {
    Add { sender_id: String, flow_id: String, label: String, format: Format, tags: Vec<String> },
    Remove { sender_id: String },
    AddReceiver { device_id: String, label: String },
    RemoveReceiver { device_id: String },
}

/// Laufende Wiedergaben je Ausgangsgerät (entstehen mit der IS-05-Verbindung des Empfängers).
type Playbacks = Arc<Mutex<HashMap<String, Playback>>>;
/// IS-05-Endpunkte der Empfänger je Ausgangsgerät.
type Receivers = Arc<Mutex<HashMap<String, Arc<ReceiverConnection<OutputControl>>>>>;

/// Setzt IS-05-PATCHes auf den Empfänger eines Ausgangs um: Quelle auflösen, Wiedergabe starten bzw. beenden.
struct OutputControl {
    device_id: String,
    registry: RegistryClient,
    hub: Arc<Mutex<Hub>>,
    playbacks: Playbacks,
    ctx: Option<Arc<MxlContext>>,
    test_sink: bool,
}

impl OutputControl {
    fn fail(&self, why: String) {
        eprintln!("omp-device-hub: Ausgang {}: {why}", self.device_id);
        self.hub.lock().expect("lock poisoned").status.insert(self.device_id.clone(), format!("error: {why}"));
    }
}

impl ReceiverControl for OutputControl {
    fn apply(&self, resource: &ReceiverResource) {
        // Jede neue Verbindung ist ein frischer Versuch.
        self.playbacks.lock().expect("lock poisoned").remove(&self.device_id);
        self.hub.lock().expect("lock poisoned").status.remove(&self.device_id);
        let (Some(sender_id), true) = (&resource.sender_id, resource.master_enable) else { return };
        let flow_id = match self.registry.get_sender(sender_id) {
            Ok(s) => match s.flow_id {
                Some(f) => f,
                None => return self.fail(format!("Sender {sender_id} hat keinen Flow")),
            },
            Err(e) => return self.fail(format!("Sender {sender_id} nicht auflösbar: {e}")),
        };
        let Some(ctx) = &self.ctx else { return self.fail("MXL nicht verfügbar".to_string()) };
        let device = self.hub.lock().expect("lock poisoned").devices.iter().find(|d| d.id == self.device_id).cloned();
        let Some(device) = device else { return self.fail("Gerät nicht angesteckt".to_string()) };
        match Playback::start(ctx.clone(), &device, &flow_id, self.test_sink) {
            Ok(p) => {
                self.playbacks.lock().expect("lock poisoned").insert(self.device_id.clone(), p);
            }
            Err(e) => self.fail(e),
        }
    }
}

struct HubStore {
    hub: Arc<Mutex<Hub>>,
    receivers: Receivers,
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

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<omp_node_sdk::RawResponse> {
        {
            let receivers = self.receivers.lock().expect("lock poisoned");
            for connection in receivers.values() {
                if let Some((status, content_type, body)) = connection.handle(method, path, body) {
                    return Some(omp_node_sdk::RawResponse { status, content_type, body });
                }
            }
        }
        uibundle::route(method, path)
    }
}

/// Alles, was der Abgleich braucht (gemeinsame Zustände + Kanal zum NMOS-Worker).
struct Reconciler {
    hub: Arc<Mutex<Hub>>,
    ctx: Option<Arc<MxlContext>>,
    label: String,
    test_source: bool,
    changes: tokio::sync::mpsc::UnboundedSender<SenderChange>,
    playbacks: Playbacks,
    /// Eingänge: laufende Anbietungen.
    running: HashMap<String, Offer>,
    /// Ausgänge: für welche Geräte ein Empfänger angemeldet ist.
    receivers_added: HashSet<String>,
}

impl Reconciler {
    /// Gleicht laufende Anbietungen/Empfänger mit dem Soll ab und pflegt `Hub::status`.
    fn reconcile(&mut self) {
        let (devices, wanted): (Vec<Device>, HashSet<String>) = {
            let h = self.hub.lock().expect("lock poisoned");
            let present: HashSet<&str> = h.devices.iter().map(|d| d.id.as_str()).collect();
            let wanted = h.offered.offered.keys().filter(|id| present.contains(id.as_str())).cloned().collect();
            (h.devices.clone(), wanted)
        };
        let is_out = |id: &String| devices.iter().find(|d| &d.id == id).is_some_and(|d| d.direction == Direction::Output);
        let wanted_in: HashSet<String> = wanted.iter().filter(|id| !is_out(id)).cloned().collect();
        let wanted_out: HashSet<String> = wanted.iter().filter(|id| is_out(id)).cloned().collect();
        let prev_status = self.hub.lock().expect("lock poisoned").status.clone();
        let mut status: HashMap<String, String> = HashMap::new();

        // ---- Eingänge (Quellen) ----
        let mut failed: Vec<(String, String)> = Vec::new();
        for (id, o) in self.running.iter() {
            if let Some(e) = o.poll_error() {
                failed.push((id.clone(), e));
            }
        }
        for (id, e) in failed {
            eprintln!("omp-device-hub: {id} ausgefallen: {e}");
            self.running.remove(&id);
            let _ = self.changes.send(SenderChange::Remove { sender_id: offer::sender_id(&id) });
            status.insert(id, format!("error: {e}"));
        }
        let stale: Vec<String> = self.running.keys().filter(|id| !wanted_in.contains(*id)).cloned().collect();
        for id in stale {
            self.running.remove(&id);
            let _ = self.changes.send(SenderChange::Remove { sender_id: offer::sender_id(&id) });
        }
        for id in &wanted_in {
            if self.running.contains_key(id) || status.contains_key(id) {
                continue;
            }
            // Bereits gemeldeter Fehler bleibt stehen, bis `setOffered`/`rescan` ihn löscht.
            if let Some(prev) = prev_status.get(id).filter(|s| s.starts_with("error")) {
                status.insert(id.clone(), prev.clone());
                continue;
            }
            let Some(ctx) = &self.ctx else {
                status.insert(id.clone(), "error: MXL nicht verfügbar".to_string());
                continue;
            };
            let Some(d) = devices.iter().find(|d| &d.id == id) else { continue };
            let label = format!("{} {}", self.label, d.name);
            match Offer::start(ctx.clone(), d, &label, self.test_source) {
                Ok(o) => {
                    let tags = vec!["source.live".to_string(), format!("device.{}", if d.kind == omp_device_hub::DeviceKind::Video { "video" } else { "audio" })];
                    let _ = self.changes.send(SenderChange::Add {
                        sender_id: offer::sender_id(id),
                        flow_id: offer::flow_id(id),
                        label,
                        format: o.format.clone(),
                        tags,
                    });
                    self.running.insert(id.clone(), o);
                }
                Err(e) => {
                    eprintln!("omp-device-hub: {id} lässt sich nicht anbieten: {e}");
                    status.insert(id.clone(), format!("error: {e}"));
                }
            }
        }
        for (id, o) in self.running.iter() {
            status.entry(id.clone()).or_insert_with(|| if o.flowing() { "flowing" } else { "starting" }.to_string());
        }

        // ---- Ausgänge (Senken): Empfänger anmelden; Wiedergabe läuft nur, solange verbunden ----
        let mut failed_out: Vec<(String, String)> = Vec::new();
        for (id, p) in self.playbacks.lock().expect("lock poisoned").iter() {
            if let Some(e) = p.poll_error() {
                failed_out.push((id.clone(), e));
            }
        }
        for (id, e) in failed_out {
            eprintln!("omp-device-hub: Ausgang {id} ausgefallen: {e}");
            self.playbacks.lock().expect("lock poisoned").remove(&id);
            status.insert(id, format!("error: {e}"));
        }
        let stale_out: Vec<String> = self.receivers_added.iter().filter(|id| !wanted_out.contains(*id)).cloned().collect();
        for id in stale_out {
            self.receivers_added.remove(&id);
            self.playbacks.lock().expect("lock poisoned").remove(&id);
            let _ = self.changes.send(SenderChange::RemoveReceiver { device_id: id });
        }
        for id in &wanted_out {
            if !self.receivers_added.contains(id) {
                let Some(d) = devices.iter().find(|d| &d.id == id) else { continue };
                self.receivers_added.insert(id.clone());
                let _ = self.changes.send(SenderChange::AddReceiver { device_id: id.clone(), label: format!("{} {}", self.label, d.name) });
            }
            if status.contains_key(id) {
                continue;
            }
            if let Some(prev) = prev_status.get(id).filter(|s| s.starts_with("error")) {
                status.insert(id.clone(), prev.clone());
                continue;
            }
            let playbacks = self.playbacks.lock().expect("lock poisoned");
            let st = match playbacks.get(id) {
                Some(p) if p.flowing() => "flowing",
                Some(_) => "starting",
                None => "waiting",
            };
            status.insert(id.clone(), st.to_string());
        }
        self.hub.lock().expect("lock poisoned").status = status;
    }

    /// Beim Beenden: alles abmelden.
    fn shutdown(&mut self) {
        for (id, _o) in self.running.drain() {
            let _ = self.changes.send(SenderChange::Remove { sender_id: offer::sender_id(&id) });
        }
        for id in self.receivers_added.drain() {
            let _ = self.changes.send(SenderChange::RemoveReceiver { device_id: id });
        }
        self.playbacks.lock().expect("lock poisoned").clear();
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
    let test_sink = test_source;
    let registry = RegistryClient::new(registry_url.clone());
    let (sender_tx, mut sender_rx) = tokio::sync::mpsc::unbounded_channel::<SenderChange>();
    let ctx = match MxlContext::new(&domain) {
        Ok(c) => Some(Arc::new(c)),
        Err(e) => {
            eprintln!("omp-device-hub: MXL nicht verfügbar ({e}) — Geräte werden erkannt, aber nicht angeboten");
            None
        }
    };
    let playbacks: Playbacks = Arc::new(Mutex::new(HashMap::new()));
    let receivers: Receivers = Arc::new(Mutex::new(HashMap::new()));

    // Abgleich: Soll (eingeschaltet ∧ angesteckt) gegen laufende Anbietungen. Hotplug per
    // Abfrage: die billige sysfs-Sicht alle POLL; nur bei geänderter ID-Menge (oder `rescan`)
    // läuft die teure Fähigkeitsabfrage über GStreamer.
    let scanner = {
        let (hub, rescan, wake, shutdown) = (hub.clone(), rescan.clone(), wake.clone(), shutdown.clone());
        let mut rec = Reconciler {
            hub: hub.clone(),
            ctx: ctx.clone(),
            label: hub_label.clone(),
            test_source,
            changes: sender_tx.clone(),
            playbacks: playbacks.clone(),
            running: HashMap::new(),
            receivers_added: HashSet::new(),
        };
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
                wake.store(false, Ordering::Relaxed);
                rec.reconcile();
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
            rec.shutdown();
        })
    };

    let store: Arc<dyn ParamStore> = Arc::new(HubStore { hub: hub.clone(), receivers: receivers.clone(), rescan, wake });
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
                SenderChange::AddReceiver { device_id, label } => {
                    let receiver_id = offer::receiver_id(&device_id);
                    let spec = ReceiverSpec {
                        id: Some(receiver_id.clone()),
                        transport: Some(TRANSPORT_MXL.to_string()),
                        media_types: Some(vec!["audio/float32".to_string()]),
                        label: Some(label),
                    };
                    match handle.add_receiver(spec).await {
                        Ok(_) => {
                            let connection = Arc::new(ReceiverConnection::new(
                                receiver_id,
                                OutputControl {
                                    device_id: device_id.clone(),
                                    registry: registry.clone(),
                                    hub: hub.clone(),
                                    playbacks: playbacks.clone(),
                                    ctx: ctx.clone(),
                                    test_sink,
                                },
                            ));
                            receivers.lock().expect("lock poisoned").insert(device_id, connection);
                            Ok(())
                        }
                        Err(e) => Err(e),
                    }
                }
                SenderChange::RemoveReceiver { device_id } => {
                    receivers.lock().expect("lock poisoned").remove(&device_id);
                    handle.remove_receiver(&offer::receiver_id(&device_id)).await
                }
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
