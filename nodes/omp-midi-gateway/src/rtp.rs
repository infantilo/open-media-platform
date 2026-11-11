//! Netzwerk-MIDI (Kapitel 93, Weg B): RTP-MIDI nach RFC 6295 (Nutzlast) mit der Sitzungsverwaltung „AppleMIDI“ (Apple, „MIDI Network
//! Driver Protocol“; macOS, Windows rtpMIDI, iOS und viele Geräte sprechen sie). Zwei UDP-Ports: Steuerport N und Datenport N+1.
//! Rollen: **Hörer** (wartet auf Einladung) und **Einlader** (verbindet sich zu einem Gerät). Abweichungen und Grenzen: `docs/CONTRACT-MIDI.md` §5.
//! Kein Journal beim Senden (J = 0; Journale beim Empfang werden übersprungen), keine Wiederherstellung verlorener Pakete, kein
//! segmentiertes SysEx. Auf einem LAN genügt das; Pakete werden nicht neu angefordert.

use std::collections::VecDeque;
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::surface::MidiPort;

const PROTOCOL_VERSION: u32 = 2;
/// Apples Treiber setzt Nutzlasttyp 0x61 (Dokument „MIDI Network Driver Protocol“, Abb. 1-3).
const RTP_PT: u8 = 0x61;

// ───────── Pakete ─────────

#[derive(Debug, PartialEq, Clone)]
pub enum Session {
    In { token: u32, ssrc: u32, name: String },
    Ok { token: u32, ssrc: u32, name: String },
    No { token: u32, ssrc: u32 },
    By { token: u32, ssrc: u32 },
    Ck { ssrc: u32, count: u8, ts: [u64; 3] },
}

fn u32be(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}
fn u64be(b: &[u8]) -> u64 {
    u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
}

pub fn parse_session(p: &[u8]) -> Option<Session> {
    if p.len() < 4 || p[0] != 0xff || p[1] != 0xff {
        return None;
    }
    match (p[2], p[3]) {
        (b'I', b'N') | (b'O', b'K') | (b'N', b'O') | (b'B', b'Y') => {
            if p.len() < 16 {
                return None;
            }
            let (token, ssrc) = (u32be(&p[8..12]), u32be(&p[12..16]));
            let name = String::from_utf8_lossy(p.get(16..).unwrap_or(&[]).split(|b| *b == 0).next().unwrap_or(&[])).to_string();
            Some(match (p[2], p[3]) {
                (b'I', _) => Session::In { token, ssrc, name },
                (b'O', _) => Session::Ok { token, ssrc, name },
                (b'N', _) => Session::No { token, ssrc },
                _ => Session::By { token, ssrc },
            })
        }
        (b'C', b'K') => {
            if p.len() < 36 {
                return None;
            }
            Some(Session::Ck { ssrc: u32be(&p[4..8]), count: p[8], ts: [u64be(&p[12..20]), u64be(&p[20..28]), u64be(&p[28..36])] })
        }
        _ => None,
    }
}

pub fn build_exchange(cmd: &[u8; 2], token: u32, ssrc: u32, name: Option<&str>) -> Vec<u8> {
    let mut v = vec![0xff, 0xff, cmd[0], cmd[1]];
    v.extend_from_slice(&PROTOCOL_VERSION.to_be_bytes());
    v.extend_from_slice(&token.to_be_bytes());
    v.extend_from_slice(&ssrc.to_be_bytes());
    if let Some(n) = name {
        v.extend_from_slice(n.as_bytes());
        v.push(0);
    }
    v
}

pub fn build_ck(ssrc: u32, count: u8, ts: [u64; 3]) -> Vec<u8> {
    let mut v = vec![0xff, 0xff, b'C', b'K'];
    v.extend_from_slice(&ssrc.to_be_bytes());
    v.extend_from_slice(&[count, 0, 0, 0]);
    for t in ts {
        v.extend_from_slice(&t.to_be_bytes());
    }
    v
}

