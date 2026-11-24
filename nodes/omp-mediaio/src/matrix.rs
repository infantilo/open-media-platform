//! Audio-Matrix (Kap. 107): Modell, Prüfung und Übersetzung der Kreuzschiene in einen Abspielplan. Reiner Rechenteil ohne MXL,
//! damit vollständig testbar; der Echtzeitteil steht in `rawmatrix.rs`.
//!
//! Eingänge und Ausgänge sind Ports mit Name und Kanalliste (Label, optional Symbol nach VSF TR-03 Anhang A, so wie es
//! AMWA IS-04 v1.3 in `source_audio.channels[]` vorsieht). Die Kreuzschiene ist eine Liste von Kreuzpunkten
//! „Eingangskanal → Ausgangskanal“. Ein Ausgangskanal ohne Kreuzpunkt ist Stille; mit genau einem Kreuzpunkt ohne Gain ein
//! **Kopierkanal** (bitgleich); alles andere ein **Mischkanal** (Summe mit Gain).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

pub const MAX_INPUTS: usize = 16;
pub const MAX_OUTPUTS: usize = 32;
pub const MAX_CHANNELS: usize = 64;
pub const MAX_SOURCES_PER_CHANNEL: usize = 16;
pub const GAIN_MIN_DB: f32 = -120.0;
pub const GAIN_MAX_DB: f32 = 24.0;

/// Kanalsymbole nach VSF TR-03 Anhang A (Aufzählung in IS-04 v1.3 `source_audio.json`); dazu `NSCnnn` (001…128) und `Unn` (01…64).
const SYMBOLS: &[&str] = &["L", "R", "C", "LFE", "Ls", "Rs", "Lss", "Rss", "Lrs", "Rrs", "Lc", "Rc", "Cs", "HI", "VIN", "M1", "M2", "Lt", "Rt", "Lst", "Rst", "S"];

