//! Hoher-Level-Einstiegspunkt des SDK: verbindet Descriptor-HTTP-Server
//! (`server`), IS-04-Registrierung+Heartbeat und NATS-Health-Publisher
//! (`health`) zu dem Lifecycle, den jeder Node braucht — Rust-Pendant zu
//! `main()` im Go-Mock-Node (`nodes/mock/main.go`), als wiederverwendbare
//! Funktion statt kopierbarem Beispielcode.
//!
//! `start()` gibt sofort ein [`NodeHandle`] zurück und hält
//! Registrierung/Heartbeat/Health-Publish als Hintergrund-Task am Laufen —
//! nötig, damit Nodes mit eigener Nutzlast (z. B. der Playout-Node mit
//! seiner GStreamer-Pipeline, `UMSETZUNG.md` C2) nebenläufig arbeiten und
//! zusätzliche Events (z. B. Alarme) über dieselbe NATS-Verbindung
//! veröffentlichen können. `run()` bleibt als einfacher Wrapper für Nodes
//! ohne eigene Nutzlast (z. B. `examples/hello_node.rs`).

use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use crate::health;
use crate::is04::{
    self, AudioFlow, Device, Flow, FlowResource, HeartbeatError, INSTANCE_TAG, NodeResource,
    Receiver, RegistryClient, Sender, Source,
};
use crate::server::{self, ParamStore};

type BoxError = Box<dyn Error + Send + Sync>;

/// Heartbeat-/Health-Publish-Intervall — wie beim Mock-Node (`UMSETZUNG.md`
/// A7: "alle 5s"), deutlich unter `registration_expiry_interval` (60s,
/// `deploy/nmos/registry.json`).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const REGISTER_RETRY_INTERVAL: Duration = Duration::from_secs(2);

/// Konfiguration eines Nodes: Label, Netzwerk-Adresse, Senders/Receivers,
/// Adressen von Registry und NATS.
pub struct NodeConfig {
    pub label: String,
    pub host: String,
    pub port: u16,
    pub registry_url: String,
    pub nats_url: String,
    pub senders: Vec<SenderSpec>,
    pub receivers: Vec<ReceiverSpec>,
    /// Setzt den IS-04-Node-Tag `urn:x-omp:instance` (`UMSETZUNG.md` C8):
    /// vom Instanz-Launcher über `OMP_INSTANCE_ID` vorgegeben, damit der
    /// Orchestrator eine laufende Instanz mit dem passenden Registry-
    /// Node korrelieren kann, ohne Ports zu kennen. `None` bei manuell
    /// (nicht über den Launcher) gestarteten Nodes.
    pub instance_id: Option<String>,
    /// Bereitschafts-Quelle für das "media-ready"-Signal im Health-Status
    /// (`ARCHITECTURE.md` §5 Punkt 6, `UMSETZUNG.md` D5-prep) — bewusst
    /// ohne Default, jeder Node muss sich explizit einordnen (s.
    /// [`MediaReadySource`]).
    pub media_ready: MediaReadySource,
}

/// Beschreibt einen einzelnen Sender. `id`/`manifest_href` sind optional:
/// ohne beides verhält sich ein Sender wie bisher (auto-generierte ID,
/// kein Manifest). Nodes, die ihre eigene Sender-ID vorab kennen müssen
/// (z. B. um `manifest_href` auf einen von der ID abhängigen Pfad wie
/// `.../senders/<id>/transportfile` zu setzen, `UMSETZUNG.md` C3), geben
/// `id` selbst vor (`crate::idgen::new_v4()`) statt es generieren zu
/// lassen. `transport` überschreibt den Default (RTP) — z. B.
/// `is04::TRANSPORT_MXL`. `flow` registriert zusätzlich eine Source+Flow
/// und setzt `flow_id` auf dem Sender (`UMSETZUNG.md` C4: Flow-UUID ==
/// MXL-`flow-id`-Konvention — `FlowSpec.id` sollte daher die tatsächliche
/// MXL-`flow-id` des Nodes sein, nicht separat generiert werden).
#[derive(Default)]
pub struct SenderSpec {
    pub id: Option<String>,
    pub manifest_href: Option<String>,
    pub transport: Option<String>,
    pub flow: Option<FlowSpec>,
    /// Überschreibt das generische `"<NodeLabel> Sender <n>"` (Nutzerfund
    /// 2026-07-16: an einer Kachel mit mehreren gleichartigen Ports — z. B.
    /// einem Bildmischer-Programm-/Vorschau-Ausgang oder `omp-ograf`s
    /// Fill-/Key-Sendern — ließ sich von außen nicht erkennen, welcher
    /// Port welches Signal führt). `None` verhält sich unverändert wie
    /// bisher.
    pub label: Option<String>,
    /// IS-04-Tags für diesen Sender (`is04::Sender::tags` direkt
    /// durchgereicht) — z. B. `urn:x-nmos:tag:grouphint/v1.0` (Kapitel 15
    /// Teil 2, docs/END-GOAL-FEATURES.md §15.3b/§15.4): gegen die echte
    /// AMWA-NMOS-Parameter-Registry verifiziertes Format
    /// `"<group-name>:<role-in-group>[:<group-scope>]"`, laut Spec nur
    /// für Sender/Receiver definiert (nicht Flow/Source, trotz
    /// abweichender Doku-Formulierung — s. `docs/decisions.md`). Leer
    /// (Default) verhält sich unverändert wie bisher.
    pub tags: HashMap<String, Vec<String>>,
}

