//! Semantisches Audio-Routing (UMSETZUNG.md Kapitel 27 / P6; Spec §32–41, §100–101,
//! §155, §263).
//!
//! Ein Mixer-Kanal trägt eine **Erwartung** (Tags: z. B. `role.commentator`), nicht
//! eine feste Sender-ID. Sobald ein **Quell-Kontext** gesetzt ist (z. B. „Programm-
//! Video ist Remote X“), wählt der Mixer für jeden Kanal mit Erwartung die passende
//! Audioquelle desselben Kontexts. Ein Event kann pro Kanal ausdrücklich
//! überschreiben (Rangfolge §263: Event > Kanal-Erwartung).
//!
//! Dieses Modul ist reine Logik (keine Pipeline, kein Netz): [`plan`] liefert nur,
//! was der Mixer tun würde. Das Anwenden (und das Merken der vorherigen manuellen
//! Zuordnung, §101) macht `main.rs`.
//!
//! Konflikte (zwei Kanäle erwarten dieselbe Quelle, §155) werden NICHT still
//! entschieden: betroffene Kanäle bleiben unverändert und werden gemeldet.

use std::collections::BTreeMap;

use omp_resolver::audio::{AudioChoice, TagRule, audio_capabilities};
use omp_resolver::{MediaType, Selector, Source, SourceContext, resolve};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Aktiver Quell-Kontext (aus `setSourceContext`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveContext {
    /// Anzeigename der Quelle (nur UI).
    pub label: String,
    pub context: SourceContext,
    /// Ausdrückliche Event-Wahl je Kanal.
    #[serde(default)]
    pub overrides: BTreeMap<String, AudioChoice>,
}

/// Wodurch die Zuordnung eines Kanals zustande kam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Event,
    ChannelExpectation,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Assignment {
    pub channel: String,
    /// `None`: nichts Passendes — Kanal bleibt unverändert (kein stiller Ersatz).
    #[serde(rename = "senderId")]
    pub sender_id: Option<String>,
    pub origin: Origin,
    /// Klartext-Begründung bzw. Warnung.
    pub explain: String,
    /// Nur Event-Override gescheitert / Mehrdeutigkeit usw.
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Conflict {
    #[serde(rename = "senderId")]
    pub sender_id: String,
    pub channels: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Plan {
    pub assignments: Vec<Assignment>,
    pub conflicts: Vec<Conflict>,
}

impl Plan {
    /// Kanäle, die wegen eines Konflikts nicht angewendet werden dürfen.
    pub fn in_conflict(&self, channel: &str) -> bool {
        self.conflicts.iter().any(|c| c.channels.iter().any(|ch| ch == channel))
    }
}

fn selector_for(rule: &TagRule, ctx: &SourceContext) -> Selector {
    Selector {
        media_type: Some(MediaType::Audio),
        required: rule.required.clone(),
        preferred: rule.preferred.clone(),
        forbidden: rule.forbidden.clone(),
        context: Some(ctx.clone()),
        ..Default::default()
    }
}

fn by_rule(rule: &TagRule, ctx: &SourceContext, sources: &[Source], what: &str) -> (Option<String>, String, Option<String>) {
    let res = resolve(&selector_for(rule, ctx), sources);
    let warning = if res.selected_id.is_none() {
        Some(format!("{what}: keine Quelle erfüllt {}", rule.required.join(", ")))
    } else if res.ambiguous {
        Some(format!("{what}: mehrere Quellen passen gleich gut"))
    } else {
        None
    };
    (res.selected_id.clone(), res.explain(), warning)
}

/// Plant die Zuordnung aller Kanäle mit Erwartung bzw. Event-Override.
/// `expects`: Kanal → Erwartung (nur Kanäle, die der Mixer kennt).
pub fn plan(expects: &BTreeMap<String, TagRule>, active: &ActiveContext, sources: &[Source]) -> Plan {
    let ctx = &active.context;
    // Der Kontext ist hier ein HARTER Filter (der Resolver nutzt ihn nur als Rang):
    // ein Kanal darf nie still auf Audio einer fremden Quelle springen.
    let scoped: Vec<Source> = sources.iter().filter(|s| ctx.matches(s)).cloned().collect();
    let sources = scoped.as_slice();
    let caps = audio_capabilities(sources, ctx);
    let mut channels: Vec<&String> = expects.keys().chain(active.overrides.keys()).collect();
    channels.sort();
    channels.dedup();

    let mut assignments = Vec::new();
    for ch in channels {
        let a = match active.overrides.get(ch) {
            Some(AudioChoice::Capability { id }) => match caps.iter().find(|c| &c.id == id) {
                Some(c) => Assignment {
                    channel: ch.clone(),
                    sender_id: Some(c.sender_id.clone()),
                    origin: Origin::Event,
                    explain: format!("Event wählt „{id}“ → {} ({})", c.label, c.sender_id),
                    warning: None,
                },
                None => Assignment {
                    channel: ch.clone(),
                    sender_id: None,
                    origin: Origin::Event,
                    explain: format!("Event wählt „{id}“, die Quelle bietet es nicht an"),
                    warning: Some(format!("Audio „{id}“ wird von dieser Quelle nicht angeboten")),
                },
            },
            Some(AudioChoice::Tags(rule)) => {
                let (sender_id, explain, warning) = by_rule(rule, ctx, sources, "Event-Tags");
                Assignment { channel: ch.clone(), sender_id, origin: Origin::Event, explain, warning }
            }
            None => {
                let (sender_id, explain, warning) = by_rule(&expects[ch], ctx, sources, "Kanal-Erwartung");
                Assignment { channel: ch.clone(), sender_id, origin: Origin::ChannelExpectation, explain, warning }
            }
        };
        assignments.push(a);
    }

    let mut by_sender: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for a in &assignments {
        if let Some(id) = &a.sender_id {
            by_sender.entry(id).or_default().push(a.channel.clone());
        }
    }
    let conflicts = by_sender
        .into_iter()
        .filter(|(_, ch)| ch.len() > 1)
        .map(|(id, channels)| Conflict { sender_id: id.to_string(), channels })
        .collect();
    Plan { assignments, conflicts }
}

/// Laufzeitzustand des Routings (Mixer-weit, hinter einem Mutex).
/// Persistiert werden nur die Erwartungen (`expects`); Kontext, Pins und Merkzettel
/// sind Laufzeit — nach einem Neustart gibt es keinen Kontext, die Kanäle behalten
/// ihre zuletzt gespeicherte Quelle.
#[derive(Debug, Default)]
pub struct RoutingState {
    pub expects: BTreeMap<String, TagRule>,
    pub active: Option<ActiveContext>,
    /// Kanal → manuelle Quelle (Sender-ID, leer = intern) VOR der ersten Auto-Zuordnung (§101).
    pub restore: BTreeMap<String, String>,
    /// Kanäle, die der Operator nach der Auto-Zuordnung von Hand umgestellt hat.
    pub pinned: std::collections::BTreeSet<String>,
    /// Zuletzt ausgewertete Quellenliste von `GET /api/v1/sources` (nur Audio).
    pub sources: Vec<Source>,
    pub sources_at_ms: u64,
    pub last_plan: Option<Plan>,
}

impl RoutingState {
    pub fn expects_json(&self) -> Value {
        Value::Object(self.expects.iter().map(|(k, r)| (k.clone(), serde_json::to_value(r).unwrap_or(Value::Null))).collect())
    }

    pub fn view(&self) -> Value {
        serde_json::json!({
            "expects": self.expects_json(),
            "context": self.active,
            "pinned": self.pinned,
            "restore": self.restore,
            "plan": self.last_plan,
            "sourcesKnown": self.sources.len(),
            "sourcesAtMs": self.sources_at_ms,
        })
    }
}

/// `{"required":[…],"preferred":[…],"forbidden":[…]}` → Regel; leer = keine Erwartung.
pub fn parse_rule(v: &Value) -> Option<TagRule> {
    let rule: TagRule = serde_json::from_value(v.clone()).ok()?;
    if rule == TagRule::default() { None } else { Some(rule) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omp_resolver::{SourceTag, TagOrigin};

    fn audio(id: &str, node: &str, tags: &[&str]) -> Source {
        Source {
            sender_id: id.to_string(),
            label: format!("Audio {id}"),
            node_id: node.to_string(),
            node_label: node.to_string(),
            workflow_id: String::new(),
            media_type: Some(MediaType::Audio),
            group_hint: String::new(),
            channel_count: 2,
            online: true,
            visible: true,
            selectable: true,
            tags: tags.iter().map(|t| SourceTag { tag: t.to_string(), origin: TagOrigin::Explicit }).collect(),
        }
    }

    fn rule(required: &[&str]) -> TagRule {
        TagRule { required: required.iter().map(|s| s.to_string()).collect(), ..Default::default() }
    }

    fn ctx(node: &str) -> ActiveContext {
        ActiveContext {
            label: node.to_string(),
            context: SourceContext { node_id: node.to_string(), group: String::new() },
            overrides: BTreeMap::new(),
        }
    }

    fn sources() -> Vec<Source> {
        vec![
            audio("x-prog", "x", &["role.program"]),
            audio("x-comm", "x", &["role.commentator"]),
            audio("y-prog", "y", &["role.program"]),
        ]
    }

    #[test]
    fn channels_follow_their_expectation_within_the_context() {
        let expects = BTreeMap::from([("ch1".to_string(), rule(&["role.program"])), ("ch2".to_string(), rule(&["role.commentator"]))]);
        let p = plan(&expects, &ctx("x"), &sources());
        assert_eq!(p.assignments[0].sender_id.as_deref(), Some("x-prog"));
        assert_eq!(p.assignments[1].sender_id.as_deref(), Some("x-comm"));
        assert!(p.conflicts.is_empty());
        // Anderer Kontext: dieselben Kanäle, andere Quellen — nie die fremde.
        let p = plan(&expects, &ctx("y"), &sources());
        assert_eq!(p.assignments[0].sender_id.as_deref(), Some("y-prog"));
        assert_eq!(p.assignments[1].sender_id, None, "Y hat keinen Kommentator: nichts, kein stiller Ersatz");
        assert!(p.assignments[1].warning.is_some());
    }

    #[test]
    fn event_override_beats_channel_expectation() {
        let expects = BTreeMap::from([("ch1".to_string(), rule(&["role.program"]))]);
        let mut a = ctx("x");
        a.overrides.insert("ch1".to_string(), AudioChoice::Capability { id: "commentator".to_string() });
        let p = plan(&expects, &a, &sources());
        assert_eq!(p.assignments[0].sender_id.as_deref(), Some("x-comm"));
        assert_eq!(p.assignments[0].origin, Origin::Event);
    }

    #[test]
    fn failed_event_override_does_not_fall_back_silently() {
        let expects = BTreeMap::from([("ch1".to_string(), rule(&["role.program"]))]);
        let mut a = ctx("x");
        a.overrides.insert("ch1".to_string(), AudioChoice::Capability { id: "international".to_string() });
        let p = plan(&expects, &a, &sources());
        assert_eq!(p.assignments[0].sender_id, None);
        assert!(p.assignments[0].warning.as_deref().unwrap().contains("international"));
    }

    #[test]
    fn override_without_channel_expectation_still_applies() {
        let mut a = ctx("x");
        a.overrides.insert("ch9".to_string(), AudioChoice::Tags(rule(&["role.commentator"])));
        let p = plan(&BTreeMap::new(), &a, &sources());
        assert_eq!(p.assignments.len(), 1);
        assert_eq!(p.assignments[0].sender_id.as_deref(), Some("x-comm"));
    }

    #[test]
    fn two_channels_expecting_the_same_source_are_a_conflict() {
        let expects = BTreeMap::from([("ch1".to_string(), rule(&["role.program"])), ("ch2".to_string(), rule(&["role.program"]))]);
        let p = plan(&expects, &ctx("x"), &sources());
        assert_eq!(p.conflicts.len(), 1);
        assert_eq!(p.conflicts[0].channels, vec!["ch1", "ch2"]);
        assert!(p.in_conflict("ch1") && !p.in_conflict("ch3"));
    }

    #[test]
    fn offline_sources_are_not_chosen() {
        let mut s = sources();
        s[1].online = false;
        let expects = BTreeMap::from([("ch2".to_string(), rule(&["role.commentator"]))]);
        let p = plan(&expects, &ctx("x"), &s);
        assert_eq!(p.assignments[0].sender_id, None);
    }

    #[test]
    fn parse_rule_treats_empty_as_none() {
        assert_eq!(parse_rule(&serde_json::json!({})), None);
        assert_eq!(parse_rule(&serde_json::json!({"required": ["role.program"]})), Some(rule(&["role.program"])));
    }
}
