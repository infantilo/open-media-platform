//! Ausgabewege von `omp-scte35` (Kapitel 37): Transportstrom-Sidecar (UDP/SRT) und MXL-ANC-Flow.
//! Die Zeitplanung des ANC-Pfads (`plan`, `render`) ist reine Logik und einzeln getestet; die
//! Threads (`TsOutput`, `AncOutput`) sind dünne Hüllen darum.

use std::net::UdpSocket;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_mediaio::mxl::{MxlContext, MxlDataOutput};

use crate::anc::{self, AncPacket};
use crate::cue::Cue;
use crate::{scte104, ts};

const MAX_33: u64 = (1u64 << 33) - 1;

/// Zeitquelle: MXL-TAI, wenn eine MXL-Instanz da ist, sonst UTC.
#[derive(Clone)]
pub struct Clock {
    ctx: Option<Arc<MxlContext>>,
}

impl Clock {
    pub fn new(ctx: Option<Arc<MxlContext>>) -> Self {
        Clock { ctx }
    }

    pub fn now_ns(&self) -> u64 {
        match &self.ctx {
            Some(c) => c.now_ns(),
            None => chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64,
        }
    }

    /// 90-kHz-Uhr (33 Bit) für `pts_time`.
    pub fn now_90k(&self) -> u64 {
        ((self.now_ns() as u128 * 9 / 100_000) as u64) & MAX_33
    }

    #[allow(dead_code)]
    pub fn is_tai(&self) -> bool {
        self.ctx.is_some()
    }
}

// ---------------------------------------------------------------------------
// Transportstrom
// ---------------------------------------------------------------------------

enum TsSink {
    Udp(UdpSocket),
    Gst(gstreamer_app::AppSrc, gstreamer::Pipeline),
}

impl TsSink {
    fn open(uri: &str) -> Result<TsSink, String> {
        if let Some(rest) = uri.strip_prefix("udp://") {
            let s = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("UDP-Socket: {e}"))?;
            s.connect(rest).map_err(|e| format!("UDP-Ziel „{rest}\u{201c}: {e}"))?;
            return Ok(TsSink::Udp(s));
        }
        if uri.starts_with("srt://") {
            use gstreamer::prelude::*;
            gstreamer::init().map_err(|e| format!("gst::init: {e}"))?;
            let pipeline = gstreamer::Pipeline::new();
            let appsrc = gstreamer_app::AppSrc::builder().is_live(true).do_timestamp(true).format(gstreamer::Format::Time).build();
            let sink = gstreamer::ElementFactory::make("srtsink").property("uri", uri).property("wait-for-connection", false).build().map_err(|e| format!("srtsink: {e}"))?;
            pipeline.add_many([appsrc.upcast_ref::<gstreamer::Element>(), &sink]).map_err(|e| e.to_string())?;
            gstreamer::Element::link_many([appsrc.upcast_ref::<gstreamer::Element>(), &sink]).map_err(|e| e.to_string())?;
            pipeline.set_state(gstreamer::State::Playing).map_err(|e| format!("srt-Pipeline: {e}"))?;
            return Ok(TsSink::Gst(appsrc, pipeline));
        }
        Err(format!("TS-Ziel „{uri}\u{201c}: erwartet udp://host:port oder srt://…"))
    }

    fn write(&mut self, packets: &[[u8; ts::PACKET]]) {
        let flat: Vec<u8> = packets.iter().flatten().copied().collect();
        match self {
            TsSink::Udp(s) => {
                for chunk in flat.chunks(7 * ts::PACKET) {
                    let _ = s.send(chunk);
                }
            }
            TsSink::Gst(src, _) => {
                let _ = src.push_buffer(gstreamer::Buffer::from_slice(flat));
            }
        }
    }
}

impl Drop for TsSink {
    fn drop(&mut self) {
        if let TsSink::Gst(_, p) = self {
            use gstreamer::prelude::*;
            let _ = p.set_state(gstreamer::State::Null);
        }
    }
}

/// Sidecar-Transportstrom mit den SCTE-35-Abschnitten (PAT/PMT periodisch, Abschnitte `repeat`-mal im Abstand von 100 ms).
pub struct TsOutput {
    tx: Sender<Vec<u8>>,
    pub uri: String,
    pub pid: u16,
}

