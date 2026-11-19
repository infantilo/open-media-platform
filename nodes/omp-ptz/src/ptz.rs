//! Zustandsmaschine einer PTZ-Kamera (Kapitel 104). Reine Logik: Zeit kommt als Millisekunden-Argument, Ausgabe sind
//! Nachrichten im `outbox` (VISCA-Nutzlast + Zweck), Eingabe sind Antworten. Die Ein-/Ausgabe (UDP) liegt in `io.rs`.
//!
//! **Haltezeit (Totmann):** Eine Fahrt (Pan/Tilt oder Zoom) läuft in der Kamera, bis ein Stopp-Befehl kommt. Bricht die Bedienung
//! ab (Browser zu, Netz weg), liefe die Kamera in den Anschlag. Darum gilt jede Fahrt nur für `hold_ms`; der Bediener erneuert sie
//! (`move` wiederholen), sonst sendet der Node selbst Stopp. Das ist eine Eigenlösung von OMP, in VISCA nicht vorgesehen.

use std::collections::VecDeque;

use crate::visca::{self, PanDir, PresetOp, TiltDir};

pub const DEADZONE: f64 = 0.04;
/// Zoom-Geschwindigkeitsstufen laut Liste (`0…7`).
pub const ZOOM_MAX_SPEED: u8 = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inquiry {
    PanTilt,
    Zoom,
    Version,
}

