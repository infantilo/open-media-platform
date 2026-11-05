//! Vorlagen-Bibliothek (Kapitel 90.4): Anlegen, Lesen, Speichern, Duplizieren und Löschen der OGraf-Vorlagen im Verzeichnis
//! `OMP_OGRAF_TEMPLATES`. Grundlage des Editors; die Regeln für das Manifest folgen dem offiziellen JSON-Schema
//! `https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json` (gelesen 2026-11-05): Pflicht sind `$schema`, `id`,
//! `name`, `main`, `supportsRealTime`, `supportsNonRealTime`; weitere Felder nur aus der Liste in `ALLOWED_KEYS` oder mit
//! Präfix `v_`. Importierte ältere Vorlagen tragen Zusatzfelder (`designWidth`, `designHeight`): das ist eine Warnung, kein Fehler.
//!
//! Ein Paket ist ein flaches Verzeichnis (Manifest `<id>.ograf.json`, Hauptmodul, optional Text- und Binärdateien).
//! Binärdateien (Bilder, Schriften) laufen als Text `base64:<Daten>` durch die JSON-Schnittstelle (`BINARY_EXT`). Geschrieben wird atomar (Zwischenverzeichnis, dann Umbenennen).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

pub const SCHEMA_URL: &str = "https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json";
const MAX_FILES: usize = 60;
const MAX_FILE_BYTES: usize = 512 * 1024;
const MAX_BINARY_BYTES: usize = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const TEXT_EXT: [&str; 7] = ["js", "mjs", "json", "css", "svg", "html", "txt"];
/// Binärdateien (Bilder, Schriften) laufen als Text `base64:<Daten>` durch die JSON-Schnittstelle.
const BINARY_EXT: [&str; 8] = ["png", "jpg", "jpeg", "webp", "gif", "woff", "woff2", "ttf"];
pub const BINARY_PREFIX: &str = "base64:";

fn ext_of(n: &str) -> String {
    Path::new(n).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

pub fn is_binary(n: &str) -> bool {
    BINARY_EXT.contains(&ext_of(n).as_str())
}

/// Größe in Bytes, wie sie auf der Platte läge (Binärdateien: nach dem Dekodieren).
fn byte_len(n: &str, content: &str) -> Result<usize, String> {
    if !is_binary(n) {
        return Ok(content.len());
    }
    decode_binary(content).map(|b| b.len())
}

fn decode_binary(content: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let data = content.strip_prefix(BINARY_PREFIX).ok_or_else(|| "Binärdatei muss mit „base64:“ beginnen".to_string())?;
    base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| format!("base64: {e}"))
}

