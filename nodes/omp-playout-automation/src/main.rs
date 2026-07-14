//! `omp-playout-automation` (`UMSETZUNG.md` C14/C15, vormals C10/C11) —
//! die Playout-Automation-Controller-Referenzimplementierung.
//!
//! Bewusst **keine eigene Medienpipeline**: dieser Node hat weder Sender
//! noch Receiver, kein `omp-mediaio`, kein GStreamer. Er ist eine dünne
//! Sequenzierungsschicht (`playlist.rs`, wiederverwendet aus
//! `c4-playlist-wip`), die zur Laufzeit zwei bereits laufende, manuell
//! bedienbare Nodes fernsteuert — einen `omp-player` (C12) über dessen
//! `append`/`load`/`remove`/`cue`/`take`-Methoden und einen
//! `omp-video-mixer-me` (C10) über dessen `crosspoint.select`/
//! `crosspoint.cut` — exakt dieselben IS-12/14-Methoden, die auch das
//! Operator-UI (C10/C12-Node-UI-Bundles) über den generischen
//! Parameter-/Methoden-Proxy aufruft (`ARCHITECTURE.md` §13.1/§13.3:
//! "dieselben Methoden … keine zweite API"). `remote.rs` spricht dafür
//! direkt den Descriptor-HTTP-Server der Ziel-Nodes an (kein Umweg über
//! den Orchestrator nötig).
//!
//! **Ziel-Auflösung ist dynamisch, nicht hartkodiert:** welcher
//! `omp-player`/`omp-video-mixer-me` gesteuert wird, ist ein Paar
//! **beschreibbarer** Parameter (`targetPlayerLabel`/`targetMixerLabel`,
//! per PATCH über denselben generischen Proxy wie jeder andere Parameter
//! setzbar) statt eines Katalog-Env-Werts — der Instanz-Launcher (§6.2
//! Stufe 0) kennt keine Start-Parameter jenseits des festen
//! Katalog-`env`, ein neuer Mechanismus dafür wäre für diesen Schritt
//! unverhältnismäßig; die Ziel-Wahl über einen beschreibbaren Parameter
//! braucht keine Orchestrator-/Launcher-Änderung.
//!
//! **Bekannte Grenze (dokumentiert, nicht "gelöst"):** die Automation
//! geht von exklusiver Kontrolle über den Ziel-Player aus, sobald sie
//! ihm ein erstes Item hinzugefügt hat — paralleles manuelles Bedienen
//! desselben Player-Items *und* Automation auf demselben Player ist nicht
//! vorgesehen (§7.4/C14-Zielbild: Regieplatz **mit oder ohne**
//! Automatisation, nicht beides gleichzeitig auf demselben Player).

mod playlist;
mod remote;
mod uibundle;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_node_sdk::is04::RegistryClient;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    Range, SetError,
};
use playlist::{Mode, Playlist};
use remote::PeerClient;
use serde_json::Value;
use tokio::sync::mpsc;

const DISCOVERY_INTERVAL: Duration = Duration::from_secs(2);
const ADVANCE_TICK: Duration = Duration::from_millis(200);
const DEFAULT_PATTERN: &str = "smpte";
const DEFAULT_DURATION_MS: u64 = 5000;

#[derive(Debug, Clone)]
struct ItemMeta {
    label: String,
    pattern: String,
    tone_frequency: f64,
    duration_ms: u64,
}

struct AutomationState {
    playlist: Playlist,
    metadata: HashMap<String, ItemMeta>,
    onair_since: Option<Instant>,
    target_player_label: String,
    target_mixer_label: String,
    player_href: Option<String>,
    mixer_href: Option<String>,
}

enum Event {
    Error(String),
}

struct AutomationStore {
    state: Mutex<AutomationState>,
    registry: RegistryClient,
    events: mpsc::UnboundedSender<Event>,
}

