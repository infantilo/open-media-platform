//! Generische NMOS IS-08 (Audio Channel Mapping) API — `UMSETZUNG.md`
//! D17, `ARCHITECTURE.md` §13.2/§4.6. Feldnamen/Endpunkte gegen die
//! echte AMWA-Spec verifiziert (`AMWA-TV/is-08`, Branch `v1.0.x`:
//! `APIs/ChannelMappingAPI.raml` + `APIs/schemas/*.json` +
//! `examples/*.json`), nicht geraten — inklusive eines echten
//! Schema-Fehlers dort (`map-activations-post-request-schema.json`
//! nennt das Aktions-Feld `"action:"` mit Doppelpunkt; jedes echte
//! Beispiel (`examples/map/map-activations-post.json` etc.) verwendet
//! durchgehend `"action"` ohne Doppelpunkt — dieses Modul folgt den
//! Beispielen, nicht dem kaputten Schema).
//!
//! IS-08 modelliert Inputs/Outputs bewusst als **lokale, nicht bei der
//! Registry registrierte** Ressourcen (`docs/Overview.html`: "Inputs and
//! Outputs are resources local to the device") — ein Input bündelt die
//! Kanäle einer eingehenden Quelle (i. d. R. ein IS-04-Receiver oder eine
//! sonstige externe Quelle), ein Output die Kanäle, die einer IS-04-
//! Source zugeordnet sind oder extern verlassen (z. B. Lautsprecher/
//! Netzwerk-Ausgang). Die tatsächliche Matrix lebt in `map/active` und
//! wird per `POST map/activations` verändert.
//!
//! Kennt kein HTTP — der Node verdrahtet die Pfade selbst über
//! `ParamStore::extra_route`/`extra_options` (gleiches Muster wie
//! `crate::connection`), damit dieses Modul transportunabhängig bleibt.
//!
//! **Bewusst nicht Teil dieser Runde (D17):** zeitgesteuerte Aktivierung
//! (`activate_scheduled_absolute`/`_relative`) — genau dieselbe
//! Scope-Grenze wie beim Rust-Pendant der IS-05-Connection-API
//! (`crate::connection::Activation` kennt ebenfalls nur `mode`/
//! `requested_time`, keinen echten Scheduler; nur der Go-Mock-Node hat
//! seit D11 einen echten TAI-Timer). `POST map/activations` akzeptiert
//! deshalb nur `activate_immediate`, alles andere liefert 400 mit
//! benanntem Grund statt stillschweigend zu ignorieren.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// IS-04-`Device.controls[].type` unter dem die Channel Mapping API
/// anzukündigen ist (`docs/Interoperability - NMOS IS-04.md`: "the
/// common type 'urn:x-nmos:control:cm-ctrl/v1.0'").
pub const CONTROL_TYPE: &str = "urn:x-nmos:control:cm-ctrl/v1.0";

const PREFIX: &str = "/x-nmos/channelmapping/v1.0/";

fn strip_prefix(path: &str) -> Option<&str> {
    let sub = path.strip_prefix(PREFIX)?;
    Some(sub.strip_suffix('/').unwrap_or(sub))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub label: String,
}

/// Woher die Kanäle eines Inputs stammen (`input-parent-response-
/// schema.json`) — `None`/`None`, wenn es keine passende IS-04-Ressource
/// gibt (z. B. ein reiner physischer/externer Zufluss).
#[derive(Debug, Clone)]
pub struct InputSpec {
    pub id: String,
    pub name: String,
    pub description: String,
    pub channels: Vec<Channel>,
    pub parent_id: Option<String>,
    pub parent_type: Option<&'static str>,
    /// `input-caps-response-schema.json`: ob der Node Kanäle innerhalb
    /// dieses Inputs beliebig umsortieren kann, und in welchen Blöcken
    /// (1 = jeder Kanal einzeln routbar).
    pub reordering: bool,
    pub block_size: u32,
}

