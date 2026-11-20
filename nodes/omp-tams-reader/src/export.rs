//! Clip-Export (Kapitel 105.6): einen Zeitbereich aus dem Speicher als **Datei** ablegen (MP4, MKV, TS, MOV).
//!
//! Die Segmente sind MPEG-TS-Objects mit je **eigener Containerzeit** (`ts_offset`, AppNote 0002). Ein bloßes Aneinanderhängen der
//! Bytes ergäbe Zeitsprünge; deshalb geht jedes Segment als eigene Datei in den `concat`-Demuxer von ffmpeg, der die Zeiten
//! fortlaufend aneinanderlegt. Video und Ton sind getrennte Flows: der Ton bekommt den Versatz seines ersten Segments zum
//! ersten Videosegment als `-itsoffset`.
//!
//! * **Standard (Stream-Copy):** verlustfrei und schnell, der Bereich wird auf **ganze Segmente** erweitert (das Schnittbild liegt am
//!   Anfang jedes Segments); der tatsächliche Bereich steht im Ergebnis.
//! * **`exact`:** genau `[start, end)`, dafür neu kodiert (H.264/AAC).
//! * **Lücken** zwischen Segmenten werden **nicht** gefüllt (die Datei ist dort kürzer als die Zeitachse); ihre Zahl steht im Ergebnis.

use crate::plan;
use omp_tams::client::{Client, SegmentQuery};
use omp_tams::copy::range_ns;
use omp_tams::mpegts::first_pts;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_OBJECT_BYTES: u64 = 256 << 20;
const MAX_SEGMENTS: usize = 20_000;
const MAX_CLIP_NS: i128 = 6 * 3600 * 1_000_000_000;

#[derive(Clone, Debug)]
pub struct Request {
    pub video: Option<String>,
    pub audio: Option<String>,
    pub start_ns: i128,
    pub end_ns: i128,
    pub exact: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub path: PathBuf,
    /// Tatsächlich enthaltener Bereich in Flow-Zeit (bei Stream-Copy auf Segmentgrenzen erweitert).
    pub from_ns: i128,
    pub to_ns: i128,
    pub segments: usize,
    /// Zahl der Lücken zwischen aufeinanderfolgenden Segmenten (nicht gefüllt).
    pub gaps: usize,
}

struct Track {
    /// Concat-Liste (MPEG-TS) oder fertige MP4-Datei (fragmentiertes MP4: ein durchgehender Strom)
    list: PathBuf,
    /// `true`: `list` ist ein Strom (`-i datei`), sonst eine Concat-Liste
    stream: bool,
    first_start: i128,
    last_end: i128,
    segments: usize,
    gaps: usize,
}

/// Dateiname: nur Buchstaben, Ziffern, `.`, `_`, `-`; Endung `mp4|mkv|ts|mov` (Standard `.mp4`). Kein Pfad.
pub fn safe_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.len() > 120 || n.starts_with('.') || !n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err("Dateiname ungültig (erlaubt: Buchstaben, Ziffern, . _ -; höchstens 120 Zeichen)".into());
    }
    let ext = n.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("mp4" | "mkv" | "ts" | "mov") => Ok(n.to_string()),
        Some(_) => Err("Endung muss mp4, mkv, ts oder mov sein".into()),
        None => Ok(format!("{n}.mp4")),
    }
}

/// Zeile für die Concat-Liste; Pfade stammen von uns (nur sichere Zeichen), die Anführungszeichen sind trotzdem maskiert.
fn concat_line(p: &Path) -> String {
    format!("file '{}'\n", p.display().to_string().replace('\'', "'\\''"))
}

