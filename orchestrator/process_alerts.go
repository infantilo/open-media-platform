package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/alertsink"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/domainaudit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/process"
)

// processAlertPublisher reicht die Ausführungs-Ereignisse der Prozess-Engine (omp.process.<Ausführung>.<Status>)
// unverändert an den Bus weiter und meldet jede endgültig fehlgeschlagene Ausführung zusätzlich als Alarm
// (Art "process-failed", kritisch; Kap. 83). Jede Ausführung läuft in genau einer Engine, daher kommt der Alarm einmal.
type processAlertPublisher struct {
	inner    process.EventPublisher
	onFailed func(executionID string)
}

func (p processAlertPublisher) Publish(subject string, payload []byte) error {
	if p.onFailed != nil && strings.HasPrefix(subject, "omp.process.") && strings.HasSuffix(subject, ".failed") {
		id := strings.TrimSuffix(strings.TrimPrefix(subject, "omp.process."), ".failed")
		go p.onFailed(id)
	}
	if p.inner == nil {
		return nil
	}
	return p.inner.Publish(subject, payload)
}

// processFailureAlerter baut den Rückruf, der aus einer fehlgeschlagenen Ausführung einen Alarm macht.
func processFailureAlerter(store *process.Store, sink *alertsink.Sink) func(executionID string) {
	return func(executionID string) {
		if sink == nil {
			return
		}
		exec, err := store.GetExecution(executionID)
		if err != nil {
			slog.Warn("alarm: fehlgeschlagene Prozess-Ausführung nicht lesbar", "execution", executionID, "error", err)
			return
		}
		a := alertsink.Alert{Kind: "process-failed", Subject: exec.ID, Name: exec.ProcessDefinitionID, Severity: alertsink.SevCritical}
		msg := "Prozess-Ausführung fehlgeschlagen"
		if exec.Error != "" {
			msg += ": " + exec.Error
		}
		a.Message = msg
		if def, err := store.GetDefinition(exec.ProcessDefinitionID); err == nil {
			a.Name = def.Name
			a.Processes = []alertsink.ProcessRef{{ID: def.ID, Name: def.Name}}
		} else {
			a.Processes = []alertsink.ProcessRef{{ID: exec.ProcessDefinitionID, Name: exec.ProcessDefinitionID}}
		}
		sink.Send(a)
	}
}

// userActionAlerter macht aus jedem Domänen-Audit-Eintrag eines Benutzers einen Alarm der Opt-in-Art „user-action“
// (Kap. 83). Ohne eine Regel, die die Art ausdrücklich nennt, passiert nichts. Vom System selbst ausgelöste Einträge
// (Akteur leer/„system“) zählen nicht. Aus den Details wird nur ein Hinweistext („note“) übernommen.
func userActionAlerter(sink *alertsink.Sink) func(domainaudit.Entry) {
	return func(e domainaudit.Entry) {
		if sink == nil || e.Actor == "" || e.Actor == "system" {
			return
		}
		action := e.ObjectType + "." + e.Action
		msg := fmt.Sprintf("%s: %s (%s)", e.Actor, action, e.ObjectID)
		var d struct {
			Note string `json:"note"`
		}
		if json.Unmarshal(e.Details, &d) == nil && d.Note != "" {
			msg += " — " + d.Note
		}
		sink.Send(alertsink.Alert{Kind: "user-action", Subject: e.ObjectID, Name: e.Actor, Action: action, Message: msg})
	}
}
