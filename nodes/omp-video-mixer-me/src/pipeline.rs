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
//! **Kapitel 15 Teil 3 (Rest 2): nicht-selektierte Eingänge in Lowres.**
//! Gleiche Technik wie `omp-switcher` (Pad-Block-Hot-Swap,
//! `swap_input_resolution`, dort ausführlich dokumentierte Bug-Historie
//! — hier nicht wiederholt), aber auf **zwei** unabhängige Branch-Pools
//! angewendet (fg/`isel` und bg/`isel_bg`), weil jeder Eingang hier zwei
//! separate `MxlVideoInput`-Leser hat (Moduldoku oben). Regel für beide
//! Pools identisch: Highres nur für den aktuellen `program`-Sender,
//! sonst Lowres (sofern ein Lowres-Begleiter existiert). Eine
//! Besonderheit ggü. dem Switcher: während einer laufenden `autoTrans()`
//! zeigt `comp_bg_pad` das **ausgehende** Bild noch sichtbar (Alpha
//! rampt erst über `TRANS_DURATION_MS` von 1 auf 0), `isel_bg`s
//! aktiver Pad wechselt erst am Ende des Fades (`spawn_autotrans`) auf
//! den neuen Eingang. Der bg-Zweig des zuvor aktiven Programms darf
//! deshalb **nicht** sofort auf Lowres heruntergestuft werden (sichtbarer
//! Auflösungs-Einbruch mitten in der Überblendung) — er wird erst
//! heruntergestuft, sobald `fading` wieder `false` ist
//! (`pending_bg_demote` in `run()`). Der fg-Zweig dagegen kann sofort
//! heruntergestuft werden, weil `isel` bereits zu Transitionsbeginn auf
//! den neuen Eingang umschaltet (der alte fg-Zweig ist ab dann
//! unreferenziert).

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

/// Timeout für den Pad-Block beim Auflösungs-Hot-Swap
/// (`swap_input_resolution`) — identischer Wert/Begründung wie
/// `omp-switcher::pipeline::SWAP_BLOCK_TIMEOUT`.
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
    /// IS-04-`device_id` des Senders — Grundlage für die Sender→Device→
    /// Node-Auflösung, die `main.rs` fürs Tally-Event braucht (Tally
    /// zielt auf die Node-Kachel, Discovery liefert nur `device_id`).
    pub device_id: String,
    /// Kapitel 15 Teil 3 (s. `main.rs::discover`): Sender-ID des
    /// Lowres-Begleiters, nur von `main.rs` für `activateLowresPreview`/
    /// `releaseLowresPreview` gebraucht, hier selbst ungenutzt.
    pub lowres_sender_id: Option<String>,
    /// Flow-ID des Lowres-Begleit-Senders derselben Quelle, sofern per
    /// Grouphint-Tag gefunden. `None` heißt "keiner entdeckt/aktivierbar",
    /// dieser Eingang bleibt dauerhaft Highres (`desired_flow_id`).
    pub lowres_flow_id: Option<String>,
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

/// Welcher Flow für `input` gerade gelesen werden soll: Highres, wenn er
/// der aktuell aktive Programm-Eingang ist oder keinen Lowres-Begleiter
/// hat — sonst Lowres. Identisch zu `omp-switcher::pipeline::
/// desired_flow_id`, hier für **beide** Branch-Pools (fg und bg)
/// gleichermaßen verwendet, s. Moduldoku.
fn desired_flow_id<'a>(input: &'a DiscoveredInput, program: &Option<String>) -> &'a str {
    if program.as_deref() == Some(input.sender_id.as_str()) {
        &input.flow_id
    } else {
        input.lowres_flow_id.as_deref().unwrap_or(&input.flow_id)
    }
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
/// Aufrufer (`build_one_input` beim Erstaufbau, `swap_input_resolution`
/// beim Hot-Swap auf einen bereits existierenden Pad). `open_flow_id`
/// merkt, welcher Flow (Highres/Lowres) gerade tatsächlich offen ist —
/// Vergleichsbasis für den jeweiligen Aufrufer, um unnötige Swaps zu
/// vermeiden. Identisch zu `omp-switcher::pipeline::InputBranch`, hier
/// aber pro Eingang zweimal instanziiert (fg-Pool, bg-Pool, s. Moduldoku).
struct InputBranch {
    mxl_input: MxlVideoInput,
    queue: gst::Element,
    videoconvert: gst::Element,
    videoscale: gst::Element,
    videorate: gst::Element,
    caps: gst::Element,
    open_flow_id: String,
}

