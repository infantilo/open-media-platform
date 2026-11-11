//! Layout-Kopplung (Kapitel 90.2): eine gemessene Zone einer Grafik-Ebene (`zones.rs`) führt einen PIP-Slot des Bildmischers.
//! Das ist der Squeeze-back: die Vorlage zeichnet nur den Rahmen mit einem Fenster (`data-ograf-zone`), der Mischer legt die
//! gewählte Quelle in den Slot und fährt ihn auf das Fenster. Folgt die Zone einer CSS-Animation, folgt der Slot ihr bildweise.
//!
//! Aufrufe gehen über die Descriptor-API des Mischers (`pip.setSource`, `pip.setPose`, `pip.setEnabled`). Verzögerung gegenüber
//! der Grafik: Messung + ein HTTP-Aufruf je Änderung (Größe der Verzögerung **nicht gemessen**, s. UMSETZUNG.md 90.2). Die Bewegung selbst fährt die
//! Vorlage; ein vorausberechnetes, vom Mischer gefahrenes Fenster ist ein möglicher Ausbau (90.3).

use std::collections::BTreeMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use omp_node_sdk::is04::RegistryClient;
use omp_node_sdk::peer::PeerClient;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::zones::{Zone, ZoneStore};

/// Eine Zone darunter gilt als unsichtbar (Slot aus).
const MIN_OPACITY: f64 = 0.02;
/// Takt der Nachführung (Abfrage des Speichers, billig; bestimmt den Nachlauf mit — bei 40 ms lag er bei ≈ 60 ms).
const TICK: Duration = Duration::from_millis(8);

/// Vorlauf der Seite bei gekoppelten Fahrten (ms): sie zeigt die Pose von „jetzt + Vorlauf“, damit sie nach der Render-Latenz
/// bis zum Mischerausgang bildgleich mit dem Video steht. Standard `OMP_OGRAF_FOLLOW_LEAD_MS`, sonst 250 ms (unter Last gemessen: Lücke ab ca. 300 ms)
/// (`OMP_OGRAF_RENDER_LATENCY_MS`, 110). Zur Laufzeit per `layout.setLead` einstellbar (Kalibrierung).
static FOLLOW_LEAD_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(i64::MIN);
/// Gesetzt, wenn die Verzögerung an den Mischern neu zu setzen ist.
static LEAD_DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
/// Zusatz für Abfragetakt (40 ms) und Übertragung: um so viel später beginnt die Fahrt des Mischers als der Seitenvorlauf.
const START_MARGIN_MS: i64 = 150;

pub fn follow_lead_ms() -> i64 {
    use std::sync::atomic::Ordering::Relaxed;
    let v = FOLLOW_LEAD_MS.load(Relaxed);
    if v != i64::MIN {
        return v;
    }
    let env = |k: &str| std::env::var(k).ok().and_then(|s| s.trim().parse::<i64>().ok());
    let v = env("OMP_OGRAF_FOLLOW_LEAD_MS").or_else(|| env("OMP_OGRAF_RENDER_LATENCY_MS")).unwrap_or(250).clamp(0, 1500);
    FOLLOW_LEAD_MS.store(v, Relaxed);
    v
}

