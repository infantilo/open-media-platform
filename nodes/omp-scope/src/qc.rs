//! Automatische Signalüberwachung („QC-Alarme") — die Messungen, die
//! ein Sendeabnahme-Platz dauerhaft mitlaufen lässt, statt sie von einem
//! Menschen am Bild ablesen zu lassen: **Schwarzbild**, **Standbild
//! (Freeze)** und **Stille**.
//!
//! Alle drei sind bewusst als *gehaltene* Bedingungen modelliert
//! ([`Condition`]): ein einzelnes schwarzes Bild zwischen zwei Schnitten
//! ist keine Störung, eine Sekunde Schwarz ist eine. Ohne diese
//! Haltezeit wäre die Anzeige bei jedem Bildwechsel voller
//! Falschalarme — der klassische Fehler bei naiven „Black Detect"-
//! Implementierungen.
//!
//! Die Bildmessung läuft auf DEMSELBEN heruntergerechneten Analysebild
//! (`WAVEFORM_WIDTH`×`ANALYSIS_HEIGHT`, s. `video_pipeline`), das
//! ohnehin schon für Waveform/Vektorskop erzeugt wird — keine zweite
//! Dekodier-/Skalierkette, keine zusätzliche CPU-Last für die QC.
//!
//! **Bekannte, bewusst akzeptierte Eigenschaft:** ein statisches
//! Testbild (`omp-source`s SMPTE-Balken) wird korrekterweise als
//! Standbild gemeldet — es IST eines. Das ist kein Falschalarm, sondern
//! der Beweis, dass die Messung funktioniert; mit einer bewegten Quelle
//! (z. B. `ball`/`snow`) verschwindet die Meldung sofort wieder.

/// Mittleres Luma, ab dem ein Bild als schwarz gilt (8-bit-Luma).
/// 16 = Studio-Schwarz nach ITU-R BT.601/709 (Videopegel 0 %); alles
/// darunter ist Sub-Black. Mittelwert UND Spitzenwert müssen die
/// Schwelle unterschreiten, sonst würde ein dunkles Bild mit einer
/// hellen Bauchbinde fälschlich als Schwarzbild zählen.
pub const BLACK_MEAN_LIMIT: f64 = 16.0;
pub const BLACK_PEAK_LIMIT: u8 = 32;

/// Mittlere absolute Bild-zu-Bild-Differenz (8-bit-Luma), unter der zwei
/// Bilder als identisch gelten. Nicht 0: das Analysebild entsteht durch
/// Skalierung/Farbraumwandlung, deren Rundung selbst bei einem
/// tatsächlich unveränderten Quellbild um ±1 rauschen kann.
pub const FREEZE_DIFF_LIMIT: f64 = 0.5;

/// Spitzenpegel (dBFS), unter dem Audio als Stille gilt. −60 dBFS ist
/// der in der Sendeabnahme übliche Wert — leise genug, dass Raumton oder
/// Grundrauschen nicht als Stille durchgeht.
pub const SILENCE_LIMIT_DBFS: f64 = -60.0;

pub const BLACK_HOLD_NS: u64 = 1_000_000_000;
pub const FREEZE_HOLD_NS: u64 = 2_000_000_000;
pub const SILENCE_HOLD_NS: u64 = 2_000_000_000;

/// Eine Bedingung, die erst nach ununterbrochenem Anliegen über
/// `hold_ns` als Alarm gilt, und deren Dauer ab dem ERSTEN Anliegen
/// gezählt wird (nicht ab dem Auslösen) — ein Operator will wissen, wie
/// lange schon schwarz ist, nicht wie lange der Alarm schon leuchtet.
#[derive(Debug, Clone, Copy, Default)]
pub struct Condition {
    hold_ns: u64,
    since_ns: Option<u64>,
    now_ns: u64,
}

impl Condition {
    pub fn new(hold_ns: u64) -> Self {
        Condition { hold_ns, since_ns: None, now_ns: 0 }
    }

    pub fn update(&mut self, met: bool, now_ns: u64) {
        self.now_ns = now_ns;
        match (met, self.since_ns) {
            (true, None) => self.since_ns = Some(now_ns),
            (true, Some(_)) => {}
            (false, _) => self.since_ns = None,
        }
    }

