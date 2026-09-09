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
//! Seit `UMSETZUNG.md` D9 zusätzlich die Basis-Discovery-Subresourcen
//! (Wurzel-Listing pro Resource, `constraints/`, `transporttype/`) —
//! ohne die brach AMWA IS-05-01 vor D9 mit 0 ausgeführten Tests ab
//! (docs/decisions.md 2026-07-13). Kein `/x-nmos/connection/v1.1/`-
//! Wurzel-/`single/`-Listing hier (das ist node-global, nicht pro
//! Sender/Receiver — jeder Node verdrahtet das selbst über
//! `ParamStore::extra_route`, ein Beispiel folgt in `nodes/mock`-Pendant-
//! Form für den ersten Node, der D9 tatsächlich nutzt).
//!
//! Kennt kein HTTP — der Node verdrahtet die Pfade selbst über
//! `ParamStore::extra_route` (`server::RawResponse`), damit dieses Modul
//! transportunabhängig bleibt.
//!
//! Bedient seit Nachtrag 189 sowohl `/x-nmos/connection/v1.1/` als auch
//! `/x-nmos/connection/v1.2/` (s. [`API_VERSIONS`]) — v1.2.0 ist
//! wire-kompatibel zu v1.1.x, daher dieselben Handler für beide
//! Versionspfade statt einer zweiten Implementierung.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::is04::TRANSPORT_MXL;

/// Baut die IS-05-`constraints/`-Antwort für genau ein Leg (kein Node
/// dieses Projekts kennt 2022-7-Redundanz) — Feldnamen exakt aus dem
/// AMWA-Beispiel `receiver-constraints-get-200.json` (RTP-Leg), gilt
/// gleichermaßen für Sender (`sender-constraints-get-200.json` hat
/// dieselben Feldnamen). Alle Werte `{}` (= unconstrained), da kein
/// OMP-Node `transport_params` tatsächlich einschränkt.
fn unconstrained_rtp_leg() -> Value {
    serde_json::json!({
        "source_ip": {},
        "multicast_ip": {},
        "interface_ip": {},
        "destination_port": {},
        "fec_enabled": {},
        "fec_destination_ip": {},
        "fec_mode": {},
        "fec1D_destination_port": {},
        "fec2D_destination_port": {},
        "rtcp_enabled": {},
        "rtcp_destination_ip": {},
        "rtcp_destination_port": {},
        "rtp_enabled": {},
    })
}

fn constraints_response() -> Vec<u8> {
    serde_json::to_vec(&vec![unconstrained_rtp_leg()]).unwrap_or_default()
}

fn transport_type_response(transport_urn: &str) -> Vec<u8> {
    serde_json::to_vec(transport_urn).unwrap_or_default()
}

/// IS-05-Connection-API-Versionen, die [`SenderConnection`] und
/// [`ReceiverConnection`] parallel bedienen (Nachtrag 189, Go-Pendant:
/// `nodes/mock/internal/connection::apiVersions`). v1.2.0 ist
/// wire-kompatibel zu v1.1.x (einzige inhaltliche Änderung: weitere
/// Transport-Typen ab v1.2 über das NMOS-"Transports"-Parameter-Register
/// statt fest in der Spec definiert) — deshalb dieselben Handler für
/// beide Versionspfade statt einer zweiten Implementierung.
const API_VERSIONS: [&str; 2] = ["v1.1", "v1.2"];

/// Schneidet `/x-nmos/connection/{version}/single/{kind}/{id}/` von `path`
/// ab, sofern `path` mit einer der [`API_VERSIONS`] beginnt — sonst
/// `None`. Ein abschließendes "/" im Rest wird zusätzlich entfernt (s.
/// [`SenderConnection::handle`]-Doc zum Trailing-Slash-Normalisieren).
fn strip_versioned_prefix<'a>(path: &'a str, kind: &str, id: &str) -> Option<&'a str> {
    for version in API_VERSIONS {
        let prefix = format!("/x-nmos/connection/{version}/single/{kind}/{id}/");
        if let Some(sub) = path.strip_prefix(&prefix) {
            return Some(sub.strip_suffix('/').unwrap_or(sub));
        }
    }
    None
}

