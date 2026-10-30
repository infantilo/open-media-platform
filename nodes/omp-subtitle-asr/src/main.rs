//! omp-subtitle-asr: automatische Untertitelung. Liest einen MXL-Audioflow, schneidet ihn an Sprechpausen in Segmente
//! (`segment`), lässt jedes Segment von einer Spracherkennungs-Engine erkennen (`engine`: whisper.cpp-Server oder Ersatz) und
//! bereitet den Text zu Untertitel-Einheiten auf (`output`). Ausgaben:
//!
//! * **Live**: Text in die OGraf-Ebene `subtitle` des gewählten Grafik-Nodes (`targetGraphicsLabel`, Vorlage `subtitle`) — dieselbe
//!   Ebene, die auch die Datei-Untertitel-Engine des Grafik-Nodes nutzt.
//! * **Spur**: laufend als SRT in `OMP_SUBTITLE_DIR` (Standard `data/subtitles`), so wird aus dem Live-Ergebnis eine
//!   Untertiteldatei für Nachbearbeitung und Wiederholung (`trackName`, Methoden `track.start`/`track.stop`).
//!
//! Zeitverhalten: die Erkennung läuft nach dem Sprechen (Segmentende + Rechenzeit), live erscheint der Text daher mit einigen
//! Sekunden Verzug; die SRT-Spur trägt dagegen die tatsächlichen Sprechzeiten.

mod caption;
mod diarize;
mod engine;
mod filejob;
mod manager;
mod outputs;
mod output;
mod pipeline;
mod playout;
mod segment;
mod uibundle;

use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_node_sdk::connection::{
    ReceiverConnection, ReceiverControl, ReceiverResource, bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery,
};
use omp_node_sdk::is04::{self, RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamType, PeerClient, RawResponse, ReceiverSpec, SenderSpec, SetError,
};
use serde_json::{Value, json};

use engine::Engine;
use output::Cue;

const SUBTITLE_LAYER: &str = "subtitle";
const KEEP_CUES: usize = 30;
/// Wartende Segmente, bevor ältere verworfen werden (Engine langsamer als Echtzeit).
const BACKLOG: usize = 6;

/// Spielt der Grafik-Node gerade eine Untertiteldatei ab? Sein Parameter `subtitle` meldet `running`. Eine Untertiteldatei hat
/// Vorrang vor der Live-Erkennung: sonst überschrieben sich beide in derselben Ebene (und ein „Löschen“ der Live-Anzeige
/// würde den Dateitext ausblenden).
fn file_subtitle_running(state: &Value) -> bool {
    state.get("running").and_then(Value::as_bool).unwrap_or(false)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

struct Settings {
    language: String,
    enabled: bool,
    live_display: bool,
    graphics_label: String,
    /// Bildmischer, dessen Keyer die Untertitel-Grafik bekommt (leer = Keyer nicht anfassen).
    mixer_label: String,
    track_name: String,
}

struct Track {
    path: std::path::PathBuf,
    start_ms: i64,
    index: usize,
    last_end_ms: i64,
}

struct Shared {
    settings: Mutex<Settings>,
    status: Mutex<String>,
    last_text: Mutex<String>,
    cues: Mutex<VecDeque<Value>>,
    track: Mutex<Option<Track>>,
    subtitle_dir: std::path::PathBuf,
    engine: Arc<dyn Engine>,
    segments_total: AtomicU64,
    dropped_total: AtomicU64,
    errors_total: AtomicU64,
    last_latency_ms: AtomicI64,
    connected: AtomicBool,
    samples_total: AtomicU64,
    /// Spitzenpegel der letzten Sekunden in dBFS ×10 (Anzeige „kommt Ton an?“).
    peak_db10: AtomicI64,
    /// Live-Anzeige ruht, weil der Grafik-Node gerade eine Untertiteldatei (SRT) abspielt (Kind-Event `SUBTITLE` der Playout-Automation).
    live_suppressed: AtomicBool,
}

impl Shared {
    fn set_status(&self, s: impl Into<String>) {
        *self.status.lock().expect("lock poisoned") = s.into();
    }

    /// Dateiname einer Spur: nur Buchstaben, Ziffern, `-`, `_`, `.` (kein Pfad).
    fn track_file(&self, name: &str) -> Result<std::path::PathBuf, String> {
        let name = name.trim();
        if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') || !name.chars().all(|c| c.is_alphanumeric() || "-_.".contains(c)) {
            return Err("Spurname: nur Buchstaben, Ziffern, - _ . erlaubt".to_string());
        }
        Ok(self.subtitle_dir.join(if name.ends_with(".srt") { name.to_string() } else { format!("{name}.srt") }))
    }

    fn start_track(&self, name: &str) -> Result<(), String> {
        let path = self.track_file(name)?;
        std::fs::create_dir_all(&self.subtitle_dir).map_err(|e| e.to_string())?;
        std::fs::write(&path, b"").map_err(|e| format!("Spur {}: {e}", path.display()))?;
        *self.track.lock().expect("lock poisoned") = Some(Track { path, start_ms: now_ms(), index: 0, last_end_ms: 0 });
        self.settings.lock().expect("lock poisoned").track_name = name.trim().to_string();
        Ok(())
    }

    fn stop_track(&self) {
        *self.track.lock().expect("lock poisoned") = None;
    }

    /// Hängt Einheiten an die laufende Spur (Zeiten relativ zum Spurbeginn, nie vor dem Ende der vorigen).
    fn write_track(&self, cues: &[Cue]) -> Result<(), String> {
        let mut guard = self.track.lock().expect("lock poisoned");
        let Some(t) = guard.as_mut() else { return Ok(()) };
        let mut f = std::fs::OpenOptions::new().append(true).open(&t.path).map_err(|e| format!("Spur {}: {e}", t.path.display()))?;
        for c in cues {
            let mut c = c.clone();
            let shift = (t.last_end_ms + t.start_ms - c.start_ms).max(0);
            c.start_ms += shift;
            c.end_ms += shift;
            t.index += 1;
            f.write_all(output::srt_block(t.index, &c, t.start_ms).as_bytes()).map_err(|e| e.to_string())?;
            t.last_end_ms = c.end_ms - t.start_ms;
        }
        Ok(())
    }
}

