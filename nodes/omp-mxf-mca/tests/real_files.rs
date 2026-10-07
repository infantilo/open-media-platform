//! Prüft den Parser an von echten Encodern erzeugten MXF-Dateien
//! (ffmpeg, GStreamer mxfmux). Fehlt das Werkzeug, wird der Test übersprungen.

use std::path::PathBuf;
use std::process::Command;

fn tmp(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("omp-mxf-mca-real-{}-{name}", std::process::id()))
}

fn have(tool: &str) -> bool {
    Command::new(tool).arg("-version").output().is_ok() || Command::new(tool).arg("--version").output().is_ok()
}

#[test]
fn reads_ffmpeg_generated_mxf() {
    if !have("ffmpeg") {
        eprintln!("ffmpeg fehlt — übersprungen");
        return;
    }
    let out = tmp("ffmpeg.mxf");
    let st = Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-ac", "6"])
        .args(["-c:v", "mpeg2video", "-c:a", "pcm_s24le", "-f", "mxf"])
        .arg(&out)
        .status()
        .unwrap();
    assert!(st.success());
    let mca = omp_mxf_mca::read::read_file(&out).expect("echte MXF-Datei muss lesbar sein");
    // Keine Labels (ffmpeg schreibt keine MCA-Sub-Descriptors), aber der Audio-Descriptor mit 6 Kanälen.
    assert!(mca.is_empty());
    assert_eq!(mca.descriptors.len(), 1, "{mca:?}");
    assert_eq!(mca.descriptors[0].channel_count, 6);
    let sum = mca.summarize();
    assert_eq!(sum.unlabeled_channels.len(), 6);
    let _ = std::fs::remove_file(out);
}
