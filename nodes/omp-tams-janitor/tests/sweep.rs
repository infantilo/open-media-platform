use omp_tams::auth::Auth;
use omp_tams::client::{Client, ClientConfig, SegmentQuery};
use omp_tams::retention::parse_rfc3339_ns;
use omp_tams::testserver::{Fake, FlowRec};
use omp_tams_janitor::{Stats, sweep};
use serde_json::json;
use std::sync::atomic::Ordering;

fn id(n: u8) -> String {
    format!("{n:08x}-0000-4000-8000-{n:012x}")
}

#[test]
fn sweeps_only_tagged_flows_and_follows_each_flows_own_offset() {
    let fake = Fake::start();
    let now_unix = parse_rfc3339_ns("2026-11-20T12:00:00Z").unwrap();
    let now_tai: u64 = 10_000_000_000_000; // 10000 s
    let seg = |r: &str, o: &str| json!({"object_id": o, "timerange": r});
    {
        let mut st = fake.state.lock().unwrap();
        let mut add = |n: u8, tags: serde_json::Value, tr: &str, upd: &str, segs: Vec<serde_json::Value>| {
            st.flows.insert(id(n), FlowRec { json: json!({"id": id(n), "container": "video/mp2t", "tags": tags, "timerange": tr, "metadata_updated": upd, "segments_updated": upd}), read_only: false, segments: segs });
        };
        // 1: Segment-Retention 1 h → Grenze 6400 s: nur das alte Segment geht
        add(1, json!({"segment_retention_offset": "3600:0"}), "[1000:0_9992:0)", "2026-11-20T11:59:00Z", vec![seg("[1000:0_1002:0)", "a"), seg("[9990:0_9992:0)", "b")]);
        // 2: anderer Offset (2 h → Grenze −: 10000−7200 = 2800 s): das Segment bei 1000 s geht, bei 3000 s bleibt
        add(2, json!({"segment_retention_offset": "7200:0"}), "[1000:0_3002:0)", "2026-11-20T11:59:00Z", vec![seg("[1000:0_1002:0)", "c"), seg("[3000:0_3002:0)", "d")]);
        // 3: ohne Tag: nie anfassen, auch wenn uralt
        add(3, json!({}), "[1:0_2:0)", "2020-01-01T00:00:00Z", vec![seg("[1:0_2:0)", "e")]);
        // 4: Flow-Retention 1 h, 3 h unverändert → weg
        add(4, json!({"flow_retention_offset": "3600:0"}), "[1:0_2:0)", "2026-11-20T09:00:00Z", vec![]);
        // 5: leer, mit Tag, 2 Tage alt → weg (empty_flow_s = 24 h)
        add(5, json!({"flow_retention_offset": "864000:0"}), "()", "2026-11-18T00:00:00Z", vec![]);
        // 6: leer, ohne Tag → bleibt (nur getaggte Flows)
        add(6, json!({}), "()", "2026-11-18T00:00:00Z", vec![]);
    }
    let c = Client::new(ClientConfig::new(fake.api(), Auth::None)).unwrap();
    let stats = Stats::default();
    sweep(&c, now_tai, now_unix, 86_400, &stats);
    assert_eq!(stats.errors.load(Ordering::Relaxed), 0, "{:?}", stats.last_error.lock().unwrap());
    assert_eq!(stats.flows_seen.load(Ordering::Relaxed), 4, "nur Flows mit Tag");
    let left = |n: u8| c.list_segments(&id(n), &SegmentQuery::default(), 10).unwrap().into_iter().map(|s| s.object_id).collect::<Vec<_>>();
    assert_eq!(left(1), vec!["b"]);
    assert_eq!(left(2), vec!["d"]);
    assert_eq!(left(3), vec!["e"], "Flow ohne Tag bleibt unberührt");
    let st = fake.state.lock().unwrap();
    assert!(!st.flows.contains_key(&id(4)));
    assert!(!st.flows.contains_key(&id(5)));
    assert!(st.flows.contains_key(&id(6)), "leerer Flow ohne Tag bleibt");
    assert_eq!(stats.flows_deleted.load(Ordering::Relaxed), 2);
    drop(st);
    // zweiter Durchlauf ändert nichts mehr
    sweep(&c, now_tai, now_unix, 86_400, &stats);
    assert_eq!(stats.flows_deleted.load(Ordering::Relaxed), 2);
    assert_eq!(stats.sweeps.load(Ordering::Relaxed), 2);
}

#[test]
fn nothing_is_deleted_when_the_flow_list_cannot_be_read() {
    let fake = Fake::start();
    {
        let mut st = fake.state.lock().unwrap();
        st.flows.insert(id(1), FlowRec { json: json!({"id": id(1), "tags": {"segment_retention_offset": "1:0"}}), read_only: false, segments: vec![json!({"object_id": "a", "timerange": "[1:0_2:0)"})] });
        st.fail_next.push(("GET /tams/v8.2/flows".into(), 500));
        st.fail_next.push(("GET /tams/v8.2/flows".into(), 500));
        st.fail_next.push(("GET /tams/v8.2/flows".into(), 500));
        st.fail_next.push(("GET /tams/v8.2/flows".into(), 500));
    }
    let mut cfg = ClientConfig::new(fake.api(), Auth::None);
    cfg.retry = omp_tams::client::RetryPolicy::none();
    let c = Client::new(cfg).unwrap();
    let stats = Stats::default();
    sweep(&c, 10_000_000_000_000, 0, 0, &stats);
    assert!(stats.errors.load(Ordering::Relaxed) >= 1);
    assert_eq!(fake.state.lock().unwrap().flows[&id(1)].segments.len(), 1, "ohne Liste wird nichts gelöscht");
}
