//! GStreamer-Pipeline von `omp-switcher` (`UMSETZUNG.md` C7), übernommen
//! aus PIPELINE CONTROLLERs `MasterPipeline.js`, nicht neu erfunden:
//! `input-selector name=isel sync-streams=false`, `sink_0` permanent ein
//! Schwarzbild-Fallback (`videotestsrc is-live=true pattern=black`,
//! damit der Ausgang auch bei null entdeckten Quellen läuft), ein Zweig
//! pro entdeckter Quelle (`MxlVideoInput(flow) ! isel.sink_N`), danach
//! `isel ! MxlVideoOutput` unter der eigenen, über Neuaufbauten hinweg
//! konstanten `flow_id` (`Config::flow_id`) — MXLs `create_flow_writer`
//! erkennt einen bereits existierenden Flow und öffnet ihn erneut (siehe
//! `omp_mediaio::mxl`-Kommentar "reusing existing flow"), daher bleiben
//! angeschlossene Viewer über einen Neuaufbau hinweg gültig.
//!
//! Jeder Zweig (Schwarzbild wie Quellen) läuft vor `isel` durch
//! `videoconvert ! videoscale ! videorate ! capsfilter` auf dieselben
//! Maße/Framerate (`Config::width`/`height`, aus `OMP_WIDTH`/`OMP_HEIGHT`
//! bzw. `DEFAULT_WIDTH`/`DEFAULT_HEIGHT`-Fallback, `FRAMERATE_*` weiterhin
//! fest) — `input-selector` schaltet nur zwischen bereits kompatiblen Caps
//! um, ohne dass der Ausgang bei jedem Wechsel neu verhandeln müsste.
//!
//! **Drei getrennte Änderungsarten** (Kapitel 15 Teil 3 Ergänzung, s.
//! `docs/decisions.md`): ändert sich die entdeckte Quellenmenge
//! (`Command::SetInputs`), wird die **gesamte Pipeline neu aufgebaut**
//! (PIPELINE CONTROLLERs eigene Antwort auf einen geänderten
//! Live-Quellen-Satz). Ein Klick auf einen Auswahl-Button
//! (`Command::Select`) ändert `isel`s `active-pad`-Property auf der
//! laufenden Pipeline — **zusätzlich** aber, anders als bisher, tauscht
//! er live die Auflösung der betroffenen Zweige: der neu gewählte
//! Eingang wird (falls bisher als Lowres-Vorschau gelesen) vor dem
//! eigentlichen Umschalten auf Highres hochgestuft — PGM zeigt nie ein
//! Lowres-Bild —, der zuvor aktive Eingang wird danach (best effort,
//! PGM längst umgeschaltet) auf Lowres heruntergestuft, sofern er einen
//! Lowres-Begleit-Sender hat. Beides passiert per **Pad-Block-Hot-Swap**
//! (`swap_input_resolution`) auf genau dem einen betroffenen
//! `isel`-Sink-Pad — kein Neuaufbau der übrigen Pipeline, kein
//! sichtbarer Unterbruch auf den unbeteiligten Zweigen/dem PGM-Ausgang.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

/// Fallback, falls `main.rs` keine `OMP_WIDTH`/`OMP_HEIGHT`-Umgebungs-
/// variable findet (Kapitel 15, docs/END-GOAL-FEATURES.md §15.3c,
/// 2026-07-17: Workflow-Auflösungs-Setting) — `Config::width`/`height`
/// tragen den tatsächlich verwendeten Wert, diese Konstanten sind nur
/// noch der Default dafür, keine feste Pipeline-Vorgabe mehr.
pub const DEFAULT_WIDTH: u32 = 640;
pub const DEFAULT_HEIGHT: u32 = 480;
pub const FRAMERATE_NUMERATOR: u32 = 25;
pub const FRAMERATE_DENOMINATOR: u32 = 1;

/// Beim `MxlVideoOutput`/`MxlVideoInput`-Schreib-/Lese-Thread (`C4`) wird
/// beim `Drop` nur ein Stop-Flag gesetzt, nicht auf das tatsächliche
/// Threadende gewartet (kein `JoinHandle` gehalten) — der jeweilige
/// Loop-Durchlauf endet erst nach seinem eigenen Poll-Timeout (200/500ms).
/// Vor dem Öffnen eines neuen Writers auf denselben `flow_id` (Rebuild)
/// wird deshalb kurz gewartet, damit nicht zwei Writer-Threads
/// überlappend in denselben Flow schreiben.
const OLD_WRITER_DRAIN: Duration = Duration::from_millis(300);

/// Timeout für den Pad-Block beim Auflösungs-Hot-Swap (`swap_input_
/// resolution`) — ein aktiv fließender Zweig blockiert typischerweise
/// binnen einer Frame-Periode (≤ 40ms bei 25fps). Live entdeckt: ein
/// ursprünglich großzügigerer Wert (2s) ließ unter sehr schneller,
/// wiederholter Auswahl (weit jenseits menschlicher Klick-
/// Geschwindigkeit) den Kommando-Kanal stauen, weil jeder scheiternde
/// Versuch die Verarbeitung entsprechend lange blockierte — 500ms bleibt
/// weiterhin weit über jeder realistisch zu erwartenden Blockierzeit,
/// begrenzt aber die Worst-Case-Blockierdauer pro Versuch deutlich (s.
/// zusätzlich die `Select`-Bündelung in `run()` für dieselbe Ursache).
const SWAP_BLOCK_TIMEOUT: Duration = Duration::from_millis(500);

