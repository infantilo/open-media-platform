//! Auflösung: Quelle + Ausgabeprofil + Zuordnung + Regeln → [`AudioPlan`].

use crate::model::*;
use crate::processors::{self, Matrix};
use crate::tagexpr::TagExpr;

/// Flache Quellkanal-Liste (Spalten der Matrizen), Spuren nach Nummer.
fn flat_channels(source: &SourceDesc) -> (Vec<SourceTrack>, Vec<SrcChannel>) {
    let mut tracks = source.tracks.clone();
    tracks.sort_by_key(|t| t.n);
    let cols = tracks
        .iter()
        .flat_map(|t| t.channel_names().into_iter().map(|name| SrcChannel { track: t.n, name }))
        .collect();
    (tracks, cols)
}

struct Attempt {
    matrix: Matrix,
    chain: Vec<ProcessorRef>,
}

fn parse(expr: &str) -> Result<TagExpr, String> {
    TagExpr::parse(expr).map_err(|e| format!("Tag-Ausdruck '{expr}': {e}"))
}

fn try_spec(group: &TargetGroup, spec: &SourceSpec, tracks: &[SourceTrack], ncols: usize) -> Result<Attempt, String> {
    let dst_names = group.channel_names();
    let dst = dst_names.len();
    if dst == 0 {
        return Err(format!("Gruppe '{}' hat keine Kanäle", group.id));
    }
    // Spalte des ersten Kanals je Spur.
    let first_col = |n: u32| -> Option<usize> {
        let mut col = 0;
        for t in tracks {
            if t.n == n {
                return Some(col);
            }
            col += t.channel_names().len();
        }
        None
    };
    let mut selected: Vec<Option<usize>> = Vec::new();
    match (&spec.tracks, &spec.select) {
        (Some(list), None) => {
            for &n in list {
                if n == 0 {
                    selected.push(None);
                    continue;
                }
                let t = tracks.iter().find(|t| t.n == n).ok_or_else(|| format!("Spur {n} fehlt in der Quelle"))?;
                let c0 = first_col(n).expect("Spur existiert");
                selected.extend((0..t.channel_names().len()).map(|i| Some(c0 + i)));
            }
        }
        (None, Some(expr)) => {
            let e = parse(expr)?;
            let matching: Vec<&SourceTrack> = tracks.iter().filter(|t| e.matches(&t.all_tags())).collect();
            if matching.is_empty() {
                return Err(format!("keine Spur passt zu '{expr}'"));
            }
            // Kanalname per `ch:`-Tag hat Vorrang vor der Reihenfolge.
            let by_name: Option<Vec<Option<usize>>> = dst_names
                .iter()
                .map(|name| {
                    let tag = format!("ch:{}", name.to_ascii_lowercase());
                    matching
                        .iter()
                        .find(|t| t.tags.iter().any(|x| x.eq_ignore_ascii_case(&tag)))
                        .and_then(|t| first_col(t.n))
                        .map(Some)
                })
                .collect();
            match by_name {
                Some(v) => selected = v,
                None => {
                    for t in matching {
                        let c0 = first_col(t.n).expect("Spur existiert");
                        selected.extend((0..t.channel_names().len()).map(|i| Some(c0 + i)));
                    }
                }
            }
        }
        _ => return Err("Quellvorgabe braucht genau eines von 'tracks' oder 'select'".to_string()),
    }
    let via = spec.via.as_deref().unwrap_or("auto");
    if !processors::MATRIX_PROCESSORS.contains(&via) {
        return Err(format!("unbekannter Prozessor '{via}'"));
    }
    let m = selected.len();
    let coeffs = processors::matrix_for(via, m, dst).ok_or_else(|| format!("Prozessor '{via}' passt nicht zu {m} → {dst} Kanälen"))?;
    let mut matrix = vec![vec![0.0f32; ncols]; dst];
    for (r, row) in coeffs.iter().enumerate() {
        for (j, &coef) in row.iter().enumerate() {
            if let Some(col) = selected[j] {
                matrix[r][col] += coef;
            }
        }
    }
    for p in &spec.chain {
        if !processors::DSP_PROCESSORS.contains(&p.name.as_str()) {
            return Err(format!("unbekannter Verarbeitungsschritt '{}'", p.name));
        }
    }
    if group.bit_exact() && (!processors::is_pure_selection(&matrix) || !spec.chain.is_empty()) {
        return Err(format!("Gruppe '{}' ist bit-exakt: nur 1:1-Auswahl ohne Verarbeitung erlaubt", group.id));
    }
    Ok(Attempt { matrix, chain: spec.chain.clone() })
}

