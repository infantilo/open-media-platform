//! Testserver (Feature `testserver`), der die TAMS-API 8.2 nachstellt (nur, was der Client nutzt). Kein Ersatz für die Prüfung gegen
//! eine echte Installation, aber er setzt die in der Spezifikation genannten Regeln durch: keine Überlappung (400),
//! schreibgeschützter Flow (403), Stapel mit Fehlerliste (200), Seitenabruf (`Link`, `X-Paging-NextKey`),
//! nur reservierte Objects dürfen hochgeladen und registriert werden, Anmeldung je Art.
#![allow(dead_code)]

use crate::time::TimeRange;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::thread;
use tiny_http::{Header, Method, Response, Server};

#[derive(Default)]
pub struct State {
    pub api_version: String,
    pub page_size: usize,
    pub flows: BTreeMap<String, FlowRec>,
    pub issued: BTreeSet<String>,
    pub objects: BTreeMap<String, (Vec<u8>, String)>,
    pub webhooks: Vec<Value>,
    pub next_id: u64,
    /// Erwartete Anmeldung (leer = keine).
    pub expect_bearer: Option<String>,
    pub expect_basic: Option<String>,
    pub expect_url_token: Option<String>,
    /// Müssen auch Objekt-Adressen angemeldet sein?
    pub objects_need_auth: bool,
    /// Die nächsten Anfragen, deren „METHODE /pfad-anfang“ passt, bekommen diesen Status.
    pub fail_next: Vec<(String, u16)>,
    /// `Link`-Adresse der Folgeseite durch diese ersetzen (Test: fremder Ursprung).
    pub link_override: Option<String>,
    /// Zähler je „METHODE /pfad-anfang“ (für Wiederholungs-Tests).
    pub hits: BTreeMap<String, u32>,
    /// Alle empfangenen Authorization-Header und URLs (zur Prüfung, dass nichts an Fremde geht).
    pub seen_auth: Vec<(String, Option<String>)>,
}

pub struct FlowRec {
    pub json: Value,
    pub read_only: bool,
    pub segments: Vec<Value>,
}

pub struct Fake {
    pub base: String,
    pub state: Arc<Mutex<State>>,
}

impl Fake {
    pub fn start() -> Fake {
        let server = Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        let base = format!("http://{addr}");
        let state = Arc::new(Mutex::new(State { api_version: "8.2".into(), page_size: 1000, ..Default::default() }));
        let (st, b) = (state.clone(), base.clone());
        thread::spawn(move || {
            for mut req in server.incoming_requests() {
                let mut body = Vec::new();
                let _ = std::io::Read::read_to_end(req.as_reader(), &mut body);
                let method = req.method().clone();
                let url = req.url().to_string();
                let auth = req.headers().iter().find(|h| h.field.equiv("Authorization")).map(|h| h.value.to_string());
                let ctype = req.headers().iter().find(|h| h.field.equiv("Content-Type")).map(|h| h.value.to_string());
                let out = handle(&st, &b, &method, &url, auth, ctype, &body);
                let mut resp = Response::from_data(out.body).with_status_code(out.status);
                for (k, v) in out.headers {
                    resp.add_header(Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap());
                }
                let _ = req.respond(resp);
            }
        });
        Fake { base, state }
    }
    pub fn api(&self) -> String {
        format!("{}/tams/v8.2", self.base)
    }
    pub fn hits(&self, key: &str) -> u32 {
        *self.state.lock().unwrap().hits.get(key).unwrap_or(&0)
    }
}

struct Out {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
fn out(status: u16, v: Value) -> Out {
    Out { status, headers: vec![("Content-Type".into(), "application/json".into())], body: serde_json::to_vec(&v).unwrap() }
}
fn empty(status: u16) -> Out {
    Out { status, headers: vec![], body: vec![] }
}
fn err(status: u16, summary: &str) -> Out {
    out(status, json!({"type": "error", "summary": summary, "time": "2026-11-19T00:00:00Z"}))
}

fn query_of(url: &str) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    if let Some((_, q)) = url.split_once('?') {
        for p in q.split('&') {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            m.insert(k.to_string(), unpct(v));
        }
    }
    m
}
fn unpct(s: &str) -> String {
    let b = s.as_bytes();
    let mut o = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 3 <= b.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            o.push(v);
            i += 3;
            continue;
        }
        o.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&o).into_owned()
}

