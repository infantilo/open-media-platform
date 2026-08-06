//! omp-pipeline-controller: Adapter/Sidecar, der das unveränderte
//! PIPELINE CONTROLLER-Projekt (`/home/infantilo/PIPELINE CONTROLLER`,
//! eigenständig, kein Code-/Git-Bezug zu OMP) als OMP-Microservice mit
//! echten MXL-Ein-/Ausgängen sichtbar macht.
//!
//! Nutzervorgabe (Rückfrage 2026-07-31): OMP bekommt **kein** eigenes
//! Play/Stop/Cue-Interface für PIPELINE CONTROLLER — dessen komplette
//! Bedienung (Playlist/Grafik/Player/Assets/...) bleibt exakt wie bisher
//! PIPELINE CONTROLLERs eigene Sache, nur die Oberfläche zieht ins
//! Flow-Editor-Kachelpanel um (`proxy.rs`/`uibundle.rs`). Dieser Adapter
//! beschränkt sich auf reine Medien-Verkabelung:
//!   - registriert zwei Sender (Programm-Video/-Audio, PIPELINE
//!     CONTROLLERs neuer `mxl`-Ausgangstyp, s. `deploy/pipeline-
//!     controller/patches/0001-mxl-output.diff`) und zwei Receiver
//!     (Video/Audio) bei NMOS,
//!   - übersetzt IS-05-Connects am Receiver in PIPELINE CONTROLLERs
//!     eigene Live-Source-API (`livesource.rs`),
//!   - reicht PIPELINE CONTROLLERs eigenes Web-UI transparent auf dem
//!     einen vom Launcher publizierten Port durch (`proxy.rs`).

mod livesource;
mod proxy;
mod sse_proxy;
mod uibundle;

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use livesource::{FlowKind, LiveSourceControl, SharedLiveSource};
use omp_node_sdk::connection::ReceiverConnection;
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, MediaReadySource, NodeConfig, ParamSpec, ParamStore, ParamType,
    RawResponse, ReceiverSpec, SenderSpec, SetError,
};
use serde_json::Value;

/// Fester interner Port von PIPELINE CONTROLLER im Container (Containerfile:
/// `ENV PORT=3000`) — nur adapterintern (`127.0.0.1`) erreichbar, der
/// Launcher veröffentlicht ausschließlich `OMP_PORT` nach außen.
const PC_PORT: u16 = 3000;

/// Programm-Auflösung/-Framerate — sowohl für die IS-04-Flow-Registrierung
/// (`SenderSpec::flow`, unten) als auch für `configure_mxl_output` (Patch
/// 0001-mxl-output.diff: explizite Caps direkt nach `intervideosrc`, damit
/// die allererste Caps-Verhandlung nicht auf einem GStreamer-Fallback wie
/// 320x240@30 landet, bevor die echten Master-Caps verfügbar sind — live
/// gefunden: sonst legt mxlsink den Flow dauerhaft in der falschen
/// Auflösung an, jeder Buffer läuft danach über einen zu kleinen
/// Grain-Payload, Bild zerfällt in diagonale Streifen). Eine Konstante
/// statt zweier unabhängiger Literale, damit beide Stellen nie
/// auseinanderlaufen können.
const PROGRAM_WIDTH: u32 = 1920;
const PROGRAM_HEIGHT: u32 = 1080;
const PROGRAM_FPS_NUM: u32 = 25;
const PROGRAM_FPS_DEN: u32 = 1;

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

struct Store {
    web_ui_url: String,
    events_url: String,
    video_connection: Arc<ReceiverConnection<LiveSourceControl>>,
    audio_connection: Arc<ReceiverConnection<LiveSourceControl>>,
    proxy_agent: ureq::Agent,
    pc_base: String,
}

impl ParamStore for Store {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                ParamSpec {
                    name: "webUiUrl".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "eventsUrl".to_string(),
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
            "webUiUrl" => Some(serde_json::json!(self.web_ui_url)),
            "eventsUrl" => Some(serde_json::json!(self.events_url)),
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
        if let Some(resp) = self.video_connection.handle(method, path, body) {
            let (status, content_type, body) = resp;
            return Some(RawResponse { status, content_type, body });
        }
        if let Some(resp) = self.audio_connection.handle(method, path, body) {
            let (status, content_type, body) = resp;
            return Some(RawResponse { status, content_type, body });
        }
        if let Some(resp) = uibundle::route(method, path) {
            return Some(resp);
        }
        Some(proxy::proxy(&self.proxy_agent, &self.pc_base, method, path, body))
    }
}

