//! MXL-Zero-Copy-Transport (`UMSETZUNG.md` C4).
//!
//! Es gibt **kein** `mxlsink`/`mxlsrc`-GStreamer-Element (siehe
//! `docs/decisions.md`, 2026-07-09 "MXL-GStreamer-Integration
//! richtiggestellt") — MXL v1.0.1 liefert dafür die Crates `mxl`/`mxl-sys`
//! (`third_party/mxl/rust/mxl`, per `deploy/dev/install-mxl.sh` geklont),
//! die einen sicheren Wrapper um die C-API bieten (`FlowWriter`/
//! `FlowReader`, `GrainWriter`/`GrainReader`). Diese Datei baut die dafür
//! nötige `appsink`/`appsrc`-Brücke selbst, nach dem Muster aus
//! `tools/mxl-gst/testsrc.cpp` (Schreiben) bzw. `sink.cpp` (Lesen) im
//! MXL-Repo, aber bewusst vereinfacht (siehe Kommentare unten).
//!
//! `libmxl.so` wird zur Laufzeit per `dlopen` geladen (`libloading`,
//! Funktion [`mxl::load_api`]) — muss über `LD_LIBRARY_PATH` auffindbar
//! sein (`deploy/dev/mxl.env`).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;

use crate::Output;

/// Referenz-Caps-Name für `GstReferenceTimestampMeta` (ARCHITECTURE.md
/// §15 Punkt 4, nachgezogen 2026-07-12 per Fable-Konsultation): markiert
/// eine an einem MXL-Lesepfad angehängte Ursprungs-Zeitangabe als
/// "MXL-TAI", damit ein Schreibpfad sie eindeutig von anderen
/// Referenz-Zeitstempeln unterscheiden kann, die dieselbe Pipeline aus
/// anderen Gründen tragen könnte. Video und Audio teilen sich denselben
/// Namen — die Meta selbst trägt keine Formatinformation, die ist über
/// den jeweiligen Flow/Node ohnehin bekannt.
fn tai_reference_caps() -> gst::Caps {
    gst::Caps::new_empty_simple("timestamp/x-mxl-tai")
}

/// Geladene MXL-API + geöffnete Instanz für eine Domain (Shared-Memory-
/// Verzeichnis). Ein `MxlContext` pro Prozess reicht — Reader und Writer
/// für beliebig viele Flows teilen sich dieselbe Instanz (z. B.
/// `omp-switcher`, `UMSETZUNG.md` C7: N `MxlVideoInput` + 1
/// `MxlVideoOutput` in einem Prozess).
pub struct MxlContext {
    instance: mxl::MxlInstance,
}

impl MxlContext {
    /// Lädt `libmxl.so` (Name reicht, sofern über `LD_LIBRARY_PATH`
    /// auffindbar — kein fest einprogrammierter Pfad, damit der Build-
    /// Preset des jeweiligen `install-mxl.sh`-Laufs egal ist) und
    /// öffnet/erstellt die Instanz für `domain`.
    pub fn new(domain: &str) -> Result<Self, String> {
        let api = mxl::load_api("libmxl.so").map_err(|e| format!("libmxl.so laden: {e}"))?;
        let instance =
            mxl::MxlInstance::new(api, domain, "").map_err(|e| format!("MXL-Instanz: {e}"))?;
        Ok(MxlContext { instance })
    }
}

fn video_flow_def(
    flow_id: &str,
    label: &str,
    width: u32,
    height: u32,
    grain_rate_numerator: u32,
    grain_rate_denominator: u32,
) -> String {
    // Format/Layout 1:1 nach third_party/mxl/lib/tests/data/v210_flow.json
    // (offizielles Beispiel des MXL-Projekts) — Y in voller Breite, Cb/Cr
    // in halber Breite (4:2:2), 10 bit, wie von GStreamers `v210`-Caps
    // erzeugt. Kein eigenes Rätselraten über MXLs Flow-JSON-Schema: gleiche
    // Struktur wie das mitgelieferte Beispiel, nur Werte ausgetauscht.
    serde_json::json!({
        "id": flow_id,
        "label": label,
        "description": format!("OpenMediaPlatform: {label}"),
        "tags": {
            // Pflichtfeld, Format "<group-name>:<role-in-group>" (siehe
            // FlowParser.cpp-Fehlermeldung sowie das mitgelieferte
            // v210_flow.json-Beispiel) — MXL gruppiert zusammengehörige
            // Flows (z. B. Video+Audio derselben Quelle) darüber; wir
            // haben v0 nur Video, daher Flow-ID als eindeutiger
            // Gruppenname.
            "urn:x-nmos:tag:grouphint/v1.0": [format!("{flow_id}:Video")],
        },
        "format": "urn:x-nmos:format:video",
        "parents": [],
        "media_type": "video/v210",
        "grain_rate": {
            "numerator": grain_rate_numerator,
            "denominator": grain_rate_denominator,
        },
        "frame_width": width,
        "frame_height": height,
        "interlace_mode": "progressive",
        "colorspace": "BT709",
        "components": [
            {"name": "Y", "width": width, "height": height, "bit_depth": 10},
            {"name": "Cb", "width": width / 2, "height": height, "bit_depth": 10},
            {"name": "Cr", "width": width / 2, "height": height, "bit_depth": 10},
        ],
    })
    .to_string()
}

fn video_caps(
    width: u32,
    height: u32,
    framerate_numerator: u32,
    framerate_denominator: u32,
) -> gst::Caps {
    gst::Caps::builder("video/x-raw")
        .field("format", "v210")
        .field("width", width as i32)
        .field("height", height as i32)
        .field(
            "framerate",
            gst::Fraction::new(framerate_numerator as i32, framerate_denominator as i32),
        )
        .build()
}

/// MXL-Video-Ausgang: `videoconvert ! videoscale ! videorate !
/// capsfilter(v210, fix WxH@fps) ! valve ! appsink`, dahinter ein Thread,
/// der Samples zieht und als Grains in den Flow schreibt.
///
/// **Vereinfachung ggü. `tools/mxl-gst/testsrc.cpp` (dokumentiert, nicht
/// geraten):** kein TAI-System-Clock-Alignment der Pipeline, keine
/// PTS-zu-Index-Umrechnung. Stattdessen wird der Grain-Index einmalig bei
/// der ersten Sample per `get_current_index()` initialisiert und danach
/// pro Sample um 1 erhöht — korrekt, solange Samples ungefähr im
/// konfigurierten Takt ankommen (gegeben bei `videotestsrc`/`videorate`),
/// aber ohne Selbstkorrektur bei Drift/Aussetzern. Reicht für die
/// Test-Trias (C5–C7); eine spätere produktionsnahe Quelle sollte auf das
/// PTS-basierte Verfahren wechseln, falls Drift beobachtet wird.
pub struct MxlVideoOutput {
    valve: gst::Element,
    running: Arc<AtomicBool>,
    flowed: Arc<AtomicBool>,
}

