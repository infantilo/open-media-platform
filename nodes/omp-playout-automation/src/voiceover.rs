//! Voiceover als Child Event (Kapitel 27 / P9, Spec §53/§135): der Automator PLANT, die
//! Audio-Verarbeitung macht der Audiomischer. Ein Voiceover öffnet einen Sprecher-Kanal des
//! Mischers mit Ein-/Ausblendung und schaltet optional eine vorhandene Ducking-Regel
//! (`duck.<id>.set`) für die Dauer ein — das Absenken des Programmtons erledigt die
//! Ducking-Engine des Mischers (Pegel-Detektor auf dem Sprecher-Kanal), nicht der Automator.
//!
//! `params` des Child Events:
//! ```json
//! { "channel": "ch3", "gainDb": 0, "fadeInMs": 300, "fadeOutMs": 500,
//!   "duck": { "rule": "duck1", "amountDb": -12, "attackMs": 80, "releaseMs": 600 },
//!   "priority": 0 }
//! ```
//! `target` = Label des Audiomischers (leer → `targetAudioMixerLabel` des Automators).
//! Ein altes Voiceover mit `method` (frei formulierter Node-Befehl) bleibt unverändert lauffähig.

use serde_json::{json, Value};

/// Pegel, ab dem der Kanal als „zu“ gilt (Fade beginnt/endet hier, danach Stumm).
pub const SILENCE_DB: f64 = -60.0;
/// Zeitliche Auflösung der Blenden (Schritte je Blende, höchstens).
const MAX_FADE_STEPS: u64 = 12;
const MIN_STEP_MS: u64 = 25;

#[derive(Debug, Clone, PartialEq)]
pub struct DuckSpec {
    pub rule: String,
    pub amount_db: Option<f64>,
    pub attack_ms: Option<f64>,
    pub release_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Voiceover {
    pub channel: String,
    pub gain_db: f64,
    pub fade_in_ms: u64,
    pub fade_out_ms: u64,
    pub duck: Option<DuckSpec>,
    pub priority: i64,
}

/// Ein Schritt eines Ablaufs: erst `wait_ms` warten, dann die Methode am Mischer aufrufen.
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub wait_ms: u64,
    pub method: String,
    pub params: Value,
}

