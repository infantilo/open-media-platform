//! Durchlauf-Test (Kapitel 93): die echte Laufzeit (`runtime::run_loop`) gegen einen kleinen Schein-Orchestrator auf 127.0.0.1, der
//! Knotenliste, `mixState`, Live-Strom und Methodenaufrufe so beantwortet wie der Orchestrator-Proxy. Ein simuliertes Pult ersetzt
//! das Gerät. Beweist die Kette Pult → Logik → HTTP-Aufruf am Mischer und zurück (Zustand → Fahrfader, Pegel, On-Air).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_node_sdk::is04::RegistryClient;
use omp_playout_core::remote::OrchestratorAuth;
use serde_json::{Value, json};
use tokio::sync::mpsc::unbounded_channel;

use crate::config::parse_config;
use crate::fader::db_to_fader;
use crate::runtime::{Shared, run_loop};

struct Fake {
    url: String,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    mix: Arc<Mutex<Value>>,
}

fn respond(s: &mut TcpStream, status: &str, ctype: &str, body: &str) {
    let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

fn fake_orchestrator() -> Fake {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    let calls = Arc::new(Mutex::new(vec![]));
    let mix = Arc::new(Mutex::new(json!({
        "channels": [
            {"id": "a", "label": "Mic 1", "gainDb": -10.0, "mute": false, "pfl": false, "proc": {"pan": 0.0}},
            {"id": "b", "label": "Mic 2", "gainDb": 0.0, "mute": false, "pfl": false, "proc": {"pan": 0.0}}
        ],
        "auxBuses": [{"id": "x", "label": "Studio", "masterDb": -3.0}]
    })));
    let (c2, m2) = (calls.clone(), mix.clone());
    std::thread::spawn(move || {
        for conn in l.incoming().flatten() {
            let (calls, mix) = (c2.clone(), m2.clone());
            std::thread::spawn(move || {
                let mut s = conn;
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut line = String::new();
                if r.read_line(&mut line).is_err() {
                    return;
                }
                let (method, path) = {
                    let mut it = line.split_whitespace();
                    (it.next().unwrap_or("").to_string(), it.next().unwrap_or("").to_string())
                };
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    if r.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; len];
                let _ = r.read_exact(&mut body);
                let json_body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                if method == "GET" && path == "/api/v1/nodes" {
                    respond(&mut s, "200 OK", "application/json", &json!([{"id": "n1", "label": "Mischer"}]).to_string());
                } else if method == "GET" && path == "/api/v1/nodes/n1/params/mixState" {
                    respond(&mut s, "200 OK", "application/json", &json!({"value": *mix.lock().unwrap()}).to_string());
                } else if method == "POST" && path.starts_with("/api/v1/nodes/n1/methods/") {
                    calls.lock().unwrap().push((path.rsplit('/').next().unwrap().to_string(), json_body));
                    respond(&mut s, "200 OK", "application/json", "{}");
                } else if method == "GET" && path == "/api/v1/nodes/n1/stream/levelsUrl" {
                    let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
                    let _ = s.write_all(b"data: {\"type\":\"dsp\",\"channelId\":\"a\",\"onAir\":true}\n\n");
                    for _ in 0..200 {
                        if s.write_all(b"data: {\"channelId\":\"a\",\"rms\":0.5,\"peak\":1.0}\n\n").is_err() {
                            return;
                        }
                        let _ = s.flush();
                        std::thread::sleep(Duration::from_millis(50));
                    }
                } else {
                    respond(&mut s, "404 Not Found", "text/plain", "nicht da");
                }
            });
        }
    });
    Fake { url, calls, mix }
}

