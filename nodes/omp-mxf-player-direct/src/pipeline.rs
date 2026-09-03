//! Minimale, EINZWEIGIGE MXF-Wiedergabe-Pipeline — Diagnose-/Direkt-
//! Variante von `omp-mxf-player` (Nutzerauftrag 2026-09-02: "mxf player
//! still not working! create an instance without playlist function. but
//! working to play MXF video and audio! test and verify").
//!
//! **Warum ein eigener, separater Node statt eines Modus-Schalters in
//! `omp-mxf-player` selbst:** Live-Diagnose (2026-09-02, echter Prozess
//! über den Orchestrator gestartet, `append`+`cue`+`take` über die reale
//! HTTP-API, Verifikation per `mxl-info`s Head-Index statt der bekannt
//! irreführenden `playheadPositionMs`/JPEG-Vorschau, s. docs/decisions.md
//! Nachtrag 161): `cue()`/`take()` bauen den MXF-Zweig fehlerfrei auf
//! (kein `pipeline error` im Log, `confirm_branch_state` bestätigt PAUSED
//! UND PLAYING für alle Elemente inkl. `filesrc`/`mxfdemux`), aber der
//! MXL-Ausgang bleibt DANACH komplett eingefroren (`mxl-info`s "Head
//! index" bewegt sich über 8+ Sekunden nicht — weder Video- noch
//! Audio-Flow). Das isoliert den Fehler auf die einzige Komponente, die
//! bei einem erfolgreichen `take()` NEU ins Spiel kommt: `video_isel`/
//! `isel_<group>`s `active-pad`-Umschaltung (`apply_active`,
//! `omp-mxf-player/src/pipeline.rs`) — der eigentliche Datei-Decode-Pfad
//! (`filesrc ! mxfdemux ! …`) selbst hat sich in dieser Diagnose als
//! funktionierend erwiesen (kein Fehler, bestätigter Preroll).
//!
//! Dieser Node testet/umgeht genau das: EIN einziger, fest verdrahteter
//! Zweig (kein `input-selector`, keine A/B-Slots, kein `cue()`/`take()`,
//! keine Playlist) von `filesrc`/`mxfdemux` DIREKT in
//! `MxlVideoOutput::new_paced`/`MxlAudioOutput::new_paced` — Datei kommt
//! aus `OMP_MXF_FILE` (absoluter Pfad oder relativ zu `OMP_MEDIA_DIR`) —
//! seit dem UI-Steuer-Auftrag (2026-09-03) nur noch der ANFANGS
//! vorgeschlagene Clip, kein Autoplay mehr: der Node startet im
//! Leerlauf, Wiedergabe beginnt erst auf `play`/`load` (s. `run()`-
//! Moduldoku). Alle Element-
//! Bauschritte (Video-Kette, Audio-Backbone, Track→Gruppen-Routing,
//! `no-more-pads`-Synchronisierung) sind wortgleich aus
//! `omp-mxf-player/src/pipeline.rs` übernommen (bereits als fehlerfrei
//! bestätigt, s. o.) — NUR die Verzweigung ans Ende (isel-Sink-Pad vs.
//! direkter `new_paced`-Aufruf) und die Zustands-Orchestrierung ändern
//! sich, s. `build()` unten.
//!
//! **Zustands-Orchestrierung, bewusst EINFACHER als `omp-mxf-player`:**
//! die dortige mehrphasige `request_branch_paused`/`confirm_branch_state`/
//! `request_branch_playing`-Tanz (vier Helfer, s. dortige ausführliche
//! Doku) ist NUR nötig, weil dort Zweige NACHTRÄGLICH in eine bereits
//! dauerhaft laufende, von einem ZWEITEN Slot geteilte Pipeline
//! eingefügt werden (`cue()` auf einen im Hintergrund weiterlaufenden
//! On-Air-Zweig). Dieser Node hat keinen zweiten Zweig und keine bereits
//! laufende Pipeline, in die er hineingebaut würde — der komplette Graph
//! (Datei-Decode UND MXL-Ausgänge) entsteht EINMALIG, bevor die Pipeline
//! überhaupt zum ersten Mal `Playing` angefordert wird. Das entspricht
//! exakt der Situation, die `omp-mxf-player::build()` für sein initiales,
//! STATISCHES Setup (input-selector + zwei Leerlauf-Zweige + MXL-
//! Ausgänge) ohnehin schon nutzt: ein einziger Sammel-Aufruf
//! `pipeline.set_state(Playing)`, KEINE Einzel-Element-Choreographie.
//! Für `mxfdemux`s dynamisch entstehende Pro-Tonspur-Queues (die einzige
//! wirklich asynchrone Komponente) gilt GStreamers eigenes, offiziell
//! dokumentiertes Standardmuster für dynamische Demuxer-Pads:
//! `pipeline.add()` + `element.sync_state_with_parent()` INNERHALB des
//! `pad-added`/`no-more-pads`-Handlers, während der Sammel-Übergang noch
//! läuft (s. z. B. GStreamers eigenes "Dynamic pipelines"-Tutorial) —
//! nicht das aufwendigere Zwei-Phasen-Verfahren aus `omp-mxf-player`,
//! das dort spezifisch die "anderer Slot läuft parallel weiter"-
//! Randbedingung adressiert, die hier nicht existiert.
//!
//! **Loop statt Stillstand nach EOS** (Nutzerfund 2026-09-02: "zeigt
//! automatic multiviewer nur ein Karo/Rennflaggen-Muster"): die erste
//! Fassung spielte die Datei EINMAL und stand danach für immer still —
//! per CDP live bestätigt, dass WÄHREND echter Wiedergabe reales Bild
//! ankommt (kein Rendering-Bug), das Karo-Muster war schlicht
//! Multiviewers eigene Anzeige für eine seit einer Weile inaktive
//! Quelle. `run()` baut den Zweig deshalb jetzt bei jedem EOS komplett
//! neu auf (s. dortige Doku) — dieselben `flow_id`s bleiben über alle
//! Zyklen gleich, ein Betrachter sieht denselben Flow einfach
//! durchgehend weiterlaufen statt eines neuen pro Zyklus.
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use crate::presets;

pub const DEFAULT_WIDTH: u32 = 1920;
pub const DEFAULT_HEIGHT: u32 = 1080;
pub const FRAMERATE_NUMERATOR: u32 = 25;
pub const FRAMERATE_DENOMINATOR: u32 = 1;
pub const SAMPLE_RATE: u32 = 48000;

pub struct Config {
    pub domain: String,
    pub video_flow_id: String,
    pub group_flow_ids: Vec<String>,
    pub groups: Vec<presets::ProgramGroup>,
    pub preset: presets::AudioPreset,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub file_path: String,
}

pub enum Event {
    Error(String),
}

/// Steuerkommandos für den UI-Auftrag 2026-09-03 ("mxf player (direkt
/// ohne playliste) braucht noch ein ui zum laden des clips, seeking,
/// play, stop... und audioshuffle selection"). Bewusst NUR diese fünf,
/// KEIN Jog/Shuttle/Step wie bei `omp-mxf-player` (nicht angefordert,
/// dieser Node bleibt "direkt"/minimal, s. Moduldoku oben) — Route über
/// denselben `LoopEvent`-Kanal wie das interne Zyklusende, s. `run()`.
#[derive(Clone)]
pub enum Command {
    Play,
    Stop,
    Load(String),
    SetPreset(presets::AudioPreset),
    Seek(u64),
}

