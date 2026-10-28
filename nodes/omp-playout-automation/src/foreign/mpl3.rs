//! Adapter `mpl3`: XML-Sendeliste mit Wurzel `marinaPlaylist` (Version 3.x). Aufbau und Zeitmodell siehe
//! `docs/ENTWURF-FREMDPLAYLIST-UND-DURCHLAUF.md` §1. Zeitstempel `YYYY-MM-DDThh:mm:ss:ff` sind Hausuhr (UTC),
//! das letzte Feld sind Frames. Nur lesend; der Laufzeitzustand des Fremdsystems wird nicht übernommen.

use std::collections::BTreeMap;

use roxmltree::{Document, Node};

use super::{EndMode, Fps, ForeignEvent, ForeignFormat, ForeignList, Kind, ParseCtx, StartMode};

pub struct Mpl3;

const ROOT: &str = "marinaPlaylist";

impl ForeignFormat for Mpl3 {
    fn id(&self) -> &'static str {
        "mpl3"
    }

    fn label(&self) -> &'static str {
        "Sendeliste XML (mpl3)"
    }

    fn sniff(&self, head: &[u8]) -> bool {
        let h = String::from_utf8_lossy(&head[..head.len().min(512)]);
        h.contains(&format!("<{ROOT}"))
    }

    fn is_complete(&self, bytes: &[u8]) -> bool {
        // Schnelle Vorprüfung (Ende der Datei), erst dann der teure Volltest.
        let tail = &bytes[bytes.len().saturating_sub(64)..];
        if !String::from_utf8_lossy(tail).trim_end().ends_with(&format!("</{ROOT}>")) {
            return false;
        }
        match std::str::from_utf8(bytes).ok().and_then(|s| Document::parse(s).ok()) {
            Some(d) => d.root_element().has_tag_name(ROOT),
            None => false,
        }
    }

    fn parse(&self, bytes: &[u8], ctx: &ParseCtx) -> Result<ForeignList, String> {
        let text = std::str::from_utf8(bytes).map_err(|e| format!("kein UTF-8: {e}"))?;
        let doc = Document::parse(text).map_err(|e| format!("XML fehlerhaft: {e}"))?;
        let root = doc.root_element();
        if !root.has_tag_name(ROOT) {
            return Err(format!("Wurzel ist <{}>, erwartet <{ROOT}>", root.tag_name().name()));
        }
        let mut p = Parser { fps: ctx.fps, warnings: Vec::new() };
        let props = child(root, "properties");
        let channel = props.and_then(|n| child(n, "channel"));
        let status = props.and_then(|n| child(n, "status"));
        let tc = props.and_then(|n| child(n, "timecode"));
        let local_offset_ms = tc
            .and_then(|n| n.attribute("localTimeOffset"))
            .or_else(|| channel.and_then(|n| n.attribute("timeOffsetValue")))
            .and_then(|s| p.duration(s))
            .unwrap_or(0);
        let mut events = Vec::new();
        if let Some(list) = child(root, "eventList") {
            for e in list.children().filter(|n| n.has_tag_name("event")) {
                events.push(p.event(e, true));
            }
        }
        Ok(ForeignList {
            format: "mpl3".into(),
            channel: channel.and_then(|n| n.attribute("name")).unwrap_or("").to_string(),
            fps: ctx.fps,
            house_time_ms: tc.and_then(|n| n.attribute("houseTime")).and_then(|s| p.stamp(s)),
            local_offset_ms,
            list_state: status.and_then(|n| n.attribute("listState")).unwrap_or("").to_string(),
            focus_index: status.and_then(|n| n.attribute("focusIndex")).and_then(|s| s.parse().ok()),
            events,
            warnings: p.warnings,
        })
    }
}

struct Parser {
    fps: Fps,
    warnings: Vec<String>,
}

fn child<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    n.children().find(|c| c.has_tag_name(name))
}

fn attr(n: Option<Node>, name: &str) -> Option<String> {
    n.and_then(|n| n.attribute(name)).filter(|s| !s.is_empty()).map(|s| s.to_string())
}

impl Parser {
    /// `hh:mm:ss:ff` → ms.
    fn duration(&self, s: &str) -> Option<i64> {
        let v: Vec<&str> = s.trim().split(':').collect();
        if v.len() != 4 {
            return None;
        }
        let n: Vec<i64> = v.iter().map(|x| x.parse().ok()).collect::<Option<_>>()?;
        // Ganze Sekunden exakt, nur die Restframes laufen über die Bildrate.
        let secs = (n[0] * 60 + n[1]) * 60 + n[2];
        Some(secs * 1000 + self.fps.frames_to_ms(n[3]))
    }

