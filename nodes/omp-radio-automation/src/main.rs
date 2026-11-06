//! omp-radio-automation (Radio, Kapitel 89/RB4): spielt einen Log über den Segue-Player ab. Der Node plant die Übergänge aus den
//! Marken (`omp_playout_core::segue`), schickt die Stimmen rechtzeitig (Vorlauf) mit `startAt` auf TAI an den Segue-Player und führt
//! ein As-Run. Kein Medien-I/O; Fernaufrufe laufen über den Orchestrator-Proxy (wie `omp-playout-automation`).

mod autoload;
mod runner;
mod uibundle;

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_node_sdk::is04::RegistryClient;
use omp_node_sdk::{Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, SetError};
use omp_playout_core::remote::{self, OrchestratorAuth, ProxyClient};
use omp_playout_core::backtime;
use omp_playout_core::segue::{Config, Placed};
use serde_json::{Value, json};

use runner::{Log, PlayCall};

fn tai_now_ns() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: gültiger Zeiger auf eine lokale timespec
    unsafe { libc::clock_gettime(libc::CLOCK_TAI, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

/// Unterschied TAI − Wanduhr in ns (für die Anzeige in Ortszeit und Startzeiten „um 14:00“).
fn tai_offset_ns() -> i128 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: gültiger Zeiger auf eine lokale timespec
    unsafe { libc::clock_gettime(libc::CLOCK_REALTIME, &mut ts) };
    tai_now_ns() as i128 - (ts.tv_sec as i128 * 1_000_000_000 + ts.tv_nsec as i128)
}

/// Ansicht für das Bedienfeld: Zustand, Plan je Element (Beginn/Ende in ms ab Logstart), gesendet-Markierung, Startzeit in Wanduhr-ms.
fn view_json(r: &Run) -> Value {
    let off = tai_offset_ns();
    let now_unix_ms = ((tai_now_ns() as i128 - off) / 1_000_000) as i64;
    let start_unix_ms = if r.start_tai_ns == 0 { 0 } else { ((r.start_tai_ns as i128 - off) / 1_000_000) as i64 };
    let items: Vec<Value> = r
        .placed
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let it = r.log.as_ref().and_then(|l| l.items.get(i));
            json!({"index": i, "id": p.id, "kind": it.map(|x| x.kind), "file": it.map(|x| x.file.clone()), "startMs": p.start_ms, "endMs": p.end_ms, "nextStartMs": p.next_start_ms,
                   "fadeInMs": p.fade_in_ms, "fadeOutMs": p.fade_out_ms, "stopAtMs": p.stop_at_ms, "sent": r.sent.contains(&i)})
        })
        .collect();
    let now_tai = tai_now_ns();
    let carts: Vec<Value> = r
        .carts
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let playing = r.cart_fired.get(&i).is_some_and(|f| c.duration_ms > 0 && now_tai < f.start_tai_ns + c.duration_ms as u64 * 1_000_000);
            let elapsed = r.cart_fired.get(&i).map(|f| (now_tai.saturating_sub(f.start_tai_ns) / 1_000_000) as i64).unwrap_or(0);
            json!({"index": i, "label": c.label, "color": c.color, "file": c.file, "durationMs": c.duration_ms, "gainDb": c.gain_db, "playing": playing, "elapsedMs": if playing { elapsed } else { 0 }})
        })
        .collect();
    json!({"state": Store::state_value(r), "startUnixMs": start_unix_ms, "nowUnixMs": now_unix_ms, "items": items, "carts": carts})
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
    /// Hotkey-Wand (Carts) und je Taste die zuletzt gestartete Stimme.
    carts: Vec<Cart>,
    cart_fired: std::collections::HashMap<usize, CartFired>,
    /// Automatisches Laden/Starten der freigegebenen Sendung zur Sendezeit.
    auto_load: bool,
    auto_lead_ms: i64,
    /// Zuletzt behandelte Sendung (`id:rowVersion`) — verhindert erneutes Laden nach Neustart und Wiederholung.
    auto_key: String,
    auto_status: String,
}

/// Eine Taste der Hotkey-Wand.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cart {
    #[serde(default)]
    label: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    file: String,
    #[serde(default)]
    duration_ms: i64,
    #[serde(default)]
    gain_db: f64,
}

#[derive(Clone, Debug)]
struct CartFired {
    voice_id: String,
    start_tai_ns: u64,
}

