//! omp-multiviewer-custom (Nutzerauftrag 2026-08-20: "altes service
//! multiviewer zu automatic multiviewer umbenennen. neues microservice
//! multiviewer erstellen: layout editor, selektierbare quellen,
//! dynamische anzahl an pip's. tally und umd pro pip"): manuell
//! konfigurierter Multiviewer, Geschwister von `omp-multiviewer` (jetzt
//! "Automatic Multiviewer" — Discovery findet ALLE Quellen automatisch,
//! festes Quadrat-Raster, kein Tally). Hier bestimmt der Bediener über
//! einen node-eigenen grafischen Layout-Editor (`ui/bundle.js`, `GET`/
//! `POST /state`) explizit, WELCHE Quelle in WELCHER Kachel an WELCHER
//! Position/Größe erscheint, mit individuellem UMD-Text; das Broadcast-
//! übliche Tally (`omp.tally.<nodeId>`-Bus, bereits von
//! `omp-video-mixer-me`s Crosspoint bespielt) färbt den Kachelrahmen live.
//!
//! **Zwei getrennte Auflösungspfade** (s. `resolve_pips`/`discovery_loop`-
//! Doku unten): Quelle→Flow-Auflösung ist rein synchron aus dem zuletzt
//! gepollten Sender-Cache (kein Registry-Rundlauf im Anfrage-Pfad, sofort
//! wirksam bei `POST /state`); Quelle→Node-Auflösung fürs Tally-Routing
//! bleibt asynchron+gecacht (exakt `omp-video-mixer-me`s
//! `resolve_node_id`-Muster) und darf bis zu einem 2s-Poll nachlaufen —
//! ein frisch hinzugefügter Kachel-Rahmen bleibt dadurch bis zu 2s neutral
//! grau statt sofort tally-fähig, kein sichtbarer Nachteil für ein
//! Monitoring-Werkzeug.

mod pipeline;
mod uibundle;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_node_sdk::health;
use omp_node_sdk::is04::{self, RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, SenderSpec, SetError,
};
use pipeline::{DEFAULT_CANVAS_HEIGHT, DEFAULT_CANVAS_WIDTH, MIN_PIP_SIZE, PipelineHandle, ResolvedPip};
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

// ---------------------------------------------------------------------
// Layout-Zustand (Wire-Format von GET/POST /state)
// ---------------------------------------------------------------------

/// Eine vom Bediener konfigurierte Kachel — Wire-Format-Pendant zu
/// `pipeline::ResolvedPip`, aber VOR jeder Quellenauflösung (`senderId`
/// bleibt ein reiner String-Verweis, kein `flow_id`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct PipConfig {
    id: String,
    #[serde(rename = "senderId", default, skip_serializing_if = "Option::is_none")]
    sender_id: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    umd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Layout {
    #[serde(rename = "canvasWidth")]
    canvas_width: u32,
    #[serde(rename = "canvasHeight")]
    canvas_height: u32,
    pips: Vec<PipConfig>,
}

impl Default for Layout {
    fn default() -> Self {
        Layout { canvas_width: DEFAULT_CANVAS_WIDTH, canvas_height: DEFAULT_CANVAS_HEIGHT, pips: Vec::new() }
    }
}

/// Ein benanntes, gespeichertes Layout (Nutzerauftrag 2026-08-20:
/// "mehrere layouts pro multiviewer anlegbar/aufrufbar machen, layouts
/// export/import") — zusätzlich zum EINEN aktuell aktiven Layout
/// (`Layout`/`GET`/`POST /state`, unverändert) kann der Bediener beliebig
/// viele weitere Layouts unter einem Namen ablegen und später erneut
/// aktivieren (`POST /layouts/<name>/apply`, ruft intern dieselbe
/// `apply_layout`-Anwendung wie `POST /state` auf — ein Preset-Wechsel
/// verhält sich exakt wie manuelles Neu-Speichern). Export/Import
/// brauchen keine eigene Route: `GET /layouts` liefert bereits die
/// VOLLEN Layout-Dokumente (nicht nur Namen), der Editor bietet einen
/// Eintrag daraus direkt als Datei-Download an; Import ist ein normales
/// `POST /layouts` mit dem Inhalt einer hochgeladenen Datei als Body.
/// Nur im Prozessspeicher gehalten (`Arc<Mutex<Vec<NamedLayout>>>` in
/// `main()`) — dieselbe Haltbarkeitsstufe wie das aktuell aktive Layout
/// selbst (kein Postgres-Store für Node-eigene Inhalte in diesem
/// Projekt, s. `docs/decisions.md`), geht also bei einem Prozess-Neustart
/// verloren; Export/Import ist der dafür vorgesehene Weg, ein Layout
/// dauerhaft zu sichern.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct NamedLayout {
    name: String,
    layout: Layout,
}

