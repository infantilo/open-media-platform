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
//! Preset sofort hart auf Programm. `autoTrans()` überblendet über die
//! per `crosspoint.setTransRate` gewählte Dauer (Bug 4, vormals fest auf
//! `TRANS_DURATION_MS`/25 Frames verdrahtet, s. `DEFAULT_TRANS_RATE_FRAMES`
//! /`frames_to_ms`) in `STEP_MS`-Schritten (40ms ≙ eine Bildperiode
//! @25fps, wie im Vorbild). Läuft bereits eine Transition, werden weitere
//! `cut()`/`autoTrans()`-Aufrufe ignoriert (`fading`-Sperre) — ausreichend
//! fürs manuelle Bedienen; alles darüber hinaus (Warteschlange, weitere
//! Transitionsarten) ist wie volle DVE/Keyer-Tiefe Community-Scope
//! (`UMSETZUNG.md` C10). **Transitionsarten (`TransKind`, Nutzerauftrag
//! 2026-09-29):** Mix, V-Fade (über Schwarz), Slide (neues Bild fährt über
//! das stehende alte) und Push (neues Bild schiebt das alte hinaus) je in
//! vier Richtungen — ausschließlich über Alpha und `xpos`/`ypos` der
//! Compositor-Pads (sofort wirksam, KEINE Caps-Änderung, kein Element in
//! der Signalkette). Gilt für AUTO und den manuellen T-Bar gleichermaßen
//! (`apply_transition_frame`).
//!
//! **Bewusst KEIN Crop-Wipe (Freeze-Ursache, 2026-09-29):** ein erster Wurf
//! nutzte `videocrop` vor den Compositor-Pads (echte Wipe-Kanten). Jede
//! `videocrop`-Property-Änderung schickt aber ein RECONFIGURE stromaufwärts
//! bis in die GETEILTE Quellenkette (`appsrc`→`videoconvert`→…→`tee`);
//! scheitert dort die Neuverhandlung auch nur einmal transient
//! (`videoconvert: not negotiated`), stoppt `appsrc` dauerhaft
//! (`streaming stopped, reason not-negotiated`) — der Eingang liefert nie
//! wieder ein Bild, der PGM-Ausgang friert bei Umschalten auf ihn ein.
//! Regel: in dieser Pipeline nie zur Laufzeit etwas tun, das Caps neu
//! verhandelt (Crop/Scale-Elemente umparametrieren, Relink).
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
//! über die gewählte Rampendauer von 1 auf 0), `isel_bg`s aktiver Pad
//! wechselt erst am Ende des Fades (`spawn_autotrans`) auf den neuen
//! Eingang.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
pub const DEFAULT_WIDTH: u32 = 1280;
pub const DEFAULT_HEIGHT: u32 = 720;
pub const FRAMERATE_NUMERATOR: u32 = 25;
pub const FRAMERATE_DENOMINATOR: u32 = 1;

/// Eine Bildperiode @25fps — Animationsschrittweite für `autoTrans()`,
/// identisch zu PIPELINE CONTROLLERs `STEP_MS`.
const STEP_MS: u64 = 40;

/// `crosspoint.transRate` (Bug 4, vormals ausgegraut, s.
/// `../ui/bundle.js`-Moduldoku "K3-Teil-2"): Default-Rate, bis der
/// Operator eine der vier UI-Tasten (6f/12f/25f/50f) wählt. 25 Frames
/// @25fps ≙ 1000ms — bewusst identisch zum bisherigen festen
/// `TRANS_DURATION_MS`, damit sich am Standardverhalten nichts ändert.
pub const DEFAULT_TRANS_RATE_FRAMES: u32 = 25;

/// Rechnet eine Bildanzahl (`crosspoint.transRate`, an der aktuellen
/// `FRAMERATE_NUMERATOR`/`_DENOMINATOR` gemessen) in eine Millisekunden-
/// Dauer für `spawn_autotrans` um.
fn frames_to_ms(frames: u32) -> u64 {
    frames as u64 * 1000 * FRAMERATE_DENOMINATOR as u64 / FRAMERATE_NUMERATOR as u64
}

/// Art der Überblendung (`crosspoint.transType`), s. Moduldoku.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransKind {
    Mix,
    /// Ausgehendes Bild blendet auf Schwarz, dann blendet das neue auf.
    VFade,
    /// Fade-Cut: das ausgehende Bild blendet über die ganze Dauer auf Schwarz, danach steht das neue hart da.
    FadeCut,
    /// Cut-Fade: hart auf Schwarz, dann blendet das neue Bild über die ganze Dauer auf.
    CutFade,
    /// Slide: das neue Bild fährt über das stehende alte. Pfeil = Bewegungsrichtung.
    SlideR,
    SlideL,
    SlideD,
    SlideU,
    /// Push: das neue Bild schiebt das alte in dieselbe Richtung hinaus.
    PushR,
    PushL,
    PushD,
    PushU,
}

impl TransKind {
    const ALL: [TransKind; 12] = [
        Self::Mix,
        Self::VFade,
        Self::FadeCut,
        Self::CutFade,
        Self::SlideR,
        Self::SlideL,
        Self::SlideD,
        Self::SlideU,
        Self::PushR,
        Self::PushL,
        Self::PushD,
        Self::PushU,
    ];

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|k| k.name() == name)
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Mix => "mix",
            Self::VFade => "vfade",
            Self::FadeCut => "fadecut",
            Self::CutFade => "cutfade",
            Self::SlideR => "slideR",
            Self::SlideL => "slideL",
            Self::SlideD => "slideD",
            Self::SlideU => "slideU",
            Self::PushR => "pushR",
            Self::PushL => "pushL",
            Self::PushD => "pushD",
            Self::PushU => "pushU",
        }
    }

    fn from_u8(v: u8) -> Self {
        Self::ALL.get(v as usize).copied().unwrap_or(Self::Mix)
    }

    fn to_u8(self) -> u8 {
        Self::ALL.iter().position(|k| *k == self).unwrap_or(0) as u8
    }

    /// Bewegungsrichtung als Einheitsvektor (x, y) für Slide/Push, sonst `None`.
    fn direction(self) -> Option<(i32, i32)> {
        match self {
            Self::SlideR | Self::PushR => Some((1, 0)),
            Self::SlideL | Self::PushL => Some((-1, 0)),
            Self::SlideD | Self::PushD => Some((0, 1)),
            Self::SlideU | Self::PushU => Some((0, -1)),
            _ => None,
        }
    }

    fn is_push(self) -> bool {
        matches!(self, Self::PushR | Self::PushL | Self::PushD | Self::PushU)
    }
}

/// Diagnose (env `OMP_MXL_DEBUG`): zählt Puffer an ausgewählten Pads und gibt
/// alle 2 s die Deltas aus. Nur zur Freeze-Analyse, ohne Wirkung wenn nicht gesetzt.
static DBG_COUNTERS: std::sync::Mutex<Vec<(String, Arc<AtomicU64>, u64)>> = std::sync::Mutex::new(Vec::new());
static DBG_THREAD: std::sync::Once = std::sync::Once::new();

fn dbg_probe(pad: &gst::Pad, label: String) {
    if std::env::var("OMP_MXL_DEBUG").is_err() {
        return;
    }
    let counter = Arc::new(AtomicU64::new(0));
    let c = counter.clone();
    pad.add_probe(gst::PadProbeType::BUFFER, move |_, _| {
        c.fetch_add(1, Ordering::Relaxed);
        gst::PadProbeReturn::Ok
    });
    DBG_COUNTERS.lock().expect("lock").push((label, counter, 0));
    DBG_THREAD.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(2));
            let mut v = DBG_COUNTERS.lock().expect("lock");
            let mut out = String::new();
            for (label, counter, last) in v.iter_mut() {
                let now = counter.load(Ordering::Relaxed);
                if now != *last || label.contains("comp-out") {
                    out.push_str(&format!(" {label}=+{}", now - *last));
                }
                *last = now;
            }
            if !out.is_empty() {
                eprintln!("PIPEDBG{out}");
            }
        });
    });
}

/// Feste DSK-Farbfläche des Keyers (ARGB, big-endian, wie
/// `videotestsrc::foreground-color`): kräftiges Magenta, im Viewer klar
/// vom SMPTE-/Quellbild unterscheidbar.
const KEYER_COLOR_ARGB: u32 = 0xFFFF00FF;

/// Wie beim Switcher (C7): Reader-/Writer-Threads setzen bei `Drop` nur
/// ein Stop-Flag, kein `JoinHandle`. Vor dem Öffnen eines neuen
/// `MxlVideoOutput`-Writers auf denselben `flow_id` (Rebuild) kurz warten,
/// damit nicht zwei Writer-Threads überlappend schreiben.
const OLD_WRITER_DRAIN: Duration = Duration::from_millis(300);

/// Nutzerreport 2026-07-30: "source->scaler->videomixer m/e schaltet
/// scaler nicht auf pgm, PGM ist schwarz". Root Cause per Log-Analyse
/// gefunden (nicht geraten, `UMSETZUNG.md` §0 Punkt 9): ein frisch
/// gestarteter Scaler ist manchmal schon per IS-04 als Sender discoverbar,
/// bevor sein MXL-Flow für andere Prozesse tatsächlich lesbar ist
/// (`get_flow_def` liefert "Flow not found") — `build_one_input` überspringt
/// diesen einen Eingang dann korrekt (kein Pipeline-Abschuss), aber
/// `inputs_changed` verglich bisher nur die Sender-ID-MENGE: bleibt die
/// Menge über den nächsten Poll (alle 2s) unverändert, fand nie wieder ein
/// Rebuild-Versuch statt — der Eingang blieb für die gesamte Lebensdauer
/// der Pipeline dauerhaft schwarz, PGM sprang beim Auswählen auf BLK
/// zurück. Fix unten: fehlende Eingänge werden jetzt unabhängig von der
/// ID-Mengen-Änderung auf jedem Leerlauf-Tick erneut versucht.
///
/// Nachtrag (Kapitel 6 Teil 7 Live-Verifikation, Bug 2, 2026-09-11): ein
/// zunächst hier eingebautes FESTES Retry-Budget (`MISSING_INPUT_RETRIES`,
/// ~2.5s) reichte für diese ursprüngliche Diagnose (kurze Registrierungs-
/// Race) aus, ist aber zu kurz für den viel häufigeren Fall bei
/// `omp-channel-player`: dessen NMOS-Sender wird sofort beim Prozessstart
/// registriert, sein MXL-Output-Flow (`MxlVideoOutput`) aber laut
/// `pipeline::run()` erst beim ERSTEN `load()`-Aufruf tatsächlich angelegt
/// (`create_flow_writer`) — bis dahin liefert `get_flow_def` dauerhaft
/// "Flow not found". Liegt zwischen Workflow-Start und dem ersten
/// `cue`/`take` (z. B. via `omp-playout-automation`) mehr als ~2.5s, lief
/// das Budget aus, BEVOR der Flow existierte — der Eingang blieb bis zur
/// nächsten echten Sender-ID-Mengenänderung dauerhaft schwarz, exakt das
/// live beobachtete Symptom (`crosspoint.programInput` bleibt nach
/// `cut`/`take`/`autoTrans` leer, `presetInput` aber korrekt). Live per
/// `/proc/<pid>/fd` verifiziert: der Channel-Player öffnet vor dem ersten
/// `load()` buchstäblich keine MXL-Dateien. Fix: kein festes Budget
/// mehr — solange ein Eingang fehlt, wird auf JEDEM Leerlauf-Tick erneut
/// versucht (kostet nur dann etwas, wenn tatsächlich ein Eingang fehlt),
/// bis der Flow lesbar wird oder sich die Sender-ID-Menge ändert.

pub struct Config {
    pub domain: String,
    /// Ein Flow-ID je M/E-Ebene (Nutzerwunsch 2026-08-14: "jede
    /// Mischerebene soll eigenen Output erzeugen") — Länge = Anzahl
    /// Ebenen, `main.rs` erzeugt sie 1:1 mit den registrierten
    /// `SenderSpec`s. Länge 1 = unverändertes Vor-Ebenen-Verhalten.
    pub flow_ids: Vec<String>,
    pub label: String,
    pub width: u32,
    pub height: u32,
    /// Bugliste 2026-09-25 #7: einmal beim Node-Start ermittelt
    /// (`omp_mediaio::hwaccel::HwAccel::probe()` in `main.rs`), hier nur
    /// durchgereicht — kein wiederholter Selbsttest pro Pipeline-Aufbau.
    pub hwaccel: omp_mediaio::hwaccel::HwAccel,
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
    /// Auflösung/Bildrate des Quell-Flows laut Registry (None, falls der
    /// Flow keine trägt) — Grundlage der Formatabweichungs-Anzeige.
    pub format: Option<omp_node_sdk::is04::VideoFormat>,
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
    /// Positives Gegenstück zu `Error` für den Missing-Input-Retry
    /// (Nachtrag 2026-09-13, Root-Cause-Session "mixer recovery bug"):
    /// der Retry-Erfolg selbst wurde bisher NIRGENDS geloggt — nur der
    /// letzte Fehlschlag blieb für den Rest der Pipeline-Lebensdauer als
    /// letzte Zeile im rohen stdout-Log stehen (BCP-008-Status im
    /// Diagnose-Cockpit räumt korrekt auf, s. `report_missing_inputs`,
    /// aber ein Operator, der nur `docker logs`/rohes stdout beobachtet,
    /// hielt die Pipeline deshalb für dauerhaft hängen, obwohl PGM längst
    /// wieder lief — live per `mxl-info` widerlegt, s. `docs/decisions.md`).
    Info(String),
    /// Programm hat wirklich umgeschaltet (nach `cut()` sofort, nach
    /// `autoTrans()` bei Transitionsbeginn — Tally soll im selben Moment
    /// rot werden, in dem der Operator die Aktion auslöst, nicht erst
    /// wenn die Überblendung optisch fertig ist). `level` (Nutzerwunsch
    /// 2026-08-14, "M/E-Ebenen"): 0-basierter Ebenen-Index, immer 0 bei
    /// genau einer Ebene (unverändertes Vor-Ebenen-Verhalten).
    ProgramChanged {
        level: usize,
        previous: Option<String>,
        current: Option<String>,
    },
    PresetChanged {
        level: usize,
        preset: Option<String>,
    },
    DveBoxChanged {
        level: usize,
        box_: DveBox,
    },
    /// Manueller T-Bar (`docs/END-GOAL-FEATURES.md` §3.4 Teil 2,
    /// Nutzerauftrag 2026-09-04): Live-Position der laufenden/zuletzt
    /// abgeschlossenen Transition, 0..1 — s. `Command::
    /// SetTransitionPosition`-Doku für die Endpunkt-Semantik.
    TransitionPositionChanged {
        level: usize,
        position: f64,
    },
    KeyerChanged {
        level: usize,
        enabled: bool,
    },
    /// PIP-Layer (Nutzerwunsch 2026-07-22, s. Moduldoku "PIP als
    /// eigenständiger Layer") — gleiches Muster wie `KeyerChanged`.
    PipChanged {
        level: usize,
        enabled: bool,
    },
}

enum Command {
    /// Geplanter Befehl (Kap. 31.4): der Befehls-Thread wartet auf den Puffer mit TAI-Zeitmarke `at`
    /// (Alter der Ziel-Quelle am Selektor eingerechnet) und führt dann `inner` aus.
    At(u64, Box<Command>),
    /// Der am Compositor geplante harte Wechsel ist erfolgt (Ebene, neue Quelle).
    FlipDone(usize, Option<String>),
    /// Nach dem Einlaufen des Vordergrund-Zweigs: Bild von Hintergrund auf Vordergrund zurücklegen.
    FlipSettle(usize, Option<String>),
    SetInputs(Vec<DiscoveredInput>),
    SelectPreset(usize, Option<String>),
    Cut(usize),
    Take(usize, Option<String>),
    AutoTrans(usize),
    /// Manueller T-Bar (`docs/END-GOAL-FEATURES.md` §3.4 Teil 2): `f64` ist
    /// die Zielposition 0..1, s. `PipelineHandle::set_transition_position`-
    /// Doku für die Endpunkt-Semantik (Abbruch bei <=0, Commit bei >=1).
    SetTransitionPosition(usize, f64),
    SetDveBox(usize, DveBox),
    ResetDve(usize),
    SetKeyerEnabled(usize, bool),
    SetKeyFillInputs(Vec<DiscoveredKeyFill>),
    SetKeyerSource(usize, Option<String>),
    SetPipEnabled(usize, bool),
    SetPipSource(usize, Option<String>),
    /// PIP-Fahrt (Nutzerauftrag 2026-09-29): setzt die Box sofort auf
    /// `from`, fährt in `duration_ms` (Ease in/out) nach `to`; mit
    /// `then_disable` wird PIP am Ende ausgeschaltet.
    PipAnimate { level: usize, from: DveBox, to: DveBox, duration_ms: u64, then_disable: bool },
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    /// S. `omp-switcher::pipeline::PipelineHandle::flowed` — gleiche
    /// Begründung (Rebuild bei jeder Quellenmengen-Änderung, C10 folgt
    /// demselben Discovery-Muster wie C7). Ein Eintrag je M/E-Ebene
    /// (Nutzerwunsch 2026-08-14) — Index 0 bei genau einer Ebene
    /// unverändert wie vor diesem Feature.
    flowed: Arc<Mutex<Vec<Option<Arc<AtomicBool>>>>>,
    /// output_delay (D8 Teil 3, ARCHITECTURE.md §15.1 Punkt 3/4): anders
    /// als `flowed` bewusst KEIN `Mutex<Option<...>>>`, das bei jedem
    /// Rebuild neu belegt wird — dieselben `Arc`s werden bei jedem
    /// Rebuild erneut in `MxlVideoOutput::new` hineingereicht (s.
    /// `build()`), bleiben also über Input-Set-Änderungen hinweg stabil,
    /// exakt wie bei `omp-scaler::pipeline::PipelineHandle::output_delay`.
    /// Ein Eintrag je Ebene.
    output_delays: Vec<Arc<AtomicU64>>,
    /// `crosspoint.transRate` (Bug 4): wie `output_delay` ein reiner
    /// atomarer Store statt eines `Command` — die Rate wird beim nächsten
    /// `AutoTrans` gelesen, kein Pipeline-Neuaufbau nötig, s.
    /// `set_trans_rate`. Ein Eintrag je Ebene.
    trans_rate_ms: Vec<Arc<AtomicU64>>,
    /// `crosspoint.transType`: wie `trans_rate_ms` ein atomarer Store,
    /// gelesen beim Start von AUTO bzw. bei jedem T-Bar-Schritt.
    trans_kind: Vec<Arc<AtomicU8>>,
}

