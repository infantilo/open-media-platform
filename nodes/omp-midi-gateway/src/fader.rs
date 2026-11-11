//! Fader-Kennlinie (Kapitel 93) — wie `ui/shell/midi/fader-law.ts`: stückweise linear in dB, 0 dB bei 75 % Weg, +12 dB oben,
//! −60 dB unten. OMP-Eigenlösung (keine Norm für die Kennlinie eines Mischpult-Faders).

pub const GAIN_MIN_DB: f64 = -60.0;
pub const GAIN_MAX_DB: f64 = 12.0;
const POINTS: [(f64, f64); 6] = [(0.0, GAIN_MIN_DB), (0.2, -40.0), (0.45, -20.0), (0.6, -10.0), (0.75, 0.0), (1.0, GAIN_MAX_DB)];

pub fn position_to_db(p: f64) -> f64 {
    let x = p.clamp(0.0, 1.0);
    for i in 1..POINTS.len() {
        let (x1, y1) = POINTS[i];
        if x <= x1 {
            let (x0, y0) = POINTS[i - 1];
            return y0 + (x - x0) / (x1 - x0) * (y1 - y0);
        }
    }
    GAIN_MAX_DB
}

pub fn db_to_position(db: f64) -> f64 {
    let y = db.clamp(GAIN_MIN_DB, GAIN_MAX_DB);
    for i in 1..POINTS.len() {
        let (x1, y1) = POINTS[i];
        if y <= y1 {
            let (x0, y0) = POINTS[i - 1];
            return x0 + (y - y0) / (y1 - y0) * (x1 - x0);
        }
    }
    1.0
}

/// 14-Bit-Wert → dB auf 0,1 dB gerundet.
pub fn fader_to_db(v14: i32) -> f64 {
    (position_to_db(v14 as f64 / 16383.0) * 10.0).round() / 10.0
}

pub fn db_to_fader(db: f64) -> i32 {
    (db_to_position(db) * 16383.0).round() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn law() {
        assert_eq!(position_to_db(0.75), 0.0);
        assert_eq!(position_to_db(0.0), -60.0);
        assert_eq!(position_to_db(1.0), 12.0);
        let mut last = -1e9;
        for i in 0..=200 {
            let d = position_to_db(i as f64 / 200.0);
            assert!(d >= last);
            last = d;
        }
        for db in [-60.0, -45.5, -20.0, -3.0, 0.0, 6.0, 12.0] {
            assert!((position_to_db(db_to_position(db)) - db).abs() < 1e-9, "{db}");
        }
        assert_eq!(db_to_fader(0.0), 12287);
        assert_eq!(fader_to_db(16383), 12.0);
        assert_eq!(fader_to_db(0), -60.0);
    }
}
