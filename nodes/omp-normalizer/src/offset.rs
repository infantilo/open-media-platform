//! A/V-Versatz: Schätzer aus Einzelmessungen und Umrechnung in Korrekturen.
//!
//! Vorzeichen = Normkonvention (EBU R 37 / ITU-R BT.1359): **positiv = Ton eilt dem Bild voraus**. Dann wird der Ton
//! verzögert; bei negativem Wert (Ton hinkt nach) das Bild. Siehe `docs/entwuerfe/ENTWURF-MCR.md` §1.

use serde::Serialize;

/// Betriebsart des A/V-Ausgleichs. `Tracking` (Live-Nachführung) ist nur vorgeplant (Nutzerentscheidung E-M3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AvsyncMode {
    Off,
    Manual,
    /// In der Testphase messen, Wert übernehmen und halten (Standard).
    Once,
    Tracking,
}

impl AvsyncMode {
    pub fn parse(s: &str) -> Result<AvsyncMode, String> {
        match s {
            "off" => Ok(AvsyncMode::Off),
            "manual" => Ok(AvsyncMode::Manual),
            "once" => Ok(AvsyncMode::Once),
            "tracking" => Ok(AvsyncMode::Tracking),
            other => Err(format!("unbekannter Modus „{other}“ (off, manual, once)")),
        }
    }
    /// Ob der Node den Modus heute ausführen kann. `Tracking` ist reserviert.
    pub fn check_supported(self) -> Result<(), String> {
        match self {
            AvsyncMode::Tracking => {
                Err("Modus „tracking“ ist nicht umgesetzt (nur vorgeplant)".into())
            }
            _ => Ok(()),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            AvsyncMode::Off => "off",
            AvsyncMode::Manual => "manual",
            AvsyncMode::Once => "once",
            AvsyncMode::Tracking => "tracking",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Estimate {
    /// Median der verbleibenden Messwerte in ms.
    pub ms: f64,
    /// 0…1 aus Anzahl und Streuung.
    pub confidence: f64,
    /// Zahl der verwendeten Messwerte (nach Ausreißerauswahl).
    pub samples: usize,
}

/// Schätzer über ein gleitendes Fenster von Einzelmessungen: Median, Ausreißer jenseits 3 MAD verworfen.
#[derive(Clone, Debug)]
pub struct Estimator {
    window: usize,
    values: Vec<f64>,
}

fn median(sorted: &[f64]) -> f64 {
    let n = sorted.len();
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    }
}

impl Estimator {
    pub fn new(window: usize) -> Self {
        Estimator {
            window: window.max(1),
            values: Vec::new(),
        }
    }
    pub fn push(&mut self, ms: f64) {
        if !ms.is_finite() {
            return;
        }
        self.values.push(ms);
        if self.values.len() > self.window {
            self.values.remove(0);
        }
    }
    pub fn clear(&mut self) {
        self.values.clear();
    }
    pub fn len(&self) -> usize {
        self.values.len()
    }
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    pub fn estimate(&self) -> Option<Estimate> {
        if self.values.is_empty() {
            return None;
        }
        let mut s = self.values.clone();
        s.sort_by(|a, b| a.total_cmp(b));
        let med = median(&s);
        let mut dev: Vec<f64> = s.iter().map(|v| (v - med).abs()).collect();
        dev.sort_by(|a, b| a.total_cmp(b));
        // Untergrenze 0,5 ms, sonst würde bei MAD = 0 jede kleine Abweichung verworfen.
        let mad = median(&dev).max(0.5);
        let kept: Vec<f64> = s
            .iter()
            .copied()
            .filter(|v| (v - med).abs() <= 3.0 * mad)
            .collect();
        let mut k = kept.clone();
        k.sort_by(|a, b| a.total_cmp(b));
        let m = median(&k);
        let mut d2: Vec<f64> = k.iter().map(|v| (v - m).abs()).collect();
        d2.sort_by(|a, b| a.total_cmp(b));
        let spread = 1.4826 * median(&d2);
        let n = k.len();
        let count_factor = 1.0 - (-(n as f64) / 4.0).exp();
        let confidence = (count_factor / (1.0 + spread / 5.0)).clamp(0.0, 1.0);
        Some(Estimate {
            ms: m,
            confidence,
            samples: n,
        })
    }
}

/// Korrektur aus einem gemessenen Versatz (Normkonvention).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Correction {
    pub audio_delay_ms: f64,
    pub video_delay_ms: f64,
}

/// `measured_ms` positiv = Ton früh → Ton verzögern; negativ → Bild verzögern. Innerhalb des Totbands: keine Korrektur.
pub fn correction_for(measured_ms: f64, deadband_ms: f64) -> Correction {
    if measured_ms.abs() < deadband_ms.abs() || !measured_ms.is_finite() {
        Correction {
            audio_delay_ms: 0.0,
            video_delay_ms: 0.0,
        }
    } else if measured_ms > 0.0 {
        Correction {
            audio_delay_ms: measured_ms,
            video_delay_ms: 0.0,
        }
    } else {
        Correction {
            audio_delay_ms: 0.0,
            video_delay_ms: -measured_ms,
        }
    }
}

/// Bildverzögerung in ganzen Bildern (aufgerundet, höchstens `max_frames`); der Rest wird als zusätzliche Tonverzögerung
/// (immer ≥ 0) ausgeglichen. Rückgabe: (Bilder, Ton-Rest in ms). Wird das Maximum überschritten, bleibt der Rest im
/// Bild unausgeglichen und kommt ebenfalls in den Ton (er kann dann negativ nicht werden): der Ton trägt `D − Bilder·f`.
pub fn video_delay_split(video_delay_ms: f64, frame_ms: f64, max_frames: u32) -> (u32, f64) {
    if video_delay_ms <= 0.0 || frame_ms <= 0.0 {
        return (0, 0.0);
    }
    let want = (video_delay_ms / frame_ms - 1e-9).ceil().max(0.0) as u32;
    if want <= max_frames {
        (want, (want as f64 * frame_ms - video_delay_ms).max(0.0))
    } else {
        // Zu groß für den Ring: das Bild trägt das Maximum, der Ton ist dann zu spät — Aufrufer meldet „nicht ausgleichbar“.
        (max_frames, 0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_mit_ausreissern_innerhalb_1_ms() {
        let mut e = Estimator::new(32);
        for v in [
            80.2, 79.8, 80.5, 79.6, 80.1, 80.0, 400.0, -300.0, 79.9, 80.3,
        ] {
            e.push(v);
        }
        let est = e.estimate().unwrap();
        assert!((est.ms - 80.0).abs() <= 1.0, "{est:?}");
        assert_eq!(est.samples, 8, "beide Ausreißer verworfen");
    }

    #[test]
    fn konfidenz_steigt_mit_der_anzahl_und_faellt_mit_streuung() {
        let mut few = Estimator::new(32);
        let mut many = Estimator::new(32);
        for _ in 0..3 {
            few.push(50.0);
        }
        for _ in 0..12 {
            many.push(50.0);
        }
        assert!(many.estimate().unwrap().confidence > few.estimate().unwrap().confidence);
        assert!(many.estimate().unwrap().confidence >= 0.8);
        let mut noisy = Estimator::new(32);
        for i in 0..12 {
            noisy.push(50.0 + if i % 2 == 0 { 8.0 } else { -8.0 });
        }
        assert!(noisy.estimate().unwrap().confidence < many.estimate().unwrap().confidence);
    }

    #[test]
    fn leer_gibt_keine_schaetzung_und_nan_wird_ignoriert() {
        let mut e = Estimator::new(8);
        assert!(e.estimate().is_none());
        e.push(f64::NAN);
        assert!(e.estimate().is_none());
    }

    #[test]
    fn fenster_verwirft_alte_werte() {
        let mut e = Estimator::new(4);
        for v in [100.0; 4] {
            e.push(v);
        }
        for v in [10.0; 4] {
            e.push(v);
        }
        assert_eq!(e.estimate().unwrap().ms, 10.0);
    }

    #[test]
    fn korrektur_vorzeichen_und_totband() {
        assert_eq!(
            correction_for(60.0, 10.0),
            Correction {
                audio_delay_ms: 60.0,
                video_delay_ms: 0.0
            }
        );
        assert_eq!(
            correction_for(-80.0, 10.0),
            Correction {
                audio_delay_ms: 0.0,
                video_delay_ms: 80.0
            }
        );
        assert_eq!(
            correction_for(7.0, 10.0),
            Correction {
                audio_delay_ms: 0.0,
                video_delay_ms: 0.0
            }
        );
        assert_eq!(correction_for(-9.9, 10.0).video_delay_ms, 0.0);
    }

    #[test]
    fn bildverzoegerung_ganze_bilder_rest_in_den_ton() {
        // 25 Bilder/s = 40 ms
        assert_eq!(video_delay_split(80.0, 40.0, 12), (2, 0.0));
        let (f, rest) = video_delay_split(60.0, 40.0, 12);
        assert_eq!(f, 2);
        assert!(
            (rest - 20.0).abs() < 1e-9,
            "Ton trägt 20 ms, Summe 80 − 20 = 60"
        );
        assert_eq!(video_delay_split(0.0, 40.0, 12), (0, 0.0));
        assert_eq!(video_delay_split(1000.0, 40.0, 12).0, 12, "Höchstwert");
    }

    #[test]
    fn tracking_ist_reserviert() {
        assert_eq!(AvsyncMode::parse("once").unwrap(), AvsyncMode::Once);
        assert!(
            AvsyncMode::parse("tracking")
                .unwrap()
                .check_supported()
                .is_err()
        );
        assert!(AvsyncMode::Once.check_supported().is_ok());
        assert!(AvsyncMode::parse("blub").is_err());
    }
}