impl PipelineHandle {
    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep-2): der
    /// Programm-Ausgang produziert immer etwas (mindestens Schwarzbild),
    /// wird also i. d. R. kurz nach jedem (Re-)Build `true`. Bei mehreren
    /// Ebenen (Nutzerwunsch 2026-08-14) erst `true`, wenn ALLE Ebenen
    /// liefern — der Node insgesamt ist erst dann wirklich "bereit",
    /// nicht schon, wenn nur eine seiner mehreren registrierten
    /// NMOS-Sender lebt.
    pub fn media_ready(&self) -> bool {
        self.flowed
            .lock()
            .expect("lock poisoned")
            .iter()
            .all(|f| f.as_ref().is_some_and(|f| f.load(Ordering::Relaxed)))
    }

    /// `setOutputDelay` (D8 Teil 3) — reiner atomarer Store, kein
    /// Pipeline-Neuaufbau nötig. `level` außerhalb des gültigen Bereichs
    /// (z. B. Orchestrator ruft mit veraltetem Ebenen-Count) wird still
    /// ignoriert statt zu panicen — dieselbe Toleranz wie überall sonst
    /// hier gegenüber Timing-Racen.
    pub fn set_output_delay(&self, level: usize, frames: u64) {
        if let Some(d) = self.output_delays.get(level) {
            d.store(frames, Ordering::Relaxed);
        }
    }

    pub fn set_inputs(&self, inputs: Vec<DiscoveredInput>) {
        let _ = self.commands.send(Command::SetInputs(inputs));
    }

    pub fn select_preset(&self, level: usize, sender_id: Option<String>) {
        let _ = self.commands.send(Command::SelectPreset(level, sender_id));
    }

    /// Gemeinsamer Schaltzeitpunkt (Kap. 31.4): `at_tai_ns` ist ein absoluter
    /// TAI-Zeitpunkt (ns). Liegt er in der Zukunft, schaltet der Mischer erst, wenn der Puffer mit dieser
    /// Zeitmarke den Selektor erreicht (Alter der Quelle eingerechnet); sonst sofort.
    /// Die Wartezeit liegt in einem eigenen Thread — der Command-Thread bleibt frei.
    fn send_at(&self, at_tai_ns: Option<u64>, cmd: Command) {
        match at_tai_ns {
            Some(at) if at > omp_mediaio::timebase::tai_now_ns() => {
                let tx = self.commands.clone();
                std::thread::spawn(move || {
                    // Grob warten; die genaue Wartezeit (Alter der Quelle am Selektor) bestimmt der
                    // Befehls-Thread, der die Pads kennt, s. `Command::At`.
                    omp_mediaio::timebase::sleep_until_tai(at, TAKE_AT_EARLY_NS);
                    let _ = tx.send(Command::At(at, Box::new(cmd)));
                });
            }
            _ => {
                let _ = self.commands.send(cmd);
            }
        }
    }

    pub fn cut_at(&self, level: usize, at_tai_ns: Option<u64>) {
        self.send_at(at_tai_ns, Command::Cut(level));
    }

    pub fn take_at(&self, level: usize, sender_id: Option<String>, at_tai_ns: Option<u64>) {
        self.send_at(at_tai_ns, Command::Take(level, sender_id));
    }

    pub fn auto_trans_at(&self, level: usize, at_tai_ns: Option<u64>) {
        self.send_at(at_tai_ns, Command::AutoTrans(level));
    }

    /// PGM-Hot-Cut (K3-Teil-2, `docs/END-GOAL-FEATURES.md` §3.5 offene
    /// Frage 1, entschieden 2026-07-16: PGM-Bus-Buttons schalten direkt
    /// um): schaltet das Programm-Bild sofort auf `sender_id`, **ohne**
    /// den gestagten Preset-Wert zu berühren — anders als ein impliziter
    /// `select_preset` + `cut()`-Umweg, der die Preset-Auswahl
    /// überschreiben würde (genau das Risiko, das die ursprüngliche
    /// PGM-„nur Anzeige"-Entscheidung vermeiden wollte).
    pub fn take(&self, level: usize, sender_id: Option<String>) {
        let _ = self.commands.send(Command::Take(level, sender_id));
    }

    /// Manueller T-Bar (`docs/END-GOAL-FEATURES.md` §3.4 Teil 2,
    /// Nutzerauftrag 2026-09-04 "der Mixer Transition Fader lässt sich
    /// nicht händisch bedienen"): `pos` wird im Command-Verarbeiter auf
    /// `[0,1]` geklemmt. Semantik siehe dortige Doku (`Command::
    /// SetTransitionPosition`-Zweig in `run()`): `pos<=0` bricht sauber
    /// ab (Programm unverändert), `0<pos<1` blendet live ohne zu
    /// committen, `pos>=1` committet PGM genau wie das Ende von
    /// `spawn_autotrans`.
    pub fn set_transition_position(&self, level: usize, pos: f64) {
        let _ = self.commands.send(Command::SetTransitionPosition(level, pos));
    }

    /// `crosspoint.setTransRate` (Bug 4): setzt die Rampendauer für die
    /// NÄCHSTE(n) `autoTrans()`-Aufrufe dieser Ebene — eine bereits
    /// laufende Überblendung läuft mit ihrer ursprünglichen Dauer zu Ende
    /// (`spawn_autotrans` liest `duration_ms` einmalig beim Start).
    pub fn set_trans_kind(&self, level: usize, kind: TransKind) {
        if let Some(k) = self.trans_kind.get(level) {
            k.store(kind.to_u8(), Ordering::Relaxed);
        }
    }

    /// Startet eine PIP-Fahrt, s. `Command::PipAnimate`.
    pub fn pip_animate(&self, level: usize, from: DveBox, to: DveBox, duration_ms: u64, then_disable: bool) {
        let _ = self.commands.send(Command::PipAnimate { level, from, to, duration_ms, then_disable });
    }

    pub fn set_trans_rate(&self, level: usize, frames: u32) {
        if let Some(r) = self.trans_rate_ms.get(level) {
            r.store(frames_to_ms(frames), Ordering::Relaxed);
        }
    }

    pub fn set_dve_box(&self, level: usize, box_: DveBox) {
        let _ = self.commands.send(Command::SetDveBox(level, box_));
    }

    pub fn reset_dve(&self, level: usize) {
        let _ = self.commands.send(Command::ResetDve(level));
    }

    pub fn set_keyer_enabled(&self, level: usize, enabled: bool) {
        let _ = self.commands.send(Command::SetKeyerEnabled(level, enabled));
    }

    pub fn set_keyfill_inputs(&self, inputs: Vec<DiscoveredKeyFill>) {
        let _ = self.commands.send(Command::SetKeyFillInputs(inputs));
    }

    /// `fill_sender_id` wählt das Fill+Key-Paar (identifiziert über den
    /// Fill-Sender, s. `DiscoveredKeyFill`), `None` schaltet zurück auf
    /// die synthetische Test-Farbfläche (Default, s. `build`).
    pub fn set_keyer_source(&self, level: usize, fill_sender_id: Option<String>) {
        let _ = self.commands.send(Command::SetKeyerSource(level, fill_sender_id));
    }

    /// PIP-Layer (Nutzerwunsch 2026-07-22, s. Moduldoku "PIP als
    /// eigenständiger Layer") — Sichtbarkeit, gleiches Muster wie
    /// `set_keyer_enabled`. `dve.setBox`/`dve.reset` (s. `set_dve_box`/
    /// `reset_dve` oben, unverändert) steuern seither die Box-Geometrie
    /// dieses Layers statt des PGM-Bilds selbst.
    pub fn set_pip_enabled(&self, level: usize, enabled: bool) {
        let _ = self.commands.send(Command::SetPipEnabled(level, enabled));
    }

    /// `sender_id` wählt eine beliebige Crosspoint-Quelle (`crosspoint.
    /// inputs`, kein Fill+Key-Paar nötig — PIP zeigt ein normales Bild),
    /// `None` schaltet auf den Schwarzbild-Fallback zurück.
    pub fn set_pip_source(&self, level: usize, sender_id: Option<String>) {
        let _ = self.commands.send(Command::SetPipSource(level, sender_id));
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
        // Quadratische Pixel FEST: nur dann setzt `videoscale add-borders` die
        // Quelle mit erhaltenem Seitenverhältnis und ZENTRIERT (Balken
        // seitlich/oben+unten) ins Zielbild. Ohne feste PAR wählte es die PAR
        // selbst, der `compositor` rechnete sie in eine 960×720-Fläche links
        // oben um (4:3-Quelle im 16:9-Mixer stand links, rechts schwarz).
        .field("pixel-aspect-ratio", gst::Fraction::new(1, 1))
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
    // `new_unsynced()` + `activate()` erst nach vollständiger Verlinkung
    // unten (`docs/decisions.md` Nachtrag 272, s. ausführliche Doku bei
    // `build_source_branch`) — gleicher Bug wäre hier sonst ebenso
    // möglich (Fill/Key-Quelle friert dauerhaft ein).
    // Fill+Key gehören zusammen: eigene Synchronization-Group NUR für dieses
    // Paar (Kapitel 30.4) — alle übrigen Mixer-Eingänge bleiben ungekoppelt.
    let pair_group = context.create_sync_group();
    let fill_input = MxlVideoInput::new_unsynced_in_group(pipeline, context.clone(), &keyfill.fill_flow_id, pair_group.clone())
        .map_err(|e| format!("MxlVideoInput(keyer-fill, {}): {e}", keyfill.fill_sender_id))?;
    let fill_caps = gst::ElementFactory::make("capsfilter")
        .property("caps", keyfill_fill_caps())
        .build()
        .map_err(|e| format!("capsfilter (keyer-fill): {e}"))?;
    pipeline.add(&fill_caps).map_err(|e| format!("add keyer-fill caps: {e}"))?;
    gst::Element::link(&fill_input.tail, &fill_caps).map_err(|e| format!("link keyer-fill caps: {e}"))?;

    let key_input = MxlVideoInput::new_unsynced_in_group(pipeline, context.clone(), &keyfill.key_flow_id, pair_group)
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

    fill_input
        .activate()
        .map_err(|e| format!("activate MxlVideoInput(keyer-fill, {}): {e}", keyfill.fill_sender_id))?;
    key_input
        .activate()
        .map_err(|e| format!("activate MxlVideoInput(keyer-key, {}): {e}", keyfill.key_sender_id))?;

    Ok((alphacombine, fill_input, key_input))
}

/// Ein normalisierter Zweig (`videoconvert ! videoscale ! videorate !
/// capsfilter(rgba)`) vor einem `input-selector`-Sink-Pad — gemeinsame
/// Bauvorschrift für Programm- und Preset-Zweig eines Eingangs. Gibt neben
/// dem `capsfilter` (Anschlusspunkt für den Aufrufer) auch alle vier
/// selbst hinzugefügten Elemente zurück, damit ein Aufrufer, der diesen
/// einen Zweig später wieder verwerfen muss (s. `build_one_input`), sie
/// gezielt aus der Pipeline entfernen kann statt sie verwaisen zu lassen.
///
/// `native` = native Bildgröße der Quelle (`MxlVideoInput::width/height`),
/// sofern bekannt: dann läuft die Software-Kette über
/// [`build_normalized_branch_sw`] (CPU-optimierte Reihenfolge), sonst die
/// bisherige Kette (`None`, oder GPU-Pfad).
fn build_normalized_branch(
    pipeline: &gst::Pipeline,
    tail: &gst::Element,
    name_suffix: &str,
    width: u32,
    height: u32,
    native: Option<(u32, u32)>,
    hwaccel: omp_mediaio::hwaccel::HwAccel,
) -> Result<(gst::Element, Vec<gst::Element>), String> {
    if let (Some((sw, sh)), false) = (native, hwaccel.video_convert_scale_available()) {
        return build_normalized_branch_sw(pipeline, tail, name_suffix, sw, sh, width, height);
    }
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
    pipeline.add(&queue).map_err(|e| format!("add branch elements ({name_suffix}): {e}"))?;
    gst::Element::link(tail, &queue).map_err(|e| format!("link branch ({name_suffix}): {e}"))?;

    // Bugliste 2026-09-25 #7: Format+Größe per GPU (`vaapipostproc`),
    // wenn auf diesem Host per Selbsttest nachgewiesen nutzbar (s.
    // `omp_mediaio::hwaccel`-Moduldoku — reine Existenzprüfung wäre hier
    // unsicher gewesen, live gefunden per SEGFAULT auf virtio-gpu/virgl),
    // sonst unverändert `videoconvert ! videoscale`. OHNE Framerate in
    // diesen Ziel-Caps — die übernimmt weiterhin ausschließlich das
    // nachfolgende `videorate` (kein GPU-Äquivalent dafür im Einsatz).
    let format_size_caps = gst::Caps::builder("video/x-raw").field("format", "RGBA").field("width", width as i32).field("height", height as i32).build();
    let (convert_scale_tail, mut elements) =
        omp_mediaio::hwaccel::build_convert_scale(pipeline, &queue, name_suffix, &format_size_caps, hwaccel)?;

    let videorate = gst::ElementFactory::make("videorate")
        .build()
        .map_err(|e| format!("videorate ({name_suffix}): {e}"))?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", rgba_caps(width, height))
        .build()
        .map_err(|e| format!("capsfilter ({name_suffix}): {e}"))?;
    pipeline
        .add(&videorate)
        .and_then(|()| pipeline.add(&caps))
        .map_err(|e| format!("add branch elements ({name_suffix}): {e}"))?;
    gst::Element::link_many([&convert_scale_tail, &videorate, &caps]).map_err(|e| format!("link branch ({name_suffix}): {e}"))?;

    elements.insert(0, queue);
    elements.push(videorate);
    elements.push(caps.clone());
    Ok((caps, elements))
}

/// Schritte der Software-Normalisierung, abhängig von Quell- und Zielgröße —
/// reine Entscheidungslogik, getrennt vom GStreamer-Aufbau (testbar).
///
/// **CPU-Befund (2026-10-02, „Video-Mixer braucht unmengen CPU", gemessen mit
/// `gst-launch` pro Eingang bei 25 fps, 640×480 → 1280×720):** die frühere
/// Kette `[MxlVideoInput: videoconvert ! videoscale ! videorate] ! queue !
/// videoconvert ! videoscale ! capsfilter(RGBA Zielgröße)` ließ GStreamer
/// die Skalierung im ersten `videoscale` des `MxlVideoInput` erledigen —
/// auf dem ROHEN v210-Bild (kein SIMD-Pfad) — und danach v210 → RGBA auf der
/// vollen Zielgröße (zweiter, langsamer Pfad) konvertieren: ≈ 25–30 ms CPU
/// je Bild und Eingang (≈ 65 % eines Kerns). Neu: Quellgröße festnageln,
/// v210 → Y42B (8 Bit, 4:2:2 bleibt erhalten, ~halbe Kosten der direkten
/// v210 → RGBA-Konvertierung), dann entweder in Y42B herunterskalieren
/// (Quelle größer als Ziel) oder erst in RGBA konvertieren und dort
/// hochskalieren (Quelle kleiner/gleich) — jeweils die Variante mit den
/// weniger zu verarbeitenden Pixeln. Messung: 8,8 / 17,3 / 35,8 ms statt
/// 25,4 / 23,3 / 51,3 ms (640×480 / 1280×720 / 1920×1080 → 1280×720).
/// Pixelvergleich gegen die direkte Konvertierung: max. Abweichung 5/255
/// (Rundung), nicht über I420 — dort bis 119/255 an Farbkanten, weil die
/// vertikale Chroma-Auflösung halbiert würde.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SwScalePlan {
    /// Quelle hat bereits die Zielgröße: nur Konvertierung.
    ConvertOnly,
    /// Quelle kleiner als Ziel: in RGBA konvertieren (kleines Bild), dann RGBA hochskalieren.
    ConvertThenScale,
    /// Quelle größer als Ziel: in Y42B herunterskalieren, dann in RGBA konvertieren (kleines Bild).
    ScaleThenConvert,
}

fn sw_scale_plan(sw: u32, sh: u32, width: u32, height: u32) -> SwScalePlan {
    if (sw, sh) == (width, height) {
        SwScalePlan::ConvertOnly
    } else if (sw as u64) * (sh as u64) > (width as u64) * (height as u64) {
        SwScalePlan::ScaleThenConvert
    } else {
        SwScalePlan::ConvertThenScale
    }
}

fn raw_caps(format: Option<&str>, width: u32, height: u32) -> gst::Caps {
    let mut b = gst::Caps::builder("video/x-raw").field("width", width as i32).field("height", height as i32);
    if let Some(f) = format {
        b = b.field("format", f);
    }
    b.build()
}

