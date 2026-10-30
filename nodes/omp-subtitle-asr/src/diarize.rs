//! Sprechererkennung (Diarisierung) für Untertitel aus Dateien: Wer spricht wann? Läuft als eigenes Programm
//! (`sherpa-onnx-offline-speaker-diarization`, Apache-2.0, ONNX, CPU) mit einem Segmentierungs- und einem Sprecher-Einbettungsmodell;
//! installiert von `tools/asr-engine/install-diarization.sh` unter `<OMP_ASR_HOME>/diarization`. Der Node enthält weder Programm noch
//! Modelle. Ausgabe des Programms: eine Zeile je Sprechabschnitt, `0.031 -- 2.765 speaker_00` (Sekunden, Sprecher nummeriert in
//! Reihenfolge des ersten Auftretens).

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

/// Ein Sprechabschnitt eines Sprechers (Millisekunden ab Dateibeginn).
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker: usize,
}

/// Liest die Ausgabe des Programms (andere Zeilen — Konfiguration, Fortschritt — werden übersprungen).
pub fn parse_output(text: &str) -> Vec<Turn> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(a), Some(sep), Some(b), Some(spk)) = (it.next(), it.next(), it.next(), it.next()) else { continue };
        if sep != "--" || it.next().is_some() {
            continue;
        }
        let (Ok(a), Ok(b)) = (a.parse::<f64>(), b.parse::<f64>()) else { continue };
        let Some(n) = spk.strip_prefix("speaker_").and_then(|n| n.parse::<usize>().ok()) else { continue };
        if b > a {
            out.push(Turn { start_ms: (a * 1000.0).round() as i64, end_ms: (b * 1000.0).round() as i64, speaker: n });
        }
    }
    out.sort_by_key(|t| (t.start_ms, t.end_ms));
    out
}

/// Fasst unmittelbar aufeinanderfolgende Abschnitte desselben Sprechers (Lücke ≤ `gap_ms`) zusammen und verwirft Abschnitte
/// unter `min_ms`. Überlappende Abschnitte verschiedener Sprecher bleiben erhalten (Gleichzeitigsprechen).
pub fn merge(turns: &[Turn], gap_ms: i64, min_ms: i64) -> Vec<Turn> {
    let mut out: Vec<Turn> = Vec::new();
    for t in turns {
        if let Some(last) = out.iter_mut().rev().find(|l| l.speaker == t.speaker) {
            if t.start_ms - last.end_ms <= gap_ms {
                last.end_ms = last.end_ms.max(t.end_ms);
                continue;
            }
        }
        out.push(t.clone());
    }
    out.retain(|t| t.end_ms - t.start_ms >= min_ms);
    out.sort_by_key(|t| (t.start_ms, t.end_ms));
    out
}

/// Sprecher nach Reihenfolge des ersten Auftretens neu nummerieren (0, 1, 2 …) — die Namen im Untertitel folgen so dem Sprecherwechsel.
pub fn renumber(turns: &[Turn]) -> (Vec<Turn>, usize) {
    let mut order: Vec<usize> = Vec::new();
    let mut by_start: Vec<&Turn> = turns.iter().collect();
    by_start.sort_by_key(|t| t.start_ms);
    for t in &by_start {
        if !order.contains(&t.speaker) {
            order.push(t.speaker);
        }
    }
    let map = |s: usize| order.iter().position(|x| *x == s).unwrap_or(0);
    (turns.iter().map(|t| Turn { speaker: map(t.speaker), ..t.clone() }).collect(), order.len())
}

pub struct Diarizer {
    bin: PathBuf,
    lib: PathBuf,
    segmentation: PathBuf,
    embedding: PathBuf,
}

impl Diarizer {
    /// Sucht Programm und Modelle unter `<home>/diarization`; `None`, wenn nicht eingerichtet.
    pub fn discover(home: &Path) -> Option<Diarizer> {
        let d = home.join("diarization");
        let bin = d.join("bin/sherpa-onnx-offline-speaker-diarization");
        let segmentation = d.join("models/segmentation.onnx");
        let embedding = d.join("models/embedding.onnx");
        (bin.is_file() && segmentation.is_file() && embedding.is_file()).then_some(Diarizer { bin, lib: d.join("lib"), segmentation, embedding })
    }

    /// Standard-Ähnlichkeitsschwelle der Zusammenfassung zu Sprechern (kleiner = mehr Sprecher). Gemessen an einer Zwei-Sprecher-Datei:
    /// 0,5–0,6 spaltet einen dritten Sprecher ab, 0,7–0,8 trifft zwei, 0,9 fasst alle zusammen.
    pub const DEFAULT_THRESHOLD: f64 = 0.7;

    /// Argumente des Programms. `speakers` ≥ 2 = feste Anzahl, sonst Schwelle (`threshold`).
    pub fn args(&self, wav: &Path, speakers: usize, threshold: f64, threads: usize) -> Vec<String> {
        let mut a = vec![
            if speakers >= 2 { format!("--clustering.num-clusters={speakers}") } else { format!("--clustering.cluster-threshold={threshold}") },
            format!("--segmentation.pyannote-model={}", self.segmentation.display()),
            format!("--embedding.model={}", self.embedding.display()),
            format!("--segmentation.num-threads={threads}"),
            format!("--embedding.num-threads={threads}"),
        ];
        a.push(wav.display().to_string());
        a
    }

