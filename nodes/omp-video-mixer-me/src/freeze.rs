//! Freezes: beliebig viele Standbilder des PGM-Signals, die danach wie normale Quellen aufrufbar sind (PGM/PST/PIP/
//! Keyer). Aufnahme: `freeze.capture` (je Ebene) nimmt das letzte Ausgangsbild der Ebene auf (`pipeline::capture_still`).
//! Ablage: je Freeze eine Rohdatei `<id>.rgba` (RGBA in Mischer-Auflösung) plus `freezes.json` mit den Namen — so
//! überleben Freezes einen Neustart. Zum Pipeline-Eingang wird ein Freeze als `DiscoveredInput` mit der ID
//! `freeze:<id>` (siehe `pipeline::FREEZE_PREFIX`), den `pipeline::build_still_branch` mit Bildern füttert.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::pipeline::{self, DiscoveredInput, FREEZE_PREFIX, Still, StillStore};

#[derive(Clone)]
pub struct FreezeMeta {
    pub id: String,
    pub name: String,
    /// Unix-Sekunden der Aufnahme.
    pub at: u64,
}

pub struct Freezes {
    dir: PathBuf,
    width: u32,
    height: u32,
    stills: StillStore,
    metas: Mutex<Vec<FreezeMeta>>,
    /// Laufende Aufnahmen: Freeze-ID → (Ebene, Name).
    pending: Mutex<HashMap<String, (usize, String)>>,
    /// Vom Registry-Poll entdeckte Quellen (ohne Freezes).
    base: Mutex<Vec<DiscoveredInput>>,
    /// Derselbe Arc wie `MixerStore::inputs`: Registry-Quellen + Freezes.
    inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
    pipeline: pipeline::PipelineHandle,
    /// Je Ebene die angehefteten Tasten — ein neuer Freeze wird dort sofort angeheftet.
    pinned: Vec<Arc<Mutex<Vec<String>>>>,
    /// Kleine Vorschau je Freeze als `data:`-URI (Taste mit Vorschaubild); wird beim ersten Abruf erzeugt.
    thumbs: Mutex<HashMap<String, String>>,
}

