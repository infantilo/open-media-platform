//! Fingeralphabet und Ziffern als handgemachte Posen.
//!
//! **Näherung:** Die Handformen sind aus der Beschreibung des deutschen Fingeralphabets nachgebaut
//! und nicht von Gebärdenden abgenommen; vor jedem produktiven Einsatz müssen sie von Gehörlosen
//! geprüft werden (docs/GEBAERDENSPRACHE.md §6). Bewegte Buchstaben (J, Z) und Umlaute sind in
//! Phase 1 stark vereinfacht (Z, J: Handform mit Handgelenk-Schwung; Ä/Ö/Ü: Grundbuchstabe, zweimal).

use crate::avatar::{ArmPose, Pose};

struct Shape {
    /// Daumen, Zeige-, Mittel-, Ring-, kleiner Finger
    curl: [f32; 5],
    thumb_abd: f32,
    spread: f32,
    /// Zusatzdrehung des Handgelenks (x,y,z)
    wrist: [f32; 3],
}

const fn s(curl: [f32; 5], thumb_abd: f32, spread: f32, wrist: [f32; 3]) -> Shape {
    Shape { curl, thumb_abd, spread, wrist }
}

const FLAT: [f32; 3] = [0.0; 3];
const SIDEWAYS: [f32; 3] = [0.0, 0.0, 1.4];
const DOWN: [f32; 3] = [-0.9, 0.0, 0.0];

fn shape(c: char) -> Option<Shape> {
    let c = c.to_ascii_uppercase();
    Some(match c {
        'A' => s([0.2, 1.0, 1.0, 1.0, 1.0], 0.1, 0.0, FLAT),
        'B' => s([0.85, 0.0, 0.0, 0.0, 0.0], 0.0, 0.0, FLAT),
        'C' => s([0.45, 0.45, 0.45, 0.45, 0.45], 0.5, 0.2, FLAT),
        'D' => s([0.6, 0.0, 0.85, 0.85, 0.85], 0.2, 0.0, FLAT),
        'E' => s([0.9, 0.8, 0.8, 0.8, 0.8], 0.0, 0.0, FLAT),
        'F' => s([0.7, 0.7, 0.0, 0.0, 0.0], 0.3, 0.4, FLAT),
        'G' => s([0.1, 0.0, 1.0, 1.0, 1.0], 0.1, 0.0, SIDEWAYS),
        'H' => s([0.9, 0.0, 0.0, 1.0, 1.0], 0.0, 0.0, SIDEWAYS),
        'I' => s([0.9, 1.0, 1.0, 1.0, 0.0], 0.0, 0.0, FLAT),
        'J' => s([0.9, 1.0, 1.0, 1.0, 0.0], 0.0, 0.0, [0.0, 0.0, 0.6]),
        'K' => s([0.2, 0.0, 0.1, 1.0, 1.0], 0.5, 0.8, FLAT),
        'L' => s([0.0, 0.0, 1.0, 1.0, 1.0], 1.0, 0.0, FLAT),
        'M' => s([0.95, 0.9, 0.9, 0.9, 1.0], 0.0, 0.0, [0.5, 0.0, 0.0]),
        'N' => s([0.95, 0.9, 0.9, 1.0, 1.0], 0.0, 0.0, [0.5, 0.0, 0.0]),
        'O' => s([0.6, 0.55, 0.55, 0.55, 0.55], 0.4, 0.0, FLAT),
        'P' => s([0.2, 0.0, 0.1, 1.0, 1.0], 0.5, 0.8, DOWN),
        'Q' => s([0.1, 0.0, 1.0, 1.0, 1.0], 0.1, 0.0, [-0.9, 0.0, 0.9]),
        'R' => s([0.9, 0.0, 0.0, 1.0, 1.0], 0.0, -0.8, FLAT),
        'S' => s([0.9, 1.0, 1.0, 1.0, 1.0], 0.0, 0.0, FLAT),
        'T' => s([0.7, 1.0, 1.0, 1.0, 1.0], 0.0, 0.0, FLAT),
        'U' => s([0.9, 0.0, 0.0, 1.0, 1.0], 0.0, 0.0, FLAT),
        'V' => s([0.9, 0.0, 0.0, 1.0, 1.0], 0.0, 1.3, FLAT),
        'W' => s([0.9, 0.0, 0.0, 0.0, 1.0], 0.0, 1.0, FLAT),
        'X' => s([0.9, 0.55, 1.0, 1.0, 1.0], 0.0, 0.0, FLAT),
        'Y' => s([0.0, 1.0, 1.0, 1.0, 0.0], 1.0, 0.0, FLAT),
        'Z' => s([0.7, 0.0, 1.0, 1.0, 1.0], 0.2, 0.0, [0.0, 0.0, -0.5]),
        '0' => s([0.6, 0.55, 0.55, 0.55, 0.55], 0.4, 0.0, FLAT),
        '1' => s([0.9, 0.0, 1.0, 1.0, 1.0], 0.0, 0.0, FLAT),
        '2' => s([0.9, 0.0, 0.0, 1.0, 1.0], 0.0, 0.9, FLAT),
        '3' => s([0.0, 0.0, 0.0, 1.0, 1.0], 0.9, 0.5, FLAT),
        '4' => s([0.9, 0.0, 0.0, 0.0, 0.0], 0.0, 0.7, FLAT),
        '5' => s([0.0, 0.0, 0.0, 0.0, 0.0], 1.0, 1.0, FLAT),
        '6' => s([0.8, 0.0, 0.0, 0.0, 0.9], 0.0, 0.5, FLAT),
        '7' => s([0.8, 0.0, 0.0, 0.9, 0.0], 0.0, 0.5, FLAT),
        '8' => s([0.8, 0.0, 0.9, 0.0, 0.0], 0.0, 0.5, FLAT),
        '9' => s([0.8, 0.9, 0.0, 0.0, 0.0], 0.0, 0.5, FLAT),
        _ => return None,
    })
}