/// Validiert ein per `POST /state` eingereichtes Layout — "ehrliche
/// Ablehnung statt stillem Clamping" (gleiche Linie wie `omp-decklink`s
/// `audio_channels`-Validierung): ein zu kleines/negatives Maß wäre sonst
/// erst als kryptischer GStreamer-Pipeline-Fehler beim nächsten Rebuild
/// sichtbar, weit weg vom eigentlichen Bedienfehler.
fn validate_layout(layout: &Layout) -> Result<(), String> {
    if layout.canvas_width < MIN_PIP_SIZE || layout.canvas_height < MIN_PIP_SIZE {
        return Err(format!("canvas too small (min {MIN_PIP_SIZE}x{MIN_PIP_SIZE})"));
    }
    if layout.canvas_width > 7680 || layout.canvas_height > 4320 {
        return Err("canvas too large (max 7680x4320)".to_string());
    }
    let mut seen_ids = std::collections::HashSet::new();
    for pip in &layout.pips {
        if pip.id.trim().is_empty() {
            return Err("pip id must not be empty".to_string());
        }
        if !seen_ids.insert(pip.id.as_str()) {
            return Err(format!("duplicate pip id {:?}", pip.id));
        }
        if pip.width < MIN_PIP_SIZE || pip.height < MIN_PIP_SIZE {
            return Err(format!("pip {:?}: width/height below minimum {MIN_PIP_SIZE}", pip.id));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Quellen-Discovery (rein IS-04, gleicher Poll-/Filter-Stil wie
// `omp-multiviewer::discover` — hier ohne dessen Lowres-BEVORZUGUNG beim
// Lesen (Kapitel 15 Teil 3: bewusst nicht Teil dieser Runde, s.
// Moduldoku, das wäre eine reine Performance-Optimierung), aber mit
// demselben Lowres-Begleit-Sender-AUSSCHLUSS aus der Quellenliste — live
// beim ersten Test gefunden: ohne Filter zeigte der Quellen-Picker jede
// Kamera doppelt ("cam1 Sender 1" UND "cam1 Lowres"), die zweite ist kein
// unabhängig wählbares Signal, nur ein technischer Begleit-Sender.
// ---------------------------------------------------------------------

/// Kapitel 15 Teil 3 (docs/END-GOAL-FEATURES.md §15.3b/§15.4): gegen die
/// echte AMWA-NMOS-Parameter-Registry verifiziertes Tag — identisch zu
/// `omp-multiviewer::GROUPHINT_TAG`.
const GROUPHINT_TAG: &str = "urn:x-nmos:tag:grouphint/v1.0";

/// Ob `s` ein Lowres-Begleit-Sender ist (Rolle `low`) — identisch zu
/// `omp-multiviewer::is_lowres_companion`, hier nur zum Ausschluss aus
/// der Quellenliste genutzt (kein bevorzugtes Lesen wie dort, s.
/// Moduldoku).
fn is_lowres_companion(s: &is04::Sender) -> bool {
    s.tags
        .get(GROUPHINT_TAG)
        .map(|values| values.iter().any(|v| v.split(':').nth(1) == Some("low")))
        .unwrap_or(false)
}

#[derive(Debug, Clone)]
struct SourceInfo {
    sender_id: String,
    label: String,
    flow_id: String,
    device_id: String,
}

fn discover_sources(registry: &RegistryClient, own_pgm_flow_id: &str) -> Result<Vec<SourceInfo>, String> {
    let senders = registry.list_senders().map_err(|e| e.to_string())?;
    let mut discovered = Vec::new();
    for s in &senders {
        if s.transport != TRANSPORT_MXL || is_lowres_companion(s) {
            continue;
        }
        let Some(flow_id) = &s.flow_id else { continue };
        // Selbstausschluss (Nutzerauftrag 2026-08-20, PGM-MXL-Ausgang):
        // seit dieser Node selbst einen MXL-Video-Sender registriert
        // (anders als der automatische Multiviewer, dessen Kommentar
        // "kein Selbstausschluss nötig" hier NICHT mehr gilt), würde er
        // sich sonst live in seiner eigenen Quellenliste sehen — live
        // beim ersten Test gefunden ("mv Sender 1" tauchte im
        // Quellen-Picker auf).
        if flow_id == own_pgm_flow_id {
            continue;
        }
        if !matches!(registry.get_flow_format(flow_id), Ok(format) if format == is04::FORMAT_VIDEO) {
            continue;
        }
        discovered.push(SourceInfo {
            sender_id: s.id.clone(),
            label: s.label.clone(),
            flow_id: flow_id.clone(),
            device_id: s.device_id.clone(),
        });
    }
    Ok(discovered)
}

/// Löst `layout` rein synchron gegen den zuletzt gepollten Quellen-Cache
/// zu `pipeline::ResolvedPip`s auf — KEIN Registry-Zugriff (der lebt
/// ausschließlich im `discovery_loop`), deshalb direkt aus `POST /state`
/// aufrufbar (s. Moduldoku "zwei getrennte Auflösungspfade"). Eine
/// gewählte, aber (noch) nicht im Cache stehende `senderId` liefert
/// `flow_id: None` — zeigt die Platzhalter-Kachel statt den Start zu
/// blockieren, self-heilend über den nächsten Poll.
fn resolve_pips(layout: &Layout, sources: &[SourceInfo]) -> Vec<ResolvedPip> {
    layout
        .pips
        .iter()
        .map(|pip| {
            let source = pip.sender_id.as_deref().and_then(|id| sources.iter().find(|s| s.sender_id == id));
            ResolvedPip {
                id: pip.id.clone(),
                flow_id: source.map(|s| s.flow_id.clone()),
                // Quellen-LABEL (s. ResolvedPip-Doku), nie die rohe
                // senderId — Nutzerfund 2026-08-20.
                source_label: source.map(|s| s.label.clone()),
                umd: pip.umd.clone(),
                x: pip.x,
                y: pip.y,
                width: pip.width,
                height: pip.height,
            }
        })
        .collect()
}

/// Löst `device_id` per IS-04-Query-API zu `node_id` auf (gecacht) —
/// identisches Muster wie `omp-video-mixer-me::resolve_node_id` (dortige
/// Doku: "Devices/Nodes ändern sich nicht, solange derselbe Prozess
/// läuft").
async fn resolve_node_id(registry_url: &str, device_id: &str, cache: &Arc<Mutex<HashMap<String, String>>>) -> Option<String> {
    if let Some(cached) = cache.lock().expect("lock poisoned").get(device_id) {
        return Some(cached.clone());
    }
    let registry = RegistryClient::new(registry_url.to_string());
    let device_id_owned = device_id.to_string();
    let result = tokio::task::spawn_blocking(move || registry.get_device(&device_id_owned)).await;
    match result {
        Ok(Ok(device)) => {
            cache.lock().expect("lock poisoned").insert(device_id.to_string(), device.node_id.clone());
            Some(device.node_id)
        }
        Ok(Err(e)) => {
            eprintln!("omp-multiviewer-custom: get_device({device_id}) failed: {e}");
            None
        }
        Err(e) => {
            eprintln!("omp-multiviewer-custom: get_device({device_id}) task panicked: {e}");
            None
        }
    }
}

// ---------------------------------------------------------------------
// ParamStore
// ---------------------------------------------------------------------

struct MultiviewerCustomStore {
    layout: Arc<Mutex<Layout>>,
    sources: Arc<Mutex<Vec<SourceInfo>>>,
    pipeline: PipelineHandle,
    preview_url: String,
    // Nur für den readonly "pgmFlowId"-Parameter (Introspektion/Debug,
    // gleiches Muster wie omp-decklinks "flowId") — die eigentliche
    // Registrierung läuft über NodeConfig.senders, unabhängig von diesem
    // Feld.
    pgm_flow_id: String,
    // Benannte, gespeicherte Layouts (s. `NamedLayout`-Doku) — getrennt
    // vom aktuell AKTIVEN `layout` oben.
    saved_layouts: Arc<Mutex<Vec<NamedLayout>>>,
}

impl MultiviewerCustomStore {
    /// `POST /state`s eigentliche Anwendung: validieren, übernehmen, SOFORT
    /// (synchron, s. Moduldoku) mit dem aktuellen Quellen-Cache anwenden —
    /// kein Warten auf den nächsten 2s-Discovery-Tick, "explizites
    /// Speichern" (Editor-Konvention dieses Projekts) soll sich sofort
    /// sichtbar auswirken.
    fn apply_layout(&self, layout: Layout) -> Result<(), String> {
        validate_layout(&layout)?;
        let resolved = {
            let sources = self.sources.lock().expect("lock poisoned");
            resolve_pips(&layout, &sources)
        };
        self.pipeline.set_layout(layout.canvas_width, layout.canvas_height, resolved);
        *self.layout.lock().expect("lock poisoned") = layout;
        Ok(())
    }

    /// `POST /layouts`: legt ein benanntes Layout an oder überschreibt ein
    /// gleichnamiges (Upsert, s. `NamedLayout`-Doku) — validiert wie
    /// `apply_layout`, wendet es aber NICHT an (reines Ablegen, das
    /// aktuell aktive Layout bleibt unverändert, bis der Bediener es
    /// explizit per `apply` abruft).
    fn save_named_layout(&self, named: NamedLayout) -> Result<(), String> {
        if named.name.trim().is_empty() {
            return Err("layout name must not be empty".to_string());
        }
        validate_layout(&named.layout)?;
        let mut saved = self.saved_layouts.lock().expect("lock poisoned");
        if let Some(existing) = saved.iter_mut().find(|l| l.name == named.name) {
            *existing = named;
        } else {
            saved.push(named);
        }
        Ok(())
    }

    /// `POST /layouts/<name>/apply`: sucht das benannte Layout und wendet
    /// es exakt wie `POST /state` an (dasselbe `apply_layout`) — ein
    /// Preset-Wechsel ist funktional identisch zu "Layout X exportieren,
    /// dann importieren", nur ohne den Datei-Umweg.
    fn apply_named_layout(&self, name: &str) -> Result<(), String> {
        let layout = {
            let saved = self.saved_layouts.lock().expect("lock poisoned");
            saved.iter().find(|l| l.name == name).map(|l| l.layout.clone())
        };
        match layout {
            Some(layout) => self.apply_layout(layout),
            None => Err(format!("no saved layout named {name:?}")),
        }
    }

    /// `DELETE /layouts/<name>` — `Ok(false)`, wenn `name` nicht existiert
    /// (Aufrufer meldet das als 404, kein Fehler-Text nötig).
    fn delete_named_layout(&self, name: &str) -> bool {
        let mut saved = self.saved_layouts.lock().expect("lock poisoned");
        let before = saved.len();
        saved.retain(|l| l.name != name);
        saved.len() != before
    }
}

impl ParamStore for MultiviewerCustomStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                // JSON-Array [{senderId,label}] der aktuell verfügbaren
                // Quellen — gespeist vom Layout-Editor-Bundle für dessen
                // Quellen-Dropdown je Kachel (gleiche Array-als-String-
                // Ausnahme wie `omp-multiviewer`s "inputs").
                ParamSpec { name: "sources".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
                ParamSpec { name: "previewUrl".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
                // Optionaler PGM-MXL-Ausgang (Nutzerauftrag 2026-08-20) —
                // rein informativ (welchen Flow ein Gateway/Decklink-
                // Ausgang verbinden würde), die eigentliche NMOS-
                // Registrierung läuft unabhängig über NodeConfig.senders.
                ParamSpec { name: "pgmFlowId".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ],
            methods: vec![],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "sources" => {
                let sources = self.sources.lock().expect("lock poisoned");
                Some(serde_json::json!(
                    sources.iter().map(|s| serde_json::json!({"senderId": s.sender_id, "label": s.label})).collect::<Vec<_>>()
                ))
            }
            "previewUrl" => Some(serde_json::json!(self.preview_url)),
            "pgmFlowId" => Some(serde_json::json!(self.pgm_flow_id)),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, _name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let path = path.split('?').next().unwrap_or(path);
        // Wire-Format `{"state": ...}` auf BEIDEN Seiten — kein
        // Freiraum hier: `orchestrator/internal/snapshots/nodeclient.go`
        // (Backup/Restore, GetState/ApplyState) parst/baut exakt dieses
        // Objekt, ein abweichendes Top-Level-Feld würde dieses Node still
        // vom Snapshot-Mechanismus ausschließen (gleiche Konvention wie
        // `omp-audio-mixer`/`omp-video-mixer-me`s `/state`-Route).
        if method == "GET" && path == "/state" {
            let layout = self.layout.lock().expect("lock poisoned").clone();
            let payload = serde_json::to_vec(&serde_json::json!({ "state": layout })).unwrap_or_default();
            return Some(RawResponse { status: 200, content_type: "application/json", body: payload });
        }
        if method == "POST" && path == "/state" {
            let parsed: Result<Value, _> = serde_json::from_slice(body);
            let layout = match parsed {
                Ok(v) => serde_json::from_value::<Layout>(v.get("state").cloned().unwrap_or(Value::Null)),
                Err(e) => Err(e),
            };
            return Some(match layout {
                Ok(layout) => match self.apply_layout(layout) {
                    Ok(()) => RawResponse { status: 200, content_type: "application/json", body: br#"{"ok":true}"#.to_vec() },
                    Err(e) => RawResponse {
                        status: 400,
                        content_type: "application/json",
                        body: serde_json::to_vec(&serde_json::json!({"error": e})).unwrap_or_default(),
                    },
                },
                Err(e) => RawResponse {
                    status: 400,
                    content_type: "application/json",
                    body: serde_json::to_vec(&serde_json::json!({"error": format!("invalid state document: {e}")})).unwrap_or_default(),
                },
            });
        }

        // Benannte Layouts (Nutzerauftrag 2026-08-20, s. `NamedLayout`-
        // Doku) — gleiches Registrierungsmuster wie `/plugins`/
        // `/plugins/<name>` (orchestrator/internal/httpapi/server.go:
        // ein `{name}`-Platzhalter pro Route).
        if method == "GET" && path == "/layouts" {
            let saved = self.saved_layouts.lock().expect("lock poisoned").clone();
            let payload = serde_json::to_vec(&serde_json::json!({ "layouts": saved })).unwrap_or_default();
            return Some(RawResponse { status: 200, content_type: "application/json", body: payload });
        }
        if method == "POST" && path == "/layouts" {
            let parsed: Result<NamedLayout, _> = serde_json::from_slice(body);
            return Some(match parsed {
                Ok(named) => match self.save_named_layout(named) {
                    Ok(()) => RawResponse { status: 200, content_type: "application/json", body: br#"{"ok":true}"#.to_vec() },
                    Err(e) => RawResponse {
                        status: 400,
                        content_type: "application/json",
                        body: serde_json::to_vec(&serde_json::json!({"error": e})).unwrap_or_default(),
                    },
                },
                Err(e) => RawResponse {
                    status: 400,
                    content_type: "application/json",
                    body: serde_json::to_vec(&serde_json::json!({"error": format!("invalid layout document: {e}")})).unwrap_or_default(),
                },
            });
        }
        if let Some(name) = path.strip_prefix("/layouts/").and_then(|rest| rest.strip_suffix("/apply"))
            && method == "POST"
        {
            let name = urlencoding_decode(name);
            return Some(match self.apply_named_layout(&name) {
                Ok(()) => RawResponse { status: 200, content_type: "application/json", body: br#"{"ok":true}"#.to_vec() },
                Err(e) => RawResponse {
                    status: 404,
                    content_type: "application/json",
                    body: serde_json::to_vec(&serde_json::json!({"error": e})).unwrap_or_default(),
                },
            });
        }
        if let Some(name) = path.strip_prefix("/layouts/")
            && method == "DELETE"
        {
            let name = urlencoding_decode(name);
            return Some(if self.delete_named_layout(&name) {
                RawResponse { status: 200, content_type: "application/json", body: br#"{"ok":true}"#.to_vec() }
            } else {
                RawResponse {
                    status: 404,
                    content_type: "application/json",
                    body: serde_json::to_vec(&serde_json::json!({"error": format!("no saved layout named {name:?}")})).unwrap_or_default(),
                }
            });
        }

        uibundle::route(method, path)
    }
}

/// Minimaler `%XX`-Decoder für den `<name>`-Pfadsegment-Anteil von
/// `/layouts/<name>`/`/layouts/<name>/apply` — Layout-Namen sind
/// Nutzertext (Leerzeichen/Sonderzeichen erwartet), der Node-Server
/// selbst dekodiert den Pfad nicht (`omp_node_sdk::server`s generische
/// `/params/<name>`-Route braucht das nicht, dort sind Namen immer
/// einfache Bezeichner) — keine externe Dependency nur für diesen einen
/// Anwendungsfall, `serde_urlencoded`/`url` sind sonst nirgends im
/// Crate-Graphen dieses Nodes nötig.
fn urlencoding_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // Auf Byte-Ebene statt `&s[i+1..i+3]` (Nutzerfund-Kategorie
        // "kein Absturz bei Fehleingabe"): eine Str-Slice-Indexierung
        // würde bei fehlerhafter/mehrbyte-UTF-8-Eingabe nach einem
        // einzelnen `%` mit "byte index is not a char boundary"
        // panicken — `str::from_utf8` liefert stattdessen ein `Result`.
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Multiviewer");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9430").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Default 0 (freier Port vom OS), gleicher Grund wie
    // `omp-multiviewer`s OMP_MULTIVIEWER_PREVIEW_PORT: mehrere Instanzen
    // dürfen sich keinen festen Preview-Port teilen.
    let preview_port: u16 = env_or("OMP_MULTIVIEWER_CUSTOM_PREVIEW_PORT", "0").parse()?;
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let broadcaster = Arc::new(omp_mediaio::preview::Broadcaster::new());
    let preview_heartbeat = Arc::new(AtomicU64::new(0));
    let actual_preview_port = omp_mediaio::preview::spawn(&format!("0.0.0.0:{preview_port}"), broadcaster.clone(), preview_heartbeat.clone())?;
    let preview_url = format!("http://{host}:{actual_preview_port}/preview");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    // Optionaler PGM-MXL-Ausgang (Nutzerauftrag 2026-08-20, s.
    // pipeline::Config::pgm_flow_id-Doku) — stabile Flow-UUID über die
    // gesamte Prozesslaufzeit, gleiche Konvention wie omp-decklinks
    // flow_id.
    let pgm_flow_id = omp_node_sdk::idgen::new_v4();
    let pipeline_config = pipeline::Config { domain, pgm_flow_id: pgm_flow_id.clone(), label: label.clone() };
    let pipeline_shutdown = shutdown.clone();
    let broadcaster_for_pipeline = broadcaster.clone();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(pipeline_config, broadcaster_for_pipeline, tx, pipeline_shutdown, ready_tx, pipeline_heartbeat_thread)
    });

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-multiviewer-custom: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-multiviewer-custom: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let layout = Arc::new(Mutex::new(Layout::default()));
    let sources = Arc::new(Mutex::new(Vec::<SourceInfo>::new()));
    let media_ready_pipeline = pipeline_handle.clone();

    let store: Arc<dyn ParamStore> = Arc::new(MultiviewerCustomStore {
        layout: layout.clone(),
        sources: sources.clone(),
        pipeline: pipeline_handle.clone(),
        preview_url,
        pgm_flow_id: pgm_flow_id.clone(),
        saved_layouts: Arc::new(Mutex::new(Vec::new())),
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url: registry_url.clone(),
            nats_url: nats_url.clone(),
            senders: vec![SenderSpec {
                transport: Some(TRANSPORT_MXL.to_string()),
                flow: Some(FlowSpec::Video {
                    id: Some(pgm_flow_id.clone()),
                    frame_width: DEFAULT_CANVAS_WIDTH,
                    frame_height: DEFAULT_CANVAS_HEIGHT,
                    grain_rate_numerator: 25,
                    grain_rate_denominator: 1,
                }),
                tags: HashMap::new(),
                ..Default::default()
            }],
            receivers: vec![],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_ready_pipeline.media_ready())),
        },
        store,
    )
    .await?;

    handle.register_worker("pipeline", pipeline_heartbeat);
    handle.register_worker("preview-accept", preview_heartbeat);

    let node_id_cache: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
    // pip_id -> node_id der aktuell zugewiesenen Quelle (s.
    // `discovery_loop`/`tally_loop`-Doku) — getrennt vom `node_id_cache`
    // oben (device_id -> node_id, prozessweit gültig): diese Map ist
    // layout-abhängig und wird bei jedem Discovery-Tick komplett ersetzt.
    let pip_node_ids: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
    let discovery = discovery_loop(
        registry_url,
        layout.clone(),
        sources,
        pipeline_handle.clone(),
        node_id_cache,
        pip_node_ids.clone(),
        pgm_flow_id,
    );
    let tally = tally_loop(nats_url, pipeline_handle, pip_node_ids);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-multiviewer-custom: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-multiviewer-custom: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-multiviewer-custom: pipeline thread ended");
        }
        _ = discovery => {
            eprintln!("omp-multiviewer-custom: discovery loop ended");
        }
        _ = tally => {
            eprintln!("omp-multiviewer-custom: tally loop ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}

/// Pollt alle 2s die IS-04-Query-API nach MXL-Video-Sendern (Cache für
/// `MultiviewerCustomStore::apply_layout`s synchronen Pfad, s. Moduldoku),
/// löst danach das AKTUELL konfigurierte Layout gegen den frischen Cache
/// erneut auf (holt eine beim letzten `POST /state` noch nicht
/// auflösbare Quelle nach, sobald sie erscheint) und aktualisiert die
/// Tally-Node-ID-Zuordnung (`pip_node_ids`) für `tally_loop`.
async fn discovery_loop(
    registry_url: String,
    layout: Arc<Mutex<Layout>>,
    sources: Arc<Mutex<Vec<SourceInfo>>>,
    pipeline: PipelineHandle,
    node_id_cache: Arc<Mutex<HashMap<String, String>>>,
    pip_node_ids: Arc<Mutex<HashMap<String, String>>>,
    pgm_flow_id: String,
) {
    let registry = RegistryClient::new(registry_url.clone());
    let mut interval = tokio::time::interval(Duration::from_secs(2));

    loop {
        interval.tick().await;
        let registry_for_poll = registry.clone();
        let pgm_flow_id_for_poll = pgm_flow_id.clone();
        let result = tokio::task::spawn_blocking(move || discover_sources(&registry_for_poll, &pgm_flow_id_for_poll)).await;
        let discovered = match result {
            Ok(Ok(discovered)) => discovered,
            Ok(Err(e)) => {
                eprintln!("omp-multiviewer-custom: discovery poll failed: {e}");
                continue;
            }
            Err(e) => {
                eprintln!("omp-multiviewer-custom: discovery poll task panicked: {e}");
                continue;
            }
        };
        *sources.lock().expect("lock poisoned") = discovered.clone();

        let current_layout = layout.lock().expect("lock poisoned").clone();
        let resolved = resolve_pips(&current_layout, &discovered);
        pipeline.set_layout(current_layout.canvas_width, current_layout.canvas_height, resolved);

        // Tally-Node-ID-Zuordnung (pip_id -> node_id) neu aufbauen, s.
        // `tally_loop` — nur für Kacheln mit einer aktuell auflösbaren
        // Quelle; kompletter Ersatz statt Merge, damit eine entfernte/
        // nicht mehr auflösbare Kachel automatisch aus der Zuordnung
        // verschwindet (gleiche Überlegung wie `omp-multiviewer::
        // discovery_loop`s `activated_lowres`-Abgleich).
        let mut new_pip_node_ids = HashMap::new();
        for pip in &current_layout.pips {
            let Some(sender_id) = &pip.sender_id else { continue };
            let Some(source) = discovered.iter().find(|s| &s.sender_id == sender_id) else { continue };
            if let Some(node_id) = resolve_node_id(&registry_url, &source.device_id, &node_id_cache).await {
                new_pip_node_ids.insert(pip.id.clone(), node_id);
            }
        }
        *pip_node_ids.lock().expect("lock poisoned") = new_pip_node_ids;
    }
}

/// Abonniert `omp.tally.>` (s. `omp_node_sdk::health::subscribe_tally`,
/// erste Nutzung durch `omp-audio-mixer`s Audio-Follow-Video, hier
/// zweite) und färbt bei jedem Event den Rahmen JEDER Kachel um, deren
/// zugewiesene Quelle laut `pip_node_ids` (von `discovery_loop`
/// gepflegt) zu `node_id` gehört — mehrere Kacheln dürfen dieselbe
/// Quelle zeigen (z. B. Übersicht + Detail derselben Kamera), beide
/// sollen tally-fähig sein.
async fn tally_loop(nats_url: String, pipeline: PipelineHandle, pip_node_ids: Arc<Mutex<HashMap<String, String>>>) {
    let mut subscription = match health::subscribe_tally(&nats_url).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("omp-multiviewer-custom: tally subscribe failed, Tally-Anzeige inaktiv: {e}");
            return;
        }
    };
    while let Some((node_id, on)) = subscription.next().await {
        let matching: Vec<String> = pip_node_ids
            .lock()
            .expect("lock poisoned")
            .iter()
            .filter(|(_, nid)| **nid == node_id)
            .map(|(pip_id, _)| pip_id.clone())
            .collect();
        for pip_id in matching {
            pipeline.set_tally(&pip_id, on);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pip(id: &str, sender_id: Option<&str>) -> PipConfig {
        PipConfig { id: id.to_string(), sender_id: sender_id.map(str::to_string), x: 0, y: 0, width: 480, height: 270, umd: String::new() }
    }

    #[test]
    fn validate_layout_accepts_empty_layout() {
        assert!(validate_layout(&Layout::default()).is_ok());
    }

    #[test]
    fn validate_layout_rejects_canvas_below_minimum() {
        let layout = Layout { canvas_width: 8, canvas_height: 1080, pips: vec![] };
        assert!(validate_layout(&layout).is_err());
    }

    #[test]
    fn validate_layout_rejects_canvas_above_maximum() {
        let layout = Layout { canvas_width: 99999, canvas_height: 1080, pips: vec![] };
        assert!(validate_layout(&layout).is_err());
    }

    #[test]
    fn validate_layout_rejects_pip_below_minimum_size() {
        let mut layout = Layout::default();
        layout.pips.push(PipConfig { width: 4, height: 4, ..pip("p1", None) });
        assert!(validate_layout(&layout).is_err());
    }

    #[test]
    fn validate_layout_rejects_empty_pip_id() {
        let mut layout = Layout::default();
        layout.pips.push(pip("", None));
        assert!(validate_layout(&layout).is_err());
    }

    #[test]
    fn validate_layout_rejects_duplicate_pip_ids() {
        let mut layout = Layout::default();
        layout.pips.push(pip("p1", None));
        layout.pips.push(pip("p1", None));
        assert!(validate_layout(&layout).is_err());
    }

    #[test]
    fn validate_layout_accepts_well_formed_pips() {
        let mut layout = Layout::default();
        layout.pips.push(pip("p1", Some("sender-1")));
        layout.pips.push(pip("p2", None));
        assert!(validate_layout(&layout).is_ok());
    }

    fn source(sender_id: &str, flow_id: &str) -> SourceInfo {
        SourceInfo { sender_id: sender_id.to_string(), label: "Label".to_string(), flow_id: flow_id.to_string(), device_id: "dev-1".to_string() }
    }

    #[test]
    fn resolve_pips_maps_known_sender_to_its_flow_id() {
        let mut layout = Layout::default();
        layout.pips.push(pip("p1", Some("sender-1")));
        let resolved = resolve_pips(&layout, &[source("sender-1", "flow-1")]);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].flow_id.as_deref(), Some("flow-1"));
    }

    #[test]
    fn resolve_pips_carries_the_source_label_not_the_sender_id() {
        // Nutzerfund 2026-08-20: die Kachel muss den menschenlesbaren
        // Quellen-Label zeigen, nie die rohe senderId.
        let mut layout = Layout::default();
        layout.pips.push(pip("p1", Some("sender-1")));
        let resolved = resolve_pips(&layout, &[source("sender-1", "flow-1")]);
        assert_eq!(resolved[0].source_label.as_deref(), Some("Label"));
    }

    #[test]
    fn resolve_pips_leaves_source_label_none_without_a_resolvable_source() {
        let mut layout = Layout::default();
        layout.pips.push(pip("p1", None));
        let resolved = resolve_pips(&layout, &[source("sender-1", "flow-1")]);
        assert_eq!(resolved[0].source_label, None);
    }

    #[test]
    fn resolve_pips_leaves_unassigned_pip_without_flow_id() {
        let mut layout = Layout::default();
        layout.pips.push(pip("p1", None));
        let resolved = resolve_pips(&layout, &[source("sender-1", "flow-1")]);
        assert_eq!(resolved[0].flow_id, None);
    }

    #[test]
    fn resolve_pips_falls_back_to_none_for_a_currently_unresolvable_sender() {
        // Live gefundenes Szenario (s. Moduldoku "zwei getrennte
        // Auflösungspfade"): eine gewählte, aber (noch) nicht im
        // Quellen-Cache stehende senderId darf den Start nicht
        // blockieren, sondern zeigt die Platzhalter-Kachel.
        let mut layout = Layout::default();
        layout.pips.push(pip("p1", Some("sender-offline")));
        let resolved = resolve_pips(&layout, &[source("sender-1", "flow-1")]);
        assert_eq!(resolved[0].flow_id, None);
    }

    #[test]
    fn urlencoding_decode_handles_spaces_and_percent_sequences() {
        assert_eq!(urlencoding_decode("Regie%201"), "Regie 1");
        assert_eq!(urlencoding_decode("Regie+1"), "Regie 1");
        assert_eq!(urlencoding_decode("plain"), "plain");
    }

    #[test]
    fn urlencoding_decode_does_not_panic_on_malformed_percent_sequence() {
        // Live gefundene Absturzkategorie (dieselbe Session, s.
        // omp-decklink-Historie): eine Str-Slice-Indexierung nach einem
        // einzelnen "%" hätte bei mehrbyte-UTF-8-Folgezeichen mit
        // "byte index is not a char boundary" paniken können —
        // `urlencoding_decode` nutzt bewusst `str::from_utf8` (Result)
        // statt einer Slice-Indexierung, dieser Test belegt es.
        assert_eq!(urlencoding_decode("%"), "%");
        assert_eq!(urlencoding_decode("%2"), "%2");
        assert_eq!(urlencoding_decode("%zz"), "%zz");
        assert_eq!(urlencoding_decode("100%€"), "100%€");
    }
}