/// `output-caps-response-schema.json`: `None` = keine Einschränkung
/// (jeder Input routbar), `Some(list)` = genau diese Inputs (ein
/// `None`-Eintrag in der Liste erlaubt zusätzlich explizit "unrouted").
#[derive(Debug, Clone)]
pub struct OutputSpec {
    pub id: String,
    pub name: String,
    pub description: String,
    pub channels: Vec<Channel>,
    pub source_id: Option<String>,
    pub routable_inputs: Option<Vec<Option<String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct MapEntry {
    pub input: Option<String>,
    pub channel_index: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ActivationInfo {
    pub mode: Option<String>,
    pub requested_time: Option<String>,
    pub activation_time: Option<String>,
}

/// Reagiert auf eine tatsächlich aktivierte Änderung der Map eines
/// Outputs (z. B. `omp-aes67-gateway`s `audiomixmatrix`-Property neu
/// setzen) — Node-spezifisch, eine Implementierung pro
/// [`ChannelMapping`]. Gleiches Muster wie `crate::connection::
/// ReceiverControl`.
pub trait ChannelMapApply: Send + Sync + 'static {
    fn apply(&self, output_id: &str, map: &BTreeMap<u32, MapEntry>);
}

struct State {
    activation: ActivationInfo,
    map: BTreeMap<String, BTreeMap<u32, MapEntry>>,
    next_activation_id: u64,
}

/// `now_tai_string` liefert nur ein formatkorrektes `"<sek>:<nsek>"`
/// (UTC≈TAI für den Ausgabewert genügt — s. `nodes/mock/internal/
/// connection/receiver.go::taiUtcOffsetSeconds`-Doku für dieselbe,
/// bereits an AMWA-Tests verifizierte Begründung: nur ein vom Client
/// gesendeter ABSOLUTER `requested_time` bräuchte den echten
/// TAI-UTC-Versatz beim Zurückrechnen, den dieses Modul mangels
/// Scheduling-Unterstützung gar nicht parst).
fn now_tai_string() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}:{}", now.as_secs(), now.subsec_nanos())
}

fn json_response(status: u16, value: &impl Serialize) -> Option<(u16, &'static str, Vec<u8>)> {
    Some((status, "application/json", serde_json::to_vec(value).unwrap_or_default()))
}

fn error_response(status: u16, message: &str) -> Option<(u16, &'static str, Vec<u8>)> {
    Some((
        status,
        "application/json",
        serde_json::to_vec(&serde_json::json!({"code": status, "error": message, "debug": null}))
            .unwrap_or_default(),
    ))
}

/// Wählt den einzigen eindeutigen Kandidaten-Input für den
/// Default-/Identitäts-Zustand einer neu erstellten [`ChannelMapping`] —
/// `None`, wenn keiner oder mehr als einer infrage kommt (dann bleibt
/// der Output beim sicheren Default "unrouted" statt zu raten, welcher
/// Input gemeint ist).
fn sole_candidate_input<'a>(
    output: &OutputSpec,
    inputs: &'a HashMap<String, InputSpec>,
) -> Option<&'a InputSpec> {
    let candidate_ids: Vec<&String> = match &output.routable_inputs {
        Some(list) => list.iter().filter_map(|entry| entry.as_ref()).collect(),
        None => inputs.keys().collect(),
    };
    match candidate_ids.as_slice() {
        [only] => inputs.get(*only),
        _ => None,
    }
}

/// Generische IS-08-API-Instanz: Inputs/Outputs sind bei Konstruktion
/// fest (lokale Ressourcen, s. Moduldoku), die aktive Map ist veränderlich
/// über `POST map/activations`.
pub struct ChannelMapping<A> {
    inputs: HashMap<String, InputSpec>,
    outputs: HashMap<String, OutputSpec>,
    input_order: Vec<String>,
    output_order: Vec<String>,
    state: Mutex<State>,
    apply: A,
}

