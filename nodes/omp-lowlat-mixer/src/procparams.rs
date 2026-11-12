//! Parameter der Klangbearbeitung (Streifen: EQ, Gate, Kompressor, Phase; Bus: Limiter) als Tabelle — aus ihr entstehen
//! Descriptor, Lesen, Schreiben und die Sicherung, damit die vier nie auseinanderlaufen.
//! Namen: `strip.N.<schlüssel>` bzw. `bus.N.<schlüssel>`, z. B. `strip.1.eq.b2.gain`, `strip.1.comp.threshold`, `bus.1.limiter.ceiling`.

use omp_node_sdk::SetError;
use serde_json::{Value, json};

use crate::dsp::{EQ_BANDS, LimParams, ProcParams};

#[derive(Clone, Copy)]
pub enum Kind {
    Num { min: f64, max: f64 },
    Bool,
}

pub struct Def {
    pub key: String,
    pub unit: Option<&'static str>,
    pub kind: Kind,
}

fn num(key: impl Into<String>, unit: &'static str, min: f64, max: f64) -> Def {
    Def { key: key.into(), unit: if unit.is_empty() { None } else { Some(unit) }, kind: Kind::Num { min, max } }
}

fn flag(key: impl Into<String>) -> Def {
    Def { key: key.into(), unit: None, kind: Kind::Bool }
}

pub fn proc_defs() -> Vec<Def> {
    let mut d = vec![flag("phase"), flag("eq.bypass"), flag("eq.hp.enabled"), num("eq.hp.freq", "Hz", 20.0, 400.0)];
    for b in 1..=EQ_BANDS {
        d.push(num(format!("eq.b{b}.freq"), "Hz", 20.0, 20_000.0));
        d.push(num(format!("eq.b{b}.q"), "", 0.1, 20.0));
        d.push(num(format!("eq.b{b}.gain"), "dB", -24.0, 12.0));
    }
    d.extend([
        flag("comp.enabled"),
        num("comp.threshold", "dB", -60.0, 0.0),
        num("comp.ratio", ":1", 1.0, 20.0),
        num("comp.attack", "ms", 0.1, 200.0),
        num("comp.release", "ms", 10.0, 2000.0),
        num("comp.knee", "dB", 0.0, 24.0),
        num("comp.makeup", "dB", 0.0, 24.0),
        flag("comp.rms"),
        flag("gate.enabled"),
        num("gate.threshold", "dB", -90.0, 0.0),
        num("gate.range", "dB", -90.0, 0.0),
        num("gate.ratio", ":1", 1.0, 20.0),
        num("gate.attack", "ms", 0.1, 100.0),
        num("gate.hold", "ms", 0.0, 1000.0),
        num("gate.release", "ms", 10.0, 2000.0),
        num("gate.hysteresis", "dB", 0.0, 20.0),
    ]);
    d
}

pub fn lim_defs() -> Vec<Def> {
    vec![flag("limiter.enabled"), num("limiter.ceiling", "dB", -24.0, 0.0), num("limiter.release", "ms", 10.0, 2000.0)]
}

/// `b2` → Index 1
fn band(key: &str) -> Option<(usize, &str)> {
    let rest = key.strip_prefix("eq.b")?;
    let (n, field) = rest.split_once('.')?;
    let n: usize = n.parse().ok()?;
    (1..=EQ_BANDS).contains(&n).then_some((n - 1, field))
}

pub fn proc_get(p: &ProcParams, key: &str) -> Option<Value> {
    if let Some((i, f)) = band(key) {
        let b = &p.eq.bands[i];
        return Some(match f {
            "freq" => json!(b.freq),
            "q" => json!(b.q),
            "gain" => json!(b.gain_db),
            _ => return None,
        });
    }
    Some(match key {
        "phase" => json!(p.phase_invert),
        "eq.bypass" => json!(p.eq.bypass),
        "eq.hp.enabled" => json!(p.eq.hp_enabled),
        "eq.hp.freq" => json!(p.eq.hp_freq),
        "comp.enabled" => json!(p.comp.enabled),
        "comp.threshold" => json!(p.comp.threshold_db),
        "comp.ratio" => json!(p.comp.ratio),
        "comp.attack" => json!(p.comp.attack_ms),
        "comp.release" => json!(p.comp.release_ms),
        "comp.knee" => json!(p.comp.knee_db),
        "comp.makeup" => json!(p.comp.makeup_db),
        "comp.rms" => json!(p.comp.rms),
        "gate.enabled" => json!(p.gate.enabled),
        "gate.threshold" => json!(p.gate.threshold_db),
        "gate.range" => json!(p.gate.range_db),
        "gate.ratio" => json!(p.gate.ratio),
        "gate.attack" => json!(p.gate.attack_ms),
        "gate.hold" => json!(p.gate.hold_ms),
        "gate.release" => json!(p.gate.release_ms),
        "gate.hysteresis" => json!(p.gate.hysteresis_db),
        _ => return None,
    })
}

fn check(defs: &[Def], key: &str, v: &Value) -> Result<Value, SetError> {
    let d = defs.iter().find(|d| d.key == key).ok_or(SetError::Unknown)?;
    match d.kind {
        Kind::Bool => v.as_bool().map(Value::Bool).ok_or(SetError::Unknown),
        Kind::Num { min, max } => v.as_f64().filter(|x| x.is_finite() && (min..=max).contains(x)).map(|x| json!(x)).ok_or(SetError::Unknown),
    }
}

