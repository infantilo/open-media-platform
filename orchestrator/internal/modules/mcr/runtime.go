package mcr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// WorkflowAPI ist die schmale Schnittstelle zum Workflow-Dienst (*workflows.Service).
type WorkflowAPI interface {
	Create(name string, def workflows.Definition, adopt map[string]workflows.RoleRuntime, ownerOrgID string) (workflows.Workflow, error)
	Update(id, name string, def workflows.Definition) (workflows.Workflow, error)
	Get(id string) (workflows.Workflow, error)
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string, confirm bool) error
	Delete(id string) error
}

// NodeAPI erreicht die Nodes der Workflow-Rollen.
type NodeAPI interface {
	// BaseURL: Adresse des Node-API einer Instanz (online), sonst false.
	BaseURL(instanceID string) (string, bool)
	// Do ruft die Node-API auf (Methode, vollständige URL, JSON-Körper oder nil) und gibt Körper und Statuscode zurück.
	Do(ctx context.Context, method, url string, body any) ([]byte, int, error)
}

// Runtime verbindet Events mit Workflows und Nodes. Die Datenbank ist die Quelle der Wahrheit: nach jedem (Neu-)Start einer
// Rolleninstanz schreibt `Reconcile` ihre Einstellungen aus der Datenbank an den Node zurück.
type Runtime struct {
	Wf         WorkflowAPI
	Nodes      NodeAPI
	SecretsDir func() string
	// Intercom: Rückwege zu den Leitungen (106.12); nil = keine Verknüpfung.
	Intercom *Intercom
	// Sources verbindet vorhandene Nodes (`transport.existing`) mit dem Normalizer; nil = nicht verfügbar.
	Sources SourceLinker
	// Poll/Timeout: Wartezeit auf Workflow-Zustände (Tests setzen kleine Werte).
	Poll    time.Duration
	Timeout time.Duration

	mu      sync.Mutex
	applied map[string]string // "<eventID>/<Rolle>" → Instanz-ID, an die die Einstellungen zuletzt gingen
	linked  map[string]string // "<eventID>/<Rolle>" → "<Normalizer-Instanz>|<Quelle>" der zuletzt verbundenen Quelle
}

var ErrConfirm = errors.New("mcr: Stoppen auf Sendung braucht Bestätigung")

func (rt *Runtime) poll() time.Duration {
	if rt.Poll > 0 {
		return rt.Poll
	}
	return 500 * time.Millisecond
}

func (rt *Runtime) timeout() time.Duration {
	if rt.Timeout > 0 {
		return rt.Timeout
	}
	return 90 * time.Second
}

func (rt *Runtime) secrets() string {
	if rt.SecretsDir == nil {
		return ""
	}
	return rt.SecretsDir()
}

// definitionFor materialisiert das Event mit dem aktuellen globalen Hausformat.
func (rt *Runtime) definitionFor(s *Service, e Event) (workflows.Definition, map[string]LineRoles, error) {
	g, err := s.GlobalHouse()
	if err != nil {
		return workflows.Definition{}, nil, err
	}
	d, r, _, err := Materialize(e, g, rt.secrets())
	return d, r, err
}

// Prepare legt den Workflow zum Event an oder aktualisiert ihn (planned → testing). Gibt die Workflow-ID zurück.
func (rt *Runtime) Prepare(ctx context.Context, s *Service, e Event) (string, error) {
	def, _, err := rt.definitionFor(s, e)
	if err != nil {
		return "", err
	}
	name := WorkflowName(e)
	if e.WorkflowID != "" {
		if _, err := rt.Wf.Get(e.WorkflowID); err == nil {
			if _, err := rt.Wf.Update(e.WorkflowID, name, def); err != nil {
				return "", fmt.Errorf("Workflow aktualisieren: %w", err)
			}
			return e.WorkflowID, nil
		}
	}
	wf, err := rt.Wf.Create(name, def, nil, "")
	if err != nil {
		return "", fmt.Errorf("Workflow anlegen: %w", err)
	}
	return wf.ID, nil
}

// StartWorkflow startet den Workflow (kehrt nach dem Anstoßen zurück; die Einstellungen gehen danach über Reconcile an die Nodes).
func (rt *Runtime) StartWorkflow(ctx context.Context, id string) error {
	if err := rt.Wf.Start(ctx, id); err != nil {
		return fmt.Errorf("Workflow starten: %w", err)
	}
	return nil
}

// StopWorkflow stoppt den Workflow (bestätigt, wenn `confirm`). Ein nicht laufender Workflow ist kein Fehler.
func (rt *Runtime) StopWorkflow(ctx context.Context, id string, confirm bool) error {
	err := rt.Wf.Stop(ctx, id, confirm)
	switch {
	case err == nil:
	case errors.Is(err, workflows.ErrNotRunning):
		return nil
	case errors.Is(err, workflows.ErrConfirmationRequired):
		return ErrConfirm
	default:
		return fmt.Errorf("Workflow stoppen: %w", err)
	}
	return rt.waitStatus(ctx, id, workflows.StatusStopped)
}

