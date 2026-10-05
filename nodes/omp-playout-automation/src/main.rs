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

mod asrun;
mod children;
mod hooks;
mod persist;
mod playlist;
mod readiness;
mod remote;
mod schedule;
mod structlog;
mod timeline;
mod trigger;
mod uibundle;
mod voiceover;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omp_node_sdk::is04::RegistryClient;
use omp_node_sdk::{
    Descriptor, InvokeError, MethodArg, MethodSpec, NodeConfig, ParamSpec, ParamStore, ParamType,
    Range, SetError,
};
use children::{ChildEvent, ChildState, ChildType, FailAction};
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

/// Woher ein Rundown-/Cart-Item seine Essenz bezieht. Kapitel 6 Teil 7:
/// dieser Node entscheidet das jetzt selbst aus den Operator-Argumenten
/// (`item_media_from_args`), statt es aus einer Ziel-Player-Antwort zu
/// übernehmen (`omp-channel-player` hat kein eigenes Item-Modell mehr,
/// das eine solche Entscheidung träfe).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ItemMedia {
    TestPattern { pattern: String, tone_frequency: f64 },
    File { path: String },
    Live { sender_id: String },
    /// Live-Quelle per Auswahlkriterien statt fester Sender-ID (Kapitel 27 /
    /// P4c, Spec §14–17): erst beim Cue/Take gegen die aktuellen Quellen mit
    /// Tags aufgelöst (`omp-resolver`). Nur tatsächlich passende, erreichbare
    /// Quellen werden automatisch gewählt.
    LiveSelect { selector: Box<omp_resolver::Selector> },
    /// Standbild (Kapitel 27 / P2b) — `omp-channel-player` bekommt
    /// `mediaType=image` (ausdrücklich, nicht an der Dateiendung erkannt).
    Image { path: String },
    /// Steuer-Event (Kapitel 27 / P2b): wird nie auf einen Player geladen.
    /// `Hold`: hält die Sequenz an — das vorherige Bild bleibt auf Sendung, bis
    /// der Operator weiterschaltet (Dauer 0 = endlos, kein Auto-Advance).
    Hold,
    /// `Jump`: springt beim Erreichen zu `target_id` (Item-ID derselben Liste).
    Jump { target_id: String },
}

impl ItemMedia {
    /// Steuer-Events laden nichts auf einen Player.
    fn is_control(&self) -> bool {
        matches!(self, ItemMedia::Hold | ItemMedia::Jump { .. })
    }
}

/// Kapitel 6 Teil 1 (`docs/END-GOAL-FEATURES.md` §6.4/§6.2b): rein
/// automationsseitiges Konzept, das kein Ziel-Kanal kennt — s.
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
    /// Ausgehendes Bild blendet auf Schwarz, dann steht das neue hart da (Mixer-Art `fadecut`).
    FadeCut,
    /// Hart auf Schwarz, das neue Bild blendet auf (Mixer-Art `cutfade`).
    CutFade,
}

impl Transition {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "cut" => Some(Self::Cut),
            "mix" => Some(Self::Mix),
            "fadecut" | "fade-cut" => Some(Self::FadeCut),
            "cutfade" | "cut-fade" => Some(Self::CutFade),
            _ => None,
        }
    }
}

/// Kapitel 6 Teil 7 (`docs/END-GOAL-FEATURES.md` §6.5): welcher der
/// beiden `omp-channel-player`-Kanäle (Teil 6) gerade den Hauptkanal am
/// Mixer zeigt. Ersetzt das bisherige Einzelziel `target_player_label`/
/// `player_node_id` — ein A/B-Slot-Player kann `Transition::Mix` nicht
/// als echtes Xfade darstellen (Teil-6-Doku, "ehrliche v1-Grenze"), zwei
/// Isel-freie `omp-channel-player`-Instanzen können es, aber nur wenn
/// `take_on_targets` tatsächlich zwischen zwei VERSCHIEDENEN Mixer-
/// Sendern umschaltet statt wie bisher immer denselben erneut
/// auszuwählen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Channel {
    #[default]
    A,
    B,
}

