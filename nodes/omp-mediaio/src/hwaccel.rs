//! GPU-Erkennung für GStreamer-Pipelines (Bugliste 2026-09-25 #7: "alle
//! GStreamer-basierten Pipelines müssen beim Start des Nodes schauen, ob
//! auf dem Host eine GPU zur Verfügung steht und wenn ja jeweils die GPU
//! nutzen, sonst Fallback auf CPU-basierte Elemente").
//!
//! **Warum nicht einfach `gst::ElementFactory::find("vaapipostproc")`?**
//! Live gefunden (2026-09-25, virtio-gpu/virgl-Treiber — typisch für
//! Entwicklungsumgebungen wie Crostini, s. `docs/decisions.md` Nachtrag
//! 292): `vaapipostproc` lädt anstandslos und verhandelt Caps korrekt,
//! SEGFAULTET aber zuverlässig, sobald es tatsächlich eine
//! Formatkonvertierung oder Skalierung durchführen soll. Eine reine
//! Existenzprüfung hätte auf genau dieser, keineswegs exotischen
//! Treiber-Klasse aktiv GPU-Nutzung empfohlen und damit jede Pipeline,
//! die [`build_convert_scale`] nutzt, beim Start zum Absturz gebracht.
//!
//! [`probe`] führt deshalb einen ECHTEN Funktionstest aus — in einem
//! eigenen, wegwerfbaren Subprozess (`omp-mediaio-hwaccel-selftest`,
//! `src/bin/hwaccel_selftest.rs`), damit ein Absturz des geprüften
//! Elements niemals den aufrufenden Node-Prozess mitreißt. Der Test
//! kostet bis zu [`PROBE_TIMEOUT`] und ist NICHT für den heißen Pfad
//! gedacht — jeder Node ruft [`probe`] genau einmal beim Start auf und
//! hält das Ergebnis für die Lebensdauer des Prozesses.

use gst::prelude::*;
use gstreamer as gst;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Ergebnis eines einmaligen Fähigkeits-Checks (s. Moduldoku) — bewusst
/// `Copy`/`Clone`, damit ein Node es einmal berechnet und beliebig oft an
/// `build_convert_scale`-Aufrufer weiterreichen kann, ohne den Selbsttest
/// je zu wiederholen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HwAccel {
    video_convert_scale: bool,
}

impl HwAccel {
    /// Führt den Selbsttest aus (aktuell nur `vaapipostproc`, s.
    /// Moduldoku — Kandidat für künftige Erweiterung, z. B. NVENC/NVDEC
    /// für Encode/Decode, sobald ein realer Anwendungsfall dafür ansteht).
    pub fn probe() -> Self {
        Self { video_convert_scale: probe_candidate("vaapipostproc") }
    }

    /// Erzwingt einen festen Zustand — für Tests, die NICHT den echten,
    /// hostabhängigen Subprozess-Selbsttest durchlaufen wollen.
    pub fn forced(video_convert_scale: bool) -> Self {
        Self { video_convert_scale }
    }

    /// `true`, wenn eine GPU-beschleunigte Formatkonvertierung+Skalierung
    /// auf diesem Host NACHGEWIESEN (nicht nur vermutet) funktioniert.
    pub fn video_convert_scale_available(&self) -> bool {
        self.video_convert_scale
    }
}

/// Läuft `omp-mediaio-hwaccel-selftest <candidate>` in einem eigenen
/// Prozess (Suche relativ zu `current_exe()` — landet dank Standard-
/// Cargo-Layout automatisch neben jedem Node-Binary im selben
/// `target/<profile>`-Verzeichnis). `true` NUR bei sauberem Exit 0
/// innerhalb von [`PROBE_TIMEOUT`] — jeder andere Fall (Absturz, Timeout,
/// fehlendes Helfer-Binary, o. Ä.) gilt als "nicht nutzbar", niemals als
/// Fehler, der den Aufrufer selbst stören dürfte.
fn probe_candidate(candidate: &str) -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let Some(dir) = exe.parent() else { return false };
    let helper = dir.join("omp-mediaio-hwaccel-selftest");
    if !helper.is_file() {
        return false;
    }
    let Ok(mut child) = Command::new(&helper).arg(candidate).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
    else {
        return false;
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if start.elapsed() >= PROBE_TIMEOUT {
                    // Hängender ODER (wie live beobachtet bei `gst-
                    // launch-1.0`s eigenem Absturz-Handler) "spinnender"
                    // Kandidat — beides zählt als nicht nutzbar, nicht
                    // als unentschieden.
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return false,
        }
    }
}