impl<A: ChannelMapApply> ChannelMapping<A> {
    /// Baut die API-Instanz und aktiviert sofort einen Identitäts-
    /// Default (Kanal `i` jedes Outputs kommt von Kanal `i` des einzigen
    /// eindeutigen Inputs, überzählige Output-Kanäle bleiben unrouted) —
    /// ruft dafür `apply` einmal pro Output auf, damit der Aufrufer keine
    /// eigene, zweite Default-Berechnung braucht (die Pipeline soll von
    /// Anfang an exakt das fahren, was `GET map/active` zeigt).
    pub fn new(inputs: Vec<InputSpec>, outputs: Vec<OutputSpec>, apply: A) -> Self {
        let input_order: Vec<String> = inputs.iter().map(|i| i.id.clone()).collect();
        let output_order: Vec<String> = outputs.iter().map(|o| o.id.clone()).collect();
        let inputs: HashMap<String, InputSpec> = inputs.into_iter().map(|i| (i.id.clone(), i)).collect();
        let outputs_map: HashMap<String, OutputSpec> = outputs.into_iter().map(|o| (o.id.clone(), o)).collect();

        let mut map: BTreeMap<String, BTreeMap<u32, MapEntry>> = BTreeMap::new();
        for output_id in &output_order {
            let output = &outputs_map[output_id];
            let source = sole_candidate_input(output, &inputs);
            let mut entries = BTreeMap::new();
            for (i, _channel) in output.channels.iter().enumerate() {
                let i = i as u32;
                let entry = match source {
                    Some(input) if (i as usize) < input.channels.len() => {
                        MapEntry { input: Some(input.id.clone()), channel_index: Some(i) }
                    }
                    _ => MapEntry::default(),
                };
                entries.insert(i, entry);
            }
            map.insert(output_id.clone(), entries);
        }

        for (output_id, entries) in &map {
            apply.apply(output_id, entries);
        }

        ChannelMapping {
            inputs,
            outputs: outputs_map,
            input_order,
            output_order,
            state: Mutex::new(State { activation: ActivationInfo::default(), map, next_activation_id: 1 }),
            apply,
        }
    }

    fn input_channels_response(&self, input: &InputSpec) -> Vec<u8> {
        serde_json::to_vec(&input.channels).unwrap_or_default()
    }

    fn input_caps_response(&self, input: &InputSpec) -> Value {
        serde_json::json!({"reordering": input.reordering, "block_size": input.block_size})
    }

    fn input_parent_response(&self, input: &InputSpec) -> Value {
        serde_json::json!({"id": input.parent_id, "type": input.parent_type})
    }

    fn output_caps_response(&self, output: &OutputSpec) -> Value {
        serde_json::json!({"routable_inputs": output.routable_inputs})
    }

    fn io_response(&self) -> Value {
        let inputs: serde_json::Map<String, Value> = self
            .input_order
            .iter()
            .map(|id| {
                let input = &self.inputs[id];
                (
                    id.clone(),
                    serde_json::json!({
                        "properties": {"name": input.name, "description": input.description},
                        "parent": self.input_parent_response(input),
                        "channels": input.channels,
                        "caps": self.input_caps_response(input),
                    }),
                )
            })
            .collect();
        let outputs: serde_json::Map<String, Value> = self
            .output_order
            .iter()
            .map(|id| {
                let output = &self.outputs[id];
                (
                    id.clone(),
                    serde_json::json!({
                        "properties": {"name": output.name, "description": output.description},
                        "source_id": output.source_id,
                        "channels": output.channels,
                        "caps": self.output_caps_response(output),
                    }),
                )
            })
            .collect();
        serde_json::json!({"inputs": inputs, "outputs": outputs})
    }

