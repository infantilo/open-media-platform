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
//! aus `OMP_MXF_FILE` (absoluter Pfad oder relativ zu `OMP_MEDIA_DIR`),
//! Wiedergabe startet automatisch beim Prozessstart. Alle Element-
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

#[derive(Clone)]
pub struct PipelineHandle {
    video_flowed: Arc<AtomicBool>,
    group_flowed: Vec<Arc<AtomicBool>>,
}

impl PipelineHandle {
    /// "media-ready" (ARCHITECTURE.md §5 Punkt 6): Video- UND alle
    /// Gruppen-Ausgänge müssen jeweils mindestens einmal geflossen sein
    /// — identisches Prinzip wie `omp-mxf-player::PipelineHandle::
    /// media_ready`.
    pub fn media_ready(&self) -> bool {
        self.video_flowed.load(Ordering::Relaxed) && self.group_flowed.iter().all(|f| f.load(Ordering::Relaxed))
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
    _pipeline: gst::Pipeline,
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

/// Baut den vollständigen, einzweigigen Graphen und fordert EINMAL
/// `Playing` für die gesamte Pipeline an — s. Moduldoku für die
/// Begründung, warum hier (anders als `omp-mxf-player`) kein
/// mehrphasiger Preroll-Tanz nötig ist.
fn build(config: &Config, tx: UnboundedSender<Event>) -> Result<ActivePipeline, String> {
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
    let pipeline_for_nmp = pipeline.clone();
    let (nmp_done_tx, nmp_done_rx) = std::sync::mpsc::channel::<()>();
    demux.connect_no_more_pads(move |_demux| {
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

    let bus = pipeline.bus().expect("pipeline has no bus");
    let tx_for_bus = tx.clone();
    std::thread::spawn(move || {
        for msg in bus.iter_timed(gst::ClockTime::NONE) {
            use gst::MessageView;
            match msg.view() {
                MessageView::Error(err) => {
                    let _ = tx_for_bus.send(Event::Error(format!(
                        "{} ({:?})",
                        err.error(),
                        err.debug()
                    )));
                }
                MessageView::Eos(_) => {
                    let _ = tx_for_bus.send(Event::Error("Datei-Ende erreicht (EOS) — kein Loop in diesem Diagnose-Node".to_string()));
                }
                _ => {}
            }
        }
    });

    Ok(ActivePipeline {
        _pipeline: pipeline,
        video_flowed,
        group_flowed,
        _mxl_video_output: mxl_video_output,
        _mxl_group_outputs: mxl_group_outputs,
    })
}

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

    let active = match build(&config, tx.clone()) {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("build failed: {e}")));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let _ = ready.send(Ok(PipelineHandle {
        video_flowed: active.video_flowed.clone(),
        group_flowed: active.group_flowed.clone(),
    }));

    // Hält die Pipeline (und damit `active`, dessen Drop sie abbaut)
    // für die Lebensdauer des Prozesses am Leben — Teardown erfolgt wie
    // bei jedem anderen Node über SIGTERM→Prozessende, kein eigener
    // Teardown-Code nötig (kein zweiter Zweig, kein Wiederverwenden).
    loop {
        std::thread::park();
    }
}

