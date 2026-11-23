//! Pipeline von `omp-audio-split`: liest einen per IS-05 gewählten Mehrkanal-Ton-Flow aus der MXL-Domain des Nodes und schreibt
//! je Ausgang einen eigenen Flow aus den gewählten Kanälen (`omp_mediaio::rawcopy::RawAudioSplit`: bitgleiche Kanalkopie,
//! Sample-Index bleibt erhalten, kein GStreamer). Passt die Quelle nicht (kein `audio/float32`, falsche Abtastrate, zu wenige
//! Kanäle), wird sie mit klarer Meldung abgelehnt; eine noch fehlende Quelle wird bei der nächsten Domainänderung erneut versucht.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omp_mediaio::domainwatch::DomainWatch;
use omp_mediaio::mxl::MxlContext;
use omp_mediaio::rawcopy::{RawAudioSplit, SplitOutput, check_split_source};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use crate::outputs::{self, Output};

pub const SAMPLE_RATE: u32 = 48000;

pub struct Config {
    pub in_domain: String,
    pub out_domain: String,
    pub label: String,
    /// Ausgänge mit ihren Flow-IDs (feste Reihenfolge = Reihenfolge der Sender).
    pub outputs: Vec<(Output, String)>,
}

pub enum Event {
    Error(String),
}

/// Zustand, den Node-Parameter lesen und schreiben.
pub struct Shared {
    pub outputs: Mutex<Vec<Output>>,
    pub flowed: Arc<AtomicBool>,
    pub mode: Mutex<String>,
    pub input_channels: AtomicU32,
}

enum Command {
    DomainChanged,
    SourceLost,
    Connect(String),
    Disconnect,
    /// Kanalzuordnung der Ausgänge wurde geändert (`Shared::outputs`).
    Remap,
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
    pub shared: Arc<Shared>,
}

impl PipelineHandle {
    pub fn connect(&self, flow_id: String) {
        self.shared.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::Connect(flow_id));
    }
    pub fn disconnect(&self) {
        self.shared.flowed.store(false, Ordering::Relaxed);
        let _ = self.commands.send(Command::Disconnect);
    }
    /// Ändert die Kanäle der Ausgänge zur Laufzeit. Namen und Kanalzahl je Ausgang müssen bleiben (die Sender stehen fest).
    pub fn remap(&self, new: Vec<Output>) -> Result<(), String> {
        outputs::validate(&new)?;
        {
            let mut cur = self.shared.outputs.lock().expect("lock poisoned");
            if new.len() != cur.len() {
                return Err(format!("{} Ausgänge statt {} (die Ausgänge stehen beim Start fest)", new.len(), cur.len()));
            }
            for (a, b) in cur.iter().zip(&new) {
                if a.name != b.name {
                    return Err(format!("Ausgang „{}“ heißt jetzt „{}“ (Namen stehen beim Start fest)", a.name, b.name));
                }
                if a.channels.len() != b.channels.len() {
                    return Err(format!("Ausgang „{}“: {} Kanäle statt {}", a.name, b.channels.len(), a.channels.len()));
                }
            }
            let need = self.shared.input_channels.load(Ordering::Relaxed) as usize;
            if need > 0 && outputs::min_input_channels(&new) > need {
                return Err(format!("die Quelle hat nur {need} Kanäle"));
            }
            *cur = new;
        }
        let _ = self.commands.send(Command::Remap);
        Ok(())
    }
    pub fn flowing(&self) -> bool {
        self.shared.flowed.load(Ordering::Relaxed)
    }
}

const FORMAT_ERR: &str = "FORMAT: ";

