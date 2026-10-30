//! Kartenerkennung für den Start-Assistenten: `omp-capture-card --list-cards` gibt die Anschlüsse
//! der Herstellerplugins als JSON aus. Der Host-Agent ruft das auf und meldet jeden Anschluss als
//! I/O-Port (`<Gerät>-in` / `<Gerät>-out`) — Duplex-Karten liefern beide.
//!
//! Die Plugins melden Geräte über GStreamer-Geräteanbieter: Quellen ("Video/Source") sind Eingänge,
//! Senken ("Video/Sink") Ausgänge. Gerätenummer: Eigenschaft `device-number`, sonst Laufnummer je Klasse.
//! Ohne Karte oder Plugin ist die Liste leer (kein Fehler). Nicht an Hardware geprüft.

use gstreamer as gst;
use gst::prelude::*;

use crate::ports::Dir;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Connector {
    /// `decklink` | `aja` — der `cardType` des I/O-Ports.
    pub vendor: String,
    pub device: i32,
    pub dir: &'static str,
    pub name: String,
}

/// Gerätebeschreibung eines Anbieters (für Tests ohne GStreamer-Geräte).
#[derive(Clone, Debug)]
pub struct Found {
    pub vendor: &'static str,
    pub class: String,
    pub number: Option<i32>,
    pub name: String,
}

/// Rein: Geräte → Anschlüsse (Laufnummer je Hersteller und Richtung, wenn das Plugin keine Nummer meldet).
pub fn connectors(found: &[Found]) -> Vec<Connector> {
    let mut out: Vec<Connector> = Vec::new();
    let mut counters: std::collections::HashMap<(&str, Dir), i32> = Default::default();
    for f in found {
        if !f.class.starts_with("Video/") {
            continue;
        }
        let dir = if f.class.contains("Sink") {
            Dir::Out
        } else if f.class.contains("Source") {
            Dir::In
        } else {
            continue;
        };
        let n = match f.number {
            Some(n) => n,
            None => {
                let c = counters.entry((f.vendor, dir)).or_insert(0);
                let n = *c;
                *c += 1;
                n
            }
        };
        let c = Connector { vendor: f.vendor.into(), device: n, dir: if dir == Dir::In { "in" } else { "out" }, name: f.name.clone() };
        if !out.contains(&c) {
            out.push(c);
        }
    }
    out.sort_by(|a, b| (a.vendor.as_str(), a.device, a.dir).cmp(&(b.vendor.as_str(), b.device, b.dir)));
    out
}

pub fn to_json(list: &[Connector]) -> String {
    serde_json::Value::Array(
        list.iter().map(|c| serde_json::json!({"vendor": c.vendor, "device": c.device, "dir": c.dir, "name": c.name})).collect(),
    )
    .to_string()
}

const PROVIDERS: &[(&str, &str)] = &[("decklinkdeviceprovider", "decklink"), ("ajadeviceprovider", "aja")];

/// Fragt die installierten Herstellerplugins ab.
pub fn scan() -> Vec<Connector> {
    if gst::init().is_err() {
        return Vec::new();
    }
    let mut found = Vec::new();
    for (provider, vendor) in PROVIDERS {
        let Some(factory) = gst::DeviceProviderFactory::find(provider) else { continue };
        let Some(p) = factory.get() else { continue };
        for d in p.devices() {
            let number = d
                .properties()
                .and_then(|s| s.get::<i32>("device-number").ok().or_else(|| s.get::<u32>("device-number").ok().map(|v| v as i32)));
            found.push(Found { vendor, class: d.device_class().to_string(), number, name: d.display_name().to_string() });
        }
    }
    connectors(&found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(vendor: &'static str, class: &str, number: Option<i32>, name: &str) -> Found {
        Found { vendor, class: class.into(), number, name: name.into() }
    }

    #[test]
    fn duplex_card_gets_in_and_out() {
        let c = connectors(&[f("decklink", "Video/Source", Some(0), "DeckLink Duo 2"), f("decklink", "Video/Sink", Some(0), "DeckLink Duo 2")]);
        assert_eq!(c.iter().map(|c| format!("{}:{}", c.device, c.dir)).collect::<Vec<_>>(), ["0:in", "0:out"]);
    }

    #[test]
    fn numbers_fall_back_to_running_index_per_direction() {
        let c = connectors(&[
            f("aja", "Video/Source", None, "KONA"),
            f("aja", "Video/Source", None, "KONA"),
            f("aja", "Video/Sink", None, "KONA"),
            f("aja", "Audio/Source", Some(5), "x"),
        ]);
        let s: Vec<_> = c.iter().map(|c| format!("{}:{}:{}", c.vendor, c.device, c.dir)).collect();
        assert_eq!(s, ["aja:0:in", "aja:0:out", "aja:1:in"]);
    }

    #[test]
    fn scan_without_cards_is_empty() {
        assert!(scan().is_empty());
    }
}
