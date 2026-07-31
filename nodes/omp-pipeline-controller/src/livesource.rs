//! Verkabelt IS-05-Receiver-Connects (Flow-Editor-Drag&Drop) mit PIPELINE
//! CONTROLLERs eigener Live-Source-API (`POST /api/live-sources`) — reine
//! Medien-Verkabelung, keine Playout-Steuerung. Nutzervorgabe: Steuerung
//! (Playlist/Grafik/Player/...) bleibt vollständig PIPELINE CONTROLLERs
//! eigene Sache, OMP bekommt dafür kein eigenes Methoden-Interface.

use std::sync::{Arc, Mutex};

use omp_node_sdk::connection::{ReceiverControl, ReceiverResource};
use omp_node_sdk::is04::RegistryClient;

/// Feste ID des von diesem Adapter verwalteten Live-Source-Eintrags in
/// PIPELINE CONTROLLERs `_settings.liveSources` — GET-then-merge (s.
/// `SharedLiveSource::sync`) lässt andere, manuell konfigurierte Einträge
/// unangetastet.
pub const LIVE_SOURCE_ID: &str = "omp-input";

#[derive(Default, Clone)]
struct LiveSourceState {
    video_flow_id: Option<String>,
    audio_flow_id: Option<String>,
}

pub enum FlowKind {
    Video,
    Audio,
}

/// Von beiden Receivern (Video/Audio) gemeinsam genutzt — ein Flow kann
/// unabhängig vom anderen verbunden/getrennt werden (Flow-Editor erlaubt
/// zwei separate Drag&Drop-Aktionen), PIPELINE CONTROLLERs `mxl://`-URI
/// (`_parseMxlUri`) nimmt Audio optional.
pub struct SharedLiveSource {
    pc_base: String,
    domain: String,
    registry: RegistryClient,
    state: Mutex<LiveSourceState>,
}

impl SharedLiveSource {
    pub fn new(pc_base: String, domain: String, registry: RegistryClient) -> Arc<Self> {
        Arc::new(SharedLiveSource {
            pc_base,
            domain,
            registry,
            state: Mutex::new(LiveSourceState::default()),
        })
    }

    fn sync(&self) {
        let state = self.state.lock().expect("lock poisoned").clone();
        let uri = state.video_flow_id.as_ref().map(|v| match &state.audio_flow_id {
            Some(a) => format!("mxl://{}?video={}&audio={}", self.domain, v, a),
            None => format!("mxl://{}?video={}", self.domain, v),
        });

        // GET-then-merge statt blindem Überschreiben: /api/live-sources
        // ersetzt das ganze Array serverseitig (server.js: `_settings.
        // liveSources = b.liveSources`) — andere, manuell in PIPELINE
        // CONTROLLER konfigurierte Einträge dürfen dabei nicht verloren
        // gehen.
        let mut sources: Vec<serde_json::Value> = ureq::get(&format!("{}/api/live-sources", self.pc_base))
            .call()
            .ok()
            .and_then(|mut r| r.body_mut().read_json::<serde_json::Value>().ok())
            .and_then(|v| v.get("liveSources").cloned())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();

        sources.retain(|s| s.get("id").and_then(|v| v.as_str()) != Some(LIVE_SOURCE_ID));
        if let Some(uri) = uri {
            sources.push(serde_json::json!({ "id": LIVE_SOURCE_ID, "label": "OMP", "uri": uri }));
        }

        if let Err(e) = ureq::post(&format!("{}/api/live-sources", self.pc_base))
            .send_json(serde_json::json!({ "liveSources": sources }))
        {
            eprintln!("omp-pipeline-controller: /api/live-sources sync failed: {e}");
        }
    }
}

pub struct LiveSourceControl {
    pub kind: FlowKind,
    pub shared: Arc<SharedLiveSource>,
}

impl ReceiverControl for LiveSourceControl {
    fn apply(&self, resource: &ReceiverResource) {
        let flow_id = match (&resource.sender_id, resource.master_enable) {
            (Some(sender_id), true) => match self.shared.registry.get_sender(sender_id) {
                Ok(sender) => sender.flow_id,
                Err(e) => {
                    eprintln!("omp-pipeline-controller: resolve sender {sender_id} failed: {e}");
                    None
                }
            },
            _ => None,
        };
        {
            let mut state = self.shared.state.lock().expect("lock poisoned");
            match self.kind {
                FlowKind::Video => state.video_flow_id = flow_id,
                FlowKind::Audio => state.audio_flow_id = flow_id,
            }
        }
        self.shared.sync();
    }
}
