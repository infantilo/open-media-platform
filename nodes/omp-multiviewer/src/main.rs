//! omp-multiviewer: dynamische Eingangszahl, Grid-Monitoring aller
//! entdeckten MXL-Video-Sender (Nutzeranforderung 2026-07-12, gleiche
//! §13-Produktions-Microservice-Einordnung wie C10-C12). Discovery rein
//! über IS-04 (gleicher Poll-Stil wie `omp-switcher`, C7): alle ~2s
//! werden alle registrierten MXL-Video-Sender abgefragt, jeder erscheint
//! automatisch als Kachel im Grid — kein manuelles Patchen pro Quelle
//! nötig. Reiner Monitor: kein MXL-Sende-Ausgang, nur MJPEG-über-HTTP
//! (`omp_mediaio::preview`, aus `omp-viewer`/C6 hierher extrahiert) —
//! ein Multiviewer speist in der Praxis eine Bedienplatz-Anzeige, kein
//! weiterverkettbares Programmsignal.

mod pipeline;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_mediaio::preview;
use omp_node_sdk::is04::{self, RegistryClient, Sender, TRANSPORT_MXL};
use omp_node_sdk::{
    Descriptor, InvokeError, NodeConfig, ParamSpec, ParamStore, ParamType, PeerClient, SetError,
    resolve_owning_node_href,
};
use pipeline::DiscoveredInput;
use serde_json::Value;

/// Kapitel 15 Teil 3 (docs/END-GOAL-FEATURES.md §15.3b/§15.4): gegen die
/// echte AMWA-NMOS-Parameter-Registry verifiziertes Tag (nicht geraten,
/// s. `docs/decisions.md` Nachtrag 37/38) — Format
/// `"<group-name>:<role-in-group>[:<group-scope>]"`, hier auf Sendern
/// gesetzt von `omp-source` (bisher einziger Node mit Lowres-Begleit-
/// Sender).
const GROUPHINT_TAG: &str = "urn:x-nmos:tag:grouphint/v1.0";

struct MultiviewerStore {
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
    preview_url: String,
}