impl MxlVideoOutput {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pipeline: &gst::Pipeline,
        upstream: &gst::Element,
        context: Arc<MxlContext>,
        flow_id: &str,
        label: &str,
        width: u32,
        height: u32,
        framerate_numerator: u32,
        framerate_denominator: u32,
    ) -> Result<Self, String> {
        let videoconvert = gst::ElementFactory::make("videoconvert")
            .build()
            .map_err(|e| format!("videoconvert: {e}"))?;
        let videoscale = gst::ElementFactory::make("videoscale")
            .build()
            .map_err(|e| format!("videoscale: {e}"))?;
        let videorate = gst::ElementFactory::make("videorate")
            .build()
            .map_err(|e| format!("videorate: {e}"))?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                video_caps(width, height, framerate_numerator, framerate_denominator),
            )
            .build()
            .map_err(|e| format!("capsfilter(v210): {e}"))?;
        // Kein fester `.name(...)` (anders als früher): `omp-ograf`
        // (K5-Teil-1) instanziiert `MxlVideoOutput` zweimal in derselben
        // Pipeline (Fill + Key) — ein fest verdrahteter Name hätte beim
        // zweiten Aufruf mit "Failed to add element" kollidiert (per
        // Live-Test gefunden, nicht angenommen). GStreamer vergibt ohne
        // `.name(...)` automatisch eindeutige Namen, exakt wie die
        // Geschwister-Elemente in dieser Funktion (`videoconvert` etc.)
        // es ohnehin schon tun — kein Code sucht dieses Element je über
        // seinen Namen (`self.valve` hält die Referenz direkt).
        let valve = gst::ElementFactory::make("valve")
            .property("drop", true)
            .build()
            .map_err(|e| format!("valve: {e}"))?;
        // `async=false` (Live-Test-Fund K5-Teil-1, docs/decisions.md
        // 2026-07-16, bestätigtes Muster aus `PIPELINE CONTROLLER/lib/
        // PlayerPipeline.js`/`MasterPipeline.js`, `UMSETZUNG.md` §0 Punkt
        // 9): ohne dieses Flag muss der Sink erst einen Puffer empfangen
        // (Preroll), bevor sein eigener PAUSED→PLAYING-Übergang als
        // abgeschlossen gilt — bei `omp-ograf` (K5-Teil-1) mit `wpesrc`
        // und drei Appsinks in einer `tee`-Topologie führte das
        // reproduzierbar zu einem Dauer-Deadlock in
        // `gst_base_sink_wait_preroll()` (per `gdb`/`GST_DEBUG=
        // GST_STATES:5` hart nachgewiesen), sobald ein Zweig minimal
        // langsamer lief als die anderen. `async=false` lässt den
        // Zustandswechsel synchron/sofort durchlaufen, unabhängig davon,
        // ob/wann der erste Puffer ankommt — exakt das dokumentierte
        // Muster, das PIPELINE CONTROLLER für jeden Tee-Zweig-Sink
        // (`intervideosink`/`interaudiosink`) verwendet.
        let appsink = gst::ElementFactory::make("appsink")
            .property("sync", false)
            .property("async", false)
            .property("max-buffers", 2u32)
            .property("drop", true)
            .build()
            .map_err(|e| format!("appsink: {e}"))?;

        pipeline
            .add(&videoconvert)
            .and_then(|()| pipeline.add(&videoscale))
            .and_then(|()| pipeline.add(&videorate))
            .and_then(|()| pipeline.add(&caps))
            .and_then(|()| pipeline.add(&valve))
            .and_then(|()| pipeline.add(&appsink))
            .map_err(|e| format!("add mxl output elements: {e}"))?;

        gst::Element::link_many([
            upstream,
            &videoconvert,
            &videoscale,
            &videorate,
            &caps,
            &valve,
            &appsink,
        ])
        .map_err(|e| format!("link mxl output chain: {e}"))?;

        // Gleicher Verwaisungs-Schutz wie `MxlVideoInput::new` (s. dort):
        // ab hier hängen sechs Elemente bereits im `pipeline`, ein
        // Fehlschlag der folgenden MXL-Schritte darf sie nicht über `?`
        // zurücklassen.
        let cleanup_partial = || {
            for el in [
                &videoconvert,
                &videoscale,
                &videorate,
                &caps,
                &valve,
                &appsink,
            ] {
                let _ = el.set_state(gst::State::Null);
                let _ = pipeline.remove(el);
            }
        };

        let flow_def = video_flow_def(
            flow_id,
            label,
            width,
            height,
            framerate_numerator,
            framerate_denominator,
        );
        let (writer, _config, was_created) = match context.instance.create_flow_writer(&flow_def, None) {
            Ok(w) => w,
            Err(e) => {
                cleanup_partial();
                return Err(format!("create_flow_writer: {e}"));
            }
        };
        if !was_created {
            eprintln!("omp-mediaio(mxl): reusing existing flow {flow_id}");
        }
        let grain_writer = match writer.to_grain_writer() {
            Ok(gw) => gw,
            Err(e) => {
                cleanup_partial();
                return Err(format!("to_grain_writer: {e}"));
            }
        };

        let grain_rate = mxl_sys::Rational {
            numerator: framerate_numerator as i64,
            denominator: framerate_denominator as i64,
        };

        let running = Arc::new(AtomicBool::new(true));
        let running_thread = running.clone();
        let flowed = Arc::new(AtomicBool::new(false));
        let flowed_thread = flowed.clone();
        let app_sink: gst_app::AppSink = match appsink.clone().dynamic_cast::<gst_app::AppSink>() {
            Ok(a) => a,
            Err(_) => {
                cleanup_partial();
                return Err("appsink: cast to AppSink failed".to_string());
            }
        };

        thread::spawn(move || {
            write_loop(
                &context,
                grain_writer,
                &grain_rate,
                &app_sink,
                &running_thread,
                &flowed_thread,
            );
        });

        Ok(MxlVideoOutput {
            valve,
            running,
            flowed,
        })
    }
}

fn write_loop(
    context: &Arc<MxlContext>,
    grain_writer: mxl::GrainWriter,
    grain_rate: &mxl_sys::Rational,
    app_sink: &gst_app::AppSink,
    running: &Arc<AtomicBool>,
    flowed: &Arc<AtomicBool>,
) {
    let reference_caps = tai_reference_caps();
    let mut index: Option<u64> = None;
    let mut last_written: Option<u64> = None;
    while running.load(Ordering::Relaxed) {
        let sample = match app_sink.try_pull_sample(gst::ClockTime::from_mseconds(200)) {
            Some(sample) => sample,
            None => continue,
        };
        let Some(buffer) = sample.buffer() else {
            continue;
        };
        let Ok(map) = buffer.map_readable() else {
            eprintln!("omp-mediaio(mxl): buffer map_readable failed, dropping frame");
            continue;
        };

        // Ursprungs-Index bevorzugen, falls ein durchgereichter Node
        // (z. B. omp-switcher) die TAI-Herkunftszeit als Meta trägt
        // (ARCHITECTURE.md §15 Punkt 4) — sonst wie bisher fortlaufend
        // zählen (z. B. ein Mixer-Ausgang oder eine Test-Quelle ohne
        // durchgereichten Ursprung, per Definition ein neuer Ursprung).
        // `max(origin, letzter+1)` schützt vor Rückwärtssprüngen (z. B.
        // durch von `videorate` duplizierte Buffer mit identischer Meta).
        let origin_index = origin_index_from_buffer(context, buffer, &reference_caps, grain_rate);
        let this_index = match origin_index {
            Some(origin) => match last_written {
                Some(last) => origin.max(last + 1),
                None => origin,
            },
            None => *index.get_or_insert_with(|| context.instance.get_current_index(grain_rate)),
        };

        match grain_writer.open_grain(this_index) {
            Ok(mut access) => {
                let payload = access.payload_mut();
                let n = payload.len().min(map.as_slice().len());
                payload[..n].copy_from_slice(&map.as_slice()[..n]);
                let total_slices = access.total_slices();
                match access.commit(total_slices) {
                    Ok(()) => flowed.store(true, Ordering::Relaxed),
                    Err(e) => eprintln!("omp-mediaio(mxl): commit grain {this_index} failed: {e}"),
                }
            }
            Err(e) => {
                eprintln!("omp-mediaio(mxl): open_grain {this_index} failed: {e}");
            }
        }

        last_written = Some(this_index);
        index = Some(this_index + 1);
    }
}

/// Liest die per [`ReferenceTimestampMeta`](gst::ReferenceTimestampMeta)
/// mitgeführte TAI-Ursprungszeit (falls vorhanden, s.
/// [`tai_reference_caps`]) und rechnet sie zurück in einen Grain-/Sample-
/// Index — `None`, wenn keine solche Meta anliegt (z. B. Ausgang eines
/// Mixers/einer Testquelle) oder die Umrechnung fehlschlägt.
fn origin_index_from_buffer(
    context: &Arc<MxlContext>,
    buffer: &gst::BufferRef,
    reference_caps: &gst::Caps,
    rate: &mxl_sys::Rational,
) -> Option<u64> {
    let meta = buffer.meta::<gst::ReferenceTimestampMeta>()?;
    if meta.reference() != reference_caps.as_ref() {
        return None;
    }
    context
        .instance
        .timestamp_to_index(meta.timestamp().nseconds(), rate)
        .ok()
}

impl Output for MxlVideoOutput {
    fn set_active(&self, active: bool) {
        self.valve.set_property("drop", !active);
    }

    fn is_active(&self) -> bool {
        !self.valve.property::<bool>("drop")
    }
}

impl MxlVideoOutput {
    /// Eigenständiger, klonbarer Griff auf das "media-ready"-Flag
    /// (`ARCHITECTURE.md` §5 Punkt 6) — für Aufrufer, deren
    /// `MxlVideoOutput`-Instanz nicht über die gesamte Prozesslaufzeit
    /// erreichbar bleibt (z. B. `omp-player`s `ActivePipeline`, die nur
    /// im Pipeline-Thread lebt), aber das Flag trotzdem von außen
    /// (`NodeConfig::media_ready`) abfragen muss.
    pub fn flowed_handle(&self) -> Arc<AtomicBool> {
        self.flowed.clone()
    }
}

