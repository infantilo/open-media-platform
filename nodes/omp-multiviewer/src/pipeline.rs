//! GStreamer-Pipeline von `omp-multiviewer` (dynamische Eingangszahl,
//! Nutzeranforderung 2026-07-12): ein `compositor`-Grid, eine Kachel pro
//! per IS-04-Discovery gefundenem MXL-Video-Sender (gleicher Discovery-
//! /Rebuild-Stil wie `omp-switcher`, C7: eine geänderte externe
//! Quellenmenge baut die **gesamte** Pipeline neu auf, kein dynamisches
//! Pad-Relinking) — anders als der Switcher aber alle Quellen
//! **gleichzeitig** sichtbar (Compositor-Grid statt `input-selector`),
//! wie C10s DVE-Kompositing (`xpos`/`ypos`/`width`/`height` als
//! `compositor`-Sink-Pad-Properties). Ausgang ist reines Monitoring
//! (MJPEG-über-HTTP, `omp_mediaio::preview` — dieselbe, aus `omp-viewer`
//! (C6) hierher extrahierte Encode-Kette) statt eines MXL-Sende-Flows:
//! ein Multiviewer speist in der Praxis eine Bedienplatz-Anzeige, kein
//! weiterverkettbares Programmsignal.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput};
use omp_mediaio::preview::{self, Broadcaster};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub const TILE_WIDTH: u32 = 320;
pub const TILE_HEIGHT: u32 = 180;
const PREVIEW_FPS: i32 = 5;
const PREVIEW_JPEG_QUALITY: i32 = 70;
/// Bei 0 Quellen zeigt der Multiviewer ein einzelnes Schwarzbild in
/// Kachelgröße statt eines leeren/fehlerhaften Canvas.
const EMPTY_CANVAS_TILES: (u32, u32) = (1, 1);

pub struct Config {
    pub domain: String,
}

#[derive(Debug, Clone)]
pub struct DiscoveredInput {
    pub sender_id: String,
    pub label: String,
    pub flow_id: String,
    /// Kapitel 15 Teil 3 (docs/END-GOAL-FEATURES.md §15.4): per
    /// `urn:x-nmos:tag:grouphint/v1.0` gefundener Lowres-Begleit-Sender
    /// dieser Quelle — `None`, wenn die Quelle keinen meldet (Rückfall
    /// auf `flow_id`/Highres+Downscale, unverändertes Verhalten vor
    /// diesem Schritt) oder wenn die Aktivierung beim Quell-Node
    /// fehlschlug (`main.rs::discovery_loop`, dort auf `None`
    /// zurückgesetzt statt eine dauerhaft schwarze Kachel zu riskieren).
    pub lowres_sender_id: Option<String>,
    pub lowres_flow_id: Option<String>,
}

pub enum Event {
    Error(String),
}

enum Command {
    SetInputs(Vec<DiscoveredInput>),
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    /// "media-ready"-Flags aller aktuell aktiven Eingänge (s.
    /// `ActivePipeline::flowed`) — bei jeder Quellenmengen-Änderung neu
    /// befüllt (analog `omp-switcher`, C7).
    flowed: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
}

impl PipelineHandle {
    pub fn set_inputs(&self, inputs: Vec<DiscoveredInput>) {
        let _ = self.commands.send(Command::SetInputs(inputs));
    }

    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2): ein
    /// reiner Monitor ohne deklarierte Quellen hat nichts abzuwarten
    /// (vakuos "bereit", Schwarzbild-Fallback, s. `build()`); sind
    /// Quellen deklariert, genügt mindestens eine tatsächlich fließende
    /// Kachel — ein einzelner ausgefallener Zubringer soll den Monitor
    /// nicht als "nicht bereit" erscheinen lassen, solange er noch
    /// irgendetwas zeigt.
    pub fn media_ready(&self) -> bool {
        let flowed = self.flowed.lock().expect("lock poisoned");
        flowed.is_empty() || flowed.iter().any(|f| f.load(Ordering::Relaxed))
    }
}

