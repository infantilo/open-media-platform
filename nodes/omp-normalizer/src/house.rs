//! Hausformat: wie ein Signal im Haus aussehen soll. Video- und Tonteil sind unabhängig voneinander (jeder darf fehlen =
//! keine Anforderung) und zur Laufzeit austauschbar; im Code steht **kein** Standardwert. Vererbung Global → Event →
//! Leitung: der spezifischere Wert gewinnt, je Teil getrennt.

use std::fmt;

use serde::de::{self, Deserializer};
use serde::ser::Serializer;
use serde::{Deserialize, Serialize};

/// Bildrate als Bruch („25/1“, „60000/1001“). Gleichwertige Brüche (50/2 = 25/1) sind gleich.
#[derive(Clone, Copy, Debug)]
pub struct Rate {
    pub num: u32,
    pub den: u32,
}

impl Rate {
    pub fn new(num: u32, den: u32) -> Self {
        Rate { num, den }
    }
    pub fn parse(s: &str) -> Result<Rate, String> {
        let (n, d) = match s.split_once('/') {
            Some((n, d)) => (n.trim(), d.trim()),
            None => (s.trim(), "1"),
        };
        let num: u32 = n
            .parse()
            .map_err(|_| format!("Bildrate „{s}“: Zähler keine Zahl"))?;
        let den: u32 = d
            .parse()
            .map_err(|_| format!("Bildrate „{s}“: Nenner keine Zahl"))?;
        if num == 0 || den == 0 {
            return Err(format!("Bildrate „{s}“ muss größer als 0 sein"));
        }
        Ok(Rate { num, den })
    }
    /// Doppelte Rate (z. B. Halbbildrate eines Zeilensprung-Rasters).
    pub fn doubled(self) -> Rate {
        Rate {
            num: self.num.saturating_mul(2),
            den: self.den,
        }
    }
    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }
    /// Dauer eines Bildes in Millisekunden.
    pub fn frame_ms(self) -> f64 {
        1000.0 * self.den as f64 / self.num as f64
    }
}

impl PartialEq for Rate {
    fn eq(&self, o: &Rate) -> bool {
        self.num as u64 * o.den as u64 == o.num as u64 * self.den as u64
    }
}
impl Eq for Rate {}

impl fmt::Display for Rate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.num, self.den)
    }
}

impl Serialize for Rate {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
impl<'de> Deserialize<'de> for Rate {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Rate, D::Error> {
        let s = String::deserialize(d)?;
        Rate::parse(&s).map_err(de::Error::custom)
    }
}

/// Rasterart. „Zeilensprung“ meint ein Vollbild-Grain mit zwei verschränkten Halbbildern (MXL: `interlaced_tff`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scan {
    Progressive,
    InterlacedTff,
    InterlacedBff,
}

impl Scan {
    pub fn is_interlaced(self) -> bool {
        !matches!(self, Scan::Progressive)
    }
    /// Aus dem MXL-/NMOS-Feld `interlace_mode`; fehlt es, gilt progressiv.
    pub fn from_mode(s: &str) -> Scan {
        match s {
            "interlaced_tff" => Scan::InterlacedTff,
            "interlaced_bff" => Scan::InterlacedBff,
            _ => Scan::Progressive,
        }
    }
}

