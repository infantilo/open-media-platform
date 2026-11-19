//! GStreamer-Teil: Encoder → `splitmuxsink` (MPEG-TS) → Segmentdateien in der Warteschlange.
//!
//! **Zeitbereich eines Segments** (Spezifikation 8.2: Zeiten sind TAI-Zeiten, Segmente je Flow überlappungsfrei):
//! Vor dem Encoder merkt sich eine Pad-Probe je Puffer `(Laufzeit, MXL-Ursprungs-Index)`. Der Anfangsindex eines
//! Segments ist der Index zur Laufzeit, die `splitmuxsink-fragment-opened` meldet. Die **Länge** ergibt sich aus der
//! Laufzeitdauer (`closed − opened`), gerundet auf ganze Bilder bzw. Samples (Audio: auf AAC-Rahmen zu 1024
//! Samples, wenn nahe daran). Segmente werden **verkettet** (Ende = Anfang des nächsten): Überlappung ist dadurch
//! ausgeschlossen; weicht der Anfang um mehr als zwei Bilder/Rahmen nach hinten ab (Quelle war weg), entsteht eine
//! Lücke statt eines falschen Anschlusses.
//!
//! **Unabhängig dekodierbar** (AppNote 0005): `splitmuxsink` teilt nur an Schlüsselbildern; `h264parse` setzt vor
//! jedem IDR SPS/PPS ein (`config-interval=-1`). Ohne B-Bilder (`bframes=0`) ist PTS = DTS.

use crate::spool::{SegmentMeta, Spool};
use gstreamer as gst;
use gstreamer::prelude::*;
use omp_tams::index::{Rate, index_to_ns};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Liefert zu einem Puffer den MXL-Ursprungs-Index (Grain bei Video, erstes Sample bei Audio).
pub type OriginFn = Arc<dyn Fn(&gst::BufferRef) -> Option<u64> + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Video,
    Audio,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    /// Segment steht in der Warteschlange.
    Segment { flow_id: String, start_ns: u64, end_ns: u64, bytes: u64 },
    /// Segment konnte nicht zugeordnet werden und wurde verworfen.
    Dropped { flow_id: String, reason: String },
}

const RING_CAP: usize = 2048;
/// AAC-LC: Samples je Rahmen.
const AAC_FRAME: u64 = 1024;

pub struct Branch {
    pub flow_id: String,
    pub kind: Kind,
    rate: Rate,
    sink_name: String,
    spool: Arc<Spool>,
    ring: Arc<Mutex<VecDeque<(u64, u64)>>>,
    opened: Mutex<HashMap<String, u64>>,
    chain_next: Mutex<Option<u64>>,
}

fn short(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect()
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Pad-Probe: je Puffer (Laufzeit, Ursprungs-Index) merken.
fn arm_probe(tail: &gst::Element, ring: Arc<Mutex<VecDeque<(u64, u64)>>>, origin: OriginFn) -> Result<(), String> {
    let pad = tail.static_pad("src").ok_or("Eingang ohne src-Pad")?;
    pad.add_probe(gst::PadProbeType::BUFFER, move |pad, info| {
        if let Some(gst::PadProbeData::Buffer(buf)) = &info.data
            && let Some(pts) = buf.pts()
        {
            let rt = pad
                .sticky_event::<gst::event::Segment>(0)
                .and_then(|e| e.segment().downcast_ref::<gst::format::Time>().and_then(|s| s.to_running_time(pts)))
                .unwrap_or(pts);
            if let Some(idx) = origin(buf) {
                let mut r = ring.lock().expect("lock poisoned");
                if r.len() >= RING_CAP {
                    r.pop_front();
                }
                r.push_back((rt.nseconds(), idx));
            }
        }
        gst::PadProbeReturn::Ok
    });
    Ok(())
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory).build().map_err(|e| format!("{factory}: {e}"))
}

