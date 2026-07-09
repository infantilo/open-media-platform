//! Playout-Node: produziert Bild und Ton über eine GStreamer-Pipeline
//! (`pipeline.rs`) und meldet sich wie jeder Node über `omp-node-sdk` bei
//! der NMOS-Registry an. Pipeline-Fehler werden als NATS-Alarm über
//! `NodeHandle::publish_alert` gemeldet (`UMSETZUNG.md` C2).
//!
//! Netz-Ausgang (`UMSETZUNG.md` C3): das Video verlässt den Prozess als
//! RTP (`omp_mediaio::rtp::RtpVideoOutput`) an eine über IS-05 steuerbare
//! Ziel-Adresse. `RtpControl`/`RtpSdp` verbinden die generische
//! IS-05-Sender-Connection-API aus `omp_node_sdk::connection` mit dem
//! konkreten RTP-Ausgang — der Node selbst kennt nur `omp-mediaio`s
//! `Output`-Trait, keine RTP-Spezifika.
//!
//! Playlist-Engine (`UMSETZUNG.md` C4): `playlist.rs` hält die reine
//! Clip-Logik (laden/cuen/take, ohne GStreamer-Wissen); `PlayoutStore`
//! verbindet sie mit dem generischen Descriptor/Method-API und schickt
//! `pipeline::Command::PlayUri` an den Pipeline-Thread, sobald ein Clip
//! auf Sendung gehen soll (per `take()` oder automatisch bei `advance()`
//! nach einem EOS).

mod pipeline;
mod playlist;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender as StdSender;
use std::sync::{Arc, Mutex};

use omp_mediaio::Output;
use omp_mediaio::rtp::RtpVideoOutput;
use omp_node_sdk::connection::{SenderConnection, SenderControl, SenderResource, SenderSdp};
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    RawResponse, SenderSpec, SetError,
};
use playlist::{Mode, Playlist};
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
    playhead: Arc<Mutex<f64>>,
    playlist: Arc<Mutex<Playlist>>,
    commands: StdSender<pipeline::Command>,
    connection: Option<Arc<SenderConnection<RtpControl, RtpSdp>>>,
}

impl PlayoutStore {
    /// Schickt `uri` (falls vorhanden) an den Pipeline-Thread. Gemeinsame
    /// Umsetzung für `take()` und die automatische Weiterschaltung nach
    /// einem EOS (siehe `main()`s Event-Loop).
    fn play(&self, uri: Option<String>) {
        if let Some(uri) = uri {
            let _ = self.commands.send(pipeline::Command::PlayUri(uri));
        }
    }
}

