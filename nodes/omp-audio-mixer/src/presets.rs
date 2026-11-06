//! Presets für EQ und Dynamik (Kompressor + Gate) je Kanalzug. Ein Preset ist eine Tabelle von Kanal-Parametern (`proc_get`/`proc_set`-Namen
//! aus `main.rs`) — dadurch gilt dieselbe Bereichsprüfung wie bei jeder Einzeländerung. Werkspresets sind fest eingebaut (nur lesbar),
//! eigene Presets liegen im Mischerzustand (Workflow-Sicherung) und lassen sich anlegen, überschreiben und löschen.
//! Die Werte sind Ausgangspunkte nach gängiger Rundfunkpraxis, keine Norm — sie werden am Mikrofon und Raum nachgestellt.

use serde_json::{Map, Value, json};

/// Parameter, die ein EQ-Preset setzt (Bypass bewusst nicht: er gehört zum Kanalzug, nicht zum Klang). Frequenz steht vor Breite,
/// weil die Breite relativ zur neuen Frequenz in Q umgerechnet wird.
pub const EQ_KEYS: &[&str] = &[
    "eqHpEnabled", "eqHpFreq", "eqLowFreq", "eqLowWidth", "eqLow", "eqMidFreq", "eqMidWidth", "eqMid", "eqMid2Freq", "eqMid2Width", "eqMid2", "eqHighFreq",
    "eqHighWidth", "eqHigh",
];

/// Parameter eines Dynamik-Presets (Kompressor und Gate zusammen).
pub const DYN_KEYS: &[&str] = &[
    "compEnabled", "compThreshold", "compRatio", "compMakeup", "compAttack", "compRelease", "compKnee", "compRms", "gateEnabled", "gateThreshold",
    "gateRange", "gateRatio", "gateAttack", "gateHold", "gateRelease", "gateHysteresis",
];