/// Wartet, bis PIPELINE CONTROLLERs eigener HTTP-Server antwortet — bewusst
/// blockierend (kein anderer async-Task läuft an dieser Stelle im Setup
/// noch), gleiches Prinzip wie das "media-ready"-Wartemuster anderer
/// Nodes, nur für "control-ready" statt Medienfluss.
fn wait_for_pc_ready(pc_base: &str) {
    let url = format!("{pc_base}/api/config");
    for attempt in 1.. {
        match ureq::get(&url).call() {
            Ok(_) => return,
            Err(e) => {
                if attempt % 10 == 0 {
                    eprintln!("omp-pipeline-controller: warte auf PIPELINE CONTROLLER ({url}): {e}");
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

/// Konfiguriert PIPELINE CONTROLLERs neuen `mxl`-Ausgangstyp (s. Patch 0001)
/// auf die beiden hier generierten Flow-IDs. Reine Verkabelung, welcher
/// Flow existiert — keine Playout-Aktion: ob/wann das Programm tatsächlich
/// läuft, entscheidet weiterhin PIPELINE CONTROLLER selbst über
/// `enabled`/Auto-Restart seiner eigenen OutputEngine.
fn configure_mxl_output(pc_base: &str, domain: &str, video_flow_id: &str, audio_flow_id: &str) {
    let body = serde_json::json!({
        "outputs": [{
            "id": "omp-mxl",
            "label": "OMP MXL",
            "enabled": true,
            "source": "pgm",
            "sink": "mxl",
            "mxlDomain": domain,
            "mxlVideoFlowId": video_flow_id,
            "mxlAudioFlowId": audio_flow_id,
            "width": PROGRAM_WIDTH,
            "height": PROGRAM_HEIGHT,
            "mxlFrameRateNum": PROGRAM_FPS_NUM,
            "mxlFrameRateDen": PROGRAM_FPS_DEN,
        }]
    });
    if let Err(e) = ureq::post(&format!("{pc_base}/api/outputs/settings")).send_json(body) {
        eprintln!("omp-pipeline-controller: mxl-Ausgang konnte nicht konfiguriert werden: {e}");
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "PIPELINE CONTROLLER");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9360").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let pc_base = format!("http://127.0.0.1:{PC_PORT}");

    // PIPELINE CONTROLLER als Kindprozess — der Adapter kontrolliert den
    // Lebenszyklus (Start hier, Kill bei Shutdown unten), damit NMOS-
    // Registrierung/Deregistrierung an den echten Prozesszustand gekoppelt
    // bleibt statt an einen unabhängig laufenden Container-Entrypoint.
    let mut pc_child = tokio::process::Command::new("node")
        .arg("server.js")
        .current_dir("/app")
        .stdin(Stdio::null())
        .spawn()?;

    wait_for_pc_ready(&pc_base);

    // Flow-UUID == MXL-flow-id-Konvention (UMSETZUNG.md C4) — dieselbe ID
    // geht sowohl an PIPELINE CONTROLLERs `mxlsink` (via configure_mxl_output)
    // als auch an die IS-04-Flow-Registrierung (SenderSpec::flow).
    let video_flow_id = omp_node_sdk::idgen::new_v4();
    let audio_flow_id = omp_node_sdk::idgen::new_v4();
    configure_mxl_output(&pc_base, &domain, &video_flow_id, &audio_flow_id);

    // Receiver-IDs vorab (wie omp-viewer, C6): die IS-05-Connection-Endpunkte
    // müssen vor omp_node_sdk::start() unter der endgültigen ID stehen.
    let video_receiver_id = omp_node_sdk::idgen::new_v4();
    let audio_receiver_id = omp_node_sdk::idgen::new_v4();

    let registry = RegistryClient::new(registry_url.clone());
    let shared_live_source = SharedLiveSource::new(pc_base.clone(), domain.clone(), registry.clone());

    let video_connection = Arc::new(ReceiverConnection::new(
        video_receiver_id.clone(),
        LiveSourceControl { kind: FlowKind::Video, shared: shared_live_source.clone() },
    ));
    let audio_connection = Arc::new(ReceiverConnection::new(
        audio_receiver_id.clone(),
        LiveSourceControl { kind: FlowKind::Audio, shared: shared_live_source.clone() },
    ));

    let web_ui_url = format!("http://{host}:{port}/");

    // Eigener, echt streamender zweiter Listener für PIPELINE CONTROLLERs
    // SSE-Kanal (s. sse_proxy.rs-Moduldoku) — proxy.rs' `/events`-Kurzschluss
    // (501) hielt den Adapter am Leben, ließ `ui.html` aber dauerhaft im
    // "OFFLINE"-Zustand hängen (live per Browser/CDP gefunden, nicht nur per
    // API getestet). OMP_EXTRA_PORT: vom Launcher vorab per `podman run -p`
    // veröffentlichter Port (CatalogEntry.ExtraPort, s. dortige Doku) — ein
    // containerinterner `:0`-Zufallsport wäre von außen (Browser) nicht
    // erreichbar, anders als bei omp-viewers `preview_port` (nativer
    // Prozess, kein Container-Netzwerk-Namensraum dazwischen). Fehlt die
    // Env (z. B. lokaler `cargo run` ohne Launcher), fällt `:0` zurück —
    // dann läuft der Adapter selbst nativ, also ohne Erreichbarkeitslücke.
    let events_port_env: u16 = env_or("OMP_EXTRA_PORT", "0").parse()?;
    let events_port = sse_proxy::spawn(&format!("0.0.0.0:{events_port_env}"), pc_base.clone())?;
    let events_url = format!("http://{host}:{events_port}/events");

    let store: Arc<dyn ParamStore> = Arc::new(Store {
        web_ui_url,
        events_url,
        video_connection: video_connection.clone(),
        audio_connection: audio_connection.clone(),
        proxy_agent: proxy::make_agent(),
        pc_base: pc_base.clone(),
    });

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
                        id: Some(video_flow_id),
                        frame_width: PROGRAM_WIDTH,
                        frame_height: PROGRAM_HEIGHT,
                        grain_rate_numerator: PROGRAM_FPS_NUM,
                        grain_rate_denominator: PROGRAM_FPS_DEN,
                    }),
                    label: Some(format!("{} Programm", env_or("OMP_LABEL", "PIPELINE CONTROLLER"))),
                    ..Default::default()
                },
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Audio {
                        id: Some(audio_flow_id),
                        sample_rate_numerator: 48000,
                        channel_count: 2,
                        media_type: "audio/float32".to_string(),
                        bit_depth: 32,
                    }),
                    label: Some(format!("{} Programm Audio", env_or("OMP_LABEL", "PIPELINE CONTROLLER"))),
                    ..Default::default()
                },
            ],
            receivers: vec![
                ReceiverSpec {
                    id: Some(video_receiver_id),
                    transport: Some(TRANSPORT_MXL.to_string()),
                    media_types: Some(vec!["video/v210".to_string()]),
                    ..Default::default()
                },
                ReceiverSpec {
                    id: Some(audio_receiver_id),
                    transport: Some(TRANSPORT_MXL.to_string()),
                    media_types: Some(vec!["audio/float32".to_string()]),
                    label: Some("Audio".to_string()),
                },
            ],
            instance_id,
            // Kein eigener Medien-I/O-Probe verdrahtet (die eigentliche
            // Pipeline läuft in PIPELINE CONTROLLERs Kindprozess, nicht im
            // Adapter selbst) — konservativ "unbekannt" statt eine
            // ungeprüfte Bereitschaft vorzutäuschen (s. MediaReadySource-Doku).
            media_ready: MediaReadySource::Unknown,
        },
        store,
    )
    .await?;
    let _ = &handle;

    tokio::signal::ctrl_c().await?;
    eprintln!("omp-pipeline-controller: shutdown requested");
    let _ = pc_child.kill().await;

    Ok(())
}
