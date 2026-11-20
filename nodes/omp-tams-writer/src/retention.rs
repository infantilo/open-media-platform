//! Löschlauf der Aufbewahrung (AppNote 0019): räumt **nur die Flows auf, die dieser Schreiber selbst aufnimmt** (die der
//! [`FlowRegistry`] bekannt sind) — nie fremde Flows des Speichers. Metadaten-Kopien (Kapitel 105.6) behalten ihre
//! Objects: der Dienst zählt Verweise und löscht ein Object erst nach dem letzten.

use crate::uploader::FlowRegistry;
use omp_tams::client::Client;
use omp_tams::retention::{cutoff_range, empty_flow_expired, flow_expired};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Aufbewahrungsregeln (0 = aus).
#[derive(Clone, Copy, Debug, Default)]
pub struct Policy {
    /// Segmente (Tag `segment_retention_offset`).
    pub segment_s: u64,
    /// Ganze Flows (Tag `flow_retention_offset`): gelöscht, wenn `max(metadata_updated, segments_updated) + Offset ≤ jetzt`.
    pub flow_s: u64,
    /// Leere Flows ohne Segmente, deren Änderungen länger als so viele Sekunden zurückliegen.
    pub empty_flow_s: u64,
}

impl Policy {
    pub fn active(&self) -> bool {
        self.segment_s > 0 || self.flow_s > 0 || self.empty_flow_s > 0
    }
}

#[derive(Default)]
pub struct RetentionStats {
    pub flows_deleted: AtomicU64,
    pub runs: AtomicU64,
    pub errors: AtomicU64,
    pub last_error: Mutex<String>,
}

/// Ein Durchlauf: je Flow `DELETE …?timerange=_<jetzt − Offset>)`. 404 (Flow noch nicht angelegt) ist kein Fehler.
pub fn run_once(client: &Client, registry: &FlowRegistry, policy: Policy, now_tai_ns: u64, now_unix_ns: i128, stats: &RetentionStats) {
    let fail = |id: &str, e: omp_tams::client::Error| {
        stats.errors.fetch_add(1, Ordering::Relaxed);
        *stats.last_error.lock().expect("lock poisoned") = format!("Aufbewahrung {id}: {e}");
    };
    let range = (policy.segment_s > 0).then(|| cutoff_range(now_tai_ns, policy.segment_s)).flatten();
    for id in registry.flow_ids() {
        if let Some(r) = &range {
            match client.delete_segments(&id, r) {
                Ok(_) => {}
                Err(e) if e.status() == Some(404) => continue,
                Err(e) => fail(&id, e),
            }
        }
        // ganze Flows: erst nach den Segmenten, mit frischem Stand des Flows (der Offset kann inzwischen geändert sein)
        if policy.flow_s > 0 || policy.empty_flow_s > 0 {
            match client.get_flow(&id) {
                Ok(flow) => {
                    let due = flow_expired(&flow, now_unix_ns) || (policy.empty_flow_s > 0 && empty_flow_expired(&flow, policy.empty_flow_s, now_unix_ns));
                    if due {
                        match client.delete_flow(&id) {
                            Ok(_) => {
                                stats.flows_deleted.fetch_add(1, Ordering::Relaxed);
                            }
                            Err(e) if e.status() == Some(404) => {}
                            Err(e) => fail(&id, e),
                        }
                    }
                }
                Err(e) if e.status() == Some(404) => {}
                Err(e) => fail(&id, e),
            }
        }
    }
    stats.runs.fetch_add(1, Ordering::Relaxed);
}

/// Wiederholt [`run_once`] alle `interval`, bis `shutdown` gesetzt wird.
pub fn run(client: Arc<Client>, registry: Arc<FlowRegistry>, policy: Policy, interval: Duration, now: impl Fn() -> u64, shutdown: Arc<AtomicBool>, stats: Arc<RetentionStats>) {
    let mut next = std::time::Instant::now();
    while !shutdown.load(Ordering::Relaxed) {
        if std::time::Instant::now() >= next {
            let unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as i128).unwrap_or(0);
            run_once(&client, &registry, policy, now(), unix, &stats);
            next = std::time::Instant::now() + interval;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}
