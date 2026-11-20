//! Überwachungsmodus von `omp-scope` (UMSETZUNG 106.13c): Signalfehler erkennen und als **Alarm bei Eintritt** und **Entwarnung
//! bei Ende** melden. Nichts hier ist ein Normwert, außer wo es dasteht: Schwellen und Haltezeiten sind **OMP-Voreinstellungen**
//! in Profilen (`monitor_profiles.json`, Daten, kein Festwert im Code); der Betreiber ändert sie zur Laufzeit.
//!
//! Prüfungen: `black`, `freeze`, `silence` (bestehende gehaltene Bedingungen aus `qc.rs`), neu `clipping`, `loudness`, `phase`,
//! `monoDropout`, `signalLoss`, `formatMismatch`. Jede Prüfung hat `enabled`, `threshold`, `holdSeconds` und einen Schweregrad.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const CHECKS: [&str; 9] = ["black", "freeze", "silence", "clipping", "loudness", "phase", "monoDropout", "signalLoss", "formatMismatch"];

/// Voreingestellte Profile (Daten, eingebettet; zur Laufzeit per `qc.profiles` ersetzbar).
pub const DEFAULT_PROFILES: &str = include_str!("monitor_profiles.json");

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckCfg {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub threshold: f64,
    #[serde(default)]
    pub hold_seconds: f64,
    #[serde(default = "default_severity")]
    pub severity: String,
    /// Nur `clipping`: so viele aufeinanderfolgende Samples am Anschlag zählen als Übersteuerung.
    #[serde(default)]
    pub min_samples: u32,
}

fn default_severity() -> String {
    "warning".into()
}

