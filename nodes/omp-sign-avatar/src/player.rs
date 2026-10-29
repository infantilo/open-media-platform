//! Wiedergabe: Text → Folge von Haltungen mit weicher Überblendung (Phase 1: buchstabieren).

use crate::alphabet;
use crate::avatar::Pose;

struct Key {
    /// Beginn des Haltens (ms); davor wird aus der vorigen Haltung überblendet.
    arrive_ms: f32,
    hold_ms: f32,
    pose: Pose,
}

pub struct Timeline {
    keys: Vec<Key>,
    total_ms: f32,
}

const HOLD_MS: f32 = 650.0;
const TRANSITION_MS: f32 = 220.0;
const SPACE_MS: f32 = 450.0;
const LEAD_MS: f32 = 400.0;

fn smooth(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

impl Timeline {
    /// `speed` 1.0 = Normaltempo; größer = schneller.
    pub fn spell(text: &str, speed: f32) -> Timeline {
        let speed = speed.clamp(0.25, 4.0);
        let (hold, trans, space) = (HOLD_MS / speed, TRANSITION_MS / speed, SPACE_MS / speed);
        let mut keys = vec![Key { arrive_ms: 0.0, hold_ms: LEAD_MS, pose: alphabet::rest() }];
        let mut t = LEAD_MS;
        let mut prev: Option<char> = None;
        for c in text.chars() {
            let Some(pose) = alphabet::pose_for(c) else {
                // Leerzeichen/Satzzeichen: kurz zur Ruhe-/Grundhaltung
                if !matches!(prev, None) {
                    t += space;
                }
                prev = None;
                continue;
            };
            // Gleicher Buchstabe hintereinander (z. B. „LL“): kurze Lücke, sonst sähe man nur einen
            if prev.map(|p| p.to_ascii_lowercase()) == Some(c.to_ascii_lowercase()) {
                let mut lowered = pose;
                lowered.dom.shoulder[0] += 0.12;
                keys.push(Key { arrive_ms: t + trans, hold_ms: trans, pose: lowered });
                t += trans * 2.0;
            }
            let umlaut = matches!(c, 'ä' | 'ö' | 'ü' | 'Ä' | 'Ö' | 'Ü');
            keys.push(Key { arrive_ms: t + trans, hold_ms: hold, pose });
            t += trans + hold;
            if umlaut {
                let mut twice = pose;
                twice.dom.wrist[0] -= 0.25;
                keys.push(Key { arrive_ms: t + trans * 0.6, hold_ms: hold * 0.5, pose: twice });
                t += trans * 0.6 + hold * 0.5;
            }
            prev = Some(c);
        }
        t += trans;
        keys.push(Key { arrive_ms: t, hold_ms: LEAD_MS, pose: alphabet::rest() });
        let total_ms = t + LEAD_MS;
        Timeline { keys, total_ms }
    }

    pub fn total_ms(&self) -> f32 {
        self.total_ms
    }

    pub fn pose_at(&self, t_ms: f32) -> Pose {
        let t = t_ms.clamp(0.0, self.total_ms);
        let mut prev = &self.keys[0];
        for k in &self.keys {
            if t < k.arrive_ms {
                let span = (k.arrive_ms - (prev.arrive_ms + prev.hold_ms)).max(1.0);
                let u = (t - (prev.arrive_ms + prev.hold_ms)) / span;
                return prev.pose.lerp(&k.pose, smooth(u));
            }
            prev = k;
        }
        prev.pose
    }

    /// Der Buchstabe, der gerade gehalten oder angesteuert wird, ist hier nicht verfolgt — Phase 1
    /// misst nur Bild und CPU.
    pub fn is_finished(&self, t_ms: f32) -> bool {
        t_ms >= self.total_ms
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
