//! omp-mxf-player: MXF-Player mit Programmgruppen-Audio-Shuffle nach
//! `Audio Tonspurerweiterung Q3 2026 PD.pdf` (ORF-intern,
//! `/home/infantilo/`) — liest die 8 MXF-Audiotonspuren einer Datei und
//! ordnet sie je nach gewähltem Preset (`presets.rs`, 13 offizielle
//! Status ab 15.9.2026) fünf gleichzeitig aktiven, klar beschrifteten
//! MXL-Sendern zu: Programmton, Hörfilm/AD, Originalton, Dolby E
//! (Bit-exakter Durchgriff, keine Mischung), 5.1 diskret. Plus einem
//! Video-Sender (Codec generisch über `decodebin` — MPEG-2 heute,
//! XAVC-100/300 künftig ohne Code-Änderung).
//!
//! Architektur/Node-Contract eng an `omp-player` angelehnt (A/B-Slot-
//! Cue/Take, `append`/`load`/`remove`/`cue`/`take`, s. `pipeline.rs`-
//! Moduldoku für die Abweichungen) — bewusst OHNE `omp-player`s
//! `TestPattern`/`Live`-Item-Typen (dort C21/§0-Punkt-7-Scope, hier nicht
//! gebraucht) und ohne eigenes UI-Bundle (mehrere gleichartige,
//! sprechend beschriftete Sender werden vom Flow-Editor bereits generisch
//! dargestellt, s. Plan-Dokument — kein Sonderfall wie bei
//! `omp-player`s Cue/Take- bzw. Cart-Wall-Oberflächen).

mod orchestrator_settings;
mod pipeline;
mod presets;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use gstreamer as gst;
use gstreamer_pbutils as gst_pbutils;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    Range, SenderSpec, SetError,
};
use pipeline::{PipelineHandle, Slot};
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone)]
struct PlaylistItem {
    id: String,
    label: String,
    file: String,
    audio_preset: String,
    duration_ms: u64,
}

struct PlayerState {
    items: Vec<PlaylistItem>,
    onair_slot: Slot,
    onair_item: Option<String>,
    cued_item: Option<String>,
    onair_since: Option<Instant>,
}

struct PlayerStore {
    state: Mutex<PlayerState>,
    next_seq: AtomicU64,
    pipeline: PipelineHandle,
    media_dir: PathBuf,
    // Vom Orchestrator geladen (oder presets::default_settings()-
    // Fallback) — s. orchestrator_settings.rs-Moduldoku. Feststehend für
    // die Lebensdauer dieses Prozesses (Nutzerentscheidung: Änderungen
    // an Programmgruppen/Presets wirken erst nach einem Neustart).
    groups: Vec<presets::ProgramGroup>,
    shuffle_presets: Vec<presets::AudioPreset>,
}

const DEFAULT_DURATION_MS: u64 = 5000;
/// Default-Preset für Items ohne explizite Angabe — "Stereo" ist der
/// verbreitetste, verlustloseste Fallback (reine PT-Zuordnung, keine
/// Annahme über AD/OT/Dolby-Vorhandensein).
const DEFAULT_PRESET: &str = "stereo";

/// Löst einen vom Aufrufer übergebenen, relativen Dateipfad gegen
/// `media_dir` auf — identische Traversal-Absicherung wie
/// `omp-player::resolve_media_path` (`canonicalize()` + `starts_with`).
fn resolve_media_path(media_dir: &Path, rel: &str) -> Result<PathBuf, InvokeError> {
    let candidate = media_dir.join(rel);
    let canonical = candidate.canonicalize().map_err(|_| InvokeError::Unknown)?;
    let canonical_dir = media_dir.canonicalize().map_err(|_| InvokeError::Unknown)?;
    if !canonical.starts_with(&canonical_dir) {
        return Err(InvokeError::Unknown);
    }
    Ok(canonical)
}

