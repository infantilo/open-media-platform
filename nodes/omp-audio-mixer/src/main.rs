//! omp-audio-mixer: zweiter §13-Referenzknoten (`UMSETZUNG.md` C11) —
//! ein `NcBlock` mit dynamischer `ChannelStrip`-Anzahl
//! (`addChannel`/`removeChannel`), Gain/EQ pro Kanal und Audio-Follow-
//! Video gegen den von `omp-video-mixer-me` (C10) bespielten
//! `omp.tally.<node_id>`-NATS-Bus — kein neuer Sync-Mechanismus
//! (`ARCHITECTURE.md` §13.2).
//!
//! **Deskriptor-Namensraum** wie bei C10 (v0-Schema kennt keine
//! `NcBlock`/`NcWorker`-Verschachtelung, `omp-node-sdk/src/
//! descriptor.rs`): `channel.<id>.<name>` pro dynamischem `ChannelStrip`.
//! Anders als C10s feste Worker ist die Kanalliste hier zur Laufzeit
//! veränderlich — der Descriptor wird bei jedem `GET /descriptor.json`
//! frisch aus der aktuellen Kanalliste generiert (`descriptor()` unten),
//! B6/das eigene UI-Bundle re-fetchen entsprechend (kein Push-Mechanismus
//! nötig, `ARCHITECTURE.md` §13.2).

mod pipeline;
mod uibundle;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_node_sdk::health;
use omp_node_sdk::is04::{self, RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    Range, RawResponse, SenderSpec, SetError,
};
use pipeline::PipelineHandle;
use serde_json::Value;

/// Feste Crossfade-Dauer für `followMode=crossfade` (Minimalausbau, keine
/// pro-Kanal-konfigurierbare Zeit — §13.2 nennt `crossfadeMs` als
/// Konzept, nicht als Pflicht-Parameter; volle Konfigurierbarkeit bleibt
/// wie Kompressor/Limiter/Aux/Gruppen Community-Vertiefung).
const FOLLOW_CROSSFADE_MS: u64 = 500;
const FOLLOW_CROSSFADE_STEPS: u64 = 12;

#[derive(Clone)]
struct ChannelState {
    id: String,
    label: String,
    gain_db: f64,
    mute: bool,
    eq_low: f64,
    eq_mid: f64,
    eq_high: f64,
    /// Node-ID der zu verfolgenden Quelle (Tally-Bus-Subject,
    /// `omp.tally.<node_id>`) — leer = keine Kopplung.
    follow_target: String,
    /// "off" | "cut" | "crossfade".
    follow_mode: String,
    /// Manueller Override (§13.2): unterbricht die Kopplung für diesen
    /// Kanal, ohne den Automatismus anderer Kanäle zu beeinflussen.
    override_enabled: bool,
    /// Testton-Frequenz, die dieser Kanal bei `addChannel` bekam — bleibt
    /// über einen Quellwechsel hin und her erhalten, damit `setSource("")`
    /// (zurück auf intern) immer denselben, wiedererkennbaren Ton liefert
    /// statt bei jedem Wechsel neu zu würfeln.
    internal_freq: f64,
    /// `senderId` der aktuell gewählten externen Quelle, leer = interner
    /// Testton (`pipeline::ChannelSource::Internal`).
    source: String,
}

impl ChannelState {
    fn new(id: String, label: String, internal_freq: f64) -> Self {
        ChannelState {
            id,
            label,
            gain_db: 0.0,
            mute: false,
            eq_low: 0.0,
            eq_mid: 0.0,
            eq_high: 0.0,
            follow_target: String::new(),
            follow_mode: "off".to_string(),
            override_enabled: false,
            internal_freq,
            source: String::new(),
        }
    }
}

/// Ein per IS-04-Discovery gefundener externer MXL-Audio-Sender —
/// wählbar als Kanalquelle (`channel.<id>.setSource`).
#[derive(Debug, Clone)]
struct DiscoveredAudioSource {
    sender_id: String,
    label: String,
    flow_id: String,
}

