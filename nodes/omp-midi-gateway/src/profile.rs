//! Generische MIDI-Zuordnung (Kapitel 93) — Rust-Gegenstück zu `ui/shell/midi/profile.ts`, gegen `docs/midi/profile-golden.json` getestet.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

#[derive(Clone, Debug, PartialEq)]
pub struct MidiIn {
    pub kind: String, // "cc" | "note" | "pitchbend"
    pub channel: Option<u8>,
    pub num: Option<u8>,
}

#[derive(Clone, Debug)]
pub struct Target {
    pub node: String,
    pub method: String,
    pub args: Map<String, Value>,
    pub arg: Option<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub read_param: Option<String>,
    pub on_value: Option<Value>,
    pub off_value: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Absolute,
    Momentary,
    Toggle,
    Relative,
}

#[derive(Clone, Debug)]
pub struct Control {
    pub id: String,
    pub input: MidiIn,
    pub mode: Option<Mode>,
    pub to: Target,
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub name: String,
    pub controls: Vec<Control>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Call { node: String, method: String, args: Map<String, Value>, control_id: String },
    Nudge { node: String, method: String, args: Map<String, Value>, arg: String, delta: f64, min: Option<f64>, max: Option<f64>, read_param: String, control_id: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Described {
    pub kind: &'static str,
    pub channel: u8,
    pub num: u8,
    pub value: i32,
    pub down: Option<bool>,
}

pub fn describe(msg: &[u8]) -> Option<Described> {
    if msg.len() < 3 {
        return None;
    }
    let st = msg[0] & 0xf0;
    let channel = (msg[0] & 0x0f) + 1;
    match st {
        0xb0 => Some(Described { kind: "cc", channel, num: msg[1], value: msg[2] as i32, down: None }),
        0x90 | 0x80 => Some(Described { kind: "note", channel, num: msg[1], value: msg[2] as i32, down: Some(st == 0x90 && msg[2] > 0) }),
        0xe0 => Some(Described { kind: "pitchbend", channel, num: 0, value: ((msg[2] as i32) << 7) | msg[1] as i32, down: None }),
        _ => None,
    }
}

fn matches(i: &MidiIn, d: &Described) -> bool {
    i.kind == d.kind && i.channel.is_none_or(|c| c == d.channel) && (i.kind == "pitchbend" || i.num == Some(d.num))
}

pub fn mode_of(c: &Control) -> Mode {
    c.mode.unwrap_or(if c.input.kind == "note" { Mode::Momentary } else { Mode::Absolute })
}

fn scale(raw: i32, raw_max: i32, min: f64, max: f64) -> f64 {
    let v = min + (raw.clamp(0, raw_max) as f64 / raw_max as f64) * (max - min);
    (v * 10000.0).round() / 10000.0
}

pub struct ProfileEngine {
    pub profile: Profile,
    default_node: String,
    toggles: HashMap<String, bool>,
}

impl ProfileEngine {
    pub fn new(profile: Profile, default_node: &str) -> Self {
        ProfileEngine { profile, default_node: default_node.to_string(), toggles: HashMap::new() }
    }

    pub fn handle(&mut self, msg: &[u8]) -> Vec<Action> {
        let Some(d) = describe(msg) else { return vec![] };
        let mut out = vec![];
        for c in &self.profile.controls {
            if !matches(&c.input, &d) {
                continue;
            }
            let node = if c.to.node.is_empty() { self.default_node.clone() } else { c.to.node.clone() };
            let mode = mode_of(c);
            let mut args = c.to.args.clone();
            let on = c.to.on_value.clone().unwrap_or(Value::Bool(true));
            let off = c.to.off_value.clone().unwrap_or(Value::Bool(false));
            match mode {
                Mode::Absolute => {
                    let Some(a) = &c.to.arg else { continue };
                    let raw_max = if d.kind == "pitchbend" { 16383 } else { 127 };
                    args.insert(a.clone(), json!(scale(d.value, raw_max, c.to.min.unwrap_or(0.0), c.to.max.unwrap_or(1.0))));
                }
                Mode::Momentary => {
                    let down = if d.kind == "note" { d.down.unwrap_or(false) } else { d.value >= 64 };
                    if let Some(a) = &c.to.arg {
                        args.insert(a.clone(), if down { on } else { off });
                    } else if !down {
                        continue;
                    }
                }
                Mode::Toggle => {
                    let down = if d.kind == "note" { d.down.unwrap_or(false) } else { d.value >= 64 };
                    if !down {
                        continue;
                    }
                    let now = !self.toggles.get(&c.id).copied().unwrap_or(false);
                    self.toggles.insert(c.id.clone(), now);
                    if let Some(a) = &c.to.arg {
                        args.insert(a.clone(), if now { on } else { off });
                    }
                }
                Mode::Relative => {
                    let (Some(a), Some(rp)) = (&c.to.arg, &c.to.read_param) else { continue };
                    if d.kind != "cc" {
                        continue;
                    }
                    let delta = (d.value - 64) as f64 * c.to.step.unwrap_or(1.0);
                    if delta == 0.0 {
                        continue;
                    }
                    out.push(Action::Nudge { node, method: c.to.method.clone(), args, arg: a.clone(), delta, min: c.to.min, max: c.to.max, read_param: rp.clone(), control_id: c.id.clone() });
                    continue;
                }
            }
            out.push(Action::Call { node, method: c.to.method.clone(), args, control_id: c.id.clone() });
        }
        out
    }
}

fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}

/// Profil aus JSON lesen und prüfen; Fehler lesbar.
pub fn parse_profile(v: &Value) -> Result<Profile, Vec<String>> {
    let mut errs = vec![];
    let name = v.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if name.is_empty() {
        errs.push("name fehlt".to_string());
    }
    let Some(list) = v.get("controls").and_then(Value::as_array) else {
        errs.push("controls fehlt".to_string());
        return Err(errs);
    };
    let mut controls = vec![];
    let mut ids = std::collections::HashSet::new();
    for (i, c) in list.iter().enumerate() {
        let w = format!("controls[{i}]");
        let id = c.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if id.is_empty() {
            errs.push(format!("{w}: id fehlt"));
        } else if !ids.insert(id.clone()) {
            errs.push(format!("{w}: id „{id}“ doppelt"));
        }
        let inp = c.get("in").cloned().unwrap_or(Value::Null);
        let kind = inp.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        let mut input = MidiIn { kind: kind.clone(), channel: None, num: None };
        if !["cc", "note", "pitchbend"].contains(&kind.as_str()) {
            errs.push(format!("{w}: in.type muss cc, note oder pitchbend sein"));
        } else {
            if kind != "pitchbend" {
                match inp.get("num").and_then(Value::as_u64) {
                    Some(n) if n <= 127 => input.num = Some(n as u8),
                    _ => errs.push(format!("{w}: in.num 0…127")),
                }
            }
            if let Some(ch) = inp.get("channel") {
                match ch.as_u64() {
                    Some(n) if (1..=16).contains(&n) => input.channel = Some(n as u8),
                    _ => errs.push(format!("{w}: in.channel 1…16")),
                }
            }
        }
        let to = c.get("to").cloned().unwrap_or(Value::Null);
        let method = to.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        if method.is_empty() {
            errs.push(format!("{w}: to.method fehlt"));
        }
        let mode = match c.get("mode").and_then(Value::as_str) {
            None => None,
            Some("absolute") => Some(Mode::Absolute),
            Some("momentary") => Some(Mode::Momentary),
            Some("toggle") => Some(Mode::Toggle),
            Some("relative") => Some(Mode::Relative),
            Some(_) => {
                errs.push(format!("{w}: mode unbekannt"));
                None
            }
        };
        let target = Target {
            node: to.get("node").and_then(Value::as_str).unwrap_or("").to_string(),
            method,
            args: to.get("args").and_then(Value::as_object).cloned().unwrap_or_default(),
            arg: to.get("arg").and_then(Value::as_str).map(str::to_string),
            min: num(&to, "min"),
            max: num(&to, "max"),
            step: num(&to, "step"),
            read_param: to.get("readParam").and_then(Value::as_str).map(str::to_string),
            on_value: to.get("onValue").cloned(),
            off_value: to.get("offValue").cloned(),
        };
        let ctl = Control { id, input, mode, to: target };
        if ["cc", "note", "pitchbend"].contains(&kind.as_str()) {
            let m = mode_of(&ctl);
            if matches!(m, Mode::Absolute | Mode::Relative) && ctl.to.arg.is_none() {
                errs.push(format!("{w}: to.arg fehlt (Modus {})", if m == Mode::Absolute { "absolute" } else { "relative" }));
            }
            if m == Mode::Relative && ctl.to.read_param.is_none() {
                errs.push(format!("{w}: to.readParam fehlt (relative)"));
            }
        }
        controls.push(ctl);
    }
    if errs.is_empty() { Ok(Profile { name, controls }) } else { Err(errs) }
}

#[cfg(test)]
fn action_json(a: &Action) -> Value {
    match a {
        Action::Call { node, method, args, control_id } => json!({"kind": "call", "node": node, "method": method, "args": args, "controlId": control_id}),
        Action::Nudge { node, method, args, arg, delta, min, max, read_param, control_id } => {
            let mut v = json!({"kind": "nudge", "node": node, "method": method, "args": args, "arg": arg, "delta": delta, "readParam": read_param, "controlId": control_id});
            if let Some(m) = min {
                v["min"] = json!(m);
            }
            if let Some(m) = max {
                v["max"] = json!(m);
            }
            v
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../docs/midi/profile-golden.json")).unwrap()
    }

    /// Zahlen vergleichen, nicht ihre Schreibweise (12 und 12.0).
    fn norm(v: &Value) -> Value {
        match v {
            Value::Number(n) => json!(n.as_f64().unwrap()),
            Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
            x => x.clone(),
        }
    }

    #[test]
    fn golden_cases() {
        let g = golden();
        let mut eng = ProfileEngine::new(parse_profile(&g["profile"]).unwrap(), "Mischer");
        for c in g["cases"].as_array().unwrap() {
            let msg: Vec<u8> = c["msg"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
            let got: Vec<Value> = eng.handle(&msg).iter().map(action_json).collect();
            assert_eq!(norm(&Value::Array(got)), norm(&c["actions"]), "{msg:?}");
        }
    }

    #[test]
    fn toggle_state_and_validation() {
        let g = golden();
        let mut eng = ProfileEngine::new(parse_profile(&g["profile"]).unwrap(), "M");
        assert_eq!(eng.handle(&[0x90, 40, 127]).len(), 1);
        assert_eq!(eng.handle(&[0x90, 40, 0]).len(), 0);
        match &eng.handle(&[0x90, 40, 127])[0] {
            Action::Call { args, .. } => assert_eq!(args["muted"], json!(false)),
            _ => panic!(),
        }
        assert_eq!(describe(&[0xb2, 7, 100]), Some(Described { kind: "cc", channel: 3, num: 7, value: 100, down: None }));
        assert_eq!(describe(&[0xe5, 0, 64]).unwrap().value, 8192);
        let bad = json!({"name": "", "controls": [{"id": "a", "in": {"type": "cc", "num": 200}, "to": {"method": ""}}, {"id": "a", "in": {"type": "x"}, "to": {}}]});
        let e = parse_profile(&bad).unwrap_err();
        for part in ["name fehlt", "in.num", "doppelt", "to.method"] {
            assert!(e.iter().any(|x| x.contains(part)), "{part}: {e:?}");
        }
    }
}
