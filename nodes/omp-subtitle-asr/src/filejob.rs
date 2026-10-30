//! Untertitel (SRT) aus einer Datei erzeugen — mit Sprechererkennung. Ablauf eines Auftrags:
//!
//! 1. **Ton holen**: `ffmpeg` liest die gewählte Tonspur der Datei als 16-kHz-Mono-PCM.
//! 2. **Sprecher** (bei `speakers` ≠ 1): `diarize` bestimmt, wer wann spricht (Sprechabschnitte je Sprecher).
//! 3. **Text**: jeder Sprechabschnitt wird für sich (mit dem Pausen-Segmentierer in ≤ 8-s-Stücke geteilt) von der Engine erkannt — so
//!    gehört jeder Text sicher zu einem Sprecher, auch wenn zwei ohne Pause aufeinander folgen.
//! 4. **Aufbereiten**: Einheiten ≤ 2 Zeilen à 42 Zeichen im Zeitfenster der Sprache, Sprechername am Anfang eines Sprecherwechsels,
//!    Überlappungen beseitigt, SRT-Text.
//!
//! Aufträge laufen nacheinander (die Engine ist ein einzelner Rechenprozess). Das Ergebnis bleibt im Node abrufbar
//! (`fileJobs`-Parameter, SRT über `fileJobSrt.<id>`); abspeichern und weiterverwenden tut der Aufrufer (Orchestrator).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::diarize::{self, Diarizer, Turn};
use crate::engine::{self, Engine};
use crate::output::{self, Cue};
use crate::segment::{self, SAMPLE_RATE, Segmenter};

const MAX_JOBS_KEPT: usize = 12;
/// Längste verarbeitete Datei in Minuten (der Ton liegt als 16-Bit-PCM im Speicher: 180 min ≈ 345 MB).
pub const DEFAULT_MAX_MINUTES: u64 = 180;
const PAD_MS: i64 = 150;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LabelStyle {
    /// `Sprecher 1: Text`
    Colon,
    /// `[Sprecher 1] Text`
    Bracket,
    /// `- Text` (nur der Wechsel wird markiert, keine Namen)
    Dash,
}