/// Baut einen Konvertierungs-/Skalierungs-Zweig (`tail` → `target_caps`):
/// `vaapipostproc`, wenn `hwaccel.video_convert_scale_available()`, sonst
/// das unveränderte `videoconvert ! videoscale` (identisches Verhalten
/// wie vor diesem Modul). Gleiches Rückgabemuster wie die
/// `build_normalized_branch`-artigen Hilfsfunktionen in den einzelnen
/// Nodes: `(Anschlusspunkt, alle selbst hinzugefügten Elemente)` — der
/// Aufrufer verlinkt `tail` selbst davor und behandelt den
/// Anschlusspunkt wie jedes andere `capsfilter`.
pub fn build_convert_scale(
    pipeline: &gst::Pipeline,
    tail: &gst::Element,
    name_suffix: &str,
    target_caps: &gst::Caps,
    hwaccel: HwAccel,
) -> Result<(gst::Element, Vec<gst::Element>), String> {
    let caps_el = gst::ElementFactory::make("capsfilter")
        .property("caps", target_caps.clone())
        .build()
        .map_err(|e| format!("capsfilter ({name_suffix}): {e}"))?;

    if hwaccel.video_convert_scale_available() {
        let postproc = gst::ElementFactory::make("vaapipostproc")
            .build()
            .map_err(|e| format!("vaapipostproc ({name_suffix}): {e}"))?;
        pipeline
            .add(&postproc)
            .and_then(|()| pipeline.add(&caps_el))
            .map_err(|e| format!("add ({name_suffix}): {e}"))?;
        gst::Element::link_many([tail, &postproc, &caps_el]).map_err(|e| format!("link ({name_suffix}): {e}"))?;
        Ok((caps_el.clone(), vec![postproc, caps_el]))
    } else {
        let convert = gst::ElementFactory::make("videoconvert").build().map_err(|e| format!("videoconvert ({name_suffix}): {e}"))?;
        let scale = gst::ElementFactory::make("videoscale").build().map_err(|e| format!("videoscale ({name_suffix}): {e}"))?;
        pipeline
            .add(&convert)
            .and_then(|()| pipeline.add(&scale))
            .and_then(|()| pipeline.add(&caps_el))
            .map_err(|e| format!("add ({name_suffix}): {e}"))?;
        gst::Element::link_many([tail, &convert, &scale, &caps_el]).map_err(|e| format!("link ({name_suffix}): {e}"))?;
        Ok((caps_el.clone(), vec![convert, scale, caps_el]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forced_reports_exactly_the_requested_state() {
        assert!(HwAccel::forced(true).video_convert_scale_available());
        assert!(!HwAccel::forced(false).video_convert_scale_available());
    }

    #[test]
    fn default_is_software_only() {
        assert!(!HwAccel::default().video_convert_scale_available());
    }

    #[test]
    fn probe_candidate_is_false_for_a_nonexistent_binary_directory() {
        // `current_exe()` im Testprozess liegt im `deps/`-Unterordner,
        // NICHT direkt neben `omp-mediaio-hwaccel-selftest` — deckt den
        // "Helfer-Binary fehlt" No-Op-Zweig ab, ohne den echten Host-
        // Selbsttest laufen zu lassen (der ist Sache der `build_convert_
        // scale`-Live-Verifikation, nicht eines Unit-Tests).
        assert!(!probe_candidate("does-not-matter"));
    }

    #[test]
    fn build_convert_scale_uses_software_path_without_hwaccel() {
        gst::init().expect("gst init");
        let pipeline = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").build().expect("videotestsrc");
        pipeline.add(&src).expect("add src");
        let target = gst::Caps::builder("video/x-raw").field("format", "RGBA").field("width", 64i32).field("height", 48i32).build();
        let (_, elements) = build_convert_scale(&pipeline, &src, "test", &target, HwAccel::forced(false)).expect("build_convert_scale");
        let names: Vec<String> = elements.iter().map(|e| e.factory().map(|f| f.name().to_string()).unwrap_or_default()).collect();
        assert_eq!(names, vec!["videoconvert", "videoscale", "capsfilter"]);
    }
}
