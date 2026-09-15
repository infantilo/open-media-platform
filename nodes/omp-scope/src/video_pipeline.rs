//! Video-Zweig von `omp-scope`: liest einen per IS-05-Receiver-PATCH
//! gewählten MXL-Video-Flow (`main.rs`s `VideoControl`, exaktes Muster
//! von `omp-viewer::pipeline`: bei jedem Quellwechsel wird die GANZE
//! Pipeline neu aufgebaut, kein dynamisches Pad-Relinking), skaliert ihn
//! über die bereits in `MxlVideoInput` eingebaute videoconvert/
//! videoscale/videorate-Kette (`.tail`) auf eine feste, günstige
//! Analyse-Auflösung herunter, berechnet daraus pro Frame das
//! kombinierte Waveform/Vektorskop-Bild (`scope_image::render`) und
//! speist es über einen `appsrc` in `omp_mediaio::preview::
//! build_mjpeg_branch` — dieselbe JPEG-über-HTTP-Infrastruktur, die
//! `omp-viewer` bereits nutzt, hier auf einem SYNTHETISCHEN statt dem
//! rohen Quellbild.
//!
//! **Warum kein zusätzlicher `videoconvert`/`videoscale`/`videorate` vor
//! der Analyse nötig ist:** `MxlVideoInput::new` baut diese drei
//! Elemente bereits intern VOR `.tail` ein (s. `omp-mediaio::mxl`s
//! Struct-Doku) — ein direkt an `.tail` gehängter `capsfilter` mit der
//! gewünschten Analyse-Größe/-Bildrate reicht, die Standard-GStreamer-
//! Caps-Verhandlung zieht die Skalierung/Ratenanpassung automatisch
//! durch die bereits vorhandene Kette durch.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gstreamer as gst;
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;
use gstreamer_video::prelude::*;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput};
use omp_mediaio::preview::{self, Broadcaster};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use crate::flowmeta::{self, VideoFlowMeta};
use crate::qc::{VideoQc, VideoQcSnapshot};
use crate::scope_image::{self, ANALYSIS_HEIGHT, OUTPUT_HEIGHT, OUTPUT_WIDTH, WAVEFORM_WIDTH};
use crate::timing::{FlowTiming, TimingSnapshot};

/// Analyse-/Ausgabe-Bildrate — ein Messgerät muss nicht sendebildrate-
/// flüssig sein (anders als `omp-viewer`s Bedienbild), 8fps ist für ein
/// Waveform/Vektorskop bereits gut lesbar und hält die Pixel-Rechnung
/// pro Sekunde klein (`UMSETZUNG.md` §0 Punkt 7: Sandbox-taugliche CPU-
/// Last, keine Sendebild-Hardware zum Testen nötig).
const ANALYSIS_FPS: i32 = 8;
const JPEG_QUALITY: i32 = 80;

pub enum Event {
    Error(String),
    /// Tatsächlich gemessene Eingangsbildrate (gleiches Muster wie
    /// `omp-source::pipeline::Event::Fps`) — EIN Zähler-Probe direkt
    /// hinter `input.tail`, VOR der Analyse-Drosselung auf
    /// `ANALYSIS_FPS`, damit hier die echte Quellrate steht, nicht die
    /// eigene Analyse-Rate.
    MeasuredFps(f64),
    /// Die tatsächliche, vom `appsrc` in `MxlVideoInput` deklarierte
    /// Quellauflösung/-Framerate (aus dessen `caps`-Property gelesen,
    /// SOFORT nach dem Connect, nicht aus dem Analyse-Appsink). Live-
    /// Fund (2026-09-14, s. `docs/decisions.md`): ein erster Entwurf las
    /// dies aus den negotiated Caps des ANALYSE-Appsinks — die zeigen
    /// aber durch Konstruktion IMMER exakt `WAVEFORM_WIDTH`×
    /// `ANALYSIS_HEIGHT`@`ANALYSIS_FPS` (die selbst erzwungenen Analyse-
    /// Ziel-Caps), unabhängig von der echten Quelle — kein Messwert,
    /// sondern ein Echo der eigenen Konfiguration. Per echtem CDP-Test
    /// entdeckt: "Auflösung" zeigte immer 320×180, obwohl die Quelle
    /// eine andere native Auflösung hatte.
    SourceFormat { width: i32, height: i32, framerate: (i32, i32) },
}