fn require_string_arg(
    args: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<String, InvokeError> {
    args.get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or(InvokeError::Unknown)
}

fn require_index_arg(
    args: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<usize, InvokeError> {
    args.get(name)
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .ok_or(InvokeError::Unknown)
}

impl ParamStore for PlayoutStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            parameters: vec![
                ParamSpec {
                    name: "fps".to_string(),
                    kind: ParamType::Number,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "items".to_string(),
                    kind: ParamType::String,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "currentIndex".to_string(),
                    kind: ParamType::Number,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    // Entspricht "ChannelStatus.onAir" im NcBlock-Beispiel
                    // aus ARCHITECTURE.md §11.1.
                    name: "onAir".to_string(),
                    kind: ParamType::Boolean,
                    unit: None,
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "playheadPosition".to_string(),
                    kind: ParamType::Number,
                    unit: Some("s".to_string()),
                    range: None,
                    readonly: true,
                },
                ParamSpec {
                    name: "mode".to_string(),
                    kind: ParamType::Enum,
                    unit: None,
                    range: Some(omp_node_sdk::Range::Enum {
                        values: vec!["auto".to_string(), "hold".to_string()],
                    }),
                    readonly: false,
                },
            ],
            methods: vec![
                MethodSpec {
                    name: "load".to_string(),
                    args: vec![MethodArg {
                        name: "uri".to_string(),
                        kind: ParamType::String,
                    }],
                },
                MethodSpec {
                    name: "append".to_string(),
                    args: vec![MethodArg {
                        name: "uri".to_string(),
                        kind: ParamType::String,
                    }],
                },
                MethodSpec {
                    name: "remove".to_string(),
                    args: vec![MethodArg {
                        name: "index".to_string(),
                        kind: ParamType::Number,
                    }],
                },
                MethodSpec {
                    name: "cue".to_string(),
                    args: vec![MethodArg {
                        name: "index".to_string(),
                        kind: ParamType::Number,
                    }],
                },
                MethodSpec {
                    name: "take".to_string(),
                    args: vec![],
                },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "fps" => Some(serde_json::json!(*self.fps.lock().expect("lock poisoned"))),
            "playheadPosition" => Some(serde_json::json!(
                *self.playhead.lock().expect("lock poisoned")
            )),
            "items" => {
                let playlist = self.playlist.lock().expect("lock poisoned");
                Some(serde_json::json!(
                    serde_json::to_string(playlist.items()).unwrap_or_default()
                ))
            }
            "currentIndex" => {
                let playlist = self.playlist.lock().expect("lock poisoned");
                Some(serde_json::json!(
                    playlist.current_index().map(|i| i as i64).unwrap_or(-1)
                ))
            }
            "onAir" => {
                let playlist = self.playlist.lock().expect("lock poisoned");
                Some(serde_json::json!(playlist.on_air()))
            }
            "mode" => {
                let playlist = self.playlist.lock().expect("lock poisoned");
                Some(serde_json::json!(playlist.mode()))
            }
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        if name != "mode" {
            return Err(SetError::ReadOnly);
        }
        let mode: Mode = serde_json::from_value(value).map_err(|_| SetError::Unknown)?;
        self.playlist.lock().expect("lock poisoned").set_mode(mode);
        Ok(())
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "load" => {
                let uri = require_string_arg(args, "uri")?;
                self.playlist.lock().expect("lock poisoned").load(uri);
                Ok(())
            }
            "append" => {
                let uri = require_string_arg(args, "uri")?;
                self.playlist.lock().expect("lock poisoned").append(uri);
                Ok(())
            }
            "remove" => {
                let index = require_index_arg(args, "index")?;
                self.playlist
                    .lock()
                    .expect("lock poisoned")
                    .remove(index)
                    .map_err(|_| InvokeError::Unknown)
            }
            "cue" => {
                let index = require_index_arg(args, "index")?;
                self.playlist
                    .lock()
                    .expect("lock poisoned")
                    .cue(index)
                    .map_err(|_| InvokeError::Unknown)
            }
            "take" => {
                let uri = self
                    .playlist
                    .lock()
                    .expect("lock poisoned")
                    .take()
                    .map_err(|_| InvokeError::Unknown)?;
                self.play(uri);
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
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
    let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<pipeline::Command>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        framerate_numerator: framerate,
        framerate_denominator: 1,
        initial_destination_host: dest_host,
        initial_destination_port: dest_port,
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_thread = std::thread::spawn(move || {
        pipeline::run(pipeline_config, tx, pipeline_shutdown, cmd_rx, ready_tx)
    });

    let fps = Arc::new(Mutex::new(0.0));
    let playhead = Arc::new(Mutex::new(0.0));
    let playlist = Arc::new(Mutex::new(Playlist::new()));

    // Wartet, bis die Pipeline (auf ihrem eigenen Thread) den RTP-Ausgang
    // gebaut hat oder scheitert — erst danach ist bekannt, ob eine
    // IS-05-Sender-Connection überhaupt angeboten werden kann. Schlägt der
    // Aufbau fehl, bleibt der Node trotzdem nutzbar: registriert, Heartbeat/
    // Alarm laufen weiter, nur ohne Sender-Connection-Endpoint.
    let connection = match ready_rx.await {
        Ok(Ok(output)) => Some(Arc::new(SenderConnection::new(
            sender_id.clone(),
            RtpControl {
                output: output.clone(),
            },
            RtpSdp { output },
        ))),
        Ok(Err(e)) => {
            eprintln!("playout: pipeline build failed, sender connection unavailable: {e}");
            None
        }
        Err(_) => {
            eprintln!("playout: pipeline thread ended before reporting readiness");
            None
        }
    };

    let store: Arc<PlayoutStore> = Arc::new(PlayoutStore {
        fps: fps.clone(),
        playhead: playhead.clone(),
        playlist: playlist.clone(),
        commands: cmd_tx,
        connection,
    });
    let sdk_store: Arc<dyn ParamStore> = store.clone();

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
            }],
            receivers: 0,
        },
        sdk_store,
    )
    .await?;

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Fps(measured) => {
                    *fps.lock().expect("lock poisoned") = measured;
                    eprintln!("playout: measured video fps ~= {measured:.1}");
                }
                pipeline::Event::PlayheadPosition(seconds) => {
                    *playhead.lock().expect("lock poisoned") = seconds;
                }
                pipeline::Event::ClipEnded => {
                    eprintln!("playout: clip ended");
                    let next = playlist.lock().expect("lock poisoned").advance();
                    store.play(next);
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
