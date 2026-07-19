//! omp-player: dritter §13-Referenzknoten (`UMSETZUNG.md` C12) —
//! verallgemeinert den für Playout vorgesehenen `PlaylistController`-
//! Baustein (§11.1) zu einer gemeinsamen Codebasis für Musik-/Jingle-
//! Player und Videoplayer (`ARCHITECTURE.md` §13.3): dieselben Descriptor-
//! Parameter/-Methoden, nur zwei unterschiedliche Default-
//! Konfigurationsprofile (`OMP_PLAYER_PROFILE=video|jingle`, steuert nur
//! ob ein Video-MXL-Sender registriert wird) und zwei unterschiedliche
//! UI-Bundle-Varianten (`uibundle.rs`). Manueller Cue/Take-Betrieb —
//! Automation (zeitgesteuertes Vorrücken, Playlist-Scheduling) ist
//! C14/C15-Scope.
//!
//! **Deskriptor-Namensraum** wie bei C10/C11 (v0-Schema kennt keine
//! `NcBlock`/`NcWorker`-Verschachtelung): flache Top-Level-Parameter, kein
//! `item.<id>.<name>`-Namespace nötig, weil einzelne Items (anders als
//! Audiomischer-Kanäle) keine live-verstellbaren Parameter haben — nur
//! Zugehörigkeit zur Playlist bzw. Cue/Take-Zustand.
//!
//! **K2-Teil-1** (`docs/END-GOAL-FEATURES.md` §2.3/§2.4, `UMSETZUNG.md`
//! §6a): `append`/`load` akzeptieren zusätzlich zu `pattern` ein `file`
//! (Pfad relativ zu `OMP_MEDIA_DIR`) — dann ist `durationMs` das
//! per `gstreamer_pbutils::Discoverer` einmalig geprobte Ergebnis statt
//! Handeingabe. MXF (K2-Teil-2) ist hier nicht enthalten.

mod pipeline;
mod uibundle;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use gstreamer as gst;
use gstreamer_pbutils as gst_pbutils;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    Range, RawResponse, SenderSpec, SetError,
};
use pipeline::{PipelineHandle, Slot};
use serde::Deserialize;
use serde_json::Value;

/// Woher ein Playlist-Eintrag seine Essenz bezieht — `TestPattern` bleibt
/// das ursprüngliche Software-Testmittel (`UMSETZUNG.md` §0 Punkt 7,
/// `pattern` ein `videotestsrc`-Patternname, `tone_freq` der
/// Begleitton), `File` ist neu (K2-Teil-1): `path` ist der roh vom
/// Aufrufer übergebene, relative Pfad (nur für Anzeige/`items`), `uri`
/// die daraus aufgelöste `file://`-URI, die `pipeline::ItemSource::File`
/// tatsächlich verwendet.
#[derive(Clone)]
enum ItemMedia {
    TestPattern { pattern: String, tone_freq: f64 },
    File { path: String, uri: String },
}

/// Playlist-Eintrag. `duration_ms` ist bei `TestPattern` reine
/// Handeingabe-Metadatik für `playheadPositionMs` (kein erzwungenes
/// Clip-Ende, s. `pipeline.rs`-Moduldoku), bei `File` das Ergebnis der
/// einmaligen Discoverer-Probe beim `append`/`load`.
#[derive(Clone)]
struct PlaylistItem {
    id: String,
    label: String,
    media: ItemMedia,
    duration_ms: u64,
}

/// Alle veränderlichen Playlist-/Cue-Take-Felder in einem Mutex — Cue und
/// Take müssen `items`/`onair_slot`/`onair_item`/`cued_item` immer
/// konsistent zueinander sehen, getrennte Mutexe (wie bei C11s
/// `channels`/`available_sources`) wären hier eine unnötige
/// Lock-Reihenfolge-Falle.
struct PlayerState {
    items: Vec<PlaylistItem>,
    /// Welcher der zwei Pipeline-Slots aktuell "on air" ist.
    onair_slot: Slot,
    onair_item: Option<String>,
    cued_item: Option<String>,
    onair_since: Option<Instant>,
}

