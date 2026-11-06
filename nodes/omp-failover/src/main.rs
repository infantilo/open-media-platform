//! omp-failover (Kapitel 89, Radio/Fernsehen): Modulationswächter und Havarieumschalter vor dem letzten Signalpunkt
//! (`docs/ENTWURF-HAVARIEUMSCHALTER.md`). Diese Stufe: Audio (Radio). Hauptsignal und drei Notquellen kommen als MXL-Flows, dazu ein eingebauter
//! Notclip (Datei in Schleife); fällt das Hauptsignal aus (kein Signal, Stille), schlägt der Node Alarm (`omp.alert.<node>`) und schaltet die
//! erste gesunde Quelle der einstellbaren Reihenfolge; Rückkehr automatisch oder manuell, Umschaltung auch von Hand.

mod failover;
mod io;
mod uibundle;
mod video;

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use failover::{Controller, Event, Fader, Mode, N, Obs, Plan, Rules, SOURCES, Status};
use io::{BLOCK, CH, InputControl, MXL_INPUTS, MxlIo, SAMPLE_RATE};
use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource, bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, ReceiverSpec, SenderSpec, SetError};
use serde_json::{Value, json};
use video::{VideoCfg, VideoIo};

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Shared {
    ctl: Mutex<Controller>,
    /// Spitzenpegel je Quelle (f32-Bits, mit Abklingen) und am Ausgang.
    levels: [AtomicU32; N],
    out_level: AtomicU32,
    /// Wanduhr beim Start (Zeitstempel der Ereignisse = Start + Modellzeit).
    start_unix_ms: u64,
    clip_path: Mutex<String>,
    still_path: Mutex<String>,
    /// Index der aktiven Quelle (für den Bildtakt).
    active_idx: AtomicUsize,
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

/// Beobachten, entscheiden, mischen: ein Block (10 ms) je Aufruf. Gemeinsam für Radio (eigene Uhr) und Fernsehen (MXL-Raster).
struct Engine {
    sh: Arc<Shared>,
    io: Arc<MxlIo>,
    video: Option<Arc<VideoIo>>,
    events: Sender<Event>,
    bufs: Vec<Vec<f32>>,
    out: Vec<f32>,
    fader: Fader,
}

impl Engine {
    fn new(sh: Arc<Shared>, io: Arc<MxlIo>, video: Option<Arc<VideoIo>>, events: Sender<Event>) -> Self {
        Engine { sh, io, video, events, bufs: (0..N).map(|_| vec![0.0f32; BLOCK * CH]).collect(), out: vec![0.0f32; BLOCK * CH], fader: Fader::new(0) }
    }

    /// `ts_ns`: Ursprungszeit auf dem MXL-Raster (Fernsehen) oder `None` (Radio).
    fn audio_tick(&mut self, ts_ns: Option<u64>) {
        let still = SOURCES.iter().position(|s| *s == "still").unwrap_or(5);
        let mut obs = [Obs::default(); N];
        for slot in 0..N {
            let got = self.io.take(slot, &mut self.bufs[slot]);
            let db = if got > 0 { peak_db(&self.bufs[slot][..got * CH]) } else { -120.0 };
            let lv = &self.sh.levels[slot];
            let old = load_db(lv) - 1.5;
            store_db(lv, db.max(old));
            obs[slot] = match &self.video {
                // Fernsehen: „Signal da“ heißt Bild da; Stille/Standbild/Schwarz kommen aus Ton und Bildanalyse
                Some(v) => Obs {
                    present: v.present(slot, 800),
                    level_db: if slot == still { None } else { Some(db) },
                    frozen: if slot == still { Some(false) } else { Some(v.frozen(slot, 3)) },
                    black: Some(v.is_black(slot)),
                },
                None => Obs { present: self.io.present(slot, 600), level_db: Some(db), frozen: None, black: None },
            };
        }
        let (active, evs) = {
            let mut c = self.sh.ctl.lock().expect("lock poisoned");
            let evs = c.step(10, &obs);
            (SOURCES.iter().position(|s| *s == c.active).unwrap_or(0), evs)
        };
        self.sh.active_idx.store(active, Ordering::Relaxed);
        for e in evs {
            let _ = self.events.send(e);
        }
        match self.fader.update(active) {
            Plan::Solo(src) => self.out.copy_from_slice(&self.bufs[src]),
            Plan::Fade { from, to, block } => {
                // Überblendung über 20 ms (linear; die Quellen sind unkorreliert, kurzer Übergang)
                let total = (2 * BLOCK) as f32;
                let done = (block as usize * BLOCK) as f32;
                for i in 0..BLOCK {
                    let t = (done + i as f32) / total;
                    for c in 0..CH {
                        self.out[i * CH + c] = self.bufs[from][i * CH + c] * (1.0 - t) + self.bufs[to][i * CH + c] * t;
                    }
                }
            }
        }
        let odb = peak_db(&self.out);
        let old = load_db(&self.sh.out_level) - 1.5;
        store_db(&self.sh.out_level, odb.max(old));
        match ts_ns {
            Some(ts) => self.io.push_output_origin(&self.out, ts),
            None => self.io.push_output(&self.out),
        }
    }
}

/// Radio: eigene Uhr, alle 10 ms ein Block; nie vom Eingang getrieben.
fn clock_loop(mut eng: Engine, shutdown: Arc<AtomicBool>, heartbeat: Arc<AtomicU64>) {
    let period = Duration::from_millis(10);
    let mut next = std::time::Instant::now();
    while !shutdown.load(Ordering::Relaxed) {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        eng.audio_tick(None);
        next += period;
        let now = std::time::Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else if now - next > period * 20 {
            next = now;
        }
    }
}

/// Fernsehen: Bild- und Tonblöcke auf dem MXL-Raster (Index → TAI-Zeit), wie `omp-playout-buffer`; die Entscheidung fällt im Tontakt,
/// das Bild folgt der aktiven Quelle am nächsten Bildtakt (höchstens ein Bild Versatz beim Umschalten).
fn av_loop(mut eng: Engine, video: Arc<VideoIo>, shutdown: Arc<AtomicBool>, heartbeat: Arc<AtomicU64>) {
    let ctx = video.context();
    let cfg = video.cfg;
    let period_ns = cfg.period_ns();
    let rate = SAMPLE_RATE;
    let block = BLOCK as u64;
    let now0 = ctx.now_ns();
    let mut kv = ctx.ns_to_index(now0 + 100_000_000, cfg.fps_num, cfg.fps_den).unwrap_or(0) + 1;
    let mut ka = ctx.ns_to_index(now0 + 100_000_000, rate, 1).unwrap_or(0).div_ceil(block) * block;
    let mut tv = ctx.index_to_ns(kv, cfg.fps_num, cfg.fps_den).unwrap_or(now0);
    let mut ta = ctx.index_to_ns(ka, rate, 1).unwrap_or(now0);
    let mut last_frame: Option<video::Frame> = None;
    while !shutdown.load(Ordering::Relaxed) {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        let now = ctx.now_ns();
        if now >= ta {
            eng.audio_tick(Some(ta));
            ka += block;
            if now > ta + 200_000_000 {
                ka = ctx.ns_to_index(now, rate, 1).unwrap_or(ka).div_ceil(block) * block;
            }
            ta = ctx.index_to_ns(ka, rate, 1).unwrap_or(ta + 10_000_000);
        }
        if now >= tv {
            let active = eng.sh.active_idx.load(Ordering::Relaxed);
            // letztes Bild der aktiven Quelle; fehlt es, das zuletzt gesendete wiederholen, sonst Schwarz (nie abreißen)
            let own = video.latest(active);
            if own.is_none() {
                video.repeats_out.fetch_add(1, Ordering::Relaxed);
            }
            let frame = own.or_else(|| last_frame.clone()).unwrap_or_else(|| video.black.clone());
            video.push_frame(&frame, tv);
            video.frames_out.fetch_add(1, Ordering::Relaxed);
            last_frame = Some(frame);
            kv += 1;
            if now > tv + period_ns * 5 {
                kv = ctx.ns_to_index(now, cfg.fps_num, cfg.fps_den).unwrap_or(kv) + 1;
            }
            tv = ctx.index_to_ns(kv, cfg.fps_num, cfg.fps_den).unwrap_or(tv + period_ns);
        }
        let next = tv.min(ta);
        let now = ctx.now_ns();
        if next > now {
            std::thread::sleep(Duration::from_nanos((next - now).min(2_000_000)));
        }
    }
}

/// IS-05-Steuerung eines Bild-Eingangs.
struct VideoInputControl {
    video: Arc<VideoIo>,
    slot: usize,
    registry: RegistryClient,
}

impl ReceiverControl for VideoInputControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => self.video.connect_input(self.slot, flow_id),
                    None => eprintln!("omp-failover: Sender {sender_id} hat keinen Flow"),
                },
                Err(e) => eprintln!("omp-failover: Sender {sender_id} nicht auflösbar: {e}"),
            },
            _ => self.video.connect_input(self.slot, String::new()),
        }
    }
}