/// Baut einen `InputBranch` (`MxlVideoInput` + Konvertierungskette),
/// räumt bei jedem Fehlschlag vollständig auf, was diese Funktion selbst
/// bereits angelegt hat — gleicher Verwaisungs-Schutz wie überall sonst
/// in diesem Modul. `sync_state_with_parent` ist beim Erstaufbau (Pipeline
/// wechselt erst danach auf `PLAYING`) ein No-Op, beim Hot-Swap
/// (`swap_input_resolution`, Pipeline läuft bereits) zwingend nötig.
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
        open_flow_id: read_flow_id.to_string(),
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
/// `program` bestimmt (via `desired_flow_id`) die **Start**-Auflösung
/// beider Zweige: Highres nur, wenn `input` bereits der aktuelle
/// Programm-Eingang ist (z. B. nach einem `SetInputs`-Rebuild bei
/// unverändertem `program`), sonst Lowres.
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
    program: &Option<String>,
) -> Result<(gst::Pad, gst::Pad, InputBranch, InputBranch), String> {
    let read_flow_id = desired_flow_id(input, program).to_string();

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

/// Tauscht die Auflösung eines einzelnen, bereits laufenden Zweigs
/// (fg **oder** bg-Pool) aus, während die Pipeline `PLAYING` bleibt.
/// Identische Pad-Block-Hot-Swap-Technik wie
/// `omp-switcher::pipeline::swap_input_resolution` (dort ausführlich
/// dokumentierte Bug-Historie: Segfault durch `set_state(Null)` vom
/// eigenen Streaming-Thread, unbegrenzter Speicherverbrauch durch
/// Element-Auf-/Abbau innerhalb des blockierten Pad-Probe-Callbacks,
/// verlorene Buchführung bei einem im ersten Schritt fehlschlagenden
/// Swap) — hier nicht wiederholt, gilt unverändert: der Callback tut
/// ausschließlich das Entlinken, jeder Element-Auf-/Abbau passiert
/// strikt auf dem Kontroll-Thread danach.
///
/// Der akute OOM (Kapitel 15 Teil 3 Rest 2, `docs/decisions.md`
/// Nachtrag 51+59) ist behoben — Root Cause saß in `omp-mediaio::mxl`
/// (fehlendes `sync_state_with_parent` + unbegrenzte `appsrc`-Queue),
/// nicht hier. **Bekannte, dokumentierte Restschwäche** (Nutzer-
/// entscheidung 2026-07-20: trotzdem committen, nicht verschweigen):
/// nach genügend wiederholten Swaps auf demselben `isel_sink_pad` läuft
/// der Pad-Block-Callback nicht-deterministisch in den
/// `SWAP_BLOCK_TIMEOUT` — es kommt schlicht kein Puffer mehr an diesem
/// Pad an, der Callback feuert also nie. Diese Funktion behandelt das
/// bereits korrekt (loggt, gibt `old_branch` unangetastet zurück, kein
/// Crash/Leck dank des OOM-Fixes) — funktional bedeutet es aber, dass
/// eine Auflösung ab diesem Punkt nicht mehr wechselt, bis der
/// betroffene Zweig aus einem anderen Grund (z. B. `SetInputs`-Rebuild)
/// neu aufgebaut wird. Root Cause nicht gefunden (Kandidaten: `appsrc`-
/// interner Weiterleitungs-Task-Scheduling-Zusammenhang mit dem eigenen
/// `read_loop`-Thread, oder GStreamer-/`input-selector`-interne
/// Zustandsakkumulation über viele Unlink-ohne-Flush-Zyklen auf
/// demselben, nie per `release_request_pad` freigegebenen Sink-Pad) —
/// künftige Sitzung.
#[allow(clippy::too_many_arguments)]
fn swap_input_resolution(
    pipeline: &gst::Pipeline,
    context: Arc<MxlContext>,
    isel_sink_pad: &gst::Pad,
    input: DiscoveredInput,
    target_flow_id: String,
    name_suffix: &str,
    width: u32,
    height: u32,
    old_branch: InputBranch,
) -> Result<InputBranch, Box<(String, Option<InputBranch>)>> {
    // Nutzerreport "Viewer schwarz, hohe Latenz bei PGM-Umschaltung" — per
    // Debug-Tap direkt auf `comp`s eigenem Ausgang reproduziert (ganz ohne
    // MXL/Viewer dazwischen) und per `GST_DEBUG=3` teilweise root-gecaust.
    // Zwei davon **bestätigt behoben**, ein drittes Restproblem bleibt
    // **offen** — Details und Repro unten und in `docs/decisions.md`
    // Nachtrag 65.
    //
    // **Fund 1, behoben:** `build_input_branch` (unten) synchronisiert
    // seine Elemente INTERN bereits auf `PLAYING` — das startet `appsrc`s
    // eigene GStreamer-Streaming-Task sofort. Stand der Aufruf (wie
    // vorher) VOR dem Block+Entlink+Drain-Ablauf für den alten Zweig,
    // lief diese Task waehrend der gesamten Wartezeit (Block-Timeout +
    // `OLD_WRITER_DRAIN`, mehrere hundert ms) gegen ein `capsfilter` ohne
    // jeden Downstream-Peer (erst `link_branch_to_pad` ganz unten verlinkt
    // es auf `isel_sink_pad`). `appsrc`s eigener Push kaskadiert dabei als
    // `GST_FLOW_NOT_LINKED` bis zum `basesrc`-Loop zurück, der das als
    // fatalen Fehler behandelt und seine Streaming-Task PERMANENT beendet
    // (bestätigt: `<appsrcN>: streaming stopped, reason not-linked`,
    // danach nie wieder ein Puffer, auch nicht nach einem spaeteren
    // erfolgreichen Relink). Fix: `build_input_branch` erst unmittelbar
    // vor `link_branch_to_pad` aufrufen, nicht am Funktionsanfang — das
    // unvermeidliche Fenster ohne Downstream-Peer schrumpft dadurch von
    // "mehrere hundert ms" auf eine Handvoll Rust-Anweisungen.
    //
    // **Fund 2, behoben:** dieselbe Fehlerklasse, umgekehrt, beim ALTEN
    // Zweig — `remove_mxl_video_input` (in `teardown_branch`) setzte die
    // GStreamer-Elemente bisher IMMER erst auf `Null`/entfernte sie und
    // stoppte den `read_loop`-Thread (via `running`-Flag) erst danach,
    // beim finalen `drop()`. Der Thread rief also `push_buffer()` weiter
    // gegen ein Element auf, das der Kontroll-Thread parallel demontierte
    // — dasselbe `not-linked`/Refcounting-Muster wie Fund 1. Fix:
    // `MxlVideoInput::stop()` (neu, `omp-mediaio`) muss vor
    // `remove_elements` laufen.
    //
    // **Restproblem, NICHT behoben:** selbst mit beiden Fixen und ohne
    // jede Warnung/Fehlermeldung in `GST_DEBUG=3` bleibt `comp`s Ausgang
    // bei einem Teil der ALLERERSTEN Highres-Promotions eines Zweigs
    // dauerhaft schwarz (kein Einzelbild-Ruckler, ALLE Frames ab dem
    // Zeitpunkt der Umschaltung). Bestätigt per Vier-Wege-Vergleich: (a)
    // Debug-Tap direkt auf `comp` UND ein echter `omp-viewer` zeigen
    // beide dasselbe Schwarzbild (kein Debug-Tap-Artefakt); (b) `mxl-info`
    // zeigt auf allen beteiligten Flows (Quelle Highres, Mixer-Ausgang)
    // durchgehend gesunden, synchronen Read/Write — die Daten sind also
    // nachweislich echt und fließen; (c) ein NACHFOLGENDER, durch einen
    // neuen Sender ausgelöster `SetInputs`-Rebuild (baut `comp` mit dem
    // Ziel bereits als `program` — also OHNE jeden Hot-Swap — komplett
    // neu auf) zeigt sofort echtes Bild, bestätigt also, dass das Problem
    // spezifisch am Hot-Swap-in-eine-laufende-Pipeline-Mechanismus hängt,
    // nicht an Quelle/Daten/Alpha/Zorder/isel-Auswahl (per temporärem
    // Debug-Log in `Cut`/`Take` einzeln alle als korrekt bestätigt, s.
    // `docs/decisions.md` Nachtrag 65 für die genauen Werte);
    // (d) probiert und verworfen, weil wirkungslos oder die Fehlerquote
    // nur senkend statt beseitigend: `compositor.min-upstream-latency`
    // bei 200ms/1s/2s, ein Buffer-Probe-Wait auf `isel_sink_pad` vor dem
    // Aktivschalten, ein FLUSH_START/FLUSH_STOP direkt auf `isel_sink_pad`
    // nach dem Relink. Root Cause nicht gefunden (Kandidaten: `compositor`
    // /`GstAggregator`-interne Segment-/Timestamp-Buchführung für einen
    // Sink-Pad, der zur Aktivierungszeit erstmals "wirklich" Daten liefert
    // — passend zu keiner Fehlermeldung, da ein `GstAggregator` verspätete
    // Puffer im Live-Betrieb standardmäßig lautlos verwirft). Ohne
    // `gdb`/Kenntnis der `compositor`-internen Segment-Verwaltung in
    // dieser Sandbox nicht weiter eingrenzbar — künftige Sitzung.
    // Reproduktion (exakter Tap-Code in `docs/decisions.md` Nachtrag 65):
    // ein `tee` zwischen `comp` und `comp_out_caps` mit `videoconvert !
    // jpegenc ! filesink`-Zweig, auf zwei frischen `omp-source`-Instanzen,
    // `select`+`cut` auf eine davon; tritt nicht-deterministisch bei ca.
    // jedem zweiten erstmaligen Highres-Swap eines Zweigs auf.
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

    let Some(probe_id) = probe_id else {
        return Err(Box::new(("add_probe (BLOCK_DOWNSTREAM) fehlgeschlagen".to_string(), Some(old_branch))));
    };

    if unblocked_rx.recv_timeout(SWAP_BLOCK_TIMEOUT).is_err() {
        // Live gefundener Bug (ggü. omp-switcher zusätzlich, dort schlägt
        // dieser Zweig nie fehl): ohne `remove_probe` bliebe der Block-
        // Probe dauerhaft auf dem Pad hängen und würde beim nächsten
        // vorbeikommenden Puffer irgendwann unkontrolliert entlinken.
        isel_sink_pad.remove_probe(probe_id);
        return Err(Box::new(("Timeout beim Warten auf den blockierten Pad-Unlink".to_string(), Some(old_branch))));
    }

    // Ab hier: Pad entlinkt (und per `PadProbeReturn::Remove` bereits
    // wieder freigegeben) — kein Zurück mehr zu `old_branch`.
    teardown_branch(pipeline, old_branch);
    std::thread::sleep(OLD_WRITER_DRAIN);

    // `build_input_branch` (startet die Streaming-Task, Fund 1 oben)
    // bewusst erst HIER, unmittelbar vor `link_branch_to_pad`.
    let branch = build_input_branch(pipeline, &context, &target_flow_id, &input.sender_id, name_suffix, width, height)
        .map_err(|e| Box::new((e, None)))?;
    match link_branch_to_pad(&branch, isel_sink_pad) {
        Ok(()) => Ok(branch),
        Err(e) => {
            teardown_branch(pipeline, branch);
            Err(Box::new((e, None)))
        }
    }
}

/// Tauscht `sender_id`s Zweig in `branches`/`pads` (fg **oder** bg-Pool,
/// generisch — beide werden an denselben Stellen im selben Rhythmus
/// umgeschaltet, s. Moduldoku) auf `target_flow_id` um, sofern er nicht
/// bereits offen ist. Kapselt `swap_input_resolution`s Bad-Path-
/// Buchführung (unangetasteten `old_branch` bei Fehlschlag zurückgeben)
/// für die drei Aufrufer unten (`promote_to_highres`/`demote_*_to_lowres`).
#[allow(clippy::too_many_arguments)]
fn retarget_branch(
    pipeline: &gst::Pipeline,
    context: &Arc<MxlContext>,
    branches: &mut HashMap<String, InputBranch>,
    pads: &HashMap<String, gst::Pad>,
    inputs: &[DiscoveredInput],
    sender_id: &str,
    name_suffix: &str,
    target_flow_id: &str,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let needs_swap = branches.get(sender_id).is_some_and(|b| b.open_flow_id != target_flow_id);
    if !needs_swap {
        return Ok(());
    }
    let (Some(pad), Some(old_branch)) = (pads.get(sender_id).cloned(), branches.remove(sender_id)) else {
        return Ok(());
    };
    let Some(input) = inputs.iter().find(|i| i.sender_id == sender_id) else {
        // Eingang aus der Buchführung verschwunden (Rennen mit einem
        // parallelen SetInputs, das ohnehin gleich die ganze Pipeline
        // ersetzt) — alten Zweig unangetastet zurückgeben.
        branches.insert(sender_id.to_string(), old_branch);
        return Ok(());
    };
    match swap_input_resolution(
        pipeline,
        context.clone(),
        &pad,
        input.clone(),
        target_flow_id.to_string(),
        name_suffix,
        width,
        height,
        old_branch,
    ) {
        Ok(new_branch) => {
            branches.insert(sender_id.to_string(), new_branch);
            Ok(())
        }
        Err(err) => {
            let (e, restored) = *err;
            if let Some(restored) = restored {
                branches.insert(sender_id.to_string(), restored);
            }
            Err(e)
        }
    }
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
    fg_branches: HashMap<String, InputBranch>,
    bg_branches: HashMap<String, InputBranch>,
    _mxl_output: MxlVideoOutput,
    /// `Some` nur, wenn der Keyer gerade eine echte Fill+Key-Quelle liest
    /// (statt der synthetischen Test-Farbfläche) — hält deren
    /// `MxlVideoInput`s am Leben, sonst stirbt ihr `read_loop`-Thread
    /// beim `Drop` (s. `build_keyfill_tail`).
    _keyer_keyfill: Option<(MxlVideoInput, MxlVideoInput)>,
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

/// Baut die Mixer-Pipeline. Ein einzelner kaputter Eingang (z. B. ein
/// Registry-Geist-Sender, s. `build_one_input`) lässt den restlichen
/// Build nicht scheitern — er wird übersprungen und als Eintrag im
/// zweiten Rückgabewert gemeldet, den der Aufrufer (`run()`) als
/// `Event::Error` weiterreicht.
fn build(
    context: &Arc<MxlContext>,
    config: &Config,
    inputs: &[DiscoveredInput],
    program: &Option<String>,
    keyfill_inputs: &[DiscoveredKeyFill],
    keyer_source: &Option<String>,
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
            program,
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

    // ── comp.sink_0 = Programm (fg, zorder 2, DVE-fähig — Box wird nach
    //    dem Build vom Aufrufer via `apply_dve_box` gesetzt).
    let comp_fg_pad = comp
        .request_pad_simple("sink_0")
        .ok_or("comp: request sink_0 (fg) failed")?;
    comp_fg_pad.set_property("zorder", 2u32);
    comp_fg_pad.set_property("alpha", 1.0f64);
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
            fg_branches,
            bg_branches,
            _mxl_output: mxl_output,
            _keyer_keyfill: keyer_keyfill,
            flowed,
        },
        warnings,
    ))
}

