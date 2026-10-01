//! Deklarative Automations-Regeln des Audiomischers (Kapitel 26): Media-Player-
//! Automation, On-Air-Ableitung und Video→Audio-Kontext.
//!
//! Prinzip (Vorgabe "Media Automation von Audio-Logik trennen"): Audio-Code
//! ruft nie direkt `mediaPlayer.play()` auf. Stattdessen entstehen aus
//! Zustandsänderungen abstrakte [`Event`]s; die Regeln eines Kanals
//! ([`ChannelAutomation`]) bilden Event → [`Action`] ab, und erst ein
//! Ausführer (`media.rs`) übersetzt die Aktion auf das konkrete Ziel. Alles
//! hier ist reine Logik ohne I/O und damit testbar.

use std::collections::HashMap;

use serde_json::{Value, json};

/// Was eine Regel auslösen kann.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Action {
    None,
    Play,
    Resume,
    Pause,
    Stop,
}

impl Action {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "none" => Action::None,
            "play" => Action::Play,
            "resume" => Action::Resume,
            "pause" => Action::Pause,
            "stop" => Action::Stop,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Action::None => "none",
            Action::Play => "play",
            Action::Resume => "resume",
            Action::Pause => "pause",
            Action::Stop => "stop",
        }
    }

    /// Mögliche Methodenaufrufe auf einem Ziel-Node, in Präferenz-Reihenfolge.
    /// Welche davon es gibt, entscheidet der Ausführer anhand des
    /// Descriptors des Ziels — unterschiedliche Player-Typen bieten
    /// unterschiedliche Methoden an (`play`/`take`/`stop`/`setRate`).
    pub fn candidates(self) -> Vec<(&'static str, Value)> {
        match self {
            Action::None => vec![],
            Action::Play => vec![("play", json!({})), ("take", json!({}))],
            Action::Resume => vec![("resume", json!({})), ("play", json!({})), ("setRate", json!({"rate": 1.0}))],
            Action::Pause => vec![("pause", json!({})), ("setRate", json!({"rate": 0.0}))],
            Action::Stop => vec![("stop", json!({}))],
        }
    }
}

/// Auslöser einer Regel.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Trigger {
    /// Kanal wird entstummt (Kanal- oder Gruppen-Mute fällt weg).
    Unmute,
    Mute,
    /// Fader wird über die Öffnungsschwelle gezogen.
    FaderOpen,
    FaderClose,
    SceneActivate,
    VideoActive,
    VideoInactive,
}

impl Trigger {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "unmute" => Trigger::Unmute,
            "mute" => Trigger::Mute,
            "fader_open" => Trigger::FaderOpen,
            "fader_close" => Trigger::FaderClose,
            "scene_activate" => Trigger::SceneActivate,
            "video_active" => Trigger::VideoActive,
            "video_inactive" => Trigger::VideoInactive,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::Unmute => "unmute",
            Trigger::Mute => "mute",
            Trigger::FaderOpen => "fader_open",
            Trigger::FaderClose => "fader_close",
            Trigger::SceneActivate => "scene_activate",
            Trigger::VideoActive => "video_active",
            Trigger::VideoInactive => "video_inactive",
        }
    }
}

/// Konkretes Ereignis aus dem Mixer bzw. dem Video-/Szenen-Kontext.
#[derive(Clone, PartialEq, Debug)]
pub enum Event {
    ChannelUnmuted(String),
    ChannelMuted(String),
    FaderOpened(String),
    FaderClosed(String),
    SceneActivated(String),
    VideoActive(String),
    VideoInactive(String),
}

#[derive(Clone, PartialEq, Debug)]
pub struct Rule {
    pub trigger: Trigger,
    pub action: Action,
    /// Nur für `SceneActivate`: Szenen-ID, leer = jede Szene.
    pub scene: String,
    /// Nur für `Video*`: Node-ID der Videoquelle, leer = jede.
    pub source: String,
}

/// Deklarative Automation eines Kanals.
#[derive(Clone, PartialEq, Debug)]
pub struct ChannelAutomation {
    /// "Automation On/Off" — aus = Regeln werden ignoriert (Operator-Override).
    pub enabled: bool,
    /// Label des Ziel-Nodes (Media Player); leer = nicht verbunden.
    pub target: String,
    pub rules: Vec<Rule>,
}

impl Default for ChannelAutomation {
    fn default() -> Self {
        ChannelAutomation { enabled: true, target: String::new(), rules: vec![] }
    }
}

