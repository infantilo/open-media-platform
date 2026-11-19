//! Zeit in MPEG-TS-Segmenten (TAMS-AppNote 0002).
//!
//! PTS/DTS sind 33 Bit auf einer 90-kHz-Zeitbasis (ISO/IEC 13818-1) und laufen etwa alle 26,5 Stunden über.
//! TAMS trägt die oberen Bits im `ts_offset` des Segments: absolute Zeit = `ts_offset + PTS/90000`.
//!
//! * Schreiben: [`ts_offset_for`] bildet aus der absoluten Zeit des ersten Bildes den `ts_offset`
//!   (`C_offset = C_abs − (C_abs & 0x1_FFFF_FFFF)`).
//! * Lesen: [`PtsUnwrapper`] setzt PTS-Werte wieder zu absoluten Zeiten zusammen und erkennt einen Überlauf
//!   mitten im Segment (PTS wird kleiner, vorheriger Wert > 2^33 − 2^31).
//!
//! **Abweichung vom Beispielcode der AppNote:** Dort wird bei einem Überlauf `(2^33−1)/90000` Sekunden addiert. Der
//! 33-Bit-Zähler läuft aber nach **2^33** Ticks über, und `C_offset` ist ein Vielfaches von 2^33 (siehe oben).
//! Wir addieren deshalb **2^33 Ticks**; mit 2^33−1 wäre die Zeit nach einem Überlauf um einen Tick (11 µs) falsch.

use crate::time::Timestamp;

/// Zeitbasis in Hz.
pub const PTS_HZ: u64 = 90_000;
/// 33-Bit-Zähler: Anzahl der Werte.
pub const PTS_MODULUS: u64 = 1 << 33;
const PTS_MASK: u64 = PTS_MODULUS - 1;

/// Ticks (90 kHz) → Nanosekunden, auf die nächste Nanosekunde gerundet.
pub fn ticks_to_ns(ticks: u64) -> i128 {
    ((ticks as i128) * 1_000_000_000 + (PTS_HZ as i128) / 2) / PTS_HZ as i128
}

/// Nanosekunden → Ticks (90 kHz), auf den nächsten Tick gerundet. `None` bei negativer Zeit.
pub fn ns_to_ticks(ns: i128) -> Option<u64> {
    if ns < 0 {
        return None;
    }
    let t = (ns * PTS_HZ as i128 + 500_000_000) / 1_000_000_000;
    u64::try_from(t).ok()
}

/// `ts_offset` für ein Segment, dessen erstes Bild die absolute Präsentationszeit `first_pts_abs` hat.
/// Es gilt dann `ts_offset + (first_pts_abs & 33 Bit)/90000 ≈ first_pts_abs`.
pub fn ts_offset_for(first_pts_abs: Timestamp) -> Option<Timestamp> {
    let abs_ticks = ns_to_ticks(first_pts_abs.ns())?;
    let offset_ticks = abs_ticks - (abs_ticks & PTS_MASK);
    Some(Timestamp::from_ns(ticks_to_ns(offset_ticks)))
}

/// Der PTS-Wert (33 Bit), mit dem ein Schreiber die absolute Zeit in den Strom schreibt.
pub fn pts_for(abs: Timestamp) -> Option<u64> {
    ns_to_ticks(abs.ns()).map(|t| t & PTS_MASK)
}

/// Rekonstruiert absolute Zeiten aus PTS/DTS-Werten eines Segments (Reihenfolge der Präsentation oder des Stroms).
///
/// `ts_offset` bleibt in Nanosekunden **unverändert** (er darf beliebig sein, auch kein Vielfaches von 2^33 Ticks:
/// ein Schreiber legt ihn als „Segmentzeit − Containerzeit“ fest); gerundet wird nur je PTS-Wert.
#[derive(Debug, Clone)]
pub struct PtsUnwrapper {
    offset_ns: i128,
    wraps: u64,
    last: Option<u64>,
}

impl PtsUnwrapper {
    pub fn new(ts_offset: Timestamp) -> Self {
        PtsUnwrapper { offset_ns: ts_offset.ns(), wraps: 0, last: None }
    }

