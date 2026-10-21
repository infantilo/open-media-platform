//! Zustand des Intercom-Nodes: Konfiguration (Teilnehmer, Kanäle, Rechte), Laufzeitzustand
//! (Sprechtasten, Stummschaltungen), Rufe, Sitzungen und der 20-ms-Takt, der den Mix-Kern treibt.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::mix::{Channel, ChannelId, Engine, FRAME, Out, Party, PartyId, Route, Vox};
use crate::encpool::EncoderPool;
use crate::mxl_io::MxlIo;
use crate::peer::Peer;

/// Kanal-IDs ab diesem Wert sind ad hoc entstandene Rufe (Direkt-/Gruppen-/Alle-Ruf).
pub const CALL_BASE: ChannelId = 1_000_000;

#[derive(Debug, Clone)]
pub struct ChanInfo {
    pub name: String,
    pub color: String,
    pub kind: String,
}

#[derive(Debug, Clone)]
pub struct PartyInfo {
    pub name: String,
    pub token: String,
    pub kind: String,
    /// Darf andere zwangs-stumm schalten und Alle-Ruf auslösen (`intercom.force`).
    pub force: bool,
    /// Mikrofon wird gesperrt, solange `onAir` gesetzt ist (Studio-Lautsprecher, Kamerakanal …).
    pub onair_lock: bool,
    /// MXL-Programmeingang (1-basiert, 0 = keiner): speist diesen Teilnehmer statt eines Mikrofons.
    pub mxl_in: usize,
    /// MXL-Ausgang (1-basiert, 0 = keiner): trägt das Hörsignal dieses Teilnehmers.
    pub mxl_out: usize,
}

struct Call {
    from: PartyId,
    targets: Vec<PartyId>,
}

#[derive(Default)]
pub struct Stats {
    pub ticks: Arc<AtomicU64>,
    pub late_ticks: AtomicU64,
    pub max_tick_us: AtomicU64,
    /// Summe der Durchlaufzeiten (µs) — Mittel = tick_total_us / ticks.
    pub tick_total_us: AtomicU64,
    pub engine_total_us: AtomicU64,
}

pub struct Core {
    pub engine: Engine,
    pub channels: BTreeMap<ChannelId, ChanInfo>,
    pub parties: BTreeMap<PartyId, PartyInfo>,
    pub sessions: BTreeMap<PartyId, Arc<Peer>>,
    generations: BTreeMap<PartyId, u64>,
    next_generation: u64,
    last_seen: BTreeMap<PartyId, Instant>,
    pub mxl: Option<Arc<MxlIo>>,
    pool: EncoderPool,
    silent_run: BTreeMap<PartyId, u32>,
    dnd: BTreeSet<PartyId>,
    pending_busy: Vec<(PartyId, PartyId)>, // (Anrufer, besetzter Teilnehmer)
    replaced: BTreeMap<PartyId, Arc<Peer>>,
    calls: BTreeMap<ChannelId, Call>,
    pub on_air: bool,
    air_manual: bool,
    air_tally: bool,
    speakers: BTreeMap<ChannelId, Vec<PartyId>>,
    speaking: BTreeSet<PartyId>,
    pending_rings: Vec<(PartyId, PartyId)>, // (an, von)
    dirty: bool,
}

pub struct Hub {
    pub core: Mutex<Core>,
    pub stats: Stats,
}

fn num(v: &Value, key: &str, default: f64) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(default)
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

impl Core {
    fn new() -> Self {
        Self {
            engine: Engine::new(),
            channels: BTreeMap::new(),
            parties: BTreeMap::new(),
            sessions: BTreeMap::new(),
            generations: BTreeMap::new(),
            next_generation: 1,
            last_seen: BTreeMap::new(),
            mxl: None,
            pool: EncoderPool::default(),
            silent_run: BTreeMap::new(),
            dnd: BTreeSet::new(),
            pending_busy: Vec::new(),
            replaced: BTreeMap::new(),
            calls: BTreeMap::new(),
            on_air: false,
            air_manual: false,
            air_tally: false,
            speakers: BTreeMap::new(),
            speaking: BTreeSet::new(),
            pending_rings: Vec::new(),
            dirty: true,
        }
    }

