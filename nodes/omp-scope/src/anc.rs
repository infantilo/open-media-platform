//! ANC-Analyse des Messgeräts: liest einen MXL-Daten-Flow (`video/smpte291`) und zeigt **jeden** Ancillary-Pakettyp (DID/SDID) —
//! Zähler, Rate, Zeile/Offset, Nutzdatenlänge, Paritäts- und Prüfsummenfehler, letzte Nutzdaten —, entschlüsselt bekannte Typen
//! (CEA-708-CDP mit Untertiteltext, AFD, privates OMP-Text-Paket) und liefert für **SCTE** den vollständigen Ablauf:
//! SCTE-104-Nachrichten aus ANC (über Pakete zusammengesetzt, jede Operation entschlüsselt) und SCTE-35-Abschnitte aus einem
//! UDP-Eingang (`OMP_SCOPE_SCTE35_UDP`) bzw. zur Einzelprüfung per `POST /scte35/decode` (Hex oder Base64).
//!
//! Unbekannte Typen werden nicht verworfen, sondern mit Rohdaten gezeigt. Strukturfehler (Länge, abgeschnitten) zählen als
//! Fehler und lassen den Rest laufen (`anc::parse_mxl_grain_lenient`).

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use omp_mediaio::anc::{self, ParsedAnc};
use omp_mediaio::cea608::Cea608Decoder;
use omp_mediaio::mxl::{MxlContext, MxlDataInput};
use omp_mediaio::scte_decode::{self as scte, Decoded, Scte104Assembler};
use serde_json::{Value, json};

const MAX_EVENTS: usize = 40;
const MAX_ERRORS: usize = 30;
const MAX_RECENT: usize = 30;

/// Name und Norm eines DID/SDID-Paares (Tabelle nach SMPTE ST 291-1 und den Folgenormen; unbekannte Paare bleiben unbenannt).
pub fn describe(did: u8, sdid: u8) -> (&'static str, &'static str) {
    match (did, sdid) {
        (0x61, 0x01) => ("Untertitel CEA-708 (CDP)", "SMPTE ST 334-1 / CEA-708"),
        (0x61, 0x02) => ("Untertitel CEA-608", "SMPTE ST 334-1 / CEA-608"),
        (0x41, 0x01) => ("Payload-Identifikation", "SMPTE ST 352"),
        (0x41, 0x05) => ("AFD und Bar-Daten", "SMPTE ST 2016-3"),
        (0x41, 0x07) => ("SCTE 104 (Werbemarker)", "SMPTE ST 2010 / SCTE 104"),
        (0x60, 0x60) => ("Zeitcode (ATC)", "SMPTE ST 12-2"),
        (0x43, 0x02) => ("Untertitel/Teletext OP-47 (SDP)", "SMPTE RDD 8 / OP-47"),
        (0x43, 0x03) => ("OP-47 Multipacket", "SMPTE RDD 8 / OP-47"),
        (0x62, 0x01) => ("Programmbeschreibung", "SMPTE ST 334-1"),
        (0x62, 0x02) => ("Datenrundfunk", "SMPTE ST 334-1"),
        (0x62, 0x03) => ("VBI-Daten", "SMPTE ST 334-1"),
        (0x5E, 0x01) => ("OMP Text-Cue (privat)", "OMP, kein Standard"),
        (0xE4..=0xE7, _) => ("Eingebetteter Ton (HD, Daten)", "SMPTE ST 299-1"),
        (0xE0..=0xE3, _) => ("Eingebetteter Ton (HD, Steuerung)", "SMPTE ST 299-1"),
        (0xFF | 0xFD | 0xFB | 0xF9, _) => ("Eingebetteter Ton (SD, Daten)", "SMPTE ST 272"),
        (0xFE | 0xFC | 0xFA | 0xF8, _) => ("Eingebetteter Ton (SD, Steuerung)", "SMPTE ST 272"),
        (0xF4, _) => ("EDH (Fehlererkennung)", "SMPTE RP 165"),
        _ => ("unbekannt / herstellerspezifisch", "–"),
    }
}

fn rate_name(code: u8) -> &'static str {
    match code {
        1 => "23,976 fps",
        2 => "24 fps",
        3 => "25 fps",
        4 => "29,97 fps",
        5 => "30 fps",
        6 => "50 fps",
        7 => "59,94 fps",
        8 => "60 fps",
        _ => "reserviert",
    }
}

