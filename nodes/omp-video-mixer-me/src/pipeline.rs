//! GStreamer-Pipeline von `omp-video-mixer-me` (`UMSETZUNG.md` C10,
//! `ARCHITECTURE.md` §13.1) — Crossfade-/DVE-/Keyer-Topologie aus
//! PIPELINE CONTROLLERs `MasterPipeline.js` übernommen (nicht neu
//! erfunden, `UMSETZUNG.md` §0 Punkt 9): `isel` = Programm-Bus (fg),
//! `isel_bg` = Preset-Mirror (bg, während einer Transition sichtbar),
//! `compositor` mit fg auf `zorder=2` über bg auf `zorder=1`, ein
//! Keyer-Layer auf `zorder=3` obenauf. Jeder Eingang wird zweimal per
//! `MxlVideoInput` gelesen (einmal für `isel`, einmal für `isel_bg`) —
//! Spiegel des Vorbilds, das denselben `intervideosrc`-Kanal zweimal
//! liest; MXLs Ring-Buffer ist für mehrere unabhängige Reader ausgelegt
//! (bereits produktiv: `omp-viewer` + `omp-switcher` lesen denselben
//! `omp-source`-Flow prozessübergreifend).
//!
//! **Vereinfachung ggü. dem Vorbild:** dort werden DVE-Box/Alpha über
//! zusätzliche `videobox`/`alpha`-Elemente gesetzt, weil die dortige
//! JS-Bindung (`gst-kit`) `GstCompositorPad`-Properties nur zur Parse-Zeit
//! setzen kann (Kommentar dort: „kann NICHT zur Laufzeit setzen"). Diese
//! Einschränkung gilt für `gstreamer-rs` nicht (siehe `gst-inspect-1.0
//! compositor`: `xpos`/`ypos`/`width`/`height`/`alpha`/`zorder` sind alle
//! `controllable`, zur Laufzeit setzbar) — hier direkt als Properties auf
//! den `comp`-Request-Pads gesetzt, keine Zusatzelemente nötig.
//!
//! **Crosspoint-Semantik:** `select(senderId)` setzt nur die
//! Preset-Bus-Auswahl, ändert das Programmbild nicht. `cut()` schaltet
//! Preset sofort hart auf Programm. `autoTrans()` überblendet über
//! `TRANS_DURATION_MS` in `STEP_MS`-Schritten (40ms ≙ eine Bildperiode
//! @25fps, wie im Vorbild). Läuft bereits eine Transition, werden weitere
//! `cut()`/`autoTrans()`-Aufrufe ignoriert (`fading`-Sperre) — ausreichend
//! fürs manuelle Bedienen; alles darüber hinaus (Warteschlange, weitere
//! Transitionsarten) ist wie volle DVE/Keyer-Tiefe Community-Scope
//! (`UMSETZUNG.md` C10). **Wipe-Transition bewusst nicht implementiert**
//! (kein erprobtes Muster in PIPELINE CONTROLLER vorhanden, `docs/
//! decisions.md` 2026-07-11) — nur Cut + Mix-AutoTrans.
//!
//! **Keyer:** kein Chroma-/Luma-Keying eines externen Eingangs (dafür
//! fehlt im Dev-Sandbox mangels Kamera/Greenscreen-Footage ein
//! sinnvolles Testsignal, `UMSETZUNG.md` §0 Punkt 7), sondern ein
//! DSK-artiger fester Farbflächen-Layer (`videotestsrc
//! pattern=solid-color`), per/via `keyer.setEnabled` ein-/ausblendbar —
//! deckt exakt die C10-Verifikation „Farbfläche über Hintergrund" ab.
//!
//! **Kapitel 15 Teil 3 (Rest 2) rückgebaut (2026-07-23, Viewer-Freeze-
//! Untersuchung):** dieses Modul hatte bis 2026-07-23 einen reaktiven
//! Highres/Lowres-Hot-Swap für nicht-selektierte Eingänge (Pad-Block-
//! Relink zur Laufzeit, analog `omp-switcher::swap_input_resolution`).
//! Nutzerreport "friert nach mehrmaligem Umschnitt zwischen zwei Quellen
//! und Schwarz irgendwann ein" live reproduziert (zwei `omp-source`,
//! Mixer, Viewer, wiederholtes `crosspoint.take` zwischen beiden Quellen
//! und Schwarz — bereits bei realistischem Bedien-Tempo, nicht nur unter
//! künstlichem Dauerfeuer): `comp`s Ausgang blieb nach einer Highres-
//! Promotion permanent auf dem letzten Bildinhalt eingefroren (per
//! `mxl-info` bestätigt — die MXL-Ausgangs-Flow lief mit gesundem,
//! kontinuierlich wachsendem Head-Index weiter, nur der tatsächliche
//! Pixelinhalt änderte sich nie mehr), exakt das seit 2026-07-22 als
//! „Restproblem, NICHT behoben" dokumentierte, nie root-gecauste
//! Verhalten dieses Hot-Swaps (mehrere GStreamer-interne Hypothesen
//! bereits damals geprüft und verworfen, s. `docs/decisions.md`
//! Nachtrag 65). Ein zweiter, unabhängiger Bug im selben Mechanismus
//! (Pad-Wiederverwendung über beliebig viele Swaps ohne
//! `release_request_pad`) wurde in derselben Untersuchung gefunden und
//! wäre für sich genommen behebbar gewesen (Fix kurz im Einsatz: pro
//! Swap einen frischen Pad anfordern) — angesichts des UNGELÖSTEN
//! ersten Bugs im selben Mechanismus aber witzlos, PGM darf niemals
//! einfrieren.
//!
//! **Entscheidung:** die gesamte reaktive Demote/Promote-Maschinerie
//! (`swap_input_resolution`, `retarget_branch`, `promote_to_highres`,
//! `demote_fg_to_lowres`, `demote_bg_to_lowres`, `demote_to_lowres`,
//! `InputBranch::open_flow_id`) ist ersatzlos entfernt. Jeder Zweig
//! bleibt ab jetzt für seine gesamte Lebensdauer in Highres — exakt das
//! bereits seit der „Highres-Start"-Entscheidung vom 2026-07-22 für den
//! initialen Aufbau geltende Verhalten, jetzt einfach dauerhaft statt nur
//! am Build. Ein `SetInputs`-Rebuild (Quellenmenge ändert sich) baut
//! ohnehin schon immer alle Zweige komplett neu auf (nachweislich
//! zuverlässig, s. damalige Doku) — dieser Pfad bleibt der EINZIGE Weg,
//! wie sich der von einem Zweig gelesene Flow noch ändert. Bewusst
//! aufgegeben: die Bandbreiten-/CPU-Einsparung aus Kapitel 15 Teil 2/3
//! für nicht-selektierte Mixer-Eingänge (PGM-Zuverlässigkeit hat
//! Vorrang) — `main.rs`s `activateLowresPreview`/`releaseLowresPreview`-
//! Aktivierung und `DiscoveredInput::lowres_sender_id`/`lowres_flow_id`
//! sind im selben Zug entfernt, da dieses Modul die Lowres-Flows nun nie
//! mehr liest. `omp-switcher`/`omp-multiviewer` sind NICHT betroffen
//! (jeweils eigener, unabhängiger Mechanismus, s. dortige Moduldoku).
//!
//! Unverändert: während einer laufenden `autoTrans()` zeigt
//! `comp_bg_pad` das **ausgehende** Bild noch sichtbar (Alpha rampt erst
//! über `TRANS_DURATION_MS` von 1 auf 0), `isel_bg`s aktiver Pad
//! wechselt erst am Ende des Fades (`spawn_autotrans`) auf den neuen
//! Eingang.

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

/// Eine Bildperiode @25fps — Animationsschrittweite für `autoTrans()`,
/// identisch zu PIPELINE CONTROLLERs `STEP_MS`.
const STEP_MS: u64 = 40;
const TRANS_DURATION_MS: u64 = 1000;

/// Feste DSK-Farbfläche des Keyers (ARGB, big-endian, wie
/// `videotestsrc::foreground-color`): kräftiges Magenta, im Viewer klar
/// vom SMPTE-/Quellbild unterscheidbar.
const KEYER_COLOR_ARGB: u32 = 0xFFFF00FF;

