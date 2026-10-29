//! Engine-Verwaltung: Die Spracherkennungs-Engine (whisper.cpp-Server) gehört zum Node. Er findet Programm und Modelle, startet die
//! Engine auf einem freien lokalen Port, überwacht sie (stürzt sie ab, startet sie neu), tauscht das Modell zur Laufzeit und beendet
//! sie mit sich — auch bei hartem Abbruch (Elternprozess-Signal). So wird mit dem Node auch seine Engine ersetzt.
//!
//! Ablage: `<home>/bin/whisper-server` (+ Bibliotheken daneben) und `<home>/models/ggml-<Name>.bin`; `<home>` = `OMP_ASR_HOME`
//! (Standard `data/asr-engine`), eingerichtet mit `tools/asr-engine/install.sh`.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::engine::{Engine, WhisperHttp};

pub struct Config {
    pub home: PathBuf,
    /// Programm ausdrücklich gesetzt (`OMP_ASR_BIN`) statt `<home>/bin/whisper-server`.
    pub bin: Option<PathBuf>,
    pub threads: u32,
    /// Modellname (`small`) oder Pfad; leer = bestes vorhandenes.
    pub model: String,
    /// Datei, in der die im Panel gewählte Modellwahl bleibt (leer = nicht merken).
    pub state_file: Option<PathBuf>,
}

struct State {
    child: Option<Child>,
    model: String,
    /// Letzter Startfehler (leer = keiner).
    error: String,
}

pub struct EngineManager {
    cfg: Config,
    port: u16,
    state: Mutex<State>,
    stop: Arc<AtomicBool>,
}

/// Modellname aus einem Dateinamen `ggml-<Name>.bin`.
fn model_name(path: &Path) -> Option<String> {
    let f = path.file_name()?.to_str()?;
    f.strip_prefix("ggml-")?.strip_suffix(".bin").map(str::to_string)
}

/// Rangfolge für „bestes vorhandenes“: größere Modelle zuerst, aber nicht die sehr großen (zu langsam ohne GPU).
fn preference(name: &str) -> usize {
    ["small", "base", "medium", "tiny"].iter().position(|n| name == *n || name.starts_with(&format!("{n}."))).unwrap_or(99)
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").ok().and_then(|l| l.local_addr().ok()).map_or(8178, |a| a.port())
}

impl EngineManager {
    pub fn bin_path(cfg: &Config) -> PathBuf {
        cfg.bin.clone().unwrap_or_else(|| cfg.home.join("bin").join("whisper-server"))
    }

    pub fn models_dir(cfg: &Config) -> PathBuf {
        cfg.home.join("models")
    }

    /// Verfügbare Modelle (Namen), bevorzugte zuerst.
    pub fn models(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(Self::models_dir(&self.cfg)).into_iter().flatten().flatten().filter_map(|e| model_name(&e.path())).collect();
        v.sort_by_key(|n| (preference(n), n.clone()));
        v
    }

    /// Startet die Verwaltung. `Err`, wenn kein Programm da ist (Meldung nennt den Installationsbefehl).
    pub fn start(cfg: Config) -> Result<Arc<Self>, String> {
        let bin = Self::bin_path(&cfg);
        if !bin.is_file() {
            return Err(format!("Engine nicht installiert: {} fehlt — `sh tools/asr-engine/install.sh` ausführen (oder OMP_ASR_HOME/OMP_ASR_BIN setzen)", bin.display()));
        }
        let me = Arc::new(EngineManager { port: free_port(), state: Mutex::new(State { child: None, model: String::new(), error: String::new() }), stop: Arc::new(AtomicBool::new(false)), cfg });
        // gemerkte Wahl > Option > bestes vorhandenes
        let saved = me.cfg.state_file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let models = me.models();
        let wanted = [saved, Some(me.cfg.model.clone())].into_iter().flatten().find(|m| !m.is_empty() && me.model_path(m).is_some());
        me.state.lock().expect("lock poisoned").model = wanted.or_else(|| models.first().cloned()).unwrap_or_default();
        let watcher = me.clone();
        std::thread::spawn(move || watcher.watch());
        Ok(me)
    }

