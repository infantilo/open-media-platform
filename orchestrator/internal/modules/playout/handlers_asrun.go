package playout

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asrun"
)

// As-Run-Protokoll der Playout-Automation (Kapitel 27 / P10, Spec §117–119).
// Schreiben: der Automator-Node seines Channels (wie Zustand/Ausführungsjournal).
// Lesen: globales `view`. Manuelle Eingriffe (§119) hängt der Orchestrator selbst an — er kennt
// als Einziger den angemeldeten Benutzer (der Node bekommt über den Proxy keine Identität).

// AsRunStore wird von *asrun.Store implementiert.
type AsRunStore interface {
	Upsert(ctx context.Context, channelID string, recs []asrun.Record) error
	List(ctx context.Context, f asrun.Filter) ([]asrun.Record, error)
}

// operatorActions sind die Node-Methoden, die als manueller Eingriff protokolliert werden.
var operatorActions = map[string]bool{
	"take": true, "next": true, "nextLive": true, "cue": true, "stop": true, "remove": true, "load": true,
	"append": true, "appendAsset": true, "updateItem": true, "moveItem": true, "setStartType": true,
	"setTransition": true, "setChildren": true, "setAudio": true, "setMediaRef": true, "sendTrigger": true,
	"cart.fire": true, "cart.return": true, "cart.define": true, "cart.update": true, "cart.remove": true,
}

func writeAsRunError(w http.ResponseWriter, err error) {
	if errors.Is(err, asrun.ErrValidation) {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	http.Error(w, err.Error(), http.StatusInternalServerError)
}

// handlePostAsRun: POST /api/v1/playout/channels/{id}/as-run  {"records":[…]}
func handlePostAsRun(store AsRunStore, svc PlayoutService, az verbChecker, roles InstanceRoleResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch, ok := channelAccess(svc, az, roles, w, r)
		if !ok {
			return
		}
		var body struct {
			Records []asrun.Record `json:"records"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if err := store.Upsert(r.Context(), ch.ID, body.Records); err != nil {
			writeAsRunError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]int{"accepted": len(body.Records)})
	}
}

// handleGetAsRun: GET /api/v1/playout/channels/{id}/as-run?kind=&from=&to=&limit=&format=csv
func handleGetAsRun(store AsRunStore, svc PlayoutService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch, err := svc.GetChannel(r.PathValue("id"))
		if err != nil {
			writePlayoutError(w, err)
			return
		}
		q := r.URL.Query()
		f := asrun.Filter{ChannelID: ch.ID, Kind: q.Get("kind")}
		parse := func(name string, dst *time.Time) bool {
			v := q.Get(name)
			if v == "" {
				return true
			}
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				http.Error(w, name+": RFC 3339 erwartet", http.StatusBadRequest)
				return false
			}
			*dst = t
			return true
		}
		if !parse("from", &f.From) || !parse("to", &f.To) {
			return
		}
		if v := q.Get("limit"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n <= 0 {
				http.Error(w, "limit: positive Zahl erwartet", http.StatusBadRequest)
				return
			}
			f.Limit = n
		}
		recs, err := store.List(r.Context(), f)
		if err != nil {
			writeAsRunError(w, err)
			return
		}
		if q.Get("format") == "csv" {
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="as-run-`+ch.ID+`.csv"`)
			_ = asrun.WriteCSV(w, recs)
			return
		}
		writeJSON(w, http.StatusOK, recs)
	}
}

// summarizeArgs kürzt Argumente fürs Protokoll (keine großen JSON-Blöcke).
func summarizeArgs(args map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range args {
		if s, ok := v.(string); ok && len(s) > 200 {
			v = s[:200] + "…"
		}
		if strings.HasSuffix(k, "Json") {
			continue
		}
		out[k] = v
	}
	return out
}
