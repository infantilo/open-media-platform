//! GStreamer-Pipeline des Playout-Node — Playlist-getriebene Datei-
//! Wiedergabe (`UMSETZUNG.md` C4) über zwei alternierende "Slots"
//! (`uridecodebin` je Slot) plus je einen `input-selector` (Video/Audio),
//! die entscheiden, welcher Slot gerade auf Sendung ist ("Selector-
//! Pattern", wie in C4 gefordert). Beide Slots bestehen für die gesamte
//! Prozesslaufzeit; ein `take()` lädt die neue URI in den *inaktiven*
//! Slot (Zustandswechsel NULL→PLAYING dieses einen `uridecodebin`s) und
//! schaltet danach den Selector um — die nachgelagerte Kette (Tee,
//! FPS-Zweig, RTP-Ausgang aus C2/C3) bleibt davon komplett unberührt.
//! Bewusste v0-Vereinfachung (siehe docs/decisions.md): der Ziel-Slot
//! wird erst *bei* `take()` geladen, nicht schon während der vorherige
//! Clip noch läuft — ein Vorab-Puffern für einen wirklich lückenlosen
//! Schnitt ist ein späterer Hardening-Schritt, kein v0-Anspruch.
//!
//! Läuft weiterhin auf einem eigenen `std::thread` (siehe C2/C3): Bus-
//! Polling ist blockierend, das soll die async SDK-Schleife nicht stören.
//! Ein `std::sync::mpsc`-Kanal führt jetzt zusätzlich in die *andere*
//! Richtung (Kommandos vom async Haupt-Task in den Pipeline-Thread).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Receiver as StdReceiver;
use std::time::Duration;

use gst::prelude::*;
use gstreamer as gst;
use omp_mediaio::rtp::RtpVideoOutput;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

/// Feste Zwischenformat-Caps, auf die *beide* Slots ihr Video normalisieren,
/// bevor sie den Selector erreichen — unabhängig vom nativen Format/
/// Auflösung der jeweiligen Quelldatei. Ohne das könnte ein Slot-Wechsel
/// die Caps-Verhandlung der nachgelagerten Kette brechen (siehe die
/// videoscale-Lehre aus C3, docs/decisions.md).
const VIDEO_WIDTH: i32 = 640;
const VIDEO_HEIGHT: i32 = 480;

pub struct Config {
    pub framerate_numerator: i32,
    pub framerate_denominator: i32,
    pub initial_destination_host: String,
    pub initial_destination_port: u16,
}

/// Ereignis, das der Pipeline-Thread an den async Node-Lifecycle meldet.
pub enum Event {
    /// Über das letzte Poll-Intervall gemessene Video-Bildrate (Buffer/s
    /// am Video-Fakesink, C2, unverändert).
    Fps(f64),
    /// Abspielposition des aktuell auf Sendung befindlichen Clips
    /// (Sekunden seit dessen Start).
    PlayheadPosition(f64),
    /// Der auf Sendung befindliche Clip hat sein Ende erreicht (EOS) —
    /// der Aufrufer entscheidet per `Playlist::advance()`, was als
    /// Nächstes läuft.
    ClipEnded,
    /// Ein Pipeline-Fehler (Konstruktion, Bus-ERROR-Message, z. B. eine
    /// nicht ladbare Datei) — wird als NATS-Alarm veröffentlicht.
    Error(String),
}

/// Kommando vom async Haupt-Task an den Pipeline-Thread.
pub enum Command {
    /// Lädt `uri` in den inaktiven Slot und schaltet danach den Selector
    /// um — die konkrete Umsetzung von `Playlist::take()`/`advance()`.
    PlayUri(String),
}

struct PipelineError(String);

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Ein alternierender Wiedergabe-Slot: ein `uridecodebin` plus feste
/// Konverter-Ketten für Video/Audio, deren Ausgänge dauerhaft an je einen
/// Selector-Sink-Pad angeschlossen sind.
struct Slot {
    uridecodebin: gst::Element,
    selector_video_pad: gst::Pad,
}