impl ChannelAutomation {
    pub fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "target": self.target,
            "rules": self.rules.iter().map(|r| json!({
                "trigger": r.trigger.as_str(), "action": r.action.as_str(),
                "scene": r.scene, "source": r.source,
            })).collect::<Vec<_>>(),
        })
    }

    /// Fehlende Felder → Defaults; ungültige Regeln werden verworfen.
    pub fn from_json(d: &Value) -> Self {
        let mut a = ChannelAutomation {
            enabled: d.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            target: d.get("target").and_then(Value::as_str).unwrap_or("").to_string(),
            rules: vec![],
        };
        if let Some(list) = d.get("rules").and_then(Value::as_array) {
            for r in list {
                let (Some(t), Some(ac)) = (
                    r.get("trigger").and_then(Value::as_str).and_then(Trigger::parse),
                    r.get("action").and_then(Value::as_str).and_then(Action::parse),
                ) else {
                    continue;
                };
                a.rules.push(Rule {
                    trigger: t,
                    action: ac,
                    scene: r.get("scene").and_then(Value::as_str).unwrap_or("").to_string(),
                    source: r.get("source").and_then(Value::as_str).unwrap_or("").to_string(),
                });
            }
        }
        a
    }

    /// Aktionen, die dieses Ereignis für Kanal `channel_id` auslöst. Nur
    /// Kanalereignisse (Mute/Fader) gelten für *den eigenen* Kanal; Szenen-
    /// und Videoereignisse gelten für alle Kanäle.
    pub fn actions_for(&self, channel_id: &str, ev: &Event) -> Vec<Action> {
        if !self.enabled || self.target.is_empty() {
            return vec![];
        }
        let matches = |r: &Rule| -> bool {
            match (r.trigger, ev) {
                (Trigger::Unmute, Event::ChannelUnmuted(c)) => c == channel_id,
                (Trigger::Mute, Event::ChannelMuted(c)) => c == channel_id,
                (Trigger::FaderOpen, Event::FaderOpened(c)) => c == channel_id,
                (Trigger::FaderClose, Event::FaderClosed(c)) => c == channel_id,
                (Trigger::SceneActivate, Event::SceneActivated(s)) => r.scene.is_empty() || &r.scene == s,
                (Trigger::VideoActive, Event::VideoActive(n)) => r.source.is_empty() || &r.source == n,
                (Trigger::VideoInactive, Event::VideoInactive(n)) => r.source.is_empty() || &r.source == n,
                _ => false,
            }
        };
        self.rules.iter().filter(|r| matches(r) && r.action != Action::None).map(|r| r.action).collect()
    }
}

// ───────────────────────────── On-Air ─────────────────────────────

/// Fader unter diesem Wert gilt als zu (nicht hörbar).
pub const FADER_OPEN_DB: f64 = -50.0;

/// Eingangsdaten der On-Air-Ableitung eines Kanals.
#[derive(Clone, Copy, Debug)]
pub struct OnAirIn {
    pub muted: bool,
    pub group_muted: bool,
    /// Kanal ist auf den Programm-Bus geroutet (`mainRoute`).
    pub routed: bool,
    pub fader_db: f64,
    /// Fader + Gruppe + AutoMix + Ducking (dB): effektiver Pegel im Programm.
    pub effective_db: f64,
}

/// On-Air ≠ Unmuted: ein Kanal ist nur dann on air, wenn er tatsächlich
/// hörbar im Programm ankommt — nicht stumm (Kanal/Gruppe), auf den
/// Programm-Bus geroutet und mit hörbarem effektivem Pegel (Fader, Gruppe,
/// AutoMix und Ducking eingerechnet).
pub fn on_air(i: &OnAirIn) -> bool {
    !i.muted && !i.group_muted && i.routed && i.fader_db > FADER_OPEN_DB && i.effective_db > FADER_OPEN_DB
}

#[derive(Default)]
struct ChanTrack {
    muted: Option<bool>,
    fader_open: Option<bool>,
}

/// Erkennt Mute-/Fader-Übergänge je Kanal und liefert [`Event`]s. Der erste
/// Aufruf je Kanal setzt nur den Ausgangszustand (kein Startereignis).
#[derive(Default)]
pub struct TransitionTracker {
    chans: HashMap<String, ChanTrack>,
}

impl TransitionTracker {
    pub fn update(&mut self, id: &str, muted_effective: bool, fader_db: f64) -> Vec<Event> {
        let t = self.chans.entry(id.to_string()).or_default();
        let open = fader_db > FADER_OPEN_DB;
        let mut out = vec![];
        if let Some(prev) = t.muted
            && prev != muted_effective
        {
            out.push(if muted_effective {
                Event::ChannelMuted(id.to_string())
            } else {
                Event::ChannelUnmuted(id.to_string())
            });
        }
        if let Some(prev) = t.fader_open
            && prev != open
        {
            out.push(if open { Event::FaderOpened(id.to_string()) } else { Event::FaderClosed(id.to_string()) });
        }
        t.muted = Some(muted_effective);
        t.fader_open = Some(open);
        out
    }

