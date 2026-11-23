//! Pipeline von `omp-avdelay`: liest je einen per IS-05 gewählten Video- und Audio-Flow aus der MXL-Domain des Nodes und schreibt
//! sie verzögert als eigene Flows wieder hinein (Standard: dieselbe Domain). Aufbau wie `omp-mxl-bridge`, aber **ohne**
//! Wandlungspfad: der Node ändert nur die Zeit, nie das Format. Passt das Quellformat nicht zum Format des Nodes
//! (Größe, Bildrate, Abtastrate, Kanalzahl), wird die Verbindung mit klarer Meldung abgelehnt — Anpassen ist Aufgabe des
//! Normalizers/Scalers davor. Die Verzögerung steuert `AvDelay` (Bild in ganzen Bildern, Ton auf das Sample genau) und ist
//! jederzeit änderbar.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use omp_mediaio::domainwatch::DomainWatch;
use omp_mediaio::mxl::MxlContext;
use omp_mediaio::rawcopy::{
    AudioFormat, AvDelay, RawAudioCopy, RawVideoCopy, VideoFormat, check_audio_passthrough, check_passthrough,
};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub const SAMPLE_RATE: u32 = crate::delay::SAMPLE_RATE;

pub struct Config {
    /// Eingangsdomain (die Domain des Nodes).
    pub in_domain: String,
    /// Domain der geschriebenen Flows (Standard = Eingangsdomain).
    pub out_domain: String,
    pub video_flow_id: String,
    pub audio_flow_id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub framerate_numerator: u32,
    pub framerate_denominator: u32,
    pub audio_channels: u32,
    /// Gemeinsame Steuerung der Verzögerung (Parameter des Nodes schreiben hinein, die Kopierer lesen sie).
    pub delay: Arc<AvDelay>,
}

pub enum Event {
    Error(String),
}

enum Command {
    /// Im Eingangs-Domain-Verzeichnis wurde ein Flow angelegt oder entfernt (inotify) — offene Verbindungen erneut versuchen.
    DomainChanged,
    /// Ein Kopierer hat seine Quelle verloren (kein Grain seit 3 s) — Zweig neu aufbauen.
    SourceLost,
    ConnectVideo(String),
    DisconnectVideo,
    ConnectAudio(String),
    DisconnectAudio,
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    video_flowed: Arc<AtomicBool>,
    audio_flowed: Arc<AtomicBool>,
    /// "direkt kopiert" oder "abgelehnt: <Grund>" — nur Anzeige.
    video_mode: Arc<std::sync::Mutex<String>>,
    audio_mode: Arc<std::sync::Mutex<String>>,
}

impl PipelineHandle {
    pub fn connect_video(&self, flow_id: String) {
        self.video_flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::ConnectVideo(flow_id));
    }
    pub fn disconnect_video(&self) {
        self.video_flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::DisconnectVideo);
    }
    pub fn connect_audio(&self, flow_id: String) {
        self.audio_flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::ConnectAudio(flow_id));
    }
    pub fn disconnect_audio(&self) {
        self.audio_flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::DisconnectAudio);
    }
    /// Ob in der verbundenen Quelle mindestens ein Bild floss (media-ready).
    pub fn media_ready(&self) -> bool {
        self.video_flowed.load(Ordering::Relaxed)
    }
    pub fn audio_flowed(&self) -> bool {
        self.audio_flowed.load(Ordering::Relaxed)
    }
    pub fn video_mode(&self) -> String {
        self.video_mode.lock().expect("lock poisoned").clone()
    }
    pub fn audio_mode(&self) -> String {
        self.audio_mode.lock().expect("lock poisoned").clone()
    }
}

/// Präfix permanenter Fehler (Format passt nicht): kein erneuter Versuch, bis die Verbindung geändert wird.
const FORMAT_ERR: &str = "FORMAT: ";

fn connect_video(
    in_ctx: &Arc<MxlContext>,
    out_ctx: &Arc<MxlContext>,
    source_flow_id: &str,
    config: &Config,
    flowed: Arc<AtomicBool>,
    mode: &Arc<std::sync::Mutex<String>>,
    wake: &Arc<dyn Fn() + Send + Sync>,
) -> Result<RawVideoCopy, String> {
    let target = VideoFormat {
        width: config.width,
        height: config.height,
        rate_num: config.framerate_numerator,
        rate_den: config.framerate_denominator,
    };
    let set_mode = |m: String| *mode.lock().expect("lock poisoned") = m;
    // Fehlt der Quell-Flow noch (Start-Reihenfolge), ist das kein Formatfehler: Fehler ohne Präfix wird bei der nächsten
    // Änderung der Domain erneut versucht.
    let source_def = in_ctx.flow_def(source_flow_id).map_err(|e| format!("Quelle {source_flow_id}: {e}"))?;
    let def = match check_passthrough(&source_def, target) {
        Ok(def) => def,
        Err(why) => {
            set_mode(format!("abgelehnt: {why}"));
            return Err(format!(
                "{FORMAT_ERR}Video-Quelle passt nicht zum A/V-Delay ({why}). Der Node ändert nur die Zeit: einen Scaler/Normalizer \
                 davor schalten oder das Format des Nodes (OMP_WIDTH/OMP_HEIGHT/OMP_FRAMERATE_NUM/DEN) an die Quelle anpassen."
            ));
        }
    };
    let rc = RawVideoCopy::start_delayed(
        in_ctx.clone(),
        out_ctx.clone(),
        source_flow_id,
        def,
        &config.video_flow_id,
        &config.label,
        target,
        flowed,
        wake.clone(),
        Some(config.delay.clone()),
    )
    .map_err(|e| format!("Kopierer: {e}"))?;
    set_mode("direkt kopiert".to_string());
    Ok(rc)
}

