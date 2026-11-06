//! Segue-Editor, Knotenseite (RB7.2): `POST /segue/plan` rechnet einen Ausschnitt des Logs mit derselben `segue::plan()` wie die
//! Sendung (der Editor zeigt und hört nie etwas anderes als gesendet wird); `GET /segue/peaks` liefert Spitzenwerte einer Datei
//! für die Wellenform. Nichts davon verändert Dateien oder den laufenden Ablauf.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use omp_playout_core::segue::{self, Config, Curve, Placed};
use serde_json::{Value, json};

use crate::runner::{self, Log};

const SAMPLE_RATE: u64 = 48_000;
const MAX_BINS: usize = 8192;

/// Spitzenwert auf 0…255 (0 = ≤ −60 dBFS, 255 = 0 dBFS), dieselbe Skala wie die Wellenform im Review-Player.
pub fn peak_to_u8(peak: f32) -> u8 {
    if peak <= 0.0 {
        return 0;
    }
    let db = 20.0 * peak.min(1.0).log10();
    (((db + 60.0) / 60.0).clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Streaming-Reduktion: `total` Samples auf `bins` Spalten, je Spalte das Maximum des Betrags.
pub struct PeakBins {
    bins: usize,
    total: u64,
    seen: u64,
    cur: f32,
    pub out: Vec<u8>,
}

impl PeakBins {
    pub fn new(bins: usize, total: u64) -> Self {
        PeakBins { bins, total: total.max(1), seen: 0, cur: 0.0, out: Vec::with_capacity(bins) }
    }
    pub fn push(&mut self, s: f32) {
        // Spalte, zu der dieses Sample gehört (ganzzahlig, ohne Rundungsdrift)
        let col = ((self.seen as u128 * self.bins as u128) / self.total as u128) as usize;
        while self.out.len() < col.min(self.bins) {
            self.out.push(peak_to_u8(self.cur));
            self.cur = 0.0;
        }
        self.cur = self.cur.max(s.abs());
        self.seen += 1;
    }
    pub fn finish(mut self) -> Vec<u8> {
        if self.seen > 0 {
            self.out.push(peak_to_u8(self.cur));
        }
        self.out.resize(self.bins, 0);
        self.out
    }
}

fn media_roots() -> Vec<PathBuf> {
    let raw = std::env::var("OMP_MEDIA_MOUNTS").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "data/media".to_string());
    raw.split(':').filter(|p| !p.is_empty()).filter_map(|p| Path::new(p).canonicalize().ok()).collect()
}

/// Nur Dateien unterhalb der Medienverzeichnisse (kein `..`, keine Verweise hinaus).
pub fn allowed_file(file: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let p = Path::new(file).canonicalize().ok()?;
    roots.iter().any(|r| p.starts_with(r)).then_some(p)
}

fn curve_name(c: Curve) -> &'static str {
    c.as_str()
}

pub fn placed_json(p: &Placed) -> Value {
    json!({
        "id": p.id, "startMs": p.start_ms, "offsetMs": p.offset_ms, "gainDb": p.gain_db,
        "fadeInMs": p.fade_in_ms, "fadeInCurve": curve_name(p.fade_in_curve),
        "stopAtMs": p.stop_at_ms, "fadeOutMs": p.fade_out_ms, "fadeOutCurve": curve_name(p.fade_out_curve),
        "endMs": p.end_ms, "nextStartMs": p.next_start_ms,
    })
}

/// `{"items":[LogItem…], "startMs":0, "config":{"crossfadeMs":…}}` → `{"placed":[…]}`.
pub fn plan_response(body: &[u8]) -> (u16, Value) {
    let v: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return (400, json!({"error": "invalid JSON body"})),
    };
    let items = v.get("items").cloned().unwrap_or(Value::Null);
    let log: Log = match serde_json::from_value(json!({"logId": "editor", "items": items})) {
        Ok(l) => l,
        Err(e) => return (400, json!({"error": format!("items: {e}")})),
    };
    if log.items.len() > 64 {
        return (400, json!({"error": "höchstens 64 Elemente"}));
    }
    let mut cfg = Config::default();
    if let Some(c) = v.get("config") {
        let ms = |k: &str| c.get(k).and_then(Value::as_i64).filter(|n| (0..=600_000).contains(n));
        cfg.crossfade_ms = ms("crossfadeMs").unwrap_or(cfg.crossfade_ms);
        cfg.under_jingle_fade_ms = ms("underJingleFadeMs").unwrap_or(cfg.under_jingle_fade_ms);
        cfg.after_jingle_fade_ms = ms("afterJingleFadeMs").unwrap_or(cfg.after_jingle_fade_ms);
        cfg.default_outro_ms = ms("defaultOutroMs").unwrap_or(cfg.default_outro_ms);
        if let Some(cv) = c.get("curve").and_then(|x| serde_json::from_value::<Curve>(x.clone()).ok()) {
            cfg.curve = cv;
        }
    }
    let start = v.get("startMs").and_then(Value::as_i64).unwrap_or(0);
    let items: Vec<segue::Item> = log.items.iter().map(runner::to_item).collect();
    match segue::plan(&items, start, &cfg) {
        Ok(p) => (200, json!({"placed": p.iter().map(placed_json).collect::<Vec<_>>()})),
        Err(e) => (400, json!({"error": e})),
    }
}

