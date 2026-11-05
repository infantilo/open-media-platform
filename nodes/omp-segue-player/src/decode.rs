//! Dateien vollständig in den Speicher decodieren (48 kHz, Stereo, f32): sample-genaues Starten braucht fertig bereitliegendes
//! Material. Ein kleiner Zwischenspeicher hält zuletzt benutzte Dateien (Jingles, Bett) vor.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;

use crate::mix::{CH, SR};

/// Längste Datei (Minuten) — danach Fehler statt Speicherexplosion.
pub const MAX_MINUTES: usize = 20;

/// Decodiert `path` vollständig. Blockiert (eigener Thread des Aufrufers).
pub fn decode(path: &Path) -> Result<Vec<f32>, String> {
    let uri = gst::glib::filename_to_uri(path, None).map_err(|e| format!("Pfad: {e}"))?;
    let pipeline = gst::Pipeline::new();
    let src = gst::ElementFactory::make("uridecodebin").property("uri", uri.as_str()).property("expose-all-streams", false).build().map_err(|e| e.to_string())?;
    let conv = gst::ElementFactory::make("audioconvert").build().map_err(|e| e.to_string())?;
    let resample = gst::ElementFactory::make("audioresample").build().map_err(|e| e.to_string())?;
    let caps = gst::Caps::builder("audio/x-raw").field("format", "F32LE").field("layout", "interleaved").field("rate", SR as i32).field("channels", CH as i32).build();
    let sink = gst_app::AppSink::builder().caps(&caps).sync(false).build();
    let drain = gst::ElementFactory::make("fakesink").property("sync", false).property("async", false).build().map_err(|e| e.to_string())?;
    pipeline.add_many([&src, &conv, &resample, sink.upcast_ref::<gst::Element>(), &drain]).map_err(|e| e.to_string())?;
    gst::Element::link_many([&conv, &resample, sink.upcast_ref::<gst::Element>()]).map_err(|e| e.to_string())?;
    let audio_sink = conv.static_pad("sink").ok_or("audioconvert: kein Sink-Pad")?;
    let drain_sink = drain.static_pad("sink").ok_or("fakesink: kein Sink-Pad")?;
    src.connect_pad_added(move |_s, pad| {
        let Some(caps) = pad.current_caps() else { return };
        let Some(st) = caps.structure(0) else { return };
        let target = if st.name().starts_with("audio/") { &audio_sink } else { &drain_sink };
        if !target.is_linked() {
            let _ = pad.link(target);
        }
    });
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("Start: {e}"))?;
    let max_frames = SR as usize * 60 * MAX_MINUTES;
    let mut out: Vec<f32> = Vec::new();
    let result = loop {
        let Some(sample) = sink.try_pull_sample(gst::ClockTime::from_seconds(10)) else {
            if sink.is_eos() {
                break Ok(());
            }
            // Zeitüberschreitung ohne Daten: Bus nach Fehler fragen
            if let Some(msg) = pipeline.bus().and_then(|b| b.pop_filtered(&[gst::MessageType::Error])) {
                if let gst::MessageView::Error(e) = msg.view() {
                    break Err(format!("{}", e.error()));
                }
            }
            break Err("Zeitüberschreitung beim Decodieren".to_string());
        };
        let buf = sample.buffer().ok_or("Puffer fehlt")?;
        let map = buf.map_readable().map_err(|_| "Puffer nicht lesbar".to_string())?;
        for c in map.as_slice().chunks_exact(4) {
            out.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
        }
        if out.len() / CH > max_frames {
            break Err(format!("Datei länger als {MAX_MINUTES} Minuten"));
        }
    };
    let _ = pipeline.set_state(gst::State::Null);
    result?;
    if out.is_empty() {
        return Err("keine Tonspur gefunden".to_string());
    }
    Ok(out)
}

/// Decodierte Dateien, begrenzt in Bytes (älteste fliegen zuerst raus). Schlüssel: Pfad + Änderungszeit.
pub struct Cache {
    max_bytes: usize,
    inner: Mutex<CacheInner>,
}

#[derive(Default)]
struct CacheInner {
    map: HashMap<String, (Arc<Vec<f32>>, u64)>,
    tick: u64,
    bytes: usize,
}

impl Cache {
    pub fn new(max_mib: usize) -> Cache {
        Cache { max_bytes: max_mib * 1024 * 1024, inner: Mutex::new(CacheInner::default()) }
    }

    fn key(path: &Path) -> String {
        let m = std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis());
        format!("{}|{m}", path.display())
    }

    pub fn get_or_decode(&self, path: &Path) -> Result<Arc<Vec<f32>>, String> {
        let key = Self::key(path);
        {
            let mut c = self.inner.lock().expect("lock poisoned");
            c.tick += 1;
            let t = c.tick;
            if let Some((a, last)) = c.map.get_mut(&key) {
                *last = t;
                return Ok(a.clone());
            }
        }
        let data = Arc::new(decode(path)?);
        let mut c = self.inner.lock().expect("lock poisoned");
        c.tick += 1;
        let t = c.tick;
        c.bytes += data.len() * 4;
        c.map.insert(key, (data.clone(), t));
        while c.bytes > self.max_bytes && c.map.len() > 1 {
            // älteste Datei entfernen (nie die gerade eingefügte)
            let oldest = c.map.iter().filter(|(_, (_, last))| *last != t).min_by_key(|(_, (_, last))| *last).map(|(k, _)| k.clone());
            let Some(k) = oldest else { break };
            if let Some((a, _)) = c.map.remove(&k) {
                c.bytes -= a.len() * 4;
            }
        }
        Ok(data)
    }

    pub fn bytes(&self) -> usize {
        self.inner.lock().expect("lock poisoned").bytes
    }
}
