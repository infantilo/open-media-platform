package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// handleNodeProxy baut einen reinen HTTP-Proxy-Handler für einen
// Node-eigenen Self-Describe-Pfad (descriptor.json, params/<name>,
// methods/<name>). pathTemplate darf den Platzhalter "{name}" enthalten,
// der durch den gleichnamigen Pfadparameter der eingehenden Anfrage
// ersetzt wird. Der Orchestrator kennt dabei nur Standard-IS-04-Adressen
// (NodeLister.Get liefert die API-Basis-URL aus dem Node-Resource) —
// keine Node-Typ-Kenntnis (UMSETZUNG.md A8, ARCHITECTURE.md §2/§11.1).
// client ist der (ggf. mTLS-fähige, UMSETZUNG.md D3) HTTP-Client für
// Node-Aufrufe — nil bedeutet http.DefaultClient (unverändertes
// Verhalten ohne mTLS).
func handleNodeProxy(nodes NodeLister, client *http.Client, pathTemplate string) http.HandlerFunc {
	if client == nil {
		client = http.DefaultClient
	}
	return func(w http.ResponseWriter, r *http.Request) {
		node, ok := nodes.Get(r.PathValue("id"))
		if !ok {
			http.Error(w, "unknown node", http.StatusNotFound)
			return
		}
		if node.APIBaseURL == "" {
			http.Error(w, "node has no reachable api endpoint", http.StatusBadGateway)
			return
		}

		path := pathTemplate
		if name := r.PathValue("name"); name != "" {
			path = strings.ReplaceAll(path, "{name}", name)
		}

		target := node.APIBaseURL + path
		// Query-String durchreichen (C20, ARCHITECTURE.md §24.5): der
		// erste Konsument ist omp-playout-automations gefensterte
		// Timeline-Anfrage (`GET .../timeline/window?fromIndex=&count=`,
		// ein extra_route mit Zahlen-Argumenten — weder ein Parameter
		// noch eine Methode passt dafür, s. dortige Doku). Bisherige
		// Routen (params/methods/plugins/ui/descriptor) schicken nie
		// eine Query, dieses Anhängen ändert für sie nichts.
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}

		req, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
		if err != nil {
			http.Error(w, "failed to build proxy request", http.StatusInternalServerError)
			return
		}
		if ct := r.Header.Get("Content-Type"); ct != "" {
			req.Header.Set("Content-Type", ct)
		}

		resp, err := client.Do(req)
		if err != nil {
			http.Error(w, "node unreachable: "+err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		if ct := resp.Header.Get("Content-Type"); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}
}

// handleNodeStreamProxy liefert `GET /api/v1/nodes/<id>/stream/<name>`
// (K4, `docs/END-GOAL-FEATURES.md` Kapitel 10 Entscheidungssitzung Punkt
// 5: "Generischer Node-Stream-Proxy im Orchestrator wird gebaut — löst
// Audio-Pegel UND die bekannte MJPEG-Vorschau-Problematik (C12) in
// einem Aufwasch"). Zwei bereits bestehende Node-Funktionen
// (`omp-viewer`/`omp-multiviewer`s MJPEG-Vorschau, `preview.rs`;
// `omp-audio-mixer`s SSE-Metering, `levels.rs`) laufen aus GStreamer-/
// Threading-Gründen (dauerhaft offene Antwort würde `omp-node-sdk::
// server`s Single-Thread-Accept-Loop für alle anderen Endpunkte dieses
// Nodes blockieren, s. dortige Doku) auf einem **eigenen, zweiten**
// `tiny_http`-Port pro Node, dessen tatsächliche Adresse nur über einen
// Parameter (`previewUrl`/`levelsUrl`) bekannt ist. Bisher griff die UI
// (`ui/graph/flow-canvas.ts`, node-eigene `ui/bundle.js`) nach dem
// Auflösen dieses Parameters **direkt** auf die zurückgelieferte
// Node-URL zu — zwei reale Probleme: (1) das umgeht komplett die
// Orchestrator-eigene Auth (JWT/Rollenbindungen, D3 Teil 2), jeder mit
// Netzwerksicht auf den Node-Port sieht die Vorschau/Pegel ohne jede
// Anmeldung; (2) der Browser braucht direkte Netzwerk-Erreichbarkeit zu
// JEDEM Node-Host, nicht nur zum Orchestrator — bricht in jedem
// Mehr-Host-Aufbau (§18), in dem der Operator nur den Orchestrator
// direkt erreicht.
//
// Dieser Handler löst beides: er holt selbst zuerst `name`s Parameterwert
// vom Node (zweiter, kurzlebiger Request auf dessen regulären API-Port,
// identisch zu `handleNodeProxy`s Params-Pfad), behandelt ihn als URL
// und öffnet DANACH einen zweiten, diesmal dauerhaften Request dorthin,
// dessen Antwort er Byte für Byte an den Aufrufer durchreicht — der
// Browser sieht nach außen nur noch die Orchestrator-URL (authentifiziert
// wie jeder andere `/api/v1`-Endpunkt), kennt nie den tatsächlichen
// Node-Host/-Port des zweiten Ports. `name` ist bewusst generisch (nicht
// hart auf "previewUrl"/"levelsUrl" verdrahtet) — jeder künftige
// Node-Typ mit einem eigenen dauerhaften Stream kann denselben Pfad
// nutzen, solange er seine URL unter irgendeinem Parameter exportiert.
func handleNodeStreamProxy(nodes NodeLister, client *http.Client) http.HandlerFunc {
	if client == nil {
		client = http.DefaultClient
	}
	return func(w http.ResponseWriter, r *http.Request) {
		node, ok := nodes.Get(r.PathValue("id"))
		if !ok {
			http.Error(w, "unknown node", http.StatusNotFound)
			return
		}
		if node.APIBaseURL == "" {
			http.Error(w, "node has no reachable api endpoint", http.StatusBadGateway)
			return
		}
		name := r.PathValue("name")

		paramReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, node.APIBaseURL+"/params/"+name, nil)
		if err != nil {
			http.Error(w, "failed to build param request", http.StatusInternalServerError)
			return
		}
		paramResp, err := client.Do(paramReq)
		if err != nil {
			http.Error(w, "node unreachable: "+err.Error(), http.StatusBadGateway)
			return
		}
		var parsed struct {
			Value string `json:"value"`
		}
		decodeErr := json.NewDecoder(paramResp.Body).Decode(&parsed)
		paramResp.Body.Close()
		if paramResp.StatusCode != http.StatusOK {
			http.Error(w, "unknown stream", http.StatusNotFound)
			return
		}
		if decodeErr != nil || parsed.Value == "" {
			http.Error(w, "stream not available", http.StatusNotFound)
			return
		}

		streamReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, parsed.Value, nil)
		if err != nil {
			http.Error(w, "failed to build stream request", http.StatusInternalServerError)
			return
		}
		streamResp, err := client.Do(streamReq)
		if err != nil {
			http.Error(w, "stream unreachable: "+err.Error(), http.StatusBadGateway)
			return
		}
		defer streamResp.Body.Close()

		if ct := streamResp.Header.Get("Content-Type"); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(streamResp.StatusCode)

		// Sofort flushen statt implizit auf den ersten Read()-Erfolg
		// unten zu warten — live gefunden: ein frisch verbundener Stream
		// ohne bereits fließende Daten (z. B. `preview.rs` ohne bislang
		// publiziertes Frame) blockiert im Read() weiter unten u. U.
		// unbegrenzt; ohne dieses Flush hier bliebe der Response-Header
		// selbst so lange im Puffer hängen, dass der Aufrufer nicht
		// einmal einen 200-Status sieht (identisches Muster/identische
		// Begründung wie `preview.rs::serve_client`s eigenem expliziten
		// Flush nach dem Header, s. dortige Doku).
		flusher, _ := w.(http.Flusher)
		if flusher != nil {
			flusher.Flush()
		}

		buf := make([]byte, 32*1024)
		for {
			n, readErr := streamResp.Body.Read(buf)
			if n > 0 {
				if _, writeErr := w.Write(buf[:n]); writeErr != nil {
					return
				}
				if flusher != nil {
					flusher.Flush()
				}
			}
			if readErr != nil {
				return
			}
		}
	}
}