    /// Absolute Zeit für den nächsten PTS-Wert (0…2^33−1). Werte außerhalb des Bereichs werden abgeschnitten.
    pub fn absolute(&mut self, pts: u64) -> Timestamp {
        let pts = pts & PTS_MASK;
        if let Some(last) = self.last
            && pts < last
            && last > PTS_MODULUS - (1 << 31)
        {
            self.wraps += 1;
        }
        self.last = Some(pts);
        Timestamp::from_ns(self.offset_ns + ticks_to_ns(pts + self.wraps * PTS_MODULUS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollover_period_is_about_26_5_hours() {
        let secs = PTS_MODULUS as f64 / PTS_HZ as f64;
        assert!((secs / 3600.0 - 26.5).abs() < 0.1, "{}", secs / 3600.0);
    }

    #[test]
    fn tick_conversions() {
        assert_eq!(ticks_to_ns(90_000), 1_000_000_000);
        assert_eq!(ticks_to_ns(1), 11_111); // 11 111,1 ns
        assert_eq!(ns_to_ticks(1_000_000_000), Some(90_000));
        assert_eq!(ns_to_ticks(-1), None);
        // ein 25-Hz-Bild = 3600 Ticks
        assert_eq!(ns_to_ticks(40_000_000), Some(3600));
    }

    #[test]
    fn offset_and_pts_reconstruct_the_absolute_time() {
        // heutige TAI-Zeit, auf 25-Hz-Bildraster
        for secs in [0u64, 1, 95_443, 1_790_000_000, 1_790_000_123] {
            for frame in [0u64, 1, 7, 24] {
                let abs = Timestamp::from_ns(secs as i128 * 1_000_000_000 + frame as i128 * 40_000_000);
                let off = ts_offset_for(abs).unwrap();
                let pts = pts_for(abs).unwrap();
                let mut u = PtsUnwrapper::new(off);
                let back = u.absolute(pts);
                // gleiche Rundung auf Ticks → Abweichung höchstens 1 ns (Tick-Auflösung 11 µs wird gerundet)
                let tick_ns = 11_112i128;
                assert!((back.ns() - abs.ns()).abs() <= tick_ns / 2 + 1, "{secs} {frame}: {back} vs {abs}");
            }
        }
    }

    #[test]
    fn offset_is_a_multiple_of_the_rollover_period() {
        let abs = Timestamp::from_ns(1_790_000_000_000_000_000);
        let off = ts_offset_for(abs).unwrap();
        let ticks = ns_to_ticks(off.ns()).unwrap();
        assert_eq!(ticks % PTS_MODULUS, 0);
        // und es liegt höchstens eine Periode unter der absoluten Zeit
        assert!(off.ns() <= abs.ns());
        assert!(abs.ns() - off.ns() < ticks_to_ns(PTS_MODULUS) + 1);
    }

    #[test]
    fn rollover_in_the_middle_of_a_segment_is_continuous() {
        // Segment beginnt 0,2 s vor dem Überlauf; Bilder alle 40 ms (3600 Ticks)
        let start_ticks: u64 = 5 * PTS_MODULUS + PTS_MODULUS - 18_000; // absolute Ticks
        let abs0 = Timestamp::from_ns(ticks_to_ns(start_ticks));
        let off = ts_offset_for(abs0).unwrap();
        let mut u = PtsUnwrapper::new(off);
        let mut prev = i128::MIN;
        for n in 0..20u64 {
            let abs_ticks = start_ticks + n * 3600;
            let pts = abs_ticks & PTS_MASK; // was der Strom enthält (wird bei n=5 wieder klein)
            let t = u.absolute(pts);
            assert!((t.ns() - ticks_to_ns(abs_ticks)).abs() <= 1, "Bild {n}");
            assert!(t.ns() > prev, "Zeit muss steigen, Bild {n}");
            prev = t.ns();
        }
    }

    #[test]
    fn small_backwards_steps_are_not_rollover() {
        // B-Bilder: PTS darf wenig zurückspringen, ohne dass ein Überlauf angenommen wird
        let mut u = PtsUnwrapper::new(Timestamp::ZERO);
        let a = u.absolute(1_000_000);
        let b = u.absolute(1_000_000 - 3600);
        assert!(b.ns() < a.ns());
        assert_eq!(b.ns(), ticks_to_ns(1_000_000 - 3600));
    }

    #[test]
    fn rejects_negative_times() {
        assert!(ts_offset_for(Timestamp::from_ns(-1)).is_none());
        assert!(pts_for(Timestamp::from_ns(-5)).is_none());
    }
}

/// PTS (33 Bit, 90-kHz-Ticks) des **ersten** PES-Pakets mit Präsentationszeit in einem MPEG-TS-Stück.
///
/// Für den `ts_offset` eines Segments (Spezifikation 8.2, `POST …/segments`: „ts_offset = Segmentzeit − Objektzeit“):
/// Objektzeit ist die Zeit, die im Container steht. Ohne Bildumordnung (wir kodieren ohne B-Bilder) ist der erste PTS
/// zugleich der kleinste. Liest nur Paketköpfe; `None`, wenn kein PES mit PTS gefunden wird oder die Synchronisation
/// fehlt (Paketgrenzen nicht auf 188 Byte, Sync-Byte ≠ 0x47).
pub fn first_pts(data: &[u8]) -> Option<u64> {
    const PKT: usize = 188;
    for pkt in data.chunks_exact(PKT) {
        if pkt[0] != 0x47 {
            return None;
        }
        if pkt[1] & 0x40 == 0 {
            continue; // kein Paketanfang
        }
        let afc = (pkt[3] >> 4) & 3;
        if afc & 1 == 0 {
            continue; // keine Nutzlast
        }
        let mut at = 4usize;
        if afc == 3 {
            at += 1 + pkt[4] as usize;
        }
        if at + 14 > PKT || pkt[at] != 0 || pkt[at + 1] != 0 || pkt[at + 2] != 1 {
            continue; // kein PES (z. B. PAT/PMT)
        }
        let flags = pkt[at + 7] >> 6;
        if flags & 0b10 == 0 {
            continue; // kein PTS
        }
        let b = &pkt[at + 9..at + 14];
        if b[0] & 1 == 0 || b[2] & 1 == 0 || b[4] & 1 == 0 {
            continue; // Markerbits fehlen: kein gültiger PTS
        }
        let pts = (((b[0] >> 1) & 7) as u64) << 30 | (b[1] as u64) << 22 | ((b[2] >> 1) as u64) << 15 | (b[3] as u64) << 7 | (b[4] >> 1) as u64;
        return Some(pts);
    }
    None
}

/// Beginn eines PES-Pakets: PID und `stream_id`.
struct PesStart {
    pid: u16,
    stream_id: u8,
}

fn ts_payload(pkt: &[u8]) -> Option<(u16, bool, &[u8])> {
    if pkt.len() != 188 || pkt[0] != 0x47 {
        return None;
    }
    let pid = ((pkt[1] as u16 & 0x1F) << 8) | pkt[2] as u16;
    let pusi = pkt[1] & 0x40 != 0;
    let afc = (pkt[3] >> 4) & 3;
    if afc & 1 == 0 {
        return Some((pid, pusi, &[]));
    }
    let mut at = 4usize;
    if afc == 3 {
        at += 1 + pkt[4] as usize;
    }
    if at > 188 {
        return None;
    }
    Some((pid, pusi, &pkt[at..]))
}

fn pes_start(payload: &[u8]) -> Option<(u8, &[u8])> {
    if payload.len() < 9 || payload[0] != 0 || payload[1] != 0 || payload[2] != 1 {
        return None;
    }
    let hdr = 9 + payload[8] as usize;
    Some((payload[3], payload.get(hdr..).unwrap_or(&[])))
}

fn pes_starts(data: &[u8]) -> Option<Vec<PesStart>> {
    let mut out = Vec::new();
    for pkt in data.chunks_exact(188) {
        let (pid, pusi, pl) = ts_payload(pkt)?;
        if pusi && let Some((stream_id, _)) = pes_start(pl) {
            out.push(PesStart { pid, stream_id });
        }
    }
    Some(out)
}

/// Anzahl der **Videobilder** in einem MPEG-TS-Stück: ein PES-Paket je Zugriffseinheit (`stream_id` 0xE0…0xEF; unser
/// `mpegtsmux` arbeitet mit `alignment=au`). `None`, wenn der Strom nicht auf 188-Byte-Paketen sitzt.
pub fn video_frame_count(data: &[u8]) -> Option<usize> {
    Some(pes_starts(data)?.iter().filter(|p| (0xE0..=0xEF).contains(&p.stream_id)).count())
}

/// Anzahl der **AAC-Rahmen** (ADTS) in einem MPEG-TS-Stück (`stream_id` 0xC0…0xDF), je 1024 Samples bei AAC-LC.
/// Zählt die ADTS-Köpfe (Synchronwort, Rahmenlänge) im zusammengesetzten Ton-Datenstrom; bricht beim ersten
/// ungültigen Kopf ab. `None`, wenn kein Ton-PES vorhanden ist oder der Strom nicht auf Paketen sitzt.
pub fn aac_frame_count(data: &[u8]) -> Option<usize> {
    let starts = pes_starts(data)?;
    let pid = starts.iter().find(|p| (0xC0..=0xDF).contains(&p.stream_id))?.pid;
    let mut es: Vec<u8> = Vec::new();
    let mut in_audio_pes = false;
    for pkt in data.chunks_exact(188) {
        let (p, pusi, pl) = ts_payload(pkt)?;
        if p != pid {
            continue;
        }
        if pusi {
            match pes_start(pl) {
                Some((_, rest)) => {
                    es.extend_from_slice(rest);
                    in_audio_pes = true;
                }
                None => in_audio_pes = false,
            }
        } else if in_audio_pes {
            es.extend_from_slice(pl);
        }
    }
    let mut pos = 0usize;
    let mut n = 0usize;
    while pos + 7 <= es.len() {
        if es[pos] != 0xFF || es[pos + 1] & 0xF0 != 0xF0 {
            break;
        }
        let len = (((es[pos + 3] & 3) as usize) << 11) | ((es[pos + 4] as usize) << 3) | (es[pos + 5] as usize >> 5);
        if len < 7 || pos + len > es.len() {
            break; // letzter Rahmen abgeschnitten: nicht mitzählen
        }
        n += 1;
        pos += len;
    }
    Some(n)
}

#[cfg(test)]
mod ts_tests {
    use super::*;

    /// Ein TS-Paket mit PES-Kopf und PTS (und optional Anpassungsfeld).
    fn pes_packet(pid: u16, pts: u64, with_adaptation: bool) -> Vec<u8> {
        let mut p = vec![0u8; 188];
        p[0] = 0x47;
        p[1] = 0x40 | ((pid >> 8) as u8 & 0x1F);
        p[2] = pid as u8;
        let mut at = 4;
        if with_adaptation {
            p[3] = 0x30; // Anpassungsfeld + Nutzlast
            p[4] = 7; // Länge
            at = 5 + 7;
        } else {
            p[3] = 0x10;
        }
        p[at..at + 3].copy_from_slice(&[0, 0, 1]);
        p[at + 3] = 0xE0; // Video-Strom
        p[at + 7] = 0x80; // PTS vorhanden
        p[at + 8] = 5;
        p[at + 9] = 0x21 | (((pts >> 30) as u8 & 7) << 1);
        p[at + 10] = (pts >> 22) as u8;
        p[at + 11] = 0x01 | (((pts >> 15) as u8 & 0x7F) << 1);
        p[at + 12] = (pts >> 7) as u8;
        p[at + 13] = 0x01 | (((pts & 0x7F) as u8) << 1);
        p
    }

    #[test]
    fn finds_the_first_pts_with_and_without_adaptation_field() {
        for adapt in [false, true] {
            for pts in [0u64, 1, 90_000, 126_000, 0x1_2345_6789, PTS_MODULUS - 1] {
                let mut d = vec![0u8; 188]; // PAT-ähnliches Paket ohne Paketanfang davor
                d[0] = 0x47;
                d[3] = 0x10;
                d.extend(pes_packet(0x100, pts, adapt));
                d.extend(pes_packet(0x100, pts + 3600, adapt));
                assert_eq!(first_pts(&d), Some(pts), "pts {pts} adapt {adapt}");
            }
        }
    }

    #[test]
    fn rejects_garbage_and_missing_pts() {
        assert_eq!(first_pts(&[]), None);
        assert_eq!(first_pts(&[0u8; 188]), None); // Sync-Byte fehlt
        let mut p = pes_packet(0x100, 5, false);
        p[4 + 7] = 0; // keine Zeitangabe
        assert_eq!(first_pts(&p), None);
        let mut p = pes_packet(0x100, 5, false);
        p[4 + 9] &= !1; // Markerbit weg
        assert_eq!(first_pts(&p), None);
    }

    #[test]
    fn ts_offset_from_the_real_first_pts() {
        // Segment beginnt bei absoluter Zeit T; im Container steht PTS p → ts_offset = T − p/90000
        let abs = Timestamp::from_ns(1_790_000_000_123_456_789);
        let p = 1_000_000u64;
        let off = Timestamp::from_ns(abs.ns() - ticks_to_ns(p));
        let mut u = PtsUnwrapper::new(off);
        let back = u.absolute(p);
        assert!((back.ns() - abs.ns()).abs() <= 1, "{back} vs {abs}");
    }

    /// TS-Pakete für einen Strom aus PES-Paketen (jedes PES beginnt in einem eigenen Paket, Reste mit Füllbytes).
    fn ts_from_pes(pid: u16, stream_id: u8, pes_payloads: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut cc = 0u8;
        for pl in pes_payloads {
            let mut pes = vec![0, 0, 1, stream_id, 0, 0, 0x80, 0x00, 0x00]; // PES-Kopf ohne PTS, Länge 0
            pes.extend_from_slice(pl);
            let mut first = true;
            for chunk in pes.chunks(184) {
                let mut p = vec![0xFFu8; 188];
                p[0] = 0x47;
                p[1] = ((pid >> 8) as u8 & 0x1F) | if first { 0x40 } else { 0 };
                p[2] = pid as u8;
                if chunk.len() < 184 {
                    // Füllen über Anpassungsfeld
                    let stuff = 184 - chunk.len();
                    p[3] = 0x30 | (cc & 0xF);
                    p[4] = (stuff - 1) as u8;
                    if stuff > 1 {
                        p[5] = 0;
                    }
                    p[4 + stuff..4 + stuff + chunk.len()].copy_from_slice(chunk);
                } else {
                    p[3] = 0x10 | (cc & 0xF);
                    p[4..188].copy_from_slice(chunk);
                }
                cc = cc.wrapping_add(1);
                first = false;
                out.extend_from_slice(&p);
            }
        }
        out
    }

    fn adts(len: usize) -> Vec<u8> {
        let mut f = vec![0u8; len];
        f[0] = 0xFF;
        f[1] = 0xF1;
        f[2] = 0x4C;
        f[3] = ((len >> 11) & 3) as u8;
        f[4] = (len >> 3) as u8;
        f[5] = ((len & 7) << 5) as u8 | 0x1F;
        f[6] = 0xFC;
        f
    }

    #[test]
    fn counts_video_frames_by_pes_start() {
        let au = |n: usize| vec![0u8; n];
        let d = ts_from_pes(0x100, 0xE0, &[au(10), au(5000), au(300), au(1)]);
        assert_eq!(video_frame_count(&d), Some(4));
        assert_eq!(video_frame_count(&[]), Some(0));
        assert_eq!(video_frame_count(&[1, 2, 3]), Some(0)); // kein ganzes Paket
        assert_eq!(video_frame_count(&[0u8; 188]), None); // Sync-Byte fehlt
    }

    #[test]
    fn counts_adts_frames_across_pes_and_packet_boundaries() {
        // 3 PES mit 2, 3 und 1 ADTS-Rahmen unterschiedlicher Länge (Rahmen reichen über Paketgrenzen)
        let pes = |lens: &[usize]| lens.iter().flat_map(|l| adts(*l)).collect::<Vec<u8>>();
        let d = ts_from_pes(0x101, 0xC0, &[pes(&[200, 391]), pes(&[1000, 150, 777]), pes(&[300])]);
        assert_eq!(aac_frame_count(&d), Some(6));
        // Video-Strom hat keinen Ton
        let v = ts_from_pes(0x100, 0xE0, &[vec![0u8; 100]]);
        assert_eq!(aac_frame_count(&v), None);
    }
}