/// Wie [`raw_caps`], aber mit festen quadratischen Pixeln (s. `rgba_caps`):
/// Voraussetzung dafür, dass `videoscale add-borders` zentriert letterboxt.
fn raw_caps_square(format: Option<&str>, width: u32, height: u32) -> gst::Caps {
    let mut c = raw_caps(format, width, height);
    c.make_mut().set("pixel-aspect-ratio", gst::Fraction::new(1, 1));
    c
}

/// Software-Variante von `build_normalized_branch` mit festgelegter
/// Quellgröße, s. [`SwScalePlan`]. Gleiche Außenschnittstelle (letztes
/// Element = Capsfilter mit `rgba_caps`), `videoscale` behält `add-borders`
/// (Seitenverhältnis erhalten, Nutzerfund 2026-09-30).
fn build_normalized_branch_sw(
    pipeline: &gst::Pipeline,
    tail: &gst::Element,
    name_suffix: &str,
    sw: u32,
    sh: u32,
    width: u32,
    height: u32,
) -> Result<(gst::Element, Vec<gst::Element>), String> {
    let make = |factory: &str, what: &str| -> Result<gst::Element, String> {
        gst::ElementFactory::make(factory).build().map_err(|e| format!("{factory} ({what}, {name_suffix}): {e}"))
    };
    let capsf = |caps: gst::Caps, what: &str| -> Result<gst::Element, String> {
        gst::ElementFactory::make("capsfilter")
            .property("caps", caps)
            .build()
            .map_err(|e| format!("capsfilter ({what}, {name_suffix}): {e}"))
    };
    let scaler = |what: &str| -> Result<gst::Element, String> {
        gst::ElementFactory::make("videoscale")
            .property("add-borders", true)
            .build()
            .map_err(|e| format!("videoscale ({what}, {name_suffix}): {e}"))
    };

    // Native Größe festnageln: das `videoscale` im `MxlVideoInput` bleibt
    // dadurch ein Durchreicher (sonst skaliert es das rohe v210-Bild).
    let pin = capsf(raw_caps(None, sw, sh), "pin native")?;
    let queue = gst::ElementFactory::make("queue")
        .property_from_str("leaky", "downstream")
        .property("max-size-buffers", 3u32)
        .property("max-size-bytes", 0u32)
        .property("max-size-time", 0u64)
        .build()
        .map_err(|e| format!("queue ({name_suffix}): {e}"))?;
    let to_y42b = make("videoconvert", "v210->Y42B")?;
    let y42b_native = capsf(raw_caps(Some("Y42B"), sw, sh), "Y42B native")?;

    let mut chain: Vec<gst::Element> = vec![pin, queue, to_y42b, y42b_native];
    match sw_scale_plan(sw, sh, width, height) {
        SwScalePlan::ConvertOnly => {
            chain.push(make("videoconvert", "Y42B->RGBA")?);
        }
        SwScalePlan::ConvertThenScale => {
            chain.push(make("videoconvert", "Y42B->RGBA")?);
            chain.push(capsf(raw_caps(Some("RGBA"), sw, sh), "RGBA native")?);
            chain.push(scaler("RGBA up")?);
        }
        SwScalePlan::ScaleThenConvert => {
            chain.push(scaler("Y42B down")?);
            chain.push(capsf(raw_caps_square(Some("Y42B"), width, height), "Y42B target")?);
            chain.push(make("videoconvert", "Y42B->RGBA")?);
        }
    }
    // Nach dem CPU-Gate (`refresh_source_gates`) ist beim Wieder-Öffnen eine
    // Zeitlücke im Strom: ohne Begrenzung würde `videorate` sie mit
    // Duplikaten füllen (Burst, Latenz); mit Begrenzung gilt sie als
    // Diskontinuität.
    let rate = make("videorate", "rate")?;
    rate.set_property("max-duplication-time", 200_000_000u64);
    chain.push(rate);
    let out_caps = capsf(rgba_caps(width, height), "RGBA target")?;
    chain.push(out_caps.clone());

    let refs: Vec<&gst::Element> = chain.iter().collect();
    pipeline.add_many(refs.iter().copied()).map_err(|e| format!("add branch elements ({name_suffix}): {e}"))?;
    let mut linked = vec![tail];
    linked.extend(refs.iter().copied());
    if let Err(e) = gst::Element::link_many(linked) {
        for el in &chain {
            let _ = pipeline.remove(el);
        }
        return Err(format!("link branch ({name_suffix}): {e}"));
    }
    Ok((out_caps, chain))
}

/// Vereinfachte Variante von `build_normalized_branch` für rein
/// synthetische Quellen (`videotestsrc` schwarz/Farbfläche als Fallback für
/// bg/Keyer/PIP, s. `build()`/`build_pip_tail`) — anders als bei einer
/// echten externen Quelle unbekannten Formats/unbekannter Auflösung
/// bestimmen wir das Format hier selbst: `videotestsrc` liefert jedes
/// angeforderte `video/x-raw`-Format/Auflösung/Framerate direkt, ein
/// `capsfilter` reicht, `videoconvert`/`videoscale`/`videorate` sind reine
/// Verschwendung. `queue` bleibt (gleicher Grund wie dort: `compositor`
/// braucht ein puffendes Element für seine Latenz-Query, reine
/// `GstBaseTransform`s wie `capsfilter` reichen die Query unverändert
/// durch).
///
/// **Root-Cause-Fund Bugliste 2026-09-25 #5** ("Video-Mixer M/E braucht
/// 130% CPU selbst wenn er nur schwarz als Quelle hat"): der `compositor`
/// hat pro Ebene IMMER vier verbundene Sink-Pads (fg/bg/Keyer/PIP,
/// `build()`-Doku "PIP als eigenständiger Layer") — auch ohne gewählte
/// Quelle, Keyer oder PIP laufen bg/Keyer/PIP als volle, dauerhaft aktive
/// Zubringer-Zweige mit, nur mit `alpha=0` (unsichtbar, aber weiterhin
/// jeden Frame reell gerendert/konvertiert/geblendet — `alpha=0` überspringt
/// beim `compositor` keine Arbeit, s. GStreamer-Doku). Ein dynamisches
/// Ab-/Wiederanhängen dieser Pads je nach Bedarf wäre dieselbe Klasse
/// Pad-Hot-Swap, die in Kapitel 15 Teil 3 (Rest 2, s. Moduldoku oben)
/// bereits einen dauerhaften Freeze verursacht hat und deshalb bewusst
/// zurückgebaut wurde — hier daher NICHT erneut versucht. Stattdessen: die
/// vier IMMER laufenden synthetischen Zubringer (fg-schwarz, bg-schwarz,
/// Keyer-Farbfläche, PIP-schwarz) bekommen diese schlankere Kette statt
/// der vollen `build_normalized_branch`, die für sie ohnehin nichts zu tun
/// hatte außer identisches Format in identisches Format zu "konvertieren".
/// Reale externe Quellen (angeschlossene Sender, Fill+Key, echtes PIP-
/// Bild) behalten weiterhin die volle `build_normalized_branch`-Kette,
/// deren Konvertierung dort tatsächlich gebraucht wird.
fn build_synthetic_branch(
    pipeline: &gst::Pipeline,
    tail: &gst::Element,
    name_suffix: &str,
    width: u32,
    height: u32,
) -> Result<(gst::Element, Vec<gst::Element>), String> {
    let queue = gst::ElementFactory::make("queue")
        .property_from_str("leaky", "downstream")
        .property("max-size-buffers", 3u32)
        .property("max-size-bytes", 0u32)
        .property("max-size-time", 0u64)
        .build()
        .map_err(|e| format!("queue ({name_suffix}): {e}"))?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", rgba_caps(width, height))
        .build()
        .map_err(|e| format!("capsfilter ({name_suffix}): {e}"))?;

    pipeline
        .add(&queue)
        .and_then(|()| pipeline.add(&caps))
        .map_err(|e| format!("add branch elements ({name_suffix}): {e}"))?;
    gst::Element::link_many([tail, &queue, &caps]).map_err(|e| format!("link branch ({name_suffix}): {e}"))?;

    Ok((caps.clone(), vec![queue, caps]))
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

/// EIN `MxlVideoInput`-Reader plus die normalisierende Konvertierungskette
/// (`build_normalized_branch`) für genau einen entdeckten Eingang, per
/// `tee` an beliebig viele Verbraucher verteilt (s. `tap_source_branch`) —
/// ersetzt seit "M/E-Ebenen" (docs/decisions.md, Nutzerwunsch 2026-08-14)
/// die vormalige Duplizierung (ein eigener `MxlVideoInput` je fg **und**
/// bg desselben Eingangs). Grund für den Umbau: ein dritter unabhängiger
/// Reader pro Eingang (für einen früher versuchten, wieder verworfenen
/// PST-Ausgang) hatte 2026-07-16 den MXL-Read-Livelock deutlich häufiger
/// ausgelöst (docs/decisions.md "Nachtrag 2") — mit `tee` bleibt es bei
/// GENAU EINEM Reader pro Quelle, unabhängig davon, wie viele Verbraucher
/// (fg, bg, künftig weitere M/E-Ebenen) daraus lesen. Bleibt für seine
/// gesamte Lebensdauer in Highres (s. Moduldoku "Kapitel 15 Teil 3
/// (Rest 2) rückgebaut") — kein Hot-Swap-Ziel mehr.
struct SourceBranch {
    mxl_input: MxlVideoInput,
    /// CPU-Gate (s. `refresh_source_gates`): `false` = Puffer dieses Eingangs
    /// werden direkt hinter dem `MxlVideoInput` verworfen, bevor die teure
    /// Konvertierung/Skalierung läuft. Nur ein Pad-Probe-Flag — kein
    /// Element, keine Caps-Änderung, kein Relink.
    gate: Arc<AtomicBool>,
    /// Root-Cause-Fund Bugliste 2026-09-25 #7-Nachbesserung: vorher fünf
    /// einzeln benannte Felder (`queue`/`videoconvert`/`videoscale`/
    /// `videorate`/`caps`), die `build_normalized_branch` unter der
    /// Annahme IMMER GENAU FÜNF Elemente zu liefern per `try_into()`
    /// destrukturiert hatte — seit `omp_mediaio::hwaccel::
    /// build_convert_scale` liefert die Konvertierungs-/Skalierungs-
    /// Kette GPU-abhängig ZWEI (`vaapipostproc`+`capsfilter`) ODER DREI
    /// (`videoconvert`+`videoscale`+`capsfilter`) Elemente statt fest
    /// zwei — macht die Gesamtlänge variabel (5 ODER 6), `try_into::<[_;
    /// 5]>()` paniert live reproduzierbar, sobald tatsächlich ein echter
    /// Eingang verbunden wird (nicht beim reinen Schwarzbild-Fallback,
    /// der `build_synthetic_branch` nutzt — deshalb bei der Nachtrag-
    /// 292-Live-Verifikation unentdeckt geblieben, s. docs/decisions.md).
    /// Keiner dieser fünf Namen wird je einzeln gebraucht (nur fürs
    /// Aufräumen, s. `teardown_source_branch`) — ein `Vec` plus separat
    /// gehaltenem `caps` (letztes Element, für den `caps->tee`-Link
    /// gebraucht) reicht.
    chain_elements: Vec<gst::Element>,
    tee: gst::Element,
    taps: Vec<SourceTap>,
}

/// Ein einzelner Abgriff eines `SourceBranch`s Richtung genau eines
/// Verbrauchers (z. B. `isel`- oder `isel_bg`-Sink-Pad) — eigene `queue`
/// zwischen `tee`-Src-Pad und Verbraucher (Puffer-Entkopplung, damit ein
/// langsamer/blockierter Verbraucher den `tee` und damit ALLE anderen
/// Abgriffe derselben Quelle nicht mitreißt — `GstTee` propagiert
/// Rückstau sonst an alle Zweige gleichermaßen).
struct SourceTap {
    queue: gst::Element,
    tee_pad: gst::Pad,
}

/// Baut einen `SourceBranch` (`MxlVideoInput` + Konvertierungskette +
/// `tee`, noch ohne Abgriffe), räumt bei jedem Fehlschlag vollständig
/// auf, was diese Funktion selbst bereits angelegt hat — gleicher
/// Verwaisungs-Schutz wie überall sonst in diesem Modul.
/// `sync_state_with_parent` ist beim Erstaufbau (Pipeline wechselt erst
/// danach auf `PLAYING`) ein No-Op.
#[allow(clippy::too_many_arguments)]
fn build_source_branch(
    pipeline: &gst::Pipeline,
    context: &Arc<MxlContext>,
    read_flow_id: &str,
    sender_id: &str,
    name_suffix: &str,
    width: u32,
    height: u32,
    hwaccel: omp_mediaio::hwaccel::HwAccel,
) -> Result<SourceBranch, String> {
    // `new_unsynced()` statt `new()` (`docs/decisions.md` Nachtrag 272,
    // gleicher Fix wie bereits in `omp-switcher::pipeline::build_branch`
    // — dessen Doku nannte diese Funktion hier sogar namentlich als
    // strukturell ebenso betroffen, ohne dass es je nachgezogen wurde):
    // das einphasige `new()` zog `mxl_input`s interne Kette (`appsrc`/
    // `videoconvert`/`videoscale`/`videorate`) schon VOR der externen
    // Verlinkung unten (bis zum `tee`) auf den Zustand der Eltern-
    // Pipeline hoch — `appsrc`s eigener Streaming-Task konnte dadurch
    // bereits zu pushen beginnen, BEVOR `tail` extern verlinkt war;
    // `gst_base_src_loop` meldet dann `not-linked` und stellt sich
    // PERMANENT ab, sobald ein echter Datenpuffer (nicht nur ein
    // Sticky-Event) den noch unverlinkten Pad erreicht. Live gefunden
    // (Nutzerreport 2026-09-29: "Quelle2 stallt beim Take, Preview-
    // Thumbnail läuft aber weiter") — `isel_l0:sinkN` erhielt trotz
    // korrekt empfangener stream-start/caps-Events NIE auch nur einen
    // einzigen Puffer, per `GST_DEBUG=input-selector:6,GST_EVENT:5`
    // bestätigt. `activate()` jetzt explizit erst ganz unten, NACH der
    // vollständigen Verlinkung bis zum `tee`.
    let mxl_input = MxlVideoInput::new_unsynced(pipeline, context.clone(), read_flow_id)
        .map_err(|e| format!("MxlVideoInput({name_suffix}, {sender_id}): {e}"))?;
    // CPU-Gate: Start OFFEN (sicherer Ausgangszustand, bis die erste
    // `refresh_source_gates`-Runde entscheidet). Ein Buffer-Probe, der
    // verwirft, liefert dem Vorgänger `Ok` zurück — anders als ein
    // geschlossenes `valve` (dokumentiert: erster Puffer auf geschlossenem
    // Valve tötete eine Live-Quelle mit `not-linked`) und ohne dessen
    // `drop-mode`-Falle (Standard `drop-all` verwirft auch Caps-Events).
    let gate = Arc::new(AtomicBool::new(true));
    if let Some(pad) = mxl_input.tail.static_pad("src") {
        let gate_probe = gate.clone();
        pad.add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            if gate_probe.load(Ordering::Relaxed) {
                gst::PadProbeReturn::Ok
            } else {
                gst::PadProbeReturn::Drop
            }
        });
    }
    let (_, elements) = match build_normalized_branch(
        pipeline,
        &mxl_input.tail,
        name_suffix,
        width,
        height,
        Some((mxl_input.width, mxl_input.height)),
        hwaccel,
    ) {
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
    // `caps` (letztes Element) verlinkt unten auf `tee` — s.
    // `SourceBranch::chain_elements`-Doku für den Grund, warum hier kein
    // fixes `[T; N]`-Destrukturieren mehr passiert.
    let caps = elements.last().cloned().expect("build_normalized_branch always returns at least one element");

    let tee = match gst::ElementFactory::make("tee")
        .property("allow-not-linked", true)
        .build()
    {
        Ok(t) => t,
        Err(e) => {
            remove_elements(pipeline, &elements);
            remove_mxl_video_input(pipeline, mxl_input);
            return Err(format!("tee ({name_suffix}): {e}"));
        }
    };
    if let Err(e) = pipeline.add(&tee) {
        remove_elements(pipeline, &elements);
        remove_mxl_video_input(pipeline, mxl_input);
        return Err(format!("add tee ({name_suffix}): {e}"));
    }
    if let Err(e) = tee.sync_state_with_parent() {
        remove_elements(pipeline, &elements);
        remove_elements(pipeline, &[tee]);
        remove_mxl_video_input(pipeline, mxl_input);
        return Err(format!("sync_state_with_parent (tee {name_suffix}): {e}"));
    }
    if let Err(e) = gst::Element::link(&caps, &tee) {
        remove_elements(pipeline, &elements);
        remove_elements(pipeline, &[tee]);
        remove_mxl_video_input(pipeline, mxl_input);
        return Err(format!("link caps->tee ({name_suffix}): {e}"));
    }

    if let Some(pad) = mxl_input.tail.static_pad("src") {
        dbg_probe(&pad, format!("{}/{name_suffix}/tail", pipeline.name()));
    }
    if let Some(pad) = caps.static_pad("src") {
        dbg_probe(&pad, format!("{}/{name_suffix}/precap", pipeline.name()));
    }
    // `mxl_input`s eigene interne Kette erst JETZT hochziehen, nachdem
    // sie bis zum `tee` vollständig extern verlinkt ist (s. Kommentar
    // oben, Nachtrag 272) — der `tee` selbst toleriert noch unverlinkte
    // Abgriffe (`allow-not-linked: true`, die kommen erst in
    // `tap_source_branch`), nur `appsrc`s EIGENE Kette bis hierhin darf
    // beim Aktivieren keine Lücke mehr haben.
    if let Err(e) = mxl_input.activate() {
        remove_elements(pipeline, &elements);
        remove_elements(pipeline, &[tee]);
        remove_mxl_video_input(pipeline, mxl_input);
        return Err(format!("activate MxlVideoInput ({name_suffix}): {e}"));
    }

    Ok(SourceBranch {
        mxl_input,
        gate,
        chain_elements: elements,
        tee,
        taps: Vec::new(),
    })
}

