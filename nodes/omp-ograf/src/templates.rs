//! Template-Scan + Auslieferung (K5-Teil-1, `docs/END-GOAL-FEATURES.md`
//! §5.3): jedes Unterverzeichnis von `OMP_OGRAF_TEMPLATES` mit genau
//! einer `*.ograf.json`-Manifest-Datei (EBU-OGraf-v1, `main` = ES-Modul
//! mit `default export`-Klasse, `schema` = JSON-Schema der Parameter) ist
//! ein Template. Dateinamen-Konvention variiert real (`<slug>.ograf.json`
//! oder `manifest.ograf.json`, per Live-Test an echten PIPELINE-
//! CONTROLLER-Templates im K5-Teil-0-Spike beobachtet, `docs/
//! decisions.md` 2026-07-15) — deshalb Glob auf die Endung, nicht auf
//! einen festen Dateinamen.
//!
//! Auslieferung über `ParamStore::extra_route` (kein zweiter HTTP-Server
//! nötig — derselbe Descriptor-Server, der auch `/ui/manifest.json`
//! anderer Nodes bedient, s. `omp-node-sdk/src/server.rs`): `wpesrc`
//! lädt die Harness-Seite und jedes Template-Modul über diesen Node-
//! internen Port, ohne Auth (node-lokal, gleiche Begründung wie
//! `omp-audio-mixer::levels`).

use std::path::{Path, PathBuf};

use omp_node_sdk::RawResponse;
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct TemplateInfo {
    pub id: String,
    pub label: String,
    pub step_count: u32,
    pub schema: Value,
    /// `customActions` des Manifests (Liste `{id, name, …}`), leer wenn keine.
    pub actions: Value,
    /// `v_omp_zones` des Manifests (Vendor-Feld nach OGraf v1, Präfix `v_`): Liste `{id, name, slot?}` der Layout-Zonen, leer wenn keine.
    pub zones: Value,
    /// Verzeichnisname relativ zu `OMP_OGRAF_TEMPLATES` — Teil der
    /// Modul-URL (`/ograf-templates/<dir>/<main>`), nicht Teil des
    /// Descriptor-Werts (der Bildmeister braucht nur `id`/`label`, keine
    /// Dateisystem-Details, §5.3).
    dir: String,
    main: String,
}

impl TemplateInfo {
    #[cfg(test)]
    pub fn for_test(id: &str, step_count: u32) -> Self {
        TemplateInfo {
            id: id.to_string(),
            label: id.to_string(),
            step_count,
            schema: Value::Null,
            actions: Value::Array(vec![]),
            zones: Value::Array(vec![]),
            dir: id.to_string(),
            main: "main.js".to_string(),
        }
    }

    /// Verzeichnisname des Pakets (kann von der Manifest-`id` älterer Importe abweichen).
    pub fn dir_name(&self) -> &str {
        &self.dir
    }

    pub fn to_descriptor_json(&self) -> Value {
        serde_json::json!({
            "id": self.id,
            "label": self.label,
            "stepCount": self.step_count,
            "schema": self.schema,
            "actions": self.actions,
            "zones": self.zones,
        })
    }
}

/// Scannt `root` (nicht rekursiv — ein Template ist genau ein
/// Unterverzeichnis) nach `*.ograf.json`-Manifesten. Ein defektes
/// einzelnes Manifest überspringt nur dieses Template (mit `eprintln!`)
/// statt den ganzen Scan abzubrechen — ein Tippfehler in einem der
/// potenziell ~45 Templates soll nicht alle anderen unerreichbar machen.
pub fn scan_templates(root: &Path) -> Vec<TemplateInfo> {
    let mut templates = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return templates;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().into_owned();
        if dir_name.starts_with('.') {
            continue; // Zwischenverzeichnisse der Bibliothek (library.rs)
        }
        let Some(manifest_path) = find_manifest(&path) else {
            continue;
        };
        match load_manifest(&manifest_path, &dir_name) {
            Ok(info) => templates.push(info),
            Err(e) => eprintln!("omp-ograf: Template '{dir_name}' übersprungen: {e}"),
        }
    }
    templates.sort_by(|a, b| a.id.cmp(&b.id));
    templates
}

