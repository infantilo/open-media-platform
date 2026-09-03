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
    /// Der gemeinsame `tee`, an dem der MJPEG-Zweig hängt — gehalten,
    /// damit `set_preview_fps` (s. `run()`) ihn chirurgisch ab- und mit
    /// neuer Bildrate wieder aufbauen kann, ohne die gesamte Pipeline
    /// (inkl. `MxlVideoInput`) neu zu erstellen (Nutzerauftrag
    /// 2026-09-03).
    tee: gst::Element,
    /// Die sechs Elemente des aktuell laufenden MJPEG-Zweigs (`preview::
    /// build_mjpeg_branch`s Rückgabe) — für einen sauberen Abbau bei
    /// einem FPS-Wechsel (`set_state(Null)` + Unlink + `pipeline.
    /// remove()`, s. `rebuild_mjpeg_branch`).
    mjpeg_elements: Vec<gst::Element>,
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

/// Baut den MJPEG-Zweig für `active` mit `fps` neu auf. Der neu
/// hinzugefügte Zweig hängt an einer bereits PLAYING laufenden Pipeline
/// — `sync_state_with_parent()` (nicht die aufwendigere Paused-zuerst-
/// Choreografie aus `omp-mxf-player`) ist hier der richtige, in diesem
/// Repo an jeder vergleichbaren Stelle (`omp-switcher`, `omp-video-
/// mixer-me`, `omp-audio-mixer`) verwendete Weg: die Elemente haben
/// feste Pad-Zahlen, kein `no-more-pads`-Warten nötig, das die
/// `omp-mxf-player`-Race überhaupt erst begründet hätte.
///
/// **Verifikations-Stolperstein (2026-09-03, festgehalten für die
/// nächste Sitzung):** ein erster Live-Test gegen `omp-mxf-player-
/// direct` als Quelle zeigte über mehrere FPS-Wechsel hinweg
/// scheinbar eingefrorene `/preview`-Antworten (identischer MD5-Hash
/// über Sekunden). Per `GST_DEBUG`-Instrumentierung (Element-Zustände
/// UND ein temporärer Zähler im `new_sample`-Callback) zweifelsfrei
/// widerlegt: der Zweig baut sich korrekt neu auf, der Callback feuert
/// exakt mit der eingestellten Rate (z. B. 5,3/s bei `fps=5`, 20,3/s bei
/// `fps=20`, gegen eine stabile `omp-source`-Testquelle gemessen). Die
/// `omp-mxf-player-direct`-Quelle zeigte im selben Zeitraum
/// wiederholtes `"omp-mediaio(mxl): reopen after FLOW_INVALID …
/// retrying"` — ein bereits an anderer Stelle dokumentiertes,
/// unabhängiges Problem dieser LOOPENDEN Testquelle, nicht dieses
/// Zweigs. Für künftige Preview-/MJPEG-Debugging-Sessions: eine
/// STABILE Quelle (`omp-source`) statt einer loopenden verwenden, sonst
/// verschwendet man Zeit auf ein fremdes Symptom. Die beiden unten
/// umgesetzten Maßnahmen (bestätigtes NULL vor Unlink, neuer Zweig vor
/// dem alten aufgebaut) blieben trotzdem bewusst erhalten — sie folgen
/// derselben sicheren Reihenfolge, die an anderer Stelle in diesem Repo
/// bereits für echte Bugs nötig war (s. Kommentare unten), auch ohne
/// dass hier zweifelsfrei bewiesen ist, dass sie für DIESEN Zweig
/// zwingend erforderlich sind.
fn rebuild_mjpeg_branch(active: &mut ActivePipeline, broadcaster: &Arc<Broadcaster>, fps: i32) -> Result<(), String> {
    let new_elements = preview::build_mjpeg_branch(
        &active.pipeline,
        &active.tee,
        broadcaster,
        PREVIEW_WIDTH,
        PREVIEW_HEIGHT,
        fps,
        PREVIEW_JPEG_QUALITY,
    )?;
    for el in &new_elements {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync_state_with_parent (mjpeg fps change, {}): {e}", el.name()))?;
    }

    let old_elements = std::mem::replace(&mut active.mjpeg_elements, new_elements);
    for el in &old_elements {
        let _ = el.set_state(gst::State::Null);
    }
    // Erst NACH bestätigtem NULL (nicht nur angefordert) unlinken/
    // freigeben/entfernen — dieselbe Reihenfolge, die `omp-mxf-player::
    // pipeline::stop_element_and_wait`/`omp-player::pipeline::
    // teardown_branch` an anderer Stelle in diesem Repo bereits
    // dokumentieren.
    for el in &old_elements {
        if el.state(gst::ClockTime::from_mseconds(500)).0.is_err() {
            eprintln!(
                "omp-viewer: {} erreichte GST_STATE_NULL nicht innerhalb 500ms beim FPS-Wechsel — fahre trotzdem fort",
                el.name()
            );
        }
    }
    if let Some(first) = old_elements.first()
        && let Some(sink_pad) = first.static_pad("sink")
        && let Some(tee_pad) = sink_pad.peer()
    {
        let _ = tee_pad.unlink(&sink_pad);
        active.tee.release_request_pad(&tee_pad);
    }
    for el in &old_elements {
        let _ = active.pipeline.remove(el);
    }
    Ok(())
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

    Ok(ActivePipeline {
        pipeline,
        _input: input,
        tee,
        mjpeg_elements,
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
    loop {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
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
                    Ok(p) => active = Some(p),
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("connect {flow_id} failed: {e}")));
                    }
                }
            }
            Ok(Command::Disconnect) => {
                active = None;
                broadcaster.reset();
            }
            // Nutzerauftrag 2026-09-03: wirkt nur, wenn gerade eine Quelle
            // verbunden ist (`active.is_some()`) — ohne aktive Pipeline
            // gibt es nichts umzubauen, `PipelineHandle::set_preview_fps`
            // hat den neuen Wert im gemeinsamen `Arc<AtomicI32>` bereits
            // hinterlegt, der nächste `connect()` liest ihn ohnehin.
            Ok(Command::SetPreviewFps(fps)) => {
                if let Some(active) = active.as_mut()
                    && let Err(e) = rebuild_mjpeg_branch(active, &broadcaster, fps)
                {
                    let _ = tx.send(Event::Error(format!("set preview fps {fps} failed: {e}")));
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