/// Baut den Elemente-Satz eines `SourceBranch`s vollständig ab (Gegenstück
/// zu `build_source_branch`) — löst zuerst alle noch offenen Abgriffe
/// (`taps`), dann den Rest.
fn teardown_source_branch(pipeline: &gst::Pipeline, branch: SourceBranch) {
    for tap in &branch.taps {
        let _ = tap.queue.set_state(gst::State::Null);
        let _ = pipeline.remove(&tap.queue);
        branch.tee.release_request_pad(&tap.tee_pad);
    }
    // `branch.caps` steckt bereits in `chain_elements` (dessen letztes
    // Element, s. `build_source_branch`) — kein doppelter Eintrag nötig,
    // `remove_elements` verträgt ohnehin ein bereits entferntes Element
    // (stiller No-Op, `let _ = pipeline.remove(el)`).
    remove_elements(pipeline, &branch.chain_elements);
    remove_elements(pipeline, &[branch.tee]);
    remove_mxl_video_input(pipeline, branch.mxl_input);
}

/// Zapft `branch` per neuem `tee`-Src-Pad für genau einen Verbraucher an
/// (eigene `queue` dazwischen, s. `SourceTap`-Doku) und verlinkt sie auf
/// den bereits reservierten Ziel-Sink-Pad (z. B. ein `isel`-/`isel_bg`-
/// Sink-Pad). Bei Fehlschlag räumt diese Funktion nur den eigenen,
/// halbfertigen Abgriff ab — `branch` selbst (und bereits erfolgreich
/// verlinkte frühere Abgriffe) bleiben unangetastet, der Aufrufer
/// entscheidet über deren weiteres Schicksal (s. `build_one_input`).
fn tap_source_branch(
    pipeline: &gst::Pipeline,
    branch: &mut SourceBranch,
    name_suffix: &str,
    sink_pad: &gst::Pad,
) -> Result<(), String> {
    let queue = gst::ElementFactory::make("queue")
        .property_from_str("leaky", "downstream")
        .property("max-size-buffers", 3u32)
        .property("max-size-bytes", 0u32)
        .property("max-size-time", 0u64)
        .build()
        .map_err(|e| format!("queue (tap {name_suffix}): {e}"))?;
    pipeline.add(&queue).map_err(|e| format!("add tap queue ({name_suffix}): {e}"))?;
    if let Err(e) = queue.sync_state_with_parent() {
        let _ = pipeline.remove(&queue);
        return Err(format!("sync_state_with_parent (tap queue {name_suffix}): {e}"));
    }

    let tee_pad = match branch.tee.request_pad_simple("src_%u") {
        Some(p) => p,
        None => {
            let _ = queue.set_state(gst::State::Null);
            let _ = pipeline.remove(&queue);
            return Err(format!("tee: request src pad failed ({name_suffix})"));
        }
    };
    let link_result = queue
        .static_pad("sink")
        .ok_or_else(|| "tap queue: no sink pad".to_string())
        .and_then(|sink| tee_pad.link(&sink).map_err(|e| format!("link tee->tap queue ({name_suffix}): {e}")))
        .and_then(|_| {
            queue
                .static_pad("src")
                .ok_or_else(|| "tap queue: no src pad".to_string())
        })
        .and_then(|src| src.link(sink_pad).map_err(|e| format!("link tap queue->sink ({name_suffix}): {e}")));
    if let Err(e) = link_result {
        branch.tee.release_request_pad(&tee_pad);
        let _ = queue.set_state(gst::State::Null);
        let _ = pipeline.remove(&queue);
        return Err(e);
    }

    if let Some(pad) = queue.static_pad("src") {
        dbg_probe(&pad, format!("{}/{name_suffix}/tap", pipeline.name()));
    }
    branch.taps.push(SourceTap { queue, tee_pad });
    Ok(())
}

/// Baut fg+bg-Abgriffe für genau einen Eingang, EINMAL geteilt über ALLE
/// M/E-Ebenen (`isels`/`isel_bgs`, je ein Element pro Ebene, gleiche
/// Reihenfolge) aus einem einzigen `SourceBranch` (s. dortige Doku).
/// Schlägt irgendein Schritt fehl (z. B. `MxlVideoInput::new` gegen einen
/// Registry-Geist-Sender, dessen Flow bereits per `mxl-info -g`
/// eingesammelt wurde), räumt diese Funktion alles, was sie selbst für
/// DIESEN Eingang bereits angelegt hat, vollständig wieder ab, statt es
/// im (bei anderen Eingängen weiterhin erfolgreichen) `pipeline`
/// verwaisen zu lassen — genau das war die beobachtete OOM-Ursache: ein
/// einzelner kaputter Sender riss früher den GANZEN Build via `?` ab, was
/// den Aufrufer zu wiederholten Voll-Rebuild-Versuchen zwang, von denen
/// jeder erneut denselben Geist traf.
///
/// Startet immer in Highres — s. Moduldoku "Architekturentscheidung
/// 2026-07-22": Lowres wird ausschließlich reaktiv per Hot-Swap-Demote
/// erreicht, nie am Build.
#[allow(clippy::too_many_arguments)]
fn build_one_input(
    pipeline: &gst::Pipeline,
    context: &Arc<MxlContext>,
    isels: &[gst::Element],
    isel_bgs: &[gst::Element],
    input: &DiscoveredInput,
    pad_index: usize,
    width: u32,
    height: u32,
    hwaccel: omp_mediaio::hwaccel::HwAccel,
) -> Result<(Vec<gst::Pad>, Vec<gst::Pad>, SourceBranch), String> {
    let mut branch = build_source_branch(
        pipeline,
        context,
        &input.flow_id,
        &input.sender_id,
        &format!("input-{pad_index}"),
        width,
        height,
        hwaccel,
    )?;

    // Rollback-Hilfe: alle bereits erfolgreich angeforderten (isel, pad)
    // -Paare, damit ein Fehlschlag auf einer SPÄTEREN Ebene die bereits
    // erfolgreich verlinkten früheren Ebenen sauber wieder freigibt,
    // statt sie an einem halbfertigen `branch` verwaist zu lassen.
    let mut requested: Vec<(&gst::Element, gst::Pad)> = Vec::with_capacity(isels.len() + isel_bgs.len());
    let fail = |branch: SourceBranch, requested: Vec<(&gst::Element, gst::Pad)>, err: String| {
        for (sel, pad) in requested {
            sel.release_request_pad(&pad);
        }
        teardown_source_branch(pipeline, branch);
        Err(err)
    };

    let mut fg_pads = Vec::with_capacity(isels.len());
    for (level_idx, isel) in isels.iter().enumerate() {
        let fg_pad = match isel.request_pad_simple(&format!("sink_{pad_index}")) {
            Some(p) => p,
            None => return fail(branch, requested, format!("isel[{level_idx}]: request sink_{pad_index} failed")),
        };
        if let Err(e) = tap_source_branch(pipeline, &mut branch, &format!("input-{pad_index}-fg{level_idx}"), &fg_pad) {
            isel.release_request_pad(&fg_pad);
            return fail(branch, requested, e);
        }
        requested.push((isel, fg_pad.clone()));
        fg_pads.push(fg_pad);
    }

    let mut bg_pads = Vec::with_capacity(isel_bgs.len());
    for (level_idx, isel_bg) in isel_bgs.iter().enumerate() {
        let bg_pad = match isel_bg.request_pad_simple(&format!("sink_{pad_index}")) {
            Some(p) => p,
            None => return fail(branch, requested, format!("isel_bg[{level_idx}]: request sink_{pad_index} failed")),
        };
        if let Err(e) = tap_source_branch(pipeline, &mut branch, &format!("input-{pad_index}-bg{level_idx}"), &bg_pad) {
            isel_bg.release_request_pad(&bg_pad);
            return fail(branch, requested, e);
        }
        requested.push((isel_bg, bg_pad.clone()));
        bg_pads.push(bg_pad);
    }

    Ok((fg_pads, bg_pads, branch))
}

