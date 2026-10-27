//! Raten-Kennzahlen eines Nodes (Audit 2026-10-23 M7: „keine Medien-KPIs“): ein Node registriert einen Zähler (z. B. Bilder, die seine Pipeline erzeugt hat); der SDK-Takt
//! für `omp.health.<id>` rechnet daraus die Rate je Sekunde und hängt sie als `kpis` an das Health-Ereignis. Der Orchestrator führt Mittel, Minimum und letzten Wert.
//! Der Zähler muss nur monoton steigen; die erste Messung nach dem Registrieren liefert keinen Wert (kein Bezugspunkt).

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

struct Entry {
    counter: Arc<AtomicU64>,
    last: u64,
    at: Instant,
}

#[derive(Default)]
pub struct RateKpis {
    map: Mutex<HashMap<String, Entry>>,
}

impl RateKpis {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registriert (oder ersetzt) eine Rate; `name` z. B. `"video_fps"`.
    pub fn register(&self, name: impl Into<String>, counter: Arc<AtomicU64>) {
        let last = counter.load(Ordering::Relaxed);
        self.map.lock().expect("lock poisoned").insert(name.into(), Entry { counter, last, at: Instant::now() });
    }

    pub fn unregister(&self, name: &str) {
        self.map.lock().expect("lock poisoned").remove(name);
    }

    /// Rate je Sekunde seit der letzten Messung (nur Einträge mit mindestens 0,5 s Abstand).
    pub fn sample(&self, now: Instant) -> BTreeMap<String, f64> {
        let mut out = BTreeMap::new();
        let mut map = self.map.lock().expect("lock poisoned");
        for (name, e) in map.iter_mut() {
            let dt = now.saturating_duration_since(e.at).as_secs_f64();
            if dt < 0.5 {
                continue;
            }
            let cur = e.counter.load(Ordering::Relaxed);
            let delta = cur.saturating_sub(e.last);
            out.insert(name.clone(), delta as f64 / dt);
            e.last = cur;
            e.at = now;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn rate_is_delta_per_second() {
        let k = RateKpis::new();
        let c = Arc::new(AtomicU64::new(0));
        k.register("video_fps", c.clone());
        let t0 = Instant::now();
        c.fetch_add(50, Ordering::Relaxed);
        let s = k.sample(t0 + Duration::from_secs(2));
        assert!((s["video_fps"] - 25.0).abs() < 0.01, "{s:?}");
        c.fetch_add(10, Ordering::Relaxed);
        let s = k.sample(t0 + Duration::from_secs(3));
        assert!((s["video_fps"] - 10.0).abs() < 0.5, "{s:?}");
    }

    #[test]
    fn too_short_interval_and_unregistered_give_nothing() {
        let k = RateKpis::new();
        let c = Arc::new(AtomicU64::new(0));
        k.register("a", c.clone());
        assert!(k.sample(Instant::now()).is_empty());
        k.unregister("a");
        assert!(k.sample(Instant::now() + Duration::from_secs(5)).is_empty());
    }

    #[test]
    fn stalled_counter_reports_zero() {
        let k = RateKpis::new();
        let c = Arc::new(AtomicU64::new(100));
        k.register("a", c);
        let s = k.sample(Instant::now() + Duration::from_secs(4));
        assert_eq!(s["a"], 0.0);
    }
}