fn find_manifest(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    entries
        .flatten()
        .map(|e| e.path())
        .find(|p| p.is_file() && p.to_string_lossy().ends_with(".ograf.json"))
}

fn load_manifest(path: &Path, dir_name: &str) -> Result<TemplateInfo, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("lesen: {e}"))?;
    let json: Value = serde_json::from_str(&raw).map_err(|e| format!("JSON parsen: {e}"))?;
    let id = json["id"].as_str().ok_or("Feld 'id' fehlt")?.to_string();
    let label = json["name"].as_str().unwrap_or(&id).to_string();
    let main = json["main"]
        .as_str()
        .ok_or("Feld 'main' fehlt")?
        .to_string();
    let step_count = json["stepCount"].as_u64().unwrap_or(1) as u32;
    let schema = json["schema"].clone();
    let actions = if json["customActions"].is_array() { json["customActions"].clone() } else { Value::Array(vec![]) };
    let zones = if json["v_omp_zones"].is_array() { json["v_omp_zones"].clone() } else { Value::Array(vec![]) };
    Ok(TemplateInfo {
        id,
        label,
        step_count,
        schema,
        actions,
        zones,
        dir: dir_name.to_string(),
        main,
    })
}

/// Extrahiert die im Schema hinterlegten Default-Werte pro Feld (K5-Teil-
/// 0-Formfund: die Harness braucht sie beim ersten `show()`, falls der
/// Aufrufer kein `data` mitschickt — ein Template ohne Pflichtfeld-Wert
/// würde sonst mit `undefined` rendern statt mit sinnvollen Werten).
pub fn schema_defaults(schema: &Value) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(props) = schema.get("properties").and_then(Value::as_object) {
        for (key, prop) in props {
            if let Some(default) = prop.get("default") {
                out.insert(key.clone(), default.clone());
            }
        }
    }
    Value::Object(out)
}

/// Traversal-Schutz identisch zum bereits etablierten Muster in
/// `omp-player::resolve_media_path` (`docs/decisions.md`/`UMSETZUNG.md`
/// K2-Teil-1) — `canonicalize()` + `starts_with()`-Prüfung gegen die
/// Root, kein eigenes Verfahren erfunden.
fn resolve_under_root(root: &Path, rel: &str) -> Option<PathBuf> {
    let candidate = root.join(rel);
    let canonical = candidate.canonicalize().ok()?;
    let canonical_root = root.canonicalize().ok()?;
    if !canonical.starts_with(&canonical_root) {
        return None;
    }
    Some(canonical)
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("js" | "mjs") => "text/javascript",
        Some("json") => "application/json",
        Some("css") => "text/css",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    }
}

/// Mitgelieferte Rahmen-Vorlage für den Paternoster (Kapitel 90.3): wird beim Start geschrieben, falls noch keine liegt
/// (das Datenverzeichnis ist nicht Teil des Repositories).
pub fn ensure_builtin_paternoster_frame(templates_root: &Path) {
    let dir = templates_root.join("paternoster-frame");
    if dir.join("paternoster-frame.ograf.json").exists() {
        upgrade_builtin(&dir, "paternoster-frame", include_str!("../builtin/paternoster-frame/paternoster-frame.ograf.json"), include_str!("../builtin/paternoster-frame/paternoster-frame.js"));
        return;
    }
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(dir.join("paternoster-frame.ograf.json"), include_str!("../builtin/paternoster-frame/paternoster-frame.ograf.json"));
        let _ = std::fs::write(dir.join("paternoster-frame.js"), include_str!("../builtin/paternoster-frame/paternoster-frame.js"));
    }
}

