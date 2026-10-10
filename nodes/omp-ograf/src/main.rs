//! omp-ograf: OGraf-Grafik-Microservice (`UMSETZUNG.md` K5-Teil-1,
//! `docs/END-GOAL-FEATURES.md` §5). Rendert genau ein EBU-OGraf-v1-
//! Template gleichzeitig (Mehrfach-Instanzen/Layer `full`/Pre-Cue/
//! adaptive Render-Rate sind K5-Teil-3) über `wpesrc` (Variante A,
//! Go-Entscheidung K5-Teil-0, `docs/decisions.md` 2026-07-15) als zwei
//! MXL-`video/v210`-Flows (Fill + Key — Fallback statt eines nativen
//! `video/v210a`-Einzelflows, Begründung in `pipeline.rs`). Der
//! Mixer-DSK-Anschluss (Empfängerseite) ist K5-Teil-2.

mod layers;
mod pipeline;
mod subtitles;
mod templates;
mod uibundle;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use omp_node_sdk::is04::TRANSPORT_MXL;
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    RawResponse, SenderSpec, SetError,
};
use serde_json::Value;
use templates::TemplateInfo;

struct OgrafStore {
    templates: Vec<TemplateInfo>,
    /// Gleichzeitig sichtbare Grafik-Ebenen (s. layers.rs).
    layers: Mutex<layers::Layers>,
    templates_root: PathBuf,
    lowres_flow_id: String,
    pipeline: pipeline::PipelineHandle,
    /// Kapitel 27 / P9.4: Untertitel-Engine (s. `subtitles.rs`).
    subtitle_dir: PathBuf,
    subtitle_track: Mutex<Option<subtitles::Track>>,
    subtitle_play: Mutex<Option<subtitles::Playback>>,
    /// Für den Ticker-Thread (ruft `show`/`update`/`hide` des Stores auf, ohne Referenzzyklus).
    self_ref: std::sync::OnceLock<std::sync::Weak<dyn ParamStore>>,
}

/// Ebene und Template der Untertitel im OGraf-Pfad.
const SUBTITLE_LAYER: &str = "subtitle";

impl OgrafStore {
    fn subtitle_args(v: Value) -> serde_json::Map<String, Value> {
        v.as_object().cloned().unwrap_or_default()
    }

    fn subtitle_state(&self) -> Value {
        let play = self.subtitle_play.lock().expect("lock poisoned");
        let sel = self.subtitle_track.lock().expect("lock poisoned");
        serde_json::json!({
            "selected": sel.as_ref().map(|t| t.id.clone()),
            "running": play.is_some(),
            "positionMs": play.as_ref().map(|p| p.position_ms()),
            "text": play.as_ref().map(|p| p.last_text.clone()).unwrap_or_default(),
            "tracks": subtitles::list_tracks(&self.subtitle_dir),
        })
    }

