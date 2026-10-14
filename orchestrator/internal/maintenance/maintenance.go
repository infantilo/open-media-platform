// Package maintenance implementiert den Wartungsmodus für Hosts: Der Host
// bekommt keine neue Last mehr (Placement-Sperre) und seine Workflow-Rollen
// werden nacheinander per Make-before-break (workflows.executeMigration) auf
// andere Hosts umgezogen — kein Signalausfall, solange ein Zielhost existiert.
//
// Bewusste Grenzen (ehrlich statt stillem Ausfall): Eigenständige, nicht
// Workflow-gebundene Instanzen haben keinen Make-before-break-Pfad
// (instancemigrate ist Stop-dann-Start) und bleiben stehen; sie werden als
// "Rest" gemeldet, der Bediener entscheidet. Dasselbe gilt für Rollen ohne
// Zielhost oder ohne freien I/O-Port auf dem Ziel.
package maintenance

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// ErrUnknownHost wird bei einer Host-ID geliefert, die die Registry nicht kennt.
var ErrUnknownHost = errors.New("maintenance: unknown host")

// Item ist etwas, das noch auf dem Host läuft (Rest) oder nicht umgezogen werden konnte.
type Item struct {
	Kind       string `json:"kind"` // "role" | "instance"
	WorkflowID string `json:"workflowId,omitempty"`
	Role       string `json:"role,omitempty"`
	InstanceID string `json:"instanceId"`
	Label      string `json:"label,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

// ReasonStandalone: eigenständige Instanz ohne Workflow — kein Make-before-break-Umzug möglich,
// nur manuell per Stop-dann-Start (POST /api/v1/instances/{id}/migrate). Die UI übersetzt den Code.
const ReasonStandalone = "standalone"

// ReasonHostBound: Rolle/Instanz ist an Hardware dieses Hosts gebunden (Katalog hostBound, Escalation
// "pinned" oder exklusiver I/O-Port) und wird nie automatisch umgezogen.
const ReasonHostBound = "hostBound"

// Step meldet den Fortschritt einer laufenden Evakuierung.
type Step struct {
	Total  int
	Moved  int
	Failed []Item
}

// Evacuator zieht die Workflow-Rollen eines Hosts um (workflows.Service).
type Evacuator interface {
	// EvacuateHost blockiert bis alle Rollen versucht wurden (oder ctx endet).
	EvacuateHost(ctx context.Context, hostID string, onStep func(Step))
	// RolesOn listet die Rollen laufender Workflows auf dem Host.
	RolesOn(hostID string) []Item
}

// InstanceLister liefert alle Instanzen (launcher.Launcher).
type InstanceLister interface {
	ListOnHost(hostID string) []Item
}

// HostFlags persistiert das Wartungs-Flag (hosts.Store).
type HostFlags interface {
	SetMaintenance(hostID string, on bool) error
	MaintenanceHosts() ([]string, error)
}

// PlacementGate sperrt den Host für neue Platzierungen (placement.Engine).
type PlacementGate interface {
	SetMaintenance(hostID string, on bool)
}

// Status ist der API-Blick auf den Wartungszustand eines Hosts.
type Status struct {
	Since     time.Time `json:"since"`
	State     string    `json:"state"` // "evacuating" | "drained" | "blocked"
	Total     int       `json:"total"`
	Moved     int       `json:"moved"`
	Failed    []Item    `json:"failed,omitempty"`
	Remaining []Item    `json:"remaining,omitempty"`
}

type entry struct {
	since   time.Time
	cancel  context.CancelFunc
	running bool
	step    Step
}

// Manager verwaltet den Wartungszustand aller Hosts.
type Manager struct {
	flags  HostFlags
	gate   PlacementGate
	evac   Evacuator
	insts  InstanceLister
	events interface{ Broadcast(sse.Event) }

	mu      sync.Mutex
	entries map[string]*entry
}

// NewManager erstellt den Manager; events darf nil sein.
func NewManager(flags HostFlags, gate PlacementGate, evac Evacuator, insts InstanceLister, events interface{ Broadcast(sse.Event) }) *Manager {
	return &Manager{flags: flags, gate: gate, evac: evac, insts: insts, events: events, entries: map[string]*entry{}}
}

// Restore stellt nach einem Neustart die Placement-Sperre aller Hosts im
// Wartungsmodus wieder her. Eine Evakuierung startet nicht von selbst
// (Telemetrie fehlt noch) — der Bediener stößt sie bei Bedarf erneut an.
func (m *Manager) Restore() {
	ids, err := m.flags.MaintenanceHosts()
	if err != nil {
		slog.Warn("maintenance: restore failed", "error", err)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, id := range ids {
		m.gate.SetMaintenance(id, true)
		m.entries[id] = &entry{since: time.Now()}
	}
}

// Enter versetzt den Host in den Wartungsmodus und startet die Evakuierung.
// Idempotent; ein erneuter Aufruf nach "blocked" versucht die Reste nochmal.
func (m *Manager) Enter(hostID string) error {
	if err := m.flags.SetMaintenance(hostID, true); err != nil {
		return err
	}
	m.gate.SetMaintenance(hostID, true)

	m.mu.Lock()
	e := m.entries[hostID]
	if e == nil {
		e = &entry{since: time.Now()}
		m.entries[hostID] = e
	}
	if e.running {
		m.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	e.cancel, e.running, e.step = cancel, true, Step{}
	m.mu.Unlock()

	m.notify(hostID)
	go func() {
		m.evac.EvacuateHost(ctx, hostID, func(s Step) {
			m.mu.Lock()
			e.step = s
			m.mu.Unlock()
			m.notify(hostID)
		})
		m.mu.Lock()
		e.running = false
		m.mu.Unlock()
		m.notify(hostID)
	}()
	return nil
}

// Leave beendet den Wartungsmodus (laufende Evakuierung wird abgebrochen,
// bereits umgezogene Rollen bleiben, wo sie sind).
func (m *Manager) Leave(hostID string) error {
	if err := m.flags.SetMaintenance(hostID, false); err != nil {
		return err
	}
	m.gate.SetMaintenance(hostID, false)
	m.mu.Lock()
	if e := m.entries[hostID]; e != nil && e.cancel != nil {
		e.cancel()
	}
	delete(m.entries, hostID)
	m.mu.Unlock()
	m.notify(hostID)
	return nil
}

// Status liefert den Wartungsstatus; ok=false, wenn der Host nicht in Wartung ist.
func (m *Manager) Status(hostID string) (Status, bool) {
	m.mu.Lock()
	e, ok := m.entries[hostID]
	if !ok {
		m.mu.Unlock()
		return Status{}, false
	}
	st := Status{Since: e.since, Total: e.step.Total, Moved: e.step.Moved, Failed: e.step.Failed}
	running := e.running
	m.mu.Unlock()

	rem := m.evac.RolesOn(hostID)
	inRole := map[string]bool{}
	for _, r := range rem {
		inRole[r.InstanceID] = true
	}
	for _, it := range m.insts.ListOnHost(hostID) {
		if !inRole[it.InstanceID] {
			rem = append(rem, it)
		}
	}
	sort.Slice(rem, func(i, j int) bool { return rem[i].InstanceID < rem[j].InstanceID })
	st.Remaining = rem
	switch {
	case running:
		st.State = "evacuating"
	case len(rem) == 0:
		st.State = "drained"
	default:
		st.State = "blocked"
	}
	return st, true
}

func (m *Manager) notify(hostID string) {
	if m.events == nil {
		return
	}
	if data, err := json.Marshal(map[string]string{"hostId": hostID}); err == nil {
		m.events.Broadcast(sse.Event{Type: "host.maintenance", Data: data})
	}
}
