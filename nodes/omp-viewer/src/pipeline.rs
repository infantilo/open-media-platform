//! GStreamer-Pipeline von `omp-viewer` (`UMSETZUNG.md` C6): liest einen
//! MXL-Flow über `omp_mediaio::mxl::MxlVideoInput` und speist ihn in
//! einen `tee`, der einen MJPEG-Zweig (PIPELINE CONTROLLERs bewährtes
//! Preview-Muster, `lib/PreviewPipeline.js`: `videoscale 640×360 !
//! videorate 5/1 ! jpegenc quality=70 ! appsink`) sowie optional einen
//! `autovideosink`-Zweig speist (`OMP_VIEWER_SINK`, Terminal-Start).
//! `sync=false` durchgehend — umgeht die Timestamp-Frage aus C4 für
//! diesen Pfad vollständig (`UMSETZUNG.md` C6).
//!
//! Die Quelle (`flow_id`) wird per IS-05-Receiver-PATCH gewählt
//! (`main.rs`s `ViewerControl`), nicht per Kommandozeile — bei jedem
//! Quellwechsel wird die **gesamte Pipeline neu aufgebaut** (kein
//! dynamisches Pad-Relinking), analog PIPELINE CONTROLLERs eigener
//! Antwort auf einen geänderten Live-Quellen-Satz (`MasterPipeline.js`,
//! hier auf einen einzelnen Input übertragen, `UMSETZUNG.md` C6/C7).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput};
use omp_mediaio::preview::{self, Broadcaster};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

const PREVIEW_WIDTH: u32 = 640;
const PREVIEW_HEIGHT: u32 = 360;
const PREVIEW_JPEG_QUALITY: i32 = 70;

// Nutzerauftrag 2026-09-03 ("die fps ... einstellbar in der UI, damit
// man auch ruckelfrei das Video kontrollieren kann"): der bisher feste
// `PREVIEW_FPS`-Wert (5) wurde durch einen zur Laufzeit über den
// schreibbaren Parameter `previewFps` änderbaren `Arc<AtomicI32>`
// ersetzt (`PipelineHandle::set_preview_fps`, s. dort) — der Default
// bleibt bei 5, um die Server-CPU-/Bandbreitenlast für alle, die den
// neuen Regler nie anfassen, unverändert zu lassen; 1..30 deckt sowohl
// sehr sparsame Dauerbeobachtung als auch eine für einen Operator
// tatsächlich ruckelfrei wirkende Kontrolle ab (25-30fps entspricht der
// üblichen Sendebild-Rate).
const PREVIEW_FPS_DEFAULT: i32 = 5;
pub const PREVIEW_FPS_MIN: i32 = 1;
pub const PREVIEW_FPS_MAX: i32 = 30;

pub struct Config {
    pub sink_element: Option<String>,
}

pub enum Event {
    Error(String),
}

enum Command {
    Connect(String, String),
    Disconnect,
    SetPreviewFps(i32),
}

/// Griff für den async Node-Lifecycle: schickt Connect-/
/// Disconnect-Befehle an den Pipeline-Thread.
#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    flowed: Arc<AtomicBool>,
    preview_fps: Arc<AtomicI32>,
}