impl Channel {
    /// Der jeweils andere Kanal — genau der ist beim nächsten `cue()`/
    /// `take()` der Standby-Kanal, auf den geladen wird, während der
    /// aktuell laufende Kanal ungestört auf Sendung bleibt (kein Glitch
    /// am Programmausgang durch einen `load()`-Aufruf auf dem gerade
    /// aktiven Kanal).
    fn other(self) -> Self {
        match self {
            Channel::A => Channel::B,
            Channel::B => Channel::A,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// Kapitel 27 / P2a: absoluter Startzeitpunkt in UTC-Millisekunden
    /// (`schedule::parse_start_at`, RFC 3339 mit Offset, E5) — bei
    /// `StartType::Fixtime` hat er Vorrang vor dem dateilosen
    /// `fixtime_hms` (Altbestand, §224), ist DST-sicher und kennt das
    /// Datum (keine Mitternachts-Grenze mehr).
    #[serde(default)]
    start_at_utc_ms: Option<i64>,
    /// Kapitel 6 Teil 4: wie DIESES Item auf Sendung genommen wird,
    /// s. `Transition`-Doku.
    transition: Transition,
    /// Nur bei `transition == Transition::Mix` ausgewertet — `None`
    /// heißt "die am Mixer aktuell gesetzte `crosspoint.transRate`
    /// unverändert lassen" (kein PATCH vor dem `autoTrans`), `Some(f)`
    /// setzt sie vorher explizit (`crosspoint.setTransRate`,
    /// 1..=250 Frames, Mixer-seitige Grenze).
    transition_rate_frames: Option<u32>,
    /// Child Events (Kapitel 6 Teil 5 Grafik, Kapitel 27 / P3 verallgemeinert), s. `children.rs`.
    children: Vec<ChildEvent>,
    /// Kapitel 27 / P5: Audio-Absicht dieses Events (ausdrückliche Capability,
    /// erwartete Tags, Fallback-Kette, Spec §104/§146/§263). `None` = keine —
    /// dann greifen Quell-Default bzw. die einzige Capability (§260).
    #[serde(default)]
    audio: Option<omp_resolver::audio::AudioIntent>,
    /// Kapitel 27 / P8: Asset-Referenz, Ausfallrichtlinie und Ersatzdatei (flach im JSON).
    #[serde(flatten)]
    media_ref: readiness::MediaRef,
}

/// Fachlicher Event-Typ eines Items (Spec §7). Leitet sich aus dem Medium
/// ab, ist aber ein eigenes Konzept: die Playlist beschreibt Intent, nicht
/// den Player. `BLACK` = Testmuster „black"; reine Testmuster heißen
/// `PATTERN`.
fn event_type(media: &ItemMedia) -> &'static str {
    match media {
        ItemMedia::File { .. } => "CLIP",
        ItemMedia::Live { .. } | ItemMedia::LiveSelect { .. } => "LIVE",
        ItemMedia::Image { .. } => "IMAGE",
        ItemMedia::Hold => "HOLD",
        ItemMedia::Jump { .. } => "JUMP",
        ItemMedia::TestPattern { pattern, .. } if pattern == "black" => "BLACK",
        ItemMedia::TestPattern { .. } => "PATTERN",
    }
}

/// Kapitel 27 / P10: kurze Quellbeschreibung fürs As-Run.
fn asrun_source(state: &AutomationState, m: &ItemMeta) -> String {
    match &m.media {
        ItemMedia::File { path } | ItemMedia::Image { path } => path.clone(),
        ItemMedia::Live { sender_id } => state.sources.iter().find(|s| &s.sender_id == sender_id).map(|s| format!("{} / {}", s.node_label, s.label)).unwrap_or_else(|| sender_id.clone()),
        ItemMedia::LiveSelect { selector } => omp_resolver::resolve(&effective_selector(selector), &state.sources)
            .selected_id
            .and_then(|id| state.sources.iter().find(|s| s.sender_id == id))
            .map(|s| format!("{} / {}", s.node_label, s.label))
            .unwrap_or_else(|| "keine passende Quelle".to_string()),
        ItemMedia::TestPattern { pattern, .. } => format!("Testmuster {pattern}"),
        ItemMedia::Hold => "HOLD".to_string(),
        ItemMedia::Jump { target_id } => format!("JUMP → {target_id}"),
    }
}

/// Das On-Air-Primary hat gewechselt (`schedule_children`-Aufrufer): As-Run nachführen.
/// `item_id` ist eine Playlist-Item-ID (Start), „stop“ (Schwarzbild) oder eine Cart-ID (Unterbrechung).
fn asrun_primary_changed(state: &mut AutomationState, item_id: &str) {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let Some(meta) = state.metadata.get(item_id).cloned() else {
        if item_id == "stop" {
            state.asrun.end(now_ms, "STOPPED", "Operator-Stopp (Schwarzbild)");
        } else {
            state.asrun.end(now_ms, "INTERRUPTED", &format!("Cart {item_id} unterbricht"));
        }
        return;
    };
    let info = asrun::StartInfo {
        event_id: item_id.to_string(),
        label: meta.label.clone(),
        asset: meta.media_ref.asset.as_ref().map(|a| a.asset_id.clone()).unwrap_or_default(),
        source: asrun_source(state, &meta),
        anchored_start_ms: if meta.start_type == StartType::Fixtime { meta.start_at_utc_ms } else { None },
        duration_ms: Some(meta.duration_ms).filter(|d| *d > 0 && !meta.media.is_control()),
        mode: match state.playlist.mode() {
            Mode::Auto => "auto",
            Mode::Hold => "hold",
        }
        .to_string(),
        ad_class: meta.media_ref.ad_class.clone(),
    };
    state.asrun.start(now_ms, info);
    // Audio-Absicht nicht auflösbar / mit Warnungen → protokollieren (Spec §192 audio_resolution_failures).
    if let Some(av) = audio_view(state, &meta)
        && let Some(w) = av["resolution"]["warnings"].as_array().filter(|w| !w.is_empty())
    {
        let text = w.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; ");
        state.asrun.warning(now_ms, "audio_resolution", item_id, &meta.label, &text);
    }
}

/// Ein Take wurde verweigert, weil die Quelle fehlt: als Warnung festhalten (Art nach Event-Typ).
fn asrun_take_refused(state: &mut AutomationState, item_id: &str, meta: &ItemMeta) {
    let action = if matches!(meta.media, ItemMedia::LiveSelect { .. }) {
        "source_resolution"
    } else if meta.media_ref.asset.is_some() {
        "asset_preflight"
    } else {
        "source_unavailable"
    };
    state.asrun.warning(chrono::Utc::now().timestamp_millis(), action, item_id, &meta.label, "Take verweigert: Quelle nicht verfügbar");
}

/// Kapitel 27 / P5: die Audio-Sicht eines Live-Items — welche Audio-Capabilities
/// bietet die (aufgelöste) Quelle an, und was ergibt die Audio-Absicht des Events?
/// `None` für Items ohne Live-Quelle oder wenn die Quelle (noch) nicht bekannt ist.
fn audio_view(state: &AutomationState, m: &ItemMeta) -> Option<Value> {
    let source = match &m.media {
        ItemMedia::Live { sender_id } => state.sources.iter().find(|s| &s.sender_id == sender_id),
        ItemMedia::LiveSelect { selector } => {
            omp_resolver::resolve(&effective_selector(selector), &state.sources).selected_id.and_then(|id| state.sources.iter().find(|s| s.sender_id == id))
        }
        _ => None,
    }?;
    let caps = omp_resolver::audio::audio_capabilities(&state.sources, &omp_resolver::SourceContext::of(source));
    let intent = m.audio.clone().unwrap_or_default();
    let resolution = omp_resolver::audio::resolve_audio_intent(&intent, &caps);
    Some(serde_json::json!({
        "source": format!("{} / {}", source.node_label, source.label),
        "capabilities": caps,
        "intent": intent,
        "resolution": resolution,
    }))
}

/// Kapitel 27 / P4c: Live-Items sind Video — ohne ausdrückliche Medienart im
/// Selektor wird `video` angenommen (sonst könnte ein reiner Tag-Selektor eine
/// Audio-Quelle als „Live-Bild“ wählen).
fn effective_selector(selector: &omp_resolver::Selector) -> omp_resolver::Selector {
    let mut s = selector.clone();
    if s.media_type.is_none() {
        s.media_type = Some(omp_resolver::MediaType::Video);
    }
    s
}

/// Löst einen Selektor gegen die gelieferten Quellen auf (rein, testbar).
/// Ergebnis: gewählte Sender-ID oder Fehlertext mit der Begründung.
fn resolve_live_selector(selector: &omp_resolver::Selector, sources: &[omp_resolver::Source]) -> Result<(String, omp_resolver::Resolution), String> {
    let resolution = omp_resolver::resolve(&effective_selector(selector), sources);
    match resolution.selected_id.clone() {
        Some(id) => Ok((id, resolution)),
        None => Err(format!("Live-Quelle nicht auflösbar — {}", resolution.summary)),
    }
}

/// Baut `ItemMedia` aus den vom Operator übergebenen Rohargumenten —
/// Precedence senderId > file > pattern, deckungsgleich mit der früher
/// vom Ziel-Player angewandten Reihenfolge (`omp-player/src/main.rs`s
/// ehemaliges `append`/`load`, jetzt hier entschieden statt dort: seit
/// Kapitel 6 Teil 7 hat `omp-channel-player` kein eigenes Item-Modell
/// mehr, das diese Entscheidung träfe). Geteilt zwischen `do_append`
/// und `do_load`.
fn item_media_from_args(
    pattern: Option<&str>,
    file: Option<&str>,
    sender_id: Option<&str>,
    tone_frequency: Option<f64>,
    event_type: Option<&str>,
    jump_target: Option<&str>,
    live_selector: Option<&omp_resolver::Selector>,
) -> ItemMedia {
    // Kapitel 27 / P2b: ausdrücklicher Event-Typ (Spec §10: keine Erkennung an
    // der Dateiendung) hat Vorrang vor der Quellen-Wahl unten.
    match event_type.map(str::to_ascii_lowercase).as_deref() {
        Some("hold") => return ItemMedia::Hold,
        Some("jump") => return ItemMedia::Jump { target_id: jump_target.unwrap_or_default().to_string() },
        Some("image") => {
            if let Some(file) = file.filter(|s| !s.is_empty()) {
                return ItemMedia::Image { path: file.to_string() };
            }
        }
        _ => {}
    }
    if let Some(sender_id) = sender_id.filter(|s| !s.is_empty()) {
        ItemMedia::Live { sender_id: sender_id.to_string() }
    } else if let Some(selector) = live_selector {
        ItemMedia::LiveSelect { selector: Box::new(selector.clone()) }
    } else if let Some(file) = file.filter(|s| !s.is_empty()) {
        ItemMedia::File { path: file.to_string() }
    } else {
        ItemMedia::TestPattern {
            pattern: pattern.filter(|s| !s.is_empty()).unwrap_or(DEFAULT_PATTERN).to_string(),
            tone_frequency: tone_frequency.unwrap_or(0.0),
        }
    }
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
fn item_is_available(m: &ItemMeta, media_library: &[String], available_sources: &[Value], sources: &[omp_resolver::Source]) -> bool {
    // Kapitel 27 / P8: Items mit Asset-Referenz regelt der Medien-Preflight (Bereitschaft + Ausfallrichtlinie
    // beim Take) — die Datei muss nicht schon im Medienverzeichnis liegen, sie wird bereitgestellt.
    if m.media_ref.asset.is_some() && matches!(m.media, ItemMedia::File { .. }) {
        return true;
    }
    match &m.media {
        // Kapitel 27 / P4c: verfügbar, wenn die Kriterien gerade eine Quelle ergeben.
        ItemMedia::LiveSelect { selector } => omp_resolver::resolve(&effective_selector(selector), sources).selected_id.is_some(),
        ItemMedia::TestPattern { .. } => true,
        ItemMedia::File { path } | ItemMedia::Image { path } => media_library.iter().any(|f| f == path),
        // Steuer-Events brauchen kein Medium.
        ItemMedia::Hold | ItemMedia::Jump { .. } => true,
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

/// Kapitel 27 / P2a: liegt die Startzeit eines Fixtime-Items noch in der
/// Zukunft? Absolute UTC-Zeit hat Vorrang vor dem dateilosen HH:MM:SS-
/// Altbestand (der gegen die lokale Wanduhr verglichen wird). Reine Funktion.
fn fixtime_is_in_future(m: &ItemMeta, now_utc_secs: i64, now_local_secs: i64) -> bool {
    if m.start_type != StartType::Fixtime {
        return false;
    }
    if let Some(ms) = m.start_at_utc_ms {
        return ms.div_euclid(1000) > now_utc_secs;
    }
    m.fixtime_hms.as_deref().and_then(parse_hms_to_secs).map(|t| t > now_local_secs).unwrap_or(false)
}

/// Serialisiert ein `ItemMeta` für `get("items")`/`get("assets")` —
/// dieselbe Feld-Shape, die `omp-channel-player::invoke("load")`
/// erwartet (jeweils genau eines von `pattern`+`toneFrequency` / `file`
/// / `senderId`, s. `load_args`).
fn item_meta_to_json(id: &str, m: &ItemMeta) -> Value {
    let mut v = match &m.media {
        ItemMedia::TestPattern { pattern, tone_frequency } => serde_json::json!({
            "pattern": pattern,
            "toneFrequency": tone_frequency,
        }),
        ItemMedia::File { path } => serde_json::json!({ "file": path }),
        ItemMedia::Live { sender_id } => serde_json::json!({ "senderId": sender_id }),
        ItemMedia::Image { path } => serde_json::json!({ "file": path, "mediaType": "image" }),
        ItemMedia::Hold => serde_json::json!({}),
        ItemMedia::Jump { target_id } => serde_json::json!({ "jumpTarget": target_id }),
        ItemMedia::LiveSelect { selector } => serde_json::json!({ "sourceSelector": selector }),
    };
    v["id"] = serde_json::json!(id);
    v["label"] = serde_json::json!(m.label);
    v["durationMs"] = serde_json::json!(m.duration_ms);
    v["startType"] = serde_json::json!(m.start_type);
    if let Some(hms) = &m.fixtime_hms {
        v["fixtimeHms"] = serde_json::json!(hms);
    }
    if let Some(ms) = m.start_at_utc_ms {
        v["startAt"] = serde_json::json!(schedule::format_start_at(ms));
    }
    v["eventType"] = serde_json::json!(event_type(&m.media));
    v["transition"] = serde_json::json!(m.transition);
    if let Some(frames) = m.transition_rate_frames {
        v["transitionRateFrames"] = serde_json::json!(frames);
    }
    if !m.children.is_empty() {
        v["children"] = serde_json::json!(m.children);
    }
    if let Some(a) = &m.media_ref.asset {
        v["asset"] = serde_json::json!(a);
        v["onMissing"] = serde_json::json!(m.media_ref.on_missing);
    }
    if let Some(f) = &m.media_ref.fallback_file {
        v["fallbackFile"] = serde_json::json!(f);
    }
    for (k, val) in [("icon", &m.media_ref.icon), ("color", &m.media_ref.color), ("note", &m.media_ref.note), ("adClass", &m.media_ref.ad_class), ("audioMapping", &m.media_ref.audio_mapping)] {
        if !val.is_empty() {
            v[k] = serde_json::json!(val);
        }
    }
    v
}

/// Bereitschaft eines Items (Preflight-Ergebnis, Spec §184).
#[derive(Debug, Clone, Default)]
struct ReadinessEntry {
    /// Verfügbarkeitszustand des Orchestrators (READY/REMOTE_ONLY/TRANSFERRING/FAILED/MISSING).
    state: String,
    detail: String,
    progress: f64,
    estimate_s: f64,
    checked_ms: i64,
    /// Schon gewarnt, dass die Bereitstellung nicht mehr rechtzeitig fertig wird.
    warned_late: bool,
    /// Bereitstellung wurde angestoßen.
    materializing: bool,
}

struct AutomationState {
    playlist: Playlist,
    metadata: HashMap<String, ItemMeta>,
    /// Kapitel 6 Teil 7: lokal vergebene IDs für Rundown-Items (`format!
    /// ("item{}", seq)`, gleiches Muster wie `next_cart_seq`/`"cart{}"`)
    /// — ersetzt die bisher vom Ziel-Player bei `append()`/`load()`
    /// vergebenen IDs (`omp-channel-player` hat kein Mehr-Item-Modell
    /// mehr, das eigene IDs vergeben könnte, s. Moduldoku).
    next_item_seq: u64,
    onair_since: Option<Instant>,
    target_player_a_label: String,
    target_player_b_label: String,
    target_mixer_label: String,
    /// NMOS-IS-04-Node-IDs der beiden `omp-channel-player`-Ziele (nicht
    /// der `href` wie vor C16) — s. `remote::resolve_node_id_by_label`-
    /// Doku. Kapitel 6 Teil 7 ersetzt das bisherige EINE `player_node_id`
    /// durch ein Paar: `take_on_targets` lädt immer auf den gerade NICHT
    /// live geschalteten Kanal (`live_channel`s Gegenstück), damit ein
    /// `Transition::Mix` zwischen zwei tatsächlich verschiedenen Mixer-
    /// Sendern überblendet statt denselben Sender erneut zu wählen.
    player_a_node_id: Option<String>,
    player_b_node_id: Option<String>,
    mixer_node_id: Option<String>,
    /// Welcher der beiden Kanäle gerade den Hauptkanal am Mixer zeigt —
    /// s. `Channel`-Doku. Wird NUR nach einem erfolgreichen
    /// `take_on_targets`-Aufruf umgeschaltet (remote zuerst, dann lokal
    /// committen, gleiches Prinzip wie zuvor bei `last_live_item_id`).
    live_channel: Channel,
    /// Alle aktuell bekannten Node-Labels außer dem eigenen (`remote::
    /// list_node_labels`) — Grundlage für `availableNodes`, das
    /// `targetPlayerALabel`/`targetPlayerBLabel`/`targetMixerLabel` im
    /// UI-Bundle von Freitext-Feldern auf eine Auswahl umstellt
    /// (Nutzerwunsch 2026-07-22: "wie beim Video-Mixer DSK"). Im selben
    /// `discovery_loop`-Tick wie `player_a_node_id`/`player_b_node_id`/
    /// `mixer_node_id` aktualisiert.
    discovered_labels: Vec<String>,
    /// Rundown-Echtmedien (`ARCHITECTURE.md` §24.6-Folgeschritt): Spiegel
    /// von `omp-channel-player`s `mediaLibrary`/`availableSources`-
    /// Parametern — Kapitel 7: absichtlich nur von Kanal A gelesen (beide
    /// Kanal-Player-Instanzen eines Workflows zeigen laut Katalog-
    /// Konvention denselben `OMP_MEDIA_DIR`, ein zweiter, redundanter
    /// Poll von Kanal B brächte hier keinen Erkenntnisgewinn). Leert
    /// sich, sobald `player_a_node_id` `None` wird (Ziel nicht
    /// aufgelöst/offline) — sonst böte das UI Quellen eines gar nicht
    /// mehr angesprochenen Kanals an.
    media_library: Vec<String>,
    available_sources: Vec<Value>,
    /// Kapitel 27 / A4: Audio-Spiegel der Kanal-Player (Discovery-Tick): zuletzt
    /// aufgelöster Plan je Kanal (`audioPlan`), Zielgruppen und wählbare Vorlagen.
    audio_plan_a: Value,
    audio_plan_b: Value,
    audio_groups: Value,
    audio_mappings: Value,
    /// Item-ID, die zuletzt tatsächlich per `take_on_targets` remote live
    /// geschaltet wurde (C18-Fund, `ARCHITECTURE.md` §24.3) — bewusst
    /// **nicht** aus `playlist.on_air()` abgeleitet: erreicht `advance()`
    /// das Listenende, setzt es lokal `on_air=false`, OHNE einen Kanal/
    /// den Mixer anzufassen. Ein Cart-Fire, das sich in diesem Zustand auf
    /// `playlist.on_air()` verlassen hätte, nähme fälschlich den
    /// "nur cuen, nicht nehmen"-Rückweg und der Cart-Clip bliebe nach dem
    /// Return dauerhaft live hängen (live reproduziert, s.
    /// docs/decisions.md Nachtrag zu C18). Dieses Feld ist die einzige
    /// Quelle der Wahrheit für "was zeigt der Mixer über den Hauptkanal
    /// gerade wirklich" — gesetzt von `do_take`/`do_advance` direkt nach
    /// einem erfolgreichen `take_on_targets`, von `do_load` beim
    /// Playlist-Ersatz zurückgesetzt (die alte Item-ID existiert danach
    /// evtl. gar nicht mehr in `state.metadata`).
    last_live_item_id: Option<String>,
    /// C18 (`ARCHITECTURE.md` §24.3): definierte Cart-/Interrupt-Assets,
    /// insertion-geordnet (`Vec` statt `HashMap`, damit `assets` stabil
    /// in Anlage-Reihenfolge angezeigt wird — bei der erwarteten kleinen
    /// Cart-Anzahl ist die O(n)-Suche unproblematisch, gleiche Abwägung
    /// wie beim Rest dieses Nodes).
    carts: Vec<(String, ItemMeta)>,
    next_cart_seq: u64,
    active_cart: Option<ActiveCart>,
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
    /// Kapitel 27 / P8: zuletzt ermittelte Medien-Bereitschaft je Item (Preflight-Schleife).
    readiness: HashMap<String, ReadinessEntry>,
    /// Preflight-Fenster in Minuten (Spec §72): davor wird nichts bewegt.
    preflight_window_min: u32,
    /// Standard-Filler des Channels (Dateiname im Medienverzeichnis), Richtlinie DEFAULT_FILLER.
    default_filler: String,
    /// Kapitel 6 Teil 5 (`graphics_loop`-Doku): Ziel-`omp-ograf` für
    /// Grafik-Kind-Ereignisse — dasselbe dynamische Label-Muster wie
    /// `target_player_label`/`target_mixer_label`, aber bewusst
    /// OPTIONAL: ein Rundown ohne Grafik-Kinder braucht keinen
    /// Grafik-Node, ein `do_take` scheitert deshalb NICHT, nur weil
    /// `graphics_node_id` unaufgelöst ist (anders als beim
    /// Player/Mixer) — erst `schedule_children` selbst meldet einen
    /// Fehler, und auch dann nur, wenn das Item tatsächlich Kinder hat.
    target_graphics_label: String,
    /// Kapitel 27 / P6 (optional): Ziel-`omp-audio-mixer`, dem beim Take der Quell-Kontext
    /// (`setSourceContext`) gemeldet wird. Leer = kein semantisches Audio-Routing.
    target_audio_mixer_label: String,
    audio_mixer_node_id: Option<String>,
    graphics_node_id: Option<String>,
    /// Erhöht sich bei JEDER On-Air-Änderung (alle 8 `take_on_targets`-
    /// Aufrufstellen, auch die drei "immer harter Cut"-Ausnahmen) — ein
    /// `ScheduledGraphicsEvent` mit einer älteren Epoche gilt als
    /// storniert, ohne dass `child_schedule` aktiv durchsucht/
    /// bereinigt werden muss (verhindert, dass ein End-relatives Kind
    /// des VORHERIGEN On-Air-Items verspätet auf dem NEUEN Item auftaucht).
    child_epoch: u64,
    child_schedule: Vec<ScheduledChild>,
    /// Kapitel 27 / P3: Lebenszyklus der Kinder (aktuelles + gerade abgelöstes Primary).
    child_runtime: Vec<ChildRuntime>,
    /// Kapitel 27 / P10: As-Run-Protokoll (Primary/Child/Warnungen/Trigger), geliefert an den Orchestrator.
    asrun: asrun::AsRunTracker,
    /// Kapitel 27 / P4c: zuletzt gelesene Quellen mit Tags (Orchestrator,
    /// `discovery_loop`) — Grundlage der Anzeige „aufgelöst zu …“ und der
    /// Verfügbarkeit von `LiveSelect`-Items. Das echte Auflösen beim Cue/Take
    /// holt die Quellen frisch.
    sources: Vec<omp_resolver::Source>,
    /// On-Air-Beginn des aktuellen Primary in UTC-ms (für ABSOLUTE-Kinder und
    /// den Journal-Schlüssel, der Neustarts überlebt).
    onair_utc_ms: i64,
}

impl AutomationState {
    /// Leerer Ausgangszustand eines frisch gestarteten Nodes — geteilt
    /// zwischen `main()` und den `persist`-Tests.
    fn new(player_a_label: String, player_b_label: String, mixer_label: String, graphics_label: String) -> Self {
        AutomationState {
            playlist: Playlist::new(),
            metadata: HashMap::new(),
            next_item_seq: 0,
            onair_since: None,
            target_player_a_label: player_a_label,
            target_player_b_label: player_b_label,
            target_mixer_label: mixer_label,
            player_a_node_id: None,
            player_b_node_id: None,
            mixer_node_id: None,
            live_channel: Channel::default(),
            discovered_labels: Vec::new(),
            media_library: Vec::new(),
            available_sources: Vec::new(),
            audio_plan_a: Value::Null,
            audio_plan_b: Value::Null,
            audio_groups: Value::Array(vec![]),
            audio_mappings: Value::Array(vec![]),
            last_live_item_id: None,
            carts: Vec::new(),
            next_cart_seq: 0,
            active_cart: None,
            timeline: TimelineCache::new(),
            fixtime_resolved: HashMap::new(),
            readiness: HashMap::new(),
            preflight_window_min: 15,
            default_filler: String::new(),
            target_graphics_label: graphics_label,
            target_audio_mixer_label: String::new(),
            audio_mixer_node_id: None,
            graphics_node_id: None,
            child_epoch: 0,
            child_schedule: Vec::new(),
            child_runtime: Vec::new(),
            asrun: Default::default(),
            sources: Vec::new(),
            onair_utc_ms: 0,
        }
    }
}

/// s. `AutomationState::fixtime_resolved`-Doku.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FixtimeResolution {
    PreCued,
    Fired,
    Skipped,
}

/// Kapitel 27 / P3: was der zentrale Child-Scheduler zu einem Kind tut.
#[derive(Debug, Clone, PartialEq)]
enum ChildAction {
    /// `attempt` 0 = erster Versuch; `use_fallback`: `fallbackTarget` statt `target`.
    Start { attempt: u32, use_fallback: bool },
    Stop,
}

/// Ein fälliger/ausstehender Child-Befehl. `Start`-Einträge werden bei jedem
/// Primary-Wechsel verworfen, `Stop`-Einträge NIE (ein gestartetes Kind muss
/// auch nach einem Primary-Wechsel wieder gestoppt werden).
#[derive(Debug, Clone)]
struct ScheduledChild {
    fire_at: Instant,
    item_id: String,
    child_id: String,
    action: ChildAction,
}

/// Laufzeit-Zustand eines Kindes des aktuellen (bzw. gerade abgelösten)
/// Primary — Grundlage für Lebenszyklus-Anzeige (`childEvents`) und Restart.
#[derive(Debug, Clone)]
struct ChildRuntime {
    item_id: String,
    /// Mit bereits aufgelösten Variablen (`{{next:title}}`).
    child: ChildEvent,
    state: ChildState,
    start_offset_ms: u64,
    stop_offset_ms: Option<u64>,
    until_primary_end: bool,
    attempt: u32,
    error: Option<String>,
    /// Der erfolgreiche Start lief über `fallbackTarget` — der Stopp muss
    /// denselben Node treffen, nicht das (nicht erreichbare) Haupt-Ziel.
    used_fallback: bool,
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
    /// Kapitel 27 / P6: Ergebnis des letzten Audio-Kontext-Aufrufs (Anzeige; eigener
    /// Mutex, weil `take_on_targets` unter dem State-Lock läuft).
    audio_status: Mutex<String>,
    /// Kapitel 27 / P7: die letzten ein-/ausgehenden Channel-Trigger (Anzeige im Panel).
    trigger_log: Mutex<std::collections::VecDeque<Value>>,
    /// Kapitel 27 / P8: von der Ausfallrichtlinie STOP angefordert — die Auto-Advance-Schleife stellt auf Hold.
    request_hold: std::sync::atomic::AtomicBool,
    /// Drosselung gleicher Meldungen (Take im Auto-Advance-Takt würde sonst jede Viertelsekunde alarmieren).
    report_throttle: Mutex<HashMap<String, Instant>>,
    /// Serialisiert die Ausführung eingehender Trigger (Reihenfolge der Zustellung, Policy QUEUE).
    trigger_gate: tokio::sync::Mutex<()>,
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
    /// Kapitel 27 / P1a+P1b: Anbindung an die Orchestrator-Domäne
    /// `playout` (Snapshot, Restart-Rekonstruktion, Ausführungsjournal),
    /// s. `persist.rs`.
    persistence: persist::Persistence,
    /// Kapitel 27 / P9: laufende Voiceovers (`Label:Kanal`, Priorität).
    voiceovers_active: Mutex<Vec<(String, i64)>>,
    /// Kapitel 27 / P9.2: laufende SCTE-35-Events (`Label:Kind-ID` → Event-ID), damit der Stopp dieselbe ID trägt.
    scte35_events: Mutex<HashMap<String, u32>>,
    /// Kapitel 27 / P9.3: Plugin-Host des Node-SDK (Plugin `event-hooks`, s. `hooks.rs`).
    plugins: Arc<omp_node_sdk::PluginRegistry>,
}

impl AutomationStore {
    /// Baut einen `ProxyClient` für eine gegebene Ziel-Node-ID —
    /// gemeinsamer Kern für Player- und Mixer-Zugriffe (beide sprechen
    /// denselben Orchestrator-Proxy an, nur unter unterschiedlicher ID).
    /// Kapitel 27 / P7: Trigger über den Orchestrator senden (blockierend). Der Orchestrator prüft die
    /// Regeln „wer darf wen steuern“ und protokolliert; ein verweigerter Trigger wird als Fehler gemeldet.
    fn send_channel_trigger(
        &self,
        event: &str,
        target: Value,
        args: Value,
        target_time: &str,
        relative_offset_ms: i64,
        late_policy: &str,
    ) -> Result<Value, String> {
        let channel_id = self.persistence.channel_id();
        if channel_id.is_empty() {
            return Err("dieser Node ist (noch) keinem Channel zugeordnet — Trigger können nur Channels senden".to_string());
        }
        if event.trim().is_empty() {
            return Err("event fehlt (z. B. NEXT_LIVE)".to_string());
        }
        let mut body = serde_json::json!({
            "event": event.trim(),
            "target": target,
            "args": args,
            "relativeOffsetMs": relative_offset_ms,
            "latePolicy": late_policy.trim(),
        });
        if !target_time.trim().is_empty() {
            body["targetTime"] = Value::String(target_time.trim().to_string());
        }
        let result = remote::post_json(&self.orchestrator_url, &self.auth, &format!("/api/v1/playout/channels/{channel_id}/triggers"), &body);
        let entry = |status: &str, detail: String| {
            serde_json::json!({
                "at": chrono::Utc::now().timestamp_millis(), "direction": "out", "event": event.trim(),
                "target": body["target"], "status": status, "detail": detail,
            })
        };
        match &result {
            Ok(v) => {
                let n = v.get("deliveries").and_then(Value::as_array).map_or(0, Vec::len);
                self.log_trigger(entry("sent", format!("{n} Zustellung(en)")));
            }
            Err(e) => self.log_trigger(entry("denied", e.clone())),
        }
        result
    }

    fn log_trigger(&self, entry: Value) {
        {
            let text = |k: &str| entry.get(k).map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default();
            let dir = text("direction");
            let id = {
                let i = text("id");
                if i.is_empty() { format!("{}-{}", text("event"), chrono::Utc::now().timestamp_millis()) } else { i }
            };
            let mut st = self.state.lock().expect("lock poisoned");
            st.asrun.trigger(chrono::Utc::now().timestamp_millis(), &id, &text("correlationId"), &dir, &text("event"), &text("status"), &text("detail"));
        }
        let mut log = self.trigger_log.lock().expect("lock poisoned");
        log.push_front(entry);
        log.truncate(30);
    }

    /// Wendet ein eingehendes Trigger-Event an (blockierend). Rückgabe: Detailtext für die Quittung.
    fn apply_trigger_event(&self, env: &trigger::Envelope) -> Result<String, String> {
        use trigger::Event;
        match Event::parse(&env.event) {
            Some(Event::Next) => self.do_next().map(|_| "weitergeschaltet".to_string()),
            Some(Event::NextLive) => self.do_next_live().map(|_| "nächstes Live-Item genommen".to_string()),
            Some(Event::Cut) => self.do_take().map(|_| "gecuetes Item genommen".to_string()),
            Some(Event::Jump) => {
                let item = trigger::jump_item(&env.args).ok_or("args.itemId fehlt")?.to_string();
                self.do_cue(&item)?;
                self.do_take().map(|_| format!("auf „{item}\u{201c} gesprungen"))
            }
            Some(Event::Hold) => {
                self.state.lock().expect("lock poisoned").playlist.set_mode(Mode::Hold);
                Ok("Hold".to_string())
            }
            Some(Event::Resume) => {
                self.state.lock().expect("lock poisoned").playlist.set_mode(Mode::Auto);
                Ok("Auto".to_string())
            }
            Some(Event::Custom) => Err("benannte Trigger (CHANNEL_TRIGGER) haben noch keinen Handler im Automator".to_string()),
            None => Err(format!("unbekanntes Event „{}\u{201c}", env.event)),
        }
    }

    fn audio_status_hint(&self, status: String) {
        *self.audio_status.lock().expect("lock poisoned") = status;
    }

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
        retire_children(state);
        state.child_epoch += 1;
        state.onair_utc_ms = chrono::Utc::now().timestamp_millis() - onair_since.elapsed().as_millis() as i64;
        asrun_primary_changed(state, item_id);
        for notice in plan_children(state, item_id, onair_since, None) {
            self.report(notice);
        }
    }

    /// Gemeinsame Logik für `invoke("take")` und den Auto-Advance-Timer:
    /// lädt das gecuede Item auf den Standby-Kanal und schneidet den
    /// Ziel-Mixer per Crosspoint darauf (`take_on_targets`) — bewusst
    /// "remote zuerst, danach lokal committen": schlägt einer der
    /// Fernaufrufe fehl, bleibt der lokale Zustand unverändert (kein
    /// Vorgriff auf einen Zustand, der remote nicht bestätigt ist).
    fn do_take(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let index = state
            .playlist
            .current_index()
            .ok_or("nichts gecued".to_string())?;
        let item_id = state.playlist.items()[index].clone();
        // JUMP: erst auf das Ziel umcuen (Take unten nimmt dann das Ziel).
        let item_id = resolve_jump(&mut state, item_id, false)?;

        // Kapitel 6 Teil 7: OHNE eigene ItemMeta kann `take_on_targets`
        // gar nicht mehr `load()` aufrufen (anders als im alten
        // Player-Modell, wo das Item beim Player bereits vollständig
        // existierte) — ein fehlender Eintrag ist damit ein echter
        // Fehler, kein optionaler Verfügbarkeits-Check mehr wie zuvor.
        let meta = state
            .metadata
            .get(&item_id)
            .cloned()
            .ok_or("Item-Metadaten fehlen (Rundown-Eintrag inkonsistent)".to_string())?;

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
        if !item_is_available(&meta, &state.media_library, &state.available_sources, &state.sources) {
            asrun_take_refused(&mut state, &item_id, &meta);
            return Err(format!(
                "„{}\u{201c} nicht verfügbar (Datei fehlt oder Live-Quelle offline) — Take verweigert",
                meta.label
            ));
        }

        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst (targetMixerLabel unbekannt/noch nicht gestartet)")?;
        let (transition, rate_frames) = item_transition(&state, &item_id);

        let new_channel = take_on_targets(self, &state, &mixer_node_id, &meta, transition, rate_frames)?;
        state.live_channel = new_channel;

        state.playlist.take().map_err(|e| e.to_string())?;
        let onair_since = Instant::now();
        state.onair_since = Some(onair_since);
        state.asrun.cause = "take";
        self.schedule_children(&mut state, &item_id, onair_since);
        if !meta.media.is_control() {
            state.last_live_item_id = Some(item_id);
        }
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
            // Kapitel 27 / P2a: ein Fixtime-Item, dessen Startzeit noch in der
            // Zukunft liegt, wird NICHT vorzeitig genommen — es wird nur
            // gecued, der `fixtime_loop` feuert es zur Zeit (vorher nahm
            // Auto-Advance es sofort, mit absoluten Zeiten wäre das ein
            // Sendefehler, den der Plan als „Lücke“ ausweist).
            let waits_for_clock = state
                .metadata
                .get(&next_id)
                .map(|m| fixtime_is_in_future(m, chrono::Utc::now().timestamp(), seconds_since_midnight_local()))
                .unwrap_or(false);
            if is_manual || waits_for_clock {
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
            state.asrun.end(chrono::Utc::now().timestamp_millis(), "COMPLETED", "Playlist-Ende");
            // last_live_item_id bleibt bewusst unangetastet: der Player
            // zeigt das letzte Item remote unverändert weiter (kein
            // EOS-Konzept) — nur die lokale Sequenzierung endet hier, s.
            // `last_live_item_id`-Doku.
            return Ok(());
        };
        let item_id = resolve_jump(&mut state, item_id, true)?;

        let meta = state
            .metadata
            .get(&item_id)
            .cloned()
            .ok_or("Item-Metadaten fehlen (Rundown-Eintrag inkonsistent)".to_string())?;
        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst")?;
        let (transition, rate_frames) = item_transition(&state, &item_id);

        let new_channel = take_on_targets(self, &state, &mixer_node_id, &meta, transition, rate_frames)?;
        state.live_channel = new_channel;
        let onair_since = Instant::now();
        state.onair_since = Some(onair_since);
        state.asrun.cause = "auto";
        self.schedule_children(&mut state, &item_id, onair_since);
        // Ein per Sequenz (zu spät/gerade rechtzeitig) genommenes Fixtime-
        // Item gilt als erledigt — sonst meldete der `fixtime_loop`
        // fälschlich „verpasst“ für ein Item, das längst läuft.
        if meta.start_type == StartType::Fixtime {
            state.fixtime_resolved.insert(item_id.clone(), FixtimeResolution::Fired);
        }
        if !meta.media.is_control() {
            state.last_live_item_id = Some(item_id);
        }
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
        // Ein Fixtime-JUMP springt zum Ziel (und nimmt DAS auf Sendung).
        let resolved = resolve_jump(&mut state, item_id.to_string(), false)?;
        let item_id = resolved.as_str();
        let index = state
            .playlist
            .index_of(item_id)
            .ok_or("Fixtime-Item nicht mehr im Rundown".to_string())?;

        let meta = state
            .metadata
            .get(item_id)
            .cloned()
            .ok_or("Item-Metadaten fehlen (Rundown-Eintrag inkonsistent)".to_string())?;
        if !item_is_available(&meta, &state.media_library, &state.available_sources, &state.sources) {
            asrun_take_refused(&mut state, item_id, &meta);
            return Err(format!(
                "„{}\u{201c} nicht verfügbar (Datei fehlt oder Live-Quelle offline)",
                meta.label
            ));
        }

        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst (targetMixerLabel unbekannt/noch nicht gestartet)")?;
        let (transition, rate_frames) = item_transition(&state, item_id);

        let new_channel = take_on_targets(self, &state, &mixer_node_id, &meta, transition, rate_frames)?;
        state.live_channel = new_channel;

        state.playlist.cue(index).map_err(|e| e.to_string())?;
        state.playlist.take().map_err(|e| e.to_string())?;
        let onair_since = Instant::now();
        state.onair_since = Some(onair_since);
        state.asrun.cause = "fixtime";
        self.schedule_children(&mut state, item_id, onair_since);
        if !meta.media.is_control() {
            state.last_live_item_id = Some(item_id.to_string());
        }
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
        let item_id = resolve_jump(&mut state, item_id, true)?;

        let meta = state
            .metadata
            .get(&item_id)
            .cloned()
            .ok_or("Item-Metadaten fehlen (Rundown-Eintrag inkonsistent)".to_string())?;
        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst")?;
        let (transition, rate_frames) = item_transition(&state, &item_id);

        let new_channel = take_on_targets(self, &state, &mixer_node_id, &meta, transition, rate_frames)?;
        state.live_channel = new_channel;
        let onair_since = Instant::now();
        state.onair_since = Some(onair_since);
        state.asrun.cause = "next";
        self.schedule_children(&mut state, &item_id, onair_since);
        if !meta.media.is_control() {
            state.last_live_item_id = Some(item_id);
        }
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

        let meta = state
            .metadata
            .get(&item_id)
            .cloned()
            .ok_or("Item-Metadaten fehlen (Rundown-Eintrag inkonsistent)".to_string())?;
        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst (targetMixerLabel unbekannt/noch nicht gestartet)")?;
        let (transition, rate_frames) = item_transition(&state, &item_id);

        let new_channel = take_on_targets(self, &state, &mixer_node_id, &meta, transition, rate_frames)?;
        state.live_channel = new_channel;

        state.playlist.cue(target_index).map_err(|e| e.to_string())?;
        state.playlist.take().map_err(|e| e.to_string())?;
        let onair_since = Instant::now();
        state.onair_since = Some(onair_since);
        state.asrun.cause = "next_live";
        self.schedule_children(&mut state, &item_id, onair_since);
        if !meta.media.is_control() {
            state.last_live_item_id = Some(item_id);
        }
        Ok(())
    }

    /// Listenansicht-Folgeschritt, "Stop"-Bedienknopf (PIPELINE-CONTROLLER-
    /// Parität, `ui.html::stopPlaylist()`): schaltet den Hauptkanal sofort
    /// auf ein synthetisches Schwarzbild — non-destruktiv wie im
    /// PC-Original ("Stop beendet nur die Wiedergabe, die Liste bleibt
    /// erhalten"), deshalb bewusst kein `state.playlist.replace_all(..)`
    /// oder Ähnliches. Kapitel 6 Teil 7 vereinfacht diesen Mechanismus
    /// gegenüber dem alten Player-Modell erheblich: ein synthetisches
    /// `ItemMeta` geht direkt in `take_on_targets`, keine append/remove-
    /// Buchhaltung mehr nötig (`omp-channel-player::load()` ersetzt den
    /// eigenen Inhalt einfach beim nächsten Take, es gibt keine Player-
    /// seitige Liste mehr, die Schwarzbild-Leichen ansammeln könnte). Ein
    /// aktiver Cart hat Vorrang — Stop beträfe sonst den falschen
    /// Kanal-Zustand.
    fn do_stop(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        if state.active_cart.is_some() {
            return Err("Cart aktiv — zuerst cart.return() aufrufen".to_string());
        }
        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst (targetMixerLabel unbekannt/noch nicht gestartet)")?;
        let black = ItemMeta {
            label: "STOP".to_string(),
            media: ItemMedia::TestPattern { pattern: "black".to_string(), tone_frequency: 0.0 },
            duration_ms: 0,
            start_type: StartType::default(),
            fixtime_hms: None,
            start_at_utc_ms: None,
            transition: Transition::default(),
            transition_rate_frames: None,
            children: Vec::new(),
            audio: None,
            media_ref: Default::default(),
        };

        // Kapitel 6 Teil 4: Schwarzbild-Stop bleibt immer ein sofortiger
        // Cut — ein Operator, der auf "Stop" drückt, erwartet sofortige
        // Wirkung, keine Ramp-Down-Rampe.
        let new_channel = take_on_targets(self, &state, &mixer_node_id, &black, Transition::Cut, None)?;
        state.live_channel = new_channel;
        // Kapitel 6 Teil 5: das synthetische Schwarzbild-Item hat nie
        // Kinder — dieser Aufruf storniert nur (Epochen-Sprung) noch
        // ausstehende Grafik-Ereignisse des VORHERIGEN On-Air-Items,
        // s. `schedule_children`-Doku.
        self.schedule_children(&mut state, "stop", Instant::now());

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

    /// Rundown-Echtmedien-Folgeschritt: baut das `ItemMeta` seit Kapitel
    /// 6 Teil 7 direkt aus den übergebenen Rohargumenten statt es aus
    /// der Antwort eines Ziel-Players zu rekonstruieren —
    /// `omp-channel-player` hat kein eigenes Mehr-Item-Modell mehr, das
    /// eine Item-ID vergeben oder eine Datei vorab (ohne sie auf einen
    /// Kanal zu laden) probieren könnte. **Ehrliche v1-Grenze:**
    /// `duration_ms` kommt jetzt vom Operator (`DEFAULT_DURATION_MS`,
    /// falls leer) statt automatisch per `ffprobe` ermittelt zu werden —
    /// vormals probte der Ziel-Player die reale Clip-Länge selbst. Ein
    /// künftiger Ausbau könnte das über `omp-media-library`s bereits
    /// ffprobe'ten Dateikatalog nachrüsten (`docs/END-GOAL-FEATURES.md`
    /// §6.5 Teil 7 nennt das als "Kandidat"), bewusst nicht Teil dieser
    /// Runde — der Datei-Decode-Pfad selbst probt weiterhin die echte
    /// Länge beim tatsächlichen `load()` auf einen Kanal, nur eben nicht
    /// mehr VORAB beim bloßen Anlegen des Rundown-Eintrags.
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
        event_type: Option<String>,
        jump_target: Option<String>,
        live_selector: Option<omp_resolver::Selector>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        state.next_item_seq += 1;
        let id = format!("item{}", state.next_item_seq);
        let media = item_media_from_args(
            pattern.as_deref(),
            file.as_deref(),
            sender_id.as_deref(),
            tone_frequency,
            event_type.as_deref(),
            jump_target.as_deref(),
            live_selector.as_ref(),
        );
        if let ItemMedia::Jump { target_id } = &media
            && state.playlist.index_of(target_id).is_none()
        {
            state.next_item_seq -= 1;
            return Err(format!("jumpTarget „{target_id}\u{201c} ist kein Item dieser Liste"));
        }
        // Steuer-Events haben keine eigene Dauer (Hold = endlos, Jump = sofort).
        let duration_ms = if media.is_control() { Some(0) } else { duration_ms };
        let meta = ItemMeta {
            label,
            media,
            duration_ms: duration_ms.unwrap_or(DEFAULT_DURATION_MS),
            start_type: start_type.unwrap_or_default(),
            fixtime_hms: None,
            start_at_utc_ms: None,
            transition: Transition::default(),
            transition_rate_frames: None,
            children: Vec::new(),
            audio: None,
            media_ref: Default::default(),
        };
        state.playlist.append(id.clone());
        state.metadata.insert(id, meta);
        // C20: kein state.timeline.invalidate_from() nötig — append()
        // hängt immer ans Ende (Playlist::append-Doku), der Zeitplan-
        // Cache bleibt für alle bestehenden Indizes gültig.
        Ok(())
    }

    /// Ersetzt den kompletten Rundown (Reorder aus dem UI, `ui/
    /// bundle.js::reorderItems`, oder ein bewusstes Neuladen). Kapitel 6
    /// Teil 7: rein lokal — anders als vor der Umstellung auf
    /// `omp-channel-player` gibt es keinen Ziel-Player mehr, dessen
    /// `load()` die maßgebliche neue Item-Liste (inkl. frisch
    /// vergebener IDs) zurückliefert; diese Node vergibt die IDs jetzt
    /// selbst (`state.next_item_seq`, gleiches `"item{n}"`-Muster wie
    /// `do_append`).
    fn do_load(&self, items_json: &str) -> Result<(), String> {
        #[derive(serde::Deserialize)]
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
            /// Kapitel 27 / P2a: RFC 3339 mit Offset (`2026-10-02T10:00:00+02:00`).
            #[serde(rename = "startAt", default)]
            start_at: Option<String>,
            /// Kapitel 27 / P4c: Live-Quelle per Auswahlkriterien (`omp-resolver::Selector`).
            #[serde(rename = "sourceSelector", default)]
            source_selector: Option<omp_resolver::Selector>,
            /// Kapitel 27 / P2b: "image" | "hold" | "jump".
            #[serde(rename = "eventType", default)]
            event_type: Option<String>,
            /// JUMP-Ziel als Position (0-basiert) in DIESER Liste — die Item-IDs
            /// entstehen erst beim Laden.
            #[serde(rename = "jumpToIndex", default)]
            jump_to_index: Option<usize>,
            #[serde(rename = "transition", default)]
            transition: Transition,
            #[serde(rename = "transitionRateFrames", default)]
            transition_rate_frames: Option<u32>,
            #[serde(default)]
            children: Vec<ChildEvent>,
            /// Kapitel 27 / P5: Audio-Absicht (`omp_resolver::audio::AudioIntent`).
            #[serde(default)]
            audio: Option<omp_resolver::audio::AudioIntent>,
            #[serde(flatten)]
            media_ref: readiness::MediaRef,
        }
        let load_items: Vec<LoadItem> = serde_json::from_str(items_json)
            .map_err(|e| format!("itemsJson ungültig: {e}"))?;
        // Vorab validieren, damit ein ungültiges `startAt` die Liste nicht
        // halb ersetzt (die Schleife unten ändert den State).
        let mut start_ats = Vec::with_capacity(load_items.len());
        for li in &load_items {
            start_ats.push(match li.start_at.as_deref().filter(|s| !s.is_empty()) {
                Some(s) => Some(
                    schedule::parse_start_at(s)
                        .ok_or_else(|| format!("startAt „{s}\u{201c} ungültig (RFC 3339, z. B. 2026-10-02T10:00:00+02:00)"))?,
                ),
                None => None,
            });
        }

        for (n, li) in load_items.iter().enumerate() {
            if li.event_type.as_deref().map(str::to_ascii_lowercase).as_deref() == Some("jump") {
                match li.jump_to_index {
                    Some(i) if i < load_items.len() && i != n => {}
                    Some(i) => return Err(format!("Item {n}: jumpToIndex {i} ungültig (außerhalb der Liste oder auf sich selbst)")),
                    None => return Err(format!("Item {n}: JUMP braucht jumpToIndex")),
                }
            }
        }
        let jump_indices: Vec<Option<usize>> = load_items.iter().map(|li| li.jump_to_index).collect();

        let mut state = self.state.lock().expect("lock poisoned");
        let mut ids = Vec::with_capacity(load_items.len());
        let mut metadata = HashMap::with_capacity(load_items.len());
        for (li, start_at_utc_ms) in load_items.into_iter().zip(start_ats) {
            state.next_item_seq += 1;
            let id = format!("item{}", state.next_item_seq);
            let meta = ItemMeta {
                label: li.label,
                media: item_media_from_args(
                    li.pattern.as_deref(),
                    li.file.as_deref(),
                    li.sender_id.as_deref(),
                    li.tone_frequency,
                    li.event_type.as_deref(),
                    None,
                    li.source_selector.as_ref(),
                ),
                duration_ms: if matches!(li.event_type.as_deref().map(str::to_ascii_lowercase).as_deref(), Some("hold" | "jump")) {
                    0
                } else {
                    li.duration_ms.unwrap_or(DEFAULT_DURATION_MS)
                },
                start_type: li.start_type,
                fixtime_hms: li.fixtime_hms,
                start_at_utc_ms,
                transition: li.transition,
                transition_rate_frames: li.transition_rate_frames,
                children: li.children,
                audio: li.audio,
                media_ref: li.media_ref,
            };
            metadata.insert(id.clone(), meta);
            ids.push(id);
        }

        // Kapitel 6 Teil 3: `fixtime_resolved` ist an Item-IDs gebunden,
        // die bei jedem `load()` frisch vergeben werden — der alte
        // Resolved-Zustand wäre ohnehin nicht mehr sinnvoll zuordenbar.
        // Bewusst NICHT positionell gerettet — ein Fixtime-Event, das
        // VOR einem Reorder bereits gefeuert hat, feuert danach
        // höchstens ein zweites Mal fälschlich (harmlos: derselbe Take
        // wie eh schon aktiv), verpasst aber nie eins.
        // JUMP-Ziele (Listenposition → Item-ID) erst jetzt, wo alle IDs feststehen.
        for (n, target_index) in jump_indices.iter().enumerate() {
            if let (Some(t), Some(m)) = (target_index, metadata.get_mut(&ids[n]))
                && let ItemMedia::Jump { target_id } = &mut m.media
            {
                *target_id = ids[*t].clone();
            }
        }
        state.fixtime_resolved.clear();
        state.playlist.replace_all(ids);
        state.asrun.end(chrono::Utc::now().timestamp_millis(), "INTERRUPTED", "Playlist ersetzt (load)");
        state.metadata = metadata;
        state.onair_since = None;
        // Die Rundown-Liste wurde komplett ersetzt — eine vorher
        // gemerkte last_live_item_id existiert danach evtl. nicht mehr
        // in `state.metadata`, s. dortige Doku. Der aktuell laufende
        // Kanal selbst bleibt unangetastet (kein `take_on_targets`-
        // Aufruf hier, reine Listenoperation).
        state.last_live_item_id = None;
        // C20: komplette Playlist ersetzt, Zeitplan-Cache ab Index 0
        // ungültig.
        state.timeline.invalidate_from(0);
        Ok(())
    }

    /// Kapitel 6 Teil 7: rein lokale Listenoperation — Entfernen aus dem
    /// Rundown betrifft nur `state.playlist`/`state.metadata`, nie einen
    /// Kanal. Anders als beim alten Ziel-Player (dessen `remove()` das
    /// Entfernen eines noch on-air befindlichen Items ablehnte, s.
    /// `AutomationState::last_live_item_id`-Doku zum historischen C18-
    /// Fund) gibt es bei `omp-channel-player` gar kein Player-seitiges
    /// Item-Konzept mehr, das dem im Weg stünde — auch das gerade live
    /// gezeigte Item lässt sich jetzt aus dem Rundown entfernen, ohne
    /// die laufende Wiedergabe zu beeinflussen (gleiche "Liste ≠
    /// Wiedergabe"-Trennung wie bei `do_stop`).
    fn do_remove(&self, item_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let index = state
            .playlist
            .index_of(item_id)
            .ok_or("unbekannte itemId".to_string())?;
        state.playlist.remove(index).map_err(|e| e.to_string())?;
        state.metadata.remove(item_id);
        // C20: alles ab dem entfernten Index rückt eine Position vor,
        // Zeitplan-Cache dort ungültig.
        state.timeline.invalidate_from(index);
        Ok(())
    }

    /// Verschiebt ein Event an eine neue Position (Drag & Drop im Panel). Cue/On-Air-Zustand bleiben,
    /// der Cursor folgt dem Event (`Playlist::move_item`).
    fn do_move_item(&self, item_id: &str, to_index: usize) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let from = state.playlist.index_of(item_id).ok_or("unbekannte itemId".to_string())?;
        state.playlist.move_item(from, to_index).map_err(|_| format!("Zielposition {to_index} liegt außerhalb der Liste"))?;
        state.timeline.invalidate_from(from.min(to_index));
        Ok(())
    }

