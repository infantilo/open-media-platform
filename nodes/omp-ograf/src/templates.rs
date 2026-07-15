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
    /// Verzeichnisname relativ zu `OMP_OGRAF_TEMPLATES` — Teil der
    /// Modul-URL (`/ograf-templates/<dir>/<main>`), nicht Teil des
    /// Descriptor-Werts (der Bildmeister braucht nur `id`/`label`, keine
    /// Dateisystem-Details, §5.3).
    dir: String,
    main: String,
}

impl TemplateInfo {
    pub fn to_descriptor_json(&self) -> Value {
        serde_json::json!({
            "id": self.id,
            "label": self.label,
            "stepCount": self.step_count,
            "schema": self.schema,
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
    Ok(TemplateInfo {
        id,
        label,
        step_count,
        schema,
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
        _ => "application/octet-stream",
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

pub fn module_url(info: &TemplateInfo) -> (String, String) {
    (info.dir.clone(), info.main.clone())
}