impl AutomationStore {
    /// Gemeinsame Logik für `invoke("take")` und den Auto-Advance-Timer:
    /// cued Item am Ziel-Player erneut cuen (idempotent, self-healing
    /// falls der Player zwischenzeitlich neu gestartet ist), dann
    /// `take()` sowie `crosspoint.select`+`crosspoint.cut` am Ziel-Mixer
    /// — bewusst "remote zuerst, danach lokal committen": schlägt einer
    /// der Fernaufrufe fehl, bleibt der lokale Zustand unverändert
    /// (kein Vorgriff auf einen Zustand, der remote nicht bestätigt ist).
    fn do_take(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let index = state
            .playlist
            .current_index()
            .ok_or("nichts gecued".to_string())?;
        let item_id = state.playlist.items()[index].clone();

        let player_href = state
            .player_href
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst (targetPlayerLabel unbekannt/noch nicht gestartet)")?;
        let mixer_href = state
            .mixer_href
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst (targetMixerLabel unbekannt/noch nicht gestartet)")?;
        let player_label = state.target_player_label.clone();

        take_on_targets(&player_href, &mixer_href, &player_label, &item_id)?;

        state.playlist.take().map_err(|e| e.to_string())?;
        state.onair_since = Some(Instant::now());
        Ok(())
    }

    /// Auto-Advance-Gegenstück zu `do_take`: `playlist.advance()` liefert
    /// die nächste Item-ID als Mutation in einem Schritt (anders als
    /// `take()`, das sich in Peek+Commit aufteilen lässt) — hier bewusst
    /// **nicht** remote-first: schlägt der Fernaufruf fehl, bleibt der
    /// lokale Zustand einen Schritt "voraus", was beim nächsten manuellen
    /// Eingriff/Tick selbstheilend ist. Für den Best-Effort-Hintergrund-
    /// Pfad (Fehler landen als Alarm, keine Sendung wird deswegen
    /// angehalten) ein bewusst akzeptierter Kompromiss, kein Bug.
    fn do_advance(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let Some(item_id) = state.playlist.advance() else {
            state.onair_since = None;
            return Ok(());
        };

        let player_href = state
            .player_href
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst")?;
        let mixer_href = state
            .mixer_href
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst")?;
        let player_label = state.target_player_label.clone();

        take_on_targets(&player_href, &mixer_href, &player_label, &item_id)?;
        state.onair_since = Some(Instant::now());
        Ok(())
    }

    fn do_append(
        &self,
        label: String,
        pattern: String,
        tone_frequency: f64,
        duration_ms: u64,
    ) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let player_href = state
            .player_href
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst")?;
        let player = PeerClient::new(player_href);

        let known_before: std::collections::HashSet<String> =
            state.metadata.keys().cloned().collect();

        player
            .invoke(
                "append",
                serde_json::json!({
                    "label": label,
                    "pattern": pattern,
                    "toneFrequency": tone_frequency,
                    "durationMs": duration_ms,
                }),
            )
            .map_err(|e| format!("Player-append fehlgeschlagen: {e}"))?;

        let new_id = fetch_new_item_id(&player, &known_before)
            .map_err(|e| format!("Player-Items nach append nicht lesbar: {e}"))?;