impl PipelineHandle {
    /// `label` ist die IS-04-Sender-Bezeichnung der gewählten Quelle
    /// (Nutzeranforderung 2026-07-12: als UMD-artiges Textoverlay
    /// eingeblendet, s. `build()`) — kein Verbindungsparameter im
    /// engeren Sinn, nur zur Anzeige.
    pub fn connect(&self, flow_id: String, label: String) {
        self.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::Connect(flow_id, label));
    }

    pub fn disconnect(&self) {
        self.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::Disconnect);
    }

    /// Aktuell konfigurierte Vorschau-Bildrate (Startwert für die UI, s.
    /// `main.rs`s `ViewerStore::get("previewFps")`).
    pub fn preview_fps(&self) -> i32 {
        self.preview_fps.load(Ordering::Relaxed)
    }

    /// Ändert die Vorschau-Bildrate zur Laufzeit (Nutzerauftrag
    /// 2026-09-03) — auf `PREVIEW_FPS_MIN..=PREVIEW_FPS_MAX` geklemmt
    /// statt eines Fehlers, damit ein UI-Regler nie einen ungültigen
    /// Wert riskiert. Der neue Wert gilt SOWOHL für eine bereits aktive
    /// Pipeline (der Kommando-Thread baut nur den MJPEG-Zweig chirurgisch
    /// neu auf, s. `run()`) ALS AUCH für jeden künftigen `connect()`
    /// (Quellwechsel) — deshalb im gemeinsamen `Arc<AtomicI32>`
    /// hinterlegt, nicht nur als einmaliges Kommando-Argument.
    pub fn set_preview_fps(&self, fps: i32) {
        let clamped = fps.clamp(PREVIEW_FPS_MIN, PREVIEW_FPS_MAX);
        self.preview_fps.store(clamped, Ordering::Relaxed);
        let _ = self.commands.send(Command::SetPreviewFps(clamped));
    }

    /// Ob die aktuell verbundene Quelle (falls vorhanden) bereits
    /// mindestens einen echten Video-Buffer geliefert hat —
    /// "media-ready"-Signal (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md
    /// D5-prep-2). `false` sowohl vor dem ersten `connect()` als auch direkt
    /// nach einem Quellwechsel, bis der neue Input nachweislich liefert
    /// (s. `connect()`/`disconnect()` oben, die das Flag zurücksetzen).
    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    _input: MxlVideoInput,
    /// Das `capsfilter` des MJPEG-Zweigs — `rebuild_mjpeg_branch`
    /// (Nutzerauftrag 2026-09-03/2026-09-24) ändert bei einem
    /// `previewFps`-Wechsel nur dessen `caps`-Eigenschaft live, statt
    /// den Zweig ab-/wieder aufzubauen (s. dortige Doku für die
    /// Root-Cause-Analyse, warum Ab-/Wiederaufbau die falsche Wahl war).
    mjpeg_caps: gst::Element,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        // Pipeline zuerst auf Null setzen (appsrc nimmt keine Buffer mehr
        // an, der Reader-Thread in _input bricht daraufhin selbst aus
        // seiner push_buffer-Schleife) — Felder droppen danach in
        // Deklarationsreihenfolge (_input nach pipeline).
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Ändert die Ziel-Bildrate des laufenden MJPEG-Zweigs live, indem
/// nur `capsfilter`s `caps`-Eigenschaft neu gesetzt wird — der Zweig
/// selbst (Pad-Verbindung zum `tee`, alle sechs Elemente) bleibt vom
/// ersten Aufbau bis zum nächsten `Disconnect` unangetastet.
///
/// **Root Cause des eigentlichen Freeze-Bugs, jetzt wirklich gefunden
/// (2026-09-24, Nutzermeldung "ändern der framerate bei viewer führt
/// zu freeze"):** die VORHERIGE Version dieser Funktion (Verlauf s.
/// Git-Historie) riss bei JEDEM `previewFps`-Wechsel den kompletten
/// Zweig ab und baute ihn an einem NEU angeforderten `tee`-Request-Pad
/// wieder auf — inklusive Block-Pad-Probe-Choreografie (dasselbe
/// Muster wie `omp-webrtc-gateway/src/monitor.rs`, Nachtrag 250) UND
/// einem `pipeline.state()`-Wartepunkt danach. Das behob zwei echte
/// Races (Puffer gegen einen noch nicht bereiten neuen Zweig; Puffer
/// in den bereits blockierten alten Zweig) und einen dritten (aggregierter
/// Pipeline-Zustand blieb bei überlappenden Rebuilds unter PLAYING
/// hängen) — reichte aber nicht: Live-Reproduktion (`GST_DEBUG=
/// GST_STATES:5` plus eigene Puffer-/Event-Pad-Probes auf dem neuen
/// Zweig) zeigte, dass ein per `tee.request_pad_simple("src_%u")`
/// NACH dem allerersten Aufbau zusätzlich angeforderter Pad
/// reproduzierbar — aber NICHT bei jedem einzelnen Versuch, also
/// eine echte Race, kein deterministischer Ordinal-Effekt — dauerhaft
/// WEDER Sticky-Events (STREAM-START/CAPS/SEGMENT) NOCH auch nur einen
/// einzigen Puffer vom `tee` bekam, ganz ohne GStreamer-Fehlermeldung.
/// Das erklärt rückwirkend auch, warum sich das Problem trotz aller
/// drei vorherigen Fixes durch bloßes Abwarten NIE erholte ("man muss
/// die Verbindung trennen und neu herstellen").
///
/// **Der eigentliche Fix: das `tee` nach dem allerersten Aufbau nie
/// wieder anfassen.** `previewFps` ändert an diesem Zweig ohnehin nur
/// EINE Eigenschaft (die Ziel-Framerate im `capsfilter`) — dafür
/// braucht es kein Ab-/Neuverlinken von irgendetwas. `capsfilter.caps`
/// ist eine zur Laufzeit änderbare GObject-Eigenschaft; GStreamer trägt
/// die neue Framerate per normaler Caps-Renegotiation zum bereits
/// laufenden `videorate` weiter (das genau dafür da ist). Das
/// vermeidet die komplette Klasse von `tee`-Pad-Races (keine neuen
/// Request-Pads mehr nach dem ersten Aufbau, nichts zu blockieren/zu
/// entblocken, kein `pipeline.state()`-Wartepunkt nötig) statt sie nur
/// enger einzugrenzen. Live verifiziert: 6 Wechsel mit klarem
/// zeitlichem Abstand (2s) UND ein 20-Wechsel-Burst (50ms Abstand) —
/// `/preview`-MD5 ändert sich nach JEDEM Wechsel, bleibt nie hängen
/// (vorher fror bereits der zweite Wechsel unabhängig vom zeitlichen
/// Abstand reproduzierbar ein).
fn rebuild_mjpeg_branch(active: &mut ActivePipeline, fps: i32) {
    active.mjpeg_caps.set_property(
        "caps",
        gst::Caps::builder("video/x-raw")
            .field("width", PREVIEW_WIDTH as i32)
            .field("height", PREVIEW_HEIGHT as i32)
            .field("framerate", gst::Fraction::new(fps, 1))
            .build(),
    );
}

