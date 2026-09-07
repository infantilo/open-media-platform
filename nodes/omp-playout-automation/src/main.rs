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
use serde::{Deserialize, Serialize};
use serde_json::Value;
use timeline::TimelineCache;
use tokio::sync::mpsc;

const DISCOVERY_INTERVAL: Duration = Duration::from_secs(2);
const ADVANCE_TICK: Duration = Duration::from_millis(200);
const DEFAULT_PATTERN: &str = "smpte";
const DEFAULT_DURATION_MS: u64 = 5000;
/// Kapitel 6 Teil 3 (§6.4, PC-Vorbild `PRE_CUE_MS`=5000,
/// `docs/decisions.md` Nachtrag 180): wie viele Sekunden vor der
/// Fixzeit ein Item vorab gecued wird (Vorschau, kein Take).
const FIXTIME_PRECUE_SECS: i64 = 5;
/// PC-Vorbild: 30s Gnadenfenster. Danach gilt ein noch nicht
/// gefeuertes Fixtime-Event als verpasst (`Skipped` + Alarm) statt
/// verspätet doch noch zu feuern.
const FIXTIME_GRACE_SECS: i64 = 30;
const FIXTIME_TICK: Duration = Duration::from_secs(1);
/// Kapitel 6 Teil 5 — feiner als `FIXTIME_TICK`, gröber als
/// `ADVANCE_TICK` (Begründung bei `graphics_loop`).
const GRAPHICS_TICK: Duration = Duration::from_millis(250);
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

/// Kapitel 6 Teil 1 (`docs/END-GOAL-FEATURES.md` §6.4/§6.2b): rein
/// automationsseitiges Konzept, das `omp-player` NICHT kennt (dessen
/// `item_meta_from_player_json`-Quelle liefert das nicht) — deshalb
/// separat gepflegt statt aus dem Player-Response abgeleitet, s.
/// `do_append`/`do_load`-Doku. `Manual`: PIPELINE CONTROLLER hat dafür
/// **kein** Vorbild (dort gibt es nur ein End-seitiges "Manual Hold",
/// keinen Start-Gate — `docs/decisions.md` Nachtrag 180) — ein
/// `manual`-Item nimmt weder am Sequenz-Vorrücken noch an Fixzeit-
/// Timern teil, sondern wird ausschließlich per explizitem
/// Operator-Cue+Take scharf. `Fixtime` (Kapitel 6 Teil 3): feuert zur
/// in `ItemMeta::fixtime_hms` hinterlegten Uhrzeit unabhängig vom
/// Sequenz-Fortschritt (harter Unterbrecher), s. `fixtime_loop`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum StartType {
    #[default]
    Sequence,
    Manual,
    Fixtime,
}

impl StartType {
    /// Für die generische Method-Arg-Extraktion (`invoke("append"/
    /// "setStartType", …)`) — dieselbe String-Repräsentation wie der
    /// `#[serde(rename_all = "lowercase")]`-Ableitung, nur ohne den
    /// JSON-String-Umweg über `serde_json::from_value`.
    fn parse(s: &str) -> Option<Self> {
        match s {
            "sequence" => Some(Self::Sequence),
            "manual" => Some(Self::Manual),
            "fixtime" => Some(Self::Fixtime),
            _ => None,
        }
    }
}

/// Kapitel 6 Teil 4 (`docs/END-GOAL-FEATURES.md` §6.4 "Take-Choreografie
/// mit Transitions"): `Cut` ist die bisherige, einzige Take-Art
/// (`crosspoint.select`+`crosspoint.cut`). `Mix` nutzt stattdessen
/// `crosspoint.select`+`crosspoint.autoTrans` (K3-Teil-2, bereits
/// fertig in `omp-video-mixer-me`) — ein echtes Audio/Video-Xfade
/// zwischen zwei Clips DESSELBEN Players kann der A/B-Slot-Player nicht
/// darstellen (ein Ausgang, harte `active-pad`-Umschaltung, s.
/// `docs/END-GOAL-FEATURES.md` §6.4 "ehrliche v1-Grenze") — `Mix` wirkt
/// deshalb nur sinnvoll, wenn Quelle und Ziel zwei VERSCHIEDENE
/// Quellen am Mixer sind (z. B. Player + Live-Kamera, oder zwei
/// Player-Instanzen). Bewusst NICHT hier erzwungen/geprüft — der
/// Mixer führt die Rampe so oder so aus, ein "Xfade" auf denselben
/// Eingang ist einfach optisch wirkungslos, kein Fehlerfall.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum Transition {
    #[default]
    Cut,
    Mix,
}

impl Transition {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "cut" => Some(Self::Cut),
            "mix" => Some(Self::Mix),
            _ => None,
        }
    }
}

/// Kapitel 6 Teil 5 (`docs/END-GOAL-FEATURES.md` §6.4 "Grafik-Child-
/// Events"): ein Kind-Ereignis ist relativ zum START oder ENDE des
/// tragenden Rundown-Items terminiert — `End` ist nur sinnvoll, wenn das
/// Item eine echte `duration_ms > 0` hat (Live-/manuell endlose Items
/// kennen kein "Ende", `schedule_children` überspringt solche
/// End-relativen Kinder dann mit einer Meldung statt sie nie feuern zu
/// lassen, ohne dass der Operator erfährt, warum).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RelativeTo {
    Start,
    End,
}

/// Ein Grafik-Kind-Ereignis (`docs/END-GOAL-FEATURES.md` §6.4) — zeigt
/// `template_id` mit `data` am Ziel-`omp-ograf` (`targetGraphicsLabel`)
/// für `duration_ms` (0 = bleibt stehen, bis das tragende Item endet
/// oder der Kanal wechselt — kein eigenes `hide()` geplant) ab
/// `delay_ms` relativ zu `relative_to`. `data` ist bewusst rohes JSON
/// (nicht typisiert) — die Feldform hängt vom jeweiligen OGraf-Template-
/// Schema ab, das dieser Node nicht kennt und nicht kennen muss
/// (`omp-ograf::show` wendet es ohnehin nur als Override auf die
/// Schema-Defaults an).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct GraphicsChild {
    #[serde(rename = "templateId")]
    template_id: String,
    #[serde(default)]
    data: Value,
    #[serde(rename = "delayMs", default)]
    delay_ms: u64,
    #[serde(rename = "durationMs", default)]
    duration_ms: u64,
    #[serde(rename = "relativeTo")]
    relative_to: RelativeTo,
}

#[derive(Debug, Clone)]
struct ItemMeta {
    label: String,
    media: ItemMedia,
    duration_ms: u64,
    start_type: StartType,
    /// Kapitel 6 Teil 3: nur bedeutungsvoll bei `start_type ==
    /// StartType::Fixtime` — lokale Uhrzeit als "HH:MM:SS"
    /// (`parse_hms_to_secs`), sonst `None`. Eigenes `Option` statt
    /// eines leeren Strings, damit ein Item, das GERADE erst auf
    /// `Fixtime` umgeschaltet wurde, aber noch keine Zeit gesetzt hat,
    /// eindeutig "noch nicht scharf" bleibt statt fälschlich auf
    /// Mitternacht zu feuern.
    fixtime_hms: Option<String>,
    /// Kapitel 6 Teil 4: wie DIESES Item auf Sendung genommen wird,
    /// s. `Transition`-Doku.
    transition: Transition,
    /// Nur bei `transition == Transition::Mix` ausgewertet — `None`
    /// heißt "die am Mixer aktuell gesetzte `crosspoint.transRate`
    /// unverändert lassen" (kein PATCH vor dem `autoTrans`), `Some(f)`
    /// setzt sie vorher explizit (`crosspoint.setTransRate`,
    /// 1..=250 Frames, Mixer-seitige Grenze).
    transition_rate_frames: Option<u32>,
    /// Kapitel 6 Teil 5: Grafik-Kind-Ereignisse, s. `GraphicsChild`-Doku.
    children: Vec<GraphicsChild>,
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
    // `start_type` ist bewusst NICHT Teil dieser Rekonstruktion — der
    // Player kennt das Konzept nicht (Typdoku oben). Aufrufer, die einen
    // Wert haben (`do_append`s eigener Parameter, `do_load`s positionell
    // gezippte `LoadItem`s), überschreiben das Feld danach selbst.
    Some(ItemMeta {
        label,
        media,
        duration_ms,
        start_type: StartType::default(),
        fixtime_hms: None,
        transition: Transition::default(),
        transition_rate_frames: None,
        children: Vec::new(),
    })
}

