//! Zustandsmaschine von `omp-gpio` (Kapitel 89/RC1, `docs/CONTRACT-GPIO.md`): Eingänge mit Entprellung, Ausgänge mit Haltezeit
//! (Lease) und Fail-Safe-Pegel. Reine Logik mit eingespeister Zeit (ms, monoton) — ohne Gerät und ohne Netz testbar.

#[derive(Debug, Clone, PartialEq)]
pub struct Input {
    pub name: String,
    /// Entprellter, gemeldeter Pegel.
    pub level: bool,
    /// Letzter Rohwert vom Gerät und seit wann er unverändert anliegt.
    raw: bool,
    raw_since_ms: u64,
    /// Seit der letzten gemeldeten Änderung (monotone ms), 0 = seit Start.
    pub changed_ms: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Output {
    pub name: String,
    pub level: bool,
    /// Pegel, auf den der Ausgang bei Verbindungsverlust oder abgelaufener Haltezeit fällt.
    pub fail_safe: bool,
    /// Ablauf der Haltezeit (monotone ms); `None` = gehalten, bis ein neuer Befehl kommt.
    lease_until_ms: Option<u64>,
}

/// Was `tick`/`set_link` nach außen melden.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// Entprellte Änderung eines Eingangs.
    Input { pin: usize, name: String, level: bool },
    /// Ausgang hat sich ohne Befehl geändert (`reason`: `lease` = Haltezeit abgelaufen, `link` = Verbindungsverlust).
    OutputFellBack { pin: usize, name: String, level: bool, reason: &'static str },
    /// Verbindung zum Gerät (`true` = da).
    Link { up: bool },
}

pub struct Gpio {
    pub inputs: Vec<Input>,
    pub outputs: Vec<Output>,
    pub debounce_ms: u64,
    pub link_up: bool,
}

impl Gpio {
    pub fn new(inputs: usize, outputs: usize, debounce_ms: u64) -> Self {
        Gpio {
            inputs: (0..inputs).map(|i| Input { name: format!("in{}", i + 1), level: false, raw: false, raw_since_ms: 0, changed_ms: 0 }).collect(),
            outputs: (0..outputs).map(|i| Output { name: format!("out{}", i + 1), level: false, fail_safe: false, lease_until_ms: None }).collect(),
            debounce_ms,
            link_up: true,
        }
    }

    /// Rohwert eines Eingangs vom Gerät. Eine Änderung startet die Entprellzeit; zurückprellen innerhalb der Zeit verwirft sie.
    pub fn raw_input(&mut self, now_ms: u64, pin: usize, level: bool) -> Result<(), String> {
        let i = self.inputs.get_mut(pin).ok_or_else(|| format!("Eingang {pin} gibt es nicht"))?;
        if !self.link_up {
            return Err("Verbindung zum Gerät fehlt".to_string());
        }
        if i.raw != level {
            i.raw = level;
            i.raw_since_ms = now_ms;
        }
        Ok(())
    }

    /// Setzt einen Ausgang. `hold_ms > 0` und Pegel ≠ Fail-Safe: nach Ablauf (ohne Erneuerung) fällt der Ausgang zurück.
    pub fn set_output(&mut self, now_ms: u64, pin: usize, level: bool, hold_ms: u64) -> Result<(), String> {
        if !self.link_up {
            return Err("Verbindung zum Gerät fehlt".to_string());
        }
        let o = self.outputs.get_mut(pin).ok_or_else(|| format!("Ausgang {pin} gibt es nicht"))?;
        o.level = level;
        o.lease_until_ms = if hold_ms > 0 && level != o.fail_safe { Some(now_ms + hold_ms) } else { None };
        Ok(())
    }

    /// Verbindung zum Gerät kommt/geht. Weg: alle Ausgänge sofort auf Fail-Safe. Wieder da: Eingänge werden neu gelesen (Rohwert gilt sofort).
    pub fn set_link(&mut self, now_ms: u64, up: bool) -> Vec<Event> {
        if up == self.link_up {
            return Vec::new();
        }
        self.link_up = up;
        let mut ev = vec![Event::Link { up }];
        if !up {
            for (pin, o) in self.outputs.iter_mut().enumerate() {
                o.lease_until_ms = None;
                if o.level != o.fail_safe {
                    o.level = o.fail_safe;
                    ev.push(Event::OutputFellBack { pin, name: o.name.clone(), level: o.level, reason: "link" });
                }
            }
        } else {
            for (pin, i) in self.inputs.iter_mut().enumerate() {
                i.raw_since_ms = now_ms;
                if i.level != i.raw {
                    i.level = i.raw;
                    i.changed_ms = now_ms;
                    ev.push(Event::Input { pin, name: i.name.clone(), level: i.level });
                }
            }
        }
        ev
    }