    pub fn retain(&mut self, keep: impl Fn(&str) -> bool) {
        self.chans.retain(|k, _| keep(k));
    }
}

// ───────────────────────────── Video → Audio-Kontext ─────────────────────────────

/// Abbildung "Videoquelle aktiv → Audio-Szene": das Audio-System bekommt
/// Kontext ("Kamera 1 ist im Programm"), nicht Einzelbefehle wie "Mic 1 unmute".
#[derive(Clone, PartialEq, Debug)]
pub struct ContextRule {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    /// Node-ID der Videoquelle (Tally-Bus-Subject `omp.tally.<node_id>`).
    pub source: String,
    /// Audio-Szene, die aktiviert wird, wenn die Quelle aktiv wird.
    pub scene: String,
}

impl ContextRule {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "label": self.label, "enabled": self.enabled, "source": self.source, "scene": self.scene})
    }
    pub fn from_json(d: &Value) -> Option<Self> {
        Some(ContextRule {
            id: d.get("id")?.as_str()?.to_string(),
            label: d.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
            enabled: d.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            source: d.get("source").and_then(Value::as_str).unwrap_or("").to_string(),
            scene: d.get("scene").and_then(Value::as_str).unwrap_or("").to_string(),
        })
    }
}

/// Aktueller Audio-Kontext, aus dem Video-System abgeleitet.
#[derive(Default, Clone, PartialEq, Debug)]
pub struct AudioContext {
    pub active_sources: Vec<String>,
    pub active_scene: String,
}

