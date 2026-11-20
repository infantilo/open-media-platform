//! `omp-tams-janitor` (Kapitel 105.6): Aufbewahrung als **Dauerläufer** (AppNote 0019, „Worker Client“).
//!
//! Der Worker findet seine Flows über die Tags `segment_retention_offset` und `flow_retention_offset`
//! (`GET /flows?tag_exists.<tag>=true`) und richtet sich nach dem Wert **jedes Flows** (der Offset darf nachträglich geändert
//! werden). Ein Flow ohne eines dieser Tags wird nie angefasst. Der Schreiber (`omp-tams-writer`) setzt die Tags, wenn
//! `OMP_TAMS_RETENTION_HOURS` bzw. `OMP_TAMS_FLOW_RETENTION_HOURS` gesetzt sind — das Profil `tams` des Aufnahme-Zeitplans
//! reicht sie durch. So überlebt die Aufbewahrung die kurzlebige Schreiber-Instanz je Sendung.
//!
//! Je Durchlauf und Flow: Segmente vor `jetzt − Offset` löschen; dann (frischer Stand des Flows) den ganzen Flow löschen, wenn
//! `max(metadata_updated, segments_updated) + flow_retention_offset ≤ jetzt`, oder — nur mit `empty_flow_s` — wenn er leer ist
//! und seit so langer Zeit unverändert (nur unter den Flows mit Tag).

use omp_tams::client::Client;
use omp_tams::retention::{FLOW_TAG, TAG, cutoff_range, empty_flow_expired, flow_expired, tag_offset_s};
use std::collections::BTreeSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_FLOWS: usize = 100_000;

#[derive(Default)]
pub struct Stats {
    pub sweeps: AtomicU64,
    pub flows_seen: AtomicU64,
    pub segment_deletes: AtomicU64,
    pub flows_deleted: AtomicU64,
    pub errors: AtomicU64,
    pub last_error: Mutex<String>,
}

impl Stats {
    fn fail(&self, what: &str, e: impl std::fmt::Display) {
        self.errors.fetch_add(1, Ordering::Relaxed);
        *self.last_error.lock().expect("lock poisoned") = format!("{what}: {e}");
    }
}

fn flow_id(f: &serde_json::Value) -> Option<&str> {
    f.get("id")?.as_str()
}

/// Ein Durchlauf. `empty_flow_s` = 0: leere Flows werden nicht aufgeräumt.
pub fn sweep(client: &Client, now_tai_ns: u64, now_unix_ns: i128, empty_flow_s: u64, stats: &Stats) {
    let mut flows: Vec<serde_json::Value> = Vec::new();
    let mut seen_ids = BTreeSet::new();
    for tag in [TAG, FLOW_TAG] {
        match client.list_flows_with_tag(tag, MAX_FLOWS) {
            Ok(list) => {
                for f in list {
                    if let Some(id) = flow_id(&f)
                        && seen_ids.insert(id.to_string())
                    {
                        flows.push(f);
                    }
                }
            }
            Err(e) => {
                stats.fail(&format!("Flows mit Tag {tag} abfragen"), e);
                stats.sweeps.fetch_add(1, Ordering::Relaxed);
                return; // ohne vollständige Liste nichts löschen
            }
        }
    }
    stats.flows_seen.store(flows.len() as u64, Ordering::Relaxed);
    for f in &flows {
        let Some(id) = flow_id(f) else { continue };
        if let Some(off) = tag_offset_s(f, TAG)
            && let Some(range) = cutoff_range(now_tai_ns, off)
        {
            match client.delete_segments(id, &range) {
                Ok(_) => {
                    stats.segment_deletes.fetch_add(1, Ordering::Relaxed);
                }
                Err(e) if e.status() == Some(404) => continue,
                Err(e) => stats.fail(&format!("Segmente von {id} löschen"), e),
            }
        }
        // Ganze Flows: mit frischem Stand (Offset und Änderungszeiten können sich seit der Liste geändert haben)
        let fresh = match client.get_flow(id) {
            Ok(v) => v,
            Err(e) if e.status() == Some(404) => continue,
            Err(e) => {
                stats.fail(&format!("Flow {id} lesen"), e);
                continue;
            }
        };
        let due = flow_expired(&fresh, now_unix_ns) || (empty_flow_s > 0 && empty_flow_expired(&fresh, empty_flow_s, now_unix_ns));
        if due {
            match client.delete_flow(id) {
                Ok(_) => {
                    stats.flows_deleted.fetch_add(1, Ordering::Relaxed);
                }
                Err(e) if e.status() == Some(404) => {}
                Err(e) => stats.fail(&format!("Flow {id} löschen"), e),
            }
        }
    }
    stats.sweeps.fetch_add(1, Ordering::Relaxed);
}