pub fn set_follow_lead_ms(ms: i64) {
    FOLLOW_LEAD_MS.store(ms.clamp(0, 1500), std::sync::atomic::Ordering::Relaxed);
    LEAD_DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Binding {
    #[serde(rename = "layerId")]
    pub layer: String,
    pub zone: String,
    /// Anzeigename (IS-04-Label) des Mischers.
    pub mixer: String,
    /// Mischer-Ebene (1-basiert, nur bei Mehr-Ebenen-Mischern, 0 = ohne Präfix).
    #[serde(default)]
    pub level: u32,
    #[serde(default)]
    pub slot: u32,
    /// Quelle im PIP-Slot (Sender-ID, `pst:N` folgt dem Preset der Ebene N). Bei `kind` = `window` unbenutzt.
    #[serde(rename = "senderId", default)]
    pub sender_id: String,
    /// `pip` (Standard): die Zone führt einen PIP-Slot (Squeeze-back). `window`: die Zone ist das Fenster des
    /// Paternoster-Übergangs (`crosspoint.setTransWindow`, Kapitel 90.3).
    #[serde(default)]
    pub kind: String,
    /// Vorlage, für die die Bindung gilt (leer = jede Vorlage der Ebene, Altbestand). Gebundene Vorlagen sind nur aktiv, solange
    /// die Ebene diese Vorlage zeigt; beim Wechsel zurück gilt die Zuordnung wieder.
    #[serde(rename = "templateId", default)]
    pub template: String,
}

impl Binding {
    fn is_window(&self) -> bool {
        self.kind == "window"
    }
    /// `follow` (umgekehrte Richtung): Pose des PIP-Slots → Fenster/Rahmen der Grafik (Zonenname = Elementname, z. B. `pip1`).
    fn is_follow(&self) -> bool {
        self.kind == "follow"
    }
    fn key(&self) -> String {
        format!("{}/{}/{}", self.layer, self.template, self.zone)
    }
    fn method(&self, base: &str) -> String {
        if self.level == 0 { base.to_string() } else { format!("level{}.{base}", self.level) }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Applied {
    pub source_set: bool,
    pub enabled: bool,
    pub pose: Option<[i32; 4]>,
    /// `follow`: zuletzt an die Grafik gesendeter Datensatz (als Text) und Zeitpunkt der letzten Mischer-Abfrage.
    pub sig: String,
    pub polled: Option<Instant>,
    /// Zeitpunkt des letzten Sendens an die Grafik (für die regelmäßige Wiederholung des Stands).
    pub sent: Option<Instant>,
}

/// Der aktuelle Stand wird auch ohne Änderung in diesem Abstand erneut an die Grafik geschickt: ein verlorenes oder von der
/// Seite verworfenes Update heilt so von selbst (Seite stand sonst dauerhaft auf einer alten Pose).
const FOLLOW_RESYNC: Duration = Duration::from_millis(1000);

/// Abfrageabstand der `follow`-Bindungen am Mischer (Slot-Posen ändern sich nur bei Szenen/Fokus).
const FOLLOW_POLL: Duration = Duration::from_millis(40);
/// Takt des Arbeitsthreads, solange nur `follow`-Bindungen bestehen.
const FOLLOW_TICK: Duration = Duration::from_millis(20);

/// Liefert die Vorlage, die eine Ebene gerade zeigt (`None` = Ebene nicht on air).
pub type TemplateLookup = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Aktualisiert die Daten einer Grafik-Ebene (Node-intern, gesetzt nach dem Aufbau des Stores). `false` = Ebene nicht on air.
pub type Updater = Box<dyn Fn(&str, serde_json::Map<String, Value>) -> bool + Send + Sync>;

/// Zustand eines Slots aus `pip.slots`, normiert auf die Leinwand: `[x, y, b, h]` (0..1), sichtbar, vergrößert; `other_focus`:
/// ein anderer Slot ist vergrößert.
#[derive(Clone, Debug, PartialEq)]
pub struct SlotView {
    pub rect: [f64; 4],
    pub enabled: bool,
    pub focused: bool,
    pub other_focus: bool,
    /// Laufende Mischerfahrt: `[x,y,b,h]` von/nach (0..1), Startzeit (Unix-ms), Dauer (ms).
    pub anim: Option<([f64; 4], [f64; 4], u64, u64)>,
}

/// Liest den Slot aus `pip.slots`; `None`, wenn es ihn nicht gibt.
pub fn slot_view(slots: &Value, slot: u32, canvas: (u32, u32)) -> Option<SlotView> {
    let arr = slots.as_array()?;
    let me = arr.iter().find(|s| s["slot"].as_u64() == Some(slot as u64))?;
    let (cw, ch) = (canvas.0 as f64, canvas.1 as f64);
    let p = &me["pose"];
    let g = |k: &str| p[k].as_f64().unwrap_or(0.0);
    let norm = |p: &Value| -> [f64; 4] {
        let g = |k: &str| p[k].as_f64().unwrap_or(0.0);
        [g("x") / cw, g("y") / ch, g("width") / cw, g("height") / ch]
    };
    let anim = me.get("anim").filter(|a| a.is_object()).map(|a| (norm(&a["from"]), norm(&a["to"]), a["t0"].as_u64().unwrap_or(0), a["ms"].as_u64().unwrap_or(0)));
    Some(SlotView {
        anim,
        rect: [g("x") / cw, g("y") / ch, g("width") / cw, g("height") / ch],
        enabled: me["enabled"].as_bool().unwrap_or(false),
        focused: me["focused"].as_bool().unwrap_or(false),
        other_focus: arr.iter().any(|s| s["focused"].as_bool() == Some(true) && s["slot"].as_u64() != Some(slot as u64)),
    })
}

/// Datensatz für die Grafik: `<zone>Box` ("x,y,b,h"), `<zone>On`, `<zone>Dim`.
pub fn follow_data(zone: &str, v: &SlotView) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    let r = v.rect.map(|f| format!("{:.5}", f)).join(",");
    m.insert(format!("{zone}Box"), json!(r));
    m.insert(format!("{zone}On"), json!(v.enabled));
    m.insert(format!("{zone}Dim"), json!(v.other_focus));
    // Fahrt des Mischers: die Vorlage rechnet sie mit derselben Ease-in/out-Kurve nach (Zeitbezug Unix-ms).
    let anim = v.anim.map_or(String::new(), |(f, t, t0, ms)| {
        let n = |a: [f64; 4]| a.map(|x| format!("{:.5}", x)).join(",");
        format!("{},{},{},{}", n(f), n(t), t0, ms)
    });
    m.insert(format!("{zone}Anim"), json!(anim));
    m.insert("leadMs".to_string(), json!(follow_lead_ms()));
    m
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    SetSource(String),
    SetPose([i32; 4]),
    Enable(bool),
    /// Paternoster-Fenster des Mischers setzen (`Some`) oder löschen (`None`).
    SetWindow(Option<[i32; 4]>),
}

/// Zone = Elementname der Grafik (ohne Beachtung der Groß-/Kleinschreibung, „PIP1“ = `pip1`).
fn norm_zone(z: &str) -> String {
    z.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase()
}

/// Zone (normiert) → Rechteck in Mischer-Pixeln `[x, y, w, h]`; mindestens 2×2.
pub fn zone_box(z: &Zone, canvas: (u32, u32)) -> [i32; 4] {
    let (cw, ch) = (canvas.0 as f64, canvas.1 as f64);
    let x = (z.x * cw).round() as i32;
    let y = (z.y * ch).round() as i32;
    let w = ((z.w * cw).round() as i32).max(2);
    let h = ((z.h * ch).round() as i32).max(2);
    [x, y, w, h]
}

/// Entscheidet, was der Mischer tun muss, damit sein Slot zur Zone passt; schreibt den Soll-Stand nach `st`.
/// Reihenfolge beim Einschalten: Quelle, Pose, dann erst Einschalten (kein Aufblitzen an der falschen Stelle).
pub fn plan(b: &Binding, zone: Option<&Zone>, canvas: (u32, u32), st: &mut Applied) -> Vec<Action> {
    let visible = zone.filter(|z| z.o >= MIN_OPACITY && z.w > 0.0 && z.h > 0.0);
    let mut out = Vec::new();
    if b.is_window() {
        match visible {
            Some(z) => {
                let bx = zone_box(z, canvas);
                if st.pose != Some(bx) {
                    st.pose = Some(bx);
                    out.push(Action::SetWindow(Some(bx)));
                }
            }
            None if st.pose.is_some() => {
                st.pose = None;
                out.push(Action::SetWindow(None));
            }
            None => {}
        }
        return out;
    }
    let Some(z) = visible else {
        if st.enabled {
            st.enabled = false;
            out.push(Action::Enable(false));
        }
        return out;
    };
    if !st.source_set {
        st.source_set = true;
        out.push(Action::SetSource(b.sender_id.clone()));
    }
    let bx = zone_box(z, canvas);
    if st.pose != Some(bx) {
        st.pose = Some(bx);
        out.push(Action::SetPose(bx));
    }
    if !st.enabled {
        st.enabled = true;
        out.push(Action::Enable(true));
    }
    out
}

struct Entry {
    applied: Applied,
    last_error: String,
    /// Nachlauf: Zeit von der Meldung der Seite bis zum fertigen `pip.setPose`-Aufruf (ms), letzter und größter Wert.
    lag_ms: f64,
    lag_max_ms: f64,
    /// Zeitpunkt der Bindung: der Nachlauf zählt frühestens von hier (die Seite meldet eine ruhende Zone nur einmal).
    created: Instant,
    /// Von `unbind` markiert: der Slot wird noch ausgeschaltet, dann verschwindet die Bindung.
    unbound: bool,
}

struct Shared {
    updater: Arc<std::sync::OnceLock<Updater>>,
    lookup: Arc<std::sync::OnceLock<TemplateLookup>>,
    bindings: Mutex<BTreeMap<String, (Binding, Entry)>>,
    wake: Condvar,
}

/// Kopplungsverwaltung dieses Nodes: Bindungen + ein Arbeitsthread, der nur läuft, solange Bindungen bestehen.
#[derive(Clone)]
pub struct Layout {
    shared: Arc<Shared>,
}

impl Entry {
    fn new() -> Entry {
        Entry { applied: Applied::default(), last_error: String::new(), lag_ms: 0.0, lag_max_ms: 0.0, created: Instant::now(), unbound: false }
    }
}

impl Layout {
    pub fn new(registry: RegistryClient, zones: ZoneStore) -> Layout {
        let updater = Arc::new(std::sync::OnceLock::new());
        let shared = Arc::new(Shared { updater: updater.clone(), lookup: Default::default(), bindings: Mutex::new(BTreeMap::new()), wake: Condvar::new() });
        let weak = Arc::downgrade(&shared);
        std::thread::Builder::new()
            .name("omp-ograf-layout".into())
            .spawn(move || worker(weak, registry, zones, updater))
            .ok();
        Layout { shared }
    }

    /// Setzt den Rückweg in den Grafik-Speicher (nötig für `follow`); einmalig nach dem Aufbau des Stores.
    pub fn set_updater(&self, u: Updater) {
        let _ = self.shared.updater.set(u);
    }

    /// Setzt die Abfrage „welche Vorlage zeigt Ebene X“ (für Bindungen je Vorlage); einmalig nach dem Aufbau des Stores.
    pub fn set_template_lookup(&self, l: TemplateLookup) {
        let _ = self.shared.lookup.set(l);
    }

    pub fn bind(&self, b: Binding) -> Result<(), String> {
        if !matches!(b.kind.as_str(), "" | "pip" | "window" | "follow") {
            return Err("kind: pip, window oder follow".into());
        }
        if b.layer.is_empty() || b.zone.is_empty() || b.mixer.is_empty() || (!b.is_window() && !b.is_follow() && b.sender_id.is_empty()) {
            return Err("layerId, zone, mixer und (außer bei kind=window) senderId sind nötig".into());
        }
        if b.level > 16 || b.slot > 32 {
            return Err("level/slot außerhalb des Bereichs".into());
        }
        let mut map = self.shared.bindings.lock().expect("lock poisoned");
        // Eine geänderte Bindung (anderer Mischer/Slot/Quelle) beginnt von vorn.
        let key = b.key();
        if map.get(&key).is_none_or(|(old, e)| *old != b || e.unbound) {
            map.insert(key, (b, Entry::new()));
        }
        self.shared.wake.notify_all();
        Ok(())
    }

    /// Entfernt Bindungen einer Ebene (`zone` leer = alle); der Slot wird beim nächsten Takt ausgeschaltet.
    /// `template` leer = Bindungen aller Vorlagen der Ebene.
    pub fn unbind(&self, layer: &str, zone: &str, template: &str) {
        let mut map = self.shared.bindings.lock().expect("lock poisoned");
        for (_, e) in map.values_mut().filter(|(b, _)| b.layer == layer && (zone.is_empty() || b.zone == zone) && (template.is_empty() || b.template == template)) {
            e.unbound = true;
        }
        self.shared.wake.notify_all();
    }

    /// Aktive Bindungen für `GET /state` (Workflow-Sicherung).
    pub fn export(&self) -> Vec<Binding> {
        let map = self.shared.bindings.lock().expect("lock poisoned");
        map.values().filter(|(_, e)| !e.unbound).map(|(b, _)| b.clone()).collect()
    }

    /// Stellt Bindungen aus `{"layout":[…]}` wieder her; ungültige Einträge werden übersprungen.
    pub fn restore(&self, state: &Value) {
        let list = state.get("layout").and_then(Value::as_array).cloned().unwrap_or_default();
        for item in list {
            if let Ok(b) = serde_json::from_value::<Binding>(item) {
                let _ = self.bind(b);
            }
        }
    }

    /// Eine Bindung je Vorlage gilt nur, solange die Ebene diese Vorlage zeigt; ohne Vorlage gilt sie immer.
    fn is_active(&self, b: &Binding) -> bool {
        is_active(&self.shared.lookup, b)
    }

    pub fn to_json(&self) -> Value {
        let map = self.shared.bindings.lock().expect("lock poisoned");
        Value::Array(
            map.values()
                .filter(|(_, e)| !e.unbound)
                .map(|(b, e)| {
                    let mut v = serde_json::to_value(b).unwrap_or(Value::Null);
                    // PIP: Slot an; Fenster-Bindung: „aktiv“, solange ein Fenster am Mischer gesetzt ist
                    v["enabled"] = json!(e.applied.enabled || (b.is_window() && e.applied.pose.is_some()) || (b.is_follow() && !e.applied.sig.is_empty()));
                    v["active"] = json!(self.is_active(b));
                    v["error"] = json!(e.last_error);
                    v["lagMs"] = json!(e.lag_ms);
                    v["lagMaxMs"] = json!(e.lag_max_ms);
                    v
                })
                .collect(),
        )
    }
}

fn is_active(lookup: &std::sync::OnceLock<TemplateLookup>, b: &Binding) -> bool {
    b.template.is_empty() || lookup.get().is_some_and(|f| f(&b.layer).as_deref() == Some(b.template.as_str()))
}

struct MixerLink {
    peer: PeerClient,
    /// Je Bindungsebene gelesene Leinwandgröße.
    canvas: BTreeMap<u32, (u32, u32)>,
    /// Zuletzt gelesenes `pip.slots` (für alle `follow`-Bindungen dieses Mischers gemeinsam).
    slots: Option<(Instant, Value)>,
}

fn worker(weak: std::sync::Weak<Shared>, registry: RegistryClient, zones: ZoneStore, updater: Arc<std::sync::OnceLock<Updater>>) {
    let mut links: BTreeMap<String, MixerLink> = BTreeMap::new();
    loop {
        let Some(shared) = weak.upgrade() else { return };
        // Bindungen kopieren, damit der Mutex bei den HTTP-Aufrufen frei bleibt.
        let work: Vec<(String, Binding, Applied, bool, Instant)> = {
            let mut map = shared.bindings.lock().expect("lock poisoned");
            while map.is_empty() {
                let (g, _) = shared.wake.wait_timeout(map, Duration::from_secs(5)).expect("lock poisoned");
                map = g;
                if Arc::strong_count(&shared) == 1 {
                    return; // Layout wurde freigegeben
                }
            }
            map.iter().map(|(k, (b, e))| (k.clone(), b.clone(), e.applied.clone(), e.unbound, e.created)).collect()
        };
        // Nur `follow`-Bindungen fragen den Mischer ohnehin höchstens alle 40 ms ab — dann genügt ein längerer Takt (CPU).
        let fast = work.iter().any(|(_, b, _, _, _)| !b.is_follow());
        // Fahrten des Mischers beginnen um Vorlauf + Reserve später, damit die Seite sie von Anfang an mitfahren kann.
        if LEAD_DIRTY.swap(false, std::sync::atomic::Ordering::Relaxed) {
            let delay = follow_lead_ms() + START_MARGIN_MS;
            for link in links.values() {
                let _ = link.peer.invoke_with("pip.setAnimDelay", json!({"ms": delay}));
            }
        }
        for (key, b, mut st, unbound, created) in work {
            if !unbound && !is_active(&shared.lookup, &b) {
                continue; // Vorlage der Ebene ist eine andere: Bindung ruht, bleibt aber gespeichert
            }
            let result = run_one(&mut links, &registry, &zones, &updater, &b, &mut st, unbound, created);
            let mut map = shared.bindings.lock().expect("lock poisoned");
            if let Some((cur, e)) = map.get_mut(&key) {
                if *cur != b {
                    continue; // inzwischen neu gebunden
                }
                e.applied = st;
                if !unbound {
                    match result {
                        Ok(lag) => {
                            e.last_error = String::new();
                            if let Some(ms) = lag {
                                e.lag_ms = ms;
                                e.lag_max_ms = e.lag_max_ms.max(ms);
                            }
                        }
                        Err(err) => e.last_error = err,
                    }
                } else {
                    map.remove(&key);
                }
            }
        }
        drop(shared);
        std::thread::sleep(if fast { TICK } else { FOLLOW_TICK });
    }
}

fn run_one(
    links: &mut BTreeMap<String, MixerLink>,
    registry: &RegistryClient,
    zones: &ZoneStore,
    updater: &std::sync::OnceLock<Updater>,
    b: &Binding,
    st: &mut Applied,
    unbound: bool,
    created: Instant,
) -> Result<Option<f64>, String> {
    if !links.contains_key(&b.mixer) {
        let node = registry
            .list_nodes()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|n| n.label == b.mixer)
            .ok_or_else(|| format!("Mischer „{}“ nicht gefunden", b.mixer))?;
        let peer = PeerClient::new(node.href);
        if b.is_follow() {
            let _ = peer.invoke_with("pip.setAnimDelay", json!({"ms": follow_lead_ms() + START_MARGIN_MS}));
        }
        links.insert(b.mixer.clone(), MixerLink { peer, canvas: BTreeMap::new(), slots: None });
    }
    let link = links.get_mut(&b.mixer).ok_or("kein Mischer")?;
    let canvas = match link.canvas.get(&b.level) {
        Some(c) => *c,
        None => {
            let v = link.peer.get_param(&b.method("pip.canvas")).map_err(|e| e.to_string())?;
            let c = (v["width"].as_u64().unwrap_or(0) as u32, v["height"].as_u64().unwrap_or(0) as u32);
            if c.0 == 0 || c.1 == 0 {
                return Err("pip.canvas unbekannt".into());
            }
            link.canvas.insert(b.level, c);
            c
        }
    };
    if b.is_follow() {
        if unbound {
            return Ok(None);
        }
        if st.polled.is_some_and(|t| t.elapsed() < FOLLOW_POLL) {
            return Ok(None);
        }
        st.polled = Some(Instant::now());
        let slots = match link.slots.as_ref().filter(|(t, _)| t.elapsed() < FOLLOW_POLL) {
            Some((_, v)) => v.clone(),
            None => {
                let v = link.peer.get_param(&b.method("pip.slots")).map_err(|e| e.to_string());
                let v = match v {
                    Ok(v) => v,
                    Err(e) => {
                        links.remove(&b.mixer);
                        return Err(e);
                    }
                };
                link.slots = Some((Instant::now(), v.clone()));
                v
            }
        };
        let view = slot_view(&slots, b.slot, canvas).ok_or_else(|| format!("Slot {} am Mischer nicht vorhanden", b.slot))?;
        let data = follow_data(&norm_zone(&b.zone), &view);
        let sig = serde_json::to_string(&data).unwrap_or_default();
        if sig != st.sig || st.sent.is_none_or(|t| t.elapsed() >= FOLLOW_RESYNC) {
            let up = updater.get().ok_or("Grafikspeicher noch nicht bereit")?;
            if up(&b.layer, data) {
                st.sig = sig; // nicht on air: beim nächsten Takt erneut versuchen
                st.sent = Some(Instant::now());
            }
        }
        return Ok(None);
    }
    let (layer_zones, seen) = if unbound { (Vec::new(), None) } else { zones.layer_seen(&b.layer) };
    let zone = layer_zones.into_iter().find(|z| z.id == b.zone);
    let mut next = st.clone();
    let actions = plan(b, zone.as_ref(), canvas, &mut next);
    for a in &actions {
        let r = match a {
            Action::SetSource(id) => link.peer.invoke_with(&b.method("pip.setSource"), json!({"senderId": id, "slot": b.slot})),
            Action::SetPose([x, y, w, h]) => link.peer.invoke_with(
                &b.method("pip.setPose"),
                json!({"pose": json!({"x": x, "y": y, "width": w, "height": h}).to_string(), "slot": b.slot}),
            ),
            Action::Enable(on) => link.peer.invoke_with(&b.method("pip.setEnabled"), json!({"enabled": on, "slot": b.slot})),
            Action::SetWindow(Some([x, y, w, h])) => {
                link.peer.invoke_with(&b.method("crosspoint.setTransWindow"), json!({"x": x, "y": y, "width": w, "height": h}))
            }
            Action::SetWindow(None) => link.peer.invoke_with(&b.method("crosspoint.setTransWindow"), json!({})),
        };
        if let Err(e) = r {
            // Beim Fehler den Mischer neu auflösen (Instanz kann neu gestartet sein) und von vorn beginnen.
            links.remove(&b.mixer);
            *st = Applied::default();
            return Err(e.to_string());
        }
    }
    *st = next;
    let moved = actions.iter().any(|a| matches!(a, Action::SetPose(_) | Action::SetWindow(Some(_))));
    Ok(seen.filter(|_| moved).map(|t| Instant::now().duration_since(t.max(created)).as_secs_f64() * 1000.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b() -> Binding {
        Binding { layer: "L1".into(), zone: "box".into(), mixer: "M".into(), level: 0, slot: 1, sender_id: "S".into(), kind: String::new(), template: String::new() }
    }
    fn z(o: f64) -> Zone {
        Zone { id: "box".into(), x: 0.0625, y: 0.375, w: 0.25, h: 1.0 / 3.0, o }
    }

    #[test]
    fn maps_zone_to_mixer_pixels() {
        assert_eq!(zone_box(&z(1.0), (1920, 1080)), [120, 405, 480, 360]);
        let tiny = Zone { id: "t".into(), x: 0.0, y: 0.0, w: 0.0, h: 0.0, o: 1.0 };
        assert_eq!(zone_box(&tiny, (1920, 1080)), [0, 0, 2, 2]);
    }

    #[test]
    fn enables_after_source_and_pose_then_only_moves() {
        let mut st = Applied::default();
        let a = plan(&b(), Some(&z(1.0)), (1920, 1080), &mut st);
        assert_eq!(a, vec![Action::SetSource("S".into()), Action::SetPose([120, 405, 480, 360]), Action::Enable(true)]);
        assert!(plan(&b(), Some(&z(1.0)), (1920, 1080), &mut st).is_empty());
        let moved = Zone { x: 0.5, ..z(1.0) };
        assert_eq!(plan(&b(), Some(&moved), (1920, 1080), &mut st), vec![Action::SetPose([960, 405, 480, 360])]);
    }

    #[test]
    fn disables_when_zone_vanishes_or_fades_and_reenables_without_resending_source() {
        let mut st = Applied::default();
        plan(&b(), Some(&z(1.0)), (1920, 1080), &mut st);
        assert_eq!(plan(&b(), Some(&z(0.0)), (1920, 1080), &mut st), vec![Action::Enable(false)]);
        assert!(plan(&b(), None, (1920, 1080), &mut st).is_empty());
        assert_eq!(plan(&b(), Some(&z(1.0)), (1920, 1080), &mut st), vec![Action::Enable(true)]);
    }

    #[test]
    fn window_binding_sets_and_clears_the_transition_window() {
        let w = Binding { kind: "window".into(), sender_id: String::new(), ..b() };
        let mut st = Applied::default();
        assert_eq!(plan(&w, Some(&z(1.0)), (1920, 1080), &mut st), vec![Action::SetWindow(Some([120, 405, 480, 360]))]);
        assert!(plan(&w, Some(&z(1.0)), (1920, 1080), &mut st).is_empty());
        assert_eq!(plan(&w, None, (1920, 1080), &mut st), vec![Action::SetWindow(None)]);
        assert!(plan(&w, None, (1920, 1080), &mut st).is_empty());
        let l = Layout { shared: Arc::new(Shared { updater: Default::default(), lookup: Default::default(), bindings: Mutex::new(BTreeMap::new()), wake: Condvar::new() }) };
        assert!(l.bind(w).is_ok());
        assert!(l.bind(Binding { kind: "x".into(), ..b() }).is_err());
    }

    #[test]
    fn follow_maps_slot_pose_to_graphic_data() {
        let slots = json!([
            {"slot":0,"enabled":true,"focused":false,"pose":{"x":0,"y":467,"width":427,"height":240}},
            {"slot":1,"enabled":true,"focused":true,"pose":{"x":38,"y":22,"width":1204,"height":676}}
        ]);
        let v0 = slot_view(&slots, 0, (1280, 720)).unwrap();
        assert!(v0.enabled && !v0.focused && v0.other_focus);
        let d = follow_data(&norm_zone(" PIP1"), &v0);
        assert_eq!(d["pip1Box"], "0.00000,0.64861,0.33359,0.33333");
        assert_eq!(d["pip1Dim"], true);
        let v1 = slot_view(&slots, 1, (1280, 720)).unwrap();
        assert!(v1.focused && !v1.other_focus);
        assert!(slot_view(&slots, 7, (1280, 720)).is_none());
        let l = Layout { shared: Arc::new(Shared { updater: Default::default(), lookup: Default::default(), bindings: Mutex::new(BTreeMap::new()), wake: Condvar::new() }) };
        assert!(l.bind(Binding { kind: "follow".into(), sender_id: String::new(), ..b() }).is_ok());
    }

    #[test]
    fn level_prefix_and_validation() {
        let mut x = b();
        assert_eq!(x.method("pip.setPose"), "pip.setPose");
        x.level = 2;
        assert_eq!(x.method("pip.setPose"), "level2.pip.setPose");
        let l = Layout { shared: Arc::new(Shared { updater: Default::default(), lookup: Default::default(), bindings: Mutex::new(BTreeMap::new()), wake: Condvar::new() }) };
        assert!(l.bind(Binding { sender_id: String::new(), ..b() }).is_err());
        assert!(l.bind(b()).is_ok());
        assert_eq!(l.to_json().as_array().unwrap().len(), 1);
        let saved = serde_json::json!({"layout": l.export()});
        assert_eq!(saved["layout"][0]["senderId"], "S");
        l.unbind("L1", "", "");
        assert!(l.to_json().as_array().unwrap().is_empty());
        assert!(l.export().is_empty());
        l.restore(&saved);
        assert_eq!(l.export(), vec![b()]);
        l.restore(&serde_json::json!({"layout": [{"nonsense": 1}]})); // ungültig: übersprungen
        assert_eq!(l.export().len(), 1);
    }

    #[test]
    fn bindings_per_template_are_separate_and_follow_the_layer() {
        let l = Layout { shared: Arc::new(Shared { updater: Default::default(), lookup: Default::default(), bindings: Mutex::new(BTreeMap::new()), wake: Condvar::new() }) };
        let shown = Arc::new(Mutex::new(Some("wand".to_string())));
        let s2 = shown.clone();
        l.set_template_lookup(Box::new(move |_| s2.lock().unwrap().clone()));
        assert!(l.bind(Binding { template: "wand".into(), slot: 1, ..b() }).is_ok());
        assert!(l.bind(Binding { template: "rahmen".into(), slot: 2, ..b() }).is_ok());
        assert_eq!(l.export().len(), 2); // gleiche Ebene + Zone, zwei Vorlagen: zwei Bindungen
        let active = |l: &Layout| l.to_json().as_array().unwrap().iter().filter(|v| v["active"] == true).map(|v| v["templateId"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(active(&l), vec!["wand"]);
        *shown.lock().unwrap() = Some("rahmen".into());
        assert_eq!(active(&l), vec!["rahmen"]);
        *shown.lock().unwrap() = None; // Ebene nicht on air: nichts aktiv
        assert!(active(&l).is_empty());
        l.unbind("L1", "box", "wand");
        assert_eq!(l.export().len(), 1);
        assert_eq!(l.export()[0].template, "rahmen");
    }
}
