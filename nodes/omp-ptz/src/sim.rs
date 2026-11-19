//! Kamera-Simulator für VISCA über IP (nur Entwicklung und Tests; §0 Regel 7: keine Hardware nötig). Bildet ein Gerät nach, das die
//! Befehle von `visca.rs` annimmt, ACK/Abschluss/Fehler antwortet und Pan/Tilt/Zoom mit der gefahrenen Geschwindigkeit bewegt.
//! Die Wertebereiche und Geschwindigkeiten sind **erfunden** (kein Modell nachgebaut).

use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::visca;

pub const PAN_RANGE: i16 = 2448;
pub const TILT_MIN: i16 = -432;
pub const TILT_MAX: i16 = 1296;
pub const ZOOM_MAX: u16 = 0x4000;
/// Einheiten je Sekunde bei Geschwindigkeitsstufe 1 (Pan/Tilt) bzw. je Stufe (Zoom).
const UNITS_PER_STEP: f64 = 40.0;
const ZOOM_UNITS_PER_STEP: f64 = 1200.0;

pub struct SimCam {
    pub pan: f64,
    pub tilt: f64,
    pub zoom: f64,
    vel_pan: f64,
    vel_tilt: f64,
    vel_zoom: f64,
    /// Ziel einer absoluten Fahrt: (pan, tilt, Einheiten/s).
    target: Option<(f64, f64, f64)>,
    pub presets: [Option<(i16, i16, u16)>; 64],
    last: Instant,
    pub expect_seq: u32,
    pub commands: Vec<Vec<u8>>,
}

impl SimCam {
    pub fn new(now: Instant) -> Self {
        SimCam {
            pan: 0.0,
            tilt: 0.0,
            zoom: 0.0,
            vel_pan: 0.0,
            vel_tilt: 0.0,
            vel_zoom: 0.0,
            target: None,
            presets: [None; 64],
            last: now,
            expect_seq: 0,
            commands: Vec::new(),
        }
    }

    pub fn advance(&mut self, now: Instant) {
        let dt = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        if let Some((tp, tt, rate)) = self.target {
            let (dp, dt_) = (tp - self.pan, tt - self.tilt);
            let dist = (dp * dp + dt_ * dt_).sqrt();
            let step = rate * dt;
            if dist <= step {
                self.pan = tp;
                self.tilt = tt;
                self.target = None;
            } else {
                self.pan += dp / dist * step;
                self.tilt += dt_ / dist * step;
            }
        } else {
            self.pan = (self.pan + self.vel_pan * dt).clamp(-(PAN_RANGE as f64), PAN_RANGE as f64);
            self.tilt = (self.tilt + self.vel_tilt * dt).clamp(TILT_MIN as f64, TILT_MAX as f64);
        }
        self.zoom = (self.zoom + self.vel_zoom * dt).clamp(0.0, ZOOM_MAX as f64);
    }

    fn pan_tilt_in_range(p: i16, t: i16) -> bool {
        (-PAN_RANGE..=PAN_RANGE).contains(&p) && (TILT_MIN..=TILT_MAX).contains(&t)
    }