/// CEA-708-CDP (`0x9669`-Kopf): Kopffelder, Prüfsumme, Abschnitte, Zahl der CC-Paare je Art, erkannter 608-Text.
pub fn decode_cdp(cdp: &[u8]) -> Decoded {
    let mut d = Decoded { title: "CEA-708 Caption Distribution Packet".to_string(), ..Default::default() };
    let mut f = |k: &str, v: String| d.fields.push((k.to_string(), v));
    if cdp.len() < 7 || cdp[0] != 0x96 || cdp[1] != 0x69 {
        d.warnings.push("kein CDP (Kennung 0x9669 fehlt)".to_string());
        d.fields.push(("Rohdaten".to_string(), scte::hex(&cdp[..cdp.len().min(32)])));
        return d;
    }
    let mut warns: Vec<String> = Vec::new();
    f("cdp_length", cdp[2].to_string());
    if cdp[2] as usize != cdp.len() {
        warns.push(format!("cdp_length {} passt nicht zu {} Byte", cdp[2], cdp.len()));
    }
    let sum: u32 = cdp.iter().map(|b| *b as u32).sum();
    f("Prüfsumme", if sum % 256 == 0 { "gültig".to_string() } else { "FALSCH".to_string() });
    if sum % 256 != 0 {
        warns.push("CDP-Prüfsumme falsch".to_string());
    }
    f("Bildrate", rate_name(cdp[3] >> 4).to_string());
    let flags = cdp[4];
    f("Flags", format!("timecode={} ccdata={} svcinfo={} aktiv={}", flags >> 7 & 1, flags >> 6 & 1, flags >> 5 & 1, flags >> 1 & 1));
    f("cdp_hdr_sequence_cntr", u16::from_be_bytes([cdp[5], cdp[6]]).to_string());
    let mut pos = 7;
    let mut pairs = [0usize; 4]; // cc_type 0..3
    let mut valid = 0usize;
    let mut dec = Cea608Decoder::new();
    while pos < cdp.len() {
        match cdp[pos] {
            0x71 => {
                if let Some(t) = cdp.get(pos + 1..pos + 5) {
                    f("Zeitcode-Abschnitt", scte::hex(t));
                }
                pos += 5;
            }
            0x72 => {
                let Some(&cc) = cdp.get(pos + 1) else { break };
                let n = (cc & 0x1F) as usize;
                for i in 0..n {
                    let at = pos + 2 + i * 3;
                    let Some(t) = cdp.get(at..at + 3) else {
                        warns.push("ccdata-Abschnitt abgeschnitten".to_string());
                        break;
                    };
                    if t[0] & 0x04 != 0 {
                        valid += 1;
                        pairs[(t[0] & 3) as usize] += 1;
                    }
                }
                f("cc_count", n.to_string());
                pos += 2 + n * 3;
            }
            0x73 => {
                f("Dienstinformation", "vorhanden".to_string());
                pos = cdp.len().saturating_sub(4).max(pos + 1);
            }
            0x74 => {
                if let Some(t) = cdp.get(pos + 1..pos + 4) {
                    f("Fußzeile (Folge)", u16::from_be_bytes([t[0], t[1]]).to_string());
                }
                break;
            }
            other => {
                warns.push(format!("unbekannter Abschnitt 0x{other:02X}"));
                break;
            }
        }
    }
    f("gültige CC-Paare", valid.to_string());
    f("Paare 608 Feld 1 / Feld 2", format!("{} / {}", pairs[0], pairs[1]));
    f("Paare 708 (Daten / Start)", format!("{} / {}", pairs[2], pairs[3]));
    dec.feed_cdp(cdp);
    let text = dec.text();
    if !text.is_empty() {
        f("Text (608)", text.replace('\n', " | "));
    }
    d.warnings.extend(warns);
    d
}

/// Zeitcode-Paket (ST 12-2): Zeitcode, Art (LTC/VITC), Gültigkeit.
fn decode_atc(udw: &[u8]) -> Decoded {
    let mut d = Decoded { title: "Zeitcode (ATC)".to_string(), ..Default::default() };
    let p = omp_mediaio::anc::AncPacket { c_not_y: false, line: 0, offset: 0, did: 0x60, sdid: 0x60, udw: udw.to_vec() };
    match omp_mediaio::anc::parse_atc(&p) {
        Some(a) => {
            d.fields.push(("Zeitcode".to_string(), a.timecode.display()));
            d.fields.push((
                "Art".to_string(),
                match a.payload_type {
                    0 => "ATC_LTC (linear)".to_string(),
                    1 => "ATC_VITC1".to_string(),
                    2 => "ATC_VITC2".to_string(),
                    n => format!("Nutzlasttyp 0x{n:02X}"),
                },
            ));
            d.fields.push(("Drop-Frame".to_string(), if a.timecode.drop_frame { "ja" } else { "nein" }.to_string()));
            d.fields.push(("Gültig".to_string(), if a.valid { "ja" } else { "nein (interpoliert)" }.to_string()));
        }
        None => d.fields.push(("Fehler".to_string(), format!("{} Nutzdatenwörter statt 16", udw.len()))),
    }
    d
}

