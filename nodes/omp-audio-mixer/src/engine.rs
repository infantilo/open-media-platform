//! Automations-Engine (Kapitel 26): AutoMix + Ducking im 10-ms-Takt.
//!
//! Läuft auf einem eigenen Thread, liest die Detektor-Meter der Kanal-DSP
//! (`dsp::Meters`, vom Audio-Thread geschrieben) und schreibt ausschließlich
//! die Gain-*Anteile* (`auto_db`, `duck_db`, `group_db`) in den geteilten
//! Kanalzustand — niemals Fader oder Mute. Dadurch überschreibt die
//! Automation nie einen manuellen Eingriff; "manuell übersteuern" heißt:
//! Kanal auf `manual` setzen, dann laufen seine Anteile sanft auf 0 dB.
//!
//! Fail-Safe: Die Fader-Stufe ignoriert alle Engine-Anteile, wenn
//! `engine_beat_ms` älter als `dsp::ENGINE_TIMEOUT_MS` ist (Engine-Absturz);
//! ein Kanal mit veraltetem Detektor (>500 ms) zählt nicht mehr mit
//! (AutoMix: Ziel 0 dB, Ducking-Key: kein Signal).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::automation::{
    AutoMixEngine, AutoMixIn, AutoMixParams, DetectorKind, DuckEngine, DuckParams, SILENCE_DB,
};
use crate::dsp::{self, ChannelShared};
use crate::pipeline::SharedMap;
use crate::rules::{self, TransitionTracker};

pub const TICK_MS: f64 = 10.0;
/// Detektor älter als das → als ausgefallen behandeln.
const DETECTOR_STALE_MS: u64 = 500;

#[derive(Clone)]
pub struct GroupCfg {
    pub id: String,
    pub gain_db: f64,
    pub muted: bool,
    pub automix: AutoMixParams,
}

#[derive(Clone)]
pub struct ChanCfg {
    pub id: String,
    /// Gruppen-ID, leer = keine Gruppe.
    pub group: String,
    pub am_enabled: bool,
    pub weight: f64,
    pub priority: u8,
    pub sensitivity_db: f64,
    /// "Channel Manual": AutoMix/Ducking wirken nicht auf diesen Kanal.
    pub manual: bool,
    /// Darf dieser Kanal als Ducking-Target abgesenkt werden?
    pub duckable: bool,
    /// Auf den Programm-Bus geroutet.
    pub routed: bool,
}

#[derive(Clone)]
pub struct DuckCfg {
    pub id: String,
    pub enabled: bool,
    /// Kanal-IDs oder `group:<id>`.
    pub keys: Vec<String>,
    pub targets: Vec<String>,
    pub params: DuckParams,
}

#[derive(Clone, Default)]
pub struct EngineConfig {
    pub groups: Vec<GroupCfg>,
    pub chans: Vec<ChanCfg>,
    pub ducks: Vec<DuckCfg>,
}

pub type ConfigCell = Arc<Mutex<Arc<EngineConfig>>>;

pub fn new_config_cell() -> ConfigCell {
    Arc::new(Mutex::new(Arc::new(EngineConfig::default())))
}

fn detector_db(sh: &ChannelShared, kind: DetectorKind) -> f64 {
    let m = &sh.meters;
    (match kind {
        DetectorKind::Peak => m.peak_db.get(),
        DetectorKind::Rms => m.rms_db.get(),
        DetectorKind::ShortTerm => m.short_db.get(),
        DetectorKind::Speech => m.speech_db.get(),
    }) as f64
}

fn detector_alive(sh: &ChannelShared, now: u64) -> bool {
    now.saturating_sub(sh.meters.updated_ms.load(Ordering::Relaxed)) < DETECTOR_STALE_MS
}

fn resolve<'a>(cfg: &'a EngineConfig, sel: &str) -> Vec<&'a str> {
    if let Some(g) = sel.strip_prefix("group:") {
        cfg.chans.iter().filter(|c| c.group == g).map(|c| c.id.as_str()).collect()
    } else {
        cfg.chans.iter().filter(|c| c.id == sel).map(|c| c.id.as_str()).collect()
    }
}

