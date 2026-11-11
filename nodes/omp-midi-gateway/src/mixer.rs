//! Verbindung zum Audiomischer (Kapitel 93): Zustand per `mixState` (eine Abfrage für alle Kanäle), Pegel und On-Air aus dem Live-Strom
//! `levelsUrl`, Befehle als `channel.<id>.set*` — alles über den Orchestrator-Proxy wie bei der Studio-Logik. Hilfsthreads, damit
//! ein träger HTTP-Aufruf den Takt der Pulte nie anhält.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_node_sdk::is04::RegistryClient;
use omp_playout_core::remote::{self, OrchestratorAuth, ProxyClient};
use serde_json::{Value, json};

use crate::surface::{MixerCmd, StripInfo};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub channels: Vec<StripInfo>,
    /// (Aux-Bus-ID, Master-dB)
    pub aux: Vec<(String, f64)>,
}

/// `mixState` → Pult-Modell (auch als Zeichenkette). Pegel und On-Air bleiben aus dem Live-Strom.
pub fn parse_mix_state(raw: &Value) -> Snapshot {
    let doc: Value = match raw {
        Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
        v => v.clone(),
    };
    let channels = doc
        .get("channels")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| {
                    let id = c.get("id")?.as_str()?.to_string();
                    Some(StripInfo {
                        label: c.get("label").and_then(Value::as_str).unwrap_or(&id).to_string(),
                        gain_db: c.get("gainDb").and_then(Value::as_f64),
                        mute: c.get("mute").and_then(Value::as_bool).unwrap_or(false),
                        pfl: c.get("pfl").and_then(Value::as_bool).unwrap_or(false),
                        on_air: false,
                        level: 0.0,
                        pan: c.pointer("/proc/pan").and_then(Value::as_f64),
                        raw: c.clone(),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let aux = doc
        .get("auxBuses")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| Some((x.get("id")?.as_str()?.to_string(), x.get("masterDb").and_then(Value::as_f64).unwrap_or(0.0)))).collect())
        .unwrap_or_default();
    Snapshot { channels, aux }
}

/// Eine Live-Meldung einarbeiten. Master (`channelId` null) wird ignoriert.
pub fn apply_live(m: &Value, levels: &mut HashMap<String, f64>, on_air: &mut HashMap<String, bool>) -> bool {
    let Some(id) = m.get("channelId").and_then(Value::as_str) else { return false };
    if m.get("type").and_then(Value::as_str) == Some("dsp") {
        if let Some(a) = m.get("onAir").and_then(Value::as_bool) {
            on_air.insert(id.to_string(), a);
            return true;
        }
        return false;
    }
    if let Some(p) = m.get("peak").and_then(Value::as_f64) {
        levels.insert(id.to_string(), p.clamp(0.0, 1.0));
        return true;
    }
    false
}

pub fn cmd_call(c: &MixerCmd, master_aux: &str) -> Option<(String, Value)> {
    Some(match c {
        MixerCmd::Call { .. } | MixerCmd::Nudge { .. } => return None, // gehen über den Aktions-Hilfsthread (beliebige Nodes)
        MixerCmd::Gain { id, db } => (format!("channel.{id}.setGain"), json!({"db": db})),
        MixerCmd::Mute { id, muted } => (format!("channel.{id}.setMute"), json!({"muted": muted})),
        MixerCmd::Pfl { id, enabled } => (format!("channel.{id}.setPfl"), json!({"enabled": enabled})),
        MixerCmd::Pan { id, pan } => (format!("channel.{id}.setPan"), json!({"pan": pan})),
        MixerCmd::Master { db } => {
            if master_aux.is_empty() {
                return None;
            }
            (format!("aux.{master_aux}.setMaster"), json!({"db": db}))
        }
    })
}

#[derive(Default)]
struct LinkShared {
    snapshot: Mutex<Option<Snapshot>>,
    fresh: AtomicBool,
    levels: Mutex<HashMap<String, f64>>,
    on_air: Mutex<HashMap<String, bool>>,
    found: AtomicBool,
    error: Mutex<String>,
    /// Letzter Fehler eines Befehls (die Abfrage löscht ihren eigenen Fehler, nicht diesen).
    cmd_error: Mutex<String>,
    client: Mutex<Option<ProxyClient>>,
    node_id: Mutex<String>,
    /// Zählt Wechsel des Ziel-Nodes (der Live-Strom beginnt dann neu).
    epoch: AtomicU64,
}

pub struct MixerLink {
    sh: Arc<LinkShared>,
    tx: Sender<MixerCmd>,
    stop: Arc<AtomicBool>,
}

impl Drop for MixerLink {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl MixerLink {
    pub fn start(label: String, master_aux: String, orch_url: String, auth: OrchestratorAuth, reg: RegistryClient) -> MixerLink {
        let sh = Arc::new(LinkShared::default());
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = channel::<MixerCmd>();
        {
            let (sh, stop, url, auth) = (sh.clone(), stop.clone(), orch_url.clone(), auth.clone());
            std::thread::spawn(move || poll_loop(sh, stop, label, url, auth, reg));
        }
        {
            let (sh, stop) = (sh.clone(), stop.clone());
            std::thread::spawn(move || cmd_loop(sh, stop, rx, master_aux));
        }
        {
            let (sh, stop) = (sh.clone(), stop.clone());
            std::thread::spawn(move || stream_loop(sh, stop, orch_url, auth));
        }
        MixerLink { sh, tx, stop }
    }

    pub fn send(&self, c: MixerCmd) {
        let _ = self.tx.send(c);
    }
    /// Neuer Zustand seit dem letzten Aufruf?
    pub fn take_snapshot(&self) -> Option<Snapshot> {
        if self.sh.fresh.swap(false, Ordering::Relaxed) { self.sh.snapshot.lock().expect("lock poisoned").clone() } else { None }
    }
    pub fn levels(&self) -> HashMap<String, f64> {
        self.sh.levels.lock().expect("lock poisoned").clone()
    }
    pub fn on_air(&self) -> HashMap<String, bool> {
        self.sh.on_air.lock().expect("lock poisoned").clone()
    }
    pub fn found(&self) -> bool {
        self.sh.found.load(Ordering::Relaxed)
    }
    pub fn error(&self) -> String {
        let c = self.sh.cmd_error.lock().expect("lock poisoned").clone();
        if c.is_empty() { self.sh.error.lock().expect("lock poisoned").clone() } else { c }
    }
}

fn sleep_unless(stop: &AtomicBool, d: Duration) {
    let t = Instant::now();
    while t.elapsed() < d && !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn poll_loop(sh: Arc<LinkShared>, stop: Arc<AtomicBool>, label: String, url: String, auth: OrchestratorAuth, reg: RegistryClient) {
    let mut id = String::new();
    let mut since = Instant::now() - Duration::from_secs(60);
    while !stop.load(Ordering::Relaxed) {
        if label.is_empty() {
            *sh.error.lock().expect("lock poisoned") = "kein Mischer eingestellt".to_string();
            sleep_unless(&stop, Duration::from_millis(500));
            continue;
        }
        if id.is_empty() || since.elapsed() > Duration::from_secs(10) {
            since = Instant::now();
            let idx = remote::fetch_node_index(&url, &auth).unwrap_or_else(|_| remote::node_index_from_registry(&reg));
            let found = idx.resolve(&label).unwrap_or_default();
            if found != id {
                id = found;
                sh.epoch.fetch_add(1, Ordering::Relaxed);
                *sh.node_id.lock().expect("lock poisoned") = id.clone();
                *sh.client.lock().expect("lock poisoned") = if id.is_empty() { None } else { Some(ProxyClient::new(url.clone(), id.clone(), auth.clone())) };
            }
            sh.found.store(!id.is_empty(), Ordering::Relaxed);
            if id.is_empty() {
                *sh.error.lock().expect("lock poisoned") = format!("Mischer „{label}“ nicht gefunden");
            }
        }
        let client = sh.client.lock().expect("lock poisoned").clone();
        if let Some(c) = client {
            match c.get_param("mixState") {
                Ok(v) => {
                    *sh.snapshot.lock().expect("lock poisoned") = Some(parse_mix_state(&v));
                    sh.fresh.store(true, Ordering::Relaxed);
                    sh.error.lock().expect("lock poisoned").clear();
                }
                Err(e) => *sh.error.lock().expect("lock poisoned") = format!("mixState: {e}"),
            }
        }
        sleep_unless(&stop, Duration::from_millis(700));
    }
}

fn cmd_loop(sh: Arc<LinkShared>, stop: Arc<AtomicBool>, rx: Receiver<MixerCmd>, master_aux: String) {
    while !stop.load(Ordering::Relaxed) {
        let Ok(first) = rx.recv_timeout(Duration::from_millis(100)) else { continue };
        let mut batch = vec![first];
        while let Ok(c) = rx.try_recv() {
            batch.push(c);
        }
        let client = sh.client.lock().expect("lock poisoned").clone();
        let Some(c) = client else { continue };
        for cmd in batch {
            if let Some((name, args)) = cmd_call(&cmd, &master_aux) {
                match c.invoke(&name, args) {
                    Ok(()) => sh.cmd_error.lock().expect("lock poisoned").clear(),
                    Err(e) => *sh.cmd_error.lock().expect("lock poisoned") = format!("{name}: {e}"),
                }
            }
        }
    }
}

fn stream_loop(sh: Arc<LinkShared>, stop: Arc<AtomicBool>, orch_url: String, auth: OrchestratorAuth) {
    while !stop.load(Ordering::Relaxed) {
        let epoch = sh.epoch.load(Ordering::Relaxed);
        let client = sh.client.lock().expect("lock poisoned").clone();
        let (Some(_), Some(hdr)) = (client, auth.header_value()) else {
            sleep_unless(&stop, Duration::from_millis(500));
            continue;
        };
        let id = sh.node_id.lock().expect("lock poisoned").clone();
        let url = format!("{}/api/v1/nodes/{}/stream/levelsUrl", orch_url.trim_end_matches('/'), id);
        match ureq::get(&url).config().timeout_recv_body(Some(Duration::from_secs(20))).build().header("Authorization", &hdr).call() {
            Ok(mut resp) => {
                let reader = BufReader::new(resp.body_mut().as_reader());
                for line in reader.lines() {
                    if stop.load(Ordering::Relaxed) || sh.epoch.load(Ordering::Relaxed) != epoch {
                        break;
                    }
                    let Ok(line) = line else { break };
                    let Some(data) = line.strip_prefix("data:") else { continue };
                    if let Ok(m) = serde_json::from_str::<Value>(data.trim()) {
                        let (mut lv, mut oa) = (sh.levels.lock().expect("lock poisoned"), sh.on_air.lock().expect("lock poisoned"));
                        apply_live(&m, &mut lv, &mut oa);
                    }
                }
            }
            Err(_) => {}
        }
        sleep_unless(&stop, Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> Value {
        json!({
            "channels": [
                {"id": "a", "label": "Mic 1", "gainDb": -3, "mute": false, "pfl": true, "proc": {"pan": -0.5}},
                {"id": "b", "gainDb": 0, "mute": true}
            ],
            "auxBuses": [{"id": "x", "label": "Studio", "masterDb": -6}]
        })
    }

    #[test]
    fn mix_state_parsed_also_as_string() {
        for raw in [doc(), Value::String(doc().to_string())] {
            let s = parse_mix_state(&raw);
            assert_eq!(s.channels[0], StripInfo { id: "a".into(), label: "Mic 1".into(), gain_db: Some(-3.0), mute: false, pfl: true, on_air: false, level: 0.0, pan: Some(-0.5), raw: doc()["channels"][0].clone() });
            assert_eq!(s.channels[1].label, "b");
            assert_eq!(s.channels[1].pan, None);
            assert_eq!(s.aux, vec![("x".to_string(), -6.0)]);
        }
        assert!(parse_mix_state(&Value::Null).channels.is_empty());
    }

    #[test]
    fn live_messages() {
        let (mut lv, mut oa) = (HashMap::new(), HashMap::new());
        assert!(apply_live(&json!({"channelId": "a", "rms": 0.1, "peak": 0.7}), &mut lv, &mut oa));
        assert!(apply_live(&json!({"type": "dsp", "channelId": "a", "onAir": true}), &mut lv, &mut oa));
        assert_eq!((lv["a"], oa["a"]), (0.7, true));
        assert!(!apply_live(&json!({"channelId": null, "peak": 1}), &mut lv, &mut oa));
        apply_live(&json!({"channelId": "a", "peak": 7}), &mut lv, &mut oa);
        assert_eq!(lv["a"], 1.0);
    }

    #[test]
    fn commands_map_to_methods() {
        assert_eq!(cmd_call(&MixerCmd::Gain { id: "a".into(), db: -4.5 }, ""), Some(("channel.a.setGain".to_string(), json!({"db": -4.5}))));
        assert_eq!(cmd_call(&MixerCmd::Mute { id: "a".into(), muted: true }, "").unwrap().0, "channel.a.setMute");
        assert_eq!(cmd_call(&MixerCmd::Pfl { id: "a".into(), enabled: true }, "").unwrap().1, json!({"enabled": true}));
        assert_eq!(cmd_call(&MixerCmd::Master { db: -1.0 }, ""), None);
        assert_eq!(cmd_call(&MixerCmd::Master { db: -1.0 }, "x"), Some(("aux.x.setMaster".to_string(), json!({"db": -1.0}))));
    }
}
