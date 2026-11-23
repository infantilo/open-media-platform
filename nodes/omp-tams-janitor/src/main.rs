//! omp-tams-janitor (Kapitel 105.6): Aufbewahrung als Dauerläufer für einen TAMS-Speicher (API 8.2), siehe `lib.rs`.
//!
//! Einstellung per Umgebung (Zugang wie bei den anderen TAMS-Nodes, Entscheidung D-T3):
//! * `OMP_TAMS_URL`, `OMP_TAMS_AUTH`, `OMP_TAMS_USER`, `OMP_TAMS_TOKEN_FILE` / `OMP_TAMS_TOKEN`
//! * `OMP_TAMS_JANITOR_INTERVAL_S`  Abstand der Durchläufe (Standard 60, 10…86400)
//! * `OMP_TAMS_EMPTY_FLOW_HOURS`    leere Flows **mit Retention-Tag** nach so vielen Stunden aufräumen (Standard 0 = nie)
//!
//! Der Node braucht Löschrecht an den Flows (AppNote 0016). Er löscht nur Flows mit den Tags `segment_retention_offset` /
//! `flow_retention_offset`.

use omp_node_sdk::{Descriptor, InvokeError, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, SetError};
use omp_tams::auth::{Auth, redact_url, secret_from_env};
use omp_tams::client::{Client, ClientConfig};
use omp_tams_janitor::{Stats, sweep};
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

struct Store {
    stats: Arc<Stats>,
    config_problem: Option<String>,
    service: String,
    interval_s: u64,
    last_sweep_unix_s: Arc<AtomicU64>,
    run_now: Arc<AtomicBool>,
}

fn num(name: &str, unit: Option<&str>) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind: ParamType::Number, unit: unit.map(str::to_string), range: None, readonly: true }
}
fn text(name: &str) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind: ParamType::String, unit: None, range: None, readonly: true }
}

impl ParamStore for Store {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                text("tams.service"),
                num("tams.intervalS", Some("s")),
                num("tams.sweeps", None),
                num("tams.flowsSeen", None),
                num("tams.segmentDeletes", None),
                num("tams.flowsDeleted", None),
                num("tams.errors", None),
                num("tams.lastSweepAt", Some("s")),
                text("tams.lastError"),
            ],
            methods: vec![MethodSpec { name: "tams.sweepNow".to_string(), args: vec![] }],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let s = &self.stats;
        let n = |a: &AtomicU64| Some(serde_json::json!(a.load(Ordering::Relaxed)));
        match name {
            "tams.service" => Some(serde_json::json!(self.service)),
            "tams.intervalS" => Some(serde_json::json!(self.interval_s)),
            "tams.sweeps" => n(&s.sweeps),
            "tams.flowsSeen" => n(&s.flows_seen),
            "tams.segmentDeletes" => n(&s.segment_deletes),
            "tams.flowsDeleted" => n(&s.flows_deleted),
            "tams.errors" => n(&s.errors),
            "tams.lastSweepAt" => n(&self.last_sweep_unix_s),
            "tams.lastError" => Some(serde_json::json!(self.config_problem.clone().unwrap_or_else(|| s.last_error.lock().expect("lock poisoned").clone()))),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "tams.sweepNow" => match &self.config_problem {
                Some(p) => Err(InvokeError::Message(format!("kein TAMS-Speicher eingerichtet: {p}"))),
                None => {
                    self.run_now.store(true, Ordering::Relaxed);
                    Ok(())
                }
            },
            _ => Err(InvokeError::Unknown),
        }
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn client_from_env() -> Result<(Client, String), String> {
    let url = std::env::var("OMP_TAMS_URL").map_err(|_| "OMP_TAMS_URL nicht gesetzt".to_string())?;
    let secret = secret_from_env().map_err(|e| e.to_string())?;
    let user = std::env::var("OMP_TAMS_USER").ok();
    let auth = Auth::from_parts(&env_or("OMP_TAMS_AUTH", "none"), user.as_deref(), secret)?;
    let display = redact_url(&url);
    Ok((Client::new(ClientConfig::new(url, auth)).map_err(|e| e.to_string())?, display))
}

fn unix_ns() -> i128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as i128).unwrap_or(0)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "TAMS Retention");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9362").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let interval_s: u64 = env_or("OMP_TAMS_JANITOR_INTERVAL_S", "60").parse().unwrap_or(60).clamp(10, 86_400);
    let empty_flow_s: u64 = env_or("OMP_TAMS_EMPTY_FLOW_HOURS", "0").parse::<f64>().ok().filter(|h| *h > 0.0).map(|h| (h * 3600.0) as u64).unwrap_or(0);

    let stats = Arc::new(Stats::default());
    let shutdown = Arc::new(AtomicBool::new(false));
    let heartbeat = Arc::new(AtomicU64::new(0));
    let last_sweep = Arc::new(AtomicU64::new(0));
    let run_now = Arc::new(AtomicBool::new(false));
    let (client, config_problem, service) = match client_from_env() {
        Ok((c, d)) => (Some(c), None, d),
        Err(e) => {
            eprintln!("omp-tams-janitor: {e}");
            (None, Some(e), String::new())
        }
    };
    let worker = client.map(|c| {
        let (st, sd, hb, ls, rn) = (stats.clone(), shutdown.clone(), heartbeat.clone(), last_sweep.clone(), run_now.clone());
        std::thread::spawn(move || {
            let mut next = Instant::now();
            while !sd.load(Ordering::Relaxed) {
                hb.fetch_add(1, Ordering::Relaxed);
                if Instant::now() >= next || rn.swap(false, Ordering::Relaxed) {
                    sweep(&c, omp_mediaio::timebase::tai_now_ns(), unix_ns(), empty_flow_s, &st);
                    ls.store((unix_ns() / 1_000_000_000) as u64, Ordering::Relaxed);
                    next = Instant::now() + Duration::from_secs(interval_s);
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        })
    });
    let store: Arc<dyn ParamStore> = Arc::new(Store { stats, config_problem, service, interval_s, last_sweep_unix_s: last_sweep, run_now });
    let node = omp_node_sdk::start(
        NodeConfig { label, host, port, registry_url, nats_url, senders: vec![], receivers: vec![], instance_id, media_ready: omp_node_sdk::MediaReadySource::NotApplicable },
        store,
    )
    .await?;
    node.register_worker("sweeper", heartbeat);
    tokio::signal::ctrl_c().await?;
    shutdown.store(true, Ordering::Relaxed);
    if let Some(t) = worker {
        let _ = t.join();
    }
    Ok(())
}