/// Grundstellung zum Buchstabieren: Unterarm hoch, Handfläche zum Betrachter, andere Hand ruht.
pub fn signing_base() -> ArmPose {
    ArmPose { shoulder: [-1.2, 0.0, -0.3], elbow: -1.75, twist: std::f32::consts::PI, wrist: [0.0; 3], ..ArmPose::REST }
}

/// Normiert Umlaute/ß auf den Grundbuchstaben (Phase 1: Näherung).
fn base_letter(c: char) -> char {
    match c {
        'ä' | 'Ä' => 'A',
        'ö' | 'Ö' => 'O',
        'ü' | 'Ü' => 'U',
        'ß' => 'S',
        o => o,
    }
}

/// Setzt nur die Handform (Finger, Daumen, Spreizen, Handgelenk-Zusatz) eines Zeichens auf einen Arm; die Armstellung bleibt.
/// Rückgabe `false` für unbekannte Zeichen.
pub fn apply_hand(arm: &mut ArmPose, c: char) -> bool {
    let Some(sh) = shape(base_letter(c)) else { return false };
    arm.curl = sh.curl;
    arm.thumb_abd = sh.thumb_abd;
    arm.spread = sh.spread;
    for i in 0..3 {
        arm.wrist[i] += sh.wrist[i];
    }
    true
}

/// Haltung für ein Zeichen; `None` für unbekannte Zeichen (Leerzeichen, Satzzeichen).
pub fn pose_for(c: char) -> Option<Pose> {
    let mut dom = signing_base();
    apply_hand(&mut dom, c).then_some(Pose { dom, ..Pose::REST })
}

/// Grundstellung zum Gebärden vor dem Gesicht (Unterarm hoch, Handfläche zum Betrachter) — Ausgangspunkt für Lexikon-Einträge.
pub fn signing_pose() -> Pose {
    Pose { dom: signing_base(), ..Pose::REST }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_letter_and_digit_has_a_pose() {
        for c in ('a'..='z').chain('0'..='9') {
            assert!(pose_for(c).is_some(), "{c}");
        }
        for c in "äöüÄÖÜß".chars() {
            assert!(pose_for(c).is_some(), "{c}");
        }
        assert!(pose_for(' ').is_none());
        assert!(pose_for('!').is_none());
    }

    #[test]
    fn letters_differ_from_each_other() {
        let all: Vec<(char, Pose)> = ('a'..='z').map(|c| (c, pose_for(c).unwrap())).collect();
        // Bewusst gleiche Handform bei bewegten/ähnlichen Zeichen (S/T, O/0 unterscheiden sich, I/J durch Handgelenk).
        for i in 0..all.len() {
            for j in i + 1..all.len() {
                assert_ne!(all[i].1, all[j].1, "{} und {} identisch", all[i].0, all[j].0);
            }
        }
    }

    #[test]
    fn case_does_not_matter() {
        assert_eq!(pose_for('a'), pose_for('A'));
    }
}
