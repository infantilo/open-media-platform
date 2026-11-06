//! Entscheidungslogik des Havarieumschalters (`docs/ENTWURF-HAVARIEUMSCHALTER.md`): reine Zustandsmaschine mit eingespeister Zeit.
//! Sie bekommt je Block die Beobachtung jeder Quelle (Signal da? Pegel? später Freeze/Schwarz) und liefert Ereignisse sowie die aktive Quelle.
//! Haltezeiten und Schwellen sind Eigenlösung (keine Norm), s. `Rules::default`.

use std::collections::VecDeque;

/// Quellen: Hauptsignal, drei Notquellen (andere MXL-Flows), der eingebaute Notclip (Datei in Schleife) und das Standbild (nur Bild).
pub const SOURCES: [&str; 6] = ["main", "n1", "n2", "n3", "clip", "still"];
pub const N: usize = SOURCES.len();

pub fn label(id: &str) -> &'static str {
    match id {
        "main" => "Hauptsignal",
        "n1" => "Notquelle 1",
        "n2" => "Notquelle 2",
        "n3" => "Notquelle 3",
        "clip" => "Notclip",
        "still" => "Standbild",
        _ => "?",
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Rules {
    /// Kein Signal länger als so viele ms → gestört.
    pub no_signal_ms: u64,
    /// Pegel unter `silence_db` länger als `silence_ms` → gestört (Stille).
    pub silence_db: f64,
    pub silence_ms: u64,
    /// Standbild länger als so viele ms → gestört (Bild; 0 = aus).
    pub freeze_ms: u64,
    /// Schwarzbild länger als so viele ms → gestört (Bild; 0 = aus).
    pub black_ms: u64,
    /// So lange in Ordnung, bis eine Quelle als gesund gilt (Vorbedingung zum Aufschalten und für die Rückkehr).
    pub healthy_ms: u64,
    /// Rückkehr zum Hauptsignal erst nach so langer Gesundheit.
    pub return_ms: u64,
    /// Mindestverweildauer auf einer Notquelle (kein Flattern).
    pub min_hold_ms: u64,
    pub auto_return: bool,
    /// Reihenfolge der Notquellen (Priorität, „zuerst das, dann das“); nicht genannte Notquellen werden nicht benutzt.
    pub order: Vec<String>,
}

impl Default for Rules {
    fn default() -> Self {
        Rules {
            no_signal_ms: 1500,
            silence_db: -60.0,
            silence_ms: 5000,
            freeze_ms: 5000,
            black_ms: 5000,
            healthy_ms: 500,
            return_ms: 3000,
            min_hold_ms: 2000,
            auto_return: true,
            order: ["n1", "n2", "n3", "clip", "still"].iter().map(|s| s.to_string()).collect(),
        }
    }
}

impl Rules {
    pub fn validate(&self) -> Result<(), String> {
        if !(100..=600_000).contains(&self.no_signal_ms) || !(500..=3_600_000).contains(&self.silence_ms) || self.freeze_ms > 3_600_000 || self.black_ms > 3_600_000 {
            return Err("Haltezeiten außerhalb des Bereichs (Signal 0,1–600 s, Stille 0,5 s–1 h, Freeze ≤ 1 h)".to_string());
        }
        if !(-120.0..=-10.0).contains(&self.silence_db) {
            return Err("Schwelle −120…−10 dBFS".to_string());
        }
        if self.healthy_ms > 60_000 || self.return_ms > 3_600_000 || self.min_hold_ms > 3_600_000 {
            return Err("healthyMs ≤ 60 s, returnMs und minHoldMs ≤ 1 h".to_string());
        }
        let mut seen = Vec::new();
        for s in &self.order {
            if !SOURCES.contains(&s.as_str()) || s == "main" || seen.contains(s) {
                return Err(format!("Reihenfolge: „{s}“ unbekannt, doppelt oder das Hauptsignal"));
            }
            seen.push(s.clone());
        }
        Ok(())
    }
}

/// Beobachtung einer Quelle für einen Block.
#[derive(Clone, Copy, Debug, Default)]
pub struct Obs {
    /// Kamen in letzter Zeit Daten an?
    pub present: bool,
    /// Spitzenpegel des Blocks in dBFS (Ton); `None` = Quelle liefert keinen Ton (z. B. Bildquelle).
    pub level_db: Option<f64>,
    /// Bild unverändert (Freeze) — `None` = keine Bildquelle.
    pub frozen: Option<bool>,
    /// Bild zu dunkel (Schwarzbild) — `None` = keine Bildquelle.
    pub black: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cause {
    NoSignal,
    Silence,
    Freeze,
    Black,
}

impl Cause {
    pub fn text(self) -> &'static str {
        match self {
            Cause::NoSignal => "kein Signal",
            Cause::Silence => "Stille",
            Cause::Freeze => "Standbild",
            Cause::Black => "Schwarzbild",
        }
    }
}

/// Gesundheit einer Quelle.
#[derive(Clone, Debug, Default)]
pub struct Health {
    pub no_signal_ms: u64,
    pub silent_ms: u64,
    pub frozen_ms: u64,
    pub black_ms: u64,
    pub ok_ms: u64,
    pub last_level_db: f64,
    pub present: bool,
}

impl Health {
    fn feed(&mut self, dt: u64, o: &Obs, silence_db: f64) {
        self.present = o.present;
        self.last_level_db = o.level_db.unwrap_or(-120.0);
        let bad_signal = !o.present;
        if bad_signal {
            self.no_signal_ms += dt;
        } else {
            self.no_signal_ms = 0;
        }
        // Stille und Freeze zählen nur, wenn Daten da sind (sonst gilt „kein Signal“)
        match o.level_db {
            Some(l) if o.present => self.silent_ms = if l < silence_db { self.silent_ms + dt } else { 0 },
            _ => self.silent_ms = 0,
        }
        match o.frozen {
            Some(true) if o.present => self.frozen_ms += dt,
            _ => self.frozen_ms = 0,
        }
        match o.black {
            Some(true) if o.present => self.black_ms += dt,
            _ => self.black_ms = 0,
        }
        if bad_signal || self.silent_ms > 0 || self.frozen_ms > 0 || self.black_ms > 0 {
            self.ok_ms = 0;
        } else {
            self.ok_ms += dt;
        }
    }

    /// Ursache der Störung nach den Haltezeiten (None = nicht gestört).
    pub fn failure(&self, r: &Rules) -> Option<Cause> {
        if self.no_signal_ms >= r.no_signal_ms {
            Some(Cause::NoSignal)
        } else if self.silent_ms >= r.silence_ms {
            Some(Cause::Silence)
        } else if r.freeze_ms > 0 && self.frozen_ms >= r.freeze_ms {
            Some(Cause::Freeze)
        } else if r.black_ms > 0 && self.black_ms >= r.black_ms {
            Some(Cause::Black)
        } else {
            None
        }
    }

    pub fn healthy(&self, r: &Rules) -> bool {
        self.failure(r).is_none() && self.present && self.ok_ms >= r.healthy_ms
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Mode {
    Auto,
    Manual(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// Umgeschaltet (automatisch oder manuell).
    Switched { from: String, to: String, auto: bool, reason: String },
    /// Alarm (`kind`: havarie, allDown, manualBad, recovered, sourceFailed).
    Alarm { kind: &'static str, text: String },
}

/// Gesamtzustand für die Anzeige.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Normal,
    /// Notquelle aktiv (Havarie).
    Havarie,
    /// Aktive Quelle gestört und nichts Gesundes verfügbar.
    AllDown,
}

pub struct Controller {
    pub rules: Rules,
    pub mode: Mode,
    pub active: String,
    pub health: Vec<(String, Health)>,
    /// Seit wann (ms Modellzeit) die aktive Quelle aktiv ist.
    since_ms: u64,
    now_ms: u64,
    /// Merker für Alarm-Flanken.
    all_down_alarmed: bool,
    manual_bad_alarmed: bool,
    pub takeovers: u64,
    pub log: VecDeque<(u64, String)>,
}

impl Controller {
    pub fn new(rules: Rules) -> Self {
        Controller {
            rules,
            mode: Mode::Auto,
            active: "main".to_string(),
            health: SOURCES.iter().map(|s| (s.to_string(), Health::default())).collect(),
            since_ms: 0,
            now_ms: 0,
            all_down_alarmed: false,
            manual_bad_alarmed: false,
            takeovers: 0,
            log: VecDeque::new(),
        }
    }

    fn h(&self, id: &str) -> &Health {
        &self.health.iter().find(|(n, _)| n == id).expect("bekannte Quelle").1
    }

    pub fn health_of(&self, id: &str) -> &Health {
        self.h(id)
    }

    pub fn status(&self) -> Status {
        let active_bad = self.h(&self.active).failure(&self.rules).is_some();
        if active_bad && self.best_other().is_none() {
            Status::AllDown
        } else if self.active != "main" {
            Status::Havarie
        } else if active_bad {
            Status::AllDown
        } else {
            Status::Normal
        }
    }

    /// Erste gesunde Quelle in Prioritätsreihenfolge, die nicht die aktive ist (Hauptsignal zählt zuerst, wenn `prefer_main`).
    fn best_other(&self) -> Option<String> {
        self.rules.order.iter().find(|s| **s != self.active && self.h(s).healthy(&self.rules)).cloned()
    }

    fn switch(&mut self, to: &str, auto: bool, reason: &str, ev: &mut Vec<Event>) {
        if self.active == to {
            return;
        }
        let from = std::mem::replace(&mut self.active, to.to_string());
        self.since_ms = self.now_ms;
        if to != "main" {
            self.takeovers += 1;
        }
        self.all_down_alarmed = false;
        self.manual_bad_alarmed = false;
        let text = format!("{} → {} ({}{})", label(&from), label(to), if auto { "automatisch: " } else { "manuell: " }, reason);
        self.push_log(text);
        ev.push(Event::Switched { from, to: to.to_string(), auto, reason: reason.to_string() });
    }

    fn push_log(&mut self, text: String) {
        self.log.push_back((self.now_ms, text));
        while self.log.len() > 200 {
            self.log.pop_front();
        }
    }

    /// Manuell auf eine Quelle schalten (auch auf das Hauptsignal).
    pub fn select(&mut self, source: &str) -> Result<Vec<Event>, String> {
        if !SOURCES.contains(&source) {
            return Err(format!("Quelle „{source}“ gibt es nicht"));
        }
        let mut ev = Vec::new();
        self.mode = Mode::Manual(source.to_string());
        self.switch(source, false, "Bedienung", &mut ev);
        Ok(ev)
    }

    /// Zurück in die Automatik (wählt sofort neu).
    pub fn auto(&mut self) -> Vec<Event> {
        self.mode = Mode::Auto;
        self.manual_bad_alarmed = false;
        self.push_log("Automatik eingeschaltet".to_string());
        Vec::new()
    }

    /// Ein Block (`dt_ms`) mit der Beobachtung je Quelle (Reihenfolge wie [`SOURCES`]).
    pub fn step(&mut self, dt_ms: u64, obs: &[Obs; N]) -> Vec<Event> {
        self.now_ms += dt_ms;
        let silence_db = self.rules.silence_db;
        for (i, (_, h)) in self.health.iter_mut().enumerate() {
            h.feed(dt_ms, &obs[i], silence_db);
        }
        let mut ev = Vec::new();
        let rules = self.rules.clone();
        let active_fail = self.h(&self.active).failure(&rules);
        match self.mode.clone() {
            Mode::Manual(_) => {
                if let Some(c) = active_fail {
                    if !self.manual_bad_alarmed {
                        self.manual_bad_alarmed = true;
                        let t = format!("manuell gewählte Quelle „{}“ gestört: {}", label(&self.active), c.text());
                        self.push_log(t.clone());
                        ev.push(Event::Alarm { kind: "manualBad", text: t });
                    }
                } else {
                    self.manual_bad_alarmed = false;
                }
            }
            Mode::Auto => {
                if let Some(c) = active_fail {
                    // aktive Quelle gestört: nächste gesunde nehmen (Hauptsignal zuerst, falls es nicht die gestörte ist, dann Reihenfolge)
                    let candidate = if self.active != "main" && self.h("main").healthy(&rules) { Some("main".to_string()) } else { self.best_other() };
                    match candidate {
                        Some(to) => {
                            let from_main = self.active == "main";
                            let text = format!("{} gestört: {}", label(&self.active), c.text());
                            if from_main {
                                self.push_log(text.clone());
                                ev.push(Event::Alarm { kind: "havarie", text: format!("Havarie: {text} — schalte auf {}", label(&to)) });
                            } else {
                                ev.push(Event::Alarm { kind: "sourceFailed", text: format!("Notquelle gestört: {text} — schalte auf {}", label(&to)) });
                            }
                            self.switch(&to, true, &text, &mut ev);
                        }
                        None => {
                            if !self.all_down_alarmed {
                                self.all_down_alarmed = true;
                                let t = format!("Alle Quellen gestört: {} ({}), keine gesunde Ersatzquelle", label(&self.active), c.text());
                                self.push_log(t.clone());
                                ev.push(Event::Alarm { kind: "allDown", text: t });
                            }
                        }
                    }
                } else {
                    self.all_down_alarmed = false;
                    // Rückkehr zum Hauptsignal
                    if self.active != "main" && rules.auto_return && self.now_ms.saturating_sub(self.since_ms) >= rules.min_hold_ms {
                        let m = self.h("main");
                        if m.failure(&rules).is_none() && m.present && m.ok_ms >= rules.return_ms {
                            ev.push(Event::Alarm { kind: "recovered", text: "Hauptsignal wieder da — Rückkehr".to_string() });
                            self.switch("main", true, "Hauptsignal wieder stabil", &mut ev);
                        }
                    }
                }
            }
        }
        ev
    }

    pub fn since_ms(&self) -> u64 {
        self.now_ms.saturating_sub(self.since_ms)
    }
}

/// Überblendung beim Quellenwechsel: zwei Blöcke (20 ms) von der alten zur neuen Quelle, danach nur noch die neue.
/// Wechselt die aktive Quelle mitten in der Überblendung, springt die Basis auf die bisherige Zielquelle (kein Rückfall auf die erste).
#[derive(Debug)]
pub struct Fader {
    cur: usize,
    to: usize,
    left: u32,
}

#[derive(Debug, PartialEq)]
pub enum Plan {
    Solo(usize),
    /// `block` 0 oder 1 der Überblendung von `from` nach `to`.
    Fade { from: usize, to: usize, block: u32 },
}

impl Fader {
    pub fn new(start: usize) -> Self {
        Fader { cur: start, to: start, left: 0 }
    }

    pub fn update(&mut self, active: usize) -> Plan {
        if active != self.to {
            self.cur = self.to;
            self.to = active;
            self.left = 2;
        }
        if self.left == 0 {
            return Plan::Solo(self.to);
        }
        let block = 2 - self.left;
        self.left -= 1;
        let from = self.cur;
        if self.left == 0 {
            self.cur = self.to;
        }
        Plan::Fade { from, to: self.to, block }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK: Obs = Obs { present: true, level_db: Some(-20.0), frozen: None, black: None };
    const SILENT: Obs = Obs { present: true, level_db: Some(-90.0), frozen: None, black: None };
    const GONE: Obs = Obs { present: false, level_db: None, frozen: None, black: None };

    /// Beobachtungen: main, n1, n2, n3, clip
    fn run(c: &mut Controller, secs: u64, obs: [Obs; N]) -> Vec<Event> {
        let mut all = Vec::new();
        for _ in 0..secs * 100 {
            all.extend(c.step(10, &obs));
        }
        all
    }

    fn switched(ev: &[Event]) -> Vec<(String, String)> {
        ev.iter().filter_map(|e| if let Event::Switched { from, to, .. } = e { Some((from.clone(), to.clone())) } else { None }).collect()
    }

    #[test]
    fn healthy_main_stays() {
        let mut c = Controller::new(Rules::default());
        let ev = run(&mut c, 30, [OK, OK, OK, OK, OK, OK]);
        assert!(ev.is_empty());
        assert_eq!(c.active, "main");
        assert_eq!(c.status(), Status::Normal);
    }

    #[test]
    fn main_gone_switches_to_first_healthy_notquelle_after_hold() {
        let mut c = Controller::new(Rules::default());
        run(&mut c, 3, [OK, OK, OK, OK, OK, OK]);
        // Hauptsignal weg: erst nach no_signal_ms (1,5 s) umschalten
        let ev = run(&mut c, 1, [GONE, OK, OK, OK, OK, OK]);
        assert!(switched(&ev).is_empty(), "noch innerhalb der Haltezeit");
        let ev = run(&mut c, 1, [GONE, OK, OK, OK, OK, OK]);
        assert_eq!(switched(&ev), vec![("main".to_string(), "n1".to_string())]);
        assert!(ev.iter().any(|e| matches!(e, Event::Alarm { kind: "havarie", .. })));
        assert_eq!(c.status(), Status::Havarie);
        assert_eq!(c.takeovers, 1);
    }

    #[test]
    fn silence_needs_its_hold_time_and_respects_priority_order() {
        let mut r = Rules::default();
        r.order = vec!["clip".into(), "n2".into()]; // Reihenfolge: zuerst Clip, dann Notquelle 2; n1 wird nicht benutzt
        let mut c = Controller::new(r);
        run(&mut c, 2, [OK, OK, OK, OK, OK, OK]);
        let ev = run(&mut c, 4, [SILENT, OK, OK, OK, OK, OK]);
        assert!(switched(&ev).is_empty(), "Stille < 5 s");
        let ev = run(&mut c, 2, [SILENT, OK, OK, OK, OK, OK]);
        assert_eq!(switched(&ev), vec![("main".to_string(), "clip".to_string())]);
    }

    #[test]
    fn skips_unhealthy_notquelle() {
        let mut c = Controller::new(Rules::default());
        run(&mut c, 2, [OK, OK, OK, OK, OK, OK]);
        let ev = run(&mut c, 3, [GONE, GONE, SILENT, OK, OK, OK]); // n1 weg, n2 still → n3
        assert_eq!(switched(&ev), vec![("main".to_string(), "n3".to_string())]);
    }

    #[test]
    fn all_down_alarms_once_and_stays() {
        let mut c = Controller::new(Rules::default());
        run(&mut c, 2, [OK, OK, OK, OK, OK, OK]);
        let ev = run(&mut c, 10, [GONE, GONE, GONE, GONE, GONE, GONE]);
        assert!(switched(&ev).is_empty());
        assert_eq!(ev.iter().filter(|e| matches!(e, Event::Alarm { kind: "allDown", .. })).count(), 1);
        assert_eq!(c.status(), Status::AllDown);
        // sobald eine Notquelle gesund ist, wird aufgeschaltet
        let ev = run(&mut c, 1, [GONE, GONE, OK, GONE, GONE, GONE]);
        assert_eq!(switched(&ev), vec![("main".to_string(), "n2".to_string())]);
    }

    #[test]
    fn returns_to_main_only_after_stable_and_min_hold() {
        let mut c = Controller::new(Rules::default());
        run(&mut c, 2, [OK, OK, OK, OK, OK, OK]);
        run(&mut c, 2, [GONE, OK, OK, OK, OK, OK]);
        assert_eq!(c.active, "n1");
        // Hauptsignal kommt zurück, ist aber noch nicht 3 s stabil
        let ev = run(&mut c, 2, [OK, OK, OK, OK, OK, OK]);
        assert!(switched(&ev).is_empty());
        let ev = run(&mut c, 2, [OK, OK, OK, OK, OK, OK]);
        assert_eq!(switched(&ev), vec![("n1".to_string(), "main".to_string())]);
        assert!(ev.iter().any(|e| matches!(e, Event::Alarm { kind: "recovered", .. })));
        assert_eq!(c.status(), Status::Normal);
    }

    #[test]
    fn flapping_main_does_not_return() {
        let mut c = Controller::new(Rules::default());
        run(&mut c, 2, [OK, OK, OK, OK, OK, OK]);
        run(&mut c, 2, [GONE, OK, OK, OK, OK, OK]);
        for _ in 0..5 {
            run(&mut c, 2, [OK, OK, OK, OK, OK, OK]); // 2 s gut …
            run(&mut c, 1, [GONE, OK, OK, OK, OK, OK]); // … dann wieder weg: setzt die Stabilitätszeit zurück
        }
        assert_eq!(c.active, "n1");
    }

    #[test]
    fn no_auto_return_when_disabled() {
        let mut r = Rules::default();
        r.auto_return = false;
        let mut c = Controller::new(r);
        run(&mut c, 2, [OK, OK, OK, OK, OK, OK]);
        run(&mut c, 2, [GONE, OK, OK, OK, OK, OK]);
        run(&mut c, 20, [OK, OK, OK, OK, OK, OK]);
        assert_eq!(c.active, "n1");
        c.select("main").unwrap();
        assert_eq!(c.active, "main");
    }

    #[test]
    fn failed_notquelle_moves_on_and_prefers_recovered_main() {
        let mut c = Controller::new(Rules::default());
        run(&mut c, 2, [OK, OK, OK, OK, OK, OK]);
        run(&mut c, 2, [GONE, OK, OK, OK, OK, OK]);
        assert_eq!(c.active, "n1");
        let ev = run(&mut c, 3, [GONE, GONE, OK, OK, OK, OK]); // n1 fällt aus → n2
        assert_eq!(switched(&ev), vec![("n1".to_string(), "n2".to_string())]);
        assert!(ev.iter().any(|e| matches!(e, Event::Alarm { kind: "sourceFailed", .. })));
        let ev = run(&mut c, 3, [OK, GONE, GONE, OK, OK, OK]); // n2 fällt aus, Hauptsignal inzwischen gesund → zurück zum Hauptsignal
        assert_eq!(switched(&ev), vec![("n2".to_string(), "main".to_string())]);
    }

    #[test]
    fn manual_overrides_and_alarms_on_bad_selection() {
        let mut c = Controller::new(Rules::default());
        run(&mut c, 2, [OK, OK, OK, OK, OK, OK]);
        let ev = c.select("n3").unwrap();
        assert_eq!(switched(&ev), vec![("main".to_string(), "n3".to_string())]);
        // Hauptsignal weg: bleibt auf n3 (manuell)
        let ev = run(&mut c, 5, [GONE, OK, OK, OK, OK, OK]);
        assert!(switched(&ev).is_empty());
        // n3 gestört: nur Alarm, keine Umschaltung
        let ev = run(&mut c, 3, [GONE, OK, OK, GONE, OK, OK]);
        assert!(switched(&ev).is_empty());
        assert_eq!(ev.iter().filter(|e| matches!(e, Event::Alarm { kind: "manualBad", .. })).count(), 1);
        // Automatik: sofort auf eine gesunde Quelle
        c.auto();
        let ev = run(&mut c, 1, [GONE, OK, OK, GONE, OK, OK]);
        assert_eq!(switched(&ev), vec![("n3".to_string(), "n1".to_string())]);
        assert!(c.select("quatsch").is_err());
    }

    #[test]
    fn freeze_is_a_failure_for_video_sources() {
        let mut c = Controller::new(Rules::default());
        let frozen = Obs { present: true, level_db: Some(-20.0), frozen: Some(true), black: None };
        let live = Obs { present: true, level_db: Some(-20.0), frozen: Some(false), black: None };
        for _ in 0..200 {
            c.step(10, &[live, live, live, live, live, live]);
        }
        let ev = run(&mut c, 4, [frozen, live, live, live, live, live]);
        assert!(switched(&ev).is_empty());
        let ev = run(&mut c, 2, [frozen, live, live, live, live, live]);
        assert_eq!(switched(&ev), vec![("main".to_string(), "n1".to_string())]);
    }

    #[test]
    fn black_picture_is_a_failure_and_still_image_can_be_the_last_resort() {
        let mut r = Rules::default();
        r.order = vec!["still".into()];
        let mut c = Controller::new(r);
        let black = Obs { present: true, level_db: Some(-20.0), frozen: Some(false), black: Some(true) };
        let ok = Obs { present: true, level_db: Some(-20.0), frozen: Some(false), black: Some(false) };
        for _ in 0..200 {
            c.step(10, &[ok, GONE, GONE, GONE, GONE, ok]);
        }
        let ev = run(&mut c, 4, [black, GONE, GONE, GONE, GONE, ok]);
        assert!(switched(&ev).is_empty(), "Schwarz < 5 s");
        let ev = run(&mut c, 2, [black, GONE, GONE, GONE, GONE, ok]);
        assert_eq!(switched(&ev), vec![("main".to_string(), "still".to_string())]);
        assert_eq!(c.health_of("main").failure(&c.rules), Some(Cause::Black));
    }

    #[test]
    fn fader_completes_the_crossfade_and_then_stays_on_the_target() {
        let mut f = Fader::new(0);
        assert_eq!(f.update(0), Plan::Solo(0));
        assert_eq!(f.update(5), Plan::Fade { from: 0, to: 5, block: 0 });
        // die Zielquelle bleibt gleich: zweiter Block, danach nur noch die neue Quelle (Regression: die Überblendung blieb am Anfang hängen)
        assert_eq!(f.update(5), Plan::Fade { from: 0, to: 5, block: 1 });
        for _ in 0..10 {
            assert_eq!(f.update(5), Plan::Solo(5));
        }
    }

    #[test]
    fn fader_switch_during_fade_restarts_from_the_previous_target() {
        let mut f = Fader::new(0);
        f.update(1);
        assert_eq!(f.update(2), Plan::Fade { from: 1, to: 2, block: 0 });
        assert_eq!(f.update(2), Plan::Fade { from: 1, to: 2, block: 1 });
        assert_eq!(f.update(2), Plan::Solo(2));
    }

    #[test]
    fn rules_validation() {
        assert!(Rules::default().validate().is_ok());
        let mut r = Rules::default();
        r.order = vec!["main".into()];
        assert!(r.validate().is_err());
        r.order = vec!["n1".into(), "n1".into()];
        assert!(r.validate().is_err());
        r.order = vec!["x".into()];
        assert!(r.validate().is_err());
        let mut r = Rules::default();
        r.silence_db = 5.0;
        assert!(r.validate().is_err());
        r.silence_db = -60.0;
        r.no_signal_ms = 10;
        assert!(r.validate().is_err());
    }
}