impl Default for CheckCfg {
    fn default() -> Self {
        CheckCfg { enabled: false, threshold: 0.0, hold_seconds: 0.0, severity: default_severity(), min_samples: 0 }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Profile {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub checks: BTreeMap<String, CheckCfg>,
}

pub type Profiles = BTreeMap<String, Profile>;

pub fn default_profiles() -> Profiles {
    serde_json::from_str(DEFAULT_PROFILES).expect("eingebettete Profile sind gültig")
}

/// Laufende Einstellung: gewähltes Profil plus Abweichungen je Prüfung („angepasst“).
#[derive(Clone, Debug)]
pub struct Settings {
    pub profile: String,
    pub profiles: Profiles,
    pub overrides: BTreeMap<String, CheckCfg>,
    /// Name der Leitung für den Alarmtext.
    pub line: String,
    /// Erwartetes Hausformat (JSON, wie es der Normalizer ausgibt); leer = keine Prüfung.
    pub expected_format: String,
}

impl Settings {
    pub fn new(profile: &str) -> Settings {
        Settings { profile: profile.to_string(), profiles: default_profiles(), overrides: BTreeMap::new(), line: String::new(), expected_format: String::new() }
    }

    /// Wirksame Einstellung einer Prüfung: Abweichung vor Profil, unbekanntes Profil oder Prüfung = aus.
    pub fn cfg(&self, check: &str) -> CheckCfg {
        if let Some(o) = self.overrides.get(check) {
            return o.clone();
        }
        self.profiles.get(&self.profile).and_then(|p| p.checks.get(check)).cloned().unwrap_or_default()
    }

    /// Profil wechseln: alle Abweichungen entfallen.
    pub fn set_profile(&mut self, name: &str) -> Result<(), String> {
        if !self.profiles.contains_key(name) {
            return Err(format!("unbekanntes Profil „{name}“"));
        }
        self.profile = name.to_string();
        self.overrides.clear();
        Ok(())
    }

    /// Abweichung für ein Feld einer Prüfung setzen (kopiert die Profilwerte beim ersten Mal).
    pub fn set_field(&mut self, check: &str, field: &str, v: &serde_json::Value) -> Result<(), String> {
        if !CHECKS.contains(&check) {
            return Err(format!("unbekannte Prüfung „{check}“"));
        }
        let mut c = self.cfg(check);
        match field {
            "enabled" => c.enabled = v.as_bool().ok_or("enabled: Wahrheitswert erwartet")?,
            "threshold" => c.threshold = v.as_f64().ok_or("threshold: Zahl erwartet")?,
            "holdSeconds" => c.hold_seconds = v.as_f64().filter(|x| *x >= 0.0 && *x <= 3600.0).ok_or("holdSeconds: 0 bis 3600")?,
            "severity" => {
                let s = v.as_str().ok_or("severity: Text erwartet")?;
                if !matches!(s, "info" | "warning" | "error" | "critical") {
                    return Err("severity: info, warning, error oder critical".into());
                }
                c.severity = s.to_string();
            }
            other => return Err(format!("unbekanntes Feld „{other}“")),
        }
        self.overrides.insert(check.to_string(), c);
        Ok(())
    }

    /// `true`, wenn die Prüfung vom Profil abweicht (für die Anzeige „angepasst“).
    pub fn is_customised(&self, check: &str) -> bool {
        self.overrides.get(check).is_some_and(|o| Some(o) != self.profiles.get(&self.profile).and_then(|p| p.checks.get(check)))
    }
}

/// Entprellung von Alarm und Entwarnung. Der Alarm kommt erst, wenn die Bedingung `hold` lang anliegt (macht der Aufrufer über
/// `Condition`); die **Entwarnung** erst, wenn sie `recover` lang weg war — damit ein flackernder Zustand nicht im Takt Alarm und
/// Entwarnung erzeugt.
#[derive(Clone, Debug, Default)]
pub struct AlarmGate {
    raised: bool,
    ok_since_ns: Option<u64>,
    recover_ns: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Raised,
    Cleared,
}

impl AlarmGate {
    pub fn new(recover_seconds: f64) -> Self {
        AlarmGate { raised: false, ok_since_ns: None, recover_ns: (recover_seconds * 1e9) as u64 }
    }
    pub fn is_raised(&self) -> bool {
        self.raised
    }
    /// `active` = die (bereits gehaltene) Bedingung liegt an. Gibt höchstens eine Flanke zurück.
    pub fn update(&mut self, active: bool, now_ns: u64) -> Option<Edge> {
        if active {
            self.ok_since_ns = None;
            if !self.raised {
                self.raised = true;
                return Some(Edge::Raised);
            }
            return None;
        }
        if !self.raised {
            return None;
        }
        let since = *self.ok_since_ns.get_or_insert(now_ns);
        if now_ns.saturating_sub(since) >= self.recover_ns {
            self.raised = false;
            self.ok_since_ns = None;
            return Some(Edge::Cleared);
        }
        None
    }
    /// Ein deaktivierte Prüfung darf keinen offenen Alarm festhalten: ohne Entwarnung zurücksetzen und sagen, ob einer offen war.
    pub fn reset(&mut self) -> bool {
        let was = self.raised;
        *self = AlarmGate::new(self.recover_ns as f64 / 1e9);
        was
    }
}

// ---- Audio-Messungen auf rohen Samples -----------------------------------------------------------------------------------

/// Längster Lauf aufeinanderfolgender Samples (eines Kanals, interleaved) mit |x| ≥ `level`.
pub fn clipping_run(samples: &[f32], channels: usize, level: f32) -> u32 {
    if channels == 0 {
        return 0;
    }
    let mut best = 0u32;
    for ch in 0..channels {
        let mut run = 0u32;
        let mut i = ch;
        while i < samples.len() {
            if samples[i].abs() >= level {
                run += 1;
                best = best.max(run);
            } else {
                run = 0;
            }
            i += channels;
        }
    }
    best
}

/// Korrelationsgrad L/R eines Blocks (−1 gegenphasig … +1 gleichphasig). `None`, wenn kein Pegel (Division durch ≈ 0).
pub fn correlation(samples: &[f32], channels: usize, l: usize, r: usize) -> Option<f64> {
    if channels == 0 || l >= channels || r >= channels {
        return None;
    }
    let (mut sl, mut sr, mut slr) = (0f64, 0f64, 0f64);
    let mut i = 0;
    while i + channels <= samples.len() {
        let (a, b) = (samples[i + l] as f64, samples[i + r] as f64);
        sl += a * a;
        sr += b * b;
        slr += a * b;
        i += channels;
    }
    let d = (sl * sr).sqrt();
    if d < 1e-9 { None } else { Some(slr / d) }
}

/// Spitzenpegel je Kanal in dBFS (−∞ als −200).
pub fn channel_peaks_db(samples: &[f32], channels: usize) -> Vec<f64> {
    let mut peaks = vec![0f32; channels];
    for (i, s) in samples.iter().enumerate() {
        let c = i % channels.max(1);
        peaks[c] = peaks[c].max(s.abs());
    }
    peaks.into_iter().map(|p| if p <= 0.0 { -200.0 } else { 20.0 * (p as f64).log10() }).collect()
}

/// Mono-Ausfall eines Stereopaars: ein Kanal still (unter `silent_db`), der andere aktiv (über `silent_db + 20`).
pub fn mono_dropout(peaks_db: &[f64], l: usize, r: usize, silent_db: f64) -> bool {
    match (peaks_db.get(l), peaks_db.get(r)) {
        (Some(a), Some(b)) => (*a < silent_db && *b > silent_db + 20.0) || (*b < silent_db && *a > silent_db + 20.0),
        _ => false,
    }
}

/// Weicht das ankommende Format vom erwarteten ab? Verglichen werden nur Felder, die im Erwarteten stehen.
pub fn format_mismatch(expected: &serde_json::Value, actual: &serde_json::Value) -> Option<String> {
    let mut diffs = Vec::new();
    if let Some(ev) = expected.get("video") {
        let av = actual.get("video");
        for (key, label) in [("width", "Breite"), ("height", "Höhe")] {
            if let (Some(e), Some(a)) = (ev.get(key).and_then(|x| x.as_u64()), av.and_then(|v| v.get(key)).and_then(|x| x.as_u64())) {
                if e != a {
                    diffs.push(format!("{label} {a} statt {e}"));
                }
            }
        }
        if let (Some(e), Some(a)) = (ev.get("rate").and_then(|x| x.as_str()), av.and_then(|v| v.get("rate")).and_then(|x| x.as_str())) {
            if !same_rate(e, a) {
                diffs.push(format!("Bildrate {a} statt {e}"));
            }
        }
    }
    if let Some(ea) = expected.get("audio") {
        let aa = actual.get("audio");
        if let (Some(e), Some(a)) = (ea.get("channels").and_then(|x| x.as_u64()), aa.and_then(|v| v.get("channels")).and_then(|x| x.as_u64())) {
            if e != a {
                diffs.push(format!("{a} Tonkanäle statt {e}"));
            }
        }
        if let (Some(e), Some(a)) = (ea.get("sampleRate").and_then(|x| x.as_u64()), aa.and_then(|v| v.get("sampleRate").or_else(|| v.get("sample_rate"))).and_then(|x| x.as_u64())) {
            if e != a {
                diffs.push(format!("Abtastrate {a} statt {e}"));
            }
        }
    }
    if diffs.is_empty() { None } else { Some(diffs.join(", ")) }
}

fn same_rate(a: &str, b: &str) -> bool {
    let p = |s: &str| {
        let (n, d) = s.split_once('/').unwrap_or((s, "1"));
        Some((n.trim().parse::<u64>().ok()?, d.trim().parse::<u64>().ok()?))
    };
    match (p(a), p(b)) {
        (Some((an, ad)), Some((bn, bd))) if ad > 0 && bd > 0 => an * bd == bn * ad,
        _ => a == b,
    }
}

/// Alarmtext je Prüfung (deutsch, Leitungsname vorn).
pub fn alarm_text(check: &str, line: &str, detail: &str) -> String {
    let what = match check {
        "black" => "Schwarzbild",
        "freeze" => "Standbild",
        "silence" => "Stille",
        "clipping" => "Übersteuerung (Clipping)",
        "loudness" => "Lautheit zu hoch",
        "phase" => "Phasenfehler (Stereo gegenphasig)",
        "monoDropout" => "Mono-Ausfall (ein Kanal still)",
        "signalLoss" => "Signalverlust",
        "formatMismatch" => "Format weicht vom Hausformat ab",
        other => other,
    };
    let head = if line.is_empty() { what.to_string() } else { format!("{line}: {what}") };
    if detail.is_empty() { head } else { format!("{head} ({detail})") }
}

// ---- Laufzeit: Messwerte sammeln, Prüfungen auswerten, Flanken erzeugen ----------------------------------------------------

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Eine Flanke einer Prüfung, bereit zum Senden.
#[derive(Clone, Debug, PartialEq)]
pub struct Alarm {
    pub check: &'static str,
    pub edge: Edge,
    pub severity: String,
    pub text: String,
}

/// Anzeige-Zustand einer Prüfung (Parameter `qc.status`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckStatus {
    pub check: &'static str,
    pub enabled: bool,
    pub active: bool,
    pub customised: bool,
    pub seconds: Option<f64>,
}

pub struct Runtime {
    pub settings: Mutex<Settings>,
    /// Ohne Waveform-/Vektorskop-Bild (nur Analysebild und Tonmessung), siehe `OMP_SCOPE_MODE=monitor`.
    pub monitor_mode: bool,
    since: Mutex<BTreeMap<&'static str, u64>>,
    gates: Mutex<BTreeMap<&'static str, AlarmGate>>,
    details: Mutex<BTreeMap<&'static str, String>>,
    last_video_ns: AtomicU64,
    last_audio_ns: AtomicU64,
    video_seen: AtomicBool,
    audio_seen: AtomicBool,
}

static RT: OnceLock<Arc<Runtime>> = OnceLock::new();

/// Die gemeinsame Laufzeit (wird beim ersten Zugriff mit Profil `standard` bzw. `OMP_SCOPE_PROFILE` angelegt).
pub fn rt() -> &'static Arc<Runtime> {
    RT.get_or_init(|| {
        let profile = std::env::var("OMP_SCOPE_PROFILE").ok().filter(|p| !p.is_empty()).unwrap_or_else(|| "standard".into());
        let mut st = Settings::new(&profile);
        if st.set_profile(&profile).is_err() {
            st = Settings::new("standard");
        }
        st.line = std::env::var("OMP_SCOPE_LINE").unwrap_or_default();
        st.expected_format = std::env::var("OMP_SCOPE_EXPECTED_FORMAT").unwrap_or_default();
        Arc::new(Runtime::new(st, std::env::var("OMP_SCOPE_MODE").is_ok_and(|m| m == "monitor")))
    })
}

