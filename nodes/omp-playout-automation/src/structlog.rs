//! Strukturierte Log-Zeilen mit Korrelations-IDs (Kapitel 27 / P10, Spec §193):
//! JSON je Zeile auf stderr mit `channelId`, `eventId`, `childEventId`,
//! `sourceId`, `correlationId`, `triggerId` (leere Felder entfallen). Der
//! Orchestrator sammelt die Node-Ausgabe (`/api/v1/logs`), die Zeilen lassen
//! sich dort nach diesen IDs durchsuchen.

use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value};

static CHANNEL: OnceLock<Mutex<String>> = OnceLock::new();

/// Channel-ID dieser Instanz (wird beim Binden/Laden des Channels gesetzt).
pub fn set_channel(id: &str) {
    let m = CHANNEL.get_or_init(|| Mutex::new(String::new()));
    let mut g = m.lock().expect("lock poisoned");
    if g.as_str() != id {
        *g = id.to_string();
    }
}

fn channel() -> String {
    CHANNEL.get().map(|m| m.lock().expect("lock poisoned").clone()).unwrap_or_default()
}

#[derive(Debug, Default, Clone)]
pub struct Ids<'a> {
    pub event_id: &'a str,
    pub child_event_id: &'a str,
    pub source_id: &'a str,
    pub correlation_id: &'a str,
    pub trigger_id: &'a str,
}

/// Baut die JSON-Zeile (rein, testbar).
pub fn line(time: &str, level: &str, msg: &str, channel_id: &str, ids: &Ids) -> String {
    let mut m = Map::new();
    m.insert("time".into(), Value::from(time));
    m.insert("level".into(), Value::from(level));
    m.insert("component".into(), Value::from("omp-playout-automation"));
    m.insert("msg".into(), Value::from(msg));
    for (k, v) in [
        ("channelId", channel_id),
        ("eventId", ids.event_id),
        ("childEventId", ids.child_event_id),
        ("sourceId", ids.source_id),
        ("correlationId", ids.correlation_id),
        ("triggerId", ids.trigger_id),
    ] {
        if !v.is_empty() {
            m.insert(k.into(), Value::from(v));
        }
    }
    Value::Object(m).to_string()
}

pub fn emit(level: &str, msg: &str, ids: &Ids) {
    let t = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let l = line(&t, level, msg, &channel(), ids);
    eprintln!("{l}");
    // Optional zusätzlich in eine Datei (`OMP_PLAYOUT_LOG_FILE`, Node-Option):
    // der Orchestrator hält von Node-stderr nur die letzten Zeilen für
    // Absturzmeldungen, eine Datei ist daher die durchsuchbare Ablage.
    if let Ok(path) = std::env::var("OMP_PLAYOUT_LOG_FILE")
        && !path.trim().is_empty()
        && let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path.trim())
    {
        use std::io::Write;
        let _ = writeln!(f, "{l}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_contains_only_set_ids() {
        let l = line("2026-10-05T10:00:00.000Z", "INFO", "Event gestartet", "ch1", &Ids { event_id: "e1", source_id: "Remote X", ..Default::default() });
        let v: Value = serde_json::from_str(&l).unwrap();
        assert_eq!(v["channelId"], "ch1");
        assert_eq!(v["eventId"], "e1");
        assert_eq!(v["sourceId"], "Remote X");
        assert_eq!(v["msg"], "Event gestartet");
        assert!(v.get("childEventId").is_none() && v.get("triggerId").is_none() && v.get("correlationId").is_none());
    }

    #[test]
    fn emit_appends_json_lines_to_the_log_file_option() {
        let path = std::env::temp_dir().join(format!("omp-structlog-test-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&path);
        // SAFETY: einziger Test, der diese Variable setzt; Lesen nur in `emit`.
        unsafe { std::env::set_var("OMP_PLAYOUT_LOG_FILE", &path) };
        set_channel("chan-x");
        emit("INFO", "structlog-test A", &Ids { event_id: "e1", ..Default::default() });
        emit("WARN", "structlog-test B", &Ids { event_id: "e2", source_id: "Remote X", ..Default::default() });
        unsafe { std::env::remove_var("OMP_PLAYOUT_LOG_FILE") };
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        // Andere Tests (parallel) dürfen im selben Zeitfenster ebenfalls Zeilen
        // erzeugen — nur die eigenen auswerten.
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|v| v["msg"].as_str().is_some_and(|m| m.starts_with("structlog-test")))
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["channelId"], "chan-x");
        assert_eq!(lines[1]["level"], "WARN");
        assert_eq!(lines[1]["sourceId"], "Remote X");
    }

    #[test]
    fn line_escapes_and_stays_one_line() {
        let l = line("t", "WARN", "zeile1\nzeile2 \"q\"", "", &Ids::default());
        assert!(!l.contains('\n'));
        let v: Value = serde_json::from_str(&l).unwrap();
        assert_eq!(v["msg"], "zeile1\nzeile2 \"q\"");
        assert!(v.get("channelId").is_none());
    }
}
