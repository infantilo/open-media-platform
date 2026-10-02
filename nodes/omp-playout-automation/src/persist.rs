//! Kapitel 27 / P1b (`UMSETZUNG.md` §27): Persistenz des Automationszustands
//! über die Orchestrator-Domäne `playout` (E1 = Postgres, E2 = eine
//! Instanz pro Channel).
//!
//! Der Node hält keine Datenbank. Er findet seinen Channel über die eigene
//! Instanz-ID (`GET /api/v1/playout/channels?instanceId=…`), schreibt einen
//! Snapshot (versioniert, Optimistic Concurrency) und stellt ihn beim Start
//! wieder her. Ohne gebundenen Channel bleibt der Node voll funktionsfähig,
//! nur eben ohne Persistenz — kein stiller Fehler, der Status steht im
//! Parameter `persistence`.
//!
//! **Restart-Regel (Spec §115/§116: nicht blind erneut ausführen):**
//! wiederhergestellt werden Playlist, Cursor, Modus, Carts-Definitionen,
//! Zähler, Kanal A/B und der Fixtime-Stand (`fixtime_resolved`, damit
//! bereits gefeuerte Events nicht erneut feuern). **Nicht** wiederhergestellt
//! werden Zeitplan-Einträge im Speicher (Grafik-Kinder: `Instant`-basiert,
//! nach einem Neustart nicht sinnvoll nachholbar) und ein aktiver Cart
//! (Interrupt-Rückweg unklar) — beides wird dem Operator gemeldet statt still
//! verworfen. Ein on-air Item läuft nur dann weiter, wenn es laut
//! Wanduhr (UTC, E5) noch innerhalb seiner Dauer liegt; ist es inzwischen
//! abgelaufen, bleibt es gecued, aber NICHT on-air und es wird nichts
//! automatisch genommen — der Operator entscheidet.
//!
//! Der Abgleich mit dem tatsächlichen Zustand von Player/Mixer
//! (Spec §115, „reconcile") ist ausdrücklich noch NICHT Teil von P1b.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::playlist::Mode;
use crate::remote::OrchestratorAuth;
use crate::{AutomationState, AutomationStore, Channel, FixtimeResolution, ItemMeta};

pub const SNAPSHOT_SCHEMA: u32 = 1;
const PERSIST_TICK: Duration = Duration::from_secs(1);
/// Channel-Suche ohne Treffer: nicht jede Sekunde nachfragen.
const LOOKUP_EVERY_TICKS: u32 = 5;
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapItem {
    pub id: String,
    pub meta: ItemMeta,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapCart {
    pub id: String,
    pub meta: ItemMeta,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub schema: u32,
    pub items: Vec<SnapItem>,
    pub current_index: Option<usize>,
    pub on_air: bool,
    pub mode: Mode,
    pub next_item_seq: u64,
    pub next_cart_seq: u64,
    /// "a" | "b"
    pub live_channel: String,
    pub last_live_item_id: Option<String>,
    /// Start des on-air Items in UTC-Millisekunden (E5).
    pub onair_since_utc_ms: Option<i64>,
    pub carts: Vec<SnapCart>,
    /// Nur zur Meldung beim Restart (der Cart selbst wird nicht wiederhergestellt).
    pub active_cart_id: Option<String>,
    /// Item-ID → "precued" | "fired" | "skipped".
    pub fixtime_resolved: HashMap<String, String>,
    pub target_player_a_label: String,
    pub target_player_b_label: String,
    pub target_mixer_label: String,
    pub target_graphics_label: String,
}

fn resolution_name(r: FixtimeResolution) -> &'static str {
    match r {
        FixtimeResolution::PreCued => "precued",
        FixtimeResolution::Fired => "fired",
        FixtimeResolution::Skipped => "skipped",
    }
}

