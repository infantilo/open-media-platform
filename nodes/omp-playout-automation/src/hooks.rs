//! Ereignis-Hooks / Plugin-Architektur des Playout-Automators (Kapitel 27 / P9.3, Spec §130–133).
//!
//! **Prüfergebnis „Plugin vs. Prozess vs. Node vs. Core“ (§133):** OMP besitzt bereits den
//! generischen Plugin-Host des Node-SDK (`PluginRegistry`, `GET /plugins`, `PATCH /plugins/<id>`,
//! vom Orchestrator durchgereicht). Daher wird kein eigener Lader gebaut: der Automator
//! registriert dort das Plugin **`event-hooks`**. Es meldet Playout-Ereignisse
//! (`playlistEvent`, `primaryStart`, `primaryEnd`, `childEvent`, `channelStart`, `channelStop`) als
//! JSON-POST an konfigurierte HTTP-Ziele — externe Dienste (Router, SNMP, Broadcast-Controller,
//! Untertitel-Engines …) sind damit Abonnenten, keine Einbauten im Core. Aktionen
//! (`execute`/`preflight`) sind bereits die Child-Typen `WEBHOOK`/`NODE_COMMAND`.
//!
//! **Isolation (§132):** Zustellung läuft in einem eigenen Thread hinter einer begrenzten Warteschlange;
//! der Playout-Takt ruft nur `fire()` (nie blockierend, bei voller Warteschlange wird verworfen und
//! gezählt). Zeitüberschreitung, Fehlerstatus und Absturz des Ziels erzeugen nur einen Eintrag im
//! Status (`hookStatus`) — nie einen Fehler im Event oder im Takt.
//!
//! Konfiguration (`config` des Plugins):
//! `{"hooks":[{"event":"primaryStart","url":"http://…","timeoutMs":2000,"label":"Router"}]}`
//! (`event` = Name oder `"*"`).

use std::collections::HashMap;
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use omp_node_sdk::PluginRegistry;
use serde_json::{json, Value};

pub const PLUGIN_ID: &str = "event-hooks";
pub const EVENTS: [&str; 6] = ["playlistEvent", "primaryStart", "primaryEnd", "childEvent", "channelStart", "channelStop"];
const QUEUE_LEN: usize = 256;
const DEFAULT_TIMEOUT_MS: u64 = 2000;
const MAX_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Hook {
    pub label: String,
    pub event: String,
    pub url: String,
    pub timeout_ms: u64,
}

/// Liest die Hook-Liste aus der Plugin-Konfiguration; ungültige Einträge werden mit Grund zurückgegeben.
pub fn parse_config(config: &Value) -> (Vec<Hook>, Vec<String>) {
    let mut hooks = Vec::new();
    let mut problems = Vec::new();
    for (n, h) in config.get("hooks").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let event = h.get("event").and_then(Value::as_str).unwrap_or("*").trim().to_string();
        let url = h.get("url").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if event != "*" && !EVENTS.contains(&event.as_str()) {
            problems.push(format!("Hook {}: unbekanntes Ereignis „{event}\u{201c} ({} oder *)", n + 1, EVENTS.join(" | ")));
            continue;
        }
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            problems.push(format!("Hook {}: url muss mit http:// oder https:// beginnen", n + 1));
            continue;
        }
        let timeout_ms = h.get("timeoutMs").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT_MS).clamp(100, MAX_TIMEOUT_MS);
        let label = h.get("label").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("hook{}", n + 1));
        hooks.push(Hook { label, event, url, timeout_ms });
    }
    (hooks, problems)
}

pub fn matching<'a>(hooks: &'a [Hook], event: &str) -> Vec<&'a Hook> {
    hooks.iter().filter(|h| h.event == "*" || h.event == event).collect()
}

#[derive(Debug, Clone, Default)]
struct Stat {
    sent: u64,
    failed: u64,
    last_error: String,
    last_ok_ms: Option<i64>,
}

struct Delivery {
    event: String,
    body: Value,
}

pub struct HookEngine {
    tx: SyncSender<Delivery>,
    dropped: Arc<std::sync::atomic::AtomicU64>,
    status: Arc<Mutex<HashMap<String, Stat>>>,
}

static ENGINE: OnceLock<HookEngine> = OnceLock::new();
static PLUGINS: OnceLock<Arc<PluginRegistry>> = OnceLock::new();

/// Plugin-Zustand für den Snapshot (leer ohne gestarteten Host).
pub fn capture() -> Value {
    PLUGINS.get().map(|p| p.capture()).unwrap_or(Value::Null)
}

pub fn restore(doc: &Value) {
    if let Some(p) = PLUGINS.get() {
        p.restore(doc);
    }
}

