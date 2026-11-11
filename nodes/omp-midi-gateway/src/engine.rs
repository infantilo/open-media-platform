//! Verdrahtet die Pult-Einheiten mit der Logik (Kapitel 93) — wie `ui/shell/midi/surface-controller.ts`: pro Takt Ereignisse einsammeln,
//! gedrosselte Befehle freigeben, Pulte nachführen. Takt und Uhr kommen von außen (deshalb ohne Gerät und Zeit testbar).

use crate::surface::*;

pub struct Engine {
    pub logic: SurfaceLogic,
    pub units: Vec<McuUnit>,
}

impl Engine {
    pub fn new(ports: Vec<Box<dyn MidiPort>>, master_target: bool, keys: Option<crate::keys::KeysConfig>) -> Self {
        let specs: Vec<UnitSpec> = (0..ports.len()).map(|i| UnitSpec { strips: 8, has_master: i == 0 }).collect();
        let mut o = LogicOptions::new(specs);
        o.master_target = master_target;
        o.keys = keys;
        Engine { logic: SurfaceLogic::new(o), units: ports.into_iter().map(McuUnit::new).collect() }
    }

    pub fn start(&mut self, now: u64) {
        for u in &mut self.units {
            u.start();
        }
        self.render(now);
    }

    pub fn render(&mut self, now: u64) {
        for i in 0..self.units.len() {
            let st = self.logic.view(i, now);
            self.units[i].apply(&st);
            let moved: Vec<u8> = self.units[i].moved.clone();
            for s in moved {
                self.logic.note_host_move(i, s, now);
            }
        }
    }

    /// Ein Takt: Eingänge lesen, Logik, Anzeige. Rückgabe: Befehle an den Mischer.
    pub fn tick(&mut self, now: u64) -> Vec<MixerCmd> {
        for i in 0..self.units.len() {
            for ev in self.units[i].poll() {
                self.logic.on_event(i, &ev, now);
            }
        }
        self.logic.flush(now, false);
        self.render(now);
        self.logic.drain_cmds()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fader::{db_to_fader, fader_to_db};
    use crate::mcu::*;
    use std::sync::{Arc, Mutex};

    fn ch(n: usize) -> StripInfo {
        StripInfo { id: format!("c{n}"), label: format!("Mic {n}"), gain_db: Some(0.0), mute: false, pfl: false, on_air: false, level: 0.0, pan: Some(0.0), raw: serde_json::json!({"id": format!("c{n}")}) }
    }

    struct Rig {
        e: Engine,
        sims: Vec<Arc<Mutex<SimState>>>,
        now: u64,
        cmds: Vec<MixerCmd>,
    }

    impl Rig {
        fn new(n: usize, units: usize, master: bool) -> Rig {
            let sims: Vec<SimPort> = (0..units).map(|i| SimPort::new(&format!("sim{i}"))).collect();
            let states = sims.iter().map(|s| s.state.clone()).collect();
            let mut e = Engine::new(sims.into_iter().map(|s| Box::new(s) as Box<dyn MidiPort>).collect(), master, None);
            e.logic.set_model((1..=n).map(ch).collect(), master.then_some(0.0));
            let mut r = Rig { e, sims: states, now: 1000, cmds: vec![] };
            r.e.start(r.now);
            r.step(0);
            r
        }
        fn step(&mut self, ms: u64) {
            self.now += ms;
            let c = self.e.tick(self.now);
            self.cmds.extend(c);
        }
        fn sim(&self, i: usize) -> std::sync::MutexGuard<'_, SimState> {
            self.sims[i].lock().unwrap()
        }
    }

    #[test]
    fn start_writes_everything() {
        let r = Rig::new(10, 1, false);
        let s = r.sim(0);
        assert!(s.faders[..8].iter().all(|f| *f == db_to_fader(0.0)));
        assert_eq!(s.leds.get(&NOTE_MUTE), Some(&Led::Off));
        assert_eq!(&s.text(0)[..14], "Mic 1  Mic 2  ");
        assert_eq!(&s.text(1)[..7], "0.0    ");
        assert_eq!((s.seven_seg[11], s.seven_seg[10]), (b'0', b'1'));
    }

