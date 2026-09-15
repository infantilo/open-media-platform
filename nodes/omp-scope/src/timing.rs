//! Zeit-/Kadenz-Messung auf einem MXL-Lesepfad (Nutzerauftrag
//! 2026-09-15: „MXL-spezifische Messungen ... Audio-/Video-Timing,
//! Latenz messen (Lipsync, Source-Timestamps vergleichen)").
//!
//! **Woher die Messgröße kommt (gemessen, nicht geschätzt):** jeder von
//! `omp_mediaio::mxl`s Lesepfaden hängt an JEDEN gelesenen Puffer eine
//! `GstReferenceTimestampMeta` mit den Caps `timestamp/x-mxl-tai`
//! (`omp_mediaio::mxl::tai_reference_caps`) — darin steht der
//! **Ursprungs-Zeitstempel des Grains** (`mxlIndexToTimestamp` des
//! Grain-Index, also die Zeit, für die der SCHREIBER diesen Grain
//! deklariert hat). Zusammen mit `MxlContext::now_ns()` (`mxlGetTime()`,
//! dieselbe Epoche) ergibt das pro Grain eine echte Messung:
//!
//! ```text
//! Transportlatenz = now_ns (Ankunft am Tap) − Grain-TAI (Ursprung)
//! ```
//!
//! Beides stammt aus derselben MXL-Zeitquelle — bewusst NICHT aus
//! `std::time::SystemTime` (andere Epoche: UTC statt TAI, Differenz =
//! Schaltsekunden) und NICHT aus GStreamer-PTS (die MXL-Lesepfade setzen
//! `do-timestamp=true`, deren PTS ist damit die lokale ANKUNFTSzeit,
//! enthält also gar keine Ursprungsinformation mehr).
//!
//! **Lipsync (`av_offset_ms`)** ist genau die Differenz dieser beiden
//! Transportlatenzen — der Trick dabei: die (konstante, unbekannte)
//! Umrechnung zwischen Uhren kürzt sich weg, und die beiden Flows müssen
//! NICHT im selben Moment abgetastet werden:
//!
//! ```text
//! Δ = (Ankunft_V − Ursprung_V) − (Ankunft_A − Ursprung_A)
//! ```
//!
//! Δ > 0 heißt: Video braucht länger durch das System als Audio, bezogen
//! auf die Zeitstempel, die die Quelle beiden mitgegeben hat → **der Ton
//! eilt dem Bild voraus**. Δ < 0 → der Ton hinkt nach.
//!
//! **Was diese Messung ehrlicherweise NICHT leistet:** sie misst den
//! Versatz, den die MXL-TAI-Zeitstempel der beiden Flows beschreiben —
//! sie kann nicht erkennen, ob eine Quelle Video und Audio schon
//! gegeneinander verschoben *stempelt* (z. B. `MxlVideoOutput`s
//! dokumentierter Vereinfachungspfad, der den Grain-Index bei der ersten
//! Sample aus `get_current_index()` setzt statt aus der PTS). Genau
//! solche Stempel-Fehler macht sie aber SICHTBAR, statt sie unbemerkt
//! zu lassen — der Messwert ist der Versatz „wie die Zeitstempel ihn
//! behaupten", und wenn der von der Realität abweicht, liegt der Fehler
//! nachweisbar beim Schreiber.

/// Länge des gleitenden Messfensters für Min/Max/Jitter. Lifetime-Zähler
/// (Grains/Drops/Diskontinuitäten) laufen davon unberührt weiter — ein
/// Messgerät soll „seit wann läuft das schon schief" zeigen können, aber
/// eine Latenzspitze von vor zehn Minuten darf den aktuellen Jitterwert
/// nicht für immer verfälschen.
const WINDOW_NS: u64 = 2_000_000_000;

