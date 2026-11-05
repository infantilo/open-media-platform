//! Layout-Kopplung (Kapitel 90.2): eine gemessene Zone einer Grafik-Ebene (`zones.rs`) führt einen PIP-Slot des Bildmischers.
//! Das ist der Squeeze-back: die Vorlage zeichnet nur den Rahmen mit einem Fenster (`data-ograf-zone`), der Mischer legt die
//! gewählte Quelle in den Slot und fährt ihn auf das Fenster. Folgt die Zone einer CSS-Animation, folgt der Slot ihr bildweise.
//!
//! Aufrufe gehen über die Descriptor-API des Mischers (`pip.setSource`, `pip.setPose`, `pip.setEnabled`). Verzögerung gegenüber
//! der Grafik: Messung + ein HTTP-Aufruf je Änderung (Größe der Verzögerung **nicht gemessen**, s. UMSETZUNG.md 90.2). Die Bewegung selbst fährt die
//! Vorlage; ein vorausberechnetes, vom Mischer gefahrenes Fenster ist ein möglicher Ausbau (90.3).

use std::collections::BTreeMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use omp_node_sdk::is04::RegistryClient;
use omp_node_sdk::peer::PeerClient;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::zones::{Zone, ZoneStore};

/// Eine Zone darunter gilt als unsichtbar (Slot aus).
const MIN_OPACITY: f64 = 0.02;
/// Takt der Nachführung (ein Bild bei 25 fps).
const TICK: Duration = Duration::from_millis(40);

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
    /// Quelle im PIP-Slot (Sender-ID).
    #[serde(rename = "senderId")]
    pub sender_id: String,
}