/// Startet den Zustell-Thread (einmal je Prozess). `plugins` liefert die jeweils aktuelle Konfiguration.
pub fn start(plugins: Arc<PluginRegistry>) {
    let _ = PLUGINS.set(plugins.clone());
    let (tx, rx) = sync_channel::<Delivery>(QUEUE_LEN);
    let status: Arc<Mutex<HashMap<String, Stat>>> = Arc::new(Mutex::new(HashMap::new()));
    let st = status.clone();
    std::thread::Builder::new()
        .name("omp-event-hooks".into())
        .spawn(move || {
            for d in rx {
                let Some(p) = plugins.get(PLUGIN_ID).filter(|p| p.enabled) else { continue };
                let (hooks, _) = parse_config(&p.config);
                for h in matching(&hooks, &d.event) {
                    let res = ureq::post(&h.url)
                        .config()
                        .timeout_global(Some(Duration::from_millis(h.timeout_ms)))
                        .build()
                        .send_json(d.body.clone());
                    let mut g = st.lock().unwrap_or_else(|e| e.into_inner());
                    let s = g.entry(h.label.clone()).or_default();
                    match res {
                        Ok(_) => {
                            s.sent += 1;
                            s.last_ok_ms = Some(chrono::Utc::now().timestamp_millis());
                        }
                        Err(e) => {
                            s.failed += 1;
                            s.last_error = format!("{e}");
                            eprintln!("omp-playout-automation: Hook „{}\u{201c} ({}) fehlgeschlagen: {e}", h.label, d.event);
                        }
                    }
                }
            }
        })
        .expect("hook thread");
    let _ = ENGINE.set(HookEngine { tx, dropped: Arc::new(std::sync::atomic::AtomicU64::new(0)), status });
}

/// Meldet ein Ereignis. Nie blockierend; ohne gestartete Engine (Tests) ein No-Op.
pub fn fire(event: &str, mut payload: Value) {
    let Some(e) = ENGINE.get() else { return };
    payload["event"] = json!(event);
    payload["at"] = json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    if let Err(TrySendError::Full(_)) = e.tx.try_send(Delivery { event: event.to_string(), body: payload }) {
        e.dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Zustand je Hook für den Parameter `hookStatus`.
pub fn status_json(plugins: &PluginRegistry) -> Value {
    let enabled = plugins.get(PLUGIN_ID).is_some_and(|p| p.enabled);
    let (hooks, problems) = plugins.get(PLUGIN_ID).map(|p| parse_config(&p.config)).unwrap_or_default();
    let (stats, dropped) = ENGINE
        .get()
        .map(|e| (e.status.lock().unwrap_or_else(|x| x.into_inner()).clone(), e.dropped.load(std::sync::atomic::Ordering::Relaxed)))
        .unwrap_or_default();
    json!({
        "enabled": enabled,
        "dropped": dropped,
        "problems": problems,
        "hooks": hooks.iter().map(|h| {
            let s = stats.get(&h.label).cloned().unwrap_or_default();
            json!({"label": h.label, "event": h.event, "url": h.url, "timeoutMs": h.timeout_ms, "sent": s.sent, "failed": s.failed, "lastError": s.last_error, "lastOkMs": s.last_ok_ms})
        }).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_is_parsed_validated_and_clamped() {
        let (h, p) = parse_config(&json!({"hooks": [
            {"event": "primaryStart", "url": "http://a/x", "timeoutMs": 99999, "label": "A"},
            {"event": "*", "url": "https://b"},
            {"event": "nope", "url": "http://c"},
            {"event": "childEvent", "url": "ftp://d"},
        ]}));
        assert_eq!(h.len(), 2);
        assert_eq!((h[0].label.as_str(), h[0].timeout_ms), ("A", 10_000));
        assert_eq!((h[1].label.as_str(), h[1].event.as_str(), h[1].timeout_ms), ("hook2", "*", 2000));
        assert_eq!(p.len(), 2);
        assert!(p[0].contains("unbekanntes Ereignis") && p[1].contains("http"));
        assert!(parse_config(&json!({})).0.is_empty());
    }

    #[test]
    fn matching_selects_by_event_or_wildcard() {
        let (h, _) = parse_config(&json!({"hooks": [
            {"event": "primaryStart", "url": "http://a"}, {"event": "*", "url": "http://b"}, {"event": "childEvent", "url": "http://c"}]}));
        assert_eq!(matching(&h, "primaryStart").len(), 2);
        assert_eq!(matching(&h, "childEvent").len(), 2);
        assert_eq!(matching(&h, "channelStop").len(), 1);
    }

    #[test]
    fn fire_without_engine_is_a_noop_and_never_panics() {
        fire("primaryStart", json!({"label": "x"}));
    }
}