    /// Verarbeitet eine VISCA-Nachricht, liefert die Antwortnachrichten (ACK, dann Abschluss/Fehler).
    pub fn handle(&mut self, now: Instant, msg: &[u8]) -> Vec<Vec<u8>> {
        self.advance(now);
        self.commands.push(msg.to_vec());
        let err = |code: u8| vec![vec![0x90, 0x60 | 0x01, code, 0xFF]];
        let ack_done = || vec![vec![0x90, 0x41, 0xFF], vec![0x90, 0x51, 0xFF]];
        if msg.len() < 5 || msg[0] != 0x81 || *msg.last().unwrap() != 0xFF {
            return err(0x02);
        }
        match (msg[1], &msg[2..msg.len() - 1]) {
            // Pan-Tilt-Fahrt
            (0x01, [0x06, 0x01, vv, ww, p, t]) => {
                let dirp = match p {
                    1 => -1.0,
                    2 => 1.0,
                    3 => 0.0,
                    _ => return err(0x02),
                };
                let dirt = match t {
                    1 => 1.0,
                    2 => -1.0,
                    3 => 0.0,
                    _ => return err(0x02),
                };
                if !(1..=0x20).contains(vv) || !(1..=0x20).contains(ww) {
                    return err(0x02);
                }
                self.target = None;
                self.vel_pan = dirp * *vv as f64 * UNITS_PER_STEP;
                self.vel_tilt = dirt * *ww as f64 * UNITS_PER_STEP;
                vec![vec![0x90, 0x41, 0xFF]]
            }
            // Absolute Position
            (0x01, [0x06, 0x02, vv, ww, n @ ..]) if n.len() == 8 => {
                let (Some(p), Some(t)) = (visca::from_nibbles16(&n[..4]), visca::from_nibbles16(&n[4..])) else { return err(0x02) };
                if !Self::pan_tilt_in_range(p, t) || *vv == 0 || *ww == 0 {
                    return err(0x41);
                }
                self.vel_pan = 0.0;
                self.vel_tilt = 0.0;
                self.target = Some((p as f64, t as f64, (*vv).max(*ww) as f64 * UNITS_PER_STEP));
                vec![vec![0x90, 0x41, 0xFF]]
            }
            (0x01, [0x06, 0x04]) => {
                self.vel_pan = 0.0;
                self.vel_tilt = 0.0;
                self.target = Some((0.0, 0.0, 24.0 * UNITS_PER_STEP));
                ack_done()
            }
            // Zoom
            (0x01, [0x04, 0x07, v]) => {
                let (dir, sp) = match v >> 4 {
                    0 if *v == 0 => (0.0, 0),
                    2 => (1.0, v & 0x0F),
                    3 => (-1.0, v & 0x0F),
                    _ => return err(0x02),
                };
                if sp > 7 {
                    return err(0x02);
                }
                self.vel_zoom = dir * (sp as f64 + 1.0) * ZOOM_UNITS_PER_STEP;
                if dir == 0.0 {
                    self.vel_zoom = 0.0;
                }
                ack_done()
            }
            (0x01, [0x04, 0x47, n @ ..]) if n.len() == 4 => {
                let Some(z) = visca::from_nibbles16(n) else { return err(0x02) };
                if (z as u16) > ZOOM_MAX {
                    return err(0x41);
                }
                self.vel_zoom = 0.0;
                self.zoom = z as u16 as f64;
                ack_done()
            }
            // Voreinstellungen
            (0x01, [0x04, 0x3F, op, n]) => {
                if *n > 63 {
                    return err(0x41);
                }
                match op {
                    0 => self.presets[*n as usize] = None,
                    1 => self.presets[*n as usize] = Some((self.pan as i16, self.tilt as i16, self.zoom as u16)),
                    2 => match self.presets[*n as usize] {
                        Some((p, t, z)) => {
                            self.vel_pan = 0.0;
                            self.vel_tilt = 0.0;
                            self.target = Some((p as f64, t as f64, 20.0 * UNITS_PER_STEP));
                            self.zoom = z as f64;
                        }
                        None => return err(0x41),
                    },
                    _ => return err(0x02),
                }
                ack_done()
            }
            // Abfragen (ohne ACK)
            (0x09, [0x06, 0x12]) => {
                let mut v = vec![0x90, 0x50];
                v.extend_from_slice(&visca::nibbles16(self.pan.round() as i16));
                v.extend_from_slice(&visca::nibbles16(self.tilt.round() as i16));
                v.push(0xFF);
                vec![v]
            }
            (0x09, [0x04, 0x47]) => {
                let mut v = vec![0x90, 0x50];
                v.extend_from_slice(&visca::nibbles16(self.zoom.round() as u16 as i16));
                v.push(0xFF);
                vec![v]
            }
            (0x09, [0x00, 0x02]) => vec![vec![0x90, 0x50, 0x00, 0x01, 0xFF, 0xFE, 0x00, 0x01, 0x02, 0xFF]],
            _ => err(0x02),
        }
    }
}