#[allow(clippy::too_many_arguments)]
fn build_branch(
    pipeline: &gst::Pipeline,
    tail: &gst::Element,
    flow_id: &str,
    kind: Kind,
    rate: Rate,
    segment_ns: u64,
    spool: Arc<Spool>,
    origin: OriginFn,
    chain: Vec<gst::Element>,
    mux_pad: &str,
    max_size_time: u64,
) -> Result<Arc<Branch>, String> {
    let sink_name = format!("split-{}-{}", short(flow_id), if kind == Kind::Video { "v" } else { "a" });
    let muxer = make("mpegtsmux")?;
    let split = gst::ElementFactory::make("splitmuxsink")
        .name(sink_name.as_str())
        .property("muxer", &muxer)
        .property("max-size-time", max_size_time)
        .property("send-keyframe-requests", false)
        .property("max-size-bytes", 0u64)
        .build()
        .map_err(|e| format!("splitmuxsink: {e}"))?;
    let _ = segment_ns;
    let counter = Arc::new(AtomicU64::new(0));
    {
        let (spool, counter, flow) = (spool.clone(), counter.clone(), short(flow_id));
        let t0 = unix_ms();
        split.connect("format-location", false, move |_| {
            let n = counter.fetch_add(1, Ordering::Relaxed);
            let name = format!("{flow}-{t0}-{n:06}.ts");
            Some(spool.file_path(&name).to_string_lossy().to_string().to_value())
        });
    }
    pipeline.add(&split).map_err(|e| format!("add splitmuxsink: {e}"))?;
    pipeline.add_many(&chain).map_err(|e| format!("add Zweig: {e}"))?;
    let mut all: Vec<&gst::Element> = vec![tail];
    all.extend(chain.iter());
    gst::Element::link_many(all).map_err(|e| format!("link Zweig: {e}"))?;
    let last = chain.last().ok_or("leerer Zweig")?;
    let pad = split.request_pad_simple(mux_pad).ok_or_else(|| format!("splitmuxsink: Pad {mux_pad} nicht verfügbar"))?;
    last.static_pad("src").ok_or("Zweig ohne src-Pad")?.link(&pad).map_err(|e| format!("link zu splitmuxsink: {e}"))?;

    let ring = Arc::new(Mutex::new(VecDeque::with_capacity(RING_CAP)));
    arm_probe(tail, ring.clone(), origin)?;
    Ok(Arc::new(Branch { flow_id: flow_id.to_string(), kind, rate, sink_name, spool, ring, opened: Mutex::new(HashMap::new()), chain_next: Mutex::new(None) }))
}

/// Video-Zweig: `tail ! videoconvert ! x264enc ! h264parse ! splitmuxsink(mpegtsmux)`.
///
/// `gop_frames` Bilder je GOP (Schlüsselbild-Abstand); Segmentlänge ≈ `segment_ns`, wirksam an der nächsten GOP-Grenze.
#[allow(clippy::too_many_arguments)]
pub fn add_video_branch(
    pipeline: &gst::Pipeline,
    tail: &gst::Element,
    flow_id: &str,
    fps: Rate,
    segment_ns: u64,
    bitrate_kbps: u32,
    spool: Arc<Spool>,
    origin: OriginFn,
) -> Result<Arc<Branch>, String> {
    let gop = (((segment_ns as f64) / 1e9) * fps.num as f64 / fps.den as f64).round().max(1.0) as u32;
    let convert = make("videoconvert")?;
    let enc = gst::ElementFactory::make("x264enc")
        .property("bitrate", bitrate_kbps)
        .property("key-int-max", gop)
        .property("bframes", 0u32)
        .build()
        .map_err(|e| format!("x264enc: {e}"))?;
    // GEnum: nur als Text setzbar (Projektfund)
    enc.set_property_from_str("speed-preset", "veryfast");
    enc.set_property_from_str("tune", "zerolatency");
    let parse = gst::ElementFactory::make("h264parse").property("config-interval", -1i32).build().map_err(|e| format!("h264parse: {e}"))?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("video/x-h264").field("stream-format", "byte-stream").field("alignment", "au").build())
        .build()
        .map_err(|e| format!("capsfilter: {e}"))?;
    let queue = make("queue")?;
    // Teilen ab 95 % der GOP-Dauer: der Schnitt fällt dann sicher auf das nächste Schlüsselbild, nicht erst auf das übernächste
    let max = (segment_ns as f64 * 0.95) as u64;
    build_branch(pipeline, tail, flow_id, Kind::Video, fps, segment_ns, spool, origin, vec![convert, enc, parse, caps, queue], "video", max)
}

