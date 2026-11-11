//! Tastenbelegung des Pults (Kapitel 93) — Rust-Gegenstück zu `ui/shell/midi/keys.ts`, gegen `docs/midi/keys-golden.json` getestet.
//! Feste Funktionstasten, Funktionstastenfeld F1–F8 in umschaltbaren Seiten, Jog-Rad. `{ch}` steht für den gewählten Kanal.

use std::collections::HashMap;

use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyAction {
    Toggle,
    Momentary,
    Call,
    Internal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Internal {
    ClearPfl,
    ClearMute,
    SelectPrev,
    SelectNext,
    GainUp,
    GainDown,
    Deselect,
    JogMode,
}

#[derive(Clone, Debug)]
pub struct KeyBinding {
    pub label: Option<String>,
    pub action: KeyAction,
    pub internal: Option<Internal>,
    pub node: String,
    pub method: String,
    pub args: Map<String, Value>,
    pub arg: Option<String>,
    pub on_value: Option<Value>,
    pub off_value: Option<Value>,
    /// (Pfad im Mischer-Eintrag des gewählten Kanals, Vergleichswert)
    pub led: Option<(String, Option<Value>)>,
}

#[derive(Clone, Debug)]
pub enum JogMode {
    Gain { name: Option<String> },
    Select { name: Option<String> },
    Nudge { name: Option<String>, node: String, method: String, args: Map<String, Value>, arg: String, read_param: String, step: f64, min: Option<f64>, max: Option<f64> },
}

impl JogMode {
    pub fn label(&self) -> String {
        match self {
            JogMode::Gain { name } => name.clone().unwrap_or_else(|| "gain".into()),
            JogMode::Select { name } => name.clone().unwrap_or_else(|| "select".into()),
            JogMode::Nudge { name, .. } => name.clone().unwrap_or_else(|| "nudge".into()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Page {
    pub name: String,
    pub keys: HashMap<String, KeyBinding>,
}

#[derive(Clone, Debug, Default)]
pub struct KeysConfig {
    pub pages: Vec<Page>,
    pub global: HashMap<String, KeyBinding>,
    pub jog: Vec<JogMode>,
    /// Zusatzprofil für alles, was kein Mackie-Control ist (frei belegte Pads, Regler auf anderen MIDI-Kanälen).
    pub profile: Option<crate::profile::Profile>,
}

pub const PAGE_KEYS: [&str; 8] = ["midiTracks", "inputs", "audioTracks", "audioInstruments", "aux", "busses", "outputs", "user"];

fn toggle(method: &str, arg: &str, led: &str, label: &str) -> KeyBinding {
    KeyBinding { label: Some(label.into()), action: KeyAction::Toggle, internal: None, node: String::new(), method: format!("channel.{{ch}}.{method}"), args: Map::new(), arg: Some(arg.into()), on_value: None, off_value: None, led: Some((led.into(), None)) }
}

fn internal(a: Internal, label: &str) -> KeyBinding {
    KeyBinding { label: Some(label.into()), action: KeyAction::Internal, internal: Some(a), node: String::new(), method: String::new(), args: Map::new(), arg: None, on_value: None, off_value: None, led: None }
}

pub fn default_page() -> Page {
    let mut keys = HashMap::new();
    keys.insert("f1".to_string(), toggle("setMute", "muted", "mute", "Mute"));
    keys.insert("f2".to_string(), toggle("setPfl", "enabled", "pfl", "PFL"));
    keys.insert("f3".to_string(), toggle("setPhase", "invert", "proc.phaseInvert", "Phase"));
    keys.insert("f4".to_string(), toggle("setEqBypass", "bypass", "proc.eqBypass", "EQ byp"));
    keys.insert("f5".to_string(), toggle("setComp", "enabled", "proc.compEnabled", "Comp"));
    keys.insert("f6".to_string(), toggle("setGate", "enabled", "proc.gateEnabled", "Gate"));
    keys.insert("f7".to_string(), toggle("setMainRoute", "routed", "mainRoute", "Main"));
    keys.insert("f8".to_string(), internal(Internal::ClearMute, "Mute clr"));
    Page { name: "Kanal".into(), keys }
}

pub fn default_global() -> HashMap<String, KeyBinding> {
    let mut g = HashMap::new();
    g.insert("soloGlobal".to_string(), internal(Internal::ClearPfl, "PFL clr"));
    g.insert("left".to_string(), internal(Internal::SelectPrev, "Sel <"));
    g.insert("right".to_string(), internal(Internal::SelectNext, "Sel >"));
    g.insert("up".to_string(), internal(Internal::GainUp, "Gain +1"));
    g.insert("down".to_string(), internal(Internal::GainDown, "Gain -1"));
    g.insert("cancel".to_string(), internal(Internal::Deselect, "Desel"));
    g.insert("scrub".to_string(), internal(Internal::JogMode, "Jog"));
    g
}

pub fn default_jog() -> Vec<JogMode> {
    vec![JogMode::Gain { name: Some("Gain".into()) }, JogMode::Select { name: Some("Select".into()) }]
}

#[derive(Clone, Debug)]
pub struct Keys {
    pub pages: Vec<Page>,
    pub global: HashMap<String, KeyBinding>,
    pub jog: Vec<JogMode>,
    pub profile: Option<crate::profile::Profile>,
}

/// Konfiguration mit Standardwerten zusammenführen: konfigurierte Seiten ersetzen die Standardseite Stück für Stück.
pub fn resolve(c: Option<&KeysConfig>) -> Keys {
    let mut pages = vec![default_page()];
    let mut global = default_global();
    let mut jog = default_jog();
    if let Some(c) = c {
        if let Some(first) = c.pages.first() {
            pages[0] = first.clone();
        }
        pages.extend(c.pages.iter().skip(1).cloned());
        global.extend(c.global.clone());
        if !c.jog.is_empty() {
            jog = c.jog.clone();
        }
    }
    pages.truncate(PAGE_KEYS.len());
    Keys { pages, global, jog, profile: c.and_then(|c| c.profile.clone()) }
}

pub fn get_path<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = v;
    for p in path.split('.') {
        cur = cur.get(p)?;
    }
    Some(cur)
}

pub fn set_path(v: &mut Value, path: &str, val: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut cur = v;
    for p in &parts[..parts.len() - 1] {
        if !cur.get(*p).is_some_and(Value::is_object) {
            cur[*p] = Value::Object(Map::new());
        }
        cur = cur.get_mut(*p).expect("eben angelegt");
    }
    cur[parts[parts.len() - 1]] = val;
}

pub fn fill_template(v: &Value, ch: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace("{ch}", ch)),
        Value::Array(a) => Value::Array(a.iter().map(|x| fill_template(x, ch)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), fill_template(x, ch))).collect()),
        x => x.clone(),
    }
}

