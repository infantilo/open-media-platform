//! omp-tams-reader (Kapitel 105.4): spielt einen Zeitbereich eines TAMS-Speichers (API 8.2) als MXL-Quelle ab oder
//! gibt eine laufende Aufnahme **zeitverschoben** wieder (Verzögerung wählbar, z. B. 30 s für „Instant Replay“).
//!
//! Zwei IS-04-Sender (Video, Ton) wie die anderen Quellen; Methoden `tams.play`, `tams.follow`, `tams.stop`. Der Node
//! ist nur Client eines fremden Speichers (Entscheidung D-T2).
//!
//! Einstellung per Umgebung (Zugangsdaten nur aus Datei oder Umgebung, nie aus Parametern — Entscheidung D-T3):
//! * `OMP_TAMS_URL`, `OMP_TAMS_AUTH`, `OMP_TAMS_USER`, `OMP_TAMS_TOKEN_FILE` / `OMP_TAMS_TOKEN` — wie beim Schreiber
//! * `OMP_WIDTH`, `OMP_HEIGHT`, `OMP_FRAMERATE_NUM`, `OMP_FRAMERATE_DEN` — Format des Video-Ausgangs (Standard 1280×720, 25);
//!   abweichende Aufnahmen werden skaliert bzw. in der Bildrate angepasst
//! * `OMP_TAMS_GAP`            `hold` (Standard: letztes Bild wiederholen) | `black`; Ton: Stille
//! * `OMP_TAMS_LEAD_MS`        Vorlauf beim Abspielen eines Bereichs (Standard 2000)

use omp_node_sdk::is04::TRANSPORT_MXL;
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, Range, SenderSpec, SetError};
use omp_tams::auth::{Auth, redact_url, secret_from_env};
use omp_tams::client::{Client, ClientConfig};
use omp_tams::time::Timestamp;
use omp_tams_reader::lane::GapMode;
use omp_tams_reader::runtime::{self, Handle, PlayStatus, Request};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

struct ReaderStore {
    handle: Handle,
    config_problem: Option<String>,
    service_display: String,
    flow_id: String,
    audio_flow_id: String,
}

fn num(name: &str) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind: ParamType::Number, unit: None, range: None, readonly: true }
}
fn text(name: &str) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind: ParamType::String, unit: None, range: None, readonly: true }
}
fn method(name: &str, args: &[(&str, ParamType)]) -> MethodSpec {
    MethodSpec { name: name.to_string(), args: args.iter().map(|(n, k)| MethodArg { name: n.to_string(), kind: *k }).collect() }
}

/// Eine Flow-ID ist eine UUID (36 Zeichen); alles andere weisen wir früh ab, statt es in einen Pfad zu setzen.
fn valid_flow_id(s: &str) -> bool {
    s.len() == 36 && s.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() })
}

fn opt_flow(args: &serde_json::Map<String, Value>, key: &str) -> Result<Option<String>, InvokeError> {
    match args.get(key).and_then(Value::as_str).map(str::trim) {
        None | Some("") => Ok(None),
        Some(s) if valid_flow_id(s) => Ok(Some(s.to_string())),
        Some(_) => Err(InvokeError::Message(format!("{key}: keine gültige Flow-ID (UUID)"))),
    }
}

fn opt_time(args: &serde_json::Map<String, Value>, key: &str) -> Result<Option<i128>, InvokeError> {
    match args.get(key).and_then(Value::as_str).map(str::trim) {
        None | Some("") => Ok(None),
        Some(s) => Timestamp::parse(s).map(|t| Some(t.ns())).map_err(|e| InvokeError::Message(format!("{key}: kein Zeitstempel (Sekunden:Nanosekunden): {e}"))),
    }
}

