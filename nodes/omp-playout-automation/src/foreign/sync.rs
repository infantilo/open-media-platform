//! Watchfolder-Mitlauf (Kern, `docs/ENTWURF-FREMDPLAYLIST-UND-DURCHLAUF.md` §2): neueste vollständige Datei finden,
//! gegen den bisherigen Stand abgleichen, Position und Veralterung bestimmen. Rein bis auf den Verzeichnisscan.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::map::PlanItem;
use super::{ForeignEvent, ForeignFormat, ForeignList, Kind};

/// Dateiname `Autosaved_<Kennung>_<hh-mm-ss-ff>_<dd-mm-yyyy>.<ext>` → (Kennung, Sortierschlüssel `yyyymmddhhmmssff`).
pub fn parse_name(name: &str) -> Option<(String, u64)> {
    let stem = name.rsplit_once('.').map(|x| x.0).unwrap_or(name);
    let mut it = stem.split('_');
    if it.next()? != "Autosaved" {
        return None;
    }
    let key = it.next()?.to_string();
    let t: Vec<u64> = it.next()?.split('-').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    let d: Vec<u64> = it.next()?.split('-').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    if t.len() != 4 || d.len() != 3 || it.next().is_some() {
        return None;
    }
    Some((key, (((d[2] * 100 + d[1]) * 100 + d[0]) * 100 + t[0]) * 1_000_000 + (t[1] * 100 + t[2]) * 100 + t[3]))
}

#[derive(Debug, Default, Serialize)]
pub struct ScanOutcome {
    /// Neueste vollständige Datei (Pfad, Bytes), falls neuer als `after`.
    #[serde(skip)]
    pub file: Option<(PathBuf, Vec<u8>, u64)>,
    /// Dateien, die gefunden, aber (noch) nicht brauchbar waren.
    pub rejected: Vec<String>,
    /// Anzahl passender Dateien.
    pub candidates: usize,
    /// Als unbrauchbar erkannte Dateien (Sortierschlüssel, Größe) — beim nächsten Durchlauf nicht erneut lesen.
    #[serde(skip)]
    pub bad: Vec<(u64, u64)>,
}

/// Sucht im Ordner die neueste passende Datei, die **fertig** ist: Änderungszeit mindestens `settle_ms` her,
/// Format meldet vollständig. Unbrauchbare neuere Dateien werden übersprungen (die nächst ältere gültige gewinnt),
/// niemals eine halbe Datei geladen. `after`: nur Dateien mit größerem Sortierschlüssel.
pub fn scan(
    dir: &Path,
    channel_key: &str,
    fmt: &dyn ForeignFormat,
    after: u64,
    settle_ms: u64,
    known_bad: &std::collections::HashMap<u64, u64>,
) -> std::io::Result<ScanOutcome> {
    let mut out = ScanOutcome::default();
    let mut found: Vec<(u64, PathBuf)> = Vec::new();
    for ent in std::fs::read_dir(dir)? {
        let ent = ent?;
        let name = ent.file_name().to_string_lossy().to_string();
        let Some((key, order)) = parse_name(&name) else { continue };
        if (!channel_key.is_empty() && key != channel_key) || order <= after {
            continue;
        }
        found.push((order, ent.path()));
    }
    out.candidates = found.len();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    for (order, path) in found {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let settled = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|d| d.as_millis() as u64 >= settle_ms)
            .unwrap_or(false);
        if !settled {
            out.rejected.push(format!("{name}: wird noch geschrieben"));
            continue;
        }
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if known_bad.get(&order) == Some(&size) {
            out.rejected.push(format!("{name}: unvollständig oder fehlerhaft"));
            out.bad.push((order, size));
            continue;
        }
        match std::fs::read(&path) {
            Ok(b) if fmt.is_complete(&b) => {
                out.file = Some((path, b, order));
                return Ok(out);
            }
            Ok(_) => {
                out.rejected.push(format!("{name}: unvollständig oder fehlerhaft"));
                out.bad.push((order, size));
            }
            Err(e) => out.rejected.push(format!("{name}: {e}")),
        }
    }
    Ok(out)
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct Diff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
}

impl Diff {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.changed.is_empty()
    }
}

fn key(i: &PlanItem) -> String {
    i.reconcile_key.clone().filter(|k| !k.is_empty()).unwrap_or_else(|| format!("uid:{}", i.uid))
}

/// Abgleich über den Planungsschlüssel (sonst UID): neu, entfallen, inhaltlich geändert.
pub fn diff(old: &[PlanItem], new: &[PlanItem]) -> Diff {
    let mut d = Diff::default();
    let o: std::collections::HashMap<String, &PlanItem> = old.iter().map(|i| (key(i), i)).collect();
    let n: std::collections::HashMap<String, &PlanItem> = new.iter().map(|i| (key(i), i)).collect();
    for i in new {
        match o.get(&key(i)) {
            None => d.added.push(key(i)),
            Some(p) if p.append != i.append || p.patch != i.patch => d.changed.push(key(i)),
            _ => {}
        }
    }
    for i in old {
        if !n.contains_key(&key(i)) {
            d.removed.push(key(i));
        }
    }
    d
}

