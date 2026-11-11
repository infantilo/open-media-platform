package httpapi

import (
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/alertsink"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/events"
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
		out = append(out, events.List()...)
		writeJSON(w, http.StatusOK, map[string]any{"events": out})
	}
}