        state.playlist.append(new_id.clone());
        state.metadata.insert(
            new_id,
            ItemMeta {
                label,
                pattern,
                tone_frequency,
                duration_ms,
            },
        );
        Ok(())
    }

    fn do_load(&self, items_json: &str) -> Result<(), String> {
        // Nur Form-Validierung vor dem Weiterreichen an den Player (dessen
        // `load()` dieselbe Form erwartet, `omp-player/src/main.rs`s
        // `LoadItem`) — die Felder selbst werden hier nicht gebraucht,
        // die maßgebliche Auswertung inkl. Defaults passiert im Player;
        // die eigene Sicht wird danach aus dessen Antwort rekonstruiert
        // (s. u.), nicht aus diesen Rohdaten.
        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct LoadItem {
            label: String,
            #[serde(default)]
            pattern: Option<String>,
            #[serde(rename = "toneFrequency", default)]
            tone_frequency: Option<f64>,
            #[serde(rename = "durationMs", default)]
            duration_ms: Option<u64>,
        }
        serde_json::from_str::<Vec<LoadItem>>(items_json)
            .map_err(|e| format!("itemsJson ungültig: {e}"))?;

        let mut state = self.state.lock().expect("lock poisoned");
        let player_href = state
            .player_href
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst")?;
        let player = PeerClient::new(player_href);

        player
            .invoke("load", serde_json::json!({"itemsJson": items_json}))
            .map_err(|e| format!("Player-load fehlgeschlagen: {e}"))?;

        // Nach load() ist die Player-Playlist neu — die eigene Sicht wird
        // komplett aus der (jetzt maßgeblichen) Antwort des Players
        // rekonstruiert, nicht aus den rohen Eingabeargumenten (der Player
        // wendet eigene Defaults an, s. `omp-player/src/main.rs`).
        let items = player
            .get_param("items")
            .map_err(|e| format!("Player-Items nach load nicht lesbar: {e}"))?;
        let items = items.as_array().cloned().unwrap_or_default();

        let mut ids = Vec::with_capacity(items.len());
        let mut metadata = HashMap::with_capacity(items.len());
        for it in items {
            let id = it
                .get("id")
                .and_then(Value::as_str)
                .ok_or("Player-Item ohne id")?
                .to_string();
            metadata.insert(
                id.clone(),
                ItemMeta {
                    label: it
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    pattern: it
                        .get("pattern")
                        .and_then(Value::as_str)
                        .unwrap_or(DEFAULT_PATTERN)
                        .to_string(),
                    tone_frequency: it.get("toneFrequency").and_then(Value::as_f64).unwrap_or(0.0),
                    duration_ms: it
                        .get("durationMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(DEFAULT_DURATION_MS),
                },
            );
            ids.push(id);
        }

        state.playlist.replace_all(ids);
        state.metadata = metadata;
        state.onair_since = None;
        Ok(())
    }

    fn do_remove(&self, item_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let index = state
            .playlist
            .index_of(item_id)
            .ok_or("unbekannte itemId".to_string())?;
        let player_href = state
            .player_href
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst")?;
        let player = PeerClient::new(player_href);

        player
            .invoke("remove", serde_json::json!({"itemId": item_id}))
            .map_err(|e| format!("Player-remove fehlgeschlagen: {e}"))?;

        state.playlist.remove(index).map_err(|e| e.to_string())?;
        state.metadata.remove(item_id);
        Ok(())
    }

    fn do_cue(&self, item_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let index = state
            .playlist
            .index_of(item_id)
            .ok_or("unbekannte itemId".to_string())?;
        let player_href = state
            .player_href
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst")?;
        let player = PeerClient::new(player_href);

        player
            .invoke("cue", serde_json::json!({"itemId": item_id}))
            .map_err(|e| format!("Player-cue fehlgeschlagen: {e}"))?;

        state.playlist.cue(index).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn report(&self, message: String) {
        eprintln!("omp-playout-automation: {message}");
        let _ = self.events.send(Event::Error(message));
    }
}

/// Cued+nimmt ein Item am Ziel-Player auf Sendung und schneidet den
/// Ziel-Mixer per Crosspoint darauf — gemeinsamer Kern von `do_take`/
/// `do_advance`. `crosspoint.select` setzt nur den Preset-Bus (§13.1),
/// `crosspoint.cut` vollzieht den eigentlichen Programmwechsel und löst
/// damit (über den bereits bestehenden Mechanismus in
/// `omp-video-mixer-me`) das Tally-Event für die Kachel des Players aus —
/// keine eigene Tally-Logik hier nötig.
fn take_on_targets(
    player_href: &str,
    mixer_href: &str,
    player_label: &str,
    item_id: &str,
) -> Result<(), String> {
    let player = PeerClient::new(player_href);
    let mixer = PeerClient::new(mixer_href);

    player
        .invoke("cue", serde_json::json!({"itemId": item_id}))
        .map_err(|e| format!("Player-cue (vor take) fehlgeschlagen: {e}"))?;
    player
        .invoke("take", serde_json::json!({}))
        .map_err(|e| format!("Player-take fehlgeschlagen: {e}"))?;

    let sender_id = resolve_mixer_sender_id(&mixer, player_label).ok_or_else(|| {
        format!(
            "Ziel-Player-Video-Sender am Mixer nicht gefunden (Label-Präfix \"{player_label} Sender\" \
             nicht unter crosspoint.inputs — Mixer-Discovery evtl. noch nicht durchgelaufen)"
        )
    })?;
    mixer
        .invoke("crosspoint.select", serde_json::json!({"senderId": sender_id}))
        .map_err(|e| format!("Mixer-crosspoint.select fehlgeschlagen: {e}"))?;
    mixer
        .invoke("crosspoint.cut", serde_json::json!({}))
        .map_err(|e| format!("Mixer-crosspoint.cut fehlgeschlagen: {e}"))?;

    Ok(())
}

/// Liest `crosspoint.inputs` des Ziel-Mixers (bereits dessen eigene,
/// laufende IS-04-Discovery, §6.1/C10) und findet den Video-Sender des
/// Ziel-Players über dessen Label-Präfix (`omp-node-sdk::node::start`
/// benennt Sender immer `"{Node-Label} Sender {n}"`) — keine eigene
/// Sender-Discovery nötig, der Mixer hat sie schon.
fn resolve_mixer_sender_id(mixer: &PeerClient, player_label: &str) -> Option<String> {
    let inputs = mixer.get_param("crosspoint.inputs").ok()?;
    let prefix = format!("{player_label} Sender");
    inputs.as_array()?.iter().find_map(|entry| {
        let label = entry.get("label")?.as_str()?;
        if !label.starts_with(&prefix) {
            return None;
        }
        entry.get("senderId")?.as_str().map(str::to_string)
    })
}

/// Nach einem `append()` beim Ziel-Player: findet die neu vergebene
/// Item-ID durch Differenzbildung gegen die vorher bekannten IDs (die
/// generische Methoden-Antwort liefert keinen Rückgabewert, §4.5a/A8 —
/// nur `{"ok":true}`). Mehr als eine neue ID (z. B. gleichzeitiges
/// manuelles Bedienen desselben Players, s. Moduldoku "Bekannte Grenze")
/// wird pragmatisch als "die letzte in der Antwort" aufgelöst.
fn fetch_new_item_id(
    player: &PeerClient,
    known_before: &std::collections::HashSet<String>,
) -> Result<String, remote::RemoteError> {
    let items = player.get_param("items")?;
    let items = items.as_array().cloned().unwrap_or_default();
    let mut new_ids: Vec<String> = items
        .iter()
        .filter_map(|it| it.get("id").and_then(Value::as_str).map(str::to_string))
        .filter(|id| !known_before.contains(id))
        .collect();
    new_ids
        .pop()
        .ok_or(remote::RemoteError::UnexpectedBody)
}

impl ParamStore for AutomationStore {
    fn descriptor(&self) -> Descriptor {
        let parameters = vec![
            ParamSpec {
                name: "items".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "currentItemId".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "cuedItemId".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "mode".to_string(),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum {
                    values: vec!["auto".to_string(), "hold".to_string()],
                }),
                readonly: false,
            },
            ParamSpec {
                name: "targetPlayerLabel".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: false,
            },
            ParamSpec {
                name: "targetMixerLabel".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: false,
            },
            ParamSpec {
                name: "connected".to_string(),
                kind: ParamType::Boolean,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "playheadPositionMs".to_string(),
                kind: ParamType::Number,
                unit: Some("ms".to_string()),
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "currentDurationMs".to_string(),
                kind: ParamType::Number,
                unit: Some("ms".to_string()),
                range: None,
                readonly: true,
            },
        ];

        let methods = vec![
            MethodSpec {
                name: "append".to_string(),
                args: vec![
                    MethodArg {
                        name: "label".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "pattern".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "toneFrequency".to_string(),
                        kind: ParamType::Number,
                    },
                    MethodArg {
                        name: "durationMs".to_string(),
                        kind: ParamType::Number,
                    },
                ],
            },
            MethodSpec {
                name: "load".to_string(),
                args: vec![MethodArg {
                    name: "itemsJson".to_string(),
                    kind: ParamType::String,
                }],
            },
            MethodSpec {
                name: "remove".to_string(),
                args: vec![MethodArg {
                    name: "itemId".to_string(),
                    kind: ParamType::String,
                }],
            },
            MethodSpec {
                name: "cue".to_string(),
                args: vec![MethodArg {
                    name: "itemId".to_string(),
                    kind: ParamType::String,
                }],
            },
            MethodSpec {
                name: "take".to_string(),
                args: vec![],
            },
        ];

        Descriptor { parameters, methods }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let state = self.state.lock().expect("lock poisoned");
        match name {
            "items" => Some(serde_json::json!(
                state
                    .playlist
                    .items()
                    .iter()
                    .filter_map(|id| state.metadata.get(id).map(|m| serde_json::json!({
                        "id": id,
                        "label": m.label,
                        "pattern": m.pattern,
                        "toneFrequency": m.tone_frequency,
                        "durationMs": m.duration_ms,
                    })))
                    .collect::<Vec<_>>()
            )),
            "currentItemId" => Some(serde_json::json!(current_or_cued_id(&state, true))),
            "cuedItemId" => Some(serde_json::json!(current_or_cued_id(&state, false))),
            "mode" => Some(serde_json::json!(match state.playlist.mode() {
                Mode::Auto => "auto",
                Mode::Hold => "hold",
            })),
            "targetPlayerLabel" => Some(serde_json::json!(state.target_player_label)),
            "targetMixerLabel" => Some(serde_json::json!(state.target_mixer_label)),
            "connected" => Some(serde_json::json!(
                state.player_href.is_some() && state.mixer_href.is_some()
            )),
            "playheadPositionMs" => Some(serde_json::json!(
                state
                    .onair_since
                    .map(|since| since.elapsed().as_millis() as f64)
                    .unwrap_or(0.0)
            )),
            "currentDurationMs" => {
                let id = current_or_cued_id(&state, true);
                Some(serde_json::json!(
                    state.metadata.get(&id).map(|m| m.duration_ms).unwrap_or(0)
                ))
            }
            _ => None,
        }
    }

    fn set(&self, name: &str, value: Value) -> Result<(), SetError> {
        let mut state = self.state.lock().expect("lock poisoned");
        match name {
            "mode" => {
                let mode = match value.as_str() {
                    Some("auto") => Mode::Auto,
                    Some("hold") => Mode::Hold,
                    _ => return Err(SetError::Unknown),
                };
                state.playlist.set_mode(mode);
                Ok(())
            }
            "targetPlayerLabel" => {
                state.target_player_label = value.as_str().unwrap_or_default().to_string();
                // Sofort invalidieren statt bis zum nächsten 2s-Discovery-
                // Tick zu warten — ein `take()` unmittelbar nach dem
                // Umkonfigurieren soll nicht den alten Player treffen.
                state.player_href = None;
                Ok(())
            }
            "targetMixerLabel" => {
                state.target_mixer_label = value.as_str().unwrap_or_default().to_string();
                state.mixer_href = None;
                Ok(())
            }
            _ => Err(SetError::ReadOnly),
        }
    }

    fn invoke(&self, name: &str, args: &serde_json::Map<String, Value>) -> Result<(), InvokeError> {
        let result = match name {
            "append" => {
                let label = args
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Item")
                    .to_string();
                let pattern = args
                    .get("pattern")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(DEFAULT_PATTERN)
                    .to_string();
                let tone_frequency = args.get("toneFrequency").and_then(Value::as_f64).unwrap_or(0.0);
                let duration_ms = args
                    .get("durationMs")
                    .and_then(Value::as_f64)
                    .filter(|d| *d > 0.0)
                    .map(|d| d as u64)
                    .unwrap_or(DEFAULT_DURATION_MS);
                self.do_append(label, pattern, tone_frequency, duration_ms)
            }
            "load" => {
                let items_json = args.get("itemsJson").and_then(Value::as_str).unwrap_or("[]");
                self.do_load(items_json)
            }
            "remove" => match args.get("itemId").and_then(Value::as_str) {
                Some(id) => self.do_remove(id),
                None => Err("itemId fehlt".to_string()),
            },
            "cue" => match args.get("itemId").and_then(Value::as_str) {
                Some(id) => self.do_cue(id),
                None => Err("itemId fehlt".to_string()),
            },
            "take" => self.do_take(),
            _ => return Err(InvokeError::Unknown),
        };

        result.map_err(|e| {
            self.report(e);
            InvokeError::Unknown
        })
    }

    fn extra_route(&self, method: &str, path: &str, _body: &[u8]) -> Option<omp_node_sdk::RawResponse> {
        uibundle::route(method, path)
    }
}