#[allow(clippy::too_many_arguments)]
/// Audio-Zweig: `tail ! audioconvert ! audioresample ! avenc_aac ! aacparse ! splitmuxsink(mpegtsmux)`.
pub fn add_audio_branch(
    pipeline: &gst::Pipeline,
    tail: &gst::Element,
    flow_id: &str,
    sample_rate: u32,
    segment_ns: u64,
    bitrate_bps: i32,
    spool: Arc<Spool>,
    origin: OriginFn,
) -> Result<Arc<Branch>, String> {
    let convert = make("audioconvert")?;
    let resample = make("audioresample")?;
    let enc = make("avenc_aac")?;
    enc.set_property("bitrate", bitrate_bps);
    let parse = make("aacparse")?;
    let caps = gst::ElementFactory::make("capsfilter")
        .property("caps", gst::Caps::builder("audio/mpeg").field("mpegversion", 4i32).field("stream-format", "adts").build())
        .build()
        .map_err(|e| format!("capsfilter: {e}"))?;
    let queue = make("queue")?;
    let rate = Rate::new(sample_rate, 1).ok_or("Abtastrate 0")?;
    build_branch(pipeline, tail, flow_id, Kind::Audio, rate, segment_ns, spool, origin, vec![convert, resample, enc, parse, caps, queue], "audio_%u", segment_ns)
}

impl Branch {
    /// Index zur Laufzeit `rt` (nächster gemerkter Eintrag) und Abstand in Indexeinheiten.
    fn lookup(&self, rt: u64) -> Option<u64> {
        let r = self.ring.lock().expect("lock poisoned");
        let (best_rt, best_idx) = r.iter().min_by_key(|(t, _)| t.abs_diff(rt)).copied()?;
        // Abstand in Bildern/Samples umrechnen und Zusatz hinzurechnen
        let diff_ns = rt as i128 - best_rt as i128;
        let diff_idx = (diff_ns * self.rate.num as i128 / (self.rate.den as i128 * 1_000_000_000)) as i64;
        if diff_idx.unsigned_abs() > self.tolerance() * 8 {
            return None; // Eintrag zu weit weg: Zuordnung nicht verlässlich
        }
        Some((best_idx as i64 + diff_idx).max(0) as u64)
    }

    /// Toleranz in Index-Einheiten: zwei Bilder bzw. zwei AAC-Rahmen.
    fn tolerance(&self) -> u64 {
        match self.kind {
            Kind::Video => 2,
            Kind::Audio => 2 * AAC_FRAME,
        }
    }

    /// Anzahl Bilder bzw. Samples **aus der Datei** (exakt, unabhängig vom Zeitpunkt der Meldung: das zuletzt geschlossene
    /// Fragment meldet beim EOS mal die Laufzeit des letzten Bildes, mal dessen Ende). `None`, wenn nicht lesbar.
    fn count_in_file(&self, location: &str) -> Option<u64> {
        let data = std::fs::read(location).ok()?;
        let n = match self.kind {
            Kind::Video => omp_tams::mpegts::video_frame_count(&data)? as u64,
            Kind::Audio => omp_tams::mpegts::aac_frame_count(&data)? as u64 * AAC_FRAME,
        };
        (n > 0).then_some(n)
    }

    /// Anzahl Indizes (Bilder/Samples) aus einer Laufzeitdauer (Rückfall, wenn die Datei nicht lesbar ist).
    fn count_from_duration(&self, dur_ns: u64) -> u64 {
        let exact = dur_ns as u128 * self.rate.num as u128;
        let den = self.rate.den as u128 * 1_000_000_000;
        let n = ((exact + den / 2) / den) as u64;
        if self.kind == Kind::Audio {
            let snapped = ((n + AAC_FRAME / 2) / AAC_FRAME) * AAC_FRAME;
            if snapped > 0 && snapped.abs_diff(n) <= 64 {
                return snapped;
            }
        }
        n
    }

    /// Verarbeitet Meldungen von `splitmuxsink`. Andere Meldungen und fremde Zweige: `None`.
    pub fn handle_message(&self, msg: &gst::Message) -> Option<Event> {
        let gst::MessageView::Element(el) = msg.view() else { return None };
        if msg.src().map(|s| s.name().to_string()).as_deref() != Some(self.sink_name.as_str()) {
            return None;
        }
        let s = el.structure()?;
        let location = s.get::<String>("location").ok()?;
        let rt = s.get::<u64>("running-time").ok()?;
        match s.name().as_str() {
            "splitmuxsink-fragment-opened" => {
                self.opened.lock().expect("lock poisoned").insert(location, rt);
                None
            }
            "splitmuxsink-fragment-closed" => {
                let start_rt = self.opened.lock().expect("lock poisoned").remove(&location)?;
                self.close_fragment(&location, start_rt, rt)
            }
            _ => None,
        }
    }