fn when_applies(w: &When, source: &SourceDesc, tracks: &[SourceTrack]) -> Result<bool, String> {
    if let Some(k) = w.source
        && k != source.kind
    {
        return Ok(false);
    }
    let any = |expr: &str| -> Result<bool, String> {
        let e = parse(expr)?;
        Ok(tracks.iter().any(|t| e.matches(&t.all_tags())))
    };
    if let Some(m) = &w.missing
        && any(m)?
    {
        return Ok(false);
    }
    if let Some(h) = &w.has
        && !any(h)?
    {
        return Ok(false);
    }
    Ok(true)
}

fn plan(group: &TargetGroup, ncols: usize, a: Option<Attempt>, rule: Option<String>, warnings: Vec<String>, failed: bool) -> GroupPlan {
    let (matrix, chain, silent) = match a {
        Some(a) => (a.matrix, a.chain, false),
        None => (vec![vec![0.0; ncols]; group.channel_names().len()], Vec::new(), true),
    };
    GroupPlan { group: group.id.clone(), matrix, chain, silent, rule, warnings, failed }
}

fn resolve_group(group: &TargetGroup, source: &SourceDesc, tracks: &[SourceTrack], ncols: usize, mapping: Option<&Mapping>, rules: &RuleSet) -> GroupPlan {
    let spec = mapping.and_then(|m| m.groups.get(&group.id)).or(group.default_source.as_ref());
    let reason = match spec {
        Some(s) => match try_spec(group, s, tracks, ncols) {
            Ok(a) => return plan(group, ncols, Some(a), None, vec![], false),
            Err(e) => e,
        },
        None => "keine Quellvorgabe".to_string(),
    };
    let had_spec = spec.is_some();
    for rule in rules.rules.iter().filter(|r| r.group == group.id || r.group == "*") {
        match when_applies(&rule.when, source, tracks) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => return plan(group, ncols, None, Some(rule.id.clone()), vec![format!("{}: Regel '{}': {e}", group.label, rule.id)], true),
        }
        let mut pending: Vec<String> = Vec::new();
        for action in &rule.then {
            if let Some(u) = &action.use_ {
                if let Ok(a) = try_spec(group, u, tracks, ncols) {
                    let mut w = vec![format!("{}: {reason} → Ersatz per Regel '{}'", group.label, rule.id)];
                    w.append(&mut pending);
                    w.extend(action.warn.iter().map(|t| format!("{}: {t}", group.label)));
                    return plan(group, ncols, Some(a), Some(rule.id.clone()), w, false);
                }
                continue;
            }
            if action.silence || action.fail {
                let mut w = vec![format!("{}: {reason}", group.label)];
                w.append(&mut pending);
                w.extend(action.warn.iter().map(|t| format!("{}: {t}", group.label)));
                return plan(group, ncols, None, Some(rule.id.clone()), w, action.fail);
            }
            pending.extend(action.warn.iter().map(|t| format!("{}: {t}", group.label)));
        }
    }
    let warnings = if had_spec { vec![format!("{}: {reason}; keine Regel anwendbar, Gruppe bleibt still", group.label)] } else { vec![] };
    plan(group, ncols, None, None, warnings, false)
}

