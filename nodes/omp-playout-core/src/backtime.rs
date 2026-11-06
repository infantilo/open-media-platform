//! Backtiming / weiche Fixzeit (Radio-Plan §4, RB5): Eine harte Marke (z. B. Nachrichten um :00:00) muss getroffen werden.
//! Die Rechnung läuft rückwärts von der Marke: Sie lässt Füllkandidaten (`optional`) weg, zieht Segue-Punkte der Titel davor vor
//! (höchstens `max_shift_ms` je Titel) oder füllt mit Kandidaten und schiebt Segue-Punkte nach hinten. Jede Entscheidung steht als
//! Text im Ergebnis (As-Run mit Begründung); was nicht erreichbar ist, bleibt als `residual_ms` ausgewiesen.

use crate::segue::{self, Config, Item, Kind};

#[derive(Clone, Debug)]
pub struct Params {
    /// Größte Verschiebung eines Segue-Punkts je Titel (ms).
    pub max_shift_ms: i64,
    /// Toleranz, innerhalb der die Marke als getroffen gilt (ms).
    pub tolerance_ms: i64,
}

impl Default for Params {
    fn default() -> Self {
        Params { max_shift_ms: 8000, tolerance_ms: 20 }
    }
}

#[derive(Debug)]
pub struct Fit {
    pub items: Vec<Item>,
    /// Index der Marken-Stelle im neuen Ablauf (kann sich durch Weglassen/Einfügen ändern).
    pub fix_index: usize,
    /// Verbleibende Abweichung nach allen Maßnahmen: > 0 = Marke wird zu spät erreicht, < 0 = zu früh (Lücke).
    pub residual_ms: i64,
    pub decisions: Vec<String>,
}

fn start_of(items: &[Item], idx: usize, start_ms: i64, cfg: &Config) -> Result<i64, String> {
    Ok(segue::plan(items, start_ms, cfg)?[idx].start_ms)
}

fn outro(it: &Item, cfg: &Config) -> i64 {
    it.outro_ms.unwrap_or(it.duration_ms - cfg.default_outro_ms).clamp(it.som_ms, it.duration_ms)
}