    /// Übernimmt eine Konfiguration. Laufzeitzustand (Tasten, Stumm, Pegel/Pan, die ein Teilnehmer selbst
    /// geändert hat) bleibt für bestehende Teilnehmer/Routen erhalten.
    pub fn apply_config(&mut self, cfg: &Value) -> Result<(), String> {
        let channels = cfg.get("channels").and_then(Value::as_array).ok_or("channels fehlt")?;
        let parties = cfg.get("parties").and_then(Value::as_array).ok_or("parties fehlt")?;

        let mut new_channels = BTreeMap::new();
        for c in channels {
            let id = c.get("id").and_then(Value::as_u64).ok_or("Kanal ohne id")? as ChannelId;
            if id >= CALL_BASE {
                return Err(format!("Kanal-ID {id} liegt im Bereich der Rufe"));
            }
            new_channels.insert(
                id,
                ChanInfo { name: s(c, "name"), color: s(c, "color"), kind: if s(c, "kind").is_empty() { "party".into() } else { s(c, "kind") } },
            );
            let ch = self.engine.channels.entry(id).or_insert_with(Channel::default);
            ch.duck_db = num(c, "duck_db", 0.0) as f32;
            ch.priority_duck_db = num(c, "priority_duck_db", 12.0) as f32;
        }

        let mut seen = BTreeSet::new();
        let mut new_parties = BTreeMap::new();
        for p in parties {
            let id = p.get("id").and_then(Value::as_u64).ok_or("Teilnehmer ohne id")? as PartyId;
            if !seen.insert(id) {
                return Err(format!("Teilnehmer-ID {id} doppelt"));
            }
            new_parties.insert(
                id,
                PartyInfo {
                    name: s(p, "name"),
                    token: s(p, "token"),
                    kind: if s(p, "kind").is_empty() { "human".into() } else { s(p, "kind") },
                    force: p.get("force").and_then(Value::as_bool).unwrap_or(false),
                    onair_lock: p.get("onair_lock").and_then(Value::as_bool).unwrap_or(false),
                    mxl_in: num(p, "mxl_in", 0.0).max(0.0) as usize,
                    mxl_out: num(p, "mxl_out", 0.0).max(0.0) as usize,
                },
            );
            let ep = self.engine.parties.entry(id).or_insert_with(Party::default);
            ep.priority = num(p, "priority", 0.0) as u8;
            ep.is_program = s(p, "kind") == "program";
            if p.get("mic_gain").is_some() {
                ep.mic_gain = num(p, "mic_gain", 1.0) as f32;
            }
            ep.vox = p.get("vox").filter(|v| v.is_object()).map(|v| Vox {
                threshold_db: num(v, "threshold_db", -40.0) as f32,
                hold_ms: num(v, "hold_ms", 300.0) as u32,
            });
            // Konfigurierte Routen: Rechte setzen, neue Routen mit Standardwerten anlegen.
            let mut configured = BTreeSet::new();
            for r in p.get("routes").and_then(Value::as_array).cloned().unwrap_or_default() {
                let ch = r.get("ch").and_then(Value::as_u64).ok_or("Route ohne ch")? as ChannelId;
                if !new_channels.contains_key(&ch) {
                    return Err(format!("Route auf unbekannten Kanal {ch}"));
                }
                configured.insert(ch);
                let fresh = !ep.routes.contains_key(&ch);
                let route = ep.route_mut(ch);
                route.talk_allowed = r.get("talk").and_then(Value::as_bool).unwrap_or(false);
                route.listen = r.get("listen").and_then(Value::as_bool).unwrap_or(false);
                // Programmquellen und Anbindungen haben keine Taste: ihr Sprechweg ist immer offen.
                if matches!(s(p, "kind").as_str(), "program" | "port") {
                    route.talk_key = route.talk_allowed;
                }
                if fresh {
                    route.level = num(&r, "level", 1.0) as f32;
                    route.pan = num(&r, "pan", 0.0) as f32;
                    route.talk_vox = r.get("vox").and_then(Value::as_bool).unwrap_or(false);
                }
            }
            // Nicht mehr konfigurierte Kanalrouten entfernen (Rufkanäle bleiben).
            ep.routes.retain(|ch, _| configured.contains(ch) || *ch >= CALL_BASE);
        }
        for (kind, pick) in [("mxl_in", 0usize), ("mxl_out", 1usize)] {
            let mut used = BTreeSet::new();
            for (id, p) in &new_parties {
                let slot = if pick == 0 { p.mxl_in } else { p.mxl_out };
                if slot > 0 && !used.insert(slot) {
                    return Err(format!("{kind} {slot} doppelt (Teilnehmer {id})"));
                }
            }
        }
        self.engine.parties.retain(|id, _| new_parties.contains_key(id));
        self.engine.channels.retain(|id, _| new_channels.contains_key(id) || *id >= CALL_BASE);
        for id in self.sessions.keys().copied().collect::<Vec<_>>() {
            if !new_parties.contains_key(&id) {
                if let Some(peer) = self.sessions.remove(&id) {
                    peer.close();
                }
            }
        }
        self.channels = new_channels;
        self.parties = new_parties;
        self.calls.retain(|_, c| c.from != 0 && self.parties.contains_key(&c.from));
        self.apply_locks();
        self.dirty = true;
        Ok(())
    }

