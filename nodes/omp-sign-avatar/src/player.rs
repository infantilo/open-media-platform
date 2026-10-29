//! Wiedergabe: Folge von Schlüsselhaltungen mit weicher Überblendung. Buchstabieren (Phase 1) und Lexikon-Gebärden (Phase 2)
//! erzeugen beide diese Schlüsselfolge; `pose_at` interpoliert zwischen benachbarten Schlüsseln (Smoothstep, je Abschnitt).

use crate::alphabet;
use crate::avatar::Pose;

pub const HOLD_MS: f32 = 650.0;
pub const TRANSITION_MS: f32 = 220.0;
pub const SPACE_MS: f32 = 450.0;
pub const LEAD_MS: f32 = 400.0;

fn smooth(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[derive(Clone, Debug)]
pub struct Timeline {
    /// (Zeit in ms, Haltung), Zeiten nicht fallend.
    keys: Vec<(f32, Pose)>,
}

impl Timeline {
    /// Beginnt in Ruhehaltung bei 0 und hält sie `lead_ms`.
    pub fn new(lead_ms: f32) -> Timeline {
        Timeline { keys: vec![(0.0, Pose::REST), (lead_ms.max(0.0), Pose::REST)] }
    }

    /// Ende der Folge (ms).
    pub fn total_ms(&self) -> f32 {
        self.keys.last().map_or(0.0, |k| k.0)
    }

    /// Haltung `pose` wird `trans_ms` nach dem Ende der Folge erreicht und `hold_ms` gehalten.
    pub fn push(&mut self, trans_ms: f32, hold_ms: f32, pose: Pose) {
        let t = self.total_ms() + trans_ms.max(0.0);
        self.keys.push((t, pose));
        if hold_ms > 0.0 {
            self.keys.push((t + hold_ms, pose));
        }
    }

    /// Ruhe: überblendet zur Ruhehaltung und hält sie `lead_ms`.
    pub fn finish(&mut self, trans_ms: f32, lead_ms: f32) {
        self.push(trans_ms, lead_ms, Pose::REST);
    }

    /// Haltung am Ende der Folge.
    pub fn last_pose(&self) -> Pose {
        self.keys.last().map_or(Pose::REST, |k| k.1)
    }

    /// Wendet `f` auf alle Schlüssel mit Zeit in [t0, t1] an (Kopfhaltung für Fragen u. ä.). Zwischen den Schlüsseln wird weich
    /// überblendet; an den Rändern des Bereichs liegen Schlüssel der Ruhe/Ausgangshaltung, deshalb beginnt die Wirkung sanft.
    pub fn map_range(&mut self, t0: f32, t1: f32, f: impl Fn(&mut Pose)) {
        for (t, p) in &mut self.keys {
            if *t >= t0 && *t <= t1 {
                f(p);
            }
        }
    }

    /// Buchstabieren; `speed` 1.0 = Normaltempo, größer = schneller.
    pub fn spell(text: &str, speed: f32) -> Timeline {
        let speed = speed.clamp(0.25, 4.0);
        let mut tl = Timeline::new(LEAD_MS / speed);
        tl.push_spelling(text, speed);
        tl.finish(TRANSITION_MS / speed, LEAD_MS / speed);
        tl
    }

    /// Hängt ein Wort/einen Text als Fingeralphabet an (ohne Ruhehaltung davor/danach).
    pub fn push_spelling(&mut self, text: &str, speed: f32) {
        let speed = speed.clamp(0.25, 4.0);
        let (hold, trans, space) = (HOLD_MS / speed, TRANSITION_MS / speed, SPACE_MS / speed);
        let mut prev: Option<char> = None;
        for c in text.chars() {
            let Some(pose) = alphabet::pose_for(c) else {
                // Leerzeichen/Satzzeichen: kurze Pause (nur zwischen Wörtern)
                if prev.is_some() {
                    self.push(0.0, space, self.last_pose());
                }
                prev = None;
                continue;
            };
            // Gleicher Buchstabe hintereinander (z. B. „LL“): kurze Absenkung, sonst sähe man nur einen
            if prev.map(|p| p.to_ascii_lowercase()) == Some(c.to_ascii_lowercase()) {
                let mut lowered = pose;
                lowered.dom.shoulder[0] += 0.12;
                self.push(trans, 0.0, lowered);
            }
            self.push(trans, hold, pose);
            if matches!(c, 'ä' | 'ö' | 'ü' | 'Ä' | 'Ö' | 'Ü') {
                let mut twice = pose;
                twice.dom.wrist[0] -= 0.25;
                self.push(trans * 0.6, hold * 0.5, twice);
            }
            prev = Some(c);
        }
    }

    pub fn pose_at(&self, t_ms: f32) -> Pose {
        let t = t_ms.clamp(0.0, self.total_ms());
        let k = &self.keys;
        // erster Schlüssel mit Zeit > t
        let i = k.partition_point(|(kt, _)| *kt <= t);
        if i == 0 {
            return k[0].1;
        }
        if i >= k.len() {
            return k[k.len() - 1].1;
        }
        let (t0, p0) = k[i - 1];
        let (t1, p1) = k[i];
        if t1 - t0 < 1e-3 || p0 == p1 {
            return p1;
        }
        p0.lerp(&p1, smooth((t - t0) / (t1 - t0)))
    }

    pub fn is_finished(&self, t_ms: f32) -> bool {
        t_ms >= self.total_ms()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_and_ends_at_rest() {
        let tl = Timeline::spell("Hallo", 1.0);
        assert_eq!(tl.pose_at(0.0), Pose::REST);
        assert_eq!(tl.pose_at(tl.total_ms()), Pose::REST);
        assert!(tl.is_finished(tl.total_ms()));
    }

    #[test]
    fn holds_the_letter_pose_and_blends_in_between() {
        let tl = Timeline::spell("ab", 1.0);
        let a = alphabet::pose_for('a').unwrap();
        let b = alphabet::pose_for('b').unwrap();
        let t_a = LEAD_MS + TRANSITION_MS + HOLD_MS / 2.0;
        assert_eq!(tl.pose_at(t_a), a);
        let t_mid = LEAD_MS + TRANSITION_MS + HOLD_MS + TRANSITION_MS / 2.0;
        let mid = tl.pose_at(t_mid);
        assert_ne!(mid, a);
        assert_ne!(mid, b);
        assert!(mid.dom.curl[1] > 0.0 && mid.dom.curl[1] < 1.0);
    }

    #[test]
    fn higher_speed_shortens_the_sequence() {
        assert!(Timeline::spell("Hallo Welt", 2.0).total_ms() < Timeline::spell("Hallo Welt", 1.0).total_ms());
    }

    #[test]
    fn empty_or_unknown_text_is_just_rest() {
        let tl = Timeline::spell("?! ", 1.0);
        assert_eq!(tl.pose_at(tl.total_ms() / 2.0), Pose::REST);
    }
}