pub struct Config {
    pub domain: String,
    pub flow_id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone)]
pub struct DiscoveredInput {
    pub sender_id: String,
    pub label: String,
    pub flow_id: String,
    /// Sender-ID des Lowres-Begleiters (nur von `main.rs` für
    /// `activateLowresPreview`/`releaseLowresPreview` gebraucht, hier
    /// selbst ungenutzt — s. `lowres_flow_id`-Doku).
    pub lowres_sender_id: Option<String>,
    /// Kapitel 15 Teil 3 (docs/decisions.md): Flow-ID des Lowres-
    /// Begleit-Senders derselben Quelle, sofern per Grouphint-Tag
    /// gefunden (`main.rs::discover`) — `None` heißt "keiner
    /// entdeckt/aktivierbar", dieser Eingang bleibt dauerhaft Highres.
    pub lowres_flow_id: Option<String>,
}

pub enum Event {
    Error(String),
    /// `None` = Schwarzbild aktiv. Sowohl nach einem `Select` als auch
    /// nach einem Rebuild geschickt (im zweiten Fall ggf. abweichend vom
    /// zuletzt gewünschten `senderId`, wenn die Quelle verschwunden ist).
    ActiveChanged(Option<String>),
}

enum Command {
    SetInputs(Vec<DiscoveredInput>),
    Select(Option<String>),
}

/// Griff für den async Node-Lifecycle: meldet die aktuell entdeckten
/// Quellen (`main.rs`s Discovery-Loop) bzw. eine Auswahl (`select`-Methode).
#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    /// Zeigt auf das "media-ready"-Flag (`omp_mediaio::MxlVideoOutput::
    /// flowed_handle`) des jeweils **aktuellen** Ausgangs — der Ausgang
    /// wird bei jeder Quellenmengen-Änderung neu aufgebaut (C7: "Ändert
    /// sich die entdeckte Quellenmenge, wird die gesamte Pipeline neu
    /// aufgebaut"), ein einzelnes fest verdrahtetes Flag würde nach dem
    /// ersten Rebuild veraltet bleiben. `None` nur im (praktisch nicht
    /// erreichbaren) Fenster vor dem allerersten erfolgreichen Build.
    flowed: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl PipelineHandle {
    pub fn set_inputs(&self, inputs: Vec<DiscoveredInput>) {
        let _ = self.commands.send(Command::SetInputs(inputs));
    }

    pub fn select(&self, sender_id: Option<String>) {
        let _ = self.commands.send(Command::Select(sender_id));
    }

    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2): der
    /// Switcher-Ausgang produziert immer etwas (mindestens das
    /// Schwarzbild, C7), wird also i. d. R. kurz nach jedem (Re-)Build
    /// `true`.
    pub fn media_ready(&self) -> bool {
        self.flowed
            .lock()
            .expect("lock poisoned")
            .as_ref()
            .is_some_and(|f| f.load(Ordering::Relaxed))
    }
}

fn video_caps(width: u32, height: u32) -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("width", width as i32)
        .field("height", height as i32)
        .field(
            "framerate",
            gst::Fraction::new(FRAMERATE_NUMERATOR as i32, FRAMERATE_DENOMINATOR as i32),
        )
        .build()
}

/// Welcher Flow für `input` gerade gelesen werden soll: Highres, wenn er
/// der aktuell (bzw. gerade werdende) aktive PGM-Eingang ist oder keinen
/// Lowres-Begleiter hat — sonst Lowres.
fn desired_flow_id<'a>(input: &'a DiscoveredInput, active: &Option<String>) -> &'a str {
    if active.as_deref() == Some(input.sender_id.as_str()) {
        &input.flow_id
    } else {
        input.lowres_flow_id.as_deref().unwrap_or(&input.flow_id)
    }
}

