//! Mixer-Modell für Gruppen und Ducking-Regeln (Kapitel 26) — der
//! *Konfigurationszustand*, den UI/Methoden verändern und der in
//! `/state`/Presets gespeichert wird. Die Rechenarbeit passiert in
//! `automation.rs` (Kerne) und `engine.rs` (Thread); hier gibt es keinen
//! Audiobezug.

use serde_json::{Map, Value};

use crate::automation::{AutoMixParams, DetectorKind, DuckParams};
use omp_node_sdk::InvokeError;

#[derive(Clone)]
pub struct GroupState {
    pub id: String,
    pub label: String,
    /// Gruppen-Fader (dB) und -Mute: additiv zu den individuellen Kanalwerten,
    /// die dabei erhalten bleiben.
    pub gain_db: f64,
    pub muted: bool,
    pub automix: AutoMixParams,
}

#[derive(Clone)]
pub struct DuckState {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    /// Kanal-IDs oder `group:<id>`.
    pub keys: Vec<String>,
    pub targets: Vec<String>,
    pub params: DuckParams,
}

fn num(args: &Map<String, Value>, key: &str, cur: f64, lo: f64, hi: f64) -> Result<f64, InvokeError> {
    match args.get(key) {
        None => Ok(cur),
        Some(v) => v.as_f64().map(|x| x.clamp(lo, hi)).ok_or(InvokeError::Unknown),
    }
}

fn flag(args: &Map<String, Value>, key: &str, cur: bool) -> Result<bool, InvokeError> {
    match args.get(key) {
        None => Ok(cur),
        Some(v) => v.as_bool().ok_or(InvokeError::Unknown),
    }
}

fn detector(args: &Map<String, Value>, cur: DetectorKind) -> Result<DetectorKind, InvokeError> {
    match args.get("detector") {
        None => Ok(cur),
        Some(v) => v.as_str().and_then(DetectorKind::parse).ok_or(InvokeError::Unknown),
    }
}

fn csv(args: &Map<String, Value>, key: &str, cur: &[String]) -> Result<Vec<String>, InvokeError> {
    match args.get(key) {
        None => Ok(cur.to_vec()),
        Some(v) => {
            let s = v.as_str().ok_or(InvokeError::Unknown)?;
            Ok(s.split(',').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect())
        }
    }
}

impl GroupState {
    pub fn new(id: String, label: String) -> Self {
        GroupState { id, label, gain_db: 0.0, muted: false, automix: AutoMixParams::default() }
    }

    pub fn to_json(&self) -> Value {
        let a = &self.automix;
        serde_json::json!({
            "id": self.id, "label": self.label, "gainDb": self.gain_db, "mute": self.muted,
            "autoMixEnabled": a.enabled, "attackMs": a.attack_ms, "holdMs": a.hold_ms,
            "releaseMs": a.release_ms, "maxAttenDb": a.max_atten_db, "sharing": a.sharing,
            "detector": a.detector.as_str(),
        })
    }

    /// Fehlende Felder → Defaults (Rückwärtskompatibilität).
    pub fn from_json(d: &Value) -> Option<Self> {
        let id = d.get("id")?.as_str()?.to_string();
        let mut g = GroupState::new(id.clone(), d.get("label").and_then(Value::as_str).unwrap_or(&id).to_string());
        let f = |k: &str, def: f64| d.get(k).and_then(Value::as_f64).unwrap_or(def);
        g.gain_db = f("gainDb", 0.0);
        g.muted = d.get("mute").and_then(Value::as_bool).unwrap_or(false);
        let def = AutoMixParams::default();
        g.automix = AutoMixParams {
            enabled: d.get("autoMixEnabled").and_then(Value::as_bool).unwrap_or(false),
            attack_ms: f("attackMs", def.attack_ms),
            hold_ms: f("holdMs", def.hold_ms),
            release_ms: f("releaseMs", def.release_ms),
            max_atten_db: f("maxAttenDb", def.max_atten_db),
            sharing: f("sharing", def.sharing),
            detector: d
                .get("detector")
                .and_then(Value::as_str)
                .and_then(DetectorKind::parse)
                .unwrap_or(def.detector),
        };
        Some(g)
    }