impl TsOutput {
    pub fn start(uri: &str, pid: u16, repeat: u32) -> Result<TsOutput, String> {
        if !(32..=0x1FFE).contains(&pid) || pid == ts::PMT_PID {
            return Err(format!("PID {pid} ungültig (32…8190, nicht {})", ts::PMT_PID));
        }
        let mut sink = TsSink::open(uri)?;
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let repeat = repeat.max(1);
        std::thread::spawn(move || {
            let mut counters = ts::Counters::default();
            let mut pending: Vec<(Instant, Vec<u8>, u32)> = Vec::new();
            let mut next_psi = Instant::now();
            loop {
                match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(section) => pending.push((Instant::now(), section, repeat)),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                let now = Instant::now();
                if now >= next_psi {
                    let mut p = ts::pat(&mut counters);
                    p.extend(ts::pmt(&mut counters, pid));
                    sink.write(&p);
                    next_psi = now + Duration::from_millis(500);
                }
                for (due, section, left) in pending.iter_mut() {
                    if *left > 0 && now >= *due {
                        sink.write(&ts::scte35(&mut counters, pid, section));
                        *left -= 1;
                        *due = now + Duration::from_millis(100);
                    }
                }
                pending.retain(|(_, _, left)| *left > 0);
            }
        });
        Ok(TsOutput { tx, uri: uri.to_string(), pid })
    }

    pub fn send_section(&self, section: Vec<u8>) {
        let _ = self.tx.send(section);
    }
}

// ---------------------------------------------------------------------------
// ANC
// ---------------------------------------------------------------------------

/// Wann ein Marker in den ANC-Flow gehört (Grain-Indizes).
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub send_idx: u64,
    /// `None` = sofort (kein Vorlauf).
    pub cut_idx: Option<u64>,
}

/// Höchster `pre_roll_time` (16 Bit, ms).
const MAX_PRE_ROLL_MS: u64 = 65_535;

/// `cur`: aktueller Index, `cut_idx`: Index des Schnitts (`None` = sofort), `offset_frames`: Ausgleich
/// zwischen ANC- und Video-Index. Gesendet wird frühestens im nächsten Bild, bei sehr langem Vorlauf
/// erst, wenn er in `pre_roll_time` passt.
pub fn plan(cur: u64, cut_idx: Option<u64>, period_ns: u64, offset_frames: i64) -> Plan {
    let shift = |i: u64| (i as i64 + offset_frames).max(0) as u64;
    let next = cur + 1;
    match cut_idx {
        None => Plan { send_idx: shift(next), cut_idx: None },
        Some(cut) => {
            let max_frames = MAX_PRE_ROLL_MS * 1_000_000 / period_ns.max(1);
            let send = next.max(cut.saturating_sub(max_frames));
            Plan { send_idx: shift(send), cut_idx: Some(shift(cut.max(send))) }
        }
    }
}

pub struct Entry {
    pub cue: Cue,
    pub cut_idx: Option<u64>,
    pub next_idx: u64,
    pub sent: u32,
    pub total: u32,
    pub msg_no: u8,
}

/// Erzeugt die ANC-Pakete für den Grain `idx` aus allen fälligen Einträgen (und entfernt erledigte).
/// Der Vorlauf wird hier aus dem Abstand zum Schnitt-Index berechnet — dadurch stimmt er auch dann,
/// wenn der Grain verspätet geschrieben wird.
pub fn render(entries: &mut Vec<Entry>, idx: u64, period_ns: u64, line: u16) -> Result<Vec<AncPacket>, String> {
    let mut packets = Vec::new();
    for e in entries.iter_mut() {
        if e.next_idx > idx {
            continue;
        }
        let lead_ms = match e.cut_idx {
            Some(cut) if cut > idx => ((cut - idx) as u128 * period_ns as u128 / 1_000_000) as u64,
            _ => 0,
        };
        let cue = e.cue.with_lead(lead_ms);
        let mom = scte104::encode_mom(&cue.to_scte104(0)?, e.msg_no)?;
        packets.extend(anc::scte104_packets(&mom, line, 0, e.sent > 0));
        e.sent += 1;
        e.next_idx = idx + 1;
        // Nach dem Schnitt wird nicht mehr wiederholt.
        if e.cut_idx.is_some_and(|c| e.next_idx > c) {
            e.total = e.sent;
        }
    }
    entries.retain(|e| e.sent < e.total);
    Ok(packets)
}

pub struct AncOutput {
    out: Arc<MxlDataOutput>,
    queue: Arc<Mutex<Vec<Entry>>>,
    msg_no: std::sync::atomic::AtomicU8,
    offset_frames: i64,
    repeat: u32,
    pub flow_id: String,
}