    /// Property-Editor: ändert beliebige Eigenschaften EINES Events in einem Schritt (alles-oder-nichts —
    /// zuerst vollständig geprüft, dann angewendet). Das laufende Event darf nicht umgebaut werden
    /// (Medium/Dauer), Children/Audio/Titel/Start/Transition schon.
    fn do_update_item(&self, item_id: &str, patch: &Value) -> Result<(), String> {
        let mut p: ItemPatch = serde_json::from_value(patch.clone()).map_err(|e| format!("Eigenschaften ungültig: {e}"))?;

        // 1) Vorab prüfen/auflösen (ohne den State-Lock zu halten: Asset-Auflösung ist ein HTTP-Aufruf).
        let player_label = self.state.lock().expect("lock poisoned").target_player_a_label.clone();
        let mut new_media: Option<(ItemMedia, Option<readiness::AssetRef>)> = None;
        if let Some(m) = &p.media {
            let nonempty = |o: &Option<String>| o.as_deref().filter(|s| !s.trim().is_empty()).map(|s| s.trim().to_string());
            let media = match m.kind.as_str() {
                "pattern" => item_media_from_args(m.pattern.as_deref(), None, None, m.tone_frequency, None, None, None),
                "file" => ItemMedia::File { path: nonempty(&m.file).ok_or("Datei fehlt")? },
                "image" => ItemMedia::Image { path: nonempty(&m.file).ok_or("Bilddatei fehlt")? },
                "live" => ItemMedia::Live { sender_id: nonempty(&m.sender_id).ok_or("Live-Quelle fehlt")? },
                "liveselect" => {
                    let sel = m.source_selector.clone().ok_or("sourceSelector fehlt")?;
                    ItemMedia::LiveSelect { selector: Box::new(sel) }
                }
                "hold" => ItemMedia::Hold,
                "jump" => ItemMedia::Jump { target_id: nonempty(&m.jump_target).ok_or("Sprungziel fehlt")? },
                "asset" => {
                    let a = m.asset.clone().filter(|a| !a.asset_id.is_empty()).ok_or("Asset-ID fehlt")?;
                    let file = resolve_asset_file(self, &player_label, &a)?;
                    new_media = Some((ItemMedia::File { path: file }, Some(a)));
                    ItemMedia::Hold // Platzhalter, unten überschrieben
                }
                other => return Err(format!("unbekannter Medientyp „{other}\u{201c}")),
            };
            if new_media.is_none() {
                new_media = Some((media, None));
            }
        }
        if let Some(c) = p.ad_class.as_deref()
            && !c.is_empty()
            && !readiness::AD_CLASSES.contains(&c)
        {
            return Err(format!("adClass „{c}\u{201c} unbekannt ({})", readiness::AD_CLASSES.join(" | ")));
        }
        let start_type = match p.start_type.as_deref() {
            None => None,
            Some(s) => Some(StartType::parse(s).ok_or_else(|| format!("startType „{s}\u{201c} unbekannt"))?),
        };
        let start_at_ms = match p.start_at.as_deref() {
            None => None,
            Some("") => Some(None),
            Some(t) => Some(Some(schedule::parse_start_at(t).ok_or("startAt ungültig (RFC 3339 mit Zeitzone)")?)),
        };
        if let Some(h) = p.fixtime_hms.as_deref().filter(|h| !h.is_empty())
            && parse_hms_to_secs(h).is_none()
        {
            return Err(format!("fixtimeHms „{h}\u{201c} ungültig (Format HH:MM:SS)"));
        }
        let on_missing = match p.on_missing.as_deref() {
            None => None,
            Some("") => Some(readiness::MissingPolicy::default()),
            Some(s) => Some(readiness::MissingPolicy::parse(s).ok_or_else(|| format!("onMissing „{s}\u{201c} unbekannt"))?),
        };
        let audio: Option<Option<omp_resolver::audio::AudioIntent>> = match &p.audio {
            None => None,
            Some(Value::Null) => Some(None),
            Some(v) => {
                let i: omp_resolver::audio::AudioIntent = serde_json::from_value(v.clone()).map_err(|e| format!("audio ungültig: {e}"))?;
                Some(if i == omp_resolver::audio::AudioIntent::default() { None } else { Some(i) })
            }
        };
        if let Some(children) = p.children.as_mut() {
            let mut seen = std::collections::HashSet::new();
            for (n, c) in children.iter_mut().enumerate() {
                if c.id.trim().is_empty() {
                    c.id = format!("c{}", n + 1);
                }
                c.validate().map_err(|e| format!("Child {} („{}\u{201c}): {e}", n + 1, c.id))?;
                if !seen.insert(c.id.clone()) {
                    return Err(format!("Child-ID „{}\u{201c} kommt doppelt vor", c.id));
                }
            }
        }

        apply_item_patch(&mut self.state.lock().expect("lock poisoned"), item_id, new_media, start_type, start_at_ms, on_missing, audio, p)
    }

