//! Aufbewahrung (AppNote 0019): nur Segmente, die vollständig vor „jetzt − Offset“ enden, verschwinden — und nur in Flows,
//! die dieser Schreiber selbst aufnimmt.

use omp_tams::auth::Auth;
use omp_tams::client::{Client, ClientConfig, SegmentQuery};
use omp_tams::testserver::{Fake, FlowRec};
use omp_tams_writer::retention::{Policy, RetentionStats, run_once};
use omp_tams_writer::spool::Spool;
use omp_tams_writer::uploader::{FlowDef, FlowRegistry};
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::Ordering;

const MINE: &str = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const FOREIGN: &str = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

fn seg(range: &str, id: &str) -> serde_json::Value {
    json!({"object_id": id, "timerange": range})
}

#[test]
fn only_old_segments_of_own_flows_are_deleted() {
    let dir = std::env::temp_dir().join(format!("omp-tams-ret-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let spool = Arc::new(Spool::open(&dir, 1 << 20).unwrap());
    let fake = Fake::start();
    let segs = || vec![seg("[1000:0_1002:0)", "o1"), seg("[7000:0_7002:0)", "o2"), seg("[9990:0_9992:0)", "o3")];
    {
        let mut st = fake.state.lock().unwrap();
        for id in [MINE, FOREIGN] {
            st.flows.insert(id.into(), FlowRec { json: json!({"id": id, "container": "video/mp2t"}), read_only: false, segments: segs() });
        }
    }
    let reg = FlowRegistry::new(spool.clone(), vec![FlowDef { flow_id: MINE.into(), body: json!({"id": MINE}), container: "video/mp2t".into() }]);
    let client = Client::new(ClientConfig::new(fake.api(), Auth::None)).unwrap();
    let stats = RetentionStats::default();
    // jetzt = 10000 s, Aufbewahrung 1 h = 3600 s → Grenze 6400 s: nur [1000_1002) ist alt genug
    run_once(&client, &reg, Policy { segment_s: 3600, ..Default::default() }, 10_000_000_000_000, 0, &stats);
    assert_eq!(stats.runs.load(Ordering::Relaxed), 1);
    assert_eq!(stats.errors.load(Ordering::Relaxed), 0);
    let left = |id: &str| client.list_segments(id, &SegmentQuery::default(), 10).unwrap().into_iter().map(|s| s.object_id).collect::<Vec<_>>();
    assert_eq!(left(MINE), vec!["o2", "o3"]);
    assert_eq!(left(FOREIGN).len(), 3, "fremde Flows werden nie angefasst");
    // unbekannter (noch nicht angelegter) Flow ist kein Fehler
    let reg2 = FlowRegistry::new(Arc::new(Spool::open(dir.join("b"), 1 << 20).unwrap()), vec![FlowDef { flow_id: "cccccccc-3333-4333-8333-cccccccccccc".into(), body: json!({}), container: "video/mp2t".into() }]);
    run_once(&client, &reg2, Policy { segment_s: 3600, ..Default::default() }, 10_000_000_000_000, 0, &stats);
    assert_eq!(stats.errors.load(Ordering::Relaxed), 0);
    // zu kurze Zeit seit der Epoche: nichts tun
    run_once(&client, &reg, Policy { segment_s: 3600, ..Default::default() }, 1_000_000_000, 0, &stats);
    assert_eq!(left(MINE), vec!["o2", "o3"]);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn whole_flows_and_empty_flows_follow_their_rules() {
    use omp_tams::retention::parse_rfc3339_ns;
    const OLD: &str = "dddddddd-4444-4444-8444-dddddddddddd";
    const EMPTY: &str = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
    const FRESH: &str = "ffffffff-6666-4666-8666-ffffffffffff";
    let dir = std::env::temp_dir().join(format!("omp-tams-ret2-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let spool = Arc::new(Spool::open(&dir, 1 << 20).unwrap());
    let fake = Fake::start();
    let now = parse_rfc3339_ns("2026-11-20T12:00:00Z").unwrap();
    {
        let mut st = fake.state.lock().unwrap();
        let mut add = |id: &str, tags: serde_json::Value, tr: &str, upd: &str| {
            st.flows.insert(id.into(), FlowRec { json: json!({"id": id, "container": "video/mp2t", "tags": tags, "timerange": tr, "metadata_updated": upd, "segments_updated": upd}), read_only: false, segments: vec![] });
        };
        add(OLD, json!({"flow_retention_offset": "3600:0"}), "[1:0_2:0)", "2026-11-20T09:00:00Z"); // 3 h alt, Offset 1 h → fällig
        add(EMPTY, json!({}), "()", "2026-11-18T00:00:00Z"); // leer, 2 Tage alt → fällig bei 24 h
        add(FRESH, json!({"flow_retention_offset": "3600:0"}), "[1:0_2:0)", "2026-11-20T11:45:00Z"); // 15 min alt → bleibt
    }
    let defs = [OLD, EMPTY, FRESH].map(|id| FlowDef { flow_id: id.into(), body: json!({"id": id}), container: "video/mp2t".into() });
    let reg = FlowRegistry::new(spool.clone(), defs.into());
    let client = Client::new(ClientConfig::new(fake.api(), Auth::None)).unwrap();
    let stats = RetentionStats::default();
    run_once(&client, &reg, Policy { segment_s: 0, flow_s: 3600, empty_flow_s: 86_400 }, 0, now, &stats);
    let st = fake.state.lock().unwrap();
    assert!(!st.flows.contains_key(OLD), "abgelaufener Flow muss weg sein");
    assert!(!st.flows.contains_key(EMPTY), "alter leerer Flow muss weg sein");
    assert!(st.flows.contains_key(FRESH), "frischer Flow bleibt");
    assert_eq!(stats.flows_deleted.load(Ordering::Relaxed), 2);
    assert_eq!(stats.errors.load(Ordering::Relaxed), 0);
    drop(st);
    // Ohne Regeln passiert mit Flows nichts
    let reg2 = FlowRegistry::new(Arc::new(Spool::open(dir.join("b"), 1 << 20).unwrap()), vec![FlowDef { flow_id: FRESH.into(), body: json!({}), container: "video/mp2t".into() }]);
    run_once(&client, &reg2, Policy::default(), 0, now, &stats);
    assert!(fake.state.lock().unwrap().flows.contains_key(FRESH));
    std::fs::remove_dir_all(&dir).ok();
}
