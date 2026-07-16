//! GStreamer-Pipeline von `omp-ograf` (K5-Teil-1, `docs/END-GOAL-
//! FEATURES.md` §5.3/§5.4): `wpesrc` (Variante A, Go-Entscheidung aus
//! K5-Teil-0, `docs/decisions.md` 2026-07-15) rendert die Harness-Seite
//! (`ui/harness.html`, von `templates.rs` ausgeliefert), ein `tee`
//! verteilt an zwei MXL-Ausgänge:
//!
//! - **Fill** (`video/v210`, unverändert `omp_mediaio::mxl::
//!   MxlVideoOutput`): das eigentliche Bild.
//! - **Key** (ebenfalls `video/v210`, aber aus dem BGRA-Alpha-Byte pro
//!   Pixel gewonnen — s. `spawn_alpha_key_bridge` unten für die
//!   Begründung des Fallbacks "getrennte Fill+Key-Flows" statt eines
//!   nativen `video/v210a`-Einzelflows).
//!
//! Steuerung (`show`/`hide`) läuft über `wpesrc`s `run-javascript`-Action
//! ins geladene `window.omp` (s. `ui/harness.html`) — fire-and-forget,
//! kein Rückkanal von der Seite in die Pipeline nötig für Teil 1.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlContext, MxlVideoOutput};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

// 1280×720 statt der sonst im Projekt üblichen 640×480 (K1-K4-Testnodes):
// Grafik-Templates sind für reale HD-Broadcast-Auflösungen gestaltet
// (die 5 im K5-Teil-0-Spike getesteten Templates nennen `renderRequirements.
// resolution.ideal` 1920×1080) — 1280×720 als Kompromiss zwischen
// Lesbarkeit/Text-Rendering-Treue und CPU-Last des Software-Renderers auf
// der Dev-Maschine, volle HD folgt bei Bedarf über einen künftigen
// `OMP_OGRAF_WIDTH`/`_HEIGHT`-Override (Teil 1 hält es bewusst fest
// verdrahtet, wie `omp-source`s `WIDTH`/`HEIGHT`).
pub const WIDTH: u32 = 1280;
pub const HEIGHT: u32 = 720;
pub const FRAMERATE_NUMERATOR: u32 = 25;
pub const FRAMERATE_DENOMINATOR: u32 = 1;

pub struct Config {
    pub domain: String,
    pub fill_flow_id: String,
    pub key_flow_id: String,
    pub label: String,
    pub harness_url: String,
    pub width: u32,
    pub height: u32,
}

pub enum Command {
    Show {
        template_id: String,
        dir: String,
        main: String,
        data: Value,
    },
    Hide,
}

pub enum Event {
    Error(String),
}

struct PipelineError(String);

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

fn bgra_caps(width: u32, height: u32) -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("format", "BGRA")
        .field("width", width as i32)
        .field("height", height as i32)
        .field(
            "framerate",
            gst::Fraction::new(FRAMERATE_NUMERATOR as i32, FRAMERATE_DENOMINATOR as i32),
        )
        .build()
}

fn gray8_caps(width: u32, height: u32) -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("format", "GRAY8")
        .field("width", width as i32)
        .field("height", height as i32)
        .field(
            "framerate",
            gst::Fraction::new(FRAMERATE_NUMERATOR as i32, FRAMERATE_DENOMINATOR as i32),
        )
        .build()
}

