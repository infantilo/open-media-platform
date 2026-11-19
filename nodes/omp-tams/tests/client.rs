//! Der Client gegen den Testserver (`tests/common`), der die Regeln der Spezifikation 8.2 nachstellt.

use omp_tams::testserver::Fake;
use omp_tams::auth::{Auth, Secret};
use omp_tams::client::{Client, ClientConfig, Deleted, Error, Registered, RetryPolicy, SegmentQuery};
use omp_tams::time::TimeRange;
use omp_tams::types::*;
use std::time::Duration;

const FLOW: &str = "11111111-1111-4111-8111-111111111111";
const SOURCE: &str = "22222222-2222-4222-8222-222222222222";

fn client(f: &Fake, auth: Auth) -> Client {
    let mut cfg = ClientConfig::new(f.api(), auth);
    cfg.retry = RetryPolicy { attempts: 3, base_delay: Duration::from_millis(5), max_delay: Duration::from_millis(20) };
    cfg.timeout = Duration::from_secs(5);
    Client::new(cfg).unwrap()
}

fn flow() -> VideoFlowPut {
    VideoFlowPut {
        id: FLOW.into(),
        source_id: SOURCE.into(),
        format: FORMAT_VIDEO.into(),
        codec: "video/h264".into(),
        container: CONTAINER_MPEGTS.into(),
        essence_parameters: VideoEssence { frame_width: 1920, frame_height: 1080, frame_rate: Some(Fraction { numerator: 50, denominator: 1 }), ..Default::default() },
        label: Some("Test".into()),
        description: None,
        segment_duration: Some(Fraction { numerator: 2, denominator: 1 }),
        avg_bit_rate: None,
        max_bit_rate: None,
        tags: Default::default(),
    }
}

/// Ein Segment schreiben: Platz reservieren, hochladen, registrieren.
fn write_segment(c: &Client, range: &str, payload: &[u8]) -> Registered {
    let slots = c.request_storage(FLOW, &StorageRequest { limit: Some(1), ..Default::default() }).unwrap();
    let slot = &slots.media_objects[0];
    c.upload_object(slot, CONTAINER_MPEGTS, payload).unwrap();
    let post = SegmentPost {
        object_id: slot.object_id.clone(),
        timerange: range.into(),
        ts_offset: Some("0:0".into()),
        object_timerange: None,
        last_duration: None,
        sample_offset: None,
        sample_count: None,
        key_frame_count: Some(1),
        init_object_id: None,
    };
    c.register_segments(FLOW, &[post]).unwrap()
}

#[test]
fn service_and_version_rules() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    let (info, check) = c.service().unwrap();
    assert_eq!(info.api_version, "8.2");
    assert_eq!(info.min_object_timeout, "3600:0");
    assert_eq!(check, omp_tams::VersionCheck::Ok);

    f.state.lock().unwrap().api_version = "8.5".into();
    assert_eq!(c.service().unwrap().1, omp_tams::VersionCheck::NewerMinor);

    f.state.lock().unwrap().api_version = "9.0".into();
    assert!(matches!(c.service(), Err(Error::Version(_))));
    f.state.lock().unwrap().api_version = "7.4".into();
    assert!(matches!(c.service(), Err(Error::Version(_))));
}

#[test]
fn write_then_read_round_trip() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    assert!(c.put_flow(FLOW, &flow()).unwrap(), "erstes PUT legt an (201)");
    assert!(!c.put_flow(FLOW, &flow()).unwrap(), "zweites PUT aktualisiert (204)");

    assert_eq!(write_segment(&c, "[10:0_12:0)", b"AAAA"), Registered::All);
    assert_eq!(write_segment(&c, "[12:0_14:0)", b"BBBB"), Registered::All);

    let segs = c.list_segments(FLOW, &SegmentQuery::default(), 100).unwrap();
    assert_eq!(segs.len(), 2);
    assert_eq!(segs[0].timerange, "[10:0_12:0)");
    let data = c.download_object(&segs[0].get_urls[0].url, 1024).unwrap();
    assert_eq!(data, b"AAAA");
    // Zeitfilter: nur das zweite Segment
    let q = SegmentQuery { timerange: Some(TimeRange::parse("[13:0_20:0)").unwrap()), ..Default::default() };
    let segs = c.list_segments(FLOW, &q, 100).unwrap();
    assert_eq!(segs.len(), 1);
    assert_eq!(segs[0].timerange, "[12:0_14:0)");
    // das Object bekam den vom Dienst genannten Inhaltstyp
    let st = f.state.lock().unwrap();
    assert_eq!(st.objects.values().next().unwrap().1, "video/mp2t");
}

