//! omp-sign-avatar: Gebärdensprach-Avatar (Phase 1 = Spike, docs/GEBAERDENSPRACHE.md §7).
//! Software-Rasterizer (CPU) → Fill + Key als MXL-Flows.

mod alphabet;
mod avatar;
mod engine;
mod font;
mod lexicon;
mod math;
mod player;
mod png;
mod pipeline;
mod raster;
mod rules;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use avatar::{Avatar, Camera, Pose};
use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, RawResponse, Range, ReceiverSpec, SenderSpec,
    SetError,
};
use raster::Raster;
use serde_json::Value;

pub const FPS: u32 = 25;

/// Ein Bild rendern (Fill BGRA mit Alpha, Key GRAY8).
pub struct Renderer {
    avatar: Avatar,
    raster: Raster,
    cam: Camera,
    /// Haltung und Einblendtext des zuletzt gezeichneten Bildes: unverändert = Puffer bleibt gültig.
    last: Option<(Pose, Option<String>)>,
    /// Vollflächiger Hintergrund (Karte) statt freigestelltem Avatar — bessere Lesbarkeit im kleinen Bild-in-Bild.
    pub panel: bool,
    pub width: usize,
    pub height: usize,
}

impl Renderer {
    pub fn new(width: usize, height: usize, ss: usize) -> Renderer {
        Renderer { avatar: Avatar::new(), raster: Raster::new(width, height, ss), cam: Camera::framing(width, height), last: None, panel: false, width, height }
    }

    /// Rendert nur bei geänderter Haltung; Rückgabe `true` = Puffer neu beschrieben. Die Puffer müssen
    /// über Aufrufe dieselben bleiben (anfangs null, s. `Raster::resolve`).
    /// Text-Rückfall: dunkles Band am unteren Rand mit weißer Schrift, Zeilenzahl nach Bildbreite.
    fn draw_overlay(&mut self, text: &str) {
        let cell = ((self.width as i32) / 120).max(2); // Schriftpixel: 3 bei 360 Breite
        let cols = (self.width as i32 / (6 * cell)) as usize - 1;
        let lines = font::wrap(text, cols, 5);
        let line_h = 9 * cell;
        let pad = 2 * cell;
        let h = lines.len() as i32 * line_h + 2 * pad;
        let y0 = self.height as i32 - h;
        self.raster.rect(0, y0, self.width as i32, h, 90.0, 0x0A0A0A);
        for (i, l) in lines.iter().enumerate() {
            for (x, y, w, hh) in font::line_rects(l, cell * 3, y0 + pad + i as i32 * line_h, cell) {
                self.raster.rect(x, y, w, hh, 91.0, 0xFFFFFF);
            }
        }
    }

    /// Nächstes `render` zeichnet auch bei gleicher Haltung neu (z. B. nach Wechsel der Zielpuffer).
    pub fn invalidate(&mut self) {
        self.last = None;
    }

    pub fn render(&mut self, pose: &Pose, overlay: Option<&str>, bgra: &mut [u8], key: &mut [u8]) -> bool {
        let state = (*pose, overlay.map(str::to_string));
        if self.last.as_ref() == Some(&state) {
            return false;
        }
        self.last = Some(state);
        self.raster.clear();
        if self.panel {
            self.raster.rect(0, 0, self.width as i32, self.height as i32, -50.0, 0x1E2A3A);
        }
        self.avatar.draw(pose, &mut self.raster, &self.cam);
        if let Some(text) = overlay {
            self.draw_overlay(text);
        }
        self.raster.resolve(bgra, key);
        true
    }
}

