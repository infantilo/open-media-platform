//! Untertitel-Engine des Grafik-Nodes (Kapitel 27 / P9.4, Spec §52): lädt SRT/WebVTT-Spuren aus einem
//! Verzeichnis (`OMP_SUBTITLE_DIR`, Standard `data/subtitles`), spielt sie nach `subtitle.start` gegen
//! eine Uhr ab und setzt je Cue-Wechsel den Text der OGraf-Ebene `subtitle` (Template `subtitle`) — das
//! Bild entsteht also im vorhandenen Fill+Key-Pfad des Grafik-Nodes. Der Playout-Automator steuert nur
//! `subtitle.load/select/start/stop` (Child Event `SUBTITLE`); Cues, Zeitlogik und Darstellung bleiben hier.

use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Track {
    pub id: String,
    pub cues: Vec<Cue>,
}

/// `00:01:02,500` bzw. `00:01:02.500` bzw. `01:02.500` → Millisekunden.
fn parse_time(s: &str) -> Option<u64> {
    let s = s.trim().replace(',', ".");
    let (hms, ms) = match s.split_once('.') {
        Some((a, b)) => (a, b),
        None => (s.as_str(), "0"),
    };
    let ms: u64 = format!("{:0<3}", ms.chars().take(3).collect::<String>()).parse().ok()?;
    let parts: Vec<u64> = hms.split(':').map(|p| p.trim().parse().ok()).collect::<Option<_>>()?;
    let secs = match parts.as_slice() {
        [h, m, s] => h * 3600 + m * 60 + s,
        [m, s] => m * 60 + s,
        _ => return None,
    };
    Some(secs * 1000 + ms)
}

/// Entfernt einfache Auszeichnungen (`<i>`, `<b>`, `{\an8}` …), lässt Text und Zeilenumbrüche stehen.
fn clean(text: &str) -> String {
    let mut out = String::new();
    let (mut in_tag, mut in_brace) = (false, false);
    for c in text.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            '{' => in_brace = true,
            '}' if in_brace => in_brace = false,
            _ if in_tag || in_brace => {}
            _ => out.push(c),
        }
    }
    out.trim().to_string()
}

/// SRT oder WebVTT (Kopf `WEBVTT`, Notizen/Stil-Blöcke werden übersprungen). Fehlerhafte Blöcke
/// werden mit Nummer gemeldet statt still verworfen.
pub fn parse(id: &str, src: &str) -> Result<Track, String> {
    let src = src.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut cues = Vec::new();
    for (n, block) in src.split("\n\n").enumerate() {
        let lines: Vec<&str> = block.lines().filter(|l| !l.trim().is_empty()).collect();
        let Some(ti) = lines.iter().position(|l| l.contains("-->")) else {
            continue; // Kopf, Nummer allein, Notiz, Stil
        };
        if lines[0].trim_start().starts_with("NOTE") || lines[0].trim_start().starts_with("STYLE") {
            continue;
        }
        let (a, b) = lines[ti].split_once("-->").ok_or_else(|| format!("Block {}: Zeitzeile ungültig", n + 1))?;
        let start = parse_time(a).ok_or_else(|| format!("Block {}: Startzeit „{}\u{201c} ungültig", n + 1, a.trim()))?;
        // Hinter der Endzeit können VTT-Einstellungen stehen (`align:start …`).
        let end = parse_time(b.split_whitespace().next().unwrap_or("")).ok_or_else(|| format!("Block {}: Endzeit „{}\u{201c} ungültig", n + 1, b.trim()))?;
        if end <= start {
            return Err(format!("Block {}: Ende ({end} ms) liegt nicht nach dem Anfang ({start} ms)", n + 1));
        }
        let text = clean(&lines[ti + 1..].join("\n"));
        if !text.is_empty() {
            cues.push(Cue { start_ms: start, end_ms: end, text });
        }
    }
    if cues.is_empty() {
        return Err("keine Untertitel-Cues gefunden".to_string());
    }
    cues.sort_by_key(|c| c.start_ms);
    Ok(Track { id: id.to_string(), cues })
}

impl Track {
    /// Text zum Zeitpunkt `pos_ms` (leer = kein Cue). Bei Überlappung gewinnt der zuletzt begonnene.
    pub fn text_at(&self, pos_ms: u64) -> &str {
        self.cues.iter().rev().find(|c| c.start_ms <= pos_ms && pos_ms < c.end_ms).map_or("", |c| c.text.as_str())
    }

    pub fn end_ms(&self) -> u64 {
        self.cues.iter().map(|c| c.end_ms).max().unwrap_or(0)
    }
}

/// Mitgelieferte Untertitel-Vorlage: wird beim Start in das Vorlagenverzeichnis geschrieben, falls dort
/// noch keine `subtitle`-Vorlage liegt (das Datenverzeichnis ist nicht Teil des Repositories).
pub fn ensure_builtin_template(templates_root: &Path) {
    let dir = templates_root.join("subtitle");
    if dir.join("subtitle.ograf.json").exists() {
        return;
    }
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(dir.join("subtitle.ograf.json"), include_str!("../builtin/subtitle/subtitle.ograf.json"));
        let _ = std::fs::write(dir.join("subtitle.js"), include_str!("../builtin/subtitle/subtitle.js"));
    }
}

/// Spur-IDs im Verzeichnis (Dateiname ohne Endung, `.srt`/`.vtt`).
pub fn list_tracks(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let ext = p.extension()?.to_str()?.to_ascii_lowercase();
            (ext == "srt" || ext == "vtt").then(|| p.file_stem()?.to_str().map(str::to_string))?
        })
        .collect();
    v.sort();
    v.dedup();
    v
}