/// Stuft `target_id`s fg- **und** bg-Zweig auf Highres hoch, falls nötig
/// — vor jedem tatsächlichen Programm-Wechsel (Cut/Take/AutoTrans)
/// aufgerufen, damit PGM nie, auch nicht für einen Frame, Lowres zeigt
/// (s. Moduldoku). Für den bg-Zweig eines Eingangs, der noch nie
/// Programm war, ist das eine Vorab-Investition auf den Moment, in dem
/// `isel_bg`s aktiver Pad am Ende der nächsten Überblendung dorthin
/// mitzieht (`spawn_autotrans`) — unschädlich, weil der bg-Zweig bis
/// dahin ohnehin nicht sichtbar ist.
fn promote_to_highres(
    p: &mut ActivePipeline,
    context: &Arc<MxlContext>,
    current_inputs: &[DiscoveredInput],
    config: &Config,
    target_id: &str,
    tx: &UnboundedSender<Event>,
) {
    let Some(input) = current_inputs.iter().find(|i| i.sender_id == target_id) else {
        return;
    };
    let highres = input.flow_id.clone();
    if let Err(e) = retarget_branch(
        &p.pipeline,
        context,
        &mut p.fg_branches,
        &p.source_pads_fg,
        current_inputs,
        target_id,
        &format!("swap-{target_id}-fg"),
        &highres,
        config.width,
        config.height,
    ) {
        let _ = tx.send(Event::Error(format!(
            "Auflösungs-Swap (Highres, fg) für {target_id} fehlgeschlagen: {e}"
        )));
    }
    if let Err(e) = retarget_branch(
        &p.pipeline,
        context,
        &mut p.bg_branches,
        &p.source_pads_bg,
        current_inputs,
        target_id,
        &format!("swap-{target_id}-bg"),
        &highres,
        config.width,
        config.height,
    ) {
        let _ = tx.send(Event::Error(format!(
            "Auflösungs-Swap (Highres, bg) für {target_id} fehlgeschlagen: {e}"
        )));
    }
}

