//! AMWA BCP-008-01 (NMOS Receiver Status Monitoring) / BCP-008-02 (NMOS
//! Sender Status Monitoring), auf OMPs flaches Parameter/Methoden-
//! Descriptor-Schema abgebildet (`docs/decisions.md`, Nachtrag zur
//! BCP-008-Einführung 2026-09-11).
//!
//! **Bewusste Abweichung von der wörtlichen Spec:** BCP-008 setzt ein
//! echtes MS-05-02-Objektmodell voraus (`NcReceiverMonitor`/
//! `NcSenderMonitor`, jeweils von `NcStatusMonitor`/`NcWorker`/`NcObject`
//! abgeleitet, mit Rollenpfaden, Class-IDs, Notifications über einen
//! eigenen WebSocket-Kanal). OMP hat das nicht (`ARCHITECTURE.md` §2
//! nennt IS-12/14 nur als Vorbild für den Hebel "selbstbeschreibende
//! Parameter/Methoden", implementiert aber ein einfaches
//! `GET/PATCH /params/<name>` + `POST /methods/<name>`-Schema, s.
//! `descriptor.rs`). Diese Datei bildet die Spec-Absicht (vier
//! Gesundheits-Domains + Overall-Status, Transition-Zähler, Reset,
//! Reporting-Delay-Entprellung) direkt auf dieses Schema ab, statt einen
//! eigenen NcObject-Baum nachzubauen — gleiches Vorgehen wie beim
//! Mixer, der M/E-Ebenen als Namenspräfix statt als eigene Objekte
//! abbildet (`omp-video-mixer-me::level_name`).
//!
//! **Zweite bewusste Abweichung:** BCP-008s `GetLostPacketCounters`/
//! `GetLatePacketCounters`/`GetTransmissionErrorCounters` sind in der
//! Spec Methoden mit Rückgabewert — [`ParamStore::invoke`] hier liefert
//! aber nur `Result<(), InvokeError>`, keine Nutzdaten (s. `server.rs`).
//! Deshalb werden diese drei als READONLY-Parameter exponiert
//! (`GET /params/<prefix>.lostPacketCounters` etc.), nicht als Methoden
//! — nur `ResetCountersAndMessages` bleibt eine echte Methode (reines
//! Kommando, passt zur `invoke()`-Signatur).
//!
//! Aufrufer: Ticker-Task ruft periodisch [`Monitor::observe_link`]/
//! [`Monitor::observe_sync`]/[`Monitor::observe_activity`]/
//! [`Monitor::observe_content`] mit dem aktuellen ROH-Messwert auf;
//! [`Monitor::activate`]/[`Monitor::deactivate`] bei echten Aktivitäts-
//! wechseln (z. B. IS-05-Connect/Disconnect). [`Monitor::param_specs`]/
//! [`Monitor::get`] ins jeweilige `ParamStore::descriptor()`/`get()`
//! verdrahten, [`Monitor::method_specs`]/[`Monitor::invoke`] entsprechend
//! in `invoke()`.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::descriptor::{MethodSpec, ParamSpec, ParamType, Range};

/// Gemeinsame interne Gesundheitsstufe für alle vier BCP-008-Domains —
/// die Spec-eigenen Vokabulare (`AllUp`/`Inactive`/`NotUsed`/...) sind
/// reine Beschriftungen derselben vier Stufen je Domain (s. `label_*`
/// unten). `Neutral` existiert nur für Domains mit einem echten
/// Leerlaufzustand (Verbindung/Transmission, Stream/Essenz, Overall) —
/// `linkStatus`/`externalSynchronizationStatus` erzeugen es nie
/// (`AllUp`/`NotUsed` sind für diese beiden schon der GESUNDE Fall, s.
/// `label_link`/`label_sync`), zählen also immer normal in
/// `Monitor::overall` mit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum HealthLevel {
    Neutral = 0,
    Healthy = 1,
    PartiallyHealthy = 2,
    Unhealthy = 3,
}

impl HealthLevel {
    fn from_u8(v: u8) -> Self {
        match v {
            0 => HealthLevel::Neutral,
            1 => HealthLevel::Healthy,
            2 => HealthLevel::PartiallyHealthy,
            _ => HealthLevel::Unhealthy,
        }
    }
}

