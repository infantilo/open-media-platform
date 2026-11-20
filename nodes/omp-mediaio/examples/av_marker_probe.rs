//! Echte A/V-Versatzmessung an den MXL-Etiketten einer Quelle (Marker statt
//! Latenzdifferenz): Quelle mit `OMP_SOURCE_PATTERN=black`, `OMP_SOURCE_VIDEO_MARKER=1` (ein
//! weißes Bild je Sekunde) und `OMP_SOURCE_AUDIO_WAVE=ticks` (Tick je Sekunde). Das Programm
//! liest Video- und Audio-Flow direkt, bestimmt den TAI-Zeitstempel (Grain-/
//! Sample-Index → `mxlIndexToTimestamp`) des Bildwechsels und des Tick-
//! Beginns und gibt den Versatz in **Normkonvention** aus (EBU R 37 / BT.1359):
//! 0 = Etiketten stimmen; > 0 = Ton eilt dem Bild voraus (Bild − Ton), < 0 = Ton hinkt nach.
//! Erkennung und Vorzeichen stehen in `omp_mediaio::avmarker` (gleiche Zahlen wie der Normalizer-Node).
//!
//!   cargo run -p omp-mediaio --features mxl --example av_marker_probe -- <domain> <video_flow> <audio_flow> [sekunden]
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (domain, vflow, aflow) = (&a[1], &a[2], &a[3]);
    let secs: f64 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(14.0);
    let api = mxl::load_api("libmxl.so").expect("libmxl");
    let inst = mxl::MxlInstance::new(api, domain, "").expect("instance");
    let stop = std::sync::atomic::AtomicBool::new(false);
    let m = omp_mediaio::avmarker::measure(&inst, vflow, aflow, secs, 500.0, &stop).expect("Messung");
    println!("video grains={}, Bildwechsel={}, Audio-Ticks={}", m.video_grains, m.flips, m.ticks);
    let mut d = m.offsets_ms.clone();
    d.sort_by(|x, y| x.total_cmp(y));
    println!("Versatz [ms] je Tick (positiv = Ton früh): {:?}", d.iter().map(|v| (v * 10.0).round() / 10.0).collect::<Vec<_>>());
    if d.is_empty() {
        println!("kein Messwert (kein Marker erkannt)");
    } else {
        println!("Median = {:.1} ms (positiv = Ton eilt dem Bild voraus)", d[d.len() / 2]);
    }
}
