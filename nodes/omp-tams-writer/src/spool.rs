//! Warteschlange auf der Platte: Segmente, die geschlossen, aber noch nicht im Speicher registriert sind.
//!
//! Die Platte ist **gleichzeitig** der normale Weg und der Puffer bei Speicherausfall: der Segmentierer schreibt
//! `<flow>-<n>.ts` und danach `<flow>-<n>.json` (Metadaten, atomar per Umbenennen); der Uploader arbeitet nur Segmente
//! mit Metadaten ab. Dadurch überlebt die Warteschlange auch einen Neustart des Nodes. Die Live-Kette wird nie
//! blockiert: ist der Platz voll, werden die **ältesten** Segmente verworfen (Lücke in der Zeitachse, nie Überlappung)
//! und gemeldet.

use omp_tams::types::HttpRequest;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Von `POST …/storage` reservierter Platz (bleibt bei Wiederholungen erhalten).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SlotMeta {
    pub object_id: String,
    pub put_url: HttpRequest,
    /// Unix-Sekunden der Reservierung (der Dienst verwirft unbenutzte Objects nach `min_object_timeout`).
    pub reserved_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SegmentMeta {
    pub flow_id: String,
    /// Dateiname im Spool-Verzeichnis (ohne Pfad).
    pub file: String,
    /// TAI-Nanosekunden des ersten Samples (auf das Raster der Rate gelegt).
    pub start_ns: u64,
    /// TAI-Nanosekunden des ersten Samples **nach** dem Segment (exklusives Ende).
    pub end_ns: u64,
    pub key_frame_count: u32,
    pub size: u64,
    #[serde(default)]
    pub slot: Option<SlotMeta>,
    /// Fragmentiertes MP4 (Kapitel 105.3b): Dateiname des **Init-Segments** (`ftyp` + `moov`) im Spool-Verzeichnis. Die
    /// Segmentdatei enthält dann nur `moof`/`mdat`. `None` = MPEG-TS (ein in sich geschlossenes Object).
    #[serde(default)]
    pub init_file: Option<String>,
}

#[derive(Debug)]
pub struct Spool {
    dir: PathBuf,
    max_bytes: u64,
}

/// Was beim Begrenzen des Platzes verworfen wurde.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Dropped {
    pub segments: u32,
    pub bytes: u64,
    /// Zeitbereich (TAI-ns) der verworfenen Segmente: kleinster Anfang, größtes Ende.
    pub range_ns: Option<(u64, u64)>,
}

impl Spool {
    /// Öffnet (und legt an) das Verzeichnis; räumt verwaiste Dateien ohne Metadaten auf (Absturz beim Schreiben).
    pub fn open(dir: impl Into<PathBuf>, max_bytes: u64) -> io::Result<Spool> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        let s = Spool { dir, max_bytes };
        for e in fs::read_dir(&s.dir)? {
            let p = e?.path();
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
            match ext {
                "ts" | "mp4" | "m4s" if !p.with_extension("json").exists() => {
                    let _ = fs::remove_file(&p);
                }
                "tmp" => {
                    let _ = fs::remove_file(&p);
                }
                _ => {}
            }
        }
        Ok(s)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn file_path(&self, file: &str) -> PathBuf {
        self.dir.join(file)
    }

    fn meta_path(&self, file: &str) -> PathBuf {
        self.file_path(file).with_extension("json")
    }

    /// Segment in die Warteschlange stellen (Metadaten atomar schreiben).
    pub fn add(&self, meta: &SegmentMeta) -> io::Result<()> {
        self.write_meta(meta)
    }

    /// Metadaten (z. B. reservierten Platz) nachführen.
    pub fn update(&self, meta: &SegmentMeta) -> io::Result<()> {
        self.write_meta(meta)
    }

