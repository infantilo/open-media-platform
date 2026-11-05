//! omp-audio-delay (Radio, Kapitel 89/RA3): Sendeverzögerung für den Programmton — Verzögerung `delayMs` (Standard 8 s), **Dump**
//! (Sprung nach vorn), **Wiederaufbau** mit ±1 % Tonhöhe und **Notquelle** bei Ausfall des Eingangs. Logik: `delay.rs` (rein, getestet),
//! MXL-Anbindung: `io.rs`. Der Ausgang läuft auf eigener Uhr (10-ms-Takt) und reißt nie ab.

mod delay;
mod io;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use omp_node_sdk::connection::{ReceiverConnection, bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, LatencyInfo, LatencyRange, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, Range, RawResponse,
    ReceiverSpec, SenderSpec, SetError,
};
use serde_json::Value;

use delay::{Config, DelayLine, State};
use io::{BLOCK, InputControl, MxlIo, SAMPLE_RATE};

const MAX_DELAY_MS: u64 = 60_000;

/// Spitzenpegel von Ein- und Ausgang (linear, f32-Bits) — Anzeige im Panel und Messhilfe für den Verzögerungstest.
#[derive(Default)]
struct Levels {
    input: std::sync::atomic::AtomicU32,
    output: std::sync::atomic::AtomicU32,
}

fn peak(block: &[f32]) -> f32 {
    block.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

fn db(linear: u32) -> f64 {
    let v = f32::from_bits(linear) as f64;
    if v <= 0.00003 { -90.0 } else { (20.0 * v.log10() * 10.0).round() / 10.0 }
}

struct DelayStore {
    line: Arc<Mutex<DelayLine>>,
    io: Arc<MxlIo>,
    levels: Arc<Levels>,
    connections: Vec<Arc<ReceiverConnection<InputControl>>>,
}

fn ro(name: &str, kind: ParamType, unit: Option<&str>) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: unit.map(str::to_string), range: None, readonly: true }
}

