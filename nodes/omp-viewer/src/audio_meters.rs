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
//!
//! **`MxlContext` wird von `main.rs` hereingereicht, nicht hier selbst
//! erzeugt (2026-08-07):** dieses Modul öffnete zuvor einen ZWEITEN,
//! unabhängigen `MxlContext::new(domain)`, während `pipeline.rs` bereits
//! einen ersten für dieselbe Domain offen hielt — `MxlContext`s eigene
//! Struct-Doku sagt explizit "ein `MxlContext` pro Prozess reicht",
//! jeder andere Node im Codebase hält sich exakt daran (grep bestätigt
//! 2026-08-07), `omp-viewer` war der einzige mit zwei. Aufgeräumt als
//! echte Konventions-Abweichung — **war aber NICHT die Ursache des
//! Rest-Bugs unten** (per isoliertem Test widerlegt, s. dort): `main.rs`
//! erzeugt jetzt trotzdem EINEN `Arc<MxlContext>` für `pipeline::run` UND
//! `audio_meters::run`, weil es die dokumentierte Konvention ist, nicht
//! weil es den Bug behebt.
//!
//! **Der zuvor offene Rest-Bug (Reader-Thread liefert nie eine
//! `level`-Bus-Message) ist jetzt wirklich root-caused + behoben
//! (2026-08-07):** kein MXL-/GStreamer-Problem, sondern ein Rust-
//! Ownership-Bug in DIESEM Modul. `build_branch` hielt in `Branch` nur
//! die geklonten `gst::Element`s (`elements`), nicht den `MxlAudioInput`
//! selbst — dessen lokale Variable `input` fiel am Ende von
//! `build_branch` aus dem Scope. `MxlAudioInput::drop` setzt
//! `running=false`, was den frisch gestarteten Reader-Thread SOFORT nach
//! dessen allererstem (erfolglosen, weil legitim `OutOfRangeTooEarly`)
//! Non-Blocking-Read-Versuch beendet — kein Hang, kein Fehler, der
//! Thread terminiert einfach lautlos nach einer Iteration, bevor er
//! jemals Daten liefern konnte. Live per Instrumentierung bewiesen: ein
//! `get_current_index`/`get_samples_non_blocking`-Erstaufruf mit
//! identischem Timing in einem isolierten Test (kein GStreamer, kein
//! `omp-viewer`, nur die rohen `mxl`-Crate-Aufrufe, auch mit 8s
//! künstlicher Verzögerung vor dem ersten Lesezugriff) lief
//! reproduzierbar in Mikrosekunden durch — die vendorte MXL-Bibliothek
//! selbst ist also NICHT die Ursache, anders als der frühere, hier
//! ursprünglich dokumentierte Verdacht (weder "zwei `gst::Pipeline`s im
//! Prozess" noch "zwei `MxlContext`s" halten der Live-Prüfung stand).
//! `omp-audio-mixer::pipeline::ChannelBranch` macht es bereits richtig
//! (Feld `_external_input: Option<MxlAudioInput>`, exakt zu diesem
//! Zweck) — `Branch` unten übernimmt jetzt dasselbe Muster.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// Hält den eigentlichen `MxlAudioInput` am Leben (2026-08-07,
    /// root-caused Fix für den zuvor offenen Meter-Rest-Bug) — dessen
    /// `Drop` setzt `running=false`, was den Reader-Thread sofort nach
    /// dem allerersten Non-Blocking-Read-Versuch beendet, s.
    /// `build_branch`-Kommentar für die volle Herleitung. Nur die davor
    /// geklonten `gst::Element`s (`elements` oben) zu behalten reichte
    /// nicht, weil `MxlAudioInput` selbst (nicht die Elemente) den
    /// Reader-Thread kontrolliert.
    _input: MxlAudioInput,
    /// S. `reader_worker_name` — für `LivenessMonitor::unregister` beim
    /// Abbau dieses Zweigs.
    heartbeat: Arc<AtomicU64>,
}

/// Name, unter dem der Reader-Thread eines Eingangs bei
/// `omp_node_sdk::liveness::LivenessMonitor` registriert wird — als
/// eigene Funktion, damit Registrieren (`run`) und Abmelden
/// (`run`/Teardown-Pfade) garantiert denselben Namen verwenden.
fn reader_worker_name(input_id: &str) -> String {
    format!("audio-meters:reader:{input_id}")
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

    // Liveness-Heartbeat des Reader-Threads (`docs/decisions.md`
    // Nachtrag 123/2026-08-10) — VOR dem Verschieben von `input` in
    // `Branch` abholen, s. `LivenessMonitor::register`-Aufruf in `run()`.
    let heartbeat = input.heartbeat_handle();

    Ok(Branch { elements, _input: input, heartbeat })
}

/// Läuft auf einem eigenen Thread (analog `pipeline::run`): baut die
/// gemeinsame Meter-Pipeline einmal, hält sie PLAYING, verarbeitet
/// Add-/Remove-Kommandos und pollt `level`-Bus-Messages nicht-blockierend
/// (identisches Muster zu `omp-audio-mixer::pipeline::run`).
pub fn run(
    context: Arc<MxlContext>,
    tx: UnboundedSender<LevelEvent>,
    shutdown: Arc<AtomicBool>,
    ready: tokio::sync::oneshot::Sender<Result<AudioMeterHandle, String>>,
    node: omp_node_sdk::NodeHandle,
) {
    if gst::init().is_err() {
        let _ = ready.send(Err("gst init failed (audio meters)".to_string()));
        return;
    }

    // Bug 2026-08-07 (docs/decisions.md Nachtrag 123): genau dieser
    // Thread ist der historische Auslöser des Liveness-Mechanismus (s.
    // Moduldoku oben) — die äußere Schleife selbst blieb beim
    // ursprünglichen Bug am Leben (pollte weiter, loggte sogar ihren
    // eigenen Debug-Heartbeat), nur der VERSCHACHTELTE Reader-Thread
    // eines einzelnen `MxlAudioInput` starb still. Deshalb zwei
    // Registrierungsebenen: die äußere Schleife hier (erkennt einen Hang
    // z. B. im `commands_rx`/Bus-Polling selbst) UND, unten bei jedem
    // `AddInput`, der jeweilige Reader-Thread (erkennt exakt den
    // ursprünglich gefundenen Bug).
    let outer_heartbeat = Arc::new(AtomicU64::new(0));
    node.register_worker("audio-meters:outer-loop", outer_heartbeat.clone());

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
        outer_heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Command::AddInput { input_id, flow_id }) => {
                if let Some(old) = branches.remove(&input_id) {
                    node.unregister_worker(&reader_worker_name(&input_id));
                    teardown_branch(&pipeline, old);
                }
                match build_branch(&pipeline, &context, &flow_id, &input_id) {
                    Ok(branch) => {
                        node.register_worker(reader_worker_name(&input_id), branch.heartbeat.clone());
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
                    node.unregister_worker(&reader_worker_name(&input_id));
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

    for (input_id, branch) in branches.drain() {
        node.unregister_worker(&reader_worker_name(&input_id));
        teardown_branch(&pipeline, branch);
    }
    node.unregister_worker("audio-meters:outer-loop");
    let _ = pipeline.set_state(gst::State::Null);
}