struct Store {
    sh: Arc<Shared>,
    io: Arc<MxlIo>,
    connections: Vec<Arc<ReceiverConnection<InputControl>>>,
    video: Option<Arc<VideoIo>>,
    video_connections: Vec<Arc<ReceiverConnection<VideoInputControl>>>,
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
                    let slot_src = if let Some(v) = &self.video { let vs = v.source_of(i); if vs.is_empty() { self.io.source_of(i) } else { vs } } else { self.io.source_of(i) };
                    let state = if slot_src.is_empty() { "nichtverbunden" } else if cause.is_some() { "gestoert" } else if h.healthy(&c.rules) { "gesund" } else { "pruefe" };
                    json!({"id": id, "label": failover::label(id), "connected": !slot_src.is_empty(), "present": h.present, "levelDb": load_db(&self.sh.levels[i]).max(-120.0),
                           "state": state, "cause": cause, "okMs": h.ok_ms, "noSignalMs": h.no_signal_ms, "silentMs": h.silent_ms, "frozenMs": h.frozen_ms, "blackMs": h.black_ms, "video": self.video.is_some(), "active": c.active == *id,
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
                rw("freezeMs", ParamType::Number, Some("ms")),
                rw("blackMs", ParamType::Number, Some("ms")),
                rw("clipFile", ParamType::String, None),
                rw("stillFile", ParamType::String, None),
                ro("videoMode", ParamType::Boolean),
                ro("videoOut", ParamType::String),
                ro("videoOut", ParamType::String),
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
            "freezeMs" => json!(c.rules.freeze_ms),
            "blackMs" => json!(c.rules.black_ms),
            "clipFile" => json!(self.sh.clip_path.lock().expect("lock poisoned").clone()),
            "stillFile" => json!(self.sh.still_path.lock().expect("lock poisoned").clone()),
            "videoMode" => json!(self.video.is_some()),
            "videoOut" => json!(self.video.as_ref().map(|v| json!({"frames": v.frames_out.load(Ordering::Relaxed), "repeats": v.repeats_out.load(Ordering::Relaxed)}).to_string()).unwrap_or_default()),
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
            self.io.set_clip(p, self.video.clone());
            return Ok(());
        }
        if name == "stillFile" {
            let p = value.as_str().ok_or(SetError::Unknown)?.trim().to_string();
            *self.sh.still_path.lock().expect("lock poisoned") = p.clone();
            if let Some(v) = &self.video {
                v.set_still(p);
            }
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
            "freezeMs" => r.freeze_ms = value.as_u64().ok_or(SetError::Unknown)?,
            "blackMs" => r.black_ms = value.as_u64().ok_or(SetError::Unknown)?,
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
            return Some(json_ok(json!({"state": {"noSignalMs": r.no_signal_ms, "silenceDb": r.silence_db, "silenceMs": r.silence_ms, "freezeMs": r.freeze_ms, "blackMs": r.black_ms, "healthyMs": r.healthy_ms,
                "returnMs": r.return_ms, "minHoldMs": r.min_hold_ms, "autoReturn": r.auto_return, "order": r.order,
                "clipFile": self.sh.clip_path.lock().expect("lock poisoned").clone(),
                "stillFile": self.sh.still_path.lock().expect("lock poisoned").clone(),
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
            if let Some(x) = u("blackMs") { r.black_ms = x; }
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
                self.io.set_clip(p.to_string(), self.video.clone());
            }
            if let Some(p) = s.get("stillFile").and_then(Value::as_str).filter(|p| !p.is_empty()) {
                *self.sh.still_path.lock().expect("lock poisoned") = p.to_string();
                if let Some(v) = &self.video {
                    v.set_still(p.to_string());
                }
            }
            return Some(json_ok(json!({"ok": true})));
        }
        // IS-05: Verbindungen der vier Eingänge
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        let ids: Vec<String> = self.connections.iter().map(|c| c.id().to_string()).chain(self.video_connections.iter().map(|c| c.id().to_string())).collect();
        let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        root_discovery(method, path)
            .or_else(|| list_ids(method, path, "receivers", &id_refs))
            .or_else(|| bulk_discovery(method, path))
            .or_else(|| bulk_patch(method, path, "receivers", body, |id, params| self.connections.iter().find(|c| c.id() == id).map(|c| c.patch_staged(params).0).or_else(|| self.video_connections.iter().find(|c| c.id() == id).map(|c| c.patch_staged(params).0))))
            .or_else(|| bulk_patch(method, path, "senders", body, |_, _| None))
            .or_else(|| self.connections.iter().find_map(|c| c.handle(method, path, body)))
            .or_else(|| self.video_connections.iter().find_map(|c| c.handle(method, path, body)))
            .map(to_raw)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.connections.iter().find_map(|c| c.cors_methods(path)).or_else(|| self.video_connections.iter().find_map(|c| c.cors_methods(path))).or_else(|| bulk_cors_methods(path, "senders")).or_else(|| bulk_cors_methods(path, "receivers"))
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
    // Fernsehbetrieb (Bild + Ton): OMP_FAILOVER_VIDEO=1; Format des Ausgangs OMP_FAILOVER_WIDTH/HEIGHT/FPS (Standard 1920×1080, 25 Bilder/s)
    let tv = matches!(env_or("OMP_FAILOVER_VIDEO", "0").as_str(), "1" | "true" | "yes");
    let video_out_flow = omp_node_sdk::idgen::new_v4();
    let video: Option<Arc<VideoIo>> = if tv {
        let cfg = VideoCfg {
            width: env_or("OMP_FAILOVER_WIDTH", "1920").parse().unwrap_or(1920),
            height: env_or("OMP_FAILOVER_HEIGHT", "1080").parse().unwrap_or(1080),
            fps_num: env_or("OMP_FAILOVER_FPS", "25").parse().unwrap_or(25),
            fps_den: 1,
        };
        Some(VideoIo::new(io.context(), cfg, &video_out_flow, &format!("{label} Bild"))?)
    } else {
        None
    };
    let receiver_ids: Vec<String> = (0..MXL_INPUTS).map(|_| omp_node_sdk::idgen::new_v4()).collect();
    let connections: Vec<Arc<ReceiverConnection<InputControl>>> = receiver_ids
        .iter()
        .enumerate()
        .map(|(slot, id)| Arc::new(ReceiverConnection::new(id.clone(), InputControl { io: io.clone(), slot, registry: registry.clone() })))
        .collect();
    let video_receiver_ids: Vec<String> = if tv { (0..MXL_INPUTS).map(|_| omp_node_sdk::idgen::new_v4()).collect() } else { Vec::new() };
    let video_connections: Vec<Arc<ReceiverConnection<VideoInputControl>>> = match &video {
        Some(v) => video_receiver_ids
            .iter()
            .enumerate()
            .map(|(slot, id)| Arc::new(ReceiverConnection::new(id.clone(), VideoInputControl { video: v.clone(), slot, registry: registry.clone() })))
            .collect(),
        None => Vec::new(),
    };
    let names = ["Hauptsignal", "Notquelle 1", "Notquelle 2", "Notquelle 3"];
    let mut receivers: Vec<ReceiverSpec> = receiver_ids
        .iter()
        .zip(names)
        .map(|(id, name)| ReceiverSpec {
            id: Some(id.clone()),
            transport: Some(TRANSPORT_MXL.to_string()),
            media_types: Some(vec!["audio/float32".to_string()]),
            // Fernsehbetrieb: „… Ton“ und „… Bild“ getrennt; Radio behält die schlichten Namen
            label: Some(if tv { format!("{name} Ton") } else { name.to_string() }),
            ..Default::default()
        })
        .collect();
    for (id, name) in video_receiver_ids.iter().zip(names) {
        receivers.push(ReceiverSpec {
            id: Some(id.clone()),
            transport: Some(TRANSPORT_MXL.to_string()),
            media_types: Some(vec!["video/v210".to_string()]),
            label: Some(format!("{name} Bild")),
            ..Default::default()
        });
    }
    let mut senders = vec![SenderSpec {
        id: Some(omp_node_sdk::idgen::new_v4()),
        transport: Some(TRANSPORT_MXL.to_string()),
        flow: Some(FlowSpec::Audio { id: Some(out_flow), sample_rate_numerator: SAMPLE_RATE, channel_count: CH as u32, media_type: "audio/float32".to_string(), bit_depth: 32, source_id: None }),
        label: Some(if tv { "Ton (nach Wächter)".to_string() } else { "Programm (nach Wächter)".to_string() }),
        ..Default::default()
    }];
    if let Some(v) = &video {
        senders.push(SenderSpec {
            id: Some(omp_node_sdk::idgen::new_v4()),
            transport: Some(TRANSPORT_MXL.to_string()),
            flow: Some(FlowSpec::Video { id: Some(video_out_flow), frame_width: v.cfg.width, frame_height: v.cfg.height, grain_rate_numerator: v.cfg.fps_num, grain_rate_denominator: v.cfg.fps_den }),
            label: Some("Bild (nach Wächter)".to_string()),
            ..Default::default()
        });
    }

    let sh = Arc::new(Shared {
        ctl: Mutex::new(Controller::new(Rules::default())),
        levels: std::array::from_fn(|_| AtomicU32::new((-120.0f32).to_bits())),
        out_level: AtomicU32::new((-120.0f32).to_bits()),
        start_unix_ms: unix_now_ms(),
        clip_path: Mutex::new(String::new()),
        still_path: Mutex::new(String::new()),
        active_idx: AtomicUsize::new(0),
    });
    let initial_clip = env_or("OMP_FAILOVER_CLIP", "");
    if !initial_clip.is_empty() {
        *sh.clip_path.lock().expect("lock poisoned") = initial_clip.clone();
        io.set_clip(initial_clip, video.clone());
    }
    let initial_still = env_or("OMP_FAILOVER_STILL", "");
    if !initial_still.is_empty() {
        *sh.still_path.lock().expect("lock poisoned") = initial_still.clone();
        if let Some(v) = &video {
            v.set_still(initial_still);
        }
    }
    let shutdown = Arc::new(AtomicBool::new(false));
    let heartbeat = Arc::new(AtomicU64::new(0));
    let (tx, rx) = channel::<Event>();
    let tx2 = tx.clone();
    let clock = {
        let (sd, hb) = (shutdown.clone(), heartbeat.clone());
        let eng = Engine::new(sh.clone(), io.clone(), video.clone(), tx);
        match video.clone() {
            Some(v) => std::thread::spawn(move || av_loop(eng, v, sd, hb)),
            None => std::thread::spawn(move || clock_loop(eng, sd, hb)),
        }
    };
    let media_io = io.clone();
    let media_video = video.clone();
    let store: Arc<dyn ParamStore> = Arc::new(Store { sh: sh.clone(), io: io.clone(), connections, video: video.clone(), video_connections, events: Mutex::new(tx2) });
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
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_io.out_flowed() && media_video.as_ref().is_none_or(|v| v.out_flowed()))),
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
