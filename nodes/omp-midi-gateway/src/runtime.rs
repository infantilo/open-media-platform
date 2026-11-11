//! Laufzeit des MIDI-Gateways (Kapitel 93): baut aus der Konfiguration die Anschlüsse, treibt im 5-ms-Takt die Pulte (Betriebsart `mcu`)
//! oder das generische Profil (`profile`) und meldet Ereignisse für NATS. Eine neue Konfiguration (`generation`) baut alles neu auf.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_node_sdk::is04::RegistryClient;
use omp_playout_core::remote::{self, OrchestratorAuth, ProxyClient};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;

use crate::config::{Config, Mode, UnitKind};
use crate::engine::Engine;
use crate::mixer::MixerLink;
use crate::mcu::MidiParser;
use crate::profile::{Action, ProfileEngine, describe, parse_profile};
use crate::raw::RawPort;
use crate::rtp::{Role, RtpPort};
use crate::surface::{MidiPort, SimPort};

/// Nachricht an den Veröffentlichungstask: Betreff-Endung (nach `omp.midi.<node>.`) und Inhalt.
pub struct Msg {
    pub suffix: String,
    pub body: Value,
}

pub struct Shared {
    pub cfg: Config,
    pub generation: u64,
    pub status: Value,
    /// Simulierte Einheiten: (Einheiten-Index, Anschluss).
    pub sims: Vec<(usize, SimPort)>,
    pub bank_delta: i64,
    pub recent: VecDeque<Value>,
    pub seq: u64,
    pub error: String,
    pub last_midi: String,
}

impl Shared {
    pub fn new(cfg: Config) -> Self {
        Shared { cfg, generation: 1, status: json!({"running": false}), sims: vec![], bank_delta: 0, recent: VecDeque::new(), seq: 0, error: String::new(), last_midi: String::new() }
    }
}

