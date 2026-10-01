//! Rechenkerne für AutoMix und Ducking (Kapitel 26) — bewusst zwei
//! getrennte Engines (`UMSETZUNG`-Vorgabe: kein generisches "Auto Volume").
//!
//! * **AutoMix** ([`AutoMixEngine`]): mehrere gleichartige Quellen einer
//!   Gruppe beeinflussen sich gegenseitig (Gain-Sharing nach Dugan-Prinzip:
//!   Gain_i = L_i / ΣL_j, die Summe der Amplitudenanteile bleibt konstant).
//! * **Ducking** ([`DuckEngine`]): *eine* Quelle (Key) senkt *andere*
//!   (Targets) um einen festen Betrag ab, mit Schwelle/Hysterese/Hold und
//!   langer Release-Zeit — kein Kompressor auf dem Target.
//!
//! Beide Kerne rechnen in dt-Schritten (Engine-Takt ≈ 10 ms) ohne
//! Audiozugriff und liefern Gain-Anteile in dB; die Fader-Stufe
//! (`dsp::FaderStage`) glättet sie zusätzlich pro Buffer. Fail-Safe-Regeln
//! (ausgefallener Detektor → 0 dB) stehen im Aufrufer (`engine.rs`) und sind
//! hier über `participate`/`key_level_db = SILENCE_DB` abgebildet.

use std::collections::HashMap;

/// Pegel für "kein Signal / Detektor ausgefallen".
pub const SILENCE_DB: f64 = -120.0;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum DetectorKind {
    Peak,
    Rms,
    /// ~400 ms Kurzzeit-Energie (laufstärkenähnlich).
    ShortTerm,
    /// RMS im Sprachband (300–3400 Hz) — unempfindlich gegen Rumpeln/Zischen.
    Speech,
}

impl DetectorKind {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "peak" => DetectorKind::Peak,
            "rms" => DetectorKind::Rms,
            "short" => DetectorKind::ShortTerm,
            "speech" => DetectorKind::Speech,
            _ => return None,
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            DetectorKind::Peak => "peak",
            DetectorKind::Rms => "rms",
            DetectorKind::ShortTerm => "short",
            DetectorKind::Speech => "speech",
        }
    }
}

/// Weicher Schritt Richtung Ziel: exponentielle Annäherung mit Zeitkonstante `tau_ms`.
fn approach(cur: f64, target: f64, dt_ms: f64, tau_ms: f64) -> f64 {
    if tau_ms <= 0.0 {
        return target;
    }
    cur + (target - cur) * (1.0 - (-dt_ms / tau_ms).exp())
}

// ───────────────────────────── AutoMix ─────────────────────────────

/// Obergrenze der Summe der Amplitudenanteile (≈ +1.6 dB) — begrenzt das
/// kurzzeitige Aufaddieren beim Sprecherwechsel.
const SUM_CAP: f64 = 1.2;

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct AutoMixParams {
    pub enabled: bool,
    pub attack_ms: f64,
    pub hold_ms: f64,
    pub release_ms: f64,
    /// Maximale Absenkung eines nicht dominanten Kanals (dB, ≤ 0).
    pub max_atten_db: f64,
    /// Exponent auf die gewichteten Pegel: 1 = klassisches Gain-Sharing,
    /// größer = stärker "der Lauteste gewinnt".
    pub sharing: f64,
    pub detector: DetectorKind,
}

impl Default for AutoMixParams {
    /// Nicht aggressiv: kurzes Öffnen, ruhiges Schließen, begrenzte Absenkung.
    fn default() -> Self {
        AutoMixParams {
            enabled: false,
            attack_ms: 40.0,
            hold_ms: 300.0,
            release_ms: 700.0,
            max_atten_db: -18.0,
            sharing: 1.0,
            detector: DetectorKind::Speech,
        }
    }
}

/// Eingang eines Kanals für einen Engine-Schritt.
#[derive(Clone, Copy, Debug)]
pub struct AutoMixIn {
    pub level_db: f64,
    /// Gewicht (Bedienung, ~0.25 … 4); multipliziert die Entscheidungsgröße,
    /// ist *kein* Audio-Gain.
    pub weight: f64,
    /// 0 = normal, 1 = bevorzugt, 2 = Host/Vorrang (Faktor 1 + 0.5·Prio).
    pub priority: u8,
    /// Unter dieser Schwelle gilt der Kanal als "spricht nicht".
    pub sensitivity_db: f64,
    /// Nimmt am Gain-Sharing teil (aktiv, nicht stumm, nicht Manual,
    /// Detektor lebt). Sonst Ziel 0 dB und kein Einfluss auf andere.
    pub participate: bool,
}

