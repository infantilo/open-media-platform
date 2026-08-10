//! Generische Liveness-Überwachung für Node-interne Worker-Threads
//! (Bug-Klasse 2026-08-07, `docs/decisions.md` Nachtrag 123:
//! `omp-viewer`s Audio-Meter-Reader-Thread starb still — kein Panic,
//! keine Fehlermeldung —, der Prozess lief unverändert weiter und
//! meldete sich über `omp.health.<node_id>` weiterhin als "ok", lieferte
//! aber keine Daten mehr; `launcher.supervise` beobachtet nur den
//! Prozess, nicht dessen interne Threads). Statt jeden künftigen Fund
//! dieser Klasse einzeln zu beheben (wie bislang), gibt dieses Modul dem
//! `omp.health`-Signal die dafür bislang fehlende Grundlage.
//!
//! Ein Worker registriert sich mit einem `Arc<AtomicU64>`, den er bei
//! JEDEM Schleifendurchlauf erhöht — unabhängig davon, ob dabei
//! tatsächlich Daten flossen (anders als `omp_mediaio::MediaFlow::
//! has_flowed`, das sticky ist, einmal `true` bleibt für immer `true`,
//! und daher genau diese Bug-Klasse nicht erkennen kann — s. dortige
//! Doku). [`LivenessMonitor::check`], vom periodischen Heartbeat-Tick
//! aufgerufen (`node::start`s `heartbeat_loop`), erkennt einen still
//! gestorbenen Worker daran, dass sich sein Zähler seit dem letzten Tick
//! nicht mehr bewegt hat.
//!
//! Rein additiv: ein Node, der keinen Worker registriert, bleibt in
//! seinem Verhalten unverändert (`check()` liefert dann immer
//! `(true, [])`) — kein bestehender Node-Typ musste für diese Änderung
//! angefasst werden.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Ein Worker-Eintrag: sein geteilter Zähler, der beim letzten `check()`
/// gesehene Wert, und ob er seit dem Registrieren noch keinen einzigen
/// `check()`-Durchlauf erlebt hat (`fresh`) — ein frisch registrierter
/// Worker hatte noch keine Zeit für seinen ersten Tick und gilt beim
/// nächsten `check()` deshalb unbedingt als lebendig, unabhängig vom
/// Zählerstand (s. `LivenessMonitor`-Doku).
struct Worker {
    counter: Arc<AtomicU64>,
    last_seen: u64,
    fresh: bool,
}

/// Sammelt benannte Worker-Heartbeats und meldet, welche seit dem
/// letzten `check()` nicht vorangekommen sind. Ein frisch registrierter
/// Worker gilt beim NÄCHSTEN `check()` automatisch als lebendig (sein
/// `last_seen` wird beim Registrieren mit dem aktuellen Zählerstand
/// vorbelegt) — ein `check()` unmittelbar nach dem Start meldet also nie
/// fälschlich einen gerade erst gestarteten Worker als hängend, selbst
/// wenn dieser seinen ersten Tick noch nicht geschafft hat.
#[derive(Default)]
pub struct LivenessMonitor {
    workers: Mutex<HashMap<String, Worker>>,
}

impl LivenessMonitor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registriert (oder ersetzt, bei Namenskollision) einen Worker.
    /// `name` erscheint 1:1 im Log, falls `check()` ihn als hängend
    /// meldet — sprechend wählen (z. B. `"audio-meter-reader:ch1"`).
    pub fn register(&self, name: impl Into<String>, counter: Arc<AtomicU64>) {
        let value = counter.load(Ordering::Relaxed);
        self.workers.lock().expect("lock poisoned").insert(
            name.into(),
            Worker {
                counter,
                last_seen: value,
                fresh: true,
            },
        );
    }

    /// Entfernt einen Worker (z. B. wenn sein Thread absichtlich beendet
    /// wurde — `omp-audio-mixer` entfernt Audio-Kanal-Zweige chirurgisch
    /// zur Laufzeit, `UMSETZUNG.md` C11) — ohne dies bliebe sein letzter
    /// gesehener Zählerstand für immer "hängend" und würde `status`
    /// dauerhaft fälschlich auf `"degraded"` ziehen.
    pub fn unregister(&self, name: &str) {
        self.workers.lock().expect("lock poisoned").remove(name);
    }

    /// Prüft alle registrierten Worker gegen ihren beim letzten Aufruf
    /// gesehenen Stand. Liefert `(alle_lebendig, namen_der_haengenden)`.
    pub fn check(&self) -> (bool, Vec<String>) {
        let mut workers = self.workers.lock().expect("lock poisoned");
        let mut stuck = Vec::new();
        for (name, worker) in workers.iter_mut() {
            let current = worker.counter.load(Ordering::Relaxed);
            if current == worker.last_seen && !worker.fresh {
                stuck.push(name.clone());
            }
            worker.last_seen = current;
            worker.fresh = false;
        }
        (stuck.is_empty(), stuck)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freshly_registered_worker_is_not_stuck_on_first_check() {
        let monitor = LivenessMonitor::new();
        monitor.register("w1", Arc::new(AtomicU64::new(0)));
        let (alive, stuck) = monitor.check();
        assert!(alive);
        assert!(stuck.is_empty());
    }

    #[test]
    fn advancing_counter_stays_alive_across_repeated_checks() {
        let monitor = LivenessMonitor::new();
        let counter = Arc::new(AtomicU64::new(0));
        monitor.register("w1", counter.clone());
        counter.fetch_add(1, Ordering::Relaxed);
        assert!(monitor.check().0);
        counter.fetch_add(1, Ordering::Relaxed);
        assert!(monitor.check().0);
    }

    #[test]
    fn stalled_counter_is_reported_stuck() {
        let monitor = LivenessMonitor::new();
        let counter = Arc::new(AtomicU64::new(0));
        monitor.register("w1", counter.clone());
        counter.fetch_add(1, Ordering::Relaxed);
        monitor.check(); // konsumiert den einen Tick
        let (alive, stuck) = monitor.check(); // kein weiterer Tick seither
        assert!(!alive);
        assert_eq!(stuck, vec!["w1".to_string()]);
    }

    #[test]
    fn unregistered_worker_is_not_reported() {
        let monitor = LivenessMonitor::new();
        monitor.register("w1", Arc::new(AtomicU64::new(0)));
        monitor.unregister("w1");
        let (alive, stuck) = monitor.check();
        assert!(alive);
        assert!(stuck.is_empty());
    }

    #[test]
    fn no_registered_workers_is_trivially_alive() {
        let monitor = LivenessMonitor::new();
        assert_eq!(monitor.check(), (true, Vec::new()));
    }
}