    /// Alarm aktiv (Bedingung liegt länger als die Haltezeit an).
    pub fn raised(&self) -> bool {
        self.since_ns.is_some_and(|since| self.now_ns.saturating_sub(since) >= self.hold_ns)
    }

    /// Wie lange die Bedingung bereits ununterbrochen anliegt —
    /// `None`, solange sie gar nicht anliegt. Auch VOR dem Auslösen
    /// bereits gefüllt, damit die Anzeige „seit 0,4 s dunkel" zeigen
    /// kann, ohne schon Alarm zu schlagen.
    pub fn seconds(&self) -> Option<f64> {
        self.since_ns.map(|since| self.now_ns.saturating_sub(since) as f64 / 1e9)
    }

}

/// Mittleres Luma eines dicht gepackten 8-bit-Y-Planes.
pub fn mean_luma(y: &[u8]) -> f64 {
    if y.is_empty() {
        return 0.0;
    }
    y.iter().map(|&v| v as u64).sum::<u64>() as f64 / y.len() as f64
}

pub fn peak_luma(y: &[u8]) -> u8 {
    y.iter().copied().max().unwrap_or(0)
}

/// Mittlere absolute Differenz zweier gleich großer Y-Planes. Bei
/// abweichender Länge (Formatwechsel mitten im Lauf) `None` — dann ist
/// „unverändert" schlicht nicht beantwortbar, und eine Antwort zu
/// erfinden wäre schlimmer als keine.
pub fn mean_abs_diff(a: &[u8], b: &[u8]) -> Option<f64> {
    if a.len() != b.len() || a.is_empty() {
        return None;
    }
    let sum: u64 = a.iter().zip(b.iter()).map(|(&x, &y)| x.abs_diff(y) as u64).sum();
    Some(sum as f64 / a.len() as f64)
}