#[derive(Default)]
struct AmChan {
    gain_db: f64,
    /// Gehaltener gewichteter Pegel: ein Kanal zählt nach dem Verstummen
    /// noch `hold_ms` als sprechend (kein Flattern zwischen Wörtern, und
    /// beim Sprecherwechsel teilen sich beide den Anteil statt dass kurz
    /// zwei Mikrofone voll offen sind — die Summe bleibt konstant).
    held: f64,
    hold_left: f64,
    fresh: bool,
}

#[derive(Default)]
pub struct AutoMixEngine {
    chans: HashMap<String, AmChan>,
    last_share: HashMap<String, f64>,
    silent_ms: f64,
}

impl AutoMixEngine {
    /// Aktuelle Gains (dB) ohne neuen Schritt.
    #[cfg(test)]
    pub fn gain_db(&self, id: &str) -> f64 {
        self.chans.get(id).map_or(0.0, |c| c.gain_db)
    }

    /// Ein Schritt über die Mitglieder einer Gruppe. Rückgabe: (id, Gain dB ≤ 0).
    pub fn step(&mut self, dt_ms: f64, p: &AutoMixParams, ins: &[(String, AutoMixIn)]) -> Vec<(String, f64)> {
        // Zustände ausgeschiedener Mitglieder verwerfen.
        self.chans.retain(|id, _| ins.iter().any(|(i, _)| i == id));
        self.last_share.retain(|id, _| ins.iter().any(|(i, _)| i == id));

        let weighted = |i: &AutoMixIn| -> f64 {
            if !i.participate || i.level_db < i.sensitivity_db {
                return 0.0;
            }
            let amp = 10f64.powf(i.level_db / 20.0);
            let w = i.weight.max(0.01) * (1.0 + 0.5 * i.priority as f64);
            (amp * w).powf(p.sharing.max(0.1))
        };
        let mut levels: Vec<f64> = Vec::with_capacity(ins.len());
        for (id, i) in ins {
            let c = self.chans.entry(id.clone()).or_insert_with(|| AmChan { fresh: true, ..Default::default() });
            let w = weighted(i);
            if !i.participate {
                c.held = 0.0;
                c.hold_left = 0.0;
            } else if w > 0.0 {
                c.held = w;
                c.hold_left = p.hold_ms;
            } else if c.hold_left > 0.0 {
                c.hold_left -= dt_ms;
            } else {
                c.held = 0.0;
            }
            levels.push(c.held);
        }
        let total: f64 = levels.iter().sum();
        let n_active = ins.iter().filter(|(_, i)| i.participate).count().max(1);

        let mut shares: HashMap<&str, f64> = HashMap::new();
        if total > 1e-9 {
            self.silent_ms = 0.0;
            for ((id, i), l) in ins.iter().zip(&levels) {
                let s = if i.participate { l / total } else { 0.0 };
                shares.insert(id.as_str(), s);
                self.last_share.insert(id.clone(), s);
            }
        } else {
            self.silent_ms += dt_ms;
            // Last-Mic-Hold: Verteilung eine Weile einfrieren, danach
            // gleichmäßige Aufteilung (NOM-Verhalten) — Übergang geglättet.
            let frozen = self.silent_ms < p.hold_ms + p.release_ms;
            for (id, i) in ins {
                let s = if !i.participate {
                    0.0
                } else if frozen {
                    self.last_share.get(id).copied().unwrap_or(1.0 / n_active as f64)
                } else {
                    1.0 / n_active as f64
                };
                shares.insert(id.as_str(), s);
            }
        }

        let mut out = Vec::with_capacity(ins.len());
        let mut targets: Vec<f64> = Vec::with_capacity(ins.len());
        for (id, i) in ins {
            let c = self.chans.get_mut(id).expect("eingefügt oben");
            let target = if i.participate {
                let s = shares.get(id.as_str()).copied().unwrap_or(0.0);
                (20.0 * s.max(1e-6).log10()).max(p.max_atten_db.min(0.0))
            } else {
                0.0
            };
            if c.fresh {
                // Neu hinzugekommen: direkt auf den Zielwert, nicht von 0 dB
                // herunterlaufen (sonst addieren sich alle offenen Mikrofone).
                c.gain_db = target;
                c.fresh = false;
            } else if target > c.gain_db {
                // Kanal wird dominanter / Rückkehr zu 0 dB: schnell (Attack).
                c.gain_db = approach(c.gain_db, target, dt_ms, p.attack_ms);
            } else {
                c.gain_db = approach(c.gain_db, target, dt_ms, p.release_ms);
            }
            // Numerisch sauber an den Grenzen enden lassen.
            c.gain_db = c.gain_db.clamp(p.max_atten_db.min(0.0), 0.0);
            targets.push(target);
        }

        // Summenbegrenzung: schließt ein Kanal langsam (Release), während ein
        // anderer schnell öffnet (Attack), wäre die Amplitudensumme kurz > 1.
        // Dann werden die *schließenden* Kanäle (Gain über Ziel) so weit
        // zusätzlich abgesenkt, dass die Summe `SUM_CAP` nicht übersteigt —
        // die öffnenden bleiben unberührt (kein Pumpen der neuen Stimme).
        let amp = |db: f64| 10f64.powf(db / 20.0);
        let mut sum: f64 = ins.iter().map(|(id, _)| amp(self.chans[id].gain_db)).sum();
        if sum > SUM_CAP {
            let mut closing: Vec<usize> = (0..ins.len())
                .filter(|&k| self.chans[&ins[k].0].gain_db > targets[k] + 1e-9)
                .collect();
            closing.sort_by(|&a, &b| {
                let da = self.chans[&ins[a].0].gain_db - targets[a];
                let db_ = self.chans[&ins[b].0].gain_db - targets[b];
                db_.partial_cmp(&da).unwrap_or(std::cmp::Ordering::Equal)
            });
            for k in closing {
                let c = self.chans.get_mut(&ins[k].0).expect("vorhanden");
                let room = amp(c.gain_db) - amp(targets[k]);
                let cut = (sum - SUM_CAP).min(room).max(0.0);
                c.gain_db = 20.0 * (amp(c.gain_db) - cut).max(1e-6).log10();
                sum -= cut;
                if sum <= SUM_CAP {
                    break;
                }
            }
        }
        for (id, _) in ins {
            out.push((id.clone(), self.chans[id].gain_db));
        }
        out
    }
}

