//! Reine Pufferlogik von `omp-playout-buffer` (Kapitel 39.2) — ohne GStreamer, ohne MXL, vollständig
//! testbar. Der Node-Teil (`pipeline.rs`) füttert [`Playout`] mit Bildern/Tonblöcken und holt im festen
//! Ausgabetakt (`tick_video`/`tick_audio`) das, was gesendet werden soll.
//!
//! **Modell:** Zeit steckt in den Daten (`ts` = Ursprungszeit in TAI-Nanosekunden, vom MXL-Lesepfad).
//! Der Ausgang läuft auf einer **eigenen Uhr** (ein Bild je Takt, ein Block je Takt) und wird nie vom
//! Eingang getrieben:
//!
//! * `Fill`: Vorlauf. Ausgang hält (letztes Bild/Schwarz, Stille), bis das älteste Bild `target` alt ist.
//! * `Run`: je Takt ein Bild aus dem Ring. Ist der Ring leer (Eingang weg), wechselt der Zustand nach
//!   `Hold` — das **bereits gepufferte** Material wurde vorher normal gesendet (Überbrückung bis zur
//!   Pufferlänge ohne sichtbare Störung).
//! * `Hold`: Ausgang hält (letztes Bild/Schwarz, Stille), bis das älteste neue Bild `resume` alt ist.
//!
//! **Ton** folgt dem Bild über die Ursprungszeit: je Block wird die erwartete Ton-Zeit aus dem zuletzt
//! gezeigten Bild + verstrichener Zeit berechnet; weicht die Lesestelle ab (Lücke, Sprung, Beschneiden),
//! wird gezielt verworfen oder Stille eingefügt. So bleiben Bild und Ton nach jedem Splice im
//! ursprünglichen Verhältnis, ohne dass einzelne Zeitstempel durchgereicht werden müssen — der Ausgang
//! bekommt ohnehin eine eigene, streng monotone Zeitleiste (Zeitstempel-Glättung durch Neuvergabe).
//!
//! **Speicher:** harte Grenzen in Bytes (`max_video_bytes`, `max_audio_bytes`); beim Überlauf fällt das
//! Älteste weg (gezählt in `dropped_*`).

use std::collections::VecDeque;

/// Ablaufzustand (gemeinsam für Bild und Ton).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Fill,
    Run,
    Hold,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Fill => "fill",
            State::Run => "run",
            State::Hold => "hold",
        }
    }
}

/// Was der Ausgang zeigt, solange kein frisches Bild kommt.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HoldMode {
    Last,
    Black,
}

impl HoldMode {
    pub fn parse(s: &str) -> Option<HoldMode> {
        match s {
            "last" => Some(HoldMode::Last),
            "black" => Some(HoldMode::Black),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            HoldMode::Last => "last",
            HoldMode::Black => "black",
        }
    }
}

/// Ausgabe-Entscheidung für einen Bildtakt.
#[derive(Debug, PartialEq, Eq)]
pub enum VideoOut<V> {
    /// Frisches Bild aus dem Ring.
    Frame(V),
    /// Letztes Bild noch einmal (Hold-Modus `last`).
    Repeat(V),
    /// Schwarzbild (kein letztes Bild bekannt oder Hold-Modus `black`).
    Black,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub sample_rate: u32,
    pub channels: u32,
    /// Zieltiefe in ns (Alter des ältesten Bildes beim Start von `Run`).
    pub target_ns: u64,
    /// Wiederaufnahme nach `Hold` (Alter des ältesten neuen Bildes); wird auf `target_ns` begrenzt.
    pub resume_ns: u64,
    /// Toleranz oberhalb `target_ns`, ab der je Takt ein Bild verworfen wird (Aufholen nach Stau).
    pub slack_ns: u64,
    pub hold_mode: HoldMode,
    pub max_video_bytes: usize,
    pub max_audio_bytes: usize,
    /// Wiederauffüll-Rate in ppm (Millionstel): nach einem überbrückten Ausfall ist die Puffertiefe kleiner
    /// als das Ziel — mit dieser Rate wird sie wieder aufgebaut (Bild: gelegentlich ein Bild doppelt,
    /// Ton: gleichmäßig eingefügte Zwischenwerte, ohne Tonhöhensprung). 0 = aus.
    pub refill_ppm: u32,
}

fn s2n(rate: u32, samples: u64) -> u64 {
    (samples as u128 * 1_000_000_000 / rate.max(1) as u128) as u64
}

fn n2s(rate: u32, ns: u64) -> u64 {
    (ns as u128 * rate.max(1) as u128 / 1_000_000_000) as u64
}

/// Abweichung Ton-Lesestelle ↔ erwartete Zeit, ab der neu ausgerichtet wird.
const SEEK_TOLERANCE_NS: u64 = 30_000_000;
/// Zeitstempel-Toleranz zwischen aufeinanderfolgenden Tonblöcken (exakte Ursprungszeit).
const AUDIO_EXACT_TOL_NS: u64 = 2_000_000;
/// Wie oben, wenn nur Ankunftszeiten vorliegen (Ursprung fehlt): Jitter nicht als Lücke werten.
const AUDIO_ARRIVAL_TOL_NS: u64 = 60_000_000;

struct VItem<V> {
    ts: u64,
    len: usize,
    data: V,
}

struct AItem {
    /// Ursprungszeit des ersten noch nicht gelesenen Samples.
    ts: u64,
    exact: bool,
    data: Vec<u8>,
    off: usize,
}

