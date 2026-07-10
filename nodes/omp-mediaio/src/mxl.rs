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
        let valve = gst::ElementFactory::make("valve")
            .name("mxl_output_valve")
            .property("drop", true)
            .build()
            .map_err(|e| format!("valve: {e}"))?;
        let appsink = gst::ElementFactory::make("appsink")
            .property("sync", false)
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

        let flow_def = video_flow_def(
            flow_id,
            label,
            width,
            height,
            framerate_numerator,
            framerate_denominator,
        );
        let (writer, _config, was_created) = context
            .instance
            .create_flow_writer(&flow_def, None)
            .map_err(|e| format!("create_flow_writer: {e}"))?;
        if !was_created {
            eprintln!("omp-mediaio(mxl): reusing existing flow {flow_id}");
        }
        let grain_writer = writer
            .to_grain_writer()
            .map_err(|e| format!("to_grain_writer: {e}"))?;

        let grain_rate = mxl_sys::Rational {
            numerator: framerate_numerator as i64,
            denominator: framerate_denominator as i64,
        };

        let running = Arc::new(AtomicBool::new(true));
        let running_thread = running.clone();
        let app_sink: gst_app::AppSink = appsink
            .clone()
            .dynamic_cast::<gst_app::AppSink>()
            .map_err(|_| "appsink: cast to AppSink failed".to_string())?;

        thread::spawn(move || {
            write_loop(
                &context,
                grain_writer,
                &grain_rate,
                &app_sink,
                &running_thread,
            );
        });

        Ok(MxlVideoOutput { valve, running })
    }
}

fn write_loop(
    context: &Arc<MxlContext>,
    grain_writer: mxl::GrainWriter,
    grain_rate: &mxl_sys::Rational,
    app_sink: &gst_app::AppSink,
    running: &Arc<AtomicBool>,
) {
    let mut index: Option<u64> = None;
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

        let this_index =
            *index.get_or_insert_with(|| context.instance.get_current_index(grain_rate));

        match grain_writer.open_grain(this_index) {
            Ok(mut access) => {
                let payload = access.payload_mut();
                let n = payload.len().min(map.as_slice().len());
                payload[..n].copy_from_slice(&map.as_slice()[..n]);
                let total_slices = access.total_slices();
                if let Err(e) = access.commit(total_slices) {
                    eprintln!("omp-mediaio(mxl): commit grain {this_index} failed: {e}");
                }
            }
            Err(e) => {
                eprintln!("omp-mediaio(mxl): open_grain {this_index} failed: {e}");
            }
        }

        index = Some(this_index + 1);
    }
}

impl Output for MxlVideoOutput {
    fn set_active(&self, active: bool) {
        self.valve.set_property("drop", !active);
    }

    fn is_active(&self) -> bool {
        !self.valve.property::<bool>("drop")
    }
}

impl Drop for MxlVideoOutput {
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
    running: Arc<AtomicBool>,
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

        let reader = context
            .instance
            .create_flow_reader(flow_id)
            .map_err(|e| format!("create_flow_reader({flow_id}): {e}"))?;
        let grain_reader = reader
            .to_grain_reader()
            .map_err(|e| format!("to_grain_reader: {e}"))?;
        let grain_rate = mxl_sys::Rational {
            numerator: framerate_numerator,
            denominator: framerate_denominator,
        };

        let running = Arc::new(AtomicBool::new(true));
        let running_thread = running.clone();
        let app_src: gst_app::AppSrc = appsrc
            .clone()
            .dynamic_cast::<gst_app::AppSrc>()
            .map_err(|_| "appsrc: cast to AppSrc failed".to_string())?;

        thread::spawn(move || {
            read_loop(
                &context,
                grain_reader,
                &grain_rate,
                &app_src,
                &running_thread,
            );
        });

        Ok(MxlVideoInput {
            tail: videorate,
            running,
        })
    }
}

fn read_loop(
    context: &Arc<MxlContext>,
    grain_reader: mxl::GrainReader,
    grain_rate: &mxl_sys::Rational,
    app_src: &gst_app::AppSrc,
    running: &Arc<AtomicBool>,
) {
    let mut index = context.instance.get_current_index(grain_rate);
    while running.load(Ordering::Relaxed) {
        match grain_reader.get_complete_grain(index, Duration::from_millis(500)) {
            Ok(grain) => {
                let buffer = gst::Buffer::from_slice(grain.payload.to_vec());
                if app_src.push_buffer(buffer).is_err() {
                    break;
                }
                index += 1;
            }
            Err(mxl::Error::OutOfRangeTooLate) => {
                // Wir sind zu weit zurück (Writer hat den Ringpuffer
                // überholt) — auf den aktuellen Head springen statt
                // endlos veraltete Indizes anzufragen.
                index = context.instance.get_current_index(grain_rate);
            }
            Err(mxl::Error::Timeout | mxl::Error::OutOfRangeTooEarly) => {
                // Noch nicht geschrieben — gleichen Index erneut versuchen.
                // Kurzer Backoff statt sofortigem Retry, als Teilschutz
                // gegen ein bekanntes TOCTOU-Fenster in MXLs eigener
                // `waitUntilChanged` (vendored C++, lib/internal/src/
                // Sync.cpp): committet der Writer zwischen dem Lesen des
                // Sync-Zählers und dem eigentlichen Futex-Wait erneut,
                // kehrt der Aufruf sofort zurück, ohne tatsächlich zu
                // warten.
                //
                // **Behebt NICHT den in der Praxis beobachteten
                // Extremfall** (docs/decisions.md, 2026-07-10 "C8 —
                // MXL-Read-Livelock"): dort steckt die Retry-Schleife
                // bereits *innerhalb* des einzelnen `get_complete_grain`-
                // FFI-Aufrufs (C++-eigenes `while(true)` in `getGrain`,
                // das bei `OUT_OF_RANGE_TOO_EARLY` selbst erneut
                // `getGrainImpl` aufruft) — die Kontrolle kommt in diesem
                // Fall über Minuten hinweg gar nicht zu diesem Rust-Codepfad
                // zurück, weshalb der Sleep hier nichts bewirkt (per
                // `/proc/<pid>/task/*/stat` verifiziert: ein Thread bleibt
                // bei ~100% CPU, "Last read time" des Flows friert dauerhaft
                // ein). Bleibt trotzdem stehen, weil er den harmloseren
                // Fall (Aufruf kehrt normal mit `Timeout`/
                // `OutOfRangeTooEarly` zurück) korrekt entschärft — 5ms
                // liegen deutlich unter einer Frame-Periode (40ms bei
                // 25fps) und verzögern kein tatsächlich verfügbares Grain
                // spürbar. Der Extremfall braucht entweder einen Patch im
                // vendorten MXL-C++ oder eine Rust-seitige Umgehung (z. B.
                // "neuestes verfügbares Grain" statt strikt sequenziellem
                // Index pollen) — nicht in diesem Schritt behoben, siehe
                // Decisions-Eintrag.
                thread::sleep(Duration::from_millis(5));
            }
            Err(e) => {
                eprintln!("omp-mediaio(mxl): get_complete_grain {index} failed: {e}");
                thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

impl Drop for MxlVideoInput {
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
}