    fn subtitle_invoke(&self, method: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let msg = |e: String| InvokeError::Message(e);
        match method {
            "load" | "select" => {
                let id = args.get("track").and_then(Value::as_str).ok_or_else(|| msg("track fehlt".to_string()))?;
                let t = subtitles::load_track(&self.subtitle_dir, id).map_err(msg)?;
                *self.subtitle_track.lock().expect("lock poisoned") = Some(t);
                Ok(())
            }
            "start" => {
                if let Some(id) = args.get("track").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    let t = subtitles::load_track(&self.subtitle_dir, id).map_err(msg)?;
                    *self.subtitle_track.lock().expect("lock poisoned") = Some(t);
                }
                let track = self.subtitle_track.lock().expect("lock poisoned").clone().ok_or_else(|| msg("keine Spur gewählt (subtitle.select/load oder track)".to_string()))?;
                let offset = args.get("offsetMs").and_then(Value::as_u64).unwrap_or(0);
                // Ebene sichtbar machen (leerer Text), dann läuft der Ticker.
                self.invoke("show", &Self::subtitle_args(serde_json::json!({"templateId": "subtitle", "layerId": SUBTITLE_LAYER, "data": {"text": ""}}))).map_err(|_| msg("Template „subtitle“ nicht gefunden (data/ograf-templates/subtitle)".to_string()))?;
                *self.subtitle_play.lock().expect("lock poisoned") = Some(subtitles::Playback::new(track, offset));
                self.spawn_ticker();
                Ok(())
            }
            "tick" => {
                // Ereignisse außerhalb der Sperre ausführen.
                let (update, finished) = {
                    let mut g = self.subtitle_play.lock().expect("lock poisoned");
                    match g.as_mut() {
                        Some(p) => (p.changed_text(), p.finished()),
                        None => return Ok(()),
                    }
                };
                if let Some(text) = update {
                    let _ = self.invoke("update", &Self::subtitle_args(serde_json::json!({"layerId": SUBTITLE_LAYER, "data": {"text": text}})));
                }
                if finished {
                    return self.subtitle_invoke("stop", args);
                }
                Ok(())
            }
            "stop" => {
                let was_running = self.subtitle_play.lock().expect("lock poisoned").take().is_some();
                if was_running {
                    let _ = self.invoke("hide", &Self::subtitle_args(serde_json::json!({"layerId": SUBTITLE_LAYER})));
                }
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    /// Ein Thread je Prozess, beendet sich mit dem Store; prüft alle 60 ms den aktuellen Cue.
    fn spawn_ticker(&self) {
        static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(weak) = self.self_ref.get().cloned() else { return };
        std::thread::Builder::new()
            .name("omp-ograf-subtitles".into())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(60));
                let Some(store) = weak.upgrade() else { break };
                let _ = store.invoke("subtitle.tick", &Default::default());
            })
            .ok();
    }
}

