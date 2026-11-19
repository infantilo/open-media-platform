//! UDP-Verbindung zur Kamera (VISCA über IP). Ein Thread besitzt den Socket; Zustand und Logik liegen in `ptz.rs`.

use std::collections::VecDeque;
use std::net::{ToSocketAddrs, UdpSocket};

use crate::ptz::{Out, Tag};
use crate::visca::{self, Packet};

pub struct Transport {
    sock: UdpSocket,
    /// Nächste zu sendende Sequenznummer (nach RESET ab 1).
    seq: u32,
    pending: VecDeque<(u32, Tag)>,
}

/// `host` oder `host:port` (Standard 52381).
pub fn normalize_target(t: &str) -> Result<String, String> {
    let t = t.trim();
    if t.is_empty() || t.len() > 255 || t.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Ziel: Adresse oder Name der Kamera (optional :Port)".to_string());
    }
    if t.starts_with('[') {
        return if t.contains("]:") { Ok(t.to_string()) } else { Ok(format!("{t}:{}", visca::PORT)) };
    }
    match t.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') && !h.is_empty() => {
            let port: u16 = p.parse().map_err(|_| "Port ist keine Zahl".to_string())?;
            if port == 0 {
                return Err("Port 0 ist ungültig".to_string());
            }
            Ok(t.to_string())
        }
        _ if t.contains(':') => Ok(format!("[{t}]:{}", visca::PORT)), // nackte IPv6-Adresse
        _ => Ok(format!("{t}:{}", visca::PORT)),
    }
}

impl Transport {
    pub fn connect(target: &str) -> std::io::Result<Self> {
        let addr = target
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "Adresse nicht auflösbar"))?;
        let sock = UdpSocket::bind(if addr.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" })?;
        sock.connect(addr)?;
        sock.set_nonblocking(true)?;
        Ok(Transport { sock, seq: 1, pending: VecDeque::new() })
    }

    pub fn send(&mut self, out: &Out) {
        let is_reset = out.kind == visca::payload_type::CONTROL;
        let seq = if is_reset { 0 } else { self.seq };
        let _ = self.sock.send(&visca::frame(out.kind, seq, &out.payload));
        if is_reset {
            self.seq = 1;
            self.pending.clear();
        } else {
            self.seq = self.seq.wrapping_add(1);
            self.pending.push_back((seq, out.tag));
            while self.pending.len() > 32 {
                self.pending.pop_front();
            }
        }
    }

    /// Alle bereitliegenden Pakete: (Paket, Zweck der Anfrage, falls bekannt).
    pub fn recv(&mut self) -> Vec<(Packet, Option<Tag>)> {
        let mut out = Vec::new();
        let mut buf = [0u8; 128];
        while let Ok(n) = self.sock.recv(&mut buf) {
            let Ok(p) = visca::parse(&buf[..n]) else { continue };
            let tag = self.pending.iter().rev().find(|(s, _)| *s == p.seq).map(|(_, t)| *t);
            out.push((p, tag));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ptz::Tag;

    #[test]
    fn ziel_normalisieren() {
        assert_eq!(normalize_target("cam1.lan").unwrap(), "cam1.lan:52381");
        assert_eq!(normalize_target(" 192.168.1.20:5678 ").unwrap(), "192.168.1.20:5678");
        assert_eq!(normalize_target("fe80::1").unwrap(), "[fe80::1]:52381");
        assert_eq!(normalize_target("[fe80::1]").unwrap(), "[fe80::1]:52381");
        assert_eq!(normalize_target("[fe80::1]:99").unwrap(), "[fe80::1]:99");
        assert!(normalize_target("").is_err());
        assert!(normalize_target("a b").is_err());
        assert!(normalize_target("cam:0").is_err());
        assert!(normalize_target("cam:x").is_err());
    }

    /// Vollständiger Weg über echtes UDP: Zustandsmaschine → Transport → Simulator → zurück.
    #[test]
    fn ende_zu_ende_gegen_simulator() {
        use crate::ptz::Ptz;
        use std::time::{Duration, Instant};
        let (port, cam) = crate::sim::spawn(0).unwrap();
        let mut t = Transport::connect(&format!("127.0.0.1:{port}")).unwrap();
        let mut p = Ptz::new(8);
        let start = Instant::now();
        let step = |p: &mut Ptz, t: &mut Transport, ms: u64| {
            let end = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < end {
                let now = start.elapsed().as_millis() as u64;
                p.tick(now);
                for o in p.outbox.drain(..).collect::<Vec<_>>() {
                    t.send(&o);
                }
                for (pkt, tag) in t.recv() {
                    match pkt.kind {
                        visca::payload_type::REPLY => {
                            if let Some(r) = visca::parse_reply(&pkt.payload) {
                                p.on_reply(now, tag.unwrap_or(Tag::Other), r);
                            }
                        }
                        visca::payload_type::CONTROL_REPLY => p.alive(now),
                        _ => {}
                    }
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        };
        // 1. Verbindung (RESET + Versionsabfrage)
        step(&mut p, &mut t, 400);
        assert!(p.link_up, "keine Verbindung zum Simulator");
        assert_eq!(p.version.map(|v| v.0), Some(1));
        // 2. Fahrt nach rechts, Position kommt über die Abfrage zurück
        p.move_axes(start.elapsed().as_millis() as u64, 1.0, 0.0).unwrap();
        for _ in 0..4 {
            step(&mut p, &mut t, 100);
            p.move_axes(start.elapsed().as_millis() as u64, 1.0, 0.0).unwrap(); // Haltezeit erneuern
        }
        assert!(cam.lock().unwrap().pan > 100.0);
        assert!(p.pan_tilt_pos.is_some_and(|x| x.0 > 50), "{:?}", p.pan_tilt_pos);
        // 3. Totmann: nicht erneuern → Node stoppt selbst
        step(&mut p, &mut t, 1400);
        assert!(!p.moving());
        let a = cam.lock().unwrap().pan;
        step(&mut p, &mut t, 300);
        let b = cam.lock().unwrap().pan;
        assert!((a - b).abs() < 1.0, "Kamera fährt weiter: {a} → {b}");
        // 4. Speichern, wegfahren, Abruf
        p.store(2, Some("Test".to_string())).unwrap();
        step(&mut p, &mut t, 100);
        assert!(cam.lock().unwrap().presets[1].is_some());
        p.goto(-500, 200, 1.0).unwrap();
        step(&mut p, &mut t, 2500);
        assert!((cam.lock().unwrap().pan + 500.0).abs() < 2.0);
        p.recall(2).unwrap();
        step(&mut p, &mut t, 2500);
        assert!((cam.lock().unwrap().pan - a).abs() < 3.0, "Abruf erreicht Position nicht");
        // 5. Abruf einer nicht gespeicherten Voreinstellung: Kamerafehler wird gemeldet, nichts bricht
        p.recall(7).unwrap();
        step(&mut p, &mut t, 150);
        assert!(p.rx_errors >= 1);
    }
}