fn opt_num(args: &serde_json::Map<String, Value>, key: &str) -> f64 {
    args.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// Aus den Argumenten von `tams.play` Anfang und Ende bestimmen (Flow-Zeit, ns).
///
/// * `start` (+ `end`) in TAMS-Zeit, **oder**
/// * `agoSeconds` („vor N Sekunden“) mit `durationSeconds` (Standard: bis jetzt).
fn play_range(args: &serde_json::Map<String, Value>, now_tai_ns: u64) -> Result<(i128, Option<i128>), InvokeError> {
    let (start, end) = (opt_time(args, "start")?, opt_time(args, "end")?);
    let (ago, dur) = (opt_num(args, "agoSeconds"), opt_num(args, "durationSeconds"));
    let (start, end) = match start {
        Some(s) => (s, end),
        None if ago > 0.0 => {
            let s = now_tai_ns as i128 - (ago * 1e9) as i128;
            (s, if dur > 0.0 { Some(s + (dur * 1e9) as i128) } else { end.or(Some(now_tai_ns as i128)) })
        }
        None => return Err(InvokeError::Message("start (Zeitstempel) oder agoSeconds (> 0) angeben".into())),
    };
    if let Some(e) = end
        && e <= start
    {
        return Err(InvokeError::Message("Ende liegt nicht nach dem Anfang".into()));
    }
    Ok((start, end))
}

impl ParamStore for ReaderStore {
    fn descriptor(&self) -> Descriptor {
        let parameters = vec![
            ParamSpec {
                name: "tams.status".to_string(),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum { values: ["idle", "playing", "following", "error"].map(String::from).to_vec() }),
                readonly: true,
            },
            text("tams.service"),
            text("flowId"),
            text("audioFlowId"),
            num("tams.segmentsFetched"),
            num("tams.framesOut"),
            num("tams.blocksOut"),
            num("tams.gapsFilled"),
            num("tams.lateDropped"),
            num("tams.errors"),
            text("tams.lastError"),
        ];
        let methods = vec![
            method("tams.play", &[("videoFlow", ParamType::String), ("audioFlow", ParamType::String), ("start", ParamType::String), ("end", ParamType::String), ("agoSeconds", ParamType::Number), ("durationSeconds", ParamType::Number)]),
            method("tams.follow", &[("videoFlow", ParamType::String), ("audioFlow", ParamType::String), ("delayMs", ParamType::Number)]),
            method("tams.stop", &[]),
        ];
        Descriptor { latency: None, parameters, methods }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let s = self.handle.stats();
        let n = |a: &AtomicU64| Some(serde_json::json!(a.load(Ordering::Relaxed)));
        match name {
            "tams.status" => Some(serde_json::json!(self.handle.status().as_str())),
            "tams.service" => Some(serde_json::json!(self.service_display)),
            "flowId" => Some(serde_json::json!(self.flow_id)),
            "audioFlowId" => Some(serde_json::json!(self.audio_flow_id)),
            "tams.segmentsFetched" => n(&s.segments_fetched),
            "tams.framesOut" => n(&s.frames_out),
            "tams.blocksOut" => n(&s.blocks_out),
            "tams.gapsFilled" => n(&s.gaps_filled),
            "tams.lateDropped" => n(&s.late_dropped),
            "tams.errors" => n(&s.errors),
            "tams.lastError" => Some(serde_json::json!(self.config_problem.clone().unwrap_or_else(|| s.last_error.lock().expect("lock poisoned").clone()))),
            _ => None,
        }
    }

    fn set(&self, _name: &str, _value: Value) -> Result<(), SetError> {
        Err(SetError::ReadOnly)
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let need_store = || match &self.config_problem {
            Some(p) => Err(InvokeError::Message(format!("kein TAMS-Speicher eingerichtet: {p}"))),
            None => Ok(()),
        };
        match name {
            "tams.play" => {
                need_store()?;
                let (video, audio) = (opt_flow(args, "videoFlow")?, opt_flow(args, "audioFlow")?);
                let (start_ns, end_ns) = play_range(args, omp_mediaio::timebase::tai_now_ns())?;
                self.handle.start(Request::Play { video, audio, start_ns, end_ns }).map_err(InvokeError::Message)
            }
            "tams.follow" => {
                need_store()?;
                let (video, audio) = (opt_flow(args, "videoFlow")?, opt_flow(args, "audioFlow")?);
                let delay_ms = opt_num(args, "delayMs");
                if !(1000.0..=86_400_000.0).contains(&delay_ms) {
                    return Err(InvokeError::Message("delayMs muss zwischen 1000 und 86400000 liegen (mindestens eine Segmentlänge plus Aufnahmeverzug)".into()));
                }
                self.handle.start(Request::Follow { video, audio, delay_ns: (delay_ms * 1e6) as i128 }).map_err(InvokeError::Message)
            }
            "tams.stop" => self.handle.stop().map_err(InvokeError::Message),
            _ => Err(InvokeError::Unknown),
        }
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}
fn env_num<T: std::str::FromStr>(key: &str, fallback: T) -> T {
    env_or(key, "").trim().parse().unwrap_or(fallback)
}

/// Client aus der Umgebung. `Err(Grund)` statt Absturz: der Node läuft trotzdem und zeigt den Grund an.
fn client_from_env() -> Result<(Client, String), String> {
    let url = std::env::var("OMP_TAMS_URL").map_err(|_| "OMP_TAMS_URL nicht gesetzt".to_string())?;
    let secret = secret_from_env().map_err(|e| e.to_string())?;
    let user = std::env::var("OMP_TAMS_USER").ok();
    let auth = Auth::from_parts(&env_or("OMP_TAMS_AUTH", "none"), user.as_deref(), secret)?;
    let display = redact_url(&url);
    let client = Client::new(ClientConfig::new(url, auth)).map_err(|e| e.to_string())?;
    Ok((client, display))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "TAMS-Wiedergabe");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9361").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let (width, height): (u32, u32) = (env_num("OMP_WIDTH", 1280), env_num("OMP_HEIGHT", 720));
    let (fps_num, fps_den): (u32, u32) = (env_num("OMP_FRAMERATE_NUM", 25), env_num("OMP_FRAMERATE_DEN", 1));
    let (sample_rate, channels) = (48_000u32, 2u32);
    let gap = if env_or("OMP_TAMS_GAP", "hold").eq_ignore_ascii_case("black") { GapMode::Black } else { GapMode::Hold };

    let (client, config_problem, service_display) = match client_from_env() {
        Ok((c, d)) => (Some(c), None, d),
        Err(e) => {
            eprintln!("omp-tams-reader: {e}");
            (None, Some(e), String::new())
        }
    };
    // Ohne Speicher läuft der Node trotzdem (zeigt den Grund); der Client ist dann ein Platzhalter, der nie benutzt wird.
    let client = match client {
        Some(c) => c,
        None => Client::new(ClientConfig::new("http://127.0.0.1:1/unused".to_string(), Auth::None)).map_err(|e| e.to_string())?,
    };

    let flow_id = omp_node_sdk::idgen::new_v4();
    let audio_flow_id = omp_node_sdk::idgen::new_v4();
    let shutdown = Arc::new(AtomicBool::new(false));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<runtime::Event>();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let cfg = runtime::Config {
        domain,
        client: Arc::new(client),
        label: label.clone(),
        video_flow_id: flow_id.clone(),
        audio_flow_id: audio_flow_id.clone(),
        width,
        height,
        fps_num,
        fps_den,
        sample_rate,
        channels,
        gap,
        lead_ms: env_num("OMP_TAMS_LEAD_MS", 2000u64).clamp(500, 30_000),
    };
    let sd = shutdown.clone();
    let heartbeat = Arc::new(AtomicU64::new(0));
    let hb = heartbeat.clone();
    let pipeline_thread = std::thread::spawn(move || runtime::run(cfg, tx, sd, ready_tx, hb));
    let handle = match ready_rx.await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            eprintln!("omp-tams-reader: init failed: {e}");
            return Err(e.into());
        }
        Err(_) => return Err("Wiedergabe-Thread vor Bereitschaft beendet".into()),
    };

    let store: Arc<dyn ParamStore> = Arc::new(ReaderStore { handle: handle.clone(), config_problem, service_display, flow_id: flow_id.clone(), audio_flow_id: audio_flow_id.clone() });
    let group = omp_node_sdk::group::name_or(&flow_id);
    let media_handle = handle.clone();
    let node = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Video { id: Some(flow_id), frame_width: width, frame_height: height, grain_rate_numerator: fps_num, grain_rate_denominator: fps_den }),
                    tags: HashMap::from([("urn:x-nmos:tag:grouphint/v1.0".to_string(), vec![format!("{group}:high")])]),
                    ..Default::default()
                },
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(FlowSpec::Audio { id: Some(audio_flow_id), sample_rate_numerator: sample_rate, channel_count: channels, media_type: "audio/float32".to_string(), bit_depth: 32, source_id: None }),
                    tags: HashMap::from([("urn:x-nmos:tag:grouphint/v1.0".to_string(), vec![format!("{group}:audio")])]),
                    ..Default::default()
                },
            ],
            receivers: vec![],
            instance_id,
            // Im Leerlauf ist der Node bereit (es gibt noch nichts zu senden); während der Wiedergabe: sobald ein Bild kam
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_handle.status() == PlayStatus::Idle || media_handle.media_ready())),
        },
        store,
    )
    .await?;
    node.register_worker("pipeline", heartbeat);

    let events = async {
        while let Some(runtime::Event::Warning(message)) = rx.recv().await {
            eprintln!("omp-tams-reader: {message}");
            node.publish_alert(message).await;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-tams-reader: shutdown requested"),
        _ = events => eprintln!("omp-tams-reader: pipeline thread ended"),
    }
    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: Value) -> serde_json::Map<String, Value> {
        v.as_object().unwrap().clone()
    }
    const NOW: u64 = 5_000_000_000_000;

    #[test]
    fn flow_ids_are_uuids_only() {
        assert!(valid_flow_id("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"));
        assert!(!valid_flow_id("../../etc"));
        assert!(!valid_flow_id("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaag"));
        assert!(opt_flow(&args(serde_json::json!({"videoFlow": ""})), "videoFlow").unwrap().is_none());
        assert!(opt_flow(&args(serde_json::json!({"videoFlow": "x/y"})), "videoFlow").is_err());
    }

    #[test]
    fn play_range_from_timestamps_or_ago() {
        let (s, e) = play_range(&args(serde_json::json!({"start": "100:0", "end": "110:500"})), NOW).unwrap();
        assert_eq!((s, e), (100_000_000_000, Some(110_000_000_500)));
        let (s, e) = play_range(&args(serde_json::json!({"start": "100:0"})), NOW).unwrap();
        assert_eq!((s, e), (100_000_000_000, None));
        // „vor 30 s“, 10 s lang
        let (s, e) = play_range(&args(serde_json::json!({"agoSeconds": 30, "durationSeconds": 10})), NOW).unwrap();
        assert_eq!(s, NOW as i128 - 30_000_000_000);
        assert_eq!(e, Some(s + 10_000_000_000));
        // „vor 30 s“ ohne Dauer: bis jetzt
        let (_, e) = play_range(&args(serde_json::json!({"agoSeconds": 30})), NOW).unwrap();
        assert_eq!(e, Some(NOW as i128));
        assert!(play_range(&args(serde_json::json!({})), NOW).is_err());
        assert!(play_range(&args(serde_json::json!({"start": "10:0", "end": "9:0"})), NOW).is_err());
        assert!(play_range(&args(serde_json::json!({"start": "abc"})), NOW).is_err());
    }
}
