//! Echtzeitteil der Audio-Matrix (Kap. 107): liest bis zu 16 Eingangs-Flows, schreibt bis zu 32 Ausgangs-Flows und setzt die
//! Kreuzschiene aus `matrix.rs` um. Alles Zeitkritische läuft in **einem** Thread mit einem Ausgangstakt; Eingänge werden nach
//! Sample-Index gelesen (alle MXL-Flows tragen TAI-Indizes), ein Eingang ohne Daten ergibt Stille und hält die anderen nicht auf.
//! Kopierkanäle sind bitgleich (`copy_fragments`), nur Mischkanäle rechnen. Konfiguration, Eingangsverbindungen und Ausgänge
//! ändern sich zur Laufzeit über Befehle; nicht betroffene Ausgänge laufen ohne Unterbrechung weiter.
//!
//! Ändert sich die Kanalzahl eines Ausgangs, entsteht ein **neuer Flow mit neuer ID** (Entscheidung Nutzer 2026-11-24); der
//! Aufrufer erfährt es über [`OutputInfo`] und zieht die Sender nach.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::matrix::{ChanPlan, Config, Plan, compile, mix_into, validate};
use crate::mxl::MxlContext;
use crate::rawcopy::{check_split_source, copy_fragments};

const AUDIO_BATCH: usize = 480;
/// Der Ausgang liegt so weit hinter „jetzt“, damit auch etwas spätere Eingänge noch rechtzeitig da sind (1 Block = 10 ms).
const MARGIN_BLOCKS: u64 = 1;
/// Wartezeit je Eingang beim Lesen eines Blocks.
const INPUT_WAIT: Duration = Duration::from_millis(4);
/// Ein Eingang gilt als ohne Signal, wenn so lange kein Block kam.
const INPUT_LIVE: Duration = Duration::from_millis(500);