impl Binding {
    fn key(&self) -> String {
        format!("{}/{}", self.layer, self.zone)
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
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    SetSource(String),
    SetPose([i32; 4]),
    Enable(bool),
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

#[derive(Default)]
struct Entry {
    applied: Applied,
    last_error: String,
    /// Von `unbind` markiert: der Slot wird noch ausgeschaltet, dann verschwindet die Bindung.
    unbound: bool,
}

struct Shared {
    bindings: Mutex<BTreeMap<String, (Binding, Entry)>>,
    wake: Condvar,
}

/// Kopplungsverwaltung dieses Nodes: Bindungen + ein Arbeitsthread, der nur läuft, solange Bindungen bestehen.
#[derive(Clone)]
pub struct Layout {
    shared: Arc<Shared>,
}

impl Layout {
    pub fn new(registry: RegistryClient, zones: ZoneStore) -> Layout {
        let shared = Arc::new(Shared { bindings: Mutex::new(BTreeMap::new()), wake: Condvar::new() });
        let weak = Arc::downgrade(&shared);
        std::thread::Builder::new()
            .name("omp-ograf-layout".into())
            .spawn(move || worker(weak, registry, zones))
            .ok();
        Layout { shared }
    }

    pub fn bind(&self, b: Binding) -> Result<(), String> {
        if b.layer.is_empty() || b.zone.is_empty() || b.mixer.is_empty() || b.sender_id.is_empty() {
            return Err("layerId, zone, mixer und senderId sind nötig".into());
        }
        if b.level > 16 || b.slot > 32 {
            return Err("level/slot außerhalb des Bereichs".into());
        }
        let mut map = self.shared.bindings.lock().expect("lock poisoned");
        // Eine geänderte Bindung (anderer Mischer/Slot/Quelle) beginnt von vorn.
        let key = b.key();
        if map.get(&key).is_none_or(|(old, _)| *old != b) {
            map.insert(key, (b, Entry::default()));
        }
        self.shared.wake.notify_all();
        Ok(())
    }

    /// Entfernt Bindungen einer Ebene (`zone` leer = alle); der Slot wird beim nächsten Takt ausgeschaltet.
    pub fn unbind(&self, layer: &str, zone: &str) {
        let mut map = self.shared.bindings.lock().expect("lock poisoned");
        for (_, e) in map.values_mut().filter(|(b, _)| b.layer == layer && (zone.is_empty() || b.zone == zone)) {
            e.unbound = true;
        }
        self.shared.wake.notify_all();
    }

    pub fn to_json(&self) -> Value {
        let map = self.shared.bindings.lock().expect("lock poisoned");
        Value::Array(
            map.values()
                .filter(|(_, e)| !e.unbound)
                .map(|(b, e)| {
                    let mut v = serde_json::to_value(b).unwrap_or(Value::Null);
                    v["enabled"] = json!(e.applied.enabled);
                    v["error"] = json!(e.last_error);
                    v
                })
                .collect(),
        )
    }
}

struct MixerLink {
    peer: PeerClient,
    /// Je Bindungsebene gelesene Leinwandgröße.
    canvas: BTreeMap<u32, (u32, u32)>,
}

fn worker(weak: std::sync::Weak<Shared>, registry: RegistryClient, zones: ZoneStore) {
    let mut links: BTreeMap<String, MixerLink> = BTreeMap::new();
    loop {
        let Some(shared) = weak.upgrade() else { return };
        // Bindungen kopieren, damit der Mutex bei den HTTP-Aufrufen frei bleibt.
        let work: Vec<(String, Binding, Applied, bool)> = {
            let mut map = shared.bindings.lock().expect("lock poisoned");
            while map.is_empty() {
                let (g, _) = shared.wake.wait_timeout(map, Duration::from_secs(5)).expect("lock poisoned");
                map = g;
                if Arc::strong_count(&shared) == 1 {
                    return; // Layout wurde freigegeben
                }
            }
            map.iter().map(|(k, (b, e))| (k.clone(), b.clone(), e.applied.clone(), e.unbound)).collect()
        };
        for (key, b, mut st, unbound) in work {
            let result = run_one(&mut links, &registry, &zones, &b, &mut st, unbound);
            let mut map = shared.bindings.lock().expect("lock poisoned");
            if let Some((cur, e)) = map.get_mut(&key) {
                if *cur != b {
                    continue; // inzwischen neu gebunden
                }
                e.applied = st;
                if !unbound {
                    e.last_error = result.err().unwrap_or_default();
                } else {
                    map.remove(&key);
                }
            }
        }
        drop(shared);
        std::thread::sleep(TICK);
    }
}

fn run_one(
    links: &mut BTreeMap<String, MixerLink>,
    registry: &RegistryClient,
    zones: &ZoneStore,
    b: &Binding,
    st: &mut Applied,
    unbound: bool,
) -> Result<(), String> {
    if !links.contains_key(&b.mixer) {
        let node = registry
            .list_nodes()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|n| n.label == b.mixer)
            .ok_or_else(|| format!("Mischer „{}“ nicht gefunden", b.mixer))?;
        links.insert(b.mixer.clone(), MixerLink { peer: PeerClient::new(node.href), canvas: BTreeMap::new() });
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
    let zone = if unbound { None } else { zones.layer(&b.layer).into_iter().find(|z| z.id == b.zone) };
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
        };
        if let Err(e) = r {
            // Beim Fehler den Mischer neu auflösen (Instanz kann neu gestartet sein) und von vorn beginnen.
            links.remove(&b.mixer);
            *st = Applied::default();
            return Err(e.to_string());
        }
    }
    *st = next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b() -> Binding {
        Binding { layer: "L1".into(), zone: "box".into(), mixer: "M".into(), level: 0, slot: 1, sender_id: "S".into() }
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
    fn level_prefix_and_validation() {
        let mut x = b();
        assert_eq!(x.method("pip.setPose"), "pip.setPose");
        x.level = 2;
        assert_eq!(x.method("pip.setPose"), "level2.pip.setPose");
        let l = Layout { shared: Arc::new(Shared { bindings: Mutex::new(BTreeMap::new()), wake: Condvar::new() }) };
        assert!(l.bind(Binding { sender_id: String::new(), ..b() }).is_err());
        assert!(l.bind(b()).is_ok());
        assert_eq!(l.to_json().as_array().unwrap().len(), 1);
        l.unbind("L1", "");
        assert!(l.to_json().as_array().unwrap().is_empty());
    }
}
