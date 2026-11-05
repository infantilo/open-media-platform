//! Segue-Planung (Radio-Plan §4, RB4): aus den Markern zweier Nachbarn entstehen Startzeitpunkt des Nächsten und Kurven.
//! Reine Rechnung in Millisekunden relativ zum Start des Logs; die Automation übersetzt in `play`-Aufrufe des Segue-Players
//! (`docs/CONTRACT-SEGUE-PLAYER.md`).

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Musiktitel: Kreuzblende mit dem nächsten Titel, Intro-/Outro-Marker.
    Song,
    /// Jingle/Sweeper: startet über dem Ausklang des Vorgängers, hart.
    Jingle,
    /// Gesprochenes, Nachrichten, Spots: laufen am Stück, ohne Überlappung.
    Speech,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Curve {
    Linear,
    Cosine,
    Log,
}

impl Curve {
    pub fn as_str(self) -> &'static str {
        match self {
            Curve::Linear => "linear",
            Curve::Cosine => "cosine",
            Curve::Log => "log",
        }
    }
}

/// Ein Element des Logs mit seinen Marken (Millisekunden in der Datei).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub kind: Kind,
    pub duration_ms: i64,
    /// Beginn der Wiedergabe in der Datei (SOM).
    #[serde(default)]
    pub som_ms: i64,
    /// Ende der Intro-Phase (Gesang setzt ein); nur Anzeige und Regeln, z. B. „Moderation über Intro".
    #[serde(default)]
    pub intro_ms: Option<i64>,
    /// Segue-Punkt: ab hier darf der Nachfolger starten und der Ausklang wird ausgeblendet.
    #[serde(default)]
    pub outro_ms: Option<i64>,
    /// Pegelkorrektur aus der Lautheit (Ziel − gemessen).
    #[serde(default)]
    pub gain_db: f64,
    /// Füllkandidat: darf das Backtiming weglassen (RB5).
    #[serde(default)]
    pub optional: bool,
}

#[derive(Clone, Debug)]
pub struct Config {
    /// Standardlänge der Kreuzblende, wenn der Ausklang lang genug ist.
    pub crossfade_ms: i64,
    /// Ausblenden des Titels unter einem Jingle.
    pub under_jingle_fade_ms: i64,
    /// Einblenden eines Titels nach einem Jingle ohne Intro-Vorgabe.
    pub after_jingle_fade_ms: i64,
    /// Ohne Outro-Marke: so weit vor dem Dateiende beginnt der Segue.
    pub default_outro_ms: i64,
    pub curve: Curve,
}

impl Default for Config {
    fn default() -> Self {
        Config { crossfade_ms: 3000, under_jingle_fade_ms: 1500, after_jingle_fade_ms: 300, default_outro_ms: 3000, curve: Curve::Cosine }
    }
}

/// Geplante Stimme.
#[derive(Clone, Debug, PartialEq)]
pub struct Placed {
    pub id: String,
    /// Zeitpunkt, an dem die Stimme auf dem Ausgang einsetzt (ms ab Logstart).
    pub start_ms: i64,
    pub offset_ms: i64,
    pub gain_db: f64,
    pub fade_in_ms: i64,
    pub fade_in_curve: Curve,
    /// Stelle in der Datei, an der das Ausblenden beginnt (None = bis zum Dateiende).
    pub stop_at_ms: Option<i64>,
    pub fade_out_ms: i64,
    pub fade_out_curve: Curve,
    /// Ende der Stimme auf dem Ausgang (nach dem Ausblenden).
    pub end_ms: i64,
    /// Beginn des Nachfolgers (Segue-Zeitpunkt), ms ab Logstart.
    pub next_start_ms: i64,
}

fn outro_of(it: &Item, cfg: &Config) -> i64 {
    let o = it.outro_ms.unwrap_or(it.duration_ms - cfg.default_outro_ms);
    o.clamp(it.som_ms, it.duration_ms)
}

