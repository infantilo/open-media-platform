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
//! **seit `ARCHITECTURE.md` §24.1 (`UMSETZUNG.md` C16) denselben
//! Orchestrator-Proxy an, den auch das Operator-UI nutzt** — ein per
//! `OMP_LAUNCH_SECRET` geholtes Service-Token statt eines direkten
//! Node-zu-Node-Zugriffs, s. `remote.rs`-Moduldoku für die Begründung
//! (frühere Fassung ging direkt über den `href` des Ziel-Nodes, das
//! umging die einzige Durchsetzungsstelle des Systems).
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
//!
//! **Cart-/Interrupt-Assets (`ARCHITECTURE.md` §24.3, `UMSETZUNG.md`
//! C18):** `cart.define`/`cart.remove` verwalten wiederverwendbare,
//! benannte Interrupt-Clips (Blackclip, Standby, …); `cart.fire`
//! unterbricht den Hauptkanal damit (neues Item beim Ziel-Player,
//! dieselbe `take_on_targets`-Sequenz wie `take()`), `cart.return`
//! (explizit oder automatisch nach `durationMs`, 0 = nur manuell) stellt
//! ihn wieder her. `playlist.rs` selbst bleibt während eines Interrupts
//! unangetastet — Carts laufen bewusst NEBEN der Hauptplaylist, nicht
//! als Teil ihrer Sequenz. Live-debuggter Fund beim Bau: die
//! Wiederherstellung darf sich NICHT auf `playlist.on_air()` verlassen,
//! um zu entscheiden, ob voll (`take_on_targets`) oder nur `cue()`
//! wiederhergestellt wird — erreicht `advance()` das Listenende, setzt
//! es dieses Flag lokal auf `false`, OHNE den Player anzufassen (kein
//! EOS-Konzept, das Item läuft remote unverändert weiter). Ein
//! `cue()`-only-Restore in diesem Zustand ließ den Cart-Clip
//! dauerhaft live hängen (`omp-player`s `remove()` lehnt das Entfernen
//! eines noch on-air befindlichen Items ab). Fix: ein separates
//! `AutomationState::last_live_item_id`, das nur bei einem
//! tatsächlichen `take_on_targets`-Erfolg gesetzt wird — die einzige
//! verlässliche Quelle für "was zeigt der Player gerade wirklich".

mod playlist;
mod remote;
mod timeline;
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
use remote::{OrchestratorAuth, ProxyClient};
use serde_json::Value;
use timeline::TimelineCache;
use tokio::sync::mpsc;

const DISCOVERY_INTERVAL: Duration = Duration::from_secs(2);
const ADVANCE_TICK: Duration = Duration::from_millis(200);
const DEFAULT_PATTERN: &str = "smpte";
const DEFAULT_DURATION_MS: u64 = 5000;
/// Deutlich unter `auth.ServiceTokenTTL` (24h, Orchestrator) — ein
/// Refresh auf halber Laufzeit lässt reichlich Spielraum, falls der
/// Orchestrator beim ersten Versuch kurz nicht erreichbar ist (nächster
/// Tick holt es einfach nach, s. `token_refresh_loop`).
const TOKEN_REFRESH_INTERVAL: Duration = Duration::from_secs(12 * 60 * 60);

/// Woher ein Rundown-/Cart-Item seine Essenz bezieht — spiegelt
/// `omp-player`s eigenes `ItemMedia` (dessen `main.rs`), weil dieser Node
/// keine eigene Medienentscheidung trifft, sondern nur weiterreicht, was
/// der Ziel-Player tatsächlich zugewiesen hat (s. `item_meta_from_player_json`).
#[derive(Debug, Clone)]
enum ItemMedia {
    TestPattern { pattern: String, tone_frequency: f64 },
    File { path: String },
    Live { sender_id: String },
}

#[derive(Debug, Clone)]
struct ItemMeta {
    label: String,
    media: ItemMedia,
    duration_ms: u64,
}

/// Rekonstruiert ein `ItemMeta` aus einem Item, wie es `omp-player`s
/// `items`-Parameter zurückgibt (`{"id","label","pattern"|"file"|
/// "senderId",...,"durationMs"}`, s. dessen `main.rs::get("items")`) —
/// der Player trifft die Medienentscheidung (inkl. Datei-Duration-Probe),
/// dieser Node übernimmt sie nur, statt sie aus den eigenen Aufrufargumenten
/// zu erraten (gleiche Quelle-der-Wahrheit-Überlegung wie in `do_load`s
/// Moduldoku). `senderId` hat Vorrang vor `file` vor `pattern` — deckungs-
/// gleich mit der Precedence in `omp-player/src/main.rs`s `append`/`load`.
fn item_meta_from_player_json(v: &Value) -> Option<ItemMeta> {
    let label = v.get("label")?.as_str()?.to_string();
    let duration_ms = v.get("durationMs").and_then(Value::as_u64).unwrap_or(DEFAULT_DURATION_MS);
    let media = if let Some(sender_id) = v.get("senderId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        ItemMedia::Live { sender_id: sender_id.to_string() }
    } else if let Some(file) = v.get("file").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        ItemMedia::File { path: file.to_string() }
    } else {
        let pattern = v
            .get("pattern")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_PATTERN)
            .to_string();
        let tone_frequency = v.get("toneFrequency").and_then(Value::as_f64).unwrap_or(0.0);
        ItemMedia::TestPattern { pattern, tone_frequency }
    };
    Some(ItemMeta { label, media, duration_ms })
}

/// Gegenstück zu `item_meta_from_player_json` für `get("items")`/
/// `get("assets")` — dieselbe Feld-Shape wie `omp-player`s `items`
/// (jeweils genau eines von `pattern`+`toneFrequency` / `file` / `senderId`).
fn item_meta_to_json(id: &str, m: &ItemMeta) -> Value {
    let mut v = match &m.media {
        ItemMedia::TestPattern { pattern, tone_frequency } => serde_json::json!({
            "pattern": pattern,
            "toneFrequency": tone_frequency,
        }),
        ItemMedia::File { path } => serde_json::json!({ "file": path }),
        ItemMedia::Live { sender_id } => serde_json::json!({ "senderId": sender_id }),
    };
    v["id"] = serde_json::json!(id);
    v["label"] = serde_json::json!(m.label);
    v["durationMs"] = serde_json::json!(m.duration_ms);
    v
}