enum Command {
    Connect(String, String),
    Disconnect,
}

/// Alle laufend fortgeschriebenen Messwerte des Videozweigs, geteilt
/// zwischen GStreamer-Streaming-Thread (schreibt) und HTTP-Thread
/// (liest). Bewusst EIN Bündel statt drei einzeln durchgereichter Arcs
/// — jede neue Messgröße käme sonst als weiterer Parameter durch
/// `run`/`build` hindurch.
#[derive(Clone, Default)]
pub struct Measurements {
    timing: Arc<Mutex<FlowTiming>>,
    qc: Arc<Mutex<VideoQc>>,
    flow: Arc<Mutex<VideoFlowMeta>>,
}

impl Measurements {
    pub fn timing(&self) -> TimingSnapshot {
        self.timing.lock().expect("lock poisoned").snapshot()
    }

    pub fn qc(&self) -> VideoQcSnapshot {
        self.qc.lock().expect("lock poisoned").snapshot()
    }

    pub fn flow(&self) -> VideoFlowMeta {
        self.flow.lock().expect("lock poisoned").clone()
    }

    /// Bei jedem Quellwechsel: kompletter Neuanfang. Messwerte der
    /// VORIGEN Quelle an einer neuen weiterzuzeigen wäre eine
    /// Falschaussage (s. `FlowTiming::reset`).
    fn reset(&self) {
        self.timing.lock().expect("lock poisoned").reset();
        self.qc.lock().expect("lock poisoned").reset();
        *self.flow.lock().expect("lock poisoned") = VideoFlowMeta::default();
    }
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    flowed: Arc<AtomicBool>,
}

impl PipelineHandle {
    pub fn connect(&self, flow_id: String, label: String) {
        self.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::Connect(flow_id, label));
    }

    pub fn disconnect(&self) {
        self.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::Disconnect);
    }

    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    _input: MxlVideoInput,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn output_video_info() -> gst_video::VideoInfo {
    gst_video::VideoInfo::builder(gst_video::VideoFormat::I420, OUTPUT_WIDTH as u32, OUTPUT_HEIGHT as u32)
        .fps(gst::Fraction::new(ANALYSIS_FPS, 1))
        .build()
        .expect("static output video info is valid")
}

