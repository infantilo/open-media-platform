//! Dynamische Audio-Eingänge für Pegelanzeigen (2026-08-06,
//! Nutzerwunsch: "der viewer ... dynamische anzahl an eingängen damit
//! ich zb den mxf player hinrouten kann und alle gruppen sehe") — der
//! Viewer bleibt video-fokussiert (MJPEG-Vorschau, `pipeline.rs`,
//! unverändert), diese Audio-Eingänge liefern bewusst **kein** Audio in
//! den Browser (das leistet der redesignte `omp-audio-monitor`), nur
//! `<omp-meter>`-Pegelwerte.
//!
//! **Eigene, dauerhaft laufende Pipeline statt Teil von `pipeline.rs`s
//! Video-Pipeline:** `pipeline.rs`s `run()`-Schleife baut bei JEDEM
//! Video-Quellwechsel die komplette Pipeline neu auf (`active = None`,
//! s. dortige Moduldoku) — ein audio-Meter-Zweig dort würde bei jedem
//! Video-Reconnect mitsterben, obwohl er unabhängig davon leben soll
//! (ein Operator kann Video und Audio-Eingänge unabhängig voneinander
//! verbinden/trennen). Diese Pipeline wird stattdessen EINMAL gebaut und
//! bleibt PLAYING; einzelne Audio-Zweige werden chirurgisch an-/abgebaut
//! (exakt `omp-audio-mixer::pipeline`s `addChannel`/`removeChannel`-
//! Muster für `MxlAudioInput`, s. dortige Moduldoku "Dynamische
//! Kanalzahl ohne Pipeline-Rebuild" — hier 1:1 auf Empfänger statt
//! Kanäle übertragen).
//!
//! Jeder Zweig: `MxlAudioInput -> level -> appsink` (kein tatsächlicher
//! Audio-Output nötig, nur die `level`-Bus-Message zählt — `appsink`
//! statt `fakesink`, s. `build_branch`-Kommentar für den live gefundenen
//! Grund). Alle Zweige
//! teilen sich EINEN `/levels`-SSE-Broadcaster (`omp_mediaio::levels`,
//! identisches Muster zu `omp-audio-mixer`: ein Strom, Nachrichten nach
//! `inputId` markiert statt eines Ports pro Eingang — vermeidet, dass
//! das UI-Bundle bei jedem `addAudioInput`/`removeAudioInput` neu
//! verkabeln müsste, s. `main.rs`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver as MpscReceiver, Sender as MpscSender};
use std::sync::Arc;
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use omp_mediaio::levels::parse_level_message;
use omp_mediaio::mxl::{MxlAudioInput, MxlContext};
use tokio::sync::mpsc::UnboundedSender;

const LEVEL_INTERVAL_NS: u64 = 50_000_000;

pub struct LevelEvent {
    pub input_id: String,
    pub rms: f64,
    pub peak: f64,
}

enum Command {
    AddInput { input_id: String, flow_id: String },
    RemoveInput { input_id: String },
}

#[derive(Clone)]
pub struct AudioMeterHandle {
    commands: MpscSender<Command>,
}

impl AudioMeterHandle {
    pub fn add_input(&self, input_id: String, flow_id: String) {
        let _ = self.commands.send(Command::AddInput { input_id, flow_id });
    }

    pub fn remove_input(&self, input_id: String) {
        let _ = self.commands.send(Command::RemoveInput { input_id });
    }
}

struct Branch {
    elements: Vec<gst::Element>,
}

fn teardown_branch(pipeline: &gst::Pipeline, branch: Branch) {
    for el in &branch.elements {
        let _ = el.set_state(gst::State::Null);
    }
    for el in &branch.elements {
        let _ = pipeline.remove(el);
    }
}