/// Versionsnummer `x.y.z` als Tupel; `None`, wenn nicht lesbar.
fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
    let mut it = v.trim().split('.').map(|p| p.parse::<u32>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

/// Ältere Installationen tragen eine ältere Fassung der mitgelieferten Vorlage (das Datenverzeichnis wird nur einmal befüllt):
/// ist die installierte `version` kleiner als die des Programms, werden Manifest und Modul ersetzt. Ohne lesbare Version
/// (vom Nutzer umgebaut) bleibt die Vorlage unberührt.
pub(crate) fn upgrade_builtin(dir: &Path, name: &str, manifest: &str, module: &str) {
    let path = dir.join(format!("{name}.ograf.json"));
    let Ok(raw) = std::fs::read_to_string(&path) else { return };
    let Ok(json) = serde_json::from_str::<Value>(&raw) else { return };
    let (Some(old), Ok(new)) = (json["version"].as_str().and_then(parse_version), serde_json::from_str::<Value>(manifest)) else { return };
    if new["version"].as_str().and_then(parse_version).is_some_and(|n| old < n) {
        let _ = std::fs::write(&path, manifest);
        let _ = std::fs::write(dir.join(format!("{name}.js")), module);
    }
}

/// Mitgelieferte PIP-Wand (Hintergrund, Rahmen, Beschriftung für drei PIP-Fenster; Layout-Kopplung `follow`).
pub fn ensure_builtin_pip_wall(templates_root: &Path) {
    let dir = templates_root.join("pip-wall");
    if dir.join("pip-wall.ograf.json").exists() {
        upgrade_builtin(&dir, "pip-wall", include_str!("../builtin/pip-wall/pip-wall.ograf.json"), include_str!("../builtin/pip-wall/pip-wall.js"));
        return;
    }
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(dir.join("pip-wall.ograf.json"), include_str!("../builtin/pip-wall/pip-wall.ograf.json"));
        let _ = std::fs::write(dir.join("pip-wall.js"), include_str!("../builtin/pip-wall/pip-wall.js"));
    }
}

/// Mitgelieferte Sendevorlagen mit Präfix `omp-` (Anzeigename `OMP_…`): Bauchbinde, Schlagzeile, Ticker, Logo, Uhr, Ergebnis,
/// Titelkarte, Danach, Ortsmarke, Zitat, Trenner „Wipe“, Abspann. Mit `scene.json` sind sie Designer-Vorlagen und im Editor auf
/// der Leinwand bearbeitbar (erzeugt mit `tools/builtin-scenes/gen.ts`). Installation/Ersatz bei höherer `version` wie bei `pip-wall`.
const BUILTIN_SET: &[(&str, &str, &str, Option<&str>)] = &[
    ("omp-lower-third", include_str!("../builtin/omp-lower-third/omp-lower-third.ograf.json"), include_str!("../builtin/omp-lower-third/omp-lower-third.js"), Some(include_str!("../builtin/omp-lower-third/scene.json"))),
    ("omp-headline-bar", include_str!("../builtin/omp-headline-bar/omp-headline-bar.ograf.json"), include_str!("../builtin/omp-headline-bar/omp-headline-bar.js"), Some(include_str!("../builtin/omp-headline-bar/scene.json"))),
    ("omp-ticker", include_str!("../builtin/omp-ticker/omp-ticker.ograf.json"), include_str!("../builtin/omp-ticker/omp-ticker.js"), None),
    ("omp-channel-bug", include_str!("../builtin/omp-channel-bug/omp-channel-bug.ograf.json"), include_str!("../builtin/omp-channel-bug/omp-channel-bug.js"), None),
    ("omp-clock", include_str!("../builtin/omp-clock/omp-clock.ograf.json"), include_str!("../builtin/omp-clock/omp-clock.js"), None),
    ("omp-scoreboard", include_str!("../builtin/omp-scoreboard/omp-scoreboard.ograf.json"), include_str!("../builtin/omp-scoreboard/omp-scoreboard.js"), Some(include_str!("../builtin/omp-scoreboard/scene.json"))),
    ("omp-title-card", include_str!("../builtin/omp-title-card/omp-title-card.ograf.json"), include_str!("../builtin/omp-title-card/omp-title-card.js"), Some(include_str!("../builtin/omp-title-card/scene.json"))),
    ("omp-next-up", include_str!("../builtin/omp-next-up/omp-next-up.ograf.json"), include_str!("../builtin/omp-next-up/omp-next-up.js"), Some(include_str!("../builtin/omp-next-up/scene.json"))),
    ("omp-location-strap", include_str!("../builtin/omp-location-strap/omp-location-strap.ograf.json"), include_str!("../builtin/omp-location-strap/omp-location-strap.js"), Some(include_str!("../builtin/omp-location-strap/scene.json"))),
    ("omp-quote", include_str!("../builtin/omp-quote/omp-quote.ograf.json"), include_str!("../builtin/omp-quote/omp-quote.js"), Some(include_str!("../builtin/omp-quote/scene.json"))),
    ("omp-wipe-divider", include_str!("../builtin/omp-wipe-divider/omp-wipe-divider.ograf.json"), include_str!("../builtin/omp-wipe-divider/omp-wipe-divider.js"), None),
    ("omp-credits", include_str!("../builtin/omp-credits/omp-credits.ograf.json"), include_str!("../builtin/omp-credits/omp-credits.js"), None),
];

