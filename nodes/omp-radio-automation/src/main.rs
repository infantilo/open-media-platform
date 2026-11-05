//! omp-radio-automation (Radio, Kapitel 89/RB4): spielt einen Log über den Segue-Player ab. Der Node plant die Übergänge aus den
//! Marken (`omp_playout_core::segue`), schickt die Stimmen rechtzeitig (Vorlauf) mit `startAt` auf TAI an den Segue-Player und führt
//! ein As-Run. Kein Medien-I/O; Fernaufrufe laufen über den Orchestrator-Proxy (wie `omp-playout-automation`).

mod runner;

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_node_sdk::is04::RegistryClient;
use omp_node_sdk::{Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, SetError};
use omp_playout_core::remote::{self, OrchestratorAuth, ProxyClient};
use omp_playout_core::segue::{Config, Placed};
use serde_json::{Value, json};

use runner::{Log, PlayCall};

fn tai_now_ns() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: gültiger Zeiger auf eine lokale timespec
    unsafe { libc::clock_gettime(libc::CLOCK_TAI, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

#[derive(Default)]
struct Run {
    log: Option<Log>,
    placed: Vec<Placed>,
    /// TAI-Zeitpunkt des Logbeginns; 0 = nicht gestartet.
    start_tai_ns: u64,
    sent: HashSet<usize>,
    as_run: Vec<Value>,
    target_label: String,
    lookahead_ms: u64,
    last_error: String,
}

struct Store {
    run: Arc<Mutex<Run>>,
}

fn ro(name: &str, kind: ParamType) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly: true }
}

impl Store {
    fn state_value(r: &Run) -> &'static str {
        if r.log.is_none() {
            "empty"
        } else if r.start_tai_ns == 0 {
            "loaded"
        } else if let Some(p) = r.placed.last() {
            if tai_now_ns() as i128 >= r.start_tai_ns as i128 + p.end_ms as i128 * 1_000_000 { "finished" } else { "running" }
        } else {
            "loaded"
        }
    }
}

