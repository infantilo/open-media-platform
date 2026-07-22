//! Optionale Node-Contract-Erweiterung "Plugin-Host" (`ARCHITECTURE.md`
//! §24.4, `UMSETZUNG.md` C19) — PIPELINE-CONTROLLER-Vorbild
//! (`plugins/*.js` + `plugins.json`: dynamisches Laden, `enabled`-Flag,
//! pro-Plugin-Config), hier bewusst **nur der generische Mechanismus**,
//! keines der dortigen konkreten Plugins (die sind eigenständige spätere
//! Katalog-Einträge, s. §24.4).
//!
//! Kein neuer Node-Typ, kein Pflichtpunkt im Node-Contract: ein Node
//! signalisiert Unterstützung, indem sein `ParamStore` die Default-Methode
//! [`crate::ParamStore::plugins`] überschreibt und ein [`PluginRegistry`]
//! zurückgibt — `server::route` exponiert dann automatisch `GET /plugins`
//! (Liste) und `PATCH /plugins/<id>` (Enable/Disable + Config), exakt das
//! Wire-Format, das der Orchestrator-Proxy unter
//! `/api/v1/nodes/<id>/plugins[/​<id>]` weiterreicht (reine
//! Routenregistrierung dort, keine neue Proxy-Logik — derselbe generische
//! `handleNodeProxy` wie bei Params/Methods).
//!
//! `PluginRegistry` ist bewusst die einzige mitgelieferte Implementierung
//! (kein separater Trait): ein Node, der Plugins braucht, definiert seine
//! Plugin-IDs beim Start (`register`) und liest/ändert sie darüber — kein
//! Grund, das hinter einem Trait zu abstrahieren, solange es nur diese
//! eine sinnvolle Umsetzung gibt (YAGNI, gleiche Abwägung wie
//! `RegistryClient`).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Ein einzelnes Plugin — Wire-Format von `GET /plugins`/`PATCH
/// /plugins/<id>` (`ARCHITECTURE.md` §24.4).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    /// Freies JSON-Objekt — der Plugin-Host kennt keine Config-Schemata
    /// (die sind Sache des jeweiligen Plugins, s. Moduldoku "kein neuer
    /// Node-Typ"), gleiche Philosophie wie PIPELINE CONTROLLERs
    /// `plugins.json`.
    pub config: Value,
}

/// In-Memory-Registry aller Plugins eines Nodes — insertion-geordnet
/// (`Vec` statt `HashMap`, gleiches Muster wie `omp-playout-automation`s
/// Cart-Liste, C18): bei der erwarteten kleinen Plugin-Anzahl pro Node
/// ist die O(n)-Suche unproblematisch, dafür bleibt `list()` stabil in
/// Registrierungsreihenfolge.
#[derive(Debug, Default)]
pub struct PluginRegistry {
    plugins: Mutex<Vec<PluginInfo>>,
}