/// `Inactive`/`Healthy`/`PartiallyHealthy`/`Unhealthy` — `connectionStatus`/
/// `transmissionStatus`, `streamStatus`/`essenceStatus`, `overallStatus`.
pub fn label_standard(level: HealthLevel) -> &'static str {
    match level {
        HealthLevel::Neutral => "Inactive",
        HealthLevel::Healthy => "Healthy",
        HealthLevel::PartiallyHealthy => "PartiallyHealthy",
        HealthLevel::Unhealthy => "Unhealthy",
    }
}

/// `AllUp`/`SomeDown`/`AllDown` — `linkStatus`. `Neutral` kommt hier nie
/// vor (s. Typdoku oben), der `match`-Zweig ist nur zur Vollständigkeit
/// vorhanden.
pub fn label_link(level: HealthLevel) -> &'static str {
    match level {
        HealthLevel::Neutral | HealthLevel::Healthy => "AllUp",
        HealthLevel::PartiallyHealthy => "SomeDown",
        HealthLevel::Unhealthy => "AllDown",
    }
}

/// `NotUsed`/`Healthy`/`PartiallyHealthy`/`Unhealthy` —
/// `externalSynchronizationStatus`.
pub fn label_sync(level: HealthLevel) -> &'static str {
    match level {
        HealthLevel::Neutral => "NotUsed",
        HealthLevel::Healthy => "Healthy",
        HealthLevel::PartiallyHealthy => "PartiallyHealthy",
        HealthLevel::Unhealthy => "Unhealthy",
    }
}

/// Eine einzelne entprellte Gesundheits-Domain (z. B. `connectionStatus`).
/// Entprellregeln direkt aus der Spec (`docs/decisions.md`
/// BCP-008-Nachtrag): eine Verschlechterung wirkt SOFORT (kein Grund,
/// einen echten Fehler zu verschleppen), eine Verbesserung erst, wenn der
/// bessere Rohwert `status_reporting_delay` lang UNUNTERBROCHEN anhielt
/// (verhindert Flattern bei kurzen Erholungen). `force()` (Aktivierung/
/// Deaktivierung) umgeht die Entprellung komplett — beides sind
/// diskrete, vom Aufrufer sicher bekannte Zustandswechsel, keine
/// Meßgrößen.
pub struct DebouncedDomain {
    reported: AtomicU8,
    pending: Mutex<Option<(HealthLevel, Instant)>>,
    transition_counter: AtomicU32,
    message: Mutex<Option<String>>,
}

impl DebouncedDomain {
    pub fn new(initial: HealthLevel) -> Self {
        DebouncedDomain {
            reported: AtomicU8::new(initial as u8),
            pending: Mutex::new(None),
            transition_counter: AtomicU32::new(0),
            message: Mutex::new(None),
        }
    }

    /// Ein neuer ROH-Messwert (z. B. "gerade eben 3 Pakete verloren" oder
    /// "PTP-Clock aktuell synced") — `message` beschreibt die Ursache
    /// einer VERSCHLECHTERUNG (wird bei Verbesserung auf `Healthy` mit
    /// "Previously: "-Präfix übernommen, Spec-Empfehlung).
    pub fn observe(&self, raw: HealthLevel, delay: Duration, message: Option<&str>) {
        let current = HealthLevel::from_u8(self.reported.load(Ordering::Acquire));
        if raw == current {
            *self.pending.lock().expect("lock poisoned") = None;
            return;
        }
        if raw > current {
            // Verschlechterung: sofort, kein Entprellen.
            *self.pending.lock().expect("lock poisoned") = None;
            self.transition_counter.fetch_add(1, Ordering::Relaxed);
            self.reported.store(raw as u8, Ordering::Release);
            if let Some(m) = message {
                *self.message.lock().expect("lock poisoned") = Some(m.to_string());
            }
            return;
        }
        // Erholung (raw < current): nur nach `delay` ununterbrochenem
        // Anhalten des besseren Werts übernehmen.
        let mut pending = self.pending.lock().expect("lock poisoned");
        match &*pending {
            Some((level, since)) if *level == raw => {
                if since.elapsed() >= delay {
                    self.reported.store(raw as u8, Ordering::Release);
                    *pending = None;
                    let mut msg = self.message.lock().expect("lock poisoned");
                    *msg = if raw == HealthLevel::Healthy {
                        Some(format!("Previously: {}", message.unwrap_or("degraded")))
                    } else {
                        message.map(str::to_string)
                    };
                }
            }
            _ => *pending = Some((raw, Instant::now())),
        }
    }