fn connect(
    in_ctx: &Arc<MxlContext>,
    out_ctx: &Arc<MxlContext>,
    source_flow_id: &str,
    config: &Config,
    shared: &Arc<Shared>,
    wake: &Arc<dyn Fn() + Send + Sync>,
) -> Result<RawAudioSplit, String> {
    let current = shared.outputs.lock().expect("lock poisoned").clone();
    let need = outputs::min_input_channels(&current) as u32;
    // Fehlt der Quell-Flow noch (Start-Reihenfolge), ist das kein Formatfehler und wird später erneut versucht.
    let source_def = in_ctx.flow_def(source_flow_id).map_err(|e| format!("Quelle {source_flow_id}: {e}"))?;
    let (def, channels) = match check_split_source(&source_def, SAMPLE_RATE, need) {
        Ok(x) => x,
        Err(why) => {
            *shared.mode.lock().expect("lock poisoned") = format!("abgelehnt: {why}");
            return Err(format!("{FORMAT_ERR}Ton-Quelle passt nicht zum Tonteiler ({why})."));
        }
    };
    let outs: Vec<SplitOutput> = config
        .outputs
        .iter()
        .zip(current.iter())
        .map(|((_, flow), o)| SplitOutput { flow_id: flow.clone(), label: format!("{} {}", config.label, o.name), channels: o.channels.clone() })
        .collect();
    let split = RawAudioSplit::start(in_ctx.clone(), out_ctx.clone(), source_flow_id, def, &outs, SAMPLE_RATE, shared.flowed.clone(), wake.clone())
        .map_err(|e| format!("Tonteiler: {e}"))?;
    shared.input_channels.store(channels, Ordering::Relaxed);
    *shared.mode.lock().expect("lock poisoned") = format!("geteilt: {channels} Kanäle → {} Ausgänge", outs.len());
    Ok(split)
}

pub fn run(config: Config, tx: UnboundedSender<Event>, shutdown: Arc<AtomicBool>, ready: oneshot::Sender<Result<PipelineHandle, String>>, heartbeat: Arc<AtomicU64>) {
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
    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let shared = Arc::new(Shared {
        outputs: Mutex::new(config.outputs.iter().map(|(o, _)| o.clone()).collect()),
        flowed: Arc::new(AtomicBool::new(false)),
        mode: Mutex::new(String::new()),
        input_channels: AtomicU32::new(0),
    });
    let _ = ready.send(Ok(PipelineHandle { commands: commands_tx.clone(), shared: shared.clone() }));

    let wake: Arc<dyn Fn() + Send + Sync> = {
        let tx = commands_tx.clone();
        let m = Mutex::new(());
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
                    if w.wait(Some(Duration::from_secs(1))) && tx.send(Command::DomainChanged).is_err() {
                        break;
                    }
                }
            }))
        }
        Err(e) => {
            eprintln!("omp-audio-split: Domain {} nicht beobachtbar ({e}) — später erscheinende Quellen werden nicht automatisch erkannt", config.in_domain);
            None
        }
    };

    let mut split: Option<RawAudioSplit> = None;
    let mut last: Option<String> = None;
    let mut retry = false;
    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Command::Connect(id)) => {
                last = Some(id.clone());
                split = None;
                match connect(&in_ctx, &out_ctx, &id, &config, &shared, &wake) {
                    Ok(s) => {
                        split = Some(s);
                        retry = false;
                    }
                    Err(e) => {
                        retry = !e.starts_with(FORMAT_ERR);
                        let _ = tx.send(Event::Error(e.trim_start_matches(FORMAT_ERR).to_string()));
                    }
                }
            }
            Ok(Command::Disconnect) => {
                split = None;
                last = None;
                retry = false;
                shared.mode.lock().expect("lock poisoned").clear();
            }
            Ok(Command::Remap) => {
                if let Some(s) = &split {
                    let cur = shared.outputs.lock().expect("lock poisoned").clone();
                    for (i, o) in cur.iter().enumerate() {
                        if let Err(e) = s.set_channels(i, o.channels.clone()) {
                            let _ = tx.send(Event::Error(format!("Neuzuordnung „{}“: {e}", o.name)));
                        }
                    }
                }
            }
            Ok(Command::SourceLost) | Ok(Command::DomainChanged) => {
                if split.as_ref().is_some_and(RawAudioSplit::is_dead) {
                    eprintln!("omp-audio-split: Tonquelle liefert nichts mehr — verbinde neu");
                    split = None;
                    shared.flowed.store(false, Ordering::Relaxed);
                    retry = last.is_some();
                }
                if split.is_none() && retry && let Some(id) = last.clone() && let Ok(s) = connect(&in_ctx, &out_ctx, &id, &config, &shared, &wake) {
                    split = Some(s);
                    retry = false;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(split);
    if let Some(w) = watcher {
        let _ = w.join();
    }
}