fn fetch_track(client: &Client, flow: &str, req: &Request, dir: PathBuf, stop: &AtomicBool) -> Result<Track, String> {
    std::fs::create_dir_all(&dir).map_err(|e| format!("Arbeitsverzeichnis: {e}"))?;
    let q = SegmentQuery { timerange: Some(range_ns(req.start_ns, req.end_ns)), ..Default::default() };
    let mut segs: Vec<(i128, i128, omp_tams::types::Segment)> = client
        .list_segments(flow, &q, MAX_SEGMENTS)
        .map_err(|e| format!("Segmente abfragen: {e}"))?
        .into_iter()
        .filter_map(|s| match omp_tams::time::TimeRange::parse(&s.timerange).ok().as_ref().and_then(plan::bounds_ns) {
            Some((Some(a), Some(b))) => Some((a, b, s)),
            _ => None,
        })
        .collect();
    segs.sort_by_key(|(a, _, _)| *a);
    if segs.is_empty() {
        return Err(format!("im Zeitbereich liegt keine Aufnahme (Flow {flow})"));
    }
    let mut list = String::new();
    let (mut mp4_init, mut mp4_init_id, mut mp4_origin, mut mp4_media): (Vec<u8>, Option<String>, Option<i128>, Vec<u8>) = (Vec::new(), None, None, Vec::new());
    let (mut gaps, mut prev_end) = (0usize, None::<i128>);
    for (i, (a, b, s)) in segs.iter().enumerate() {
        if stop.load(Ordering::Relaxed) {
            return Err("abgebrochen".into());
        }
        let url = s.get_urls.first().map(|g| g.url.clone()).ok_or_else(|| format!("Segment {} ohne Adresse", s.timerange))?;
        let mut data = client.download_object(&url, MAX_OBJECT_BYTES).map_err(|e| format!("Object laden ({}): {e}", s.timerange))?;
        if omp_tams::mp4::looks_like_mp4(&data) {
            // Fragmentiertes MP4: Init-Segment (je Object-ID einmal geladen); alle Segmente werden zu EINEM Strom mit durchgehender
            // Zeit zusammengesetzt (tfdt neu gesetzt: Flow-Zeit des Segments − Flow-Zeit des ersten), Lücken bleiben als Zeitsprung
            let init_id = s.init_object_id.clone().or_else(|| s.init_object.as_ref().and_then(|o| o["object_id"].as_str()).map(str::to_string)).ok_or_else(|| format!("Segment {} nennt kein Init-Segment", s.timerange))?;
            if let Some(prev) = &mp4_init_id
                && *prev != init_id
            {
                return Err("das Init-Segment wechselt im Bereich — als eine Datei nicht exportierbar (Bereich teilen)".into());
            }
            if mp4_init.is_empty() {
                let iurl = s.init_object.as_ref().and_then(|o| o["get_urls"][0]["url"].as_str()).ok_or_else(|| format!("Init-Segment {init_id} ohne Adresse"))?;
                mp4_init = client.download_object(iurl, 16 << 20).map_err(|e| format!("Init-Segment laden: {e}"))?;
                mp4_init_id = Some(init_id);
            }
            let ts = omp_tams::mp4::timescale(&mp4_init).ok_or("Init-Segment ohne Zeitskala")? as i128;
            let info = omp_tams::mp4::fragment_info(&data).ok_or_else(|| format!("Segment {} ohne lesbare Zeitangaben", s.timerange))?;
            let first_ns = omp_tams::mp4::first_pts_ns(&mp4_init, &data).ok_or("keine Objektzeit")?;
            let off = s.ts_offset.as_deref().map(|t| omp_tams::time::Timestamp::parse(t).map(|x| x.ns())).transpose().map_err(|e| format!("ts_offset: {e}"))?.unwrap_or(0);
            let flow_first = off + first_ns;
            let origin = *mp4_origin.get_or_insert(flow_first);
            let wanted_ticks = (flow_first - origin) * ts / 1_000_000_000 - info.min_cts_offset as i128;
            let delta = i64::try_from(wanted_ticks - info.base_decode_time as i128).map_err(|_| "Zeitverschiebung zu groß")?;
            if !omp_tams::mp4::shift_base_decode_time(&mut data, delta) {
                return Err(format!("Zeit des Segments {} nicht umsetzbar (tfdt)", s.timerange));
            }
            mp4_media.extend_from_slice(&data);
        } else {
            if first_pts(&data).is_none() {
                return Err(format!("Object {} ohne lesbaren PTS (kein MPEG-TS?)", s.timerange));
            }
            let p = dir.join(format!("{i:06}.ts"));
            std::fs::write(&p, &data).map_err(|e| format!("Segment ablegen: {e}"))?;
            list.push_str(&concat_line(&p));
        }
        // Lücke: Anfang liegt mehr als ein halbes Bild (20 ms) hinter dem Ende des vorigen
        if prev_end.is_some_and(|pe| *a - pe > 20_000_000) {
            gaps += 1;
        }
        prev_end = Some(*b);
    }
    let (list_path, stream) = if mp4_init.is_empty() {
        let p = dir.join("list.txt");
        std::fs::write(&p, list).map_err(|e| format!("Liste: {e}"))?;
        (p, false)
    } else {
        let p = dir.join("stream.mp4");
        mp4_init.extend_from_slice(&mp4_media);
        std::fs::write(&p, &mp4_init).map_err(|e| format!("MP4-Strom ablegen: {e}"))?;
        (p, true)
    };
    Ok(Track { stream, list: list_path, first_start: segs[0].0, last_end: segs[segs.len() - 1].1, segments: segs.len(), gaps })
}

