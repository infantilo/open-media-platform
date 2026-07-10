//! Minimale, gültige IS-04-v1.3-Resources (Node, Device, Sender, Receiver)
//! plus Registration-API-Client. Feldnamen 1:1 vom bereits gegen die
//! Spezifikation geprüften Go-Pendant übernommen (`nodes/mock/internal/is04`,
//! `docs/decisions.md` "IS-04-Feldnamen aus der Spezifikation, nicht aus dem
//! Gedächtnis") — keine erneute Spec-Recherche nötig, da das Wire-Format
//! sprachunabhängig ist.

use std::collections::HashMap;
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const INTERFACE_NAME: &str = "eth0";
const TRANSPORT_RTP: &str = "urn:x-nmos:transport:rtp";
const FORMAT_VIDEO: &str = "urn:x-nmos:format:video";

/// Transport-URN für MXL-Zero-Copy-Sender/-Receiver (`UMSETZUNG.md` C4).
/// `x-omp`, weil MXL (Stand v1.0.1) keine eigene registrierte NMOS-
/// Transport-URN hat — Migrationspunkt, falls AMWA/EBU später eine
/// Standard-URN definieren.
pub const TRANSPORT_MXL: &str = "urn:x-omp:transport:mxl";

/// IS-04-Node-Tag-Name, den der Instanz-Launcher-korrelierte Node-Wert
/// trägt (`UMSETZUNG.md` C8) — Wert ist `OMP_INSTANCE_ID`, Schlüssel
/// dieser konstante String (`orchestrator/internal/registry` liest
/// denselben Tag-Namen als String-Literal, da Go/Rust keine Konstante
/// teilen können).
pub const INSTANCE_TAG: &str = "urn:x-omp:instance";