// ───────────────────────────── Ducking ─────────────────────────────

#[derive(Clone, PartialEq, Debug)]
pub struct DuckParams {
    pub threshold_db: f64,
    /// Schließen erst unter `threshold − hysteresis`.
    pub hysteresis_db: f64,
    /// Nennabsenkung (dB, ≤ 0).
    pub amount_db: f64,
    /// Obergrenze der Absenkung (dB, ≤ 0), auch bei mehreren Regeln.
    pub max_db: f64,
    pub attack_ms: f64,
    pub hold_ms: f64,
    pub release_ms: f64,
    /// Der Key muss so lange über der Schwelle liegen, bevor ducked wird —
    /// ein kurzer Peak löst nichts aus.
    pub min_trigger_ms: f64,
    pub detector: DetectorKind,
}

impl Default for DuckParams {
    /// Atmosphäre bleibt hörbar: −8 dB, ruhige Rückkehr (1.5 s).
    fn default() -> Self {
        DuckParams {
            threshold_db: -38.0,
            hysteresis_db: 4.0,
            amount_db: -8.0,
            max_db: -20.0,
            attack_ms: 120.0,
            hold_ms: 500.0,
            release_ms: 1500.0,
            min_trigger_ms: 60.0,
            detector: DetectorKind::Speech,
        }
    }
}

#[derive(Default)]
pub struct DuckEngine {
    open: bool,
    above_ms: f64,
    hold_left: f64,
    gain_db: f64,
}

impl DuckEngine {
    #[cfg(test)]
    pub fn gain_db(&self) -> f64 {
        self.gain_db
    }

    #[cfg(test)]
    pub fn is_ducking(&self) -> bool {
        self.open
    }

