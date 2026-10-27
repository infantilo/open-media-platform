//! Momentaufnahme einer GStreamer-Pipeline für die Diagnose (UMSETZUNG.md Kap. 72.7): Elemente mit Zustand, Verbindungen mit
//! ausgehandelten Caps, Füllstand von Queues und appsrc. Nur Lesen — keine Probes, keine Eingriffe in den Datenpfad.

use gstreamer as gst;
use gstreamer::prelude::*;
use serde_json::{Value, json};

const MAX_CAPS_CHARS: usize = 160;

fn state_name(e: &gst::Element) -> &'static str {
    match e.state(gst::ClockTime::ZERO).1 {
        gst::State::Null => "Null",
        gst::State::Ready => "Ready",
        gst::State::Paused => "Paused",
        gst::State::Playing => "Playing",
        _ => "VoidPending",
    }
}

fn caps_text(pad: &gst::Pad) -> Option<String> {
    pad.current_caps().map(|c| {
        let s = c.to_string();
        if s.chars().count() > MAX_CAPS_CHARS { s.chars().take(MAX_CAPS_CHARS).collect::<String>() + "…" } else { s }
    })
}

/// Liest eine ganzzahlige Eigenschaft, falls das Element sie hat (kein Panic bei fehlender Eigenschaft).
fn uint_prop(e: &gst::Element, name: &str) -> Option<u64> {
    e.find_property(name)?;
    let v = e.property_value(name);
    v.get::<u32>().map(u64::from).or_else(|_| v.get::<u64>()).or_else(|_| v.get::<i32>().map(|n| n.max(0) as u64)).ok()
}

fn element_json(e: &gst::Element) -> Value {
    let factory = e.factory().map(|f| f.name().to_string()).unwrap_or_default();
    let mut pads = Vec::new();
    for pad in e.pads() {
        let peer = pad.peer().and_then(|p| p.parent_element().map(|pe| format!("{}.{}", pe.name(), p.name())));
        pads.push(json!({
            "name": pad.name().as_str(),
            "dir": if pad.direction() == gst::PadDirection::Src { "src" } else { "sink" },
            "peer": peer,
            "caps": caps_text(&pad),
        }));
    }
    let mut v = json!({
        "name": e.name().as_str(),
        "factory": factory,
        "state": state_name(e),
        "parent": e.parent().map(|p| p.name().to_string()),
        "pads": pads,
    });
    // Füllstände: ein volles oder leeres Queue-Glied zeigt, wo der Fluss stockt.
    if matches!(factory.as_str(), "queue" | "queue2" | "multiqueue" | "appsrc") {
        let mut level = serde_json::Map::new();
        for (key, prop) in [
            ("buffers", "current-level-buffers"),
            ("bytes", "current-level-bytes"),
            ("timeNs", "current-level-time"),
            ("maxBuffers", "max-size-buffers"),
            ("maxBytes", "max-size-bytes"),
            ("maxTimeNs", "max-size-time"),
        ] {
            if let Some(n) = uint_prop(e, prop) {
                level.insert(key.into(), json!(n));
            }
        }
        if !level.is_empty() {
            v["level"] = Value::Object(level);
        }
    }
    v
}

/// Zustand der ganzen Pipeline samt aller Elemente (rekursiv durch Bins).
pub fn snapshot(pipeline: &gst::Pipeline) -> Value {
    let mut elements: Vec<Value> = Vec::new();
    let mut iter = pipeline.iterate_recurse();
    loop {
        match iter.next() {
            Ok(Some(e)) => elements.push(element_json(&e)),
            Ok(None) => break,
            Err(gst::IteratorError::Resync) => {
                elements.clear();
                iter.resync();
            }
            Err(_) => break,
        }
    }
    json!({
        "state": state_name(pipeline.upcast_ref()),
        "clock": pipeline.clock().is_some(),
        "elements": elements,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_lists_elements_links_and_queue_levels() {
        gst::init().unwrap();
        let p = gst::Pipeline::new();
        let src = gst::ElementFactory::make("videotestsrc").name("src").build().unwrap();
        let q = gst::ElementFactory::make("queue").name("q").build().unwrap();
        let sink = gst::ElementFactory::make("fakesink").name("sink").build().unwrap();
        p.add_many([&src, &q, &sink]).unwrap();
        gst::Element::link_many([&src, &q, &sink]).unwrap();
        let s = snapshot(&p);
        assert_eq!(s["state"], "Null");
        let els = s["elements"].as_array().unwrap();
        assert_eq!(els.len(), 3);
        let q = els.iter().find(|e| e["name"] == "q").unwrap();
        assert_eq!(q["factory"], "queue");
        assert_eq!(q["level"]["buffers"], 0);
        let qsrc = q["pads"].as_array().unwrap().iter().find(|p| p["name"] == "src").unwrap();
        assert_eq!(qsrc["peer"], "sink.sink");
        // Elemente ohne Füllstand tragen keinen "level"
        assert!(els.iter().find(|e| e["name"] == "sink").unwrap().get("level").is_none());
    }
}
