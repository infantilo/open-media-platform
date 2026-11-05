//! omp-segue-player (Radio, Kapitel 89/RB3): mehrere Stimmen (Dateien) in **einem** Prozess, sample-genau auf eine gemeinsame
//! Ausgabeuhr gemischt (`mix.rs`). Der Automator entscheidet *was und wann* (Methoden `play`/`stop`/`fade` mit TAI-Zeitpunkt), der
//! Player *wie* (Überblendkurven, Pegel). Vertrag: `docs/CONTRACT-SEGUE-PLAYER.md`.
//!
//! Jede Stimme hat eine vom Aufrufer vergebene `voiceId` — ein zweites `play` mit derselben ID wird ignoriert (kein Doppelstart bei
//! Wiederholung nach einem Neustart der Automation).

mod decode;
mod io;
mod mix;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::is04::TRANSPORT_MXL;
use omp_node_sdk::{
    Descriptor, InvokeError, LatencyInfo, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, SenderSpec, SetError,
};
use serde_json::{Value, json};

use mix::{BLOCK, Curve, Mixer, SR, VoiceState, db_to_gain};

const MAX_VOICES: usize = 8;

/// Befehle an eine Stimme, die noch lädt: sie werden angewandt, sobald sie im Mischer steht.
#[derive(Clone)]
enum Op {
    Stop { at_tai: u64, fade_ms: f64, curve: Curve },
    Fade { at_tai: u64, to_db: f64, ms: f64, curve: Curve },
}

/// Kennzahlen einer Stimme für die Anzeige (`voices`).
#[derive(Clone)]
struct Meta {
    id: String,
    label: String,
    file: String,
    start_tai_ns: u64,
    gain_db: f64,
    intro_ms: Option<u64>,
    hook_ms: Option<u64>,
    outro_ms: Option<u64>,
    /// `loading` (wird decodiert) oder `error`; sonst entscheidet der Mischer (`pending`/`playing`/`ended`).
    phase: String,
    error: String,
    internal: Option<u64>,
    duration_ms: u64,
    late_ms: u64,
    pending: Vec<Op>,
}

struct Shared {
    mixer: Mutex<Mixer>,
    metas: Mutex<BTreeMap<String, Meta>>,
    /// Ausgabeuhr: Frame 0 liegt bei TAI `tai0`; `n` = nächster zu rechnender Frame.
    clock: Mutex<(u64, i64)>,
    out_peak: std::sync::atomic::AtomicU32,
    last_index: AtomicU64,
    head_index: AtomicU64,
    cache: decode::Cache,
    media_dir: PathBuf,
}

impl Shared {
    /// Ausgabeframe, dessen MXL-Zeit `tai_ns` ist (Frame n trägt die Zeit `tai0 + n/SR − OUT_LAG`).
    fn frame_for_tai(&self, tai_ns: u64) -> i64 {
        let (tai0, _) = *self.clock.lock().expect("lock poisoned");
        ((tai_ns as i128 - tai0 as i128 + io::OUT_LAG_NS as i128) * SR as i128 / 1_000_000_000) as i64
    }
    fn now_frame(&self) -> i64 {
        self.frame_for_tai(omp_mediaio::timebase::tai_now_ns())
    }
}

fn resolve_media(dir: &Path, rel_or_abs: &str) -> Result<PathBuf, String> {
    let c = Path::new(rel_or_abs);
    let p = if c.is_absolute() { c.to_path_buf() } else { dir.join(c) };
    let canon = p.canonicalize().map_err(|e| format!("Datei {rel_or_abs:?} nicht lesbar: {e}"))?;
    if !c.is_absolute() {
        let root = dir.canonicalize().map_err(|e| format!("Medienverzeichnis nicht lesbar: {e}"))?;
        if !canon.starts_with(&root) {
            return Err("Pfad außerhalb des Medienverzeichnisses".to_string());
        }
    }
    Ok(canon)
}

/// Frame für einen Befehlszeitpunkt: TAI-Zeit (0 = jetzt) nie vor dem nächsten Block.
fn op_frame(shared: &Shared, at_tai: u64) -> i64 {
    let now = shared.now_frame() + BLOCK as i64;
    if at_tai == 0 { now } else { shared.frame_for_tai(at_tai).max(now) }
}

fn apply_op(shared: &Shared, mx: &mut Mixer, vid: u64, op: &Op) -> bool {
    match op {
        Op::Stop { at_tai, fade_ms, curve } => mx.stop(vid, op_frame(shared, *at_tai), (fade_ms * SR as f64 / 1000.0) as i64, *curve),
        Op::Fade { at_tai, to_db, ms, curve } => mx.fade_to(vid, op_frame(shared, *at_tai), (ms * SR as f64 / 1000.0) as i64, db_to_gain(*to_db), *curve),
    }
}

