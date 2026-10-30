//! omp-ograf: OGraf-Grafik-Microservice (`UMSETZUNG.md` K5-Teil-1,
//! `docs/END-GOAL-FEATURES.md` §5). Rendert genau ein EBU-OGraf-v1-
//! Template gleichzeitig (Mehrfach-Instanzen/Layer `full`/Pre-Cue/
//! adaptive Render-Rate sind K5-Teil-3) über `wpesrc` (Variante A,
//! Go-Entscheidung K5-Teil-0, `docs/decisions.md` 2026-07-15) als zwei
//! MXL-`video/v210`-Flows (Fill + Key — Fallback statt eines nativen
//! `video/v210a`-Einzelflows, Begründung in `pipeline.rs`). Der
//! Mixer-DSK-Anschluss (Empfängerseite) ist K5-Teil-2.

mod layers;
#[cfg(test)]
mod frame_probe;
mod pipeline;
mod subtitles;
mod templates;
mod uibundle;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    RawResponse, ReceiverSpec, SenderSpec, SetError,
};
use serde_json::Value;
use templates::TemplateInfo;

/// IS-05-Steuerung des Eingangs „Zeitcode“ (Daten-Flow mit ST-12-2-Paketen, z. B. „Zeitcode (ANC)“ eines Kanal-Players): die
/// Untertitel-Wiedergabe folgt diesem Zeitcode statt einer freilaufenden Uhr.
struct TimecodeControl {
    registry: RegistryClient,
    context: Arc<omp_mediaio::mxl::MxlContext>,
    input: Arc<omp_mediaio::mxl::TimecodeInput>,
}

impl ReceiverControl for TimecodeControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        if let Err(e) = self.input.connect(self.context.clone(), &flow_id) {
                            eprintln!("omp-ograf: Zeitcode-Eingang {flow_id}: {e}");
                        }
                    }
                    None => eprintln!("omp-ograf: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-ograf: resolve sender {sender_id} failed: {e}"),
            },
            _ => self.input.disconnect(),
        }
    }
}

