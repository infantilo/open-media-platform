//! GStreamer-Pipeline von `omp-audio-mixer` (`UMSETZUNG.md` C11,
//! `ARCHITECTURE.md` §13.2).
//!
//! **Kanal-Audioquelle: intern per Default, extern per MXL wählbar
//! (2026-07-11 nachgezogen).** Jeder neu angelegte Kanal startet mit
//! einem internen `audiotestsrc`-Testton (unterschiedliche Frequenz je
//! Kanal, Software-Testmittel-Linie, `UMSETZUNG.md` §0 Punkt 7) — zum
//! Zeitpunkt des ursprünglichen C11-Minimalausbaus gab es noch keinen
//! MXL-Audio-erzeugenden Node im System (`omp-source`, C5, ist reines
//! Video), ein extern wählbarer Eingang wäre ein Henne-Ei-Problem
//! gewesen (`docs/decisions.md` 2026-07-11). Inzwischen kann derselbe
//! Node selbst als Quelle dienen (sein `MxlAudioOutput`-Sender ist über
//! IS-04 discoverbar) — `channel.<id>.setSource` schaltet einen Kanal
//! deshalb auf einen per Discovery gefundenen externen MXL-Audio-Sender
//! um (`omp_mediaio::mxl::MxlAudioInput`, neu) oder zurück auf den
//! internen Testton (`senderId=""`). Der **Ausgang** war von Anfang an
//! ein echter MXL-Audio-Flow (`omp_mediaio::mxl::MxlAudioOutput`).
//!
//! **Dynamische Kanalzahl ohne Pipeline-Rebuild:** anders als
//! `omp-switcher`/`omp-video-mixer-me` (C7/C10, dort zwingt eine
//! *externe* Quellenmenge-Änderung einen Neuaufbau, weil `MxlVideoInput`
//! ohnehin bei jedem discovery-Tick neu bewertet wird) baut `addChannel`/
//! `removeChannel` hier nur den betroffenen Zweig dynamisch an die schon
//! laufende Pipeline an/ab (`GstAggregator`-Sink-Pads — hier
//! `audiomixer.sink_%u` — unterstützen Request/Release im Zustand
//! PLAYING, `gst-inspect-1.0 audiomixer`: `Availability: On request`,
//! kein Parse-Zeit-Vorbehalt wie beim Compositor-Pad-Property-Fall in
//! C10). Das ist exakt die in §13.2 geforderte „Kanalzahl als
//! Laufzeit-Eigenschaft, keine Neustart-/Konfigurationsfrage".
//!
//! **Gain/Mute als Pad-Property, EQ als eigenes Element:** wie in C10
//! (`gst-inspect-1.0 audiomixer`: Sink-Pads haben `volume`/`mute` als
//! `controllable`-Properties) — kein separates `volume`-Element pro
//! Kanal nötig. 3-Band-EQ ist dagegen ein eigener Filter
//! (`equalizer-3bands`, `band0`/`band1`/`band2` = Low/Mid/High in dB),
//! den es als Pad-Property nicht gibt.
//!
//! **Standardklassen geprüft, nicht angenommen (`UMSETZUNG.md` §0 Punkt
//! 6, 2026-07-11 am MS-05-02-Quellrepo verifiziert):** der komplette
//! MS-05-02-Kernklassenbaum (`github.com/AMWA-TV/ms-05-02`,
//! `models/classes/*.json`) umfasst nur sechs Klassen — `NcObject`,
//! `NcBlock`, `NcWorker`, `NcManager`, `NcDeviceManager`,
//! `NcClassManager` — keine `NcGain`/`NcMute`/EQ-Klasse. Die in
//! `ARCHITECTURE.md` §11.1/§13.2 erwähnte AES70/OCA-Analogie bezieht sich
//! auf ein verwandtes, aber separates Standardmodell, nicht auf im
//! MS-05-02-Kern tatsächlich vorhandene Klassen; MS-05-03 (das
//! vorgesehene Blockspec-Folgedokument) ist weiterhin „Work In Progress"
//! ohne veröffentlichte Audio-Blockspecs (bereits für C10 verifiziert).
//! Eigene `gain`/`mute`/`eq*`-Properties pro Kanal sind damit nach §11.1
//! Punkt 3 korrekt, kein Standard wird dupliziert.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioInput, MxlAudioOutput, MxlContext};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub const SAMPLE_RATE: u32 = 48000;
pub const CHANNELS: u32 = 2;

pub struct Config {
    pub domain: String,
    pub flow_id: String,
    pub label: String,
}

pub enum Event {
    Error(String),
}

/// Woher ein Kanal sein Audio bezieht — `Internal` (Testton) oder
/// `External` (echter MXL-Audio-Flow, per `flow_id` adressiert; die
/// Sender→Flow-Auflösung passiert vorher in `main.rs`, hier ist nur noch
/// die fertige `flow_id` bekannt).
#[derive(Clone)]
pub enum ChannelSource {
    Internal { freq: f64 },
    External { flow_id: String },
}