impl AudioContext {
    /// Tally-Meldung der Videoquelle `node` (an/aus) verarbeiten: Kontext
    /// aktualisieren und die Szene zurückgeben, die jetzt zu aktivieren ist
    /// (nur beim Einschalten und nur, wenn eine aktive Regel passt).
    pub fn on_video(&mut self, rules: &[ContextRule], node: &str, on: bool) -> Option<String> {
        if on {
            if !self.active_sources.iter().any(|s| s == node) {
                self.active_sources.push(node.to_string());
            }
            let scene = rules.iter().find(|r| r.enabled && r.source == node && !r.scene.is_empty())?.scene.clone();
            self.active_scene = scene.clone();
            Some(scene)
        } else {
            self.active_sources.retain(|s| s != node);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(t: Trigger, a: Action) -> Rule {
        Rule { trigger: t, action: a, scene: String::new(), source: String::new() }
    }

    fn auto(rules: Vec<Rule>) -> ChannelAutomation {
        ChannelAutomation { enabled: true, target: "Player 1".into(), rules }
    }

    #[test]
    fn declarative_unmute_play_and_mute_pause() {
        let a = auto(vec![rule(Trigger::Unmute, Action::Play), rule(Trigger::Mute, Action::Pause)]);
        assert_eq!(a.actions_for("ch1", &Event::ChannelUnmuted("ch1".into())), vec![Action::Play]);
        assert_eq!(a.actions_for("ch1", &Event::ChannelMuted("ch1".into())), vec![Action::Pause]);
        // Ereignis eines anderen Kanals betrifft diesen nicht.
        assert!(a.actions_for("ch1", &Event::ChannelUnmuted("ch2".into())).is_empty());
    }

    #[test]
    fn all_actions_resume_stop_and_none() {
        let a = auto(vec![
            rule(Trigger::SceneActivate, Action::Resume),
            rule(Trigger::FaderClose, Action::Stop),
            rule(Trigger::FaderOpen, Action::None),
        ]);
        assert_eq!(a.actions_for("c", &Event::SceneActivated("s".into())), vec![Action::Resume]);
        assert_eq!(a.actions_for("c", &Event::FaderClosed("c".into())), vec![Action::Stop]);
        assert!(a.actions_for("c", &Event::FaderOpened("c".into())).is_empty(), "None löst nichts aus");
    }

    #[test]
    fn scene_and_video_filters() {
        let mut r1 = rule(Trigger::SceneActivate, Action::Resume);
        r1.scene = "football".into();
        let mut r2 = rule(Trigger::VideoActive, Action::Play);
        r2.source = "cam1".into();
        let a = auto(vec![r1, r2]);
        assert_eq!(a.actions_for("c", &Event::SceneActivated("football".into())), vec![Action::Resume]);
        assert!(a.actions_for("c", &Event::SceneActivated("studio".into())).is_empty());
        assert_eq!(a.actions_for("c", &Event::VideoActive("cam1".into())), vec![Action::Play]);
        assert!(a.actions_for("c", &Event::VideoActive("cam2".into())).is_empty());
        assert!(a.actions_for("c", &Event::VideoInactive("cam1".into())).is_empty());
    }

    #[test]
    fn disabled_automation_or_missing_target_is_inert() {
        let mut a = auto(vec![rule(Trigger::Unmute, Action::Play)]);
        a.enabled = false;
        assert!(a.actions_for("c", &Event::ChannelUnmuted("c".into())).is_empty(), "Operator-Override");
        a.enabled = true;
        a.target.clear();
        assert!(a.actions_for("c", &Event::ChannelUnmuted("c".into())).is_empty(), "kein Ziel → sicher");
    }

    #[test]
    fn json_roundtrip_drops_invalid_rules_and_defaults() {
        let a = auto(vec![rule(Trigger::Unmute, Action::Play), rule(Trigger::VideoActive, Action::Resume)]);
        assert_eq!(ChannelAutomation::from_json(&a.to_json()), a);
        let b = ChannelAutomation::from_json(&json!({"rules":[{"trigger":"quatsch","action":"play"},{"trigger":"mute","action":"pause"}]}));
        assert!(b.enabled);
        assert_eq!(b.rules.len(), 1);
        assert_eq!(ChannelAutomation::from_json(&json!({})), ChannelAutomation::default());
    }

    #[test]
    fn action_candidates_cover_player_variants() {
        let names = |a: Action| a.candidates().into_iter().map(|(n, _)| n).collect::<Vec<_>>();
        assert_eq!(names(Action::Play), vec!["play", "take"]);
        assert_eq!(names(Action::Pause), vec!["pause", "setRate"]);
        assert!(names(Action::None).is_empty());
        assert_eq!(Action::Pause.candidates()[1].1, json!({"rate": 0.0}));
    }

    #[test]
    fn on_air_is_not_just_unmuted() {
        let base = OnAirIn { muted: false, group_muted: false, routed: true, fader_db: 0.0, effective_db: 0.0 };
        assert!(on_air(&base));
        assert!(!on_air(&OnAirIn { muted: true, ..base }));
        assert!(!on_air(&OnAirIn { group_muted: true, ..base }), "Gruppen-Mute");
        // unmuted, aber nicht auf Programm geroutet → NICHT on air
        assert!(!on_air(&OnAirIn { routed: false, ..base }));
        // Fader zu
        assert!(!on_air(&OnAirIn { fader_db: -60.0, ..base }));
        // durch AutoMix/Ducking praktisch weggeregelt
        assert!(!on_air(&OnAirIn { effective_db: -70.0, ..base }));
        // leicht abgesenkt (AutoMix −10) bleibt on air
        assert!(on_air(&OnAirIn { effective_db: -10.0, ..base }));
    }

    #[test]
    fn transition_tracker_emits_only_on_change() {
        let mut t = TransitionTracker::default();
        assert!(t.update("c", true, -60.0).is_empty(), "erster Wert = Ausgangszustand");
        assert!(t.update("c", true, -60.0).is_empty());
        assert_eq!(t.update("c", false, -60.0), vec![Event::ChannelUnmuted("c".into())]);
        assert_eq!(t.update("c", false, -10.0), vec![Event::FaderOpened("c".into())]);
        assert_eq!(
            t.update("c", true, -70.0),
            vec![Event::ChannelMuted("c".into()), Event::FaderClosed("c".into())]
        );
        t.retain(|k| k != "c");
        assert!(t.update("c", false, 0.0).is_empty(), "nach Entfernen wieder Ausgangszustand");
    }

    #[test]
    fn video_context_maps_source_to_scene_not_to_mic_commands() {
        let rules = vec![
            ContextRule { id: "r1".into(), label: "Cam 1".into(), enabled: true, source: "cam1".into(), scene: "studio-a".into() },
            ContextRule { id: "r2".into(), label: "Cam 2".into(), enabled: true, source: "cam2".into(), scene: "studio-a".into() },
            ContextRule { id: "r3".into(), label: "Stadion".into(), enabled: false, source: "cam3".into(), scene: "stadium".into() },
        ];
        let mut ctx = AudioContext::default();
        assert_eq!(ctx.on_video(&rules, "cam1", true), Some("studio-a".into()));
        assert_eq!(ctx.active_scene, "studio-a");
        // Kamera 2 → dieselbe Szene (die AutoMix-Gruppe bleibt unabhängig bestehen).
        assert_eq!(ctx.on_video(&rules, "cam2", true), Some("studio-a".into()));
        // deaktivierte Regel / unbekannte Quelle → keine Szene
        assert_eq!(ctx.on_video(&rules, "cam3", true), None);
        assert_eq!(ctx.on_video(&rules, "cam9", true), None);
        // Ausschalten aktiviert nichts, aktualisiert aber den Kontext.
        assert_eq!(ctx.on_video(&rules, "cam1", false), None);
        assert!(!ctx.active_sources.contains(&"cam1".to_string()));
        assert_eq!(ContextRule::from_json(&rules[0].to_json()).unwrap(), rules[0]);
    }
}