/// Zähler/Messwerte für Parameter und Tests.
#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub dropped_video: u64,
    pub dropped_audio_bytes: u64,
    pub trimmed_video: u64,
    pub underruns: u64,
    pub resumes: u64,
    pub hold_ticks: u64,
    pub silent_blocks: u64,
    pub audio_seeks: u64,
    pub audio_gap_samples: u64,
    pub audio_skipped_samples: u64,
    pub video_ts_jumps: u64,
    pub audio_ts_jumps: u64,
    /// Durch das Wiederauffüllen eingefügte Haltebilder / Tonwerte.
    pub refill_frames: u64,
    pub refill_samples: u64,
}

pub struct Playout<V: Clone> {
    cfg: Config,
    state: State,
    video: VecDeque<VItem<V>>,
    video_bytes: usize,
    audio: VecDeque<AItem>,
    audio_bytes: usize,
    last_video: Option<V>,
    /// (Ursprungszeit des zuletzt gezeigten frischen Bildes, Ausgabezeit dieses Taktes).
    v_anchor: Option<(u64, u64)>,
    /// Ursprungszeit des nächsten auszugebenden Samples; `None` = noch nicht ausgerichtet.
    audio_play: Option<u64>,
    video_connected: bool,
    audio_connected: bool,
    prev_video_ts: Option<u64>,
    prev_audio_end: Option<u64>,
    video_period_ns: u64,
    /// Wiederauffüllen läuft (Hysterese, s. `update_refill`).
    refilling: bool,
    acc_v: u64,
    acc_a: u64,
    pub stats: Stats,
}

