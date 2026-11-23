//! Konfiguration der Ausgänge des Tonteilers: Name und Eingangskanäle (1-basiert) je Ausgang. Ohne MXL, damit testbar.
//!
//! JSON (`OMP_SPLIT_OUTPUTS` beim Start, Parameter `split.outputs` zur Laufzeit):
//! `[{"name":"Programm","channels":[1,2]},{"name":"IT","channels":[3,4]},{"name":"Kommentar","channels":[9]}]`
//! Ein Eingangskanal darf in mehreren Ausgängen vorkommen; nicht genannte Kanäle werden verworfen.

use serde::{Deserialize, Serialize};

pub const MAX_OUTPUTS: usize = 32;
pub const MAX_CHANNELS: usize = 64;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Output {
    pub name: String,
    pub channels: Vec<usize>,
}

/// Prüft die Ausgänge: Namen eindeutig und nicht leer, Kanäle 1…64 ohne Doppelte je Ausgang, Grenzen.
pub fn validate(outputs: &[Output]) -> Result<(), String> {
    if outputs.is_empty() {
        return Err("mindestens ein Ausgang".into());
    }
    if outputs.len() > MAX_OUTPUTS {
        return Err(format!("höchstens {MAX_OUTPUTS} Ausgänge"));
    }
    let mut names = std::collections::HashSet::new();
    for (i, o) in outputs.iter().enumerate() {
        let n = o.name.trim();
        if n.is_empty() || n.chars().count() > 40 {
            return Err(format!("Ausgang {}: Name leer oder länger als 40 Zeichen", i + 1));
        }
        if !names.insert(n.to_string()) {
            return Err(format!("Ausgangsname „{n}“ doppelt"));
        }
        if o.channels.is_empty() || o.channels.len() > MAX_CHANNELS {
            return Err(format!("Ausgang „{n}“: 1…{MAX_CHANNELS} Kanäle"));
        }
        let mut seen = std::collections::HashSet::new();
        for &c in &o.channels {
            if c == 0 || c > MAX_CHANNELS {
                return Err(format!("Ausgang „{n}“: Kanal {c} außerhalb 1…{MAX_CHANNELS}"));
            }
            if !seen.insert(c) {
                return Err(format!("Ausgang „{n}“: Kanal {c} doppelt"));
            }
        }
    }
    Ok(())
}

pub fn parse(json: &str) -> Result<Vec<Output>, String> {
    let v: Vec<Output> = serde_json::from_str(json).map_err(|e| format!("Ausgänge: {e}"))?;
    validate(&v)?;
    Ok(v)
}

/// Standard ohne Angabe: je zwei Kanäle ein Ausgang („1/2“, „3/4“, …); ein ungerader letzter Kanal wird Mono.
pub fn default_pairs(input_channels: usize) -> Vec<Output> {
    let n = input_channels.clamp(1, MAX_CHANNELS);
    (0..n.div_ceil(2))
        .map(|i| {
            let a = i * 2 + 1;
            if a + 1 <= n { Output { name: format!("{a}/{}", a + 1), channels: vec![a, a + 1] } } else { Output { name: format!("{a}"), channels: vec![a] } }
        })
        .take(MAX_OUTPUTS)
        .collect()
}

/// Größter genannter Eingangskanal (= Mindestkanalzahl der Quelle).
pub fn min_input_channels(outputs: &[Output]) -> usize {
    outputs.iter().flat_map(|o| o.channels.iter().copied()).max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_validates() {
        let v = parse(r#"[{"name":"Programm","channels":[1,2]},{"name":"IT","channels":[3,4]},{"name":"Kommentar","channels":[9]}]"#).unwrap();
        assert_eq!(v.len(), 3);
        assert_eq!(min_input_channels(&v), 9);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse("[]").is_err());
        assert!(parse(r#"[{"name":"","channels":[1]}]"#).is_err());
        assert!(parse(r#"[{"name":"A","channels":[]}]"#).is_err());
        assert!(parse(r#"[{"name":"A","channels":[0]}]"#).is_err());
        assert!(parse(r#"[{"name":"A","channels":[65]}]"#).is_err());
        assert!(parse(r#"[{"name":"A","channels":[1,1]}]"#).is_err());
        assert!(parse(r#"[{"name":"A","channels":[1]},{"name":"A","channels":[2]}]"#).is_err());
        assert!(parse("kein json").is_err());
    }

    #[test]
    fn a_channel_may_appear_in_several_outputs() {
        assert!(parse(r#"[{"name":"A","channels":[1,2]},{"name":"B","channels":[1]}]"#).is_ok());
    }

    #[test]
    fn default_pairs_cover_all_channels() {
        let v = default_pairs(16);
        assert_eq!(v.len(), 8);
        assert_eq!((v[0].name.as_str(), v[0].channels.clone()), ("1/2", vec![1, 2]));
        assert_eq!(v[7].channels, vec![15, 16]);
        let odd = default_pairs(5);
        assert_eq!(odd.len(), 3);
        assert_eq!((odd[2].name.as_str(), odd[2].channels.clone()), ("5", vec![5]));
        assert!(validate(&v).is_ok() && validate(&odd).is_ok());
    }
}