/// Kopiert `scope_image::Image` (dicht gepackt, `OUTPUT_WIDTH`/
/// `OUTPUT_HEIGHT`) zeilenweise in einen frisch allozierten,
/// stride-korrekten `gst::Buffer` (`gst_video::VideoFrame` respektiert
/// ein evtl. abweichendes Zeilen-Padding, ein blindes `memcpy` des
/// gesamten Puffers wäre nur bei zufällig identischem Stride korrekt).
fn build_output_buffer(info: &gst_video::VideoInfo, image: &scope_image::Image) -> Result<gst::Buffer, String> {
    let buffer = gst::Buffer::with_size(info.size()).map_err(|e| format!("buffer alloc: {e}"))?;
    let mut frame = gst_video::VideoFrame::from_buffer_writable(buffer, info)
        .map_err(|_| "VideoFrame::from_buffer_writable failed".to_string())?;

    copy_plane(&mut frame, 0, &image.y, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    copy_plane(&mut frame, 1, &image.u, OUTPUT_WIDTH / 2, OUTPUT_HEIGHT / 2);
    copy_plane(&mut frame, 2, &image.v, OUTPUT_WIDTH / 2, OUTPUT_HEIGHT / 2);

    Ok(frame.into_buffer())
}

fn copy_plane(frame: &mut gst_video::VideoFrame<gst_video::video_frame::Writable>, plane: u32, src: &[u8], width: usize, height: usize) {
    let stride = frame.plane_stride()[plane as usize] as usize;
    let data = frame.plane_data_mut(plane).expect("plane index valid for I420");
    for row in 0..height {
        let src_row = &src[row * width..(row + 1) * width];
        let dst_row = &mut data[row * stride..row * stride + width];
        dst_row.copy_from_slice(src_row);
    }
}

/// Liest eine I420-Analyse-`gst::Sample` stride-korrekt aus und
/// berechnet daraus das Ausgabebild — `None`, falls Caps/Puffer (noch)
/// nicht vorliegen (z. B. der allererste Sample vor abgeschlossener
/// Verhandlung).
fn render_from_sample(sample: &gst::Sample) -> Option<(scope_image::Image, Vec<u8>)> {
    let caps = sample.caps()?;
    let info = gst_video::VideoInfo::from_caps(caps).ok()?;
    let buffer = sample.buffer()?;
    let frame = gst_video::VideoFrameRef::from_buffer_ref_readable(buffer, &info).ok()?;

    let read_plane = |plane: usize, width: usize, height: usize| -> Vec<u8> {
        let stride = frame.plane_stride()[plane] as usize;
        let data = frame.plane_data(plane as u32).unwrap_or(&[]);
        let mut out = vec![0u8; width * height];
        for row in 0..height {
            let start = row * stride;
            if start + width > data.len() {
                break;
            }
            out[row * width..(row + 1) * width].copy_from_slice(&data[start..start + width]);
        }
        out
    };

    let y = read_plane(0, WAVEFORM_WIDTH, ANALYSIS_HEIGHT);
    let u = read_plane(1, WAVEFORM_WIDTH / 2, ANALYSIS_HEIGHT / 2);
    let v = read_plane(2, WAVEFORM_WIDTH / 2, ANALYSIS_HEIGHT / 2);

    // Das Luma-Plane wird zusätzlich zurückgegeben: die QC-Messung
    // (Schwarz-/Standbild) rechnet auf demselben bereits skalierten
    // Analysebild weiter, statt eine zweite Skalierkette zu betreiben.
    let image = scope_image::render(&y, &u, &v);
    Some((image, y))
}

fn build(
    context: &Arc<MxlContext>,
    flow_id: &str,
    broadcaster: &Arc<Broadcaster>,
    flowed: Arc<AtomicBool>,
    tx: UnboundedSender<Event>,
    measurements: &Measurements,
) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let input = MxlVideoInput::new(&pipeline, context.clone(), flow_id)?;

    // Essenz-Deklaration direkt aus der MXL-Domain (s. `flowmeta`-
    // Moduldoku: das, was der SCHREIBER behauptet — bewusst getrennt von
    // den weiter unten gemessenen Ist-Werten gehalten). Schlägt das
    // fehl, läuft alles andere weiter: ein fehlendes `flow_def` macht
    // das Messgerät nicht nutzlos.
    match context.flow_def(flow_id) {
        Ok(json) => {
            let meta = flowmeta::parse_video(&json);
            if let Some((numerator, denominator)) = meta.grain_rate
                && numerator > 0
            {
                measurements
                    .timing
                    .lock()
                    .expect("lock poisoned")
                    .set_nominal_period_ns((1_000_000_000u64 * denominator).div_ceil(numerator));
            }
            *measurements.flow.lock().expect("lock poisoned") = meta;
        }
        Err(e) => eprintln!("omp-scope: flow_def({flow_id}) unavailable: {e}"),
    }

    // Echte Quellauflösung/-framerate SOFORT nach dem Connect (nicht aus
    // dem Analyse-Appsink, s. `Event::SourceFormat`-Doku) — `input.
    // elements[0]` ist laut `MxlVideoInput`s Struct-Doku immer der
    // `appsrc`, dessen `caps`-Property `MxlVideoInput::new` bereits beim
    // Aufbau aus dem MXL-`flow_def` gesetzt hat.
    if let Some(caps) = input.elements.first().and_then(|el| el.property::<Option<gst::Caps>>("caps"))
        && let Some(s) = caps.structure(0)
    {
        let width = s.get::<i32>("width").ok();
        let height = s.get::<i32>("height").ok();
        let framerate = s.get::<gst::Fraction>("framerate").ok();
        if let (Some(width), Some(height), Some(framerate)) = (width, height, framerate) {
            let _ = tx.send(Event::SourceFormat { width, height, framerate: (framerate.numer(), framerate.denom()) });
        }
    }

    // "media-ready": Probe hinter dem gesamten MXL-Eingang (`.tail` =
    // MxlVideoInput's internes `videorate`, gleiches Prinzip wie `omp-
    // viewer::pipeline`s `flowed_probe`) — hier reicht die reine
    // Tatsache "es kommt etwas an".
    let flowed_probe = flowed.clone();
    let tail_src_pad = input.tail.static_pad("src").expect("tail has a src pad");
    tail_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
        flowed_probe.store(true, Ordering::Relaxed);
        gst::PadProbeReturn::Ok
    });

    // Gemessene EINGANGS-Bildrate (analog `omp-source::pipeline::
    // Event::Fps`): Zähler-Probe auf `input.elements[0]` (der rohen
    // `appsrc`, VOR videoconvert/videoscale/videorate) statt auf `.tail`
    // — Live-Fund (2026-09-14): ein Probe auf `.tail` zählt NACH dem
    // internen `videorate`, dessen Ausgabe durch den weiter unten per
    // Caps-Verhandlung erzwungenen `ANALYSIS_FPS` bereits gedrosselt ist.
    // Damit hätte `videoMeasuredFps` immer nur `ANALYSIS_FPS` (8.0)
    // gezeigt statt der tatsächlichen Quellrate — kein Messwert, nur ein
    // Echo der eigenen Konfiguration.
    let frame_count = Arc::new(AtomicU64::new(0));
    let frame_count_probe = frame_count.clone();
    let raw_src_pad = input.elements[0].static_pad("src").expect("input appsrc has a src pad");
    // Derselbe Probe misst zusätzlich die Transportlatenz: hier, am
    // rohen `appsrc`, tragen die Puffer noch die von `omp_mediaio::mxl`s
    // Lesepfad angehängte `timestamp/x-mxl-tai`-Meta mit dem
    // Ursprungs-Zeitstempel des Grains (s. `timing`-Moduldoku).
    // Absichtlich VOR videoconvert/videoscale/videorate — eine
    // GStreamer-Transformation ist nicht verpflichtet, fremde Metas
    // weiterzureichen, und die Analyse-Drosselung auf `ANALYSIS_FPS`
    // würde die Kadenzmessung ohnehin auf die eigene Konfiguration
    // verfälschen (derselbe Fehler, der bei `videoMeasuredFps` schon
    // einmal drohte).
    let timing_probe = measurements.timing.clone();
    let timing_context = context.clone();
    raw_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, info| {
        frame_count_probe.fetch_add(1, Ordering::Relaxed);
        if let Some(gst::PadProbeData::Buffer(buffer)) = &info.data
            && let Some(meta) = buffer.meta::<gst::ReferenceTimestampMeta>()
            && meta.reference().structure(0).is_some_and(|s| s.name() == omp_mediaio::mxl::TAI_REFERENCE_CAPS_NAME)
        {
            timing_probe
                .lock()
                .expect("lock poisoned")
                .observe(meta.timestamp().nseconds(), timing_context.now_ns());
        }
        gst::PadProbeReturn::Ok
    });
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut last = 0u64;
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let now = frame_count.load(Ordering::Relaxed);
                if now == last && now == 0 {
                    continue;
                }
                let _ = tx.send(Event::MeasuredFps((now - last) as f64));
                last = now;
                if Arc::strong_count(&frame_count) == 1 {
                    break; // Pipeline längst abgebaut, dieser Zähler ist verwaist.
                }
            }
        });
    }

    let analysis_caps = gst::ElementFactory::make("capsfilter")
        .property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("format", "I420")
                .field("width", WAVEFORM_WIDTH as i32)
                .field("height", ANALYSIS_HEIGHT as i32)
                .field("framerate", gst::Fraction::new(ANALYSIS_FPS, 1))
                .build(),
        )
        .build()
        .map_err(|e| format!("capsfilter (analysis): {e}"))?;

    let analysis_sink = gst::ElementFactory::make("appsink")
        .property("sync", false)
        // `async=false` (Live-Debugging-Fund 2026-09-14, s. `docs/
        // decisions.md`-Eintrag): OHNE das blieb die GESAMTE Pipeline
        // dauerhaft in PAUSED hängen (`pipeline.state()` zeigte
        // `(Ok(Async), Paused, Playing)` auch nach Sekunden) — zwei
        // unabhängige Live-Quellen in EINER Pipeline (`MxlVideoInput`s
        // `appsrc` UND `scope_src` unten) lassen den Preroll-Abschluss
        // des zweiten, zu diesem Zeitpunkt noch komplett ungespeisten
        // `scope_src`-Zweigs offenbar nicht zuverlässig durchlaufen,
        // solange DIESER appsink hier noch am normalen Preroll-Protokoll
        // teilnimmt. Gleiches Muster wie `omp-viewer::audio_meters::
        // build_branch`s Level-appsink (dort schon `async=false`).
        .property("async", false)
        .property("max-buffers", 2u32)
        .property("drop", true)
        .build()
        .map_err(|e| format!("appsink (analysis): {e}"))?;

    let output_info = output_video_info();
    let scope_src = gst::ElementFactory::make("appsrc")
        .property("format", gst::Format::Time)
        .property("is-live", true)
        .property("do-timestamp", true)
        .property("caps", &output_info.to_caps().map_err(|e| format!("output caps: {e}"))?)
        .property_from_str("leaky-type", "upstream")
        .property("max-buffers", 2u64)
        .build()
        .map_err(|e| format!("appsrc (scope out): {e}"))?;

    pipeline
        .add(&analysis_caps)
        .and_then(|()| pipeline.add(&analysis_sink))
        .and_then(|()| pipeline.add(&scope_src))
        .map_err(|e| format!("add scope elements: {e}"))?;
    gst::Element::link_many([&input.tail, &analysis_caps, &analysis_sink])
        .map_err(|e| format!("link analysis chain: {e}"))?;

    preview::build_mjpeg_branch(&pipeline, &scope_src, broadcaster, OUTPUT_WIDTH as u32, OUTPUT_HEIGHT as u32, ANALYSIS_FPS, JPEG_QUALITY)?;

    let app_sink: gst_app::AppSink = analysis_sink.dynamic_cast().map_err(|_| "appsink: cast to AppSink failed".to_string())?;
    let app_src: gst_app::AppSrc = scope_src.dynamic_cast().map_err(|_| "appsrc: cast to AppSrc failed".to_string())?;
    let qc = measurements.qc.clone();
    let qc_context = context.clone();
    app_sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                if let Some((image, luma)) = render_from_sample(&sample) {
                    qc.lock().expect("lock poisoned").observe(&luma, qc_context.now_ns());
                    if let Ok(out_buffer) = build_output_buffer(&output_info, &image) {
                        let _ = app_src.push_buffer(out_buffer);
                    }
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    pipeline.set_state(gst::State::Playing).map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActivePipeline { pipeline, _input: input })
}