impl LabelStyle {
    pub fn parse(s: &str) -> Option<LabelStyle> {
        match s.trim() {
            "" | "colon" => Some(LabelStyle::Colon),
            "bracket" => Some(LabelStyle::Bracket),
            "dash" => Some(LabelStyle::Dash),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct FileSpec {
    pub file: PathBuf,
    /// Index der Tonspur (0 = erste).
    pub track: usize,
    pub language: String,
    /// 1 = keine Sprecherkennung (kein Name im Text), 0 = Anzahl automatisch, ≥ 2 = feste Anzahl.
    pub speakers: usize,
    /// Namen in Reihenfolge des ersten Auftretens; fehlende heißen „<Wort> n“.
    pub names: Vec<String>,
    pub label_word: String,
    pub style: LabelStyle,
    pub name: String,
    /// Vom Aufrufer vergebene Auftrags-ID (leer = der Node vergibt eine); nur Buchstaben, Ziffern, `-`, `_`, höchstens 64 Zeichen.
    pub id: String,
}

/// Eine erkannte Äußerung eines Sprechers (Millisekunden ab Dateibeginn).
#[derive(Debug, Clone, PartialEq)]
pub struct Utterance {
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker: Option<usize>,
    pub text: String,
}

pub fn label_for(speaker: usize, names: &[String], word: &str) -> String {
    match names.get(speaker).map(|n| n.trim()).filter(|n| !n.is_empty()) {
        Some(n) => n.to_string(),
        None => format!("{word} {}", speaker + 1),
    }
}

/// Einheiten für die SRT-Datei. Beim Sprecherwechsel (und am Anfang) trägt die erste Einheit der Äußerung den Namen bzw. den Strich.
pub fn build_cues(utts: &[Utterance], names: &[String], word: &str, style: LabelStyle) -> Vec<Cue> {
    let mut sorted: Vec<&Utterance> = utts.iter().filter(|u| !u.text.trim().is_empty()).collect();
    sorted.sort_by_key(|u| (u.start_ms, u.end_ms));
    let mut out: Vec<Cue> = Vec::new();
    let mut last: Option<usize> = None;
    for u in sorted {
        let mut text = u.text.trim().to_string();
        if let Some(spk) = u.speaker {
            if last != Some(spk) {
                text = match style {
                    LabelStyle::Colon => format!("{}: {text}", label_for(spk, names, word)),
                    LabelStyle::Bracket => format!("[{}] {text}", label_for(spk, names, word)),
                    LabelStyle::Dash => format!("- {text}"),
                };
            }
            last = Some(spk);
        }
        out.extend(output::cues_between(&text, u.start_ms, u.end_ms));
    }
    output::tidy(&mut out);
    out
}

fn sanitize_name(name: &str) -> String {
    let n: String = name.trim().chars().map(|c| if c.is_alphanumeric() || "-_.".contains(c) { c } else { '-' }).collect();
    let n = n.trim_matches(|c| c == '-' || c == '.').to_string();
    if n.is_empty() { "untertitel".to_string() } else { n.chars().take(80).collect() }
}

pub fn validate(spec: &FileSpec) -> Result<(), String> {
    if !spec.file.is_absolute() {
        return Err("file: absoluter Pfad erwartet".into());
    }
    if !spec.file.is_file() {
        return Err(format!("file: {} nicht gefunden (muss auf dem Host des Untertitel-Nodes lesbar sein)", spec.file.display()));
    }
    if spec.track > 63 {
        return Err("track: 0 bis 63".into());
    }
    if spec.speakers > 12 {
        return Err("speakers: 0 (automatisch) bis 12".into());
    }
    if spec.language.trim().is_empty() {
        return Err("language: Sprache oder „auto“ angeben".into());
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct JobInfo {
    pub id: String,
    pub name: String,
    pub file: String,
    pub track: usize,
    pub language: String,
    pub speakers_requested: usize,
    /// queued | extracting | diarizing | transcribing | done | failed | canceled
    pub state: String,
    pub progress: u32,
    pub message: String,
    pub speakers_found: usize,
    pub cues: usize,
    pub duration_s: f64,
    pub created_ms: i64,
    pub finished_ms: Option<i64>,
    pub engine: String,
}

impl JobInfo {
    fn json(&self) -> Value {
        json!({
            "id": self.id, "name": self.name, "file": self.file, "track": self.track, "language": self.language,
            "speakersRequested": self.speakers_requested, "state": self.state, "progress": self.progress, "message": self.message,
            "speakersFound": self.speakers_found, "cues": self.cues, "durationS": self.duration_s,
            "createdMs": self.created_ms, "finishedMs": self.finished_ms, "engine": self.engine,
        })
    }
}

struct Job {
    info: Mutex<JobInfo>,
    srt: Mutex<Option<String>>,
    cancel: AtomicBool,
}

/// Austausch für Tests: wie der Ton aus einer Datei kommt.
pub type Extractor = dyn Fn(&Path, usize) -> Result<Vec<i16>, String> + Send + Sync;

pub struct FileJobs {
    jobs: Mutex<Vec<Arc<Job>>>,
    tx: Mutex<Sender<(Arc<Job>, FileSpec)>>,
    next: Mutex<u64>,
    has_diarizer: bool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Tonspur als 16-kHz-Mono-PCM über ffmpeg.
pub fn extract_with_ffmpeg(ffmpeg: &str, file: &Path, track: usize, max_minutes: u64) -> Result<Vec<i16>, String> {
    let out = Command::new(ffmpeg)
        .args(["-nostdin", "-v", "error", "-i"])
        .arg(file)
        .args(["-vn", "-map", &format!("0:a:{track}"), "-ac", "1", "-ar", "16000", "-f", "s16le", "-t", &(max_minutes * 60).to_string(), "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("ffmpeg startet nicht: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let first = err.lines().next().unwrap_or("").trim();
        return Err(format!("ffmpeg konnte Tonspur {track} nicht lesen: {first}"));
    }
    if out.stdout.len() < 2 * SAMPLE_RATE as usize / 2 {
        return Err("Tonspur ist leer (kürzer als eine halbe Sekunde)".into());
    }
    Ok(out.stdout.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect())
}

/// Teilt einen Sprechabschnitt mit dem Pausen-Segmentierer in Stücke; Zeiten ab Dateibeginn.
pub fn split_turn(pcm: &[i16], start_ms: i64, end_ms: i64) -> Vec<segment::Segment> {
    let from = ((start_ms - PAD_MS).max(0) * SAMPLE_RATE as i64 / 1000) as usize;
    let to = (((end_ms + PAD_MS) * SAMPLE_RATE as i64 / 1000) as usize).min(pcm.len());
    if from >= to {
        return Vec::new();
    }
    let base = from as i64 * 1000 / SAMPLE_RATE as i64;
    let mut seg = Segmenter::new(segment::Config::default());
    let mut out = Vec::new();
    for block in pcm[from..to].chunks(SAMPLE_RATE as usize) {
        // Der Segmentierer nimmt `now_ms` als Zeitpunkt des Endes des ersten Blocks (Echtzeitbetrieb); nur der erste Aufruf zählt.
        out.extend(seg.push(block, base + block.len() as i64 * 1000 / SAMPLE_RATE as i64));
    }
    out.extend(seg.flush());
    out
}

#[allow(clippy::too_many_arguments)]
fn run(
    job: &Job,
    spec: &FileSpec,
    engine: &dyn Engine,
    diarizer: Option<&Diarizer>,
    extract: &Extractor,
    threshold: f64,
    threads: usize,
    tmp_dir: &Path,
) -> Result<String, String> {
    let set = |state: &str, progress: u32, message: &str| {
        let mut i = job.info.lock().expect("lock poisoned");
        i.state = state.to_string();
        i.progress = progress;
        i.message = message.to_string();
    };
    let canceled = || job.cancel.load(Ordering::Relaxed);

    set("extracting", 2, "");
    let pcm = extract(&spec.file, spec.track)?;
    let total_ms = pcm.len() as i64 * 1000 / SAMPLE_RATE as i64;
    job.info.lock().expect("lock poisoned").duration_s = total_ms as f64 / 1000.0;
    if canceled() {
        return Err("abgebrochen".into());
    }

    // Sprecher
    let use_speakers = spec.speakers != 1;
    let (turns, found): (Vec<Turn>, usize) = if use_speakers {
        let d = diarizer.ok_or("Sprechererkennung nicht eingerichtet (sh tools/asr-engine/install-diarization.sh); „1 Sprecher“ erzeugt Untertitel ohne Namen")?;
        set("diarizing", 5, "");
        let wav = tmp_dir.join(format!("omp-asr-{}.wav", job.info.lock().expect("lock poisoned").id));
        std::fs::write(&wav, engine::wav_bytes(&pcm)).map_err(|e| format!("temporäre WAV-Datei: {e}"))?;
        let prog = AtomicU32::new(0);
        let result = std::thread::scope(|sc| {
            let watcher = sc.spawn(|| {
                // Fortschritt der Sprechererkennung (5–40 %) in die Auftragsinfo spiegeln
                while prog.load(Ordering::Relaxed) < 100 && !canceled() {
                    let p = prog.load(Ordering::Relaxed);
                    job.info.lock().expect("lock poisoned").progress = 5 + p * 35 / 100;
                    std::thread::sleep(std::time::Duration::from_millis(400));
                }
            });
            let r = d.run(&wav, spec.speakers, threshold, threads, &prog, &job.cancel);
            prog.store(100, Ordering::Relaxed);
            let _ = watcher.join();
            r
        });
        let _ = std::fs::remove_file(&wav);
        let turns = result?;
        let (turns, n) = diarize::renumber(&diarize::merge(&turns, 500, 300));
        if turns.is_empty() {
            return Err("keine Sprache gefunden".into());
        }
        (turns, n)
    } else {
        (vec![Turn { start_ms: 0, end_ms: total_ms, speaker: 0 }], 1)
    };
    job.info.lock().expect("lock poisoned").speakers_found = if use_speakers { found } else { 0 };
    if canceled() {
        return Err("abgebrochen".into());
    }

    // Text je Sprechabschnitt
    set("transcribing", if use_speakers { 40 } else { 5 }, "");
    let speech_ms: i64 = turns.iter().map(|t| t.end_ms - t.start_ms).sum::<i64>().max(1);
    let (base, span) = if use_speakers { (40u32, 60u32) } else { (5u32, 95u32) };
    let mut done_ms = 0i64;
    let mut utts: Vec<Utterance> = Vec::new();
    for t in &turns {
        for seg in split_turn(&pcm, t.start_ms, t.end_ms) {
            if canceled() {
                return Err("abgebrochen".into());
            }
            match engine.transcribe(&seg.samples, &spec.language) {
                Ok(text) if !text.is_empty() => utts.push(Utterance { start_ms: seg.start_ms, end_ms: seg.end_ms, speaker: use_speakers.then_some(t.speaker), text }),
                Ok(_) => {}
                Err(e) if e.starts_with("starting:") => return Err(format!("Engine lädt noch — bitte gleich noch einmal versuchen ({e})")),
                Err(e) => return Err(format!("Spracherkennung: {e}")),
            }
        }
        done_ms += t.end_ms - t.start_ms;
        job.info.lock().expect("lock poisoned").progress = base + (done_ms as f64 / speech_ms as f64 * span as f64) as u32;
    }
    if utts.is_empty() {
        return Err("kein erkennbarer Text".into());
    }
    let cues = build_cues(&utts, &spec.names, &spec.label_word, spec.style);
    job.info.lock().expect("lock poisoned").cues = cues.len();
    Ok(output::srt_file(&cues))
}

impl FileJobs {
    /// Startet den Arbeitsfaden. `ffmpeg`: Programmname; `home`: für temporäre Dateien (Systemtemp, wenn nicht schreibbar).
    pub fn new(engine: Arc<dyn Engine>, diarizer: Option<Arc<Diarizer>>, extract: Arc<Extractor>, threshold: f64, threads: usize) -> Arc<FileJobs> {
        let (tx, rx) = channel::<(Arc<Job>, FileSpec)>();
        let me = Arc::new(FileJobs { jobs: Mutex::new(Vec::new()), tx: Mutex::new(tx), next: Mutex::new(0), has_diarizer: diarizer.is_some() });
        std::thread::Builder::new()
            .name("omp-asr-filejobs".into())
            .spawn(move || {
                let tmp = std::env::temp_dir();
                for (job, spec) in rx {
                    if job.cancel.load(Ordering::Relaxed) {
                        let mut i = job.info.lock().expect("lock poisoned");
                        i.state = "canceled".into();
                        i.finished_ms = Some(now_ms());
                        continue;
                    }
                    let r = run(&job, &spec, engine.as_ref(), diarizer.as_deref(), extract.as_ref(), threshold, threads, &tmp);
                    let mut i = job.info.lock().expect("lock poisoned");
                    i.finished_ms = Some(now_ms());
                    match r {
                        Ok(srt) => {
                            i.state = "done".into();
                            i.progress = 100;
                            *job.srt.lock().expect("lock poisoned") = Some(srt);
                        }
                        Err(e) if e == "abgebrochen" => {
                            i.state = "canceled".into();
                            i.message = e;
                        }
                        Err(e) => {
                            i.state = "failed".into();
                            i.message = e;
                        }
                    }
                }
            })
            .expect("Arbeitsfaden starten");
        me
    }

    pub fn has_diarizer(&self) -> bool {
        self.has_diarizer
    }

    /// Nimmt einen Auftrag an; liefert die Auftrags-ID.
    pub fn submit(&self, mut spec: FileSpec, engine_name: &str) -> Result<String, String> {
        validate(&spec)?;
        spec.name = sanitize_name(&spec.name);
        if spec.label_word.trim().is_empty() {
            spec.label_word = "Sprecher".into();
        }
        let id = if spec.id.trim().is_empty() {
            let mut n = self.next.lock().expect("lock poisoned");
            *n += 1;
            format!("{:x}-{}", now_ms(), *n)
        } else {
            let id = spec.id.trim().to_string();
            if id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                return Err("id: nur Buchstaben, Ziffern, - und _, höchstens 64 Zeichen".into());
            }
            if self.find(&id).is_some() {
                return Err(format!("id {id} gibt es schon"));
            }
            id
        };
        let job = Arc::new(Job {
            info: Mutex::new(JobInfo {
                id: id.clone(),
                name: spec.name.clone(),
                file: spec.file.display().to_string(),
                track: spec.track,
                language: spec.language.clone(),
                speakers_requested: spec.speakers,
                state: "queued".into(),
                progress: 0,
                message: String::new(),
                speakers_found: 0,
                cues: 0,
                duration_s: 0.0,
                created_ms: now_ms(),
                finished_ms: None,
                engine: engine_name.to_string(),
            }),
            srt: Mutex::new(None),
            cancel: AtomicBool::new(false),
        });
        {
            let mut jobs = self.jobs.lock().expect("lock poisoned");
            jobs.push(job.clone());
            // Fertige/abgebrochene Aufträge nur begrenzt behalten
            while jobs.len() > MAX_JOBS_KEPT {
                let Some(i) = jobs.iter().position(|j| !matches!(j.info.lock().expect("lock poisoned").state.as_str(), "queued" | "extracting" | "diarizing" | "transcribing")) else { break };
                jobs.remove(i);
            }
        }
        self.tx.lock().expect("lock poisoned").send((job, spec)).map_err(|_| "Arbeitsfaden beendet".to_string())?;
        Ok(id)
    }

    fn find(&self, id: &str) -> Option<Arc<Job>> {
        self.jobs.lock().expect("lock poisoned").iter().find(|j| j.info.lock().expect("lock poisoned").id == id).cloned()
    }

    pub fn cancel(&self, id: &str) -> bool {
        self.find(id).map(|j| j.cancel.store(true, Ordering::Relaxed)).is_some()
    }

    pub fn remove(&self, id: &str) -> bool {
        let mut jobs = self.jobs.lock().expect("lock poisoned");
        let before = jobs.len();
        jobs.retain(|j| {
            let i = j.info.lock().expect("lock poisoned");
            i.id != id || matches!(i.state.as_str(), "queued" | "extracting" | "diarizing" | "transcribing")
        });
        jobs.len() != before
    }

    pub fn list_json(&self) -> Value {
        Value::Array(self.jobs.lock().expect("lock poisoned").iter().map(|j| j.info.lock().expect("lock poisoned").json()).collect())
    }

    pub fn srt(&self, id: &str) -> Option<String> {
        self.find(id)?.srt.lock().expect("lock poisoned").clone()
    }

    pub fn state(&self, id: &str) -> Option<String> {
        Some(self.find(id)?.info.lock().expect("lock poisoned").state.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: i64, e: i64, spk: Option<usize>, t: &str) -> Utterance {
        Utterance { start_ms: s, end_ms: e, speaker: spk, text: t.into() }
    }

    #[test]
    fn labels_only_at_speaker_change_in_chosen_style() {
        let utts = [u(0, 3000, Some(0), "Guten Abend."), u(3000, 6000, Some(0), "Willkommen."), u(6500, 9000, Some(1), "Danke.")];
        let c = build_cues(&utts, &["Anna".into()], "Sprecher", LabelStyle::Colon);
        assert_eq!(c[0].text, "Anna: Guten Abend.");
        assert_eq!(c[1].text, "Willkommen.", "gleicher Sprecher: kein neuer Name");
        assert_eq!(c[2].text, "Sprecher 2: Danke.", "ohne Namen: Wort + Nummer");
        assert_eq!(build_cues(&utts, &[], "Speaker", LabelStyle::Bracket)[0].text, "[Speaker 1] Guten Abend.");
        let d = build_cues(&utts, &[], "S", LabelStyle::Dash);
        assert_eq!((d[0].text.as_str(), d[1].text.as_str(), d[2].text.as_str()), ("- Guten Abend.", "Willkommen.", "- Danke."));
    }

    #[test]
    fn without_speakers_the_text_stays_plain() {
        let c = build_cues(&[u(0, 2000, None, "Nur Text.")], &[], "Sprecher", LabelStyle::Colon);
        assert_eq!(c[0].text, "Nur Text.");
    }

    #[test]
    fn overlapping_speakers_do_not_overlap_in_the_file() {
        let utts = [u(0, 5000, Some(0), "Ich wollte sagen"), u(3000, 6000, Some(1), "Moment bitte")];
        let c = build_cues(&utts, &[], "Sprecher", LabelStyle::Colon);
        for w in c.windows(2) {
            assert!(w[0].end_ms <= w[1].start_ms, "{c:?}");
        }
    }

    #[test]
    fn style_names_and_sanitising() {
        assert_eq!(LabelStyle::parse(""), Some(LabelStyle::Colon));
        assert_eq!(LabelStyle::parse("dash"), Some(LabelStyle::Dash));
        assert_eq!(LabelStyle::parse("fett"), None);
        assert_eq!(sanitize_name("../Wetter Abend!"), "Wetter-Abend");
        assert_eq!(sanitize_name("  "), "untertitel");
        assert_eq!(label_for(1, &["A".into(), "  ".into()], "Sprecher"), "Sprecher 2");
    }

    #[test]
    fn validation_rejects_missing_file_and_bad_values() {
        let mut s = FileSpec { file: "/nicht/da.mxf".into(), track: 0, language: "de".into(), speakers: 0, names: vec![], label_word: "Sprecher".into(), style: LabelStyle::Colon, name: "x".into(), id: String::new() };
        assert!(validate(&s).unwrap_err().contains("nicht gefunden"));
        s.file = "relativ.mxf".into();
        assert!(validate(&s).unwrap_err().contains("absoluter"));
        let me = std::env::current_exe().unwrap();
        s.file = me;
        s.speakers = 40;
        assert!(validate(&s).unwrap_err().contains("speakers"));
        s.speakers = 2;
        s.track = 99;
        assert!(validate(&s).unwrap_err().contains("track"));
        s.track = 0;
        s.language = " ".into();
        assert!(validate(&s).unwrap_err().contains("language"));
        s.language = "de".into();
        assert!(validate(&s).is_ok());
    }

    /// Ersatz-Engine: erkennt „Text <Länge in Zehntelsekunden>“ — genügt, um den Ablauf ohne Modell zu prüfen.
    struct Fake;
    impl Engine for Fake {
        fn name(&self) -> String {
            "fake".into()
        }
        fn transcribe(&self, pcm: &[i16], _l: &str) -> Result<String, String> {
            Ok(format!("Text {}", pcm.len() / 1600))
        }
        fn check(&self) -> Result<(), String> {
            Ok(())
        }
    }

    /// 6 s Sprache (Sinus) – 1 s Stille – 6 s Sprache: der Segmentierer teilt an der Pause.
    fn tone(sec: f64) -> Vec<i16> {
        (0..(sec * 16000.0) as usize).map(|i| ((i as f64 * 0.12).sin() * 9000.0) as i16).collect()
    }
    fn two_blocks() -> Vec<i16> {
        let mut v = tone(6.0);
        v.extend(vec![0i16; 16000]);
        v.extend(tone(6.0));
        v
    }

    fn wait(jobs: &FileJobs, id: &str) -> String {
        for _ in 0..200 {
            let s = jobs.state(id).unwrap();
            if !matches!(s.as_str(), "queued" | "extracting" | "diarizing" | "transcribing") {
                return s;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("Auftrag wird nicht fertig");
    }

    fn spec(speakers: usize) -> FileSpec {
        FileSpec { file: std::env::current_exe().unwrap(), track: 0, language: "de".into(), speakers, names: vec![], label_word: "Sprecher".into(), style: LabelStyle::Colon, name: "Probe".into(), id: String::new() }
    }

    #[test]
    fn caller_chosen_id_must_be_clean_and_unique() {
        let extract: Arc<Extractor> = Arc::new(|_, _| Ok(two_blocks()));
        let jobs = FileJobs::new(Arc::new(Fake), None, extract, 0.7, 1);
        let mut sp = spec(1);
        sp.id = "job-1_a".into();
        assert_eq!(jobs.submit(sp.clone(), "fake").unwrap(), "job-1_a");
        assert!(jobs.submit(sp.clone(), "fake").unwrap_err().contains("gibt es schon"));
        sp.id = "../x".into();
        assert!(jobs.submit(sp, "fake").unwrap_err().contains("id:"));
    }

    #[test]
    fn one_speaker_job_produces_plain_srt() {
        let extract: Arc<Extractor> = Arc::new(|_, _| Ok(two_blocks()));
        let jobs = FileJobs::new(Arc::new(Fake), None, extract, 0.7, 1);
        let id = jobs.submit(spec(1), "fake").unwrap();
        assert_eq!(wait(&jobs, &id), "done", "{}", jobs.list_json());
        let srt = jobs.srt(&id).unwrap();
        assert!(srt.starts_with("1\n00:00:0"), "{srt}");
        assert!(srt.contains("Text "), "{srt}");
        assert!(!srt.contains("Sprecher"), "Ein-Sprecher-Auftrag trägt keine Namen: {srt}");
        let info = jobs.list_json();
        assert_eq!(info[0]["state"], "done");
        assert_eq!(info[0]["progress"], 100);
        assert!(info[0]["cues"].as_u64().unwrap() >= 2);
    }

    #[test]
    fn speakers_requested_without_diarizer_fails_clearly() {
        let extract: Arc<Extractor> = Arc::new(|_, _| Ok(two_blocks()));
        let jobs = FileJobs::new(Arc::new(Fake), None, extract, 0.7, 1);
        let id = jobs.submit(spec(0), "fake").unwrap();
        assert_eq!(wait(&jobs, &id), "failed");
        let m = jobs.list_json()[0]["message"].as_str().unwrap().to_string();
        assert!(m.contains("install-diarization"), "{m}");
        assert!(jobs.srt(&id).is_none());
    }

    #[test]
    fn extraction_error_is_reported_and_jobs_can_be_removed() {
        let extract: Arc<Extractor> = Arc::new(|_, t| Err(format!("keine Tonspur {t}")));
        let jobs = FileJobs::new(Arc::new(Fake), None, extract, 0.7, 1);
        let id = jobs.submit(spec(1), "fake").unwrap();
        assert_eq!(wait(&jobs, &id), "failed");
        assert!(jobs.list_json()[0]["message"].as_str().unwrap().contains("keine Tonspur"));
        assert!(jobs.remove(&id));
        assert_eq!(jobs.list_json().as_array().unwrap().len(), 0);
    }

    #[test]
    fn split_turn_cuts_at_pauses_with_absolute_times() {
        let pcm = two_blocks();
        let segs = split_turn(&pcm, 0, 13_000);
        assert!(segs.len() >= 2, "{} Segmente", segs.len());
        assert!(segs[1].start_ms >= 6_000, "zweites Stück liegt hinter der Pause: {}", segs[1].start_ms);
        // Ausschnitt aus der Mitte: Zeiten bleiben Dateizeiten
        let part = split_turn(&pcm, 7_000, 13_000);
        assert!(part[0].start_ms >= 6_800, "{}", part[0].start_ms);
    }
}