/// Flow-Angaben für einen MXL-Sender (`SenderSpec::flow`), Video **oder**
/// Audio — zwei Varianten statt eines gemeinsamen Felderbags, weil die
/// IS-04-Pflichtfelder für Video (`frame_width`/`grain_rate`/…) und Audio
/// (`sample_rate`/`bit_depth`/…) sich nicht überschneiden (s.
/// `is04::Flow` vs. `is04::AudioFlow`). `id` sollte die MXL-`flow-id` des
/// schreibenden Nodes sein (Konvention Flow-UUID == MXL-flow-id,
/// `UMSETZUNG.md` C4) — ohne `id` wird eine neue UUID generiert, die dann
/// selbst als MXL-`flow-id` verwendet werden muss.
pub enum FlowSpec {
    Video {
        id: Option<String>,
        frame_width: u32,
        frame_height: u32,
        grain_rate_numerator: u32,
        grain_rate_denominator: u32,
    },
    /// `media_type`/`bit_depth` folgen `omp_mediaio::mxl`s Audio-
    /// Konvention (`"audio/float32"`/32) — hier trotzdem als Argumente
    /// statt hartkodiert, damit ein künftiger Node mit anderem PCM-Format
    /// (z. B. `audio/L24`) `is04::AudioFlow` nicht duplizieren muss.
    Audio {
        id: Option<String>,
        sample_rate_numerator: u32,
        channel_count: u32,
        media_type: String,
        bit_depth: u32,
    },
}

impl FlowSpec {
    fn id(&self) -> &Option<String> {
        match self {
            FlowSpec::Video { id, .. } => id,
            FlowSpec::Audio { id, .. } => id,
        }
    }
}

/// Beschreibt einen einzelnen Receiver. `id` optional wie bei
/// [`SenderSpec`]: Nodes, die vorab eine eigene IS-05-Receiver-Connection-
/// API dafür anbieten müssen (z. B. `omp-viewer`, `UMSETZUNG.md` C6, über
/// `crate::connection::ReceiverConnection`), geben `id` selbst vor
/// (`crate::idgen::new_v4()`), damit sie den `ReceiverConnection`-Endpoint
/// vor dem Aufruf von `start()` unter der endgültigen ID verdrahten
/// können — gleiches Henne-Ei-Problem wie bei `SenderSpec::id`/
/// `manifest_href`. `transport`/`media_types` überschreiben die RTP-
/// Defaults (z. B. `is04::TRANSPORT_MXL` + `["video/v210"]`).
#[derive(Default)]
pub struct ReceiverSpec {
    pub id: Option<String>,
    pub transport: Option<String>,
    pub media_types: Option<Vec<String>>,
    /// S. `SenderSpec::label` — gleiche Begründung, gleiches Verhalten bei
    /// `None`.
    pub label: Option<String>,
}

