//! Pult-Logik (Kapitel 93) — Rust-Gegenstück zu `ui/shell/midi/surface-logic.ts`, `mcu-unit.ts` und `sim-surface.ts`.
//! Reine Logik ohne Ein-/Ausgabe: Ereignisse und Modell hinein, Mischer-Befehle und Soll-Zustand je Einheit heraus.

use std::collections::{BTreeMap, HashMap};

use crate::fader::{db_to_fader, fader_to_db};
use crate::mcu::*;

#[derive(Clone, Debug, PartialEq)]
pub struct StripInfo {
    pub id: String,
    pub label: String,
    pub gain_db: Option<f64>,
    pub mute: bool,
    pub pfl: bool,
    pub on_air: bool,
    pub level: f64,
    pub pan: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum MixerCmd {
    Gain { id: String, db: f64 },
    Mute { id: String, muted: bool },
    Pfl { id: String, enabled: bool },
    Pan { id: String, pan: f64 },
    Master { db: f64 },
}

#[derive(Clone, Copy, Debug)]
pub struct UnitSpec {
    pub strips: usize,
    pub has_master: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Ring {
    pub mode: RingMode,
    pub value: i32,
    pub led: bool,
}

#[derive(Clone, Debug)]
pub struct UnitState {
    pub faders: [Option<i32>; 9],
    pub leds: BTreeMap<u8, Led>,
    pub rings: Vec<Ring>,
    pub meters: Vec<i32>,
    pub lcd_top: Vec<String>,
    pub lcd_bottom: Vec<String>,
    pub seven_seg: String,
}

#[derive(Clone, Debug)]
pub struct LogicOptions {
    pub units: Vec<UnitSpec>,
    pub gain_interval_ms: u64,
    pub echo_guard_ms: u64,
    pub pan_step: f64,
    pub hold_ms: u64,
    /// Master-Fader hat ein Ziel (Aux-Bus).
    pub master_target: bool,
}

impl LogicOptions {
    pub fn new(units: Vec<UnitSpec>) -> Self {
        LogicOptions { units, gain_interval_ms: 50, echo_guard_ms: 300, pan_step: 0.05, hold_ms: 2000, master_target: false }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LcdMode {
    Gain,
    Pan,
}

struct Held {
    db: f64,
    at: u64,
}

pub struct SurfaceLogic {
    o: LogicOptions,
    channels: Vec<StripInfo>,
    master: Option<f64>,
    pub bank: usize,
    pub selected: Option<String>,
    pub lcd_mode: LcdMode,
    touch: HashMap<(usize, u8), bool>,
    last_host_move: HashMap<(usize, u8), u64>,
    pending: BTreeMap<String, f64>,
    master_pending: Option<f64>,
    last_sent: HashMap<String, u64>,
    master_last_sent: Option<u64>,
    held: HashMap<String, Held>,
    held_master: Option<Held>,
    cmds: Vec<MixerCmd>,
    buttons: Vec<(String, bool)>,
}

pub fn fmt_db(db: Option<f64>) -> String {
    match db {
        None => String::new(),
        Some(d) if d <= -59.95 => "-inf".to_string(),
        Some(d) => format!("{}{:.1}", if d > 0.0 { "+" } else { "" }, d),
    }
}

pub fn fmt_pan(pan: Option<f64>) -> String {
    match pan {
        None => String::new(),
        Some(p) if p.abs() < 0.005 => "C".to_string(),
        Some(p) => format!("{}{}", if p < 0.0 { "L" } else { "R" }, (p.abs() * 100.0).round() as i32),
    }
}

impl SurfaceLogic {
    pub fn new(o: LogicOptions) -> Self {
        SurfaceLogic {
            o,
            channels: vec![],
            master: None,
            bank: 0,
            selected: None,
            lcd_mode: LcdMode::Gain,
            touch: HashMap::new(),
            last_host_move: HashMap::new(),
            pending: BTreeMap::new(),
            master_pending: None,
            last_sent: HashMap::new(),
            master_last_sent: None,
            held: HashMap::new(),
            held_master: None,
            cmds: vec![],
            buttons: vec![],
        }
    }

    pub fn total_strips(&self) -> usize {
        self.o.units.iter().map(|u| u.strips).sum()
    }
    pub fn channel_count(&self) -> usize {
        self.channels.len()
    }

    /// Befehle an den Mischer, die seit dem letzten Aufruf angefallen sind.
    pub fn drain_cmds(&mut self) -> Vec<MixerCmd> {
        std::mem::take(&mut self.cmds)
    }
    /// Tasten, die die Logik nicht selbst verbraucht (Transport, F-Tasten …) — als Ereignis für Workflows.
    pub fn drain_buttons(&mut self) -> Vec<(String, bool)> {
        std::mem::take(&mut self.buttons)
    }

    fn clamp_bank(&self, b: i64) -> usize {
        let max = self.channels.len().saturating_sub(self.total_strips()) as i64;
        b.clamp(0, max) as usize
    }

    pub fn set_bank_delta(&mut self, d: i64) {
        self.bank = self.clamp_bank(self.bank as i64 + d);
    }

    pub fn set_model(&mut self, channels: Vec<StripInfo>, master: Option<f64>) {
        // Pegel und On-Air stammen aus dem Live-Strom: nicht überschreiben, wenn das neue Modell keine hat
        self.channels = channels;
        self.master = master;
        if let Some(s) = &self.selected {
            if !self.channels.iter().any(|c| &c.id == s) {
                self.selected = None;
            }
        }
        self.bank = self.clamp_bank(self.bank as i64);
        let pend = &self.pending;
        let ch = &self.channels;
        self.held.retain(|id, h| {
            let confirmed = ch.iter().find(|c| &c.id == id).and_then(|c| c.gain_db).is_some_and(|g| (g - h.db).abs() < 0.15);
            !(confirmed && !pend.contains_key(id))
        });
        if let (Some(h), Some(m)) = (&self.held_master, self.master) {
            if (m - h.db).abs() < 0.15 && self.master_pending.is_none() {
                self.held_master = None;
            }
        }
    }

    pub fn set_levels(&mut self, levels: &HashMap<String, f64>) {
        for c in &mut self.channels {
            if let Some(l) = levels.get(&c.id) {
                c.level = *l;
            }
        }
    }
    pub fn set_on_air(&mut self, on_air: &HashMap<String, bool>) {
        for c in &mut self.channels {
            if let Some(a) = on_air.get(&c.id) {
                c.on_air = *a;
            }
        }
    }

    fn unit_offset(&self, unit: usize) -> usize {
        self.o.units[..unit].iter().map(|u| u.strips).sum()
    }

    fn strip_idx(&self, unit: usize, i: usize) -> Option<usize> {
        if i >= self.o.units[unit].strips {
            return None;
        }
        let k = self.bank + self.unit_offset(unit) + i;
        (k < self.channels.len()).then_some(k)
    }

    pub fn note_host_move(&mut self, unit: usize, strip: u8, now: u64) {
        self.last_host_move.insert((unit, strip), now);
    }

    pub fn is_touched(&self, unit: usize, strip: u8) -> bool {
        self.touch.get(&(unit, strip)).copied().unwrap_or(false)
    }

    pub fn on_event(&mut self, unit: usize, ev: &McuEvent, now: u64) {
        let Some(spec) = self.o.units.get(unit).copied() else { return };
        match ev {
            McuEvent::Touch { strip, down } => {
                self.touch.insert((unit, *strip), *down);
                if !down {
                    self.flush(now, true);
                    self.last_host_move.remove(&(unit, *strip));
                }
            }
            McuEvent::Fader { strip, value } => {
                let touched = self.is_touched(unit, *strip);
                let echo = self.last_host_move.get(&(unit, *strip)).is_some_and(|t| now.saturating_sub(*t) < self.o.echo_guard_ms);
                if !touched && echo {
                    return;
                }
                if *strip == 8 {
                    if spec.has_master && self.o.master_target {
                        let db = fader_to_db(*value);
                        self.held_master = Some(Held { db, at: now });
                        self.master_pending = Some(db);
                        self.flush(now, false);
                    }
                    return;
                }
                let Some(k) = self.strip_idx(unit, *strip as usize) else { return };
                let id = self.channels[k].id.clone();
                let db = fader_to_db(*value);
                self.held.insert(id.clone(), Held { db, at: now });
                self.pending.insert(id, db);
                self.flush(now, false);
            }
            McuEvent::Button { note, name, down } => {
                if *down {
                    if !self.press(unit, *note) {
                        if let Some(n) = name {
                            self.buttons.push((n.clone(), true));
                        }
                    }
                } else if let Some(n) = name {
                    if !is_consumed(*note) {
                        self.buttons.push((n.clone(), false));
                    }
                }
            }
            McuEvent::Vpot { strip, delta } => {
                let Some(k) = self.strip_idx(unit, *strip as usize) else { return };
                let step = self.o.pan_step;
                let c = &mut self.channels[k];
                let Some(p) = c.pan else { return };
                let pan = ((p + *delta as f64 * step).clamp(-1.0, 1.0) * 100.0).round() / 100.0;
                c.pan = Some(pan);
                let id = c.id.clone();
                self.cmds.push(MixerCmd::Pan { id, pan });
            }
            _ => {}
        }
    }

    /// `true`, wenn die Taste hier verbraucht wurde.
    fn press(&mut self, unit: usize, note: u8) -> bool {
        let within = |base: u8| if (base..base + 8).contains(&note) { Some((note - base) as usize) } else { None };
        if let Some(i) = within(NOTE_MUTE) {
            if let Some(k) = self.strip_idx(unit, i) {
                let c = &mut self.channels[k];
                c.mute = !c.mute;
                let (id, muted) = (c.id.clone(), c.mute);
                self.cmds.push(MixerCmd::Mute { id, muted });
            }
            return true;
        }
        if let Some(i) = within(NOTE_SOLO) {
            if let Some(k) = self.strip_idx(unit, i) {
                let c = &mut self.channels[k];
                c.pfl = !c.pfl;
                let (id, enabled) = (c.id.clone(), c.pfl);
                self.cmds.push(MixerCmd::Pfl { id, enabled });
            }
            return true;
        }
        if let Some(i) = within(NOTE_SELECT) {
            if let Some(k) = self.strip_idx(unit, i) {
                self.selected = Some(self.channels[k].id.clone());
            }
            return true;
        }
        if let Some(i) = within(NOTE_VPOT_PUSH) {
            if let Some(k) = self.strip_idx(unit, i) {
                let c = &mut self.channels[k];
                if c.pan.is_some() {
                    c.pan = Some(0.0);
                    let id = c.id.clone();
                    self.cmds.push(MixerCmd::Pan { id, pan: 0.0 });
                }
            }
            return true;
        }
        if within(NOTE_REC).is_some() {
            return true; // Rec-LED zeigt On-Air, die Taste selbst tut nichts
        }
        let step = self.total_strips() as i64;
        match note {
            BANK_LEFT => self.set_bank_delta(-step),
            BANK_RIGHT => self.set_bank_delta(step),
            CHANNEL_LEFT => self.set_bank_delta(-1),
            CHANNEL_RIGHT => self.set_bank_delta(1),
            NAME_VALUE => self.lcd_mode = if self.lcd_mode == LcdMode::Gain { LcdMode::Pan } else { LcdMode::Gain },
            _ => return false,
        }
        true
    }

    pub fn flush(&mut self, now: u64, force: bool) -> bool {
        let mut any = false;
        let due: Vec<String> = self
            .pending
            .keys()
            .filter(|id| force || now.saturating_sub(self.last_sent.get(*id).copied().unwrap_or(0)) >= self.o.gain_interval_ms || !self.last_sent.contains_key(*id))
            .cloned()
            .collect();
        for id in due {
            if let Some(db) = self.pending.remove(&id) {
                self.cmds.push(MixerCmd::Gain { id: id.clone(), db });
                self.last_sent.insert(id, now);
                any = true;
            }
        }
        if let Some(db) = self.master_pending {
            if force || self.master_last_sent.is_none_or(|t| now.saturating_sub(t) >= self.o.gain_interval_ms) {
                self.cmds.push(MixerCmd::Master { db });
                self.master_pending = None;
                self.master_last_sent = Some(now);
                any = true;
            }
        }
        any
    }

    pub fn view(&mut self, unit: usize, now: u64) -> UnitState {
        let spec = self.o.units[unit];
        let mut faders = [None; 9];
        let mut leds = BTreeMap::new();
        let (mut rings, mut meters, mut top, mut bottom) = (vec![], vec![], vec![], vec![]);
        for i in 0..8usize {
            let k = if i < spec.strips { self.strip_idx(unit, i) } else { None };
            let touched = self.is_touched(unit, i as u8);
            let id = k.map(|k| self.channels[k].id.clone());
            if let Some(id) = &id {
                if self.held.get(id).is_some_and(|h| now.saturating_sub(h.at) > self.o.hold_ms) && !self.pending.contains_key(id) {
                    self.held.remove(id);
                }
            }
            let c = k.map(|k| &self.channels[k]);
            let gain = id.as_ref().and_then(|id| self.held.get(id)).map(|h| h.db).or(c.and_then(|c| c.gain_db));
            if let (Some(_), Some(g), false) = (c, gain, touched) {
                faders[i] = Some(db_to_fader(g));
            } else if c.is_none() && i < spec.strips {
                faders[i] = Some(0);
            }
            let on = |b: bool| if b { Led::On } else { Led::Off };
            leds.insert(NOTE_MUTE + i as u8, on(c.is_some_and(|c| c.mute)));
            leds.insert(NOTE_SOLO + i as u8, on(c.is_some_and(|c| c.pfl)));
            leds.insert(NOTE_SELECT + i as u8, on(c.is_some_and(|c| Some(&c.id) == self.selected.as_ref())));
            leds.insert(NOTE_REC + i as u8, on(c.is_some_and(|c| c.on_air)));
            rings.push(match c.and_then(|c| c.pan) {
                None => Ring { mode: RingMode::Dot, value: 0, led: false },
                Some(p) => Ring { mode: RingMode::Dot, value: 1 + (((p + 1.0) / 2.0) * 10.0).round() as i32, led: p == 0.0 },
            });
            meters.push(c.map_or(0, |c| if c.mute { 0 } else { meter_step(c.level) }));
            top.push(c.map(|c| c.label.clone()).unwrap_or_default());
            bottom.push(c.map_or(String::new(), |c| if self.lcd_mode == LcdMode::Gain { fmt_db(gain) } else { fmt_pan(c.pan) }));
        }
        if spec.has_master {
            if self.held_master.as_ref().is_some_and(|h| now.saturating_sub(h.at) > self.o.hold_ms) && self.master_pending.is_none() {
                self.held_master = None;
            }
            let m = self.held_master.as_ref().map(|h| h.db).or(self.master);
            faders[8] = if self.o.master_target && !self.is_touched(unit, 8) { m.map(db_to_fader) } else { None };
        }
        let n = format!("{:02}", (self.bank / self.total_strips().max(1) + 1) % 100);
        UnitState { faders, leds, rings, meters, lcd_top: top, lcd_bottom: bottom, seven_seg: n + "          " }
    }
}

fn is_consumed(note: u8) -> bool {
    (NOTE_REC..NOTE_SELECT + 8).contains(&note) || (NOTE_VPOT_PUSH..NOTE_VPOT_PUSH + 8).contains(&note) || matches!(note, BANK_LEFT | BANK_RIGHT | CHANNEL_LEFT | CHANNEL_RIGHT | NAME_VALUE)
}

// ───────── Anschluss ─────────

/// Ein MIDI-Anschluss (USB-Rohgerät, Netzwerk, Simulator). Nicht blockierend.
pub trait MidiPort: Send {
    fn name(&self) -> String;
    fn send_batch(&mut self, msgs: &[Vec<u8>]);
    /// Alles, was seit dem letzten Aufruf vom Gerät kam (Byteblöcke des Transports).
    fn recv(&mut self) -> Vec<Vec<u8>>;
    /// Verbindung steht (Gerät da / Sitzung offen).
    fn is_up(&self) -> bool;
}

/// Eine Mackie-Control-Einheit an einem Anschluss: Bytes → Ereignisse, Soll-Zustand → nur Änderungen.
pub struct McuUnit {
    pub port: Box<dyn MidiPort>,
    parser: MidiParser,
    faders: [Option<i32>; 9],
    leds: HashMap<u8, Led>,
    rings: [Option<Ring>; 8],
    meters: [i32; 8],
    lcd: String,
    seg: String,
    touched: [bool; 9],
    tol: i32,
    pub online: bool,
    pub version: String,
    pub moved: Vec<u8>,
    was_up: bool,
}

impl McuUnit {
    pub fn new(port: Box<dyn MidiPort>) -> Self {
        McuUnit {
            port,
            parser: MidiParser::default(),
            faders: [None; 9],
            leds: HashMap::new(),
            rings: Default::default(),
            meters: [-1; 8],
            lcd: String::new(),
            seg: String::new(),
            touched: [false; 9],
            tol: 24,
            online: false,
            version: String::new(),
            moved: vec![],
            was_up: false,
        }
    }

    pub fn start(&mut self) {
        self.resync();
        self.port.send_batch(&[device_query(DEVICE_ID_MCU)]);
    }

    pub fn resync(&mut self) {
        self.faders = [None; 9];
        self.leds.clear();
        self.rings = Default::default();
        self.meters = [-1; 8];
        self.lcd.clear();
        self.seg.clear();
    }

    /// Eingang abholen: Ereignisse (ohne Anmeldung). Erkennt Wiederverbinden und schreibt dann alles neu.
    pub fn poll(&mut self) -> Vec<McuEvent> {
        let up = self.port.is_up();
        if up && !self.was_up {
            self.start();
        }
        if !up {
            self.online = false;
        }
        self.was_up = up;
        let mut out = vec![];
        for chunk in self.port.recv() {
            for msg in self.parser.push(&chunk) {
                self.online = true;
                let ev = decode_from_surface(&msg);
                if let McuEvent::Sysex { device_id, cmd, data } = &ev {
                    if let Some(r) = host_connection_reply(*device_id, *cmd, data) {
                        self.port.send_batch(&[r]);
                        continue;
                    }
                    if *cmd == 0x14 {
                        self.version = String::from_utf8_lossy(data).to_string();
                    }
                }
                match &ev {
                    McuEvent::Touch { strip, down } => {
                        let s = (*strip as usize).min(8);
                        self.touched[s] = *down;
                        if !down {
                            self.faders[s] = None;
                        }
                    }
                    McuEvent::Fader { strip, value } if self.touched[(*strip as usize).min(8)] => self.faders[(*strip as usize).min(8)] = Some(*value),
                    _ => {}
                }
                out.push(ev);
            }
        }
        out
    }

    pub fn apply(&mut self, s: &UnitState) {
        if !self.port.is_up() {
            return;
        }
        let mut out: Vec<Vec<u8>> = vec![];
        self.moved.clear();
        for i in 0..9usize {
            let Some(want) = s.faders[i] else { continue };
            if self.touched[i] {
                continue;
            }
            let moved = match self.faders[i] {
                None => true,
                Some(have) => (have - want).abs() >= self.tol || ((want == 0 || want == FADER_MAX) && have != want),
            };
            if moved {
                out.push(fader_move(i as u8, want));
                self.faders[i] = Some(want);
                self.moved.push(i as u8);
            }
        }
        for (note, st) in &s.leds {
            if self.leds.get(note) != Some(st) {
                out.push(led_note(*note, *st));
                self.leds.insert(*note, *st);
            }
        }
        for (i, r) in s.rings.iter().enumerate().take(8) {
            if self.rings[i].as_ref() != Some(r) {
                out.push(vpot_ring(i as u8, r.mode, r.value, r.led));
                self.rings[i] = Some(r.clone());
            }
        }
        for (i, m) in s.meters.iter().enumerate().take(8) {
            if self.meters[i] != *m {
                out.push(meter_level(i as u8, *m));
                self.meters[i] = *m;
            }
        }
        let lcd = format!("{:?}{:?}", s.lcd_top, s.lcd_bottom);
        if lcd != self.lcd {
            out.extend(lcd_cells(&s.lcd_top, &s.lcd_bottom, DEVICE_ID_MCU));
            self.lcd = lcd;
        }
        if s.seven_seg != self.seg {
            out.extend(seven_seg_text(&s.seven_seg));
            self.seg = s.seven_seg.clone();
        }
        if !out.is_empty() {
            self.port.send_batch(&out);
        }
    }
}

// ───────── Simulator (Geräteseite) ─────────

use std::sync::{Arc, Mutex};

/// Zustand eines simulierten Pults (Geräteseite) — wie `sim-surface.ts`.
pub struct SimState {
    pub faders: [i32; 9],
    pub touched: [bool; 9],
    pub leds: HashMap<u8, Led>,
    pub rings: [(u8, u8, bool); 8],
    pub meters: [u8; 8],
    pub lcd: [Vec<u8>; 2],
    pub seven_seg: [u8; 12],
    pub received: Vec<Vec<u8>>,
    pub answers_query: bool,
    pub up: bool,
    outbox: Vec<Vec<u8>>,
    parser: MidiParser,
}

impl SimState {
    pub fn new() -> Self {
        SimState {
            faders: [0; 9],
            touched: [false; 9],
            leds: HashMap::new(),
            rings: [(0, 0, false); 8],
            meters: [0; 8],
            lcd: [vec![b' '; 56], vec![b' '; 56]],
            seven_seg: [0x20; 12],
            received: vec![],
            answers_query: true,
            up: true,
            outbox: vec![],
            parser: MidiParser::default(),
        }
    }

    fn handle(&mut self, m: &[u8]) {
        let st = m[0] & 0xf0;
        if m[0] == 0xf0 && m.len() >= 7 {
            match m[5] {
                0x00 if self.answers_query => self.outbox.push(vec![0xf0, 0, 0, 0x66, 0x14, 0x01, 0x53, 0x49, 0x4d, 0x30, 0x30, 0x30, 0x31, 1, 2, 3, 4, 0xf7]),
                0x12 if m.len() >= 8 => {
                    let off = m[6] as usize;
                    for (i, c) in m[7..m.len() - 1].iter().enumerate() {
                        let pos = off + i;
                        let (line, col) = if pos < 0x38 { (0, pos) } else { (1, pos - 0x38) };
                        if col < 56 {
                            self.lcd[line][col] = *c;
                        }
                    }
                }
                0x63 => self.reset(),
                _ => {}
            }
            return;
        }
        if m.len() < 2 {
            return;
        }
        match st {
            0xe0 if (m[0] & 0xf) <= 8 && m.len() >= 3 => {
                let s = (m[0] & 0xf) as usize;
                if !self.touched[s] {
                    self.faders[s] = ((m[2] as i32) << 7) | m[1] as i32;
                }
            }
            0x90 if m.len() >= 3 => {
                self.leds.insert(m[1], if m[2] == 0 { Led::Off } else if m[2] == 0x7f { Led::On } else { Led::Blink });
            }
            0xb0 if m.len() >= 3 => {
                if (0x30..=0x37).contains(&m[1]) {
                    self.rings[(m[1] - 0x30) as usize] = ((m[2] >> 4) & 3, m[2] & 0x0f, m[2] & 0x40 != 0);
                } else if (0x40..=0x4b).contains(&m[1]) {
                    self.seven_seg[(m[1] - 0x40) as usize] = m[2];
                }
            }
            0xd0 => self.meters[((m[1] >> 4) & 7) as usize] = m[1] & 0x0f,
            _ => {}
        }
    }

    pub fn reset(&mut self) {
        self.faders = [0; 9];
        self.leds.clear();
        self.rings = [(0, 0, false); 8];
        self.meters = [0; 8];
        self.lcd = [vec![b' '; 56], vec![b' '; 56]];
    }

    pub fn text_raw(&self, line: usize) -> String {
        String::from_utf8_lossy(&self.lcd[line]).to_string()
    }
    #[cfg(test)]
    pub fn text(&self, line: usize) -> String {
        self.text_raw(line)
    }

    // Bedienung am Pult
    pub fn touch(&mut self, strip: usize, down: bool) {
        self.touched[strip] = down;
        self.outbox.push(vec![0x90, NOTE_TOUCH + strip as u8, if down { 0x7f } else { 0 }]);
    }
    pub fn drag(&mut self, strip: usize, value: i32) {
        if !self.touched[strip] {
            self.touch(strip, true);
        }
        let v = value.clamp(0, FADER_MAX);
        self.faders[strip] = v;
        self.outbox.push(vec![0xe0 | strip as u8, (v & 0x7f) as u8, (v >> 7) as u8]);
    }
    pub fn release(&mut self, strip: usize) {
        self.touch(strip, false);
    }
    pub fn press(&mut self, name: &str) -> Result<(), String> {
        let n = note_by_name(name).ok_or_else(|| format!("unbekannte Taste {name}"))?;
        self.outbox.push(vec![0x90, n, 0x7f]);
        self.outbox.push(vec![0x90, n, 0x00]);
        Ok(())
    }
    pub fn turn(&mut self, strip: usize, steps: i32) {
        self.outbox.push(vec![0xb0, 0x10 + strip as u8, (if steps < 0 { 0x40 } else { 0 }) | (steps.unsigned_abs().min(63) as u8)]);
    }
}

impl Default for SimState {
    fn default() -> Self {
        Self::new()
    }
}

/// Anschluss auf ein simuliertes Pult; der Zustand ist von außen (Methoden des Nodes, Tests) erreichbar.
#[derive(Clone)]
pub struct SimPort {
    pub name: String,
    pub state: Arc<Mutex<SimState>>,
}

impl SimPort {
    pub fn new(name: &str) -> Self {
        SimPort { name: name.to_string(), state: Arc::new(Mutex::new(SimState::new())) }
    }
}

impl MidiPort for SimPort {
    fn name(&self) -> String {
        self.name.clone()
    }
    fn send_batch(&mut self, msgs: &[Vec<u8>]) {
        let mut s = self.state.lock().expect("lock poisoned");
        if !s.up {
            return;
        }
        for bytes in msgs {
            let parsed = s.parser.push(bytes);
            for m in parsed {
                s.received.push(m.clone());
                s.handle(&m);
            }
        }
    }
    fn recv(&mut self) -> Vec<Vec<u8>> {
        let mut s = self.state.lock().expect("lock poisoned");
        if !s.up {
            s.outbox.clear();
        }
        std::mem::take(&mut s.outbox)
    }
    fn is_up(&self) -> bool {
        self.state.lock().expect("lock poisoned").up
    }
}