/// Kontaktbogen: eine Zeile je Gebärde (alphabetisch), je Schlüssel ein Bild; Zuordnung Zeile → Glosse/Zeit auf der Standardausgabe.
fn contact_sheet(lex: &lexicon::Lexicon, out: &str) {
    const TW: usize = 160;
    const TH: usize = 180;
    let mut glosses: Vec<&String> = lex.signs.keys().collect();
    glosses.sort();
    let cols = lex.signs.values().map(|s| s.keys.len()).max().unwrap_or(1).min(8);
    let rows = glosses.len().max(1);
    let (sw, sh) = (cols * TW, rows * TH);
    let mut sheet = vec![0u8; sw * sh * 4];
    let mut r = Renderer::new(TW, TH, 2);
    r.panel = true;
    let (mut bgra, mut key) = (vec![0u8; TW * TH * 4], vec![0u8; TW * TH]);
    for (ri, g) in glosses.iter().enumerate() {
        let sign = &lex.signs[*g];
        println!("Zeile {}: {} ({}){}", ri + 1, g, if sign.verified { "freigegeben" } else { "NICHT freigegeben" }, sign.keys.iter().enumerate().take(cols).map(|(i, k)| format!(" [{}]={:.0} ms", i + 1, k.0)).collect::<String>());
        for (ci, (_, pose)) in sign.keys.iter().enumerate().take(cols) {
            r.render(pose, None, &mut bgra, &mut key);
            r.invalidate();
            for y in 0..TH {
                for x in 0..TW {
                    let s = (y * TW + x) * 4;
                    let d = ((ri * TH + y) * sw + ci * TW + x) * 4;
                    sheet[d..d + 4].copy_from_slice(&[bgra[s + 2], bgra[s + 1], bgra[s], 255]);
                }
            }
        }
    }
    std::fs::write(out, png::encode_rgba(sw as u32, sh as u32, &sheet)).expect("PNG schreiben");
    println!("Kontaktbogen: {out} ({sw}×{sh})");
}

#[cfg(test)]
mod renderer_tests {
    use super::*;

    fn frame(r: &mut Renderer, pose: &Pose, text: Option<&str>) -> (Vec<u8>, Vec<u8>) {
        let (mut bgra, mut key) = (vec![0u8; r.width * r.height * 4], vec![0u8; r.width * r.height]);
        r.render(pose, text, &mut bgra, &mut key);
        (bgra, key)
    }

    #[test]
    fn overlay_text_makes_an_opaque_band_at_the_bottom_with_white_text_pixels() {
        let mut r = Renderer::new(360, 405, 1);
        let (_, k0) = frame(&mut r, &Pose::REST, None);
        let (bgra, k1) = frame(&mut r, &Pose::REST, Some("Heute Regen"));
        let last_row = &k1[(405 - 3) * 360..(405 - 2) * 360];
        assert!(last_row.iter().all(|&a| a == 255), "Band muss voll deckend sein");
        assert_ne!(k0, k1);
        let white = bgra.chunks_exact(4).filter(|p| p[0] == 255 && p[1] == 255 && p[2] == 255 && p[3] == 255).count();
        assert!(white > 100, "Schrift fehlt: {white} weiße Pixel");
        // Text weg → Band weg
        let (_, k2) = frame(&mut r, &Pose::REST, None);
        assert_eq!(k0, k2);
    }

    #[test]
    fn panel_makes_the_whole_frame_opaque() {
        let mut r = Renderer::new(120, 135, 2);
        r.panel = true;
        let (_, k) = frame(&mut r, &Pose::REST, None);
        assert!(k.iter().all(|&a| a == 255));
    }