#[allow(clippy::too_many_arguments)]
pub fn run(
    context: Arc<MxlContext>,
    broadcaster: Arc<Broadcaster>,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
    heartbeat: Arc<AtomicU64>,
    measurements: Measurements,
) {
    if let Err(e) = gst::init() {
        let msg = format!("gst init failed: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let flowed = Arc::new(AtomicBool::new(false));
    let _ = ready.send(Ok(PipelineHandle { commands: commands_tx, flowed: flowed.clone() }));

    let mut active: Option<ActivePipeline> = None;
    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::Connect(flow_id, _label)) => {
                active = None;
                measurements.reset();
                match build(&context, &flow_id, &broadcaster, flowed.clone(), tx.clone(), &measurements) {
                    Ok(p) => active = Some(p),
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("connect {flow_id} failed: {e}")));
                    }
                }
            }
            Ok(Command::Disconnect) => {
                active = None;
                measurements.reset();
                broadcaster.reset();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }

        // Live-Debugging-Fund (2026-09-14): ohne diesen Bus-Watcher blieb
        // ein "not-negotiated"-Fehler (falsche Caps-Feldtypen im
        // Analyse-`capsfilter`) komplett unsichtbar — `set_state(Playing)`
        // meldet nur den ASYNC-Übergang, nicht das spätere tatsächliche
        // Scheitern, und ohne Bus-Abfrage verschwindet die Fehlermeldung
        // lautlos. Gleiches Muster wie `omp-viewer::audio_meters::run`s
        // DEBUG-Bus-Polling.
        if let Some(active) = active.as_ref() {
            let bus = active.pipeline.bus().expect("pipeline has a bus");
            while let Some(msg) = bus.pop_filtered(&[gst::MessageType::Error, gst::MessageType::Warning]) {
                match msg.view() {
                    gst::MessageView::Error(e) => {
                        let _ = tx.send(Event::Error(format!(
                            "pipeline error from {}: {} ({:?})",
                            msg.src().map(|o| o.name().to_string()).unwrap_or_default(),
                            e.error(),
                            e.debug()
                        )));
                    }
                    gst::MessageView::Warning(w) => {
                        eprintln!(
                            "omp-scope: video pipeline warning from {}: {} ({:?})",
                            msg.src().map(|o| o.name().to_string()).unwrap_or_default(),
                            w.error(),
                            w.debug()
                        );
                    }
                    _ => {}
                }
            }
        }
    }

    drop(active);
}
