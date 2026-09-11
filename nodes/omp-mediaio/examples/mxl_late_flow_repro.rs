//! Isoliert die Frage, ob eine `MxlInstance`, die VOR der Existenz
//! eines Flows geöffnet wurde, diesen Flow später — ohne Reopen, über
//! DIESELBE Instanz — per `get_flow_def()`/`create_flow_reader()`
//! trotzdem findet (BCP-008-Nachtrag, `docs/decisions.md`: live am
//! echten `omp-video-mixer-me` beobachtet, dass genau das dauerhaft
//! fehlschlägt, obwohl ein frischer `mxl-info`-Lauf denselben Flow
//! sofort findet). Optional (`own-writer-flow-id`) hält die Instanz
//! zusätzlich eine EIGENE Writer-Flow offen, um zu prüfen, ob ein
//! aktiver Writer auf derselben Instanz die Sichtbarkeit später
//! angelegter FREMDER Flows verschlechtert (mirrort `omp-video-mixer-
//! me`s Konstellation: schreibt sein eigenes PGM, liest gleichzeitig
//! Crosspoint-Eingänge über denselben `MxlContext`).
//!
//! **Ergebnis bisher (beide Varianten, mit/ohne eigenen Writer):**
//! funktioniert in diesem minimalen, GStreamer-freien Aufbau
//! einwandfrei (`attempt 1: SUCCESS`) — der reine `libmxl.so`-
//! Mechanismus hat also KEIN generelles "Instanz vor Flow geöffnet"-
//! Problem. Die reale Diskrepanz beim Mixer bleibt bisher ungeklärt
//! (weitere Variable vermutlich: viele parallele GStreamer-Threads,
//! wiederholtes Rebuild/Drop von `MxlVideoInput` im Retry-Takt, oder
//! irgendeine Kombination — nicht mit diesem Werkzeug allein
//! eingegrenzt).
//!
//! Aufruf:
//!   OMP_MXL_DOMAIN=/dev/shm/omp-mxl \
//!   cargo run --package omp-mediaio --example mxl_late_flow_repro --features mxl -- \
//!     <flow-id> <initial-wait-secs> [own-writer-flow-id]
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let flow_id = args.get(1).cloned().unwrap_or_default();
    let initial_wait: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let own_flow_id = args.get(3).cloned();
    let domain = std::env::var("OMP_MXL_DOMAIN").unwrap_or_else(|_| "/dev/shm/omp-mxl".to_string());
    let api = mxl::load_api("libmxl.so").expect("load_api");
    let instance = mxl::MxlInstance::new(api, &domain, "").expect("MxlInstance::new");

    let mut _own_writer = None;
    if let Some(own_id) = &own_flow_id {
        let flow_def = serde_json::json!({
            "id": own_id,
            "label": "late-flow-repro-own-writer",
            "description": "own writer flow",
            "tags": {"urn:x-nmos:tag:grouphint/v1.0": [format!("{own_id}:Audio")]},
            "format": "urn:x-nmos:format:audio",
            "parents": [],
            "media_type": "audio/float32",
            "sample_rate": {"numerator": 48000},
            "channel_count": 2,
            "bit_depth": 32,
        })
        .to_string();
        let (writer, _config, was_created) = instance.create_flow_writer(&flow_def, None).expect("create_flow_writer(own)");
        println!("own writer flow created (was_created={was_created})");
        _own_writer = Some(writer);
    }

    println!("instance opened, domain={domain}, flow_id={flow_id}, waiting {initial_wait}s before first attempt");
    std::thread::sleep(Duration::from_secs(initial_wait));

    for attempt in 1..=40 {
        match instance.get_flow_def(&flow_id) {
            Ok(_def) => {
                println!("attempt {attempt}: SUCCESS, get_flow_def worked");
                match instance.create_flow_reader(&flow_id) {
                    Ok(_reader) => println!("attempt {attempt}: create_flow_reader ALSO succeeded"),
                    Err(e) => println!("attempt {attempt}: create_flow_reader FAILED: {e}"),
                }
                return;
            }
            Err(e) => {
                println!("attempt {attempt}: get_flow_def FAILED: {e}");
                std::thread::sleep(Duration::from_millis(1000));
            }
        }
    }
    println!("gave up after 40 attempts");
}
