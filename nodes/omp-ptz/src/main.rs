//! omp-ptz (Kapitel 104): PTZ-Kamera-Steuerung als Node. Eine Instanz steuert eine Kamera über VISCA über IP (UDP 52381):
//! Pan/Tilt/Zoom mit Haltezeit-Sicherung, Voreinstellungen (in der Kamera, Namen im Node), Positionsanzeige, Ereignisse auf NATS
//! `omp.ptz.<node>.<art>`. Ohne Kamera läuft ein Simulator (`OMP_PTZ_SIM=1`). Vertrag: `docs/contracts/CONTRACT-PTZ.md`.

mod io;
mod ptz;
mod sim;
mod uibundle;
mod visca;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_node_sdk::{Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, SetError};
use ptz::{Event, Ptz};
use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

fn tai_now_ns() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: gültiger Zeiger auf eine lokale timespec
    unsafe { libc::clock_gettime(libc::CLOCK_TAI, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

struct Msg {
    suffix: String,
    body: Value,
}

struct Core {
    ptz: Ptz,
    start: Instant,
    seq: u64,
    recent: VecDeque<Value>,
    tx: UnboundedSender<Msg>,
    target: String,
    /// Zählt Zielwechsel; der E/A-Thread verbindet neu, wenn sich der Wert ändert.
    target_gen: u64,
    simulated: bool,
}

impl Core {
    fn now_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    fn emit(&mut self, suffix: &str, mut body: Value) {
        self.seq += 1;
        body["seq"] = json!(self.seq);
        body["taiNs"] = json!(tai_now_ns());
        self.recent.push_back(json!({"subject": suffix, "event": body}));
        while self.recent.len() > 50 {
            self.recent.pop_front();
        }
        let _ = self.tx.send(Msg { suffix: suffix.to_string(), body });
    }

    fn flush_events(&mut self) {
        let events = std::mem::take(&mut self.ptz.events);
        for e in events {
            match e {
                Event::Link { up } => self.emit("link", json!({"kind": "link", "up": up})),
                Event::HoldExpired { what } => self.emit("hold", json!({"kind": "hold", "what": what})),
                Event::CameraError { code, text, tag } => self.emit("error", json!({"kind": "error", "code": code, "text": text, "command": tag})),
                Event::PresetRecalled { number, name } => self.emit("preset", json!({"kind": "preset", "preset": number, "name": name})),
            }
        }
    }
}

struct Store {
    core: Arc<Mutex<Core>>,
}

fn ro(name: &str, kind: ParamType) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly: true }
}

fn rw(name: &str, unit: &str) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind: ParamType::Number, unit: Some(unit.to_string()), range: None, readonly: false }
}

fn m(name: &str, args: &[(&str, ParamType)]) -> MethodSpec {
    MethodSpec { name: name.to_string(), args: args.iter().map(|(n, k)| MethodArg { name: n.to_string(), kind: *k }).collect() }
}

fn num(args: &serde_json::Map<String, Value>, key: &str) -> Result<f64, InvokeError> {
    args.get(key).and_then(Value::as_f64).ok_or_else(|| InvokeError::Message(format!("{key} (Zahl) fehlt")))
}

fn num_or(args: &serde_json::Map<String, Value>, key: &str, d: f64) -> f64 {
    args.get(key).and_then(Value::as_f64).unwrap_or(d)
}

fn int_in(args: &serde_json::Map<String, Value>, key: &str, lo: i64, hi: i64) -> Result<i64, InvokeError> {
    let v = num(args, key)?;
    if v.fract() != 0.0 || v < lo as f64 || v > hi as f64 {
        return Err(InvokeError::Message(format!("{key}: ganze Zahl {lo}…{hi}")));
    }
    Ok(v as i64)
}

fn msg(e: String) -> InvokeError {
    InvokeError::Message(e)
}

impl Store {
    fn presets_json(c: &Core) -> Value {
        Value::Array(c.ptz.presets.iter().enumerate().map(|(i, p)| json!({"preset": i + 1, "name": p.name, "stored": p.stored})).collect())
    }
}