/// Vereinigt externe Kommandos UND das interne "Zyklus zu Ende"-Signal
/// (vormals ein eigener `cycle_done: Sender<()>`) in EINEM Kanal — `run()`
/// kann so mit einem einzigen `recv_timeout` sowohl auf Bedienereingaben
/// als auch auf EOS/Bus-Error reagieren, statt zwei Kanäle konkurrierend
/// abfragen zu müssen.
enum LoopEvent {
    CycleDone,
    Cmd(Command),
}

struct SharedState {
    file_path: String,
    preset_id: String,
    playing: bool,
    // Vom jeweils AKTUELLEN Baulauf (`build()`) übernommen — anders als
    // eine feste Zuweisung nur beim allerersten Aufbau (das wäre nach
    // einem `Load`/`SetPreset`-Neuaufbau bereits wieder veraltet).
    video_flowed: Arc<AtomicBool>,
    group_flowed: Vec<Arc<AtomicBool>>,
}

#[derive(Clone)]
pub struct PipelineHandle {
    events: std::sync::mpsc::Sender<LoopEvent>,
    shared: Arc<Mutex<SharedState>>,
    position_ms: Arc<AtomicI64>,
    duration_ms: Arc<AtomicI64>,
}

impl PipelineHandle {
    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6): Video- UND alle
    /// Gruppen-Ausgänge müssen jeweils mindestens einmal geflossen sein
    /// — identisches Prinzip wie `omp-mxf-player::PipelineHandle::
    /// media_ready`. KEIN zusätzliches `playing`-Gate (mehr) nötig: seit
    /// `Stop` die Pipeline nur noch auf PAUSED bringt statt sie
    /// abzubauen (s. `run()`-Moduldoku "Stop pausiert, baut nicht mehr
    /// ab"), bleibt der MXL-Flow während des Stillstands ein echter,
    /// gültiger (nur eingefrorener) Datenstand — "mindestens einmal
    /// geflossen" bleibt also auch im Stillstand wahr und zutreffend.
    pub fn media_ready(&self) -> bool {
        let s = self.shared.lock().expect("lock poisoned");
        s.video_flowed.load(Ordering::Relaxed) && s.group_flowed.iter().all(|f| f.load(Ordering::Relaxed))
    }

    pub fn play(&self) {
        let _ = self.events.send(LoopEvent::Cmd(Command::Play));
    }

    pub fn stop(&self) {
        let _ = self.events.send(LoopEvent::Cmd(Command::Stop));
    }

    /// Wechselt die abgespielte Datei — startet automatisch (kein
    /// separates `play()` nötig), s. `run()`-Doku: dieser Node kennt
    /// (anders als `omp-mxf-player`) kein Cue/Take, "eine neue Datei
    /// laden" heißt hier direkt "sie jetzt zeigen".
    pub fn load(&self, file_path: String) {
        let _ = self.events.send(LoopEvent::Cmd(Command::Load(file_path)));
    }

    pub fn set_preset(&self, preset: presets::AudioPreset) {
        let _ = self.events.send(LoopEvent::Cmd(Command::SetPreset(preset)));
    }

    pub fn seek(&self, position_ms: i64) {
        let _ = self.events.send(LoopEvent::Cmd(Command::Seek(position_ms.max(0) as u64)));
    }

    pub fn is_playing(&self) -> bool {
        self.shared.lock().expect("lock poisoned").playing
    }

    pub fn current_file(&self) -> String {
        self.shared.lock().expect("lock poisoned").file_path.clone()
    }

    pub fn current_preset_id(&self) -> String {
        self.shared.lock().expect("lock poisoned").preset_id.clone()
    }

    pub fn position_ms(&self) -> i64 {
        self.position_ms.load(Ordering::Relaxed)
    }

    pub fn duration_ms(&self) -> i64 {
        self.duration_ms.load(Ordering::Relaxed)
    }

    /// Setzt einen VORAB (per `gst_pbutils::Discoverer`, s. `main.rs`)
    /// ermittelten Dauer-Wert, BEVOR überhaupt eine Pipeline gebaut
    /// wurde — Nutzerfund 2026-09-03: ohne diesen Hinweis blieb
    /// `durationMs` bis zum ersten `play` bei `0`, die Scrub-Bar der UI
    /// (deren `max` an `durationMs` gebunden ist) ließ sich also im
    /// Stillstand gar nicht sinnvoll ziehen — Seek-im-Leerlauf war zwar
    /// serverseitig längst möglich, aber über die UI praktisch
    /// unbedienbar. Wird bei laufender Wiedergabe ohnehin sofort vom
    /// nächsten Tick-Poll (`query_duration_ms`) überschrieben, ein
    /// Wettlauf ist also unschädlich.
    pub fn set_duration_hint(&self, ms: i64) {
        self.duration_ms.store(ms, Ordering::Relaxed);
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

fn group_audio_caps(channels: u32) -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("rate", SAMPLE_RATE as i32)
        .field("channels", channels as i32)
        .field("layout", "interleaved")
        .build()
}

/// S. `omp-mxf-player/src/pipeline.rs`s gleichnamige Funktion — wortgleich
/// übernommen (reine Werteumformung, keine GStreamer-Zustandslogik).
fn matrix_to_gst_array(matrix: &[Vec<f64>]) -> gst::Array {
    gst::Array::new(matrix.iter().map(|row| gst::Array::new(row.iter().copied())))
}

struct PendingAudio {
    pads: Vec<(u32, gst::Pad)>,
}

pub struct ActivePipeline {
    pipeline: gst::Pipeline,
    // Für Seek (Nutzerauftrag 2026-09-03) — dieselbe `mxfdemux`-Instanz,
    // auf der `filesrc ! mxfdemux` in `build()` unten aufsetzt.
    demux: gst::Element,
    // Zählt jeden Video-Buffer, der `vqueue`s Src-Pad passiert (Pad-Probe
    // in `build()`) — ground truth für "ein frisches Bild ist wirklich
    // auf dem Weg zu `MxlVideoOutput` angekommen", s. `perform_seek`-Doku
    // (Nachtrag 175: eine feste Wartezeit allein war unzuverlässig, ca.
    // 1 von 12 Versuchen blieb ohne sichtbares Bild — reales Warten auf
    // echten Bufferdurchsatz statt Raten macht das deterministisch).
    frame_count: Arc<AtomicU64>,
    video_flowed: Arc<AtomicBool>,
    group_flowed: Vec<Arc<AtomicBool>>,
    // MÜSSEN für die Lebensdauer der Pipeline gehalten werden: beide
    // Output-Typen setzen in ihrem `Drop` `running=false` (s.
    // omp-mediaio::mxl), was den jeweiligen `write_loop`-Thread sofort
    // beendet — ohne dieses Feld würden `mxl_video_output`/
    // `mxl_group_outputs` am Ende von `build()` (Funktionsende, lokale
    // Variable) SOFORT wieder verworfen, der Schreib-Thread also
    // startet und stirbt praktisch im selben Moment (live gefunden: der
    // Flow existierte laut `mxl-info --list` danach überhaupt nicht
    // mehr, obwohl `build()` fehlerfrei durchlief).
    _mxl_video_output: MxlVideoOutput,
    _mxl_group_outputs: Vec<MxlAudioOutput>,
}