/// Länge einer Kanal-/System-Common-Nachricht anhand des Statusbytes (ohne SysEx).
fn midi_len(status: u8) -> Option<usize> {
    match status & 0xf0 {
        0x80 | 0x90 | 0xa0 | 0xb0 | 0xe0 => Some(3),
        0xc0 | 0xd0 => Some(2),
        0xf0 => match status {
            0xf1 | 0xf3 => Some(2),
            0xf2 => Some(3),
            0xf6 => Some(1),
            _ => None,
        },
        _ => None,
    }
}

/// RTP-MIDI-Paket → einzelne MIDI-Nachrichten (RFC 6295 §3: Befehlsabschnitt, Delta-Zeiten übersprungen; Journal ignoriert).
pub fn parse_rtp(p: &[u8]) -> Option<Vec<Vec<u8>>> {
    if p.len() < 13 || p[0] >> 6 != 2 {
        return None;
    }
    let cc = (p[0] & 0x0f) as usize;
    let mut pos = 12 + cc * 4;
    if p[0] & 0x10 != 0 {
        // Erweiterungskopf überspringen
        let l = u16::from_be_bytes([*p.get(pos + 2)?, *p.get(pos + 3)?]) as usize;
        pos += 4 + l * 4;
    }
    let h = *p.get(pos)?;
    let (b, z) = (h & 0x80 != 0, h & 0x20 != 0);
    let (len, start) = if b { ((((h & 0x0f) as usize) << 8) | *p.get(pos + 1)? as usize, pos + 2) } else { ((h & 0x0f) as usize, pos + 1) };
    let list = p.get(start..start + len)?;
    let mut out = vec![];
    let mut i = 0;
    let mut first = true;
    let mut running: Option<u8> = None;
    while i < list.len() {
        if !first || z {
            // Delta-Zeit: 1–4 Byte, Fortsetzungsbit 7
            let mut n = 0;
            while i < list.len() {
                let d = list[i];
                i += 1;
                n += 1;
                if d & 0x80 == 0 || n == 4 {
                    break;
                }
            }
            if i >= list.len() {
                break;
            }
        }
        first = false;
        let st = list[i];
        if st == 0xf0 {
            let Some(end) = list[i..].iter().position(|b| *b == 0xf7) else { break }; // segmentiertes SysEx: nicht unterstützt
            out.push(list[i..i + end + 1].to_vec());
            i += end + 1;
            running = None;
            continue;
        }
        let (status, data_start) = if st & 0x80 != 0 {
            i += 1;
            (st, i)
        } else if let Some(r) = running {
            (r, i)
        } else {
            break;
        };
        let Some(total) = midi_len(status) else {
            // Echtzeit/undefiniert: ein Byte überspringen
            if status >= 0xf8 {
                continue;
            }
            break;
        };
        let n = total - 1;
        let Some(data) = list.get(data_start..data_start + n) else { break };
        let mut m = vec![status];
        m.extend_from_slice(data);
        i = data_start + n;
        if status < 0xf0 {
            running = Some(status);
        } else {
            running = None;
        }
        out.push(m);
    }
    Some(out)
}

/// RTP-MIDI-Paket aus Nachrichten (Befehlsabschnitt ohne Journal; Delta-Zeit 0 zwischen den Befehlen, volle Statusbytes).
pub fn build_rtp(seq: u16, ts: u32, ssrc: u32, msgs: &[Vec<u8>]) -> Vec<u8> {
    let mut list = vec![];
    for (i, m) in msgs.iter().enumerate() {
        if i > 0 {
            list.push(0x00);
        }
        list.extend_from_slice(m);
    }
    let mut v = vec![0x80, 0x80 | RTP_PT];
    v.extend_from_slice(&seq.to_be_bytes());
    v.extend_from_slice(&ts.to_be_bytes());
    v.extend_from_slice(&ssrc.to_be_bytes());
    if list.len() <= 15 {
        v.push(list.len() as u8);
    } else {
        v.push(0x80 | ((list.len() >> 8) as u8 & 0x0f));
        v.push((list.len() & 0xff) as u8);
    }
    v.extend(list);
    v
}