impl ParamStore for Store {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                rw("holdMs", "ms"),
                rw("panMax", "Stufe"),
                rw("tiltMax", "Stufe"),
                ro("linkUp", ParamType::Boolean),
                ro("moving", ParamType::Boolean),
                ro("target", ParamType::String),
                ro("simulated", ParamType::Boolean),
                ro("model", ParamType::String),
                ro("panPos", ParamType::Number),
                ro("tiltPos", ParamType::Number),
                ro("zoomPos", ParamType::Number),
                ro("cameraErrors", ParamType::Number),
                ro("presets", ParamType::String),
                ro("recent", ParamType::String),
            ],
            methods: vec![
                m("move", &[("pan", ParamType::Number), ("tilt", ParamType::Number)]),
                m("zoom", &[("speed", ParamType::Number)]),
                m("stop", &[]),
                m("home", &[]),
                m("goto", &[("pan", ParamType::Number), ("tilt", ParamType::Number), ("speed", ParamType::Number)]),
                m("zoomTo", &[("pos", ParamType::Number)]),
                m("recall", &[("preset", ParamType::Number)]),
                m("store", &[("preset", ParamType::Number), ("name", ParamType::String)]),
                m("clearPreset", &[("preset", ParamType::Number)]),
                m("renamePreset", &[("preset", ParamType::Number), ("name", ParamType::String)]),
                m("setTarget", &[("target", ParamType::String)]),
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let c = self.core.lock().expect("lock poisoned");
        Some(match name {
            "holdMs" => json!(c.ptz.hold_ms),
            "panMax" => json!(c.ptz.pan_max),
            "tiltMax" => json!(c.ptz.tilt_max),
            "linkUp" => json!(c.ptz.link_up),
            "moving" => json!(c.ptz.moving()),
            "target" => json!(c.target),
            "simulated" => json!(c.simulated),
            "model" => json!(c.ptz.version.map(|(v, mo, rom)| format!("Hersteller {v:04X}, Modell {mo:04X}, ROM {rom:04X}")).unwrap_or_default()),
            "panPos" => json!(c.ptz.pan_tilt_pos.map(|p| p.0)),
            "tiltPos" => json!(c.ptz.pan_tilt_pos.map(|p| p.1)),
            "zoomPos" => json!(c.ptz.zoom_pos),
            "cameraErrors" => json!(c.ptz.rx_errors),
            "presets" => json!(Self::presets_json(&c).to_string()),
            "recent" => json!(Value::Array(c.recent.iter().cloned().collect()).to_string()),
            _ => return None,
        })
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let mut c = self.core.lock().expect("lock poisoned");
        match name {
            "holdMs" => c.ptz.hold_ms = value.as_u64().filter(|v| (100..=5000).contains(v)).ok_or(SetError::Unknown)?,
            "panMax" => c.ptz.pan_max = value.as_u64().filter(|v| (1..=32).contains(v)).ok_or(SetError::Unknown)? as u8,
            "tiltMax" => c.ptz.tilt_max = value.as_u64().filter(|v| (1..=32).contains(v)).ok_or(SetError::Unknown)? as u8,
            _ => {
                drop(c);
                return if self.get(name).is_some() { Err(SetError::ReadOnly) } else { Err(SetError::Unknown) };
            }
        }
        Ok(())
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let mut c = self.core.lock().expect("lock poisoned");
        let now = c.now_ms();
        let r = match name {
            "move" => c.ptz.move_axes(now, num(args, "pan")?, num(args, "tilt")?),
            "zoom" => c.ptz.zoom_move(now, num(args, "speed")?),
            "stop" => {
                c.ptz.stop();
                Ok(())
            }
            "home" => c.ptz.home(),
            "goto" => {
                let (p, t) = (int_in(args, "pan", i16::MIN as i64, i16::MAX as i64)?, int_in(args, "tilt", i16::MIN as i64, i16::MAX as i64)?);
                c.ptz.goto(p as i16, t as i16, num_or(args, "speed", 0.5))
            }
            "zoomTo" => {
                let z = int_in(args, "pos", 0, u16::MAX as i64)?;
                c.ptz.zoom_to(z as u16)
            }
            "recall" => c.ptz.recall(int_in(args, "preset", 1, 64)? as u64),
            "store" => {
                let n = int_in(args, "preset", 1, 64)? as u64;
                c.ptz.store(n, args.get("name").and_then(Value::as_str).map(str::to_string))
            }
            "clearPreset" => c.ptz.clear_preset(int_in(args, "preset", 1, 64)? as u64),
            "renamePreset" => {
                let n = int_in(args, "preset", 1, 64)? as u64;
                c.ptz.rename_preset(n, args.get("name").and_then(Value::as_str).unwrap_or(""))
            }
            "setTarget" => {
                let t = io::normalize_target(args.get("target").and_then(Value::as_str).unwrap_or("")).map_err(msg)?;
                if c.simulated {
                    Err("Im Simulatorbetrieb ist das Ziel fest".to_string())
                } else {
                    c.target = t;
                    c.target_gen += 1;
                    c.ptz.link_up = false;
                    Ok(())
                }
            }
            _ => return Err(InvokeError::Unknown),
        };
        c.flush_events();
        r.map_err(msg)
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if let Some(r) = uibundle::route(method, path) {
            return Some(r);
        }
        let json_ok = |v: Value| RawResponse { status: 200, content_type: "application/json", body: serde_json::to_vec(&v).unwrap_or_default() };
        // Sicherung: Ziel, Namen und „gespeichert“-Merker der Voreinstellungen, Haltezeit, Geschwindigkeitsstufen. Fahrten nie.
        if method == "GET" && path == "/state" {
            let c = self.core.lock().expect("lock poisoned");
            let presets: Vec<Value> = c.ptz.presets.iter().map(|p| json!({"name": p.name, "stored": p.stored})).collect();
            let target = if c.simulated { Value::Null } else { json!(c.target) };
            return Some(json_ok(json!({"state": {"target": target, "holdMs": c.ptz.hold_ms, "panMax": c.ptz.pan_max, "tiltMax": c.ptz.tilt_max, "presets": presets}})));
        }
        if method == "POST" && path == "/state" {
            let Ok(v) = serde_json::from_slice::<Value>(body) else {
                return Some(RawResponse { status: 400, content_type: "application/json", body: br#"{"error":"invalid JSON body"}"#.to_vec() });
            };
            let s = v.get("state").cloned().unwrap_or(Value::Null);
            let mut c = self.core.lock().expect("lock poisoned");
            if let Some(h) = s.get("holdMs").and_then(Value::as_u64).filter(|h| (100..=5000).contains(h)) {
                c.ptz.hold_ms = h;
            }
            if let Some(x) = s.get("panMax").and_then(Value::as_u64).filter(|x| (1..=32).contains(x)) {
                c.ptz.pan_max = x as u8;
            }
            if let Some(x) = s.get("tiltMax").and_then(Value::as_u64).filter(|x| (1..=32).contains(x)) {
                c.ptz.tilt_max = x as u8;
            }
            if let (false, Some(t)) = (c.simulated, s.get("target").and_then(Value::as_str))
                && let Ok(t) = io::normalize_target(t)
                && t != c.target
            {
                c.target = t;
                c.target_gen += 1;
            }
            if let Some(a) = s.get("presets").and_then(Value::as_array) {
                for (i, p) in a.iter().enumerate() {
                    if let Some(slot) = c.ptz.presets.get_mut(i) {
                        if let Some(n) = p.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty() && n.len() <= 40) {
                            slot.name = n.to_string();
                        }
                        if let Some(b) = p.get("stored").and_then(Value::as_bool) {
                            slot.stored = b;
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

/// E/A-Thread: Zeitschritt der Zustandsmaschine, Senden, Empfangen, Neuverbinden bei Zielwechsel.
fn io_loop(core: Arc<Mutex<Core>>, heartbeat: Arc<AtomicU64>) {
    let mut transport: Option<io::Transport> = None;
    let mut gen_seen = u64::MAX;
    let mut retry_at = Instant::now();
    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(5));
        let (outs, target, gen_now) = {
            let mut c = core.lock().expect("lock poisoned");
            let now = c.now_ms();
            c.ptz.tick(now);
            c.flush_events();
            (c.ptz.outbox.drain(..).collect::<Vec<_>>(), c.target.clone(), c.target_gen)
        };
        if gen_now != gen_seen {
            transport = None;
            gen_seen = gen_now;
            retry_at = Instant::now();
        }
        if transport.is_none() && Instant::now() >= retry_at {
            match io::Transport::connect(&target) {
                Ok(t) => transport = Some(t),
                Err(e) => {
                    eprintln!("omp-ptz: Verbindung zu {target} nicht möglich: {e}");
                    retry_at = Instant::now() + Duration::from_secs(2);
                }
            }
        }
        let Some(t) = transport.as_mut() else { continue };
        for o in &outs {
            t.send(o);
        }
        let got = t.recv();
        if got.is_empty() {
            continue;
        }
        let mut c = core.lock().expect("lock poisoned");
        let now = c.now_ms();
        for (pkt, tag) in got {
            match pkt.kind {
                visca::payload_type::REPLY => {
                    if let Some(r) = visca::parse_reply(&pkt.payload) {
                        c.ptz.on_reply(now, tag.unwrap_or(ptz::Tag::Other), r);
                    }
                }
                visca::payload_type::CONTROL_REPLY => {
                    c.ptz.alive(now);
                    // Steuerfehler (0F 01: Sequenznummer): beim nächsten Takt RESET senden.
                    if pkt.payload.first() == Some(&0x0F) {
                        c.ptz.outbox.push_back(ptz::Out { kind: visca::payload_type::CONTROL, payload: vec![visca::CONTROL_RESET], tag: ptz::Tag::Other });
                    }
                }
                _ => {}
            }
        }
        c.flush_events();
    }
}

async fn publisher(mut rx: UnboundedReceiver<Msg>, handle: omp_node_sdk::NodeHandle) {
    while let Some(msg) = rx.recv().await {
        let mut body = msg.body;
        body["node"] = json!(handle.node_id());
        handle.publish_json(format!("omp.ptz.{}.{}", handle.node_id(), msg.suffix), &body).await;
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "PTZ-Kamera");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "0").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let presets: usize = env_or("OMP_PTZ_PRESETS", "16").parse::<usize>()?.clamp(1, 64);

    let simulated = env_or("OMP_PTZ_SIM", "0") == "1";
    let target = if simulated {
        let (p, _cam) = sim::spawn(0)?;
        format!("127.0.0.1:{p}")
    } else {
        io::normalize_target(&env_or("OMP_PTZ_TARGET", "192.168.0.100"))?
    };

    let (tx, rx) = unbounded_channel();
    let core = Arc::new(Mutex::new(Core { ptz: Ptz::new(presets), start: Instant::now(), seq: 0, recent: VecDeque::new(), tx, target, target_gen: 0, simulated }));
    let heartbeat = Arc::new(AtomicU64::new(0));
    {
        let (core, hb) = (core.clone(), heartbeat.clone());
        std::thread::spawn(move || io_loop(core, hb));
    }
    let store: Arc<dyn ParamStore> = Arc::new(Store { core });
    let handle = omp_node_sdk::start(
        NodeConfig { label, host, port, registry_url, nats_url, senders: vec![], receivers: vec![], instance_id, media_ready: omp_node_sdk::MediaReadySource::NotApplicable },
        store,
    )
    .await?;
    handle.register_worker("io", heartbeat);
    tokio::spawn(publisher(rx, handle.clone()));
    tokio::signal::ctrl_c().await?;
    Ok(())
}