/// Bereitschafts-Quelle für das „media-ready"-Signal aus dem Node-Contract
/// (`ARCHITECTURE.md` §5 Punkt 6, `UMSETZUNG.md` D5-prep): ergänzt den
/// bestehenden Health-Status ("Prozess lebt und ist registriert") um
/// "produziert/konsumiert tatsächlich Medien" — Grundlage für die
/// Betriebsbereitschafts-Prüfung einer Make-before-break-Migration (§6.1
/// Punkt 3), noch nicht Teil dieses Schritts.
///
/// Drei bewusst unterschiedene Fälle statt eines einzelnen `Option<Probe>`
/// mit `None` als Default: ein still auf `true` fallender Default für
/// Nodes ohne verdrahtete Erkennung würde eine Bereitschaft vortäuschen,
/// die nicht geprüft wurde — genau das soll dieses Signal verhindern
/// (`docs/decisions.md`, D5-prep).
pub enum MediaReadySource {
    /// Der Node hat kein Medien-I/O (z. B. ein reiner Control-Plane-Node
    /// wie `omp-playout-automation` — `senders`/`receivers` leer) — gilt
    /// per Definition sofort als bereit, es gibt nichts abzuwarten.
    NotApplicable,
    /// Der Node hat Medien-I/O, aber noch keine Bereitschafts-Probe
    /// verdrahtet (dokumentierte Folgearbeit) — meldet konservativ nie
    /// "bereit", statt eine ungeprüfte Bereitschaft vorzutäuschen.
    Unknown,
    /// Bereitschaft wird bei jedem Health-Tick über die gegebene Funktion
    /// abgefragt (z. B. "mindestens ein echter Medien-Buffer ist durch die
    /// Pipeline geflossen").
    Probe(Arc<dyn Fn() -> bool + Send + Sync>),
}

impl MediaReadySource {
    fn is_ready(&self) -> bool {
        match self {
            MediaReadySource::NotApplicable => true,
            MediaReadySource::Unknown => false,
            MediaReadySource::Probe(probe) => probe(),
        }
    }
}

/// Gemeinsamer, veränderlicher Registrierungszustand zwischen dem
/// Heartbeat-Task und [`NodeHandle::add_receiver`]/[`NodeHandle::
/// remove_receiver`] (2026-08-06, `omp-viewer`s dynamische Audio-
/// Eingänge — erste Node in OMP, die Empfänger nach `start()` noch
/// hinzufügt/entfernt, statt sie einmalig aus `NodeConfig::receivers`
/// abzuleiten). `node`/`sources`/`flows`/`senders` bleiben nach `start()`
/// unverändert (kein Node braucht bisher dynamische Sender/Flows) — nur
/// `device` (dessen `receivers`-Liste referenziert werden muss) und
/// `receivers` selbst wandern hier rein, alles andere bleibt wie bisher
/// direkt in `heartbeat_loop` gefangen.
struct RegisteredReceivers {
    device: Device,
    receivers: Vec<Receiver>,
}

/// Griff auf einen laufenden Node: Identität + (falls NATS erreichbar war)
/// die Möglichkeit, zusätzliche Events wie Alarme zu veröffentlichen.
#[derive(Clone)]
pub struct NodeHandle {
    pub node_id: String,
    publisher: Option<Arc<health::Publisher>>,
    registry: RegistryClient,
    label: String,
    shared_receivers: Arc<std::sync::Mutex<RegisteredReceivers>>,
    liveness: Arc<crate::liveness::LivenessMonitor>,
}

impl NodeHandle {
    /// Registriert einen Node-internen Worker-Thread für die generische
    /// Liveness-Überwachung (`docs/decisions.md` Nachtrag 123: Bug-Klasse
    /// "Thread stirbt still, Prozess/Health melden trotzdem weiter
    /// 'ok'"). `counter` muss der Worker selbst bei JEDEM
    /// Schleifendurchlauf erhöhen (z. B. `omp_mediaio::mxl::
    /// MxlAudioInput::heartbeat_handle()`), unabhängig davon, ob dabei
    /// Daten flossen — s. `liveness`-Moduldoku. Rein additiv: ein Node,
    /// der dies nie aufruft, verhält sich unverändert (`status` bleibt
    /// immer `"ok"`).
    pub fn register_worker(&self, name: impl Into<String>, counter: Arc<std::sync::atomic::AtomicU64>) {
        self.liveness.register(name, counter);
    }

    /// Kehrseite von `register_worker` — aufrufen, wenn ein Worker
    /// absichtlich beendet wird (sonst meldet `status` ihn ab dann für
    /// immer fälschlich als hängend).
    pub fn unregister_worker(&self, name: &str) {
        self.liveness.unregister(name);
    }

