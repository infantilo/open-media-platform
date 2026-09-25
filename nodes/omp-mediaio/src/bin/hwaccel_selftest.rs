//! Eigenständiges Helfer-Binary für `omp_mediaio::hwaccel::probe()`
//! (Bugliste 2026-09-25 #7, "alle GStreamer-Pipelines müssen beim Start
//! schauen, ob eine GPU zur Verfügung steht"): baut+startet die exakt zu
//! prüfende Mini-Pipeline für einen GPU-Kandidaten in einem EIGENEN
//! Prozess.
//!
//! **Warum ein eigener Prozess, nicht einfach ein Funktionsaufruf in der
//! Bibliothek?** Live gefunden (2026-09-25, virtio-gpu/virgl-Treiber,
//! typisch für Entwicklungsumgebungen wie Crostini): `vaapipostproc`
//! lädt anstandslos und verhandelt Caps korrekt — SEGFAULTET aber
//! zuverlässig, sobald es tatsächlich eine Formatkonvertierung oder
//! Skalierung durchführen soll (per `gst-launch-1.0` bestätigt: reines
//! Passthrough — identisches Format UND identische Größe — lief
//! einwandfrei, sowohl reine Konvertierung als auch reine Skalierung
//! rissen die gesamte Pipeline sofort mit runter). Ein solcher Absturz
//! IN-PROCESS würde den aufrufenden Node beim Start mitreißen, bevor er
//! überhaupt seine eigentliche Arbeit aufnehmen kann — der einzige
//! sichere Weg, "funktioniert das wirklich" zu prüfen, ist ein
//! wegwerfbarer Subprozess, dessen Absturz `omp_mediaio::hwaccel::
//! probe()` (per Exit-Code ungleich 0 bzw. per Timeout+`SIGKILL`, falls
//! er wie hier auf `gst-launch-1.0` beobachtet nach einem Absturz erst
//! einmal "spinnt" statt sofort zu beenden) sauber als "nicht nutzbar"
//! wertet, ohne selbst betroffen zu sein.
//!
//! Aufruf: `omp-mediaio-hwaccel-selftest <candidate>` — Exit 0 = der
//! Kandidat funktioniert auf diesem Host nachweislich, jeder andere
//! Exit-Code (oder gar kein sauberes Beenden) = nicht nutzbar.

use gstreamer as gst;
use gst::prelude::*;

fn main() {
    let candidate = std::env::args().nth(1).unwrap_or_default();
    let ok = match candidate.as_str() {
        "vaapipostproc" => test_vaapipostproc(),
        _ => false,
    };
    std::process::exit(if ok { 0 } else { 1 });
}

/// Repräsentativer Testfall: ANDERE Auflösung UND ANDERES Format
/// zwischen Ein- und Ausgang — bewusst NICHT nur Passthrough (identisches
/// Format+Größe), das hätte den live gefundenen Absturz auf virtio-gpu/
/// virgl verpasst (s. Moduldoku).
fn test_vaapipostproc() -> bool {
    if gst::init().is_err() {
        return false;
    }

    let build = || -> Result<gst::Pipeline, String> {
        let pipeline = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc")
            .property("num-buffers", 2i32)
            .build()
            .map_err(|e| e.to_string())?;
        let src_caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field("format", "I420")
                    .field("width", 640i32)
                    .field("height", 480i32)
                    .field("framerate", gst::Fraction::new(25, 1))
                    .build(),
            )
            .build()
            .map_err(|e| e.to_string())?;
        let postproc = gst::ElementFactory::make("vaapipostproc").build().map_err(|e| e.to_string())?;
        let out_caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("video/x-raw")
                    .field("format", "RGBA")
                    .field("width", 320i32)
                    .field("height", 240i32)
                    .field("framerate", gst::Fraction::new(25, 1))
                    .build(),
            )
            .build()
            .map_err(|e| e.to_string())?;
        let sink = gst::ElementFactory::make("fakesink").build().map_err(|e| e.to_string())?;

        pipeline
            .add(&src)
            .and_then(|()| pipeline.add(&src_caps))
            .and_then(|()| pipeline.add(&postproc))
            .and_then(|()| pipeline.add(&out_caps))
            .and_then(|()| pipeline.add(&sink))
            .map_err(|e| e.to_string())?;
        gst::Element::link_many([&src, &src_caps, &postproc, &out_caps, &sink]).map_err(|e| e.to_string())?;
        Ok(pipeline)
    };

    let pipeline = match build() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let Some(bus) = pipeline.bus() else { return false };
    if pipeline.set_state(gst::State::Playing).is_err() {
        return false;
    }
    let result = bus.timed_pop_filtered(gst::ClockTime::from_seconds(5), &[gst::MessageType::Eos, gst::MessageType::Error]);
    let _ = pipeline.set_state(gst::State::Null);
    matches!(result.as_ref().map(|m| m.view()), Some(gst::MessageView::Eos(_)))
}