impl ParamStore for OgrafStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                ParamSpec {
                    name: "templates".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "current".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                // Alle gerade sichtbaren Ebenen als JSON-Array (id, templateId,
                // label, data, step, stepCount, hasContinue, canContinue) —
                // Grundlage der "On Air"-Liste im Panel.
                ParamSpec {
                    name: "layers".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                // Kapitel 15 Teil 4 (docs/END-GOAL-FEATURES.md §15.4):
                // nur Fill bekommt einen Lowres-Begleiter, s. pipeline.rs
                // `LOWRES_WIDTH`-Doku.
                ParamSpec {
                    name: "lowresFlowId".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "lowresActive".to_string(),
                    kind: ParamType::Boolean,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                // Kapitel 27 / P9.4: Untertitel-Engine (JSON: selected, running, positionMs, text, tracks).
                ParamSpec { name: "subtitle".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ],
            methods: vec![
                MethodSpec { name: "subtitle.load".to_string(), args: vec![MethodArg { name: "track".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "subtitle.select".to_string(), args: vec![MethodArg { name: "track".to_string(), kind: ParamType::String }] },
                MethodSpec {
                    name: "subtitle.start".to_string(),
                    args: vec![MethodArg { name: "track".to_string(), kind: ParamType::String }, MethodArg { name: "offsetMs".to_string(), kind: ParamType::Number }],
                },
                MethodSpec { name: "subtitle.stop".to_string(), args: vec![] },
                MethodSpec {
                    name: "show".to_string(),
                    args: vec![
                        MethodArg {
                            name: "templateId".to_string(),
                            kind: ParamType::String,
                        },
                        MethodArg {
                            name: "data".to_string(),
                            kind: ParamType::String,
                        },
                        // Optional: Ebenen-ID (Standard = templateId, also
                        // eine Ebene je Template).
                        MethodArg {
                            name: "layerId".to_string(),
                            kind: ParamType::String,
                        },
                    ],
                },
                MethodSpec {
                    name: "update".to_string(),
                    args: vec![
                        MethodArg {
                            name: "layerId".to_string(),
                            kind: ParamType::String,
                        },
                        MethodArg {
                            name: "data".to_string(),
                            kind: ParamType::String,
                        },
                    ],
                },
                MethodSpec {
                    name: "continue".to_string(),
                    args: vec![MethodArg {
                        name: "layerId".to_string(),
                        kind: ParamType::String,
                    }],
                },
                MethodSpec {
                    name: "hide".to_string(),
                    // layerId optional: ohne alle Ebenen ausblenden.
                    args: vec![MethodArg {
                        name: "layerId".to_string(),
                        kind: ParamType::String,
                    }],
                },
                MethodSpec {
                    name: "activateLowresPreview".to_string(),
                    args: vec![],
                },
                MethodSpec {
                    name: "releaseLowresPreview".to_string(),
                    args: vec![],
                },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        if name == "subtitle" {
            return Some(self.subtitle_state());
        }
        match name {
            "templates" => Some(serde_json::json!(
                self.templates
                    .iter()
                    .map(TemplateInfo::to_descriptor_json)
                    .collect::<Vec<_>>()
            )),
            "current" => Some(serde_json::json!(
                self.layers.lock().expect("lock poisoned").current_template()
            )),
            "layers" => Some(self.layers.lock().expect("lock poisoned").to_json()),
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
            "activateLowresPreview" => {
                self.pipeline.activate_lowres_preview();
                Ok(())
            }
            "releaseLowresPreview" => {
                self.pipeline.release_lowres_preview();
                Ok(())
            }
            "show" => {
                let template_id = args
                    .get("templateId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let info = templates::find_by_id(&self.templates, template_id)
                    .ok_or(InvokeError::Unknown)?;
                let (dir, main) = templates::module_url(info);
                let mut data = templates::schema_defaults(&info.schema);
                if let Some(Value::Object(overrides)) = args.get("data") {
                    if let Value::Object(map) = &mut data {
                        for (k, v) in overrides {
                            map.insert(k.clone(), v.clone());
                        }
                    }
                }
                let layer_id = args
                    .get("layerId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(template_id)
                    .to_string();
                self.layers
                    .lock()
                    .expect("lock poisoned")
                    .show(&layer_id, info, data.clone());
                self.pipeline.send(pipeline::Command::Show {
                    layer_id,
                    template_id: template_id.to_string(),
                    dir,
                    main,
                    data,
                });
                Ok(())
            }
            "update" => {
                let layer_id = args
                    .get("layerId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let Some(Value::Object(patch)) = args.get("data") else {
                    return Err(InvokeError::Unknown);
                };
                let full = self
                    .layers
                    .lock()
                    .expect("lock poisoned")
                    .update(layer_id, patch)
                    .ok_or(InvokeError::Unknown)?;
                self.pipeline.send(pipeline::Command::Update {
                    layer_id: layer_id.to_string(),
                    data: full,
                });
                Ok(())
            }
            "continue" => {
                let mut layers = self.layers.lock().expect("lock poisoned");
                // Ohne ID nur eindeutig, wenn genau eine Ebene on air ist.
                let layer_id = match args.get("layerId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    Some(id) => id.to_string(),
                    None => layers.only().map(|l| l.id.clone()).ok_or(InvokeError::Unknown)?,
                };
                if !layers.contains(&layer_id) {
                    return Err(InvokeError::Unknown);
                }
                // Am letzten Schritt bzw. bei einstufigen Templates: kein Effekt.
                if let Some(step) = layers.advance(&layer_id) {
                    self.pipeline.send(pipeline::Command::Continue { layer_id, step });
                }
                Ok(())
            }
            "hide" => {
                let id = args.get("layerId").and_then(Value::as_str).filter(|s| !s.is_empty());
                let removed = self.layers.lock().expect("lock poisoned").hide(id);
                // Eine unbekannte/bereits ausgeblendete Ebene ist kein Fehler
                // (idempotent), schickt aber auch nichts an die Pipeline.
                if id.is_none() || !removed.is_empty() {
                    self.pipeline.send(pipeline::Command::Hide { layer_id: id.map(str::to_string) });
                }
                Ok(())
            }
            _ if name.starts_with("subtitle.") => self.subtitle_invoke(&name["subtitle.".len()..], args),
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, _body: &[u8]) -> Option<RawResponse> {
        uibundle::route(method, path).or_else(|| templates::route(&self.templates_root, method, path))
    }
}

/// Nur für die Harness-Seite (s. `spawn_harness_server` unten) — kein
/// Descriptor/Params/Methods, davon ruft niemand darüber je etwas ab.
struct HarnessOnlyStore {
    templates_root: PathBuf,
}

impl ParamStore for HarnessOnlyStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![],
            methods: vec![],
        }
    }

    fn get(&self, _name: &str) -> Option<Value> {
        None
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, _name: &str, _args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }

    fn extra_route(&self, method: &str, path: &str, _body: &[u8]) -> Option<RawResponse> {
        templates::route(&self.templates_root, method, path)
    }
}

/// Startet einen eigenen, minimalen HTTP-Server NUR für die Harness-Seite
/// + Template-Dateien, auf einem OS-zugewiesenen Port — gebraucht, weil
/// `wpesrc` die Harness-Seite schon beim Pipeline-Aufbau lädt (`Pipeline::
/// build`, vor `omp_node_sdk::start()`s eigenem Descriptor-Server). Live-
/// Test-Fund (K5-Teil-1, docs/decisions.md 2026-07-16): ohne diesen
/// eigenen Server lief `wpesrc`s Seitenaufruf regelmäßig ins Leere
/// ("Connection refused"), weil der normale Descriptor-Server zu diesem
/// Zeitpunkt im Programmablauf noch gar nicht gebunden war (der braucht
/// wiederum den fertigen `PipelineHandle` für `OgrafStore` — klassisches
/// Henne-Ei-Problem). `server::spawn` bindet synchron (der Port ist also
/// sofort verbindungsfähig, auch bevor die Accept-Loop im eigenen Thread
/// tatsächlich läuft — Verbindungen warten im Kernel-Backlog) und liefert
/// den zugewiesenen Port zurück.
fn spawn_harness_server(templates_root: PathBuf) -> std::io::Result<u16> {
    let store: Arc<dyn ParamStore> = Arc::new(HarnessOnlyStore { templates_root });
    let (port, _join_handle) = omp_node_sdk::server::spawn("127.0.0.1:0", store)?;
    Ok(port)
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "OGraf");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9330").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let templates_root = PathBuf::from(env_or("OMP_OGRAF_TEMPLATES", "data/ograf-templates"));
    std::fs::create_dir_all(&templates_root).ok();
    subtitles::ensure_builtin_template(&templates_root);
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let templates = templates::scan_templates(&templates_root);
    eprintln!(
        "omp-ograf: {} Template(s) gefunden in {}",
        templates.len(),
        templates_root.display()
    );

    let fill_flow_id = omp_node_sdk::idgen::new_v4();
    let key_flow_id = omp_node_sdk::idgen::new_v4();
    // Kapitel 15 Teil 4 (docs/END-GOAL-FEATURES.md §15.4): Fill-Lowres-
    // Begleit-Flow, referenzgezählt zu-/abschaltbar (identisch zu
    // omp-source/omp-player, Nutzerentscheidung 2026-07-20: nur Fill,
    // nicht Key).
    let lowres_flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    // Eigener, früh gebundener Mini-Server nur für die Harness-Seite +
    // Templates (s. `spawn_harness_server`-Doku) — der reguläre
    // Descriptor-Server (unten, `omp_node_sdk::start`) bedient dieselben
    // Pfade zusätzlich (`OgrafStore::extra_route`), node-lokal ohne Auth
    // (gleiche Begründung wie `omp-audio-mixer::levels`), aber `wpesrc`
    // braucht die Seite schon vor dessen Start.
    let harness_port = spawn_harness_server(templates_root.clone())?;
    let harness_url = format!("http://127.0.0.1:{harness_port}/ograf-harness.html");

    let pipeline_config = pipeline::Config {
        domain,
        fill_flow_id: fill_flow_id.clone(),
        key_flow_id: key_flow_id.clone(),
        lowres_flow_id: lowres_flow_id.clone(),
        label: label.clone(),
        harness_url,
        width: pipeline::WIDTH,
        height: pipeline::HEIGHT,
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
            eprintln!("omp-ograf: pipeline build failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-ograf: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let media_ready_pipeline = pipeline_handle.clone();
    let key_bridge_heartbeat = pipeline_handle.key_bridge_heartbeat_handle();
    let main_loop_heartbeat = pipeline_handle.main_loop_heartbeat_handle();

    let concrete = Arc::new(OgrafStore {
        templates,
        layers: Mutex::new(layers::Layers::default()),
        templates_root,
        lowres_flow_id: lowres_flow_id.clone(),
        pipeline: pipeline_handle,
        subtitle_dir: PathBuf::from(env_or("OMP_SUBTITLE_DIR", "data/subtitles")),
        subtitle_track: Mutex::new(None),
        subtitle_play: Mutex::new(None),
        self_ref: std::sync::OnceLock::new(),
    });
    // Rückverweis für den Untertitel-Ticker (kein Zyklus: schwache Referenz).
    let store: Arc<dyn ParamStore> = concrete.clone();
    let _ = concrete.self_ref.set(Arc::downgrade(&store));

    // Port-Labels (Nutzerfund 2026-07-16, §22 Flow-Editor-Lesbarkeit):
    // ohne eigenes Label sähe man an der Kachel nur zwei gleich benannte
    // "OGraf Sender 1/2" — nicht erkennbar, welcher Port Fill (Bild) bzw.
    // Key (Alpha) führt. Vor der `NodeConfig`-Konstruktion berechnet, weil
    // `label` dort per Shorthand in ein eigenes Feld verschoben wird.
    let fill_label = format!("{label} Fill");
    let key_label = format!("{label} Key");
    let lowres_label = format!("{label} Fill Lowres");

    // Kapitel 15 Teil 4 (docs/END-GOAL-FEATURES.md §15.3b, gleiches
    // Format wie omp-source/omp-player): `urn:x-nmos:tag:grouphint/v1.0`
    // "<group>:<role>" — `fill_flow_id` als Gruppenname (stabil, pro
    // Instanz eindeutig). Nur Fill bekommt das Tag, Key bleibt
    // unangetastet (kein Lowres-Begleiter für Key, s. pipeline.rs).
    let fill_group_name = fill_flow_id.clone();
    let lowres_group_name = fill_flow_id.clone();

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Video {
                        id: Some(fill_flow_id),
                        frame_width: pipeline::WIDTH,
                        frame_height: pipeline::HEIGHT,
                        grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
                        grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
                    }),
                    label: Some(fill_label),
                    tags: std::collections::HashMap::from([(
                        "urn:x-nmos:tag:grouphint/v1.0".to_string(),
                        vec![format!("{fill_group_name}:high")],
                    )]),
                    ..Default::default()
                },
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Video {
                        id: Some(key_flow_id),
                        frame_width: pipeline::WIDTH,
                        frame_height: pipeline::HEIGHT,
                        grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
                        grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
                    }),
                    label: Some(key_label),
                    ..Default::default()
                },
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Video {
                        id: Some(lowres_flow_id),
                        frame_width: pipeline::LOWRES_WIDTH,
                        frame_height: pipeline::LOWRES_HEIGHT,
                        grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
                        grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
                    }),
                    label: Some(lowres_label),
                    tags: std::collections::HashMap::from([(
                        "urn:x-nmos:tag:grouphint/v1.0".to_string(),
                        vec![format!("{lowres_group_name}:low")],
                    )]),
                    ..Default::default()
                },
            ],
            receivers: vec![],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready_pipeline.media_ready()
            })),
        },
        store,
    )
    .await?;

    // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
    // Nachtrag 130-132).
    handle.register_worker("pipeline", pipeline_heartbeat);
    handle.register_worker("alpha-key-bridge", key_bridge_heartbeat);
    handle.register_worker("glib-main-loop", main_loop_heartbeat);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-ograf: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-ograf: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-ograf: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}