pub fn ensure_builtin_broadcast_set(templates_root: &Path) {
    for (id, manifest, module, scene) in BUILTIN_SET {
        let dir = templates_root.join(id);
        let mpath = dir.join(format!("{id}.ograf.json"));
        let install = match std::fs::read_to_string(&mpath) {
            Err(_) => true, // noch nicht vorhanden
            Ok(raw) => {
                let old = serde_json::from_str::<Value>(&raw).ok().and_then(|j| j["version"].as_str().and_then(parse_version));
                let new = serde_json::from_str::<Value>(manifest).ok().and_then(|j| j["version"].as_str().and_then(parse_version));
                matches!((old, new), (Some(o), Some(n)) if o < n) // ohne lesbare Version: vom Nutzer umgebaut, bleibt
            }
        };
        if install && std::fs::create_dir_all(&dir).is_ok() {
            let _ = std::fs::write(&mpath, manifest);
            let _ = std::fs::write(dir.join(format!("{id}.js")), module);
            if let Some(sc) = scene {
                let _ = std::fs::write(dir.join("scene.json"), sc);
            }
        }
    }
}

const HARNESS_HTML: &str = include_str!("../ui/harness.html");

/// `ParamStore::extra_route`-Implementierung für die Harness-Seite
/// (`/ograf-harness.html`, von `wpesrc` selbst geladen) + rohe
/// Template-Dateien (`/ograf-templates/<dir>/<datei>`, vom
/// `import()` der Harness-Seite nachgeladen — Manifest, ES-Modul,
/// Assets wie Fonts/Bilder gleichermaßen).
pub fn route(root: &Path, method: &str, path: &str) -> Option<RawResponse> {
    if method != "GET" {
        return None;
    }
    if path == "/ograf-harness.html" {
        return Some(RawResponse {
            status: 200,
            content_type: "text/html",
            body: HARNESS_HTML.as_bytes().to_vec(),
        });
    }
    let rel = path.strip_prefix("/ograf-templates/")?;
    let rel = rel.split('?').next().unwrap_or(rel); // `?v=<Änderungszeit>` (module_url)
    let resolved = resolve_under_root(root, rel)?;
    if !resolved.is_file() {
        return None;
    }
    let body = std::fs::read(&resolved).ok()?;
    Some(RawResponse {
        status: 200,
        content_type: content_type_for(&resolved),
        body,
    })
}

