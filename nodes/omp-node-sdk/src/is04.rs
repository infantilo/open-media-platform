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