enum Command {
    AddChannel { id: String, source: ChannelSource },
    RemoveChannel(String),
    SetChannelSource { id: String, source: ChannelSource },
    SetGain { id: String, db: f64 },
    SetMute { id: String, muted: bool },
    SetEq { id: String, low: f64, mid: f64, high: f64 },
}

#[derive(Clone)]
pub struct PipelineHandle {
    commands: Sender<Command>,
}

impl PipelineHandle {
    pub fn add_channel(&self, id: String, source: ChannelSource) {
        let _ = self.commands.send(Command::AddChannel { id, source });
    }

    pub fn remove_channel(&self, id: String) {
        let _ = self.commands.send(Command::RemoveChannel(id));
    }

    pub fn set_channel_source(&self, id: String, source: ChannelSource) {
        let _ = self
            .commands
            .send(Command::SetChannelSource { id, source });
    }

    pub fn set_gain(&self, id: String, db: f64) {
        let _ = self.commands.send(Command::SetGain { id, db });
    }

    pub fn set_mute(&self, id: String, muted: bool) {
        let _ = self.commands.send(Command::SetMute { id, muted });
    }

    pub fn set_eq(&self, id: String, low: f64, mid: f64, high: f64) {
        let _ = self
            .commands
            .send(Command::SetEq { id, low, mid, high });
    }
}