/// Rasterlayout für `n` Kacheln: möglichst quadratisch (Spalten =
/// aufgerundete Wurzel), damit das Grid bei wachsender Quellenzahl nicht
/// einseitig in die Breite/Höhe ausufert.
fn grid_dimensions(n: usize) -> (u32, u32) {
    if n == 0 {
        return EMPTY_CANVAS_TILES;
    }
    let cols = (n as f64).sqrt().ceil() as u32;
    let rows = (n as u32).div_ceil(cols);
    (cols, rows)
}

/// Vergleicht zwei Discovery-Ergebnisse per Sender-ID-Menge (Reihenfolge
/// egal) — identisch zu `omp-switcher`s gleichnamiger Funktion (C7).
fn inputs_changed(current: &[DiscoveredInput], new: &[DiscoveredInput]) -> bool {
    if current.len() != new.len() {
        return true;
    }
    let mut current_ids: Vec<&str> = current.iter().map(|i| i.sender_id.as_str()).collect();
    let mut new_ids: Vec<&str> = new.iter().map(|i| i.sender_id.as_str()).collect();
    current_ids.sort_unstable();
    new_ids.sort_unstable();
    current_ids != new_ids
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    _inputs: Vec<MxlVideoInput>,
    flowed: Vec<Arc<AtomicBool>>,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn build(
    context: &Arc<MxlContext>,
    broadcaster: &Arc<Broadcaster>,
    inputs: &[DiscoveredInput],
) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();
    let (cols, rows) = grid_dimensions(inputs.len());
    let canvas_width = cols * TILE_WIDTH;
    let canvas_height = rows * TILE_HEIGHT;

    let comp = gst::ElementFactory::make("compositor")
        .name("grid")
        .build()
        .map_err(|e| format!("compositor: {e}"))?;
    pipeline
        .add(&comp)
        .map_err(|e| format!("add compositor: {e}"))?;

    let mut mxl_inputs = Vec::with_capacity(inputs.len());
    let mut flowed = Vec::with_capacity(inputs.len());
    if inputs.is_empty() {
        let black = gst::ElementFactory::make("videotestsrc")
            .property("is-live", true)
            .build()
            .map_err(|e| format!("videotestsrc (black): {e}"))?;
        black.set_property_from_str("pattern", "black");
        pipeline
            .add(&black)
            .map_err(|e| format!("add black source: {e}"))?;
        let pad = comp
            .request_pad_simple("sink_0")
            .ok_or("compositor: request sink_0 failed")?;
        black
            .static_pad("src")
            .ok_or("black source: no src pad")?
            .link(&pad)
            .map_err(|e| format!("link black source to compositor: {e}"))?;
    } else {
        for (i, input) in inputs.iter().enumerate() {
            // Kapitel 15 Teil 3: bevorzugt den Lowres-Flow lesen, sofern
            // vorhanden und aktiviert (`main.rs::discovery_loop`) — jede
            // Kachel skaliert ohnehin auf `TILE_WIDTH`×`TILE_HEIGHT`
            // herunter (s. `videoscale`/`capsfilter` unten), `MxlVideoInput`
            // selbst braucht keine Anpassung (liest die tatsächliche
            // Flow-Auflösung aus dem MXL-Flow-Def, s. `omp-mediaio::mxl`).
            let read_flow_id = input.lowres_flow_id.as_deref().unwrap_or(&input.flow_id);
            let mxl_input = MxlVideoInput::new(&pipeline, context.clone(), read_flow_id)
                .map_err(|e| format!("MxlVideoInput({}): {e}", input.sender_id))?;

            let videoconvert = gst::ElementFactory::make("videoconvert")
                .build()
                .map_err(|e| format!("videoconvert (tile {i}): {e}"))?;
            let videoscale = gst::ElementFactory::make("videoscale")
                .build()
                .map_err(|e| format!("videoscale (tile {i}): {e}"))?;
            let caps = gst::ElementFactory::make("capsfilter")
                .property(
                    "caps",
                    gst::Caps::builder("video/x-raw")
                        .field("width", TILE_WIDTH as i32)
                        .field("height", TILE_HEIGHT as i32)
                        .build(),
                )
                .build()
                .map_err(|e| format!("capsfilter (tile {i}): {e}"))?;
            // UMD-artiges Textoverlay mit der IS-04-Sender-Bezeichnung
            // dieser Kachel (Nutzeranforderung 2026-07-12) — nach der
            // Kachelgröße statt vorher, damit Textgröße/-position pro
            // Kachel konsistent bleiben, unabhängig von der jeweiligen
            // Quellauflösung.
            // `valignment`/`halignment` sind GEnums, keine Strings — s.
            // Kommentar in omp-viewer/src/pipeline.rs (per Absturz
            // gefunden).
            let umd = gst::ElementFactory::make("textoverlay")
                .property("text", input.label.as_str())
                .property("shaded-background", true)
                .property("font-desc", "Sans 8")
                .build()
                .map_err(|e| format!("textoverlay (tile {i}): {e}"))?;
            umd.set_property_from_str("valignment", "bottom");
            umd.set_property_from_str("halignment", "center");

            pipeline
                .add(&videoconvert)
                .and_then(|()| pipeline.add(&videoscale))
                .and_then(|()| pipeline.add(&caps))
                .and_then(|()| pipeline.add(&umd))
                .map_err(|e| format!("add tile {i} elements: {e}"))?;
            gst::Element::link_many([&mxl_input.tail, &videoconvert, &videoscale, &caps, &umd])
                .map_err(|e| format!("link tile {i} chain: {e}"))?;

            let pad = comp
                .request_pad_simple(&format!("sink_{i}"))
                .ok_or_else(|| format!("compositor: request sink_{i} failed"))?;
            umd.static_pad("src")
                .ok_or("tile textoverlay: no src pad")?
                .link(&pad)
                .map_err(|e| format!("link tile {i} to compositor: {e}"))?;

            let col = (i as u32) % cols;
            let row = (i as u32) / cols;
            pad.set_property("xpos", (col * TILE_WIDTH) as i32);
            pad.set_property("ypos", (row * TILE_HEIGHT) as i32);
            pad.set_property("width", TILE_WIDTH as i32);
            pad.set_property("height", TILE_HEIGHT as i32);

            flowed.push(mxl_input.flowed_handle());
            mxl_inputs.push(mxl_input);
        }
    }

    preview::build_mjpeg_branch(
        &pipeline,
        &comp,
        broadcaster,
        canvas_width,
        canvas_height,
        PREVIEW_FPS,
        PREVIEW_JPEG_QUALITY,
    )?;

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActivePipeline {
        pipeline,
        _inputs: mxl_inputs,
        flowed,
    })
}