/// Kapitel 6 Teil 2 (`docs/END-GOAL-FEATURES.md` §6.4, "Verfügbarkeits-
/// Absatz" — PC-Vorbild s. `docs/decisions.md` Nachtrag 180): Test-
/// Muster sind synthetisch, immer verfügbar. Datei-/Live-Items
/// spiegeln den zuletzt bekannten `media_library`/`available_sources`-
/// Stand des Ziel-Players (`discovery_loop`-Doku, best effort, kein
/// Extra-Poll nur für diese Prüfung) — bewusst KEIN eigener
/// Backup-Verzeichnis-Mechanismus wie bei PC (`omp-media-library` ist
/// ein zentraler, gepflegter Katalog, kein Dateisystem mit
/// Ausweich-Ordnern, s. §6.4-Doku).
fn item_is_available(m: &ItemMeta, media_library: &[String], available_sources: &[Value]) -> bool {
    match &m.media {
        ItemMedia::TestPattern { .. } => true,
        ItemMedia::File { path } => media_library.iter().any(|f| f == path),
        ItemMedia::Live { sender_id } => available_sources
            .iter()
            .any(|s| s.get("senderId").and_then(Value::as_str) == Some(sender_id.as_str())),
    }
}

/// Kapitel 6 Teil 3: "HH:MM:SS" (lokale Wanduhr, kein Datum) →
/// Sekunden seit Mitternacht, oder `None` bei ungültigem Format/
/// Wertebereich. Bewusst `i64` (nicht `u32`) — passt direkt in die
/// Differenzrechnung in `fixtime_action` ohne Vorzeichen-Klimmzüge.
fn parse_hms_to_secs(s: &str) -> Option<i64> {
    let mut parts = s.trim().splitn(3, ':');
    let h: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let sec: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None; // mehr als drei Teile
    }
    if !(0..24).contains(&h) || !(0..60).contains(&m) || !(0..60).contains(&sec) {
        return None;
    }
    Some(h * 3600 + m * 60 + sec)
}

/// Lokale Wanduhr (nicht UTC — ein Operator tippt "14:00:00" im Sinne
/// der Studio-Zeitzone, s. `Cargo.toml`s `chrono`-Begründung), Sekunden
/// seit Mitternacht. **Bekannte Grenze:** reine Sekunden-seit-
/// Mitternacht-Arithmetik kennt kein Datum — ein Fixtime-Event kurz vor
/// Mitternacht kann bei einem Neustart/Reorder kurz nach Mitternacht
/// fälschlich als "weit in der Zukunft" statt "gerade verpasst"
/// erscheinen. Für die erste Ausbaustufe hingenommen (dieselbe
/// Kern-Rundown-Länge wie C20s "rundown-lang, nicht tagelang"-Annahme),
/// nicht stillschweigend als vollständig korrekt behauptet.
fn seconds_since_midnight_local() -> i64 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    now.hour() as i64 * 3600 + now.minute() as i64 * 60 + now.second() as i64
}

/// Kapitel 6 Teil 3: reine, seiteneffektfreie Entscheidungslogik —
/// getrennt von der Uhr/dem State, damit sie ohne Zeit-Mocking testbar
/// bleibt (gleiches Prinzip wie `Playlist::peek_next()`/
/// `item_is_available()`). `already` ist der Vorzustand aus
/// `AutomationState::fixtime_resolved`; `Fired`/`Skipped` sind
/// Endzustände (kein weiterer Tick tut noch etwas).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FixtimeAction {
    None,
    PreCue,
    Fire,
    Skip,
}

fn fixtime_action(now_secs: i64, target_secs: i64, already: Option<FixtimeResolution>) -> FixtimeAction {
    if matches!(already, Some(FixtimeResolution::Fired) | Some(FixtimeResolution::Skipped)) {
        return FixtimeAction::None;
    }
    let delta = now_secs - target_secs;
    if delta < -FIXTIME_PRECUE_SECS {
        FixtimeAction::None
    } else if delta < 0 {
        if already == Some(FixtimeResolution::PreCued) {
            FixtimeAction::None
        } else {
            FixtimeAction::PreCue
        }
    } else if delta <= FIXTIME_GRACE_SECS {
        FixtimeAction::Fire
    } else {
        FixtimeAction::Skip
    }
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
    v["startType"] = serde_json::json!(m.start_type);
    if let Some(hms) = &m.fixtime_hms {
        v["fixtimeHms"] = serde_json::json!(hms);
    }
    v["transition"] = serde_json::json!(m.transition);
    if let Some(frames) = m.transition_rate_frames {
        v["transitionRateFrames"] = serde_json::json!(frames);
    }
    if !m.children.is_empty() {
        v["children"] = serde_json::json!(m.children);
    }
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
    /// Kapitel 6 Teil 3 (`fixtime_loop`-Doku): pro Item-ID, ob/wie ihr
    /// `Fixtime`-Ereignis heute schon abgearbeitet wurde — verhindert
    /// wiederholtes Vor-Cuen/Feuern/Alarmieren bei jedem 1-Sekunden-Tick,
    /// sobald einmal entschieden. An Item-IDs gebunden (nicht an
    /// `fixtime_hms`-Werte), daher bei jedem `do_load()` geleert (dessen
    /// eigene Doku).
    fixtime_resolved: HashMap<String, FixtimeResolution>,
    /// Kapitel 6 Teil 5 (`graphics_loop`-Doku): Ziel-`omp-ograf` für
    /// Grafik-Kind-Ereignisse — dasselbe dynamische Label-Muster wie
    /// `target_player_label`/`target_mixer_label`, aber bewusst
    /// OPTIONAL: ein Rundown ohne Grafik-Kinder braucht keinen
    /// Grafik-Node, ein `do_take` scheitert deshalb NICHT, nur weil
    /// `graphics_node_id` unaufgelöst ist (anders als beim
    /// Player/Mixer) — erst `schedule_children` selbst meldet einen
    /// Fehler, und auch dann nur, wenn das Item tatsächlich Kinder hat.
    target_graphics_label: String,
    graphics_node_id: Option<String>,
    /// Erhöht sich bei JEDER On-Air-Änderung (alle 8 `take_on_targets`-
    /// Aufrufstellen, auch die drei "immer harter Cut"-Ausnahmen) — ein
    /// `ScheduledGraphicsEvent` mit einer älteren Epoche gilt als
    /// storniert, ohne dass `graphics_schedule` aktiv durchsucht/
    /// bereinigt werden muss (verhindert, dass ein End-relatives Kind
    /// des VORHERIGEN On-Air-Items verspätet auf dem NEUEN Item auftaucht).
    graphics_epoch: u64,
    graphics_schedule: Vec<ScheduledGraphicsEvent>,
}

/// s. `AutomationState::fixtime_resolved`-Doku.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FixtimeResolution {
    PreCued,
    Fired,
    Skipped,
}

/// s. `AutomationState::graphics_epoch`-Doku.
#[derive(Debug, Clone)]
enum GraphicsAction {
    Show { template_id: String, data: Value },
    Hide,
}