func (rt *Runtime) waitStatus(ctx context.Context, id, want string) error {
	deadline := time.Now().Add(rt.timeout())
	for {
		wf, err := rt.Wf.Get(id)
		if err != nil {
			return err
		}
		if wf.Status == want {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("Workflow %s: Zustand %q nicht erreicht (aktuell %q)", id, want, wf.Status)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(rt.poll()):
		}
	}
}

// DeleteWorkflow gibt den Workflow frei (stoppt ihn vorher, falls nötig).
func (rt *Runtime) DeleteWorkflow(ctx context.Context, id string) error {
	if err := rt.StopWorkflow(ctx, id, true); err != nil {
		return err
	}
	if err := rt.Wf.Delete(id); err != nil && !errors.Is(err, workflows.ErrNotFound) {
		return fmt.Errorf("Workflow löschen: %w", err)
	}
	rt.forget(id)
	return nil
}

func (rt *Runtime) forget(string) {}

// SetConfirmStop schaltet die Stoppbestätigung des laufenden Workflows (ab `live`).
func (rt *Runtime) SetConfirmStop(ctx context.Context, s *Service, e Event) error {
	def, _, err := rt.definitionFor(s, e)
	if err != nil {
		return err
	}
	_, err = rt.Wf.Update(e.WorkflowID, WorkflowName(e), def)
	return err
}

// Refresh schreibt Änderungen eines laufenden Events in die Workflow-Definition (für den nächsten Start) und sofort an die Nodes.
func (rt *Runtime) Refresh(ctx context.Context, s *Service, e Event) error {
	if e.WorkflowID == "" {
		return nil
	}
	def, _, err := rt.definitionFor(s, e)
	if err != nil {
		return err
	}
	if _, err := rt.Wf.Update(e.WorkflowID, WorkflowName(e), def); err != nil && !errors.Is(err, workflows.ErrNotStopped) {
		return fmt.Errorf("Workflow aktualisieren: %w", err)
	}
	rt.ForceApply(e.ID)
	return nil
}

// ForceApply: beim nächsten Abgleich alle Einstellungen des Events erneut senden.
func (rt *Runtime) ForceApply(eventID string) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	for k := range rt.applied {
		if len(k) > len(eventID) && k[:len(eventID)+1] == eventID+"/" {
			delete(rt.applied, k)
		}
	}
}

func (rt *Runtime) patch(ctx context.Context, base, name string, value any) error {
	b, code, err := rt.Nodes.Do(ctx, http.MethodPatch, base+"/params/"+name, map[string]any{"value": value})
	if err != nil {
		return err
	}
	if code >= 300 {
		return fmt.Errorf("PATCH %s: HTTP %d %s", name, code, bytes.TrimSpace(b))
	}
	return nil
}

// Reconcile gleicht ein laufendes Event ab: für jede Rolleninstanz, die der Datenbank noch nicht entspricht (neu gestartet), gehen
// Hausformat und Ausgleichs-Einstellungen aus der Datenbank an den Node. Gibt die Zahl der erfolgreich versorgten Leitungen zurück.
func (rt *Runtime) Reconcile(ctx context.Context, s *Service, e Event) (int, error) {
	if e.WorkflowID == "" || (e.State != StateTesting && e.State != StateLive) {
		return 0, nil
	}
	wf, err := rt.Wf.Get(e.WorkflowID)
	if err != nil || wf.Status != workflows.StatusStarted {
		return 0, err
	}
	_, roles, err := rt.definitionFor(s, e)
	if err != nil {
		return 0, err
	}
	g, _ := s.GlobalHouse()
	ev, _ := ParseHouse(e.HouseFormat)
	done := 0
	var firstErr error
	for _, l := range e.Lines {
		lr, ok := roles[l.ID]
		if !ok {
			continue
		}
		rr, ok := wf.Runtime[lr.Normalizer]
		if !ok || rr.InstanceID == "" {
			continue
		}
		key := e.ID + "/" + lr.Normalizer
		rt.mu.Lock()
		same := rt.applied[key] == rr.InstanceID
		rt.mu.Unlock()
		if same {
			done++
			continue
		}
		base, ok := rt.Nodes.BaseURL(rr.InstanceID)
		if !ok {
			continue // Node noch nicht in der Registry: nächster Abgleich
		}
		lh, _ := ParseHouse(l.HouseFormat)
		failed := false
		for _, p := range NodeParams(l, Effective(g, ev, lh)) {
			if err := rt.patch(ctx, base, p.Name, p.Value); err != nil {
				failed = true
				if firstErr == nil {
					firstErr = fmt.Errorf("Leitung %q: %w", l.Name, err)
				}
				break
			}
		}
		if failed {
			continue
		}
		rt.mu.Lock()
		if rt.applied == nil {
			rt.applied = map[string]string{}
		}
		rt.applied[key] = rr.InstanceID
		rt.mu.Unlock()
		done++
	}
	rt.reconcileIntercom(ctx, s, e, wf, roles)
	if err := rt.reconcileSources(ctx, e, wf, roles); err != nil && firstErr == nil {
		firstErr = err
	}
	return done, firstErr
}