fn encode_binary(bytes: &[u8]) -> String {
    use base64::Engine;
    format!("{BINARY_PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}
/// Laut Schema erlaubte Felder oberhalb von `v_*`.
const ALLOWED_KEYS: [&str; 14] = [
    "$schema", "id", "name", "main", "supportsRealTime", "supportsNonRealTime", "version", "stepCount", "author",
    "customActions", "schema", "renderRequirements", "thumbnails", "description",
];
const ALLOWED_KEYS_2: [&str; 1] = ["actionDurations"];
/// Aus dem Vorgängersystem importierte Felder: geduldet, aber gemeldet.
const TOLERATED_KEYS: [&str; 2] = ["designWidth", "designHeight"];

pub type Files = BTreeMap<String, String>;

/// Gültige Paket-ID (= Verzeichnisname = Manifest-`id`): Kleinbuchstaben, Ziffern, Bindestrich.
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn valid_file_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 80
        && !n.starts_with('.')
        && n.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        && (TEXT_EXT.contains(&ext_of(n).as_str()) || is_binary(n))
}

/// Ergebnis der Prüfung eines Pakets.
#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

fn manifest_name(files: &Files) -> Option<&String> {
    files.keys().find(|n| n.ends_with(".ograf.json"))
}

/// Prüft ein Paket gegen die Regeln dieser Datei (ohne Dateisystem).
pub fn check(id: &str, files: &Files) -> Report {
    let mut r = Report::default();
    if !valid_id(id) {
        r.errors.push("id: nur Kleinbuchstaben, Ziffern und Bindestrich (max. 63 Zeichen)".into());
    }
    if files.len() > MAX_FILES {
        r.errors.push(format!("zu viele Dateien (max. {MAX_FILES})"));
    }
    let mut total = 0usize;
    for (n, c) in files {
        if !valid_file_name(n) {
            r.errors.push(format!(
                "Dateiname „{n}“ ungültig (flach, Buchstaben/Ziffern/._-, Endung {} oder {})",
                TEXT_EXT.join("/"),
                BINARY_EXT.join("/")
            ));
        }
        match byte_len(n, c) {
            Ok(len) => {
                let max = if is_binary(n) { MAX_BINARY_BYTES } else { MAX_FILE_BYTES };
                if len > max {
                    r.errors.push(format!("Datei „{n}“ zu groß (max. {} KB)", max / 1024));
                }
                total += len;
            }
            Err(e) => r.errors.push(format!("Datei „{n}“: {e}")),
        }
    }
    if total > MAX_TOTAL_BYTES {
        r.errors.push(format!("Paket zu groß (max. {} MB)", MAX_TOTAL_BYTES / 1024 / 1024));
    }
    let manifests: Vec<&String> = files.keys().filter(|n| n.ends_with(".ograf.json")).collect();
    if manifests.len() != 1 {
        r.errors.push(format!("genau ein Manifest (*.ograf.json) nötig, gefunden: {}", manifests.len()));
        return r;
    }
    let Some(raw) = manifest_name(files).and_then(|n| files.get(n)) else { return r };
    let m: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            r.errors.push(format!("Manifest ist kein gültiges JSON: {e}"));
            return r;
        }
    };
    let Some(obj) = m.as_object() else {
        r.errors.push("Manifest muss ein JSON-Objekt sein".into());
        return r;
    };
    if obj.get("$schema").and_then(Value::as_str) != Some(SCHEMA_URL) {
        r.errors.push(format!("$schema muss {SCHEMA_URL} sein"));
    }
    match obj.get("id").and_then(Value::as_str) {
        Some(mid) if mid == id => {}
        Some(mid) => r.errors.push(format!("Manifest-id „{mid}“ stimmt nicht mit der Paket-ID „{id}“ überein")),
        None => r.errors.push("id fehlt".into()),
    }
    if obj.get("name").and_then(Value::as_str).is_none_or(|s| s.trim().is_empty()) {
        r.errors.push("name fehlt".into());
    }
    match obj.get("main").and_then(Value::as_str) {
        Some(main) if files.contains_key(main) => {
            if files[main].trim().is_empty() {
                r.errors.push(format!("Hauptmodul „{main}“ ist leer"));
            }
        }
        Some(main) => r.errors.push(format!("main „{main}“ ist nicht im Paket")),
        None => r.errors.push("main fehlt".into()),
    }
    for k in ["supportsRealTime", "supportsNonRealTime"] {
        if obj.get(k).and_then(Value::as_bool).is_none() {
            r.errors.push(format!("{k} fehlt (true/false)"));
        }
    }
    if let Some(v) = obj.get("stepCount") {
        match v.as_i64() {
            Some(n) if n >= -1 => {}
            _ => r.errors.push("stepCount: ganze Zahl ≥ −1".into()),
        }
    }
    if let Some(v) = obj.get("version")
        && !v.is_string()
    {
        r.errors.push("version muss Text sein".into());
    }
    if let Some(v) = obj.get("schema")
        && !v.is_object()
    {
        r.errors.push("schema muss ein Objekt sein".into());
    }
    if let Some(a) = obj.get("author") {
        if a.get("name").and_then(Value::as_str).is_none() {
            r.errors.push("author.name fehlt".into());
        }
    }
    if let Some(sc) = obj.get("schema") {
        check_gdd(sc, "schema", true, &mut r);
    }
    for (key, val) in [("renderRequirements", obj.get("renderRequirements")), ("thumbnails", obj.get("thumbnails")), ("actionDurations", obj.get("actionDurations"))] {
        if let Some(v) = val {
            check_list_fields(key, v, &mut r);
        }
    }
    if let Some(list) = obj.get("thumbnails").and_then(Value::as_array) {
        for (i, t) in list.iter().enumerate() {
            if let Some(f) = t.get("file").and_then(Value::as_str)
                && !files.contains_key(f)
            {
                r.errors.push(format!("thumbnails[{i}]: Datei „{f}“ ist nicht im Paket"));
            }
        }
    }
    if let Some(ca) = obj.get("customActions") {
        match ca.as_array() {
            None => r.errors.push("customActions muss eine Liste sein".into()),
            Some(list) => {
                let mut seen: Vec<&str> = Vec::new();
                for (i, a) in list.iter().enumerate() {
                    let id = a.get("id").and_then(Value::as_str).unwrap_or("");
                    if id.is_empty() || a.get("name").and_then(Value::as_str).is_none() {
                        r.errors.push(format!("customActions[{i}]: id und name sind Pflicht"));
                    } else if seen.contains(&id) {
                        r.errors.push(format!("customActions: id „{id}“ doppelt"));
                    } else {
                        seen.push(id);
                    }
                    if let Some(o) = a.as_object() {
                        for k in o.keys() {
                            if !["id", "name", "description", "schema"].contains(&k.as_str()) && !k.starts_with("v_") {
                                r.errors.push(format!("customActions[{i}]: Feld „{k}“ ist im Schema nicht erlaubt"));
                            }
                        }
                    }
                }
            }
        }
    }
    for k in obj.keys() {
        let known = ALLOWED_KEYS.contains(&k.as_str()) || ALLOWED_KEYS_2.contains(&k.as_str()) || k.starts_with("v_");
        if !known {
            if TOLERATED_KEYS.contains(&k.as_str()) {
                r.warnings.push(format!("Feld „{k}“ steht nicht im OGraf-v1-Schema (aus einem älteren System übernommen)"));
            } else {
                r.errors.push(format!("Feld „{k}“ ist im OGraf-v1-Schema nicht erlaubt (Erweiterungen mit Präfix v_)"));
            }
        }
    }
    r
}