    /// Zeit weiterschalten: entprellte Eingangsänderungen und abgelaufene Haltezeiten.
    pub fn tick(&mut self, now_ms: u64) -> Vec<Event> {
        let mut ev = Vec::new();
        if !self.link_up {
            return ev;
        }
        let deb = self.debounce_ms;
        for (pin, i) in self.inputs.iter_mut().enumerate() {
            if i.level != i.raw && now_ms.saturating_sub(i.raw_since_ms) >= deb {
                i.level = i.raw;
                i.changed_ms = now_ms;
                ev.push(Event::Input { pin, name: i.name.clone(), level: i.level });
            }
        }
        for (pin, o) in self.outputs.iter_mut().enumerate() {
            if o.lease_until_ms.is_some_and(|t| now_ms >= t) {
                o.lease_until_ms = None;
                if o.level != o.fail_safe {
                    o.level = o.fail_safe;
                    ev.push(Event::OutputFellBack { pin, name: o.name.clone(), level: o.level, reason: "lease" });
                }
            }
        }
        ev
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debounce_accepts_stable_change_only() {
        let mut g = Gpio::new(2, 1, 20);
        g.raw_input(100, 0, true).unwrap();
        assert!(g.tick(110).is_empty(), "noch in der Entprellzeit");
        // Prellen: zurück auf false innerhalb der Zeit → keine Meldung
        g.raw_input(115, 0, false).unwrap();
        assert!(g.tick(200).is_empty());
        g.raw_input(300, 0, true).unwrap();
        let ev = g.tick(320);
        assert_eq!(ev, vec![Event::Input { pin: 0, name: "in1".into(), level: true }]);
        assert!(g.tick(400).is_empty(), "nur einmal melden");
    }

    #[test]
    fn lease_expires_to_fail_safe_unless_renewed() {
        let mut g = Gpio::new(0, 2, 20);
        g.set_output(0, 0, true, 1000).unwrap();
        assert!(g.tick(900).is_empty());
        g.set_output(900, 0, true, 1000).unwrap(); // erneuert
        assert!(g.tick(1500).is_empty());
        let ev = g.tick(1900);
        assert_eq!(ev, vec![Event::OutputFellBack { pin: 0, name: "out1".into(), level: false, reason: "lease" }]);
        assert!(!g.outputs[0].level);
        // ohne Haltezeit bleibt der Pegel
        g.set_output(2000, 1, true, 0).unwrap();
        assert!(g.tick(100_000).is_empty());
        assert!(g.outputs[1].level);
    }

    #[test]
    fn fail_safe_level_may_be_high() {
        let mut g = Gpio::new(0, 1, 20);
        g.outputs[0].fail_safe = true; // z. B. Lautsprecher bleibt an
        g.set_output(0, 0, false, 500).unwrap(); // abweichender Pegel mit Haltezeit
        let ev = g.tick(600);
        assert_eq!(ev.len(), 1);
        assert!(g.outputs[0].level);
    }

    #[test]
    fn link_loss_forces_fail_safe_and_blocks_commands() {
        let mut g = Gpio::new(1, 2, 20);
        g.set_output(0, 0, true, 0).unwrap();
        let ev = g.set_link(10, false);
        assert!(ev.contains(&Event::Link { up: false }));
        assert!(ev.contains(&Event::OutputFellBack { pin: 0, name: "out1".into(), level: false, reason: "link" }));
        assert!(g.set_output(20, 0, true, 0).is_err());
        assert!(g.raw_input(20, 0, true).is_err());
        assert!(g.set_link(30, false).is_empty(), "keine Doppelmeldung");
        let ev = g.set_link(40, true);
        assert_eq!(ev, vec![Event::Link { up: true }]);
    }

    #[test]
    fn unknown_pins_are_rejected() {
        let mut g = Gpio::new(1, 1, 20);
        assert!(g.raw_input(0, 5, true).is_err());
        assert!(g.set_output(0, 5, true, 0).is_err());
    }
}
