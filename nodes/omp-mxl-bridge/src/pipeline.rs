//! Pipeline von `omp-mxl-bridge` (Kap. 103, Entwurf D5): liest je einen per IS-05 gewählten Video- und Audio-Flow aus der
//! EIGENEN MXL-Domain des Nodes (`OMP_MXL_DOMAIN`, Eingang) und schreibt sie als neue Flows in die ZIELDOMAIN
//! (`OMP_MXL_TARGET_DOMAIN`, Ausgang). Das ist der einzige Ort, an dem zwei Domains absichtlich zusammenkommen.
//!
//! **Die Brücke wandelt nicht.** Sie kopiert die Grains/Samples unverändert (`omp_mediaio::rawcopy`, kein GStreamer, eine
//! Speicherkopie je Bild bzw. 10 ms Ton; Grain-Index und damit der Bild/Ton-Bezug bleiben erhalten). Passt das Format der
//! Quelle nicht zum Format der Brücke (Größe, Bildrate, Abtastrate, Kanalzahl), lehnt sie die Verbindung mit einer klaren
//! Meldung ab — Anpassen ist Aufgabe eines Scalers VOR der Brücke (wie innerhalb einer Domain auch). Nur auf ausdrücklichen
//! Wunsch (`OMP_BRIDGE_CONVERT=1`, Standard aus) fällt sie auf die rechenintensive Wandlungskette zurück
//! (`MxlVideoInput → MxlVideoOutput`, `MxlAudioInput → MxlAudioOutput`).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext, MxlVideoInput, MxlVideoOutput};
use omp_mediaio::domainwatch::DomainWatch;
use omp_mediaio::rawcopy::{
    AudioFormat, RawAudioCopy, RawVideoCopy, VideoFormat, check_audio_passthrough, check_passthrough,
};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub const SAMPLE_RATE: u32 = 48000;

pub struct Config {
    /// Eingangsdomain (die Domain des Nodes).
    pub in_domain: String,
    /// Zieldomain der geschriebenen Flows.
    pub out_domain: String,
    pub video_flow_id: String,
    pub audio_flow_id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub framerate_numerator: u32,
    pub framerate_denominator: u32,
    pub audio_channels: u32,
    /// Optional: bei abweichendem Quellformat wandeln statt ablehnen (viel CPU). Standard aus.
    pub convert: bool,
    pub rate_mode: omp_mediaio::framerate::RateMode,
}

pub enum Event {
    Error(String),
}

enum Command {
    /// Im Eingangs-Domain-Verzeichnis wurde ein Flow angelegt oder entfernt (inotify) — offene Verbindungen erneut versuchen.
    DomainChanged,
    /// Ein Kopierer hat seine Quelle verloren (kein Grain seit 3 s) — Zweig neu aufbauen.
    SourceLost,
    ConnectVideo(String),
    DisconnectVideo,
    ConnectAudio(String),
    DisconnectAudio,
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    video_flowed: Arc<AtomicBool>,
    audio_flowed: Arc<AtomicBool>,
    /// "pass-through" (Grains werden direkt kopiert) oder "Wandlung: <Grund>" (GStreamer-Kette) — nur Anzeige.
    video_mode: Arc<std::sync::Mutex<String>>,
    audio_mode: Arc<std::sync::Mutex<String>>,
}

impl PipelineHandle {
    pub fn connect_video(&self, flow_id: String) {
        self.video_flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::ConnectVideo(flow_id));
    }
    pub fn disconnect_video(&self) {
        self.video_flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::DisconnectVideo);
    }
    pub fn connect_audio(&self, flow_id: String) {
        self.audio_flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::ConnectAudio(flow_id));
    }
    pub fn disconnect_audio(&self) {
        self.audio_flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::DisconnectAudio);
    }
    /// Ob in der verbundenen Quelle mindestens ein Bild floss (media-ready).
    pub fn media_ready(&self) -> bool {
        self.video_flowed.load(Ordering::Relaxed)
    }
    pub fn audio_flowed(&self) -> bool {
        self.audio_flowed.load(Ordering::Relaxed)
    }
    pub fn video_mode(&self) -> String {
        self.video_mode.lock().expect("lock poisoned").clone()
    }
    pub fn audio_mode(&self) -> String {
        self.audio_mode.lock().expect("lock poisoned").clone()
    }
}

