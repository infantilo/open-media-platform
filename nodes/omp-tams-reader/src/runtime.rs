//! Lebenszyklus der Wiedergabe (eigener Thread, wie beim Schreiber): bis `play`/`follow` gibt es keine Pipeline; sie
//! entsteht je Wiedergabe neu (frische Pipeline-Uhr, kein Nachlaufen von `videorate` über die Pause hinweg) und wird nach
//! dem Ende oder `stop` abgebaut. Die MXL-Flows der Ausgänge bleiben dem Node (feste IDs, IS-04-Sender).

use crate::lane::{self, Control, Course, GapMode, Sink, Stats};
use crate::plan;
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use omp_mediaio::Output;
use omp_mediaio::mxl::{MxlAudioOutput, MxlContext, MxlVideoOutput};
use omp_mediaio::timebase::tai_now_ns;
use omp_tams::client::Client;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender as TokioUnboundedSender;
use tokio::sync::oneshot;

const COMMAND_POLL: Duration = Duration::from_millis(100);
/// Wie lange nach dem letzten Bild noch gewartet wird, bis abgebaut wird (Ausgabe leert sich).
const DRAIN_AFTER_LAST: Duration = Duration::from_millis(400);
const DRAIN_MAX: Duration = Duration::from_secs(20);

#[derive(Clone)]
pub struct Config {
    pub domain: String,
    pub client: Arc<Client>,
    pub label: String,
    pub video_flow_id: String,
    pub audio_flow_id: String,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub sample_rate: u32,
    pub channels: u32,
    pub gap: GapMode,
    /// Vorlauf zwischen „jetzt“ und dem Erscheinen des Bereichsanfangs (Holen + Dekodieren).
    pub lead_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlayStatus {
    Idle,
    Playing,
    Following,
    Error,
}
impl PlayStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            PlayStatus::Idle => "idle",
            PlayStatus::Playing => "playing",
            PlayStatus::Following => "following",
            PlayStatus::Error => "error",
        }
    }
}

pub enum Event {
    Warning(String),
}

#[derive(Clone, Debug)]
pub enum Request {
    /// Zeitbereich abspielen. `end_ns = None`: ab `start_ns` ohne Ende (läuft in die Gegenwart hinein).
    Play { video: Option<String>, audio: Option<String>, start_ns: i128, end_ns: Option<i128> },
    /// Zeitverschoben mitlaufen: Ausgabe liegt `delay_ns` hinter der Aufnahme.
    Follow { video: Option<String>, audio: Option<String>, delay_ns: i128 },
}

enum Command {
    Start(Request, Sender<Result<(), String>>),
    Stop(Sender<Result<(), String>>),
}

#[derive(Clone)]
pub struct Handle {
    commands: Sender<Command>,
    status: Arc<Mutex<PlayStatus>>,
    stats: Arc<Mutex<Arc<Stats>>>,
}

impl Handle {
    pub fn start(&self, req: Request) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.commands.send(Command::Start(req, tx)).map_err(|_| "Wiedergabe-Thread beendet".to_string())?;
        rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "Zeitüberschreitung beim Starten".to_string())?
    }
    pub fn stop(&self) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.commands.send(Command::Stop(tx)).map_err(|_| "Wiedergabe-Thread beendet".to_string())?;
        rx.recv_timeout(Duration::from_secs(30)).map_err(|_| "Zeitüberschreitung beim Stoppen".to_string())?
    }
    pub fn status(&self) -> PlayStatus {
        *self.status.lock().expect("lock poisoned")
    }
    /// Zähler der laufenden bzw. zuletzt gelaufenen Wiedergabe.
    pub fn stats(&self) -> Arc<Stats> {
        self.stats.lock().expect("lock poisoned").clone()
    }
    /// Es ist mindestens ein Bild bzw. Block ausgegeben worden.
    pub fn media_ready(&self) -> bool {
        let s = self.stats();
        s.frames_out.load(Ordering::Relaxed) > 0 || s.blocks_out.load(Ordering::Relaxed) > 0
    }
}