fn wait<F: FnMut() -> bool>(mut f: F, secs: u64) -> bool {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(secs) {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn surface_to_mixer_and_back() {
    let fake = fake_orchestrator();
    let auth = OrchestratorAuth::new();
    auth.set("test-token".to_string());
    let cfg = parse_config(r#"{"mixer":"Mischer","masterAux":"x","units":[{"type":"sim"},{"type":"sim"}]}"#).unwrap();
    let sh = Arc::new(Mutex::new(Shared::new(cfg)));
    let (tx, mut rx) = unbounded_channel();
    {
        let (sh, url, hb) = (sh.clone(), fake.url.clone(), Arc::new(AtomicU64::new(0)));
        std::thread::spawn(move || run_loop(sh, tx, url, auth, RegistryClient::new("http://127.0.0.1:1".to_string()), hb));
    }
    let sim = |i: usize| sh.lock().unwrap().sims.iter().find(|(k, _)| *k == i).map(|(_, p)| p.clone());
    assert!(wait(|| sim(0).is_some() && sim(1).is_some(), 5), "Anschlüsse werden gebaut");
    let (s0, s1) = (sim(0).unwrap(), sim(1).unwrap());

    // 1. Mischer-Zustand erscheint am Pult: Namen, Fader auf −10 dB, Master-Fader auf −3 dB (Aux-Bus)
    assert!(wait(|| s0.state.lock().unwrap().text(0).starts_with("Mic 1  Mic 2"), 5), "Namen kommen an");
    assert!(wait(|| s0.state.lock().unwrap().faders[0] == db_to_fader(-10.0), 5));
    assert!(wait(|| s0.state.lock().unwrap().faders[8] == db_to_fader(-3.0), 5), "Master-Fader folgt dem Aux-Bus");

    // 2. Live-Strom: Pegel (Meter-Stufe 12) und On-Air (Rec-LED)
    assert!(wait(|| s0.state.lock().unwrap().meters[0] == 12, 5), "Pegel kommt an");
    assert!(wait(|| s0.state.lock().unwrap().leds.get(&crate::mcu::NOTE_REC) == Some(&crate::mcu::Led::On), 5), "On-Air kommt an");

    // 3. Bedienung am Pult → Methodenaufrufe am Mischer
    s0.state.lock().unwrap().press("mute1").unwrap();
    assert!(wait(|| fake.calls.lock().unwrap().iter().any(|(m, b)| m == "channel.a.setMute" && b["muted"] == json!(true)), 5));
    s0.state.lock().unwrap().drag(1, db_to_fader(-20.0));
    s0.state.lock().unwrap().release(1);
    assert!(wait(|| fake.calls.lock().unwrap().iter().any(|(m, b)| m == "channel.b.setGain" && b["db"] == json!(-20.0)), 5));
    s0.state.lock().unwrap().drag(8, db_to_fader(-6.0));
    s0.state.lock().unwrap().release(8);
    assert!(wait(|| fake.calls.lock().unwrap().iter().any(|(m, b)| m == "aux.x.setMaster" && b["db"] == json!(-6.0)), 5));
    // Erweiterung zeigt hier keinen Kanal (nur zwei vorhanden): ihre Taste löst nichts am Mischer aus
    let n_before = fake.calls.lock().unwrap().len();
    s1.state.lock().unwrap().press("solo1").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(fake.calls.lock().unwrap().len(), n_before);

    // 4. Taste ohne Belegung → NATS-Ereignis
    s0.state.lock().unwrap().press("play").unwrap();
    let mut got = false;
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(5) && !got {
        while let Ok(m) = rx.try_recv() {
            if m.suffix == "button.play" && m.body["down"] == json!(true) {
                got = true;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(got, "button.play wird gemeldet");

    // 5. Von außen verstellt → Fahrfader fährt
    fake.mix.lock().unwrap()["channels"][0]["gainDb"] = json!(-30.0);
    assert!(wait(|| (s0.state.lock().unwrap().faders[0] - db_to_fader(-30.0)).abs() <= 24, 5), "Fader folgt dem Mischer");

    // 6. Status
    let status = sh.lock().unwrap().status.clone();
    assert_eq!(status["running"], json!(true));
    assert_eq!(status["mixerFound"], json!(true));
    assert_eq!(status["units"].as_array().unwrap().len(), 2);
    assert_eq!(status["channels"], json!(2));
    assert!(status["units"][0]["sim"]["lcd"][0].as_str().unwrap().starts_with("Mic 1"));

    // 7. Neue Konfiguration baut neu auf (jetzt eine Einheit)
    {
        let mut s = sh.lock().unwrap();
        s.cfg = parse_config(r#"{"mixer":"Mischer","units":[{"type":"sim"}]}"#).unwrap();
        s.generation += 1;
    }
    assert!(wait(|| sh.lock().unwrap().status["units"].as_array().is_some_and(|u| u.len() == 1), 5), "Neuaufbau mit einer Einheit");
}
