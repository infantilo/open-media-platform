//! omp-gpio (Radio, Kapitel 89/RC1): generische Ein-/Ausgänge (Kontakte) als Node. GPI → NATS-Ereignis `omp.gpio.<node>.in.<pin>`,
//! GPO ← Methode `setOutput`, Entprellung, Haltezeit und Fail-Safe-Pegel bei Verbindungsverlust (`docs/CONTRACT-GPIO.md`).
//! Das einzige Gerät dieser Stufe ist der Simulator (Methoden `simulateInput`/`simulateLink`); echte Geräte kommen als weitere
//! Gerätetreiber hinter dieselbe Zustandsmaschine (`gpio.rs`).

mod gpio;
mod uibundle;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpio::{Event, Gpio};
use omp_node_sdk::{Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, SetError};
use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

fn tai_now_ns() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: gültiger Zeiger auf eine lokale timespec
    unsafe { libc::clock_gettime(libc::CLOCK_TAI, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

/// Nachricht an den Veröffentlichungstask: Betreff-Endung (nach `omp.gpio.<node>.`) und Inhalt.
struct Msg {
    suffix: String,
    body: Value,
}

struct Core {
    gpio: Gpio,
    start: Instant,
    seq: u64,
    recent: VecDeque<Value>,
    tx: UnboundedSender<Msg>,
}

impl Core {
    fn now_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    fn emit(&mut self, suffix: String, mut body: Value) {
        self.seq += 1;
        body["seq"] = json!(self.seq);
        body["taiNs"] = json!(tai_now_ns());
        self.recent.push_back(json!({"subject": suffix, "event": body}));
        while self.recent.len() > 50 {
            self.recent.pop_front();
        }
        let _ = self.tx.send(Msg { suffix, body });
    }

    fn emit_events(&mut self, events: Vec<Event>) {
        for e in events {
            match e {
                Event::Input { pin, name, level } => self.emit(format!("in.{}", pin + 1), json!({"kind": "in", "pin": pin + 1, "name": name, "level": level})),
                Event::OutputFellBack { pin, name, level, reason } => {
                    self.emit(format!("out.{}", pin + 1), json!({"kind": "out", "pin": pin + 1, "name": name, "level": level, "reason": reason}))
                }
                Event::Link { up } => self.emit("link".to_string(), json!({"kind": "link", "up": up})),
            }
        }
    }

    fn tick(&mut self) {
        let now = self.now_ms();
        let ev = self.gpio.tick(now);
        self.emit_events(ev);
    }
}

struct Store {
    core: Arc<Mutex<Core>>,
}

fn ro(name: &str, kind: ParamType) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly: true }
}

fn m(name: &str, args: &[(&str, ParamType)]) -> MethodSpec {
    MethodSpec { name: name.to_string(), args: args.iter().map(|(n, k)| MethodArg { name: n.to_string(), kind: *k }).collect() }
}

/// Pin aus dem Aufruf: Nummer ab 1.
fn pin_arg(args: &serde_json::Map<String, Value>, count: usize) -> Result<usize, InvokeError> {
    let p = args.get("pin").and_then(Value::as_u64).ok_or_else(|| InvokeError::Message("pin (Nummer ab 1) fehlt".to_string()))?;
    if p == 0 || p as usize > count {
        return Err(InvokeError::Message(format!("pin {p} gibt es nicht (1…{count})")));
    }
    Ok(p as usize - 1)
}

fn level_arg(args: &serde_json::Map<String, Value>) -> Result<bool, InvokeError> {
    match args.get("level") {
        Some(Value::Bool(b)) => Ok(*b),
        Some(Value::Number(n)) => Ok(n.as_f64().unwrap_or(0.0) != 0.0),
        Some(Value::String(s)) => match s.as_str() {
            "1" | "true" | "an" | "on" => Ok(true),
            "0" | "false" | "aus" | "off" => Ok(false),
            _ => Err(InvokeError::Message("level: true/false".to_string())),
        },
        _ => Err(InvokeError::Message("level fehlt".to_string())),
    }
}