impl crate::MediaFlow for MxlVideoOutput {
    fn has_flowed(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

impl Drop for MxlVideoOutput {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

fn audio_flow_def(flow_id: &str, label: &str, sample_rate: u32, channel_count: u32) -> String {
    // Struktur 1:1 nach third_party/mxl/lib/tests/data/audio_flow.json
    // (offizielles Beispiel) — kein Rätselraten über MXLs Audio-Flow-
    // Schema. Audio ist bei MXL ein **"continuous"**-Flow (Sample-Ring-
    // Buffer), kein "discrete"-Grain-Flow wie Video (`third_party/mxl/
    // docs/Architecture.md`: "Discrete ringbuffers are used for granular
    // data types such as video ... Continuous ringbuffers are used for
    // audio") — deshalb kein `grain_rate`-Feld, sondern `sample_rate`,
    // und `to_samples_writer()` statt `to_grain_writer()` beim Öffnen
    // (`MxlAudioOutput::new` unten).
    serde_json::json!({
        "id": flow_id,
        "label": label,
        "description": format!("OpenMediaPlatform: {label}"),
        "tags": {
            "urn:x-nmos:tag:grouphint/v1.0": [format!("{flow_id}:Audio")],
        },
        "format": "urn:x-nmos:format:audio",
        "parents": [],
        "media_type": "audio/float32",
        "sample_rate": {
            "numerator": sample_rate,
        },
        "channel_count": channel_count,
        "bit_depth": 32,
    })
    .to_string()
}

fn audio_caps(sample_rate: u32, channels: u32, layout: &str) -> gst::Caps {
    // `layout=non-interleaved` (planar, ein Kanal nach dem anderen im
    // gemappten Buffer) passt direkt auf MXLs `channel_data_mut(channel)`-
    // Zugriff (`SamplesWriteAccess`, ein eigener Byte-Slice pro Kanal) —
    // kein manuelles Kanal-Deinterleaving nötig. `audiobuffersplit`
    // akzeptiert aber nur `layout=interleaved` (`gst-inspect-1.0
    // audiobuffersplit`, Sink- **und** Src-Pad-Template) — deshalb hier
    // parametrisiert statt fest verdrahtet: interleaved bis inklusive
    // `audiobuffersplit`, non-interleaved erst danach (s.
    // `MxlAudioOutput::new`).
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("rate", sample_rate as i32)
        .field("channels", channels as i32)
        .field("layout", layout)
        .build()
}

/// MXL-Audio-Ausgang, Pendant zu [`MxlVideoOutput`] für **continuous**-
/// Flows (s. `audio_flow_def`). `audiobuffersplit` erzwingt eine feste
/// Blockgröße (`output-buffer-duration` 1/100 = 10ms, gleicher Batch-Wert
/// wie der Default im offiziellen `mxl`-Rust-Beispiel
/// `rust/mxl/examples/flow-writer.rs::write_samples`, dessen Aufruf-Muster
/// — `open_samples(index, batch_size)`, danach `index += batch_size` —
/// hier 1:1 übernommen wird, nur mit echten Pipeline-Samples statt
/// synthetischer Testbytes) — ohne feste Blockgröße hätte jeder
/// `appsink`-Pull eine andere Byteanzahl, `open_samples` erwartet aber
/// eine pro Batch vorab bekannte `count`.
pub struct MxlAudioOutput {
    valve: gst::Element,
    running: Arc<AtomicBool>,
    flowed: Arc<AtomicBool>,
}

impl MxlAudioOutput {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pipeline: &gst::Pipeline,
        upstream: &gst::Element,
        context: Arc<MxlContext>,
        flow_id: &str,
        label: &str,
        sample_rate: u32,
        channels: u32,
    ) -> Result<Self, String> {
        let audioconvert = gst::ElementFactory::make("audioconvert")
            .build()
            .map_err(|e| format!("audioconvert: {e}"))?;
        let audioresample = gst::ElementFactory::make("audioresample")
            .build()
            .map_err(|e| format!("audioresample: {e}"))?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", audio_caps(sample_rate, channels, "interleaved"))
            .build()
            .map_err(|e| format!("capsfilter(audio): {e}"))?;
        let split = gst::ElementFactory::make("audiobuffersplit")
            .property("output-buffer-duration", gst::Fraction::new(1, 100))
            .build()
            .map_err(|e| format!("audiobuffersplit: {e}"))?;
        // Erst nach `audiobuffersplit` auf non-interleaved wandeln (s.
        // `audio_caps`-Kommentar) — eigener `audioconvert`, weil der
        // erste bereits für Format/Kanalzahl gebraucht wird und
        // `audiobuffersplit` zwischen beiden ausschließlich interleaved
        // akzeptiert.
        let planar_convert = gst::ElementFactory::make("audioconvert")
            .build()
            .map_err(|e| format!("audioconvert (planar): {e}"))?;
        let planar_caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                audio_caps(sample_rate, channels, "non-interleaved"),
            )
            .build()
            .map_err(|e| format!("capsfilter(audio planar): {e}"))?;
        let valve = gst::ElementFactory::make("valve")
            .name("mxl_audio_output_valve")
            .property("drop", true)
            .build()
            .map_err(|e| format!("valve: {e}"))?;
        let appsink = gst::ElementFactory::make("appsink")
            .property("sync", false)
            .property("max-buffers", 4u32)
            .property("drop", true)
            .build()
            .map_err(|e| format!("appsink: {e}"))?;

        pipeline
            .add(&audioconvert)
            .and_then(|()| pipeline.add(&audioresample))
            .and_then(|()| pipeline.add(&caps))
            .and_then(|()| pipeline.add(&split))
            .and_then(|()| pipeline.add(&planar_convert))
            .and_then(|()| pipeline.add(&planar_caps))
            .and_then(|()| pipeline.add(&valve))
            .and_then(|()| pipeline.add(&appsink))
            .map_err(|e| format!("add mxl audio output elements: {e}"))?;

        gst::Element::link_many([
            upstream,
            &audioconvert,
            &audioresample,
            &caps,
            &split,
            &planar_convert,
            &planar_caps,
            &valve,
            &appsink,
        ])
        .map_err(|e| format!("link mxl audio output chain: {e}"))?;

        // Gleicher Verwaisungs-Schutz wie `MxlVideoInput::new` (s. dort).
        let cleanup_partial = || {
            for el in [
                &audioconvert,
                &audioresample,
                &caps,
                &split,
                &planar_convert,
                &planar_caps,
                &valve,
                &appsink,
            ] {
                let _ = el.set_state(gst::State::Null);
                let _ = pipeline.remove(el);
            }
        };

        let flow_def = audio_flow_def(flow_id, label, sample_rate, channels);
        let (writer, _config, was_created) = match context.instance.create_flow_writer(&flow_def, None) {
            Ok(w) => w,
            Err(e) => {
                cleanup_partial();
                return Err(format!("create_flow_writer(audio): {e}"));
            }
        };
        if !was_created {
            eprintln!("omp-mediaio(mxl): reusing existing audio flow {flow_id}");
        }
        let samples_writer = match writer.to_samples_writer() {
            Ok(sw) => sw,
            Err(e) => {
                cleanup_partial();
                return Err(format!("to_samples_writer: {e}"));
            }
        };

        let sample_rate_r = mxl_sys::Rational {
            numerator: sample_rate as i64,
            denominator: 1,
        };
        let batch_size = (sample_rate / 100).max(1) as u64;

        let running = Arc::new(AtomicBool::new(true));
        let running_thread = running.clone();
        let flowed = Arc::new(AtomicBool::new(false));
        let flowed_thread = flowed.clone();
        let app_sink: gst_app::AppSink = match appsink.clone().dynamic_cast::<gst_app::AppSink>() {
            Ok(a) => a,
            Err(_) => {
                cleanup_partial();
                return Err("appsink: cast to AppSink failed".to_string());
            }
        };

        thread::spawn(move || {
            write_audio_loop(
                &context,
                samples_writer,
                &sample_rate_r,
                batch_size,
                channels as usize,
                &app_sink,
                &running_thread,
                &flowed_thread,
            );
        });

        Ok(MxlAudioOutput {
            valve,
            running,
            flowed,
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn write_audio_loop(
    context: &Arc<MxlContext>,
    samples_writer: mxl::SamplesWriter,
    sample_rate: &mxl_sys::Rational,
    batch_size: u64,
    channels: usize,
    app_sink: &gst_app::AppSink,
    running: &Arc<AtomicBool>,
    flowed: &Arc<AtomicBool>,
) {
    let reference_caps = tai_reference_caps();
    let mut index: Option<u64> = None;
    let mut last_written: Option<u64> = None;
    while running.load(Ordering::Relaxed) {
        let sample = match app_sink.try_pull_sample(gst::ClockTime::from_mseconds(200)) {
            Some(sample) => sample,
            None => continue,
        };
        let Some(buffer) = sample.buffer() else {
            continue;
        };
        let Ok(map) = buffer.map_readable() else {
            eprintln!("omp-mediaio(mxl): audio buffer map_readable failed, dropping batch");
            continue;
        };
        let bytes = map.as_slice();
        let bytes_per_channel = bytes.len() / channels.max(1);

        // Gleiches Ursprungs-Index-Prinzip wie im Video-Schreibpfad
        // (`write_loop`) — s. Kommentar dort.
        let origin_index =
            origin_index_from_buffer(context, buffer, &reference_caps, sample_rate);
        let this_index = match origin_index {
            Some(origin) => match last_written {
                Some(last) => origin.max(last + batch_size),
                None => origin,
            },
            None => *index.get_or_insert_with(|| context.instance.get_current_index(sample_rate)),
        };

        match samples_writer.open_samples(this_index, batch_size as usize) {
            Ok(mut access) => {
                for channel in 0..access.channels().min(channels) {
                    let Ok((dst_1, dst_2)) = access.channel_data_mut(channel) else {
                        continue;
                    };
                    let src_start = channel * bytes_per_channel;
                    let src_end = (src_start + bytes_per_channel).min(bytes.len());
                    let src = &bytes[src_start..src_end];
                    let n1 = dst_1.len().min(src.len());
                    dst_1[..n1].copy_from_slice(&src[..n1]);
                    let remaining = &src[n1..];
                    let n2 = dst_2.len().min(remaining.len());
                    dst_2[..n2].copy_from_slice(&remaining[..n2]);
                }
                match access.commit() {
                    Ok(()) => flowed.store(true, Ordering::Relaxed),
                    Err(e) => eprintln!("omp-mediaio(mxl): commit samples at {this_index} failed: {e}"),
                }
            }
            Err(e) => {
                eprintln!("omp-mediaio(mxl): open_samples {this_index} failed: {e}");
            }
        }

        last_written = Some(this_index);
        index = Some(this_index + batch_size);
    }
}

impl Output for MxlAudioOutput {
    fn set_active(&self, active: bool) {
        self.valve.set_property("drop", !active);
    }

    fn is_active(&self) -> bool {
        !self.valve.property::<bool>("drop")
    }
}

impl MxlAudioOutput {
    /// S. `MxlVideoOutput::flowed_handle`.
    pub fn flowed_handle(&self) -> Arc<AtomicBool> {
        self.flowed.clone()
    }
}

impl crate::MediaFlow for MxlAudioOutput {
    fn has_flowed(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

impl Drop for MxlAudioOutput {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

/// MXL-Video-Eingang: Thread liest Grains und schiebt sie in ein `appsrc
/// do-timestamp=true` (dieselbe Rolle wie PIPELINE CONTROLLERs
/// `intervideosrc … do-timestamp=true` — verwirft die ursprüngliche
/// Grain-Herkunftszeit und stempelt stattdessen mit der Laufzeit der
/// lesenden Pipeline neu, siehe `docs/decisions.md` 2026-07-09 zur
/// offenen Timestamp-Frage), danach `videoconvert ! videoscale !
/// videorate` zur weiteren Verarbeitung durch den Aufrufer.
pub struct MxlVideoInput {
    pub tail: gst::Element,
    /// Alle von diesem Eingang selbst zur Pipeline hinzugefügten Elemente
    /// (`appsrc`/`videoconvert`/`videoscale`/`videorate` = `tail`, in
    /// Verkettungsreihenfolge) — live gefunden (Kapitel 15 Teil 3
    /// Ergänzung, `docs/decisions.md`): `Drop` setzt bislang nur das
    /// Lese-Thread-Stop-Flag, entfernt aber keines dieser vier Elemente
    /// aus der Pipeline. Unschädlich, solange jeder Aufrufer
    /// `MxlVideoInput` ausschließlich beim Abbau der **ganzen** Pipeline
    /// fallen lässt (der Bin-Dispose reißt dann alles mit) — brach aber
    /// nachweislich (unbegrenzt wachsender Speicherverbrauch, per RSS-
    /// Messung bestätigt, sogar nach nur einem einzigen Vorgang noch
    /// weiterwachsend) an der ersten Stelle, die einen einzelnen Eingang
    /// **innerhalb** einer weiterlaufenden Pipeline chirurgisch ersetzt
    /// (`omp-switcher`s Kapitel-15-Teil-3-Auflösungs-Hot-Swap). Exakt
    /// dasselbe Feld/Muster wie [`MxlAudioInput::elements`] (dortige Doku
    /// nannte dieses Bedürfnis für `omp-audio-mixer` bereits explizit,
    /// nur `MxlVideoInput` hatte es bis jetzt nicht gebraucht) — der
    /// Aufrufer ist dafür verantwortlich, bei einer chirurgischen
    /// Entfernung jedes Element hier selbst auf `Null` zu setzen und aus
    /// der Pipeline zu entfernen, nicht nur `MxlVideoInput` fallen zu
    /// lassen.
    pub elements: Vec<gst::Element>,
    running: Arc<AtomicBool>,
    flowed: Arc<AtomicBool>,
}

impl MxlVideoInput {
    pub fn new(
        pipeline: &gst::Pipeline,
        context: Arc<MxlContext>,
        flow_id: &str,
    ) -> Result<Self, String> {
        let flow_def_json = context
            .instance
            .get_flow_def(flow_id)
            .map_err(|e| format!("get_flow_def({flow_id}): {e}"))?;
        let flow_def: serde_json::Value = serde_json::from_str(&flow_def_json)
            .map_err(|e| format!("flow_def JSON parsen: {e}"))?;
        let width = flow_def["frame_width"]
            .as_u64()
            .ok_or("flow_def: frame_width fehlt")? as u32;
        let height = flow_def["frame_height"]
            .as_u64()
            .ok_or("flow_def: frame_height fehlt")? as u32;
        let framerate_numerator = flow_def["grain_rate"]["numerator"]
            .as_i64()
            .ok_or("flow_def: grain_rate.numerator fehlt")?;
        let framerate_denominator = flow_def["grain_rate"]["denominator"]
            .as_i64()
            .ok_or("flow_def: grain_rate.denominator fehlt")?;

        let appsrc = gst::ElementFactory::make("appsrc")
            .property("format", gst::Format::Time)
            .property("is-live", true)
            .property("do-timestamp", true)
            .property(
                "caps",
                video_caps(
                    width,
                    height,
                    framerate_numerator as u32,
                    framerate_denominator as u32,
                ),
            )
            .build()
            .map_err(|e| format!("appsrc: {e}"))?;
        let videoconvert = gst::ElementFactory::make("videoconvert")
            .build()
            .map_err(|e| format!("videoconvert: {e}"))?;
        let videoscale = gst::ElementFactory::make("videoscale")
            .build()
            .map_err(|e| format!("videoscale: {e}"))?;
        let videorate = gst::ElementFactory::make("videorate")
            .build()
            .map_err(|e| format!("videorate: {e}"))?;

        pipeline
            .add(&appsrc)
            .and_then(|()| pipeline.add(&videoconvert))
            .and_then(|()| pipeline.add(&videoscale))
            .and_then(|()| pipeline.add(&videorate))
            .map_err(|e| format!("add mxl input elements: {e}"))?;
        gst::Element::link_many([&appsrc, &videoconvert, &videoscale, &videorate])
            .map_err(|e| format!("link mxl input chain: {e}"))?;

        // Ab hier bereits vier Elemente im `pipeline` verankert (fremder,
        // langlebiger Owner!) — ein Fehlschlag der beiden folgenden Schritte
        // (z. B. ein Registry-GeisterEintrag: `get_flow_def` fand die
        // Metadaten noch, aber die zugehörige MXL-Shared-Memory-Flow wurde
        // per `mxl-info -g` bereits eingesammelt → "Flow not found") darf
        // sie nicht einfach über `?` verwaisen lassen: der Aufrufer
        // (`omp-video-mixer-me`/`omp-switcher` `build()`) baut bei jeder
        // Eingangsänderung die GANZE Pipeline neu, verwirft sie bei einem
        // Fehlschlag aber nicht zwingend sofort wieder — wiederholte
        // Rebuild-Versuche gegen denselben Geist-Sender akkumulieren sonst
        // unbegrenzt tote Elemente im `pipeline`-Objekt (beobachteter OOM,
        // `docs/decisions.md` 2026-07-16 "Nachtrag 2").
        let cleanup_partial = || {
            for el in [&appsrc, &videoconvert, &videoscale, &videorate] {
                let _ = el.set_state(gst::State::Null);
                let _ = pipeline.remove(el);
            }
        };

        let reader = match context.instance.create_flow_reader(flow_id) {
            Ok(r) => r,
            Err(e) => {
                cleanup_partial();
                return Err(format!("create_flow_reader({flow_id}): {e}"));
            }
        };
        let grain_reader = match reader.to_grain_reader() {
            Ok(gr) => gr,
            Err(e) => {
                cleanup_partial();
                return Err(format!("to_grain_reader: {e}"));
            }
        };
        let grain_rate = mxl_sys::Rational {
            numerator: framerate_numerator,
            denominator: framerate_denominator,
        };

        let running = Arc::new(AtomicBool::new(true));
        let running_thread = running.clone();
        let flowed = Arc::new(AtomicBool::new(false));
        let flowed_thread = flowed.clone();
        let app_src: gst_app::AppSrc = match appsrc.clone().dynamic_cast::<gst_app::AppSrc>() {
            Ok(a) => a,
            Err(_) => {
                cleanup_partial();
                return Err("appsrc: cast to AppSrc failed".to_string());
            }
        };

        thread::spawn(move || {
            read_loop(
                &context,
                grain_reader,
                &grain_rate,
                &app_src,
                &running_thread,
                &flowed_thread,
            );
        });

        Ok(MxlVideoInput {
            elements: vec![appsrc, videoconvert, videoscale, videorate.clone()],
            tail: videorate,
            running,
            flowed,
        })
    }
}

fn read_loop(
    context: &Arc<MxlContext>,
    grain_reader: mxl::GrainReader,
    grain_rate: &mxl_sys::Rational,
    app_src: &gst_app::AppSrc,
    running: &Arc<AtomicBool>,
    flowed: &Arc<AtomicBool>,
) {
    let reference_caps = tai_reference_caps();
    let mut index = context.instance.get_current_index(grain_rate);
    while running.load(Ordering::Relaxed) {
        match grain_reader.get_grain_non_blocking(index) {
            Ok(grain) => {
                let mut buffer = gst::Buffer::from_slice(grain.payload.to_vec());
                // Ursprungs-Zeitstempel als Referenz-Meta anhängen
                // (ARCHITECTURE.md §15 Punkt 4) — `do-timestamp=true`
                // oben bleibt unverändert (PTS/Pipeline-Verhalten
                // unangetastet), die Meta reist zusätzlich mit, damit ein
                // Schreibpfad weiter unten den echten Ursprung kennt statt
                // ihn wie bisher zu verwerfen.
                if let Ok(ts_ns) = context.instance.index_to_timestamp(index, grain_rate)
                    && let Some(buffer_mut) = buffer.get_mut()
                {
                    gst::ReferenceTimestampMeta::add(
                        buffer_mut,
                        &reference_caps,
                        gst::ClockTime::from_nseconds(ts_ns),
                        gst::ClockTime::NONE,
                    );
                }
                if app_src.push_buffer(buffer).is_err() {
                    break;
                }
                flowed.store(true, Ordering::Relaxed);
                index += 1;
            }
            Err(mxl::Error::OutOfRangeTooLate) => {
                // Wir sind zu weit zurück (Writer hat den Ringpuffer
                // überholt) — auf den aktuellen Head springen statt
                // endlos veraltete Indizes anzufragen.
                index = context.instance.get_current_index(grain_rate);
            }
            Err(mxl::Error::OutOfRangeTooEarly) => {
                // Noch nicht geschrieben — gleichen Index nach kurzem
                // Rust-seitigem Backoff erneut versuchen.
                //
                // Bewusst `get_grain_non_blocking` statt des blockierenden
                // `get_complete_grain` (docs/decisions.md, 2026-07-17
                // "MXL-Read-Livelock — root-caused, per Non-Blocking-Read
                // umgangen"): der blockierende Pfad ruft im vendorten C++
                // (`third_party/mxl/lib/internal/src/{Sync,
                // PosixDiscreteFlowReader}.cpp`) intern `waitUntilChanged`
                // → einen rohen `FUTEX_WAIT`-Syscall auf, der bei ≥3
                // gleichzeitigen Lesern auf demselben Flow nachweislich
                // (gdb-Backtrace aller Reader-Threads, per Diagnose-Test
                // reproduziert) über sein eigenes `timeoutNs`-Argument
                // hinaus hängen bleibt — nicht durch einen Fehler im
                // Rust-Wrapper hier, sondern *innerhalb* des Syscalls
                // selbst. Der nicht-blockierende Aufruf durchläuft diesen
                // Codepfad gar nicht erst (reine Speicher-Prüfung, kein
                // Futex/Wait), der Timeout/Poll-Rhythmus liegt komplett und
                // korrekt hier in Rust. 5ms liegen deutlich unter einer
                // Frame-Periode (40ms bei 25fps) und verzögern kein
                // tatsächlich verfügbares Grain spürbar.
                thread::sleep(Duration::from_millis(5));
            }
            Err(e) => {
                eprintln!("omp-mediaio(mxl): get_grain_non_blocking {index} failed: {e}");
                thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

impl MxlVideoInput {
    /// S. `MxlVideoOutput::flowed_handle`.
    pub fn flowed_handle(&self) -> Arc<AtomicBool> {
        self.flowed.clone()
    }
}

impl crate::MediaFlow for MxlVideoInput {
    fn has_flowed(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

impl Drop for MxlVideoInput {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

/// MXL-Audio-Eingang, Pendant zu [`MxlVideoInput`] für **continuous**-
/// Flows (s. `audio_flow_def`/`MxlAudioOutput`) — gebraucht seit
/// `omp-audio-mixer` echte externe Kanalquellen wählen kann
/// (`UMSETZUNG.md` C11, `channel.<id>.setSource`), nicht nur den
/// internen Testton. Liest per `SamplesReader::get_samples_non_blocking`
/// (nicht blockierend, Rust-seitiger 5ms-Poll-Backoff — gleicher Stil wie
/// `MxlVideoInput`s `get_grain_non_blocking`, inkl. derselben
/// `OutOfRangeTooLate`/`OutOfRangeTooEarly`-Behandlung, siehe Kommentar
/// dort) feste
/// 10ms-Batches, verkettet die pro Kanal getrennten Byte-Slices
/// (`SamplesData::channel_data`) zu einem planaren (non-interleaved)
/// Puffer und schiebt ihn in ein `appsrc`. `tail` liefert bereits
/// interleaved-gewandeltes Audio (per `audioconvert`), damit der
/// Aufrufer (Channel-Strip-Zweig in `omp-audio-mixer`) identisch zum
/// internen Testton weiterverarbeiten kann, unabhängig von der Quelle.
pub struct MxlAudioInput {
    pub tail: gst::Element,
    /// Alle von diesem Eingang selbst zur Pipeline hinzugefügten Elemente
    /// (`appsrc`/`audioconvert`/`capsfilter`, in Verkettungsreihenfolge)
    /// — anders als bei [`MxlVideoInput`] (dort baut der Aufrufer bei
    /// jeder Quellenänderung die **ganze** Pipeline neu, `omp-switcher`/
    /// `omp-video-mixer-me`, C7/C10) entfernt `omp-audio-mixer`
    /// einzelne Kanal-Zweige chirurgisch aus der laufenden Pipeline
    /// (`UMSETZUNG.md` C11) — dafür muss der Aufrufer jedes Element
    /// selbst auf `Null` setzen und aus der Pipeline entfernen können,
    /// nicht nur den Lese-Thread stoppen (das leistet `Drop` weiterhin,
    /// s. u., aber eben nicht die Pipeline-Aufräumarbeit).
    pub elements: Vec<gst::Element>,
    running: Arc<AtomicBool>,
    flowed: Arc<AtomicBool>,
}

impl MxlAudioInput {
    pub fn new(pipeline: &gst::Pipeline, context: Arc<MxlContext>, flow_id: &str) -> Result<Self, String> {
        let flow_def_json = context
            .instance
            .get_flow_def(flow_id)
            .map_err(|e| format!("get_flow_def({flow_id}): {e}"))?;
        let flow_def: serde_json::Value = serde_json::from_str(&flow_def_json)
            .map_err(|e| format!("flow_def JSON parsen: {e}"))?;
        let sample_rate = flow_def["sample_rate"]["numerator"]
            .as_u64()
            .ok_or("flow_def: sample_rate.numerator fehlt")? as u32;
        let channel_count = flow_def["channel_count"]
            .as_u64()
            .ok_or("flow_def: channel_count fehlt")? as u32;

        // Interleaved, nicht non-interleaved: `read_audio_loop` verwebt
        // die pro Kanal getrennten MXL-Bytes (`SamplesData::channel_data`)
        // unten selbst zu einem interleaved-Puffer, statt einen
        // non-interleaved-Puffer per `appsrc` einzuspeisen. Grund
        // (2026-07-11 beim ersten Testlauf gefunden, nicht vorab
        // erkannt): ein non-interleaved-`GstBuffer` braucht zwingend ein
        // begleitendes `GstAudioMeta`, das eine echte GStreamer-
        // Transformation (z. B. `audioconvert`) automatisch mitgibt, ein
        // von Hand per `Buffer::from_slice` gebauter Puffer aber nicht —
        // Folge war `gst_audio_buffer_map`-Assertion-Fehler downstream.
        // Interleaved ist der Default-Layout-Fall, der genau dieses Meta
        // nicht braucht (`MxlAudioOutput`s Schreibpfad umgeht dasselbe
        // Problem andersherum: dort erzeugt ein echter `audioconvert` den
        // non-interleaved-Puffer, nicht Handarbeit — deshalb dort nie
        // aufgefallen).
        let appsrc = gst::ElementFactory::make("appsrc")
            .property("format", gst::Format::Time)
            .property("is-live", true)
            .property("do-timestamp", true)
            .property("caps", audio_caps(sample_rate, channel_count, "interleaved"))
            .build()
            .map_err(|e| format!("appsrc: {e}"))?;
        let convert = gst::ElementFactory::make("audioconvert")
            .build()
            .map_err(|e| format!("audioconvert (input): {e}"))?;

        pipeline
            .add(&appsrc)
            .and_then(|()| pipeline.add(&convert))
            .map_err(|e| format!("add mxl audio input elements: {e}"))?;
        gst::Element::link_many([&appsrc, &convert])
            .map_err(|e| format!("link mxl audio input chain: {e}"))?;

        // Gleicher Verwaisungs-Schutz wie `MxlVideoInput::new` (s. dort) —
        // trifft hier ebenso zu, seit `omp-audio-mixer` (UMSETZUNG.md C11)
        // Audio-Sender in der Registry anmeldet, die derselben Geist-
        // Registrierung (Registry-Eintrag ohne lebende MXL-Flow) zum Opfer
        // fallen können wie Video-Sender.
        let cleanup_partial = || {
            for el in [&appsrc, &convert] {
                let _ = el.set_state(gst::State::Null);
                let _ = pipeline.remove(el);
            }
        };

        let reader = match context.instance.create_flow_reader(flow_id) {
            Ok(r) => r,
            Err(e) => {
                cleanup_partial();
                return Err(format!("create_flow_reader({flow_id}): {e}"));
            }
        };
        let samples_reader = match reader.to_samples_reader() {
            Ok(sr) => sr,
            Err(e) => {
                cleanup_partial();
                return Err(format!("to_samples_reader: {e}"));
            }
        };
        let sample_rate_r = mxl_sys::Rational {
            numerator: sample_rate as i64,
            denominator: 1,
        };
        let batch_size = (sample_rate / 100).max(1) as u64;

        let running = Arc::new(AtomicBool::new(true));
        let running_thread = running.clone();
        let flowed = Arc::new(AtomicBool::new(false));
        let flowed_thread = flowed.clone();
        let app_src: gst_app::AppSrc = match appsrc.clone().dynamic_cast::<gst_app::AppSrc>() {
            Ok(a) => a,
            Err(_) => {
                cleanup_partial();
                return Err("appsrc: cast to AppSrc failed".to_string());
            }
        };

        thread::spawn(move || {
            read_audio_loop(
                &context,
                samples_reader,
                &sample_rate_r,
                batch_size,
                &app_src,
                &running_thread,
                &flowed_thread,
            );
        });

        Ok(MxlAudioInput {
            elements: vec![appsrc, convert.clone()],
            tail: convert,
            running,
            flowed,
        })
    }
}

/// Bytes pro Sample bei `audio/float32` (32 bit = 4 Byte) — einzige
/// Audio-`media_type`, die dieser Node schreibt/liest (s.
/// `audio_flow_def`), deshalb hier fest statt aus dem Flow-Def geparst.
const BYTES_PER_SAMPLE: usize = 4;

/// Verwebt die pro Kanal getrennten MXL-Byte-Slices
/// (`SamplesData::channel_data`, je Kanal in bis zu zwei Fragmente
/// gesplittet, falls der Ringpuffer umbricht) zu einem interleaved
/// `[s0c0, s0c1, …, s1c0, s1c1, …]`-Puffer, wie ihn ein plain
/// `audio/x-raw`-Buffer ohne `GstAudioMeta` erwartet (s. Kommentar bei
/// `MxlAudioInput::new`).
fn interleave_samples(data: &mxl::SamplesData<'_>) -> Vec<u8> {
    let channels = data.num_of_channels();
    if channels == 0 {
        return Vec::new();
    }
    let Ok((d1, d2)) = data.channel_data(0) else {
        return Vec::new();
    };
    let samples_per_channel = (d1.len() + d2.len()) / BYTES_PER_SAMPLE;

    let mut buf = vec![0u8; samples_per_channel * channels * BYTES_PER_SAMPLE];
    for channel in 0..channels {
        let Ok((d1, d2)) = data.channel_data(channel) else {
            continue;
        };
        for (sample_index, sample) in d1
            .chunks_exact(BYTES_PER_SAMPLE)
            .chain(d2.chunks_exact(BYTES_PER_SAMPLE))
            .enumerate()
        {
            let dst = (sample_index * channels + channel) * BYTES_PER_SAMPLE;
            buf[dst..dst + BYTES_PER_SAMPLE].copy_from_slice(sample);
        }
    }
    buf
}

fn read_audio_loop(
    context: &Arc<MxlContext>,
    samples_reader: mxl::SamplesReader,
    sample_rate: &mxl_sys::Rational,
    batch_size: u64,
    app_src: &gst_app::AppSrc,
    running: &Arc<AtomicBool>,
    flowed: &Arc<AtomicBool>,
) {
    let reference_caps = tai_reference_caps();
    let mut index = context.instance.get_current_index(sample_rate);
    while running.load(Ordering::Relaxed) {
        match samples_reader.get_samples_non_blocking(index, batch_size as usize) {
            Ok(data) => {
                let mut buffer = gst::Buffer::from_slice(interleave_samples(&data));
                // Ursprungs-Zeitstempel des Batch-Starts als Referenz-Meta
                // (gleiches Prinzip wie im Video-Lesepfad, `read_loop`).
                if let Ok(ts_ns) = context.instance.index_to_timestamp(index, sample_rate)
                    && let Some(buffer_mut) = buffer.get_mut()
                {
                    gst::ReferenceTimestampMeta::add(
                        buffer_mut,
                        &reference_caps,
                        gst::ClockTime::from_nseconds(ts_ns),
                        gst::ClockTime::NONE,
                    );
                }
                if app_src.push_buffer(buffer).is_err() {
                    break;
                }
                flowed.store(true, Ordering::Relaxed);
                index += batch_size;
            }
            Err(mxl::Error::OutOfRangeTooLate) => {
                // Wie bei MxlVideoInputs read_loop: zu weit zurück, auf
                // den aktuellen Head springen statt endlos veraltete
                // Indizes anzufragen.
                index = context.instance.get_current_index(sample_rate);
            }
            Err(mxl::Error::OutOfRangeTooEarly) => {
                // Noch nicht geschrieben — gleichen Index nach kurzem
                // Rust-seitigem Backoff erneut versuchen. Gleicher Grund
                // wie bei `MxlVideoInput`s `read_loop`: bewusst
                // `get_samples_non_blocking` statt des blockierenden
                // `get_samples` (docs/decisions.md, 2026-07-17), das den
                // nachgewiesenen Futex-Hang im vendorten MXL-C++ bei ≥3
                // gleichzeitigen Lesern umgeht.
                thread::sleep(Duration::from_millis(5));
            }
            Err(e) => {
                eprintln!("omp-mediaio(mxl): get_samples_non_blocking {index} failed: {e}");
                thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

impl MxlAudioInput {
    /// S. `MxlVideoOutput::flowed_handle`.
    pub fn flowed_handle(&self) -> Arc<AtomicBool> {
        self.flowed.clone()
    }
}

impl crate::MediaFlow for MxlAudioInput {
    fn has_flowed(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

impl Drop for MxlAudioInput {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    //! End-to-End-Loopback-Test für C4s Verifikationsschritt: schreibt
    //! einige Frames über `MxlVideoOutput`, liest sie über einen zweiten
    //! `MxlContext` (simuliert einen zweiten Prozess, wie es
    //! `omp-viewer`/`omp-switcher` real tun würden) über `MxlVideoInput`
    //! zurück und zählt angekommene Buffer. Braucht ein gebautes
    //! `libmxl.so` im `LD_LIBRARY_PATH` (`source deploy/dev/mxl.env`) —
    //! ohne das schlägt `MxlContext::new` kontrolliert fehl statt zu
    //! hängen.
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    const TEST_FLOW_ID: &str = "6f2a9c1e-6b7d-4a3a-9c1e-6b7d4a3a9c1e";

    #[test]
    fn write_then_read_loopback() {
        gst::init().expect("gst::init");

        let domain = std::env::temp_dir().join("omp-mxl-test-domain");
        std::fs::create_dir_all(&domain).expect("create test domain dir");
        let domain = domain.to_string_lossy().to_string();

        let write_context = Arc::new(MxlContext::new(&domain).expect(
            "MxlContext::new (writer) — libmxl.so im LD_LIBRARY_PATH? source deploy/dev/mxl.env",
        ));

        let write_pipeline = gst::Pipeline::new();
        let videotestsrc = gst::ElementFactory::make("videotestsrc")
            .property("is-live", true)
            .property("num-buffers", 50i32)
            .property_from_str("pattern", "smpte")
            .build()
            .expect("videotestsrc");
        write_pipeline.add(&videotestsrc).expect("add videotestsrc");

        let _output = MxlVideoOutput::new(
            &write_pipeline,
            &videotestsrc,
            write_context,
            TEST_FLOW_ID,
            "omp-mediaio loopback test",
            640,
            480,
            25,
            1,
        )
        .expect("MxlVideoOutput::new");
        _output.set_active(true);

        write_pipeline
            .set_state(gst::State::Playing)
            .expect("write pipeline playing");

        // Dem Writer-Thread etwas Zeit geben, den Flow anzulegen und ein
        // paar Grains zu schreiben, bevor der Reader aufmacht.
        std::thread::sleep(Duration::from_millis(500));

        let read_context = Arc::new(MxlContext::new(&domain).expect("MxlContext::new (reader)"));
        let read_pipeline = gst::Pipeline::new();
        let input = MxlVideoInput::new(&read_pipeline, read_context, TEST_FLOW_ID)
            .expect("MxlVideoInput::new");
        let fakesink = gst::ElementFactory::make("fakesink")
            .property("sync", false)
            .build()
            .expect("fakesink");
        read_pipeline.add(&fakesink).expect("add fakesink");
        input.tail.link(&fakesink).expect("link tail to fakesink");

        let received = Arc::new(AtomicU32::new(0));
        let received_probe = received.clone();
        fakesink
            .static_pad("sink")
            .expect("fakesink sink pad")
            .add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
                received_probe.fetch_add(1, Ordering::Relaxed);
                gst::PadProbeReturn::Ok
            });

        read_pipeline
            .set_state(gst::State::Playing)
            .expect("read pipeline playing");

        std::thread::sleep(Duration::from_secs(3));

        write_pipeline
            .set_state(gst::State::Null)
            .expect("write pipeline null");
        read_pipeline
            .set_state(gst::State::Null)
            .expect("read pipeline null");

        assert!(
            received.load(Ordering::Relaxed) > 0,
            "expected at least one buffer to arrive at the reader's fakesink via MXL"
        );
    }

    /// Regressionstest für den echten Produktionspfad (`MxlVideoInput::new`
    /// → `read_loop`, über GStreamer/`appsrc`, nicht die rohen `mxl`-Crate-
    /// Aufrufe wie `three_readers_livelock_diagnostic`): drei unabhängige
    /// `MxlVideoInput`s (eigener `MxlContext` je Instanz, wie
    /// `omp-video-mixer-me`s fg/bg/pst-Zweige es real täten) lesen
    /// gleichzeitig denselben Flow. Vor dem `get_grain_non_blocking`-Fix
    /// (docs/decisions.md 2026-07-17) hing dieses Szenario zuverlässig
    /// (siehe `three_readers_livelock_diagnostic`); dieser Test muss
    /// innerhalb der festen Sleep-Dauer fertig werden (kein offenes
    /// Polling, kein `#[ignore]` nötig) und alle drei Leser müssen Frames
    /// bekommen haben.
    #[test]
    fn three_concurrent_readers_same_flow_do_not_hang() {
        gst::init().expect("gst::init");

        let domain = std::env::temp_dir().join("omp-mxl-test-domain-three-readers");
        let _ = std::fs::remove_dir_all(&domain);
        std::fs::create_dir_all(&domain).expect("create test domain dir");
        let domain = domain.to_string_lossy().to_string();

        const FLOW_ID: &str = "c2f66b0d-3333-4a3a-9c1e-6b7d4a3a9c1e";

        let write_context = Arc::new(MxlContext::new(&domain).expect("MxlContext::new (writer)"));
        let write_pipeline = gst::Pipeline::new();
        let videotestsrc = gst::ElementFactory::make("videotestsrc")
            .property("is-live", true)
            .property("num-buffers", 250i32) // ~10s bei 25fps
            .property_from_str("pattern", "smpte")
            .build()
            .expect("videotestsrc");
        write_pipeline.add(&videotestsrc).expect("add videotestsrc");
        let _output = MxlVideoOutput::new(
            &write_pipeline,
            &videotestsrc,
            write_context,
            FLOW_ID,
            "omp-mediaio three-readers test",
            640,
            480,
            25,
            1,
        )
        .expect("MxlVideoOutput::new");
        _output.set_active(true);
        write_pipeline
            .set_state(gst::State::Playing)
            .expect("write pipeline playing");

        thread::sleep(Duration::from_millis(500));

        struct ReaderHandle {
            _pipeline: gst::Pipeline,
            // Muss am Leben bleiben: `MxlVideoInput::drop` setzt
            // `running=false`, was den `read_loop`-Thread sofort beendet.
            _input: MxlVideoInput,
            received: Arc<AtomicU32>,
        }

        let readers: Vec<ReaderHandle> = (0..3)
            .map(|i| {
                let read_context =
                    Arc::new(MxlContext::new(&domain).expect("MxlContext::new (reader)"));
                let read_pipeline = gst::Pipeline::new();
                let input = MxlVideoInput::new(&read_pipeline, read_context, FLOW_ID)
                    .expect("MxlVideoInput::new");
                let fakesink = gst::ElementFactory::make("fakesink")
                    .property("sync", false)
                    .build()
                    .expect("fakesink");
                read_pipeline.add(&fakesink).expect("add fakesink");
                input.tail.link(&fakesink).expect("link tail to fakesink");

                let received = Arc::new(AtomicU32::new(0));
                let received_probe = received.clone();
                fakesink
                    .static_pad("sink")
                    .expect("fakesink sink pad")
                    .add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
                        received_probe.fetch_add(1, Ordering::Relaxed);
                        gst::PadProbeReturn::Ok
                    });

                read_pipeline
                    .set_state(gst::State::Playing)
                    .unwrap_or_else(|e| panic!("read pipeline {i} playing: {e}"));

                ReaderHandle {
                    _pipeline: read_pipeline,
                    _input: input,
                    received,
                }
            })
            .collect();

        // Feste, bewusst kurze Wartezeit statt Polling: vor dem Fix wäre
        // dieser Test nie an diesen Punkt gekommen (Prozess hängt in
        // read_loop -> get_complete_grain, weit über jede sinnvolle
        // Sleep-Dauer hinaus, s. `three_readers_livelock_diagnostic`).
        thread::sleep(Duration::from_secs(5));

        write_pipeline
            .set_state(gst::State::Null)
            .expect("write pipeline null");

        for (i, r) in readers.iter().enumerate() {
            r._pipeline
                .set_state(gst::State::Null)
                .unwrap_or_else(|e| panic!("read pipeline {i} null: {e}"));
        }

        let counts: Vec<u32> = readers
            .iter()
            .map(|r| r.received.load(Ordering::Relaxed))
            .collect();
        println!("received counts: {counts:?}");
        for (i, count) in counts.iter().enumerate() {
            assert!(
                *count > 0,
                "reader {i} received no frames — three concurrent readers on the same flow \
                 must all flow independently (all counts: {counts:?})"
            );
        }
    }

    /// Verifiziert den in `read_loop`/`write_loop` genutzten Mechanismus
    /// (ARCHITECTURE.md §15 Punkt 4, nachgezogen 2026-07-12) direkt auf
    /// Buffer-Ebene, ohne eine volle Zwei-Prozess-Pipeline: ein Index,
    /// über `index_to_timestamp` in eine TAI-Zeit gewandelt und als
    /// `ReferenceTimestampMeta` angehängt, muss über
    /// `origin_index_from_buffer` unverändert zurückkommen.
    #[test]
    fn origin_timestamp_meta_round_trips_to_same_index() {
        gst::init().expect("gst::init");

        let domain = std::env::temp_dir().join("omp-mxl-test-domain-origin");
        std::fs::create_dir_all(&domain).expect("create test domain dir");
        let domain = domain.to_string_lossy().to_string();

        let context = Arc::new(MxlContext::new(&domain).expect(
            "MxlContext::new — libmxl.so im LD_LIBRARY_PATH? source deploy/dev/mxl.env",
        ));
        let rate = mxl_sys::Rational {
            numerator: 25,
            denominator: 1,
        };
        let origin_index = context.instance.get_current_index(&rate) + 1000;
        let ts = context
            .instance
            .index_to_timestamp(origin_index, &rate)
            .expect("index_to_timestamp");

        let reference_caps = tai_reference_caps();
        let mut buffer = gst::Buffer::from_slice(vec![0u8; 4]);
        gst::ReferenceTimestampMeta::add(
            buffer.get_mut().expect("exclusive buffer"),
            &reference_caps,
            gst::ClockTime::from_nseconds(ts),
            gst::ClockTime::NONE,
        );

        let recovered = origin_index_from_buffer(&context, &buffer, &reference_caps, &rate);
        assert_eq!(
            recovered,
            Some(origin_index),
            "origin index should round-trip through the reference-timestamp meta unchanged"
        );
    }

    /// Ein Buffer ohne die Meta (z. B. ein Mixer-/Testquellen-Ausgang,
    /// der per Definition einen neuen Ursprung setzt) muss `None` liefern,
    /// damit der Aufrufer sauber auf das bisherige Zähler-Verhalten
    /// zurückfällt (`write_loop`/`write_audio_loop`).
    #[test]
    fn origin_index_from_buffer_returns_none_without_meta() {
        gst::init().expect("gst::init");

        let domain = std::env::temp_dir().join("omp-mxl-test-domain-origin-none");
        std::fs::create_dir_all(&domain).expect("create test domain dir");
        let domain = domain.to_string_lossy().to_string();

        let context = Arc::new(
            MxlContext::new(&domain).expect("MxlContext::new"),
        );
        let rate = mxl_sys::Rational {
            numerator: 25,
            denominator: 1,
        };
        let reference_caps = tai_reference_caps();
        let buffer = gst::Buffer::from_slice(vec![0u8; 4]);

        assert_eq!(
            origin_index_from_buffer(&context, &buffer, &reference_caps, &rate),
            None,
            "a buffer without the meta must fall back to None (caller uses the counter-based index)"
        );
    }

    /// Diagnose-Test für den in `docs/decisions.md` (2026-07-10 "C8",
    /// 2026-07-16 "Nachtrag 2") dokumentierten MXL-Read-Livelock: schreibt
    /// ~16s Frames auf einen Flow und liest ihn gleichzeitig mit drei
    /// unabhängigen `MxlContext`s (simuliert drei getrennte Prozesse, wie
    /// `omp-video-mixer-me`s fg/bg/pst-Zweige es real täten) — exakt der
    /// Loop-Stil aus `read_loop` oben. Statt auf Erfolg/Fehlschlag zu
    /// prüfen, misst er die Wanduhrzeit jedes einzelnen
    /// `get_complete_grain`-Aufrufs: bleibt einer davon deutlich über dem
    /// übergebenen 500ms-Timeout hängen, ist das der direkte Beweis für das
    /// TOCTOU-Fenster in `waitUntilChanged`/`getGrain`
    /// (vendored `third_party/mxl/lib/internal/src/{Sync,
    /// PosixDiscreteFlowReader}.cpp`) — nicht nur eine Vermutung.
    /// `#[ignore]`, weil er ~16s läuft; gezielt aufrufen mit
    /// `cargo test --release -p omp-mediaio -- --ignored --nocapture
    /// three_readers_livelock_diagnostic`.
    #[test]
    #[ignore]
    fn three_readers_livelock_diagnostic() {
        gst::init().expect("gst::init");

        let domain = std::env::temp_dir().join("omp-mxl-test-domain-livelock");
        let _ = std::fs::remove_dir_all(&domain);
        std::fs::create_dir_all(&domain).expect("create test domain dir");
        let domain = domain.to_string_lossy().to_string();

        const FLOW_ID: &str = "b1e55a9c-1234-4d3e-9a1a-1234567890ab";
        const FRAME_MS: u64 = 40; // 25fps
        const WRITER_FRAMES: u64 = 400; // ~16s
        const READER_COUNT: usize = 3;
        const READ_TIMEOUT: Duration = Duration::from_millis(500);
        // Deutlich über READ_TIMEOUT: jeder einzelne Aufruf, der länger
        // braucht, kann nicht mehr durch legitimes Blockieren bis zum
        // Timeout erklärt werden.
        const HANG_THRESHOLD: Duration = Duration::from_millis(1500);

        let write_context = Arc::new(MxlContext::new(&domain).expect("MxlContext::new (writer)"));
        let rate = mxl_sys::Rational {
            numerator: 25,
            denominator: 1,
        };
        let flow_def = video_flow_def(FLOW_ID, "livelock-diagnostic", 640, 480, 25, 1);
        let (writer, _config, _was_created) = write_context
            .instance
            .create_flow_writer(&flow_def, None)
            .expect("create_flow_writer");
        let grain_writer = writer.to_grain_writer().expect("to_grain_writer");

        let writer_handle = thread::spawn(move || {
            let mut index = write_context.instance.get_current_index(&rate);
            for _ in 0..WRITER_FRAMES {
                match grain_writer.open_grain(index) {
                    Ok(mut access) => {
                        let payload = access.payload_mut();
                        payload.fill((index % 256) as u8);
                        let total_slices = access.total_slices();
                        if let Err(e) = access.commit(total_slices) {
                            eprintln!("[writer] commit {index} failed: {e}");
                        }
                    }
                    Err(e) => eprintln!("[writer] open_grain {index} failed: {e}"),
                }
                index += 1;
                thread::sleep(Duration::from_millis(FRAME_MS));
            }
        });

        // Schreiber etwas Vorlauf geben, wie im übrigen Test-Stil dieser
        // Datei.
        thread::sleep(Duration::from_millis(300));

        struct ReaderStats {
            id: usize,
            calls: u64,
            grains_received: u64,
            max_call_elapsed: Duration,
            hangs: Vec<(u64, Duration)>, // (call-index, elapsed) über HANG_THRESHOLD
        }

        let domain_for_readers = domain.clone();
        let reader_handles: Vec<_> = (0..READER_COUNT)
            .map(|id| {
                let domain = domain_for_readers.clone();
                thread::spawn(move || -> ReaderStats {
                    let context = MxlContext::new(&domain).expect("MxlContext::new (reader)");
                    let reader = context
                        .instance
                        .create_flow_reader(FLOW_ID)
                        .expect("create_flow_reader");
                    let grain_reader = reader.to_grain_reader().expect("to_grain_reader");

                    let mut stats = ReaderStats {
                        id,
                        calls: 0,
                        grains_received: 0,
                        max_call_elapsed: Duration::ZERO,
                        hangs: Vec::new(),
                    };
                    let mut index = context.instance.get_current_index(&rate);
                    // Etwas mehr Versuche als der Writer Frames schreibt,
                    // damit ein Reader, der ein paar Mal ins Leere pollt,
                    // trotzdem fertig wird, aber klar begrenzt bleibt.
                    let max_calls = WRITER_FRAMES * 3 + 200;

                    while stats.calls < max_calls {
                        let call_start = std::time::Instant::now();
                        let result = grain_reader.get_complete_grain(index, READ_TIMEOUT);
                        let elapsed = call_start.elapsed();
                        stats.calls += 1;
                        if elapsed > stats.max_call_elapsed {
                            stats.max_call_elapsed = elapsed;
                        }
                        if elapsed > HANG_THRESHOLD {
                            stats.hangs.push((stats.calls, elapsed));
                        }

                        match result {
                            Ok(_grain) => {
                                stats.grains_received += 1;
                                index += 1;
                            }
                            Err(mxl::Error::OutOfRangeTooLate) => {
                                index = context.instance.get_current_index(&rate);
                            }
                            Err(mxl::Error::Timeout | mxl::Error::OutOfRangeTooEarly) => {
                                thread::sleep(Duration::from_millis(5));
                            }
                            Err(_e) => {
                                thread::sleep(Duration::from_millis(200));
                            }
                        }
                    }
                    stats
                })
            })
            .collect();

        writer_handle.join().expect("writer thread panicked");

        // Den Lesern nach Schreib-Ende noch kurz Zeit geben, ihre letzten
        // Aufrufe regulär (per Timeout) zu beenden.
        let all_stats: Vec<ReaderStats> = reader_handles
            .into_iter()
            .map(|h| h.join().expect("reader thread panicked"))
            .collect();

        let mut any_hang = false;
        for s in &all_stats {
            println!(
                "[reader {}] calls={} grains_received={} max_call_elapsed={:?} hangs={:?}",
                s.id, s.calls, s.grains_received, s.max_call_elapsed, s.hangs
            );
            if !s.hangs.is_empty() {
                any_hang = true;
            }
        }

        if any_hang {
            println!(
                "LIVELOCK REPRODUCED: at least one get_complete_grain() call exceeded {:?} \
                 despite a requested timeout of {:?} — confirms the TOCTOU deadline-skip in \
                 vendored MXL C++ (waitUntilChanged / PosixDiscreteFlowReader::getGrain).",
                HANG_THRESHOLD, READ_TIMEOUT
            );
        } else {
            println!(
                "No call exceeded {:?} in this run ({} readers, {} writer frames) — livelock is \
                 timing-dependent, did not trigger this time.",
                HANG_THRESHOLD, READER_COUNT, WRITER_FRAMES
            );
        }
    }
}