    /// Bearbeitet eine Anfrage, falls `path` unter das Channel-Mapping-
    /// API-Präfix dieses Nodes fällt — `None` sonst.
    pub fn handle(&self, method: &str, path: &str, body: &[u8]) -> Option<(u16, &'static str, Vec<u8>)> {
        let sub = strip_prefix(path)?;
        let mut parts = sub.splitn(3, '/');
        match (method, parts.next().unwrap_or(""), parts.next(), parts.next()) {
            ("GET", "", None, None) => json_response(200, &["inputs/", "outputs/", "map/", "io/"]),
            ("GET", "inputs", None, None) => {
                let listing: Vec<String> = self.input_order.iter().map(|id| format!("{id}/")).collect();
                json_response(200, &listing)
            }
            ("GET", "outputs", None, None) => {
                let listing: Vec<String> = self.output_order.iter().map(|id| format!("{id}/")).collect();
                json_response(200, &listing)
            }
            ("GET", "io", None, None) => json_response(200, &self.io_response()),
            ("GET", "map", None, None) => json_response(200, &["activations/", "active/"]),
            ("GET", "map", Some("active"), None) => self.get_map_active(),
            ("GET", "map", Some("active"), Some(output_id)) => self.get_map_active_output(output_id),
            ("GET", "map", Some("activations"), None) => {
                json_response(200, &serde_json::Map::<String, Value>::new())
            }
            ("POST", "map", Some("activations"), None) => self.post_activation(body),
            // Kein Scheduling (Moduldoku) ⇒ nie eine ausstehende
            // Aktivierung — konsistent 404 statt eine nie erreichbare
            // Ressource vorzutäuschen.
            ("GET", "map", Some("activations"), Some(_)) => {
                error_response(404, "no pending scheduled activation")
            }
            ("DELETE", "map", Some("activations"), Some(_)) => {
                error_response(404, "no pending scheduled activation")
            }
            ("GET", "inputs", Some(id), leaf) => self.get_input(id, leaf),
            ("GET", "outputs", Some(id), leaf) => self.get_output(id, leaf),
            _ => None,
        }
    }

