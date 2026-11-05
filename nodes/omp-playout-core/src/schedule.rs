//! Kapitel 27 / P2a (`UMSETZUNG.md` §27): reine Planungslogik für die
//! Wanduhr-Timeline — kein HTTP, keine Uhr, kein State (wie `playlist.rs`/
//! `timeline.rs`), damit sie isoliert testbar bleibt.
//!
//! Alle Zeiten sind **UTC-Millisekunden** (Entscheidung E5). Eine
//! Operator-Eingabe mit Zeitzone (RFC 3339, z. B. `2026-10-02T10:00:00+02:00`)
//! wird beim Einlesen in einen absoluten Zeitpunkt umgerechnet; damit ist die
//! Planung DST-sicher, ohne dass der Node eine Zeitzonendatenbank braucht
//! (Spec §172). Die Channel-Zeitzone dient der Anzeige/Eingabe, nicht der
//! Rechnung.
//!
//! Modell: ein Item ist entweder **verankert** (`anchor_utc_ms`, harter
//! Startzeitpunkt wie bisher Fixtime) oder folgt dem Ende seines Vorgängers.
//! Daraus entstehen Warnungen (Spec §126), statt dass die Liste still
//! inkonsistent wird:
//!   - Überlappung: ein verankertes Item beginnt vor dem Ende des Vorgängers
//!     (der Vorgänger wird zur Startzeit hart abgelöst),
//!   - Lücke: ein verankertes Item beginnt nach dem Ende des Vorgängers,
//!   - unbestimmter Start: der Vorgänger ist endlos (Dauer 0) oder manuell.

use chrono::{DateTime, SecondsFormat, Utc};

/// RFC 3339 → UTC-Millisekunden; `None` bei ungültigem Format.
pub fn parse_start_at(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s.trim()).ok().map(|d| d.timestamp_millis())
}

