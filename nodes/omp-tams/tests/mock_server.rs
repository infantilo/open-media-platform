//! Prüfung gegen den **Mock-Server der Spezifikation** (Prism auf `api/TimeAddressableMediaStore.yaml`).
//!
//! Prism prüft jede Anfrage gegen die OpenAPI-Beschreibung (falsche Nutzlast → 422) und liefert Beispielantworten
//! der Spezifikation; so zeigt der Test, dass unsere **Anfragen** der Spezifikation entsprechen und unsere Typen
//! die **Beispielantworten** lesen können. Der Server hält keinen Zustand (kein Schreiben-dann-Lesen).
//!
//! Läuft nur, wenn `OMP_TAMS_MOCK_URL` gesetzt ist (z. B. `http://127.0.0.1:4010`), sonst wird übersprungen:
//! `prism mock -p 4010 api/TimeAddressableMediaStore.yaml` im Repository `bbc/tams`.

use omp_tams::auth::{Auth, Secret};
use omp_tams::client::{Client, ClientConfig, Deleted, Registered, RetryPolicy, SegmentQuery};
use omp_tams::time::TimeRange;
use omp_tams::types::*;

const FLOW: &str = "c6c72c78-1e7f-4cd0-9e5c-0cd4d3f6b8a1";

fn client() -> Option<Client> {
    let url = std::env::var("OMP_TAMS_MOCK_URL").ok()?;
    let mut cfg = ClientConfig::new(url, Auth::Bearer(Secret::new("irgendein-token").unwrap()));
    cfg.retry = RetryPolicy::none();
    Some(Client::new(cfg).unwrap())
}

#[test]
fn requests_conform_to_the_specification_and_examples_parse() {
    let Some(c) = client() else {
        eprintln!("OMP_TAMS_MOCK_URL nicht gesetzt — Prüfung gegen den Mock-Server übersprungen");
        return;
    };
    // Dienst: Die Beispielantwort der Spezifikation 8.2 nennt selbst `api_version: "1.0"` (veraltetes Beispiel).
    // Unsere Versionsprüfung (D-T4) lehnt sie deshalb zu Recht ab; die Antwort ist aber als ServiceInfo lesbar,
    // sonst wäre der Fehler ein Protokollfehler und keine Versionsablehnung.
    match c.service() {
        Err(omp_tams::client::Error::Version(msg)) => assert!(msg.contains("Hauptversion 1"), "{msg}"),
        other => panic!("erwartet Versionsablehnung wegen Beispiel-Version 1.0, war {other:?}"),
    }

    // Flow anlegen: Prism lehnt eine Nutzlast, die nicht zum Schema passt, mit 422 ab
    let flow = VideoFlowPut {
        id: FLOW.into(),
        source_id: "5f7c9d8e-2b1a-4c3d-8e4f-0a1b2c3d4e5f".into(),
        format: FORMAT_VIDEO.into(),
        codec: "video/h264".into(),
        container: CONTAINER_MPEGTS.into(),
        essence_parameters: VideoEssence { frame_width: 1920, frame_height: 1080, frame_rate: Some(Fraction { numerator: 50, denominator: 1 }), interlace_mode: Some("progressive".into()), ..Default::default() },
        label: Some("Studio A".into()),
        description: None,
        segment_duration: Some(Fraction { numerator: 2, denominator: 1 }),
        avg_bit_rate: Some(8000),
        max_bit_rate: Some(10000),
        tags: Default::default(),
    };
    c.put_flow(FLOW, &flow).expect("PUT /flows/{id}");
    let audio = AudioFlowPut {
        id: FLOW.into(),
        source_id: "5f7c9d8e-2b1a-4c3d-8e4f-0a1b2c3d4e5f".into(),
        format: FORMAT_AUDIO.into(),
        codec: "audio/aac".into(),
        container: CONTAINER_MPEGTS.into(),
        essence_parameters: AudioEssence { sample_rate: 48000, channels: 2, ..Default::default() },
        label: None,
        description: None,
        segment_duration: None,
        avg_bit_rate: None,
        max_bit_rate: None,
        tags: Default::default(),
    };
    c.put_flow(FLOW, &audio).expect("PUT audio flow");

    // Speicherplätze: Antwort der Spezifikation muss in StorageResponse passen
    let st = c.request_storage(FLOW, &StorageRequest { limit: Some(2), ..Default::default() }).expect("POST storage");
    assert!(!st.media_objects.is_empty());

    // Segment registrieren
    let post = SegmentPost {
        object_id: "obj-1".into(),
        timerange: "[1694429247:0_1694429249:0)".into(),
        ts_offset: Some("0:0".into()),
        object_timerange: None,
        last_duration: Some("0:20000000".into()),
        sample_offset: None,
        sample_count: None,
        key_frame_count: Some(1),
        init_object_id: None,
    };
    match c.register_segments(FLOW, std::slice::from_ref(&post)).expect("POST segments") {
        Registered::All | Registered::Partial(_) => {}
    }

    // Segmente lesen: die Antwort muss als Vec<Segment> lesbar sein (Prism liefert hier Platzhalterwerte wie
    // "string"; Zeiten sind deshalb nicht prüfbar — das tut der Testserver in tests/client.rs).
    let q = SegmentQuery { timerange: Some(TimeRange::parse("[0:0_100:0)").unwrap()), ..Default::default() };
    let page = c.segments_page(FLOW, &q, None).expect("GET segments");
    assert!(!page.segments.is_empty(), "Beispielantwort ohne Segmente");

    // Löschen und Webhook
    match c.delete_segments(FLOW, &TimeRange::parse("_1694429247:0)").unwrap()).expect("DELETE segments") {
        Deleted::Done | Deleted::Accepted { .. } => {}
    }
    let hook = WebhookPost { url: "https://node.example/hook".into(), events: vec!["flows/segments_added".into()], api_key_name: None, api_key_value: None, flow_ids: Some(vec![FLOW.into()]) };
    c.register_webhook(&hook).expect("POST webhooks");
}