impl ActivePipeline {
    /// Bringt die GESAMTE Pipeline explizit auf `GST_STATE_NULL`, bevor
    /// `self` fallengelassen wird — live gefunden (2026-09-02, Nutzerfund
    /// "im audiomonitor höre ich aber keinen ton", tatsächliche Ursache
    /// beim Nachschauen: 200% CPU / 2,3 GB RAM nach ~7 Minuten Laufzeit):
    /// ein bloßes `drop(active)` verlässt sich auf `gstreamer-rs`s
    /// Standard-`Drop`, der die zugrundeliegende GStreamer-Pipeline NICHT
    /// automatisch auf NULL bringt (dasselbe Prinzip, aus dem
    /// `omp-mxf-player`s `stop_element_and_wait` überhaupt existiert,
    /// dort nur pro Einzel-Element statt für die ganze eigene Pipeline
    /// nötig, weil dort nur EIN Zweig, nie die geteilte Pipeline selbst,
    /// abgebaut wird). Ohne dieses `set_state(Null)` blieb bei jedem
    /// Loop-Zyklus (s. `run()`) die komplette alte Pipeline (Demuxer-
    /// Threads, MXL-Schreib-Threads, GStreamer-Elemente) als Leiche
    /// bestehen — akkumulierte über ~42 Zyklen (~7 Minuten) zu 200% CPU
    /// und 2,3 GB RSS. Ein einziger `pipeline.set_state(Null)`-Aufruf
    /// reicht (anders als bei `omp-mxf-player`): `GstBin`s Zustands-
    /// wechsel kaskadiert automatisch auf ALLE Kind-Elemente, keine
    /// Einzel-Choreographie nötig, weil hier die GANZE Pipeline (nicht
    /// nur ein Zweig neben einem weiterlaufenden zweiten) abgebaut wird.
    ///
    /// Nur noch für ECHTEN Abbau (Neuaufbau wegen `Load`/`SetPreset`,
    /// EOS-Loop-Zyklus, Seek-Revive) — `Stop` ruft das seit Nutzerfund
    /// 2026-09-03 ("das bild im viewer bleibt unverändert" beim Seeken
    /// im Stillstand) NICHT mehr auf, s. `set_target_state`/`run()`.
    fn teardown(&self) {
        if let Err(e) = self.pipeline.set_state(gst::State::Null) {
            eprintln!("omp-mxf-player-direct: Pipeline-Teardown (set_state Null) fehlgeschlagen: {e}");
            return;
        }
        let (result, state, _pending) = self.pipeline.state(gst::ClockTime::from_seconds(3));
        if result.is_err() || state != gst::State::Null {
            eprintln!(
                "omp-mxf-player-direct: Pipeline erreichte NULL nicht innerhalb 3s beim Zyklus-Teardown (state={state:?}) — möglicher Ressourcen-Leak"
            );
        }
    }

    /// Bringt die GESAMTE, bereits existierende Pipeline auf ein neues
    /// Ziel (`Playing`/`Paused`), OHNE sie abzubauen — Nutzerfund
    /// 2026-09-03 ("wenn mxf player im stop und ich seeke, dann bleibt
    /// das bild im viewer unverändert"): `Stop` teardownte bislang die
    /// GESAMTE Pipeline (inkl. `MxlVideoOutput`/`MxlAudioOutput`, deren
    /// `Drop` den MXL-Flow faktisch zerstört, s. `teardown()`-Doku), ein
    /// Seek im Stillstand hatte also buchstäblich NICHTS mehr, worauf es
    /// wirken könnte. Jetzt bringt `Stop` die Pipeline nur auf `Paused`
    /// — das bereits zuletzt real gepullte Sample bleibt als MXL-Flow-
    /// Inhalt gültig eingefroren stehen, statt zu verschwinden (kein
    /// erneutes `Playing` nötig, solange NICHT geseekt wird). Ein `Seek`
    /// braucht dagegen zwingend einen ZWISCHENZEITLICH ECHT laufenden
    /// (`Playing`) Moment, s. `run()`-Moduldoku "Seek immer über echtes
    /// Playing": `omp-mediaio::mxl`s `write_loop` pullt Samples per
    /// `try_pull_sample()`, das das reine PAUSED-Preroll-Sample NICHT
    /// liefert (live bestätigt: `mxl-info`s Head-Index blieb nach einem
    /// Seek während `Paused` bei `0`) — ein Flushing-Seek allein während
    /// `Paused` bleibt also unsichtbar. `run()`s Aufrufer schalten daher
    /// für einen Seek IMMER kurz auf `Playing`, seeken dort, und
    /// schalten danach bei Bedarf mit dieser Funktion wieder auf
    /// `Paused` zurück.
    fn set_target_state(&self, target: gst::State, timeout_secs: u64) -> Result<(), String> {
        self.pipeline.set_state(target).map_err(|e| format!("set_state({target:?}): {e}"))?;
        let (result, state, _pending) = self.pipeline.state(gst::ClockTime::from_seconds(timeout_secs));
        if result.is_err() || state != target {
            return Err(format!("Pipeline erreichte {target:?} nicht innerhalb {timeout_secs}s (state={state:?})"));
        }
        Ok(())
    }
}

