//! omp-switcher: MXL ×N → Buttons → MXL (`UMSETZUNG.md` C7). Dritter der
//! drei MXL-Demo-Services: der „Videomixer" mit dynamischer
//! Quellen-Auswahl per Button. Discovery **rein über IS-04** (kein
//! Orchestrator-Sonderwissen): alle ~2 s werden alle registrierten
//! MXL-Sender abgefragt, der eigene ausgeschlossen — neue
//! `omp-source`-Instanzen erscheinen dadurch automatisch als wählbare
//! Eingänge, ohne Neustart des Switchers.

mod pipeline;
mod uibundle;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_node_sdk::is04;
use omp_node_sdk::is04::{RegistryClient, Sender, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    PeerClient, RawResponse, SenderSpec, SetError, resolve_owning_node_href,
};
use pipeline::DiscoveredInput;
use serde_json::Value;

/// Kapitel 15 Teil 3 (docs/END-GOAL-FEATURES.md §15.3b/§15.4, gleiches
/// Tag/Muster wie `omp-multiviewer`, s. dortige Moduldoku Nachtrag 38).
const GROUPHINT_TAG: &str = "urn:x-nmos:tag:grouphint/v1.0";

struct SwitcherStore {
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
    active: Arc<Mutex<Option<String>>>,
    pipeline: pipeline::PipelineHandle,
}