/// Fernzugriff für Methoden, die sofort etwas am Segue-Player auslösen (Hotkeys).
struct Remote {
    orchestrator_url: String,
    auth: OrchestratorAuth,
    registry: RegistryClient,
}

/// Log laden (Plan rechnen, Zustand zurücksetzen; Hotkeys und Einstellungen bleiben). Gemeinsam für `load` und das automatische Laden.
fn load_log(r: &mut Run, log: Log) -> Result<(), String> {
    let placed = runner::plan(&log, &Config::default())?;
    *r = Run {
        log: Some(log),
        placed,
        target_label: std::mem::take(&mut r.target_label),
        lookahead_ms: r.lookahead_ms,
        carts: std::mem::take(&mut r.carts),
        cart_fired: std::mem::take(&mut r.cart_fired),
        auto_load: r.auto_load,
        auto_lead_ms: r.auto_lead_ms,
        auto_key: std::mem::take(&mut r.auto_key),
        auto_status: std::mem::take(&mut r.auto_status),
        ..Run::default()
    };
    Ok(())
}

/// Ablauf starten (`start_tai` = TAI-Zeitpunkt des Logbeginns); rechnet das Backtiming gegen harte Marken und schreibt es ins As-Run.
fn start_run(r: &mut Run, start_tai: u64) -> Result<(), String> {
    let start_unix_ms = ((start_tai as i128 - tai_offset_ns()) / 1_000_000) as i64;
    if r.log.as_ref().is_some_and(|l| l.items.iter().any(|i| i.fix_at_unix_ms.is_some())) {
        let log = r.log.clone().expect("log");
        let (adj, notes, residual) = runner::apply_fixtimes(&log, start_unix_ms, &Config::default(), &backtime::Params::default())?;
        r.placed = runner::plan(&adj, &Config::default())?;
        r.log = Some(adj);
        for n in notes {
            r.as_run.push(json!({"event": "backtiming", "text": n, "taiNs": tai_now_ns()}));
        }
        r.as_run.push(json!({"event": "backtiming-result", "residualMs": residual, "taiNs": tai_now_ns()}));
    }
    r.start_tai_ns = start_tai;
    Ok(())
}