/// Ab welchem Vielfachen der Soll-Periode eine Lücke als übersprungene
/// Grains gilt. 1,5 statt 2,0: bei exakt einem fehlenden Grain ist die
/// gemessene Lücke genau 2× Soll — der Schwellwert muss darunter liegen,
/// sonst bliebe ausgerechnet der häufigste Fall (genau ein Drop)
/// unerkannt.
const DROP_THRESHOLD_FACTOR: f64 = 1.5;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TimingSnapshot {
    /// Zuletzt gemessene Transportlatenz (Grain-Alter am Tap).
    pub latency_ms: Option<f64>,
    /// Geglättete Latenz (EWMA) — Grundlage der Lipsync-Rechnung, damit
    /// ein einzelner verzögerter Grain den A/V-Versatz nicht springen
    /// lässt.
    pub latency_avg_ms: Option<f64>,
    /// Min/Max im gleitenden Fenster (`WINDOW_NS`).
    pub latency_min_ms: Option<f64>,
    pub latency_max_ms: Option<f64>,
    /// Spitze-zu-Spitze-Schwankung der Latenz im Fenster (`max − min`) —
    /// die klassische Delay-Variation, hier auf MXL-Grains statt auf
    /// RTP-Paketen.
    pub jitter_ms: Option<f64>,
    /// Gemessener mittlerer Ursprungs-Abstand aufeinanderfolgender
    /// Grains im Fenster (Ist-Kadenz).
    pub cadence_ms: Option<f64>,
    /// Soll-Abstand laut Flow-Rate (Grain-Rate bzw. Audio-Batch-Dauer).
    pub nominal_cadence_ms: Option<f64>,
    /// Seit Verbindungsaufbau übersprungene Grains (Lücke > 1,5 × Soll).
    pub dropped: u64,
    /// Seit Verbindungsaufbau beobachtete Rückwärts-/Reset-Sprünge des
    /// Ursprungs-Zeitstempels (MXL-Reader-Neuaufsetzer, z. B. nach
    /// `OutOfRangeTooLate` oder `FLOW_INVALID`).
    pub discontinuities: u64,
    /// Seit Verbindungsaufbau beobachtete Grains.
    pub grains: u64,
    /// Zuletzt gesehener Ursprungs-Zeitstempel (MXL-TAI, ns).
    pub last_tai_ns: Option<u64>,
}

/// Zustand eines Flow-Taps. Wird aus einem GStreamer-Pad-Probe heraus
/// gefüttert (`observe`) und aus dem HTTP-Thread gelesen (`snapshot`).
#[derive(Debug, Default)]
pub struct FlowTiming {
    nominal_period_ns: Option<u64>,
    last_tai_ns: Option<u64>,
    latency_ns: Option<i64>,
    latency_avg_ns: Option<f64>,
    window_start_ns: Option<u64>,
    window_min_ns: Option<i64>,
    window_max_ns: Option<i64>,
    window_span_sum_ns: u64,
    window_span_count: u64,
    cadence_ms: Option<f64>,
    dropped: u64,
    discontinuities: u64,
    grains: u64,
}

/// Glättungsfaktor der Latenz-EWMA. 0,05 ≈ Zeitkonstante von 20 Grains
/// (bei 25 fps also knapp eine Sekunde) — träge genug, dass die
/// Lipsync-Anzeige nicht zappelt, schnell genug, dass ein echter
/// Versatzsprung binnen ~1 s sichtbar wird.
const EWMA_ALPHA: f64 = 0.05;

impl FlowTiming {
    /// Setzt die Soll-Kadenz (Grain-Rate bei Video, Batch-Dauer bei
    /// Audio). Ohne sie werden Drops nicht gezählt (ohne Sollwert gibt es
    /// keine Lücke, nur einen Abstand) — alles andere misst trotzdem.
    pub fn set_nominal_period_ns(&mut self, period_ns: u64) {
        if period_ns > 0 {
            self.nominal_period_ns = Some(period_ns);
        }
    }