    /// Aktivierung/Deaktivierung — sofortiger Wechsel ohne Entprellung,
    /// löscht auch einen ggf. laufenden Erholungs-Timer (der bezog sich
    /// auf den alten Aktivitätszustand).
    pub fn force(&self, level: HealthLevel) {
        *self.pending.lock().expect("lock poisoned") = None;
        self.reported.store(level as u8, Ordering::Release);
    }

    pub fn level(&self) -> HealthLevel {
        HealthLevel::from_u8(self.reported.load(Ordering::Acquire))
    }

    pub fn transition_counter(&self) -> u32 {
        self.transition_counter.load(Ordering::Relaxed)
    }

    pub fn message(&self) -> Option<String> {
        self.message.lock().expect("lock poisoned").clone()
    }

    pub fn reset(&self) {
        self.transition_counter.store(0, Ordering::Relaxed);
        *self.message.lock().expect("lock poisoned") = None;
    }
}

/// Ob ein [`Monitor`] die BCP-008-01-Vokabeln (Receiver:
/// `connectionStatus`/`streamStatus`, `GetLostPacketCounters`/
/// `GetLatePacketCounters`) oder BCP-008-02 (Sender:
/// `transmissionStatus`/`essenceStatus`, `GetTransmissionErrorCounters`)
/// verwendet — inhaltlich identische Zustandsmaschine, nur andere
/// Param-/Methodennamen auf der Wire-Seite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorKind {
    Receiver,
    Sender,
}

/// Ein vollständiger BCP-008-Monitor (vier Domains + Overall + Config) —
/// eine Instanz pro überwachtem NMOS-Sender/-Receiver. Für Nodes mit
/// mehreren Sendern/Receivern (hier noch keiner) `prefix` in
/// `param_specs`/`get`/`method_specs`/`invoke` entsprechend eindeutig
/// wählen (gleiches Muster wie `omp-video-mixer-me::level_name`).
pub struct Monitor {
    kind: MonitorKind,
    pub link: DebouncedDomain,
    pub sync: DebouncedDomain,
    /// `connectionStatus` (Receiver) bzw. `transmissionStatus` (Sender).
    pub activity: DebouncedDomain,
    /// `streamStatus` (Receiver) bzw. `essenceStatus` (Sender).
    pub content: DebouncedDomain,
    overall_message: Mutex<Option<String>>,
    status_reporting_delay: Mutex<Duration>,
    auto_reset: AtomicBool,
}

const DEFAULT_STATUS_REPORTING_DELAY: Duration = Duration::from_secs(3);

impl Monitor {
    /// Startzustand: `Healthy` für `activity`/`content` (Spec: sofort
    /// gesund bei Aktivierung), `link`/`sync` neutral-gesund
    /// (`AllUp`/`NotUsed`) bis der erste echte Messwert eintrifft.
    pub fn new(kind: MonitorKind) -> Self {
        Monitor {
            kind,
            link: DebouncedDomain::new(HealthLevel::Healthy),
            sync: DebouncedDomain::new(HealthLevel::Neutral),
            activity: DebouncedDomain::new(HealthLevel::Healthy),
            content: DebouncedDomain::new(HealthLevel::Healthy),
            overall_message: Mutex::new(None),
            status_reporting_delay: Mutex::new(DEFAULT_STATUS_REPORTING_DELAY),
            auto_reset: AtomicBool::new(true),
        }
    }

    pub fn status_reporting_delay(&self) -> Duration {
        *self.status_reporting_delay.lock().expect("lock poisoned")
    }

