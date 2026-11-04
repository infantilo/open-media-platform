//! Natural-Group-Name einer Node-Instanz (NMOS `grouphint`, AMWA BCP-002-01).
//!
//! **Muss identisch zu `omp_mediaio::group` bleiben** (die Crates hängen nicht
//! voneinander ab). Der Gruppenteil ist der Instanzname aus `OMP_LABEL` /
//! `OMP_INSTANCE_ID` (vom Launcher gesetzt); dasselbe schreibt `omp-mediaio` in
//! die MXL-Flow-Definitionen, damit IS-04-Sender-Tag und MXL-Flow-Tag derselben
//! Instanz zur selben Gruppe gehören.

pub const GROUPHINT_TAG: &str = "urn:x-nmos:tag:grouphint/v1.0";

pub fn name(label: &str, instance_id: Option<&str>) -> Option<String> {
    let label: String = label.replace(':', "-").trim().to_string();
    if label.is_empty() {
        return None;
    }
    let short = instance_id.map(|i| i.chars().take(8).collect::<String>()).filter(|s| !s.is_empty());
    Some(match short {
        Some(s) if !label.contains(&s) => format!("{label} ({s})"),
        _ => label,
    })
}

/// Name der laufenden Instanz; `None` ohne `OMP_LABEL` (dann kein Auto-Tag).
pub fn from_env() -> Option<String> {
    let label = std::env::var("OMP_LABEL").ok()?;
    let id = std::env::var("OMP_INSTANCE_ID").ok();
    name(&label, id.as_deref())
}

/// Instanzname, sonst `fallback` (z. B. Flow-ID) — für Nodes mit eigenen Rollen.
pub fn name_or(fallback: &str) -> String {
    from_env().unwrap_or_else(|| fallback.to_string())
}

/// Rolle für einen automatisch getaggten Sender: bereinigtes Sender-Label,
/// sonst `<Art> #<n>` (Rollen einer Gruppe müssen verschieden sein, deshalb
/// Position des Senders im Node).
pub fn auto_role(kind: &str, label: Option<&str>, index: usize) -> String {
    match label.map(|l| l.replace(':', "-").trim().to_string()).filter(|l| !l.is_empty()) {
        Some(l) => l,
        None => format!("{kind} #{}", index + 1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_vektoren() {
        assert_eq!(name("Source (3f2a1b9c)", Some("3f2a1b9c-1111")).as_deref(), Some("Source (3f2a1b9c)"));
        assert_eq!(name("Regie 1", Some("3f2a1b9c-1111")).as_deref(), Some("Regie 1 (3f2a1b9c)"));
        assert_eq!(name("Regie: 1", None).as_deref(), Some("Regie- 1"));
        assert_eq!(name("  ", Some("abcd")), None);
    }

    #[test]
    fn rolle() {
        assert_eq!(auto_role("Video", Some("PGM"), 0), "PGM");
        assert_eq!(auto_role("Audio", None, 1), "Audio #2");
    }
}
