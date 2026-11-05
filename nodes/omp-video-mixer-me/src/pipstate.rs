//! Store-seitige PIP-Logik (Kapitel 87, `docs/ENTWURF-PIP-MEHRFACH-2D.md`): Szenen (vormals "PIP-Presets"), Zustand
//! je Slot, Fokus. Die Funktionen `plan_*` ändern den Store-Zustand und liefern die **Aktionen**, die der Aufrufer
//! danach an die Pipeline schickt — so bleibt die Entscheidungslogik ohne GStreamer testbar.

use serde_json::Value;

use crate::pip::{PipPose, default_focus_pose, hit_test};
use crate::pipeline::{DveBox, PipelineHandle};

/// z-Wert des fokussierten Slots: über allen regulären Slots (4 … 4 + Slots − 1).
pub const FOCUS_Z: u32 = 200;
/// Standarddauer der Fokusfahrt.
pub const FOCUS_MS: u32 = 500;

pub fn base_z(slot: usize) -> u32 {
    4 + slot as u32
}

/// Ein Slot einer Szene: Quelle, Halteposition, optionale Fahrt-Positionen, Dauern, z-Wert, Fokusposition.
#[derive(Debug, Clone, PartialEq)]
pub struct PipEntry {
    pub slot: usize,
    pub sender_id: Option<String>,
    pub pose: PipPose,
    pub start: Option<PipPose>,
    pub end: Option<PipPose>,
    pub in_ms: u32,
    pub out_ms: u32,
    pub z: Option<u32>,
    pub focus: Option<PipPose>,
}

impl PipEntry {
    /// Ziel der Ausfahrt (`end`, sonst `start`), `None` = kein Ausfahren.
    pub fn exit_pose(&self) -> Option<PipPose> {
        self.end.or(self.start)
    }
}

/// Szene = Menge von Slot-Einträgen, die zusammen ein- und ausgefahren werden.
#[derive(Debug, Clone, PartialEq)]
pub struct PipPreset {
    pub id: String,
    pub name: String,
    pub entries: Vec<PipEntry>,
}

fn opt_pose_json(p: &Option<PipPose>) -> Value {
    p.map_or(Value::Null, PipPose::to_json)
}

pub fn entry_to_json(e: &PipEntry) -> Value {
    serde_json::json!({
        "slot": e.slot,
        "senderId": e.sender_id,
        "pose": e.pose.to_json(),
        "start": opt_pose_json(&e.start),
        "end": opt_pose_json(&e.end),
        "inMs": e.in_ms,
        "outMs": e.out_ms,
        "z": e.z,
        "focus": opt_pose_json(&e.focus),
    })
}