    pub fn set_status_reporting_delay(&self, delay: Duration) {
        *self.status_reporting_delay.lock().expect("lock poisoned") = delay;
    }

    pub fn auto_reset_counters_and_messages(&self) -> bool {
        self.auto_reset.load(Ordering::Relaxed)
    }

    pub fn set_auto_reset_counters_and_messages(&self, enabled: bool) {
        self.auto_reset.store(enabled, Ordering::Relaxed);
    }

    /// `activity`/`content`/`overall` sofort auf `Healthy`, `link`/`sync`
    /// unverändert (die messen echte physische/Sync-Zustände, die vom
    /// Aktivwerden dieses einen Senders/Receivers unabhängig sind) —
    /// exakt der in beiden Specs dokumentierte Aktivierungs-Sonderfall.
    /// Setzt bei `autoResetCountersAndMessages` zusätzlich alle Zähler/
    /// Meldungen zurück.
    pub fn activate(&self) {
        self.activity.force(HealthLevel::Healthy);
        self.content.force(HealthLevel::Healthy);
        *self.overall_message.lock().expect("lock poisoned") = None;
        if self.auto_reset_counters_and_messages() {
            self.reset_counters_and_messages();
        }
    }

    /// `activity`/`content`/`overall` sofort auf `Inactive`, ohne
    /// Zwischenzustände — exakt der in beiden Specs dokumentierte
    /// Deaktivierungs-Sonderfall.
    pub fn deactivate(&self) {
        self.activity.force(HealthLevel::Neutral);
        self.content.force(HealthLevel::Neutral);
    }

    /// `overallStatus`: `Inactive`, solange der Sender/Receiver inaktiv
    /// ist (an `activity`/`content` == `Neutral` erkennbar, s.
    /// `activate`/`deactivate`), sonst der ungesündeste der vier Domains
    /// (`Neutral` bei `link`/`sync` zählt dabei als gesund, s.
    /// `HealthLevel`-Doku).
    pub fn overall(&self) -> HealthLevel {
        if self.activity.level() == HealthLevel::Neutral {
            return HealthLevel::Neutral;
        }
        [self.link.level(), self.sync.level(), self.activity.level(), self.content.level()]
            .into_iter()
            .max()
            .unwrap_or(HealthLevel::Healthy)
    }

    pub fn reset_counters_and_messages(&self) {
        self.link.reset();
        self.sync.reset();
        self.activity.reset();
        self.content.reset();
        *self.overall_message.lock().expect("lock poisoned") = None;
    }