struct Active {
    pipeline: gst::Pipeline,
    ctl: Arc<Control>,
    stats: Arc<Stats>,
    threads: Vec<JoinHandle<()>>,
    srcs: Vec<gst_app::AppSrc>,
    lanes: usize,
    follow: bool,
    draining_since: Option<Instant>,
    _video: Option<MxlVideoOutput>,
    _audio: Option<MxlAudioOutput>,
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory).build().map_err(|e| format!("{factory}: {e}"))
}

fn live_src(max_bytes: u64) -> gst_app::AppSrc {
    let src = gst_app::AppSrc::builder().build();
    src.set_format(gst::Format::Time);
    src.set_is_live(true);
    src.set_block(true);
    src.set_do_timestamp(false);
    src.set_max_bytes(max_bytes);
    src
}

fn build(ctx: &Arc<MxlContext>, cfg: &Config, req: Request) -> Result<Active, String> {
    let (video, audio, course, shift_ns, follow) = match req {
        Request::Play { video, audio, start_ns, end_ns } => {
            let lead = cfg.lead_ms as i128 * 1_000_000;
            (video, audio, Course { start_ns, end_ns }, plan::play_shift(start_ns, tai_now_ns(), lead), false)
        }
        Request::Follow { video, audio, delay_ns } => (video, audio, Course { start_ns: plan::follow_start(tai_now_ns(), delay_ns), end_ns: None }, delay_ns, true),
    };
    if video.is_none() && audio.is_none() {
        return Err("weder Video- noch Ton-Flow angegeben".into());
    }
    let pipeline = gst::Pipeline::new();
    let ctl = Arc::new(Control { stop: AtomicBool::new(false) });
    let stats = Arc::new(Stats::default());
    let mut srcs = Vec::new();
    let mut plans: Vec<(bool, String, gst_app::AppSrc)> = Vec::new();
    let (mut vout, mut aout) = (None, None);

    if let Some(flow) = video {
        let src = live_src((cfg.width as u64 * cfg.height as u64 * 3 / 2 * 6).max(3 << 20));
        let ident = make("identity")?;
        ident.set_property("sync", true);
        pipeline.add_many([src.upcast_ref::<gst::Element>(), &ident]).map_err(|e| format!("Elemente: {e}"))?;
        src.link(&ident).map_err(|e| format!("verbinden: {e}"))?;
        let out = MxlVideoOutput::new(&pipeline, &ident, ctx.clone(), &cfg.video_flow_id, &cfg.label, cfg.width, cfg.height, cfg.fps_num, cfg.fps_den, Arc::new(AtomicU64::new(0)))?;
        out.set_active(true);
        vout = Some(out);
        srcs.push(src.clone());
        plans.push((true, flow, src));
    }
    if let Some(flow) = audio {
        let src = live_src(1 << 20);
        let ident = make("identity")?;
        ident.set_property("sync", true);
        pipeline.add_many([src.upcast_ref::<gst::Element>(), &ident]).map_err(|e| format!("Elemente: {e}"))?;
        src.link(&ident).map_err(|e| format!("verbinden: {e}"))?;
        let out = MxlAudioOutput::new(&pipeline, &ident, ctx.clone(), &cfg.audio_flow_id, &cfg.label, cfg.sample_rate, cfg.channels)?;
        out.set_active(true);
        aout = Some(out);
        srcs.push(src.clone());
        plans.push((false, flow, src));
    }
    pipeline.set_state(gst::State::Playing).map_err(|e| format!("Pipeline starten: {e}"))?;

    let lanes = plans.len();
    let mut threads = Vec::new();
    for (is_video, flow, src) in plans {
        let (tx, rx) = sync_channel(2);
        let (c, ctl2, st2, fl) = (cfg.client.clone(), ctl.clone(), stats.clone(), flow);
        threads.push(std::thread::spawn(move || lane::fetch_loop(&c, &fl, course, &tx, &ctl2, &st2)));
        let sink = Sink { pipeline: pipeline.clone(), src, shift_ns, course, ctl: ctl.clone(), stats: stats.clone() };
        let c = cfg.clone();
        threads.push(std::thread::spawn(move || {
            if is_video {
                lane::play_video(&sink, rx, plan::period_ns(c.fps_num, c.fps_den), c.gap)
            } else {
                lane::play_audio(&sink, rx, c.sample_rate, c.channels)
            }
        }));
    }
    Ok(Active { pipeline, ctl, stats, threads, srcs, lanes, follow, draining_since: None, _video: vout, _audio: aout })
}