/// `items[fix_index]` soll bei `fix_at_ms` (ms ab Logstart) einsetzen. `fillers` sind Kandidaten zum Auffüllen (werden bei Bedarf eingefügt).
pub fn fit(items: &[Item], fix_index: usize, fix_at_ms: i64, start_ms: i64, fillers: &[Item], cfg: &Config, p: &Params) -> Result<Fit, String> {
    if fix_index >= items.len() {
        return Err("Marken-Index außerhalb des Logs".to_string());
    }
    let mut cur: Vec<Item> = items.to_vec();
    let mut fi = fix_index;
    let mut notes: Vec<String> = Vec::new();
    let dev = |cur: &[Item], fi: usize| -> Result<i64, String> { Ok(start_of(cur, fi, start_ms, cfg)? - fix_at_ms) };
    let mut d = dev(&cur, fi)?;

    if d > p.tolerance_ms {
        // zu spät: Füllkandidaten vor der Marke weglassen, spätester zuerst
        while d > p.tolerance_ms {
            let Some(pos) = (0..fi).rev().find(|&i| cur[i].optional) else { break };
            let gone = cur.remove(pos);
            fi -= 1;
            d = dev(&cur, fi)?;
            notes.push(format!("„{}“ weggelassen (Füllkandidat), Abweichung jetzt {d} ms", gone.id));
        }
        // dann Segue-Punkte der Titel vor der Marke vorziehen, nächster zur Marke zuerst
        let mut i = fi;
        while d > p.tolerance_ms && i > 0 {
            i -= 1;
            if cur[i].kind != Kind::Song || i + 1 > fi {
                continue;
            }
            let o = outro(&cur[i], cfg);
            let room = (o - cur[i].som_ms - 1000).max(0); // mindestens 1 s Titel spielen
            let shift = d.min(p.max_shift_ms).min(room);
            if shift > 0 {
                cur[i].outro_ms = Some(o - shift);
                d = dev(&cur, fi)?;
                notes.push(format!("Segue-Punkt von „{}“ um {shift} ms vorgezogen, Abweichung jetzt {d} ms", cur[i].id));
            }
        }
    } else if d < -p.tolerance_ms {
        // zu früh: Lücke mit Kandidaten füllen (größter, der noch passt), dann Segue-Punkte nach hinten schieben
        let mut pool: Vec<Item> = fillers.to_vec();
        loop {
            let gap = -d;
            if gap <= p.tolerance_ms {
                break;
            }
            let Some(best) = pool.iter().enumerate().filter(|(_, f)| f.duration_ms - f.som_ms <= gap + p.max_shift_ms).max_by_key(|(_, f)| f.duration_ms - f.som_ms).map(|(k, _)| k) else { break };
            let f = pool.remove(best);
            let id = f.id.clone();
            cur.insert(fi, f);
            fi += 1;
            d = dev(&cur, fi)?;
            notes.push(format!("„{id}“ eingefügt (Füller), Abweichung jetzt {d} ms"));
            if d > p.tolerance_ms {
                break; // überschossen: unten wieder zurückziehen
            }
        }
        if d > p.tolerance_ms {
            // der Füller war etwas zu lang: Segue-Punkt davor vorziehen
            let mut i = fi;
            while d > p.tolerance_ms && i > 0 {
                i -= 1;
                if cur[i].kind != Kind::Song {
                    continue;
                }
                let o = outro(&cur[i], cfg);
                let shift = d.min(p.max_shift_ms).min((o - cur[i].som_ms - 1000).max(0));
                if shift > 0 {
                    cur[i].outro_ms = Some(o - shift);
                    d = dev(&cur, fi)?;
                    notes.push(format!("Segue-Punkt von „{}“ um {shift} ms vorgezogen, Abweichung jetzt {d} ms", cur[i].id));
                }
            }
        } else {
            let mut i = fi;
            while d < -p.tolerance_ms && i > 0 {
                i -= 1;
                if cur[i].kind != Kind::Song {
                    continue;
                }
                let o = outro(&cur[i], cfg);
                let room = (cur[i].duration_ms - o - cfg.crossfade_ms).max(0); // Ausklang bleibt für die Kreuzblende
                let shift = (-d).min(p.max_shift_ms).min(room);
                if shift > 0 {
                    cur[i].outro_ms = Some(o + shift);
                    d = dev(&cur, fi)?;
                    notes.push(format!("Segue-Punkt von „{}“ um {shift} ms nach hinten gelegt, Abweichung jetzt {d} ms", cur[i].id));
                }
            }
        }
    }
    if d.abs() > p.tolerance_ms {
        notes.push(format!("Marke nicht exakt erreichbar: Rest {d} ms"));
    }
    Ok(Fit { items: cur, fix_index: fi, residual_ms: d, decisions: notes })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: &str, dur: i64, outro: i64) -> Item {
        Item { id: id.into(), kind: Kind::Song, duration_ms: dur, som_ms: 0, intro_ms: None, outro_ms: Some(outro), gain_db: 0.0, optional: false, transition: Default::default() }
    }
    fn news() -> Item {
        Item { id: "news".into(), kind: Kind::Speech, duration_ms: 120_000, som_ms: 0, intro_ms: None, outro_ms: None, gain_db: 0.0, optional: false, transition: Default::default() }
    }
    fn cfg() -> Config {
        Config::default()
    }

    // a: Segue bei 180 s, b: Segue bei 170 s → news startet bei 350 s
    fn base() -> Vec<Item> {
        vec![song("a", 190_000, 180_000), song("b", 180_000, 170_000), news()]
    }

    #[test]
    fn on_time_changes_nothing() {
        let f = fit(&base(), 2, 350_000, 0, &[], &cfg(), &Params::default()).unwrap();
        assert_eq!(f.residual_ms, 0);
        assert!(f.decisions.is_empty());
    }

    #[test]
    fn late_drops_optional_item_first() {
        let mut items = base();
        let mut x = song("x", 100_000, 95_000);
        x.optional = true;
        items.insert(1, x);
        // mit x: news bei 350 + 95 s; Marke bei 350 s → x muss weg
        let f = fit(&items, 3, 350_000, 0, &[], &cfg(), &Params::default()).unwrap();
        assert_eq!(f.items.len(), 3);
        assert_eq!(f.fix_index, 2);
        assert_eq!(f.residual_ms, 0);
        assert!(f.decisions[0].contains("weggelassen"));
    }

    #[test]
    fn late_pulls_segue_points_forward_within_limit() {
        // Marke 5 s früher: b's Segue 5 s vorziehen
        let f = fit(&base(), 2, 345_000, 0, &[], &cfg(), &Params::default()).unwrap();
        assert_eq!(f.residual_ms, 0);
        assert_eq!(f.items[1].outro_ms, Some(165_000));
        assert!(f.decisions.iter().any(|d| d.contains("vorgezogen")));
    }

    #[test]
    fn late_beyond_limits_reports_residual() {
        let p = Params { max_shift_ms: 3000, tolerance_ms: 20 };
        // 20 s zu spät, je Titel höchstens 3 s → 6 s erreichbar, Rest 14 s
        let f = fit(&base(), 2, 330_000, 0, &[], &cfg(), &p).unwrap();
        assert_eq!(f.residual_ms, 14_000);
        assert!(f.decisions.last().unwrap().contains("nicht exakt"));
    }

    #[test]
    fn early_inserts_filler_then_shifts_segue() {
        let filler = Item { id: "jingle".into(), kind: Kind::Speech, duration_ms: 20_000, som_ms: 0, intro_ms: None, outro_ms: None, gain_db: 0.0, optional: true, transition: Default::default() };
        // Marke 23 s später: 20-s-Füller einfügen, Rest 3 s über Segue-Punkt nach hinten
        let f = fit(&base(), 2, 373_000, 0, &[filler], &cfg(), &Params::default()).unwrap();
        assert_eq!(f.items.len(), 4);
        assert_eq!(f.fix_index, 3);
        assert_eq!(f.residual_ms, 0);
        assert!(f.decisions[0].contains("eingefügt"));
    }

    #[test]
    fn early_without_filler_shifts_segue_back() {
        let f = fit(&base(), 2, 355_000, 0, &[], &cfg(), &Params::default()).unwrap();
        assert_eq!(f.residual_ms, 0);
        assert_eq!(f.items[1].outro_ms, Some(175_000));
    }

    #[test]
    fn bad_index_is_rejected() {
        assert!(fit(&base(), 9, 0, 0, &[], &cfg(), &Params::default()).is_err());
    }
}