    /// Veröffentlicht einen Alarm auf `omp.alert.<node_id>` (z. B. bei
    /// einem Pipeline-Fehler, `UMSETZUNG.md` C2). Kein NATS verbunden ⇒
    /// stiller No-Op, nur eine Log-Zeile — Alarme sind Zusatzinformation,
    /// kein Ersatz für den Health-Mechanismus.
    pub async fn publish_alert(&self, message: impl Into<String>) {
        let Some(publisher) = &self.publisher else {
            eprintln!(
                "omp-node-sdk: alert dropped (no nats connection): {}",
                message.into()
            );
            return;
        };
        let alert = health::Alert {
            node_id: self.node_id.clone(),
            message: message.into(),
        };
        if let Err(e) = publisher.publish_alert(&alert).await {
            eprintln!("omp-node-sdk: alert publish failed: {e}");
        }
    }

    /// Veröffentlicht ein Tally-Event auf `omp.tally.<target_node_id>`
    /// (`UMSETZUNG.md` C10) — anders als `publish_alert` gilt das Event
    /// nicht dem eigenen Node, sondern der Kachel `target_node_id` (z. B.
    /// dem gerade auf Programm geschalteten Quell-Node). Kein NATS
    /// verbunden ⇒ stiller No-Op wie bei `publish_alert`.
    pub async fn publish_tally(&self, target_node_id: &str, on: bool) {
        let Some(publisher) = &self.publisher else {
            eprintln!("omp-node-sdk: tally dropped (no nats connection): {target_node_id} on={on}");
            return;
        };
        if let Err(e) = publisher.publish_tally(target_node_id, on).await {
            eprintln!("omp-node-sdk: tally publish failed: {e}");
        }
    }

    /// Veröffentlicht ein `ItemEnded`-Event auf
    /// `omp.player.<node_id>.itemEnded` (K2-Teil-1) — gilt dem eigenen
    /// Node (anders als `publish_tally`), gleiches No-Op-Verhalten ohne
    /// NATS-Verbindung wie `publish_alert`.
    pub async fn publish_item_ended(&self, item_id: &str) {
        let Some(publisher) = &self.publisher else {
            eprintln!("omp-node-sdk: itemEnded dropped (no nats connection): {item_id}");
            return;
        };
        if let Err(e) = publisher.publish_item_ended(&self.node_id, item_id).await {
            eprintln!("omp-node-sdk: itemEnded publish failed: {e}");
        }
    }
}

/// Baut ein einzelnes `Receiver`-Resource aus einer [`ReceiverSpec`] —
/// gemeinsame Logik von `start()` (einmalig aus `NodeConfig::receivers`)
/// und [`NodeHandle::add_receiver`] (2026-08-06, nach `start()` zur
/// Laufzeit). `label_index` speist nur den generischen Fallback-Namen
/// ("<Label> Receiver <n>"), keine Identität.
fn build_receiver(id: &str, label_index: usize, spec: &ReceiverSpec, device_id: &str, node_label: &str) -> Receiver {
    let label = spec
        .label
        .clone()
        .unwrap_or_else(|| format!("{node_label} Receiver {}", label_index + 1));
    let mut receiver = Receiver::new(id, &label, device_id);
    if let Some(transport) = &spec.transport {
        receiver.transport = transport.clone();
    }
    if let Some(media_types) = &spec.media_types {
        receiver.caps.media_types = media_types.clone();
        // Live gefunden (Kapitel 19 Teil 3, `docs/decisions.md`):
        // `Receiver::new` setzt `format` fest auf `FORMAT_VIDEO`,
        // unabhängig von `media_types` — inkonsistent zu
        // `caps.media_types` und von der Registry mit HTTP 400
        // abgelehnt, sobald ein Node einen Audio-Receiver mit eigenen
        // `media_types` deklariert. `format` muss zum tatsächlichen
        // Medientyp passen, nicht am Video-Default kleben bleiben.
        if let Some(first) = media_types.first() {
            if first.starts_with("audio/") {
                receiver.format = is04::FORMAT_AUDIO.to_string();
            } else if first.starts_with("video/") {
                receiver.format = is04::FORMAT_VIDEO.to_string();
            }
        }
    }
    receiver
}

