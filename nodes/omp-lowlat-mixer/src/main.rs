//! omp-lowlat-mixer — Studio-Mischer mit niedriger Latenz (Kapitel 99): ein schlanker Block-Mischer für Konferenz-, Moderations- und
//! In-Ear-Wege, bei denen 2–15 ms Rundlauf zählen. Eingänge/Ausgänge: ALSA-Soundkarte, AES67-RTP (1 ms), MXL (ohne GStreamer, kleine
//! Blöcke). Misch-Kern: `engine.rs` (rein, getestet); Ringpuffer mit Drift-Regelung: `ring.rs`; RTP: `rtp.rs`/`aes_io.rs`;
//! ALSA: `alsa.rs`; MXL: `mxl_io.rs`. Takt: Soundkarte (wenn eine konfiguriert ist, kleinste Latenz) sonst eigener Zeitgeber.

mod aes_io;
mod alsa;
mod engine;
mod mxl_io;
mod ring;
mod rtp;
mod uibundle;

use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use engine::{Engine, MAX_BUSES, MAX_STRIPS, Shared, Source, StripIn, db_to_lin, lin_to_db};
use omp_mediaio::mxl::MxlContext;
use omp_node_sdk::connection::{ReceiverConnection, ReceiverControl, ReceiverResource, bulk_cors_methods, bulk_discovery, bulk_patch, list_ids, root_discovery};
use omp_node_sdk::is04::{RegistryClient, TRANSPORT_MXL};
use omp_node_sdk::node::FlowSpec;
use omp_node_sdk::{Descriptor, InvokeError, LatencyInfo, LatencyRange, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType, Range, RawResponse, ReceiverSpec, SenderSpec, SetError};
use ring::InRing;
use serde_json::{Value, json};

const RATE: usize = 48_000;
/// Erlaubte Blockgrößen (Rahmen bei 48 kHz): 0,33 / 1 / 2 / 4 / 10 ms. 16 und 48 und 192 sind AES67-Paketzeiten.
const BLOCKS: [usize; 5] = [16, 48, 96, 192, 480];

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn env_num<T: std::str::FromStr>(key: &str, fallback: T) -> T {
    std::env::var(key).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(fallback)
}

#[derive(Clone)]
struct Cfg {
    block: usize,
    strips: usize,
    buses: usize,
    safety_frames: usize,
    max_safety_frames: usize,
    adaptive: bool,
    alsa_in: String,
    alsa_out: String,
    alsa_in_ch: usize,
    alsa_out_ch: usize,
    alsa_periods: usize,
    aes_rx: Option<(Ipv4Addr, u16)>,
    aes_rx_ch: usize,
    aes_rx_fmt: rtp::Format,
    aes_tx: Option<(Ipv4Addr, u16)>,
    aes_tx_ch: usize,
    aes_tx_fmt: rtp::Format,
    aes_iface: Ipv4Addr,
    aes_ttl: u32,
    aes_pt: u8,
    rt_priority: i32,
    spin_us: u64,
}

impl Cfg {
    fn from_env() -> Cfg {
        let block = env_num("OMP_LL_BLOCK", 48usize);
        let block = if BLOCKS.contains(&block) { block } else { 48 };
        let strips = env_num("OMP_LL_STRIPS", 8usize).clamp(1, MAX_STRIPS);
        let buses = env_num("OMP_LL_BUSES", 4usize).clamp(1, MAX_BUSES);
        let ms: f64 = env_num("OMP_LL_INPUT_BUFFER_MS", 1.0f64);
        let max_ms: f64 = env_num("OMP_LL_INPUT_BUFFER_MAX_MS", 20.0f64);
        Cfg {
            block,
            strips,
            buses,
            safety_frames: ((ms.clamp(0.0, 200.0) * RATE as f64 / 1000.0) as usize).max(1),
            max_safety_frames: (max_ms.clamp(1.0, 500.0) * RATE as f64 / 1000.0) as usize,
            adaptive: env_or("OMP_LL_ADAPTIVE", "1") != "0",
            alsa_in: env_or("OMP_LL_ALSA_IN", ""),
            alsa_out: env_or("OMP_LL_ALSA_OUT", ""),
            alsa_in_ch: env_num("OMP_LL_ALSA_IN_CH", 2usize).clamp(1, 64),
            alsa_out_ch: env_num("OMP_LL_ALSA_OUT_CH", 2usize).clamp(1, 64),
            alsa_periods: env_num("OMP_LL_ALSA_PERIODS", 2usize).clamp(2, 8),
            aes_rx: aes_io::parse_endpoint(&env_or("OMP_LL_AES_RX", "")),
            aes_rx_ch: env_num("OMP_LL_AES_RX_CH", 8usize).clamp(1, 64),
            aes_rx_fmt: rtp::Format::parse(&env_or("OMP_LL_AES_RX_FMT", "L24")).unwrap_or(rtp::Format::L24),
            aes_tx: aes_io::parse_endpoint(&env_or("OMP_LL_AES_TX", "")),
            aes_tx_ch: env_num("OMP_LL_AES_TX_CH", (buses * 2).min(8)).clamp(1, 64),
            aes_tx_fmt: rtp::Format::parse(&env_or("OMP_LL_AES_TX_FMT", "L24")).unwrap_or(rtp::Format::L24),
            aes_iface: env_or("OMP_LL_AES_IFACE", "0.0.0.0").parse().unwrap_or(Ipv4Addr::UNSPECIFIED),
            aes_ttl: env_num("OMP_LL_AES_TTL", 32u32).clamp(1, 255),
            aes_pt: env_num("OMP_LL_AES_PT", 97u8).clamp(96, 127),
            rt_priority: env_num("OMP_LL_RT_PRIORITY", 50i32).clamp(0, 90),
            spin_us: env_num("OMP_LL_SPIN_US", 100u64).min(2000),
        }
    }

    /// Rahmen je RTP-Paket: die Blockgröße, wenn sie eine AES67-Paketzeit ist, sonst 1 ms.
    fn packet_frames(&self) -> usize {
        if [6, 12, 16, 48, 192].contains(&self.block) { self.block } else { 48 }
    }
}

/// Setzt SCHED_FIFO für den aufrufenden Thread (best effort; ohne Rechte `false`).
fn set_realtime(prio: i32) -> bool {
    if prio <= 0 {
        return false;
    }
    let p = libc::sched_param { sched_priority: prio };
    // SAFETY: `p` lebt über den Aufruf; Thread-ID 0 = aufrufender Thread.
    unsafe { libc::sched_setscheduler(0, libc::SCHED_FIFO, &p) == 0 }
}

#[derive(Clone)]
struct StripSet {
    label: String,
    gain_db: f64,
    mute: bool,
    source: Source,
    sends_db: Vec<f64>,
}

#[derive(Clone)]
struct BusSet {
    label: String,
    gain_db: f64,
    mute: bool,
    /// Erster ALSA-Ausgangskanal (1-basiert) des Stereopaares, 0 = kein ALSA-Ausgang
    alsa_out: u32,
}

struct Settings {
    strips: Vec<StripSet>,
    buses: Vec<BusSet>,
}