/// dB → lineares `volume`-Pad-Property (0 dB = 1.0), Standardformel.
fn db_to_linear(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

struct ChannelBranch {
    /// Alle Elemente dieses Zweigs, in Verkettungsreihenfolge (Quelle …
    /// `eq`) — für sauberes chirurgisches Entfernen (`remove_channel_
    /// branch`) statt der früheren Peer-Pad-Suche, die nur für den
    /// Testton-Fall funktionierte. Bei externer Quelle stammen die
    /// vorderen Elemente aus `MxlAudioInput::elements`.
    elements: Vec<gst::Element>,
    eq: gst::Element,
    mixer_pad: gst::Pad,
    /// Hält den Lese-Thread einer externen Quelle am Leben (`Drop`
    /// stoppt ihn) — `None` beim internen Testton.
    _external_input: Option<MxlAudioInput>,
}

struct ActivePipeline {
    pipeline: gst::Pipeline,
    mixer: gst::Element,
    channels: HashMap<String, ChannelBranch>,
    _mxl_output: MxlAudioOutput,
}

impl Drop for ActivePipeline {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn add_channel_branch(
    active: &mut ActivePipeline,
    context: &Arc<MxlContext>,
    id: &str,
    source: &ChannelSource,
) -> Result<(), String> {
    if active.channels.contains_key(id) {
        return Ok(());
    }

    // `tail` = letztes Element der Quelle (verlinkt gleich auf `convert`),
    // `elements` sammelt alles, was dieser Zweig selbst zur Pipeline
    // hinzugefügt hat (für `remove_channel_branch`) — bei externer Quelle
    // bereits von `MxlAudioInput::new` zur Pipeline hinzugefügt, hier nur
    // übernommen, nicht erneut `pipeline.add()`.
    let (tail, mut elements, external_input) = match source {
        ChannelSource::Internal { freq } => {
            let src = gst::ElementFactory::make("audiotestsrc")
                .property("is-live", true)
                .property("freq", *freq)
                .property("volume", 0.3f64)
                .build()
                .map_err(|e| format!("audiotestsrc ({id}): {e}"))?;
            src.set_property_from_str("wave", "sine");
            active
                .pipeline
                .add(&src)
                .map_err(|e| format!("add audiotestsrc ({id}): {e}"))?;
            (src.clone(), vec![src], None)
        }
        ChannelSource::External { flow_id } => {
            let input = MxlAudioInput::new(&active.pipeline, context.clone(), flow_id)
                .map_err(|e| format!("MxlAudioInput ({id}, flow {flow_id}): {e}"))?;
            (input.tail.clone(), input.elements.clone(), Some(input))
        }
    };

    let convert = gst::ElementFactory::make("audioconvert")
        .build()
        .map_err(|e| format!("audioconvert ({id}): {e}"))?;
    let eq = gst::ElementFactory::make("equalizer-3bands")
        .name(format!("eq-{id}"))
        .build()
        .map_err(|e| format!("equalizer-3bands ({id}): {e}"))?;

    active
        .pipeline
        .add(&convert)
        .and_then(|()| active.pipeline.add(&eq))
        .map_err(|e| format!("add channel elements ({id}): {e}"))?;
    gst::Element::link_many([&tail, &convert, &eq])
        .map_err(|e| format!("link channel chain ({id}): {e}"))?;
    elements.push(convert);

    let mixer_pad = active
        .mixer
        .request_pad_simple("sink_%u")
        .ok_or_else(|| format!("audiomixer: request sink pad failed ({id})"))?;
    eq.static_pad("src")
        .ok_or("equalizer: no src pad")?
        .link(&mixer_pad)
        .map_err(|e| format!("link eq to mixer ({id}): {e}"))?;

    // Neue Elemente in einer bereits laufenden (PLAYING) Pipeline müssen
    // ihren Zustand explizit an den Elternzustand angleichen — sonst
    // bleiben sie in NULL/READY hängen und liefern nie Daten.
    for el in elements.iter().chain(std::iter::once(&eq)) {
        el.sync_state_with_parent()
            .map_err(|e| format!("sync_state_with_parent ({id}): {e}"))?;
    }

    elements.push(eq.clone());
    active.channels.insert(
        id.to_string(),
        ChannelBranch {
            elements,
            eq,
            mixer_pad,
            _external_input: external_input,
        },
    );
    Ok(())
}

fn remove_channel_branch(active: &mut ActivePipeline, id: &str) {
    let Some(branch) = active.channels.remove(id) else {
        return;
    };
    // Reihenfolge: erst den Mixer-Pad freigeben (stoppt den Datenfluss in
    // den Mixer sauber), dann jedes Zweig-Element auf NULL setzen und aus
    // der Pipeline entfernen — Gegenrichtung des Aufbaus in
    // `add_channel_branch`. `_external_input` wird beim Drop von `branch`
    // am Ende dieser Funktion automatisch verworfen, was den Lese-Thread
    // stoppt (aber nicht dessen Pipeline-Elemente entfernt — die stehen
    // bereits in `elements` und werden hier explizit aufgeräumt).
    active.mixer.release_request_pad(&branch.mixer_pad);
    for el in &branch.elements {
        let _ = el.set_state(gst::State::Null);
        let _ = active.pipeline.remove(el);
    }
}

fn build(context: &Arc<MxlContext>, config: &Config) -> Result<ActivePipeline, String> {
    let pipeline = gst::Pipeline::new();

    let mixer = gst::ElementFactory::make("audiomixer")
        .name("mixer")
        .build()
        .map_err(|e| format!("audiomixer: {e}"))?;
    pipeline
        .add(&mixer)
        .map_err(|e| format!("add audiomixer: {e}"))?;

    let mxl_output = MxlAudioOutput::new(
        &pipeline,
        &mixer,
        context.clone(),
        &config.flow_id,
        &config.label,
        SAMPLE_RATE,
        CHANNELS,
    )
    .map_err(|e| format!("MxlAudioOutput: {e}"))?;
    mxl_output.set_active(true);

    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| format!("set state playing: {e}"))?;

    Ok(ActivePipeline {
        pipeline,
        mixer,
        channels: HashMap::new(),
        _mxl_output: mxl_output,
    })
}

/// Läuft auf einem eigenen Thread (analog `omp-switcher`/
/// `omp-video-mixer-me`s `pipeline::run`) — anders als dort **ein**
/// dauerhafter `build()`-Aufruf, kein Rebuild-auf-Kommando-Pfad (s.
/// Moduldoku): Kanäle werden dynamisch an die laufende Pipeline an-/
/// abgebaut.
pub fn run(
    config: Config,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    ready: oneshot::Sender<Result<PipelineHandle, String>>,
) {
    if let Err(e) = gst::init() {
        let msg = format!("gst init failed: {e}");
        let _ = tx.send(Event::Error(msg.clone()));
        let _ = ready.send(Err(msg));
        return;
    }

    let context = match MxlContext::new(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = tx.send(Event::Error(e.clone()));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let mut active = match build(&context, &config) {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("initial build failed: {e}")));
            let _ = ready.send(Err(e));
            return;
        }
    };

    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) =
        std::sync::mpsc::channel();
    let _ = ready.send(Ok(PipelineHandle {
        commands: commands_tx,
    }));

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match commands_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Command::AddChannel { id, source }) => {
                if let Err(e) = add_channel_branch(&mut active, &context, &id, &source) {
                    let _ = tx.send(Event::Error(format!("addChannel({id}) failed: {e}")));
                }
            }
            Ok(Command::RemoveChannel(id)) => {
                remove_channel_branch(&mut active, &id);
            }
            Ok(Command::SetChannelSource { id, source }) => {
                // Nur ersetzen, wenn der Kanal (noch) existiert — ein
                // `removeChannel` kurz zuvor darf hier keinen neuen Zweig
                // ohne zugehörigen Kanal-Zustand in `main.rs` entstehen
                // lassen.
                if active.channels.contains_key(&id) {
                    remove_channel_branch(&mut active, &id);
                    if let Err(e) = add_channel_branch(&mut active, &context, &id, &source) {
                        let _ = tx.send(Event::Error(format!("setSource({id}) failed: {e}")));
                    }
                }
            }
            Ok(Command::SetGain { id, db }) => {
                if let Some(branch) = active.channels.get(&id) {
                    branch.mixer_pad.set_property("volume", db_to_linear(db));
                }
            }
            Ok(Command::SetMute { id, muted }) => {
                if let Some(branch) = active.channels.get(&id) {
                    branch.mixer_pad.set_property("mute", muted);
                }
            }
            Ok(Command::SetEq { id, low, mid, high }) => {
                if let Some(branch) = active.channels.get(&id) {
                    branch.eq.set_property("band0", low);
                    branch.eq.set_property("band1", mid);
                    branch.eq.set_property("band2", high);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    drop(active);
}