fn handle(st: &Arc<Mutex<State>>, base: &str, method: &Method, url: &str, auth: Option<String>, ctype: Option<String>, body: &[u8]) -> Out {
    let mut s = st.lock().unwrap();
    let path = url.split('?').next().unwrap().to_string();
    let q = query_of(url);
    let m = method.as_str().to_string();
    let key = format!("{m} {path}");
    s.seen_auth.push((key.clone(), auth.clone()));
    *s.hits.entry(format!("{m} {}", route_prefix(&path))).or_insert(0) += 1;

    // eingespielte Fehler
    if let Some(i) = s.fail_next.iter().position(|(k, _)| key.starts_with(k.as_str())) {
        let (_, code) = s.fail_next.remove(i);
        return err(code, "eingespielter Fehler");
    }

    // Anmeldung
    let is_object = path.starts_with("/objects/");
    if !is_object || s.objects_need_auth {
        let ok_bearer = s.expect_bearer.as_ref().is_none_or(|t| auth.as_deref() == Some(&format!("Bearer {t}")));
        let ok_basic = s.expect_basic.as_ref().is_none_or(|t| auth.as_deref() == Some(&format!("Basic {t}")));
        let ok_url = s.expect_url_token.as_ref().is_none_or(|t| q.get("access_token") == Some(t));
        if !(ok_bearer && ok_basic && ok_url) {
            return err(401, "nicht angemeldet");
        }
    }

    let seg: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match (m.as_str(), seg.as_slice()) {
        ("GET", ["tams", "v8.2", "service"]) => out(
            200,
            json!({"type": "urn:x-tams:service:test", "api_version": s.api_version, "min_object_timeout": "3600:0",
                    "name": "Testdienst", "event_stream_mechanisms": [{"name": "webhooks"}], "zusatz": 1}),
        ),
        ("POST", ["tams", "v8.2", "service", "webhooks"]) => {
            let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
            if v.get("url").is_none() || v.get("events").is_none() {
                return err(400, "url und events fehlen");
            }
            s.webhooks.push(v);
            empty(201)
        }
        ("PUT", ["tams", "v8.2", "flows", id]) => {
            let v: Value = match serde_json::from_slice(body) {
                Ok(v) => v,
                Err(_) => return err(400, "kein JSON"),
            };
            if v.get("id").and_then(|x| x.as_str()) != Some(id) {
                return err(400, "id passt nicht zum Pfad");
            }
            if ctype.as_deref() != Some("application/json") {
                return err(400, "Content-Type");
            }
            match s.flows.get_mut(*id) {
                Some(f) if f.read_only => err(403, "Flow ist schreibgeschützt"),
                Some(f) => {
                    f.json = v;
                    empty(204)
                }
                None => {
                    s.flows.insert(id.to_string(), FlowRec { json: v, read_only: false, segments: vec![] });
                    out(201, json!({"id": id}))
                }
            }
        }
        ("POST", ["tams", "v8.2", "flows", id, "storage"]) => {
            let Some(f) = s.flows.get(*id) else { return err(404, "Flow unbekannt") };
            if f.read_only {
                return err(403, "Flow ist schreibgeschützt");
            }
            let container = f.json.get("container").and_then(|c| c.as_str()).unwrap_or("").to_string();
            let req: Value = serde_json::from_slice(body).unwrap_or(json!({}));
            let n = req.get("limit").and_then(|l| l.as_u64()).unwrap_or(3);
            let mut objs = vec![];
            for _ in 0..n {
                s.next_id += 1;
                let oid = format!("obj-{}", s.next_id);
                s.issued.insert(oid.clone());
                objs.push(json!({"object_id": oid, "put_url": {"url": format!("{base}/objects/{oid}"), "content-type": container}}));
            }
            out(201, json!({"media_objects": objs}))
        }
        ("PUT", ["objects", oid]) => {
            if !s.issued.contains(*oid) {
                return err(403, "Object nicht reserviert");
            }
            s.objects.insert(oid.to_string(), (body.to_vec(), ctype.unwrap_or_default()));
            empty(200)
        }
        ("GET", ["objects", oid]) => match s.objects.get(*oid) {
            Some((d, ct)) => Out { status: 200, headers: vec![("Content-Type".into(), ct.clone())], body: d.clone() },
            None => err(404, "Object unbekannt"),
        },
        ("POST", ["tams", "v8.2", "flows", id, "segments"]) => post_segments(&mut s, id, body),
        ("GET", ["tams", "v8.2", "flows", id, "segments"]) => get_segments(&s, base, id, &q),
        ("DELETE", ["tams", "v8.2", "flows", id, "segments"]) => {
            let Some(f) = s.flows.get_mut(*id) else { return err(404, "Flow unbekannt") };
            if f.read_only {
                return err(403, "Flow ist schreibgeschützt");
            }
            let range = TimeRange::parse(q.get("timerange").map(String::as_str).unwrap_or("_")).unwrap_or(TimeRange::Empty);
            f.segments.retain(|sg| !range.contains_range(&TimeRange::parse(sg["timerange"].as_str().unwrap()).unwrap()));
            empty(204)
        }
        _ => err(404, "unbekannter Pfad"),
    }
}

