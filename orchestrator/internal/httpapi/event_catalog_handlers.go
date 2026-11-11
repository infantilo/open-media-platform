package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/alertsink"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/events"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/process"
)

var alarmFields = []events.Field{
	{Path: "kind", Label: "Alarmart"}, {Path: "severity", Label: "Schweregrad"}, {Path: "subject", Label: "Gegenstand (Node-/Host-ID)"},
	{Path: "name", Label: "Name"}, {Path: "message", Label: "Meldung"}, {Path: "action", Label: "Aktion"}, {Path: "time", Label: "Zeit"},
}

// handleEventCatalog liefert alle als Auslöser wählbaren Ereignisse: angemeldete Arten, jede aktuell angemeldete Alarmart
// (omp.alarm.<Art>, dynamisch — auch künftige) und auf dem Bus beobachtete Subjects.
func handleEventCatalog() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		out := []events.Info{}
		for _, k := range alertsink.ListKinds() {
			out = append(out, events.Info{ID: "alarm." + k.Kind, Subject: "omp.alarm." + k.Kind, Group: "alarm", Label: k.Label, LabelEN: k.LabelEN, Fields: alarmFields})
		}
		out = append(out, events.Info{ID: "alarm.any", Subject: "omp.alarm.*", Group: "alarm", Label: "Beliebiger Alarm", Fields: alarmFields})
		for i := range out {
			out[i].Sample, out[i].Count, out[i].LastSeen = events.SampleFor(out[i].Subject)
		}
		for _, e := range events.List() {
			if e.Observed && strings.HasPrefix(e.Subject, "omp.alarm.") {
				continue // Alarme stehen schon mit Name und Art in der Liste
			}
			out = append(out, e)
		}
		// Felder: angemeldete plus aus dem letzten Beispiel abgeleitete (verschachtelte Pfade), ohne Doppelte.
		for i := range out {
			have := map[string]bool{}
			for _, f := range out[i].Fields {
				have[f.Path] = true
			}
			for _, f := range events.FlattenFields(out[i].Sample) {
				if !have[f.Path] {
					out[i].Fields = append(out[i].Fields, f)
				}
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"events": out})
	}
}

// handleTestTriggerFilter wertet einen Auslöser-Filter gegen eine Beispiel-Nutzlast aus (Vorab-Test im Dialog).
func handleTestTriggerFilter() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Filter  string          `json:"filter"`
			Subject string          `json:"subject"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ungültiges JSON"})
			return
		}
		var payload any
		if len(in.Payload) > 0 && json.Unmarshal(in.Payload, &payload) != nil {
			payload = string(in.Payload)
		}
		ev, _ := process.NewEvaluator()
		ok, err := ev.EvalBool(in.Filter, map[string]any{"input": payload, "subject": in.Subject})
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": ok})
	}
}