/// Baut den vollständigen, einzweigigen Graphen und fordert EINMAL
/// `Playing` für die gesamte Pipeline an — s. Moduldoku für die
/// Begründung, warum hier (anders als `omp-mxf-player`) kein
/// mehrphasiger Preroll-Tanz nötig ist. IMMER `Playing`, NIE direkt
/// `Paused` (Nutzerfund 2026-09-03, s. `run()`-Moduldoku "Seek immer
/// über echtes Playing"): `omp-mediaio::mxl`s `write_loop` liest Samples
/// per `AppSink::try_pull_sample()`, das bewusst NICHT das reine
/// Preroll-Sample einer PAUSED-Pipeline liefert (nur `try_pull_preroll()`
/// täte das, hier aber nicht verwendet) — ein direkt auf `Paused`
/// gebauter Zweig bliebe im MXL-Flow also für immer unsichtbar. Ruft ein
/// Aufrufer diese Funktion, der eigentlich einen PAUSIERTEN Ruhezustand
/// will, muss er NACH einem erfolgreichen Aufbau (und ggf. Seek)
/// zusätzlich `ActivePipeline::set_target_state(Paused, ...)` aufrufen —
/// die Pipeline hat den Sprung nach `Playing` dann bereits real
/// durchlaufen, mindestens ein reguläres (Nicht-Preroll-)Sample liegt
/// also schon beim `write_loop` an.
fn build(config: &Config, tx: UnboundedSender<Event>, events: std::sync::mpsc::Sender<LoopEvent>) -> Result<ActivePipeline, String> {
    let context = Arc::new(MxlContext::new(&config.domain)?);
    let pipeline = gst::Pipeline::new();

    // --- Datei-Decode (wortgleich aus omp-mxf-player::build_mxf_branch
    //     übernommen, s. Moduldoku) ---
    let filesrc = gst::ElementFactory::make("filesrc")
        .property("location", config.file_path.as_str())
        .build()
        .map_err(|e| format!("filesrc: {e}"))?;
    let demux = gst::ElementFactory::make("mxfdemux").build().map_err(|e| format!("mxfdemux: {e}"))?;
    pipeline
        .add(&filesrc)
        .and_then(|()| pipeline.add(&demux))
        .map_err(|e| format!("add filesrc/mxfdemux: {e}"))?;
    gst::Element::link(&filesrc, &demux).map_err(|e| format!("link filesrc to mxfdemux: {e}"))?;

    let decodebin = gst::ElementFactory::make("decodebin").build().map_err(|e| format!("decodebin: {e}"))?;
    let vconvert = gst::ElementFactory::make("videoconvert").build().map_err(|e| format!("videoconvert: {e}"))?;
    let vscale = gst::ElementFactory::make("videoscale").build().map_err(|e| format!("videoscale: {e}"))?;
    let vrate = gst::ElementFactory::make("videorate").build().map_err(|e| format!("videorate: {e}"))?;
    let vcaps = gst::ElementFactory::make("capsfilter")
        .property("caps", video_caps(config.width, config.height))
        .build()
        .map_err(|e| format!("capsfilter(video): {e}"))?;
    let vqueue = gst::ElementFactory::make("queue").build().map_err(|e| format!("queue(video): {e}"))?;
    pipeline
        .add(&decodebin)
        .and_then(|()| pipeline.add(&vconvert))
        .and_then(|()| pipeline.add(&vscale))
        .and_then(|()| pipeline.add(&vrate))
        .and_then(|()| pipeline.add(&vcaps))
        .and_then(|()| pipeline.add(&vqueue))
        .map_err(|e| format!("add video chain: {e}"))?;
    gst::Element::link_many([&vconvert, &vscale, &vrate, &vcaps, &vqueue]).map_err(|e| format!("link video chain: {e}"))?;

    // Zählt jeden Video-Buffer, der `vqueue`s Src-Pad passiert — ground
    // truth für "MxlVideoOutput bekommt gerade wirklich ein frisches
    // Bild geliefert", s. `ActivePipeline::frame_count`-Doku.
    let frame_count = Arc::new(AtomicU64::new(0));
    let frame_count_probe = frame_count.clone();
    let vqueue_src = vqueue.static_pad("src").ok_or("queue(video): no src pad")?;
    vqueue_src.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        frame_count_probe.fetch_add(1, Ordering::Relaxed);
        gst::PadProbeReturn::Ok
    });

    let decodebin_sink = vconvert.static_pad("sink").ok_or("videoconvert: no sink pad")?;
    decodebin.connect_pad_added(move |_db, new_pad| {
        let Some(caps) = new_pad.current_caps() else { return };
        let Some(structure) = caps.structure(0) else { return };
        if structure.name().starts_with("video/") && !decodebin_sink.is_linked() {
            if let Err(e) = new_pad.link(&decodebin_sink) {
                eprintln!("omp-mxf-player-direct: decodebin pad-added link failed: {e:?}");
            }
        }
    });

    let interleave = gst::ElementFactory::make("interleave").build().map_err(|e| format!("interleave: {e}"))?;
    let aconvert = gst::ElementFactory::make("audioconvert").build().map_err(|e| format!("audioconvert(bridge): {e}"))?;
    let atee = gst::ElementFactory::make("tee").build().map_err(|e| format!("tee(audio): {e}"))?;
    pipeline
        .add(&interleave)
        .and_then(|()| pipeline.add(&aconvert))
        .and_then(|()| pipeline.add(&atee))
        .map_err(|e| format!("add audio backbone: {e}"))?;
    gst::Element::link_many([&interleave, &aconvert, &atee]).map_err(|e| format!("link audio backbone: {e}"))?;

    let mut group_tails = Vec::with_capacity(config.groups.len());
    let mut matrix_elements = Vec::with_capacity(config.groups.len());
    for group in &config.groups {
        let queue = gst::ElementFactory::make("queue").build().map_err(|e| format!("queue({}): {e}", group.id))?;
        let matrix = gst::ElementFactory::make("audiomixmatrix")
            .build()
            .map_err(|e| format!("audiomixmatrix({}): {e}", group.id))?;
        // Reihenfolge kritisch (s. omp-mxf-player-Vorbild): erst bauen,
        // dann sequenziell setzen, sonst validiert audiomixmatrix die
        // Matrixform gegen die (0/0)-Default-Werte.
        matrix.set_property("out-channels", group.channels);
        matrix.set_property("in-channels", 1u32);
        matrix.set_property("matrix", matrix_to_gst_array(&vec![vec![0.0f64; 1]; group.channels as usize]));
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", group_audio_caps(group.channels))
            .build()
            .map_err(|e| format!("capsfilter({}): {e}", group.id))?;
        pipeline
            .add(&queue)
            .and_then(|()| pipeline.add(&matrix))
            .and_then(|()| pipeline.add(&caps))
            .map_err(|e| format!("add group chain ({}): {e}", group.id))?;
        gst::Element::link_many([&atee, &queue, &matrix, &caps]).map_err(|e| format!("link group chain ({}): {e}", group.id))?;
        group_tails.push(caps.clone());
        matrix_elements.push((group.id.clone(), group.channels, matrix));
    }

    let pending = Arc::new(Mutex::new(PendingAudio { pads: Vec::new() }));
    let pending_pad_added = pending.clone();
    demux.connect_pad_added(move |_demux, new_pad| {
        let Some(caps) = new_pad.current_caps() else { return };
        let Some(structure) = caps.structure(0) else { return };
        if !structure.name().starts_with("audio/") {
            return;
        }
        let pad_name = new_pad.name();
        let track_num: u32 = pad_name.rsplit('_').next().and_then(|s| s.parse().ok()).unwrap_or(0);
        pending_pad_added.lock().expect("lock poisoned").pads.push((track_num, new_pad.clone()));
    });

    let decodebin_sink_target = decodebin.static_pad("sink").ok_or("decodebin: no sink pad")?;
    demux.connect_pad_added(move |_demux, new_pad| {
        let Some(caps) = new_pad.current_caps() else { return };
        let Some(structure) = caps.structure(0) else { return };
        if structure.name().starts_with("video/") && !decodebin_sink_target.is_linked() {
            if let Err(e) = new_pad.link(&decodebin_sink_target) {
                eprintln!("omp-mxf-player-direct: mxfdemux video pad link failed: {e:?}");
            }
        }
    });

    // `no-more-pads`: per-Tonspur-Queues anlegen und ans `interleave`
    // hängen (Thread-Entkopplung, s. omp-mxf-player-Moduldoku) — HIER,
    // anders als dort, per `sync_state_with_parent()` statt
    // `set_state(Paused)`: die Pipeline hat zu diesem Zeitpunkt bereits
    // ein `Playing`-Ziel (der Sammel-Aufruf unten läuft noch), das
    // GStreamer-Standardmuster für dynamische Demuxer-Pads gilt
    // unverändert (s. Moduldoku).
    let preset_owned = config.preset.clone();
    // SCHWACHE Referenz statt `pipeline.clone()` (Nutzerfund 2026-09-02:
    // "im audiomonitor höre ich aber keinen ton" — tatsächliche Ursache:
    // 180% CPU/stetig wachsendes RSS, weil dieser Node im Gegensatz zu
    // `omp-mxf-player` die GANZE Pipeline pro Zyklus neu aufbaut/abbaut).
    // `pipeline.clone()` HIER wäre ein echter Referenzzirkel:
    // `pipeline` besitzt `demux` als Kind-Element, `demux`s eigener
    // `no-more-pads`-Handler (dieser Closure) hielte seinerseits einen
    // starken Klon von `pipeline` — GObject-Refcounting erkennt/löst
    // solche Zirkel nicht auf, die alte Pipeline samt allem darin bliebe
    // nach jedem Zyklus für immer unerreichbar-aber-ungeräumt im Speicher
    // (live bestätigt: RSS wuchs linear über mehrere Minuten, 41+ Threads
    // nach ~9 Zyklen). `omp-mxf-player` hat denselben Klon-Zirkel
    // (`pipeline_for_nmp`, dort harmlos, weil DESSEN eine Pipeline nie
    // zur Laufzeit neu aufgebaut wird, nur einzelne Zweige). Fix hier:
    // `downgrade()`/`upgrade()` (bereits etabliertes Muster,
    // `omp-srt-gateway/src/pipeline.rs`) — `None` bedeutet schlicht "die
    // Pipeline dieses Zyklus wurde bereits abgebaut, bevor `no-more-pads`
    // feuerte", kein Fehlerfall.
    let pipeline_weak = pipeline.downgrade();
    let (nmp_done_tx, nmp_done_rx) = std::sync::mpsc::channel::<()>();
    demux.connect_no_more_pads(move |_demux| {
        let Some(pipeline_for_nmp) = pipeline_weak.upgrade() else { return };
        let mut sorted = std::mem::take(&mut pending.lock().expect("lock poisoned").pads);
        sorted.sort_by_key(|(track, _)| *track);
        let input_channels = sorted.len() as u32;

        for (rank, (_, pad)) in sorted.iter().enumerate() {
            let Some(sink) = interleave.request_pad_simple(&format!("sink_{rank}")) else {
                eprintln!("omp-mxf-player-direct: interleave: request sink_{rank} failed");
                continue;
            };
            let queue = match gst::ElementFactory::make("queue").build() {
                Ok(q) => q,
                Err(e) => {
                    eprintln!("omp-mxf-player-direct: queue(track {rank}): {e}");
                    continue;
                }
            };
            if let Err(e) = pipeline_for_nmp.add(&queue) {
                eprintln!("omp-mxf-player-direct: add queue(track {rank}) failed: {e:?}");
                continue;
            }
            if let Err(e) = queue.sync_state_with_parent() {
                eprintln!("omp-mxf-player-direct: sync queue(track {rank}) failed: {e:?}");
                continue;
            }
            let Some(queue_sink) = queue.static_pad("sink") else { continue };
            let Some(queue_src) = queue.static_pad("src") else { continue };
            if let Err(e) = pad.link(&queue_sink) {
                eprintln!("omp-mxf-player-direct: link mxfdemux track {rank} to queue failed: {e:?}");
                continue;
            }
            if let Err(e) = queue_src.link(&sink) {
                eprintln!("omp-mxf-player-direct: link queue to interleave (track {rank}) failed: {e:?}");
                continue;
            }
        }

        for (group_id, group_channels, matrix_el) in &matrix_elements {
            let coeffs = presets::matrix_for(&preset_owned, group_id, *group_channels, input_channels.max(1));
            matrix_el.set_property("in-channels", input_channels.max(1));
            matrix_el.set_property("out-channels", *group_channels);
            matrix_el.set_property("matrix", matrix_to_gst_array(&coeffs));
        }
        let _ = nmp_done_tx.send(());
    });

    // --- MXL-Ausgänge DIREKT ab den Zweig-Enden (kein input-selector,
    //     s. Moduldoku) ---
    let mxl_video_output = MxlVideoOutput::new_paced(
        &pipeline,
        &vqueue,
        context.clone(),
        &config.video_flow_id,
        &config.label,
        config.width,
        config.height,
        FRAMERATE_NUMERATOR,
        FRAMERATE_DENOMINATOR,
        Arc::new(AtomicU64::new(0)),
    )
    .map_err(|e| format!("MxlVideoOutput: {e}"))?;
    mxl_video_output.set_active(true);
    let video_flowed = mxl_video_output.flowed_handle();

    let mut group_flowed = Vec::with_capacity(config.groups.len());
    let mut mxl_group_outputs = Vec::with_capacity(config.groups.len());
    for (i, group) in config.groups.iter().enumerate() {
        let flow_id = &config.group_flow_ids[i];
        let output = MxlAudioOutput::new_paced(
            &pipeline,
            &group_tails[i],
            context.clone(),
            flow_id,
            &format!("{} {}", config.label, group.label),
            SAMPLE_RATE,
            group.channels,
        )
        .map_err(|e| format!("MxlAudioOutput({}): {e}", group.id))?;
        output.set_active(true);
        group_flowed.push(output.flowed_handle());
        mxl_group_outputs.push(output);
    }

    // Ein einziger Sammel-Übergang für ALLES (Datei-Decode-Kette UND
    // MXL-Ausgänge, s. Moduldoku) — `mxfdemux`s `no-more-pads` fließt
    // während dieses (Async-)Übergangs mit ein, exakt wie im
    // GStreamer-eigenen Dynamic-Pads-Muster vorgesehen.
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("set state playing: {e}"))?;
    let (result, state, _pending) = pipeline.state(gst::ClockTime::from_seconds(8));
    if result.is_err() || state != gst::State::Playing {
        return Err(format!("pipeline erreichte Playing nicht innerhalb 8s (state={state:?})"));
    }

    // Nur zur Diagnose/Logging — kein Fehlerfall, falls `no-more-pads`
    // (Header bereits am Dateianfang) noch nicht ganz durch ist, wenn die
    // Pipeline selbst schon Playing meldet.
    if nmp_done_rx.recv_timeout(std::time::Duration::from_secs(3)).is_err() {
        eprintln!("omp-mxf-player-direct: no-more-pads nicht innerhalb 3s nach Playing beobachtet (nur Diagnose, kein Abbruch)");
    }

    // Nutzerfund 2026-09-02 ("testinstanz hat kein UI... zeigt automatic
    // multiviewer nur ein Karo/Rennflaggen-Muster"): live per CDP
    // bestätigt, dass WÄHREND echter Wiedergabe reales Bild ankommt (kein
    // Rendering-Bug) — das Karo-Muster war lediglich der Multiviewer-
    // eigene "Quelle liefert schon länger nichts mehr"-Zustand, weil
    // dieser Node bis hierhin nach einem einzelnen EOS für immer
    // stillstand (kein Loop, keine Playlist-Bedienung, um erneut
    // abzuspielen). Fix: EOS baut den Zweig automatisch neu auf (Loop),
    // `run()` unten fängt das über `cycle_done` ab — kein Alert mehr bei
    // EOS (das ist jetzt der erwartete, wiederkehrende Normalfall, kein
    // Fehler), nur noch echte Bus-Errors gehen weiterhin als
    // `Event::Error`/Alert raus.
    let bus = pipeline.bus().expect("pipeline has no bus");
    let tx_for_bus = tx.clone();
    std::thread::spawn(move || {
        for msg in bus.iter_timed(gst::ClockTime::NONE) {
            use gst::MessageView;
            match msg.view() {
                MessageView::Error(err) => {
                    let _ = tx_for_bus.send(Event::Error(format!("{} ({:?})", err.error(), err.debug())));
                    let _ = events.send(LoopEvent::CycleDone);
                    return;
                }
                MessageView::Eos(_) => {
                    let _ = events.send(LoopEvent::CycleDone);
                    return;
                }
                _ => {}
            }
        }
    });

    Ok(ActivePipeline {
        pipeline,
        demux,
        frame_count,
        video_flowed,
        group_flowed,
        _mxl_video_output: mxl_video_output,
        _mxl_group_outputs: mxl_group_outputs,
    })
}