/// Eine unabhängige M/E-Bank (Nutzerwunsch 2026-08-14, "dynamische Anzahl
/// an Mischerebenen... jede mit eigenem Output"): eigener Crosspoint
/// (`isel`/`isel_bg`), eigener Compositor (`comp_*_pad`), eigener Keyer/
/// PIP-Zuspieler, eigener `MxlVideoOutput`/NMOS-Sender. Was NICHT hier
/// liegt, weil es zwischen allen Ebenen GETEILT wird (s. `ActivePipeline`):
/// das `gst::Pipeline`-Objekt selbst und die `SourceBranch`es (ein
/// `MxlVideoInput`-Reader pro entdecktem Eingang, nicht pro Ebene — s.
/// dortige Doku, exakt das Sicherheitsziel des Tee-Umbaus).
struct LevelPipeline {
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

/// Der volle gebaute Pipeline-Zustand: EIN geteiltes `gst::Pipeline`-
/// Objekt (GStreamer-Elemente können nur innerhalb derselben Pipeline
/// verlinkt werden — `SourceBranch`es lassen sich deshalb nicht über
/// mehrere separate `gst::Pipeline`s teilen, s. `LevelPipeline`-Doku),
/// EIN geteilter Satz `SourceBranch`es (ein Reader pro entdecktem
/// Eingang) und `levels.len()` unabhängige M/E-Bänke (Nutzerwunsch
/// 2026-08-14). `levels.len() == 1` (Default) entspricht exakt dem
/// Vor-Ebenen-Verhalten.
struct ActivePipeline {
    pipeline: gst::Pipeline,
    /// Nie mehr gelesen seit dem Rückbau des Highres/Lowres-Hot-Swaps
    /// (s. Moduldoku "Kapitel 15 Teil 3 (Rest 2) rückgebaut") — hält die
    /// `SourceBranch`es (und damit deren `MxlVideoInput`-Reader-Threads
    /// sowie ihre pro-Ebene-`SourceTap`s) für die Lebensdauer der
    /// Pipeline am Leben, gleicher Grund wie `LevelPipeline`s
    /// `_keyer_keyfill`/`_pip_input`. Ein Eintrag pro entdecktem
    /// Eingang, unabhängig von der Ebenen-Anzahl — s. `SourceBranch`-Doku.
    _branches: HashMap<String, SourceBranch>,
    levels: Vec<LevelPipeline>,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Setzt `isel`s `active-pad` auf den Eingang `selected` (Schwarzbild bei
/// `None` oder unbekannter `senderId`) und liefert die tatsächlich aktiv
/// geschaltete `senderId` zurück.
/// So früh vor `takeAt` übergibt der Wartethread den Befehl an den Befehls-Thread (der die Quelle
/// im Hintergrund-Zweig vorbereitet, damit ihre Bilder am Compositor bereitstehen).
const TAKE_AT_EARLY_NS: u64 = 400_000_000;
/// So lange läuft nach einem geplanten Cut der Vordergrund-Zweig ein (Selektor + Warteschlangen),
/// bevor das Bild von Hintergrund auf Vordergrund zurückgelegt wird.
const FLIP_SETTLE: Duration = Duration::from_millis(600);

/// Geplanter Wechsel am Compositor (Kap. 31.4): ein Probe am Compositor-Ausgang wartet auf das
/// Ausgangsbild unmittelbar VOR dem Zielbild `takeAt` und legt dann im Aggregator-Thread die
/// Alpha-Werte um — der Compositor liest sie erst für das nächste Ausgangsbild, der Wechsel liegt
/// damit unabhängig von Warteschlangen/Latenzen genau auf dem Bild `takeAt`.
struct FlipJob {
    at_tai_ns: u64,
    /// `Some(quelle)`: harter Wechsel (Alpha umlegen, dann `FlipDone`); `None` im Feld `auto`:
    /// stattdessen eine Überblendung per `AutoTrans` anstoßen.
    cut_to: Option<Option<String>>,
    comp_fg: gst::Pad,
    comp_bg: gst::Pad,
    tx: Sender<Command>,
    level: usize,
}

static FLIPS: std::sync::LazyLock<Mutex<HashMap<usize, FlipJob>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Hängt den Wechsel-Probe an den Ausgang des Compositors einer Ebene.
fn attach_flip_probe(comp: &gst::Element, level: usize, frame_ns: u64) {
    let Some(src) = comp.static_pad("src") else { return };
    src.add_probe(gst::PadProbeType::BUFFER, move |pad, info| {
        let armed = FLIPS.lock().expect("lock poisoned").contains_key(&level);
        if !armed {
            return gst::PadProbeReturn::Ok;
        }
        if let Some(gst::PadProbeData::Buffer(buffer)) = &info.data
            && let Some(pts) = buffer.pts()
            && let Some(ev) = pad.sticky_event::<gst::event::Segment>(0)
            && let Ok(seg) = ev.segment().clone().downcast::<gst::ClockTime>()
            && let Some(running) = seg.to_running_time(pts)
            && let Some(el) = pad.parent_element()
            && let (Some(clock), Some(base)) = (el.clock(), el.base_time())
        {
            let tai_now = omp_mediaio::timebase::tai_now_ns();
            if let Some(tai) = omp_mediaio::timebase::running_to_tai(running.nseconds(), base.nseconds(), clock.time().nseconds(), tai_now) {
                let mut flips = FLIPS.lock().expect("lock poisoned");
                // Dieses Ausgangsbild ist das letzte vor dem Zielbild (oder schon später: sofort). Der Schreiber
                // beschriftet ein Bild mit dem NÄCHSTEN Rasterindex (Rundung): das Zielbild ist das erste Ausgangsbild,
                // dessen Zeit ≥ Bildgrenze − ½ Bild liegt — der Compositor-Takt hat eine beliebige Phase zum Raster
                // (Messung 2026-10-07: bei Phase > 20 ms kam das Bild sonst ein Bild zu spät).
                if flips.get(&level).is_some_and(|j| tai + frame_ns + frame_ns / 2 + 500_000 >= j.at_tai_ns)
                    && let Some(job) = flips.remove(&level)
                {
                    match job.cut_to {
                        Some(target) => {
                            job.comp_bg.set_property("alpha", 1.0f64);
                            job.comp_fg.set_property("alpha", 0.0f64);
                            let _ = job.tx.send(Command::FlipDone(job.level, target));
                        }
                        None => {
                            let _ = job.tx.send(Command::AutoTrans(job.level));
                        }
                    }
                }
            }
        }
        gst::PadProbeReturn::Ok
    });
}

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

/// Wie lange ein Eingang nach dem letzten Einsatz (Programm oder Preset)
/// noch „warm" bleibt, bevor sein CPU-Gate schließt.
const GATE_GRACE: Duration = Duration::from_secs(2);

fn is_active_pad(isel: &gst::Element, pad: Option<&gst::Pad>) -> bool {
    match (isel.property::<Option<gst::Pad>>("active-pad"), pad) {
        (Some(active), Some(p)) => &active == p,
        _ => false,
    }
}

/// CPU-Befund 2026-10-02: jeder angeschlossene Eingang wurde dauernd mit
/// voller Bildrate nach RGBA konvertiert/skaliert — auch wenn er weder auf
/// Programm (`isel`) noch auf Preset (`isel_bg`) lag; bei acht Eingängen
/// liefen sechs davon umsonst. Dieses Gate lässt die Puffer eines Eingangs
/// nur durch, solange er auf irgendeiner Ebene als `active-pad` des
/// Programm- oder Preset-Selektors gewählt ist, plus `GATE_GRACE` danach
/// (und beim ersten Sehen, damit ein frisch gebauter Eingang warm startet).
/// Wird am Anfang JEDER Schleifenrunde des Pipeline-Threads aufgerufen —
/// also unmittelbar nach jedem Kommando (`SelectPreset` öffnet das Gate
/// binnen eines Bildes), höchstens 500 ms nach Änderungen aus dem
/// Auto-Transition-Thread.
fn refresh_source_gates(p: &ActivePipeline, last_used: &mut HashMap<String, Instant>) {
    let now = Instant::now();
    for (id, branch) in &p._branches {
        let in_use = p.levels.iter().any(|lvl| {
            is_active_pad(&lvl.isel, lvl.source_pads_fg.get(id)) || is_active_pad(&lvl.isel_bg, lvl.source_pads_bg.get(id))
        });
        let seen = last_used.entry(id.clone()).or_insert(now);
        if in_use {
            *seen = now;
        }
        let open = in_use || now.duration_since(*seen) < GATE_GRACE;
        branch.gate.store(open, Ordering::Relaxed);
    }
}

/// Ob für `level` gerade ein ECHTER Hintergrund-Animations-Thread läuft
/// (nur `AutoTrans` startet einen) — anders als das gröbere
/// `fading[level]`-Flag, das AUCH "T-Bar wurde per Hand gezogen und
/// mitten in der Bewegung losgelassen, kein Thread aktiv" mit abdeckt
/// (`SetTransitionPosition` setzt `fading[level]=true` beim Start einer
/// Drag-Session, räumt es aber nur bei `pos>=1.0` wieder auf — ein an
/// beliebiger Zwischenposition losgelassener T-Bar lässt es bewusst
/// stehen, echtes Hardware-Verhalten: der Bediener kann eine Blende
/// mitten parken). Bugfund 2026-09-28 (Nutzermeldung: eine Aufnahme auf
/// Programm oder BLK schalten hatte gar keine Wirkung mehr, "alte"
/// Quelle blieb dauerhaft on air) — `Cut`/`Take`/`AutoTrans` prüften
/// bisher gegen genau dieses `fading[level]`, blockierten sich dadurch
/// nach jedem nur teilweise gezogenen T-Bar selbst PERMANENT, obwohl der
/// Code-Kommentar bei `Cut` das Gegenteil dokumentierte ("CUT ersetzt
/// einen eventuell mitten geparkten manuellen Zug" — das war nie
/// erreichbar, weil die Sperre davor schon griff). `SetTransitionPosition`
/// selbst prüfte schon immer korrekt gegen den echten Thread-Zustand
/// (s. dort) — dieselbe Prüfung jetzt auch hier.
fn auto_trans_running(fade_threads: &[Arc<Mutex<Option<std::thread::JoinHandle<()>>>>], level: usize) -> bool {
    fade_threads
        .get(level)
        .is_some_and(|h| h.lock().expect("lock poisoned").as_ref().is_some_and(|handle| !handle.is_finished()))
}

/// Liefert die `sender_id`s aus `inputs`, für die `build_one_input`
/// keinen Pad in `pads` anlegen konnte (Registry-Discovery vs. tatsächlich
/// lesbarer MXL-Flow ist ein bekanntes Zeitfenster, s. Moduldoku "Start-
/// Race zwischen IS-04-Sender-Discovery und MXL-Flow-Verfügbarkeit"
/// unten): Grundlage für die Retry-Logik der Haupt-Loop, statt einen
/// einmal übersprungenen Eingang bis zur nächsten echten Mengenänderung
/// dauerhaft schwarz zu lassen.
fn missing_input_ids(inputs: &[DiscoveredInput], pads: &HashMap<String, gst::Pad>) -> Vec<String> {
    inputs
        .iter()
        .map(|i| i.sender_id.clone())
        .filter(|id| !pads.contains_key(id))
        .collect()
}

/// Füttert `monitor.activity` (BCP-008-01 `connectionStatus`, s.
/// `run()`s Monitor-Doku) direkt aus `missing_input_ids()`s Ergebnis —
/// an beiden Stellen aufgerufen, an denen die Hauptschleife das ohnehin
/// schon berechnet.
fn report_missing_inputs(monitor: &omp_node_sdk::Monitor, missing: &[String]) {
    let delay = monitor.status_reporting_delay();
    let level = if missing.is_empty() { omp_node_sdk::HealthLevel::Healthy } else { omp_node_sdk::HealthLevel::Unhealthy };
    monitor.activity.observe(
        level,
        delay,
        Some(&format!("{} Crosspoint-Eingang/-Eingänge nicht lesbar (Flow not found): {missing:?}", missing.len())),
    );
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
    hwaccel: omp_mediaio::hwaccel::HwAccel,
    shared_black: &gst::Element,
) -> Result<(gst::Element, Option<MxlVideoInput>), String> {
    match pip_source_input {
        Some(input) => {
            // `new_unsynced()` + `activate()` erst nach vollständiger
            // Verlinkung (`docs/decisions.md` Nachtrag 272, s. Doku bei
            // `build_source_branch`) — gleicher Bug wäre hier sonst
            // ebenso möglich (PIP-Quelle friert dauerhaft ein).
            let mxl_input = MxlVideoInput::new_unsynced(pipeline, context.clone(), &input.flow_id)
                .map_err(|e| format!("MxlVideoInput(pip, {}): {e}", input.sender_id))?;
            let (caps, _elements) = build_normalized_branch(
                pipeline,
                &mxl_input.tail,
                "pip",
                width,
                height,
                Some((mxl_input.width, mxl_input.height)),
                hwaccel,
            )?;
            mxl_input
                .activate()
                .map_err(|e| format!("activate MxlVideoInput(pip, {}): {e}", input.sender_id))?;
            Ok((caps, Some(mxl_input)))
        }
        None => {
            // Geteiltes Schwarzbild der Ebene (`build()`), keine eigene Quelle.
            let (caps, _elements) = build_synthetic_branch(pipeline, shared_black, "pip-black", width, height)?;
            Ok((caps, None))
        }
    }
}

/// Alles, was eine M/E-Ebene braucht, AUSSER den angezapften Quellen
/// (`source_pads_fg`/`source_pads_bg`) — Zwischenstand von `build()`s
/// erster Ebenen-Schleife (Compositor+Keyer/PIP+eigener `MxlVideoOutput`),
/// bevor die Eingänge angezapft werden. Reihenfolge-Fund 2026-08-14 (s.
/// `build()`-Doku unten): der eigene `MxlVideoOutput`-Schreiber MUSS
/// existieren, bevor eine ANDERE Ebene ihn per `MxlVideoInput` als
/// Eingang öffnet (Mastereben-Routing), sonst schlägt `get_flow_def`
/// fehl — daher zwei getrennte Ebenen-Durchläufe statt einem.
struct PartialLevel {
    isel: gst::Element,
    isel_bg: gst::Element,
    black_pad_fg: gst::Pad,
    black_pad_bg: gst::Pad,
    comp_fg_pad: gst::Pad,
    comp_bg_pad: gst::Pad,
    comp_keyer_pad: gst::Pad,
    comp_pip_pad: gst::Pad,
    mxl_output: MxlVideoOutput,
    keyer_keyfill: Option<(MxlVideoInput, MxlVideoInput)>,
    pip_input: Option<MxlVideoInput>,
    flowed: Arc<AtomicBool>,
}

/// Baut die Mixer-Pipeline. Ein einzelner kaputter Eingang (z. B. ein
/// Registry-Geist-Sender, s. `build_one_input`) lässt den restlichen
/// Build nicht scheitern — er wird übersprungen und als Eintrag im
/// zweiten Rückgabewert gemeldet, den der Aufrufer (`run()`) als
/// `Event::Error` weiterreicht.
#[allow(clippy::too_many_arguments)]
fn build(
    context: &Arc<MxlContext>,
    config: &Config,
    inputs: &[DiscoveredInput],
    keyfill_inputs: &[DiscoveredKeyFill],
    // Ein Eintrag je M/E-Ebene (Nutzerwunsch 2026-08-14), gleiche
    // Reihenfolge/Länge wie `config.flow_ids` — Länge 1 entspricht dem
    // unveränderten Vor-Ebenen-Verhalten.
    keyer_sources: &[Option<String>],
    pip_sources: &[Option<String>],
    output_delays: &[Arc<AtomicU64>],
) -> Result<(ActivePipeline, Vec<String>), String> {
    let level_count = config.flow_ids.len();
    let pipeline = gst::Pipeline::new();

    // ── Ein (isel, isel_bg)-Paar je Ebene, VOR den Eingängen gebaut —
    //    `build_one_input` unten braucht sie alle gleichzeitig, um jeden
    //    Eingang per `tee` auf ALLE Ebenen zu verteilen (s. `SourceBranch`-
    //    Doku). Feste Namen ("isel"/"isel_bg"/"comp" im Vorbild) müssen
    //    hier pro Ebene eindeutig sein, sonst lehnt `pipeline.add()` das
    //    zweite Element mit demselben Namen ab.
    let mut isels = Vec::with_capacity(level_count);
    let mut isel_bgs = Vec::with_capacity(level_count);
    let mut black_pads_fg = Vec::with_capacity(level_count);
    // Je Ebene EIN geteiltes Schwarzbild (`tee`) für fg, bg und PIP-Fallback.
    let mut black_tees: Vec<gst::Element> = Vec::with_capacity(level_count);
    let mut black_pads_bg = Vec::with_capacity(level_count);
    for level_idx in 0..level_count {
        let isel = gst::ElementFactory::make("input-selector")
            .name(format!("isel_l{level_idx}"))
            .property("sync-streams", false)
            .build()
            .map_err(|e| format!("input-selector (fg, level {level_idx}): {e}"))?;
        let isel_bg = gst::ElementFactory::make("input-selector")
            .name(format!("isel_bg_l{level_idx}"))
            .property("sync-streams", false)
            .build()
            .map_err(|e| format!("input-selector (bg, level {level_idx}): {e}"))?;
        pipeline
            .add(&isel)
            .and_then(|()| pipeline.add(&isel_bg))
            .map_err(|e| format!("add isel (level {level_idx}): {e}"))?;

        // ── Schwarzbild-Fallback, auf beiden Selektoren (fg + bg)
        //    verfügbar, exakt wie im Vorbild (dort black auf isel UND
        //    isel_bg gespiegelt) — je Ebene unabhängig (billig, kein
        //    MXL-Reader, kein Tee-Sharing nötig).
        // CPU-Befund 2026-10-02: früher erzeugten drei getrennte
        // `videotestsrc` (fg, bg, PIP) je Ebene dasselbe Schwarzbild (je ~2,5 ms
        // CPU pro Bild bei 720p). Jetzt EINE Quelle + `tee`: die Puffer werden
        // nur referenziert (kein Kopieren), jeder Verbraucher behält seine
        // eigene `queue` (s. `build_synthetic_branch`).
        let black_src = gst::ElementFactory::make("videotestsrc")
            .property("is-live", true)
            .build()
            .map_err(|e| format!("videotestsrc (black, level {level_idx}): {e}"))?;
        black_src.set_property_from_str("pattern", "black");
        let black_tee = gst::ElementFactory::make("tee")
            .property("allow-not-linked", true)
            .build()
            .map_err(|e| format!("tee (black, level {level_idx}): {e}"))?;
        pipeline
            .add(&black_src)
            .and_then(|()| pipeline.add(&black_tee))
            .map_err(|e| format!("add black source (level {level_idx}): {e}"))?;
        gst::Element::link(&black_src, &black_tee)
            .map_err(|e| format!("link black source to tee (level {level_idx}): {e}"))?;
        let (black_caps_fg, _) = build_synthetic_branch(
            &pipeline,
            &black_tee,
            &format!("black-fg-l{level_idx}"),
            config.width,
            config.height,
        )?;
        let (black_caps_bg, _) = build_synthetic_branch(
            &pipeline,
            &black_tee,
            &format!("black-bg-l{level_idx}"),
            config.width,
            config.height,
        )?;
        black_tees.push(black_tee);

        let black_pad_fg = isel
            .request_pad_simple("sink_0")
            .ok_or_else(|| format!("isel: request sink_0 failed (level {level_idx})"))?;
        black_caps_fg
            .static_pad("src")
            .ok_or("black-fg capsfilter: no src pad")?
            .link(&black_pad_fg)
            .map_err(|e| format!("link black-fg to isel (level {level_idx}): {e}"))?;
        let black_pad_bg = isel_bg
            .request_pad_simple("sink_0")
            .ok_or_else(|| format!("isel_bg: request sink_0 failed (level {level_idx})"))?;
        black_caps_bg
            .static_pad("src")
            .ok_or("black-bg capsfilter: no src pad")?
            .link(&black_pad_bg)
            .map_err(|e| format!("link black-bg to isel_bg (level {level_idx}): {e}"))?;

        isels.push(isel);
        isel_bgs.push(isel_bg);
        black_pads_fg.push(black_pad_fg);
        black_pads_bg.push(black_pad_bg);
    }

    // ── Pro Ebene: Compositor + Keyer/PIP-Zuspieler + eigener
    //    `MxlVideoOutput` (Nutzerwunsch 2026-08-14) — bewusst VOR dem
    //    Anzapfen der Eingänge (nächster Block unten), NICHT mehr danach
    //    wie im Vorbild vor dem Mastereben-Routing (Nachtrag 2026-08-14):
    //    live gefunden — zapft der nächste Block den eigenen PGM-Ausgang
    //    einer ANDEREN Ebene als Eingang an (Mastereben-Routing), muss
    //    dessen `MxlVideoOutput`-Schreiber zu dem Zeitpunkt bereits
    //    existieren, sonst schlägt `MxlVideoInput::new`s `get_flow_def`
    //    mit "Flow not found" fehl — reproduzierbar bei JEDEM Rebuild,
    //    nicht nur einem Start-Race (das ursprüngliche Vorbild brauchte
    //    diese Reihenfolge nicht, da nie der eigene Ausgang gelesen
    //    wurde). Ergebnis landet zunächst in `PartialLevel` (ohne
    //    `source_pads_fg`/`_bg`, die kommen erst danach), NICHT direkt in
    //    `LevelPipeline` — s. `PartialLevel`-Doku.
    let mut partial_levels = Vec::with_capacity(level_count);
    for level_idx in 0..level_count {
        let isel = isels[level_idx].clone();
        let isel_bg = isel_bgs[level_idx].clone();

        let comp = gst::ElementFactory::make("compositor")
            .name(format!("comp_l{level_idx}"))
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
            .map_err(|e| format!("compositor (level {level_idx}): {e}"))?;
        pipeline
            .add(&comp)
            .map_err(|e| format!("add compositor (level {level_idx}): {e}"))?;
        attach_flip_probe(&comp, level_idx, 1_000_000_000 * FRAMERATE_DENOMINATOR as u64 / FRAMERATE_NUMERATOR as u64);

        // ── comp.sink_0 = Programm (fg, zorder 2). Dauerhaft vollflächig
        //    (Architekturentscheidung 2026-07-22, s. Moduldoku "PIP als
        //    eigenständiger Layer"): PIP verkleinert nicht mehr das PGM-Bild
        //    selbst, sondern ist ein eigener Layer mit eigener Quelle
        //    (comp.sink_3 unten) — `apply_dve_box` trifft seither
        //    `comp_pip_pad`, nie mehr diesen Pad.
        let comp_fg_pad = comp
            .request_pad_simple("sink_0")
            .ok_or_else(|| format!("comp: request sink_0 (fg) failed (level {level_idx})"))?;
        comp_fg_pad.set_property("zorder", 2u32);
        comp_fg_pad.set_property("alpha", 1.0f64);
        comp_fg_pad.set_property("xpos", 0i32);
        comp_fg_pad.set_property("ypos", 0i32);
        comp_fg_pad.set_property("width", config.width as i32);
        comp_fg_pad.set_property("height", config.height as i32);
        isel.static_pad("src")
            .ok_or("isel: no src pad")?
            .link(&comp_fg_pad)
            .map_err(|e| format!("link isel to comp.sink_0 (level {level_idx}): {e}"))?;

        // ── comp.sink_1 = Preset-Mirror (bg, zorder 1, während normalem
        //    Betrieb transparent — alpha 0 —, während `autoTrans()` sichtbar).
        let comp_bg_pad = comp
            .request_pad_simple("sink_1")
            .ok_or_else(|| format!("comp: request sink_1 (bg) failed (level {level_idx})"))?;
        comp_bg_pad.set_property("zorder", 1u32);
        comp_bg_pad.set_property("alpha", 0.0f64);
        isel_bg
            .static_pad("src")
            .ok_or("isel_bg: no src pad")?
            .link(&comp_bg_pad)
            .map_err(|e| format!("link isel_bg to comp.sink_1 (level {level_idx}): {e}"))?;

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
        let keyer_source_input = keyer_sources[level_idx]
            .as_ref()
            .and_then(|id| keyfill_inputs.iter().find(|k| &k.fill_sender_id == id));
        // Root-Cause-Fund Bugliste 2026-09-25 #5 (s. `build_synthetic_
        // branch`-Doku): die synthetische Farbfläche (kein Fill+Key
        // gewählt) braucht keine `videoconvert`/`videoscale`/`videorate`-
        // Kette, ein echter externer Fill+Key-Flow (unbekannte Auflösung/
        // Format) weiterhin schon — deshalb hier zweigeteilt statt wie
        // vorher gemeinsam über `build_normalized_branch` danach.
        let (keyer_caps, keyer_keyfill) = match keyer_source_input {
            Some(kf) => {
                let (tail, fill_input, key_input) = build_keyfill_tail(&pipeline, context, kf)?;
                let (caps, _) = build_normalized_branch(&pipeline, &tail, &format!("keyer-l{level_idx}"), config.width, config.height, None, config.hwaccel)?;
                (caps, Some((fill_input, key_input)))
            }
            None => {
                let keyer_src = gst::ElementFactory::make("videotestsrc")
                    .property("is-live", true)
                    .property("foreground-color", KEYER_COLOR_ARGB)
                    .build()
                    .map_err(|e| format!("videotestsrc (keyer, level {level_idx}): {e}"))?;
                keyer_src.set_property_from_str("pattern", "solid-color");
                pipeline
                    .add(&keyer_src)
                    .map_err(|e| format!("add keyer source (level {level_idx}): {e}"))?;
                // Einfarbige Fläche: muss nicht in voller Mixer-Größe erzeugt
                // werden (je ~2,5 ms CPU/Bild bei 720p) — der Compositor
                // skaliert sie über `width`/`height` des Pads ohnehin auf die
                // Keyer-Box (unten), bei einer Farbfläche ohne sichtbaren
                // Unterschied.
                let (caps, _) = build_synthetic_branch(
                    &pipeline,
                    &keyer_src,
                    &format!("keyer-l{level_idx}"),
                    (config.width / 8).max(2),
                    (config.height / 8).max(2),
                )?;
                (caps, None)
            }
        };
        let comp_keyer_pad = comp
            .request_pad_simple("sink_2")
            .ok_or_else(|| format!("comp: request sink_2 (keyer) failed (level {level_idx})"))?;
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
            .map_err(|e| format!("link keyer to comp.sink_2 (level {level_idx}): {e}"))?;

        // ── comp.sink_3 = PIP (Bild-im-Bild, zorder 4, ganz oben —
        //    Architekturentscheidung 2026-07-22, s. Moduldoku "PIP als
        //    eigenständiger Layer"): unabhängig vom PGM-/PST-Bus wählbare
        //    Quelle aus `crosspoint.inputs` (nicht `keyer.inputs` — jede
        //    entdeckte Quelle taugt als PIP-Bild, kein Fill+Key-Paar nötig).
        //    Box-Geometrie kommt vom Aufrufer nach dem Build via
        //    `apply_dve_box` (dieselbe Funktion, die vorher `comp_fg_pad`
        //    traf).
        let pip_source_input = pip_sources[level_idx].as_ref().and_then(|id| inputs.iter().find(|i| &i.sender_id == id));
        let (pip_caps, pip_input) =
            build_pip_tail(&pipeline, context, pip_source_input, config.width, config.height, config.hwaccel, &black_tees[level_idx])?;
        let comp_pip_pad = comp
            .request_pad_simple("sink_3")
            .ok_or_else(|| format!("comp: request sink_3 (pip) failed (level {level_idx})"))?;
        comp_pip_pad.set_property("zorder", 4u32);
        comp_pip_pad.set_property("alpha", 0.0f64);
        pip_caps
            .static_pad("src")
            .ok_or("pip capsfilter: no src pad")?
            .link(&comp_pip_pad)
            .map_err(|e| format!("link pip to comp.sink_3 (level {level_idx}): {e}"))?;

        let comp_out_caps = gst::ElementFactory::make("capsfilter")
            .property("caps", video_caps(config.width, config.height))
            .build()
            .map_err(|e| format!("capsfilter (comp out, level {level_idx}): {e}"))?;
        pipeline
            .add(&comp_out_caps)
            .map_err(|e| format!("add comp out capsfilter (level {level_idx}): {e}"))?;
        gst::Element::link(&comp, &comp_out_caps)
            .map_err(|e| format!("link comp to caps (level {level_idx}): {e}"))?;
        if let Some(pad) = comp_out_caps.static_pad("src") {
            dbg_probe(&pad, format!("{}/comp-out{level_idx}", pipeline.name()));
        }

        let mxl_output = MxlVideoOutput::new_from_rgba(
            &pipeline,
            &comp_out_caps,
            context.clone(),
            &config.flow_ids[level_idx],
            &format!("{} L{}", config.label, level_idx + 1),
            config.width,
            config.height,
            FRAMERATE_NUMERATOR,
            FRAMERATE_DENOMINATOR,
            output_delays[level_idx].clone(),
        )
        .map_err(|e| format!("MxlVideoOutput (level {level_idx}): {e}"))?;
        mxl_output.set_active(true);
        let flowed = mxl_output.flowed_handle();

        partial_levels.push(PartialLevel {
            isel,
            isel_bg,
            black_pad_fg: black_pads_fg[level_idx].clone(),
            black_pad_bg: black_pads_bg[level_idx].clone(),
            comp_fg_pad,
            comp_bg_pad,
            comp_keyer_pad,
            comp_pip_pad,
            mxl_output,
            keyer_keyfill,
            pip_input,
            flowed,
        });
    }

    // ── Ein Eingang = EIN geteilter `SourceBranch` (s. dortige Doku),
    //    per `tee` auf jede Ebene verteilt. Läuft ERST HIER (s. Doku bei
    //    `partial_levels` oben) — jeder eigene `MxlVideoOutput`-Schreiber
    //    existiert an dieser Stelle bereits, ein Eingang, der auf den
    //    eigenen PGM-Ausgang einer ANDEREN Ebene zeigt (Mastereben-
    //    Routing), findet seinen Flow also vor. Ein einzelner kaputter
    //    Eingang wird übersprungen (`build_one_input` räumt seinen
    //    eigenen Teilbau selbst ab) statt den ganzen Build abzureißen —
    //    s. Funktionsdoku.
    let mut source_pads_fg: Vec<HashMap<String, gst::Pad>> =
        (0..level_count).map(|_| HashMap::with_capacity(inputs.len())).collect();
    let mut source_pads_bg: Vec<HashMap<String, gst::Pad>> =
        (0..level_count).map(|_| HashMap::with_capacity(inputs.len())).collect();
    let mut branches = HashMap::with_capacity(inputs.len());
    let mut warnings = Vec::new();
    for (i, input) in inputs.iter().enumerate() {
        let pad_index = i + 1;
        match build_one_input(&pipeline, context, &isels, &isel_bgs, input, pad_index, config.width, config.height, config.hwaccel) {
            Ok((fg_pads, bg_pads, branch)) => {
                for (level_idx, pad) in fg_pads.into_iter().enumerate() {
                    source_pads_fg[level_idx].insert(input.sender_id.clone(), pad);
                }
                for (level_idx, pad) in bg_pads.into_iter().enumerate() {
                    source_pads_bg[level_idx].insert(input.sender_id.clone(), pad);
                }
                branches.insert(input.sender_id.clone(), branch);
            }
            Err(e) => {
                warnings.push(format!(
                    "input {} ({}) übersprungen: {e}",
                    input.sender_id, input.label
                ));
            }
        }
    }

    // ── `LevelPipeline`s aus den beiden Teilen zusammensetzen (letzter
    //    Schritt, rein buchhalterisch — keine Pipeline-Seiteneffekte
    //    mehr).
    let mut levels = Vec::with_capacity(level_count);
    for (level_idx, partial) in partial_levels.into_iter().enumerate() {
        levels.push(LevelPipeline {
            isel: partial.isel,
            isel_bg: partial.isel_bg,
            black_pad_fg: partial.black_pad_fg,
            black_pad_bg: partial.black_pad_bg,
            source_pads_fg: std::mem::take(&mut source_pads_fg[level_idx]),
            source_pads_bg: std::mem::take(&mut source_pads_bg[level_idx]),
            comp_fg_pad: partial.comp_fg_pad,
            comp_bg_pad: partial.comp_bg_pad,
            comp_keyer_pad: partial.comp_keyer_pad,
            comp_pip_pad: partial.comp_pip_pad,
            _mxl_output: partial.mxl_output,
            _keyer_keyfill: partial.keyer_keyfill,
            _pip_input: partial.pip_input,
            flowed: partial.flowed,
        });
    }

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok((
        ActivePipeline {
            pipeline,
            _branches: branches,
            levels,
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
/// Alles, was ein Überblendungs-Frame anfasst (s. `apply_transition_frame`).
#[derive(Clone)]
struct TransPads {
    fg: gst::Pad,
    bg: gst::Pad,
    width: i32,
    height: i32,
}

fn set_pos(pad: &gst::Pad, x: i32, y: i32) {
    pad.set_property("xpos", x);
    pad.set_property("ypos", y);
}

/// Grundlage jeder Überblendung: alle Pads zurück an den Ursprung.
fn reset_positions(t: &TransPads) {
    set_pos(&t.fg, 0, 0);
    set_pos(&t.bg, 0, 0);
}

/// Setzt EINEN Überblendungs-Frame für Position `pos` (0..1): `fg` ist das
/// neue Bild (oben), `bg` das ausgehende. Gemeinsam für AUTO und T-Bar.
/// Nur Alpha und Pad-Positionen — nichts, das Caps neu verhandelt.
fn apply_transition_frame(t: &TransPads, kind: TransKind, pos: f64) {
    let pos = pos.clamp(0.0, 1.0);
    match kind {
        // Neues Bild teiltransparent über dem (deckenden) alten = lineare
        // Überblendung ohne Helligkeitseinbruch.
        TransKind::Mix => {
            t.fg.set_property("alpha", pos);
            t.bg.set_property("alpha", 1.0f64);
        }
        TransKind::VFade => {
            if pos < 0.5 {
                t.fg.set_property("alpha", 0.0f64);
                t.bg.set_property("alpha", 1.0 - 2.0 * pos);
            } else {
                t.fg.set_property("alpha", 2.0 * pos - 1.0);
                t.bg.set_property("alpha", 0.0f64);
            }
        }
        // Ganze Dauer ausblenden (`fg` bleibt unsichtbar); erst am Ende (`pos >= 1`) steht das neue Bild hart da.
        TransKind::FadeCut => {
            t.fg.set_property("alpha", if pos >= 1.0 { 1.0f64 } else { 0.0f64 });
            t.bg.set_property("alpha", if pos >= 1.0 { 0.0f64 } else { 1.0 - pos });
        }
        // Sofort Schwarz (`bg` weg), das neue Bild blendet über die ganze Dauer auf.
        TransKind::CutFade => {
            t.bg.set_property("alpha", 0.0f64);
            t.fg.set_property("alpha", pos);
        }
        slide_or_push => {
            let (dx, dy) = slide_or_push.direction().unwrap_or((1, 0));
            t.bg.set_property("alpha", 1.0f64);
            if pos <= 0.0 {
                // Start: neues Bild komplett außerhalb und unsichtbar.
                t.fg.set_property("alpha", 0.0f64);
                reset_positions(t);
                return;
            }
            let travel_x = (pos * t.width as f64).round() as i32;
            let travel_y = (pos * t.height as f64).round() as i32;
            // Neues Bild kommt von der Gegenseite herein: Position = -Richtung*(1-pos)*Größe.
            let fg_x = dx * (travel_x - t.width);
            let fg_y = dy * (travel_y - t.height);
            let (bg_x, bg_y) = if slide_or_push.is_push() { (dx * travel_x, dy * travel_y) } else { (0, 0) };
            t.fg.set_property("alpha", 1.0f64);
            set_pos(&t.bg, bg_x, bg_y);
            set_pos(&t.fg, fg_x, fg_y);
        }
    }
}

/// Endzustand nach einer abgeschlossenen Überblendung: neues Bild
/// vollflächig oben an Position 0, ausgehendes Bild ausgeblendet.
fn finish_transition(t: &TransPads) {
    reset_positions(t);
    t.fg.set_property("alpha", 1.0f64);
    t.bg.set_property("alpha", 0.0f64);
}

#[allow(clippy::too_many_arguments)]
fn spawn_autotrans(
    pads: TransPads,
    kind: TransKind,
    isel_bg: gst::Element,
    bg_target_pad: gst::Pad,
    fading: Arc<AtomicBool>,
    duration_ms: u64,
    // Manueller T-Bar (`docs/END-GOAL-FEATURES.md` §3.4 Teil 2): am Ende
    // der Rampe "retracted" der T-Bar auf Position 0 (s. `Command::
    // SetTransitionPosition`-Doku "Ruheposition"), damit ein neu
    // geladenes/verbundenes UI nach einem AUTO korrekt bei 0 startet statt
    // fälschlich bei 1 zu verharren. Kein Zwischenschritt-Progress (bewusst
    // nicht gebaut, s. Moduldoku/Plan) — ein einzelner Event am Ende reicht.
    tx: UnboundedSender<Event>,
    level: usize,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let steps = (duration_ms / STEP_MS).max(2);
        let start = std::time::Instant::now();
        // Startbild der Rampe sofort setzen: bei Cut-Fade ist es Schwarz (hartes Wegschalten des alten Bildes),
        // bei allen anderen Arten entspricht Position 0 dem unveränderten Ausgangszustand.
        apply_transition_frame(&pads, kind, 0.0);
        for i in 1..=steps {
            let target = Duration::from_millis(duration_ms * i / steps);
            if let Some(wait) = target.checked_sub(start.elapsed()) {
                std::thread::sleep(wait);
            }
            let t = (start.elapsed().as_millis() as f64 / duration_ms as f64).min(1.0);
            apply_transition_frame(&pads, kind, t);
        }
        finish_transition(&pads);
        isel_bg.set_property("active-pad", &bg_target_pad);

        fading.store(false, Ordering::Release);
        let _ = tx.send(Event::TransitionPositionChanged { level, position: 0.0 });
    })
}

/// Läuft auf einem eigenen Thread (analog `omp-switcher`s `pipeline::run`).
pub fn run(
    config: Config,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
    heartbeat: Arc<AtomicU64>,
    // AMWA BCP-008-01 (NMOS Receiver Status Monitoring, `docs/
    // decisions.md` BCP-008-Nachtrag) — informell wie bei `omp-srt-
    // gateway` (kein echter NMOS-Touchpoint: die Crosspoint-Eingänge
    // sind fremde Sender, keine eigenen Receiver dieses Nodes).
    // `connectionStatus` wird direkt an den beiden Stellen gefüttert,
    // an denen `missing_input_ids()` ohnehin schon berechnet wird (s.
    // unten) — kein separater Tick-Task nötig, dieser Thread pollt
    // bereits alle 500ms.
    monitor: Arc<omp_node_sdk::Monitor>,
) {
    if let Err(e) = gst::init() {
        let msg = format!("gst init failed: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }
    // Mixer läuft immer (kein Enable/Disable-Konzept) — sofort aktiv.
    monitor.activate();

    let context = match MxlContext::new(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let level_count = config.flow_ids.len().max(1);
    let flowed_slot: Arc<Mutex<Vec<Option<Arc<AtomicBool>>>>> = Arc::new(Mutex::new(Vec::new()));
    let output_delays: Vec<Arc<AtomicU64>> = (0..level_count).map(|_| Arc::new(AtomicU64::new(0))).collect();
    let trans_rate_ms: Vec<Arc<AtomicU64>> = (0..level_count)
        .map(|_| Arc::new(AtomicU64::new(frames_to_ms(DEFAULT_TRANS_RATE_FRAMES))))
        .collect();

    let trans_kind: Vec<Arc<AtomicU8>> = (0..level_count).map(|_| Arc::new(AtomicU8::new(TransKind::Mix.to_u8()))).collect();
    // Generationszähler je Ebene für PIP-Fahrten: jede neue Box-/PIP-Änderung
    // erhöht ihn und bricht damit eine laufende Fahrt ab.
    let pip_anim_gen: Vec<Arc<AtomicU64>> = (0..level_count).map(|_| Arc::new(AtomicU64::new(0))).collect();

    // Art der gerade laufenden manuellen T-Bar-Session je Ebene (s. `SetTransitionPosition`).
    let mut drag_kinds: Vec<TransKind> = vec![TransKind::Mix; level_count];
    let mut current_inputs: Vec<DiscoveredInput> = Vec::new();
    let mut keyfill_inputs: Vec<DiscoveredKeyFill> = Vec::new();
    let mut keyer_sources: Vec<Option<String>> = vec![None; level_count];
    let mut pip_sources: Vec<Option<String>> = vec![None; level_count];
    let mut active = match build(&context, &config, &current_inputs, &keyfill_inputs, &keyer_sources, &pip_sources, &output_delays) {
        Ok((p, _warnings)) => {
            *flowed_slot.lock().expect("lock poisoned") = p.levels.iter().map(|l| Some(l.flowed.clone())).collect();
            Some(p)
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("initial build failed: {e}")));
            let _ = ready.send(Err(e));
            return;
        }
    };
    let mut program: Vec<Option<String>> = vec![None; level_count];
    let mut preset: Vec<Option<String>> = vec![None; level_count];
    // Missing-Input-Retry (s. Doku oben bei `OLD_WRITER_DRAIN`/Nachtrag
    // Bug 2): Eingänge, die beim letzten Build keinen Pad bekamen — kein
    // festes Budget mehr, es wird auf JEDEM Leerlauf-Tick erneut versucht,
    // solange die Liste nicht leer ist. Wird nach jedem erfolgreichen
    // Rebuild neu berechnet. Eine Ebene reicht als Referenz (s.
    // `reapply_all_levels`-Doku: alle Ebenen teilen sich dieselben
    // `SourceBranch`es, ein Eingang fehlt also für ALLE Ebenen gleichzeitig
    // oder für keine).
    let mut missing_inputs: Vec<String> = Vec::new();
    let mut dve_box: Vec<DveBox> = vec![DveBox::full_frame(config.width, config.height); level_count];
    let mut keyer_enabled: Vec<bool> = vec![false; level_count];
    let mut pip_enabled: Vec<bool> = vec![false; level_count];
    let fading: Vec<Arc<AtomicBool>> = (0..level_count).map(|_| Arc::new(AtomicBool::new(false))).collect();
    let fade_threads: Vec<Arc<Mutex<Option<std::thread::JoinHandle<()>>>>> =
        (0..level_count).map(|_| Arc::new(Mutex::new(None))).collect();

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) =
        std::sync::mpsc::channel();
    let anim_tx = commands_tx.clone();
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        flowed: flowed_slot.clone(),
        output_delays: output_delays.clone(),
        trans_rate_ms: trans_rate_ms.clone(),
        trans_kind: trans_kind.clone(),
    }));

    /// Wartet auf einen laufenden Transition-Thread, falls vorhanden —
    /// vor jedem Rebuild nötig, damit der Thread nicht auf Pads einer
    /// bereits zerstörten `ActivePipeline` schreibt.
    fn join_fade(fade_thread: &Arc<Mutex<Option<std::thread::JoinHandle<()>>>>) {
        if let Some(handle) = fade_thread.lock().expect("lock poisoned").take() {
            let _ = handle.join();
        }
    }

    /// Joint+resettet ALLE Ebenen — vor jedem Voll-Rebuild nötig (der
    /// ersetzt die GESAMTE `ActivePipeline`, alle Ebenen gleichzeitig).
    fn join_all_fades(fade_threads: &[Arc<Mutex<Option<std::thread::JoinHandle<()>>>>], fading: &[Arc<AtomicBool>]) {
        for ft in fade_threads {
            join_fade(ft);
        }
        for f in fading {
            f.store(false, Ordering::Release);
        }
    }

    /// Nach einem erfolgreichen Rebuild: pro Ebene den gemerkten
    /// Programm-/DVE-/Keyer-/PIP-Zustand erneut anwenden (ein Rebuild
    /// verliert alle Pad-Properties/`active-pad`-Zustände, s.
    /// `build()`) und `ProgramChanged` je Ebene senden.
    fn reapply_all_levels(
        p: &ActivePipeline,
        program: &mut [Option<String>],
        dve_box: &[DveBox],
        keyer_enabled: &[bool],
        pip_enabled: &[bool],
        tx: &UnboundedSender<Event>,
    ) {
        for (level_idx, lvl) in p.levels.iter().enumerate() {
            let applied = switch_isel(&lvl.isel, &lvl.source_pads_fg, &lvl.black_pad_fg, &program[level_idx]);
            switch_isel(&lvl.isel_bg, &lvl.source_pads_bg, &lvl.black_pad_bg, &program[level_idx]);
            apply_dve_box(&lvl.comp_pip_pad, &dve_box[level_idx]);
            lvl.comp_keyer_pad
                .set_property("alpha", if keyer_enabled[level_idx] { 1.0f64 } else { 0.0f64 });
            lvl.comp_pip_pad
                .set_property("alpha", if pip_enabled[level_idx] { 1.0f64 } else { 0.0f64 });
            let previous = program[level_idx].clone();
            program[level_idx] = applied;
            let _ = tx.send(Event::ProgramChanged {
                level: level_idx,
                previous,
                current: program[level_idx].clone(),
            });
        }
    }

    /// Fallback-Pfad (s. jede Rebuild-Stelle unten): ein Build mit LEEREN
    /// Eingängen kann nicht scheitern (kein MXL-Reader zu öffnen) — setzt
    /// alle Ebenen konsistent auf Schwarzbild/keine Preset-Auswahl zurück.
    fn reset_all_levels_to_black(
        p: &ActivePipeline,
        program: &mut [Option<String>],
        preset: &mut [Option<String>],
        dve_box: &[DveBox],
        tx: &UnboundedSender<Event>,
    ) {
        for (level_idx, lvl) in p.levels.iter().enumerate() {
            apply_dve_box(&lvl.comp_pip_pad, &dve_box[level_idx]);
            let previous = program[level_idx].take();
            preset[level_idx] = None;
            let _ = tx.send(Event::ProgramChanged {
                level: level_idx,
                previous,
                current: None,
            });
        }
    }

    fn update_flowed(flowed_slot: &Arc<Mutex<Vec<Option<Arc<AtomicBool>>>>>, p: &ActivePipeline) {
        *flowed_slot.lock().expect("lock poisoned") = p.levels.iter().map(|l| Some(l.flowed.clone())).collect();
    }

    let mut gate_last_used: HashMap<String, Instant> = HashMap::new();
    loop {
        // omp_node_sdk::liveness::LivenessMonitor (docs/decisions.md
        // Nachtrag 130/131).
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        if let Some(p) = &active {
            refresh_source_gates(p, &mut gate_last_used);
        }

        let received = match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::At(at, inner)) => {
                // Geplanter Take/Cut/Mix (Kap. 31.4): Zielquelle jetzt im Hintergrund-Zweig bereitstellen und
                // den Wechsel am Compositor auf das Bild `takeAt` scharf schalten. Ohne aktive Pipeline oder
                // bei laufender Überblendung: wie ein sofortiger Befehl.
                let plan = match &*inner {
                    Command::Take(level, sender) => Some((*level, Some(sender.clone()))),
                    Command::Cut(level) => preset.get(*level).map(|p| (*level, Some(p.clone()))),
                    Command::AutoTrans(level) => Some((*level, None)),
                    _ => None,
                };
                let armed = plan.and_then(|(level, cut_to)| {
                    if auto_trans_running(&fade_threads, level) {
                        return None;
                    }
                    let lvl = active.as_ref()?.levels.get(level)?;
                    if let Some(target) = &cut_to {
                        switch_isel(&lvl.isel_bg, &lvl.source_pads_bg, &lvl.black_pad_bg, target);
                    }
                    FLIPS.lock().expect("lock poisoned").insert(
                        level,
                        FlipJob {
                            at_tai_ns: at,
                            cut_to,
                            comp_fg: lvl.comp_fg_pad.clone(),
                            comp_bg: lvl.comp_bg_pad.clone(),
                            tx: anim_tx.clone(),
                            level,
                        },
                    );
                    Some(())
                });
                match armed {
                    Some(()) => continue,
                    None => Ok(*inner),
                }
            }
            other => other,
        };
        match received {
            Ok(Command::At(..)) => {}
            // Geplanter Cut ist am Compositor erfolgt (Alpha umgelegt): Programm-Zustand nachziehen, den
            // Vordergrund-Selektor auf die Quelle stellen und nach `FLIP_SETTLE` das Bild vom Hintergrund
            // auf den Vordergrund zurücklegen (dann zeigen beide dieselbe Quelle — unsichtbarer Tausch).
            Ok(Command::FlipDone(level, target)) => {
                if let (Some(p), Some(prog), Some(fading_l)) = (
                    active.as_mut().and_then(|a| a.levels.get_mut(level)),
                    program.get_mut(level),
                    fading.get(level),
                ) {
                    let previous = prog.clone();
                    let applied = switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &target);
                    *prog = applied;
                    fading_l.store(false, Ordering::Release);
                    let _ = tx.send(Event::ProgramChanged { level, previous, current: prog.clone() });
                    let _ = tx.send(Event::TransitionPositionChanged { level, position: 0.0 });
                    let settle_tx = anim_tx.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(FLIP_SETTLE);
                        let _ = settle_tx.send(Command::FlipSettle(level, target));
                    });
                }
            }
            Ok(Command::FlipSettle(level, target)) => {
                if let (Some(p), Some(prog)) = (active.as_mut().and_then(|a| a.levels.get_mut(level)), program.get(level))
                    && *prog == target
                    && !auto_trans_running(&fade_threads, level)
                {
                    switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &target);
                    p.comp_fg_pad.set_property("alpha", 1.0f64);
                    p.comp_bg_pad.set_property("alpha", 0.0f64);
                    set_pos(&p.comp_fg_pad, 0, 0);
                    set_pos(&p.comp_bg_pad, 0, 0);
                }
            }
            Ok(Command::SetInputs(inputs)) => {
                if inputs_changed(&current_inputs, &inputs) {
                    current_inputs = inputs;
                    join_all_fades(&fade_threads, &fading);
                    active = None;
                    std::thread::sleep(OLD_WRITER_DRAIN);
                    match build(&context, &config, &current_inputs, &keyfill_inputs, &keyer_sources, &pip_sources, &output_delays) {
                        Ok((p, warnings)) => {
                            for w in warnings {
                                let _ = tx.send(Event::Error(w));
                            }
                            reapply_all_levels(&p, &mut program, &dve_box, &keyer_enabled, &pip_enabled, &tx);
                            missing_inputs = p
                                .levels
                                .first()
                                .map(|l| missing_input_ids(&current_inputs, &l.source_pads_fg))
                                .unwrap_or_default();
                            report_missing_inputs(&monitor, &missing_inputs);
                            update_flowed(&flowed_slot, &p);
                            active = Some(p);
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
                            match build(&context, &config, &[], &keyfill_inputs, &keyer_sources, &pip_sources, &output_delays) {
                                Ok((p, _warnings)) => {
                                    reset_all_levels_to_black(&p, &mut program, &mut preset, &dve_box, &tx);
                                    update_flowed(&flowed_slot, &p);
                                    active = Some(p);
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
            // Nutzerfund 2026-08-14 (bekannte, bewusst in Kauf genommene
            // Einschränkung dieser Sitzung): ein Keyer-/PIP-Quellwechsel
            // auf EINER Ebene löst — wie schon vor den M/E-Ebenen — einen
            // VOLLEN Rebuild aus (neue `MxlVideoInput`-Verbindung), der
            // seit diesem Feature ALLE Ebenen gleichzeitig kurz
            // unterbricht, nicht nur die betroffene. Isolierte
            // Teil-Rebuilds (nur die eine Ebene) sind eine gezielte
            // Folge-Optimierung, kein Teil dieser Sitzung — s.
            // Zusammenfassung an den Nutzer.
            Ok(Command::SetKeyerSource(level, source)) if keyer_sources.get(level).is_some_and(|s| *s != source) => {
                keyer_sources[level] = source;
                join_all_fades(&fade_threads, &fading);
                active = None;
                std::thread::sleep(OLD_WRITER_DRAIN);
                match build(&context, &config, &current_inputs, &keyfill_inputs, &keyer_sources, &pip_sources, &output_delays) {
                    Ok((p, warnings)) => {
                        for w in warnings {
                            let _ = tx.send(Event::Error(w));
                        }
                        reapply_all_levels(&p, &mut program, &dve_box, &keyer_enabled, &pip_enabled, &tx);
                        update_flowed(&flowed_slot, &p);
                        active = Some(p);
                    }
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!(
                            "keyer source rebuild failed: {e} — falling back to black"
                        )));
                        match build(&context, &config, &[], &keyfill_inputs, &keyer_sources, &pip_sources, &output_delays) {
                            Ok((p, _warnings)) => {
                                reset_all_levels_to_black(&p, &mut program, &mut preset, &dve_box, &tx);
                                update_flowed(&flowed_slot, &p);
                                active = Some(p);
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
            Ok(Command::SetKeyerSource(..)) => {}
            // PIP-Layer (Nutzerwunsch 2026-07-22, s. Moduldoku "PIP als
            // eigenständiger Layer") — Quellwechsel, exakt gespiegelt von
            // `SetKeyerSource` oben (voller Rebuild, da eine neue
            // `MxlVideoInput`-Verbindung entsteht), nur ohne Fill+Key-Paar.
            // Gleiche Cross-Ebenen-Einschränkung wie dort.
            Ok(Command::SetPipSource(level, source)) if pip_sources.get(level).is_some_and(|s| *s != source) => {
                pip_sources[level] = source;
                join_all_fades(&fade_threads, &fading);
                active = None;
                std::thread::sleep(OLD_WRITER_DRAIN);
                match build(&context, &config, &current_inputs, &keyfill_inputs, &keyer_sources, &pip_sources, &output_delays) {
                    Ok((p, warnings)) => {
                        for w in warnings {
                            let _ = tx.send(Event::Error(w));
                        }
                        reapply_all_levels(&p, &mut program, &dve_box, &keyer_enabled, &pip_enabled, &tx);
                        update_flowed(&flowed_slot, &p);
                        active = Some(p);
                    }
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!(
                            "pip source rebuild failed: {e} — falling back to black"
                        )));
                        match build(&context, &config, &[], &keyfill_inputs, &keyer_sources, &pip_sources, &output_delays) {
                            Ok((p, _warnings)) => {
                                reset_all_levels_to_black(&p, &mut program, &mut preset, &dve_box, &tx);
                                update_flowed(&flowed_slot, &p);
                                active = Some(p);
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
            Ok(Command::SetPipSource(..)) => {}
            Ok(Command::SelectPreset(level, sender_id)) => {
                // Reine Metadaten-Änderung, bewusst ohne Pipeline-
                // Seiteneffekt: `isel_bg` bleibt bis zu `cut()`/
                // `autoTrans()` auf dem Programm stehen (Invariante s.o.)
                // — die Preset-Auswahl wird erst beim Take/AutoTrans
                // wirksam, exakt die Programm-/Preset-Bus-Semantik eines
                // Bildmischers (§13.1).
                if let Some(p) = preset.get_mut(level) {
                    *p = sender_id;
                    let _ = tx.send(Event::PresetChanged { level, preset: p.clone() });
                }
            }
            Ok(Command::Cut(level)) => {
                if auto_trans_running(&fade_threads, level) {
                    // Eine ECHT laufende Animation sofort abschließen
                    // statt überlagern (einfache Sperre) — ein bloß
                    // geparkter manueller T-Bar-Zug (kein Thread aktiv)
                    // blockiert NICHT mehr, s. `auto_trans_running`-Doku.
                    continue;
                }
                if let (Some(p), Some(prog), Some(pre), Some(fading_l)) = (
                    active.as_mut().and_then(|a| a.levels.get_mut(level)),
                    program.get_mut(level),
                    preset.get(level),
                    fading.get(level),
                ) {
                    let previous = prog.clone();
                    let applied = switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, pre);
                    p.comp_fg_pad.set_property("alpha", 1.0f64);
                    p.comp_bg_pad.set_property("alpha", 0.0f64);
                    // Ein zuvor geparkter manueller Slide/Push hinterlässt sonst Versatz.
                    set_pos(&p.comp_fg_pad, 0, 0);
                    set_pos(&p.comp_bg_pad, 0, 0);
                    // isel_bg auf denselben Eingang mitziehen (nächste
                    // Transition findet dort ein laufendes Bild vor).
                    switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, pre);
                    *prog = applied;
                    // Ein zuvor bloß geparkter manueller T-Bar-Zug wird
                    // hier vollständig zurückgesetzt (Bugfund 2026-09-28)
                    // — sonst hielte die NÄCHSTE T-Bar-Bewegung
                    // fälschlich für bereits mitten in einer Drag-Session
                    // zu sein (s. `SetTransitionPosition`s `dragging`-
                    // Prüfung).
                    fading_l.store(false, Ordering::Release);
                    let _ = tx.send(Event::ProgramChanged {
                        level,
                        previous,
                        current: prog.clone(),
                    });
                    // T-Bar "retracted" auf Ruheposition (s.
                    // `spawn_autotrans`-Doku) — CUT ersetzt einen
                    // eventuell mitten geparkten manuellen Zug.
                    let _ = tx.send(Event::TransitionPositionChanged { level, position: 0.0 });
                }
            }
            Ok(Command::Take(level, sender_id)) => {
                // PGM-Hot-Cut: identisch zu `Cut` (sofortiger fg/bg-
                // Pad-Wechsel, kein Fade), aber gegen `sender_id` statt
                // `preset` geschaltet — `preset`/`PresetChanged` bleiben
                // unverändert, exakt die Zusicherung aus `take()`s Doku.
                if auto_trans_running(&fade_threads, level) {
                    continue;
                }
                if let (Some(p), Some(prog), Some(fading_l)) = (
                    active.as_mut().and_then(|a| a.levels.get_mut(level)),
                    program.get_mut(level),
                    fading.get(level),
                ) {
                    let previous = prog.clone();
                    let applied = switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, &sender_id);
                    p.comp_fg_pad.set_property("alpha", 1.0f64);
                    p.comp_bg_pad.set_property("alpha", 0.0f64);
                    // Ein zuvor geparkter manueller Slide/Push hinterlässt sonst Versatz.
                    set_pos(&p.comp_fg_pad, 0, 0);
                    set_pos(&p.comp_bg_pad, 0, 0);
                    switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, &sender_id);
                    *prog = applied;
                    fading_l.store(false, Ordering::Release);
                    let _ = tx.send(Event::ProgramChanged {
                        level,
                        previous,
                        current: prog.clone(),
                    });
                    let _ = tx.send(Event::TransitionPositionChanged { level, position: 0.0 });
                }
            }
            Ok(Command::AutoTrans(level)) => {
                if auto_trans_running(&fade_threads, level) {
                    continue;
                }
                if let (Some(p), Some(prog), Some(pre), Some(fading_l), Some(fade_thread_l), Some(rate)) = (
                    active.as_mut().and_then(|a| a.levels.get_mut(level)),
                    program.get_mut(level),
                    preset.get(level),
                    fading.get(level),
                    fade_threads.get(level),
                    trans_rate_ms.get(level),
                ) {
                    if pre == prog {
                        // Nichts zu überblenden (Preset == Programm).
                        continue;
                    }
                    let previous = prog.clone();
                    // Programm-Zustand gilt sofort als gewechselt (Tally
                    // reagiert im Moment des Auslösens, Moduldoku) — die
                    // sichtbare Überblendung läuft danach asynchron.
                    let target_pad_bg = pre
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
                    let kind = trans_kind.get(level).map_or(TransKind::Mix, |k| TransKind::from_u8(k.load(Ordering::Relaxed)));
                    let trans_pads = TransPads {
                        fg: p.comp_fg_pad.clone(),
                        bg: p.comp_bg_pad.clone(),
                        width: config.width as i32,
                        height: config.height as i32,
                    };
                    reset_positions(&trans_pads);
                    p.comp_bg_pad.set_property("alpha", 1.0f64);
                    p.comp_fg_pad.set_property("alpha", 0.0f64);
                    switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, pre);
                    *prog = pre.clone();
                    fading_l.store(true, Ordering::Release);
                    let handle = spawn_autotrans(
                        trans_pads,
                        kind,
                        p.isel_bg.clone(),
                        target_pad_bg,
                        fading_l.clone(),
                        rate.load(Ordering::Relaxed),
                        tx.clone(),
                        level,
                    );
                    *fade_thread_l.lock().expect("lock poisoned") = Some(handle);
                    let _ = tx.send(Event::ProgramChanged {
                        level,
                        previous,
                        current: prog.clone(),
                    });
                }
            }
            // Manueller T-Bar (`docs/END-GOAL-FEATURES.md` §3.4 Teil 2,
            // Nutzerauftrag 2026-09-04): synchron im Command-Thread statt
            // per Hintergrund-Thread wie `AutoTrans` — jeder Aufruf setzt
            // die Compositor-Alpha direkt, kein Ramping nötig (das UI
            // liefert bereits die Zwischenwerte, pointermove-getaktet).
            //
            // `fading[level]` dient hier als reine "wird gerade manuell
            // gezogen"-Markierung (identisches Feld wie bei AutoTrans, aber
            // AutoTrans' eigener Thread ist die einzige andere Quelle, die
            // es setzt/löscht) — `is_finished()` auf dem zuletzt
            // gespeicherten Thread-Handle unterscheidet "eine ECHTE
            // AUTO-Rampe läuft gerade" (blockieren) von "das ist meine
            // eigene, bereits laufende Drag-Session" (fortsetzen): der
            // Handle-Slot wird sonst nie auf `None` zurückgesetzt (nur bei
            // einem Voll-Rebuild, `join_all_fades`), aber `spawn_autotrans`
            // räumt `fading` synchron als LETZTEN Schritt vor seiner
            // Rückkehr auf — `is_finished()==true` garantiert also bereits
            // `fading==false` an dieser Stelle, kein Race.
            Ok(Command::SetTransitionPosition(level, raw_pos)) => {
                let pos = raw_pos.clamp(0.0, 1.0);
                if let (Some(p), Some(prog), Some(pre), Some(fading_l), Some(fade_thread_l)) = (
                    active.as_mut().and_then(|a| a.levels.get_mut(level)),
                    program.get_mut(level),
                    preset.get(level),
                    fading.get(level),
                    fade_threads.get(level),
                ) {
                    let auto_running = fade_thread_l
                        .lock()
                        .expect("lock poisoned")
                        .as_ref()
                        .is_some_and(|h| !h.is_finished());
                    if auto_running {
                        continue;
                    }
                    let dragging = fading_l.load(Ordering::Acquire);
                    if !dragging {
                        if pos <= 0.0 || pre == prog {
                            // Ruheposition oder nichts zum Überblenden
                            // (Preset == Programm, gleicher Guard wie
                            // AutoTrans) — kein Effekt.
                            continue;
                        }
                        // Start einer neuen Drag-Session — identischer
                        // Aufbau wie der Beginn von `AutoTrans` (isel(fg)
                        // sofort auf `pre` schalten, bg zeigt weiterhin das
                        // alte Bild), nur OHNE sofortigen Programm-/
                        // Tally-Commit (der folgt erst bei `pos>=1.0`
                        // unten).
                        // Die Art wird beim Start der Drag-Session festgehalten,
                        // ein Wechsel mitten im Zug wirkt erst beim nächsten Zug.
                        drag_kinds[level] =
                            trans_kind.get(level).map_or(TransKind::Mix, |k| TransKind::from_u8(k.load(Ordering::Relaxed)));
                        let start_pads = TransPads {
                            fg: p.comp_fg_pad.clone(),
                            bg: p.comp_bg_pad.clone(),
                            width: config.width as i32,
                            height: config.height as i32,
                        };
                        reset_positions(&start_pads);
                        p.comp_bg_pad.set_property("alpha", 1.0f64);
                        p.comp_fg_pad.set_property("alpha", 0.0f64);
                        switch_isel(&p.isel, &p.source_pads_fg, &p.black_pad_fg, pre);
                        fading_l.store(true, Ordering::Release);
                    }
                    let kind = drag_kinds[level];
                    let trans_pads = TransPads {
                        fg: p.comp_fg_pad.clone(),
                        bg: p.comp_bg_pad.clone(),
                        width: config.width as i32,
                        height: config.height as i32,
                    };
                    apply_transition_frame(&trans_pads, kind, pos);
                    if pos >= 1.0 {
                        finish_transition(&trans_pads);
                        // Abschluss-Kommit (`docs/END-GOAL-FEATURES.md`
                        // §3.4 Teil 2) — identisch zum Ende von
                        // `spawn_autotrans`, inkl. T-Bar-Rückstellung auf
                        // die Ruheposition 0 für den nächsten Zug.
                        switch_isel(&p.isel_bg, &p.source_pads_bg, &p.black_pad_bg, pre);
                        let previous = prog.clone();
                        *prog = pre.clone();
                        fading_l.store(false, Ordering::Release);
                        let _ = tx.send(Event::ProgramChanged { level, previous, current: prog.clone() });
                        let _ = tx.send(Event::TransitionPositionChanged { level, position: 0.0 });
                    } else {
                        if pos <= 0.0 {
                            // Sauberer Abbruch: zurück auf 0 gezogen, bevor
                            // der Endanschlag erreicht wurde — Programm
                            // bleibt unverändert, Sperre wird wieder
                            // freigegeben.
                            reset_positions(&trans_pads);
                            fading_l.store(false, Ordering::Release);
                        }
                        let _ = tx.send(Event::TransitionPositionChanged { level, position: pos });
                    }
                }
            }
            Ok(Command::PipAnimate { level, from, to, duration_ms, then_disable }) => {
                if let (Some(b), Some(anim_gen)) = (dve_box.get_mut(level), pip_anim_gen.get(level)) {
                    let my_gen = anim_gen.fetch_add(1, Ordering::AcqRel) + 1;
                    *b = from;
                    if let Some(p) = active.as_ref().and_then(|a| a.levels.get(level)) {
                        apply_dve_box(&p.comp_pip_pad, &from);
                        let pad = p.comp_pip_pad.clone();
                        let anim_gen = anim_gen.clone();
                        let cmd_tx = anim_tx.clone();
                        std::thread::spawn(move || {
                            let steps = (duration_ms / STEP_MS).max(1);
                            let start = std::time::Instant::now();
                            for i in 1..=steps {
                                let target = Duration::from_millis(duration_ms * i / steps);
                                if let Some(wait) = target.checked_sub(start.elapsed()) {
                                    std::thread::sleep(wait);
                                }
                                if anim_gen.load(Ordering::Acquire) != my_gen {
                                    return; // von neuerer Box-/PIP-Änderung abgelöst
                                }
                                let t = (start.elapsed().as_millis() as f64 / duration_ms.max(1) as f64).min(1.0);
                                let e = t * t * (3.0 - 2.0 * t); // Ease in/out
                                let lerp = |a: i32, b: i32| (a as f64 + (b - a) as f64 * e).round() as i32;
                                apply_dve_box(
                                    &pad,
                                    &DveBox {
                                        x: lerp(from.x, to.x),
                                        y: lerp(from.y, to.y),
                                        width: lerp(from.width, to.width).max(2),
                                        height: lerp(from.height, to.height).max(2),
                                    },
                                );
                            }
                            if anim_gen.load(Ordering::Acquire) != my_gen {
                                return;
                            }
                            let _ = cmd_tx.send(Command::SetDveBox(level, to));
                            if then_disable {
                                let _ = cmd_tx.send(Command::SetPipEnabled(level, false));
                            }
                        });
                    }
                    let _ = tx.send(Event::DveBoxChanged { level, box_: from });
                }
            }
            Ok(Command::SetDveBox(level, box_)) => {
                if let Some(g) = pip_anim_gen.get(level) {
                    g.fetch_add(1, Ordering::AcqRel);
                }
                if let Some(b) = dve_box.get_mut(level) {
                    *b = box_;
                    if let Some(p) = active.as_ref().and_then(|a| a.levels.get(level)) {
                        apply_dve_box(&p.comp_pip_pad, b);
                    }
                    let _ = tx.send(Event::DveBoxChanged { level, box_: *b });
                }
            }
            Ok(Command::ResetDve(level)) => {
                if let Some(g) = pip_anim_gen.get(level) {
                    g.fetch_add(1, Ordering::AcqRel);
                }
                if let Some(b) = dve_box.get_mut(level) {
                    *b = DveBox::full_frame(config.width, config.height);
                    if let Some(p) = active.as_ref().and_then(|a| a.levels.get(level)) {
                        apply_dve_box(&p.comp_pip_pad, b);
                    }
                    let _ = tx.send(Event::DveBoxChanged { level, box_: *b });
                }
            }
            Ok(Command::SetKeyerEnabled(level, enabled)) => {
                if let Some(e) = keyer_enabled.get_mut(level) {
                    *e = enabled;
                    if let Some(p) = active.as_ref().and_then(|a| a.levels.get(level)) {
                        p.comp_keyer_pad
                            .set_property("alpha", if enabled { 1.0f64 } else { 0.0f64 });
                    }
                    let _ = tx.send(Event::KeyerChanged { level, enabled });
                }
            }
            Ok(Command::SetPipEnabled(level, enabled)) => {
                if let Some(g) = pip_anim_gen.get(level) {
                    g.fetch_add(1, Ordering::AcqRel);
                }
                if let Some(e) = pip_enabled.get_mut(level) {
                    *e = enabled;
                    if let Some(p) = active.as_ref().and_then(|a| a.levels.get(level)) {
                        p.comp_pip_pad
                            .set_property("alpha", if enabled { 1.0f64 } else { 0.0f64 });
                    }
                    let _ = tx.send(Event::PipChanged { level, enabled });
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Missing-Input-Retry (s. Doku bei `OLD_WRITER_DRAIN`/
                // Nachtrag Bug 2): ohne diesen Zweig bliebe ein beim
                // letzten Build übersprungener Eingang bis zur nächsten
                // echten Mengenänderung dauerhaft schwarz — kein Wechsel
                // der Eingangsmenge nötig hier, nur ein erneuter Versuch
                // mit denselben `current_inputs`, falls der Flow
                // inzwischen lesbar geworden ist. Kein festes Budget mehr:
                // ein `omp-channel-player` legt seinen MXL-Output-Flow
                // erst beim ersten `load()` an, das kann beliebig lange
                // nach der NMOS-Registrierung passieren (z. B. erst beim
                // ersten `cue` via `omp-playout-automation`) — deshalb
                // wird hier versucht, bis es klappt oder sich die
                // Sender-ID-Menge ändert (dann übernimmt der `SetInputs`-
                // Zweig oben).
                if !missing_inputs.is_empty() && fading.iter().all(|f| !f.load(Ordering::Acquire)) {
                    join_all_fades(&fade_threads, &fading);
                    active = None;
                    std::thread::sleep(OLD_WRITER_DRAIN);
                    match build(&context, &config, &current_inputs, &keyfill_inputs, &keyer_sources, &pip_sources, &output_delays) {
                        Ok((p, warnings)) => {
                            for w in warnings {
                                let _ = tx.send(Event::Error(w));
                            }
                            reapply_all_levels(&p, &mut program, &dve_box, &keyer_enabled, &pip_enabled, &tx);
                            let still_missing = p
                                .levels
                                .first()
                                .map(|l| missing_input_ids(&current_inputs, &l.source_pads_fg))
                                .unwrap_or_default();
                            // s. `Event::Info`-Doku: der Gegenpart zur
                            // "übersprungen"-Warnung fehlte bisher komplett
                            // — ohne dies sah ein auf rohes stdout
                            // schauender Operator nach einem erfolgreichen
                            // Retry nie einen Hinweis, dass der Eingang
                            // wieder lebt (letzte Log-Zeile blieb für den
                            // Rest der Pipeline-Lebensdauer der Fehler).
                            for id in &missing_inputs {
                                if !still_missing.contains(id) {
                                    if let Some(input) = current_inputs.iter().find(|i| &i.sender_id == id) {
                                        let _ = tx.send(Event::Info(format!(
                                            "input {} ({}) wieder verfügbar (Flow jetzt lesbar)",
                                            input.sender_id, input.label
                                        )));
                                    }
                                }
                            }
                            missing_inputs = still_missing;
                            report_missing_inputs(&monitor, &missing_inputs);
                            update_flowed(&flowed_slot, &p);
                            active = Some(p);
                        }
                        Err(e) => {
                            let _ = tx.send(Event::Error(format!(
                                "missing-input retry rebuild failed: {e} — falling back to black"
                            )));
                            match build(&context, &config, &[], &keyfill_inputs, &keyer_sources, &pip_sources, &output_delays) {
                                Ok((p, _warnings)) => {
                                    reset_all_levels_to_black(&p, &mut program, &mut preset, &dve_box, &tx);
                                    update_flowed(&flowed_slot, &p);
                                    active = Some(p);
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
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    join_all_fades(&fade_threads, &fading);
    drop(active);
}

#[cfg(test)]
mod trans_kind_tests {
    use super::*;

    #[test]
    fn sw_scale_plan_picks_the_variant_with_fewer_pixels_to_process() {
        // Quelle == Ziel: nur konvertieren.
        assert_eq!(sw_scale_plan(1280, 720, 1280, 720), SwScalePlan::ConvertOnly);
        // Kleinere Quelle: erst im kleinen Bild nach RGBA, dann hochskalieren.
        assert_eq!(sw_scale_plan(640, 480, 1280, 720), SwScalePlan::ConvertThenScale);
        // Größere Quelle: erst herunterskalieren (Y42B), dann konvertieren.
        assert_eq!(sw_scale_plan(1920, 1080, 1280, 720), SwScalePlan::ScaleThenConvert);
        // Gleiche Pixelzahl, andere Form: kein Herunterskalieren nötig.
        assert_eq!(sw_scale_plan(720, 1280, 1280, 720), SwScalePlan::ConvertThenScale);
    }

    #[test]
    fn names_and_ids_roundtrip() {
        for k in TransKind::ALL {
            assert_eq!(TransKind::from_name(k.name()), Some(k));
            assert_eq!(TransKind::from_u8(k.to_u8()), k);
        }
        assert_eq!(TransKind::from_name("nope"), None);
        assert_eq!(TransKind::from_u8(200), TransKind::Mix);
    }

    #[test]
    fn slide_and_push_directions() {
        assert_eq!(TransKind::Mix.direction(), None);
        assert_eq!(TransKind::VFade.direction(), None);
        assert_eq!(TransKind::FadeCut.direction(), None);
        assert_eq!(TransKind::CutFade.direction(), None);
        assert_eq!(TransKind::SlideR.direction(), Some((1, 0)));
        assert_eq!(TransKind::PushL.direction(), Some((-1, 0)));
        assert_eq!(TransKind::SlideD.direction(), Some((0, 1)));
        assert_eq!(TransKind::PushU.direction(), Some((0, -1)));
        assert!(TransKind::PushR.is_push() && !TransKind::SlideR.is_push());
    }
}

#[cfg(test)]
mod letterbox_tests {
    use super::*;
    use gstreamer_app as gst_app;

    /// Spaltenbereich [erste, letzte] der nicht-schwarzen Pixel in der
    /// Bildmitte (RGBA) sowie Zeilenbereich in der Bildmitte-Spalte.
    fn content_bounds(buf: &[u8], w: usize, h: usize) -> ((usize, usize), (usize, usize)) {
        let lit = |x: usize, y: usize| buf[(y * w + x) * 4] > 40;
        let row = h / 2;
        let col = w / 2;
        let xs: Vec<usize> = (0..w).filter(|&x| lit(x, row)).collect();
        let ys: Vec<usize> = (0..h).filter(|&y| lit(col, y)).collect();
        ((*xs.first().unwrap(), *xs.last().unwrap()), (*ys.first().unwrap(), *ys.last().unwrap()))
    }

    /// Quelle beliebiger Größe → Mixer-Zielformat: Seitenverhältnis bleibt,
    /// Bild sitzt ZENTRIERT (gleich breite Balken links/rechts bzw. oben/unten).
    fn run(sw: u32, sh: u32) -> ((usize, usize), (usize, usize)) {
        gst::init().expect("gst init");
        let (w, h) = (1280u32, 720u32);
        let pipeline = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc")
            .property("num-buffers", 30i32)
            .property_from_str("pattern", "white")
            .property("is-live", true)
            .build()
            .unwrap();
        let caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field("format", "I420")
                    .field("width", sw as i32)
                    .field("height", sh as i32)
                    .field("framerate", gst::Fraction::new(25, 1))
                    .build(),
            )
            .build()
            .unwrap();
        let sink = gst::ElementFactory::make("appsink").property("sync", false).property("max-buffers", 1u32).property("drop", true).build().unwrap();
        pipeline.add_many([&src, &caps, &sink]).unwrap();
        src.link(&caps).unwrap();
        let (tail, _els) = build_normalized_branch_sw(&pipeline, &caps, "t", sw, sh, w, h).expect("branch");
        tail.link(&sink).unwrap();
        pipeline.set_state(gst::State::Playing).unwrap();
        let app: gst_app::AppSink = sink.dynamic_cast().unwrap();
        let mut last = None;
        for _ in 0..20 {
            if let Some(s) = app.try_pull_sample(gst::ClockTime::from_seconds(2)) {
                last = Some(s);
            } else {
                break;
            }
            if last.is_some() {
                break;
            }
        }
        let sample = last.expect("sample");
        let st = sample.caps().unwrap().structure(0).unwrap().to_owned();
        assert_eq!((st.get::<i32>("width").unwrap(), st.get::<i32>("height").unwrap()), (w as i32, h as i32));
        let buf = sample.buffer().unwrap().map_readable().unwrap();
        let r = content_bounds(buf.as_slice(), w as usize, h as usize);
        pipeline.set_state(gst::State::Null).unwrap();
        r
    }

    #[test]
    fn four_by_three_source_is_pillarboxed_and_centered() {
        let ((x0, x1), (y0, y1)) = run(640, 480);
        // 4:3 in 16:9 → 960×720 mittig: Balken je 160 px.
        assert!((x0 as i32 - 160).abs() <= 2, "linker Balken {x0}");
        assert!((1279 - x1 as i32 - 160).abs() <= 2, "rechter Balken {}", 1279 - x1);
        assert!(y0 <= 1 && y1 >= 718);
    }

    #[test]
    fn small_source_is_scaled_up_and_centered() {
        let ((x0, x1), (y0, y1)) = run(320, 240);
        assert!((x0 as i32 - 160).abs() <= 2 && (1279 - x1 as i32 - 160).abs() <= 2, "{x0} {x1}");
        assert!(y0 <= 1 && y1 >= 718);
    }

    #[test]
    fn large_source_is_scaled_down_and_centered() {
        // 1920×1200 (16:10) → 1152×720 mittig: Balken je 64 px.
        let ((x0, x1), (y0, y1)) = run(1920, 1200);
        assert!((x0 as i32 - 64).abs() <= 2 && (1279 - x1 as i32 - 64).abs() <= 2, "{x0} {x1}");
        assert!(y0 <= 1 && y1 >= 718);
    }

    #[test]
    fn wide_source_is_letterboxed_top_and_bottom_centered() {
        // 2.4:1-Quelle 1920×800 → 1280×533 mittig: Balken oben/unten je ~93 px.
        let ((x0, x1), (y0, y1)) = run(1920, 800);
        assert!(x0 <= 1 && x1 >= 1278);
        assert!((y0 as i32 - 93).abs() <= 3 && (719 - y1 as i32 - 93).abs() <= 3, "{y0} {y1}");
    }
}