fn build(
    context: &Arc<MxlContext>,
    flow_id: &str,
    label: &str,
    broadcaster: &Arc<Broadcaster>,
    sink_element: Option<&str>,
    flowed: Arc<AtomicBool>,
    preview_fps: i32,
) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let input = MxlVideoInput::new(&pipeline, context.clone(), flow_id)?;
    // "media-ready" (ARCHITECTURE.md §5 Punkt 6): Probe hinter dem
    // MXL-Eingang, unabhängig von `MxlVideoInput::has_flowed()` (dessen
    // internes Flag stirbt mit der Instanz bei jedem Quellwechsel) — hier
    // ein von außen (PipelineHandle) abfragbares, über Rebuilds hinweg
    // bewusst zurückgesetztes Flag (s. PipelineHandle::connect).
    let flowed_probe = flowed.clone();
    let input_tail_src_pad = input.tail.static_pad("src").expect("tail has a src pad");
    input_tail_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        flowed_probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Remove
    });

    // UMD-artiges Textoverlay mit der IS-04-Sender-Bezeichnung der
    // gewählten Quelle (Nutzeranforderung 2026-07-12) — vor dem `tee`,
    // damit sowohl der MJPEG- als auch ein optionaler Terminal-Sink-Zweig
    // das Label sehen.
    // `valignment`/`halignment` sind GEnums (`GstBaseTextOverlayV/HAlign`),
    // keine Strings — `set_property_from_str` statt `.property()` (per
    // Absturz gefunden: `.property("valignment", "bottom")` schlägt zur
    // Laufzeit fehl, "expected GstBaseTextOverlayVAlign, got gchararray").
    let umd = gst::ElementFactory::make("textoverlay")
        .property("text", label)
        .property("shaded-background", true)
        .build()
        .map_err(|e| format!("textoverlay: {e}"))?;
    umd.set_property_from_str("valignment", "bottom");
    umd.set_property_from_str("halignment", "center");

    let tee = gst::ElementFactory::make("tee")
        .name("preview_tee")
        .build()
        .map_err(|e| format!("tee: {e}"))?;
    pipeline
        .add(&umd)
        .and_then(|()| pipeline.add(&tee))
        .map_err(|e| format!("add tee: {e}"))?;
    gst::Element::link_many([&input.tail, &umd, &tee])
        .map_err(|e| format!("link input to tee: {e}"))?;

    let mjpeg_elements = preview::build_mjpeg_branch(
        &pipeline,
        &tee,
        broadcaster,
        PREVIEW_WIDTH,
        PREVIEW_HEIGHT,
        preview_fps,
        PREVIEW_JPEG_QUALITY,
    )?;
    if let Some(sink_name) = sink_element {
        build_sink_branch(&pipeline, &tee, sink_name)?;
    }

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    // Reihenfolge aus `preview::build_mjpeg_branch`s Rückgabe:
    // [queue, videoscale, videorate, caps, jpegenc, appsink].
    let mjpeg_caps = mjpeg_elements
        .into_iter()
        .nth(3)
        .ok_or("build_mjpeg_branch: missing capsfilter element")?;

    Ok(ActivePipeline {
        pipeline,
        _input: input,
        mjpeg_caps,
    })
}

