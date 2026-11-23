//! Pipeline von `omp-normalizer` (UMSETZUNG 106.2): liest je einen per IS-05 gewählten Video- und Ton-Flow aus der
//! Domain des Nodes und schreibt sie als Flows mit **stabilen IDs** ins Hausformat.
//!
//! Entscheidung je Zweig: `omp_normalizer::plan::plan` vergleicht die `flow_def` der Quelle mit dem Hausformat.
//! * Plan leer → **bitgleiche Kopie** (`omp_mediaio::rawcopy`, Grain-Index bleibt, kein GStreamer, keine Bearbeitung).
//! * sonst Wandlungskette (`MxlVideoInput → MxlVideoOutput`); in diesem Schritt nur Größe und Bildrate. Die übrigen Stufen
//!   (Halbbild, Farbmatrix, Ton-Layout) folgen in 106.3 und führen bis dahin zu `state=error` mit klarer Meldung.
//! * `mode=copyOnly`: bei Abweichung keine Wandlung, `state=blocked` und ein Alarm.
//!
//! Alle 2 s wird die `flow_def` der Quelle erneut gelesen; ändert sich das Eingangsformat (Rasterwechsel der Leitung),
//! baut der Zweig mit denselben Ausgangs-Flow-IDs neu auf.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::domainwatch::DomainWatch;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext, MxlVideoInput, MxlVideoOutput};
use omp_mediaio::rawcopy::{AudioFormat, RawAudioCopy, RawVideoCopy, VideoFormat};
use omp_normalizer::audiomap::AudioMap;
use omp_normalizer::flowdef::{self, InputFormat};
use omp_normalizer::house::{HouseFormat, Scan, VideoHouse};
use omp_normalizer::plan::{self, PlanOptions, Stage};
use omp_normalizer::avsync::{Applied, AvSyncSettings};
use omp_mediaio::rawcopy::AvDelay;
use omp_normalizer::tonemap::{Curve, MapRequest, StageBackend};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Auto,
    CopyOnly,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "auto" => Some(Mode::Auto),
            "copyOnly" => Some(Mode::CopyOnly),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Auto => "auto",
            Mode::CopyOnly => "copyOnly",
        }
    }
}

pub struct Config {
    pub domain: String,
    pub video_flow_id: String,
    pub audio_flow_id: String,
    /// Ausgangs-Flow der Datenspur (ANC/Zeitcode/Untertitel): wird unverändert, mit gleichem Grain-Index, durchgereicht.
    pub data_flow_id: String,
    pub label: String,
    pub house: HouseFormat,
    pub mode: Mode,
    pub audio_map: AudioMap,
    pub rate_mode: omp_mediaio::framerate::RateMode,
}

impl Shared {
    /// Berechnet aus den Einstellungen die Verzögerungen und gibt sie an den Kopierpfad. Mit `freeze` bleibt das Ziel stehen.
    pub fn recompute_avsync(&self) -> Result<Applied, String> {
        let cfg = self.avsync.lock().expect("lock poisoned").clone();
        if cfg.freeze {
            return self.applied.lock().expect("lock poisoned").ok_or_else(|| "eingefroren ohne Wert".to_string());
        }
        let house = self.house.lock().expect("lock poisoned").clone();
        let frame_ms = house.video.as_ref().map_or(40.0, |v| 1000.0 * v.rate.den as f64 / v.rate.num as f64);
        let rate = house.audio.as_ref().map_or(48_000, |a| a.sample_rate);
        let a = cfg.decide(frame_ms, rate, self.delay.max_frames())?;
        self.delay.set_slew_permille(cfg.max_slew_permille);
        self.delay.set_video_frames(a.video_delay_frames);
        self.delay.set_audio_delay_samples(a.audio_delay_samples);
        *self.applied.lock().expect("lock poisoned") = Some(a);
        Ok(a)
    }
}

pub enum Event {
    Error(String),
}

/// Anzeige eines Zweigs (Video oder Ton).
#[derive(Clone, Debug)]
pub struct BranchInfo {
    /// `waiting` / `copy` / `convert` / `blocked` / `error`
    pub state: &'static str,
    pub input: serde_json::Value,
    pub deviations: Vec<String>,
    pub stages: Vec<String>,
    pub warnings: Vec<String>,
}

impl Default for BranchInfo {
    fn default() -> Self {
        BranchInfo { state: "waiting", input: serde_json::Value::Null, deviations: vec![], stages: vec![], warnings: vec![] }
    }
}

pub struct Shared {
    pub house: Mutex<HouseFormat>,
    pub mode: Mutex<Mode>,
    pub audio_map: Mutex<AudioMap>,
    /// Überschreibt die Übertragungsfunktions-Regel des Hausformats (`normalize.transferPolicy`); `None` = Hausformat.
    pub transfer_policy: Mutex<Option<omp_normalizer::house::TransferPolicy>>,
    /// `builtin` oder Dienst-Befehl (`normalize.mapBackend`).
    pub map_backend: Mutex<String>,
    /// A/V-Ausgleich (106.5): Einstellungen, Steuerung des Kopierpfads und zuletzt wirksames Ergebnis.
    pub avsync: Mutex<AvSyncSettings>,
    pub delay: Arc<AvDelay>,
    pub applied: Mutex<Option<Applied>>,
    pub video: Mutex<BranchInfo>,
    pub audio: Mutex<BranchInfo>,
    pub video_flowed: AtomicBool,
    pub audio_flowed: AtomicBool,
    /// Datenspur: ein Grain wurde durchgereicht.
    pub data_flowed: AtomicBool,
    /// Zeitpunkt des letzten durchgereichten Daten-Grains (ms seit Prozessstart, 0 = noch keiner). `normalize.dataFlowing` gilt nur
    /// für frische Daten: bleibt die Datenquelle aus, wird es wieder `false` (Grundlage des MCR-Alarms `signal-dataLoss`).
    pub data_last_ms: AtomicU64,
    /// Datenspur: Anzeige („verbunden: …“, „wartet auf Quelle“, leer = nicht verbunden).
    pub data_mode: Mutex<String>,
    pub format_changes: AtomicU64,
    pub last_error: Mutex<String>,
}

enum Command {
    DomainChanged,
    SourceLost,
    Tick,
    ConnectVideo(String),
    DisconnectVideo,
    ConnectAudio(String),
    DisconnectAudio,
    ConnectData(String),
    DisconnectData,
    /// Hausformat oder Modus geändert: beide Zweige neu bewerten und aufbauen.
    Reconfigure,
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    pub shared: Arc<Shared>,
}

impl PipelineHandle {
    pub fn connect_video(&self, id: String) {
        self.shared.video_flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::ConnectVideo(id));
    }
    pub fn disconnect_video(&self) {
        self.shared.video_flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::DisconnectVideo);
    }
    pub fn connect_audio(&self, id: String) {
        self.shared.audio_flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::ConnectAudio(id));
    }
    pub fn disconnect_audio(&self) {
        self.shared.audio_flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::DisconnectAudio);
    }
    pub fn connect_data(&self, id: String) {
        self.shared.data_flowed.store(false, Ordering::Relaxed);
        self.shared.data_last_ms.store(0, Ordering::Relaxed);
        let _ = self.commands.send(Command::ConnectData(id));
    }
    pub fn disconnect_data(&self) {
        self.shared.data_flowed.store(false, Ordering::Relaxed);
        self.shared.data_last_ms.store(0, Ordering::Relaxed);
        let _ = self.commands.send(Command::DisconnectData);
    }
    pub fn reconfigure(&self) {
        let _ = self.commands.send(Command::Reconfigure);
    }
    pub fn media_ready(&self) -> bool {
        self.shared.video_flowed.load(Ordering::Relaxed)
    }
}

/// Datenspur (ANC, Zeitcode, Untertitel): ein Daten-Flow wird Grain für Grain unverändert in den eigenen Ausgangs-Flow kopiert,
/// mit **demselben Grain-Index** (gemeinsame TAI-Zeit) — Bild, Ton und Daten bleiben zueinander ausgerichtet. Der Normalizer
/// wandelt Daten nicht; sie laufen am Format-Abgleich vorbei (die Verzögerung eines A/V-Ausgleichs gilt hier nicht).
/// Millisekunden seit dem ersten Aufruf (monoton), für die Aktualität der Datenspur.
pub fn now_ms() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64
}

/// Daten gelten als „fließend“, wenn der letzte Grain höchstens so lange her ist.
pub const DATA_FRESH_MS: u64 = 3000;

impl Shared {
    /// Liefert die Datenspur frische Daten? (letzter Grain höchstens `DATA_FRESH_MS` her)
    pub fn data_fresh(&self) -> bool {
        let last = self.data_last_ms.load(Ordering::Relaxed);
        last != 0 && now_ms().saturating_sub(last) <= DATA_FRESH_MS
    }
}

struct DataLane {
    _input: omp_mediaio::mxl::MxlDataInput,
}

/// Baut die Datenspur. `on_grain` wird nach jedem durchgereichten Grain gerufen. Rückgabe: Spur und Grain-Rate der Quelle.
fn build_data_lane(ctx: &Arc<MxlContext>, source_flow_id: &str, out_flow_id: &str, label: &str, on_grain: Arc<dyn Fn() + Send + Sync>) -> Result<(DataLane, (i64, i64)), String> {
    let def = ctx.flow_def(source_flow_id).map_err(|e| format!("Quelle {source_flow_id}: {e}"))?;
    let (num, den) = omp_mediaio::mxl::grain_rate_of(&def);
    let out = Arc::new(omp_mediaio::mxl::MxlDataOutput::new(ctx.clone(), out_flow_id, &format!("{label} Daten"), label, num as u32, den as u32)?);
    let input = omp_mediaio::mxl::MxlDataInput::new_indexed(ctx.clone(), source_flow_id, move |index, payload| {
        if out.write_grain(index, payload).is_ok() {
            on_grain();
        }
    })?;
    Ok((DataLane { _input: input }, (num, den)))
}

fn connect_data(ctx: &Arc<MxlContext>, source_flow_id: &str, config: &Config, shared: &Arc<Shared>) -> Result<DataLane, String> {
    let sh = shared.clone();
    let (lane, (num, den)) = build_data_lane(ctx, source_flow_id, &config.data_flow_id, &config.label, Arc::new(move || {
        sh.data_flowed.store(true, Ordering::Relaxed);
        sh.data_last_ms.store(now_ms().max(1), Ordering::Relaxed);
    }))?;
    *shared.data_mode.lock().expect("lock poisoned") = format!("durchgereicht ({num}/{den})");
    Ok(lane)
}

struct ActiveVideo {
    pipeline: gst::Pipeline,
    _input: MxlVideoInput,
    _output: MxlVideoOutput,
    /// Letzter Fehler der Abbildungsstufe (leer = keiner); der 2-s-Takt meldet ihn als Alarm.
    map_error: Arc<Mutex<String>>,
}