/// Zustand der Engine (getrennt vom Thread, damit Schritte testbar sind).
#[derive(Default)]
pub struct EngineState {
    automix: HashMap<String, AutoMixEngine>,
    ducks: HashMap<String, DuckEngine>,
    /// Aktuelle Auto-Anteile von Kanälen ohne aktive AutoMix-Gruppe
    /// (laufen sanft auf 0 dB zurück).
    free_auto: HashMap<String, f64>,
    /// Geglätteter Duck-Anteil je Kanal (τ 80 ms): Umschalten von
    /// Manual/Regel-Enable erzeugt keinen Pegelsprung.
    duck_cur: HashMap<String, f64>,
    tracker: TransitionTracker,
}

impl EngineState {
    /// Ein Takt: liest Meter/Konfiguration, schreibt Anteile.
    pub fn tick(
        &mut self,
        dt_ms: f64,
        now: u64,
        cfg: &EngineConfig,
        shared: &HashMap<String, Arc<ChannelShared>>,
    ) -> Vec<rules::Event> {
        // Gruppen-Fader/-Mute + Lebenszeichen.
        let group_of = |id: &str| cfg.chans.iter().find(|c| c.id == id).map(|c| c.group.as_str()).unwrap_or("");
        for (id, sh) in shared {
            let g = cfg.groups.iter().find(|g| g.id == group_of(id));
            sh.group_db.set(g.map_or(0.0, |g| g.gain_db as f32));
            sh.group_muted.store(g.is_some_and(|g| g.muted), Ordering::Relaxed);
            sh.main_route.store(cfg.chans.iter().find(|c| &c.id == id).is_none_or(|c| c.routed), Ordering::Relaxed);
            sh.engine_beat_ms.store(now, Ordering::Relaxed);
        }

        // ───── AutoMix je Gruppe ─────
        let mut covered: HashSet<&str> = HashSet::new();
        self.automix.retain(|gid, _| cfg.groups.iter().any(|g| &g.id == gid && g.automix.enabled));
        for g in cfg.groups.iter().filter(|g| g.automix.enabled) {
            let members: Vec<&ChanCfg> = cfg.chans.iter().filter(|c| c.group == g.id && shared.contains_key(&c.id)).collect();
            let ins: Vec<(String, AutoMixIn)> = members
                .iter()
                .map(|c| {
                    let sh = &shared[&c.id];
                    let alive = detector_alive(sh, now);
                    let participate =
                        c.am_enabled && !c.manual && alive && !sh.muted.load(Ordering::Relaxed) && !g.muted;
                    (
                        c.id.clone(),
                        AutoMixIn {
                            level_db: if alive { detector_db(sh, g.automix.detector) } else { SILENCE_DB },
                            weight: c.weight,
                            priority: c.priority,
                            sensitivity_db: c.sensitivity_db,
                            participate,
                        },
                    )
                })
                .collect();
            let engine = self.automix.entry(g.id.clone()).or_default();
            for (id, gain) in engine.step(dt_ms, &g.automix, &ins) {
                shared[&id].auto_db.set(gain as f32);
                self.free_auto.remove(&id);
            }
            covered.extend(members.iter().map(|c| c.id.as_str()));
        }
        for (id, sh) in shared {
            if covered.contains(id.as_str()) {
                continue;
            }
            // Kein aktives AutoMix: Anteil sanft (τ 100 ms) auf 0 dB.
            let cur = *self.free_auto.entry(id.clone()).or_insert(sh.auto_db.get() as f64);
            let next = if cur.abs() < 0.01 { 0.0 } else { cur * (-dt_ms / 100.0).exp() };
            self.free_auto.insert(id.clone(), next);
            sh.auto_db.set(next as f32);
        }

        // ───── Ducking je Regel ─────
        self.ducks.retain(|rid, _| cfg.ducks.iter().any(|d| &d.id == rid));
        self.duck_cur.retain(|id, _| shared.contains_key(id));
        let mut acc: HashMap<&str, Vec<(f64, f64)>> = HashMap::new();
        for rule in &cfg.ducks {
            let keys: Vec<&str> = rule.keys.iter().flat_map(|k| resolve(cfg, k)).collect();
            let mut key_level = SILENCE_DB;
            if rule.enabled {
                for k in &keys {
                    let (Some(sh), Some(c)) = (shared.get(*k), cfg.chans.iter().find(|c| c.id == *k)) else {
                        continue;
                    };
                    // Nur hörbare Keys: stumm (Kanal/Gruppe) oder Detektor tot → kein Signal.
                    let group_muted = cfg.groups.iter().any(|g| g.id == c.group && g.muted);
                    if sh.muted.load(Ordering::Relaxed) || group_muted || !detector_alive(sh, now) {
                        continue;
                    }
                    let lvl = detector_db(sh, rule.params.detector) + sh.fader_db.get() as f64 + sh.group_db.get() as f64;
                    key_level = key_level.max(lvl);
                }
            }
            let engine = self.ducks.entry(rule.id.clone()).or_default();
            let gain = engine.step(dt_ms, &rule.params, key_level);
            if gain < -0.005 {
                for t in rule.targets.iter().flat_map(|t| resolve(cfg, t)) {
                    if keys.contains(&t) {
                        continue; // ein Kanal ducked sich nicht selbst
                    }
                    let Some(c) = cfg.chans.iter().find(|c| c.id == t) else { continue };
                    if c.duckable && !c.manual {
                        acc.entry(t).or_default().push((gain, rule.params.max_db));
                    }
                }
            }
        }
        for (id, sh) in shared {
            let v = acc.get(id.as_str()).map_or(0.0, |parts| {
                let sum: f64 = parts.iter().map(|(g, _)| g).sum();
                let floor = parts.iter().map(|(_, m)| *m).fold(0.0, f64::min);
                sum.max(floor)
            });
            let cur = self.duck_cur.entry(id.clone()).or_insert(0.0);
            *cur = if (v - *cur).abs() < 0.05 { v } else { *cur + (v - *cur) * (1.0 - (-dt_ms / 80.0).exp()) };
            sh.duck_db.set(*cur as f32);
        }

        // ───── On-Air + Übergangsereignisse ─────
        // On-Air ≠ Unmuted: aus dem tatsächlichen Zustand abgeleitet (Mute
        // von Kanal/Gruppe, Programm-Routing, Fader, AutoMix/Ducking).
        self.tracker.retain(|id| shared.contains_key(id));
        let mut events = Vec::new();
        for (id, sh) in shared {
            let group_muted = sh.group_muted.load(Ordering::Relaxed);
            let muted = sh.muted.load(Ordering::Relaxed);
            let routed = sh.main_route.load(Ordering::Relaxed);
            let air = rules::on_air(&rules::OnAirIn {
                muted,
                group_muted,
                routed,
                fader_db: sh.fader_db.get() as f64,
                effective_db: sh.effective_db(),
            });
            sh.on_air.store(air, Ordering::Relaxed);
            events.extend(self.tracker.update(id, muted || group_muted, sh.fader_db.get() as f64));
        }
        events
    }
}