impl Runtime {
    pub fn new(settings: Settings, monitor_mode: bool) -> Runtime {
        Runtime {
            settings: Mutex::new(settings),
            monitor_mode,
            since: Mutex::new(BTreeMap::new()),
            gates: Mutex::new(BTreeMap::new()),
            details: Mutex::new(BTreeMap::new()),
            last_video_ns: AtomicU64::new(0),
            last_audio_ns: AtomicU64::new(0),
            video_seen: AtomicBool::new(false),
            audio_seen: AtomicBool::new(false),
        }
    }

    pub fn cfg(&self, check: &str) -> CheckCfg {
        self.settings.lock().expect("lock poisoned").cfg(check)
    }

    /// Meldet, ob die Bedingung einer Prüfung gerade erfüllt ist (der Beginn wird gemerkt; die Haltezeit wertet `evaluate` aus).
    pub fn feed(&self, check: &'static str, met: bool, now_ns: u64, detail: Option<String>) {
        let mut m = self.since.lock().expect("lock poisoned");
        if met {
            m.entry(check).or_insert(now_ns);
            if let Some(d) = detail {
                self.details.lock().expect("lock poisoned").insert(check, d);
            }
        } else {
            m.remove(check);
        }
    }

    pub fn video_frame(&self, now_ns: u64) {
        self.last_video_ns.store(now_ns, Ordering::Relaxed);
        self.video_seen.store(true, Ordering::Relaxed);
    }
    pub fn audio_block(&self, now_ns: u64) {
        self.last_audio_ns.store(now_ns, Ordering::Relaxed);
        self.audio_seen.store(true, Ordering::Relaxed);
    }
    /// Verbindung getrennt/neu: kein Signalverlust aus einem früheren Fluss ableiten.
    pub fn reset_flow(&self, video: bool) {
        if video {
            self.video_seen.store(false, Ordering::Relaxed);
        } else {
            self.audio_seen.store(false, Ordering::Relaxed);
        }
    }