#[derive(Default)]
struct Stats {
    ticks: AtomicU64,
    deadline_misses: AtomicU64,
    proc_us_max: AtomicU64,
    proc_us_sum: AtomicU64,
    proc_us_count: AtomicU64,
    alsa_xruns: AtomicU64,
    alsa_out_delay_frames: AtomicU64,
    aes_tx_packets: AtomicU64,
    mxl_out_resyncs: AtomicU64,
    realtime: AtomicBool,
    out_flowed: AtomicBool,
}

struct Rt {
    cfg: Cfg,
    shared: Arc<Shared>,
    settings: Mutex<Settings>,
    /// Quelle je Streifen, kodiert: 0 aus, 1 mxl, 2 alsa mono, 3 alsa stereo, 4 aes mono, 5 aes stereo (| Kanal << 8)
    sources: Vec<AtomicU32>,
    bus_alsa_out: Vec<AtomicU32>,
    rings: Vec<Arc<Mutex<InRing>>>,
    mxl_in: Arc<mxl_io::MxlIn>,
    aes_ring: Option<Arc<Mutex<InRing>>>,
    aes_rx_stats: Arc<aes_io::RxStats>,
    stats: Stats,
    alsa_in_info: Mutex<String>,
    alsa_out_info: Mutex<String>,
    out_flows: Vec<String>,
    tx_sdp: Mutex<String>,
    /// Mindestens ein ALSA-Strom wurde wirklich geöffnet (dann gibt die Karte den Takt)
    alsa_active: bool,
}