/// Wie beim Switcher (C7): Reader-/Writer-Threads setzen bei `Drop` nur
/// ein Stop-Flag, kein `JoinHandle`. Vor dem Öffnen eines neuen
/// `MxlVideoOutput`-Writers auf denselben `flow_id` (Rebuild) kurz warten,
/// damit nicht zwei Writer-Threads überlappend schreiben.
const OLD_WRITER_DRAIN: Duration = Duration::from_millis(300);

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
    /// IS-04-`device_id` des Senders — Grundlage für die Sender→Device→
    /// Node-Auflösung, die `main.rs` fürs Tally-Event braucht (Tally
    /// zielt auf die Node-Kachel, Discovery liefert nur `device_id`).
    pub device_id: String,
}

/// Ein per NMOS-Device gefundenes Fill+Key-Senderpaar (`main.rs::
/// discover_keyfill`) — Kandidat für den Keyer-DSK-Eingang (§13.1 „Keyer:
/// Chroma/Luma/DSK"). Klarstellung ARCHITECTURE.md 2026-07-12: „ein DSK
/// ist signalflusstechnisch nichts anderes als ein Keyer, der den
/// Programmbus als Hintergrund nimmt und OGrafs Ausgang als Quelle
/// wählt" — `omp-ograf` (Kapitel 5) veröffentlicht genau ein solches Paar
/// (`<Label> Fill` + `<Label> Key`, beide `video/v210`, s. dortige
/// Moduldoku „Teil 2 (Mixer-DSK-Anschluss) compositiert beide
/// zusammen") pro Grafik-Instanz; jede künftige CG-Quelle mit derselben
/// Sender-Namenskonvention wird automatisch mit erkannt.
#[derive(Debug, Clone)]
pub struct DiscoveredKeyFill {
    pub device_id: String,
    /// Basis-Label ohne " Fill"-Suffix (z. B. "OGraf Grafik (27396541)"),
    /// fürs UI-Dropdown.
    pub label: String,
    pub fill_sender_id: String,
    pub fill_flow_id: String,
    pub key_sender_id: String,
    pub key_flow_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DveBox {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl DveBox {
    pub fn full_frame(width: u32, height: u32) -> Self {
        DveBox {
            x: 0,
            y: 0,
            width: width as i32,
            height: height as i32,
        }
    }
}

impl Default for DveBox {
    fn default() -> Self {
        DveBox::full_frame(DEFAULT_WIDTH, DEFAULT_HEIGHT)
    }
}

pub enum Event {
    Error(String),
    /// Programm hat wirklich umgeschaltet (nach `cut()` sofort, nach
    /// `autoTrans()` bei Transitionsbeginn — Tally soll im selben Moment
    /// rot werden, in dem der Operator die Aktion auslöst, nicht erst
    /// wenn die Überblendung optisch fertig ist).
    ProgramChanged {
        previous: Option<String>,
        current: Option<String>,
    },
    PresetChanged(Option<String>),
    DveBoxChanged(DveBox),
    KeyerChanged(bool),
    /// PIP-Layer (Nutzerwunsch 2026-07-22, s. Moduldoku "PIP als
    /// eigenständiger Layer") — gleiches Muster wie `KeyerChanged`.
    PipChanged(bool),
}

enum Command {
    SetInputs(Vec<DiscoveredInput>),
    SelectPreset(Option<String>),
    Cut,
    Take(Option<String>),
    AutoTrans,
    SetDveBox(DveBox),
    ResetDve,
    SetKeyerEnabled(bool),
    SetKeyFillInputs(Vec<DiscoveredKeyFill>),
    SetKeyerSource(Option<String>),
    SetPipEnabled(bool),
    SetPipSource(Option<String>),
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    /// S. `omp-switcher::pipeline::PipelineHandle::flowed` — gleiche
    /// Begründung (Rebuild bei jeder Quellenmengen-Änderung, C10 folgt
    /// demselben Discovery-Muster wie C7).
    flowed: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl PipelineHandle {
    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2): der
    /// Programm-Ausgang produziert immer etwas (mindestens Schwarzbild),
    /// wird also i. d. R. kurz nach jedem (Re-)Build `true`.
    pub fn media_ready(&self) -> bool {
        self.flowed
            .lock()
            .expect("lock poisoned")
            .as_ref()
            .is_some_and(|f| f.load(Ordering::Relaxed))
    }

    pub fn set_inputs(&self, inputs: Vec<DiscoveredInput>) {
        let _ = self.commands.send(Command::SetInputs(inputs));
    }

    pub fn select_preset(&self, sender_id: Option<String>) {
        let _ = self.commands.send(Command::SelectPreset(sender_id));
    }

    pub fn cut(&self) {
        let _ = self.commands.send(Command::Cut);
    }

    /// PGM-Hot-Cut (K3-Teil-2, `docs/END-GOAL-FEATURES.md` §3.5 offene
    /// Frage 1, entschieden 2026-07-16: PGM-Bus-Buttons schalten direkt
    /// um): schaltet das Programm-Bild sofort auf `sender_id`, **ohne**
    /// den gestagten Preset-Wert zu berühren — anders als ein impliziter
    /// `select_preset` + `cut()`-Umweg, der die Preset-Auswahl
    /// überschreiben würde (genau das Risiko, das die ursprüngliche
    /// PGM-„nur Anzeige"-Entscheidung vermeiden wollte).
    pub fn take(&self, sender_id: Option<String>) {
        let _ = self.commands.send(Command::Take(sender_id));
    }

    pub fn auto_trans(&self) {
        let _ = self.commands.send(Command::AutoTrans);
    }

    pub fn set_dve_box(&self, box_: DveBox) {
        let _ = self.commands.send(Command::SetDveBox(box_));
    }

    pub fn reset_dve(&self) {
        let _ = self.commands.send(Command::ResetDve);
    }

    pub fn set_keyer_enabled(&self, enabled: bool) {
        let _ = self.commands.send(Command::SetKeyerEnabled(enabled));
    }

    pub fn set_keyfill_inputs(&self, inputs: Vec<DiscoveredKeyFill>) {
        let _ = self.commands.send(Command::SetKeyFillInputs(inputs));
    }

    /// `fill_sender_id` wählt das Fill+Key-Paar (identifiziert über den
    /// Fill-Sender, s. `DiscoveredKeyFill`), `None` schaltet zurück auf
    /// die synthetische Test-Farbfläche (Default, s. `build`).
    pub fn set_keyer_source(&self, fill_sender_id: Option<String>) {
        let _ = self.commands.send(Command::SetKeyerSource(fill_sender_id));
    }

    /// PIP-Layer (Nutzerwunsch 2026-07-22, s. Moduldoku "PIP als
    /// eigenständiger Layer") — Sichtbarkeit, gleiches Muster wie
    /// `set_keyer_enabled`. `dve.setBox`/`dve.reset` (s. `set_dve_box`/
    /// `reset_dve` oben, unverändert) steuern seither die Box-Geometrie
    /// dieses Layers statt des PGM-Bilds selbst.
    pub fn set_pip_enabled(&self, enabled: bool) {
        let _ = self.commands.send(Command::SetPipEnabled(enabled));
    }

    /// `sender_id` wählt eine beliebige Crosspoint-Quelle (`crosspoint.
    /// inputs`, kein Fill+Key-Paar nötig — PIP zeigt ein normales Bild),
    /// `None` schaltet auf den Schwarzbild-Fallback zurück.
    pub fn set_pip_source(&self, sender_id: Option<String>) {
        let _ = self.commands.send(Command::SetPipSource(sender_id));
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

fn rgba_caps(width: u32, height: u32) -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("format", "RGBA")
        .field("width", width as i32)
        .field("height", height as i32)
        .field(
            "framerate",
            gst::Fraction::new(FRAMERATE_NUMERATOR as i32, FRAMERATE_DENOMINATOR as i32),
        )
        .build()
}

/// Caps für den Fill-Zweig einer `alphacombine`-Kombination — `format`/
/// `colorimetry` bewusst fest verdrahtet (nicht Breite/Höhe: die kommen
/// unverändert vom Quell-Node, z. B. `omp-ograf`s 1280×720, `videoscale`
/// in `build_normalized_branch` skaliert danach auf `config.width`/
/// `config.height`). `colorimetry=bt601` MUSS mit `keyfill_key_caps`
/// übereinstimmen — live gefunden (`gst-launch-1.0`-Minimaltest):
/// `alphacombine` verweigert sonst mit "Color range miss-match" die
/// Verhandlung, selbst wenn Format/Auflösung sonst passen.
fn keyfill_fill_caps() -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("format", "I420")
        .field("colorimetry", "bt601")
        .build()
}

/// S. `keyfill_fill_caps` — `GRAY8` trägt die Key-Ebene (Luma als Alpha-
/// Maske, s. `omp-ograf::pipeline::spawn_alpha_key_bridge`, das dieselbe
/// Kodierung umgekehrt erzeugt).
fn keyfill_key_caps() -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("format", "GRAY8")
        .field("colorimetry", "bt601")
        .build()
}

/// Baut Fill+Key-MXL-Eingänge plus `alphacombine` zu einem einzigen,
/// alpha-tragenden `tail`-Element zusammen — Gegenstück zum synthetischen
/// `videotestsrc pattern=solid-color` (Default ohne gewählte Quelle, s.
/// `build`). Live per `gst-launch-1.0` verifiziert (nicht angenommen):
/// `alphacombine` (Element `codecalpha`-Plugin, GStreamer-Bad,
/// eigentlich für VP8/VP9-Alpha-Codecs gedacht, aber generisch nutzbar)
/// kombiniert eine Fill- mit einer Key-Ebene zu `A420`/`AV12`, das
/// `videoconvert` danach anstandslos nach RGBA mit echtem Pro-Pixel-Alpha
/// wandelt — reines Broadcast-DSK-Verfahren, keine Neuerfindung.
/// Rückgabe: das `alphacombine`-Element selbst (dient `build_normalized_
/// branch` als `tail`, dessen `queue`-Erstglied den nötigen Puffer vor
/// `comp` liefert — dieselbe Begründung wie bei jedem anderen Zweig,
/// `docs/decisions.md` Nachtrag 63) sowie beide `MxlVideoInput`s (müssen
/// über die Lebensdauer der Pipeline am Leben gehalten werden, sonst
/// stirbt ihr `read_loop`-Thread beim `Drop`).
fn build_keyfill_tail(
    pipeline: &gst::Pipeline,
    context: &Arc<MxlContext>,
    keyfill: &DiscoveredKeyFill,
) -> Result<(gst::Element, MxlVideoInput, MxlVideoInput), String> {
    let fill_input = MxlVideoInput::new(pipeline, context.clone(), &keyfill.fill_flow_id)
        .map_err(|e| format!("MxlVideoInput(keyer-fill, {}): {e}", keyfill.fill_sender_id))?;
    let fill_caps = gst::ElementFactory::make("capsfilter")
        .property("caps", keyfill_fill_caps())
        .build()
        .map_err(|e| format!("capsfilter (keyer-fill): {e}"))?;
    pipeline.add(&fill_caps).map_err(|e| format!("add keyer-fill caps: {e}"))?;
    gst::Element::link(&fill_input.tail, &fill_caps).map_err(|e| format!("link keyer-fill caps: {e}"))?;

    let key_input = MxlVideoInput::new(pipeline, context.clone(), &keyfill.key_flow_id)
        .map_err(|e| format!("MxlVideoInput(keyer-key, {}): {e}", keyfill.key_sender_id))?;
    let key_caps = gst::ElementFactory::make("capsfilter")
        .property("caps", keyfill_key_caps())
        .build()
        .map_err(|e| format!("capsfilter (keyer-key): {e}"))?;
    pipeline.add(&key_caps).map_err(|e| format!("add keyer-key caps: {e}"))?;
    gst::Element::link(&key_input.tail, &key_caps).map_err(|e| format!("link keyer-key caps: {e}"))?;

    let alphacombine = gst::ElementFactory::make("alphacombine")
        .build()
        .map_err(|e| format!("alphacombine: {e}"))?;
    pipeline.add(&alphacombine).map_err(|e| format!("add alphacombine: {e}"))?;

    let alpha_sink_pad = alphacombine.static_pad("sink").ok_or("alphacombine: no sink pad")?;
    let alpha_alpha_pad = alphacombine.static_pad("alpha").ok_or("alphacombine: no alpha pad")?;
    fill_caps
        .static_pad("src")
        .ok_or("keyer-fill caps: no src pad")?
        .link(&alpha_sink_pad)
        .map_err(|e| format!("link fill to alphacombine: {e}"))?;
    key_caps
        .static_pad("src")
        .ok_or("keyer-key caps: no src pad")?
        .link(&alpha_alpha_pad)
        .map_err(|e| format!("link key to alphacombine: {e}"))?;

    Ok((alphacombine, fill_input, key_input))
}

/// Ein normalisierter Zweig (`videoconvert ! videoscale ! videorate !
/// capsfilter(rgba)`) vor einem `input-selector`-Sink-Pad — gemeinsame
/// Bauvorschrift für Programm- und Preset-Zweig eines Eingangs. Gibt neben
/// dem `capsfilter` (Anschlusspunkt für den Aufrufer) auch alle vier
/// selbst hinzugefügten Elemente zurück, damit ein Aufrufer, der diesen
/// einen Zweig später wieder verwerfen muss (s. `build_one_input`), sie
/// gezielt aus der Pipeline entfernen kann statt sie verwaisen zu lassen.
fn build_normalized_branch(
    pipeline: &gst::Pipeline,
    tail: &gst::Element,
    name_suffix: &str,
    width: u32,
    height: u32,
) -> Result<(gst::Element, Vec<gst::Element>), String> {
    // `queue` zwischen `tail` und der Konvertierungskette: ohne ein
    // pufferndes Element hier beantwortet keins der nachgelagerten
    // Elemente (videoconvert/-scale/-rate sind reine GstBaseTransforms,
    // reichen Latenz-Queries unveraendert durch) die Latenz-Query des
    // `compositor`s (`GstAggregator`) mit einer endlichen Max-Latenz —
    // live gefunden per `GST_DEBUG=3`: "input-selector: minimum latency
    // bigger than maximum latency" / "aggregator: Impossible to configure
    // latency: max 0:00:00.000000000 < min 0:00:00.080000000. Add queues
    // or other buffering elements." (genau das von GStreamer selbst
    // vorgeschlagene Mittel). Ohne gueltige Latenzkonfiguration verwirft
    // der `compositor` jeden ankommenden Puffer als verspaetet — PGM
    // bleibt dauerhaft schwarz, obwohl `appsrc`/`MxlVideoInput` nachweislich
    // (per `mxl-info`) durchgehend echte Frames liefert. `leaky=downstream`
    // + kleines `max-size-buffers` haelt die Latenz trotzdem niedrig, kein
    // Live-Rueckstau.
    let queue = gst::ElementFactory::make("queue")
        .property_from_str("leaky", "downstream")
        .property("max-size-buffers", 3u32)
        .property("max-size-bytes", 0u32)
        .property("max-size-time", 0u64)
        .build()
        .map_err(|e| format!("queue ({name_suffix}): {e}"))?;
    let videoconvert = gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(|e| format!("videoconvert ({name_suffix}): {e}"))?;
    let videoscale = gst::ElementFactory::make("videoscale")
        .build()
        .map_err(|e| format!("videoscale ({name_suffix}): {e}"))?;
    let videorate = gst::ElementFactory::make("videorate")
        .build()
        .map_err(|e| format!("videorate ({name_suffix}): {e}"))?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", rgba_caps(width, height))
        .build()
        .map_err(|e| format!("capsfilter ({name_suffix}): {e}"))?;

    pipeline
        .add(&queue)
        .and_then(|()| pipeline.add(&videoconvert))
        .and_then(|()| pipeline.add(&videoscale))
        .and_then(|()| pipeline.add(&videorate))
        .and_then(|()| pipeline.add(&caps))
        .map_err(|e| format!("add branch elements ({name_suffix}): {e}"))?;
    gst::Element::link_many([tail, &queue, &videoconvert, &videoscale, &videorate, &caps])
        .map_err(|e| format!("link branch ({name_suffix}): {e}"))?;

    Ok((caps.clone(), vec![queue, videoconvert, videoscale, videorate, caps]))
}

/// Entfernt zuvor per `pipeline.add()` hinzugefügte Elemente wieder
/// (`Null`-Zustand + `remove`) — Aufräumen für einen einzelnen, verworfenen
/// Eingang, s. `build_one_input`. Gleicher Verwaisungs-Schutz wie in
/// `omp-mediaio::mxl` (`docs/decisions.md` 2026-07-16 "Nachtrag 2",
/// Registry-Geist-OOM).
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
/// Auflösungs-Hot-Swap, `swap_input_resolution`). Identisch zu
/// `omp-switcher::pipeline::remove_mxl_video_input`.
fn remove_mxl_video_input(pipeline: &gst::Pipeline, mxl_input: MxlVideoInput) {
    // Live gefundener Bug (Nutzerreport "Viewer schwarz, hohe Latenz bei
    // PGM-Umschaltung"): `stop()` MUSS vor `remove_elements` laufen, nicht
    // erst über das `drop(mxl_input)` danach — sonst rennt der
    // `read_loop`-Thread noch `push_buffer()` gegen ein `appsrc`, das der
    // Kontroll-Thread hier gerade auf `Null` setzt/aus der Pipeline
    // entfernt (per `GST_DEBUG=3` bestätigt: `<appsrcN>: streaming
    // stopped, reason not-linked`, gefolgt von einem GStreamer-eigenen
    // "Unexpected item dequeued ... refcounting problem?" in einer
    // völlig anderen Queue). Der kurze Schlaf gibt dem Thread eine
    // realistische Chance, seine laufende Schleifen-Iteration noch vor
    // `remove_elements` zu beenden (s. `MxlVideoInput::stop`-Doku für
    // Details, warum das kein reines Zeit-Raten ist).
    mxl_input.stop();
    std::thread::sleep(Duration::from_millis(20));
    remove_elements(pipeline, &mxl_input.elements);
    drop(mxl_input);
}

/// Ein einzelner Zweig (fg **oder** bg) genau eines Eingangs: `MxlVideoInput`
/// plus die normalisierende Konvertierungskette (`build_normalized_branch`),
/// **nicht** an `isel`/`isel_bg` verlinkt — das entscheidet der jeweilige
/// Aufrufer (`build_one_input`). Bleibt für seine gesamte Lebensdauer in
/// Highres (s. Moduldoku "Kapitel 15 Teil 3 (Rest 2) rückgebaut") — kein
/// Hot-Swap-Ziel mehr, deshalb anders als `omp-switcher::pipeline::
/// InputBranch` ohne `open_flow_id`-Feld.
struct InputBranch {
    mxl_input: MxlVideoInput,
    queue: gst::Element,
    videoconvert: gst::Element,
    videoscale: gst::Element,
    videorate: gst::Element,
    caps: gst::Element,
}

/// Baut einen `InputBranch` (`MxlVideoInput` + Konvertierungskette),
/// räumt bei jedem Fehlschlag vollständig auf, was diese Funktion selbst
/// bereits angelegt hat — gleicher Verwaisungs-Schutz wie überall sonst
/// in diesem Modul. `sync_state_with_parent` ist beim Erstaufbau (Pipeline
/// wechselt erst danach auf `PLAYING`) ein No-Op.
fn build_input_branch(
    pipeline: &gst::Pipeline,
    context: &Arc<MxlContext>,
    read_flow_id: &str,
    sender_id: &str,
    name_suffix: &str,
    width: u32,
    height: u32,
) -> Result<InputBranch, String> {
    let mxl_input = MxlVideoInput::new(pipeline, context.clone(), read_flow_id)
        .map_err(|e| format!("MxlVideoInput({name_suffix}, {sender_id}): {e}"))?;
    let (_, elements) = match build_normalized_branch(pipeline, &mxl_input.tail, name_suffix, width, height) {
        Ok(r) => r,
        Err(e) => {
            remove_mxl_video_input(pipeline, mxl_input);
            return Err(e);
        }
    };
    for el in &elements {
        if let Err(e) = el.sync_state_with_parent() {
            remove_elements(pipeline, &elements);
            remove_mxl_video_input(pipeline, mxl_input);
            return Err(format!("sync_state_with_parent ({name_suffix}): {e}"));
        }
    }
    let [queue, videoconvert, videoscale, videorate, caps]: [gst::Element; 5] =
        elements.try_into().expect("build_normalized_branch always returns exactly 5 elements");
    Ok(InputBranch {
        mxl_input,
        queue,
        videoconvert,
        videoscale,
        videorate,
        caps,
    })
}

/// Baut den Elemente-Satz eines `InputBranch` vollständig ab (Gegenstück
/// zu `build_input_branch`).
fn teardown_branch(pipeline: &gst::Pipeline, branch: InputBranch) {
    let elements = [
        branch.queue.clone(),
        branch.videoconvert.clone(),
        branch.videoscale.clone(),
        branch.videorate.clone(),
        branch.caps.clone(),
    ];
    remove_elements(pipeline, &elements);
    remove_mxl_video_input(pipeline, branch.mxl_input);
}

/// Verlinkt einen bereits gebauten `InputBranch` auf einen bereits per
/// `request_pad_simple` reservierten `isel`-/`isel_bg`-Sink-Pad.
fn link_branch_to_pad(branch: &InputBranch, pad: &gst::Pad) -> Result<(), String> {
    branch
        .caps
        .static_pad("src")
        .ok_or_else(|| "branch capsfilter: no src pad".to_string())
        .and_then(|p| p.link(pad).map(|_| ()).map_err(|e| format!("link branch to isel: {e}")))
}

/// Baut fg+bg-Zweig für genau einen Eingang. Schlägt irgendein Schritt
/// fehl (z. B. `MxlVideoInput::new` gegen einen Registry-Geist-Sender,
/// dessen Flow bereits per `mxl-info -g` eingesammelt wurde), räumt diese
/// Funktion alles, was sie selbst für DIESEN Eingang bereits angelegt hat,
/// vollständig wieder ab, statt es im (bei anderen Eingängen weiterhin
/// erfolgreichen) `pipeline` verwaisen zu lassen — genau das war die
/// beobachtete OOM-Ursache: ein einzelner kaputter Sender riss früher den
/// GANZEN Build via `?` ab, was den Aufrufer zu wiederholten Voll-
/// Rebuild-Versuchen zwang, von denen jeder erneut denselben Geist traf.
///
/// Beide Zweige (fg + bg) starten immer in Highres — s. Moduldoku
/// "Architekturentscheidung 2026-07-22": Lowres wird ausschließlich
/// reaktiv per Hot-Swap-Demote erreicht, nie am Build.
#[allow(clippy::too_many_arguments)]
fn build_one_input(
    pipeline: &gst::Pipeline,
    context: &Arc<MxlContext>,
    isel: &gst::Element,
    isel_bg: &gst::Element,
    input: &DiscoveredInput,
    pad_index: usize,
    width: u32,
    height: u32,
) -> Result<(gst::Pad, gst::Pad, InputBranch, InputBranch), String> {
    let read_flow_id = input.flow_id.clone();

    let fg_branch = build_input_branch(
        pipeline,
        context,
        &read_flow_id,
        &input.sender_id,
        &format!("input-{pad_index}-fg"),
        width,
        height,
    )?;
    let fg_pad = match isel.request_pad_simple(&format!("sink_{pad_index}")) {
        Some(p) => p,
        None => {
            teardown_branch(pipeline, fg_branch);
            return Err(format!("isel: request sink_{pad_index} failed"));
        }
    };
    if let Err(e) = link_branch_to_pad(&fg_branch, &fg_pad) {
        isel.release_request_pad(&fg_pad);
        teardown_branch(pipeline, fg_branch);
        return Err(e);
    }

    let bg_branch = match build_input_branch(
        pipeline,
        context,
        &read_flow_id,
        &input.sender_id,
        &format!("input-{pad_index}-bg"),
        width,
        height,
    ) {
        Ok(b) => b,
        Err(e) => {
            isel.release_request_pad(&fg_pad);
            teardown_branch(pipeline, fg_branch);
            return Err(e);
        }
    };
    let bg_pad = match isel_bg.request_pad_simple(&format!("sink_{pad_index}")) {
        Some(p) => p,
        None => {
            isel.release_request_pad(&fg_pad);
            teardown_branch(pipeline, fg_branch);
            teardown_branch(pipeline, bg_branch);
            return Err(format!("isel_bg: request sink_{pad_index} failed"));
        }
    };
    if let Err(e) = link_branch_to_pad(&bg_branch, &bg_pad) {
        isel.release_request_pad(&fg_pad);
        isel_bg.release_request_pad(&bg_pad);
        teardown_branch(pipeline, fg_branch);
        teardown_branch(pipeline, bg_branch);
        return Err(e);
    }

    Ok((fg_pad, bg_pad, fg_branch, bg_branch))
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    isel: gst::Element,
    isel_bg: gst::Element,
    black_pad_fg: gst::Pad,
    black_pad_bg: gst::Pad,
    source_pads_fg: HashMap<String, gst::Pad>,
    source_pads_bg: HashMap<String, gst::Pad>,
    comp_fg_pad: gst::Pad,
    comp_bg_pad: gst::Pad,
    comp_keyer_pad: gst::Pad,
    /// PIP-Layer (Nutzerwunsch 2026-07-22, s. Moduldoku "PIP als
    /// eigenständiger Layer"): Box-Geometrie (`apply_dve_box`) trifft
    /// jetzt diesen Pad, nicht mehr `comp_fg_pad` (der bleibt seither
    /// dauerhaft vollflächig).
    comp_pip_pad: gst::Pad,
    /// Nie mehr gelesen seit dem Rückbau des Highres/Lowres-Hot-Swaps
    /// (s. Moduldoku "Kapitel 15 Teil 3 (Rest 2) rückgebaut") — hält die
    /// `InputBranch`en (und damit deren `MxlVideoInput`-Reader-Threads)
    /// für die Lebensdauer der Pipeline am Leben, gleicher Grund wie
    /// `_keyer_keyfill`/`_pip_input` unten.
    _fg_branches: HashMap<String, InputBranch>,
    _bg_branches: HashMap<String, InputBranch>,
    _mxl_output: MxlVideoOutput,
    /// `Some` nur, wenn der Keyer gerade eine echte Fill+Key-Quelle liest
    /// (statt der synthetischen Test-Farbfläche) — hält deren
    /// `MxlVideoInput`s am Leben, sonst stirbt ihr `read_loop`-Thread
    /// beim `Drop` (s. `build_keyfill_tail`).
    _keyer_keyfill: Option<(MxlVideoInput, MxlVideoInput)>,
    /// `Some` nur, wenn PIP gerade eine echte Quelle liest (statt des
    /// Schwarzbild-Fallbacks) — hält deren `MxlVideoInput` am Leben,
    /// gleicher Grund wie `_keyer_keyfill`.
    _pip_input: Option<MxlVideoInput>,
    flowed: Arc<AtomicBool>,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Setzt `isel`s `active-pad` auf den Eingang `selected` (Schwarzbild bei
/// `None` oder unbekannter `senderId`) und liefert die tatsächlich aktiv
/// geschaltete `senderId` zurück.
fn switch_isel(isel: &gst::Element, pads: &HashMap<String, gst::Pad>, black: &gst::Pad, selected: &Option<String>) -> Option<String> {
    let pad = selected
        .as_ref()
        .and_then(|id| pads.get(id).map(|pad| (id.clone(), pad)));
    match pad {
        Some((id, pad)) => {
            isel.set_property("active-pad", pad);
            Some(id)
        }
        None => {
            isel.set_property("active-pad", black);
            None
        }
    }
}

fn apply_dve_box(pad: &gst::Pad, box_: &DveBox) {
    pad.set_property("xpos", box_.x);
    pad.set_property("ypos", box_.y);
    pad.set_property("width", box_.width);
    pad.set_property("height", box_.height);
}

/// Baut den Zuspieler für den PIP-Layer (comp.sink_3, s. Moduldoku "PIP
/// als eigenständiger Layer") — ein einzelner normalisierter Video-Zweig
/// wie fg/bg, **kein** Fill+Key-Paar wie beim Keyer: PIP zeigt ein
/// normales, undurchsichtiges Bild aus einer frei wählbaren Crosspoint-
/// Quelle (`crosspoint.inputs`, nicht `keyer.inputs` — jede entdeckte
/// Quelle ist als PIP-Bild geeignet, nicht nur Fill+Key-Paare). Ohne
/// gewählte Quelle ein Schwarzbild-Fallback, damit ein aktiviertes PIP
/// ohne Quelle eine leere schwarze Box zeigt statt den Build scheitern
/// zu lassen — gleiches Prinzip wie der Keyer ohne gewählte Fill+Key-
/// Quelle (dort Testfarbe statt Schwarz, da dort schon vor dieser
/// Änderung eine synthetische Quelle existierte).
fn build_pip_tail(
    pipeline: &gst::Pipeline,
    context: &Arc<MxlContext>,
    pip_source_input: Option<&DiscoveredInput>,
    width: u32,
    height: u32,
) -> Result<(gst::Element, Option<MxlVideoInput>), String> {
    match pip_source_input {
        Some(input) => {
            let mxl_input = MxlVideoInput::new(pipeline, context.clone(), &input.flow_id)
                .map_err(|e| format!("MxlVideoInput(pip, {}): {e}", input.sender_id))?;
            let (caps, _elements) = build_normalized_branch(pipeline, &mxl_input.tail, "pip", width, height)?;
            Ok((caps, Some(mxl_input)))
        }
        None => {
            let black_src = gst::ElementFactory::make("videotestsrc")
                .property("is-live", true)
                .build()
                .map_err(|e| format!("videotestsrc (pip black): {e}"))?;
            black_src.set_property_from_str("pattern", "black");
            pipeline.add(&black_src).map_err(|e| format!("add pip black source: {e}"))?;
            let (caps, _elements) = build_normalized_branch(pipeline, &black_src, "pip-black", width, height)?;
            Ok((caps, None))
        }
    }
}

/// Baut die Mixer-Pipeline. Ein einzelner kaputter Eingang (z. B. ein
/// Registry-Geist-Sender, s. `build_one_input`) lässt den restlichen
/// Build nicht scheitern — er wird übersprungen und als Eintrag im
/// zweiten Rückgabewert gemeldet, den der Aufrufer (`run()`) als
/// `Event::Error` weiterreicht.
fn build(
    context: &Arc<MxlContext>,
    config: &Config,
    inputs: &[DiscoveredInput],
    keyfill_inputs: &[DiscoveredKeyFill],
    keyer_source: &Option<String>,
    pip_source: &Option<String>,
) -> Result<(ActivePipeline, Vec<String>), String> {
    let pipeline = gst::Pipeline::new();

    let isel = gst::ElementFactory::make("input-selector")
        .name("isel")
        .property("sync-streams", false)
        .build()
        .map_err(|e| format!("input-selector (fg): {e}"))?;
    let isel_bg = gst::ElementFactory::make("input-selector")
        .name("isel_bg")
        .property("sync-streams", false)
        .build()
        .map_err(|e| format!("input-selector (bg): {e}"))?;
    pipeline
        .add(&isel)
        .and_then(|()| pipeline.add(&isel_bg))
        .map_err(|e| format!("add isel: {e}"))?;

    let comp = gst::ElementFactory::make("compositor")
        .name("comp")
        .property_from_str("background", "black")
        // `min-upstream-latency` (GstAggregator-Property, laut eigener
        // GStreamer-Doku fuer genau diesen Fall gedacht: "sources with a
        // higher latency are expected to be plugged in dynamically after
        // the aggregator has started playing", exakt was
        // `swap_input_resolution` bei jedem Highres/Lowres-Hot-Swap tut).
        // Defensive Zusatz-Toleranz — behebt NICHT alleine das in
        // `swap_input_resolution` dokumentierte, noch offene Restproblem
        // (dort ausführlich beschrieben, inkl. Repro-Anleitung); bei
        // Tests mit dieser Property allein (200ms bis 2s) blieb die
        // Fehlerquote nicht bei null. Trotzdem beibehalten als reines
        // Sicherheitsnetz gegen die zwei tatsaechlich behobenen,
        // verwandten Race-Conditions, ohne im Bild sichtbar zu verzögern
        // (reine Aggregator-Toleranz, kein zusätzlicher Puffer
        // in der eigentlichen Pipeline).
        .property("min-upstream-latency", 200_000_000u64)
        .build()
        .map_err(|e| format!("compositor: {e}"))?;
    pipeline
        .add(&comp)
        .map_err(|e| format!("add compositor: {e}"))?;

    // ── Schwarzbild-Fallback, auf beiden Selektoren (fg + bg) verfügbar,
    //    exakt wie im Vorbild (dort black auf isel UND isel_bg gespiegelt).
    let black_src_fg = gst::ElementFactory::make("videotestsrc")
        .property("is-live", true)
        .build()
        .map_err(|e| format!("videotestsrc (black fg): {e}"))?;
    black_src_fg.set_property_from_str("pattern", "black");
    let black_src_bg = gst::ElementFactory::make("videotestsrc")
        .property("is-live", true)
        .build()
        .map_err(|e| format!("videotestsrc (black bg): {e}"))?;
    black_src_bg.set_property_from_str("pattern", "black");
    pipeline
        .add(&black_src_fg)
        .and_then(|()| pipeline.add(&black_src_bg))
        .map_err(|e| format!("add black sources: {e}"))?;
    let (black_caps_fg, _) =
        build_normalized_branch(&pipeline, &black_src_fg, "black-fg", config.width, config.height)?;
    let (black_caps_bg, _) =
        build_normalized_branch(&pipeline, &black_src_bg, "black-bg", config.width, config.height)?;

    let black_pad_fg = isel
        .request_pad_simple("sink_0")
        .ok_or("isel: request sink_0 failed")?;
    black_caps_fg
        .static_pad("src")
        .ok_or("black-fg capsfilter: no src pad")?
        .link(&black_pad_fg)
        .map_err(|e| format!("link black-fg to isel: {e}"))?;
    let black_pad_bg = isel_bg
        .request_pad_simple("sink_0")
        .ok_or("isel_bg: request sink_0 failed")?;
    black_caps_bg
        .static_pad("src")
        .ok_or("black-bg capsfilter: no src pad")?
        .link(&black_pad_bg)
        .map_err(|e| format!("link black-bg to isel_bg: {e}"))?;

    // ── Ein Eingang = zwei unabhängige MXL-Reader (fg + bg), siehe
    //    Modul-Dokumentation. Ein einzelner kaputter Eingang wird
    //    übersprungen (`build_one_input` räumt seinen eigenen Teilbau
    //    selbst ab) statt den ganzen Build abzureißen — s. Funktionsdoku.
    let mut source_pads_fg = HashMap::with_capacity(inputs.len());
    let mut source_pads_bg = HashMap::with_capacity(inputs.len());
    let mut fg_branches = HashMap::with_capacity(inputs.len());
    let mut bg_branches = HashMap::with_capacity(inputs.len());
    let mut warnings = Vec::new();
    for (i, input) in inputs.iter().enumerate() {
        let pad_index = i + 1;
        match build_one_input(
            &pipeline,
            context,
            &isel,
            &isel_bg,
            input,
            pad_index,
            config.width,
            config.height,
        ) {
            Ok((fg_pad, bg_pad, fg_branch, bg_branch)) => {
                source_pads_fg.insert(input.sender_id.clone(), fg_pad);
                source_pads_bg.insert(input.sender_id.clone(), bg_pad);
                fg_branches.insert(input.sender_id.clone(), fg_branch);
                bg_branches.insert(input.sender_id.clone(), bg_branch);
            }
            Err(e) => {
                warnings.push(format!(
                    "input {} ({}) übersprungen: {e}",
                    input.sender_id, input.label
                ));
            }
        }
    }

    // ── comp.sink_0 = Programm (fg, zorder 2). Dauerhaft vollflächig
    //    (Architekturentscheidung 2026-07-22, s. Moduldoku "PIP als
    //    eigenständiger Layer"): PIP verkleinert nicht mehr das PGM-Bild
    //    selbst, sondern ist ein eigener Layer mit eigener Quelle
    //    (comp.sink_3 unten) — `apply_dve_box` trifft seither
    //    `comp_pip_pad`, nie mehr diesen Pad.
    let comp_fg_pad = comp
        .request_pad_simple("sink_0")
        .ok_or("comp: request sink_0 (fg) failed")?;
    comp_fg_pad.set_property("zorder", 2u32);
    comp_fg_pad.set_property("alpha", 1.0f64);
    comp_fg_pad.set_property("xpos", 0i32);
    comp_fg_pad.set_property("ypos", 0i32);
    comp_fg_pad.set_property("width", config.width as i32);
    comp_fg_pad.set_property("height", config.height as i32);
    isel.static_pad("src")
        .ok_or("isel: no src pad")?
        .link(&comp_fg_pad)
        .map_err(|e| format!("link isel to comp.sink_0: {e}"))?;

    // ── comp.sink_1 = Preset-Mirror (bg, zorder 1, während normalem
    //    Betrieb transparent — alpha 0 —, während `autoTrans()` sichtbar).
    let comp_bg_pad = comp
        .request_pad_simple("sink_1")
        .ok_or("comp: request sink_1 (bg) failed")?;
    comp_bg_pad.set_property("zorder", 1u32);
    comp_bg_pad.set_property("alpha", 0.0f64);
    isel_bg
        .static_pad("src")
        .ok_or("isel_bg: no src pad")?
        .link(&comp_bg_pad)
        .map_err(|e| format!("link isel_bg to comp.sink_1: {e}"))?;

    // ── comp.sink_2 = Keyer/DSK (zorder 3, obenauf, alpha vom Aufrufer
    //    nach dem Build per `keyer.enabled`-Zustand gesetzt). Zwei
    //    Varianten: ohne gewählte Fill+Key-Quelle die bisherige
    //    synthetische Test-Farbfläche (kleine, zentrierte Box — reine
    //    Demo-Anzeige, keine echte Keying-Semantik); mit gewählter Quelle
    //    ein echtes Downstream-Key aus Fill+Key-MXL-Flows (`omp-ograf`
    //    o. Ä., s. `build_keyfill_tail`) — vollflächig wie der
    //    Programm-Bus, weil eine reale Grafik/CG-Quelle ihre eigene
    //    Transparenz über die Key-Ebene selbst mitbringt, nicht über eine
    //    vom Mixer vorgegebene Box.
    let keyer_source_input = keyer_source
        .as_ref()
        .and_then(|id| keyfill_inputs.iter().find(|k| &k.fill_sender_id == id));
    let (keyer_tail, keyer_keyfill) = match keyer_source_input {
        Some(kf) => {
            let (tail, fill_input, key_input) = build_keyfill_tail(&pipeline, context, kf)?;
            (tail, Some((fill_input, key_input)))
        }
        None => {
            let keyer_src = gst::ElementFactory::make("videotestsrc")
                .property("is-live", true)
                .property("foreground-color", KEYER_COLOR_ARGB)
                .build()
                .map_err(|e| format!("videotestsrc (keyer): {e}"))?;
            keyer_src.set_property_from_str("pattern", "solid-color");
            pipeline
                .add(&keyer_src)
                .map_err(|e| format!("add keyer source: {e}"))?;
            (keyer_src, None)
        }
    };
    let (keyer_caps, _) =
        build_normalized_branch(&pipeline, &keyer_tail, "keyer", config.width, config.height)?;
    let comp_keyer_pad = comp
        .request_pad_simple("sink_2")
        .ok_or("comp: request sink_2 (keyer) failed")?;
    comp_keyer_pad.set_property("zorder", 3u32);
    comp_keyer_pad.set_property("alpha", 0.0f64);
    if keyer_keyfill.is_some() {
        comp_keyer_pad.set_property("xpos", 0i32);
        comp_keyer_pad.set_property("ypos", 0i32);
        comp_keyer_pad.set_property("width", config.width as i32);
        comp_keyer_pad.set_property("height", config.height as i32);
    } else {
        let keyer_width = (config.width / 3) as i32;
        let keyer_height = (config.height / 3) as i32;
        comp_keyer_pad.set_property("xpos", (config.width as i32 - keyer_width) / 2);
        comp_keyer_pad.set_property("ypos", (config.height as i32 - keyer_height) / 2);
        comp_keyer_pad.set_property("width", keyer_width);
        comp_keyer_pad.set_property("height", keyer_height);
    }
    keyer_caps
        .static_pad("src")
        .ok_or("keyer capsfilter: no src pad")?
        .link(&comp_keyer_pad)
        .map_err(|e| format!("link keyer to comp.sink_2: {e}"))?;

    // ── comp.sink_3 = PIP (Bild-im-Bild, zorder 4, ganz oben —
    //    Architekturentscheidung 2026-07-22, s. Moduldoku "PIP als
    //    eigenständiger Layer"): unabhängig vom PGM-/PST-Bus wählbare
    //    Quelle aus `crosspoint.inputs` (nicht `keyer.inputs` — jede
    //    entdeckte Quelle taugt als PIP-Bild, kein Fill+Key-Paar nötig).
    //    Box-Geometrie kommt vom Aufrufer nach dem Build via
    //    `apply_dve_box` (dieselbe Funktion, die vorher `comp_fg_pad`
    //    traf).
    let pip_source_input = pip_source.as_ref().and_then(|id| inputs.iter().find(|i| &i.sender_id == id));
    let (pip_caps, pip_input) = build_pip_tail(&pipeline, context, pip_source_input, config.width, config.height)?;
    let comp_pip_pad = comp.request_pad_simple("sink_3").ok_or("comp: request sink_3 (pip) failed")?;
    comp_pip_pad.set_property("zorder", 4u32);
    comp_pip_pad.set_property("alpha", 0.0f64);
    pip_caps
        .static_pad("src")
        .ok_or("pip capsfilter: no src pad")?
        .link(&comp_pip_pad)
        .map_err(|e| format!("link pip to comp.sink_3: {e}"))?;

    let comp_out_caps = gst::ElementFactory::make("capsfilter")
        .property("caps", video_caps(config.width, config.height))
        .build()
        .map_err(|e| format!("capsfilter (comp out): {e}"))?;
    pipeline
        .add(&comp_out_caps)
        .map_err(|e| format!("add comp out capsfilter: {e}"))?;
    gst::Element::link(&comp, &comp_out_caps).map_err(|e| format!("link comp to caps: {e}"))?;

    let mxl_output = MxlVideoOutput::new(
        &pipeline,
        &comp_out_caps,
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

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok((
        ActivePipeline {
            pipeline,
            isel,
            isel_bg,
            black_pad_fg,
            black_pad_bg,
            source_pads_fg,
            source_pads_bg,
            comp_fg_pad,
            comp_bg_pad,
            comp_keyer_pad,
            comp_pip_pad,
            _fg_branches: fg_branches,
            _bg_branches: bg_branches,
            _mxl_output: mxl_output,
            _keyer_keyfill: keyer_keyfill,
            _pip_input: pip_input,
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

/// Führt eine Mix-Überblendung von `from` (Programm, aktuell auf fg) nach
/// `to` (Preset, aktuell nur auf bg gespiegelt) auf einem eigenen Thread
/// aus — direkte Pad-Property-Writes (`gst::Pad` ist `Send`+`Sync`,
/// GObject-Properties sind von jedem Thread aus setzbar), damit der
/// Command-Loop währenddessen weiter auf `recv_timeout` reagieren kann
/// (z. B. für einen parallelen `SetInputs`-Rebuild, der zuerst diesen
/// Thread joint). Erwartet, dass der Aufrufer `bg_pad`/`fg_pad`-Alpha
/// bereits synchron auf den Startzustand (bg=1, fg=0) gesetzt UND `isel`
/// bereits auf den neuen Eingang geschaltet hat (Reihenfolge-Grund siehe
/// `Command::AutoTrans`) — dieser Thread startet direkt mit der Rampe.
/// Nach Ablauf: bg stumm schalten (alpha 0), `isel_bg` auf den neuen
/// Programm-Eingang mitziehen (nächste Transition findet dort direkt ein
/// laufendes Bild vor, kein kalter Wechsel).
fn spawn_autotrans(
    fg_pad: gst::Pad,
    bg_pad: gst::Pad,
    isel_bg: gst::Element,
    bg_target_pad: gst::Pad,
    fading: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let steps = (TRANS_DURATION_MS / STEP_MS).max(2);
        let start = std::time::Instant::now();
        for i in 1..=steps {
            let target = Duration::from_millis(TRANS_DURATION_MS * i / steps);
            if let Some(wait) = target.checked_sub(start.elapsed()) {
                std::thread::sleep(wait);
            }
            let t = (start.elapsed().as_millis() as f64 / TRANS_DURATION_MS as f64).min(1.0);
            fg_pad.set_property("alpha", t);
        }
        fg_pad.set_property("alpha", 1.0f64);
        bg_pad.set_property("alpha", 0.0f64);
        isel_bg.set_property("active-pad", &bg_target_pad);

        fading.store(false, Ordering::Release);
    })
}

/// Läuft auf einem eigenen Thread (analog `omp-switcher`s `pipeline::run`).
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
    let mut keyfill_inputs: Vec<DiscoveredKeyFill> = Vec::new();
    let mut keyer_source: Option<String> = None;
    let mut pip_source: Option<String> = None;
    let mut active = match build(&context, &config, &current_inputs, &keyfill_inputs, &keyer_source, &pip_source) {
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
    let mut program: Option<String> = None;
    let mut preset: Option<String> = None;
    let mut dve_box = DveBox::full_frame(config.width, config.height);
    let mut keyer_enabled = false;
    let mut pip_enabled = false;
    let fading = Arc::new(AtomicBool::new(false));
    let fade_thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) =
        std::sync::mpsc::channel();
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        flowed: flowed_slot.clone(),
    }));

    /// Wartet auf einen laufenden Transition-Thread, falls vorhanden —
    /// vor jedem Rebuild nötig, damit der Thread nicht auf Pads einer
    /// bereits zerstörten `ActivePipeline` schreibt.
    fn join_fade(fade_thread: &Arc<Mutex<Option<std::thread::JoinHandle<()>>>>) {
        if let Some(handle) = fade_thread.lock().expect("lock poisoned").take() {
            let _ = handle.join();
        }
    }

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }

        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::SetInputs(inputs)) => {
                if inputs_changed(&current_inputs, &inputs) {
                    current_inputs = inputs;
                    join_fade(&fade_thread);
                    fading.store(false, Ordering::Release);
                    active = None;
                    std::thread::sleep(OLD_WRITER_DRAIN);
                    match build(&context, &config, &current_inputs, &keyfill_inputs, &keyer_source, &pip_source) {
                        Ok((p, warnings)) => {
                            for w in warnings {
                                let _ = tx.send(Event::Error(w));
                            }
                            let applied_program =
                                switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &program);
                            // isel_bg spiegelt außerhalb einer laufenden
                            // Transition immer das Programm (Invariante,
                            // siehe Moduldoku bei `spawn_autotrans`), nicht
                            // die Preset-Auswahl — sonst zeigt die nächste
                            // `autoTrans()` das falsche „Outgoing"-Bild.
                            switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &program);
                            apply_dve_box(&p.comp_pip_pad, &dve_box);
                            p.comp_keyer_pad
                                .set_property("alpha", if keyer_enabled { 1.0f64 } else { 0.0f64 });
                            p.comp_pip_pad
                                .set_property("alpha", if pip_enabled { 1.0f64 } else { 0.0f64 });
                            let previous = program.clone();
                            program = applied_program;
                            *flowed_slot.lock().expect("lock poisoned") = Some(p.flowed.clone());
                            active = Some(p);
                            let _ = tx.send(Event::ProgramChanged {
                                previous,
                                current: program.clone(),
                            });
                        }
                        Err(e) => {
                            // Ein einzelner kaputter/verwaister Eingang darf
                            // den Mixer nicht abschießen — Fallback auf
                            // Schwarzbild-Pipeline statt Threadende (gleiche
                            // Linie wie omp-switcher, C7).
                            let _ = tx.send(Event::Error(format!(
                                "rebuild with {} inputs failed: {e} — falling back to black",
                                current_inputs.len()
                            )));
                            match build(&context, &config, &[], &keyfill_inputs, &keyer_source, &pip_source) {
                                Ok((p, _warnings)) => {
                                    apply_dve_box(&p.comp_pip_pad, &dve_box);
                                    let previous = program.take();
                                    preset = None;
                                    *flowed_slot.lock().expect("lock poisoned") =
                                        Some(p.flowed.clone());
                                    active = Some(p);
                                    let _ = tx.send(Event::ProgramChanged {
                                        previous,
                                        current: None,
                                    });
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
            Ok(Command::SetKeyFillInputs(inputs)) => {
                // Reine Buchführung, kein Rebuild — anders als
                // `SetInputs`s Crosspoint-Kandidaten wird eine gerade
                // NICHT als Keyer-Quelle gewählte Fill+Key-Quelle im
                // laufenden Pipeline-Zustand gar nicht berührt (kein
                // `MxlVideoInput` dafür existiert). Ändert sich die
                // Menge, während eine Quelle AKTIV gewählt ist, greift der
                // neue Stand erst beim nächsten `keyer.setSource`
                // (bewusst einfach gehalten für den ersten Ausbau, s.
                // `docs/decisions.md`).
                keyfill_inputs = inputs;
            }
            Ok(Command::SetKeyerSource(source)) => {
                if keyer_source != source {
                    keyer_source = source;
                    join_fade(&fade_thread);
                    fading.store(false, Ordering::Release);
                    active = None;
                    std::thread::sleep(OLD_WRITER_DRAIN);
                    match build(&context, &config, &current_inputs, &keyfill_inputs, &keyer_source, &pip_source) {
                        Ok((p, warnings)) => {
                            for w in warnings {
                                let _ = tx.send(Event::Error(w));
                            }
                            let applied_program =
                                switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &program);
                            switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &program);
                            apply_dve_box(&p.comp_pip_pad, &dve_box);
                            p.comp_keyer_pad
                                .set_property("alpha", if keyer_enabled { 1.0f64 } else { 0.0f64 });
                            p.comp_pip_pad
                                .set_property("alpha", if pip_enabled { 1.0f64 } else { 0.0f64 });
                            let previous = program.clone();
                            program = applied_program;
                            *flowed_slot.lock().expect("lock poisoned") = Some(p.flowed.clone());
                            active = Some(p);
                            let _ = tx.send(Event::ProgramChanged {
                                previous,
                                current: program.clone(),
                            });
                        }
                        Err(e) => {
                            let _ = tx.send(Event::Error(format!(
                                "keyer source rebuild failed: {e} — falling back to black"
                            )));
                            match build(&context, &config, &[], &keyfill_inputs, &keyer_source, &pip_source) {
                                Ok((p, _warnings)) => {
                                    apply_dve_box(&p.comp_pip_pad, &dve_box);
                                    let previous = program.take();
                                    preset = None;
                                    *flowed_slot.lock().expect("lock poisoned") =
                                        Some(p.flowed.clone());
                                    active = Some(p);
                                    let _ = tx.send(Event::ProgramChanged {
                                        previous,
                                        current: None,
                                    });
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
            // PIP-Layer (Nutzerwunsch 2026-07-22, s. Moduldoku "PIP als
            // eigenständiger Layer") — Quellwechsel, exakt gespiegelt von
            // `SetKeyerSource` oben (voller Rebuild, da eine neue
            // `MxlVideoInput`-Verbindung entsteht), nur ohne Fill+Key-Paar.
            Ok(Command::SetPipSource(source)) => {
                if pip_source != source {
                    pip_source = source;
                    join_fade(&fade_thread);
                    fading.store(false, Ordering::Release);
                    active = None;
                    std::thread::sleep(OLD_WRITER_DRAIN);
                    match build(&context, &config, &current_inputs, &keyfill_inputs, &keyer_source, &pip_source) {
                        Ok((p, warnings)) => {
                            for w in warnings {
                                let _ = tx.send(Event::Error(w));
                            }
                            let applied_program =
                                switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &program);
                            switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &program);
                            apply_dve_box(&p.comp_pip_pad, &dve_box);
                            p.comp_keyer_pad
                                .set_property("alpha", if keyer_enabled { 1.0f64 } else { 0.0f64 });
                            p.comp_pip_pad
                                .set_property("alpha", if pip_enabled { 1.0f64 } else { 0.0f64 });
                            let previous = program.clone();
                            program = applied_program;
                            *flowed_slot.lock().expect("lock poisoned") = Some(p.flowed.clone());
                            active = Some(p);
                            let _ = tx.send(Event::ProgramChanged {
                                previous,
                                current: program.clone(),
                            });
                        }
                        Err(e) => {
                            let _ = tx.send(Event::Error(format!(
                                "pip source rebuild failed: {e} — falling back to black"
                            )));
                            match build(&context, &config, &[], &keyfill_inputs, &keyer_source, &pip_source) {
                                Ok((p, _warnings)) => {
                                    apply_dve_box(&p.comp_pip_pad, &dve_box);
                                    let previous = program.take();
                                    preset = None;
                                    *flowed_slot.lock().expect("lock poisoned") =
                                        Some(p.flowed.clone());
                                    active = Some(p);
                                    let _ = tx.send(Event::ProgramChanged {
                                        previous,
                                        current: None,
                                    });
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
            Ok(Command::SelectPreset(sender_id)) => {
                // Reine Metadaten-Änderung, bewusst ohne Pipeline-
                // Seiteneffekt: `isel_bg` bleibt bis zu `cut()`/
                // `autoTrans()` auf dem Programm stehen (Invariante s.o.)
                // — die Preset-Auswahl wird erst beim Take/AutoTrans
                // wirksam, exakt die Programm-/Preset-Bus-Semantik eines
                // Bildmischers (§13.1).
                preset = sender_id;
                let _ = tx.send(Event::PresetChanged(preset.clone()));
            }
            Ok(Command::Cut) => {
                if fading.load(Ordering::Acquire) {
                    // Laufende Transition sofort abschließen statt
                    // überlagern (einfache Sperre, siehe Moduldoku).
                    continue;
                }
                if let Some(p) = &mut active {
                    let previous = program.clone();
                    let applied = switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &preset);
                    p.comp_fg_pad.set_property("alpha", 1.0f64);
                    p.comp_bg_pad.set_property("alpha", 0.0f64);
                    // isel_bg auf denselben Eingang mitziehen (nächste
                    // Transition findet dort ein laufendes Bild vor).
                    switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &preset);
                    program = applied;
                    let _ = tx.send(Event::ProgramChanged {
                        previous,
                        current: program.clone(),
                    });
                }
            }
            Ok(Command::Take(sender_id)) => {
                // PGM-Hot-Cut: identisch zu `Cut` (sofortiger fg/bg-
                // Pad-Wechsel, kein Fade), aber gegen `sender_id` statt
                // `preset` geschaltet — `preset`/`PresetChanged` bleiben
                // unverändert, exakt die Zusicherung aus `take()`s Doku.
                if fading.load(Ordering::Acquire) {
                    continue;
                }
                if let Some(p) = &mut active {
                    let previous = program.clone();
                    let applied =
                        switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &sender_id);
                    p.comp_fg_pad.set_property("alpha", 1.0f64);
                    p.comp_bg_pad.set_property("alpha", 0.0f64);
                    switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &sender_id);
                    program = applied;
                    let _ = tx.send(Event::ProgramChanged {
                        previous,
                        current: program.clone(),
                    });
                }
            }
            Ok(Command::AutoTrans) => {
                if fading.load(Ordering::Acquire) {
                    continue;
                }
                if let Some(p) = &mut active {
                    if preset == program {
                        // Nichts zu überblenden (Preset == Programm).
                        continue;
                    }
                    let previous = program.clone();
                    // Programm-Zustand gilt sofort als gewechselt (Tally
                    // reagiert im Moment des Auslösens, Moduldoku) — die
                    // sichtbare Überblendung läuft danach asynchron.
                    let target_pad_bg = preset
                        .as_ref()
                        .and_then(|id| p.source_pads_bg.get(id))
                        .cloned()
                        .unwrap_or_else(|| p.black_pad_bg.clone());
                    // Reihenfolge wie im Vorbild (MasterPipeline.js
                    // `xFadeTo`): erst bg sichtbar machen, dann fg
                    // unsichtbar, ERST DANACH isel auf den neuen Eingang
                    // schalten — sonst zeigt ein Frame lang das neue Bild
                    // bei altem (vollem) Alpha, bevor der Thread unten
                    // überhaupt zum Zug kommt.
                    p.comp_bg_pad.set_property("alpha", 1.0f64);
                    p.comp_fg_pad.set_property("alpha", 0.0f64);
                    switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &preset);
                    program = preset.clone();
                    fading.store(true, Ordering::Release);
                    let handle = spawn_autotrans(
                        p.comp_fg_pad.clone(),
                        p.comp_bg_pad.clone(),
                        p.isel_bg.clone(),
                        target_pad_bg,
                        fading.clone(),
                    );
                    *fade_thread.lock().expect("lock poisoned") = Some(handle);
                    let _ = tx.send(Event::ProgramChanged {
                        previous,
                        current: program.clone(),
                    });
                }
            }
            Ok(Command::SetDveBox(box_)) => {
                dve_box = box_;
                if let Some(p) = &active {
                    apply_dve_box(&p.comp_pip_pad, &dve_box);
                }
                let _ = tx.send(Event::DveBoxChanged(dve_box));
            }
            Ok(Command::ResetDve) => {
                dve_box = DveBox::full_frame(config.width, config.height);
                if let Some(p) = &active {
                    apply_dve_box(&p.comp_pip_pad, &dve_box);
                }
                let _ = tx.send(Event::DveBoxChanged(dve_box));
            }
            Ok(Command::SetKeyerEnabled(enabled)) => {
                keyer_enabled = enabled;
                if let Some(p) = &active {
                    p.comp_keyer_pad
                        .set_property("alpha", if enabled { 1.0f64 } else { 0.0f64 });
                }
                let _ = tx.send(Event::KeyerChanged(enabled));
            }
            Ok(Command::SetPipEnabled(enabled)) => {
                pip_enabled = enabled;
                if let Some(p) = &active {
                    p.comp_pip_pad
                        .set_property("alpha", if enabled { 1.0f64 } else { 0.0f64 });
                }
                let _ = tx.send(Event::PipChanged(enabled));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    join_fade(&fade_thread);
    drop(active);
}
