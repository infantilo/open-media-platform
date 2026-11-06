//! omp-studio-logic (Radio, Kapitel 89/RC2): Mikrofonlogik des Moderationsplatzes. Liest `onAir` je Mischerkanal und die Kontakt-Eingänge
//! des GPIO-Nodes, schaltet Rotlicht (GPO mit Haltezeit), Studio-Lautsprecher, Cough und die Studio-Übergabe auf einen TAI-Zeitpunkt.
//! Regeln stehen als Daten im Parameter `config` (`docs/CONTRACT-STUDIO-LOGIC.md`). Fernaufrufe laufen über den Orchestrator-Proxy.

mod logic;
mod uibundle;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use logic::{Action, Config, Logic, Obs, Target};
use omp_node_sdk::is04::RegistryClient;
use omp_node_sdk::{Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, SetError};
use omp_playout_core::remote::{self, OrchestratorAuth, ProxyClient};
use serde_json::{Value, json};

fn tai_now_ns() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: gültiger Zeiger auf eine lokale timespec
    unsafe { libc::clock_gettime(libc::CLOCK_TAI, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

fn tai_offset_ns() -> i128 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: gültiger Zeiger auf eine lokale timespec
    unsafe { libc::clock_gettime(libc::CLOCK_REALTIME, &mut ts) };
    tai_now_ns() as i128 - (ts.tv_sec as i128 * 1_000_000_000 + ts.tv_nsec as i128)
}

struct Shared {
    logic: Logic,
    mixer_label: String,
    gpio_label: String,
    last_error: String,
    start: Instant,
}

struct Store {
    sh: Arc<Mutex<Shared>>,
}

fn ro(name: &str, kind: ParamType) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly: true }
}
fn rw(name: &str, kind: ParamType) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly: false }
}
fn m(name: &str, args: &[(&str, ParamType)]) -> MethodSpec {
    MethodSpec { name: name.to_string(), args: args.iter().map(|(n, k)| MethodArg { name: n.to_string(), kind: *k }).collect() }
}

fn view(s: &Shared) -> Value {
    let groups: Vec<Value> = s
        .logic
        .cfg
        .groups
        .iter()
        .enumerate()
        .map(|(i, g)| json!({"name": g.name, "onAir": s.logic.on_air(i), "cough": s.logic.cough_active(i), "light": g.light, "channels": g.channels}))
        .collect();
    json!({"groups": groups, "studios": s.logic.cfg.studios.iter().map(|x| &x.name).collect::<Vec<_>>(), "activeStudio": s.logic.active_studio, "handover": s.logic.handover,
           "nowTaiNs": tai_now_ns()})
}

