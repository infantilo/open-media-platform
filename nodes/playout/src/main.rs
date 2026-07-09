//! Playout-Node (`UMSETZUNG.md` C2): produziert Bild und Ton über eine
//! GStreamer-Testsignal-Pipeline (`pipeline.rs`) und meldet sich wie jeder
//! Node über `omp-node-sdk` bei der NMOS-Registry an. Ein readonly
//! `fps`-Parameter macht die gemessene Bildrate im generischen
//! Parameter-Panel (B6) sichtbar; Pipeline-Fehler werden als NATS-Alarm
//! über `NodeHandle::publish_alert` gemeldet (der Netz-Ausgang folgt in
//! C3, hier zunächst headless `fakesink`).

mod pipeline;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use omp_node_sdk::{
    Descriptor, InvokeError, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, SetError,
};
use serde_json::Value;

struct PlayoutStore {
    fps: Arc<Mutex<f64>>,
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

    fn invoke(&self, name: &str) -> Result<(), InvokeError> {
        // Kein echter Effekt in C2 (keine Playlist, die zurückgesetzt
        // werden könnte) — Platzhalter, damit der Node schon jetzt eine
        // Methode im Panel zeigt; echte Semantik folgt mit der
        // Playlist-Engine (C4).
        if name == "reset" {
            Ok(())
        } else {
            Err(InvokeError::Unknown)
        }
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

    let video_element = env_or("OMP_PLAYOUT_VIDEO_ELEMENT", "videotestsrc");
    let audio_element = env_or("OMP_PLAYOUT_AUDIO_ELEMENT", "audiotestsrc");
    let framerate: i32 = env_or("OMP_PLAYOUT_FRAMERATE", "25").parse()?;

    let fps = Arc::new(Mutex::new(0.0));
    let store: Arc<dyn ParamStore> = Arc::new(PlayoutStore { fps: fps.clone() });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: 1,
            receivers: 0,
        },
        store,
    )
    .await?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));

    let pipeline_config = pipeline::Config {
        video_element,
        audio_element,
        framerate_numerator: framerate,
        framerate_denominator: 1,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_thread =
        std::thread::spawn(move || pipeline::run(pipeline_config, tx, pipeline_shutdown));

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