fn num(args: &serde_json::Map<String, Value>, k: &str) -> Option<f64> {
    args.get(k).and_then(Value::as_f64).filter(|v| v.is_finite())
}

fn curve(args: &serde_json::Map<String, Value>, k: &str, default: Curve) -> Result<Curve, InvokeError> {
    match args.get(k).and_then(Value::as_str) {
        None | Some("") => Ok(default),
        Some(s) => Curve::parse(s).ok_or_else(|| InvokeError::Message(format!("{k}: linear, cosine oder log"))),
    }
}

fn valid_voice_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

struct SegueStore {
    shared: Arc<Shared>,
}

fn ro(name: &str, kind: ParamType, unit: Option<&str>) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: unit.map(str::to_string), range: None, readonly: true }
}

fn arg(name: &str, kind: ParamType) -> MethodArg {
    MethodArg { name: name.to_string(), kind }
}

impl SegueStore {
    /// Stimme laden (im Hintergrund decodieren) und planen. Rückkehr sofort; `voices` zeigt den Fortschritt.
    fn play(&self, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let msg = |s: &str| InvokeError::Message(s.to_string());
        let id = args.get("voiceId").and_then(Value::as_str).unwrap_or("").to_string();
        if !valid_voice_id(&id) {
            return Err(msg("voiceId: 1–40 Zeichen (Buchstaben, Ziffern, - _ .)"));
        }
        if self.shared.metas.lock().expect("lock poisoned").contains_key(&id) {
            return Ok(()); // schon bekannt: kein Doppelstart
        }
        let file = args.get("file").and_then(Value::as_str).unwrap_or("").to_string();
        let path = resolve_media(&self.shared.media_dir, &file).map_err(InvokeError::Message)?;
        let start_tai = num(args, "startAt").filter(|v| *v > 0.0).map_or(0, |v| v as u64);
        let gain_db = num(args, "gainDb").unwrap_or(0.0);
        if !(-60.0..=24.0).contains(&gain_db) {
            return Err(msg("gainDb: −60 … +24"));
        }
        let offset_ms = num(args, "offsetMs").unwrap_or(0.0).max(0.0) as u64;
        let fade_in_ms = num(args, "fadeInMs").unwrap_or(0.0).max(0.0) as u64;
        let fade_in_curve = curve(args, "fadeInCurve", Curve::Cosine)?;
        let stop_at_ms = num(args, "stopAtMs").filter(|v| *v > 0.0).map(|v| v as u64);
        let fade_out_ms = num(args, "fadeOutMs").unwrap_or(0.0).max(0.0) as u64;
        let fade_out_curve = curve(args, "fadeOutCurve", Curve::Cosine)?;
        let opt_ms = |k: &str| num(args, k).filter(|v| *v >= 0.0).map(|v| v as u64);
        let meta = Meta {
            id: id.clone(),
            label: args.get("label").and_then(Value::as_str).unwrap_or("").chars().take(120).collect(),
            file,
            start_tai_ns: start_tai,
            gain_db,
            intro_ms: opt_ms("introMs"),
            hook_ms: opt_ms("hookMs"),
            outro_ms: opt_ms("outroMs"),
            phase: "loading".to_string(),
            error: String::new(),
            internal: None,
            duration_ms: 0,
            late_ms: 0,
            pending: Vec::new(),
        };
        self.shared.metas.lock().expect("lock poisoned").insert(id.clone(), meta);
        let shared = self.shared.clone();
        std::thread::Builder::new()
            .name("segue-load".into())
            .spawn(move || {
                let data = match shared.cache.get_or_decode(&path) {
                    Ok(d) => d,
                    Err(e) => {
                        if let Some(m) = shared.metas.lock().expect("lock poisoned").get_mut(&id) {
                            m.phase = "error".to_string();
                            m.error = e;
                        }
                        return;
                    }
                };
                let frames = data.len() / mix::CH;
                let offset = ((offset_ms * SR as u64 / 1000) as usize).min(frames.saturating_sub(1));
                // Start: gewünschter TAI-Zeitpunkt; schon vorbei (zu spät geladen) → sofort, Verspätung vermerken
                let now = shared.now_frame();
                let wanted = if start_tai == 0 { now + 2 * BLOCK as i64 } else { shared.frame_for_tai(start_tai) };
                let start_n = wanted.max(now + BLOCK as i64);
                let late = ((start_n - wanted).max(0) * 1000 / SR as i64) as u64;
                let mut mx = shared.mixer.lock().expect("lock poisoned");
                let Some(vid) = mx.add(data, offset, start_n, db_to_gain(gain_db)) else {
                    drop(mx);
                    if let Some(m) = shared.metas.lock().expect("lock poisoned").get_mut(&id) {
                        m.phase = "error".to_string();
                        m.error = format!("alle {MAX_VOICES} Stimmen belegt");
                    }
                    return;
                };
                if fade_in_ms > 0 {
                    mx.fade_in(vid, (fade_in_ms * SR as u64 / 1000) as i64, fade_in_curve);
                }
                if let Some(stop_at) = stop_at_ms.filter(|s| *s > offset_ms) {
                    let at = start_n + ((stop_at - offset_ms) * SR as u64 / 1000) as i64;
                    mx.stop(vid, at, (fade_out_ms * SR as u64 / 1000) as i64, fade_out_curve);
                }
                // Befehle, die während des Ladens kamen (z. B. `stop` für die Überblendung), jetzt anwenden
                let pending = shared.metas.lock().expect("lock poisoned").get(&id).map(|m| m.pending.clone()).unwrap_or_default();
                for op in &pending {
                    apply_op(&shared, &mut mx, vid, op);
                }
                drop(mx);
                if let Some(m) = shared.metas.lock().expect("lock poisoned").get_mut(&id) {
                    m.pending.clear();
                    m.phase = "scheduled".to_string();
                    m.internal = Some(vid);
                    m.duration_ms = (frames as u64) * 1000 / SR as u64;
                    m.late_ms = late;
                }
            })
            .map_err(|e| InvokeError::Message(e.to_string()))?;
        Ok(())
    }