    pub fn invoke(&mut self, method: &str, args: &Map<String, Value>) -> Result<(), InvokeError> {
        match method {
            "setLabel" => {
                self.label = args.get("label").and_then(Value::as_str).ok_or(InvokeError::Unknown)?.to_string();
            }
            "setGain" => self.gain_db = num(args, "db", self.gain_db, -60.0, 12.0)?,
            "setMute" => self.muted = flag(args, "muted", self.muted)?,
            "setAutoMix" => {
                let a = self.automix;
                self.automix = AutoMixParams {
                    enabled: flag(args, "enabled", a.enabled)?,
                    attack_ms: num(args, "attackMs", a.attack_ms, 1.0, 2000.0)?,
                    hold_ms: num(args, "holdMs", a.hold_ms, 0.0, 5000.0)?,
                    release_ms: num(args, "releaseMs", a.release_ms, 10.0, 10000.0)?,
                    max_atten_db: num(args, "maxAttenDb", a.max_atten_db, -60.0, 0.0)?,
                    sharing: num(args, "sharing", a.sharing, 0.5, 3.0)?,
                    detector: detector(args, a.detector)?,
                };
            }
            _ => return Err(InvokeError::Unknown),
        }
        Ok(())
    }
}

impl DuckState {
    pub fn new(id: String, label: String) -> Self {
        DuckState { id, label, enabled: false, keys: vec![], targets: vec![], params: DuckParams::default() }
    }

    pub fn to_json(&self) -> Value {
        let p = &self.params;
        serde_json::json!({
            "id": self.id, "label": self.label, "enabled": self.enabled,
            "keys": self.keys, "targets": self.targets,
            "thresholdDb": p.threshold_db, "hysteresisDb": p.hysteresis_db,
            "amountDb": p.amount_db, "maxDb": p.max_db, "attackMs": p.attack_ms,
            "holdMs": p.hold_ms, "releaseMs": p.release_ms, "minTriggerMs": p.min_trigger_ms,
            "detector": p.detector.as_str(),
        })
    }