pub fn valid_symbol(s: &str) -> bool {
    if SYMBOLS.contains(&s) {
        return true;
    }
    let num = |rest: &str, digits: usize, lo: u32, hi: u32| rest.len() == digits && rest.chars().all(|c| c.is_ascii_digit()) && rest.parse::<u32>().is_ok_and(|n| (lo..=hi).contains(&n));
    s.strip_prefix("NSC").is_some_and(|r| num(r, 3, 0, 128)) || s.strip_prefix('U').is_some_and(|r| num(r, 2, 1, 64))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
enum ChannelRepr {
    Text(String),
    Full {
        label: String,
        #[serde(default)]
        symbol: Option<String>,
    },
}

/// Ein Kanal eines Ports. In JSON entweder nur der Text (`"Komm"`) oder `{"label":"Links","symbol":"L"}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(from = "ChannelRepr")]
pub struct Channel {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
}

impl From<ChannelRepr> for Channel {
    fn from(r: ChannelRepr) -> Self {
        match r {
            ChannelRepr::Text(label) => Channel { label, symbol: None },
            ChannelRepr::Full { label, symbol } => Channel { label, symbol },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Port {
    pub id: String,
    pub name: String,
    pub channels: Vec<Channel>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Route {
    /// Ausgang (Port-ID) und Ausgangskanal (1-basiert).
    pub out: String,
    pub ch: usize,
    /// Eingang (Port-ID) und Eingangskanal (1-basiert).
    #[serde(rename = "in")]
    pub input: String,
    #[serde(rename = "inCh")]
    pub in_ch: usize,
    /// Fehlt oder 0 → Kopie, wenn es die einzige Quelle des Ausgangskanals ist.
    #[serde(rename = "gainDb", default, skip_serializing_if = "Option::is_none")]
    pub gain_db: Option<f32>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub inputs: Vec<Port>,
    #[serde(default)]
    pub outputs: Vec<Port>,
    #[serde(default)]
    pub routes: Vec<Route>,
}

pub fn parse(json: &str) -> Result<Config, String> {
    let c: Config = serde_json::from_str(json).map_err(|e| format!("Matrix: {e}"))?;
    validate(&c)?;
    Ok(c)
}

fn check_ports(ports: &[Port], kind: &str, max: usize) -> Result<(), String> {
    if ports.len() > max {
        return Err(format!("höchstens {max} {kind}"));
    }
    let (mut ids, mut names) = (HashSet::new(), HashSet::new());
    for p in ports {
        let (id, name) = (p.id.trim(), p.name.trim());
        if id.is_empty() || id.chars().count() > 40 {
            return Err(format!("{kind}: ID leer oder länger als 40 Zeichen"));
        }
        if name.is_empty() || name.chars().count() > 40 {
            return Err(format!("{kind} „{id}“: Name leer oder länger als 40 Zeichen"));
        }
        if !ids.insert(id) {
            return Err(format!("{kind}: ID „{id}“ doppelt"));
        }
        if !names.insert(name) {
            return Err(format!("{kind}: Name „{name}“ doppelt"));
        }
        if p.channels.is_empty() || p.channels.len() > MAX_CHANNELS {
            return Err(format!("{kind} „{name}“: 1…{MAX_CHANNELS} Kanäle"));
        }
        for (i, c) in p.channels.iter().enumerate() {
            if c.label.chars().count() > 40 {
                return Err(format!("{kind} „{name}“: Kanal {} Label länger als 40 Zeichen", i + 1));
            }
            if let Some(s) = &c.symbol && !valid_symbol(s) {
                return Err(format!("{kind} „{name}“: Kanal {} Symbol „{s}“ ist nach VSF TR-03 Anhang A unbekannt", i + 1));
            }
        }
    }
    Ok(())
}

/// Prüft die ganze Konfiguration (Grenzen, eindeutige IDs und Namen, gültige Kreuzpunkte).
pub fn validate(c: &Config) -> Result<(), String> {
    check_ports(&c.inputs, "Eingang", MAX_INPUTS)?;
    check_ports(&c.outputs, "Ausgang", MAX_OUTPUTS)?;
    let ins: HashMap<&str, usize> = c.inputs.iter().map(|p| (p.id.as_str(), p.channels.len())).collect();
    let outs: HashMap<&str, usize> = c.outputs.iter().map(|p| (p.id.as_str(), p.channels.len())).collect();
    let mut seen = HashSet::new();
    let mut per_target: HashMap<(&str, usize), usize> = HashMap::new();
    for r in &c.routes {
        let n_out = *outs.get(r.out.as_str()).ok_or_else(|| format!("Kreuzpunkt: Ausgang „{}“ gibt es nicht", r.out))?;
        let n_in = *ins.get(r.input.as_str()).ok_or_else(|| format!("Kreuzpunkt: Eingang „{}“ gibt es nicht", r.input))?;
        if r.ch == 0 || r.ch > n_out {
            return Err(format!("Kreuzpunkt: Ausgang „{}“ hat keinen Kanal {}", r.out, r.ch));
        }
        if r.in_ch == 0 || r.in_ch > n_in {
            return Err(format!("Kreuzpunkt: Eingang „{}“ hat keinen Kanal {}", r.input, r.in_ch));
        }
        if let Some(g) = r.gain_db && !(g.is_finite() && (GAIN_MIN_DB..=GAIN_MAX_DB).contains(&g)) {
            return Err(format!("Kreuzpunkt {}→{}: Gain {g} dB außerhalb {GAIN_MIN_DB}…{GAIN_MAX_DB}", r.input, r.out));
        }
        if !seen.insert((r.out.as_str(), r.ch, r.input.as_str(), r.in_ch)) {
            return Err(format!("Kreuzpunkt {}:{} → {}:{} doppelt", r.input, r.in_ch, r.out, r.ch));
        }
        let n = per_target.entry((r.out.as_str(), r.ch)).or_default();
        *n += 1;
        if *n > MAX_SOURCES_PER_CHANNEL {
            return Err(format!("Ausgang „{}“ Kanal {}: höchstens {MAX_SOURCES_PER_CHANNEL} Quellen", r.out, r.ch));
        }
    }
    Ok(())
}

/// Wie ein Ausgangskanal erzeugt wird.
#[derive(Clone, Debug, PartialEq)]
pub enum ChanPlan {
    Silence,
    /// Bitgleiche Kopie von Eingang (Index in `Config::inputs`), Kanal (0-basiert).
    Copy { input: usize, ch: usize },
    /// Summe der Quellen: (Eingangsindex, Kanal 0-basiert, linearer Faktor).
    Mix(Vec<(usize, usize, f32)>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct OutPlan {
    pub id: String,
    pub channels: Vec<ChanPlan>,
}

/// Abspielplan: je Ausgang (Reihenfolge wie `Config::outputs`) je Kanal die Art der Erzeugung.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Plan {
    pub outputs: Vec<OutPlan>,
    /// Eingang-IDs in der Reihenfolge, auf die sich die Indizes in `ChanPlan` beziehen.
    pub inputs: Vec<String>,
}

pub fn db_to_linear(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Übersetzt eine geprüfte Konfiguration in den Plan. Ein einzelner Kreuzpunkt mit 0 dB (oder ohne Gain) wird zur Kopie.
pub fn compile(c: &Config) -> Plan {
    let in_idx: HashMap<&str, usize> = c.inputs.iter().enumerate().map(|(i, p)| (p.id.as_str(), i)).collect();
    let outputs = c
        .outputs
        .iter()
        .map(|o| {
            let channels = (1..=o.channels.len())
                .map(|ch| {
                    let src: Vec<&Route> = c.routes.iter().filter(|r| r.out == o.id && r.ch == ch).collect();
                    match src.as_slice() {
                        [] => ChanPlan::Silence,
                        [r] if r.gain_db.unwrap_or(0.0) == 0.0 => ChanPlan::Copy { input: in_idx.get(r.input.as_str()).copied().unwrap_or(0), ch: r.in_ch - 1 },
                        many => ChanPlan::Mix(many.iter().map(|r| (in_idx.get(r.input.as_str()).copied().unwrap_or(0), r.in_ch - 1, db_to_linear(r.gain_db.unwrap_or(0.0)))).collect()),
                    }
                })
                .collect();
            OutPlan { id: o.id.clone(), channels }
        })
        .collect();
    Plan { outputs, inputs: c.inputs.iter().map(|p| p.id.clone()).collect() }
}

/// Summiert Quellen mit Faktor in `dst` (alle gleich lang). Fehlende Quellen (`None`) zählen als Stille.
/// Rückgabe: größter Betrag des Ergebnisses (> 1,0 = Übersteuerung; es wird nicht begrenzt).
pub fn mix_into(dst: &mut [f32], sources: &[(Option<&[f32]>, f32)]) -> f32 {
    dst.iter_mut().for_each(|d| *d = 0.0);
    for (src, gain) in sources {
        if let Some(s) = src {
            for (d, v) in dst.iter_mut().zip(s.iter()) {
                *d += v * gain;
            }
        }
    }
    dst.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

/// Standard „Teiler“: ein Eingang mit `n` Kanälen, je zwei Kanäle ein Ausgang (ungerader letzter Mono), 1:1 verdrahtet.
pub fn splitter_pairs(n: usize) -> Config {
    let n = n.clamp(1, MAX_CHANNELS);
    let input = Port { id: "in1".into(), name: "Input".into(), channels: (1..=n).map(|i| Channel { label: i.to_string(), symbol: None }).collect() };
    let (mut outputs, mut routes) = (vec![], vec![]);
    for (k, a) in (1..=n).step_by(2).enumerate().take(MAX_OUTPUTS) {
        let two = a < n;
        let id = format!("out{}", k + 1);
        let name = if two { format!("{a}/{}", a + 1) } else { a.to_string() };
        let count = if two { 2 } else { 1 };
        outputs.push(Port { id: id.clone(), name, channels: (0..count).map(|j| Channel { label: (a + j).to_string(), symbol: None }).collect() });
        for j in 0..count {
            routes.push(Route { out: id.clone(), ch: j + 1, input: "in1".into(), in_ch: a + j, gain_db: None });
        }
    }
    Config { inputs: vec![input], outputs, routes }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port(id: &str, name: &str, n: usize) -> Port {
        Port { id: id.into(), name: name.into(), channels: (1..=n).map(|i| Channel { label: i.to_string(), symbol: None }).collect() }
    }
    fn route(out: &str, ch: usize, input: &str, in_ch: usize, g: Option<f32>) -> Route {
        Route { out: out.into(), ch, input: input.into(), in_ch, gain_db: g }
    }

    #[test]
    fn parses_strings_and_objects_for_channels() {
        let c = parse(r#"{"inputs":[{"id":"a","name":"A","channels":["Komm",{"label":"Links","symbol":"L"}]}],"outputs":[{"id":"o","name":"O","channels":["x"]}],"routes":[{"out":"o","ch":1,"in":"a","inCh":2}]}"#).unwrap();
        assert_eq!(c.inputs[0].channels[0], Channel { label: "Komm".into(), symbol: None });
        assert_eq!(c.inputs[0].channels[1].symbol.as_deref(), Some("L"));
        // Rundreise
        assert_eq!(parse(&serde_json::to_string(&c).unwrap()).unwrap(), c);
    }

    #[test]
    fn symbols_follow_tr03() {
        for s in ["L", "LFE", "Rrs", "M2", "NSC001", "NSC128", "U01", "U64"] {
            assert!(valid_symbol(s), "{s}");
        }
        for s in ["l", "NSC129", "NSC1", "U00", "U65", "X", ""] {
            assert!(!valid_symbol(s), "{s}");
        }
    }

    #[test]
    fn rejects_bad_configs() {
        let base = Config { inputs: vec![port("a", "A", 2)], outputs: vec![port("o", "O", 2)], routes: vec![] };
        assert!(validate(&base).is_ok());
        let mut c = base.clone();
        c.routes = vec![route("x", 1, "a", 1, None)];
        assert!(validate(&c).unwrap_err().contains("Ausgang"));
        c.routes = vec![route("o", 3, "a", 1, None)];
        assert!(validate(&c).is_err());
        c.routes = vec![route("o", 1, "a", 3, None)];
        assert!(validate(&c).is_err());
        c.routes = vec![route("o", 1, "a", 1, Some(f32::NAN))];
        assert!(validate(&c).is_err());
        c.routes = vec![route("o", 1, "a", 1, Some(30.0))];
        assert!(validate(&c).is_err());
        c.routes = vec![route("o", 1, "a", 1, None), route("o", 1, "a", 1, Some(-3.0))];
        assert!(validate(&c).unwrap_err().contains("doppelt"));
        let mut d = base.clone();
        d.outputs.push(port("o", "P", 1));
        assert!(validate(&d).unwrap_err().contains("ID"));
        let mut d = base.clone();
        d.outputs.push(port("p", "O", 1));
        assert!(validate(&d).unwrap_err().contains("Name"));
        let mut d = base.clone();
        d.outputs[0].channels[0].symbol = Some("Q".into());
        assert!(validate(&d).unwrap_err().contains("TR-03"));
        let mut d = base;
        d.outputs[0].channels = vec![];
        assert!(validate(&d).is_err());
    }

    #[test]
    fn limits() {
        let many_in = Config { inputs: (0..17).map(|i| port(&format!("i{i}"), &format!("I{i}"), 1)).collect(), ..Default::default() };
        assert!(validate(&many_in).is_err());
        let many_out = Config { outputs: (0..33).map(|i| port(&format!("o{i}"), &format!("O{i}"), 1)).collect(), ..Default::default() };
        assert!(validate(&many_out).is_err());
        let wide = Config { outputs: vec![port("o", "O", 65)], ..Default::default() };
        assert!(validate(&wide).is_err());
        assert!(validate(&Config { outputs: vec![port("o", "O", 64)], ..Default::default() }).is_ok());
    }

    #[test]
    fn compile_classifies_channels() {
        let c = Config {
            inputs: vec![port("a", "A", 2), port("b", "B", 1)],
            outputs: vec![port("o", "O", 4)],
            routes: vec![route("o", 1, "a", 1, None), route("o", 2, "b", 1, Some(0.0)), route("o", 3, "a", 2, Some(-6.0)), route("o", 3, "b", 1, None)],
        };
        let p = compile(&c);
        assert_eq!(p.outputs[0].channels[0], ChanPlan::Copy { input: 0, ch: 0 });
        assert_eq!(p.outputs[0].channels[1], ChanPlan::Copy { input: 1, ch: 0 });
        match &p.outputs[0].channels[2] {
            ChanPlan::Mix(m) => {
                assert_eq!(m.len(), 2);
                assert!((m[0].2 - 0.501_187).abs() < 1e-4 && m[1].2 == 1.0);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(p.outputs[0].channels[3], ChanPlan::Silence);
        // Einzelner Kreuzpunkt mit Gain ist Mischkanal, nicht Kopie.
        let g = Config { routes: vec![route("o", 1, "a", 1, Some(-3.0))], ..c };
        assert!(matches!(compile(&g).outputs[0].channels[0], ChanPlan::Mix(_)));
    }

    #[test]
    fn mix_sums_with_gain_and_treats_missing_as_silence() {
        let a = [0.5f32, -0.5, 1.0];
        let b = [0.25f32, 0.25, 0.25];
        let mut dst = [9.0f32; 3];
        let peak = mix_into(&mut dst, &[(Some(&a), 1.0), (Some(&b), 2.0), (None, 1.0)]);
        assert_eq!(dst, [1.0, 0.0, 1.5]);
        assert_eq!(peak, 1.5);
        let peak = mix_into(&mut dst, &[(None, 1.0)]);
        assert_eq!((dst, peak), ([0.0; 3], 0.0));
    }

    #[test]
    fn splitter_preset_matches_old_splitter() {
        let c = splitter_pairs(5);
        assert!(validate(&c).is_ok());
        assert_eq!(c.outputs.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["1/2", "3/4", "5"]);
        assert!(compile(&c).outputs.iter().flat_map(|o| &o.channels).all(|x| matches!(x, ChanPlan::Copy { .. })));
        assert_eq!(validate(&splitter_pairs(64)), Ok(()));
    }
}