/// Einmalige Dauer-Probe per `gst_pbutils::Discoverer` — identisches
/// Muster wie `omp-player::probe_duration_ms`, hier gegen den absoluten
/// Dateipfad statt einer `file://`-URI (`mxfdemux` braucht keine URI-
/// Auflösung, `Discoverer::discover_uri` aber schon: `filename_to_uri`
/// analog `omp-player::file_uri`).
///
/// Läuft wie `omp-player::probe_duration_ms` auf einem eigenen,
/// zeit-gedeckelten Thread statt direkt im `append()`-Aufrufpfad:
/// `mxfdemux`s bekannter Thread-Leak (Nachtrag 121, `docs/
/// decisions.md` — Demuxer-Threads überleben ihren eigenen bestätigten
/// `NULL`-Übergang) kann `discover_uri()`s internen Pipeline-Teardown
/// weit über dessen nominellen 5s-Timeout hinaus blockieren; da dieser
/// Node genau EIN Format bedient (MXF), träfe das hier JEDE `append()`-
/// Dauerprobe potenziell, nicht nur Einzelfälle. Ein Hänger im
/// einzigen Accept-Loop-Thread des Node-Servers würde sonst nicht nur
/// diesen Aufruf, sondern den gesamten Node auf unbestimmte Zeit
/// einfrieren.
fn probe_duration_ms(path: &Path) -> Option<u64> {
    let path = path.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = gst::init();
        let result = (|| -> Option<u64> {
            let uri = gst::glib::filename_to_uri(&path, None).ok()?;
            let discoverer = gst_pbutils::Discoverer::new(gst::ClockTime::from_seconds(5)).ok()?;
            let info = discoverer.discover_uri(uri.as_str()).ok()?;
            info.duration().map(|d| d.mseconds())
        })();
        let _ = tx.send(result);
    });
    rx.recv_timeout(std::time::Duration::from_secs(8)).ok().flatten()
}

fn resolve_preset_id(presets_list: &[presets::AudioPreset], requested: Option<&str>) -> String {
    requested
        .filter(|s| !s.is_empty() && presets::find_preset(presets_list, s).is_some())
        .or_else(|| presets_list.iter().find(|p| p.id == DEFAULT_PRESET).map(|_| DEFAULT_PRESET))
        .or_else(|| presets_list.first().map(|p| p.id.as_str()))
        .unwrap_or(DEFAULT_PRESET)
        .to_string()
}

#[derive(Deserialize)]
struct LoadItem {
    label: String,
    file: String,
    #[serde(rename = "audioPreset", default)]
    audio_preset: Option<String>,
    #[serde(rename = "durationMs", default)]
    duration_ms: Option<u64>,
}