impl Drop for ActiveVideo {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

enum VideoBranch {
    #[allow(dead_code)] // gehalten, damit Drop die Pipeline beendet
    Gst(ActiveVideo),
    Raw(RawVideoCopy),
    /// Nichts läuft (blockiert/Fehler): nur Anzeige.
    None,
}

impl VideoBranch {
    fn is_dead(&self) -> bool {
        matches!(self, VideoBranch::Raw(r) if r.is_dead())
    }
    fn map_error(&self) -> String {
        match self {
            VideoBranch::Gst(a) => a.map_error.lock().expect("lock poisoned").clone(),
            _ => String::new(),
        }
    }
}

struct ActiveAudio {
    pipeline: gst::Pipeline,
    _input: MxlAudioInput,
    _output: MxlAudioOutput,
}

impl Drop for ActiveAudio {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

enum AudioBranch {
    Raw(RawAudioCopy),
    #[allow(dead_code)] // gehalten, damit Drop die Pipeline beendet
    Gst(ActiveAudio),
    None,
}

impl AudioBranch {
    fn is_dead(&self) -> bool {
        matches!(self, AudioBranch::Raw(r) if r.is_dead())
    }
}

fn names(stages: &[Stage]) -> Vec<String> {
    stages.iter().map(|s| s.as_str().to_string()).collect()
}

fn queue() -> Result<gst::Element, String> {
    gst::ElementFactory::make("queue").build().map_err(|e| format!("queue: {e}"))
}

/// Gibt eine Ausgangs-Flow-Datei frei, damit sie mit neuem Format angelegt werden kann: verwaiste Flows (kein lebender
/// Schreiber/Leser) räumt `garbage_collect_flows` weg. Der alte Schreiber braucht einen Moment zum Beenden, deshalb wird
/// kurz wiederholt. Halten Leser den Flow offen (nachgeschaltete Nodes), bleibt er bestehen — der Aufrufer prüft danach
/// die Flow-Definition (`output_matches`).
fn free_flow(ctx: &Arc<MxlContext>, flow_id: &str) {
    for _ in 0..30 {
        ctx.instance().garbage_collect_flows().ok();
        if ctx.flow_def(flow_id).is_err() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Stimmt die vorhandene Ausgangs-Flow-Definition mit der erwarteten Größe/Rasterart überein?
fn output_matches(ctx: &Arc<MxlContext>, flow_id: &str, width: u32, height: u32, scan: &str) -> bool {
    match ctx.flow_def(flow_id).ok().and_then(|d| flowdef::parse_video(&d).ok()) {
        Some(v) => v.width == width && v.height == height && format!("{:?}", v.scan).to_lowercase().contains(scan),
        None => false,
    }
}

/// Bewertet die Quelle und baut den Zweig. Gibt Zweig und Anzeige zurück; Fehler werden zu `state=error`.
fn connect_video(
    ctx: &Arc<MxlContext>,
    source_flow_id: &str,
    config: &Config,
    shared: &Shared,
    wake: &Arc<dyn Fn() + Send + Sync>,
) -> Result<(VideoBranch, BranchInfo, Option<String>), String> {
    let def_json = ctx.flow_def(source_flow_id)?;
    let inp = flowdef::parse_video(&def_json)?;
    let house = shared.house.lock().expect("lock poisoned").clone();
    let mode = *shared.mode.lock().expect("lock poisoned");
    let opts = PlanOptions { transfer_policy: *shared.transfer_policy.lock().expect("lock poisoned"), ..Default::default() };
    let plan = plan::plan(&InputFormat { video: Some(inp.clone()), audio: None }, &house, &opts);
    let mut info = BranchInfo {
        state: "waiting",
        input: serde_json::to_value(&inp).unwrap_or_default(),
        deviations: plan.deviations.iter().map(|d| d.detail.clone()).collect(),
        stages: names(&plan.video_stages),
        warnings: plan.warnings.clone(),
    };
    if let Some(why) = &plan.blocked {
        info.state = "blocked";
        return Ok((VideoBranch::None, info, Some(why.clone())));
    }
    if plan.copy_video {
        let def: serde_json::Value = serde_json::from_str(&def_json).map_err(|e| e.to_string())?;
        let target = VideoFormat { width: inp.width, height: inp.height, rate_num: inp.rate.num, rate_den: inp.rate.den };
        let rc = RawVideoCopy::start_delayed(
            ctx.clone(),
            ctx.clone(),
            source_flow_id,
            def,
            &config.video_flow_id,
            &config.label,
            target,
            Arc::new(AtomicBool::new(false)),
            wake.clone(),
            Some(shared.delay.clone()),
        )
        .map_err(|e| format!("Kopierer: {e}"))?;
        info.state = "copy";
        // media-ready kommt über den eigenen `flowed`-Zähler nicht; die Anzeige folgt dem Quellfluss unten.
        shared.video_flowed.store(true, Ordering::Relaxed);
        return Ok((VideoBranch::Raw(rc), info, None));
    }
    if mode == Mode::CopyOnly {
        info.state = "blocked";
        let why = format!("Abweichung vom Hausformat ({}), Modus copyOnly wandelt nicht", info.deviations.join("; "));
        return Ok((VideoBranch::None, info, Some(why)));
    }
    let unsupported: Vec<&'static str> = plan
        .video_stages
        .iter()
        .filter(|st| matches!(st, Stage::PixelFormat))
        .map(|st| st.as_str())
        .collect();
    let hv = house.video.as_ref().ok_or("Hausformat ohne Videoteil")?;
    if !unsupported.is_empty() {
        info.state = "error";
        let why = format!("Stufe(n) {} sind noch nicht umgesetzt ", unsupported.join(", "));
        return Ok((VideoBranch::None, info, Some(why)));
    }
    // Kennzeichnung der neu angelegten Ausgangs-Flows: Farbraum/Übertragungsfunktion des Hausformats, sonst die des Eingangs.
    let cs = hv.colorspace.clone().or_else(|| inp.colorspace.clone()).unwrap_or_else(|| "BT709".into());
    let tr = hv.transfer.clone().or_else(|| inp.transfer.clone()).unwrap_or_else(|| "SDR".into());
    omp_mediaio::colorimetry::set_process_override(omp_mediaio::colorimetry::Colorimetry::parse(&format!("{cs}/{tr}")).ok());
    let backend_name = shared.map_backend.lock().expect("lock poisoned").clone();
    let active = build_video_chain(ctx, source_flow_id, &inp, hv, &plan, config, &backend_name)?;
    info.state = "convert";
    shared.video_flowed.store(true, Ordering::Relaxed);
    Ok((VideoBranch::Gst(active), info, None))
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory).build().map_err(|e| format!("{factory}: {e}"))
}

fn gst_colorimetry(name: &str) -> &'static str {
    match name.to_ascii_uppercase().as_str() {
        "BT601" => "bt601",
        "BT2020" | "BT2100" => "bt2020",
        _ => "bt709",
    }
}

/// Baut die Wandlungskette für Video in fester Stufenfolge (Halbbild auflösen → Rate/Größe → Farbmatrix → Halbbild
/// erzeugen). Ausgang immer mit den stabilen Flow-IDs. Zwischen den Stufen arbeitet GStreamer mit 8-Bit-4:2:2 (`Y42B`),
/// weil `deinterlace`/`interlace` kein 10-Bit unterstützen: **Stufen mit Halbbild kosten Bittiefe** (Mindestlösung,
/// im Handbuch benannt); reine Größen-/Ratenwandlung bleibt bei v210.
/// Wendet die Abbildungsstufe auf die Y-Ebene eines Y42B-Puffers an. Die Stufe sitzt vor der Skalierung, Breite/Höhe
/// sind die des Eingangs; Zeilenabstand der Y-Ebene = Breite auf 4 aufgerundet (GStreamer-Standard für Y42B).
fn map_luma_in_buffer(buf: &mut gst::Buffer, w: u32, h: u32, from: Curve, to: Curve, backend: &mut dyn StageBackend, err: &Arc<Mutex<String>>) {
    let stride = (w as usize + 3) & !3;
    let b = buf.make_mut();
    let Ok(mut map) = b.map_writable() else { return };
    let data = map.as_mut_slice();
    if data.len() < stride * h as usize {
        return;
    }
    let mut packed = Vec::with_capacity((w * h) as usize);
    for row in 0..h as usize {
        packed.extend_from_slice(&data[row * stride..row * stride + w as usize]);
    }
    match backend.map_luma(&MapRequest { from, to, width: w, height: h }, &mut packed) {
        Ok(()) => {
            for row in 0..h as usize {
                data[row * stride..row * stride + w as usize].copy_from_slice(&packed[row * w as usize..(row + 1) * w as usize]);
            }
        }
        Err(e) => *err.lock().expect("lock poisoned") = format!("Abbildungsdienst {}: {e}", backend.name()),
    }
}

fn build_video_chain(
    ctx: &Arc<MxlContext>,
    source_flow_id: &str,
    inp: &flowdef::VideoIn,
    hv: &VideoHouse,
    plan: &plan::Plan,
    config: &Config,
    backend_name: &str,
) -> Result<ActiveVideo, String> {
    let pipeline = gst::Pipeline::new();
    let input = MxlVideoInput::new(&pipeline, ctx.clone(), source_flow_id)?;
    let mut chain: Vec<gst::Element> = vec![input.tail.clone()];
    let add = |els: Vec<gst::Element>, pipeline: &gst::Pipeline, chain: &mut Vec<gst::Element>| -> Result<(), String> {
        for e in els {
            pipeline.add(&e).map_err(|er| format!("add: {er}"))?;
            let prev = chain.last().expect("Kette nie leer").clone();
            prev.link(&e).map_err(|er| format!("link: {er}"))?;
            chain.push(e);
        }
        Ok(())
    };
    let has = |st: Stage| plan.video_stages.contains(&st);
    let eight_bit = || -> Result<gst::Element, String> {
        let f = make("capsfilter")?;
        // `interlace-mode=progressive` festnageln: sonst verlangt die Kette stromaufwärts „interleaved“ (aus dem Etikett).
        f.set_property("caps", gst::Caps::builder("video/x-raw").field("format", "Y42B").field("interlace-mode", "progressive").build());
        Ok(f)
    };

    if has(Stage::Deinterlace) {
        let field_order = if inp.scan == Scan::InterlacedBff { "bottom-field-first" } else { "top-field-first" };
        let setter = make("capssetter")?;
        setter.set_property(
            "caps",
            gst::Caps::builder("video/x-raw").field("interlace-mode", "interleaved").field("field-order", field_order).build(),
        );
        let di = make("deinterlace")?;
        di.set_property_from_str("mode", "interlaced");
        di.set_property_from_str("method", &std::env::var("OMP_DEINTERLACE_METHOD").unwrap_or_else(|_| "greedyh".into()));
        di.set_property_from_str("fields", if plan.deinterlace_double { "all" } else { "top" });
        add(vec![make("videoconvert")?, eight_bit()?, setter, di], &pipeline, &mut chain)?;
    }
    if has(Stage::ColorMatrix) {
        let incs = inp.colorspace.as_deref().map(gst_colorimetry).unwrap_or("bt709");
        let outcs = hv.colorspace.as_deref().map(gst_colorimetry).unwrap_or("bt709");
        let label = make("capssetter")?;
        label.set_property("caps", gst::Caps::builder("video/x-raw").field("colorimetry", incs).build());
        let want = make("capsfilter")?;
        want.set_property("caps", gst::Caps::builder("video/x-raw").field("colorimetry", outcs).build());
        add(vec![label, make("videoconvert")?, want], &pipeline, &mut chain)?;
    }

    let map_error = Arc::new(Mutex::new(String::new()));
    if has(Stage::TransferMap) {
        let from = inp.transfer.as_deref().and_then(Curve::parse).ok_or("Übertragungsfunktion des Eingangs unbekannt")?;
        let to = hv.transfer.as_deref().and_then(Curve::parse).ok_or("Übertragungsfunktion des Hausformats unbekannt")?;
        let backend = Mutex::new(omp_normalizer::tonemap::make_backend(backend_name)?);
        let tap = make("identity")?;
        let err = map_error.clone();
        let (w, h) = (inp.width, inp.height);
        let pad = tap.static_pad("src").ok_or("identity ohne src-Pad")?;
        pad.add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            if let Some(gst::PadProbeData::Buffer(ref mut buf)) = info.data {
                map_luma_in_buffer(buf, w, h, from, to, backend.lock().expect("lock poisoned").as_mut(), &err);
            }
            gst::PadProbeReturn::Ok
        });
        add(vec![make("videoconvert")?, eight_bit()?, tap], &pipeline, &mut chain)?;
    }
    let to_house_rate = if hv.scan.is_interlaced() { hv.rate.doubled() } else { hv.rate };
    let out_pipeline_tail: gst::Element;
    let output: MxlVideoOutput;
    if hv.scan.is_interlaced() {
        // Größe/Rate auf Hausgröße bei doppelter Rate (Halbbildrate), dann zwei Bilder zu einem Vollbild mit zwei Halbbildern.
        let caps = make("capsfilter")?;
        caps.set_property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("format", "Y42B")
                .field("interlace-mode", "progressive")
                .field("width", hv.width as i32)
                .field("height", hv.height as i32)
                .field("framerate", gst::Fraction::new(to_house_rate.num as i32, to_house_rate.den as i32))
                .build(),
        );
        let il = make("interlace")?;
        il.set_property("top-field-first", hv.scan == Scan::InterlacedTff);
        il.set_property_from_str("field-pattern", "1:1");
        let vr = make("videorate")?;
        vr.set_property("max-duplication-time", 1_000_000_000u64);
        add(vec![make("videoconvert")?, make("videoscale")?, vr, caps, il, queue()?], &pipeline, &mut chain)?;
        out_pipeline_tail = chain.last().expect("Kette nie leer").clone();
        output = MxlVideoOutput::new_interlaced_tff(
            &pipeline,
            &out_pipeline_tail,
            ctx.clone(),
            &config.video_flow_id,
            &config.label,
            hv.width,
            hv.height,
            hv.rate.num,
            hv.rate.den,
            Arc::new(AtomicU64::new(0)),
        )
        .map_err(|e| format!("MxlVideoOutput: {e}"))?;
    } else {
        add(vec![queue()?], &pipeline, &mut chain)?;
        out_pipeline_tail = chain.last().expect("Kette nie leer").clone();
        let rate_mode = if omp_mediaio::framerate::same_rate(input.framerate_numerator, input.framerate_denominator, hv.rate.num, hv.rate.den) {
            omp_mediaio::framerate::RateMode::Videorate
        } else {
            config.rate_mode
        };
        output = MxlVideoOutput::new_with_rate_mode(
            &pipeline,
            &out_pipeline_tail,
            ctx.clone(),
            &config.video_flow_id,
            &config.label,
            hv.width,
            hv.height,
            hv.rate.num,
            hv.rate.den,
            Arc::new(AtomicU64::new(0)),
            rate_mode,
        )
        .map_err(|e| format!("MxlVideoOutput: {e}"))?;
    }
    output.set_active(true);
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("set state playing: {e}"))?;
    Ok(ActiveVideo { pipeline, _input: input, _output: output, map_error })
}