#[derive(Debug, Clone)]
struct ScheduledGraphicsEvent {
    epoch: u64,
    fire_at: Instant,
    action: GraphicsAction,
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
    /// Kapitel 6 Teil 5 (`docs/END-GOAL-FEATURES.md` §6.4): an ALLEN
    /// acht On-Air-Änderungs-Stellen aufgerufen (den fünf echten
    /// "dieses Item auf Sendung nehmen"-Pfaden UND den drei "immer
    /// harter Cut"-Ausnahmen, Doku bei `take_on_targets`) — erhöht
    /// zuerst bedingungslos die Epoche (storniert dadurch jedes noch
    /// ausstehende Grafik-Ereignis des VORHERIGEN On-Air-Items, auch
    /// wenn das neue Item selbst gar keine Kinder hat, z. B. Stop/Cart),
    /// und plant danach die Kinder des NEUEN Items (falls vorhanden —
    /// Carts/das synthetische Stop-Item haben nie welche, dieser Zweig
    /// ist für sie ein reines No-op nach dem Epochen-Sprung).
    fn schedule_children(&self, state: &mut AutomationState, item_id: &str, onair_since: Instant) {
        state.graphics_epoch += 1;
        let epoch = state.graphics_epoch;
        let Some(meta) = state.metadata.get(item_id) else { return };
        if meta.children.is_empty() {
            return;
        }
        let next_title = state
            .playlist
            .peek_next()
            .and_then(|id| state.metadata.get(id))
            .map(|m| m.label.clone());
        let item_duration_ms = meta.duration_ms;
        let item_label = meta.label.clone();
        let children = meta.children.clone();
        for child in &children {
            let Some(offset_ms) = child_show_offset_ms(child, item_duration_ms) else {
                self.report(format!(
                    "Grafik-Kind „{}\u{201c} von „{item_label}\u{201c} übersprungen: End-relativ ohne feste Item-Dauer (oder Verzögerung länger als die Dauer)",
                    child.template_id
                ));
                continue;
            };
            let fire_at = onair_since + Duration::from_millis(offset_ms);
            let data = resolve_variables(&child.data, next_title.as_deref());
            state.graphics_schedule.push(ScheduledGraphicsEvent {
                epoch,
                fire_at,
                action: GraphicsAction::Show { template_id: child.template_id.clone(), data },
            });
            if child.duration_ms > 0 {
                state.graphics_schedule.push(ScheduledGraphicsEvent {
                    epoch,
                    fire_at: fire_at + Duration::from_millis(child.duration_ms),
                    action: GraphicsAction::Hide,
                });
            }
        }
    }

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

        // Kapitel 6 Teil 2 (§6.4 "Verfügbarkeits-Absatz"): NUR bei Take
        // blockierend geprüft, nicht bei Cue — Cuen bleibt harmlose
        // Vorschau/Vorbereitung, auch für ein Item, dessen Quelle gerade
        // fehlt (Operator soll das sehen können, ohne blockiert zu
        // werden; dieselbe "Cue bleibt möglich"-Linie wie beim
        // Manual-Start-Feld, Kapitel 6 Teil 1). `missingBehavior` bleibt
        // v1 bewusst nur "block" — kein Auto-Skip/Idle-Fallback (PC-
        // Vorbild s. Nachtrag 180): welches Item ein Auto-Advance
        // stattdessen automatisch nehmen sollte, ist eine eigene, noch
        // nicht getroffene Design-Entscheidung.
        if let Some(m) = state.metadata.get(&item_id)
            && !item_is_available(m, &state.media_library, &state.available_sources)
        {
            return Err(format!(
                "„{}\u{201c} nicht verfügbar (Datei fehlt oder Live-Quelle offline) — Take verweigert",
                m.label
            ));
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
        let (transition, rate_frames) = item_transition(&state, &item_id);

        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &item_id, transition, rate_frames)?;