    pub fn config_json(&self) -> Value {
        let channels: Vec<Value> = self
            .channels
            .iter()
            .map(|(id, c)| {
                let ch = self.engine.channels.get(id);
                json!({"id": id, "name": c.name, "color": c.color, "kind": c.kind,
                       "duck_db": ch.map(|c| c.duck_db).unwrap_or(0.0)})
            })
            .collect();
        let parties: Vec<Value> = self
            .parties
            .iter()
            .map(|(id, info)| {
                let ep = &self.engine.parties[id];
                let routes: Vec<Value> = ep
                    .routes
                    .iter()
                    .filter(|(ch, _)| **ch < CALL_BASE)
                    .map(|(ch, r)| json!({"ch": ch, "talk": r.talk_allowed, "listen": r.listen, "level": r.level, "pan": r.pan}))
                    .collect();
                json!({"id": id, "name": info.name, "kind": info.kind, "priority": ep.priority, "force": info.force,
                       "onair_lock": info.onair_lock, "mxl_in": info.mxl_in, "mxl_out": info.mxl_out, "routes": routes})
            })
            .collect();
        json!({"channels": channels, "parties": parties})
    }

    pub fn party_by_token(&self, token: &str) -> Option<PartyId> {
        if token.is_empty() {
            return None;
        }
        self.parties.iter().find(|(_, p)| p.token == token).map(|(id, _)| *id)
    }

    /// Manuelle Vorgabe (Parameter `onAir`).
    pub fn set_on_air(&mut self, on: bool) {
        self.air_manual = on;
        self.refresh_air();
    }

    /// Vorgabe aus dem Tally-Bus.
    pub fn set_tally_air(&mut self, on: bool) {
        self.air_tally = on;
        self.refresh_air();
    }

    fn refresh_air(&mut self) {
        let on = self.air_manual || self.air_tally;
        if on != self.on_air {
            self.on_air = on;
            self.apply_locks();
            self.dirty = true;
        }
    }

    fn apply_locks(&mut self) {
        for (id, info) in &self.parties {
            if let Some(ep) = self.engine.parties.get_mut(id) {
                if info.onair_lock {
                    ep.forced_mute = self.on_air;
                }
            }
        }
    }

    pub fn encoder_count(&self) -> usize {
        self.pool.count()
    }

    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub fn force_mute(&mut self, id: PartyId, on: bool) -> Result<(), String> {
        let p = self.engine.parties.get_mut(&id).ok_or_else(|| format!("unbekannter Teilnehmer {id}"))?;
        p.forced_mute = on;
        self.dirty = true;
        Ok(())
    }

    /// Beendet die Sitzung eines Teilnehmers (Tasten und Rufe werden zurückgesetzt).
    pub fn end_session(&mut self, id: PartyId) {
        if let Some(p) = self.sessions.remove(&id) {
            p.close();
        }
        self.generations.remove(&id);
        self.silent_run.remove(&id);
        self.pool.forget(id);
        self.reset_runtime(id);
    }

    /// Setzt den flüchtigen Zustand eines Teilnehmers zurück: Sprechtasten, Rufe, Solo.
    pub fn reset_runtime(&mut self, id: PartyId) {
        self.dnd.remove(&id);
        if let Some(ep) = self.engine.parties.get_mut(&id) {
            for r in ep.routes.values_mut() {
                r.talk_key = false;
            }
            ep.solo.clear();
        }
        self.call(id, &[], false);
        self.dirty = true;
    }

