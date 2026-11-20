//! Aufbewahrung (AppNote 0019): nur Segmente, die vollständig vor „jetzt − Offset“ enden, verschwinden — und nur in Flows,
//! die dieser Schreiber selbst aufnimmt.

use omp_tams::auth::Auth;
use omp_tams::client::{Client, ClientConfig, SegmentQuery};
use omp_tams::testserver::{Fake, FlowRec};
use omp_tams_writer::retention::{RetentionStats, run_once};
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
    run_once(&client, &reg, 3600, 10_000_000_000_000, &stats);
    assert_eq!(stats.runs.load(Ordering::Relaxed), 1);
    assert_eq!(stats.errors.load(Ordering::Relaxed), 0);
    let left = |id: &str| client.list_segments(id, &SegmentQuery::default(), 10).unwrap().into_iter().map(|s| s.object_id).collect::<Vec<_>>();
    assert_eq!(left(MINE), vec!["o2", "o3"]);
    assert_eq!(left(FOREIGN).len(), 3, "fremde Flows werden nie angefasst");
    // unbekannter (noch nicht angelegter) Flow ist kein Fehler
    let reg2 = FlowRegistry::new(Arc::new(Spool::open(dir.join("b"), 1 << 20).unwrap()), vec![FlowDef { flow_id: "cccccccc-3333-4333-8333-cccccccccccc".into(), body: json!({}), container: "video/mp2t".into() }]);
    run_once(&client, &reg2, 3600, 10_000_000_000_000, &stats);
    assert_eq!(stats.errors.load(Ordering::Relaxed), 0);
    // zu kurze Zeit seit der Epoche: nichts tun
    run_once(&client, &reg, 3600, 1_000_000_000, &stats);
    assert_eq!(left(MINE), vec!["o2", "o3"]);
    std::fs::remove_dir_all(&dir).ok();
}