fn teardown(a: Active) {
    a.ctl.stop.store(true, Ordering::Relaxed);
    // erst die Pipeline anhalten: das löst einen im `appsrc` wartenden Schreiber
    let _ = a.pipeline.set_state(gst::State::Null);
    for t in a.threads {
        let _ = t.join();
    }
}

/// Läuft auf einem eigenen Thread.
pub fn run(config: Config, tx: TokioUnboundedSender<Event>, shutdown: Arc<AtomicBool>, ready: oneshot::Sender<Result<Handle, String>>, heartbeat: Arc<AtomicU64>) {
    if let Err(e) = gst::init() {
        let _ = ready.send(Err(format!("gst init: {e}")));
        return;
    }
    let ctx = match MxlContext::new(&config.domain) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let (commands_tx, commands_rx): (Sender<Command>, Receiver<Command>) = std::sync::mpsc::channel();
    let status = Arc::new(Mutex::new(PlayStatus::Idle));
    let stats = Arc::new(Mutex::new(Arc::new(Stats::default())));
    let _ = ready.send(Ok(Handle { commands: commands_tx, status: status.clone(), stats: stats.clone() }));

    let mut active: Option<Active> = None;
    let mut reported_errors = 0u64;
    loop {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        if let Some(a) = active.as_mut() {
            let n = a.stats.errors.load(Ordering::Relaxed);
            if n != reported_errors {
                reported_errors = n;
                let _ = tx.send(Event::Warning(a.stats.last_error.lock().expect("lock poisoned").clone()));
            }
            if let Some(bus) = a.pipeline.bus()
                && let Some(m) = bus.pop_filtered(&[gst::MessageType::Error])
                && let gst::MessageView::Error(e) = m.view()
            {
                let msg = format!("Pipeline-Fehler: {} ({})", e.error(), e.debug().unwrap_or_default());
                let _ = tx.send(Event::Warning(msg));
                teardown(active.take().expect("active"));
                *status.lock().expect("lock poisoned") = PlayStatus::Error;
            }
        }
        // natürliches Ende: alle Spuren fertig, dann kurz warten, bis die Ausgabe sich geleert hat
        if let Some(a) = active.as_mut()
            && a.stats.lanes_done.load(Ordering::Relaxed) >= a.lanes
        {
            let since = *a.draining_since.get_or_insert_with(Instant::now);
            let last = a.stats.last_tai.load(Ordering::Relaxed);
            let out_done = last == 0 || tai_now_ns() >= last.saturating_add(DRAIN_AFTER_LAST.as_nanos() as u64);
            if out_done || since.elapsed() > DRAIN_MAX {
                for s in &a.srcs {
                    let _ = s.end_of_stream();
                }
                teardown(active.take().expect("active"));
                *status.lock().expect("lock poisoned") = PlayStatus::Idle;
            }
        }
        match commands_rx.recv_timeout(COMMAND_POLL) {
            Ok(Command::Start(req, reply)) => {
                let r = if active.is_some() {
                    Err("Wiedergabe läuft bereits — erst tams.stop".to_string())
                } else {
                    *stats.lock().expect("lock poisoned") = Arc::new(Stats::default());
                    reported_errors = 0;
                    build(&ctx, &config, req).map(|a| {
                        *stats.lock().expect("lock poisoned") = a.stats.clone();
                        *status.lock().expect("lock poisoned") = if a.follow { PlayStatus::Following } else { PlayStatus::Playing };
                        active = Some(a);
                    })
                };
                if let Err(e) = &r {
                    *status.lock().expect("lock poisoned") = PlayStatus::Error;
                    let _ = tx.send(Event::Warning(format!("Start: {e}")));
                }
                let _ = reply.send(r);
            }
            Ok(Command::Stop(reply)) => {
                let r = match active.take() {
                    Some(a) => {
                        teardown(a);
                        *status.lock().expect("lock poisoned") = PlayStatus::Idle;
                        Ok(())
                    }
                    None => Err("keine Wiedergabe aktiv".to_string()),
                };
                let _ = reply.send(r);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    if let Some(a) = active.take() {
        teardown(a);
    }
}