/// Stuft `old_id`s fg-Zweig (nur fg-Pool) auf Lowres herunter, sofern er
/// einen Lowres-Begleiter hat und nicht (mehr) das aktuelle Programm ist
/// — sicher sofort nach einem Cut/Take/AutoTrans aufrufbar, weil `isel`
/// zu diesem Zeitpunkt bereits auf den neuen Eingang umgeschaltet hat
/// (der alte fg-Zweig ist ab dann unreferenziert, s. Moduldoku).
fn demote_fg_to_lowres(
    p: &mut ActivePipeline,
    context: &Arc<MxlContext>,
    current_inputs: &[DiscoveredInput],
    config: &Config,
    old_id: &str,
    new_id: &Option<String>,
    tx: &UnboundedSender<Event>,
) {
    if new_id.as_deref() == Some(old_id) {
        return;
    }
    let Some(input) = current_inputs.iter().find(|i| i.sender_id == old_id) else {
        return;
    };
    let Some(lowres_flow_id) = input.lowres_flow_id.clone() else {
        return;
    };
    if let Err(e) = retarget_branch(
        &p.pipeline,
        context,
        &mut p.fg_branches,
        &p.source_pads_fg,
        current_inputs,
        old_id,
        &format!("swap-{old_id}-fg"),
        &lowres_flow_id,
        config.width,
        config.height,
    ) {
        let _ = tx.send(Event::Error(format!(
            "Auflösungs-Swap (Lowres, fg) für {old_id} fehlgeschlagen: {e}"
        )));
    }
}

