//! Label-Plan aus JSON (Konfiguration, CLI). Labels werden bevorzugt über
//! ihr Symbol aus dem Dictionary (ST 428-12/2067-8) angegeben, z. B. `"L"`,
//! `"Ls"`, `"ST"`, `"51"`, `"MPg"`; alternativ als UL `06.0E.2B.34…`.
//!
//! ```json
//! { "replaceExisting": true,
//!   "channels": [ {"index":0,"label":"L","soundfieldGroup":0}, {"index":1,"label":"R","soundfieldGroup":0} ],
//!   "soundfieldGroups": [ {"label":"ST","groups":[0],"items":{"content":"PRM","useClass":"FCMP"}} ],
//!   "groups": [ {"label":"MPg","items":{"spokenLanguage":"de","spokenLanguageAttribute":"ORIGINAL"}} ] }
//! ```

use serde::Deserialize;

use crate::inject::{InjectError, Plan, PlanChannel, PlanGroup};
use crate::keys::Ul;
use crate::model::McaItems;
use crate::vocab::{self, Facet};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanJson {
    replace_existing: Option<bool>,
    #[serde(default)]
    channels: Vec<ChannelJson>,
    #[serde(default)]
    soundfield_groups: Vec<GroupJson>,
    #[serde(default)]
    groups: Vec<GroupJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChannelJson {
    index: usize,
    label: String,
    symbol: Option<String>,
    name: Option<String>,
    soundfield_group: Option<usize>,
    #[serde(default)]
    items: McaItems,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroupJson {
    label: String,
    symbol: Option<String>,
    name: Option<String>,
    #[serde(default)]
    groups: Vec<usize>,
    #[serde(default)]
    items: McaItems,
}

fn parse_ul(s: &str) -> Option<Ul> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 16 {
        return None;
    }
    let mut ul = [0u8; 16];
    for (i, p) in parts.iter().enumerate() {
        ul[i] = u8::from_str_radix(p, 16).ok()?;
    }
    Some(ul)
}

fn resolve_label(facet: Facet, s: &str) -> Result<(Ul, &'static str), InjectError> {
    if let Some(ul) = parse_ul(s) {
        let sym = vocab::lookup_label(&ul).map_or("", |d| d.symbol);
        return Ok((ul, sym));
    }
    vocab::LABELS
        .iter()
        .find(|d| d.facet == facet && d.symbol == s)
        .map(|d| (d.ul, d.symbol))
        .ok_or_else(|| InjectError::Plan(format!("unbekanntes Label „{s}“ (Symbol aus ST 428-12/2067-8 oder UL 06.0E.2B.34…)")))
}

fn group(facet: Facet, g: GroupJson) -> Result<PlanGroup, InjectError> {
    let (ul, sym) = resolve_label(facet, &g.label)?;
    Ok(PlanGroup { dictionary_id: ul, symbol: g.symbol.unwrap_or_else(|| if sym.is_empty() { "grp".into() } else { format!("{}{}", if facet == Facet::SoundfieldGroup { "sg" } else { "" }, sym) }), name: g.name, items: g.items, groups: g.groups })
}

impl Plan {
    /// Plan aus JSON lesen (s. Moduldoku).
    pub fn from_json(text: &str) -> Result<Plan, InjectError> {
        let j: PlanJson = serde_json::from_str(text).map_err(|e| InjectError::Plan(format!("JSON: {e}")))?;
        let mut plan = Plan::new();
        plan.replace_existing = j.replace_existing.unwrap_or(true);
        for c in j.channels {
            let (ul, sym) = resolve_label(Facet::Channel, &c.label)?;
            plan.channels.push(PlanChannel {
                index: c.index,
                dictionary_id: ul,
                symbol: c.symbol.unwrap_or_else(|| if sym.is_empty() { format!("ch{}", c.index + 1) } else { format!("ch{sym}") }),
                name: c.name,
                items: c.items,
                soundfield_group: c.soundfield_group,
            });
        }
        for g in j.soundfield_groups {
            plan.soundfield_groups.push(group(Facet::SoundfieldGroup, g)?);
        }
        for g in j.groups {
            plan.groups.push(group(Facet::GroupOfSoundfieldGroups, g)?);
        }
        Ok(plan)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_symbols_and_defaults() {
        let p = Plan::from_json(
            r#"{"channels":[{"index":0,"label":"L","soundfieldGroup":0},{"index":1,"label":"R","soundfieldGroup":0}],
                "soundfieldGroups":[{"label":"ST","groups":[0],"items":{"content":"PRM","useClass":"FCMP"}}],
                "groups":[{"label":"MPg","items":{"spokenLanguage":"de"}}]}"#,
        )
        .unwrap();
        assert_eq!(p.channels[0].symbol, "chL");
        assert_eq!(p.soundfield_groups[0].symbol, "sgST");
        assert_eq!(p.groups[0].symbol, "MPg");
        assert!(p.replace_existing);
        p.validate(2).unwrap();
    }

    #[test]
    fn rejects_unknown_labels_and_fields() {
        assert!(Plan::from_json(r#"{"channels":[{"index":0,"label":"Zzz"}]}"#).is_err());
        assert!(Plan::from_json(r#"{"channels":[{"index":0,"label":"L","bogus":1}]}"#).is_err());
        assert!(Plan::from_json(r#"{"channels":[{"index":0,"label":"06.0E.2B.34.04.01.01.0D.03.02.01.0B.00.00.00.00"}]}"#).is_ok());
        // Kanal-Symbol auf eine SG-Position angegeben → unbekannt (Facet-getrennt)
        assert!(Plan::from_json(r#"{"soundfieldGroups":[{"label":"L"}]}"#).is_err());
    }
}