/// Alpha-Key-Brücke: liest BGRA-Puffer vom `tee`-Zweig, extrahiert das
/// Alpha-Byte jedes Pixels in einen neuen GRAY8-Puffer, speist ihn in ein
/// `appsrc` — dasselbe Thread-Pull/-Push-Muster wie `omp_mediaio::mxl`s
/// eigene `write_loop`/`read_loop` (kein neues Verfahren erfunden).
///
/// **Warum nicht nativ `video/v210a`:** `third_party/mxl/lib/internal/
/// src/FlowParser.cpp` kodiert `v210a` als **zwei Rohbyte-Ebenen** in
/// einem Grain (Fill-Ebene v210-gepackt + Key-Ebene mit 10 Bit/Pixel, 3
/// Pixel pro 32-Bit-Wort) — kein GStreamer-`GstVideoFormat` erzeugt
/// dieses spezifische Byte-Layout aus einer normalen BGRA/RGBA-Quelle,
/// ein eigener Packer wäre eine substanzielle Neuentwicklung jenseits
/// von Teil 1 (per Live-Prüfung von `FlowParser.cpp` festgestellt, nicht
/// angenommen, s. `docs/decisions.md` 2026-07-15 K5-Teil-0). Deshalb der
/// im Design-Dokument selbst vorgesehene Fallback: zwei normale
/// `video/v210`-Flows (Fill + Key), exakt wie klassisches Broadcast-
/// Keying es ohnehin kennt — Teil 2 (Mixer-DSK-Anschluss) compositiert
/// beide zusammen.
///
/// **Bekannte Grenze:** GRAY8-Zeilenlänge wird als `width` angenommen
/// (keine Stride-Auffüllung) — für BGRA gilt das immer (4 Byte/Pixel,
/// von Natur aus 4-Byte-ausgerichtet), für GRAY8 nur bei `width % 4 ==
/// 0`. `Pipeline::build` prüft das vorab und bricht mit einer klaren
/// Fehlermeldung ab statt stillschweigend ein verzerrtes Bild zu
/// erzeugen.
fn spawn_alpha_key_bridge(
    pipeline: &gst::Pipeline,
    tee: &gst::Element,
    width: u32,
    height: u32,
    running: Arc<AtomicBool>,
) -> Result<gst::Element, PipelineError> {
    let queue = gst::ElementFactory::make("queue")
        .build()
        .map_err(|e| PipelineError(format!("queue (key): {e}")))?;
    // `async=false`: s. ausführliche Begründung in
    // `omp_mediaio::mxl::MxlVideoOutput::new` (derselbe Fund, dieselbe
    // Ursache — jeder Appsink an einem `tee`-Zweig dieser Pipeline
    // braucht es, nicht nur die beiden MXL-Ausgänge).
    let appsink = gst::ElementFactory::make("appsink")
        .property("sync", false)
        .property("async", false)
        .property("max-buffers", 2u32)
        .property("drop", true)
        .property("caps", bgra_caps(width, height))
        .build()
        .map_err(|e| PipelineError(format!("appsink (key): {e}")))?;
    // Live-Test-Fund (K5-Teil-1, docs/decisions.md 2026-07-16): `is-live`
    // gehört auf ein `appsrc`, das (wie hier) mitten in der Pipeline
    // manuell per `push_buffer()` gefüttert wird, NICHT auf `true`. Ein
    // "live" `appsrc` verhält sich wie jede andere Live-Quelle (z. B.
    // `v4l2src`) und liefert per GstBaseSrc-Vertrag **keinen** Puffer,
    // solange die Pipeline nur PAUSED ist ("no preroll for live
    // sources") — der Sink dahinter (hier: das Key-`MxlVideoOutput`)
    // kann dadurch nie prerollen, was wiederum den gesamten
    // PAUSED→PLAYING-Übergang der Pipeline blockiert (per
    // `GST_DEBUG=GST_STATES:5` hart nachgewiesen: alle drei Appsinks
    // blieben dauerhaft in `gst_base_sink_wait_preroll`, der einzige
    // fehlende Baustein war das Preroll-Bild dieses Zweigs). `is-live`
    // bleibt daher auf dem GStreamer-Default `false` — unser eigener
    // Thread liefert die Puffer ohnehin schon getaktet vom `tee`-Zweig,
    // eine zweite Live-Semantik mittendrin ist unnötig und war die
    // eigentliche Ursache des zuvor beobachteten Dauerstillstands (nicht
    // `wpesrc`/GLib-Thread-Konkurrenz, wie in einer früheren, nie
    // vollständig verifizierten Sitzung vermutet).
    let appsrc = gst::ElementFactory::make("appsrc")
        .property("format", gst::Format::Time)
        .property("caps", gray8_caps(width, height))
        .build()
        .map_err(|e| PipelineError(format!("appsrc (key): {e}")))?;

    pipeline
        .add(&queue)
        .and_then(|()| pipeline.add(&appsink))
        .and_then(|()| pipeline.add(&appsrc))
        .map_err(|e| PipelineError(format!("add key-bridge elements: {e}")))?;
    gst::Element::link_many([tee, &queue, &appsink])
        .map_err(|e| PipelineError(format!("link key-bridge sink chain: {e}")))?;

    let app_sink: gst_app::AppSink = appsink
        .dynamic_cast()
        .map_err(|_| PipelineError("appsink (key): cast to AppSink failed".to_string()))?;
    let app_src: gst_app::AppSrc = appsrc
        .clone()
        .dynamic_cast()
        .map_err(|_| PipelineError("appsrc (key): cast to AppSrc failed".to_string()))?;

    // Live-Test-Fund (K5-Teil-1, docs/decisions.md 2026-07-16): ein erster
    // Versuch, hier per `AppSinkCallbacks`/`new_sample` (synchron auf dem
    // GStreamer-Streaming-Thread) statt eines eigenen Threads zu arbeiten,
    // verursachte einen Preroll-Deadlock: alle drei Appsinks der Pipeline
    // (dieser hier + beide `MxlVideoOutput`-Appsinks) blieben per
    // `gdb`-Backtrace (`thread apply all bt`) und `GST_DEBUG=GST_STATES:5`
    // hart nachgewiesen dauerhaft in `gst_base_sink_wait_preroll()`
    // hängen — der Pipeline-Zustandswechsel PAUSED→PLAYING kam nie zum
    // Abschluss, obwohl jeder einzelne Nicht-Sink-Bestandteil (inkl.
    // `wpesrc`) seinen eigenen Übergang längst gemeldet hatte. Die
    // ursprünglich vermutete Ursache ("eigener Thread konkurriert mit
    // WPEs GLib-Hauptschleife") war eine Fehldiagnose aus einer früheren,
    // nie vollständig durchverifizierten Sitzung (s. Commit-Historie) —
    // der tatsächliche Reproduktionsfall (`gst-launch-1.0` mit `tee` +
    // zwei `queue`+`identity`+`fakesink`-Zweigen gegen dieselbe
    // `wpesrc`-URL) lief über 10s durchgehend mit ~25fps, ganz ohne
    // Appsink/Thread. Zurück auf denselben eigenen Thread + blockierendes
    // `try_pull_sample()` wie `omp_mediaio::mxl`s eigene `write_loop`
    // (bewährtes Muster aus `tools/mxl-gst/testsrc.cpp`, von acht anderen
    // Nodes seit C4 unverändert genutzt) — damit preroll(t) der Sink über
    // den offiziellen Pull-Pfad korrekt, kein Deadlock mehr.
    let pixel_count = (width as usize) * (height as usize);
    thread::spawn(move || {
        while running.load(Ordering::Relaxed) {
            let sample = match app_sink.try_pull_sample(gst::ClockTime::from_mseconds(200)) {
                Some(sample) => sample,
                None => continue,
            };
            let Some(buffer) = sample.buffer() else {
                continue;
            };
            let Ok(map) = buffer.map_readable() else {
                continue;
            };
            let bgra = map.as_slice();
            if bgra.len() < pixel_count * 4 {
                continue; // unerwartet kleiner Puffer, überspringen
            }
            let mut gray = vec![0u8; pixel_count];
            for i in 0..pixel_count {
                gray[i] = bgra[i * 4 + 3]; // Alpha-Byte (BGR**A**)
            }
            let pts = buffer.pts();
            drop(map);

            let mut out_buffer = gst::Buffer::from_slice(gray);
            if let (Some(pts), Some(out)) = (pts, out_buffer.get_mut()) {
                out.set_pts(pts);
            }
            let _ = app_src.push_buffer(out_buffer);
        }
    });

    Ok(appsrc)
}