    /// Trägt eine neue Sitzung ein und liefert ihre Generationsnummer; eine ersetzte Sitzung wird für `take_replaced` gemerkt.
    pub fn register_session(&mut self, id: PartyId, peer: Arc<Peer>) -> u64 {
        let gen_id = self.next_generation;
        self.next_generation += 1;
        if let Some(old) = self.sessions.insert(id, peer) {
            self.replaced.insert(id, old);
        }
        self.generations.insert(id, gen_id);
        self.last_seen.insert(id, Instant::now());
        self.dirty = true;
        gen_id
    }

    pub fn take_replaced(&mut self, id: PartyId) -> Option<Arc<Peer>> {
        self.replaced.remove(&id)
    }

    pub fn session_generation(&self, id: PartyId) -> Option<u64> {
        self.generations.get(&id).copied()
    }

    fn online(&self, id: PartyId) -> bool {
        if let (Some(info), Some(io)) = (self.parties.get(&id), self.mxl.as_ref()) {
            if matches!(info.kind.as_str(), "program" | "port") {
                return (info.mxl_in > 0 && io.input_flowed(info.mxl_in - 1)) || (info.mxl_out > 0 && info.mxl_in == 0);
            }
        }
        self.sessions.get(&id).map(|p| p.connected()).unwrap_or(false)
    }

    /// Befehl eines Panels (JSON aus dem Datenkanal). Fehlerhafte oder unberechtigte Befehle werden
    /// stillschweigend ignoriert (der nächste Zustand korrigiert die Anzeige).
    pub fn command(&mut self, who: PartyId, msg: &Value) {
        let kind = s(msg, "t");
        self.last_seen.insert(who, Instant::now());
        if kind == "ping" {
            return;
        }
        let ch = msg.get("ch").and_then(Value::as_u64).map(|c| c as ChannelId);
        let on = msg.get("on").and_then(Value::as_bool);
        match (kind.as_str(), on) {
            ("force", Some(on)) => {
                let target = msg.get("party").and_then(Value::as_u64).map(|p| p as PartyId);
                if self.parties.get(&who).map(|p| p.force).unwrap_or(false) {
                    if let Some(t) = target.and_then(|t| self.engine.parties.get_mut(&t)) {
                        t.forced_mute = on;
                    }
                }
                self.dirty = true;
                return;
            }
            ("call", Some(on)) => {
                let to: Vec<PartyId> = match msg.get("to") {
                    Some(Value::Array(a)) => a.iter().filter_map(Value::as_u64).map(|p| p as PartyId).collect(),
                    Some(Value::String(x)) if x == "all" => {
                        if !self.parties.get(&who).map(|p| p.force).unwrap_or(false) {
                            return;
                        }
                        self.parties.keys().copied().filter(|p| *p != who).collect()
                    }
                    _ => Vec::new(),
                };
                self.call(who, &to, on);
                return;
            }
            _ => {}
        }
        let Some(party) = self.engine.parties.get_mut(&who) else { return };
        match (kind.as_str(), ch, on) {
            ("talk", Some(ch), Some(on)) => {
                if let Some(r) = party.routes.get_mut(&ch) {
                    if r.talk_allowed {
                        r.talk_key = on;
                    }
                }
            }
            ("listen", Some(ch), Some(on)) => {
                if let Some(r) = party.routes.get_mut(&ch) {
                    r.listen_muted = !on;
                }
            }
            ("level", Some(ch), _) => {
                let v = num(msg, "v", 1.0).clamp(0.0, 2.0) as f32;
                if let Some(r) = party.routes.get_mut(&ch) {
                    r.level = v;
                }
            }
            ("pan", Some(ch), _) => {
                let v = num(msg, "v", 0.0).clamp(-1.0, 1.0) as f32;
                if let Some(r) = party.routes.get_mut(&ch) {
                    r.pan = v;
                }
            }
            ("solo", Some(ch), Some(on)) => {
                if on {
                    party.solo.insert(ch);
                } else {
                    party.solo.remove(&ch);
                }
            }
            ("mute", _, Some(on)) => party.muted = on,
            ("dnd", _, Some(on)) => {
                if on {
                    self.dnd.insert(who);
                } else {
                    self.dnd.remove(&who);
                }
            }
            ("mic_gain", _, _) => party.mic_gain = num(msg, "v", 1.0).clamp(0.0, 4.0) as f32,
            ("out_gain", _, _) => party.out_gain = num(msg, "v", 1.0).clamp(0.0, 2.0) as f32,
            _ => return,
        }
        self.dirty = true;
    }

