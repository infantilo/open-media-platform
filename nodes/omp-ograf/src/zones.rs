//! Layout-Zonen (Kapitel 90.1): Vorlagen markieren Rechtecke mit `data-ograf-zone="<id>"` (Altname `data-dve-zone`). Die
//! Harness-Seite misst sie live (auch während einer CSS-Animation) und meldet sie per POST an den Loopback-Server dieses
//! Nodes. Hier liegt der gemeinsame Speicher: der Harness-Server schreibt, `OgrafStore` liest (Property `zones`).
//!
//! OGraf v1 kennt keine Zonen (Spezifikation gelesen); das ist eine Erweiterung, andere Systeme ignorieren die Attribute.
//! Alle Werte sind auf die Seitengröße normiert (0..1, links oben), `o` ist die Deckkraft des Elements (0..1).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use omp_node_sdk::RawResponse;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ZONES_PATH: &str = "/ograf-zones";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default = "one")]
    pub o: f64,
}

fn one() -> f64 {
    1.0
}

#[derive(Deserialize)]
struct Report {
    layer: String,
    #[serde(default)]
    remove: bool,
    #[serde(default)]
    zones: Vec<Zone>,
}

/// Ebene → Zonen. Klein (wenige Ebenen, wenige Zonen), ein Mutex genügt.
#[derive(Clone, Default)]
pub struct ZoneStore(Arc<Mutex<BTreeMap<String, (Vec<Zone>, Instant)>>>);

impl ZoneStore {
    /// Übernimmt eine Meldung der Harness-Seite. Ungültige oder nicht endliche Werte werden verworfen (Fehlertext).
    pub fn apply(&self, body: &[u8]) -> Result<(), String> {
        let r: Report = serde_json::from_slice(body).map_err(|e| format!("zones: {e}"))?;
        if r.layer.is_empty() || r.layer.len() > 128 {
            return Err("zones: layer fehlt".into());
        }
        let mut map = self.0.lock().expect("lock poisoned");
        if r.remove || r.zones.is_empty() {
            map.remove(&r.layer);
            return Ok(());
        }
        let ok = r.zones.iter().all(|z| {
            !z.id.is_empty() && z.id.len() <= 64 && [z.x, z.y, z.w, z.h, z.o].iter().all(|v| v.is_finite())
        });
        if !ok || r.zones.len() > 32 {
            return Err("zones: ungueltige Zone".into());
        }
        map.insert(r.layer, (r.zones, Instant::now()));
        Ok(())
    }

    /// Eine Ebene vergessen (Node blendet sie aus).
    pub fn clear(&self, layer: &str) {
        self.0.lock().expect("lock poisoned").remove(layer);
    }

    pub fn clear_all(&self) {
        self.0.lock().expect("lock poisoned").clear();
    }

    /// `{ "<layerId>": [ {id,x,y,w,h,o}, … ] }`
    pub fn to_json(&self) -> Value {
        let map = self.0.lock().expect("lock poisoned");
        let zones: BTreeMap<&String, &Vec<Zone>> = map.iter().map(|(k, (z, _))| (k, z)).collect();
        serde_json::to_value(zones).unwrap_or(Value::Null)
    }

    /// Zonen einer Ebene (Kopie).
    #[cfg(test)]
    pub fn layer(&self, layer: &str) -> Vec<Zone> {
        self.layer_seen(layer).0
    }

    /// Zonen einer Ebene und der Zeitpunkt, an dem der Node die letzte Meldung der Seite erhielt (für die Nachlaufmessung).
    pub fn layer_seen(&self, layer: &str) -> (Vec<Zone>, Option<Instant>) {
        match self.0.lock().expect("lock poisoned").get(layer) {
            Some((z, t)) => (z.clone(), Some(*t)),
            None => (Vec::new(), None),
        }
    }
}

/// `POST /ograf-zones` des Harness-Servers; sonst `None`.
pub fn route(store: &ZoneStore, method: &str, path: &str, body: &[u8]) -> Option<RawResponse> {
    if method != "POST" || path != ZONES_PATH {
        return None;
    }
    let (status, text) = match store.apply(body) {
        Ok(()) => (204, String::new()),
        Err(e) => (400, e),
    };
    Some(RawResponse { status, content_type: "text/plain", body: text.into_bytes() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(s: &ZoneStore, v: Value) -> Option<RawResponse> {
        route(s, "POST", ZONES_PATH, v.to_string().as_bytes())
    }

    #[test]
    fn stores_and_removes_layer_zones() {
        let s = ZoneStore::default();
        let r = post(&s, serde_json::json!({"layer":"L1","zones":[{"id":"box","x":0.1,"y":0.2,"w":0.3,"h":0.4,"o":0.5}]})).unwrap();
        assert_eq!(r.status, 204);
        assert_eq!(s.layer("L1")[0].w, 0.3);
        assert_eq!(s.to_json()["L1"][0]["id"], "box");
        post(&s, serde_json::json!({"layer":"L1","remove":true}));
        assert!(s.layer("L1").is_empty());
        assert_eq!(s.to_json(), serde_json::json!({}));
    }

    #[test]
    fn missing_opacity_defaults_to_one() {
        let s = ZoneStore::default();
        post(&s, serde_json::json!({"layer":"L","zones":[{"id":"a","x":0,"y":0,"w":1,"h":1}]}));
        assert_eq!(s.layer("L")[0].o, 1.0);
    }

    #[test]
    fn rejects_garbage_and_wrong_route() {
        let s = ZoneStore::default();
        assert_eq!(route(&s, "POST", ZONES_PATH, b"{").unwrap().status, 400);
        assert_eq!(post(&s, serde_json::json!({"layer":"","zones":[]})).unwrap().status, 400);
        assert_eq!(post(&s, serde_json::json!({"layer":"L","zones":[{"id":"","x":0,"y":0,"w":1,"h":1}]})).unwrap().status, 400);
        assert!(route(&s, "GET", ZONES_PATH, b"").is_none());
        assert!(route(&s, "POST", "/x", b"").is_none());
        assert!(s.to_json().as_object().unwrap().is_empty());
    }
}