fn query_param<'a>(query: &'a str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                if let Ok(h) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(h);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `GET /segue/peaks?file=…&bins=N[&fromMs=…&toMs=…]` → `{"fromMs","toMs","bins","peaks":[0…255]}`.
/// `toMs` fehlt = bis zum Dateiende; ohne `toMs` muss die Dauer vorab bekannt sein (`durationMs`), weil die Spalten feste Breite haben.
pub fn peaks_response(query: &str) -> (u16, Value) {
    let Some(file) = query_param(query, "file") else { return (400, json!({"error": "file fehlt"})) };
    let Some(path) = allowed_file(&file, &media_roots()) else { return (403, json!({"error": "Datei liegt nicht im Medienverzeichnis"})) };
    let num = |k: &str| query_param(query, k).and_then(|v| v.parse::<i64>().ok());
    let bins = num("bins").unwrap_or(1024).clamp(16, MAX_BINS as i64) as usize;
    let from = num("fromMs").unwrap_or(0).max(0);
    let Some(dur) = num("durationMs").filter(|d| *d > 0) else { return (400, json!({"error": "durationMs fehlt"})) };
    let to = num("toMs").unwrap_or(dur).clamp(from + 1, dur.max(from + 1));
    let total = ((to - from) as u64 * SAMPLE_RATE / 1000).max(1);
    let child = Command::new("ffmpeg")
        .args(["-v", "error", "-nostdin", "-ss", &format!("{:.3}", from as f64 / 1000.0), "-t", &format!("{:.3}", (to - from) as f64 / 1000.0)])
        .arg("-i")
        .arg(&path)
        .args(["-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return (500, json!({"error": format!("ffmpeg nicht startbar: {e}")})),
    };
    let mut acc = PeakBins::new(bins, total);
    let mut out = child.stdout.take().expect("stdout piped");
    let mut buf = vec![0u8; 64 * 1024];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        let n = match out.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        carry.extend_from_slice(&buf[..n]);
        let whole = carry.len() / 4 * 4;
        for c in carry[..whole].chunks_exact(4) {
            acc.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
        }
        carry.drain(..whole);
    }
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    if !ok && acc.seen == 0 {
        return (422, json!({"error": "Datei nicht lesbar"}));
    }
    (200, json!({"fromMs": from, "toMs": to, "bins": bins, "peaks": acc.finish()}))
}

/// Längster Vorhörausschnitt einer Datei (Schutz gegen riesige Antworten): 2 Minuten Stereo 48 kHz s16 ≈ 23 MB.
const MAX_AUDIO_MS: i64 = 120_000;