    fn drop_file(&self, location: &str, reason: String) -> Event {
        let _ = std::fs::remove_file(location);
        Event::Dropped { flow_id: self.flow_id.clone(), reason }
    }

    /// `None` bei leeren Fragmenten (entstehen beim Beenden: `splitmuxsink` öffnet am EOS noch ein Fragment) — kein Fehler.
    fn close_fragment(&self, location: &str, start_rt: u64, end_rt: u64) -> Option<Event> {
        let size = std::fs::metadata(location).map(|m| m.len()).unwrap_or(0);
        if size == 0 || end_rt <= start_rt {
            let _ = std::fs::remove_file(location);
            return None;
        }
        let Some(looked_up) = self.lookup(start_rt) else {
            return Some(self.drop_file(location, format!("kein Ursprungs-Index zur Laufzeit {start_rt} (Quelle ohne MXL-Zeitangabe?)")));
        };
        let count = self.count_in_file(location).unwrap_or_else(|| self.count_from_duration(end_rt - start_rt));
        if count == 0 {
            return Some(self.drop_file(location, "Segment ohne Dauer".to_string()));
        }
        let mut chain = self.chain_next.lock().expect("lock poisoned");
        let start_idx = match *chain {
            // lückenloser Anschluss, solange der Anfang nur um Rundung abweicht (oder vor dem Anschluss liegt: nie überlappen)
            Some(next) if looked_up <= next + self.tolerance() => next,
            // Quelle war eine Weile weg: Lücke zulassen
            _ => looked_up,
        };
        let end_idx = start_idx + count;
        *chain = Some(end_idx);
        drop(chain);
        let start_ns = index_to_ns(start_idx, self.rate);
        let end_ns = index_to_ns(end_idx, self.rate);
        let file = std::path::Path::new(location).file_name().and_then(|f| f.to_str()).unwrap_or(location).to_string();
        let meta = SegmentMeta { flow_id: self.flow_id.clone(), file, start_ns, end_ns, key_frame_count: 1, size, slot: None };
        Some(match self.spool.add(&meta) {
            Ok(()) => Event::Segment { flow_id: self.flow_id.clone(), start_ns, end_ns, bytes: size },
            Err(e) => self.drop_file(location, format!("Warteschlange nicht beschreibbar: {e}")),
        })
    }
}

/// Zeitpunkt, bis zu dem alle Zweige ihre letzten Segmente geschlossen haben sollen (EOS-Wartezeit).
pub const STOP_EOS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg(test)]
mod tests {
    use super::*;

    fn branch(kind: Kind, rate: Rate) -> Branch {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("omp-seg-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        Branch {
            flow_id: "f".into(),
            kind,
            rate,
            sink_name: "s".into(),
            spool: Arc::new(Spool::open(d, 1 << 20).unwrap()),
            ring: Arc::new(Mutex::new(VecDeque::new())),
            opened: Mutex::new(HashMap::new()),
            chain_next: Mutex::new(None),
        }
    }

    #[test]
    fn video_count_rounds_to_whole_frames() {
        let b = branch(Kind::Video, Rate::new(25, 1).unwrap());
        assert_eq!(b.count_from_duration(2_000_000_000), 50);
        assert_eq!(b.count_from_duration(2_015_000_000), 50); // 0,4 Bild Überstand
        assert_eq!(b.count_from_duration(2_030_000_000), 51); // 0,75 Bild → 51
        let b = branch(Kind::Video, Rate::new(30000, 1001).unwrap());
        assert_eq!(b.count_from_duration(2_002_000_000), 60); // 60 Bilder = 2,002 s
    }