pub fn sender_id(id: &str) -> String {
    format!("{FREEZE_PREFIX}{id}")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Freezes {
    /// Lädt vorhandene Freezes aus `dir` in den `StillStore`; Dateien mit falscher Größe (Mischer-Auflösung hat
    /// sich geändert) werden übersprungen und bleiben auf der Platte.
    pub fn load(
        dir: PathBuf,
        width: u32,
        height: u32,
        stills: StillStore,
        inputs: Arc<Mutex<Vec<DiscoveredInput>>>,
        pipeline: pipeline::PipelineHandle,
        pinned: Vec<Arc<Mutex<Vec<String>>>>,
    ) -> Arc<Self> {
        let mut metas = Vec::new();
        if let Ok(text) = std::fs::read_to_string(dir.join("freezes.json"))
            && let Ok(Value::Array(list)) = serde_json::from_str::<Value>(&text)
        {
            for item in list {
                let (Some(id), Some(name)) = (item["id"].as_str(), item["name"].as_str()) else { continue };
                match std::fs::read(dir.join(format!("{id}.rgba"))) {
                    Ok(rgba) if rgba.len() == (width * height * 4) as usize => {
                        stills.lock().expect("lock poisoned").insert(id.to_string(), Arc::new(Still { width, height, rgba }));
                        metas.push(FreezeMeta { id: id.to_string(), name: name.to_string(), at: item["at"].as_u64().unwrap_or(0) });
                    }
                    Ok(_) => eprintln!("omp-video-mixer-me: Freeze {id} hat eine andere Auflösung als der Mischer — übersprungen"),
                    Err(e) => eprintln!("omp-video-mixer-me: Freeze {id} nicht lesbar: {e}"),
                }
            }
        }
        Arc::new(Self {
            dir,
            width,
            height,
            stills,
            metas: Mutex::new(metas),
            pending: Mutex::new(HashMap::new()),
            base: Mutex::new(Vec::new()),
            inputs,
            pipeline,
            pinned,
            thumbs: Mutex::new(HashMap::new()),
        })
    }

    fn persist_meta(&self) {
        let list: Vec<Value> = self
            .metas
            .lock()
            .expect("lock poisoned")
            .iter()
            .map(|m| json!({ "id": m.id, "name": m.name, "at": m.at }))
            .collect();
        let _ = std::fs::create_dir_all(&self.dir);
        let tmp = self.dir.join("freezes.json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(&list).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, self.dir.join("freezes.json"));
        }
    }

    fn freeze_inputs(&self) -> Vec<DiscoveredInput> {
        self.metas
            .lock()
            .expect("lock poisoned")
            .iter()
            .map(|m| DiscoveredInput {
                sender_id: sender_id(&m.id),
                label: format!("Freeze: {}", m.name),
                flow_id: sender_id(&m.id),
                device_id: String::new(),
                format: Some(omp_node_sdk::is04::VideoFormat {
                    width: self.width,
                    height: self.height,
                    rate_num: pipeline::FRAMERATE_NUMERATOR,
                    rate_den: pipeline::FRAMERATE_DENOMINATOR,
                }),
            })
            .collect()
    }

    /// Registry-Quellen + Freezes zusammenführen, in `MixerStore::inputs` ablegen und an die Pipeline geben.
    pub fn publish(&self, discovered: Option<Vec<DiscoveredInput>>) {
        if let Some(d) = discovered {
            *self.base.lock().expect("lock poisoned") = d;
        }
        let mut merged = self.base.lock().expect("lock poisoned").clone();
        merged.extend(self.freeze_inputs());
        *self.inputs.lock().expect("lock poisoned") = merged.clone();
        self.pipeline.set_inputs(merged);
    }

    /// `freeze.capture`: Aufnahme anstoßen; der Name ist optional ("Freeze N").
    pub fn capture(&self, level: usize, name: Option<String>) {
        let id = format!(
            "{:x}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_micros()).unwrap_or(0)
        );
        let name = name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| {
            let existing = self.metas.lock().expect("lock poisoned");
            let mut n = existing.len() + 1;
            while existing.iter().any(|m| m.name == format!("Freeze {n}")) {
                n += 1;
            }
            format!("Freeze {n}")
        });
        self.pending.lock().expect("lock poisoned").insert(id.clone(), (level, name));
        self.pipeline.capture_freeze(level, id);
    }

    /// Ergebnis der Aufnahme aus der Pipeline: Datei schreiben, Liste ergänzen, als Quelle bereitstellen, anheften.
    /// Gibt eine Fehlermeldung für den Operator zurück.
    pub fn on_captured(&self, id: &str, result: Result<(), String>) -> Option<String> {
        let (level, name) = self.pending.lock().expect("lock poisoned").remove(id)?;
        if let Err(e) = result {
            return Some(format!("Freeze fehlgeschlagen: {e}"));
        }
        let Some(still) = self.stills.lock().expect("lock poisoned").get(id).cloned() else {
            return Some("Freeze fehlgeschlagen: Bild nicht im Speicher".to_string());
        };
        let _ = std::fs::create_dir_all(&self.dir);
        if let Err(e) = std::fs::write(self.dir.join(format!("{id}.rgba")), &still.rgba) {
            eprintln!("omp-video-mixer-me: Freeze {id} konnte nicht gespeichert werden: {e} (bleibt bis zum Neustart im Speicher)");
        }
        self.metas.lock().expect("lock poisoned").push(FreezeMeta { id: id.to_string(), name, at: now_secs() });
        self.persist_meta();
        if let Some(p) = self.pinned.get(level) {
            let sid = sender_id(id);
            let mut p = p.lock().expect("lock poisoned");
            if !p.contains(&sid) {
                p.push(sid);
            }
        }
        self.publish(None);
        None
    }

    pub fn delete(&self, id: &str) -> bool {
        let removed = {
            let mut metas = self.metas.lock().expect("lock poisoned");
            let before = metas.len();
            metas.retain(|m| m.id != id);
            metas.len() != before
        };
        if !removed {
            return false;
        }
        let sid = sender_id(id);
        for p in &self.pinned {
            p.lock().expect("lock poisoned").retain(|s| *s != sid);
        }
        self.persist_meta();
        let _ = std::fs::remove_file(self.dir.join(format!("{id}.rgba")));
        // Erst aus der Pipeline nehmen (`publish`), danach das Bild freigeben: der Feeder hält seine eigene Kopie.
        self.publish(None);
        self.stills.lock().expect("lock poisoned").remove(id);
        self.thumbs.lock().expect("lock poisoned").remove(id);
        true
    }

    pub fn rename(&self, id: &str, name: &str) -> bool {
        let name = name.trim();
        if name.is_empty() {
            return false;
        }
        let ok = {
            let mut metas = self.metas.lock().expect("lock poisoned");
            match metas.iter_mut().find(|m| m.id == id) {
                Some(m) => {
                    m.name = name.to_string();
                    true
                }
                None => false,
            }
        };
        if ok {
            self.persist_meta();
            self.publish(None);
        }
        ok
    }

    pub fn list_json(&self) -> Value {
        let metas = self.metas.lock().expect("lock poisoned").clone();
        json!(
            metas
                .iter()
                .map(|m| json!({ "id": m.id, "name": m.name, "senderId": sender_id(&m.id), "at": m.at, "thumb": self.thumb(&m.id) }))
                .collect::<Vec<_>>()
        )
    }

    /// Vorschaubild (JPEG als `data:`-URI) eines Freezes; einmal erzeugt, danach aus dem Zwischenspeicher.
    fn thumb(&self, id: &str) -> Option<String> {
        if let Some(t) = self.thumbs.lock().expect("lock poisoned").get(id) {
            return Some(t.clone());
        }
        let still = self.stills.lock().expect("lock poisoned").get(id).cloned()?;
        let uri = thumb_data_uri(&still)?;
        self.thumbs.lock().expect("lock poisoned").insert(id.to_string(), uri.clone());
        Some(uri)
    }
}

