//! Kapitel 27 / P7: Channel-Trigger auf der Empfängerseite — REINE Logik (keine Uhr, kein NATS,
//! kein State), damit Zeit- und Late-Policy-Entscheidungen isoliert testbar bleiben. Die
//! Ausführung (Abo, Journal, Aktionen, Quittung) liegt in `main.rs`.
//!
//! Der Orchestrator vermittelt und autorisiert (Rechte-Regeln, Audit) und stellt per NATS auf
//! `omp.channel.<channelId>.trigger` zu; dieser Node dedupliziert über das Ausführungsjournal der
//! Domäne `playout`, entscheidet über Zeitpunkt/Verspätung und quittiert beim Orchestrator.

use chrono::DateTime;
use serde::Deserialize;
use serde_json::Value;

/// Toleranz, bis zu der ein Trigger als „pünktlich“ gilt (Spec §85: möglichst präzise).
pub const ON_TIME_TOLERANCE_MS: i64 = 500;

/// Vom Orchestrator zugestellte Nachricht (`channeltrigger.Envelope`).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Envelope {
    pub id: String,
    #[serde(rename = "correlationId", default)]
    pub correlation_id: String,
    #[serde(rename = "originChannel", default)]
    pub origin_channel: String,
    #[serde(rename = "targetChannel", default)]
    pub target_channel: String,
    pub event: String,
    #[serde(default)]
    pub args: Value,
    #[serde(rename = "targetTime", default)]
    pub target_time: Option<String>,
    #[serde(rename = "relativeOffsetMs", default)]
    pub relative_offset_ms: i64,
    #[serde(rename = "latePolicy", default)]
    pub late_policy: String,
    #[serde(default)]
    pub seq: i64,
    #[serde(default)]
    pub attempt: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Next,
    NextLive,
    Jump,
    Cut,
    Hold,
    Resume,
    /// Benannter Trigger ohne eingebauten Handler.
    Custom,
}

impl Event {
    pub fn parse(s: &str) -> Option<Event> {
        Some(match s {
            "CHANNEL_NEXT" => Event::Next,
            "CHANNEL_NEXT_LIVE" => Event::NextLive,
            "CHANNEL_JUMP" => Event::Jump,
            "CHANNEL_CUT" => Event::Cut,
            "CHANNEL_HOLD" => Event::Hold,
            "CHANNEL_RESUME" => Event::Resume,
            "CHANNEL_TRIGGER" => Event::Custom,
            _ => return None,
        })
    }
}

/// Late-Policy (Spec §86).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LatePolicy {
    ExecuteImmediately,
    Skip,
    Resync,
    Queue,
}

impl LatePolicy {
    pub fn parse(s: &str) -> LatePolicy {
        match s {
            "SKIP" => LatePolicy::Skip,
            "RESYNC" => LatePolicy::Resync,
            "QUEUE" => LatePolicy::Queue,
            _ => LatePolicy::ExecuteImmediately,
        }
    }
}

/// Was mit dem Trigger geschieht.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Nach `wait_ms` ausführen (0 = sofort). `late_ms` > 0: verspätet ausgeführt (Policy hat entschieden).
    Execute { wait_ms: u64, late_ms: i64, resync: bool },
    /// Nicht ausführen (Policy SKIP bei Verspätung).
    Skip { late_ms: i64 },
    /// Falscher Ziel-Channel / unbekanntes Event / ungültige Zeit.
    Reject(String),
}

/// Effektive Zielzeit in UTC-ms (`targetTime` + `relativeOffsetMs`), `None` = sofort.
pub fn effective_target_ms(env: &Envelope) -> Result<Option<i64>, String> {
    match &env.target_time {
        None => Ok(None),
        Some(t) => {
            let ms = DateTime::parse_from_rfc3339(t)
                .map_err(|e| format!("targetTime ungültig: {e}"))?
                .timestamp_millis();
            Ok(Some(ms.saturating_add(env.relative_offset_ms)))
        }
    }
}

/// Entscheidet über den Trigger (Spec §85–87). `own_channel`: die Channel-ID dieses Nodes.
pub fn decide(env: &Envelope, own_channel: &str, now_ms: i64) -> Decision {
    if env.target_channel != own_channel {
        return Decision::Reject(format!("Trigger ist für Channel „{}“, dieser Node bedient „{own_channel}“", env.target_channel));
    }
    if Event::parse(&env.event).is_none() {
        return Decision::Reject(format!("unbekanntes Event „{}“", env.event));
    }
    let target = match effective_target_ms(env) {
        Ok(t) => t,
        Err(e) => return Decision::Reject(e),
    };
    let Some(target) = target else {
        return Decision::Execute { wait_ms: 0, late_ms: 0, resync: false };
    };
    let diff = target - now_ms;
    if diff > 0 {
        // Zukunft: alle Policies warten bis zum Zielzeitpunkt (Spec §85, millisekundengenau geplant).
        return Decision::Execute { wait_ms: diff as u64, late_ms: 0, resync: false };
    }
    let late = -diff;
    if late <= ON_TIME_TOLERANCE_MS {
        return Decision::Execute { wait_ms: 0, late_ms: 0, resync: false };
    }
    match LatePolicy::parse(&env.late_policy) {
        LatePolicy::Skip => Decision::Skip { late_ms: late },
        // RESYNC: ausführen UND den Versatz melden (der Operator sieht, wie weit dieser Channel danebenlag).
        LatePolicy::Resync => Decision::Execute { wait_ms: 0, late_ms: late, resync: true },
        // QUEUE: der serielle Trigger-Worker führt verspätete Trigger in Zustellreihenfolge aus.
        LatePolicy::Queue | LatePolicy::ExecuteImmediately => Decision::Execute { wait_ms: 0, late_ms: late, resync: false },
    }
}