struct Pipeline {
    pipeline: gst::Pipeline,
    wpesrc: gst::Element,
    page_ready: Arc<AtomicBool>,
    key_bridge_running: Arc<AtomicBool>,
    _mxl_fill: MxlVideoOutput,
    _mxl_key: MxlVideoOutput,
}

impl Pipeline {
    fn build(config: &Config) -> Result<Self, PipelineError> {
        if config.width % 4 != 0 {
            return Err(PipelineError(format!(
                "Breite {} nicht durch 4 teilbar (GRAY8-Key-Zweig braucht das, s. spawn_alpha_key_bridge-Doku)",
                config.width
            )));
        }
        gst::init().map_err(|e| PipelineError(format!("gst init failed: {e}")))?;

        let pipeline = gst::Pipeline::new();

        let wpesrc = gst::ElementFactory::make("wpesrc")
            .name("wpesrc")
            .property("location", &config.harness_url)
            .property("draw-background", false)
            .build()
            .map_err(|e| PipelineError(format!("wpesrc: {e}")))?;

        let convert = gst::ElementFactory::make("videoconvert")
            .build()
            .map_err(|e| PipelineError(format!("videoconvert: {e}")))?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", bgra_caps(config.width, config.height))
            .build()
            .map_err(|e| PipelineError(format!("capsfilter (bgra): {e}")))?;
        let tee = gst::ElementFactory::make("tee")
            .name("ograf_tee")
            .build()
            .map_err(|e| PipelineError(format!("tee: {e}")))?;

        pipeline
            .add(&wpesrc)
            .and_then(|()| pipeline.add(&convert))
            .and_then(|()| pipeline.add(&caps))
            .and_then(|()| pipeline.add(&tee))
            .map_err(|e| PipelineError(format!("add source elements: {e}")))?;
        // `wpesrc`s "video"-Pad ist "Always" verfügbar (per gst-inspect-1.0
        // im K5-Teil-0-Spike geprüft, nicht angenommen) — normales
        // `link_many` reicht, kein `pad-added`-Handling nötig.
        gst::Element::link_many([&wpesrc, &convert, &caps, &tee])
            .map_err(|e| PipelineError(format!("link source chain: {e}")))?;

        let fill_queue = gst::ElementFactory::make("queue")
            .build()
            .map_err(|e| PipelineError(format!("queue (fill): {e}")))?;
        let fill_convert = gst::ElementFactory::make("videoconvert")
            .build()
            .map_err(|e| PipelineError(format!("videoconvert (fill): {e}")))?;
        pipeline
            .add(&fill_queue)
            .and_then(|()| pipeline.add(&fill_convert))
            .map_err(|e| PipelineError(format!("add fill elements: {e}")))?;
        gst::Element::link_many([&tee, &fill_queue, &fill_convert])
            .map_err(|e| PipelineError(format!("link fill branch: {e}")))?;

        let mxl_context = Arc::new(
            MxlContext::new(&config.domain)
                .map_err(|e| PipelineError(format!("MxlContext::new: {e}")))?,
        );

        let mxl_fill = MxlVideoOutput::new(
            &pipeline,
            &fill_convert,
            mxl_context.clone(),
            &config.fill_flow_id,
            &format!("{} Fill", config.label),
            config.width,
            config.height,
            FRAMERATE_NUMERATOR,
            FRAMERATE_DENOMINATOR,
        )
        .map_err(PipelineError)?;
        mxl_fill.set_active(true);

        let key_bridge_running = Arc::new(AtomicBool::new(true));
        let key_appsrc = spawn_alpha_key_bridge(
            &pipeline,
            &tee,
            config.width,
            config.height,
            key_bridge_running.clone(),
        )?;
        let key_convert = gst::ElementFactory::make("videoconvert")
            .build()
            .map_err(|e| PipelineError(format!("videoconvert (key): {e}")))?;
        pipeline
            .add(&key_convert)
            .map_err(|e| PipelineError(format!("add key convert: {e}")))?;
        gst::Element::link_many([&key_appsrc, &key_convert])
            .map_err(|e| PipelineError(format!("link key branch: {e}")))?;

        let mxl_key = MxlVideoOutput::new(
            &pipeline,
            &key_convert,
            mxl_context,
            &config.key_flow_id,
            &format!("{} Key", config.label),
            config.width,
            config.height,
            FRAMERATE_NUMERATOR,
            FRAMERATE_DENOMINATOR,
        )
        .map_err(PipelineError)?;
        mxl_key.set_active(true);

        let page_ready = Arc::new(AtomicBool::new(false));
        let page_ready_probe = page_ready.clone();
        let tee_sink_pad = tee.static_pad("sink").expect("tee has a sink pad");
        tee_sink_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            // Der erste Puffer, der den `tee` erreicht, beweist, dass
            // `wpesrc` die Harness-Seite tatsächlich gerendert hat (die
            // Seite definiert `window.omp` synchron beim Laden, s.
            // `ui/harness.html`) — Grundlage für die Bereitschafts-Sonde
            // in `run()` unten, die `run-javascript` erst danach
            // aufruft (sonst liefe der allererste `show()`-Aufruf nach
            // dem Node-Start ins Leere).
            page_ready_probe.store(true, Ordering::Relaxed);
            gst::PadProbeReturn::Ok
        });

        // Live-Test-Fund (K5-Teil-1, docs/decisions.md 2026-07-16): ein
        // einzelner `set_state(Playing)`-Aufruf ohne begleitendes
        // `get_state()` blieb hier dauerhaft hängen — per
        // `GST_DEBUG=GST_STATES:5` nachgewiesen: `wpevideosrc0` (die
        // Live-Quelle in `wpesrc`) meldet ihren eigenen Zustandswechsel
        // als `NO_PREROLL` statt `ASYNC`/`SUCCESS` (GStreamers Vertrag für
        // Live-Quellen: "liefert im PAUSED-Zustand keine Daten, also auch
        // kein echtes Preroll"), was sich bis zu `pipeline0` selbst
        // hochpflanzt (`gst_bin_change_state_func`: "we have NO_PREROLL
        // elements SUCCESS -> NO_PREROLL"). Ohne einen expliziten
        // `get_state()`-Aufruf (der GStreamers interne Zustands-Buchhaltung
        // tatsächlich abarbeitet) blieben die drei normalen, nicht-live
        // `appsink`s der Pipeline (Fill/Key-Brücke/Key-Ausgang) trotz je
        // eines erfolgreich zugestellten ersten Puffers dauerhaft in
        // `gst_base_sink_wait_preroll()` hängen. Fix: derselbe
        // zweistufige PAUSED→(`get_state`)→PLAYING→(`get_state`)-Ablauf,
        // den `gst-launch-1.0` (per eigenem Kontroll-Testlauf gegen
        // dieselbe `wpesrc`-URL bestätigt durchgehend funktionsfähig)
        // intern selbst fährt — `NO_PREROLL` ist dabei der erwartete,
        // nicht fehlerhafte Rückgabewert für den ersten Schritt.
        pipeline
            .set_state(gst::State::Paused)
            .map_err(|e| PipelineError(format!("set state paused: {e}")))?;
        let (paused_result, _, _) = pipeline.state(gst::ClockTime::from_seconds(5));
        if let Err(e) = paused_result {
            return Err(PipelineError(format!("pipeline did not reach PAUSED: {e:?}")));
        }
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| PipelineError(format!("set state playing: {e}")))?;
        let (playing_result, _, _) = pipeline.state(gst::ClockTime::from_seconds(5));
        if let Err(e) = playing_result {
            return Err(PipelineError(format!("pipeline did not reach PLAYING: {e:?}")));
        }

        Ok(Pipeline {
            pipeline,
            wpesrc,
            page_ready,
            key_bridge_running,
            _mxl_fill: mxl_fill,
            _mxl_key: mxl_key,
        })
    }

    fn run_javascript(&self, code: &str) {
        self.wpesrc.emit_by_name::<()>("run-javascript", &[&code]);
    }

    fn shutdown(&self) {
        self.key_bridge_running.store(false, Ordering::Relaxed);
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Griff für den async Node-Lifecycle (`main.rs`): `media_ready`
/// (`ARCHITECTURE.md` §5 Punkt 6) meldet "bereit", sobald die
/// Harness-Seite nachweislich mindestens einen Frame gerendert hat —
/// unabhängig davon, ob schon ein Template sichtbar ist (die Pipeline
/// selbst produziert bereits gültige, wenn auch leere/transparente
/// MXL-Frames, das ist der relevante Medien-Fluss-Nachweis).
#[derive(Clone)]
pub struct PipelineHandle {
    commands: std::sync::mpsc::Sender<Command>,
    page_ready: Arc<AtomicBool>,
}

impl PipelineHandle {
    pub fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }

    pub fn media_ready(&self) -> bool {
        self.page_ready.load(Ordering::Relaxed)
    }
}

