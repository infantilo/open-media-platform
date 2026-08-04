//! Reverse-Proxy von PIPELINE CONTROLLERs eigenem Web-UI (`ui.html` +
//! dessen REST-API) auf den vom Launcher publizierten Container-Port.
//!
//! Der Podman-Runner veröffentlicht pro Container genau einen Port
//! (`OMP_PORT`, `orchestrator/internal/launcher/podman.go`) — PIPELINE
//! CONTROLLERs eigener interner Port (3000) ist von außen sonst nicht
//! erreichbar. Alles, was nicht der OMP-Node-Contract selbst ist
//! (Descriptor/Params/Methods/IS-05-Connection/`/ui/*`), wird hier
//! transparent durchgereicht.
//!
//! Bekannte Einschränkung: `RawResponse` ist keine Streaming-Antwort —
//! PIPELINE CONTROLLERs SSE-Kanal (`/events`) funktioniert durch diesen
//! Proxy nicht (die eingebettete Oberfläche bleibt bedienbar, nur
//! Live-Push-Updates fehlen, manueller Reload nötig).
//!
//! **Live gefundener, echter Deadlock (nicht nur "funktioniert nicht",
//! sondern legt den GANZEN Adapter lahm):** `ui.html` öffnet beim Laden
//! unbedingt `new EventSource('/events')` — dieser Request läuft durch
//! `proxy()` wie jeder andere. `resp.body_mut().read_to_vec()` liest bis
//! EOF; ein `text/event-stream`-Body endet nie. `main.rs` startet den
//! Adapter mit `#[tokio::main(flavor = "current_thread")]` (EIN einziger
//! Runtime-Thread) — dieser eine blockierende Lesevorgang, der niemals
//! zurückkehrt, blockiert damit den GESAMTEN Adapter, nicht nur die
//! `/events`-Anfrage: jede andere Route (inkl. `/healthz`,
//! `/descriptor.json`, PIPELINE CONTROLLERs eigenes `/api/*` durch
//! denselben Proxy) hängt ab diesem Zeitpunkt ebenfalls für immer. Live
//! reproduziert: nach dem ersten Laden der eingebetteten Oberfläche
//! antwortete der Adapter-Port auf gar nichts mehr, während PIPELINE
//! CONTROLLERs eigener interner Port (3000, per `podman exec` direkt
//! geprüft) weiterhin normal antwortete — der Adapter war blockiert,
//! nicht PIPELINE CONTROLLER selbst. Fix unten: `Content-Type:
//! text/event-stream` wird VOR dem Body-Lesen erkannt und die Anfrage
//! ohne Body-Read mit einem synthetischen Fehler beantwortet — der
//! Adapter bleibt reaktionsfähig, `EventSource` fällt (wie vom Browser
//! bei jedem `error`-Event vorgesehen) auf automatisches Neuverbinden
//! zurück statt der ganzen App den Rest zu geben. Zusätzlich ein
//! globales `timeout_recv_body` als zweite Absicherung gegen JEDE
//! andere, aus anderem Grund hängende Backend-Antwort (z. B. ein PC-
//! Handler, der selbst nie antwortet) — echtes SSE-Proxying/Streaming
//! bleibt dokumentierte Folgearbeit, kein Blocker für diese Runde.

use omp_node_sdk::RawResponse;
use std::time::Duration;
use ureq::Agent;
use ureq::http::Request;

/// s. Moduldoku zum `read_to_vec()`-Deadlock — zweite Absicherung neben
/// dem gezielten `text/event-stream`-Kurzschluss unten, falls ein
/// Backend-Handler aus einem anderen Grund nie fertig antwortet.
const PROXY_BODY_TIMEOUT: Duration = Duration::from_secs(10);

/// `http_status_as_error(false)`: jede Antwort (auch 4xx/5xx) soll
/// unverändert an den Browser durchgereicht werden statt hier als
/// `ureq::Error` behandelt zu werden.
pub fn make_agent() -> Agent {
    let config = Agent::config_builder()
        .http_status_as_error(false)
        .timeout_recv_body(Some(PROXY_BODY_TIMEOUT))
        .build();
    Agent::new_with_config(config)
}

pub fn proxy(agent: &Agent, pc_base: &str, method: &str, path: &str, body: &[u8]) -> RawResponse {
    let uri = format!("{pc_base}{path}");
    let request = Request::builder()
        .method(method)
        .uri(&uri)
        .header("content-type", "application/json")
        .body(body.to_vec());

    let request = match request {
        Ok(r) => r,
        Err(e) => {
            return RawResponse {
                status: 502,
                content_type: "text/plain",
                body: format!("omp-pipeline-controller: invalid proxy request to {uri}: {e}").into_bytes(),
            };
        }
    };

    match agent.run(request) {
        Ok(mut resp) => {
            let status = resp.status().as_u16();
            let content_type = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            // s. Moduldoku: ein `text/event-stream`-Body endet nie —
            // `read_to_vec()` darauf würde den einzigen Runtime-Thread des
            // Adapters für immer blockieren. Body-Read hier bewusst
            // übersprungen, bevor er überhaupt beginnt.
            if content_type.starts_with("text/event-stream") {
                return RawResponse {
                    status: 501,
                    content_type: "text/plain",
                    body: b"omp-pipeline-controller: SSE-Streaming wird durch diesen Proxy nicht unterstuetzt (kein Live-Push, Seite bei Bedarf manuell neu laden)".to_vec(),
                };
            }
            let body = resp.body_mut().read_to_vec().unwrap_or_default();
            // Content-Type ist zur Laufzeit von PIPELINE CONTROLLER bestimmt
            // (statisches HTML/JS/CSS + dynamische JSON-Antworten) —
            // RawResponse verlangt aber `&'static str`. Bewusster, pro
            // Proxy-Antwort begrenzter Leak (Kontrollpanel-Traffic, kein
            // Datenpfad) statt einer unvollständigen Content-Type-Tabelle,
            // die z. B. Bilder aus PIPELINE CONTROLLERs UI falsch ausliefern
            // würde.
            let content_type: &'static str = Box::leak(content_type.into_boxed_str());
            RawResponse { status, content_type, body }
        }
        Err(e) => RawResponse {
            status: 502,
            content_type: "text/plain",
            body: format!("omp-pipeline-controller: proxy to {uri} failed: {e}").into_bytes(),
        },
    }
}
