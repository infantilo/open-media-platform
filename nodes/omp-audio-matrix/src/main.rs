//! omp-audio-matrix (Kap. 107): Audio-Kreuzschiene mit frei konfigurierbaren Ein- und Ausgängen, die sich zur Laufzeit ändern.
//! Ein Eingang ist ein NMOS-Empfänger, ein Ausgang ein NMOS-Sender mit eigenem MXL-Flow (Mono, Stereo, … bis 64 Kanäle), dazwischen
//! die Kreuzschiene mit Kopie (bitgleich) oder Gain/Summe (`omp_mediaio::matrix`, `rawmatrix`). Teiler (1 → n) und Kombinierer
//! (n → 1, z. B. 16 Kanäle aus mehreren Quellen) sind Sonderfälle derselben Konfiguration (Parameter `matrix.config`, JSON).
//!
//! Zustand: `GET/POST /state` (Konfiguration + Empfänger-/Sender-IDs je Port), damit Verbindungen einen Neustart überstehen.

mod uibundle;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_mediaio::matrix::{self, Config};
use omp_mediaio::mxl::MxlContext;
use omp_mediaio::rawmatrix::{OutputInfo, RawAudioMatrix};
use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource, bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery};
use omp_node_sdk::is04::{RegistryClient, SourceChannel, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{Descriptor, InvokeError, NodeConfig, NodeHandle, ParamSpec, ParamStore, ParamType, RawResponse, ReceiverSpec, SenderSpec, SetError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

const SAMPLE_RATE: u32 = 48000;

/// IDs, die ein Port beim Wiederherstellen behalten soll (damit Verbindungen weiter auf ihn zeigen).
#[derive(Clone, Default, Serialize, Deserialize)]
struct Hints {
    #[serde(default)]
    receivers: HashMap<String, String>,
    #[serde(default)]
    senders: HashMap<String, String>,
}

/// Der Orchestrator ersetzt beim Sichern des Zustands jede Sender-ID einer eigenen Rolle durch einen Platzhalter (`workflows/state.go`,
/// Listenposition des Senders); dieser Node legt seine Sender aber erst **nach** dem Wiederherstellen an, der Platzhalter wäre
/// unauflösbar. Die Sender-IDs stehen deshalb umgekehrt und ohne Bindestriche im Zustand und werden beim Lesen zurückgewandelt.
fn enc_id(id: &str) -> String {
    id.chars().filter(|c| *c != '-').rev().collect()
}

fn dec_id(s: &str) -> String {
    let h: Vec<char> = s.chars().rev().collect();
    if h.len() != 32 {
        return s.to_string();
    }
    let t: String = h.iter().collect();
    format!("{}-{}-{}-{}-{}", &t[0..8], &t[8..12], &t[12..16], &t[16..20], &t[20..32])
}

struct Apply {
    config: Config,
    hints: Hints,
}

struct InputControl {
    port_id: String,
    registry: RegistryClient,
    engine: Arc<RawAudioMatrix>,
    flow: Arc<Mutex<Option<String>>>,
    last_error: Arc<Mutex<String>>,
}

impl ReceiverControl for InputControl {
    fn apply(&self, resource: &ReceiverResource) {
        let flow = match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(f) => Some(f),
                    None => {
                        eprintln!("omp-audio-matrix: sender {sender_id} has no flow_id");
                        return;
                    }
                },
                Err(e) => {
                    eprintln!("omp-audio-matrix: resolve sender {sender_id} failed: {e}");
                    return;
                }
            },
            _ => None,
        };
        *self.flow.lock().expect("lock poisoned") = flow.clone();
        match self.engine.connect_input(&self.port_id, flow) {
            Ok(()) => self.last_error.lock().expect("lock poisoned").clear(),
            Err(e) => {
                eprintln!("omp-audio-matrix: {e}");
                *self.last_error.lock().expect("lock poisoned") = e;
            }
        }
    }
}

struct InputEntry {
    receiver_id: String,
    conn: Arc<ReceiverConnection<InputControl>>,
    flow: Arc<Mutex<Option<String>>>,
}

#[derive(Clone, PartialEq)]
struct OutEntry {
    sender_id: String,
    flow_id: String,
    name: String,
    channels: usize,
    labels: String,
}