        state.playlist.take().map_err(|e| e.to_string())?;
        let onair_since = Instant::now();
        state.onair_since = Some(onair_since);
        self.schedule_children(&mut state, &item_id, onair_since);
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
        // Kapitel 6 Teil 1 (`docs/END-GOAL-FEATURES.md` §6.4, `startType:
        // manual`): VOR dem eigentlichen `advance()` prüfen, ob das
        // nächste Item manuell startet — `playlist.rs` kennt Item-
        // Metadaten bewusst nicht (Moduldoku dort), deshalb hier statt
        // eines Prädikat-Parameters an `advance()` selbst. Im `Hold`-Modus
        // erübrigt sich das: `advance()` rückt dort ohnehin nie automatisch
        // vor, unabhängig vom `startType`.
        if state.playlist.mode() != Mode::Hold
            && let Some(next_id) = state.playlist.peek_next().map(str::to_string)
        {
            let is_manual = state
                .metadata
                .get(&next_id)
                .map(|m| m.start_type == StartType::Manual)
                .unwrap_or(false);
            if is_manual {
                // Cued, aber NICHT auf Sendung genommen — sichtbar als
                // "als Nächstes fällig, wartet auf TAKE" statt einfach
                // am Listenende zu verharren. Kein Remote-Aufruf: das
                // aktuelle On-Air-Item beim Ziel-Player läuft unverändert
                // weiter (kein EOS-Konzept, s. `take()`-Doku oben).
                if let Some(index) = state.playlist.index_of(&next_id) {
                    let _ = state.playlist.cue(index);
                }
                state.onair_since = None;
                return Ok(());
            }
        }
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
        let (transition, rate_frames) = item_transition(&state, &item_id);

        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &item_id, transition, rate_frames)?;
        let onair_since = Instant::now();
        state.onair_since = Some(onair_since);
        self.schedule_children(&mut state, &item_id, onair_since);
        state.last_live_item_id = Some(item_id);
        Ok(())
    }

    /// Kapitel 6 Teil 3 (`docs/END-GOAL-FEATURES.md` §6.4, "harter
    /// Unterbrecher"): Gegenstück zu `do_take`, aber ohne dessen
    /// Vorbedingung "muss bereits gecued sein" — ein Fixtime-Event
    /// springt die Sequenz-Cue-Position selbst dorthin (`cue()` VOR
    /// `take()`), unabhängig davon, was gerade gecued/on-air war.
    /// Aufgerufen von `fixtime_loop`, nicht direkt von außen erreichbar
    /// (kein `invoke`-Dispatch-Zweig) — Fixtime ist ein reiner
    /// Automatismus, kein manueller Bedienweg. Cart-Vorrang wie überall
    /// sonst: der Aufrufer prüft das ohnehin schon VOR dem Aufruf (s.
    /// `fixtime_loop`), hier trotzdem als zweite Sicherung (kein
    /// Zeitfenster zwischen Prüfung und Aufruf, in dem ein Cart
    /// unbemerkt scharf werden könnte).
    fn do_fire_fixtime(&self, item_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        if state.active_cart.is_some() {
            return Err("Cart aktiv".to_string());
        }
        let index = state
            .playlist
            .index_of(item_id)
            .ok_or("Fixtime-Item nicht mehr im Rundown".to_string())?;

        if let Some(m) = state.metadata.get(item_id)
            && !item_is_available(m, &state.media_library, &state.available_sources)
        {
            return Err(format!(
                "„{}\u{201c} nicht verfügbar (Datei fehlt oder Live-Quelle offline)",
                m.label
            ));
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
        let (transition, rate_frames) = item_transition(&state, item_id);

        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, item_id, transition, rate_frames)?;

        state.playlist.cue(index).map_err(|e| e.to_string())?;
        state.playlist.take().map_err(|e| e.to_string())?;
        let onair_since = Instant::now();
        state.onair_since = Some(onair_since);
        self.schedule_children(&mut state, item_id, onair_since);
        state.last_live_item_id = Some(item_id.to_string());
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
        let (transition, rate_frames) = item_transition(&state, &item_id);

        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &item_id, transition, rate_frames)?;
        let onair_since = Instant::now();
        state.onair_since = Some(onair_since);
        self.schedule_children(&mut state, &item_id, onair_since);
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
        let (transition, rate_frames) = item_transition(&state, &item_id);

        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &item_id, transition, rate_frames)?;

        state.playlist.cue(target_index).map_err(|e| e.to_string())?;
        state.playlist.take().map_err(|e| e.to_string())?;
        let onair_since = Instant::now();
        state.onair_since = Some(onair_since);
        self.schedule_children(&mut state, &item_id, onair_since);
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

        // Kapitel 6 Teil 4: Schwarzbild-Stop bleibt immer ein sofortiger
        // Cut — ein Operator, der auf "Stop" drückt, erwartet sofortige
        // Wirkung, keine Ramp-Down-Rampe.
        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &stop_item_id, Transition::Cut, None)?;
        // Kapitel 6 Teil 5: das synthetische Schwarzbild-Item hat nie
        // Kinder — dieser Aufruf storniert nur (Epochen-Sprung) noch
        // ausstehende Grafik-Ereignisse des VORHERIGEN On-Air-Items,
        // s. `schedule_children`-Doku.
        self.schedule_children(&mut state, &stop_item_id, Instant::now());

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
    // Kapitel 6 Teil 1s `start_type`-Parameter drückt die Signatur auf 8
    // Argumente — gleiche Konvention wie andernorts im Projekt (z. B.
    // `omp-video-mixer-me::spawn_autotrans`, `docs/decisions.md`
    // Nachtrag 177): `#[allow]` statt einer Parameter-Struct, die hier
    // nur für einen einzigen Aufrufer (der `invoke("append", …)`-Zweig)
    // zusätzliche Indirektion brächte.
    #[allow(clippy::too_many_arguments)]
    fn do_append(
        &self,
        label: String,
        pattern: Option<String>,
        file: Option<String>,
        sender_id: Option<String>,
        tone_frequency: Option<f64>,
        duration_ms: Option<u64>,
        start_type: Option<StartType>,
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
        let mut meta = item_meta_from_player_json(&new_item).ok_or("Neues Player-Item unlesbar")?;
        meta.start_type = start_type.unwrap_or_default();

        state.playlist.append(new_id.clone());
        state.metadata.insert(new_id, meta);
        // C20: kein state.timeline.invalidate_from() nötig — append()
        // hängt immer ans Ende (Playlist::append-Doku), der Zeitplan-
        // Cache bleibt für alle bestehenden Indizes gültig.
        Ok(())
    }

    fn do_load(&self, items_json: &str) -> Result<(), String> {
        // Form-Validierung vor dem Weiterreichen an den Player (dessen
        // `load()` dieselbe Form erwartet, `omp-player/src/main.rs`s
        // `LoadItem`) — die Player-relevanten Felder selbst werden hier
        // nicht gebraucht, die maßgebliche Auswertung inkl. Defaults
        // passiert im Player; die eigene Sicht wird danach aus dessen
        // Antwort rekonstruiert (s. u.), nicht aus diesen Rohdaten.
        // **Ausnahme: `startType`** (Kapitel 6 Teil 1) — ein rein
        // automationsseitiges Feld, das der Player nicht kennt (und beim
        // Weiterreichen des unveränderten `items_json` an ihn stillschweigend
        // ignoriert, da sein eigenes `LoadItem` kein `deny_unknown_fields`
        // setzt). Ohne diesen positionellen Zip würde JEDER `load()`-Aufruf
        // (auch der reine Reorder aus dem UI, `ui/bundle.js::reorderItems`)
        // alle `startType`-Werte auf `sequence` zurücksetzen, weil `load()`
        // beim Player IMMER frische Item-IDs vergibt (`next_seq`, nie
        // wiederverwendet) — die alte ID-Zuordnung wäre nach jedem Reorder
        // verloren. Die UI schickt deshalb bei jedem `load()` (auch beim
        // Reorder) den zuletzt bekannten `startType` pro Item mit, hier per
        // Index mit der Player-Antwort gezippt (Reihenfolge bleibt über
        // einen einzelnen `load()`-Aufruf hinweg stabil, `omp-player`s
        // `main.rs`-Schleife baut `items` in exakt der Eingabereihenfolge).
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
            #[serde(rename = "startType", default)]
            start_type: StartType,
            #[serde(rename = "fixtimeHms", default)]
            fixtime_hms: Option<String>,
            // Kapitel 6 Teil 4: dieselbe Reorder-Rettung wie oben bei
            // `startType`/`fixtimeHms` (Nachtrag 181-Lehre) — ohne das
            // würde jeder Reorder eine `mix`-Transition stillschweigend
            // auf `cut` zurücksetzen.
            #[serde(rename = "transition", default)]
            transition: Transition,
            #[serde(rename = "transitionRateFrames", default)]
            transition_rate_frames: Option<u32>,
            // Kapitel 6 Teil 5: dieselbe Reorder-Rettung zum vierten Mal,
            // diesmal proaktiv beim Schreiben ergänzt statt erst nach
            // einem Live-Fund (Nachtrag 181-Lehre endgültig verinnerlicht).
            #[serde(default)]
            children: Vec<GraphicsChild>,
        }
        let load_items: Vec<LoadItem> = serde_json::from_str(items_json)
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

        // `items.len()` kann von `load_items.len()` abweichen, falls der
        // Player selbst Einträge verwirft (z. B. eine unlesbare Datei,
        // s. dessen `resolve_media_path`) — `.get(i)` statt Index-Panik,
        // `unwrap_or_default()` (= `sequence`) für jeden ohne Entsprechung.
        let mut ids = Vec::with_capacity(items.len());
        let mut metadata = HashMap::with_capacity(items.len());
        for (i, it) in items.into_iter().enumerate() {
            let id = it
                .get("id")
                .and_then(Value::as_str)
                .ok_or("Player-Item ohne id")?
                .to_string();
            let mut meta = item_meta_from_player_json(&it).ok_or("Player-Item unlesbar")?;
            let load_item = load_items.get(i);
            meta.start_type = load_item.map(|li| li.start_type).unwrap_or_default();
            meta.fixtime_hms = load_item.and_then(|li| li.fixtime_hms.clone());
            meta.transition = load_item.map(|li| li.transition).unwrap_or_default();
            meta.transition_rate_frames = load_item.and_then(|li| li.transition_rate_frames);
            meta.children = load_item.map(|li| li.children.clone()).unwrap_or_default();
            metadata.insert(id.clone(), meta);
            ids.push(id);
        }

        // Kapitel 6 Teil 3: `fixtime_resolved` ist an die (bei jedem
        // `load()` frisch vergebenen) Item-IDs gebunden — ein Reorder
        // erzeugt zwangsläufig neue IDs (Doku bei `load_items` oben),
        // der alte Resolved-Zustand wäre ohnehin nicht mehr sinnvoll
        // zuordenbar. Bewusst NICHT versucht, ihn wie `startType`
        // positionell zu retten — ein Fixtime-Event, das VOR einem
        // Reorder bereits gefeuert hat, feuert danach höchstens ein
        // zweites Mal fälschlich (harmlos: derselbe Take wie eh schon
        // aktiv), verpasst aber nie eins.
        state.fixtime_resolved.clear();
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

    /// Kapitel 6 Teil 1 (`docs/END-GOAL-FEATURES.md` §6.4): rein lokale
    /// Metadaten-Änderung, bewusst OHNE jeden Player-Roundtrip — anders
    /// als `do_cue`/`do_remove` betrifft `startType` nur, WIE dieser
    /// Node selbst später auto-vorrückt (`do_advance`), nicht was der
    /// Ziel-Player gerade zeigt. Ein `load()`-Umweg (wie beim Reorder,
    /// `ui/bundle.js::reorderItems`-Doku) wäre hier unnötig teuer: `load()`
    /// setzt den Player unbedingt auf Schwarzbild zurück, nur um ein
    /// einzelnes Flag umzuschalten.
    /// `fixtime_hms` (Kapitel 6 Teil 3): nur bei `start_type ==
    /// StartType::Fixtime` ausgewertet und validiert (`parse_hms_to_secs`)
    /// — bei jedem anderen `start_type` wird das Feld auf `None`
    /// zurückgesetzt, ein Item kann also nicht "heimlich" seine alte
    /// Fixzeit behalten, nachdem es auf `sequence`/`manual`
    /// zurückgeschaltet wurde. Ein Wechsel AUF `fixtime` OHNE gültige
    /// Zeit wird abgelehnt (kein sinnvoller "Fixtime ohne Zeit"-Zustand,
    /// `fixtime_loop` würde ihn ohnehin ignorieren, hier aber lieber ein
    /// klarer Fehler als ein still wirkungsloses Item).
    fn do_set_start_type(
        &self,
        item_id: &str,
        start_type: StartType,
        fixtime_hms: Option<String>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let resolved_fixtime = if start_type == StartType::Fixtime {
            let hms = fixtime_hms.ok_or("fixtimeHms fehlt (Format HH:MM:SS)".to_string())?;
            if parse_hms_to_secs(&hms).is_none() {
                return Err(format!("fixtimeHms „{hms}\u{201c} ungültig (Format HH:MM:SS)"));
            }
            Some(hms)
        } else {
            None
        };
        match state.metadata.get_mut(item_id) {
            Some(meta) => {
                meta.start_type = start_type;
                meta.fixtime_hms = resolved_fixtime;
                // Ein manueller Rückstufungs-/Neuansetzungs-Wunsch des
                // Operators soll sofort wieder feuern dürfen, nicht an
                // einem alten Resolved-Zustand von vorher hängen bleiben.
                state.fixtime_resolved.remove(item_id);
                Ok(())
            }
            None => Err("unbekannte itemId".to_string()),
        }
    }

    /// Kapitel 6 Teil 4 (`docs/END-GOAL-FEATURES.md` §6.4 "Take-
    /// Choreografie mit Transitions"): reine lokale Metadaten-Änderung
    /// wie `do_set_start_type` — betrifft nur, WIE ein KÜNFTIGES Take
    /// dieses Items am Mixer abläuft, nicht den aktuellen On-Air-Zustand
    /// (kein sofortiger Mixer-Aufruf hier). `rate_frames`: `None` lässt
    /// eine vorher gesetzte Rate unverändert (nicht auf den
    /// Mixer-Default zurücksetzen).
    fn do_set_transition(
        &self,
        item_id: &str,
        transition: Transition,
        rate_frames: Option<u32>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        match state.metadata.get_mut(item_id) {
            Some(meta) => {
                meta.transition = transition;
                meta.transition_rate_frames = rate_frames;
                Ok(())
            }
            None => Err("unbekannte itemId".to_string()),
        }
    }

    /// Kapitel 6 Teil 5 (`docs/END-GOAL-FEATURES.md` §6.4 "Children-
    /// Editor"): ersetzt die GESAMTE Kind-Liste eines Items — kein
    /// Hinzufügen/Entfernen einzelner Kinder als eigenes Method (dieselbe
    /// "ganzer Ersatz statt PATCH-per-Feld"-Linie wie beim generischen
    /// Node-Katalog-Editor, `docs/END-GOAL-FEATURES.md` §17). Rein lokal
    /// wie `do_set_start_type`/`do_set_transition`, kein Player-/Mixer-
    /// Roundtrip — wirkt erst beim NÄCHSTEN Take dieses Items
    /// (`schedule_children` liest die Liste dort neu), ein bereits
    /// laufender On-Air-Zeitplan wird von einer Änderung hier nicht
    /// rückwirkend angepasst.
    fn do_set_children(&self, item_id: &str, children: Vec<GraphicsChild>) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        match state.metadata.get_mut(item_id) {
            Some(meta) => {
                meta.children = children;
                Ok(())
            }
            None => Err("unbekannte itemId".to_string()),
        }
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
                // Carts laufen nie durch `Playlist::advance()` (eigener
                // `state.carts`-Vec, nur per explizitem `cart.fire`
                // ausgelöst) — `startType` ist hier bedeutungslos, bleibt
                // aber gesetzt, weil `ItemMeta` ein geteilter Typ ist
                // (Doku oben) — Carts feuern immer per `cart.fire`
                // ausdrücklich mit hartem `Transition::Cut` (Doku dort),
                // dieselbe "bedeutungslos, aber gesetzt"-Logik gilt daher
                // auch für `transition`.
                start_type: StartType::default(),
                fixtime_hms: None,
                transition: Transition::default(),
                transition_rate_frames: None,
                children: Vec::new(),
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

        // Kapitel 6 Teil 4: ein Cart-Interrupt ist per Definition ein
        // sofortiges Eingreifen (Blackclip, Standby, …) — immer harter
        // Cut, unabhängig davon, was `transition` für dieses (synthetische
        // Test-Muster-)Cart-Item ohnehin bedeutungslos trüge.
        take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &cart_item_id, Transition::Cut, None)?;
        // Kapitel 6 Teil 5: Cart-Assets haben nie Kinder (Doku oben) —
        // storniert nur ausstehende Grafik-Ereignisse des unterbrochenen
        // Hauptkanal-Items.
        self.schedule_children(&mut state, &cart_item_id, Instant::now());

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
            // Kapitel 6 Teil 4: Return nach einem Interrupt bewusst immer
            // ein harter Cut, unabhängig vom `transition`-Feld des
            // wiederhergestellten Items — Vorhersagbarkeit nach einem
            // Cart-Interrupt zählt hier mehr als eine weiche Rampe.
            take_on_targets(self, &player_node_id, &mixer_node_id, &player_label, &restore_id, Transition::Cut, None)?;
            let restored_onair_since =
                Instant::now() - Duration::from_millis(active.elapsed_before_interrupt_ms as u64);
            state.onair_since = Some(restored_onair_since);
            // Kapitel 6 Teil 5: dieselbe zurückdatierte `onair_since` wie
            // oben (Restdauer-Prinzip, C18) — ein Kind, dessen Zeitfenster
            // während des Interrupts bereits verstrichen wäre, feuert
            // dadurch beim Return sofort (Show unmittelbar gefolgt von
            // Hide, `graphics_loop` sortiert fällige Ereignisse vor dem
            // Versand nach `fire_at`) statt entweder nie oder dauerhaft zu
            // erscheinen — ein knappes, aber korrektes Verhalten für einen
            // seltenen Randfall, kein perfekter "hat es schon gezeigt"-
            // Zustand.
            self.schedule_children(&mut state, &restore_id, restored_onair_since);
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
/// Kapitel 6 Teil 4: `transition`/`rate_frames` steuern nur noch den
/// LETZTEN Schritt am Mixer (Cut vs. Mix) — Player-seitiges cue/take
/// bleibt für beide Transition-Arten identisch, der Player kennt das
/// Konzept nicht (dieselbe Trennung wie bei `StartType`). Aufrufer, die
/// IMMER einen harten Cut wollen (Stop-Schwarzbild, Cart-Interrupt/
/// -Return — Doku an deren jeweiligen Aufrufstellen), übergeben explizit
/// `(Transition::Cut, None)` statt das Item-eigene `transition`-Feld zu
/// befragen.
fn take_on_targets(
    store: &AutomationStore,
    player_node_id: &str,
    mixer_node_id: &str,
    player_label: &str,
    item_id: &str,
    transition: Transition,
    rate_frames: Option<u32>,
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
    match transition {
        Transition::Cut => {
            mixer
                .invoke("crosspoint.cut", serde_json::json!({}))
                .map_err(|e| format!("Mixer-crosspoint.cut fehlgeschlagen: {e}"))?;
        }
        Transition::Mix => {
            if let Some(frames) = rate_frames {
                mixer
                    .invoke("crosspoint.setTransRate", serde_json::json!({"frames": frames}))
                    .map_err(|e| format!("Mixer-crosspoint.setTransRate fehlgeschlagen: {e}"))?;
            }
            mixer
                .invoke("crosspoint.autoTrans", serde_json::json!({}))
                .map_err(|e| format!("Mixer-crosspoint.autoTrans fehlgeschlagen: {e}"))?;
        }
    }

    Ok(())
}