/// Bg-Pendant zu `demote_fg_to_lowres`. **Nur** sicher aufrufbar, wenn
/// `isel_bg`s aktiver Pad tatsächlich nicht mehr auf `old_id` zeigt —
/// bei Cut/Take ist das sofort der Fall (beide Selektoren schalten
/// synchron um), bei `autoTrans()` **nicht** (s. Moduldoku:
/// `isel_bg` bleibt während des gesamten Fades auf `old_id` stehen,
/// deshalb dort über `pending_bg_demote` in `run()` verzögert).
fn demote_bg_to_lowres(
    p: &mut ActivePipeline,
    context: &Arc<MxlContext>,
    current_inputs: &[DiscoveredInput],
    config: &Config,
    old_id: &str,
    new_id: &Option<String>,
    tx: &UnboundedSender<Event>,
) {
    if new_id.as_deref() == Some(old_id) {
        return;
    }
    let Some(input) = current_inputs.iter().find(|i| i.sender_id == old_id) else {
        return;
    };
    let Some(lowres_flow_id) = input.lowres_flow_id.clone() else {
        return;
    };
    if let Err(e) = retarget_branch(
        &p.pipeline,
        context,
        &mut p.bg_branches,
        &p.source_pads_bg,
        current_inputs,
        old_id,
        &format!("swap-{old_id}-bg"),
        &lowres_flow_id,
        config.width,
        config.height,
    ) {
        let _ = tx.send(Event::Error(format!(
            "Auflösungs-Swap (Lowres, bg) für {old_id} fehlgeschlagen: {e}"
        )));
    }
}