/// `GET /segue/audio?file=…&fromMs=…&toMs=…` → rohe PCM-Daten: 48 kHz, 2 Kanäle, s16le, verschränkt. Das Vorhören im Browser baut
/// daraus einen `AudioBuffer` (kein Dekodieren von Formaten im Browser, gleiche Dekodierung wie die Wellenform).
pub fn audio_response(query: &str) -> (u16, Vec<u8>, &'static str) {
    let err = |status: u16, msg: &str| (status, serde_json::to_vec(&json!({"error": msg})).unwrap_or_default(), "application/json");
    let Some(file) = query_param(query, "file") else { return err(400, "file fehlt") };
    let Some(path) = allowed_file(&file, &media_roots()) else { return err(403, "Datei liegt nicht im Medienverzeichnis") };
    let num = |k: &str| query_param(query, k).and_then(|v| v.parse::<i64>().ok());
    let from = num("fromMs").unwrap_or(0).max(0);
    let Some(to) = num("toMs").filter(|t| *t > from) else { return err(400, "toMs fehlt oder ≤ fromMs") };
    if to - from > MAX_AUDIO_MS {
        return err(400, "Ausschnitt zu lang (höchstens 120 s)");
    }
    let out = Command::new("ffmpeg")
        .args(["-v", "error", "-nostdin", "-ss", &format!("{:.3}", from as f64 / 1000.0), "-t", &format!("{:.3}", (to - from) as f64 / 1000.0)])
        .arg("-i")
        .arg(&path)
        .args(["-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "-"])
        .stderr(Stdio::null())
        .output();
    match out {
        Ok(o) if !o.stdout.is_empty() => (200, o.stdout, "application/octet-stream"),
        Ok(_) => err(422, "Datei nicht lesbar"),
        Err(e) => err(500, &format!("ffmpeg nicht startbar: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peak_scale_matches_review_player() {
        assert_eq!(peak_to_u8(0.0), 0);
        assert_eq!(peak_to_u8(1.0), 255);
        assert_eq!(peak_to_u8(0.001), 0, "−60 dBFS ist die Untergrenze");
        let half = peak_to_u8(0.5);
        assert!((228..=231).contains(&half), "−6 dBFS = 0,9 der Skala, war {half}");
    }

    #[test]
    fn bins_take_the_maximum_per_column() {
        let mut b = PeakBins::new(4, 8);
        for s in [0.0, 0.5, 0.0, 0.0, 1.0, 0.0, 0.0, 0.25] {
            b.push(s);
        }
        let out = b.finish();
        assert_eq!(out.len(), 4);
        assert_eq!((out[0], out[1], out[2]), (peak_to_u8(0.5), 0, 255));
        assert_eq!(out[3], peak_to_u8(0.25));
    }

    #[test]
    fn short_input_is_padded_with_silence() {
        let mut b = PeakBins::new(8, 100);
        b.push(1.0);
        let out = b.finish();
        assert_eq!(out.len(), 8);
        assert_eq!(out[0], 255);
        assert!(out[1..].iter().all(|v| *v == 0));
    }

    #[test]
    fn only_files_inside_media_roots_are_allowed() {
        let dir = std::env::temp_dir().join("segue_api_test_roots");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.wav");
        std::fs::write(&f, b"x").unwrap();
        let roots = vec![dir.canonicalize().unwrap()];
        assert!(allowed_file(f.to_str().unwrap(), &roots).is_some());
        assert!(allowed_file("/etc/passwd", &roots).is_none());
        assert!(allowed_file(&format!("{}/../../../etc/passwd", dir.display()), &roots).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn plan_route_uses_the_shared_planner_with_transition() {
        let body = br#"{"items":[
          {"id":"a","kind":"song","file":"/m/a.wav","durationMs":60000,"outroMs":50000},
          {"id":"b","kind":"song","file":"/m/b.wav","durationMs":60000,"transition":{"startShiftMs":-500,"fadeOutMs":2000}}],
          "config":{"crossfadeMs":4000}}"#;
        let (st, v) = plan_response(body);
        assert_eq!(st, 200);
        assert_eq!(v["placed"][1]["startMs"], 49_500);
        assert_eq!(v["placed"][0]["fadeOutMs"], 2000);
        assert_eq!(v["placed"][1]["fadeInCurve"], "cosine");
        let (st, v) = plan_response(br#"{"items":[{"id":"a","kind":"song","file":"x","durationMs":0}]}"#);
        assert_eq!(st, 400, "{v}");
        assert_eq!(plan_response(b"nope").0, 400);
    }

    #[test]
    fn audio_route_refuses_foreign_files_and_bad_ranges() {
        assert_eq!(audio_response("fromMs=0&toMs=1000").0, 400, "file fehlt");
        assert_eq!(audio_response("file=/etc/passwd&fromMs=0&toMs=1000").0, 403);
        let dir = std::env::temp_dir().join("segue_api_audio_test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.wav");
        std::fs::write(&f, b"x").unwrap();
        // Medienverzeichnis ist hier nicht gesetzt → Datei außerhalb von data/media
        assert_eq!(audio_response(&format!("file={}&fromMs=0&toMs=1000", f.display())).0, 403);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn query_decoding() {
        assert_eq!(query_param("file=%2Fm%2Fa%20b.wav&bins=9", "file").as_deref(), Some("/m/a b.wav"));
        assert_eq!(query_param("file=x&bins=9", "bins").as_deref(), Some("9"));
        assert!(query_param("file=x", "bins").is_none());
    }
}