const GDD_TYPES: [&str; 6] = ["boolean", "string", "number", "integer", "array", "object"];
const GDD_KINDS: [&str; 10] = [
    "single-line", "multi-line", "file-path", "file-path/image-path", "select", "select-multiple", "color-rrggbb", "color-rrggbbaa", "percentage", "duration-ms",
];

/// Prüft ein Parameter-Schema nach `gdd/object.json` + `gdd/gdd-types.json` (gelesen 2026-11-05): jede Eigenschaft braucht `type` aus
/// der Liste; `gddType` nur aus den zehn bekannten Werten und passend zum Grundtyp; Farben mit dem vorgeschriebenen Muster; `select` mit
/// `enum` und `gddOptions`. Abweichungen sind **Hinweise** (ältere Importe halten sich nicht daran), nur ein kaputter Aufbau ist ein Fehler.
fn check_gdd(node: &Value, path: &str, top: bool, r: &mut Report) {
    let Some(o) = node.as_object() else {
        r.errors.push(format!("{path}: muss ein Objekt sein"));
        return;
    };
    let ty = o.get("type").and_then(Value::as_str);
    match ty {
        None => r.warnings.push(format!("{path}: „type“ fehlt (Pflicht im GDD-Schema)")),
        Some(t) if !GDD_TYPES.contains(&t) => r.warnings.push(format!("{path}: type „{t}“ ist kein GDD-Typ")),
        _ => {}
    }
    if top && ty.is_some_and(|t| t != "object") {
        r.warnings.push(format!("{path}: das Parameter-Schema sollte type „object“ haben"));
    }
    if let Some(h) = o.get("hidden")
        && !h.is_boolean()
    {
        r.warnings.push(format!("{path}: hidden muss ja/nein sein"));
    }
    if let Some(n) = o.get("order")
        && !n.is_number()
    {
        r.warnings.push(format!("{path}: order muss eine Zahl sein"));
    }
    if let Some(g) = o.get("gddType") {
        match g.as_str() {
            Some(k) if GDD_KINDS.contains(&k) => {
                let want: &[&str] = match k {
                    "single-line" | "multi-line" | "file-path" | "file-path/image-path" | "color-rrggbb" | "color-rrggbbaa" => &["string"],
                    "select" => &["string", "number", "integer"],
                    "select-multiple" => &["array"],
                    "percentage" => &["number"],
                    _ => &["integer"], // duration-ms
                };
                if let Some(t) = ty
                    && !want.contains(&t)
                {
                    r.warnings.push(format!("{path}: gddType „{k}“ gehört zu type {}", want.join("/")));
                }
                let pattern = o.get("pattern").and_then(Value::as_str);
                if k == "color-rrggbb" && pattern != Some("^#[0-9a-f]{6}$") {
                    r.warnings.push(format!("{path}: color-rrggbb braucht pattern „^#[0-9a-f]{{6}}$“"));
                }
                if k == "color-rrggbbaa" && pattern != Some("^#[0-9a-f]{8}$") {
                    r.warnings.push(format!("{path}: color-rrggbbaa braucht pattern „^#[0-9a-f]{{8}}$“"));
                }
                if k == "select" && (!o.get("enum").is_some_and(Value::is_array) || !o.get("gddOptions").is_some_and(Value::is_object)) {
                    r.warnings.push(format!("{path}: select braucht enum und gddOptions"));
                }
            }
            Some(k) => r.warnings.push(format!("{path}: gddType „{k}“ ist nicht definiert")),
            None => r.warnings.push(format!("{path}: gddType muss Text sein")),
        }
    }
    if let Some(e) = o.get("enum")
        && !e.is_array()
    {
        r.errors.push(format!("{path}: enum muss eine Liste sein"));
    }
    match o.get("properties") {
        Some(Value::Object(props)) => {
            for (k, v) in props {
                check_gdd(v, &format!("{path}.{k}"), false, r);
            }
        }
        Some(_) => r.errors.push(format!("{path}: properties muss ein Objekt sein")),
        None => {}
    }
    if let Some(items) = o.get("items") {
        check_gdd(items, &format!("{path}[]"), false, r);
    }
}

