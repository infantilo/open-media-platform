//! `omp-fabrics-gateway` (Kapitel 16 Teil 2, `docs/END-GOAL-FEATURES.md`
//! §16.4 Teil 2): erster echter Node-Konsument von `omp_mediaio::fabrics`
//! (Kapitel 16 Teil 1, Fundament + Grain-Relay) — bewusst zweigeteilt wie
//! `omp-2110-gateway`/`omp-aes67-gateway` (`OMP_FABRICS_GATEWAY_ROLE=
//! target|initiator`), hier aber ohne jede GStreamer-Pipeline: Fabrics
//! operiert unterhalb der GStreamer-Ebene direkt auf `mxlFlowWriter`/
//! `mxlFlowReader`-Handles (s. `omp_mediaio::fabrics`-Moduldoku), dieser
//! Node braucht deshalb kein `pipeline.rs`-GStreamer-Gerüst — nur
//! Fabrics-Objekt-Lebenszyklus + Threads.
//!
//! - **Target** (Empfänger-Host): legt einen neuen lokalen MXL-Video-Flow
//!   an (feste Konfiguration wie `omp-2110-gateway`s Ingest-Rolle,
//!   `OMP_FABRICS_WIDTH`/`_HEIGHT`/`_FPS_NUM`/`_FPS_DEN`), bindet einen
//!   Fabrics-Endpunkt und exponiert die daraus resultierende, opake
//!   `TargetInfo`-Zeichenkette als Node-Contract-Parameter
//!   (`fabricsTargetInfo`) — die Initiator-Seite muss sie kennen, um sich
//!   zu verbinden (Fabrics kennt kein IS-04/05-Analogon für diesen
//!   Adressaustausch, deshalb Node-zu-Node per HTTP statt eines neuen
//!   Standard-Konzepts).
//! - **Initiator** (Sender-Host): wählt die zu relayende lokale MXL-
//!   Quelle dynamisch per echtem IS-05-Receiver-PATCH (`main.rs`,
//!   gleiches Muster wie `omp-2110-gateway`s Output-Rolle/`omp-viewer`),
//!   holt sich `fabricsTargetInfo` der konfigurierten Ziel-Instanz per
//!   HTTP (`OMP_FABRICS_TARGET_URL`, `omp_node_sdk::PeerClient::
//!   get_param`) und relayt danach dauerhaft.
//!
//! **Bewusste Vereinfachung, dokumentiert (Target-Rolle,
//! `media_ready`):** um ehrlich "mindestens ein Grain ist wirklich
//! angekommen" statt eines hartkodierten `true` zu melden, wartet die
//! Target-Rolle vor dem Start der dauerhaften `relay_incoming_grains`-
//! Schleife auf genau ein per `read_grain` eingetroffenes Grain. Dieses
//! erste Grain wird dabei **nicht** committet (die dafür nötige
//! `commit_relayed_grain`-Funktion ist modul-privat, außerhalb von
//! `omp_mediaio::fabrics` nicht sichtbar, absichtlich nicht erweitert für
//! dieses eine Signal) — ein einzelnes, am Verbindungsanfang
//! übersprungenes Bild bei kontinuierlichem Video, kein fortlaufender
//! Datenverlust danach. Analoge, bereits akzeptierte Vereinfachung wie
//! `FabricsInitiator::relay_outgoing_grains`s eigene "kein Slice-Batching"-
//! Notiz.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use omp_mediaio::fabrics::{FabricsRuntime, Provider};
use omp_node_sdk::PeerClient;
use tokio::sync::mpsc::UnboundedSender;

pub enum Event {
    Error(String),
}