/// Tonkette: Kanalzuordnung (`audiomixmatrix`) → Abtastrate (`audioresample`) → Ausgang. Datenkanäle werden nur 1:1
/// durchgereicht (Prüfung in `AudioMap::validate`); eine Abtastratenwandlung mit Datenkanälen sperrt der Plan.
fn build_audio_chain(
    ctx: &Arc<MxlContext>,
    source_flow_id: &str,
    inp: &flowdef::AudioIn,
    ha: &omp_normalizer::house::AudioHouse,
    plan: &plan::Plan,
    map: &AudioMap,
    config: &Config,
) -> Result<ActiveAudio, String> {
    map.validate(inp.channels, ha.channels)?;
    let pipeline = gst::Pipeline::new();
    let input = MxlAudioInput::new(&pipeline, ctx.clone(), source_flow_id)?;
    let mut last = input.tail.clone();
    let push = |e: gst::Element, last: &mut gst::Element| -> Result<(), String> {
        pipeline.add(&e).map_err(|er| format!("add: {er}"))?;
        last.link(&e).map_err(|er| format!("link: {er}"))?;
        *last = e;
        Ok(())
    };
    if plan.audio_stages.contains(&Stage::ChannelMap) {
        let mix = make("audiomixmatrix")?;
        mix.set_property("in-channels", inp.channels);
        mix.set_property("out-channels", ha.channels);
        mix.set_property_from_str("mode", "manual");
        let rows: Vec<gst::glib::SendValue> =
            map.matrix(inp.channels, ha.channels).iter().map(|r| gst::Array::new(r.iter().copied()).to_send_value()).collect();
        mix.set_property("matrix", gst::Array::from_values(rows));
        // Kanalanordnung nicht raten: unpositioniert (channel-mask 0), die Zuordnung steckt allein in der Matrix.
        let setter = make("capssetter")?;
        setter.set_property("caps", gst::Caps::builder("audio/x-raw").field("channel-mask", gst::Bitmask::new(0)).build());
        push(setter, &mut last)?;
        push(mix, &mut last)?;
    }
    if plan.audio_stages.contains(&Stage::Resample) {
        push(make("audioconvert")?, &mut last)?;
        push(make("audioresample")?, &mut last)?;
    }
    let tail = queue()?;
    push(tail, &mut last)?;
    let output = MxlAudioOutput::new(&pipeline, &last, ctx.clone(), &config.audio_flow_id, &config.label, ha.sample_rate, ha.channels)
        .map_err(|e| format!("MxlAudioOutput: {e}"))?;
    output.set_active(true);
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("set state playing: {e}"))?;
    Ok(ActiveAudio { pipeline, _input: input, _output: output })
}

fn connect_audio(
    ctx: &Arc<MxlContext>,
    source_flow_id: &str,
    config: &Config,
    shared: &Shared,
    wake: &Arc<dyn Fn() + Send + Sync>,
) -> Result<(AudioBranch, BranchInfo, Option<String>), String> {
    let def_json = ctx.flow_def(source_flow_id)?;
    let inp = flowdef::parse_audio(&def_json)?;
    let house = shared.house.lock().expect("lock poisoned").clone();
    let mode = *shared.mode.lock().expect("lock poisoned");
    let map = shared.audio_map.lock().expect("lock poisoned").clone();
    shared.delay.set_data_channels(map.data_channels.iter().map(|c| *c as usize).collect());
    let opts = PlanOptions { explicit_audio_map: !map.outputs.is_empty(), data_channels: map.data_channels.clone(), ..Default::default() };
    let plan = plan::plan(&InputFormat { video: None, audio: Some(inp.clone()) }, &house, &opts);
    let mut info = BranchInfo {
        state: "waiting",
        input: serde_json::to_value(&inp).unwrap_or_default(),
        deviations: plan.deviations.iter().map(|d| d.detail.clone()).collect(),
        stages: names(&plan.audio_stages),
        warnings: plan.warnings.clone(),
    };
    if let Some(why) = &plan.blocked {
        info.state = "blocked";
        return Ok((AudioBranch::None, info, Some(why.clone())));
    }
    if plan.copy_audio {
        let def: serde_json::Value = serde_json::from_str(&def_json).map_err(|e| e.to_string())?;
        let target = AudioFormat { sample_rate: inp.sample_rate, channels: inp.channels };
        let rc = RawAudioCopy::start_delayed(
            ctx.clone(),
            ctx.clone(),
            source_flow_id,
            def,
            &config.audio_flow_id,
            &config.label,
            target,
            Arc::new(AtomicBool::new(false)),
            wake.clone(),
            Some(shared.delay.clone()),
        )
        .map_err(|e| format!("Kopierer: {e}"))?;
        info.state = "copy";
        shared.audio_flowed.store(true, Ordering::Relaxed);
        return Ok((AudioBranch::Raw(rc), info, None));
    }
    if mode == Mode::CopyOnly {
        info.state = "blocked";
        let why = format!("Abweichung vom Hausformat ({}), Modus copyOnly wandelt nicht", info.deviations.join("; "));
        return Ok((AudioBranch::None, info, Some(why)));
    }
    if plan.audio_stages.contains(&Stage::SampleFormat) {
        info.state = "error";
        return Ok((AudioBranch::None, info, Some("Tonformat außer audio/float32 ist noch nicht umgesetzt".to_string())));
    }
    let ha = house.audio.as_ref().ok_or("Hausformat ohne Tonteil")?;
    let active = build_audio_chain(ctx, source_flow_id, &inp, ha, &plan, &map, config)?;
    info.state = "convert";
    shared.audio_flowed.store(true, Ordering::Relaxed);
    Ok((AudioBranch::Gst(active), info, None))
}

/// Meldet einen Fehler; eine unveränderte Meldung wird nicht erneut als Alarm gesendet (kein Alarm-Dauerfeuer bei
/// den 2-s-Wiederholungen).
fn set_error(shared: &Shared, tx: &UnboundedSender<Event>, msg: String) {
    let mut last = shared.last_error.lock().expect("lock poisoned");
    if *last == msg {
        return;
    }
    *last = msg.clone();
    let _ = tx.send(Event::Error(msg));
}