const THUMB_WIDTH: u32 = 160;

/// RGBA-Standbild → kleines JPEG als `data:`-URI (einmalige GStreamer-Kette, nicht in der Sendepipeline).
fn thumb_data_uri(still: &Still) -> Option<String> {
    use gst::prelude::*;
    use gstreamer as gst;
    use gstreamer_app as gst_app;
    let h = ((THUMB_WIDTH as u64 * still.height as u64 / still.width.max(1) as u64) as u32).max(2) & !1;
    let desc = format!(
        "appsrc name=src format=time ! videoconvert ! videoscale ! video/x-raw,width={THUMB_WIDTH},height={h} ! jpegenc quality=70 ! appsink name=sink sync=false"
    );
    let pipe = gst::parse::launch(&desc).ok()?.downcast::<gst::Pipeline>().ok()?;
    let src = pipe.by_name("src")?.downcast::<gst_app::AppSrc>().ok()?;
    let sink = pipe.by_name("sink")?.downcast::<gst_app::AppSink>().ok()?;
    let caps = gst::Caps::builder("video/x-raw")
        .field("format", "RGBA")
        .field("width", still.width as i32)
        .field("height", still.height as i32)
        .field("framerate", gst::Fraction::new(25, 1))
        .build();
    src.set_caps(Some(&caps));
    pipe.set_state(gst::State::Playing).ok()?;
    let mut buf = gst::Buffer::from_slice(still.rgba.clone());
    buf.get_mut()?.set_pts(gst::ClockTime::ZERO);
    src.push_buffer(buf).ok()?;
    let _ = src.end_of_stream();
    let sample = sink.try_pull_sample(gst::ClockTime::from_seconds(3));
    let _ = pipe.set_state(gst::State::Null);
    let sample = sample?;
    let map = sample.buffer()?.map_readable().ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64(map.as_slice())))
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_reference() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
