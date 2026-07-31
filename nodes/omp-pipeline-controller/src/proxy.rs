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
//! Live-Push-Updates fehlen, manueller Reload nötig) — dokumentierte
//! Folgearbeit, kein Blocker für diese Runde.

use omp_node_sdk::RawResponse;
use ureq::Agent;
use ureq::http::Request;

/// `http_status_as_error(false)`: jede Antwort (auch 4xx/5xx) soll
/// unverändert an den Browser durchgereicht werden statt hier als
/// `ureq::Error` behandelt zu werden.
pub fn make_agent() -> Agent {
    let config = Agent::config_builder().http_status_as_error(false).build();
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
