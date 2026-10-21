//! Mix-Kern des Intercoms (Kapitel 47.2): reine Rechenbibliothek ohne GStreamer.
//!
//! Alle 20 ms ([`FRAME`] Samples bei 48 kHz) bekommt der Kern ein Mono-Mikrofonsignal je Teilnehmer
//! und liefert je Teilnehmer ein Stereo-Hörsignal. Kanäle sind Summenpuffer; der Hörweg eines
//! Teilnehmers ist die Summe aller gehörten Kanäle **abzüglich seines eigenen Beitrags**
//! (Mix-minus) — Aufwand O(Teilnehmer × gehörte Kanäle), nicht quadratisch.
//!
//! Pegel-/Routenänderungen sind reine Zahlenänderungen an [`Party`]/[`Route`]; es gibt nirgends
//! einen Pipeline-Umbau.

use std::collections::{BTreeMap, BTreeSet};

/// Samples je 20-ms-Frame bei 48 kHz (= ein Opus-Paket).
pub const FRAME: usize = 960;
pub const SAMPLE_RATE: f32 = 48_000.0;
const FRAME_SECS: f32 = FRAME as f32 / SAMPLE_RATE;

pub type PartyId = u32;
pub type ChannelId = u32;

/// Ein Teilnehmer ↔ Kanal-Zuordnung.
#[derive(Debug, Clone)]
pub struct Route {
    /// Darf der Teilnehmer auf diesem Kanal überhaupt sprechen (Konfiguration/Rechte)?
    pub talk_allowed: bool,
    /// Sprechtaste gedrückt bzw. eingerastet.
    pub talk_key: bool,
    /// Sprachaktivierung für diesen Kanal (öffnet, solange der Teilnehmer spricht).
    pub talk_vox: bool,
    /// Hört der Teilnehmer diesen Kanal?
    pub listen: bool,
    /// Hören stumm (der Kanal bleibt zugeordnet).
    pub listen_muted: bool,
    /// Hörpegel (linear, 1.0 = unverändert).
    pub level: f32,
    /// Stereo-Lage −1 (links) … +1 (rechts).
    pub pan: f32,
}

impl Default for Route {
    fn default() -> Self {
        Self {
            talk_allowed: false,
            talk_key: false,
            talk_vox: false,
            listen: false,
            listen_muted: false,
            level: 1.0,
            pan: 0.0,
        }
    }
}

/// Sprachaktivierung (Schwelle in dBFS, Haltezeit in ms).
#[derive(Debug, Clone, Copy)]
pub struct Vox {
    pub threshold_db: f32,
    pub hold_ms: u32,
}

#[derive(Debug, Clone)]
pub struct Party {
    /// Mikrofon stumm (vom Teilnehmer selbst).
    pub muted: bool,
    /// Zwangs-Stumm durch Berechtigte oder Mikrofonsperre — hat Vorrang vor `muted`.
    pub forced_mute: bool,
    pub mic_gain: f32,
    pub out_gain: f32,
    /// Priorität; höher dämpft niedrigere im selben Kanal.
    pub priority: u8,
    /// Programmquelle (kein Mensch): wird in Kanälen mit `duck_db` gedämpft, solange gesprochen wird.
    pub is_program: bool,
    pub vox: Option<Vox>,
    /// Solo-Hören: nicht leer ⇒ nur diese Kanäle sind hörbar.
    pub solo: BTreeSet<ChannelId>,
    pub routes: BTreeMap<ChannelId, Route>,
    // Laufzeitzustand
    speaking: bool,
    hold_frames: u32,
    mic_db: f32,
}

impl Default for Party {
    fn default() -> Self {
        Self {
            muted: false,
            forced_mute: false,
            mic_gain: 1.0,
            out_gain: 1.0,
            priority: 0,
            is_program: false,
            vox: None,
            solo: BTreeSet::new(),
            routes: BTreeMap::new(),
            speaking: false,
            hold_frames: 0,
            mic_db: -120.0,
        }
    }
}

impl Party {
    pub fn route_mut(&mut self, ch: ChannelId) -> &mut Route {
        self.routes.entry(ch).or_default()
    }
}