impl ParamStore for DelayStore {
    fn descriptor(&self) -> Descriptor {
        let target = self.line.lock().expect("lock poisoned").target_ms();
        let samples = (target * SAMPLE_RATE as u64 / 1000) as u32;
        Descriptor {
            // Eigenlatenz = Zielverzögerung (deterministisch); ein vom Orchestrator zugewiesener Ausgleich kommt obendrauf.
            latency: Some(LatencyInfo { video: None, audio: Some(LatencyRange { min_latency_frames: samples, max_latency_frames: samples }), data: None, supports_delay_compensation: false }),
            parameters: vec![
                ParamSpec {
                    name: "delayMs".to_string(),
                    kind: ParamType::Number,
                    unit: Some("ms".to_string()),
                    range: Some(Range::Number { min: 0.0, max: MAX_DELAY_MS as f64 }),
                    readonly: false,
                },
                ParamSpec {
                    name: "rebuildPercent".to_string(),
                    kind: ParamType::Number,
                    unit: Some("%".to_string()),
                    range: Some(Range::Number { min: 0.1, max: 5.0 }),
                    readonly: false,
                },
                ro("currentDelayMs", ParamType::Number, Some("ms")),
                ro("inputLevelDb", ParamType::Number, Some("dBFS")),
                ro("outputLevelDb", ParamType::Number, Some("dBFS")),
                ro("state", ParamType::String, None),
                ro("rebuilding", ParamType::Boolean, None),
                ro("dumpedMs", ParamType::Number, Some("ms")),
                ro("underruns", ParamType::Number, None),
                ro("inputConnected", ParamType::Boolean, None),
                ro("inputFlowing", ParamType::Boolean, None),
                ro("emergencyConnected", ParamType::Boolean, None),
            ],
            methods: vec![
                // Sprung nach vorn: wirft höchstens `ms` der ältesten Verzögerung weg (Wiederaufbau folgt von selbst).
                MethodSpec { name: "dump".to_string(), args: vec![MethodArg { name: "ms".to_string(), kind: ParamType::Number }] },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "inputLevelDb" => return Some(serde_json::json!(db(self.levels.input.load(Ordering::Relaxed)))),
            "outputLevelDb" => return Some(serde_json::json!(db(self.levels.output.load(Ordering::Relaxed)))),
            _ => {}
        }
        let l = self.line.lock().expect("lock poisoned");
        Some(match name {
            "delayMs" => serde_json::json!(l.target_ms()),
            "rebuildPercent" => serde_json::json!(l.rebuild_permille() as f64 / 10.0),
            "currentDelayMs" => serde_json::json!((l.delay_ms() * 10.0).round() / 10.0),
            "state" => serde_json::json!(l.state().as_str()),
            "rebuilding" => serde_json::json!(l.rebuilding()),
            "dumpedMs" => serde_json::json!((l.stats.dumped_frames as f64 * 1000.0 / SAMPLE_RATE as f64).round()),
            "underruns" => serde_json::json!(l.stats.underruns),
            "inputConnected" => serde_json::json!(!self.io.input_flow(0).is_empty()),
            "inputFlowing" => serde_json::json!(self.io.input_flowed(0)),
            "emergencyConnected" => serde_json::json!(!self.io.input_flow(1).is_empty()),
            _ => return None,
        })
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let v = value.as_f64().filter(|v| v.is_finite()).ok_or(SetError::Unknown)?;
        match name {
            "delayMs" => {
                if !(0.0..=MAX_DELAY_MS as f64).contains(&v) {
                    return Err(SetError::Unknown);
                }
                self.line.lock().expect("lock poisoned").set_target_ms(v as u64);
                Ok(())
            }
            "rebuildPercent" => {
                if !(0.1..=5.0).contains(&v) {
                    return Err(SetError::Unknown);
                }
                self.line.lock().expect("lock poisoned").set_rebuild_permille((v * 10.0).round() as u32);
                Ok(())
            }
            _ if self.get(name).is_some() => Err(SetError::ReadOnly),
            _ => Err(SetError::Unknown),
        }
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "dump" => {
                let ms = args.get("ms").and_then(Value::as_f64).filter(|v| v.is_finite() && *v > 0.0 && *v <= MAX_DELAY_MS as f64).ok_or(InvokeError::Unknown)?;
                let dropped = self.line.lock().expect("lock poisoned").dump(ms as u64);
                if dropped == 0 {
                    return Err(InvokeError::Message("Dump nicht möglich (Verzögerung steht nicht oder ist schon minimal)".to_string()));
                }
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        // Workflow-Sicherung: Zielverzögerung und Wiederaufbau-Geschwindigkeit überleben einen Neustart
        if method == "GET" && path == "/state" {
            let l = self.line.lock().expect("lock poisoned");
            let payload = serde_json::to_vec(&serde_json::json!({ "state": { "delayMs": l.target_ms(), "rebuildPermille": l.rebuild_permille() } })).unwrap_or_default();
            return Some(RawResponse { status: 200, content_type: "application/json", body: payload });
        }
        if method == "POST" && path == "/state" {
            return Some(match serde_json::from_slice::<Value>(body) {
                Ok(v) => {
                    let s = v.get("state").cloned().unwrap_or(Value::Null);
                    let mut l = self.line.lock().expect("lock poisoned");
                    if let Some(ms) = s.get("delayMs").and_then(Value::as_u64).filter(|m| *m <= MAX_DELAY_MS) {
                        l.set_target_ms(ms);
                    }
                    if let Some(p) = s.get("rebuildPermille").and_then(Value::as_u64).filter(|p| (1..=50).contains(p)) {
                        l.set_rebuild_permille(p as u32);
                    }
                    RawResponse { status: 200, content_type: "application/json", body: br#"{"ok":true}"#.to_vec() }
                }
                Err(_) => RawResponse { status: 400, content_type: "application/json", body: br#"{"error":"invalid JSON body"}"#.to_vec() },
            });
        }
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

/// Takt: alle 10 ms den Eingang in den Ring schieben, einen Block holen und senden. Eigene Uhr, nie vom Eingang getrieben.
fn clock_loop(line: Arc<Mutex<DelayLine>>, io: Arc<MxlIo>, levels: Arc<Levels>, shutdown: Arc<AtomicBool>, heartbeat: Arc<AtomicU64>) {
    let period = std::time::Duration::from_millis(10);
    let mut next = std::time::Instant::now();
    let mut block = vec![0.0f32; BLOCK * delay::CH];
    while !shutdown.load(Ordering::Relaxed) {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        let input = io.drain_input(0);
        // Spitzenpegel mit Abklingen (≈ 100 ms), damit kurze Töne in der Abfrage sichtbar bleiben
        let hold = |a: &std::sync::atomic::AtomicU32, new: f32| {
            let old = f32::from_bits(a.load(Ordering::Relaxed)) * 0.8;
            a.store(new.max(old).to_bits(), Ordering::Relaxed);
        };
        hold(&levels.input, peak(&input));
        {
            let mut l = line.lock().expect("lock poisoned");
            if !input.is_empty() {
                l.push(&input);
            }
            let io2 = io.clone();
            let mut emergency = move |out: &mut [f32]| io2.take_input(1, BLOCK, out);
            l.pull(&mut block, Some(&mut emergency));
        }
        hold(&levels.output, peak(&block));
        io.push_output(&block);
        next += period;
        let now = std::time::Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else if now - next > period * 20 {
            next = now; // lange Pause (Stillstand des Rechners): nicht im Rennen nachholen
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Audio-Verzögerung");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "0").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let delay_ms: u64 = env_or("OMP_DELAY_MS", "8000").parse::<u64>().unwrap_or(8000).min(MAX_DELAY_MS);
    let permille: u32 = env_or("OMP_REBUILD_PERMILLE", "10").parse::<u32>().unwrap_or(10).clamp(1, 50);

    gstreamer::init()?;
    let out_flow = omp_node_sdk::idgen::new_v4();
    let io = MxlIo::new(&domain, 2, &out_flow, &label)?;
    let line = Arc::new(Mutex::new(DelayLine::new(Config { sample_rate: SAMPLE_RATE, target_ms: delay_ms, max_ms: delay_ms + 2000, rebuild_permille: permille })));

    let registry = RegistryClient::new(registry_url.clone());
    let receiver_ids = [omp_node_sdk::idgen::new_v4(), omp_node_sdk::idgen::new_v4()];
    let connections: Vec<Arc<ReceiverConnection<InputControl>>> = receiver_ids
        .iter()
        .enumerate()
        .map(|(slot, id)| Arc::new(ReceiverConnection::new(id.clone(), InputControl { io: io.clone(), slot, registry: registry.clone() })))
        .collect();
    let receivers: Vec<ReceiverSpec> = receiver_ids
        .iter()
        .zip(["Programm", "Notquelle"])
        .map(|(id, name)| ReceiverSpec { id: Some(id.clone()), transport: Some(TRANSPORT_MXL.to_string()), media_types: Some(vec!["audio/float32".to_string()]), label: Some(name.to_string()), ..Default::default() })
        .collect();
    let senders = vec![SenderSpec {
        id: Some(omp_node_sdk::idgen::new_v4()),
        transport: Some(TRANSPORT_MXL.to_string()),
        flow: Some(FlowSpec::Audio { id: Some(out_flow), sample_rate_numerator: SAMPLE_RATE, channel_count: delay::CH as u32, media_type: "audio/float32".to_string(), bit_depth: 32, source_id: None }),
        label: Some("Programm verzögert".to_string()),
        ..Default::default()
    }];

    let shutdown = Arc::new(AtomicBool::new(false));
    let heartbeat = Arc::new(AtomicU64::new(0));
    let levels = Arc::new(Levels::default());
    let clock = {
        let (line, io, lv, sd, hb) = (line.clone(), io.clone(), levels.clone(), shutdown.clone(), heartbeat.clone());
        std::thread::spawn(move || clock_loop(line, io, lv, sd, hb))
    };

    let media_io = io.clone();
    let store: Arc<dyn ParamStore> = Arc::new(DelayStore { line: line.clone(), io: io.clone(), levels, connections });
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
            // Der Ausgang schreibt von Anfang an (Stille/Notquelle bis die Verzögerung gefüllt ist).
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_io.out_flowed())),
        },
        store,
    )
    .await?;
    handle.register_worker("clock", heartbeat);

    tokio::signal::ctrl_c().await?;
    eprintln!("omp-audio-delay: shutdown requested");
    shutdown.store(true, Ordering::Relaxed);
    let _ = clock.join();
    let _ = State::Run; // (State bleibt für spätere Anzeigen importiert)
    Ok(())
}