#[test]
fn overlap_is_rejected_by_the_store() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    c.put_flow(FLOW, &flow()).unwrap();
    assert_eq!(write_segment(&c, "[10:0_12:0)", b"A"), Registered::All);
    match write_segment(&c, "[11:0_13:0)", b"B") {
        Registered::Partial(bf) => {
            assert_eq!(bf.failed_segments.len(), 1);
            assert_eq!(bf.failed_segments[0].timerange.as_deref(), Some("[11:0_13:0)"));
        }
        other => panic!("erwartet Teilfehler, war {other:?}"),
    }
    // direkt anschließend ist erlaubt
    assert_eq!(write_segment(&c, "[12:0_14:0)", b"C"), Registered::All);
}

#[test]
fn batch_reports_only_the_failed_segments() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    c.put_flow(FLOW, &flow()).unwrap();
    let slots = c.request_storage(FLOW, &StorageRequest { limit: Some(3), ..Default::default() }).unwrap().media_objects;
    // nur zwei hochladen: das dritte Object bleibt unbenutzt → Registrierung scheitert
    c.upload_object(&slots[0], "video/mp2t", b"1").unwrap();
    c.upload_object(&slots[1], "video/mp2t", b"2").unwrap();
    let mk = |i: usize, r: &str| SegmentPost { object_id: slots[i].object_id.clone(), timerange: r.into(), ts_offset: None, object_timerange: None, last_duration: None, sample_offset: None, sample_count: None, key_frame_count: None, init_object_id: None };
    let res = c.register_segments(FLOW, &[mk(0, "[0:0_2:0)"), mk(2, "[2:0_4:0)"), mk(1, "[4:0_6:0)")]).unwrap();
    match res {
        Registered::Partial(bf) => {
            assert_eq!(bf.failed_segments.len(), 1);
            assert_eq!(bf.failed_segments[0].object_id, slots[2].object_id);
        }
        other => panic!("{other:?}"),
    }
    // die beiden guten sind angelegt (Verarbeitung läuft nach Fehlern weiter)
    assert_eq!(c.list_segments(FLOW, &SegmentQuery::default(), 10).unwrap().len(), 2);
}

#[test]
fn read_only_flow_is_forbidden() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    c.put_flow(FLOW, &flow()).unwrap();
    f.state.lock().unwrap().flows.get_mut(FLOW).unwrap().read_only = true;
    assert_eq!(c.put_flow(FLOW, &flow()).unwrap_err().status(), Some(403));
    assert_eq!(c.request_storage(FLOW, &StorageRequest::default()).unwrap_err().status(), Some(403));
    assert_eq!(c.delete_segments(FLOW, &TimeRange::ETERNITY).unwrap_err().status(), Some(403));
    assert_eq!(c.register_segments(FLOW, &[SegmentPost { object_id: "x".into(), timerange: "[0:0_1:0)".into(), ts_offset: None, object_timerange: None, last_duration: None, sample_offset: None, sample_count: None, key_frame_count: None, init_object_id: None }]).unwrap_err().status(), Some(403));
    // 403 ist ein Fehler des Aufrufers und wird nicht wiederholt: je Aufruf genau eine Anfrage
    let n = |k: &str| f.hits(k);
    let before = n("PUT flows/*/") + n("POST flows/*/storage") + n("DELETE flows/*/segments") + n("POST flows/*/segments");
    let _ = c.put_flow(FLOW, &flow());
    let _ = c.request_storage(FLOW, &StorageRequest::default());
    let _ = c.delete_segments(FLOW, &TimeRange::ETERNITY);
    let after = n("PUT flows/*/") + n("POST flows/*/storage") + n("DELETE flows/*/segments") + n("POST flows/*/segments");
    assert_eq!(after - before, 3);
}

