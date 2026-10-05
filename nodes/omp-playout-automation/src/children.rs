//! Kapitel 27 / P3 (`UMSETZUNG.md` §27): Child Events — Modell, Zeitfenster,
//! Lebenszyklus und Fehlerrichtlinie als REINE Logik (keine Uhr, kein HTTP,
//! kein State), damit sie isoliert testbar bleibt. Die Ausführung (Scheduler,
//! Fernaufrufe) liegt in `main.rs`.
//!
//! Ein Child Event hängt an einem Primary (Spec §46): Grafik/Logo/Branding,
//! Trigger/Node-Command, Audio/Voiceover (über einen Node-Befehl), Webhook.
//! Der Automator kennt dafür KEINE Node-Typen (Spec §111): Grafik-Typen gehen
//! an den konfigurierten Grafik-Node (`show`/`hide`), alle anderen nennen
//! `target` (Node-Label) + `method` + `params` ausdrücklich — dieselben
//! IS-12/14-Methoden, die auch die Bedien-UIs aufrufen.
//!
//! **Bewusst NICHT unterstützt (kein Fake, Spec §275):** SUBTITLE, ROUTING,
//! SOURCE, SCTE35, GPI. Dafür existiert in diesem System kein Ziel-Node; sie
//! werden beim Setzen abgelehnt (`validate`) statt scheinbar zu laufen.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Altes Zeitmodell der Grafik-Kinder (Kapitel 6 Teil 5), weiterhin lesbar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RelativeTo {
    Start,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChildType {
    #[default]
    Graphic,
    Logo,
    ChannelBranding,
    Trigger,
    NodeCommand,
    Webhook,
    /// Kapitel 27 / P7: sendet einen Channel-Trigger (über den Orchestrator) an andere Channels.
    ChannelTrigger,
    Audio,
    Voiceover,
    // Ohne Ziel-Node in diesem System — nur zum sauberen Ablehnen:
    Subtitle,
    Routing,
    Source,
    Scte35,
    Gpi,
}

impl ChildType {
    /// Läuft über den Grafik-Node (`show`/`hide`).
    pub fn is_graphics(self) -> bool {
        matches!(self, ChildType::Graphic | ChildType::Logo | ChildType::ChannelBranding)
    }

    /// Läuft als ausdrücklicher Node-Befehl (`target` + `method`).
    pub fn is_node_command(self) -> bool {
        matches!(self, ChildType::Trigger | ChildType::NodeCommand | ChildType::Audio | ChildType::Voiceover)
    }

    pub fn is_supported(self) -> bool {
        self.is_graphics() || self.is_node_command() || matches!(self, ChildType::Webhook | ChildType::ChannelTrigger | ChildType::Scte35 | ChildType::Subtitle)
    }
}

/// Spec §48.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TimingMode {
    /// Fester Zeitpunkt (`atUtc`, RFC 3339), unabhängig vom Primary-Start.
    Absolute,
    RelativeToStart,
    /// `delayMs` Millisekunden VOR dem Ende des Primary (braucht feste Dauer).
    RelativeToEnd,
    /// Vom Start bis zum Ende des Primary (auch bei endlosem Live-Primary).
    FullPrimary,
}

/// Spec §188.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FailurePolicy {
    Ignore,
    #[default]
    Warn,
    Retry,
    /// Nur sinnvoll mit `required`: das Primary wird nicht genommen (Preflight).
    Block,
    /// Beim Fehler `fallbackTarget` statt `target` versuchen.
    Fallback,
}

/// Spec §57.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChildState {
    Scheduled,
    /// Ziel aufgelöst, wartet auf den Startzeitpunkt.
    Armed,
    /// Startbefehl erfolgreich abgesetzt.
    Fired,
    /// Läuft (wartet auf Stop: Dauer oder Primary-Ende).
    Active,
    Completed,
    Failed,
    Cancelled,
}

impl ChildState {
    /// Endzustände haben keine Ausgänge.
    pub fn is_terminal(self) -> bool {
        matches!(self, ChildState::Completed | ChildState::Failed | ChildState::Cancelled)
    }

    pub fn can_go(self, to: ChildState) -> bool {
        use ChildState::*;
        matches!(
            (self, to),
            (Scheduled, Armed)
                | (Scheduled, Fired)
                | (Scheduled, Failed)
                | (Scheduled, Cancelled)
                | (Armed, Fired)
                | (Armed, Failed)
                | (Armed, Cancelled)
                | (Fired, Active)
                | (Fired, Completed)
                | (Fired, Failed)
                | (Active, Completed)
                | (Active, Failed)
                | (Active, Cancelled)
        )
    }
}