    /// Ruf starten/beenden. Ein Ruf ist ein temporärer Kanal: der Anrufer spricht, die Angerufenen hören
    /// (unabhängig von ihren übrigen Kanälen und auch dann, wenn sie sonst nichts hören).
    pub fn call(&mut self, from: PartyId, to: &[PartyId], on: bool) {
        let id = CALL_BASE + from;
        if on {
            let caller_force = self.parties.get(&from).map(|p| p.force).unwrap_or(false);
            let mut targets: Vec<PartyId> = Vec::new();
            for t in to.iter().copied().filter(|t| *t != from && self.engine.parties.contains_key(t)) {
                if self.dnd.contains(&t) && !caller_force {
                    self.pending_busy.push((from, t));
                    continue;
                }
                targets.push(t);
            }
            if targets.is_empty() {
                self.dirty = true;
                return;
            }
            self.engine.channels.entry(id).or_insert_with(Channel::default);
            if let Some(p) = self.engine.parties.get_mut(&from) {
                let r = p.route_mut(id);
                r.talk_allowed = true;
                r.talk_key = true;
                r.listen = false;
            }
            // Zuvor bestehende Ziele dieses Rufs abbauen, die nicht mehr dabei sind.
            if let Some(old) = self.calls.get(&id) {
                for t in old.targets.clone() {
                    if !targets.contains(&t) {
                        if let Some(p) = self.engine.parties.get_mut(&t) {
                            p.routes.remove(&id);
                        }
                    }
                }
            }
            for t in &targets {
                if let Some(p) = self.engine.parties.get_mut(t) {
                    let fresh = !p.routes.contains_key(&id);
                    let r = p.route_mut(id);
                    r.listen = true;
                    r.listen_muted = false;
                    r.talk_allowed = false;
                    // Ruf ist laut, auch wenn der Teilnehmer sonst leise gestellt hat.
                    r.level = 1.0;
                    if fresh {
                        self.pending_rings.push((*t, from));
                    }
                }
            }
            self.calls.insert(id, Call { from, targets });
        } else if let Some(call) = self.calls.remove(&id) {
            for t in call.targets.iter().chain(std::iter::once(&call.from)) {
                if let Some(p) = self.engine.parties.get_mut(t) {
                    p.routes.remove(&id);
                }
            }
            self.engine.channels.remove(&id);
        }
        self.dirty = true;
    }

    pub fn state_for(&self, id: PartyId) -> Option<Value> {
        let info = self.parties.get(&id)?;
        let ep = self.engine.parties.get(&id)?;
        let mut channels = Vec::new();
        for (ch, r) in &ep.routes {
            if !r.talk_allowed && !r.listen {
                continue;
            }
            let (name, color, kind) = match self.channels.get(ch) {
                Some(c) => (c.name.clone(), c.color.clone(), c.kind.clone()),
                None => {
                    let from = self.calls.get(ch).map(|c| c.from).unwrap_or(0);
                    let who = self.parties.get(&from).map(|p| p.name.clone()).unwrap_or_default();
                    (format!("Ruf {who}"), String::new(), "call".to_string())
                }
            };
            channels.push(json!({
                "id": ch, "name": name, "color": color, "kind": kind,
                "talk_allowed": r.talk_allowed, "talk": r.talk_key && r.talk_allowed,
                "listen": r.listen, "listen_on": r.listen && !r.listen_muted,
                "level": r.level, "pan": r.pan, "solo": ep.solo.contains(ch),
                "speakers": self.speakers.get(ch).cloned().unwrap_or_default(),
            }));
        }
        let parties: Vec<Value> = self
            .parties
            .iter()
            .filter(|(_, p)| p.kind != "program")
            .map(|(pid, p)| json!({"id": pid, "name": p.name, "kind": p.kind, "online": self.online(*pid), "speaking": self.speaking.contains(pid), "dnd": self.dnd.contains(pid)}))
            .collect();
        Some(json!({
            "t": "state",
            "me": {"id": id, "name": info.name, "muted": ep.muted, "forced": ep.forced_mute, "force": info.force,
                   "mic_gain": ep.mic_gain, "out_gain": ep.out_gain,
                   "mic_db": self.engine.mic_db(id), "speaking": self.speaking.contains(&id), "on_air": self.on_air,
                   "dnd": self.dnd.contains(&id)},
            "channels": channels,
            "parties": parties,
        }))
    }