/// Aus den Nutzdaten eines ANC-Pakets das, was sich für den Typ lesen lässt (sonst nur Rohdaten).
pub fn decode_packet(did: u8, sdid: u8, udw: &[u8]) -> Decoded {
    match (did, sdid) {
        (0x61, 0x01) => decode_cdp(udw),
        (0x60, 0x60) => decode_atc(udw),
        (0x41, 0x05) => {
            let mut d = Decoded { title: "AFD und Bar-Daten".to_string(), ..Default::default() };
            if let Some(&b) = udw.first() {
                d.fields.push(("AFD-Code".to_string(), ((b >> 3) & 0x0F).to_string()));
                d.fields.push(("Seitenverhältnis".to_string(), if b & 4 != 0 { "16:9" } else { "4:3" }.to_string()));
            }
            d.fields.push(("Rohdaten".to_string(), scte::hex(&udw[..udw.len().min(16)])));
            d
        }
        (0x5E, 0x01) if udw.len() >= 3 => {
            let mut d = Decoded { title: "OMP Text-Cue".to_string(), ..Default::default() };
            d.fields.push(("Version".to_string(), udw[0].to_string()));
            d.fields.push(("Folge".to_string(), u16::from_be_bytes([udw[1], udw[2]]).to_string()));
            d.fields.push(("Text".to_string(), String::from_utf8_lossy(&udw[3..]).to_string()));
            d
        }
        _ => {
            let (name, std) = describe(did, sdid);
            let mut d = Decoded { title: name.to_string(), ..Default::default() };
            d.fields.push(("Norm".to_string(), std.to_string()));
            d.fields.push(("Typ".to_string(), if did >= 0x80 { "Typ 1 (SDID = Blocknummer)" } else { "Typ 2 (DID/SDID)" }.to_string()));
            d.fields.push(("Rohdaten".to_string(), format!("{}{}", scte::hex(&udw[..udw.len().min(48)]), if udw.len() > 48 { " …" } else { "" })));
            d
        }
    }
}

pub fn decoded_to_json(d: &Decoded) -> Value {
    decoded_json(d)
}