fn tai_now_ns() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: gültiger Zeiger auf eine lokale timespec
    unsafe { libc::clock_gettime(libc::CLOCK_TAI, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

fn emit(sh: &Mutex<Shared>, tx: &UnboundedSender<Msg>, suffix: String, mut body: Value) {
    let mut s = sh.lock().expect("lock poisoned");
    s.seq += 1;
    body["seq"] = json!(s.seq);
    body["taiNs"] = json!(tai_now_ns());
    s.recent.push_back(json!({"subject": suffix, "event": body}));
    while s.recent.len() > 50 {
        s.recent.pop_front();
    }
    drop(s);
    let _ = tx.send(Msg { suffix, body });
}

/// Anschluss, der nie zustande kam (z. B. Port belegt): immer „aus“, Fehler steht im Status.
struct DeadPort(String);
impl MidiPort for DeadPort {
    fn name(&self) -> String {
        self.0.clone()
    }
    fn send_batch(&mut self, _: &[Vec<u8>]) {}
    fn recv(&mut self) -> Vec<Vec<u8>> {
        vec![]
    }
    fn is_up(&self) -> bool {
        false
    }
}

fn unit_label(i: usize, name: &str, fallback: &str) -> String {
    if name.is_empty() { format!("{} ({})", fallback, i + 1) } else { name.to_string() }
}

fn build_ports(cfg: &Config, sh: &Mutex<Shared>) -> (Vec<Box<dyn MidiPort>>, Vec<&'static str>, Vec<String>) {
    let mut ports: Vec<Box<dyn MidiPort>> = vec![];
    let mut kinds = vec![];
    let mut errors = vec![];
    let mut sims = vec![];
    for (i, u) in cfg.units.iter().enumerate() {
        match &u.kind {
            UnitKind::Raw { path } => {
                ports.push(Box::new(RawPort::open(path, &unit_label(i, &u.name, path))));
                kinds.push("raw");
            }
            UnitKind::RtpListen { port, session } => {
                let label = unit_label(i, &u.name, &format!("RTP-MIDI :{port}"));
                match RtpPort::start(Role::Listen { port: *port }, session, &label) {
                    Ok(p) => ports.push(Box::new(p)),
                    Err(e) => {
                        errors.push(format!("Einheit {}: Port {port}/{} nicht zu öffnen ({e})", i + 1, port + 1));
                        ports.push(Box::new(DeadPort(label)));
                    }
                }
                kinds.push("rtp");
            }
            UnitKind::RtpConnect { peer, session } => {
                let label = unit_label(i, &u.name, &format!("RTP-MIDI {peer}"));
                match RtpPort::start(Role::Connect { peer: peer.clone() }, session, &label) {
                    Ok(p) => ports.push(Box::new(p)),
                    Err(e) => {
                        errors.push(format!("Einheit {}: {e}", i + 1));
                        ports.push(Box::new(DeadPort(label)));
                    }
                }
                kinds.push("rtp");
            }
            UnitKind::Sim => {
                let p = SimPort::new(&unit_label(i, &u.name, "Simulator"));
                sims.push((i, p.clone()));
                ports.push(Box::new(p));
                kinds.push("sim");
            }
        }
    }
    sh.lock().expect("lock poisoned").sims = sims;
    (ports, kinds, errors)
}

/// Aktion des Profils am Ziel-Node ausführen (Hilfsthread: HTTP blockiert).
fn spawn_action_worker(url: String, auth: OrchestratorAuth, reg: RegistryClient, default_node: String, sh: Arc<Mutex<Shared>>) -> Sender<Action> {
    let (tx, rx) = channel::<Action>();
    std::thread::spawn(move || {
        let mut cache: Vec<(String, String, Instant)> = vec![]; // (Label, ID, Zeit)
        while let Ok(a) = rx.recv() {
            let node = match &a {
                Action::Call { node, .. } | Action::Nudge { node, .. } => node.clone(),
            };
            let label = if node.is_empty() { default_node.clone() } else { node };
            cache.retain(|(_, _, t)| t.elapsed() < Duration::from_secs(10));
            let id = match cache.iter().find(|(l, _, _)| *l == label) {
                Some((_, id, _)) => id.clone(),
                None => {
                    let idx = remote::fetch_node_index(&url, &auth).unwrap_or_else(|_| remote::node_index_from_registry(&reg));
                    let id = idx.resolve(&label).unwrap_or_default();
                    cache.push((label.clone(), id.clone(), Instant::now()));
                    id
                }
            };
            if id.is_empty() {
                sh.lock().expect("lock poisoned").error = format!("Node „{label}“ nicht gefunden");
                continue;
            }
            let c = ProxyClient::new(url.clone(), id, auth.clone());
            let res = match a {
                Action::Call { method, args, .. } => c.invoke(&method, Value::Object(args)),
                Action::Nudge { method, mut args, arg, delta, min, max, read_param, .. } => match c.get_param(&read_param) {
                    Ok(Value::Number(n)) => {
                        let mut v = n.as_f64().unwrap_or(0.0) + delta;
                        if let Some(m) = min {
                            v = v.max(m);
                        }
                        if let Some(m) = max {
                            v = v.min(m);
                        }
                        args.insert(arg, json!((v * 10000.0).round() / 10000.0));
                        c.invoke(&method, Value::Object(args))
                    }
                    Ok(_) => Ok(()),
                    Err(e) => Err(e),
                },
            };
            match res {
                Ok(()) => sh.lock().expect("lock poisoned").error.clear(),
                Err(e) => sh.lock().expect("lock poisoned").error = format!("{label}: {e}"),
            }
        }
    });
    tx
}

pub fn run_loop(sh: Arc<Mutex<Shared>>, tx: UnboundedSender<Msg>, url: String, auth: OrchestratorAuth, reg: RegistryClient, hb: Arc<AtomicU64>) {
    let start = Instant::now();
    let mut seen_gen = 0u64;
    loop {
        hb.fetch_add(1, Ordering::Relaxed);
        let (cfg, generation_id) = {
            let s = sh.lock().expect("lock poisoned");
            (s.cfg.clone(), s.generation)
        };
        if generation_id == seen_gen {
            std::thread::sleep(Duration::from_millis(20));
            continue;
        }
        seen_gen = generation_id;
        {
            let mut s = sh.lock().expect("lock poisoned");
            s.error.clear();
            s.status = json!({"running": false});
        }
        if cfg.units.is_empty() {
            sh.lock().expect("lock poisoned").status = json!({"running": false, "mode": mode_str(&cfg), "mixer": cfg.mixer, "units": [], "hint": "keine Einheiten eingestellt"});
            continue;
        }
        let (ports, kinds, errors) = build_ports(&cfg, &sh);
        if !errors.is_empty() {
            sh.lock().expect("lock poisoned").error = errors.join("; ");
        }
        match cfg.mode {
            Mode::Mcu => run_mcu(&sh, &tx, &cfg, ports, kinds, &url, &auth, &reg, &hb, start, generation_id),
            Mode::Profile => run_profile(&sh, &tx, &cfg, ports, kinds, &url, &auth, &reg, &hb, start, generation_id),
        }
    }
}

fn mode_str(c: &Config) -> &'static str {
    if c.mode == Mode::Mcu { "mcu" } else { "profile" }
}

#[allow(clippy::too_many_arguments)]
fn run_mcu(sh: &Arc<Mutex<Shared>>, tx: &UnboundedSender<Msg>, cfg: &Config, ports: Vec<Box<dyn MidiPort>>, kinds: Vec<&'static str>, url: &str, auth: &OrchestratorAuth, reg: &RegistryClient, hb: &Arc<AtomicU64>, start: Instant, generation_id: u64) {
    let link = MixerLink::start(cfg.mixer.clone(), cfg.master_aux.clone(), url.to_string(), auth.clone(), reg.clone());
    let mut engine = Engine::new(ports, !cfg.master_aux.is_empty());
    engine.start(start.elapsed().as_millis() as u64);
    let mut online = vec![false; engine.units.len()];
    let mut last_status = Instant::now() - Duration::from_secs(1);
    let mut last_levels = Instant::now();
    let mut master: Option<f64> = None;
    loop {
        hb.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(5));
        let now = start.elapsed().as_millis() as u64;
        let delta = {
            let mut s = sh.lock().expect("lock poisoned");
            if s.generation != generation_id {
                return;
            }
            std::mem::take(&mut s.bank_delta)
        };
        if delta != 0 {
            engine.logic.set_bank_delta(delta);
        }
        if let Some(snap) = link.take_snapshot() {
            master = snap.aux.iter().find(|(id, _)| *id == cfg.master_aux).map(|(_, db)| *db);
            engine.logic.set_model(snap.channels, master);
            engine.logic.set_levels(&link.levels());
            engine.logic.set_on_air(&link.on_air());
        }
        if last_levels.elapsed() >= Duration::from_millis(40) {
            last_levels = Instant::now();
            engine.logic.set_levels(&link.levels());
            engine.logic.set_on_air(&link.on_air());
        }
        for c in engine.tick(now) {
            link.send(c);
        }
        for (name, down) in engine.logic.drain_buttons() {
            emit(sh, tx, format!("button.{name}"), json!({"kind": "button", "name": name, "down": down}));
        }
        for (i, u) in engine.units.iter().enumerate() {
            if u.online != online[i] {
                online[i] = u.online;
                emit(sh, tx, "link".to_string(), json!({"kind": "link", "unit": i + 1, "name": u.port.name(), "up": u.online}));
            }
        }
        if last_status.elapsed() >= Duration::from_millis(250) {
            last_status = Instant::now();
            let mut s = sh.lock().expect("lock poisoned");
            let units: Vec<Value> = engine
                .units
                .iter()
                .enumerate()
                .map(|(i, u)| {
                    let mut o = json!({"unit": i + 1, "type": kinds[i], "name": u.port.name(), "up": u.port.is_up(), "online": u.online, "version": u.version});
                    if let Some((_, sim)) = s.sims.iter().find(|(k, _)| *k == i) {
                        let st = sim.state.lock().expect("lock poisoned");
                        let leds: Vec<Value> = st.leds.iter().filter(|(_, l)| **l != crate::mcu::Led::Off).map(|(n, _)| json!(n)).collect();
                        o["sim"] = json!({"faders": st.faders, "touched": st.touched, "meters": st.meters, "lcd": [st.text_raw(0), st.text_raw(1)], "ledsOn": leds});
                    }
                    o
                })
                .collect();
            let err = if s.error.is_empty() { link.error() } else { s.error.clone() };
            s.status = json!({"running": true, "mode": "mcu", "mixer": cfg.mixer, "mixerFound": link.found(), "masterAux": cfg.master_aux, "masterDb": master,
                "bank": engine.logic.bank, "channels": engine.logic.channel_count(), "strips": engine.logic.total_strips(), "units": units, "error": err});
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_profile(sh: &Arc<Mutex<Shared>>, tx: &UnboundedSender<Msg>, cfg: &Config, mut ports: Vec<Box<dyn MidiPort>>, kinds: Vec<&'static str>, url: &str, auth: &OrchestratorAuth, reg: &RegistryClient, hb: &Arc<AtomicU64>, _start: Instant, generation_id: u64) {
    let Some(profile) = cfg.profile.as_ref().and_then(|p| parse_profile(p).ok()) else { return };
    let mut engine = ProfileEngine::new(profile, &cfg.mixer);
    let actions = spawn_action_worker(url.to_string(), auth.clone(), reg.clone(), cfg.mixer.clone(), sh.clone());
    let mut parser = MidiParser::default();
    let mut up = false;
    let mut last_status = Instant::now() - Duration::from_secs(1);
    let port = &mut ports[0];
    loop {
        hb.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(5));
        if sh.lock().expect("lock poisoned").generation != generation_id {
            return;
        }
        for chunk in port.recv() {
            for m in parser.push(&chunk) {
                if let Some(d) = describe(&m) {
                    sh.lock().expect("lock poisoned").last_midi = format!("{} {} Kanal {} Wert {}", d.kind, d.num, d.channel, d.value);
                }
                for a in engine.handle(&m) {
                    let id = match &a {
                        Action::Call { control_id, .. } | Action::Nudge { control_id, .. } => control_id.clone(),
                    };
                    if let Some(d) = describe(&m) {
                        emit(sh, tx, format!("control.{id}"), json!({"kind": "control", "control": id, "value": d.value, "down": d.down}));
                    }
                    let _ = actions.send(a);
                }
            }
        }
        if port.is_up() != up {
            up = port.is_up();
            emit(sh, tx, "link".to_string(), json!({"kind": "link", "unit": 1, "name": port.name(), "up": up}));
        }
        if last_status.elapsed() >= Duration::from_millis(250) {
            last_status = Instant::now();
            let mut s = sh.lock().expect("lock poisoned");
            let units = json!([{"unit": 1, "type": kinds[0], "name": port.name(), "up": up, "online": up}]);
            s.status = json!({"running": true, "mode": "profile", "mixer": cfg.mixer, "profile": engine.profile.name, "controls": engine.profile.controls.len(), "units": units, "lastMidi": s.last_midi, "error": s.error});
        }
    }
}
