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
        json!(
            self.metas
                .lock()
                .expect("lock poisoned")
                .iter()
                .map(|m| json!({ "id": m.id, "name": m.name, "senderId": sender_id(&m.id), "at": m.at }))
                .collect::<Vec<_>>()
        )
    }
}
