//! Konfiguration des MIDI-Gateways (Kapitel 93): welche Anschlüsse, welcher Mischer, welche Betriebsart. Als JSON im Parameter
//! `config` (Oberfläche, Sicherung `/state`), Vorgabe aus der Umgebung `OMP_MIDI_CONFIG`.

use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq)]
pub enum UnitKind {
    /// ALSA-Rohgerät, z. B. `/dev/snd/midiC1D0`.
    Raw { path: String },
    RtpListen { port: u16, session: String },
    RtpConnect { peer: String, session: String },
    Sim,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UnitCfg {
    pub kind: UnitKind,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Mcu,
    Profile,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub mixer: String,
    pub master_aux: String,
    pub mode: Mode,
    pub units: Vec<UnitCfg>,
    pub profile: Option<Value>,
    /// Tastenbelegung (Seiten, feste Tasten, Jog), Betriebsart `mcu`.
    pub keys: Option<Value>,
}

impl Default for Config {
    fn default() -> Self {
        Config { mixer: String::new(), master_aux: String::new(), mode: Mode::Mcu, units: vec![], profile: None, keys: None }
    }
}

pub const MAX_UNITS: usize = 4;

pub fn parse_config(s: &str) -> Result<Config, String> {
    let v: Value = serde_json::from_str(s).map_err(|e| format!("kein gültiges JSON: {e}"))?;
    from_value(&v)
}

pub fn from_value(v: &Value) -> Result<Config, String> {
    let mode = match v.get("mode").and_then(Value::as_str).unwrap_or("mcu") {
        "mcu" => Mode::Mcu,
        "profile" => Mode::Profile,
        m => return Err(format!("mode „{m}“ unbekannt (mcu oder profile)")),
    };
    let mut units = vec![];
    for (i, u) in v.get("units").and_then(Value::as_array).cloned().unwrap_or_default().iter().enumerate() {
        let w = format!("units[{i}]");
        let t = u.get("type").and_then(Value::as_str).unwrap_or("");
        let name = u.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let kind = match t {
            "raw" => {
                let path = u.get("path").and_then(Value::as_str).unwrap_or("").to_string();
                // Nur Rohgeräte der Soundkarten: kein beliebiger Dateipfad (der Node schreibt dorthin).
                let ok = path.strip_prefix("/dev/snd/midiC").is_some_and(|r| !r.contains('/') && r.contains('D') && r.chars().all(|c| c.is_ascii_digit() || c == 'D'));
                if !ok {
                    return Err(format!("{w}: path muss ein Gerät /dev/snd/midiC<n>D<m> sein"));
                }
                UnitKind::Raw { path }
            }
            "rtp" => {
                let session = u.get("session").and_then(Value::as_str).unwrap_or("OMP MIDI").to_string();
                if let Some(p) = u.get("listen").and_then(Value::as_u64) {
                    if !(1..=65534).contains(&p) {
                        return Err(format!("{w}: listen 1…65534"));
                    }
                    UnitKind::RtpListen { port: p as u16, session }
                } else if let Some(peer) = u.get("connect").and_then(Value::as_str) {
                    if !peer.contains(':') {
                        return Err(format!("{w}: connect als host:port"));
                    }
                    UnitKind::RtpConnect { peer: peer.to_string(), session }
                } else {
                    return Err(format!("{w}: rtp braucht listen (Port) oder connect (host:port)"));
                }
            }
            "sim" => UnitKind::Sim,
            other => return Err(format!("{w}: type „{other}“ unbekannt (raw, rtp, sim)")),
        };
        units.push(UnitCfg { kind, name });
    }
    if units.len() > MAX_UNITS {
        return Err(format!("höchstens {MAX_UNITS} Einheiten"));
    }
    let profile = v.get("profile").filter(|p| !p.is_null()).cloned();
    if mode == Mode::Profile {
        match &profile {
            None => return Err("Betriebsart profile braucht ein Profil".to_string()),
            Some(p) => {
                if let Err(e) = crate::profile::parse_profile(p) {
                    return Err(format!("Profil: {}", e.join("; ")));
                }
            }
        }
    }
    let keys = v.get("keys").filter(|k| !k.is_null()).cloned();
    if let Some(k) = &keys {
        if let Err(e) = crate::keys::parse_keys(k) {
            return Err(format!("Tasten: {}", e.join("; ")));
        }
    }
    Ok(Config {
        mixer: v.get("mixer").and_then(Value::as_str).unwrap_or("").trim().to_string(),
        master_aux: v.get("masterAux").and_then(Value::as_str).unwrap_or("").trim().to_string(),
        mode,
        units,
        profile,
        keys,
    })
}

pub fn to_value(c: &Config) -> Value {
    let units: Vec<Value> = c
        .units
        .iter()
        .map(|u| {
            let mut o = match &u.kind {
                UnitKind::Raw { path } => json!({"type": "raw", "path": path}),
                UnitKind::RtpListen { port, session } => json!({"type": "rtp", "listen": port, "session": session}),
                UnitKind::RtpConnect { peer, session } => json!({"type": "rtp", "connect": peer, "session": session}),
                UnitKind::Sim => json!({"type": "sim"}),
            };
            if !u.name.is_empty() {
                o["name"] = json!(u.name);
            }
            o
        })
        .collect();
    json!({"mixer": c.mixer, "masterAux": c.master_aux, "mode": if c.mode == Mode::Mcu { "mcu" } else { "profile" }, "units": units, "profile": c.profile, "keys": c.keys})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_defaults() {
        let s = r#"{"mixer":"Audiomischer","masterAux":"x","units":[{"type":"raw","path":"/dev/snd/midiC1D0","name":"V1-M"},{"type":"rtp","listen":5004},{"type":"rtp","connect":"10.0.0.5:5004","session":"S"},{"type":"sim"}]}"#;
        let c = parse_config(s).unwrap();
        assert_eq!(c.units.len(), 4);
        assert_eq!(c.units[1].kind, UnitKind::RtpListen { port: 5004, session: "OMP MIDI".into() });
        assert_eq!(parse_config(&to_value(&c).to_string()).unwrap(), c);
        assert_eq!(parse_config("{}").unwrap(), Config::default());
    }

    #[test]
    fn rejects_unsafe_and_wrong() {
        for (s, part) in [
            (r#"{"units":[{"type":"raw","path":"/etc/passwd"}]}"#, "midiC"),
            (r#"{"units":[{"type":"raw","path":"/dev/snd/midiC1D0/../../x"}]}"#, "midiC"),
            (r#"{"units":[{"type":"raw","path":"/dev/snd/midiC1"}]}"#, "midiC"),
            (r#"{"units":[{"type":"rtp"}]}"#, "listen"),
            (r#"{"units":[{"type":"rtp","listen":0}]}"#, "listen"),
            (r#"{"units":[{"type":"rtp","connect":"host"}]}"#, "host:port"),
            (r#"{"units":[{"type":"x"}]}"#, "unbekannt"),
            (r#"{"mode":"profile"}"#, "Profil"),
            (r#"{"mode":"zz"}"#, "mode"),
            (r#"{"units":[{"type":"sim"},{"type":"sim"},{"type":"sim"},{"type":"sim"},{"type":"sim"}]}"#, "höchstens"),
            ("kaputt", "JSON"),
        ] {
            let e = parse_config(s).unwrap_err();
            assert!(e.contains(part), "{s}: {e}");
        }
    }
}