/// Löst alle Zielgruppen des Profils gegen die Quelle auf.
pub fn resolve(profile: &OutputProfile, source: &SourceDesc, mapping: Option<&Mapping>, rules: &RuleSet) -> AudioPlan {
    let (tracks, src_channels) = flat_channels(source);
    let ncols = src_channels.len();
    let groups: Vec<GroupPlan> = profile.groups.iter().map(|g| resolve_group(g, source, &tracks, ncols, mapping, rules)).collect();
    let warnings = groups.iter().flat_map(|g| g.warnings.clone()).collect();
    let ok = groups.iter().all(|g| !g.failed);
    AudioPlan { src_channels, groups, warnings, ok }
}

/// Wählt das passendste Spurschema (meiste erfüllte Kriterien) für eine Datei.
pub fn select_schema<'a>(schemas: &'a [TrackSchema], probe: &ProbeInfo) -> Option<&'a TrackSchema> {
    schemas
        .iter()
        .filter_map(|s| {
            let m = &s.matcher;
            let mut score = 0;
            if let Some(f) = &m.format {
                if !f.eq_ignore_ascii_case(&probe.format) {
                    return None;
                }
                score += 1;
            }
            if let Some(n) = m.tracks {
                if n != probe.track_count {
                    return None;
                }
                score += 1;
            }
            if let Some(g) = &m.path_glob {
                if !glob(g, &probe.path) {
                    return None;
                }
                score += 1;
            }
            Some((score, s))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, s)| s)
}

/// `*` = beliebig viele Zeichen; sonst wörtlich, Groß-/Kleinschreibung egal.
fn glob(pattern: &str, text: &str) -> bool {
    let (p, t) = (pattern.to_lowercase(), text.to_lowercase());
    let parts: Vec<&str> = p.split('*').collect();
    if parts.len() == 1 {
        return p == t;
    }
    let mut rest = t.as_str();
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        match rest.find(part) {
            Some(pos) if i > 0 || pos == 0 => rest = &rest[pos + part.len()..],
            _ => return false,
        }
    }
    parts.last().is_some_and(|l| l.is_empty()) || rest.is_empty()
}

/// Prüft Einstellungen vor dem Speichern; leere Liste = gültig.
pub fn validate(profile: &OutputProfile, schemas: &[TrackSchema], mappings: &[Mapping], rules: &RuleSet) -> Vec<String> {
    let mut errs = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    for g in &profile.groups {
        if g.id.is_empty() || !ids.insert(g.id.clone()) {
            errs.push(format!("Zielgruppe '{}': ID leer oder doppelt", g.id));
        }
        if g.layout == Layout::Custom && g.channels.is_empty() {
            errs.push(format!("Zielgruppe '{}': Layout 'custom' braucht Kanalnamen", g.id));
        }
        if let Some(s) = &g.default_source {
            check_spec(&format!("Zielgruppe '{}' Vorgabe", g.id), s, Some(g), &mut errs);
        }
    }
    let mut sids = std::collections::BTreeSet::new();
    for s in schemas {
        if !sids.insert(&s.id) {
            errs.push(format!("Spurschema '{}': doppelte ID", s.id));
        }
        let mut ns = std::collections::BTreeSet::new();
        for t in &s.tracks {
            if t.n == 0 || !ns.insert(t.n) {
                errs.push(format!("Spurschema '{}': Spurnummer {} ungültig oder doppelt", s.id, t.n));
            }
        }
    }
    for m in mappings {
        for (gid, spec) in &m.groups {
            match profile.groups.iter().find(|g| &g.id == gid) {
                None => errs.push(format!("Zuordnung '{}': unbekannte Zielgruppe '{gid}'", m.id)),
                g => check_spec(&format!("Zuordnung '{}' / {gid}", m.id), spec, g, &mut errs),
            }
        }
    }
    for r in &rules.rules {
        if r.group != "*" && !profile.groups.iter().any(|g| g.id == r.group) {
            errs.push(format!("Regel '{}': unbekannte Zielgruppe '{}'", r.id, r.group));
        }
        for e in [&r.when.missing, &r.when.has].into_iter().flatten() {
            if let Err(e) = parse(e) {
                errs.push(format!("Regel '{}': {e}", r.id));
            }
        }
        let target = profile.groups.iter().find(|g| g.id == r.group);
        for a in &r.then {
            if let Some(u) = &a.use_ {
                check_spec(&format!("Regel '{}'", r.id), u, target, &mut errs);
            }
        }
    }
    errs
}