/// Baut die MXL-Flow-Definition für den neu anzulegenden Ziel-Flow der
/// Target-Rolle — 1:1 dasselbe Schema wie `omp_mediaio::mxl::
/// video_flow_def` (dort modul-privat), hier bewusst dupliziert statt
/// importiert: Feature `fabrics` bleibt unabhängig von Feature `mxl`
/// (dieselbe Begründung wie im Grain-Relay-Test von Kapitel 16 Teil 1).
fn video_flow_def(
    flow_id: &str,
    label: &str,
    width: u32,
    height: u32,
    grain_rate_numerator: u32,
    grain_rate_denominator: u32,
) -> String {
    serde_json::json!({
        "id": flow_id,
        "label": label,
        "description": format!("OpenMediaPlatform: {label}"),
        "tags": {
            "urn:x-nmos:tag:grouphint/v1.0": [format!("{flow_id}:Video")],
        },
        "format": "urn:x-nmos:format:video",
        "parents": [],
        "media_type": "video/v210",
        "grain_rate": {
            "numerator": grain_rate_numerator,
            "denominator": grain_rate_denominator,
        },
        "frame_width": width,
        "frame_height": height,
        "interlace_mode": "progressive",
        "colorspace": "BT709",
        "components": [
            {"name": "Y", "width": width, "height": height, "bit_depth": 10},
            {"name": "Cb", "width": width / 2, "height": height, "bit_depth": 10},
            {"name": "Cr", "width": width / 2, "height": height, "bit_depth": 10},
        ],
    })
    .to_string()
}

pub struct TargetConfig {
    pub domain: String,
    pub flow_id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub framerate_numerator: u32,
    pub framerate_denominator: u32,
    pub provider: Provider,
    pub bind_node: String,
    pub bind_service: String,
}

pub struct TargetHandle {
    pub target_info: String,
    flowed: Arc<AtomicBool>,
}

impl TargetHandle {
    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }
}

/// Baut die Target-Rolle auf und startet ihren Relay-Thread. `shutdown`
/// wird direkt als Stop-Flag für den Relay-Thread wiederverwendet (kein
/// eigenes GStreamer-Pipeline-Objekt, das einen eigenen Kontroll-Thread
/// bräuchte, s. Moduldoku).
pub fn start_target(
    config: TargetConfig,
    tx: UnboundedSender<Event>,
    shutdown: Arc<AtomicBool>,
) -> Result<TargetHandle, String> {
    let runtime = FabricsRuntime::new(&config.domain)?;
    let flow_def = video_flow_def(
        &config.flow_id,
        &config.label,
        config.width,
        config.height,
        config.framerate_numerator,
        config.framerate_denominator,
    );
    let (target, target_info) =
        runtime.create_target(&flow_def, config.provider, &config.bind_node, &config.bind_service)?;

    let flowed = Arc::new(AtomicBool::new(false));
    let flowed_thread = flowed.clone();
    std::thread::spawn(move || {
        // S. Moduldoku "Bewusste Vereinfachung": erstes Grain nur zum
        // Nachweis konsumiert, nicht committet.
        while !shutdown.load(Ordering::Relaxed) {
            match target.read_grain(200) {
                Ok(Some(_)) => {
                    flowed_thread.store(true, Ordering::Relaxed);
                    break;
                }
                Ok(None) => continue,
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("Fabrics target read_grain: {e}")));
                    return;
                }
            }
        }
        if let Err(e) = target.relay_incoming_grains(&shutdown) {
            let _ = tx.send(Event::Error(format!("Fabrics target relay: {e}")));
        }
    });

    Ok(TargetHandle { target_info, flowed })
}

pub struct InitiatorConfig {
    pub domain: String,
    pub provider: Provider,
    pub bind_node: String,
    pub bind_service: String,
    pub target_url: String,
}

struct ActiveInitiator {
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

/// Verwaltet die aktuell relayte MXL-Quelle der Initiator-Rolle,
/// neu aufgebaut bei jedem IS-05-Connect (`main.rs::InitiatorControl`) —
/// gleiches Rebuild-bei-Connect-Muster wie `omp-2110-gateway`s
/// `OutputPipelineHandle`/`omp-viewer`, hier aber ein Fabrics-Initiator-
/// Objekt + Relay-Thread statt einer GStreamer-Pipeline.
pub struct InitiatorHandle {
    runtime: Arc<FabricsRuntime>,
    provider: Provider,
    bind_node: String,
    bind_service: String,
    target_url: String,
    tx: UnboundedSender<Event>,
    active: Mutex<Option<ActiveInitiator>>,
    flowed: Arc<AtomicBool>,
}

impl InitiatorHandle {
    pub fn new(config: InitiatorConfig, tx: UnboundedSender<Event>) -> Result<Arc<Self>, String> {
        let runtime = FabricsRuntime::new(&config.domain)?;
        Ok(Arc::new(InitiatorHandle {
            runtime,
            provider: config.provider,
            bind_node: config.bind_node,
            bind_service: config.bind_service,
            target_url: config.target_url,
            tx,
            active: Mutex::new(None),
            flowed: Arc::new(AtomicBool::new(false)),
        }))
    }

