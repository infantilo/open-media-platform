//! Bildratenwandlung: `videorate` (Bilder verwerfen/verdoppeln, Standard)
//! oder `blend` (Bilder überblenden) über das GStreamer-Plugin
//! `avvideofilter` (Fremdprojekt von emcodem, <https://github.com/emcodem/avvideofilter>,
//! LGPL-2.1+, bringt ein eigenes FFmpeg mit; Filter `framerate`). Plugin und
//! Idee des optionalen, rückfallsicheren Modus stammen von emcodem
//! (s. `THIRD-PARTY-NOTICES.md`). Gleiche Idee und gleicher
//! Rückfall wie im PIPELINE CONTROLLER (`lib/FrameRateChain.js`): fehlt das
//! Plugin oder lässt es sich nicht laden (zu alte glibc/GStreamer), läuft
//! der Node mit `videorate` weiter — nichts bricht.
//!
//! Das Plugin kennt kein `v210`; der Aufrufer legt die Stufe deshalb VOR die
//! Wandlung nach v210 (`I422_10LE`, verlustfrei zu v210).

use gstreamer as gst;
use std::sync::OnceLock;

/// Gewünschte Wandlung (Konfiguration, noch nicht gegen das Plugin geprüft).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum RateMode {
    #[default]
    Videorate,
    Blend,
}

impl RateMode {
    /// `blend` (ohne Beachtung der Groß-/Kleinschreibung) → `Blend`, alles
    /// andere (auch leer) → `Videorate`.
    pub fn parse(s: &str) -> Self {
        if s.trim().eq_ignore_ascii_case("blend") { Self::Blend } else { Self::Videorate }
    }

    /// Liest `OMP_FRAMERATE_CONVERSION`.
    pub fn from_env() -> Self {
        Self::parse(&std::env::var("OMP_FRAMERATE_CONVERSION").unwrap_or_default())
    }

    /// Tatsächlich genutzter Modus: `Blend` nur, wenn das Plugin da ist.
    pub fn effective(self) -> Self {
        if self == Self::Blend && avvideofilter_available() { Self::Blend } else { Self::Videorate }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Videorate => "videorate",
            Self::Blend => "blend",
        }
    }
}

/// Ist das Element `avvideofilter` ladbar? Einmal je Prozess geprüft (ein
/// Plugin, das nicht lädt, taucht in der Registry nicht auf). Meldet beim
/// ersten Aufruf einmal auf stderr, wenn der Rückfall greift.
pub fn avvideofilter_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    // `gst::init()` ist idempotent: die Prüfung läuft auch in `main()` vor dem Pipeline-Thread (Scaler),
    // ohne Init paniert `ElementFactory::find` (live gefunden, nicht von den Tests erfasst).
    *AVAILABLE.get_or_init(|| gst::init().is_ok() && gst::ElementFactory::find("avvideofilter").is_some())
}

/// Wie [`RateMode::effective`], meldet aber einmalig, wenn `Blend`
/// gewünscht war und das Plugin fehlt.
pub fn resolve(requested: RateMode) -> RateMode {
    let eff = requested.effective();
    if requested != eff {
        static WARNED: OnceLock<()> = OnceLock::new();
        WARNED.get_or_init(|| {
            eprintln!("omp: OMP_FRAMERATE_CONVERSION=blend, aber Plugin 'avvideofilter' nicht ladbar — Rückfall auf videorate (Installation: docs/INSTALLATION.md)");
        });
    }
    eff
}

/// Gleiche Bildrate (als Bruch, ohne Kürzen verglichen)? Dann ist keine Wandlung nötig und die
/// Blend-Stufe wird weggelassen — sie würde nur Latenz (gemessen ~1 Bild) und CPU kosten.
pub fn same_rate(a_num: u32, a_den: u32, b_num: u32, b_den: u32) -> bool {
    a_den != 0 && b_den != 0 && (a_num as u64) * (b_den as u64) == (b_num as u64) * (a_den as u64)
}

/// Filterbeschreibung für `avvideofilter` (`framerate=fps=N/D`).
pub fn blend_filter_desc(num: u32, den: u32) -> String {
    format!("framerate=fps={}/{}", num, den.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_modes() {
        assert_eq!(RateMode::parse("blend"), RateMode::Blend);
        assert_eq!(RateMode::parse(" Blend "), RateMode::Blend);
        assert_eq!(RateMode::parse(""), RateMode::Videorate);
        assert_eq!(RateMode::parse("videorate"), RateMode::Videorate);
        assert_eq!(RateMode::parse("quatsch"), RateMode::Videorate);
    }

    #[test]
    fn filter_desc_uses_fraction() {
        assert_eq!(blend_filter_desc(30000, 1001), "framerate=fps=30000/1001");
        assert_eq!(blend_filter_desc(25, 0), "framerate=fps=25/1");
    }

    #[test]
    fn same_rate_compares_fractions() {
        assert!(same_rate(25, 1, 25, 1));
        assert!(same_rate(50, 2, 25, 1));
        assert!(!same_rate(30000, 1001, 30, 1));
        assert!(!same_rate(25, 0, 25, 1));
    }

    #[test]
    fn availability_check_initialises_gstreamer_itself() {
        // darf ohne vorheriges gst::init() nicht paniert (Scaler ruft es in main() davor auf)
        let _ = avvideofilter_available();
        let _ = resolve(RateMode::Blend);
    }

    #[test]
    fn videorate_is_always_effective() {
        assert_eq!(RateMode::Videorate.effective(), RateMode::Videorate);
    }
}