impl Voiceover {
    /// Prüft und liest `params`. Fehler sind Klartext für den Operator.
    pub fn parse(p: &Value) -> Result<Voiceover, String> {
        let channel = p.get("channel").and_then(Value::as_str).map(str::trim).unwrap_or("");
        if channel.is_empty() {
            return Err("Voiceover: params.channel (Kanal-ID des Sprecher-Kanals am Audiomischer) fehlt".to_string());
        }
        if !channel.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(format!("Voiceover: ungültige Kanal-ID „{channel}\u{201c}"));
        }
        let gain_db = p.get("gainDb").and_then(Value::as_f64).unwrap_or(0.0);
        if !(-40.0..=12.0).contains(&gain_db) {
            return Err("Voiceover: gainDb muss zwischen −40 und +12 dB liegen".to_string());
        }
        let ms = |k: &str, def: u64| -> Result<u64, String> {
            match p.get(k) {
                None | Some(Value::Null) => Ok(def),
                Some(v) => v.as_u64().filter(|m| *m <= 10_000).ok_or_else(|| format!("Voiceover: {k} muss 0…10000 ms sein")),
            }
        };
        let duck = match p.get("duck") {
            None | Some(Value::Null) => None,
            Some(d) => {
                let rule = d.get("rule").and_then(Value::as_str).map(str::trim).unwrap_or("");
                if rule.is_empty() || !rule.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                    return Err("Voiceover: duck.rule (ID der Ducking-Regel am Mischer) fehlt oder ist ungültig".to_string());
                }
                let amount = d.get("amountDb").and_then(Value::as_f64);
                if amount.is_some_and(|a| !(-60.0..=0.0).contains(&a)) {
                    return Err("Voiceover: duck.amountDb muss zwischen −60 und 0 dB liegen".to_string());
                }
                Some(DuckSpec { rule: rule.to_string(), amount_db: amount, attack_ms: d.get("attackMs").and_then(Value::as_f64), release_ms: d.get("releaseMs").and_then(Value::as_f64) })
            }
        };
        Ok(Voiceover {
            channel: channel.to_string(),
            gain_db,
            fade_in_ms: ms("fadeInMs", 300)?,
            fade_out_ms: ms("fadeOutMs", 500)?,
            duck,
            priority: p.get("priority").and_then(Value::as_i64).unwrap_or(0),
        })
    }

    /// Pegelverlauf einer Blende: (Wartezeit vor dem Schritt, Pegel dB). Letzter Schritt = Ziel.
    pub fn fade(from_db: f64, to_db: f64, ms: u64) -> Vec<(u64, f64)> {
        if ms == 0 {
            return vec![(0, to_db)];
        }
        let steps = (ms / MIN_STEP_MS).clamp(1, MAX_FADE_STEPS);
        let each = ms / steps;
        (1..=steps).map(|i| (each, from_db + (to_db - from_db) * i as f64 / steps as f64)).collect()
    }

    fn set_gain(&self, wait_ms: u64, db: f64) -> Step {
        Step { wait_ms, method: format!("channel.{}.setGain", self.channel), params: json!({ "db": (db * 10.0).round() / 10.0 }) }
    }

    fn duck_step(&self, enabled: bool) -> Option<Step> {
        let d = self.duck.as_ref()?;
        let mut params = json!({ "enabled": enabled });
        if enabled {
            if let Some(a) = d.amount_db {
                params["amountDb"] = json!(a);
            }
            if let Some(a) = d.attack_ms {
                params["attackMs"] = json!(a);
            }
            if let Some(r) = d.release_ms {
                params["releaseMs"] = json!(r);
            }
            // Der Sprecher-Kanal ist der Schlüssel der Regel.
            params["keys"] = json!(self.channel);
        }
        Some(Step { wait_ms: 0, method: format!("duck.{}.set", d.rule), params })
    }

    /// Start: Ducking-Regel an, Kanal auf Stille setzen und aufmachen, einblenden.
    pub fn start_plan(&self) -> Vec<Step> {
        let mut v = Vec::new();
        v.extend(self.duck_step(true));
        v.push(self.set_gain(0, SILENCE_DB));
        v.push(Step { wait_ms: 0, method: format!("channel.{}.setMute", self.channel), params: json!({ "muted": false }) });
        for (wait, db) in Self::fade(SILENCE_DB, self.gain_db, self.fade_in_ms) {
            v.push(self.set_gain(wait, db));
        }
        v
    }

    /// Stopp: ausblenden, Kanal stumm, Ducking-Regel aus (die Regel gibt danach selbst frei, `releaseMs`).
    pub fn stop_plan(&self) -> Vec<Step> {
        let mut v = Vec::new();
        for (wait, db) in Self::fade(self.gain_db, SILENCE_DB, self.fade_out_ms) {
            v.push(self.set_gain(wait, db));
        }
        v.push(Step { wait_ms: 0, method: format!("channel.{}.setMute", self.channel), params: json!({ "muted": true }) });
        v.extend(self.duck_step(false));
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vo(p: Value) -> Voiceover {
        Voiceover::parse(&p).unwrap()
    }

    #[test]
    fn parse_defaults_and_validation() {
        let v = vo(json!({"channel": "ch3"}));
        assert_eq!((v.gain_db, v.fade_in_ms, v.fade_out_ms, v.priority), (0.0, 300, 500, 0));
        assert!(v.duck.is_none());
        assert!(Voiceover::parse(&json!({})).unwrap_err().contains("channel"));
        assert!(Voiceover::parse(&json!({"channel": "a b"})).unwrap_err().contains("ungültig"));
        assert!(Voiceover::parse(&json!({"channel": "c", "gainDb": 30})).unwrap_err().contains("gainDb"));
        assert!(Voiceover::parse(&json!({"channel": "c", "fadeInMs": 99999})).unwrap_err().contains("fadeInMs"));
        assert!(Voiceover::parse(&json!({"channel": "c", "duck": {}})).unwrap_err().contains("duck.rule"));
        assert!(Voiceover::parse(&json!({"channel": "c", "duck": {"rule": "d1", "amountDb": 6}})).unwrap_err().contains("amountDb"));
    }

    #[test]
    fn fade_is_monotonic_ends_at_target_and_respects_duration() {
        let f = Voiceover::fade(-60.0, 0.0, 300);
        assert_eq!(f.len(), 12);
        assert_eq!(f.last().unwrap().1, 0.0);
        assert!(f.windows(2).all(|w| w[1].1 > w[0].1));
        assert!((f.iter().map(|s| s.0).sum::<u64>() as i64 - 300).abs() <= 12);
        assert_eq!(Voiceover::fade(-60.0, 0.0, 0), vec![(0, 0.0)]);
        // Sehr kurze Blende: ein Schritt.
        assert_eq!(Voiceover::fade(0.0, -60.0, 10).len(), 1);
        // Ausblenden fällt monoton.
        let o = Voiceover::fade(0.0, -60.0, 500);
        assert!(o.windows(2).all(|w| w[1].1 < w[0].1) && o.last().unwrap().1 == -60.0);
    }

    #[test]
    fn start_plan_opens_the_channel_silent_then_fades_in_with_duck_first() {
        let v = vo(json!({"channel": "ch3", "gainDb": -3, "duck": {"rule": "duck1", "amountDb": -12, "releaseMs": 600}}));
        let p = v.start_plan();
        assert_eq!(p[0].method, "duck.duck1.set");
        assert_eq!(p[0].params, json!({"enabled": true, "amountDb": -12.0, "releaseMs": 600.0, "keys": "ch3"}));
        assert_eq!((p[1].method.as_str(), p[1].params["db"].as_f64()), ("channel.ch3.setGain", Some(-60.0)));
        assert_eq!((p[2].method.as_str(), &p[2].params), ("channel.ch3.setMute", &json!({"muted": false})));
        assert_eq!(p.last().unwrap().params["db"].as_f64(), Some(-3.0));
        // Ohne Ducking kein duck-Schritt.
        assert!(vo(json!({"channel": "ch3"})).start_plan().iter().all(|s| !s.method.starts_with("duck.")));
    }

    #[test]
    fn stop_plan_fades_out_mutes_then_releases_the_duck() {
        let v = vo(json!({"channel": "ch3", "duck": {"rule": "duck1"}}));
        let p = v.stop_plan();
        assert_eq!(p.first().unwrap().method, "channel.ch3.setGain");
        let n = p.len();
        assert_eq!(p[n - 2].params, json!({"muted": true}));
        assert_eq!((p[n - 1].method.as_str(), &p[n - 1].params), ("duck.duck1.set", &json!({"enabled": false})));
    }
}
