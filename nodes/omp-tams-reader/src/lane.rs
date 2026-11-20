//! Eine Essenz (Video oder Ton) einer Wiedergabe: **Holen** (eigener Thread, Vorlauf von wenigen Segmenten) und
//! **Wiedergeben** (eigener Thread: dekodieren, auf die Ausgabezeit legen, Lücken füllen, in die Pipeline geben).
//!
//! Takt: Jedes Bild/jeder Block bekommt als PTS die Laufzeit der Pipeline, die zur Ausgabe-TAI passt
//! (`omp_mediaio::timebase::tai_to_running`); ein `identity sync=true` hinter dem `appsrc` gibt es erst dann weiter.
//! Zusätzlich trägt es die Ausgabe-TAI als `ReferenceTimestampMeta` — daraus bildet der MXL-Ausgang den Grain-Index
//! (wie bei jedem durchgereichten Ursprung). So ist der Index unabhängig vom Zeitpunkt des Schreibens.

use crate::decode::{decode_audio, decode_video};
use crate::plan;
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use gstreamer_video as gst_video;
use omp_mediaio::mxl::tai_reference_caps;
use omp_mediaio::timebase::{tai_now_ns, tai_to_running};
use omp_tams::client::{Client, SegmentQuery};
use omp_tams::mpegts::first_pts;
use omp_tams::time::{Bound, TimeRange, Timestamp};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Mehr als so viel zu spät (ns) → Bild/Block verwerfen (und zählen) statt veraltet auszugeben.
pub const LATE_NS: u64 = 1_000_000_000;
/// Größtes Object, das wir laden.
const MAX_OBJECT_BYTES: u64 = 256 << 20;
/// Lücken bis zu dieser Dauer werden gefüllt; längere springt die Wiedergabe.
const GAP_CAP_NS: i128 = 60_000_000_000;
/// Nach dem Ende eines Zeitbereichs in der Vergangenheit: so lange noch auf späte Segmente warten.
const END_GRACE_NS: i128 = 5_000_000_000;
const SILENCE_BLOCK_SAMPLES: u64 = 480;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GapMode {
    /// Lücke: letztes Bild wiederholen (Ton: Stille).
    Hold,
    /// Lücke: Schwarz (Ton: Stille).
    Black,
}

/// Zu spielender Bereich in Flow-Zeit. `end_ns = None`: offen (Folge-Modus, wartet auf neue Segmente).
#[derive(Clone, Copy, Debug)]
pub struct Course {
    pub start_ns: i128,
    pub end_ns: Option<i128>,
}

pub struct Control {
    pub stop: AtomicBool,
}

#[derive(Default)]
pub struct Stats {
    pub segments_fetched: AtomicU64,
    pub frames_out: AtomicU64,
    pub blocks_out: AtomicU64,
    pub late_dropped: AtomicU64,
    pub gaps_filled: AtomicU64,
    pub errors: AtomicU64,
    /// Größte bisher ausgegebene Ausgabe-TAI (ns) — der Lebenszyklus wartet darauf, bis alles ausgegeben ist.
    pub last_tai: AtomicU64,
    pub lanes_done: AtomicUsize,
    pub last_error: Mutex<String>,
}

impl Stats {
    pub fn error(&self, msg: impl Into<String>) {
        self.errors.fetch_add(1, Ordering::Relaxed);
        *self.last_error.lock().expect("lock poisoned") = msg.into();
    }
}

/// Ein geholtes Segment, bereit zum Dekodieren.
pub struct Fetched {
    pub start_ns: i128,
    pub end_ns: i128,
    /// Flow-Zeit des ersten Pakets (`ts_offset` + erster PTS).
    pub base_ns: i128,
    pub data: Vec<u8>,
}