struct ActiveVideo {
    pipeline: gst::Pipeline,
    _input: MxlVideoInput,
    _output: MxlVideoOutput,
}

impl Drop for ActiveVideo {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Der Videozweig: direkter Grain-Kopierer (Quelle = Zielformat) oder die Wandlungskette.
enum VideoBranch {
    #[allow(dead_code)] // gehalten, damit Drop die Pipeline beendet
    Gst(ActiveVideo),
    Raw(RawVideoCopy),
}

impl VideoBranch {
    fn is_dead(&self) -> bool {
        matches!(self, VideoBranch::Raw(r) if r.is_dead())
    }
}

/// Präfix permanenter Fehler (Format passt nicht): kein erneuter Versuch, bis die Verbindung geändert wird.
const FORMAT_ERR: &str = "FORMAT: ";

/// Baut den Videozweig: Format passt → direkt kopieren; sonst ablehnen (Standard) oder — nur mit `convert` — wandeln.
fn connect_video(
    in_ctx: &Arc<MxlContext>,
    out_ctx: &Arc<MxlContext>,
    source_flow_id: &str,
    config: &Config,
    flowed: Arc<AtomicBool>,
    mode: &Arc<std::sync::Mutex<String>>,
    wake: &Arc<dyn Fn() + Send + Sync>,
) -> Result<VideoBranch, String> {
    let target = VideoFormat {
        width: config.width,
        height: config.height,
        rate_num: config.framerate_numerator,
        rate_den: config.framerate_denominator,
    };
    let set_mode = |m: String| *mode.lock().expect("lock poisoned") = m;
    let why = match in_ctx.flow_def(source_flow_id).map_err(|e| e.to_string()).and_then(|d| check_passthrough(&d, target)) {
        Ok(def) => match RawVideoCopy::start(
            in_ctx.clone(),
            out_ctx.clone(),
            source_flow_id,
            def,
            &config.video_flow_id,
            &config.label,
            target,
            flowed.clone(),
            wake.clone(),
        ) {
            Ok(rc) => {
                set_mode("direkt kopiert".to_string());
                return Ok(VideoBranch::Raw(rc));
            }
            Err(e) => return Err(format!("Kopierer: {e}")),
        },
        Err(why) => why,
    };
    if config.convert {
        eprintln!("omp-mxl-bridge: Video wird gewandelt (OMP_BRIDGE_CONVERT=1; {why}) — das braucht viel CPU");
        set_mode(format!("gewandelt (optional): {why}"));
        return build_video(in_ctx, out_ctx, source_flow_id, config, flowed).map(VideoBranch::Gst);
    }
    set_mode(format!("abgelehnt: {why}"));
    Err(format!(
        "{FORMAT_ERR}Video-Quelle passt nicht zur Brücke ({why}). Die Brücke wandelt nicht: einen Scaler vor die Brücke \
         schalten oder das Format der Brücke an die Quelle anpassen."
    ))
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
    #[allow(dead_code)] // gehalten, damit Drop die Pipeline beendet
    Gst(ActiveAudio),
    Raw(RawAudioCopy),
}

impl AudioBranch {
    fn is_dead(&self) -> bool {
        matches!(self, AudioBranch::Raw(r) if r.is_dead())
    }
}

fn connect_audio(
    in_ctx: &Arc<MxlContext>,
    out_ctx: &Arc<MxlContext>,
    source_flow_id: &str,
    config: &Config,
    flowed: Arc<AtomicBool>,
    mode: &Arc<std::sync::Mutex<String>>,
    wake: &Arc<dyn Fn() + Send + Sync>,
) -> Result<AudioBranch, String> {
    let target = AudioFormat { sample_rate: SAMPLE_RATE, channels: config.audio_channels };
    let set_mode = |m: String| *mode.lock().expect("lock poisoned") = m;
    let why = match in_ctx.flow_def(source_flow_id).map_err(|e| e.to_string()).and_then(|d| check_audio_passthrough(&d, target)) {
        Ok(def) => match RawAudioCopy::start(
            in_ctx.clone(),
            out_ctx.clone(),
            source_flow_id,
            def,
            &config.audio_flow_id,
            &config.label,
            target,
            flowed.clone(),
            wake.clone(),
        ) {
            Ok(rc) => {
                set_mode("direkt kopiert".to_string());
                return Ok(AudioBranch::Raw(rc));
            }
            Err(e) => return Err(format!("Kopierer: {e}")),
        },
        Err(why) => why,
    };
    if config.convert {
        eprintln!("omp-mxl-bridge: Ton wird gewandelt (OMP_BRIDGE_CONVERT=1; {why})");
        set_mode(format!("gewandelt (optional): {why}"));
        return build_audio(in_ctx, out_ctx, source_flow_id, config, flowed).map(AudioBranch::Gst);
    }
    set_mode(format!("abgelehnt: {why}"));
    Err(format!(
        "{FORMAT_ERR}Ton-Quelle passt nicht zur Brücke ({why}). Die Brücke wandelt nicht: die Quelle auf {} Hz / {} Kanäle \
         bringen oder OMP_AUDIO_CHANNELS der Brücke anpassen.",
        SAMPLE_RATE, config.audio_channels
    ))
}

fn queue() -> Result<gst::Element, String> {
    gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue: {e}"))
}

fn build_video(
    in_ctx: &Arc<MxlContext>,
    out_ctx: &Arc<MxlContext>,
    source_flow_id: &str,
    config: &Config,
    flowed: Arc<AtomicBool>,
) -> Result<ActiveVideo, String> {
    let pipeline = gst::Pipeline::new();
    {
        let diag = pipeline.clone();
        omp_node_sdk::diag::register(
            "video",
            Arc::new(move || omp_mediaio::diag::snapshot(&diag)),
        );
    }
    let input = MxlVideoInput::new(&pipeline, in_ctx.clone(), source_flow_id)?;
    let q = queue()?;
    pipeline.add(&q).map_err(|e| format!("add queue: {e}"))?;
    gst::Element::link_many([&input.tail, &q]).map_err(|e| format!("link input to queue: {e}"))?;
    let rate_mode = if omp_mediaio::framerate::same_rate(
        input.framerate_numerator,
        input.framerate_denominator,
        config.framerate_numerator,
        config.framerate_denominator,
    ) {
        omp_mediaio::framerate::RateMode::Videorate
    } else {
        config.rate_mode
    };
    let output = MxlVideoOutput::new_with_rate_mode(
        &pipeline,
        &q,
        out_ctx.clone(), // Ausgang in der ZIELDOMAIN
        &config.video_flow_id,
        &config.label,
        config.width,
        config.height,
        config.framerate_numerator,
        config.framerate_denominator,
        Arc::new(AtomicU64::new(0)),
        rate_mode,
    )
    .map_err(|e| format!("MxlVideoOutput: {e}"))?;
    output.set_active(true);
    let probe = flowed;
    let pad = input
        .tail
        .static_pad("src")
        .ok_or("input tail ohne src-Pad")?;
    pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Remove
    });
    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;
    Ok(ActiveVideo {
        pipeline,
        _input: input,
        _output: output,
    })
}

