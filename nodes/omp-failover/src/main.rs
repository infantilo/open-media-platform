//! omp-failover (Kapitel 89, Radio/Fernsehen): Modulationswächter und Havarieumschalter vor dem letzten Signalpunkt
//! (`docs/ENTWURF-HAVARIEUMSCHALTER.md`). Diese Stufe: Audio (Radio). Hauptsignal und drei Notquellen kommen als MXL-Flows, dazu ein eingebauter
//! Notclip (Datei in Schleife); fällt das Hauptsignal aus (kein Signal, Stille), schlägt der Node Alarm (`omp.alert.<node>`) und schaltet die
//! erste gesunde Quelle der einstellbaren Reihenfolge; Rückkehr automatisch oder manuell, Umschaltung auch von Hand.

mod failover;
mod io;
mod uibundle;

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use failover::{Controller, Event, Mode, Obs, Rules, SOURCES, Status};
use io::{BLOCK, CH, CLIP_SLOT, InputControl, MXL_INPUTS, MxlIo, SAMPLE_RATE};
use omp_node_sdk::connection::{ReceiverConnection, bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, ReceiverSpec, SenderSpec, SetError};
use serde_json::{Value, json};

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Shared {
    ctl: Mutex<Controller>,
    /// Spitzenpegel je Quelle (f32-Bits, mit Abklingen) und am Ausgang.
    levels: [AtomicU32; 5],
    out_level: AtomicU32,
    /// Wanduhr beim Start (Zeitstempel der Ereignisse = Start + Modellzeit).
    start_unix_ms: u64,
    clip_path: Mutex<String>,
}

fn peak_db(block: &[f32]) -> f64 {
    let p = block.iter().fold(0.0f32, |m, v| m.max(v.abs())) as f64;
    if p <= 0.000_001 { -120.0 } else { 20.0 * p.log10() }
}


fn store_db(a: &AtomicU32, db: f64) {
    a.store((db as f32).to_bits(), Ordering::Relaxed);
}

fn load_db(a: &AtomicU32) -> f64 {
    f32::from_bits(a.load(Ordering::Relaxed)) as f64
}

/// Takt: alle 10 ms jede Quelle einen Block holen, beobachten, entscheiden, die aktive Quelle (mit kurzer Überblendung) ausgeben. Eigene Uhr.
fn clock_loop(sh: Arc<Shared>, io: Arc<MxlIo>, events: Sender<Event>, shutdown: Arc<AtomicBool>, heartbeat: Arc<AtomicU64>) {
    let period = Duration::from_millis(10);
    let mut next = std::time::Instant::now();
    let mut bufs: Vec<Vec<f32>> = (0..=CLIP_SLOT).map(|_| vec![0.0f32; BLOCK * CH]).collect();
    let mut out = vec![0.0f32; BLOCK * CH];
    let mut prev_active = 0usize;
    let mut fade_left = 0u32; // Blöcke Überblendung (2 × 10 ms)
    while !shutdown.load(Ordering::Relaxed) {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        let mut obs = [Obs::default(); 5];
        for slot in 0..=CLIP_SLOT {
            let got = io.take(slot, &mut bufs[slot]);
            let db = if got > 0 { peak_db(&bufs[slot][..got * CH]) } else { -120.0 };
            let lv = &sh.levels[slot];
            let old = load_db(lv) - 1.5;
            store_db(lv, db.max(old));
            obs[slot] = Obs { present: io.present(slot, 600), level_db: Some(db), frozen: None };
        }
        let (active, evs) = {
            let mut c = sh.ctl.lock().expect("lock poisoned");
            let evs = c.step(10, &obs);
            (SOURCES.iter().position(|s| *s == c.active).unwrap_or(0), evs)
        };
        for e in evs {
            let _ = events.send(e);
        }
        if active != prev_active {
            fade_left = 2;
        }
        if fade_left > 0 {
            // gleichmäßige Überblendung über 20 ms (linear; die Quellen sind unkorreliert, kurzer Übergang)
            let total = (2 * BLOCK) as f32;
            let done = ((2 - fade_left) as usize * BLOCK) as f32;
            for i in 0..BLOCK {
                let t = (done + i as f32) / total;
                for c in 0..CH {
                    out[i * CH + c] = bufs[prev_active][i * CH + c] * (1.0 - t) + bufs[active][i * CH + c] * t;
                }
            }
            fade_left -= 1;
            if fade_left == 0 {
                prev_active = active;
            }
        } else {
            out.copy_from_slice(&bufs[active]);
            prev_active = active;
        }
        let odb = peak_db(&out);
        let old = load_db(&sh.out_level) - 1.5;
        store_db(&sh.out_level, odb.max(old));
        io.push_output(&out);
        next += period;
        let now = std::time::Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else if now - next > period * 20 {
            next = now;
        }
    }
}