// SourceLinker verbindet die Sender eines vorhandenen Nodes mit den Empfängern einer Normalizer-Instanz (Bild und Ton).
type SourceLinker interface {
	Link(ctx context.Context, src Existing, normalizerInstance string) error
}

// reconcileSources verbindet vorhandene Quell-Nodes; je Normalizer-Instanz und Quelle nur einmal (nach einem Neustart erneut).
func (rt *Runtime) reconcileSources(ctx context.Context, e Event, wf workflows.Workflow, roles map[string]LineRoles) error {
	if rt.Sources == nil {
		return nil
	}
	var firstErr error
	for _, l := range e.Lines {
		ex := ExistingSourceOf(l)
		lr, ok := roles[l.ID]
		if ex == nil || !ok {
			continue
		}
		inst := instanceOf(wf, lr.Normalizer)
		if inst == "" {
			continue
		}
		key := e.ID + "/" + lr.Normalizer
		sig := fmt.Sprintf("%s|%s|%s|%s|%s", inst, ex.NodeID, ex.NodeLabel, ex.VideoSenderID, ex.AudioSenderID)
		rt.mu.Lock()
		same := rt.linked[key] == sig
		rt.mu.Unlock()
		if same {
			continue
		}
		if err := rt.Sources.Link(ctx, *ex, inst); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("Leitung %q: Quelle verbinden: %w", l.Name, err)
			}
			continue
		}
		rt.mu.Lock()
		if rt.linked == nil {
			rt.linked = map[string]string{}
		}
		rt.linked[key] = sig
		rt.mu.Unlock()
	}
	return firstErr
}

// ReconcileLoop gleicht alle laufenden Events regelmäßig ab (läuft nur auf dem Raft-Leader, siehe Module.Start).
func (rt *Runtime) ReconcileLoop(ctx context.Context, s *Service, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		for _, st := range []string{StateTesting, StateLive} {
			evs, err := s.St.ListEvents(ctx, st)
			if err != nil {
				slog.Warn("mcr: Abgleich: Events nicht lesbar", "error", err)
				continue
			}
			for _, e := range evs {
				full, err := s.St.GetEvent(ctx, e.ID)
				if err != nil {
					continue
				}
				if _, err := rt.Reconcile(ctx, s, full); err != nil {
					slog.Warn("mcr: Abgleich", "event", e.ID, "error", err)
				}
			}
		}
	}
}

// ---- Zustand je Leitung (ein Aufruf statt vieler Einzelabfragen) ----

// LineStatus ist der Zustand einer Leitung, gelesen aus den Node-Parametern.
type LineStatus struct {
	LineID   string         `json:"lineId"`
	Name     string         `json:"name"`
	Input    map[string]any `json:"input,omitempty"`
	Normaliz map[string]any `json:"normalizer,omitempty"`
	Error    string         `json:"error,omitempty"`
}

var inputParams = []string{"contrib.state", "contrib.inputFormat", "contrib.bitrateKbps", "contrib.rttMs", "contrib.lossPermille", "contrib.audioChannels", "contrib.lastError", "ingest.labelSource", "ingest.labelClock", "state", "lastError"}
var normParams = []string{"normalize.state", "normalize.videoState", "normalize.audioState", "normalize.inputFormat", "normalize.stages", "normalize.warnings", "normalize.lastError",
	"avsync.mode", "avsync.manualMs", "avsync.heldMs", "avsync.measuredMs", "avsync.confidence", "avsync.method", "avsync.appliedMs", "avsync.videoDelayFrames", "avsync.running"}

func (rt *Runtime) readParams(ctx context.Context, instanceID string, names []string) (map[string]any, error) {
	base, ok := rt.Nodes.BaseURL(instanceID)
	if !ok {
		return nil, fmt.Errorf("Node der Instanz %s nicht erreichbar", instanceID)
	}
	out := map[string]any{}
	for _, n := range names {
		b, code, err := rt.Nodes.Do(ctx, http.MethodGet, base+"/params/"+n, nil)
		if err != nil || code != 200 {
			continue // Parameter gibt es an diesem Node-Typ nicht
		}
		var v struct {
			Value any `json:"value"`
		}
		if json.Unmarshal(b, &v) == nil {
			out[n] = v.Value
		}
	}
	return out, nil
}