struct Store {
    run: Arc<Mutex<Run>>,
    remote: Remote,
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
                ParamSpec { name: "autoLoad".to_string(), kind: ParamType::Boolean, unit: None, range: None, readonly: false },
                ParamSpec { name: "autoLeadMs".to_string(), kind: ParamType::Number, unit: Some("ms".to_string()), range: None, readonly: false },
                ro("autoStatus", ParamType::String),
                ro("state", ParamType::String),
                ro("logId", ParamType::String),
                ro("itemCount", ParamType::Number),
                ro("sentCount", ParamType::Number),
                ro("startTaiNs", ParamType::Number),
                ro("asRun", ParamType::String),
                ro("view", ParamType::String),
                ro("log", ParamType::String),
                ro("carts", ParamType::String),
                ro("lastError", ParamType::String),
            ],
            methods: vec![
                MethodSpec { name: "load".to_string(), args: vec![MethodArg { name: "log".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "start".to_string(), args: vec![MethodArg { name: "atTai".to_string(), kind: ParamType::Number }, MethodArg { name: "atUnixMs".to_string(), kind: ParamType::Number }, MethodArg { name: "delayMs".to_string(), kind: ParamType::Number }] },
                MethodSpec { name: "stop".to_string(), args: vec![MethodArg { name: "fadeMs".to_string(), kind: ParamType::Number }] },
                MethodSpec { name: "setCarts".to_string(), args: vec![MethodArg { name: "carts".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "fireCart".to_string(), args: vec![MethodArg { name: "index".to_string(), kind: ParamType::Number }] },
                MethodSpec { name: "stopCart".to_string(), args: vec![MethodArg { name: "index".to_string(), kind: ParamType::Number }, MethodArg { name: "fadeMs".to_string(), kind: ParamType::Number }] },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let r = self.run.lock().expect("lock poisoned");
        Some(match name {
            "target" => json!(r.target_label),
            "lookaheadMs" => json!(r.lookahead_ms),
            "autoLoad" => json!(r.auto_load),
            "autoLeadMs" => json!(r.auto_lead_ms),
            "autoStatus" => json!(r.auto_status),
            "state" => json!(Self::state_value(&r)),
            "logId" => json!(r.log.as_ref().map(|l| l.log_id.clone()).unwrap_or_default()),
            "itemCount" => json!(r.log.as_ref().map_or(0, |l| l.items.len())),
            "sentCount" => json!(r.sent.len()),
            "startTaiNs" => json!(r.start_tai_ns),
            "asRun" => json!(serde_json::to_string(&r.as_run).unwrap_or_default()),
            "view" => json!(view_json(&r).to_string()),
            "log" => json!(r.log.as_ref().map(|l| serde_json::to_string(l).unwrap_or_default()).unwrap_or_default()),
            "carts" => json!(serde_json::to_string(&r.carts).unwrap_or_default()),
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
            "autoLoad" => {
                r.auto_load = value.as_bool().ok_or(SetError::Unknown)?;
                r.auto_status = if r.auto_load { "wartet auf die nächste freigegebene Sendung".to_string() } else { String::new() };
                Ok(())
            }
            "autoLeadMs" => {
                r.auto_lead_ms = value.as_i64().filter(|v| (10_000..=3_600_000).contains(v)).ok_or(SetError::Unknown)?;
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
                load_log(&mut r, log).map_err(InvokeError::Message)?;
                Ok(())
            }
            "start" => {
                if r.log.is_none() {
                    return Err(InvokeError::Message("kein Log geladen".to_string()));
                }
                if r.start_tai_ns != 0 {
                    return Err(InvokeError::Message("läuft bereits".to_string()));
                }
                let at = args
                    .get("atTai")
                    .and_then(Value::as_u64)
                    .filter(|v| *v > 0)
                    .or_else(|| args.get("atUnixMs").and_then(Value::as_u64).filter(|v| *v > 0).map(|ms| (ms as i128 * 1_000_000 + tai_offset_ns()) as u64));
                let delay = args.get("delayMs").and_then(Value::as_u64).unwrap_or(3000);
                let start_tai = at.unwrap_or_else(|| tai_now_ns() + delay * 1_000_000);
                start_run(&mut r, start_tai).map_err(InvokeError::Message)?;
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
            "setCarts" => {
                let carts: Vec<Cart> = match args.get("carts") {
                    Some(Value::String(t)) => serde_json::from_str(t).map_err(|e| InvokeError::Message(format!("Hotkeys ungültig: {e}")))?,
                    Some(v) => serde_json::from_value(v.clone()).map_err(|e| InvokeError::Message(format!("Hotkeys ungültig: {e}")))?,
                    None => return Err(InvokeError::Unknown),
                };
                if carts.len() > 64 {
                    return Err(InvokeError::Message("höchstens 64 Tasten".to_string()));
                }
                let n = carts.len();
                r.carts = carts;
                r.cart_fired.retain(|i, _| *i < n);
                Ok(())
            }
            "fireCart" | "stopCart" => {
                let idx = args.get("index").and_then(Value::as_u64).ok_or_else(|| InvokeError::Message("index fehlt".to_string()))? as usize;
                let cart = r.carts.get(idx).cloned().ok_or_else(|| InvokeError::Message(format!("Taste {idx} gibt es nicht")))?;
                let target = r.target_label.clone();
                if target.is_empty() {
                    return Err(InvokeError::Message("kein Ziel (Segue-Player) gewählt".to_string()));
                }
                let now = tai_now_ns();
                let fired = r.cart_fired.get(&idx).cloned();
                let voice = if name == "fireCart" { format!("cart-{}-{}", idx + 1, now / 1_000_000) } else { fired.as_ref().map(|f| f.voice_id.clone()).unwrap_or_default() };
                drop(r);
                if name == "stopCart" && voice.is_empty() {
                    return Ok(());
                }
                let id = resolve_target(&self.remote.orchestrator_url, &self.remote.auth, &self.remote.registry, &target).ok_or_else(|| InvokeError::Message(format!("Ziel „{target}“ nicht gefunden")))?;
                let client = ProxyClient::new(self.remote.orchestrator_url.clone(), id, self.remote.auth.clone());
                if name == "fireCart" {
                    if cart.file.trim().is_empty() {
                        return Err(InvokeError::Message("Taste ohne Datei".to_string()));
                    }
                    client.invoke("play", json!({"voiceId": voice, "file": cart.file, "gainDb": cart.gain_db, "label": cart.label})).map_err(|e| InvokeError::Message(e.to_string()))?;
                    let mut r = self.run.lock().expect("lock poisoned");
                    r.cart_fired.insert(idx, CartFired { voice_id: voice, start_tai_ns: now });
                    r.as_run.push(json!({"event": "cart", "index": idx, "label": cart.label, "taiNs": now}));
                } else {
                    let fade = args.get("fadeMs").and_then(Value::as_u64).unwrap_or(300);
                    client.invoke("stop", json!({"voiceId": voice, "fadeMs": fade})).map_err(|e| InvokeError::Message(e.to_string()))?;
                    self.run.lock().expect("lock poisoned").cart_fired.remove(&idx);
                }
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if let Some(r) = uibundle::route(method, path) {
            return Some(r);
        }
        // Sicherung: Log, Startzeit und gesendete Plätze überleben einen Neustart (kein Doppelstart, kein Verlust des Ablaufs)
        let json_ok = |v: Value| RawResponse { status: 200, content_type: "application/json", body: serde_json::to_vec(&v).unwrap_or_default() };
        if method == "GET" && path == "/state" {
            let r = self.run.lock().expect("lock poisoned");
            let mut sent: Vec<usize> = r.sent.iter().copied().collect();
            sent.sort_unstable();
            return Some(json_ok(json!({"state": {"log": r.log, "startTaiNs": r.start_tai_ns, "sent": sent, "target": r.target_label, "lookaheadMs": r.lookahead_ms, "carts": r.carts, "autoLoad": r.auto_load, "autoLeadMs": r.auto_lead_ms, "autoKey": r.auto_key}})));
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
            if let Some(b) = s.get("autoLoad").and_then(Value::as_bool) {
                r.auto_load = b;
            }
            if let Some(l) = s.get("autoLeadMs").and_then(Value::as_i64).filter(|v| (10_000..=3_600_000).contains(v)) {
                r.auto_lead_ms = l;
            }
            if let Some(k) = s.get("autoKey").and_then(Value::as_str) {
                r.auto_key = k.to_string();
            }
            if let Some(c) = s.get("carts").and_then(|c| serde_json::from_value::<Vec<Cart>>(c.clone()).ok()) {
                r.carts = c;
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

fn unix_now_ms() -> i64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: gültiger Zeiger auf eine lokale timespec
    unsafe { libc::clock_gettime(libc::CLOCK_REALTIME, &mut ts) };
    ts.tv_sec as i64 * 1000 + ts.tv_nsec as i64 / 1_000_000
}

/// Automatisches Laden (alle 5 s): die früheste freigegebene Sendung in Reichweite holen und nach `autoload::decide` laden und zum
/// Beginn des Zeitfensters starten. Fehler stehen in `autoStatus`; die Sendung wird je Stand nur einmal behandelt.
fn auto_tick(run: &Arc<Mutex<Run>>, url: &str, auth: &OrchestratorAuth) {
    let (enabled, lead, key, running) = {
        let r = run.lock().expect("lock poisoned");
        (r.auto_load, r.auto_lead_ms, r.auto_key.clone(), Store::state_value(&r) == "running")
    };
    if !enabled {
        return;
    }
    let set_status = |t: String| run.lock().expect("lock poisoned").auto_status = t;
    let now = unix_now_ms();
    let path = format!("/api/v1/radio/shows?template=0&from={}&to={}", autoload::fmt_rfc3339_ms(now), autoload::fmt_rfc3339_ms(now + lead));
    let list = match remote::get_json(url, auth, &path) {
        Ok(v) => v,
        Err(e) => return set_status(format!("Sendungen nicht lesbar: {e}")),
    };
    let candidate = list.as_array().and_then(|a| a.iter().find(|s| matches!(s.get("status").and_then(Value::as_str), Some("ready") | Some("live")))).cloned();
    let Some(c) = candidate else { return set_status("wartet auf die nächste freigegebene Sendung".to_string()) };
    let id = c.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    // vor dem Nachladen des Inhalts prüfen, ob die Liste (ohne Inhalt) schon „behandelt“ sagt
    if autoload::key_of(&c) == key {
        return;
    }
    let full = match remote::get_json(url, auth, &format!("/api/v1/radio/shows/{id}")) {
        Ok(v) => v,
        Err(e) => return set_status(format!("Sendung nicht lesbar: {e}")),
    };
    match autoload::decide(Some(&full), now, lead, running, &key) {
        autoload::Decision::Nothing => {}
        autoload::Decision::Note(t) => set_status(t),
        autoload::Decision::Load { key, title, log, carts, start_unix_ms, late, .. } => {
            let log: Log = match serde_json::from_value(log) {
                Ok(l) => l,
                Err(e) => return set_status(format!("Log der Sendung „{title}“ ungültig: {e}")),
            };
            let carts: Vec<Cart> = serde_json::from_value(carts).unwrap_or_default();
            let mut r = run.lock().expect("lock poisoned");
            if Store::state_value(&r) == "running" {
                return;
            }
            if let Err(e) = load_log(&mut r, log) {
                r.auto_status = format!("Log der Sendung „{title}“ nicht planbar: {e}");
                return;
            }
            r.carts = carts;
            r.auto_key = key;
            let mut note = format!("Sendung „{title}“ geladen");
            if let Some(ms) = start_unix_ms {
                let tai = (ms as i128 * 1_000_000 + tai_offset_ns()) as u64;
                match start_run(&mut r, tai) {
                    Ok(()) => note.push_str(&format!(", Start um {}", autoload::fmt_rfc3339_ms(ms))),
                    Err(e) => note.push_str(&format!(", Start fehlgeschlagen: {e}")),
                }
            } else if late {
                note.push_str(" — Zeitfenster hat begonnen, bitte manuell starten");
            }
            r.as_run.push(json!({"event": "autoload", "text": note, "taiNs": tai_now_ns()}));
            r.auto_status = note;
        }
    }
}

/// Planer: alle 250 ms fällige Stimmen senden; Fehler stehen in `lastError`, ein misslungener Aufruf wird beim nächsten Tick wiederholt
/// (die `voiceId` macht die Wiederholung folgenlos).
fn scheduler_loop(run: Arc<Mutex<Run>>, orchestrator_url: String, auth: OrchestratorAuth, registry: RegistryClient, heartbeat: Arc<AtomicU64>) {
    let mut cached: (String, String, std::time::Instant) = (String::new(), String::new(), std::time::Instant::now());
    let mut last_auto = std::time::Instant::now() - Duration::from_secs(60);
    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(250));
        if last_auto.elapsed() >= Duration::from_secs(5) {
            last_auto = std::time::Instant::now();
            auto_tick(&run, &orchestrator_url, &auth);
        }
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
        // Token holen und stündlich erneuern. Startet der Node innerhalb eines Workflows, kennt der Orchestrator die Instanz manchmal noch
        // nicht (404) — dann alle 2 s wiederholen, nicht erst nach einer Stunde (sonst bleiben alle Fernaufrufe ohne Token).
        let (url, id, secret, auth2) = (orchestrator_url.clone(), id.to_string(), launch_secret.clone(), auth.clone());
        let name = "omp-radio-automation";
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
                            eprintln!("{name}: Service-Token noch nicht erhalten ({e}) — erneuter Versuch alle 2 s");
                            warned = true;
                        }
                        std::thread::sleep(Duration::from_secs(2));
                    }
                }
            }
        });
    } else {
        eprintln!("omp-radio-automation: OMP_INSTANCE_ID/OMP_LAUNCH_SECRET fehlen — keine Fernsteuerung des Segue-Players");
    }

    let run = Arc::new(Mutex::new(Run { target_label: env_or("OMP_RADIO_TARGET_LABEL", ""), lookahead_ms: 30_000, auto_lead_ms: 120_000, ..Run::default() }));
    let registry = RegistryClient::new(registry_url.clone());
    let heartbeat = Arc::new(AtomicU64::new(0));
    {
        let (run, url, auth, reg, hb) = (run.clone(), orchestrator_url.clone(), auth.clone(), registry.clone(), heartbeat.clone());
        std::thread::spawn(move || scheduler_loop(run, url, auth, reg, hb));
    }
    let store: Arc<dyn ParamStore> = Arc::new(Store { run, remote: Remote { orchestrator_url: orchestrator_url.clone(), auth: auth.clone(), registry: registry.clone() } });
    let handle = omp_node_sdk::start(
        NodeConfig { label, host, port, registry_url, nats_url, senders: vec![], receivers: vec![], instance_id, media_ready: omp_node_sdk::MediaReadySource::NotApplicable },
        store,
    )
    .await?;
    handle.register_worker("scheduler", heartbeat);
    tokio::signal::ctrl_c().await?;
    Ok(())
}