impl ParamStore for Store {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                rw("mixer", ParamType::String),
                rw("gpio", ParamType::String),
                rw("config", ParamType::String),
                ro("view", ParamType::String),
                ro("audit", ParamType::String),
                ro("lastError", ParamType::String),
            ],
            methods: vec![
                m("cough", &[("group", ParamType::String), ("on", ParamType::Boolean)]),
                m("offerHandover", &[("from", ParamType::String), ("to", ParamType::String), ("atTai", ParamType::Number), ("atUnixMs", ParamType::Number), ("delayMs", ParamType::Number)]),
                m("acceptHandover", &[]),
                m("abortHandover", &[]),
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let s = self.sh.lock().expect("lock poisoned");
        Some(match name {
            "mixer" => json!(s.mixer_label),
            "gpio" => json!(s.gpio_label),
            "config" => json!(serde_json::to_string(&s.logic.cfg).unwrap_or_default()),
            "view" => json!(view(&s).to_string()),
            "audit" => json!(serde_json::to_string(&s.logic.audit).unwrap_or_default()),
            "lastError" => json!(s.last_error),
            _ => return None,
        })
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let mut s = self.sh.lock().expect("lock poisoned");
        match name {
            "mixer" => s.mixer_label = value.as_str().ok_or(SetError::Unknown)?.trim().to_string(),
            "gpio" => s.gpio_label = value.as_str().ok_or(SetError::Unknown)?.trim().to_string(),
            "config" => {
                let text = value.as_str().ok_or(SetError::Unknown)?;
                let cfg: Config = serde_json::from_str(text).map_err(|_| SetError::Unknown)?;
                cfg.validate().map_err(|_| SetError::Unknown)?;
                let (handover, active, audit) = (s.logic.handover.take(), s.logic.active_studio.take(), std::mem::take(&mut s.logic.audit));
                s.logic = Logic::new(cfg);
                s.logic.handover = handover;
                s.logic.active_studio = active;
                s.logic.audit = audit;
            }
            _ => {
                drop(s);
                return if self.get(name).is_some() { Err(SetError::ReadOnly) } else { Err(SetError::Unknown) };
            }
        }
        Ok(())
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let mut s = self.sh.lock().expect("lock poisoned");
        let now_ms = s.start.elapsed().as_millis() as u64;
        let msg = |e: String| InvokeError::Message(e);
        match name {
            "cough" => {
                let group = args.get("group").and_then(Value::as_str).ok_or_else(|| msg("group fehlt".into()))?;
                let on = args.get("on").and_then(Value::as_bool).ok_or_else(|| msg("on fehlt".into()))?;
                s.logic.set_cough(now_ms, group, on).map_err(msg)
            }
            "offerHandover" => {
                let from = args.get("from").and_then(Value::as_str).unwrap_or("").to_string();
                let to = args.get("to").and_then(Value::as_str).unwrap_or("").to_string();
                let now = tai_now_ns();
                let at = args
                    .get("atTai")
                    .and_then(Value::as_u64)
                    .filter(|v| *v > 0)
                    .or_else(|| args.get("atUnixMs").and_then(Value::as_u64).filter(|v| *v > 0).map(|ms| (ms as i128 * 1_000_000 + tai_offset_ns()) as u64))
                    .unwrap_or_else(|| now + args.get("delayMs").and_then(Value::as_u64).unwrap_or(10_000) * 1_000_000);
                s.logic.offer(&from, &to, at, now).map_err(msg)
            }
            "acceptHandover" => s.logic.accept(tai_now_ns()).map_err(msg),
            "abortHandover" => s.logic.abort().map_err(msg),
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if let Some(r) = uibundle::route(method, path) {
            return Some(r);
        }
        let json_ok = |v: Value| RawResponse { status: 200, content_type: "application/json", body: serde_json::to_vec(&v).unwrap_or_default() };
        if method == "GET" && path == "/state" {
            let s = self.sh.lock().expect("lock poisoned");
            return Some(json_ok(json!({"state": {"config": s.logic.cfg, "mixer": s.mixer_label, "gpio": s.gpio_label}})));
        }
        if method == "POST" && path == "/state" {
            let Ok(v) = serde_json::from_slice::<Value>(body) else {
                return Some(RawResponse { status: 400, content_type: "application/json", body: br#"{"error":"invalid JSON body"}"#.to_vec() });
            };
            let st = v.get("state").cloned().unwrap_or(Value::Null);
            let mut s = self.sh.lock().expect("lock poisoned");
            if let Some(cfg) = st.get("config").and_then(|c| serde_json::from_value::<Config>(c.clone()).ok()).filter(|c| c.validate().is_ok()) {
                s.logic = Logic::new(cfg);
            }
            if let Some(x) = st.get("mixer").and_then(Value::as_str) {
                s.mixer_label = x.to_string();
            }
            if let Some(x) = st.get("gpio").and_then(Value::as_str) {
                s.gpio_label = x.to_string();
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

struct Link {
    label: String,
    id: String,
    since: Instant,
}

fn resolve(url: &str, auth: &OrchestratorAuth, reg: &RegistryClient, cache: &mut Link, label: &str) -> Option<ProxyClient> {
    if label.is_empty() {
        return None;
    }
    if cache.label != label || cache.id.is_empty() || cache.since.elapsed() > Duration::from_secs(10) {
        let idx = remote::fetch_node_index(url, auth).unwrap_or_else(|_| remote::node_index_from_registry(reg));
        *cache = Link { label: label.to_string(), id: idx.resolve(label).unwrap_or_default(), since: Instant::now() };
    }
    if cache.id.is_empty() { None } else { Some(ProxyClient::new(url.to_string(), cache.id.clone(), auth.clone())) }
}

fn run_loop(sh: Arc<Mutex<Shared>>, url: String, auth: OrchestratorAuth, reg: RegistryClient, hb: Arc<AtomicU64>) {
    let (mut mix_l, mut gpio_l) = (Link { label: String::new(), id: String::new(), since: Instant::now() }, Link { label: String::new(), id: String::new(), since: Instant::now() });
    // zuletzt gesendetes Licht je Pin und wann (Erneuerung der Haltezeit)
    let mut light_sent: HashMap<u32, (bool, Instant)> = HashMap::new();
    loop {
        hb.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(100));
        let (mixer_label, gpio_label, cfg) = {
            let s = sh.lock().expect("lock poisoned");
            (s.mixer_label.clone(), s.gpio_label.clone(), s.logic.cfg.clone())
        };
        if cfg.groups.is_empty() && cfg.studios.is_empty() {
            continue;
        }
        let mixer = resolve(&url, &auth, &reg, &mut mix_l, &mixer_label);
        let gpio = resolve(&url, &auth, &reg, &mut gpio_l, &gpio_label);
        let mut errors: Vec<String> = Vec::new();

        let mut obs = Obs::default();
        if let Some(g) = &gpio {
            match g.get_param("inputs") {
                Ok(Value::String(t)) => {
                    if let Ok(Value::Array(a)) = serde_json::from_str::<Value>(&t) {
                        obs.inputs = Some(a.iter().filter_map(|x| Some((x.get("pin")?.as_u64()? as u32, x.get("level")?.as_bool()?))).collect());
                    }
                }
                Ok(_) => {}
                Err(e) => errors.push(format!("GPIO: {e}")),
            }
        }
        if let Some(mx) = &mixer {
            for g in &cfg.groups {
                for c in &g.channels {
                    match mx.get_param(&format!("channel.{c}.onAir")) {
                        Ok(Value::Bool(b)) => {
                            obs.on_air.insert(c.clone(), b);
                        }
                        Ok(_) => {}
                        Err(e) => errors.push(format!("Mischer {c}: {e}")),
                    }
                }
            }
        } else if !mixer_label.is_empty() {
            errors.push(format!("Mischer „{mixer_label}“ nicht gefunden"));
        }

        // Stummzustand nur lesen, wo ein Cough läuft oder beginnt (Wiederherstellen)
        let want_mute: Vec<String> = {
            let s = sh.lock().expect("lock poisoned");
            cfg.groups
                .iter()
                .enumerate()
                .filter(|(i, g)| s.logic.cough_active(*i) || g.cough_input.is_some_and(|p| obs.inputs.as_ref().and_then(|m| m.get(&p)).copied().unwrap_or(false)))
                .flat_map(|(_, g)| g.channels.clone())
                .collect()
        };
        if let Some(mx) = &mixer {
            for c in want_mute {
                if let Ok(Value::Bool(b)) = mx.get_param(&format!("channel.{c}.mute")) {
                    obs.mute.insert(c, b);
                }
            }
        }

        let actions = {
            let mut s = sh.lock().expect("lock poisoned");
            let now_ms = s.start.elapsed().as_millis() as u64;
            s.logic.step(now_ms, tai_now_ns(), &obs)
        };
        for a in actions {
            match a {
                Action::Light { pin, on } => {
                    let due = light_sent.get(&pin).is_none_or(|(l, t)| *l != on || t.elapsed() >= Duration::from_millis(cfg.light_hold_ms / 3));
                    if due {
                        if let Some(g) = &gpio {
                            match g.invoke("setOutput", json!({"pin": pin, "level": on, "holdMs": cfg.light_hold_ms})) {
                                Ok(()) => {
                                    light_sent.insert(pin, (on, Instant::now()));
                                }
                                Err(e) => errors.push(format!("Rotlicht {pin}: {e}")),
                            }
                        }
                    }
                }
                Action::Mute { target: Target { kind, id }, muted } => {
                    if let Some(mx) = &mixer {
                        let (name, args) = match kind.as_str() {
                            "group" => (format!("group.{id}.setMute"), json!({"muted": muted})),
                            "aux" => (format!("aux.{id}.setMaster"), json!({"muted": muted})),
                            _ => (format!("channel.{id}.setMute"), json!({"muted": muted})),
                        };
                        if let Err(e) = mx.invoke(&name, args) {
                            errors.push(format!("{name}: {e}"));
                        }
                    }
                }
                Action::Audit(_) => {}
            }
        }
        sh.lock().expect("lock poisoned").last_error = errors.join("; ");
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Studio-Logik");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "0").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let orchestrator_url = env_or("OMP_ORCHESTRATOR_URL", "http://localhost:8000");
    let launch_secret = std::env::var("OMP_LAUNCH_SECRET").unwrap_or_default();
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let auth = OrchestratorAuth::new();
    if let (Some(id), false) = (instance_id.as_deref(), launch_secret.is_empty()) {
        match remote::fetch_service_token(&orchestrator_url, id, &launch_secret) {
            Ok(t) => auth.set(t),
            Err(e) => eprintln!("omp-studio-logic: Service-Token nicht erhalten: {e}"),
        }
        let (url, id, secret, auth2) = (orchestrator_url.clone(), id.to_string(), launch_secret.clone(), auth.clone());
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(3600));
                if let Ok(t) = remote::fetch_service_token(&url, &id, &secret) {
                    auth2.set(t);
                }
            }
        });
    } else {
        eprintln!("omp-studio-logic: OMP_INSTANCE_ID/OMP_LAUNCH_SECRET fehlen — keine Fernsteuerung von Mischer und GPIO");
    }

    let sh = Arc::new(Mutex::new(Shared {
        logic: Logic::new(Config::default()),
        mixer_label: env_or("OMP_STUDIO_MIXER_LABEL", ""),
        gpio_label: env_or("OMP_STUDIO_GPIO_LABEL", ""),
        last_error: String::new(),
        start: Instant::now(),
    }));
    let registry = RegistryClient::new(registry_url.clone());
    let heartbeat = Arc::new(AtomicU64::new(0));
    {
        let (sh, url, auth, reg, hb) = (sh.clone(), orchestrator_url.clone(), auth.clone(), registry.clone(), heartbeat.clone());
        std::thread::spawn(move || run_loop(sh, url, auth, reg, hb));
    }
    let store: Arc<dyn ParamStore> = Arc::new(Store { sh });
    let handle = omp_node_sdk::start(
        NodeConfig { label, host, port, registry_url, nats_url, senders: vec![], receivers: vec![], instance_id, media_ready: omp_node_sdk::MediaReadySource::NotApplicable },
        store,
    )
    .await?;
    handle.register_worker("studio-logic", heartbeat);
    tokio::signal::ctrl_c().await?;
    Ok(())
}