fn query_position_ms(demux: &gst::Element) -> Option<i64> {
    demux.query_position::<gst::ClockTime>().map(|t| t.mseconds() as i64)
}

fn query_duration_ms(demux: &gst::Element) -> Option<i64> {
    demux.query_duration::<gst::ClockTime>().map(|t| t.mseconds() as i64)
}

/// EIN flushender, framegenauer Seek — anders als `omp-mxf-player::
/// seek_to` OHNE den dortigen manuellen PAUSED→PLAYING-Zyklus danach
/// (Nutzerfund 2026-09-03: "seeking not working"). Grund für den
/// Unterschied: dort ist `demux` ein Kind-Element eines per
/// `set_locked_state(true)` bewusst vom GstBin-Zustandsmanagement
/// ABGEKOPPELTEN A/B-Slot-Zweigs — der manuelle Zyklus ist DORT der
/// einzige Weg, diesen einen Zweig gezielt neu zu takten, während der
/// Rest der geteilten Pipeline weiterläuft. Hier gibt es keine Slots und
/// kein `set_locked_state`: `demux` ist ein GANZ NORMALES Kind-Element
/// der einzigen, komplett PLAYING laufenden Pipeline. Ein direkter
/// `set_state()`-Aufruf auf ein ungesperrtes Kind-Element, während der
/// umgebende `GstBin` selbst auf PLAYING steht, gerät mit dessen eigener
/// Zustands-Verwaltung in Konflikt (live bestätigt: genau dieser Zyklus
/// führte zu den gemeldeten hängenden/eingefrorenen Seeks) — der
/// einfache, flushende `seek()`-Aufruf allein ist hier das GStreamer-
/// Standardmuster für einen Seek auf eine bereits laufende Pipeline und
/// reicht aus, SOLANGE `mxfdemux`s Pull-Task noch lebt. Der verbleibende
/// Nachtrag-159-Sonderfall (Task nach echtem EOS bereits gestorben) wird
/// weiterhin über `perform_seek`s Stillstands-Erkennung + kompletten
/// Zweig-Neuaufbau in `run()` abgefangen, s. dort.
fn seek_to(demux: &gst::Element, target_ms: u64) {
    let _ = demux.seek(
        1.0,
        gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
        gst::SeekType::Set,
        gst::ClockTime::from_mseconds(target_ms),
        gst::SeekType::None,
        gst::ClockTime::NONE,
    );
}