    /// Dateipfad zu einem Modellnamen oder Pfad.
    fn model_path(&self, name: &str) -> Option<PathBuf> {
        let direct = PathBuf::from(name);
        if direct.is_file() {
            return Some(direct);
        }
        let p = Self::models_dir(&self.cfg).join(format!("ggml-{name}.bin"));
        p.is_file().then_some(p)
    }

    pub fn current_model(&self) -> String {
        self.state.lock().expect("lock poisoned").model.clone()
    }

    /// Wechselt das Modell: Engine beenden, die Überwachung startet sie mit dem neuen Modell.
    pub fn set_model(&self, name: &str) -> Result<(), String> {
        if self.model_path(name).is_none() {
            return Err(format!("Modell „{name}“ nicht vorhanden (verfügbar: {})", self.models().join(", ")));
        }
        let mut s = self.state.lock().expect("lock poisoned");
        if s.model == name {
            return Ok(());
        }
        s.model = name.to_string();
        s.error.clear();
        if let Some(mut c) = s.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if let Some(f) = &self.cfg.state_file {
            let _ = std::fs::write(f, name);
        }
        Ok(())
    }

    fn spawn(&self, model: &str) -> Result<Child, String> {
        let path = self.model_path(model).ok_or_else(|| format!("Modell „{model}“ nicht vorhanden"))?;
        let bin = Self::bin_path(&self.cfg);
        let lib_dir = bin.parent().map(Path::to_path_buf).unwrap_or_default();
        let ld = match std::env::var("LD_LIBRARY_PATH") {
            Ok(old) if !old.is_empty() => format!("{}:{old}", lib_dir.display()),
            _ => lib_dir.display().to_string(),
        };
        let mut cmd = Command::new(&bin);
        cmd.args(["-m", &path.to_string_lossy(), "--host", "127.0.0.1", "--port", &self.port.to_string(), "-t", &self.cfg.threads.to_string()])
            .env("LD_LIBRARY_PATH", ld)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Stirbt der Node (auch hart), stirbt die Engine mit.
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                Ok(())
            });
        }
        cmd.spawn().map_err(|e| format!("Engine-Start: {e}"))
    }

    /// Überwachung: fehlt die Engine oder ist sie beendet, mit dem gewählten Modell (neu) starten; bei Fehlern mit Pause.
    fn watch(self: Arc<Self>) {
        while !self.stop.load(Ordering::Relaxed) {
            {
                let mut s = self.state.lock().expect("lock poisoned");
                let dead = match s.child.as_mut() {
                    Some(c) => c.try_wait().ok().flatten().is_some(),
                    None => true,
                };
                if dead && !s.model.is_empty() {
                    let model = s.model.clone();
                    match self.spawn(&model) {
                        Ok(c) => {
                            s.child = Some(c);
                            s.error.clear();
                        }
                        Err(e) => s.error = e,
                    }
                } else if s.model.is_empty() && s.error.is_empty() {
                    s.error = format!("kein Modell in {} — `sh tools/asr-engine/install.sh small` ausführen", Self::models_dir(&self.cfg).display());
                }
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        if let Some(mut c) = self.state.lock().expect("lock poisoned").child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    /// Beendet die Engine (beim Herunterfahren des Nodes).
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(mut c) = self.state.lock().expect("lock poisoned").child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    fn http(&self) -> WhisperHttp {
        WhisperHttp { base_url: format!("http://127.0.0.1:{}", self.port) }
    }
}

impl Engine for EngineManager {
    fn name(&self) -> String {
        format!("whisper · Modell {} (im Node, Port {})", self.current_model(), self.port)
    }

    fn transcribe(&self, pcm: &[i16], language: &str) -> Result<String, String> {
        self.check()?;
        self.http().transcribe(pcm, language)
    }

    fn check(&self) -> Result<(), String> {
        {
            let s = self.state.lock().expect("lock poisoned");
            if !s.error.is_empty() {
                return Err(s.error.clone());
            }
        }
        // `starting:` kennzeichnet „lädt noch“ (kein Fehler): das Modell braucht einige Sekunden
        self.http().check().map_err(|_| format!("starting: Engine lädt Modell {} …", self.current_model()))
    }
}