struct Store {
    sh: Arc<Shared>,
    io: Arc<MxlIo>,
    connections: Vec<Arc<ReceiverConnection<InputControl>>>,
    /// Ereignisse der Bedienung (manuelle Umschaltung) gehen über denselben Kanal wie die der Automatik an den Alarmweg.
    events: Mutex<Sender<Event>>,
}

fn ro(name: &str, kind: ParamType) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly: true }
}
fn rw(name: &str, kind: ParamType, unit: Option<&str>) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: unit.map(str::to_string), range: None, readonly: false }
}

fn status_name(s: Status) -> &'static str {
    match s {
        Status::Normal => "normal",
        Status::Havarie => "havarie",
        Status::AllDown => "allDown",
    }
}

impl Store {
    fn sources_json(&self) -> Value {
        let c = self.sh.ctl.lock().expect("lock poisoned");
        let order = c.rules.order.clone();
        Value::Array(
            SOURCES
                .iter()
                .enumerate()
                .map(|(i, id)| {
                    let h = c.health_of(id);
                    let cause = h.failure(&c.rules).map(|x| x.text());
                    let slot_src = self.io.source_of(i);
                    let state = if slot_src.is_empty() { "nichtverbunden" } else if cause.is_some() { "gestoert" } else if h.healthy(&c.rules) { "gesund" } else { "pruefe" };
                    json!({"id": id, "label": failover::label(id), "connected": !slot_src.is_empty(), "present": h.present, "levelDb": load_db(&self.sh.levels[i]).max(-120.0),
                           "state": state, "cause": cause, "okMs": h.ok_ms, "noSignalMs": h.no_signal_ms, "silentMs": h.silent_ms, "active": c.active == *id,
                           "priority": order.iter().position(|o| o == id).map(|p| p + 1)})
                })
                .collect(),
        )
    }

    fn events_json(&self) -> Value {
        let c = self.sh.ctl.lock().expect("lock poisoned");
        Value::Array(c.log.iter().rev().take(100).map(|(t, text)| json!({"atUnixMs": self.sh.start_unix_ms + t, "text": text})).collect())
    }
}

