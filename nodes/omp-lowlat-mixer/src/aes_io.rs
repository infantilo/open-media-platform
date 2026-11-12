//! AES67-/ST-2110-30-artige RTP-Ströme (Empfang und Senden) über UDP, ohne GStreamer. Nutzlast und Kopf: [`crate::rtp`].
//! Empfang: ein Thread liest Pakete, füllt Lücken (≤ 8 Pakete) mit Stille, damit der Ring seinen Zeitbezug behält, und schiebt
//! die Rahmen in den Eingangsring ([`crate::ring::InRing`]); Unterschiede der Uhren gleicht der Ring aus. Senden: der Misch-Takt
//! schickt je Block ein oder mehrere Pakete; der RTP-Zeitstempel folgt der Hostzeit (TAI, bei PTP-geführtem Host = PTP-Zeit).

use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use socket2::{Domain, Protocol, Socket, Type};

use crate::ring::InRing;
use crate::rtp::{self, Format};

#[derive(Clone)]
pub struct RxCfg {
    pub addr: Ipv4Addr,
    pub port: u16,
    pub iface: Ipv4Addr,
    pub ch: usize,
    pub fmt: Format,
    pub pt: u8,
}

#[derive(Default)]
pub struct RxStats {
    pub packets: AtomicU64,
    pub lost: AtomicU64,
    pub rejected: AtomicU64,
    pub last_packet_ms: AtomicU64,
}

fn now_ms() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64 + 1
}

pub fn is_multicast(a: Ipv4Addr) -> bool {
    a.is_multicast()
}

/// Spannt `ip:port` oder nur `ip` (Port 5004) auf.
pub fn parse_endpoint(s: &str) -> Option<(Ipv4Addr, u16)> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    match s.rsplit_once(':') {
        Some((ip, port)) => Some((ip.parse().ok()?, port.parse().ok()?)),
        None => Some((s.parse().ok()?, 5004)),
    }
}

pub fn start_rx(cfg: RxCfg, ring: Arc<Mutex<InRing>>, stats: Arc<RxStats>, shutdown: Arc<AtomicBool>, packet_frames: usize) -> std::io::Result<std::thread::JoinHandle<()>> {
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    sock.set_reuse_address(true)?;
    let _ = sock.set_reuse_port(true);
    sock.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, cfg.port).into())?;
    if is_multicast(cfg.addr) {
        sock.join_multicast_v4(&cfg.addr, &cfg.iface)?;
    }
    sock.set_read_timeout(Some(Duration::from_millis(5)))?;
    let sock: UdpSocket = sock.into();
    std::thread::Builder::new().name("ll-aes-rx".into()).spawn(move || {
        let mut buf = vec![0u8; 2048];
        let mut pcm: Vec<f32> = Vec::with_capacity(packet_frames.max(48) * cfg.ch);
        let (mut last_seq, mut last_ssrc): (Option<u16>, u32) = (None, 0);
        while !shutdown.load(Ordering::Relaxed) {
            let n = match sock.recv(&mut buf) {
                Ok(n) => n,
                Err(_) => continue, // Zeitüberschreitung: Abbruchflagge prüfen
            };
            let Some(p) = rtp::parse_packet(&buf[..n], cfg.pt) else {
                stats.rejected.fetch_add(1, Ordering::Relaxed);
                continue;
            };
            pcm.clear();
            let frames = rtp::decode_payload(p.payload, cfg.fmt, cfg.ch, &mut pcm);
            if frames == 0 {
                stats.rejected.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            if last_ssrc != p.ssrc {
                // neuer Absender: Ring neu aufsetzen
                if last_seq.is_some() {
                    ring.lock().expect("lock poisoned").reset();
                }
                last_ssrc = p.ssrc;
                last_seq = None;
            }
            let mut fill_silence = 0usize;
            if let Some(prev) = last_seq {
                let diff = p.seq.wrapping_sub(prev.wrapping_add(1)) as i16;
                if diff > 0 && diff <= 8 {
                    stats.lost.fetch_add(diff as u64, Ordering::Relaxed);
                    fill_silence = diff as usize * frames;
                } else if diff < 0 {
                    stats.rejected.fetch_add(1, Ordering::Relaxed); // doppelt oder zu spät
                    continue;
                } else if diff > 8 {
                    stats.lost.fetch_add(diff as u64, Ordering::Relaxed);
                }
            }
            last_seq = Some(p.seq);
            stats.packets.fetch_add(1, Ordering::Relaxed);
            stats.last_packet_ms.store(now_ms(), Ordering::Relaxed);
            let mut r = ring.lock().expect("lock poisoned");
            if fill_silence > 0 {
                r.push(&vec![0.0f32; fill_silence * cfg.ch]);
            }
            r.push(&pcm);
        }
    })
}

