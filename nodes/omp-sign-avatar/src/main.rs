//! omp-sign-avatar: Gebärdensprach-Avatar (Phase 1 = Spike, docs/GEBAERDENSPRACHE.md §7).
//! Software-Rasterizer (CPU) → Fill + Key als MXL-Flows.

mod alphabet;
mod avatar;
mod math;
mod player;
mod png;
mod pipeline;
mod raster;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use avatar::{Avatar, Camera, Pose};
use omp_node_sdk::is04::TRANSPORT_MXL;
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, Range, SenderSpec, SetError,
};
use raster::Raster;
use serde_json::Value;

pub const FPS: u32 = 25;

/// Ein Bild rendern (Fill BGRA mit Alpha, Key GRAY8).
pub struct Renderer {
    avatar: Avatar,
    raster: Raster,
    cam: Camera,
    /// Haltung des zuletzt gezeichneten Bildes: unveränderte Haltung = Puffer bleibt gültig.
    last: Option<Pose>,
    pub width: usize,
    pub height: usize,
}

impl Renderer {
    pub fn new(width: usize, height: usize, ss: usize) -> Renderer {
        Renderer { avatar: Avatar::new(), raster: Raster::new(width, height, ss), cam: Camera::framing(width, height), last: None, width, height }
    }

    /// Rendert nur bei geänderter Haltung; Rückgabe `true` = Puffer neu beschrieben. Die Puffer müssen
    /// über Aufrufe dieselben bleiben (anfangs null, s. `Raster::resolve`).
    pub fn render(&mut self, pose: &Pose, bgra: &mut [u8], key: &mut [u8]) -> bool {
        if self.last.as_ref() == Some(pose) {
            return false;
        }
        self.last = Some(*pose);
        self.raster.clear();
        self.avatar.draw(pose, &mut self.raster, &self.cam);
        self.raster.resolve(bgra, key);
        true
    }
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

/// CPU-Zeit des Prozesses (Nutzer+System) in Sekunden aus /proc/self/stat.
fn cpu_seconds() -> f64 {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let rest = stat.rsplit(')').next().unwrap_or("");
    let f: Vec<&str> = rest.split_whitespace().collect();
    let tick = |i: usize| f.get(i).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    (tick(11) + tick(12)) / 100.0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Parameter: Kommandozeile, sonst Umgebung (Node-Start), sonst Standard 480×540 mit 2×2-Überabtastung.
    let opt = |flag: &str, env: &str, default: usize| -> usize {
        arg_value(&args, flag).or_else(|| std::env::var(env).ok()).and_then(|s| s.parse().ok()).unwrap_or(default)
    };
    let (w, h) = (opt("--width", "OMP_SIGN_WIDTH", 480), opt("--height", "OMP_SIGN_HEIGHT", 540));
    let ss = opt("--ss", "OMP_SIGN_SS", 2);
    let text = arg_value(&args, "--text").unwrap_or_else(|| "Hallo".to_string());

    if let Some(path) = arg_value(&args, "--dump") {
        // Beispiel: --dump a.png --letter K  → eine Haltung als PNG (Hintergrund grau, Alpha eingerechnet)
        let letter = arg_value(&args, "--letter").and_then(|s| s.chars().next()).unwrap_or('A');
        let pose = alphabet::pose_for(letter).unwrap_or(Pose::REST);
        let mut r = Renderer::new(w, h, ss);
        let (mut bgra, mut key) = (vec![0u8; w * h * 4], vec![0u8; w * h]);
        r.render(&pose, &mut bgra, &mut key);
        let mut rgba = Vec::with_capacity(w * h * 4);
        for p in bgra.chunks_exact(4) {
            let a = p[3] as u32;
            let bg = 150u32;
            let mix = |c: u8| ((c as u32 * a + bg * (255 - a)) / 255) as u8;
            rgba.extend_from_slice(&[mix(p[2]), mix(p[1]), mix(p[0]), 255]);
        }
        std::fs::write(&path, png::encode_rgba(w as u32, h as u32, &rgba)).expect("PNG schreiben");
        eprintln!("{path}: {w}x{h}, {} Dreiecke", r.avatar.triangle_count());
        return;
    }

    if args.iter().any(|a| a == "--bench") {
        let secs: f32 = arg_value(&args, "--secs").and_then(|s| s.parse().ok()).unwrap_or(10.0);
        let frames = (secs * FPS as f32) as usize;
        let mut r = Renderer::new(w, h, ss);
        let tl = player::Timeline::spell(&text, 1.0);
        let (mut bgra, mut key) = (vec![0u8; w * h * 4], vec![0u8; w * h]);
        let cpu0 = cpu_seconds();
        let t0 = std::time::Instant::now();
        let mut worst = 0.0f64;
        for i in 0..frames {
            let f0 = std::time::Instant::now();
            let t_ms = (i as f32 * 1000.0 / FPS as f32) % tl.total_ms();
            r.render(&tl.pose_at(t_ms), &mut bgra, &mut key);
            worst = worst.max(f0.elapsed().as_secs_f64());
        }
        let wall = t0.elapsed().as_secs_f64();
        let cpu = cpu_seconds() - cpu0;
        let per = wall / frames as f64;
        // Last bei Echtzeit-Betrieb: Renderzeit je Bild × 25 Bilder/s (ein Kern = 100 %)
        println!(
            "{w}x{h} ss={ss}: {frames} Bilder, {:.2} ms/Bild (schlechtestes {:.2} ms), Echtzeit-Last {:.1} % eines Kerns (CPU gemessen {:.1} %)",
            per * 1000.0,
            worst * 1000.0,
            per * FPS as f64 * 100.0,
            cpu / wall * 100.0
        );
        return;
    }
    if let Err(e) = run_node(w, h, ss) {
        eprintln!("omp-sign-avatar: {}", omp_node_sdk::errcode::tag(&e.to_string()));
        std::process::exit(1);
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

/// Node-API: Phase 1 nur zum Testen (Text buchstabieren), keine Übersetzung.
struct SignStore {
    shared: Arc<pipeline::Shared>,
    text: Mutex<String>,
    speed: Mutex<f64>,
}

impl SignStore {
    fn speak(&self, text: &str) {
        let speed = *self.speed.lock().expect("lock poisoned") as f32;
        let mut pb = self.shared.playback.lock().expect("lock poisoned");
        pb.timeline = Some(player::Timeline::spell(text, speed));
        pb.started = Some(Instant::now());
        pb.text = text.to_string();
    }
}

impl ParamStore for SignStore {
    fn descriptor(&self) -> Descriptor {
        let p = |name: &str, kind, range, readonly| ParamSpec { name: name.to_string(), kind, unit: None, range, readonly };
        Descriptor {
            latency: None,
            parameters: vec![
                p("text", ParamType::String, None, false),
                p("speed", ParamType::Number, Some(Range::Number { min: 0.25, max: 4.0 }), false),
                p("loop", ParamType::Boolean, None, false),
                p("playing", ParamType::Boolean, None, true),
                p("renderMs", ParamType::Number, None, true),
                p("framesOut", ParamType::Number, None, true),
            ],
            methods: vec![
                MethodSpec { name: "speak".to_string(), args: vec![MethodArg { name: "text".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "stop".to_string(), args: vec![] },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let pb = self.shared.playback.lock().expect("lock poisoned");
        match name {
            "text" => Some(Value::from(self.text.lock().expect("lock poisoned").clone())),
            "speed" => Some(Value::from(*self.speed.lock().expect("lock poisoned"))),
            "loop" => Some(Value::from(pb.looping)),
            "playing" => Some(Value::from(pb.timeline.is_some())),
            "renderMs" => Some(Value::from(self.shared.render_us.load(Ordering::Relaxed) as f64 / 1000.0)),
            "framesOut" => Some(Value::from(self.shared.frames_out.load(Ordering::Relaxed))),
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        match name {
            "text" => {
                *self.text.lock().expect("lock poisoned") = value.as_str().ok_or(SetError::Unknown)?.to_string();
                Ok(())
            }
            "speed" => {
                *self.speed.lock().expect("lock poisoned") = value.as_f64().ok_or(SetError::Unknown)?.clamp(0.25, 4.0);
                Ok(())
            }
            "loop" => {
                self.shared.playback.lock().expect("lock poisoned").looping = value.as_bool().ok_or(SetError::Unknown)?;
                Ok(())
            }
            "playing" | "renderMs" | "framesOut" => Err(SetError::ReadOnly),
            _ => Err(SetError::Unknown),
        }
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        match name {
            "speak" => {
                // Ohne Argument: der Parameter `text`
                let text = args.get("text").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| self.text.lock().expect("lock poisoned").clone());
                self.speak(&text);
                Ok(())
            }
            "stop" => {
                let mut pb = self.shared.playback.lock().expect("lock poisoned");
                pb.timeline = None;
                pb.started = None;
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn run_node_async(w: usize, h: usize, ss: usize) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Gebärdensprache");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9340").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let fill_flow_id = omp_node_sdk::idgen::new_v4();
    let key_flow_id = omp_node_sdk::idgen::new_v4();

    let mut running = pipeline::Running::start(&pipeline::Config {
        domain,
        fill_flow_id: fill_flow_id.clone(),
        key_flow_id: key_flow_id.clone(),
        label: label.clone(),
        width: w as u32,
        height: h as u32,
        ss,
    })?;
    let shared = running.shared.clone();
    let ready = shared.clone();
    let store: Arc<dyn ParamStore> = Arc::new(SignStore { shared: shared.clone(), text: Mutex::new(String::new()), speed: Mutex::new(1.0) });

    let video = |id: String| FlowSpec::Video { id: Some(id), frame_width: w as u32, frame_height: h as u32, grain_rate_numerator: FPS, grain_rate_denominator: 1 };
    let fill_group = fill_flow_id.clone();
    let handle = omp_node_sdk::start(
        NodeConfig {
            label: label.clone(),
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![
                SenderSpec {
                    transport: Some(TRANSPORT_MXL.to_string()),
                    flow: Some(video(fill_flow_id)),
                    label: Some(format!("{label} Fill")),
                    tags: std::collections::HashMap::from([("urn:x-nmos:tag:grouphint/v1.0".to_string(), vec![format!("{fill_group}:high")])]),
                    ..Default::default()
                },
                SenderSpec { transport: Some(TRANSPORT_MXL.to_string()), flow: Some(video(key_flow_id)), label: Some(format!("{label} Key")), ..Default::default() },
            ],
            receivers: vec![],
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || ready.frames_out.load(Ordering::Relaxed) > 0)),
        },
        store,
    )
    .await?;
    handle.register_worker("render", shared.heartbeat.clone());

    tokio::signal::ctrl_c().await?;
    eprintln!("omp-sign-avatar: shutdown requested");
    running.stop();
    Ok(())
}

fn run_node(w: usize, h: usize, ss: usize) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    run_node_async(w, h, ss)
}

/// Sichtprüfung am echten Ausgang: liest den Key-Flow eines laufenden Nodes und schreibt das letzte Bild als PNG (Luma).
///
/// `OMP_TEST_FLOW=<Key-Flow-ID> OMP_TEST_OUT=key.png cargo test --release -p omp-sign-avatar -- --ignored --nocapture flow_probe`
/// (MXL-Umgebung wie beim Dev-Stack).
#[cfg(test)]
mod flow_probe {
    use std::sync::{Arc, Mutex};

    use omp_mediaio::mxl::{MxlContext, MxlDataInput};

    /// v210: je 16 Byte 6 Pixel; Luma-Wörter siehe SMPTE 274/ v210-Layout. Rückgabe 8-Bit-Luma.
    fn v210_luma(payload: &[u8], w: usize, h: usize) -> Vec<u8> {
        let stride = payload.len() / h;
        let mut out = vec![0u8; w * h];
        for y in 0..h {
            for g in 0..(w / 6) {
                let o = y * stride + g * 16;
                let word = |i: usize| u32::from_le_bytes(payload[o + i * 4..o + i * 4 + 4].try_into().unwrap());
                let (w0, w1, w2, w3) = (word(0), word(1), word(2), word(3));
                let s = |v: u32, sh: u32| ((v >> sh) & 0x3FF) as u16;
                let ys = [s(w0, 10), s(w1, 0), s(w1, 20), s(w2, 10), s(w3, 0), s(w3, 20)];
                for (i, yv) in ys.iter().enumerate() {
                    // 10 Bit, begrenzter Bereich 64..940 → 0..255
                    let v = ((*yv as i32 - 64) * 255 / 876).clamp(0, 255);
                    if g * 6 + i < w {
                        out[y * w + g * 6 + i] = v as u8;
                    }
                }
            }
        }
        out
    }

    #[test]
    #[ignore = "braucht einen laufenden Node und MXL-Umgebung"]
    fn flow_probe() {
        let flow = std::env::var("OMP_TEST_FLOW").expect("OMP_TEST_FLOW");
        let out = std::env::var("OMP_TEST_OUT").unwrap_or_else(|_| "key.png".into());
        let ctx = Arc::new(MxlContext::new(&std::env::var("OMP_MXL_DOMAIN").unwrap_or("/dev/shm/omp-mxl".into())).unwrap());
        let def: serde_json::Value = serde_json::from_str(&ctx.flow_def(&flow).unwrap()).unwrap();
        let (w, h) = (def["frame_width"].as_u64().unwrap() as usize, def["frame_height"].as_u64().unwrap() as usize);
        let last: Arc<Mutex<Option<Vec<u8>>>> = Arc::new(Mutex::new(None));
        let l = last.clone();
        let _input = MxlDataInput::new_indexed(ctx.clone(), &flow, move |_i, payload| {
            *l.lock().unwrap() = Some(payload.to_vec());
        })
        .unwrap();
        std::thread::sleep(std::time::Duration::from_secs(4));
        let payload = last.lock().unwrap().clone().expect("kein Bild gelesen");
        let luma = v210_luma(&payload, w, h);
        let covered = luma.iter().filter(|&&v| v > 127).count();
        println!("KEY {w}x{h}: {} Pixel > 50 % ({:.1} %)", covered, covered as f64 * 100.0 / (w * h) as f64);
        let mut rgba = Vec::with_capacity(w * h * 4);
        for v in &luma {
            rgba.extend_from_slice(&[*v, *v, *v, 255]);
        }
        std::fs::write(&out, crate::png::encode_rgba(w as u32, h as u32, &rgba)).unwrap();
        assert!(covered > 0, "Key-Flow ist leer");
    }
}