    /// Verwirft allen Messzustand (neuer Verbindungsaufbau). Absichtlich
    /// inklusive der Lifetime-Zähler: „12 Drops" einer VORIGEN Quelle an
    /// einer neuen anzuzeigen wäre eine Falschaussage, kein Verlauf.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Ein gelesener Grain: `tai_ns` ist sein Ursprungs-Zeitstempel aus
    /// der `timestamp/x-mxl-tai`-Meta, `now_ns` die MXL-Zeit beim
    /// Durchlaufen des Probes.
    pub fn observe(&mut self, tai_ns: u64, now_ns: u64) {
        self.grains += 1;
        let latency = now_ns as i64 - tai_ns as i64;
        self.latency_ns = Some(latency);
        self.latency_avg_ns = Some(match self.latency_avg_ns {
            Some(avg) => avg * (1.0 - EWMA_ALPHA) + latency as f64 * EWMA_ALPHA,
            None => latency as f64,
        });

        if let Some(last) = self.last_tai_ns {
            if tai_ns <= last {
                // Rückwärts oder Stillstand: MXL-Reader hat neu
                // aufgesetzt (s. `read_loop`s `OutOfRangeTooLate`/
                // `FLOW_INVALID`-Zweige) — als Diskontinuität zählen,
                // NICHT als negative Kadenz in die Statistik geben.
                self.discontinuities += 1;
            } else {
                let span = tai_ns - last;
                self.window_span_sum_ns += span;
                self.window_span_count += 1;
                if let Some(nominal) = self.nominal_period_ns
                    && span as f64 > nominal as f64 * DROP_THRESHOLD_FACTOR
                {
                    // Auf ganze Grains gerundet: eine Lücke von n × Soll
                    // bedeutet n−1 übersprungene Grains.
                    let missed = (span as f64 / nominal as f64).round() as u64;
                    self.dropped += missed.saturating_sub(1);
                }
            }
        }
        self.last_tai_ns = Some(tai_ns);

        match self.window_start_ns {
            Some(start) if now_ns.saturating_sub(start) >= WINDOW_NS => {
                self.cadence_ms = mean_ms(self.window_span_sum_ns, self.window_span_count);
                self.window_start_ns = Some(now_ns);
                self.window_min_ns = Some(latency);
                self.window_max_ns = Some(latency);
                self.window_span_sum_ns = 0;
                self.window_span_count = 0;
            }
            Some(_) => {
                self.window_min_ns = Some(self.window_min_ns.map_or(latency, |v| v.min(latency)));
                self.window_max_ns = Some(self.window_max_ns.map_or(latency, |v| v.max(latency)));
            }
            None => {
                self.window_start_ns = Some(now_ns);
                self.window_min_ns = Some(latency);
                self.window_max_ns = Some(latency);
            }
        }
    }

    pub fn snapshot(&self) -> TimingSnapshot {
        let min = self.window_min_ns.map(ns_to_ms);
        let max = self.window_max_ns.map(ns_to_ms);
        TimingSnapshot {
            latency_ms: self.latency_ns.map(ns_to_ms),
            latency_avg_ms: self.latency_avg_ns.map(|v| v / 1e6),
            latency_min_ms: min,
            latency_max_ms: max,
            jitter_ms: match (min, max) {
                (Some(min), Some(max)) => Some(max - min),
                _ => None,
            },
            // Solange das erste Fenster noch läuft, gibt es keinen
            // abgeschlossenen Mittelwert — dann den laufenden nehmen
            // statt "–" anzuzeigen (ein Messgerät, das die erste
            // Sekunde nichts sagt, wirkt kaputt).
            cadence_ms: self.cadence_ms.or_else(|| mean_ms(self.window_span_sum_ns, self.window_span_count)),
            nominal_cadence_ms: self.nominal_period_ns.map(|ns| ns as f64 / 1e6),
            dropped: self.dropped,
            discontinuities: self.discontinuities,
            grains: self.grains,
            last_tai_ns: self.last_tai_ns,
        }
    }
}

fn ns_to_ms(ns: i64) -> f64 {
    ns as f64 / 1e6
}

fn mean_ms(sum_ns: u64, count: u64) -> Option<f64> {
    (count > 0).then(|| sum_ns as f64 / count as f64 / 1e6)
}

/// A/V-Versatz am Tap: positiv = Ton eilt dem Bild voraus (Video braucht
/// länger durch das System), negativ = Ton hinkt nach. Siehe Moduldoku
/// für die Herleitung.
pub fn av_offset_ms(video: &TimingSnapshot, audio: &TimingSnapshot) -> Option<f64> {
    Some(video.latency_avg_ms? - audio.latency_avg_ms?)
}