impl NodeHandle {
    /// Registriert einen zusätzlichen Receiver **nach** `start()` — erste
    /// Nutzung in OMP (2026-08-06, `omp-viewer`s dynamische Audio-
    /// Eingänge: "wie viele Meter ich sehen will, ist eine Operator-
    /// Entscheidung zur Laufzeit, keine Startkonfiguration"). Jeder
    /// andere Node bleibt unverändert bei der statischen
    /// `NodeConfig::receivers`-Liste aus `start()` — dieser Pfad ist rein
    /// additiv, keine bestehende Nutzung ändert sich.
    ///
    /// Registriert den neuen Receiver UND das aktualisierte Device
    /// (dessen `receivers`-Liste ihn jetzt referenzieren muss) sofort
    /// (nicht erst beim nächsten Heartbeat-Tick, für zügige Sichtbarkeit
    /// im Flow-Editor) und trägt ihn in die geteilte Liste ein, die der
    /// Heartbeat-Task ab jetzt mit am Leben hält.
    pub async fn add_receiver(&self, spec: ReceiverSpec) -> Result<Receiver, BoxError> {
        let id = spec.id.clone().unwrap_or_else(crate::idgen::new_v4);
        let (receiver, device_snapshot) = {
            let mut shared = self.shared_receivers.lock().expect("lock poisoned");
            let label_index = shared.receivers.len();
            let receiver = build_receiver(&id, label_index, &spec, &shared.device.id, &self.label);
            shared.receivers.push(receiver.clone());
            shared.device.receivers.push(id.clone());
            shared.device.version = is04::now_version();
            (receiver, shared.device.clone())
        };

        let registry = self.registry.clone();
        let receiver_for_register = receiver.clone();
        tokio::task::spawn_blocking(move || -> Result<(), is04::RegisterError> {
            registry.register("device", &device_snapshot)?;
            registry.register("receiver", &receiver_for_register)?;
            Ok(())
        })
        .await??;

        Ok(receiver)
    }

    /// Entfernt einen per [`add_receiver`](Self::add_receiver) hinzugefügten
    /// Receiver wieder — deregistriert ihn bei der Registry und
    /// aktualisiert das Device (dessen `receivers`-Liste ihn nicht mehr
    /// referenzieren darf, sonst meldet die Registry ein Device mit einem
    /// toten Receiver-Verweis). Kein Fehler, wenn `receiver_id` unbekannt
    /// ist (idempotent, gleiche Linie wie `RegistryClient::deregister_node`).
    pub async fn remove_receiver(&self, receiver_id: &str) -> Result<(), BoxError> {
        let device_snapshot = {
            let mut shared = self.shared_receivers.lock().expect("lock poisoned");
            shared.receivers.retain(|r| r.id != receiver_id);
            shared.device.receivers.retain(|id| id != receiver_id);
            shared.device.version = is04::now_version();
            shared.device.clone()
        };

        let registry = self.registry.clone();
        let id = receiver_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), BoxError> {
            registry.deregister_receiver(&id).map_err(|e| -> BoxError { e.into() })?;
            registry.register("device", &device_snapshot)?;
            Ok(())
        })
        .await??;

        Ok(())
    }
}

