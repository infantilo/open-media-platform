package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// handleGraph liefert GET /api/v1/graph (UMSETZUNG.md B1).
func handleGraph(svc GraphService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, svc.Graph(r.Context()))
	}
}

// handlePostGraphEdge liefert POST /api/v1/graph/edges: {"from":
// "<senderId>", "to": "<receiverId>"} → IS-05-PATCH auf den Receiver.
//
// ARCHITECTURE.md §25.1 (UMSETZUNG.md D19): der Trace beginnt hier, am
// Einstiegspunkt der eigentlichen Nutzeraktion (Flow-Editor-Drag), und
// wird als Response-Header zurückgegeben — sowohl bei Erfolg als auch
// bei Fehler, ohne das bestehende Fehler-Body-Format (writeGraphError,
// reiner Text) zu ändern. Ein Admin, der einen fehlgeschlagenen
// Verbindungsversuch sieht, kann die trace_id direkt aus den
// Browser-Devtools ins Diagnose-Cockpit (§25.3, GET /api/v1/logs)
// übernehmen.
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

		ctx := tracing.FromRequest(r)
		w.Header().Set(tracing.HeaderTraceID, tracing.TraceID(ctx))
		if err := svc.Connect(ctx, body.From, body.To); err != nil {
			writeGraphError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id": body.To})
	}
}

// handleDeleteGraphEdge liefert DELETE /api/v1/graph/edges/<id> (id ==
// Receiver-ID, siehe graph.Edge). S. handlePostGraphEdge-Doku zum
// Trace-Header.
func handleDeleteGraphEdge(svc GraphService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := tracing.FromRequest(r)
		w.Header().Set(tracing.HeaderTraceID, tracing.TraceID(ctx))
		if err := svc.Disconnect(ctx, r.PathValue("id")); err != nil {
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
	case errors.Is(err, graph.ErrRoutingLoop):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, graph.ErrNodeUnreachable):
		http.Error(w, err.Error(), http.StatusBadGateway)
	default:
		http.Error(w, err.Error(), http.StatusBadGateway)
	}
}