fn resolution_from(s: &str) -> Option<FixtimeResolution> {
    match s {
        "precued" => Some(FixtimeResolution::PreCued),
        "fired" => Some(FixtimeResolution::Fired),
        "skipped" => Some(FixtimeResolution::Skipped),
        _ => None,
    }
}

/// Cache für die Umrechnung `Instant` → UTC-ms: derselbe `Instant` muss bei
/// jedem Snapshot denselben Wert ergeben, sonst sähe jeder Tick wie eine
/// Änderung aus (Millisekunden-Jitter) und würde neu geschrieben.
pub type SinceCache = Option<(Instant, i64)>;

pub fn build_snapshot(state: &AutomationState, since_cache: &mut SinceCache, now_utc_ms: i64) -> Snapshot {
    let onair_since_utc_ms = match state.onair_since {
        None => {
            *since_cache = None;
            None
        }
        Some(since) => match since_cache {
            Some((cached, ms)) if *cached == since => Some(*ms),
            _ => {
                let ms = now_utc_ms - since.elapsed().as_millis() as i64;
                *since_cache = Some((since, ms));
                Some(ms)
            }
        },
    };
    Snapshot {
        schema: SNAPSHOT_SCHEMA,
        items: state
            .playlist
            .items()
            .iter()
            .filter_map(|id| state.metadata.get(id).map(|m| SnapItem { id: id.clone(), meta: m.clone() }))
            .collect(),
        current_index: state.playlist.current_index(),
        on_air: state.playlist.on_air(),
        mode: state.playlist.mode(),
        next_item_seq: state.next_item_seq,
        next_cart_seq: state.next_cart_seq,
        live_channel: match state.live_channel {
            Channel::A => "a".to_string(),
            Channel::B => "b".to_string(),
        },
        last_live_item_id: state.last_live_item_id.clone(),
        onair_since_utc_ms,
        carts: state.carts.iter().map(|(id, m)| SnapCart { id: id.clone(), meta: m.clone() }).collect(),
        active_cart_id: state.active_cart.as_ref().map(|a| a.asset_id.clone()),
        fixtime_resolved: state
            .fixtime_resolved
            .iter()
            .map(|(id, r)| (id.clone(), resolution_name(*r).to_string()))
            .collect(),
        target_player_a_label: state.target_player_a_label.clone(),
        target_player_b_label: state.target_player_b_label.clone(),
        target_mixer_label: state.target_mixer_label.clone(),
        target_graphics_label: state.target_graphics_label.clone(),
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct RestoreReport {
    pub restored_items: usize,
    pub resumed_on_air: bool,
    /// Meldungen für den Operator (Alert-Kanal).
    pub notices: Vec<String>,
}

/// Wendet einen Snapshot auf einen FRISCHEN Zustand an (Aufrufer prüft,
/// dass der Node noch leer ist). Reine Funktion bis auf `Instant::now()`.
pub fn apply_snapshot(state: &mut AutomationState, snap: Snapshot, now_utc_ms: i64) -> Result<RestoreReport, String> {
    if snap.schema != SNAPSHOT_SCHEMA {
        return Err(format!("Snapshot-Schema {} wird nicht unterstützt (erwartet {SNAPSHOT_SCHEMA})", snap.schema));
    }
    let mut report = RestoreReport::default();

    let ids: Vec<String> = snap.items.iter().map(|i| i.id.clone()).collect();
    state.metadata = snap.items.into_iter().map(|i| (i.id, i.meta)).collect();
    state.playlist.restore(ids, snap.current_index, snap.on_air, snap.mode);
    state.timeline.invalidate_from(0);
    report.restored_items = state.playlist.items().len();

    state.next_item_seq = state.next_item_seq.max(snap.next_item_seq);
    state.next_cart_seq = state.next_cart_seq.max(snap.next_cart_seq);
    state.live_channel = if snap.live_channel == "b" { Channel::B } else { Channel::A };
    state.carts = snap.carts.into_iter().map(|c| (c.id, c.meta)).collect();
    state.fixtime_resolved = snap
        .fixtime_resolved
        .into_iter()
        .filter(|(id, _)| state.metadata.contains_key(id))
        .filter_map(|(id, r)| resolution_from(&r).map(|r| (id, r)))
        .collect();

    // Env-Vorgaben haben Vorrang vor dem Gespeicherten.
    for (cur, saved) in [
        (&mut state.target_player_a_label, snap.target_player_a_label),
        (&mut state.target_player_b_label, snap.target_player_b_label),
        (&mut state.target_mixer_label, snap.target_mixer_label),
        (&mut state.target_graphics_label, snap.target_graphics_label),
    ] {
        if cur.is_empty() {
            *cur = saved;
        }
    }

    state.last_live_item_id = snap.last_live_item_id.filter(|id| state.metadata.contains_key(id));

    // On-Air-Rekonstruktion anhand der Wanduhr (UTC).
    state.onair_since = None;
    if state.playlist.on_air() {
        let idx = state.playlist.current_index();
        let meta = idx.and_then(|i| state.playlist.items().get(i)).and_then(|id| state.metadata.get(id));
        let (label, duration_ms) = meta.map(|m| (m.label.clone(), m.duration_ms)).unwrap_or_default();
        let elapsed_ms = snap.onair_since_utc_ms.map(|s| (now_utc_ms - s).max(0) as u64);
        match elapsed_ms {
            // 0 = endlos (Live/manuell): läuft weiter.
            Some(e) if duration_ms == 0 || e <= duration_ms => {
                state.onair_since = Instant::now().checked_sub(Duration::from_millis(e)).or_else(|| Some(Instant::now()));
                report.resumed_on_air = true;
                report.notices.push(format!(
                    "Neustart: „{label}\u{201c} läuft laut Snapshot weiter ({}s von {}s) — Zustand der Player nicht abgeglichen",
                    e / 1000,
                    duration_ms / 1000
                ));
            }
            _ => {
                // Abgelaufen oder Startzeit unbekannt: nichts automatisch tun.
                state.playlist.restore(
                    state.playlist.items().to_vec(),
                    state.playlist.current_index(),
                    false,
                    state.playlist.mode(),
                );
                report.notices.push(format!(
                    "Neustart: „{label}\u{201c} war laut Snapshot on air, ist aber inzwischen abgelaufen — nicht automatisch fortgesetzt, Operator entscheidet"
                ));
            }
        }
    } else {
        // Nicht on-air: last_live_item_id bleibt (der Mixer zeigt weiter das letzte Item).
    }

    if let Some(cart) = snap.active_cart_id {
        report.notices.push(format!(
            "Neustart: Cart „{cart}\u{201c} war aktiv — Interrupt nicht wiederhergestellt, Mixer-Zustand prüfen"
        ));
    }
    Ok(report)
}

// ---- HTTP-Client (blockierend; Aufrufer nutzt spawn_blocking) ------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct ChannelInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug)]
pub enum PutError {
    Conflict,
    Other(String),
}

#[derive(Debug, Clone)]
pub struct PersistClient {
    base: String,
    instance_id: String,
    auth: OrchestratorAuth,
}

impl PersistClient {
    fn header(&self) -> Result<String, String> {
        self.auth.header_value().ok_or_else(|| "kein Service-Token verfügbar".to_string())
    }

    fn url(&self, tail: &str) -> String {
        format!("{}/api/v1/playout/channels{}", self.base.trim_end_matches('/'), tail)
    }

    pub fn find_channel(&self) -> Result<Option<ChannelInfo>, String> {
        let h = self.header()?;
        let url = format!("{}?instanceId={}", self.url(""), self.instance_id);
        let mut resp = ureq::get(&url)
            .config()
            .timeout_global(Some(HTTP_TIMEOUT))
            .build()
            .header("Authorization", &h)
            .call()
            .map_err(|e| e.to_string())?;
        let list: Vec<ChannelInfo> = resp.body_mut().read_json().map_err(|e| e.to_string())?;
        Ok(list.into_iter().next())
    }

    /// `None` = noch nie ein Zustand geschrieben (404).
    pub fn get_state(&self, channel_id: &str) -> Result<Option<(i64, serde_json::Value)>, String> {
        let h = self.header()?;
        let url = self.url(&format!("/{channel_id}/state"));
        match ureq::get(&url).config().timeout_global(Some(HTTP_TIMEOUT)).build().header("Authorization", &h).call() {
            Ok(mut resp) => {
                #[derive(Deserialize)]
                struct St {
                    version: i64,
                    state: serde_json::Value,
                }
                let st: St = resp.body_mut().read_json().map_err(|e| e.to_string())?;
                Ok(Some((st.version, st.state)))
            }
            Err(ureq::Error::StatusCode(404)) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn put_state(&self, channel_id: &str, version: i64, body: &str) -> Result<i64, PutError> {
        let h = self.header().map_err(PutError::Other)?;
        let url = self.url(&format!("/{channel_id}/state?version={version}"));
        match ureq::put(&url)
            .config()
            .timeout_global(Some(HTTP_TIMEOUT))
            .build()
            .header("Authorization", &h)
            .header("Content-Type", "application/json")
            .send(body)
        {
            Ok(mut resp) => {
                #[derive(Deserialize)]
                struct St {
                    version: i64,
                }
                let st: St = resp.body_mut().read_json().map_err(|e| PutError::Other(e.to_string()))?;
                Ok(st.version)
            }
            Err(ureq::Error::StatusCode(409)) => Err(PutError::Conflict),
            Err(e) => Err(PutError::Other(e.to_string())),
        }
    }

    /// `true` = erste Ausführung, `false` = bereits protokolliert.
    pub fn record_execution(&self, channel_id: &str, execution_id: &str, kind: &str) -> Result<bool, String> {
        let h = self.header()?;
        let url = self.url(&format!("/{channel_id}/executions"));
        let mut resp = ureq::post(&url)
            .config()
            .timeout_global(Some(HTTP_TIMEOUT))
            .build()
            .header("Authorization", &h)
            .send_json(serde_json::json!({ "executionId": execution_id, "kind": kind }))
            .map_err(|e| e.to_string())?;
        #[derive(Deserialize)]
        struct R {
            first: bool,
        }
        let r: R = resp.body_mut().read_json().map_err(|e| e.to_string())?;
        Ok(r.first)
    }
}

// ---- Laufender Zustand der Anbindung -------------------------------------------------------------

#[derive(Default)]
struct Inner {
    channel: Option<ChannelInfo>,
    version: i64,
    loaded: bool,
    last_written: Option<String>,
    since_cache: SinceCache,
    status: String,
    last_error: Option<String>,
    ticks_since_lookup: u32,
}

pub struct Persistence {
    client: Option<PersistClient>,
    inner: Mutex<Inner>,
}

/// Ergebnis von [`Persistence::claim_execution`].
#[derive(Debug, PartialEq, Eq)]
pub enum Claim {
    /// Erste Ausführung (oder Persistenz nicht verfügbar → best effort, siehe Doku).
    Proceed,
    /// Bereits ausgeführt (Restart/Retry) — NICHT erneut ausführen.
    AlreadyDone,
}

impl Persistence {
    pub fn new(instance_id: Option<String>, orchestrator_url: String, auth: OrchestratorAuth) -> Self {
        let client = instance_id.map(|instance_id| PersistClient { base: orchestrator_url, instance_id, auth });
        let status = if client.is_some() {
            "Channel wird gesucht".to_string()
        } else {
            "deaktiviert (keine Instanz-ID/Launch-Secret)".to_string()
        };
        Persistence { client, inner: Mutex::new(Inner { status, ..Inner::default() }) }
    }

    pub fn channel_id(&self) -> String {
        self.inner.lock().expect("lock poisoned").channel.as_ref().map(|c| c.id.clone()).unwrap_or_default()
    }

    pub fn channel_name(&self) -> String {
        self.inner.lock().expect("lock poisoned").channel.as_ref().map(|c| c.name.clone()).unwrap_or_default()
    }

    pub fn status(&self) -> String {
        self.inner.lock().expect("lock poisoned").status.clone()
    }

    /// Trägt eine Aktion VOR ihrer Ausführung ins Journal ein (at-most-once,
    /// Spec §56/§116/§190). Ist die Persistenz nicht erreichbar (kein
    /// Channel, Orchestrator down), wird trotzdem `Proceed` geliefert:
    /// ein verpasstes Fixtime-Event auf Sendung wiegt schwerer als das
    /// seltene Risiko einer Doppelausführung nach Absturz UND gleichzeitigem
    /// Datenbankausfall — der Fehler wird gemeldet.
    pub fn claim_execution(&self, execution_id: &str, kind: &str) -> (Claim, Option<String>) {
        let Some(client) = &self.client else { return (Claim::Proceed, None) };
        let Some(channel_id) = self.inner.lock().expect("lock poisoned").channel.as_ref().map(|c| c.id.clone()) else {
            return (Claim::Proceed, None);
        };
        match client.record_execution(&channel_id, execution_id, kind) {
            Ok(true) => (Claim::Proceed, None),
            Ok(false) => (Claim::AlreadyDone, None),
            Err(e) => (Claim::Proceed, Some(format!("Ausführungsjournal nicht erreichbar ({e}) — „{execution_id}\u{201c} wird trotzdem ausgeführt"))),
        }
    }
}

fn now_utc_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Ein Persistenz-Schritt (blockierend). Reihenfolge: Channel finden →
/// Zustand laden/wiederherstellen → danach erst schreiben (nie vor dem
/// Laden, sonst würde ein leerer Neustart den gespeicherten Zustand
/// überschreiben).
fn persist_tick(store: &AutomationStore) {
    let p = &store.persistence;
    let Some(client) = p.client.clone() else { return };

    let (channel, loaded) = {
        let inner = p.inner.lock().expect("lock poisoned");
        (inner.channel.clone(), inner.loaded)
    };

    let Some(channel) = channel else {
        {
            let mut inner = p.inner.lock().expect("lock poisoned");
            inner.ticks_since_lookup += 1;
            if inner.ticks_since_lookup < LOOKUP_EVERY_TICKS && inner.ticks_since_lookup != 1 {
                return;
            }
            if inner.ticks_since_lookup >= LOOKUP_EVERY_TICKS {
                inner.ticks_since_lookup = 0;
            }
        }
        match client.find_channel() {
            Ok(Some(ch)) => {
                let mut inner = p.inner.lock().expect("lock poisoned");
                inner.status = format!("Channel „{}\u{201c} gefunden, Zustand wird geladen", ch.name);
                inner.channel = Some(ch);
                inner.last_error = None;
            }
            Ok(None) => {
                p.inner.lock().expect("lock poisoned").status =
                    "kein Channel an diese Instanz gebunden (Persistenz aus)".to_string();
            }
            Err(e) => {
                p.inner.lock().expect("lock poisoned").status = format!("Channel-Suche fehlgeschlagen: {e}");
            }
        }
        return;
    };

    if !loaded {
        match client.get_state(&channel.id) {
            Ok(None) => {
                let mut inner = p.inner.lock().expect("lock poisoned");
                inner.version = 0;
                inner.loaded = true;
                inner.status = format!("Channel „{}\u{201c}: neuer Zustand", channel.name);
            }
            Ok(Some((version, value))) => match serde_json::from_value::<Snapshot>(value) {
                Ok(snap) => {
                    let mut notices = Vec::new();
                    {
                        let mut state = store.state.lock().expect("lock poisoned");
                        if state.playlist.items().is_empty() && state.metadata.is_empty() {
                            match apply_snapshot(&mut state, snap, now_utc_ms()) {
                                Ok(rep) => notices.extend(rep.notices),
                                Err(e) => notices.push(format!("Snapshot nicht angewendet: {e}")),
                            }
                        } else {
                            notices.push(
                                "Snapshot nicht angewendet: der Node wurde schon vor der Wiederherstellung bedient — gespeicherter Zustand wird überschrieben"
                                    .to_string(),
                            );
                        }
                    }
                    for n in notices {
                        store.report(n);
                    }
                    let mut inner = p.inner.lock().expect("lock poisoned");
                    inner.version = version;
                    inner.loaded = true;
                    inner.status = format!("Channel „{}\u{201c}: Zustand wiederhergestellt (v{version})", channel.name);
                }
                Err(e) => {
                    // NICHT als geladen markieren: sonst würde der nächste
                    // Schreibvorgang den (unlesbaren) Zustand überschreiben.
                    let msg = format!("Snapshot nicht lesbar: {e}");
                    let mut inner = p.inner.lock().expect("lock poisoned");
                    inner.status = msg.clone();
                    if inner.last_error.as_deref() != Some(&msg) {
                        inner.last_error = Some(msg.clone());
                        drop(inner);
                        store.report(msg);
                    }
                }
            },
            Err(e) => {
                p.inner.lock().expect("lock poisoned").status = format!("Zustand laden fehlgeschlagen: {e}");
            }
        }
        return;
    }

    // Schreiben, wenn sich etwas geändert hat.
    let body = {
        let state = store.state.lock().expect("lock poisoned");
        let mut inner = p.inner.lock().expect("lock poisoned");
        let snap = build_snapshot(&state, &mut inner.since_cache, now_utc_ms());
        match serde_json::to_string(&snap) {
            Ok(b) => b,
            Err(e) => {
                inner.status = format!("Snapshot nicht serialisierbar: {e}");
                return;
            }
        }
    };
    let (version, unchanged) = {
        let inner = p.inner.lock().expect("lock poisoned");
        (inner.version, inner.last_written.as_deref() == Some(body.as_str()))
    };
    if unchanged {
        return;
    }
    match client.put_state(&channel.id, version, &body) {
        Ok(new_version) => {
            let mut inner = p.inner.lock().expect("lock poisoned");
            inner.version = new_version;
            inner.last_written = Some(body);
            inner.last_error = None;
            inner.status = format!("Channel „{}\u{201c}: gespeichert (v{new_version})", channel.name);
        }
        Err(PutError::Conflict) => {
            // Ein anderer Schreiber war dazwischen: Version neu holen, der
            // Speicher dieses Nodes bleibt maßgeblich und wird im nächsten
            // Tick mit der neuen Version geschrieben.
            let refreshed = client.get_state(&channel.id);
            let mut inner = p.inner.lock().expect("lock poisoned");
            match refreshed {
                Ok(Some((v, _))) => {
                    inner.version = v;
                    inner.status = format!("Versionskonflikt (v{v} auf dem Server) — wird erneut geschrieben");
                }
                _ => inner.status = "Versionskonflikt, Version nicht abrufbar".to_string(),
            }
            drop(inner);
            store.report("Playout-Zustand: Versionskonflikt beim Speichern (anderer Schreiber?) — wird mit neuer Version erneut geschrieben".to_string());
        }
        Err(PutError::Other(e)) => {
            let mut inner = p.inner.lock().expect("lock poisoned");
            inner.status = format!("Speichern fehlgeschlagen: {e}");
            if inner.last_error.as_deref() != Some(&e) {
                inner.last_error = Some(e.clone());
                drop(inner);
                store.report(format!("Playout-Zustand konnte nicht gespeichert werden: {e}"));
            }
        }
    }
}

pub async fn persist_loop(store: Arc<AutomationStore>) {
    let mut interval = tokio::time::interval(PERSIST_TICK);
    loop {
        interval.tick().await;
        let store2 = store.clone();
        let _ = tokio::task::spawn_blocking(move || persist_tick(&store2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GraphicsChild, ItemMedia, RelativeTo, StartType, Transition};

    fn meta(label: &str, duration_ms: u64) -> ItemMeta {
        ItemMeta {
            label: label.to_string(),
            media: ItemMedia::File { path: format!("{label}.mp4") },
            duration_ms,
            start_type: StartType::Sequence,
            fixtime_hms: None,
            transition: Transition::Cut,
            transition_rate_frames: None,
            children: vec![GraphicsChild {
                template_id: "lt".to_string(),
                data: serde_json::json!({"name": "X"}),
                delay_ms: 1000,
                duration_ms: 2000,
                relative_to: RelativeTo::Start,
            }],
        }
    }

    fn state_with_three_items() -> AutomationState {
        let mut s = AutomationState::new(String::new(), String::new(), String::new(), String::new());
        for (i, (l, d)) in [("a", 60_000u64), ("b", 30_000), ("c", 0)].iter().enumerate() {
            let id = format!("item{}", i + 1);
            s.metadata.insert(id.clone(), meta(l, *d));
            s.playlist.append(id);
        }
        s.next_item_seq = 3;
        s
    }

    #[test]
    fn snapshot_roundtrips_through_json() {
        let mut s = state_with_three_items();
        s.carts.push(("cart1".to_string(), meta("slate", 5000)));
        s.next_cart_seq = 1;
        s.live_channel = Channel::B;
        s.fixtime_resolved.insert("item2".to_string(), FixtimeResolution::Fired);
        let mut cache = None;
        let snap = build_snapshot(&s, &mut cache, 1_000_000);
        let json = serde_json::to_string(&snap).unwrap();
        let back: Snapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back, snap);
        assert_eq!(back.items.len(), 3);
        assert_eq!(back.live_channel, "b");
    }

    #[test]
    fn identical_state_yields_identical_json_despite_elapsed_time() {
        let mut s = state_with_three_items();
        s.playlist.take().unwrap();
        s.onair_since = Some(Instant::now());
        let mut cache = None;
        let a = serde_json::to_string(&build_snapshot(&s, &mut cache, 5_000_000)).unwrap();
        std::thread::sleep(Duration::from_millis(15));
        let b = serde_json::to_string(&build_snapshot(&s, &mut cache, 5_000_015)).unwrap();
        assert_eq!(a, b, "same Instant must map to the same UTC start, otherwise every tick rewrites");
    }

    fn restore_into_fresh(snap: Snapshot, now_ms: i64) -> (AutomationState, RestoreReport) {
        let mut fresh = AutomationState::new(String::new(), String::new(), String::new(), String::new());
        let rep = apply_snapshot(&mut fresh, snap, now_ms).unwrap();
        (fresh, rep)
    }

    #[test]
    fn restore_resumes_on_air_item_still_inside_its_duration() {
        let mut s = state_with_three_items();
        s.playlist.take().unwrap(); // item1 (60s) on air
        s.onair_since = Some(Instant::now());
        s.last_live_item_id = Some("item1".to_string());
        let mut cache = None;
        let snap = build_snapshot(&s, &mut cache, 10_000_000);

        // 20 s später neu gestartet.
        let (r, rep) = restore_into_fresh(snap, 10_020_000);
        assert!(rep.resumed_on_air);
        assert!(r.playlist.on_air());
        assert_eq!(r.playlist.current_index(), Some(0));
        let elapsed = r.onair_since.unwrap().elapsed().as_millis() as u64;
        assert!((19_900..21_000).contains(&elapsed), "elapsed = {elapsed}");
        assert_eq!(r.last_live_item_id.as_deref(), Some("item1"));
        assert_eq!(r.next_item_seq, 3, "IDs must not be reused after restart");
        assert_eq!(r.metadata.len(), 3);
    }

    #[test]
    fn restore_does_not_resume_expired_item_and_tells_the_operator() {
        let mut s = state_with_three_items();
        s.playlist.take().unwrap(); // item1 = 60 s
        s.onair_since = Some(Instant::now());
        let mut cache = None;
        let snap = build_snapshot(&s, &mut cache, 10_000_000);

        // 10 Minuten Ausfall.
        let (r, rep) = restore_into_fresh(snap, 10_000_000 + 600_000);
        assert!(!rep.resumed_on_air);
        assert!(!r.playlist.on_air(), "nothing must be taken automatically");
        assert!(r.onair_since.is_none());
        assert_eq!(r.playlist.current_index(), Some(0), "cursor stays so the operator sees where we were");
        assert!(rep.notices.iter().any(|n| n.contains("abgelaufen")), "{:?}", rep.notices);
    }

    #[test]
    fn restore_keeps_endless_item_on_air() {
        let mut s = state_with_three_items();
        s.playlist.cue(2).unwrap(); // item3 = Dauer 0 (endlos)
        s.playlist.take().unwrap();
        s.onair_since = Some(Instant::now());
        let mut cache = None;
        let snap = build_snapshot(&s, &mut cache, 1_000);
        let (r, rep) = restore_into_fresh(snap, 1_000 + 3_600_000);
        assert!(rep.resumed_on_air && r.playlist.on_air());
    }

    #[test]
    fn restore_keeps_fired_fixtimes_so_they_do_not_fire_again() {
        let mut s = state_with_three_items();
        s.fixtime_resolved.insert("item2".to_string(), FixtimeResolution::Fired);
        s.fixtime_resolved.insert("gone".to_string(), FixtimeResolution::Fired);
        let mut cache = None;
        let snap = build_snapshot(&s, &mut cache, 0);
        let (r, _) = restore_into_fresh(snap, 0);
        assert_eq!(r.fixtime_resolved.get("item2"), Some(&FixtimeResolution::Fired));
        assert!(!r.fixtime_resolved.contains_key("gone"), "entries for unknown items are dropped");
    }

    #[test]
    fn restore_reports_active_cart_and_drops_it() {
        let mut s = state_with_three_items();
        s.carts.push(("cart1".to_string(), meta("slate", 5000)));
        s.active_cart = Some(crate::ActiveCart {
            asset_id: "cart1".to_string(),
            fired_at: Instant::now(),
            duration_ms: 5000,
            interrupted_item_id: None,
            elapsed_before_interrupt_ms: 0,
        });
        let mut cache = None;
        let snap = build_snapshot(&s, &mut cache, 0);
        let (r, rep) = restore_into_fresh(snap, 0);
        assert!(r.active_cart.is_none());
        assert_eq!(r.carts.len(), 1);
        assert!(rep.notices.iter().any(|n| n.contains("cart1")));
    }

    #[test]
    fn env_labels_win_over_saved_labels() {
        let mut s = state_with_three_items();
        s.target_mixer_label = "SavedMixer".to_string();
        s.target_player_a_label = "SavedA".to_string();
        let mut cache = None;
        let snap = build_snapshot(&s, &mut cache, 0);
        let mut fresh = AutomationState::new("EnvA".to_string(), String::new(), String::new(), String::new());
        apply_snapshot(&mut fresh, snap, 0).unwrap();
        assert_eq!(fresh.target_player_a_label, "EnvA");
        assert_eq!(fresh.target_mixer_label, "SavedMixer");
    }

    #[test]
    fn unknown_schema_is_rejected() {
        let s = state_with_three_items();
        let mut cache = None;
        let mut snap = build_snapshot(&s, &mut cache, 0);
        snap.schema = 99;
        let mut fresh = AutomationState::new(String::new(), String::new(), String::new(), String::new());
        assert!(apply_snapshot(&mut fresh, snap, 0).is_err());
        assert!(fresh.playlist.items().is_empty(), "a rejected snapshot must not touch the state");
    }
}
