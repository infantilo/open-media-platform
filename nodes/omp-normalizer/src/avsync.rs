//! A/V-Ausgleich: aus Betriebsart und Messwert die wirksame Verzögerung bestimmen (UMSETZUNG 106.5).
//!
//! Vorzeichen: Normkonvention, **positiv = Ton eilt dem Bild voraus** (→ Ton verzögern, negativ → Bild verzögern).
//! Das Bild wird nur um ganze Bilder verzögert, der Rest geht in den Ton (`offset::video_delay_split`).
//! `Tracking` (Live-Nachführung) ist reserviert und wird abgelehnt (Nutzerentscheidung E-M3).

use crate::offset::{AvsyncMode, correction_for, video_delay_split};
use serde::Serialize;

/// Einstellungen des Ausgleichs (alle zur Laufzeit änderbar, alle im Zustandsexport über schreibbare Parameter).
#[derive(Clone, Debug, PartialEq)]
pub struct AvSyncSettings {
    pub mode: AvsyncMode,
    /// Manueller Versatz in ms (Normkonvention), nur im Modus `manual`.
    pub manual_ms: f64,
    /// Übernommener Messwert (`once`), `None` = noch keiner übernommen.
    pub held_ms: Option<f64>,
    pub deadband_ms: f64,
    pub max_slew_permille: f64,
    /// Eingefroren: das Ziel wird nicht mehr nachgezogen.
    pub freeze: bool,
}

impl Default for AvSyncSettings {
    fn default() -> Self {
        AvSyncSettings { mode: AvsyncMode::Once, manual_ms: 0.0, held_ms: None, deadband_ms: 10.0, max_slew_permille: 5.0, freeze: false }
    }
}

/// Wirksames Ergebnis.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Applied {
    /// Der ausgeglichene Versatz (Normkonvention), 0 = nichts zu tun.
    pub offset_ms: f64,
    pub video_delay_frames: u32,
    pub audio_delay_samples: f64,
    /// Der Versatz war größer als der Ring zulässt; es bleibt ein Restfehler.
    pub exceeds_range: bool,
}

impl AvSyncSettings {
    /// Der Versatz, der ausgeglichen werden soll.
    pub fn target_offset_ms(&self) -> Result<f64, String> {
        self.mode.check_supported()?;
        Ok(match self.mode {
            AvsyncMode::Off | AvsyncMode::Tracking => 0.0,
            AvsyncMode::Manual => self.manual_ms,
            AvsyncMode::Once => self.held_ms.unwrap_or(0.0),
        })
    }

    /// Verzögerungen für ein Bildraster (`frame_ms`) und eine Abtastrate. `manual` ignoriert das Totband (es ist eine
    /// ausdrückliche Vorgabe), `once` wendet es an.
    pub fn decide(&self, frame_ms: f64, sample_rate: u32, max_frames: u32) -> Result<Applied, String> {
        let ms = self.target_offset_ms()?;
        let deadband = if self.mode == AvsyncMode::Manual { 0.0 } else { self.deadband_ms };
        let c = correction_for(ms, deadband);
        let (frames, rest_ms) = video_delay_split(c.video_delay_ms, frame_ms, max_frames);
        let exceeds = c.video_delay_ms > max_frames as f64 * frame_ms + 1e-6;
        let audio_ms = c.audio_delay_ms + rest_ms;
        Ok(Applied {
            offset_ms: if c.audio_delay_ms == 0.0 && c.video_delay_ms == 0.0 { 0.0 } else { ms },
            video_delay_frames: frames,
            audio_delay_samples: (audio_ms * sample_rate as f64 / 1000.0).round(),
            exceeds_range: exceeds,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(mode: AvsyncMode) -> AvSyncSettings {
        AvSyncSettings { mode, ..Default::default() }
    }

    #[test]
    fn sound_early_delays_audio_only() {
        let mut a = s(AvsyncMode::Once);
        a.held_ms = Some(60.0);
        let r = a.decide(40.0, 48_000, 12).unwrap();
        assert_eq!(r.video_delay_frames, 0);
        assert_eq!(r.audio_delay_samples, 2880.0); // 60 ms bei 48 kHz
        assert_eq!(r.offset_ms, 60.0);
    }

    #[test]
    fn sound_late_delays_video_in_whole_frames_and_rest_to_audio() {
        let mut a = s(AvsyncMode::Once);
        a.held_ms = Some(-80.0);
        let r = a.decide(40.0, 48_000, 12).unwrap();
        assert_eq!(r.video_delay_frames, 2);
        assert_eq!(r.audio_delay_samples, 0.0); // 80 ms = genau 2 Bilder
        a.held_ms = Some(-70.0);
        let r = a.decide(40.0, 48_000, 12).unwrap();
        assert_eq!(r.video_delay_frames, 2); // aufgerundet: 80 ms Bild
        assert_eq!(r.audio_delay_samples, 480.0); // 10 ms Rest in den Ton
    }

    #[test]
    fn deadband_means_no_correction() {
        let mut a = s(AvsyncMode::Once);
        a.held_ms = Some(7.4);
        let r = a.decide(40.0, 48_000, 12).unwrap();
        assert_eq!((r.video_delay_frames, r.audio_delay_samples, r.offset_ms), (0, 0.0, 0.0));
    }

    #[test]
    fn manual_overrides_and_ignores_deadband() {
        let mut a = s(AvsyncMode::Manual);
        a.held_ms = Some(60.0);
        a.manual_ms = 5.0;
        let r = a.decide(40.0, 48_000, 12).unwrap();
        assert_eq!(r.audio_delay_samples, 240.0); // 5 ms trotz Totband 10
    }

    #[test]
    fn off_and_no_held_value_do_nothing() {
        let mut a = s(AvsyncMode::Off);
        a.held_ms = Some(80.0);
        assert_eq!(a.decide(40.0, 48_000, 12).unwrap().audio_delay_samples, 0.0);
        let b = s(AvsyncMode::Once);
        assert_eq!(b.decide(40.0, 48_000, 12).unwrap().audio_delay_samples, 0.0);
    }

    #[test]
    fn tracking_is_rejected() {
        let a = s(AvsyncMode::Tracking);
        assert!(a.decide(40.0, 48_000, 12).unwrap_err().contains("nicht umgesetzt"));
    }

    #[test]
    fn too_large_for_ring_is_reported() {
        let mut a = s(AvsyncMode::Once);
        a.held_ms = Some(-1000.0);
        let r = a.decide(40.0, 48_000, 12).unwrap();
        assert_eq!(r.video_delay_frames, 12);
        assert!(r.exceeds_range);
        a.held_ms = Some(-400.0);
        assert!(!a.decide(40.0, 48_000, 12).unwrap().exceeds_range);
    }
}
