//! Playout-Node: produziert Bild und Ton über eine GStreamer-Testsignal-
//! Pipeline (`pipeline.rs`) und meldet sich wie jeder Node über
//! `omp-node-sdk` bei der NMOS-Registry an. Ein readonly `fps`-Parameter
//! macht die gemessene Bildrate im generischen Parameter-Panel (B6)
//! sichtbar; Pipeline-Fehler werden als NATS-Alarm über
//! `NodeHandle::publish_alert` gemeldet (`UMSETZUNG.md` C2).
//!
//! Netz-Ausgang (`UMSETZUNG.md` C3): das Video verlässt den Prozess als
//! RTP (`omp_mediaio::rtp::RtpVideoOutput`) an eine über IS-05 steuerbare
//! Ziel-Adresse. `RtpControl`/`RtpSdp` verbinden die generische
//! IS-05-Sender-Connection-API aus `omp_node_sdk::connection` mit dem
//! konkreten RTP-Ausgang — der Node selbst kennt nur `omp-mediaio`s
//! `Output`-Trait, keine RTP-Spezifika.

mod pipeline;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use omp_mediaio::MediaFlow;
use omp_mediaio::Output;
use omp_mediaio::rtp::RtpVideoOutput;
use omp_node_sdk::connection::{SenderConnection, SenderControl, SenderResource, SenderSdp};
use omp_node_sdk::{
    Descriptor, InvokeError, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse,
    SenderSpec, SetError,
};
use serde_json::Value;

/// Setzt IS-05-PATCHes (Ziel, Ein/Aus) auf den echten RTP-Ausgang um.
struct RtpControl {
    output: Arc<RtpVideoOutput>,
}

impl SenderControl for RtpControl {
    fn apply(&self, resource: &SenderResource) {
        if let Some(leg) = resource.transport_params.first()
            && let (Some(ip), Some(port)) = (&leg.destination_ip, leg.destination_port)
        {
            self.output.set_destination(ip, port);
        }
        self.output.set_active(resource.master_enable);
    }
}

/// Liefert die SDP des RTP-Ausgangs für `.../transportfile`.
struct RtpSdp {
    output: Arc<RtpVideoOutput>,
}

impl SenderSdp for RtpSdp {
    fn sdp(&self, _resource: &SenderResource) -> String {
        self.output.sdp()
    }
}

struct PlayoutStore {
    fps: Arc<Mutex<f64>>,
    connection: Option<Arc<SenderConnection<RtpControl, RtpSdp>>>,
}