impl PluginRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registriert ein Plugin beim Node-Start — `enabled: false` als
    /// sicherer Default (kein Plugin läuft ungefragt), gleiche
    /// Konvention wie mehrere Einträge in PIPELINE CONTROLLERs
    /// `plugins.json`. Erneutes Registrieren derselben ID überschreibt
    /// den bisherigen Eintrag (praktisch für einen Node-Neustart mit
    /// unverändertem Plugin-Satz, bevor ein `restore()` den zuletzt
    /// gespeicherten Zustand einspielt).
    pub fn register(&self, id: impl Into<String>, label: impl Into<String>, default_config: Value) {
        let id = id.into();
        let mut plugins = self.plugins.lock().expect("lock poisoned");
        plugins.retain(|p| p.id != id);
        plugins.push(PluginInfo { id, label: label.into(), enabled: false, config: default_config });
    }

    pub fn list(&self) -> Vec<PluginInfo> {
        self.plugins.lock().expect("lock poisoned").clone()
    }

    pub fn get(&self, id: &str) -> Option<PluginInfo> {
        self.plugins.lock().expect("lock poisoned").iter().find(|p| p.id == id).cloned()
    }

    /// Liefert `true`, wenn ein Plugin mit dieser ID existiert (auch wenn
    /// `enabled` unverändert blieb) — `false` bedeutet "unbekannte ID",
    /// vom Aufrufer (`server::route`) als 404 behandelt.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> bool {
        let mut plugins = self.plugins.lock().expect("lock poisoned");
        match plugins.iter_mut().find(|p| p.id == id) {
            Some(p) => {
                p.enabled = enabled;
                true
            }
            None => false,
        }
    }

    pub fn set_config(&self, id: &str, config: Value) -> bool {
        let mut plugins = self.plugins.lock().expect("lock poisoned");
        match plugins.iter_mut().find(|p| p.id == id) {
            Some(p) => {
                p.config = config;
                true
            }
            None => false,
        }
    }

    /// Für den `/state`-Snapshot-Mechanismus (`ARCHITECTURE.md` §4.6
    /// Punkt 4, bereits etabliert bei `omp-video-mixer-me`/
    /// `omp-audio-mixer`): ein Node, der bereits `GET`/`POST /state`
    /// implementiert, faltet `capture()`/`restore()` einfach in seinen
    /// eigenen `capture_state`/`restore_state` — kein separater
    /// Mechanismus nötig. Reine Werte-Snapshot, keine HTTP-Kopplung.
    pub fn capture(&self) -> Value {
        serde_json::to_value(self.list()).unwrap_or(Value::Array(vec![]))
    }

    /// Kehrseite von `capture()`: spielt `enabled`/`config` für jede in
    /// `doc` enthaltene, beim Node **weiterhin registrierte** ID wieder
    /// ein — unbekannte/inzwischen entfernte IDs im Snapshot werden
    /// ignoriert (kein Fehler), ein seit dem Snapshot neu registriertes
    /// Plugin ohne Snapshot-Eintrag bleibt bei seinem `register()`-
    /// Default (kein rückwirkendes "alles war mal deaktiviert").
    pub fn restore(&self, doc: &Value) {
        let Some(entries) = doc.as_array() else { return };
        for entry in entries {
            let Some(id) = entry.get("id").and_then(Value::as_str) else { continue };
            if let Some(enabled) = entry.get("enabled").and_then(Value::as_bool) {
                self.set_enabled(id, enabled);
            }
            if let Some(config) = entry.get("config") {
                self.set_config(id, config.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_defaults_to_disabled() {
        let reg = PluginRegistry::new();
        reg.register("scte35", "SCTE-35", serde_json::json!({"pid": 500}));
        let list = reg.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "scte35");
        assert_eq!(list[0].label, "SCTE-35");
        assert!(!list[0].enabled);
        assert_eq!(list[0].config, serde_json::json!({"pid": 500}));
    }

    #[test]
    fn list_preserves_registration_order() {
        let reg = PluginRegistry::new();
        reg.register("b", "B", Value::Null);
        reg.register("a", "A", Value::Null);
        let ids: Vec<_> = reg.list().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["b", "a"]);
    }

    #[test]
    fn re_registering_same_id_overwrites_in_place() {
        let reg = PluginRegistry::new();
        reg.register("x", "X v1", Value::Null);
        reg.set_enabled("x", true);
        reg.register("x", "X v2", Value::Null);
        let list = reg.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "X v2");
        assert!(!list[0].enabled, "re-registering resets to the safe default");
    }

    #[test]
    fn set_enabled_unknown_id_returns_false() {
        let reg = PluginRegistry::new();
        assert!(!reg.set_enabled("nope", true));
    }

    #[test]
    fn set_config_updates_known_plugin() {
        let reg = PluginRegistry::new();
        reg.register("x", "X", serde_json::json!({}));
        assert!(reg.set_config("x", serde_json::json!({"level": 3})));
        assert_eq!(reg.get("x").unwrap().config, serde_json::json!({"level": 3}));
    }

    #[test]
    fn capture_restore_round_trip() {
        let reg = PluginRegistry::new();
        reg.register("a", "A", serde_json::json!({"n": 1}));
        reg.register("b", "B", serde_json::json!({"n": 2}));
        reg.set_enabled("a", true);
        reg.set_config("b", serde_json::json!({"n": 99}));
        let snapshot = reg.capture();

        let reg2 = PluginRegistry::new();
        reg2.register("a", "A", serde_json::json!({"n": 1}));
        reg2.register("b", "B", serde_json::json!({"n": 2}));
        reg2.restore(&snapshot);

        assert!(reg2.get("a").unwrap().enabled);
        assert_eq!(reg2.get("b").unwrap().config, serde_json::json!({"n": 99}));
    }

    #[test]
    fn restore_ignores_ids_not_currently_registered() {
        let reg = PluginRegistry::new();
        reg.register("a", "A", Value::Null);
        // Snapshot enthält ein Plugin, das dieser Node-Start gar nicht
        // (mehr) registriert hat — darf nicht panicen oder ein Phantom-
        // Plugin erzeugen.
        reg.restore(&serde_json::json!([
            {"id": "a", "enabled": true, "config": null},
            {"id": "long-gone", "enabled": true, "config": null},
        ]));
        assert_eq!(reg.list().len(), 1);
        assert!(reg.get("a").unwrap().enabled);
    }
}