#[derive(Default)]
struct Topo {
    inputs: HashMap<String, InputEntry>,
    outputs: HashMap<String, OutEntry>,
}

struct MatrixStore {
    in_domain: String,
    out_domain: String,
    engine: Arc<RawAudioMatrix>,
    desired: Mutex<Config>,
    topo: Arc<Mutex<Topo>>,
    last_error: Arc<Mutex<String>>,
    commands: UnboundedSender<Apply>,
}

fn ro(name: &str, kind: ParamType) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly: true }
}

fn json_str<T: Serialize>(v: &T) -> Value {
    serde_json::json!(serde_json::to_string(v).unwrap_or_default())
}

impl MatrixStore {
    fn status(&self) -> Value {
        let cfg = self.desired.lock().expect("lock poisoned").clone();
        let topo = self.topo.lock().expect("lock poisoned");
        let st = self.engine.shared.inputs.lock().expect("lock poisoned").clone();
        let inputs: Vec<Value> = cfg
            .inputs
            .iter()
            .map(|p| {
                let s = st.get(&p.id).cloned().unwrap_or_default();
                serde_json::json!({"id": p.id, "name": p.name, "receiverId": topo.inputs.get(&p.id).map(|e| e.receiver_id.clone()), "connected": s.connected, "live": s.live, "flowChannels": s.channels})
            })
            .collect();
        let outputs: Vec<Value> = cfg
            .outputs
            .iter()
            .map(|p| {
                let o = topo.outputs.get(&p.id);
                serde_json::json!({"id": p.id, "name": p.name, "senderId": o.map(|e| e.sender_id.clone()), "flowId": o.map(|e| e.flow_id.clone()), "channels": p.channels.len()})
            })
            .collect();
        serde_json::json!({"inputs": inputs, "outputs": outputs, "overs": self.engine.shared.overs.load(Ordering::Relaxed)})
    }

    fn hints(&self) -> Hints {
        let t = self.topo.lock().expect("lock poisoned");
        Hints {
            receivers: t.inputs.iter().map(|(k, v)| (k.clone(), v.receiver_id.clone())).collect(),
            senders: t.outputs.iter().map(|(k, v)| (k.clone(), v.sender_id.clone())).collect(),
        }
    }

    fn request(&self, config: Config, hints: Hints) -> Result<(), String> {
        matrix::validate(&config)?;
        *self.desired.lock().expect("lock poisoned") = config.clone();
        self.commands.send(Apply { config, hints }).map_err(|_| "Worker beendet".to_string())
    }
}