/// Erkennung: ein Segment nach dem anderen, Ergebnis an Anzeige und Spur.
fn worker(shared: Arc<Shared>, rx: Receiver<segment::Segment>, display: std::sync::mpsc::Sender<String>, flows: Vec<std::sync::mpsc::Sender<String>>, shutdown: Arc<AtomicBool>) {
    while !shutdown.load(Ordering::Relaxed) {
        let seg = match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(s) => s,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        };
        let (enabled, language) = {
            let s = shared.settings.lock().expect("lock poisoned");
            (s.enabled, s.language.clone())
        };
        if !enabled {
            continue;
        }
        shared.set_status("transcribing");
        let t0 = Instant::now();
        let result = shared.engine.transcribe(&seg.samples, &language);
        shared.last_latency_ms.store(t0.elapsed().as_millis() as i64, Ordering::Relaxed);
        shared.segments_total.fetch_add(1, Ordering::Relaxed);
        match result {
            Ok(text) if text.is_empty() => {}
            Ok(text) => {
                let cues = output::cues_for(&text, seg.start_ms);
                *shared.last_text.lock().expect("lock poisoned") = text.clone();
                // Die MXL-Ausgänge (Text-Strom, CEA-608) laufen unabhängig von der Live-Grafik.
                for f in &flows {
                    let _ = f.send(text.clone());
                }
                {
                    let mut list = shared.cues.lock().expect("lock poisoned");
                    for c in &cues {
                        list.push_back(json!({"startMs": c.start_ms, "endMs": c.end_ms, "text": c.text}));
                    }
                    while list.len() > KEEP_CUES {
                        list.pop_front();
                    }
                }
                if let Err(e) = shared.write_track(&cues) {
                    shared.errors_total.fetch_add(1, Ordering::Relaxed);
                    shared.set_status(format!("error: {e}"));
                    continue;
                }
                if shared.settings.lock().expect("lock poisoned").live_display {
                    let _ = display.send(text);
                }
            }
            // Engine lädt noch (Start oder Modellwechsel): kein Fehler, dieser Abschnitt entfällt
            Err(e) if e.starts_with("starting:") => {
                shared.set_status(e);
                continue;
            }
            Err(e) => {
                shared.errors_total.fetch_add(1, Ordering::Relaxed);
                shared.set_status(format!("error: {e}"));
                continue;
            }
        }
        shared.set_status(if shared.connected.load(Ordering::Relaxed) { "listening" } else { "idle" });
    }
}