pub fn fill_str(s: &str, ch: &str) -> String {
    s.replace("{ch}", ch)
}

pub fn uses_channel(b: &KeyBinding) -> bool {
    b.method.contains("{ch}") || b.arg.as_deref().is_some_and(|a| a.contains("{ch}")) || Value::Object(b.args.clone()).to_string().contains("{ch}")
}

const INTERNALS: [(&str, Internal); 8] = [
    ("clearPfl", Internal::ClearPfl),
    ("clearMute", Internal::ClearMute),
    ("selectPrev", Internal::SelectPrev),
    ("selectNext", Internal::SelectNext),
    ("gainUp", Internal::GainUp),
    ("gainDown", Internal::GainDown),
    ("deselect", Internal::Deselect),
    ("jogMode", Internal::JogMode),
];

fn parse_binding(w: &str, name: &str, v: &Value, errs: &mut Vec<String>) -> Option<KeyBinding> {
    if crate::mcu::note_by_name(name).is_none() {
        errs.push(format!("{w}: Taste „{name}“ unbekannt"));
    }
    let action = match v.get("action").and_then(Value::as_str) {
        Some("toggle") => KeyAction::Toggle,
        Some("momentary") => KeyAction::Momentary,
        Some("call") => KeyAction::Call,
        Some("internal") => KeyAction::Internal,
        _ => {
            errs.push(format!("{w}.{name}: action muss toggle, momentary, call oder internal sein"));
            return None;
        }
    };
    let method = v.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let arg = v.get("arg").and_then(Value::as_str).map(str::to_string);
    let mut int = None;
    if action == KeyAction::Internal {
        match v.get("internal").and_then(Value::as_str).and_then(|s| INTERNALS.iter().find(|(k, _)| *k == s)) {
            Some((_, i)) => int = Some(*i),
            None => errs.push(format!("{w}.{name}: internal unbekannt ({})", INTERNALS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", "))),
        }
    } else if method.is_empty() {
        errs.push(format!("{w}.{name}: method fehlt"));
    }
    if matches!(action, KeyAction::Toggle | KeyAction::Momentary) && !method.is_empty() && arg.is_none() {
        errs.push(format!("{w}.{name}: arg fehlt (Name des Arguments für an/aus)"));
    }
    let led = match v.get("led") {
        Some(Value::String(p)) => Some((p.clone(), None)),
        Some(o @ Value::Object(_)) => o.get("path").and_then(Value::as_str).map(|p| (p.to_string(), o.get("equals").cloned())),
        _ => None,
    };
    Some(KeyBinding {
        label: v.get("label").and_then(Value::as_str).map(str::to_string),
        action,
        internal: int,
        node: v.get("node").and_then(Value::as_str).unwrap_or("").to_string(),
        method,
        args: v.get("args").and_then(Value::as_object).cloned().unwrap_or_default(),
        arg,
        on_value: v.get("onValue").cloned(),
        off_value: v.get("offValue").cloned(),
        led,
    })
}