#[test]
fn unknown_flow_is_404_with_the_service_message() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    let e = c.request_storage("33333333-3333-4333-8333-333333333333", &StorageRequest::default()).unwrap_err();
    assert_eq!(e.status(), Some(404));
    assert!(e.to_string().contains("Flow unbekannt"), "{e}");
}

#[test]
fn paging_follows_link_and_collects_everything() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    c.put_flow(FLOW, &flow()).unwrap();
    for i in 0..7 {
        assert_eq!(write_segment(&c, &format!("[{}:0_{}:0)", i * 2, i * 2 + 2), b"x"), Registered::All);
    }
    f.state.lock().unwrap().page_size = 3;
    let all = c.list_segments(FLOW, &SegmentQuery::default(), 100).unwrap();
    assert_eq!(all.len(), 7);
    let starts: Vec<&str> = all.iter().map(|s| s.timerange.as_str()).collect();
    assert_eq!(starts[0], "[0:0_2:0)");
    assert_eq!(starts[6], "[12:0_14:0)");
    // eine einzelne Seite liefert nur 3 und eine Folgeadresse
    let p = c.segments_page(FLOW, &SegmentQuery::default(), None).unwrap();
    assert_eq!((p.segments.len(), p.next.is_some()), (3, true));
    // Zeitfilter bleibt über die Seiten erhalten
    let q = SegmentQuery { timerange: Some(TimeRange::parse("[4:0_12:0)").unwrap()), ..Default::default() };
    assert_eq!(c.list_segments(FLOW, &q, 100).unwrap().len(), 4);
    // Obergrenze
    assert!(matches!(c.list_segments(FLOW, &SegmentQuery::default(), 5), Err(Error::Protocol(_))));
    // umgekehrte Reihenfolge
    let q = SegmentQuery { reverse_order: true, ..Default::default() };
    assert_eq!(c.list_segments(FLOW, &q, 100).unwrap()[0].timerange, "[12:0_14:0)");
}

#[test]
fn next_page_on_a_foreign_origin_is_refused_and_no_token_leaks() {
    let f = Fake::start();
    f.state.lock().unwrap().expect_bearer = Some("geheim-token".into());
    let c = client(&f, Auth::Bearer(Secret::new("geheim-token").unwrap()));
    c.put_flow(FLOW, &flow()).unwrap();
    for i in 0..3 {
        write_segment(&c, &format!("[{}:0_{}:0)", i, i + 1), b"x");
    }
    {
        let mut s = f.state.lock().unwrap();
        s.page_size = 1;
        s.link_override = Some("http://127.0.0.1:1/flows/x/segments?page=1".into());
    }
    let e = c.list_segments(FLOW, &SegmentQuery::default(), 100).unwrap_err();
    assert!(matches!(e, Error::Protocol(_)), "{e}");
    assert!(e.to_string().contains("fremden Ursprung"));
}

#[test]
fn delete_removes_only_fully_covered_segments() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    c.put_flow(FLOW, &flow()).unwrap();
    for i in 0..4 {
        write_segment(&c, &format!("[{}:0_{}:0)", i * 2, i * 2 + 2), b"x");
    }
    // Bereich [0:0_5:0) deckt die ersten beiden Segmente vollständig ab, das dritte nur zur Hälfte
    assert_eq!(c.delete_segments(FLOW, &TimeRange::parse("[0:0_5:0)").unwrap()).unwrap(), Deleted::Done);
    let left = c.list_segments(FLOW, &SegmentQuery::default(), 100).unwrap();
    assert_eq!(left.iter().map(|s| s.timerange.as_str()).collect::<Vec<_>>(), ["[4:0_6:0)", "[6:0_8:0)"]);
    // „bis vor 5 s“ als offener Anfang (Aufbewahrung, AppNote 0010)
    assert_eq!(c.delete_segments(FLOW, &TimeRange::parse("_6:0)").unwrap()).unwrap(), Deleted::Done);
    assert_eq!(c.list_segments(FLOW, &SegmentQuery::default(), 100).unwrap().len(), 1);
}

