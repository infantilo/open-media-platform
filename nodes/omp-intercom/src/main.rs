//! `omp-intercom` — Intercom-Node (UMSETZUNG.md Kapitel 47).
//!
//! Browser-Panels verbinden sich per WebRTC (`POST /offer?token=…`, Opus + Datenkanal `ctl`); der
//! Node mischt alle 20 ms mit dem Mix-Kern ([`mix`]) und schickt jedem Teilnehmer sein Mix-minus.
//! Konfiguration (Teilnehmer, Kanäle, Rechte) kommt per `PUT /config` (Orchestrator-Modul `intercom`)
//! oder aus `OMP_INTERCOM_CONFIG` (Datei) beim Start.

mod hub;
mod ice;
mod mix;
mod mxl_io;
mod peer;
mod tally;
mod uibundle;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use omp_node_sdk::connection::{bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery, ReceiverConnection};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, MediaReadySource, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse,
    ReceiverSpec, SenderSpec, SetError,
};
use serde_json::{Value, json};

const PANEL: &str = include_str!("../ui/panel.html");

fn env_or(key: &str, fallback: &str) -> String {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => v,
        _ => fallback.to_string(),
    }
}

fn token_from_query(path: &str) -> &str {
    let Some((_, query)) = path.split_once('?') else { return "" };
    query.split('&').find_map(|p| p.strip_prefix("token=")).unwrap_or("")
}

struct Store {
    hub: Arc<hub::Hub>,
    latency_ms: u32,
    config_file: Option<String>,
    // Serialisiert gleichzeitige Angebote desselben Teilnehmers.
    offer_lock: Mutex<()>,
    /// IS-05-Steuerung der Programm-Eingänge (leer ohne MXL).
    inputs: Vec<Arc<ReceiverConnection<mxl_io::InputControl>>>,
}

fn text(status: u16, body: impl Into<String>) -> RawResponse {
    RawResponse { status, content_type: "text/plain; charset=utf-8", body: body.into().into_bytes() }
}

fn json_resp(status: u16, v: Value) -> RawResponse {
    RawResponse { status, content_type: "application/json", body: v.to_string().into_bytes() }
}