    #[test]
    fn unchanged_pose_and_text_is_not_rendered_again() {
        let mut r = Renderer::new(60, 68, 1);
        let (mut b, mut k) = (vec![0u8; 60 * 68 * 4], vec![0u8; 60 * 68]);
        assert!(r.render(&Pose::REST, Some("x"), &mut b, &mut k));
        assert!(!r.render(&Pose::REST, Some("x"), &mut b, &mut k));
        assert!(r.render(&Pose::REST, Some("y"), &mut b, &mut k));
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
    // Größe: Voreinstellung (klein/mittel/groß, Seitenverhältnis 8:9) oder frei; Breite durch 4 teilbar (Key-Zweig)
    let (pw, ph) = match std::env::var("OMP_SIGN_SIZE").unwrap_or_default().as_str() {
        "medium" | "mittel" => (480, 540),
        "large" | "gross" | "groß" => (600, 675),
        _ => (360, 405),
    };
    let (w, h) = (opt("--width", "OMP_SIGN_WIDTH", pw), opt("--height", "OMP_SIGN_HEIGHT", ph));
    let ss = opt("--ss", "OMP_SIGN_SS", 2);
    let text = arg_value(&args, "--text").unwrap_or_else(|| "Hallo".to_string());

    if let Some(path) = arg_value(&args, "--dump") {
        // Beispiel: --dump a.png --letter K  → eine Haltung als PNG (Hintergrund grau, Alpha eingerechnet)
        let letter = arg_value(&args, "--letter").and_then(|s| s.chars().next()).unwrap_or('A');
        let pose = alphabet::pose_for(letter).unwrap_or(Pose::REST);
        let mut r = Renderer::new(w, h, ss);
        let (mut bgra, mut key) = (vec![0u8; w * h * 4], vec![0u8; w * h]);
        r.render(&pose, None, &mut bgra, &mut key);
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

    // Prüfwerkzeug für Fachleute: Lexikon prüfen (Fehler mit Pfad ins Lexikon) und Kontaktbogen aller Gebärden als PNG
    if let Some(path) = arg_value(&args, "--lexicon-check") {
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            eprintln!("{path}: {e}");
            std::process::exit(2)
        });
        let lex = match lexicon::Lexicon::from_json(&text) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("{path}: FEHLER: {e}");
                std::process::exit(1)
            }
        };
        println!("{path}: {} Gebärden, {} Wortformen, {} freigegeben", lex.signs.len(), lex.lemmas.len(), lex.verified_count());
        if let Some(out) = arg_value(&args, "--sheet") {
            contact_sheet(&lex, &out);
        }
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
            r.render(&tl.pose_at(t_ms), None, &mut bgra, &mut key);
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

/// Node-API: Untertitel-Betrieb (Phase 2) und Testbetrieb (Buchstabieren).
struct SignStore {
    shared: Arc<pipeline::Shared>,
    text: Mutex<String>,
    speed: Mutex<f64>,
    subtitle_connection: Arc<ReceiverConnection<SubtitleControl>>,
    lexicon_info: String,
    start: Instant,
}

impl SignStore {
    fn now_ms(&self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }

    fn speak(&self, text: &str) {
        let speed = *self.speed.lock().expect("lock poisoned") as f32;
        let now = self.now_ms();
        self.shared.engine.lock().expect("lock poisoned").play_now(player::Timeline::spell(text, speed), now);
    }
}

/// IS-05-Steuerung des Eingangs „Untertitel“ (Daten-Flow `video/smpte291`): Text-Strom oder CEA-608.
struct SubtitleControl {
    registry: RegistryClient,
    context: Arc<omp_mediaio::mxl::MxlContext>,
    input: Arc<omp_mediaio::mxl::SubtitleInput>,
}

impl ReceiverControl for SubtitleControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        if let Err(e) = self.input.connect(self.context.clone(), &flow_id) {
                            eprintln!("omp-sign-avatar: Untertitel-Eingang {flow_id}: {e}");
                        }
                    }
                    None => eprintln!("omp-sign-avatar: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-sign-avatar: resolve sender {sender_id} failed: {e}"),
            },
            _ => self.input.disconnect(),
        }
    }
}