/// Kapitel 6 Teil 4: liest `transition`/`transition_rate_frames` aus
/// `state.metadata` für `item_id` — Default `(Cut, None)`, falls das
/// Item (noch) keine eigene Metadaten-Zeile hat (sollte für ein
/// gerade aufgelöstes Rundown-Item nicht vorkommen, aber ein fehlender
/// Eintrag ist kein Grund, den Take selbst scheitern zu lassen).
fn item_transition(state: &AutomationState, item_id: &str) -> (Transition, Option<u32>) {
    state
        .metadata
        .get(item_id)
        .map(|m| (m.transition, m.transition_rate_frames))
        .unwrap_or((Transition::Cut, None))
}

/// Kapitel 6 Teil 5 (`docs/END-GOAL-FEATURES.md` §6.4 "Grafik-Child-
/// Events... relativ zu Clip-Start ODER -Ende"): reine Zeit-Arithmetik,
/// kein State/keine Uhr — testbar wie `fixtime_action`. Rechnet den
/// Versatz (ms) zwischen dem On-Air-Beginn des tragenden Items und dem
/// Anzeige-Zeitpunkt des Kinds aus. `item_duration_ms == 0` (endlos,
/// Live-/manuelle Items) macht `RelativeTo::End` bedeutungslos — `None`
/// statt eines erfundenen Zeitpunkts, ebenso bei einer `delay_ms` >
/// `item_duration_ms` (End-relativ VOR dem Start wäre unsinnig).
fn child_show_offset_ms(child: &GraphicsChild, item_duration_ms: u64) -> Option<u64> {
    match child.relative_to {
        RelativeTo::Start => Some(child.delay_ms),
        RelativeTo::End => {
            if item_duration_ms == 0 {
                return None;
            }
            item_duration_ms.checked_sub(child.delay_ms)
        }
    }
}