/// Ein Ausgang, wie er gerade im MXL-Raum liegt.
#[derive(Clone, Debug, PartialEq)]
pub struct OutputInfo {
    pub port_id: String,
    pub flow_id: String,
    pub name: String,
    pub channels: usize,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct InputStatus {
    pub connected: bool,
    /// Kam innerhalb der letzten 500 ms ein Block.
    pub live: bool,
    /// Kanäle des verbundenen Flows.
    pub channels: u32,
}

#[derive(Default)]
pub struct Shared {
    pub outputs: Mutex<Vec<OutputInfo>>,
    pub inputs: Mutex<HashMap<String, InputStatus>>,
    pub flowed: Arc<AtomicBool>,
    /// Anzahl Blöcke, in denen ein Mischkanal über 1,0 lag.
    pub overs: AtomicU64,
}

type Reply<T> = Sender<Result<T, String>>;

enum Cmd {
    Config(Box<Config>, Reply<Vec<OutputInfo>>),
    Connect { input: String, flow_id: Option<String>, reply: Reply<()> },
}

pub struct RawAudioMatrix {
    tx: Sender<Cmd>,
    running: Arc<AtomicBool>,
    handle: Mutex<Option<JoinHandle<()>>>,
    pub shared: Arc<Shared>,
}

struct Writer {
    info: OutputInfo,
    writer: mxl::SamplesWriter,
}

struct Reader {
    reader: mxl::SamplesReader,
    channels: u32,
    last_ok: std::cell::Cell<Option<std::time::Instant>>,
}

fn zero(dst: (&mut [u8], &mut [u8])) {
    dst.0.fill(0);
    dst.1.fill(0);
}

fn read_f32(src: (&[u8], &[u8])) -> Vec<f32> {
    let bytes: Vec<u8> = src.0.iter().chain(src.1.iter()).copied().collect();
    bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

fn write_f32(v: &[f32], dst: (&mut [u8], &mut [u8])) {
    let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
    copy_fragments((&bytes, &[]), dst);
}

impl RawAudioMatrix {
    /// Startet den Thread ohne Eingänge und Ausgänge; Konfiguration folgt über [`set_config`](Self::set_config).
    pub fn start(in_ctx: Arc<MxlContext>, out_ctx: Arc<MxlContext>, sample_rate: u32, label_prefix: String) -> Self {
        let (tx, rx) = channel::<Cmd>();
        let running = Arc::new(AtomicBool::new(true));
        let shared = Arc::new(Shared::default());
        let (run, sh) = (running.clone(), shared.clone());
        let handle = thread::Builder::new()
            .name("mxl-audio-matrix".into())
            .spawn(move || engine(in_ctx, out_ctx, sample_rate, label_prefix, rx, run, sh))
            .expect("thread");
        RawAudioMatrix { tx, running, handle: Mutex::new(Some(handle)), shared }
    }

    /// Wendet eine neue Konfiguration an (geprüft). Gibt die Ausgänge mit ihren Flow-IDs zurück: gleiche Port-ID und gleiche
    /// Kanalzahl behalten ihren Flow, alle anderen bekommen einen neuen (`new_flow_id` liefert die ID).
    pub fn set_config(&self, config: Config) -> Result<Vec<OutputInfo>, String> {
        validate(&config)?;
        let (r, rx) = channel();
        self.tx.send(Cmd::Config(Box::new(config), r)).map_err(|_| "Matrix-Thread beendet".to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Matrix-Thread antwortet nicht".to_string())?
    }

    /// Verbindet einen Eingang mit einem Flow (`None` trennt ihn). Prüft Format (float32, 48 kHz) und Kanalzahl.
    pub fn connect_input(&self, input: &str, flow_id: Option<String>) -> Result<(), String> {
        let (reply, rx) = channel();
        self.tx.send(Cmd::Connect { input: input.to_string(), flow_id, reply }).map_err(|_| "Matrix-Thread beendet".to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Matrix-Thread antwortet nicht".to_string())?
    }

    pub fn flowing(&self) -> bool {
        self.shared.flowed.load(Ordering::Relaxed)
    }
}

impl Drop for RawAudioMatrix {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(h) = self.handle.lock().expect("lock poisoned").take() {
            let _ = h.join();
        }
    }
}

fn new_flow_id() -> String {
    // Version-4-UUID aus dem Zufall des Betriebssystems, ohne zusätzliche Abhängigkeit.
    let mut b = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = std::io::Read::read_exact(&mut f, &mut b);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn output_def(info: &OutputInfo, port: &crate::matrix::Port, sample_rate: u32, prefix: &str) -> String {
    let labels: Vec<serde_json::Value> = port.channels.iter().map(|c| match &c.symbol {
        Some(s) => serde_json::json!({"label": c.label, "symbol": s}),
        None => serde_json::json!({"label": c.label}),
    }).collect();
    let mut def: serde_json::Value = serde_json::from_str(&crate::mxl::audio_flow_def(&info.flow_id, &format!("{prefix} {}", info.name), sample_rate, info.channels as u32)).unwrap_or_default();
    if let Some(m) = def.as_object_mut() {
        // Kanalbeschriftung als Tag am Flow (IS-04 führt `channels[]` an der Source, die MXL-flow_def kennt kein solches Feld).
        m.get_mut("tags").and_then(|t| t.as_object_mut()).map(|t| t.insert("urn:x-omp:tag:channels/v1.0".into(), serde_json::json!([serde_json::Value::Array(labels).to_string()])));
    }
    def.to_string()
}

fn engine(in_ctx: Arc<MxlContext>, out_ctx: Arc<MxlContext>, rate: u32, prefix: String, rx: Receiver<Cmd>, running: Arc<AtomicBool>, shared: Arc<Shared>) {
    let mut config = Config::default();
    let mut plan = Plan::default();
    let mut writers: Vec<Writer> = Vec::new();
    let mut readers: HashMap<String, Reader> = HashMap::new();
    let batch = AUDIO_BATCH as u64;
    let now_index = |c: &MxlContext| c.ns_to_index(c.now_ns(), rate, 1).unwrap_or(0);
    let mut index = now_index(&in_ctx).saturating_sub(batch * 3);

    while running.load(Ordering::Relaxed) {
        // Befehle zuerst (nicht blockierend).
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Cmd::Config(new, reply) => {
                    let result = apply_config(&new, &mut writers, &out_ctx, rate, &prefix);
                    if result.is_ok() {
                        plan = compile(&new);
                        // Eingänge, die es nicht mehr gibt, abbauen.
                        readers.retain(|id, _| new.inputs.iter().any(|p| &p.id == id));
                        shared.inputs.lock().expect("lock poisoned").retain(|id, _| readers.contains_key(id));
                        config = *new;
                        *shared.outputs.lock().expect("lock poisoned") = writers.iter().map(|w| w.info.clone()).collect();
                    }
                    let _ = reply.send(result.map(|_| writers.iter().map(|w| w.info.clone()).collect()));
                }
                Cmd::Connect { input, flow_id, reply } => {
                    let r = connect(&mut readers, &config, &in_ctx, rate, &input, flow_id.as_deref());
                    let mut st = shared.inputs.lock().expect("lock poisoned");
                    match readers.get(&input) {
                        Some(rd) => {
                            st.insert(input, InputStatus { connected: true, live: false, channels: rd.channels });
                        }
                        None => {
                            st.remove(&input);
                        }
                    }
                    let _ = reply.send(r);
                }
            }
        }

        // Pacing: erst arbeiten, wenn der Block samt Spielraum vergangen ist.
        let now = now_index(&in_ctx);
        if index + batch * (1 + MARGIN_BLOCKS) > now {
            thread::sleep(Duration::from_millis(2));
            continue;
        }
        if now > index + batch * 100 {
            index = now.saturating_sub(batch * (1 + MARGIN_BLOCKS) + batch);
        }
        if writers.is_empty() {
            index += batch;
            continue;
        }

        // Eingangsblöcke holen: je Eingang Some(Daten) oder None (Stille).
        let order: Vec<&String> = plan.inputs.iter().collect();
        let datas: Vec<Option<_>> = order
            .iter()
            .map(|id| {
                let rd = readers.get(*id)?;
                match rd.reader.get_samples(index, AUDIO_BATCH, INPUT_WAIT) {
                    Ok(d) => {
                        rd.last_ok.set(Some(std::time::Instant::now()));
                        Some(d)
                    }
                    Err(_) => None,
                }
            })
            .collect();
        {
            let mut st = shared.inputs.lock().expect("lock poisoned");
            for (id, rd) in &readers {
                if let Some(s) = st.get_mut(id) {
                    s.live = rd.last_ok.get().is_some_and(|t| t.elapsed() < INPUT_LIVE);
                }
            }
        }

        let mut wrote = false;
        let mut over = false;
        for (w, op) in writers.iter().zip(plan.outputs.iter()) {
            let Ok(mut access) = w.writer.open_samples(index, AUDIO_BATCH) else { continue };
            for (k, ch) in op.channels.iter().enumerate() {
                let Ok(dst) = access.channel_data_mut(k) else { continue };
                match ch {
                    ChanPlan::Silence => zero(dst),
                    ChanPlan::Copy { input, ch } => match datas.get(*input).and_then(|d| d.as_ref()).filter(|d| *ch < d.num_of_channels()).and_then(|d| d.channel_data(*ch).ok()) {
                        Some(src) => copy_fragments(src, dst),
                        None => zero(dst),
                    },
                    ChanPlan::Mix(terms) => {
                        let bufs: Vec<Option<Vec<f32>>> = terms
                            .iter()
                            .map(|(i, c, _)| datas.get(*i).and_then(|d| d.as_ref()).filter(|d| *c < d.num_of_channels()).and_then(|d| d.channel_data(*c).ok()).map(read_f32))
                            .collect();
                        let sources: Vec<(Option<&[f32]>, f32)> = bufs.iter().zip(terms.iter()).map(|(b, t)| (b.as_deref(), t.2)).collect();
                        let mut out = vec![0.0f32; AUDIO_BATCH];
                        over |= mix_into(&mut out, &sources) > 1.0;
                        write_f32(&out, dst);
                    }
                }
            }
            wrote |= access.commit().is_ok();
        }
        if over {
            shared.overs.fetch_add(1, Ordering::Relaxed);
        }
        if wrote {
            shared.flowed.store(true, Ordering::Relaxed);
        }
        index += batch;
    }
}

/// Gleicht die Schreiber mit der neuen Konfiguration ab: behalten (gleiche ID + Kanalzahl), neu anlegen (neue Flow-ID),
/// entfernen. Fehler beim Anlegen lassen den bisherigen Stand unverändert.
fn apply_config(new: &Config, writers: &mut Vec<Writer>, out_ctx: &Arc<MxlContext>, rate: u32, prefix: &str) -> Result<(), String> {
    let mut next: Vec<Writer> = Vec::with_capacity(new.outputs.len());
    for port in &new.outputs {
        if let Some(pos) = writers.iter().position(|w| w.info.port_id == port.id && w.info.channels == port.channels.len()) {
            let mut w = writers.swap_remove(pos);
            w.info.name = port.name.clone();
            next.push(w);
            continue;
        }
        let info = OutputInfo { port_id: port.id.clone(), flow_id: new_flow_id(), name: port.name.clone(), channels: port.channels.len() };
        let def = output_def(&info, port, rate, prefix);
        let created = out_ctx.instance().create_flow_writer(&def, None).and_then(|(w, _, _)| w.to_samples_writer());
        match created {
            Ok(writer) => next.push(Writer { info, writer }),
            Err(e) => {
                // Bisherige Schreiber nicht verlieren: bereits übernommene zurücklegen.
                writers.extend(next);
                return Err(format!("Ausgang „{}“: {e}", port.name));
            }
        }
    }
    *writers = next;
    Ok(())
}

fn connect(readers: &mut HashMap<String, Reader>, config: &Config, ctx: &Arc<MxlContext>, rate: u32, input: &str, flow_id: Option<&str>) -> Result<(), String> {
    let port = config.inputs.iter().find(|p| p.id == input).ok_or_else(|| format!("Eingang „{input}“ gibt es nicht"))?;
    let Some(flow_id) = flow_id else {
        readers.remove(input);
        return Ok(());
    };
    let def = ctx.flow_def(flow_id).map_err(|e| format!("Quelle {flow_id}: {e}"))?;
    let (_, channels) = check_split_source(&def, rate, port.channels.len() as u32).map_err(|e| format!("Eingang „{}“: {e}", port.name))?;
    let reader = ctx.instance().create_flow_reader(flow_id).and_then(|r| r.to_samples_reader()).map_err(|e| format!("Eingang „{}“: {e}", port.name))?;
    readers.insert(input.to_string(), Reader { reader, channels, last_ok: std::cell::Cell::new(None) });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matrix::{Channel, Port, Route};

    fn port(id: &str, name: &str, n: usize) -> Port {
        Port { id: id.into(), name: name.into(), channels: (1..=n).map(|i| Channel { label: i.to_string(), symbol: None }).collect() }
    }
    fn route(out: &str, ch: usize, input: &str, in_ch: usize, g: Option<f32>) -> Route {
        Route { out: out.into(), ch, input: input.into(), in_ch, gain_db: g }
    }

    #[test]
    fn f32_roundtrip_over_ring_wrap_is_bit_exact() {
        let v = [0.1f32, -0.25, f32::MIN_POSITIVE, 1.0e-30, 0.999_999_9];
        let (mut a, mut b) = ([0u8; 6], [0u8; 14]);
        write_f32(&v, (&mut a, &mut b));
        assert_eq!(read_f32((&a, &b)), v);
    }

    #[test]
    fn flow_ids_are_valid_uuid_v4() {
        let id = new_flow_id();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert_ne!(id, new_flow_id());
    }

    /// Zwei Quellen (Kommentar mono = 0,5; Programm 2 Kanäle = 0,1/0,2) → ein 16-Kanal-Ausgang plus ein Mono-Ausgang;
    /// Neuzuordnung, Gain/Summe, Ausgang entfernen, Kanalzahl ändern (neue ID).
    #[test]
    #[ignore = "braucht die MXL-Laufzeit (libmxl, siehe deploy/dev/mxl.env)"]
    fn live_two_inputs_into_16_channels() {
        let dir = format!("/dev/shm/omp-matrix-test-{}", std::process::id());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = Arc::new(MxlContext::new(&dir).unwrap());
        let feed = |flow: &'static str, label: &'static str, values: Vec<f32>, stop: Arc<AtomicBool>| {
            let c = ctx.clone();
            let (w, _, _) = c.instance().create_flow_writer(&crate::mxl::audio_flow_def(flow, label, 48000, values.len() as u32), None).unwrap();
            let writer = w.to_samples_writer().unwrap();
            thread::spawn(move || {
                let mut idx = c.ns_to_index(c.now_ns(), 48000, 1).unwrap().saturating_sub(AUDIO_BATCH as u64 * 6);
                while !stop.load(Ordering::Relaxed) {
                    if let Ok(mut a) = writer.open_samples(idx, AUDIO_BATCH) {
                        for (ch, v) in values.iter().enumerate() {
                            if let Ok(dst) = a.channel_data_mut(ch) {
                                let buf: Vec<u8> = (0..AUDIO_BATCH).flat_map(|_| v.to_le_bytes()).collect();
                                copy_fragments((&buf, &[]), dst);
                            }
                        }
                        let _ = a.commit();
                    }
                    idx += AUDIO_BATCH as u64;
                    while c.ns_to_index(c.now_ns(), 48000, 1).unwrap() + (AUDIO_BATCH as u64) < idx {
                        thread::sleep(Duration::from_millis(5));
                    }
                }
            })
        };
        let stop = Arc::new(AtomicBool::new(false));
        let (s1, s2) = ("00000000-0000-4000-8000-0000000000c1", "00000000-0000-4000-8000-0000000000c2");
        let f1 = feed(s1, "Kommentar", vec![0.5], stop.clone());
        let f2 = feed(s2, "Programm", vec![0.1, 0.2], stop.clone());
        thread::sleep(Duration::from_millis(300));

        let m = RawAudioMatrix::start(ctx.clone(), ctx.clone(), 48000, "Test".into());
        let mut cfg = Config {
            inputs: vec![port("k", "Kommentar", 1), port("p", "Programm", 2)],
            outputs: vec![port("o16", "PGM 16", 16), port("mono", "Komm Mono", 1)],
            routes: vec![route("o16", 1, "p", 1, None), route("o16", 2, "p", 2, None), route("o16", 9, "k", 1, None), route("mono", 1, "k", 1, Some(-6.0206))],
        };
        let outs = m.set_config(cfg.clone()).unwrap();
        m.connect_input("k", Some(s1.into())).unwrap();
        m.connect_input("p", Some(s2.into())).unwrap();
        assert!(m.connect_input("p", Some(s1.into())).is_err(), "Mono-Quelle darf nicht an 2-Kanal-Eingang");
        thread::sleep(Duration::from_millis(1200));
        assert!(m.flowing());
        let read = |flow: &str, ch: usize| -> (usize, f32) {
            let r = ctx.instance().create_flow_reader(flow).and_then(|r| r.to_samples_reader()).unwrap();
            let index = ctx.ns_to_index(ctx.now_ns(), 48000, 1).unwrap().saturating_sub(AUDIO_BATCH as u64 * 3);
            let d = r.get_samples(index, AUDIO_BATCH, Duration::from_millis(500)).unwrap();
            (d.num_of_channels(), read_f32(d.channel_data(ch).unwrap())[10])
        };
        let near = |a: f32, b: f32| (a - b).abs() < 1e-4;
        let o16 = outs.iter().find(|o| o.port_id == "o16").unwrap().clone();
        let mono = outs.iter().find(|o| o.port_id == "mono").unwrap().clone();
        assert_eq!(read(&o16.flow_id, 0), (16, 0.1));
        assert!(near(read(&o16.flow_id, 1).1, 0.2) && near(read(&o16.flow_id, 8).1, 0.5), "Programm/Kommentar");
        assert_eq!(read(&o16.flow_id, 15).1, 0.0, "nicht belegter Kanal = Stille");
        assert!(near(read(&mono.flow_id, 0).1, 0.25), "Mono mit −6 dB");
        // Umlegen zur Laufzeit: Kanal 3 = Programm 1 + Kommentar (Summe); Ausgang „mono“ bleibt, 16-Kanal-Fluss gleiche ID.
        cfg.routes.push(route("o16", 3, "p", 1, None));
        cfg.routes.push(route("o16", 3, "k", 1, None));
        let again = m.set_config(cfg.clone()).unwrap();
        assert_eq!(again.iter().find(|o| o.port_id == "o16").unwrap().flow_id, o16.flow_id, "gleiche Kanalzahl → gleicher Flow");
        thread::sleep(Duration::from_millis(500));
        assert!(near(read(&o16.flow_id, 2).1, 0.6), "Summe 0,1+0,5");
        // Kanalzahl ändern → neue Flow-ID, anderer Ausgang unberührt.
        cfg.outputs[1] = port("mono", "Komm Mono", 2);
        cfg.routes.retain(|r| r.out != "mono");
        let third = m.set_config(cfg.clone()).unwrap();
        let mono2 = third.iter().find(|o| o.port_id == "mono").unwrap();
        assert_ne!(mono2.flow_id, mono.flow_id);
        assert_eq!(third.iter().find(|o| o.port_id == "o16").unwrap().flow_id, o16.flow_id);
        // Eingang trennen → Stille auf seinen Kanälen.
        m.connect_input("k", None).unwrap();
        thread::sleep(Duration::from_millis(400));
        assert!(near(read(&o16.flow_id, 8).1, 0.0), "getrennter Eingang = Stille");
        drop(m);
        stop.store(true, Ordering::Relaxed);
        let _ = (f1.join(), f2.join());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