fn connect_audio(
    in_ctx: &Arc<MxlContext>,
    out_ctx: &Arc<MxlContext>,
    source_flow_id: &str,
    config: &Config,
    flowed: Arc<AtomicBool>,
    mode: &Arc<std::sync::Mutex<String>>,
    wake: &Arc<dyn Fn() + Send + Sync>,
) -> Result<RawAudioCopy, String> {
    let target = AudioFormat { sample_rate: SAMPLE_RATE, channels: config.audio_channels };
    let set_mode = |m: String| *mode.lock().expect("lock poisoned") = m;
    let source_def = in_ctx.flow_def(source_flow_id).map_err(|e| format!("Quelle {source_flow_id}: {e}"))?;
    let def = match check_audio_passthrough(&source_def, target) {
        Ok(def) => def,
        Err(why) => {
            set_mode(format!("abgelehnt: {why}"));
            return Err(format!(
                "{FORMAT_ERR}Ton-Quelle passt nicht zum A/V-Delay ({why}). Die Quelle auf {SAMPLE_RATE} Hz / {} Kanäle bringen \
                 oder OMP_AUDIO_CHANNELS des Nodes anpassen.",
                config.audio_channels
            ));
        }
    };
    let rc = RawAudioCopy::start_delayed(
        in_ctx.clone(),
        out_ctx.clone(),
        source_flow_id,
        def,
        &config.audio_flow_id,
        &config.label,
        target,
        flowed,
        wake.clone(),
        Some(config.delay.clone()),
    )
    .map_err(|e| format!("Kopierer: {e}"))?;
    set_mode("direkt kopiert".to_string());
    Ok(rc)
}

