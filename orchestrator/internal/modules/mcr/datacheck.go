package mcr

import (
	"context"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/alertsink"
)

// Überwachung der Datenspur (ANC, Zeitcode, Untertitel): Hat eine Leitung eine Datenquelle (`transport.existing.dataNodeId/dataSenderId`)
// und liefert der Normalizer keine Daten (nicht verbunden oder Quelle still), entsteht der Alarm `signal-dataLoss` — wie die
// Signalalarme der Bild- und Tonüberwachung in der Alarmliste, im globalen Alarmweg (E-Mail, Webhook, Bus) und als Auslöser der Reaktionen.
// Der Scope prüft Bild und Ton; die Datenspur läuft nicht durch ihn, deshalb prüft der MCR sie selbst am Normalizer.

const (
	// KindDataLoss: Art des Alarms (wie `signal-*`, siehe alertsink/kinds.go).
	KindDataLoss = "signal-dataLoss"
	// dataHold: so viele Abgleichläufe (je ~3 s) hintereinander ohne Daten, bis der Alarm eintritt — kurzes Stocken löst nichts aus.
	dataHold = 4
)

// dataProblem beurteilt die Parameter des Normalizers; leer = in Ordnung.
func dataProblem(p map[string]any) string {
	if id, _ := p["connectedDataFlowId"].(string); id == "" {
		return "Datenquelle ist nicht mit dem Normalizer verbunden"
	}
	if flowing, ok := p["normalize.dataFlowing"].(bool); ok && !flowing {
		return "Datenspur liefert keine Daten"
	}
	return ""
}

// dataCheckStep wertet einen Abgleichlauf einer Leitung aus: nach `dataHold` Läufen mit Problem Alarm, bei Entwarnung Ende.
func (rt *Runtime) dataCheckStep(ctx context.Context, s *Service, e Event, l Line, problem string) {
	key := e.ID + "/" + l.ID
	rt.mu.Lock()
	if rt.dataBad == nil {
		rt.dataBad = map[string]int{}
	}
	if problem != "" {
		rt.dataBad[key]++
	} else {
		delete(rt.dataBad, key)
	}
	n := rt.dataBad[key]
	rt.mu.Unlock()
	if problem != "" {
		if n < dataHold {
			return
		}
		sev := "warning"
		a, created, err := s.St.RaiseAlarm(ctx, Alarm{EventID: e.ID, LineID: l.ID, LineName: l.Name, Kind: KindDataLoss, Severity: sev, Text: l.Name + ": " + problem})
		if err != nil || !created {
			return
		}
		rt.onAlarm(ctx, s, e, a, true)
		rt.alert(e, l, alertsink.SevWarning, a.Text)
		return
	}
	a, changed, err := s.St.ClearAlarm(ctx, e.ID, l.ID, KindDataLoss)
	if err != nil || !changed {
		return
	}
	rt.onAlarm(ctx, s, e, a, false)
	rt.alert(e, l, alertsink.SevInfo, l.Name+": Datenspur liefert wieder Daten")
}

// alert meldet einen MCR-eigenen Alarm in den globalen Alarmweg (E-Mail-Regeln, Webhook, Bus-Ereignis); nil = aus.
func (rt *Runtime) alert(e Event, l Line, severity, message string) {
	if rt.Alerter == nil {
		return
	}
	a := alertsink.Alert{Kind: KindDataLoss, Severity: severity, Subject: e.ID + "/" + l.ID, Name: e.Name + " / " + l.Name, Message: message,
		MCR: &alertsink.MCRRef{EventID: e.ID, Event: e.Name, LineID: l.ID, Line: l.Name}}
	if e.WorkflowID != "" {
		a.Workflows = []alertsink.WorkflowRef{{ID: e.WorkflowID, Name: e.Name}}
	}
	rt.Alerter(a)
}

// checkData liest die Datenspur-Parameter des Normalizers jeder Leitung mit Datenquelle und wertet sie aus.
func (rt *Runtime) checkData(ctx context.Context, s *Service, e Event, wfRuntime map[string]string, roles map[string]LineRoles) {
	for _, l := range e.Lines {
		if !HasDataSource(l) || EffectiveMon(e.Monitoring, l.Monitoring).Off() {
			continue
		}
		inst := wfRuntime[roles[l.ID].Normalizer]
		if inst == "" {
			continue // Normalizer läuft (noch) nicht: nichts zu beurteilen
		}
		p, err := rt.readParams(ctx, inst, []string{"connectedDataFlowId", "normalize.dataFlowing"})
		if err != nil {
			continue
		}
		rt.dataCheckStep(ctx, s, e, l, dataProblem(p))
	}
}