    /// Ein Takt: Eingänge holen, mischen, Ausgänge senden. Alle 5 Takte (oder bei Änderung) Zustand an die Panels.
    fn tick(&mut self, n: u64, stats: &Stats) {
        let mut inputs = BTreeMap::new();
        for (id, peer) in &self.sessions {
            if let Some(frame) = peer.pull_frame() {
                inputs.insert(*id, frame);
            }
        }
        if let Some(io) = &self.mxl {
            for (id, info) in &self.parties {
                if info.mxl_in > 0 && !inputs.contains_key(id) {
                    if let Some(frame) = io.pull_input(info.mxl_in - 1) {
                        inputs.insert(*id, frame);
                    }
                }
            }
        }
        let t_engine = Instant::now();
        let (outs, report) = self.engine.process(&inputs);
        stats.engine_total_us.fetch_add(t_engine.elapsed().as_micros() as u64, Ordering::Relaxed);
        // Webrtc-Hörer: Stille wird nach 240 Nachlauf nicht mehr kodiert/gesendet; gleiche Signale teilen einen Encoder.
        let mut audible: BTreeMap<PartyId, &Out> = BTreeMap::new();
        for (id, out) in &outs {
            if self.sessions.get(id).map(|p| p.connected()).unwrap_or(false) {
                let silent = out.left.iter().chain(out.right.iter()).all(|v| v.abs() < 1e-4);
                let run = self.silent_run.entry(*id).or_insert(0);
                if silent {
                    *run += 1;
                    if *run > 12 {
                        continue;
                    }
                } else {
                    *run = 0;
                }
                audible.insert(*id, out);
            }
        }
        self.pool.feed(&audible, &self.sessions);
        for (id, out) in &outs {
            if let (Some(io), Some(info)) = (&self.mxl, self.parties.get(id)) {
                if info.mxl_out > 0 {
                    io.push_output(info.mxl_out - 1, &out.left[..FRAME], &out.right[..FRAME]);
                }
            }
        }
        let speaking: BTreeSet<PartyId> = self.engine.parties.keys().copied().filter(|p| self.engine.is_speaking(*p)).collect();
        if report.speakers != self.speakers || speaking != self.speaking {
            self.dirty = true;
        }
        self.speakers = report.speakers;
        self.speaking = speaking;

        // Zustände ca. 10 Hz (Pegelanzeige) oder sofort bei Änderung.
        if self.dirty || n % 5 == 0 {
            self.dirty = false;
            let rings = std::mem::take(&mut self.pending_rings);
            let busy = std::mem::take(&mut self.pending_busy);
            for (id, peer) in &self.sessions {
                if !peer.connected() {
                    continue;
                }
                if let Some(state) = self.state_for(*id) {
                    peer.send_text(&state.to_string());
                }
                for (caller, who) in &busy {
                    if caller == id {
                        let name = self.parties.get(who).map(|p| p.name.clone()).unwrap_or_default();
                        peer.send_text(&json!({"t": "busy", "party": who, "name": name}).to_string());
                    }
                }
                for (to, from) in &rings {
                    if to == id {
                        let name = self.parties.get(from).map(|p| p.name.clone()).unwrap_or_default();
                        peer.send_text(&json!({"t": "ring", "from": from, "name": name}).to_string());
                    }
                }
            }
        }
    }

    /// Entfernt Sitzungen, deren Verbindung endgültig weg ist (damit Teilnehmer „offline“ werden).
    fn reap(&mut self) {
        // Tot: Verbindung gescheitert/geschlossen — oder der Browser meldet sich seit 8 s nicht mehr (Tab zu, Seite hängt):
        // das Panel schickt alle 2 s einen Ping über den Datenkanal.
        let silent = Duration::from_secs(8);
        let dead: Vec<PartyId> = self
            .sessions
            .iter()
            .filter(|(id, p)| {
                let gone = matches!(p.state().as_str(), "failed" | "closed" | "disconnected") && p.created.elapsed() > Duration::from_secs(2);
                let quiet = p.created.elapsed() > silent && self.last_seen.get(id).map(|t| t.elapsed() > silent).unwrap_or(true);
                gone || quiet
            })
            .map(|(id, _)| *id)
            .collect();
        for id in dead {
            self.end_session(id);
        }
    }
}

