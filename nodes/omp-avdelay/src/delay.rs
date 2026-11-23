//! Rechnung des A/V-Delays: Millisekunden ↔ Bilder/Samples und der resultierende Versatz. Ohne MXL, damit testbar.
//!
//! Zwei voneinander unabhängige Verzögerungen: das Bild in **ganzen Bildern** (lokaler Ring im Kopierer), der Ton **auf das
//! Sample genau** (in ms vorgegeben). Der Versatz, den der Node dadurch zwischen Bild und Ton erzeugt, ist
//! `Ton-Verzögerung − Bild-Verzögerung`: positiv = Ton kommt später als das Bild, negativ = Ton früher.

pub const SAMPLE_RATE: u32 = 48000;

/// Dauer eines Bildes in ms.
pub fn frame_ms(rate_num: u32, rate_den: u32) -> f64 {
    if rate_num == 0 {
        return 0.0;
    }
    1000.0 * rate_den as f64 / rate_num as f64
}

/// Millisekunden → Samples (auf ganze Samples gerundet, nie negativ).
pub fn ms_to_samples(ms: f64) -> f64 {
    if !ms.is_finite() {
        return 0.0;
    }
    (ms.max(0.0) * SAMPLE_RATE as f64 / 1000.0).round()
}

pub fn samples_to_ms(samples: f64) -> f64 {
    samples * 1000.0 / SAMPLE_RATE as f64
}

/// Bildverzögerung in ms aus der Zahl ganzer Bilder.
pub fn video_ms(frames: u32, frame_ms: f64) -> f64 {
    frames as f64 * frame_ms
}

/// Versatz zwischen Bild und Ton, den der Node erzeugt (positiv = Ton später als Bild).
pub fn offset_ms(audio_ms: f64, frames: u32, frame_ms: f64) -> f64 {
    audio_ms - video_ms(frames, frame_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_duration() {
        assert!((frame_ms(25, 1) - 40.0).abs() < 1e-9);
        assert!((frame_ms(30000, 1001) - 33.3667).abs() < 1e-3);
        assert_eq!(frame_ms(0, 1), 0.0);
    }

    #[test]
    fn samples_round_and_clamp() {
        assert_eq!(ms_to_samples(10.0), 480.0);
        assert_eq!(ms_to_samples(-5.0), 0.0);
        assert_eq!(ms_to_samples(f64::NAN), 0.0);
        assert!((samples_to_ms(480.0) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn offset_sign() {
        // Bild 2 Bilder (80 ms) später, Ton 0: Ton kommt 80 ms früher als das Bild.
        assert!((offset_ms(0.0, 2, 40.0) - (-80.0)).abs() < 1e-9);
        // Ton 120 ms, Bild 2 Bilder: Ton 40 ms später.
        assert!((offset_ms(120.0, 2, 40.0) - 40.0).abs() < 1e-9);
    }

}