    #[test]
    fn audio_count_snaps_to_aac_frames() {
        let b = branch(Kind::Audio, Rate::new(48000, 1).unwrap());
        // 2 s = 96000 Samples = 93,75 Rahmen: nahe an 94·1024 = 96256? 256 Samples entfernt → nicht einrasten
        assert_eq!(b.count_from_duration(2_000_000_000), 96_000);
        // 2,0213 s ≈ 97 024 Samples = 94,75 Rahmen: weit weg
        // exakt 94 Rahmen = 96 256 Samples = 2,005333 s → einrasten, auch mit Rundungsrauschen
        assert_eq!(b.count_from_duration(2_005_333_333), 96_256);
        assert_eq!(b.count_from_duration(2_005_340_000), 96_256);
    }

    #[test]
    fn lookup_interpolates_between_entries_and_refuses_far_ones() {
        let b = branch(Kind::Video, Rate::new(25, 1).unwrap());
        {
            let mut r = b.ring.lock().unwrap();
            for i in 0..100u64 {
                r.push_back((i * 40_000_000, 1000 + i));
            }
        }
        assert_eq!(b.lookup(0), Some(1000));
        assert_eq!(b.lookup(1_000_000_000), Some(1025));
        // zwischen zwei Bildern: nächster Eintrag plus Bruchteil, abgerundet
        assert_eq!(b.lookup(1_040_000_000 + 20_000_000), Some(1026));
        // viel später als der letzte Eintrag: nicht verlässlich
        assert_eq!(b.lookup(60_000_000_000), None);
        // leer
        assert_eq!(branch(Kind::Video, Rate::new(25, 1).unwrap()).lookup(0), None);
    }

    #[test]
    fn segments_chain_without_gap_or_overlap_and_gaps_are_kept() {
        let b = branch(Kind::Video, Rate::new(25, 1).unwrap());
        {
            let mut r = b.ring.lock().unwrap();
            for i in 0..2000u64 {
                r.push_back((i * 40_000_000, 5000 + i));
            }
        }
        let dir = b.spool.dir().to_path_buf();
        let mk = |n: u32| {
            let p = dir.join(format!("f-{n}.ts"));
            std::fs::write(&p, vec![0u8; 188]).unwrap();
            p.to_string_lossy().to_string()
        };
        // Segment 1: 0 s … 2,03 s, Segment 2 beginnt bei 2,0 s (Rundung), Segment 3 nach einer Lücke bei 10 s
        let e1 = b.close_fragment(&mk(1), 0, 2_030_000_000).unwrap();
        let e2 = b.close_fragment(&mk(2), 2_000_000_000, 4_000_000_000).unwrap();
        let e3 = b.close_fragment(&mk(3), 10_000_000_000, 12_000_000_000).unwrap();
        let get = |e: Event| match e {
            Event::Segment { start_ns, end_ns, .. } => (start_ns, end_ns),
            other => panic!("{other:?}"),
        };
        let (s1, n1) = get(e1);
        let (s2, n2) = get(e2);
        let (s3, n3) = get(e3);
        assert_eq!(s1, index_to_ns(5000, Rate::new(25, 1).unwrap()));
        assert_eq!(n1 - s1, 2_040_000_000); // 51 Bilder (2,03 s → 50,75 gerundet)
        assert_eq!(s2, n1, "lückenloser Anschluss trotz Rundung");
        assert_eq!(n2 - s2, 2_000_000_000);
        // Quelle: Segment 3 beginnt bei 10 s = Index 5250; verkettet endete Segment 2 bei Index 5101 (51 + 50 Bilder)
        assert_eq!(s3 - n2, 149 * 40_000_000, "echte Lücke bleibt eine Lücke");
        assert_eq!(n3 - s3, 2_000_000_000);
        assert_eq!(b.spool.pending().len(), 3);
    }

    #[test]
    fn unmatched_or_empty_fragments_are_dropped_with_a_reason() {
        let b = branch(Kind::Video, Rate::new(25, 1).unwrap());
        let p = b.spool.dir().join("x.ts");
        std::fs::write(&p, vec![0u8; 188]).unwrap();
        match b.close_fragment(p.to_str().unwrap(), 0, 2_000_000_000).unwrap() {
            Event::Dropped { reason, .. } => assert!(reason.contains("Ursprungs-Index"), "{reason}"),
            other => panic!("{other:?}"),
        }
        assert!(!p.exists());
        std::fs::write(&p, b"").unwrap();
        // leeres Fragment (EOS): kein Ereignis, Datei entfernt
        assert_eq!(b.close_fragment(p.to_str().unwrap(), 0, 2_000_000_000), None);
        assert!(!p.exists());
    }
}