fn build_sink_branch(
    pipeline: &gst::Pipeline,
    tee: &gst::Element,
    sink_name: &str,
) -> Result<(), String> {
    let queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| format!("queue (sink): {e}"))?;
    let videoconvert = gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(|e| format!("videoconvert (sink): {e}"))?;
    let sink = gst::ElementFactory::make(sink_name)
        .property("sync", false)
        .build()
        .map_err(|e| format!("{sink_name}: {e}"))?;

    pipeline
        .add(&queue)
        .and_then(|()| pipeline.add(&videoconvert))
        .and_then(|()| pipeline.add(&sink))
        .map_err(|e| format!("add sink elements: {e}"))?;

    gst::Element::link_many([tee, &queue, &videoconvert, &sink])
        .map_err(|e| format!("link sink branch: {e}"))?;

    Ok(())
}

/// Läuft auf einem eigenen Thread (analog `omp-source::pipeline::run`):
/// baut initial keine Pipeline (noch keine Quelle gewählt), wartet auf
/// `Command`s aus `PipelineHandle` und baut bei jedem Connect/Disconnect
/// die Pipeline komplett neu auf.
pub fn run(
    config: Config,
    context: Arc<MxlContext>,
    broadcaster: Arc<Broadcaster>,
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

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) =
        std::sync::mpsc::channel();
    let flowed = Arc::new(AtomicBool::new(false));
    let preview_fps = Arc::new(AtomicI32::new(PREVIEW_FPS_DEFAULT));
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        flowed: flowed.clone(),
        preview_fps: preview_fps.clone(),
    }));

    let mut active: Option<ActivePipeline> = None;
    // Ein per `try_recv()` beim Bündeln (s. `SetPreviewFps`-Zweig unten)
    // vorgezogenes Nicht-`SetPreviewFps`-Kommando — wird in der NÄCHSTEN
    // Schleifeniteration zuerst verarbeitet, damit die Reihenfolge
    // relativ zu einem dazwischenkommenden Connect/Disconnect erhalten
    // bleibt.
    let mut pending: Option<Command> = None;
    // Root-Cause-Fund Bugliste 2026-09-25 #3: `build()` schlägt fehl,
    // wenn der `flow_id`-MXL-Flow der Quelle im Moment des `Connect`
    // noch nicht existiert (Quelle erzeugt, aber noch kein Video
    // geladen/abgespielt) — bisher OHNE Retry, die Pipeline blieb dann
    // dauerhaft `None`, selbst nachdem die Quelle später zu schreiben
    // begann; nur ein manuelles Trennen+Neuverbinden (erneutes
    // `Command::Connect`) stieß einen neuen Versuch an. Gleiches Muster
    // wie das bereits (mit eigenem, dediziertem Retry-Mechanismus)
    // behandelte `missing_input_ids()` bei `omp-video-mixer-me` — hier
    // als einfacher "letzter fehlgeschlagener Connect"-Merker, der bei
    // jedem 500ms-Tick der ohnehin laufenden Kommando-Schleife erneut
    // versucht wird, bis er entweder erfolgreich ist oder durch einen
    // neuen `Connect`/`Disconnect` ersetzt wird.
    let mut retry_target: Option<(String, String)> = None;
    loop {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        let command = match pending.take() {
            Some(cmd) => Ok(cmd),
            None => commands_rx.recv_timeout(Duration::from_millis(500)),
        };
        match command {
            Ok(Command::Connect(flow_id, label)) => {
                // Alte Pipeline zuerst abbauen (Drop stoppt Reader-Thread
                // + setzt State Null), bevor die neue denselben
                // MxlContext für einen neuen Reader nutzt.
                active = None;
                match build(
                    &context,
                    &flow_id,
                    &label,
                    &broadcaster,
                    config.sink_element.as_deref(),
                    flowed.clone(),
                    preview_fps.load(Ordering::Relaxed),
                ) {
                    Ok(p) => {
                        active = Some(p);
                        retry_target = None;
                    }
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("connect {flow_id} failed: {e}")));
                        retry_target = Some((flow_id, label));
                    }
                }
            }
            Ok(Command::Disconnect) => {
                active = None;
                retry_target = None;
                broadcaster.reset();
            }
            // Nutzerauftrag 2026-09-03: wirkt nur, wenn gerade eine Quelle
            // verbunden ist (`active.is_some()`) — ohne aktive Pipeline
            // gibt es nichts umzubauen, `PipelineHandle::set_preview_fps`
            // hat den neuen Wert im gemeinsamen `Arc<AtomicI32>` bereits
            // hinterlegt, der nächste `connect()` liest ihn ohnehin.
            Ok(Command::SetPreviewFps(mut fps)) => {
                // Aufeinanderfolgende SetPreviewFps-Kommandos bündeln: nur
                // der LETZTE angeforderte Wert zählt ohnehin, ältere sind
                // sofort überholt — spart ein paar redundante
                // `caps`-Property-Sets bei einem schnell gezogenen
                // Bildrate-Regler (seit 2026-09-24 unkritisch, s.
                // `rebuild_mjpeg_branch`-Doku, aber weiterhin unnötige
                // Arbeit). Ein dazwischenliegendes Connect/Disconnect wird
                // NICHT verworfen, sondern für die nächste
                // Schleifeniteration vorgemerkt (`pending`).
                while let Ok(next) = commands_rx.try_recv() {
                    match next {
                        Command::SetPreviewFps(newer) => fps = newer,
                        other => {
                            pending = Some(other);
                            break;
                        }
                    }
                }
                if let Some(active) = active.as_mut() {
                    rebuild_mjpeg_branch(active, fps);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Automatischer Reconnect-Versuch (s. `retry_target`-Doku
                // oben): kein neues Event pro Versuch — die erste
                // Fehlermeldung wurde bereits beim ursprünglichen
                // `Connect` gemeldet, weitere gleiche Meldungen alle
                // 500ms wären reines Alert-Spam. `spawn_viewer_monitor_
                // tick` (main.rs) erholt den BCP-008-Status ohnehin
                // automatisch, sobald `flowed` durch die Pad-Probe in
                // `build()` wahr wird.
                if active.is_none()
                    && let Some((flow_id, label)) = retry_target.clone()
                    && let Ok(p) = build(
                        &context,
                        &flow_id,
                        &label,
                        &broadcaster,
                        config.sink_element.as_deref(),
                        flowed.clone(),
                        preview_fps.load(Ordering::Relaxed),
                    )
                {
                    active = Some(p);
                    retry_target = None;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