/// Wozu eine gesendete Nachricht diente — damit Antworten (ACK/Fehler/Abschluss) zugeordnet werden können.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tag {
    Inquiry(Inquiry),
    Preset(PresetOp, u8),
    Drive,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Out {
    /// Nutzlasttyp des Paketkopfs.
    pub kind: u16,
    pub payload: Vec<u8>,
    pub tag: Tag,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Link { up: bool },
    HoldExpired { what: &'static str },
    CameraError { code: u8, text: &'static str, tag: String },
    PresetRecalled { number: u8, name: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preset {
    pub name: String,
    pub stored: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DriveState {
    pan_speed: u8,
    tilt_speed: u8,
    pan: PanDir,
    tilt: TiltDir,
}

pub struct Ptz {
    pub pan_max: u8,
    pub tilt_max: u8,
    pub hold_ms: u64,
    pub poll_ms: u64,
    pub link_timeout_ms: u64,
    pub link_up: bool,
    pub pan_tilt_pos: Option<(i16, i16)>,
    pub zoom_pos: Option<u16>,
    /// `(Hersteller, Modell, ROM-Stand)` aus der Versionsabfrage.
    pub version: Option<(u16, u16, u16)>,
    /// Voreinstellungen, Index = Nummer − 1.
    pub presets: Vec<Preset>,
    pub outbox: VecDeque<Out>,
    pub events: Vec<Event>,
    last_rx_ms: Option<u64>,
    next_poll_ms: u64,
    drive: Option<DriveState>,
    drive_deadline: Option<u64>,
    zoom: Option<(bool, u8)>,
    zoom_deadline: Option<u64>,
    pub rx_errors: u64,
}

fn axis_speed(v: f64, max: u8) -> u8 {
    let a = v.abs().min(1.0);
    (1.0 + a.powf(1.5) * (max.max(1) as f64 - 1.0)).round().clamp(1.0, max.max(1) as f64) as u8
}

impl Ptz {
    pub fn new(preset_count: usize) -> Self {
        Ptz {
            pan_max: 0x18,
            tilt_max: 0x14,
            hold_ms: 1000,
            poll_ms: 500,
            link_timeout_ms: 2500,
            link_up: false,
            pan_tilt_pos: None,
            zoom_pos: None,
            version: None,
            presets: (1..=preset_count.clamp(1, 64)).map(|n| Preset { name: format!("Preset {n}"), stored: false }).collect(),
            outbox: VecDeque::new(),
            events: Vec::new(),
            last_rx_ms: None,
            next_poll_ms: 0,
            drive: None,
            drive_deadline: None,
            zoom: None,
            zoom_deadline: None,
            rx_errors: 0,
        }
    }

    pub fn moving(&self) -> bool {
        self.drive.is_some() || self.zoom.is_some()
    }

    fn push(&mut self, payload: Vec<u8>, tag: Tag, inquiry: bool) {
        let kind = if inquiry { visca::payload_type::INQUIRY } else { visca::payload_type::COMMAND };
        // Der Puffer ist begrenzt: ein hängender Sender soll nicht beliebig anwachsen.
        if self.outbox.len() >= 64 {
            self.outbox.pop_front();
        }
        self.outbox.push_back(Out { kind, payload, tag });
    }

    fn need_link(&self) -> Result<(), String> {
        if self.link_up { Ok(()) } else { Err("Kamera nicht erreichbar".to_string()) }
    }

    // ───────────── Bedienung ─────────────

    /// Pan/Tilt-Fahrt, `pan`/`tilt` in −1…1 (links/unten negativ). Erneuern verlängert die Haltezeit; (0, 0) stoppt.
    pub fn move_axes(&mut self, now: u64, pan: f64, tilt: f64) -> Result<(), String> {
        self.need_link()?;
        if !pan.is_finite() || !tilt.is_finite() {
            return Err("pan/tilt müssen Zahlen sein".to_string());
        }
        let pd = if pan.abs() < DEADZONE { PanDir::Stop } else if pan < 0.0 { PanDir::Left } else { PanDir::Right };
        let td = if tilt.abs() < DEADZONE { TiltDir::Stop } else if tilt < 0.0 { TiltDir::Down } else { TiltDir::Up };
        if pd == PanDir::Stop && td == TiltDir::Stop {
            return self.stop_drive();
        }
        let want = DriveState {
            pan_speed: if pd == PanDir::Stop { 1 } else { axis_speed(pan, self.pan_max) },
            tilt_speed: if td == TiltDir::Stop { 1 } else { axis_speed(tilt, self.tilt_max) },
            pan: pd,
            tilt: td,
        };
        if self.drive != Some(want) {
            self.push(visca::pan_tilt_drive(want.pan_speed, want.tilt_speed, want.pan, want.tilt), Tag::Drive, false);
            self.drive = Some(want);
        }
        self.drive_deadline = Some(now + self.hold_ms);
        Ok(())
    }

    fn stop_drive(&mut self) -> Result<(), String> {
        if self.drive.take().is_some() {
            self.push(visca::pan_tilt_stop(), Tag::Drive, false);
        }
        self.drive_deadline = None;
        Ok(())
    }

    /// Zoomfahrt `speed` in −1…1 (positiv = Tele); 0 stoppt.
    pub fn zoom_move(&mut self, now: u64, speed: f64) -> Result<(), String> {
        self.need_link()?;
        if !speed.is_finite() {
            return Err("speed muss eine Zahl sein".to_string());
        }
        if speed.abs() < DEADZONE {
            return self.stop_zoom();
        }
        let want = (speed > 0.0, (speed.abs().min(1.0) * ZOOM_MAX_SPEED as f64).round() as u8);
        if self.zoom != Some(want) {
            self.push(visca::zoom_variable(want.0, want.1), Tag::Drive, false);
            self.zoom = Some(want);
        }
        self.zoom_deadline = Some(now + self.hold_ms);
        Ok(())
    }

    fn stop_zoom(&mut self) -> Result<(), String> {
        if self.zoom.take().is_some() {
            self.push(visca::zoom_stop(), Tag::Drive, false);
        }
        self.zoom_deadline = None;
        Ok(())
    }

    /// Alles anhalten. Geht auch ohne Verbindung (der Befehl wird gepuffert und beim ersten Lebenszeichen gesendet).
    pub fn stop(&mut self) {
        // Zustände immer räumen; Stopp-Befehle immer senden, auch wenn wir keine Fahrt kennen (Sicherheitsstopp).
        self.drive = None;
        self.zoom = None;
        self.drive_deadline = None;
        self.zoom_deadline = None;
        self.push(visca::pan_tilt_stop(), Tag::Drive, false);
        self.push(visca::zoom_stop(), Tag::Drive, false);
    }

    pub fn home(&mut self) -> Result<(), String> {
        self.need_link()?;
        self.stop_drive()?;
        self.push(visca::pan_tilt_home(), Tag::Other, false);
        Ok(())
    }

    /// Absolute Pan/Tilt-Position; die Wertebereiche kennt die Kamera (modellabhängig). `speed` 0…1.
    pub fn goto(&mut self, pan: i16, tilt: i16, speed: f64) -> Result<(), String> {
        self.need_link()?;
        self.stop_drive()?;
        let s = speed.clamp(0.0, 1.0);
        self.push(visca::pan_tilt_absolute(axis_speed(s, self.pan_max), axis_speed(s, self.tilt_max), pan, tilt), Tag::Other, false);
        Ok(())
    }

    pub fn zoom_to(&mut self, pos: u16) -> Result<(), String> {
        self.need_link()?;
        self.stop_zoom()?;
        self.push(visca::zoom_direct(pos), Tag::Other, false);
        Ok(())
    }

    fn preset_index(&self, number: u64) -> Result<usize, String> {
        if number == 0 || number as usize > self.presets.len() {
            return Err(format!("preset {number} gibt es nicht (1…{})", self.presets.len()));
        }
        Ok(number as usize - 1)
    }

    pub fn recall(&mut self, number: u64) -> Result<(), String> {
        self.need_link()?;
        let i = self.preset_index(number)?;
        self.stop_drive()?;
        self.stop_zoom()?;
        self.push(visca::preset(PresetOp::Recall, i as u8), Tag::Preset(PresetOp::Recall, i as u8), false);
        self.events.push(Event::PresetRecalled { number: number as u8, name: self.presets[i].name.clone() });
        Ok(())
    }

    /// Aktuelle Lage als Voreinstellung speichern (in der Kamera) und benennen.
    pub fn store(&mut self, number: u64, name: Option<String>) -> Result<(), String> {
        self.need_link()?;
        let i = self.preset_index(number)?;
        self.push(visca::preset(PresetOp::Set, i as u8), Tag::Preset(PresetOp::Set, i as u8), false);
        self.presets[i].stored = true;
        if let Some(n) = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
            self.presets[i].name = n;
        }
        Ok(())
    }

    pub fn clear_preset(&mut self, number: u64) -> Result<(), String> {
        self.need_link()?;
        let i = self.preset_index(number)?;
        self.push(visca::preset(PresetOp::Reset, i as u8), Tag::Preset(PresetOp::Reset, i as u8), false);
        self.presets[i] = Preset { name: format!("Preset {number}"), stored: false };
        Ok(())
    }

    pub fn rename_preset(&mut self, number: u64, name: &str) -> Result<(), String> {
        let i = self.preset_index(number)?;
        let n = name.trim();
        if n.is_empty() || n.len() > 40 {
            return Err("Name: 1…40 Zeichen".to_string());
        }
        self.presets[i].name = n.to_string();
        Ok(())
    }

    // ───────────── Zeit und Antworten ─────────────

    pub fn tick(&mut self, now: u64) {
        if self.drive_deadline.is_some_and(|d| now >= d) {
            let _ = self.stop_drive();
            self.events.push(Event::HoldExpired { what: "pan-tilt" });
        }
        if self.zoom_deadline.is_some_and(|d| now >= d) {
            let _ = self.stop_zoom();
            self.events.push(Event::HoldExpired { what: "zoom" });
        }
        if self.link_up && self.last_rx_ms.is_none_or(|t| now.saturating_sub(t) > self.link_timeout_ms) {
            self.link_up = false;
            // Die Kamera könnte noch fahren; wir können es nicht mehr ändern, aber die Bedienung soll es nicht mehr glauben.
            self.drive = None;
            self.zoom = None;
            self.drive_deadline = None;
            self.zoom_deadline = None;
            self.events.push(Event::Link { up: false });
        }
        if now >= self.next_poll_ms {
            if self.link_up {
                self.next_poll_ms = now + if self.moving() { self.poll_ms.min(250) } else { self.poll_ms };
                self.push(visca::inq_pan_tilt_position(), Tag::Inquiry(Inquiry::PanTilt), true);
                self.push(visca::inq_zoom_position(), Tag::Inquiry(Inquiry::Zoom), true);
            } else {
                // Ohne Verbindung: Sequenznummer abgleichen (RESET) und nach der Version fragen — das ist das Lebenszeichen.
                self.next_poll_ms = now + 1000;
                self.outbox.push_back(Out { kind: visca::payload_type::CONTROL, payload: vec![visca::CONTROL_RESET], tag: Tag::Other });
                self.push(visca::inq_version(), Tag::Inquiry(Inquiry::Version), true);
            }
        }
    }

    /// Irgendein gültiges Paket der Kamera: Lebenszeichen.
    pub fn alive(&mut self, now: u64) {
        self.last_rx_ms = Some(now);
        if !self.link_up {
            self.link_up = true;
            self.next_poll_ms = now;
            self.events.push(Event::Link { up: true });
        }
    }

    pub fn on_reply(&mut self, now: u64, tag: Tag, reply: visca::Reply) {
        self.alive(now);
        match reply {
            visca::Reply::Ack { .. } => {}
            visca::Reply::Completion { data, .. } => {
                if let Tag::Inquiry(q) = tag {
                    match q {
                        Inquiry::PanTilt => self.pan_tilt_pos = visca::decode_pan_tilt(&data).or(self.pan_tilt_pos),
                        Inquiry::Zoom => self.zoom_pos = visca::decode_zoom(&data).or(self.zoom_pos),
                        Inquiry::Version => self.version = visca::decode_version(&data).map(|(a, b, c, _)| (a, b, c)).or(self.version),
                    }
                }
            }
            visca::Reply::Error { code, .. } => {
                self.rx_errors += 1;
                // Ein abgelehntes Speichern ist nicht gespeichert.
                if let Tag::Preset(PresetOp::Set, i) = tag
                    && let Some(p) = self.presets.get_mut(i as usize)
                {
                    p.stored = false;
                }
                self.events.push(Event::CameraError { code, text: visca::error_text(code), tag: format!("{tag:?}") });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up() -> Ptz {
        let mut p = Ptz::new(8);
        p.alive(0);
        p.events.clear();
        p
    }

    fn drain(p: &mut Ptz) -> Vec<Vec<u8>> {
        p.outbox.drain(..).map(|o| o.payload).collect()
    }

    #[test]
    fn ohne_verbindung_wird_abgelehnt() {
        let mut p = Ptz::new(4);
        assert!(p.move_axes(0, 1.0, 0.0).is_err());
        assert!(p.recall(1).is_err());
        assert!(p.home().is_err());
        assert!(p.outbox.is_empty());
    }

    #[test]
    fn geschwindigkeit_wird_auf_stufen_abgebildet() {
        assert_eq!(axis_speed(0.0, 0x18), 1);
        assert_eq!(axis_speed(1.0, 0x18), 0x18);
        assert_eq!(axis_speed(-1.0, 0x18), 0x18);
        assert!(axis_speed(0.5, 0x18) < 0x0D); // unten feiner als linear
        assert_eq!(axis_speed(5.0, 0x14), 0x14);
    }

    #[test]
    fn fahrt_nur_bei_aenderung_senden_und_haltezeit_erneuern() {
        let mut p = up();
        p.move_axes(0, 1.0, 0.0).unwrap();
        assert_eq!(drain(&mut p), vec![visca::pan_tilt_drive(0x18, 1, PanDir::Right, TiltDir::Stop)]);
        p.move_axes(300, 1.0, 0.0).unwrap(); // gleiche Fahrt: nichts senden, Frist verlängert
        assert!(p.outbox.is_empty());
        p.tick(1200); // 300 + 1000 = 1300, noch nicht (Abfragen laufen weiter, aber kein Stopp)
        assert!(p.outbox.iter().all(|o| o.tag != Tag::Drive));
        p.outbox.clear();
        p.tick(1301);
        assert_eq!(drain(&mut p).first(), Some(&visca::pan_tilt_stop()));
        assert!(p.events.contains(&Event::HoldExpired { what: "pan-tilt" }));
        assert!(!p.moving());
    }

    #[test]
    fn nullstellung_stoppt_und_tote_zone() {
        let mut p = up();
        p.move_axes(0, -0.5, 0.5).unwrap();
        p.outbox.clear();
        p.move_axes(10, 0.01, -0.02).unwrap();
        assert_eq!(drain(&mut p), vec![visca::pan_tilt_stop()]);
        p.move_axes(20, 0.0, 0.0).unwrap(); // schon gestoppt: nichts
        assert!(p.outbox.is_empty());
    }

    #[test]
    fn diagonale_und_richtungswechsel() {
        let mut p = up();
        p.move_axes(0, -1.0, 1.0).unwrap();
        p.move_axes(5, 1.0, -1.0).unwrap();
        let v = drain(&mut p);
        assert_eq!(v[0], visca::pan_tilt_drive(0x18, 0x14, PanDir::Left, TiltDir::Up));
        assert_eq!(v[1], visca::pan_tilt_drive(0x18, 0x14, PanDir::Right, TiltDir::Down));
    }

    #[test]
    fn zoom_stufen_und_haltezeit() {
        let mut p = up();
        p.zoom_move(0, 1.0).unwrap();
        p.zoom_move(10, -0.5).unwrap();
        assert_eq!(drain(&mut p), vec![visca::zoom_variable(true, 7), visca::zoom_variable(false, 4)]);
        p.tick(1100);
        assert_eq!(drain(&mut p).first(), Some(&visca::zoom_stop()));
        assert!(p.events.contains(&Event::HoldExpired { what: "zoom" }));
    }

    #[test]
    fn stopp_sendet_immer_auch_ohne_bekannte_fahrt_und_ohne_verbindung() {
        let mut p = Ptz::new(4);
        p.stop();
        assert_eq!(drain(&mut p), vec![visca::pan_tilt_stop(), visca::zoom_stop()]);
    }

    #[test]
    fn voreinstellungen() {
        let mut p = up();
        p.store(3, Some("  Totale ".to_string())).unwrap();
        assert_eq!(drain(&mut p), vec![visca::preset(PresetOp::Set, 2)]);
        assert_eq!(p.presets[2], Preset { name: "Totale".to_string(), stored: true });
        p.recall(3).unwrap();
        assert_eq!(drain(&mut p), vec![visca::preset(PresetOp::Recall, 2)]);
        assert!(p.events.contains(&Event::PresetRecalled { number: 3, name: "Totale".to_string() }));
        assert!(p.recall(0).is_err());
        assert!(p.recall(9).is_err());
        assert!(p.store(99, None).is_err());
        p.clear_preset(3).unwrap();
        assert_eq!(p.presets[2], Preset { name: "Preset 3".to_string(), stored: false });
        assert!(p.rename_preset(1, "").is_err());
        p.rename_preset(1, "Moderator").unwrap();
        assert_eq!(p.presets[0].name, "Moderator");
    }

    #[test]
    fn abruf_stoppt_laufende_fahrt_zuerst() {
        let mut p = up();
        p.move_axes(0, 1.0, 1.0).unwrap();
        p.outbox.clear();
        p.recall(1).unwrap();
        let v = drain(&mut p);
        assert_eq!(v[0], visca::pan_tilt_stop());
        assert_eq!(v[1], visca::preset(PresetOp::Recall, 0));
    }

    #[test]
    fn abgelehntes_speichern_gilt_nicht() {
        let mut p = up();
        p.store(2, None).unwrap();
        p.outbox.clear();
        p.on_reply(10, Tag::Preset(PresetOp::Set, 1), visca::Reply::Error { socket: 1, code: 0x41 });
        assert!(!p.presets[1].stored);
        assert!(matches!(p.events.last(), Some(Event::CameraError { code: 0x41, .. })));
        assert_eq!(p.rx_errors, 1);
    }

    #[test]
    fn abfragen_nur_mit_verbindung_und_ohne_verbindung_reset_plus_version() {
        let mut p = Ptz::new(2);
        p.tick(0);
        let o: Vec<_> = p.outbox.drain(..).collect();
        assert_eq!(o[0].kind, visca::payload_type::CONTROL);
        assert_eq!(o[0].payload, vec![visca::CONTROL_RESET]);
        assert_eq!(o[1].tag, Tag::Inquiry(Inquiry::Version));
        p.tick(500); // noch nicht fällig
        assert!(p.outbox.is_empty());
        p.on_reply(600, Tag::Inquiry(Inquiry::Version), visca::Reply::Completion { socket: 0, data: vec![0, 1, 5, 0x1E, 0, 1, 2] });
        assert!(p.link_up);
        assert_eq!(p.version, Some((1, 0x051E, 1)));
        assert_eq!(p.events, vec![Event::Link { up: true }]);
        p.tick(600);
        let o: Vec<_> = p.outbox.drain(..).map(|o| o.tag).collect();
        assert_eq!(o, vec![Tag::Inquiry(Inquiry::PanTilt), Tag::Inquiry(Inquiry::Zoom)]);
    }

    #[test]
    fn positionen_aus_abfragen() {
        let mut p = up();
        let mut d = Vec::new();
        d.extend_from_slice(&visca::nibbles16(-12));
        d.extend_from_slice(&visca::nibbles16(34));
        p.on_reply(1, Tag::Inquiry(Inquiry::PanTilt), visca::Reply::Completion { socket: 0, data: d });
        p.on_reply(1, Tag::Inquiry(Inquiry::Zoom), visca::Reply::Completion { socket: 0, data: visca::nibbles16(0x1234).to_vec() });
        assert_eq!(p.pan_tilt_pos, Some((-12, 34)));
        assert_eq!(p.zoom_pos, Some(0x1234));
        p.on_reply(2, Tag::Inquiry(Inquiry::Zoom), visca::Reply::Completion { socket: 0, data: vec![1, 2] }); // kaputt: alter Wert bleibt
        assert_eq!(p.zoom_pos, Some(0x1234));
    }

    #[test]
    fn verbindungsverlust_beendet_fahrten_im_zustand() {
        let mut p = up();
        p.move_axes(0, 1.0, 0.0).unwrap();
        p.tick(2600);
        assert!(!p.link_up);
        assert!(!p.moving());
        assert!(p.events.contains(&Event::Link { up: false }));
        assert!(p.move_axes(2700, 1.0, 0.0).is_err());
    }

    #[test]
    fn ausgabepuffer_ist_begrenzt() {
        let mut p = up();
        for _ in 0..200 {
            p.stop();
        }
        assert_eq!(p.outbox.len(), 64);
    }

    #[test]
    fn goto_und_zoom_to_stoppen_fahrten() {
        let mut p = up();
        p.move_axes(0, 1.0, 0.0).unwrap();
        p.zoom_move(0, 1.0).unwrap();
        p.outbox.clear();
        p.goto(100, -50, 0.5).unwrap();
        p.zoom_to(0x2000).unwrap();
        let v = drain(&mut p);
        assert_eq!(v[0], visca::pan_tilt_stop());
        assert_eq!(v[1][..4], [0x81, 0x01, 0x06, 0x02]);
        assert_eq!(v[2], visca::zoom_stop());
        assert_eq!(v[3], visca::zoom_direct(0x2000));
    }
}