/// `renderRequirements`, `thumbnails`, `actionDurations`: Listen von Objekten mit den Pflichtfeldern des Schemas.
fn check_list_fields(key: &str, v: &Value, r: &mut Report) {
    let Some(list) = v.as_array() else {
        r.errors.push(format!("{key} muss eine Liste sein"));
        return;
    };
    for (i, item) in list.iter().enumerate() {
        let Some(o) = item.as_object() else {
            r.errors.push(format!("{key}[{i}] muss ein Objekt sein"));
            continue;
        };
        let (allowed, required): (&[&str], &[&str]) = match key {
            "renderRequirements" => (&["resolution", "frameRate", "accessToPublicInternet", "engine"], &[]),
            "thumbnails" => (&["file", "resolution"], &["file"]),
            _ => (&["type", "duration"], &["type", "duration"]),
        };
        for k in required {
            if !o.contains_key(*k) {
                r.errors.push(format!("{key}[{i}]: „{k}“ fehlt"));
            }
        }
        for k in o.keys() {
            if !allowed.contains(&k.as_str()) && !k.starts_with("v_") {
                r.errors.push(format!("{key}[{i}]: Feld „{k}“ ist im Schema nicht erlaubt"));
            }
        }
        if key == "actionDurations" {
            if let Some(t) = o.get("type").and_then(Value::as_str)
                && !["playAction", "updateAction", "stopAction", "customAction"].contains(&t)
            {
                r.errors.push(format!("{key}[{i}]: type „{t}“ unbekannt"));
            }
            if o.get("duration").and_then(Value::as_i64).is_none_or(|d| d < -1) {
                r.errors.push(format!("{key}[{i}]: duration muss eine ganze Zahl ≥ −1 sein"));
            }
        }
    }
}

