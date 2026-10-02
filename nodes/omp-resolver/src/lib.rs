//! `omp-resolver` — gemeinsame, REINE Quellen-Auswahl (UMSETZUNG.md Kapitel 27
//! / P4b, Entscheidung E6: Rust-Crate im Workspace; Spec §253–255).
//!
//! Kein HTTP, keine Uhr, kein Zustand: der Aufrufer liefert die Quellen
//! (`GET /api/v1/sources` des Orchestrators → [`Source`]) und einen
//! [`Selector`]; heraus kommt eine [`Resolution`] mit Begründung für JEDEN
//! Kandidaten (Spec §37/§252: keine undurchsichtige Magie).
//!
//! Pipeline (Spec §16): Sichtbarkeit → Capability → Tags → Health → Rangfolge.
//! Rangfolge (Spec §36), in dieser Reihenfolge, jede Stufe nur Gleichstand der
//! vorherigen bricht:
//!   1. Quell-Kontext (gleicher Node/gleiche Natural Group wie die gewählte
//!      Quelle, z. B. Audio zur gewählten Videoquelle),
//!   2. ausdrückliche Priorität (`priority_ids`, frühere gewinnen),
//!   3. Workflow-Präferenz (aktueller Workflow vor anderen),
//!   4. Anzahl erfüllter bevorzugter Tags,
//!   5. stabiler, deterministischer Tie-Breaker (Label, Node, Sender-ID).
//!
//! Gleichstand VOR dem Tie-Breaker wird als `ambiguous` gemeldet (Spec §250:
//! bei Unsicherheit warnen/blockieren statt zufällig wählen) — mit
//! `fail_on_ambiguity` wird daraus keine Auswahl.
//!
//! Namensbasierte Erkennung gibt es bewusst nicht (Spec §222): nur Tags,
//! Capabilities und IDs.

pub mod audio;

use serde::{Deserialize, Serialize};

/// Medienart einer Quelle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Video,
    Audio,
    Data,
}

/// Herkunft eines Tags (Spec §25).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TagOrigin {
    Explicit,
    Derived,
    Discovered,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceTag {
    pub tag: String,
    pub origin: TagOrigin,
}

/// Eine auswählbare Quelle — Feldnamen wie bei `GET /api/v1/sources`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
    #[serde(rename = "senderId")]
    pub sender_id: String,
    pub label: String,
    #[serde(rename = "nodeId", default)]
    pub node_id: String,
    #[serde(rename = "nodeLabel", default)]
    pub node_label: String,
    #[serde(rename = "workflowId", default)]
    pub workflow_id: String,
    #[serde(rename = "mediaType", default)]
    pub media_type: Option<MediaType>,
    #[serde(rename = "groupHint", default)]
    pub group_hint: String,
    #[serde(rename = "channelCount", default)]
    pub channel_count: u32,
    #[serde(default = "yes")]
    pub online: bool,
    /// `visible=false`: gar nicht anbieten. `selectable=false`: sichtbar, aber
    /// nicht automatisch wählbar (Spec §216).
    #[serde(default = "yes")]
    pub visible: bool,
    #[serde(default = "yes")]
    pub selectable: bool,
    #[serde(default)]
    pub tags: Vec<SourceTag>,
}

fn yes() -> bool {
    true
}

impl Source {
    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.iter().any(|t| t.tag == tag)
    }

    /// Natural-Group-Name aus `grouphint` ("<gruppe>:<rolle>[:<scope>]").
    pub fn group_name(&self) -> Option<&str> {
        let g = self.group_hint.split(':').next().unwrap_or("");
        if g.is_empty() { None } else { Some(g) }
    }
}

/// Wohin zur Quelle gehört, was „zusammen“ gewählt wird (Spec §40–44).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceContext {
    #[serde(rename = "nodeId", default)]
    pub node_id: String,
    /// Natural-Group-Name der gewählten Quelle.
    #[serde(default)]
    pub group: String,
}

impl SourceContext {
    /// Kontext aus der gewählten Quelle (z. B. dem Programm-Video).
    pub fn of(source: &Source) -> Self {
        SourceContext { node_id: source.node_id.clone(), group: source.group_name().unwrap_or("").to_string() }
    }