    /// Ändert ein bestehendes Cart (Panel „Assets verwalten“).
    fn do_cart_update(&self, asset_id: &str, patch: &Value) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let (_, meta) = state.carts.iter_mut().find(|(id, _)| id == asset_id).ok_or("unbekannte Cart-ID".to_string())?;
        let text = |k: &str| patch.get(k).and_then(Value::as_str);
        if let Some(l) = text("label") {
            if l.trim().is_empty() {
                return Err("label darf nicht leer sein".to_string());
            }
            meta.label = l.trim().to_string();
        }
        if let ItemMedia::TestPattern { pattern, tone_frequency } = &mut meta.media {
            if let Some(p) = text("pattern").filter(|p| !p.is_empty()) {
                *pattern = p.to_string();
            }
            if let Some(t) = patch.get("toneFrequency").and_then(Value::as_f64) {
                *tone_frequency = t.max(0.0);
            }
        }
        if let Some(d) = patch.get("durationMs").and_then(Value::as_f64) {
            meta.duration_ms = d.max(0.0) as u64;
        }
        if let Some(i) = text("icon") {
            meta.media_ref.icon = i.to_string();
        }
        if let Some(c) = text("color") {
            meta.media_ref.color = c.to_string();
        }
        Ok(())
    }

    /// Kapitel 6 Teil 7: "cue" bedeutet jetzt echtes `load()` auf den
    /// Standby-Kanal (Vorschau/Vorbereitung, PROGRAM/Mixer bleibt
    /// unberührt) statt nur eines internen Zeigers beim Ziel-Player —
    /// der A/B-Kanal-Wechsel selbst braucht dafür KEINEN eigenen
    /// Fernaufruf, `standby_target`/`load_onto_channel` reichen (dieselbe
    /// Logik, die `take_on_targets` intern zuerst ausführt). Schlägt der
    /// `load()`-Aufruf fehl, bleibt der lokale Cue-Zeiger unverändert
    /// (remote zuerst, dann erst lokal committen, gleiches Prinzip wie
    /// überall sonst in diesem Node).
    fn do_cue(&self, item_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let index = state
            .playlist
            .index_of(item_id)
            .ok_or("unbekannte itemId".to_string())?;
        let meta = state
            .metadata
            .get(item_id)
            .cloned()
            .ok_or("Item-Metadaten fehlen (Rundown-Eintrag inkonsistent)".to_string())?;
        let (standby_node_id, standby_label) = standby_target(&state)?;
        // Kapitel 27 / P8: auch das Cue folgt der Ausfallrichtlinie (Vorschau des Ersatzes bzw. „gehalten“).
        let meta = if meta.media_ref.asset.is_some() { apply_media_policy(self, &state, &standby_label, &meta, false)? } else { meta };
        load_onto_channel(self, &standby_node_id, &meta)?;

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
        start_at_utc_ms: Option<i64>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        // `startAt` (absolut, UTC) hat Vorrang vor dem dateilosen `fixtimeHms`.
        let resolved_fixtime = if start_type == StartType::Fixtime && start_at_utc_ms.is_none() {
            let hms = fixtime_hms.ok_or("startAt (RFC 3339) oder fixtimeHms (HH:MM:SS) fehlt".to_string())?;
            if parse_hms_to_secs(&hms).is_none() {
                return Err(format!("fixtimeHms „{hms}\u{201c} ungültig (Format HH:MM:SS)"));
            }
            Some(hms)
        } else {
            None
        };
        let start_at_utc_ms = if start_type == StartType::Fixtime { start_at_utc_ms } else { None };
        match state.metadata.get_mut(item_id) {
            Some(meta) => {
                meta.start_type = start_type;
                meta.fixtime_hms = resolved_fixtime;
                meta.start_at_utc_ms = start_at_utc_ms;
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
    /// Kapitel 27 / P5: setzt (oder löscht, bei `None`) die Audio-Absicht eines
    /// Items — rein lokal wie `do_set_transition`, wirkt beim nächsten Take.
    fn do_set_audio(&self, item_id: &str, intent: Option<omp_resolver::audio::AudioIntent>) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        match state.metadata.get_mut(item_id) {
            Some(meta) => {
                meta.audio = intent;
                Ok(())
            }
            None => Err("unbekannte itemId".to_string()),
        }
    }

    fn do_set_children(&self, item_id: &str, mut children: Vec<ChildEvent>) -> Result<(), String> {
        // Vorab validieren (Kapitel 27 / P3): ein ungültiges Kind verwirft die
        // ganze Liste, statt halb gesetzt zu werden. IDs werden vergeben, wenn leer.
        let mut seen = std::collections::HashSet::new();
        for (n, c) in children.iter_mut().enumerate() {
            if c.id.trim().is_empty() {
                c.id = format!("c{}", n + 1);
            }
            c.validate().map_err(|e| format!("Child {} („{}\u{201c}): {e}", n + 1, c.id))?;
            if !seen.insert(c.id.clone()) {
                return Err(format!("Child-ID „{}\u{201c} kommt doppelt vor", c.id));
            }
        }
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
            start_at_utc_ms: None,
                transition: Transition::default(),
                transition_rate_frames: None,
                children: Vec::new(),
                audio: None,
                media_ref: Default::default(),
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
    /// ist, lädt das Cart-Asset auf den Standby-Kanal und schaltet den
    /// Mixer wie bei `take()` darauf um — dieselbe `take_on_targets`-
    /// Sequenz, kein eigener Mechanismus. `playlist` selbst bleibt
    /// unangetastet (s. `ActiveCart`-Doku). Kapitel 6 Teil 7: kein
    /// append/remove-Umweg über einen Ziel-Player mehr nötig — das
    /// Cart-Asset ist bereits ein vollständiges `ItemMeta`.
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
        let mixer_node_id = state
            .mixer_node_id
            .clone()
            .ok_or("Ziel-Mixer nicht aufgelöst (targetMixerLabel unbekannt/noch nicht gestartet)")?;

        // `last_live_item_id` statt `playlist.on_air()` — s. dessen Doku
        // (AutomationState): das lokale on_air-Flag kann durch ein
        // Ende-der-Liste-`advance()` bereits `false` sein, obwohl der
        // Mixer den Hauptkanal unverändert weiter zeigt.
        let interrupted_item_id = state.last_live_item_id.clone();
        let elapsed_before_interrupt_ms = state
            .onair_since
            .map(|since| since.elapsed().as_millis())
            .unwrap_or(0);

        // Kapitel 6 Teil 4: ein Cart-Interrupt ist per Definition ein
        // sofortiges Eingreifen (Blackclip, Standby, …) — immer harter
        // Cut, unabhängig davon, was `transition` für dieses (synthetische
        // Test-Muster-)Cart-Item ohnehin bedeutungslos trüge.
        let new_channel = take_on_targets(self, &state, &mixer_node_id, &meta, Transition::Cut, None)?;
        state.live_channel = new_channel;
        // Kapitel 6 Teil 5: Cart-Assets haben nie Kinder (Doku oben) —
        // storniert nur ausstehende Grafik-Ereignisse des unterbrochenen
        // Hauptkanal-Items.
        self.schedule_children(&mut state, asset_id, Instant::now());

        state.active_cart = Some(ActiveCart {
            asset_id: asset_id.to_string(),
            fired_at: Instant::now(),
            duration_ms: meta.duration_ms,
            interrupted_item_id,
            elapsed_before_interrupt_ms,
        });
        Ok(())
    }

    /// Beendet einen laufenden Cart-Interrupt: stellt den gemerkten
    /// Hauptkanal-Zustand IMMER über die volle `take_on_targets`-Sequenz
    /// wieder her (nicht bloß `cue()`) — lädt das unterbrochene Item
    /// erneut auf den (jetzt wieder freien) Standby-Kanal und schneidet
    /// den Mixer darauf zurück. Nichts zu tun, wenn der Hauptkanal beim
    /// Fire noch nie live war. Kapitel 6 Teil 7: kein Aufräumen eines
    /// Player-seitigen Cart-Item mehr nötig — `omp-channel-player` hat
    /// keine Liste, in der ein Cart-Clip nachwirken könnte, sobald der
    /// Standby-Kanal beim Return mit dem wiederhergestellten Item
    /// überschrieben wird.
    fn do_cart_return(&self) -> Result<(), String> {
        let mut state = self.state.lock().expect("lock poisoned");
        let Some(active) = state.active_cart.take() else {
            return Ok(());
        };

        if let Some(restore_id) = active.interrupted_item_id.clone() {
            let meta = state
                .metadata
                .get(&restore_id)
                .cloned()
                .ok_or("Item-Metadaten des unterbrochenen Items fehlen (evtl. zwischenzeitlich aus dem Rundown entfernt)")?;
            let mixer_node_id = state
                .mixer_node_id
                .clone()
                .ok_or("Ziel-Mixer nicht aufgelöst (Cart-Return)")?;
            // Kapitel 6 Teil 4: Return nach einem Interrupt bewusst immer
            // ein harter Cut, unabhängig vom `transition`-Feld des
            // wiederhergestellten Items — Vorhersagbarkeit nach einem
            // Cart-Interrupt zählt hier mehr als eine weiche Rampe.
            let new_channel = take_on_targets(self, &state, &mixer_node_id, &meta, Transition::Cut, None)?;
            state.live_channel = new_channel;
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
        Ok(())
    }

    fn report(&self, message: String) {
        eprintln!("omp-playout-automation: {message}");
        let _ = self.events.send(Event::Error(message));
    }
}

/// Baut die `load()`-Argumente aus einem `ItemMeta` — exakt das
/// Feld-Set, das `omp-channel-player::invoke("load")` erwartet (label/
/// pattern/file/senderId/toneFrequency/durationMs). Geteilt zwischen
/// `load_onto_channel`/`take_on_targets` und `do_cart_fire` (vorher an
/// jeder Stelle einzeln aufgebaut, s. Git-Historie).
fn load_args(meta: &ItemMeta) -> Value {
    let mut body = serde_json::json!({ "label": meta.label, "durationMs": meta.duration_ms });
    match &meta.media {
        ItemMedia::TestPattern { pattern, tone_frequency } => {
            body["pattern"] = serde_json::json!(pattern);
            body["toneFrequency"] = serde_json::json!(tone_frequency);
        }
        ItemMedia::File { path } => body["file"] = serde_json::json!(path),
        ItemMedia::Live { sender_id } => body["senderId"] = serde_json::json!(sender_id),
        ItemMedia::Image { path } => {
            body["file"] = serde_json::json!(path);
            body["mediaType"] = serde_json::json!("image");
        }
        // Steuer-Events werden nie geladen (`load_onto_channel`/`take_on_targets`);
        // `LiveSelect` wird vorher zu `Live` aufgelöst (`resolve_item_media`).
        ItemMedia::Hold | ItemMedia::Jump { .. } | ItemMedia::LiveSelect { .. } => {}
    }
    // Audio-Zuordnung des Events (Kapitel 27 / A4): der Player löst sie gegen die Quelle auf.
    if !meta.media_ref.audio_mapping.is_empty() {
        body["audioMapping"] = serde_json::json!(meta.media_ref.audio_mapping);
    }
    body
}

/// Node-ID+Label des Standby-Kanals (`state.live_channel.other()`) —
/// dort lädt `do_cue`/`take_on_targets` das nächste Item, ohne den
/// gerade laufenden Hauptkanal zu stören (kein `load()`-Aufruf auf dem
/// aktiven Kanal, kein Glitch am Programmausgang).
fn standby_target(state: &AutomationState) -> Result<(String, String), String> {
    let (node_id, label) = match state.live_channel.other() {
        Channel::A => (&state.player_a_node_id, &state.target_player_a_label),
        Channel::B => (&state.player_b_node_id, &state.target_player_b_label),
    };
    let node_id = node_id.clone().ok_or(
        "Ziel-Player (Standby-Kanal) nicht aufgelöst (targetPlayerALabel/targetPlayerBLabel unbekannt/noch nicht gestartet)",
    )?;
    Ok((node_id, label.clone()))
}

/// Maximale Kettenlänge aufeinanderfolgender JUMP-Events (Schleifenschutz).
const MAX_JUMP_CHAIN: usize = 8;

/// Medien-Teil eines Property-Editor-Patches.
#[derive(serde::Deserialize, Default)]
struct MediaPatch {
    kind: String,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    file: Option<String>,
    #[serde(rename = "senderId", default)]
    sender_id: Option<String>,
    #[serde(rename = "toneFrequency", default)]
    tone_frequency: Option<f64>,
    #[serde(rename = "sourceSelector", default)]
    source_selector: Option<omp_resolver::Selector>,
    #[serde(rename = "jumpTarget", default)]
    jump_target: Option<String>,
    #[serde(default)]
    asset: Option<readiness::AssetRef>,
}
#[derive(serde::Deserialize, Default)]
struct ItemPatch {
    label: Option<String>,
    note: Option<String>,
    icon: Option<String>,
    color: Option<String>,
    #[serde(rename = "adClass")]
    ad_class: Option<String>,
    #[serde(rename = "audioMapping")]
    audio_mapping: Option<String>,
    media: Option<MediaPatch>,
    #[serde(rename = "durationMs")]
    duration_ms: Option<u64>,
    #[serde(rename = "startType")]
    start_type: Option<String>,
    #[serde(rename = "startAt")]
    start_at: Option<String>,
    #[serde(rename = "fixtimeHms")]
    fixtime_hms: Option<String>,
    transition: Option<Transition>,
    #[serde(rename = "transitionRateFrames")]
    transition_rate_frames: Option<Value>,
    children: Option<Vec<ChildEvent>>,
    audio: Option<Value>,
    #[serde(rename = "onMissing")]
    on_missing: Option<String>,
    #[serde(rename = "fallbackFile")]
    fallback_file: Option<String>,
}


/// Wendet einen vollständig vorab geprüften Patch an (alles oder nichts — nach der ersten Änderung gibt es
/// keinen Fehlerpfad mehr). Reine Zustandsfunktion, ohne Netz.
#[allow(clippy::too_many_arguments)]
fn apply_item_patch(
    state: &mut AutomationState,
    item_id: &str,
    new_media: Option<(ItemMedia, Option<readiness::AssetRef>)>,
    start_type: Option<StartType>,
    start_at_ms: Option<Option<i64>>,
    on_missing: Option<readiness::MissingPolicy>,
    audio: Option<Option<omp_resolver::audio::AudioIntent>>,
    p: ItemPatch,
) -> Result<(), String> {
    let index = state.playlist.index_of(item_id).ok_or("unbekannte itemId".to_string())?;
    let is_on_air = state.playlist.on_air() && state.playlist.current_index() == Some(index);
    if is_on_air && (new_media.is_some() || p.duration_ms.is_some()) {
        return Err("Das laufende Event kann nicht umgebaut werden (Medium/Dauer) — Titel, Children, Audio, Start und Transition sind änderbar".to_string());
    }
    if let Some((ItemMedia::Jump { target_id }, _)) = &new_media
        && state.playlist.index_of(target_id).is_none()
    {
        return Err(format!("Sprungziel „{target_id}\u{201c} ist kein Event dieser Liste"));
    }
    let meta = state.metadata.get_mut(item_id).ok_or("Metadaten fehlen".to_string())?;
    if let Some(l) = p.label {
        meta.label = l;
    }
    for (field, val) in [(&mut meta.media_ref.note, p.note), (&mut meta.media_ref.icon, p.icon), (&mut meta.media_ref.color, p.color), (&mut meta.media_ref.ad_class, p.ad_class), (&mut meta.media_ref.audio_mapping, p.audio_mapping)] {
        if let Some(v) = val {
            *field = v;
        }
    }
    if let Some((media, asset)) = new_media {
        meta.media = media;
        meta.media_ref.asset = asset;
        if meta.media.is_control() {
            meta.duration_ms = 0;
        }
    }
    if let Some(d) = p.duration_ms
        && !meta.media.is_control()
    {
        meta.duration_ms = d;
    }
    if let Some(st) = start_type {
        meta.start_type = st;
    }
    if meta.start_type == StartType::Fixtime {
        if let Some(at) = start_at_ms {
            meta.start_at_utc_ms = at;
        }
        if let Some(h) = p.fixtime_hms.as_deref() {
            meta.fixtime_hms = Some(h).filter(|h| !h.is_empty()).map(str::to_string);
        }
        if meta.start_at_utc_ms.is_none() && meta.fixtime_hms.is_none() {
            meta.start_type = StartType::default(); // „Fixtime ohne Zeit“ gibt es nicht
        }
    } else {
        meta.start_at_utc_ms = None;
        meta.fixtime_hms = None;
    }
    if let Some(t) = p.transition {
        meta.transition = t;
    }
    if let Some(v) = p.transition_rate_frames {
        meta.transition_rate_frames = v.as_u64().filter(|f| (1..=250).contains(f)).map(|f| f as u32);
    }
    if let Some(c) = p.children {
        meta.children = c;
    }
    if let Some(a) = audio {
        meta.audio = a;
    }
    if let Some(m) = on_missing {
        meta.media_ref.on_missing = m;
    }
    if let Some(f) = p.fallback_file {
        meta.media_ref.fallback_file = Some(f).filter(|f| !f.trim().is_empty());
    }
    state.fixtime_resolved.remove(item_id);
    state.readiness.remove(item_id);
    state.timeline.invalidate_from(index);
    Ok(())
}


/// Kapitel 27 / P2b: löst ein JUMP-Event auf. Ist `item_id` ein `Jump`, wird
/// (ggf. über mehrere Sprünge) das Ziel-Item ermittelt und die Playlist darauf
/// gecued; mit `mark_on_air` zusätzlich auf Sendung markiert (für Pfade, in
/// denen `advance()` bereits „on air“ gesetzt hat — der Aufrufer nimmt das
/// Ziel danach selbst auf den Ziel-Nodes). Liefert die endgültige Item-ID
/// (unverändert, wenn `item_id` kein JUMP ist). Fehler bei fehlendem Ziel oder
/// einer Kette länger als `MAX_JUMP_CHAIN` (Endlosschleife JUMP→JUMP).
fn resolve_jump(state: &mut AutomationState, item_id: String, mark_on_air: bool) -> Result<String, String> {
    let mut current = item_id;
    for _ in 0..=MAX_JUMP_CHAIN {
        let Some(ItemMedia::Jump { target_id }) = state.metadata.get(&current).map(|m| m.media.clone()) else {
            return Ok(current);
        };
        let idx = state
            .playlist
            .index_of(&target_id)
            .ok_or_else(|| format!("JUMP-Ziel „{target_id}\u{201c} nicht mehr im Rundown"))?;
        state.playlist.cue(idx).map_err(|e| e.to_string())?;
        if mark_on_air {
            state.playlist.take().map_err(|e| e.to_string())?;
        }
        current = target_id;
    }
    Err(format!("JUMP-Kette länger als {MAX_JUMP_CHAIN} — Schleife?"))
}

/// Kapitel 27 / P4c: `LiveSelect` → `Live` mit der JETZT gewählten Sender-ID
/// (frische Quellen vom Orchestrator; kein Raten bei Unsicherheit: ohne Treffer
/// ein Fehler mit Begründung, bei Gleichrang eine Meldung). Alle anderen Medien
/// unverändert.
fn resolve_item_media(store: &AutomationStore, meta: &ItemMeta) -> Result<ItemMeta, String> {
    let ItemMedia::LiveSelect { selector } = &meta.media else { return Ok(meta.clone()) };
    let sources = remote::fetch_sources(&store.orchestrator_url, &store.auth)
        .map_err(|e| format!("Quellen konnten nicht gelesen werden ({e}) — Live-Auswahl für „{}\u{201c} nicht möglich", meta.label))?;
    let (sender_id, resolution) = resolve_live_selector(selector, &sources).map_err(|e| format!("„{}\u{201c}: {e}", meta.label))?;
    if resolution.ambiguous {
        store.report(format!("Live-Auswahl für „{}\u{201c} mehrdeutig: {}", meta.label, resolution.summary));
    }
    let mut out = meta.clone();
    out.media = ItemMedia::Live { sender_id };
    Ok(out)
}

/// Meldet höchstens alle 10 s dieselbe Nachricht (Take im Auto-Advance-Takt).
fn report_throttled(store: &AutomationStore, message: String) {
    let mut map = store.report_throttle.lock().expect("lock poisoned");
    let now = Instant::now();
    if map.get(&message).is_some_and(|t| now.duration_since(*t) < Duration::from_secs(10)) {
        return;
    }
    map.retain(|_, t| now.duration_since(*t) < Duration::from_secs(60));
    map.insert(message.clone(), now);
    drop(map);
    store.report(message);
}

/// Fragt den Orchestrator nach der Verfügbarkeit von Asset-Medien am Ziel-Player (`preflight`). Blockierend.
/// Antwort je Eintrag: `{key, state, detail, fileName, estimateSeconds, progress, materializable}`.
fn preflight_request(store: &AutomationStore, channel_id: &str, target_label: &str, items: &[(String, readiness::AssetRef)]) -> Result<Vec<Value>, String> {
    if channel_id.is_empty() {
        return Err("Channel unbekannt (Persistenz noch nicht verbunden)".to_string());
    }
    let body = serde_json::json!({
        "target": {"nodeLabel": target_label},
        "items": items.iter().map(|(k, a)| serde_json::json!({
            "key": k, "assetId": a.asset_id, "versionId": a.version_id, "representationType": a.representation_type,
        })).collect::<Vec<_>>(),
    });
    let resp = remote::post_json(&store.orchestrator_url, &store.auth, &format!("/api/v1/playout/channels/{channel_id}/preflight"), &body)?;
    Ok(resp.get("items").and_then(Value::as_array).cloned().unwrap_or_default())
}

/// Stößt die Bereitstellung eines Assets am Ziel-Player an (OMP-Prozess „Asset materialisieren“).
fn materialize_request(store: &AutomationStore, channel_id: &str, target_label: &str, key: &str, asset: &readiness::AssetRef) -> Result<Value, String> {
    let body = serde_json::json!({
        "target": {"nodeLabel": target_label},
        "item": {"key": key, "assetId": asset.asset_id, "versionId": asset.version_id, "representationType": asset.representation_type},
    });
    remote::post_json(&store.orchestrator_url, &store.auth, &format!("/api/v1/playout/channels/{channel_id}/materialize"), &body)
}

/// Löst eine Asset-Referenz zum Dateinamen am Ziel-Player auf (nur Auflösung, keine Bereitschaft verlangt).
fn resolve_asset_file(store: &AutomationStore, target_label: &str, asset: &readiness::AssetRef) -> Result<String, String> {
    let channel = store.persistence.channel_id();
    let res = preflight_request(store, &channel, target_label, &[("resolve".to_string(), asset.clone())])?;
    let first = res.first().ok_or("leere Antwort des Orchestrators")?;
    let name = first.get("fileName").and_then(Value::as_str).unwrap_or("");
    if name.is_empty() {
        let why = first.get("detail").and_then(Value::as_str).unwrap_or("Asset nicht auflösbar");
        return Err(format!("Asset „{}\u{201c}: {why}", asset.asset_id));
    }
    Ok(name.to_string())
}

/// Spec §73: Ist das Asset-Medium des Items zur Sendezeit nicht bereit, entscheidet die Ausfallrichtlinie.
/// Wird vor dem Laden aufgerufen (Take). Liefert das tatsächlich zu sendende Item (ggf. ersetzt) oder den
/// Fehler „Event gehalten“. Ist der Preflight selbst nicht erreichbar, wird NICHT ersetzt (ungeprüft laden —
/// der Player meldet fehlende Dateien selbst), aber gemeldet.
fn apply_media_policy(store: &AutomationStore, state: &AutomationState, target_label: &str, meta: &ItemMeta, at_take: bool) -> Result<ItemMeta, String> {
    let Some(asset) = meta.media_ref.asset.clone() else { return Ok(meta.clone()) };
    if !matches!(meta.media, ItemMedia::File { .. }) {
        return Ok(meta.clone());
    }
    let channel = store.persistence.channel_id();
    let check = preflight_request(store, &channel, target_label, &[("take".to_string(), asset)]);
    let entry = match check {
        Ok(v) => v.into_iter().next().unwrap_or(Value::Null),
        Err(e) => {
            report_throttled(store, format!("Preflight für „{}\u{201c} nicht möglich ({e}) — Medium wird ungeprüft geladen", meta.label));
            return Ok(meta.clone());
        }
    };
    let st = entry.get("state").and_then(Value::as_str).unwrap_or("");
    if st == "READY" {
        return Ok(meta.clone());
    }
    let why = format!("{st}{}", entry.get("detail").and_then(Value::as_str).filter(|d| !d.is_empty()).map(|d| format!(": {d}")).unwrap_or_default());
    let outcome = readiness::apply_policy(
        meta.media_ref.on_missing,
        meta.media_ref.fallback_file.as_deref(),
        Some(state.default_filler.as_str()),
        &why,
    );
    report_throttled(store, format!("„{}\u{201c}: {}", meta.label, outcome.note));
    if outcome.stop_auto && at_take {
        store.request_hold.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    let mut out = meta.clone();
    match outcome.substitute {
        readiness::Substitute::Fail => return Err(outcome.note),
        readiness::Substitute::Black => out.media = ItemMedia::TestPattern { pattern: "black".to_string(), tone_frequency: 0.0 },
        readiness::Substitute::HoldProgram => out.media = ItemMedia::Hold,
        readiness::Substitute::File(f) => out.media = ItemMedia::File { path: f },
    }
    Ok(out)
}

/// Lädt ein Item auf einen bestimmten Kanal, OHNE den Mixer anzufassen
/// — Kern von `do_cue` (reine Vorschau, kein On-Air-Wechsel).
fn load_onto_channel(store: &AutomationStore, node_id: &str, meta: &ItemMeta) -> Result<(), String> {
    if meta.media.is_control() {
        return Ok(()); // nichts zu laden
    }
    let resolved = resolve_item_media(store, meta)?;
    let meta = &resolved;
    store
        .proxy_client(node_id.to_string())
        .invoke("load", load_args(meta))
        .map_err(|e| format!("Kanal-load fehlgeschlagen: {e}"))
}

/// Lädt ein Item auf den aktuellen Standby-Kanal und schneidet den
/// Ziel-Mixer per Crosspoint darauf — gemeinsamer Kern von `do_take`/
/// `do_advance`/`do_stop`/Cart-Fire/-Return. Kapitel 6 Teil 7 (`docs/
/// END-GOAL-FEATURES.md` §6.5): lädt IMMER auf den Kanal, der gerade
/// NICHT live ist (`state.live_channel` vor diesem Aufruf), und schaltet
/// den Mixer auf GENAU DIESEN, bis dahin nicht auf Sendung befindlichen
/// Sender — dieselbe Wahl über zwei tatsächlich verschiedene Mixer-
/// Sender macht `Transition::Mix` erstmals zu einem echten, sichtbaren
/// Xfade (vorher immer derselbe Sender erneut gewählt, s. Kapitel 6
/// Teil 6 "ehrliche v1-Grenze"). Gibt bei Erfolg den NEUEN
/// `live_channel`-Wert zurück, den der Aufrufer erst danach lokal
/// committen darf (remote zuerst, dann erst der lokale Zustandswechsel —
/// gleiches Prinzip wie zuvor bei `last_live_item_id`).
///
/// `crosspoint.select` setzt nur den Preset-Bus (§13.1), `crosspoint.
/// cut`/`autoTrans` vollzieht den eigentlichen Programmwechsel und löst
/// damit (über den bereits bestehenden Mechanismus in
/// `omp-video-mixer-me`) das Tally-Event für die Kachel des Kanals aus
/// — keine eigene Tally-Logik hier nötig.
///
/// Kapitel 6 Teil 4: `transition`/`rate_frames` steuern nur noch den
/// LETZTEN Schritt am Mixer (Cut vs. Mix). Aufrufer, die IMMER einen
/// harten Cut wollen (Stop-Schwarzbild, Cart-Interrupt/-Return — Doku
/// an deren jeweiligen Aufrufstellen), übergeben explizit
/// `(Transition::Cut, None)` statt das Item-eigene `transition`-Feld zu
/// befragen.
fn take_on_targets(
    store: &AutomationStore,
    state: &AutomationState,
    mixer_node_id: &str,
    meta: &ItemMeta,
    transition: Transition,
    rate_frames: Option<u32>,
) -> Result<Channel, String> {
    // Kapitel 27 / P8: Medium nicht bereit → Ausfallrichtlinie (Ersatz oder „gehalten“) VOR allem anderen.
    let policy_meta;
    let meta = if meta.media_ref.asset.is_some() {
        let (_, label) = standby_target(state)?;
        policy_meta = apply_media_policy(store, state, &label, meta, true)?;
        &policy_meta
    } else {
        meta
    };
    // Kapitel 27 / P2b: HOLD ändert nichts am Programm — das vorherige Bild
    // bleibt stehen; JUMP wird VOR dem Take aufgelöst (`resolve_jump`).
    match &meta.media {
        ItemMedia::Hold => return Ok(state.live_channel),
        ItemMedia::Jump { .. } => return Err("JUMP-Event nicht aufgelöst (interner Fehler)".to_string()),
        _ => {}
    }
    // Kapitel 27 / P3 Preflight (Spec §187): ein ERFORDERLICHES Child mit
    // Richtlinie BLOCK, dessen Ziel nicht auflösbar ist, verhindert den Take —
    // vorher, nicht erst mitten in der Sendung.
    for child in meta.children.iter().filter(|c| c.required && c.failure_policy == children::FailurePolicy::Block) {
        if !child_target_ok(state, child) {
            return Err(format!(
                "Preflight: erforderliches Child „{}\u{201c} von „{}\u{201c} hat kein auflösbares Ziel — Take blockiert",
                child.id, meta.label
            ));
        }
    }
    let (standby_node_id, standby_label) = standby_target(state)?;
    load_onto_channel(store, &standby_node_id, meta)?;

    let mixer = store.proxy_client(mixer_node_id.to_string());
    let sender_id = resolve_mixer_sender_id(&mixer, &standby_label).ok_or_else(|| {
        format!(
            "Standby-Kanal-Video-Sender am Mixer nicht gefunden (Label-Präfix \"{standby_label} Sender\" \
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
        Transition::Mix | Transition::FadeCut | Transition::CutFade => {
            // Art vor jeder Rampe setzen: der Mixer behält sie, ein späteres Mix-Event darf nicht in der
            // Art des vorigen Fade-Events laufen.
            let kind = match transition {
                Transition::FadeCut => "fadecut",
                Transition::CutFade => "cutfade",
                _ => "mix",
            };
            mixer
                .invoke("crosspoint.setTransType", serde_json::json!({"type": kind}))
                .map_err(|e| format!("Mixer-crosspoint.setTransType fehlgeschlagen: {e}"))?;
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

    apply_audio_context(store, state, meta);
    Ok(state.live_channel.other())
}

/// Kapitel 27 / P6: meldet dem Audiomixer nach dem Take, WELCHE Quelle jetzt im
/// Programm ist (Quell-Kontext) und welche Kanal-Wahlen das Event ausdrücklich
/// vorgibt. Der Mixer ordnet seine Kanäle anhand ihrer Tag-Erwartung selbst zu.
/// Items ohne Live-Quelle beenden den Kontext (Mixer stellt die manuelle Zuordnung
/// wieder her). Best effort: ein Fehler hier blockiert nie den Videotake — er
/// landet in `audioRouting` (Anzeige) und im Log.
fn apply_audio_context(store: &AutomationStore, state: &AutomationState, meta: &ItemMeta) {
    let Some(node_id) = state.audio_mixer_node_id.clone() else { return };
    let source = match &meta.media {
        ItemMedia::Live { sender_id } => state.sources.iter().find(|s| &s.sender_id == sender_id),
        ItemMedia::LiveSelect { selector } => omp_resolver::resolve(&effective_selector(selector), &state.sources)
            .selected_id
            .and_then(|id| state.sources.iter().find(|s| s.sender_id == id)),
        _ => None,
    };
    let (method, args, what) = match source {
        Some(src) => {
            let ctx = omp_resolver::SourceContext::of(src);
            let overrides = meta.audio.as_ref().map(|a| a.channels.clone()).unwrap_or_default();
            (
                "setSourceContext",
                serde_json::json!({
                    "nodeId": ctx.node_id,
                    "group": ctx.group,
                    "label": format!("{} / {}", src.node_label, src.label),
                    "overridesJson": serde_json::to_string(&overrides).unwrap_or_default(),
                }),
                format!("Kontext {} / {}", src.node_label, src.label),
            )
        }
        None => ("clearSourceContext", serde_json::json!({}), "Kontext beendet".to_string()),
    };
    let result = store.proxy_client(node_id).invoke(method, args);
    let status = match &result {
        Ok(()) => format!("{what}: gemeldet"),
        Err(e) => {
            eprintln!("omp-playout-automation: Audio-Kontext ({what}) fehlgeschlagen: {e}");
            format!("{what}: FEHLGESCHLAGEN ({e})")
        }
    };
    store.audio_status_hint(status);
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
/// Kapitel 27 / P3: der bisherige Primary wird abgelöst. Noch nicht gestartete
/// Kinder → CANCELLED (Spec §234: keine späteren Trigger mehr), gestartete
/// Kinder bekommen SOFORT einen Stopp (Spec §243: FULL_PRIMARY-Kinder enden
/// mit dem Primary; auch zeitlich begrenzte dürfen nicht stehenbleiben, weil
/// ihr geplanter Stopp sonst mit dem Primary verfiele).
fn retire_children(state: &mut AutomationState) {
    let now = Instant::now();
    // Starts aller Primaries verwerfen, Stopps vorziehen.
    state.child_schedule.retain(|e| matches!(e.action, ChildAction::Stop));
    for e in state.child_schedule.iter_mut() {
        if e.fire_at > now {
            e.fire_at = now;
        }
    }
    let mut stops = Vec::new();
    for rt in state.child_runtime.iter_mut() {
        match rt.state {
            ChildState::Scheduled | ChildState::Armed => {
                rt.state = ChildState::Cancelled;
            }
            ChildState::Fired | ChildState::Active => {
                if needs_stop(&rt.child) {
                    stops.push((rt.item_id.clone(), rt.child.id.clone()));
                } else {
                    rt.state = ChildState::Completed;
                }
            }
            _ => {}
        }
    }
    for (item_id, child_id) in stops {
        if !state.child_schedule.iter().any(|e| e.item_id == item_id && e.child_id == child_id && e.action == ChildAction::Stop) {
            state.child_schedule.push(ScheduledChild { fire_at: now, item_id, child_id, action: ChildAction::Stop });
        }
    }
    // Abgeschlossene Einträge älterer Primaries fallen weg; laufende bleiben bis zu ihrem Stopp.
    state.child_runtime.retain(|rt| !rt.state.is_terminal());
}

/// Braucht das Kind nach dem Start noch einen Stopp-Befehl?
fn needs_stop(child: &ChildEvent) -> bool {
    if child.is_native_voiceover() {
        return true;
    }
    if child.kind == ChildType::Subtitle {
        return true; // Start und Stopp: subtitle.start/stop am Grafik-Node
    }
    if child.kind == ChildType::Scte35 {
        // Rückkehr ins Netz (splice.in) bzw. End-Signal (endTypeId) beim Stopp.
        let p = &child.params;
        return p.get("returnAtStop").and_then(Value::as_bool).unwrap_or(true) && p.get("action").and_then(Value::as_str).unwrap_or("out") == "out"
            || p.get("endTypeId").is_some();
    }
    match child.kind {
        k if k.is_graphics() => true,
        k if k.is_node_command() => !child.stop_method.trim().is_empty(),
        _ => false,
    }
}

/// Plant die Kinder des gerade auf Sendung gegangenen Items (reine
/// Zustandsfunktion, testbar ohne Netzwerk). `saved`: Zustand je Kind-ID aus
/// einem Snapshot (Restart-Rekonstruktion, `Some`) — dann werden bereits
/// gestartete Kinder nicht erneut gestartet und verpasste Starts als
/// CANCELLED gemeldet statt nachgeholt (Spec §115: nicht blind erneut
/// ausführen). Liefert Meldungen für den Operator.
fn plan_children(
    state: &mut AutomationState,
    item_id: &str,
    onair_since: Instant,
    saved: Option<&HashMap<String, ChildState>>,
) -> Vec<String> {
    let mut notices = Vec::new();
    let Some(meta) = state.metadata.get(item_id) else { return notices };
    if meta.children.is_empty() {
        return notices;
    }
    let next_title = state.playlist.peek_next().and_then(|id| state.metadata.get(id)).map(|m| m.label.clone());
    let item_duration_ms = meta.duration_ms;
    let item_label = meta.label.clone();
    let children = meta.children.clone();
    let elapsed_ms = onair_since.elapsed().as_millis() as u64;
    for (n, original) in children.iter().enumerate() {
        let mut child = original.clone();
        if child.id.is_empty() {
            child.id = format!("c{}", n + 1);
        }
        child.data = resolve_variables(&child.data, next_title.as_deref());
        let window = match child.resolve_window(item_duration_ms, state.onair_utc_ms) {
            Ok(w) => w,
            Err(e) => {
                notices.push(format!("Child „{}\u{201c} von „{item_label}\u{201c} übersprungen: {e}", child.id));
                state.child_runtime.push(ChildRuntime {
                    item_id: item_id.to_string(),
                    child,
                    state: ChildState::Failed,
                    start_offset_ms: 0,
                    stop_offset_ms: None,
                    until_primary_end: false,
                    attempt: 0,
                    error: Some(e),
                    used_fallback: false,
                });
                continue;
            }
        };
        if let Some(w) = child.warn_outside_primary(&window, item_duration_ms) {
            notices.push(format!("Child „{}\u{201c} von „{item_label}\u{201c}: {w}", child.id));
        }
        let prior = saved.and_then(|m| m.get(&child.id)).copied();
        let start_at = onair_since + Duration::from_millis(window.start_offset_ms);
        let mut runtime = ChildRuntime {
            item_id: item_id.to_string(),
            child: child.clone(),
            state: ChildState::Scheduled,
            start_offset_ms: window.start_offset_ms,
            stop_offset_ms: window.stop_offset_ms,
            until_primary_end: window.until_primary_end,
            attempt: 0,
            error: None,
            used_fallback: false,
        };
        let push_stop = |state: &mut AutomationState, at: Instant| {
            state.child_schedule.push(ScheduledChild {
                fire_at: at,
                item_id: item_id.to_string(),
                child_id: child.id.clone(),
                action: ChildAction::Stop,
            });
        };
        match prior {
            // Restart: Endzustände bleiben, ohne etwas auszuführen.
            Some(st) if st.is_terminal() => runtime.state = st,
            // Restart: lief schon — nur noch den geplanten Stopp nachziehen.
            Some(ChildState::Fired) | Some(ChildState::Active) => {
                runtime.state = ChildState::Active;
                if needs_stop(&child)
                    && let Some(stop) = window.stop_offset_ms
                {
                    push_stop(state, onair_since + Duration::from_millis(stop));
                }
            }
            // Restart: noch nicht gestartet, Startzeit aber verstrichen → nicht nachholen.
            Some(_) if window.start_offset_ms < elapsed_ms => {
                runtime.state = ChildState::Cancelled;
                notices.push(format!(
                    "Neustart: Child „{}\u{201c} von „{item_label}\u{201c} wurde während des Ausfalls verpasst — nicht nachgeholt",
                    child.id
                ));
            }
            _ => {
                state.child_schedule.push(ScheduledChild {
                    fire_at: start_at,
                    item_id: item_id.to_string(),
                    child_id: child.id.clone(),
                    action: ChildAction::Start { attempt: 0, use_fallback: false },
                });
                if let Some(stop) = window.stop_offset_ms
                    && needs_stop(&child)
                {
                    push_stop(state, onair_since + Duration::from_millis(stop));
                }
                // ARMED, sobald das Ziel auflösbar ist (sonst bleibt es SCHEDULED, Auflösung beim Start).
                if child_target_ok(state, &child) {
                    runtime.state = ChildState::Armed;
                }
            }
        }
        state.child_runtime.push(runtime);
    }
    notices
}

/// Ist das Ziel eines Kindes gerade auflösbar? (Preflight/ARMED; für Node-
/// Befehle gegen die zuletzt entdeckten Node-Labels, für Grafik gegen den
/// aufgelösten Grafik-Node, Webhooks sind immer „auflösbar“ — das Netz zeigt
/// sich erst beim Senden.)
fn child_target_ok(state: &AutomationState, child: &ChildEvent) -> bool {
    if child.kind.is_graphics() {
        state.graphics_node_id.is_some()
    } else if child.kind == ChildType::Subtitle {
        if child.target.trim().is_empty() {
            state.graphics_node_id.is_some()
        } else {
            state.discovered_labels.iter().any(|l| l == &child.target)
        }
    } else if child.kind == ChildType::Scte35 {
        state.discovered_labels.iter().any(|l| l == &child.target)
    } else if child.is_native_voiceover() {
        let label = if child.target.trim().is_empty() { &state.target_audio_mixer_label } else { &child.target };
        state.discovered_labels.iter().any(|l| l == label)
    } else if child.kind.is_node_command() {
        state.discovered_labels.iter().any(|l| l == &child.target)
    } else {
        true
    }
}

/// SCTE-35 (Kapitel 27 / P9.2): der Automator plant, `omp-scte35` kodiert. `action: out` →
/// `splice.out` (Dauer aus `params.durationMs` bzw. der Kind-Dauer), beim Stopp `splice.in` mit
/// derselben Event-ID (`returnAtStop`, Standard an); `action: signal` → `time_signal` mit
/// `typeId`, beim Stopp optional mit `endTypeId` (z. B. 0x34 Start → 0x35 Ende).
fn execute_scte35(store: &AutomationStore, child: &ChildEvent, stop: bool) -> Result<(), String> {
    let node_id = remote::resolve_node_id_by_label(&store.registry, &child.target).ok_or_else(|| format!("Ziel-Node „{}\u{201c} nicht gefunden", child.target))?;
    let client = store.proxy_client(node_id);
    let p = &child.params;
    let action = p.get("action").and_then(Value::as_str).unwrap_or("out");
    let key = format!("{}:{}", child.target, child.id);
    if !stop {
        // Eindeutige, über Start und Stopp stabile Event-ID (31 Bit) aus Kind-ID und Zeit.
        let id = (chrono::Utc::now().timestamp_millis() as u32 ^ child.id.bytes().fold(5381u32, |h, b| h.wrapping_mul(33) ^ b as u32)) & 0x7FFF_FFFF;
        store.scte35_events.lock().expect("lock poisoned").insert(key.clone(), id);
        let duration = p.get("durationMs").and_then(Value::as_u64).or((child.duration_ms > 0).then_some(child.duration_ms));
        return if action == "signal" {
            let mut args = serde_json::json!({"typeId": p["typeId"], "eventId": id});
            if let Some(d) = duration {
                args["durationMs"] = serde_json::json!(d);
            }
            if let Some(u) = p.get("upid") {
                args["upid"] = u.clone();
            }
            client.invoke("signal", args).map_err(|e| e.to_string())
        } else {
            let mut args = serde_json::json!({"eventId": id, "autoReturn": p.get("autoReturn").and_then(Value::as_bool).unwrap_or(true)});
            if let Some(d) = duration {
                args["durationMs"] = serde_json::json!(d);
            }
            client.invoke("splice.out", args).map_err(|e| e.to_string())
        };
    }
    let id = store.scte35_events.lock().expect("lock poisoned").remove(&key);
    let Some(id) = id else { return Ok(()) };
    if action == "signal" {
        match p.get("endTypeId") {
            Some(t) => client.invoke("signal", serde_json::json!({"typeId": t, "eventId": id})).map_err(|e| e.to_string()),
            None => Ok(()),
        }
    } else if p.get("returnAtStop").and_then(Value::as_bool).unwrap_or(true) {
        client.invoke("splice.in", serde_json::json!({"eventId": id})).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Voiceover (Kapitel 27 / P9, `voiceover.rs`): Ablaufplan gegen den Audiomischer. Eine höhere
/// Priorität verdrängt kein laufendes Voiceover, aber ein laufendes mit HÖHERER Priorität
/// blockiert den Start eines niedrigeren (Fehler → Fehlerrichtlinie des Kindes).
fn execute_voiceover(store: &AutomationStore, child: &ChildEvent, stop: bool) -> Result<(), String> {
    let vo = voiceover::Voiceover::parse(&child.params)?;
    let label = if child.target.trim().is_empty() {
        store.state.lock().expect("lock poisoned").target_audio_mixer_label.clone()
    } else {
        child.target.clone()
    };
    if label.trim().is_empty() {
        return Err("Voiceover: kein Audiomischer (target des Kindes oder targetAudioMixerLabel des Automators)".to_string());
    }
    let node_id = remote::resolve_node_id_by_label(&store.registry, &label).ok_or_else(|| format!("Ziel-Node „{label}\u{201c} nicht gefunden"))?;
    let client = store.proxy_client(node_id);
    let key = format!("{}:{}", label, vo.channel);
    if !stop {
        let mut active = store.voiceovers_active.lock().expect("lock poisoned");
        if let Some((_, p)) = active.iter().find(|(k, p)| *k != key && *p > vo.priority) {
            return Err(format!("Voiceover verdrängt: ein Voiceover mit höherer Priorität ({p}) läuft"));
        }
        active.retain(|(k, _)| *k != key);
        active.push((key.clone(), vo.priority));
    }
    let plan = if stop { vo.stop_plan() } else { vo.start_plan() };
    let mut first_err: Option<String> = None;
    for step in plan {
        if step.wait_ms > 0 {
            std::thread::sleep(Duration::from_millis(step.wait_ms));
        }
        if let Err(e) = client.invoke(&step.method, step.params.clone()) {
            // Beim Stoppen trotzdem alle Schritte versuchen (Kanal muss zu, Regel aus).
            first_err.get_or_insert_with(|| format!("{}: {e}", step.method));
            if !stop {
                break;
            }
        }
    }
    if stop || first_err.is_some() {
        store.voiceovers_active.lock().expect("lock poisoned").retain(|(k, _)| *k != key);
    }
    first_err.map_or(Ok(()), Err)
}

/// Führt Start oder Stopp eines Kindes aus (blockierend, `spawn_blocking`).
/// Knoten-agnostisch: Grafik → `show`/`hide` am Grafik-Node, sonst der in
/// `target`/`method` genannte Node-Befehl über denselben Proxy wie überall.
fn execute_child(
    store: &AutomationStore,
    child: &ChildEvent,
    graphics_node_id: Option<String>,
    use_fallback: bool,
    stop: bool,
) -> Result<(), String> {
    let obj = |v: &Value| if v.is_null() { serde_json::json!({}) } else { v.clone() };
    if child.kind.is_graphics() {
        let node_id = graphics_node_id.ok_or("kein Ziel-omp-ograf aufgelöst (targetGraphicsLabel)")?;
        let graphics = store.proxy_client(node_id);
        return if stop {
            graphics.invoke("hide", serde_json::json!({})).map_err(|e| e.to_string())
        } else {
            graphics
                .invoke("show", serde_json::json!({"templateId": child.template_id, "data": child.data}))
                .map_err(|e| e.to_string())
        };
    }
    if child.is_native_voiceover() {
        return execute_voiceover(store, child, stop);
    }
    if child.kind == ChildType::Scte35 {
        return execute_scte35(store, child, stop);
    }
    if child.kind == ChildType::Subtitle {
        // Untertitel-Engine im Grafik-Node: `target` = anderer Node, sonst der aufgelöste Grafik-Node.
        let node_id = if child.target.trim().is_empty() {
            graphics_node_id.ok_or("kein Ziel-omp-ograf aufgelöst (targetGraphicsLabel)")?
        } else {
            remote::resolve_node_id_by_label(&store.registry, &child.target).ok_or_else(|| format!("Ziel-Node „{}\u{201c} nicht gefunden", child.target))?
        };
        let client = store.proxy_client(node_id);
        return if stop {
            client.invoke("subtitle.stop", serde_json::json!({})).map_err(|e| e.to_string())
        } else {
            let mut args = serde_json::json!({"track": child.params["track"]});
            if let Some(o) = child.params.get("offsetMs") {
                args["offsetMs"] = o.clone();
            }
            client.invoke("subtitle.start", args).map_err(|e| e.to_string())
        };
    }
    if child.kind.is_node_command() {
        let method = if stop { child.stop_method.as_str() } else { child.method.as_str() };
        if method.is_empty() {
            return Ok(());
        }
        let label = if use_fallback && !child.fallback_target.is_empty() { &child.fallback_target } else { &child.target };
        let node_id = remote::resolve_node_id_by_label(&store.registry, label)
            .ok_or_else(|| format!("Ziel-Node „{label}\u{201c} nicht gefunden"))?;
        let params = if stop { obj(&child.stop_params) } else { obj(&child.params) };
        return store.proxy_client(node_id).invoke(method, params).map_err(|e| e.to_string());
    }
    if child.kind == ChildType::ChannelTrigger {
        if stop {
            return Ok(());
        }
        let p = &child.params;
        let text = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        return store
            .send_channel_trigger(
                &text("event"),
                p.get("target").cloned().unwrap_or(Value::Null),
                p.get("args").cloned().unwrap_or_else(|| serde_json::json!({})),
                &text("targetTime"),
                p.get("relativeOffsetMs").and_then(Value::as_i64).unwrap_or(0),
                &text("latePolicy"),
            )
            .map(|_| ());
    }
    if child.kind == ChildType::Webhook {
        if stop {
            return Ok(());
        }
        let body = obj(&child.params);
        return match ureq::post(&child.url)
            .config()
            .timeout_global(Some(Duration::from_secs(10)))
            .build()
            .send_json(body)
        {
            Ok(_) => Ok(()),
            Err(ureq::Error::StatusCode(code)) => Err(format!("Webhook antwortete mit Status {code}")),
            Err(e) => Err(format!("Webhook fehlgeschlagen: {e}")),
        };
    }
    Err(format!("{:?} wird nicht unterstützt", child.kind))
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
                name: "targetPlayerALabel".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: false,
            },
            ParamSpec {
                name: "targetPlayerBLabel".to_string(),
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
                name: "targetAudioMixerLabel".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: false,
            },
            ParamSpec { name: "audioRouting".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            // Kapitel 27 / P8: Preflight-Fenster (Minuten) und Standard-Filler des Channels.
            ParamSpec {
                name: "preflightWindowMin".to_string(),
                kind: ParamType::Number,
                unit: Some("min".to_string()),
                range: Some(Range::Number { min: 1.0, max: 240.0 }),
                readonly: false,
            },
            ParamSpec { name: "defaultFiller".to_string(), kind: ParamType::String, unit: None, range: None, readonly: false },
            // Kapitel 27 / P7: Protokoll der letzten Channel-Trigger (JSON-Array, neueste zuerst).
            ParamSpec { name: "triggerLog".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            // Kapitel 27 / P1b: Anbindung an die Domäne `playout` (s.
            // `persist.rs`) — reine Anzeige.
            // Kapitel 27 / P3: Lebenszyklus der Child Events (SCHEDULED…COMPLETED).
            ParamSpec {
                name: "childEvents".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            // Kapitel 27 / P2a: Wanduhr-Plan (UTC) mit Warnungen, s. `schedule.rs`.
            ParamSpec {
                name: "schedule".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "channelId".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "channelName".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            ParamSpec {
                name: "persistence".to_string(),
                kind: ParamType::String,
                unit: None,
                range: None,
                readonly: true,
            },
            // Kapitel 27 / P9.3: Zustand der Ereignis-Hooks (JSON).
            ParamSpec { name: "hookStatus".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
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
                name: "liveChannel".to_string(),
                kind: ParamType::Enum,
                unit: None,
                range: Some(Range::Enum { values: vec!["a".to_string(), "b".to_string()] }),
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
            // Kapitel 27 / A4 — Audio-Spiegel der Kanal-Player (JSON): `audioPlans` = {"a": Plan|null, "b": …},
            // `audioGroups` = Zielgruppen, `audioMappings` = wählbare Vorlagen [{id,label}].
            ParamSpec { name: "audioPlans".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "audioGroups".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
            ParamSpec { name: "audioMappings".to_string(), kind: ParamType::String, unit: None, range: None, readonly: true },
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
                    // Kapitel 27 / P2b: "image" | "hold" | "jump" (+ jumpTarget = Item-ID).
                    MethodArg {
                        name: "eventType".to_string(),
                        kind: ParamType::String,
                    },
                    MethodArg {
                        name: "jumpTarget".to_string(),
                        kind: ParamType::String,
                    },
                    // Kapitel 27 / P4c: Live-Quelle per Kriterien statt Sender-ID —
                    // JSON-Objekt (`omp-resolver::Selector`), z. B. {"required":["video.camera"],"preferred":["role.program"]}.
                    MethodArg {
                        name: "sourceSelectorJson".to_string(),
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
                    // Kapitel 27 / P2a: absoluter Start (RFC 3339 mit Offset),
                    // hat Vorrang vor fixtimeHms.
                    MethodArg {
                        name: "startAt".to_string(),
                        kind: ParamType::String,
                    },
                ],
            },
            // Panel: Drag & Drop (Position in der neuen Liste), Property-Editor (JSON-Patch), Cart ändern.
            MethodSpec {
                name: "moveItem".to_string(),
                args: vec![
                    MethodArg { name: "itemId".to_string(), kind: ParamType::String },
                    MethodArg { name: "toIndex".to_string(), kind: ParamType::Number },
                ],
            },
            MethodSpec {
                name: "updateItem".to_string(),
                args: vec![
                    MethodArg { name: "itemId".to_string(), kind: ParamType::String },
                    MethodArg { name: "patchJson".to_string(), kind: ParamType::String },
                ],
            },
            MethodSpec {
                name: "cart.update".to_string(),
                args: vec![
                    MethodArg { name: "assetId".to_string(), kind: ParamType::String },
                    MethodArg { name: "patchJson".to_string(), kind: ParamType::String },
                ],
            },
            // Kapitel 27 / P8: Event mit Asset-Referenz (Datei wird am Ziel-Player aufgelöst) und
            // nachträgliche Änderung von Asset/Ausfallrichtlinie/Ersatzdatei.
            MethodSpec {
                name: "appendAsset".to_string(),
                args: vec![
                    MethodArg { name: "label".to_string(), kind: ParamType::String },
                    MethodArg { name: "assetJson".to_string(), kind: ParamType::String },
                    MethodArg { name: "onMissing".to_string(), kind: ParamType::String },
                    MethodArg { name: "fallbackFile".to_string(), kind: ParamType::String },
                    MethodArg { name: "startType".to_string(), kind: ParamType::String },
                    MethodArg { name: "durationMs".to_string(), kind: ParamType::Number },
                ],
            },
            MethodSpec {
                name: "setMediaRef".to_string(),
                args: vec![
                    MethodArg { name: "itemId".to_string(), kind: ParamType::String },
                    MethodArg { name: "assetJson".to_string(), kind: ParamType::String },
                    MethodArg { name: "onMissing".to_string(), kind: ParamType::String },
                    MethodArg { name: "fallbackFile".to_string(), kind: ParamType::String },
                ],
            },
            // Kapitel 27 / P7: Trigger an andere Channels (vermittelt der Orchestrator: Rechte, Audit).
            // targetKind = channel|group|all, target = Name/ID/Gruppe (bei all leer).
            MethodSpec {
                name: "sendTrigger".to_string(),
                args: vec![
                    MethodArg { name: "event".to_string(), kind: ParamType::String },
                    MethodArg { name: "targetKind".to_string(), kind: ParamType::String },
                    MethodArg { name: "target".to_string(), kind: ParamType::String },
                    MethodArg { name: "argsJson".to_string(), kind: ParamType::String },
                    MethodArg { name: "targetTime".to_string(), kind: ParamType::String },
                    MethodArg { name: "relativeOffsetMs".to_string(), kind: ParamType::String },
                    MethodArg { name: "latePolicy".to_string(), kind: ParamType::String },
                ],
            },
            // Kapitel 27 / P5: Audio-Absicht eines Live-Items (JSON, `AudioIntent`).
            MethodSpec {
                name: "setAudio".to_string(),
                args: vec![
                    MethodArg { name: "itemId".to_string(), kind: ParamType::String },
                    MethodArg { name: "audioJson".to_string(), kind: ParamType::String },
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
                        if let ItemMedia::LiveSelect { selector } = &m.media {
                            let r = omp_resolver::resolve(&effective_selector(selector), &state.sources);
                            v["resolvedSenderId"] = serde_json::json!(r.selected_id);
                            v["resolvedLabel"] = serde_json::json!(
                                r.selected(&state.sources).map(|s| format!("{} / {}", s.node_label, s.label))
                            );
                            v["resolutionSummary"] = serde_json::json!(r.summary);
                            v["resolutionAmbiguous"] = serde_json::json!(r.ambiguous);
                        }
                        if let Some(a) = audio_view(&state, m) {
                            v["audio"] = a;
                        }
                        v["available"] =
                            serde_json::json!(item_is_available(m, &state.media_library, &state.available_sources, &state.sources));
                        if let Some(r) = state.readiness.get(id).filter(|_| m.media_ref.asset.is_some()) {
                            v["readiness"] = serde_json::json!(readiness::readiness_of(&r.state));
                            v["readinessState"] = serde_json::json!(r.state);
                            v["readinessDetail"] = serde_json::json!(r.detail);
                            v["readinessProgress"] = serde_json::json!(r.progress);
                            v["readinessEstimateS"] = serde_json::json!(r.estimate_s);
                        } else if m.media_ref.asset.is_some() {
                            v["readiness"] = serde_json::json!(readiness::Readiness::Unknown);
                        }
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
            "targetPlayerALabel" => Some(serde_json::json!(state.target_player_a_label)),
            "targetPlayerBLabel" => Some(serde_json::json!(state.target_player_b_label)),
            "targetMixerLabel" => Some(serde_json::json!(state.target_mixer_label)),
            "targetGraphicsLabel" => Some(serde_json::json!(state.target_graphics_label)),
            "targetAudioMixerLabel" => Some(serde_json::json!(state.target_audio_mixer_label)),
            "audioRouting" => Some(serde_json::json!(self.audio_status.lock().expect("lock poisoned").clone())),
            "preflightWindowMin" => Some(serde_json::json!(state.preflight_window_min)),
            "defaultFiller" => Some(serde_json::json!(state.default_filler)),
            "triggerLog" => Some(Value::Array(self.trigger_log.lock().expect("lock poisoned").iter().cloned().collect())),
            "schedule" => Some(schedule_json(&state, chrono::Utc::now().timestamp_millis())),
            "childEvents" => Some(child_events_json(&state)),
            "channelId" => Some(serde_json::json!(self.persistence.channel_id())),
            "channelName" => Some(serde_json::json!(self.persistence.channel_name())),
            "persistence" => Some(serde_json::json!(self.persistence.status())),
            "hookStatus" => Some(hooks::status_json(&self.plugins)),
            // Kapitel 6 Teil 7: welcher Kanal gerade live ist — reine
            // Anzeige fürs UI (z. B. um die aktive Kanal-Kachel optisch
            // hervorzuheben), keine Bedienmöglichkeit über diesen Node
            // (der Kanalwechsel läuft ausschließlich über take()/advance()).
            "liveChannel" => Some(serde_json::json!(match state.live_channel {
                Channel::A => "a",
                Channel::B => "b",
            })),
            "connected" => Some(serde_json::json!(
                state.player_a_node_id.is_some() && state.player_b_node_id.is_some() && state.mixer_node_id.is_some()
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
            "audioPlans" => Some(serde_json::json!({"a": state.audio_plan_a, "b": state.audio_plan_b})),
            "audioGroups" => Some(state.audio_groups.clone()),
            "audioMappings" => Some(state.audio_mappings.clone()),
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
            "targetPlayerALabel" => {
                state.target_player_a_label = value.as_str().unwrap_or_default().to_string();
                // Sofort invalidieren statt bis zum nächsten 2s-Discovery-
                // Tick zu warten — ein `take()` unmittelbar nach dem
                // Umkonfigurieren soll nicht den alten Kanal treffen.
                state.player_a_node_id = None;
                Ok(())
            }
            "targetPlayerBLabel" => {
                state.target_player_b_label = value.as_str().unwrap_or_default().to_string();
                state.player_b_node_id = None;
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
            "preflightWindowMin" => {
                let v = value.as_f64().ok_or(SetError::Unknown)?;
                if !(1.0..=240.0).contains(&v) {
                    return Err(SetError::Unknown);
                }
                state.preflight_window_min = v as u32;
                Ok(())
            }
            "defaultFiller" => {
                state.default_filler = value.as_str().unwrap_or_default().trim().to_string();
                Ok(())
            }
            "targetAudioMixerLabel" => {
                state.target_audio_mixer_label = value.as_str().unwrap_or_default().to_string();
                state.audio_mixer_node_id = None;
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
                let event_type = args.get("eventType").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
                let jump_target = args.get("jumpTarget").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
                // Kapitel 27 / P4c: Live-Quelle per Kriterien (JSON-Objekt als String).
                let live_selector = match args.get("sourceSelectorJson").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    Some(j) => match serde_json::from_str::<omp_resolver::Selector>(j) {
                        Ok(sel) => Some(sel),
                        Err(e) => return Err(InvokeError::Message(format!("sourceSelectorJson ungültig: {e}"))),
                    },
                    None => None,
                };
                self.do_append(label, pattern, file, sender_id, tone_frequency, duration_ms, start_type, event_type, jump_target, live_selector)
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
                let fixtime_hms = args.get("fixtimeHms").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
                let start_at = match args.get("startAt").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    Some(s) => match schedule::parse_start_at(s) {
                        Some(ms) => Some(ms),
                        None => {
                            return Err(InvokeError::Message(format!(
                                "startAt „{s}\u{201c} ungültig (RFC 3339, z. B. 2026-10-02T10:00:00+02:00)"
                            )));
                        }
                    },
                    None => None,
                };
                match (item_id, start_type) {
                    (Some(id), Some(st)) => self.do_set_start_type(id, st, fixtime_hms, start_at),
                    (None, _) => Err("itemId fehlt".to_string()),
                    (_, None) => Err("startType fehlt oder ungültig (sequence|manual|fixtime)".to_string()),
                }
            }
            "moveItem" => (|| {
                let item_id = args.get("itemId").and_then(Value::as_str).ok_or("itemId fehlt".to_string())?;
                let to = args.get("toIndex").and_then(Value::as_f64).filter(|n| *n >= 0.0).ok_or("toIndex fehlt".to_string())? as usize;
                self.do_move_item(item_id, to)
            })(),
            "updateItem" => (|| {
                let item_id = args.get("itemId").and_then(Value::as_str).ok_or("itemId fehlt".to_string())?;
                let patch: Value = serde_json::from_str(args.get("patchJson").and_then(Value::as_str).unwrap_or("{}"))
                    .map_err(|e| format!("patchJson ungültig: {e}"))?;
                self.do_update_item(item_id, &patch)
            })(),
            "cart.update" => (|| {
                let id = args.get("assetId").and_then(Value::as_str).ok_or("assetId fehlt".to_string())?;
                let patch: Value = serde_json::from_str(args.get("patchJson").and_then(Value::as_str).unwrap_or("{}"))
                    .map_err(|e| format!("patchJson ungültig: {e}"))?;
                self.do_cart_update(id, &patch)
            })(),
            "appendAsset" => (|| {
                let text = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
                let asset: readiness::AssetRef =
                    serde_json::from_str(&text("assetJson")).map_err(|e| format!("assetJson ungültig: {e}"))?;
                if asset.asset_id.is_empty() {
                    return Err("assetJson braucht assetId".to_string());
                }
                let on_missing = match text("onMissing").as_str() {
                    "" => readiness::MissingPolicy::default(),
                    p => readiness::MissingPolicy::parse(p).ok_or_else(|| format!("onMissing „{p}\u{201c} unbekannt (HOLD/STOP/SKIP/BLACK/FALLBACK/DEFAULT_FILLER)"))?,
                };
                let fallback = Some(text("fallbackFile")).filter(|f| !f.is_empty());
                let player = self.state.lock().expect("lock poisoned").target_player_a_label.clone();
                let file = resolve_asset_file(self, &player, &asset)?;
                let label = Some(text("label")).filter(|l| !l.is_empty()).unwrap_or_else(|| file.clone());
                let start_type = args.get("startType").and_then(Value::as_str).and_then(StartType::parse);
                let duration_ms = args.get("durationMs").and_then(Value::as_f64).filter(|d| *d > 0.0).map(|d| d as u64);
                self.do_append(label, None, Some(file), None, None, duration_ms, start_type, None, None, None)?;
                let mut st = self.state.lock().expect("lock poisoned");
                let id = format!("item{}", st.next_item_seq);
                if let Some(m) = st.metadata.get_mut(&id) {
                    m.media_ref = readiness::MediaRef { asset: Some(asset), on_missing, fallback_file: fallback, ..m.media_ref.clone() };
                }
                Ok(())
            })(),
            "setMediaRef" => (|| {
                let text = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
                let item_id = text("itemId");
                let json = text("assetJson");
                let asset: Option<readiness::AssetRef> = if json.is_empty() || json == "null" {
                    None
                } else {
                    let a: readiness::AssetRef = serde_json::from_str(&json).map_err(|e| format!("assetJson ungültig: {e}"))?;
                    if a.asset_id.is_empty() { None } else { Some(a) }
                };
                let on_missing = match text("onMissing").as_str() {
                    "" => readiness::MissingPolicy::default(),
                    p => readiness::MissingPolicy::parse(p).ok_or_else(|| format!("onMissing „{p}\u{201c} unbekannt"))?,
                };
                let fallback = Some(text("fallbackFile")).filter(|f| !f.is_empty());
                let mut st = self.state.lock().expect("lock poisoned");
                let m = st.metadata.get_mut(&item_id).ok_or("unbekannte itemId".to_string())?;
                m.media_ref = readiness::MediaRef { asset, on_missing, fallback_file: fallback, ..m.media_ref.clone() };
                st.readiness.remove(&item_id);
                Ok(())
            })(),
            "sendTrigger" => (|| {
                let text = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
                let kind = text("targetKind");
                let target = text("target");
                let target_obj = match kind.as_str() {
                    "channel" if !target.is_empty() => serde_json::json!({"channel": target}),
                    "group" if !target.is_empty() => serde_json::json!({"group": target}),
                    "all" => serde_json::json!({"all": true}),
                    _ => return Err("targetKind muss channel, group oder all sein (channel/group brauchen target)".to_string()),
                };
                let args_json = text("argsJson");
                let args_val: Value = if args_json.is_empty() { serde_json::json!({}) } else {
                    serde_json::from_str(&args_json).map_err(|e| format!("argsJson ungültig: {e}"))?
                };
                let offset: i64 = match text("relativeOffsetMs").as_str() {
                    "" => 0,
                    v => v.parse().map_err(|_| "relativeOffsetMs muss eine ganze Zahl sein".to_string())?,
                };
                self.send_channel_trigger(&text("event"), target_obj, args_val, &text("targetTime"), offset, &text("latePolicy")).map(|_| ())
            })(),
            "setAudio" => (|| {
                let item_id = args.get("itemId").and_then(Value::as_str).ok_or("itemId fehlt".to_string())?;
                let json = args.get("audioJson").and_then(Value::as_str).unwrap_or("").trim();
                // Leer/„null“/„{}“ löscht die Absicht (zurück zu Quell-Default).
                let intent: Option<omp_resolver::audio::AudioIntent> = if json.is_empty() || json == "null" {
                    None
                } else {
                    let i: omp_resolver::audio::AudioIntent =
                        serde_json::from_str(json).map_err(|e| format!("audioJson ungültig: {e}"))?;
                    if i == omp_resolver::audio::AudioIntent::default() { None } else { Some(i) }
                };
                self.do_set_audio(item_id, intent)
            })(),
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
                let children: Vec<ChildEvent> = serde_json::from_str(children_json)
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

        if result.is_ok()
            && matches!(
                name,
                "append" | "appendAsset" | "load" | "remove" | "moveItem" | "updateItem" | "setStartType" | "setTransition" | "setAudio" | "setChildren" | "setMediaRef"
            )
        {
            hooks::fire("playlistEvent", serde_json::json!({ "method": name, "channelId": structlog::current_channel(), "args": Value::Object(args.clone()) }));
        }
        result.map_err(|e| {
            self.report(e.clone());
            InvokeError::Message(e)
        })
    }

    fn plugins(&self) -> Option<&omp_node_sdk::PluginRegistry> {
        Some(&self.plugins)
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
    /// `{"ok":true}` zurück, kein Datenergebnis; ein Parameter
    /// (`GET /params/<name>`)
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

/// Löst `targetPlayerALabel`/`targetPlayerBLabel`/`targetMixerLabel`
/// periodisch neu auf (gleiches 2s-Poll-Muster wie `omp-switcher`/
/// `omp-video-mixer-me`s Sender-Discovery, C7/C10) — macht die Ziel-
/// Auflösung selbstheilend (ein neu gestarteter Ziel-Node mit neuem
/// `href` wird automatisch wieder gefunden), nicht nur einmalig beim
/// Setzen des Labels.
async fn discovery_loop(store: Arc<AutomationStore>) {
    let mut interval = tokio::time::interval(DISCOVERY_INTERVAL);
    loop {
        interval.tick().await;
        let audio_label = store.state.lock().expect("lock poisoned").target_audio_mixer_label.clone();
        let (player_a_label, player_b_label, mixer_label, graphics_label) = {
            let state = store.state.lock().expect("lock poisoned");
            (
                state.target_player_a_label.clone(),
                state.target_player_b_label.clone(),
                state.target_mixer_label.clone(),
                state.target_graphics_label.clone(),
            )
        };
        let registry = store.registry.clone();
        let own_label = store.own_label.clone();
        let (orch_url, orch_auth) = (store.orchestrator_url.clone(), store.auth.clone());
        let resolved = tokio::task::spawn_blocking(move || {
            // Node-Liste vom Orchestrator (kennt alle Hosts); die lokale Registry nur als Rückfall — auf einem
            // anderen Host kennt sie oft nur die eigenen Nodes, Player/Mischer anderer Hosts fehlten sonst.
            let index = remote::fetch_node_index(&orch_url, &orch_auth).unwrap_or_else(|_| remote::node_index_from_registry(&registry));
            (
                index.resolve(&player_a_label),
                index.resolve(&player_b_label),
                index.resolve(&mixer_label),
                // Kapitel 6 Teil 5: `resolve_node_id_by_label` gibt bei
                // leerem Label ohnehin `None` zurück (eigener Guard dort)
                // — der Kurzschluss hier spart nur den sonst unnötigen
                // `list_nodes()`-Registry-Aufruf alle 2s im (erwartet
                // häufigen) Fall "kein Grafik-Ziel konfiguriert".
                if graphics_label.is_empty() {
                    None
                } else {
                    index.resolve(&graphics_label)
                },
                index.labels(&own_label),
                if audio_label.is_empty() { None } else { index.resolve(&audio_label) },
            )
        })
        .await;
        if let Ok((player_a_node_id, player_b_node_id, mixer_node_id, graphics_node_id, discovered_labels, audio_mixer_node_id)) =
            resolved
        {
            let mut state = store.state.lock().expect("lock poisoned");
            state.player_a_node_id = player_a_node_id;
            state.player_b_node_id = player_b_node_id;
            state.mixer_node_id = mixer_node_id;
            state.graphics_node_id = graphics_node_id;
            state.audio_mixer_node_id = audio_mixer_node_id;
            state.discovered_labels = discovered_labels;
        }

        // Rundown-Echtmedien-Folgeschritt: `mediaLibrary`/`availableSources`
        // spiegeln — im selben Tick statt in einem eigenen Intervall,
        // gleiche Kadenz wie die übrige Ziel-Discovery. Best effort:
        // schlägt der Fernaufruf fehl (Kanal kurz nicht erreichbar),
        // bleibt der zuletzt bekannte Stand einfach bis zum nächsten Tick
        // stehen. Kapitel 6 Teil 7: absichtlich nur Kanal A (s.
        // `AutomationState::media_library`-Doku, warum ein zweiter Poll
        // von Kanal B redundant wäre).
        // Kapitel 27 / P4c: Quellen mit Tags vom Orchestrator spiegeln (Anzeige
        // „aufgelöst zu …“, Verfügbarkeit von LiveSelect-Items). Best effort.
        {
            let (url, auth) = (store.orchestrator_url.clone(), store.auth.clone());
            if let Ok(Ok(sources)) = tokio::task::spawn_blocking(move || remote::fetch_sources(&url, &auth)).await {
                store.state.lock().expect("lock poisoned").sources = sources;
            }
        }
        let player_a_node_id_for_media = {
            store.state.lock().expect("lock poisoned").player_a_node_id.clone()
        };
        match player_a_node_id_for_media {
            Some(player_a_node_id) => {
                let store2 = store.clone();
                let fetched = tokio::task::spawn_blocking(move || {
                    let player = store2.proxy_client(player_a_node_id);
                    (
                        player.get_param("mediaLibrary"),
                        player.get_param("availableSources"),
                        player.get_param("audioPlan"),
                        player.get_param("audioGroups"),
                        player.get_param("audioMappings"),
                    )
                })
                .await;
                if let Ok((media_library, available_sources, audio_plan, audio_groups, audio_mappings)) = fetched {
                    let mut state = store.state.lock().expect("lock poisoned");
                    state.audio_plan_a = audio_plan.unwrap_or(Value::Null);
                    if let Ok(g) = audio_groups {
                        state.audio_groups = g;
                    }
                    if let Ok(m) = audio_mappings {
                        state.audio_mappings = m;
                    }
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
                // Kanal A nicht aufgelöst (z. B. `targetPlayerALabel`
                // gerade umkonfiguriert/offline) — Angebote leeren, sonst
                // böte das UI Quellen eines gar nicht mehr angesprochenen
                // Kanals an.
                let mut state = store.state.lock().expect("lock poisoned");
                state.media_library.clear();
                state.available_sources.clear();
                state.audio_plan_a = Value::Null;
            }
        }
        // Audio-Plan von Kanal B (Kanal A wird oben mitgeholt).
        let player_b_node_id_for_plan = store.state.lock().expect("lock poisoned").player_b_node_id.clone();
        let plan_b = match player_b_node_id_for_plan {
            Some(id) => {
                let store2 = store.clone();
                tokio::task::spawn_blocking(move || store2.proxy_client(id).get_param("audioPlan").unwrap_or(Value::Null)).await.unwrap_or(Value::Null)
            }
            None => Value::Null,
        };
        store.state.lock().expect("lock poisoned").audio_plan_b = plan_b;
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

        // Kapitel 27 / P8: Ausfallrichtlinie STOP hat den Automatikmodus angefordert → Hold.
        if store.request_hold.swap(false, std::sync::atomic::Ordering::SeqCst) {
            store.state.lock().expect("lock poisoned").playlist.set_mode(Mode::Hold);
        }

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
/// Items mit Asset-Referenz innerhalb der ersten Positionen der Playlist samt geplanter Sendezeit (UTC-ms,
/// `None` = manuell/unbekannt). Spec §72: nur was im Preflight-Fenster liegt (oder als Nächstes drankommt).
fn upcoming_asset_items(state: &AutomationState, now_ms: i64) -> Vec<(String, readiness::AssetRef, Option<i64>)> {
    let from = state.playlist.current_index().unwrap_or(0);
    let base = match (state.playlist.on_air(), state.onair_since) {
        (true, Some(since)) => now_ms - since.elapsed().as_millis() as i64,
        _ => now_ms,
    };
    let inputs: Vec<schedule::PlanInput> = state
        .playlist
        .items()
        .iter()
        .skip(from)
        .take(SCHEDULE_MAX_ENTRIES)
        .filter_map(|id| {
            state.metadata.get(id).map(|m| schedule::PlanInput {
                id: id.clone(),
                duration_ms: m.duration_ms,
                anchor_utc_ms: if m.start_type == StartType::Fixtime { m.start_at_utc_ms } else { None },
                manual: m.start_type == StartType::Manual,
            })
        })
        .collect();
    let entries = schedule::plan(&inputs, base);
    entries
        .iter()
        .filter_map(|e| {
            let asset = state.metadata.get(&e.id)?.media_ref.asset.clone()?;
            Some((e.id.clone(), asset, e.start_ms))
        })
        .collect()
}

/// Kapitel 27 / P8: prüft alle 5 s die Medien der anstehenden Events, stößt die Bereitstellung rechtzeitig an
/// (Spec §71) und hält die Bereitschaft je Item fest. Läuft vollständig asynchron zum Playout-Takt (Spec §182):
/// Prozesse laufen im Orchestrator, hier wird nur gefragt und angestoßen — ein Fehler macht das Event „NOT_READY“,
/// nie den Takt kaputt (Spec §183).
async fn preflight_loop(store: Arc<AutomationStore>) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    loop {
        interval.tick().await;
        let now_ms = chrono::Utc::now().timestamp_millis();
        let (items, labels, window_ms, channel) = {
            let state = store.state.lock().expect("lock poisoned");
            let mut labels: Vec<String> = [&state.target_player_a_label, &state.target_player_b_label]
                .into_iter()
                .filter(|l| !l.is_empty())
                .cloned()
                .collect();
            labels.dedup();
            (upcoming_asset_items(&state, now_ms), labels, state.preflight_window_min as i64 * 60_000, store.persistence.channel_id())
        };
        if items.is_empty() || labels.is_empty() || channel.is_empty() {
            let mut state = store.state.lock().expect("lock poisoned");
            if items.is_empty() {
                state.readiness.clear();
            }
            continue;
        }
        let store2 = store.clone();
        let items2: Vec<(String, readiness::AssetRef)> = items.iter().map(|(id, a, _)| (id.clone(), a.clone())).collect();
        let (labels2, channel2) = (labels.clone(), channel.clone());
        // Ergebnisse je (Item, Ziel-Player): schlechtester Zustand gewinnt.
        let checked = tokio::task::spawn_blocking(move || {
            let mut per_item: HashMap<String, Vec<(String, Value)>> = HashMap::new();
            let mut error = None;
            for label in &labels2 {
                match preflight_request(&store2, &channel2, label, &items2) {
                    Ok(entries) => {
                        for e in entries {
                            if let Some(k) = e.get("key").and_then(Value::as_str) {
                                per_item.entry(k.to_string()).or_default().push((label.clone(), e.clone()));
                            }
                        }
                    }
                    Err(e) => error = Some(e),
                }
            }
            (per_item, error)
        })
        .await;
        let Ok((per_item, error)) = checked else { continue };
        if let Some(e) = error {
            report_throttled(&store, format!("Preflight nicht erreichbar: {e}"));
        }
        let rank = |s: &str| match s {
            "READY" => 0,
            "TRANSFERRING" => 1,
            "REMOTE_ONLY" => 2,
            "FAILED" => 3,
            "MISSING" => 4,
            _ => 5,
        };
        for (id, asset, start_ms) in items {
            let Some(results) = per_item.get(&id) else { continue };
            let worst = results.iter().max_by_key(|(_, e)| rank(e.get("state").and_then(Value::as_str).unwrap_or(""))).cloned();
            let Some((_, worst)) = worst else { continue };
            let st = worst.get("state").and_then(Value::as_str).unwrap_or("").to_string();
            let mut entry = {
                let state = store.state.lock().expect("lock poisoned");
                state.readiness.get(&id).cloned().unwrap_or_default()
            };
            entry.state = st.clone();
            entry.detail = worst.get("detail").and_then(Value::as_str).unwrap_or("").to_string();
            entry.progress = worst.get("progress").and_then(Value::as_f64).unwrap_or(0.0);
            entry.estimate_s = worst.get("estimateSeconds").and_then(Value::as_f64).unwrap_or(0.0);
            entry.checked_ms = now_ms;
            if st == "READY" {
                entry.materializing = false;
                entry.warned_late = false;
            }
            // Noch nicht lokal, aber bereitstellbar: Zeitpunkt nach Spec §71 berechnen und ggf. anstoßen.
            if st == "REMOTE_ONLY" || (st == "FAILED" && worst.get("materializable").and_then(Value::as_bool).unwrap_or(false)) {
                let materializable = worst.get("materializable").and_then(Value::as_bool).unwrap_or(false);
                if materializable {
                    let estimate_ms = (entry.estimate_s * 1000.0) as i64;
                    // Ohne feste Startzeit (manuell): sofort bereitstellen, sobald das Event in Reichweite ist.
                    let plan = match start_ms {
                        Some(at) => readiness::plan_materialization(now_ms, at, estimate_ms, readiness::DEFAULT_SAFETY_MARGIN_MS, window_ms),
                        None => readiness::Plan::Start,
                    };
                    if !matches!(plan, readiness::Plan::Wait) && !(st == "FAILED" && entry.materializing && now_ms - entry.checked_ms < 30_000) {
                        let targets: Vec<String> = results
                            .iter()
                            .filter(|(_, e)| e.get("state").and_then(Value::as_str) != Some("READY"))
                            .map(|(l, _)| l.clone())
                            .collect();
                        let (s3, ch3, a3, id3) = (store.clone(), channel.clone(), asset.clone(), id.clone());
                        let r = tokio::task::spawn_blocking(move || {
                            targets.iter().map(|l| (l.clone(), materialize_request(&s3, &ch3, l, &id3, &a3))).collect::<Vec<_>>()
                        })
                        .await;
                        if let Ok(rs) = r {
                            for (label, res) in rs {
                                match res {
                                    Ok(_) => entry.materializing = true,
                                    Err(e) => report_throttled(&store, format!("Bereitstellung für Event „{id}\u{201c} auf „{label}\u{201c} nicht gestartet: {e}")),
                                }
                            }
                        }
                        if let readiness::Plan::StartLate { short_by_ms } = plan
                            && !entry.warned_late
                        {
                            entry.warned_late = true;
                            store.state.lock().expect("lock poisoned").asrun.warning(
                                chrono::Utc::now().timestamp_millis(),
                                "asset_preflight",
                                &id,
                                &id,
                                &format!("Bereitstellung wird voraussichtlich {} s zu spät fertig", short_by_ms / 1000),
                            );
                            report_throttled(&store, format!("Event „{id}\u{201c}: Bereitstellung wird voraussichtlich {} s zu spät fertig (Sendezeit zu nah) — Ausfallrichtlinie greift bei Bedarf", short_by_ms / 1000));
                        }
                    }
                }
            }
            store.state.lock().expect("lock poisoned").readiness.insert(id, entry);
        }
        // Einträge für Items, die nicht mehr vorne in der Liste stehen, verfallen.
        let ids: std::collections::HashSet<String> = per_item.keys().cloned().collect();
        store.state.lock().expect("lock poisoned").readiness.retain(|k, _| ids.contains(k));
    }
}

/// Kapitel 27 / P7: abonniert `omp.channel.<channelId>.trigger` und führt eingehende Channel-Trigger aus.
/// Wartet, bis die Persistenz den eigenen Channel kennt; folgt einem Channel-Wechsel (neu abonnieren).
async fn trigger_loop(store: Arc<AutomationStore>, nats_url: String) {
    use futures_util::StreamExt;
    let tls = omp_node_sdk::health::NatsTlsConfig::from_env();
    loop {
        let channel = store.persistence.channel_id();
        if channel.is_empty() {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        }
        let mut opts = async_nats::ConnectOptions::new().retry_on_initial_connect().max_reconnects(None).name("omp-playout-trigger");
        if let Some(ca) = &tls.ca_file {
            opts = opts.add_root_certificates(ca.into());
        }
        if let (Some(cert), Some(key)) = (&tls.cert_file, &tls.key_file) {
            opts = opts.add_client_certificate(cert.into(), key.into()).require_tls(true);
        }
        let addrs: Vec<String> = nats_url.split(',').map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()).collect();
        let client = match opts.connect(addrs).await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("omp-playout-automation: NATS-Verbindung für Channel-Trigger fehlgeschlagen: {e}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        let subject = format!("omp.channel.{channel}.trigger");
        let mut sub = match client.subscribe(subject.clone()).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("omp-playout-automation: Abo {subject} fehlgeschlagen: {e}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        let mut recheck = tokio::time::interval(Duration::from_secs(5));
        loop {
            tokio::select! {
                msg = sub.next() => {
                    let Some(msg) = msg else { break };
                    match serde_json::from_slice::<trigger::Envelope>(&msg.payload) {
                        Ok(env) => { tokio::spawn(handle_trigger(store.clone(), env, channel.clone())); }
                        Err(e) => eprintln!("omp-playout-automation: ungültiger Trigger auf {subject}: {e}"),
                    }
                }
                _ = recheck.tick() => {
                    if store.persistence.channel_id() != channel { break; }
                }
            }
        }
    }
}

/// Quittiert einen Trigger beim Orchestrator (best effort; bei Ausfall wiederholt der Orchestrator die
/// Zustellung und die Deduplizierung quittiert dann als Duplikat).
async fn ack_trigger(store: &Arc<AutomationStore>, channel: &str, id: &str, status: &str, detail: String) {
    let (url, auth) = (store.orchestrator_url.clone(), store.auth.clone());
    let (ch, tid, st) = (channel.to_string(), id.to_string(), status.to_string());
    let result = tokio::task::spawn_blocking(move || {
        remote::post_json(&url, &auth, &format!("/api/v1/playout/channels/{ch}/trigger-ack"), &serde_json::json!({"id": tid, "status": st, "detail": detail}))
    })
    .await;
    match result {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => eprintln!("omp-playout-automation: Quittung für Trigger {id} fehlgeschlagen: {e}"),
        Err(e) => eprintln!("omp-playout-automation: Quittungs-Task abgestürzt: {e}"),
    }
}

async fn handle_trigger(store: Arc<AutomationStore>, env: trigger::Envelope, channel: String) {
    let now = chrono::Utc::now().timestamp_millis();
    let log = |status: &str, detail: &str| {
        store.log_trigger(serde_json::json!({
            "at": chrono::Utc::now().timestamp_millis(), "direction": "in", "event": env.event, "origin": env.origin_channel,
            "id": env.id, "correlationId": env.correlation_id, "status": status, "detail": detail,
        }));
    };
    let decision = trigger::decide(&env, &channel, now);
    if let trigger::Decision::Reject(reason) = &decision {
        log("rejected", reason);
        ack_trigger(&store, &channel, &env.id, "rejected", reason.clone()).await;
        return;
    }
    // Deduplizierung über das Ausführungsjournal (at-most-once, auch über Neustarts hinweg).
    let key = trigger::journal_key(&env);
    let s2 = store.clone();
    let (claim, warn) = tokio::task::spawn_blocking(move || s2.persistence.claim_execution(&key, "trigger"))
        .await
        .unwrap_or((persist::Claim::Proceed, Some("Journal-Task abgestürzt".to_string())));
    if let Some(w) = warn {
        eprintln!("omp-playout-automation: {w}");
    }
    if claim == persist::Claim::AlreadyDone {
        log("duplicate", "bereits angenommen");
        ack_trigger(&store, &channel, &env.id, "applied", "Duplikat — bereits zuvor angenommen".to_string()).await;
        return;
    }
    match decision {
        trigger::Decision::Skip { late_ms } => {
            let d = format!("{late_ms} ms verspätet, Policy SKIP");
            log("skipped_late", &d);
            ack_trigger(&store, &channel, &env.id, "skipped_late", d).await;
        }
        trigger::Decision::Execute { wait_ms, late_ms, resync } => {
            if wait_ms > 0 {
                let d = format!("Ausführung in {wait_ms} ms (Zielzeit)");
                log("scheduled", &d);
                ack_trigger(&store, &channel, &env.id, "scheduled", d).await;
                tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            }
            let _gate = store.trigger_gate.lock().await;
            let s3 = store.clone();
            let env2 = env.clone();
            let res = tokio::task::spawn_blocking(move || s3.apply_trigger_event(&env2)).await.unwrap_or_else(|e| Err(format!("abgestürzt: {e}")));
            match res {
                Ok(msg) => {
                    let (status, detail) = if late_ms > 0 {
                        ("applied_late", format!("{msg} — {late_ms} ms verspätet{}", if resync { " (RESYNC: Versatz gemeldet)" } else { "" }))
                    } else {
                        ("applied", msg)
                    };
                    log(status, &detail);
                    ack_trigger(&store, &channel, &env.id, status, detail).await;
                }
                Err(e) => {
                    log("failed", &e);
                    ack_trigger(&store, &channel, &env.id, "failed", e).await;
                }
            }
        }
        trigger::Decision::Reject(_) => unreachable!("oben behandelt"),
    }
}

async fn fixtime_loop(store: Arc<AutomationStore>, events: mpsc::UnboundedSender<Event>) {
    let mut interval = tokio::time::interval(FIXTIME_TICK);
    loop {
        interval.tick().await;
        let now_secs = seconds_since_midnight_local();
        let now_utc_secs = chrono::Utc::now().timestamp();

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
                // P2a: absolute UTC-Zeit (Datum, DST-sicher) hat Vorrang;
                // sonst der dateilose HH:MM:SS-Altbestand gegen die lokale Uhr.
                let (now_cmp, target_secs) = if let Some(ms) = meta.start_at_utc_ms {
                    (now_utc_secs, ms.div_euclid(1000))
                } else if let Some(t) = meta.fixtime_hms.as_deref().and_then(parse_hms_to_secs) {
                    (now_secs, t)
                } else {
                    continue;
                };
                let already = state.fixtime_resolved.get(id).copied();
                match fixtime_action(now_cmp, target_secs, already) {
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
            // Kapitel 27 / P1b: VOR dem Feuern ins Ausführungsjournal der
            // Domäne `playout` eintragen (at-most-once über Neustarts
            // hinweg, `persist::Persistence::claim_execution`-Doku). Key =
            // Item-ID + Fixtime + UTC-Datum.
            let exec_key = {
                let state = store.state.lock().expect("lock poisoned");
                match state.metadata.get(&id).and_then(|m| m.start_at_utc_ms) {
                    // Absolut: der Zeitpunkt selbst ist der Schlüssel (kein Datum nötig).
                    Some(ms) => format!("fixtime:{id}:at:{ms}"),
                    None => format!(
                        "fixtime:{id}:{}:{}",
                        state.metadata.get(&id).and_then(|m| m.fixtime_hms.clone()).unwrap_or_default(),
                        chrono::Utc::now().format("%Y-%m-%d")
                    ),
                }
            };
            let store3 = store.clone();
            let (claim, warn) =
                tokio::task::spawn_blocking(move || store3.persistence.claim_execution(&exec_key, "fixtime"))
                    .await
                    .unwrap_or((persist::Claim::Proceed, Some("Journal-Task abgestürzt".to_string())));
            if let Some(w) = warn {
                let _ = events.send(Event::Error(w));
            }
            if claim == persist::Claim::AlreadyDone {
                store.state.lock().expect("lock poisoned").fixtime_resolved.insert(id.clone(), FixtimeResolution::Fired);
                let _ = events.send(Event::Error(format!(
                    "Fixtime-Event „{id}\u{201c} laut Ausführungsjournal bereits ausgeführt — nicht erneut gefeuert"
                )));
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
async fn child_loop(store: Arc<AutomationStore>, events: mpsc::UnboundedSender<Event>) {
    let mut interval = tokio::time::interval(GRAPHICS_TICK);
    loop {
        interval.tick().await;
        let now = Instant::now();

        // Fällige Befehle einsammeln, nach `fire_at` sortiert (ein Start muss
        // vor seinem eigenen Stopp laufen, auch wenn beide überfällig sind).
        let due: Vec<(ScheduledChild, ChildEvent, Option<String>, i64)> = {
            let mut state = store.state.lock().expect("lock poisoned");
            let mut due_events = Vec::new();
            state.child_schedule.retain(|ev| {
                if ev.fire_at <= now {
                    due_events.push(ev.clone());
                    false
                } else {
                    true
                }
            });
            due_events.sort_by_key(|ev| ev.fire_at);
            let graphics_node = state.graphics_node_id.clone();
            let occurrence_secs = state.onair_utc_ms.div_euclid(1000);
            due_events
                .into_iter()
                .filter_map(|ev| {
                    let rt = state.child_runtime.iter().find(|r| r.item_id == ev.item_id && r.child.id == ev.child_id)?;
                    // Ein Start für ein schon beendetes Kind (z. B. abgebrochen) entfällt.
                    if ev.action != ChildAction::Stop && rt.state.is_terminal() {
                        return None;
                    }
                    // Stopp trifft denselben Node wie der erfolgreiche Start (Fallback!).
                    let mut child = rt.child.clone();
                    if ev.action == ChildAction::Stop && rt.used_fallback && !child.fallback_target.is_empty() {
                        child.target = child.fallback_target.clone();
                    }
                    Some((ev, child, graphics_node.clone(), occurrence_secs))
                })
                .collect()
        };
        if due.is_empty() {
            continue;
        }

        for (ev, child, graphics_node, occurrence_secs) in due {
            match ev.action.clone() {
                ChildAction::Start { attempt, use_fallback } => {
                    // Exactly-once über Neustarts: VOR dem ersten Versuch ins
                    // Ausführungsjournal der Domäne `playout` eintragen.
                    if attempt == 0 && !use_fallback {
                        let key = format!("child:{}:{}:{occurrence_secs}", ev.item_id, ev.child_id);
                        let store3 = store.clone();
                        let (claim, warn) =
                            tokio::task::spawn_blocking(move || store3.persistence.claim_execution(&key, "child"))
                                .await
                                .unwrap_or((persist::Claim::Proceed, Some("Journal-Task abgestürzt".to_string())));
                        if let Some(w) = warn {
                            let _ = events.send(Event::Error(w));
                        }
                        if claim == persist::Claim::AlreadyDone {
                            set_child_state(&store, &ev, ChildState::Completed, Some("laut Ausführungsjournal bereits ausgeführt".to_string()));
                            let _ = events.send(Event::Error(format!(
                                "Child „{}\u{201c} laut Ausführungsjournal bereits ausgeführt — nicht erneut gestartet",
                                ev.child_id
                            )));
                            continue;
                        }
                    }
                    let store2 = store.clone();
                    let child2 = child.clone();
                    let result = tokio::task::spawn_blocking(move || execute_child(&store2, &child2, graphics_node, use_fallback, false))
                        .await
                        .unwrap_or_else(|e| Err(format!("Task abgestürzt: {e}")));
                    match result {
                        Ok(()) => {
                            if use_fallback {
                                let mut state = store.state.lock().expect("lock poisoned");
                                if let Some(rt) = state.child_runtime.iter_mut().find(|r| r.item_id == ev.item_id && r.child.id == ev.child_id) {
                                    rt.used_fallback = true;
                                }
                            }
                            set_child_state(&store, &ev, ChildState::Fired, None);
                            // Läuft weiter (wartet auf Stopp) oder ist schon fertig.
                            let stop_pending = {
                                let state = store.state.lock().expect("lock poisoned");
                                let rt_until_end = state
                                    .child_runtime
                                    .iter()
                                    .find(|r| r.item_id == ev.item_id && r.child.id == ev.child_id)
                                    .map(|r| r.until_primary_end)
                                    .unwrap_or(false);
                                needs_stop(&child)
                                    && (rt_until_end
                                        || state.child_schedule.iter().any(|e| {
                                            e.item_id == ev.item_id && e.child_id == ev.child_id && e.action == ChildAction::Stop
                                        }))
                            };
                            set_child_state(&store, &ev, if stop_pending { ChildState::Active } else { ChildState::Completed }, None);
                        }
                        Err(e) => match children::decide_on_failure(&child, attempt, use_fallback) {
                            FailAction::Retry { delay_ms } => {
                                set_child_attempt(&store, &ev, attempt + 1, Some(e.clone()));
                                store.state.lock().expect("lock poisoned").child_schedule.push(ScheduledChild {
                                    fire_at: Instant::now() + Duration::from_millis(delay_ms),
                                    item_id: ev.item_id.clone(),
                                    child_id: ev.child_id.clone(),
                                    action: ChildAction::Start { attempt: attempt + 1, use_fallback },
                                });
                            }
                            FailAction::UseFallback => {
                                set_child_attempt(&store, &ev, attempt + 1, Some(e.clone()));
                                store.state.lock().expect("lock poisoned").child_schedule.push(ScheduledChild {
                                    fire_at: Instant::now(),
                                    item_id: ev.item_id.clone(),
                                    child_id: ev.child_id.clone(),
                                    action: ChildAction::Start { attempt: attempt + 1, use_fallback: true },
                                });
                            }
                            FailAction::Warn => {
                                set_child_state(&store, &ev, ChildState::Failed, Some(e.clone()));
                                let _ = events.send(Event::Error(format!("Child „{}\u{201c} fehlgeschlagen: {e}", ev.child_id)));
                            }
                            FailAction::Ignore => set_child_state(&store, &ev, ChildState::Failed, Some(e)),
                        },
                    }
                }
                ChildAction::Stop => {
                    let store2 = store.clone();
                    let child2 = child.clone();
                    let result = tokio::task::spawn_blocking(move || execute_child(&store2, &child2, graphics_node, false, true))
                        .await
                        .unwrap_or_else(|e| Err(format!("Task abgestürzt: {e}")));
                    match result {
                        Ok(()) => set_child_state(&store, &ev, ChildState::Completed, None),
                        Err(e) => {
                            set_child_state(&store, &ev, ChildState::Failed, Some(e.clone()));
                            let _ = events.send(Event::Error(format!("Child „{}\u{201c}: Stopp fehlgeschlagen: {e}", ev.child_id)));
                        }
                    }
                }
            }
        }
    }
}

/// Setzt den Lebenszyklus-Zustand eines Kindes (nur erlaubte Übergänge, `ChildState::can_go`).
fn set_child_state(store: &AutomationStore, ev: &ScheduledChild, to: ChildState, error: Option<String>) {
    let mut state = store.state.lock().expect("lock poisoned");
    let mut note: Option<(String, String, &'static str, String)> = None;
    if let Some(rt) = state.child_runtime.iter_mut().find(|r| r.item_id == ev.item_id && r.child.id == ev.child_id) {
        let changed = rt.state != to && rt.state.can_go(to);
        if rt.state == to || rt.state.can_go(to) {
            rt.state = to;
        }
        if error.is_some() {
            rt.error = error;
        }
        if changed {
            let label = if !rt.child.template_id.is_empty() {
                format!("{:?} {}", rt.child.kind, rt.child.template_id)
            } else if !rt.child.target.is_empty() {
                format!("{:?} {}.{}", rt.child.kind, rt.child.target, rt.child.method)
            } else {
                format!("{:?}", rt.child.kind)
            };
            let status = match to {
                ChildState::Fired => Some("FIRED"),
                ChildState::Active => Some("ACTIVE"),
                ChildState::Completed => Some("COMPLETED"),
                ChildState::Failed => Some("FAILED"),
                ChildState::Cancelled => Some("CANCELLED"),
                _ => None,
            };
            if let Some(status) = status {
                note = Some((rt.child.id.clone(), label, status, rt.error.clone().unwrap_or_default()));
            }
        }
    }
    if let Some((child_id, label, status, reason)) = note {
        state.asrun.child(chrono::Utc::now().timestamp_millis(), &ev.item_id, &child_id, &label, status, &reason);
    }
}

fn set_child_attempt(store: &AutomationStore, ev: &ScheduledChild, attempt: u32, error: Option<String>) {
    let mut state = store.state.lock().expect("lock poisoned");
    if let Some(rt) = state.child_runtime.iter_mut().find(|r| r.item_id == ev.item_id && r.child.id == ev.child_id) {
        rt.attempt = attempt;
        rt.error = error;
    }
}

/// Lebenszyklus der Kinder für `childEvents` (Parameter) und den Snapshot.
fn child_events_json(state: &AutomationState) -> Value {
    Value::Array(
        state
            .child_runtime
            .iter()
            .map(|rt| {
                serde_json::json!({
                    "itemId": rt.item_id,
                    "id": rt.child.id,
                    "type": rt.child.kind,
                    "state": rt.state,
                    "startOffsetMs": rt.start_offset_ms,
                    "stopOffsetMs": rt.stop_offset_ms,
                    "untilPrimaryEnd": rt.until_primary_end,
                    "attempt": rt.attempt,
                    "error": rt.error,
                })
            })
            .collect(),
    )
}

/// Wanduhr-Plan (UTC) der Hauptplaylist ab dem aktuellen Item: Basis ist der
/// tatsächliche On-Air-Start des laufenden Items (sonst „jetzt"). Begrenzt auf
/// die nächsten `SCHEDULE_MAX_ENTRIES` Einträge (Spec §229: keine volle
/// Neuberechnung großer Listen bei jedem UI-Poll).
const SCHEDULE_MAX_ENTRIES: usize = 200;
const SCHEDULE_PREROLL_MS: i64 = FIXTIME_PRECUE_SECS * 1000;

fn schedule_json(state: &AutomationState, now_utc_ms: i64) -> Value {
    let from = state.playlist.current_index().unwrap_or(0);
    let base = match (state.playlist.on_air(), state.onair_since) {
        (true, Some(since)) => now_utc_ms - since.elapsed().as_millis() as i64,
        _ => now_utc_ms,
    };
    let inputs: Vec<schedule::PlanInput> = state
        .playlist
        .items()
        .iter()
        .skip(from)
        .take(SCHEDULE_MAX_ENTRIES)
        .filter_map(|id| {
            state.metadata.get(id).map(|m| schedule::PlanInput {
                id: id.clone(),
                duration_ms: m.duration_ms,
                anchor_utc_ms: if m.start_type == StartType::Fixtime { m.start_at_utc_ms } else { None },
                manual: m.start_type == StartType::Manual,
            })
        })
        .collect();
    let entries = schedule::plan(&inputs, base);
    let queue = schedule::event_queue(&entries, SCHEDULE_PREROLL_MS);
    serde_json::json!({
        "generatedAt": schedule::format_start_at(now_utc_ms),
        "entries": entries.iter().map(|e| serde_json::json!({
            "id": e.id,
            "eventType": state.metadata.get(&e.id).map(|m| event_type(&m.media)).unwrap_or(""),
            "start": e.start_ms.map(schedule::format_start_at),
            "end": e.end_ms.map(schedule::format_start_at),
            "anchored": e.anchored,
            "warnings": e.warnings,
        })).collect::<Vec<_>>(),
        "queue": queue.iter().map(|a| serde_json::json!({
            "at": schedule::format_start_at(a.at_ms),
            "action": match a.kind {
                schedule::ActionKind::End => "end",
                schedule::ActionKind::Cue => "cue",
                schedule::ActionKind::Take => "take",
            },
            "id": a.id,
        })).collect::<Vec<_>>(),
    })
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let label = env_or("OMP_LABEL", "PlayoutAutomation");
    let hook_label = label.clone();
    let host = env_or("OMP_HOST", "127.0.0.1");
    let port: u16 = env_or("OMP_PORT", "9370").parse()?;
    let registry_url = env_or("OMP_REGISTRY_URL", "http://localhost:8010");
    let nats_url = env_or("OMP_NATS_URL", "nats://localhost:4222");
    let nats_url_for_triggers = nats_url.clone();
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
    // Bequeme Startwerte für die beschreibbaren Ziel-Parameter — rein
    // optional, Operator kann sie jederzeit per PATCH überschreiben (s.
    // Moduldoku: kein Launcher-/Katalog-Änderung für dynamische Ziele
    // nötig). Kapitel 6 Teil 7: zwei Kanal-Ziele statt eines.
    let initial_player_a_label = std::env::var("OMP_PLAYOUT_TARGET_PLAYER_A_LABEL").unwrap_or_default();
    let initial_player_b_label = std::env::var("OMP_PLAYOUT_TARGET_PLAYER_B_LABEL").unwrap_or_default();
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

    let mut initial_state = AutomationState::new(
        initial_player_a_label,
        initial_player_b_label,
        initial_mixer_label,
        initial_graphics_label,
    );
    // Vom Workflow-Start vorbelegt (Rollenname des Audiomischers), sonst leer.
    initial_state.target_audio_mixer_label = std::env::var("OMP_PLAYOUT_TARGET_AUDIO_MIXER_LABEL").unwrap_or_default();
    let state = Mutex::new(initial_state);
    let store = Arc::new(AutomationStore {
        audio_status: Mutex::new(String::new()),
        trigger_log: Mutex::new(std::collections::VecDeque::new()),
        request_hold: std::sync::atomic::AtomicBool::new(false),
        report_throttle: Mutex::new(HashMap::new()),
        trigger_gate: tokio::sync::Mutex::new(()),
        state,
        registry: registry.clone(),
        events: events_tx.clone(),
        orchestrator_url: orchestrator_url.clone(),
        auth: auth.clone(),
        own_label: label.clone(),
        voiceovers_active: Mutex::new(Vec::new()),
        scte35_events: Mutex::new(HashMap::new()),
        plugins: {
            let p = Arc::new(omp_node_sdk::PluginRegistry::new());
            p.register(hooks::PLUGIN_ID, "Ereignis-Hooks (HTTP)", serde_json::json!({"hooks": []}));
            hooks::start(p.clone());
            p
        },
        persistence: persist::Persistence::new(
            instance_id.clone().filter(|_| !launch_secret.is_empty()),
            orchestrator_url.clone(),
            auth.clone(),
        ),
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
    tokio::spawn(child_loop(store.clone(), graphics_events));

    tokio::spawn(persist::persist_loop(store.clone()));
    // Kapitel 27 / P10: As-Run an den Orchestrator liefern.
    tokio::spawn(persist::asrun_loop(store.clone()));
    // Kapitel 27 / P8: Medien-Preflight (Verfügbarkeit, rechtzeitige Bereitstellung, Bereitschaft je Event).
    tokio::spawn(preflight_loop(store.clone()));
    // Kapitel 27 / P7: Channel-Trigger empfangen.
    tokio::spawn(trigger_loop(store.clone(), nats_url_for_triggers));

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

    hooks::fire("channelStart", serde_json::json!({ "channelId": structlog::current_channel(), "label": hook_label }));
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            eprintln!("omp-playout-automation: shutdown requested");
            hooks::fire("channelStop", serde_json::json!({ "channelId": structlog::current_channel(), "label": hook_label }));
            // Der Zustell-Thread bekommt kurz Zeit, die Abschlussmeldung noch abzusetzen.
            tokio::time::sleep(Duration::from_millis(300)).await;
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
            start_at_utc_ms: None,
            transition: Transition::Cut,
            transition_rate_frames: None,
            children: Vec::new(),
            audio: None,
            media_ref: Default::default(),
        }
    }

    fn file_item(path: &str) -> ItemMeta {
        ItemMeta {
            label: "File".to_string(),
            media: ItemMedia::File { path: path.to_string() },
            duration_ms: 1000,
            start_type: StartType::Sequence,
            fixtime_hms: None,
            start_at_utc_ms: None,
            transition: Transition::Cut,
            transition_rate_frames: None,
            children: Vec::new(),
            audio: None,
            media_ref: Default::default(),
        }
    }

    fn live_item(sender_id: &str) -> ItemMeta {
        ItemMeta {
            label: "Live".to_string(),
            media: ItemMedia::Live { sender_id: sender_id.to_string() },
            duration_ms: 1000,
            start_type: StartType::Sequence,
            fixtime_hms: None,
            start_at_utc_ms: None,
            transition: Transition::Cut,
            transition_rate_frames: None,
            children: Vec::new(),
            audio: None,
            media_ref: Default::default(),
        }
    }

    #[test]
    fn test_pattern_is_always_available() {
        assert!(item_is_available(&pattern_item(), &[], &[], &[]));
    }

    #[test]
    fn file_is_available_iff_listed_in_media_library() {
        let media_library = vec!["clip.mp4".to_string()];
        assert!(item_is_available(&file_item("clip.mp4"), &media_library, &[], &[]));
        assert!(!item_is_available(&file_item("missing.mp4"), &media_library, &[], &[]));
    }

    #[test]
    fn live_is_available_iff_sender_id_in_available_sources() {
        let sources = vec![serde_json::json!({"senderId": "sender-1", "label": "Cam 1"})];
        assert!(item_is_available(&live_item("sender-1"), &[], &sources, &[]));
        assert!(!item_is_available(&live_item("sender-2"), &[], &sources, &[]));
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

// Kapitel 27 / P4c: Live-Quelle per Kriterien.
#[cfg(test)]
mod live_select_tests {
    use super::*;
    use omp_resolver::{MediaType, Selector, Source, SourceTag, TagOrigin};

    fn video(id: &str, tags: &[&str], online: bool) -> Source {
        Source {
            sender_id: id.to_string(),
            label: format!("Cam {id}"),
            node_id: "n".to_string(),
            node_label: "Remote".to_string(),
            workflow_id: String::new(),
            media_type: Some(MediaType::Video),
            group_hint: String::new(),
            channel_count: 0,
            online,
            visible: true,
            selectable: true,
            tags: tags.iter().map(|t| SourceTag { tag: t.to_string(), origin: TagOrigin::Explicit }).collect(),
        }
    }

    fn selector(required: &[&str]) -> Selector {
        Selector { required: required.iter().map(|s| s.to_string()).collect(), ..Selector::default() }
    }

    #[test]
    fn selector_picks_the_matching_online_source_and_defaults_to_video() {
        let sources = vec![video("a", &["video.camera"], false), video("b", &["video.camera"], true), video("c", &["video.clean"], true)];
        let (id, res) = resolve_live_selector(&selector(&["video.camera"]), &sources).unwrap();
        assert_eq!(id, "b", "offline alternative is skipped");
        assert!(!res.ambiguous);
        // Ein reiner Tag-Selektor darf keine Audio-Quelle als Live-Bild wählen (Medienart-Default video).
        let mut audio = video("x", &["role.program"], true);
        audio.media_type = Some(MediaType::Audio);
        assert!(resolve_live_selector(&selector(&["role.program"]), &[audio]).is_err());
    }

    #[test]
    fn no_match_is_an_error_with_the_reason_never_a_guess() {
        let err = resolve_live_selector(&selector(&["video.program"]), &[video("a", &["video.camera"], true)]).unwrap_err();
        assert!(err.contains("nicht auflösbar") && err.contains("keine passende Quelle"), "{err}");
    }

    #[test]
    fn live_select_item_availability_follows_the_current_sources() {
        let meta = ItemMeta {
            label: "L".to_string(),
            media: ItemMedia::LiveSelect { selector: Box::new(selector(&["video.camera"])) },
            duration_ms: 0,
            start_type: StartType::Sequence,
            fixtime_hms: None,
            start_at_utc_ms: None,
            transition: Transition::Cut,
            transition_rate_frames: None,
            children: Vec::new(),
            audio: None,
            media_ref: Default::default(),
        };
        assert!(item_is_available(&meta, &[], &[], &[video("a", &["video.camera"], true)]));
        assert!(!item_is_available(&meta, &[], &[], &[video("a", &["video.camera"], false)]), "offline source: not available");
        assert!(!item_is_available(&meta, &[], &[], &[]));
        assert_eq!(event_type(&meta.media), "LIVE");
        // Im Snapshot erhalten (Neustart) und als Item-JSON sichtbar.
        let back: ItemMeta = serde_json::from_str(&serde_json::to_string(&meta).unwrap()).unwrap();
        assert_eq!(back.media, meta.media);
        assert_eq!(item_meta_to_json("i", &meta)["sourceSelector"]["required"][0], "video.camera");
    }

    fn audio_src(id: &str, node: &str, tags: &[&str]) -> Source {
        let mut s = video(id, tags, true);
        s.media_type = Some(MediaType::Audio);
        s.node_id = node.to_string();
        s.channel_count = 2;
        s
    }

    fn live_item(sender: &str, audio: Option<omp_resolver::audio::AudioIntent>) -> ItemMeta {
        ItemMeta {
            label: "L".to_string(),
            media: ItemMedia::Live { sender_id: sender.to_string() },
            duration_ms: 0,
            start_type: StartType::Sequence,
            fixtime_hms: None,
            start_at_utc_ms: None,
            transition: Transition::Cut,
            transition_rate_frames: None,
            children: Vec::new(),
            audio,
            media_ref: Default::default(),        }
    }

    #[test]
    fn audio_view_offers_only_the_audio_of_the_selected_source() {
        use omp_resolver::audio::{AudioIntent, AudioVia};
        let mut state = AutomationState::new(String::new(), String::new(), String::new(), String::new());
        let mut v = video("v-x", &["video.camera"], true);
        v.node_id = "x".to_string();
        state.sources = vec![
            v,
            audio_src("ax1", "x", &["role.program"]),
            audio_src("ax2", "x", &["role.commentator"]),
            audio_src("ay1", "y", &["role.international"]),
        ];
        // Kein Intent: zwei Capabilities, kein Default → keine willkürliche Wahl.
        let view = audio_view(&state, &live_item("v-x", None)).unwrap();
        let ids: Vec<&str> = view["capabilities"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["commentator", "program"], "nothing from node y");
        assert!(view["resolution"]["chosen"].is_null());
        // Ausdrückliche Wahl.
        let intent = AudioIntent { capability: Some("commentator".to_string()), ..Default::default() };
        let view = audio_view(&state, &live_item("v-x", Some(intent))).unwrap();
        assert_eq!(view["resolution"]["chosen"], "commentator");
        assert_eq!(view["resolution"]["via"], serde_json::to_value(AudioVia::Explicit).unwrap()["via"]);
        // Gespeichertes Preset, das die Quelle nicht (mehr) anbietet: Warnung, keine stille Ersatzwahl.
        let intent = AudioIntent { capability: Some("surround".to_string()), ..Default::default() };
        let view = audio_view(&state, &live_item("v-x", Some(intent))).unwrap();
        assert!(view["resolution"]["chosen"].is_null());
        assert!(view["resolution"]["warnings"][0].as_str().unwrap().contains("surround"));
        // Unbekannte Quelle / kein Live-Item: keine Audio-Sicht.
        assert!(audio_view(&state, &live_item("unbekannt", None)).is_none());
        let mut pattern = live_item("x", None);
        pattern.media = ItemMedia::TestPattern { pattern: "smpte".to_string(), tone_frequency: 0.0 };
        assert!(audio_view(&state, &pattern).is_none());
    }

    #[test]
    fn audio_intent_survives_the_snapshot_roundtrip_and_old_items_load_without_it() {
        let intent = omp_resolver::audio::AudioIntent { capability: Some("program".to_string()), ..Default::default() };
        let m = live_item("s", Some(intent.clone()));
        let back: ItemMeta = serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(back.audio, Some(intent));
        let mut v = serde_json::to_value(live_item("s", None)).unwrap();
        v.as_object_mut().unwrap().remove("audio");
        let old: ItemMeta = serde_json::from_value(v).unwrap();
        assert_eq!(old.audio, None, "snapshots from before P5 still load");
    }

    #[test]
    fn selector_json_from_the_operator_parses_with_defaults() {
        let s: Selector = serde_json::from_str(r#"{"required":["video.camera"],"preferred":["role.program"],"failOnAmbiguity":true}"#).unwrap();
        assert_eq!(s.required, ["video.camera"]);
        assert!(s.fail_on_ambiguity && !s.allow_offline && s.exact_id.is_none());
        let m = item_media_from_args(None, None, None, None, None, None, Some(&s));
        assert!(matches!(m, ItemMedia::LiveSelect { .. }));
        // Eine feste Sender-ID hat Vorrang (EXACT_ID bleibt der einfache Fall).
        let m = item_media_from_args(None, None, Some("snd-1"), None, None, None, Some(&s));
        assert_eq!(m, ItemMedia::Live { sender_id: "snd-1".to_string() });
    }
}

// Kapitel 27 / P2b: Bild-, Hold- und Jump-Events.
#[cfg(test)]
mod control_event_tests {
    use super::*;

    fn item(media: ItemMedia, duration_ms: u64) -> ItemMeta {
        ItemMeta {
            label: "x".to_string(),
            media,
            duration_ms,
            start_type: StartType::Sequence,
            fixtime_hms: None,
            start_at_utc_ms: None,
            transition: Transition::Cut,
            transition_rate_frames: None,
            children: Vec::new(),
            audio: None,
            media_ref: Default::default(),
        }
    }

    fn state_with(items: Vec<(&str, ItemMedia)>) -> AutomationState {
        let mut s = AutomationState::new(String::new(), String::new(), String::new(), String::new());
        for (id, media) in items {
            s.metadata.insert(id.to_string(), item(media, 1000));
            s.playlist.append(id.to_string());
        }
        s
    }

    fn pat() -> ItemMedia {
        ItemMedia::TestPattern { pattern: "smpte".to_string(), tone_frequency: 0.0 }
    }

    #[test]
    fn event_type_comes_from_the_explicit_type_not_the_extension() {
        let m = item_media_from_args(None, Some("still.jpg"), None, None, Some("image"), None, None);
        assert_eq!(m, ItemMedia::Image { path: "still.jpg".to_string() });
        assert_eq!(event_type(&m), "IMAGE");
        // Ohne ausdrückliche Angabe bleibt eine .jpg-Datei ein CLIP (kein Raten an der Endung).
        let m = item_media_from_args(None, Some("still.jpg"), None, None, None, None, None);
        assert_eq!(event_type(&m), "CLIP");
        assert_eq!(event_type(&item_media_from_args(None, None, None, None, Some("hold"), None, None)), "HOLD");
        let j = item_media_from_args(None, None, None, None, Some("JUMP"), Some("item3"), None);
        assert_eq!(j, ItemMedia::Jump { target_id: "item3".to_string() });
        assert!(j.is_control() && ItemMedia::Hold.is_control() && !pat().is_control());
    }

    #[test]
    fn image_is_sent_to_the_player_with_media_type_and_checked_in_the_media_library() {
        let meta = item(ItemMedia::Image { path: "logo.png".to_string() }, 5000);
        let args = load_args(&meta);
        assert_eq!(args["file"], "logo.png");
        assert_eq!(args["mediaType"], "image");
        assert!(item_is_available(&meta, &["logo.png".to_string()], &[], &[]));
        assert!(!item_is_available(&meta, &["other.png".to_string()], &[], &[]));
        // Steuer-Events brauchen kein Medium und werden nie geladen.
        assert!(item_is_available(&item(ItemMedia::Hold, 0), &[], &[], &[]));
        assert_eq!(load_args(&item(ItemMedia::Hold, 0)).get("file"), None);
    }

    #[test]
    fn jump_resolves_to_its_target_and_chains() {
        let mut s = state_with(vec![
            ("a", pat()),
            ("j1", ItemMedia::Jump { target_id: "j2".to_string() }),
            ("j2", ItemMedia::Jump { target_id: "a".to_string() }),
            ("z", pat()),
        ]);
        let id = resolve_jump(&mut s, "j1".to_string(), true).unwrap();
        assert_eq!(id, "a", "j1 -> j2 -> a");
        assert_eq!(s.playlist.current_index(), Some(0));
        assert!(s.playlist.on_air(), "mark_on_air=true takes the target");
        // kein Jump: unverändert, Playlist unangetastet
        let before = s.playlist.current_index();
        assert_eq!(resolve_jump(&mut s, "z".to_string(), true).unwrap(), "z");
        assert_eq!(s.playlist.current_index(), before);
    }

    #[test]
    fn jump_without_take_only_cues_the_target() {
        let mut s = state_with(vec![("a", pat()), ("j", ItemMedia::Jump { target_id: "a".to_string() })]);
        s.playlist.cue(1).unwrap();
        assert_eq!(resolve_jump(&mut s, "j".to_string(), false).unwrap(), "a");
        assert_eq!(s.playlist.current_index(), Some(0));
        assert!(!s.playlist.on_air());
    }

    #[test]
    fn jump_loop_and_missing_target_are_errors_not_hangs() {
        // Neun Sprünge in Folge (länger als MAX_JUMP_CHAIN) ohne Ziel-Item.
        let mut items = Vec::new();
        let names: Vec<String> = (0..=MAX_JUMP_CHAIN + 1).map(|i| format!("j{i}")).collect();
        for (i, n) in names.iter().enumerate() {
            let next = names[(i + 1) % names.len()].clone();
            items.push((n.as_str(), ItemMedia::Jump { target_id: next }));
        }
        let mut s = state_with(items);
        let err = resolve_jump(&mut s, "j0".to_string(), false).unwrap_err();
        assert!(err.contains("Schleife"), "{err}");

        let mut s = state_with(vec![("j", ItemMedia::Jump { target_id: "gone".to_string() })]);
        assert!(resolve_jump(&mut s, "j".to_string(), false).unwrap_err().contains("nicht mehr im Rundown"));
    }

    #[test]
    fn control_events_survive_a_snapshot_roundtrip() {
        for media in [ItemMedia::Hold, ItemMedia::Jump { target_id: "x".to_string() }, ItemMedia::Image { path: "a.png".to_string() }] {
            let json = serde_json::to_string(&item(media.clone(), 0)).unwrap();
            let back: ItemMeta = serde_json::from_str(&json).unwrap();
            assert_eq!(back.media, media);
        }
    }
}

// Kapitel 27 / P2a: Auto-Advance darf ein Fixtime-Item nicht vor seiner Zeit nehmen.
#[cfg(test)]
mod fixtime_wait_tests {
    use super::*;

    fn fix(start_at_utc_ms: Option<i64>, hms: Option<&str>) -> ItemMeta {
        ItemMeta {
            label: "F".to_string(),
            media: ItemMedia::TestPattern { pattern: "smpte".to_string(), tone_frequency: 0.0 },
            duration_ms: 1000,
            start_type: StartType::Fixtime,
            fixtime_hms: hms.map(str::to_string),
            start_at_utc_ms,
            transition: Transition::Cut,
            transition_rate_frames: None,
            children: Vec::new(),
            audio: None,
            media_ref: Default::default(),
        }
    }

    #[test]
    fn absolute_future_waits_and_past_does_not() {
        let now = 1_000_000;
        assert!(fixtime_is_in_future(&fix(Some((now + 60) * 1000), None), now, 0));
        assert!(!fixtime_is_in_future(&fix(Some((now - 60) * 1000), None), now, 0));
        assert!(!fixtime_is_in_future(&fix(Some(now * 1000), None), now, 0), "exactly now = due, not future");
    }

    #[test]
    fn absolute_time_wins_over_legacy_hms() {
        // Altes HH:MM:SS läge in der Zukunft, die absolute Zeit ist aber vorbei.
        assert!(!fixtime_is_in_future(&fix(Some(1000), Some("23:59:59")), 5000, 100));
    }

    #[test]
    fn legacy_hms_compares_against_local_clock() {
        assert!(fixtime_is_in_future(&fix(None, Some("12:00:00")), 0, 11 * 3600));
        assert!(!fixtime_is_in_future(&fix(None, Some("12:00:00")), 0, 13 * 3600));
        assert!(!fixtime_is_in_future(&fix(None, None), 0, 0), "fixtime without any time never waits");
    }

    #[test]
    fn non_fixtime_items_never_wait() {
        let mut m = fix(Some(i64::MAX / 2), None);
        m.start_type = StartType::Sequence;
        assert!(!fixtime_is_in_future(&m, 0, 0));
    }
}

// Kapitel 6 Teil 5 / Kapitel 27 P3: `resolve_variables` und die Child-Planung
// sind reine Zustandsfunktionen (kein Netzwerk) — direkt unit-testbar.
#[cfg(test)]
mod graphics_children_tests {
    use super::*;
    use children::{ChildEvent, TimingMode};

    fn item_with(children: Vec<ChildEvent>, duration_ms: u64) -> AutomationState {
        let mut s = AutomationState::new(String::new(), String::new(), String::new(), String::new());
        s.metadata.insert(
            "p".to_string(),
            ItemMeta {
                label: "Primary".to_string(),
                media: ItemMedia::TestPattern { pattern: "smpte".to_string(), tone_frequency: 0.0 },
                duration_ms,
                start_type: StartType::Sequence,
                fixtime_hms: None,
                start_at_utc_ms: None,
                transition: Transition::Cut,
                transition_rate_frames: None,
                children,
                audio: None,
                media_ref: Default::default(),
            },
        );
        s.playlist.append("p".to_string());
        s.graphics_node_id = Some("g".to_string());
        s
    }

    fn graphic(timing: TimingMode, delay: u64, dur: u64) -> ChildEvent {
        let mut c = ChildEvent::graphic("lt", timing, delay, dur);
        c.data = serde_json::json!({"t": "{{next:title}}"});
        c
    }

    #[test]
    fn plan_schedules_start_and_timed_stop_and_arms_resolvable_targets() {
        let mut s = item_with(vec![graphic(TimingMode::RelativeToStart, 10_000, 8_000)], 60_000);
        let now = Instant::now();
        let notices = plan_children(&mut s, "p", now, None);
        assert!(notices.is_empty(), "{notices:?}");
        let kinds: Vec<(String, u64)> = s
            .child_schedule
            .iter()
            .map(|e| (format!("{:?}", e.action), (e.fire_at - now).as_millis() as u64))
            .collect();
        assert_eq!(kinds.len(), 2);
        assert!(kinds.iter().any(|(a, t)| a.starts_with("Start") && *t == 10_000));
        assert!(kinds.iter().any(|(a, t)| a == "Stop" && *t == 18_000));
        assert_eq!(s.child_runtime[0].state, ChildState::Armed, "graphics node resolved");
        assert_eq!(s.child_runtime[0].child.id, "c1", "id assigned");
    }

    #[test]
    fn full_primary_has_no_own_stop_it_ends_with_the_primary() {
        let mut s = item_with(vec![graphic(TimingMode::FullPrimary, 0, 0)], 0);
        plan_children(&mut s, "p", Instant::now(), None);
        assert_eq!(s.child_schedule.len(), 1, "only the start");
        assert!(s.child_runtime[0].until_primary_end);
    }

    #[test]
    fn unresolved_target_leaves_the_child_scheduled_not_armed() {
        let mut s = item_with(vec![graphic(TimingMode::FullPrimary, 0, 0)], 0);
        s.graphics_node_id = None;
        plan_children(&mut s, "p", Instant::now(), None);
        assert_eq!(s.child_runtime[0].state, ChildState::Scheduled);
    }

    #[test]
    fn impossible_window_fails_the_child_with_a_notice_and_schedules_nothing() {
        // RELATIVE_TO_END an einem endlosen Live-Primary.
        let mut s = item_with(vec![graphic(TimingMode::RelativeToEnd, 2000, 0)], 0);
        let notices = plan_children(&mut s, "p", Instant::now(), None);
        assert!(notices[0].contains("fester Dauer"), "{notices:?}");
        assert!(s.child_schedule.is_empty());
        assert_eq!(s.child_runtime[0].state, ChildState::Failed);
    }

    #[test]
    fn primary_change_cancels_pending_starts_and_stops_active_children_immediately() {
        let mut s = item_with(
            vec![graphic(TimingMode::RelativeToStart, 60_000, 0), graphic(TimingMode::FullPrimary, 0, 0)],
            120_000,
        );
        s.child_runtime.clear();
        plan_children(&mut s, "p", Instant::now(), None);
        // Zweites Kind lief bereits.
        s.child_runtime[1].state = ChildState::Active;
        s.child_schedule.retain(|e| e.child_id != "c2");

        retire_children(&mut s);

        assert!(s.child_schedule.iter().all(|e| e.action == ChildAction::Stop), "no start survives a primary change");
        let stop = s.child_schedule.iter().find(|e| e.child_id == "c2").expect("active child gets a stop");
        assert!(stop.fire_at <= Instant::now());
        // Das nicht gestartete Kind (c1) ist storniert und aus der Laufzeitliste verschwunden (terminal).
        assert!(s.child_runtime.iter().all(|r| r.child.id != "c1"));
        assert!(s.child_runtime.iter().any(|r| r.child.id == "c2" && r.state == ChildState::Active));
    }

    #[test]
    fn restart_does_not_refire_started_children_and_reports_missed_ones() {
        let mut s = item_with(
            vec![
                graphic(TimingMode::RelativeToStart, 1_000, 30_000), // lief schon
                graphic(TimingMode::RelativeToStart, 2_000, 0),      // verpasst
                graphic(TimingMode::RelativeToStart, 500_000, 0),    // liegt in der Zukunft
            ],
            600_000,
        );
        let onair = Instant::now() - Duration::from_secs(10);
        let saved: HashMap<String, ChildState> =
            [("c1".to_string(), ChildState::Active), ("c2".to_string(), ChildState::Scheduled), ("c3".to_string(), ChildState::Scheduled)]
                .into_iter()
                .collect();
        let notices = plan_children(&mut s, "p", onair, Some(&saved));
        assert!(notices.iter().any(|n| n.contains("c2") && n.contains("verpasst")), "{notices:?}");
        let by_id = |id: &str| s.child_runtime.iter().find(|r| r.child.id == id).unwrap().state;
        assert_eq!(by_id("c1"), ChildState::Active);
        assert_eq!(by_id("c2"), ChildState::Cancelled);
        assert_eq!(by_id("c3"), ChildState::Armed);
        // Nur c3 bekommt einen Start; c1 nur seinen Stopp.
        assert_eq!(s.child_schedule.iter().filter(|e| matches!(e.action, ChildAction::Start { .. })).count(), 1);
        assert!(s.child_schedule.iter().any(|e| e.child_id == "c1" && e.action == ChildAction::Stop));
    }

    #[test]
    fn preflight_target_check_by_type() {
        let s = item_with(vec![], 0);
        let mut c = graphic(TimingMode::FullPrimary, 0, 0);
        assert!(child_target_ok(&s, &c));
        c.kind = ChildType::NodeCommand;
        c.target = "Audiomischer".to_string();
        c.method = "x".to_string();
        assert!(!child_target_ok(&s, &c));
        let mut s2 = item_with(vec![], 0);
        s2.discovered_labels = vec!["Audiomischer".to_string()];
        assert!(child_target_ok(&s2, &c));
        assert!(needs_stop(&graphic(TimingMode::FullPrimary, 0, 0)));
        assert!(!needs_stop(&c), "node commands only stop when a stopMethod is set");
        c.stop_method = "off".to_string();
        assert!(needs_stop(&c));
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

#[cfg(test)]
mod media_ref_tests {
    use super::*;

    fn meta_with(media_ref: readiness::MediaRef) -> ItemMeta {
        ItemMeta {
            label: "Clip".into(),
            media: ItemMedia::File { path: "clip.mxf".into() },
            duration_ms: 1000,
            start_type: StartType::default(),
            fixtime_hms: None,
            start_at_utc_ms: None,
            transition: Transition::default(),
            transition_rate_frames: None,
            children: Vec::new(),
            audio: None,
            media_ref,
        }
    }

    #[test]
    fn asset_reference_policy_and_fallback_survive_the_snapshot_roundtrip_flat() {
        let m = meta_with(readiness::MediaRef {
            asset: Some(readiness::AssetRef { asset_id: "a1".into(), version_id: String::new(), representation_type: "playout".into() }),
            on_missing: readiness::MissingPolicy::Fallback,
            fallback_file: Some("ersatz.mxf".into()),
            ..Default::default()
        });
        let v = serde_json::to_value(&m).unwrap();
        // Flach (nicht verschachtelt) — Altbestand und neue Felder liegen auf derselben Ebene.
        assert_eq!(v["asset"]["assetId"], "a1");
        assert_eq!(v["onMissing"], "FALLBACK");
        assert_eq!(v["fallbackFile"], "ersatz.mxf");
        let back: ItemMeta = serde_json::from_value(v).unwrap();
        assert_eq!(back.media_ref, m.media_ref);
    }

    #[test]
    fn snapshots_from_before_p8_load_without_media_ref() {
        let mut v = serde_json::to_value(meta_with(readiness::MediaRef::default())).unwrap();
        for k in ["asset", "onMissing", "fallbackFile"] {
            v.as_object_mut().unwrap().remove(k);
        }
        let back: ItemMeta = serde_json::from_value(v).unwrap();
        assert!(back.media_ref.asset.is_none());
        assert_eq!(back.media_ref.on_missing, readiness::MissingPolicy::Hold);
    }

    #[test]
    fn item_json_shows_asset_and_policy_only_when_set() {
        let plain = item_meta_to_json("i", &meta_with(readiness::MediaRef::default()));
        assert!(plain.get("asset").is_none());
        let with = item_meta_to_json(
            "i",
            &meta_with(readiness::MediaRef {
                asset: Some(readiness::AssetRef { asset_id: "a1".into(), ..Default::default() }),
                on_missing: readiness::MissingPolicy::Skip,
                fallback_file: None,
                ..Default::default()
            }),
        );
        assert_eq!(with["asset"]["assetId"], "a1");
        assert_eq!(with["onMissing"], "SKIP");
    }

    #[test]
    fn asset_items_are_not_gated_by_the_local_file_list() {
        let asset = readiness::AssetRef { asset_id: "a1".into(), ..Default::default() };
        let m = meta_with(readiness::MediaRef { asset: Some(asset), ..Default::default() });
        assert!(item_is_available(&m, &[], &[], &[]), "Datei fehlt lokal, aber der Preflight stellt sie bereit");
        assert!(!item_is_available(&meta_with(readiness::MediaRef::default()), &[], &[], &[]), "ohne Asset-Referenz gilt wie bisher die Dateiliste");
    }

    #[test]
    fn upcoming_asset_items_only_lists_items_with_a_reference_and_their_planned_start() {
        let mut state = AutomationState::new(String::new(), String::new(), String::new(), String::new());
        let asset = readiness::AssetRef { asset_id: "a1".into(), ..Default::default() };
        state.next_item_seq = 2;
        for (id, with_asset) in [("item1", false), ("item2", true)] {
            let mut m = meta_with(readiness::MediaRef { asset: with_asset.then(|| asset.clone()), ..Default::default() });
            m.duration_ms = 10_000;
            state.metadata.insert(id.to_string(), m);
            state.playlist.append(id.to_string());
        }
        let now = 1_790_000_000_000;
        let up = upcoming_asset_items(&state, now);
        assert_eq!(up.len(), 1);
        assert_eq!(up[0].0, "item2");
        assert_eq!(up[0].2, Some(now + 10_000), "startet nach dem ersten 10-s-Item");
    }
}

#[cfg(test)]
mod patch_tests {
    use super::*;

    fn state_with(ids: &[&str]) -> AutomationState {
        let mut st = AutomationState::new(String::new(), String::new(), String::new(), String::new());
        for id in ids {
            st.metadata.insert(
                id.to_string(),
                ItemMeta {
                    label: id.to_string(),
                    media: ItemMedia::File { path: "a.mp4".into() },
                    duration_ms: 1000,
                    start_type: StartType::default(),
                    fixtime_hms: None,
                    start_at_utc_ms: None,
                    transition: Transition::default(),
                    transition_rate_frames: None,
                    children: Vec::new(),
                    audio: None,
                    media_ref: Default::default(),
                },
            );
            st.playlist.append(id.to_string());
        }
        st
    }

    fn apply(st: &mut AutomationState, id: &str, patch: Value) -> Result<(), String> {
        let p: ItemPatch = serde_json::from_value(patch).unwrap();
        apply_item_patch(st, id, None, None, None, None, None, p)
    }

    #[test]
    fn simple_fields_and_transition_are_applied() {
        let mut st = state_with(&["a"]);
        apply(&mut st, "a", serde_json::json!({
            "label": "Neu", "note": "Hinweis", "icon": "🎬", "color": "#5aabff", "durationMs": 4000,
            "transition": "mix", "transitionRateFrames": 25,
        })).unwrap();
        let m = &st.metadata["a"];
        assert_eq!((m.label.as_str(), m.duration_ms, m.transition_rate_frames), ("Neu", 4000, Some(25)));
        assert_eq!(m.transition, Transition::Mix);
        assert_eq!((m.media_ref.note.as_str(), m.media_ref.icon.as_str(), m.media_ref.color.as_str()), ("Hinweis", "🎬", "#5aabff"));
        // Rate außerhalb 1..=250 oder null löscht sie.
        apply(&mut st, "a", serde_json::json!({"transitionRateFrames": 999})).unwrap();
        assert_eq!(st.metadata["a"].transition_rate_frames, None);
    }

    #[test]
    fn fade_transitions_parse_and_serialize_by_name() {
        assert_eq!(Transition::parse("fadecut"), Some(Transition::FadeCut));
        assert_eq!(Transition::parse("fade-cut"), Some(Transition::FadeCut));
        assert_eq!(Transition::parse("cutfade"), Some(Transition::CutFade));
        assert_eq!(Transition::parse("cut-fade"), Some(Transition::CutFade));
        assert_eq!(Transition::parse("nope"), None);
        assert_eq!(serde_json::to_value(Transition::FadeCut).unwrap(), "fadecut");
        assert_eq!(serde_json::from_value::<Transition>(serde_json::json!("cutfade")).unwrap(), Transition::CutFade);
    }

    #[test]
    fn audio_mapping_is_set_cleared_shown_and_passed_to_the_player() {
        let mut st = state_with(&["a"]);
        apply(&mut st, "a", serde_json::json!({"audioMapping": "stereo-dolbye"})).unwrap();
        assert_eq!(st.metadata["a"].media_ref.audio_mapping, "stereo-dolbye");
        assert_eq!(item_meta_to_json("a", &st.metadata["a"])["audioMapping"], "stereo-dolbye");
        assert_eq!(load_args(&st.metadata["a"])["audioMapping"], "stereo-dolbye");
        apply(&mut st, "a", serde_json::json!({"audioMapping": ""})).unwrap();
        assert!(item_meta_to_json("a", &st.metadata["a"]).get("audioMapping").is_none());
        assert!(load_args(&st.metadata["a"]).get("audioMapping").is_none(), "ohne Wahl nichts mitschicken");
    }

    #[test]
    fn ad_class_is_set_cleared_and_shown_in_the_item_json() {
        let mut st = state_with(&["a"]);
        apply(&mut st, "a", serde_json::json!({"adClass": "commercial"})).unwrap();
        assert_eq!(st.metadata["a"].media_ref.ad_class, "commercial");
        assert_eq!(item_meta_to_json("a", &st.metadata["a"])["adClass"], "commercial");
        apply(&mut st, "a", serde_json::json!({"adClass": ""})).unwrap();
        assert!(st.metadata["a"].media_ref.ad_class.is_empty());
        assert!(item_meta_to_json("a", &st.metadata["a"]).get("adClass").is_none());
    }

    #[test]
    fn on_air_event_keeps_its_media_and_duration_but_allows_the_rest() {
        let mut st = state_with(&["a", "b"]);
        st.playlist.take().unwrap(); // a on air
        let media = Some((ItemMedia::Hold, None));
        let err = apply_item_patch(&mut st, "a", media, None, None, None, None, ItemPatch::default()).unwrap_err();
        assert!(err.contains("laufende Event"));
        assert!(apply(&mut st, "a", serde_json::json!({"durationMs": 5})).unwrap_err().contains("laufende Event"));
        apply(&mut st, "a", serde_json::json!({"label": "Live-Titel", "children": []})).unwrap();
        assert_eq!(st.metadata["a"].label, "Live-Titel");
        // Das nicht laufende Event b ist frei änderbar.
        apply_item_patch(&mut st, "b", Some((ItemMedia::File { path: "x.mxf".into() }, None)), None, None, None, None, ItemPatch::default()).unwrap();
        assert!(matches!(&st.metadata["b"].media, ItemMedia::File { path } if path == "x.mxf"));
    }

    #[test]
    fn control_media_zeroes_the_duration_and_fixtime_without_a_time_falls_back() {
        let mut st = state_with(&["a", "b"]);
        apply_item_patch(&mut st, "b", Some((ItemMedia::Hold, None)), None, None, None, None, ItemPatch::default()).unwrap();
        assert_eq!(st.metadata["b"].duration_ms, 0);
        apply_item_patch(&mut st, "a", None, Some(StartType::Fixtime), None, None, None, ItemPatch::default()).unwrap();
        assert_eq!(st.metadata["a"].start_type, StartType::default(), "Fixtime ohne Zeit gibt es nicht");
        apply_item_patch(&mut st, "a", None, Some(StartType::Fixtime), Some(Some(1_790_000_000_000)), None, None, ItemPatch::default()).unwrap();
        assert_eq!((st.metadata["a"].start_type, st.metadata["a"].start_at_utc_ms), (StartType::Fixtime, Some(1_790_000_000_000)));
        // Zurück auf „sequence“ räumt die Zeiten ab.
        apply_item_patch(&mut st, "a", None, Some(StartType::default()), None, None, None, ItemPatch::default()).unwrap();
        assert_eq!(st.metadata["a"].start_at_utc_ms, None);
    }

    #[test]
    fn jump_target_must_exist_and_unknown_items_are_rejected() {
        let mut st = state_with(&["a"]);
        let jump = Some((ItemMedia::Jump { target_id: "gibts-nicht".into() }, None));
        assert!(apply_item_patch(&mut st, "a", jump, None, None, None, None, ItemPatch::default()).unwrap_err().contains("kein Event"));
        assert_eq!(st.metadata["a"].label, "a", "bei Fehler bleibt alles unverändert");
        assert!(apply(&mut st, "nix", serde_json::json!({"label": "x"})).unwrap_err().contains("unbekannte itemId"));
    }

    #[test]
    fn policy_asset_and_children_patches() {
        let mut st = state_with(&["a"]);
        let asset = readiness::AssetRef { asset_id: "as1".into(), ..Default::default() };
        apply_item_patch(&mut st, "a", Some((ItemMedia::File { path: "clip.mxf".into() }, Some(asset.clone()))),
            None, None, Some(readiness::MissingPolicy::Black), None,
            serde_json::from_value(serde_json::json!({"fallbackFile": "filler.mxf"})).unwrap()).unwrap();
        let m = &st.metadata["a"];
        assert_eq!(m.media_ref.asset, Some(asset));
        assert_eq!(m.media_ref.on_missing, readiness::MissingPolicy::Black);
        assert_eq!(m.media_ref.fallback_file.as_deref(), Some("filler.mxf"));
        let c = ChildEvent::graphic("t1", children::TimingMode::RelativeToStart, 1000, 0);
        apply_item_patch(&mut st, "a", None, None, None, None, None, ItemPatch { children: Some(vec![c]), ..Default::default() }).unwrap();
        assert_eq!(st.metadata["a"].children.len(), 1);
    }
}