impl Store {
    fn offer(&self, path: &str, body: &[u8]) -> RawResponse {
        let token = token_from_query(path);
        let who = {
            let core = self.hub.core.lock().expect("lock poisoned");
            match core.party_by_token(token) {
                Some(id) => id,
                None => return text(401, "missing or invalid token"),
            }
        };
        let Ok(sdp) = std::str::from_utf8(body) else { return text(400, "offer is not UTF-8") };
        let _serial = self.offer_lock.lock().expect("lock poisoned");

        let hub_msg = self.hub.clone();
        let on_message: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |m: String| {
            if let Ok(v) = serde_json::from_str::<Value>(&m) {
                hub_msg.core.lock().expect("lock poisoned").command(who, &v);
            }
        });
        let hub_open = self.hub.clone();
        let on_open: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            hub_open.core.lock().expect("lock poisoned").mark_dirty();
        });
        let hub_close = self.hub.clone();
        let generation = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let gen_close = generation.clone();
        let on_close: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            // Nur beenden, wenn diese Sitzung noch die aktuelle ist (eine neue Sitzung desselben Teilnehmers bleibt).
            let mut core = hub_close.core.lock().expect("lock poisoned");
            let id = gen_close.load(Ordering::Relaxed);
            if core.session_generation(who) == Some(id) {
                core.end_session(who);
            }
        });
        match peer::Peer::answer(sdp, self.latency_ms, on_message, on_open, on_close) {
            Ok((peer, answer)) => {
                let old = {
                    let mut core = self.hub.core.lock().expect("lock poisoned");
                    // Eine neue Sitzung beginnt sauber: keine Sprechtasten/Rufe aus der alten.
                    core.reset_runtime(who);
                    let id = core.register_session(who, peer);
                    generation.store(id, Ordering::Relaxed);
                    core.take_replaced(who)
                };
                if let Some(old) = old {
                    old.close();
                }
                RawResponse { status: 201, content_type: "application/sdp", body: answer.into_bytes() }
            }
            Err(e) => {
                eprintln!("omp-intercom: Angebot von Teilnehmer {who} fehlgeschlagen: {e}");
                text(500, e)
            }
        }
    }

    fn put_config(&self, body: &[u8]) -> RawResponse {
        let Ok(v) = serde_json::from_slice::<Value>(body) else { return text(400, "kein JSON") };
        let result = self.hub.core.lock().expect("lock poisoned").apply_config(&v);
        match result {
            Ok(()) => {
                if let Some(path) = &self.config_file {
                    if let Err(e) = std::fs::write(path, v.to_string()) {
                        eprintln!("omp-intercom: Konfiguration nicht gespeichert ({path}): {e}");
                    }
                }
                json_resp(200, json!({"ok": true}))
            }
            Err(e) => text(400, e),
        }
    }

    /// IS-05-Verbindungs-API der Programm-Eingänge (Muster `omp-audio-monitor`, hier mehrere Receiver).
    fn connection_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if self.inputs.is_empty() {
            return None;
        }
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        if let Some(r) = root_discovery(method, path) {
            return Some(to_raw(r));
        }
        let ids: Vec<&str> = self.inputs.iter().map(|c| c.id()).collect();
        if let Some(r) = list_ids(method, path, "receivers", &ids) {
            return Some(to_raw(r));
        }
        if let Some(r) = bulk_discovery(method, path) {
            return Some(to_raw(r));
        }
        if let Some(r) = bulk_patch(method, path, "receivers", body, |id, params| {
            self.inputs.iter().find(|c| c.id() == id).map(|c| c.patch_staged(params).0)
        }) {
            return Some(to_raw(r));
        }
        if let Some(r) = bulk_patch(method, path, "senders", body, |_, _| None) {
            return Some(to_raw(r));
        }
        self.inputs.iter().find_map(|c| c.handle(method, path, body)).map(to_raw)
    }

    fn status_json(&self) -> Value {
        let core = self.hub.core.lock().expect("lock poisoned");
        let parties: Vec<Value> = core
            .parties
            .iter()
            .map(|(id, p)| {
                let s = core.sessions.get(id);
                json!({"id": id, "name": p.name, "kind": p.kind, "online": s.map(|s| s.connected()).unwrap_or(false),
                       "state": s.map(|s| s.state()).unwrap_or_else(|| "none".into()),
                       "rx_samples": s.map(|s| s.rx_samples.load(Ordering::Relaxed)).unwrap_or(0),
                       "underruns": s.map(|s| s.underruns.load(Ordering::Relaxed)).unwrap_or(0),
                       "dropped": s.map(|s| s.dropped.load(Ordering::Relaxed)).unwrap_or(0),
                       "ring_ms": s.map(|s| s.ring_us.load(Ordering::Relaxed) as f64 / 1000.0).unwrap_or(0.0),
                       "speaking": core.engine.is_speaking(*id), "mic_db": core.engine.mic_db(*id)})
            })
            .collect();
        json!({
            "parties": parties,
            "on_air": core.on_air,
            "mxl": core.mxl.as_ref().map(|io| json!({
                "inputs": (0..io.input_count()).map(|i| json!({"slot": i + 1, "flow": io.input_flow(i), "flowing": io.input_flowed(i)})).collect::<Vec<_>>(),
                "outputs": (0..io.output_count()).map(|i| json!({"slot": i + 1, "flow": io.output_flow(i)})).collect::<Vec<_>>(),
            })),
            "ticks": self.hub.stats.ticks.load(Ordering::Relaxed),
            "late_ticks": self.hub.stats.late_ticks.load(Ordering::Relaxed),
            "max_tick_us": self.hub.stats.max_tick_us.load(Ordering::Relaxed),
        })
    }
}