/// Konfiguration aus JSON lesen und prüfen; Fehler lesbar.
pub fn parse_keys(v: &Value) -> Result<KeysConfig, Vec<String>> {
    let mut errs = vec![];
    let mut c = KeysConfig::default();
    if !v.is_object() {
        return Err(vec!["keys ist kein Objekt".into()]);
    }
    if let Some(p) = v.get("pages") {
        match p.as_array() {
            None => errs.push("pages muss eine Liste sein".into()),
            Some(list) => {
                if list.len() > PAGE_KEYS.len() {
                    errs.push(format!("höchstens {} Seiten", PAGE_KEYS.len()));
                }
                for (i, pg) in list.iter().enumerate() {
                    let name = pg.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                    if name.is_empty() {
                        errs.push(format!("pages[{i}]: name fehlt"));
                    }
                    let mut keys = HashMap::new();
                    for (k, b) in pg.get("keys").and_then(Value::as_object).cloned().unwrap_or_default() {
                        if let Some(b) = parse_binding(&format!("pages[{i}]"), &k, &b, &mut errs) {
                            keys.insert(k, b);
                        }
                    }
                    c.pages.push(Page { name, keys });
                }
            }
        }
    }
    for (k, b) in v.get("global").and_then(Value::as_object).cloned().unwrap_or_default() {
        if let Some(b) = parse_binding("global", &k, &b, &mut errs) {
            c.global.insert(k, b);
        }
    }
    if let Some(p) = v.get("profile").filter(|p| !p.is_null()) {
        match crate::profile::parse_profile(p) {
            Ok(pr) => c.profile = Some(pr),
            Err(e) => errs.extend(e.into_iter().map(|x| format!("profile: {x}"))),
        }
    }
    if let Some(j) = v.get("jog") {
        match j.as_array().filter(|a| !a.is_empty()) {
            None => errs.push("jog muss eine nicht leere Liste sein".into()),
            Some(list) => {
                for (i, m) in list.iter().enumerate() {
                    let name = m.get("name").and_then(Value::as_str).map(str::to_string);
                    match m.get("kind").and_then(Value::as_str) {
                        Some("gain") => c.jog.push(JogMode::Gain { name }),
                        Some("select") => c.jog.push(JogMode::Select { name }),
                        Some("nudge") => {
                            let s = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                            if s("method").is_empty() || s("arg").is_empty() || s("readParam").is_empty() {
                                errs.push(format!("jog[{i}]: nudge braucht method, arg und readParam"));
                            } else {
                                c.jog.push(JogMode::Nudge {
                                    name,
                                    node: s("node"),
                                    method: s("method"),
                                    args: m.get("args").and_then(Value::as_object).cloned().unwrap_or_default(),
                                    arg: s("arg"),
                                    read_param: s("readParam"),
                                    step: m.get("step").and_then(Value::as_f64).unwrap_or(1.0),
                                    min: m.get("min").and_then(Value::as_f64),
                                    max: m.get("max").and_then(Value::as_f64),
                                });
                            }
                        }
                        _ => errs.push(format!("jog[{i}]: kind muss gain, select oder nudge sein")),
                    }
                }
            }
        }
    }
    if errs.is_empty() { Ok(c) } else { Err(errs) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn helpers() {
        let mut o = json!({"proc": {"eqBypass": true}, "mute": false});
        assert_eq!(get_path(&o, "proc.eqBypass"), Some(&json!(true)));
        assert_eq!(get_path(&o, "proc.x.y"), None);
        set_path(&mut o, "proc.gateEnabled", json!(true));
        assert_eq!(o["proc"]["gateEnabled"], json!(true));
        assert_eq!(fill_template(&json!({"m": "channel.{ch}.x", "a": ["{ch}", 1]}), "z"), json!({"m": "channel.z.x", "a": ["z", 1]}));
        let r = resolve(Some(&parse_keys(&json!({"global": {"userSwitch1": {"action": "call", "method": "x"}}, "jog": [{"kind": "gain"}]})).unwrap()));
        assert_eq!(r.pages[0].keys.len(), 8);
        assert!(r.global.contains_key("userSwitch1") && r.global.contains_key("scrub"));
        assert_eq!(resolve(None).jog.len(), 2);
    }

    #[test]
    fn validation() {
        assert!(parse_keys(&json!({"pages": [{"name": "x", "keys": {"f1": {"action": "toggle", "method": "m", "arg": "a"}}}], "jog": [{"kind": "gain"}]})).is_ok());
        let e = parse_keys(&json!({
            "pages": [{"name": "", "keys": {"f99": {"action": "call", "method": "m"}, "f1": {"action": "toggle", "method": "m"}}}],
            "global": {"play": {"action": "internal", "internal": "nix"}, "stop": {"action": "call"}},
            "jog": [{"kind": "nudge", "method": "m"}]
        }))
        .unwrap_err();
        for part in ["name fehlt", "f99", "arg fehlt", "internal unbekannt", "method fehlt", "readParam"] {
            assert!(e.iter().any(|x| x.contains(part)), "{part}: {e:?}");
        }
    }

    /// Gemeinsame Szenarien (docs/midi/keys-golden.json) gegen die Pult-Logik.
    #[test]
    fn golden_scenarios() {
        use crate::mcu::{McuEvent, decode_from_surface, note_by_name};
        use crate::mixer::parse_mix_state;
        use crate::surface::{LogicOptions, MixerCmd, SurfaceLogic, UnitSpec};
        let g: Value = serde_json::from_str(include_str!("../../../docs/midi/keys-golden.json")).unwrap();
        fn norm(v: &Value) -> Value {
            match v {
                Value::Number(n) => json!(n.as_f64().unwrap()),
                Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
                Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
                x => x.clone(),
            }
        }
        fn out_json(c: &MixerCmd) -> Value {
            match c {
                MixerCmd::Gain { id, db } => json!({"c": "gain", "id": id, "db": db}),
                MixerCmd::Mute { id, muted } => json!({"c": "mute", "id": id, "muted": muted}),
                MixerCmd::Pfl { id, enabled } => json!({"c": "pfl", "id": id, "enabled": enabled}),
                MixerCmd::Pan { id, pan } => json!({"c": "pan", "id": id, "pan": pan}),
                MixerCmd::Master { db } => json!({"c": "master", "db": db}),
                MixerCmd::Call { node, method, args } => json!({"c": "call", "node": node, "method": method, "args": args}),
                MixerCmd::Nudge { node, method, args, arg, delta, min, max, read_param } => {
                    let mut o = json!({"c": "nudge", "node": node, "method": method, "args": args, "arg": arg, "delta": delta, "readParam": read_param});
                    if let Some(m) = min {
                        o["min"] = json!(m);
                    }
                    if let Some(m) = max {
                        o["max"] = json!(m);
                    }
                    o
                }
            }
        }
        for sc in g["scenarios"].as_array().unwrap() {
            let name = sc["name"].as_str().unwrap();
            let keys = sc.get("keys").filter(|k| !k.is_null()).map(|k| parse_keys(k).unwrap());
            let mut o = LogicOptions::new(vec![UnitSpec { strips: 8, has_master: true }]);
            o.keys = keys;
            let mut logic = SurfaceLogic::new(o);
            logic.set_model(parse_mix_state(&json!({"channels": sc["channels"]})).channels, None);
            let mut now = 1000u64;
            for (i, st) in sc["steps"].as_array().unwrap().iter().enumerate() {
                let key = st.get("key").and_then(Value::as_str);
                let note = key.map(|k| note_by_name(k).unwrap()).unwrap_or(0);
                let ev = match st["do"].as_str().unwrap() {
                    "midi" => decode_from_surface(&st["bytes"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect::<Vec<u8>>()),
                    "press" => McuEvent::Button { note, name: key.map(str::to_string), down: true },
                    "release" => McuEvent::Button { note, name: key.map(str::to_string), down: false },
                    _ => McuEvent::Jog { delta: st["delta"].as_i64().unwrap() as i32 },
                };
                logic.on_event(0, &ev, now);
                now += st.get("ms").and_then(Value::as_u64).unwrap_or(100);
                logic.flush(now, false);
                let mut got: Vec<Value> = logic.drain_cmds().iter().map(out_json).collect();
                got.extend(logic.drain_buttons().into_iter().map(|(n, d)| json!({"c": "unbound", "name": n, "down": d})));
                let w = format!("{name}: Schritt {}", i + 1);
                assert_eq!(norm(&Value::Array(got)), norm(&st["expect"]), "{w}");
                let Some(state) = st.get("state") else { continue };
                let v = logic.view(0, now - 50);
                if let Some(p) = state.get("page") {
                    assert_eq!(json!(logic.page), *p, "{w}: page");
                }
                if let Some(p) = state.get("jogMode") {
                    assert_eq!(json!(logic.jog_mode), *p, "{w}: jogMode");
                }
                if let Some(p) = state.get("selected") {
                    assert_eq!(json!(logic.selected), *p, "{w}: selected");
                }
                if let Some(p) = state.get("bank") {
                    assert_eq!(json!(logic.bank), *p, "{w}: bank");
                }
                if let Some(p) = state.get("message") {
                    assert_eq!(json!(v.message), *p, "{w}: message");
                }
                for (k, want) in state.get("leds").and_then(Value::as_object).cloned().unwrap_or_default() {
                    let led = v.leds.get(&note_by_name(&k).unwrap()).copied();
                    let s = match led {
                        Some(crate::mcu::Led::On) => "on",
                        Some(crate::mcu::Led::Blink) => "blink",
                        Some(crate::mcu::Led::Off) => "off",
                        None => "none",
                    };
                    assert_eq!(json!(s), want, "{w}: LED {k}");
                }
            }
        }
    }
}