/// Baut IS-04-Resources, registriert sie, startet den Descriptor-Server und
/// hält Heartbeat + Health-Publish als Hintergrund-Task am Laufen. `store`
/// ist die einzige Node-spezifische Eingabe. Gibt sofort nach erfolgreicher
/// Erstregistrierung zurück.
pub async fn start(config: NodeConfig, store: Arc<dyn ParamStore>) -> Result<NodeHandle, BoxError> {
    // Bug 2026-08-10: "beim Stoppen/Neustarten eines Workflows verlieren
    // viele Nodes ihre UID" — bislang würfelte jeder Prozessstart
    // node_id/device_id komplett neu, auch wenn derselbe Launcher dieselbe
    // Workflow-Rolle nur neu gestartet hat. `OMP_ROLE_SEED` (vom
    // Orchestrator ausschließlich für Workflow-Rollen gesetzt, nie für
    // manuelle Katalog-Starts oder während einer Live-Migration mit
    // parallel weiterlaufender alter Instanz, s. `workflows/service.go`
    // runStart/runRestartRole) macht node_id/device_id über einen
    // Stop/Start-Zyklus hinweg stabil, ohne dass jeder einzelne Node-Typ
    // dafür etwas tun muss. Ohne den Env-Var (unverändertes Verhalten):
    // zufällig wie bisher.
    let role_seed = std::env::var("OMP_ROLE_SEED").ok();
    let node_id = role_seed
        .as_deref()
        .map(|seed| crate::idgen::deterministic_v4(&format!("node:{seed}")))
        .unwrap_or_else(crate::idgen::new_v4);
    let device_id = role_seed
        .as_deref()
        .map(|seed| crate::idgen::deterministic_v4(&format!("device:{seed}")))
        .unwrap_or_else(crate::idgen::new_v4);
    let sender_ids: Vec<String> = config
        .senders
        .iter()
        .map(|spec| spec.id.clone().unwrap_or_else(crate::idgen::new_v4))
        .collect();
    let receiver_ids: Vec<String> = config
        .receivers
        .iter()
        .map(|spec| spec.id.clone().unwrap_or_else(crate::idgen::new_v4))
        .collect();

    let device_res = Device::new(
        &device_id,
        &format!("{} Device", config.label),
        &node_id,
        sender_ids.clone(),
        receiver_ids.clone(),
    );
    let mut sources: Vec<Source> = vec![];
    let mut flows: Vec<FlowResource> = vec![];
    let senders: Vec<Sender> = sender_ids
        .iter()
        .zip(&config.senders)
        .enumerate()
        .map(|(i, (id, spec))| {
            let label = spec
                .label
                .clone()
                .unwrap_or_else(|| format!("{} Sender {}", config.label, i + 1));
            let mut sender = Sender::new(id, &label, &device_id);
            sender.manifest_href = spec.manifest_href.clone();
            sender.tags = spec.tags.clone();
            if let Some(transport) = &spec.transport {
                sender.transport = transport.clone();
            }
            if let Some(flow_spec) = &spec.flow {
                let source_id = crate::idgen::new_v4();
                let flow_id = flow_spec
                    .id()
                    .clone()
                    .unwrap_or_else(crate::idgen::new_v4);
                match flow_spec {
                    FlowSpec::Video {
                        frame_width,
                        frame_height,
                        grain_rate_numerator,
                        grain_rate_denominator,
                        ..
                    } => {
                        sources.push(Source::new_video(&source_id, &label, &device_id));
                        flows.push(FlowResource::Video(Flow::new_video(
                            &flow_id,
                            &label,
                            &device_id,
                            &source_id,
                            *frame_width,
                            *frame_height,
                            *grain_rate_numerator,
                            *grain_rate_denominator,
                        )));
                    }
                    FlowSpec::Audio {
                        sample_rate_numerator,
                        channel_count,
                        media_type,
                        bit_depth,
                        ..
                    } => {
                        sources.push(Source::new_audio(
                            &source_id,
                            &label,
                            &device_id,
                            *channel_count,
                        ));
                        flows.push(FlowResource::Audio(AudioFlow::new(
                            &flow_id,
                            &label,
                            &device_id,
                            &source_id,
                            *sample_rate_numerator,
                            media_type,
                            *bit_depth,
                        )));
                    }
                }
                sender.flow_id = Some(flow_id);
            }
            sender
        })
        .collect();
    let sender_count = senders.len();
    let receivers: Vec<Receiver> = receiver_ids
        .iter()
        .zip(&config.receivers)
        .enumerate()
        .map(|(i, (id, spec))| build_receiver(id, i, spec, &device_id, &config.label))
        .collect();

    let registry = RegistryClient::new(config.registry_url.clone());

    // `config.port == 0` lässt das OS einen freien Port zuweisen
    // (`UMSETZUNG.md` C8: der Instanz-Launcher startet mehrere Node-
    // Instanzen desselben Typs auf einem Host, die sich sonst einen
    // festen Port teilen müssten) — registriert wird deshalb erst nach
    // dem tatsächlichen Binden, mit dem wirklich belegten Port.
    let bind_addr = format!("0.0.0.0:{}", config.port);
    let (actual_port, _server_handle) = server::spawn(&bind_addr, store)?;

    let mut node_res = NodeResource::new(&node_id, &config.label, &config.host, actual_port);
    if let Some(instance_id) = &config.instance_id {
        node_res
            .tags
            .insert(INSTANCE_TAG.to_string(), vec![instance_id.clone()]);
    }

    register_with_retry(
        &registry,
        &node_res,
        &device_res,
        &sources,
        &flows,
        &senders,
        &receivers,
    )
    .await;
    eprintln!("omp-node-sdk: node registered: {node_id}");

    let publisher = match health::Publisher::connect(&config.nats_url).await {
        Ok(p) => Some(Arc::new(p)),
        Err(e) => {
            eprintln!(
                "omp-node-sdk: nats connect failed, continuing without health publishing: {e}"
            );
            None
        }
    };

    let shared_receivers = Arc::new(std::sync::Mutex::new(RegisteredReceivers {
        device: device_res.clone(),
        receivers: receivers.clone(),
    }));

    let liveness = Arc::new(crate::liveness::LivenessMonitor::new());

    let handle = NodeHandle {
        node_id: node_id.clone(),
        publisher: publisher.clone(),
        registry: registry.clone(),
        label: config.label.clone(),
        shared_receivers: shared_receivers.clone(),
        liveness: liveness.clone(),
    };

    // Bugfix 2026-07-26 (Geister-Kacheln im Flow-Editor nach Stop/
    // Pause): der Instanz-Launcher stoppt eine lokale Node ausschließlich
    // per SIGTERM (`orchestrator/internal/launcher/launcher.go`, "SIGTERM,
    // Grace, SIGKILL") — `tokio::signal::ctrl_c()`, das jeder Node in
    // seiner eigenen `main()` für die eigene Pipeline-Abschaltung nutzt,
    // reagiert auf Unix aber ausschließlich auf SIGINT, nicht SIGTERM.
    // Ohne einen eigenen SIGTERM-Handler beendet die Standard-Aktion des
    // Betriebssystems den Prozess sofort, ohne dass irgendein Rust-Code
    // (auch kein `Drop`) noch läuft — die Node bleibt bei der Registry
    // bis zum nächsten verpassten Heartbeat "registriert" (bis zu
    // `registration_expiry_interval`, 60s) und erscheint so lange als
    // tote Kachel im Flow-Editor. Bewusst als eigener, zusätzlicher
    // Task statt in den bestehenden `ctrl_c()`-Pfad jedes einzelnen
    // Node-`main()` integriert: SIGINT (manueller Ctrl+C-Devbetrieb)
    // bleibt dadurch unverändert bei der bereits funktionierenden,
    // Pipeline-eigenen Abschaltlogik jedes Nodes — dieser Task
    // übernimmt ausschließlich den bisher komplett unbehandelten
    // SIGTERM-Pfad, keine Konkurrenz zu bestehendem Code.
    let dereg_registry = registry.clone();
    let dereg_node_id = node_id.clone();
    tokio::spawn(async move {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut term) => {
                term.recv().await;
            }
            Err(e) => {
                eprintln!("omp-node-sdk: failed to install SIGTERM handler: {e}");
                return;
            }
        }
        eprintln!("omp-node-sdk: SIGTERM received, deregistering {dereg_node_id}");
        if let Err(e) = dereg_registry.deregister_node(&dereg_node_id) {
            eprintln!("omp-node-sdk: deregister failed: {e}");
        }
        std::process::exit(0);
    });

    tokio::spawn(heartbeat_loop(
        registry,
        node_id,
        node_res,
        sources,
        flows,
        senders,
        shared_receivers,
        publisher,
        config.label,
        sender_count,
        config.media_ready,
        liveness,
    ));

    Ok(handle)
}

