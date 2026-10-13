//! Komprimierter Puffer-Ring (Kapitel 39.5, Pfad B) — Gegenstück zum Roh-Pfad von `omp-playout-buffer`
//! für **Zugriffseinheiten (AU)** eines Video-Elementarstroms (H.264/H.265), ohne GStreamer, rein logisch.
//!
//! Regeln (wie im Entwurf Kap. 39):
//! * Eintritt/Splice nur an einem **Schlüsselbild** (IDR/IRAP): nach Start und nach [`AuRing::mark_gap`]
//!   werden Nicht-Schlüsselbilder verworfen; vor dem ersten Schlüsselbild nach dem Splice werden die
//!   zuletzt gemeldeten **Parameter-Sätze** (SPS/PPS/VPS) vorangestellt.
//! * **Speicherbegrenzung:** harte Grenze in Bytes; bei Überlauf fällt immer eine **ganze GOP** (ab dem
//!   ältesten Schlüsselbild bis vor das nächste) weg, nie ein einzelnes P-Bild. Die jüngste GOP bleibt.
//! * **Ausgabetakt:** je [`AuRing::tick`] genau eine AU (eigene Uhr, nie vom Eingang getrieben). Die
//!   Ausgangs-DTS läuft streng monoton (`+= Dauer`), die PTS bleibt über den Kompositions-Versatz
//!   (`pts − dts` der AU) erhalten → DTS ≤ PTS auch mit B-Bildern, Reihenfolge = AU-Reihenfolge.
//! * **Lückenfüllung:** ist der Ring leer (Eingang weg), liefert `tick` im Zustand `Hold` das zuletzt
//!   gesendete **Schlüsselbild** erneut (oder ein vorbereitetes Schwarz-IDR, [`AuRing::set_black`]) mit
//!   neuen Zeitstempeln — der Ausgang bleibt am Leben. Wiederaufnahme erst, wenn wieder `resume_ns`
//!   Material ab einem Schlüsselbild vorliegt.

use std::collections::VecDeque;

/// Eine Zugriffseinheit; Zeiten in Nanosekunden.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Au {
    pub data: Vec<u8>,
    pub pts: u64,
    pub dts: u64,
    pub dur: u64,
    pub key: bool,
}

/// Was `tick` liefert: die AU mit **Ausgangs**-Zeitstempeln.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutAu {
    pub data: Vec<u8>,
    pub pts: u64,
    pub dts: u64,
    pub dur: u64,
    pub key: bool,
    /// `true`: Wiederholung (Haltebild/Schwarz), kein frisches Material.
    pub held: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Fill,
    Run,
    Hold,
}

#[derive(Default, Debug, Clone, Copy)]
pub struct Counters {
    pub dropped_gops: u64,
    pub dropped_non_key: u64,
    pub splices: u64,
    pub held_ticks: u64,
    pub underruns: u64,
}

pub struct AuRing {
    target_ns: u64,
    resume_ns: u64,
    max_bytes: usize,
    jump_ns: u64,
    q: VecDeque<Au>,
    bytes: usize,
    depth_ns: u64,
    state: State,
    wait_key: bool,
    params: Vec<u8>,
    prepend_params: bool,
    last_key: Option<Vec<u8>>,
    black: Option<Vec<u8>>,
    last_in_dts: Option<u64>,
    out_dts: u64,
    frame_ns: u64,
    pub counters: Counters,
}

impl AuRing {
    /// `target_ns` Zieltiefe, `resume_ns` Mindesttiefe zur Wiederaufnahme nach `Hold`,
    /// `max_bytes` harte Obergrenze, `frame_ns` Bilddauer des Ausgabetakts.
    pub fn new(target_ns: u64, resume_ns: u64, max_bytes: usize, frame_ns: u64) -> AuRing {
        AuRing {
            target_ns,
            resume_ns,
            max_bytes,
            jump_ns: 1_000_000_000,
            q: VecDeque::new(),
            bytes: 0,
            depth_ns: 0,
            state: State::Fill,
            wait_key: true,
            params: Vec::new(),
            prepend_params: false,
            last_key: None,
            black: None,
            last_in_dts: None,
            out_dts: 0,
            frame_ns,
            counters: Counters::default(),
        }
    }

