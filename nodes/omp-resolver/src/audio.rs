//! Audio-Capabilities einer Quelle und die Auflösung der Audio-Absicht eines
//! Playlist-Events (UMSETZUNG.md Kapitel 27 / P5; Spec §26–31, §94–99, §261–265).
//!
//! Eine Quelle (z. B. „Remote Feed X“) besteht aus mehreren Audio-Flows mit
//! Rollen (`role.program`, `role.commentator`, `role.international`). Jeder
//! dieser Flows ist eine [`AudioCapability`] — der Playlist-Editor bietet NUR
//! diese an, nicht alle globalen Presets (Spec §30). Reine Logik, keine
//! Netz-/Zustandsabhängigkeit.
//!
//! **Rangfolge der Audio-Auflösung (Spec §263):**
//!   1. ausdrückliche Wahl des Events (`capability`),
//!   2. erwartete Tags des Events (`expected`),
//!   3. Kanal-Präferenz (`channel_preference`, eine Rolle),
//!   4. Quell-Default (Tag `audio.default`; bei GENAU einer Capability wird diese
//!      vorgewählt, bei mehreren ohne Default keine willkürliche Wahl, Spec §260),
//!   5. globaler Fallback (`global_default`),
//!   6. sonst: Operator entscheidet.
//!
//! Wählt das Event ausdrücklich (1) oder erwartet Tags (2), die die Quelle nicht
//! anbietet, wird NICHT stillschweigend auf irgendetwas anderes gewechselt
//! (Spec §96): es gibt eine Warnung, und nur eine ausdrücklich konfigurierte
//! Fallback-Kette (`fallback`, Spec §97) darf ersetzen.

use serde::{Deserialize, Serialize};

use crate::{MediaType, Source, SourceContext};

/// Kanal-Layout einer Audio-Capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioLayout {
    Mono,
    Stereo,
    Surround51,
    /// Andere Kanalanzahl (0 = unbekannt).
    Other(u32),
}

impl AudioLayout {
    fn of(source: &Source) -> Self {
        if source.has_tag("audio.mono") {
            AudioLayout::Mono
        } else if source.has_tag("audio.stereo") {
            AudioLayout::Stereo
        } else if source.has_tag("audio.51") {
            AudioLayout::Surround51
        } else {
            match source.channel_count {
                1 => AudioLayout::Mono,
                2 => AudioLayout::Stereo,
                6 => AudioLayout::Surround51,
                n => AudioLayout::Other(n),
            }
        }
    }
}

/// Ein von der Quelle angebotener Audio-Flow mit Rolle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioCapability {
    /// Stabile Kennung: die Rolle (`role.commentator` → `commentator`), sonst
    /// ein Slug des Sender-Labels (nur als Kennung, nie als Bedeutung).
    pub id: String,
    #[serde(rename = "senderId")]
    pub sender_id: String,
    pub label: String,
    pub tags: Vec<String>,
    pub layout: AudioLayout,
    #[serde(rename = "channelCount")]
    pub channel_count: u32,
    /// Quell-Default (Tag `audio.default`).
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}

fn slug(label: &str) -> String {
    let s: String = label.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    format!("label-{}", s.trim_matches('-'))
}

/// Die Audio-Capabilities im Kontext einer Quelle (gleicher Node bzw. gleiche
/// Natural Group), stabil nach Kennung sortiert. Offline-/unsichtbare Flows
/// werden nicht angeboten.
pub fn audio_capabilities(sources: &[Source], context: &SourceContext) -> Vec<AudioCapability> {
    let mut caps: Vec<AudioCapability> = sources
        .iter()
        .filter(|s| s.media_type == Some(MediaType::Audio) && s.online && s.visible && s.selectable && context.matches(s))
        .map(|s| {
            let role = s.tags.iter().map(|t| t.tag.as_str()).filter_map(|t| t.strip_prefix("role.")).min();
            AudioCapability {
                id: role.map(str::to_string).unwrap_or_else(|| slug(&s.label)),
                sender_id: s.sender_id.clone(),
                label: s.label.clone(),
                tags: s.tags.iter().map(|t| t.tag.clone()).collect(),
                layout: AudioLayout::of(s),
                channel_count: s.channel_count,
                is_default: s.has_tag("audio.default"),
            }
        })
        .collect();
    caps.sort_by(|a, b| (&a.id, &a.sender_id).cmp(&(&b.id, &b.sender_id)));
    caps
}

