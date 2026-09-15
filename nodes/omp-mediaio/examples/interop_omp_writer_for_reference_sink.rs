//! **DMF/MXL-Interop-Test, Gegenrichtung** zu
//! `interop_third_party_reference_reader`: schreibt einen echten
//! Video-Flow über OMPs eigenen Produktions-Schreibpfad
//! (`MxlVideoOutput`, derselbe Code wie `omp-source`) und hält ihn
//! offen, damit ein unabhängiges Werkzeug (`mxl-info`, `mxl-gst-sink`
//! — beide aus dem `dmf-mxl/mxl`-Repo, kein OMP-Code) ihn von außen
//! lesen kann. S. `docs/decisions.md` Nachtrag 227 für das
//! Gesamtergebnis.
//!
//! Aufruf:
//!   OMP_MXL_DOMAIN=/dev/shm/omp-mxl-interop-test \
//!   cargo run --package omp-mediaio --example interop_omp_writer_for_reference_sink --features mxl -- \
//!     <video-flow-id>
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlContext, MxlVideoOutput};

fn main() {
    let flow_id = std::env::args().nth(1).expect("usage: interop_omp_writer_for_reference_sink <video-flow-id>");
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/omp-mxl".to_string());

    gst::init().expect("gst::init");
    let context = Arc::new(MxlContext::new(&domain).expect("MxlContext::new"));

    let pipeline = gst::Pipeline::new();
    let src = gst::ElementFactory::make("videotestsrc")
        .property_from_str("pattern", "ball")
        .property("is-live", true)
        .build()
        .expect("videotestsrc");
    pipeline.add(&src).expect("add src");

    let output = MxlVideoOutput::new(
        &pipeline,
        &src,
        context,
        &flow_id,
        "IBC-Interop-Test (OMP-Produktions-Schreibpfad, fuer unabhaengiges mxl-info/mxl-gst-sink)",
        1920,
        1080,
        30000,
        1001,
        Arc::new(AtomicU64::new(0)),
    )
    .expect("MxlVideoOutput::new");

    pipeline.set_state(gst::State::Playing).expect("set state playing");
    // `MxlVideoOutput` baut das intern verwendete `valve`-Element bewusst
    // GESCHLOSSEN auf (`drop=true`) — jeder echte OMP-Node aktiviert seinen
    // Ausgang erst explizit über das `Output`-Trait (IS-05-Start), s.
    // `mxl.rs`s `set_active`. Ohne diesen Aufruf bleibt der Flow zwar
    // angelegt, aber für immer bei `head_index=0` — live an genau diesem
    // Beispiel gefunden, bevor der Aufruf hier ergänzt wurde.
    output.set_active(true);
    println!("OMP schreibt Flow {flow_id} (1920x1080@29.97, videotestsrc pattern=ball) — Prozess bleibt am Leben, Strg+C zum Beenden.");

    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}