/// Kapitel 6 Teil 5 (§6.4 "Variablen-Auflösung ({{next:title}}-
/// Teilmenge)"): ersetzt `{{next:title}}` in allen String-Werten von
/// `data` (rekursiv durch Objekte/Arrays) durch den Titel des
/// chronologisch nächsten Rundown-Items — die einzige in dieser
/// Ausbaustufe unterstützte Variable, bewusst keine generische
/// Template-Engine. `next_title: None` (kein nächstes Item, z. B.
/// letztes Item der Liste) ersetzt durch einen leeren String statt den
/// Platzhalter unverändert stehen zu lassen (der wäre sonst sichtbar
/// auf der Grafik, ein leeres Feld ist die unauffälligere Ausfallstufe).
fn resolve_variables(data: &Value, next_title: Option<&str>) -> Value {
    const VAR_NEXT_TITLE: &str = "{{next:title}}";
    match data {
        Value::String(s) if s.contains(VAR_NEXT_TITLE) => {
            Value::String(s.replace(VAR_NEXT_TITLE, next_title.unwrap_or("")))
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| resolve_variables(v, next_title)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter().map(|(k, v)| (k.clone(), resolve_variables(v, next_title))).collect(),
        ),
        other => other.clone(),
    }
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
            // Kapitel 6 Teil 5 — optional, s. `target_graphics_label`-Doku.
            ParamSpec {
                name: "targetGraphicsLabel".to_string(),
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
                    // Kapitel 6 Teil 1 — "sequence" (Default) oder "manual".
                    MethodArg {
                        name: "startType".to_string(),
                        kind: ParamType::String,
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
            // Kapitel 6 Teil 1: reine lokale Metadaten-Änderung, KEIN
            // Player-Roundtrip (s. `do_set_start_type`-Doku) — deshalb ein
            // eigenes, leichtgewichtiges Method statt über `load()`.
            MethodSpec {
                name: "setStartType".to_string(),
                args: vec![
                    MethodArg {
                        name: "itemId".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "startType".to_string(),
                        kind: ParamType::String,
                    },
                    // Kapitel 6 Teil 3 — nur bei startType=="fixtime"
                    // ausgewertet (do_set_start_type-Doku), Format
                    // "HH:MM:SS".
                    MethodArg {
                        name: "fixtimeHms".to_string(),
                        kind: ParamType::String,
                    },
                ],
            },
            // Kapitel 6 Teil 4: ebenfalls reine lokale Metadaten-Änderung
            // (do_set_transition-Doku).
            MethodSpec {
                name: "setTransition".to_string(),
                args: vec![
                    MethodArg {
                        name: "itemId".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "transition".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "transitionRateFrames".to_string(),
                        kind: ParamType::Number,
                    },
                ],
            },
            // Kapitel 6 Teil 5: `childrenJson` ist JSON-kodiert (Array von
            // `GraphicsChild`), gleiches Muster wie `load`s `itemsJson` —
            // komplexe/verschachtelte Daten gehen in diesem SDK immer als
            // JSON-String-Argument, nicht als eigener `ParamType`
            // (do_set_children-Doku).
            MethodSpec {
                name: "setChildren".to_string(),
                args: vec![
                    MethodArg {
                        name: "itemId".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "childrenJson".to_string(),
                        kind: ParamType::String,
                    },
                ],
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

        Descriptor { parameters, methods, latency: None }
    }

    fn get(&self, name: &str) -> Option<Value> {
        let state = self.state.lock().expect("lock poisoned");
        match name {
            "items" => Some(serde_json::json!(
                state
                    .playlist
                    .items()
                    .iter()
                    .filter_map(|id| state.metadata.get(id).map(|m| {
                        let mut v = item_meta_to_json(id, m);
                        v["available"] =
                            serde_json::json!(item_is_available(m, &state.media_library, &state.available_sources));
                        v
                    }))
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
            "targetGraphicsLabel" => Some(serde_json::json!(state.target_graphics_label)),
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
            "targetGraphicsLabel" => {
                state.target_graphics_label = value.as_str().unwrap_or_default().to_string();
                state.graphics_node_id = None;
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
                let start_type = args.get("startType").and_then(Value::as_str).and_then(StartType::parse);
                self.do_append(label, pattern, file, sender_id, tone_frequency, duration_ms, start_type)
            }
            "load" => {
                let items_json = args.get("itemsJson").and_then(Value::as_str).unwrap_or("[]");
                self.do_load(items_json)
            }
            "remove" => match args.get("itemId").and_then(Value::as_str) {
                Some(id) => self.do_remove(id),
                None => Err("itemId fehlt".to_string()),
            },
            "setStartType" => {
                let item_id = args.get("itemId").and_then(Value::as_str);
                let start_type = args.get("startType").and_then(Value::as_str).and_then(StartType::parse);
                let fixtime_hms = args.get("fixtimeHms").and_then(Value::as_str).map(str::to_string);
                match (item_id, start_type) {
                    (Some(id), Some(st)) => self.do_set_start_type(id, st, fixtime_hms),
                    (None, _) => Err("itemId fehlt".to_string()),
                    (_, None) => Err("startType fehlt oder ungültig (sequence|manual|fixtime)".to_string()),
                }
            }
            "setTransition" => {
                let item_id = args.get("itemId").and_then(Value::as_str);
                let transition = args.get("transition").and_then(Value::as_str).and_then(Transition::parse);
                let rate_frames = args
                    .get("transitionRateFrames")
                    .and_then(Value::as_f64)
                    .filter(|f| f.is_finite() && *f >= 1.0 && *f <= 250.0)
                    .map(|f| f as u32);
                match (item_id, transition) {
                    (Some(id), Some(t)) => self.do_set_transition(id, t, rate_frames),
                    (None, _) => Err("itemId fehlt".to_string()),
                    (_, None) => Err("transition fehlt oder ungültig (cut|mix)".to_string()),
                }
            }
            // IIFE-Closure statt der sonstigen Tupel-Match-Form (s.
            // "setStartType"/"setTransition" oben) — hier zwei
            // unabhängige Fehlerquellen (fehlende `itemId`, ungültiges
            // `childrenJson`), `?` innerhalb der Closure bleibt lesbarer
            // als eine dreiwertige Tupel-Verzweigung.
            "setChildren" => (|| {
                let item_id = args.get("itemId").and_then(Value::as_str).ok_or("itemId fehlt".to_string())?;
                let children_json = args.get("childrenJson").and_then(Value::as_str).unwrap_or("[]");
                let children: Vec<GraphicsChild> = serde_json::from_str(children_json)
                    .map_err(|e| format!("childrenJson ungültig: {e}"))?;
                self.do_set_children(item_id, children)
            })(),
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
            self.report(e.clone());
            InvokeError::Message(e)
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
        let (player_label, mixer_label, graphics_label) = {
            let state = store.state.lock().expect("lock poisoned");
            (
                state.target_player_label.clone(),
                state.target_mixer_label.clone(),
                state.target_graphics_label.clone(),
            )
        };
        let registry = store.registry.clone();
        let own_label = store.own_label.clone();
        let resolved = tokio::task::spawn_blocking(move || {
            (
                remote::resolve_node_id_by_label(&registry, &player_label),
                remote::resolve_node_id_by_label(&registry, &mixer_label),
                // Kapitel 6 Teil 5: `resolve_node_id_by_label` gibt bei
                // leerem Label ohnehin `None` zurück (eigener Guard dort)
                // — der Kurzschluss hier spart nur den sonst unnötigen
                // `list_nodes()`-Registry-Aufruf alle 2s im (erwartet
                // häufigen) Fall "kein Grafik-Ziel konfiguriert".
                if graphics_label.is_empty() {
                    None
                } else {
                    remote::resolve_node_id_by_label(&registry, &graphics_label)
                },
                remote::list_node_labels(&registry, &own_label),
            )
        })
        .await;
        if let Ok((player_node_id, mixer_node_id, graphics_node_id, discovered_labels)) = resolved {
            let mut state = store.state.lock().expect("lock poisoned");
            state.player_node_id = player_node_id;
            state.mixer_node_id = mixer_node_id;
            state.graphics_node_id = graphics_node_id;
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

/// Kapitel 6 Teil 3 (`docs/END-GOAL-FEATURES.md` §6.4/§6.5): eigener
/// 1-Sekunden-Takt statt Wiederverwendung von `ADVANCE_TICK` (200ms,
/// `auto_advance_loop`) — Wanduhr-Vergleiche brauchen keine
/// Zehntelsekunden-Auflösung, ein eigener, gröberer Takt hält diese
/// neue Logik außerdem vollständig getrennt vom bereits bewährten
/// Advance-Pfad (kein Risiko, dort etwas zu verändern).
async fn fixtime_loop(store: Arc<AutomationStore>, events: mpsc::UnboundedSender<Event>) {
    let mut interval = tokio::time::interval(FIXTIME_TICK);
    loop {
        interval.tick().await;
        let now_secs = seconds_since_midnight_local();

        // Entscheidungs-Schnappschuss bei kurz gehaltenem Lock — keine
        // Fernaufrufe/`spawn_blocking`s, während die Sperre hält (gleiches
        // Prinzip wie `auto_advance_loop` oben).
        let (precue_ids, fire_ids, skip_infos): (Vec<String>, Vec<String>, Vec<(String, String)>) = {
            let state = store.state.lock().expect("lock poisoned");
            let live_ids: std::collections::HashSet<&String> = state.playlist.items().iter().collect();
            let mut precue = Vec::new();
            let mut fire = Vec::new();
            let mut skip = Vec::new();
            for (id, meta) in state.metadata.iter() {
                if meta.start_type != StartType::Fixtime || !live_ids.contains(id) {
                    continue;
                }
                let Some(target_secs) = meta.fixtime_hms.as_deref().and_then(parse_hms_to_secs) else {
                    continue;
                };
                let already = state.fixtime_resolved.get(id).copied();
                match fixtime_action(now_secs, target_secs, already) {
                    FixtimeAction::None => {}
                    FixtimeAction::PreCue => precue.push(id.clone()),
                    FixtimeAction::Fire => fire.push(id.clone()),
                    FixtimeAction::Skip => skip.push((id.clone(), meta.label.clone())),
                }
            }
            (precue, fire, skip)
        };

        for id in precue_ids {
            let store2 = store.clone();
            let id2 = id.clone();
            let result = tokio::task::spawn_blocking(move || store2.do_cue(&id2)).await;
            match result {
                Ok(Ok(())) => {
                    store.state.lock().expect("lock poisoned").fixtime_resolved.insert(id, FixtimeResolution::PreCued);
                }
                Ok(Err(e)) => {
                    let _ = events.send(Event::Error(format!("Fixtime-Vor-Cue fehlgeschlagen: {e}")));
                }
                Err(e) => {
                    let _ = events.send(Event::Error(format!("Fixtime-Vor-Cue-Task abgestürzt: {e}")));
                }
            }
        }

        for id in fire_ids {
            // Kein Feuern, solange ein Cart aktiv ist — innerhalb des
            // Gnadenfensters beim nächsten Tick einfach erneut versuchen,
            // statt den Interrupt-Kanal zu erzwingen (§6.4: Fixtime ist
            // ein harter Unterbrecher der SEQUENZ, nicht des Cart-Kanals).
            let cart_active = store.state.lock().expect("lock poisoned").active_cart.is_some();
            if cart_active {
                continue;
            }
            let store2 = store.clone();
            let id2 = id.clone();
            let result = tokio::task::spawn_blocking(move || store2.do_fire_fixtime(&id2)).await;
            match result {
                Ok(Ok(())) => {
                    store.state.lock().expect("lock poisoned").fixtime_resolved.insert(id, FixtimeResolution::Fired);
                }
                Ok(Err(e)) => {
                    // Kein sinnvoller Retry binnen der nächsten Sekunde
                    // (z. B. fehlende Verfügbarkeit) — sofort als
                    // übersprungen werten statt bis zum Ablauf des
                    // Gnadenfensters stumm zu bleiben.
                    store.state.lock().expect("lock poisoned").fixtime_resolved.insert(id.clone(), FixtimeResolution::Skipped);
                    let _ = events.send(Event::Error(format!("Fixtime-Event „{id}\u{201c} übersprungen: {e}")));
                }
                Err(e) => {
                    let _ = events.send(Event::Error(format!("Fixtime-Feuer-Task abgestürzt: {e}")));
                }
            }
        }

        if !skip_infos.is_empty() {
            let mut state = store.state.lock().expect("lock poisoned");
            for (id, label) in skip_infos {
                state.fixtime_resolved.insert(id, FixtimeResolution::Skipped);
                let _ = events.send(Event::Error(format!(
                    "Fixtime-Event „{label}\u{201c} verpasst (Gnadenfenster {FIXTIME_GRACE_SECS}s überschritten) — übersprungen"
                )));
            }
        }
    }
}

/// Kapitel 6 Teil 5 (`docs/END-GOAL-FEATURES.md` §6.4/§6.5): eigener,
/// von `auto_advance_loop`/`fixtime_loop` komplett getrennter Takt
/// (gleiches "neue Planungs-Zuständigkeit bekommt einen eigenen Loop"-
/// Prinzip wie bei Kapitel 6 Teil 3) — feiner als `fixtime_loop`s 1s
/// (Grafikeinblendungen dürfen sichtbar präziser sein als eine
/// Wanduhr-Minute), aber nicht so fein wie der 200ms-Advance-Tick
/// (kein Zeitkritischer On-Air-Wechsel, nur ein Overlay).
async fn graphics_loop(store: Arc<AutomationStore>, events: mpsc::UnboundedSender<Event>) {
    let mut interval = tokio::time::interval(GRAPHICS_TICK);
    loop {
        interval.tick().await;
        let now = Instant::now();

        // Fällige Ereignisse aus der aktuellen Epoche einsammeln (nach
        // `fire_at` sortiert — wichtig für den Cart-Return-Nachhol-Fall,
        // s. dortige Doku: Show muss vor ihrem eigenen Hide versendet
        // werden, auch wenn beide bereits überfällig sind), storniert
        // (falsche Epoche) UND noch-nicht-fällige Einträge bleiben in
        // `graphics_schedule` bzw. werden beim `retain` verworfen —
        // dieselbe Drain-und-Prune-Bewegung in einem Schritt.
        let (graphics_node_id, due) = {
            let mut state = store.state.lock().expect("lock poisoned");
            let current_epoch = state.graphics_epoch;
            let mut due = Vec::new();
            state.graphics_schedule.retain(|ev| {
                if ev.epoch != current_epoch {
                    return false; // storniert, verwerfen
                }
                if ev.fire_at <= now {
                    due.push(ev.clone());
                    false // fällig, aus der Warteschlange entfernen
                } else {
                    true // noch in der Zukunft, behalten
                }
            });
            due.sort_by_key(|ev| ev.fire_at);
            (state.graphics_node_id.clone(), due)
        };
        if due.is_empty() {
            continue;
        }
        let Some(graphics_node_id) = graphics_node_id else {
            // Kinder geplant, aber kein Ziel-`omp-ograf` (mehr) aufgelöst
            // (z. B. `targetGraphicsLabel` nie/nicht mehr gültig) — einmal
            // pro fälligem Ereignis melden statt still zu verwerfen.
            let label = store.state.lock().expect("lock poisoned").target_graphics_label.clone();
            for _ in &due {
                store.report(format!(
                    "Grafik-Ereignis nicht zustellbar: kein Ziel-omp-ograf aufgelöst (targetGraphicsLabel: „{label}\u{201c})"
                ));
            }
            continue;
        };

        for ev in due {
            let store2 = store.clone();
            let node_id = graphics_node_id.clone();
            let result = tokio::task::spawn_blocking(move || {
                let graphics = store2.proxy_client(node_id);
                match ev.action {
                    GraphicsAction::Show { template_id, data } => {
                        graphics.invoke("show", serde_json::json!({"templateId": template_id, "data": data}))
                    }
                    GraphicsAction::Hide => graphics.invoke("hide", serde_json::json!({})),
                }
            })
            .await;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    let _ = events.send(Event::Error(format!("Grafik-Ereignis fehlgeschlagen: {e}")));
                }
                Err(e) => {
                    let _ = events.send(Event::Error(format!("Grafik-Ereignis-Task abgestürzt: {e}")));
                }
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
    // Kapitel 6 Teil 5 — gleiches Muster, aber optional (Doku bei
    // `AutomationState::target_graphics_label`).
    let initial_graphics_label = std::env::var("OMP_PLAYOUT_TARGET_GRAPHICS_LABEL").unwrap_or_default();

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
        fixtime_resolved: HashMap::new(),
        target_graphics_label: initial_graphics_label,
        graphics_node_id: None,
        graphics_epoch: 0,
        graphics_schedule: Vec::new(),
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

    let fixtime_events = events_tx.clone();
    tokio::spawn(fixtime_loop(store.clone(), fixtime_events));

    let graphics_events = events_tx.clone();
    tokio::spawn(graphics_loop(store.clone(), graphics_events));

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

// Kapitel 6 Teil 2: erster Unit-Test-Block in `main.rs` überhaupt — der
// Rest der Datei ist HTTP-/State-Orchestrierungs-Logik, nur live gegen
// den echten Dev-Stack sinnvoll geprüft (s. docs/decisions.md Nachtrag
// 181). `item_is_available` ist dagegen reine, seiteneffektfreie Logik
// wie `Playlist::peek_next()` — dieselbe Isolations-Überlegung, hier
// eben ohne ein eigenes Modul dafür anzulegen.
#[cfg(test)]
mod availability_tests {
    use super::*;

    fn pattern_item() -> ItemMeta {
        ItemMeta {
            label: "Pattern".to_string(),
            media: ItemMedia::TestPattern { pattern: "smpte".to_string(), tone_frequency: 440.0 },
            duration_ms: 1000,
            start_type: StartType::Sequence,
            fixtime_hms: None,
            transition: Transition::Cut,
            transition_rate_frames: None,
            children: Vec::new(),
        }
    }

    fn file_item(path: &str) -> ItemMeta {
        ItemMeta {
            label: "File".to_string(),
            media: ItemMedia::File { path: path.to_string() },
            duration_ms: 1000,
            start_type: StartType::Sequence,
            fixtime_hms: None,
            transition: Transition::Cut,
            transition_rate_frames: None,
            children: Vec::new(),
        }
    }

    fn live_item(sender_id: &str) -> ItemMeta {
        ItemMeta {
            label: "Live".to_string(),
            media: ItemMedia::Live { sender_id: sender_id.to_string() },
            duration_ms: 1000,
            start_type: StartType::Sequence,
            fixtime_hms: None,
            transition: Transition::Cut,
            transition_rate_frames: None,
            children: Vec::new(),
        }
    }

    #[test]
    fn test_pattern_is_always_available() {
        assert!(item_is_available(&pattern_item(), &[], &[]));
    }

    #[test]
    fn file_is_available_iff_listed_in_media_library() {
        let media_library = vec!["clip.mp4".to_string()];
        assert!(item_is_available(&file_item("clip.mp4"), &media_library, &[]));
        assert!(!item_is_available(&file_item("missing.mp4"), &media_library, &[]));
    }

    #[test]
    fn live_is_available_iff_sender_id_in_available_sources() {
        let sources = vec![serde_json::json!({"senderId": "sender-1", "label": "Cam 1"})];
        assert!(item_is_available(&live_item("sender-1"), &[], &sources));
        assert!(!item_is_available(&live_item("sender-2"), &[], &sources));
    }
}

// Kapitel 6 Teil 3: `parse_hms_to_secs`/`fixtime_action` sind reine
// Funktionen (keine Uhr, kein State) — direkt unit-testbar, gleiches
// Prinzip wie oben.
#[cfg(test)]
mod fixtime_tests {
    use super::*;

    #[test]
    fn parse_hms_accepts_valid_time() {
        assert_eq!(parse_hms_to_secs("14:30:00"), Some(14 * 3600 + 30 * 60));
        assert_eq!(parse_hms_to_secs("00:00:00"), Some(0));
        assert_eq!(parse_hms_to_secs("23:59:59"), Some(23 * 3600 + 59 * 60 + 59));
    }

    #[test]
    fn parse_hms_rejects_out_of_range_or_malformed() {
        assert_eq!(parse_hms_to_secs("24:00:00"), None);
        assert_eq!(parse_hms_to_secs("12:60:00"), None);
        assert_eq!(parse_hms_to_secs("12:00:60"), None);
        assert_eq!(parse_hms_to_secs("12:00"), None);
        assert_eq!(parse_hms_to_secs("12:00:00:00"), None);
        assert_eq!(parse_hms_to_secs("not-a-time"), None);
        assert_eq!(parse_hms_to_secs(""), None);
    }

    #[test]
    fn action_is_none_well_before_precue_window() {
        // 10:00:00 Ziel, jetzt 09:00:00 — weit vor dem 5s-Vor-Cue-Fenster.
        assert_eq!(fixtime_action(9 * 3600, 10 * 3600, None), FixtimeAction::None);
    }

    #[test]
    fn action_precues_inside_the_precue_window_once() {
        let target = 10 * 3600;
        assert_eq!(fixtime_action(target - 3, target, None), FixtimeAction::PreCue);
        // Schon vor-gecued — kein zweites Mal.
        assert_eq!(
            fixtime_action(target - 1, target, Some(FixtimeResolution::PreCued)),
            FixtimeAction::None
        );
    }

    #[test]
    fn action_fires_exactly_at_target_and_within_grace() {
        let target = 10 * 3600;
        assert_eq!(fixtime_action(target, target, None), FixtimeAction::Fire);
        assert_eq!(fixtime_action(target + FIXTIME_GRACE_SECS, target, None), FixtimeAction::Fire);
        assert_eq!(
            fixtime_action(target + 10, target, Some(FixtimeResolution::PreCued)),
            FixtimeAction::Fire
        );
    }

    #[test]
    fn action_skips_once_grace_window_is_exceeded() {
        let target = 10 * 3600;
        assert_eq!(fixtime_action(target + FIXTIME_GRACE_SECS + 1, target, None), FixtimeAction::Skip);
    }

    #[test]
    fn action_is_none_once_fired_or_skipped_regardless_of_time() {
        let target = 10 * 3600;
        assert_eq!(
            fixtime_action(target + 1, target, Some(FixtimeResolution::Fired)),
            FixtimeAction::None
        );
        assert_eq!(
            fixtime_action(target + 1000, target, Some(FixtimeResolution::Skipped)),
            FixtimeAction::None
        );
    }
}

// Kapitel 6 Teil 5: `child_show_offset_ms`/`resolve_variables` sind
// ebenfalls reine Funktionen (kein State/keine Uhr) — direkt
// unit-testbar, gleiches Prinzip wie oben.
#[cfg(test)]
mod graphics_children_tests {
    use super::*;

    fn start_child(delay_ms: u64) -> GraphicsChild {
        GraphicsChild {
            template_id: "lower-third".to_string(),
            data: Value::Null,
            delay_ms,
            duration_ms: 0,
            relative_to: RelativeTo::Start,
        }
    }

    fn end_child(delay_ms: u64) -> GraphicsChild {
        GraphicsChild {
            template_id: "lower-third".to_string(),
            data: Value::Null,
            delay_ms,
            duration_ms: 0,
            relative_to: RelativeTo::End,
        }
    }

    #[test]
    fn start_relative_offset_is_just_the_delay() {
        assert_eq!(child_show_offset_ms(&start_child(3000), 10_000), Some(3000));
        // Auch bei einem endlosen (Live-)Item unverändert — Start-relativ
        // braucht keine bekannte Dauer.
        assert_eq!(child_show_offset_ms(&start_child(3000), 0), Some(3000));
    }

    #[test]
    fn end_relative_offset_is_duration_minus_delay() {
        assert_eq!(child_show_offset_ms(&end_child(2000), 10_000), Some(8000));
    }

    #[test]
    fn end_relative_on_unlimited_item_is_none() {
        assert_eq!(child_show_offset_ms(&end_child(2000), 0), None);
    }

    #[test]
    fn end_relative_delay_longer_than_duration_is_none() {
        assert_eq!(child_show_offset_ms(&end_child(15_000), 10_000), None);
    }

    #[test]
    fn resolve_variables_replaces_next_title_in_string_values() {
        let data = serde_json::json!({"title": "Coming up: {{next:title}}", "subtitle": "static"});
        let resolved = resolve_variables(&data, Some("Weather"));
        assert_eq!(resolved["title"], "Coming up: Weather");
        assert_eq!(resolved["subtitle"], "static");
    }

    #[test]
    fn resolve_variables_without_a_next_item_substitutes_empty_string() {
        let data = serde_json::json!({"title": "{{next:title}}"});
        let resolved = resolve_variables(&data, None);
        assert_eq!(resolved["title"], "");
    }

    #[test]
    fn resolve_variables_recurses_into_nested_arrays_and_objects() {
        let data = serde_json::json!({"items": [{"label": "Next: {{next:title}}"}]});
        let resolved = resolve_variables(&data, Some("News"));
        assert_eq!(resolved["items"][0]["label"], "Next: News");
    }

    #[test]
    fn resolve_variables_leaves_non_matching_data_untouched() {
        let data = serde_json::json!({"count": 5, "flag": true, "title": "Fixed Title"});
        let resolved = resolve_variables(&data, Some("Ignored"));
        assert_eq!(resolved, data);
    }
}