/// Plant eine Folge ab `start_ms`. Fehlerhafte Eingaben (Dauer ≤ 0) werden abgelehnt.
pub fn plan(items: &[Item], start_ms: i64, cfg: &Config) -> Result<Vec<Placed>, String> {
    for it in items {
        if it.duration_ms <= 0 || it.som_ms < 0 || it.som_ms >= it.duration_ms {
            return Err(format!("{}: ungültige Dauer/SOM", it.id));
        }
    }
    let mut out: Vec<Placed> = Vec::with_capacity(items.len());
    let mut cursor = start_ms;
    // Einblenden, das der Vorgänger für dieses Element festlegt.
    let mut pending_in: (i64, Curve) = (0, cfg.curve);
    for (i, it) in items.iter().enumerate() {
        let next = items.get(i + 1);
        let natural_end = cursor + (it.duration_ms - it.som_ms);
        let (fade_in_ms, fade_in_curve) = pending_in;
        let mut p = Placed {
            id: it.id.clone(),
            start_ms: cursor,
            offset_ms: it.som_ms,
            gain_db: it.gain_db,
            fade_in_ms,
            fade_in_curve,
            stop_at_ms: None,
            fade_out_ms: 0,
            fade_out_curve: cfg.curve,
            end_ms: natural_end,
            next_start_ms: natural_end,
        };
        pending_in = (0, cfg.curve);
        if let Some(n) = next {
            match (it.kind, n.kind) {
                (Kind::Song, Kind::Song) => {
                    let o = outro_of(it, cfg);
                    let tail = it.duration_ms - o;
                    let xf = cfg.crossfade_ms.min(tail.max(0));
                    p.next_start_ms = cursor + (o - it.som_ms);
                    p.stop_at_ms = Some(o);
                    p.fade_out_ms = xf;
                    p.end_ms = p.next_start_ms + xf;
                    pending_in = (xf, cfg.curve);
                }
                (Kind::Song, Kind::Jingle | Kind::Speech) => {
                    let o = outro_of(it, cfg);
                    let tail = it.duration_ms - o;
                    let f = cfg.under_jingle_fade_ms.min(tail.max(0));
                    p.next_start_ms = cursor + (o - it.som_ms);
                    p.stop_at_ms = Some(o);
                    p.fade_out_ms = f;
                    p.end_ms = p.next_start_ms + f;
                }
                (Kind::Jingle, Kind::Song) => {
                    // Der Titel startet unter dem Ende des Jingles (Outro-Marke, sonst 500 ms vor Ende).
                    let o = it.outro_ms.unwrap_or(it.duration_ms - 500).clamp(it.som_ms, it.duration_ms);
                    p.next_start_ms = cursor + (o - it.som_ms);
                    pending_in = (cfg.after_jingle_fade_ms, Curve::Linear);
                }
                _ => {}
            }
        }
        cursor = p.next_start_ms;
        out.push(p);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: &str, dur: i64, outro: Option<i64>) -> Item {
        Item { id: id.into(), kind: Kind::Song, duration_ms: dur, som_ms: 0, intro_ms: None, outro_ms: outro, gain_db: 0.0, optional: false }
    }
    fn jingle(id: &str, dur: i64) -> Item {
        Item { id: id.into(), kind: Kind::Jingle, duration_ms: dur, som_ms: 0, intro_ms: None, outro_ms: None, gain_db: 0.0, optional: false }
    }
    fn speech(id: &str, dur: i64) -> Item {
        Item { id: id.into(), kind: Kind::Speech, duration_ms: dur, som_ms: 0, intro_ms: None, outro_ms: None, gain_db: 0.0, optional: false }
    }

    #[test]
    fn song_to_song_crossfades_at_outro_marker() {
        let p = plan(&[song("a", 200_000, Some(195_000)), song("b", 180_000, None)], 0, &Config::default()).unwrap();
        assert_eq!(p[0].next_start_ms, 195_000);
        assert_eq!(p[0].stop_at_ms, Some(195_000));
        assert_eq!(p[0].fade_out_ms, 3000);
        assert_eq!(p[0].end_ms, 198_000);
        assert_eq!(p[1].start_ms, 195_000);
        assert_eq!(p[1].fade_in_ms, 3000);
        assert_eq!(p[1].fade_in_curve, Curve::Cosine);
    }

    #[test]
    fn crossfade_is_limited_by_the_tail() {
        let p = plan(&[song("a", 100_000, Some(99_000)), song("b", 60_000, None)], 0, &Config::default()).unwrap();
        assert_eq!(p[0].fade_out_ms, 1000);
        assert_eq!(p[1].fade_in_ms, 1000);
        assert_eq!(p[1].start_ms, 99_000);
    }

    #[test]
    fn missing_outro_uses_default_before_end() {
        let p = plan(&[song("a", 120_000, None), song("b", 60_000, None)], 10_000, &Config::default()).unwrap();
        assert_eq!(p[0].start_ms, 10_000);
        assert_eq!(p[1].start_ms, 10_000 + 117_000);
    }

    #[test]
    fn jingle_starts_over_the_outro_hard() {
        let p = plan(&[song("a", 200_000, Some(196_000)), jingle("j", 5000)], 0, &Config::default()).unwrap();
        assert_eq!(p[1].start_ms, 196_000);
        assert_eq!(p[1].fade_in_ms, 0);
        assert_eq!(p[0].fade_out_ms, 1500);
        assert_eq!(p[0].end_ms, 197_500);
    }

    #[test]
    fn song_starts_under_the_jingle_end() {
        let p = plan(&[jingle("j", 6000), song("s", 180_000, None)], 1000, &Config::default()).unwrap();
        assert_eq!(p[1].start_ms, 1000 + 5500);
        assert_eq!(p[1].fade_in_ms, 300);
        assert_eq!(p[1].fade_in_curve, Curve::Linear);
    }

    #[test]
    fn speech_runs_sequentially() {
        let p = plan(&[speech("n", 90_000), song("s", 100_000, None)], 0, &Config::default()).unwrap();
        assert_eq!(p[1].start_ms, 90_000);
        assert_eq!(p[0].end_ms, 90_000);
        assert_eq!(p[1].fade_in_ms, 0);
    }

    #[test]
    fn som_shifts_timeline() {
        let mut a = song("a", 200_000, Some(190_000));
        a.som_ms = 2000;
        let p = plan(&[a, song("b", 1000, None)], 0, &Config::default()).unwrap();
        assert_eq!(p[0].offset_ms, 2000);
        assert_eq!(p[1].start_ms, 188_000);
    }

    #[test]
    fn invalid_duration_is_rejected() {
        assert!(plan(&[song("a", 0, None)], 0, &Config::default()).is_err());
    }
}