pub fn entry_from_json(v: &Value) -> Option<PipEntry> {
    let pose = PipPose::from_json(v.get("pose").or_else(|| v.get("box"))?)?;
    let opt = |k: &str| v.get(k).filter(|x| !x.is_null()).and_then(PipPose::from_json);
    let ms = |k: &str| v.get(k).and_then(Value::as_f64).filter(|x| x.is_finite()).map_or(0, |x| x.clamp(0.0, 60_000.0) as u32);
    Some(PipEntry {
        slot: v.get("slot").and_then(Value::as_u64).unwrap_or(0) as usize,
        sender_id: v.get("senderId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
        pose,
        start: opt("start"),
        end: opt("end"),
        in_ms: ms("inMs"),
        out_ms: ms("outMs"),
        z: v.get("z").and_then(Value::as_u64).map(|z| z as u32),
        focus: opt("focus"),
    })
}

/// JSON einer Szene: `entries` plus die flachen Altfelder des ersten Eintrags (Stream Deck und alte Oberflächen
/// lesen `senderId`/`box`/`start`/`end`/`inMs`/`outMs`).
pub fn preset_to_json(p: &PipPreset) -> Value {
    let mut v = serde_json::json!({
        "id": p.id,
        "name": p.name,
        "entries": p.entries.iter().map(entry_to_json).collect::<Vec<_>>(),
    });
    if let Some(first) = p.entries.first() {
        let m = v.as_object_mut().expect("object");
        m.insert("senderId".into(), serde_json::json!(first.sender_id));
        m.insert("box".into(), box_json(&first.pose.bounds()));
        m.insert("start".into(), first.start.map_or(Value::Null, |s| box_json(&s.bounds())));
        m.insert("end".into(), first.end.map_or(Value::Null, |s| box_json(&s.bounds())));
        m.insert("inMs".into(), serde_json::json!(first.in_ms));
        m.insert("outMs".into(), serde_json::json!(first.out_ms));
    }
    v
}

fn box_json(b: &DveBox) -> Value {
    serde_json::json!({"x": b.x, "y": b.y, "width": b.width, "height": b.height})
}

/// Szene aus JSON: mit `entries`, sonst (Altformat) ein Eintrag für Slot 0 aus den flachen Feldern.
pub fn preset_from_json(v: &Value) -> Option<PipPreset> {
    let id = v.get("id")?.as_str()?.to_string();
    let name = v.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    let entries = match v.get("entries").and_then(Value::as_array) {
        Some(list) => list.iter().filter_map(entry_from_json).collect(),
        None => vec![entry_from_json(v)?],
    };
    Some(PipPreset { id, name, entries })
}

#[derive(Debug, Clone)]
pub struct SlotState {
    pub enabled: bool,
    pub source: Option<String>,
    /// Zuletzt gemeldete Pose der Pipeline (Anfang/Ende einer Fahrt).
    pub pose: PipPose,
    /// Ruhepose: dorthin kehrt der Slot nach einem Fokus zurück.
    pub hold: PipPose,
    pub focus_pose: PipPose,
    pub z: u32,
    pub scene_z: u32,
}

#[derive(Debug, Clone)]
pub struct LevelPips {
    pub slots: Vec<SlotState>,
    pub focused: Option<usize>,
    /// Die ersten `two_d` Slots haben ein Transform-Element (Trapez/Rotation).
    two_d: usize,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Source(usize, Option<String>),
    Pose(usize, PipPose),
    Enable(usize, bool),
    Z(usize, u32),
    Animate { slot: usize, from: Option<PipPose>, to: PipPose, ms: u32, then_disable: bool, z_during: Option<u32>, z_after: Option<u32> },
}

impl Action {
    pub fn run(&self, h: &PipelineHandle, level: usize) {
        match self {
            Action::Source(s, src) => h.set_pip_source(level, *s, src.clone()),
            Action::Pose(s, p) => h.set_dve_box(level, *s, *p),
            Action::Enable(s, on) => h.set_pip_enabled(level, *s, *on),
            Action::Z(s, z) => h.set_pip_z(level, *s, *z),
            Action::Animate { slot, from, to, ms, then_disable, z_during, z_after } => {
                h.pip_animate(level, *slot, *from, *to, *ms as u64, *then_disable, *z_during, *z_after)
            }
        }
    }
}

impl LevelPips {
    pub fn new(slots: usize, two_d: usize, width: u32, height: u32) -> Self {
        let full = PipPose::from_box(&DveBox::full_frame(width, height));
        LevelPips {
            slots: (0..slots.max(1))
                .map(|s| SlotState {
                    enabled: false,
                    source: None,
                    pose: full,
                    hold: full,
                    focus_pose: default_focus_pose(width, height),
                    z: base_z(s),
                    scene_z: base_z(s),
                })
                .collect(),
            focused: None,
            two_d,
            width,
            height,
        }
    }

    /// Pose, auf die ein Klick zielt: fokussiert → Fokuspose, sonst Ruhepose (unabhängig vom Fahrtstand).
    pub fn target_pose(&self, slot: usize) -> PipPose {
        let s = &self.slots[slot];
        if self.focused == Some(slot) { s.focus_pose } else { s.hold }
    }

    /// Szene einschalten: alle Einträge gleichzeitig (mit Einfahrt, falls definiert); andere Slots gehen aus.
    pub fn plan_apply(&mut self, preset: &PipPreset) -> Vec<Action> {
        let mut out = Vec::new();
        self.focused = None;
        let in_scene: Vec<usize> = preset.entries.iter().map(|e| e.slot).collect();
        for slot in 0..self.slots.len() {
            if !in_scene.contains(&slot) && self.slots[slot].enabled {
                out.push(Action::Enable(slot, false));
                self.slots[slot].enabled = false;
            }
        }
        let slot_count = self.slots.len();
        for e in preset.entries.iter().filter(|e| e.slot < slot_count) {
            let st = &mut self.slots[e.slot];
            let z = e.z.unwrap_or_else(|| base_z(e.slot));
            st.source = e.sender_id.clone();
            st.hold = e.pose;
            st.focus_pose = e.focus.unwrap_or_else(|| default_focus_pose(self.width, self.height));
            st.z = z;
            st.scene_z = z;
            st.enabled = true;
            out.push(Action::Source(e.slot, e.sender_id.clone()));
            out.push(Action::Z(e.slot, z));
            match e.start {
                Some(from) if e.in_ms > 0 => {
                    // Reihenfolge ist wichtig: `Enable` zählt den Animationszähler des Slots hoch und würde eine bereits
                    // gestartete Einfahrt sofort abbrechen (das PIP bliebe an der Startposition stehen, außerhalb des
                    // Bildes). Darum erst Startpose setzen und einschalten, die Einfahrt zuletzt.
                    out.push(Action::Pose(e.slot, from));
                    out.push(Action::Enable(e.slot, true));
                    out.push(Action::Animate { slot: e.slot, from: Some(from), to: e.pose, ms: e.in_ms, then_disable: false, z_during: None, z_after: None });
                }
                _ => {
                    out.push(Action::Pose(e.slot, e.pose));
                    out.push(Action::Enable(e.slot, true));
                }
            }
        }
        out
    }

    /// Ausschalten: `slot == None` = alle eingeschalteten Slots. Hat die aktive Szene für den Slot eine Ausfahrt,
    /// fährt er dorthin und schaltet sich danach selbst ab.
    pub fn plan_disable(&mut self, slot: Option<usize>, active: Option<&PipPreset>) -> Vec<Action> {
        let mut out = Vec::new();
        let targets: Vec<usize> = match slot {
            Some(s) if s < self.slots.len() => vec![s],
            Some(_) => vec![],
            None => (0..self.slots.len()).collect(),
        };
        for s in targets {
            if !self.slots[s].enabled {
                continue;
            }
            let exit = active.and_then(|p| p.entries.iter().find(|e| e.slot == s)).and_then(|e| e.exit_pose().filter(|_| e.out_ms > 0).map(|x| (x, e.out_ms)));
            if self.focused == Some(s) {
                self.focused = None;
            }
            match exit {
                Some((to, ms)) => out.push(Action::Animate { slot: s, from: None, to, ms, then_disable: true, z_during: None, z_after: Some(self.slots[s].scene_z) }),
                None => {
                    out.push(Action::Z(s, self.slots[s].scene_z));
                    out.push(Action::Enable(s, false));
                }
            }
            self.slots[s].enabled = false;
        }
        out
    }

    fn back_to_hold(&mut self, slot: usize, ms: u32) -> Action {
        let st = &self.slots[slot];
        Action::Animate { slot, from: None, to: st.hold, ms, then_disable: false, z_during: None, z_after: Some(st.scene_z) }
    }

    pub fn plan_focus(&mut self, slot: usize, ms: u32) -> Vec<Action> {
        if slot >= self.slots.len() || !self.slots[slot].enabled || self.focused == Some(slot) {
            return Vec::new();
        }
        let mut out = Vec::new();
        if let Some(prev) = self.focused.take() {
            out.push(self.back_to_hold(prev, ms));
        }
        let st = &mut self.slots[slot];
        st.z = FOCUS_Z;
        out.push(Action::Animate { slot, from: None, to: st.focus_pose, ms, then_disable: false, z_during: Some(FOCUS_Z), z_after: Some(FOCUS_Z) });
        self.focused = Some(slot);
        out
    }

    pub fn plan_unfocus(&mut self, ms: u32) -> Vec<Action> {
        match self.focused.take() {
            Some(prev) => vec![self.back_to_hold(prev, ms)],
            None => Vec::new(),
        }
    }

    pub fn plan_toggle(&mut self, slot: usize, ms: u32) -> Vec<Action> {
        if self.focused == Some(slot) { self.plan_unfocus(ms) } else { self.plan_focus(slot, ms) }
    }

    /// Klick im PGM-Bild (Mischer-Pixel): oberster getroffener, eingeschalteter Slot wird umgeschaltet.
    /// Ist ein Slot fokussiert und der Klick trifft ihn nicht (oder nichts), passiert nichts — ein Klick ins
    /// Leere soll nie versehentlich etwas verstellen.
    pub fn plan_click(&mut self, x: f64, y: f64, ms: u32) -> Option<(usize, Vec<Action>)> {
        let candidates: Vec<(usize, PipPose, u32)> = (0..self.slots.len())
            .filter(|&s| self.slots[s].enabled)
            .map(|s| (s, self.target_pose(s), if self.focused == Some(s) { FOCUS_Z } else { self.slots[s].scene_z }))
            .collect();
        let hit = hit_test(&candidates, x, y)?;
        Some((hit, self.plan_toggle(hit, ms)))
    }

    pub fn slots_json(&self) -> Value {
        Value::Array(
            self.slots
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    serde_json::json!({
                        "slot": i,
                        "enabled": s.enabled,
                        "senderId": s.source,
                        "pose": self.target_pose(i).to_json(),
                        "holdPose": s.hold.to_json(),
                        "focusPose": s.focus_pose.to_json(),
                        "z": s.z,
                        "focused": self.focused == Some(i),
                        "twoD": i < self.two_d,
                        "rect": self.target_pose(i).is_rect(),
                    })
                })
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pose(x: i32, y: i32, w: i32, h: i32) -> PipPose {
        PipPose::from_box(&DveBox { x, y, width: w, height: h })
    }

    fn entry(slot: usize, p: PipPose) -> PipEntry {
        PipEntry { slot, sender_id: Some(format!("s{slot}")), pose: p, start: None, end: None, in_ms: 0, out_ms: 0, z: None, focus: None }
    }

    fn scene3() -> PipPreset {
        PipPreset {
            id: "sc".into(),
            name: "drei".into(),
            entries: vec![entry(0, pose(0, 0, 300, 200)), entry(1, pose(400, 0, 300, 200)), entry(2, pose(800, 0, 300, 200))],
        }
    }

    #[test]
    fn apply_enables_all_entries_and_disables_the_rest() {
        let mut l = LevelPips::new(4, 2, 1280, 720);
        l.slots[3].enabled = true;
        let acts = l.plan_apply(&scene3());
        assert!(acts.contains(&Action::Enable(3, false)));
        for s in 0..3 {
            assert!(acts.contains(&Action::Enable(s, true)));
            assert!(acts.contains(&Action::Source(s, Some(format!("s{s}")))));
            assert!(l.slots[s].enabled);
        }
        assert!(!l.slots[3].enabled);
    }

    #[test]
    fn apply_with_start_animates_instead_of_hard_pose() {
        let mut l = LevelPips::new(2, 0, 1280, 720);
        let mut e = entry(0, pose(0, 0, 100, 100));
        e.start = Some(pose(-100, 0, 100, 100));
        e.in_ms = 400;
        let acts = l.plan_apply(&PipPreset { id: "a".into(), name: "a".into(), entries: vec![e] });
        assert!(acts.iter().any(|a| matches!(a, Action::Animate { slot: 0, from: Some(_), ms: 400, then_disable: false, .. })));
        // Die Zielpose wird nicht hart gesetzt; nur die Startpose (vor dem Einschalten).
        assert!(!acts.contains(&Action::Pose(0, pose(0, 0, 100, 100))));
    }

    #[test]
    fn apply_with_start_enables_before_the_entry_animation() {
        // Regression (Nutzerfund 2026-11-05): `Enable` nach `Animate` brach die Einfahrt ab, das PIP erschien nie.
        let mut l = LevelPips::new(2, 0, 1280, 720);
        let mut e = entry(0, pose(0, 0, 100, 100));
        e.start = Some(pose(-100, 0, 100, 100));
        e.in_ms = 400;
        let acts = l.plan_apply(&PipPreset { id: "a".into(), name: "a".into(), entries: vec![e] });
        let enable = acts.iter().position(|a| *a == Action::Enable(0, true)).expect("enable");
        let animate = acts.iter().position(|a| matches!(a, Action::Animate { slot: 0, .. })).expect("animate");
        assert!(enable < animate, "Enable muss vor Animate laufen: {acts:?}");
        assert_eq!(acts.last(), acts.get(animate), "Animate ist die letzte Aktion des Slots");
    }

    #[test]
    fn click_focuses_hit_slot_and_second_click_returns() {
        let mut l = LevelPips::new(4, 2, 1280, 720);
        l.plan_apply(&scene3());
        let (hit, acts) = l.plan_click(450.0, 50.0, 500).expect("treffer");
        assert_eq!(hit, 1);
        assert_eq!(l.focused, Some(1));
        match &acts[0] {
            Action::Animate { slot: 1, to, z_during: Some(FOCUS_Z), z_after: Some(FOCUS_Z), .. } => assert_eq!(to.bounds().width, 1204),
            other => panic!("unerwartet: {other:?}"),
        }
        // Fokus-Pose ist jetzt Klickziel: Mitte des Bildes trifft den fokussierten Slot, dessen Ruhepose nicht mehr
        let (hit2, acts2) = l.plan_click(640.0, 360.0, 500).expect("treffer");
        assert_eq!(hit2, 1);
        assert_eq!(l.focused, None);
        assert!(matches!(&acts2[0], Action::Animate { slot: 1, from: None, z_during: None, z_after: Some(5), .. }));
    }

    #[test]
    fn click_on_nothing_changes_nothing() {
        let mut l = LevelPips::new(4, 2, 1280, 720);
        l.plan_apply(&scene3());
        assert!(l.plan_click(1200.0, 700.0, 500).is_none());
        assert_eq!(l.focused, None);
    }

    #[test]
    fn focusing_another_slot_sends_previous_back() {
        let mut l = LevelPips::new(4, 2, 1280, 720);
        l.plan_apply(&scene3());
        l.plan_focus(0, 500);
        let acts = l.plan_focus(2, 500);
        assert_eq!(acts.len(), 2);
        assert!(matches!(&acts[0], Action::Animate { slot: 0, z_after: Some(4), .. }));
        assert!(matches!(&acts[1], Action::Animate { slot: 2, z_during: Some(FOCUS_Z), .. }));
        assert_eq!(l.focused, Some(2));
    }

    #[test]
    fn focus_ignores_disabled_slots_and_repeat() {
        let mut l = LevelPips::new(2, 0, 1280, 720);
        assert!(l.plan_focus(0, 500).is_empty());
        l.plan_apply(&PipPreset { id: "a".into(), name: "a".into(), entries: vec![entry(0, pose(0, 0, 100, 100))] });
        assert_eq!(l.plan_focus(0, 500).len(), 1);
        assert!(l.plan_focus(0, 500).is_empty());
    }

    #[test]
    fn disable_uses_exit_animation_and_clears_focus() {
        let mut l = LevelPips::new(2, 0, 1280, 720);
        let mut e = entry(0, pose(0, 0, 100, 100));
        e.end = Some(pose(2000, 0, 100, 100));
        e.out_ms = 300;
        let scene = PipPreset { id: "a".into(), name: "a".into(), entries: vec![e, entry(1, pose(500, 0, 100, 100))] };
        l.plan_apply(&scene);
        l.plan_focus(0, 500);
        let acts = l.plan_disable(None, Some(&scene));
        assert!(acts.iter().any(|a| matches!(a, Action::Animate { slot: 0, then_disable: true, ms: 300, .. })));
        assert!(acts.contains(&Action::Enable(1, false)));
        assert_eq!(l.focused, None);
        assert!(l.slots.iter().all(|s| !s.enabled));
    }

    #[test]
    fn disabling_one_slot_leaves_others() {
        let mut l = LevelPips::new(4, 2, 1280, 720);
        l.plan_apply(&scene3());
        let acts = l.plan_disable(Some(1), None);
        assert_eq!(acts, vec![Action::Z(1, 5), Action::Enable(1, false)]);
        assert!(l.slots[0].enabled && l.slots[2].enabled);
    }

    #[test]
    fn json_roundtrip_and_legacy_flat_format() {
        let mut e = entry(2, pose(1, 2, 30, 40));
        e.start = Some(pose(0, 0, 10, 10));
        e.in_ms = 250;
        e.z = Some(9);
        e.focus = Some(pose(5, 5, 500, 300));
        let p = PipPreset { id: "x".into(), name: "n".into(), entries: vec![e] };
        assert_eq!(preset_from_json(&preset_to_json(&p)), Some(p));

        let legacy = serde_json::json!({"id": "old", "name": "Alt", "senderId": "abc", "box": {"x": 1, "y": 2, "width": 3, "height": 4},
            "start": null, "end": {"x": 9, "y": 9, "width": 3, "height": 4}, "inMs": 0, "outMs": 200});
        let p = preset_from_json(&legacy).unwrap();
        assert_eq!(p.entries.len(), 1);
        assert_eq!(p.entries[0].slot, 0);
        assert_eq!(p.entries[0].sender_id.as_deref(), Some("abc"));
        assert_eq!(p.entries[0].out_ms, 200);
        assert!(p.entries[0].end.is_some());
    }
}