/// Startet den Simulator auf `127.0.0.1:<Port>` (0 = frei) in einem Thread; liefert den Port und den Zustand (für Tests).
pub fn spawn(port: u16) -> std::io::Result<(u16, Arc<Mutex<SimCam>>)> {
    let sock = UdpSocket::bind(("127.0.0.1", port))?;
    sock.set_read_timeout(Some(Duration::from_millis(50)))?;
    let port = sock.local_addr()?.port();
    let cam = Arc::new(Mutex::new(SimCam::new(Instant::now())));
    let c = cam.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 64];
        loop {
            let Ok((n, from)) = sock.recv_from(&mut buf) else {
                c.lock().expect("lock poisoned").advance(Instant::now());
                continue;
            };
            let Ok(pkt) = visca::parse(&buf[..n]) else { continue };
            let mut cam = c.lock().expect("lock poisoned");
            let now = Instant::now();
            match pkt.kind {
                visca::payload_type::CONTROL if pkt.payload == [visca::CONTROL_RESET] => {
                    // Nach RESET zählt das Gerät ab 1 (die Nummer des RESET selbst wird ignoriert).
                    cam.expect_seq = 1;
                    let _ = sock.send_to(&visca::frame(visca::payload_type::CONTROL_REPLY, 0, &[0x01]), from);
                }
                visca::payload_type::COMMAND | visca::payload_type::INQUIRY => {
                    // Sequenzfehler wie in der Liste: Steuer-Fehler 0x0F01.
                    if pkt.seq != cam.expect_seq {
                        let _ = sock.send_to(&visca::frame(visca::payload_type::CONTROL_REPLY, pkt.seq, &[0x0F, 0x01]), from);
                        continue;
                    }
                    cam.expect_seq = cam.expect_seq.wrapping_add(1);
                    for r in cam.handle(now, &pkt.payload) {
                        let _ = sock.send_to(&visca::frame(visca::payload_type::REPLY, pkt.seq, &r), from);
                    }
                }
                _ => {}
            }
        }
    });
    Ok((port, cam))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn fahrt_bewegt_und_stopp_haelt() {
        let t = t0();
        let mut c = SimCam::new(t);
        assert_eq!(c.handle(t, &visca::pan_tilt_drive(10, 1, visca::PanDir::Right, visca::TiltDir::Stop)), vec![vec![0x90, 0x41, 0xFF]]);
        c.advance(t + Duration::from_secs(1));
        assert!((c.pan - 400.0).abs() < 1.0, "{}", c.pan);
        c.handle(t + Duration::from_secs(1), &visca::pan_tilt_stop());
        c.advance(t + Duration::from_secs(3));
        assert!((c.pan - 400.0).abs() < 1.0);
    }

    #[test]
    fn anschlag_wird_begrenzt() {
        let t = t0();
        let mut c = SimCam::new(t);
        c.handle(t, &visca::pan_tilt_drive(0x18, 1, visca::PanDir::Left, visca::TiltDir::Stop));
        c.advance(t + Duration::from_secs(60));
        assert_eq!(c.pan, -(PAN_RANGE as f64));
    }

    #[test]
    fn absolut_preset_und_fehler() {
        let t = t0();
        let mut c = SimCam::new(t);
        assert_eq!(c.handle(t, &visca::pan_tilt_absolute(0x18, 0x18, 3000, 0)), vec![vec![0x90, 0x61, 0x41, 0xFF]]); // außerhalb
        c.handle(t, &visca::pan_tilt_absolute(0x18, 0x18, 100, 50));
        c.advance(t + Duration::from_secs(1));
        assert_eq!((c.pan, c.tilt), (100.0, 50.0));
        c.handle(t + Duration::from_secs(1), &visca::preset(visca::PresetOp::Set, 4));
        assert_eq!(c.presets[4], Some((100, 50, 0)));
        assert_eq!(c.handle(t, &visca::preset(visca::PresetOp::Recall, 9)), vec![vec![0x90, 0x61, 0x41, 0xFF]]); // nicht gespeichert
        assert_eq!(c.handle(t, &visca::preset(visca::PresetOp::Recall, 64)), vec![vec![0x90, 0x61, 0x41, 0xFF]]);
        assert_eq!(c.handle(t, &[0x81, 0x01, 0x04, 0x38, 0xFF]), vec![vec![0x90, 0x61, 0x02, 0xFF]]); // Syntaxfehler
    }

    #[test]
    fn abfragen_liefern_position() {
        let t = t0();
        let mut c = SimCam::new(t);
        c.pan = -12.0;
        c.tilt = 34.0;
        let r = c.handle(t, &visca::inq_pan_tilt_position());
        let Some(visca::Reply::Completion { data, .. }) = visca::parse_reply(&r[0]) else { panic!() };
        assert_eq!(visca::decode_pan_tilt(&data), Some((-12, 34)));
        let r = c.handle(t, &visca::inq_version());
        let Some(visca::Reply::Completion { data, .. }) = visca::parse_reply(&r[0]) else { panic!() };
        assert_eq!(visca::decode_version(&data).map(|v| v.0), Some(1));
    }
}