// Status liest den Zustand aller Leitungen eines laufenden Events.
func (rt *Runtime) Status(ctx context.Context, s *Service, e Event) (map[string]any, error) {
	res := map[string]any{"eventId": e.ID, "state": e.State, "workflowId": e.WorkflowID}
	if e.WorkflowID == "" {
		res["lines"] = []LineStatus{}
		return res, nil
	}
	wf, err := rt.Wf.Get(e.WorkflowID)
	if err != nil {
		return res, err
	}
	res["workflowStatus"] = wf.Status
	_, roles, err := rt.definitionFor(s, e)
	if err != nil {
		return res, err
	}
	lines := []LineStatus{}
	for _, l := range e.Lines {
		ls := LineStatus{LineID: l.ID, Name: l.Name}
		lr := roles[l.ID]
		if rr, ok := wf.Runtime[lr.Input]; ok && lr.Input != "" && rr.InstanceID != "" {
			if m, err := rt.readParams(ctx, rr.InstanceID, inputParams); err == nil {
				ls.Input = m
			}
		}
		if rr, ok := wf.Runtime[lr.Normalizer]; ok && rr.InstanceID != "" {
			m, err := rt.readParams(ctx, rr.InstanceID, normParams)
			if err != nil {
				ls.Error = err.Error()
			}
			ls.Normaliz = m
		}
		lines = append(lines, ls)
	}
	res["lines"] = lines
	return res, nil
}

// NormalizerInstance liefert die Instanz-ID des Normalizers einer Leitung (leer = läuft nicht).
func (rt *Runtime) NormalizerInstance(s *Service, e Event, lineID string) (string, error) {
	if e.WorkflowID == "" {
		return "", ErrState
	}
	wf, err := rt.Wf.Get(e.WorkflowID)
	if err != nil {
		return "", err
	}
	_, roles, err := rt.definitionFor(s, e)
	if err != nil {
		return "", err
	}
	lr, ok := roles[lineID]
	if !ok {
		return "", ErrNotFound
	}
	rr, ok := wf.Runtime[lr.Normalizer]
	if !ok || rr.InstanceID == "" || wf.Status != workflows.StatusStarted {
		return "", ErrState
	}
	return rr.InstanceID, nil
}

// CallNormalizer ruft eine Methode am Normalizer einer Leitung auf.
func (rt *Runtime) CallNormalizer(ctx context.Context, instanceID, method string, args map[string]any) error {
	base, ok := rt.Nodes.BaseURL(instanceID)
	if !ok {
		return fmt.Errorf("Node der Instanz %s nicht erreichbar", instanceID)
	}
	if args == nil {
		args = map[string]any{}
	}
	b, code, err := rt.Nodes.Do(ctx, http.MethodPost, base+"/methods/"+method, args)
	if err != nil {
		return err
	}
	if code >= 300 {
		return fmt.Errorf("%s: HTTP %d %s", method, code, bytes.TrimSpace(b))
	}
	return nil
}

// ReadParam liest einen Parameter einer Instanz.
func (rt *Runtime) ReadParam(ctx context.Context, instanceID, name string) (any, error) {
	m, err := rt.readParams(ctx, instanceID, []string{name})
	if err != nil {
		return nil, err
	}
	return m[name], nil
}

// CallMethod ruft eine Methode an einer Rolleninstanz auf (z. B. `aux.1.setN1` am Audiomischer).
func (rt *Runtime) CallMethod(ctx context.Context, instanceID, method string, args map[string]any) error {
	return rt.CallNormalizer(ctx, instanceID, method, args)
}

// instanceOf liefert die Instanz einer Rolle im laufenden Workflow ("" = läuft nicht).
func instanceOf(wf workflows.Workflow, role string) string {
	if wf.Status != workflows.StatusStarted {
		return ""
	}
	return wf.Runtime[role].InstanceID
}

// reconcileIntercom legt die Rückwege an und schreibt die Warnungen ans Event.
func (rt *Runtime) reconcileIntercom(ctx context.Context, s *Service, e Event, wf workflows.Workflow, roles map[string]LineRoles) {
	if rt.Intercom == nil || rt.Intercom.Svc == nil || rt.Intercom.Fabric == nil {
		return
	}
	warns := rt.Intercom.Ensure(ctx, rt, s, e, func(role string) string { return instanceOf(wf, role) }, roles)
	if err := s.St.SetWarnings(ctx, e.ID, warns); err != nil {
		slog.Warn("mcr: Warnungen nicht gespeichert", "event", e.ID, "error", err)
	}
}