    /// Befehl an eine Stimme: steht sie schon im Mischer, sofort; lädt sie noch, wird er gemerkt und beim Einplanen angewandt.
    fn dispatch(&self, args: &serde_json::Map<String, Value>, op: Op) -> Result<(), InvokeError> {
        let id = args.get("voiceId").and_then(Value::as_str).unwrap_or("");
        let mut metas = self.shared.metas.lock().expect("lock poisoned");
        let Some(m) = metas.get_mut(id) else {
            return Err(InvokeError::Message(format!("Stimme „{id}“ unbekannt")));
        };
        match (m.internal, m.phase.as_str()) {
            (Some(vid), _) => {
                drop(metas);
                let mut mx = self.shared.mixer.lock().expect("lock poisoned");
                if apply_op(&self.shared, &mut mx, vid, &op) { Ok(()) } else { Err(InvokeError::Message("Stimme schon beendet".to_string())) }
            }
            (None, "loading") => {
                m.pending.push(op);
                Ok(())
            }
            _ => Err(InvokeError::Message(format!("Stimme „{id}“ nicht abspielbar ({})", m.phase))),
        }
    }

    fn voices_json(&self) -> Value {
        let metas = self.shared.metas.lock().expect("lock poisoned").clone();
        let mx = self.shared.mixer.lock().expect("lock poisoned");
        let mut out = Vec::new();
        for m in metas.values() {
            let (phase, pos) = match m.internal.and_then(|i| mx.voices.iter().find(|v| v.id == i)) {
                Some(v) => (
                    match v.state {
                        VoiceState::Pending => "scheduled",
                        VoiceState::Playing => "playing",
                        VoiceState::Ended => "ended",
                    },
                    (v.position() as u64) * 1000 / SR as u64,
                ),
                None if m.internal.is_some() => ("ended", m.duration_ms),
                None => (m.phase.as_str(), 0),
            };
            out.push(json!({
                "voiceId": m.id, "label": m.label, "file": m.file, "state": phase, "positionMs": pos, "durationMs": m.duration_ms,
                "startAt": m.start_tai_ns, "gainDb": m.gain_db, "lateMs": m.late_ms, "error": m.error,
                "markers": { "introMs": m.intro_ms, "hookMs": m.hook_ms, "outroMs": m.outro_ms },
            }));
        }
        Value::Array(out)
    }
}