impl ParamStore for Store {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                ParamSpec { name: "target".to_string(), kind: ParamType::String, unit: None, range: None, readonly: false },
                ParamSpec { name: "lookaheadMs".to_string(), kind: ParamType::Number, unit: Some("ms".to_string()), range: None, readonly: false },
                ro("state", ParamType::String),
                ro("logId", ParamType::String),
                ro("itemCount", ParamType::Number),
                ro("sentCount", ParamType::Number),
                ro("startTaiNs", ParamType::Number),
                ro("asRun", ParamType::String),
                ro("lastError", ParamType::String),
            ],
            methods: vec![
                MethodSpec { name: "load".to_string(), args: vec![MethodArg { name: "log".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "start".to_string(), args: vec![MethodArg { name: "atTai".to_string(), kind: ParamType::Number }, MethodArg { name: "delayMs".to_string(), kind: ParamType::Number }] },
                MethodSpec { name: "stop".to_string(), args: vec![MethodArg { name: "fadeMs".to_string(), kind: ParamType::Number }] },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let r = self.run.lock().expect("lock poisoned");
        Some(match name {
            "target" => json!(r.target_label),
            "lookaheadMs" => json!(r.lookahead_ms),
            "state" => json!(Self::state_value(&r)),
            "logId" => json!(r.log.as_ref().map(|l| l.log_id.clone()).unwrap_or_default()),
            "itemCount" => json!(r.log.as_ref().map_or(0, |l| l.items.len())),
            "sentCount" => json!(r.sent.len()),
            "startTaiNs" => json!(r.start_tai_ns),
            "asRun" => json!(serde_json::to_string(&r.as_run).unwrap_or_default()),
            "lastError" => json!(r.last_error),
            _ => return None,
        })
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let mut r = self.run.lock().expect("lock poisoned");
        match name {
            "target" => {
                r.target_label = value.as_str().ok_or(SetError::Unknown)?.trim().to_string();
                Ok(())
            }
            "lookaheadMs" => {
                let v = value.as_u64().filter(|v| (2000..=300_000).contains(v)).ok_or(SetError::Unknown)?;
                r.lookahead_ms = v;
                Ok(())
            }
            _ => {
                drop(r);
                if self.get(name).is_some() { Err(SetError::ReadOnly) } else { Err(SetError::Unknown) }
            }
        }
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let mut r = self.run.lock().expect("lock poisoned");
        match name {
            "load" => {
                if r.start_tai_ns != 0 && Self::state_value(&r) == "running" {
                    return Err(InvokeError::Message("Log läuft — erst stop".to_string()));
                }
                let log: Log = match args.get("log") {
                    Some(Value::String(s)) => serde_json::from_str(s).map_err(|e| InvokeError::Message(format!("Log ungültig: {e}")))?,
                    Some(v) => serde_json::from_value(v.clone()).map_err(|e| InvokeError::Message(format!("Log ungültig: {e}")))?,
                    None => return Err(InvokeError::Unknown),
                };
                let placed = runner::plan(&log, &Config::default()).map_err(InvokeError::Message)?;
                *r = Run { log: Some(log), placed, target_label: std::mem::take(&mut r.target_label), lookahead_ms: r.lookahead_ms, ..Run::default() };
                Ok(())
            }
            "start" => {
                if r.log.is_none() {
                    return Err(InvokeError::Message("kein Log geladen".to_string()));
                }
                if r.start_tai_ns != 0 {
                    return Err(InvokeError::Message("läuft bereits".to_string()));
                }
                let at = args.get("atTai").and_then(Value::as_u64).filter(|v| *v > 0);
                let delay = args.get("delayMs").and_then(Value::as_u64).unwrap_or(3000);
                r.start_tai_ns = at.unwrap_or_else(|| tai_now_ns() + delay * 1_000_000);
                Ok(())
            }
            "stop" => {
                let fade = args.get("fadeMs").and_then(Value::as_u64).unwrap_or(1000);
                let target = r.target_label.clone();
                r.start_tai_ns = 0;
                r.sent.clear();
                r.as_run.push(json!({"event": "stop", "taiNs": tai_now_ns()}));
                drop(r);
                STOP_REQUEST.store(fade + 1, Ordering::Relaxed);
                let _ = target;
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        // Sicherung: Log, Startzeit und gesendete Plätze überleben einen Neustart (kein Doppelstart, kein Verlust des Ablaufs)
        let json_ok = |v: Value| RawResponse { status: 200, content_type: "application/json", body: serde_json::to_vec(&v).unwrap_or_default() };
        if method == "GET" && path == "/state" {
            let r = self.run.lock().expect("lock poisoned");
            let mut sent: Vec<usize> = r.sent.iter().copied().collect();
            sent.sort_unstable();
            return Some(json_ok(json!({"state": {"log": r.log, "startTaiNs": r.start_tai_ns, "sent": sent, "target": r.target_label, "lookaheadMs": r.lookahead_ms}})));
        }
        if method == "POST" && path == "/state" {
            let v: Value = match serde_json::from_slice(body) {
                Ok(v) => v,
                Err(_) => return Some(RawResponse { status: 400, content_type: "application/json", body: br#"{"error":"invalid JSON body"}"#.to_vec() }),
            };
            let s = v.get("state").cloned().unwrap_or(Value::Null);
            let mut r = self.run.lock().expect("lock poisoned");
            if let Some(log) = s.get("log").and_then(|l| serde_json::from_value::<Log>(l.clone()).ok()) {
                if let Ok(placed) = runner::plan(&log, &Config::default()) {
                    r.log = Some(log);
                    r.placed = placed;
                    r.start_tai_ns = s.get("startTaiNs").and_then(Value::as_u64).unwrap_or(0);
                    r.sent = s.get("sent").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as usize)).collect()).unwrap_or_default();
                }
            }
            if let Some(t) = s.get("target").and_then(Value::as_str) {
                r.target_label = t.to_string();
            }
            if let Some(l) = s.get("lookaheadMs").and_then(Value::as_u64).filter(|v| (2000..=300_000).contains(v)) {
                r.lookahead_ms = l;
            }
            return Some(json_ok(json!({"ok": true})));
        }
        None
    }

    fn extra_options(&self, _path: &str) -> Option<Vec<&'static str>> {
        None
    }
}

/// Aufforderung zum Stoppen (Überblendzeit + 1 ms), vom Planer-Thread abgeholt.
static STOP_REQUEST: AtomicU64 = AtomicU64::new(0);

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn resolve_target(orchestrator_url: &str, auth: &OrchestratorAuth, registry: &RegistryClient, label: &str) -> Option<String> {
    let idx = remote::fetch_node_index(orchestrator_url, auth).unwrap_or_else(|_| remote::node_index_from_registry(registry));
    idx.resolve(label)
}

/// Planer: alle 250 ms fällige Stimmen senden; Fehler stehen in `lastError`, ein misslungener Aufruf wird beim nächsten Tick wiederholt
/// (die `voiceId` macht die Wiederholung folgenlos).
fn scheduler_loop(run: Arc<Mutex<Run>>, orchestrator_url: String, auth: OrchestratorAuth, registry: RegistryClient, heartbeat: Arc<AtomicU64>) {
    let mut cached: (String, String, std::time::Instant) = (String::new(), String::new(), std::time::Instant::now());
    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(250));
        let (label, calls, stop) = {
            let r = run.lock().expect("lock poisoned");
            let stop = STOP_REQUEST.swap(0, Ordering::Relaxed);
            let calls: Vec<PlayCall> = match (&r.log, r.start_tai_ns) {
                (Some(log), s) if s != 0 => runner::due(log, &r.placed, s, tai_now_ns(), r.lookahead_ms, &r.sent),
                _ => Vec::new(),
            };
            (r.target_label.clone(), calls, stop)
        };
        if label.is_empty() || (calls.is_empty() && stop == 0) {
            continue;
        }
        if cached.0 != label || cached.2.elapsed() > Duration::from_secs(10) || cached.1.is_empty() {
            let id = resolve_target(&orchestrator_url, &auth, &registry, &label).unwrap_or_default();
            cached = (label.clone(), id, std::time::Instant::now());
        }
        if cached.1.is_empty() {
            run.lock().expect("lock poisoned").last_error = format!("Ziel „{label}“ nicht gefunden");
            continue;
        }
        let client = ProxyClient::new(orchestrator_url.clone(), cached.1.clone(), auth.clone());
        if stop > 0 {
            let res = client.invoke("stopAll", json!({"fadeMs": stop - 1}));
            run.lock().expect("lock poisoned").last_error = res.err().map(|e| e.to_string()).unwrap_or_default();
        }
        for c in calls {
            let res = client.invoke("play", c.args());
            let mut r = run.lock().expect("lock poisoned");
            match res {
                Ok(()) => {
                    r.sent.insert(c.index);
                    r.last_error.clear();
                    let sent_at = tai_now_ns();
                    r.as_run.push(json!({"event": "scheduled", "index": c.index, "id": c.item_id, "voiceId": c.voice_id, "startTaiNs": c.start_at_tai_ns, "sentTaiNs": sent_at, "leadMs": (c.start_at_tai_ns as i128 - sent_at as i128) / 1_000_000}));
                }
                Err(e) => {
                    r.last_error = format!("{}: {e}", c.item_id);
                    break;
                }
            }
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Radio-Automation");
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
            Err(e) => eprintln!("omp-radio-automation: Service-Token nicht erhalten: {e}"),
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
        eprintln!("omp-radio-automation: OMP_INSTANCE_ID/OMP_LAUNCH_SECRET fehlen — keine Fernsteuerung des Segue-Players");
    }

    let run = Arc::new(Mutex::new(Run { target_label: env_or("OMP_RADIO_TARGET_LABEL", ""), lookahead_ms: 30_000, ..Run::default() }));
    let registry = RegistryClient::new(registry_url.clone());
    let heartbeat = Arc::new(AtomicU64::new(0));
    {
        let (run, url, auth, reg, hb) = (run.clone(), orchestrator_url.clone(), auth.clone(), registry.clone(), heartbeat.clone());
        std::thread::spawn(move || scheduler_loop(run, url, auth, reg, hb));
    }
    let store: Arc<dyn ParamStore> = Arc::new(Store { run });
    let handle = omp_node_sdk::start(
        NodeConfig { label, host, port, registry_url, nats_url, senders: vec![], receivers: vec![], instance_id, media_ready: omp_node_sdk::MediaReadySource::NotApplicable },
        store,
    )
    .await?;
    handle.register_worker("scheduler", heartbeat);
    tokio::signal::ctrl_c().await?;
    Ok(())
}
