//! Zustand der gleichzeitig sichtbaren Grafik-Ebenen (Nutzerwunsch
//! 2026-10-01, Vorbild PIPELINE CONTROLLERs Grafik-Panel: mehrere Grafiken
//! gleichzeitig auf Sendung, Anzeige welche on air sind, Live-Update,
//! Continue nur für mehrstufige Templates, einzeln ausblendbar).
//!
//! Reine Zustandslogik ohne GStreamer/HTTP, damit sie per Unit-Test prüfbar
//! ist. Der Node hält die Wahrheit über den aktuellen Schritt einer Ebene
//! (die Harness-Seite bekommt ihn als Zielschritt übergeben).

use serde_json::{Map, Value};

use crate::templates::TemplateInfo;

#[derive(Clone, Debug, PartialEq)]
pub struct Layer {
    pub id: String,
    pub template_id: String,
    pub label: String,
    pub data: Value,
    /// Aktueller Schritt (0-basiert).
    pub step: u32,
    pub step_count: u32,
}

#[derive(Default)]
pub struct Layers {
    // Reihenfolge = Einblendreihenfolge (die zuletzt gezeigte liegt oben).
    list: Vec<Layer>,
}

impl Layers {
    /// Blendet eine Ebene ein oder aktualisiert sie (gleiche ID). Wechselt das
    /// Template einer vorhandenen Ebene, beginnt sie wieder bei Schritt 0.
    pub fn show(&mut self, id: &str, tpl: &TemplateInfo, data: Value) {
        if let Some(l) = self.list.iter_mut().find(|l| l.id == id) {
            if l.template_id != tpl.id {
                l.step = 0;
            }
            l.template_id = tpl.id.clone();
            l.label = tpl.label.clone();
            l.step_count = tpl.step_count;
            l.data = data;
            return;
        }
        self.list.push(Layer {
            id: id.to_string(),
            template_id: tpl.id.clone(),
            label: tpl.label.clone(),
            data,
            step: 0,
            step_count: tpl.step_count,
        });
    }

    /// Führt `patch` in die Daten einer sichtbaren Ebene ein und liefert die
    /// vollständigen neuen Daten (OGraf `updateAction` bekommt den ganzen
    /// Datensatz). None, wenn die Ebene nicht on air ist.
    pub fn update(&mut self, id: &str, patch: &Map<String, Value>) -> Option<Value> {
        let l = self.list.iter_mut().find(|l| l.id == id)?;
        if let Value::Object(map) = &mut l.data {
            for (k, v) in patch {
                map.insert(k.clone(), v.clone());
            }
        } else {
            l.data = Value::Object(patch.clone());
        }
        Some(l.data.clone())
    }

    /// Rückt eine mehrstufige Ebene einen Schritt weiter. Some(neuer Schritt),
    /// wenn es weiterging; None bei unbekannter Ebene oder am letzten Schritt
    /// (bzw. bei einstufigen Templates — dort gibt es kein "Continue").
    pub fn advance(&mut self, id: &str) -> Option<u32> {
        let l = self.list.iter_mut().find(|l| l.id == id)?;
        if l.step + 1 >= l.step_count {
            return None;
        }
        l.step += 1;
        Some(l.step)
    }

    /// Entfernt eine Ebene (Some(id)) oder alle (None); liefert die
    /// entfernten IDs.
    pub fn hide(&mut self, id: Option<&str>) -> Vec<String> {
        match id {
            Some(id) => {
                let before = self.list.len();
                self.list.retain(|l| l.id != id);
                if self.list.len() < before { vec![id.to_string()] } else { vec![] }
            }
            None => self.list.drain(..).map(|l| l.id).collect(),
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.list.iter().any(|l| l.id == id)
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    /// Eindeutige Ebene, wenn genau eine on air ist (für Aufrufe ohne ID).
    pub fn only(&self) -> Option<&Layer> {
        if self.list.len() == 1 { self.list.first() } else { None }
    }

    /// Template der zuletzt eingeblendeten Ebene (Rückwärtskompatibilität
    /// des Parameters `current`).
    pub fn current_template(&self) -> Option<String> {
        self.list.last().map(|l| l.template_id.clone())
    }

    pub fn to_json(&self) -> Value {
        Value::Array(
            self.list
                .iter()
                .map(|l| {
                    serde_json::json!({
                        "id": l.id,
                        "templateId": l.template_id,
                        "label": l.label,
                        "data": l.data,
                        "step": l.step,
                        "stepCount": l.step_count,
                        // Continue nur bei mehrstufigen Templates, und nur
                        // solange es einen weiteren Schritt gibt.
                        "hasContinue": l.step_count > 1,
                        "canContinue": l.step + 1 < l.step_count,
                    })
                })
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tpl(id: &str, steps: u32) -> TemplateInfo {
        TemplateInfo::for_test(id, steps)
    }

    #[test]
    fn show_stacks_layers_and_updates_same_id() {
        let mut l = Layers::default();
        l.show("a", &tpl("a", 1), json!({"x": 1}));
        l.show("b", &tpl("b", 3), json!({}));
        assert_eq!(l.to_json().as_array().unwrap().len(), 2);
        l.show("a", &tpl("a", 1), json!({"x": 2}));
        let j = l.to_json();
        assert_eq!(j.as_array().unwrap().len(), 2, "gleiche ID ersetzt, stapelt nicht");
        assert_eq!(j[0]["data"]["x"], 2);
        assert_eq!(l.current_template().as_deref(), Some("b"));
    }

    #[test]
    fn update_merges_into_full_data() {
        let mut l = Layers::default();
        l.show("a", &tpl("a", 1), json!({"title": "alt", "sub": "s"}));
        let patch = json!({"title": "neu"});
        let full = l.update("a", patch.as_object().unwrap()).unwrap();
        assert_eq!(full, json!({"title": "neu", "sub": "s"}));
        assert!(l.update("nix", patch.as_object().unwrap()).is_none());
    }

    #[test]
    fn continue_only_for_multistep_until_last_step() {
        let mut l = Layers::default();
        l.show("single", &tpl("single", 1), json!({}));
        l.show("multi", &tpl("multi", 3), json!({}));
        assert_eq!(l.advance("single"), None, "einstufig: kein Continue");
        assert_eq!(l.advance("multi"), Some(1));
        assert_eq!(l.advance("multi"), Some(2));
        assert_eq!(l.advance("multi"), None, "am letzten Schritt endet es");
        let j = l.to_json();
        assert_eq!(j[0]["hasContinue"], false);
        assert_eq!(j[1]["hasContinue"], true);
        assert_eq!(j[1]["canContinue"], false);
        assert_eq!(l.advance("unbekannt"), None);
    }

    #[test]
    fn template_change_on_same_id_resets_step() {
        let mut l = Layers::default();
        l.show("x", &tpl("multi", 3), json!({}));
        l.advance("x");
        l.show("x", &tpl("other", 2), json!({}));
        assert_eq!(l.to_json()[0]["step"], 0);
    }

    #[test]
    fn hide_one_or_all() {
        let mut l = Layers::default();
        l.show("a", &tpl("a", 1), json!({}));
        l.show("b", &tpl("b", 1), json!({}));
        assert_eq!(l.hide(Some("a")), vec!["a".to_string()]);
        assert!(l.hide(Some("a")).is_empty());
        assert_eq!(l.only().map(|x| x.id.as_str()), Some("b"));
        assert_eq!(l.hide(None), vec!["b".to_string()]);
        assert!(l.is_empty());
    }
}