pub fn run(
    config: Config,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
    heartbeat: Arc<AtomicU64>,
) {
    let in_ctx = match MxlContext::new(&config.in_domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };
    let out_ctx = if config.out_domain == config.in_domain {
        in_ctx.clone()
    } else {
        match MxlContext::new(&config.out_domain) {
            Ok(c) => Arc::new(c),
            Err(e) => {
                let msg = format!("Ausgangsdomain {}: {e}", config.out_domain);
                let _ = tx.send(Event::Error(msg.clone()));
                let _ = ready.send(Err(msg));
                return;
            }
        }
    };

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) =
        std::sync::mpsc::channel();
    let video_flowed = Arc::new(AtomicBool::new(false));
    let audio_flowed = Arc::new(AtomicBool::new(false));
    let video_mode = Arc::new(std::sync::Mutex::new(String::new()));
    let audio_mode = Arc::new(std::sync::Mutex::new(String::new()));
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx.clone(),
        video_flowed: video_flowed.clone(),
        audio_flowed: audio_flowed.clone(),
        video_mode: video_mode.clone(),
        audio_mode: audio_mode.clone(),
    }));

    // Ereignisse statt Nachsehen im Takt: ein inotify-Beobachter weckt die Schleife, wenn im Eingangs-Domainverzeichnis ein Flow
    // erscheint oder verschwindet; die Kopierer wecken sie, wenn ihre Quelle verloren geht. Dazwischen schläft sie (nur ein
    // 2-s-Herzschlag für die Liveness-Überwachung des Node-SDK).
    let wake: Arc<dyn Fn() + Send + Sync> = {
        let tx = commands_tx.clone();
        let m = std::sync::Mutex::new(());
        Arc::new(move || {
            let _g = m.lock();
            let _ = tx.send(Command::SourceLost);
        })
    };
    let watcher = match DomainWatch::new(std::path::Path::new(&config.in_domain)) {
        Ok(w) => {
            let tx = commands_tx.clone();
            let stop = shutdown.clone();
            Some(std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    // Blockiert im Kernel bis zu einer Änderung; die Sekunde ist nur die Stopp-Prüfung.
                    if w.wait(Some(Duration::from_secs(1))) && tx.send(Command::DomainChanged).is_err() {
                        break;
                    }
                }
            }))
        }
        Err(e) => {
            eprintln!("omp-avdelay: Domain {} nicht beobachtbar ({e}) — Quellen, die später erscheinen, werden nicht automatisch erkannt", config.in_domain);
            None
        }
    };
    let mut video: Option<RawVideoCopy> = None;
    let mut audio: Option<RawAudioCopy> = None;
    let mut last_audio: Option<String> = None;
    let mut retry_video: Option<String> = None;
    let mut last_video: Option<String> = None; // zuletzt gewählte Videoquelle (für den Neuaufbau eines gestorbenen Kopierers)
    let mut retry_audio: Option<String> = None;
    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Command::ConnectVideo(id)) => {
                last_video = Some(id.clone());
                video = None;
                match connect_video(&in_ctx, &out_ctx, &id, &config, video_flowed.clone(), &video_mode, &wake) {
                    Ok(p) => {
                        video = Some(p);
                        retry_video = None;
                    }
                    Err(e) => {
                        // Formatfehler sind endgültig (kein Dauer-Neuversuch), alles andere wird wiederholt.
                        retry_video = (!e.starts_with(FORMAT_ERR)).then(|| id.clone());
                        let _ = tx.send(Event::Error(e.trim_start_matches(FORMAT_ERR).to_string()));
                    }
                }
            }
            Ok(Command::DisconnectVideo) => {
                video = None;
                retry_video = None;
                last_video = None;
                video_mode.lock().expect("lock poisoned").clear();
            }
            Ok(Command::ConnectAudio(id)) => {
                last_audio = Some(id.clone());
                audio = None;
                match connect_audio(&in_ctx, &out_ctx, &id, &config, audio_flowed.clone(), &audio_mode, &wake) {
                    Ok(p) => {
                        audio = Some(p);
                        retry_audio = None;
                    }
                    Err(e) => {
                        retry_audio = (!e.starts_with(FORMAT_ERR)).then(|| id.clone());
                        let _ = tx.send(Event::Error(e.trim_start_matches(FORMAT_ERR).to_string()));
                    }
                }
            }
            Ok(Command::DisconnectAudio) => {
                audio = None;
                retry_audio = None;
                last_audio = None;
                audio_mode.lock().expect("lock poisoned").clear();
            }
            // Quelle verloren: nur den Zweig abbauen und merken. KEIN sofortiger neuer Versuch — die Flow-Datei eines beendeten
            // Schreibers bleibt liegen, ein Neuöffnen würde nach 3 s wieder scheitern (verstecktes Polling im 3-s-Takt). Der
            // nächste Versuch kommt erst, wenn sich im Domainverzeichnis etwas ändert (Flow neu angelegt/ersetzt).
            Ok(Command::SourceLost) => {
                // Ein Kopierer, dessen Quelle verschwand (neu angelegt/gestoppt), baut sich neu auf.
                if video.as_ref().is_some_and(RawVideoCopy::is_dead) {
                    eprintln!("omp-avdelay: Videoquelle liefert keine Bilder mehr — verbinde neu");
                    video = None;
                    video_flowed.store(false, Ordering::Relaxed);
                    retry_video = last_video.clone();
                }
                if audio.as_ref().is_some_and(RawAudioCopy::is_dead) {
                    eprintln!("omp-avdelay: Tonquelle liefert nichts mehr — verbinde neu");
                    audio = None;
                    audio_flowed.store(false, Ordering::Relaxed);
                    retry_audio = last_audio.clone();
                }
}
            // Ein Flow wurde angelegt oder entfernt: offene Verbindungen erneut versuchen (inotify, kein Nachsehen im Takt).
            Ok(Command::DomainChanged) => {
                // Ein Kopierer, dessen Quelle verschwand (neu angelegt/gestoppt), baut sich neu auf.
                if video.as_ref().is_some_and(RawVideoCopy::is_dead) {
                    eprintln!("omp-avdelay: Videoquelle liefert keine Bilder mehr — verbinde neu");
                    video = None;
                    video_flowed.store(false, Ordering::Relaxed);
                    retry_video = last_video.clone();
                }
                if audio.as_ref().is_some_and(RawAudioCopy::is_dead) {
                    eprintln!("omp-avdelay: Tonquelle liefert nichts mehr — verbinde neu");
                    audio = None;
                    audio_flowed.store(false, Ordering::Relaxed);
                    retry_audio = last_audio.clone();
                }
                // Die Quelle erscheint evtl. erst später in der Eingangsdomain (Start-Reihenfolge) — erneut versuchen.
                if video.is_none()
                    && let Some(id) = retry_video.clone()
                    && let Ok(p) = connect_video(&in_ctx, &out_ctx, &id, &config, video_flowed.clone(), &video_mode, &wake)
                {
                    video = Some(p);
                    retry_video = None;
                }
                if audio.is_none()
                    && let Some(id) = retry_audio.clone()
                    && let Ok(p) = connect_audio(&in_ctx, &out_ctx, &id, &config, audio_flowed.clone(), &audio_mode, &wake)
                {
                    audio = Some(p);
                    retry_audio = None;
                }
            }
            // Nur der Herzschlag (Schleifenanfang): nichts zu tun, kein Nachsehen.
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(video);
    drop(audio);
    if let Some(w) = watcher {
        let _ = w.join();
    }
}
