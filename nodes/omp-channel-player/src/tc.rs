//! Zeitcode-Ausgang des Kanal-Players (ST 12-2, ATC_LTC) als MXL-Daten-Flow: ein Grain je Bildperiode mit dem Zeitcode der
//! Medienposition des laufenden Clips (00:00:00:00 = Clipanfang bei Medienzeit 0). Ohne Clip mit Medienzeit (Testbild, Live,
//! Standbild) bleibt der Grain leer — ein falscher Zeitcode wäre schlimmer als keiner.
//! Zweck (Nutzerauftrag 2026-10-30): Anzeige in Viewer und Messgerät und die bildgenaue Wiedergabe von SRT-Dateien (Grafik-Node
//! folgt diesem Zeitcode, s. `omp-ograf`), auch bei Halt, Pause und Seek.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_mediaio::anc::{self, Timecode};
use omp_mediaio::mxl::MxlDataOutput;
use gstreamer as gst;

use crate::pipeline::{FRAMERATE_DENOMINATOR, FRAMERATE_NUMERATOR};

/// Letzte vom Videozweig gemeldete Position (Bildnummer, Zeitpunkt der Meldung). Der Probe schreibt, der Ausgang liest.
pub struct TcSource {
    inner: Mutex<(i64, Instant)>,
    /// Bildnummer je PTS der zuletzt vom Videozweig gemeldeten Bilder: der Video-Schreiber meldet (Grain-Index, PTS), daraus wird
    /// der Zeitcode des Bildes und er landet auf demselben Grain-Index wie das Bild (Zeitcode und Bild können nicht auseinanderlaufen).
    by_pts: Mutex<std::collections::VecDeque<(u64, i64)>>,
    out: Mutex<Option<Arc<MxlDataOutput>>>,
    /// Zeitpunkt des letzten bildgebundenen Grains; solange er jung ist, schreibt der Zeitgeber-Thread nichts (er hält nur bei Halt).
    hooked_at: Mutex<Option<Instant>>,
}

impl TcSource {
    pub fn new() -> TcSource {
        TcSource { inner: Mutex::new((-1, Instant::now())), by_pts: Mutex::new(Default::default()), out: Mutex::new(None), hooked_at: Mutex::new(None) }
    }

    pub fn set(&self, frame: i64) {
        *self.inner.lock().expect("lock poisoned") = (frame, Instant::now());
    }

    /// Bild mit PTS `pts_ns` hat die Bildnummer `frame`.
    pub fn note_pts(&self, pts_ns: u64, frame: i64) {
        let mut q = self.by_pts.lock().expect("lock poisoned");
        q.push_back((pts_ns, frame));
        while q.len() > 64 {
            q.pop_front();
        }
    }

    pub fn attach(&self, out: Arc<MxlDataOutput>) {
        *self.out.lock().expect("lock poisoned") = Some(out);
    }

    /// Video-Schreiber-Hook: Zeitcode des soeben geschriebenen Bildes auf denselben Grain-Index.
    pub fn on_frame(&self, index: u64, pts: Option<gst::ClockTime>) {
        let Some(pts) = pts else { return };
        let frame = self.by_pts.lock().expect("lock poisoned").iter().rev().find(|(p, _)| *p == pts.nseconds()).map(|(_, f)| *f);
        let Some(frame) = frame else { return };
        if let Some(out) = self.out.lock().expect("lock poisoned").as_ref()
            && let Ok(p) = payload(frame)
        {
            let _ = out.write_grain(index, &p);
            *self.hooked_at.lock().expect("lock poisoned") = Some(Instant::now());
        }
    }

    fn hooked_recently(&self) -> bool {
        self.hooked_at.lock().expect("lock poisoned").is_some_and(|t| t.elapsed() < Duration::from_millis(120))
    }

    pub fn clear(&self) {
        *self.inner.lock().expect("lock poisoned") = (-1, Instant::now());
        self.by_pts.lock().expect("lock poisoned").clear();
    }

    fn get(&self) -> (i64, Instant) {
        *self.inner.lock().expect("lock poisoned")
    }
}

/// Glättung: Der Videozweig liefert Bilder in Schüben (Warteschlangen), der Ausgang schreibt im festen Bildraster. Würde der
/// Ausgang den zuletzt gemeldeten Wert abtasten, entstünden doppelte Werte und Sprünge um 2. Statt dessen zählt der Zeitcode
/// **mit dem Grain-Index** weiter (ein Grain = ein Bild, auch wenn der Schreib-Thread unter Last verspätet aufwacht) und wird nur
/// neu verankert, wenn er mehr als `MAX_ERR` Bilder von der Meldung abweicht (Seek, Neustart). Er bleibt stehen, solange keine
/// Bilder mehr gemeldet werden (Pause, Halt, Dateiende).
pub struct Follower {
    period: Duration,
    /// (Bildnummer am Anker, Grain-Index am Anker)
    anchor: Option<(i64, u64)>,
    last_frame: i64,
}

const MAX_ERR: f64 = 3.0;
/// So weit darf die Ausgabe der letzten Meldung des Videozweigs vorauslaufen (Bilder).
const MAX_AHEAD: i64 = 2;
/// So lange nach der letzten Meldung gilt der Clip noch als laufend (in Bildperioden).
const RUNNING_PERIODS: u32 = 6;