impl ParamStore for Store {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                rw("noSignalMs", ParamType::Number, Some("ms")),
                rw("silenceDb", ParamType::Number, Some("dBFS")),
                rw("silenceMs", ParamType::Number, Some("ms")),
                rw("healthyMs", ParamType::Number, Some("ms")),
                rw("returnMs", ParamType::Number, Some("ms")),
                rw("minHoldMs", ParamType::Number, Some("ms")),
                rw("autoReturn", ParamType::Boolean, None),
                rw("order", ParamType::String, None),
                rw("clipFile", ParamType::String, None),
                ro("mode", ParamType::String),
                ro("manualSource", ParamType::String),
                ro("active", ParamType::String),
                ro("status", ParamType::String),
                ro("activeSinceMs", ParamType::Number),
                ro("takeovers", ParamType::Number),
                ro("outputLevelDb", ParamType::Number),
                ro("sources", ParamType::String),
                ro("events", ParamType::String),
            ],
            methods: vec![
                MethodSpec { name: "select".to_string(), args: vec![MethodArg { name: "source".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "auto".to_string(), args: vec![] },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        if name == "sources" {
            return Some(json!(self.sources_json().to_string()));
        }
        if name == "events" {
            return Some(json!(self.events_json().to_string()));
        }
        let c = self.sh.ctl.lock().expect("lock poisoned");
        Some(match name {
            "noSignalMs" => json!(c.rules.no_signal_ms),
            "silenceDb" => json!(c.rules.silence_db),
            "silenceMs" => json!(c.rules.silence_ms),
            "healthyMs" => json!(c.rules.healthy_ms),
            "returnMs" => json!(c.rules.return_ms),
            "minHoldMs" => json!(c.rules.min_hold_ms),
            "autoReturn" => json!(c.rules.auto_return),
            "order" => json!(serde_json::to_string(&c.rules.order).unwrap_or_default()),
            "clipFile" => json!(self.sh.clip_path.lock().expect("lock poisoned").clone()),
            "mode" => json!(if matches!(c.mode, Mode::Auto) { "auto" } else { "manual" }),
            "manualSource" => json!(if let Mode::Manual(s) = &c.mode { s.clone() } else { String::new() }),
            "active" => json!(c.active),
            "status" => json!(status_name(c.status())),
            "activeSinceMs" => json!(c.since_ms()),
            "takeovers" => json!(c.takeovers),
            "outputLevelDb" => json!(load_db(&self.sh.out_level).max(-120.0)),
            _ => return None,
        })
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        if name == "clipFile" {
            let p = value.as_str().ok_or(SetError::Unknown)?.trim().to_string();
            *self.sh.clip_path.lock().expect("lock poisoned") = p.clone();
            self.io.set_clip(p);
            return Ok(());
        }
        let mut c = self.sh.ctl.lock().expect("lock poisoned");
        let mut r = c.rules.clone();
        match name {
            "noSignalMs" => r.no_signal_ms = value.as_u64().ok_or(SetError::Unknown)?,
            "silenceDb" => r.silence_db = value.as_f64().ok_or(SetError::Unknown)?,
            "silenceMs" => r.silence_ms = value.as_u64().ok_or(SetError::Unknown)?,
            "healthyMs" => r.healthy_ms = value.as_u64().ok_or(SetError::Unknown)?,
            "returnMs" => r.return_ms = value.as_u64().ok_or(SetError::Unknown)?,
            "minHoldMs" => r.min_hold_ms = value.as_u64().ok_or(SetError::Unknown)?,
            "autoReturn" => r.auto_return = value.as_bool().ok_or(SetError::Unknown)?,
            "order" => {
                let text = value.as_str().ok_or(SetError::Unknown)?;
                r.order = serde_json::from_str(text).map_err(|_| SetError::Unknown)?;
            }
            _ => {
                drop(c);
                return if self.get(name).is_some() { Err(SetError::ReadOnly) } else { Err(SetError::Unknown) };
            }
        }
        r.validate().map_err(|_| SetError::Unknown)?;
        c.rules = r;
        Ok(())
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let mut c = self.sh.ctl.lock().expect("lock poisoned");
        match name {
            "select" => {
                let s = args.get("source").and_then(Value::as_str).ok_or_else(|| InvokeError::Message("source fehlt".to_string()))?;
                // Umschaltung und Alarm laufen wie bei der Automatik über den Ereigniskanal; hier genügt das Protokoll (siehe Controller::select)
                let evs = c.select(s).map_err(InvokeError::Message)?;
                let tx = self.events.lock().expect("lock poisoned");
                for e in evs {
                    let _ = tx.send(e);
                }
                Ok(())
            }
            "auto" => {
                c.auto();
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if let Some(r) = uibundle::route(method, path) {
            return Some(r);
        }
        let json_ok = |v: Value| RawResponse { status: 200, content_type: "application/json", body: serde_json::to_vec(&v).unwrap_or_default() };
        if method == "GET" && path == "/state" {
            let c = self.sh.ctl.lock().expect("lock poisoned");
            let r = &c.rules;
            return Some(json_ok(json!({"state": {"noSignalMs": r.no_signal_ms, "silenceDb": r.silence_db, "silenceMs": r.silence_ms, "freezeMs": r.freeze_ms, "healthyMs": r.healthy_ms,
                "returnMs": r.return_ms, "minHoldMs": r.min_hold_ms, "autoReturn": r.auto_return, "order": r.order,
                "clipFile": self.sh.clip_path.lock().expect("lock poisoned").clone(),
                "manualSource": if let Mode::Manual(s) = &c.mode { json!(s) } else { Value::Null }}})));
        }
        if method == "POST" && path == "/state" {
            let Ok(v) = serde_json::from_slice::<Value>(body) else {
                return Some(RawResponse { status: 400, content_type: "application/json", body: br#"{"error":"invalid JSON body"}"#.to_vec() });
            };
            let s = v.get("state").cloned().unwrap_or(Value::Null);
            let mut c = self.sh.ctl.lock().expect("lock poisoned");
            let mut r = c.rules.clone();
            let u = |k: &str| s.get(k).and_then(Value::as_u64);
            if let Some(x) = u("noSignalMs") { r.no_signal_ms = x; }
            if let Some(x) = s.get("silenceDb").and_then(Value::as_f64) { r.silence_db = x; }
            if let Some(x) = u("silenceMs") { r.silence_ms = x; }
            if let Some(x) = u("freezeMs") { r.freeze_ms = x; }
            if let Some(x) = u("healthyMs") { r.healthy_ms = x; }
            if let Some(x) = u("returnMs") { r.return_ms = x; }
            if let Some(x) = u("minHoldMs") { r.min_hold_ms = x; }
            if let Some(x) = s.get("autoReturn").and_then(Value::as_bool) { r.auto_return = x; }
            if let Some(a) = s.get("order").and_then(Value::as_array) { r.order = a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(); }
            if r.validate().is_ok() {
                c.rules = r;
            }
            if let Some(src) = s.get("manualSource").and_then(Value::as_str) {
                let _ = c.select(src);
            }
            drop(c);
            if let Some(p) = s.get("clipFile").and_then(Value::as_str).filter(|p| !p.is_empty()) {
                *self.sh.clip_path.lock().expect("lock poisoned") = p.to_string();
                self.io.set_clip(p.to_string());
            }
            return Some(json_ok(json!({"ok": true})));
        }
        // IS-05: Verbindungen der vier Eingänge
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        let ids: Vec<String> = self.connections.iter().map(|c| c.id().to_string()).collect();
        let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        root_discovery(method, path)
            .or_else(|| list_ids(method, path, "receivers", &id_refs))
            .or_else(|| bulk_discovery(method, path))
            .or_else(|| bulk_patch(method, path, "receivers", body, |id, params| self.connections.iter().find(|c| c.id() == id).map(|c| c.patch_staged(params).0)))
            .or_else(|| bulk_patch(method, path, "senders", body, |_, _| None))
            .or_else(|| self.connections.iter().find_map(|c| c.handle(method, path, body)))
            .map(to_raw)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.connections.iter().find_map(|c| c.cors_methods(path)).or_else(|| bulk_cors_methods(path, "senders")).or_else(|| bulk_cors_methods(path, "receivers"))
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Havarieumschalter");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "0").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    gstreamer::init()?;
    let out_flow = omp_node_sdk::idgen::new_v4();
    let io = MxlIo::new(&domain, &out_flow, &label)?;
    let registry = RegistryClient::new(registry_url.clone());
    let receiver_ids: Vec<String> = (0..MXL_INPUTS).map(|_| omp_node_sdk::idgen::new_v4()).collect();
    let connections: Vec<Arc<ReceiverConnection<InputControl>>> = receiver_ids
        .iter()
        .enumerate()
        .map(|(slot, id)| Arc::new(ReceiverConnection::new(id.clone(), InputControl { io: io.clone(), slot, registry: registry.clone() })))
        .collect();
    let names = ["Hauptsignal", "Notquelle 1", "Notquelle 2", "Notquelle 3"];
    let receivers: Vec<ReceiverSpec> = receiver_ids
        .iter()
        .zip(names)
        .map(|(id, name)| ReceiverSpec {
            id: Some(id.clone()),
            transport: Some(TRANSPORT_MXL.to_string()),
            media_types: Some(vec!["audio/float32".to_string()]),
            label: Some(name.to_string()),
            ..Default::default()
        })
        .collect();
    let senders = vec![SenderSpec {
        id: Some(omp_node_sdk::idgen::new_v4()),
        transport: Some(TRANSPORT_MXL.to_string()),
        flow: Some(FlowSpec::Audio { id: Some(out_flow), sample_rate_numerator: SAMPLE_RATE, channel_count: CH as u32, media_type: "audio/float32".to_string(), bit_depth: 32, source_id: None }),
        label: Some("Programm (nach Wächter)".to_string()),
        ..Default::default()
    }];

    let sh = Arc::new(Shared {
        ctl: Mutex::new(Controller::new(Rules::default())),
        levels: std::array::from_fn(|_| AtomicU32::new((-120.0f32).to_bits())),
        out_level: AtomicU32::new((-120.0f32).to_bits()),
        start_unix_ms: unix_now_ms(),
        clip_path: Mutex::new(String::new()),
    });
    let initial_clip = env_or("OMP_FAILOVER_CLIP", "");
    if !initial_clip.is_empty() {
        *sh.clip_path.lock().expect("lock poisoned") = initial_clip.clone();
        io.set_clip(initial_clip);
    }
    let shutdown = Arc::new(AtomicBool::new(false));
    let heartbeat = Arc::new(AtomicU64::new(0));
    let (tx, rx) = channel::<Event>();
    let tx2 = tx.clone();
    let clock = {
        let (sh, io, sd, hb) = (sh.clone(), io.clone(), shutdown.clone(), heartbeat.clone());
        std::thread::spawn(move || clock_loop(sh, io, tx, sd, hb))
    };
    let media_io = io.clone();
    let store: Arc<dyn ParamStore> = Arc::new(Store { sh: sh.clone(), io: io.clone(), connections, events: Mutex::new(tx2) });
    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders,
            receivers,
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_io.out_flowed())),
        },
        store,
    )
    .await?;
    handle.register_worker("clock", heartbeat);

    // Alarme: Havarie, Notquelle gestört, alle gestört, manuell gewählte gestört, Rückkehr (omp.alert.<node>)
    let mut ticker = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = ticker.tick() => {
                while let Ok(e) = rx.try_recv() {
                    match e {
                        Event::Alarm { text, .. } => handle.publish_alert(text).await,
                        Event::Switched { from, to, auto, reason } => {
                            // Umschaltungen erscheinen im Protokoll; ein Alarm geht nur bei automatischen Wechseln raus (die Alarmtexte stehen schon oben)
                            if !auto { handle.publish_alert(format!("Manuelle Umschaltung: {} → {} ({})", failover::label(&from), failover::label(&to), reason)).await; }
                        }
                    }
                }
            }
        }
    }
    eprintln!("omp-failover: shutdown requested");
    shutdown.store(true, Ordering::Relaxed);
    let _ = clock.join();
    Ok(())
}