fn build_branch(pipeline: &gst::Pipeline, context: &Arc<MxlContext>, flow_id: &str, input_id: &str) -> Result<Branch, String> {
    let input = MxlAudioInput::new(pipeline, context.clone(), flow_id)?;
    let level = gst::ElementFactory::make("level")
        .name(format!("level-{input_id}"))
        .property("interval", LEVEL_INTERVAL_NS)
        .build()
        .map_err(|e| format!("level ({input_id}): {e}"))?;
    // `appsink` statt `fakesink` (live gefunden — s. Nachtrag in
    // `docs/decisions.md`): jeder andere Live-MXL-Audio-Konsumzweig in
    // diesem Codebase (`audio_stream.rs`/`pcm_stream.rs`s MP3/PCM-
    // Zweige) endet auf einem `appsink` mit `sync=false`, nie auf einem
    // `fakesink` — hier zunächst (falsch) angenommen, ein reiner Mess-
    // Sink ohne echten Konsumzweck bräuchte keinen `appsink`, sei mit
    // `fakesink` einfacher. Live reproduzierbar: mit `fakesink` blieb
    // der MXL-Reader-Thread dauerhaft in `futex_wait` hängen (bestätigt
    // per `/proc/<pid>/task/*/wchan`, kein GDB im Container verfügbar),
    // nie ein einziges `level`-Bus-Message. Nach Wechsel auf `appsink`
    // (mit No-Op-`new_sample`-Callback, da nur die `level`-Bus-Message
    // gebraucht wird) lief derselbe Zweig sofort wie erwartet.
    let sink = gst::ElementFactory::make("appsink")
        .property("sync", false)
        .property("async", false)
        .property("max-buffers", 8u32)
        .property("drop", true)
        .build()
        .map_err(|e| format!("appsink ({input_id}): {e}"))?;
    let app_sink: gst_app::AppSink = sink
        .clone()
        .dynamic_cast()
        .map_err(|_| format!("appsink ({input_id}): cast to AppSink failed"))?;
    app_sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(|sink| {
                // Nur die `level`-Bus-Message wird gebraucht — Buffer
                // sofort verwerfen (`pull_sample` reicht zum Abholen,
                // kein Weiterverarbeiten nötig).
                let _ = sink.pull_sample();
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    pipeline
        .add(&level)
        .and_then(|()| pipeline.add(&sink))
        .map_err(|e| format!("add meter branch ({input_id}): {e}"))?;
    gst::Element::link_many([&input.tail, &level, &sink]).map_err(|e| format!("link meter branch ({input_id}): {e}"))?;

    for el in [&level, &sink] {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync_state_with_parent (meter {input_id}): {e}"))?;
    }

    // `MxlAudioInput` selbst besteht aus `appsrc`+`audioconvert` (bereits
    // beim Konstruktor auf den Pipeline-Zustand synchronisiert, s.
    // dortige Doku) — dessen Elemente hier mit einsammeln, damit
    // `teardown_branch` sie mit abbaut (sonst Leck bei jedem
    // `removeAudioInput`).
    let mut elements = input.elements.clone();
    elements.push(level);
    elements.push(sink);

    Ok(Branch { elements })
}

/// Läuft auf einem eigenen Thread (analog `pipeline::run`): baut die
/// gemeinsame Meter-Pipeline einmal, hält sie PLAYING, verarbeitet
/// Add-/Remove-Kommandos und pollt `level`-Bus-Messages nicht-blockierend
/// (identisches Muster zu `omp-audio-mixer::pipeline::run`).
pub fn run(
    domain: String,
    tx: UnboundedSender<LevelEvent>,
    shutdown: Arc<AtomicBool>,
    ready: tokio::sync::oneshot::Sender<Result<AudioMeterHandle, String>>,
) {
    if gst::init().is_err() {
        let _ = ready.send(Err("gst init failed (audio meters)".to_string()));
        return;
    }
    let context = match MxlContext::new(&domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };

    // Bewusst NICHT hier schon auf PLAYING gesetzt (anders als der
    // ursprüngliche Ansatz, live als Bug gefunden): jeder andere Node in
    // diesem Codebase (`omp-audio-mixer::pipeline::build`, `omp-audio-
    // monitor::pipeline::build`) baut erst die ANFÄNGLICHEN Elemente in
    // die Pipeline ein und setzt sie DANACH einmalig auf PLAYING — nie
    // umgekehrt. Eine komplett LEERE Pipeline zuerst auf PLAYING zu
    // setzen und danach den ersten Zweig dynamisch anzubauen sah nach
    // `gst_element_set_state()`-Doku äquivalent aus (`sync_state_with_
    // parent()` je Element sollte reichen), hing aber live reproduzierbar:
    // Pipeline blieb bei PAUSED (bestätigt per `pipeline.state()`,
    // `GST_DEBUG=GST_STATES`, `/proc/<pid>/task/*/wchan` — kein GDB im
    // Container verfügbar), der MXL-Reader-Thread kam nie über seinen
    // allerersten `get_current_index()`-Aufruf hinaus. Fix: wie überall
    // sonst im Codebase — erste Elemente rein, DANN einmalig PLAYING;
    // erst ab dem zweiten Zweig (Pipeline dann bereits PLAYING) reicht
    // `sync_state_with_parent()` pro neuem Element, exakt das erprobte
    // `addChannel`-Muster von `omp-audio-mixer`.
    let pipeline = gst::Pipeline::new();
    let mut pipeline_started = false;

    let (commands_tx, commands_rx): (MpscSender<Command>, MpscReceiver<Command>) = std::sync::mpsc::channel();
    let _ = ready.send(Ok(AudioMeterHandle { commands: commands_tx }));

    let bus = pipeline.bus().expect("pipeline has a bus");
    let mut branches: HashMap<String, Branch> = HashMap::new();
    let mut debug_element_msgs: u64 = 0;
    let mut debug_last_report = std::time::Instant::now();

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Command::AddInput { input_id, flow_id }) => {
                if let Some(old) = branches.remove(&input_id) {
                    teardown_branch(&pipeline, old);
                }
                match build_branch(&pipeline, &context, &flow_id, &input_id) {
                    Ok(branch) => {
                        branches.insert(input_id.clone(), branch);
                        if !pipeline_started {
                            // Erster Zweig: Pipeline (inkl. gerade
                            // hinzugefügter Kind-Elemente) erstmals
                            // gemeinsam von NULL auf PLAYING — s.
                            // Kommentar bei `pipeline_started`-Deklaration
                            // oben für den live gefundenen Grund, warum
                            // NICHT schon vorher leer auf PLAYING gesetzt
                            // wird.
                            match pipeline.set_state(gst::State::Playing) {
                                Ok(_) => pipeline_started = true,
                                Err(e) => eprintln!("omp-viewer: audio meter pipeline: initial set Playing failed: {e}"),
                            }
                        }
                        // Zweiter+ Zweig: Pipeline läuft schon,
                        // `sync_state_with_parent()` je Element (bereits
                        // in `build_branch` erledigt) reicht — exakt das
                        // erprobte `addChannel`-Muster von
                        // `omp-audio-mixer`.
                    }
                    Err(e) => eprintln!("omp-viewer: audio meter input {input_id} failed: {e}"),
                }
            }
            Ok(Command::RemoveInput { input_id }) => {
                if let Some(branch) = branches.remove(&input_id) {
                    teardown_branch(&pipeline, branch);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }

        while let Some(msg) = bus.pop_filtered(&[gst::MessageType::Element, gst::MessageType::Error, gst::MessageType::Warning]) {
            if let gst::MessageView::Error(e) = msg.view() {
                eprintln!("omp-viewer: DEBUG audio meter pipeline ERROR: {e:?}");
                continue;
            }
            if let gst::MessageView::Warning(w) = msg.view() {
                eprintln!("omp-viewer: DEBUG audio meter pipeline WARNING: {w:?}");
                continue;
            }
            let gst::MessageView::Element(el) = msg.view() else { continue };
            let Some(structure) = el.structure() else { continue };
            debug_element_msgs += 1;
            if structure.name() != "level" {
                continue;
            }
            let Some((rms, peak)) = parse_level_message(structure) else { continue };
            let name = msg.src().map(|o| o.name().to_string()).unwrap_or_default();
            let Some(input_id) = name.strip_prefix("level-") else { continue };
            let _ = tx.send(LevelEvent { input_id: input_id.to_string(), rms, peak });
        }

        if !branches.is_empty() && debug_last_report.elapsed() > std::time::Duration::from_secs(2) {
            debug_last_report = std::time::Instant::now();
            eprintln!(
                "omp-viewer: DEBUG heartbeat: {} active branch(es), {debug_element_msgs} element bus msgs seen so far, pipeline.state={:?}",
                branches.len(),
                pipeline.state(gst::ClockTime::ZERO)
            );
        }
    }

    for (_, branch) in branches.drain() {
        teardown_branch(&pipeline, branch);
    }
    let _ = pipeline.set_state(gst::State::Null);
}