/// Welches Haupt-Event läuft jetzt? Zuerst der Fremdzustand `Running`, sonst nach Uhrzeit (letztes begonnenes Event,
/// dessen Ende noch nicht erreicht ist). `None`, wenn nichts passt.
pub fn on_air<'a>(list: &'a ForeignList, now_ms: i64) -> Option<&'a ForeignEvent> {
    let is_media = |e: &&ForeignEvent| matches!(e.kind, Kind::Clip | Kind::Live);
    let by_time = list
        .events
        .iter()
        .filter(is_media)
        .filter(|e| e.start_ms.is_some_and(|s| s <= now_ms) && e.end_ms.map(|en| en > now_ms).unwrap_or(true))
        .last();
    // Die Uhr schlägt den Zustand, sobald die Datei älter ist als das laufende Event (Datei hängt hinterher).
    let running = list.events.iter().filter(is_media).find(|e| e.state == "Running");
    match (by_time, running) {
        (Some(t), Some(r)) if t.uid != r.uid => Some(t),
        (_, Some(r)) => Some(r),
        (Some(t), None) => Some(t),
        _ => None,
    }
}

/// Alter der Liste in Millisekunden (Hausuhr der Datei gegen jetzt); negativ → 0.
pub fn age_ms(list: &ForeignList, now_ms: i64) -> Option<i64> {
    list.house_time_ms.map(|h| (now_ms - h).max(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::foreign::mpl3::Mpl3;
    use crate::foreign::{map, ParseCtx};

    const MINI: &str = include_str!("fixtures/mini.mpl");

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("omp-foreign-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn dateiname() {
        let (k, o) = parse_name("Autosaved_5002_08-31-46-11_28-10-2026.mpl").unwrap();
        assert_eq!(k, "5002");
        let (_, spaeter) = parse_name("Autosaved_5002_08-31-46-12_28-10-2026.mpl").unwrap();
        let (_, naechster_tag) = parse_name("Autosaved_5002_00-00-00-00_29-10-2026.mpl").unwrap();
        let (_, vorjahr) = parse_name("Autosaved_5002_23-59-59-24_31-12-2025.mpl").unwrap();
        assert!(o < spaeter && spaeter < naechster_tag && vorjahr < o);
        assert!(parse_name("anderes.mpl").is_none() && parse_name("Autosaved_x_1-2-3_4-5-6.mpl").is_none());
    }

    #[test]
    fn scan_nimmt_neueste_vollstaendige() {
        let d = tmp("scan");
        let w = |n: &str, b: &[u8]| std::fs::write(d.join(n), b).unwrap();
        w("Autosaved_5000_08-00-00-00_28-10-2026.mpl", MINI.as_bytes());
        w("Autosaved_5000_09-00-00-00_28-10-2026.mpl", &MINI.as_bytes()[..MINI.len() / 2]); // neuer, aber halb
        w("Autosaved_5001_10-00-00-00_28-10-2026.mpl", MINI.as_bytes()); // anderer Kanal
        w("notiz.txt", b"x");
        let o = scan(&d, "5000", &Mpl3, 0, 0, &Default::default()).unwrap();
        assert_eq!(o.candidates, 2);
        let (p, _, order) = o.file.unwrap();
        assert!(p.to_string_lossy().contains("08-00-00-00"));
        assert_eq!(o.rejected.len(), 1);
        // Nichts Neueres als `order` → nichts zu tun.
        assert!(scan(&d, "5000", &Mpl3, order, 0, &Default::default()).unwrap().file.is_none());
        // Noch frisch geschrieben → nicht anfassen.
        let o = scan(&d, "5000", &Mpl3, 0, 3_600_000, &Default::default()).unwrap();
        assert!(o.file.is_none() && o.rejected.len() == 2);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn diff_und_position() {
        let l = Mpl3.parse(MINI.as_bytes(), &ParseCtx::default()).unwrap();
        let cfg = map::MapConfig::default();
        let a = map::plan(&l, &cfg).items;
        assert!(diff(&a, &a).is_empty());
        let mut l2 = l.clone();
        l2.events[1].title = "Geändert".into();
        l2.events.remove(2);
        let b = map::plan(&l2, &cfg).items;
        let d = diff(&a, &b);
        assert_eq!(d.changed, vec!["KEY-1"]);
        assert_eq!(d.removed, vec!["KEY-2"]);
        assert!(d.added.is_empty());
        // Position: Zustand Running.
        assert_eq!(on_air(&l, l.events[1].start_ms.unwrap() + 1000).unwrap().uid, "2");
        // Datei hängt hinterher: Uhr zeigt bereits das Live-Event.
        assert_eq!(on_air(&l, l.events[2].start_ms.unwrap() + 1000).unwrap().uid, "5");
        assert!(on_air(&l, 0).is_some()); // Running gewinnt, wenn die Uhr nichts findet
        assert_eq!(age_ms(&l, l.house_time_ms.unwrap() + 90_000), Some(90_000));
    }
}
