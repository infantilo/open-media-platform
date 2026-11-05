//! PGM-Monitor (Kapitel 87): ein kleines JPEG-Bild des Programmausgangs je Ebene, damit der Operator direkt im
//! Mischer auf ein PIP klicken kann. Läuft **abseits** der Sendepipeline: der Kompositor legt ohnehin das letzte Bild ab
//! (`PipelineHandle::last_frame`), ein eigener Thread codiert es nur dann, wenn der Vorschau-Port in den letzten
//! Sekunden abgerufen wurde — ohne Betrachter kostet der Monitor nichts und die Sendekette bleibt unberührt.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use omp_mediaio::preview::{self, Broadcaster};

use crate::pipeline::PipelineHandle;

/// Breite des Monitorbilds; die Höhe folgt dem Seitenverhältnis.
const MONITOR_WIDTH: i32 = 640;
/// So lange nach dem letzten Abruf wird weiter codiert.
const ACTIVE_WINDOW: Duration = Duration::from_secs(3);
/// Wie oft nach einem neuen Bild gesehen wird: ein Viertel der Bildperiode des Mischerausgangs (25 Bilder/s → 10 ms). Gecodet
/// wird nur, wenn der Kompositor seit dem letzten Mal ein neues Bild geliefert hat (Zeitstempel + Größe als Kennung); so läuft
/// der Monitor mit der Ausgangsrate, ohne dass Codierzeit und Wartezeit die Periode über 40 ms hinaus dehnen (ein fester
/// 40-ms-Schlaf nach jedem Bild ergab nur etwa 19 Bilder/s).
const TICK: Duration = Duration::from_millis(1000 * crate::pipeline::FRAMERATE_DENOMINATOR as u64 / crate::pipeline::FRAMERATE_NUMERATOR as u64 / 4);

struct Encoder {
    pipe: gst::Pipeline,
    src: gst_app::AppSrc,
    sink: gst_app::AppSink,
    caps: gst::Caps,
}

impl Encoder {
    fn new(caps: &gst::Caps) -> Result<Self, String> {
        let s = caps.structure(0).ok_or("Bild ohne Caps")?;
        let (w, h) = (s.get::<i32>("width").map_err(|e| e.to_string())?, s.get::<i32>("height").map_err(|e| e.to_string())?);
        let out_h = ((MONITOR_WIDTH as i64 * h as i64 / w.max(1) as i64) as i32).max(2) & !1;
        let desc = format!(
            "appsrc name=src format=time is-live=false block=false max-buffers=2 leaky-type=downstream ! videoconvert ! videoscale ! video/x-raw,width={MONITOR_WIDTH},height={out_h} ! jpegenc quality=70 ! appsink name=sink sync=false max-buffers=2 drop=true"
        );
        let pipe = gst::parse::launch(&desc).map_err(|e| e.to_string())?.downcast::<gst::Pipeline>().map_err(|_| "keine Pipeline")?;
        let src = pipe.by_name("src").ok_or("appsrc")?.downcast::<gst_app::AppSrc>().map_err(|_| "appsrc")?;
        let sink = pipe.by_name("sink").ok_or("appsink")?.downcast::<gst_app::AppSink>().map_err(|_| "appsink")?;
        src.set_caps(Some(caps));
        pipe.set_state(gst::State::Playing).map_err(|e| e.to_string())?;
        Ok(Encoder { pipe, src, sink, caps: caps.clone() })
    }

    /// Schiebt ein Bild in die Codierkette, ohne auf das Ergebnis zu warten (die Kette arbeitet nebenläufig).
    fn push(&self, sample: &gst::Sample) -> Option<()> {
        let mut buf = sample.buffer()?.copy();
        // Zeitstempel egal (nicht synchronisiert), aber gültig halten
        buf.get_mut()?.set_pts(gst::ClockTime::ZERO);
        self.src.push_buffer(buf).ok()?;
        Some(())
    }

    /// Holt alle bereits fertigen JPEGs ab (nicht blockierend), in Reihenfolge.
    fn ready(&self) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        while let Some(s) = self.sink.try_pull_sample(gst::ClockTime::ZERO) {
            if let Some(b) = s.buffer().and_then(|b| b.map_readable().ok().map(|m| m.as_slice().to_vec())) {
                out.push(b);
            }
        }
        out
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        let _ = self.pipe.set_state(gst::State::Null);
    }
}

/// Startet für jede Ebene einen Vorschau-Port und den Codier-Thread. Rückgabe: je Ebene (URL, Accept-Heartbeat).
pub fn start(handle: PipelineHandle, levels: usize, host: &str, shutdown: Arc<AtomicBool>) -> Result<Vec<(String, Arc<AtomicU64>)>, String> {
    let mut out = Vec::with_capacity(levels);
    for level in 0..levels {
        let broadcaster = Arc::new(Broadcaster::new());
        let heartbeat = Arc::new(AtomicU64::new(0));
        let port = preview::spawn("0.0.0.0:0", broadcaster.clone(), heartbeat.clone()).map_err(|e| format!("PGM-Monitor Port: {e}"))?;
        out.push((format!("http://{host}:{port}/preview"), heartbeat));
        let (h, sd) = (handle.clone(), shutdown.clone());
        std::thread::Builder::new()
            .name(format!("pgm-monitor-{level}"))
            .spawn(move || {
                let mut enc: Option<Encoder> = None;
                let mut last_key: Option<(Option<gst::ClockTime>, usize)> = None;
                while !sd.load(Ordering::Relaxed) {
                    std::thread::sleep(TICK);
                    if !broadcaster.requested_within(ACTIVE_WINDOW) {
                        enc = None; // niemand schaut: Encoder freigeben
                        last_key = None;
                        continue;
                    }
                    // Fertige JPEGs sofort veröffentlichen — auch in Runden ohne neues Bild.
                    if let Some(e) = enc.as_ref() {
                        for jpeg in e.ready() {
                            broadcaster.publish(&jpeg);
                        }
                    }
                    let Some(sample) = h.last_frame(level) else { continue };
                    let Some(caps) = sample.caps() else { continue };
                    // Dasselbe Bild nicht noch einmal codieren (Zeitstempel + Größe als Kennung).
                    let key = sample.buffer().map(|b| (b.pts(), b.size()));
                    if key.is_some() && key == last_key {
                        continue;
                    }
                    last_key = key;
                    if enc.as_ref().is_none_or(|e| e.caps.as_ref() != caps) {
                        enc = Encoder::new(&caps.to_owned()).map_err(|e| eprintln!("omp-video-mixer-me: PGM-Monitor Ebene {}: {e}", level + 1)).ok();
                    }
                    if let Some(e) = enc.as_ref() {
                        let _ = e.push(&sample);
                    }
                }
            })
            .map_err(|e| format!("PGM-Monitor Thread: {e}"))?;
    }
    Ok(out)
}