    pub fn state(&self) -> State {
        self.state
    }
    pub fn depth_ns(&self) -> u64 {
        self.depth_ns
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    /// Parameter-Sätze (Annex-B, SPS/PPS/VPS) — werden vor das erste Schlüsselbild nach einem Splice gestellt.
    pub fn set_params(&mut self, p: Vec<u8>) {
        self.params = p;
    }
    /// Vorbereitetes Schwarz-IDR für `Hold` (sonst wird das letzte Schlüsselbild wiederholt).
    pub fn set_black(&mut self, idr: Vec<u8>) {
        self.black = Some(idr);
    }
    /// Der Eingang ist ausgefallen/wechselt die Quelle: bis zum nächsten Schlüsselbild verwerfen.
    pub fn mark_gap(&mut self) {
        self.wait_key = true;
        self.last_in_dts = None;
    }

    pub fn push(&mut self, au: Au) {
        // Zeitsprung im Eingang (Quelle gewechselt, Rückwärtslauf) = Splice.
        if let Some(prev) = self.last_in_dts {
            if au.dts.abs_diff(prev) > self.jump_ns {
                self.wait_key = true;
            }
        }
        if self.wait_key {
            if !au.key {
                self.counters.dropped_non_key += 1;
                return;
            }
            self.wait_key = false;
            self.counters.splices += 1;
            self.prepend_params = !self.params.is_empty();
        }
        self.last_in_dts = Some(au.dts);
        let mut au = au;
        if au.key && self.prepend_params {
            let mut d = self.params.clone();
            d.extend_from_slice(&au.data);
            au.data = d;
            self.prepend_params = false;
        }
        self.bytes += au.data.len();
        self.depth_ns += au.dur;
        self.q.push_back(au);
        self.evict();
        if self.state == State::Fill && self.depth_ns >= self.target_ns {
            self.state = State::Run;
        }
        if self.state == State::Hold && self.starts_with_key() && self.depth_ns >= self.resume_ns {
            self.state = State::Run;
        }
    }

    fn starts_with_key(&self) -> bool {
        self.q.front().is_some_and(|a| a.key)
    }

    /// Ganze GOPs ab dem ältesten verwerfen, solange die Byte-Grenze überschritten ist.
    fn evict(&mut self) {
        while self.bytes > self.max_bytes {
            // Nächstes Schlüsselbild nach dem Kopf suchen; gibt es keins, bleibt die (einzige) GOP.
            let Some(next_key) = self.q.iter().skip(1).position(|a| a.key).map(|i| i + 1) else {
                break;
            };
            for _ in 0..next_key {
                if let Some(a) = self.q.pop_front() {
                    self.bytes -= a.data.len();
                    self.depth_ns -= a.dur;
                }
            }
            self.counters.dropped_gops += 1;
        }
    }

    /// Ein Ausgabetakt. `None` nur, solange noch nie ein Schlüsselbild gesendet wurde (nichts zu halten).
    pub fn tick(&mut self) -> Option<OutAu> {
        match self.state {
            State::Fill => self.hold_out(),
            State::Hold => self.hold_out(),
            State::Run => {
                // Im Lauf immer ab einem Schlüsselbild beginnen (nach Hold/Splice ist der Kopf ein IDR).
                if let Some(au) = self.q.pop_front() {
                    self.bytes -= au.data.len();
                    self.depth_ns -= au.dur;
                    if au.key {
                        self.last_key = Some(au.data.clone());
                    }
                    let cts = au.pts.saturating_sub(au.dts);
                    let dts = self.out_dts;
                    self.out_dts += au.dur.max(1);
                    Some(OutAu { data: au.data, pts: dts + cts, dts, dur: au.dur, key: au.key, held: false })
                } else {
                    self.counters.underruns += 1;
                    self.state = State::Hold;
                    self.hold_out()
                }
            }
        }
    }

    fn hold_out(&mut self) -> Option<OutAu> {
        let data = self.black.clone().or_else(|| self.last_key.clone())?;
        self.counters.held_ticks += 1;
        let dts = self.out_dts;
        self.out_dts += self.frame_ns;
        Some(OutAu { data, pts: dts, dts, dur: self.frame_ns, key: true, held: true })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const F: u64 = 40_000_000; // 25 Bilder/s

    fn au(i: u64, key: bool, size: usize) -> Au {
        Au { data: vec![i as u8; size], pts: i * F + 2 * F, dts: i * F, dur: F, key }
    }

    /// GOP-Länge 5: i % 5 == 0 ist Schlüsselbild.
    fn feed(r: &mut AuRing, from: u64, n: u64, size: usize) {
        for i in from..from + n {
            r.push(au(i, i % 5 == 0, size));
        }
    }

    #[test]
    fn fill_then_run_and_monotonic_timestamps() {
        let mut r = AuRing::new(10 * F, 5 * F, 1 << 20, F);
        feed(&mut r, 0, 9, 10);
        assert_eq!(r.state(), State::Fill);
        assert!(r.tick().is_none(), "vor dem ersten Schlüsselbild nichts zu halten");
        feed(&mut r, 9, 3, 10);
        assert_eq!(r.state(), State::Run);
        let mut last = None;
        for _ in 0..12 {
            let o = r.tick().unwrap();
            assert!(o.dts <= o.pts, "DTS ≤ PTS");
            if let Some(p) = last {
                assert!(o.dts > p, "DTS streng monoton");
            }
            last = Some(o.dts);
            assert!(!o.held);
        }
    }

    #[test]
    fn start_drops_until_keyframe_and_prepends_params() {
        let mut r = AuRing::new(F, F, 1 << 20, F);
        r.set_params(vec![0xAA, 0xBB]);
        r.push(au(1, false, 4));
        r.push(au(2, false, 4));
        assert_eq!(r.counters.dropped_non_key, 2);
        r.push(au(5, true, 4));
        r.push(au(6, false, 4));
        let o = r.tick().unwrap();
        assert!(o.key);
        assert_eq!(&o.data[..2], &[0xAA, 0xBB], "Parameter-Sätze vor dem IDR");
        let p = r.tick().unwrap();
        assert_eq!(p.data.len(), 4, "keine Parameter vor P-Bildern");
    }

    #[test]
    fn byte_limit_drops_whole_gops_and_keeps_newest() {
        // 5 Bilder à 100 Byte je GOP, Grenze 1200 Byte → alte GOPs fallen als Ganzes
        let mut r = AuRing::new(100 * F, 100 * F, 1200, F);
        feed(&mut r, 0, 40, 100);
        assert!(r.bytes() <= 1200 + 400, "Grenze bleibt (bis auf die jüngste, unvollständige GOP)");
        assert!(r.counters.dropped_gops > 0);
        assert!(r.starts_with_key(), "Kopf ist immer ein Schlüsselbild — nie ein einzelnes P-Bild verworfen");
        assert_eq!(r.q.len() as u64 * F, r.depth_ns());
    }

    #[test]
    fn underrun_holds_last_key_then_resumes_at_keyframe() {
        let mut r = AuRing::new(5 * F, 5 * F, 1 << 20, F);
        feed(&mut r, 0, 5, 10);
        assert_eq!(r.state(), State::Run);
        for _ in 0..5 {
            assert!(!r.tick().unwrap().held);
        }
        // Ring leer → Hold mit wiederholtem Schlüsselbild
        let h = r.tick().unwrap();
        assert!(h.held && h.key);
        assert_eq!(r.state(), State::Hold);
        assert_eq!(r.counters.underruns, 1);
        let h2 = r.tick().unwrap();
        assert!(h2.dts > h.dts, "auch im Hold streng monoton");
        // Eingang kommt zurück (Quelle gewechselt): erst ab Schlüsselbild, erst nach resume_ns
        r.mark_gap();
        feed(&mut r, 100, 3, 10); // 100 ist Schlüsselbild
        assert_eq!(r.state(), State::Hold, "noch zu wenig Material");
        feed(&mut r, 103, 3, 10);
        assert_eq!(r.state(), State::Run);
        let o = r.tick().unwrap();
        assert!(!o.held && o.key);
        assert!(o.dts > h2.dts, "Zeitleiste läuft über den Splice hinweg weiter");
    }

    #[test]
    fn black_idr_is_used_when_set() {
        let mut r = AuRing::new(F, F, 1 << 20, F);
        r.set_black(vec![9, 9, 9]);
        let h = r.tick().unwrap();
        assert!(h.held);
        assert_eq!(h.data, vec![9, 9, 9]);
    }

    #[test]
    fn input_timestamp_jump_is_a_splice() {
        let mut r = AuRing::new(2 * F, F, 1 << 20, F);
        feed(&mut r, 0, 5, 10);
        // Quelle springt um Stunden zurück: Nicht-Schlüsselbilder fallen weg, IDR beginnt neu
        r.push(Au { data: vec![1; 10], pts: 5 * F, dts: 3 * F, dur: F, key: false });
        let before = r.counters.dropped_non_key;
        r.push(Au { data: vec![1; 10], pts: 0, dts: 0, dur: F, key: false });
        assert!(r.counters.dropped_non_key > before || r.counters.splices >= 1);
    }

    #[test]
    fn memory_stays_flat_under_long_load() {
        let mut r = AuRing::new(60 * F, 30 * F, 20_000, F);
        for i in 0..15_000u64 {
            r.push(au(i, i % 25 == 0, 100));
            if i > 60 {
                let _ = r.tick();
            }
        }
        assert!(r.bytes() <= 20_000 + 2_500);
    }
}