impl ParamStore for PlayoutStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![ParamSpec {
                name: "fps".to_string(),
                kind: ParamType::Number,
                unit: None,
                range: None,
                readonly: true,
            }],
            methods: vec![MethodSpec {
                name: "reset".to_string(),
                args: vec![],
            }],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        if name == "fps" {
            Some(serde_json::json!(*self.fps.lock().expect("lock poisoned")))
        } else {
            None
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(
        &self,
        name: &str,
        _args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        // Kein echter Effekt in C2/C3 (keine Playlist, die zurückgesetzt
        // werden könnte) — Platzhalter, damit der Node schon jetzt eine
        // Methode im Panel zeigt; echte Semantik folgt mit der
        // Playlist-Engine (C4).
        if name == "reset" {
            Ok(())
        } else {
            Err(InvokeError::Unknown)
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let connection = self.connection.as_ref()?;
        let (status, content_type, body) = connection.handle(method, path, body)?;
        Some(RawResponse {
            status,
            content_type,
            body,
        })
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Playout");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9301").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    // Vom Instanz-Launcher gesetzt (`UMSETZUNG.md` C8), sonst leer bei
    // manuellem Start. Playout ist (noch) nicht im Katalog, unterstützt
    // den Tag hier aber schon mit, damit `NodeConfig` einheitlich bleibt.
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let video_element = env_or("OMP_PLAYOUT_VIDEO_ELEMENT", "videotestsrc");
    let audio_element = env_or("OMP_PLAYOUT_AUDIO_ELEMENT", "audiotestsrc");
    let framerate: i32 = env_or("OMP_PLAYOUT_FRAMERATE", "25").parse()?;
    let dest_host = env_or("OMP_PLAYOUT_DEST_HOST", "127.0.0.1");
    let dest_port: u16 = env_or("OMP_PLAYOUT_DEST_PORT", "5004").parse()?;

    // Die Sender-ID wird hier (statt erst in omp-node-sdk) erzeugt, weil
    // manifest_href von ihr abhängt (.../senders/<id>/transportfile) —
    // klassisches Henne-Ei-Problem, gelöst über SenderSpec::id.
    let sender_id = omp_node_sdk::idgen::new_v4();
    let manifest_href = format!(
        "http://{host}:{port}/x-nmos/connection/v1.1/single/senders/{sender_id}/transportfile"
    );

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        video_element,
        audio_element,
        framerate_numerator: framerate,
        framerate_denominator: 1,
        initial_destination_host: dest_host,
        initial_destination_port: dest_port,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_thread =
        std::thread::spawn(move || pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx));

    let fps = Arc::new(Mutex::new(0.0));

    // Wartet, bis die Pipeline (auf ihrem eigenen Thread) den RTP-Ausgang
    // gebaut hat oder scheitert — erst danach ist bekannt, ob eine
    // IS-05-Sender-Connection überhaupt angeboten werden kann. Schlägt der
    // Aufbau fehl (z. B. "ungültiges Element per Env"), bleibt der Node
    // trotzdem nutzbar: registriert, Heartbeat/Alarm laufen weiter, nur
    // ohne Sender-Connection-Endpoint (siehe pipeline::Event::Error
    // weiter unten für den Alarm dazu).
    let rtp_output: Option<Arc<RtpVideoOutput>> = match ready_rx.await {
        Ok(Ok(output)) => Some(output),
        Ok(Err(e)) => {
            eprintln!("playout: pipeline build failed, sender connection unavailable: {e}");
            None
        }
        Err(_) => {
            eprintln!("playout: pipeline thread ended before reporting readiness");
            None
        }
    };
    let connection = rtp_output.clone().map(|output| {
        Arc::new(SenderConnection::new(
            sender_id.clone(),
            RtpControl {
                output: output.clone(),
            },
            RtpSdp { output },
        ))
    });

    let store: Arc<dyn ParamStore> = Arc::new(PlayoutStore {
        fps: fps.clone(),
        connection,
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![SenderSpec {
                id: Some(sender_id),
                manifest_href: Some(manifest_href),
                ..Default::default()
            }],
            receivers: vec![],
            instance_id,
            // "media-ready" über den echten RTP-Ausgang (ARCHITECTURE.md
            // §5 Punkt 6, UMSETZUNG.md D5-prep-2): `RtpVideoOutput` trägt
            // `has_flowed()` seit D5-prep-2 selbst (Probe auf dem Src-Pad
            // seines internen Valve, s. omp-mediaio/src/rtp.rs) — ein
            // gescheiterter Pipeline-Aufbau (kein `rtp_output`) bleibt
            // ehrlich `Unknown` statt fälschlich `true`.
            media_ready: match &rtp_output {
                Some(output) => {
                    let output = output.clone();
                    omp_node_sdk::MediaReadySource::Probe(Arc::new(move || output.has_flowed()))
                }
                None => omp_node_sdk::MediaReadySource::Unknown,
            },
        },
        store,
    )
    .await?;

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Fps(measured) => {
                    *fps.lock().expect("lock poisoned") = measured;
                    eprintln!("playout: measured video fps ~= {measured:.1}");
                }
                pipeline::Event::Error(message) => {
                    eprintln!("playout: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("playout: shutdown requested");
        }
        _ = events => {
            eprintln!("playout: pipeline thread ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}