fn encode_source(s: Source) -> u32 {
    match s {
        Source::Off => 0,
        Source::Mxl => 1,
        Source::Alsa { first, stereo } => (if stereo { 3 } else { 2 }) | (first as u32) << 8,
        Source::Aes { first, stereo } => (if stereo { 5 } else { 4 }) | (first as u32) << 8,
    }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Echtzeit-Schleife

struct Buffers {
    n: usize,
    alsa_il: Vec<f32>,
    alsa_planar: Vec<Vec<f32>>,
    aes_il: Vec<f32>,
    aes_planar: Vec<Vec<f32>>,
    strip_l: Vec<Vec<f32>>,
    strip_r: Vec<Vec<f32>>,
    present: Vec<bool>,
    stereo_il: Vec<f32>,
    out_l: Vec<Vec<f32>>,
    out_r: Vec<Vec<f32>>,
    alsa_out_il: Vec<f32>,
    aes_tx_il: Vec<f32>,
}

fn deinterleave(il: &[f32], ch: usize, planar: &mut [Vec<f32>]) {
    for (c, p) in planar.iter_mut().enumerate().take(ch) {
        for (i, v) in p.iter_mut().enumerate() {
            *v = il[i * ch + c];
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_loop(rt: Arc<Rt>, ctx: Arc<MxlContext>, mut alsa_in: Option<alsa::Pcm>, mut alsa_out: Option<alsa::Pcm>, mut mxl_out: Vec<mxl_io::MxlOut>, mut aes_tx: Option<aes_io::Tx>, shutdown: Arc<AtomicBool>, heartbeat: Arc<AtomicU64>) {
    let cfg = rt.cfg.clone();
    let n = cfg.block;
    if set_realtime(cfg.rt_priority) {
        rt.stats.realtime.store(true, Ordering::Relaxed);
    } else if cfg.rt_priority > 0 {
        eprintln!("omp-lowlat-mixer: keine Echtzeit-Priorität (SCHED_FIFO {}): Rechte/RLIMIT_RTPRIO fehlen — Zeitverhalten nicht garantiert", cfg.rt_priority);
    }
    // SAFETY: mlockall ohne Zeiger; scheitert harmlos ohne Rechte.
    unsafe {
        libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE);
    }
    let (in_ch, out_ch) = (alsa_in.as_ref().map_or(0, |_| cfg.alsa_in_ch), alsa_out.as_ref().map_or(0, |_| cfg.alsa_out_ch));
    let aes_rx_ch = if rt.aes_ring.is_some() { cfg.aes_rx_ch } else { 0 };
    let mut b = Buffers {
        n,
        alsa_il: vec![0.0; n * in_ch.max(1)],
        alsa_planar: vec![vec![0.0; n]; in_ch],
        aes_il: vec![0.0; n * aes_rx_ch.max(1)],
        aes_planar: vec![vec![0.0; n]; aes_rx_ch],
        strip_l: vec![vec![0.0; n]; cfg.strips],
        strip_r: vec![vec![0.0; n]; cfg.strips],
        present: vec![false; cfg.strips],
        stereo_il: vec![0.0; n * 2],
        out_l: vec![vec![0.0; n]; cfg.buses],
        out_r: vec![vec![0.0; n]; cfg.buses],
        alsa_out_il: vec![0.0; n * out_ch.max(1)],
        aes_tx_il: vec![0.0; n * cfg.aes_tx_ch],
    };
    let mut engine = Engine::new(n, rt.shared.clone());
    let alsa_master = alsa_in.is_some() || alsa_out.is_some();
    if let Some(out) = alsa_out.as_mut() {
        // Puffer einmal füllen (Wiedergabe startet erst bei vollem Puffer), danach hält das blockierende Schreiben den Takt
        let silence = vec![0.0f32; n * out_ch];
        for _ in 0..cfg.alsa_periods {
            if let Err(e) = out.write(&silence) {
                eprintln!("omp-lowlat-mixer: ALSA-Ausgang: {e}");
            }
        }
    }
    let period = Duration::from_nanos(n as u64 * 1_000_000_000 / RATE as u64);
    let spin = Duration::from_micros(cfg.spin_us);
    let mut next = Instant::now() + period;
    let mut last_delay_poll = Instant::now();
    while !shutdown.load(Ordering::Relaxed) {
        heartbeat.fetch_add(1, Ordering::Relaxed);
        // 1) Takt
        if !alsa_master {
            let now = Instant::now();
            if next > now + spin {
                std::thread::sleep(next - now - spin);
            }
            while Instant::now() < next {
                std::hint::spin_loop();
            }
            if Instant::now() > next + period / 2 {
                rt.stats.deadline_misses.fetch_add(1, Ordering::Relaxed);
            }
            next += period;
            if Instant::now() > next + period * 50 {
                next = Instant::now() + period; // langer Stillstand des Rechners: nicht im Rennen nachholen
            }
        }
        if let Some(inp) = alsa_in.as_mut() {
            match inp.read(&mut b.alsa_il) {
                Ok(()) => deinterleave(&b.alsa_il, in_ch, &mut b.alsa_planar),
                Err(e) => {
                    eprintln!("omp-lowlat-mixer: ALSA-Eingang: {e}");
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            rt.stats.alsa_xruns.store(inp.xruns + alsa_out.as_ref().map_or(0, |o| o.xruns), Ordering::Relaxed);
        }
        let t0 = Instant::now();
        // 2) Eingänge einsammeln
        let aes_ok = match &rt.aes_ring {
            Some(r) => {
                let ok = r.lock().expect("lock poisoned").pull(&mut b.aes_il);
                deinterleave(&b.aes_il, aes_rx_ch, &mut b.aes_planar);
                ok
            }
            None => false,
        };
        for s in 0..cfg.strips {
            let code = rt.sources[s].load(Ordering::Relaxed);
            let (kind, first) = (code & 0xFF, (code >> 8) as usize);
            let mut present = false;
            match kind {
                1 => {
                    present = rt.rings[s].lock().expect("lock poisoned").pull(&mut b.stereo_il);
                    for i in 0..n {
                        b.strip_l[s][i] = b.stereo_il[i * 2];
                        b.strip_r[s][i] = b.stereo_il[i * 2 + 1];
                    }
                }
                2 | 3 if first >= 1 && first <= in_ch => {
                    let l = &b.alsa_planar[first - 1];
                    let r = if kind == 3 && first < in_ch { &b.alsa_planar[first] } else { l };
                    b.strip_l[s].copy_from_slice(l);
                    b.strip_r[s].copy_from_slice(r);
                    present = true;
                }
                4 | 5 if aes_ok && first >= 1 && first <= aes_rx_ch => {
                    let l = &b.aes_planar[first - 1];
                    let r = if kind == 5 && first < aes_rx_ch { &b.aes_planar[first] } else { l };
                    b.strip_l[s].copy_from_slice(l);
                    b.strip_r[s].copy_from_slice(r);
                    present = true;
                }
                _ => {}
            }
            if kind != 1 {
                // nicht benutzter MXL-Eingang: Ring leer halten statt ihn überlaufen zu lassen
                let mut r = rt.rings[s].lock().expect("lock poisoned");
                if r.fill_frames() > 0 {
                    r.reset();
                }
            }
            b.present[s] = present;
        }
        // 3) mischen
        {
            let ins: Vec<StripIn> = (0..cfg.strips).map(|s| StripIn { l: &b.strip_l[s], r: &b.strip_r[s], present: b.present[s] }).collect();
            engine.process(&ins, &mut b.out_l, &mut b.out_r);
        }
        // 4) Ausgänge
        if let Some(out) = alsa_out.as_mut() {
            b.alsa_out_il.fill(0.0);
            for bus in 0..cfg.buses {
                let first = rt.bus_alsa_out[bus].load(Ordering::Relaxed) as usize;
                if first == 0 || first > out_ch {
                    continue;
                }
                for i in 0..n {
                    b.alsa_out_il[i * out_ch + first - 1] += b.out_l[bus][i];
                    if first < out_ch {
                        b.alsa_out_il[i * out_ch + first] += b.out_r[bus][i];
                    }
                }
            }
            if let Err(e) = out.write(&b.alsa_out_il) {
                eprintln!("omp-lowlat-mixer: ALSA-Ausgang: {e}");
                std::thread::sleep(Duration::from_millis(50));
            }
            if last_delay_poll.elapsed() > Duration::from_millis(500) {
                rt.stats.alsa_out_delay_frames.store(out.delay_frames().max(0) as u64, Ordering::Relaxed);
                last_delay_poll = Instant::now();
            }
            rt.stats.out_flowed.store(true, Ordering::Relaxed);
        }
        for (bus, o) in mxl_out.iter_mut().enumerate() {
            o.write(&ctx, &b.out_l[bus], &b.out_r[bus]);
        }
        rt.stats.mxl_out_resyncs.store(mxl_out.iter().map(|o| o.resyncs).sum(), Ordering::Relaxed);
        if let Some(tx) = aes_tx.as_mut() {
            b.aes_tx_il.fill(0.0);
            for bus in 0..cfg.buses {
                let c0 = bus * 2;
                if c0 >= cfg.aes_tx_ch {
                    break;
                }
                for i in 0..n {
                    b.aes_tx_il[i * cfg.aes_tx_ch + c0] = b.out_l[bus][i];
                    if c0 + 1 < cfg.aes_tx_ch {
                        b.aes_tx_il[i * cfg.aes_tx_ch + c0 + 1] = b.out_r[bus][i];
                    }
                }
            }
            tx.send(ctx.now_ns(), &b.aes_tx_il);
            rt.stats.aes_tx_packets.store(tx.packets, Ordering::Relaxed);
        }
        // 5) Statistik
        let us = t0.elapsed().as_micros() as u64;
        rt.stats.ticks.fetch_add(1, Ordering::Relaxed);
        rt.stats.proc_us_sum.fetch_add(us, Ordering::Relaxed);
        rt.stats.proc_us_count.fetch_add(1, Ordering::Relaxed);
        rt.stats.proc_us_max.fetch_max(us, Ordering::Relaxed);
    }
    let _ = b.n;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Parameter

struct InputControl {
    mxl_in: Arc<mxl_io::MxlIn>,
    slot: usize,
    registry: RegistryClient,
}

impl ReceiverControl for InputControl {
    fn apply(&self, resource: &ReceiverResource) {
        match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.registry.get_sender(sender_id) {
                Ok(sender) => match sender.flow_id {
                    Some(flow_id) => self.mxl_in.connect(self.slot, &flow_id),
                    None => eprintln!("omp-lowlat-mixer: Sender {sender_id} hat keinen Flow"),
                },
                Err(e) => eprintln!("omp-lowlat-mixer: Sender {sender_id} nicht auflösbar: {e}"),
            },
            _ => self.mxl_in.connect(self.slot, ""),
        }
    }
}

struct Store {
    rt: Arc<Rt>,
    connections: Vec<Arc<ReceiverConnection<InputControl>>>,
}

fn ro(name: String, kind: ParamType, unit: Option<&str>) -> ParamSpec {
    ParamSpec { name, kind, unit: unit.map(str::to_string), range: None, readonly: true }
}

fn rw(name: String, kind: ParamType, unit: Option<&str>, range: Option<Range>) -> ParamSpec {
    ParamSpec { name, kind, unit: unit.map(str::to_string), range, readonly: false }
}

fn db_range() -> Option<Range> {
    Some(Range::Number { min: -90.0, max: 12.0 })
}

/// `strip.3.gain` → ("strip", 2, "gain"); `strip.3.send.2` → ("strip", 2, "send.2")
fn split_name(name: &str) -> Option<(&str, usize, &str)> {
    let mut it = name.splitn(3, '.');
    let kind = it.next()?;
    let idx: usize = it.next()?.parse().ok()?;
    let rest = it.next()?;
    if idx == 0 {
        return None;
    }
    Some((kind, idx - 1, rest))
}

impl Store {
    fn apply_strip(&self, s: usize) {
        let st = self.rt.settings.lock().expect("lock poisoned");
        let x = &st.strips[s];
        self.rt.shared.strip_gain[s].store(db_to_lin(x.gain_db).to_bits(), Ordering::Relaxed);
        self.rt.shared.strip_mute[s].store(x.mute, Ordering::Relaxed);
        self.rt.sources[s].store(encode_source(x.source), Ordering::Relaxed);
        for b in 0..self.rt.cfg.buses {
            self.rt.shared.set_send(s, b, db_to_lin(x.sends_db[b]));
        }
    }

    fn apply_bus(&self, b: usize) {
        let st = self.rt.settings.lock().expect("lock poisoned");
        let x = &st.buses[b];
        self.rt.shared.bus_gain[b].store(db_to_lin(x.gain_db).to_bits(), Ordering::Relaxed);
        self.rt.shared.bus_mute[b].store(x.mute, Ordering::Relaxed);
        self.rt.bus_alsa_out[b].store(x.alsa_out, Ordering::Relaxed);
    }

    /// Alles, was die Bedienoberfläche je Aktualisierung braucht, in einer Antwort (statt > 100 Einzelabfragen): Streifen, Busse,
    /// Zähler. Geht über `GET /api/v1/nodes/{id}/measurements` (generische Orchestrator-Route).
    fn snapshot(&self) -> Value {
        let cfg = &self.rt.cfg;
        let g = |n: &str| self.get(n).unwrap_or(Value::Null);
        let strips: Vec<Value> = (1..=cfg.strips)
            .map(|s| {
                json!({
                    "n": s, "label": g(&format!("strip.{s}.label")), "source": g(&format!("strip.{s}.source")), "gain": g(&format!("strip.{s}.gain")),
                    "mute": g(&format!("strip.{s}.mute")), "level": g(&format!("strip.{s}.levelDb")), "state": g(&format!("strip.{s}.state")),
                    "bufferMs": g(&format!("strip.{s}.bufferMs")),
                    "sends": (1..=cfg.buses).map(|b| g(&format!("strip.{s}.send.{b}"))).collect::<Vec<_>>(),
                })
            })
            .collect();
        let buses: Vec<Value> = (1..=cfg.buses)
            .map(|b| json!({ "n": b, "label": g(&format!("bus.{b}.label")), "gain": g(&format!("bus.{b}.gain")), "mute": g(&format!("bus.{b}.mute")), "alsaOut": g(&format!("bus.{b}.alsaOut")), "level": g(&format!("bus.{b}.levelDb")) }))
            .collect();
        let mut stats = serde_json::Map::new();
        for k in ["blockMs", "clockMaster", "realtime", "processUsAvg", "processUsMax", "deadlineMisses", "alsaIn", "alsaOut", "alsaXruns", "alsaOutDelayMs", "aesRx", "aesRxPackets", "aesRxLost", "aesTx", "aesTxPackets", "ringUnderruns", "ringSlips", "ringGrown", "ringShrunk", "mxlOutResyncs", "mxlInResyncs"] {
            stats.insert(k.to_string(), g(k));
        }
        json!({ "strips": strips, "buses": buses, "stats": stats, "alsaInChannels": if self.rt.cfg.alsa_in.is_empty() { 0 } else { self.rt.cfg.alsa_in_ch }, "aesRxChannels": if self.rt.aes_ring.is_some() { self.rt.cfg.aes_rx_ch } else { 0 } })
    }

    fn state_json(&self) -> Value {
        let st = self.rt.settings.lock().expect("lock poisoned");
        json!({
            "strips": st.strips.iter().map(|s| json!({"label": s.label, "gainDb": s.gain_db, "mute": s.mute, "source": s.source.to_text(), "sendsDb": s.sends_db})).collect::<Vec<_>>(),
            "buses": st.buses.iter().map(|b| json!({"label": b.label, "gainDb": b.gain_db, "mute": b.mute, "alsaOut": b.alsa_out})).collect::<Vec<_>>(),
        })
    }

    fn load_state(&self, v: &Value) {
        let (ns, nb) = (self.rt.cfg.strips, self.rt.cfg.buses);
        {
            let mut st = self.rt.settings.lock().expect("lock poisoned");
            if let Some(a) = v.get("strips").and_then(Value::as_array) {
                for (i, s) in a.iter().enumerate().take(ns) {
                    let x = &mut st.strips[i];
                    if let Some(l) = s.get("label").and_then(Value::as_str) {
                        x.label = l.chars().take(40).collect();
                    }
                    if let Some(g) = s.get("gainDb").and_then(Value::as_f64).filter(|g| (-90.0..=12.0).contains(g)) {
                        x.gain_db = g;
                    }
                    if let Some(m) = s.get("mute").and_then(Value::as_bool) {
                        x.mute = m;
                    }
                    if let Some(src) = s.get("source").and_then(Value::as_str).and_then(Source::parse) {
                        x.source = src;
                    }
                    if let Some(sd) = s.get("sendsDb").and_then(Value::as_array) {
                        for (b, g) in sd.iter().enumerate().take(nb) {
                            if let Some(g) = g.as_f64().filter(|g| (-90.0..=12.0).contains(g)) {
                                x.sends_db[b] = g;
                            }
                        }
                    }
                }
            }
            if let Some(a) = v.get("buses").and_then(Value::as_array) {
                for (i, s) in a.iter().enumerate().take(nb) {
                    let x = &mut st.buses[i];
                    if let Some(l) = s.get("label").and_then(Value::as_str) {
                        x.label = l.chars().take(40).collect();
                    }
                    if let Some(g) = s.get("gainDb").and_then(Value::as_f64).filter(|g| (-90.0..=12.0).contains(g)) {
                        x.gain_db = g;
                    }
                    if let Some(m) = s.get("mute").and_then(Value::as_bool) {
                        x.mute = m;
                    }
                    if let Some(o) = s.get("alsaOut").and_then(Value::as_u64).filter(|o| *o <= 64) {
                        x.alsa_out = o as u32;
                    }
                }
            }
        }
        for s in 0..ns {
            self.apply_strip(s);
        }
        for b in 0..nb {
            self.apply_bus(b);
        }
    }

    fn strip_state(&self, s: usize) -> &'static str {
        let src = self.rt.settings.lock().expect("lock poisoned").strips[s].source;
        match src {
            Source::Off => "aus",
            Source::Mxl => {
                if self.rt.mxl_in.flow_of(s).is_empty() {
                    "nicht verbunden"
                } else if !self.rt.mxl_in.slots[s].flowed.load(Ordering::Relaxed) {
                    "kein Signal"
                } else if self.rt.rings[s].lock().expect("lock poisoned").is_primed() {
                    "ok"
                } else {
                    "füllt"
                }
            }
            Source::Alsa { .. } => if self.rt.cfg.alsa_in.is_empty() { "kein ALSA-Eingang" } else { "ok" },
            Source::Aes { .. } => match &self.rt.aes_ring {
                None => "kein AES-Eingang",
                Some(r) => if r.lock().expect("lock poisoned").is_primed() { "ok" } else { "kein Signal" },
            },
        }
    }
}

fn frames_ms(f: usize) -> f64 {
    (f as f64 * 1000.0 / RATE as f64 * 100.0).round() / 100.0
}

impl ParamStore for Store {
    fn descriptor(&self) -> Descriptor {
        let cfg = &self.rt.cfg;
        let mut p: Vec<ParamSpec> = Vec::new();
        for s in 1..=cfg.strips {
            p.push(rw(format!("strip.{s}.label"), ParamType::String, None, None));
            p.push(rw(format!("strip.{s}.source"), ParamType::String, None, None));
            p.push(rw(format!("strip.{s}.gain"), ParamType::Number, Some("dB"), db_range()));
            p.push(rw(format!("strip.{s}.mute"), ParamType::Boolean, None, None));
            for b in 1..=cfg.buses {
                p.push(rw(format!("strip.{s}.send.{b}"), ParamType::Number, Some("dB"), db_range()));
            }
            p.push(ro(format!("strip.{s}.levelDb"), ParamType::Number, Some("dBFS")));
            p.push(ro(format!("strip.{s}.state"), ParamType::String, None));
            p.push(ro(format!("strip.{s}.flow"), ParamType::String, None));
            p.push(ro(format!("strip.{s}.bufferMs"), ParamType::Number, Some("ms")));
        }
        for b in 1..=cfg.buses {
            p.push(rw(format!("bus.{b}.label"), ParamType::String, None, None));
            p.push(rw(format!("bus.{b}.gain"), ParamType::Number, Some("dB"), db_range()));
            p.push(rw(format!("bus.{b}.mute"), ParamType::Boolean, None, None));
            p.push(rw(format!("bus.{b}.alsaOut"), ParamType::Number, None, Some(Range::Number { min: 0.0, max: 64.0 })));
            p.push(ro(format!("bus.{b}.levelDb"), ParamType::Number, Some("dBFS")));
            p.push(ro(format!("bus.{b}.flowId"), ParamType::String, None));
        }
        for (n, k, u) in [
            ("blockFrames", ParamType::Number, None),
            ("blockMs", ParamType::Number, Some("ms")),
            ("clockMaster", ParamType::String, None),
            ("realtime", ParamType::Boolean, None),
            ("processUsAvg", ParamType::Number, Some("µs")),
            ("processUsMax", ParamType::Number, Some("µs")),
            ("deadlineMisses", ParamType::Number, None),
            ("alsaIn", ParamType::String, None),
            ("alsaOut", ParamType::String, None),
            ("alsaXruns", ParamType::Number, None),
            ("alsaOutDelayMs", ParamType::Number, Some("ms")),
            ("aesRx", ParamType::String, None),
            ("aesRxPackets", ParamType::Number, None),
            ("aesRxLost", ParamType::Number, None),
            ("aesTx", ParamType::String, None),
            ("aesTxPackets", ParamType::Number, None),
            ("aesTxSdp", ParamType::String, None),
            ("ringUnderruns", ParamType::Number, None),
            ("ringSlips", ParamType::Number, None),
            ("ringGrown", ParamType::Number, None),
            ("ringShrunk", ParamType::Number, None),
            ("mxlOutResyncs", ParamType::Number, None),
            ("mxlInResyncs", ParamType::Number, None),
        ] {
            p.push(ro(n.to_string(), k, u));
        }
        let mut methods = vec![
            MethodSpec { name: "resetStats".to_string(), args: vec![] },
        ];
        for s in 1..=cfg.strips {
            methods.push(MethodSpec { name: format!("strip.{s}.setFlow"), args: vec![MethodArg { name: "flowId".to_string(), kind: ParamType::String }] });
        }
        for b in 1..=cfg.buses {
            methods.push(MethodSpec { name: format!("bus.{b}.mixMinus"), args: vec![MethodArg { name: "strip".to_string(), kind: ParamType::Number }] });
            methods.push(MethodSpec { name: format!("bus.{b}.clearSends"), args: vec![] });
        }
        // Eigenlatenz: ein Block Verarbeitung + Reserve des Eingangsrings; ALSA/Netz kommen je nach Weg obendrauf
        let frames = (cfg.block + cfg.safety_frames) as u32;
        Descriptor { latency: Some(LatencyInfo { video: None, audio: Some(LatencyRange { min_latency_frames: cfg.block as u32, max_latency_frames: frames * 2 }), data: None, supports_delay_compensation: false }), parameters: p, methods }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let rt = &self.rt;
        let cfg = &rt.cfg;
        match name {
            "blockFrames" => return Some(json!(cfg.block)),
            "blockMs" => return Some(json!(frames_ms(cfg.block))),
            "clockMaster" => return Some(json!(if rt.alsa_active { "alsa" } else { "timer" })),
            "realtime" => return Some(json!(rt.stats.realtime.load(Ordering::Relaxed))),
            "processUsAvg" => {
                let c = rt.stats.proc_us_count.load(Ordering::Relaxed).max(1);
                return Some(json!(rt.stats.proc_us_sum.load(Ordering::Relaxed) / c));
            }
            "processUsMax" => return Some(json!(rt.stats.proc_us_max.load(Ordering::Relaxed))),
            "deadlineMisses" => return Some(json!(rt.stats.deadline_misses.load(Ordering::Relaxed))),
            "alsaIn" => return Some(json!(rt.alsa_in_info.lock().expect("lock poisoned").clone())),
            "alsaOut" => return Some(json!(rt.alsa_out_info.lock().expect("lock poisoned").clone())),
            "alsaXruns" => return Some(json!(rt.stats.alsa_xruns.load(Ordering::Relaxed))),
            "alsaOutDelayMs" => return Some(json!(frames_ms(rt.stats.alsa_out_delay_frames.load(Ordering::Relaxed) as usize))),
            "aesRx" => return Some(json!(match cfg.aes_rx { Some((a, p)) => format!("{a}:{p} {} {} Kanäle", cfg.aes_rx_fmt.name(), cfg.aes_rx_ch), None => "aus".into() })),
            "aesRxPackets" => return Some(json!(rt.aes_rx_stats.packets.load(Ordering::Relaxed))),
            "aesRxLost" => return Some(json!(rt.aes_rx_stats.lost.load(Ordering::Relaxed))),
            "aesTx" => return Some(json!(match cfg.aes_tx { Some((a, p)) => format!("{a}:{p} {} {} Kanäle, Paket {} ms", cfg.aes_tx_fmt.name(), cfg.aes_tx_ch, rtp::ptime_text(cfg.packet_frames())), None => "aus".into() })),
            "aesTxPackets" => return Some(json!(rt.stats.aes_tx_packets.load(Ordering::Relaxed))),
            "aesTxSdp" => return Some(json!(rt.tx_sdp.lock().expect("lock poisoned").clone())),
            "ringUnderruns" | "ringSlips" | "ringGrown" | "ringShrunk" => {
                let mut rings: Vec<&Arc<Mutex<InRing>>> = rt.rings.iter().collect();
                if let Some(r) = &rt.aes_ring {
                    rings.push(r);
                }
                let v: u64 = rings
                    .iter()
                    .map(|r| {
                        let s = r.lock().expect("lock poisoned").stats.clone();
                        match name {
                            "ringUnderruns" => s.underruns,
                            "ringSlips" => s.slips_drop + s.slips_insert,
                            "ringShrunk" => s.shrunk,
                            _ => s.grown,
                        }
                    })
                    .sum();
                return Some(json!(v));
            }
            "mxlOutResyncs" => return Some(json!(rt.stats.mxl_out_resyncs.load(Ordering::Relaxed))),
            "mxlInResyncs" => return Some(json!(rt.mxl_in.slots.iter().map(|s| s.resyncs.load(Ordering::Relaxed)).sum::<u64>())),
            _ => {}
        }
        let (kind, idx, rest) = split_name(name)?;
        let st = rt.settings.lock().expect("lock poisoned");
        match kind {
            "strip" if idx < cfg.strips => {
                let s = &st.strips[idx];
                if let Some(b) = rest.strip_prefix("send.") {
                    let b: usize = b.parse().ok()?;
                    return (1..=cfg.buses).contains(&b).then(|| json!(s.sends_db[b - 1]));
                }
                Some(match rest {
                    "label" => json!(s.label),
                    "source" => json!(s.source.to_text()),
                    "gain" => json!(s.gain_db),
                    "mute" => json!(s.mute),
                    "levelDb" => json!(lin_to_db(Shared::peak_of(&rt.shared.strip_peak[idx]))),
                    "flow" => json!(rt.mxl_in.flow_of(idx)),
                    "bufferMs" => json!(frames_ms(rt.rings[idx].lock().expect("lock poisoned").fill_frames())),
                    "state" => {
                        drop(st);
                        return Some(json!(self.strip_state(idx)));
                    }
                    _ => return None,
                })
            }
            "bus" if idx < cfg.buses => {
                let b = &st.buses[idx];
                Some(match rest {
                    "label" => json!(b.label),
                    "gain" => json!(b.gain_db),
                    "mute" => json!(b.mute),
                    "alsaOut" => json!(b.alsa_out),
                    "levelDb" => json!(lin_to_db(Shared::peak_of(&rt.shared.bus_peak[idx]))),
                    "flowId" => json!(rt.out_flows[idx]),
                    _ => return None,
                })
            }
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let cfg = &self.rt.cfg;
        let Some((kind, idx, rest)) = split_name(name) else {
            return if self.get(name).is_some() { Err(SetError::ReadOnly) } else { Err(SetError::Unknown) };
        };
        let num = || value.as_f64().filter(|v| v.is_finite());
        match kind {
            "strip" if idx < cfg.strips => {
                {
                    let mut st = self.rt.settings.lock().expect("lock poisoned");
                    let s = &mut st.strips[idx];
                    if let Some(b) = rest.strip_prefix("send.") {
                        let b: usize = b.parse().map_err(|_| SetError::Unknown)?;
                        if !(1..=cfg.buses).contains(&b) {
                            return Err(SetError::Unknown);
                        }
                        let v = num().filter(|v| (-90.0..=12.0).contains(v)).ok_or(SetError::Unknown)?;
                        s.sends_db[b - 1] = v;
                    } else {
                        match rest {
                            "label" => s.label = value.as_str().ok_or(SetError::Unknown)?.chars().take(40).collect(),
                            "source" => s.source = value.as_str().and_then(Source::parse).ok_or(SetError::Unknown)?,
                            "gain" => s.gain_db = num().filter(|v| (-90.0..=12.0).contains(v)).ok_or(SetError::Unknown)?,
                            "mute" => s.mute = value.as_bool().ok_or(SetError::Unknown)?,
                            "levelDb" | "state" | "flow" | "bufferMs" => return Err(SetError::ReadOnly),
                            _ => return Err(SetError::Unknown),
                        }
                    }
                }
                self.apply_strip(idx);
                Ok(())
            }
            "bus" if idx < cfg.buses => {
                {
                    let mut st = self.rt.settings.lock().expect("lock poisoned");
                    let b = &mut st.buses[idx];
                    match rest {
                        "label" => b.label = value.as_str().ok_or(SetError::Unknown)?.chars().take(40).collect(),
                        "gain" => b.gain_db = num().filter(|v| (-90.0..=12.0).contains(v)).ok_or(SetError::Unknown)?,
                        "mute" => b.mute = value.as_bool().ok_or(SetError::Unknown)?,
                        "alsaOut" => b.alsa_out = num().filter(|v| (0.0..=64.0).contains(v)).ok_or(SetError::Unknown)? as u32,
                        "levelDb" | "flowId" => return Err(SetError::ReadOnly),
                        _ => return Err(SetError::Unknown),
                    }
                }
                self.apply_bus(idx);
                Ok(())
            }
            _ => Err(SetError::Unknown),
        }
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let cfg = &self.rt.cfg;
        if name == "resetStats" {
            let s = &self.rt.stats;
            for a in [&s.deadline_misses, &s.proc_us_max, &s.proc_us_sum, &s.proc_us_count] {
                a.store(0, Ordering::Relaxed);
            }
            return Ok(());
        }
        let (kind, idx, rest) = split_name(name).ok_or(InvokeError::Unknown)?;
        match (kind, rest) {
            ("strip", "setFlow") if idx < cfg.strips => {
                let flow = args.get("flowId").and_then(Value::as_str).ok_or(InvokeError::Unknown)?;
                if !flow.is_empty() && flow.len() != 36 {
                    return Err(InvokeError::Message("flowId muss eine UUID sein (oder leer zum Trennen)".to_string()));
                }
                self.rt.mxl_in.connect(idx, flow);
                Ok(())
            }
            ("bus", "mixMinus") if idx < cfg.buses => {
                let own = args.get("strip").and_then(Value::as_f64).filter(|v| v.fract() == 0.0 && *v >= 1.0 && *v <= cfg.strips as f64).ok_or_else(|| InvokeError::Message(format!("strip muss 1..{} sein", cfg.strips)))? as usize - 1;
                {
                    let mut st = self.rt.settings.lock().expect("lock poisoned");
                    for (s, x) in st.strips.iter_mut().enumerate() {
                        x.sends_db[idx] = if s == own { -90.0 } else { 0.0 };
                    }
                }
                for s in 0..cfg.strips {
                    self.apply_strip(s);
                }
                Ok(())
            }
            ("bus", "clearSends") if idx < cfg.buses => {
                {
                    let mut st = self.rt.settings.lock().expect("lock poisoned");
                    for x in st.strips.iter_mut() {
                        x.sends_db[idx] = -90.0;
                    }
                }
                for s in 0..cfg.strips {
                    self.apply_strip(s);
                }
                Ok(())
            }
            _ => Err(InvokeError::Unknown),
        }
    }

    fn extra_route(&self, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
        let to_raw = |(status, content_type, body)| RawResponse { status, content_type, body };
        if let Some(r) = uibundle::route(method, path) {
            return Some(r);
        }
        if method == "GET" && path.split('?').next() == Some("/measurements") {
            return Some(RawResponse { status: 200, content_type: "application/json", body: serde_json::to_vec(&self.snapshot()).unwrap_or_default() });
        }
        // Workflow-Sicherung: Pegel, Sends, Quellen, Bezeichnungen überleben einen Neustart
        if method == "GET" && path == "/state" {
            return Some(RawResponse { status: 200, content_type: "application/json", body: serde_json::to_vec(&json!({ "state": self.state_json() })).unwrap_or_default() });
        }
        if method == "POST" && path == "/state" {
            return Some(match serde_json::from_slice::<Value>(body) {
                Ok(v) => {
                    self.load_state(v.get("state").unwrap_or(&Value::Null));
                    RawResponse { status: 200, content_type: "application/json", body: br#"{"ok":true}"#.to_vec() }
                }
                Err(_) => RawResponse { status: 400, content_type: "application/json", body: br#"{"error":"invalid JSON body"}"#.to_vec() },
            });
        }
        let ids: Vec<String> = self.connections.iter().map(|c| c.id().to_string()).collect();
        let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        root_discovery(method, path)
            .or_else(|| list_ids(method, path, "receivers", &id_refs))
            .or_else(|| bulk_discovery(method, path))
            .or_else(|| bulk_patch(method, path, "receivers", body, |id, params| self.connections.iter().find(|c| c.id() == id).map(|c| c.patch_staged(params).0)))
            .or_else(|| bulk_patch(method, path, "senders", body, |_, _| None))
            .or_else(|| self.connections.iter().find_map(|c| c.handle(method, path, body)))
            .map(to_raw)
    }

    fn extra_options(&self, path: &str) -> Option<Vec<&'static str>> {
        self.connections.iter().find_map(|c| c.cors_methods(path)).or_else(|| bulk_cors_methods(path, "senders")).or_else(|| bulk_cors_methods(path, "receivers"))
    }
}

// ---------------------------------------------------------------------------------------------------------------------------

fn local_mac() -> String {
    for dev in ["eth0", "ens3", "enp1s0", "eno1"] {
        if let Ok(m) = std::fs::read_to_string(format!("/sys/class/net/{dev}/address")) {
            return m.trim().replace(':', "-");
        }
    }
    "00-00-00-00-00-00".to_string()
}

/// `omp-lowlat-mixer --alsa-test <gerät> [periode=48] [perioden=2] [kanäle=2] [sekunden=3]`: öffnet die Karte (Wiedergabe und Aufnahme
/// getrennt), liest/schreibt Perioden und meldet das Zeitverhalten (Abstand zwischen zwei Perioden, Aussetzer, Wiedergabe-Latenz).
/// Dient dazu, vor dem Einsatz eine brauchbare Periodengröße der Karte zu finden.
fn alsa_test(args: &[String]) -> i32 {
    let dev = match args.first() {
        Some(d) => d.clone(),
        None => {
            eprintln!("Aufruf: omp-lowlat-mixer --alsa-test <gerät> [periode=48] [perioden=2] [kanäle=2] [sekunden=3]");
            return 2;
        }
    };
    let num = |i: usize, d: usize| args.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
    let (period, periods, ch, secs) = (num(1, 48), num(2, 2), num(3, 2), num(4, 3));
    let mut rc = 0;
    for capture in [false, true] {
        let what = if capture { "Aufnahme" } else { "Wiedergabe" };
        let mut p = match alsa::Pcm::open(&dev, capture, ch, RATE as u32, period, periods) {
            Ok(p) => p,
            Err(e) => {
                println!("{what}: {e}");
                rc = 1;
                continue;
            }
        };
        println!("{what}: {} Kanäle, Periode {} Rahmen ({:.2} ms), Puffer {} Rahmen, Format {}", p.info.channels, p.info.period_frames, frames_ms(p.info.period_frames), p.info.buffer_frames, p.info.format);
        let n = p.period_frames();
        let mut buf = vec![0.0f32; n * ch];
        if !capture {
            for _ in 0..periods {
                let _ = p.write(&buf);
            }
        }
        let mut gaps_us: Vec<f64> = Vec::new();
        let mut last = Instant::now();
        let end = Instant::now() + Duration::from_secs(secs as u64);
        while Instant::now() < end {
            let r = if capture { p.read(&mut buf) } else { p.write(&buf) };
            if let Err(e) = r {
                println!("{what}: {e}");
                rc = 1;
                break;
            }
            gaps_us.push(last.elapsed().as_secs_f64() * 1e6);
            last = Instant::now();
        }
        gaps_us.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        if gaps_us.len() > 4 {
            let q = |f: f64| gaps_us[((gaps_us.len() - 1) as f64 * f) as usize];
            println!("  {} Perioden, Abstand µs: Median {:.0}, p99 {:.0}, max {:.0} (Soll {:.0}); Aussetzer {}", gaps_us.len(), q(0.5), q(0.99), q(1.0), n as f64 * 1e6 / RATE as f64, p.xruns);
        }
        if !capture {
            println!("  Wiedergabe-Verzug (snd_pcm_delay): {} Rahmen ({:.2} ms)", p.delay_frames(), frames_ms(p.delay_frames().max(0) as usize));
        }
    }
    rc
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let argv: Vec<String> = std::env::args().collect();
    if argv.get(1).map(String::as_str) == Some("--alsa-test") {
        std::process::exit(alsa_test(&argv[2..]));
    }
    let label = env_or("OMP_LABEL", "Studio-Mischer");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "0").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://127.0.0.1:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let domain = env_or("OMP_MXL_DOMAIN", "/dev/shm/omp-mxl");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    let cfg = Cfg::from_env();
    let n = cfg.block;

    let ctx = Arc::new(MxlContext::new(&domain)?);
    let shared = Arc::new(Shared::new(cfg.strips, cfg.buses));
    let rings: Vec<Arc<Mutex<InRing>>> = (0..cfg.strips).map(|_| Arc::new(Mutex::new(InRing::new(2, n, cfg.safety_frames, cfg.max_safety_frames, cfg.adaptive)))).collect();
    let mxl_in = mxl_io::MxlIn::new(ctx.clone(), rings.clone(), n);

    let shutdown = Arc::new(AtomicBool::new(false));
    // AES67-Empfang
    let aes_rx_stats = Arc::new(aes_io::RxStats::default());
    let mut aes_ring = None;
    let mut threads: Vec<std::thread::JoinHandle<()>> = Vec::new();
    if let Some((addr, p)) = cfg.aes_rx {
        let ring = Arc::new(Mutex::new(InRing::new(cfg.aes_rx_ch, n, cfg.safety_frames, cfg.max_safety_frames, cfg.adaptive)));
        match aes_io::start_rx(aes_io::RxCfg { addr, port: p, iface: cfg.aes_iface, ch: cfg.aes_rx_ch, fmt: cfg.aes_rx_fmt, pt: cfg.aes_pt }, ring.clone(), aes_rx_stats.clone(), shutdown.clone(), cfg.packet_frames()) {
            Ok(h) => {
                threads.push(h);
                aes_ring = Some(ring);
            }
            Err(e) => eprintln!("omp-lowlat-mixer: AES67-Empfang {addr}:{p}: {e}"),
        }
    }
    // AES67-Senden
    let tx_sdp = Mutex::new(String::new());
    let aes_tx = match cfg.aes_tx {
        Some((addr, p)) => match aes_io::Tx::new(addr, p, cfg.aes_iface, cfg.aes_ttl, cfg.aes_tx_ch, cfg.aes_tx_fmt, cfg.aes_pt, cfg.packet_frames()) {
            Ok(t) => {
                *tx_sdp.lock().expect("lock poisoned") = rtp::sdp(&label, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(1), &host, &addr.to_string(), cfg.aes_ttl, p, cfg.aes_pt, cfg.aes_tx_fmt, cfg.aes_tx_ch, cfg.packet_frames(), &local_mac());
                Some(t)
            }
            Err(e) => {
                eprintln!("omp-lowlat-mixer: AES67-Senden {addr}:{p}: {e}");
                None
            }
        },
        None => None,
    };
    // ALSA
    let (mut alsa_in_info, mut alsa_out_info) = (String::from("aus"), String::from("aus"));
    let alsa_in = if cfg.alsa_in.is_empty() {
        None
    } else {
        match alsa::Pcm::open(&cfg.alsa_in, true, cfg.alsa_in_ch, RATE as u32, n, cfg.alsa_periods) {
            Ok(p) => {
                alsa_in_info = format!("{}: {} Kanäle, Periode {} Rahmen, Puffer {}, {}", cfg.alsa_in, p.info.channels, p.info.period_frames, p.info.buffer_frames, p.info.format);
                Some(p)
            }
            Err(e) => {
                alsa_in_info = format!("Fehler: {e}");
                eprintln!("omp-lowlat-mixer: ALSA-Eingang: {e}");
                None
            }
        }
    };
    let alsa_out = if cfg.alsa_out.is_empty() {
        None
    } else {
        match alsa::Pcm::open(&cfg.alsa_out, false, cfg.alsa_out_ch, RATE as u32, n, cfg.alsa_periods) {
            Ok(p) => {
                alsa_out_info = format!("{}: {} Kanäle, Periode {} Rahmen, Puffer {}, {}", cfg.alsa_out, p.info.channels, p.info.period_frames, p.info.buffer_frames, p.info.format);
                Some(p)
            }
            Err(e) => {
                alsa_out_info = format!("Fehler: {e}");
                eprintln!("omp-lowlat-mixer: ALSA-Ausgang: {e}");
                None
            }
        }
    };
    // Perioden, die die Karte tatsächlich liefert, bestimmen den Takt — abweichend von der Wunschgröße nicht stillschweigend weitermachen
    for p in [alsa_in.as_ref(), alsa_out.as_ref()].into_iter().flatten() {
        if p.period_frames() != n {
            eprintln!("omp-lowlat-mixer: Karte liefert Periode {} statt {n} Rahmen — Block bleibt {n}, Karte läuft mit eigener Periode (Latenz/Takt prüfen)", p.period_frames());
        }
    }

    // MXL-Ausgänge je Bus
    let out_flows: Vec<String> = (0..cfg.buses).map(|_| omp_node_sdk::idgen::new_v4()).collect();
    let mut settings = Settings {
        strips: (0..cfg.strips).map(|i| StripSet { label: format!("Streifen {}", i + 1), gain_db: 0.0, mute: false, source: Source::Mxl, sends_db: (0..cfg.buses).map(|b| if b == 0 { 0.0 } else { -90.0 }).collect() }).collect(),
        buses: (0..cfg.buses).map(|b| BusSet { label: if b == 0 { "Hauptmix".to_string() } else { format!("Bus {}", b + 1) }, gain_db: 0.0, mute: false, alsa_out: if b == 0 && !cfg.alsa_out.is_empty() { 1 } else { 0 } }).collect(),
    };
    settings.buses[0].alsa_out = settings.buses[0].alsa_out.min(64);
    let mut mxl_out = Vec::new();
    for (b, flow) in out_flows.iter().enumerate() {
        mxl_out.push(mxl_io::MxlOut::new(&ctx, flow, &format!("{label} {}", settings.buses[b].label), n)?);
    }
    let out_flowed: Vec<Arc<AtomicBool>> = mxl_out.iter().map(|o| o.flowed.clone()).collect();

    let alsa_active = alsa_in.is_some() || alsa_out.is_some();
    let rt = Arc::new(Rt {
        cfg: cfg.clone(),
        shared: shared.clone(),
        settings: Mutex::new(settings),
        sources: (0..cfg.strips).map(|_| AtomicU32::new(encode_source(Source::Mxl))).collect(),
        bus_alsa_out: (0..cfg.buses).map(|_| AtomicU32::new(0)).collect(),
        rings: rings.clone(),
        mxl_in: mxl_in.clone(),
        aes_ring,
        aes_rx_stats,
        stats: Stats::default(),
        alsa_in_info: Mutex::new(alsa_in_info),
        alsa_out_info: Mutex::new(alsa_out_info),
        out_flows: out_flows.clone(),
        tx_sdp,
        alsa_active,
    });

    // NMOS: ein MXL-Empfänger je Streifen, ein MXL-Sender je Bus
    let registry = RegistryClient::new(registry_url.clone());
    let receiver_ids: Vec<String> = (0..cfg.strips).map(|_| omp_node_sdk::idgen::new_v4()).collect();
    let connections: Vec<Arc<ReceiverConnection<InputControl>>> = receiver_ids.iter().enumerate().map(|(slot, id)| Arc::new(ReceiverConnection::new(id.clone(), InputControl { mxl_in: mxl_in.clone(), slot, registry: registry.clone() }))).collect();
    let receivers: Vec<ReceiverSpec> = receiver_ids
        .iter()
        .enumerate()
        .map(|(i, id)| ReceiverSpec { id: Some(id.clone()), transport: Some(TRANSPORT_MXL.to_string()), media_types: Some(vec!["audio/float32".to_string()]), label: Some(format!("Streifen {}", i + 1)), ..Default::default() })
        .collect();
    let senders: Vec<SenderSpec> = out_flows
        .iter()
        .enumerate()
        .map(|(b, flow)| SenderSpec {
            id: Some(omp_node_sdk::idgen::new_v4()),
            transport: Some(TRANSPORT_MXL.to_string()),
            flow: Some(FlowSpec::Audio { id: Some(flow.clone()), sample_rate_numerator: RATE as u32, channel_count: 2, media_type: "audio/float32".to_string(), bit_depth: 32, source_id: None }),
            label: Some(if b == 0 { "Hauptmix".to_string() } else { format!("Bus {}", b + 1) }),
            ..Default::default()
        })
        .collect();

    let heartbeat = Arc::new(AtomicU64::new(0));
    let mix = {
        let (rt2, ctx2, sd, hb) = (rt.clone(), ctx.clone(), shutdown.clone(), heartbeat.clone());
        std::thread::Builder::new().name("ll-mix".into()).spawn(move || run_loop(rt2, ctx2, alsa_in, alsa_out, mxl_out, aes_tx, sd, hb))?
    };

    let store = Arc::new(Store { rt: rt.clone(), connections });
    // Anfangszustand in die Echtzeit-Strukturen übernehmen (Pegel, Quellen, ALSA-Zuordnung)
    for s in 0..cfg.strips {
        store.apply_strip(s);
    }
    for b in 0..cfg.buses {
        store.apply_bus(b);
    }
    let media_rt = rt.clone();
    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders,
            receivers,
            instance_id,
            media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new(move || media_rt.stats.out_flowed.load(Ordering::Relaxed) || out_flowed.iter().any(|f| f.load(Ordering::Relaxed)))),
        },
        store,
    )
    .await?;
    handle.register_worker("mix", heartbeat);
    let _ = tokio::signal::ctrl_c().await;
    eprintln!("omp-lowlat-mixer: shutdown requested");
    shutdown.store(true, Ordering::Relaxed);
    let _ = mix.join();
    for t in threads {
        let _ = t.join();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_names() {
        assert_eq!(split_name("strip.3.gain"), Some(("strip", 2, "gain")));
        assert_eq!(split_name("strip.3.send.2"), Some(("strip", 2, "send.2")));
        assert_eq!(split_name("bus.1.alsaOut"), Some(("bus", 0, "alsaOut")));
        assert_eq!(split_name("strip.0.gain"), None);
        assert_eq!(split_name("blockFrames"), None);
    }

    #[test]
    fn source_codes_are_distinct() {
        let all = [Source::Off, Source::Mxl, Source::Alsa { first: 2, stereo: false }, Source::Alsa { first: 2, stereo: true }, Source::Aes { first: 2, stereo: false }, Source::Aes { first: 2, stereo: true }];
        let codes: Vec<u32> = all.iter().map(|s| encode_source(*s)).collect();
        for (i, a) in codes.iter().enumerate() {
            for b in &codes[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn packet_frames_follow_aes67_ptimes() {
        let mut c = Cfg::from_env();
        for (block, want) in [(16, 16), (48, 48), (96, 48), (192, 192), (480, 48)] {
            c.block = block;
            assert_eq!(c.packet_frames(), want);
        }
    }
}