impl ParamStore for SwitcherStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                ParamSpec {
                    name: "inputs".to_string(),
                    // Das v0-Descriptor-Schema kennt keinen Array-/Objekt-
                    // Typ (docs/descriptor-v0.schema.json) — der Wert ist
                    // trotzdem ein JSON-Array [{senderId,label}], gelesen
                    // vom eigenen UI-Bundle (uibundle.rs), nicht vom
                    // generischen B6-Panel.
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "activeInput".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
            ],
            methods: vec![MethodSpec {
                name: "select".to_string(),
                args: vec![MethodArg {
                    name: "senderId".to_string(),
                    kind: ParamType::String,
                }],
            }],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "inputs" => {
                let inputs = self.inputs.lock().expect("lock poisoned");
                Some(serde_json::json!(
                    inputs
                        .iter()
                        .map(|i| serde_json::json!({"senderId": i.sender_id, "label": i.label}))
                        .collect::<Vec<_>>()
                ))
            }
            "activeInput" => Some(serde_json::json!(
                self.active
                    .lock()
                    .expect("lock poisoned")
                    .clone()
                    .unwrap_or_default()
            )),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        if name != "select" {
            return Err(InvokeError::Unknown);
        }
        let sender_id = args
            .get("senderId")
            .and_then(Value::as_str)
            .ok_or(InvokeError::Unknown)?;
        let selected = if sender_id.is_empty() {
            None
        } else {
            Some(sender_id.to_string())
        };
        self.pipeline.select(selected);
        Ok(())
    }

    fn extra_route(&self, method: &str, path: &str, _body: &[u8]) -> Option<RawResponse> {
        uibundle::route(method, path)
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Switcher");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9350").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Vom Instanz-Launcher gesetzt (`UMSETZUNG.md` C8), sonst leer bei
    // manuellem Start.
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

    // Wie bei omp-source/playout (C5/C3): eigene Sender-/Flow-ID vorab
    // erzeugen — die Discovery (unten) muss den eigenen Sender aus der
    // Query-API-Antwort ausschließen können, und es gilt Flow-UUID ==
    // MXL-flow-id (`UMSETZUNG.md` C4).
    let sender_id = omp_node_sdk::idgen::new_v4();
    let flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        flow_id: flow_id.clone(),
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
            eprintln!("omp-switcher: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-switcher: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let inputs = Arc::new(Mutex::new(Vec::<DiscoveredInput>::new()));
    let active = Arc::new(Mutex::new(None::<String>));

    let store: Arc<dyn ParamStore> = Arc::new(SwitcherStore {
        inputs: inputs.clone(),
        active: active.clone(),
        pipeline: pipeline_handle.clone(),
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url: registry_url.clone(),
            nats_url,
            senders: vec![SenderSpec {
                id: Some(sender_id.clone()),
                transport: Some(TRANSPORT_MXL.to_string()),
                flow: Some(FlowSpec::Video {
                    id: Some(flow_id),
                    frame_width: width,
                    frame_height: height,
                    grain_rate_numerator: pipeline::FRAMERATE_NUMERATOR,
                    grain_rate_denominator: pipeline::FRAMERATE_DENOMINATOR,
                }),
                ..Default::default()
            }],
            receivers: vec![],
            instance_id,
            // "media-ready" über PipelineHandle::media_ready()
            // (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2).
            media_ready: {
                let pipeline = pipeline_handle.clone();
                omp_node_sdk::MediaReadySource::Probe(Arc::new(move || pipeline.media_ready()))
            },
        },
        store,
    )
    .await?;

    let discovery = discovery_loop(registry_url, sender_id, pipeline_handle, inputs);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-switcher: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
                pipeline::Event::ActiveChanged(sender_id) => {
                    *active.lock().expect("lock poisoned") = sender_id;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-switcher: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-switcher: pipeline thread ended");
        }
        _ = discovery => {
            eprintln!("omp-switcher: discovery loop ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}

/// Pollt alle 2s die IS-04-Query-API nach MXL-Sendern (gleicher Poll-Stil
/// wie A5), filtert den eigenen Sender heraus und meldet das Ergebnis an
/// den Pipeline-Thread. Der Pipeline-Thread selbst entscheidet, ob sich
/// die Quellenmenge tatsächlich geändert hat (`pipeline::inputs_changed`)
/// — hier wird bewusst bei jedem Tick unverändert weitergemeldet, kein
/// Diffing auf dieser Seite.
/// Splittet einen Grouphint-Tag-Wert (`"<group>:<role>[:<scope>]"`, s.
/// `GROUPHINT_TAG`-Doku) in `(group, role)` — identisch zu
/// `omp-multiviewer::main::parse_grouphint`, bewusst dupliziert statt
/// geteilt (gleiche Begründung wie überall sonst in diesem Projekt bei
/// Node-zu-Node-Codeduplikation: jeder Node ist ein eigenständiges,
/// unabhängig bau-/verteilbares Binary).
fn parse_grouphint(value: &str) -> Option<(&str, &str)> {
    let mut parts = value.splitn(3, ':');
    let group = parts.next()?;
    let role = parts.next()?;
    Some((group, role))
}

/// Baut `group-name -> (lowres sender_id, lowres flow_id)` aus dem
/// vollen Sender-Satz (Kapitel 15 Teil 3) — ein Durchlauf, kein
/// zusätzlicher Registry-Umlauf gegenüber der bisherigen Discovery.
fn lowres_by_group(senders: &[Sender]) -> HashMap<String, (String, String)> {
    let mut map = HashMap::new();
    for s in senders {
        let Some(flow_id) = &s.flow_id else { continue };
        let Some(values) = s.tags.get(GROUPHINT_TAG) else { continue };
        for v in values {
            if let Some((group, "low")) = parse_grouphint(v) {
                map.insert(group.to_string(), (s.id.clone(), flow_id.clone()));
            }
        }
    }
    map
}

/// Ob `s` selbst ein Lowres-Begleit-Sender ist (Rolle `low`) — solche
/// Sender bekommen keinen eigenen Eingangs-Button, sie werden nur über
/// `DiscoveredInput::lowres_flow_id` ihres Highres-Geschwisters gelesen.
fn is_lowres_companion(s: &Sender) -> bool {
    s.tags
        .get(GROUPHINT_TAG)
        .map(|values| values.iter().any(|v| matches!(parse_grouphint(v), Some((_, "low")))))
        .unwrap_or(false)
}

/// Ein Discovery-Durchlauf (blockierend, s. `spawn_blocking`-Aufrufer) —
/// gleicher Filter-Stil wie zuvor (`transport==MXL`, `format==video`,
/// eigener Sender ausgeschlossen), zusätzlich Kapitel 15 Teil 3: pro
/// Eingang den Lowres-Begleit-Sender (falls vorhanden) verlinken,
/// Lowres-Sender selbst nicht als eigenen Eingang führen.
fn discover(registry: &RegistryClient, own_sender_id: &str) -> Result<Vec<DiscoveredInput>, String> {
    let senders = registry.list_senders().map_err(|e| e.to_string())?;
    let lowres_map = lowres_by_group(&senders);

    let mut discovered = Vec::new();
    for s in &senders {
        if s.transport != TRANSPORT_MXL || s.id == own_sender_id || is_lowres_companion(s) {
            continue;
        }
        let Some(flow_id) = &s.flow_id else { continue };
        if !matches!(registry.get_flow_format(flow_id), Ok(format) if format == is04::FORMAT_VIDEO) {
            continue;
        }

        let group = s
            .tags
            .get(GROUPHINT_TAG)
            .and_then(|values| values.first())
            .and_then(|v| parse_grouphint(v))
            .map(|(group, _)| group.to_string());
        let lowres = group.and_then(|g| lowres_map.get(&g).cloned());

        discovered.push(DiscoveredInput {
            sender_id: s.id.clone(),
            label: s.label.clone(),
            flow_id: flow_id.clone(),
            lowres_sender_id: lowres.as_ref().map(|(id, _)| id.clone()),
            lowres_flow_id: lowres.map(|(_, fid)| fid),
        });
    }
    Ok(discovered)
}

/// wie A5), filtert den eigenen Sender heraus und meldet das Ergebnis an
/// den Pipeline-Thread. Der Pipeline-Thread selbst entscheidet, ob sich
/// die Quellenmenge tatsächlich geändert hat (`pipeline::inputs_changed`)
/// — hier wird bewusst bei jedem Tick unverändert weitergemeldet, kein
/// Diffing auf dieser Seite.
///
/// Kapitel 15 Teil 3 (docs/END-GOAL-FEATURES.md §15.4, docs/decisions.md):
/// gleicht zusätzlich bei jedem Poll die beim jeweiligen Quell-Node
/// aktivierten Lowres-Sender an die aktuelle Eingangs-Menge an
/// (`activateLowresPreview`/`releaseLowresPreview`, Kapitel 15 Teil 2,
/// exakt dasselbe Muster wie `omp-multiviewer::main::discovery_loop`) —
/// `activated_lowres` merkt den Aktivierungsstand über Polls hinweg.
/// Anders als beim Multiviewer entscheidet **hier nicht** diese
/// Discovery-Schleife, welcher Eingang gerade Lowres liest (das macht
/// `pipeline::run`s `Command::Select`-Behandlung anhand der PGM-Auswahl)
/// — die Aktivierung beim Quell-Node läuft für **jeden** entdeckten
/// Eingang mit Lowres-Begleiter, unabhängig davon, ob er gerade PGM ist;
/// ob der Switcher intern gerade den Highres- oder Lowres-Flow davon
/// liest, ist eine reine Leseentscheidung auf bereits aktivierten Flows.
async fn discovery_loop(
    registry_url: String,
    own_sender_id: String,
    pipeline: pipeline::PipelineHandle,
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
) {
    let registry = RegistryClient::new(registry_url);
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    let mut activated_lowres: HashMap<String, String> = HashMap::new();

    loop {
        interval.tick().await;
        let registry_for_poll = registry.clone();
        let own_sender_id_for_poll = own_sender_id.clone();
        let result =
            tokio::task::spawn_blocking(move || discover(&registry_for_poll, &own_sender_id_for_poll)).await;

        let discovered = match result {
            Ok(Ok(discovered)) => discovered,
            Ok(Err(e)) => {
                eprintln!("omp-switcher: discovery poll failed: {e}");
                continue;
            }
            Err(e) => {
                eprintln!("omp-switcher: discovery poll task panicked: {e}");
                continue;
            }
        };

        // Lowres-Aktivierung: pro entdecktem Eingang mit Begleiter immer
        // aktivieren, sofern noch nicht geschehen — exakt dasselbe
        // Muster wie `omp-multiviewer::main::discovery_loop`, hier aber
        // ohne Rückfall-auf-Highres-Logik in `discovered` selbst (der
        // Switcher entscheidet die Highres/Lowres-Lesewahl separat
        // anhand der PGM-Auswahl, s. Funktionsdoku); schlägt die
        // Aktivierung fehl, werden `lowres_sender_id`/`lowres_flow_id`
        // für diesen Eingang zurückgesetzt, damit `pipeline::run` gar
        // nicht erst versucht, einen nie aktivierten Flow zu lesen.
        let mut discovered = discovered;
        let wanted_ids: std::collections::HashSet<&str> =
            discovered.iter().filter_map(|i| i.lowres_sender_id.as_deref()).collect();
        let stale: Vec<(String, String)> = activated_lowres
            .iter()
            .filter(|(id, _)| !wanted_ids.contains(id.as_str()))
            .map(|(id, href)| (id.clone(), href.clone()))
            .collect();
        for (lowres_sender_id, href) in stale {
            let result = tokio::task::spawn_blocking(move || PeerClient::new(href).invoke("releaseLowresPreview")).await;
            if let Ok(Err(e)) = result {
                eprintln!("omp-switcher: releaseLowresPreview({lowres_sender_id}) failed: {e}");
            }
            activated_lowres.remove(&lowres_sender_id);
        }

        for input in discovered.iter_mut() {
            let Some(lowres_sender_id) = input.lowres_sender_id.clone() else { continue };
            if activated_lowres.contains_key(&lowres_sender_id) {
                continue;
            }
            let registry_for_resolve = registry.clone();
            let sender_id_for_resolve = lowres_sender_id.clone();
            let href = tokio::task::spawn_blocking(move || {
                resolve_owning_node_href(&registry_for_resolve, &sender_id_for_resolve)
            })
            .await
            .ok()
            .flatten();
            let Some(href) = href else {
                eprintln!(
                    "omp-switcher: owning node for lowres sender {lowres_sender_id} not resolvable, falling back to highres"
                );
                input.lowres_sender_id = None;
                input.lowres_flow_id = None;
                continue;
            };
            let href_for_call = href.clone();
            let activate_result =
                tokio::task::spawn_blocking(move || PeerClient::new(href_for_call).invoke("activateLowresPreview")).await;
            match activate_result {
                Ok(Ok(())) => {
                    activated_lowres.insert(lowres_sender_id, href);
                }
                Ok(Err(e)) => {
                    eprintln!("omp-switcher: activateLowresPreview({lowres_sender_id}) failed: {e}, falling back to highres");
                    input.lowres_sender_id = None;
                    input.lowres_flow_id = None;
                }
                Err(e) => {
                    eprintln!("omp-switcher: activateLowresPreview({lowres_sender_id}) task panicked: {e}, falling back to highres");
                    input.lowres_sender_id = None;
                    input.lowres_flow_id = None;
                }
            }
        }

        *inputs.lock().expect("lock poisoned") = discovered.clone();
        pipeline.set_inputs(discovered);
    }
}