    /// `YYYY-MM-DDThh:mm:ss:ff` → UTC ms. Der Null-Wert `2000-01-01…` gilt als „nicht gesetzt“.
    fn stamp(&self, s: &str) -> Option<i64> {
        let (d, t) = s.trim().split_once('T')?;
        let dv: Vec<i32> = d.split('-').map(|x| x.parse().ok()).collect::<Option<_>>()?;
        if dv.len() != 3 || dv[0] <= 2000 {
            return None;
        }
        let day = chrono::NaiveDate::from_ymd_opt(dv[0], dv[1] as u32, dv[2] as u32)?;
        let secs = day.and_hms_opt(0, 0, 0)?.and_utc().timestamp();
        Some(secs * 1000 + self.duration(t)?)
    }

    fn event(&mut self, e: Node, top: bool) -> ForeignEvent {
        let ty = e.attribute("type").unwrap_or("").to_string();
        let uid = e.attribute("uid").unwrap_or("").to_string();
        let props = child(e, "properties");
        let state = child(e, "state");
        let sched = props.and_then(|n| child(n, "schedule"));
        let ev = props.and_then(|n| child(n, "event"));
        let media = props.and_then(|n| child(n, "media"));
        let switch = props.and_then(|n| child(n, "switch"));
        let kind = match ty.as_str() {
            "PrimaryVideo" => Kind::Clip,
            "Live" => Kind::Live,
            "PlaylistStart" => Kind::BlockStart,
            "PlaylistEnd" => Kind::BlockEnd,
            "Comment" => Kind::Comment,
            t if !top => Kind::Child(t.to_string()),
            t => {
                self.warnings.push(format!("Event {uid}: unbekannter Typ „{t}“ in der Hauptliste"));
                Kind::Other(t.to_string())
            }
        };
        let start_mode = match sched.and_then(|n| n.attribute("startType")) {
            Some("Fixed") => StartMode::Fixed,
            Some("+ParentStart") => StartMode::ParentStart,
            Some("-ParentEnd") | Some("+ParentEnd") => StartMode::ParentEnd,
            Some("Sequential") | None => StartMode::Sequential,
            Some(o) => {
                self.warnings.push(format!("Event {uid}: unbekannter Starttyp „{o}“, als Sequential gelesen"));
                StartMode::Sequential
            }
        };
        let end_type = sched.and_then(|n| n.attribute("endType"));
        let end_mode = match end_type {
            Some("Duration") => EndMode::Duration,
            Some("Hold") => EndMode::Hold,
            Some("+ParentEnd") | Some("-ParentEnd") => EndMode::ParentEnd,
            _ => EndMode::None,
        };
        let end_off = sched.and_then(|n| n.attribute("endOffset")).and_then(|s| self.duration(s));
        let (duration_ms, end_offset_ms) = match end_mode {
            EndMode::Duration => (end_off, None),
            EndMode::ParentEnd => (None, end_off),
            _ => (None, None),
        };
        let mut meta = BTreeMap::new();
        if let Some(c) = ev.and_then(|n| child(n, "classifications")).and_then(|n| child(n, "classification")) {
            if let Some(v) = c.attribute("category") {
                meta.insert("category".to_string(), v.to_string());
            }
        }
        if let Some(h) = attr(ev, "houseId") {
            meta.insert("houseId".into(), h);
        }
        if let Some(b) = props.and_then(|n| child(n, "block")).and_then(|n| n.attribute("name")) {
            meta.insert("block".into(), b.to_string());
        }
        if let Some(a) = props.and_then(|n| child(n, "auxData")).and_then(|n| child(n, "payload")) {
            for f in a.children().filter(|n| n.has_tag_name("field")) {
                if let Some(name) = f.attribute("name") {
                    let v = child(f, "value").and_then(|v| v.text()).unwrap_or("").trim().to_string();
                    meta.insert(format!("aux.{name}"), v);
                }
            }
        }
        if let Some(cg) = props.and_then(|n| child(n, "mediaStream")).and_then(|n| child(n, "cg")) {
            for f in cg.children().filter(|n| n.has_tag_name("f")) {
                if let Some(name) = f.attribute("name") {
                    meta.insert(format!("cg.{name}"), f.text().unwrap_or("").to_string());
                }
            }
            if let Some(l) = cg.attribute("layer") {
                meta.insert("cg.layer".into(), l.to_string());
            }
        }
        if let Some(m) = props.and_then(|n| child(n, "audioMixer")) {
            if let Some(v) = m.attribute("preset") {
                meta.insert("audioMixer.preset".into(), v.to_string());
            }
        }
        if let Some(t) = media.and_then(|n| n.attribute("mediaType")) {
            meta.insert("mediaType".into(), t.to_string());
            if kind == Kind::Clip && t != "Video" {
                self.warnings.push(format!("Event {uid}: Medientyp „{t}“ als Datei gelesen"));
            }
        }
        let mut features = BTreeMap::new();
        if let Some(fs) = props.and_then(|n| child(n, "features")) {
            for f in fs.children().filter(|n| n.has_tag_name("feature")) {
                let Some(ft) = f.attribute("type") else { continue };
                let fp = child(f, "properties");
                let val = match ft {
                    "Loudness" => fp.and_then(|n| child(n, "genericPreset")).and_then(|n| child(n, "preset")).and_then(|n| n.attribute("name")),
                    "VPS" => fp.and_then(|n| child(n, "vps")).and_then(|n| n.attribute("dateTime")),
                    "Subtitle" => fp.and_then(|n| child(n, "media")).and_then(|n| n.attribute("mediaName")),
                    "AudioShuffle" => fp.and_then(|n| descendant(n, "trackPreset")).and_then(|n| n.attribute("name")),
                    "AFD" => fp.and_then(|n| child(n, "aspectRatio")).and_then(|n| n.attribute("type")),
                    _ => None,
                };
                features.insert(ft.to_string(), val.unwrap_or("").to_string());
            }
        }
        let logical = |tag: &str| {
            switch
                .and_then(|s| child(s, tag))
                .and_then(|s| child(s, "logical"))
                .and_then(|l| l.attribute("name"))
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        };
        let mut children = Vec::new();
        if let Some(ce) = child(e, "childEvents") {
            for c in ce.children().filter(|n| n.has_tag_name("event")) {
                children.push(self.event(c, false));
            }
        }
        let media_name = attr(media, "mediaName");
        if kind == Kind::Clip && media_name.is_none() {
            self.warnings.push(format!("Event {uid}: Datei-Event ohne Medienkennung"));
        }
        ForeignEvent {
            uid,
            reconcile_key: attr(ev, "reconcileKey"),
            kind,
            enabled: e.attribute("enabled") != Some("false"),
            title: ev.and_then(|n| n.attribute("title")).unwrap_or("").to_string(),
            comment: ev.and_then(|n| child(n, "comment")).and_then(|n| n.text()).map(|s| s.to_string()),
            media_name,
            som_ms: props
                .and_then(|n| child(n, "mediaStream"))
                .and_then(|n| n.attribute("som"))
                .filter(|s| *s != "$INHERIT$")
                .and_then(|s| self.duration(s)),
            source: logical("source"),
            backup_source: logical("backupSource"),
            start_mode,
            end_mode,
            start_ms: state.and_then(|n| n.attribute("schedStartTime")).and_then(|s| self.stamp(s)),
            end_ms: state.and_then(|n| n.attribute("schedEndTime")).and_then(|s| self.stamp(s)),
            duration_ms,
            end_offset_ms,
            transition: attr(switch, "transition"),
            transition_rate: attr(switch, "rate"),
            state: state.and_then(|n| n.attribute("state")).unwrap_or("").to_string(),
            features,
            meta,
            children,
        }
    }
}