/// Kombiniert `demote_fg_to_lowres` + `demote_bg_to_lowres` — für
/// Cut/Take, wo beide Pools gleichzeitig sicher herunterstufbar sind
/// (kein Fade, s. `demote_bg_to_lowres`-Doku).
fn demote_to_lowres(
    p: &mut ActivePipeline,
    context: &Arc<MxlContext>,
    current_inputs: &[DiscoveredInput],
    config: &Config,
    old_id: &str,
    new_id: &Option<String>,
    tx: &UnboundedSender<Event>,
) {
    demote_fg_to_lowres(p, context, current_inputs, config, old_id, new_id, tx);
    demote_bg_to_lowres(p, context, current_inputs, config, old_id, new_id, tx);
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
    let mut active = match build(&context, &config, &current_inputs, &None, &keyfill_inputs, &keyer_source) {
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
    let fading = Arc::new(AtomicBool::new(false));
    let fade_thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    // Kapitel 15 Teil 3 (Rest 2, s. Moduldoku): der bg-Zweig des vor einer
    // `autoTrans()` aktiven Programms darf erst nach Fade-Ende auf Lowres
    // herunterstuft werden (`isel_bg` zeigt bis dahin noch darauf) — hier
    // gemerkt, im Loop unten angewendet, sobald `fading` wieder `false` ist.
    let mut pending_bg_demote: Option<String> = None;

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

        // Verzögerte bg-Herunterstufung nach einer abgeschlossenen
        // `autoTrans()` (s. Moduldoku + `pending_bg_demote`-Deklaration
        // oben) — hier statt im Fade-Thread selbst, weil jeder Element-
        // Auf-/Abbau strikt auf diesem Kontroll-Thread passieren muss
        // (`swap_input_resolution`-Doku).
        if let Some(old_id) = pending_bg_demote.take() {
            if fading.load(Ordering::Acquire) {
                pending_bg_demote = Some(old_id);
            } else if let Some(p) = &mut active {
                demote_bg_to_lowres(p, &context, &current_inputs, &config, &old_id, &program, &tx);
            }
        }

        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::SetInputs(inputs)) => {
                if inputs_changed(&current_inputs, &inputs) {
                    current_inputs = inputs;
                    join_fade(&fade_thread);
                    fading.store(false, Ordering::Release);
                    pending_bg_demote = None;
                    active = None;
                    std::thread::sleep(OLD_WRITER_DRAIN);
                    match build(&context, &config, &current_inputs, &program, &keyfill_inputs, &keyer_source) {
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
                            apply_dve_box(&p.comp_fg_pad, &dve_box);
                            p.comp_keyer_pad
                                .set_property("alpha", if keyer_enabled { 1.0f64 } else { 0.0f64 });
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
                            match build(&context, &config, &[], &program, &keyfill_inputs, &keyer_source) {
                                Ok((p, _warnings)) => {
                                    apply_dve_box(&p.comp_fg_pad, &dve_box);
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
                    pending_bg_demote = None;
                    active = None;
                    std::thread::sleep(OLD_WRITER_DRAIN);
                    match build(&context, &config, &current_inputs, &program, &keyfill_inputs, &keyer_source) {
                        Ok((p, warnings)) => {
                            for w in warnings {
                                let _ = tx.send(Event::Error(w));
                            }
                            let applied_program =
                                switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &program);
                            switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &program);
                            apply_dve_box(&p.comp_fg_pad, &dve_box);
                            p.comp_keyer_pad
                                .set_property("alpha", if keyer_enabled { 1.0f64 } else { 0.0f64 });
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
                            match build(&context, &config, &[], &program, &keyfill_inputs, &keyer_source) {
                                Ok((p, _warnings)) => {
                                    apply_dve_box(&p.comp_fg_pad, &dve_box);
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
                    if let Some(target_id) = &preset {
                        promote_to_highres(p, &context, &current_inputs, &config, target_id, &tx);
                    }
                    let applied = switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &preset);
                    p.comp_fg_pad.set_property("alpha", 1.0f64);
                    p.comp_bg_pad.set_property("alpha", 0.0f64);
                    // isel_bg auf denselben Eingang mitziehen (nächste
                    // Transition findet dort ein laufendes Bild vor).
                    switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &preset);
                    program = applied;
                    // Kein Fade bei Cut: beide Selektoren sind bereits auf
                    // den neuen Eingang umgeschaltet, der alte ist ab hier
                    // in keinem Pool mehr referenziert — sofortiges
                    // Herunterstufen (fg + bg) ist sicher.
                    if let Some(prev_id) = &previous {
                        demote_to_lowres(p, &context, &current_inputs, &config, prev_id, &program, &tx);
                    }
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
                    if let Some(target_id) = &sender_id {
                        promote_to_highres(p, &context, &current_inputs, &config, target_id, &tx);
                    }
                    let applied =
                        switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &sender_id);
                    p.comp_fg_pad.set_property("alpha", 1.0f64);
                    p.comp_bg_pad.set_property("alpha", 0.0f64);
                    switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &sender_id);
                    program = applied;
                    if let Some(prev_id) = &previous {
                        demote_to_lowres(p, &context, &current_inputs, &config, prev_id, &program, &tx);
                    }
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
                    if let Some(target_id) = &preset {
                        promote_to_highres(p, &context, &current_inputs, &config, target_id, &tx);
                    }
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
                    // fg ist ab hier sicher herunterstufbar (isel zeigt
                    // bereits auf das neue Ziel) — bg dagegen erst nach
                    // Fade-Ende (`pending_bg_demote`, Moduldoku).
                    if let Some(prev_id) = &previous {
                        demote_fg_to_lowres(p, &context, &current_inputs, &config, prev_id, &program, &tx);
                        if Some(prev_id) != program.as_ref() {
                            pending_bg_demote = Some(prev_id.clone());
                        }
                    }
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
                    apply_dve_box(&p.comp_fg_pad, &dve_box);
                }
                let _ = tx.send(Event::DveBoxChanged(dve_box));
            }
            Ok(Command::ResetDve) => {
                dve_box = DveBox::full_frame(config.width, config.height);
                if let Some(p) = &active {
                    apply_dve_box(&p.comp_fg_pad, &dve_box);
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
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    join_fade(&fade_thread);
    drop(active);
}