/// Für `show()` im Node-Aufrufcode (`main.rs`): löst eine `templateId`
/// gegen die gescannte Liste auf und liefert die für die Harness nötigen
/// Modul-Angaben (`dir`/`main`) — kein zweiter Lookup-Mechanismus, dieser
/// hier ist die einzige Quelle.
pub fn find_by_id<'a>(templates: &'a [TemplateInfo], id: &str) -> Option<&'a TemplateInfo> {
    templates.iter().find(|t| t.id == id)
}

/// Verzeichnis und Hauptmodul für die Harness-Seite. An den Modulnamen hängt die Änderungszeit der Datei als `?v=…`: ohne sie
/// lädt die Seite ein bearbeitetes Modul nie neu (ES-Module werden je URL einmal geladen, Kapitel 90.4 Editor).
pub fn module_url(root: &Path, info: &TemplateInfo) -> (String, String) {
    let v = std::fs::metadata(root.join(&info.dir).join(&info.main))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    (info.dir.clone(), format!("{}?v={v}", info.main))
}

#[cfg(test)]
mod zone_tests {
    use super::*;

    /// Die mitgelieferten Vorlagen deklarieren ihre Zonen im Vendor-Feld `v_omp_zones` und tragen keine unbekannten Felder
    /// ohne `v_` (OGraf v1: `additionalProperties: false`, Vendor-Felder nur mit Präfix `v_`).
    #[test]
    fn builtin_manifests_declare_zones_and_stay_within_the_schema() {
        let allowed = [
            "$schema", "$id", "id", "version", "name", "description", "author", "main", "customActions", "actionDurations", "stepCount",
            "schema", "renderRequirements", "thumbnails", "supportsRealTime", "supportsNonRealTime",
        ];
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("builtin");
        let mut zones = std::collections::BTreeMap::new();
        for dir in std::fs::read_dir(&root).unwrap().flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
            let m = find_manifest(&dir).expect("Manifest");
            let json: Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
            for k in json.as_object().unwrap().keys() {
                assert!(allowed.contains(&k.as_str()) || k.starts_with("v_"), "{}: Feld „{k}“ ist nicht Teil von OGraf v1 (Vendor-Felder: Präfix v_)", m.display());
            }
            let info = load_manifest(&m, &dir.file_name().unwrap().to_string_lossy()).unwrap();
            zones.insert(info.id.clone(), info.zones.as_array().unwrap().iter().map(|z| z["id"].as_str().unwrap().to_string()).collect::<Vec<_>>());
        }
        assert_eq!(zones["pip-wall"], vec!["pip1", "pip2", "pip3"]);
        assert_eq!(zones["paternoster-frame"], vec!["window"]);
        assert_eq!(zones["omp-credits"], vec!["video"]);
        assert!(zones["omp-wipe-divider"].is_empty() && zones["omp-lower-third"].is_empty());
    }
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;

    #[test]
    fn old_builtin_manifest_is_replaced_but_user_edits_stay() {
        let dir = std::env::temp_dir().join(format!("omp-ograf-upg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("pip-wall")).unwrap();
        let p = dir.join("pip-wall").join("pip-wall.ograf.json");
        std::fs::write(&p, r#"{"id":"pip-wall","version":"1.0.0","designWidth":1920}"#).unwrap();
        std::fs::write(dir.join("pip-wall").join("pip-wall.js"), "alt").unwrap();
        ensure_builtin_pip_wall(&dir);
        let now: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert!(now.get("designWidth").is_none() && now["v_omp_zones"].is_array());
        assert_ne!(std::fs::read_to_string(dir.join("pip-wall").join("pip-wall.js")).unwrap(), "alt"); // Modul mit ersetzt
        std::fs::write(&p, r#"{"id":"pip-wall","name":"meins"}"#).unwrap(); // vom Nutzer geändert: bleibt
        ensure_builtin_pip_wall(&dir);
        assert!(std::fs::read_to_string(&p).unwrap().contains("meins"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