/// Startet den Engine-Thread. `heartbeat` für den Node-LivenessMonitor.
pub fn spawn(
    config: ConfigCell,
    shared: SharedMap,
    shutdown: Arc<AtomicBool>,
    heartbeat: Arc<AtomicU64>,
    events: std::sync::mpsc::Sender<rules::Event>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut state = EngineState::default();
        while !shutdown.load(Ordering::Relaxed) {
            heartbeat.fetch_add(1, Ordering::Relaxed);
            let cfg = config.lock().expect("lock poisoned").clone();
            let snapshot: HashMap<String, Arc<ChannelShared>> = shared.lock().expect("lock poisoned").clone();
            for ev in state.tick(TICK_MS, dsp::now_ms(), &cfg, &snapshot) {
                let _ = events.send(ev);
            }
            std::thread::sleep(Duration::from_millis(TICK_MS as u64));
        }
    })
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;

    fn chan(id: &str, group: &str) -> ChanCfg {
        ChanCfg {
            id: id.into(),
            group: group.into(),
            am_enabled: true,
            weight: 1.0,
            priority: 0,
            sensitivity_db: -60.0,
            manual: false,
            duckable: true,
            routed: true,
        }
    }

    fn shared_with(levels: &[(&str, f32)]) -> HashMap<String, Arc<ChannelShared>> {
        levels
            .iter()
            .map(|(id, db)| {
                let sh = Arc::new(ChannelShared::new());
                for a in [&sh.meters.speech_db, &sh.meters.rms_db, &sh.meters.short_db, &sh.meters.peak_db] {
                    a.set(*db);
                }
                (id.to_string(), sh)
            })
            .collect()
    }

    fn touch(shared: &HashMap<String, Arc<ChannelShared>>) {
        for sh in shared.values() {
            sh.meters.updated_ms.store(dsp::now_ms(), Ordering::Relaxed);
        }
    }

    fn run(st: &mut EngineState, cfg: &EngineConfig, shared: &HashMap<String, Arc<ChannelShared>>, ms: u32) {
        for _ in 0..(ms / 10) {
            touch(shared);
            st.tick(10.0, dsp::now_ms(), cfg, shared);
        }
    }

    fn automix_cfg(chans: Vec<ChanCfg>) -> EngineConfig {
        EngineConfig {
            groups: vec![GroupCfg {
                id: "studio".into(),
                gain_db: 0.0,
                muted: false,
                automix: AutoMixParams { enabled: true, ..AutoMixParams::default() },
            }],
            chans,
            ducks: vec![],
        }
    }

    #[test]
    fn on_air_is_derived_from_route_mute_and_effective_level_and_emits_transitions() {
        let shared = shared_with(&[("m1", -20.0)]);
        let mut cfg = automix_cfg(vec![chan("m1", "")]);
        let mut st = EngineState::default();
        run(&mut st, &cfg, &shared, 100);
        assert!(shared["m1"].on_air.load(Ordering::Relaxed));
        // unmuted, aber nicht auf Programm geroutet → nicht on air (und kein Mute-Ereignis)
        cfg.chans[0].routed = false;
        touch(&shared);
        let ev = st.tick(10.0, dsp::now_ms(), &cfg, &shared);
        assert!(!shared["m1"].on_air.load(Ordering::Relaxed));
        assert!(ev.is_empty(), "Routing ist kein Mute: {ev:?}");
        cfg.chans[0].routed = true;
        run(&mut st, &cfg, &shared, 20);
        assert!(shared["m1"].on_air.load(Ordering::Relaxed));
        // Mute → Ereignis + nicht on air; Unmute → Ereignis
        shared["m1"].muted.store(true, Ordering::Relaxed);
        touch(&shared);
        let ev = st.tick(10.0, dsp::now_ms(), &cfg, &shared);
        assert_eq!(ev, vec![rules::Event::ChannelMuted("m1".into())]);
        assert!(!shared["m1"].on_air.load(Ordering::Relaxed));
        shared["m1"].muted.store(false, Ordering::Relaxed);
        let ev = st.tick(10.0, dsp::now_ms(), &cfg, &shared);
        assert_eq!(ev, vec![rules::Event::ChannelUnmuted("m1".into())]);
        // Gruppen-Mute zählt ebenfalls.
        let mut g = automix_cfg(vec![chan("m1", "studio")]);
        g.groups[0].muted = true;
        let ev = st.tick(10.0, dsp::now_ms(), &g, &shared);
        assert_eq!(ev, vec![rules::Event::ChannelMuted("m1".into())]);
        assert!(!shared["m1"].on_air.load(Ordering::Relaxed));
    }

    #[test]
    fn automix_in_engine_attenuates_quiet_mics_only_in_group() {
        let shared = shared_with(&[("m1", -20.0), ("m2", -55.0), ("stadium", -10.0)]);
        let cfg = automix_cfg(vec![chan("m1", "studio"), chan("m2", "studio"), chan("stadium", "")]);
        let mut st = EngineState::default();
        run(&mut st, &cfg, &shared, 4000);
        assert!(shared["m1"].auto_db.get() > -1.0);
        assert!(shared["m2"].auto_db.get() < -10.0);
        // Nicht zur Gruppe gehörig → unberührt.
        assert_eq!(shared["stadium"].auto_db.get(), 0.0);
        // Fader bleibt unangetastet.
        assert_eq!(shared["m2"].fader_db.get(), 0.0);
    }

    #[test]
    fn manual_and_muted_channels_are_excluded_and_return_to_unity() {
        let shared = shared_with(&[("m1", -20.0), ("m2", -20.0)]);
        let mut cfg = automix_cfg(vec![chan("m1", "studio"), chan("m2", "studio")]);
        let mut st = EngineState::default();
        run(&mut st, &cfg, &shared, 3000);
        assert!(shared["m1"].auto_db.get() < -3.0);
        cfg.chans[1].manual = true;
        run(&mut st, &cfg, &shared, 4000);
        assert!(shared["m2"].auto_db.get().abs() < 0.2, "manual → 0 dB");
        assert!(shared["m1"].auto_db.get() > -0.5, "m1 bekommt den vollen Anteil");
    }

    #[test]
    fn stale_detector_fails_safe_to_unity() {
        let shared = shared_with(&[("m1", -20.0), ("m2", -55.0)]);
        let cfg = automix_cfg(vec![chan("m1", "studio"), chan("m2", "studio")]);
        let mut st = EngineState::default();
        run(&mut st, &cfg, &shared, 3000);
        assert!(shared["m2"].auto_db.get() < -10.0);
        // Detektoren melden sich nicht mehr (kein touch).
        for sh in shared.values() {
            sh.meters.updated_ms.store(dsp::now_ms().saturating_sub(5000), Ordering::Relaxed);
        }
        for _ in 0..500 {
            st.tick(10.0, dsp::now_ms(), &cfg, &shared);
        }
        assert!(shared["m2"].auto_db.get().abs() < 0.3, "{}", shared["m2"].auto_db.get());
    }

    #[test]
    fn group_gain_and_mute_are_applied_without_touching_channel_state() {
        let shared = shared_with(&[("m1", -20.0)]);
        let mut cfg = automix_cfg(vec![chan("m1", "studio")]);
        cfg.groups[0].gain_db = -6.0;
        cfg.groups[0].muted = true;
        let mut st = EngineState::default();
        run(&mut st, &cfg, &shared, 50);
        assert_eq!(shared["m1"].group_db.get(), -6.0);
        assert!(shared["m1"].group_muted.load(Ordering::Relaxed));
        assert!(!shared["m1"].muted.load(Ordering::Relaxed));
        assert_eq!(shared["m1"].fader_db.get(), 0.0);
    }

    fn duck_cfg() -> EngineConfig {
        EngineConfig {
            groups: vec![],
            chans: vec![chan("comm", ""), chan("atmo", ""), chan("music", "")],
            ducks: vec![DuckCfg {
                id: "d1".into(),
                enabled: true,
                keys: vec!["comm".into()],
                targets: vec!["atmo".into()],
                params: DuckParams::default(),
            }],
        }
    }

    #[test]
    fn ducking_reduces_only_the_target_when_key_speaks() {
        let shared = shared_with(&[("comm", -20.0), ("atmo", -15.0), ("music", -15.0)]);
        let cfg = duck_cfg();
        let mut st = EngineState::default();
        run(&mut st, &cfg, &shared, 3000);
        assert!((shared["atmo"].duck_db.get() - -8.0).abs() < 0.5);
        assert_eq!(shared["music"].duck_db.get(), 0.0);
        assert_eq!(shared["comm"].duck_db.get(), 0.0, "Key ducked sich nicht selbst");
        assert_eq!(shared["atmo"].fader_db.get(), 0.0, "Fader unangetastet");
        // Kommentator verstummt → Atmo kommt langsam zurück.
        shared["comm"].meters.speech_db.set(-90.0);
        run(&mut st, &cfg, &shared, 800);
        assert!(shared["atmo"].duck_db.get() < -6.0, "Hold/ruhige Rückkehr");
        run(&mut st, &cfg, &shared, 8000);
        assert!(shared["atmo"].duck_db.get().abs() < 0.1);
    }

    #[test]
    fn muted_key_or_disabled_rule_or_manual_target_does_not_duck() {
        let shared = shared_with(&[("comm", -20.0), ("atmo", -15.0), ("music", -15.0)]);
        let mut cfg = duck_cfg();
        shared["comm"].muted.store(true, Ordering::Relaxed);
        let mut st = EngineState::default();
        run(&mut st, &cfg, &shared, 2000);
        assert_eq!(shared["atmo"].duck_db.get(), 0.0, "stummer Key löst nichts aus");
        shared["comm"].muted.store(false, Ordering::Relaxed);
        cfg.chans[1].manual = true;
        run(&mut st, &cfg, &shared, 2000);
        assert_eq!(shared["atmo"].duck_db.get(), 0.0, "Manual-Kanal wird nicht geduckt");
        cfg.chans[1].manual = false;
        cfg.ducks[0].enabled = false;
        run(&mut st, &cfg, &shared, 200);
        // Regel aus: kein Sprung, die Absenkung läuft ruhig aus.
        let d = shared["atmo"].duck_db.get();
        assert!(d <= 0.0);
        run(&mut st, &cfg, &shared, 9000);
        assert!(shared["atmo"].duck_db.get().abs() < 0.06);
    }

    #[test]
    fn two_rules_stack_but_stay_within_max() {
        let shared = shared_with(&[("comm", -20.0), ("comm2", -20.0), ("atmo", -15.0)]);
        let mut cfg = duck_cfg();
        cfg.chans.push(chan("comm2", ""));
        let mut second = cfg.ducks[0].clone();
        second.id = "d2".into();
        second.keys = vec!["comm2".into()];
        second.params.amount_db = -10.0;
        cfg.ducks[0].params.amount_db = -10.0;
        cfg.ducks[0].params.max_db = -14.0;
        second.params.max_db = -14.0;
        cfg.ducks.push(second);
        let mut st = EngineState::default();
        run(&mut st, &cfg, &shared, 6000);
        let d = shared["atmo"].duck_db.get();
        assert!((-14.01..-12.0).contains(&d), "{d}");
    }

    #[test]
    fn duck_target_by_group_and_engine_failsafe_in_fader_stage() {
        let shared = shared_with(&[("comm", -20.0), ("atmo", -15.0), ("music", -15.0)]);
        let mut cfg = duck_cfg();
        cfg.chans[1].group = "bed".into();
        cfg.chans[2].group = "bed".into();
        cfg.ducks[0].targets = vec!["group:bed".into()];
        let mut st = EngineState::default();
        run(&mut st, &cfg, &shared, 3000);
        assert!(shared["atmo"].duck_db.get() < -7.0 && shared["music"].duck_db.get() < -7.0);
        // Engine stirbt: Beat wird alt → Fader-Stufe ignoriert die Anteile.
        shared["atmo"].engine_beat_ms.store(dsp::now_ms().saturating_sub(5000), Ordering::Relaxed);
        assert!((dsp::lin_to_db(shared["atmo"].total_gain())).abs() < 1e-3);
    }
}