struct AudioMixerStore {
    channels: Arc<Mutex<Vec<ChannelState>>>,
    available_sources: Arc<Mutex<Vec<DiscoveredAudioSource>>>,
    next_seq: Arc<AtomicU64>,
    pipeline: PipelineHandle,
}

/// Testton-Frequenz pro Kanal — nur zur akustischen Unterscheidbarkeit im
/// Software-Testsignal (s. `pipeline.rs`-Moduldoku), keine funktionale
/// Bedeutung.
fn channel_freq(seq: u64) -> f64 {
    220.0 * (1 + (seq % 8)) as f64
}

/// `readonly: true` für alle Kanal-Parameter — Zustandsänderungen laufen
/// ausschließlich über die `channel.<id>.set*`-Methoden (Range-Prüfung,
/// `followMode`-Validierung etc.), nicht über generisches `PATCH
/// /params/<name>` (gleiche Konvention wie `omp-video-mixer-me`, C10:
/// `set()` gibt dort wie hier immer `SetError::ReadOnly` zurück — beim
/// C11-Verifikationslauf per `tools/contract-check` (C9) gefunden, das
/// `readonly: false` hier ursprünglich fälschlich als PATCH-fähig
/// deklariert hatte, während `set()` das nie unterstützt hat).
fn channel_param(worker: &str, name: &str, kind: ParamType, range: Option<Range>) -> ParamSpec {
    ParamSpec {
        name: format!("channel.{worker}.{name}"),
        kind,
        unit: None,
        range,
        readonly: true,
    }
}

