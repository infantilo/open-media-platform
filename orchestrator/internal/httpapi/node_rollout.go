package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/instancemigrate"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// Kontrollierter Rollout einer Node-Version auf laufende Instanzen (Kapitel 28 Schritt 3):
// nacheinander (rolling), Kanten werden wiederhergestellt, bei Fehler Rollback auf den
// bisherigen Stand der Instanz und Abbruch der übrigen. Nur lokale Instanzen — Remote-Hosts
// beziehen ihre Binaries über den Host-Agent.

// InstanceRestarter startet eine eigenständige Instanz mit der produktiven Version neu
// (*instancemigrate.Service).
type InstanceRestarter interface {
	RestartInPlace(ctx context.Context, id string) (instancemigrate.RestartResult, error)
}

// rollout-Zustände je Instanz.
const (
	rolloutPending    = "pending"
	rolloutRunning    = "running"
	rolloutOK         = "ok"
	rolloutRolledBack = "rolled_back"
	rolloutFailed     = "failed"
	rolloutSkipped    = "skipped"
)

type rolloutItem struct {
	InstanceID    string `json:"instanceId"`
	Label         string `json:"label"`
	Mode          string `json:"mode"` // "standalone" | "workflow-role"
	From          string `json:"from"` // bisherige Version ("" = installiertes Binary)
	State         string `json:"state"`
	Detail        string `json:"detail,omitempty"`
	NewInstanceID string `json:"newInstanceId,omitempty"`
	workflowID    string
	role          string
}

type rolloutStatus struct {
	Name       string        `json:"name"`
	Target     string        `json:"target"` // Ziel-Version ("" = installiertes Binary)
	Running    bool          `json:"running"`
	StartedAt  time.Time     `json:"startedAt,omitempty"`
	FinishedAt *time.Time    `json:"finishedAt,omitempty"`
	Items      []rolloutItem `json:"items"`
}

// RolloutManager führt höchstens einen Rollout gleichzeitig aus.
type RolloutManager struct {
	mu   sync.Mutex
	last *rolloutStatus
	// wait/poll: für Tests verkürzbar.
	roleWait time.Duration
	poll     time.Duration
}

// NewRolloutManager erstellt den Manager.
func NewRolloutManager() *RolloutManager {
	return &RolloutManager{roleWait: 45 * time.Second, poll: 500 * time.Millisecond}
}

func (m *RolloutManager) snapshot() *rolloutStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.last == nil {
		return nil
	}
	cp := *m.last
	cp.Items = append([]rolloutItem(nil), m.last.Items...)
	return &cp
}

func (m *RolloutManager) set(fn func(*rolloutStatus)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.last != nil {
		fn(m.last)
	}
}

// plan ermittelt die betroffenen Instanzen (lokal, laufen nicht mit der Ziel-Version).
func (m *RolloutManager) plan(name string, svc LauncherService, wf WorkflowService, only map[string]bool) rolloutStatus {
	_, types := catalogBinaries(svc.Catalog())
	isType := map[string]bool{}
	for _, t := range types[name] {
		isType[t] = true
	}
	target := ""
	if p, ok := svc.(interface{ ProductiveVersion(string) string }); ok {
		target = p.ProductiveVersion(name)
	}
	type roleRef struct{ wfID, role string }
	roles := map[string]roleRef{}
	if wf != nil {
		if list, err := wf.List(); err == nil {
			for _, w := range list {
				if w.Status != workflows.StatusStarted {
					continue
				}
				for role, rt := range w.Runtime {
					roles[rt.InstanceID] = roleRef{w.ID, role}
				}
			}
		}
	}
	st := rolloutStatus{Name: name, Target: target, Items: []rolloutItem{}}
	for _, in := range instancesWithOutdated(svc) {
		if !isType[in.Type] || in.HostID != "" || in.Crashed || in.NodeVersion == target || (len(only) > 0 && !only[in.ID]) {
			continue
		}
		it := rolloutItem{InstanceID: in.ID, Label: in.Label, Mode: "standalone", From: in.NodeVersion, State: rolloutPending}
		if ref, ok := roles[in.ID]; ok {
			it.Mode, it.workflowID, it.role = "workflow-role", ref.wfID, ref.role
		}
		st.Items = append(st.Items, it)
	}
	return st
}

