//! Generischer IS-05-Sender-Connection-Endpoint (`staged`/`active`/
//! `transportfile`) für genau einen Sender pro Instanz — Rust-Pendant zu
//! `nodes/mock/internal/connection` (Go), das dort bewusst nur
//! Receiver-seitig implementiert ist ("Sender-seitige
//! Connection-Endpoints ... für B1 nicht nötig", `docs/decisions.md`).
//! Genau diese Lücke füllt `UMSETZUNG.md` C3. Feldnamen geprüft gegen
//! AMWA-TV/is-05 (Branch v1.1.x, `sender-stage-schema.json`,
//! `sender_transport_params_rtp.json`, `ConnectionAPI.raml` für die
//! `/transportfile`-Route).
//!
//! Kennt kein HTTP — der Node verdrahtet die Pfade selbst über
//! `ParamStore::extra_route` (`server::RawResponse`), damit dieses Modul
//! transportunabhängig bleibt.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Eine Transport-Parameter-"Leg" eines Senders (`sender_transport_params_
/// rtp.json`) — hier immer genau ein Element (keine 2022-7-Redundanz).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TransportParams {
    pub destination_ip: Option<String>,
    pub destination_port: Option<u16>,
    pub rtp_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Activation {
    pub mode: Option<String>,
    pub requested_time: Option<String>,
}

/// `staged`/`active`-Repräsentation eines Senders
/// (`sender-stage-schema.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SenderResource {
    pub receiver_id: Option<String>,
    pub master_enable: bool,
    pub activation: Activation,
    pub transport_params: Vec<TransportParams>,
}

impl Default for SenderResource {
    fn default() -> Self {
        SenderResource {
            receiver_id: None,
            master_enable: false,
            activation: Activation::default(),
            transport_params: vec![TransportParams::default()],
        }
    }
}

/// Reagiert auf Zustandsänderungen einer IS-05-Sender-Connection (z. B.
/// die RTP-Ausgabe des Playout-Node über `omp-mediaio`). Node-spezifisch,
/// eine Implementierung pro Sender.
pub trait SenderControl: Send + Sync + 'static {
    fn apply(&self, resource: &SenderResource);
}

/// Baut die SDP für `.../transportfile` aus dem aktuellen Zustand.
pub trait SenderSdp: Send + Sync + 'static {
    fn sdp(&self, resource: &SenderResource) -> String;
}

/// Verbindet einen `SenderControl` (wirkt die PATCHes tatsächlich aus)
/// mit einem `SenderSdp` (beschreibt den aktuellen Zustand als SDP) und
/// verwaltet den staged/active-Zustand dazwischen.
pub struct SenderConnection<C, S> {
    sender_id: String,
    control: C,
    sdp: S,
    state: Mutex<SenderResource>,
}

impl<C: SenderControl, S: SenderSdp> SenderConnection<C, S> {
    pub fn new(sender_id: impl Into<String>, control: C, sdp: S) -> Self {
        SenderConnection {
            sender_id: sender_id.into(),
            control,
            sdp,
            state: Mutex::new(SenderResource::default()),
        }
    }

    /// Bearbeitet eine Anfrage, falls `path` zu diesem Sender gehört —
    /// `None`, wenn `path` keinen der drei Endpunkte dieses Senders trifft
    /// (Aufrufer versucht dann andere Routen/liefert 404).
    pub fn handle(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> Option<(u16, &'static str, Vec<u8>)> {
        let prefix = format!("/x-nmos/connection/v1.1/single/senders/{}/", self.sender_id);
        let sub = path.strip_prefix(&prefix)?;

        match (method, sub) {
            ("GET", "staged") | ("GET", "active") => {
                let state = self.state.lock().expect("lock poisoned");
                Some((
                    200,
                    "application/json",
                    serde_json::to_vec(&*state).unwrap_or_default(),
                ))
            }
            ("PATCH", "staged") => Some(self.patch_staged(body)),
            ("GET", "transportfile") => {
                let state = self.state.lock().expect("lock poisoned");
                Some((200, "application/sdp", self.sdp.sdp(&state).into_bytes()))
            }
            _ => None,
        }
    }

    fn patch_staged(&self, body: &[u8]) -> (u16, &'static str, Vec<u8>) {
        let Ok(patch) = serde_json::from_slice::<Value>(body) else {
            return (400, "text/plain", b"invalid JSON body".to_vec());
        };

        let mut state = self.state.lock().expect("lock poisoned");
        if let Some(v) = patch.get("master_enable").and_then(Value::as_bool) {
            state.master_enable = v;
        }
        if let Some(v) = patch.get("receiver_id")
            && let Ok(receiver_id) = serde_json::from_value(v.clone())
        {
            state.receiver_id = receiver_id;
        }
        if let Some(activation) = patch.get("activation")
            && let Ok(activation) = serde_json::from_value(activation.clone())
        {
            state.activation = activation;
        }
        if let Some(params) = patch.get("transport_params").and_then(Value::as_array)
            && let Some(first) = params.first()
        {
            let leg = &mut state.transport_params[0];
            if let Some(ip) = first.get("destination_ip").and_then(Value::as_str) {
                leg.destination_ip = Some(ip.to_string());
            }
            if let Some(port) = first.get("destination_port").and_then(Value::as_u64) {
                leg.destination_port = Some(port as u16);
            }
            if let Some(enabled) = first.get("rtp_enabled").and_then(Value::as_bool) {
                leg.rtp_enabled = enabled;
            }
        }

        self.control.apply(&state);
        (
            200,
            "application/json",
            serde_json::to_vec(&*state).unwrap_or_default(),
        )
    }
}