fn descendant<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    n.descendants().find(|c| c.has_tag_name(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::foreign::{adapter, ForeignFormat};

    const MINI: &str = include_str!("fixtures/mini.mpl");

    fn parse(s: &str) -> ForeignList {
        Mpl3.parse(s.as_bytes(), &ParseCtx::default()).unwrap()
    }

    #[test]
    fn sniff_und_vollstaendigkeit() {
        assert!(Mpl3.sniff(MINI.as_bytes()));
        assert!(!Mpl3.sniff(b"<html></html>"));
        assert!(Mpl3.is_complete(MINI.as_bytes()));
        // Abgeschnitten (halb geschriebene Datei) → nie laden.
        assert!(!Mpl3.is_complete(&MINI.as_bytes()[..MINI.len() / 2]));
        // Ende stimmt, Mitte kaputt.
        let kaputt = MINI.replace("<eventList>", "<eventList><x>");
        assert!(!Mpl3.is_complete(kaputt.as_bytes()));
        assert!(adapter("mpl3").is_some() && adapter("nix").is_none());
    }

    #[test]
    fn zeiten_sind_frame_genau() {
        let p = Parser { fps: Fps::PAL, warnings: vec![] };
        let a = p.stamp("2026-10-28T08:31:03:00").unwrap();
        assert_eq!(p.stamp("2026-10-28T08:31:03:14").unwrap() - a, 560);
        assert_eq!(p.stamp("2026-10-28T08:31:04:00").unwrap() - a, 1000);
        assert_eq!(p.duration("00:23:24:14"), Some((23 * 60 + 24) * 1000 + 560));
        assert_eq!(p.stamp("2000-01-01T00:00:00:00"), None);
        assert_eq!(p.stamp("kaputt"), None);
        assert_eq!(Fps { num: 30000, den: 1001 }.frames_to_ms(30), 1001);
    }

    #[test]
    fn liste_und_kopf() {
        let l = parse(MINI);
        assert_eq!(l.channel, "TxX-A");
        assert_eq!(l.local_offset_ms, 3_600_000);
        assert_eq!(l.focus_index, Some(1));
        assert!(l.list_state.contains("OnAir"));
        assert_eq!(l.events.len(), 5);
        assert_eq!(l.count_all(), 7);
    }

    #[test]
    fn clip_live_marker_kommentar() {
        let l = parse(MINI);
        let clip = &l.events[1];
        assert_eq!(clip.kind, Kind::Clip);
        assert_eq!(clip.media_name.as_deref(), Some("MEDIA0001"));
        assert_eq!(clip.title, "Beispielsendung");
        assert_eq!(clip.reconcile_key.as_deref(), Some("KEY-1"));
        assert_eq!(clip.end_mode, EndMode::Duration);
        assert_eq!(clip.duration_ms, Some(60_000 + 560));
        assert_eq!(clip.som_ms, Some(36_000_000));
        assert_eq!(clip.start_ms.unwrap() % 1000, 560);
        assert_eq!(clip.transition.as_deref(), Some("Fade Cut"));
        assert_eq!(clip.features.get("Loudness").map(|s| s.as_str()), Some("LoudnessMild"));
        assert_eq!(clip.features.get("Subtitle").map(|s| s.as_str()), Some("10280930"));
        assert_eq!(clip.meta.get("aux.FeinplanId").map(|s| s.as_str()), Some("42"));
        assert_eq!(clip.state, "Running");
        let live = &l.events[2];
        assert_eq!(live.kind, Kind::Live);
        assert_eq!(live.source.as_deref(), Some("RP21"));
        assert_eq!(live.backup_source.as_deref(), Some("DMX21"));
        assert_eq!(live.end_mode, EndMode::Hold);
        assert_eq!(live.start_mode, StartMode::Fixed);
        assert_eq!(l.events[0].kind, Kind::BlockStart);
        assert_eq!(l.events[0].meta.get("block").map(|s| s.as_str()), Some("B1"));
        assert_eq!(l.events[3].kind, Kind::Comment);
        assert!(l.events[3].comment.as_deref().unwrap().contains("Validierungsproblem"));
        assert_eq!(l.events[3].start_ms, None);
        assert_eq!(l.events[4].kind, Kind::BlockEnd);
    }

    #[test]
    fn kinder() {
        let l = parse(MINI);
        let c = &l.events[1].children;
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].kind, Kind::Child("LogoHD".into()));
        assert_eq!(c[0].start_mode, StartMode::ParentStart);
        assert_eq!(c[0].end_mode, EndMode::ParentEnd);
        assert_eq!(c[0].media_name.as_deref(), Some("transparent_720"));
        assert_eq!(c[1].kind, Kind::Child("VIZ".into()));
        assert_eq!(c[1].meta.get("cg.Titel").map(|s| s.as_str()), Some("Ein Titel"));
        assert_eq!(c[1].end_offset_ms, Some(10_000));
    }

    #[test]
    fn unbekanntes_wird_gemeldet_nicht_verschluckt() {
        let l = parse(&MINI.replace("type=\"Comment\"", "type=\"Neu\""));
        assert!(l.warnings.iter().any(|w| w.contains("Neu")));
        assert!(matches!(l.events[3].kind, Kind::Other(_)));
        let l = parse(&MINI.replace("mediaName=\"MEDIA0001\"", "mediaName=\"\""));
        assert!(l.warnings.iter().any(|w| w.contains("Medienkennung")));
    }

    #[test]
    fn falsche_wurzel_ist_fehler() {
        assert!(Mpl3.parse(b"<a/>", &ParseCtx::default()).is_err());
        assert!(Mpl3.parse(b"<marinaPlaylist>", &ParseCtx::default()).is_err());
    }

    /// Echtdateien (nicht im Repo): `OMP_TEST_MPL=/pfad/a.mpl:/pfad/b.mpl cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn echtdateien() {
        let Ok(v) = std::env::var("OMP_TEST_MPL") else { return };
        for f in v.split(':') {
            let b = std::fs::read(f).unwrap();
            assert!(Mpl3.sniff(&b[..b.len().min(512)]) && Mpl3.is_complete(&b), "{f}");
            let t = std::time::Instant::now();
            let l = Mpl3.parse(&b, &ParseCtx::default()).unwrap();
            eprintln!("{f}: {} Events, {} Hauptliste, {} Warnungen, {:?}", l.count_all(), l.events.len(), l.warnings.len(), t.elapsed());
            for w in l.warnings.iter().take(5) {
                eprintln!("  warn: {w}");
            }
            assert!(l.events.len() > 100 && l.house_time_ms.is_some());
        }
    }
}
