//! Regeln der Studio-Logik (Kapitel 89/RC2, `docs/CONTRACT-STUDIO-LOGIC.md`). Reine Zustandsmaschine mit eingespeister Zeit:
//! sie bekommt eine Beobachtung (Mischer-`onAir`/`mute`, Kontakt-Eingänge) und liefert Aktionen (Rotlicht, Stummschalten).
//! Die Regeln stehen als Daten (`Config`), nicht im Code.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// Ein Ziel am Mischer, das stumm geschaltet wird.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Target {
    /// `channel`, `group` oder `aux`
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Group {
    pub name: String,
    /// Mischerkanäle der Mikrofone dieser Gruppe.
    pub channels: Vec<String>,
    /// Ausgang am GPIO-Node (Pin ab 1) für das Rotlicht.
    pub light: Option<u32>,
    /// Ziele, die stumm sind, solange irgendein Mikrofon der Gruppe offen ist (Studio-Lautsprecher).
    pub speakers: Vec<Target>,
    /// Eingang am GPIO-Node (Pin ab 1), der die Gruppe stumm hält, solange er gedrückt ist (Cough).
    pub cough_input: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Studio {
    pub name: String,
    /// Mikrofonkanäle, die dieses Studio auf den Programmweg gibt.
    pub channels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub groups: Vec<Group>,
    pub studios: Vec<Studio>,
    /// Längste Dauer eines Cough per Methode, danach wird wieder geöffnet.
    pub max_cough_ms: u64,
    /// Haltezeit der Rotlicht-Befehle am GPIO-Node (Fail-Safe: Studio-Logik fällt aus → Licht aus).
    pub light_hold_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Config { groups: Vec::new(), studios: Vec::new(), max_cough_ms: 15_000, light_hold_ms: 3_000 }
    }
}

impl Config {
    pub fn validate(&self) -> Result<(), String> {
        let mut names = HashSet::new();
        for g in &self.groups {
            if g.name.trim().is_empty() || !names.insert(g.name.clone()) {
                return Err(format!("Gruppenname leer oder doppelt: „{}“", g.name));
            }
            if g.channels.is_empty() {
                return Err(format!("Gruppe „{}“ hat keine Kanäle", g.name));
            }
            if g.light == Some(0) || g.cough_input == Some(0) {
                return Err(format!("Gruppe „{}“: Pins zählen ab 1", g.name));
            }
            for t in &g.speakers {
                if !["channel", "group", "aux"].contains(&t.kind.as_str()) || t.id.is_empty() {
                    return Err(format!("Gruppe „{}“: Lautsprecher-Ziel ungültig (kind channel/group/aux)", g.name));
                }
            }
        }
        let mut studios = HashSet::new();
        for s in &self.studios {
            if s.name.trim().is_empty() || !studios.insert(s.name.clone()) {
                return Err(format!("Studioname leer oder doppelt: „{}“", s.name));
            }
        }
        if !(1000..=600_000).contains(&self.max_cough_ms) || !(500..=60_000).contains(&self.light_hold_ms) {
            return Err("maxCoughMs 1000…600000, lightHoldMs 500…60000".to_string());
        }
        Ok(())
    }
}