pub fn proc_set(p: &mut ProcParams, key: &str, v: &Value) -> Result<(), SetError> {
    let v = check(&proc_defs(), key, v)?;
    let (f, b) = (v.as_f64().unwrap_or(0.0), v.as_bool().unwrap_or(false));
    if let Some((i, field)) = band(key) {
        match field {
            "freq" => p.eq.bands[i].freq = f,
            "q" => p.eq.bands[i].q = f,
            "gain" => p.eq.bands[i].gain_db = f,
            _ => return Err(SetError::Unknown),
        }
        return Ok(());
    }
    match key {
        "phase" => p.phase_invert = b,
        "eq.bypass" => p.eq.bypass = b,
        "eq.hp.enabled" => p.eq.hp_enabled = b,
        "eq.hp.freq" => p.eq.hp_freq = f,
        "comp.enabled" => p.comp.enabled = b,
        "comp.threshold" => p.comp.threshold_db = f,
        "comp.ratio" => p.comp.ratio = f,
        "comp.attack" => p.comp.attack_ms = f,
        "comp.release" => p.comp.release_ms = f,
        "comp.knee" => p.comp.knee_db = f,
        "comp.makeup" => p.comp.makeup_db = f,
        "comp.rms" => p.comp.rms = b,
        "gate.enabled" => p.gate.enabled = b,
        "gate.threshold" => p.gate.threshold_db = f,
        "gate.range" => p.gate.range_db = f,
        "gate.ratio" => p.gate.ratio = f,
        "gate.attack" => p.gate.attack_ms = f,
        "gate.hold" => p.gate.hold_ms = f,
        "gate.release" => p.gate.release_ms = f,
        "gate.hysteresis" => p.gate.hysteresis_db = f,
        _ => return Err(SetError::Unknown),
    }
    Ok(())
}

pub fn lim_get(p: &LimParams, key: &str) -> Option<Value> {
    Some(match key {
        "limiter.enabled" => json!(p.enabled),
        "limiter.ceiling" => json!(p.ceiling_db),
        "limiter.release" => json!(p.release_ms),
        _ => return None,
    })
}

pub fn lim_set(p: &mut LimParams, key: &str, v: &Value) -> Result<(), SetError> {
    let v = check(&lim_defs(), key, v)?;
    match key {
        "limiter.enabled" => p.enabled = v.as_bool().unwrap_or(false),
        "limiter.ceiling" => p.ceiling_db = v.as_f64().unwrap_or(-3.0),
        "limiter.release" => p.release_ms = v.as_f64().unwrap_or(100.0),
        _ => return Err(SetError::Unknown),
    }
    Ok(())
}

/// Alle Werte als Objekt (Sicherung, Bedienfeld-Detail).
pub fn proc_map(p: &ProcParams) -> Value {
    Value::Object(proc_defs().into_iter().filter_map(|d| proc_get(p, &d.key).map(|v| (d.key, v))).collect())
}

pub fn lim_map(p: &LimParams) -> Value {
    Value::Object(lim_defs().into_iter().filter_map(|d| lim_get(p, &d.key).map(|v| (d.key, v))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_key_roundtrips_and_is_range_checked() {
        let mut p = ProcParams::default();
        for d in proc_defs() {
            let before = proc_get(&p, &d.key).unwrap_or_else(|| panic!("{} nicht lesbar", d.key));
            match d.kind {
                Kind::Num { min, max } => {
                    proc_set(&mut p, &d.key, &json!((min + max) / 2.0)).unwrap_or_else(|_| panic!("{} nicht setzbar", d.key));
                    assert_eq!(proc_get(&p, &d.key).unwrap(), json!((min + max) / 2.0), "{}", d.key);
                    assert!(proc_set(&mut p, &d.key, &json!(max + 1.0)).is_err(), "{} über Maximum", d.key);
                    assert!(proc_set(&mut p, &d.key, &json!(min - 1.0)).is_err(), "{} unter Minimum", d.key);
                    assert!(proc_set(&mut p, &d.key, &json!("x")).is_err());
                }
                Kind::Bool => {
                    proc_set(&mut p, &d.key, &json!(!before.as_bool().unwrap())).unwrap();
                    assert_eq!(proc_get(&p, &d.key).unwrap(), json!(!before.as_bool().unwrap()), "{}", d.key);
                    assert!(proc_set(&mut p, &d.key, &json!(1.0)).is_err());
                }
            }
        }
        assert!(proc_set(&mut p, "eq.b9.gain", &json!(0.0)).is_err());
        assert!(proc_get(&p, "unbekannt").is_none());
    }

    #[test]
    fn limiter_keys_roundtrip() {
        let mut l = LimParams::default();
        lim_set(&mut l, "limiter.enabled", &json!(true)).unwrap();
        lim_set(&mut l, "limiter.ceiling", &json!(-9.0)).unwrap();
        assert!(l.enabled && l.ceiling_db == -9.0);
        assert!(lim_set(&mut l, "limiter.ceiling", &json!(3.0)).is_err());
        assert_eq!(lim_map(&l)["limiter.ceiling"], json!(-9.0));
    }

    #[test]
    fn map_covers_every_def() {
        let m = proc_map(&ProcParams::default());
        assert_eq!(m.as_object().unwrap().len(), proc_defs().len());
    }
}