/// ffmpeg-Argumente (rein, testbar). `out` ist die Zieldatei (bereits mit Endung).
/// `window` = (Anfang, Dauer) in Sekunden relativ zum ersten Videosegment (alle Spuren werden darauf zugeschnitten); `reencode`
/// kodiert neu (nötig für ein bildgenaues Fenster), sonst Stream-Copy.
pub fn ffmpeg_args(video: Option<(&Path, bool)>, audio: Option<(&Path, bool)>, audio_offset_s: f64, window: Option<(f64, f64)>, reencode: bool, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["-nostdin", "-v", "error", "-y"].map(String::from).to_vec();
    let mut idx = 0;
    let mut maps = Vec::new();
    // je Eingang: (Pfad, `true` = durchgehender MP4-Strom, `false` = Concat-Liste)
    if let Some((v, stream)) = video {
        if !stream {
            a.extend(["-f", "concat", "-safe", "0"].map(String::from));
        }
        a.push("-i".into());
        a.push(v.display().to_string());
        maps.push(format!("{idx}:v:0"));
        idx += 1;
    }
    if let Some((au, stream)) = audio {
        if audio_offset_s.abs() > 0.0005 && video.is_some() {
            a.extend(["-itsoffset".to_string(), format!("{audio_offset_s:.6}")]);
        }
        if !stream {
            a.extend(["-f", "concat", "-safe", "0"].map(String::from));
        }
        a.push("-i".into());
        a.push(au.display().to_string());
        maps.push(format!("{idx}:a:0"));
    }
    for m in maps {
        a.extend(["-map".to_string(), m]);
    }
    if let Some((ss, t)) = window {
        a.extend(["-ss".to_string(), format!("{ss:.6}"), "-t".to_string(), format!("{t:.6}")]);
    }
    if reencode {
        a.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"].map(String::from));
    } else {
        a.extend(["-c", "copy"].map(String::from));
    }
    if out.extension().is_some_and(|e| e == "mp4" || e == "mov") {
        a.extend(["-movflags", "+faststart"].map(String::from));
    }
    a.push(out.display().to_string());
    a
}

