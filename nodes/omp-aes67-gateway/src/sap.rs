//! Minimale SAP-Implementierung (RFC 2974, "Session Announcement
//! Protocol") — Kapitel 19 Teil 3, `docs/END-GOAL-FEATURES.md` §19.3c:
//! "eine kleine SAP-Komponente ... wenige hundert Zeilen, kein
//! GStreamer-Element nötig". Reines UDP/Multicast auf
//! `239.255.255.255:9875` (RFC-2974-Standardgruppe/-Port für
//! IPv4/global scope), keine neue Dependency — Paketformat von Hand
//! nach RFC 2974 §3 gebaut/geparst, exakt wie `sdp.rs` (video) schon
//! bewusst auf einen vollen RFC-4566-Parser verzichtet.
//!
//! Zwei Rollen, unabhängig von der Gateway-Richtung (`main.rs`):
//! - [`Announcer`]: sendet periodisch ein SAP-Announce-Paket mit dem
//!   eigenen SDP als Payload — für die **Source**-Rolle (dieser Node
//!   sendet AES67 ins LAN, Fremdgeräte müssen ihn per SAP finden
//!   können), auf `Drop` zusätzlich ein Delete-Paket (RFC 2974 §3,
//!   Type-Bit gesetzt) statt nur stillzuwerden — Empfänger räumen die
//!   Session dann sofort auf, statt auf ihr eigenes Timeout zu warten.
//! - [`Listener`]: hört fortlaufend mit, sammelt entdeckte Sessions
//!   (Adresse+Message-ID als Schlüssel, wie RFC 2974 es für
//!   Update-/Delete-Erkennung vorschreibt) — für die **Sink**-Rolle
//!   (Fremdgeräte/-Werkzeuge senden AES67 ins LAN, dieser Node muss sie
//!   per SAP finden, bevor er weiß, welche Adresse/welchen Port er
//!   überhaupt abonnieren soll).

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const SAP_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 255);
pub const SAP_PORT: u16 = 9875;

const PAYLOAD_TYPE: &[u8] = b"application/sdp\0";

fn build_packet(msg_id_hash: u16, origin: Ipv4Addr, sdp: &str, delete: bool) -> Vec<u8> {
    let mut packet = Vec::with_capacity(8 + PAYLOAD_TYPE.len() + sdp.len());
    // RFC 2974 §3: V=1 (Bits 7-5), A=0 (Bits4, IPv4-Origin), R=0 (Bit3),
    // T=Löschung? (Bit2), E=0 (Bit1, unverschlüsselt), C=0 (Bit0,
    // unkomprimiert).
    let flags: u8 = (1 << 5) | if delete { 1 << 2 } else { 0 };
    packet.push(flags);
    packet.push(0); // Authentication Length = 0 (keine Authentifizierung)
    packet.extend_from_slice(&msg_id_hash.to_be_bytes());
    packet.extend_from_slice(&origin.octets());
    packet.extend_from_slice(PAYLOAD_TYPE);
    packet.extend_from_slice(sdp.as_bytes());
    packet
}

/// Parst ein empfangenes SAP-Paket. Gibt `None` zurück, wenn es kein
/// gültiges SAPv1/IPv4-Announce-oder-Delete-Paket mit
/// `application/sdp`-Payload ist (RFC 2974 erlaubt weitere Varianten —
/// IPv6-Origin, Verschlüsselung, Komprimierung, Authentifizierung —,
/// die hier bewusst nicht unterstützt werden: kein am Markt verbreitetes
/// AES67-/Dante-Gerät nutzt sie für einfache Audio-Announcements).
fn parse_packet(data: &[u8]) -> Option<(u16, Ipv4Addr, bool, String)> {
    if data.len() < 8 {
        return None;
    }
    let flags = data[0];
    let version = flags >> 5;
    let address_is_ipv6 = (flags >> 4) & 1 == 1;
    let compressed = flags & 1 == 1;
    let encrypted = (flags >> 1) & 1 == 1;
    if version != 1 || address_is_ipv6 || compressed || encrypted {
        return None;
    }
    let delete = (flags >> 2) & 1 == 1;
    let auth_len = data[1] as usize;
    let msg_id_hash = u16::from_be_bytes([data[2], data[3]]);
    let origin = Ipv4Addr::new(data[4], data[5], data[6], data[7]);

    let mut offset = 8 + auth_len * 4;
    if offset > data.len() {
        return None;
    }
    let rest = &data[offset..];
    let type_end = rest.iter().position(|&b| b == 0)?;
    let payload_type = &rest[..type_end];
    offset += type_end + 1;
    if payload_type != b"application/sdp" || offset > data.len() {
        return None;
    }
    let sdp = String::from_utf8_lossy(&data[offset..]).into_owned();
    Some((msg_id_hash, origin, delete, sdp))
}