impl<V: Clone> Playout<V> {
    pub fn new(cfg: Config, video_period_ns: u64) -> Self {
        Playout {
            cfg,
            state: State::Fill,
            video: VecDeque::new(),
            video_bytes: 0,
            audio: VecDeque::new(),
            audio_bytes: 0,
            last_video: None,
            v_anchor: None,
            audio_play: None,
            video_connected: false,
            audio_connected: false,
            prev_video_ts: None,
            prev_audio_end: None,
            video_period_ns: video_period_ns.max(1),
            refilling: false,
            acc_v: 0,
            acc_a: 0,
            stats: Stats::default(),
        }
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    pub fn video_len(&self) -> usize {
        self.video.len()
    }

    pub fn video_bytes(&self) -> usize {
        self.video_bytes
    }

    pub fn audio_bytes(&self) -> usize {
        self.audio_bytes
    }

    fn bpf(&self) -> usize {
        (self.cfg.channels.max(1) as usize) * 4
    }

    fn samples_to_ns(&self, samples: u64) -> u64 {
        s2n(self.cfg.sample_rate, samples)
    }

    /// Gepufferte Bildtiefe in ms (Anzahl × Bildabstand).
    pub fn video_fill_ms(&self) -> u64 {
        self.video.len() as u64 * self.video_period_ns / 1_000_000
    }

    /// Gepufferte Tondauer in ms.
    pub fn audio_fill_ms(&self) -> u64 {
        self.samples_to_ns((self.audio_bytes / self.bpf()) as u64) / 1_000_000
    }

    /// Alter (ms) des ältesten wartenden Bildes bzw. (ohne Bild-Eingang) Tonblocks.
    pub fn front_age_ms(&self, now: u64) -> u64 {
        self.master_front_ts().map_or(0, |ts| now.saturating_sub(ts) / 1_000_000)
    }

    pub fn refilling(&self) -> bool {
        self.refilling
    }

    pub fn set_refill_ppm(&mut self, ppm: u32) {
        self.cfg.refill_ppm = ppm;
        if ppm == 0 {
            self.refilling = false;
        }
    }

    /// Wiederauffüllen mit Hysterese: beginnt, wenn die Tiefe um mehr als `max(3 Bilder, 10 % Ziel)` unter
    /// dem Ziel liegt; endet, sobald sie weniger als ein Bild darunter liegt.
    fn update_refill(&mut self, now: u64) {
        if self.cfg.refill_ppm == 0 || self.state != State::Run {
            self.refilling = false;
            return;
        }
        let Some(ts) = self.master_front_ts() else {
            self.refilling = false;
            return;
        };
        let deficit = self.cfg.target_ns.saturating_sub(now.saturating_sub(ts));
        let start = (self.video_period_ns * 3).max(self.cfg.target_ns / 10);
        if self.refilling {
            if deficit < self.video_period_ns {
                self.refilling = false;
            }
        } else if deficit > start {
            self.refilling = true;
        }
        if !self.refilling {
            self.acc_v = 0;
            self.acc_a = 0;
        }
    }

    pub fn set_connected(&mut self, video: bool, audio: bool) {
        self.video_connected = video;
        self.audio_connected = audio;
    }

    /// Zieltiefe ändern (Parameter `bufferMs` bzw. Delay-Ausgleich). Wachsende Tiefe = erneuter Vorlauf
    /// (der Ausgang hält so lange); schrumpfende Tiefe wird über das Beschneiden abgebaut.
    pub fn set_target(&mut self, target_ns: u64) {
        let grow = target_ns > self.cfg.target_ns;
        self.cfg.target_ns = target_ns;
        if grow && self.state == State::Run {
            self.state = State::Fill;
            self.audio_play = None;
        }
    }

    pub fn set_resume(&mut self, resume_ns: u64) {
        self.cfg.resume_ns = resume_ns;
    }

    pub fn set_hold_mode(&mut self, mode: HoldMode) {
        self.cfg.hold_mode = mode;
    }

    pub fn set_limits(&mut self, max_video_bytes: usize, max_audio_bytes: usize) {
        self.cfg.max_video_bytes = max_video_bytes;
        self.cfg.max_audio_bytes = max_audio_bytes;
        self.enforce_video_limit();
        self.enforce_audio_limit();
    }

    // ---- Eingang ---------------------------------------------------------------------------------

    pub fn push_video(&mut self, ts: u64, len: usize, data: V) {
        if let Some(prev) = self.prev_video_ts {
            // Sprung = rückwärts oder mehr als 2,5 Bildabstände Lücke (Quellwechsel/Neustart).
            if ts < prev || ts - prev > self.video_period_ns * 5 / 2 {
                self.stats.video_ts_jumps += 1;
            }
        }
        self.prev_video_ts = Some(ts);
        self.video.push_back(VItem { ts, len, data });
        self.video_bytes += len;
        self.enforce_video_limit();
    }

    fn enforce_video_limit(&mut self) {
        // Mindestens ein Bild bleibt stehen, sonst könnte eine zu kleine Grenze den Ring leeren.
        while self.video_bytes > self.cfg.max_video_bytes && self.video.len() > 1 {
            if let Some(old) = self.video.pop_front() {
                self.video_bytes -= old.len;
                self.stats.dropped_video += 1;
            }
        }
    }

    /// `ts` = Ursprungszeit des ersten Samples, `exact` = stammt aus dem Ursprung (sonst Ankunftszeit).
    pub fn push_audio(&mut self, ts: u64, exact: bool, data: Vec<u8>) {
        let bpf = self.bpf();
        let data = {
            let mut d = data;
            d.truncate(d.len() / bpf * bpf);
            d
        };
        if data.is_empty() {
            return;
        }
        let samples = (data.len() / bpf) as u64;
        let tol = if exact { AUDIO_EXACT_TOL_NS } else { AUDIO_ARRIVAL_TOL_NS };
        if let Some(prev_end) = self.prev_audio_end
            && ts.abs_diff(prev_end) > tol.max(self.samples_to_ns(samples))
        {
            self.stats.audio_ts_jumps += 1;
        }
        self.prev_audio_end = Some(ts + self.samples_to_ns(samples));
        self.audio_bytes += data.len();
        self.audio.push_back(AItem { ts, exact, data, off: 0 });
        self.enforce_audio_limit();
    }

    fn enforce_audio_limit(&mut self) {
        while self.audio_bytes > self.cfg.max_audio_bytes && self.audio.len() > 1 {
            if let Some(old) = self.audio.pop_front() {
                let remaining = old.data.len() - old.off;
                self.audio_bytes -= remaining;
                self.stats.dropped_audio_bytes += remaining as u64;
            }
        }
    }

    // ---- Zustand ---------------------------------------------------------------------------------

    fn master_front_ts(&self) -> Option<u64> {
        if self.video_connected {
            self.video.front().map(|v| v.ts)
        } else if self.audio_connected {
            self.audio.front().map(|a| a.ts)
        } else {
            None
        }
    }

    fn update_state(&mut self, now: u64) {
        let front = self.master_front_ts();
        match self.state {
            State::Fill | State::Hold => {
                let need = if self.state == State::Fill {
                    self.cfg.target_ns
                } else {
                    self.cfg.resume_ns.min(self.cfg.target_ns)
                };
                if let Some(ts) = front
                    && now.saturating_sub(ts) >= need
                {
                    if self.state == State::Hold {
                        self.stats.resumes += 1;
                    }
                    self.state = State::Run;
                    // Ton richtet sich beim ersten Takt neu nach dem Bild aus.
                    self.audio_play = if self.video_connected { None } else { Some(ts) };
                    self.v_anchor = None;
                }
            }
            State::Run => {
                if front.is_none() {
                    self.state = State::Hold;
                    self.stats.underruns += 1;
                    self.audio_play = None;
                }
            }
        }
    }

    // ---- Ausgang ---------------------------------------------------------------------------------

    fn idle_video(&mut self) -> VideoOut<V> {
        self.stats.hold_ticks += 1;
        match (self.cfg.hold_mode, &self.last_video) {
            (HoldMode::Last, Some(v)) => VideoOut::Repeat(v.clone()),
            _ => VideoOut::Black,
        }
    }

    /// Ein Bildtakt. `now` = aktuelle Zeit in derselben Epoche wie die Ursprungszeiten (MXL-TAI).
    pub fn tick_video(&mut self, now: u64) -> VideoOut<V> {
        self.update_state(now);
        if self.state != State::Run {
            return self.idle_video();
        }
        // Aufholen: ist das älteste Bild deutlich älter als Ziel + Toleranz, ein Bild überspringen.
        if self.video_connected
            && self.video.len() > 1
            && let Some(front) = self.video.front()
            && now.saturating_sub(front.ts) > self.cfg.target_ns + self.cfg.slack_ns
            && let Some(old) = self.video.pop_front()
        {
            self.video_bytes -= old.len;
            self.stats.trimmed_video += 1;
        }
        self.update_refill(now);
        if self.refilling && self.video_connected && !self.video.is_empty() {
            // Wiederauffüllen: in `refill_ppm` Millionstel der Takte das letzte Bild noch einmal zeigen,
            // statt ein neues aus dem Ring zu nehmen — der Ring wächst dadurch um ein Bild.
            self.acc_v += self.cfg.refill_ppm as u64;
            if self.acc_v >= 1_000_000 && self.last_video.is_some() {
                self.acc_v -= 1_000_000;
                self.stats.refill_frames += 1;
                return match self.last_video.clone() {
                    Some(v) => VideoOut::Repeat(v),
                    None => VideoOut::Black,
                };
            }
        }
        match self.video.pop_front() {
            Some(item) => {
                self.video_bytes -= item.len;
                self.v_anchor = Some((item.ts, now));
                self.last_video = Some(item.data.clone());
                VideoOut::Frame(item.data)
            }
            None => {
                // Ohne Bild-Eingang (reiner Ton) ist ein leerer Ring der Normalfall.
                if self.video_connected {
                    self.state = State::Hold;
                    self.stats.underruns += 1;
                    self.audio_play = None;
                }
                self.idle_video()
            }
        }
    }

    /// Ein Tonblock mit `frames` Samples je Kanal (Stille, wo nichts zu senden ist).
    /// Rückgabe: Daten (interleaved F32LE) und ob der Block (teilweise) Stille ist.
    pub fn tick_audio(&mut self, now: u64, frames: usize) -> (Vec<u8>, bool) {
        self.update_state(now);
        if !self.video_connected {
            self.update_refill(now);
        }
        let bpf = self.bpf();
        let mut out = vec![0u8; frames * bpf];
        if self.state != State::Run {
            self.stats.silent_blocks += 1;
            // Beim Vorlauf/Hold darf sich der Tonpuffer nicht über die Grenze hinaus aufstauen:
            // die Grenze (`max_audio_bytes`) erzwingt `push_audio`.
            return (out, true);
        }
        // Erwartete Ursprungszeit am Ton-Ausgang aus dem Bild ableiten.
        let expected = if self.video_connected {
            self.v_anchor.map(|(ts, at)| ts + now.saturating_sub(at))
        } else {
            None
        };
        if self.video_connected && expected.is_none() {
            // Bild-Anker fehlt noch (erster Takt nach Run-Beginn): Ton wartet auf das erste Bild.
            self.stats.silent_blocks += 1;
            return (out, true);
        }
        // Beim Wiederauffüllen läuft der Ton absichtlich bis zu ein Bild hinter der Bildzeit her (s. Moduldoku).
        let seek_tol = if self.refilling { 2 * SEEK_TOLERANCE_NS } else { SEEK_TOLERANCE_NS };
        match (expected, self.audio_play) {
            (Some(e), None) => self.seek_audio(e),
            (Some(e), Some(p)) if p.abs_diff(e) > seek_tol => self.seek_audio(e),
            (None, None) => {
                if let Some(a) = self.audio.front() {
                    self.audio_play = Some(a.ts);
                }
            }
            _ => {}
        }
        let rate = self.cfg.sample_rate;
        let Some(mut play) = self.audio_play else {
            self.stats.silent_blocks += 1;
            return (out, true);
        };
        // Wiederauffüllen: `k` Zwischenwerte einfügen, also nur `frames - k` Samples aus dem Puffer nehmen.
        let k = if self.refilling && self.cfg.refill_ppm > 0 {
            self.acc_a += frames as u64 * self.cfg.refill_ppm as u64;
            let k = (self.acc_a / 1_000_000) as usize;
            self.acc_a %= 1_000_000;
            k.min(frames / 4)
        } else {
            0
        };
        let want = frames - k;
        let mut silent = false;
        let mut written = 0usize; // in Samples
        while written < want {
            let Some(front) = self.audio.front_mut() else {
                silent = true;
                // Ohne Daten läuft die Lesestelle mit (Stille), bleibt aber an der Zeitleiste.
                play += s2n(rate, (want - written) as u64);
                break;
            };
            let tol = if front.exact { AUDIO_EXACT_TOL_NS } else { AUDIO_ARRIVAL_TOL_NS };
            if front.ts > play + tol {
                // Lücke im Material: Stille bis zum Beginn der Daten.
                let gap = ((front.ts - play) as u128 * rate as u128 / 1_000_000_000) as usize;
                let n = gap.min(want - written).max(1);
                silent = true;
                self.stats.audio_gap_samples += n as u64;
                written += n;
                play += (n as u128 * 1_000_000_000 / rate as u128) as u64;
                continue;
            }
            if front.ts + tol < play {
                // Daten liegen hinter der Lesestelle: Überstehendes verwerfen.
                let behind = ((play - front.ts) as u128 * rate as u128 / 1_000_000_000) as usize;
                let avail = (front.data.len() - front.off) / bpf;
                let skip = behind.min(avail).max(1);
                front.off += skip * bpf;
                front.ts += (skip as u128 * 1_000_000_000 / rate as u128) as u64;
                self.audio_bytes -= skip * bpf;
                self.stats.audio_skipped_samples += skip as u64;
                if front.off >= front.data.len() {
                    self.audio.pop_front();
                }
                continue;
            }
            let avail = (front.data.len() - front.off) / bpf;
            let n = avail.min(want - written);
            let src = &front.data[front.off..front.off + n * bpf];
            out[written * bpf..(written + n) * bpf].copy_from_slice(src);
            front.off += n * bpf;
            let adv = (n as u128 * 1_000_000_000 / rate as u128) as u64;
            front.ts += adv;
            self.audio_bytes -= n * bpf;
            written += n;
            play += adv;
            if front.off >= front.data.len() {
                self.audio.pop_front();
            }
        }
        self.audio_play = Some(play);
        if silent {
            self.stats.silent_blocks += 1;
        }
        if k > 0 {
            out = stretch_block(&out[..want * bpf], want, k, self.cfg.channels.max(1) as usize);
            self.stats.refill_samples += k as u64;
        }
        (out, silent)
    }

    /// Lesestelle auf Ursprungszeit `e` setzen: älteres Material verwerfen.
    fn seek_audio(&mut self, e: u64) {
        let bpf = self.bpf();
        let rate = self.cfg.sample_rate;
        self.stats.audio_seeks += 1;
        while let Some(front) = self.audio.front_mut() {
            let n = ((front.data.len() - front.off) / bpf) as u64;
            let end = front.ts + s2n(rate, n);
            if end <= e {
                let remaining = front.data.len() - front.off;
                self.audio_bytes -= remaining;
                self.stats.audio_skipped_samples += n;
                self.audio.pop_front();
                continue;
            }
            if front.ts < e {
                let skip = n2s(rate, e - front.ts).min(n) as usize;
                front.off += skip * bpf;
                front.ts += s2n(rate, skip as u64);
                self.audio_bytes -= skip * bpf;
                self.stats.audio_skipped_samples += skip as u64;
            }
            break;
        }
        self.audio_play = Some(e);
    }
}

/// Dehnt einen Tonblock um `k` Zwischenwerte (je Kanal Mittel der Nachbarn), gleichmäßig verteilt — die Tonhöhe
/// ändert sich dabei um `k/want` (bei 1 % unhörbar), ohne Sprung oder Stille.
fn stretch_block(src: &[u8], want: usize, k: usize, ch: usize) -> Vec<u8> {
    let bpf = ch * 4;
    let mut out = Vec::with_capacity((want + k) * bpf);
    let mut next_insert = 1usize;
    let frame = |i: usize, c: usize| -> f32 {
        let o = i * bpf + c * 4;
        f32::from_le_bytes(src[o..o + 4].try_into().unwrap())
    };
    for i in 0..want {
        // Einfügepunkt vor Eingangsbild `p_j = (j * want) / (k + 1)`.
        while next_insert <= k && next_insert * want / (k + 1) == i {
            for c in 0..ch {
                let prev = if i == 0 { frame(0, c) } else { frame(i - 1, c) };
                out.extend_from_slice(&((prev + frame(i, c)) * 0.5).to_le_bytes());
            }
            next_insert += 1;
        }
        out.extend_from_slice(&src[i * bpf..(i + 1) * bpf]);
    }
    // Rest (Einfügepunkte am Blockende)
    while next_insert <= k {
        for c in 0..ch {
            out.extend_from_slice(&frame(want - 1, c).to_le_bytes());
        }
        next_insert += 1;
    }
    out
}

/// Schwarzbild im Format v210 (10 Bit 4:2:2, 6 Pixel je 16 Byte, Zeilen auf 48 Pixel/128 Byte
/// aufgefüllt): Y = 64, Cb = Cr = 512.
pub fn black_v210(width: u32, height: u32) -> Vec<u8> {
    let stride = (width as usize).div_ceil(48) * 128;
    let (y, c) = (64u32, 512u32);
    let w0 = c | (y << 10) | (c << 20);
    let w1 = y | (c << 10) | (y << 20);
    let w2 = c | (y << 10) | (c << 20);
    let w3 = y | (c << 10) | (y << 20);
    // Muster je 6 Pixel: (Cb0 Y0 Cr0) (Y1 Cb1 Y2) (Cr1 Y3 Cb2) (Y4 Cr2 Y5)
    let mut group = [0u8; 16];
    for (i, w) in [w0, w1, w2, w3].iter().enumerate() {
        group[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
    }
    let mut row = Vec::with_capacity(stride);
    for _ in 0..stride / 16 {
        row.extend_from_slice(&group);
    }
    let mut out = Vec::with_capacity(stride * height as usize);
    for _ in 0..height {
        out.extend_from_slice(&row);
    }
    out
}

/// Größe eines v210-Bildes in Bytes.
pub fn v210_frame_bytes(width: u32, height: u32) -> usize {
    (width as usize).div_ceil(48) * 128 * height as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;
    const PERIOD: u64 = 40 * MS; // 25 fps
    const RATE: u32 = 48_000;
    const CH: u32 = 2;

    fn cfg(target_ms: u64) -> Config {
        Config {
            sample_rate: RATE,
            channels: CH,
            target_ns: target_ms * MS,
            resume_ns: target_ms * MS,
            slack_ns: 200 * MS,
            hold_mode: HoldMode::Last,
            max_video_bytes: 1000,
            max_audio_bytes: 10_000_000,
            refill_ppm: 0,
        }
    }

    fn pl(target_ms: u64) -> Playout<u64> {
        let mut p = Playout::new(cfg(target_ms), PERIOD);
        p.set_connected(true, true);
        p
    }

    /// Ein Tonblock von 10 ms mit Ursprungszeit `ts`; jedes Sample trägt `tag`.
    fn ablock(ts: u64, tag: f32) -> Vec<u8> {
        let mut v = Vec::new();
        for _ in 0..(RATE / 100 * CH) {
            v.extend_from_slice(&tag.to_le_bytes());
        }
        let _ = ts;
        v
    }

    /// Speist `ms` Millisekunden Eingang in Echtzeit-Schritten von `from` an (Bild je 40 ms, Ton je 10 ms).
    fn feed(p: &mut Playout<u64>, from: u64, ms: u64) {
        let mut t = from;
        while t < from + ms * MS {
            if (t - from).is_multiple_of(PERIOD) || from == 0 && t.is_multiple_of(PERIOD) {
                p.push_video(t, 10, t / MS);
            }
            p.push_audio(t, true, ablock(t, 1.0));
            t += 10 * MS;
        }
    }

    #[test]
    fn fill_holds_black_then_runs_with_constant_delay() {
        let mut p = pl(400);
        let mut now = 0u64;
        let mut outs = Vec::new();
        // 2 s Betrieb: Eingang in Echtzeit, Ausgabetakt alle 40 ms
        while now < 2000 * MS {
            if now.is_multiple_of(PERIOD) {
                p.push_video(now, 10, now / MS);
            }
            outs.push((now, p.tick_video(now)));
            now += 10 * MS;
            // Bildtakt nur alle 40 ms: überspringe Zwischenschritte
            while !now.is_multiple_of(PERIOD) && now < 2000 * MS {
                now += 10 * MS;
            }
        }
        // Vorlauf: Schwarz bis zum ersten Run-Bild
        let first_frame = outs.iter().position(|(_, o)| matches!(o, VideoOut::Frame(_))).unwrap();
        assert!((10..=12).contains(&first_frame), "Vorlauf ~400 ms = ~10 Takte, war {first_frame}");
        assert!(outs[..first_frame].iter().all(|(_, o)| *o == VideoOut::Black));
        // danach lückenlos frische Bilder, jedes um genau die Zieltiefe verspätet
        for (t, o) in &outs[first_frame..] {
            match o {
                VideoOut::Frame(ts_ms) => {
                    let delay = t / MS - ts_ms;
                    assert!((400..=440).contains(&delay), "Delay {delay} ms bei {t}");
                }
                other => panic!("unerwartet {other:?} bei {t}"),
            }
        }
    }

    #[test]
    fn short_outage_is_bridged_without_hold() {
        let mut p = pl(1000);
        let mut now = 0u64;
        let mut holds_during = 0;
        let mut frames = 0;
        while now < 4000 * MS {
            // Eingang fällt von 1,5 s bis 2,3 s aus (0,8 s < Puffer 1,0 s)
            let outage = (1500 * MS..2300 * MS).contains(&now);
            if !outage {
                p.push_video(now, 10, now / MS);
            }
            match p.tick_video(now) {
                VideoOut::Frame(_) => frames += 1,
                _ if now > 1100 * MS => holds_during += 1,
                _ => {}
            }
            now += PERIOD;
        }
        assert_eq!(holds_during, 0, "Ausfall unter Pufferlänge darf nicht sichtbar werden");
        assert!(frames > 60);
        assert_eq!(p.stats.underruns, 0);
    }

    #[test]
    fn long_outage_holds_last_then_resumes_after_resume_threshold() {
        let mut p = pl(400);
        let mut now = 0u64;
        let mut repeats = 0;
        let mut resumed_at = None;
        while now < 6000 * MS {
            let outage = (1000 * MS..3000 * MS).contains(&now);
            if !outage {
                p.push_video(now, 10, now / MS);
            }
            match p.tick_video(now) {
                VideoOut::Repeat(_) => repeats += 1,
                VideoOut::Frame(_) if now > 3000 * MS && resumed_at.is_none() => resumed_at = Some(now),
                _ => {}
            }
            now += PERIOD;
        }
        assert!(repeats > 30, "Hold muss den Ausgang halten, Repeat-Takte = {repeats}");
        assert_eq!(p.stats.underruns, 1);
        assert_eq!(p.stats.resumes, 1);
        let r = resumed_at.expect("Wiederaufnahme");
        // erstes neues Bild bei 3000 ms, Wiederaufnahme nach resume (400 ms)
        assert!((3400 * MS..=3480 * MS).contains(&r), "Wiederaufnahme bei {} ms", r / MS);
        assert_eq!(p.state(), State::Run);
    }

    #[test]
    fn hold_black_mode_never_repeats() {
        let mut c = cfg(0);
        c.hold_mode = HoldMode::Black;
        let mut p = Playout::<u64>::new(c, PERIOD);
        p.set_connected(true, false);
        p.push_video(0, 10, 1);
        assert_eq!(p.tick_video(0), VideoOut::Frame(1));
        assert_eq!(p.tick_video(PERIOD), VideoOut::Black);
    }

    #[test]
    fn memory_is_bounded_under_endless_input() {
        let mut c = cfg(2500);
        c.max_video_bytes = 100 * 50;
        c.max_audio_bytes = 48_000 * 8 * 3;
        let mut p = Playout::<u64>::new(c, PERIOD);
        p.set_connected(true, true);
        // 10 Minuten Eingang bei gleichzeitigem Vorlauf ohne Ausgang (Worst Case: nichts wird abgeholt)
        let mut t = 0u64;
        let mut max_v = 0;
        let mut max_a = 0;
        while t < 600_000 * MS {
            if t.is_multiple_of(PERIOD) {
                p.push_video(t, 100, t / MS);
            }
            p.push_audio(t, true, ablock(t, 0.5));
            max_v = max_v.max(p.video_bytes());
            max_a = max_a.max(p.audio_bytes());
            t += 10 * MS;
        }
        assert!(max_v <= 100 * 50, "Video {max_v}");
        assert!(max_a <= 48_000 * 8 * 3, "Audio {max_a}");
        assert!(p.stats.dropped_video > 0 && p.stats.dropped_audio_bytes > 0);
    }

    #[test]
    fn catches_up_after_burst_by_trimming() {
        let mut p = pl(400);
        // 3 s Material auf einmal (Stau), Ausgang beginnt viel später
        for i in 0..75u64 {
            p.push_video(i * PERIOD, 10, i);
        }
        let now = 3000 * MS;
        let mut t = now;
        let mut last = 0;
        for _ in 0..40 {
            if let VideoOut::Frame(i) = p.tick_video(t) {
                last = i;
            }
            t += PERIOD;
        }
        assert!(p.stats.trimmed_video > 10, "Stau muss durch Verwerfen abgebaut werden");
        // am Ende liegt das gezeigte Bild nahe Ziel + Toleranz hinter der Echtzeit
        assert!(last > 40);
    }

    #[test]
    fn growing_target_triggers_new_fill() {
        let mut p = pl(200);
        let mut now = 0u64;
        for _ in 0..30 {
            p.push_video(now, 10, now / MS);
            p.tick_video(now);
            now += PERIOD;
        }
        assert_eq!(p.state(), State::Run);
        p.set_target(800 * MS);
        assert_eq!(p.state(), State::Fill);
        let mut repeats = 0;
        for _ in 0..30 {
            p.push_video(now, 10, now / MS);
            if matches!(p.tick_video(now), VideoOut::Repeat(_)) {
                repeats += 1;
            }
            now += PERIOD;
        }
        assert!(repeats >= 10, "Verzögerung wird durch Halten aufgebaut, Repeat = {repeats}");
        assert_eq!(p.state(), State::Run);
    }

    #[test]
    fn audio_follows_video_timestamps_across_a_splice() {
        let mut p = pl(200);
        // Eingang A: ts 0..1000 ms, danach Lücke bis 3000 ms, Eingang B ab 3000 ms (Ton trägt tag 2.0)
        let mut t = 0;
        while t < 1000 * MS {
            if t.is_multiple_of(PERIOD) {
                p.push_video(t, 10, t / MS);
            }
            p.push_audio(t, true, ablock(t, 1.0));
            t += 10 * MS;
        }
        let mut t = 3000 * MS;
        while t < 4000 * MS {
            if t.is_multiple_of(PERIOD) {
                p.push_video(t, 10, t / MS);
            }
            p.push_audio(t, true, ablock(t, 2.0));
            t += 10 * MS;
        }
        // Ausgabe in Echtzeit ab 200 ms Vorlauf; Eingangs-Zeit läuft mit dem Ausgang mit (Material ist da)
        let mut now = 1200 * MS;
        let mut tag_at_frame: Vec<(u64, f32)> = Vec::new();
        for _ in 0..(5000 / 10) {
            if now.is_multiple_of(PERIOD)
                && let VideoOut::Frame(ts_ms) = p.tick_video(now)
            {
                // Ton dieses Taktes
                let (a, _) = p.tick_audio(now, 480);
                let tag = f32::from_le_bytes(a[0..4].try_into().unwrap());
                tag_at_frame.push((ts_ms, tag));
            } else {
                let _ = p.tick_audio(now, 480);
            }
            now += 10 * MS;
        }
        // Bilder aus A (ts < 1000) haben Ton 1.0, Bilder aus B (ts ≥ 3000) haben Ton 2.0 — nie vertauscht.
        for (ts_ms, tag) in &tag_at_frame {
            if *ts_ms < 1000 {
                assert!(*tag == 1.0 || *tag == 0.0, "ts {ts_ms}: Ton {tag}");
            } else if *ts_ms >= 3100 {
                assert!(*tag == 2.0 || *tag == 0.0, "ts {ts_ms}: Ton {tag}");
            }
        }
        assert!(tag_at_frame.iter().any(|(ts, t)| *ts >= 3100 && *t == 2.0));
    }

    #[test]
    fn audio_only_runs_after_fill_and_sends_silence_when_empty() {
        let mut p = Playout::<u64>::new(cfg(100), PERIOD);
        p.set_connected(false, true);
        let mut now = 0;
        let mut sounding = 0;
        for i in 0..100u64 {
            p.push_audio(now, true, ablock(now, 1.0));
            let (a, silent) = p.tick_audio(now, 480);
            if !silent && a.iter().any(|b| *b != 0) {
                sounding += 1;
            }
            let _ = i;
            now += 10 * MS;
        }
        assert!(sounding > 80, "nach 100 ms Vorlauf läuft der Ton, Takte mit Ton = {sounding}");
        // Eingang weg: Stille, kein Absturz, Zustand Hold bis wieder Material da ist
        // erst den Rest des Puffers abspielen (~100 ms), danach Stille
        let mut t = now;
        for _ in 0..30 {
            let _ = p.tick_audio(t, 480);
            t += 10 * MS;
        }
        let (a, silent) = p.tick_audio(t, 480);
        assert!(silent && a.iter().all(|b| *b == 0));
        assert_eq!(p.state(), State::Hold);
    }

    #[test]
    fn no_input_connected_outputs_black_and_silence_forever() {
        let mut p = Playout::<u64>::new(cfg(500), PERIOD);
        for i in 0..50u64 {
            assert_eq!(p.tick_video(i * PERIOD), VideoOut::Black);
            let (a, silent) = p.tick_audio(i * PERIOD, 480);
            assert!(silent && a.iter().all(|b| *b == 0));
        }
        assert_eq!(p.state(), State::Fill);
    }

    #[test]
    fn timestamp_jumps_are_counted_not_propagated() {
        let mut p = pl(200);
        p.push_video(1_000 * MS, 10, 1);
        p.push_video(1_040 * MS, 10, 2);
        p.push_video(500 * MS, 10, 3); // rückwärts
        p.push_video(10_000 * MS, 10, 4); // Vorwärtssprung
        assert_eq!(p.stats.video_ts_jumps, 2);
    }

    #[test]
    fn black_v210_has_expected_size_and_pattern() {
        let b = black_v210(1920, 1080);
        assert_eq!(b.len(), v210_frame_bytes(1920, 1080));
        assert_eq!(b.len(), 5_120 * 1080);
        // erstes Wort: Cb=512, Y=64, Cr=512
        let w0 = u32::from_le_bytes(b[0..4].try_into().unwrap());
        assert_eq!(w0 & 0x3ff, 512);
        assert_eq!((w0 >> 10) & 0x3ff, 64);
        assert_eq!((w0 >> 20) & 0x3ff, 512);
        // 848 Pixel Breite: Zeile auf 48 aufgefüllt (18 Gruppen × 128 Byte)
        assert_eq!(v210_frame_bytes(848, 480), 18 * 128 * 480);
    }

    #[test]
    fn feed_helper_is_consistent() {
        // Absicherung der Hilfsfunktion selbst
        let mut p = pl(100);
        feed(&mut p, 0, 400);
        assert!(p.video_len() >= 9);
        assert_eq!(p.audio_fill_ms(), 400);
    }

    /// Hilfe: lässt Eingang (Bild + Ton) und Ausgabetakt in Echtzeit-Schritten laufen; `outage` = Ausfallfenster [ns].
    fn run_sim(p: &mut Playout<u64>, from: u64, to: u64, outage: Option<(u64, u64)>) -> Vec<VideoOut<u64>> {
        let mut outs = Vec::new();
        let mut t = from;
        while t < to {
            let down = outage.is_some_and(|(a, b)| t >= a && t < b);
            if !down {
                if t.is_multiple_of(PERIOD) {
                    p.push_video(t, 10, t / MS);
                }
                p.push_audio(t, true, ablock(t, 1.0));
            }
            if t.is_multiple_of(PERIOD) {
                outs.push(p.tick_video(t));
            }
            let _ = p.tick_audio(t, 480);
            t += 10 * MS;
        }
        outs
    }

    #[test]
    fn depth_is_rebuilt_after_a_bridged_outage() {
        let mut c = cfg(1000);
        c.refill_ppm = 20_000; // 2 % → 600 ms in ~30 s
        c.max_video_bytes = 100_000;
        let mut p = Playout::<u64>::new(c, PERIOD);
        p.set_connected(true, true);
        // 4 s Vorlauf/Betrieb, 0,6 s Ausfall (Puffer 1,0 s überbrückt ihn), danach 60 s Normalbetrieb
        run_sim(&mut p, 0, 4_000 * MS, None);
        run_sim(&mut p, 4_000 * MS, 4_600 * MS, Some((4_000 * MS, 4_600 * MS)));
        // Bis die gepufferten alten Bilder abgespielt sind, bleibt die Verzögerung 1,0 s; danach springt der Ausgang
        // über die Lücke und liegt nur noch ~0,4 s hinter dem Eingang.
        run_sim(&mut p, 4_600 * MS, 6_000 * MS, None);
        assert!(p.front_age_ms(6_000 * MS) < 700, "Tiefe nach Ausfall: {}", p.front_age_ms(6_000 * MS));
        assert_eq!(p.stats.underruns, 0);
        let mut t = 6_000 * MS;
        let mut stretched_seen = false;
        while t < 70_000 * MS {
            run_sim(&mut p, t, t + 1_000 * MS, None);
            stretched_seen |= p.refilling();
            t += 1_000 * MS;
        }
        assert!(stretched_seen, "Wiederauffüllen muss anlaufen");
        let age = p.front_age_ms(70_000 * MS);
        assert!((960..=1040).contains(&age), "Tiefe nach Wiederauffüllen: {age} ms (Ziel 1000)");
        assert!(!p.refilling(), "Wiederauffüllen endet am Ziel");
        assert!(p.stats.refill_frames >= 12 && p.stats.refill_frames <= 18, "Haltebilder: {}", p.stats.refill_frames);
        assert!(p.stats.refill_samples > 20_000, "eingefügte Tonwerte: {}", p.stats.refill_samples);
    }

    #[test]
    fn no_refill_when_depth_is_on_target_or_disabled() {
        let mut c = cfg(500);
        c.refill_ppm = 20_000;
        let mut p = Playout::<u64>::new(c, PERIOD);
        p.set_connected(true, true);
        run_sim(&mut p, 0, 20_000 * MS, None);
        assert_eq!(p.stats.refill_frames, 0);
        // abgeschaltet: auch mit Defizit kein Wiederauffüllen
        let mut c = cfg(1000);
        c.refill_ppm = 0;
        let mut q = Playout::<u64>::new(c, PERIOD);
        q.set_connected(true, true);
        run_sim(&mut q, 0, 4_000 * MS, None);
        run_sim(&mut q, 4_000 * MS, 4_600 * MS, Some((4_000 * MS, 4_600 * MS)));
        run_sim(&mut q, 4_600 * MS, 20_000 * MS, None);
        assert_eq!(q.stats.refill_frames, 0);
        assert!(q.front_age_ms(20_000 * MS) < 500);
    }

    #[test]
    fn stretch_block_inserts_without_clicks() {
        let ch = 2;
        let want = 480;
        // gleichmäßige Rampe je Kanal: Zwischenwerte müssen monoton zwischen den Nachbarn liegen
        let mut src = Vec::new();
        for i in 0..want {
            for _ in 0..ch {
                src.extend_from_slice(&(i as f32 / want as f32).to_le_bytes());
            }
        }
        let out = stretch_block(&src, want, 5, ch);
        assert_eq!(out.len(), (want + 5) * ch * 4);
        let vals: Vec<f32> = out.chunks_exact(8).map(|c| f32::from_le_bytes(c[..4].try_into().unwrap())).collect();
        for w in vals.windows(2) {
            assert!(w[1] >= w[0], "monoton: {} → {}", w[0], w[1]);
            assert!(w[1] - w[0] < 0.004, "keine Sprünge: {}", w[1] - w[0]);
        }
    }
}