/// Wie `start()`, hält den aufrufenden Task danach aber unbegrenzt am
/// Laufen — für Nodes ohne eigene Nutzlast (z. B. `hello_node`), die
/// selbst nichts anderes zu tun haben, als registriert zu bleiben.
pub async fn run(config: NodeConfig, store: Arc<dyn ParamStore>) -> Result<(), BoxError> {
    let _handle = start(config, store).await?;
    std::future::pending().await
}

#[allow(clippy::too_many_arguments)]
async fn heartbeat_loop(
    registry: RegistryClient,
    node_id: String,
    node_res: NodeResource,
    sources: Vec<Source>,
    flows: Vec<FlowResource>,
    senders: Vec<Sender>,
    shared_receivers: Arc<std::sync::Mutex<RegisteredReceivers>>,
    publisher: Option<Arc<health::Publisher>>,
    label: String,
    sender_count: usize,
    media_ready: MediaReadySource,
    liveness: Arc<crate::liveness::LivenessMonitor>,
) {
    let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
    loop {
        interval.tick().await;

        let registry_clone = registry.clone();
        let node_id_clone = node_id.clone();
        let heartbeat_result =
            tokio::task::spawn_blocking(move || registry_clone.heartbeat(&node_id_clone)).await;
        // Aktuellen Stand von Device/Receivers bei JEDEM Tick frisch aus
        // dem geteilten Zustand lesen (statt einer beim Start
        // eingefrorenen Kopie) — sonst würde ein per `add_receiver` nach
        // `start()` hinzugefügter Receiver bei einer nötigen
        // Re-Registrierung (z. B. nach Registry-Neustart) wieder
        // verschwinden.
        let (device_snapshot, receivers_snapshot) = {
            let shared = shared_receivers.lock().expect("lock poisoned");
            (shared.device.clone(), shared.receivers.clone())
        };
        match heartbeat_result {
            Ok(Ok(())) => {}
            Ok(Err(HeartbeatError::NotRegistered)) => {
                register_with_retry(
                    &registry,
                    &node_res,
                    &device_snapshot,
                    &sources,
                    &flows,
                    &senders,
                    &receivers_snapshot,
                )
                .await;
            }
            Ok(Err(e)) => eprintln!("omp-node-sdk: heartbeat failed: {e}"),
            Err(e) => eprintln!("omp-node-sdk: heartbeat task panicked: {e}"),
        }

        if let Some(publisher) = &publisher {
            // Bug 2026-08-07 (docs/decisions.md Nachtrag 123): `status`
            // war bislang IMMER "ok" — der einzige Weg, wie ein Node sich
            // selbst als beeinträchtigt melden konnte, war `media_ready`,
            // und das ist sticky (bleibt für immer `true`, sobald einmal
            // Daten flossen). `liveness.check()` schließt die Lücke: ein
            // registrierter, aber seit dem letzten Tick nicht mehr
            // vorangekommener Worker (z. B. ein still gestorbener MXL-
            // Reader-Thread) zieht `status` auf "degraded", mit den
            // Namen im Log — ohne registrierte Worker (die meisten
            // Node-Typen heute, s. `liveness`-Moduldoku) unverändert
            // immer "ok".
            let (workers_alive, stuck_workers) = liveness.check();
            if !workers_alive {
                eprintln!(
                    "omp-node-sdk: worker liveness check failed, node {node_id} degraded: {stuck_workers:?}"
                );
            }
            let status = health::Status {
                node_id: node_id.clone(),
                label: label.clone(),
                status: if workers_alive { "ok" } else { "degraded" }.to_string(),
                senders: sender_count,
                receivers: receivers_snapshot.len(),
                media_ready: media_ready.is_ready(),
            };
            if let Err(e) = publisher.publish(&status).await {
                eprintln!("omp-node-sdk: health publish failed: {e}");
            }
        }
    }
}