impl Store {
    fn inputs_json(c: &Core) -> Value {
        Value::Array(c.gpio.inputs.iter().enumerate().map(|(i, p)| json!({"pin": i + 1, "name": p.name, "level": p.level, "changedMs": p.changed_ms})).collect())
    }
    fn outputs_json(c: &Core) -> Value {
        Value::Array(c.gpio.outputs.iter().enumerate().map(|(i, p)| json!({"pin": i + 1, "name": p.name, "level": p.level, "failSafe": p.fail_safe})).collect())
    }
}

impl ParamStore for Store {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                ParamSpec { name: "debounceMs".to_string(), kind: ParamType::Number, unit: Some("ms".to_string()), range: None, readonly: false },
                ro("linkUp", ParamType::Boolean),
                ro("inputCount", ParamType::Number),
                ro("outputCount", ParamType::Number),
                ro("inputs", ParamType::String),
                ro("outputs", ParamType::String),
                ro("recent", ParamType::String),
            ],
            methods: vec![
                m("setOutput", &[("pin", ParamType::Number), ("level", ParamType::Boolean), ("holdMs", ParamType::Number)]),
                m("configurePin", &[("kind", ParamType::String), ("pin", ParamType::Number), ("name", ParamType::String), ("failSafe", ParamType::Boolean)]),
                m("simulateInput", &[("pin", ParamType::Number), ("level", ParamType::Boolean)]),
                m("simulateLink", &[("up", ParamType::Boolean)]),
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let c = self.core.lock().expect("lock poisoned");
        Some(match name {
            "debounceMs" => json!(c.gpio.debounce_ms),
            "linkUp" => json!(c.gpio.link_up),
            "inputCount" => json!(c.gpio.inputs.len()),
            "outputCount" => json!(c.gpio.outputs.len()),
            "inputs" => json!(Self::inputs_json(&c).to_string()),
            "outputs" => json!(Self::outputs_json(&c).to_string()),
            "recent" => json!(Value::Array(c.recent.iter().cloned().collect()).to_string()),
            _ => return None,
        })
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        if name == "debounceMs" {
            let v = value.as_u64().filter(|v| *v <= 2000).ok_or(SetError::Unknown)?;
            self.core.lock().expect("lock poisoned").gpio.debounce_ms = v;
            return Ok(());
        }
        if self.get(name).is_some() { Err(SetError::ReadOnly) } else { Err(SetError::Unknown) }
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let mut c = self.core.lock().expect("lock poisoned");
        let now = c.now_ms();
        match name {
            "setOutput" => {
                let pin = pin_arg(args, c.gpio.outputs.len())?;
                let level = level_arg(args)?;
                let hold = args.get("holdMs").and_then(Value::as_u64).unwrap_or(0);
                let before = c.gpio.outputs[pin].level;
                c.gpio.set_output(now, pin, level, hold).map_err(InvokeError::Message)?;
                if before != level {
                    let n = c.gpio.outputs[pin].name.clone();
                    c.emit(format!("out.{}", pin + 1), json!({"kind": "out", "pin": pin + 1, "name": n, "level": level, "reason": "command"}));
                }
                Ok(())
            }
            "configurePin" => {
                let kind = args.get("kind").and_then(Value::as_str).unwrap_or("");
                let name_arg = args.get("name").and_then(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                match kind {
                    "in" => {
                        let pin = pin_arg(args, c.gpio.inputs.len())?;
                        if let Some(n) = name_arg {
                            c.gpio.inputs[pin].name = n;
                        }
                    }
                    "out" => {
                        let pin = pin_arg(args, c.gpio.outputs.len())?;
                        if let Some(n) = name_arg {
                            c.gpio.outputs[pin].name = n;
                        }
                        if let Some(f) = args.get("failSafe").and_then(Value::as_bool) {
                            c.gpio.outputs[pin].fail_safe = f;
                        }
                    }
                    _ => return Err(InvokeError::Message("kind: in oder out".to_string())),
                }
                Ok(())
            }
            "simulateInput" => {
                let pin = pin_arg(args, c.gpio.inputs.len())?;
                let level = level_arg(args)?;
                c.gpio.raw_input(now, pin, level).map_err(InvokeError::Message)
            }
            "simulateLink" => {
                let up = args.get("up").and_then(Value::as_bool).ok_or_else(|| InvokeError::Message("up fehlt".to_string()))?;
                let ev = c.gpio.set_link(now, up);
                c.emit_events(ev);
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if let Some(r) = uibundle::route(method, path) {
            return Some(r);
        }
        // Sicherung der Einstellungen (Namen, Fail-Safe-Pegel, Entprellzeit); Pegel und Haltezeiten werden bewusst nicht gesichert:
        // nach einem Neustart gilt der Fail-Safe-Zustand.
        let json_ok = |v: Value| RawResponse { status: 200, content_type: "application/json", body: serde_json::to_vec(&v).unwrap_or_default() };
        if method == "GET" && path == "/state" {
            let c = self.core.lock().expect("lock poisoned");
            let ins: Vec<&str> = c.gpio.inputs.iter().map(|p| p.name.as_str()).collect();
            let outs: Vec<Value> = c.gpio.outputs.iter().map(|p| json!({"name": p.name, "failSafe": p.fail_safe})).collect();
            return Some(json_ok(json!({"state": {"debounceMs": c.gpio.debounce_ms, "inputs": ins, "outputs": outs}})));
        }
        if method == "POST" && path == "/state" {
            let Ok(v) = serde_json::from_slice::<Value>(body) else {
                return Some(RawResponse { status: 400, content_type: "application/json", body: br#"{"error":"invalid JSON body"}"#.to_vec() });
            };
            let s = v.get("state").cloned().unwrap_or(Value::Null);
            let mut c = self.core.lock().expect("lock poisoned");
            if let Some(d) = s.get("debounceMs").and_then(Value::as_u64).filter(|d| *d <= 2000) {
                c.gpio.debounce_ms = d;
            }
            if let Some(a) = s.get("inputs").and_then(Value::as_array) {
                for (i, n) in a.iter().enumerate() {
                    if let (Some(p), Some(n)) = (c.gpio.inputs.get_mut(i), n.as_str()) {
                        p.name = n.to_string();
                    }
                }
            }
            if let Some(a) = s.get("outputs").and_then(Value::as_array) {
                for (i, o) in a.iter().enumerate() {
                    if let Some(p) = c.gpio.outputs.get_mut(i) {
                        if let Some(n) = o.get("name").and_then(Value::as_str) {
                            p.name = n.to_string();
                        }
                        if let Some(f) = o.get("failSafe").and_then(Value::as_bool) {
                            p.fail_safe = f;
                            p.level = f;
                        }
                    }
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
        handle.publish_json(format!("omp.gpio.{}.{}", handle.node_id(), msg.suffix), &body).await;
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "GPIO");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "0").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let inputs: usize = env_or("OMP_GPIO_INPUTS", "8").parse::<usize>()?.min(64);
    let outputs: usize = env_or("OMP_GPIO_OUTPUTS", "8").parse::<usize>()?.min(64);
    let debounce: u64 = env_or("OMP_GPIO_DEBOUNCE_MS", "20").parse()?;

    let (tx, rx) = unbounded_channel();
    let core = Arc::new(Mutex::new(Core { gpio: Gpio::new(inputs, outputs, debounce), start: Instant::now(), seq: 0, recent: VecDeque::new(), tx }));
    let heartbeat = Arc::new(AtomicU64::new(0));
    {
        let (core, hb) = (core.clone(), heartbeat.clone());
        std::thread::spawn(move || {
            loop {
                hb.fetch_add(1, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(5));
                core.lock().expect("lock poisoned").tick();
            }
        });
    }
    let store: Arc<dyn ParamStore> = Arc::new(Store { core });
    let handle = omp_node_sdk::start(
        NodeConfig { label, host, port, registry_url, nats_url, senders: vec![], receivers: vec![], instance_id, media_ready: omp_node_sdk::MediaReadySource::NotApplicable },
        store,
    )
    .await?;
    handle.register_worker("tick", heartbeat);
    tokio::spawn(publisher(rx, handle.clone()));
    tokio::signal::ctrl_c().await?;
    Ok(())
}