    fn write_meta(&self, meta: &SegmentMeta) -> io::Result<()> {
        let tmp = self.meta_path(&meta.file).with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec(meta).map_err(io::Error::other)?)?;
        fs::rename(&tmp, self.meta_path(&meta.file))
    }

    /// Segment und Metadaten löschen.
    pub fn remove(&self, meta: &SegmentMeta) {
        let _ = fs::remove_file(self.file_path(&meta.file));
        let _ = fs::remove_file(self.meta_path(&meta.file));
        // Das Init-Segment gehört mehreren Segmenten: erst mit dem letzten Verweis entfernen
        if let Some(init) = &meta.init_file
            && !self.pending().iter().any(|m| m.init_file.as_deref() == Some(init.as_str()))
        {
            let _ = fs::remove_file(self.file_path(init));
        }
    }

    /// Bekannte Flow-Beschreibungen (damit Segmente einer früheren Aufnahme auch nach einem Neustart angelegt werden können).
    pub fn load_flow_defs(&self) -> Vec<crate::uploader::FlowDef> {
        fs::read(self.dir.join("flows.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save_flow_defs(&self, defs: &[crate::uploader::FlowDef]) -> io::Result<()> {
        let tmp = self.dir.join("flows.tmp");
        fs::write(&tmp, serde_json::to_vec(defs).map_err(io::Error::other)?)?;
        fs::rename(&tmp, self.dir.join("flows.json"))
    }

    /// Alle wartenden Segmente, nach Flow und Anfang sortiert (unlesbare Metadaten werden übersprungen).
    pub fn pending(&self) -> Vec<SegmentMeta> {
        let mut v: Vec<SegmentMeta> = match fs::read_dir(&self.dir) {
            Ok(rd) => rd
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
                .filter_map(|p| serde_json::from_slice::<SegmentMeta>(&fs::read(p).ok()?).ok())
                .collect(),
            Err(_) => Vec::new(),
        };
        v.sort_by(|a, b| (a.flow_id.as_str(), a.start_ns).cmp(&(b.flow_id.as_str(), b.start_ns)));
        v
    }

    /// (Anzahl, Bytes) der wartenden Segmente.
    pub fn usage(&self) -> (u32, u64) {
        let p = self.pending();
        (p.len() as u32, p.iter().map(|m| m.size).sum())
    }

    /// Hält die Warteschlange unter dem Platzlimit, indem die **ältesten** Segmente (über alle Flows) verworfen werden.
    pub fn enforce_limit(&self) -> Dropped {
        let mut all = self.pending();
        let mut total: u64 = all.iter().map(|m| m.size).sum();
        let mut out = Dropped::default();
        all.sort_by_key(|m| m.start_ns);
        for m in all {
            if total <= self.max_bytes {
                break;
            }
            total = total.saturating_sub(m.size);
            self.remove(&m);
            out.segments += 1;
            out.bytes += m.size;
            out.range_ns = Some(match out.range_ns {
                None => (m.start_ns, m.end_ns),
                Some((a, b)) => (a.min(m.start_ns), b.max(m.end_ns)),
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("omp-spool-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn seg(flow: &str, n: u64, start: u64, size: u64) -> SegmentMeta {
        SegmentMeta { flow_id: flow.into(), file: format!("{flow}-{n:06}.ts"), start_ns: start, end_ns: start + 2_000_000_000, key_frame_count: 1, size, slot: None, init_file: None }
    }

    fn put(s: &Spool, m: &SegmentMeta) {
        fs::write(s.file_path(&m.file), vec![0u8; m.size as usize]).unwrap();
        s.add(m).unwrap();
    }

    #[test]
    fn pending_is_sorted_by_flow_then_time_and_survives_reopen() {
        let d = tmp("sort");
        let s = Spool::open(&d, 1 << 20).unwrap();
        put(&s, &seg("b", 2, 400, 10));
        put(&s, &seg("a", 1, 200, 10));
        put(&s, &seg("b", 1, 100, 10));
        let order: Vec<_> = s.pending().iter().map(|m| (m.flow_id.clone(), m.start_ns)).collect();
        assert_eq!(order, [("a".to_string(), 200), ("b".to_string(), 100), ("b".to_string(), 400)]);
        // Neustart: alles noch da
        let s2 = Spool::open(&d, 1 << 20).unwrap();
        assert_eq!(s2.pending().len(), 3);
        assert_eq!(s2.usage(), (3, 30));
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn orphans_without_metadata_are_cleaned_on_open() {
        let d = tmp("orphan");
        let s = Spool::open(&d, 1 << 20).unwrap();
        put(&s, &seg("a", 1, 100, 10));
        fs::write(d.join("a-000002.ts"), b"halb geschrieben").unwrap(); // Absturz vor den Metadaten
        fs::write(d.join("a-000003.tmp"), b"x").unwrap();
        let s2 = Spool::open(&d, 1 << 20).unwrap();
        assert_eq!(s2.pending().len(), 1);
        assert!(!d.join("a-000002.ts").exists() && !d.join("a-000003.tmp").exists());
        assert!(d.join("a-000001.ts").exists());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn limit_drops_the_oldest_across_flows_and_reports_the_gap() {
        let d = tmp("limit");
        let s = Spool::open(&d, 25).unwrap();
        put(&s, &seg("v", 1, 100, 10));
        put(&s, &seg("a", 1, 150, 10));
        put(&s, &seg("v", 2, 300, 10));
        assert_eq!(s.usage().1, 30);
        let dr = s.enforce_limit();
        assert_eq!(dr.segments, 1);
        assert_eq!(dr.bytes, 10);
        assert_eq!(dr.range_ns, Some((100, 100 + 2_000_000_000)));
        let left: Vec<_> = s.pending().iter().map(|m| m.start_ns).collect();
        assert_eq!(left, [150, 300]);
        assert!(!d.join("v-000001.ts").exists());
        // unter dem Limit passiert nichts
        assert_eq!(s.enforce_limit(), Dropped::default());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn update_keeps_the_reserved_slot() {
        let d = tmp("slot");
        let s = Spool::open(&d, 1 << 20).unwrap();
        let mut m = seg("a", 1, 100, 10);
        put(&s, &m);
        m.slot = Some(SlotMeta { object_id: "o1".into(), put_url: HttpRequest { url: "https://x/o1".into(), content_type: None, headers: Default::default() }, reserved_at: 42 });
        s.update(&m).unwrap();
        assert_eq!(Spool::open(&d, 1 << 20).unwrap().pending()[0].slot.as_ref().unwrap().object_id, "o1");
        s.remove(&m);
        assert!(s.pending().is_empty());
        fs::remove_dir_all(&d).ok();
    }
}