/// Umgang mit abweichender Übertragungsfunktion (SDR/HLG/PQ).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferPolicy {
    /// Mit Warnung unverändert durchreichen (Standard).
    #[default]
    Warn,
    /// Leitung sperren.
    Block,
    /// Über die austauschbare Abbildungsstufe wandeln (106.3b).
    Map,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoHouse {
    pub width: u32,
    pub height: u32,
    pub rate: Rate,
    pub scan: Scan,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colorspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer: Option<String>,
    #[serde(default)]
    pub transfer_policy: TransferPolicy,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AudioGroup {
    pub name: String,
    /// Hauskanäle, 1-basiert.
    pub channels: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioHouse {
    pub sample_rate: u32,
    pub channels: u32,
    #[serde(default)]
    pub groups: Vec<AudioGroup>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct HouseFormat {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<VideoHouse>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioHouse>,
}

impl HouseFormat {
    /// Parst und prüft ein Hausformat-JSON.
    pub fn from_json(s: &str) -> Result<HouseFormat, String> {
        let h: HouseFormat = serde_json::from_str(s).map_err(|e| format!("Hausformat: {e}"))?;
        h.validate()?;
        Ok(h)
    }

    pub fn validate(&self) -> Result<(), String> {
        if let Some(v) = &self.video {
            if v.width == 0 || v.height == 0 {
                return Err("Hausformat: Bildgröße muss größer als 0 sein".into());
            }
            if v.scan.is_interlaced() && v.height % 2 != 0 {
                return Err("Hausformat: Zeilensprung braucht eine gerade Zeilenzahl".into());
            }
            if v.rate.num == 0 || v.rate.den == 0 {
                return Err("Hausformat: Bildrate muss größer als 0 sein".into());
            }
        }
        if let Some(a) = &self.audio {
            if a.sample_rate < 8000 || a.sample_rate > 384_000 {
                return Err("Hausformat: Abtastrate außerhalb 8000…384000 Hz".into());
            }
            if a.channels == 0 || a.channels > 64 {
                return Err("Hausformat: Kanalzahl muss 1…64 sein".into());
            }
            for g in &a.groups {
                if g.name.trim().is_empty() {
                    return Err("Hausformat: Tongruppe ohne Namen".into());
                }
                let mut seen = std::collections::BTreeSet::new();
                for &c in &g.channels {
                    if c == 0 || c > a.channels {
                        return Err(format!(
                            "Hausformat: Gruppe „{}“ nennt Kanal {c} außerhalb 1…{}",
                            g.name, a.channels
                        ));
                    }
                    if !seen.insert(c) {
                        return Err(format!(
                            "Hausformat: Gruppe „{}“ nennt Kanal {c} doppelt",
                            g.name
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

/// Wirksames Hausformat: je Teil gewinnt der spezifischste vorhandene Wert (Leitung vor Event vor Global).
pub fn effective(
    global: &HouseFormat,
    event: Option<&HouseFormat>,
    line: Option<&HouseFormat>,
) -> HouseFormat {
    let pick_v = || {
        line.and_then(|h| h.video.clone())
            .or_else(|| event.and_then(|h| h.video.clone()))
            .or_else(|| global.video.clone())
    };
    let pick_a = || {
        line.and_then(|h| h.audio.clone())
            .or_else(|| event.and_then(|h| h.audio.clone()))
            .or_else(|| global.audio.clone())
    };
    HouseFormat {
        video: pick_v(),
        audio: pick_a(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EX: &str = r#"{"video":{"width":1920,"height":1080,"rate":"25/1","scan":"interlaced_tff","colorspace":"BT709","transfer":"SDR","transferPolicy":"warn"},
        "audio":{"sampleRate":48000,"channels":16,"groups":[{"name":"Stereo PGM","channels":[1,2]},{"name":"IS","channels":[3,4]}]}}"#;

    #[test]
    fn beispiel_wird_gelesen_und_zurueckgeschrieben() {
        let h = HouseFormat::from_json(EX).unwrap();
        assert_eq!(h.video.as_ref().unwrap().rate, Rate::new(25, 1));
        assert!(h.video.as_ref().unwrap().scan.is_interlaced());
        let again = HouseFormat::from_json(&serde_json::to_string(&h).unwrap()).unwrap();
        assert_eq!(h, again);
    }

    #[test]
    fn ungueltiges_wird_abgelehnt() {
        assert!(
            HouseFormat::from_json(
                r#"{"video":{"width":0,"height":1080,"rate":"25/1","scan":"progressive"}}"#
            )
            .is_err()
        );
        assert!(
            HouseFormat::from_json(
                r#"{"video":{"width":1920,"height":1080,"rate":"0/1","scan":"progressive"}}"#
            )
            .is_err()
        );
        assert!(
            HouseFormat::from_json(
                r#"{"video":{"width":1920,"height":1081,"rate":"25/1","scan":"interlaced_tff"}}"#
            )
            .is_err()
        );
        assert!(HouseFormat::from_json(r#"{"audio":{"sampleRate":48000,"channels":2,"groups":[{"name":"x","channels":[3]}]}}"#).is_err());
        assert!(HouseFormat::from_json(r#"{"audio":{"sampleRate":48000,"channels":2,"groups":[{"name":"x","channels":[1,1]}]}}"#).is_err());
        assert!(HouseFormat::from_json("kein json").is_err());
    }

    #[test]
    fn gleichwertige_raten_sind_gleich() {
        assert_eq!(Rate::parse("50/2").unwrap(), Rate::new(25, 1));
        assert_ne!(Rate::parse("30000/1001").unwrap(), Rate::new(30, 1));
    }

    #[test]
    fn vererbung_je_teil_getrennt() {
        let global = HouseFormat::from_json(EX).unwrap();
        let event = HouseFormat::from_json(
            r#"{"video":{"width":1280,"height":720,"rate":"50/1","scan":"progressive"}}"#,
        )
        .unwrap();
        let line =
            HouseFormat::from_json(r#"{"audio":{"sampleRate":44100,"channels":2}}"#).unwrap();
        let e = effective(&global, Some(&event), None);
        assert_eq!(
            e.video.as_ref().unwrap().width,
            1280,
            "Event überstimmt Global (Video)"
        );
        assert_eq!(
            e.audio, global.audio,
            "Tonteil bleibt unberührt, wenn nur Video überschrieben wird"
        );
        let l = effective(&global, Some(&event), Some(&line));
        assert_eq!(
            l.video.as_ref().unwrap().width,
            1280,
            "Leitung ohne Videoteil erbt vom Event"
        );
        assert_eq!(
            l.audio.as_ref().unwrap().sample_rate,
            44100,
            "Leitung überstimmt Event/Global (Ton)"
        );
    }
}
