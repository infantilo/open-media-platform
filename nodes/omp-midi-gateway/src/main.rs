//! omp-midi-gateway (Kapitel 93, Weg B): MIDI-Pulte am Server — USB (ALSA-Rohgeräte), Netzwerk (RTP-MIDI/AppleMIDI) und Simulator.
//! Mackie-Control-Pulte (Hauptpult + Erweiterungen, z. B. iCON V1-M/V1-X, P1-M/P1-X) steuern den Audiomischer; andere MIDI-Geräte
//! laufen über ein generisches Profil. Nicht verbrauchte Tasten und Reglerbewegungen gehen als NATS-Ereignis `omp.midi.<node>.…`
//! hinaus (Auslöser für Workflows). Vertrag: `docs/CONTRACT-MIDI.md`.

mod config;
#[cfg(test)]
mod e2e;
mod engine;
mod fader;
mod keys;
mod mcu;
mod mixer;
mod profile;
mod raw;
mod rtp;
mod runtime;
mod surface;
mod uibundle;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_node_sdk::is04::RegistryClient;
use omp_node_sdk::{Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, SetError};
use omp_playout_core::remote::{self, OrchestratorAuth};
use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

use config::{Config, UnitKind};
use runtime::{Msg, Shared};

fn ro(name: &str, kind: ParamType) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly: true }
}

fn m(name: &str, args: &[(&str, ParamType)]) -> MethodSpec {
    MethodSpec { name: name.to_string(), args: args.iter().map(|(n, k)| MethodArg { name: n.to_string(), kind: *k }).collect() }
}

struct Store {
    sh: Arc<Mutex<Shared>>,
}

fn arg_u(args: &serde_json::Map<String, Value>, k: &str, max: u64) -> Result<usize, InvokeError> {
    let v = args.get(k).and_then(Value::as_u64).ok_or_else(|| InvokeError::Message(format!("{k} fehlt")))?;
    if v > max {
        return Err(InvokeError::Message(format!("{k}: höchstens {max}")));
    }
    Ok(v as usize)
}

impl Store {
    /// Simulierter Anschluss der Einheit `unit` (ab 1).
    fn sim(&self, args: &serde_json::Map<String, Value>) -> Result<surface::SimPort, InvokeError> {
        let unit = arg_u(args, "unit", 8)?;
        let s = self.sh.lock().expect("lock poisoned");
        s.sims.iter().find(|(i, _)| i + 1 == unit).map(|(_, p)| p.clone()).ok_or_else(|| InvokeError::Message(format!("Einheit {unit} ist kein Simulator")))
    }
}