pub struct Tx {
    sock: UdpSocket,
    pt: u8,
    fmt: Format,
    ch: usize,
    packet_frames: usize,
    ssrc: u32,
    seq: u16,
    ts: Option<u32>,
    buf: Vec<u8>,
    pub packets: u64,
    pub errors: u64,
}

impl Tx {
    #[allow(clippy::too_many_arguments)]
    pub fn new(addr: Ipv4Addr, port: u16, iface: Ipv4Addr, ttl: u32, ch: usize, fmt: Format, pt: u8, packet_frames: usize) -> std::io::Result<Self> {
        let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        sock.bind(&SocketAddrV4::new(iface, 0).into())?;
        // DSCP EF (46) für Medienverkehr; im Container/ohne Rechte darf das fehlschlagen
        let _ = sock.set_tos_v4(0xB8);
        if is_multicast(addr) {
            sock.set_multicast_ttl_v4(ttl)?;
            sock.set_multicast_loop_v4(true)?;
            let _ = sock.set_multicast_if_v4(&iface);
        }
        sock.connect(&SocketAddrV4::new(addr, port).into())?;
        let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        Ok(Self { sock: sock.into(), pt, fmt, ch, packet_frames, ssrc: (seed ^ (seed >> 32)) as u32, seq: (seed >> 7) as u16, ts: None, buf: Vec::with_capacity(rtp::HEADER + packet_frames * ch * 3), packets: 0, errors: 0 })
    }

    /// Sendet `frames` (interleaved, Vielfaches von `packet_frames` Rahmen). `tai_ns` = Zeit des ersten Rahmens.
    pub fn send(&mut self, tai_ns: u64, frames: &[f32]) {
        let per = self.packet_frames * self.ch;
        let host_ts = (tai_ns as u128 * rtp::SAMPLE_RATE as u128 / 1_000_000_000) as u32;
        let mut ts = match self.ts {
            None => host_ts,
            Some(t) => {
                // dauerhafte Abweichung von der Hostzeit (> 2 Pakete): auf die Hostzeit zurücksetzen
                if (host_ts.wrapping_sub(t) as i32).unsigned_abs() as usize > 2 * self.packet_frames { host_ts } else { t }
            }
        };
        for chunk in frames.chunks(per) {
            if chunk.len() < per {
                break;
            }
            rtp::build_packet(&mut self.buf, self.pt, self.seq, ts, self.ssrc, self.fmt, chunk);
            if self.sock.send(&self.buf).is_ok() {
                self.packets += 1;
            } else {
                self.errors += 1;
            }
            self.seq = self.seq.wrapping_add(1);
            ts = ts.wrapping_add(self.packet_frames as u32);
        }
        self.ts = Some(ts);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_parsing() {
        assert_eq!(parse_endpoint("239.69.1.1:5004"), Some((Ipv4Addr::new(239, 69, 1, 1), 5004)));
        assert_eq!(parse_endpoint("10.0.0.7"), Some((Ipv4Addr::new(10, 0, 0, 7), 5004)));
        assert_eq!(parse_endpoint(""), None);
        assert_eq!(parse_endpoint("nonsense:1"), None);
    }

    /// Senden → Empfang über Loopback (Unicast): Pakete kommen als Rahmen im Ring an, keine Lücken.
    #[test]
    fn loopback_tx_to_rx_fills_ring() {
        let port = 41_000 + (std::process::id() % 2000) as u16;
        let ring = Arc::new(Mutex::new(InRing::new(2, 48, 24, 4800, false)));
        let stats = Arc::new(RxStats::default());
        let stop = Arc::new(AtomicBool::new(false));
        let cfg = RxCfg { addr: Ipv4Addr::LOCALHOST, port, iface: Ipv4Addr::UNSPECIFIED, ch: 2, fmt: Format::L24, pt: 97 };
        let h = start_rx(cfg, ring.clone(), stats.clone(), stop.clone(), 48).unwrap();
        let mut tx = Tx::new(Ipv4Addr::LOCALHOST, port, Ipv4Addr::LOCALHOST, 1, 2, Format::L24, 97, 48).unwrap();
        for i in 0..50u64 {
            tx.send(1_000_000_000 + i * 1_000_000, &vec![0.25f32; 96]);
            std::thread::sleep(Duration::from_millis(1));
        }
        std::thread::sleep(Duration::from_millis(30));
        stop.store(true, Ordering::Relaxed);
        h.join().unwrap();
        assert_eq!(tx.packets, 50);
        assert!(stats.packets.load(Ordering::Relaxed) >= 48, "empfangen: {}", stats.packets.load(Ordering::Relaxed));
        assert_eq!(stats.lost.load(Ordering::Relaxed), 0);
        assert!(ring.lock().unwrap().fill_frames() >= 48 * 40);
    }
}