fn default_retry_delay() -> u64 {
    1000
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChildEvent {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    #[serde(rename = "type", default)]
    pub kind: ChildType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing: Option<TimingMode>,
    /// Altes Feld der Grafik-Kinder; nur gelesen, wenn `timing` fehlt.
    #[serde(rename = "relativeTo", default, skip_serializing_if = "Option::is_none")]
    pub relative_to: Option<RelativeTo>,
    #[serde(rename = "delayMs", default)]
    pub delay_ms: u64,
    /// 0 = bis zum Ende des Primary.
    #[serde(rename = "durationMs", default)]
    pub duration_ms: u64,
    #[serde(rename = "atUtc", default, skip_serializing_if = "String::is_empty")]
    pub at_utc: String,
    #[serde(rename = "templateId", default, skip_serializing_if = "String::is_empty")]
    pub template_id: String,
    #[serde(default)]
    pub data: Value,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub target: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub method: String,
    #[serde(default)]
    pub params: Value,
    #[serde(rename = "stopMethod", default, skip_serializing_if = "String::is_empty")]
    pub stop_method: String,
    #[serde(rename = "stopParams", default)]
    pub stop_params: Value,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(rename = "failurePolicy", default)]
    pub failure_policy: FailurePolicy,
    #[serde(rename = "retryCount", default)]
    pub retry_count: u32,
    #[serde(rename = "retryDelayMs", default = "default_retry_delay")]
    pub retry_delay_ms: u64,
    #[serde(default)]
    pub required: bool,
    #[serde(rename = "fallbackTarget", default, skip_serializing_if = "String::is_empty")]
    pub fallback_target: String,
}

/// Ergebnis der Zeitrechnung (Offsets ab On-Air-Beginn des Primary).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub start_offset_ms: u64,
    /// `Some`: fester Stopp-Offset. `None`: kein eigener Stopp.
    pub stop_offset_ms: Option<u64>,
    /// Läuft bis zum Ende des Primary (Stopp beim Primary-Wechsel).
    pub until_primary_end: bool,
}

impl ChildEvent {
    /// Bequemer Konstruktor für Grafik-Kinder (nur Tests).
    #[cfg(test)]
    pub fn graphic(template_id: &str, timing: TimingMode, delay_ms: u64, duration_ms: u64) -> Self {
        ChildEvent {
            id: String::new(),
            kind: ChildType::Graphic,
            timing: Some(timing),
            relative_to: None,
            delay_ms,
            duration_ms,
            at_utc: String::new(),
            template_id: template_id.to_string(),
            data: Value::Null,
            target: String::new(),
            method: String::new(),
            params: Value::Null,
            stop_method: String::new(),
            stop_params: Value::Null,
            url: String::new(),
            failure_policy: FailurePolicy::Warn,
            retry_count: 0,
            retry_delay_ms: default_retry_delay(),
            required: false,
            fallback_target: String::new(),
        }
    }

    pub fn timing_mode(&self) -> TimingMode {
        self.timing.unwrap_or(match self.relative_to {
            Some(RelativeTo::End) => TimingMode::RelativeToEnd,
            _ => TimingMode::RelativeToStart,
        })
    }

    pub fn at_utc_ms(&self) -> Option<i64> {
        crate::schedule::parse_start_at(&self.at_utc)
    }