/// Führt den Export aus. `dir` ist das Zielverzeichnis, `name` der (bereits geprüfte) Dateiname; Arbeitsdateien liegen in einem
/// eigenen Unterverzeichnis und werden danach entfernt. Die Zieldatei entsteht als `.part` und wird erst am Ende umbenannt.
pub fn export(client: &Client, ffmpeg: &str, req: &Request, dir: &Path, name: &str, stop: &AtomicBool) -> Result<Report, String> {
    let name = safe_name(name)?;
    if req.video.is_none() && req.audio.is_none() {
        return Err("weder Video- noch Ton-Flow angegeben".into());
    }
    if req.end_ns <= req.start_ns {
        return Err("Ende liegt nicht nach dem Anfang".into());
    }
    if req.end_ns - req.start_ns > MAX_CLIP_NS {
        return Err("Bereich länger als 6 Stunden".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Zielverzeichnis: {e}"))?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let work = dir.join(format!(".work-{}-{nonce}", std::process::id()));
    let cleanup = |w: &Path| {
        let _ = std::fs::remove_dir_all(w);
    };
    let run = || -> Result<Report, String> {
        let v = req.video.as_ref().map(|f| fetch_track(client, f, req, work.join("video"), stop)).transpose()?;
        let a = req.audio.as_ref().map(|f| fetch_track(client, f, req, work.join("audio"), stop)).transpose()?;
        let base = v.as_ref().or(a.as_ref()).expect("mindestens ein Flow");
        let audio_off = match (&v, &a) {
            (Some(v), Some(a)) => (a.first_start - v.first_start) as f64 / 1e9,
            _ => 0.0,
        };
        let from = v.as_ref().map(|t| t.first_start).into_iter().chain(a.as_ref().map(|t| t.first_start)).min().expect("Spur");
        let to = v.as_ref().map(|t| t.last_end).into_iter().chain(a.as_ref().map(|t| t.last_end)).max().expect("Spur");
        // Video und Ton werden getrennt segmentiert (andere Grenzen): beide auf das Fenster des ersten Videosegments zuschneiden.
        // Stream-Copy: das Fenster ist der Videobereich (beginnt mit Schlüsselbild); exakt: genau der verlangte Bereich.
        let window = if req.exact {
            Some((((req.start_ns - base.first_start).max(0)) as f64 / 1e9, (req.end_ns - req.start_ns.max(base.first_start)) as f64 / 1e9))
        } else if let Some(v) = &v {
            a.as_ref().map(|_| (0.0, (v.last_end - v.first_start) as f64 / 1e9))
        } else {
            None
        };
        let part = dir.join(format!("{name}.part.{}", name.rsplit('.').next().unwrap_or("mp4")));
        let args = ffmpeg_args(v.as_ref().map(|t| (t.list.as_path(), t.stream)), a.as_ref().map(|t| (t.list.as_path(), t.stream)), audio_off, window, req.exact, &part);
        let out = Command::new(ffmpeg).args(&args).output().map_err(|e| format!("ffmpeg nicht startbar: {e}"))?;
        if !out.status.success() {
            let _ = std::fs::remove_file(&part);
            return Err(format!("ffmpeg fehlgeschlagen: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        let target = dir.join(&name);
        std::fs::rename(&part, &target).map_err(|e| format!("Datei ablegen: {e}"))?;
        let (from, to) = if req.exact {
            (req.start_ns.max(from), req.end_ns.min(to))
        } else if let Some(v) = &v {
            (v.first_start, v.last_end)
        } else {
            (from, to)
        };
        let segments = v.as_ref().map_or(0, |t| t.segments).max(a.as_ref().map_or(0, |t| t.segments));
        let gaps = v.as_ref().map_or(0, |t| t.gaps).max(a.as_ref().map_or(0, |t| t.gaps));
        Ok(Report { path: target, from_ns: from, to_ns: to, segments, gaps })
    };
    let r = run();
    cleanup(&work);
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_plain_files_with_known_extensions() {
        assert_eq!(safe_name("sendung_1.mp4").unwrap(), "sendung_1.mp4");
        assert_eq!(safe_name("clip").unwrap(), "clip.mp4");
        assert_eq!(safe_name("A-b.MKV").unwrap(), "A-b.MKV");
        for bad in ["", ".hidden.mp4", "../x.mp4", "a/b.mp4", "a b.mp4", "x.exe", "a;rm.mp4", &"a".repeat(130)] {
            assert!(safe_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn ffmpeg_arguments_copy_and_exact() {
        let out = Path::new("/o/clip.mp4");
        let a = ffmpeg_args(Some((Path::new("/w/v.txt"), false)), Some((Path::new("/w/a.txt"), false)), 0.034, Some((0.0, 4.0)), false, out);
        let s = a.join(" ");
        assert!(s.contains("-f concat -safe 0 -i /w/v.txt -itsoffset 0.034000 -f concat -safe 0 -i /w/a.txt"), "{s}");
        assert!(s.contains("-map 0:v:0 -map 1:a:0") && s.contains("-c copy") && s.contains("-movflags +faststart"), "{s}");
        assert!(s.contains("-ss 0.000000 -t 4.000000"), "{s}");
        let e = ffmpeg_args(Some((Path::new("/w/v.txt"), false)), None, 0.0, Some((2.0, 4.0)), true, Path::new("/o/clip.mkv")).join(" ");
        assert!(e.contains("-ss 2.000000 -t 4.000000") && e.contains("libx264") && !e.contains("+faststart") && !e.contains("itsoffset"), "{e}");
        // nur Ton: kein Offset
        let t = ffmpeg_args(None, Some((Path::new("/w/a.txt"), false)), 5.0, None, false, out).join(" ");
        // MP4-Strom: direkter Eingang ohne Concat
        let m = ffmpeg_args(Some((Path::new("/w/stream.mp4"), true)), None, 0.0, None, false, out).join(" ");
        assert!(m.contains("-i /w/stream.mp4") && !m.contains("concat"), "{m}");
        assert!(!t.contains("itsoffset") && t.contains("-map 0:a:0"), "{t}");
    }

    #[test]
    fn concat_lines_escape_quotes() {
        assert_eq!(concat_line(Path::new("/a/b.ts")), "file '/a/b.ts'\n");
        assert_eq!(concat_line(Path::new("/a/it's.ts")), "file '/a/it'\\''s.ts'\n");
    }
}