impl Slot {
    #[allow(clippy::too_many_arguments)]
    fn build(
        pipeline: &gst::Pipeline,
        index: usize,
        video_selector: &gst::Element,
        audio_selector: &gst::Element,
        video_caps: &gst::Caps,
        audio_caps: &gst::Caps,
    ) -> Result<Self, PipelineError> {
        let uridecodebin = gst::ElementFactory::make("uridecodebin")
            .name(format!("slot{index}_decode"))
            .build()
            .map_err(|e| PipelineError(format!("uridecodebin (slot {index}): {e}")))?;
        // Ohne gesetzte "uri" kann uridecodebin nicht auf PLAYING wechseln
        // (kein gültiger Quellort) — locked_state hält es in NULL, egal
        // was mit der übergeordneten Pipeline passiert, bis `play_uri()`
        // es beim ersten geladenen Clip entsperrt. Sonst würde schon der
        // initiale `pipeline.set_state(Playing)` fehlschlagen, solange
        // die Playlist noch leer ist.
        uridecodebin.set_locked_state(true);

        let video_convert = gst::ElementFactory::make("videoconvert")
            .build()
            .map_err(|e| PipelineError(format!("videoconvert (slot {index}): {e}")))?;
        let video_scale = gst::ElementFactory::make("videoscale")
            .build()
            .map_err(|e| PipelineError(format!("videoscale (slot {index}): {e}")))?;
        let video_capsfilter = gst::ElementFactory::make("capsfilter")
            .property("caps", video_caps)
            .build()
            .map_err(|e| PipelineError(format!("video capsfilter (slot {index}): {e}")))?;

        let audio_convert = gst::ElementFactory::make("audioconvert")
            .build()
            .map_err(|e| PipelineError(format!("audioconvert (slot {index}): {e}")))?;
        let audio_resample = gst::ElementFactory::make("audioresample")
            .build()
            .map_err(|e| PipelineError(format!("audioresample (slot {index}): {e}")))?;
        let audio_capsfilter = gst::ElementFactory::make("capsfilter")
            .property("caps", audio_caps)
            .build()
            .map_err(|e| PipelineError(format!("audio capsfilter (slot {index}): {e}")))?;

        pipeline
            .add(&uridecodebin)
            .and_then(|()| pipeline.add(&video_convert))
            .and_then(|()| pipeline.add(&video_scale))
            .and_then(|()| pipeline.add(&video_capsfilter))
            .and_then(|()| pipeline.add(&audio_convert))
            .and_then(|()| pipeline.add(&audio_resample))
            .and_then(|()| pipeline.add(&audio_capsfilter))
            .map_err(|e| PipelineError(format!("add slot {index} elements: {e}")))?;

        gst::Element::link_many([&video_convert, &video_scale, &video_capsfilter])
            .map_err(|e| PipelineError(format!("link slot {index} video chain: {e}")))?;
        gst::Element::link_many([&audio_convert, &audio_resample, &audio_capsfilter])
            .map_err(|e| PipelineError(format!("link slot {index} audio chain: {e}")))?;

        let selector_video_pad = video_selector
            .request_pad_simple("sink_%u")
            .ok_or_else(|| {
                PipelineError(format!("video selector: no free sink pad (slot {index})"))
            })?;
        let video_capsfilter_src = video_capsfilter
            .static_pad("src")
            .expect("capsfilter has a src pad");
        video_capsfilter_src.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            eprintln!("playout: slot {index}: buffer reached selector input");
            gst::PadProbeReturn::Ok
        });
        video_capsfilter_src
            .link(&selector_video_pad)
            .map_err(|e| PipelineError(format!("link slot {index} video to selector: {e:?}")))?;

        let selector_audio_pad = audio_selector
            .request_pad_simple("sink_%u")
            .ok_or_else(|| {
                PipelineError(format!("audio selector: no free sink pad (slot {index})"))
            })?;
        let audio_capsfilter_src = audio_capsfilter
            .static_pad("src")
            .expect("capsfilter has a src pad");
        audio_capsfilter_src
            .link(&selector_audio_pad)
            .map_err(|e| PipelineError(format!("link slot {index} audio to selector: {e:?}")))?;

        let video_sink_pad = video_convert
            .static_pad("sink")
            .expect("videoconvert has a sink pad");
        let audio_sink_pad = audio_convert
            .static_pad("sink")
            .expect("audioconvert has a sink pad");
        uridecodebin.connect_pad_added(move |_element, pad| {
            let caps = pad.current_caps().or_else(|| Some(pad.query_caps(None)));
            eprintln!("playout: slot {index}: pad-added, caps = {caps:?}");
            let is_video = caps.as_ref().is_some_and(|caps| {
                caps.structure(0)
                    .is_some_and(|s| s.name().starts_with("video/"))
            });
            let target = if is_video {
                &video_sink_pad
            } else {
                &audio_sink_pad
            };
            if target.is_linked() {
                eprintln!("playout: slot {index}: target already linked, skipping");
                return;
            }
            match pad.link(target) {
                Ok(_) => eprintln!("playout: slot {index}: linked {} pad ok", if is_video { "video" } else { "audio" }),
                Err(e) => eprintln!("playout: slot {index}: failed to link decoded pad: {e:?}"),
            }
        });

        Ok(Slot {
            uridecodebin,
            selector_video_pad,
        })
    }

    /// Setzt den Slot auf NULL (verwirft alte Pads), lädt `uri` und
    /// startet die Wiedergabe wieder.
    fn play_uri(&self, uri: &str) -> Result<(), PipelineError> {
        // Ab dem ersten geladenen Clip soll der Slot parent-getriebenen
        // Zustandswechseln wieder folgen (z. B. dem `pipeline.set_state
        // (Null)` beim Shutdown) — sonst bliebe ein entsperrter Slot beim
        // Beenden hängen.
        self.uridecodebin.set_locked_state(false);
        self.uridecodebin
            .set_state(gst::State::Null)
            .map_err(|e| PipelineError(format!("slot reset: {e}")))?;
        self.uridecodebin.set_property("uri", uri);
        // `sync_state_with_parent()` statt eines direkten `set_state
        // (Playing)`: nur so übernimmt das Element Clock/Base-Time der
        // bereits laufenden Pipeline korrekt. Ein direkter `set_state`-Ruf
        // auf einem Kind-Element, das mitten im Betrieb (wieder)
        // dazukommt, lässt dessen Buffer-Timestamps sonst gegen die
        // falsche Referenz laufen — sync=true-Sinks warten dann
        // (scheinbar für immer) auf einen "richtigen" Zeitpunkt, der so
        // nie kommt. Genau das war die Ursache für den Total-Stillstand
        // nach ein paar Frames, den ein erster Testlauf zeigte (siehe
        // docs/decisions.md).
        self.uridecodebin
            .sync_state_with_parent()
            .map_err(|e| PipelineError(format!("slot play '{uri}': {e}")))?;
        Ok(())
    }
}