struct PlayerStore {
    state: Mutex<PlayerState>,
    next_seq: AtomicU64,
    pipeline: PipelineHandle,
    has_video: bool,
    media_dir: PathBuf,
    /// Kapitel 15 Teil 4 — nur bedeutungsvoll bei `has_video == true`.
    lowres_flow_id: String,
}

/// Testton-Frequenz-Formel wie C11s `channel_freq` — nur zur akustischen
/// Unterscheidbarkeit neu angelegter Items, keine funktionale Bedeutung.
fn default_tone_freq(seq: u64) -> f64 {
    220.0 * (1 + (seq % 8)) as f64
}

const DEFAULT_PATTERN: &str = "smpte";
const DEFAULT_DURATION_MS: u64 = 5000;

/// Löst einen vom Aufrufer übergebenen, relativen Dateipfad gegen
/// `media_dir` auf und lehnt jeden Fluchtversuch nach außerhalb ab
/// (`../../etc/passwd` u. ä. — `canonicalize()` löst `..`/Symlinks aus
/// beiden Seiten auf, `starts_with` prüft danach den echten Zielpfad,
/// nicht nur die rohe Zeichenkette). Scheitert auch, wenn die Datei nicht
/// existiert (canonicalize verlangt einen realen Pfad) — bewusst
/// dieselbe Fehlermeldung wie ein Traversal-Versuch, kein Oracle für
/// Dateiexistenz außerhalb von `media_dir`.
fn resolve_media_path(media_dir: &Path, rel: &str) -> Result<PathBuf, InvokeError> {
    let candidate = media_dir.join(rel);
    let canonical = candidate.canonicalize().map_err(|_| InvokeError::Unknown)?;
    let canonical_dir = media_dir.canonicalize().map_err(|_| InvokeError::Unknown)?;
    if !canonical.starts_with(&canonical_dir) {
        return Err(InvokeError::Unknown);
    }
    Ok(canonical)
}

fn file_uri(path: &Path) -> Result<String, InvokeError> {
    gst::glib::filename_to_uri(path, None)
        .map(|s| s.to_string())
        .map_err(|_| InvokeError::Unknown)
}

/// Einmalige Dauer-Probe per `gst_pbutils::Discoverer` (K2-Teil-1,
/// `docs/END-GOAL-FEATURES.md` §2.3) — blockierend, aber für lokale
/// Testdateien im Millisekundenbereich, daher direkt im
/// `invoke()`-Aufrufpfad (kein eigener Worker-Thread nötig für diesen
/// Schritt; ein persistenter Metadaten-Cache ist explizit K2-Teil-3).
/// `gst::init()` ist idempotent (interner `INITIALIZED`-Guard) — der
/// defensive Aufruf hier deckt den Fall ab, dass `append`/`load` vor dem
/// ersten `gst::init()` auf dem Pipeline-Thread aufgerufen würde.
fn probe_duration_ms(uri: &str) -> Option<u64> {
    let _ = gst::init();
    let discoverer = gst_pbutils::Discoverer::new(gst::ClockTime::from_seconds(5)).ok()?;
    let info = discoverer.discover_uri(uri).ok()?;
    info.duration().map(|d| d.mseconds())
}

#[derive(Deserialize)]
struct LoadItem {
    label: String,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    file: Option<String>,
    #[serde(rename = "toneFrequency", default)]
    tone_frequency: Option<f64>,
    #[serde(rename = "durationMs", default)]
    duration_ms: Option<u64>,
}