struct AutomationState {
    playlist: Playlist,
    metadata: HashMap<String, ItemMeta>,
    onair_since: Option<Instant>,
    target_player_label: String,
    target_mixer_label: String,
    /// NMOS-IS-04-Node-ID des Ziel-Players (nicht der `href` wie vor
    /// C16) — s. `remote::resolve_node_id_by_label`-Doku.
    player_node_id: Option<String>,
    mixer_node_id: Option<String>,
    /// Alle aktuell bekannten Node-Labels außer dem eigenen (`remote::
    /// list_node_labels`) — Grundlage für `availableNodes`, das
    /// `targetPlayerLabel`/`targetMixerLabel` im UI-Bundle von
    /// Freitext-Feldern auf eine Auswahl umstellt (Nutzerwunsch
    /// 2026-07-22: "wie beim Video-Mixer DSK"). Im selben `discovery_loop`-
    /// Tick wie `player_node_id`/`mixer_node_id` aktualisiert.
    discovered_labels: Vec<String>,
    /// Rundown-Echtmedien (`ARCHITECTURE.md` §24.6-Folgeschritt): Spiegel
    /// von `omp-player`s `mediaLibrary`/`availableSources`-Parametern des
    /// aktuell aufgelösten Ziel-Players — im selben `discovery_loop`-Tick
    /// wie `player_node_id` aktualisiert, damit das Rundown-UI Datei-/
    /// Live-Quellen anbieten kann, ohne den Player-Node selbst über einen
    /// zweiten Kanal abzufragen (gleicher Proxy-Weg wie jeder andere
    /// Fernzugriff dieses Nodes). Leert sich, sobald `player_node_id`
    /// `None` wird (Ziel nicht aufgelöst/offline) — sonst böte das UI
    /// Quellen eines gar nicht mehr angesprochenen Players an.
    media_library: Vec<String>,
    available_sources: Vec<Value>,
    /// Item-ID, die zuletzt tatsächlich per `take_on_targets` remote live
    /// geschaltet wurde (C18-Fund, `ARCHITECTURE.md` §24.3) — bewusst
    /// **nicht** aus `playlist.on_air()` abgeleitet: erreicht `advance()`
    /// das Listenende, setzt es lokal `on_air=false`, OHNE den Player/
    /// Mixer anzufassen (kein EOS-Konzept, `omp-player`s Item läuft remote
    /// unverändert weiter). Ein Cart-Fire, das sich in diesem Zustand auf
    /// `playlist.on_air()` verlassen hätte, nähme fälschlich den
    /// "nur cuen, nicht nehmen"-Rückweg und der Cart-Clip bliebe nach dem
    /// Return dauerhaft live hängen (live reproduziert, s.
    /// docs/decisions.md Nachtrag zu C18). Dieses Feld ist die einzige
    /// Quelle der Wahrheit für "was zeigt der Player/Mixer über den
    /// Hauptkanal gerade wirklich" — gesetzt von `do_take`/`do_advance`
    /// direkt nach einem erfolgreichen `take_on_targets`, von `do_load`
    /// beim Playlist-Ersatz zurückgesetzt (danach existiert die alte
    /// Item-ID beim Player evtl. gar nicht mehr).
    last_live_item_id: Option<String>,
    /// C18 (`ARCHITECTURE.md` §24.3): definierte Cart-/Interrupt-Assets,
    /// insertion-geordnet (`Vec` statt `HashMap`, damit `assets` stabil
    /// in Anlage-Reihenfolge angezeigt wird — bei der erwarteten kleinen
    /// Cart-Anzahl ist die O(n)-Suche unproblematisch, gleiche Abwägung
    /// wie beim Rest dieses Nodes).
    carts: Vec<(String, ItemMeta)>,
    next_cart_seq: u64,
    active_cart: Option<ActiveCart>,
    /// Listenansicht-Folgeschritt ("Stop"-Bedienknopf, PIPELINE-
    /// CONTROLLER-Parität): Item-ID eines beim Ziel-Player synthetisch
    /// angehängten Schwarzbilds, auf das `do_stop()` zuletzt geschaltet
    /// hat — best-effort vor dem nächsten `do_stop()` wieder entfernt
    /// (gleiches Aufräum-Prinzip wie `ActiveCart::player_item_id` bei
    /// `cart.return`), damit wiederholtes Stoppen den Player nicht mit
    /// Schwarzbild-Leichen zumüllt. Bewusst **kein** Cart/keine Playlist-
    /// Item-ID: `state.playlist`/`state.metadata` bleiben unangetastet,
    /// damit der Rundown nach einem Stop unverändert erhalten bleibt
    /// (PC-Semantik: Stop beendet nur die Wiedergabe, nicht die Liste).
    stop_item_id: Option<String>,
    /// C20 (`ARCHITECTURE.md` §24.5, `timeline.rs`): gefensterter,
    /// inkrementeller Zeitplan-Cache für die Hauptplaylist — bewusst
    /// nicht für Carts geführt (die laufen neben der Hauptplaylist,
    /// haben keinen Platz in deren Zeitplan, s. `ActiveCart`-Doku).
    timeline: TimelineCache,
}

/// Zustand eines gerade laufenden Cart-Interrupts (`ARCHITECTURE.md`
/// §24.3) — hält fest, was nach Ablauf/`cart.return()` wiederherzustellen
/// ist. `playlist` selbst bleibt während des gesamten Interrupts
/// unverändert (Carts laufen bewusst NEBEN der Hauptplaylist, nicht als
/// Teil ihrer Sequenz, s. Moduldoku C18) — die Wiederherstellung braucht
/// deshalb keine lokale Zustandsmutation, nur einen erneuten Fernaufruf
/// mit der hier gemerkten Item-ID.
struct ActiveCart {
    asset_id: String,
    /// Die vom Ziel-Player beim Cart-`append` vergebene Item-ID — wird
    /// bei `cart.return()` wieder entfernt, damit Cart-Clips den Player
    /// nicht dauerhaft aufblähen.
    player_item_id: String,
    fired_at: Instant,
    /// 0 = kein automatischer Return (nur explizites `cart.return()`),
    /// gleiche Konvention wie `ItemMeta::duration_ms` beim
    /// Haupt-Auto-Advance (dort per `duration_ms > 0`-Guard geprüft).
    duration_ms: u64,
    /// = `AutomationState::last_live_item_id` zum Fire-Zeitpunkt — `None`,
    /// wenn der Hauptkanal noch nie tatsächlich live geschaltet war.
    interrupted_item_id: Option<String>,
    /// Bereits vor dem Interrupt vergangene On-Air-Zeit des
    /// Hauptkanal-Items — beim Return wird `onair_since` um genau diesen
    /// Betrag zurückdatiert, damit die Interrupt-Dauer nicht gegen die
    /// verbleibende Item-Laufzeit zählt ("an der Stelle, an der es
    /// unterbrochen wurde", nicht "von vorn"). 0, wenn `onair_since` beim
    /// Fire bereits `None` war (z. B. Listenende, s.
    /// `last_live_item_id`-Doku) — der Return startet die Item-Laufzeit
    /// dann bewusst frisch, statt eine Pseudo-Restdauer zu erfinden.
    elapsed_before_interrupt_ms: u128,
}

enum Event {
    Error(String),
}

struct AutomationStore {
    state: Mutex<AutomationState>,
    registry: RegistryClient,
    events: mpsc::UnboundedSender<Event>,
    /// ARCHITECTURE.md §24.1 — Basis-URL des Orchestrators (für den
    /// Proxy-Pfad) plus das geteilte, periodisch erneuerte Service-Token.
    orchestrator_url: String,
    auth: OrchestratorAuth,
    /// Das eigene, bei der NMOS-Registrierung verwendete Label —
    /// `remote::list_node_labels` schließt es aus (dieser Node ist nie
    /// ein sinnvolles Player-/Mixer-Ziel).
    own_label: String,
}