    /// Startet die Erkennung; `progress` = 0–100 aus der Fortschrittsausgabe; `cancel` bricht ab (Programm wird beendet).
    pub fn run(&self, wav: &Path, speakers: usize, threshold: f64, threads: usize, progress: &AtomicU32, cancel: &AtomicBool) -> Result<Vec<Turn>, String> {
        let mut child = Command::new(&self.bin)
            .args(self.args(wav, speakers, threshold, threads))
            .env("LD_LIBRARY_PATH", &self.lib)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Sprechererkennung startet nicht: {e}"))?;
        let stderr = child.stderr.take().expect("stderr piped");
        let prog = Arc::new(AtomicU32::new(0));
        let reader = {
            let prog = prog.clone();
            std::thread::spawn(move || {
                // Das Programm trennt Fortschrittszeilen mit \r
                let mut tail = String::new();
                for chunk in BufReader::new(stderr).split(b'\r') {
                    let Ok(chunk) = chunk else { break };
                    for line in String::from_utf8_lossy(&chunk).lines() {
                        if let Some(p) = line.trim().strip_prefix("progress ").and_then(|s| s.trim_end_matches('%').parse::<f64>().ok()) {
                            prog.store(p.clamp(0.0, 100.0) as u32, Ordering::Relaxed);
                        } else if !line.trim().is_empty() {
                            tail = line.trim().to_string();
                        }
                    }
                }
                tail
            })
        };
        let mut stdout = child.stdout.take().expect("stdout piped");
        let collector = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
            s
        });
        loop {
            progress.store(prog.load(Ordering::Relaxed), Ordering::Relaxed);
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("abgebrochen".to_string());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let out = collector.join().unwrap_or_default();
                    let tail = reader.join().unwrap_or_default();
                    if !status.success() {
                        return Err(format!("Sprechererkennung beendet mit {status}: {tail}"));
                    }
                    let turns = parse_output(&out);
                    return if turns.is_empty() { Err("Sprechererkennung fand keine Sprache".to_string()) } else { Ok(turns) };
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(200)),
                Err(e) => return Err(e.to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "Started\n0.031 -- 2.765 speaker_00\n2.765 -- 7.810 speaker_01\n7.844 -- 11.118 speaker_00\nprogress 100.00%\nDuration : 34.000 s\n11.287 -- 13.902 speaker_01\n";

    #[test]
    fn parses_turns_and_ignores_noise() {
        let t = parse_output(SAMPLE);
        assert_eq!(t.len(), 4);
        assert_eq!(t[0], Turn { start_ms: 31, end_ms: 2765, speaker: 0 });
        assert_eq!(t[3].speaker, 1);
        assert!(parse_output("12 -- 3 speaker_00\nabc -- 4 speaker_01\n1.0 -- 2.0 jemand\n").is_empty(), "rückwärts, keine Zahl, kein Sprecher");
    }

    #[test]
    fn merges_neighbours_of_one_speaker_but_keeps_overlap_between_speakers() {
        let t = vec![
            Turn { start_ms: 0, end_ms: 2000, speaker: 0 },
            Turn { start_ms: 2300, end_ms: 4000, speaker: 0 }, // Lücke 300 ms → zusammen
            Turn { start_ms: 3500, end_ms: 6000, speaker: 1 }, // überlappt Sprecher 0 → bleibt
            Turn { start_ms: 9000, end_ms: 9100, speaker: 1 }, // 100 ms → verworfen
        ];
        let m = merge(&t, 500, 300);
        assert_eq!(m, vec![Turn { start_ms: 0, end_ms: 4000, speaker: 0 }, Turn { start_ms: 3500, end_ms: 6000, speaker: 1 }]);
    }

    #[test]
    fn renumbers_by_first_appearance() {
        let t = vec![Turn { start_ms: 5000, end_ms: 6000, speaker: 2 }, Turn { start_ms: 0, end_ms: 1000, speaker: 7 }, Turn { start_ms: 2000, end_ms: 3000, speaker: 2 }];
        let (r, n) = renumber(&t);
        assert_eq!(n, 2);
        assert_eq!(r.iter().map(|t| t.speaker).collect::<Vec<_>>(), vec![1, 0, 1]);
    }

    #[test]
    fn argument_list_uses_count_or_threshold() {
        let d = Diarizer { bin: "b".into(), lib: "l".into(), segmentation: "seg.onnx".into(), embedding: "emb.onnx".into() };
        let auto = d.args(Path::new("a.wav"), 0, 0.7, 2);
        assert!(auto[0].starts_with("--clustering.cluster-threshold=0.7"));
        let fixed = d.args(Path::new("a.wav"), 3, 0.7, 2);
        assert_eq!(fixed[0], "--clustering.num-clusters=3");
        assert_eq!(d.args(Path::new("a.wav"), 1, 0.7, 2)[0].starts_with("--clustering.cluster-threshold"), true, "1 Sprecher ist keine Clusterzahl");
        assert_eq!(fixed.last().unwrap(), "a.wav");
    }

    #[test]
    fn discover_needs_program_and_both_models() {
        let dir = std::env::temp_dir().join(format!("omp-dia-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(Diarizer::discover(&dir).is_none());
        std::fs::create_dir_all(dir.join("diarization/bin")).unwrap();
        std::fs::create_dir_all(dir.join("diarization/models")).unwrap();
        std::fs::write(dir.join("diarization/bin/sherpa-onnx-offline-speaker-diarization"), b"x").unwrap();
        std::fs::write(dir.join("diarization/models/segmentation.onnx"), b"x").unwrap();
        assert!(Diarizer::discover(&dir).is_none(), "Einbettungsmodell fehlt");
        std::fs::write(dir.join("diarization/models/embedding.onnx"), b"x").unwrap();
        assert!(Diarizer::discover(&dir).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