/// Nachrichten auf Pakete mit höchstens `max` Byte Befehlsabschnitt verteilen.
pub fn chunk(msgs: &[Vec<u8>], max: usize) -> Vec<Vec<Vec<u8>>> {
    let mut out: Vec<Vec<Vec<u8>>> = vec![];
    let mut cur: Vec<Vec<u8>> = vec![];
    let mut size = 0;
    for m in msgs {
        let add = m.len() + usize::from(!cur.is_empty());
        if !cur.is_empty() && size + add > max {
            out.push(std::mem::take(&mut cur));
            size = 0;
        }
        size += m.len() + usize::from(!cur.is_empty());
        cur.push(m.clone());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

// ───────── Anschluss ─────────

#[derive(Clone, Debug)]
pub enum Role {
    /// Steuerport (Datenport = +1); 0 = freien Port suchen (Tests).
    Listen { port: u16 },
    Connect { peer: String },
}

struct Shared {
    up: AtomicBool,
    stop: AtomicBool,
    rx: Mutex<VecDeque<Vec<u8>>>,
    tx: Mutex<VecDeque<Vec<Vec<u8>>>>,
    peer_name: Mutex<String>,
    port: Mutex<u16>,
}

pub struct RtpPort {
    label: String,
    sh: Arc<Shared>,
}

fn rand32(salt: u32) -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
    let mut x = n ^ ((std::process::id() as u64) << 32) ^ (salt as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
    x ^= x >> 33;
    (x & 0xffff_ffff) as u32
}

fn bind_pair(port: u16) -> std::io::Result<(UdpSocket, UdpSocket, u16)> {
    if port != 0 {
        return Ok((UdpSocket::bind(("0.0.0.0", port))?, UdpSocket::bind(("0.0.0.0", port + 1))?, port));
    }
    for i in 0..200u32 {
        let p = 20000 + (rand32(i) % 20000) as u16;
        if let (Ok(c), Ok(d)) = (UdpSocket::bind(("127.0.0.1", p)), UdpSocket::bind(("127.0.0.1", p + 1))) {
            return Ok((c, d, p));
        }
    }
    Err(std::io::Error::other("kein freier Portpaar gefunden"))
}

impl RtpPort {
    pub fn start(role: Role, session_name: &str, label: &str) -> std::io::Result<RtpPort> {
        let sh = Arc::new(Shared { up: AtomicBool::new(false), stop: AtomicBool::new(false), rx: Mutex::new(VecDeque::new()), tx: Mutex::new(VecDeque::new()), peer_name: Mutex::new(String::new()), port: Mutex::new(0) });
        let (ctrl, data, port) = match &role {
            Role::Listen { port } => bind_pair(*port)?,
            Role::Connect { .. } => {
                let c = UdpSocket::bind(("0.0.0.0", 0))?;
                let p = c.local_addr()?.port();
                match UdpSocket::bind(("0.0.0.0", p.wrapping_add(1))) {
                    Ok(d) => (c, d, p),
                    Err(_) => bind_pair(0)?,
                }
            }
        };
        *sh.port.lock().expect("lock poisoned") = port;
        ctrl.set_read_timeout(Some(Duration::from_millis(10)))?;
        data.set_read_timeout(Some(Duration::from_millis(10)))?;
        let (s2, name) = (sh.clone(), session_name.to_string());
        std::thread::spawn(move || worker(s2, role, ctrl, data, &name));
        Ok(RtpPort { label: label.to_string(), sh })
    }

    /// Steuerport (bei `Listen { port: 0 }` der gewählte).
    #[cfg(test)]
    pub fn port(&self) -> u16 {
        *self.sh.port.lock().expect("lock poisoned")
    }
    #[cfg(test)]
    pub fn peer_name(&self) -> String {
        self.sh.peer_name.lock().expect("lock poisoned").clone()
    }
}

impl Drop for RtpPort {
    fn drop(&mut self) {
        self.sh.stop.store(true, Ordering::Relaxed);
    }
}

impl MidiPort for RtpPort {
    fn name(&self) -> String {
        self.label.clone()
    }
    fn send_batch(&mut self, msgs: &[Vec<u8>]) {
        if !self.is_up() {
            return;
        }
        let mut q = self.sh.tx.lock().expect("lock poisoned");
        for c in chunk(msgs, 1000) {
            q.push_back(c);
        }
        while q.len() > 200 {
            q.pop_front(); // Gegenstelle hängt: alte Pakete verwerfen, der Zustandsabgleich holt sie nach
        }
    }
    fn recv(&mut self) -> Vec<Vec<u8>> {
        self.sh.rx.lock().expect("lock poisoned").drain(..).collect()
    }
    fn is_up(&self) -> bool {
        self.sh.up.load(Ordering::Relaxed)
    }
}

struct Peer {
    ctrl: SocketAddr,
    data: SocketAddr,
    ssrc: u32,
    last_rx: Instant,
}

fn worker(sh: Arc<Shared>, role: Role, ctrl: UdpSocket, data: UdpSocket, name: &str) {
    let ssrc = rand32(1) | 1;
    let clock = Instant::now();
    let now100us = || (clock.elapsed().as_micros() / 100) as u64;
    let mut peer: Option<Peer> = None;
    let mut pending: Option<(SocketAddr, u32)> = None; // Hörer: Einladung auf dem Steuerport angenommen
    let mut seq: u16 = (rand32(2) & 0xffff) as u16;
    let mut buf = [0u8; 2048];

    // Einlader
    let target: Option<(SocketAddr, SocketAddr)> = match &role {
        Role::Connect { peer } => peer.to_socket_addrs().ok().and_then(|mut a| a.next()).map(|c| (c, SocketAddr::new(c.ip(), c.port().wrapping_add(1)))),
        _ => None,
    };
    let token = rand32(3);
    let mut stage = 0u8; // 0 Steuerport einladen, 1 Datenport einladen, 2 Sitzung
    let mut last_try = Instant::now() - Duration::from_secs(10);
    let mut last_ck = Instant::now();
    let mut ck_burst = 0u8;

    let end_session = |sh: &Shared, peer: &mut Option<Peer>, ctrl: &UdpSocket, data: &UdpSocket| {
        if let Some(p) = peer.take() {
            let by = build_exchange(b"BY", 0, ssrc, None);
            let _ = ctrl.send_to(&by, p.ctrl);
            let _ = data.send_to(&by, p.data);
        }
        sh.up.store(false, Ordering::Relaxed);
    };

    while !sh.stop.load(Ordering::Relaxed) {
        // Steuerport
        if let Ok((n, from)) = ctrl.recv_from(&mut buf) {
            match parse_session(&buf[..n]) {
                Some(Session::In { token, ssrc: s, name: pn }) if matches!(role, Role::Listen { .. }) => {
                    let _ = ctrl.send_to(&build_exchange(b"OK", token, ssrc, Some(name)), from);
                    pending = Some((from, s));
                    *sh.peer_name.lock().expect("lock poisoned") = pn;
                }
                Some(Session::Ok { token: t, .. }) if t == token && stage == 0 => stage = 1,
                Some(Session::By { .. }) => {
                    if peer.as_ref().is_some_and(|p| p.ctrl == from) {
                        peer = None;
                        sh.up.store(false, Ordering::Relaxed);
                        stage = 0;
                    }
                }
                Some(Session::No { .. }) => stage = 0,
                _ => {}
            }
        }
        // Datenport
        if let Ok((n, from)) = data.recv_from(&mut buf) {
            let pkt = &buf[..n];
            if let Some(s) = parse_session(pkt) {
                match s {
                    Session::In { token, ssrc: s, .. } if matches!(role, Role::Listen { .. }) => {
                        if let Some((c, _)) = pending.take_if(|(c, _)| c.ip() == from.ip()) {
                            let _ = data.send_to(&build_exchange(b"OK", token, ssrc, Some(name)), from);
                            peer = Some(Peer { ctrl: c, data: from, ssrc: s, last_rx: Instant::now() });
                            sh.up.store(true, Ordering::Relaxed);
                        } else {
                            let _ = data.send_to(&build_exchange(b"NO", token, ssrc, None), from);
                        }
                    }
                    Session::Ok { token: t, ssrc: s, name: pn } if t == token && stage == 1 => {
                        if let Some((c, d)) = target {
                            peer = Some(Peer { ctrl: c, data: d, ssrc: s, last_rx: Instant::now() });
                            *sh.peer_name.lock().expect("lock poisoned") = pn;
                            sh.up.store(true, Ordering::Relaxed);
                            stage = 2;
                            ck_burst = 0;
                            last_ck = Instant::now() - Duration::from_secs(10);
                        }
                    }
                    Session::Ck { ssrc: s, count, ts } => {
                        if let Some(p) = peer.as_mut().filter(|p| p.ssrc == s) {
                            p.last_rx = Instant::now();
                            if count == 0 {
                                let _ = data.send_to(&build_ck(ssrc, 1, [ts[0], now100us(), 0]), from);
                            } else if count == 1 {
                                let _ = data.send_to(&build_ck(ssrc, 2, [ts[0], ts[1], now100us()]), from);
                            }
                        }
                    }
                    Session::By { .. } => {
                        if peer.as_ref().is_some_and(|p| p.data == from) {
                            peer = None;
                            sh.up.store(false, Ordering::Relaxed);
                            stage = 0;
                        }
                    }
                    _ => {}
                }
            } else if let Some(p) = peer.as_mut().filter(|p| p.data == from) {
                p.last_rx = Instant::now();
                if let Some(msgs) = parse_rtp(pkt) {
                    let mut rx = sh.rx.lock().expect("lock poisoned");
                    for m in msgs {
                        rx.push_back(m);
                    }
                }
            }
        }
        // Einlader: Einladungen wiederholen, Uhrabgleich
        if let Some((c, d)) = target {
            if stage < 2 && last_try.elapsed() > Duration::from_secs(1) {
                last_try = Instant::now();
                let _ = if stage == 0 { ctrl.send_to(&build_exchange(b"IN", token, ssrc, Some(name)), c) } else { data.send_to(&build_exchange(b"IN", token, ssrc, Some(name)), d) };
            }
            if stage == 2 && peer.is_some() {
                let every = if ck_burst < 6 { Duration::from_millis(500) } else { Duration::from_secs(10) };
                if last_ck.elapsed() > every {
                    last_ck = Instant::now();
                    ck_burst = ck_burst.saturating_add(1);
                    let _ = data.send_to(&build_ck(ssrc, 0, [now100us(), 0, 0]), d);
                }
            }
        }
        // Senden
        if let Some(p) = &peer {
            let batch: Vec<Vec<Vec<u8>>> = sh.tx.lock().expect("lock poisoned").drain(..).collect();
            for msgs in batch {
                seq = seq.wrapping_add(1);
                let _ = data.send_to(&build_rtp(seq, now100us() as u32, ssrc, &msgs), p.data);
            }
        } else {
            sh.tx.lock().expect("lock poisoned").clear();
        }
        // Zeitüberwachung: die Gegenstelle muss sich mindestens alle 60 s melden (Apple-Dokument, Uhrabgleich)
        if peer.as_ref().is_some_and(|p| p.last_rx.elapsed() > Duration::from_secs(90)) {
            end_session(&sh, &mut peer, &ctrl, &data);
            stage = 0;
        }
    }
    end_session(&sh, &mut peer, &ctrl, &data);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_packets_roundtrip() {
        let p = build_exchange(b"IN", 0xdeadbeef, 0x01020304, Some("OMP"));
        assert_eq!(&p[..4], &[0xff, 0xff, b'I', b'N']);
        assert_eq!(&p[4..8], &[0, 0, 0, 2]);
        assert_eq!(parse_session(&p), Some(Session::In { token: 0xdeadbeef, ssrc: 0x01020304, name: "OMP".into() }));
        assert_eq!(parse_session(&build_exchange(b"NO", 7, 9, None)), Some(Session::No { token: 7, ssrc: 9 }));
        let ck = build_ck(5, 1, [10, 20, 0]);
        assert_eq!(ck.len(), 36);
        assert_eq!(parse_session(&ck), Some(Session::Ck { ssrc: 5, count: 1, ts: [10, 20, 0] }));
        assert_eq!(parse_session(&[0x80, 0x61]), None);
    }

    #[test]
    fn rtp_build_and_parse() {
        let msgs = vec![vec![0x90, 0x10, 0x7f], vec![0xe0, 0, 64], vec![0xf0, 0, 0, 0x66, 0x14, 0, 0xf7]];
        let p = build_rtp(1, 100, 7, &msgs);
        assert_eq!(p[0], 0x80);
        assert_eq!(p[1], 0xe1);
        assert_eq!(parse_rtp(&p), Some(msgs.clone()));
        // langes Paket: zweibyte Kopf
        let long: Vec<Vec<u8>> = (0..40).map(|i| vec![0x90, i, 0x7f]).collect();
        let p = build_rtp(2, 0, 7, &long);
        assert_eq!(p[12] & 0x80, 0x80);
        assert_eq!(parse_rtp(&p), Some(long));
    }

    #[test]
    fn rtp_parse_foreign_packets() {
        // RFC 6295: Z = 1 → Delta-Zeit vorweg; Laufstatus; Delta-Zeiten mehrbytig; Journal (J = 1) dahinter wird ignoriert
        let hdr = [0x80, 0x61, 0, 1, 0, 0, 0, 0, 0, 0, 0, 9];
        // Befehlsabschnitt: Z=1, J=1, LEN=9: Delta 0 | 90 10 7f | Delta 0x81 0x00 (=128) | 11 7f (Laufstatus) | Delta 0 | F8 …
        let list: Vec<u8> = vec![0x00, 0x90, 0x10, 0x7f, 0x81, 0x00, 0x11, 0x7f, 0x00];
        let mut p = hdr.to_vec();
        p.push(0x20 | 0x40 | list.len() as u8);
        p.extend(&list);
        p.extend([0xaa, 0xbb, 0xcc]); // „Journal“
        assert_eq!(parse_rtp(&p), Some(vec![vec![0x90, 0x10, 0x7f], vec![0x90, 0x11, 0x7f]]));
        // Z = 0: erster Befehl ohne Delta-Zeit
        let mut q = hdr.to_vec();
        q.extend([0x03, 0xb0, 0x07, 0x40]);
        assert_eq!(parse_rtp(&q), Some(vec![vec![0xb0, 0x07, 0x40]]));
        // kaputt: abgeschnitten → nichts, kein Absturz
        assert_eq!(parse_rtp(&hdr), None);
        assert_eq!(parse_rtp(&[0x80, 0x61, 0, 1, 0, 0, 0, 0, 0, 0, 0, 9, 0x05, 0x90]), None);
    }

    #[test]
    fn chunking_respects_size() {
        let m: Vec<Vec<u8>> = (0..10).map(|_| vec![0u8; 100]).collect();
        let c = chunk(&m, 350);
        assert_eq!(c.iter().map(Vec::len).collect::<Vec<_>>(), vec![3, 3, 3, 1]);
        assert!(chunk(&[], 100).is_empty());
    }

    fn wait<F: FnMut() -> bool>(mut f: F, secs: u64) -> bool {
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(secs) {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /// Hörer und Einlader gegeneinander über 127.0.0.1: Einladung, Uhrabgleich, MIDI in beide Richtungen, Abmelden.
    #[test]
    fn loopback_session() {
        let mut listener = RtpPort::start(Role::Listen { port: 0 }, "Hörer", "l").unwrap();
        let mut caller = RtpPort::start(Role::Connect { peer: format!("127.0.0.1:{}", listener.port()) }, "Einlader", "c").unwrap();
        assert!(wait(|| listener.is_up() && caller.is_up(), 5), "Sitzung kommt nicht zustande (Einladung wird jede Sekunde wiederholt)");
        assert_eq!(listener.peer_name(), "Einlader");
        assert_eq!(caller.peer_name(), "Hörer");
        caller.send_batch(&[vec![0x90, 0x18, 0x7f], vec![0xf0, 0, 0, 0x66, 0x14, 0x00, 0xf7]]);
        let mut got: Vec<Vec<u8>> = vec![];
        assert!(wait(|| { got.extend(listener.recv()); got.len() >= 2 }, 3));
        assert_eq!(got, vec![vec![0x90, 0x18, 0x7f], vec![0xf0, 0, 0, 0x66, 0x14, 0x00, 0xf7]]);
        listener.send_batch(&[vec![0xe0, 1, 2]]);
        let mut back: Vec<Vec<u8>> = vec![];
        assert!(wait(|| { back.extend(caller.recv()); !back.is_empty() }, 3));
        assert_eq!(back, vec![vec![0xe0, 1, 2]]);
        drop(caller);
        assert!(wait(|| !listener.is_up(), 3), "BY beendet die Sitzung");
    }
}