#[derive(Debug, Clone)]
pub struct Channel {
    /// Dämpfung der Programmquellen in dB, solange ein Mensch auf dem Kanal spricht (0 = aus). IFB.
    pub duck_db: f32,
    /// Dämpfung niedriger priorisierter Sprecher in dB, solange höher priorisierte sprechen.
    pub priority_duck_db: f32,
    duck_gain: f32,
}

impl Default for Channel {
    fn default() -> Self {
        Self { duck_db: 0.0, priority_duck_db: 12.0, duck_gain: 1.0 }
    }
}

/// Hörsignal eines Teilnehmers (Stereo, getrennte Ebenen).
#[derive(Debug, Clone)]
pub struct Out {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

/// Zustand nach einem Durchlauf — für Anzeigen.
#[derive(Debug, Clone, Default)]
pub struct Report {
    /// Sprechende Teilnehmer je Kanal (Sprechweg offen UND Signal über Schwelle).
    pub speakers: BTreeMap<ChannelId, Vec<PartyId>>,
    /// Mikrofonpegel je Teilnehmer in dBFS (vor Stummschaltung).
    pub mic_db: BTreeMap<PartyId, f32>,
}

#[derive(Default)]
pub struct Engine {
    pub parties: BTreeMap<PartyId, Party>,
    pub channels: BTreeMap<ChannelId, Channel>,
}

/// Schwelle, ab der ein Mikrofonsignal als „spricht“ gilt (Anzeige, Ducking, Priorität).
const SPEAK_DB: f32 = -48.0;
const SPEAK_HOLD_FRAMES: u32 = 8; // 160 ms

fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

fn rms_db(x: &[f32]) -> f32 {
    if x.is_empty() {
        return -120.0;
    }
    let ms = x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32;
    if ms <= 1e-12 { -120.0 } else { 10.0 * ms.log10() }
}

/// Weicher Begrenzer: linear bis 0.8, darüber weich gegen 1.0.
fn limit(x: f32) -> f32 {
    let a = x.abs();
    if a <= 0.8 {
        x
    } else {
        x.signum() * (0.8 + 0.2 * ((a - 0.8) / 0.2).tanh())
    }
}

/// Konstante Leistung: −1 → (1, 0), 0 → (≈0.707, ≈0.707), +1 → (0, 1).
fn pan_gains(pan: f32) -> (f32, f32) {
    let p = (pan.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
    (p.cos(), p.sin())
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Verarbeitet einen Frame. `inputs`: Mikrofonsignal je Teilnehmer (fehlt ein Teilnehmer oder ist
    /// ein Frame kürzer als [`FRAME`], gilt der Rest als Stille).
    pub fn process(&mut self, inputs: &BTreeMap<PartyId, Vec<f32>>) -> (BTreeMap<PartyId, Out>, Report) {
        let mut report = Report::default();

        // 1. Mikrofon aufbereiten: Pegel, Sprecher-Erkennung, VOX, Stumm.
        let mut mics: BTreeMap<PartyId, [f32; FRAME]> = BTreeMap::new();
        for (id, party) in self.parties.iter_mut() {
            let mut buf = [0f32; FRAME];
            if let Some(src) = inputs.get(id) {
                let n = src.len().min(FRAME);
                buf[..n].copy_from_slice(&src[..n]);
            }
            let raw_db = rms_db(&buf);
            party.mic_db = raw_db;
            report.mic_db.insert(*id, raw_db);

            let threshold = party.vox.map(|v| v.threshold_db).unwrap_or(SPEAK_DB);
            if raw_db > threshold && !party.muted && !party.forced_mute {
                party.speaking = true;
                party.hold_frames = match party.vox {
                    Some(v) => (v.hold_ms as f32 / (FRAME_SECS * 1000.0)).ceil() as u32,
                    None => SPEAK_HOLD_FRAMES,
                };
            } else if party.hold_frames > 0 {
                party.hold_frames -= 1;
            } else {
                party.speaking = false;
            }

            let gate = if party.muted || party.forced_mute { 0.0 } else { party.mic_gain };
            for s in buf.iter_mut() {
                *s *= gate;
            }
            mics.insert(*id, buf);
        }

        // 2. Wer spricht wo? (Sprechweg offen: Taste oder VOX.)
        let mut open: BTreeMap<ChannelId, Vec<PartyId>> = BTreeMap::new();
        for (id, party) in &self.parties {
            if party.muted || party.forced_mute {
                continue;
            }
            for (ch, route) in &party.routes {
                if !route.talk_allowed {
                    continue;
                }
                let via_key = route.talk_key;
                let via_vox = route.talk_vox && party.vox.is_some() && party.speaking;
                if via_key || via_vox {
                    open.entry(*ch).or_default().push(*id);
                }
            }
        }

        // 3. Kanal-Summen mit Ducking/Priorität. `contrib` merkt sich den Faktor je (Kanal, Sprecher),
        //    damit der Mix-minus-Abzug exakt denselben Faktor verwendet.
        let mut sums: BTreeMap<ChannelId, [f32; FRAME]> = BTreeMap::new();
        let mut contrib: BTreeMap<(ChannelId, PartyId), f32> = BTreeMap::new();
        for (ch, talkers) in &open {
            let channel = self.channels.entry(*ch).or_default();
            let humans_speaking: Vec<PartyId> = talkers
                .iter()
                .copied()
                .filter(|p| {
                    let party = &self.parties[p];
                    !party.is_program && party.speaking
                })
                .collect();
            // Ducking der Programmquellen (weich: schnell zu, langsam auf).
            let target = if channel.duck_db > 0.0 && !humans_speaking.is_empty() {
                db_to_lin(-channel.duck_db)
            } else {
                1.0
            };
            let coeff = if target < channel.duck_gain { 0.5 } else { 0.08 };
            channel.duck_gain += (target - channel.duck_gain) * coeff;
            // Höchste Priorität unter den tatsächlich Sprechenden.
            let top = humans_speaking.iter().map(|p| self.parties[p].priority).max();
            let prio_gain = db_to_lin(-channel.priority_duck_db);

            let sum = sums.entry(*ch).or_insert([0.0; FRAME]);
            for p in talkers {
                let party = &self.parties[p];
                let mut g = 1.0;
                if party.is_program {
                    g *= channel.duck_gain;
                } else if let Some(top) = top {
                    if party.priority < top {
                        g *= prio_gain;
                    }
                }
                contrib.insert((*ch, *p), g);
                let mic = &mics[p];
                for i in 0..FRAME {
                    sum[i] += mic[i] * g;
                }
            }
        }

        // Sprecheranzeige: offen UND spricht (Programmquellen zählen nicht als Sprecher).
        for (ch, talkers) in &open {
            let list: Vec<PartyId> = talkers
                .iter()
                .copied()
                .filter(|p| {
                    let party = &self.parties[p];
                    !party.is_program && party.speaking
                })
                .collect();
            if !list.is_empty() {
                report.speakers.insert(*ch, list);
            }
        }

        // 4. Hörwege.
        let mut outs = BTreeMap::new();
        for (id, party) in &self.parties {
            let mut left = vec![0f32; FRAME];
            let mut right = vec![0f32; FRAME];
            for (ch, route) in &party.routes {
                if !route.listen || route.listen_muted {
                    continue;
                }
                if !party.solo.is_empty() && !party.solo.contains(ch) {
                    continue;
                }
                let Some(sum) = sums.get(ch) else { continue };
                let own = contrib.get(&(*ch, *id)).copied();
                let (gl, gr) = pan_gains(route.pan);
                let (gl, gr) = (gl * route.level * party.out_gain, gr * route.level * party.out_gain);
                let mic = &mics[id];
                for i in 0..FRAME {
                    let mut v = sum[i];
                    if let Some(g) = own {
                        v -= mic[i] * g;
                    }
                    left[i] += v * gl;
                    right[i] += v * gr;
                }
            }
            for i in 0..FRAME {
                left[i] = limit(left[i]);
                right[i] = limit(right[i]);
            }
            outs.insert(*id, Out { left, right });
        }
        (outs, report)
    }

    /// Mikrofonpegel (dBFS) des letzten Frames.
    pub fn mic_db(&self, id: PartyId) -> f32 {
        self.parties.get(&id).map(|p| p.mic_db).unwrap_or(-120.0)
    }

    pub fn is_speaking(&self, id: PartyId) -> bool {
        self.parties.get(&id).map(|p| p.speaking).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(amp: f32, freq: f32, phase0: usize) -> Vec<f32> {
        (0..FRAME)
            .map(|i| amp * (2.0 * std::f32::consts::PI * freq * (phase0 + i) as f32 / SAMPLE_RATE).sin())
            .collect()
    }

    fn energy(x: &[f32]) -> f32 {
        x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32
    }

    fn party(listen: &[ChannelId], talk: &[ChannelId]) -> Party {
        let mut p = Party::default();
        for c in listen {
            let r = p.route_mut(*c);
            r.listen = true;
        }
        for c in talk {
            let r = p.route_mut(*c);
            r.talk_allowed = true;
            r.talk_key = true;
        }
        p
    }

    fn inputs(list: &[(PartyId, Vec<f32>)]) -> BTreeMap<PartyId, Vec<f32>> {
        list.iter().cloned().collect()
    }

    #[test]
    fn listener_hears_talker_but_talker_does_not_hear_self() {
        let mut e = Engine::new();
        e.parties.insert(1, party(&[1], &[1]));
        e.parties.insert(2, party(&[1], &[]));
        let (outs, rep) = e.process(&inputs(&[(1, tone(0.3, 440.0, 0)), (2, vec![0.0; FRAME])]));
        assert!(energy(&outs[&2].left) > 0.01, "Hörer hört den Sprecher");
        assert!(energy(&outs[&1].left) < 1e-9, "Sprecher hört sich nicht selbst");
        assert_eq!(rep.speakers[&1], vec![1]);
    }

    #[test]
    fn mix_minus_property_holds_for_random_matrices() {
        // Einfacher deterministischer Zufall (LCG), keine Zusatzabhängigkeit.
        let mut s = 12345u64;
        let mut rnd = || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (s >> 33) as u32
        };
        for _ in 0..50 {
            let mut e = Engine::new();
            let n = 2 + rnd() % 8;
            let c = 1 + rnd() % 5;
            for p in 0..n {
                let mut party = Party::default();
                for ch in 0..c {
                    let r = party.route_mut(ch);
                    r.listen = rnd() % 2 == 0;
                    r.talk_allowed = rnd() % 2 == 0;
                    r.talk_key = rnd() % 2 == 0;
                    r.level = 0.5 + (rnd() % 100) as f32 / 100.0;
                }
                e.parties.insert(p, party);
            }
            // Jeder Teilnehmer sendet ein eigenes, nur ihm zugehöriges Signal (Frequenz = Id).
            let ins: BTreeMap<_, _> = (0..n).map(|p| (p, tone(0.1, 300.0 + 97.0 * p as f32, 0))).collect();
            let (outs, _) = e.process(&ins);
            // Referenz: Ausgang ohne die eigene Spur == Ausgang, wenn der Teilnehmer schweigt.
            for p in 0..n {
                let mut quiet = ins.clone();
                quiet.insert(p, vec![0.0; FRAME]);
                let mut e2 = Engine::new();
                e2.parties = e.parties.clone();
                let (outs2, _) = e2.process(&quiet);
                for i in 0..FRAME {
                    assert!((outs[&p].left[i] - outs2[&p].left[i]).abs() < 1e-3, "Selbstecho bei Teilnehmer {p}");
                }
            }
        }
    }

    #[test]
    fn muted_and_forced_mute_silence_the_talker() {
        let mut e = Engine::new();
        e.parties.insert(1, party(&[], &[1]));
        e.parties.insert(2, party(&[1], &[]));
        let ins = inputs(&[(1, tone(0.3, 440.0, 0))]);
        e.parties.get_mut(&1).unwrap().muted = true;
        assert!(energy(&e.process(&ins).0[&2].left) < 1e-9);
        let p = e.parties.get_mut(&1).unwrap();
        p.muted = false;
        p.forced_mute = true;
        assert!(energy(&e.process(&ins).0[&2].left) < 1e-9);
        e.parties.get_mut(&1).unwrap().forced_mute = false;
        assert!(energy(&e.process(&ins).0[&2].left) > 0.01);
    }

    #[test]
    fn listen_mute_solo_and_closed_talk_key() {
        let mut e = Engine::new();
        e.parties.insert(1, party(&[], &[1, 2]));
        e.parties.insert(2, party(&[1, 2], &[]));
        let ins = inputs(&[(1, tone(0.2, 440.0, 0))]);
        let base = energy(&e.process(&ins).0[&2].left);
        // Beide Kanäle tragen das Signal -> doppelte Amplitude.
        assert!(base > 0.02);
        e.parties.get_mut(&2).unwrap().route_mut(1).listen_muted = true;
        let one = energy(&e.process(&ins).0[&2].left);
        assert!((one / base - 0.25).abs() < 0.02, "ein Kanal gleich ein Viertel der Energie, war {}", one / base);
        e.parties.get_mut(&2).unwrap().route_mut(1).listen_muted = false;
        e.parties.get_mut(&2).unwrap().solo.insert(2);
        let solo = energy(&e.process(&ins).0[&2].left);
        assert!((solo / base - 0.25).abs() < 0.02);
        e.parties.get_mut(&2).unwrap().solo.clear();
        e.parties.get_mut(&1).unwrap().route_mut(1).talk_key = false;
        e.parties.get_mut(&1).unwrap().route_mut(2).talk_key = false;
        assert!(energy(&e.process(&ins).0[&2].left) < 1e-9, "ohne Taste kein Ton");
    }

    #[test]
    fn talk_not_allowed_blocks_even_with_key() {
        let mut e = Engine::new();
        let mut p = party(&[], &[1]);
        p.route_mut(1).talk_allowed = false;
        e.parties.insert(1, p);
        e.parties.insert(2, party(&[1], &[]));
        assert!(energy(&e.process(&inputs(&[(1, tone(0.3, 440.0, 0))])).0[&2].left) < 1e-9);
    }

    #[test]
    fn pan_places_signal_left_and_right() {
        let mut e = Engine::new();
        e.parties.insert(1, party(&[], &[1]));
        let mut l = party(&[1], &[]);
        l.route_mut(1).pan = -1.0;
        let mut r = party(&[1], &[]);
        r.route_mut(1).pan = 1.0;
        e.parties.insert(2, l);
        e.parties.insert(3, r);
        let (outs, _) = e.process(&inputs(&[(1, tone(0.3, 440.0, 0))]));
        assert!(energy(&outs[&2].left) > 0.01 && energy(&outs[&2].right) < 1e-9);
        assert!(energy(&outs[&3].right) > 0.01 && energy(&outs[&3].left) < 1e-9);
    }

    #[test]
    fn ifb_ducks_program_while_human_speaks() {
        let mut e = Engine::new();
        let mut prog = party(&[], &[1]);
        prog.is_program = true;
        e.parties.insert(1, prog);
        e.parties.insert(2, party(&[], &[1])); // Regie spricht in den IFB
        e.parties.insert(3, party(&[1], &[])); // Moderator hört
        e.channels.insert(1, Channel { duck_db: 20.0, ..Default::default() });
        e.parties.get_mut(&2).unwrap().route_mut(1).talk_key = false;
        let prog_in = tone(0.2, 1000.0, 0);
        let base = energy(&e.process(&inputs(&[(1, prog_in.clone())])).0[&3].left);
        e.parties.get_mut(&2).unwrap().route_mut(1).talk_key = true;
        let mut last = base;
        for k in 0..30 {
            let o = e.process(&inputs(&[(1, prog_in.clone()), (2, tone(0.0001, 200.0, k * FRAME))]));
            last = energy(&o.0[&3].left);
        }
        // Regie spricht zu leise, um "spricht" auszulösen -> kein Ducking.
        assert!((last / base - 1.0).abs() < 0.05);
        for k in 0..30 {
            let o = e.process(&inputs(&[(1, prog_in.clone()), (2, tone(0.2, 200.0, k * FRAME))]));
            last = energy(&o.0[&3].left);
        }
        // Programm um 20 dB gedämpft + Sprachanteil: Programmanteil allein wäre base/100.
        let sprecher = energy(&tone(0.2, 200.0, 0));
        assert!(last < base * 0.5 + sprecher * 1.2, "Programm wurde gedämpft");
    }

    #[test]
    fn priority_ducks_lower_priority_talkers() {
        let mut e = Engine::new();
        let mut hi = party(&[], &[1]);
        hi.priority = 5;
        let mut lo = party(&[], &[1]);
        lo.priority = 0;
        e.parties.insert(1, hi);
        e.parties.insert(2, lo);
        e.parties.insert(3, party(&[1], &[]));
        // Nur der Niedrige: volle Lautstärke.
        let ref_e = {
            let o = e.process(&inputs(&[(2, tone(0.2, 600.0, 0))]));
            energy(&o.0[&3].left)
        };
        // Beide sprechen: Niedriger um 12 dB gedämpft, Hoher unverändert.
        let both = e.process(&inputs(&[(1, tone(0.2, 300.0, 0)), (2, tone(0.2, 600.0, 0))]));
        let hi_only = {
            let mut e2 = Engine::new();
            e2.parties = e.parties.clone();
            energy(&e2.process(&inputs(&[(1, tone(0.2, 300.0, 0))])).0[&3].left)
        };
        let total = energy(&both.0[&3].left);
        let expected = hi_only + ref_e * 10f32.powf(-1.2);
        assert!((total / expected - 1.0).abs() < 0.1, "total {total} erwartet {expected}");
    }

    #[test]
    fn vox_opens_only_while_speaking_with_hold() {
        let mut e = Engine::new();
        let mut a = Party::default();
        a.vox = Some(Vox { threshold_db: -40.0, hold_ms: 100 });
        let r = a.route_mut(1);
        r.talk_allowed = true;
        r.talk_vox = true;
        e.parties.insert(1, a);
        e.parties.insert(2, party(&[1], &[]));
        let loud = e.process(&inputs(&[(1, tone(0.2, 440.0, 0))]));
        assert!(energy(&loud.0[&2].left) > 0.01);
        let mut heard_after = 0;
        for _ in 0..20 {
            let o = e.process(&inputs(&[(1, vec![0.0; FRAME])]));
            if energy(&o.0[&2].left) > 1e-12 || e.is_speaking(1) {
                heard_after += 1;
            }
        }
        assert!((1..=7).contains(&heard_after), "Haltezeit ~100 ms (5 Frames), war {heard_after}");
        assert!(!e.is_speaking(1));
    }

    #[test]
    fn limiter_keeps_sum_of_many_talkers_below_one() {
        let mut e = Engine::new();
        let mut ins = BTreeMap::new();
        for p in 0..10u32 {
            e.parties.insert(p, party(&[], &[1]));
            ins.insert(p, tone(0.5, 440.0, 0));
        }
        e.parties.insert(100, party(&[1], &[]));
        let (o, _) = e.process(&ins);
        assert!(o[&100].left.iter().all(|v| v.abs() <= 1.0));
    }

    #[test]
    fn hundred_parties_twenty_channels_fit_the_frame_budget() {
        let mut e = Engine::new();
        let mut ins = BTreeMap::new();
        for p in 0..100u32 {
            let mut party = Party::default();
            for c in 0..20u32 {
                let r = party.route_mut(c);
                r.listen = (p + c) % 4 == 0;
                r.talk_allowed = true;
                r.talk_key = (p * 7 + c) % 9 == 0;
            }
            e.parties.insert(p, party);
            ins.insert(p, tone(0.1, 200.0 + p as f32, 0));
        }
        let start = std::time::Instant::now();
        for _ in 0..50 {
            let _ = e.process(&ins);
        }
        let per_frame_ms = start.elapsed().as_secs_f64() * 1000.0 / 50.0;
        // 10 % eines Kerns = 2 ms je 20-ms-Frame. Im Debug-Profil großzügig, im Release deutlich darunter.
        assert!(per_frame_ms < 20.0, "{per_frame_ms} ms je Frame");
        eprintln!("100x20: {per_frame_ms:.3} ms je Frame");
    }
}