fn check_spec(ctx: &str, s: &SourceSpec, group: Option<&TargetGroup>, errs: &mut Vec<String>) {
    match (&s.tracks, &s.select) {
        (Some(_), None) => {}
        (None, Some(e)) => {
            if let Err(e) = parse(e) {
                errs.push(format!("{ctx}: {e}"));
            }
        }
        _ => errs.push(format!("{ctx}: genau eines von 'tracks' oder 'select' angeben")),
    }
    if let Some(v) = &s.via
        && !processors::MATRIX_PROCESSORS.contains(&v.as_str())
    {
        errs.push(format!("{ctx}: unbekannter Prozessor '{v}'"));
    }
    for p in &s.chain {
        if !processors::DSP_PROCESSORS.contains(&p.name.as_str()) {
            errs.push(format!("{ctx}: unbekannter Verarbeitungsschritt '{}'", p.name));
        }
    }
    if let Some(g) = group
        && g.bit_exact()
        && (!s.chain.is_empty() || !matches!(s.via.as_deref(), None | Some("auto") | Some("matrix")))
    {
        errs.push(format!("{ctx}: Gruppe '{}' ist bit-exakt, keine Verarbeitung erlaubt", g.id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::defaults::*;

    fn mono_tracks(n: u32) -> SourceDesc {
        SourceDesc {
            kind: SourceKind::File,
            tracks: (1..=n).map(|i| SourceTrack { n: i, layout: Layout::Mono, channels: vec![], tags: vec![format!("pos:{i}")] }).collect(),
        }
    }

    fn live(tracks: Vec<SourceTrack>) -> SourceDesc {
        SourceDesc { kind: SourceKind::Live, tracks }
    }

    fn track(n: u32, layout: Layout, tags: &[&str]) -> SourceTrack {
        SourceTrack { n, layout, channels: vec![], tags: tags.iter().map(|t| t.to_string()).collect() }
    }

    /// Jedes der 13 importierten ORF-Presets liefert exakt die Matrix der alten Routen.
    #[test]
    fn imported_orf_presets_match_the_old_routes() {
        #[derive(serde::Deserialize)]
        struct Old {
            presets: Vec<P>,
        }
        #[derive(serde::Deserialize)]
        struct P {
            id: String,
            routes: Vec<R>,
        }
        #[derive(serde::Deserialize)]
        struct R {
            #[serde(rename = "srcTrack")]
            src_track: usize,
            group: String,
            #[serde(rename = "groupChannel")]
            group_channel: usize,
        }
        let old: Old = serde_json::from_str(include_str!("../defaults/orf-mxf-player.json")).unwrap();
        let profile = default_profile();
        let mappings = default_mappings();
        assert_eq!(mappings.len(), 13);
        let src = mono_tracks(8);
        for p in &old.presets {
            let m = mappings.iter().find(|m| m.id == p.id).unwrap();
            let plan = resolve(&profile, &src, Some(m), &RuleSet::default());
            assert!(plan.ok, "{}: {:?}", p.id, plan.warnings);
            for g in &plan.groups {
                let mut expect = vec![vec![0.0f32; 8]; g.matrix.len()];
                for r in p.routes.iter().filter(|r| r.group == g.group) {
                    expect[r.group_channel][r.src_track - 1] = 1.0;
                }
                assert_eq!(g.matrix, expect, "Preset {} Gruppe {}", p.id, g.group);
            }
        }
    }

    #[test]
    fn missing_51_falls_back_to_upmix_of_stereo_program() {
        let src = live(vec![track(1, Layout::Stereo, &["role:pt"])]);
        let plan = resolve(&default_profile(), &src, None, &default_rules());
        let g = plan.groups.iter().find(|g| g.group == "surround51").unwrap();
        assert_eq!(g.rule.as_deref(), Some("51-aus-stereo"));
        assert!(!g.silent && g.matrix.len() == 6 && g.matrix[0] == vec![1.0, 0.0]);
        assert!(g.warnings[0].contains("Ersatz"), "{:?}", g.warnings);
        assert!(plan.ok);
    }

    #[test]
    fn pt_from_51_uses_the_itu_downmix() {
        let mut p = default_profile();
        p.groups.truncate(1);
        let src = live(vec![track(1, Layout::Surround51, &["role:pt"])]);
        let plan = resolve(&p, &src, None, &default_rules());
        let g = &plan.groups[0];
        assert_eq!(g.rule.as_deref(), Some("pt-aus-51"));
        assert!((g.matrix[0][2] - 0.7071).abs() < 1e-3);
    }

    #[test]
    fn explicit_spec_beats_rules_and_silence_via_track_zero() {
        let mut m = Mapping::default();
        m.groups.insert("pt".into(), SourceSpec { tracks: Some(vec![3, 0]), ..Default::default() });
        let mut p = default_profile();
        p.groups.truncate(1);
        let plan = resolve(&p, &mono_tracks(4), Some(&m), &default_rules());
        let g = &plan.groups[0];
        assert!(g.rule.is_none() && !g.silent);
        assert_eq!(g.matrix, vec![vec![0.0, 0.0, 1.0, 0.0], vec![0.0; 4]]);
    }

    #[test]
    fn channel_name_tags_override_track_order() {
        let g = TargetGroup { default_source: Some(SourceSpec { select: Some("role:x".into()), ..Default::default() }), ..group("g", "G", Layout::Stereo, &[]) };
        let src = live(vec![track(1, Layout::Mono, &["role:x", "ch:R"]), track(2, Layout::Mono, &["role:x", "ch:L"])]);
        let plan = resolve(&OutputProfile { groups: vec![g] }, &src, None, &RuleSet::default());
        assert_eq!(plan.groups[0].matrix, vec![vec![0.0, 1.0], vec![1.0, 0.0]]);
    }

    #[test]
    fn bit_exact_group_rejects_processing() {
        let mut g = group("de", "DE", Layout::Stereo, &["bitexact"]);
        g.default_source = Some(SourceSpec { select: Some("layout:stereo".into()), chain: vec![ProcessorRef { name: "gain".into(), params: Default::default() }], ..Default::default() });
        let src = live(vec![track(1, Layout::Stereo, &[])]);
        let plan = resolve(&OutputProfile { groups: vec![g] }, &src, None, &RuleSet::default());
        assert!(plan.groups[0].silent);
        assert!(plan.warnings[0].contains("bit-exakt"), "{:?}", plan.warnings);
    }

    #[test]
    fn fail_action_blocks_the_plan() {
        let g = TargetGroup { default_source: Some(SourceSpec { tracks: Some(vec![9]), ..Default::default() }), ..group("g", "G", Layout::Mono, &[]) };
        let rules = RuleSet { rules: vec![Rule { id: "r".into(), group: "*".into(), when: When::default(), then: vec![Action { fail: true, warn: Some("Pflichtspur fehlt".into()), ..Default::default() }] }] };
        let plan = resolve(&OutputProfile { groups: vec![g] }, &mono_tracks(2), None, &rules);
        assert!(!plan.ok && plan.groups[0].failed);
    }

    #[test]
    fn unsatisfied_without_rule_stays_silent_with_warning() {
        let g = TargetGroup { default_source: Some(SourceSpec { select: Some("role:ad".into()), ..Default::default() }), ..group("ad", "AD", Layout::Stereo, &[]) };
        let plan = resolve(&OutputProfile { groups: vec![g] }, &mono_tracks(2), None, &RuleSet::default());
        assert!(plan.groups[0].silent && plan.ok);
        assert!(plan.warnings[0].contains("keine Regel"));
    }

    #[test]
    fn group_without_any_spec_is_silent_and_quiet() {
        let mut profile = default_profile();
        profile.groups.iter_mut().for_each(|g| g.default_source = None);
        let plan = resolve(&profile, &mono_tracks(8), None, &RuleSet::default());
        assert!(plan.groups.iter().all(|g| g.silent) && plan.warnings.is_empty());
    }

    #[test]
    fn rule_conditions_filter() {
        let g = TargetGroup { default_source: Some(SourceSpec { select: Some("role:zz".into()), ..Default::default() }), ..group("g", "G", Layout::Mono, &[]) };
        let r = |when: When| RuleSet { rules: vec![Rule { id: "r".into(), group: "g".into(), when, then: vec![select("pos:2", None)] }] };
        let p = OutputProfile { groups: vec![g] };
        let file = mono_tracks(3);
        let hit = resolve(&p, &file, None, &r(When { source: Some(SourceKind::File), ..Default::default() }));
        assert_eq!(hit.groups[0].rule.as_deref(), Some("r"));
        let miss = resolve(&p, &file, None, &r(When { source: Some(SourceKind::Live), ..Default::default() }));
        assert!(miss.groups[0].silent);
        let blocked = resolve(&p, &file, None, &r(When { missing: Some("pos:1".into()), ..Default::default() }));
        assert!(blocked.groups[0].silent);
    }

    #[test]
    fn schema_selection_prefers_the_most_specific_match() {
        let general = TrackSchema { id: "mxf".into(), matcher: SchemaMatch { format: Some("mxf".into()), ..Default::default() }, tracks: vec![] };
        let specific = TrackSchema { id: "mxf8".into(), matcher: SchemaMatch { format: Some("MXF".into()), tracks: Some(8), path_glob: Some("/media/orf/*.mxf".into()) }, tracks: vec![] };
        let schemas = vec![general, specific];
        let probe = ProbeInfo { format: "mxf".into(), track_count: 8, path: "/media/ORF/news.mxf".into() };
        assert_eq!(select_schema(&schemas, &probe).unwrap().id, "mxf8");
        let other = ProbeInfo { format: "mxf".into(), track_count: 16, path: "/x/y.mxf".into() };
        assert_eq!(select_schema(&schemas, &other).unwrap().id, "mxf");
        assert!(select_schema(&schemas, &ProbeInfo { format: "mov".into(), ..Default::default() }).is_none());
    }

    #[test]
    fn defaults_are_valid_and_validation_finds_mistakes() {
        assert!(validate(&default_profile(), &default_schemas(), &default_mappings(), &default_rules()).is_empty());
        let mut bad_map = Mapping { id: "m".into(), ..Default::default() };
        bad_map.groups.insert("nope".into(), SourceSpec::default());
        bad_map.groups.insert("dolbye".into(), SourceSpec { select: Some("a".into()), via: Some("upmix51".into()), ..Default::default() });
        let bad_rules = RuleSet { rules: vec![Rule { id: "r".into(), group: "pt".into(), when: When { missing: Some("a AND".into()), ..Default::default() }, then: vec![] }] };
        let errs = validate(&default_profile(), &[], &[bad_map], &bad_rules);
        assert!(errs.iter().any(|e| e.contains("unbekannte Zielgruppe 'nope'")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("bit-exakt")), "{errs:?}");
        assert!(errs.iter().any(|e| e.contains("Tag-Ausdruck")), "{errs:?}");
    }

    #[test]
    fn plan_serializes_to_json() {
        let plan = resolve(&default_profile(), &mono_tracks(8), default_mappings().iter().find(|m| m.id == "stereo"), &RuleSet::default());
        let j = serde_json::to_value(&plan).unwrap();
        assert_eq!(j["groups"][0]["group"], "pt");
        assert_eq!(j["src_channels"].as_array().unwrap().len(), 8);
    }
}
