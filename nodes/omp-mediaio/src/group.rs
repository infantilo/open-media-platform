//! Natural-Group-Name einer Node-Instanz (NMOS `grouphint`, AMWA BCP-002-01 /
//! NMOS-Parameter-Register „grouphint“).
//!
//! MXL verlangt (`third_party/mxl/lib/include/mxl/flow.h`, `mxlCreateFlowWriter`),
//! dass der Gruppenteil des Tags `"<Gruppe>:<Rolle>"` den **Namen der
//! Media-Function-Instanz** trägt — damit Flows derselben Instanz (Video, Audio,
//! ANC …) von übergeordneten Anwendungen als Gruppe erkannt werden.
//!
//! Der Name kommt aus den vom Launcher gesetzten Variablen `OMP_LABEL` und
//! `OMP_INSTANCE_ID`. Ohne `OMP_LABEL` (Werkzeuge, Tests, von Hand gestartete
//! Prozesse) gibt es keinen Instanznamen: Aufrufer fallen dann auf die
//! Flow-ID zurück (bisheriges Verhalten).
//!
//! **Muss identisch zu `omp_node_sdk::group` bleiben** (beide Crates hängen
//! nicht voneinander ab; beide Tests prüfen dieselben Vektoren).

/// Gruppenname aus Label und optionaler Instanz-ID. Doppelpunkte (Trenner des
/// Tags) werden ersetzt; hängt die Kurz-ID noch nicht im Label, wird sie
/// angefügt, damit zwei Instanzen mit gleichem Label verschiedene Gruppen sind.
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

/// Name der laufenden Instanz aus `OMP_LABEL`/`OMP_INSTANCE_ID`.
pub fn from_env() -> Option<String> {
    let label = std::env::var("OMP_LABEL").ok()?;
    let id = std::env::var("OMP_INSTANCE_ID").ok();
    name(&label, id.as_deref())
}

/// Instanzname, sonst `fallback` (meist die Flow-ID).
pub fn name_or(fallback: &str) -> String {
    from_env().unwrap_or_else(|| fallback.to_string())
}

/// Eindeutige Rolle je Flow innerhalb des Prozesses: erster Flow einer Art
/// heißt `Video`/`Audio`, weitere `Video #2` … (Spec: Rollen innerhalb einer
/// Gruppe sind verschieden). Derselbe Flow (z. B. nach Pipeline-Neuaufbau)
/// behält seine Rolle.
pub fn role_for(kind: &str, flow_id: &str) -> String {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static ROLES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let mut map = ROLES.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    let key = format!("{kind}/{flow_id}");
    if let Some(r) = map.get(&key) {
        return r.clone();
    }
    let n = map.keys().filter(|k| k.starts_with(&format!("{kind}/"))).count() + 1;
    let role = if n == 1 { kind.to_string() } else { format!("{kind} #{n}") };
    map.insert(key, role.clone());
    role
}

/// Fertiger Tag-Wert `"<Gruppe>:<Rolle>"` für einen MXL-Flow.
pub fn tag_value(kind: &str, flow_id: &str) -> String {
    format!("{}:{}", name_or(flow_id), role_for(kind, flow_id))
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
    fn rollen_sind_je_flow_stabil_und_verschieden() {
        let a = role_for("TestKind", "flow-a");
        let b = role_for("TestKind", "flow-b");
        assert_eq!(a, "TestKind");
        assert_eq!(b, "TestKind #2");
        assert_eq!(role_for("TestKind", "flow-a"), a);
    }
}