    pub(crate) fn matches(&self, s: &Source) -> bool {
        (!self.node_id.is_empty() && s.node_id == self.node_id)
            || (!self.group.is_empty() && s.group_name() == Some(self.group.as_str()))
    }
}

/// Wie Workflows berücksichtigt werden (Spec §215).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowScope {
    /// Alle Workflows gleichwertig.
    #[default]
    Any,
    /// Nur dieser Workflow.
    Only { workflow_id: String },
    /// Dieser Workflow bevorzugt, andere nur wenn nichts passt.
    Prefer { workflow_id: String },
}

/// Auswahlkriterien (Spec §14–17, §264).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Selector {
    /// EXACT_ID: genau diese Sender-ID (alle anderen Kriterien gelten zusätzlich nur zur Prüfung).
    #[serde(rename = "exactId", default)]
    pub exact_id: Option<String>,
    #[serde(rename = "mediaType", default)]
    pub media_type: Option<MediaType>,
    #[serde(rename = "minChannels", default)]
    pub min_channels: Option<u32>,
    /// REQUIRED: alle müssen vorhanden sein.
    #[serde(default)]
    pub required: Vec<String>,
    /// PREFERRED: erhöht die Rangfolge, schließt nichts aus.
    #[serde(default)]
    pub preferred: Vec<String>,
    /// FORBIDDEN: keiner darf vorhanden sein.
    #[serde(default)]
    pub forbidden: Vec<String>,
    /// Natural Group (Name vor dem ersten `:` des grouphint).
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub workflow: WorkflowScope,
    /// Quell-Kontext (z. B. die gewählte Videoquelle).
    #[serde(default)]
    pub context: Option<SourceContext>,
    /// Ausdrückliche Priorität: Sender-IDs, frühere gewinnen.
    #[serde(rename = "priorityIds", default)]
    pub priority_ids: Vec<String>,
    /// Offline-Quellen zulassen (Standard: nein, Spec §17).
    #[serde(rename = "allowOffline", default)]
    pub allow_offline: bool,
    /// Bei Gleichstand vor dem Tie-Breaker KEINE Auswahl treffen (Spec §250).
    #[serde(rename = "failOnAmbiguity", default)]
    pub fail_on_ambiguity: bool,
}

/// Stufe, in der ein Kandidat ausgeschieden ist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Visibility,
    Capability,
    Tags,
    Health,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "verdict", rename_all = "lowercase")]
pub enum Verdict {
    Selected,
    /// Zulässig, aber nicht gewählt; `rank` 1 = beste (die gewählte Quelle hat Rang 1).
    Accepted { rank: usize },
    Rejected { stage: Stage },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CandidateReport {
    #[serde(rename = "senderId")]
    pub sender_id: String,
    pub label: String,
    #[serde(flatten)]
    pub verdict: Verdict,
    /// Begründungen in Klartext (Spec §37: „matched: audio, commentator“).
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Resolution {
    #[serde(rename = "selectedId")]
    pub selected_id: Option<String>,
    pub candidates: Vec<CandidateReport>,
    /// Die beste Quelle war von der zweitbesten nur durch den Tie-Breaker getrennt.
    pub ambiguous: bool,
    /// Einzeiler für Operator/Log.
    pub summary: String,
}

impl Resolution {
    pub fn selected<'a>(&self, sources: &'a [Source]) -> Option<&'a Source> {
        let id = self.selected_id.as_deref()?;
        sources.iter().find(|s| s.sender_id == id)
    }

    /// Mehrzeilige Erklärung für Debug/UI (Spec §252).
    pub fn explain(&self) -> String {
        let mut out = vec![self.summary.clone()];
        for c in &self.candidates {
            let tag = match &c.verdict {
                Verdict::Selected => "= gewählt".to_string(),
                Verdict::Accepted { rank } => format!("zulässig, Rang {rank}"),
                Verdict::Rejected { stage } => format!("abgelehnt ({stage:?})"),
            };
            out.push(format!("  {} „{}“: {tag} — {}", c.sender_id, c.label, c.reasons.join("; ")));
        }
        out.join("\n")
    }
}