struct OgrafStore {
    timecode: Arc<omp_mediaio::mxl::TimecodeInput>,
    timecode_connection: Option<Arc<ReceiverConnection<TimecodeControl>>>,
    templates: Vec<TemplateInfo>,
    /// Gleichzeitig sichtbare Grafik-Ebenen (s. layers.rs).
    layers: Mutex<layers::Layers>,
    templates_root: PathBuf,
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
            "clock": play.as_ref().map(|p| p.clock_name()),
            "timecode": self.timecode.display(),
            "text": play.as_ref().map(|p| p.last_text.clone()).unwrap_or_default(),
            "tracks": subtitles::list_tracks(&self.subtitle_dir),
        })
    }

    /// Optionales `atUtcMs`: Befehl zeitgenau (Millisekunde) statt sofort ausführen.
    fn timed(args: &serde_json::Map<String, Value>, cmd: pipeline::Command) -> pipeline::Command {
        match args.get("atUtcMs").and_then(Value::as_i64) {
            Some(at_utc_ms) => pipeline::Command::At { at_utc_ms, inner: Box::new(cmd) },
            None => cmd,
        }
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
                // Uhr: "timecode" folgt dem verbundenen Zeitcode (Bild-genau, auch bei Halt/Seek), "free" läuft ab jetzt frei,
                // "auto" (Standard) folgt dem Zeitcode, wenn einer anliegt.
                let rate = (
                    args.get("fpsNum").and_then(Value::as_u64).unwrap_or(25) as u32,
                    args.get("fpsDen").and_then(Value::as_u64).unwrap_or(1) as u32,
                );
                let clock = args.get("clock").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("auto");
                let have_tc = self.timecode.media_ms(rate.0, rate.1).is_some();
                let playback = match clock {
                    "free" => subtitles::Playback::new(track, offset),
                    "timecode" if !have_tc => return Err(msg("clock=timecode: kein Zeitcode verbunden oder er liegt nicht an (Eingang „Zeitcode“ des Grafik-Nodes verdrahten)".to_string())),
                    "timecode" | "auto" if have_tc => subtitles::Playback::following(track, offset, self.timecode.clone(), rate),
                    "auto" => subtitles::Playback::new(track, offset),
                    other => return Err(msg(format!("clock „{other}“ unbekannt (auto | timecode | free)"))),
                };
                *self.subtitle_play.lock().expect("lock poisoned") = Some(playback);
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
                // Kapitel 27 / P9.4: Untertitel-Engine (JSON: selected, running, positionMs, text, tracks).
                ParamSpec { name: "subtitle".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
                ParamSpec { name: "timecodeFlowId".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ],
            methods: vec![
                MethodSpec { name: "subtitle.load".to_string(), args: vec![MethodArg { name: "track".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "subtitle.select".to_string(), args: vec![MethodArg { name: "track".to_string(), kind: ParamType::String }] },
                MethodSpec {
                    name: "subtitle.start".to_string(),
                    args: vec![
                        MethodArg { name: "track".to_string(), kind: ParamType::String },
                        MethodArg { name: "offsetMs".to_string(), kind: ParamType::Number },
                        // auto (Standard) | timecode | free — s. Untertitel-Engine
                        MethodArg { name: "clock".to_string(), kind: ParamType::String },
                        MethodArg { name: "fpsNum".to_string(), kind: ParamType::Number },
                        MethodArg { name: "fpsDen".to_string(), kind: ParamType::Number },
                    ],
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
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        if name == "subtitle" {
            return Some(self.subtitle_state());
        }
        if name == "timecodeFlowId" {
            return Some(serde_json::json!(self.timecode.connected_flow_id()));
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
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
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
                self.pipeline.send(Self::timed(args, pipeline::Command::Show {
                    layer_id,
                    template_id: template_id.to_string(),
                    dir,
                    main,
                    data,
                }));
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
                    self.pipeline.send(Self::timed(args, pipeline::Command::Hide { layer_id: id.map(str::to_string) }));
                }
                Ok(())
            }
            _ if name.starts_with("subtitle.") => self.subtitle_invoke(&name["subtitle.".len()..], args),
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        if let Some(conn) = &self.timecode_connection
            && let Some((status, content_type, body)) = conn.handle(method, path, body)
        {
            return Some(RawResponse { status, content_type, body });
        }
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

    /// `wpesrc` schickt kein Node-API-Token: ohne diese Freigabe beantwortet der Server die Harness-Seite mit 401 und die
    /// Grafik erscheint als winziger Fehlertext statt als Vorlage. Der Server lauscht nur auf 127.0.0.1 und liefert nur
    /// die statische Harness-Seite und die Vorlagendateien.
    fn public_route(&self, method: &str, _path: &str) -> bool {
        method == "GET"
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
        domain: domain.clone(),
        fill_flow_id: fill_flow_id.clone(),
        key_flow_id: key_flow_id.clone(),
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
            eprintln!("omp-ograf: pipeline build failed: {}", omp_node_sdk::errcode::tag(&e.to_string()));
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

    let timecode = Arc::new(omp_mediaio::mxl::TimecodeInput::new());
    let timecode_receiver_id = omp_node_sdk::idgen::new_v4();
    let timecode_label = format!("{label} Zeitcode");
    let timecode_connection = match omp_mediaio::mxl::MxlContext::new(&domain).map(Arc::new) {
        Ok(ctx) => Some(Arc::new(ReceiverConnection::new(
            timecode_receiver_id.clone(),
            TimecodeControl { registry: RegistryClient::new(registry_url.clone()), context: ctx, input: timecode.clone() },
        ))),
        Err(e) => {
            eprintln!("omp-ograf: Zeitcode-Eingang aus — {e}");
            None
        }
    };
    let timecode_receivers = if timecode_connection.is_some() {
        vec![ReceiverSpec {
            id: Some(timecode_receiver_id),
            transport: Some(TRANSPORT_MXL.to_string()),
            media_types: Some(vec!["video/smpte291".to_string()]),
            label: Some(timecode_label),
            ..Default::default()
        }]
    } else {
        vec![]
    };
    let concrete = Arc::new(OgrafStore {
        timecode: timecode.clone(),
        timecode_connection,
        templates,
        layers: Mutex::new(layers::Layers::default()),
        templates_root,
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

    // Kapitel 15 Teil 4 (docs/END-GOAL-FEATURES.md §15.3b, gleiches
    // Format wie omp-source/omp-player): `urn:x-nmos:tag:grouphint/v1.0`
    // "<group>:<role>" — `fill_flow_id` als Gruppenname (stabil, pro
    // Instanz eindeutig). Nur Fill bekommt das Tag, Key bleibt
    // unangetastet .
    let fill_group_name = fill_flow_id.clone();

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
            ],
            receivers: timecode_receivers,
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
                    // Fehlercode [OMP-nnnn] voranstellen, wenn die Meldung einem Katalogeintrag entspricht (Kap. 72.8)
                    let message = omp_node_sdk::errcode::tag(&message);
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

#[cfg(test)]
mod harness_tests {
    use super::*;

    /// Regression: `wpesrc` trägt kein Node-API-Token; ohne öffentliche Route lieferte der Harness-Server 401 und die Grafik
    /// erschien nur als Fehlertext.
    #[test]
    fn harness_server_is_reachable_without_node_token() {
        let store = HarnessOnlyStore { templates_root: PathBuf::from(".") };
        assert!(store.public_route("GET", "/ograf-harness.html"));
        assert!(store.public_route("GET", "/ograf-templates/x/y.js"));
        assert!(!store.public_route("POST", "/ograf-harness.html"));
    }
}