/// Bewertung nach **EBU R 37** („The relative timing of the sound and
/// vision components of a television signal", 2007): der Ton darf dem
/// Bild um höchstens **40 ms voraus** eilen und um höchstens **60 ms
/// nachhinken**. Bewusst asymmetrisch — das entspricht der Norm, nicht
/// einem selbst gewählten Toleranzband (Nachhinken ist für Zuschauer
/// deutlich weniger störend, weil es dem natürlichen Laufzeitunterschied
/// von Schall gegenüber Licht entspricht).
pub const R37_AUDIO_LEAD_LIMIT_MS: f64 = 40.0;
pub const R37_AUDIO_LAG_LIMIT_MS: f64 = 60.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncVerdict {
    /// Noch keine Messung (mindestens einer der beiden Flows fehlt).
    Unknown,
    InSpec,
    OutOfSpec,
}

impl SyncVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncVerdict::Unknown => "unbekannt",
            SyncVerdict::InSpec => "innerhalb EBU R 37",
            SyncVerdict::OutOfSpec => "außerhalb EBU R 37",
        }
    }
}

pub fn sync_verdict(offset_ms: Option<f64>) -> SyncVerdict {
    match offset_ms {
        None => SyncVerdict::Unknown,
        Some(offset) if (-R37_AUDIO_LAG_LIMIT_MS..=R37_AUDIO_LEAD_LIMIT_MS).contains(&offset) => SyncVerdict::InSpec,
        Some(_) => SyncVerdict::OutOfSpec,
    }
}