/// Journal-Schlüssel für die Deduplizierung (at-most-once über Neustarts).
pub fn journal_key(env: &Envelope) -> String {
    format!("trigger:{}", env.id)
}

/// Item-ID aus `args.itemId` (JUMP).
pub fn jump_item(args: &Value) -> Option<&str> {
    args.get("itemId").and_then(Value::as_str).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(event: &str) -> Envelope {
        Envelope {
            id: "t1".into(), correlation_id: "c1".into(), origin_channel: "nat".into(), target_channel: "n".into(),
            event: event.into(), args: Value::Null, target_time: None, relative_offset_ms: 0, late_policy: String::new(), seq: 1, attempt: 1,
        }
    }

    const NOW: i64 = 1_790_000_000_000;

    fn at(ms: i64) -> Option<String> {
        Some(DateTime::from_timestamp_millis(ms).unwrap().to_rfc3339())
    }

    #[test]
    fn immediate_when_no_target_time() {
        assert_eq!(decide(&env("CHANNEL_NEXT"), "n", NOW), Decision::Execute { wait_ms: 0, late_ms: 0, resync: false });
    }

    #[test]
    fn rejects_foreign_channel_and_unknown_event_and_bad_time() {
        assert!(matches!(decide(&env("CHANNEL_NEXT"), "anderer", NOW), Decision::Reject(_)));
        assert!(matches!(decide(&env("CHANNEL_EXPLODE"), "n", NOW), Decision::Reject(_)));
        let mut e = env("CHANNEL_CUT");
        e.target_time = Some("gestern".into());
        assert!(matches!(decide(&e, "n", NOW), Decision::Reject(_)));
    }

    #[test]
    fn future_target_waits_until_then_for_every_policy() {
        for p in ["", "SKIP", "RESYNC", "QUEUE", "EXECUTE_IMMEDIATELY"] {
            let mut e = env("CHANNEL_CUT");
            e.target_time = at(NOW + 2_500);
            e.late_policy = p.into();
            assert_eq!(decide(&e, "n", NOW), Decision::Execute { wait_ms: 2_500, late_ms: 0, resync: false }, "Policy {p:?}");
        }
    }

    #[test]
    fn relative_offset_shifts_the_target_in_both_directions() {
        let mut e = env("CHANNEL_CUT");
        e.target_time = at(NOW + 1_000);
        e.relative_offset_ms = 1_500;
        assert_eq!(decide(&e, "n", NOW), Decision::Execute { wait_ms: 2_500, late_ms: 0, resync: false });
        e.relative_offset_ms = -1_000; // dieser Channel läuft 1 s voraus → sofort
        assert_eq!(decide(&e, "n", NOW), Decision::Execute { wait_ms: 0, late_ms: 0, resync: false });
    }

    #[test]
    fn within_tolerance_counts_as_on_time_even_with_skip() {
        let mut e = env("CHANNEL_CUT");
        e.late_policy = "SKIP".into();
        e.target_time = at(NOW - ON_TIME_TOLERANCE_MS);
        assert_eq!(decide(&e, "n", NOW), Decision::Execute { wait_ms: 0, late_ms: 0, resync: false });
    }

    #[test]
    fn late_handling_follows_the_policy() {
        let late = |p: &str| {
            let mut e = env("CHANNEL_NEXT_LIVE");
            e.late_policy = p.into();
            e.target_time = at(NOW - 4_000);
            decide(&e, "n", NOW)
        };
        assert_eq!(late("SKIP"), Decision::Skip { late_ms: 4_000 });
        assert_eq!(late("EXECUTE_IMMEDIATELY"), Decision::Execute { wait_ms: 0, late_ms: 4_000, resync: false });
        assert_eq!(late(""), Decision::Execute { wait_ms: 0, late_ms: 4_000, resync: false });
        assert_eq!(late("QUEUE"), Decision::Execute { wait_ms: 0, late_ms: 4_000, resync: false });
        assert_eq!(late("RESYNC"), Decision::Execute { wait_ms: 0, late_ms: 4_000, resync: true });
    }

    #[test]
    fn event_parsing_and_helpers() {
        assert_eq!(Event::parse("CHANNEL_HOLD"), Some(Event::Hold));
        assert_eq!(Event::parse("CHANNEL_TRIGGER"), Some(Event::Custom));
        assert_eq!(Event::parse("HOLD"), None, "der Orchestrator normalisiert auf CHANNEL_*");
        assert_eq!(journal_key(&env("CHANNEL_NEXT")), "trigger:t1");
        assert_eq!(jump_item(&serde_json::json!({"itemId": "x"})), Some("x"));
        assert_eq!(jump_item(&serde_json::json!({"itemId": ""})), None);
    }

    #[test]
    fn envelope_parses_the_orchestrator_json() {
        let json = r#"{"id":"a","correlationId":"c","originChannel":"nat","targetChannel":"n","event":"CHANNEL_JUMP",
            "args":{"itemId":"i7"},"targetTime":"2026-10-02T10:00:00Z","relativeOffsetMs":-250,"latePolicy":"SKIP","seq":3,
            "timestamp":"2026-10-02T09:59:59Z","attempt":2}"#;
        let e: Envelope = serde_json::from_str(json).unwrap();
        assert_eq!(e.target_channel, "n");
        assert_eq!(e.relative_offset_ms, -250);
        assert_eq!(effective_target_ms(&e).unwrap(), Some(DateTime::parse_from_rfc3339("2026-10-02T10:00:00Z").unwrap().timestamp_millis() - 250));
    }
}