fn current_or_cued_id(state: &AutomationState, want_onair: bool) -> String {
    if state.playlist.on_air() != want_onair {
        return String::new();
    }
    state
        .playlist
        .current_index()
        .and_then(|i| state.playlist.items().get(i))
        .cloned()
        .unwrap_or_default()
}

/// Löst `targetPlayerLabel`/`targetMixerLabel` periodisch neu auf
/// (gleiches 2s-Poll-Muster wie `omp-switcher`/`omp-video-mixer-me`s
/// Sender-Discovery, C7/C10) — macht die Ziel-Auflösung selbstheilend
/// (ein neu gestarteter Ziel-Node mit neuem `href` wird automatisch
/// wieder gefunden), nicht nur einmalig beim Setzen des Labels.
async fn discovery_loop(store: Arc<AutomationStore>) {
    let mut interval = tokio::time::interval(DISCOVERY_INTERVAL);
    loop {
        interval.tick().await;
        let (player_label, mixer_label) = {
            let state = store.state.lock().expect("lock poisoned");
            (state.target_player_label.clone(), state.target_mixer_label.clone())
        };
        let registry = store.registry.clone();
        let resolved = tokio::task::spawn_blocking(move || {
            (
                remote::resolve_href_by_label(&registry, &player_label),
                remote::resolve_href_by_label(&registry, &mixer_label),
            )
        })
        .await;
        if let Ok((player_href, mixer_href)) = resolved {
            let mut state = store.state.lock().expect("lock poisoned");
            state.player_href = player_href;
            state.mixer_href = mixer_href;
        }
    }
}