pub fn run(
    config: Config,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
    heartbeat: Arc<AtomicU64>,
) {
    if let Err(e) = gst::init() {
        let msg = format!("gst init failed: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }
    let ctx = match MxlContext::new(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };
    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let shared = Arc::new(Shared {
        house: Mutex::new(config.house.clone()),
        mode: Mutex::new(config.mode),
        audio_map: Mutex::new(config.audio_map.clone()),
        transfer_policy: Mutex::new(None),
        map_backend: Mutex::new(std::env::var("OMP_MAP_BACKEND").unwrap_or_else(|_| "builtin".into())),
        avsync: Mutex::new(AvSyncSettings::default()),
        delay: AvDelay::new(std::env::var("OMP_AVSYNC_MAX_VIDEO_FRAMES").ok().and_then(|v| v.parse().ok()).unwrap_or(12)),
        applied: Mutex::new(None),
        video: Mutex::new(BranchInfo::default()),
        audio: Mutex::new(BranchInfo::default()),
        video_flowed: AtomicBool::new(false),
        audio_flowed: AtomicBool::new(false),
        data_flowed: AtomicBool::new(false),
        data_last_ms: AtomicU64::new(0),
        data_mode: Mutex::new(String::new()),
        format_changes: AtomicU64::new(0),
        last_error: Mutex::new(String::new()),
    });
    let _ = ready.send(Ok(PipelineHandle { commands: commands_tx.clone(), shared: shared.clone() }));

    let wake: Arc<dyn Fn() + Send + Sync> = {
        let tx = commands_tx.clone();
        let m = Mutex::new(());
        Arc::new(move || {
            let _g = m.lock();
            let _ = tx.send(Command::SourceLost);
        })
    };
    let watcher = match DomainWatch::new(std::path::Path::new(&config.domain)) {
        Ok(w) => {
            let tx = commands_tx.clone();
            let stop = shutdown.clone();
            Some(std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    if w.wait(Some(Duration::from_secs(1))) && tx.send(Command::DomainChanged).is_err() {
                        break;
                    }
                }
            }))
        }
        Err(e) => {
            eprintln!("omp-normalizer: Domain {} nicht beobachtbar ({e})", config.domain);
            None
        }
    };

    let mut video = VideoBranch::None;
    let mut audio = AudioBranch::None;
    let mut last_video: Option<String> = None;
    let mut last_audio: Option<String> = None;
    let mut seen_video: Option<serde_json::Value> = None;
    let mut seen_audio: Option<serde_json::Value> = None;
    let mut retry_video = false;
    let mut retry_audio = false;
    let mut data: Option<DataLane> = None;
    let mut last_data: Option<String> = None;
    let mut retry_data = false;

    // Baut den Videozweig (neu) auf. Vorher den alten abbauen, damit die Ausgangs-Flow-Datei frei wird; verwaiste Flows mit
    // anderem Format räumt `garbage_collect_flows` weg (nur Flows ohne lebenden Schreiber/Leser).
    macro_rules! rebuild_video {
        () => {{
            video = VideoBranch::None;
            free_flow(&ctx, &config.video_flow_id);
            if let Some(id) = last_video.clone() {
                match connect_video(&ctx, &id, &config, &shared, &wake) {
                    Ok((b, mut info, mut problem)) => {
                        seen_video = Some(info.input.clone());
                        if matches!(info.state, "copy" | "convert") {
                            // Erwartete Ausgangsgröße: Kopie = Eingang, Wandlung = Hausformat.
                            let (w, h, scan) = if info.state == "copy" {
                                let w = info.input["width"].as_u64().unwrap_or(0) as u32;
                                let h = info.input["height"].as_u64().unwrap_or(0) as u32;
                                (w, h, if info.input["scan"] == "progressive" { "progressive" } else { "interlaced" })
                            } else {
                                let hv = shared.house.lock().expect("lock poisoned").video.clone();
                                hv.map(|v| (v.width, v.height, if v.scan.is_interlaced() { "interlaced" } else { "progressive" })).unwrap_or((0, 0, "progressive"))
                            };
                            std::thread::sleep(Duration::from_millis(300));
                            if !output_matches(&ctx, &config.video_flow_id, w, h, scan) {
                                info.state = "error";
                                problem = Some("Ausgangs-Flow trägt noch das alte Format (nachgeschaltete Leser halten ihn offen): Verbraucher trennen und neu verbinden".to_string());
                            }
                        }
                        if let Some(p) = problem {
                            set_error(&shared, &tx, format!("Video: {p}"));
                        }
                        video = b;
                        *shared.video.lock().expect("lock poisoned") = info;
                        retry_video = false;
                    }
                    Err(e) => {
                        retry_video = true;
                        set_error(&shared, &tx, format!("Video: {e}"));
                        let mut i = BranchInfo::default();
                        i.state = "error";
                        *shared.video.lock().expect("lock poisoned") = i;
                    }
                }
            }
        }};
    }
    macro_rules! rebuild_audio {
        () => {{
            audio = AudioBranch::None;
            free_flow(&ctx, &config.audio_flow_id);
            if let Some(id) = last_audio.clone() {
                match connect_audio(&ctx, &id, &config, &shared, &wake) {
                    Ok((b, info, problem)) => {
                        seen_audio = Some(info.input.clone());
                        if let Some(p) = problem {
                            set_error(&shared, &tx, format!("Ton: {p}"));
                        }
                        audio = b;
                        *shared.audio.lock().expect("lock poisoned") = info;
                        retry_audio = false;
                    }
                    Err(e) => {
                        retry_audio = true;
                        set_error(&shared, &tx, format!("Ton: {e}"));
                        let mut i = BranchInfo::default();
                        i.state = "error";
                        *shared.audio.lock().expect("lock poisoned") = i;
                    }
                }
            }
        }};
    }

    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        let cmd = match commands_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(c) => c,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Command::Tick,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        match cmd {
            Command::ConnectVideo(id) => {
                last_video = Some(id);
                rebuild_video!();
            }
            Command::DisconnectVideo => {
                video = VideoBranch::None;
                last_video = None;
                seen_video = None;
                retry_video = false;
                *shared.video.lock().expect("lock poisoned") = BranchInfo::default();
            }
            Command::ConnectAudio(id) => {
                last_audio = Some(id);
                rebuild_audio!();
            }
            Command::DisconnectAudio => {
                audio = AudioBranch::None;
                last_audio = None;
                seen_audio = None;
                retry_audio = false;
                *shared.audio.lock().expect("lock poisoned") = BranchInfo::default();
            }
            Command::ConnectData(id) => {
                last_data = Some(id.clone());
                data = None;
                match connect_data(&ctx, &id, &config, &shared) {
                    Ok(d) => {
                        data = Some(d);
                        retry_data = false;
                    }
                    Err(e) => {
                        // Die Quelle erscheint evtl. erst später in der Domain: bei der nächsten Änderung erneut versuchen.
                        retry_data = true;
                        *shared.data_mode.lock().expect("lock poisoned") = "wartet auf Quelle".to_string();
                        eprintln!("omp-normalizer: Daten: {e}");
                    }
                }
            }
            Command::DisconnectData => {
                data = None;
                last_data = None;
                retry_data = false;
                shared.data_mode.lock().expect("lock poisoned").clear();
            }
            Command::Reconfigure => {
                rebuild_video!();
                rebuild_audio!();
            }
            Command::SourceLost | Command::DomainChanged | Command::Tick => {
                if video.is_dead() {
                    eprintln!("omp-normalizer: Videoquelle liefert keine Bilder mehr — verbinde neu");
                    shared.video_flowed.store(false, Ordering::Relaxed);
                    retry_video = true;
                    video = VideoBranch::None;
                }
                if audio.is_dead() {
                    eprintln!("omp-normalizer: Tonquelle liefert nichts mehr — verbinde neu");
                    shared.audio_flowed.store(false, Ordering::Relaxed);
                    retry_audio = true;
                    audio = AudioBranch::None;
                }
                let merr = video.map_error();
                if !merr.is_empty() {
                    set_error(&shared, &tx, merr);
                }
                // Format der Quelle geändert (Rasterwechsel der Leitung)? Dann mit gleichen Ausgangs-IDs neu aufbauen.
                if let (Some(id), Some(old)) = (last_video.clone(), seen_video.clone())
                    && let Ok(def) = ctx.flow_def(&id)
                    && let Ok(now) = flowdef::parse_video(&def)
                    && serde_json::to_value(&now).unwrap_or_default() != old
                {
                    shared.format_changes.fetch_add(1, Ordering::Relaxed);
                    eprintln!("omp-normalizer: Eingangsformat (Video) hat sich geändert — baue neu");
                    rebuild_video!();
                }
                if let (Some(id), Some(old)) = (last_audio.clone(), seen_audio.clone())
                    && let Ok(def) = ctx.flow_def(&id)
                    && let Ok(now) = flowdef::parse_audio(&def)
                    && serde_json::to_value(&now).unwrap_or_default() != old
                {
                    shared.format_changes.fetch_add(1, Ordering::Relaxed);
                    eprintln!("omp-normalizer: Eingangsformat (Ton) hat sich geändert — baue neu");
                    rebuild_audio!();
                }
                if retry_video && matches!(video, VideoBranch::None) {
                    rebuild_video!();
                }
                if retry_audio && matches!(audio, AudioBranch::None) {
                    rebuild_audio!();
                }
                if retry_data && data.is_none() && let Some(id) = last_data.clone() && let Ok(d) = connect_data(&ctx, &id, &config, &shared) {
                    data = Some(d);
                    retry_data = false;
                }
            }
        }
    }
    drop(video);
    drop(audio);
    drop(data);
    if let Some(w) = watcher {
        let _ = w.join();
    }
}

#[cfg(test)]
mod live_tests {
    //! Integrationstest mit echtem MXL (`source deploy/dev/mxl.env`): eigene Domain unter /dev/shm, kleine Bilder, wenige
    //! Sekunden. Aufruf: `cargo test -p omp-normalizer -- --ignored --nocapture live_`.
    use super::*;
    use omp_mediaio::mxl::MxlVideoOutput;

    const SRC: &str = "11111111-1111-4111-8111-111111111111";
    const OUT: &str = "22222222-2222-4222-8222-222222222222";
    const AUDIO_OUT: &str = "33333333-3333-4333-8333-333333333333";