impl ParamStore for Store {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                ro("config", ParamType::String),
                ro("status", ParamType::String),
                ro("ports", ParamType::String),
                ro("recent", ParamType::String),
            ],
            methods: vec![
                m("setConfig", &[("config", ParamType::String)]),
                m("bank", &[("delta", ParamType::Number)]),
                m("simulateTouch", &[("unit", ParamType::Number), ("strip", ParamType::Number), ("down", ParamType::Boolean)]),
                m("simulateFader", &[("unit", ParamType::Number), ("strip", ParamType::Number), ("value", ParamType::Number)]),
                m("simulatePress", &[("unit", ParamType::Number), ("name", ParamType::String)]),
                m("simulateTurn", &[("unit", ParamType::Number), ("strip", ParamType::Number), ("steps", ParamType::Number)]),
                m("simulateJog", &[("unit", ParamType::Number), ("steps", ParamType::Number)]),
                m("simulateLink", &[("unit", ParamType::Number), ("up", ParamType::Boolean)]),
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let s = self.sh.lock().expect("lock poisoned");
        Some(match name {
            "config" => json!(config::to_value(&s.cfg).to_string()),
            "status" => json!(s.status.to_string()),
            "ports" => {
                let devs: Vec<Value> = raw::list_devices().iter().map(|d| json!({"path": d.path, "card": d.card, "device": d.device, "name": d.name})).collect();
                json!(Value::Array(devs).to_string())
            }
            "recent" => json!(Value::Array(s.recent.iter().cloned().collect()).to_string()),
            _ => return None,
        })
    }

    fn set(&self, name: &str, _value: Value) -> Result<(), SetError> {
        // Die Konfiguration wird über die Methode `setConfig` geändert (nur sie kann den Grund einer Ablehnung mitgeben).
        if self.get(name).is_some() { Err(SetError::ReadOnly) } else { Err(SetError::Unknown) }
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "setConfig" => {
                let cfg = match args.get("config") {
                    Some(Value::String(t)) => config::parse_config(t),
                    Some(v) => config::from_value(v),
                    None => return Err(InvokeError::Message("config fehlt".to_string())),
                }
                .map_err(InvokeError::Message)?;
                let mut s = self.sh.lock().expect("lock poisoned");
                s.cfg = cfg;
                s.generation += 1;
                Ok(())
            }
            "bank" => {
                let d = args.get("delta").and_then(Value::as_i64).ok_or_else(|| InvokeError::Message("delta fehlt".to_string()))?;
                self.sh.lock().expect("lock poisoned").bank_delta += d;
                Ok(())
            }
            "simulateTouch" => {
                let (p, strip) = (self.sim(args)?, arg_u(args, "strip", 8)?);
                let down = args.get("down").and_then(Value::as_bool).ok_or_else(|| InvokeError::Message("down fehlt".to_string()))?;
                p.state.lock().expect("lock poisoned").touch(strip, down);
                Ok(())
            }
            "simulateFader" => {
                let (p, strip) = (self.sim(args)?, arg_u(args, "strip", 8)?);
                let v = arg_u(args, "value", 16383)?;
                let mut s = p.state.lock().expect("lock poisoned");
                s.drag(strip, v as i32);
                s.release(strip);
                Ok(())
            }
            "simulatePress" => {
                let p = self.sim(args)?;
                let n = args.get("name").and_then(Value::as_str).ok_or_else(|| InvokeError::Message("name fehlt".to_string()))?;
                p.state.lock().expect("lock poisoned").press(n).map_err(InvokeError::Message)
            }
            "simulateTurn" => {
                let (p, strip) = (self.sim(args)?, arg_u(args, "strip", 7)?);
                let steps = args.get("steps").and_then(Value::as_i64).ok_or_else(|| InvokeError::Message("steps fehlt".to_string()))?;
                p.state.lock().expect("lock poisoned").turn(strip, steps as i32);
                Ok(())
            }
            "simulateJog" => {
                let p = self.sim(args)?;
                let steps = args.get("steps").and_then(Value::as_i64).ok_or_else(|| InvokeError::Message("steps fehlt".to_string()))?;
                p.state.lock().expect("lock poisoned").jog_wheel(steps as i32);
                Ok(())
            }
            "simulateLink" => {
                let p = self.sim(args)?;
                let up = args.get("up").and_then(Value::as_bool).ok_or_else(|| InvokeError::Message("up fehlt".to_string()))?;
                p.state.lock().expect("lock poisoned").up = up;
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if let Some(r) = uibundle::route(method, path) {
            return Some(r);
        }
        // Sicherung: die Konfiguration (Laufzeitzustand wird nach einem Neustart aus ihr neu aufgebaut)
        let json_ok = |v: Value| RawResponse { status: 200, content_type: "application/json", body: serde_json::to_vec(&v).unwrap_or_default() };
        if method == "GET" && path == "/state" {
            let s = self.sh.lock().expect("lock poisoned");
            return Some(json_ok(json!({"state": {"config": config::to_value(&s.cfg)}})));
        }
        if method == "POST" && path == "/state" {
            let Ok(v) = serde_json::from_slice::<Value>(body) else {
                return Some(RawResponse { status: 400, content_type: "application/json", body: br#"{"error":"invalid JSON body"}"#.to_vec() });
            };
            if let Some(c) = v.pointer("/state/config") {
                match config::from_value(c) {
                    Ok(cfg) => {
                        let mut s = self.sh.lock().expect("lock poisoned");
                        s.cfg = cfg;
                        s.generation += 1;
                    }
                    Err(e) => return Some(RawResponse { status: 400, content_type: "application/json", body: serde_json::to_vec(&json!({"error": e})).unwrap_or_default() }),
                }
            }
            return Some(json_ok(json!({"ok": true})));
        }
        None
    }

    fn extra_options(&self, _path: &str) -> Option<Vec<&'static str>> {
        None
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

async fn publisher(mut rx: UnboundedReceiver<Msg>, handle: omp_node_sdk::NodeHandle) {
    while let Some(msg) = rx.recv().await {
        let mut body = msg.body;
        body["node"] = json!(handle.node_id());
        handle.publish_json(format!("omp.midi.{}.{}", handle.node_id(), msg.suffix), &body).await;
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "MIDI-Gateway");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "0").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let orchestrator_url = env_or("OMP_ORCHESTRATOR_URL", "http://localhost:8000");
    let launch_secret = std::env::var("OMP_LAUNCH_SECRET").unwrap_or_default();
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let auth = OrchestratorAuth::new();
    if let (Some(id), false) = (instance_id.as_deref(), launch_secret.is_empty()) {
        let (url, id, secret, auth2) = (orchestrator_url.clone(), id.to_string(), launch_secret.clone(), auth.clone());
        std::thread::spawn(move || {
            let mut warned = false;
            loop {
                match remote::fetch_service_token(&url, &id, &secret) {
                    Ok(t) => {
                        auth2.set(t);
                        warned = false;
                        std::thread::sleep(Duration::from_secs(3600));
                    }
                    Err(e) => {
                        if !warned {
                            eprintln!("omp-midi-gateway: Service-Token noch nicht erhalten ({e}) — erneuter Versuch alle 2 s");
                            warned = true;
                        }
                        std::thread::sleep(Duration::from_secs(2));
                    }
                }
            }
        });
    } else {
        eprintln!("omp-midi-gateway: OMP_INSTANCE_ID/OMP_LAUNCH_SECRET fehlen — keine Verbindung zum Audiomischer");
    }

    // Vorgabe aus der Umgebung; die Oberfläche/Sicherung überschreibt sie später
    let cfg = match std::env::var("OMP_MIDI_CONFIG") {
        Ok(t) if !t.trim().is_empty() => config::parse_config(&t).unwrap_or_else(|e| {
            eprintln!("omp-midi-gateway: OMP_MIDI_CONFIG ungültig ({e}) — starte ohne Einheiten");
            Config::default()
        }),
        _ => Config::default(),
    };
    let _ = UnitKind::Sim; // (Typ bleibt für Konfigurationsprüfungen eingebunden)
    let sh = Arc::new(Mutex::new(Shared::new(cfg)));
    let (tx, rx) = unbounded_channel();
    let heartbeat = Arc::new(AtomicU64::new(0));
    {
        let registry = RegistryClient::new(registry_url.clone());
        let (sh, url, auth, hb) = (sh.clone(), orchestrator_url.clone(), auth.clone(), heartbeat.clone());
        std::thread::spawn(move || runtime::run_loop(sh, tx, url, auth, registry, hb));
    }
    let store: Arc<dyn ParamStore> = Arc::new(Store { sh });
    let handle = omp_node_sdk::start(
        NodeConfig { label, host, port, registry_url, nats_url, senders: vec![], receivers: vec![], instance_id, media_ready: omp_node_sdk::MediaReadySource::NotApplicable },
        store,
    )
    .await?;
    handle.register_worker("midi", heartbeat.clone());
    tokio::spawn(publisher(rx, handle.clone()));
    let _ = heartbeat.load(Ordering::Relaxed);
    tokio::signal::ctrl_c().await?;
    Ok(())
}