#[test]
fn bearer_basic_and_url_token() {
    // Bearer
    let f = Fake::start();
    f.state.lock().unwrap().expect_bearer = Some("tok-b".into());
    assert_eq!(client(&f, Auth::None).service().unwrap_err().status(), Some(401));
    assert_eq!(client(&f, Auth::Bearer(Secret::new("falsch").unwrap())).service().unwrap_err().status(), Some(401));
    assert!(client(&f, Auth::Bearer(Secret::new("tok-b").unwrap())).service().is_ok());
    // Basic (Beispiel RFC 7617)
    let f = Fake::start();
    f.state.lock().unwrap().expect_basic = Some("YWxhZGRpbjpvcGVuIHNlc2FtZQ==".into());
    let a = Auth::from_parts("basic", Some("aladdin"), Some(Secret::new("open sesame").unwrap())).unwrap();
    assert!(client(&f, a).service().is_ok());
    assert_eq!(client(&f, Auth::None).service().unwrap_err().status(), Some(401));
    // Token in der URL
    let f = Fake::start();
    f.state.lock().unwrap().expect_url_token = Some("tok-u".into());
    assert!(client(&f, Auth::UrlToken(Secret::new("tok-u").unwrap())).service().is_ok());
    assert_eq!(client(&f, Auth::UrlToken(Secret::new("nein").unwrap())).service().unwrap_err().status(), Some(401));
}

#[test]
fn url_token_also_flows_through_paging_and_object_urls_on_same_origin() {
    let f = Fake::start();
    {
        let mut s = f.state.lock().unwrap();
        s.expect_url_token = Some("tok-u".into());
        s.objects_need_auth = true;
        s.page_size = 2;
    }
    let c = client(&f, Auth::UrlToken(Secret::new("tok-u").unwrap()));
    c.put_flow(FLOW, &flow()).unwrap();
    for i in 0..3 {
        assert_eq!(write_segment(&c, &format!("[{}:0_{}:0)", i, i + 1), b"data"), Registered::All);
    }
    let segs = c.list_segments(FLOW, &SegmentQuery::default(), 10).unwrap();
    assert_eq!(segs.len(), 3);
    assert_eq!(c.download_object(&segs[0].get_urls[0].url, 100).unwrap(), b"data");
}

#[test]
fn credentials_are_never_sent_to_a_foreign_origin() {
    let f = Fake::start(); // „Fremder“ Ursprung: ein zweiter Server
    let other = Fake::start();
    other.state.lock().unwrap().issued.insert("o1".into());
    other.state.lock().unwrap().objects.insert("o1".into(), (b"fremd".to_vec(), "video/mp2t".into()));
    f.state.lock().unwrap().expect_bearer = Some("tok-b".into());
    let c = client(&f, Auth::Bearer(Secret::new("tok-b").unwrap()));
    let data = c.download_object(&format!("{}/objects/o1", other.base), 100).unwrap();
    assert_eq!(data, b"fremd");
    let seen = other.state.lock().unwrap().seen_auth.clone();
    assert!(!seen.is_empty() && seen.iter().all(|(_, a)| a.is_none()), "Authorization an fremden Ursprung gesendet: {seen:?}");
}

#[test]
fn transient_errors_are_retried_with_backoff_but_not_client_errors() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    c.put_flow(FLOW, &flow()).unwrap();
    let slots = c.request_storage(FLOW, &StorageRequest { limit: Some(1), ..Default::default() }).unwrap();
    // Hochladen: zweimal 503, dann Erfolg (3 Versuche erlaubt)
    f.state.lock().unwrap().fail_next = vec![("PUT /objects/".into(), 503), ("PUT /objects/".into(), 503)];
    c.upload_object(&slots.media_objects[0], "video/mp2t", b"zz").unwrap();
    assert_eq!(f.hits("PUT objects/*"), 3);
    // dauerhaft 503: nach drei Versuchen Fehler
    let slots = c.request_storage(FLOW, &StorageRequest { limit: Some(1), ..Default::default() }).unwrap();
    f.state.lock().unwrap().fail_next = vec![("PUT /objects/".into(), 503); 5];
    let before = f.hits("PUT objects/*");
    let e = c.upload_object(&slots.media_objects[0], "video/mp2t", b"zz").unwrap_err();
    assert_eq!(e.status(), Some(503));
    assert_eq!(f.hits("PUT objects/*") - before, 3);
    f.state.lock().unwrap().fail_next.clear();
    // 403 (nicht reserviert) wird nicht wiederholt
    let bogus = MediaObjectSlot { object_id: "nicht-da".into(), put_url: HttpRequest { url: format!("{}/objects/nicht-da", f.base), content_type: None, headers: Default::default() }, presigned: false };
    let before = f.hits("PUT objects/*");
    assert_eq!(c.upload_object(&bogus, "video/mp2t", b"x").unwrap_err().status(), Some(403));
    assert_eq!(f.hits("PUT objects/*") - before, 1);
}