/// Tag-Regel (REQUIRED/PREFERRED/FORBIDDEN, Spec §264).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagRule {
    #[serde(default)]
    pub required: Vec<String>,
    #[serde(default)]
    pub preferred: Vec<String>,
    #[serde(default)]
    pub forbidden: Vec<String>,
}

impl TagRule {
    fn matches(&self, c: &AudioCapability) -> bool {
        self.required.iter().all(|t| c.tags.contains(t)) && !self.forbidden.iter().any(|t| c.tags.contains(t))
    }

    fn preferred_hits(&self, c: &AudioCapability) -> usize {
        self.preferred.iter().filter(|t| c.tags.contains(t)).count()
    }
}

/// Ein Eintrag der Fallback-Kette (Spec §97).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioChoice {
    Capability { id: String },
    Tags(TagRule),
}

/// Audio-Absicht eines Events (Spec §104/§146).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioIntent {
    /// Ausdrückliche Wahl (Capability-Kennung).
    #[serde(default)]
    pub capability: Option<String>,
    /// Erwartete Tags des Events.
    #[serde(default)]
    pub expected: Option<TagRule>,
    /// Kanal-Präferenz (Rolle, z. B. `program`).
    #[serde(rename = "channelPreference", default)]
    pub channel_preference: Option<String>,
    /// Ausdrücklich konfigurierte Ersatzkette, in Reihenfolge.
    #[serde(default)]
    pub fallback: Vec<AudioChoice>,
    /// Globaler Fallback (Capability-Kennung).
    #[serde(rename = "globalDefault", default)]
    pub global_default: Option<String>,
}

/// Wodurch die Wahl zustande kam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "via", rename_all = "snake_case")]
pub enum AudioVia {
    Explicit,
    ExpectedTags,
    ChannelPreference,
    SourceDefault,
    /// Genau eine Capability vorhanden — automatisch vorgewählt (Spec §260).
    SingleCapability,
    /// Position in der Fallback-Kette (0-basiert).
    Fallback { index: usize },
    GlobalDefault,
    /// Nichts gewählt (Operator entscheidet).
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioResolution {
    /// Kennung der gewählten Capability.
    pub chosen: Option<String>,
    #[serde(flatten)]
    pub via: AudioVia,
    /// Warnungen für Operator/Preflight (Spec §96/§126).
    pub warnings: Vec<String>,
    /// Mehrere Capabilities passten gleich gut; nur der Tie-Breaker entschied.
    pub ambiguous: bool,
}

fn pick_by_rule<'a>(rule: &TagRule, caps: &'a [AudioCapability]) -> Option<(&'a AudioCapability, bool)> {
    let mut matching: Vec<&AudioCapability> = caps.iter().filter(|c| rule.matches(c)).collect();
    // Mehr bevorzugte Tags zuerst, dann stabil nach Kennung (caps ist bereits sortiert).
    matching.sort_by_key(|c| std::cmp::Reverse(rule.preferred_hits(c)));
    let best = *matching.first()?;
    let ambiguous = matching.get(1).is_some_and(|n| rule.preferred_hits(n) == rule.preferred_hits(best));
    Some((best, ambiguous))
}

