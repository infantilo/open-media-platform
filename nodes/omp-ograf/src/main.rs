//! omp-ograf: OGraf-Grafik-Microservice (`UMSETZUNG.md` K5-Teil-1,
//! `docs/END-GOAL-FEATURES.md` §5). Rendert genau ein EBU-OGraf-v1-
//! Template gleichzeitig (Mehrfach-Instanzen/Layer `full`/Pre-Cue/
//! adaptive Render-Rate sind K5-Teil-3) über `wpesrc` (Variante A,
//! Go-Entscheidung K5-Teil-0, `docs/decisions.md` 2026-07-15) als zwei
//! MXL-`video/v210`-Flows (Fill + Key — Fallback statt eines nativen
//! `video/v210a`-Einzelflows, Begründung in `pipeline.rs`). Der
//! Mixer-DSK-Anschluss (Empfängerseite) ist K5-Teil-2.

mod pipeline;
mod templates;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

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
    current: Mutex<Option<String>>,
    templates_root: PathBuf,
    lowres_flow_id: String,
    pipeline: pipeline::PipelineHandle,
}

impl ParamStore for OgrafStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
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
            ],
            methods: vec![
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
                    ],
                },
                MethodSpec {
                    name: "hide".to_string(),
                    args: vec![],
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
        match name {
            "templates" => Some(serde_json::json!(
                self.templates
                    .iter()
                    .map(TemplateInfo::to_descriptor_json)
                    .collect::<Vec<_>>()
            )),
            "current" => Some(serde_json::json!(
                *self.current.lock().expect("lock poisoned")
            )),
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
                *self.current.lock().expect("lock poisoned") = Some(template_id.to_string());
                self.pipeline.send(pipeline::Command::Show {
                    template_id: template_id.to_string(),
                    dir,
                    main,
                    data,
                });
                Ok(())
            }
            "hide" => {
                *self.current.lock().expect("lock poisoned") = None;
                self.pipeline.send(pipeline::Command::Hide);
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, _body: &[u8]) -> Option<RawResponse> {
        templates::route(&self.templates_root, method, path)
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
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let templates_root = PathBuf::from(env_or("OMP_OGRAF_TEMPLATES", "data/ograf-templates"));
    std::fs::create_dir_all(&templates_root).ok();
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
    let pipeline_thread =
        std::thread::spawn(move || pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx));

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

    let store: Arc<dyn ParamStore> = Arc::new(OgrafStore {
        templates,
        current: Mutex::new(None),
        templates_root,
        lowres_flow_id: lowres_flow_id.clone(),
        pipeline: pipeline_handle,
    });

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