/// Ein einzelner Eingangs-Zweig (`MxlVideoInput ! videoconvert !
/// videoscale ! videorate ! capsfilter`), **nicht** an `isel` verlinkt —
/// das entscheidet der jeweilige Aufrufer (`build_one_input`: neuer
/// Pad-Request beim Erstaufbau; `swap_input_resolution`: Verlinkung auf
/// einen schon existierenden Pad beim Hot-Swap).
struct InputBranch {
    mxl_input: MxlVideoInput,
    videoconvert: gst::Element,
    videoscale: gst::Element,
    videorate: gst::Element,
    caps: gst::Element,
    /// Welcher Flow gerade tatsächlich offen ist (Highres oder Lowres) —
    /// Vergleichsbasis für `swap_input_resolution`s Aufrufer, um
    /// unnötige Swaps zu vermeiden.
    open_flow_id: String,
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    isel: gst::Element,
    black_pad: gst::Pad,
    source_pads: HashMap<String, gst::Pad>,
    branches: HashMap<String, InputBranch>,
    _mxl_output: MxlVideoOutput,
    flowed: Arc<AtomicBool>,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Wendet `selected` auf die laufende Pipeline an (fällt auf Schwarzbild
/// zurück, wenn `selected` keinem aktuell bekannten `source_pads`-Eintrag
/// entspricht) und liefert die tatsächlich aktiv geschaltete `senderId`
/// zurück (`None` = Schwarzbild).
fn apply_selection(active: &ActivePipeline, selected: &Option<String>) -> Option<String> {
    let pad = selected
        .as_ref()
        .and_then(|id| active.source_pads.get(id).map(|pad| (id.clone(), pad)));
    match pad {
        Some((id, pad)) => {
            active.isel.set_property("active-pad", pad);
            Some(id)
        }
        None => {
            active.isel.set_property("active-pad", &active.black_pad);
            None
        }
    }
}

/// Entfernt zuvor per `pipeline.add()` hinzugefügte Elemente wieder
/// (`Null`-Zustand + `remove`) — Aufräumen für einen einzelnen, verworfenen
/// Eingang, s. `build_branch`. Gleicher Verwaisungs-Schutz wie in
/// `omp-mediaio::mxl` und `omp-video-mixer-me` (`docs/decisions.md`
/// 2026-07-16 "Nachtrag 2", Registry-Geist-OOM).
fn remove_elements(pipeline: &gst::Pipeline, elements: &[gst::Element]) {
    for el in elements {
        let _ = el.set_state(gst::State::Null);
        let _ = pipeline.remove(el);
    }
}

/// Baut `mxl_input` vollständig ab, statt es nur fallen zu lassen — s.
/// `MxlVideoInput::elements`-Doku (`omp-mediaio`): ein bloßes `drop()`
/// entfernt seine vier intern angelegten Elemente **nicht** aus der
/// Pipeline, unschädlich nur beim Abbau der ganzen Pipeline, ein
/// nachgewiesener, unbegrenzt wachsender Speicherverbrauch bei jeder
/// chirurgischen Einzel-Entfernung (Registry-Geist-Fehlschlag hier oder
/// Auflösungs-Hot-Swap, `swap_input_resolution`).
fn remove_mxl_video_input(pipeline: &gst::Pipeline, mxl_input: MxlVideoInput) {
    // S. omp-video-mixer-me::pipeline::remove_mxl_video_input (identische
    // Funktion) — `stop()` muss vor `remove_elements` laufen, sonst rennt
    // der `read_loop`-Thread noch `push_buffer()` gegen ein Element, das
    // hier gerade auf `Null` gesetzt/entfernt wird (live per `GST_DEBUG=3`
    // im Mixer bestätigt, gleicher Codepfad/gleiche Funktion hier).
    mxl_input.stop();
    std::thread::sleep(std::time::Duration::from_millis(20));
    remove_elements(pipeline, &mxl_input.elements);
    drop(mxl_input);
}

/// Baut nur den Zweig selbst (`MxlVideoInput` + Konvertierungskette),
/// fügt ihn zur Pipeline hinzu und verlinkt seine interne Kette — **noch
/// nicht** an `isel` angeschlossen, s. `InputBranch`-Doku. Schlägt
/// irgendein Schritt fehl (z. B. `MxlVideoInput::new` gegen einen
/// Registry-Geist-Sender, dessen Flow bereits per `mxl-info -g`
/// eingesammelt wurde), räumt diese Funktion alles, was sie selbst
/// bereits angelegt hat, vollständig wieder ab, statt es verwaist zu
/// lassen (gleicher Fix wie `omp-video-mixer-me::pipeline::
/// build_one_input`, ursprünglich die Registry-Geist-OOM-Ursache).
fn build_branch(
    pipeline: &gst::Pipeline,
    context: &Arc<MxlContext>,
    read_flow_id: &str,
    sender_id: &str,
    pad_index: usize,
    width: u32,
    height: u32,
) -> Result<InputBranch, String> {
    let mxl_input = MxlVideoInput::new(pipeline, context.clone(), read_flow_id)
        .map_err(|e| format!("MxlVideoInput({sender_id}): {e}"))?;

    let videoconvert = match gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(|e| format!("videoconvert (input {pad_index}): {e}"))
    {
        Ok(e) => e,
        Err(e) => {
            remove_mxl_video_input(pipeline, mxl_input);
            return Err(e);
        }
    };
    let videoscale = match gst::ElementFactory::make("videoscale")
        .build()
        .map_err(|e| format!("videoscale (input {pad_index}): {e}"))
    {
        Ok(e) => e,
        Err(e) => {
            remove_mxl_video_input(pipeline, mxl_input);
            return Err(e);
        }
    };
    let videorate = match gst::ElementFactory::make("videorate")
        .build()
        .map_err(|e| format!("videorate (input {pad_index}): {e}"))
    {
        Ok(e) => e,
        Err(e) => {
            remove_mxl_video_input(pipeline, mxl_input);
            return Err(e);
        }
    };
    let caps = match gst::ElementFactory::make("capsfilter")
        .property("caps", video_caps(width, height))
        .build()
        .map_err(|e| format!("capsfilter (input {pad_index}): {e}"))
    {
        Ok(e) => e,
        Err(e) => {
            remove_mxl_video_input(pipeline, mxl_input);
            return Err(e);
        }
    };
    let branch_elements = [videoconvert.clone(), videoscale.clone(), videorate.clone(), caps.clone()];

    if let Err(e) = pipeline
        .add(&videoconvert)
        .and_then(|()| pipeline.add(&videoscale))
        .and_then(|()| pipeline.add(&videorate))
        .and_then(|()| pipeline.add(&caps))
        .map_err(|e| format!("add input {pad_index} elements: {e}"))
    {
        remove_elements(pipeline, &branch_elements);
        remove_mxl_video_input(pipeline, mxl_input);
        return Err(e);
    }
    if let Err(e) = gst::Element::link_many([&mxl_input.tail, &videoconvert, &videoscale, &videorate, &caps])
        .map_err(|e| format!("link input {pad_index} chain: {e}"))
    {
        remove_elements(pipeline, &branch_elements);
        remove_mxl_video_input(pipeline, mxl_input);
        return Err(e);
    }

    // Neue Elemente in einer bereits PLAYING-Pipeline müssen explizit auf
    // deren Zustand hochgezogen werden (`add()` allein tut das nicht) —
    // beim Erstaufbau (Pipeline wird erst danach auf PLAYING gesetzt)
    // ist das ein No-Op (Zustand wechselt ohnehin gleich mit), beim
    // Hot-Swap (`swap_input_resolution`, Pipeline läuft bereits) ist es
    // zwingend.
    for el in &branch_elements {
        if let Err(e) = el.sync_state_with_parent() {
            remove_elements(pipeline, &branch_elements);
            remove_mxl_video_input(pipeline, mxl_input);
            return Err(format!("sync_state_with_parent (input {pad_index}): {e}"));
        }
    }

    Ok(InputBranch {
        mxl_input,
        videoconvert,
        videoscale,
        videorate,
        caps,
        open_flow_id: read_flow_id.to_string(),
    })
}

/// Baut einen kompletten neuen Eingang beim (Erst-)Aufbau der Pipeline:
/// `build_branch` plus ein frischer `isel`-Sink-Pad-Request. Ein
/// einzelner kaputter Eingang lässt den restlichen Build nicht scheitern
/// — Fehler werden dem Aufrufer (`build`) als `Result::Err` gemeldet,
/// der ihn überspringt und als Warnung sammelt.
#[allow(clippy::too_many_arguments)]
fn build_one_input(
    pipeline: &gst::Pipeline,
    context: &Arc<MxlContext>,
    isel: &gst::Element,
    input: &DiscoveredInput,
    pad_index: usize,
    width: u32,
    height: u32,
    active: &Option<String>,
) -> Result<(gst::Pad, InputBranch), String> {
    let read_flow_id = desired_flow_id(input, active);
    let branch = build_branch(pipeline, context, read_flow_id, &input.sender_id, pad_index, width, height)?;

    let pad = match isel.request_pad_simple(&format!("sink_{pad_index}")) {
        Some(p) => p,
        None => {
            let elements = [
                branch.videoconvert.clone(),
                branch.videoscale.clone(),
                branch.videorate.clone(),
                branch.caps.clone(),
            ];
            remove_elements(pipeline, &elements);
            remove_mxl_video_input(pipeline, branch.mxl_input);
            return Err(format!("isel: request sink_{pad_index} failed"));
        }
    };
    if let Err(e) = branch
        .caps
        .static_pad("src")
        .ok_or_else(|| "input capsfilter: no src pad".to_string())
        .and_then(|p| p.link(&pad).map_err(|e| format!("link input {pad_index} to isel: {e}")))
    {
        isel.release_request_pad(&pad);
        let elements = [
            branch.videoconvert.clone(),
            branch.videoscale.clone(),
            branch.videorate.clone(),
            branch.caps.clone(),
        ];
        remove_elements(pipeline, &elements);
        remove_mxl_video_input(pipeline, branch.mxl_input);
        return Err(e);
    }

    Ok((pad, branch))
}

/// Tauscht die Auflösung eines einzelnen, bereits laufenden
/// Eingangs-Zweigs aus, während die Pipeline PLAYING bleibt — kein
/// Neuaufbau der übrigen Pipeline, andere Eingänge/der PGM-Ausgang
/// bleiben unberührt. Technik: ein blockierender Pad-Probe
/// (`PadProbeType::BLOCK_DOWNSTREAM`) auf dem `isel`-Sink-Pad dieses
/// Eingangs, **nur um ihn gefahrlos zu entlinken** — sobald der Probe
/// feuert, ist garantiert kein Datenfluss mehr über diesen Pad
/// unterwegs, genau in diesem Moment (und nur dafür) wird entlinkt. Der
/// eigentliche Auf-/Abbau (alten Zweig abbauen, neuen Zweig bauen +
/// wieder anlinken) passiert **danach**, zurück auf dem aufrufenden
/// Kontroll-Thread — nicht mehr innerhalb des Callbacks, s. u.
///
/// **Zwei live gefundene, echte Bugs, jetzt behoben, nicht nur
/// umschifft:**
/// 1. **Absturz (Segfault):** ein erster Versuch baute den alten Zweig
///    (`set_state(Null)` + `remove`) noch **innerhalb** des
///    Probe-Callbacks ab — der Callback läuft aber genau auf dem
///    Streaming-Thread, den dieser Zweig selbst antreibt (der
///    `MxlVideoInput`-Push-Thread läuft ungepuffert bis zum
///    `isel`-Sink-Pad durch). `set_state(Null)` wartet synchron auf das
///    Ende genau dieses Threads — von ihm selbst aus aufgerufen ein
///    garantierter Deadlock, live als Segfault beim zweiten Umschalten
///    reproduziert.
/// 2. **Unbegrenzter Speicherverbrauch, selbst nach nur einem einzigen
///    Swap weiterwachsend, ganz ohne weitere Kommandos:** ein zweiter
///    Versuch behob (1), baute den **neuen** Zweig aber weiterhin
///    innerhalb des Callbacks (`build_branch` inkl.
///    `sync_state_with_parent`) — Elemente in einer laufenden Pipeline
///    synchron auf `PLAYING` zu heben, während gleichzeitig ein anderer
///    Pad derselben Pipeline blockiert gehalten wird, brachte
///    offenbar GStreamers eigene Zustandsmaschine in einen Zustand, in
///    dem irgendwo unbegrenzt nachgefordert wurde (per `RSS`-Messung
///    bestätigt: aktives Weiterwachsen 20s nach einem einzelnen Swap
///    ganz ohne Folgekommandos, bei gleichbleibender Thread-Zahl — kein
///    Thread-Leck, sondern eine aktiv weiterlaufende Zuteilung
///    irgendwo in der GStreamer-/Glib-Ebene). Ohne Profiling-Werkzeuge
///    (kein `valgrind`/`heaptrack` in dieser Sandbox verfügbar) nicht
///    bis auf die letzte C-Zeile zurückverfolgt, aber durch gezielte
///    Isolation zweifelsfrei auf "Elementaufbau/Zustandswechsel
///    innerhalb eines blockierten Callbacks" eingegrenzt (ohne jeden
///    Swap: RSS über 20s Leerlauf konstant; mit Elementaufbau
///    **innerhalb** des Callbacks: RSS wächst nach einem einzigen Swap
///    unbegrenzt weiter). Der Callback tut jetzt **ausschließlich**
///    das Entlinken — jeder Element-Auf-/Abbau (inkl. `set_state`)
///    passiert strikt auf dem Kontroll-Thread, außerhalb jedes
///    Pad-Probes, exakt wie beim bereits bewährten vollständigen
///    Rebuild (`build`/`build_one_input`).
///
/// **Bekannte, bewusst in Kauf genommene Einschränkung:** schlägt der
/// Aufbau des neuen Zweigs fehl, bleibt der `isel`-Sink-Pad bis zum
/// nächsten vollständigen Rebuild (`Command::SetInputs`) unverlinkt,
/// dieser Eingang also ohne Bild. Nur erreichbar, wenn der Aufbau des
/// **neuen** Zweigs fehlschlägt, **nachdem** der Pad-Unlink bereits
/// bestätigt wurde (`Err(.., None)` unten) — z. B. wenn genau der
/// Ziel-Flow zwischen Entdeckung und Swap verschwindet (derselbe Fall,
/// den auch ein Neuaufbau nicht anders lösen könnte).
///
/// **Live gefundener dritter Bug (unter Dauerlast, `--nocapture`-
/// Stresstest mit ~100 Umschaltungen in schneller Folge):** schlägt
/// bereits der **erste** Schritt fehl (Timeout beim Warten auf die
/// Pad-Block-Bestätigung — passiert, wenn der betroffene Zweig gerade
/// keine Puffer liefert, z. B. weil sein Lowres-Begleit-Flow noch nicht
/// zu schreiben begonnen hat), war `old_branch` in einer ersten Fassung
/// einfach als Funktionsparameter verworfen worden — **weder** wieder
/// in `p.branches` eingetragen (der Eingang blieb ab dann für immer als
/// "kein Swap nötig" markiert, obwohl seine tatsächliche Auflösung nie
/// wechselte) **noch** ordentlich abgebaut (seine acht Elemente blieben
/// für immer in der Pipeline registriert, derselbe Speicherverbrauchs-
/// Fehler wie beim zweiten Bug oben, hier aber unabhängig davon). Der
/// Rückgabetyp gibt den unangetasteten `old_branch` deshalb im
/// Fehlerfall explizit zurück, sofern er noch existiert (`Err(msg,
/// Some(old_branch))`) — der Aufrufer trägt ihn dann unverändert wieder
/// in `p.branches` ein, exakt der Zustand vor dem Versuch.
#[allow(clippy::too_many_arguments)]
fn swap_input_resolution(
    pipeline: &gst::Pipeline,
    context: Arc<MxlContext>,
    isel_sink_pad: &gst::Pad,
    input: DiscoveredInput,
    target_flow_id: String,
    pad_index: usize,
    width: u32,
    height: u32,
    old_branch: InputBranch,
) -> Result<InputBranch, Box<(String, Option<InputBranch>)>> {
    let (unblocked_tx, unblocked_rx) = std::sync::mpsc::sync_channel::<()>(1);
    let task = Mutex::new(Some(unblocked_tx));

    let probe_id = isel_sink_pad.add_probe(gst::PadProbeType::BLOCK_DOWNSTREAM, move |pad, _info| {
        let Some(unblocked_tx) = task.lock().expect("lock poisoned").take() else {
            return gst::PadProbeReturn::Remove;
        };
        if let Some(peer) = pad.peer() {
            let _ = peer.unlink(pad);
        }
        let _ = unblocked_tx.send(());
        gst::PadProbeReturn::Remove
    });

    if probe_id.is_none() {
        return Err(Box::new(("add_probe (BLOCK_DOWNSTREAM) fehlgeschlagen".to_string(), Some(old_branch))));
    }

    if unblocked_rx.recv_timeout(SWAP_BLOCK_TIMEOUT).is_err() {
        // Der Probe hat nie ausgelöst — der alte Zweig liefert
        // vermutlich gerade keine Puffer (s. Funktionsdoku). Nichts
        // wurde bislang verändert: `old_branch` unangetastet
        // zurückgeben, statt ihn stillschweigend zu verwerfen.
        return Err(Box::new(("Timeout beim Warten auf den blockierten Pad-Unlink".to_string(), Some(old_branch))));
    }

    // Ab hier: Pad ist entlinkt und (per `PadProbeReturn::Remove` im
    // Callback) bereits wieder freigegeben — kein Datenfluss über ihn,
    // aber auch keine Blockade mehr aktiv. Alle folgenden Schritte
    // laufen ganz normal auf diesem (Kontroll-)Thread, genau wie beim
    // vollständigen Rebuild. Ab hier gibt es kein Zurück mehr zu
    // `old_branch` (bereits entlinkt) — jeder weitere Fehlschlag liefert
    // `None` zurück, der Eingang bleibt bis zum nächsten
    // `Command::SetInputs` ohne Bild (s. Funktionsdoku).
    let old_elements = [
        old_branch.videoconvert.clone(),
        old_branch.videoscale.clone(),
        old_branch.videorate.clone(),
        old_branch.caps.clone(),
    ];
    remove_elements(pipeline, &old_elements);
    remove_mxl_video_input(pipeline, old_branch.mxl_input);

    // Gleiche Wartezeit wie beim vollständigen Rebuild (`OLD_WRITER_
    // DRAIN`-Doku oben) und aus demselben Grund: `MxlVideoInput::drop`
    // setzt nur das Stop-Flag, der eigentliche Lese-Thread (und damit
    // die Freigabe seines MXL-`FlowReader`) endet erst mit etwas
    // Verzug. Unter sehr schneller, wiederholter Auswahl auf denselben
    // Ziel-Flow (weit jenseits menschlicher Klick-Geschwindigkeit) sonst
    // live beobachtet: mehrere überlappende Reader auf demselben Flow —
    // exakt die bereits an anderer Stelle dokumentierte MXL-Mehrfach-
    // Leser-Gefahrenzone (`docs/decisions.md`, "MXL-Read-Livelock").
    std::thread::sleep(OLD_WRITER_DRAIN);

    let branch = build_branch(pipeline, &context, &target_flow_id, &input.sender_id, pad_index, width, height)
        .map_err(|e| Box::new((e, None)))?;
    match branch
        .caps
        .static_pad("src")
        .ok_or_else(|| "input capsfilter: no src pad".to_string())
        .and_then(|p| p.link(isel_sink_pad).map_err(|e| format!("link input {pad_index} to isel: {e}")))
    {
        Ok(_) => Ok(branch),
        Err(e) => {
            let elements = [
                branch.videoconvert.clone(),
                branch.videoscale.clone(),
                branch.videorate.clone(),
                branch.caps.clone(),
            ];
            remove_elements(pipeline, &elements);
            remove_mxl_video_input(pipeline, branch.mxl_input);
            Err(Box::new((e, None)))
        }
    }
}

fn build(
    context: &Arc<MxlContext>,
    config: &Config,
    inputs: &[DiscoveredInput],
    active: &Option<String>,
) -> Result<(ActivePipeline, Vec<String>), String> {
    let pipeline = gst::Pipeline::new();

    let isel = gst::ElementFactory::make("input-selector")
        .name("isel")
        .property("sync-streams", false)
        .build()
        .map_err(|e| format!("input-selector: {e}"))?;
    pipeline.add(&isel).map_err(|e| format!("add isel: {e}"))?;

    let black_src = gst::ElementFactory::make("videotestsrc")
        .property("is-live", true)
        .build()
        .map_err(|e| format!("videotestsrc (black): {e}"))?;
    black_src.set_property_from_str("pattern", "black");
    let black_caps = gst::ElementFactory::make("capsfilter")
        .property("caps", video_caps(config.width, config.height))
        .build()
        .map_err(|e| format!("capsfilter (black): {e}"))?;
    pipeline
        .add(&black_src)
        .and_then(|()| pipeline.add(&black_caps))
        .map_err(|e| format!("add black branch: {e}"))?;
    gst::Element::link_many([&black_src, &black_caps]).map_err(|e| format!("link black branch: {e}"))?;
    let black_pad = isel.request_pad_simple("sink_0").ok_or("isel: request sink_0 failed")?;
    black_caps
        .static_pad("src")
        .ok_or("black capsfilter: no src pad")?
        .link(&black_pad)
        .map_err(|e| format!("link black branch to isel: {e}"))?;

    let mut source_pads = HashMap::with_capacity(inputs.len());
    let mut branches = HashMap::with_capacity(inputs.len());
    let mut warnings = Vec::new();
    for (i, input) in inputs.iter().enumerate() {
        let pad_index = i + 1;
        match build_one_input(&pipeline, context, &isel, input, pad_index, config.width, config.height, active) {
            Ok((pad, branch)) => {
                source_pads.insert(input.sender_id.clone(), pad);
                branches.insert(input.sender_id.clone(), branch);
            }
            Err(e) => {
                warnings.push(format!("input {} ({}) übersprungen: {e}", input.sender_id, input.label));
            }
        }
    }

    let mxl_output = MxlVideoOutput::new(
        &pipeline,
        &isel,
        context.clone(),
        &config.flow_id,
        &config.label,
        config.width,
        config.height,
        FRAMERATE_NUMERATOR,
        FRAMERATE_DENOMINATOR,
    )
    .map_err(|e| format!("MxlVideoOutput: {e}"))?;
    mxl_output.set_active(true);
    let flowed = mxl_output.flowed_handle();

    pipeline.set_state(gst::State::Playing).map_err(|e| format!("set state playing: {e}"))?;

    Ok((
        ActivePipeline {
            pipeline,
            isel,
            black_pad,
            source_pads,
            branches,
            _mxl_output: mxl_output,
            flowed,
        },
        warnings,
    ))
}

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

/// Läuft auf einem eigenen Thread (analog `omp-source`/`omp-viewer`s
/// `pipeline::run`): baut sofort eine erste Pipeline ohne Quellen
/// (Schwarzbild-Fallback läuft ab dem ersten Moment), wartet danach auf
/// `Command`s.
pub fn run(
    config: Config,
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

    let flowed_slot: Arc<Mutex<Option<Arc<AtomicBool>>>> = Arc::new(Mutex::new(None));

    let mut current_inputs: Vec<DiscoveredInput> = Vec::new();
    let mut selected: Option<String> = None;
    let mut active = match build(&context, &config, &current_inputs, &selected) {
        Ok((p, _warnings)) => {
            *flowed_slot.lock().expect("lock poisoned") = Some(p.flowed.clone());
            Some(p)
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("initial build failed: {e}")));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        flowed: flowed_slot.clone(),
    }));

    // Ein-Kommando-Vorschaupuffer für die `Select`-Bündelung unten (statt
    // eines `mpsc::Receiver`-"Zurücklegens", das der Kanaltyp nicht
    // anbietet).
    let mut pending: Option<Command> = None;

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        let received = match pending.take() {
            Some(cmd) => Ok(cmd),
            None => commands_rx.recv_timeout(Duration::from_millis(500)),
        };
        match received {
            Ok(Command::SetInputs(inputs)) => {
                if inputs_changed(&current_inputs, &inputs) {
                    // current_inputs merkt sich den *versuchten* Stand,
                    // auch wenn der Rebuild unten fehlschlägt — verhindert
                    // Rebuild-Spam bei jedem 2s-Poll, solange die
                    // Registry denselben (kaputten, z. B. verwaisten)
                    // Stand meldet; ein späterer, tatsächlich
                    // abweichender Poll (Quelle verschwindet endgültig
                    // aus der Registry) löst dann erneut aus.
                    current_inputs = inputs;
                    // Alte Pipeline zuerst abbauen (Drop stoppt die
                    // Reader-Threads + setzt State Null), bevor der neue
                    // MxlVideoOutput denselben flow_id erneut öffnet.
                    active = None;
                    std::thread::sleep(OLD_WRITER_DRAIN);
                    match build(&context, &config, &current_inputs, &selected) {
                        Ok((p, warnings)) => {
                            for w in warnings {
                                let _ = tx.send(Event::Error(w));
                            }
                            let applied = apply_selection(&p, &selected);
                            *flowed_slot.lock().expect("lock poisoned") = Some(p.flowed.clone());
                            active = Some(p);
                            let _ = tx.send(Event::ActiveChanged(applied));
                        }
                        Err(e) => {
                            // Ein einzelner kaputter/verwaister Eingang
                            // (z. B. Registry-Eintrag eines gerade erst
                            // beendeten Nodes, noch nicht per
                            // registration_expiry_interval verfallen)
                            // darf den Switcher nicht abschießen — der
                            // Ausgang muss laut C7 auch bei null Quellen
                            // laufen. Fallback auf eine Schwarzbild-
                            // Pipeline statt den Thread zu beenden.
                            let _ = tx.send(Event::Error(format!(
                                "rebuild with {} inputs failed: {e} — falling back to black",
                                current_inputs.len()
                            )));
                            match build(&context, &config, &[], &selected) {
                                Ok((p, _warnings)) => {
                                    let applied = apply_selection(&p, &selected);
                                    *flowed_slot.lock().expect("lock poisoned") = Some(p.flowed.clone());
                                    active = Some(p);
                                    let _ = tx.send(Event::ActiveChanged(applied));
                                }
                                Err(e2) => {
                                    let _ = tx.send(Event::Error(format!(
                                        "fallback black-only build also failed: {e2}"
                                    )));
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Ok(Command::Select(sender_id)) => {
                // Live gefundener OOM-Absturz unter künstlichem
                // Stresstest (weit außerhalb menschlicher Klick-
                // Geschwindigkeit, `docs/decisions.md`): eine schnelle
                // Serie von `Select`-Kommandos verarbeitete bislang
                // **jedes** einzeln, inklusive je bis zu zwei
                // Auflösungs-Hot-Swap-Versuchen mit bis zu
                // `SWAP_BLOCK_TIMEOUT` Wartezeit — Kommandos stauten sich
                // schneller im Kanal, als sie verarbeitet werden
                // konnten. Fachlich zählt bei einer Serie ohnehin nur
                // das **letzte** Ziel (ein Hart-Umschalter kennt keine
                // Zwischenzustände) — bereits im Kanal wartende weitere
                // `Select`s werden deshalb sofort mit übernommen, nur das
                // letzte davon tatsächlich verarbeitet. Ein dabei
                // angetroffenes `SetInputs` geht nicht verloren (landet
                // in `pending`, s. o., und wird in der nächsten
                // Schleifenrunde regulär bearbeitet).
                let mut sender_id = sender_id;
                loop {
                    match commands_rx.try_recv() {
                        Ok(Command::Select(newer)) => sender_id = newer,
                        Ok(other @ Command::SetInputs(_)) => {
                            pending = Some(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }

                let previous = selected.clone();
                selected = sender_id.clone();

                if let Some(p) = &mut active {
                    // 1. Neues Ziel vor dem eigentlichen Umschalten auf
                    // Highres hochstufen, falls es bisher Lowres war —
                    // PGM darf nie, auch nicht für einen Frame, Lowres
                    // zeigen.
                    if let Some(new_id) = &sender_id
                        && let Some(input) = current_inputs.iter().find(|i| &i.sender_id == new_id) {
                            let target = input.flow_id.clone();
                            let needs_swap = p.branches.get(new_id).is_some_and(|b| b.open_flow_id != target);
                            if needs_swap
                                && let (Some(pad), Some(old_branch)) =
                                    (p.source_pads.get(new_id).cloned(), p.branches.remove(new_id))
                                {
                                    let pad_index = current_inputs.iter().position(|i| &i.sender_id == new_id).map(|i| i + 1).unwrap_or(0);
                                    match swap_input_resolution(
                                        &p.pipeline,
                                        context.clone(),
                                        &pad,
                                        input.clone(),
                                        target,
                                        pad_index,
                                        config.width,
                                        config.height,
                                        old_branch,
                                    ) {
                                        Ok(new_branch) => {
                                            p.branches.insert(new_id.clone(), new_branch);
                                        }
                                        Err(err) => {
                                            let (e, restored) = *err;
                                            // Unangetasteten alten Zweig zurückschreiben, statt
                                            // den Eingang stillschweigend aus der Buchführung
                                            // verschwinden zu lassen (live gefundener Bug, s.
                                            // `swap_input_resolution`-Doku).
                                            if let Some(restored) = restored {
                                                p.branches.insert(new_id.clone(), restored);
                                            }
                                            let _ = tx.send(Event::Error(format!(
                                                "Auflösungs-Swap (Highres) für {new_id} fehlgeschlagen: {e}"
                                            )));
                                        }
                                    }
                                }
                        }

                    // 2. Jetzt erst tatsächlich umschalten.
                    let applied = apply_selection(p, &selected);
                    let _ = tx.send(Event::ActiveChanged(applied));

                    // 3. Vorherigen Eingang danach (best effort, PGM
                    // längst umgeschaltet) auf Lowres herunterstufen,
                    // sofern er einen Begleit-Sender hat und nicht auch
                    // der neue aktive Eingang ist.
                    if let Some(old_id) = &previous
                        && Some(old_id) != sender_id.as_ref()
                            && let Some(input) = current_inputs.iter().find(|i| &i.sender_id == old_id)
                                && let Some(lowres_flow_id) = input.lowres_flow_id.clone() {
                                    let needs_swap =
                                        p.branches.get(old_id).is_some_and(|b| b.open_flow_id != lowres_flow_id);
                                    if needs_swap
                                        && let (Some(pad), Some(old_branch)) =
                                            (p.source_pads.get(old_id).cloned(), p.branches.remove(old_id))
                                        {
                                            let pad_index = current_inputs
                                                .iter()
                                                .position(|i| &i.sender_id == old_id)
                                                .map(|i| i + 1)
                                                .unwrap_or(0);
                                            match swap_input_resolution(
                                                &p.pipeline,
                                                context.clone(),
                                                &pad,
                                                input.clone(),
                                                lowres_flow_id,
                                                pad_index,
                                                config.width,
                                                config.height,
                                                old_branch,
                                            ) {
                                                Ok(new_branch) => {
                                                    p.branches.insert(old_id.clone(), new_branch);
                                                }
                                                Err(err) => {
                                                    let (e, restored) = *err;
                                                    if let Some(restored) = restored {
                                                        p.branches.insert(old_id.clone(), restored);
                                                    }
                                                    let _ = tx.send(Event::Error(format!(
                                                        "Auflösungs-Swap (Lowres) für {old_id} fehlgeschlagen: {e}"
                                                    )));
                                                }
                                            }
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