/// Rangfolge-Schlüssel (kleiner = besser). Reihenfolge der Felder = Reihenfolge der Kriterien.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Rank {
    context: u8,
    priority: usize,
    workflow: u8,
    /// Negiert, damit „mehr bevorzugte Tags“ kleiner = besser ist.
    missing_preferred: usize,
}

fn tag_list(tags: &[String]) -> String {
    tags.join(", ")
}

/// Löst `selector` gegen `sources` auf (Spec §253 `resolveSource`).
pub fn resolve(selector: &Selector, sources: &[Source]) -> Resolution {
    let mut reports: Vec<CandidateReport> = Vec::with_capacity(sources.len());
    // (Index in reports, Source, Rank, Tie-Breaker-Schlüssel)
    let mut accepted: Vec<(usize, &Source, Rank)> = Vec::new();

    for s in sources {
        let mut reasons: Vec<String> = Vec::new();
        let reject = |stage: Stage, why: String, mut reasons: Vec<String>| {
            reasons.push(why);
            CandidateReport { sender_id: s.sender_id.clone(), label: s.label.clone(), verdict: Verdict::Rejected { stage }, reasons }
        };

        // EXACT_ID: alles andere ist nicht der gesuchte Sender.
        if let Some(id) = &selector.exact_id
            && &s.sender_id != id
        {
            reports.push(reject(Stage::Visibility, format!("nicht die gesuchte Sender-ID {id}"), reasons));
            continue;
        }
        // 1. Sichtbarkeit
        if !s.visible {
            reports.push(reject(Stage::Visibility, "nicht sichtbar".to_string(), reasons));
            continue;
        }
        if !s.selectable {
            reports.push(reject(Stage::Visibility, "sichtbar, aber nicht wählbar".to_string(), reasons));
            continue;
        }
        if let WorkflowScope::Only { workflow_id } = &selector.workflow
            && &s.workflow_id != workflow_id
        {
            reports.push(reject(Stage::Visibility, format!("gehört nicht zum Workflow {workflow_id}"), reasons));
            continue;
        }
        // 2. Capability
        if let Some(mt) = selector.media_type
            && s.media_type != Some(mt)
        {
            reports.push(reject(Stage::Capability, format!("Medienart {:?} statt {mt:?}", s.media_type), reasons));
            continue;
        }
        if let Some(min) = selector.min_channels
            && s.channel_count < min
        {
            reports.push(reject(Stage::Capability, format!("{} Kanäle, mindestens {min} verlangt", s.channel_count), reasons));
            continue;
        }
        if let Some(g) = &selector.group
            && s.group_name() != Some(g.as_str())
        {
            reports.push(reject(Stage::Capability, format!("nicht in der Gruppe „{g}“"), reasons));
            continue;
        }
        // 3. Tags
        let missing: Vec<String> = selector.required.iter().filter(|t| !s.has_tag(t)).cloned().collect();
        if !missing.is_empty() {
            reports.push(reject(Stage::Tags, format!("es fehlt: {}", tag_list(&missing)), reasons));
            continue;
        }
        let forbidden: Vec<String> = selector.forbidden.iter().filter(|t| s.has_tag(t)).cloned().collect();
        if !forbidden.is_empty() {
            reports.push(reject(Stage::Tags, format!("verbotenes Tag vorhanden: {}", tag_list(&forbidden)), reasons));
            continue;
        }
        if !selector.required.is_empty() {
            reasons.push(format!("erfüllt: {}", tag_list(&selector.required)));
        }
        // 4. Health
        if !s.online && !selector.allow_offline {
            reports.push(reject(Stage::Health, "offline".to_string(), reasons));
            continue;
        }

        // Rangfolge
        let context_rank = match &selector.context {
            Some(ctx) if ctx.matches(s) => {
                reasons.push("gleicher Kontext (Node/Gruppe) wie die gewählte Quelle".to_string());
                0
            }
            Some(_) => 1,
            None => 0,
        };
        let priority = selector.priority_ids.iter().position(|p| p == &s.sender_id).unwrap_or(selector.priority_ids.len());
        if priority < selector.priority_ids.len() {
            reasons.push(format!("ausdrückliche Priorität {}", priority + 1));
        }
        let workflow = match &selector.workflow {
            WorkflowScope::Prefer { workflow_id } if &s.workflow_id == workflow_id => {
                reasons.push("bevorzugter Workflow".to_string());
                0
            }
            WorkflowScope::Prefer { .. } => 1,
            _ => 0,
        };
        let have: Vec<String> = selector.preferred.iter().filter(|t| s.has_tag(t)).cloned().collect();
        if !have.is_empty() {
            reasons.push(format!("bevorzugt erfüllt: {}", tag_list(&have)));
        }
        let rank = Rank { context: context_rank, priority, workflow, missing_preferred: selector.preferred.len() - have.len() };
        let idx = reports.len();
        reports.push(CandidateReport { sender_id: s.sender_id.clone(), label: s.label.clone(), verdict: Verdict::Accepted { rank: 0 }, reasons });
        accepted.push((idx, s, rank));
    }

    // Deterministische Reihenfolge: Rang, dann Tie-Breaker (Label, Node, Sender-ID).
    accepted.sort_by(|a, b| {
        a.2.cmp(&b.2).then_with(|| (&a.1.label, &a.1.node_label, &a.1.sender_id).cmp(&(&b.1.label, &b.1.node_label, &b.1.sender_id)))
    });
    for (pos, (idx, _, _)) in accepted.iter().enumerate() {
        reports[*idx].verdict = Verdict::Accepted { rank: pos + 1 };
    }

    let ambiguous = accepted.len() >= 2 && accepted[0].2 == accepted[1].2;
    let mut selected_id = None;
    let summary;
    if accepted.is_empty() {
        summary = format!("keine passende Quelle unter {} Kandidaten", sources.len());
    } else if ambiguous && selector.fail_on_ambiguity {
        summary = format!(
            "mehrdeutig: {} Quellen gleichrangig — keine Auswahl (failOnAmbiguity)",
            accepted.iter().take_while(|a| a.2 == accepted[0].2).count()
        );
    } else {
        let (idx, best, _) = &accepted[0];
        reports[*idx].verdict = Verdict::Selected;
        selected_id = Some(best.sender_id.clone());
        summary = if ambiguous {
            format!("gewählt: „{}“ ({}) — Achtung: gleichrangig mit weiteren, nur per Tie-Breaker entschieden", best.label, best.sender_id)
        } else {
            format!("gewählt: „{}“ ({})", best.label, best.sender_id)
        };
    }
    Resolution { selected_id, candidates: reports, ambiguous, summary }
}