/// Läuft auf einem eigenen Thread (analog `omp-switcher::pipeline::run`,
/// C7): baut sofort ein leeres (Schwarzbild-)Grid, wartet danach auf
/// Discovery-getriebene `SetInputs`-Kommandos und baut bei jeder
/// Änderung komplett neu.
pub fn run(
    config: Config,
    broadcaster: Arc<Broadcaster>,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
) {
    if let Err(e) = gst::init() {
        let msg = format!("gst init failed: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }

    let context = match MxlContext::new(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let flowed_slot: Arc<Mutex<Vec<Arc<AtomicBool>>>> = Arc::new(Mutex::new(Vec::new()));

    let mut current_inputs: Vec<DiscoveredInput> = Vec::new();
    let mut active = match build(&context, &broadcaster, &current_inputs) {
        Ok(p) => {
            *flowed_slot.lock().expect("lock poisoned") = p.flowed.clone();
            Some(p)
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("initial build failed: {e}")));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) =
        std::sync::mpsc::channel();
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        flowed: flowed_slot.clone(),
    }));

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::SetInputs(inputs)) => {
                // Discovery meldet unverändert bei jedem 2s-Tick erneut
                // (wie omp-switcher, C7) — nur bei tatsächlich anderer
                // Quellenmenge neu aufbauen, sonst würde das Grid alle 2s
                // sichtbar flackern.
                if inputs_changed(&current_inputs, &inputs) {
                    current_inputs = inputs;
                    active = None; // Reader-Threads/State-Null vor dem Neuaufbau stoppen.
                    match build(&context, &broadcaster, &current_inputs) {
                        Ok(p) => {
                            *flowed_slot.lock().expect("lock poisoned") = p.flowed.clone();
                            active = Some(p);
                        }
                        Err(e) => {
                            let _ = tx.send(Event::Error(format!(
                                "rebuild with {} inputs failed: {e}",
                                current_inputs.len()
                            )));
                        }
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