impl ParamStore for Store {
    fn descriptor(&self) -> Descriptor {
        let ro = |name: &str, kind: ParamType| ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly: true };
        let mut on_air = ro("onAir", ParamType::Boolean);
        on_air.readonly = false;
        Descriptor {
            latency: None,
            parameters: vec![on_air, ro("partiesTotal", ParamType::Number), ro("partiesOnline", ParamType::Number), ro("lateTicks", ParamType::Number), ro("maxTickUs", ParamType::Number)],
            methods: vec![
                MethodSpec { name: "forceMute".into(), args: vec![MethodArg { name: "party".into(), kind: ParamType::Number }, MethodArg { name: "on".into(), kind: ParamType::Boolean }] },
                MethodSpec { name: "resetStats".into(), args: vec![] },
                // Fernbedienung einer Sprechstelle (Stream Deck): dieselben Befehle wie der Datenkanal des Panels (JSON-Text).
                MethodSpec { name: "panelCommand".into(), args: vec![MethodArg { name: "party".into(), kind: ParamType::Number }, MethodArg { name: "cmd".into(), kind: ParamType::String }] },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let core = self.hub.core.lock().expect("lock poisoned");
        match name {
            "onAir" => Some(json!(core.on_air)),
            "partiesTotal" => Some(json!(core.parties.len())),
            "partiesOnline" => Some(json!(core.sessions.values().filter(|s| s.connected()).count())),
            "lateTicks" => Some(json!(self.hub.stats.late_ticks.load(Ordering::Relaxed))),
            "maxTickUs" => Some(json!(self.hub.stats.max_tick_us.load(Ordering::Relaxed))),
            // `deck.<Teilnehmer-ID>`: Zustand dieser Sprechstelle wie im Panel (Stream Deck, Anzeigen).
            other => {
                let id: u32 = other.strip_prefix("deck.")?.parse().ok()?;
                core.state_for(id)
            }
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        match name {
            "onAir" => {
                let on = value.as_bool().ok_or(SetError::Unknown)?;
                self.hub.core.lock().expect("lock poisoned").set_on_air(on);
                Ok(())
            }
            "partiesTotal" | "partiesOnline" | "lateTicks" | "maxTickUs" => Err(SetError::ReadOnly),
            _ => Err(SetError::Unknown),
        }
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "forceMute" => {
                let party = args.get("party").and_then(Value::as_u64).ok_or(InvokeError::Message("party fehlt".into()))? as u32;
                let on = args.get("on").and_then(Value::as_bool).unwrap_or(true);
                let mut core = self.hub.core.lock().expect("lock poisoned");
                core.force_mute(party, on).map_err(InvokeError::Message)
            }
            "panelCommand" => {
                let party = args.get("party").and_then(Value::as_u64).ok_or(InvokeError::Message("party fehlt".into()))? as u32;
                let cmd = args.get("cmd").and_then(Value::as_str).ok_or(InvokeError::Message("cmd fehlt".into()))?;
                let v: Value = serde_json::from_str(cmd).map_err(|e| InvokeError::Message(format!("cmd kein JSON: {e}")))?;
                let mut core = self.hub.core.lock().expect("lock poisoned");
                if !core.parties.contains_key(&party) {
                    return Err(InvokeError::Message(format!("unbekannter Teilnehmer {party}")));
                }
                core.command(party, &v);
                Ok(())
            }
            "resetStats" => {
                self.hub.stats.late_ticks.store(0, Ordering::Relaxed);
                self.hub.stats.max_tick_us.store(0, Ordering::Relaxed);
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let bare = path.split('?').next().unwrap_or(path);
        match (method, bare) {
            ("GET", "/panel" | "/") => {
                let valid = self.hub.core.lock().expect("lock poisoned").party_by_token(token_from_query(path)).is_some();
                Some(if valid {
                    RawResponse { status: 200, content_type: "text/html; charset=utf-8", body: PANEL.as_bytes().to_vec() }
                } else {
                    text(401, "missing or invalid token")
                })
            }
            ("POST", "/offer") => Some(self.offer(path, body)),
            ("DELETE", "/offer") => {
                let mut core = self.hub.core.lock().expect("lock poisoned");
                if let Some(id) = core.party_by_token(token_from_query(path)) {
                    core.end_session(id);
                    Some(text(200, "ok"))
                } else {
                    Some(text(401, "missing or invalid token"))
                }
            }
            ("GET", "/config") => Some(json_resp(200, self.hub.core.lock().expect("lock poisoned").config_json())),
            ("PUT", "/config") => Some(self.put_config(body)),
            ("GET", "/status") => Some(json_resp(200, self.status_json())),
            _ => self.connection_route(method, path, body).or_else(|| uibundle::route(method, bare)),
        }
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        match path.split('?').next().unwrap_or(path) {
            "/offer" => Some(vec!["POST", "DELETE"]),
            "/config" => Some(vec!["GET", "PUT"]),
            _ => self
                .inputs
                .iter()
                .find_map(|c| c.cors_methods(path))
                .or_else(|| bulk_cors_methods(path, "senders"))
                .or_else(|| bulk_cors_methods(path, "receivers")),
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    gstreamer::init()?;
    let label = env_or("OMP_LABEL", "Intercom");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9450").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let latency_ms: u32 = env_or("OMP_INTERCOM_LATENCY_MS", "40").parse()?;
    let config_file = std::env::var("OMP_INTERCOM_CONFIG").ok().filter(|v| !v.is_empty());

    let hub = hub::Hub::new();
    if let Some(path) = &config_file {
        match std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            Some(cfg) => {
                if let Err(e) = hub.core.lock().expect("lock poisoned").apply_config(&cfg) {
                    eprintln!("omp-intercom: gespeicherte Konfiguration ungültig: {e}");
                }
            }
            None => eprintln!("omp-intercom: keine gespeicherte Konfiguration in {path} (Start leer)"),
        }
    }
    hub.spawn_clock();
    let ticks = hub.stats.ticks.clone();

    // MXL-Programmeingänge und Kanalmix-Ausgänge (fehlt libmxl/die Domain, läuft der Node ohne).
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let n_in: usize = env_or("OMP_INTERCOM_PROGRAM_INPUTS", "2").parse()?;
    let n_out: usize = env_or("OMP_INTERCOM_MIX_OUTPUTS", "2").parse()?;
    let out_flow_ids: Vec<String> = (0..n_out).map(|_| omp_node_sdk::idgen::new_v4()).collect();
    let io = if n_in + n_out == 0 {
        None
    } else {
        match mxl_io::MxlIo::new(&domain, n_in, &out_flow_ids) {
            Ok(io) => Some(io),
            Err(e) => {
                eprintln!("omp-intercom: MXL nicht verfügbar ({e}) — Betrieb ohne Programmeingänge und Mix-Ausgänge");
                None
            }
        }
    };
    hub.core.lock().expect("lock poisoned").mxl = io.clone();
    let mut receiver_specs = Vec::new();
    let mut sender_specs = Vec::new();
    let mut inputs = Vec::new();
    if let Some(io) = &io {
        for slot in 0..io.input_count() {
            let id = omp_node_sdk::idgen::new_v4();
            inputs.push(Arc::new(ReceiverConnection::new(
                id.clone(),
                mxl_io::InputControl { io: io.clone(), slot, registry: RegistryClient::new(registry_url.clone()) },
            )));
            receiver_specs.push(ReceiverSpec {
                id: Some(id),
                label: Some(format!("Programm {}", slot + 1)),
                transport: Some(TRANSPORT_MXL.to_string()),
                media_types: Some(vec!["audio/float32".to_string()]),
                ..Default::default()
            });
        }
        for (slot, flow_id) in out_flow_ids.iter().enumerate() {
            sender_specs.push(SenderSpec {
                label: Some(format!("Intercom Mix {}", slot + 1)),
                transport: Some(TRANSPORT_MXL.to_string()),
                flow: Some(FlowSpec::Audio {
                    id: Some(flow_id.clone()),
                    sample_rate_numerator: 48_000,
                    channel_count: 2,
                    media_type: "audio/float32".to_string(),
                    bit_depth: 32,
                    source_id: None,
                }),
                ..Default::default()
            });
        }
    }

    let tally_hub = hub.clone();
    let tally_nats = nats_url.clone();
    let tally_registry = registry_url.clone();
    let store: Arc<dyn ParamStore> = Arc::new(Store { hub, latency_ms, config_file, offer_lock: Mutex::new(()), inputs });
    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: sender_specs,
            receivers: receiver_specs,
            instance_id: std::env::var("OMP_INSTANCE_ID").ok(),
            media_ready: MediaReadySource::NotApplicable,
        },
        store,
    )
    .await?;
    handle.register_worker("clock", ticks);
    tokio::spawn(tally::run(tally_hub, tally::TriggerFilter::new(&env_or("OMP_INTERCOM_ONAIR_SOURCES", "")), tally_nats, tally_registry));
    tokio::signal::ctrl_c().await?;
    eprintln!("omp-intercom: shutdown requested");
    Ok(())
}
