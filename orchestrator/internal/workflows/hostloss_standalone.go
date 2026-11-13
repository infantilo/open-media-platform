// Kapitel 100 — Host-Ausfall eigenständiger Instanzen.
//
// Neben den Workflow-Rollen (hostloss.go) ziehen auch Launcher-Instanzen ohne Rolle (z. B. per POST /api/v1/instances
// angelegt) auf einen anderen Host um, wenn ihr Host ausfällt: gleiche Frist (OMP_HOST_FAILURE_RELOCATE_AFTER), gleicher
// Schalter (OMP_HOST_FAILURE_RELOCATE=off schaltet beides ab), gleiche Ausnahmen (Goodbye, Wartung) und dieselbe
// Platzwahl wie die Host-Wartung. Der Umzug selbst ist instancemigrate.Service.RelocateLost; der Stop der verlorenen
// Instanz bleibt beim Launcher vorgemerkt (RetryPendingStops) — Abgrenzung gegen eine Doppelsendung.
//
// Ausgenommen bleiben Node-Typen, die der Katalog als hostgebunden führt (Capture-Karte, Geräte, GPIO, MIDI, ALSA-
// Mischer): sie brauchen Hardware ihres Hosts. Ein Feld je Instanz zum Übersteuern gibt es nicht — nur der globale
// Schalter. Kommt der Host ohne Umzug zurück (Neustart des Host-Agents), startet der Abgleich des Launchers die
// Instanz dort wie bisher neu.
package workflows

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// StandaloneRelocator zieht eine eigenständige Instanz eines ausgefallenen Hosts um (instancemigrate.Service).
type StandaloneRelocator interface {
	RelocateLost(ctx context.Context, instanceID, targetHostID string) error
}

// SetStandaloneRelocator verdrahtet den Umzug eigenständiger Instanzen bei Host-Ausfall (nil = aus).
func (s *Service) SetStandaloneRelocator(r StandaloneRelocator) {
	if r == nil {
		s.standalone.Store(nil)
		return
	}
	s.standalone.Store(&r)
}

// instanceMigrationEvent ist der Payload des "instance.migration"-SSE-Events (Umzug einer eigenständigen Instanz).
type instanceMigrationEvent struct {
	InstanceID   string    `json:"instanceId"`
	Label        string    `json:"label,omitempty"`
	NodeType     string    `json:"nodeType"`
	FromHostID   string    `json:"fromHostId"`
	TargetHostID string    `json:"targetHostId,omitempty"`
	Reason       string    `json:"reason"` // "host-lost" | "host-lost-no-target" | "host-lost-failed"
	Status       string    `json:"status"` // "done" | "failed"
	At           time.Time `json:"at"`
}

func (s *Service) publishInstanceMigrationEvent(ev instanceMigrationEvent) {
	if s.events == nil {
		return
	}
	if data, err := json.Marshal(ev); err == nil {
		s.events.Broadcast(sse.Event{Type: "instance.migration", Data: data})
	}
}

// standaloneOnHost listet die Instanzen auf hostID, die bei einem Ausfall umziehen dürfen: eigenständig (keine
// Workflow-Rolle), nicht schon zum Stoppen vorgemerkt, nicht abgestürzt, kein hostgebundener Typ.
func (s *Service) standaloneOnHost(hostID string) []launcher.Instance {
	ll, ok := s.launcher.(interface{ List() []launcher.Instance })
	if !ok || s.standalone.Load() == nil || !hostLossRelocateDefault() {
		return nil
	}
	bound := map[string]bool{}
	for _, e := range s.launcher.Catalog() {
		if e.HostBound {
			bound[e.Type] = true
		}
	}
	var out []launcher.Instance
	for _, in := range ll.List() {
		if in.HostID != hostID || in.StopPending || in.Crashed || bound[in.Type] {
			continue
		}
		if _, _, isRole := s.FindRoleForInstance(in.ID); isRole {
			continue
		}
		out = append(out, in)
	}
	return out
}

// standaloneLostHosts: Hosts, auf denen umziehbare eigenständige Instanzen liegen (Kandidaten für checkLostHosts).
func (s *Service) standaloneLostHosts() []string {
	ll, ok := s.launcher.(interface{ List() []launcher.Instance })
	if !ok || s.standalone.Load() == nil || !hostLossRelocateDefault() {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, in := range ll.List() {
		if in.HostID != "" && !seen[in.HostID] && !in.StopPending && !in.Crashed {
			seen[in.HostID] = true
			out = append(out, in.HostID)
		}
	}
	return out
}

// relocateStandaloneFromLostHost zieht die eigenständigen Instanzen des ausgefallenen Hosts nacheinander um. Liefert
// die Zahl der umgezogenen.
func (s *Service) relocateStandaloneFromLostHost(hostID string) int {
	rel := s.standalone.Load()
	if rel == nil || s.resources == nil {
		return 0
	}
	insts := s.standaloneOnHost(hostID)
	if len(insts) == 0 {
		return 0
	}
	slog.Warn("workflows: host lost, relocating its standalone instances", "host", hostID, "instances", len(insts))
	moved := 0
	for _, in := range insts {
		if !s.hostLostForRelocation(hostID) {
			return moved // der Host ist wieder da: der Abgleich des Launchers startet den Rest dort neu
		}
		ev := instanceMigrationEvent{InstanceID: in.ID, Label: in.Label, NodeType: in.Type, FromHostID: hostID, Status: "failed"}
		res := s.resources.SelectHost(placement.PlacementRequest{NodeType: in.Type}, s.buildOccupancy(time.Now()))
		if res.HostID == hostID || (res.HostID != "" && s.hostOffline(res.HostID)) {
			slog.Warn("workflows: standalone instance stays on the lost host, no target", "instance", in.ID, "host", hostID)
			ev.Reason, ev.At = "host-lost-no-target", time.Now()
			s.publishInstanceMigrationEvent(ev)
			continue
		}
		if !s.claimMigrationAttempt(in.ID) {
			continue
		}
		ev.TargetHostID = res.HostID
		err := (*rel).RelocateLost(context.Background(), in.ID, res.HostID)
		s.finishMigrationAttempt(in.ID)
		ev.At = time.Now()
		if err != nil {
			slog.Warn("workflows: standalone relocation failed", "instance", in.ID, "host", hostID, "target", res.HostID, "error", err)
			ev.Reason = "host-lost-failed"
			s.publishInstanceMigrationEvent(ev)
			continue
		}
		ev.Reason, ev.Status = "host-lost", "done"
		s.publishInstanceMigrationEvent(ev)
		moved++
	}
	return moved
}
