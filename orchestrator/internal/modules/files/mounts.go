package files

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/jobwire"
)

// Mount-/Host-Zustand je Ort (Kapitel 86, hängende Mounts): jede Dateioperation und ein Takt-Probelauf (df) melden ihr Ergebnis.
// Zwei Fehlschläge in Folge lösen den Alarm aus (Entprellung); die Erholung wird gemeldet.

const (
	MountOK          = "ok"
	MountHung        = "hung"        // Mount antwortet nicht (Frist überschritten)
	MountUnreachable = "unreachable" // Host offline, Ort nicht vorhanden/nicht freigegeben, sonstiger Fehler
)

type mountState struct {
	State    string
	Since    time.Time
	Fails    int
	Notified string
	Msg      string
	Host     string // zuletzt erfolgreicher/gewählter Host
}

type mountTracker struct {
	mu   sync.Mutex
	byID map[string]*mountState
	pref map[string]string // Ort → zuletzt erfolgreicher Host (gemeinsamer Speicher)
}

func (m *Module) tracker() *mountTracker {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.mounts == nil {
		m.mounts = &mountTracker{byID: map[string]*mountState{}, pref: map[string]string{}}
	}
	return m.mounts
}

// MountInfo: Zustand für die Oberfläche.
type MountInfo struct {
	State      string `json:"state"`
	Since      string `json:"since,omitempty"`
	Message    string `json:"message,omitempty"`
	ActiveHost string `json:"activeHost"`
}

func (m *Module) mountInfo(id string) MountInfo {
	t := m.tracker()
	t.mu.Lock()
	defer t.mu.Unlock()
	s := t.byID[id]
	if s == nil {
		return MountInfo{State: MountOK}
	}
	mi := MountInfo{State: s.State, Message: s.Msg, ActiveHost: s.Host}
	if s.State != MountOK && !s.Since.IsZero() {
		mi.Since = s.Since.UTC().Format(time.RFC3339)
	}
	return mi
}

// hostFailure: Fehler des Hosts oder Mounts (nächsten Host versuchen) — nicht der Anfrage (ungültiger Pfad o. ä.).
func hostFailure(err error) bool {
	if err == nil {
		return false
	}
	if jobwireInvalid(err) {
		return false
	}
	return true
}

func jobwireInvalid(err error) bool { return strings.Contains(err.Error(), "Dateioperation ungültig") }

// rootOp führt eine Operation in einem Ort aus. Bei gemeinsamem Speicher werden die Hosts der Reihe nach versucht (zuletzt
// erfolgreicher zuerst); fällt einer aus oder hängt sein Mount, kommt der nächste an die Reihe. Nie blockierend (Fristen in jobwire).
func (m *Module) rootOp(root Root, op jobwire.FileOp) ([]byte, error) {
	op.Root = root.Path
	hosts := []string{root.HostID}
	if root.Shared && len(root.Hosts) > 0 {
		hosts = append([]string{}, root.Hosts...)
		t := m.tracker()
		t.mu.Lock()
		p, ok := t.pref[root.ID]
		t.mu.Unlock()
		if ok {
			for i, h := range hosts {
				if h == p && i > 0 {
					hosts = append([]string{h}, append(hosts[:i:i], hosts[i+1:]...)...)
					break
				}
			}
		}
	}
	var errs []string
	var last error
	for _, h := range hosts {
		raw, err := m.hostOp(h, op)
		if err == nil {
			m.mountResult(root, h, nil)
			return raw, nil
		}
		if !hostFailure(err) {
			return nil, err // ungültige Anfrage: kein Mount-Problem
		}
		last = err
		errs = append(errs, hostLabel(h)+": "+err.Error())
	}
	err := last
	if len(hosts) > 1 {
		err = fmt.Errorf("%s", strings.Join(errs, "; "))
		if jobwire.IsMountHung(last) {
			err = fmt.Errorf("%w (%s)", jobwire.ErrMountHung, strings.Join(errs, "; "))
		}
	}
	m.mountResult(root, hosts[len(hosts)-1], err)
	return nil, err
}

// mountResult führt den Zustand des Ortes nach und löst Alarme aus.
func (m *Module) mountResult(root Root, host string, err error) {
	t := m.tracker()
	t.mu.Lock()
	s := t.byID[root.ID]
	if s == nil {
		s = &mountState{State: MountOK}
		t.byID[root.ID] = s
	}
	if err == nil {
		t.pref[root.ID] = host
		s.Host = host
		wasNotified := s.Notified
		s.State, s.Fails, s.Msg, s.Since, s.Notified = MountOK, 0, "", time.Time{}, ""
		t.mu.Unlock()
		if wasNotified != "" {
			m.alert("file-mount-recovered", "info", root.ID, root.Name, fmt.Sprintf("Ort „%s“ (%s) antwortet wieder.", root.Name, root.Path))
			m.event("omp.files.mount-recovered", map[string]any{"root": root.Name, "path": root.Path})
			m.audit("system", "file-root", root.ID, "file.mount.recovered", map[string]any{"root": root.Name})
		}
		return
	}
	state := MountUnreachable
	if jobwire.IsMountHung(err) {
		state = MountHung
	}
	if s.State != state || s.Since.IsZero() {
		s.Since = time.Now()
		s.Fails = 0
	}
	s.State, s.Msg = state, err.Error()
	s.Fails++
	fire := s.Fails >= 2 && s.Notified != state
	if fire {
		s.Notified = state
	}
	since := s.Since
	t.mu.Unlock()
	if !fire {
		return
	}
	kind, sev, msg := "file-root-unreachable", "warning",
		fmt.Sprintf("Ort „%s“ (%s) ist nicht erreichbar: %s", root.Name, root.Path, err.Error())
	if state == MountHung {
		kind, sev = "file-mount-hung", "critical"
		msg = fmt.Sprintf("Mount hängt: Ort „%s“ (%s) antwortet seit %s nicht. Dateioperationen darauf werden sofort abgewiesen; andere Orte, Sendungen und der Orchestrator sind nicht blockiert. Ursache: %s",
			root.Name, root.Path, since.Format("15:04:05"), err.Error())
	}
	m.alert(kind, sev, root.ID, root.Name, msg)
	m.event("omp."+strings.ReplaceAll(kind, "-", "."), map[string]any{"root": root.Name, "path": root.Path, "state": state, "since": since})
	m.audit("system", "file-root", root.ID, "file.mount."+state, map[string]any{"root": root.Name, "path": root.Path, "error": err.Error()})
}

// ProbeRoots prüft alle Orte (df) — gleichzeitig, jede Prüfung mit Frist; hängende Mounts blockieren weder die anderen Orte noch den Takt.
func (m *Module) ProbeRoots(ctx context.Context) {
	roots, err := ListRoots(ctx, m.db())
	if err != nil {
		return
	}
	var wg sync.WaitGroup
	for _, r := range roots {
		wg.Add(1)
		go func(r Root) {
			defer wg.Done()
			_, _ = m.rootOp(r, jobwire.FileOp{Op: jobwire.FileOpDF}) // Ergebnis geht über mountResult
		}(r)
	}
	wg.Wait()
}