fn now_version() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Systemzeit vor 1970");
    format!("{}:{}", now.as_secs(), now.subsec_nanos())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeResource {
    pub id: String,
    pub version: String,
    pub label: String,
    pub description: String,
    pub tags: HashMap<String, Vec<String>>,
    pub href: String,
    pub caps: HashMap<String, Value>,
    pub api: NodeApi,
    pub services: Vec<Value>,
    pub clocks: Vec<Value>,
    pub interfaces: Vec<NodeInterface>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeApi {
    pub versions: Vec<String>,
    pub endpoints: Vec<NodeEndpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeEndpoint {
    pub host: String,
    pub port: u16,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInterface {
    pub chassis_id: Option<String>,
    pub port_id: String,
    pub name: String,
}

impl NodeResource {
    /// Baut ein minimales, gültiges Node-Resource für host:port.
    pub fn new(id: &str, label: &str, host: &str, port: u16) -> Self {
        let mac = format!("00-00-00-00-{:02x}-01", port & 0xff);
        NodeResource {
            id: id.to_string(),
            version: now_version(),
            label: label.to_string(),
            description: String::new(),
            tags: HashMap::new(),
            href: format!("http://{host}:{port}/"),
            caps: HashMap::new(),
            api: NodeApi {
                versions: vec!["v1.3".to_string()],
                endpoints: vec![NodeEndpoint {
                    host: host.to_string(),
                    port,
                    protocol: "http".to_string(),
                }],
            },
            services: vec![],
            clocks: vec![],
            interfaces: vec![NodeInterface {
                chassis_id: None,
                port_id: mac,
                name: INTERFACE_NAME.to_string(),
            }],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub version: String,
    pub label: String,
    pub description: String,
    pub tags: HashMap<String, Vec<String>>,
    #[serde(rename = "type")]
    pub device_type: String,
    pub node_id: String,
    pub senders: Vec<String>,
    pub receivers: Vec<String>,
    pub controls: Vec<Value>,
}

impl Device {
    /// Baut ein minimales, gültiges Device-Resource unterhalb von node_id.
    pub fn new(
        id: &str,
        label: &str,
        node_id: &str,
        sender_ids: Vec<String>,
        receiver_ids: Vec<String>,
    ) -> Self {
        Device {
            id: id.to_string(),
            version: now_version(),
            label: label.to_string(),
            description: String::new(),
            tags: HashMap::new(),
            device_type: "urn:x-nmos:device:generic".to_string(),
            node_id: node_id.to_string(),
            senders: sender_ids,
            receivers: receiver_ids,
            controls: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SenderSubscription {
    pub receiver_id: Option<String>,
    pub active: bool,
}

/// Minimale Teilmenge eines IS-04-v1.3-Sender-Resource. Ohne echten
/// gerouteten Flow bleibt `flow_id` immer `None` (wie beim Mock-Node).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sender {
    pub id: String,
    pub version: String,
    pub label: String,
    pub description: String,
    pub tags: HashMap<String, Vec<String>>,
    pub flow_id: Option<String>,
    pub transport: String,
    pub device_id: String,
    pub manifest_href: Option<String>,
    pub interface_bindings: Vec<String>,
    pub subscription: SenderSubscription,
}

impl Sender {
    pub fn new(id: &str, label: &str, device_id: &str) -> Self {
        Sender {
            id: id.to_string(),
            version: now_version(),
            label: label.to_string(),
            description: String::new(),
            tags: HashMap::new(),
            flow_id: None,
            transport: TRANSPORT_RTP.to_string(),
            device_id: device_id.to_string(),
            manifest_href: None,
            interface_bindings: vec![INTERFACE_NAME.to_string()],
            subscription: SenderSubscription {
                receiver_id: None,
                active: false,
            },
        }
    }
}

/// Minimale, gültige IS-04-v1.3-Source-Resource (generisches Video, kein
/// Audio) — Pflichtfeld-Kombination aus `resource_core.json` +
/// `source_core.json` + `source_generic.json`, gegen die AMWA-Spec
/// verifiziert (specs.amwa.tv / `AMWA-TV/is-04` v1.3.x), nicht geraten.
/// Jeder MXL-Sender braucht eine Source (Flows referenzieren `source_id`),
/// aber für OMPs Zwecke (keine Rig-Topologie, ein Sender = eine Source)
/// reicht dieses generische Minimum.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub version: String,
    pub label: String,
    pub description: String,
    pub tags: HashMap<String, Vec<String>>,
    pub caps: HashMap<String, Value>,
    pub device_id: String,
    pub parents: Vec<String>,
    pub clock_name: Option<String>,
    pub format: String,
}

impl Source {
    pub fn new_video(id: &str, label: &str, device_id: &str) -> Self {
        Source {
            id: id.to_string(),
            version: now_version(),
            label: label.to_string(),
            description: String::new(),
            tags: HashMap::new(),
            caps: HashMap::new(),
            device_id: device_id.to_string(),
            parents: vec![],
            clock_name: None,
            format: FORMAT_VIDEO.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrainRate {
    pub numerator: u32,
    pub denominator: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowComponent {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub bit_depth: u32,
}

/// Minimale, gültige IS-04-v1.3-Flow-Resource (Video) — Pflichtfelder aus
/// `resource_core.json` + `flow_core.json` + `flow_video.json` **und**
/// `flow_video_raw.json`, gegen die AMWA-Spec verifiziert. Der zunächst
/// implementierte Feldsatz (nur `flow_video.json`) wurde von nmos-cpp mit
/// "no subschema has succeeded" abgelehnt: das Registration-API-Schema
/// (`flow.json`) validiert `data` nicht gegen `flow_video.json` direkt,
/// sondern gegen `flow_video_raw.json` (o. ä. Coded/Audio/Data-Varianten),
/// welches zusätzlich `media_type` und `components` verlangt (siehe
/// `docs/decisions.md`, C5-Blocker-Eintrag). `media_type`/`components`
/// spiegeln bewusst dieselbe v210-4:2:2-10bit-Struktur wie
/// `omp-mediaio::mxl::video_flow_def` (das MXL-eigene Flow-JSON) — beide
/// beschreiben denselben, tatsächlich über MXL laufenden Videostrom, keine
/// zwei unabhängig geratenen Layouts.
///
/// Konvention (`UMSETZUNG.md` C4): bei MXL-Sendern ist `id` **identisch
/// mit der MXL-`flow-id`** (`mxlsink`-Äquivalent des schreibenden Nodes) —
/// macht Discovery rein IS-04-basiert (C7), ohne Seitenkanal zwischen
/// NMOS und MXL-Domain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Flow {
    pub id: String,
    pub version: String,
    pub label: String,
    pub description: String,
    pub tags: HashMap<String, Vec<String>>,
    pub source_id: String,
    pub device_id: String,
    pub parents: Vec<String>,
    pub grain_rate: GrainRate,
    pub format: String,
    pub media_type: String,
    pub components: Vec<FlowComponent>,
    pub frame_width: u32,
    pub frame_height: u32,
    pub colorspace: String,
    pub interlace_mode: String,
}

impl Flow {
    #[allow(clippy::too_many_arguments)]
    pub fn new_video(
        id: &str,
        label: &str,
        device_id: &str,
        source_id: &str,
        frame_width: u32,
        frame_height: u32,
        grain_rate_numerator: u32,
        grain_rate_denominator: u32,
    ) -> Self {
        Flow {
            id: id.to_string(),
            version: now_version(),
            label: label.to_string(),
            description: String::new(),
            tags: HashMap::new(),
            source_id: source_id.to_string(),
            device_id: device_id.to_string(),
            parents: vec![],
            grain_rate: GrainRate {
                numerator: grain_rate_numerator,
                denominator: grain_rate_denominator,
            },
            format: FORMAT_VIDEO.to_string(),
            media_type: "video/v210".to_string(),
            components: vec![
                FlowComponent {
                    name: "Y".to_string(),
                    width: frame_width,
                    height: frame_height,
                    bit_depth: 10,
                },
                FlowComponent {
                    name: "Cb".to_string(),
                    width: frame_width / 2,
                    height: frame_height,
                    bit_depth: 10,
                },
                FlowComponent {
                    name: "Cr".to_string(),
                    width: frame_width / 2,
                    height: frame_height,
                    bit_depth: 10,
                },
            ],
            frame_width,
            frame_height,
            colorspace: "BT709".to_string(),
            interlace_mode: "progressive".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiverSubscription {
    pub sender_id: Option<String>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiverCaps {
    pub media_types: Vec<String>,
}

/// Minimale Teilmenge eines IS-04-v1.3-Video-Receiver-Resource
/// (`receiver_video.json`: zusätzlich zu receiver_core `format` und `caps`
/// erforderlich).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receiver {
    pub id: String,
    pub version: String,
    pub label: String,
    pub description: String,
    pub tags: HashMap<String, Vec<String>>,
    pub device_id: String,
    pub transport: String,
    pub interface_bindings: Vec<String>,
    pub subscription: ReceiverSubscription,
    pub format: String,
    pub caps: ReceiverCaps,
}

impl Receiver {
    pub fn new(id: &str, label: &str, device_id: &str) -> Self {
        Receiver {
            id: id.to_string(),
            version: now_version(),
            label: label.to_string(),
            description: String::new(),
            tags: HashMap::new(),
            device_id: device_id.to_string(),
            transport: TRANSPORT_RTP.to_string(),
            interface_bindings: vec![INTERFACE_NAME.to_string()],
            subscription: ReceiverSubscription {
                sender_id: None,
                active: false,
            },
            format: FORMAT_VIDEO.to_string(),
            caps: ReceiverCaps {
                media_types: vec!["video/raw".to_string()],
            },
        }
    }
}

/// Fehler beim Registrieren einer Resource.
#[derive(Debug)]
pub enum RegisterError {
    Request(String),
    Status(u16),
}

impl fmt::Display for RegisterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RegisterError::Request(e) => write!(f, "register: {e}"),
            RegisterError::Status(code) => write!(f, "register: unexpected status {code}"),
        }
    }
}

impl std::error::Error for RegisterError {}

/// Fehler beim Heartbeat. `NotRegistered` (HTTP 404) signalisiert dem
/// Aufrufer, dass neu registriert werden muss (z. B. nach einem
/// Registry-Neustart) — Pendant zu `is04.ErrNotRegistered` im Go-Mock-Node.
#[derive(Debug)]
pub enum HeartbeatError {
    NotRegistered,
    Request(String),
    Status(u16),
}

impl fmt::Display for HeartbeatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HeartbeatError::NotRegistered => write!(f, "heartbeat: node not registered (404)"),
            HeartbeatError::Request(e) => write!(f, "heartbeat: {e}"),
            HeartbeatError::Status(code) => write!(f, "heartbeat: unexpected status {code}"),
        }
    }
}

impl std::error::Error for HeartbeatError {}

/// Fehler beim Abfragen der Query-API.
#[derive(Debug)]
pub enum QueryError {
    Request(String),
    Status(u16),
}

impl fmt::Display for QueryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            QueryError::Request(e) => write!(f, "query: {e}"),
            QueryError::Status(code) => write!(f, "query: unexpected status {code}"),
        }
    }
}

impl std::error::Error for QueryError {}

/// Client für eine Standard-IS-04-Registration-API (v1.3). Hält nur die
/// Basis-URL, daher billig klonbar (nötig, um Aufrufe per
/// `spawn_blocking` in einen eigenen Thread zu verschieben).
#[derive(Debug, Clone)]
pub struct RegistryClient {
    base_url: String,
}

impl RegistryClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let mut base_url = base_url.into();
        while base_url.ends_with('/') {
            base_url.pop();
        }
        RegistryClient { base_url }
    }

    /// Meldet eine Resource vom angegebenen Typ ("node", "device", "sender",
    /// "receiver") an. 200 und 201 gelten beide als Erfolg (IS-04-Spec) —
    /// ureq behandelt jeden 2xx-Status standardmäßig als `Ok`.
    pub fn register<T: Serialize>(
        &self,
        resource_type: &str,
        data: &T,
    ) -> Result<(), RegisterError> {
        let body = serde_json::json!({"type": resource_type, "data": data});
        let url = format!("{}/x-nmos/registration/v1.3/resource", self.base_url);
        match ureq::post(&url).send_json(body) {
            Ok(_) => Ok(()),
            Err(ureq::Error::StatusCode(code)) => Err(RegisterError::Status(code)),
            Err(e) => Err(RegisterError::Request(e.to_string())),
        }
    }

    /// Löst einen Sender per Standard-IS-04-Query-API auf (`GET
    /// .../senders/<id>`, dieselbe Registry-Basis-URL wie die
    /// Registration-API, siehe `orchestrator/internal/registry/client.go`)
    /// — Grundlage für `omp-viewer`s Quellwahl über IS-05-Receiver-PATCH
    /// (`UMSETZUNG.md` C6): der Receiver kennt aus dem PATCH-Body nur die
    /// `sender_id` und muss daraus `flow_id` ableiten (Konvention
    /// Flow-UUID == MXL-`flow-id`, `UMSETZUNG.md` C4).
    pub fn get_sender(&self, sender_id: &str) -> Result<Sender, QueryError> {
        let url = format!("{}/x-nmos/query/v1.3/senders/{}", self.base_url, sender_id);
        match ureq::get(&url).call() {
            Ok(mut resp) => resp
                .body_mut()
                .read_json::<Sender>()
                .map_err(|e| QueryError::Request(e.to_string())),
            Err(ureq::Error::StatusCode(code)) => Err(QueryError::Status(code)),
            Err(e) => Err(QueryError::Request(e.to_string())),
        }
    }

    /// Listet alle bei der Registry registrierten Sender (`GET
    /// .../senders`, dieselbe Query-API wie `get_sender`) — Grundlage für
    /// `omp-switcher`s reine IS-04-Discovery (`UMSETZUNG.md` C7, gleicher
    /// Poll-Stil wie A5/`orchestrator/internal/registry/client.go`, hier
    /// aber ohne Node-/Device-Join: der Switcher braucht pro Sender nur
    /// `id`/`label`/`transport`/`flow_id`, kein Graph-Modell).
    pub fn list_senders(&self) -> Result<Vec<Sender>, QueryError> {
        let url = format!("{}/x-nmos/query/v1.3/senders", self.base_url);
        match ureq::get(&url).call() {
            Ok(mut resp) => resp
                .body_mut()
                .read_json::<Vec<Sender>>()
                .map_err(|e| QueryError::Request(e.to_string())),
            Err(ureq::Error::StatusCode(code)) => Err(QueryError::Status(code)),
            Err(e) => Err(QueryError::Request(e.to_string())),
        }
    }

    /// Hält eine registrierte Node am Leben (muss innerhalb von
    /// `registration_expiry_interval` wiederholt werden).
    pub fn heartbeat(&self, node_id: &str) -> Result<(), HeartbeatError> {
        let url = format!(
            "{}/x-nmos/registration/v1.3/health/nodes/{}",
            self.base_url, node_id
        );
        match ureq::post(&url).send(()) {
            Ok(_) => Ok(()),
            Err(ureq::Error::StatusCode(404)) => Err(HeartbeatError::NotRegistered),
            Err(ureq::Error::StatusCode(code)) => Err(HeartbeatError::Status(code)),
            Err(e) => Err(HeartbeatError::Request(e.to_string())),
        }
    }
}
