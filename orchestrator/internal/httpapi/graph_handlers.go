package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
)

// handleGraph liefert GET /api/v1/graph (UMSETZUNG.md B1).
func handleGraph(svc GraphService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, svc.Graph(r.Context()))
	}
}

// handlePostGraphEdge liefert POST /api/v1/graph/edges: {"from":
// "<senderId>", "to": "<receiverId>"} → IS-05-PATCH auf den Receiver.
func handlePostGraphEdge(svc GraphService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			From string `json:"from"`
			To   string `json:"to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		if err := svc.Connect(r.Context(), body.From, body.To); err != nil {
			writeGraphError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id": body.To})
	}
}

// handleDeleteGraphEdge liefert DELETE /api/v1/graph/edges/<id> (id ==
// Receiver-ID, siehe graph.Edge).
func handleDeleteGraphEdge(svc GraphService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := svc.Disconnect(r.Context(), r.PathValue("id")); err != nil {
			writeGraphError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func writeGraphError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, graph.ErrUnknownReceiver):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, graph.ErrNodeUnreachable):
		http.Error(w, err.Error(), http.StatusBadGateway)
	default:
		http.Error(w, err.Error(), http.StatusBadGateway)
	}
}
