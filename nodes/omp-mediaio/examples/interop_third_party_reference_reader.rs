//! **DMF/MXL-Interop-Test** (Nutzerauftrag 2026-09-15, im Anschluss an
//! die Recherche zu einer herstellerübergreifenden DMF/MXL-Interop-
//! Demo auf der IBC 2026: "können wir kommerzielle MXL-Microservices
//! von Drittanbietern nutzen?"): weist
//! nach, dass OMPs eigener Produktions-Lesepfad (`MxlVideoInput`/
//! `MxlAudioInput`, exakt derselbe Code, den jeder MXL-lesende OMP-Node
//! nutzt) Grains lesen kann, die **NICHT** von OMP geschrieben wurden —
//! sondern vom rohen, unabhängigen C++-Referenzwerkzeug `mxl-gst-
//! testsrc` aus demselben `dmf-mxl/mxl`-Repo (third_party/mxl/tools/
//! mxl-gst/testsrc.cpp), das über KEINEN OMP-Code läuft, nur über
//! dieselbe MXL-Domain/-Bibliothek.
//!
//! Das ist der zweitbeste verfügbare Stand-in für "ein echtes
//! Drittanbieter-Produkt" (Hersteller-Binaries liegen hier nicht vor):
//! zwei komplett unabhängige Code-Pfade — OMPs
//! Rust-`mxl`/`mxl-sys`-Bindung hier, das MXL-Projekt-eigene C++
//! `mxl-gst-testsrc` dort —, die beide direkt gegen dieselbe offene
//! `libmxl.so`/Domain-Struktur bauen, genau wie es ein
//! Hersteller-Produkt mit "nativer MXL-Unterstützung" auch täte.
//!
//! Aufruf (Domain vorher per `mxl-gst-testsrc` befüllen, s.
//! `docs/decisions.md` Nachtrag 227 für das vollständige Rezept):
//!   OMP_MXL_DOMAIN=/dev/shm/omp-mxl-interop-test \
//!   cargo run --package omp-mediaio --example interop_third_party_reference_reader \
//!     --features "mxl preview" -- <video-flow-id> <frame-count>

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use omp_mediaio::mxl::{MxlContext, MxlVideoInput};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let flow_id = args.get(1).cloned().unwrap_or_else(|| {
        eprintln!("usage: interop_third_party_reference_reader <video-flow-id> [frame-count=25]");
        std::process::exit(2);
    });
    let want_frames: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(25);
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/omp-mxl".to_string());

    gst::init().expect("gst::init");

    println!("== OMP-Lesepfad (MxlVideoInput) liest Flow {flow_id} aus Domain {domain} ==");
    println!("   (dieser Flow wurde vom unabhängigen C++-Referenzwerkzeug mxl-gst-testsrc geschrieben, NICHT von OMP)");

    let context = Arc::new(MxlContext::new(&domain).expect("MxlContext::new"));
    let pipeline = gst::Pipeline::new();
    // Exakt dieselbe Konstruktion, die jeder OMP-Node beim Verbinden
    // eines Video-Receivers durchläuft (s. omp-viewer/omp-scope
    // video_pipeline.rs) — liest die echte, vom Fremd-Schreiber
    // deklarierte flow_def, baut appsrc+videoconvert/videoscale/
    // videorate intern auf.
    let input = MxlVideoInput::new(&pipeline, context.clone(), &flow_id).expect("MxlVideoInput::new — konnte den fremd-geschriebenen Flow nicht öffnen");

    let sink = gst::ElementFactory::make("appsink")
        .property("sync", false)
        .property("async", false)
        .property("max-buffers", 2u32)
        .property("drop", true)
        .build()
        .expect("appsink");
    pipeline.add(&sink).expect("add sink");
    gst::Element::link_many([&input.tail, &sink]).expect("link tail -> sink");

    let received = Arc::new(AtomicBool::new(false));
    let received_probe = received.clone();
    let frame_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let frame_count_cb = frame_count.clone();
    let app_sink: gst_app::AppSink = sink.dynamic_cast().expect("cast to AppSink");
    app_sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |s| {
                let sample = s.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                received_probe.store(true, Ordering::Relaxed);
                let n = frame_count_cb.fetch_add(1, Ordering::Relaxed) + 1;
                if let Some(caps) = sample.caps()
                    && let Some(st) = caps.structure(0)
                {
                    let w: i32 = st.get("width").unwrap_or(-1);
                    let h: i32 = st.get("height").unwrap_or(-1);
                    if n == 1 {
                        println!("   erstes Bild von mxl-gst-testsrc gelesen: {w}x{h} (Analyse-Caps nach OMPs interner Skalierung)");
                    }
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    pipeline.set_state(gst::State::Playing).expect("set state playing");

    let bus = pipeline.bus().expect("bus");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while frame_count.load(Ordering::Relaxed) < want_frames && std::time::Instant::now() < deadline {
        if let Some(msg) = bus.timed_pop_filtered(gst::ClockTime::from_mseconds(200), &[gst::MessageType::Error])
            && let gst::MessageView::Error(e) = msg.view()
        {
            eprintln!("PIPELINE-FEHLER: {} ({:?})", e.error(), e.debug());
            std::process::exit(1);
        }
    }

    let n = frame_count.load(Ordering::Relaxed);
    let _ = pipeline.set_state(gst::State::Null);

    if received.load(Ordering::Relaxed) {
        println!("== ERFOLG: {n} Bild(er) über OMPs eigenen Produktions-Lesepfad aus einem fremd-geschriebenen Flow gelesen ==");
        std::process::exit(0);
    } else {
        eprintln!("== FEHLSCHLAG: kein einziges Bild empfangen (Timeout nach 10s) ==");
        std::process::exit(1);
    }
}