impl Follower {
    pub fn new(rate_num: u32, rate_den: u32) -> Follower {
        Follower { period: Duration::from_nanos(1_000_000_000u64 * rate_den as u64 / rate_num as u64), anchor: None, last_frame: -1 }
    }

    /// Bildnummer für den Grain `index`, geschrieben zum Zeitpunkt `now` (`< 0` = kein Zeitcode).
    pub fn frame_at(&mut self, reported: (i64, Instant), now: Instant, index: u64) -> i64 {
        let (f, at) = reported;
        if f < 0 {
            self.anchor = None;
            self.last_frame = -1;
            return -1;
        }
        let since = now.saturating_duration_since(at);
        if since > self.period * RUNNING_PERIODS {
            // keine neuen Bilder: Halt — höchstens 2 Bilder vor der letzten Meldung gezeigt, dann bleibt der zuletzt
            // ausgegebene Wert stehen (kein Rücksprung)
            self.anchor = None;
            if !(f..=f + MAX_AHEAD).contains(&self.last_frame) {
                self.last_frame = f;
            }
            return self.last_frame;
        }
        let reported_now = f as f64 + since.as_secs_f64() / self.period.as_secs_f64();
        let predicted = self.anchor.map(|(n0, i0)| n0 as f64 + index.saturating_sub(i0) as f64);
        let anchor_ok = predicted.is_some_and(|p| (p - reported_now).abs() <= MAX_ERR);
        if !anchor_ok {
            if std::env::var_os("OMP_TC_DEBUG").is_some() {
                eprintln!("tc: neu verankert f={f} gemeldet={reported_now:.2} vorhergesagt={predicted:?} letzter={}", self.last_frame);
            }
            self.anchor = Some((reported_now.round() as i64, index));
        }
        let (n0, i0) = self.anchor.expect("gesetzt");
        let v = n0 + index.saturating_sub(i0) as i64;
        let v = if anchor_ok { v.max(self.last_frame) } else { v };
        let v = v.min(f + MAX_AHEAD);
        self.last_frame = v;
        v
    }
}

/// Grain-Nutzlast zur Bildnummer (`< 0` = leer).
pub fn payload(frame: i64) -> Result<Vec<u8>, String> {
    if frame < 0 {
        return anc::mxl_grain(&[]);
    }
    let tc = Timecode::from_frame_number(frame as u64, FRAMERATE_NUMERATOR, FRAMERATE_DENOMINATOR, false);
    anc::mxl_grain(&[anc::atc_packet(&tc, true)])
}

pub fn spawn(out: Arc<MxlDataOutput>, source: Arc<TcSource>, shutdown: Arc<AtomicBool>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut follower = Follower::new(FRAMERATE_NUMERATOR, FRAMERATE_DENOMINATOR);
        let mut index = out.index_after_ns(0) + 1;
        while !shutdown.load(Ordering::Relaxed) {
            let frame = follower.frame_at(source.get(), Instant::now(), index);
            if std::env::var_os("OMP_TC_DEBUG").is_some() {
                let (rf, rat) = source.get();
                eprintln!("tc: out={frame} rep={rf} age_ms={}", rat.elapsed().as_millis());
            }
            match payload(frame) {
                Ok(_) if source.hooked_recently() => {}
                Ok(p) => {
                    let _ = out.write_grain(index, &p);
                }
                Err(e) => eprintln!("omp-channel-player: Zeitcode-Grain: {e}"),
            }
            index += 1;
            let head = out.current_index();
            if head > index + 2 {
                index = head + 1;
            }
            out.sleep_until_index(index);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_becomes_timecode_and_negative_is_empty() {
        let g = payload(25 * 61 + 3).unwrap();
        assert_eq!(anc::parse_atc_grain(&g).unwrap().timecode.display(), "00:01:01:03");
        assert!(anc::parse_atc_grain(&payload(-1).unwrap()).is_none());
    }

    #[test]
    fn follower_counts_one_per_grain_despite_bursty_reports_and_late_wakeups() {
        let mut f = Follower::new(25, 1);
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        let mut out = vec![];
        for k in 0..50u64 {
            // Meldungen in Schüben (2 Bilder auf einmal); jeder 7. Aufruf wacht 70 ms zu spät auf
            let now = ms(k * 40 + if k % 7 == 3 { 70 } else { 0 });
            let burst_frame = (k / 2) * 2 + 1;
            out.push(f.frame_at((burst_frame as i64, ms((k / 2) * 80)), now, 1000 + k));
        }
        for w in out.windows(2) {
            assert_eq!(w[1] - w[0], 1, "jeder Grain genau ein Bild weiter: {out:?}");
        }
    }

    #[test]
    fn follower_reanchors_on_seek_and_holds_when_idle() {
        let mut f = Follower::new(25, 1);
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        assert_eq!(f.frame_at((100, ms(0)), ms(0), 10), 100);
        assert_eq!(f.frame_at((101, ms(40)), ms(40), 11), 101);
        // Sprung der Position (Seek) -> neu verankert
        assert_eq!(f.frame_at((500, ms(80)), ms(80), 12), 500);
        // keine Meldung mehr (Pause): letzter gemeldeter Wert bleibt, auch nach Sekunden
        assert_eq!(f.frame_at((500, ms(80)), ms(5_000), 200), 500);
        assert_eq!(f.frame_at((500, ms(80)), ms(9_000), 300), 500);
        // ohne Clip
        assert_eq!(f.frame_at((-1, ms(80)), ms(9_040), 301), -1);
    }
}