impl ParamStore for AudioMixerStore {
    fn descriptor(&self) -> Descriptor {
        let channels = self.channels.lock().expect("lock poisoned");

        let mut parameters = vec![
            // JSON-Array [{id,label}], gleiche Array-Ausnahme wie
            // "crosspoint.inputs" bei omp-video-mixer-me (C10).
            ParamSpec {
                name: "channels".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            // JSON-Array [{senderId,label}] — per Discovery gefundene
            // externe MXL-Audio-Sender, wählbar über
            // `channel.<id>.setSource`.
            ParamSpec {
                name: "availableSources".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
        ];
        let mut methods = vec![
            MethodSpec {
                name: "addChannel".to_string(),
                args: vec![MethodArg {
                    name: "label".to_string(),
                    kind: ParamType::String,
                }],
            },
            MethodSpec {
                name: "removeChannel".to_string(),
                args: vec![MethodArg {
                    name: "channelId".to_string(),
                    kind: ParamType::String,
                }],
            },
        ];

        for ch in channels.iter() {
            let id = &ch.id;
            parameters.push(ParamSpec {
                name: format!("channel.{id}.label"),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            });
            parameters.push(channel_param(
                id,
                "gain",
                ParamType::Number,
                Some(Range::Number { min: -60.0, max: 12.0 }),
            ));
            parameters.push(channel_param(id, "mute", ParamType::Boolean, None));
            for band in ["eqLow", "eqMid", "eqHigh"] {
                parameters.push(channel_param(
                    id,
                    band,
                    ParamType::Number,
                    Some(Range::Number { min: -24.0, max: 12.0 }),
                ));
            }
            // `senderId` der externen Quelle, leer = interner Testton.
            parameters.push(channel_param(id, "source", ParamType::String, None));
            parameters.push(channel_param(id, "followTarget", ParamType::String, None));
            parameters.push(channel_param(
                id,
                "followMode",
                ParamType::Enum,
                Some(Range::Enum {
                    values: vec!["off".to_string(), "cut".to_string(), "crossfade".to_string()],
                }),
            ));
            parameters.push(channel_param(
                id,
                "overrideEnabled",
                ParamType::Boolean,
                None,
            ));

            methods.push(MethodSpec {
                name: format!("channel.{id}.setGain"),
                args: vec![MethodArg {
                    name: "db".to_string(),
                    kind: ParamType::Number,
                }],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setMute"),
                args: vec![MethodArg {
                    name: "muted".to_string(),
                    kind: ParamType::Boolean,
                }],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setEq"),
                args: vec![
                    MethodArg {
                        name: "low".to_string(),
                        kind: ParamType::Number,
                    },
                    MethodArg {
                        name: "mid".to_string(),
                        kind: ParamType::Number,
                    },
                    MethodArg {
                        name: "high".to_string(),
                        kind: ParamType::Number,
                    },
                ],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setSource"),
                args: vec![MethodArg {
                    name: "senderId".to_string(),
                    kind: ParamType::String,
                }],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setFollow"),
                args: vec![
                    MethodArg {
                        name: "targetNodeId".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "mode".to_string(),
                        kind: ParamType::String,
                    },
                ],
            });
            methods.push(MethodSpec {
                name: format!("channel.{id}.setOverride"),
                args: vec![MethodArg {
                    name: "enabled".to_string(),
                    kind: ParamType::Boolean,
                }],
            });
        }

        Descriptor { parameters, methods }
    }

    fn get(&self, name: &str) -> Option<Value> {
        if name == "channels" {
            let channels = self.channels.lock().expect("lock poisoned");
            return Some(serde_json::json!(
                channels
                    .iter()
                    .map(|c| serde_json::json!({"id": c.id, "label": c.label}))
                    .collect::<Vec<_>>()
            ));
        }
        if name == "availableSources" {
            let sources = self.available_sources.lock().expect("lock poisoned");
            return Some(serde_json::json!(
                sources
                    .iter()
                    .map(|s| serde_json::json!({"senderId": s.sender_id, "label": s.label}))
                    .collect::<Vec<_>>()
            ));
        }

        let (id, prop) = parse_channel_name(name)?;
        let channels = self.channels.lock().expect("lock poisoned");
        let ch = channels.iter().find(|c| c.id == id)?;
        match prop {
            "label" => Some(serde_json::json!(ch.label)),
            "gain" => Some(serde_json::json!(ch.gain_db)),
            "mute" => Some(serde_json::json!(ch.mute)),
            "eqLow" => Some(serde_json::json!(ch.eq_low)),
            "eqMid" => Some(serde_json::json!(ch.eq_mid)),
            "eqHigh" => Some(serde_json::json!(ch.eq_high)),
            "source" => Some(serde_json::json!(ch.source)),
            "followTarget" => Some(serde_json::json!(ch.follow_target)),
            "followMode" => Some(serde_json::json!(ch.follow_mode)),
            "overrideEnabled" => Some(serde_json::json!(ch.override_enabled)),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "addChannel" => {
                let label = args
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
                let id = format!("ch{seq}");
                let label = label.unwrap_or_else(|| format!("Kanal {seq}"));
                let freq = channel_freq(seq);
                self.channels
                    .lock()
                    .expect("lock poisoned")
                    .push(ChannelState::new(id.clone(), label, freq));
                self.pipeline
                    .add_channel(id, pipeline::ChannelSource::Internal { freq });
                Ok(())
            }
            "removeChannel" => {
                let channel_id = args
                    .get("channelId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let mut channels = self.channels.lock().expect("lock poisoned");
                let before = channels.len();
                channels.retain(|c| c.id != channel_id);
                if channels.len() == before {
                    return Err(InvokeError::Unknown);
                }
                self.pipeline.remove_channel(channel_id.to_string());
                Ok(())
            }
            _ => self.invoke_channel_method(name, args),
        }
    }

    fn extra_route(&self, method: &str, path: &str, _body: &[u8]) -> Option<RawResponse> {
        uibundle::route(method, path)
    }
}

/// Zerlegt `channel.<id>.<prop>` — `id` selbst kann kein `.` enthalten
/// (per `ch<seq>`-Generierung, `invoke()` oben), ein einfacher Split
/// reicht.
fn parse_channel_name(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix("channel.")?;
    rest.split_once('.')
}

impl AudioMixerStore {
    fn invoke_channel_method(
        &self,
        name: &str,
        args: &serde_json::Map<String, Value>,
    ) -> Result<(), InvokeError> {
        let rest = name.strip_prefix("channel.").ok_or(InvokeError::Unknown)?;
        let (id, method) = rest.split_once('.').ok_or(InvokeError::Unknown)?;

        let mut channels = self.channels.lock().expect("lock poisoned");
        let ch = channels
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or(InvokeError::Unknown)?;

        match method {
            "setGain" => {
                let db = args.get("db").and_then(Value::as_f64).ok_or(InvokeError::Unknown)?;
                ch.gain_db = db;
                self.pipeline.set_gain(id.to_string(), db);
                Ok(())
            }
            "setMute" => {
                let muted = args
                    .get("muted")
                    .and_then(Value::as_bool)
                    .ok_or(InvokeError::Unknown)?;
                ch.mute = muted;
                self.pipeline.set_mute(id.to_string(), muted);
                Ok(())
            }
            "setEq" => {
                let low = args.get("low").and_then(Value::as_f64).ok_or(InvokeError::Unknown)?;
                let mid = args.get("mid").and_then(Value::as_f64).ok_or(InvokeError::Unknown)?;
                let high = args.get("high").and_then(Value::as_f64).ok_or(InvokeError::Unknown)?;
                ch.eq_low = low;
                ch.eq_mid = mid;
                ch.eq_high = high;
                self.pipeline.set_eq(id.to_string(), low, mid, high);
                Ok(())
            }
            "setSource" => {
                let sender_id = args
                    .get("senderId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                if sender_id.is_empty() {
                    ch.source.clear();
                    self.pipeline.set_channel_source(
                        id.to_string(),
                        pipeline::ChannelSource::Internal { freq: ch.internal_freq },
                    );
                } else {
                    let flow_id = self
                        .available_sources
                        .lock()
                        .expect("lock poisoned")
                        .iter()
                        .find(|s| s.sender_id == sender_id)
                        .map(|s| s.flow_id.clone())
                        .ok_or(InvokeError::Unknown)?;
                    ch.source = sender_id.to_string();
                    self.pipeline
                        .set_channel_source(id.to_string(), pipeline::ChannelSource::External { flow_id });
                }
                // Der neue Zweig startet mit Standardwerten (Gain 0dB,
                // nicht stumm, EQ flach) — bereits konfigurierte Werte
                // dieses Kanals erneut anwenden. Reihenfolge garantiert
                // durch den einen mpsc-Kommandokanal der Pipeline (FIFO):
                // `SetChannelSource` ist längst verarbeitet, bevor diese
                // drei Kommandos ankommen.
                self.pipeline.set_gain(id.to_string(), ch.gain_db);
                self.pipeline.set_mute(id.to_string(), ch.mute);
                self.pipeline
                    .set_eq(id.to_string(), ch.eq_low, ch.eq_mid, ch.eq_high);
                Ok(())
            }
            "setFollow" => {
                let target = args
                    .get("targetNodeId")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                let mode = args
                    .get("mode")
                    .and_then(Value::as_str)
                    .ok_or(InvokeError::Unknown)?;
                if !["off", "cut", "crossfade"].contains(&mode) {
                    return Err(InvokeError::Unknown);
                }
                ch.follow_target = target.to_string();
                ch.follow_mode = mode.to_string();
                Ok(())
            }
            "setOverride" => {
                let enabled = args
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or(InvokeError::Unknown)?;
                ch.override_enabled = enabled;
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "AudioMixer");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9370").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    let sender_id = omp_node_sdk::idgen::new_v4();
    let flow_id = omp_node_sdk::idgen::new_v4();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();

    let pipeline_config = pipeline::Config {
        domain,
        flow_id: flow_id.clone(),
        label: label.clone(),
    };
    let pipeline_shutdown = shutdown.clone();
    let pipeline_thread =
        std::thread::spawn(move || pipeline::run(pipeline_config, tx, pipeline_shutdown, ready_tx));

    let pipeline_handle = match ready_rx.await {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            eprintln!("omp-audio-mixer: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => {
            eprintln!("omp-audio-mixer: pipeline thread ended before reporting readiness");
            return Err("pipeline thread ended before reporting readiness".into());
        }
    };

    let channels: Arc<Mutex<Vec<ChannelState>>> = Arc::new(Mutex::new(Vec::new()));
    let available_sources: Arc<Mutex<Vec<DiscoveredAudioSource>>> = Arc::new(Mutex::new(Vec::new()));
    let store: Arc<dyn ParamStore> = Arc::new(AudioMixerStore {
        channels: channels.clone(),
        available_sources: available_sources.clone(),
        next_seq: Arc::new(AtomicU64::new(1)),
        pipeline: pipeline_handle.clone(),
    });

    // Für die Discovery gebraucht (den eigenen Sender ausschließen) —
    // `sender_id` wird gleich in die `SenderSpec` verschoben, also vorher
    // klonen; `registry_url` ebenso, weil `NodeConfig` sie konsumiert.
    let own_sender_id = sender_id.clone();
    let discovery_registry_url = registry_url.clone();

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url: nats_url.clone(),
            senders: vec![SenderSpec {
                id: Some(sender_id),
                transport: Some(omp_node_sdk::is04::TRANSPORT_MXL.to_string()),
                flow: Some(omp_node_sdk::node::FlowSpec::Audio {
                    id: Some(flow_id),
                    sample_rate_numerator: pipeline::SAMPLE_RATE,
                    channel_count: pipeline::CHANNELS,
                    media_type: "audio/float32".to_string(),
                    bit_depth: 32,
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

    let follow_video = audio_follow_video_loop(nats_url, channels, pipeline_handle);
    let discovery = discovery_loop(discovery_registry_url, own_sender_id, available_sources);

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    eprintln!("omp-audio-mixer: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-audio-mixer: shutdown requested");
        }
        _ = events => {
            eprintln!("omp-audio-mixer: pipeline thread ended");
        }
        _ = follow_video => {
            eprintln!("omp-audio-mixer: audio-follow-video loop ended");
        }
        _ = discovery => {
            eprintln!("omp-audio-mixer: discovery loop ended");
        }
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();

    Ok(())
}

/// Audio-Follow-Video (`UMSETZUNG.md` C11, `ARCHITECTURE.md` §13.2):
/// abonniert den Tally-Bus, den `omp-video-mixer-me` (C10) bei jedem
/// Crosspoint-Wechsel bespielt, und schaltet passend konfigurierte Kanäle
/// automatisch stumm/auf — kein neuer Sync-Mechanismus, derselbe Bus, der
/// im Flow-Editor schon Kacheln rot färbt (B4).
async fn audio_follow_video_loop(
    nats_url: String,
    channels: Arc<Mutex<Vec<ChannelState>>>,
    pipeline: PipelineHandle,
) {
    let mut subscription = match health::subscribe_tally(&nats_url).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("omp-audio-mixer: tally subscribe failed, Audio-Follow-Video inaktiv: {e}");
            return;
        }
    };

    // Pro Kanal höchstens eine laufende Crossfade-Rampe — verhindert,
    // dass zwei schnell aufeinanderfolgende Tally-Wechsel um denselben
    // Kanal konkurrieren (gleiche Nebenläufigkeits-Vorsicht wie C10s
    // `fading`-Sperre, hier pro Kanal statt global).
    let ramp_generation: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));

    while let Some((node_id, on)) = subscription.next().await {
        let matches: Vec<(String, String, bool)> = {
            let channels = channels.lock().expect("lock poisoned");
            channels
                .iter()
                .filter(|c| {
                    !c.override_enabled && c.follow_mode != "off" && c.follow_target == node_id
                })
                .map(|c| (c.id.clone(), c.follow_mode.clone(), c.mute))
                .collect()
        };

        for (channel_id, follow_mode, _current_mute) in matches {
            let target_mute = !on;
            if follow_mode == "cut" {
                {
                    let mut channels = channels.lock().expect("lock poisoned");
                    if let Some(ch) = channels.iter_mut().find(|c| c.id == channel_id) {
                        ch.mute = target_mute;
                    }
                }
                pipeline.set_mute(channel_id.clone(), target_mute);
                continue;
            }

            // "crossfade": Gain über FOLLOW_CROSSFADE_MS rampen statt hart
            // stummschalten — sanfteres Auf-/Abblenden beim Kamera-
            // /Quellwechsel. Läuft als eigener Tokio-Task (nur
            // Command-Sends, kein direkter GStreamer-Objektzugriff nötig
            // wie bei C10s Thread-Rampe, deshalb hier async statt
            // `std::thread`).
            let generation = {
                let mut gens = ramp_generation.lock().expect("lock poisoned");
                let g = gens.entry(channel_id.clone()).or_insert(0);
                *g += 1;
                *g
            };
            let pipeline = pipeline.clone();
            let channels = channels.clone();
            let ramp_generation = ramp_generation.clone();
            let channel_id_task = channel_id.clone();
            tokio::spawn(async move {
                let base_db = {
                    let ch = channels.lock().expect("lock poisoned");
                    ch.iter()
                        .find(|c| c.id == channel_id_task)
                        .map(|c| c.gain_db)
                        .unwrap_or(0.0)
                };
                pipeline.set_mute(channel_id_task.clone(), false);
                let (from, to) = if on { (-60.0, base_db) } else { (base_db, -60.0) };
                for step in 1..=FOLLOW_CROSSFADE_STEPS {
                    if *ramp_generation
                        .lock()
                        .expect("lock poisoned")
                        .get(&channel_id_task)
                        .unwrap_or(&0)
                        != generation
                    {
                        return; // von einer neueren Rampe überholt
                    }
                    let t = step as f64 / FOLLOW_CROSSFADE_STEPS as f64;
                    pipeline.set_gain(channel_id_task.clone(), from + (to - from) * t);
                    tokio::time::sleep(tokio::time::Duration::from_millis(
                        FOLLOW_CROSSFADE_MS / FOLLOW_CROSSFADE_STEPS,
                    ))
                    .await;
                }
                if !on {
                    pipeline.set_mute(channel_id_task, true);
                }
            });
        }
    }
}

/// Pollt alle 2s die IS-04-Query-API nach MXL-Audio-Sendern (gleicher
/// Poll-Stil wie `omp-switcher`/`omp-video-mixer-me`, C7/C10) — Grundlage
/// für `channel.<id>.setSource`, damit ein Kanal auf einen echten
/// externen MXL-Audio-Flow umschalten kann statt nur auf den internen
/// Testton. Filtert zusätzlich auf `format==audio`
/// (`RegistryClient::get_flow_format`, dieselbe Notwendigkeit, die C10/C7
/// erst nach Einführung dieses Nodes traf, s. `docs/decisions.md`
/// 2026-07-11) — sonst würde ein Video-Sender fälschlich als wählbare
/// Audioquelle auftauchen.
async fn discovery_loop(
    registry_url: String,
    own_sender_id: String,
    sources: Arc<Mutex<Vec<DiscoveredAudioSource>>>,
) {
    let registry = RegistryClient::new(registry_url);
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    loop {
        interval.tick().await;
        let registry = registry.clone();
        let own_sender_id = own_sender_id.clone();
        let result = tokio::task::spawn_blocking(
            move || -> Result<Vec<DiscoveredAudioSource>, String> {
                let senders = registry.list_senders().map_err(|e| e.to_string())?;
                Ok(senders
                    .into_iter()
                    .filter(|s| s.transport == TRANSPORT_MXL && s.id != own_sender_id)
                    .filter_map(|s| s.flow_id.map(|flow_id| (s.id, s.label, flow_id)))
                    .filter(|(_, _, flow_id)| {
                        matches!(registry.get_flow_format(flow_id), Ok(format) if format == is04::FORMAT_AUDIO)
                    })
                    .map(|(sender_id, label, flow_id)| DiscoveredAudioSource {
                        sender_id,
                        label,
                        flow_id,
                    })
                    .collect())
            },
        )
        .await;

        match result {
            Ok(Ok(discovered)) => {
                *sources.lock().expect("lock poisoned") = discovered;
            }
            Ok(Err(e)) => eprintln!("omp-audio-mixer: discovery poll failed: {e}"),
            Err(e) => eprintln!("omp-audio-mixer: discovery poll task panicked: {e}"),
        }
    }
}