    fn activity_name(&self) -> &'static str {
        match self.kind {
            MonitorKind::Receiver => "connectionStatus",
            MonitorKind::Sender => "transmissionStatus",
        }
    }

    fn content_name(&self) -> &'static str {
        match self.kind {
            MonitorKind::Receiver => "streamStatus",
            MonitorKind::Sender => "essenceStatus",
        }
    }

    /// `ParamSpec`-Liste für `prefix.<bcp008-name>` — ins jeweilige
    /// `ParamStore::descriptor()` einhängen (`vec.extend(monitor.param_specs("monitor"))`).
    pub fn param_specs(&self, prefix: &str) -> Vec<ParamSpec> {
        let n = |suffix: &str| format!("{prefix}.{suffix}");
        let standard_range = || {
            Some(Range::Enum {
                values: ["Inactive", "Healthy", "PartiallyHealthy", "Unhealthy"]
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            })
        };
        vec![
            ParamSpec { name: n("overallStatus"), kind: ParamType::Enum, unit: None, range: standard_range(), readonly: true },
            ParamSpec { name: n("overallStatusMessage"), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec {
                name: n("linkStatus"),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum { values: ["AllUp", "SomeDown", "AllDown"].iter().map(|s| s.to_string()).collect() }),
                readonly: true,
            },
            ParamSpec { name: n("linkStatusMessage"), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: n("linkStatusTransitionCounter"), kind: ParamType::Number, unit: None, range: None, readonly: true },
            ParamSpec {
                name: n(self.activity_name()),
                kind: ParamType::Enum,
                unit: None,
                range: standard_range(),
                readonly: true,
            },
            ParamSpec { name: n(&format!("{}Message", self.activity_name())), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec {
                name: n(&format!("{}TransitionCounter", self.activity_name())),
                kind: ParamType::Number,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: n("externalSynchronizationStatus"),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum { values: ["NotUsed", "Healthy", "PartiallyHealthy", "Unhealthy"].iter().map(|s| s.to_string()).collect() }),
                readonly: true,
            },
            ParamSpec { name: n("externalSynchronizationStatusMessage"), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec {
                name: n("externalSynchronizationStatusTransitionCounter"),
                kind: ParamType::Number,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec { name: n("synchronizationSourceId"), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec {
                name: n(self.content_name()),
                kind: ParamType::Enum,
                unit: None,
                range: standard_range(),
                readonly: true,
            },
            ParamSpec { name: n(&format!("{}Message", self.content_name())), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec {
                name: n(&format!("{}TransitionCounter", self.content_name())),
                kind: ParamType::Number,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec { name: n("statusReportingDelay"), kind: ParamType::Number, unit: Some("ms".to_string()), range: None, readonly: false },
            ParamSpec { name: n("autoResetCountersAndMessages"), kind: ParamType::Boolean, unit: None, range: None, readonly: false },
        ]
    }

    /// `MethodSpec`-Liste für `prefix.<bcp008-name>` — nur
    /// `resetCountersAndMessages` (s. Moduldoku: die drei Counter-
    /// Getter sind hier Params, keine Methoden).
    pub fn method_specs(&self, prefix: &str) -> Vec<MethodSpec> {
        vec![MethodSpec { name: format!("{prefix}.resetCountersAndMessages"), args: vec![] }]
    }

    /// Dispatcht `POST /methods/<prefix>.resetCountersAndMessages`. `Ok(false)`,
    /// wenn `name` nicht zu diesem Monitor gehört (Aufrufer fällt dann auf
    /// eigene Methoden zurück).
    pub fn invoke(&self, prefix: &str, name: &str) -> bool {
        if name == format!("{prefix}.resetCountersAndMessages") {
            self.reset_counters_and_messages();
            true
        } else {
            false
        }
    }

    /// Dispatcht `GET /params/<prefix>.<name>`. `lost`/`late`/
    /// `transmission_error_counters` liefern die drei BCP-008-Zähler-
    /// Getter als JSON-Array `[{"name","description","value"}]` (leer,
    /// wenn der Aufrufer keine Zähler hat — Spec-konform statt geraten).
    #[allow(clippy::too_many_arguments)]
    pub fn get(
        &self,
        prefix: &str,
        name: &str,
        sync_source_id: Option<&str>,
        counters: impl FnOnce() -> Vec<(String, String, i64)>,
    ) -> Option<Value> {
        let suffix = name.strip_prefix(prefix)?.strip_prefix('.')?;
        let activity_name = self.activity_name();
        let content_name = self.content_name();
        Some(match suffix {
            "overallStatus" => Value::from(label_standard(self.overall())),
            "overallStatusMessage" => self.overall_message.lock().expect("lock poisoned").clone().map(Value::from).unwrap_or(Value::Null),
            "linkStatus" => Value::from(label_link(self.link.level())),
            "linkStatusMessage" => self.link.message().map(Value::from).unwrap_or(Value::Null),
            "linkStatusTransitionCounter" => Value::from(self.link.transition_counter()),
            "externalSynchronizationStatus" => Value::from(label_sync(self.sync.level())),
            "externalSynchronizationStatusMessage" => self.sync.message().map(Value::from).unwrap_or(Value::Null),
            "externalSynchronizationStatusTransitionCounter" => Value::from(self.sync.transition_counter()),
            "synchronizationSourceId" => sync_source_id.map(Value::from).unwrap_or(Value::Null),
            "statusReportingDelay" => Value::from(self.status_reporting_delay().as_millis() as u64),
            "autoResetCountersAndMessages" => Value::from(self.auto_reset_counters_and_messages()),
            s if s == activity_name => Value::from(label_standard(self.activity.level())),
            s if s == format!("{activity_name}Message") => self.activity.message().map(Value::from).unwrap_or(Value::Null),
            s if s == format!("{activity_name}TransitionCounter") => Value::from(self.activity.transition_counter()),
            s if s == content_name => Value::from(label_standard(self.content.level())),
            s if s == format!("{content_name}Message") => self.content.message().map(Value::from).unwrap_or(Value::Null),
            s if s == format!("{content_name}TransitionCounter") => Value::from(self.content.transition_counter()),
            "lostPacketCounters" | "latePacketCounters" | "transmissionErrorCounters" => {
                serde_json::json!(
                    counters()
                        .into_iter()
                        .map(|(name, description, value)| serde_json::json!({"name": name, "description": description, "value": value}))
                        .collect::<Vec<_>>()
                )
            }
            _ => return None,
        })
    }

    /// `PATCH /params/<prefix>.<name>` — nur die zwei schreibbaren Config-
    /// Properties, sonst `false` (Aufrufer meldet `SetError::ReadOnly`/
    /// `Unknown`).
    pub fn set(&self, prefix: &str, name: &str, value: &Value) -> Option<bool> {
        let suffix = name.strip_prefix(prefix)?.strip_prefix('.')?;
        match suffix {
            "statusReportingDelay" => {
                let ms = value.as_f64()?;
                self.set_status_reporting_delay(Duration::from_millis(ms.max(0.0) as u64));
                Some(true)
            }
            "autoResetCountersAndMessages" => {
                let enabled = value.as_bool()?;
                self.set_auto_reset_counters_and_messages(enabled);
                Some(true)
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn degradation_applies_immediately() {
        let d = DebouncedDomain::new(HealthLevel::Healthy);
        d.observe(HealthLevel::Unhealthy, Duration::from_secs(3), Some("lost sync"));
        assert_eq!(d.level(), HealthLevel::Unhealthy);
        assert_eq!(d.transition_counter(), 1);
        assert_eq!(d.message(), Some("lost sync".to_string()));
    }

    #[test]
    fn recovery_is_debounced_and_requires_sustained_observation() {
        let d = DebouncedDomain::new(HealthLevel::Unhealthy);
        // Ein einziger guter Messwert reicht nicht.
        d.observe(HealthLevel::Healthy, Duration::from_millis(50), None);
        assert_eq!(d.level(), HealthLevel::Unhealthy, "recovery must not apply before the delay elapses");
        std::thread::sleep(Duration::from_millis(60));
        d.observe(HealthLevel::Healthy, Duration::from_millis(50), Some("was unhealthy"));
        assert_eq!(d.level(), HealthLevel::Healthy, "recovery must apply once sustained past the delay");
        assert_eq!(d.message().unwrap(), "Previously: was unhealthy");
    }

    #[test]
    fn flickering_recovery_resets_the_pending_timer() {
        let d = DebouncedDomain::new(HealthLevel::Unhealthy);
        d.observe(HealthLevel::Healthy, Duration::from_millis(50), None);
        std::thread::sleep(Duration::from_millis(30));
        // Zurück zu Unhealthy vor Ablauf der Verzögerung — sofortige,
        // erneute Verschlechterung, UND der Erholungs-Timer verfällt.
        d.observe(HealthLevel::Unhealthy, Duration::from_millis(50), Some("flapped"));
        assert_eq!(d.level(), HealthLevel::Unhealthy);
        std::thread::sleep(Duration::from_millis(60));
        d.observe(HealthLevel::Healthy, Duration::from_millis(50), None);
        // Erster Healthy-Messwert nach dem Flapping — Timer muss NEU
        // gestartet sein, darf also noch nicht übernommen haben.
        assert_eq!(d.level(), HealthLevel::Unhealthy);
    }

    #[test]
    fn transition_counter_ignores_repeated_same_level_observations() {
        let d = DebouncedDomain::new(HealthLevel::Healthy);
        d.observe(HealthLevel::Healthy, Duration::from_secs(3), None);
        d.observe(HealthLevel::Healthy, Duration::from_secs(3), None);
        assert_eq!(d.transition_counter(), 0);
    }

    #[test]
    fn activate_forces_activity_and_content_to_healthy_but_leaves_link_and_sync() {
        let m = Monitor::new(MonitorKind::Receiver);
        m.link.observe(HealthLevel::Unhealthy, Duration::from_secs(3), None);
        m.deactivate();
        assert_eq!(m.activity.level(), HealthLevel::Neutral);
        assert_eq!(m.content.level(), HealthLevel::Neutral);
        m.activate();
        assert_eq!(m.activity.level(), HealthLevel::Healthy);
        assert_eq!(m.content.level(), HealthLevel::Healthy);
        // link ist von activate()/deactivate() unberührt.
        assert_eq!(m.link.level(), HealthLevel::Unhealthy);
    }

    #[test]
    fn overall_is_inactive_when_deactivated_regardless_of_link_or_sync() {
        let m = Monitor::new(MonitorKind::Sender);
        m.link.observe(HealthLevel::Unhealthy, Duration::from_secs(3), None);
        m.deactivate();
        assert_eq!(m.overall(), HealthLevel::Neutral);
    }

    #[test]
    fn overall_reflects_worst_domain_while_active() {
        let m = Monitor::new(MonitorKind::Receiver);
        m.activate();
        assert_eq!(m.overall(), HealthLevel::Healthy);
        m.sync.observe(HealthLevel::PartiallyHealthy, Duration::from_secs(3), None);
        assert_eq!(m.overall(), HealthLevel::PartiallyHealthy);
        m.activity.observe(HealthLevel::Unhealthy, Duration::from_secs(3), None);
        assert_eq!(m.overall(), HealthLevel::Unhealthy);
    }

    #[test]
    fn receiver_vs_sender_use_different_wire_names() {
        let r = Monitor::new(MonitorKind::Receiver);
        let s = Monitor::new(MonitorKind::Sender);
        let r_names: Vec<String> = r.param_specs("monitor").into_iter().map(|p| p.name).collect();
        let s_names: Vec<String> = s.param_specs("monitor").into_iter().map(|p| p.name).collect();
        assert!(r_names.contains(&"monitor.connectionStatus".to_string()));
        assert!(r_names.contains(&"monitor.streamStatus".to_string()));
        assert!(s_names.contains(&"monitor.transmissionStatus".to_string()));
        assert!(s_names.contains(&"monitor.essenceStatus".to_string()));
    }

    #[test]
    fn reset_clears_counters_and_messages() {
        let m = Monitor::new(MonitorKind::Receiver);
        m.link.observe(HealthLevel::Unhealthy, Duration::from_secs(3), Some("cable pulled"));
        assert_eq!(m.link.transition_counter(), 1);
        m.reset_counters_and_messages();
        assert_eq!(m.link.transition_counter(), 0);
        assert_eq!(m.link.message(), None);
        // Reset ändert den aktuell REPORTETEN Zustand nicht, nur Zähler/Meldungen.
        assert_eq!(m.link.level(), HealthLevel::Unhealthy);
    }

    #[test]
    fn get_dispatches_known_and_rejects_unknown_suffixes() {
        let m = Monitor::new(MonitorKind::Receiver);
        m.activate();
        assert_eq!(m.get("monitor", "monitor.overallStatus", None, Vec::new), Some(Value::from("Healthy")));
        assert_eq!(m.get("monitor", "monitor.doesNotExist", None, Vec::new), None);
        assert_eq!(m.get("other.overallStatus", "monitor.overallStatus", None, Vec::new), None);
    }

    #[test]
    fn set_accepts_only_the_two_writable_config_properties() {
        let m = Monitor::new(MonitorKind::Receiver);
        assert_eq!(m.set("monitor", "monitor.statusReportingDelay", &Value::from(5000)), Some(true));
        assert_eq!(m.status_reporting_delay(), Duration::from_millis(5000));
        assert_eq!(m.set("monitor", "monitor.autoResetCountersAndMessages", &Value::from(false)), Some(true));
        assert!(!m.auto_reset_counters_and_messages());
        assert_eq!(m.set("monitor", "monitor.overallStatus", &Value::from("Healthy")), None);
    }
}