/// UTC-Millisekunden → RFC 3339 (`…Z`, Millisekunden).
pub fn format_start_at(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanInput {
    pub id: String,
    /// 0 = endlos/unbekannt (Live, manuell beendet).
    pub duration_ms: u64,
    /// Harter Startzeitpunkt (UTC-ms), sonst folgt das Item dem Vorgänger.
    pub anchor_utc_ms: Option<i64>,
    /// `startType: manual` — Start nur durch den Operator, nie aus der Zeit.
    pub manual: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlannedEntry {
    pub id: String,
    pub index: usize,
    /// Geplanter Start (UTC-ms); `None`, wenn nicht bestimmbar.
    pub start_ms: Option<i64>,
    /// Geplantes Ende; `None` bei endlosem Item oder unbekanntem Start.
    pub end_ms: Option<i64>,
    pub anchored: bool,
    pub warnings: Vec<String>,
}

/// Plant `inputs` ab `base_ms` (Start des ersten, nicht verankerten Items).
pub fn plan(inputs: &[PlanInput], base_ms: i64) -> Vec<PlannedEntry> {
    let mut out: Vec<PlannedEntry> = Vec::with_capacity(inputs.len());
    // Ende des Vorgängers: Some(ms) = bekannt, None = unbestimmt.
    let mut prev_end: Option<i64> = Some(base_ms);
    let mut prev_open_reason: Option<&'static str> = None;

    for (index, item) in inputs.iter().enumerate() {
        let mut warnings = Vec::new();
        let start = if item.manual {
            // Manuell: Start nur durch den Operator — kein Zeitpunkt planbar.
            None
        } else if let Some(anchor) = item.anchor_utc_ms {
            match prev_end {
                Some(end) if index > 0 && anchor < end => {
                    warnings.push(format!(
                        "Überlappung: beginnt {} s vor dem Ende des Vorgängers (Vorgänger wird abgelöst)",
                        (end - anchor) / 1000
                    ));
                }
                Some(end) if index > 0 && anchor > end => {
                    warnings.push(format!("Lücke von {} s vor diesem Item", (anchor - end) / 1000));
                }
                _ => {}
            }
            Some(anchor)
        } else {
            if prev_end.is_none() {
                warnings.push(format!(
                    "Start unbestimmt: {}",
                    prev_open_reason.unwrap_or("Vorgänger ohne bekanntes Ende")
                ));
            }
            prev_end
        };

        let end = match (start, item.duration_ms) {
            (Some(s), d) if d > 0 => Some(s + d as i64),
            _ => None,
        };
        prev_open_reason = if item.manual {
            Some("vorheriges Item startet manuell")
        } else if item.duration_ms == 0 {
            Some("vorheriges Item ist endlos (Dauer 0)")
        } else {
            None
        };
        prev_end = end;
        out.push(PlannedEntry {
            id: item.id.clone(),
            index,
            start_ms: start,
            end_ms: end,
            anchored: item.anchor_utc_ms.is_some() && !item.manual,
            warnings,
        });
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ActionKind {
    /// Ende eines Items (vor allem anderen zur selben Zeit).
    End,
    /// Vorbereiten (Cue) — `preroll_ms` vor dem Take.
    Cue,
    /// Auf Sendung nehmen.
    Take,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedAction {
    pub at_ms: i64,
    pub kind: ActionKind,
    pub id: String,
}

/// Deterministische Aktions-Queue (Spec §232/§233): sortiert nach Zeit, bei
/// Gleichstand End < Cue < Take, danach nach Playlist-Position (stabil, kein
/// Zufall). Nur Items mit bestimmbarem Start erzeugen Aktionen.
pub fn event_queue(entries: &[PlannedEntry], preroll_ms: i64) -> Vec<QueuedAction> {
    let mut q = Vec::new();
    for e in entries {
        let Some(start) = e.start_ms else { continue };
        q.push((start - preroll_ms, ActionKind::Cue, e.index, e.id.clone()));
        q.push((start, ActionKind::Take, e.index, e.id.clone()));
        if let Some(end) = e.end_ms {
            q.push((end, ActionKind::End, e.index, e.id.clone()));
        }
    }
    q.sort_by_key(|a| (a.0, a.1, a.2));
    q.into_iter().map(|(at_ms, kind, _, id)| QueuedAction { at_ms, kind, id }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seq(id: &str, d: u64) -> PlanInput {
        PlanInput { id: id.to_string(), duration_ms: d, anchor_utc_ms: None, manual: false }
    }
    fn anchored(id: &str, d: u64, at: i64) -> PlanInput {
        PlanInput { id: id.to_string(), duration_ms: d, anchor_utc_ms: Some(at), manual: false }
    }

    #[test]
    fn rfc3339_with_offset_becomes_absolute_utc() {
        // 10:00 Wiener Sommerzeit (+02:00) == 08:00 UTC.
        let a = parse_start_at("2026-10-02T10:00:00+02:00").unwrap();
        let b = parse_start_at("2026-10-02T08:00:00Z").unwrap();
        assert_eq!(a, b);
        assert_eq!(format_start_at(a), "2026-10-02T08:00:00.000Z");
        assert!(parse_start_at("10:00:00").is_none());
        assert!(parse_start_at("2026-10-02 10:00").is_none());
    }

    #[test]
    fn dst_changeover_day_is_not_24_hours_of_local_time() {
        // Umstellung Europe/Vienna am 2026-10-25: 03:00 CEST → 02:00 CET.
        // 00:00 Ortszeit und 12:00 Ortszeit liegen daher 13 h auseinander —
        // mit absoluten Instants richtig, mit Sekunden-seit-Mitternacht falsch.
        let a = parse_start_at("2026-10-25T00:00:00+02:00").unwrap();
        let b = parse_start_at("2026-10-25T12:00:00+01:00").unwrap();
        assert_eq!(b - a, 13 * 3600 * 1000);
    }

    #[test]
    fn sequence_items_follow_each_other() {
        let p = plan(&[seq("a", 1000), seq("b", 2000), seq("c", 500)], 10_000);
        assert_eq!(p[0].start_ms, Some(10_000));
        assert_eq!(p[1].start_ms, Some(11_000));
        assert_eq!(p[2].start_ms, Some(13_000));
        assert_eq!(p[2].end_ms, Some(13_500));
        assert!(p.iter().all(|e| e.warnings.is_empty()));
    }

    #[test]
    fn anchored_item_before_predecessor_end_warns_about_overlap() {
        let p = plan(&[seq("a", 60_000), anchored("b", 10_000, 40_000)], 0);
        assert_eq!(p[1].start_ms, Some(40_000));
        assert!(p[1].warnings[0].contains("Überlappung"), "{:?}", p[1].warnings);
        assert!(p[1].warnings[0].contains("20 s"));
    }

    #[test]
    fn anchored_item_after_predecessor_end_warns_about_gap() {
        let p = plan(&[seq("a", 10_000), anchored("b", 5000, 25_000)], 0);
        assert!(p[1].warnings[0].contains("Lücke von 15 s"), "{:?}", p[1].warnings);
    }

    #[test]
    fn exact_fit_has_no_warning() {
        let p = plan(&[seq("a", 10_000), anchored("b", 5000, 10_000)], 0);
        assert!(p[1].warnings.is_empty());
    }

    #[test]
    fn item_after_endless_item_has_undetermined_start_until_anchored() {
        let p = plan(&[seq("live", 0), seq("next", 5000), anchored("fix", 5000, 100_000), seq("after", 1000)], 0);
        assert_eq!(p[1].start_ms, None);
        assert!(p[1].warnings[0].contains("endlos"), "{:?}", p[1].warnings);
        // Ein verankertes Item nach einem endlosen Vorgänger ist ein gewollter
        // harter Übergang — keine Überlappungs-/Lückenwarnung ohne bekanntes Ende.
        assert_eq!(p[2].start_ms, Some(100_000));
        assert!(p[2].warnings.is_empty());
        // Und danach ist die Kette wieder bestimmt.
        assert_eq!(p[3].start_ms, Some(105_000));
    }

    #[test]
    fn manual_item_has_no_planned_start_and_blocks_successor() {
        let manual = PlanInput { id: "m".into(), duration_ms: 5000, anchor_utc_ms: Some(1), manual: true };
        let p = plan(&[seq("a", 1000), manual, seq("b", 1000)], 0);
        assert_eq!(p[1].start_ms, None);
        assert!(!p[1].anchored, "manual wins over an anchor");
        assert_eq!(p[2].start_ms, None);
        assert!(p[2].warnings[0].contains("manuell"));
    }

    #[test]
    fn queue_is_ordered_and_end_precedes_take_at_the_same_instant() {
        let p = plan(&[seq("a", 10_000), seq("b", 5000)], 0);
        let q = event_queue(&p, 2000);
        let flat: Vec<(i64, ActionKind, &str)> = q.iter().map(|a| (a.at_ms, a.kind, a.id.as_str())).collect();
        assert_eq!(
            flat,
            vec![
                (-2000, ActionKind::Cue, "a"),
                (0, ActionKind::Take, "a"),
                (8000, ActionKind::Cue, "b"),
                // gleicher Zeitpunkt 10_000: erst das Ende von a, dann das Take von b
                (10_000, ActionKind::End, "a"),
                (10_000, ActionKind::Take, "b"),
                (15_000, ActionKind::End, "b"),
            ]
        );
    }

    #[test]
    fn queue_is_deterministic_for_simultaneous_actions() {
        // Zwei verankerte Items zur selben Zeit: Reihenfolge = Playlist-Position.
        let p = plan(&[anchored("x", 1000, 5000), anchored("y", 1000, 5000)], 0);
        let q1 = event_queue(&p, 0);
        let q2 = event_queue(&p, 0);
        assert_eq!(q1, q2);
        let takes: Vec<&str> = q1.iter().filter(|a| a.kind == ActionKind::Take).map(|a| a.id.as_str()).collect();
        assert_eq!(takes, ["x", "y"]);
    }

    #[test]
    fn items_without_start_create_no_actions() {
        let p = plan(&[seq("live", 0), seq("after", 1000)], 0);
        let q = event_queue(&p, 1000);
        assert!(q.iter().all(|a| a.id == "live"), "{q:?}");
    }
}