impl AutomationStore {
    /// Baut einen `ProxyClient` für eine gegebene Ziel-Node-ID —
    /// gemeinsamer Kern für Player- und Mixer-Zugriffe (beide sprechen
    /// denselben Orchestrator-Proxy an, nur unter unterschiedlicher ID).
    fn proxy_client(&self, node_id: String) -> ProxyClient {
        ProxyClient::new(self.orchestrator_url.clone(), node_id, self.auth.clone())
    }
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

        let player_node_id = state
            .player_node_id
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst (targetPlayerLabel unbekannt/noch nicht gestartet)")?;
        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst (targetMixerLabel unbekannt/noch nicht gestartet)")?;
        let player_label = state.target_player_label.clone();

        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &item_id)?;

        state.playlist.take().map_err(|e| e.to_string())?;
        state.onair_since = Some(Instant::now());
        state.last_live_item_id = Some(item_id);
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
            // last_live_item_id bleibt bewusst unangetastet: der Player
            // zeigt das letzte Item remote unverändert weiter (kein
            // EOS-Konzept) — nur die lokale Sequenzierung endet hier, s.
            // `last_live_item_id`-Doku.
            return Ok(());
        };

        let player_node_id = state
            .player_node_id
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst")?;
        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst")?;
        let player_label = state.target_player_label.clone();

        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &item_id)?;
        state.onair_since = Some(Instant::now());
        state.last_live_item_id = Some(item_id);
        Ok(())
    }

    /// Listenansicht-Folgeschritt, "Next"-Bedienknopf (PIPELINE-CONTROLLER-
    /// Parität, `ui.html::playNext()`): manuelles Gegenstück zu
    /// `do_advance()` — nutzt `Playlist::force_advance()` statt `advance()`,
    /// wirkt also unabhängig vom `mode` (im PC-Original ausdrücklich der
    /// Weg, im Hold-Modus manuell weiterzuschalten). Ein aktiver Cart hat
    /// Vorrang (gleicher Guard wie `do_stop`/`do_next_live`) — "Next"
    /// bezieht sich auf die Hauptplaylist, nicht auf den Interrupt-Kanal.
    fn do_next(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        if state.active_cart.is_some() {
            return Err("Cart aktiv — zuerst cart.return() aufrufen".to_string());
        }
        let Some(item_id) = state.playlist.force_advance() else {
            state.onair_since = None;
            return Ok(());
        };

        let player_node_id = state
            .player_node_id
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst")?;
        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst")?;
        let player_label = state.target_player_label.clone();

        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &item_id)?;
        state.onair_since = Some(Instant::now());
        state.last_live_item_id = Some(item_id);
        Ok(())
    }

    /// Listenansicht-Folgeschritt, "Next Live"-Bedienknopf (PIPELINE-
    /// CONTROLLER-Parität, `ui.html::playNextLive()`): springt direkt zum
    /// nächsten Rundown-Item NACH der aktuellen Position, dessen Medium
    /// `ItemMedia::Live` ist — überspringt alles dazwischen in einem
    /// Schritt, ohne dass der Operator jedes Item einzeln cuen muss.
    /// Bewusst **ohne** PCs Fix-Zeit-Blockade (`ui.html::
    /// updateNextLiveBtn`s `startType==='fixtime'`-Check): OMP-Rundown-
    /// Items kennen bislang kein Fixzeit-/Zeitplan-Konzept (nur den
    /// reinen Zeitplan-Cache aus C20), es gibt hier nichts zu blockieren.
    fn do_next_live(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        if state.active_cart.is_some() {
            return Err("Cart aktiv — zuerst cart.return() aufrufen".to_string());
        }
        let start_from = state.playlist.current_index().map(|i| i + 1).unwrap_or(0);
        let items = state.playlist.items().to_vec();
        let target = items
            .iter()
            .enumerate()
            .skip(start_from)
            .find(|(_, id)| matches!(state.metadata.get(*id).map(|m| &m.media), Some(ItemMedia::Live { .. })))
            .map(|(i, id)| (i, id.clone()));
        let Some((target_index, item_id)) = target else {
            return Err("kein Live-Item nach der aktuellen Position im Rundown".to_string());
        };

        let player_node_id = state
            .player_node_id
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst (targetPlayerLabel unbekannt/noch nicht gestartet)")?;
        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst (targetMixerLabel unbekannt/noch nicht gestartet)")?;
        let player_label = state.target_player_label.clone();

        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &item_id)?;

        state.playlist.cue(target_index).map_err(|e| e.to_string())?;
        state.playlist.take().map_err(|e| e.to_string())?;
        state.onair_since = Some(Instant::now());
        state.last_live_item_id = Some(item_id);
        Ok(())
    }

    /// Listenansicht-Folgeschritt, "Stop"-Bedienknopf (PIPELINE-CONTROLLER-
    /// Parität, `ui.html::stopPlaylist()`): schaltet den Hauptkanal sofort
    /// auf ein synthetisches Schwarzbild — non-destruktiv wie im
    /// PC-Original ("Stop beendet nur die Wiedergabe, die Liste bleibt
    /// erhalten"), deshalb bewusst kein `state.playlist.replace_all(..)`
    /// oder Ähnliches. Gleicher Mechanismus wie `cart.fire` (synthetisches
    /// Item beim Ziel-Player anhängen + `take_on_targets`), aber ohne
    /// Rückweg/Restore — stattdessen wird das vorherige Schwarzbild-Item
    /// (falls eines von einem früheren Stop übrig ist) zuerst best-effort
    /// entfernt, damit wiederholtes Stoppen den Player nicht mit
    /// Schwarzbild-Leichen zumüllt (s. `stop_item_id`-Doku). Ein aktiver
    /// Cart hat Vorrang — Stop beträfe sonst den falschen Kanal-Zustand.
    fn do_stop(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        if state.active_cart.is_some() {
            return Err("Cart aktiv — zuerst cart.return() aufrufen".to_string());
        }
        let player_node_id = state
            .player_node_id
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst (targetPlayerLabel unbekannt/noch nicht gestartet)")?;
        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst (targetMixerLabel unbekannt/noch nicht gestartet)")?;
        let player_label = state.target_player_label.clone();
        let player = self.proxy_client(player_node_id.clone());
        let prev_stop_item_id = state.stop_item_id.take();

        let known_before: std::collections::HashSet<String> = player
            .get_param("items")
            .map_err(|e| format!("Player-Items vor Stop nicht lesbar: {e}"))?
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|it| it.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();

        player
            .invoke(
                "append",
                serde_json::json!({ "label": "STOP", "pattern": "black", "toneFrequency": 0, "durationMs": 0 }),
            )
            .map_err(|e| format!("Stop-append fehlgeschlagen: {e}"))?;

        let stop_item_id = fetch_new_item_id(&player, &known_before)
            .map_err(|e| format!("Neue Stop-Item-ID nicht lesbar: {e}"))?;

        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &stop_item_id)?;

        // Erst NACH dem Umschalten auf das neue Schwarzbild aufräumen: das
        // vorherige Stop-Item ist bis zu diesem Punkt noch on-air —
        // `omp-player`s `remove()` lehnt das Entfernen eines noch on-air
        // befindlichen Items ab (gleicher Fund wie beim C18-Cart-Return,
        // s. `AutomationState::last_live_item_id`-Doku). Best-effort:
        // schlägt es trotzdem fehl, sammelt sich höchstens ein Schwarzbild-
        // Item mehr an, kein Abbruch der eigentlichen Stop-Aktion.
        if let Some(prev_id) = prev_stop_item_id {
            if let Err(e) = player.invoke("remove", serde_json::json!({ "itemId": prev_id })) {
                self.report(format!("Vorheriges Stop-/Black-Item konnte nicht entfernt werden: {e}"));
            }
        }

        state.stop_item_id = Some(stop_item_id);
        // Nur das lokale on_air-Flag geht aus (s. cue()-Doku: erneutes
        // Cuen desselben Index setzt on_air=false ohne current_index zu
        // verschieben) — der Rundown selbst bleibt unangetastet.
        if let Some(idx) = state.playlist.current_index() {
            let _ = state.playlist.cue(idx);
        }
        state.onair_since = None;
        state.last_live_item_id = None;
        Ok(())
    }

    /// Rundown-Echtmedien-Folgeschritt: `pattern`/`file`/`senderId` werden
    /// unverändert an den Ziel-Player durchgereicht (dessen `append()`
    /// entscheidet die Precedence, s. dessen Moduldoku) — dieser Node rät
    /// nicht selbst, welche Quelle gemeint ist. Das lokale `ItemMeta` wird
    /// danach komplett aus der Player-Antwort rekonstruiert
    /// (`item_meta_from_player_json`), NICHT aus den hier übergebenen
    /// Rohargumenten: bei `file` probt der Player die echte Clip-Dauer und
    /// ignoriert ein evtl. mitgeschicktes `duration_ms` dafür vollständig
    /// (`omp-player/src/main.rs::invoke("append")`) — ein Übernehmen des
    /// Roharguments würde den Auto-Advance-Timer (`auto_advance_loop`) auf
    /// eine falsche Dauer laufen lassen.
    fn do_append(
        &self,
        label: String,
        pattern: Option<String>,
        file: Option<String>,
        sender_id: Option<String>,
        tone_frequency: Option<f64>,
        duration_ms: Option<u64>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let player_node_id = state
            .player_node_id
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst")?;
        let player = self.proxy_client(player_node_id);

        let known_before: std::collections::HashSet<String> =
            state.metadata.keys().cloned().collect();

        let mut body = serde_json::json!({ "label": label });
        if let Some(v) = &pattern {
            body["pattern"] = serde_json::json!(v);
        }
        if let Some(v) = &file {
            body["file"] = serde_json::json!(v);
        }
        if let Some(v) = &sender_id {
            body["senderId"] = serde_json::json!(v);
        }
        if let Some(v) = tone_frequency {
            body["toneFrequency"] = serde_json::json!(v);
        }
        if let Some(v) = duration_ms {
            body["durationMs"] = serde_json::json!(v);
        }

        player
            .invoke("append", body)
            .map_err(|e| format!("Player-append fehlgeschlagen: {e}"))?;

        let new_item = fetch_new_item(&player, &known_before)
            .map_err(|e| format!("Player-Items nach append nicht lesbar: {e}"))?;
        let new_id = new_item
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Neues Player-Item ohne id")?
            .to_string();
        let meta = item_meta_from_player_json(&new_item).ok_or("Neues Player-Item unlesbar")?;

        state.playlist.append(new_id.clone());
        state.metadata.insert(new_id, meta);
        // C20: kein state.timeline.invalidate_from() nötig — append()
        // hängt immer ans Ende (Playlist::append-Doku), der Zeitplan-
        // Cache bleibt für alle bestehenden Indizes gültig.
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
            #[serde(default)]
            file: Option<String>,
            #[serde(rename = "senderId", default)]
            sender_id: Option<String>,
            #[serde(rename = "toneFrequency", default)]
            tone_frequency: Option<f64>,
            #[serde(rename = "durationMs", default)]
            duration_ms: Option<u64>,
        }
        serde_json::from_str::<Vec<LoadItem>>(items_json)
            .map_err(|e| format!("itemsJson ungültig: {e}"))?;

        let mut state = self.state.lock().expect("lock poisoned");
        let player_node_id = state
            .player_node_id
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst")?;
        let player = self.proxy_client(player_node_id);

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
            let meta = item_meta_from_player_json(&it).ok_or("Player-Item unlesbar")?;
            metadata.insert(id.clone(), meta);
            ids.push(id);
        }

        state.playlist.replace_all(ids);
        state.metadata = metadata;
        state.onair_since = None;
        // load() ersetzt die komplette Player-Playlist remote — eine
        // vorher gemerkte last_live_item_id könnte danach gar nicht mehr
        // existieren, s. Doku dort.
        state.last_live_item_id = None;
        // C20: komplette Playlist ersetzt, Zeitplan-Cache ab Index 0
        // ungültig.
        state.timeline.invalidate_from(0);
        Ok(())
    }

    fn do_remove(&self, item_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let index = state
            .playlist
            .index_of(item_id)
            .ok_or("unbekannte itemId".to_string())?;
        let player_node_id = state
            .player_node_id
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst")?;
        let player = self.proxy_client(player_node_id);

        player
            .invoke("remove", serde_json::json!({"itemId": item_id}))
            .map_err(|e| format!("Player-remove fehlgeschlagen: {e}"))?;

        state.playlist.remove(index).map_err(|e| e.to_string())?;
        state.metadata.remove(item_id);
        // C20: alles ab dem entfernten Index rückt eine Position vor,
        // Zeitplan-Cache dort ungültig.
        state.timeline.invalidate_from(index);
        Ok(())
    }

    fn do_cue(&self, item_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let index = state
            .playlist
            .index_of(item_id)
            .ok_or("unbekannte itemId".to_string())?;
        let player_node_id = state
            .player_node_id
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst")?;
        let player = self.proxy_client(player_node_id);

        player
            .invoke("cue", serde_json::json!({"itemId": item_id}))
            .map_err(|e| format!("Player-cue fehlgeschlagen: {e}"))?;

        state.playlist.cue(index).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Legt ein neues, wiederverwendbares Cart-/Interrupt-Asset an (rein
    /// lokal, kein Fernaufruf nötig — anders als `do_append` gibt es hier
    /// keinen Ziel-Player, dessen Item-IDs übernommen werden müssten, das
    /// tatsächliche `append` passiert erst bei `cart.fire`).
    /// Carts bleiben in diesem Schritt bewusst pattern-only (der Rundown-
    /// Echtmedien-Folgeschritt betrifft nur die Hauptplaylist, s.
    /// gap-analysis-Kandidatenliste "Assets"-Bereich für Datei-/Live-Carts
    /// als eigenen späteren Schritt) — `ItemMeta::media` ist trotzdem
    /// bereits der geteilte Typ, damit `do_cart_fire` unverändert bleibt,
    /// sobald das nachgeholt wird.
    fn do_cart_define(&self, label: String, pattern: String, tone_frequency: f64, duration_ms: u64) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        state.next_cart_seq += 1;
        let id = format!("cart{}", state.next_cart_seq);
        state.carts.push((
            id,
            ItemMeta {
                label,
                media: ItemMedia::TestPattern { pattern, tone_frequency },
                duration_ms,
            },
        ));
        Ok(())
    }

    fn do_cart_remove(&self, asset_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let before = state.carts.len();
        state.carts.retain(|(id, _)| id != asset_id);
        if state.carts.len() == before {
            return Err("unbekannte Cart-Asset-ID".to_string());
        }
        Ok(())
    }

    /// Unterbricht den Hauptkanal mit einem definierten Cart-Asset
    /// (`ARCHITECTURE.md` §24.3): merkt sich, was gerade läuft/gecued
    /// ist, hängt das Cart-Asset als neues Item beim Ziel-Player an und
    /// schaltet Player+Mixer wie bei `take()` darauf um — dieselbe
    /// `take_on_targets`-Sequenz, kein eigener Mechanismus. `playlist`
    /// selbst bleibt unangetastet (s. `ActiveCart`-Doku).
    fn do_cart_fire(&self, asset_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        if state.active_cart.is_some() {
            return Err("bereits ein Cart aktiv, zuerst cart.return() aufrufen".to_string());
        }
        let meta = state
            .carts
            .iter()
            .find(|(id, _)| id == asset_id)
            .map(|(_, m)| m.clone())
            .ok_or("unbekannte Cart-Asset-ID")?;
        let player_node_id = state
            .player_node_id
            .clone()
            .ok_or("Ziel-Player nicht aufgelöst (targetPlayerLabel unbekannt/noch nicht gestartet)")?;
        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst (targetMixerLabel unbekannt/noch nicht gestartet)")?;
        let player_label = state.target_player_label.clone();

        // `last_live_item_id` statt `playlist.on_air()` — s. dessen Doku
        // (AutomationState): das lokale on_air-Flag kann durch ein
        // Ende-der-Liste-`advance()` bereits `false` sein, obwohl der
        // Player/Mixer den Hauptkanal remote unverändert weiter zeigt.
        let interrupted_item_id = state.last_live_item_id.clone();
        let elapsed_before_interrupt_ms = state
            .onair_since
            .map(|since| since.elapsed().as_millis())
            .unwrap_or(0);

        let player = self.proxy_client(player_node_id.clone());
        let known_before: std::collections::HashSet<String> = player
            .get_param("items")
            .map_err(|e| format!("Player-Items vor Cart-Fire nicht lesbar: {e}"))?
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|it| it.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();

        let mut cart_body = serde_json::json!({ "label": meta.label, "durationMs": meta.duration_ms });
        match &meta.media {
            ItemMedia::TestPattern { pattern, tone_frequency } => {
                cart_body["pattern"] = serde_json::json!(pattern);
                cart_body["toneFrequency"] = serde_json::json!(tone_frequency);
            }
            ItemMedia::File { path } => cart_body["file"] = serde_json::json!(path),
            ItemMedia::Live { sender_id } => cart_body["senderId"] = serde_json::json!(sender_id),
        }
        player
            .invoke("append", cart_body)
            .map_err(|e| format!("Cart-append fehlgeschlagen: {e}"))?;

        let cart_item_id = fetch_new_item_id(&player, &known_before)
            .map_err(|e| format!("Neue Cart-Item-ID nicht lesbar: {e}"))?;

        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &cart_item_id)?;

        state.active_cart = Some(ActiveCart {
            asset_id: asset_id.to_string(),
            player_item_id: cart_item_id,
            fired_at: Instant::now(),
            duration_ms: meta.duration_ms,
            interrupted_item_id,
            elapsed_before_interrupt_ms,
        });
        Ok(())
    }

    /// Beendet einen laufenden Cart-Interrupt: stellt den gemerkten
    /// Hauptkanal-Zustand IMMER über die volle `take_on_targets`-Sequenz
    /// wieder her (nicht bloß `cue()`) — s. `last_live_item_id`-Doku,
    /// warum ein bloßes Re-Cuen hier falsch wäre (der Cart-Clip bliebe
    /// sonst dauerhaft live hängen, weil `omp-player`s eigenes `remove()`
    /// das Entfernen eines noch on-air befindlichen Items ablehnt).
    /// Nichts zu tun, wenn der Hauptkanal beim Fire noch nie live war.
    /// Der Cart-Clip wird anschließend best-effort vom Ziel-Player
    /// entfernt — ein Fehler dabei lässt die Wiederherstellung selbst
    /// nicht scheitern, nur eine Alarm-Meldung (gleiche Best-Effort-
    /// Philosophie wie der Auto-Advance-Hintergrundpfad).
    fn do_cart_return(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let Some(active) = state.active_cart.take() else {
            return Ok(());
        };
        let player_label = state.target_player_label.clone();

        if let Some(restore_id) = active.interrupted_item_id.clone() {
            let player_node_id = state
                .player_node_id
                .clone()
                .ok_or("Ziel-Player nicht aufgelöst (Cart-Return)")?;
            let mixer_node_id = state
                .mixer_node_id
                .clone()
                .ok_or("Ziel-Mixer nicht aufgelöst (Cart-Return)")?;
            take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &restore_id)?;
            state.onair_since =
                Some(Instant::now() - Duration::from_millis(active.elapsed_before_interrupt_ms as u64));
            state.last_live_item_id = Some(restore_id.clone());
            // Lokale Playlist-Buchführung nachziehen, falls sie durch ein
            // zwischenzeitliches Ende-der-Liste-`advance()` hinter die
            // Realität zurückgefallen war (s. `last_live_item_id`-Doku) —
            // robust über die Item-ID statt eines evtl. inzwischen
            // verschobenen Index; kein Fehler, falls das Item inzwischen
            // entfernt wurde (dann bleibt lokal einfach "nichts gecued").
            if let Some(idx) = state.playlist.index_of(&restore_id) {
                let _ = state.playlist.cue(idx);
                let _ = state.playlist.take();
            }
        }

        if let Some(player_node_id) = state.player_node_id.clone() {
            let player = self.proxy_client(player_node_id);
            if let Err(e) = player.invoke("remove", serde_json::json!({"itemId": active.player_item_id})) {
                self.report(format!(
                    "Cart-Clip \"{}\" konnte nach Return nicht vom Player entfernt werden: {e}",
                    active.asset_id
                ));
            }
        }
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
    store: &AutomationStore,
    player_node_id: &str,
    mixer_node_id: &str,
    player_label: &str,
    item_id: &str,
) -> Result<(), String> {
    let player = store.proxy_client(player_node_id.to_string());
    let mixer = store.proxy_client(mixer_node_id.to_string());

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
fn resolve_mixer_sender_id(mixer: &ProxyClient, player_label: &str) -> Option<String> {
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
/// Nach einem `append()` beim Ziel-Player: findet das komplette neue
/// Item-JSON durch Differenzbildung gegen die vorher bekannten IDs (die
/// generische Methoden-Antwort liefert keinen Rückgabewert, §4.5a/A8 —
/// nur `{"ok":true}`). Mehr als eine neue ID (s. Moduldoku "Bekannte
/// Grenze") wird pragmatisch als "die letzte in der Antwort" aufgelöst.
fn fetch_new_item(
    player: &ProxyClient,
    known_before: &std::collections::HashSet<String>,
) -> Result<Value, remote::RemoteError> {
    let items = player.get_param("items")?;
    let items = items.as_array().cloned().unwrap_or_default();
    let mut new_items: Vec<Value> = items
        .into_iter()
        .filter(|it| {
            it.get("id")
                .and_then(Value::as_str)
                .map(|id| !known_before.contains(id))
                .unwrap_or(false)
        })
        .collect();
    new_items.pop().ok_or(remote::RemoteError::UnexpectedBody)
}

fn fetch_new_item_id(
    player: &ProxyClient,
    known_before: &std::collections::HashSet<String>,
) -> Result<String, remote::RemoteError> {
    let item = fetch_new_item(player, known_before)?;
    item.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
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
            // C18 (ARCHITECTURE.md §24.3): definierte Cart-/Interrupt-Assets
            // + welches davon (falls eines) gerade den Hauptkanal
            // unterbricht.
            ParamSpec {
                name: "assets".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "activeCartId".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            // Nutzerwunsch 2026-07-22: Player-/Mixer-Auswahl "wie beim
            // Video-Mixer DSK" — eine Discovery-Liste statt Freitext, s.
            // `remote::list_node_labels`-Doku.
            ParamSpec {
                name: "availableNodes".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            // Rundown-Echtmedien-Folgeschritt: Spiegel von `omp-player`s
            // gleichnamigen Parametern des aktuell aufgelösten Ziel-Players
            // (`discovery_loop`) — Grundlage für die Datei-/Live-Auswahl im
            // Rundown-Add-Formular, gleiches Prinzip wie `availableNodes`.
            ParamSpec {
                name: "mediaLibrary".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "availableSources".to_string(),
                kind: ParamType::String,
                unit: None,
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
                    // Rundown-Echtmedien-Folgeschritt — deckungsgleich mit
                    // `omp-player`s eigenem `append`-MethodSpec (C21).
                    MethodArg {
                        name: "file".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "senderId".to_string(),
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
            // Listenansicht-Folgeschritt, PIPELINE-CONTROLLER-Parität
            // (`ui.html`: Next/Next-Live/Stop-Bedienknöpfe).
            MethodSpec {
                name: "next".to_string(),
                args: vec![],
            },
            MethodSpec {
                name: "nextLive".to_string(),
                args: vec![],
            },
            MethodSpec {
                name: "stop".to_string(),
                args: vec![],
            },
            // C18 (ARCHITECTURE.md §24.3).
            MethodSpec {
                name: "cart.define".to_string(),
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
                name: "cart.remove".to_string(),
                args: vec![MethodArg {
                    name: "assetId".to_string(),
                    kind: ParamType::String,
                }],
            },
            MethodSpec {
                name: "cart.fire".to_string(),
                args: vec![MethodArg {
                    name: "assetId".to_string(),
                    kind: ParamType::String,
                }],
            },
            MethodSpec {
                name: "cart.return".to_string(),
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
                    .filter_map(|id| state.metadata.get(id).map(|m| item_meta_to_json(id, m)))
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
                state.player_node_id.is_some() && state.mixer_node_id.is_some()
            )),
            // Zeigt bevorzugt den Fortschritt eines aktiven Carts (C18) —
            // sonst wie bisher das Hauptkanal-Item. Ein aktiver Cart
            // "friert" den Hauptkanal-Fortschritt bewusst nicht sichtbar
            // ein, sondern zeigt den tatsächlich relevanten Vorgang.
            "playheadPositionMs" => Some(serde_json::json!(
                state
                    .active_cart
                    .as_ref()
                    .map(|active| active.fired_at.elapsed().as_millis() as f64)
                    .or_else(|| state.onair_since.map(|since| since.elapsed().as_millis() as f64))
                    .unwrap_or(0.0)
            )),
            "currentDurationMs" => {
                if let Some(active) = &state.active_cart {
                    Some(serde_json::json!(active.duration_ms))
                } else {
                    let id = current_or_cued_id(&state, true);
                    Some(serde_json::json!(
                        state.metadata.get(&id).map(|m| m.duration_ms).unwrap_or(0)
                    ))
                }
            }
            // C18 (ARCHITECTURE.md §24.3).
            "assets" => Some(serde_json::json!(
                state
                    .carts
                    .iter()
                    .map(|(id, m)| item_meta_to_json(id, m))
                    .collect::<Vec<_>>()
            )),
            "activeCartId" => Some(serde_json::json!(
                state.active_cart.as_ref().map(|a| a.asset_id.clone()).unwrap_or_default()
            )),
            "availableNodes" => Some(serde_json::json!(state.discovered_labels)),
            "mediaLibrary" => Some(serde_json::json!(state.media_library)),
            "availableSources" => Some(serde_json::json!(state.available_sources)),
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
                state.player_node_id = None;
                Ok(())
            }
            "targetMixerLabel" => {
                state.target_mixer_label = value.as_str().unwrap_or_default().to_string();
                state.mixer_node_id = None;
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
                // Rundown-Echtmedien-Folgeschritt: `pattern`/`file`/
                // `senderId` unverändert (als `Option`, kein lokaler
                // Default) an `do_append` weiterreichen — die Precedence-
                // Entscheidung trifft ausschließlich der Ziel-Player, s.
                // `do_append`-Doku.
                let pattern = args.get("pattern").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
                let file = args.get("file").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
                let sender_id = args.get("senderId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
                let tone_frequency = args.get("toneFrequency").and_then(Value::as_f64).filter(|f| *f > 0.0);
                let duration_ms = args
                    .get("durationMs")
                    .and_then(Value::as_f64)
                    .filter(|d| *d > 0.0)
                    .map(|d| d as u64);
                self.do_append(label, pattern, file, sender_id, tone_frequency, duration_ms)
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
            "next" => self.do_next(),
            "nextLive" => self.do_next_live(),
            "stop" => self.do_stop(),
            // C18 (ARCHITECTURE.md §24.3).
            "cart.define" => {
                let label = args
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Cart")
                    .to_string();
                let pattern = args
                    .get("pattern")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(DEFAULT_PATTERN)
                    .to_string();
                let tone_frequency = args.get("toneFrequency").and_then(Value::as_f64).unwrap_or(0.0);
                // Anders als beim Haupt-`append`: 0 ist hier ein gültiger,
                // bewusster Wert ("kein automatischer Return", s.
                // `ActiveCart::duration_ms`-Doku) statt auf
                // DEFAULT_DURATION_MS zu fallen.
                let duration_ms = args
                    .get("durationMs")
                    .and_then(Value::as_f64)
                    .filter(|d| *d >= 0.0)
                    .map(|d| d as u64)
                    .unwrap_or(0);
                self.do_cart_define(label, pattern, tone_frequency, duration_ms)
            }
            "cart.remove" => match args.get("assetId").and_then(Value::as_str) {
                Some(id) => self.do_cart_remove(id),
                None => Err("assetId fehlt".to_string()),
            },
            "cart.fire" => match args.get("assetId").and_then(Value::as_str) {
                Some(id) => self.do_cart_fire(id),
                None => Err("assetId fehlt".to_string()),
            },
            "cart.return" => self.do_cart_return(),
            _ => return Err(InvokeError::Unknown),
        };

        result.map_err(|e| {
            self.report(e);
            InvokeError::Unknown
        })
    }

    fn extra_route(&self, method: &str, path: &str, _body: &[u8]) -> Option<omp_node_sdk::RawResponse> {
        if method == "GET"
            && let Some(query) = path.strip_prefix("/timeline/window")
        {
            return Some(self.handle_timeline_window(query));
        }
        uibundle::route(method, path)
    }
}

impl AutomationStore {
    /// `GET /timeline/window?fromIndex=<n>&count=<n>` (C20,
    /// `ARCHITECTURE.md` §24.5) — bewusst als `extra_route` statt als
    /// Methode/Parameter: eine generische Methode
    /// (`POST /methods/<name>`) liefert im Node-Contract nur
    /// `{"ok":true}` zurück, kein Datenergebnis (s.
    /// `fetch_new_item_id`-Doku); ein Parameter (`GET /params/<name>`)
    /// kennt keine Query-Argumente. Beide passen für "gefensterte
    /// Anfrage mit zwei Zahlen-Argumenten, die Daten zurückliefert"
    /// nicht — `extra_route` ist hier der etablierte Fallback
    /// (`omp_node_sdk::ParamStore::extra_route`-Doku), gleiches Prinzip
    /// wie `/state` bei `omp-video-mixer-me`. Korrigiert gegenüber der
    /// ursprünglichen `ARCHITECTURE.md`-§24.5-Formulierung ("GET
    /// methods/timeline.window"), die diesen Konflikt vor der
    /// Umsetzung noch nicht berücksichtigt hatte, s.
    /// `docs/decisions.md`.
    fn handle_timeline_window(&self, query: &str) -> omp_node_sdk::RawResponse {
        let query = query.strip_prefix('?').unwrap_or(query);
        let mut from_index = 0usize;
        let mut count = 50usize; // vernünftiger Default, falls die UI count weglässt
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else { continue };
            match key {
                "fromIndex" => from_index = value.parse().unwrap_or(0),
                "count" => count = value.parse().unwrap_or(count),
                _ => {}
            }
        }

        let mut state = self.state.lock().expect("lock poisoned");
        let item_ids: Vec<String> = state.playlist.items().to_vec();
        let durations: Vec<u64> = item_ids
            .iter()
            .map(|id| state.metadata.get(id).map(|m| m.duration_ms).unwrap_or(0))
            .collect();
        let entries = state.timeline.window(&durations, from_index, count);

        let body = serde_json::to_vec(
            &entries
                .iter()
                .map(|e| {
                    serde_json::json!({
                        "index": e.index,
                        "itemId": item_ids[e.index],
                        "startMs": e.start_ms,
                        "durationMs": e.duration_ms,
                        "endMs": e.end_ms,
                    })
                })
                .collect::<Vec<_>>(),
        )
        .unwrap_or_default();

        omp_node_sdk::RawResponse { status: 200, content_type: "application/json", body }
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
        let own_label = store.own_label.clone();
        let resolved = tokio::task::spawn_blocking(move || {
            (
                remote::resolve_node_id_by_label(&registry, &player_label),
                remote::resolve_node_id_by_label(&registry, &mixer_label),
                remote::list_node_labels(&registry, &own_label),
            )
        })
        .await;
        if let Ok((player_node_id, mixer_node_id, discovered_labels)) = resolved {
            let mut state = store.state.lock().expect("lock poisoned");
            state.player_node_id = player_node_id;
            state.mixer_node_id = mixer_node_id;
            state.discovered_labels = discovered_labels;
        }

        // Rundown-Echtmedien-Folgeschritt: `mediaLibrary`/`availableSources`
        // des jetzt (evtl. neu) aufgelösten Ziel-Players spiegeln — im
        // selben Tick statt in einem eigenen Intervall, gleiche Kadenz wie
        // die übrige Ziel-Discovery. Best effort: schlägt der Fernaufruf
        // fehl (Player kurz nicht erreichbar), bleibt der zuletzt bekannte
        // Stand einfach bis zum nächsten Tick stehen.
        let player_node_id_for_media = {
            store.state.lock().expect("lock poisoned").player_node_id.clone()
        };
        match player_node_id_for_media {
            Some(player_node_id) => {
                let store2 = store.clone();
                let fetched = tokio::task::spawn_blocking(move || {
                    let player = store2.proxy_client(player_node_id);
                    (player.get_param("mediaLibrary"), player.get_param("availableSources"))
                })
                .await;
                if let Ok((media_library, available_sources)) = fetched {
                    let mut state = store.state.lock().expect("lock poisoned");
                    if let Ok(v) = media_library {
                        state.media_library = v
                            .as_array()
                            .cloned()
                            .unwrap_or_default()
                            .into_iter()
                            .filter_map(|x| x.as_str().map(str::to_string))
                            .collect();
                    }
                    if let Ok(v) = available_sources {
                        state.available_sources = v.as_array().cloned().unwrap_or_default();
                    }
                }
            }
            None => {
                // Kein Ziel-Player aufgelöst (z. B. `targetPlayerLabel`
                // gerade umkonfiguriert/offline) — Angebote leeren, sonst
                // böte das UI Quellen eines gar nicht mehr angesprochenen
                // Players an.
                let mut state = store.state.lock().expect("lock poisoned");
                state.media_library.clear();
                state.available_sources.clear();
            }
        }
    }
}

/// Erneuert das Service-Token lange vor Ablauf (`TOKEN_REFRESH_INTERVAL`
/// ≪ `auth.ServiceTokenTTL` im Orchestrator) — best effort: schlägt der
/// Refresh fehl (Orchestrator kurz nicht erreichbar), bleibt das alte
/// Token bis zum nächsten Tick gültig, keine Sonderbehandlung nötig.
async fn token_refresh_loop(
    orchestrator_url: String,
    instance_id: String,
    launch_secret: String,
    auth: OrchestratorAuth,
) {
    let mut interval = tokio::time::interval(TOKEN_REFRESH_INTERVAL);
    interval.tick().await; // erster Tick feuert sofort — Startwert wird vorher separat geholt
    loop {
        interval.tick().await;
        let url = orchestrator_url.clone();
        let id = instance_id.clone();
        let secret = launch_secret.clone();
        let result = tokio::task::spawn_blocking(move || remote::fetch_service_token(&url, &id, &secret)).await;
        match result {
            Ok(Ok(token)) => auth.set(token),
            Ok(Err(e)) => eprintln!("omp-playout-automation: Service-Token-Refresh fehlgeschlagen: {e}"),
            Err(e) => eprintln!("omp-playout-automation: Service-Token-Refresh-Task abgestürzt: {e}"),
        }
    }
}

/// Was der nächste `ADVANCE_TICK` (falls überhaupt) auslösen soll — ein
/// aktiver Cart (C18, `ARCHITECTURE.md` §24.3) hat immer Vorrang vor der
/// normalen Playlist-Auto-Advance-Prüfung: solange er läuft, bleibt der
/// Hauptkanal-Timer (`onair_since`) unangetastet ("pausiert"), erst
/// `CartReturn` datiert ihn beim Wiederherstellen zurück.
enum AdvanceAction {
    None,
    CartReturn,
    PlaylistAdvance,
}

async fn auto_advance_loop(
    store: Arc<AutomationStore>,
    events: mpsc::UnboundedSender<Event>,
) {
    let mut interval = tokio::time::interval(ADVANCE_TICK);
    loop {
        interval.tick().await;

        let action = {
            let state = store.state.lock().expect("lock poisoned");
            if let Some(active) = &state.active_cart {
                if active.duration_ms > 0 && active.fired_at.elapsed().as_millis() as u64 >= active.duration_ms {
                    AdvanceAction::CartReturn
                } else {
                    AdvanceAction::None
                }
            } else if !state.playlist.on_air() || state.playlist.mode() != Mode::Auto {
                AdvanceAction::None
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
                        if duration_ms > 0 && since.elapsed().as_millis() as u64 >= duration_ms {
                            AdvanceAction::PlaylistAdvance
                        } else {
                            AdvanceAction::None
                        }
                    }
                    _ => AdvanceAction::None,
                }
            }
        };

        let (label, result) = match action {
            AdvanceAction::None => continue,
            AdvanceAction::CartReturn => {
                let store2 = store.clone();
                ("Cart-Return", tokio::task::spawn_blocking(move || store2.do_cart_return()).await)
            }
            AdvanceAction::PlaylistAdvance => {
                let store2 = store.clone();
                ("Auto-Advance", tokio::task::spawn_blocking(move || store2.do_advance()).await)
            }
        };
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let message = format!("{label} fehlgeschlagen: {e}");
                eprintln!("omp-playout-automation: {message}");
                let _ = events.send(Event::Error(message));
            }
            Err(e) => {
                let message = format!("{label}-Task abgestürzt: {e}");
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
    // ARCHITECTURE.md §24.1, UMSETZUNG.md C16: Basis-URL des
    // Orchestrators (für den Proxy-Pfad) + das eigene, nur dieser
    // Instanz bekannte Launch-Secret (Nachweis gegenüber
    // `POST /api/v1/instances/<id>/service-token`). Dev-Fallback für den
    // Orchestrator-URL-Default deckungsgleich mit `config.Load()`s
    // eigenem `OMP_LISTEN`-Default (`:8000`); Launch-Secret hat bewusst
    // KEINEN Fallback — ohne echtes, vom Launcher vergebenes Secret kann
    // (und soll) sich dieser Node kein Service-Token holen.
    let orchestrator_url = env_or("OMP_ORCHESTRATOR_URL", "http://localhost:8000");
    let launch_secret = std::env::var("OMP_LAUNCH_SECRET").unwrap_or_default();
    // Bequeme Startwerte für die beiden beschreibbaren Ziel-Parameter —
    // rein optional, Operator kann sie jederzeit per PATCH überschreiben
    // (s. Moduldoku: kein Launcher-/Katalog-Änderung für dynamische Ziele
    // nötig).
    let initial_player_label = std::env::var("OMP_PLAYOUT_TARGET_PLAYER_LABEL").unwrap_or_default();
    let initial_mixer_label = std::env::var("OMP_PLAYOUT_TARGET_MIXER_LABEL").unwrap_or_default();

    let registry = RegistryClient::new(registry_url.clone());
    let (events_tx, mut events_rx) = mpsc::unbounded_channel::<Event>();

    let auth = OrchestratorAuth::new();
    if let (Some(id), false) = (instance_id.as_deref(), launch_secret.is_empty()) {
        match remote::fetch_service_token(&orchestrator_url, id, &launch_secret) {
            Ok(token) => auth.set(token),
            // Nicht fatal: der Node startet trotzdem (Descriptor bleibt
            // erreichbar, UI zeigt "nicht verbunden"), holt sich das
            // Token einfach beim nächsten `token_refresh_loop`-Tick nach
            // — gleiche Selbstheilungs-Philosophie wie die
            // Label-Discovery unten.
            Err(e) => eprintln!("omp-playout-automation: initialer Service-Token-Abruf fehlgeschlagen: {e}"),
        }
    } else {
        eprintln!(
            "omp-playout-automation: OMP_INSTANCE_ID/OMP_LAUNCH_SECRET fehlen — kein Service-Token, \
             Fernsteuerung von Player/Mixer bleibt bis dahin wirkungslos (ARCHITECTURE.md §24.1)"
        );
    }

    let state = Mutex::new(AutomationState {
        playlist: Playlist::new(),
        metadata: HashMap::new(),
        onair_since: None,
        target_player_label: initial_player_label,
        target_mixer_label: initial_mixer_label,
        player_node_id: None,
        mixer_node_id: None,
        discovered_labels: Vec::new(),
        media_library: Vec::new(),
        available_sources: Vec::new(),
        last_live_item_id: None,
        carts: Vec::new(),
        next_cart_seq: 0,
        active_cart: None,
        stop_item_id: None,
        timeline: TimelineCache::new(),
    });
    let store = Arc::new(AutomationStore {
        state,
        registry: registry.clone(),
        events: events_tx.clone(),
        orchestrator_url: orchestrator_url.clone(),
        auth: auth.clone(),
        own_label: label.clone(),
    });

    // instance_id vor dem Move in NodeConfig sichern — wird unten für
    // den Token-Refresh-Loop nochmal gebraucht (ARCHITECTURE.md §24.1).
    let instance_id_for_refresh = instance_id.clone();

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

    // ARCHITECTURE.md §24.1: nur spawnen, wenn überhaupt ein Refresh
    // Sinn ergibt (Instanz-ID + Launch-Secret vorhanden) — ohne die
    // beiden kann ohnehin kein Token geholt werden, ein Loop, der nur
    // wiederholt denselben Fehler loggt, wäre reiner Lärm.
    if let Some(id) = instance_id_for_refresh.filter(|_| !launch_secret.is_empty()) {
        tokio::spawn(token_refresh_loop(orchestrator_url.clone(), id, launch_secret.clone(), auth.clone()));
    }

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