/// Legt den Fill des Grafik-Nodes in den Keyer des Mischers und schaltet ihn ein (wie die Playout-Automation bei Grafik-Kindern).
/// Leeres `mixer_label` = nichts tun.
fn ensure_keyer(registry: &RegistryClient, mixer_label: &str, graphics_label: &str) -> Result<(), String> {
    if mixer_label.is_empty() {
        return Ok(());
    }
    let node = registry
        .list_nodes()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|n| n.label == mixer_label)
        .ok_or_else(|| format!("Mischer „{mixer_label}“ nicht gefunden"))?;
    let mixer = PeerClient::new(node.href);
    let inputs = mixer.get_param("keyer.inputs").map_err(|e| e.to_string())?;
    let fill = inputs
        .as_array()
        .and_then(|list| {
            list.iter().find_map(|e| {
                let label = e.get("label")?.as_str()?;
                if !label.starts_with(graphics_label) || label.contains("Lowres") {
                    return None;
                }
                e.get("senderId")?.as_str().map(str::to_string)
            })
        })
        .ok_or_else(|| format!("Fill von „{graphics_label}“ nicht unter keyer.inputs gefunden"))?;
    if mixer.get_param("keyer.source").ok().and_then(|v| v.as_str().map(str::to_string)).as_deref() != Some(fill.as_str()) {
        mixer.invoke_with("keyer.setSource", json!({"senderId": fill})).map_err(|e| e.to_string())?;
    }
    if mixer.get_param("keyer.enabled").ok().and_then(|v| v.as_bool()) != Some(true) {
        mixer.invoke_with("keyer.setEnabled", json!({"enabled": true})).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Anzeige: Einheiten nacheinander in die Untertitelebene des Grafik-Nodes, danach leeren.
fn display_loop(shared: Arc<Shared>, registry: RegistryClient, rx: Receiver<String>, shutdown: Arc<AtomicBool>) {
    let mut playout = playout::Playout::default();
    let mut peer: Option<(String, PeerClient)> = None;
    let mut layer_ready = false;
    let send = |peer: &mut Option<(String, PeerClient)>, layer_ready: &mut bool, text: &str| {
        let label = shared.settings.lock().expect("lock poisoned").graphics_label.clone();
        if label.is_empty() {
            return;
        }
        if peer.as_ref().is_none_or(|(l, _)| *l != label) {
            *layer_ready = false;
            *peer = registry.list_nodes().ok().and_then(|n| n.into_iter().find(|n| n.label == label)).map(|n| (label.clone(), PeerClient::new(n.href)));
        }
        let Some((_, p)) = peer.as_ref() else {
            shared.errors_total.fetch_add(1, Ordering::Relaxed);
            shared.set_status(format!("error: Grafik-Node „{label}“ nicht gefunden"));
            return;
        };
        // Untertiteldatei läuft im Grafik-Node: Live pausiert (kein Schreiben, kein Löschen); danach wieder `show`
        let file_running = p.get_param("subtitle").map(|v| file_subtitle_running(&v)).unwrap_or(false);
        let was = shared.live_suppressed.swap(file_running, Ordering::Relaxed);
        if file_running {
            *layer_ready = false;
            if !was {
                shared.set_status("live paused: subtitle file playing");
            }
            return;
        }
        if was {
            shared.set_status("listening");
        }
        let result = if *layer_ready {
            p.invoke_with("update", json!({"layerId": SUBTITLE_LAYER, "data": {"text": text}}))
        } else {
            let r = p.invoke_with("show", json!({"templateId": "subtitle", "layerId": SUBTITLE_LAYER, "data": {"text": text}})).inspect(|()| *layer_ready = true);
            if r.is_ok() {
                let mixer = shared.settings.lock().expect("lock poisoned").mixer_label.clone();
                if let Err(e) = ensure_keyer(&registry, &mixer, &label) {
                    shared.errors_total.fetch_add(1, Ordering::Relaxed);
                    shared.set_status(format!("error: Keyer: {e}"));
                }
            }
            r
        };
        if let Err(e) = result {
            *layer_ready = false;
            *peer = None;
            shared.errors_total.fetch_add(1, Ordering::Relaxed);
            shared.set_status(format!("error: Grafik-Node: {e}"));
        }
    };
    while !shutdown.load(Ordering::Relaxed) {
        let wait = playout.next_due_ms().map_or(Duration::from_millis(300), |t| Duration::from_millis((t - now_ms()).clamp(10, 300) as u64));
        match rx.recv_timeout(wait) {
            Ok(text) => playout.push(output::cues_for(&text, now_ms())),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        loop {
            match rx.try_recv() {
                Ok(text) => playout.push(output::cues_for(&text, now_ms())),
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
        match playout.tick(now_ms()) {
            Some(Some(text)) => send(&mut peer, &mut layer_ready, &text),
            Some(None) => send(&mut peer, &mut layer_ready, ""),
            None => {}
        }
    }
}

fn discover_audio_sources(registry: &RegistryClient) -> Vec<(String, String)> {
    let Ok(senders) = registry.list_senders() else { return Vec::new() };
    senders
        .into_iter()
        .filter(|s| s.transport == TRANSPORT_MXL)
        .filter_map(|s| {
            let flow_id = s.flow_id.as_ref()?;
            if !matches!(registry.get_flow_format(flow_id), Ok(f) if f == is04::FORMAT_AUDIO) {
                return None;
            }
            Some((s.id, s.label))
        })
        .collect()
}

struct AsrControl {
    registry: RegistryClient,
    pipeline: pipeline::PipelineHandle,
    shared: Arc<Shared>,
    connected_flow_id: Arc<Mutex<String>>,
    connected_label: Arc<Mutex<String>>,
}

impl ReceiverControl for AsrControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => {
                        *self.connected_flow_id.lock().expect("lock poisoned") = flow_id.clone();
                        *self.connected_label.lock().expect("lock poisoned") = sender.label;
                        self.shared.connected.store(true, Ordering::Relaxed);
                        self.shared.set_status("listening");
                        self.pipeline.connect(flow_id);
                    }
                    None => eprintln!("omp-subtitle-asr: sender {sender_id} has no flow_id"),
                },
                Err(e) => eprintln!("omp-subtitle-asr: resolve sender {sender_id} failed: {e}"),
            },
            _ => {
                self.connected_flow_id.lock().expect("lock poisoned").clear();
                self.connected_label.lock().expect("lock poisoned").clear();
                self.shared.connected.store(false, Ordering::Relaxed);
                self.shared.set_status("idle");
                self.pipeline.disconnect();
            }
        }
    }
}

/// Aufgabe der Instanz. Dateiaufträge (SRT aus Mediendateien, Eingangskontrolle/Prozess) rechnen minutenlang auf allen Kernen und dürfen
/// die Live-Untertitelung nie stören — deshalb nimmt eine Live-Instanz keine Dateiaufträge an und eine Datei-Instanz keine Live-Quelle.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Role {
    Live,
    File,
}

impl Role {
    fn parse(s: &str) -> Role {
        if s.trim().eq_ignore_ascii_case("file") { Role::File } else { Role::Live }
    }
    fn name(self) -> &'static str {
        match self {
            Role::Live => "live",
            Role::File => "file",
        }
    }
}

struct AsrStore {
    role: Role,
    shared: Arc<Shared>,
    connected_flow_id: Arc<Mutex<String>>,
    connected_label: Arc<Mutex<String>>,
    connection: Arc<ReceiverConnection<AsrControl>>,
    registry: RegistryClient,
    own_receiver_id: String,
    own_label: String,
    /// Engine im Node (None bei externer Engine oder Ersatz-Engine): Modellwahl nur hier.
    manager: Option<Arc<manager::EngineManager>>,
    /// Untertitel aus Dateien (mit Sprechererkennung), s. `filejob.rs`.
    files: Arc<filejob::FileJobs>,
}