/// Versatz in Bildern statt Millisekunden — die Einheit, in der ein
/// Bildtechniker denkt. Braucht die Ist-Bildrate des Videoflows.
pub fn av_offset_frames(offset_ms: Option<f64>, video_nominal_cadence_ms: Option<f64>) -> Option<f64> {
    let cadence = video_nominal_cadence_ms?;
    if cadence <= 0.0 {
        return None;
    }
    Some(offset_ms? / cadence)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;

    /// 25 fps.
    const FRAME_NS: u64 = 40 * MS;

    fn feed(t: &mut FlowTiming, count: u64, latency_ms: u64) {
        for i in 0..count {
            let tai = 1_000_000_000 + i * FRAME_NS;
            t.observe(tai, tai + latency_ms * MS);
        }
    }

    #[test]
    fn misst_konstante_latenz_ohne_jitter() {
        let mut t = FlowTiming::default();
        t.set_nominal_period_ns(FRAME_NS);
        feed(&mut t, 25, 12);
        let s = t.snapshot();
        assert_eq!(s.grains, 25);
        assert_eq!(s.latency_ms, Some(12.0));
        assert_eq!(s.jitter_ms, Some(0.0));
        assert_eq!(s.dropped, 0);
        assert_eq!(s.discontinuities, 0);
        assert_eq!(s.cadence_ms, Some(40.0));
        assert_eq!(s.nominal_cadence_ms, Some(40.0));
    }

    #[test]
    fn ewma_zieht_zur_neuen_latenz_ohne_zu_springen() {
        let mut t = FlowTiming::default();
        t.set_nominal_period_ns(FRAME_NS);
        feed(&mut t, 200, 10);
        let settled = t.snapshot().latency_avg_ms.expect("avg");
        assert!((settled - 10.0).abs() < 0.1, "EWMA sollte auf 10 ms einschwingen, war {settled}");

        // Ein einzelner Ausreißer darf den Mittelwert nur leicht
        // bewegen — genau dafür ist die Glättung da.
        t.observe(1_000_000_000 + 200 * FRAME_NS, 1_000_000_000 + 200 * FRAME_NS + 500 * MS);
        let after = t.snapshot();
        assert_eq!(after.latency_ms, Some(500.0));
        let avg = after.latency_avg_ms.expect("avg");
        assert!(avg > settled && avg < settled + 30.0, "Ausreißer zog den Mittelwert auf {avg}");
    }

    #[test]
    fn zaehlt_genau_einen_ausgelassenen_grain() {
        let mut t = FlowTiming::default();
        t.set_nominal_period_ns(FRAME_NS);
        let base = 1_000_000_000u64;
        t.observe(base, base + 5 * MS);
        // Index +2 statt +1 → genau ein Grain fehlt.
        t.observe(base + 2 * FRAME_NS, base + 2 * FRAME_NS + 5 * MS);
        assert_eq!(t.snapshot().dropped, 1);
        // Weitere Lücke von 4 Grains → +3.
        t.observe(base + 6 * FRAME_NS, base + 6 * FRAME_NS + 5 * MS);
        assert_eq!(t.snapshot().dropped, 4);
    }

    #[test]
    fn rueckwaertssprung_ist_diskontinuitaet_keine_negative_kadenz() {
        let mut t = FlowTiming::default();
        t.set_nominal_period_ns(FRAME_NS);
        let base = 10_000_000_000u64;
        t.observe(base, base + 5 * MS);
        t.observe(base - FRAME_NS, base + 45 * MS);
        let s = t.snapshot();
        assert_eq!(s.discontinuities, 1);
        assert_eq!(s.dropped, 0);
        assert!(s.cadence_ms.is_none(), "Rückwärtssprung darf keine Kadenz liefern, war {:?}", s.cadence_ms);
    }

    #[test]
    fn jitter_ist_spitze_zu_spitze_der_latenz() {
        let mut t = FlowTiming::default();
        t.set_nominal_period_ns(FRAME_NS);
        let base = 1_000_000_000u64;
        for (i, lat) in [8u64, 20, 8, 14].into_iter().enumerate() {
            let tai = base + i as u64 * FRAME_NS;
            t.observe(tai, tai + lat * MS);
        }
        assert_eq!(t.snapshot().jitter_ms, Some(12.0));
    }

    #[test]
    fn lipsync_kuerzt_die_gemeinsame_uhr_weg() {
        // Video braucht 45 ms durch das System, Audio 20 ms — der Ton
        // eilt also um 25 ms voraus, unabhängig davon, zu welchen
        // Zeitpunkten die beiden Flows abgetastet wurden.
        let mut v = FlowTiming::default();
        v.set_nominal_period_ns(FRAME_NS);
        feed(&mut v, 400, 45);
        let mut a = FlowTiming::default();
        a.set_nominal_period_ns(10 * MS);
        for i in 0..2000u64 {
            let tai = 7_777_000_000 + i * 10 * MS;
            a.observe(tai, tai + 20 * MS);
        }
        let offset = av_offset_ms(&v.snapshot(), &a.snapshot()).expect("offset");
        assert!((offset - 25.0).abs() < 0.5, "erwartet ~+25 ms, war {offset}");
        assert_eq!(sync_verdict(Some(offset)), SyncVerdict::InSpec);
        let frames = av_offset_frames(Some(offset), Some(40.0)).expect("frames");
        assert!((frames - 0.625).abs() < 0.02, "erwartet ~0,625 Bilder, war {frames}");
    }

    #[test]
    fn ebu_r37_grenzen_sind_asymmetrisch() {
        assert_eq!(sync_verdict(None), SyncVerdict::Unknown);
        assert_eq!(sync_verdict(Some(39.0)), SyncVerdict::InSpec);
        assert_eq!(sync_verdict(Some(41.0)), SyncVerdict::OutOfSpec);
        assert_eq!(sync_verdict(Some(-59.0)), SyncVerdict::InSpec);
        assert_eq!(sync_verdict(Some(-61.0)), SyncVerdict::OutOfSpec);
    }

    #[test]
    fn reset_verwirft_auch_lifetime_zaehler() {
        let mut t = FlowTiming::default();
        t.set_nominal_period_ns(FRAME_NS);
        let base = 1_000_000_000u64;
        t.observe(base, base + 5 * MS);
        t.observe(base + 3 * FRAME_NS, base + 3 * FRAME_NS + 5 * MS);
        assert_eq!(t.snapshot().dropped, 2);
        t.reset();
        let s = t.snapshot();
        assert_eq!(s.dropped, 0);
        assert_eq!(s.grains, 0);
        assert_eq!(s.latency_ms, None);
    }
}