impl ParamStore for PlayerStore {
    fn descriptor(&self) -> Descriptor {
        let parameters = vec![
            // JSON-Array [{id,label,file,audioPreset,durationMs}].
            ParamSpec { name: "items".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "currentItemId".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "cuedItemId".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec {
                name: "mode".to_string(),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum { values: vec!["black".to_string(), "onair".to_string()] }),
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
            // (gleiches flaches Muster wie omp-player::mediaLibrary).
            ParamSpec { name: "mediaLibrary".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            // JSON-Array [{id,label,channels}] — die 5 Programmgruppen.
            ParamSpec { name: "programGroups".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            // JSON-Array [{id,label}] — die 13 Shuffle-Presets.
            ParamSpec { name: "shufflePresets".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
        ];

        let methods = vec![
            MethodSpec {
                name: "append".to_string(),
                args: vec![
                    MethodArg { name: "label".to_string(), kind: ParamType::String },
                    MethodArg { name: "file".to_string(), kind: ParamType::String },
                    MethodArg { name: "audioPreset".to_string(), kind: ParamType::String },
                    MethodArg { name: "durationMs".to_string(), kind: ParamType::Number },
                ],
            },
            MethodSpec {
                name: "load".to_string(),
                args: vec![MethodArg { name: "itemsJson".to_string(), kind: ParamType::String }],
            },
            MethodSpec {
                name: "remove".to_string(),
                args: vec![MethodArg { name: "itemId".to_string(), kind: ParamType::String }],
            },
            MethodSpec {
                name: "setItemPreset".to_string(),
                args: vec![
                    MethodArg { name: "itemId".to_string(), kind: ParamType::String },
                    MethodArg { name: "audioPreset".to_string(), kind: ParamType::String },
                ],
            },
            MethodSpec { name: "cue".to_string(), args: vec![MethodArg { name: "itemId".to_string(), kind: ParamType::String }] },
            MethodSpec { name: "take".to_string(), args: vec![] },
        ];

        Descriptor { parameters, methods, latency: None }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let state = self.state.lock().expect("lock poisoned");
        match name {
            "items" => Some(serde_json::json!(
                state
                    .items
                    .iter()
                    .map(|it| serde_json::json!({
                        "id": it.id,
                        "label": it.label,
                        "file": it.file,
                        "audioPreset": it.audio_preset,
                        "durationMs": it.duration_ms,
                    }))
                    .collect::<Vec<_>>()
            )),
            "currentItemId" => Some(serde_json::json!(state.onair_item.clone().unwrap_or_default())),
            "cuedItemId" => Some(serde_json::json!(state.cued_item.clone().unwrap_or_default())),
            "mode" => Some(serde_json::json!(if state.onair_item.is_some() { "onair" } else { "black" })),
            "playheadPositionMs" => Some(serde_json::json!(
                state.onair_since.map(|since| since.elapsed().as_millis() as f64).unwrap_or(0.0)
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
            "programGroups" => Some(serde_json::json!(
                self.groups
                    .iter()
                    .map(|g| serde_json::json!({"id": g.id, "label": g.label, "channels": g.channels}))
                    .collect::<Vec<_>>()
            )),
            "shufflePresets" => Some(serde_json::json!(
                self.shuffle_presets
                    .iter()
                    .map(|p| serde_json::json!({"id": p.id, "label": p.label}))
                    .collect::<Vec<_>>()
            )),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "append" => {
                let label = args.get("label").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
                let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
                let file = args.get("file").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or(InvokeError::Unknown)?;
                let abs = resolve_media_path(&self.media_dir, file)?;
                let duration_ms = args
                    .get("durationMs")
                    .and_then(Value::as_f64)
                    .filter(|d| *d > 0.0)
                    .map(|d| d as u64)
                    .or_else(|| probe_duration_ms(&abs))
                    .unwrap_or(DEFAULT_DURATION_MS);
                let audio_preset = resolve_preset_id(&self.shuffle_presets, args.get("audioPreset").and_then(Value::as_str));
                let label = label.unwrap_or_else(|| format!("Item {seq}"));
                self.state.lock().expect("lock poisoned").items.push(PlaylistItem {
                    id: format!("item{seq}"),
                    label,
                    file: file.to_string(),
                    audio_preset,
                    duration_ms,
                });
                Ok(())
            }
            "load" => {
                let items_json = args.get("itemsJson").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let load_items: Vec<LoadItem> = serde_json::from_str(items_json).map_err(|_| InvokeError::Unknown)?;
                let mut items = Vec::with_capacity(load_items.len());
                for li in load_items {
                    let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
                    let abs = resolve_media_path(&self.media_dir, &li.file)?;
                    let duration_ms = li
                        .duration_ms
                        .filter(|d| *d > 0)
                        .or_else(|| probe_duration_ms(&abs))
                        .unwrap_or(DEFAULT_DURATION_MS);
                    items.push(PlaylistItem {
                        id: format!("item{seq}"),
                        label: li.label,
                        file: li.file,
                        audio_preset: resolve_preset_id(&self.shuffle_presets, li.audio_preset.as_deref()),
                        duration_ms,
                    });
                }
                let mut state = self.state.lock().expect("lock poisoned");
                state.items = items;
                state.onair_item = None;
                state.cued_item = None;
                state.onair_since = None;
                self.pipeline.load_slot(Slot::A, pipeline::ItemSource::TestPattern);
                self.pipeline.load_slot(Slot::B, pipeline::ItemSource::TestPattern);
                state.onair_slot = Slot::A;
                self.pipeline.set_active(Slot::A);
                Ok(())
            }
            "remove" => {
                let item_id = args.get("itemId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let mut state = self.state.lock().expect("lock poisoned");
                if state.onair_item.as_deref() == Some(item_id) || state.cued_item.as_deref() == Some(item_id) {
                    return Err(InvokeError::Unknown);
                }
                let before = state.items.len();
                state.items.retain(|it| it.id != item_id);
                if state.items.len() == before {
                    return Err(InvokeError::Unknown);
                }
                Ok(())
            }
            "setItemPreset" => {
                let item_id = args.get("itemId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let preset_id = args.get("audioPreset").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                if presets::find_preset(&self.shuffle_presets, preset_id).is_none() {
                    return Err(InvokeError::Unknown);
                }
                let mut state = self.state.lock().expect("lock poisoned");
                let item = state.items.iter_mut().find(|it| it.id == item_id).ok_or(InvokeError::Unknown)?;
                item.audio_preset = preset_id.to_string();
                Ok(())
            }
            "cue" => {
                let item_id = args.get("itemId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                let state = self.state.lock().expect("lock poisoned");
                let item = state.items.iter().find(|it| it.id == item_id).cloned().ok_or(InvokeError::Unknown)?;
                let target_slot = state.onair_slot.other();
                drop(state);
                let abs = resolve_media_path(&self.media_dir, &item.file)?;
                self.pipeline.load_slot(
                    target_slot,
                    pipeline::ItemSource::Mxf {
                        path: abs.to_string_lossy().to_string(),
                        preset_id: item.audio_preset.clone(),
                    },
                );
                self.state.lock().expect("lock poisoned").cued_item = Some(item_id.to_string());
                Ok(())
            }
            "take" => {
                let mut state = self.state.lock().expect("lock poisoned");
                let Some(cued_item) = state.cued_item.take() else { return Err(InvokeError::Unknown) };
                let target_slot = state.onair_slot.other();
                self.pipeline.set_active(target_slot);
                state.onair_slot = target_slot;
                state.onair_item = Some(cued_item);
                state.onair_since = Some(Instant::now());
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "MXF Player");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9395").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let width: u32 = env_or("OMP_WIDTH", "").parse().unwrap_or(pipeline::DEFAULT_WIDTH);
    let height: u32 = env_or("OMP_HEIGHT", "").parse().unwrap_or(pipeline::DEFAULT_HEIGHT);
    // ARCHITECTURE.md §24.1 (gleiches Muster wie omp-playout-automation):
    // Basis-URL des Orchestrators + eigenes Launch-Secret, um sich vor
    // dem Pipeline-Aufbau die Programmgruppen/Shuffle-Presets zu holen
    // (orchestrator_settings.rs) statt presets.rs' eingebaute
    // ORF-Standardwerte fest zu verdrahten (Nutzerwunsch 2026-08-06).
    let orchestrator_url = env_or("OMP_ORCHESTRATOR_URL", "http://localhost:8000");
    let launch_secret = std::env::var("OMP_LAUNCH_SECRET").unwrap_or_default();

    let media_dir = PathBuf::from(env_or("OMP_MEDIA_DIR", "data/media"));
    if let Err(e) = std::fs::create_dir_all(&media_dir) {
        eprintln!("omp-mxf-player: OMP_MEDIA_DIR ({media_dir:?}) konnte nicht angelegt werden: {e}");
    }

    let mxf_settings = orchestrator_settings::load_settings(&orchestrator_url, instance_id.as_deref(), &launch_secret);

    let video_flow_id = omp_node_sdk::idgen::new_v4();
    let group_flow_ids: Vec<String> = mxf_settings.groups.iter().map(|_| omp_node_sdk::idgen::new_v4()).collect();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        video_flow_id: video_flow_id.clone(),
        group_flow_ids: group_flow_ids.clone(),
        groups: mxf_settings.groups.clone(),
        presets: mxf_settings.presets.clone(),
        label: label.clone(),
        width,
        height,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let pipeline_heartbeat_thread = pipeline_heartbeat.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx, pipeline_heartbeat_thread)
    });

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-mxf-player: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-mxf-player: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let mut senders = Vec::with_capacity(1 + mxf_settings.groups.len());
    senders.push(SenderSpec {
        transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
        flow: Some(omp_node_sdk::node::FlowSpec::Video {
            id: Some(video_flow_id),
            frame_width: width,
            frame_height: height,
            grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
            grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
        }),
        label: Some(format!("{label} Programm")),
        ..Default::default()
    });
    for (group, flow_id) in mxf_settings.groups.iter().zip(group_flow_ids.into_iter()) {
        senders.push(SenderSpec {
            transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
            flow: Some(omp_node_sdk::node::FlowSpec::Audio {
                id: Some(flow_id),
                sample_rate_numerator: pipeline::SAMPLE_RATE,
                channel_count: group.channels,
                media_type: "audio/float32".to_string(),
                bit_depth: 32,
            }),
            label: Some(format!("{label} {}", group.label)),
            ..Default::default()
        });
    }

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
        media_dir,
        groups: mxf_settings.groups,
        shuffle_presets: mxf_settings.presets,
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
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_ready_pipeline.media_ready())),
        },
        store,
    )
    .await?;

    // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
    // Nachtrag 130/131).
    handle.register_worker("pipeline", pipeline_heartbeat);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-mxf-player: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-mxf-player: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-mxf-player: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}