fn route_prefix(path: &str) -> String {
    let p: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match p.as_slice() {
        ["tams", "v8.2", "flows", _, rest @ ..] => format!("flows/*/{}", rest.join("/")),
        ["objects", _] => "objects/*".into(),
        _ => path.to_string(),
    }
}

fn post_segments(s: &mut State, id: &str, body: &[u8]) -> Out {
    let v: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return err(400, "kein JSON"),
    };
    let list: Vec<Value> = match v {
        Value::Array(a) => a,
        o @ Value::Object(_) => vec![o],
        _ => return err(400, "Feld oder Objekt erwartet"),
    };
    let objects_have: BTreeSet<String> = s.objects.keys().cloned().collect();
    let Some(f) = s.flows.get_mut(id) else { return err(404, "Flow unbekannt") };
    if f.read_only {
        return err(403, "Flow ist schreibgeschützt");
    }
    if f.json.get("container").is_none() {
        return err(400, "Flow hat keinen container");
    }
    let mut failed = vec![];
    for sg in list {
        let oid = sg.get("object_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let tr = sg.get("timerange").and_then(|x| x.as_str()).map(TimeRange::parse);
        let fail = |why: &str, sg: &Value| json!({"object_id": sg.get("object_id"), "timerange": sg.get("timerange"), "error": {"type": "error", "summary": why, "time": "2026-11-19T00:00:00Z"}});
        let Some(Ok(range)) = tr else {
            failed.push(fail("timerange fehlt oder ungültig", &sg));
            continue;
        };
        if !objects_have.contains(&oid) {
            failed.push(fail("Object nicht hochgeladen", &sg));
            continue;
        }
        if f.segments.iter().any(|o| TimeRange::parse(o["timerange"].as_str().unwrap()).unwrap().overlaps(&range)) {
            failed.push(fail("Segment überlappt ein vorhandenes", &sg));
            continue;
        }
        f.segments.push(sg);
    }
    if failed.is_empty() { empty(201) } else { out(200, json!({"failed_segments": failed})) }
}

fn get_segments(s: &State, base: &str, id: &str, q: &BTreeMap<String, String>) -> Out {
    let Some(f) = s.flows.get(id) else { return err(404, "Flow unbekannt") };
    let filter = match q.get("timerange") {
        Some(t) => match TimeRange::parse(t) {
            Ok(r) => r,
            Err(_) => return err(400, "timerange ungültig"),
        },
        None => TimeRange::ETERNITY,
    };
    let mut segs: Vec<&Value> = f.segments.iter().filter(|sg| TimeRange::parse(sg["timerange"].as_str().unwrap()).unwrap().overlaps(&filter)).collect();
    segs.sort_by_key(|sg| match TimeRange::parse(sg["timerange"].as_str().unwrap()).unwrap() {
        TimeRange::Range { start: Some(b), .. } => b.ts.ns(),
        _ => i128::MIN,
    });
    if q.get("reverse_order").map(String::as_str) == Some("true") {
        segs.reverse();
    }
    let limit = q.get("limit").and_then(|l| l.parse::<usize>().ok()).unwrap_or(s.page_size).min(s.page_size).max(1);
    let offset = q.get("page").and_then(|p| p.parse::<usize>().ok()).unwrap_or(0);
    let page: Vec<Value> = segs
        .iter()
        .skip(offset)
        .take(limit)
        .map(|sg| {
            let mut v = (*sg).clone();
            let oid = v["object_id"].as_str().unwrap().to_string();
            let with_urls = q.get("accept_get_urls").map(|a| !a.is_empty()).unwrap_or(true);
            v["get_urls"] = if with_urls { json!([{"url": format!("{base}/objects/{oid}"), "label": "fake", "presigned": false}]) } else { json!([]) };
            v
        })
        .collect();
    let mut o = out(200, Value::Array(page));
    if offset + limit < segs.len() {
        let next = offset + limit;
        let mut link = format!("{base}/tams/v8.2/flows/{id}/segments?page={next}");
        if let Some(t) = q.get("timerange") {
            link.push_str(&format!("&timerange={}", t.replace('[', "%5B").replace(')', "%29").replace(':', "%3A")));
        }
        if let Some(l) = q.get("limit") {
            link.push_str(&format!("&limit={l}"));
        }
        let link = s.link_override.clone().unwrap_or(link);
        o.headers.push(("Link".into(), format!("<{link}>; rel=\"next\"")));
        o.headers.push(("X-Paging-NextKey".into(), next.to_string()));
    }
    o
}
