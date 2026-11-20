//! Löschlauf der Aufbewahrung (AppNote 0019): räumt **nur die Flows auf, die dieser Schreiber selbst aufnimmt** (die der
//! [`FlowRegistry`] bekannt sind) — nie fremde Flows des Speichers. Metadaten-Kopien (Kapitel 105.6) behalten ihre
//! Objects: der Dienst zählt Verweise und löscht ein Object erst nach dem letzten.

use crate::uploader::FlowRegistry;
use omp_tams::client::Client;
use omp_tams::retention::cutoff_range;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
pub struct RetentionStats {
    pub runs: AtomicU64,
    pub errors: AtomicU64,
    pub last_error: Mutex<String>,
}

/// Ein Durchlauf: je Flow `DELETE …?timerange=_<jetzt − Offset>)`. 404 (Flow noch nicht angelegt) ist kein Fehler.
pub fn run_once(client: &Client, registry: &FlowRegistry, offset_s: u64, now_tai_ns: u64, stats: &RetentionStats) {
    let Some(range) = cutoff_range(now_tai_ns, offset_s) else { return };
    for id in registry.flow_ids() {
        match client.delete_segments(&id, &range) {
            Ok(_) => {}
            Err(e) if e.status() == Some(404) => {}
            Err(e) => {
                stats.errors.fetch_add(1, Ordering::Relaxed);
                *stats.last_error.lock().expect("lock poisoned") = format!("Aufbewahrung {id}: {e}");
            }
        }
    }
    stats.runs.fetch_add(1, Ordering::Relaxed);
}

/// Wiederholt [`run_once`] alle `interval`, bis `shutdown` gesetzt wird.
pub fn run(client: Arc<Client>, registry: Arc<FlowRegistry>, offset_s: u64, interval: Duration, now: impl Fn() -> u64, shutdown: Arc<AtomicBool>, stats: Arc<RetentionStats>) {
    let mut next = std::time::Instant::now();
    while !shutdown.load(Ordering::Relaxed) {
        if std::time::Instant::now() >= next {
            run_once(&client, &registry, offset_s, now(), &stats);
            next = std::time::Instant::now() + interval;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}
