package httpapi

import (
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
func handleNodeProxy(nodes NodeLister, pathTemplate string) http.HandlerFunc {
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

		req, err := http.NewRequestWithContext(r.Context(), r.Method, node.APIBaseURL+path, r.Body)
		if err != nil {
			http.Error(w, "failed to build proxy request", http.StatusInternalServerError)
			return
		}
		if ct := r.Header.Get("Content-Type"); ct != "" {
			req.Header.Set("Content-Type", ct)
		}

		resp, err := http.DefaultClient.Do(req)
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