    /// Prüft ein Kind beim Setzen — Fehler als Klartext für den Operator.
    /// Voiceover im neuen Format (Kanal/Blenden/Ducking in `params`, Ausführung am Audiomischer)
    /// — ein Voiceover mit `method` bleibt ein freier Node-Befehl (Altbestand).
    pub fn is_native_voiceover(&self) -> bool {
        self.kind == ChildType::Voiceover && self.method.trim().is_empty()
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.kind == ChildType::Subtitle && self.params.get("track").and_then(Value::as_str).is_none_or(|t| t.trim().is_empty()) {
            return Err("SUBTITLE: params.track (Spur im Untertitel-Verzeichnis des Grafik-Nodes) fehlt".to_string());
        }
        if self.kind == ChildType::Scte35 {
            if self.target.trim().is_empty() {
                return Err("SCTE35: target (Label des omp-scte35-Nodes) fehlt".to_string());
            }
            match self.params.get("action").and_then(Value::as_str).unwrap_or("out") {
                "out" => {}
                "signal" => {
                    if self.params.get("typeId").and_then(Value::as_u64).is_none_or(|t| t > 255) {
                        return Err("SCTE35 signal: params.typeId (segmentation_type_id 0…255) fehlt".to_string());
                    }
                }
                other => return Err(format!("SCTE35: action „{other}\u{201c} unbekannt (out | signal)")),
            }
        }
        if !self.kind.is_supported() {
            return Err(format!(
                "{:?} wird nicht unterstützt: in diesem System gibt es dafür keinen Ziel-Node (Routing/Source/GPI)",
                self.kind
            ));
        }
        if self.kind.is_graphics() && self.template_id.trim().is_empty() {
            return Err("templateId fehlt (Grafik/Logo/Branding)".to_string());
        }
        if self.is_native_voiceover() {
            crate::voiceover::Voiceover::parse(&self.params)?;
        } else if self.kind.is_node_command() && (self.target.trim().is_empty() || self.method.trim().is_empty()) {
            return Err("target (Node-Label) und method müssen gesetzt sein (Trigger/Node-Command/Audio/Voiceover)".to_string());
        }
        if self.kind == ChildType::Webhook && !(self.url.starts_with("http://") || self.url.starts_with("https://")) {
            return Err("url muss mit http:// oder https:// beginnen (Webhook)".to_string());
        }
        if self.kind == ChildType::ChannelTrigger {
            let ok = self.params.get("event").and_then(Value::as_str).is_some_and(|e| !e.trim().is_empty())
                && self.params.get("target").is_some_and(Value::is_object);
            if !ok {
                return Err("params braucht event (z. B. NEXT_LIVE) und target ({\"channel\"|\"group\"|\"all\"}) (CHANNEL_TRIGGER)".to_string());
            }
        }
        if self.timing_mode() == TimingMode::Absolute && self.at_utc_ms().is_none() {
            return Err("ABSOLUTE braucht atUtc im RFC-3339-Format mit Offset (z. B. 2026-10-02T10:00:30+02:00)".to_string());
        }
        if self.failure_policy == FailurePolicy::Retry && self.retry_count == 0 {
            return Err("RETRY braucht retryCount > 0".to_string());
        }
        if self.failure_policy == FailurePolicy::Fallback && self.fallback_target.trim().is_empty() {
            return Err("FALLBACK braucht fallbackTarget".to_string());
        }
        if self.failure_policy == FailurePolicy::Block && !self.required {
            return Err("BLOCK wirkt nur bei required=true (sonst gäbe es nichts zu blockieren)".to_string());
        }
        Ok(())
    }

    /// Zeitfenster relativ zum On-Air-Beginn des Primary.
    /// `onair_start_utc_ms` nur für ABSOLUTE.
    pub fn resolve_window(&self, primary_duration_ms: u64, onair_start_utc_ms: i64) -> Result<Window, String> {
        let timed_stop = |start: u64| if self.duration_ms > 0 { Some(start + self.duration_ms) } else { None };
        match self.timing_mode() {
            TimingMode::RelativeToStart => {
                Ok(Window { start_offset_ms: self.delay_ms, stop_offset_ms: timed_stop(self.delay_ms), until_primary_end: self.duration_ms == 0 })
            }
            TimingMode::RelativeToEnd => {
                if primary_duration_ms == 0 {
                    return Err("RELATIVE_TO_END braucht ein Primary mit fester Dauer (Live/endlos hat kein Ende)".to_string());
                }
                let start = primary_duration_ms
                    .checked_sub(self.delay_ms)
                    .ok_or_else(|| format!("RELATIVE_TO_END: {} ms vor dem Ende liegt vor dem Beginn des Primary ({primary_duration_ms} ms)", self.delay_ms))?;
                Ok(Window { start_offset_ms: start, stop_offset_ms: timed_stop(start), until_primary_end: self.duration_ms == 0 })
            }
            TimingMode::FullPrimary => Ok(Window { start_offset_ms: 0, stop_offset_ms: None, until_primary_end: true }),
            TimingMode::Absolute => {
                let at = self.at_utc_ms().ok_or("ABSOLUTE ohne gültiges atUtc")?;
                let start = u64::try_from(at - onair_start_utc_ms)
                    .map_err(|_| "ABSOLUTE: der Zeitpunkt liegt vor dem Beginn des Primary".to_string())?;
                Ok(Window { start_offset_ms: start, stop_offset_ms: timed_stop(start), until_primary_end: self.duration_ms == 0 })
            }
        }
    }