/// Registriert Node, Device und alle Senders/Receivers; wiederholt bei
/// Fehlern bis zum Erfolg (verhindert, dass eine kurzzeitig nicht
/// erreichbare Registry den Node abstürzen lässt — gleiche Resilienz-Linie
/// wie `registerWithRetry` im Go-Mock-Node).
#[allow(clippy::too_many_arguments)]
async fn register_with_retry(
    registry: &RegistryClient,
    node: &NodeResource,
    device: &Device,
    sources: &[Source],
    flows: &[FlowResource],
    senders: &[Sender],
    receivers: &[Receiver],
) {
    loop {
        let registry = registry.clone();
        let node = node.clone();
        let device = device.clone();
        let sources = sources.to_vec();
        let flows = flows.to_vec();
        let senders = senders.to_vec();
        let receivers = receivers.to_vec();

        let result = tokio::task::spawn_blocking(move || -> Result<(), is04::RegisterError> {
            registry.register("node", &node)?;
            registry.register("device", &device)?;
            for s in &sources {
                registry.register("source", s)?;
            }
            for f in &flows {
                registry.register("flow", f)?;
            }
            for s in &senders {
                registry.register("sender", s)?;
            }
            for r in &receivers {
                registry.register("receiver", r)?;
            }
            Ok(())
        })
        .await;

        match result {
            Ok(Ok(())) => return,
            Ok(Err(e)) => eprintln!("omp-node-sdk: registration failed, retrying: {e}"),
            Err(e) => eprintln!("omp-node-sdk: registration task panicked, retrying: {e}"),
        }
        tokio::time::sleep(REGISTER_RETRY_INTERVAL).await;
    }
}