    #[test]
    fn login_handshake() {
        let r = Rig::new(1, 1, false);
        assert!(r.e.units[0].online);
        let s = r.sim(0);
        let reply = s.received.iter().find(|m| m.len() > 6 && m[5] == 0x02).unwrap();
        assert_eq!(&reply[6..], &[0x53, 0x49, 0x4d, 0x30, 0x30, 0x30, 0x31, 5, 5, 123, 47, 0xf7]);
    }

    #[test]
    fn fader_drag_throttled_last_value_wins() {
        let mut r = Rig::new(3, 1, false);
        let g = |db: f64| MixerCmd::Gain { id: "c1".into(), db: fader_to_db(db_to_fader(db)) };
        {
            let mut s = r.sim(0);
            s.drag(0, db_to_fader(-10.0));
            s.drag(0, db_to_fader(-12.0));
            s.drag(0, db_to_fader(-14.0));
        }
        r.step(0);
        assert_eq!(r.cmds, vec![g(-10.0)], "der erste Wert geht sofort raus, die nächsten sind gedrosselt");
        r.cmds.clear();
        r.step(60);
        assert_eq!(r.cmds, vec![g(-14.0)], "danach kommt der letzte Wert");
        r.cmds.clear();
        r.sim(0).drag(0, db_to_fader(-20.0));
        r.step(5);
        assert!(r.cmds.is_empty(), "innerhalb von 50 ms gedrosselt");
        r.step(60);
        assert_eq!(r.cmds, vec![g(-20.0)]);
        r.cmds.clear();
        {
            let mut s = r.sim(0);
            s.drag(0, db_to_fader(-30.0));
            s.release(0);
        }
        r.step(0);
        assert_eq!(r.cmds.last(), Some(&g(-30.0)), "Loslassen sendet sofort");
    }

    #[test]
    fn motor_follows_mixer_but_not_the_finger() {
        let mut r = Rig::new(2, 1, false);
        let mut m: Vec<StripInfo> = (1..=2).map(ch).collect();
        m[0].gain_db = Some(-20.0);
        r.e.logic.set_model(m.clone(), None);
        r.step(10);
        assert_eq!(r.sim(0).faders[0], db_to_fader(-20.0));
        r.sim(0).touch(0, true);
        r.step(0);
        m[0].gain_db = Some(-5.0);
        r.e.logic.set_model(m, None);
        r.step(10);
        assert_eq!(r.sim(0).faders[0], db_to_fader(-20.0));
        r.sim(0).release(0);
        r.step(10);
        assert_eq!(r.sim(0).faders[0], db_to_fader(-5.0));
    }

    #[test]
    fn buttons_mute_solo_select_recled() {
        let mut r = Rig::new(4, 1, false);
        r.sim(0).press("mute2").unwrap();
        r.sim(0).press("solo3").unwrap();
        r.sim(0).press("select4").unwrap();
        r.step(0);
        assert_eq!(r.cmds, vec![MixerCmd::Mute { id: "c2".into(), muted: true }, MixerCmd::Pfl { id: "c3".into(), enabled: true }]);
        assert_eq!(r.sim(0).leds.get(&(NOTE_MUTE + 1)), Some(&Led::On));
        assert_eq!(r.sim(0).leds.get(&(NOTE_SELECT + 3)), Some(&Led::On));
        let mut m: Vec<StripInfo> = (1..=4).map(ch).collect();
        m[0].on_air = true;
        r.e.logic.set_model(m, None);
        r.step(10);
        assert_eq!(r.sim(0).leds.get(&NOTE_REC), Some(&Led::On));
    }