    /// `key_level_db`: Pegel der Key-Quelle (`SILENCE_DB` bei Ausfall/stumm).
    pub fn step(&mut self, dt_ms: f64, p: &DuckParams, key_level_db: f64) -> f64 {
        let above = if self.open {
            key_level_db > p.threshold_db - p.hysteresis_db
        } else {
            key_level_db > p.threshold_db
        };
        if above {
            self.above_ms += dt_ms;
            self.hold_left = p.hold_ms;
            if !self.open && self.above_ms >= p.min_trigger_ms {
                self.open = true;
            }
        } else {
            self.above_ms = 0.0;
            if self.open {
                if self.hold_left > 0.0 {
                    self.hold_left -= dt_ms;
                } else {
                    self.open = false;
                }
            }
        }
        let depth = p.amount_db.min(0.0).max(p.max_db.min(0.0));
        let target = if self.open { depth } else { 0.0 };
        let tau = if target < self.gain_db { p.attack_ms } else { p.release_ms };
        self.gain_db = approach(self.gain_db, target, dt_ms, tau);
        if self.gain_db > -0.01 && target == 0.0 {
            self.gain_db = 0.0;
        }
        self.gain_db
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;

    const DT: f64 = 10.0;

    fn ins(levels: &[f64]) -> Vec<(String, AutoMixIn)> {
        levels
            .iter()
            .enumerate()
            .map(|(i, l)| {
                (
                    format!("m{i}"),
                    AutoMixIn { level_db: *l, weight: 1.0, priority: 0, sensitivity_db: -60.0, participate: true },
                )
            })
            .collect()
    }

    fn run(e: &mut AutoMixEngine, p: &AutoMixParams, inputs: &[(String, AutoMixIn)], ms: f64) -> Vec<f64> {
        let mut out = vec![];
        for _ in 0..(ms / DT) as usize {
            out = e.step(DT, p, inputs).into_iter().map(|(_, g)| g).collect();
        }
        out
    }

    #[test]
    fn dominant_speaker_stays_open_others_are_attenuated() {
        let mut e = AutoMixEngine::default();
        let p = AutoMixParams::default();
        // Mic 0 spricht (−20 dB), die anderen nur Raum (−50 dB).
        let g = run(&mut e, &p, &ins(&[-20.0, -50.0, -52.0, -48.0]), 3000.0);
        assert!(g[0] > -1.0, "dominant {:?}", g);
        for x in &g[1..] {
            assert!(*x < -10.0, "{g:?}");
        }
    }

    #[test]
    fn gain_sharing_keeps_total_amplitude_constant() {
        let mut e = AutoMixEngine::default();
        let mut p = AutoMixParams::default();
        p.max_atten_db = -60.0;
        // Zwei gleich laute Sprecher teilen sich: je −6 dB, Summe der Amplituden = 1.
        let g = run(&mut e, &p, &ins(&[-20.0, -20.0]), 6000.0);
        let sum: f64 = g.iter().map(|x| 10f64.powf(x / 20.0)).sum();
        assert!((sum - 1.0).abs() < 0.03, "{g:?} sum {sum}");
        // Drei gleiche → je −9.5 dB.
        let mut e = AutoMixEngine::default();
        let g = run(&mut e, &p, &ins(&[-20.0, -20.0, -20.0]), 8000.0);
        let sum: f64 = g.iter().map(|x| 10f64.powf(x / 20.0)).sum();
        assert!((sum - 1.0).abs() < 0.03, "{g:?}");
    }

    #[test]
    fn total_never_exceeds_unity_with_many_open_mics() {
        let mut e = AutoMixEngine::default();
        let p = AutoMixParams::default();
        let inputs = ins(&[-25.0, -24.0, -26.0, -30.0, -22.0, -28.0]);
        for _ in 0..500 {
            let g = e.step(DT, &p, &inputs);
            let sum: f64 = g.iter().map(|(_, x)| 10f64.powf(x / 20.0)).sum();
            assert!(sum < 1.25, "sum {sum}");
        }
    }

    #[test]
    fn max_attenuation_is_respected() {
        let mut e = AutoMixEngine::default();
        let mut p = AutoMixParams::default();
        p.max_atten_db = -9.0;
        let g = run(&mut e, &p, &ins(&[-10.0, -55.0]), 10000.0);
        assert!(g[1] >= -9.0 - 1e-9 && g[1] < -8.0, "{g:?}");
    }

    #[test]
    fn speaker_change_opens_fast_keeps_sum_bounded_and_closes_calmly() {
        let mut p = AutoMixParams::default();
        p.attack_ms = 20.0;
        p.hold_ms = 500.0;
        p.release_ms = 1000.0;
        let swapped = ins(&[-50.0, -20.0]);
        let mut e = AutoMixEngine::default();
        run(&mut e, &p, &ins(&[-20.0, -50.0]), 5000.0);
        assert!(e.gain_db("m1") < -14.0);
        // m1 beginnt zu sprechen: Aufmachen (Attack) geht schnell …
        let mut open_ms = 0.0;
        let mut max_sum: f64 = 0.0;
        for k in 0..30 {
            let g = e.step(DT, &p, &swapped);
            max_sum = max_sum.max(g.iter().map(|(_, x)| 10f64.powf(x / 20.0)).sum());
            if e.gain_db("m1") > -7.0 && open_ms == 0.0 {
                open_ms = (k + 1) as f64 * DT;
            }
        }
        assert!(open_ms > 0.0 && open_ms < 250.0, "open {open_ms}");
        // … die Summe bleibt dabei begrenzt (kein Aufaddieren zweier offener
        // Mikrofone) …
        assert!(max_sum < 1.25, "Summe während des Wechsels {max_sum}");
        // … und m0 schließt danach weiter ruhig, nicht schlagartig.
        for _ in 0..40 {
            e.step(DT, &p, &swapped);
        }
        let mid = e.gain_db("m0");
        for _ in 0..300 {
            e.step(DT, &p, &swapped);
        }
        assert!(e.gain_db("m0") < mid - 2.0 && e.gain_db("m0") < -12.0, "release {mid} → {}", e.gain_db("m0"));
    }

    #[test]
    fn weight_and_priority_shift_the_decision() {
        let p = AutoMixParams { max_atten_db: -40.0, ..AutoMixParams::default() };
        let mut a = ins(&[-20.0, -20.0]);
        a[0].1.priority = 2; // Host
        let mut e = AutoMixEngine::default();
        let g = run(&mut e, &p, &a, 6000.0);
        assert!(g[0] > g[1] + 3.0, "{g:?}");
        let mut b = ins(&[-20.0, -20.0]);
        b[1].1.weight = 3.0;
        let mut e = AutoMixEngine::default();
        let g = run(&mut e, &p, &b, 6000.0);
        assert!(g[1] > g[0] + 3.0, "{g:?}");
    }

    #[test]
    fn sensitivity_excludes_quiet_channels_from_the_decision() {
        let mut inputs = ins(&[-30.0, -45.0]);
        inputs[1].1.sensitivity_db = -40.0; // m1 liegt darunter → spricht nicht
        let mut e = AutoMixEngine::default();
        let g = run(&mut e, &AutoMixParams::default(), &inputs, 4000.0);
        assert!(g[0] > -1.0);
    }

    #[test]
    fn muted_or_manual_channels_do_not_take_part_and_return_to_0db() {
        let mut inputs = ins(&[-20.0, -20.0]);
        let mut e = AutoMixEngine::default();
        let p = AutoMixParams::default();
        run(&mut e, &p, &inputs, 4000.0);
        assert!(e.gain_db("m0") < -3.0);
        inputs[1].1.participate = false; // m1 stumm → m0 bekommt wieder den vollen Anteil
        let g = run(&mut e, &p, &inputs, 4000.0);
        assert!(g[0] > -0.5 && g[1].abs() < 0.5, "{g:?}");
    }

    #[test]
    fn groups_are_isolated() {
        let p = AutoMixParams::default();
        let mut studio = AutoMixEngine::default();
        let mut stadium = AutoMixEngine::default();
        // Ein extrem lautes Stadion-Signal darf die Studio-Gruppe nicht beeinflussen.
        let studio_in = ins(&[-20.0, -50.0]);
        let g1 = run(&mut studio, &p, &studio_in, 4000.0);
        let _ = run(&mut stadium, &p, &ins(&[0.0, -10.0]), 4000.0);
        let g2 = run(&mut studio, &p, &studio_in, 1000.0);
        assert!((g1[0] - g2[0]).abs() < 0.2);
    }

    #[test]
    fn silence_holds_last_distribution_then_relaxes_to_equal_share() {
        let mut e = AutoMixEngine::default();
        let mut p = AutoMixParams::default();
        p.hold_ms = 200.0;
        p.release_ms = 400.0;
        run(&mut e, &p, &ins(&[-20.0, -50.0]), 4000.0);
        let quiet = ins(&[-90.0, -90.0]);
        let g = run(&mut e, &p, &quiet, 300.0);
        assert!(g[0] > -1.0, "last-mic hold {g:?}");
        let g = run(&mut e, &p, &quiet, 8000.0);
        assert!((g[0] - g[1]).abs() < 1.0, "equal {g:?}");
    }

    #[test]
    fn fail_safe_all_participants_gone_returns_to_unity() {
        let mut e = AutoMixEngine::default();
        let p = AutoMixParams::default();
        let mut inputs = ins(&[-20.0, -50.0]);
        run(&mut e, &p, &inputs, 3000.0);
        for (_, i) in inputs.iter_mut() {
            i.participate = false; // Detektor ausgefallen
        }
        let g = run(&mut e, &p, &inputs, 3000.0);
        assert!(g.iter().all(|x| x.abs() < 0.3), "{g:?}");
    }

    // ───── Ducking ─────

    fn duck_run(e: &mut DuckEngine, p: &DuckParams, level: f64, ms: f64) -> f64 {
        let mut g = 0.0;
        for _ in 0..(ms / DT) as usize {
            g = e.step(DT, p, level);
        }
        g
    }

    #[test]
    fn duck_reaches_amount_and_never_exceeds_max() {
        let p = DuckParams { amount_db: -8.0, max_db: -20.0, ..DuckParams::default() };
        let mut e = DuckEngine::default();
        let g = duck_run(&mut e, &p, -20.0, 3000.0);
        assert!((g - -8.0).abs() < 0.3, "{g}");
        let p = DuckParams { amount_db: -30.0, max_db: -12.0, ..DuckParams::default() };
        let mut e = DuckEngine::default();
        let g = duck_run(&mut e, &p, -20.0, 5000.0);
        assert!((-12.0 - 1e-6..-11.0).contains(&g), "{g}");
    }

    #[test]
    fn duck_ignores_short_peaks_and_quiet_keys() {
        let p = DuckParams::default();
        let mut e = DuckEngine::default();
        // 30 ms Peak < min_trigger (60 ms)
        duck_run(&mut e, &p, -10.0, 30.0);
        let g = duck_run(&mut e, &p, -90.0, 500.0);
        assert!(g > -0.5, "{g}");
        assert!(!e.is_ducking());
        // Key unter Schwelle
        let mut e = DuckEngine::default();
        assert!(duck_run(&mut e, &p, -50.0, 3000.0).abs() < 0.01);
    }

    #[test]
    fn duck_hysteresis_keeps_ducking_between_thresholds() {
        let p = DuckParams { threshold_db: -38.0, hysteresis_db: 6.0, hold_ms: 0.0, ..DuckParams::default() };
        let mut e = DuckEngine::default();
        duck_run(&mut e, &p, -30.0, 1000.0);
        assert!(e.is_ducking());
        // −41 dB liegt unter der Öffnungsschwelle, aber über Schwelle−Hysterese (−44) → bleibt offen.
        duck_run(&mut e, &p, -41.0, 1000.0);
        assert!(e.is_ducking());
        duck_run(&mut e, &p, -50.0, 200.0);
        assert!(!e.is_ducking());
    }

    #[test]
    fn duck_hold_then_slow_release_without_jumps() {
        let p = DuckParams { hold_ms: 400.0, release_ms: 1500.0, ..DuckParams::default() };
        let mut e = DuckEngine::default();
        duck_run(&mut e, &p, -20.0, 3000.0);
        let ducked = e.gain_db();
        // Während des Holds bewegt sich nichts.
        let g = duck_run(&mut e, &p, -90.0, 300.0);
        assert!((g - ducked).abs() < 0.2, "{g} vs {ducked}");
        // Danach langsam zurück; jeder Schritt klein (kein Sprung).
        let mut prev = e.gain_db();
        let mut max_step: f64 = 0.0;
        for _ in 0..600 {
            let g = e.step(DT, &p, -90.0);
            max_step = max_step.max((g - prev).abs());
            prev = g;
        }
        assert!(max_step < 0.2, "step {max_step}");
        assert!(prev > -0.5, "zurück {prev}");
    }

    #[test]
    fn duck_attack_is_gradual() {
        let p = DuckParams { attack_ms: 200.0, min_trigger_ms: 0.0, ..DuckParams::default() };
        let mut e = DuckEngine::default();
        let g = duck_run(&mut e, &p, -20.0, 50.0);
        assert!(g > -4.0, "kein harter Sprung: {g}");
    }
}