impl AncOutput {
    pub fn start(ctx: Arc<MxlContext>, flow_id: &str, label: &str, rate: (u32, u32), line: u16, offset_frames: i64, repeat: u32) -> Result<AncOutput, String> {
        let out = Arc::new(MxlDataOutput::new(ctx, flow_id, label, flow_id, rate.0, rate.1)?);
        let queue: Arc<Mutex<Vec<Entry>>> = Arc::new(Mutex::new(Vec::new()));
        let (o, q) = (out.clone(), queue.clone());
        std::thread::spawn(move || {
            let period = o.period_ns();
            let mut last: Option<u64> = None;
            loop {
                let cur = o.current_index();
                if last.is_none_or(|l| cur > l) {
                    let packets = {
                        let mut g = q.lock().expect("lock poisoned");
                        render(&mut g, cur, period, line).unwrap_or_else(|e| {
                            eprintln!("omp-scte35: ANC-Kodierung: {e}");
                            g.clear();
                            Vec::new()
                        })
                    };
                    match anc::mxl_grain(&packets) {
                        Ok(grain) => {
                            if let Err(e) = o.write_grain(cur, &grain) {
                                eprintln!("omp-scte35: ANC schreiben: {e}");
                            }
                        }
                        Err(e) => eprintln!("omp-scte35: ANC-Grain: {e}"),
                    }
                    last = Some(cur);
                }
                o.sleep_until_index(last.unwrap_or(cur) + 1);
            }
        });
        Ok(AncOutput { out, queue, msg_no: Default::default(), offset_frames, repeat: repeat.max(1), flow_id: flow_id.to_string() })
    }