fn show_js(template_id: &str, dir: &str, main: &str, data: &Value) -> String {
    format!(
        "window.omp.show({}, {}, {}, {})",
        serde_json::to_string(template_id).unwrap_or_else(|_| "\"\"".to_string()),
        serde_json::to_string(dir).unwrap_or_else(|_| "\"\"".to_string()),
        serde_json::to_string(main).unwrap_or_else(|_| "\"\"".to_string()),
        serde_json::to_string(data).unwrap_or_else(|_| "{}".to_string()),
    )
}

pub fn run(
    config: Config,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
) {
    let pipeline = match Pipeline::build(&config) {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.send(Event::Error(e.to_string()));
            let _ = ready.send(Err(e.to_string()));
            return;
        }
    };

    // Live-Test-Fund (K5-Teil-1, per gdb/GST_DEBUG/CPU-Zeit-Vergleich
    // hart verifiziert, nicht angenommen): `wpesrc` kapselt einen eigenen
    // WebKit-Prozess (`WPEWebProcess`) und braucht eine laufende
    // `GMainLoop`, an die der Pipeline-`Bus` per `add_watch()`
    // angehängt ist — eine reine `MainLoop::run()` ohne angehängten Bus
    // reicht NICHT (ausprobiert, half nichts). Ohne diese Kombination
    // liefert `wpesrc` reproduzierbar genau eine Hand voll Puffer (das
    // initiale Setup) und geht danach messbar in Leerlauf: `WPEWebProcess`s
    // `/proc/<pid>/stat`-CPU-Zeit (utime/stime) blieb über mehrere
    // Sekunden exakt unverändert, während `gst-launch-1.0` gegen exakt
    // dieselbe Harness-URL/Topologie kontinuierlich mit ~25fps weiterlief
    // — der einzige Unterschied war `gst-launch-1.0`s eigene interne
    // GMainLoop+Bus-Verdrahtung. Kein anderer bisheriger Node brauchte
    // das (`videotestsrc`/`uridecodebin`/... sind reine GStreamer-
    // Streaming-Thread-Elemente ohne GLib-IPC-Unterbau). Ersetzt die
    // vorherige `poll_error()`-Bus-Pollschleife komplett (beide dieselbe
    // Bus-Queue zu lesen hätte sich gegenseitig Nachrichten weggeschnappt).
    let main_loop = gst::glib::MainLoop::new(None, false);
    let bus = pipeline.pipeline.bus().expect("pipeline always has a bus");
    let bus_tx = tx.clone();
    let bus_watch_guard = bus
        .add_watch(move |_bus, msg| {
            if let gst::MessageView::Error(err) = msg.view() {
                let _ = bus_tx.send(Event::Error(format!(
                    "{} ({})",
                    err.error(),
                    err.debug().unwrap_or_default()
                )));
            }
            gst::glib::ControlFlow::Continue
        })
        .expect("bus add_watch");
    let main_loop_thread = {
        let main_loop = main_loop.clone();
        thread::spawn(move || main_loop.run())
    };

    let (commands_tx, commands_rx) = std::sync::mpsc::channel::<Command>();
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
        page_ready: pipeline.page_ready.clone(),
    }));

    // Bereitschafts-Wartepuffer: ein `show()`/`hide()`, das eintrifft,
    // bevor `page_ready` wahr ist (z. B. sofort nach Node-Start), wird
    // hier gehalten und beim nächsten Loop-Durchlauf erneut versucht —
    // `run-javascript` ist fire-and-forget, ein zu früher Aufruf ginge
    // sonst kommentarlos ins Leere (`window.omp` existiert noch nicht).
    let mut pending: Option<Command> = None;

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }

        if pending.is_none() {
            pending = commands_rx.recv_timeout(Duration::from_millis(200)).ok();
        }

        if let Some(command) = pending.take() {
            if pipeline.page_ready.load(Ordering::Relaxed) {
                let code = match &command {
                    Command::Show {
                        template_id,
                        dir,
                        main,
                        data,
                    } => show_js(template_id, dir, main, data),
                    Command::Hide => "window.omp.hide()".to_string(),
                };
                pipeline.run_javascript(&code);
            } else {
                pending = Some(command);
            }
        }
    }

    pipeline.shutdown();
    drop(bus_watch_guard);
    main_loop.quit();
    let _ = main_loop_thread.join();
}