    fn house(w: u32, h: u32) -> HouseFormat {
        HouseFormat::from_json(&format!(r#"{{"video":{{"width":{w},"height":{h},"rate":"25/1","scan":"progressive"}}}}"#)).unwrap()
    }

    fn wait_state(shared: &Shared, want: &str, secs: u64) -> bool {
        let end = std::time::Instant::now() + Duration::from_secs(secs);
        while std::time::Instant::now() < end {
            if shared.video.lock().unwrap().state == want {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    #[test]
    #[ignore = "braucht MXL-Laufzeit und etwas CPU: gezielt starten"]
    fn live_copy_is_bit_identical_and_house_change_rebuilds() {
        gst::init().unwrap();
        let dir = format!("/dev/shm/omp-norm-test-{}", std::process::id());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = Arc::new(MxlContext::new(&dir).unwrap());

        // Quelle: 320×180 @ 25 in die Testdomain.
        let pl = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).property_from_str("pattern", "ball").build().unwrap();
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", gst::Caps::builder("video/x-raw").field("width", 320i32).field("height", 180i32).field("framerate", gst::Fraction::new(25, 1)).build())
            .build()
            .unwrap();
        pl.add_many([&src, &caps]).unwrap();
        gst::Element::link_many([&src, &caps]).unwrap();
        let out = MxlVideoOutput::new(&pl, &caps, ctx.clone(), SRC, "test-src", 320, 180, 25, 1, Arc::new(AtomicU64::new(0))).unwrap();
        out.set_active(true);
        pl.set_state(gst::State::Playing).unwrap();
        std::thread::sleep(Duration::from_millis(1500));

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let shutdown = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let cfg = Config {
            domain: dir.clone(),
            video_flow_id: OUT.into(),
            audio_flow_id: AUDIO_OUT.into(),
            data_flow_id: "00000000-0000-4000-8000-0000000000d1".into(),
            label: "norm-test".into(),
            house: house(320, 180),
            mode: Mode::Auto,
            audio_map: AudioMap::default(),
            rate_mode: omp_mediaio::framerate::RateMode::Videorate,
        };
        let (sd, hb) = (shutdown.clone(), Arc::new(AtomicU64::new(0)));
        let th = std::thread::spawn(move || run(cfg, tx, sd, ready_tx, hb));
        let handle = ready_rx.blocking_recv().unwrap().unwrap();

        // 1) Quelle im Hausformat → Kopie, bitgleich, gleicher Grain-Index.
        handle.connect_video(SRC.into());
        assert!(wait_state(&handle.shared, "copy", 8), "state=copy erwartet, ist {}", handle.shared.video.lock().unwrap().state);
        assert!(handle.shared.video.lock().unwrap().stages.is_empty());
        std::thread::sleep(Duration::from_secs(2));
        {
            let rin = ctx.instance().create_flow_reader(SRC).and_then(|r| r.to_grain_reader()).unwrap();
            let rout = ctx.instance().create_flow_reader(OUT).and_then(|r| r.to_grain_reader()).unwrap();
            // Der Ringpuffer ist kurz: laufend das jeweils zweitjüngste Grain beider Flows vergleichen.
            let (mut compared, mut differ) = (0, 0);
            let mut last = 0u64;
            let end = std::time::Instant::now() + Duration::from_secs(4);
            while std::time::Instant::now() < end {
                let idx = ctx.ns_to_index(ctx.now_ns(), 25, 1).unwrap() - 2;
                if idx != last {
                    last = idx;
                    if let (Ok(a), Ok(b)) = (rin.get_complete_grain(idx, Duration::from_millis(60)), rout.get_complete_grain(idx, Duration::from_millis(60)))
                        && a.index == idx
                        && b.index == idx
                    {
                        compared += 1;
                        if a.payload[..] != b.payload[..] {
                            differ += 1;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            println!("verglichen {compared} Grains, abweichend {differ}");
            assert!(compared >= 8, "zu wenige vergleichbare Grains: {compared}");
            assert_eq!(differ, 0, "Kopie muss bitgleich sein");
        }

        // 2) Hausformat zur Laufzeit auf 640×360 → Wandlung, Ausgangs-ID unverändert.
        *handle.shared.house.lock().unwrap() = house(640, 360);
        handle.reconfigure();
        assert!(wait_state(&handle.shared, "convert", 10), "state=convert erwartet");
        assert_eq!(handle.shared.video.lock().unwrap().stages, vec!["scale".to_string()]);
        std::thread::sleep(Duration::from_secs(2));
        let def: serde_json::Value = serde_json::from_str(&ctx.flow_def(OUT).unwrap()).unwrap();
        assert_eq!(def["frame_width"], 640, "Ausgangs-flow_def folgt dem Hausformat: {def}");

        // 3) zurück auf 320×180 → wieder Kopie (gleiche Ausgangs-ID, altes Format wird ersetzt).
        *handle.shared.house.lock().unwrap() = house(320, 180);
        handle.reconfigure();
        assert!(wait_state(&handle.shared, "copy", 10), "state=copy erwartet");
        std::thread::sleep(Duration::from_secs(1));
        let def: serde_json::Value = serde_json::from_str(&ctx.flow_def(OUT).unwrap()).unwrap();
        assert_eq!(def["frame_width"], 320, "Ausgangs-flow_def folgt dem Hausformat: {def}");

        // 4) copyOnly + Abweichung → blockiert, keine Wandlung.
        *handle.shared.mode.lock().unwrap() = Mode::CopyOnly;
        *handle.shared.house.lock().unwrap() = house(640, 360);
        handle.reconfigure();
        assert!(wait_state(&handle.shared, "blocked", 10), "state=blocked erwartet");

        shutdown.store(true, Ordering::Relaxed);
        let _ = th.join();
        let _ = pl.set_state(gst::State::Null);
        drop(out);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod live_stage_tests {
    //! Integrationstests der Wandlungsstufen aus Schritt 106.3 mit echtem MXL (kleine Bilder, wenige Sekunden):
    //! `cargo test -p omp-normalizer --bin omp-normalizer -- --ignored --nocapture live_stage`.
    use super::*;
    use omp_mediaio::mxl::MxlVideoOutput;

    const SRC_V: &str = "44444444-4444-4444-8444-444444444444";
    const SRC_A: &str = "55555555-5555-4555-8555-555555555555";
    const OUT_V: &str = "66666666-6666-4666-8666-666666666666";
    const OUT_A: &str = "77777777-7777-4777-8777-777777777777";

    /// Die Datenspur kopiert Grains unverändert und mit demselben Index (Bild/Ton/Daten bleiben ausgerichtet).
    #[test]
    #[ignore = "braucht die MXL-Laufzeit (libmxl, siehe deploy/dev/mxl.env)"]
    fn data_lane_copies_grains_with_the_same_index() {
        let env = Env::new("data");
        let (src_id, out_id) = ("00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2");
        let src = omp_mediaio::mxl::MxlDataOutput::new(env.ctx.clone(), src_id, "Quelle", "T", 25, 1).unwrap();
        let seen = Arc::new(Mutex::new(Vec::<(u64, Vec<u8>)>::new()));
        let flowed = Arc::new(AtomicBool::new(false));
        let fl = flowed.clone();
        let (lane, rate) = build_data_lane(&env.ctx, src_id, out_id, "Test", Arc::new(move || fl.store(true, Ordering::Relaxed))).unwrap();
        assert_eq!(rate, (25, 1));
        // Leser am Ausgang der Spur.
        let sink = seen.clone();
        let _reader = omp_mediaio::mxl::MxlDataInput::new_indexed(env.ctx.clone(), out_id, move |i, p| sink.lock().unwrap().push((i, p.to_vec()))).unwrap();
        let mut written = Vec::new();
        for n in 0..25u8 {
            let idx = src.current_index();
            let mut payload = vec![0u8; omp_mediaio::anc::HEADER_LEN + 8];
            payload[omp_mediaio::anc::HEADER_LEN..].copy_from_slice(&[n, n ^ 0x5a, 1, 2, 3, 4, 5, 6]);
            payload[0] = 0x01; // nicht leer, damit der Leser den Grain als Nutzlast sieht
            src.write_grain(idx, &payload).unwrap();
            written.push((idx, payload));
            src.sleep_until_index(idx + 1);
        }
        std::thread::sleep(Duration::from_millis(500));
        drop(lane);
        assert!(flowed.load(Ordering::Relaxed), "kein Grain durchgereicht");
        let got = seen.lock().unwrap().clone();
        let matched = written.iter().filter(|(i, p)| got.iter().any(|(gi, gp)| gi == i && gp[..p.len()] == p[..])).count();
        assert!(matched >= 18, "nur {matched} von {} Grains mit gleichem Index und gleicher Nutzlast angekommen (gelesen: {})", written.len(), got.len());
    }

    struct Env {
        dir: String,
        ctx: Arc<MxlContext>,
    }
    impl Env {
        fn new(tag: &str) -> Env {
            gst::init().unwrap();
            let dir = format!("/dev/shm/omp-norm-{tag}-{}", std::process::id());
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let ctx = Arc::new(MxlContext::new(&dir).unwrap());
            Env { dir, ctx }
        }
    }
    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    struct Running {
        handle: PipelineHandle,
        shutdown: Arc<AtomicBool>,
        th: Option<std::thread::JoinHandle<()>>,
    }
    impl Running {
        fn start(env: &Env, house: HouseFormat, map: AudioMap) -> Running {
            let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
            let shutdown = Arc::new(AtomicBool::new(false));
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let cfg = Config {
                domain: env.dir.clone(),
                video_flow_id: OUT_V.into(),
                audio_flow_id: OUT_A.into(),
                data_flow_id: "00000000-0000-4000-8000-0000000000d2".into(),
                label: "norm-test".into(),
                house,
                mode: Mode::Auto,
                audio_map: map,
                rate_mode: omp_mediaio::framerate::RateMode::Videorate,
            };
            let (sd, hb) = (shutdown.clone(), Arc::new(AtomicU64::new(0)));
            let th = std::thread::spawn(move || {
                // `_rx` lebt nur in der Hülle; der Sender ignoriert Fehler beim Schließen.
                run(cfg, tx, sd, ready_tx, hb)
            });
            let handle = ready_rx.blocking_recv().unwrap().unwrap();
            Running { handle, shutdown, th: Some(th) }
        }
        fn wait_state(&self, video: bool, want: &str, secs: u64) -> bool {
            let end = std::time::Instant::now() + Duration::from_secs(secs);
            while std::time::Instant::now() < end {
                let st = if video { self.handle.shared.video.lock().unwrap().state } else { self.handle.shared.audio.lock().unwrap().state };
                if st == want {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            false
        }
    }
    impl Drop for Running {
        fn drop(&mut self) {
            self.shutdown.store(true, Ordering::Relaxed);
            if let Some(t) = self.th.take() {
                let _ = t.join();
            }
        }
    }

    fn json(s: &str) -> HouseFormat {
        HouseFormat::from_json(s).unwrap()
    }

    fn video_source(env: &Env, w: u32, h: u32, rate: i32, interlaced: bool) -> (gst::Pipeline, MxlVideoOutput) {
        let pl = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).property_from_str("pattern", "smpte").build().unwrap();
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", gst::Caps::builder("video/x-raw").field("width", w as i32).field("height", h as i32).field("framerate", gst::Fraction::new(rate, 1)).build())
            .build()
            .unwrap();
        pl.add_many([&src, &caps]).unwrap();
        gst::Element::link_many([&src, &caps]).unwrap();
        let out = if interlaced {
            MxlVideoOutput::new_interlaced_tff(&pl, &caps, env.ctx.clone(), SRC_V, "test-src", w, h, rate as u32, 1, Arc::new(AtomicU64::new(0))).unwrap()
        } else {
            MxlVideoOutput::new(&pl, &caps, env.ctx.clone(), SRC_V, "test-src", w, h, rate as u32, 1, Arc::new(AtomicU64::new(0))).unwrap()
        };
        out.set_active(true);
        pl.set_state(gst::State::Playing).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        (pl, out)
    }

    fn out_def(env: &Env) -> serde_json::Value {
        serde_json::from_str(&env.ctx.flow_def(OUT_V).unwrap()).unwrap()
    }

    /// Zählt, wie viele neue Ausgangs-Grains in `secs` Sekunden ankommen (Beleg, dass Bilder fließen).
    fn count_new_grains(env: &Env, rate: u32, secs: u64) -> u32 {
        let rd = env.ctx.instance().create_flow_reader(OUT_V).and_then(|r| r.to_grain_reader()).unwrap();
        let end = std::time::Instant::now() + Duration::from_secs(secs);
        let (mut n, mut last) = (0u32, 0u64);
        while std::time::Instant::now() < end {
            let idx = env.ctx.ns_to_index(env.ctx.now_ns(), rate, 1).unwrap() - 2;
            if idx != last {
                last = idx;
                if rd.get_complete_grain(idx, Duration::from_millis(40)).is_ok_and(|g| g.index == idx) {
                    n += 1;
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        n
    }

    #[test]
    #[ignore = "braucht MXL-Laufzeit und etwas CPU: gezielt starten"]
    fn live_stage_interlace() {
        // A) progressiv 320×180 @ 50 → Haus 320×180 Zeilensprung (TFF) @ 25: Stufe interlace.
        let env = Env::new("il");
        let (pl, out) = video_source(&env, 320, 180, 50, false);
        let house = json(r#"{"video":{"width":320,"height":180,"rate":"25/1","scan":"interlaced_tff","colorspace":"BT709","transfer":"SDR"}}"#);
        let run = Running::start(&env, house, AudioMap::default());
        run.handle.connect_video(SRC_V.into());
        assert!(run.wait_state(true, "convert", 10), "state=convert erwartet");
        assert_eq!(run.handle.shared.video.lock().unwrap().stages, vec!["interlace".to_string()]);
        std::thread::sleep(Duration::from_secs(2));
        let d = out_def(&env);
        assert_eq!(d["interlace_mode"], "interlaced_tff", "{d}");
        assert_eq!(d["grain_rate"]["numerator"], 25, "{d}");
        let n = count_new_grains(&env, 25, 3);
        assert!(n >= 40, "Bilder müssen fließen (25/s · 3 s): {n}");
        drop(run);
        let _ = pl.set_state(gst::State::Null);
        drop(out);
        drop(env);
    }

    #[test]
    #[ignore = "braucht MXL-Laufzeit und etwas CPU: gezielt starten"]
    fn live_stage_deinterlace() {
        // Zeilensprung-Quelle 320×180 @ 25 → Haus progressiv @ 50: Stufe deinterlace mit doppelter Rate.
        let env = Env::new("di");
        let (pl, out) = video_source(&env, 320, 180, 25, true);
        let house = json(r#"{"video":{"width":320,"height":180,"rate":"50/1","scan":"progressive","colorspace":"BT709","transfer":"SDR"}}"#);
        let run = Running::start(&env, house, AudioMap::default());
        run.handle.connect_video(SRC_V.into());
        assert!(run.wait_state(true, "convert", 10), "state=convert erwartet");
        assert_eq!(run.handle.shared.video.lock().unwrap().stages, vec!["deinterlace".to_string()]);
        std::thread::sleep(Duration::from_secs(2));
        let d = out_def(&env);
        assert_eq!(d["interlace_mode"], "progressive", "{d}");
        assert_eq!(d["grain_rate"]["numerator"], 50, "{d}");
        let n = count_new_grains(&env, 50, 3);
        assert!(n >= 80, "Bilder müssen fließen (50/s · 3 s): {n}");
        drop(run);
        let _ = pl.set_state(gst::State::Null);
        drop(out);
    }

    #[test]
    #[ignore = "braucht MXL-Laufzeit und etwas CPU: gezielt starten"]
    fn live_stage_color_matrix() {
        let env = Env::new("cm");
        // Quelle als BT601 kennzeichnen (nur das Etikett des Ausgangs-Flows der Testquelle).
        omp_mediaio::colorimetry::set_process_override(omp_mediaio::colorimetry::Colorimetry::parse("BT601/SDR").ok());
        let (pl, out) = video_source(&env, 320, 180, 25, false);
        omp_mediaio::colorimetry::set_process_override(None);
        let src: serde_json::Value = serde_json::from_str(&env.ctx.flow_def(SRC_V).unwrap()).unwrap();
        assert_eq!(src["colorspace"], "BT601", "Testquelle muss BT601 tragen: {src}");
        let house = json(r#"{"video":{"width":320,"height":180,"rate":"25/1","scan":"progressive","colorspace":"BT709","transfer":"SDR"}}"#);
        let run = Running::start(&env, house, AudioMap::default());
        run.handle.connect_video(SRC_V.into());
        assert!(run.wait_state(true, "convert", 10), "state=convert erwartet");
        assert_eq!(run.handle.shared.video.lock().unwrap().stages, vec!["colorMatrix".to_string()]);
        std::thread::sleep(Duration::from_secs(2));
        let d = out_def(&env);
        assert_eq!(d["colorspace"], "BT709", "{d}");
        // Die Bilddaten müssen sich tatsächlich verändert haben (Matrix angewendet), bei gleicher Größe.
        let rin = env.ctx.instance().create_flow_reader(SRC_V).and_then(|r| r.to_grain_reader()).unwrap();
        let rout = env.ctx.instance().create_flow_reader(OUT_V).and_then(|r| r.to_grain_reader()).unwrap();
        let (mut compared, mut differ) = (0, 0);
        let end = std::time::Instant::now() + Duration::from_secs(3);
        let mut last = 0u64;
        while std::time::Instant::now() < end {
            let idx = env.ctx.ns_to_index(env.ctx.now_ns(), 25, 1).unwrap() - 3;
            if idx != last {
                last = idx;
                if let (Ok(a), Ok(b)) = (rin.get_complete_grain(idx, Duration::from_millis(40)), rout.get_complete_grain(idx, Duration::from_millis(40)))
                    && a.payload.len() == b.payload.len()
                {
                    compared += 1;
                    if a.payload[..] != b.payload[..] {
                        differ += 1;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        println!("Farbmatrix: verglichen {compared}, abweichend {differ}");
        assert!(compared >= 5 && differ == compared, "BT601→BT709 muss die Bilddaten verändern ({differ}/{compared})");
        drop(run);
        let _ = pl.set_state(gst::State::Null);
        drop(out);
    }

    /// 106.3b: HLG-Quelle, SDR-Haus. `warn` → Kopie mit Warnung, `block` → blockiert, `map` → Stufe `transferMap`
    /// (eingebaut, dann Fremdprozess), Gegenprobe gleiche Übertragungsfunktion → keine Stufe.
    #[test]
    #[ignore = "braucht MXL-Laufzeit und etwas CPU: gezielt starten (--test-threads=1)"]
    fn live_stage_transfer_map() {
        use omp_normalizer::house::TransferPolicy as T;
        let env = Env::new("tm");
        omp_mediaio::colorimetry::set_process_override(omp_mediaio::colorimetry::Colorimetry::parse("BT709/HLG").ok());
        let (pl, out) = video_source(&env, 320, 180, 25, false);
        omp_mediaio::colorimetry::set_process_override(None);
        let src: serde_json::Value = serde_json::from_str(&env.ctx.flow_def(SRC_V).unwrap()).unwrap();
        assert_eq!(src["transfer_characteristic"], "HLG", "{src}");
        let house = json(r#"{"video":{"width":320,"height":180,"rate":"25/1","scan":"progressive","colorspace":"BT709","transfer":"SDR"}}"#);
        let run = Running::start(&env, house, AudioMap::default());
        let sh = run.handle.shared.clone();
        run.handle.connect_video(SRC_V.into());
        assert!(run.wait_state(true, "copy", 10), "warn → copy");
        assert!(!sh.video.lock().unwrap().warnings.is_empty(), "Warnung erwartet");
        *sh.transfer_policy.lock().unwrap() = Some(T::Block);
        run.handle.reconfigure();
        assert!(run.wait_state(true, "blocked", 10), "block → blocked");
        *sh.transfer_policy.lock().unwrap() = Some(T::Map);
        run.handle.reconfigure();
        assert!(run.wait_state(true, "convert", 10), "map → convert");
        assert_eq!(sh.video.lock().unwrap().stages, vec!["transferMap".to_string()]);
        let rin = env.ctx.instance().create_flow_reader(SRC_V).and_then(|r| r.to_grain_reader()).unwrap();
        let diff = |secs: u64| -> (u32, u32) {
            let rout = env.ctx.instance().create_flow_reader(OUT_V).and_then(|r| r.to_grain_reader()).unwrap();
            let (mut compared, mut differ, mut last) = (0u32, 0u32, 0u64);
            let end = std::time::Instant::now() + Duration::from_secs(secs);
            while std::time::Instant::now() < end {
                let idx = env.ctx.ns_to_index(env.ctx.now_ns(), 25, 1).unwrap() - 3;
                if idx != last {
                    last = idx;
                    if let (Ok(a), Ok(b)) = (rin.get_complete_grain(idx, Duration::from_millis(40)), rout.get_complete_grain(idx, Duration::from_millis(40)))
                        && a.payload.len() == b.payload.len()
                    {
                        compared += 1;
                        if a.payload[..] != b.payload[..] {
                            differ += 1;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            (compared, differ)
        };
        std::thread::sleep(Duration::from_secs(2));
        let (c, d) = diff(3);
        println!("transferMap eingebaut: verglichen {c}, abweichend {d}; Ausgang {}", out_def(&env)["transfer_characteristic"]);
        assert!(c >= 5 && d == c, "Abbildung muss Bilddaten verändern ({d}/{c})");
        assert_eq!(out_def(&env)["transfer_characteristic"], "SDR");
        let svc = std::env::var("OMP_TEST_MAP_SERVICE").unwrap_or_default();
        if !svc.is_empty() {
            *sh.map_backend.lock().unwrap() = svc;
            run.handle.reconfigure();
            assert!(run.wait_state(true, "convert", 10));
            std::thread::sleep(Duration::from_secs(2));
            let (c2, d2) = diff(3);
            println!("transferMap Fremddienst: verglichen {c2}, abweichend {d2}");
            assert!(c2 >= 5 && d2 == c2);
            assert!(!sh.video.lock().unwrap().state.is_empty() && !sh.last_error.lock().unwrap().contains("Abbildungsdienst"), "kein Fehler vom Dienst erwartet");
        }
        let house2 = json(r#"{"video":{"width":320,"height":180,"rate":"25/1","scan":"progressive","colorspace":"BT709","transfer":"HLG"}}"#);
        *sh.house.lock().unwrap() = house2;
        run.handle.reconfigure();
        assert!(run.wait_state(true, "copy", 10), "gleiche Übertragungsfunktion → copy");
        assert!(sh.video.lock().unwrap().stages.is_empty());
        drop(run);
        let _ = pl.set_state(gst::State::Null);
        drop(out);
    }

    fn read_ch(rd: &mxl::SamplesReader, start: u64, len: usize, ch: usize) -> Option<Vec<f32>> {
        let d = rd.get_samples(start, len, Duration::from_millis(100)).map_err(|e| eprintln!("read_ch {start}+{len}: {e}")).ok()?;
        let (a, b) = d.channel_data(ch).map_err(|e| eprintln!("channel_data: {e}")).ok()?;
        Some(a.chunks_exact(4).chain(b.chunks_exact(4)).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect())
    }

    /// 106.5 Ton: stationäre Verzögerung ist **bitgleich** (Ausgang[i] == Eingang[i − d]), eine Änderung im Betrieb gleitet
    /// ohne Sprung (größte Differenz benachbarter Samples ≤ 1,5 × Theorie), und der Zielwert wird exakt erreicht.
    #[test]
    #[ignore = "braucht MXL-Laufzeit und etwas CPU: gezielt starten (--test-threads=1)"]
    fn live_avsync_audio_delay_exact_and_smooth() {
        let env = Env::new("avA");
        let (pl, out) = audio_source(&env, 48000);
        let house = json(r#"{"audio":{"sampleRate":48000,"channels":4}}"#);
        let run = Running::start(&env, house, AudioMap::default());
        let sh = run.handle.shared.clone();
        run.handle.connect_audio(SRC_A.into());
        assert!(run.wait_state(false, "copy", 10));
        std::thread::sleep(Duration::from_secs(1));
        let rin = env.ctx.instance().create_flow_reader(SRC_A).and_then(|r| r.to_samples_reader()).unwrap();
        let rout = env.ctx.instance().create_flow_reader(OUT_A).and_then(|r| r.to_samples_reader()).unwrap();
        let now = || env.ctx.ns_to_index(env.ctx.now_ns(), 48000, 1).unwrap();
        // Ohne Verzögerung: Ausgang == Eingang (Kanal 3 trägt den Sinus)
        let i0 = now() - 1800;
        let (a, b) = (read_ch(&rin, i0, 960, 2).unwrap(), read_ch(&rout, i0, 960, 2).unwrap());
        assert_eq!(a, b, "ohne Verzögerung muss der Ton bitgleich sein");
        // Stationäre Verzögerung 2880 Samples (60 ms), schnell gleiten lassen
        sh.avsync.lock().unwrap().max_slew_permille = 200.0;
        sh.delay.set_slew_permille(200.0);
        sh.delay.set_audio_delay_samples(2880.0);
        std::thread::sleep(Duration::from_secs(2));
        assert_eq!(sh.delay.audio_current_samples(), 2880.0, "Ziel muss exakt erreicht werden");
        let i1 = now() - 1800;
        let (a, b) = (read_ch(&rin, i1 - 2880, 960, 2).unwrap(), read_ch(&rout, i1, 960, 2).unwrap());
        assert_eq!(a, b, "stationäre Verzögerung muss bitgleich um 2880 Samples versetzt sein");
        assert!(a.iter().any(|v| v.abs() > 0.05), "Quelle hat Signal");
        // Änderung im Betrieb 2880 → 0 mit 50 ‰: kein Sprung. Ausgang fortlaufend mitlesen.
        sh.delay.set_slew_permille(50.0);
        sh.delay.set_audio_delay_samples(0.0);
        let mut idx = now() - 2400;
        let (mut maxdiff, mut prev, mut n, mut in_max) = (0f32, None::<f32>, 0usize, 0f32);
        let end = std::time::Instant::now() + Duration::from_millis(1800);
        while std::time::Instant::now() < end {
            if idx + 480 + 1200 < now() {
                if let Some(vi) = read_ch(&rin, idx, 480, 2) {
                    for w in vi.windows(2) {
                        in_max = in_max.max((w[1] - w[0]).abs());
                    }
                }
                if let Some(v) = read_ch(&rout, idx, 480, 2) {
                    for x in v {
                        if let Some(p) = prev {
                            maxdiff = maxdiff.max((x - p).abs());
                        }
                        prev = Some(x);
                        n += 1;
                    }
                    idx += 480;
                } else {
                    idx += 480;
                    prev = None;
                }
            } else {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        let theory = 0.1f32 * 2.0 * std::f32::consts::PI * 1000.0 / 48000.0;
        println!("Eingang größte Differenz (Quelle selbst): {in_max:.5}");
        println!("Ton-Gleiten: {n} Samples, größte Differenz {maxdiff:.5}, Theorie {theory:.5}, Verzögerung jetzt {}", sh.delay.audio_current_samples());
        assert!(n > 20000, "zu wenig Samples gelesen: {n}");
        assert!(maxdiff <= 1.5 * theory, "Sprung im Ton: {maxdiff} > 1,5 × {theory}");
        drop(run);
        let _ = pl.set_state(gst::State::Null);
        drop(out);
    }

    /// 106.5 Bild: Ausgang[i] == Eingang[i − k] bitgleich (lokaler Ring), `k` wird live geändert.
    #[test]
    #[ignore = "braucht MXL-Laufzeit und etwas CPU: gezielt starten (--test-threads=1)"]
    fn live_avsync_video_delay_whole_frames() {
        let env = Env::new("avV");
        let pl = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").property("is-live", true).property_from_str("pattern", "ball").build().unwrap();
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", gst::Caps::builder("video/x-raw").field("width", 320i32).field("height", 180i32).field("framerate", gst::Fraction::new(25, 1)).build())
            .build()
            .unwrap();
        pl.add_many([&src, &caps]).unwrap();
        gst::Element::link_many([&src, &caps]).unwrap();
        let out = MxlVideoOutput::new(&pl, &caps, env.ctx.clone(), SRC_V, "test-src", 320, 180, 25, 1, Arc::new(AtomicU64::new(0))).unwrap();
        out.set_active(true);
        pl.set_state(gst::State::Playing).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        let house = json(r#"{"video":{"width":320,"height":180,"rate":"25/1","scan":"progressive"}}"#);
        let run = Running::start(&env, house, AudioMap::default());
        let sh = run.handle.shared.clone();
        run.handle.connect_video(SRC_V.into());
        assert!(run.wait_state(true, "copy", 10));
        let rin = env.ctx.instance().create_flow_reader(SRC_V).and_then(|r| r.to_grain_reader()).unwrap();
        let rout = env.ctx.instance().create_flow_reader(OUT_V).and_then(|r| r.to_grain_reader()).unwrap();
        let check = |k: u64| -> (u32, u32) {
            let (mut same, mut total, mut last) = (0u32, 0u32, 0u64);
            let end = std::time::Instant::now() + Duration::from_secs(3);
            while std::time::Instant::now() < end {
                let idx = env.ctx.ns_to_index(env.ctx.now_ns(), 25, 1).unwrap() - 2;
                if idx != last {
                    last = idx;
                    if let (Ok(o), Ok(i)) = (rout.get_complete_grain(idx, Duration::from_millis(40)), rin.get_complete_grain(idx - k, Duration::from_millis(40)))
                        && o.index == idx
                        && i.index == idx - k
                    {
                        total += 1;
                        if o.payload[..] == i.payload[..] {
                            same += 1;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            (same, total)
        };
        let (s0, t0) = check(0);
        println!("Bild k=0: {s0}/{t0} bitgleich");
        assert!(t0 >= 5 && s0 == t0);
        sh.delay.set_video_frames(2);
        std::thread::sleep(Duration::from_millis(500));
        let (s2, t2) = check(2);
        println!("Bild k=2: {s2}/{t2} bitgleich zu Eingang[i−2]");
        assert!(t2 >= 5 && s2 == t2, "Bild muss um genau 2 Bilder verzögert sein ({s2}/{t2})");
        sh.delay.set_video_frames(0);
        std::thread::sleep(Duration::from_millis(500));
        let (s3, t3) = check(0);
        assert!(t3 >= 5 && s3 == t3, "zurück auf 0: bitgleich ({s3}/{t3})");
        drop(run);
        let _ = pl.set_state(gst::State::Null);
        drop(out);
    }

    /// 106.5 Ende zu Ende: Marker-Quelle (`omp-source`, Ton `OMP_TEST_AUDIO_OFFSET_MS` ms später) → Normalizer. Der
    /// gemessene Eingangsversatz wird mit `held_ms` übernommen; die Messung am **Ausgang** liegt danach ≤ 1 Bildperiode.
    /// Braucht `OMP_TEST_SOURCE_BIN` (Pfad zu `omp-source`).
    #[test]
    #[ignore = "braucht MXL-Laufzeit, omp-source (OMP_TEST_SOURCE_BIN) und etwas CPU (--test-threads=1)"]
    fn live_avsync_end_to_end_with_marker_source() {
        let bin = std::env::var("OMP_TEST_SOURCE_BIN").expect("OMP_TEST_SOURCE_BIN");
        let offset = std::env::var("OMP_TEST_AUDIO_OFFSET_MS").unwrap_or_else(|_| "80".into());
        let env = Env::new("avE");
        let mut child = std::process::Command::new(bin)
            .env("OMP_MXL_DOMAIN", &env.dir)
            .env("OMP_PORT", "9613")
            .env("OMP_SOURCE_PATTERN", "black")
            .env("OMP_SOURCE_VIDEO_MARKER", "1")
            .env("OMP_SOURCE_AUDIO_WAVE", "ticks")
            .env("OMP_SOURCE_AUDIO_OFFSET_MS", &offset)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("omp-source starten");
        std::thread::sleep(Duration::from_secs(5));
        let (mut vid, mut aid) = (String::new(), String::new());
        for e in std::fs::read_dir(&env.dir).unwrap().flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if let Some(id) = n.strip_suffix(".mxl-flow")
                && let Ok(def) = env.ctx.flow_def(id)
            {
                if def.contains("sample_rate") { aid = id.to_string() } else { vid = id.to_string() }
            }
        }
        assert!(!vid.is_empty() && !aid.is_empty(), "Quell-Flows nicht gefunden");
        let vd: serde_json::Value = serde_json::from_str(&env.ctx.flow_def(&vid).unwrap()).unwrap();
        let ad: serde_json::Value = serde_json::from_str(&env.ctx.flow_def(&aid).unwrap()).unwrap();
        let (w, h) = (vd["frame_width"].as_u64().unwrap(), vd["frame_height"].as_u64().unwrap());
        let rate = vd["grain_rate"]["numerator"].as_u64().unwrap();
        let (sr, ch) = (ad["sample_rate"]["numerator"].as_u64().unwrap(), ad["channel_count"].as_u64().unwrap());
        let house = json(&format!(r#"{{"video":{{"width":{w},"height":{h},"rate":"{rate}/1","scan":"progressive"}},"audio":{{"sampleRate":{sr},"channels":{ch}}}}}"#));
        let run = Running::start(&env, house, AudioMap::default());
        let sh = run.handle.shared.clone();
        run.handle.connect_video(vid.clone());
        run.handle.connect_audio(aid.clone());
        assert!(run.wait_state(true, "copy", 10) && run.wait_state(false, "copy", 10));
        let stop = AtomicBool::new(false);
        let measure = |v: &str, a: &str| -> f64 {
            let m = omp_mediaio::avmarker::measure(env.ctx.instance(), v, a, 9.0, 500.0, &stop).unwrap();
            let mut x = m.offsets_ms.clone();
            x.sort_by(|p, q| p.total_cmp(q));
            assert!(!x.is_empty(), "kein Marker erkannt");
            x[x.len() / 2]
        };
        let m_in = measure(&vid, &aid);
        println!("Eingang gemessen: {m_in:.1} ms (Ton-Versatz-Schalter {offset} ms)");
        // Übernehmen und schnell gleiten lassen
        {
            let mut a = sh.avsync.lock().unwrap();
            a.held_ms = Some(m_in);
            a.max_slew_permille = 200.0;
        }
        sh.delay.set_slew_permille(200.0);
        let applied = sh.recompute_avsync().unwrap();
        println!("angewendet: {applied:?}");
        std::thread::sleep(Duration::from_secs(3));
        let m_out = measure(OUT_V, OUT_A);
        println!("Ausgang gemessen: {m_out:.1} ms");
        let frame_ms = 1000.0 / rate as f64;
        assert!(m_out.abs() <= frame_ms, "Ausgang nach Ausgleich |{m_out}| > 1 Bildperiode");
        assert!(m_in.abs() > m_out.abs() || m_in.abs() < 10.0, "Ausgleich hat nichts verbessert");
        if applied.offset_ms == 0.0 {
            // Eigenanteil des Normalizers im Kopierpfad: höchstens 5 ms früh / 15 ms spät (EBU R 37, je Stufe)
            let own = m_out - m_in; // positiv = Ton früher geworden
            println!("Eigenanteil des Kopierpfads: {own:.2} ms");
            assert!((-15.0..=5.0).contains(&own), "Eigenanteil {own} ms außerhalb +5/−15 ms");
        }
        let _ = child.kill();
        let _ = child.wait();
        drop(run);
    }

    /// 4-Kanal-Quelle: 1-kHz-Sinus nur auf Kanal 3 (≈ −20 dBFS), die anderen Kanäle still. Die Verteilung auf vier Kanäle
    /// macht hier `audiomixmatrix` (Mono → 4 Kanäle, nur Zeile 3 = 1).
    fn audio_source(env: &Env, rate: i32) -> (gst::Pipeline, MxlAudioOutput) {
        let pl = gst::Pipeline::new();
        let src = gst::ElementFactory::make("audiotestsrc").property("is-live", true).property("freq", 1000.0f64).property("volume", 0.1f64).build().unwrap();
        let conv = gst::ElementFactory::make("audioconvert").build().unwrap();
        let mono = gst::ElementFactory::make("capsfilter")
            .property("caps", gst::Caps::builder("audio/x-raw").field("rate", rate).field("channels", 1i32).build())
            .build()
            .unwrap();
        let mix = gst::ElementFactory::make("audiomixmatrix").build().unwrap();
        mix.set_property("in-channels", 1u32);
        mix.set_property("out-channels", 4u32);
        mix.set_property_from_str("mode", "manual");
        let rows: Vec<gst::glib::SendValue> = [0.0f64, 0.0, 1.0, 0.0].iter().map(|v| gst::Array::new([*v]).to_send_value()).collect();
        mix.set_property("matrix", gst::Array::from_values(rows));
        let four = gst::ElementFactory::make("capsfilter")
            .property("caps", gst::Caps::builder("audio/x-raw").field("rate", rate).field("channels", 4i32).field("channel-mask", gst::Bitmask::new(0)).build())
            .build()
            .unwrap();
        let q = gst::ElementFactory::make("queue").build().unwrap();
        pl.add_many([&src, &conv, &mono, &mix, &four, &q]).unwrap();
        gst::Element::link_many([&src, &conv, &mono, &mix, &four, &q]).unwrap();
        let out = MxlAudioOutput::new(&pl, &q, env.ctx.clone(), SRC_A, "test-audio", rate as u32, 4).unwrap();
        out.set_active(true);
        pl.set_state(gst::State::Playing).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        (pl, out)
    }

    /// Mittlerer RMS-Pegel je Kanal (dBFS) des Ausgangs-Tonflows über ~2 s.
    fn measure_levels(env: &Env, flow: &str) -> Vec<f64> {
        let pl = gst::Pipeline::new();
        let input = MxlAudioInput::new(&pl, env.ctx.clone(), flow).unwrap();
        let level = gst::ElementFactory::make("level").property("interval", 200_000_000u64).property("post-messages", true).build().unwrap();
        let sink = gst::ElementFactory::make("fakesink").property("sync", false).property("async", false).build().unwrap();
        pl.add_many([&level, &sink]).unwrap();
        input.tail.link(&level).unwrap();
        level.link(&sink).unwrap();
        pl.set_state(gst::State::Playing).unwrap();
        let bus = pl.bus().unwrap();
        let end = std::time::Instant::now() + Duration::from_secs(3);
        let mut acc: Vec<Vec<f64>> = vec![];
        while std::time::Instant::now() < end {
            if let Some(m) = bus.timed_pop_filtered(gst::ClockTime::from_mseconds(200), &[gst::MessageType::Element])
                && let Some(st) = m.structure()
                && st.name() == "level"
                && let Ok(rms) = st.get::<gst::glib::ValueArray>("rms")
            {
                acc.push(rms.iter().filter_map(|v| v.get::<f64>().ok()).collect());
            }
        }
        let _ = pl.set_state(gst::State::Null);
        drop(input);
        let n = acc.len().max(1);
        let ch = acc.last().map(|v| v.len()).unwrap_or(0);
        // die ersten Messungen verwerfen (Einschwingen)
        let skip = (acc.len() / 3).min(acc.len().saturating_sub(1));
        let rest = &acc[skip..];
        (0..ch).map(|c| rest.iter().map(|v| v[c]).sum::<f64>() / rest.len().max(1) as f64).collect::<Vec<_>>().into_iter().inspect(|_| { let _ = n; }).collect()
    }

    #[test]
    #[ignore = "braucht MXL-Laufzeit und etwas CPU: gezielt starten"]
    fn live_stage_audio_map_and_resample() {
        let env = Env::new("au");
        eprintln!("T: Quelle starten");
        let (pl, out) = audio_source(&env, 48000);
        eprintln!("T: Quelle läuft, messe");
        let before = measure_levels(&env, SRC_A);
        println!("Quelle (dBFS je Kanal): {before:?}");
        assert!(before.len() == 4 && before[2] > -30.0 && before[0] < -80.0, "Testquelle: Ton nur auf Kanal 3");
        let house = json(r#"{"audio":{"sampleRate":48000,"channels":2}}"#);
        let map = AudioMap::from_json(r#"{"outputs":[{"out":1,"in":3}]}"#).unwrap();
        let run = Running::start(&env, house, map);
        run.handle.connect_audio(SRC_A.into());
        assert!(run.wait_state(false, "convert", 10), "state=convert erwartet");
        assert_eq!(run.handle.shared.audio.lock().unwrap().stages, vec!["channelMap".to_string()]);
        std::thread::sleep(Duration::from_secs(1));
        let after = measure_levels(&env, OUT_A);
        println!("Ausgang (dBFS je Kanal): {after:?}");
        assert_eq!(after.len(), 2);
        assert!((after[0] - before[2]).abs() < 0.5, "Kanal 3 → Hauskanal 1, Pegel ± 0,5 dB: {} gegen {}", after[0], before[2]);
        assert!(after[1] < -80.0, "Hauskanal 2 muss still sein: {}", after[1]);
        drop(run);
        let _ = pl.set_state(gst::State::Null);
        drop(out);
    }

    #[test]
    #[ignore = "braucht MXL-Laufzeit und etwas CPU: gezielt starten"]
    fn live_stage_audio_resample_only_when_needed() {
        // 44,1 kHz → Haus 48 kHz: nur die Stufe resample, Pegel bleibt.
        let env = Env::new("rs");
        let (pl, out) = audio_source(&env, 44100);
        let house = json(r#"{"audio":{"sampleRate":48000,"channels":4}}"#);
        let run = Running::start(&env, house, AudioMap::default());
        run.handle.connect_audio(SRC_A.into());
        assert!(run.wait_state(false, "convert", 10), "state=convert erwartet");
        assert_eq!(run.handle.shared.audio.lock().unwrap().stages, vec!["resample".to_string()]);
        std::thread::sleep(Duration::from_secs(1));
        let d: serde_json::Value = serde_json::from_str(&env.ctx.flow_def(OUT_A).unwrap()).unwrap();
        assert_eq!(d["sample_rate"]["numerator"], 48000, "{d}");
        let after = measure_levels(&env, OUT_A);
        println!("Ausgang (dBFS je Kanal): {after:?}");
        assert!((after[2] - -23.0).abs() < 1.0 && after[0] < -80.0, "Ton bleibt auf Kanal 3: {after:?}");
        drop(run);
        let _ = pl.set_state(gst::State::Null);
        drop(out);

        // Gleiches Format → Kopie, keine Stufe (Negativtest).
        let env = Env::new("rs2");
        let (pl, out) = audio_source(&env, 48000);
        let house = json(r#"{"audio":{"sampleRate":48000,"channels":4}}"#);
        let run = Running::start(&env, house, AudioMap::default());
        run.handle.connect_audio(SRC_A.into());
        assert!(run.wait_state(false, "copy", 10), "state=copy erwartet");
        assert!(run.handle.shared.audio.lock().unwrap().stages.is_empty());
        drop(run);
        let _ = pl.set_state(gst::State::Null);
        drop(out);
    }
}