fn decoded_json(d: &Decoded) -> Value {
    json!({
        "title": d.title,
        "fields": d.fields.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
        "children": d.children.iter().map(decoded_json).collect::<Vec<_>>(),
        "warnings": d.warnings,
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

#[derive(Default)]
struct TypeStat {
    count: u64,
    bytes: u64,
    last_line: u16,
    last_offset: u16,
    c_not_y: bool,
    dc_min: usize,
    dc_max: usize,
    parity_errors: u64,
    checksum_errors: u64,
    last_udw: Vec<u8>,
    decoded: Option<Decoded>,
    last_seen_frame: u64,
    // Rate: Zähler beim letzten Messpunkt
    rate_count: u64,
    rate: f64,
    // CDP-Folge
    cdp_seq: Option<u16>,
    cdp_seq_gaps: u64,
}

struct Event {
    at_ms: u64,
    source: &'static str,
    duplicate: bool,
    line: Option<u16>,
    decoded: Decoded,
}

struct State {
    started: Instant,
    frames: u64,
    empty_frames: u64,
    packets: u64,
    bad_grains: u64,
    index_gaps: u64,
    last_index: Option<u64>,
    types: BTreeMap<(u8, u8), TypeStat>,
    errors: VecDeque<(String, u64)>,
    events: VecDeque<Event>,
    asm: Scte104Assembler,
    scte104_messages: u64,
    scte104_dropped: u64,
    scte104_errors: u64,
    scte35_sections: u64,
    scte35_errors: u64,
    recent: VecDeque<Value>,
    rate_at: Instant,
    rate_frames: u64,
    fps: f64,
    packets_per_s: f64,
    rate_packets: u64,
    /// Zeitcode (ST 12-2): letzter Wert, Zahl der Sprünge (nicht fortlaufend) und Pakete mit ungültig-Bit.
    tc_last: Option<omp_mediaio::anc::Timecode>,
    tc_jumps: u64,
    tc_invalid: u64,
}

/// Folgt `b` auf `a` ohne Lücke? Gleicher Wert (Halbbilder bei hohen Raten) und der nächste Bildzähler zählen; ein Übertrag in die
/// nächste Sekunde/Minute/Stunde wird nicht auf die Bildrate geprüft (die kennt der Datenstrom nicht), nur dass er bei Bild 0 oder 2
/// (Drop-Frame) beginnt.
fn tc_follows(a: &omp_mediaio::anc::Timecode, b: &omp_mediaio::anc::Timecode) -> bool {
    let secs = |t: &omp_mediaio::anc::Timecode| t.hours as u32 * 3600 + t.minutes as u32 * 60 + t.seconds as u32;
    if secs(a) == secs(b) {
        return b.frames == a.frames || b.frames == a.frames + 1;
    }
    let next = (secs(a) + 1) % 86400 == secs(b);
    next && (b.frames == 0 || (b.drop_frame && b.frames == 2 && b.seconds == 0))
}

impl State {
    fn new() -> Self {
        State {
            started: Instant::now(),
            frames: 0,
            empty_frames: 0,
            packets: 0,
            bad_grains: 0,
            index_gaps: 0,
            last_index: None,
            types: BTreeMap::new(),
            errors: VecDeque::new(),
            events: VecDeque::new(),
            asm: Scte104Assembler::default(),
            scte104_messages: 0,
            scte104_dropped: 0,
            scte104_errors: 0,
            scte35_sections: 0,
            scte35_errors: 0,
            recent: VecDeque::new(),
            rate_at: Instant::now(),
            rate_frames: 0,
            fps: 0.0,
            packets_per_s: 0.0,
            rate_packets: 0,
            tc_last: None,
            tc_jumps: 0,
            tc_invalid: 0,
        }
    }

    fn error(&mut self, msg: String) {
        if let Some(e) = self.errors.iter_mut().find(|(m, _)| *m == msg) {
            e.1 += 1;
            return;
        }
        if self.errors.len() >= MAX_ERRORS {
            self.errors.pop_front();
        }
        self.errors.push_back((msg, 1));
    }

    fn push_event(&mut self, e: Event) {
        if self.events.len() >= MAX_EVENTS {
            self.events.pop_front();
        }
        self.events.push_back(e);
    }

    fn on_scte104_packet(&mut self, p: &ParsedAnc) {
        match self.asm.feed(&p.packet.udw) {
            Ok(Some(msg)) => {
                self.scte104_messages += 1;
                if msg.dropped_previous {
                    self.scte104_dropped += 1;
                    self.error("SCTE 104: unvollständige Nachricht verworfen (neuer Anfang)".to_string());
                }
                let decoded = scte::scte104(&msg.bytes);
                let warns = decoded.all_warnings();
                if !warns.is_empty() {
                    self.scte104_errors += 1;
                    for w in warns {
                        self.error(format!("SCTE 104: {w}"));
                    }
                }
                self.push_event(Event { at_ms: now_ms(), source: "SCTE-104 (ANC)", duplicate: msg.duplicate, line: Some(p.packet.line), decoded });
            }
            Ok(None) => {}
            Err(e) => {
                self.scte104_errors += 1;
                self.error(format!("SCTE 104: {e}"));
            }
        }
    }

    fn on_grain(&mut self, index: u64, grain: &[u8]) {
        self.frames += 1;
        if let Some(last) = self.last_index
            && index > last + 1
        {
            self.index_gaps += index - last - 1;
        }
        self.last_index = Some(index);
        let g = anc::parse_mxl_grain_lenient(grain);
        if let Some(e) = &g.error {
            self.bad_grains += 1;
            self.error(format!("Grain: {e}"));
        }
        if g.packets.is_empty() && g.error.is_none() {
            self.empty_frames += 1;
        }
        if g.error.is_none() && g.packets.len() != g.declared_count {
            self.error("ANC_Count passt nicht zur Zahl der Pakete".to_string());
        }
        let frame = self.frames;
        for p in &g.packets {
            self.packets += 1;
            let (did, sdid) = (p.packet.did, p.packet.sdid);
            let dc = p.packet.udw.len();
            if !p.parity_ok || !p.checksum_ok {
                let what = match (p.parity_ok, p.checksum_ok) {
                    (false, false) => "Parität und Prüfsumme",
                    (false, true) => "Parität",
                    _ => "Prüfsumme",
                };
                self.error(format!("DID 0x{did:02X}/SDID 0x{sdid:02X}: {what} falsch"));
            }
            let t = self.types.entry((did, sdid)).or_default();
            if t.count == 0 {
                t.dc_min = dc;
            }
            t.count += 1;
            t.bytes += dc as u64;
            t.last_line = p.packet.line;
            t.last_offset = p.packet.offset;
            t.c_not_y = p.packet.c_not_y;
            t.dc_min = t.dc_min.min(dc);
            t.dc_max = t.dc_max.max(dc);
            t.last_seen_frame = frame;
            if !p.parity_ok {
                t.parity_errors += 1;
            }
            if !p.checksum_ok {
                t.checksum_errors += 1;
            }
            if (did, sdid) == (0x61, 0x01) && dc >= 7 {
                let seq = u16::from_be_bytes([p.packet.udw[5], p.packet.udw[6]]);
                if let Some(prev) = t.cdp_seq
                    && seq != prev.wrapping_add(1)
                {
                    t.cdp_seq_gaps += 1;
                }
                t.cdp_seq = Some(seq);
            }
            if t.last_udw != p.packet.udw || t.decoded.is_none() {
                t.last_udw = p.packet.udw.clone();
                t.decoded = Some(decode_packet(did, sdid, &p.packet.udw));
            }
            if (did, sdid) != (0x61, 0x01) || self.recent.len() < 3 {
                // Verlauf: Nicht-Untertitel-Pakete immer, Untertitel nur die ersten (sonst füllt das 25-mal je Sekunde den Verlauf)
                if self.recent.len() >= MAX_RECENT {
                    self.recent.pop_front();
                }
                self.recent.push_back(json!({
                    "atMs": now_ms(), "frame": frame, "did": did, "sdid": sdid, "line": p.packet.line, "offset": p.packet.offset,
                    "dc": dc, "ok": p.parity_ok && p.checksum_ok, "hex": scte::hex(&p.packet.udw[..dc.min(24)]),
                }));
            }
            if (did, sdid) == (scte::DID_SCTE104, scte::SDID_SCTE104) {
                self.on_scte104_packet(p);
            }
            if (did, sdid) == (anc::DID_ATC, anc::SDID_ATC)
                && let Some(a) = anc::parse_atc(&p.packet)
                && a.payload_type == 0
            {
                if !a.valid {
                    self.tc_invalid += 1;
                }
                if let Some(prev) = &self.tc_last
                    && !tc_follows(prev, &a.timecode)
                {
                    self.tc_jumps += 1;
                    let msg = format!("Zeitcode springt: {} → {}", prev.display(), a.timecode.display());
                    self.error(msg);
                }
                self.tc_last = Some(a.timecode);
            }
        }
    }

    /// Raten aus den Zählern seit der letzten Messung (frühestens nach 0,5 s).
    fn update_rates(&mut self) {
        let dt = self.rate_at.elapsed().as_secs_f64();
        if dt < 0.5 {
            return;
        }
        self.fps = (self.frames - self.rate_frames) as f64 / dt;
        self.packets_per_s = (self.packets - self.rate_packets) as f64 / dt;
        for t in self.types.values_mut() {
            t.rate = (t.count - t.rate_count) as f64 / dt;
            t.rate_count = t.count;
        }
        self.rate_frames = self.frames;
        self.rate_packets = self.packets;
        self.rate_at = Instant::now();
    }
}

/// Der ANC-Analysator; Verbinden/Trennen ist billig (ein Lese-Thread).
pub struct AncAnalyzer {
    state: Arc<Mutex<State>>,
    input: Mutex<Option<MxlDataInput>>,
    flow_id: Mutex<String>,
}

impl AncAnalyzer {
    pub fn new() -> Self {
        AncAnalyzer { state: Arc::new(Mutex::new(State::new())), input: Mutex::new(None), flow_id: Mutex::new(String::new()) }
    }

    pub fn connect(&self, context: Arc<MxlContext>, flow_id: &str) -> Result<(), String> {
        self.disconnect();
        *self.state.lock().expect("lock poisoned") = State::new();
        let state = self.state.clone();
        let input = MxlDataInput::new_indexed(context, flow_id, move |index, grain| {
            state.lock().expect("lock poisoned").on_grain(index, grain);
        })?;
        *self.input.lock().expect("lock poisoned") = Some(input);
        *self.flow_id.lock().expect("lock poisoned") = flow_id.to_string();
        Ok(())
    }

    pub fn disconnect(&self) {
        *self.input.lock().expect("lock poisoned") = None;
        self.flow_id.lock().expect("lock poisoned").clear();
    }

    pub fn flow_id(&self) -> String {
        self.flow_id.lock().expect("lock poisoned").clone()
    }

    pub fn flowed(&self) -> bool {
        self.input.lock().expect("lock poisoned").as_ref().is_some_and(|i| i.flowed_handle().load(std::sync::atomic::Ordering::Relaxed))
    }

    /// Einen SCTE-35-Abschnitt (aus UDP oder manuell) entschlüsseln und in den Ablauf aufnehmen.
    pub fn add_scte35(&self, section: &[u8], source: &'static str) -> Decoded {
        let decoded = scte::scte35(section);
        let mut s = self.state.lock().expect("lock poisoned");
        s.scte35_sections += 1;
        let warns = decoded.all_warnings();
        if !warns.is_empty() {
            s.scte35_errors += 1;
            for w in warns {
                s.error(format!("SCTE 35: {w}"));
            }
        }
        s.push_event(Event { at_ms: now_ms(), source, duplicate: false, line: None, decoded: decoded.clone() });
        decoded
    }

    /// Kennzahlen für `/measurements` (Parameter).
    pub fn counters(&self) -> (u64, u64, u64, u64) {
        let s = self.state.lock().expect("lock poisoned");
        (s.frames, s.packets, s.scte104_messages + s.scte35_sections, s.errors.iter().map(|e| e.1).sum())
    }

    /// Gesamtzustand für das Panel (`GET /anc`).
    pub fn snapshot(&self) -> Value {
        let mut s = self.state.lock().expect("lock poisoned");
        s.update_rates();
        let types: Vec<Value> = s
            .types
            .iter()
            .map(|((did, sdid), t)| {
                let (name, std) = describe(*did, *sdid);
                json!({
                    "did": did, "sdid": sdid, "name": name, "standard": std,
                    "count": t.count, "perSec": (t.rate * 10.0).round() / 10.0, "bytes": t.bytes,
                    "line": t.last_line, "offset": t.last_offset, "channel": if t.c_not_y { "C (Chroma)" } else { "Y (Luma)" },
                    "dcMin": t.dc_min, "dcMax": t.dc_max,
                    "parityErrors": t.parity_errors, "checksumErrors": t.checksum_errors, "seqGaps": t.cdp_seq_gaps,
                    "active": s.frames.saturating_sub(t.last_seen_frame) < 50,
                    "decoded": t.decoded.as_ref().map(decoded_json),
                })
            })
            .collect();
        let events: Vec<Value> = s
            .events
            .iter()
            .rev()
            .map(|e| json!({ "atMs": e.at_ms, "source": e.source, "duplicate": e.duplicate, "line": e.line, "decoded": decoded_json(&e.decoded) }))
            .collect();
        json!({
            "connected": !self.flow_id().is_empty(),
            "flowId": self.flow_id(),
            "flowing": self.flowed(),
            "frames": s.frames, "emptyFrames": s.empty_frames, "packets": s.packets,
            "framesPerSec": (s.fps * 10.0).round() / 10.0, "packetsPerSec": (s.packets_per_s * 10.0).round() / 10.0,
            "indexGaps": s.index_gaps, "badGrains": s.bad_grains,
            "uptimeS": s.started.elapsed().as_secs(),
            "types": types,
            "timecode": json!({
                "present": s.tc_last.is_some(),
                "value": s.tc_last.as_ref().map(|t| t.display()),
                "dropFrame": s.tc_last.as_ref().is_some_and(|t| t.drop_frame),
                "jumps": s.tc_jumps, "invalid": s.tc_invalid,
            }),
            "scte": {
                "messages104": s.scte104_messages, "dropped104": s.scte104_dropped, "errors104": s.scte104_errors,
                "sections35": s.scte35_sections, "errors35": s.scte35_errors,
                "events": events,
            },
            "errors": s.errors.iter().map(|(m, n)| json!({ "message": m, "count": n })).collect::<Vec<_>>(),
            "recent": s.recent.iter().rev().cloned().collect::<Vec<_>>(),
        })
    }
}

/// Lauscht auf UDP-Datagramme mit rohen SCTE-35-Abschnitten (Ausgabe `OMP_SCTE35_UDP` des SCTE-Nodes) und füttert den Analysator.
pub fn spawn_scte35_udp(addr: &str, analyzer: Arc<AncAnalyzer>, shutdown: Arc<std::sync::atomic::AtomicBool>) -> Result<std::thread::JoinHandle<()>, String> {
    let socket = std::net::UdpSocket::bind(addr).map_err(|e| format!("SCTE-35-UDP {addr}: {e}"))?;
    socket.set_read_timeout(Some(std::time::Duration::from_millis(500))).map_err(|e| e.to_string())?;
    Ok(std::thread::spawn(move || {
        let mut buf = vec![0u8; 4096];
        while !shutdown.load(std::sync::atomic::Ordering::Relaxed) {
            if let Ok(n) = socket.recv(&mut buf) {
                analyzer.add_scte35(&buf[..n], "SCTE-35 (UDP)");
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timecode_continuity_rules() {
        use omp_mediaio::anc::Timecode;
        let t = |h, m, s, f, d| Timecode { hours: h, minutes: m, seconds: s, frames: f, drop_frame: d, field: false };
        assert!(tc_follows(&t(0, 0, 0, 5, false), &t(0, 0, 0, 6, false)));
        assert!(tc_follows(&t(0, 0, 0, 5, false), &t(0, 0, 0, 5, false)), "Halbbild");
        assert!(tc_follows(&t(0, 0, 0, 24, false), &t(0, 0, 1, 0, false)));
        assert!(tc_follows(&t(0, 0, 59, 29, true), &t(0, 1, 0, 2, true)), "Drop-Frame überspringt 0 und 1");
        assert!(tc_follows(&t(23, 59, 59, 24, false), &t(0, 0, 0, 0, false)));
        assert!(!tc_follows(&t(0, 0, 0, 5, false), &t(0, 0, 0, 9, false)));
        assert!(!tc_follows(&t(0, 0, 0, 5, false), &t(0, 0, 5, 0, false)));
    }
    use omp_mediaio::anc::AncPacket;

    fn cdp(seq: u16, with_text: bool) -> Vec<u8> {
        // 9669 | len | rate=25fps(3<<4|0xF) | flags: ccdata_present+caption_service_active | seq | 72 cc_count | triplets | 74 seq cksum
        let pairs: Vec<[u8; 3]> = if with_text { vec![[0xFC, 0x94, 0x20], [0xFC, b'H' | 0x80, b'i' | 0x80]] } else { vec![[0xF8, 0x80, 0x80]] };
        let mut v = vec![0x96, 0x69, 0, 0x3F, 0x42, (seq >> 8) as u8, seq as u8, 0x72, 0xE0 | pairs.len() as u8];
        for p in &pairs {
            v.extend_from_slice(p);
        }
        v.extend_from_slice(&[0x74, (seq >> 8) as u8, seq as u8, 0]);
        v[2] = v.len() as u8;
        let n = v.len();
        let sum: u32 = v[..n - 1].iter().map(|b| *b as u32).sum();
        v[n - 1] = ((256 - sum % 256) % 256) as u8;
        v
    }

    fn grain(packets: &[AncPacket]) -> Vec<u8> {
        anc::mxl_grain(packets).unwrap()
    }

    fn pk(did: u8, sdid: u8, udw: Vec<u8>) -> AncPacket {
        AncPacket { c_not_y: false, line: 9, offset: 0, did, sdid, udw }
    }

    #[test]
    fn cdp_is_decoded_with_checksum_and_sequence() {
        let c = cdp(7, true);
        let d = decode_cdp(&c);
        assert_eq!(d.get("Prüfsumme"), Some("gültig"), "{c:02X?}");
        assert_eq!(d.get("Bildrate"), Some("25 fps"));
        assert_eq!(d.get("cdp_hdr_sequence_cntr"), Some("7"));
        assert_eq!(d.get("cc_count"), Some("2"));
        assert_eq!(d.get("gültige CC-Paare"), Some("2"));
        assert!(d.warnings.is_empty(), "{:?}", d.warnings);
        let bad = {
            let mut b = c.clone();
            b[10] ^= 1;
            decode_cdp(&b)
        };
        assert!(bad.warnings.iter().any(|w| w.contains("Prüfsumme")));
        assert!(!decode_cdp(&[1, 2, 3]).warnings.is_empty());
    }

    #[test]
    fn every_packet_type_is_counted_and_unknown_ones_show_raw_data() {
        let mut s = State::new();
        let g = grain(&[pk(0x61, 0x01, cdp(1, false)), pk(0x41, 0x05, vec![0x28]), pk(0x7A, 0x33, vec![1, 2, 3, 4]), pk(0xE4, 0x01, vec![9; 5])]);
        s.on_grain(100, &g);
        s.on_grain(101, &g);
        assert_eq!((s.frames, s.packets), (2, 8));
        assert_eq!(s.types.len(), 4);
        let afd = s.types[&(0x41, 0x05)].decoded.as_ref().unwrap();
        assert_eq!(afd.get("AFD-Code"), Some("5"));
        assert_eq!(afd.get("Seitenverhältnis"), Some("4:3"));
        let unk = s.types[&(0x7A, 0x33)].decoded.as_ref().unwrap();
        assert_eq!(unk.get("Rohdaten"), Some("01 02 03 04"));
        assert!(unk.title.contains("unbekannt"));
        assert!(s.types[&(0xE4, 0x01)].decoded.as_ref().unwrap().title.contains("Eingebetteter Ton"));
        assert!(s.errors.is_empty());
    }

    #[test]
    fn errors_gaps_and_empty_frames_are_counted() {
        let mut s = State::new();
        s.on_grain(10, &grain(&[]));
        s.on_grain(14, &grain(&[pk(0x61, 0x01, cdp(1, false))]));
        assert_eq!((s.empty_frames, s.index_gaps), (1, 3));
        // beschädigtes Paket: Paritätsbit eines DID-Worts kippen
        let mut g = grain(&[pk(0x41, 0x05, vec![1, 2])]);
        g[anc::HEADER_LEN + 4] ^= 0xC0;
        s.on_grain(15, &g);
        assert!(s.types[&(0x41, 0x05)].parity_errors == 1 || s.errors.iter().any(|e| e.0.contains("Parität")), "{:?}", s.errors);
        s.on_grain(16, &[0, 0]);
        assert_eq!(s.bad_grains, 1);
        // CDP-Folge mit Lücke
        s.on_grain(17, &grain(&[pk(0x61, 0x01, cdp(5, false))]));
        assert_eq!(s.types[&(0x61, 0x01)].cdp_seq_gaps, 1);
    }

    #[test]
    fn scte104_across_two_packets_becomes_one_decoded_event() {
        use omp_mediaio::scte_decode as d;
        let mut msg = vec![0xFF, 0xFF, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0x01, 0x04, 0, 2, 0x0F, 0xA0];
        let n = msg.len() as u16;
        msg[2..4].copy_from_slice(&n.to_be_bytes());
        let (a, b) = msg.split_at(9);
        let mut p1 = vec![0x08 | 4];
        p1.extend_from_slice(a);
        let mut p2 = vec![0x08 | 2];
        p2.extend_from_slice(b);
        let mut s = State::new();
        s.on_grain(1, &grain(&[pk(d::DID_SCTE104, d::SDID_SCTE104, p1)]));
        assert!(s.events.is_empty(), "erst mit dem zweiten Paket komplett");
        s.on_grain(2, &grain(&[pk(d::DID_SCTE104, d::SDID_SCTE104, p2)]));
        assert_eq!(s.scte104_messages, 1);
        let e = s.events.back().unwrap();
        assert!(e.decoded.title.contains("multiple_operation_message"));
        assert_eq!(e.decoded.get("message_number"), Some("3"));
        assert_eq!(e.decoded.children[0].get("pre_roll_time"), Some("4000 ms"));
        assert_eq!(s.scte104_errors, 0);
    }

    #[test]
    fn scte35_sections_are_decoded_and_bad_ones_counted() {
        let a = AncAnalyzer::new();
        let d = a.add_scte35(&[0xFC, 0x30], "SCTE-35 (manuell)");
        assert!(!d.all_warnings().is_empty());
        let snap = a.snapshot();
        assert_eq!(snap["scte"]["sections35"], 1);
        assert_eq!(snap["scte"]["errors35"], 1);
        assert_eq!(snap["scte"]["events"][0]["source"], "SCTE-35 (manuell)");
    }

    #[test]
    fn snapshot_has_rates_and_json_shape() {
        let mut s = State::new();
        for i in 0..5 {
            s.on_grain(i, &grain(&[pk(0x61, 0x01, cdp(i as u16, false))]));
        }
        s.rate_at = Instant::now() - std::time::Duration::from_secs(1);
        s.update_rates();
        assert!(s.fps > 4.0 && s.types[&(0x61, 0x01)].rate > 4.0);
    }
}