pub fn load_track(dir: &Path, id: &str) -> Result<Track, String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("ungültige Spur „{id}\u{201c}"));
    }
    for ext in ["srt", "vtt"] {
        let p: PathBuf = dir.join(format!("{id}.{ext}"));
        if p.is_file() {
            let src = std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            return parse(id, &src).map_err(|e| format!("{}: {e}", p.display()));
        }
    }
    Err(format!("Spur „{id}\u{201c} nicht gefunden in {}", dir.display()))
}

/// Laufender Abspielzustand (Uhr = `Instant` minus Versatz).
pub struct Playback {
    pub track: Track,
    started: Instant,
    offset_ms: u64,
    pub last_text: String,
}

impl Playback {
    pub fn new(track: Track, offset_ms: u64) -> Playback {
        Playback { track, started: Instant::now(), offset_ms, last_text: String::new() }
    }

    pub fn position_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64 + self.offset_ms
    }

    /// `Some(neuer Text)`, wenn sich der anzuzeigende Text seit dem letzten Aufruf geändert hat.
    pub fn changed_text(&mut self) -> Option<String> {
        let t = self.track.text_at(self.position_ms()).to_string();
        if t != self.last_text {
            self.last_text = t.clone();
            Some(t)
        } else {
            None
        }
    }

    pub fn finished(&self) -> bool {
        self.position_ms() > self.track.end_ms() + 500
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRT: &str = "1\n00:00:01,000 --> 00:00:03,000\nErste <i>Zeile</i>\n\n2\n00:00:03,500 --> 00:00:06,250\nZwei\nZeilen\n";

    #[test]
    fn srt_is_parsed_with_markup_removed_and_multiline_kept() {
        let t = parse("de", SRT).unwrap();
        assert_eq!(t.cues.len(), 2);
        assert_eq!((t.cues[0].start_ms, t.cues[0].end_ms, t.cues[0].text.as_str()), (1000, 3000, "Erste Zeile"));
        assert_eq!((t.cues[1].end_ms, t.cues[1].text.as_str()), (6250, "Zwei\nZeilen"));
        assert_eq!(t.end_ms(), 6250);
    }

    #[test]
    fn webvtt_with_header_notes_settings_and_short_times() {
        let vtt = "WEBVTT\n\nNOTE ein Kommentar\n\ncue1\n00:01.500 --> 00:03.000 align:start position:10%\n{\\an8}Oben\n\n01:00:00.000 --> 01:00:01.000\nSpät\n";
        let t = parse("x", vtt).unwrap();
        assert_eq!(t.cues[0].start_ms, 1500);
        assert_eq!(t.cues[0].text, "Oben");
        assert_eq!(t.cues[1].start_ms, 3_600_000);
    }

    #[test]
    fn text_at_follows_the_clock_and_gaps_are_empty() {
        let t = parse("de", SRT).unwrap();
        assert_eq!(t.text_at(500), "");
        assert_eq!(t.text_at(1000), "Erste Zeile");
        assert_eq!(t.text_at(2999), "Erste Zeile");
        assert_eq!(t.text_at(3000), "");
        assert_eq!(t.text_at(4000), "Zwei\nZeilen");
        assert_eq!(t.text_at(6250), "");
    }

    #[test]
    fn broken_input_is_reported_with_the_block_number() {
        assert!(parse("x", "").unwrap_err().contains("keine"));
        assert!(parse("x", "1\n00:00:05,000 --> 00:00:04,000\nA\n").unwrap_err().contains("Block 1"));
        assert!(parse("x", "1\nabc --> 00:00:04,000\nA\n").unwrap_err().contains("Startzeit"));
    }

    #[test]
    fn playback_reports_changes_once_and_honours_the_offset() {
        let t = parse("de", SRT).unwrap();
        let mut p = Playback::new(t, 1200);
        assert_eq!(p.changed_text().as_deref(), Some("Erste Zeile"));
        assert_eq!(p.changed_text(), None, "unverändert");
        assert!(!p.finished());
        let late = Playback::new(parse("de", SRT).unwrap(), 10_000);
        assert!(late.finished());
    }

    #[test]
    fn builtin_template_is_installed_once_and_valid_json() {
        let dir = std::env::temp_dir().join(format!("omp-tpl-{}", std::process::id()));
        ensure_builtin_template(&dir);
        let manifest = std::fs::read_to_string(dir.join("subtitle/subtitle.ograf.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(v["id"], "subtitle");
        assert!(dir.join("subtitle/subtitle.js").exists());
        // Vorhandene (angepasste) Vorlage wird nicht überschrieben.
        std::fs::write(dir.join("subtitle/subtitle.ograf.json"), "{\"id\":\"subtitle\",\"custom\":true}").unwrap();
        ensure_builtin_template(&dir);
        assert!(std::fs::read_to_string(dir.join("subtitle/subtitle.ograf.json")).unwrap().contains("custom"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tracks_are_listed_and_path_traversal_is_refused() {
        let dir = std::env::temp_dir().join(format!("omp-subs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("de.srt"), SRT).unwrap();
        std::fs::write(dir.join("en.vtt"), "WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        assert_eq!(list_tracks(&dir), vec!["de", "en"]);
        assert_eq!(load_track(&dir, "en").unwrap().cues[0].text, "Hi");
        assert!(load_track(&dir, "../etc/passwd").is_err());
        assert!(load_track(&dir, "fehlt").unwrap_err().contains("nicht gefunden"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