    #[test]
    fn bank_and_extender() {
        let mut r = Rig::new(10, 1, false);
        r.sim(0).press("bankRight").unwrap();
        r.step(0);
        assert_eq!(r.e.logic.bank, 2);
        assert_eq!(&r.sim(0).text(0)[49..56], "Mic 10 ");
        r.sim(0).press("bankLeft").unwrap();
        r.step(0);
        assert_eq!(r.e.logic.bank, 0);

        let mut r = Rig::new(20, 2, false);
        assert_eq!(&r.sim(1).text(0)[..7], "Mic 9  ");
        r.sim(1).press("mute1").unwrap();
        r.step(0);
        assert_eq!(r.cmds.last(), Some(&MixerCmd::Mute { id: "c9".into(), muted: true }));
        r.sim(0).press("bankRight").unwrap();
        r.step(0);
        assert_eq!(r.e.logic.bank, 4);
        assert_eq!(&r.sim(1).text(0)[..7], "Mic 13 ");
    }

    #[test]
    fn master_only_with_target() {
        let mut r = Rig::new(2, 1, true);
        r.sim(0).drag(8, db_to_fader(-6.0));
        r.step(0);
        assert_eq!(r.cmds, vec![MixerCmd::Master { db: fader_to_db(db_to_fader(-6.0)) }]);
        let mut r = Rig::new(2, 1, false);
        r.sim(0).drag(8, db_to_fader(-6.0));
        r.step(0);
        assert!(r.cmds.is_empty());
    }

    #[test]
    fn vpot_pan_and_name_value() {
        let mut r = Rig::new(2, 1, false);
        r.sim(0).turn(0, 2);
        r.step(0);
        assert_eq!(r.cmds.last(), Some(&MixerCmd::Pan { id: "c1".into(), pan: 0.1 }));
        r.sim(0).turn(0, -5);
        r.step(0);
        assert_eq!(r.cmds.last(), Some(&MixerCmd::Pan { id: "c1".into(), pan: -0.15 }));
        r.sim(0).press("nameValue").unwrap();
        r.step(0);
        assert_eq!(&r.sim(0).text(1)[..7], "L15    ");
        r.sim(0).press("vpotPush1").unwrap();
        r.step(0);
        assert_eq!(r.cmds.last(), Some(&MixerCmd::Pan { id: "c1".into(), pan: 0.0 }));
    }

    #[test]
    fn meters_and_only_changes() {
        let mut r = Rig::new(2, 1, false);
        let lv = [("c1".to_string(), 1.0), ("c2".to_string(), 0.5)].into_iter().collect();
        r.e.logic.set_levels(&lv);
        r.step(10);
        assert_eq!(&r.sim(0).meters[..2], &[12, 6]);
        let n = r.sim(0).received.len();
        r.step(10);
        r.step(10);
        assert_eq!(r.sim(0).received.len(), n, "kein Dauerfeuer");
    }

    #[test]
    fn unconsumed_buttons_become_events() {
        let mut r = Rig::new(2, 1, false);
        r.sim(0).press("play").unwrap();
        r.sim(0).press("userSwitch1").unwrap();
        r.sim(0).press("f1").unwrap(); // belegt (Standardseite) → kein Ereignis
        r.sim(0).press("mute1").unwrap();
        r.step(0);
        let b = r.e.logic.drain_buttons();
        assert_eq!(b, vec![("play".to_string(), true), ("play".to_string(), false), ("userSwitch1".to_string(), true), ("userSwitch1".to_string(), false)]);
    }

    #[test]
    fn reconnect_rewrites_everything() {
        let mut r = Rig::new(2, 1, false);
        r.sim(0).up = false;
        r.step(10);
        assert!(!r.e.units[0].online);
        r.sim(0).reset();
        r.sim(0).up = true;
        r.step(10);
        assert_eq!(r.sim(0).faders[0], db_to_fader(0.0));
        assert_eq!(&r.sim(0).text(0)[..7], "Mic 1  ");
        assert!(r.e.units[0].online, "Pult hat sich neu angemeldet");
    }
}