    /// Wertet alle Prüfungen aus und liefert die Flanken seit dem letzten Aufruf. `actual_format`: tatsächliches Format der
    /// verbundenen Flows als JSON (`{"video":{width,height,rate},"audio":{channels,sampleRate}}`).
    pub fn evaluate(&self, now_ns: u64, actual_format: &serde_json::Value) -> Vec<Alarm> {
        let st = self.settings.lock().expect("lock poisoned").clone();
        let mut out = Vec::new();
        let mut gates = self.gates.lock().expect("lock poisoned");
        for check in CHECKS {
            let cfg = st.cfg(check);
            let gate = gates.entry(check).or_insert_with(|| AlarmGate::new(2.0));
            let active = cfg.enabled && self.condition_active(check, &cfg, now_ns, &st, actual_format);
            if !cfg.enabled {
                if gate.reset() {
                    out.push(Alarm { check, edge: Edge::Cleared, severity: cfg.severity.clone(), text: alarm_text(check, &st.line, "") });
                }
                continue;
            }
            if let Some(edge) = gate.update(active, now_ns) {
                let detail = self.details.lock().expect("lock poisoned").get(check).cloned().unwrap_or_default();
                out.push(Alarm { check, edge, severity: cfg.severity.clone(), text: alarm_text(check, &st.line, if edge == Edge::Raised { &detail } else { "" }) });
            }
        }
        out
    }