    /// Plant den Marker. `at_ns`: absoluter Schnittzeitpunkt (MXL-TAI ns), sonst gilt der Vorlauf des Markers.
    /// Rückgabe: Beschreibung für die Anzeige.
    pub fn submit(&self, cue: &Cue, at_ns: Option<u64>) -> String {
        let period = self.out.period_ns();
        let cur = self.out.current_index();
        let cut = match at_ns {
            Some(at) => Some(self.out.index_at_ns(at)),
            None => (cue.lead_ms() > 0).then(|| self.out.index_after_ns(cue.lead_ms() * 1_000_000)),
        };
        let p = plan(cur, cut, period, self.offset_frames);
        let msg_no = self.msg_no.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.queue.lock().expect("lock poisoned").push(Entry { cue: cue.clone(), cut_idx: p.cut_idx, next_idx: p.send_idx, sent: 0, total: self.repeat, msg_no });
        match p.cut_idx {
            Some(c) => format!("ANC-Grain {} (Schnitt in Grain {c}, {} Bilder später)", p.send_idx, c.saturating_sub(p.send_idx)),
            None => format!("ANC-Grain {} (sofort)", p.send_idx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P25: u64 = 40_000_000;

    #[test]
    fn plan_sends_in_the_next_frame_and_keeps_the_cut() {
        assert_eq!(plan(100, Some(200), P25, 0), Plan { send_idx: 101, cut_idx: Some(200) });
        assert_eq!(plan(100, None, P25, 0), Plan { send_idx: 101, cut_idx: None });
    }

    #[test]
    fn plan_waits_when_the_lead_exceeds_pre_roll_time() {
        // 65,5 s bei 25 fps = 1638 Bilder; Schnitt in 3000 Bildern → Senden erst 1638 Bilder vorher.
        let p = plan(0, Some(3000), P25, 0);
        assert_eq!(p.send_idx, 3000 - 1638);
    }

    #[test]
    fn plan_applies_the_offset_to_both_indices_and_never_goes_negative() {
        assert_eq!(plan(100, Some(200), P25, 2), Plan { send_idx: 103, cut_idx: Some(202) });
        assert_eq!(plan(0, None, P25, -5).send_idx, 0);
    }

    #[test]
    fn a_cut_in_the_past_becomes_immediate_lead_zero() {
        let p = plan(100, Some(50), P25, 0);
        assert_eq!((p.send_idx, p.cut_idx), (101, Some(101)));
    }

    fn decode(packets: &[AncPacket]) -> (Vec<scte104::Op>, bool) {
        let (m, dup) = anc::reassemble_scte104(packets).unwrap();
        (scte104::parse_mom(&m).unwrap().ops, dup)
    }

    #[test]
    fn render_derives_the_pre_roll_from_the_distance_to_the_cut_and_repeats_with_duplicates() {
        let mut q = vec![Entry { cue: Cue::Out { event_id: 1, duration_ms: Some(30_000), auto_return: true, lead_ms: 4000 }, cut_idx: Some(200), next_idx: 101, sent: 0, total: 3, msg_no: 4 }];
        let pre = |ops: &[scte104::Op]| match &ops[0] {
            scte104::Op::Splice { pre_roll_ms, kind, .. } => (*pre_roll_ms, *kind),
            o => panic!("{o:?}"),
        };
        assert!(render(&mut q, 100, P25, 9).unwrap().is_empty(), "noch nicht fällig");
        let (ops, dup) = decode(&render(&mut q, 101, P25, 9).unwrap());
        assert_eq!((pre(&ops), dup), ((3960, scte104::SpliceKind::StartNormal), false));
        let (ops, dup) = decode(&render(&mut q, 102, P25, 9).unwrap());
        assert_eq!((pre(&ops).0, dup), (3920, true));
        let (ops, dup) = decode(&render(&mut q, 103, P25, 9).unwrap());
        assert_eq!((pre(&ops).0, dup), (3880, true));
        assert!(q.is_empty(), "nach der dritten Sendung erledigt");
    }

    #[test]
    fn a_late_grain_shortens_the_pre_roll_accordingly() {
        let mut q = vec![Entry { cue: Cue::In { event_id: 1, lead_ms: 2000 }, cut_idx: Some(150), next_idx: 101, sent: 0, total: 1, msg_no: 0 }];
        let (ops, _) = decode(&render(&mut q, 120, P25, 9).unwrap()); // 19 Bilder zu spät
        assert!(matches!(ops[0], scte104::Op::Splice { pre_roll_ms: 1200, .. }), "{ops:?}");
    }

    #[test]
    fn nothing_is_repeated_after_the_cut() {
        let mut q = vec![Entry { cue: Cue::Out { event_id: 1, duration_ms: None, auto_return: false, lead_ms: 80 }, cut_idx: Some(102), next_idx: 100, sent: 0, total: 5, msg_no: 0 }];
        for idx in 100..110 {
            let _ = render(&mut q, idx, P25, 9).unwrap();
        }
        assert!(q.is_empty());
    }

    #[test]
    fn an_immediate_cue_past_its_cut_is_sent_as_immediate() {
        let mut q = vec![Entry { cue: Cue::Out { event_id: 1, duration_ms: None, auto_return: false, lead_ms: 80 }, cut_idx: Some(100), next_idx: 100, sent: 0, total: 1, msg_no: 0 }];
        let (ops, _) = decode(&render(&mut q, 105, P25, 9).unwrap());
        assert!(matches!(ops[0], scte104::Op::Splice { kind: scte104::SpliceKind::StartImmediate, pre_roll_ms: 0, .. }));
    }

    #[test]
    fn ts_output_over_udp_delivers_pat_pmt_and_the_section_repeatedly() {
        let rx = UdpSocket::bind("127.0.0.1:0").unwrap();
        rx.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let out = TsOutput::start(&format!("udp://{}", rx.local_addr().unwrap()), 500, 2).unwrap();
        let sec = Cue::Out { event_id: 5, duration_ms: Some(30_000), auto_return: true, lead_ms: 0 }.to_scte35(0).unwrap();
        out.send_section(sec.clone());
        let mut got = Vec::new();
        let mut buf = [0u8; 2048];
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(2) {
            if let Ok(n) = rx.recv(&mut buf) {
                got.extend_from_slice(&buf[..n]);
            }
            if let Ok(p) = ts::parse(&got)
                && p.sections.len() >= 2
            {
                break;
            }
        }
        let p = ts::parse(&got).unwrap();
        assert_eq!(p.streams, vec![(0x86, 500)]);
        assert!(p.sections.len() >= 2 && p.sections.iter().all(|s| *s == sec), "{} Abschnitte", p.sections.len());
    }

    #[test]
    fn bad_ts_settings_are_rejected() {
        assert!(TsOutput::start("udp://127.0.0.1:9", 5, 1).is_err());
        assert!(TsOutput::start("udp://127.0.0.1:9", ts::PMT_PID, 1).is_err());
        assert!(TsOutput::start("ftp://x", 500, 1).is_err());
    }
}