async fn auto_advance_loop(
    store: Arc<AutomationStore>,
    events: mpsc::UnboundedSender<Event>,
) {
    let mut interval = tokio::time::interval(ADVANCE_TICK);
    loop {
        interval.tick().await;

        let due = {
            let state = store.state.lock().expect("lock poisoned");
            if !state.playlist.on_air() || state.playlist.mode() != Mode::Auto {
                false
            } else {
                match (state.onair_since, state.playlist.current_index()) {
                    (Some(since), Some(idx)) => {
                        let duration_ms = state
                            .playlist
                            .items()
                            .get(idx)
                            .and_then(|id| state.metadata.get(id))
                            .map(|m| m.duration_ms)
                            .unwrap_or(0);
                        duration_ms > 0 && since.elapsed().as_millis() as u64 >= duration_ms
                    }
                    _ => false,
                }
            }
        };
        if !due {
            continue;
        }

        let store2 = store.clone();
        let result = tokio::task::spawn_blocking(move || store2.do_advance()).await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let message = format!("Auto-Advance fehlgeschlagen: {e}");
                eprintln!("omp-playout-automation: {message}");
                let _ = events.send(Event::Error(message));
            }
            Err(e) => {
                let message = format!("Auto-Advance-Task abgestürzt: {e}");
                eprintln!("omp-playout-automation: {message}");
                let _ = events.send(Event::Error(message));
            }
        }
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "PlayoutAutomation");
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9370").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let instance_id = std::env::var("OMP_INSTANCE_ID").ok();
    // Bequeme Startwerte für die beiden beschreibbaren Ziel-Parameter —
    // rein optional, Operator kann sie jederzeit per PATCH überschreiben
    // (s. Moduldoku: kein Launcher-/Katalog-Änderung für dynamische Ziele
    // nötig).
    let initial_player_label = std::env::var("OMP_PLAYOUT_TARGET_PLAYER_LABEL").unwrap_or_default();
    let initial_mixer_label = std::env::var("OMP_PLAYOUT_TARGET_MIXER_LABEL").unwrap_or_default();

    let registry = RegistryClient::new(registry_url.clone());
    let (events_tx, mut events_rx) = mpsc::unbounded_channel::<Event>();

    let state = Mutex::new(AutomationState {
        playlist: Playlist::new(),
        metadata: HashMap::new(),
        onair_since: None,
        target_player_label: initial_player_label,
        target_mixer_label: initial_mixer_label,
        player_href: None,
        mixer_href: None,
    });
    let store = Arc::new(AutomationStore {
        state,
        registry: registry.clone(),
        events: events_tx.clone(),
    });

    let handle = omp_node_sdk::start(
        NodeConfig {
            label,
            host,
            port,
            registry_url,
            nats_url,
            senders: vec![],
            receivers: vec![],
            instance_id,
            // Reiner Control-Plane-Node (kein omp-mediaio, senders/
            // receivers leer) — hat kein Medien-I/O, das abzuwarten wäre
            // (ARCHITECTURE.md §5 Punkt 6, UMSETZUNG.md D5-prep).
            media_ready: omp_node_sdk::MediaReadySource::NotApplicable,
        },
        store.clone(),
    )
    .await?;

    tokio::spawn(discovery_loop(store.clone()));

    let advance_events = events_tx.clone();
    tokio::spawn(auto_advance_loop(store.clone(), advance_events));

    let alerts = async {
        while let Some(event) = events_rx.recv().await {
            match event {
                Event::Error(message) => handle.publish_alert(message).await,
            }
        }
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-playout-automation: shutdown requested");
        }
        _ = alerts => {
            eprintln!("omp-playout-automation: event channel closed");
        }
    }

    Ok(())
}