/// Sendet ein SAP-Announce-Paket alle `interval` (RFC 2974 empfiehlt
/// eine Bandbreitengrenze über alle Announcements im Netz statt eines
/// festen Intervalls — für die hier realistische Handvoll AES67-
/// Sessions genügt ein einfaches festes Intervall bei weitem, ein
/// vollständiger Bandbreitenrechner wäre Überengineering für diese
/// Scheibe). Der Hintergrund-Thread endet erst, wenn [`Announcer`]
/// gedroppt wird — dann geht zusätzlich ein Delete-Paket raus.
pub struct Announcer {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    socket: UdpSocket,
    msg_id_hash: u16,
    origin: Ipv4Addr,
}

impl Announcer {
    /// `origin` geht nur als Absenderadresse ins SAP-Paket selbst ein
    /// (RFC 2974 §3 "originating source"), **nicht** in den Socket-Bind
    /// — live entdeckt: ein Bind auf `origin` (bzw. ein explizites
    /// `IP_MULTICAST_IF` auf dieselbe Adresse) lässt den Kernel die
    /// Multicast-Zielschnittstelle nach der Bind-/IF-Adresse wählen statt
    /// nach der Routing-Tabelle — auf einer Maschine, deren `lo` kein
    /// `MULTICAST`-Interface-Flag trägt (per `ip addr` bestätigt, hier im
    /// Dev-Sandbox der Fall), verschwinden Pakete dann lautlos, obwohl
    /// derselbe Code mit `origin=127.0.0.1` als reiner Paket-Inhalt und
    /// einem `UNSPECIFIED`-Bind (Kernel wählt die Zielschnittstelle über
    /// die Routing-Tabelle, hier `eth0`, das echtes Multicast-Loopback
    /// unterstützt) zuverlässig ankommt. Ein Bind auf `UNSPECIFIED` ist
    /// zudem die für reale Mehr-Interface-Hosts richtige Grundeinstellung
    /// (Betriebssystem-Routing statt geraten) — ein Deployment mit
    /// dediziertem Media-Interface würde stattdessen eine System-Route
    /// für die SAP-Gruppe auf dieses Interface setzen, nicht den Code
    /// ändern.
    pub fn start(origin: Ipv4Addr, sdp: String, interval: Duration) -> Result<Self, String> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| format!("SAP-Socket binden: {e}"))?;
        socket
            .set_multicast_ttl_v4(15) // RFC 2974 §2 empfiehlt TTL 15 als Site-Local-Standard.
            .map_err(|e| format!("SAP multicast TTL setzen: {e}"))?;
        let msg_id_hash = std::process::id() as u16;

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread_socket = socket.try_clone().map_err(|e| format!("SAP-Socket klonen: {e}"))?;
        let thread = std::thread::spawn(move || {
            let dest = SocketAddrV4::new(SAP_GROUP, SAP_PORT);
            while !thread_stop.load(Ordering::Relaxed) {
                let packet = build_packet(msg_id_hash, origin, &sdp, false);
                if let Err(e) = thread_socket.send_to(&packet, dest) {
                    eprintln!("omp-aes67-gateway: SAP-Announce senden fehlgeschlagen: {e}");
                }
                let deadline = Instant::now() + interval;
                while Instant::now() < deadline {
                    if thread_stop.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
        });

        Ok(Announcer { stop, thread: Some(thread), socket, msg_id_hash, origin })
    }
}

impl Drop for Announcer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        // Explizites Delete-Paket (RFC 2974 §3) statt nur stillzuwerden
        // — Sink-seitige Listener räumen die Session sofort auf.
        let packet = build_packet(self.msg_id_hash, self.origin, "", true);
        let _ = self.socket.send_to(&packet, SocketAddrV4::new(SAP_GROUP, SAP_PORT));
    }
}

#[derive(Debug, Clone)]
pub struct SapSession {
    pub sdp: String,
    pub last_seen: Instant,
}

/// Fallback-Verfallszeit für Sessions ohne empfangenes Delete-Paket
/// (abgestürztes/vom Netz getrenntes Gerät) — deutlich über dem
/// größten in diesem Crate konfigurierbaren Announce-Intervall, damit
/// eine normal weiterlaufende Quelle nie fälschlich als verschwunden
/// gilt, RFC 2974 nennt hierfür keinen festen Wert (nur eine
/// Bandbreiten-Empfehlung fürs Intervall selbst).
const SESSION_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Hört fortlaufend auf `239.255.255.255:9875` und sammelt entdeckte
/// Sessions nach `(origin, msg_id_hash)` (RFC 2974 §3: dieses Paar
/// identifiziert eine Session eindeutig über wiederholte
/// Announcements/Updates hinweg). Ein Delete-Paket entfernt den
/// Eintrag sofort; ohne Delete-Paket (abgestürztes Gerät) verfällt er
/// nach `SESSION_TIMEOUT`.
pub struct Listener {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    sessions: Arc<Mutex<HashMap<(Ipv4Addr, u16), SapSession>>>,
}