/// Linearer Spitzenwert (0..1) → dBFS. Digitale Null ergibt `-inf`, was
/// die Aufrufer als „nicht darstellbar" behandeln (s. `opt_f64_json` in
/// `main.rs`).
pub fn linear_to_dbfs(linear: f64) -> f64 {
    if linear <= 0.0 {
        f64::NEG_INFINITY
    } else {
        20.0 * linear.log10()
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct VideoQcSnapshot {
    /// Mittleres Luma in Prozent des 8-bit-Bereichs — der Wert, der der
    /// Waveform-Anzeige entspricht.
    pub mean_luma_percent: Option<f64>,
    /// Mittlere Bild-zu-Bild-Differenz (8-bit-Luma-Stufen).
    pub frame_diff: Option<f64>,
    pub black: bool,
    pub black_seconds: Option<f64>,
    pub freeze: bool,
    pub freeze_seconds: Option<f64>,
}

#[derive(Debug)]
pub struct VideoQc {
    previous: Option<Vec<u8>>,
    mean_luma: Option<f64>,
    frame_diff: Option<f64>,
    black: Condition,
    freeze: Condition,
}

/// **Kein `#[derive(Default)]`**: das würde beide [`Condition`]s mit
/// `hold_ns = 0` bauen, also die gesamte Entprellung aushebeln — jedes
/// einzelne dunkle Bild wäre sofort ein Schwarzbild-Alarm. Beim Bauen
/// aufgefallen, weil `video_pipeline::Measurements` sein `Default`
/// ableitet und damit genau diesen Weg genommen hätte.
impl Default for VideoQc {
    fn default() -> Self {
        VideoQc {
            previous: None,
            mean_luma: None,
            frame_diff: None,
            black: Condition::new(BLACK_HOLD_NS),
            freeze: Condition::new(FREEZE_HOLD_NS),
        }
    }
}

impl VideoQc {
    pub fn reset(&mut self) {
        *self = VideoQc::default();
    }

    pub fn observe(&mut self, y: &[u8], now_ns: u64) {
        let mean = mean_luma(y);
        let peak = peak_luma(y);
        self.mean_luma = Some(mean);
        self.black.update(mean <= BLACK_MEAN_LIMIT && peak <= BLACK_PEAK_LIMIT, now_ns);

        let diff = self.previous.as_deref().and_then(|prev| mean_abs_diff(prev, y));
        self.frame_diff = diff;
        // Ohne Vergleichsbild (erstes Bild nach dem Connect, oder
        // Formatwechsel) gilt die Bedingung als NICHT erfüllt — sonst
        // würde ein Quellwechsel je nach Zufall als Standbild starten.
        self.freeze.update(diff.is_some_and(|d| d <= FREEZE_DIFF_LIMIT), now_ns);

        match self.previous.as_mut() {
            Some(prev) if prev.len() == y.len() => prev.copy_from_slice(y),
            _ => self.previous = Some(y.to_vec()),
        }
    }

    pub fn snapshot(&self) -> VideoQcSnapshot {
        VideoQcSnapshot {
            mean_luma_percent: self.mean_luma.map(|v| v / 255.0 * 100.0),
            frame_diff: self.frame_diff,
            black: self.black.raised(),
            black_seconds: self.black.seconds(),
            freeze: self.freeze.raised(),
            freeze_seconds: self.freeze.seconds(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AudioQcSnapshot {
    pub silence: bool,
    pub silence_seconds: Option<f64>,
}

#[derive(Debug)]
pub struct AudioQc {
    silence: Condition,
}

/// Kein `#[derive(Default)]`, gleicher Grund wie bei [`VideoQc`].
impl Default for AudioQc {
    fn default() -> Self {
        AudioQc { silence: Condition::new(SILENCE_HOLD_NS) }
    }
}

impl AudioQc {
    pub fn reset(&mut self) {
        *self = AudioQc::default();
    }

    /// `peak_dbfs` ist der Spitzenpegel des gerade verarbeiteten
    /// Audio-Blocks (aus `ebur128`s `prev_true_peak`, s.
    /// `audio_pipeline`), nicht der Langzeit-Spitzenwert — sonst könnte
    /// ein einzelner lauter Knall am Anfang jede spätere Stille für immer
    /// verdecken.
    pub fn observe(&mut self, peak_dbfs: f64, now_ns: u64) {
        self.silence.update(peak_dbfs < SILENCE_LIMIT_DBFS, now_ns);
    }

    pub fn snapshot(&self) -> AudioQcSnapshot {
        AudioQcSnapshot { silence: self.silence.raised(), silence_seconds: self.silence.seconds() }
    }
}

/// EBU-R-128-Zielwerte für die Konformitätsampel: Programmlautheit
/// −23,0 LUFS mit einer in R 128 selbst genannten Toleranz von ±0,5 LU
/// (bei Programmen ohne Möglichkeit zur Nachbearbeitung ±1,0 LU — hier
/// bewusst der strengere Wert), True Peak höchstens −1 dBTP
/// (ITU-R BS.1770-Messung, Übersteuerungsreserve für die spätere
/// Datenreduktion).
pub const R128_TARGET_LUFS: f64 = -23.0;
pub const R128_TOLERANCE_LU: f64 = 0.5;
pub const R128_TRUE_PEAK_LIMIT_DBTP: f64 = -1.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum R128Verdict {
    Unknown,
    InSpec,
    /// Lautheit stimmt noch, aber der True Peak reißt die Grenze —
    /// getrennt ausgewiesen, weil die Gegenmaßnahme eine andere ist
    /// (Limiter statt Pegelkorrektur).
    TruePeakOver,
    LoudnessOff,
}

impl R128Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            R128Verdict::Unknown => "unbekannt",
            R128Verdict::InSpec => "R 128 erfüllt",
            R128Verdict::TruePeakOver => "True Peak über −1 dBTP",
            R128Verdict::LoudnessOff => "Lautheit außerhalb −23 ±0,5 LUFS",
        }
    }
}

pub fn r128_verdict(integrated_lufs: Option<f64>, true_peak_dbtp: Option<f64>) -> R128Verdict {
    let Some(integrated) = integrated_lufs.filter(|v| v.is_finite()) else {
        return R128Verdict::Unknown;
    };
    if (integrated - R128_TARGET_LUFS).abs() > R128_TOLERANCE_LU {
        return R128Verdict::LoudnessOff;
    }
    match true_peak_dbtp {
        Some(tp) if tp.is_finite() && tp > R128_TRUE_PEAK_LIMIT_DBTP => R128Verdict::TruePeakOver,
        _ => R128Verdict::InSpec,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 1_000_000_000;

    #[test]
    fn schwarzbild_erst_nach_haltezeit() {
        let mut qc = VideoQc::default();
        let black = vec![8u8; 64];
        qc.observe(&black, 0);
        assert!(!qc.snapshot().black, "sofortiger Alarm wäre ein Falschalarm");
        qc.observe(&black, S / 2);
        assert!(!qc.snapshot().black);
        qc.observe(&black, S);
        let s = qc.snapshot();
        assert!(s.black);
        assert_eq!(s.black_seconds, Some(1.0));
    }

    #[test]
    fn helles_detail_verhindert_schwarzbild_meldung() {
        let mut qc = VideoQc::default();
        // Mittelwert klar unter der Schwelle, aber ein heller Pixel
        // (Bauchbinde/Logo) — kein Schwarzbild.
        let mut frame = vec![2u8; 1000];
        frame[0] = 200;
        for t in 0..5 {
            qc.observe(&frame, t * S);
        }
        assert!(!qc.snapshot().black);
    }

    #[test]
    fn standbild_wird_erkannt_und_von_bewegung_geloescht() {
        let mut qc = VideoQc::default();
        let still = vec![120u8; 256];
        for t in 0..4 {
            qc.observe(&still, t * S);
        }
        let s = qc.snapshot();
        assert!(s.freeze);
        assert_eq!(s.frame_diff, Some(0.0));

        let mut moved = still.clone();
        moved[0..64].fill(20);
        qc.observe(&moved, 4 * S);
        let s = qc.snapshot();
        assert!(!s.freeze, "Bewegung muss den Standbild-Alarm sofort löschen");
        assert!(s.frame_diff.expect("diff") > FREEZE_DIFF_LIMIT);
    }

    #[test]
    fn erstes_bild_nach_connect_ist_kein_standbild() {
        let mut qc = VideoQc::default();
        qc.observe(&vec![120u8; 256], 10 * S);
        let s = qc.snapshot();
        assert!(!s.freeze);
        assert_eq!(s.frame_diff, None);
    }

    #[test]
    fn formatwechsel_liefert_keine_differenz() {
        assert_eq!(mean_abs_diff(&[1, 2, 3], &[1, 2]), None);
        assert_eq!(mean_abs_diff(&[], &[]), None);
        assert_eq!(mean_abs_diff(&[10, 10], &[12, 8]), Some(2.0));
    }

    #[test]
    fn stille_erst_nach_haltezeit_und_endet_sofort() {
        let mut qc = AudioQc::default();
        qc.observe(-90.0, 0);
        assert!(!qc.snapshot().silence);
        qc.observe(-90.0, 2 * S);
        assert!(qc.snapshot().silence);
        qc.observe(-12.0, 2 * S + S / 10);
        let s = qc.snapshot();
        assert!(!s.silence);
        assert_eq!(s.silence_seconds, None);
    }

    #[test]
    fn dbfs_umrechnung() {
        assert!((linear_to_dbfs(1.0) - 0.0).abs() < 1e-9);
        assert!((linear_to_dbfs(0.5) + 6.0206).abs() < 1e-3);
        assert!(linear_to_dbfs(0.0).is_infinite());
    }

    #[test]
    fn r128_ampel_trennt_lautheit_von_true_peak() {
        assert_eq!(r128_verdict(None, None), R128Verdict::Unknown);
        assert_eq!(r128_verdict(Some(f64::NEG_INFINITY), Some(-5.0)), R128Verdict::Unknown);
        assert_eq!(r128_verdict(Some(-23.2), Some(-3.0)), R128Verdict::InSpec);
        assert_eq!(r128_verdict(Some(-23.2), Some(-0.2)), R128Verdict::TruePeakOver);
        assert_eq!(r128_verdict(Some(-19.0), Some(-3.0)), R128Verdict::LoudnessOff);
        // Lautheitsfehler schlägt True-Peak-Fehler: erst pegeln, dann
        // limitieren.
        assert_eq!(r128_verdict(Some(-10.0), Some(0.5)), R128Verdict::LoudnessOff);
    }
}