    fn condition_active(&self, check: &'static str, cfg: &CheckCfg, now_ns: u64, st: &Settings, actual: &serde_json::Value) -> bool {
        let hold_ns = (cfg.hold_seconds * 1e9) as u64;
        match check {
            "signalLoss" => {
                let stale = |seen: &AtomicBool, last: &AtomicU64| seen.load(Ordering::Relaxed) && now_ns.saturating_sub(last.load(Ordering::Relaxed)) >= hold_ns.max(500_000_000);
                stale(&self.video_seen, &self.last_video_ns) || stale(&self.audio_seen, &self.last_audio_ns)
            }
            "formatMismatch" => {
                let expected: serde_json::Value = serde_json::from_str(&st.expected_format).unwrap_or(serde_json::Value::Null);
                match format_mismatch(&expected, actual) {
                    Some(d) => {
                        self.details.lock().expect("lock poisoned").insert("formatMismatch", d);
                        let mut m = self.since.lock().expect("lock poisoned");
                        let since = *m.entry("formatMismatch").or_insert(now_ns);
                        now_ns.saturating_sub(since) >= hold_ns
                    }
                    None => {
                        self.since.lock().expect("lock poisoned").remove("formatMismatch");
                        false
                    }
                }
            }
            _ => self.since.lock().expect("lock poisoned").get(check).is_some_and(|s| now_ns.saturating_sub(*s) >= hold_ns),
        }
    }