impl ParamStore for MultiviewerStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                // JSON-Array [{senderId,label}] — gleiche Array-Ausnahme
                // wie omp-switchers "inputs" (v0-Schema kennt keinen
                // Array-Typ, docs/descriptor-v0.schema.json).
                ParamSpec {
                    name: "inputs".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                // Generischer Parametername wie omp-viewer (C6) — die
                // Flow-Editor-Kachel (flow-canvas.ts) zeigt jeden Node mit
                // diesem Parameter automatisch als Inline-Vorschau,
                // unabhängig vom Node-Typ (Nutzeranforderung 2026-07-12).
                ParamSpec {
                    name: "previewUrl".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
            ],
            methods: vec![],
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
            "previewUrl" => Some(serde_json::json!(self.preview_url)),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(
        &self,
        _name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        Err(InvokeError::Unknown)
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Multiviewer");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9380").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    // Default 0 (freier Port vom OS), gleicher Grund wie omp-viewer C6/C8:
    // mehrere vom Instanz-Launcher gestartete Multiviewer dürfen sich
    // keinen festen Preview-Port teilen.
    let preview_port: u16 = env_or("OMP_MULTIVIEWER_PREVIEW_PORT", "0").parse()?;
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let broadcaster = Arc::new(preview::Broadcaster::new());
    let actual_preview_port =
        preview::spawn(&format!("0.0.0.0:{preview_port}"), broadcaster.clone())?;
    let preview_url = format!("http://{host}:{actual_preview_port}/preview");

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config { domain };
    let pipeline_shutdown = shutdown.clone();
    let broadcaster_for_pipeline = broadcaster.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(
            pipeline_config,
            broadcaster_for_pipeline,
            tx,
            pipeline_shutdown,
            ready_tx,
        )
    });

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-multiviewer: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-multiviewer: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let inputs = Arc::new(Mutex::new(Vec::<DiscoveredInput>::new()));
    let media_ready_pipeline = pipeline_handle.clone();

    let store: Arc<dyn ParamStore> = Arc::new(MultiviewerStore {
        inputs: inputs.clone(),
        preview_url,
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url: registry_url.clone(),
            nats_url,
            senders: vec![],
            receivers: vec![],
            instance_id,
            // "media-ready" über PipelineHandle::media_ready()
            // (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2).
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || {
                media_ready_pipeline.media_ready()
            })),
        },
        store,
    )
    .await?;

    let discovery = discovery_loop(registry_url, pipeline_handle, inputs);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-multiviewer: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-multiviewer: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-multiviewer: pipeline thread ended");
        }
        _ = discovery => {
            eprintln!("omp-multiviewer: discovery loop ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}

/// Splittet einen Grouphint-Tag-Wert (`"<group>:<role>[:<scope>]"`, s.
/// `GROUPHINT_TAG`-Doku) in `(group, role)` — Scope (dritter Teil) wird
/// hier nicht gebraucht (nur ein Multiviewer-Prozess pro Domain-Poll,
/// kein Geräte-/Node-Scope-Konflikt).
fn parse_grouphint(value: &str) -> Option<(&str, &str)> {
    let mut parts = value.splitn(3, ':');
    let group = parts.next()?;
    let role = parts.next()?;
    Some((group, role))
}

/// Baut `group-name -> (lowres sender_id, lowres flow_id)` aus dem vollen
/// Sender-Satz (Kapitel 15 Teil 3) — ein Durchlauf, kein zusätzlicher
/// Registry-Umlauf gegenüber der bisherigen Discovery.
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
/// Sender bekommen keine eigene Kachel, sie werden nur über
/// `DiscoveredInput::lowres_flow_id` ihres Highres-Geschwisters gelesen.
fn is_lowres_companion(s: &Sender) -> bool {
    s.tags
        .get(GROUPHINT_TAG)
        .map(|values| {
            values
                .iter()
                .any(|v| matches!(parse_grouphint(v), Some((_, "low"))))
        })
        .unwrap_or(false)
}

/// Ein Discovery-Durchlauf (blockierend, s. `spawn_blocking`-Aufrufer) —
/// gleicher Filter-Stil wie zuvor (`transport==MXL`, `format==video`),
/// zusätzlich Kapitel 15 Teil 3: pro Kachel den Lowres-Begleit-Sender
/// (falls vorhanden) verlinken, Lowres-Sender selbst nicht als eigene
/// Kachel führen.
fn discover(registry: &RegistryClient) -> Result<Vec<DiscoveredInput>, String> {
    let senders = registry.list_senders().map_err(|e| e.to_string())?;
    let lowres_map = lowres_by_group(&senders);

    let mut discovered = Vec::new();
    for s in &senders {
        if s.transport != TRANSPORT_MXL || is_lowres_companion(s) {
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
            lowres_flow_id: lowres.as_ref().map(|(_, fid)| fid.clone()),
        });
    }
    Ok(discovered)
}

/// Pollt alle 2s die IS-04-Query-API nach MXL-Video-Sendern (gleicher
/// Poll-/Filter-Stil wie `omp-switcher`, C7/C11: `get_flow_format`-Filter
/// auf `format==video`, sonst würden Audio-Sender als Grid-Kacheln
/// auftauchen) — kein Selbstausschluss nötig, der Multiviewer registriert
/// selbst keinen MXL-Sender.
///
/// Kapitel 15 Teil 3 (docs/END-GOAL-FEATURES.md §15.4, docs/decisions.md
/// Nachtrag 38): gleicht zusätzlich bei jedem Poll die beim jeweiligen
/// Quell-Node aktivierten Lowres-Sender an die aktuelle Kachel-Menge an
/// (`activateLowresPreview`/`releaseLowresPreview`, Kapitel 15 Teil 2) —
/// `activated_lowres` merkt sich dafür den Aktivierungsstand über Polls
/// hinweg, damit nicht bei jedem 2s-Tick erneut aktiviert/freigegeben
/// wird. Schlägt eine Aktivierung fehl (Quell-Node gerade nicht
/// erreichbar/auflösbar), fällt genau diese Kachel auf Highres+Downscale
/// zurück (`input.lowres_*` wird auf `None` zurückgesetzt) statt
/// dauerhaft schwarz zu bleiben. Kein Graceful-Release beim Multiviewer-
/// Shutdown (dokumentierte Lücke, nicht Teil dieser Scheibe) — der
/// Quell-Node bleibt in dem Fall bis zu seinem eigenen Neustart aktiv.
async fn discovery_loop(
    registry_url: String,
    pipeline: pipeline::PipelineHandle,
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
) {
    let registry = RegistryClient::new(registry_url);
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    let mut activated_lowres: HashMap<String, String> = HashMap::new();

    loop {
        interval.tick().await;
        let registry_for_poll = registry.clone();
        let result = tokio::task::spawn_blocking(move || discover(&registry_for_poll)).await;

        let mut discovered = match result {
            Ok(Ok(discovered)) => discovered,
            Ok(Err(e)) => {
                eprintln!("omp-multiviewer: discovery poll failed: {e}");
                continue;
            }
            Err(e) => {
                eprintln!("omp-multiviewer: discovery poll task panicked: {e}");
                continue;
            }
        };

        // Nicht mehr gewünschte Aktivierungen freigeben.
        let wanted_ids: std::collections::HashSet<&str> = discovered
            .iter()
            .filter_map(|i| i.lowres_sender_id.as_deref())
            .collect();
        let stale: Vec<(String, String)> = activated_lowres
            .iter()
            .filter(|(id, _)| !wanted_ids.contains(id.as_str()))
            .map(|(id, href)| (id.clone(), href.clone()))
            .collect();
        for (lowres_sender_id, href) in stale {
            let result = tokio::task::spawn_blocking(move || PeerClient::new(href).invoke("releaseLowresPreview")).await;
            if let Ok(Err(e)) = result {
                eprintln!("omp-multiviewer: releaseLowresPreview({lowres_sender_id}) failed: {e}");
            }
            activated_lowres.remove(&lowres_sender_id);
        }

        // Neue Lowres-Kacheln aktivieren; bei Fehlschlag Rückfall auf
        // Highres für genau diese Kachel (s. Funktionsdoku oben).
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
                    "omp-multiviewer: owning node for lowres sender {lowres_sender_id} not resolvable, falling back to highres"
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
                    eprintln!("omp-multiviewer: activateLowresPreview({lowres_sender_id}) failed: {e}, falling back to highres");
                    input.lowres_sender_id = None;
                    input.lowres_flow_id = None;
                }
                Err(e) => {
                    eprintln!("omp-multiviewer: activateLowresPreview({lowres_sender_id}) task panicked: {e}, falling back to highres");
                    input.lowres_sender_id = None;
                    input.lowres_flow_id = None;
                }
            }
        }

        *inputs.lock().expect("lock poisoned") = discovered.clone();
        pipeline.set_inputs(discovered);
    }
}