    pub fn media_ready(&self) -> bool {
        self.flowed.load(Ordering::Relaxed)
    }

    /// Baut die relayte Quelle auf `flow_id` um — beendet zuerst eine
    /// eventuell laufende vorherige Verbindung (analoges Vorgehen wie ein
    /// GStreamer-Pipeline-Rebuild: alt abbauen, dann neu aufbauen).
    pub fn connect(&self, flow_id: String) {
        self.teardown_active();
        self.flowed.store(false, Ordering::Relaxed);

        let target_info = match PeerClient::new(self.target_url.clone()).get_param("fabricsTargetInfo") {
            Ok(serde_json::Value::String(s)) if !s.is_empty() => s,
            Ok(other) => {
                let _ = self.tx.send(Event::Error(format!(
                    "fabricsTargetInfo von {}: unerwarteter Wert {other}",
                    self.target_url
                )));
                return;
            }
            Err(e) => {
                let _ = self
                    .tx
                    .send(Event::Error(format!("fabricsTargetInfo von {} holen: {e}", self.target_url)));
                return;
            }
        };

        let initiator = match self
            .runtime
            .create_initiator(&flow_id, self.provider, &self.bind_node, &self.bind_service)
        {
            Ok(i) => i,
            Err(e) => {
                let _ = self.tx.send(Event::Error(format!("FabricsInitiator({flow_id}): {e}")));
                return;
            }
        };
        if let Err(e) = initiator.add_target(&target_info) {
            let _ = self.tx.send(Event::Error(format!("add_target: {e}")));
            return;
        }

        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let flowed_thread = self.flowed.clone();
        let tx = self.tx.clone();
        let thread = std::thread::spawn(move || {
            // Verbindungsaufbau treiben (gleiches Muster wie
            // `fabrics::tests::transfers_a_real_grain_between_two_domains_
            // over_tcp`): wiederholt `make_progress_blocking`, bis sie
            // `Ok(true)` (verbunden) meldet oder abgebrochen wird.
            loop {
                if stop_thread.load(Ordering::Relaxed) {
                    return;
                }
                match initiator.make_progress_blocking(200) {
                    Ok(true) => break,
                    Ok(false) => continue,
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("Fabrics initiator connect: {e}")));
                        return;
                    }
                }
            }
            flowed_thread.store(true, Ordering::Relaxed);
            if let Err(e) = initiator.relay_outgoing_grains(&stop_thread) {
                let _ = tx.send(Event::Error(format!("Fabrics initiator relay: {e}")));
            }
        });

        *self.active.lock().expect("lock poisoned") = Some(ActiveInitiator { stop, thread });
    }

    /// Beendet die aktuell relayte Quelle (IS-05-Disconnect) — bleibt
    /// bewusst ohne Ersatz, bis der nächste `connect()` kommt (kein
    /// automatischer Rückfall, gleiche Linie wie `omp-2110-gateway`s
    /// Output-Rolle).
    pub fn disconnect(&self) {
        self.teardown_active();
        self.flowed.store(false, Ordering::Relaxed);
    }

    fn teardown_active(&self) {
        if let Some(active) = self.active.lock().expect("lock poisoned").take() {
            active.stop.store(true, Ordering::Relaxed);
            let _ = active.thread.join();
        }
    }
}

impl Drop for InitiatorHandle {
    fn drop(&mut self) {
        self.teardown_active();
    }
}