impl ParamStore for SegueStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: Some(LatencyInfo { video: None, audio: None, data: None, supports_delay_compensation: false }),
            parameters: vec![
                ro("voices", ParamType::String, None),
                ro("voiceCount", ParamType::Number, None),
                ro("maxVoices", ParamType::Number, None),
                ro("outputLevelDb", ParamType::Number, Some("dBFS")),
                ro("cacheMb", ParamType::Number, Some("MB")),
                ro("taiNowNs", ParamType::Number, Some("ns")),
                ro("clock", ParamType::String, None),
            ],
            methods: vec![
                MethodSpec {
                    name: "play".to_string(),
                    args: vec![
                        arg("voiceId", ParamType::String),
                        arg("file", ParamType::String),
                        arg("startAt", ParamType::Number),
                        arg("gainDb", ParamType::Number),
                        arg("offsetMs", ParamType::Number),
                        arg("fadeInMs", ParamType::Number),
                        arg("fadeInCurve", ParamType::String),
                        arg("stopAtMs", ParamType::Number),
                        arg("fadeOutMs", ParamType::Number),
                        arg("fadeOutCurve", ParamType::String),
                        arg("label", ParamType::String),
                        arg("introMs", ParamType::Number),
                        arg("hookMs", ParamType::Number),
                        arg("outroMs", ParamType::Number),
                    ],
                },
                MethodSpec { name: "stop".to_string(), args: vec![arg("voiceId", ParamType::String), arg("fadeMs", ParamType::Number), arg("curve", ParamType::String), arg("atTai", ParamType::Number)] },
                MethodSpec { name: "fade".to_string(), args: vec![arg("voiceId", ParamType::String), arg("gainDb", ParamType::Number), arg("ms", ParamType::Number), arg("curve", ParamType::String), arg("atTai", ParamType::Number)] },
                MethodSpec { name: "stopAll".to_string(), args: vec![arg("fadeMs", ParamType::Number)] },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        Some(match name {
            "voices" => self.voices_json(),
            "voiceCount" => json!(self.shared.mixer.lock().expect("lock poisoned").voices.iter().filter(|v| v.state != VoiceState::Ended).count()),
            "maxVoices" => json!(MAX_VOICES),
            "outputLevelDb" => {
                let v = f32::from_bits(self.shared.out_peak.load(Ordering::Relaxed)) as f64;
                json!(if v <= 0.00003 { -90.0 } else { (20.0 * v.log10() * 10.0).round() / 10.0 })
            }
            "taiNowNs" => json!(omp_mediaio::timebase::tai_now_ns()),
            "clock" => {
                let (tai0, n) = *self.shared.clock.lock().expect("lock poisoned");
                let now = omp_mediaio::timebase::tai_now_ns();
                json!({ "tai0": tai0, "n": n, "nowMinusTai0Ms": (now as i128 - tai0 as i128) as f64 / 1e6, "nMs": n as f64 * 1000.0 / SR as f64, "lastIndex": self.shared.last_index.load(Ordering::Relaxed), "headIndex": self.shared.head_index.load(Ordering::Relaxed) })
            }
            "cacheMb" => json!((self.shared.cache.bytes() as f64 / 1_048_576.0 * 10.0).round() / 10.0),
            _ => return None,
        })
    }

    fn set(&self, name: &str, _value: Value) -> Result<(), SetError> {
        if self.get(name).is_some() { Err(SetError::ReadOnly) } else { Err(SetError::Unknown) }
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "play" => self.play(args),
            "stop" => {
                let c = curve(args, "curve", Curve::Cosine)?;
                self.dispatch(args, Op::Stop { at_tai: num(args, "atTai").filter(|v| *v > 0.0).map_or(0, |v| v as u64), fade_ms: num(args, "fadeMs").unwrap_or(0.0).max(0.0), curve: c })
            }
            "fade" => {
                let c = curve(args, "curve", Curve::Cosine)?;
                let to_db = num(args, "gainDb").ok_or_else(|| InvokeError::Message("gainDb fehlt".to_string()))?.clamp(-90.0, 24.0);
                self.dispatch(args, Op::Fade { at_tai: num(args, "atTai").filter(|v| *v > 0.0).map_or(0, |v| v as u64), to_db, ms: num(args, "ms").unwrap_or(0.0).max(0.0), curve: c })
            }
            "stopAll" => {
                let at = self.shared.now_frame() + BLOCK as i64;
                let len = (num(args, "fadeMs").unwrap_or(0.0).max(0.0) * SR as f64 / 1000.0) as i64;
                let mut mx = self.shared.mixer.lock().expect("lock poisoned");
                let ids: Vec<u64> = mx.voices.iter().filter(|v| v.state != VoiceState::Ended).map(|v| v.id).collect();
                for id in ids {
                    mx.stop(id, at, len, Curve::Cosine);
                }
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

/// Takt: alle 10 ms einen Block rechnen und senden. Die Ausgabeuhr (`n`) hängt über `tai0` an TAI; bei großer Abweichung
/// (Stillstand des Rechners) wird sie neu angesetzt.
fn clock_loop(shared: Arc<Shared>, out: Arc<io::MxlOut>, shutdown: Arc<AtomicBool>, heartbeat: Arc<AtomicU64>) {
    let period = std::time::Duration::from_millis(10);
    let mut next = std::time::Instant::now();
    let mut block = vec![0.0f32; BLOCK * mix::CH];
    let mut write_warned = false;
    while !shutdown.load(Ordering::Relaxed) {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        let n = {
            let mut c = shared.clock.lock().expect("lock poisoned");
            let tai_now = omp_mediaio::timebase::tai_now_ns();
            let expected = ((tai_now as i128 - c.0 as i128) * SR as i128 / 1_000_000_000) as i64;
            // Der Zähler darf der Echtzeit nur um wenige Blöcke vorauslaufen/nachhängen
            if (c.1 - expected).abs() > 20 * BLOCK as i64 {
                c.0 = out.align_tai((tai_now as i128 - c.1 as i128 * 1_000_000_000 / SR as i128) as u64);
            }
            c.1
        };
        shared.mixer.lock().expect("lock poisoned").render(n, &mut block);
        let tai0 = {
            let mut c = shared.clock.lock().expect("lock poisoned");
            c.1 = n + BLOCK as i64;
            c.0
        };
        // Schreibindex: Frame n trägt die MXL-Zeit tai0 + n/SR − LAG; tai0 liegt auf dem Blockraster, daher ist der Index exakt
        let index0 = out.index_of(tai0).unwrap_or(0) as i128 - (io::OUT_LAG_NS as i128 * SR as i128 / 1_000_000_000);
        let index = (index0 + n as i128).max(0) as u64;
        let peak = block.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let old = f32::from_bits(shared.out_peak.load(Ordering::Relaxed)) * 0.8;
        shared.out_peak.store(peak.max(old).to_bits(), Ordering::Relaxed);
        shared.last_index.store(index, Ordering::Relaxed);
        shared.head_index.store(out.index_of(omp_mediaio::timebase::tai_now_ns()).unwrap_or(0), Ordering::Relaxed);
        if let Err(e) = out.write(&block, index) {
            if !write_warned {
                eprintln!("omp-segue-player: {e}");
                write_warned = true;
            }
        }
        next += period;
        let now = std::time::Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else if now - next > period * 20 {
            next = now;
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Segue-Player");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "0").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let media_dir = PathBuf::from(env_or("OMP_MEDIA_DIR", "data/media"));
    let cache_mib: usize = env_or("OMP_SEGUE_CACHE_MIB", "256").parse().unwrap_or(256);

    gstreamer::init()?;
    let flow = omp_node_sdk::idgen::new_v4();
    let out = io::MxlOut::new(&domain, &flow, &label)?;
    let tai0 = out.align_tai(omp_mediaio::timebase::tai_now_ns());
    let shared = Arc::new(Shared {
        mixer: Mutex::new(Mixer::new(MAX_VOICES)),
        metas: Mutex::new(BTreeMap::new()),
        clock: Mutex::new((tai0, 0)),
        out_peak: std::sync::atomic::AtomicU32::new(0),
        last_index: AtomicU64::new(0),
        head_index: AtomicU64::new(0),
        cache: decode::Cache::new(cache_mib),
        media_dir,
    });
    let shutdown = Arc::new(AtomicBool::new(false));
    let heartbeat = Arc::new(AtomicU64::new(0));
    let clock = {
        let (sh, o, sd, hb) = (shared.clone(), out.clone(), shutdown.clone(), heartbeat.clone());
        std::thread::spawn(move || clock_loop(sh, o, sd, hb))
    };

    let senders = vec![SenderSpec {
        id: Some(omp_node_sdk::idgen::new_v4()),
        transport: Some(TRANSPORT_MXL.to_string()),
        flow: Some(FlowSpec::Audio { id: Some(flow), sample_rate_numerator: SR, channel_count: mix::CH as u32, media_type: "audio/float32".to_string(), bit_depth: 32, source_id: None }),
        label: Some("Programm".to_string()),
        ..Default::default()
    }];
    let media_out = out.clone();
    let store: Arc<dyn ParamStore> = Arc::new(SegueStore { shared });
    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders,
            receivers: vec![],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_out.flowed())),
        },
        store,
    )
    .await?;
    handle.register_worker("clock", heartbeat);
    tokio::signal::ctrl_c().await?;
    eprintln!("omp-segue-player: shutdown requested");
    shutdown.store(true, Ordering::Relaxed);
    let _ = clock.join();
    Ok(())
}