fn build_audio(
    in_ctx: &Arc<MxlContext>,
    out_ctx: &Arc<MxlContext>,
    source_flow_id: &str,
    config: &Config,
    flowed: Arc<AtomicBool>,
) -> Result<ActiveAudio, String> {
    let pipeline = gst::Pipeline::new();
    {
        let diag = pipeline.clone();
        omp_node_sdk::diag::register(
            "audio",
            Arc::new(move || omp_mediaio::diag::snapshot(&diag)),
        );
    }
    let input = MxlAudioInput::new(&pipeline, in_ctx.clone(), source_flow_id)?;
    let q = queue()?;
    pipeline.add(&q).map_err(|e| format!("add queue: {e}"))?;
    gst::Element::link_many([&input.tail, &q]).map_err(|e| format!("link input to queue: {e}"))?;
    let output = MxlAudioOutput::new(
        &pipeline,
        &q,
        out_ctx.clone(), // Ausgang in der ZIELDOMAIN
        &config.audio_flow_id,
        &config.label,
        SAMPLE_RATE,
        config.audio_channels,
    )
    .map_err(|e| format!("MxlAudioOutput: {e}"))?;
    output.set_active(true);
    let probe = flowed;
    let pad = input
        .tail
        .static_pad("src")
        .ok_or("input tail ohne src-Pad")?;
    pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Remove
    });
    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;
    Ok(ActiveAudio {
        pipeline,
        _input: input,
        _output: output,
    })
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
    let in_ctx = match MxlContext::new(&config.in_domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };
    let out_ctx = if config.out_domain == config.in_domain {
        in_ctx.clone()
    } else {
        match MxlContext::new(&config.out_domain) {
            Ok(c) => Arc::new(c),
            Err(e) => {
                let msg = format!("Zieldomain {}: {e}", config.out_domain);
                let _ = tx.send(Event::Error(msg.clone()));
                let _ = ready.send(Err(msg));
                return;
            }
        }
    };

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) =
        std::sync::mpsc::channel();
    let video_flowed = Arc::new(AtomicBool::new(false));
    let audio_flowed = Arc::new(AtomicBool::new(false));
    let video_mode = Arc::new(std::sync::Mutex::new(String::new()));
    let audio_mode = Arc::new(std::sync::Mutex::new(String::new()));
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx.clone(),
        video_flowed: video_flowed.clone(),
        audio_flowed: audio_flowed.clone(),
        video_mode: video_mode.clone(),
        audio_mode: audio_mode.clone(),
    }));

    // Ereignisse statt Nachsehen im Takt: ein inotify-Beobachter weckt die Schleife, wenn im Eingangs-Domainverzeichnis ein Flow
    // erscheint oder verschwindet; die Kopierer wecken sie, wenn ihre Quelle verloren geht. Dazwischen schläft sie (nur ein
    // 2-s-Herzschlag für die Liveness-Überwachung des Node-SDK).
    let wake: Arc<dyn Fn() + Send + Sync> = {
        let tx = commands_tx.clone();
        let m = std::sync::Mutex::new(());
        Arc::new(move || {
            let _g = m.lock();
            let _ = tx.send(Command::SourceLost);
        })
    };
    let watcher = match DomainWatch::new(std::path::Path::new(&config.in_domain)) {
        Ok(w) => {
            let tx = commands_tx.clone();
            let stop = shutdown.clone();
            Some(std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    // Blockiert im Kernel bis zu einer Änderung; die Sekunde ist nur die Stopp-Prüfung.
                    if w.wait(Some(Duration::from_secs(1))) && tx.send(Command::DomainChanged).is_err() {
                        break;
                    }
                }
            }))
        }
        Err(e) => {
            eprintln!("omp-mxl-bridge: Domain {} nicht beobachtbar ({e}) — Quellen, die später erscheinen, werden nicht automatisch erkannt", config.in_domain);
            None
        }
    };
    let mut video: Option<VideoBranch> = None;
    let mut audio: Option<AudioBranch> = None;
    let mut last_audio: Option<String> = None;
    let mut retry_video: Option<String> = None;
    let mut last_video: Option<String> = None; // zuletzt gewählte Videoquelle (für den Neuaufbau eines gestorbenen Kopierers)
    let mut retry_audio: Option<String> = None;
    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Command::ConnectVideo(id)) => {
                last_video = Some(id.clone());
                video = None;
                match connect_video(&in_ctx, &out_ctx, &id, &config, video_flowed.clone(), &video_mode, &wake) {
                    Ok(p) => {
                        video = Some(p);
                        retry_video = None;
                    }
                    Err(e) => {
                        // Formatfehler sind endgültig (kein Dauer-Neuversuch), alles andere wird wiederholt.
                        retry_video = (!e.starts_with(FORMAT_ERR)).then(|| id.clone());
                        let _ = tx.send(Event::Error(e.trim_start_matches(FORMAT_ERR).to_string()));
                    }
                }
            }
            Ok(Command::DisconnectVideo) => {
                video = None;
                retry_video = None;
                last_video = None;
                video_mode.lock().expect("lock poisoned").clear();
            }
            Ok(Command::ConnectAudio(id)) => {
                last_audio = Some(id.clone());
                audio = None;
                match connect_audio(&in_ctx, &out_ctx, &id, &config, audio_flowed.clone(), &audio_mode, &wake) {
                    Ok(p) => {
                        audio = Some(p);
                        retry_audio = None;
                    }
                    Err(e) => {
                        retry_audio = (!e.starts_with(FORMAT_ERR)).then(|| id.clone());
                        let _ = tx.send(Event::Error(e.trim_start_matches(FORMAT_ERR).to_string()));
                    }
                }
            }
            Ok(Command::DisconnectAudio) => {
                audio = None;
                retry_audio = None;
                last_audio = None;
                audio_mode.lock().expect("lock poisoned").clear();
            }
            // Quelle verloren: nur den Zweig abbauen und merken. KEIN sofortiger neuer Versuch — die Flow-Datei eines beendeten
            // Schreibers bleibt liegen, ein Neuöffnen würde nach 3 s wieder scheitern (verstecktes Polling im 3-s-Takt). Der
            // nächste Versuch kommt erst, wenn sich im Domainverzeichnis etwas ändert (Flow neu angelegt/ersetzt).
            Ok(Command::SourceLost) => {
                // Ein Kopierer, dessen Quelle verschwand (neu angelegt/gestoppt), baut sich neu auf.
                if video.as_ref().is_some_and(VideoBranch::is_dead) {
                    eprintln!("omp-mxl-bridge: Videoquelle liefert keine Bilder mehr — verbinde neu");
                    video = None;
                    video_flowed.store(false, Ordering::Relaxed);
                    retry_video = last_video.clone();
                }
                if audio.as_ref().is_some_and(AudioBranch::is_dead) {
                    eprintln!("omp-mxl-bridge: Tonquelle liefert nichts mehr — verbinde neu");
                    audio = None;
                    audio_flowed.store(false, Ordering::Relaxed);
                    retry_audio = last_audio.clone();
                }
}
            // Ein Flow wurde angelegt oder entfernt: offene Verbindungen erneut versuchen (inotify, kein Nachsehen im Takt).
            Ok(Command::DomainChanged) => {
                // Ein Kopierer, dessen Quelle verschwand (neu angelegt/gestoppt), baut sich neu auf.
                if video.as_ref().is_some_and(VideoBranch::is_dead) {
                    eprintln!("omp-mxl-bridge: Videoquelle liefert keine Bilder mehr — verbinde neu");
                    video = None;
                    video_flowed.store(false, Ordering::Relaxed);
                    retry_video = last_video.clone();
                }
                if audio.as_ref().is_some_and(AudioBranch::is_dead) {
                    eprintln!("omp-mxl-bridge: Tonquelle liefert nichts mehr — verbinde neu");
                    audio = None;
                    audio_flowed.store(false, Ordering::Relaxed);
                    retry_audio = last_audio.clone();
                }
                // Die Quelle erscheint evtl. erst später in der Eingangsdomain (Start-Reihenfolge) — erneut versuchen.
                if video.is_none()
                    && let Some(id) = retry_video.clone()
                    && let Ok(p) = connect_video(&in_ctx, &out_ctx, &id, &config, video_flowed.clone(), &video_mode, &wake)
                {
                    video = Some(p);
                    retry_video = None;
                }
                if audio.is_none()
                    && let Some(id) = retry_audio.clone()
                    && let Ok(p) = connect_audio(&in_ctx, &out_ctx, &id, &config, audio_flowed.clone(), &audio_mode, &wake)
                {
                    audio = Some(p);
                    retry_audio = None;
                }
            }
            // Nur der Herzschlag (Schleifenanfang): nichts zu tun, kein Nachsehen.
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(video);
    drop(audio);
    if let Some(w) = watcher {
        let _ = w.join();
    }
}