    pub fn status(&self, now_ns: u64) -> Vec<CheckStatus> {
        let st = self.settings.lock().expect("lock poisoned").clone();
        let gates = self.gates.lock().expect("lock poisoned");
        let since = self.since.lock().expect("lock poisoned");
        CHECKS
            .iter()
            .map(|c| CheckStatus {
                check: c,
                enabled: st.cfg(c).enabled,
                active: gates.get(c).is_some_and(|g| g.is_raised()),
                customised: st.is_customised(c),
                seconds: since.get(c).map(|s| now_ns.saturating_sub(*s) as f64 / 1e9),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 1_000_000_000;

    #[test]
    fn profiles_load_and_have_all_checks() {
        let p = default_profiles();
        for name in ["standard", "strict", "off"] {
            assert!(p.contains_key(name), "{name}");
        }
        for c in CHECKS {
            assert!(p["standard"].checks.contains_key(c), "standard fehlt {c}");
            assert!(p["strict"].checks.contains_key(c), "strict fehlt {c}");
            assert!(p["off"].checks.contains_key(c), "off fehlt {c}");
            assert!(!p["off"].checks[c].enabled);
        }
        assert!(p["standard"].checks["black"].hold_seconds > p["strict"].checks["black"].hold_seconds);
    }

    #[test]
    fn settings_override_profile_and_reset_on_profile_change() {
        let mut s = Settings::new("standard");
        assert_eq!(s.cfg("black").hold_seconds, 3.0);
        assert!(!s.is_customised("black"));
        s.set_field("black", "holdSeconds", &serde_json::json!(7)).unwrap();
        assert_eq!(s.cfg("black").hold_seconds, 7.0);
        assert!(s.is_customised("black"), "Abweichung vom Profil wird als angepasst erkannt");
        s.set_profile("strict").unwrap();
        assert_eq!(s.cfg("black").hold_seconds, 1.0, "Profilwechsel verwirft Abweichungen");
        assert!(s.set_profile("gibtsnicht").is_err());
        assert!(s.set_field("gibtsnicht", "enabled", &serde_json::json!(true)).is_err());
        assert!(s.set_field("black", "holdSeconds", &serde_json::json!(-1)).is_err());
        s.set_profile("off").unwrap();
        assert!(!s.cfg("black").enabled && !s.cfg("signalLoss").enabled, "Profil off: alles aus");
    }

    #[test]
    fn gate_raises_once_and_clears_only_after_recovery() {
        let mut g = AlarmGate::new(2.0);
        assert_eq!(g.update(false, 0), None);
        assert_eq!(g.update(true, S), Some(Edge::Raised));
        assert_eq!(g.update(true, 2 * S), None, "kein zweiter Alarm");
        assert_eq!(g.update(false, 3 * S), None);
        assert_eq!(g.update(false, 4 * S), None, "erst nach 2 s Ruhe");
        assert_eq!(g.update(true, 4 * S + 500_000_000), None, "Flattern: kein neuer Alarm, kein Ende");
        assert_eq!(g.update(false, 5 * S), None);
        assert_eq!(g.update(false, 7 * S), Some(Edge::Cleared));
        assert_eq!(g.update(false, 8 * S), None, "Entwarnung nur einmal");
    }

    #[test]
    fn clean_signal_never_alarms() {
        // 1 kHz bei −18 dBFS, Stereo korreliert, 60 s in Blöcken von 20 ms
        let mut clip_gate = AlarmGate::new(1.0);
        let mut phase_gate = AlarmGate::new(1.0);
        let mut mono_gate = AlarmGate::new(1.0);
        let amp = 10f32.powf(-18.0 / 20.0);
        for blk in 0..3000u64 {
            let mut buf = Vec::with_capacity(960 * 2);
            for n in 0..960u64 {
                let t = (blk * 960 + n) as f32 / 48_000.0;
                let v = amp * (2.0 * std::f32::consts::PI * 1000.0 * t).sin();
                buf.push(v);
                buf.push(v);
            }
            let now = blk * 20_000_000;
            assert_eq!(clip_gate.update(clipping_run(&buf, 2, 0.999) >= 4, now), None);
            assert_eq!(phase_gate.update(correlation(&buf, 2, 0, 1).is_some_and(|c| c < -0.5), now), None);
            assert_eq!(mono_gate.update(mono_dropout(&channel_peaks_db(&buf, 2), 0, 1, -50.0), now), None);
        }
    }

    #[test]
    fn clipping_needs_consecutive_samples() {
        let mut buf = vec![0.1f32; 40];
        buf[10] = 1.0; // einzelnes Sample am Anschlag (Stereo: Kanal 0, Index 10 → Kanal 0)
        assert_eq!(clipping_run(&buf, 2, 0.999), 1, "ein Sample reicht nicht (min 4)");
        for i in [20, 22, 24, 26] {
            buf[i] = -1.0; // vier aufeinanderfolgende Samples von Kanal 0
        }
        assert_eq!(clipping_run(&buf, 2, 0.999), 4);
    }

    #[test]
    fn antiphase_and_mono_dropout_are_detected() {
        let mut anti = Vec::new();
        let mut mono = Vec::new();
        for n in 0..960 {
            let v = 0.1 * (2.0 * std::f32::consts::PI * 1000.0 * n as f32 / 48_000.0).sin();
            anti.push(v);
            anti.push(-v);
            mono.push(v);
            mono.push(0.0);
        }
        assert!(correlation(&anti, 2, 0, 1).unwrap() < -0.99);
        assert_eq!(correlation(&mono, 2, 0, 1), None, "ein stummer Kanal hat keine Korrelation");
        assert!(mono_dropout(&channel_peaks_db(&mono, 2), 0, 1, -50.0));
        assert!(!mono_dropout(&channel_peaks_db(&anti, 2), 0, 1, -50.0), "gegenphasig ist kein Mono-Ausfall");
        assert_eq!(correlation(&vec![0.0; 100], 2, 0, 1), None, "ohne Pegel keine Korrelation");
    }

    #[test]
    fn format_mismatch_compares_only_given_fields() {
        let exp = serde_json::json!({"video":{"width":1920,"height":1080,"rate":"25/1"},"audio":{"channels":2,"sampleRate":48000}});
        let ok = serde_json::json!({"video":{"width":1920,"height":1080,"rate":"50/2"},"audio":{"channels":2,"sampleRate":48000}});
        assert_eq!(format_mismatch(&exp, &ok), None, "50/2 = 25/1");
        let bad = serde_json::json!({"video":{"width":1280,"height":720,"rate":"50/1"},"audio":{"channels":2,"sampleRate":48000}});
        let d = format_mismatch(&exp, &bad).unwrap();
        assert!(d.contains("Breite 1280 statt 1920") && d.contains("Bildrate 50/1 statt 25/1"), "{d}");
        assert_eq!(format_mismatch(&serde_json::json!({}), &bad), None, "nichts erwartet = nichts geprüft");
    }

    #[test]
    fn alarm_texts_name_the_line() {
        assert_eq!(alarm_text("black", "PGM", "4 s"), "PGM: Schwarzbild (4 s)");
        assert_eq!(alarm_text("signalLoss", "", ""), "Signalverlust");
    }

    fn rt_with(profile: &str) -> Runtime {
        Runtime::new(Settings::new(profile), false)
    }

    #[test]
    fn black_for_4s_gives_exactly_one_alarm_and_one_clear_standard_profile() {
        let r = rt_with("standard"); // Schwarz: Haltezeit 3 s
        let none = serde_json::json!({});
        let mut alarms = Vec::new();
        for ms in (0..12_000u64).step_by(40) {
            let now = ms * 1_000_000;
            let black = (2_000..6_000).contains(&ms); // 4 s schwarz
            r.feed("black", black, now, None);
            alarms.extend(r.evaluate(now, &none));
        }
        assert_eq!(alarms.iter().filter(|a| a.edge == Edge::Raised).count(), 1, "{alarms:?}");
        assert_eq!(alarms.iter().filter(|a| a.edge == Edge::Cleared).count(), 1, "{alarms:?}");
        assert!(alarms[0].text.contains("Schwarzbild"));
    }

    #[test]
    fn black_1s_under_hold_3s_gives_no_alarm_and_off_profile_never_alarms() {
        let r = rt_with("standard");
        let none = serde_json::json!({});
        let mut n = 0;
        for ms in (0..6_000u64).step_by(40) {
            r.feed("black", (1_000..2_000).contains(&ms), ms * 1_000_000, None);
            n += r.evaluate(ms * 1_000_000, &none).len();
        }
        assert_eq!(n, 0, "1 s Schwarz bei Haltezeit 3 s");
        let off = rt_with("off");
        for ms in (0..20_000u64).step_by(40) {
            off.feed("black", true, ms * 1_000_000, None);
            off.feed("silence", true, ms * 1_000_000, None);
            assert!(off.evaluate(ms * 1_000_000, &none).is_empty(), "Profil off: nie ein Alarm");
        }
    }

    #[test]
    fn signal_loss_after_hold_and_only_for_seen_flows() {
        let r = rt_with("standard"); // signalLoss Haltezeit 2 s
        let none = serde_json::json!({});
        assert!(r.evaluate(10 * S, &none).is_empty(), "ohne gesehenen Fluss kein Verlust");
        for ms in (0..1_000u64).step_by(40) {
            r.video_frame(ms * 1_000_000);
        }
        assert!(r.evaluate(2 * S, &none).is_empty(), "nach 1 s Pause noch kein Alarm");
        let a = r.evaluate(4 * S, &none);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].check, "signalLoss");
        assert_eq!(a[0].edge, Edge::Raised);
    }

    #[test]
    fn format_mismatch_uses_expected_format_and_names_difference() {
        let r = rt_with("standard");
        r.settings.lock().unwrap().expected_format = r#"{"video":{"width":1920,"height":1080}}"#.to_string();
        let actual = serde_json::json!({"video":{"width":1280,"height":720}});
        let mut raised = None;
        for ms in (0..5_000u64).step_by(100) {
            for a in r.evaluate(ms * 1_000_000, &actual) {
                if a.edge == Edge::Raised {
                    raised = Some(a);
                }
            }
        }
        let a = raised.expect("Formatabweichung wird gemeldet");
        assert!(a.text.contains("Breite 1280 statt 1920"), "{}", a.text);
    }

    #[test]
    fn disabling_a_check_clears_an_open_alarm() {
        let r = rt_with("standard");
        let none = serde_json::json!({});
        for ms in (0..7_000u64).step_by(40) {
            r.feed("silence", true, ms * 1_000_000, None);
            r.evaluate(ms * 1_000_000, &none);
        }
        assert!(r.status(7 * S).iter().find(|c| c.check == "silence").unwrap().active);
        r.settings.lock().unwrap().set_field("silence", "enabled", &serde_json::json!(false)).unwrap();
        let a = r.evaluate(7 * S + 40_000_000, &none);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].edge, Edge::Cleared, "abgeschaltete Prüfung hält keinen Alarm fest");
    }
}
