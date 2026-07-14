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

mod pipeline;
mod uibundle;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    Range, RawResponse, SenderSpec, SetError,
};
use pipeline::{PipelineHandle, Slot};
use serde::Deserialize;
use serde_json::Value;

/// Playlist-Eintrag — reines Software-Testmittel (`UMSETZUNG.md` §0 Punkt
/// 7): `pattern` ist ein `videotestsrc`-Patternname (nur relevant im
/// Video-Profil), `tone_freq` der Begleitton (immer, auch beim
/// Videoplayer als Slate-Ton-Ersatz). `duration_ms` ist reine Metadaten
/// für `playheadPositionMs` — kein erzwungenes Clip-Ende (s.
/// `pipeline.rs`-Moduldoku).
#[derive(Clone)]
struct PlaylistItem {
    id: String,
    label: String,
    pattern: String,
    tone_freq: f64,
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
}

/// Testton-Frequenz-Formel wie C11s `channel_freq` — nur zur akustischen
/// Unterscheidbarkeit neu angelegter Items, keine funktionale Bedeutung.
fn default_tone_freq(seq: u64) -> f64 {
    220.0 * (1 + (seq % 8)) as f64
}

const DEFAULT_PATTERN: &str = "smpte";
const DEFAULT_DURATION_MS: u64 = 5000;

#[derive(Deserialize)]
struct LoadItem {
    label: String,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(rename = "toneFrequency", default)]
    tone_frequency: Option<f64>,
    #[serde(rename = "durationMs", default)]
    duration_ms: Option<u64>,
}

impl ParamStore for PlayerStore {
    fn descriptor(&self) -> Descriptor {
        let parameters = vec![
            // JSON-Array [{id,label,pattern,toneFrequency,durationMs}] —
            // gleiche Array-Ausnahme wie "channels" bei omp-audio-mixer.
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
        ];

        let methods = vec![
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

        Descriptor { parameters, methods }
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
                        "pattern": it.pattern,
                        "toneFrequency": it.tone_freq,
                        "durationMs": it.duration_ms,
                    }))
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
                let pattern = args
                    .get("pattern")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| DEFAULT_PATTERN.to_string());
                let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
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
                let label = label.unwrap_or_else(|| format!("Item {seq}"));
                let id = format!("item{seq}");
                self.state.lock().expect("lock poisoned").items.push(PlaylistItem {
                    id,
                    label,
                    pattern,
                    tone_freq,
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
                    items.push(PlaylistItem {
                        id: format!("item{seq}"),
                        label: li.label,
                        pattern: li.pattern.filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_PATTERN.to_string()),
                        tone_freq: li.tone_frequency.filter(|f| *f > 0.0).unwrap_or_else(|| default_tone_freq(seq)),
                        duration_ms: li.duration_ms.filter(|d| *d > 0).unwrap_or(DEFAULT_DURATION_MS),
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
                        pattern: "black".to_string(),
                        tone_freq: 0.0,
                    },
                );
                self.pipeline.load_slot(
                    Slot::B,
                    pipeline::Item {
                        pattern: "black".to_string(),
                        tone_freq: 0.0,
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
                self.pipeline.load_slot(
                    target_slot,
                    pipeline::Item {
                        pattern: item.pattern,
                        tone_freq: item.tone_freq,
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

    // "video" (Default) registriert Video- + Audio-MXL-Sender, "jingle"
    // nur Audio — einzige Verzweigung zwischen den beiden §13.3-Rollen
    // (`ARCHITECTURE.md` §13.3 Punkt 2: Default-Konfigurationsprofil).
    let profile = env_or("OMP_PLAYER_PROFILE", "video");
    let has_video = profile != "jingle";

    let video_flow_id = omp_node_sdk::idgen::new_v4();
    let audio_flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        has_video,
        video_flow_id: video_flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        label: label.clone(),
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

    let mut senders = Vec::with_capacity(2);
    if has_video {
        senders.push(SenderSpec {
            id: Some(omp_node_sdk::idgen::new_v4()),
            transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
            flow: Some(omp_node_sdk::node::FlowSpec::Video {
                id: Some(video_flow_id),
                frame_width: pipeline::WIDTH,
                frame_height: pipeline::HEIGHT,
                grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
                grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
            }),
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
    let store: Arc<dyn ParamStore> = Arc::new(PlayerStore {
        state,
        next_seq: AtomicU64::new(1),
        pipeline: pipeline_handle,
        has_video,
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
            // Hat echtes Medien-I/O, aber noch keine Bereitschafts-Probe
            // verdrahtet (dokumentierte Folgearbeit, ARCHITECTURE.md §5
            // Punkt 6, docs/decisions.md D5-prep) - meldet konservativ nie
            // "bereit", statt eine ungeprüfte Bereitschaft vorzutäuschen.
            media_ready: omp_node_sdk::MediaReadySource::Unknown,
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
