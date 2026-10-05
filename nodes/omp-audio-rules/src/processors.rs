//! Matrix-Prozessoren: Koeffizienten (Zeilen = Zielkanäle, Spalten = Quellkanäle).
//! `None` = Prozessor passt nicht zu den Kanalzahlen.

pub type Matrix = Vec<Vec<f32>>;

const MINUS_3_DB: f32 = 0.707_106_8;

fn identity(n: usize) -> Matrix {
    (0..n).map(|r| (0..n).map(|c| if r == c { 1.0 } else { 0.0 }).collect()).collect()
}

/// Namen der eingebauten Matrix-Prozessoren (für Editor-Auswahl und Validierung).
pub const MATRIX_PROCESSORS: &[&str] = &["auto", "matrix", "mono-to-stereo", "stereo-to-mono", "upmix51", "downmix", "downmix-mono"];

/// DSP-Prozessoren, die der Ausspielnode als Verarbeitungskette ausführt.
pub const DSP_PROCESSORS: &[&str] = &["dialog-enhance", "loudness", "gain", "delay"];

/// Koeffizienten für `name` bei `src` Quell- und `dst` Zielkanälen.
pub fn matrix_for(name: &str, src: usize, dst: usize) -> Option<Matrix> {
    match name {
        // Gleiche Kanalzahl: Durchgriff; sonst die naheliegende Anpassung.
        "auto" => {
            if src == dst {
                Some(identity(src))
            } else if src == 1 && dst == 2 {
                matrix_for("mono-to-stereo", 1, 2)
            } else if src == 2 && dst == 1 {
                matrix_for("stereo-to-mono", 2, 1)
            } else {
                None
            }
        }
        "matrix" => (src == dst).then(|| identity(src)),
        "mono-to-stereo" => (src == 1 && dst == 2).then(|| vec![vec![1.0], vec![1.0]]),
        "stereo-to-mono" => (src == 2 && dst == 1).then(|| vec![vec![0.5, 0.5]]),
        // Passiver Stereo→5.1-Upmix: L/R unverändert, C = −3 dB-Summe, Surround = Differenzsignal, kein LFE.
        "upmix51" => (src == 2 && dst == 6).then(|| {
            vec![
                vec![1.0, 0.0],
                vec![0.0, 1.0],
                vec![MINUS_3_DB * 0.5, MINUS_3_DB * 0.5],
                vec![0.0, 0.0],
                vec![0.5, -0.5],
                vec![-0.5, 0.5],
            ]
        }),
        // ITU-R BS.775: Lo = L + 0,707·C + 0,707·Ls (LFE verworfen); Quelle 5.1 (L R C LFE Ls Rs).
        "downmix" => (src == 6 && dst == 2).then(|| {
            vec![
                vec![1.0, 0.0, MINUS_3_DB, 0.0, MINUS_3_DB, 0.0],
                vec![0.0, 1.0, MINUS_3_DB, 0.0, 0.0, MINUS_3_DB],
            ]
        }),
        "downmix-mono" => (src == 6 && dst == 1).then(|| {
            vec![vec![0.5, 0.5, MINUS_3_DB, 0.0, 0.35, 0.35]]
        }),
        _ => None,
    }
}

/// Jede Zeile hat genau einen Eintrag 1,0, sonst 0 → reine Auswahl (bit-exakt).
pub fn is_pure_selection(m: &Matrix) -> bool {
    m.iter().all(|row| row.iter().filter(|&&c| c != 0.0).count() <= 1 && row.iter().all(|&c| c == 0.0 || c == 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_adapts_only_obvious_cases() {
        assert_eq!(matrix_for("auto", 2, 2).unwrap(), identity(2));
        assert_eq!(matrix_for("auto", 1, 2).unwrap(), vec![vec![1.0], vec![1.0]]);
        assert!(matrix_for("auto", 6, 2).is_none());
        assert!(matrix_for("auto", 2, 6).is_none());
    }

    #[test]
    fn downmix_follows_itu() {
        let m = matrix_for("downmix", 6, 2).unwrap();
        assert_eq!(m.len(), 2);
        assert!((m[0][2] - 0.7071).abs() < 1e-3 && m[0][3] == 0.0);
    }

    #[test]
    fn upmix_has_no_lfe_and_keeps_front() {
        let m = matrix_for("upmix51", 2, 6).unwrap();
        assert_eq!(m[0], vec![1.0, 0.0]);
        assert_eq!(m[3], vec![0.0, 0.0]);
    }

    #[test]
    fn selection_detection() {
        assert!(is_pure_selection(&identity(3)));
        assert!(is_pure_selection(&vec![vec![1.0], vec![1.0]]));
        assert!(!is_pure_selection(&matrix_for("stereo-to-mono", 2, 1).unwrap()));
    }

    #[test]
    fn unknown_or_mismatched_is_none() {
        assert!(matrix_for("nope", 2, 2).is_none());
        assert!(matrix_for("downmix", 2, 2).is_none());
    }
}