pub fn keys(kind: &str) -> Option<&'static [&'static str]> {
    match kind {
        "eq" => Some(EQ_KEYS),
        "dyn" => Some(DYN_KEYS),
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub struct Preset {
    pub kind: String,
    pub name: String,
    pub values: Map<String, Value>,
    pub builtin: bool,
}

impl Preset {
    pub fn to_state(&self) -> Value {
        json!({"kind": self.kind, "name": self.name, "values": self.values})
    }
    pub fn from_state(v: &Value) -> Option<Preset> {
        let kind = v.get("kind")?.as_str()?.to_string();
        keys(&kind)?;
        let name = v.get("name")?.as_str()?.to_string();
        valid_name(&name).ok()?;
        Some(Preset { kind, name, values: v.get("values")?.as_object()?.clone(), builtin: false })
    }
    pub fn to_list(&self) -> Value {
        json!({"kind": self.kind, "name": self.name, "builtin": self.builtin})
    }
}

/// Name eines eigenen Presets: 1–40 Zeichen, keine Steuerzeichen.
pub fn valid_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 40 || n.chars().any(|c| c.is_control()) || n != name {
        return Err("Name: 1–40 Zeichen ohne Steuerzeichen und ohne Leerraum am Rand".to_string());
    }
    Ok(())
}

fn eq(name: &str, hp: Option<f64>, bands: [(f64, f64, f64); 4]) -> Preset {
    let mut v = Map::new();
    v.insert("eqHpEnabled".into(), json!(hp.is_some()));
    v.insert("eqHpFreq".into(), json!(hp.unwrap_or(80.0)));
    for (i, (key, (f, q, g))) in [("Low", bands[0]), ("Mid", bands[1]), ("Mid2", bands[2]), ("High", bands[3])].into_iter().enumerate() {
        let _ = i;
        v.insert(format!("eq{key}Freq"), json!(f));
        v.insert(format!("eq{key}Width"), json!(f / q));
        v.insert(format!("eq{key}"), json!(g));
    }
    Preset { kind: "eq".into(), name: name.into(), values: v, builtin: true }
}

#[allow(clippy::too_many_arguments)]
fn dynp(name: &str, comp: Option<(f64, f64, f64, f64, f64, f64, bool)>, gate: Option<(f64, f64, f64, f64, f64, f64, f64)>) -> Preset {
    let mut v = Map::new();
    // (Schwelle dB, Ratio, Makeup dB, Attack ms, Release ms, Knie dB, RMS)
    let (ct, cr, cm, ca, cl, ck, rms) = comp.unwrap_or((-20.0, 2.0, 0.0, 15.0, 150.0, 6.0, true));
    v.insert("compEnabled".into(), json!(comp.is_some()));
    for (k, x) in [("compThreshold", ct), ("compRatio", cr), ("compMakeup", cm), ("compAttack", ca), ("compRelease", cl), ("compKnee", ck)] {
        v.insert(k.into(), json!(x));
    }
    v.insert("compRms".into(), json!(rms));
    // (Schwelle dB, Absenkung dB, Ratio, Attack ms, Hold ms, Release ms, Hysterese dB)
    let (gt, gr, gq, ga, gh, gl, gy) = gate.unwrap_or((-55.0, -30.0, 2.0, 5.0, 80.0, 300.0, 4.0));
    v.insert("gateEnabled".into(), json!(gate.is_some()));
    for (k, x) in [("gateThreshold", gt), ("gateRange", gr), ("gateRatio", gq), ("gateAttack", ga), ("gateHold", gh), ("gateRelease", gl), ("gateHysteresis", gy)] {
        v.insert(k.into(), json!(x));
    }
    Preset { kind: "dyn".into(), name: name.into(), values: v, builtin: true }
}

/// Werkspresets (nur lesbar). Reihenfolge = Anzeige.
pub fn factory() -> Vec<Preset> {
    // Bänder: (Frequenz Hz, Güte Q, Verstärkung dB) — tief, unten-mittel, oben-mittel, hoch
    vec![
        eq("Flat (neutral)", None, [(100.0, 1.0, 0.0), (1000.0, 1.0, 0.0), (3500.0, 1.0, 0.0), (8000.0, 0.7, 0.0)]),
        eq("Rumpelfilter (nur Hochpass 80 Hz)", Some(80.0), [(100.0, 1.0, 0.0), (1000.0, 1.0, 0.0), (3500.0, 1.0, 0.0), (8000.0, 0.7, 0.0)]),
        eq("Sprache männlich", Some(80.0), [(120.0, 1.0, 1.5), (300.0, 1.2, -2.5), (3200.0, 1.0, 3.0), (9000.0, 0.7, 1.5)]),
        eq("Sprache weiblich", Some(100.0), [(200.0, 1.0, -1.5), (500.0, 1.2, -2.0), (3800.0, 1.0, 2.5), (10000.0, 0.7, 2.0)]),
        eq("Sprache Podcast (präsent)", Some(70.0), [(100.0, 0.8, 2.0), (250.0, 1.0, -2.0), (4000.0, 1.0, 3.5), (12000.0, 0.6, 2.5)]),
        eq("Zischlaute mindern", Some(80.0), [(150.0, 1.0, 0.0), (1000.0, 1.0, 0.0), (6500.0, 3.0, -4.0), (9500.0, 2.0, -2.0)]),
        eq("Telefon / Zuspieler", Some(300.0), [(400.0, 1.0, -3.0), (1200.0, 1.0, 4.0), (2500.0, 1.0, 2.0), (6000.0, 0.5, -12.0)]),
        eq("Musik wärmer", None, [(80.0, 0.8, 2.0), (400.0, 1.0, -1.0), (3000.0, 1.0, 0.0), (10000.0, 0.7, 1.5)]),
        dynp("Aus (neutral)", None, None),
        dynp("Sprache sanft (Moderation)", Some((-18.0, 2.5, 3.0, 15.0, 180.0, 8.0, true)), None),
        dynp("Sprache kräftig (Radio)", Some((-22.0, 4.0, 5.0, 8.0, 120.0, 6.0, true)), Some((-52.0, -18.0, 2.0, 4.0, 120.0, 250.0, 4.0))),
        dynp("Mikrofon im halligen Raum (Gate)", Some((-20.0, 3.0, 2.0, 12.0, 160.0, 6.0, true)), Some((-45.0, -25.0, 4.0, 3.0, 150.0, 300.0, 4.0))),
        dynp("Telefon / Gast", Some((-24.0, 5.0, 6.0, 5.0, 100.0, 4.0, true)), Some((-48.0, -20.0, 2.0, 5.0, 100.0, 250.0, 4.0))),
        dynp("Musik leicht (Glue)", Some((-14.0, 1.8, 1.5, 30.0, 250.0, 10.0, true)), None),
        dynp("Spitzen abfangen (Peak)", Some((-6.0, 10.0, 0.0, 1.0, 80.0, 2.0, false)), None),
    ]
}

/// Dateiformat für Export und Import (JSON): `{"format":"omp-audio-presets","version":1,"presets":[{kind,name,values}]}`.
pub const FORMAT: &str = "omp-audio-presets";

/// Eigene Presets als Austauschdokument.
pub fn export_doc(user: &[Preset]) -> Value {
    json!({"format": FORMAT, "version": 1, "presets": user.iter().map(Preset::to_state).collect::<Vec<_>>()})
}

/// Liest ein Austauschdokument vollständig und streng: Format/Version, Art, Name, nur bekannte Schlüssel, nur Zahlen/Wahrheitswerte,
/// keine Werksnamen. Ein Fehler lässt den gesamten Import scheitern (nichts wird halb übernommen). Enthält die Datei einen Namen mehrfach, gilt der letzte.
pub fn parse_import(text: &str) -> Result<Vec<Preset>, String> {
    let doc: Value = serde_json::from_str(text).map_err(|e| format!("keine gültige JSON-Datei: {e}"))?;
    if doc.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(format!("unbekanntes Format (erwartet „{FORMAT}“)"));
    }
    if doc.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("unbekannte Version (unterstützt: 1)".to_string());
    }
    let list = doc.get("presets").and_then(Value::as_array).ok_or("presets fehlt")?;
    if list.len() > 200 {
        return Err("höchstens 200 Presets je Datei".to_string());
    }
    let factory_names: Vec<(String, String)> = factory().into_iter().map(|p| (p.kind, p.name)).collect();
    let mut out: Vec<Preset> = Vec::new();
    for (i, item) in list.iter().enumerate() {
        let at = |m: &str| format!("Eintrag {}: {m}", i + 1);
        let kind = item.get("kind").and_then(Value::as_str).ok_or_else(|| at("kind fehlt"))?;
        let ks = keys(kind).ok_or_else(|| at("kind muss eq oder dyn sein"))?;
        let name = item.get("name").and_then(Value::as_str).ok_or_else(|| at("name fehlt"))?;
        valid_name(name).map_err(|e| at(&e))?;
        if factory_names.iter().any(|(k, n)| k == kind && n == name) {
            return Err(at(&format!("„{name}“ ist ein Werkspreset — in der Datei umbenennen")));
        }
        let values = item.get("values").and_then(Value::as_object).ok_or_else(|| at("values fehlt"))?;
        for (k, v) in values {
            if !ks.contains(&k.as_str()) {
                return Err(at(&format!("unbekannter Parameter „{k}“")));
            }
            if !(v.is_number() || v.is_boolean()) {
                return Err(at(&format!("„{k}“ muss eine Zahl oder ein Wahrheitswert sein")));
            }
        }
        out.retain(|p| !(p.kind == kind && p.name == name));
        out.push(Preset { kind: kind.to_string(), name: name.to_string(), values: values.clone(), builtin: false });
    }
    Ok(out)
}