impl Hub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { core: Mutex::new(Core::new()), stats: Stats::default() })
    }

    /// Startet den 20-ms-Takt in einem eigenen Thread.
    pub fn spawn_clock(self: &Arc<Self>) {
        let hub = self.clone();
        std::thread::Builder::new()
            .name("intercom-clock".into())
            .spawn(move || {
                let period = Duration::from_millis(20);
                let mut next = Instant::now() + period;
                let mut n = 0u64;
                loop {
                    let now = Instant::now();
                    if next > now {
                        std::thread::sleep(next - now);
                    } else if now - next > period {
                        hub.stats.late_ticks.fetch_add(1, Ordering::Relaxed);
                        next = now; // aufgeholte Takte nicht nachholen
                    }
                    next += period;
                    let t0 = Instant::now();
                    {
                        let mut core = hub.core.lock().expect("lock poisoned");
                        core.tick(n, &hub.stats);
                        if n % 25 == 0 {
                            core.reap();
                        }
                    }
                    let us = t0.elapsed().as_micros() as u64;
                    hub.stats.max_tick_us.fetch_max(us, Ordering::Relaxed);
                    hub.stats.tick_total_us.fetch_add(us, Ordering::Relaxed);
                    hub.stats.ticks.fetch_add(1, Ordering::Relaxed);
                    n += 1;
                }
            })
            .expect("Takt-Thread");
    }
}