#[test]
fn registering_segments_is_not_retried_by_the_client() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    c.put_flow(FLOW, &flow()).unwrap();
    let slots = c.request_storage(FLOW, &StorageRequest { limit: Some(1), ..Default::default() }).unwrap();
    c.upload_object(&slots.media_objects[0], "video/mp2t", b"1").unwrap();
    f.state.lock().unwrap().fail_next = vec![("POST /tams/v8.2/flows/".into(), 503)];
    let post = SegmentPost { object_id: slots.media_objects[0].object_id.clone(), timerange: "[0:0_2:0)".into(), ts_offset: None, object_timerange: None, last_duration: None, sample_offset: None, sample_count: None, key_frame_count: None, init_object_id: None };
    let e = c.register_segments(FLOW, std::slice::from_ref(&post)).unwrap_err();
    assert!(e.is_retryable());
    assert_eq!(f.hits("POST flows/*/segments"), 1, "kein stilles Wiederholen");
    // der Aufrufer darf es selbst noch einmal versuchen
    assert_eq!(c.register_segments(FLOW, &[post]).unwrap(), Registered::All);
}

#[test]
fn webhook_registration() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    let hook = WebhookPost { url: "https://node.example/hook".into(), events: vec!["flows/segments_added".into()], api_key_name: Some("X-Key".into()), api_key_value: Some("v".into()), flow_ids: Some(vec![FLOW.into()]) };
    c.register_webhook(&hook).unwrap();
    assert_eq!(f.state.lock().unwrap().webhooks.len(), 1);
    // Nutzlast wie in der Spezifikation: Ereignisse und Schlüssel kommen beim Dienst an
    let got = f.state.lock().unwrap().webhooks[0].clone();
    assert_eq!(got["events"][0], "flows/segments_added");
    assert_eq!(got["api_key_name"], "X-Key");
    assert_eq!(got["flow_ids"][0], FLOW);
    // Dienst ohne Webhooks (404): Fehler mit Status, kein Absturz
    let bad_url = Client::new(ClientConfig::new(format!("{}/anderswo", f.base), Auth::None)).unwrap();
    assert_eq!(bad_url.register_webhook(&hook).unwrap_err().status(), Some(404));
}

#[test]
fn transport_error_message_carries_no_token() {
    // nichts hört auf diesem Port
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    let mut cfg = ClientConfig::new(format!("http://127.0.0.1:{port}/tams/v8.2"), Auth::UrlToken(Secret::new("super-geheim-xyz").unwrap()));
    cfg.retry = RetryPolicy::none();
    cfg.timeout = Duration::from_secs(2);
    let c = Client::new(cfg).unwrap();
    let e = c.service().unwrap_err();
    assert!(matches!(e, Error::Transport(_)), "{e}");
    assert!(!e.to_string().contains("geheim"), "{e}");
    assert!(!format!("{c:?}").contains("geheim"));
}

#[test]
fn response_size_is_capped() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    c.put_flow(FLOW, &flow()).unwrap();
    write_segment(&c, "[0:0_2:0)", &vec![7u8; 4096]);
    let segs = c.list_segments(FLOW, &SegmentQuery::default(), 10).unwrap();
    assert!(c.download_object(&segs[0].get_urls[0].url, 100).is_err(), "Object größer als erlaubt muss abgelehnt werden");
    assert_eq!(c.download_object(&segs[0].get_urls[0].url, 8192).unwrap().len(), 4096);
}

#[test]
fn invalid_ids_never_reach_the_network() {
    let f = Fake::start();
    let c = client(&f, Auth::None);
    for bad in ["../service", "a/b", "x?y=1", ""] {
        assert!(matches!(c.request_storage(bad, &StorageRequest::default()), Err(Error::Config(_))));
        assert!(matches!(c.segments_page(bad, &SegmentQuery::default(), None), Err(Error::Config(_))));
    }
    assert!(f.state.lock().unwrap().hits.is_empty());
}