fn pkg_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("ungültige Paket-ID".into());
    }
    Ok(root.join(id))
}

fn read_dir_files(dir: &Path) -> Files {
    let mut out = Files::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p.is_file() && valid_file_name(&name) {
            if is_binary(&name) {
                if let Ok(bytes) = std::fs::read(&p) {
                    out.insert(name, encode_binary(&bytes));
                }
            } else if let Ok(text) = std::fs::read_to_string(&p) {
                out.insert(name, text);
            }
        }
    }
    out
}

/// Übersicht aller Pakete (auch fehlerhafter) für die Bibliotheksliste.
pub fn list(root: &Path) -> Value {
    let mut items = Vec::new();
    for e in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !e.path().is_dir() {
            continue;
        }
        let files = read_dir_files(&e.path());
        let rep = check(&name, &files);
        let label = manifest_name(&files)
            .and_then(|n| serde_json::from_str::<Value>(&files[n]).ok())
            .and_then(|m| m.get("name").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| name.clone());
        items.push(json!({
            "id": name, "label": label, "valid": rep.errors.is_empty(), "errors": rep.errors, "warnings": rep.warnings,
            "files": files.keys().collect::<Vec<_>>(),
        }));
    }
    items.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Value::Array(items)
}

/// Dateien eines Pakets samt Prüfergebnis.
pub fn read(root: &Path, id: &str) -> Option<Value> {
    let dir = pkg_dir(root, id).ok()?;
    if !dir.is_dir() {
        return None;
    }
    let files = read_dir_files(&dir);
    let rep = check(id, &files);
    Some(json!({ "id": id, "files": files, "errors": rep.errors, "warnings": rep.warnings }))
}

/// Speichert ein Paket atomar (ersetzt ein vorhandenes). Fehler: Text mit allen Prüfmeldungen.
pub fn save(root: &Path, id: &str, files: &Files) -> Result<Report, String> {
    let rep = check(id, files);
    if !rep.errors.is_empty() {
        return Err(rep.errors.join("; "));
    }
    let target = pkg_dir(root, id)?;
    let pid = std::process::id();
    let tmp = root.join(format!(".tmp-{id}-{pid}"));
    let old = root.join(format!(".old-{id}-{pid}"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("anlegen: {e}"))?;
    for (n, c) in files {
        let written = if is_binary(n) { decode_binary(c).and_then(|b| std::fs::write(tmp.join(n), b).map_err(|e| e.to_string())) } else { std::fs::write(tmp.join(n), c).map_err(|e| e.to_string()) };
        if let Err(e) = written {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("schreiben „{n}“: {e}"));
        }
    }
    // Dateien aus dem alten Paket, die nicht mehr im neuen sind (z. B. Bilder), bleiben bewusst nicht erhalten: Paket = Inhalt.
    let had = target.exists();
    if had && let Err(e) = std::fs::rename(&target, &old) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("ersetzen: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, &target) {
        if had {
            let _ = std::fs::rename(&old, &target);
        }
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("ersetzen: {e}"));
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(rep)
}

/// Kopiert ein Paket unter neuer ID (Manifest-`id`, Manifest-Dateiname und Titel werden angepasst).
pub fn duplicate(root: &Path, from: &str, to: &str) -> Result<(), String> {
    if !valid_id(to) {
        return Err("ungültige neue ID".into());
    }
    if pkg_dir(root, to)?.exists() {
        return Err(format!("Paket „{to}“ existiert schon"));
    }
    let src = read_dir_files(&pkg_dir(root, from)?);
    let Some(mname) = manifest_name(&src).cloned() else { return Err("Quelle hat kein Manifest".into()) };
    let mut m: Value = serde_json::from_str(&src[&mname]).map_err(|e| format!("Manifest: {e}"))?;
    let new_name = format!("{} (Kopie)", m["name"].as_str().unwrap_or(from));
    m["id"] = json!(to);
    m["name"] = json!(new_name);
    m["$schema"] = json!(SCHEMA_URL);
    let mut files = src.clone();
    files.remove(&mname);
    files.insert(format!("{to}.ograf.json"), serde_json::to_string_pretty(&m).unwrap_or_default());
    save(root, to, &files).map(|_| ())
}

pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    let dir = pkg_dir(root, id)?;
    if !dir.is_dir() {
        return Err("Paket nicht gefunden".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("löschen: {e}"))
}

/// Neues Paket aus dem Mindestgerüst (ein Textfeld, ein Parameter), sofort lauffähig.
pub fn skeleton(id: &str, name: &str) -> Files {
    let manifest = json!({
        "$schema": SCHEMA_URL, "id": id, "name": name, "version": "1.0.0", "main": format!("{id}.js"),
        "supportsRealTime": true, "supportsNonRealTime": false, "stepCount": 1,
        "schema": { "type": "object", "properties": { "text": { "type": "string", "title": "Text", "default": "Hallo" } } },
    });
    let js = r#"export default class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{position:fixed;inset:0;opacity:0;transition:opacity 300ms}:host(.in){opacity:1}
.t{position:absolute;left:8%;bottom:10%;padding:12px 24px;background:#10151f;color:#fff;font:600 44px system-ui,sans-serif;border-left:8px solid #00c8ff}</style><div class="t"></div>`;
    this._t = root.querySelector(".t");
  }
  _apply(d) { if (d && d.text !== undefined) this._t.textContent = d.text; }
  async load(p) { this._apply(p && p.data); return { statusCode: 200 }; }
  async dispose() { this.shadowRoot.innerHTML = ""; return { statusCode: 200 }; }
  async playAction() { this.classList.add("in"); return { statusCode: 200, currentStep: 0 }; }
  async stopAction() { this.classList.remove("in"); return { statusCode: 200 }; }
  async updateAction(p) { this._apply(p && p.data); return { statusCode: 200 }; }
  async customAction() { return { statusCode: 200 }; }
}
"#;
    let mut f = Files::new();
    f.insert(format!("{id}.ograf.json"), serde_json::to_string_pretty(&manifest).unwrap_or_default());
    f.insert(format!("{id}.js"), js.to_string());
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("omp-ograf-lib-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn skeleton_is_valid_and_ids_are_checked() {
        let f = skeleton("mein-titel", "Mein Titel");
        assert_eq!(check("mein-titel", &f), Report::default());
        assert!(valid_id("a-1") && !valid_id("A") && !valid_id("a_b") && !valid_id("-a") && !valid_id(""));
        assert!(!check("anders", &f).errors.is_empty()); // id-Abweichung
    }

    #[test]
    fn rules_follow_the_official_schema() {
        let mut f = skeleton("t", "T");
        let mut m: Value = serde_json::from_str(&f["t.ograf.json"]).unwrap();
        m.as_object_mut().unwrap().remove("supportsNonRealTime");
        m["main"] = json!("fehlt.js");
        m["unbekannt"] = json!(1);
        m["designWidth"] = json!(1920);
        m["v_eigen"] = json!(true);
        f.insert("t.ograf.json".into(), m.to_string());
        let r = check("t", &f);
        assert!(r.errors.iter().any(|e| e.contains("supportsNonRealTime")));
        assert!(r.errors.iter().any(|e| e.contains("main")));
        assert!(r.errors.iter().any(|e| e.contains("unbekannt")));
        assert!(!r.errors.iter().any(|e| e.contains("v_eigen") || e.contains("designWidth")));
        assert!(r.warnings.iter().any(|w| w.contains("designWidth")));
        f.insert("../x.js".into(), "1".into());
        assert!(check("t", &f).errors.iter().any(|e| e.contains("Dateiname")));
    }

    #[test]
    fn save_read_duplicate_delete_roundtrip_and_replaces_atomically() {
        let root = tmp("rt");
        let f = skeleton("a", "A");
        assert!(save(&root, "a", &f).unwrap().errors.is_empty());
        let got = read(&root, "a").unwrap();
        assert_eq!(got["files"]["a.js"], f["a.js"]);
        // Ersetzen: Datei weg, die nicht mehr im Paket ist
        let mut f2 = f.clone();
        f2.insert("extra.css".into(), "x{}".into());
        save(&root, "a", &f2).unwrap();
        assert!(read(&root, "a").unwrap()["files"]["extra.css"].is_string());
        save(&root, "a", &f).unwrap();
        assert!(read(&root, "a").unwrap()["files"]["extra.css"].is_null());
        // Duplizieren
        duplicate(&root, "a", "b").unwrap();
        let b = read(&root, "b").unwrap();
        assert!(b["errors"].as_array().unwrap().is_empty());
        assert!(b["files"]["b.ograf.json"].as_str().unwrap().contains("A (Kopie)"));
        assert!(duplicate(&root, "a", "b").is_err()); // existiert
        assert!(duplicate(&root, "a", "B!").is_err());
        let l = list(&root);
        assert_eq!(l.as_array().unwrap().len(), 2);
        assert!(l[0]["valid"].as_bool().unwrap());
        delete(&root, "a").unwrap();
        assert!(read(&root, "a").is_none());
        assert!(delete(&root, "a").is_err());
        // ungültig speichern ändert nichts
        let mut bad = f.clone();
        bad.remove("a.js");
        assert!(save(&root, "b", &bad).is_err());
        assert!(read(&root, "b").unwrap()["errors"].as_array().unwrap().is_empty());
        assert!(std::fs::read_dir(&root).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with('.')));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn schema_follows_the_gdd_types() {
        let mut f = skeleton("a", "A");
        let mut m: Value = serde_json::from_str(&f["a.ograf.json"]).unwrap();
        m["schema"] = json!({"type": "object", "properties": {
            "c": {"type": "string", "gddType": "color-rrggbb", "pattern": "^#[0-9a-f]{6}$", "default": "#ffffff"},
            "d": {"type": "integer", "gddType": "duration-ms"},
            "s": {"type": "string", "enum": ["a", "b"]},
            "arr": {"type": "array", "items": {"type": "string"}, "gddType": "select-multiple"},
        }});
        f.insert("a.ograf.json".into(), m.to_string());
        let r = check("a", &f);
        assert!(r.errors.is_empty() && r.warnings.iter().all(|w| w.contains("select-multiple")), "{r:?}");
        m["schema"] = json!({"type": "object", "properties": {
            "c": {"type": "string", "gddType": "color-rrggbb", "pattern": "^#[0-9a-fA-F]{6}$"},
            "x": {"gddType": "bogus"},
            "n": {"type": "string", "gddType": "percentage"},
            "q": {"type": "kaputt"},
        }});
        f.insert("a.ograf.json".into(), m.to_string());
        let w = check("a", &f).warnings.join("|");
        assert!(w.contains("schema.c") && w.contains("pattern"), "{w}");
        assert!(w.contains("schema.x: „type“ fehlt") && w.contains("bogus") && w.contains("schema.n: gddType „percentage“") && w.contains("kein GDD-Typ"), "{w}");
        m["schema"] = json!({"type": "object", "properties": {"p": {"type": "string", "enum": "nope"}}});
        f.insert("a.ograf.json".into(), m.to_string());
        assert!(check("a", &f).errors.iter().any(|e| e.contains("enum muss eine Liste")));
    }

    #[test]
    fn nested_lists_and_thumbnails_are_checked() {
        let mut f = skeleton("a", "A");
        let mut m: Value = serde_json::from_str(&f["a.ograf.json"]).unwrap();
        m["thumbnails"] = json!([{"file": "t.png"}]);
        m["actionDurations"] = json!([{"type": "playAction", "duration": 500}]);
        m["renderRequirements"] = json!([{"resolution": {"width": {"ideal": 1920}}}]);
        f.insert("a.ograf.json".into(), m.to_string());
        let e = check("a", &f).errors.join("|");
        assert!(e.contains("nicht im Paket"), "{e}");
        f.insert("t.png".into(), "base64:AAAA".into());
        assert!(check("a", &f).errors.is_empty());
        m["actionDurations"] = json!([{"type": "x", "duration": -5}, {"type": "stopAction"}]);
        m["renderRequirements"] = json!([{"bogus": 1}]);
        f.insert("a.ograf.json".into(), m.to_string());
        let e = check("a", &f).errors.join("|");
        assert!(e.contains("unbekannt") && e.contains("duration") && e.contains("bogus"), "{e}");
    }

    #[test]
    #[ignore = "liest das echte Vorlagenverzeichnis (data/ograf-templates), nur zur Sichtung"]
    fn survey_real_templates() {
        let root = std::path::Path::new("../../data/ograf-templates");
        let list = list(root);
        let items = list.as_array().unwrap();
        let (mut bad, mut warn) = (0, 0);
        for e in items {
            if !e["valid"].as_bool().unwrap() {
                bad += 1;
                println!("FEHLER {}: {}", e["id"], e["errors"]);
            }
            if !e["warnings"].as_array().unwrap().is_empty() {
                warn += 1;
            }
        }
        println!("{} Pakete, {} mit Fehlern, {} mit Hinweisen", items.len(), bad, warn);
    }

    #[test]
    fn custom_actions_follow_the_action_schema() {
        let mut f = skeleton("a", "A");
        let mut m: Value = serde_json::from_str(&f["a.ograf.json"]).unwrap();
        m["customActions"] = json!([{"id": "pulse", "name": "Puls", "description": "x", "schema": null}]);
        f.insert("a.ograf.json".into(), m.to_string());
        assert!(check("a", &f).errors.is_empty());
        m["customActions"] = json!([{"id": "p", "name": "P"}, {"id": "p", "name": "Q"}, {"name": "ohne id"}, {"id": "x", "name": "X", "bogus": 1}]);
        f.insert("a.ograf.json".into(), m.to_string());
        let e = check("a", &f).errors.join("|");
        assert!(e.contains("doppelt") && e.contains("Pflicht") && e.contains("bogus"), "{e}");
        m["customActions"] = json!("kaputt");
        f.insert("a.ograf.json".into(), m.to_string());
        assert!(check("a", &f).errors.iter().any(|e| e.contains("Liste")));
    }

    #[test]
    fn binary_files_roundtrip_as_base64_and_are_checked() {
        let root = tmp("bin");
        let mut f = skeleton("b", "B");
        let png = [0x89u8, b'P', b'N', b'G', 0, 1, 2, 255];
        f.insert("logo.png".into(), encode_binary(&png));
        assert!(save(&root, "b", &f).is_ok());
        assert_eq!(std::fs::read(root.join("b").join("logo.png")).unwrap(), png);
        let got = read(&root, "b").unwrap();
        assert_eq!(got["files"]["logo.png"], encode_binary(&png));
        assert!(got["errors"].as_array().unwrap().is_empty());
        let mut bad = f.clone();
        bad.insert("kaputt.png".into(), "kein base64".into());
        assert!(check("b", &bad).errors.iter().any(|e| e.contains("base64")));
        bad.insert("kaputt.png".into(), format!("{BINARY_PREFIX}!!!"));
        assert!(check("b", &bad).errors.iter().any(|e| e.contains("kaputt.png")));
        let mut big = f.clone();
        big.insert("gross.png".into(), encode_binary(&vec![0u8; MAX_BINARY_BYTES + 1]));
        assert!(check("b", &big).errors.iter().any(|e| e.contains("zu groß")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn broken_packages_are_listed_with_errors() {
        let root = tmp("broken");
        std::fs::create_dir_all(root.join("kaputt")).unwrap();
        std::fs::write(root.join("kaputt").join("kaputt.ograf.json"), "{").unwrap();
        let l = list(&root);
        assert!(!l[0]["valid"].as_bool().unwrap());
        assert!(l[0]["errors"][0].as_str().unwrap().contains("JSON"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