#[allow(dead_code)]
fn _assert_route_default(_: Route) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Value {
        json!({
            "channels": [{"id": 1, "name": "Regie"}, {"id": 2, "name": "Technik"}],
            "parties": [
                {"id": 1, "name": "Regie 1", "token": "t1", "force": true,
                 "routes": [{"ch": 1, "talk": true, "listen": true}, {"ch": 2, "talk": true, "listen": true}]},
                {"id": 2, "name": "Kamera 1", "token": "t2", "onair_lock": true,
                 "routes": [{"ch": 1, "talk": true, "listen": true}]},
                {"id": 3, "name": "Technik 1", "token": "t3",
                 "routes": [{"ch": 2, "talk": true, "listen": true}]}
            ]
        })
    }

    #[test]
    fn config_roundtrip_and_token_lookup() {
        let mut c = Core::new();
        c.apply_config(&cfg()).unwrap();
        assert_eq!(c.party_by_token("t2"), Some(2));
        assert_eq!(c.party_by_token(""), None);
        assert_eq!(c.party_by_token("nope"), None);
        let out = c.config_json();
        let mut d = Core::new();
        d.apply_config(&out).unwrap();
        assert_eq!(d.config_json(), out);
    }

    #[test]
    fn runtime_state_survives_config_update_but_rights_follow_config() {
        let mut c = Core::new();
        c.apply_config(&cfg()).unwrap();
        c.command(1, &json!({"t": "talk", "ch": 1, "on": true}));
        c.command(1, &json!({"t": "level", "ch": 1, "v": 0.5}));
        c.apply_config(&cfg()).unwrap();
        let r = &c.engine.parties[&1].routes[&1];
        assert!(r.talk_key && (r.level - 0.5).abs() < 1e-6);
        // Recht entziehen: Taste bleibt, Sprechweg ist aber zu.
        let mut cut = cfg();
        cut["parties"][0]["routes"][0]["talk"] = json!(false);
        c.apply_config(&cut).unwrap();
        assert!(!c.engine.parties[&1].routes[&1].talk_allowed);
    }

    #[test]
    fn talk_without_right_is_ignored_and_force_needs_right() {
        let mut c = Core::new();
        c.apply_config(&cfg()).unwrap();
        c.command(3, &json!({"t": "talk", "ch": 1, "on": true})); // keine Route
        assert!(c.engine.parties[&3].routes.get(&1).is_none());
        c.command(3, &json!({"t": "force", "party": 1, "on": true}));
        assert!(!c.engine.parties[&1].forced_mute, "ohne force-Recht wirkungslos");
        c.command(1, &json!({"t": "force", "party": 3, "on": true}));
        assert!(c.engine.parties[&3].forced_mute);
    }

    #[test]
    fn on_air_locks_marked_parties_only() {
        let mut c = Core::new();
        c.apply_config(&cfg()).unwrap();
        c.set_on_air(true);
        assert!(c.engine.parties[&2].forced_mute);
        assert!(!c.engine.parties[&1].forced_mute);
        c.set_on_air(false);
        assert!(!c.engine.parties[&2].forced_mute);
    }

    #[test]
    fn on_air_is_manual_or_tally_and_both_must_clear() {
        let mut c = Core::new();
        c.apply_config(&cfg()).unwrap();
        c.set_tally_air(true);
        assert!(c.engine.parties[&2].forced_mute);
        c.set_on_air(true);
        c.set_tally_air(false);
        assert!(c.engine.parties[&2].forced_mute, "manuell hält weiter");
        c.set_on_air(false);
        assert!(!c.engine.parties[&2].forced_mute);
    }

    #[test]
    fn call_creates_temporary_channel_and_removes_it() {
        let mut c = Core::new();
        c.apply_config(&cfg()).unwrap();
        c.command(1, &json!({"t": "call", "to": [3], "on": true}));
        let id = CALL_BASE + 1;
        assert!(c.engine.parties[&1].routes[&id].talk_key);
        assert!(c.engine.parties[&3].routes[&id].listen);
        assert!(c.engine.parties[&2].routes.get(&id).is_none());
        c.command(1, &json!({"t": "call", "on": false}));
        assert!(c.engine.parties[&1].routes.get(&id).is_none());
        assert!(c.engine.parties[&3].routes.get(&id).is_none());
        assert!(!c.engine.channels.contains_key(&id));
    }

    #[test]
    fn do_not_disturb_blocks_calls_except_from_force_parties_and_reports_busy() {
        let mut c = Core::new();
        c.apply_config(&cfg()).unwrap();
        c.command(3, &json!({"t": "dnd", "on": true}));
        c.command(2, &json!({"t": "call", "to": [3], "on": true}));
        assert!(!c.engine.channels.contains_key(&(CALL_BASE + 2)), "kein Ruf an Teilnehmer im Ruhemodus");
        assert_eq!(c.pending_busy, vec![(2, 3)]);
        c.command(1, &json!({"t": "call", "to": [3], "on": true}));
        assert!(c.engine.parties[&3].routes[&(CALL_BASE + 1)].listen, "force-Teilnehmer dürfen durch");
        c.command(3, &json!({"t": "dnd", "on": false}));
        assert!(!c.state_for(3).unwrap()["me"]["dnd"].as_bool().unwrap());
    }

    #[test]
    fn all_call_needs_force_right() {
        let mut c = Core::new();
        c.apply_config(&cfg()).unwrap();
        c.command(3, &json!({"t": "call", "to": "all", "on": true}));
        assert!(!c.engine.channels.contains_key(&(CALL_BASE + 3)));
        c.command(1, &json!({"t": "call", "to": "all", "on": true}));
        let id = CALL_BASE + 1;
        assert!(c.engine.parties[&2].routes[&id].listen && c.engine.parties[&3].routes[&id].listen);
    }

    #[test]
    fn call_audio_reaches_target_only() {
        let mut c = Core::new();
        c.apply_config(&cfg()).unwrap();
        c.command(1, &json!({"t": "call", "to": [3], "on": true}));
        let tone: Vec<f32> = (0..FRAME).map(|i| 0.3 * (i as f32 * 0.06).sin()).collect();
        let mut ins = BTreeMap::new();
        ins.insert(1, tone);
        let (outs, _) = c.engine.process(&ins);
        let e = |v: &Vec<f32>| v.iter().map(|x| x * x).sum::<f32>();
        assert!(e(&outs[&3].left) > 0.1);
        assert!(e(&outs[&2].left) < 1e-9 && e(&outs[&1].left) < 1e-9);
    }

    #[test]
    fn invalid_config_is_rejected_without_changing_state() {
        let mut c = Core::new();
        c.apply_config(&cfg()).unwrap();
        let bad = json!({"channels": [{"id": 1}], "parties": [{"id": 1, "routes": [{"ch": 9, "talk": true}]}]});
        assert!(c.apply_config(&bad).is_err());
        assert_eq!(c.parties.len(), 3);
    }

    #[test]
    fn state_for_lists_only_own_routes_and_hides_program_parties() {
        let mut c = Core::new();
        let mut cf = cfg();
        cf["parties"].as_array_mut().unwrap().push(json!({"id": 9, "name": "PGM", "kind": "program", "token": "tp", "routes": [{"ch": 1, "talk": true}]}));
        c.apply_config(&cf).unwrap();
        let st = c.state_for(3).unwrap();
        assert_eq!(st["channels"].as_array().unwrap().len(), 1);
        assert!(st["parties"].as_array().unwrap().iter().all(|p| p["id"] != 9));
    }
}