/// Erkennung, ob der Seek tatsächlich ein frisches Bild geliefert hat —
/// wartet auf `frame_count` (Pad-Probe auf `vqueue`s Src-Pad, s.
/// `ActivePipeline::frame_count`-Doku), NICHT mehr auf eine feste
/// Wartezeit + reinen Positions-Vergleich (Nachtrag 159/175-Historie:
/// eine feste Wartezeit — erst 250ms wie `omp-mxf-player` übernommen,
/// dann testweise 600ms — blieb unter Stresstest weiterhin gelegentlich
/// (ca. 1 von 12 Versuchen) zu kurz: ein flushender Seek zwingt
/// `mxfdemux` zu Neu-Einlesen ab dem nächsten Keyframe VOR dem Ziel plus
/// Neu-Dekodierung bis dort — eine variable, gelegentlich lange Latenz,
/// die keine feste Zahl zuverlässig abdeckt). Kehrt zurück, sobald
/// TATSÄCHLICH ein neuer Video-Buffer angekommen ist (meist binnen
/// weniger zehn Millisekunden, oft schneller als jede feste Wartezeit),
/// mit 2s als Sicherheitsnetz. Bleibt der Zähler bis dahin unverändert,
/// entscheidet — wie zuvor — der Positions-Vergleich: `false` bedeutet
/// "Task tot, `mxfdemux`-Pull-Task reagiert nicht mehr" (der Aufrufer in
/// `run()` baut den kompletten Zweig neu auf, s. dort); bewegte sich die
/// Position dagegen (oder war gar kein Seek nötig, weil Position ==
/// Ziel), gilt der Seek trotzdem als erfolgreich.
///
/// Zusätzliche feste Nachlaufzeit NACH dem Zähler-Treffer (Live-Fund,
/// Stresstest direkt bei der Entwicklung dieser Funktion: der reine
/// Zähler-Trigger allein reichte noch NICHT — `frame_count` sitzt auf
/// `vqueue`s Src-Pad, VOR `MxlVideoOutput`s eigener, hier nicht
/// einsehbarer interner Kette [`videoconvert`/`videoscale`/`videorate`/
/// `appsink`], die selbst nochmal etwas Zeit braucht, bis
/// `write_loop`s `try_pull_sample()` das Bild tatsächlich abholt.
/// Anders als die Demux-Neu-Dekodierung oben ist DIESE Reststrecke aber
/// kurz und deutlich weniger variabel — reine Formatkonvertierung, kein
/// Codec-Decode — 150ms erwiesen sich im Stresstest als ausreichend
/// zuverlässig.
fn perform_seek(demux: &gst::Element, frame_count: &AtomicU64, target_ms: u64) -> bool {
    let before_pos = query_position_ms(demux);
    let before_count = frame_count.load(Ordering::Relaxed);
    seek_to(demux, target_ms);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if frame_count.load(Ordering::Relaxed) != before_count {
            std::thread::sleep(std::time::Duration::from_millis(150));
            return true;
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    let after_pos = query_position_ms(demux);
    let seek_was_needed = before_pos != Some(target_ms as i64);
    let stuck = seek_was_needed && before_pos.is_some() && after_pos == before_pos;
    !stuck
}

/// Läuft in einer Endlosschleife: baut den Zweig, spielt ihn bis zu einem
/// echten EOS (oder Bus-Error) durch, baut ihn dann KOMPLETT neu
/// (dieselbe `Config`, also dieselben MXL-`flow_id`s — Multiviewer/Viewer
/// sehen denselben Flow einfach kontinuierlich weiterlaufen statt eines
/// neuen) — s. Moduldoku-Ergänzung zum Nutzerfund 2026-09-02 ("Karo/
/// Rennflaggen-Muster" = Multiviewers Anzeige für eine seit einer Weile
/// stillstehende Quelle, kein Rendering-Bug). Kein `seek(0)` auf den
/// bestehenden `mxfdemux` nach EOS (dokumentiert unzuverlässig,
/// `omp-mxf-player/src/pipeline.rs` Nachtrag 158/159: `mxfdemux`s
/// eigener Pull-Task startet nach echtem Dateiende nicht zuverlässig neu)
/// — kompletter Neuaufbau ist derselbe, bereits als fehlerfrei bestätigte
/// Weg wie der allererste Aufbau, kein zweiter, unabhängig zu
/// verifizierender Codepfad.
// Tick für Position/Dauer-Polling (`query_position_ms`/`query_duration_ms`)
// zwischen zwei Kommandos/Zyklusenden — identisches Intervall wie
// `omp-mxf-player::run()`s Heartbeat-Tick (dort 200ms, s. dortige Doku:
// spürbar reaktionsschnell, ohne den Bus-Thread/`recv_timeout` unnötig zu
// belasten).
const TICK: std::time::Duration = std::time::Duration::from_millis(200);

/// Läuft in einer Endlosschleife, kommandogesteuert (Nutzerauftrag
/// 2026-09-03: "mxf player... braucht noch ein ui zum laden des clips,
/// seeking, play, stop... und audioshuffle selection") statt rein
/// automatisch: hält EINEN optionalen `active: Option<ActivePipeline>`
/// und reagiert auf externe `Play`/`Stop`/`Load`/`SetPreset`/`Seek`-
/// Kommandos sowie auf das interne "Zyklus zu Ende"-Signal
/// (`LoopEvent::CycleDone`, per Bus-Thread aus `build()` bei echtem
/// EOS/Error) — ALLE über denselben Kanal, ein einziger
/// `recv_timeout(TICK)` bedient Kommandos, Zyklusende UND das
/// periodische Positions-/Dauer-Polling gleichermaßen (s.
/// `LoopEvent`-Doku oben). Dieselbe MXL-`flow_id` bleibt über JEDEN
/// Übergang hinweg gleich (Video/Audio-Ausgänge sind fix ab `main.rs`s
/// Sender-Registrierung).
///
/// **KEIN Autoplay mehr beim Prozessstart** (Nutzerfund 2026-09-03: "the
/// player should not load/play an video on creation") — `active` startet
/// `None`, `shared.playing` startet `false`: kein Pipeline-Aufbau, kein
/// MXL-Flow, bis das ERSTE `play`/`load`/`seek`-Kommando eintrifft. Die
/// `PipelineHandle` wird deshalb SOFORT nach dem Anlegen von Kanal/
/// `SharedState` an `ready` gesendet, NICHT erst nach dem ersten
/// erfolgreichen `build()` — sonst würde `main.rs`s `ready_rx.await` für
/// immer blockieren, solange niemand etwas tut, und der Node könnte sich
/// nie als NMOS-Node registrieren.
///
/// **`Stop` pausiert, baut NICHT mehr ab** (Nutzerfund 2026-09-03:
/// "wenn mxf player im stop und ich seeke, dann bleibt das bild im
/// viewer unverändert, nicht also das geseekte frame") — vorher (erste
/// Fassung des Steuer-UIs) riss `Stop` die GESAMTE Pipeline samt
/// `MxlVideoOutput`/`MxlAudioOutput` ab (`teardown()`, deren `Drop`
/// zerstört faktisch den MXL-Flow, s. dortige Doku), ein Seek im
/// Stillstand hatte also buchstäblich nichts Sichtbares mehr, worauf es
/// wirken könnte. Jetzt bringt `Stop` eine bestehende Pipeline nur auf
/// `Paused` (`ActivePipeline::set_target_state`) — der zuletzt real
/// gepullte MXL-Grain bleibt als gültiger, nur eingefrorener Datenstand
/// stehen, statt zu verschwinden.
///
/// **Seek immer über echtes `Playing`** (zweiter, tieferer Root-Cause
/// zum selben Nutzerfund, per `mxl-info` live bestätigt: ein Seek
/// während `Paused` allein änderte GAR NICHTS am MXL-Flow, Head-Index
/// blieb bei `0`): `omp-mediaio::mxl`s `write_loop` pullt Samples per
/// `AppSink::try_pull_sample()`, das bewusst NICHT das reine
/// PAUSED-Preroll-Sample liefert (nur `try_pull_preroll()` täte das,
/// hier aber nicht verwendet, s. `build()`-Doku) — ein Flushing-Seek
/// während `Paused` bleibt also für den MXL-Flow unsichtbar, komplett
/// unabhängig vom "kein Autoplay"-Thema. Fix: `build()` baut IMMER (wie
/// schon vor diesem Nutzerauftrag) bis `Playing` durch — jeder Seek
/// passiert IMMER an einer echt laufenden Pipeline (ein zuvor
/// pausierter Zweig wird dafür kurz auf `Playing` geschaltet), NUR wenn
/// der gewünschte Ruhezustand `Stop`/nie-gespielt ist, folgt danach ein
/// `set_target_state(Paused, ...)` — die Pipeline hat den Sprung nach
/// `Playing` dann bereits real durchlaufen, mindestens ein reguläres
/// Sample liegt also schon vor, wenn sie wieder pausiert.
///
/// `Play` bringt eine bestehende, pausierte Pipeline einfach auf
/// `Playing` (setzt an genau der Stelle fort, an der pausiert/geseekt
/// wurde) — nur wenn NOCH GAR KEINE Pipeline existiert, wird sie frisch
/// gebaut. `Load`/`SetPreset` bauen wie zuvor komplett neu (neue Datei
/// bzw. neue Routing-Matrix), NICHT bloß pausiert/fortgesetzt.
pub fn run(
    config: Config,
    tx: UnboundedSender<Event>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
) {
    if let Err(e) = gst::init() {
        let msg = format!("gst init failed: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }

    let mut cfg = config;
    let (event_tx, event_rx) = std::sync::mpsc::channel::<LoopEvent>();
    let shared = Arc::new(Mutex::new(SharedState {
        file_path: cfg.file_path.clone(),
        preset_id: cfg.preset.id.clone(),
        playing: false,
        video_flowed: Arc::new(AtomicBool::new(false)),
        group_flowed: Vec::new(),
    }));
    let position_ms = Arc::new(AtomicI64::new(0));
    let duration_ms = Arc::new(AtomicI64::new(0));

    // PipelineHandle sofort verfügbar machen, NICHT erst nach dem ersten
    // erfolgreichen Pipeline-Aufbau (s. Moduldoku "KEIN Autoplay mehr").
    let _ = ready.send(Ok(PipelineHandle {
        events: event_tx.clone(),
        shared: shared.clone(),
        position_ms: position_ms.clone(),
        duration_ms: duration_ms.clone(),
    }));

    let mut active: Option<ActivePipeline> = None;

    loop {
        match event_rx.recv_timeout(TICK) {
            Ok(LoopEvent::CycleDone) => {
                if let Some(a) = active.take() {
                    a.teardown();
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
                // Nur neu aufbauen, wenn der Bedienende nicht GENAU in
                // diesem Moment gestoppt hat (seltene, harmlose Race —
                // echtes EOS kommt ohnehin nur aus einer zuvor PLAYING
                // gelaufenen Pipeline).
                if shared.lock().expect("lock poisoned").playing {
                    match build(&cfg, tx.clone(), event_tx.clone()) {
                        Ok(p) => {
                            let mut s = shared.lock().expect("lock poisoned");
                            s.video_flowed = p.video_flowed.clone();
                            s.group_flowed = p.group_flowed.clone();
                            drop(s);
                            active = Some(p);
                        }
                        Err(e) => {
                            let _ = tx.send(Event::Error(format!("build failed: {e}")));
                        }
                    }
                }
            }
            Ok(LoopEvent::Cmd(Command::Play)) => match &active {
                Some(a) => {
                    if let Err(e) = a.set_target_state(gst::State::Playing, 8) {
                        let _ = tx.send(Event::Error(format!("play fehlgeschlagen: {e}")));
                    } else {
                        shared.lock().expect("lock poisoned").playing = true;
                    }
                }
                None => match build(&cfg, tx.clone(), event_tx.clone()) {
                    Ok(p) => {
                        let mut s = shared.lock().expect("lock poisoned");
                        s.video_flowed = p.video_flowed.clone();
                        s.group_flowed = p.group_flowed.clone();
                        s.playing = true;
                        drop(s);
                        active = Some(p);
                    }
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("build failed: {e}")));
                    }
                },
            },
            Ok(LoopEvent::Cmd(Command::Stop)) => {
                // S. Moduldoku "Stop pausiert, baut NICHT mehr ab" — kein
                // Seek beteiligt, das zuletzt real gepullte Sample bleibt
                // gültig, `Paused` reicht hier direkt (kein Umweg über
                // `Playing` nötig, anders als bei `Seek`, s. dort).
                if let Some(a) = &active {
                    if let Err(e) = a.set_target_state(gst::State::Paused, 8) {
                        let _ = tx.send(Event::Error(format!("stop (paused) fehlgeschlagen: {e}")));
                    }
                }
                shared.lock().expect("lock poisoned").playing = false;
            }
            Ok(LoopEvent::Cmd(Command::Load(file))) => {
                cfg.file_path = file.clone();
                if let Some(a) = active.take() {
                    a.teardown();
                }
                match build(&cfg, tx.clone(), event_tx.clone()) {
                    Ok(p) => {
                        let mut s = shared.lock().expect("lock poisoned");
                        s.file_path = file;
                        s.playing = true; // "Laden" heißt hier direkt "zeigen", s. PipelineHandle::load-Doku.
                        s.video_flowed = p.video_flowed.clone();
                        s.group_flowed = p.group_flowed.clone();
                        drop(s);
                        active = Some(p);
                    }
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("build failed: {e}")));
                        let mut s = shared.lock().expect("lock poisoned");
                        s.file_path = file;
                        s.playing = false;
                    }
                }
            }
            Ok(LoopEvent::Cmd(Command::SetPreset(preset))) => {
                shared.lock().expect("lock poisoned").preset_id = preset.id.clone();
                cfg.preset = preset;
                if let Some(a) = active.take() {
                    // Zielzustand nach dem Neuaufbau beibehalten (spielte
                    // es vorher, soll es danach weiterspielen — war es
                    // pausiert, bleibt es pausiert). `build()` geht IMMER
                    // erst über `Playing` (s. dortige Doku), ein
                    // gewünschter `Paused`-Ruhezustand wird DANACH separat
                    // angefordert — nicht andersherum, s. Moduldoku "Seek
                    // immer über echtes Playing" (hier zwar kein Seek,
                    // aber dieselbe `try_pull_sample()`-Einschränkung
                    // würde sonst auch nach einem Preset-Wechsel im
                    // Stillstand ein sichtbares Bild verhindern).
                    let was_playing = shared.lock().expect("lock poisoned").playing;
                    a.teardown();
                    match build(&cfg, tx.clone(), event_tx.clone()) {
                        Ok(p) => {
                            if !was_playing {
                                if let Err(e) = p.set_target_state(gst::State::Paused, 8) {
                                    let _ = tx.send(Event::Error(format!("Pausieren nach Preset-Wechsel fehlgeschlagen: {e}")));
                                }
                            }
                            let mut s = shared.lock().expect("lock poisoned");
                            s.video_flowed = p.video_flowed.clone();
                            s.group_flowed = p.group_flowed.clone();
                            drop(s);
                            active = Some(p);
                        }
                        Err(e) => {
                            let _ = tx.send(Event::Error(format!("build failed: {e}")));
                        }
                    }
                }
                // War `active` bereits `None` (noch nie gebaut): nur
                // `cfg` aktualisiert, wirkt erst beim nächsten Aufbau.
            }
            Ok(LoopEvent::Cmd(Command::Seek(target_ms))) => {
                // S. Moduldoku "Seek immer über echtes Playing": ein
                // Flushing-Seek während `Paused` bleibt im MXL-Flow
                // unsichtbar (`try_pull_sample()` liefert kein reines
                // Preroll-Sample) — JEDER Seek passiert deshalb an einer
                // echt `Playing` laufenden Pipeline, ein gewünschter
                // `Stop`-Ruhezustand wird ERST danach wiederhergestellt.
                let was_playing = shared.lock().expect("lock poisoned").playing;
                if let Some(a) = active.as_ref() {
                    if !was_playing {
                        if let Err(e) = a.set_target_state(gst::State::Playing, 8) {
                            let _ = tx.send(Event::Error(format!("Playing vor Seek fehlgeschlagen: {e}")));
                        }
                    }
                    let ok = perform_seek(&a.demux, &a.frame_count, target_ms);
                    if !ok {
                        eprintln!(
                            "omp-mxf-player-direct: Seek (Ziel {target_ms}ms) wirkungslos — mxfdemux-Task vermutlich nach EOS gestoppt, baue Zweig neu auf (s. omp-mxf-player Nachtrag 159)"
                        );
                        let old = active.take().expect("oben als Some geprüft");
                        old.teardown();
                        match build(&cfg, tx.clone(), event_tx.clone()) {
                            Ok(p) => {
                                perform_seek(&p.demux, &p.frame_count, target_ms);
                                if !was_playing {
                                    if let Err(e) = p.set_target_state(gst::State::Paused, 8) {
                                        let _ = tx.send(Event::Error(format!("Pausieren nach Seek-Neuaufbau fehlgeschlagen: {e}")));
                                    }
                                }
                                let mut s = shared.lock().expect("lock poisoned");
                                s.video_flowed = p.video_flowed.clone();
                                s.group_flowed = p.group_flowed.clone();
                                drop(s);
                                active = Some(p);
                            }
                            Err(e) => {
                                let _ = tx.send(Event::Error(format!("Neuaufbau nach Seek fehlgeschlagen: {e}")));
                            }
                        }
                    } else if !was_playing {
                        if let Err(e) = a.set_target_state(gst::State::Paused, 8) {
                            let _ = tx.send(Event::Error(format!("Pausieren nach Seek fehlgeschlagen: {e}")));
                        }
                    }
                    position_ms.store(target_ms as i64, Ordering::Relaxed);
                } else {
                    // Noch nie gebaut (Nutzerfund 2026-09-03) — direkte
                    // Reaktion auf eine explizite Nutzeraktion, kein
                    // Autoplay-Widerspruch: `build()` geht IMMER erst über
                    // `Playing` durch (sonst bliebe der Seek unsichtbar,
                    // s. Moduldoku), seeken, DANACH pausieren (`shared.
                    // playing` bleibt `false` — ein bloßer Seek soll noch
                    // keine echte Dauerwiedergabe starten).
                    match build(&cfg, tx.clone(), event_tx.clone()) {
                        Ok(p) => {
                            perform_seek(&p.demux, &p.frame_count, target_ms);
                            if let Err(e) = p.set_target_state(gst::State::Paused, 8) {
                                let _ = tx.send(Event::Error(format!("Pausieren nach Erstaufbau-Seek fehlgeschlagen: {e}")));
                            }
                            let mut s = shared.lock().expect("lock poisoned");
                            s.video_flowed = p.video_flowed.clone();
                            s.group_flowed = p.group_flowed.clone();
                            drop(s);
                            active = Some(p);
                            position_ms.store(target_ms as i64, Ordering::Relaxed);
                        }
                        Err(e) => {
                            let _ = tx.send(Event::Error(format!("build failed: {e}")));
                        }
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        }

        if let Some(a) = &active {
            if let Some(pos) = query_position_ms(&a.demux) {
                position_ms.store(pos, Ordering::Relaxed);
            }
            if let Some(dur) = query_duration_ms(&a.demux) {
                duration_ms.store(dur, Ordering::Relaxed);
            }
        }
    }
}