struct Pipeline {
    pipeline: gst::Pipeline,
    slots: [Slot; 2],
    active_slot: usize,
    video_selector: gst::Element,
    video_buffers: Arc<AtomicU64>,
    clip_ended: Arc<AtomicBool>,
    rtp_output: Arc<RtpVideoOutput>,
}

impl Pipeline {
    fn build(config: &Config) -> Result<Self, PipelineError> {
        gst::init().map_err(|e| PipelineError(format!("gst init failed: {e}")))?;

        let pipeline = gst::Pipeline::new();

        // sync-streams=false: der Default versucht, inaktive Streams auf
        // die Running-Time des aktiven Streams/der Clock zu synchronisieren
        // — unnötig und kontraproduktiv für unser Ping-Pong-Muster (ein
        // Slot startet immer frisch bei ~0, der andere ist entweder aktiv
        // oder komplett still/NULL, nie "inaktiv, aber woanders synchron").
        let video_selector = gst::ElementFactory::make("input-selector")
            .name("video_selector")
            .property("sync-streams", false)
            .build()
            .map_err(|e| PipelineError(format!("input-selector (video): {e}")))?;
        let audio_selector = gst::ElementFactory::make("input-selector")
            .name("audio_selector")
            .property("sync-streams", false)
            .build()
            .map_err(|e| PipelineError(format!("input-selector (audio): {e}")))?;
        pipeline
            .add(&video_selector)
            .and_then(|()| pipeline.add(&audio_selector))
            .map_err(|e| PipelineError(format!("add selectors: {e}")))?;

        let video_caps = gst::Caps::builder("video/x-raw")
            .field("format", "I420")
            .field("width", VIDEO_WIDTH)
            .field("height", VIDEO_HEIGHT)
            .field(
                "framerate",
                gst::Fraction::new(config.framerate_numerator, config.framerate_denominator),
            )
            .build();
        let audio_caps = gst::Caps::builder("audio/x-raw")
            .field("format", "F32LE")
            .field("rate", 48_000)
            .field("channels", 2)
            .build();

        let slot_a = Slot::build(
            &pipeline,
            0,
            &video_selector,
            &audio_selector,
            &video_caps,
            &audio_caps,
        )?;
        let slot_b = Slot::build(
            &pipeline,
            1,
            &video_selector,
            &audio_selector,
            &video_caps,
            &audio_caps,
        )?;
        video_selector.set_property("active-pad", &slot_a.selector_video_pad);

        // Kein "leaky"-Modus: ein erster Versuch mit leaky=downstream löste
        // einen internen GStreamer-Assertion-Crash aus (Refcounting-
        // Konflikt zwischen tee und queue beim gemeinsamen Verwerfen
        // geteilter Buffer, siehe docs/decisions.md) — Standard-Queues,
        // die tatsächliche Ursache lag ohnehin an der Testclip-Dauer.
        let fps_queue = gst::ElementFactory::make("queue")
            .build()
            .map_err(|e| PipelineError(format!("queue: {e}")))?;
        let videosink = gst::ElementFactory::make("fakesink")
            .name("videosink")
            .property("sync", true)
            .build()
            .map_err(|e| PipelineError(format!("fakesink (video): {e}")))?;
        let audiosink = gst::ElementFactory::make("fakesink")
            .name("audiosink")
            .property("sync", true)
            .build()
            .map_err(|e| PipelineError(format!("fakesink (audio): {e}")))?;
        let rtp_queue = gst::ElementFactory::make("queue")
            .build()
            .map_err(|e| PipelineError(format!("queue (rtp): {e}")))?;

        pipeline
            .add(&fps_queue)
            .and_then(|()| pipeline.add(&videosink))
            .and_then(|()| pipeline.add(&audiosink))
            .and_then(|()| pipeline.add(&rtp_queue))
            .map_err(|e| PipelineError(format!("add sink elements: {e}")))?;

        let tee = gst::ElementFactory::make("tee")
            .name("video_tee")
            .build()
            .map_err(|e| PipelineError(format!("tee: {e}")))?;
        pipeline
            .add(&tee)
            .map_err(|e| PipelineError(format!("add tee: {e}")))?;

        gst::Element::link_many([&video_selector, &tee])
            .map_err(|e| PipelineError(format!("link selector to tee: {e}")))?;
        gst::Element::link_many([&tee, &fps_queue, &videosink])
            .map_err(|e| PipelineError(format!("link video fps/health branch: {e}")))?;
        gst::Element::link_many([&tee, &rtp_queue])
            .map_err(|e| PipelineError(format!("link video rtp branch: {e}")))?;
        gst::Element::link_many([&audio_selector, &audiosink])
            .map_err(|e| PipelineError(format!("link audio selector to sink: {e}")))?;

        let rtp_output = Arc::new(
            RtpVideoOutput::new(
                &pipeline,
                &rtp_queue,
                &config.initial_destination_host,
                config.initial_destination_port,
                config.framerate_numerator,
                config.framerate_denominator,
            )
            .map_err(PipelineError)?,
        );

        let video_buffers = Arc::new(AtomicU64::new(0));
        let counter = video_buffers.clone();
        let video_sink_pad = videosink
            .static_pad("sink")
            .expect("fakesink has a sink pad");
        video_sink_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            counter.fetch_add(1, Ordering::Relaxed);
            gst::PadProbeReturn::Ok
        });

        // Der Selector leitet ein EOS des gerade aktiven Slots an seinen
        // (einzigen) Src-Pad weiter — hier abgegriffen, unabhängig davon,
        // welcher Slot gerade aktiv ist.
        let clip_ended = Arc::new(AtomicBool::new(false));
        let clip_ended_flag = clip_ended.clone();
        let selector_src_pad = video_selector
            .static_pad("src")
            .expect("input-selector has a src pad");
        selector_src_pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_pad, info| {
            if let Some(gst::PadProbeData::Event(event)) = &info.data
                && event.type_() == gst::EventType::Eos
            {
                clip_ended_flag.store(true, Ordering::Relaxed);
            }
            gst::PadProbeReturn::Ok
        });
        selector_src_pad.add_probe(gst::PadProbeType::BUFFER, move |_pad, _info| {
            eprintln!("playout: buffer reached selector output");
            gst::PadProbeReturn::Ok
        });

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| PipelineError(format!("set state playing: {e}")))?;

        Ok(Pipeline {
            pipeline,
            slots: [slot_a, slot_b],
            active_slot: 0,
            video_selector,
            video_buffers,
            clip_ended,
            rtp_output,
        })
    }

    /// Verarbeitet Bus-Nachrichten bis `timeout` und liefert eine
    /// Fehlermeldung, falls eine ERROR-Message dabei war. Behandelt
    /// zusätzlich LATENCY-Messages (`pipeline.recalculate_latency()`) —
    /// ohne das bleibt die Pipeline-Latenz nach der Lehre aus C4
    /// (docs/decisions.md) auf dem Stand von der Konstruktion stehen,
    /// sobald ein zuvor gesperrtes Slot-Element mitten im Betrieb aktiv
    /// wird: `gst-launch`s eingebauter Bus-Handler erledigt das
    /// automatisch, ein selbst geschriebener Polling-Loop, der nur auf
    /// ERROR filtert, tut es nicht — die Folge war ein Stillstand nach
    /// wenigen Frames, ohne dass je ein Fehler geworfen wurde.
    fn poll_error(&self, timeout: Duration) -> Option<String> {
        let bus = self.pipeline.bus()?;
        let msg = bus.timed_pop_filtered(
            gst::ClockTime::from_mseconds(timeout.as_millis() as u64),
            &[gst::MessageType::Error, gst::MessageType::Latency],
        )?;
        match msg.view() {
            gst::MessageView::Error(err) => Some(format!(
                "{} ({})",
                err.error(),
                err.debug().unwrap_or_default()
            )),
            gst::MessageView::Latency(_) => {
                let _ = self.pipeline.recalculate_latency();
                None
            }
            _ => None,
        }
    }

    fn take_video_fps(&self) -> f64 {
        self.video_buffers.swap(0, Ordering::Relaxed) as f64
    }

    fn take_clip_ended(&self) -> bool {
        self.clip_ended.swap(false, Ordering::Relaxed)
    }

    /// Position des aktiven Slots in Sekunden, `None` wenn nicht ermittelbar.
    fn playhead_seconds(&self) -> Option<f64> {
        let position = self.slots[self.active_slot]
            .uridecodebin
            .query_position::<gst::ClockTime>()?;
        Some(position.mseconds() as f64 / 1000.0)
    }

    /// Lädt `uri` in den *inaktiven* Slot und schaltet danach den Selector um.
    fn play_uri(&mut self, uri: &str) -> Result<(), PipelineError> {
        let target = 1 - self.active_slot;
        self.slots[target].play_uri(uri)?;
        self.video_selector
            .set_property("active-pad", &self.slots[target].selector_video_pad);
        self.active_slot = target;
        Ok(())
    }

    fn shutdown(&self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// Baut und betreibt die Pipeline bis `shutdown` gesetzt wird oder ein
/// Bus-Fehler auftritt; meldet FPS/Playhead/ClipEnded/Fehler über `tx`,
/// den RTP-Ausgang (oder den Baufehler) einmalig über `ready` (analog zu
/// C3 — der Aufrufer braucht ihn für die IS-05-Sender-Connection) und
/// nimmt `PlayUri`-Kommandos über `commands` entgegen. Für einen eigenen
/// Thread gedacht (siehe Modul-Doku).
pub fn run(
    config: Config,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
    commands: StdReceiver<Command>,
    ready: oneshot::Sender<Result<Arc<RtpVideoOutput>, String>>,
) {
    let mut pipeline = match Pipeline::build(&config) {
        Ok(p) => p,
        Err(e) => {
            let _ = tx.send(Event::Error(e.to_string()));
            let _ = ready.send(Err(e.to_string()));
            return;
        }
    };

    let _ = ready.send(Ok(pipeline.rtp_output.clone()));

    // 200ms Poll-Takt statt der 1s aus C2/C3: `take()`/`cue()` sollen
    // zeitnah wirken, nicht erst nach bis zu einer Sekunde. FPS wird
    // weiterhin nur alle ~1s gemeldet (jede 5. Iteration).
    const POLL_INTERVAL: Duration = Duration::from_millis(200);
    let mut ticks_since_fps_report: u32 = 0;

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }

        if let Ok(Command::PlayUri(uri)) = commands.try_recv()
            && let Err(e) = pipeline.play_uri(&uri)
        {
            let _ = tx.send(Event::Error(e.to_string()));
        }

        if let Some(err) = pipeline.poll_error(POLL_INTERVAL) {
            let _ = tx.send(Event::Error(err));
            break;
        }

        if pipeline.take_clip_ended() {
            let _ = tx.send(Event::ClipEnded);
        }

        if let Some(seconds) = pipeline.playhead_seconds() {
            let _ = tx.send(Event::PlayheadPosition(seconds));
        }

        ticks_since_fps_report += 1;
        if ticks_since_fps_report >= 5 {
            ticks_since_fps_report = 0;
            // take_video_fps() liefert den Buffer-Zähler seit dem letzten
            // Reset — da genau hier alle ~1s (5 × 200ms) zurückgesetzt
            // wird, ist der Rohwert bereits "Buffer pro Sekunde", keine
            // weitere Skalierung nötig.
            let _ = tx.send(Event::Fps(pipeline.take_video_fps()));
        }
    }

    pipeline.shutdown();
}
