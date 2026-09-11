//! Schreib-Gegenstück zu `mxl_late_flow_repro`: legt einen minimalen
//! Continuous-(Audio-)Flow mit einer vorgegebenen `flow-id` an und hält
//! den Prozess danach am Leben, damit der Flow registriert/offen
//! bleibt — separater Prozess, damit `mxl_late_flow_repro`s eigene
//! Instanz garantiert VOR der Existenz dieses Flows geöffnet wurde.
//!
//! Aufruf:
//!   OMP_MXL_DOMAIN=/dev/shm/omp-mxl \
//!   cargo run --package omp-mediaio --example mxl_late_flow_writer --features mxl -- \
//!     <flow-id>
use std::time::Duration;

fn main() {
    let flow_id = std::env::args().nth(1).expect("flow-id arg");
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/omp-mxl".to_string());
    let api = mxl::load_api("libmxl.so").expect("load_api");
    let instance = mxl::MxlInstance::new(api, &domain, "").expect("MxlInstance::new");

    let flow_def = serde_json::json!({
        "id": flow_id,
        "label": "late-flow-writer-test",
        "description": "mxl_late_flow_writer test flow",
        "tags": {"urn:x-nmos:tag:grouphint/v1.0": [format!("{flow_id}:Audio")]},
        "format": "urn:x-nmos:format:audio",
        "parents": [],
        "media_type": "audio/float32",
        "sample_rate": {"numerator": 48000},
        "channel_count": 2,
        "bit_depth": 32,
    })
    .to_string();

    let (_writer, _config, was_created) = instance.create_flow_writer(&flow_def, None).expect("create_flow_writer");
    println!("flow created (was_created={was_created}), keeping process alive");
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}