impl ParamStore for MatrixStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                ro("inputDomain", ParamType::String),
                ro("outputDomain", ParamType::String),
                ro("flowing", ParamType::Boolean),
                ro("matrix.status", ParamType::String),
                ro("matrix.error", ParamType::String),
                // Gesamte Konfiguration als JSON (Eingänge, Ausgänge, Kreuzpunkte); Schreiben prüft und wendet sie live an.
                ParamSpec { name: "matrix.config".to_string(), kind: ParamType::String, unit: None, range: None, readonly: false },
            ],
            methods: vec![],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "inputDomain" => Some(serde_json::json!(self.in_domain)),
            "outputDomain" => Some(serde_json::json!(self.out_domain)),
            "flowing" => Some(serde_json::json!(self.engine.flowing())),
            "matrix.status" => Some(json_str(&self.status())),
            "matrix.error" => Some(serde_json::json!(self.last_error.lock().expect("lock poisoned").clone())),
            "matrix.config" => Some(json_str(&*self.desired.lock().expect("lock poisoned"))),
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        match name {
            "matrix.config" => {
                let text = match &value {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                let cfg = matrix::parse(&text).map_err(|e| {
                    eprintln!("omp-audio-matrix: {e}");
                    *self.last_error.lock().expect("lock poisoned") = e;
                    SetError::Unknown
                })?;
                self.last_error.lock().expect("lock poisoned").clear();
                self.request(cfg, self.hints()).map_err(|_| SetError::Unknown)
            }
            n if self.get(n).is_some() => Err(SetError::ReadOnly),
            _ => Err(SetError::Unknown),
        }
    }

    fn invoke(&self, _name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if let Some(r) = uibundle::route(method, path) {
            return Some(r);
        }
        let json = |status, v: Value| Some(RawResponse { status, content_type: "application/json", body: serde_json::to_vec(&v).unwrap_or_default() });
        if method == "GET" && path == "/state" {
            let h = self.hints();
            return json(200, serde_json::json!({"state": {"matrix": &*self.desired.lock().expect("lock poisoned"), "receivers": h.receivers, "senderKeys": h.senders.iter().map(|(k, v)| (k.clone(), enc_id(v))).collect::<HashMap<_, _>>()}}));
        }
        if method == "POST" && path == "/state" {
            let Ok(v) = serde_json::from_slice::<Value>(body) else { return json(400, serde_json::json!({"error": "invalid JSON body"})) };
            let Some(s) = v.get("state") else { return json(400, serde_json::json!({"error": "state fehlt"})) };
            let cfg: Config = match s.get("matrix").cloned().map(serde_json::from_value) {
                Some(Ok(c)) => c,
                Some(Err(e)) => return json(400, serde_json::json!({"error": format!("Matrix: {e}")})),
                None => return json(200, serde_json::json!({"ok": true})),
            };
            let hints = Hints {
                receivers: s.get("receivers").cloned().and_then(|x| serde_json::from_value(x).ok()).unwrap_or_default(),
                senders: s.get("senderKeys").cloned().and_then(|x| serde_json::from_value::<HashMap<String, String>>(x).ok()).unwrap_or_default().into_iter().map(|(k, v)| (k, dec_id(&v))).collect(),
            };
            return match self.request(cfg, hints) {
                Ok(()) => json(200, serde_json::json!({"ok": true})),
                Err(e) => json(400, serde_json::json!({"error": e})),
            };
        }
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        let topo = self.topo.lock().expect("lock poisoned");
        let ids: Vec<&str> = topo.inputs.values().map(|e| e.receiver_id.as_str()).collect();
        root_discovery(method, path)
            .or_else(|| list_ids(method, path, "receivers", &ids))
            .or_else(|| bulk_discovery(method, path))
            .or_else(|| {
                bulk_patch(method, path, "receivers", body, |rid, params| topo.inputs.values().find(|e| e.receiver_id == rid).map(|e| e.conn.patch_staged(params).0))
            })
            .or_else(|| bulk_patch(method, path, "senders", body, |_, _| None))
            .or_else(|| topo.inputs.values().find_map(|e| e.conn.handle(method, path, body)))
            .map(to_raw)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        let topo = self.topo.lock().expect("lock poisoned");
        topo.inputs.values().find_map(|e| e.conn.cors_methods(path)).or_else(|| bulk_cors_methods(path, "senders")).or_else(|| bulk_cors_methods(path, "receivers"))
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn sender_spec(info: &OutputInfo, port: &matrix::Port, sender_id: &str) -> SenderSpec {
    SenderSpec {
        id: Some(sender_id.to_string()),
        transport: Some(TRANSPORT_MXL.to_string()),
        flow: Some(FlowSpec::Audio { id: Some(info.flow_id.clone()), sample_rate_numerator: SAMPLE_RATE, channel_count: info.channels as u32, media_type: "audio/float32".to_string(), bit_depth: 32, source_id: None }),
        label: Some(info.name.clone()),
        audio_channels: Some(port.channels.iter().map(|c| SourceChannel { label: c.label.clone(), symbol: c.symbol.clone() }).collect()),
        ..Default::default()
    }
}

fn labels_key(p: &matrix::Port) -> String {
    serde_json::to_string(&p.channels).unwrap_or_default()
}

/// Gleicht NMOS-Empfänger und -Sender mit der Konfiguration ab (nach dem Umbau der Engine).
async fn apply(a: Apply, handle: &NodeHandle, engine: &Arc<RawAudioMatrix>, registry: &RegistryClient, topo: &Arc<Mutex<Topo>>, last_error: &Arc<Mutex<String>>) -> Result<(), String> {
    let infos = engine.set_config(a.config.clone())?;

    // Eingänge: entfernte abbauen, neue/umbenannte anlegen.
    let old_ids: Vec<(String, String)> = topo.lock().expect("lock poisoned").inputs.iter().map(|(k, v)| (k.clone(), v.receiver_id.clone())).collect();
    for (port_id, rid) in old_ids {
        let keep = a.config.inputs.iter().any(|p| p.id == port_id) && a.hints.receivers.get(&port_id).is_none_or(|h| *h == rid);
        if !keep {
            topo.lock().expect("lock poisoned").inputs.remove(&port_id);
            let _ = engine.connect_input(&port_id, None);
            if let Err(e) = handle.remove_receiver(&rid).await {
                eprintln!("omp-audio-matrix: remove_receiver {rid}: {e}");
            }
        }
    }
    for p in &a.config.inputs {
        if topo.lock().expect("lock poisoned").inputs.contains_key(&p.id) {
            continue;
        }
        let rid = a.hints.receivers.get(&p.id).cloned().unwrap_or_else(omp_node_sdk::idgen::new_v4);
        let spec = ReceiverSpec { id: Some(rid.clone()), transport: Some(TRANSPORT_MXL.to_string()), media_types: Some(vec!["audio/float32".to_string()]), label: Some(p.name.clone()), ..Default::default() };
        handle.add_receiver(spec).await.map_err(|e| format!("Eingang „{}“: {e}", p.name))?;
        let flow = Arc::new(Mutex::new(None));
        let conn = Arc::new(ReceiverConnection::new(rid.clone(), InputControl { port_id: p.id.clone(), registry: registry.clone(), engine: engine.clone(), flow: flow.clone(), last_error: last_error.clone() }));
        topo.lock().expect("lock poisoned").inputs.insert(p.id.clone(), InputEntry { receiver_id: rid, conn, flow });
    }
    // Bestehende Eingänge neu verbinden (Kanalzahl kann sich geändert haben; die Engine prüft sie erneut).
    let reconnect: Vec<(String, String)> = topo.lock().expect("lock poisoned").inputs.iter().filter_map(|(k, e)| e.flow.lock().expect("lock poisoned").clone().map(|f| (k.clone(), f))).collect();
    for (port, flow) in reconnect {
        if let Err(e) = engine.connect_input(&port, Some(flow)) {
            eprintln!("omp-audio-matrix: {e}");
            *last_error.lock().expect("lock poisoned") = e;
        }
    }

    // Ausgänge: entfernte, geänderte (Flow/Name/Labels) und neue Sender.
    let old: HashMap<String, OutEntry> = topo.lock().expect("lock poisoned").outputs.clone();
    for (port_id, entry) in &old {
        let wanted = infos.iter().find(|i| &i.port_id == port_id);
        let sender_hint = a.hints.senders.get(port_id);
        let port = a.config.outputs.iter().find(|p| &p.id == port_id);
        let same = match (wanted, port) {
            (Some(i), Some(p)) => i.flow_id == entry.flow_id && i.name == entry.name && labels_key(p) == entry.labels && sender_hint.is_none_or(|h| *h == entry.sender_id),
            _ => false,
        };
        if !same {
            topo.lock().expect("lock poisoned").outputs.remove(port_id);
            if let Err(e) = handle.remove_sender(&entry.sender_id).await {
                eprintln!("omp-audio-matrix: remove_sender {}: {e}", entry.sender_id);
            }
        }
    }
    for info in &infos {
        if topo.lock().expect("lock poisoned").outputs.contains_key(&info.port_id) {
            continue;
        }
        let Some(port) = a.config.outputs.iter().find(|p| p.id == info.port_id) else { continue };
        // Gleiche Sender-ID wie zuvor behalten (Verbindungen zeigen darauf), sonst Hinweis aus dem gesicherten Zustand.
        let sid = a.hints.senders.get(&info.port_id).cloned().or_else(|| old.get(&info.port_id).map(|o| o.sender_id.clone())).unwrap_or_else(omp_node_sdk::idgen::new_v4);
        handle.add_sender(sender_spec(info, port, &sid)).await.map_err(|e| format!("Ausgang „{}“: {e}", info.name))?;
        topo.lock().expect("lock poisoned").outputs.insert(info.port_id.clone(), OutEntry { sender_id: sid, flow_id: info.flow_id.clone(), name: info.name.clone(), channels: info.channels, labels: labels_key(port) });
    }
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Audio Matrix");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9397").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let in_domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let out_domain = match env_or("OMP_MXL_TARGET_DOMAIN", "") {
        d if d.is_empty() => in_domain.clone(),
        d => d,
    };
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let initial = match std::env::var("OMP_MATRIX_CONFIG").ok().filter(|v| !v.trim().is_empty()) {
        Some(j) => matrix::parse(&j).map_err(|e| {
            eprintln!("omp-audio-matrix: OMP_MATRIX_CONFIG: {e}");
            e
        })?,
        None => Config::default(),
    };

    let in_ctx = Arc::new(MxlContext::new(&in_domain)?);
    let out_ctx = if out_domain == in_domain { in_ctx.clone() } else { Arc::new(MxlContext::new(&out_domain)?) };
    let engine = Arc::new(RawAudioMatrix::start(in_ctx, out_ctx, SAMPLE_RATE, label.clone()));
    let (tx, rx): (UnboundedSender<Apply>, UnboundedReceiver<Apply>) = tokio::sync::mpsc::unbounded_channel();
    let topo = Arc::new(Mutex::new(Topo::default()));
    let last_error = Arc::new(Mutex::new(String::new()));
    let store = Arc::new(MatrixStore { in_domain, out_domain, engine: engine.clone(), desired: Mutex::new(initial.clone()), topo: topo.clone(), last_error: last_error.clone(), commands: tx.clone() });
    let probe_engine = engine.clone();
    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url: registry_url.clone(),
            nats_url,
            senders: vec![],
            receivers: vec![],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || probe_engine.flowing())),
        },
        store.clone(),
    )
    .await?;
    let _ = tx.send(Apply { config: initial, hints: Hints::default() });

    let registry = RegistryClient::new(registry_url);
    let stop = Arc::new(AtomicBool::new(false));
    let worker = async {
        let mut rx = rx;
        while let Some(first) = rx.recv().await {
            // Mehrere schnell aufeinanderfolgende Änderungen zusammenfassen: nur der letzte Stand zählt.
            let mut a = first;
            while let Ok(next) = rx.try_recv() {
                a = next;
            }
            match apply(a, &handle, &engine, &registry, &topo, &last_error).await {
                Ok(()) => last_error.lock().expect("lock poisoned").clear(),
                Err(e) => {
                    eprintln!("omp-audio-matrix: {e}");
                    handle.publish_alert(e.clone()).await;
                    *last_error.lock().expect("lock poisoned") = e;
                }
            }
        }
    };
    // Eingang ohne Signal: Alarm nach 3 Ticks (6 s) verbundener, aber stiller Eingänge, mit Entwarnung.
    let watch = async {
        let mut silent: HashMap<String, u32> = HashMap::new();
        let mut raised: HashMap<String, bool> = HashMap::new();
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        loop {
            tick.tick().await;
            let cfg = store.desired.lock().expect("lock poisoned").clone();
            let st = engine.shared.inputs.lock().expect("lock poisoned").clone();
            for p in &cfg.inputs {
                let quiet = st.get(&p.id).is_some_and(|s| s.connected && !s.live);
                let n = silent.entry(p.id.clone()).or_default();
                *n = if quiet { *n + 1 } else { 0 };
                let was = raised.get(&p.id).copied().unwrap_or(false);
                if *n >= 3 && !was {
                    raised.insert(p.id.clone(), true);
                    handle.publish_alert_ex("matrix-input-silent", "raised", "warning", &p.name, format!("Matrix-Eingang „{}“ liefert kein Signal", p.name)).await;
                } else if *n == 0 && was {
                    raised.insert(p.id.clone(), false);
                    handle.publish_alert_ex("matrix-input-silent", "cleared", "warning", &p.name, format!("Matrix-Eingang „{}“ liefert wieder Signal", p.name)).await;
                }
            }
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-audio-matrix: shutdown requested"),
        _ = worker => eprintln!("omp-audio-matrix: worker ended"),
        _ = watch => {},
    }
    stop.store(true, Ordering::Relaxed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sender_ids_roundtrip_and_hide_from_alias_replacement() {
        let id = "9a3f4e79-5b41-4f5e-b3d2-66ad86824a80";
        let e = enc_id(id);
        assert!(!e.contains(id) && !e.contains('-'));
        assert_eq!(dec_id(&e), id);
        assert_eq!(dec_id("kein-id"), "kein-id");
    }
}