// run führt den Rollout nacheinander aus; bei einem Fehler werden die übrigen übersprungen.
func (m *RolloutManager) run(st rolloutStatus, svc LauncherService, wfSvc WorkflowService, restarter InstanceRestarter, audit DomainAuditLogger, actor string) {
	for i := range st.Items {
		m.set(func(s *rolloutStatus) { s.Items[i].State = rolloutRunning })
		it := st.Items[i]
		state, detail, newID := m.restartOne(it, svc, wfSvc, restarter)
		m.set(func(s *rolloutStatus) {
			s.Items[i].State, s.Items[i].Detail, s.Items[i].NewInstanceID = state, detail, newID
		})
		logDomainAudit(audit, actor, "node_version", st.Name, "rollout_item",
			map[string]any{"instance": it.InstanceID, "label": it.Label, "state": state, "detail": detail, "target": st.Target})
		if state == rolloutFailed || state == rolloutRolledBack {
			m.set(func(s *rolloutStatus) {
				for j := i + 1; j < len(s.Items); j++ {
					s.Items[j].State, s.Items[j].Detail = rolloutSkipped, "Rollout nach Fehler bei „"+it.Label+"“ abgebrochen"
				}
			})
			break
		}
	}
	now := time.Now()
	m.set(func(s *rolloutStatus) { s.Running, s.FinishedAt = false, &now })
}

func (m *RolloutManager) restartOne(it rolloutItem, svc LauncherService, wfSvc WorkflowService, restarter InstanceRestarter) (state, detail, newID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if it.Mode == "workflow-role" {
		if wfSvc == nil {
			return rolloutFailed, "Workflow-Dienst nicht verfügbar", ""
		}
		if err := wfSvc.RestartRole(ctx, it.workflowID, it.role, "", nil); err != nil {
			return rolloutFailed, "Rolle neu starten: " + err.Error(), ""
		}
		// Die Rolle bekommt eine neue Instanz: warten, bis sie läuft.
		deadline := time.Now().Add(m.roleWait)
		for time.Now().Before(deadline) {
			if w, err := wfSvc.Get(it.workflowID); err == nil {
				if rt, ok := w.Runtime[it.role]; ok && rt.InstanceID != "" && rt.InstanceID != it.InstanceID {
					if inst, ok := svc.Get(rt.InstanceID); ok && inst.PID > 0 {
						return rolloutOK, "Rolle neu gestartet (Node-ID bleibt, Verkabelung über den Workflow)", rt.InstanceID
					}
				}
			}
			time.Sleep(m.poll)
		}
		return rolloutFailed, "Rolle kam nicht rechtzeitig wieder hoch", ""
	}
	res, err := restarter.RestartInPlace(ctx, it.InstanceID)
	switch {
	case err == nil:
		return rolloutOK, fmt.Sprintf("neu gestartet, %d Kante(n) wiederhergestellt", res.Reconnected), res.NewInstanceID
	case res.RolledBack:
		return rolloutRolledBack, err.Error(), res.NewInstanceID
	default:
		return rolloutFailed, err.Error(), ""
	}
}

// handleStartNodeRollout: POST /api/v1/admin/node-versions/{name}/rollout
// {"confirm":true,"dryRun":false,"instanceIds":[…]} — dryRun liefert nur den Plan.
func handleStartNodeRollout(m *RolloutManager, svc LauncherService, wf WorkflowService, restarter InstanceRestarter, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		var body struct {
			Confirm     bool     `json:"confirm"`
			DryRun      bool     `json:"dryRun"`
			InstanceIDs []string `json:"instanceIds"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		only := map[string]bool{}
		for _, id := range body.InstanceIDs {
			only[id] = true
		}
		plan := m.plan(name, svc, wf, only)
		if body.DryRun {
			writeJSON(w, http.StatusOK, plan)
			return
		}
		if !body.Confirm {
			http.Error(w, "Bestätigung erforderlich (confirm: true)", http.StatusBadRequest)
			return
		}
		if restarter == nil {
			http.Error(w, "Rollout nicht verfügbar", http.StatusNotImplemented)
			return
		}
		if len(plan.Items) == 0 {
			http.Error(w, "keine Instanz muss umgestellt werden (alle laufen bereits mit der Ziel-Version)", http.StatusConflict)
			return
		}
		m.mu.Lock()
		if m.last != nil && m.last.Running {
			m.mu.Unlock()
			http.Error(w, "es läuft bereits ein Rollout", http.StatusConflict)
			return
		}
		plan.Running, plan.StartedAt = true, time.Now()
		cp := plan
		m.last = &cp
		m.mu.Unlock()
		actor := actorFromRequest(r)
		logDomainAudit(domainAudit, actor, "node_version", name, "rollout_started", map[string]any{"instances": len(plan.Items), "target": plan.Target})
		go m.run(plan, svc, wf, restarter, domainAudit, actor)
		writeJSON(w, http.StatusAccepted, plan)
	}
}

// handleGetNodeRollout: GET /api/v1/admin/node-versions/{name}/rollout — Stand des letzten Rollouts.
func handleGetNodeRollout(m *RolloutManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		st := m.snapshot()
		if st == nil || st.Name != r.PathValue("name") {
			writeJSON(w, http.StatusOK, map[string]any{"running": false, "items": []rolloutItem{}})
			return
		}
		writeJSON(w, http.StatusOK, st)
	}
}