    /// s. `crate::connection::SenderConnection::cors_methods` — nur die
    /// Pfade, für die die RAML tatsächlich einen `options:`-Block
    /// definiert (`/map/activations`, `/map/activations/{id}`).
    pub fn cors_methods(&self, path: &str) -> Option<Vec<&'static str>> {
        let sub = strip_prefix(path)?;
        if sub == "map/activations" {
            return Some(vec!["GET", "POST"]);
        }
        if sub.starts_with("map/activations/") {
            return Some(vec!["GET", "DELETE"]);
        }
        None
    }

    fn get_input(&self, id: &str, leaf: Option<&str>) -> Option<(u16, &'static str, Vec<u8>)> {
        let input = self.inputs.get(id)?;
        match leaf {
            None | Some("") => json_response(200, &["properties/", "parent/", "channels/", "caps/"]),
            Some("properties") => {
                json_response(200, &serde_json::json!({"name": input.name, "description": input.description}))
            }
            Some("parent") => json_response(200, &self.input_parent_response(input)),
            Some("channels") => Some((200, "application/json", self.input_channels_response(input))),
            Some("caps") => json_response(200, &self.input_caps_response(input)),
            _ => None,
        }
    }

    fn get_output(&self, id: &str, leaf: Option<&str>) -> Option<(u16, &'static str, Vec<u8>)> {
        let output = self.outputs.get(id)?;
        match leaf {
            None | Some("") => json_response(200, &["properties/", "sourceid/", "channels/", "caps/"]),
            Some("properties") => {
                json_response(200, &serde_json::json!({"name": output.name, "description": output.description}))
            }
            Some("sourceid") => json_response(200, &output.source_id),
            Some("channels") => json_response(200, &output.channels),
            Some("caps") => json_response(200, &self.output_caps_response(output)),
            _ => None,
        }
    }

    fn get_map_active(&self) -> Option<(u16, &'static str, Vec<u8>)> {
        let state = self.state.lock().expect("lock poisoned");
        json_response(200, &serde_json::json!({"activation": state.activation, "map": state.map}))
    }

    fn get_map_active_output(&self, output_id: &str) -> Option<(u16, &'static str, Vec<u8>)> {
        if !self.outputs.contains_key(output_id) {
            return error_response(404, "unknown output");
        }
        let state = self.state.lock().expect("lock poisoned");
        let entries = state.map.get(output_id).cloned().unwrap_or_default();
        let mut one = BTreeMap::new();
        one.insert(output_id.to_string(), entries);
        json_response(200, &serde_json::json!({"activation": state.activation, "map": one}))
    }

    /// `POST map/activations` — nur `activate_immediate` (Moduldoku).
    /// `action` wird als **partielles** Map-Update angewendet (Behaviour.
    /// md: "The API MUST leave values not expressly updated in the POST
    /// request unchanged"), nicht als Ersatz der gesamten Map.
    fn post_activation(&self, body: &[u8]) -> Option<(u16, &'static str, Vec<u8>)> {
        #[derive(Deserialize)]
        struct ActivationRequest {
            mode: Option<String>,
        }
        #[derive(Deserialize)]
        struct PostBody {
            activation: ActivationRequest,
            action: BTreeMap<String, BTreeMap<String, MapEntry>>,
        }

        let Ok(req) = serde_json::from_slice::<PostBody>(body) else {
            return error_response(400, "invalid JSON body");
        };
        if req.activation.mode.as_deref() != Some("activate_immediate") {
            return error_response(
                400,
                "only activate_immediate is supported (no scheduled-activation clock implemented)",
            );
        }

        // Validieren, bevor irgendetwas angewendet wird — ein teilweise
        // angewendetes, ungültiges Update wäre schlimmer als ein
        // abgelehntes (gleiche Reihenfolge wie `ReceiverConnection::
        // patch_staged`, dort aber ohne Cross-Referenz-Prüfung nötig).
        for (output_id, channels) in &req.action {
            let Some(output) = self.outputs.get(output_id) else {
                return error_response(400, &format!("unknown output: {output_id}"));
            };
            for (channel_index_str, entry) in channels {
                let Ok(channel_index) = channel_index_str.parse::<u32>() else {
                    return error_response(400, &format!("invalid channel index: {channel_index_str}"));
                };
                if channel_index as usize >= output.channels.len() {
                    return error_response(400, &format!("channel index out of range: {channel_index}"));
                }
                if entry.input.is_some() != entry.channel_index.is_some() {
                    return error_response(400, "input and channel_index must both be null or both be set");
                }
                if let Some(input_id) = &entry.input {
                    let Some(input) = self.inputs.get(input_id) else {
                        return error_response(400, &format!("unknown input: {input_id}"));
                    };
                    if let Some(allowed) = &output.routable_inputs
                        && !allowed.iter().any(|a| a.as_deref() == Some(input_id.as_str()))
                    {
                        return error_response(400, &format!("input {input_id} is not routable to {output_id}"));
                    }
                    if entry.channel_index.expect("checked above") as usize >= input.channels.len() {
                        return error_response(400, "channel_index out of range for input");
                    }
                } else if let Some(allowed) = &output.routable_inputs
                    && !allowed.iter().any(|a| a.is_none())
                {
                    return error_response(400, &format!("output {output_id} does not allow unrouted channels"));
                }
            }
        }

        let (activation_id, activation_info) = {
            let mut state = self.state.lock().expect("lock poisoned");
            for (output_id, channels) in &req.action {
                let entries = state.map.entry(output_id.clone()).or_default();
                for (channel_index_str, entry) in channels {
                    let channel_index: u32 = channel_index_str.parse().expect("validated above");
                    entries.insert(channel_index, entry.clone());
                }
            }
            state.activation = ActivationInfo {
                mode: Some("activate_immediate".to_string()),
                requested_time: None,
                activation_time: Some(now_tai_string()),
            };
            let id = state.next_activation_id;
            state.next_activation_id += 1;

            for output_id in req.action.keys() {
                self.apply.apply(output_id, &state.map[output_id]);
            }

            (id, state.activation.clone())
        };

        json_response(
            200,
            &serde_json::json!({activation_id.to_string(): {"activation": activation_info, "action": req.action}}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RecordingApply {
        calls: Mutex<Vec<(String, BTreeMap<u32, MapEntry>)>>,
    }
    impl RecordingApply {
        fn new() -> Self {
            RecordingApply { calls: Mutex::new(Vec::new()) }
        }
    }
    impl ChannelMapApply for RecordingApply {
        fn apply(&self, output_id: &str, map: &BTreeMap<u32, MapEntry>) {
            self.calls.lock().expect("lock poisoned").push((output_id.to_string(), map.clone()));
        }
    }

    fn two_channel(label_prefix: &str) -> Vec<Channel> {
        vec![Channel { label: format!("{label_prefix} 1") }, Channel { label: format!("{label_prefix} 2") }]
    }

    fn gateway_fixture() -> ChannelMapping<RecordingApply> {
        let input = InputSpec {
            id: "aes67-in".to_string(),
            name: "AES67 Input".to_string(),
            description: "Incoming AES67 stream".to_string(),
            channels: two_channel("Channel"),
            parent_id: None,
            parent_type: None,
            reordering: true,
            block_size: 1,
        };
        let output = OutputSpec {
            id: "mxl-out".to_string(),
            name: "MXL Output".to_string(),
            description: "Outgoing MXL flow".to_string(),
            channels: two_channel("Channel"),
            source_id: Some("11111111-1111-1111-8111-111111111111".to_string()),
            routable_inputs: Some(vec![Some("aes67-in".to_string()), None]),
        };
        ChannelMapping::new(vec![input], vec![output], RecordingApply::new())
    }

    fn body_str(resp: Option<(u16, &'static str, Vec<u8>)>) -> (u16, String) {
        let (status, _content_type, body) = resp.expect("route matched");
        (status, String::from_utf8(body).expect("valid utf-8"))
    }

    #[test]
    fn base_discovery_routes() {
        let cm = gateway_fixture();
        let (status, body) = body_str(cm.handle("GET", "/x-nmos/channelmapping/v1.0/", b""));
        assert_eq!(status, 200);
        assert_eq!(body, r#"["inputs/","outputs/","map/","io/"]"#);

        let (status, body) = body_str(cm.handle("GET", "/x-nmos/channelmapping/v1.0/inputs/", b""));
        assert_eq!(status, 200);
        assert_eq!(body, r#"["aes67-in/"]"#);

        let (status, body) = body_str(cm.handle("GET", "/x-nmos/channelmapping/v1.0/outputs", b""));
        assert_eq!(status, 200);
        assert_eq!(body, r#"["mxl-out/"]"#);
    }

    #[test]
    fn identity_default_map_and_initial_apply() {
        let cm = gateway_fixture();
        let (status, body) = body_str(cm.handle("GET", "/x-nmos/channelmapping/v1.0/map/active", b""));
        assert_eq!(status, 200);
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["map"]["mxl-out"]["0"]["input"], "aes67-in");
        assert_eq!(parsed["map"]["mxl-out"]["0"]["channel_index"], 0);
        assert_eq!(parsed["map"]["mxl-out"]["1"]["input"], "aes67-in");
        assert_eq!(parsed["map"]["mxl-out"]["1"]["channel_index"], 1);
        assert!(parsed["activation"]["mode"].is_null());

        // `new()` muss die Identitäts-Map einmal an `apply` gemeldet
        // haben, ohne dass irgendein POST nötig war (Moduldoku).
        let calls = cm.apply.calls.lock().expect("lock poisoned");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "mxl-out");
        assert_eq!(calls[0].1.get(&0).unwrap().input.as_deref(), Some("aes67-in"));
    }

    #[test]
    fn immediate_activation_swaps_two_channels() {
        let cm = gateway_fixture();
        let body = br#"{
            "activation": {"mode": "activate_immediate"},
            "action": {"mxl-out": {
                "0": {"input": "aes67-in", "channel_index": 1},
                "1": {"input": "aes67-in", "channel_index": 0}
            }}
        }"#;
        let (status, resp) =
            body_str(cm.handle("POST", "/x-nmos/channelmapping/v1.0/map/activations", body));
        assert_eq!(status, 200);
        let parsed: Value = serde_json::from_str(&resp).unwrap();
        let (_, entry) = parsed.as_object().unwrap().iter().next().unwrap();
        assert_eq!(entry["activation"]["mode"], "activate_immediate");
        assert!(!entry["activation"]["activation_time"].is_null());

        let (_, active_body) = body_str(cm.handle("GET", "/x-nmos/channelmapping/v1.0/map/active", b""));
        let active: Value = serde_json::from_str(&active_body).unwrap();
        assert_eq!(active["map"]["mxl-out"]["0"]["channel_index"], 1);
        assert_eq!(active["map"]["mxl-out"]["1"]["channel_index"], 0);
        assert_eq!(active["activation"]["mode"], "activate_immediate");

        // Zweiter `apply`-Aufruf (erster war der Identitäts-Default aus
        // `new()`) muss die neue, vertauschte Map tragen.
        let calls = cm.apply.calls.lock().expect("lock poisoned");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].1.get(&0).unwrap().channel_index, Some(1));
    }

    #[test]
    fn scheduled_activation_rejected() {
        let cm = gateway_fixture();
        let body = br#"{"activation": {"mode": "activate_scheduled_absolute", "requested_time": "1:0"}, "action": {}}"#;
        let (status, _) = body_str(cm.handle("POST", "/x-nmos/channelmapping/v1.0/map/activations", body));
        assert_eq!(status, 400);
    }

    #[test]
    fn unroutable_input_rejected() {
        let cm = gateway_fixture();
        let body = br#"{"activation": {"mode": "activate_immediate"}, "action": {"mxl-out": {"0": {"input": "nope", "channel_index": 0}}}}"#;
        let (status, _) = body_str(cm.handle("POST", "/x-nmos/channelmapping/v1.0/map/activations", body));
        assert_eq!(status, 400);

        // Nichts darf angewendet worden sein (Validierung vor Anwendung).
        let calls = cm.apply.calls.lock().expect("lock poisoned");
        assert_eq!(calls.len(), 1); // nur der Identitäts-Default aus `new()`
    }

    #[test]
    fn unrouted_entry_allowed_when_routable_inputs_lists_null() {
        let cm = gateway_fixture();
        let body = br#"{"activation": {"mode": "activate_immediate"}, "action": {"mxl-out": {"0": {"input": null, "channel_index": null}}}}"#;
        let (status, _) = body_str(cm.handle("POST", "/x-nmos/channelmapping/v1.0/map/activations", body));
        assert_eq!(status, 200);
    }

    #[test]
    fn get_io_view_matches_schema_shape() {
        let cm = gateway_fixture();
        let (status, body) = body_str(cm.handle("GET", "/x-nmos/channelmapping/v1.0/io", b""));
        assert_eq!(status, 200);
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["inputs"]["aes67-in"]["channels"][0]["label"], "Channel 1");
        assert_eq!(parsed["outputs"]["mxl-out"]["source_id"], "11111111-1111-1111-8111-111111111111");
        assert_eq!(parsed["outputs"]["mxl-out"]["caps"]["routable_inputs"][0], "aes67-in");
        assert!(parsed["outputs"]["mxl-out"]["caps"]["routable_inputs"][1].is_null());
    }

    #[test]
    fn cors_methods_only_for_activations_paths() {
        let cm = gateway_fixture();
        assert_eq!(
            cm.cors_methods("/x-nmos/channelmapping/v1.0/map/activations"),
            Some(vec!["GET", "POST"])
        );
        assert_eq!(
            cm.cors_methods("/x-nmos/channelmapping/v1.0/map/activations/1"),
            Some(vec!["GET", "DELETE"])
        );
        assert_eq!(cm.cors_methods("/x-nmos/channelmapping/v1.0/inputs/aes67-in"), None);
    }

    #[test]
    fn unknown_output_in_map_active_output_is_404() {
        let cm = gateway_fixture();
        let (status, _) =
            body_str(cm.handle("GET", "/x-nmos/channelmapping/v1.0/map/active/does-not-exist", b""));
        assert_eq!(status, 404);
    }

    #[test]
    fn no_pending_activations_ever() {
        let cm = gateway_fixture();
        let (status, body) = body_str(cm.handle("GET", "/x-nmos/channelmapping/v1.0/map/activations", b""));
        assert_eq!(status, 200);
        assert_eq!(body, "{}");

        let (status, _) =
            body_str(cm.handle("GET", "/x-nmos/channelmapping/v1.0/map/activations/1", b""));
        assert_eq!(status, 404);
        let (status, _) =
            body_str(cm.handle("DELETE", "/x-nmos/channelmapping/v1.0/map/activations/1", b""));
        assert_eq!(status, 404);
    }
}
