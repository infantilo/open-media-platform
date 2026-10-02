//! As-Run-Protokoll des Automators (Kapitel 27 / P10, Spec §117–119, §192–193).
//!
//! Reine Zustandslogik ohne Netz: der Tracker hält das gerade laufende Primary Event offen,
//! schließt es mit Endstatus und Grund, sobald das nächste startet oder die Sendung endet, und
//! sammelt die Zeilen in einem begrenzten Ausgang. Ein Hintergrund-Task liefert den Ausgang an den
//! Orchestrator (mindestens einmal, idempotent über den Schlüssel `key`; eine Zeile wird beim Start
//! als RUNNING und beim Ende mit demselben Schlüssel überschrieben).

use serde::Serialize;
use std::collections::{HashMap, VecDeque};

/// Höchstens so viele ungesendete Zeilen werden gehalten (Orchestrator lange weg → älteste fallen weg, gezählt).
pub const OUTBOX_MAX: usize = 4000;

/// Dieselbe Warnung (Art + Event) höchstens alle 30 s protokollieren.
const WARN_THROTTLE_MS: i64 = 30_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AsRunRecord {
    pub key: String,
    pub kind: &'static str,
    #[serde(rename = "recordedAt")]
    pub recorded_at: String,
    #[serde(rename = "eventId", skip_serializing_if = "String::is_empty")]
    pub event_id: String,
    #[serde(rename = "childId", skip_serializing_if = "String::is_empty")]
    pub child_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub asset: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub source: String,
    #[serde(rename = "plannedStart", skip_serializing_if = "Option::is_none")]
    pub planned_start: Option<String>,
    #[serde(rename = "actualStart", skip_serializing_if = "Option::is_none")]
    pub actual_start: Option<String>,
    #[serde(rename = "plannedDurationMs", skip_serializing_if = "Option::is_none")]
    pub planned_duration_ms: Option<u64>,
    #[serde(rename = "actualEnd", skip_serializing_if = "Option::is_none")]
    pub actual_end: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub status: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reason: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub mode: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub action: String,
    #[serde(rename = "correlationId", skip_serializing_if = "String::is_empty")]
    pub correlation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

fn iso(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

impl AsRunRecord {
    fn blank(key: String, kind: &'static str, now_ms: i64) -> Self {
        AsRunRecord {
            key,
            kind,
            recorded_at: iso(now_ms),
            event_id: String::new(),
            child_id: String::new(),
            label: String::new(),
            asset: String::new(),
            source: String::new(),
            planned_start: None,
            actual_start: None,
            planned_duration_ms: None,
            actual_end: None,
            status: String::new(),
            reason: String::new(),
            mode: String::new(),
            action: String::new(),
            correlation_id: String::new(),
            detail: None,
        }
    }
}

/// Angaben zum startenden Primary Event.
#[derive(Debug, Clone, Default)]
pub struct StartInfo {
    pub event_id: String,
    pub label: String,
    pub asset: String,
    pub source: String,
    /// Fest hinterlegte Startzeit (Fixzeit/absolut), UTC-Millisekunden.
    pub anchored_start_ms: Option<i64>,
    /// `None` = endlos (Live) bzw. Steuer-Event.
    pub duration_ms: Option<u64>,
    pub mode: String,
}

#[derive(Debug, Clone)]
struct OpenRun {
    rec: AsRunRecord,
    start_ms: i64,
}

#[derive(Debug, Default)]
pub struct AsRunTracker {
    seq: u64,
    open: Option<OpenRun>,
    outbox: VecDeque<AsRunRecord>,
    dropped: u64,
    /// Geplantes Ende des vorigen Events: geplanter Start des nächsten, das ihm in der Sequenz folgt.
    prev_planned_end_ms: Option<i64>,
    /// Wodurch das nächste Event startet („take“, „auto“, „next“, …) — setzt der Aufrufer vor dem Start.
    pub cause: &'static str,
    /// Letzte Warnung je (Art, Event) — wiederholte Warnungen derselben Ursache werden gedrosselt.
    last_warn: HashMap<(String, String), i64>,
}

impl AsRunTracker {
    fn push(&mut self, rec: AsRunRecord) {
        if self.outbox.len() >= OUTBOX_MAX {
            self.outbox.pop_front();
            self.dropped += 1;
        }
        self.outbox.push_back(rec);
    }

    /// Anzahl der wegen eines vollen Ausgangs verworfenen Zeilen (Sichtbarkeit, nie still).
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    pub fn pending(&self) -> usize {
        self.outbox.len()
    }

    pub fn open_event_id(&self) -> Option<&str> {
        self.open.as_ref().map(|o| o.rec.event_id.as_str())
    }

    pub fn open_key(&self) -> Option<&str> {
        self.open.as_ref().map(|o| o.rec.key.as_str())
    }

    /// Ein Primary Event beginnt: das vorige wird beendet (Auto-Advance = COMPLETED, sonst INTERRUPTED).
    pub fn start(&mut self, now_ms: i64, info: StartInfo) {
        let cause = if self.cause.is_empty() { "take" } else { self.cause };
        let natural = matches!(cause, "auto");
        self.end(now_ms, if natural { "COMPLETED" } else { "INTERRUPTED" }, &format!("abgelöst durch {cause}"));
        self.seq += 1;
        let planned = info.anchored_start_ms.or(if natural { self.prev_planned_end_ms } else { None });
        let mut rec = AsRunRecord::blank(format!("p:{}:{}", self.seq, info.event_id), "primary", now_ms);
        rec.event_id = info.event_id;
        rec.label = info.label;
        rec.asset = info.asset;
        rec.source = info.source;
        rec.planned_start = planned.map(iso);
        rec.actual_start = Some(iso(now_ms));
        rec.planned_duration_ms = info.duration_ms;
        rec.status = "RUNNING".to_string();
        rec.reason = cause.to_string();
        rec.mode = info.mode;
        self.prev_planned_end_ms = match (planned, info.duration_ms) {
            (Some(p), Some(d)) => Some(p + d as i64),
            _ => None,
        };
        self.push(rec.clone());
        self.open = Some(OpenRun { rec, start_ms: now_ms });
        self.cause = "";
    }

    /// Beendet das offene Primary Event (kein offenes → nichts).
    pub fn end(&mut self, now_ms: i64, status: &str, reason: &str) {
        let Some(mut run) = self.open.take() else { return };
        run.rec.status = status.to_string();
        run.rec.reason = reason.to_string();
        run.rec.actual_end = Some(iso(now_ms.max(run.start_ms)));
        run.rec.recorded_at = iso(now_ms);
        self.push(run.rec);
        if status != "COMPLETED" {
            self.prev_planned_end_ms = None;
        }
    }

    /// Zustandswechsel eines Child Events (nur Fired/Completed/Failed/Cancelled sind Protokollwürdig).
    pub fn child(&mut self, now_ms: i64, event_id: &str, child_id: &str, label: &str, status: &str, reason: &str) {
        let run_key = self.open.as_ref().map(|o| o.rec.key.clone()).unwrap_or_else(|| format!("p:0:{event_id}"));
        let mut rec = AsRunRecord::blank(format!("c:{run_key}:{child_id}"), "child", now_ms);
        rec.event_id = event_id.to_string();
        rec.child_id = child_id.to_string();
        rec.label = label.to_string();
        rec.status = status.to_string();
        rec.reason = reason.to_string();
        rec.correlation_id = run_key;
        // Startzeit bei der ersten Meldung festhalten; spätere Zeilen desselben Schlüssels überschreiben nur Status/Ende.
        match status {
            "FIRED" | "ACTIVE" => rec.actual_start = Some(iso(now_ms)),
            _ => rec.actual_end = Some(iso(now_ms)),
        }
        self.push(rec);
    }

    /// Warnung (Quell-/Audio-Auflösung, Preflight): `action` ist der Metrik-Schlüssel.
    pub fn warning(&mut self, now_ms: i64, action: &str, event_id: &str, label: &str, detail: &str) {
        let k = (action.to_string(), event_id.to_string());
        if self.last_warn.get(&k).is_some_and(|t| now_ms - t < WARN_THROTTLE_MS) {
            return;
        }
        if self.last_warn.len() > 500 {
            self.last_warn.clear();
        }
        self.last_warn.insert(k, now_ms);
        self.seq += 1;
        let mut rec = AsRunRecord::blank(format!("w:{}:{action}:{event_id}", self.seq), "warning", now_ms);
        rec.event_id = event_id.to_string();
        rec.label = label.to_string();
        rec.action = action.to_string();
        rec.reason = detail.to_string();
        rec.status = "WARNING".to_string();
        self.push(rec);
    }

    /// Channel-Trigger (eingehend/ausgehend) mit Korrelations-ID (§193).
    pub fn trigger(&mut self, now_ms: i64, id: &str, correlation_id: &str, direction: &str, event: &str, status: &str, detail: &str) {
        let mut rec = AsRunRecord::blank(format!("t:{direction}:{id}"), "trigger", now_ms);
        rec.event_id = event.to_string();
        rec.action = format!("{direction} {event}");
        rec.status = status.to_string();
        rec.reason = detail.to_string();
        rec.correlation_id = correlation_id.to_string();
        self.push(rec);
    }

    /// Entnimmt bis zu `max` Zeilen zum Senden.
    pub fn drain(&mut self, max: usize) -> Vec<AsRunRecord> {
        let n = max.min(self.outbox.len());
        self.outbox.drain(..n).collect()
    }

    /// Lieferung fehlgeschlagen: Zeilen in ursprünglicher Reihenfolge vorne wieder einreihen.
    pub fn requeue(&mut self, recs: Vec<AsRunRecord>) {
        for r in recs.into_iter().rev() {
            if self.outbox.len() >= OUTBOX_MAX {
                self.dropped += 1;
                continue;
            }
            self.outbox.push_front(r);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: &str, anchored: Option<i64>, dur: Option<u64>) -> StartInfo {
        StartInfo { event_id: id.to_string(), label: id.to_uppercase(), anchored_start_ms: anchored, duration_ms: dur, mode: "auto".into(), ..Default::default() }
    }

    #[test]
    fn start_writes_running_and_the_next_start_completes_the_previous_one_in_auto() {
        let mut t = AsRunTracker::default();
        t.cause = "take";
        t.start(1_000, info("a", None, Some(5000)));
        t.cause = "auto";
        t.start(6_000, info("b", None, Some(5000)));
        let recs = t.drain(10);
        assert_eq!(recs.len(), 3);
        assert_eq!(recs[0].status, "RUNNING");
        assert_eq!((recs[1].key.as_str(), recs[1].status.as_str()), (recs[0].key.as_str(), "COMPLETED"));
        assert!(recs[1].actual_end.is_some());
        assert_eq!(recs[2].event_id, "b");
        // Auto-Folge: geplanter Start = geplantes Ende des Vorgängers (a hatte keinen Plan → keiner)
        assert_eq!(recs[2].planned_start, None);
    }

    #[test]
    fn sequence_after_a_planned_event_inherits_its_planned_end() {
        let mut t = AsRunTracker::default();
        t.cause = "take";
        t.start(10_000, info("a", Some(9_000), Some(4000)));
        t.cause = "auto";
        t.start(14_100, info("b", None, Some(1000)));
        let recs = t.drain(10);
        let b = recs.last().unwrap();
        assert_eq!(b.planned_start.as_deref(), Some(iso(13_000).as_str()), "geplant = 9 s + 4 s");
        assert_eq!(b.actual_start.as_deref(), Some(iso(14_100).as_str()));
    }

    #[test]
    fn manual_replacement_is_an_interruption_and_breaks_the_plan_chain() {
        let mut t = AsRunTracker::default();
        t.cause = "take";
        t.start(0, info("a", Some(0), Some(4000)));
        t.cause = "next";
        t.start(1_000, info("b", None, Some(1000)));
        t.cause = "auto";
        t.start(2_000, info("c", None, None));
        let recs = t.drain(10);
        assert_eq!(recs[1].status, "INTERRUPTED");
        assert!(recs[1].reason.contains("next"));
        assert_eq!(recs.last().unwrap().planned_start, None, "nach einem Eingriff gibt es keinen Plan-Anschluss");
    }

    #[test]
    fn end_without_open_run_is_a_noop_and_stop_records_the_reason() {
        let mut t = AsRunTracker::default();
        t.end(1, "STOPPED", "x");
        assert_eq!(t.pending(), 0);
        t.start(10, info("a", None, None));
        t.end(20, "STOPPED", "Operator-Stopp");
        let recs = t.drain(10);
        assert_eq!(recs[1].status, "STOPPED");
        assert_eq!(recs[1].reason, "Operator-Stopp");
        assert!(t.open_event_id().is_none());
    }

    #[test]
    fn child_rows_hang_on_the_running_primary() {
        let mut t = AsRunTracker::default();
        t.start(0, info("a", None, None));
        let key = t.open_key().unwrap().to_string();
        t.child(5, "a", "c1", "Logo", "FIRED", "");
        t.child(9, "a", "c1", "Logo", "FAILED", "Grafik-Node weg");
        let recs = t.drain(10);
        assert_eq!(recs[1].key, format!("c:{key}:c1"));
        assert_eq!(recs[1].correlation_id, key);
        assert_eq!(recs[2].status, "FAILED");
        assert_eq!(recs[2].key, recs[1].key, "gleiche Zeile wird überschrieben");
    }

    #[test]
    fn requeue_keeps_order_and_the_outbox_is_bounded_and_counts_drops() {
        let mut t = AsRunTracker::default();
        for i in 0..3 {
            t.warning(i, "asset_preflight", &format!("e{i}"), "x", "zu spät");
        }
        t.warning(5, "asset_preflight", "e0", "x", "gedrosselt: gleiche Ursache binnen 30 s");
        let first = t.drain(2);
        t.requeue(first);
        let all = t.drain(10);
        assert_eq!(all.iter().map(|r| r.event_id.as_str()).collect::<Vec<_>>(), ["e0", "e1", "e2"]);
        for i in 0..(OUTBOX_MAX as i64 + 5) {
            t.warning(i * 60_000, "x", "e", "l", "d");
        }
        assert_eq!(t.pending(), OUTBOX_MAX);
        assert_eq!(t.dropped(), 5);
    }

    #[test]
    fn json_shape_matches_what_the_orchestrator_expects() {
        let mut t = AsRunTracker::default();
        t.start(0, info("a", Some(0), Some(1500)));
        let v = serde_json::to_value(&t.drain(1)[0]).unwrap();
        assert_eq!(v["kind"], "primary");
        assert_eq!(v["plannedDurationMs"], 1500);
        assert!(v.get("childId").is_none(), "leere Felder entfallen");
        assert!(v["plannedStart"].as_str().unwrap().ends_with('Z'));
    }
}