impl ParamStore for SignStore {
    fn descriptor(&self) -> Descriptor {
        let p = |name: &str, kind, range, readonly| ParamSpec { name: name.to_string(), kind, unit: None, range, readonly };
        Descriptor {
            latency: None,
            parameters: vec![
                p("auto", ParamType::Boolean, None, false),
                p("fallback", ParamType::String, None, false),
                p("speed", ParamType::Number, Some(Range::Number { min: 0.25, max: 4.0 }), false),
                p("text", ParamType::String, None, false),
                p("subtitle", ParamType::String, None, true),
                p("subtitleFlowId", ParamType::String, None, true),
                p("state", ParamType::String, None, true),
                p("lexicon", ParamType::String, None, true),
                p("renderMs", ParamType::Number, None, true),
                p("framesOut", ParamType::Number, None, true),
            ],
            methods: vec![
                MethodSpec { name: "speak".to_string(), args: vec![MethodArg { name: "text".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "translate".to_string(), args: vec![MethodArg { name: "text".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "stop".to_string(), args: vec![] },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        match name {
            "auto" => Some(Value::from(self.shared.auto.load(Ordering::Relaxed))),
            "text" => Some(Value::from(self.text.lock().expect("lock poisoned").clone())),
            "speed" => Some(Value::from(*self.speed.lock().expect("lock poisoned"))),
            "fallback" => Some(Value::from(if self.shared.engine.lock().expect("lock poisoned").fallback_spell() { "spell" } else { "text" })),
            "subtitle" => Some(Value::from(self.shared.subtitle.text())),
            "subtitleFlowId" => Some(Value::from(self.shared.subtitle.connected_flow_id())),
            "lexicon" => Some(Value::from(self.lexicon_info.clone())),
            "state" => {
                let st = self.shared.engine.lock().expect("lock poisoned").stats();
                Some(serde_json::json!({
                    "queue": st.queue_len, "delayMs": st.last_delay_ms.round(), "dropped": st.dropped, "sentences": st.sentences,
                    "signed": st.signed, "textFallbacks": st.fallbacks, "glosses": st.last_glosses, "unknownRatio": st.last_unknown_ratio,
                    "subtitleConnected": !self.shared.subtitle.connected_flow_id().is_empty(),
                }))
            }
            "renderMs" => Some(Value::from(self.shared.render_us.load(Ordering::Relaxed) as f64 / 1000.0)),
            "framesOut" => Some(Value::from(self.shared.frames_out.load(Ordering::Relaxed))),
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        match name {
            "auto" => {
                self.shared.auto.store(value.as_bool().ok_or(SetError::Unknown)?, Ordering::Relaxed);
                Ok(())
            }
            "fallback" => {
                let spell = match value.as_str() {
                    Some("spell") => true,
                    Some("text") => false,
                    _ => return Err(SetError::Unknown),
                };
                self.shared.engine.lock().expect("lock poisoned").set_fallback_spell(spell);
                Ok(())
            }
            "text" => {
                *self.text.lock().expect("lock poisoned") = value.as_str().ok_or(SetError::Unknown)?.to_string();
                Ok(())
            }
            "speed" => {
                let v = value.as_f64().ok_or(SetError::Unknown)?.clamp(0.25, 4.0);
                *self.speed.lock().expect("lock poisoned") = v;
                self.shared.engine.lock().expect("lock poisoned").set_speed(v as f32);
                Ok(())
            }
            "subtitle" | "subtitleFlowId" | "state" | "lexicon" | "renderMs" | "framesOut" => Err(SetError::ReadOnly),
            _ => Err(SetError::Unknown),
        }
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let text_arg = || args.get("text").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| self.text.lock().expect("lock poisoned").clone());
        match name {
            // Buchstabieren (Test)
            "speak" => {
                self.speak(&text_arg());
                Ok(())
            }
            // Wie ein Untertitel behandeln: Regeln, Lexikon, Warteschlange (Test der Übersetzung ohne Untertitel-Quelle)
            "translate" => {
                let now = self.now_ms();
                self.shared.engine.lock().expect("lock poisoned").submit(&text_arg(), now);
                Ok(())
            }
            "stop" => {
                self.shared.engine.lock().expect("lock poisoned").clear();
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let path = path.split('?').next().unwrap_or(path);
        self.subtitle_connection.handle(method, path, body).map(|(status, content_type, body)| RawResponse { status, content_type, body })
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

    // Lexikon und Regeln: fehlerhafte Dateien verhindern den Start (nie mit halben Daten auf Sendung)
    let lexicon_path = env_or("OMP_SIGN_LEXICON", "data/sign/lexicon.json");
    let lex = match std::fs::read_to_string(&lexicon_path) {
        Ok(t) => lexicon::Lexicon::from_json(&t).map_err(|e| format!("Lexikon {lexicon_path}: {e}"))?,
        Err(_) => {
            eprintln!("omp-sign-avatar: kein Lexikon unter {lexicon_path} — alles wird buchstabiert oder als Text gezeigt");
            lexicon::Lexicon::default()
        }
    };
    let rules = match std::env::var("OMP_SIGN_RULES") {
        Ok(p) => rules::Rules::from_json(&std::fs::read_to_string(&p).map_err(|e| format!("Regeln {p}: {e}"))?).map_err(|e| format!("Regeln {p}: {e}"))?,
        Err(_) => rules::Rules::default_rules(),
    };
    let allow_unverified = env_or("OMP_SIGN_ALLOW_UNVERIFIED", "0") == "1";
    if allow_unverified {
        eprintln!("omp-sign-avatar: WARNUNG: nicht freigegebene Gebärden sind zugelassen (nur für Tests, nie auf Sendung)");
    }
    let lexicon_info = format!("{}: {} Gebärden, davon {} freigegeben{}", lexicon_path, lex.signs.len(), lex.verified_count(), if allow_unverified { " (ungeprüfte zugelassen!)" } else { "" });
    eprintln!("omp-sign-avatar: {lexicon_info}");
    let max_delay_ms = env_or("OMP_SIGN_MAX_DELAY_S", "8").parse::<f64>().unwrap_or(8.0).clamp(1.0, 120.0) * 1000.0;
    let engine = engine::Engine::new(
        Arc::new(lex),
        rules,
        engine::EngineConfig { allow_unverified, max_delay_ms, fallback_spell: env_or("OMP_SIGN_FALLBACK", "spell") == "spell", ..Default::default() },
    );

    let subtitle_context = Arc::new(omp_mediaio::mxl::MxlContext::new(&domain)?);
    let subtitle = Arc::new(omp_mediaio::mxl::SubtitleInput::new());
    let mut running = pipeline::Running::start(
        &pipeline::Config {
            domain,
            fill_flow_id: fill_flow_id.clone(),
            key_flow_id: key_flow_id.clone(),
            label: label.clone(),
            width: w as u32,
            height: h as u32,
            ss,
            panel: env_or("OMP_SIGN_PANEL", "0") == "1",
        },
        engine,
        subtitle.clone(),
    )?;
    let shared = running.shared.clone();
    let ready = shared.clone();

    let subtitle_receiver_id = omp_node_sdk::idgen::new_v4();
    let subtitle_connection = Arc::new(ReceiverConnection::new(
        subtitle_receiver_id.clone(),
        SubtitleControl { registry: RegistryClient::new(registry_url.clone()), context: subtitle_context, input: subtitle },
    ));
    let store: Arc<dyn ParamStore> = Arc::new(SignStore {
        shared: shared.clone(),
        text: Mutex::new(String::new()),
        speed: Mutex::new(1.0),
        subtitle_connection,
        lexicon_info,
        start: Instant::now(),
    });

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
            receivers: vec![ReceiverSpec {
                id: Some(subtitle_receiver_id),
                transport: Some(TRANSPORT_MXL.to_string()),
                media_types: Some(vec!["video/smpte291".to_string()]),
                label: Some(format!("{label} Untertitel")),
                ..Default::default()
            }],
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
