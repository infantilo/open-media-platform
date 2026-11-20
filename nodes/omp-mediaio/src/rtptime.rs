//! RTP-Zeitstempel → Zeit der Uhr (UMSETZUNG 106.8). ST 2110-10 und ST 2059-1 binden den 32-Bit-RTP-Zeitstempel an die
//! PTP-Zeit der Abtastung (Ticks der Taktrate, modulo 2^32); Abschnittsnummern werden hier **nicht** zitiert (Normtext
//! nicht lesbar, siehe `docs/entwuerfe/ENTWURF-MCR.md` §3). Die Funktionen sind rein und kennen keine Uhr: der Aufrufer
//! gibt die aktuelle Zeit derselben Uhr mit, mit der der Sender gestempelt hat.

/// Fehler bei der Zuordnung.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RtpTimeError {
    /// Taktrate 0.
    BadRate,
    /// Der aufgelöste Zeitpunkt liegt weiter als `max_skew_ns` neben der aktuellen Uhrzeit: Sender- und Empfängeruhr passen
    /// nicht zusammen (oder der Strom ist nicht an die PTP-Zeit gebunden).
    ClockMismatch { skew_ns: i64 },
}

const WRAP: u128 = 1 << 32;

/// Löst den 32-Bit-Überlauf gegen die aktuelle Zeit auf: Gibt den Zeitpunkt (ns auf der Uhr) zurück, der zum Zeitstempel
/// passt und der aktuellen Zeit am nächsten liegt. Liegt er weiter als `max_skew_ns` weg → `ClockMismatch`.
///
/// Der Überlaufbereich ist bei 90 kHz ≈ 47,7 h, bei 48 kHz ≈ 24,9 h; `max_skew_ns` muss darunter liegen (der Aufrufer
/// wählt z. B. 10 s, ein Strom mit mehr Abstand ist ohnehin nicht live).
pub fn rtp_to_clock_ns(rtp_ts: u32, clock_rate: u32, now_ns: u64, max_skew_ns: u64) -> Result<u64, RtpTimeError> {
    if clock_rate == 0 {
        return Err(RtpTimeError::BadRate);
    }
    let rate = clock_rate as u128;
    let now_ticks = now_ns as u128 * rate / 1_000_000_000;
    let base = now_ticks & !(WRAP - 1);
    let mut best: Option<(u128, i128)> = None;
    for cand in [base.wrapping_sub(WRAP), base, base + WRAP] {
        if cand > base + WRAP * 2 {
            continue; // wrapping_sub unter 0
        }
        let ticks = cand + rtp_ts as u128;
        let d = ticks as i128 - now_ticks as i128;
        if best.is_none_or(|(_, bd)| d.abs() < bd.abs()) {
            best = Some((ticks, d));
        }
    }
    let (ticks, _) = best.expect("immer ein Kandidat");
    let ns = (ticks * 1_000_000_000 / rate) as u64;
    let skew = ns as i64 - now_ns as i64;
    if skew.unsigned_abs() > max_skew_ns {
        return Err(RtpTimeError::ClockMismatch { skew_ns: skew });
    }
    Ok(ns)
}

/// Grain-/Sample-Index zum Zeitstempel: `index = ns · rate_num / (rate_den · 1e9)`.
pub fn rtp_to_tai_index(rtp_ts: u32, clock_rate: u32, ptp_now_ns: u64, grain_num: u64, grain_den: u64, max_skew_ns: u64) -> Result<u64, RtpTimeError> {
    let ns = rtp_to_clock_ns(rtp_ts, clock_rate, ptp_now_ns, max_skew_ns)?;
    Ok((ns as u128 * grain_num as u128 / (grain_den.max(1) as u128 * 1_000_000_000)) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 1_000_000_000;

    fn ts_of(ns: u64, rate: u32) -> u32 {
        ((ns as u128 * rate as u128 / 1_000_000_000) & 0xFFFF_FFFF) as u32
    }

    #[test]
    fn plain_case_90khz_and_48khz() {
        for rate in [90_000u32, 48_000] {
            let now = 1_700_000_000 * S + 123_456_789;
            let sample = now - 40_000_000; // 40 ms zuvor abgetastet
            let got = rtp_to_clock_ns(ts_of(sample, rate), rate, now, 10 * S).unwrap();
            assert!((got as i64 - sample as i64).abs() < 100_000, "{rate}: {got} vs {sample}");
        }
    }

    #[test]
    fn around_the_wrap_90khz() {
        // Zeit, bei der der Zähler genau überläuft: 2^32 Ticks bei 90 kHz.
        let wrap_ns = (WRAP * 1_000_000_000 / 90_000) as u64 * 5; // 5. Überlauf
        for dt in [-50_000_000i64, -1_000_000, 0, 1_000_000, 50_000_000] {
            let sample = (wrap_ns as i64 + dt) as u64;
            // Empfänger sieht „jetzt“ 10 ms nach der Abtastung — auf beiden Seiten des Überlaufs
            let now = sample + 10_000_000;
            let got = rtp_to_clock_ns(ts_of(sample, 90_000), 90_000, now, 10 * S).unwrap();
            assert!((got as i64 - sample as i64).abs() < 100_000, "dt {dt}: {got} vs {sample}");
        }
    }

    #[test]
    fn around_the_wrap_48khz() {
        let wrap_ns = (WRAP * 1_000_000_000 / 48_000) as u64 * 3;
        for dt in [-30_000_000i64, -1, 0, 1, 30_000_000] {
            let sample = (wrap_ns as i64 + dt) as u64;
            let now = sample + 5_000_000;
            let got = rtp_to_clock_ns(ts_of(sample, 48_000), 48_000, now, 10 * S).unwrap();
            assert!((got as i64 - sample as i64).abs() < 100_000);
        }
    }

    #[test]
    fn near_zero_does_not_underflow() {
        let got = rtp_to_clock_ns(ts_of(10_000_000, 90_000), 90_000, 20_000_000, 10 * S).unwrap();
        assert!((got as i64 - 10_000_000).abs() < 100_000);
        // Zeitstempel „in der Zukunft“ nahe Null (Sender 5 ms voraus)
        let got = rtp_to_clock_ns(ts_of(25_000_000, 90_000), 90_000, 20_000_000, 10 * S).unwrap();
        assert!((got as i64 - 25_000_000).abs() < 100_000);
    }

    #[test]
    fn wrong_clock_is_reported() {
        // Sender-Uhr 1 h neben unserer: weit außerhalb der erlaubten Abweichung
        let now = 1_000_000 * S;
        let sample = now + 3_600 * S;
        let e = rtp_to_clock_ns(ts_of(sample, 90_000), 90_000, now, 10 * S).unwrap_err();
        assert!(matches!(e, RtpTimeError::ClockMismatch { .. }), "{e:?}");
        // Rate 0
        assert_eq!(rtp_to_clock_ns(1, 0, now, S).unwrap_err(), RtpTimeError::BadRate);
    }

    #[test]
    fn index_from_timestamp() {
        let now = 1_000 * S;
        let sample = 999 * S + 520_000_000; // bei 25 Bildern/s: Index 24 988 (= 999,52 · 25)
        let i = rtp_to_tai_index(ts_of(sample, 90_000), 90_000, now, 25, 1, 10 * S).unwrap();
        assert_eq!(i, 24_988);
    }
}