/// Ein Mixer-Kanal mit semantischer Erwartung (Spec §32–35, §100).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoleRule {
    pub channel: String,
    pub selector: Selector,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoleAssignment {
    pub channel: String,
    pub resolution: Resolution,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoleConflict {
    #[serde(rename = "senderId")]
    pub sender_id: String,
    pub channels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoleResolution {
    pub assignments: Vec<RoleAssignment>,
    /// Zwei Kanäle erwarten dieselbe Quelle — NICHT still entscheiden (Spec §155).
    pub conflicts: Vec<RoleConflict>,
}

/// Löst alle Rollen-Regeln gegen die Quellen EINES Kontexts auf (Spec §41:
/// „Fader 1 → Remote X/commentator, Fader 2 → Remote X/international“). Jede
/// Regel bekommt `context` gesetzt, falls sie keinen eigenen hat.
pub fn resolve_roles(rules: &[RoleRule], sources: &[Source], context: &SourceContext) -> RoleResolution {
    let mut assignments = Vec::with_capacity(rules.len());
    for rule in rules {
        let mut sel = rule.selector.clone();
        if sel.context.is_none() {
            sel.context = Some(context.clone());
        }
        assignments.push(RoleAssignment { channel: rule.channel.clone(), resolution: resolve(&sel, sources) });
    }
    let mut by_sender: Vec<(String, Vec<String>)> = Vec::new();
    for a in &assignments {
        if let Some(id) = &a.resolution.selected_id {
            match by_sender.iter_mut().find(|(s, _)| s == id) {
                Some((_, ch)) => ch.push(a.channel.clone()),
                None => by_sender.push((id.clone(), vec![a.channel.clone()])),
            }
        }
    }
    let conflicts = by_sender
        .into_iter()
        .filter(|(_, ch)| ch.len() > 1)
        .map(|(sender_id, channels)| RoleConflict { sender_id, channels })
        .collect();
    RoleResolution { assignments, conflicts }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(t: &str, o: TagOrigin) -> SourceTag {
        SourceTag { tag: t.to_string(), origin: o }
    }

    fn src(id: &str, label: &str, node: &str, media: MediaType, tags: &[&str]) -> Source {
        Source {
            sender_id: id.to_string(),
            label: label.to_string(),
            node_id: node.to_string(),
            node_label: node.to_string(),
            workflow_id: "wf1".to_string(),
            media_type: Some(media),
            group_hint: String::new(),
            channel_count: if media == MediaType::Audio { 2 } else { 0 },
            online: true,
            visible: true,
            selectable: true,
            tags: tags.iter().map(|t| tag(t, TagOrigin::Explicit)).collect(),
        }
    }

    fn audio(id: &str, node: &str, tags: &[&str]) -> Source {
        src(id, &format!("Audio {id}"), node, MediaType::Audio, tags)
    }

    fn sel_audio(required: &[&str]) -> Selector {
        Selector { media_type: Some(MediaType::Audio), required: required.iter().map(|s| s.to_string()).collect(), ..Selector::default() }
    }

    #[test]
    fn exact_id_picks_only_that_sender() {
        let sources = vec![audio("a1", "n", &[]), audio("a2", "n", &[])];
        let r = resolve(&Selector { exact_id: Some("a2".into()), ..Selector::default() }, &sources);
        assert_eq!(r.selected_id.as_deref(), Some("a2"));
        assert!(matches!(r.candidates[0].verdict, Verdict::Rejected { stage: Stage::Visibility }));
        // Unbekannte ID: keine Auswahl, keine Ersatzwahl.
        let r = resolve(&Selector { exact_id: Some("zz".into()), ..Selector::default() }, &sources);
        assert_eq!(r.selected_id, None);
        assert!(r.summary.contains("keine passende Quelle"));
    }

    #[test]
    fn required_and_forbidden_tags_filter_with_reasons() {
        let sources = vec![
            audio("a1", "n", &["media.audio", "role.commentator"]),
            audio("a2", "n", &["media.audio", "role.international"]),
            audio("a3", "n", &["media.audio", "role.commentator", "audio.music"]),
        ];
        let mut sel = sel_audio(&["role.commentator"]);
        sel.forbidden = vec!["audio.music".into()];
        let r = resolve(&sel, &sources);
        assert_eq!(r.selected_id.as_deref(), Some("a1"));
        let by = |id: &str| r.candidates.iter().find(|c| c.sender_id == id).unwrap();
        assert!(by("a2").reasons.iter().any(|x| x.contains("es fehlt: role.commentator")));
        assert!(by("a3").reasons.iter().any(|x| x.contains("verbotenes Tag")));
        assert!(by("a1").reasons.iter().any(|x| x.contains("erfüllt: role.commentator")));
        assert!(r.explain().contains("= gewählt"));
    }

    #[test]
    fn capability_stage_media_type_channels_and_group() {
        let mut stereo = audio("a1", "n", &[]);
        stereo.group_hint = "RemoteX:audio1".to_string();
        let mut mono = audio("a2", "n", &[]);
        mono.channel_count = 1;
        let video = src("v1", "Video", "n", MediaType::Video, &[]);
        let sources = vec![stereo, mono, video];
        let mut sel = sel_audio(&[]);
        sel.min_channels = Some(2);
        sel.group = Some("RemoteX".to_string());
        let r = resolve(&sel, &sources);
        assert_eq!(r.selected_id.as_deref(), Some("a1"));
        let reason = |id: &str| r.candidates.iter().find(|c| c.sender_id == id).unwrap().reasons.join(" ");
        assert!(reason("a2").contains("1 Kanäle"), "{}", reason("a2"));
        assert!(reason("v1").contains("Medienart"), "{}", reason("v1"));
    }

    #[test]
    fn invisible_and_unselectable_sources_are_never_chosen_automatically() {
        let mut hidden = audio("a1", "n", &[]);
        hidden.visible = false;
        let mut locked = audio("a2", "n", &[]);
        locked.selectable = false;
        let ok = audio("a3", "n", &[]);
        let r = resolve(&sel_audio(&[]), &[hidden, locked, ok]);
        assert_eq!(r.selected_id.as_deref(), Some("a3"));
        assert!(r.candidates[1].reasons.iter().any(|x| x.contains("nicht wählbar")));
    }

    #[test]
    fn offline_sources_are_skipped_when_an_alternative_exists_and_allowed_on_request() {
        let mut off = audio("a1", "n", &["role.program"]);
        off.online = false;
        let on = audio("a2", "n", &["role.program"]);
        let sources = vec![off, on];
        assert_eq!(resolve(&sel_audio(&["role.program"]), &sources).selected_id.as_deref(), Some("a2"));
        // Nur die Offline-Quelle übrig: keine Auswahl (Spec §17) …
        let only_off = vec![sources[0].clone()];
        assert_eq!(resolve(&sel_audio(&["role.program"]), &only_off).selected_id, None);
        // … außer der Aufrufer erlaubt es ausdrücklich.
        let mut sel = sel_audio(&["role.program"]);
        sel.allow_offline = true;
        assert_eq!(resolve(&sel, &only_off).selected_id.as_deref(), Some("a1"));
    }

    #[test]
    fn ranking_context_beats_priority_beats_workflow_beats_preferred_tags() {
        let mut sources = vec![
            audio("other-node", "n2", &["role.commentator", "audio.stereo"]),
            audio("same-node", "n1", &["role.commentator"]),
        ];
        let mut sel = sel_audio(&["role.commentator"]);
        sel.preferred = vec!["audio.stereo".into()];
        sel.context = Some(SourceContext { node_id: "n1".into(), group: String::new() });
        // Kontext schlägt bevorzugte Tags.
        assert_eq!(resolve(&sel, &sources).selected_id.as_deref(), Some("same-node"));
        // Ohne Kontext gewinnt das bevorzugte Tag.
        sel.context = None;
        assert_eq!(resolve(&sel, &sources).selected_id.as_deref(), Some("other-node"));
        // Ausdrückliche Priorität schlägt bevorzugte Tags.
        sel.priority_ids = vec!["same-node".into()];
        assert_eq!(resolve(&sel, &sources).selected_id.as_deref(), Some("same-node"));
        // Workflow-Präferenz zwischen sonst Gleichen.
        sel.priority_ids.clear();
        sel.preferred.clear();
        sources[0].workflow_id = "wf-current".into();
        sel.workflow = WorkflowScope::Prefer { workflow_id: "wf-current".into() };
        assert_eq!(resolve(&sel, &sources).selected_id.as_deref(), Some("other-node"));
        // Only schließt die anderen aus.
        sel.workflow = WorkflowScope::Only { workflow_id: "wf1".into() };
        assert_eq!(resolve(&sel, &sources).selected_id.as_deref(), Some("same-node"));
    }

    #[test]
    fn tie_is_broken_deterministically_but_reported_as_ambiguous() {
        let sources = vec![audio("b", "n", &["role.program"]), audio("a", "n", &["role.program"])];
        let r1 = resolve(&sel_audio(&["role.program"]), &sources);
        // Reihenfolge der Eingabe darf das Ergebnis nicht ändern.
        let mut rev = sources.clone();
        rev.reverse();
        let r2 = resolve(&sel_audio(&["role.program"]), &rev);
        assert_eq!(r1.selected_id, r2.selected_id);
        assert_eq!(r1.selected_id.as_deref(), Some("a"), "label order: 'Audio a' < 'Audio b'");
        assert!(r1.ambiguous && r1.summary.contains("Tie-Breaker"));
        // Auf Wunsch gar keine Auswahl statt Zufall (Spec §250).
        let mut sel = sel_audio(&["role.program"]);
        sel.fail_on_ambiguity = true;
        let r = resolve(&sel, &sources);
        assert_eq!(r.selected_id, None);
        assert!(r.summary.contains("mehrdeutig"));
        // Ein klarer Sieger ist nicht mehrdeutig.
        let single = resolve(&sel_audio(&["role.program"]), &sources[..1]);
        assert!(!single.ambiguous);
    }

    #[test]
    fn roles_resolve_inside_one_source_context() {
        // Zwei Beiträge mit je commentator/international — der Kontext (Remote X) entscheidet.
        let sources = vec![
            audio("x-comm", "remote-x", &["role.commentator"]),
            audio("x-intl", "remote-x", &["role.international"]),
            audio("y-comm", "remote-y", &["role.commentator"]),
            audio("y-intl", "remote-y", &["role.international"]),
        ];
        let rules = vec![
            RoleRule { channel: "fader1".into(), selector: sel_audio(&["role.commentator"]) },
            RoleRule { channel: "fader2".into(), selector: sel_audio(&["role.international"]) },
        ];
        let ctx = SourceContext { node_id: "remote-x".into(), group: String::new() };
        let r = resolve_roles(&rules, &sources, &ctx);
        let sel: Vec<(&str, Option<&str>)> =
            r.assignments.iter().map(|a| (a.channel.as_str(), a.resolution.selected_id.as_deref())).collect();
        assert_eq!(sel, [("fader1", Some("x-comm")), ("fader2", Some("x-intl"))]);
        assert!(r.conflicts.is_empty());
        // Anderer Kontext → andere Quellen.
        let r = resolve_roles(&rules, &sources, &SourceContext { node_id: "remote-y".into(), group: String::new() });
        assert_eq!(r.assignments[0].resolution.selected_id.as_deref(), Some("y-comm"));
    }

    #[test]
    fn two_channels_expecting_the_same_source_are_reported_as_conflict() {
        let sources = vec![audio("only", "n", &["role.commentator"])];
        let rules = vec![
            RoleRule { channel: "c1".into(), selector: sel_audio(&["role.commentator"]) },
            RoleRule { channel: "c2".into(), selector: sel_audio(&["role.commentator"]) },
        ];
        let r = resolve_roles(&rules, &sources, &SourceContext::default());
        assert_eq!(r.conflicts, vec![RoleConflict { sender_id: "only".into(), channels: vec!["c1".into(), "c2".into()] }]);
    }

    #[test]
    fn natural_group_context_works_across_nodes() {
        let mut v = src("v", "Video", "n1", MediaType::Video, &[]);
        v.group_hint = "Feed:video".into();
        let mut a_in = audio("a-in", "n2", &["role.commentator"]);
        a_in.group_hint = "Feed:audio1".into();
        let a_out = audio("a-out", "n3", &["role.commentator"]);
        let ctx = SourceContext::of(&v);
        assert_eq!(ctx.group, "Feed");
        let mut sel = sel_audio(&["role.commentator"]);
        sel.context = Some(ctx);
        assert_eq!(resolve(&sel, &[a_out, a_in]).selected_id.as_deref(), Some("a-in"));
    }

    #[test]
    fn sources_deserialize_from_the_orchestrator_json_with_defaults() {
        let json = r#"[{"senderId":"s1","label":"A","nodeId":"n","mediaType":"audio","channelCount":2,
            "tags":[{"tag":"audio.stereo","origin":"DERIVED"}]},
            {"senderId":"s2","label":"B","mediaType":"video","online":false}]"#;
        let sources: Vec<Source> = serde_json::from_str(json).unwrap();
        assert!(sources[0].online && sources[0].visible && sources[0].selectable, "defaults");
        assert_eq!(sources[0].tags[0].origin, TagOrigin::Derived);
        assert!(!sources[1].online);
        // Resolution lässt sich als JSON zurückgeben (Methode `source.resolve`).
        let r = resolve(&sel_audio(&["audio.stereo"]), &sources);
        let j = serde_json::to_value(&r).unwrap();
        assert_eq!(j["selectedId"], "s1");
        assert_eq!(j["candidates"][0]["verdict"], "selected");
        let back: Resolution = serde_json::from_value(j).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn names_never_influence_the_choice() {
        // Spec §222: ein Label „Commentator“ macht eine Quelle nicht zum Kommentator.
        let named = src("n1", "Commentator", "n", MediaType::Audio, &[]);
        let tagged = src("n2", "Audio 7", "n", MediaType::Audio, &["role.commentator"]);
        let r = resolve(&sel_audio(&["role.commentator"]), &[named, tagged]);
        assert_eq!(r.selected_id.as_deref(), Some("n2"));
    }
}