impl ParamStore for PlayerStore {
    fn descriptor(&self) -> Descriptor {
        let parameters = vec![
            // JSON-Array [{id,label,pattern|file,toneFrequency?,durationMs}]
            // — gleiche Array-Ausnahme wie "channels" bei omp-audio-mixer.
            ParamSpec {
                name: "items".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "currentItemId".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "cuedItemId".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "mode".to_string(),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum {
                    values: vec!["black".to_string(), "onair".to_string()],
                }),
                readonly: true,
            },
            ParamSpec {
                name: "playheadPositionMs".to_string(),
                kind: ParamType::Number,
                unit: Some("ms".to_string()),
                range: None,
                readonly: true,
            },
            // JSON-Array [string] — Dateinamen direkt unter OMP_MEDIA_DIR
            // (K2-Teil-1: flache Liste, kein rekursiver Scan/Cache — s.
            // `get("mediaLibrary")`).
            ParamSpec {
                name: "mediaLibrary".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
        ];

        let mut parameters = parameters;
        if self.has_video {
            // Kapitel 15 Teil 4 (docs/END-GOAL-FEATURES.md §15.4).
            parameters.push(ParamSpec {
                name: "lowresFlowId".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            });
            parameters.push(ParamSpec {
                name: "lowresActive".to_string(),
                kind: ParamType::Boolean,
                unit: None,
                range: None,
                readonly: true,
            });
        }

        let mut methods = vec![
            MethodSpec {
                name: "append".to_string(),
                args: vec![
                    MethodArg {
                        name: "label".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "pattern".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "file".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "toneFrequency".to_string(),
                        kind: ParamType::Number,
                    },
                    MethodArg {
                        name: "durationMs".to_string(),
                        kind: ParamType::Number,
                    },
                ],
            },
            MethodSpec {
                name: "load".to_string(),
                args: vec![MethodArg {
                    name: "itemsJson".to_string(),
                    kind: ParamType::String,
                }],
            },
            MethodSpec {
                name: "remove".to_string(),
                args: vec![MethodArg {
                    name: "itemId".to_string(),
                    kind: ParamType::String,
                }],
            },
            MethodSpec {
                name: "cue".to_string(),
                args: vec![MethodArg {
                    name: "itemId".to_string(),
                    kind: ParamType::String,
                }],
            },
            MethodSpec {
                name: "take".to_string(),
                args: vec![],
            },
        ];
        if self.has_video {
            methods.push(MethodSpec {
                name: "activateLowresPreview".to_string(),
                args: vec![],
            });
            methods.push(MethodSpec {
                name: "releaseLowresPreview".to_string(),
                args: vec![],
            });
        }

        Descriptor { parameters, methods }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let state = self.state.lock().expect("lock poisoned");
        match name {
            "items" => Some(serde_json::json!(
                state
                    .items
                    .iter()
                    .map(|it| match &it.media {
                        ItemMedia::TestPattern { pattern, tone_freq } => serde_json::json!({
                            "id": it.id,
                            "label": it.label,
                            "pattern": pattern,
                            "toneFrequency": tone_freq,
                            "durationMs": it.duration_ms,
                        }),
                        ItemMedia::File { path, .. } => serde_json::json!({
                            "id": it.id,
                            "label": it.label,
                            "file": path,
                            "durationMs": it.duration_ms,
                        }),
                    })
                    .collect::<Vec<_>>()
            )),
            "currentItemId" => Some(serde_json::json!(state.onair_item.clone().unwrap_or_default())),
            "cuedItemId" => Some(serde_json::json!(state.cued_item.clone().unwrap_or_default())),
            "mode" => Some(serde_json::json!(if state.onair_item.is_some() {
                "onair"
            } else {
                "black"
            })),
            "playheadPositionMs" => Some(serde_json::json!(
                state
                    .onair_since
                    .map(|since| since.elapsed().as_millis() as f64)
                    .unwrap_or(0.0)
            )),
            "mediaLibrary" => {
                let mut files: Vec<String> = std::fs::read_dir(&self.media_dir)
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| entry.ok())
                    .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .collect();
                files.sort();
                Some(serde_json::json!(files))
            }
            // Kapitel 15 Teil 4 — nur in `descriptor()` deklariert, wenn
            // `has_video` (Jingle-Profil hat keinen Video-Ausgang). Der
            // generische Proxy (`omp_node_sdk::server::route`) prüft
            // Aufrufe nicht gegen den Descriptor, ruft `get`/`invoke`
            // immer direkt auf — harmlos hier, weil
            // `PipelineHandle::activate_lowres_preview`/
            // `release_lowres_preview` bei `None` (Jingle-Profil) selbst
            // schon zu No-Ops werden (s. dort), kein zusätzliches Gate
            // in dieser Methode nötig.
            "lowresFlowId" => Some(serde_json::json!(self.lowres_flow_id)),
            "lowresActive" => Some(serde_json::json!(self.pipeline.lowres_preview_active())),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "append" => {
                let label = args
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
                let file_arg = args
                    .get("file")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let (media, duration_ms) = if let Some(rel) = file_arg {
                    let abs = resolve_media_path(&self.media_dir, rel)?;
                    let uri = file_uri(&abs)?;
                    let duration_ms = probe_duration_ms(&uri).unwrap_or(0);
                    (
                        ItemMedia::File {
                            path: rel.to_string(),
                            uri,
                        },
                        duration_ms,
                    )
                } else {
                    let pattern = args
                        .get("pattern")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| DEFAULT_PATTERN.to_string());
                    let tone_freq = args
                        .get("toneFrequency")
                        .and_then(Value::as_f64)
                        .filter(|f| *f > 0.0)
                        .unwrap_or_else(|| default_tone_freq(seq));
                    let duration_ms = args
                        .get("durationMs")
                        .and_then(Value::as_f64)
                        .filter(|d| *d > 0.0)
                        .map(|d| d as u64)
                        .unwrap_or(DEFAULT_DURATION_MS);
                    (ItemMedia::TestPattern { pattern, tone_freq }, duration_ms)
                };
                let label = label.unwrap_or_else(|| format!("Item {seq}"));
                let id = format!("item{seq}");
                self.state.lock().expect("lock poisoned").items.push(PlaylistItem {
                    id,
                    label,
                    media,
                    duration_ms,
                });
                Ok(())
            }
            "load" => {
                let items_json = args
                    .get("itemsJson")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let load_items: Vec<LoadItem> =
                    serde_json::from_str(items_json).map_err(|_| InvokeError::Unknown)?;
                let mut items = Vec::with_capacity(load_items.len());
                for li in load_items {
                    let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
                    let (media, duration_ms) = if let Some(rel) = li.file.filter(|s| !s.is_empty()) {
                        let abs = resolve_media_path(&self.media_dir, &rel)?;
                        let uri = file_uri(&abs)?;
                        let duration_ms = probe_duration_ms(&uri).unwrap_or(0);
                        (ItemMedia::File { path: rel, uri }, duration_ms)
                    } else {
                        (
                            ItemMedia::TestPattern {
                                pattern: li.pattern.filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_PATTERN.to_string()),
                                tone_freq: li.tone_frequency.filter(|f| *f > 0.0).unwrap_or_else(|| default_tone_freq(seq)),
                            },
                            li.duration_ms.filter(|d| *d > 0).unwrap_or(DEFAULT_DURATION_MS),
                        )
                    };
                    items.push(PlaylistItem {
                        id: format!("item{seq}"),
                        label: li.label,
                        media,
                        duration_ms,
                    });
                }
                let mut state = self.state.lock().expect("lock poisoned");
                state.items = items;
                state.onair_item = None;
                state.cued_item = None;
                state.onair_since = None;
                // Beide Slots auf "schwarz/still" zurücksetzen — die
                // Playlist ist komplett neu, ein zuvor gecuter/on-air
                // Item-Verweis wäre sonst hängend.
                self.pipeline.load_slot(
                    Slot::A,
                    pipeline::Item {
                        id: String::new(),
                        source: pipeline::ItemSource::TestPattern {
                            pattern: "black".to_string(),
                            tone_freq: 0.0,
                        },
                    },
                );
                self.pipeline.load_slot(
                    Slot::B,
                    pipeline::Item {
                        id: String::new(),
                        source: pipeline::ItemSource::TestPattern {
                            pattern: "black".to_string(),
                            tone_freq: 0.0,
                        },
                    },
                );
                state.onair_slot = Slot::A;
                self.pipeline.set_active(Slot::A);
                Ok(())
            }
            "remove" => {
                let item_id = args
                    .get("itemId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let mut state = self.state.lock().expect("lock poisoned");
                if state.onair_item.as_deref() == Some(item_id)
                    || state.cued_item.as_deref() == Some(item_id)
                {
                    // On-Air/gecute Items dürfen nicht unter dem
                    // laufenden Cue/Take-Zustand entfernt werden — der
                    // Operator muss zuerst auf ein anderes Item schneiden.
                    return Err(InvokeError::Unknown);
                }
                let before = state.items.len();
                state.items.retain(|it| it.id != item_id);
                if state.items.len() == before {
                    return Err(InvokeError::Unknown);
                }
                Ok(())
            }
            "cue" => {
                let item_id = args
                    .get("itemId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let mut state = self.state.lock().expect("lock poisoned");
                let item = state
                    .items
                    .iter()
                    .find(|it| it.id == item_id)
                    .cloned()
                    .ok_or(InvokeError::Unknown)?;
                let target_slot = state.onair_slot.other();
                let source = match item.media {
                    ItemMedia::TestPattern { pattern, tone_freq } => {
                        pipeline::ItemSource::TestPattern { pattern, tone_freq }
                    }
                    ItemMedia::File { uri, .. } => pipeline::ItemSource::File { uri },
                };
                self.pipeline.load_slot(
                    target_slot,
                    pipeline::Item {
                        id: item.id.clone(),
                        source,
                    },
                );
                state.cued_item = Some(item_id.to_string());
                Ok(())
            }
            "take" => {
                let mut state = self.state.lock().expect("lock poisoned");
                let Some(cued_item) = state.cued_item.take() else {
                    return Err(InvokeError::Unknown);
                };
                let target_slot = state.onair_slot.other();
                self.pipeline.set_active(target_slot);
                state.onair_slot = target_slot;
                state.onair_item = Some(cued_item);
                state.onair_since = Some(Instant::now());
                Ok(())
            }
            "activateLowresPreview" => {
                self.pipeline.activate_lowres_preview();
                Ok(())
            }
            "releaseLowresPreview" => {
                self.pipeline.release_lowres_preview();
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, _body: &[u8]) -> Option<RawResponse> {
        uibundle::route(method, path, self.has_video)
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Player");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9390").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    // Kapitel 15 (docs/END-GOAL-FEATURES.md §15.3c): Workflow-Auflösungs-
    // Setting landet hier als OMP_WIDTH/OMP_HEIGHT (orchestrator/internal/
    // workflows/service.go runStart) — ungültige oder fehlende Werte
    // fallen ohne Fehler auf den Node-eigenen Default zurück.
    let width: u32 = env_or("OMP_WIDTH", "")
        .parse()
        .unwrap_or(pipeline::DEFAULT_WIDTH);
    let height: u32 = env_or("OMP_HEIGHT", "")
        .parse()
        .unwrap_or(pipeline::DEFAULT_HEIGHT);

    // K2-Teil-1: Wurzelverzeichnis für `file`-Items (relativ, löst gegen
    // den cwd des Prozesses auf — passend zum lokalen/host-agent-
    // Launcher, s. docs/decisions.md K2-Teil-1). Wird bei Bedarf angelegt
    // statt einen Startfehler zu erzeugen, damit ein frischer Checkout
    // ohne manuellen Zwischenschritt startfähig bleibt.
    let media_dir = PathBuf::from(env_or("OMP_MEDIA_DIR", "data/media"));
    if let Err(e) = std::fs::create_dir_all(&media_dir) {
        eprintln!("omp-player: OMP_MEDIA_DIR ({media_dir:?}) konnte nicht angelegt werden: {e}");
    }

    // "video" (Default) registriert Video- + Audio-MXL-Sender, "jingle"
    // nur Audio — einzige Verzweigung zwischen den beiden §13.3-Rollen
    // (`ARCHITECTURE.md` §13.3 Punkt 2: Default-Konfigurationsprofil).
    let profile = env_or("OMP_PLAYER_PROFILE", "video");
    let has_video = profile != "jingle";

    let video_flow_id = omp_node_sdk::idgen::new_v4();
    let audio_flow_id = omp_node_sdk::idgen::new_v4();
    // Kapitel 15 Teil 4 (docs/END-GOAL-FEATURES.md §15.4, analog Teil 2
    // in `omp-source`) — nur im Video-Profil tatsächlich verwendet.
    let lowres_video_flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        has_video,
        video_flow_id: video_flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        lowres_video_flow_id: lowres_video_flow_id.clone(),
        label: label.clone(),
        width,
        height,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_thread =
        std::thread::spawn(move || pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx));

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-player: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-player: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    // Kapitel 15 Teil 4: `urn:x-nmos:tag:grouphint/v1.0` gegen die echte
    // AMWA-NMOS-Parameter-Registry verifiziert (Kapitel 15 Teil 2,
    // docs/decisions.md Nachtrag 37) — Format "<group>:<role>", Gruppe =
    // Highres-Flow-UUID.
    let grouphint_group = video_flow_id.clone();
    let mut senders = Vec::with_capacity(3);
    if has_video {
        senders.push(SenderSpec {
            id: Some(omp_node_sdk::idgen::new_v4()),
            transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
            flow: Some(omp_node_sdk::node::FlowSpec::Video {
                id: Some(video_flow_id),
                frame_width: width,
                frame_height: height,
                grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
                grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
            }),
            tags: HashMap::from([(
                "urn:x-nmos:tag:grouphint/v1.0".to_string(),
                vec![format!("{grouphint_group}:high")],
            )]),
            ..Default::default()
        });
        senders.push(SenderSpec {
            id: Some(omp_node_sdk::idgen::new_v4()),
            transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
            flow: Some(omp_node_sdk::node::FlowSpec::Video {
                id: Some(lowres_video_flow_id.clone()),
                frame_width: pipeline::LOWRES_WIDTH,
                frame_height: pipeline::LOWRES_HEIGHT,
                grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
                grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
            }),
            label: Some(format!("{label} Lowres")),
            tags: HashMap::from([(
                "urn:x-nmos:tag:grouphint/v1.0".to_string(),
                vec![format!("{grouphint_group}:low")],
            )]),
            ..Default::default()
        });
    }
    senders.push(SenderSpec {
        id: Some(omp_node_sdk::idgen::new_v4()),
        transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
        flow: Some(omp_node_sdk::node::FlowSpec::Audio {
            id: Some(audio_flow_id),
            sample_rate_numerator: pipeline::SAMPLE_RATE,
            channel_count: pipeline::CHANNELS,
            media_type: "audio/float32".to_string(),
            bit_depth: 32,
        }),
        ..Default::default()
    });

    let state = Mutex::new(PlayerState {
        items: Vec::new(),
        onair_slot: Slot::A,
        onair_item: None,
        cued_item: None,
        onair_since: None,
    });
    let media_ready_pipeline = pipeline_handle.clone();
    let store: Arc<dyn ParamStore> = Arc::new(PlayerStore {
        state,
        next_seq: AtomicU64::new(1),
        pipeline: pipeline_handle,
        has_video,
        media_dir,
        lowres_flow_id: lowres_video_flow_id,
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders,
            receivers: vec![],
            instance_id,
            // "media-ready" über PipelineHandle::media_ready()
            // (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2): Audio
            // immer erforderlich, Video nur im Video-Profil.
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready_pipeline.media_ready()
            })),
        },
        store,
    )
    .await?;

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-player: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
                pipeline::Event::ItemEnded { item_id } => {
                    handle.publish_item_ended(&item_id).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-player: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-player: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}