/// Bedient die node-globalen Wurzel-Discovery-Pfade der IS-05-
/// Connection-API: `/x-nmos/connection/` (Versionsliste) sowie je
/// [`API_VERSIONS`]-Eintrag `.../v1.x/` (`["single/"]`) und
/// `.../v1.x/single/` (`["senders/","receivers/"]`, immer beide,
/// unabhängig davon ob dieser Node tatsächlich Sender+Receiver hat —
/// dieselbe RAML-Vorgabe, der auch das Go-Pendant folgt,
/// `nodes/mock/internal/connection/handler.go`). Anders als die
/// Sub-Ressourcen pro Sender/Receiver ([`SenderConnection::handle`]/
/// [`ReceiverConnection::handle`]) ist das node-global, nicht pro
/// Instanz, daher eine freie Funktion statt einer Methode — jeder Node
/// mit echten IS-05-Connections ruft sie zusätzlich in seinem
/// `extra_route` auf (Nachtrag 190: vorher fehlte dieser Pfad für ALLE
/// Rust-Nodes komplett, nicht erst seit v1.2 — der Go-Mock-Node hatte
/// nur die versionierten Wurzeln, nicht den nackten `/x-nmos/connection/`
/// selbst, s. docs/decisions.md).
pub fn root_discovery(method: &str, path: &str) -> Option<(u16, &'static str, Vec<u8>)> {
    if method != "GET" {
        return None;
    }
    if path == "/x-nmos/connection/" {
        return Some((200, "application/json", br#"["v1.1/","v1.2/"]"#.to_vec()));
    }
    for version in API_VERSIONS {
        if path == format!("/x-nmos/connection/{version}/") {
            return Some((200, "application/json", br#"["single/"]"#.to_vec()));
        }
        if path == format!("/x-nmos/connection/{version}/single/") {
            return Some((
                200,
                "application/json",
                br#"["senders/","receivers/"]"#.to_vec(),
            ));
        }
    }
    None
}

/// Bedient `GET /x-nmos/connection/{version}/single/{kind}/` — die
/// ID-Auflistung, die die RAML (`ConnectionAPI.raml`) getrennt vom
/// `single/`-Wurzel-Listing ([`root_discovery`]) vorsieht (Nachtrag 192:
/// vorher hatte KEIN Rust-Node das, nur der Go-Mock-Node
/// `nodes/mock/internal/connection/handler.go`). Node-global wie
/// [`root_discovery`], aber braucht die tatsächlichen IDs — deshalb eine
/// eigene Funktion statt Teil davon, jeder Node reicht seine eigene(n)
/// ID(s) durch (meist eine, bei Video+Audio-Receiver-Paaren wie
/// `omp-recorder`/`omp-decklink`/`omp-pipeline-controller` zwei). Ein
/// leeres `ids` (z. B. `playout` ohne konfigurierten Sender) liefert
/// korrekt `[]`, nicht 404 — derselbe Node hat den Pfad ja, nur (noch)
/// keine Ressource darunter.
pub fn list_ids(
    method: &str,
    path: &str,
    kind: &str,
    ids: &[&str],
) -> Option<(u16, &'static str, Vec<u8>)> {
    if method != "GET" {
        return None;
    }
    for version in API_VERSIONS {
        if path == format!("/x-nmos/connection/{version}/single/{kind}/") {
            let listing: Vec<String> = ids.iter().map(|id| format!("{id}/")).collect();
            return Some((
                200,
                "application/json",
                serde_json::to_vec(&listing).unwrap_or_default(),
            ));
        }
    }
    None
}

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
    /// `transporttype/`-Antwort — Default MXL (die meisten Sender dieses
    /// Projekts sind Zero-Copy-MXL-Sender), per [`Self::with_transport`]
    /// überschreibbar für die wenigen echten RTP-Sender (z. B. `playout`,
    /// `UMSETZUNG.md` C3).
    transport_urn: &'static str,
}

impl<C: SenderControl, S: SenderSdp> SenderConnection<C, S> {
    pub fn new(sender_id: impl Into<String>, control: C, sdp: S) -> Self {
        SenderConnection {
            sender_id: sender_id.into(),
            control,
            sdp,
            state: Mutex::new(SenderResource::default()),
            transport_urn: TRANSPORT_MXL,
        }
    }

    /// Die Sender-ID — für `single/senders/`-Listing (Nachtrag 192,
    /// [`list_ids`]), das node-global ist und deshalb nicht selbst auf
    /// `sender_id` zugreifen kann.
    pub fn id(&self) -> &str {
        &self.sender_id
    }

    /// Überschreibt die `transporttype/`-Antwort (Default: MXL, s.
    /// [`Self::transport_urn`]-Doc) — für Sender, deren tatsächlicher
    /// Transport nicht MXL ist (z. B. `is04::TRANSPORT_RTP`). Prüft gegen
    /// [`crate::transports::TRANSPORTS`] (Nachtrag 190) — ein Tippfehler
    /// hier fällt so beim Node-Start auf, nicht erst beim nächsten
    /// AMWA-Testlauf.
    pub fn with_transport(mut self, transport_urn: &'static str) -> Self {
        assert!(
            crate::transports::is_known_transport(transport_urn),
            "unbekannter Transport-Typ: {transport_urn}"
        );
        self.transport_urn = transport_urn;
        self
    }

    /// Bearbeitet eine Anfrage, falls `path` zu diesem Sender gehört —
    /// `None`, wenn `path` keinen der Endpunkte dieses Senders trifft
    /// (Aufrufer versucht dann andere Routen/liefert 404).
    pub fn handle(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> Option<(u16, &'static str, Vec<u8>)> {
        // Leaf-Ressourcen (staged/active/constraints/transporttype/
        // transportfile) sind sowohl mit als auch ohne abschließendes "/"
        // erreichbar — das AMWA-IS-05-01-Testing-Tool ruft beide Formen ab
        // (am echten Tool-Lauf beobachtet, `UMSETZUNG.md` D9). Ohne dieses
        // Normalisieren würde ein trailing "/" hier nicht matchen und
        // stattdessen `None` liefern (Aufrufer würde dann fälschlich 404
        // liefern) — anders als beim Go-Pendant (`nodes/mock`, dessen
        // `net/http`-Mux ein "/"-Teilbaummuster hätte, das denselben Fehler
        // aber in die andere Richtung machte: falscher Treffer statt keinem,
        // dort separat gefixt, docs/decisions.md D9). Prüft seit Nachtrag
        // 189 alle `API_VERSIONS`, nicht mehr nur v1.1.
        let sub = strip_versioned_prefix(path, "senders", &self.sender_id)?;

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
            ("GET", "") => Some((
                200,
                "application/json",
                br#"["constraints/","staged/","active/","transportfile/","transporttype/"]"#
                    .to_vec(),
            )),
            ("GET", "constraints") => Some((200, "application/json", constraints_response())),
            ("GET", "transporttype") => Some((
                200,
                "application/json",
                transport_type_response(self.transport_urn),
            )),
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

/// `transport_file` eines Receivers (`receiver-response-schema.json`) —
/// OMP-Nodes routen keine echten Transport-Files, daher immer `null`/`null`
/// (gleiche Vereinfachung wie im Go-Pendant, `nodes/mock/internal/
/// connection/receiver.go`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ReceiverTransportFile {
    pub data: Option<String>,
    #[serde(rename = "type")]
    pub media_type: Option<String>,
}

/// `staged`/`active`-Repräsentation eines Receivers
/// (`receiver-stage-schema.json`). Wie bei [`SenderResource`] keine
/// getrennte staged/active-Zustandsführung (`UMSETZUNG.md` C6) — der
/// Flow-Editor (B3) PATCHt ohnehin immer mit
/// `activation.mode=activate_immediate` (`orchestrator/internal/is05/
/// client.go`), eine Staging-Zwischenstufe hätte keinen Aufrufer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiverResource {
    pub sender_id: Option<String>,
    pub master_enable: bool,
    pub activation: Activation,
    pub transport_file: ReceiverTransportFile,
    pub transport_params: Vec<Value>,
}

impl Default for ReceiverResource {
    fn default() -> Self {
        ReceiverResource {
            sender_id: None,
            master_enable: false,
            activation: Activation::default(),
            transport_file: ReceiverTransportFile::default(),
            transport_params: vec![Value::Object(serde_json::Map::new())],
        }
    }
}

/// Reagiert auf Zustandsänderungen einer IS-05-Receiver-Connection (z. B.
/// `omp-viewer`s Quellwahl, `UMSETZUNG.md` C6: `sender_id` auflösen und die
/// Pipeline neu aufbauen). Node-spezifisch, eine Implementierung pro
/// Receiver.
pub trait ReceiverControl: Send + Sync + 'static {
    fn apply(&self, resource: &ReceiverResource);
}

/// Rust-Pendant zu `nodes/mock/internal/connection.ReceiverStore`+`Handler`
/// (Go) für genau einen Receiver pro Instanz — analog zu
/// [`SenderConnection`], aber ohne SDP-Endpoint (Receiver haben keinen
/// `/transportfile`).
pub struct ReceiverConnection<C> {
    receiver_id: String,
    control: C,
    state: Mutex<ReceiverResource>,
    /// s. `SenderConnection::transport_urn`-Doc — identisches Default/
    /// Override-Muster.
    transport_urn: &'static str,
}

impl<C: ReceiverControl> ReceiverConnection<C> {
    pub fn new(receiver_id: impl Into<String>, control: C) -> Self {
        ReceiverConnection {
            receiver_id: receiver_id.into(),
            control,
            state: Mutex::new(ReceiverResource::default()),
            transport_urn: TRANSPORT_MXL,
        }
    }

    /// Die Receiver-ID — für `single/receivers/`-Listing (Nachtrag 192,
    /// [`list_ids`]), das node-global ist und deshalb nicht selbst auf
    /// `receiver_id` zugreifen kann.
    pub fn id(&self) -> &str {
        &self.receiver_id
    }

    /// s. [`SenderConnection::with_transport`].
    pub fn with_transport(mut self, transport_urn: &'static str) -> Self {
        assert!(
            crate::transports::is_known_transport(transport_urn),
            "unbekannter Transport-Typ: {transport_urn}"
        );
        self.transport_urn = transport_urn;
        self
    }

    /// Bearbeitet eine Anfrage, falls `path` zu diesem Receiver gehört —
    /// `None`, wenn `path` keinen der Endpunkte dieses Receivers trifft.
    pub fn handle(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> Option<(u16, &'static str, Vec<u8>)> {
        // Leaf-Ressourcen (staged/active/constraints/transporttype/
        // transportfile) sind sowohl mit als auch ohne abschließendes "/"
        // erreichbar — das AMWA-IS-05-01-Testing-Tool ruft beide Formen ab
        // (am echten Tool-Lauf beobachtet, `UMSETZUNG.md` D9). Ohne dieses
        // Normalisieren würde ein trailing "/" hier nicht matchen und
        // stattdessen `None` liefern (Aufrufer würde dann fälschlich 404
        // liefern) — anders als beim Go-Pendant (`nodes/mock`, dessen
        // `net/http`-Mux ein "/"-Teilbaummuster hätte, das denselben Fehler
        // aber in die andere Richtung machte: falscher Treffer statt keinem,
        // dort separat gefixt, docs/decisions.md D9). Prüft seit Nachtrag
        // 189 alle `API_VERSIONS`, nicht mehr nur v1.1.
        let sub = strip_versioned_prefix(path, "receivers", &self.receiver_id)?;

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
            ("GET", "") => Some((
                200,
                "application/json",
                br#"["constraints/","staged/","active/","transporttype/"]"#.to_vec(),
            )),
            ("GET", "constraints") => Some((200, "application/json", constraints_response())),
            ("GET", "transporttype") => Some((
                200,
                "application/json",
                transport_type_response(self.transport_urn),
            )),
            _ => None,
        }
    }

    fn patch_staged(&self, body: &[u8]) -> (u16, &'static str, Vec<u8>) {
        let Ok(patch) = serde_json::from_slice::<Value>(body) else {
            return (400, "text/plain", b"invalid JSON body".to_vec());
        };

        let mut state = self.state.lock().expect("lock poisoned");
        if let Some(v) = patch.get("sender_id")
            && let Ok(sender_id) = serde_json::from_value(v.clone())
        {
            state.sender_id = sender_id;
        }
        if let Some(v) = patch.get("master_enable").and_then(Value::as_bool) {
            state.master_enable = v;
        }
        if let Some(activation) = patch.get("activation")
            && let Ok(activation) = serde_json::from_value(activation.clone())
        {
            state.activation = activation;
        }

        self.control.apply(&state);
        (
            200,
            "application/json",
            serde_json::to_vec(&*state).unwrap_or_default(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::is04::TRANSPORT_RTP;

    struct NoopSenderControl;
    impl SenderControl for NoopSenderControl {
        fn apply(&self, _resource: &SenderResource) {}
    }

    struct NoopSenderSdp;
    impl SenderSdp for NoopSenderSdp {
        fn sdp(&self, _resource: &SenderResource) -> String {
            String::new()
        }
    }

    struct NoopReceiverControl;
    impl ReceiverControl for NoopReceiverControl {
        fn apply(&self, _resource: &ReceiverResource) {}
    }

    fn body_str(resp: Option<(u16, &'static str, Vec<u8>)>) -> (u16, String) {
        let (status, _content_type, body) = resp.expect("route matched");
        (status, String::from_utf8(body).expect("valid utf-8"))
    }

    /// D9: Basis-Discovery-Pfade, an denen AMWA IS-05-01 vorher mit 0
    /// ausgeführten Tests abbrach (docs/decisions.md 2026-07-13).
    #[test]
    fn sender_base_discovery_routes() {
        let conn = SenderConnection::new("sender-1", NoopSenderControl, NoopSenderSdp)
            .with_transport(TRANSPORT_RTP);

        let (status, body) =
            body_str(conn.handle("GET", "/x-nmos/connection/v1.1/single/senders/sender-1/", b""));
        assert_eq!(status, 200);
        assert_eq!(
            body,
            r#"["constraints/","staged/","active/","transportfile/","transporttype/"]"#
        );

        let (status, body) = body_str(conn.handle(
            "GET",
            "/x-nmos/connection/v1.1/single/senders/sender-1/transporttype",
            b"",
        ));
        assert_eq!(status, 200);
        assert_eq!(body, r#""urn:x-nmos:transport:rtp""#);

        let (status, body) = body_str(conn.handle(
            "GET",
            "/x-nmos/connection/v1.1/single/senders/sender-1/constraints",
            b"",
        ));
        assert_eq!(status, 200);
        let parsed: Vec<Value> = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].get("rtp_enabled").is_some());
    }

    #[test]
    fn sender_default_transport_is_mxl() {
        let conn = SenderConnection::new("sender-1", NoopSenderControl, NoopSenderSdp);
        let (_, body) = body_str(conn.handle(
            "GET",
            "/x-nmos/connection/v1.1/single/senders/sender-1/transporttype",
            b"",
        ));
        assert_eq!(body, r#""urn:x-omp:transport:mxl""#);
    }

    #[test]
    fn receiver_base_discovery_routes() {
        let conn = ReceiverConnection::new("recv-1", NoopReceiverControl);

        let (status, body) = body_str(conn.handle(
            "GET",
            "/x-nmos/connection/v1.1/single/receivers/recv-1/",
            b"",
        ));
        assert_eq!(status, 200);
        assert_eq!(
            body,
            r#"["constraints/","staged/","active/","transporttype/"]"#
        );

        let (status, body) = body_str(conn.handle(
            "GET",
            "/x-nmos/connection/v1.1/single/receivers/recv-1/transporttype",
            b"",
        ));
        assert_eq!(status, 200);
        assert_eq!(body, r#""urn:x-omp:transport:mxl""#);
    }

    #[test]
    fn unknown_path_returns_none() {
        let conn = ReceiverConnection::new("recv-1", NoopReceiverControl);
        assert!(conn
            .handle(
                "GET",
                "/x-nmos/connection/v1.1/single/receivers/recv-1/bogus",
                b""
            )
            .is_none());
        assert!(conn
            .handle(
                "GET",
                "/x-nmos/connection/v1.1/single/receivers/other-id/staged",
                b""
            )
            .is_none());
    }

    /// Live am echten AMWA-IS-05-01-Tool-Lauf gefunden (`UMSETZUNG.md` D9,
    /// docs/decisions.md): `test_12_02`/`test_16` riefen `.../active/` und
    /// `.../constraints/` MIT abschließendem "/" ab und erwarteten exakt
    /// dieselbe Antwort wie ohne — vor dem Fix lieferte die Slash-Variante
    /// `None` (404 beim Aufrufer), da `strip_prefix` den Slash nicht
    /// abschnitt.
    #[test]
    fn trailing_slash_leaf_paths_match_bare_paths() {
        let conn = ReceiverConnection::new("recv-1", NoopReceiverControl);
        for leaf in ["staged", "active", "constraints", "transporttype"] {
            let bare = body_str(conn.handle(
                "GET",
                &format!("/x-nmos/connection/v1.1/single/receivers/recv-1/{leaf}"),
                b"",
            ));
            let slashed = body_str(conn.handle(
                "GET",
                &format!("/x-nmos/connection/v1.1/single/receivers/recv-1/{leaf}/"),
                b"",
            ));
            assert_eq!(bare, slashed, "leaf {leaf} differs between bare/slashed path");
        }
    }

    /// Nachtrag 189: v1.2.0 ist wire-kompatibel zu v1.1.x — derselbe
    /// Zustand muss über beide Versionspfade erreichbar sein (ein
    /// `Mutex<...>` pro Connection, kein zweiter Zustand pro Version).
    #[test]
    fn v12_serves_same_state_as_v11() {
        let conn = ReceiverConnection::new("recv-1", NoopReceiverControl);

        let patch = br#"{"sender_id":"sender-1","master_enable":true,"activation":{"mode":"activate_immediate"}}"#;
        let (status, _) = body_str(conn.handle(
            "PATCH",
            "/x-nmos/connection/v1.2/single/receivers/recv-1/staged",
            patch,
        ));
        assert_eq!(status, 200);

        let (_, v11_active) = body_str(conn.handle(
            "GET",
            "/x-nmos/connection/v1.1/single/receivers/recv-1/active",
            b"",
        ));
        let (_, v12_active) = body_str(conn.handle(
            "GET",
            "/x-nmos/connection/v1.2/single/receivers/recv-1/active",
            b"",
        ));
        assert_eq!(v11_active, v12_active);
    }

    /// Nachtrag 190: der node-globale Wurzel-Discovery-Pfad fehlte für
    /// ALLE Rust-Nodes komplett (nicht nur für v1.2) — dieser Test deckt
    /// die drei Ebenen ab, die `root_discovery` jetzt beantwortet.
    #[test]
    fn root_discovery_lists_versions_and_single() {
        let (status, body) = body_str(root_discovery("GET", "/x-nmos/connection/"));
        assert_eq!(status, 200);
        assert_eq!(body, r#"["v1.1/","v1.2/"]"#);

        for version in API_VERSIONS {
            let (status, body) =
                body_str(root_discovery("GET", &format!("/x-nmos/connection/{version}/")));
            assert_eq!(status, 200);
            assert_eq!(body, r#"["single/"]"#);

            let (status, body) = body_str(root_discovery(
                "GET",
                &format!("/x-nmos/connection/{version}/single/"),
            ));
            assert_eq!(status, 200);
            assert_eq!(body, r#"["senders/","receivers/"]"#);
        }
    }

    #[test]
    fn root_discovery_ignores_unrelated_paths() {
        assert!(root_discovery("GET", "/x-nmos/connection/v1.1/single/receivers/recv-1/staged").is_none());
        assert!(root_discovery("POST", "/x-nmos/connection/").is_none());
        assert!(root_discovery("GET", "/x-nmos/connection/v1.3/").is_none());
    }

    /// Nachtrag 192: `single/receivers/`-Listing fehlte für alle
    /// Rust-Nodes komplett — deckt eine ID (die Regel für die meisten
    /// Nodes) und zwei IDs ab (Video+Audio-Receiver-Paare wie
    /// `omp-recorder`/`omp-decklink`/`omp-pipeline-controller`).
    #[test]
    fn list_ids_lists_given_ids_per_version() {
        for version in API_VERSIONS {
            let (status, body) = body_str(list_ids(
                "GET",
                &format!("/x-nmos/connection/{version}/single/receivers/"),
                "receivers",
                &["recv-a"],
            ));
            assert_eq!(status, 200);
            assert_eq!(body, r#"["recv-a/"]"#);

            let (status, body) = body_str(list_ids(
                "GET",
                &format!("/x-nmos/connection/{version}/single/receivers/"),
                "receivers",
                &["recv-a", "recv-b"],
            ));
            assert_eq!(status, 200);
            assert_eq!(body, r#"["recv-a/","recv-b/"]"#);
        }
    }

    /// Ein Node ohne (noch) konfigurierten Sender (z. B. `playout` vor
    /// dem ersten Setup) muss `[]` liefern, nicht 404 — der Pfad existiert,
    /// nur die Ressource darunter fehlt (noch).
    #[test]
    fn list_ids_empty_ids_yields_empty_array_not_404() {
        let (status, body) = body_str(list_ids(
            "GET",
            "/x-nmos/connection/v1.1/single/senders/",
            "senders",
            &[],
        ));
        assert_eq!(status, 200);
        assert_eq!(body, "[]");
    }

    #[test]
    fn list_ids_ignores_unrelated_paths() {
        assert!(list_ids("POST", "/x-nmos/connection/v1.1/single/receivers/", "receivers", &["a"]).is_none());
        assert!(list_ids("GET", "/x-nmos/connection/v1.1/single/receivers/x/", "receivers", &["a"]).is_none());
        assert!(list_ids("GET", "/x-nmos/connection/v1.1/single/senders/", "receivers", &["a"]).is_none());
    }

    #[test]
    fn sender_and_receiver_expose_their_id() {
        let sender = SenderConnection::new("sender-42", NoopSenderControl, NoopSenderSdp);
        assert_eq!(sender.id(), "sender-42");

        let receiver = ReceiverConnection::new("recv-42", NoopReceiverControl);
        assert_eq!(receiver.id(), "recv-42");
    }
}