/// Löst die Audio-Absicht gegen die Capabilities einer Quelle auf (Spec §253 `resolveAudio`).
pub fn resolve_audio_intent(intent: &AudioIntent, caps: &[AudioCapability]) -> AudioResolution {
    let has = |id: &str| caps.iter().any(|c| c.id == id);
    let mut warnings = Vec::new();

    // 1/2: ausdrückliche Absicht des Events.
    let mut event_intent_failed = false;
    if let Some(id) = &intent.capability {
        if has(id) {
            return AudioResolution { chosen: Some(id.clone()), via: AudioVia::Explicit, warnings, ambiguous: false };
        }
        warnings.push(format!("Audio „{id}“ wird von dieser Quelle nicht angeboten"));
        event_intent_failed = true;
    } else if let Some(rule) = &intent.expected {
        match pick_by_rule(rule, caps) {
            Some((c, ambiguous)) => {
                if ambiguous {
                    warnings.push("mehrere Audio-Capabilities erfüllen die erwarteten Tags gleich gut".to_string());
                }
                return AudioResolution { chosen: Some(c.id.clone()), via: AudioVia::ExpectedTags, warnings, ambiguous };
            }
            None => {
                warnings.push(format!("keine Audio-Capability erfüllt die erwarteten Tags ({})", rule.required.join(", ")));
                event_intent_failed = true;
            }
        }
    }

    // Ausdrückliche Absicht gescheitert: NUR die konfigurierte Fallback-Kette darf ersetzen.
    if event_intent_failed {
        for (index, choice) in intent.fallback.iter().enumerate() {
            let found = match choice {
                AudioChoice::Capability { id } if has(id) => Some(id.clone()),
                AudioChoice::Tags(rule) => pick_by_rule(rule, caps).map(|(c, _)| c.id.clone()),
                _ => None,
            };
            if let Some(id) = found {
                warnings.push(format!("Fallback #{} verwendet: „{id}“", index + 1));
                return AudioResolution { chosen: Some(id), via: AudioVia::Fallback { index }, warnings, ambiguous: false };
            }
        }
        warnings.push("keine passende Alternative — Operator muss wählen".to_string());
        return AudioResolution { chosen: None, via: AudioVia::None, warnings, ambiguous: false };
    }

    // 3: Kanal-Präferenz.
    if let Some(pref) = &intent.channel_preference {
        if has(pref) {
            return AudioResolution { chosen: Some(pref.clone()), via: AudioVia::ChannelPreference, warnings, ambiguous: false };
        }
        warnings.push(format!("bevorzugte Rolle „{pref}“ wird von dieser Quelle nicht angeboten"));
    }
    // 4: Quell-Default bzw. genau eine Capability.
    let defaults: Vec<&AudioCapability> = caps.iter().filter(|c| c.is_default).collect();
    if let Some(d) = defaults.first() {
        let ambiguous = defaults.len() > 1;
        if ambiguous {
            warnings.push("mehrere Audio-Capabilities sind als Default markiert".to_string());
        }
        return AudioResolution { chosen: Some(d.id.clone()), via: AudioVia::SourceDefault, warnings, ambiguous };
    }
    if caps.len() == 1 {
        return AudioResolution { chosen: Some(caps[0].id.clone()), via: AudioVia::SingleCapability, warnings, ambiguous: false };
    }
    // 5: globaler Fallback.
    if let Some(g) = &intent.global_default {
        if has(g) {
            return AudioResolution { chosen: Some(g.clone()), via: AudioVia::GlobalDefault, warnings, ambiguous: false };
        }
        warnings.push(format!("globaler Fallback „{g}“ wird von dieser Quelle nicht angeboten"));
    }
    // 6: Operator.
    if caps.is_empty() {
        warnings.push("diese Quelle bietet kein Audio an".to_string());
    } else {
        warnings.push("mehrere Audio-Capabilities, kein Default — keine willkürliche Wahl, Operator wählt".to_string());
    }
    AudioResolution { chosen: None, via: AudioVia::None, warnings, ambiguous: false }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SourceTag, TagOrigin};

    fn audio(id: &str, label: &str, node: &str, ch: u32, tags: &[&str]) -> Source {
        Source {
            sender_id: id.to_string(),
            label: label.to_string(),
            node_id: node.to_string(),
            node_label: node.to_string(),
            workflow_id: String::new(),
            media_type: Some(MediaType::Audio),
            group_hint: String::new(),
            channel_count: ch,
            online: true,
            visible: true,
            selectable: true,
            tags: tags.iter().map(|t| SourceTag { tag: t.to_string(), origin: TagOrigin::Explicit }).collect(),
        }
    }

    fn ctx(node: &str) -> SourceContext {
        SourceContext { node_id: node.to_string(), group: String::new() }
    }

    fn remote_x() -> Vec<Source> {
        vec![
            audio("a1", "Audio 1", "x", 2, &["media.audio", "audio.stereo", "role.program"]),
            audio("a2", "Audio 2", "x", 1, &["media.audio", "audio.mono", "role.commentator"]),
            audio("a3", "Audio 3", "x", 2, &["media.audio", "audio.stereo", "role.international"]),
            audio("y1", "Audio 1", "y", 2, &["role.program"]),
        ]
    }

    #[test]
    fn capabilities_are_the_audio_flows_of_one_source_with_role_ids_and_layouts() {
        let caps = audio_capabilities(&remote_x(), &ctx("x"));
        let view: Vec<(&str, AudioLayout)> = caps.iter().map(|c| (c.id.as_str(), c.layout)).collect();
        assert_eq!(
            view,
            [("commentator", AudioLayout::Mono), ("international", AudioLayout::Stereo), ("program", AudioLayout::Stereo)]
        );
        // Andere Quelle liefert andere Capabilities — nicht alles global.
        assert_eq!(audio_capabilities(&remote_x(), &ctx("y")).len(), 1);
    }

    #[test]
    fn capability_without_role_gets_a_label_slug_id_never_a_meaning() {
        let caps = audio_capabilities(&[audio("s", "Mic Stage #2", "n", 6, &[])], &ctx("n"));
        assert_eq!(caps[0].id, "label-mic-stage--2");
        assert_eq!(caps[0].layout, AudioLayout::Surround51, "layout from channel count");
        // Layout-Tag hat Vorrang vor der Kanalzahl.
        let caps = audio_capabilities(&[audio("s", "x", "n", 2, &["audio.mono"])], &ctx("n"));
        assert_eq!(caps[0].layout, AudioLayout::Mono);
    }

    #[test]
    fn offline_and_hidden_flows_are_not_offered() {
        let mut off = audio("a", "A", "n", 2, &["role.program"]);
        off.online = false;
        let mut hid = audio("b", "B", "n", 2, &["role.commentator"]);
        hid.visible = false;
        assert!(audio_capabilities(&[off, hid], &ctx("n")).is_empty());
    }

    fn caps_x() -> Vec<AudioCapability> {
        audio_capabilities(&remote_x(), &ctx("x"))
    }

    #[test]
    fn explicit_capability_wins_and_missing_one_warns_without_silent_switch() {
        let ok = resolve_audio_intent(&AudioIntent { capability: Some("commentator".into()), ..Default::default() }, &caps_x());
        assert_eq!((ok.chosen.as_deref(), &ok.via), (Some("commentator"), &AudioVia::Explicit));
        // Quelle bietet „5.1“ nicht an: Warnung, KEINE stille Ersatzwahl (obwohl es einen Default gäbe).
        let mut with_default = caps_x();
        with_default[2].is_default = true;
        let r = resolve_audio_intent(&AudioIntent { capability: Some("surround".into()), ..Default::default() }, &with_default);
        assert_eq!(r.chosen, None);
        assert_eq!(r.via, AudioVia::None);
        assert!(r.warnings.iter().any(|w| w.contains("„surround“") && w.contains("nicht angeboten")), "{:?}", r.warnings);
    }

    #[test]
    fn configured_fallback_chain_replaces_in_order() {
        let intent = AudioIntent {
            capability: Some("surround".into()),
            fallback: vec![
                AudioChoice::Capability { id: "nope".into() },
                AudioChoice::Tags(TagRule { required: vec!["audio.stereo".into()], preferred: vec!["role.program".into()], forbidden: vec![] }),
                AudioChoice::Capability { id: "commentator".into() },
            ],
            ..Default::default()
        };
        let r = resolve_audio_intent(&intent, &caps_x());
        assert_eq!(r.chosen.as_deref(), Some("program"), "first usable fallback entry: stereo, preferring program");
        assert_eq!(r.via, AudioVia::Fallback { index: 1 });
        assert!(r.warnings.iter().any(|w| w.contains("Fallback #2")));
    }

    #[test]
    fn expected_tags_pick_the_matching_capability() {
        let intent = AudioIntent {
            expected: Some(TagRule { required: vec!["media.audio".into()], preferred: vec!["role.commentator".into()], forbidden: vec!["role.program".into()] }),
            ..Default::default()
        };
        let r = resolve_audio_intent(&intent, &caps_x());
        assert_eq!((r.chosen.as_deref(), &r.via, r.ambiguous), (Some("commentator"), &AudioVia::ExpectedTags, false));
        // Gleich gut: mehrdeutig gemeldet, deterministisch nach Kennung.
        let tie = AudioIntent { expected: Some(TagRule { required: vec!["audio.stereo".into()], ..Default::default() }), ..Default::default() };
        let r = resolve_audio_intent(&tie, &caps_x());
        assert_eq!(r.chosen.as_deref(), Some("international"));
        assert!(r.ambiguous && !r.warnings.is_empty());
        // Nichts erfüllt → Warnung + Operator.
        let none = AudioIntent { expected: Some(TagRule { required: vec!["audio.51".into()], ..Default::default() }), ..Default::default() };
        let r = resolve_audio_intent(&none, &caps_x());
        assert_eq!(r.chosen, None);
        assert!(r.warnings[0].contains("keine Audio-Capability"));
    }

    #[test]
    fn precedence_event_beats_channel_preference_beats_source_default_beats_global() {
        let mut caps = caps_x();
        caps.iter_mut().find(|c| c.id == "international").unwrap().is_default = true;
        let mut intent = AudioIntent { channel_preference: Some("program".into()), global_default: Some("commentator".into()), ..Default::default() };
        assert_eq!(resolve_audio_intent(&intent, &caps).via, AudioVia::ChannelPreference);
        intent.channel_preference = None;
        let r = resolve_audio_intent(&intent, &caps);
        assert_eq!((r.chosen.as_deref(), &r.via), (Some("international"), &AudioVia::SourceDefault));
        // Ohne Quell-Default greift der globale Fallback.
        let mut no_default = caps_x();
        no_default.iter_mut().for_each(|c| c.is_default = false);
        let r = resolve_audio_intent(&intent, &no_default);
        assert_eq!((r.chosen.as_deref(), &r.via), (Some("commentator"), &AudioVia::GlobalDefault));
        // Event-Erwartung schlägt alles darunter.
        intent.expected = Some(TagRule { required: vec!["role.program".into()], ..Default::default() });
        assert_eq!(resolve_audio_intent(&intent, &caps).via, AudioVia::ExpectedTags);
    }

    #[test]
    fn single_capability_is_preselected_several_without_default_are_not() {
        let one = audio_capabilities(&remote_x(), &ctx("y"));
        let r = resolve_audio_intent(&AudioIntent::default(), &one);
        assert_eq!((r.chosen.as_deref(), &r.via), (Some("program"), &AudioVia::SingleCapability));
        let r = resolve_audio_intent(&AudioIntent::default(), &caps_x());
        assert_eq!((r.chosen, r.via), (None, AudioVia::None));
        assert!(r.warnings[0].contains("keine willkürliche Wahl"));
        let r = resolve_audio_intent(&AudioIntent::default(), &[]);
        assert!(r.warnings[0].contains("kein Audio"));
    }

    #[test]
    fn intent_json_roundtrip_with_defaults() {
        let i: AudioIntent = serde_json::from_str(
            r#"{"capability":"commentator","fallback":[{"capability":{"id":"program"}},{"tags":{"required":["audio.stereo"]}}],"channelPreference":"program"}"#,
        )
        .unwrap();
        assert_eq!(i.fallback.len(), 2);
        assert_eq!(i.channel_preference.as_deref(), Some("program"));
        let back: AudioIntent = serde_json::from_value(serde_json::to_value(&i).unwrap()).unwrap();
        assert_eq!(back, i);
        let r = resolve_audio_intent(&i, &caps_x());
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["via"], "explicit");
    }
}
