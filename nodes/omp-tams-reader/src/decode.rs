//! Ein Segment dekodieren — MPEG-TS (`tsdemux`) oder fragmentiertes MP4 mit Init-Segment (`qtdemux`, Kapitel 105.3b; der Aufrufer
//! reicht Init + Medien-Segment hintereinander): eine kleine Pipeline je Segment (`appsrc ! Demuxer ! Parser ! Decoder ! appsink`).
//!
//! Je Segment eine eigene Pipeline, weil jedes Object seine **eigene Containerzeit** hat (der Schreiber legt `ts_offset`
//! je Segment fest, AppNote 0002): ein durchgehender Demuxer würde an jeder Segmentgrenze einen Zeitsprung sehen.
//! Die Aufrufer rechnen die Flow-Zeit aus `ts_offset` + erstem PTS (`plan::segment_base_ns`) + Abstand zum ersten
//! dekodierten Bild — nicht aus den Zeitstempeln des Demuxers, deren Nullpunkt der Demuxer wählt.
//!
//! Die Pipeline läuft nur, solange der Aufrufer Proben abnimmt (`appsink` mit kleinem Puffer): das Dekodieren richtet
//! sich damit nach dem Tempo der Ausgabe und braucht keinen Speicher für ein ganzes Segment.

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use std::time::Duration;

const SAMPLE_TIMEOUT: Duration = Duration::from_secs(10);

fn run<F>(data: Vec<u8>, description: &str, mut on_sample: F) -> Result<u64, String>
where
    F: FnMut(&gst::Sample) -> Result<bool, String>,
{
    gst::init().map_err(|e| format!("gst init: {e}"))?;
    // Der Demuxer richtet sich nach dem Inhalt: Beschreibungen sind für MPEG-TS geschrieben, bei MP4 wird der Demuxer getauscht
    let description = if omp_tams::mp4::looks_like_mp4(&data) {
        description.replace("tsdemux name=d d. ! video/x-h264 !", "qtdemux name=d d. ! video/x-h264 !").replace("tsdemux name=d d. ! audio/mpeg !", "qtdemux name=d d. ! audio/mpeg !")
    } else {
        description.to_string()
    };
    let pipeline = gst::parse::launch(&description)
        .map_err(|e| format!("Dekodier-Pipeline: {e}"))?
        .downcast::<gst::Pipeline>()
        .map_err(|_| "Dekodier-Pipeline: kein Pipeline-Objekt".to_string())?;
    let src = pipeline.by_name("src").and_then(|e| e.downcast::<gst_app::AppSrc>().ok()).ok_or("appsrc fehlt")?;
    let sink = pipeline.by_name("sink").and_then(|e| e.downcast::<gst_app::AppSink>().ok()).ok_or("appsink fehlt")?;
    let mp4 = omp_tams::mp4::looks_like_mp4(&data);
    src.set_caps(Some(&if mp4 { gst::Caps::builder("video/quicktime").build() } else { gst::Caps::builder("video/mpegts").field("systemstream", true).field("packetsize", 188i32).build() }));
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("Dekodieren starten: {e}"))?;
    let result = (|| {
        src.push_buffer(gst::Buffer::from_slice(data)).map_err(|e| format!("Object übergeben: {e:?}"))?;
        let _ = src.end_of_stream();
        let mut n = 0u64;
        loop {
            match sink.try_pull_sample(gst::ClockTime::from_nseconds(SAMPLE_TIMEOUT.as_nanos() as u64)) {
                Some(sample) => {
                    n += 1;
                    if !on_sample(&sample)? {
                        return Ok(n);
                    }
                }
                None => {
                    if let Some(bus) = pipeline.bus()
                        && let Some(m) = bus.pop_filtered(&[gst::MessageType::Error])
                        && let gst::MessageView::Error(e) = m.view()
                    {
                        return Err(format!("{} ({})", e.error(), e.debug().unwrap_or_default()));
                    }
                    if sink.is_eos() {
                        return Ok(n);
                    }
                    return Err("Zeitüberschreitung beim Dekodieren".to_string());
                }
            }
        }
    })();
    let _ = pipeline.set_state(gst::State::Null);
    result
}

/// Video (H.264) → I420. `on_frame(Probe, Abstand zum ersten Bild in ns)`; `false` beendet das Dekodieren früh.
/// Liefert die Zahl der dekodierten Bilder.
pub fn decode_video(data: Vec<u8>, mut on_frame: impl FnMut(&gst::Sample, u64) -> bool) -> Result<u64, String> {
    let mut first: Option<u64> = None;
    run(
        data,
        "appsrc name=src format=bytes ! tsdemux name=d d. ! video/x-h264 ! h264parse ! avdec_h264 ! videoconvert ! video/x-raw,format=I420 ! appsink name=sink sync=false max-buffers=2 drop=false",
        |s| {
            let pts = s.buffer().and_then(|b| b.pts()).ok_or("Bild ohne Zeitstempel")?.nseconds();
            let base = *first.get_or_insert(pts);
            Ok(on_frame(s, pts.saturating_sub(base)))
        },
    )
}

/// Ton (AAC) → F32LE, verschachtelt, `rate`/`channels` wie der MXL-Ausgang. `on_block(Probe, Nummer des ersten Samples
/// im Segment)`; `false` beendet früh. Liefert die Zahl der Blöcke.
pub fn decode_audio(data: Vec<u8>, rate: u32, channels: u32, mut on_block: impl FnMut(&gst::Sample, u64) -> bool) -> Result<u64, String> {
    let mut samples_so_far = 0u64;
    let desc = format!(
        "appsrc name=src format=bytes ! tsdemux name=d d. ! audio/mpeg ! aacparse ! avdec_aac ! audioconvert ! audioresample ! audio/x-raw,format=F32LE,layout=interleaved,rate={rate},channels={channels} ! appsink name=sink sync=false max-buffers=4 drop=false"
    );
    run(data, &desc, |s| {
        let size = s.buffer().map(|b| b.size()).unwrap_or(0) as u64;
        let idx = samples_so_far;
        samples_so_far += size / (4 * channels.max(1) as u64);
        Ok(on_block(s, idx))
    })
}
