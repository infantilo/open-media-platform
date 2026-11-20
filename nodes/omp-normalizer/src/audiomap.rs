//! Kanalzuordnung Eingang → Haus (UMSETZUNG 106.3). Angelehnt an das Prinzip von AMWA IS-08 (jeder Hauskanal wird aus
//! einem Eingangskanal gespeist oder bleibt still); die Spezifikation selbst wurde dafür nicht gelesen.
//!
//! JSON (`normalize.audioMap`): `{"outputs":[{"out":1,"in":3},{"out":2,"in":4,"gain":0.5}], "dataChannels":[8]}`
//! Kanäle sind 1-basiert. Fehlt ein Hauskanal in der Liste, bleibt er still. **Datenkanäle** (nicht-PCM, z. B. kodierter
//! Mehrkanalton im Stereopaar) dürfen nur 1:1 mit Verstärkung 1 durchgereicht werden — nie gemischt, nie verstärkt.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapEntry {
    pub out: u32,
    #[serde(rename = "in")]
    pub input: u32,
    #[serde(default = "one")]
    pub gain: f64,
}

fn one() -> f64 {
    1.0
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMap {
    #[serde(default)]
    pub outputs: Vec<MapEntry>,
    /// Eingangskanäle mit nicht-PCM-Daten.
    #[serde(default)]
    pub data_channels: Vec<u32>,
}

impl AudioMap {
    pub fn from_json(s: &str) -> Result<AudioMap, String> {
        serde_json::from_str(s).map_err(|e| format!("audioMap: {e}"))
    }

    /// Prüft die Zuordnung gegen Ein- und Ausgangs-Kanalzahl.
    pub fn validate(&self, in_channels: u32, out_channels: u32) -> Result<(), String> {
        for e in &self.outputs {
            if e.out == 0 || e.out > out_channels {
                return Err(format!("audioMap: Hauskanal {} außerhalb 1…{out_channels}", e.out));
            }
            if e.input == 0 || e.input > in_channels {
                return Err(format!("audioMap: Eingangskanal {} außerhalb 1…{in_channels}", e.input));
            }
            if !e.gain.is_finite() || !(0.0..=4.0).contains(&e.gain) {
                return Err(format!("audioMap: Verstärkung {} außerhalb 0…4", e.gain));
            }
        }
        for &d in &self.data_channels {
            if d == 0 || d > in_channels {
                return Err(format!("audioMap: Datenkanal {d} außerhalb 1…{in_channels}"));
            }
            let uses: Vec<&MapEntry> = self.outputs.iter().filter(|e| e.input == d).collect();
            if uses.len() > 1 {
                return Err(format!("audioMap: Datenkanal {d} darf nur auf einen Hauskanal gehen (nie gemischt)"));
            }
            if uses.iter().any(|e| (e.gain - 1.0).abs() > 1e-12) {
                return Err(format!("audioMap: Datenkanal {d} muss mit Verstärkung 1 durchgereicht werden"));
            }
            // Ein Hauskanal, der einen Datenkanal trägt, darf keine weitere Quelle mischen.
            for u in uses {
                if self.outputs.iter().filter(|e| e.out == u.out).count() > 1 {
                    return Err(format!("audioMap: Hauskanal {} trägt Datenkanal {d} und darf nichts dazumischen", u.out));
                }
            }
        }
        Ok(())
    }

    /// Mischmatrix `[out][in]`. Ohne ausdrückliche Zuordnung gilt die Standardzuordnung (siehe [`default_for`]).
    pub fn matrix(&self, in_channels: u32, out_channels: u32) -> Vec<Vec<f64>> {
        if self.outputs.is_empty() {
            return default_for(in_channels, out_channels).matrix_raw(in_channels, out_channels);
        }
        self.matrix_raw(in_channels, out_channels)
    }

    fn matrix_raw(&self, in_channels: u32, out_channels: u32) -> Vec<Vec<f64>> {
        let mut m = vec![vec![0.0; in_channels as usize]; out_channels as usize];
        for e in &self.outputs {
            m[(e.out - 1) as usize][(e.input - 1) as usize] += e.gain;
        }
        m
    }
}

/// Standard, wenn nichts eingestellt ist: Kanal i → Kanal i, soweit beide existieren, der Rest bleibt still.
pub fn default_for(in_channels: u32, out_channels: u32) -> AudioMap {
    AudioMap {
        outputs: (1..=in_channels.min(out_channels)).map(|c| MapEntry { out: c, input: c, gain: 1.0 }).collect(),
        data_channels: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kanal_drei_wird_hauskanal_eins_rest_still() {
        let m = AudioMap::from_json(r#"{"outputs":[{"out":1,"in":3}]}"#).unwrap();
        m.validate(4, 2).unwrap();
        let mx = m.matrix(4, 2);
        assert_eq!(mx[0], vec![0.0, 0.0, 1.0, 0.0]);
        assert_eq!(mx[1], vec![0.0; 4]);
    }

    #[test]
    fn standard_ist_eins_zu_eins_und_still() {
        let m = AudioMap::default().matrix(2, 4);
        assert_eq!(m[0], vec![1.0, 0.0]);
        assert_eq!(m[1], vec![0.0, 1.0]);
        assert_eq!(m[2], vec![0.0, 0.0]);
        let down = AudioMap::default().matrix(4, 2);
        assert_eq!(down[0], vec![1.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn ungueltige_zuordnung_wird_abgelehnt() {
        assert!(AudioMap::from_json(r#"{"outputs":[{"out":3,"in":1}]}"#).unwrap().validate(2, 2).is_err());
        assert!(AudioMap::from_json(r#"{"outputs":[{"out":1,"in":9}]}"#).unwrap().validate(2, 2).is_err());
        assert!(AudioMap::from_json(r#"{"outputs":[{"out":1,"in":1,"gain":9}]}"#).unwrap().validate(2, 2).is_err());
        assert!(AudioMap::from_json("nix").is_err());
    }

    #[test]
    fn datenkanaele_nur_eins_zu_eins() {
        let ok = AudioMap::from_json(r#"{"outputs":[{"out":2,"in":2},{"out":1,"in":1,"gain":0.5}],"dataChannels":[2]}"#).unwrap();
        assert!(ok.validate(2, 2).is_ok());
        let mixed = AudioMap::from_json(r#"{"outputs":[{"out":1,"in":1},{"out":1,"in":2}],"dataChannels":[2]}"#).unwrap();
        assert!(mixed.validate(2, 2).is_err(), "Datenkanal darf nicht dazugemischt werden");
        let gain = AudioMap::from_json(r#"{"outputs":[{"out":1,"in":2,"gain":0.5}],"dataChannels":[2]}"#).unwrap();
        assert!(gain.validate(2, 2).is_err(), "Datenkanal nur mit Verstärkung 1");
        let split = AudioMap::from_json(r#"{"outputs":[{"out":1,"in":2},{"out":2,"in":2}],"dataChannels":[2]}"#).unwrap();
        assert!(split.validate(2, 2).is_err(), "Datenkanal nur auf einen Hauskanal");
    }
}