    /// Liegt das Fenster innerhalb des Primary? (Spec §126 „Child Event außerhalb Primary“)
    pub fn warn_outside_primary(&self, w: &Window, primary_duration_ms: u64) -> Option<String> {
        if primary_duration_ms == 0 {
            return None;
        }
        if w.start_offset_ms >= primary_duration_ms {
            return Some(format!("startet bei {} ms, nach dem Ende des Primary ({primary_duration_ms} ms)", w.start_offset_ms));
        }
        if let Some(stop) = w.stop_offset_ms
            && stop > primary_duration_ms
        {
            return Some(format!("endet bei {stop} ms, nach dem Ende des Primary ({primary_duration_ms} ms) — wird beim Primary-Ende gestoppt"));
        }
        None
    }
}

/// Entscheidung nach einem fehlgeschlagenen Startbefehl.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailAction {
    /// Erneut versuchen nach `delay_ms` (nächster Versuch = `attempt + 1`).
    Retry { delay_ms: u64 },
    /// Mit `fallbackTarget` einmal erneut versuchen.
    UseFallback,
    /// Fehler melden, Child = FAILED.
    Warn,
    /// Still, Child = FAILED.
    Ignore,
}

/// `attempt` = Nummer des gerade fehlgeschlagenen Versuchs (0 = erster).
pub fn decide_on_failure(child: &ChildEvent, attempt: u32, already_on_fallback: bool) -> FailAction {
    match child.failure_policy {
        FailurePolicy::Ignore => FailAction::Ignore,
        FailurePolicy::Retry if attempt < child.retry_count => FailAction::Retry { delay_ms: child.retry_delay_ms },
        FailurePolicy::Fallback if !already_on_fallback => FailAction::UseFallback,
        // RETRY aufgebraucht, FALLBACK schon versucht, WARN, BLOCK (Fehler im Lauf):
        _ => FailAction::Warn,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(delay: u64, dur: u64) -> ChildEvent {
        ChildEvent::graphic("lt", TimingMode::RelativeToStart, delay, dur)
    }

    #[test]
    fn legacy_graphics_child_json_still_loads() {
        // Altes Format aus Kapitel 6 Teil 5 (Snapshots, UI): kein `type`, kein `timing`.
        let c: ChildEvent = serde_json::from_str(
            r#"{"templateId":"lower-third","data":{"name":"X"},"delayMs":3000,"durationMs":5000,"relativeTo":"end"}"#,
        )
        .unwrap();
        assert_eq!(c.kind, ChildType::Graphic);
        assert_eq!(c.timing_mode(), TimingMode::RelativeToEnd);
        assert_eq!(c.failure_policy, FailurePolicy::Warn);
        assert_eq!(c.retry_delay_ms, 1000);
        c.validate().unwrap();
        // Ohne relativeTo = vom Start aus.
        let c: ChildEvent = serde_json::from_str(r#"{"templateId":"t"}"#).unwrap();
        assert_eq!(c.timing_mode(), TimingMode::RelativeToStart);
    }

    #[test]
    fn roundtrip_keeps_all_set_fields_and_omits_empty_ones() {
        let mut c = ChildEvent::graphic("t", TimingMode::FullPrimary, 0, 0);
        c.id = "c1".to_string();
        c.failure_policy = FailurePolicy::Retry;
        c.retry_count = 2;
        let json = serde_json::to_value(&c).unwrap();
        assert_eq!(json["type"], "GRAPHIC");
        assert_eq!(json["timing"], "FULL_PRIMARY");
        assert!(json.get("target").is_none() && json.get("url").is_none(), "empty strings are not serialized");
        let back: ChildEvent = serde_json::from_value(json).unwrap();
        assert_eq!(back, c);
    }

    #[test]
    fn relative_to_start_window() {
        let w = rel(10_000, 8_000).resolve_window(120_000, 0).unwrap();
        assert_eq!(w, Window { start_offset_ms: 10_000, stop_offset_ms: Some(18_000), until_primary_end: false });
        // Dauer 0 = bis Primary-Ende (auch beim endlosen Live-Primary).
        let w = rel(3000, 0).resolve_window(0, 0).unwrap();
        assert_eq!(w, Window { start_offset_ms: 3000, stop_offset_ms: None, until_primary_end: true });
    }

    #[test]
    fn relative_to_end_window_and_its_errors() {
        let c = ChildEvent::graphic("t", TimingMode::RelativeToEnd, 5000, 0);
        let w = c.resolve_window(60_000, 0).unwrap();
        assert_eq!((w.start_offset_ms, w.until_primary_end), (55_000, true));
        assert!(c.resolve_window(0, 0).unwrap_err().contains("fester Dauer"));
        assert!(c.resolve_window(3000, 0).unwrap_err().contains("vor dem Beginn"));
    }

    #[test]
    fn full_primary_runs_from_start_to_primary_end_even_for_live() {
        let c = ChildEvent::graphic("logo", TimingMode::FullPrimary, 999, 999);
        let w = c.resolve_window(0, 0).unwrap();
        assert_eq!(w, Window { start_offset_ms: 0, stop_offset_ms: None, until_primary_end: true });
    }

    #[test]
    fn absolute_window_uses_the_wall_clock() {
        let mut c = ChildEvent::graphic("t", TimingMode::Absolute, 0, 4000);
        c.at_utc = "2026-10-02T08:00:30Z".to_string();
        let onair = crate::schedule::parse_start_at("2026-10-02T08:00:00Z").unwrap();
        let w = c.resolve_window(0, onair).unwrap();
        assert_eq!((w.start_offset_ms, w.stop_offset_ms), (30_000, Some(34_000)));
        // Vor dem Beginn des Primary → Fehler statt „sofort“.
        assert!(c.resolve_window(0, onair + 60_000).unwrap_err().contains("vor dem Beginn"));
        // Ohne atUtc gar nicht erst gültig.
        let bad = ChildEvent::graphic("t", TimingMode::Absolute, 0, 0);
        assert!(bad.validate().unwrap_err().contains("atUtc"));
    }

    #[test]
    fn subtitle_child_needs_a_track() {
        let mut c = ChildEvent::graphic("", TimingMode::FullPrimary, 0, 0);
        c.kind = ChildType::Subtitle;
        assert!(c.kind.is_supported() && !c.kind.is_graphics() && !c.kind.is_node_command());
        assert!(c.validate().unwrap_err().contains("track"));
        c.params = serde_json::json!({"track": "demo-de"});
        c.validate().unwrap();
    }

    #[test]
    fn scte35_child_needs_a_target_and_a_known_action() {
        let mut c = ChildEvent::graphic("", TimingMode::RelativeToStart, 1000, 30000);
        c.kind = ChildType::Scte35;
        assert!(c.kind.is_supported() && !c.kind.is_node_command());
        assert!(c.validate().unwrap_err().contains("target"));
        c.target = "SCTE-35".to_string();
        c.validate().unwrap();
        c.params = serde_json::json!({"action": "signal"});
        assert!(c.validate().unwrap_err().contains("typeId"));
        c.params = serde_json::json!({"action": "signal", "typeId": 52, "endTypeId": 53});
        c.validate().unwrap();
        c.params = serde_json::json!({"action": "splice"});
        assert!(c.validate().unwrap_err().contains("unbekannt"));
    }

    #[test]
    fn native_voiceover_validates_its_params_and_legacy_voiceover_stays_a_node_command() {
        let mut c = ChildEvent::graphic("", TimingMode::RelativeToStart, 1000, 5000);
        c.kind = ChildType::Voiceover;
        assert!(c.is_native_voiceover());
        assert!(c.validate().unwrap_err().contains("channel"));
        c.params = serde_json::json!({"channel": "ch3", "duck": {"rule": "duck1"}});
        c.validate().unwrap();
        // Altbestand: mit `method` ein freier Node-Befehl (target + method Pflicht).
        c.method = "play".to_string();
        assert!(!c.is_native_voiceover());
        assert!(c.validate().unwrap_err().contains("target"));
        c.target = "Sprecher".to_string();
        c.validate().unwrap();
    }

    #[test]
    fn channel_trigger_child_needs_event_and_target() {
        let mut c = ChildEvent::graphic("", TimingMode::RelativeToStart, 1000, 0);
        c.kind = ChildType::ChannelTrigger;
        assert!(c.kind.is_supported() && !c.kind.is_node_command() && !c.kind.is_graphics());
        assert!(c.validate().unwrap_err().contains("event"));
        c.params = serde_json::json!({"event": "NEXT_LIVE"});
        assert!(c.validate().is_err(), "ohne target");
        c.params = serde_json::json!({"event": "NEXT_LIVE", "target": {"group": "regional"}});
        c.validate().unwrap();
        // Serialisierung wie die übrigen Typen (SCREAMING_SNAKE_CASE).
        assert_eq!(serde_json::to_value(ChildType::ChannelTrigger).unwrap(), "CHANNEL_TRIGGER");
    }

    #[test]
    fn validation_rejects_unsupported_and_incomplete_children() {
        for kind in [ChildType::Routing, ChildType::Source, ChildType::Gpi] {
            let mut c = ChildEvent::graphic("t", TimingMode::FullPrimary, 0, 0);
            c.kind = kind;
            assert!(c.validate().unwrap_err().contains("keinen Ziel-Node"), "{kind:?}");
        }
        let mut c = ChildEvent::graphic("", TimingMode::FullPrimary, 0, 0);
        assert!(c.validate().unwrap_err().contains("templateId"));
        c.kind = ChildType::NodeCommand;
        assert!(c.validate().unwrap_err().contains("target"));
        c.target = "Audiomischer".to_string();
        c.method = "activateScene".to_string();
        c.validate().unwrap();
        c.kind = ChildType::Webhook;
        assert!(c.validate().unwrap_err().contains("http"));
        c.url = "https://example.invalid/hook".to_string();
        c.validate().unwrap();
        // Richtlinien-Konsistenz
        c.failure_policy = FailurePolicy::Retry;
        assert!(c.validate().unwrap_err().contains("retryCount"));
        c.failure_policy = FailurePolicy::Fallback;
        assert!(c.validate().unwrap_err().contains("fallbackTarget"));
        c.failure_policy = FailurePolicy::Block;
        assert!(c.validate().unwrap_err().contains("required"));
        c.required = true;
        c.validate().unwrap();
    }

    #[test]
    fn child_outside_primary_is_reported() {
        let c = rel(70_000, 5000);
        let w = c.resolve_window(60_000, 0).unwrap();
        assert!(c.warn_outside_primary(&w, 60_000).unwrap().contains("nach dem Ende"));
        let c = rel(55_000, 10_000);
        let w = c.resolve_window(60_000, 0).unwrap();
        assert!(c.warn_outside_primary(&w, 60_000).unwrap().contains("gestoppt"));
        let c = rel(1000, 1000);
        let w = c.resolve_window(60_000, 0).unwrap();
        assert!(c.warn_outside_primary(&w, 60_000).is_none());
        // Endloses Primary: nichts zu vergleichen.
        assert!(c.warn_outside_primary(&w, 0).is_none());
    }

    #[test]
    fn lifecycle_allows_the_main_path_and_forbids_resurrection() {
        use ChildState::*;
        for (a, b) in [(Scheduled, Armed), (Armed, Fired), (Fired, Active), (Active, Completed), (Scheduled, Cancelled), (Active, Failed)] {
            assert!(a.can_go(b), "{a:?} -> {b:?}");
        }
        for end in [Completed, Failed, Cancelled] {
            assert!(end.is_terminal());
            for to in [Scheduled, Armed, Fired, Active, Completed] {
                assert!(!end.can_go(to), "{end:?} is terminal");
            }
        }
        assert!(!Scheduled.can_go(Active), "no ACTIVE without FIRED");
    }

    #[test]
    fn failure_policy_decisions() {
        let mut c = rel(0, 0);
        c.failure_policy = FailurePolicy::Ignore;
        assert_eq!(decide_on_failure(&c, 0, false), FailAction::Ignore);
        c.failure_policy = FailurePolicy::Warn;
        assert_eq!(decide_on_failure(&c, 0, false), FailAction::Warn);
        c.failure_policy = FailurePolicy::Retry;
        c.retry_count = 2;
        c.retry_delay_ms = 250;
        assert_eq!(decide_on_failure(&c, 0, false), FailAction::Retry { delay_ms: 250 });
        assert_eq!(decide_on_failure(&c, 1, false), FailAction::Retry { delay_ms: 250 });
        assert_eq!(decide_on_failure(&c, 2, false), FailAction::Warn, "retries exhausted");
        c.failure_policy = FailurePolicy::Fallback;
        assert_eq!(decide_on_failure(&c, 0, false), FailAction::UseFallback);
        assert_eq!(decide_on_failure(&c, 1, true), FailAction::Warn, "fallback already tried");
    }
}