/// Findet ein Preset (zuerst eigene, dann Werkspresets).
pub fn find(user: &[Preset], kind: &str, name: &str) -> Option<Preset> {
    user.iter().find(|p| p.kind == kind && p.name == name).cloned().or_else(|| factory().into_iter().find(|p| p.kind == kind && p.name == name))
}

/// Liste für die Oberfläche (Werkspresets zuerst).
pub fn list(user: &[Preset]) -> Vec<Value> {
    factory().iter().map(Preset::to_list).chain(user.iter().map(Preset::to_list)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factory_presets_are_complete_and_unique() {
        let f = factory();
        assert!(f.len() >= 14);
        for p in &f {
            let ks = keys(&p.kind).unwrap();
            for k in ks {
                assert!(p.values.contains_key(*k), "{}: {k} fehlt", p.name);
            }
            assert_eq!(p.values.len(), ks.len(), "{}: unbekannte Schlüssel", p.name);
            assert!(p.builtin);
        }
        let mut names: Vec<_> = f.iter().map(|p| (p.kind.clone(), p.name.clone())).collect();
        names.sort();
        let n = names.len();
        names.dedup();
        assert_eq!(n, names.len(), "doppelter Name");
    }

    #[test]
    fn names_are_validated() {
        assert!(valid_name("Mein Moderator").is_ok());
        for bad in ["", " x", "x ", "a\nb", &"x".repeat(41)] {
            assert!(valid_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn export_import_roundtrip_and_strictness() {
        let mut v = Map::new();
        v.insert("eqLow".into(), json!(3.0));
        v.insert("eqHpEnabled".into(), json!(true));
        let user = vec![Preset { kind: "eq".into(), name: "Mein EQ".into(), values: v, builtin: false }];
        let text = export_doc(&user).to_string();
        let back = parse_import(&text).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].values.get("eqLow"), Some(&json!(3.0)));
        let bad = [
            "kein json",
            r#"{"format":"x","version":1,"presets":[]}"#,
            r#"{"format":"omp-audio-presets","version":2,"presets":[]}"#,
            r#"{"format":"omp-audio-presets","version":1,"presets":[{"kind":"zz","name":"a","values":{}}]}"#,
            r#"{"format":"omp-audio-presets","version":1,"presets":[{"kind":"eq","name":"a","values":{"eqGibtsNicht":1}}]}"#,
            r#"{"format":"omp-audio-presets","version":1,"presets":[{"kind":"eq","name":"a","values":{"eqLow":"laut"}}]}"#,
            r#"{"format":"omp-audio-presets","version":1,"presets":[{"kind":"eq","name":"Sprache männlich","values":{}}]}"#,
            r#"{"format":"omp-audio-presets","version":1,"presets":[{"kind":"eq","name":" x","values":{}}]}"#,
        ];
        for b in bad {
            assert!(parse_import(b).is_err(), "{b}");
        }
        // doppelter Name: der letzte gilt
        let dup = r#"{"format":"omp-audio-presets","version":1,"presets":[{"kind":"dyn","name":"a","values":{"compRatio":2}},{"kind":"dyn","name":"a","values":{"compRatio":4}}]}"#;
        let p = parse_import(dup).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].values.get("compRatio"), Some(&json!(4)));
    }

    #[test]
    fn state_roundtrip_and_lookup() {
        let mut v = Map::new();
        v.insert("eqLow".into(), json!(3.0));
        let p = Preset { kind: "eq".into(), name: "Eigenes".into(), values: v, builtin: false };
        let back = Preset::from_state(&p.to_state()).unwrap();
        assert_eq!(back.name, "Eigenes");
        assert!(Preset::from_state(&json!({"kind": "xx", "name": "a", "values": {}})).is_none());
        let user = vec![back];
        assert!(find(&user, "eq", "Eigenes").is_some());
        assert!(find(&user, "eq", "Sprache männlich").is_some());
        assert!(find(&user, "dyn", "Eigenes").is_none());
    }
}