fn spec(name: &str, kind: ParamType, readonly: bool) -> ParamSpec {
    ParamSpec { name: name.to_string(), kind, unit: None, range: None, readonly }
}

impl omp_node_sdk::ParamStore for AsrStore {
    fn descriptor(&self) -> Descriptor {
        Descriptor {
            latency: None,
            parameters: vec![
                // "live" (Standard) oder "file": dedizierter Datei-Node (OMP_ASR_ROLE=file)
                spec("role", ParamType::String, true),
                spec("status", ParamType::String, true),
                spec("connectedFlowId", ParamType::String, true),
                spec("connectedLabel", ParamType::String, true),
                spec("availableSources", ParamType::String, true),
                spec("availableNodes", ParamType::String, true),
                spec("engine", ParamType::String, true),
                spec("engineStatus", ParamType::String, true),
                // Modellwahl der im Node laufenden Engine: `models` = vorhandene, `model` = aktuelle (wechseln: Methode `engine.setModel`)
                spec("models", ParamType::String, true),
                spec("model", ParamType::String, true),
                spec("lastText", ParamType::String, true),
                spec("cues", ParamType::String, true),
                spec("stats", ParamType::String, true),
                // true, solange die Live-Anzeige ruht, weil der Grafik-Node eine Untertiteldatei abspielt
                spec("liveSuppressed", ParamType::Boolean, true),
                // Untertitel aus Dateien: Aufträge (Zustand, Fortschritt, Ergebnisse als `fileJobSrt.<id>`) und ob die Sprechererkennung eingerichtet ist
                spec("fileJobs", ParamType::String, true),
                spec("diarization", ParamType::Boolean, true),
                spec("enabled", ParamType::Boolean, false),
                spec("language", ParamType::String, false),
                spec("liveDisplay", ParamType::Boolean, false),
                spec("targetGraphicsLabel", ParamType::String, false),
                spec("targetMixerLabel", ParamType::String, false),
                spec("trackName", ParamType::String, false),
                spec("trackActive", ParamType::Boolean, true),
            ],
            methods: vec![
                MethodSpec { name: "selectSource".to_string(), args: vec![MethodArg { name: "senderId".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "track.start".to_string(), args: vec![MethodArg { name: "name".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "track.stop".to_string(), args: vec![] },
                MethodSpec { name: "clear".to_string(), args: vec![] },
                MethodSpec {
                    name: "file.transcribe".to_string(),
                    args: ["id", "file", "track", "language", "speakers", "names", "word", "style", "name"]
                        .into_iter()
                        .map(|n| MethodArg { name: n.to_string(), kind: if matches!(n, "track" | "speakers") { ParamType::Number } else { ParamType::String } })
                        .collect(),
                },
                MethodSpec { name: "file.cancel".to_string(), args: vec![MethodArg { name: "id".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "file.remove".to_string(), args: vec![MethodArg { name: "id".to_string(), kind: ParamType::String }] },
                MethodSpec { name: "engine.setModel".to_string(), args: vec![MethodArg { name: "name".to_string(), kind: ParamType::String }] },
            ],
        }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let s = &self.shared;
        let settings = s.settings.lock().expect("lock poisoned");
        match name {
            "status" => Some(json!(*s.status.lock().expect("lock poisoned"))),
            "connectedFlowId" => Some(json!(*self.connected_flow_id.lock().expect("lock poisoned"))),
            "connectedLabel" => Some(json!(*self.connected_label.lock().expect("lock poisoned"))),
            "availableSources" => Some(json!(
                discover_audio_sources(&self.registry).into_iter().map(|(id, label)| json!({"senderId": id, "label": label})).collect::<Vec<_>>()
            )),
            "availableNodes" => Some(json!(
                self.registry
                    .list_nodes()
                    .map(|n| n.into_iter().map(|n| n.label).filter(|l| *l != self.own_label).collect::<Vec<_>>())
                    .unwrap_or_default()
            )),
            "engine" => Some(json!(s.engine.name())),
            "models" => Some(json!(self.manager.as_ref().map(|m| m.models()).unwrap_or_default())),
            "model" => Some(json!(self.manager.as_ref().map(|m| m.current_model()).unwrap_or_default())),
            "engineStatus" => Some(json!(match s.engine.check() {
                Ok(()) => "ok".to_string(),
                Err(e) => e,
            })),
            "lastText" => Some(json!(*s.last_text.lock().expect("lock poisoned"))),
            "cues" => Some(json!(s.cues.lock().expect("lock poisoned").iter().cloned().collect::<Vec<_>>())),
            "stats" => Some(json!({
                "segments": s.segments_total.load(Ordering::Relaxed),
                "dropped": s.dropped_total.load(Ordering::Relaxed),
                "errors": s.errors_total.load(Ordering::Relaxed),
                "lastLatencyMs": s.last_latency_ms.load(Ordering::Relaxed),
                "samples": s.samples_total.load(Ordering::Relaxed),
                "peakDb": s.peak_db10.load(Ordering::Relaxed) as f64 / 10.0,
            })),
            "role" => Some(json!(self.role.name())),
            "liveSuppressed" => Some(json!(s.live_suppressed.load(Ordering::Relaxed))),
            "fileJobs" => Some(self.files.list_json()),
            "diarization" => Some(json!(self.files.has_diarizer())),
            n if n.starts_with("fileJobSrt.") => self.files.srt(&n["fileJobSrt.".len()..]).map(Value::String),
            "enabled" => Some(json!(settings.enabled)),
            "language" => Some(json!(settings.language)),
            "liveDisplay" => Some(json!(settings.live_display)),
            "targetGraphicsLabel" => Some(json!(settings.graphics_label)),
            "targetMixerLabel" => Some(json!(settings.mixer_label)),
            "trackName" => Some(json!(settings.track_name)),
            "trackActive" => Some(json!(s.track.lock().expect("lock poisoned").is_some())),
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let mut s = self.shared.settings.lock().expect("lock poisoned");
        match name {
            "enabled" => s.enabled = value.as_bool().ok_or(SetError::Unknown)?,
            "liveDisplay" => s.live_display = value.as_bool().ok_or(SetError::Unknown)?,
            "language" => {
                let l = value.as_str().ok_or(SetError::Unknown)?.trim().to_lowercase();
                if l.is_empty() || l.len() > 8 || !l.chars().all(|c| c.is_ascii_alphabetic() || c == '-') {
                    return Err(SetError::Unknown);
                }
                s.language = l;
            }
            "targetGraphicsLabel" => s.graphics_label = value.as_str().ok_or(SetError::Unknown)?.trim().to_string(),
            "targetMixerLabel" => s.mixer_label = value.as_str().ok_or(SetError::Unknown)?.trim().to_string(),
            "trackName" => s.track_name = value.as_str().ok_or(SetError::Unknown)?.trim().to_string(),
            "status" | "connectedFlowId" | "connectedLabel" | "availableSources" | "availableNodes" | "engine" | "engineStatus" | "models" | "model" | "lastText" | "cues"
            | "stats" | "trackActive" | "liveSuppressed" | "fileJobs" | "diarization" => return Err(SetError::ReadOnly),
            _ => return Err(SetError::Unknown),
        }
        Ok(())
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let live_only = matches!(name, "selectSource" | "clear" | "track.start" | "track.stop");
        if live_only && self.role == Role::File {
            return Err(InvokeError::Message("Dieser Node ist ein dedizierter Datei-Node (OMP_ASR_ROLE=file) und hat keine Live-Untertitelung".to_string()));
        }
        if name == "file.transcribe" && self.role == Role::Live {
            return Err(InvokeError::Message("Dateiaufträge laufen nur auf einem dedizierten Datei-Node (OMP_ASR_ROLE=file), damit die Live-Untertitelung nicht gestört wird".to_string()));
        }
        match name {
            "selectSource" => {
                let sender_id = args.get("senderId").and_then(Value::as_str).unwrap_or("");
                let body = json!({
                    "sender_id": if sender_id.is_empty() { None } else { Some(sender_id) },
                    "master_enable": !sender_id.is_empty(),
                    "activation": {"mode": "activate_immediate"},
                });
                let path = format!("/x-nmos/connection/v1.2/single/receivers/{}/staged", self.own_receiver_id);
                self.connection.handle("PATCH", &path, &serde_json::to_vec(&body).unwrap_or_default()).map(|_| ()).ok_or(InvokeError::Unknown)
            }
            "track.start" => {
                let n = args.get("name").and_then(Value::as_str).unwrap_or("");
                self.shared.start_track(n).map_err(InvokeError::Message)
            }
            "track.stop" => {
                self.shared.stop_track();
                Ok(())
            }
            "engine.setModel" => {
                let name = args.get("name").and_then(Value::as_str).unwrap_or("");
                match &self.manager {
                    Some(m) => m.set_model(name).map_err(InvokeError::Message),
                    None => Err(InvokeError::Message("Die Engine läuft nicht im Node (externe Engine oder Ersatz-Engine) — Modell dort wechseln".to_string())),
                }
            }
            "file.transcribe" => {
                let text = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
                let num = |k: &str, d: usize| args.get(k).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))).map_or(d, |n| n as usize);
                let style = filejob::LabelStyle::parse(&text("style")).ok_or_else(|| InvokeError::Message("style: colon, bracket oder dash".to_string()))?;
                let language = if text("language").is_empty() { self.shared.settings.lock().expect("lock poisoned").language.clone() } else { text("language") };
                let spec = filejob::FileSpec {
                    file: std::path::PathBuf::from(text("file")),
                    track: num("track", 0),
                    language,
                    speakers: num("speakers", 0),
                    names: text("names").split(',').map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect(),
                    label_word: text("word"),
                    style,
                    name: text("name"),
                    id: text("id"),
                };
                self.files.submit(spec, &self.shared.engine.name()).map(|_| ()).map_err(InvokeError::Message)
            }
            "file.cancel" => {
                let id = args.get("id").and_then(Value::as_str).unwrap_or("");
                if self.files.cancel(id) { Ok(()) } else { Err(InvokeError::Message(format!("Auftrag {id} unbekannt"))) }
            }
            "file.remove" => {
                let id = args.get("id").and_then(Value::as_str).unwrap_or("");
                if self.files.remove(id) { Ok(()) } else { Err(InvokeError::Message(format!("Auftrag {id} unbekannt oder läuft noch (erst abbrechen)"))) }
            }
            "clear" => {
                self.shared.cues.lock().expect("lock poisoned").clear();
                self.shared.last_text.lock().expect("lock poisoned").clear();
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        if let Some(resp) = root_discovery(method, path) {
            return Some(to_raw(resp));
        }
        if let Some(resp) = list_ids(method, path, "receivers", &[self.connection.id()]) {
            return Some(to_raw(resp));
        }
        if let Some(resp) = bulk_discovery(method, path) {
            return Some(to_raw(resp));
        }
        if let Some(resp) = bulk_patch(method, path, "receivers", body, |id, params| (self.connection.id() == id).then(|| self.connection.patch_staged(params).0)) {
            return Some(to_raw(resp));
        }
        if let Some(resp) = bulk_patch(method, path, "senders", body, |_, _| None) {
            return Some(to_raw(resp));
        }
        if let Some(resp) = self.connection.handle(method, path, body) {
            return Some(to_raw(resp));
        }
        uibundle::route(method, path)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.connection.cors_methods(path).or_else(|| bulk_cors_methods(path, "senders")).or_else(|| bulk_cors_methods(path, "receivers"))
    }
}

/// Stabile Flow-ID je Instanz und Zweck (gleiche ID nach Neustart, damit Verbindungen halten).
fn stable_flow_id(seed: &str) -> String {
    use std::hash::{Hash, Hasher};
    let h = |salt: u8| {
        let mut s = std::collections::hash_map::DefaultHasher::new();
        (salt, seed).hash(&mut s);
        s.finish()
    };
    let (a, b) = (h(1), h(2));
    format!("{:08x}-{:04x}-4{:03x}-a{:03x}-{:012x}", (a >> 32) as u32, (a >> 16) as u16, a as u16 & 0xFFF, (b >> 52) as u16 & 0xFFF, b & 0xFFFF_FFFF_FFFF)
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "Auto-Untertitel");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9395").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();

    // Engine: standardmäßig im Node (Programm und Modelle unter OMP_ASR_HOME, startet und endet mit dem Node); mit OMP_ASR_URL
    // eine bereits laufende externe Engine; OMP_ASR_ENGINE=mock ersetzt die Erkennung für Tests.
    let mut manager: Option<Arc<manager::EngineManager>> = None;
    let engine: Arc<dyn Engine> = match (env_or("OMP_ASR_ENGINE", "whisper").as_str(), env_or("OMP_ASR_URL", "")) {
        ("mock", _) => Arc::new(engine::Mock),
        (_, url) if !url.trim().is_empty() => Arc::new(engine::WhisperHttp { base_url: url.trim().to_string() }),
        _ => {
            let home = std::path::PathBuf::from(env_or("OMP_ASR_HOME", "data/asr-engine"));
            let safe: String = label.chars().map(|c| if c.is_alphanumeric() { c } else { '_' }).collect();
            let cfg = manager::Config {
                state_file: Some(home.join(format!("selected-model-{safe}"))),
                home,
                bin: std::env::var("OMP_ASR_BIN").ok().filter(|v| !v.trim().is_empty()).map(Into::into),
                threads: env_or("OMP_ASR_THREADS", "4").parse().unwrap_or(4),
                model: env_or("OMP_ASR_MODEL", ""),
                // Standard: Fenster passend zum längsten Abschnitt; OMP_ASR_AUDIO_CTX=0 = volles 30-s-Fenster (genauer, langsamer)
                audio_ctx: env_or("OMP_ASR_AUDIO_CTX", "").parse().unwrap_or_else(|_| manager::audio_ctx_for(env_or("OMP_ASR_MAX_SEGMENT_MS", "8000").parse().unwrap_or(8000))),
            };
            match manager::EngineManager::start(cfg) {
                Ok(m) => {
                    manager = Some(m.clone());
                    m
                }
                Err(e) => {
                    eprintln!("omp-subtitle-asr: {e}");
                    Arc::new(engine::Unavailable(e))
                }
            }
        }
    };

    let role = Role::parse(&env_or("OMP_ASR_ROLE", "live"));
    let shared = Arc::new(Shared {
        settings: Mutex::new(Settings {
            language: env_or("OMP_ASR_LANGUAGE", "de"),
            enabled: role == Role::Live && env_or("OMP_ASR_ENABLED", "1") != "0",
            live_display: env_or("OMP_ASR_LIVE_DISPLAY", "1") != "0",
            graphics_label: env_or("OMP_ASR_GRAPHICS_LABEL", ""),
            mixer_label: env_or("OMP_ASR_MIXER_LABEL", ""),
            track_name: String::new(),
        }),
        status: Mutex::new("idle".to_string()),
        last_text: Mutex::new(String::new()),
        cues: Mutex::new(VecDeque::new()),
        track: Mutex::new(None),
        subtitle_dir: std::path::PathBuf::from(env_or("OMP_SUBTITLE_DIR", "data/subtitles")),
        engine,
        segments_total: AtomicU64::new(0),
        dropped_total: AtomicU64::new(0),
        errors_total: AtomicU64::new(0),
        last_latency_ms: AtomicI64::new(0),
        connected: AtomicBool::new(false),
        samples_total: AtomicU64::new(0),
        peak_db10: AtomicI64::new(-1200),
        live_suppressed: AtomicBool::new(false),
    });
    let shutdown = Arc::new(AtomicBool::new(false));

    // Erkennung, Live-Grafik und MXL-Ausgänge auf eigenen Threads
    let (seg_tx, seg_rx): (SyncSender<segment::Segment>, Receiver<segment::Segment>) = std::sync::mpsc::sync_channel(BACKLOG);
    let (display_tx, display_rx) = std::sync::mpsc::channel::<String>();

    // MXL-Daten-Ausgänge: Text-Strom (privat) und CEA-608 im CDP, ein Grain je Bild (OMP_ASR_FPS, Standard 25/1)
    let rate = {
        let v = env_or("OMP_ASR_FPS", "25/1");
        let (n, d) = v.split_once('/').unwrap_or((v.as_str(), "1"));
        match (n.trim().parse::<u32>(), d.trim().parse::<u32>()) {
            (Ok(n), Ok(d)) if n > 0 && d > 0 => (n, d),
            _ => (25, 1),
        }
    };
    let mut senders: Vec<SenderSpec> = vec![];
    let mut flow_txs: Vec<std::sync::mpsc::Sender<String>> = vec![];
    let mut output_threads: Vec<std::thread::JoinHandle<()>> = vec![];
    let out_frames = Arc::new(AtomicU64::new(0));
    let mut out_heartbeats: Vec<(String, Arc<AtomicU64>)> = vec![];
    // Datei-Node: keine MXL-Daten-Ausgänge (es gibt keine Live-Untertitelung)
    let mxl_ctx = if role == Role::File { Err("Datei-Node".to_string()) } else { omp_mediaio::mxl::MxlContext::new(&domain).map(Arc::new) };
    match mxl_ctx {
        Ok(ctx) => {
            let seed = format!("{label}:{}", env_or("OMP_INSTANCE_ID", ""));
            let text_id = stable_flow_id(&format!("{seed}:text"));
            let cea_id = stable_flow_id(&format!("{seed}:cea608"));
            match omp_mediaio::mxl::MxlDataOutput::new(ctx.clone(), &text_id, &format!("{label} Text"), &label, rate.0, rate.1) {
                Ok(out) => {
                    let (tx, rx) = std::sync::mpsc::channel::<String>();
                    let hb = Arc::new(AtomicU64::new(0));
                    out_heartbeats.push(("text-out".to_string(), hb.clone()));
                    output_threads.push(outputs::spawn_text(out, rx, shutdown.clone(), hb, out_frames.clone()));
                    flow_txs.push(tx);
                    senders.push(SenderSpec {
                        transport: Some(TRANSPORT_MXL.to_string()),
                        flow: Some(FlowSpec::Data { id: Some(text_id), grain_rate_numerator: rate.0, grain_rate_denominator: rate.1, did_sdid: vec![(omp_mediaio::anc::DID_OMP_TEXT, omp_mediaio::anc::SDID_OMP_TEXT)] }),
                        label: Some(format!("{label} Untertitel-Text")),
                        ..Default::default()
                    });
                }
                Err(e) => eprintln!("omp-subtitle-asr: Text-Ausgang aus — {e}"),
            }
            match omp_mediaio::mxl::MxlDataOutput::new(ctx.clone(), &cea_id, &format!("{label} CEA-608"), &label, rate.0, rate.1) {
                Ok(out) => {
                    let (tx, rx) = std::sync::mpsc::channel::<String>();
                    let hb = Arc::new(AtomicU64::new(0));
                    match outputs::spawn_cea(out, rate, rx, shutdown.clone(), hb.clone(), out_frames.clone()) {
                        Ok(t) => {
                            out_heartbeats.push(("cea-out".to_string(), hb));
                            output_threads.push(t);
                            flow_txs.push(tx);
                            senders.push(SenderSpec {
                                transport: Some(TRANSPORT_MXL.to_string()),
                                flow: Some(FlowSpec::Data { id: Some(cea_id), grain_rate_numerator: rate.0, grain_rate_denominator: rate.1, did_sdid: vec![(caption::DID_CDP, caption::SDID_CDP)] }),
                                label: Some(format!("{label} CEA-608 (ANC)")),
                                ..Default::default()
                            });
                        }
                        Err(e) => eprintln!("omp-subtitle-asr: CEA-608-Ausgang aus — {e}"),
                    }
                }
                Err(e) => eprintln!("omp-subtitle-asr: CEA-608-Ausgang aus — {e}"),
            }
        }
        Err(e) => eprintln!("omp-subtitle-asr: keine MXL-Ausgänge ({}) — {e}", role.name()),
    }
    let worker_thread = {
        let (s, sd) = (shared.clone(), shutdown.clone());
        std::thread::spawn(move || worker(s, seg_rx, display_tx, flow_txs, sd))
    };
    let display_thread = {
        let (s, sd, reg) = (shared.clone(), shutdown.clone(), RegistryClient::new(registry_url.clone()));
        std::thread::spawn(move || display_loop(s, reg, display_rx, sd))
    };

    // Audio → Segmenter
    let segmenter = Arc::new(Mutex::new(segment::Segmenter::new(segment::Config {
        end_silence_ms: env_or("OMP_ASR_END_SILENCE_MS", "600").parse()?,
        max_segment_ms: env_or("OMP_ASR_MAX_SEGMENT_MS", "8000").parse()?,
        ..Default::default()
    })));
    let submit = {
        let (shared, seg_tx) = (shared.clone(), seg_tx.clone());
        move |segs: Vec<segment::Segment>| {
            for seg in segs {
                if seg_tx.try_send(seg).is_err() {
                    // Engine liegt zurück: lieber ein Segment auslassen als den Rückstand wachsen lassen.
                    shared.dropped_total.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    };
    let sinks = pipeline::Sinks {
        on_pcm: {
            let (segmenter, submit, shared) = (segmenter.clone(), submit.clone(), shared.clone());
            Arc::new(move |pcm: &[i16]| {
                shared.samples_total.fetch_add(pcm.len() as u64, Ordering::Relaxed);
                let peak = pcm.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0) as f64 / 32768.0;
                let db10 = if peak > 0.0 { (200.0 * peak.log10()) as i64 } else { -1200 };
                // Spitzenpegel: schnell hoch, langsam zurück
                let old = shared.peak_db10.load(Ordering::Relaxed);
                shared.peak_db10.store(if db10 >= old { db10 } else { old - 5 }.max(-1200), Ordering::Relaxed);
                let segs = segmenter.lock().expect("lock poisoned").push(pcm, now_ms());
                submit(segs);
            })
        },
        on_stop: {
            let (segmenter, submit) = (segmenter.clone(), submit.clone());
            Arc::new(move || {
                let segs = segmenter.lock().expect("lock poisoned").flush();
                submit(segs);
            })
        },
    };

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<pipeline::Event>();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let pipeline_heartbeat = Arc::new(AtomicU64::new(0));
    let pipeline_thread = {
        let (sd, hb) = (shutdown.clone(), pipeline_heartbeat.clone());
        std::thread::spawn(move || pipeline::run(pipeline::Config { domain }, sinks, tx, sd, ready_tx, hb))
    };
    let pipeline_handle = match ready_rx.await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            eprintln!("omp-subtitle-asr: pipeline init failed: {e}");
            return Err(e.into());
        }
        Err(_) => return Err("pipeline thread ended before reporting readiness".into()),
    };

    let receiver_id = omp_node_sdk::idgen::new_v4();
    let media_ready_pipeline = pipeline_handle.clone();
    let connected_flow_id = Arc::new(Mutex::new(String::new()));
    let connected_label = Arc::new(Mutex::new(String::new()));
    let connection = Arc::new(ReceiverConnection::new(
        receiver_id.clone(),
        AsrControl {
            registry: RegistryClient::new(registry_url.clone()),
            pipeline: pipeline_handle,
            shared: shared.clone(),
            connected_flow_id: connected_flow_id.clone(),
            connected_label: connected_label.clone(),
        },
    ));
    // Untertitel aus Dateien: Sprechererkennung (falls eingerichtet) und Ton-Extraktion über ffmpeg
    let diarizer = diarize::Diarizer::discover(&std::path::PathBuf::from(env_or("OMP_ASR_HOME", "data/asr-engine"))).map(Arc::new);
    match &diarizer {
        Some(_) => eprintln!("omp-subtitle-asr: Sprechererkennung eingerichtet"),
        None => eprintln!("omp-subtitle-asr: Sprechererkennung nicht eingerichtet (sh tools/asr-engine/install-diarization.sh) — Datei-Untertitel nur ohne Namen"),
    }
    let ffmpeg = env_or("OMP_FFMPEG", "ffmpeg");
    let max_minutes = env_or("OMP_ASR_FILE_MAX_MINUTES", &filejob::DEFAULT_MAX_MINUTES.to_string()).parse().unwrap_or(filejob::DEFAULT_MAX_MINUTES);
    let files = filejob::FileJobs::new(
        shared.engine.clone(),
        diarizer,
        Arc::new(move |file, track| filejob::extract_with_ffmpeg(&ffmpeg, file, track, max_minutes)),
        env_or("OMP_ASR_DIARIZE_THRESHOLD", &diarize::Diarizer::DEFAULT_THRESHOLD.to_string()).parse().unwrap_or(diarize::Diarizer::DEFAULT_THRESHOLD),
        env_or("OMP_ASR_DIARIZE_THREADS", "2").parse().unwrap_or(2),
    );
    let store: Arc<dyn omp_node_sdk::ParamStore> = Arc::new(AsrStore {
        role,
        shared: shared.clone(),
        connected_flow_id,
        connected_label,
        connection,
        registry: RegistryClient::new(registry_url.clone()),
        own_receiver_id: receiver_id.clone(),
        own_label: label.clone(),
        manager: manager.clone(),
        files,
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders,
            receivers: vec![ReceiverSpec {
                id: Some(receiver_id),
                transport: Some(TRANSPORT_MXL.to_string()),
                media_types: Some(vec!["audio/float32".to_string()]),
                ..Default::default()
            }],
            instance_id,
            // Ohne gewählte Quelle gibt es nichts zu liefern (kein Fehlzustand im Signalweg); mit Quelle: Audio muss fließen.
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new({
                let shared = shared.clone();
                move || !shared.connected.load(Ordering::Relaxed) || media_ready_pipeline.media_ready()
            })),
        },
        store,
    )
    .await?;
    handle.register_worker("pipeline", pipeline_heartbeat);
    for (name, hb) in out_heartbeats {
        handle.register_worker(&name, hb);
    }

    let events = async {
        while let Some(event) = rx.recv().await {
            match event {
                pipeline::Event::Error(message) => {
                    let message = omp_node_sdk::errcode::tag(&message);
                    eprintln!("omp-subtitle-asr: pipeline error: {message}");
                    handle.publish_alert(message).await;
                }
            }
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => eprintln!("omp-subtitle-asr: shutdown requested"),
        _ = events => eprintln!("omp-subtitle-asr: pipeline thread ended"),
    }

    shutdown.store(true, Ordering::Relaxed);
    let _ = pipeline_thread.join();
    let _ = worker_thread.join();
    let _ = display_thread.join();
    for t in output_threads {
        let _ = t.join();
    }
    if let Some(m) = &manager {
        m.shutdown();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_subtitle_state_decides_whether_live_pauses() {
        assert!(file_subtitle_running(&json!({"running": true, "selected": "wetter"})));
        assert!(!file_subtitle_running(&json!({"running": false, "tracks": []})));
        assert!(!file_subtitle_running(&Value::Null), "Grafik-Node ohne Auskunft: Live läuft weiter");
        assert!(!file_subtitle_running(&json!({"running": "ja"})), "kein Wahrheitswert: nicht pausieren");
    }
}