impl Listener {
    pub fn start() -> Result<Self, String> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, SAP_PORT))
            .map_err(|e| format!("SAP-Listen-Socket binden ({SAP_GROUP}:{SAP_PORT}): {e}"))?;
        socket
            .join_multicast_v4(&SAP_GROUP, &Ipv4Addr::UNSPECIFIED)
            .map_err(|e| format!("SAP-Multicast-Gruppe beitreten: {e}"))?;
        socket
            .set_read_timeout(Some(Duration::from_millis(500)))
            .map_err(|e| format!("SAP-Socket-Timeout setzen: {e}"))?;

        let stop = Arc::new(AtomicBool::new(false));
        let sessions: Arc<Mutex<HashMap<(Ipv4Addr, u16), SapSession>>> = Arc::new(Mutex::new(HashMap::new()));

        let thread_stop = stop.clone();
        let thread_sessions = sessions.clone();
        let thread = std::thread::spawn(move || {
            let mut buf = [0u8; 65536];
            while !thread_stop.load(Ordering::Relaxed) {
                match socket.recv_from(&mut buf) {
                    Ok((len, _from)) => {
                        if let Some((msg_id_hash, origin, delete, sdp)) = parse_packet(&buf[..len]) {
                            let mut sessions = thread_sessions.lock().expect("lock poisoned");
                            if delete {
                                sessions.remove(&(origin, msg_id_hash));
                            } else {
                                sessions
                                    .insert((origin, msg_id_hash), SapSession { sdp, last_seen: Instant::now() });
                            }
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(e) => {
                        eprintln!("omp-aes67-gateway: SAP-Empfang fehlgeschlagen: {e}");
                    }
                }
            }
        });

        Ok(Listener { stop, thread: Some(thread), sessions })
    }

    /// Alle aktuell bekannten, nicht verfallenen Sessions (s.
    /// `SESSION_TIMEOUT`) — räumt bei jedem Aufruf zusätzlich verfallene
    /// Einträge aus der internen Map, kein separater Cleanup-Thread
    /// nötig (dieselbe Lazy-Aufräum-Idee wie an anderen Stellen im
    /// Projekt, z. B. Crash-Loop-Fenstern).
    pub fn sessions(&self) -> Vec<SapSession> {
        let mut sessions = self.sessions.lock().expect("lock poisoned");
        sessions.retain(|_, session| session.last_seen.elapsed() < SESSION_TIMEOUT);
        sessions.values().cloned().collect()
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_roundtrip_announce() {
        let origin = Ipv4Addr::new(10, 0, 0, 5);
        let sdp = "v=0\r\ns=Test\r\n";
        let packet = build_packet(4242, origin, sdp, false);
        let (msg_id, parsed_origin, delete, parsed_sdp) = parse_packet(&packet).expect("parse_packet");
        assert_eq!(msg_id, 4242);
        assert_eq!(parsed_origin, origin);
        assert!(!delete);
        assert_eq!(parsed_sdp, sdp);
    }

    #[test]
    fn packet_roundtrip_delete() {
        let origin = Ipv4Addr::new(10, 0, 0, 5);
        let packet = build_packet(4242, origin, "", true);
        let (_, _, delete, _) = parse_packet(&packet).expect("parse_packet");
        assert!(delete);
    }

    /// Ein reales SAPv1-Announce-Paket enthält den `V=1`-Header korrekt
    /// in den oberen drei Bits von Byte 0 — dieser Test verifiziert
    /// gegen exakt den in RFC 2974 §3 abgedruckten Bit-Layout-Wert
    /// (`0x20` = `001 0 0 0 0 0`), nicht nur gegen den eigenen `build_packet`.
    #[test]
    fn flags_byte_matches_rfc2974_layout() {
        let origin = Ipv4Addr::new(127, 0, 0, 1);
        let packet = build_packet(1, origin, "v=0\r\n", false);
        assert_eq!(packet[0], 0x20, "V=1,A=0,R=0,T=0,E=0,C=0 muss 0b00100000 = 0x20 sein");
    }

    #[test]
    fn ignores_non_sdp_payload_type() {
        let mut packet = vec![0x20u8, 0, 0, 1, 127, 0, 0, 1];
        packet.extend_from_slice(b"application/xml\0<x/>");
        assert!(parse_packet(&packet).is_none());
    }

    #[test]
    fn ignores_short_packet() {
        assert!(parse_packet(&[0x20, 0, 0, 1]).is_none());
    }
}