    pub fn from_json(d: &Value) -> Option<Self> {
        let id = d.get("id")?.as_str()?.to_string();
        let mut r = DuckState::new(id.clone(), d.get("label").and_then(Value::as_str).unwrap_or(&id).to_string());
        r.enabled = d.get("enabled").and_then(Value::as_bool).unwrap_or(false);
        let list = |k: &str| -> Vec<String> {
            d.get(k)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        r.keys = list("keys");
        r.targets = list("targets");
        let def = DuckParams::default();
        let f = |k: &str, def: f64| d.get(k).and_then(Value::as_f64).unwrap_or(def);
        r.params = DuckParams {
            threshold_db: f("thresholdDb", def.threshold_db),
            hysteresis_db: f("hysteresisDb", def.hysteresis_db),
            amount_db: f("amountDb", def.amount_db),
            max_db: f("maxDb", def.max_db),
            attack_ms: f("attackMs", def.attack_ms),
            hold_ms: f("holdMs", def.hold_ms),
            release_ms: f("releaseMs", def.release_ms),
            min_trigger_ms: f("minTriggerMs", def.min_trigger_ms),
            detector: d
                .get("detector")
                .and_then(Value::as_str)
                .and_then(DetectorKind::parse)
                .unwrap_or(def.detector),
        };
        Some(r)
    }

    pub fn invoke(&mut self, method: &str, args: &Map<String, Value>) -> Result<(), InvokeError> {
        match method {
            "setLabel" => {
                self.label = args.get("label").and_then(Value::as_str).ok_or(InvokeError::Unknown)?.to_string();
            }
            "set" => {
                let p = self.params.clone();
                self.enabled = flag(args, "enabled", self.enabled)?;
                self.keys = csv(args, "keys", &self.keys)?;
                self.targets = csv(args, "targets", &self.targets)?;
                self.params = DuckParams {
                    threshold_db: num(args, "thresholdDb", p.threshold_db, -90.0, 0.0)?,
                    hysteresis_db: num(args, "hysteresisDb", p.hysteresis_db, 0.0, 20.0)?,
                    amount_db: num(args, "amountDb", p.amount_db, -60.0, 0.0)?,
                    max_db: num(args, "maxDb", p.max_db, -60.0, 0.0)?,
                    attack_ms: num(args, "attackMs", p.attack_ms, 1.0, 5000.0)?,
                    hold_ms: num(args, "holdMs", p.hold_ms, 0.0, 10000.0)?,
                    release_ms: num(args, "releaseMs", p.release_ms, 50.0, 20000.0)?,
                    min_trigger_ms: num(args, "minTriggerMs", p.min_trigger_ms, 0.0, 1000.0)?,
                    detector: detector(args, p.detector)?,
                };
            }
            _ => return Err(InvokeError::Unknown),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn group_membership_state_roundtrips_and_keeps_defaults_for_missing_fields() {
        let mut g = GroupState::new("g1".into(), "Studio Mics".into());
        g.invoke("setGain", &args(serde_json::json!({"db": -4.5}))).unwrap();
        g.invoke("setMute", &args(serde_json::json!({"muted": true}))).unwrap();
        g.invoke("setAutoMix", &args(serde_json::json!({"enabled": true, "maxAttenDb": -12, "detector": "rms"}))).unwrap();
        let back = GroupState::from_json(&g.to_json()).unwrap();
        assert_eq!(back.label, "Studio Mics");
        assert_eq!(back.gain_db, -4.5);
        assert!(back.muted && back.automix.enabled);
        assert_eq!(back.automix.max_atten_db, -12.0);
        assert_eq!(back.automix.detector, DetectorKind::Rms);
        // Nur id → Defaults.
        let min = GroupState::from_json(&serde_json::json!({"id": "x"})).unwrap();
        assert_eq!(min.automix, AutoMixParams::default());
    }

    #[test]
    fn group_invoke_validates_and_clamps() {
        let mut g = GroupState::new("g".into(), "G".into());
        assert!(g.invoke("setGain", &args(serde_json::json!({"db": "laut"}))).is_err());
        assert!(g.invoke("setAutoMix", &args(serde_json::json!({"detector": "magic"}))).is_err());
        assert!(g.invoke("nope", &args(serde_json::json!({}))).is_err());
        g.invoke("setGain", &args(serde_json::json!({"db": 99}))).unwrap();
        assert_eq!(g.gain_db, 12.0);
    }

    #[test]
    fn duck_rule_roundtrip_and_csv_selectors() {
        let mut d = DuckState::new("d1".into(), "Kommentar → Atmo".into());
        d.invoke(
            "set",
            &args(serde_json::json!({"enabled": true, "keys": "ch1, group:g2", "targets": "ch3", "amountDb": -10, "releaseMs": 2500})),
        )
        .unwrap();
        assert_eq!(d.keys, vec!["ch1", "group:g2"]);
        let back = DuckState::from_json(&d.to_json()).unwrap();
        assert!(back.enabled);
        assert_eq!(back.targets, vec!["ch3"]);
        assert_eq!(back.params.amount_db, -10.0);
        assert_eq!(back.params.release_ms, 2500.0);
        // Teil-Update lässt Rest unverändert.
        d.invoke("set", &args(serde_json::json!({"holdMs": 900}))).unwrap();
        assert_eq!(d.params.amount_db, -10.0);
        assert_eq!(d.params.hold_ms, 900.0);
    }
}