fn sleep_unless_stopped(ctl: &Control, total: Duration) {
    let end = std::time::Instant::now() + total;
    while std::time::Instant::now() < end && !ctl.stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn range_from(cursor_ns: i128, end_ns: Option<i128>) -> TimeRange {
    TimeRange::new(
        Some(Bound { ts: Timestamp::from_ns(cursor_ns), inclusive: true }),
        end_ns.map(|e| Bound { ts: Timestamp::from_ns(e), inclusive: false }),
    )
}

/// Holt die Segmente eines Flows in Zeitreihenfolge. Läuft, bis der Bereich abgearbeitet ist (oder `stop`); bei offenem
/// Ende fragt er dauernd nach neuen Segmenten (Abfrage; ein Webhook ist nicht eingebaut). Fehler beim Abruf werden
/// gezählt und wiederholt, ein nicht ladbares Object wird übersprungen (es entsteht eine Lücke, die gefüllt wird).
pub fn fetch_loop(client: &Client, flow: &str, course: Course, tx: &SyncSender<Fetched>, ctl: &Control, stats: &Stats) {
    let mut cursor = course.start_ns;
    while !ctl.stop.load(Ordering::Relaxed) {
        if course.end_ns.is_some_and(|e| cursor >= e) {
            return;
        }
        let q = SegmentQuery { timerange: Some(range_from(cursor, course.end_ns)), ..Default::default() };
        let mut segs = match client.list_segments(flow, &q, 10_000) {
            Ok(s) => s,
            Err(e) => {
                stats.error(format!("Segmente abfragen ({flow}): {e}"));
                sleep_unless_stopped(ctl, Duration::from_secs(1));
                continue;
            }
        };
        let mut parsed: Vec<(i128, i128, omp_tams::types::Segment)> = segs
            .drain(..)
            .filter_map(|s| match TimeRange::parse(&s.timerange).ok().as_ref().and_then(plan::bounds_ns) {
                Some((Some(a), Some(b))) if b > cursor => Some((a, b, s)),
                _ => None,
            })
            .collect();
        parsed.sort_by_key(|(a, _, _)| *a);
        let mut progressed = false;
        for (start, end, seg) in parsed {
            if ctl.stop.load(Ordering::Relaxed) {
                return;
            }
            progressed = true;
            cursor = end;
            let Some(url) = seg.get_urls.first().map(|g| g.url.clone()) else {
                stats.error(format!("Segment {} ohne Adresse", seg.timerange));
                continue;
            };
            let mut data = None;
            for attempt in 0..3 {
                match client.download_object(&url, MAX_OBJECT_BYTES) {
                    Ok(d) => {
                        data = Some(d);
                        break;
                    }
                    Err(e) => {
                        stats.error(format!("Object laden ({}): {e}", seg.timerange));
                        if attempt < 2 {
                            sleep_unless_stopped(ctl, Duration::from_millis(300));
                        }
                    }
                }
            }
            let Some(data) = data else { continue };
            let Some(pts) = first_pts(&data) else {
                stats.error(format!("Object {} ohne lesbaren PTS", seg.timerange));
                continue;
            };
            let Some(base_ns) = plan::segment_base_ns(seg.ts_offset.as_deref(), pts) else {
                stats.error(format!("Segment {}: ts_offset unlesbar", seg.timerange));
                continue;
            };
            stats.segments_fetched.fetch_add(1, Ordering::Relaxed);
            let mut item = Some(Fetched { start_ns: start, end_ns: end, base_ns, data });
            while let Some(it) = item.take() {
                if ctl.stop.load(Ordering::Relaxed) {
                    return;
                }
                match tx.try_send(it) {
                    Ok(()) => {}
                    Err(TrySendError::Full(back)) => {
                        item = Some(back);
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(TrySendError::Disconnected(_)) => return,
                }
            }
        }
        if !progressed {
            // Nichts Neues: ein Bereich, der schon deutlich in der Vergangenheit endet, ist fertig; sonst warten.
            if course.end_ns.is_some_and(|e| tai_now_ns() as i128 > e + END_GRACE_NS) {
                return;
            }
            sleep_unless_stopped(ctl, Duration::from_millis(400));
        }
    }
}

/// Alles, was die Wiedergabe-Threads zum Ausgeben brauchen.
pub struct Sink {
    pub pipeline: gst::Pipeline,
    pub src: gst_app::AppSrc,
    pub shift_ns: i128,
    pub course: Course,
    pub ctl: Arc<Control>,
    pub stats: Arc<Stats>,
}

enum Emit {
    Pushed,
    Late,
    Stopped,
}

fn running_for(pipeline: &gst::Pipeline, tai: u64) -> Option<u64> {
    let clock = pipeline.clock()?;
    let base = pipeline.base_time()?.nseconds();
    let now = clock.time().nseconds();
    tai_to_running(tai, base, now, tai_now_ns(), 0)
}

impl Sink {
    /// Legt `buf` auf die Ausgabezeit zu `flow_ns` und gibt es in die Pipeline.
    fn emit(&self, caps_set: &mut Option<gst::Caps>, mut buf: gst::Buffer, caps: &gst::Caps, flow_ns: i128, duration_ns: i128) -> Emit {
        let Some(tai) = plan::to_tai(flow_ns, self.shift_ns) else {
            self.stats.late_dropped.fetch_add(1, Ordering::Relaxed);
            return Emit::Late;
        };
        if tai.saturating_add(LATE_NS) < tai_now_ns() {
            self.stats.late_dropped.fetch_add(1, Ordering::Relaxed);
            return Emit::Late;
        }
        let Some(running) = running_for(&self.pipeline, tai) else {
            self.stats.late_dropped.fetch_add(1, Ordering::Relaxed);
            return Emit::Late;
        };
        {
            let b = buf.make_mut();
            b.set_pts(gst::ClockTime::from_nseconds(running));
            b.set_dts(gst::ClockTime::NONE);
            b.set_duration(gst::ClockTime::from_nseconds(duration_ns.max(0) as u64));
            gst::ReferenceTimestampMeta::add(b, &tai_reference_caps(), gst::ClockTime::from_nseconds(tai), gst::ClockTime::NONE);
        }
        if caps_set.as_ref() != Some(caps) {
            self.src.set_caps(Some(caps));
            *caps_set = Some(caps.clone());
        }
        match self.src.push_buffer(buf) {
            Ok(_) => {
                self.stats.last_tai.fetch_max(tai, Ordering::Relaxed);
                Emit::Pushed
            }
            Err(_) => Emit::Stopped,
        }
    }
}

/// Schwarzes I420-Bild (Y = 16, U = V = 128) in der Größe der Caps.
fn black_i420(caps: &gst::Caps) -> Option<gst::Buffer> {
    let info = gst_video::VideoInfo::from_caps(caps).ok()?;
    if info.format() != gst_video::VideoFormat::I420 {
        return None;
    }
    let mut data = vec![0u8; info.size()];
    for p in 0..3usize {
        let (off, stride) = (info.offset()[p], info.stride()[p] as usize);
        let rows = if p == 0 { info.height() as usize } else { (info.height() as usize).div_ceil(2) };
        data.get_mut(off..off + stride * rows)?.fill(if p == 0 { 16 } else { 128 });
    }
    Some(gst::Buffer::from_mut_slice(data))
}

/// Video-Wiedergabe: dekodiert die geholten Segmente der Reihe nach und gibt jedes Bild zur Ausgabezeit aus.
pub fn play_video(sink: &Sink, rx: Receiver<Fetched>, period_ns: i128, gap: GapMode) {
    let mut caps_set: Option<gst::Caps> = None;
    let mut last_flow: Option<i128> = None;
    let mut hold: Option<(gst::Buffer, gst::Caps)> = None;
    let mut black: Option<gst::Buffer> = None;
    let mut finished = false;
    while !finished && !sink.ctl.stop.load(Ordering::Relaxed) {
        let seg = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(s) => s,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let result = decode_video(seg.data, |sample, rel| {
            if sink.ctl.stop.load(Ordering::Relaxed) {
                return false;
            }
            let t = plan::frame_time_ns(seg.base_ns, rel);
            // Der Container zählt in 90-kHz-Ticks: die Flow-Zeit weicht um einige µs vom Raster ab. Für die
            // Zugehörigkeit zum Segment/Bereich zählt deshalb t + Toleranz (ein Viertelbild), nie die genaue Grenze.
            let tt = t + period_ns / 4;
            if !plan::within(tt, Some(seg.start_ns), Some(seg.end_ns)) || tt < sink.course.start_ns {
                return true;
            }
            if sink.course.end_ns.is_some_and(|e| tt >= e) {
                finished = true;
                return false;
            }
            let (Some(buf), Some(caps)) = (sample.buffer_owned(), sample.caps_owned()) else { return true };
            if let Some(l) = last_flow {
                if t <= l {
                    return true;
                }
                let missing = plan::gap_fill_count(l, t, period_ns, (GAP_CAP_NS / period_ns.max(1)) as u64);
                for k in 1..=missing as i128 {
                    let filler = match gap {
                        GapMode::Hold => hold.as_ref().map(|(b, c)| (b.clone(), c.clone())),
                        GapMode::Black => {
                            if black.is_none() {
                                black = black_i420(&caps);
                            }
                            black.clone().map(|b| (b, caps.clone()))
                        }
                    };
                    let Some((fb, fc)) = filler else { break };
                    match sink.emit(&mut caps_set, fb, &fc, l + k * period_ns, period_ns) {
                        Emit::Stopped => return false,
                        Emit::Pushed => {
                            sink.stats.gaps_filled.fetch_add(1, Ordering::Relaxed);
                        }
                        Emit::Late => {}
                    }
                }
            }
            last_flow = Some(t);
            hold = Some((buf.clone(), caps.clone()));
            match sink.emit(&mut caps_set, buf, &caps, t, period_ns) {
                Emit::Pushed => {
                    sink.stats.frames_out.fetch_add(1, Ordering::Relaxed);
                    true
                }
                Emit::Late => true,
                Emit::Stopped => false,
            }
        });
        if let Err(e) = result
            && !sink.ctl.stop.load(Ordering::Relaxed)
        {
            sink.stats.error(format!("Video dekodieren: {e}"));
        }
    }
    sink.stats.lanes_done.fetch_add(1, Ordering::Relaxed);
}

/// Ton-Wiedergabe: wie [`play_video`], Einheit ist der Block; Lücken werden mit Stille gefüllt.
pub fn play_audio(sink: &Sink, rx: Receiver<Fetched>, rate: u32, channels: u32) {
    let mut caps_set: Option<gst::Caps> = None;
    let mut last_end: Option<i128> = None;
    let mut finished = false;
    let ns_of = |samples: u64| (samples as i128 * 1_000_000_000) / rate.max(1) as i128;
    while !finished && !sink.ctl.stop.load(Ordering::Relaxed) {
        let seg = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(s) => s,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let result = decode_audio(seg.data, rate, channels, |sample, first_idx| {
            if sink.ctl.stop.load(Ordering::Relaxed) {
                return false;
            }
            let (Some(buf), Some(caps)) = (sample.buffer_owned(), sample.caps_owned()) else { return true };
            let n = (buf.size() as u64) / (4 * channels.max(1) as u64);
            let t = seg.base_ns + ns_of(first_idx);
            let tt = t + 2_000_000; // Toleranz, s. Video
            if tt >= seg.end_ns || tt < sink.course.start_ns {
                return true;
            }
            if sink.course.end_ns.is_some_and(|e| tt >= e) {
                finished = true;
                return false;
            }
            if let Some(l) = last_end {
                let gap_ns = t - l;
                // über 2 ms Abstand: Lücke füllen (kürzere Abweichungen sind Rundung der Segmentgrenze)
                if gap_ns > 2_000_000 && gap_ns <= GAP_CAP_NS {
                    let mut at = l;
                    while t - at >= ns_of(SILENCE_BLOCK_SAMPLES) {
                        let bytes = (SILENCE_BLOCK_SAMPLES * 4 * channels as u64) as usize;
                        match sink.emit(&mut caps_set, gst::Buffer::from_mut_slice(vec![0u8; bytes]), &caps, at, ns_of(SILENCE_BLOCK_SAMPLES)) {
                            Emit::Stopped => return false,
                            Emit::Pushed => {
                                sink.stats.gaps_filled.fetch_add(1, Ordering::Relaxed);
                            }
                            Emit::Late => {}
                        }
                        at += ns_of(SILENCE_BLOCK_SAMPLES);
                    }
                } else if gap_ns < 0 {
                    return true; // Überlappung: nichts doppelt ausgeben
                }
            }
            last_end = Some(t + ns_of(n));
            match sink.emit(&mut caps_set, buf, &caps, t, ns_of(n)) {
                Emit::Pushed => {
                    sink.stats.blocks_out.fetch_add(1, Ordering::Relaxed);
                    true
                }
                Emit::Late => true,
                Emit::Stopped => false,
            }
        });
        if let Err(e) = result
            && !sink.ctl.stop.load(Ordering::Relaxed)
        {
            sink.stats.error(format!("Ton dekodieren: {e}"));
        }
    }
    sink.stats.lanes_done.fetch_add(1, Ordering::Relaxed);
}