/// Was der Node vom Mischer und vom GPIO-Node gelesen hat. Fehlt ein Wert (`None`/nicht enthalten), war er nicht lesbar.
#[derive(Debug, Clone, Default)]
pub struct Obs {
    pub on_air: HashMap<String, bool>,
    pub mute: HashMap<String, bool>,
    /// Eingänge des GPIO-Nodes; `None` = GPIO-Node nicht erreichbar.
    pub inputs: Option<HashMap<u32, bool>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Light { pin: u32, on: bool },
    Mute { target: Target, muted: bool },
    Audit(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HandoverState {
    Offered,
    Accepted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Handover {
    pub from: String,
    pub to: String,
    pub at_tai_ns: u64,
    pub state: HandoverState,
}

#[derive(Default)]
struct GroupState {
    on_air: bool,
    /// Cough aktiv: wann es per Methode begann (für die Höchstdauer) und ob es per Taste/Methode gehalten wird.
    cough_method_since_ms: Option<u64>,
    cough_input_down: bool,
    /// Cough wurde im letzten Takt angewendet (Stummschaltung gesendet).
    cough_applied: bool,
    /// Zustand der Kanäle vor dem Cough (Mute), zum Wiederherstellen.
    prev_mute: HashMap<String, bool>,
    last_speaker_muted: Option<bool>,
    last_light: Option<bool>,
}

pub struct Logic {
    pub cfg: Config,
    st: Vec<GroupState>,
    pub handover: Option<Handover>,
    pub active_studio: Option<String>,
    pub audit: Vec<String>,
}

impl Logic {
    pub fn new(cfg: Config) -> Self {
        let st = cfg.groups.iter().map(|_| GroupState::default()).collect();
        Logic { cfg, st, handover: None, active_studio: None, audit: Vec::new() }
    }

    pub fn cough_active(&self, group: usize) -> bool {
        self.st[group].cough_method_since_ms.is_some() || self.st[group].cough_input_down
    }

    pub fn on_air(&self, group: usize) -> bool {
        self.st[group].on_air
    }

    /// Cough per Methode (Panel/Tastenpult). `on = false` öffnet wieder.
    pub fn set_cough(&mut self, now_ms: u64, group: &str, on: bool) -> Result<(), String> {
        let i = self.cfg.groups.iter().position(|g| g.name == group).ok_or_else(|| format!("Gruppe „{group}“ gibt es nicht"))?;
        self.st[i].cough_method_since_ms = if on { Some(now_ms) } else { None };
        Ok(())
    }

    pub fn offer(&mut self, from: &str, to: &str, at_tai_ns: u64, now_tai_ns: u64) -> Result<(), String> {
        let known = |n: &str| self.cfg.studios.iter().any(|s| s.name == n);
        if !known(from) || !known(to) || from == to {
            return Err("Studios unbekannt oder gleich".to_string());
        }
        if self.handover.is_some() {
            return Err("Eine Übergabe läuft bereits".to_string());
        }
        if at_tai_ns <= now_tai_ns {
            return Err("Schaltpunkt liegt in der Vergangenheit".to_string());
        }
        self.handover = Some(Handover { from: from.to_string(), to: to.to_string(), at_tai_ns, state: HandoverState::Offered });
        self.audit.push(format!("Übergabe angeboten: {from} → {to} um TAI {at_tai_ns}"));
        Ok(())
    }

    pub fn accept(&mut self, now_tai_ns: u64) -> Result<(), String> {
        let h = self.handover.as_mut().ok_or("keine Übergabe angeboten")?;
        if h.state != HandoverState::Offered {
            return Err("Übergabe ist schon angenommen".to_string());
        }
        if h.at_tai_ns <= now_tai_ns {
            let msg = "Annahme zu spät: Schaltpunkt vorbei, Übergabe verworfen".to_string();
            self.audit.push(msg.clone());
            self.handover = None;
            return Err(msg);
        }
        h.state = HandoverState::Accepted;
        let m = format!("Übergabe angenommen: {} → {}", h.from, h.to);
        self.audit.push(m);
        Ok(())
    }

    pub fn abort(&mut self) -> Result<(), String> {
        let h = self.handover.take().ok_or("keine Übergabe offen")?;
        self.audit.push(format!("Übergabe abgebrochen: {} → {}", h.from, h.to));
        Ok(())
    }

    fn studio_channels(&self, name: &str) -> Vec<String> {
        self.cfg.studios.iter().find(|s| s.name == name).map(|s| s.channels.clone()).unwrap_or_default()
    }

    /// Ein Takt. `now_ms` monoton, `now_tai_ns` für den Schaltpunkt der Übergabe.
    pub fn step(&mut self, now_ms: u64, now_tai_ns: u64, obs: &Obs) -> Vec<Action> {
        let mut out = Vec::new();

        // Übergabe: zum Schaltpunkt (nur wenn angenommen) Quellstudio stumm, Zielstudio offen
        if let Some(h) = self.handover.clone() {
            if now_tai_ns >= h.at_tai_ns {
                if h.state == HandoverState::Accepted {
                    for c in self.studio_channels(&h.from) {
                        out.push(Action::Mute { target: Target { kind: "channel".into(), id: c }, muted: true });
                    }
                    for c in self.studio_channels(&h.to) {
                        out.push(Action::Mute { target: Target { kind: "channel".into(), id: c }, muted: false });
                    }
                    let m = format!("Übergabe ausgeführt: {} → {} (Soll TAI {}, Ist TAI {})", h.from, h.to, h.at_tai_ns, now_tai_ns);
                    self.audit.push(m.clone());
                    out.push(Action::Audit(m));
                    self.active_studio = Some(h.to.clone());
                } else {
                    self.audit.push(format!("Übergabe verfallen (nicht angenommen): {} → {}", h.from, h.to));
                }
                self.handover = None;
            }
        }

        for (i, g) in self.cfg.groups.iter().enumerate() {
            let s = &mut self.st[i];

            // Cough: Taste (nur lesbar, solange der GPIO-Node antwortet — sonst gilt „losgelassen“) und Methode mit Höchstdauer
            let down = g.cough_input.is_some_and(|p| obs.inputs.as_ref().and_then(|m| m.get(&p)).copied().unwrap_or(false));
            if let Some(t) = s.cough_method_since_ms {
                if now_ms.saturating_sub(t) >= self.cfg.max_cough_ms {
                    s.cough_method_since_ms = None;
                    out.push(Action::Audit(format!("Cough „{}“ nach Höchstdauer beendet", g.name)));
                }
            }
            s.cough_input_down = down;
            let was = s.cough_applied;
            let now_cough = s.cough_method_since_ms.is_some() || s.cough_input_down;
            s.cough_applied = now_cough;
            if now_cough && !was {
                s.prev_mute = g.channels.iter().map(|c| (c.clone(), obs.mute.get(c).copied().unwrap_or(false))).collect();
                for c in &g.channels {
                    out.push(Action::Mute { target: Target { kind: "channel".into(), id: c.clone() }, muted: true });
                }
            } else if !now_cough && was {
                for c in &g.channels {
                    let prev = s.prev_mute.get(c).copied().unwrap_or(false);
                    out.push(Action::Mute { target: Target { kind: "channel".into(), id: c.clone() }, muted: prev });
                }
                s.prev_mute.clear();
            }

            // On-Air: irgendein Kanal offen; unlesbar → Zustand bleibt (ein einzelner Lesefehler schaltet nichts)
            let known: Vec<bool> = g.channels.iter().filter_map(|c| obs.on_air.get(c).copied()).collect();
            if !known.is_empty() {
                s.on_air = known.iter().any(|b| *b);
            }
            // Rotlicht: bei Änderung sofort, sonst als Erneuerung der Haltezeit (alle Takte, die der Aufrufer ansetzt)
            if let Some(pin) = g.light {
                out.push(Action::Light { pin, on: s.on_air });
                s.last_light = Some(s.on_air);
            }
            // Lautsprecher stumm, solange offen; nur bei Änderung (und beim ersten Takt)
            if !g.speakers.is_empty() && s.last_speaker_muted != Some(s.on_air) {
                for t in &g.speakers {
                    out.push(Action::Mute { target: t.clone(), muted: s.on_air });
                }
                s.last_speaker_muted = Some(s.on_air);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config {
            groups: vec![Group {
                name: "Moderator".into(),
                channels: vec!["m1".into(), "m2".into()],
                light: Some(1),
                speakers: vec![Target { kind: "group".into(), id: "spk".into() }],
                cough_input: Some(3),
            }],
            studios: vec![Studio { name: "A".into(), channels: vec!["a1".into()] }, Studio { name: "B".into(), channels: vec!["b1".into()] }],
            ..Config::default()
        }
    }

    fn obs(on: &[(&str, bool)]) -> Obs {
        Obs { on_air: on.iter().map(|(k, v)| (k.to_string(), *v)).collect(), ..Obs::default() }
    }

    #[test]
    fn mic_open_lights_and_mutes_speakers_once() {
        let mut l = Logic::new(cfg());
        let a = l.step(0, 0, &obs(&[("m1", false), ("m2", false)]));
        assert!(a.contains(&Action::Light { pin: 1, on: false }));
        assert!(a.contains(&Action::Mute { target: Target { kind: "group".into(), id: "spk".into() }, muted: false }));
        let a = l.step(100, 0, &obs(&[("m1", true), ("m2", false)]));
        assert!(a.contains(&Action::Light { pin: 1, on: true }));
        assert!(a.contains(&Action::Mute { target: Target { kind: "group".into(), id: "spk".into() }, muted: true }));
        let a = l.step(200, 0, &obs(&[("m1", true), ("m2", false)]));
        assert!(a.iter().all(|x| !matches!(x, Action::Mute { .. })), "Lautsprecher nicht erneut gesetzt");
        assert!(a.contains(&Action::Light { pin: 1, on: true }), "Licht wird als Erneuerung weitergesendet");
    }

    #[test]
    fn unreadable_mixer_keeps_state() {
        let mut l = Logic::new(cfg());
        l.step(0, 0, &obs(&[("m1", true)]));
        let a = l.step(100, 0, &obs(&[]));
        assert!(a.contains(&Action::Light { pin: 1, on: true }));
    }

    #[test]
    fn cough_by_input_mutes_and_release_restores_previous_state() {
        let mut l = Logic::new(cfg());
        let mut o = obs(&[("m1", true)]);
        o.mute.insert("m1".into(), false);
        o.mute.insert("m2".into(), true); // war schon stumm
        o.inputs = Some([(3, true)].into());
        let a = l.step(0, 0, &o);
        assert!(a.contains(&Action::Mute { target: Target { kind: "channel".into(), id: "m1".into() }, muted: true }));
        assert!(l.cough_active(0));
        o.inputs = Some([(3, false)].into());
        let a = l.step(100, 0, &o);
        assert!(a.contains(&Action::Mute { target: Target { kind: "channel".into(), id: "m1".into() }, muted: false }));
        assert!(a.contains(&Action::Mute { target: Target { kind: "channel".into(), id: "m2".into() }, muted: true }), "vorher stumm bleibt stumm");
    }

    #[test]
    fn cough_input_lost_gpio_opens_again() {
        let mut l = Logic::new(cfg());
        let mut o = obs(&[("m1", true)]);
        o.inputs = Some([(3, true)].into());
        l.step(0, 0, &o);
        o.inputs = None; // GPIO-Node nicht erreichbar
        let a = l.step(100, 0, &o);
        assert!(a.contains(&Action::Mute { target: Target { kind: "channel".into(), id: "m1".into() }, muted: false }));
        assert!(!l.cough_active(0));
    }

    #[test]
    fn cough_by_method_mutes_on_next_step_and_restores_on_release() {
        let mut l = Logic::new(cfg());
        let mut o = obs(&[("m1", true)]);
        o.mute.insert("m1".into(), false);
        l.set_cough(0, "Moderator", true).unwrap();
        let a = l.step(10, 0, &o);
        assert!(a.contains(&Action::Mute { target: Target { kind: "channel".into(), id: "m1".into() }, muted: true }));
        assert!(l.step(20, 0, &o).iter().all(|x| !matches!(x, Action::Mute { target, .. } if target.id == "m1")), "nicht erneut");
        l.set_cough(30, "Moderator", false).unwrap();
        let a = l.step(40, 0, &o);
        assert!(a.contains(&Action::Mute { target: Target { kind: "channel".into(), id: "m1".into() }, muted: false }));
    }

    #[test]
    fn cough_by_method_ends_after_max_duration() {
        let mut l = Logic::new(cfg());
        l.set_cough(0, "Moderator", true).unwrap();
        l.step(10, 0, &obs(&[]));
        assert!(l.cough_active(0));
        let a = l.step(15_000, 0, &obs(&[]));
        assert!(!l.cough_active(0));
        assert!(a.contains(&Action::Mute { target: Target { kind: "channel".into(), id: "m1".into() }, muted: false }));
        assert!(l.set_cough(0, "Gibtsnicht", true).is_err());
    }

    #[test]
    fn handover_switches_at_tai_only_when_accepted() {
        let mut l = Logic::new(cfg());
        l.offer("A", "B", 1_000, 0).unwrap();
        assert!(l.offer("B", "A", 2_000, 0).is_err(), "nur eine Übergabe");
        l.accept(500).unwrap();
        assert!(l.step(0, 999, &obs(&[])).iter().all(|a| !matches!(a, Action::Audit(_))));
        let a = l.step(0, 1_000, &obs(&[]));
        assert!(a.contains(&Action::Mute { target: Target { kind: "channel".into(), id: "a1".into() }, muted: true }));
        assert!(a.contains(&Action::Mute { target: Target { kind: "channel".into(), id: "b1".into() }, muted: false }));
        assert_eq!(l.active_studio.as_deref(), Some("B"));
        assert!(l.handover.is_none());
        assert!(l.audit.iter().any(|m| m.contains("ausgeführt")));
    }

    #[test]
    fn handover_abort_and_expiry() {
        let mut l = Logic::new(cfg());
        l.offer("A", "B", 1_000, 0).unwrap();
        l.abort().unwrap();
        assert!(l.step(0, 2_000, &obs(&[])).is_empty() || l.active_studio.is_none());
        assert!(l.active_studio.is_none());
        l.offer("A", "B", 5_000, 0).unwrap();
        l.step(0, 6_000, &obs(&[])); // nicht angenommen → verfällt ohne Umschaltung
        assert!(l.handover.is_none() && l.active_studio.is_none());
        assert!(l.audit.iter().any(|m| m.contains("verfallen")));
        l.offer("A", "B", 9_000, 6_000).unwrap();
        assert!(l.accept(9_500).is_err(), "zu spät angenommen");
        assert!(l.handover.is_none());
        assert!(l.offer("A", "A", 20_000, 0).is_err() && l.offer("A", "B", 1, 5).is_err());
    }

    #[test]
    fn config_validation() {
        assert!(cfg().validate().is_ok());
        let mut c = cfg();
        c.groups[0].light = Some(0);
        assert!(c.validate().is_err());
        let mut c = cfg();
        c.groups[0].speakers[0].kind = "x".into();
        assert!(c.validate().is_err());
        let mut c = cfg();
        c.groups.push(c.groups[0].clone());
        assert!(c.validate().is_err());
    }
}
