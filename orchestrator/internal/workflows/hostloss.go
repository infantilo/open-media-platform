// Kapitel 100 Punkte 2 und 3 — Host-Ausfall ohne Standby und Wiederherstellen der Redundanz.
//
// Fällt ein Host aus, übernimmt für Rollen MIT Standby die Standby-Instanz (failover.go). Alle anderen Rollen blieben
// bisher stehen, bis jemand eingriff. Hier ziehen sie auf einen anderen Host um: die Platzwahl ist dieselbe wie bei
// der Host-Wartung (Verbünde über MXL bleiben zusammen, kein Umzug in die Überlast, Hardware-gebundene Rollen
// bleiben), der Ablauf ist der des Make-before-break-Umzugs im Verlust-Modus (runMigration, oldLost): neue Instanz
// starten, Zustand aus der letzten Sicherung, Verbindungen anwenden. Die verlorene Instanz kann nicht gestoppt
// werden — ihr Stop bleibt beim Launcher vorgemerkt und wird nachgeholt, sobald der Host wieder Telemetrie sendet
// (launcher.RetryPendingStops). Das ist die Abgrenzung gegen eine Doppelsendung nach einer Netztrennung; zusätzlich
// kann sich der Host-Agent selbst abgrenzen (OMP_HOST_AGENT_FENCE_AFTER).
//
// Eigenständige Instanzen (Launcher-Instanzen ohne Workflow-Rolle) ziehen nach derselben Frist und demselben Schalter
// um (hostloss_standalone.go); Hardware-gebundene Node-Typen (Katalog hostBound) bleiben.
//
// Bewusst NICHT ausgelöst wird der Umzug, wenn der Host-Agent sich abgemeldet hat (Goodbye: absichtliches Beenden,
// z. B. Aktualisierung) oder der Host in Wartung ist — dort hat ein Bediener die Hand am Host.
package workflows

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/safego"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// defaultHostLossRelocateAfter: so lange muss die Telemetrie eines Hosts ausbleiben, bevor seine Rollen umziehen.
// Länger als hostOfflineTimeout (Standby-Übernahme, 20 s): ein Neustart des Host-Agents dauert wenige Sekunden und
// soll keinen Umzug auslösen — dafür gibt es den Abgleich des Launchers, der die Instanzen am selben Host neu startet.
const defaultHostLossRelocateAfter = 45 * time.Second

// hostLossRetryInterval: Abstand zwischen zwei Umzugsläufen für denselben ausgefallenen Host (Rollen ohne Zielhost
// würden sonst alle 5 s erneut versucht und gemeldet).
const hostLossRetryInterval = 60 * time.Second

// hostLossRelocateDefault liest OMP_HOST_FAILURE_RELOCATE: "off" schaltet den automatischen Umzug systemweit ab (je
// Rolle über placement.onHostFailure wieder einschaltbar), alles andere = an.
func hostLossRelocateDefault() bool {
	return strings.ToLower(strings.TrimSpace(os.Getenv("OMP_HOST_FAILURE_RELOCATE"))) != "off"
}

// hostLossRelocateAfter liest OMP_HOST_FAILURE_RELOCATE_AFTER (Go-Dauer); nie kürzer als hostOfflineTimeout.
func hostLossRelocateAfter() time.Duration {
	if d, err := time.ParseDuration(os.Getenv("OMP_HOST_FAILURE_RELOCATE_AFTER")); err == nil && d >= hostOfflineTimeout {
		return d
	}
	return defaultHostLossRelocateAfter
}

// relocatesOnHostLoss meldet, ob die Rolle bei einem Host-Ausfall umziehen soll.
func relocatesOnHostLoss(r Role) bool {
	if r.Placement != nil {
		switch r.Placement.OnHostFailure {
		case HostFailureRelocate:
			return true
		case HostFailureStay:
			return false
		}
	}
	return hostLossRelocateDefault()
}

// seedRoleName liefert den Namen, mit dessen Rollen-Seed die Instanz von role läuft (s. RoleRuntime.SeedRole).
func seedRoleName(wf Workflow, role string) string {
	if rt, ok := wf.Runtime[role]; ok && rt.SeedRole != "" {
		return rt.SeedRole
	}
	return role
}

// hostLostForRelocation meldet, ob hostID lange genug ohne Telemetrie ist, um seine Rollen umzuziehen. Ein Host, der
// sich abgemeldet hat (Goodbye) oder in Wartung ist, zählt nicht.
func (s *Service) hostLostForRelocation(hostID string) bool {
	if s.hostMetrics == nil || hostID == "" {
		return false
	}
	if d, ok := s.resources.(interface{ IsDraining(string) bool }); ok && d.IsDraining(hostID) {
		return false
	}
	after := hostLossRelocateAfter()
	m, ok := s.hostMetrics.Get(hostID)
	if ok {
		return !m.Goodbye && time.Since(m.ReceivedAt) >= after
	}
	// Nie gesehen (Orchestrator-Neustart während des Ausfalls): hostOffline führt die Uhr ab der ersten Beobachtung.
	if !s.hostOffline(hostID) {
		return false
	}
	s.hostUnseenMu.Lock()
	first := s.hostUnseen[hostID]
	s.hostUnseenMu.Unlock()
	return !first.IsZero() && time.Since(first) >= after
}

// checkLostHosts stößt für jeden ausgefallenen Host mit Rollen laufender Workflows einen Umzugslauf an (höchstens
// einer je Host zur selben Zeit, danach hostLossRetryInterval Pause).
func (s *Service) checkLostHosts(wfs []Workflow) {
	lost := map[string]bool{}
	for _, wf := range wfs {
		if wf.Status != StatusStarted {
			continue
		}
		for _, rt := range wf.Runtime {
			if rt.InstanceID != "" && rt.HostID != "" && !lost[rt.HostID] && s.hostLostForRelocation(rt.HostID) {
				lost[rt.HostID] = true
			}
		}
	}
	for _, hostID := range s.standaloneLostHosts() {
		if s.hostLostForRelocation(hostID) {
			lost[hostID] = true
		}
	}
	for hostID := range lost {
		if v, ok := s.relocating.Load(hostID); ok {
			next, isTime := v.(time.Time)
			if !isTime || time.Now().Before(next) {
				continue // läuft noch bzw. Pause
			}
		}
		s.relocating.Store(hostID, struct{}{})
		hostID := hostID
		safego.Go("workflows.relocateFromLostHost", func() {
			defer func() { s.relocating.Store(hostID, time.Now().Add(hostLossRetryInterval)) }()
			s.relocateFromLostHost(hostID)
			s.relocateStandaloneFromLostHost(hostID)
		})
	}
}

// relocateFromLostHost zieht die Rollen des ausgefallenen Hosts nacheinander um. Liefert die Zahl der umgezogenen.
func (s *Service) relocateFromLostHost(hostID string) int {
	roles := s.RolesOn(hostID)
	if len(roles) == 0 || s.resources == nil {
		return 0
	}
	slog.Warn("workflows: host lost, relocating its roles", "host", hostID, "roles", len(roles))
	groupCache := map[string]placement.GroupResult{}
	defer func() {
		for key, res := range groupCache {
			wfID := key[:strings.Index(key, "|")]
			for role := range res.Hosts {
				s.groupMoves.Delete(groupMoveKey(wfID, role))
			}
		}
	}()
	skip := func(wf Workflow, role, instanceID, reason string) {
		slog.Warn("workflows: role stays on the lost host", "workflow", wf.ID, "role", role, "host", hostID, "reason", reason)
		s.publishMigrationEvent(migrationEvent{WorkflowID: wf.ID, Role: role, FromInstanceID: instanceID, Reason: reason, Status: "failed", At: time.Now()})
	}
	moved := 0
	for _, it := range roles {
		if !s.hostLostForRelocation(hostID) {
			return moved // der Host ist wieder da: der Rest läuft dort weiter bzw. wird vom Launcher neu gestartet
		}
		wf, ok := s.stillBacks(it.WorkflowID, it.Role, it.InstanceID)
		if !ok {
			continue
		}
		roleDef, ok := roleByName(wf, it.Role)
		if !ok {
			continue
		}
		// Eine Primärrolle mit Standby übernimmt ihr Standby (failover.go). Erst wenn das nicht ging (Standby selbst
		// tot), zieht sie wie jede andere um — dafür genügt, dass sie beim nächsten Lauf noch hier steht.
		if sb := s.standbyRoleFor(wf, it.Role); sb != "" && !wf.Runtime[it.Role].StandbyActive {
			if sbRt := wf.Runtime[sb]; sbRt.InstanceID != "" && !s.hostOffline(sbRt.HostID) {
				continue
			}
		}
		if !relocatesOnHostLoss(roleDef) {
			continue // so eingestellt: nur Alarm
		}
		if s.roleHostBound(roleDef) {
			skip(wf, it.Role, it.InstanceID, "host-lost-host-bound")
			continue
		}
		target, why := s.evacuationTarget(wf, it, roles, hostID, groupCache)
		if why != "" {
			skip(wf, it.Role, it.InstanceID, "host-lost-no-target")
			continue
		}
		if !s.claimMigrationAttempt(it.InstanceID) {
			continue
		}
		s.runMigration(wf.ID, it.Role, it.InstanceID, target, "host-lost", true)
		if now, err := s.store.Get(wf.ID); err == nil && now.Runtime[it.Role].InstanceID != it.InstanceID {
			moved++
		}
	}
	return moved
}

// fenceInstance stoppt eine Instanz, die keine Rolle mehr erfüllt (nach einer Standby-Übernahme die alte
// Primärinstanz). Ist ihr Host nicht erreichbar, merkt der Launcher den Stop vor und holt ihn nach — so sendet nach
// dem Ende einer Netztrennung nicht plötzlich wieder eine zweite Instanz derselben Rolle.
func (s *Service) fenceInstance(workflowID, instanceID string) {
	if instanceID == "" {
		return
	}
	if err := s.launcher.Stop(instanceID); err != nil && !errors.Is(err, launcher.ErrUnknownInstance) && !errors.Is(err, launcher.ErrStopDeferred) {
		slog.Warn("workflows: fencing the superseded instance failed", "workflow", workflowID, "instance", instanceID, "error", err)
	}
	if s.authz != nil {
		if err := s.authz.DeleteInstanceBinding(instanceID, workflowID); err != nil {
			slog.Warn("workflows: failed to clean up instance role binding", "workflow", workflowID, "instance", instanceID, "error", err)
		}
	}
}

// ErrNothingToRearm: die Rolle läuft nicht auf ihrem Standby — es gibt nichts wiederherzustellen.
var ErrNothingToRearm = errors.New("workflows: role is not running on its standby")

// standbyEvent ist der Payload des "workflow.standby"-SSE-Events (Redundanz wiederhergestellt oder nicht möglich).
type standbyEvent struct {
	WorkflowID  string    `json:"workflowId"`
	Role        string    `json:"role"`
	StandbyRole string    `json:"standbyRole"`
	InstanceID  string    `json:"instanceId,omitempty"`
	HostID      string    `json:"hostId,omitempty"`
	Status      string    `json:"status"` // "rearmed" | "failed"
	Reason      string    `json:"reason,omitempty"`
	At          time.Time `json:"at"`
}

func (s *Service) publishStandbyEvent(ev standbyEvent) {
	if s.events == nil {
		return
	}
	if data, err := json.Marshal(ev); err == nil {
		s.events.Broadcast(sse.Event{Type: "workflow.standby", Data: data})
	}
}

// RearmStandby stellt nach einer Standby-Übernahme die Redundanz wieder her (Kapitel 100 Punkt 3, "Rückschwenk" ohne
// zweite Unterbrechung): die Rolle bleibt auf der übernommenen Instanz, und für die Standby-Rolle startet eine neue,
// warme Instanz auf einem anderen Host (Platzwahl mit Redundanz-Gruppe). Danach ist die Rolle wieder
// failover-fähig. Wer auf den ursprünglichen Host zurück will, zieht die Rolle anschließend per Umzug
// (Make-before-break) dorthin. Prüft synchron, arbeitet asynchron (beobachtbar per SSE "workflow.standby").
func (s *Service) RearmStandby(ctx context.Context, workflowID, primaryRole string) error {
	wf, err := s.store.Get(workflowID)
	if err != nil {
		return err
	}
	if wf.Status != StatusStarted {
		return ErrNotRunning
	}
	if _, ok := roleByName(wf, primaryRole); !ok {
		return fmt.Errorf("%w: role %q not found", ErrValidation, primaryRole)
	}
	if _, _, err := s.rearmCandidate(wf, primaryRole); err != nil {
		return err
	}
	safego.Go("workflows.rearmStandby", func() { s.rearmStandby(workflowID, primaryRole) })
	return nil
}

// rearmCandidate prüft, ob primaryRole gerade auf der Instanz ihrer Standby-Rolle läuft.
func (s *Service) rearmCandidate(wf Workflow, primaryRole string) (standbyRole string, promoted RoleRuntime, err error) {
	standbyRole = s.standbyRoleFor(wf, primaryRole)
	if standbyRole == "" {
		return "", RoleRuntime{}, fmt.Errorf("%w: role %q has no standby role", ErrValidation, primaryRole)
	}
	promoted = wf.Runtime[primaryRole]
	if !promoted.StandbyActive || promoted.InstanceID == "" || wf.Runtime[standbyRole].InstanceID != promoted.InstanceID {
		return "", RoleRuntime{}, ErrNothingToRearm
	}
	return standbyRole, promoted, nil
}

func (s *Service) rearmStandby(workflowID, primaryRole string) {
	key := "rearm|" + workflowID + "|" + primaryRole
	if _, busy := s.promoting.LoadOrStore(key, struct{}{}); busy {
		return
	}
	defer s.promoting.Delete(key)

	wf, err := s.store.Get(workflowID)
	if err != nil || wf.Status != StatusStarted {
		return
	}
	standbyRole, promoted, err := s.rearmCandidate(wf, primaryRole)
	if err != nil {
		return
	}
	fail := func(reason string) {
		slog.Warn("workflows: standby could not be re-established", "workflow", workflowID, "role", primaryRole, "standbyRole", standbyRole, "reason", reason)
		s.publishStandbyEvent(standbyEvent{WorkflowID: workflowID, Role: primaryRole, StandbyRole: standbyRole, Status: "failed", Reason: reason, At: time.Now()})
	}
	roleDef, _ := roleByName(wf, standbyRole)
	if s.roleHostBound(roleDef) {
		fail("host-bound")
		return
	}
	if s.resources == nil {
		fail("no-placement")
		return
	}
	res := s.resources.SelectHost(placement.PlacementRequest{
		NodeType: roleDef.NodeType, AffinityGroup: roleDef.AffinityGroup, RedundancyGroup: roleDef.RedundancyGroup,
	}, s.buildOccupancy(time.Now()))
	if res.HostID == promoted.HostID {
		// Ein Standby auf demselben Host wie die aktive Instanz schützt vor nichts.
		fail("no-other-host")
		return
	}

	// Die übernommene Instanz läuft mit dem Seed der einen Rolle weiter — die neue bekommt den der anderen (dessen
	// frühere Trägerin ist ausgefallen und abgegrenzt), damit nie zwei lebende Nodes dieselbe NMOS-ID tragen.
	seed := primaryRole
	if seedRoleName(wf, primaryRole) == primaryRole {
		seed = standbyRole
	}
	env := withRoleSeed(s.roleBaseEnv(wf, roleDef), wf.ID, seed)
	env[launcher.StateKeyEnv] = roleStateKey(wf.ID, roleDef.Name)
	inst, err := s.launcher.StartLabeled(roleDef.NodeType, "", res.HostID, roleDef.Name, env)
	if err != nil {
		fail("start-failed")
		return
	}
	if s.authz != nil && s.IsControlPlaneNodeType(roleDef.NodeType) {
		if _, err := s.authz.Create(inst.ID, wf.ID, authz.AnyNode, authz.VerbOperate); err != nil {
			slog.Warn("workflows: rearmStandby: failed to provision service-token role binding", "workflow", wf.ID, "instance", inst.ID, "error", err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), registrationTimeout.Load())
	node, err := s.awaitFreshRegistration(ctx, inst.ID, "")
	cancel()
	abort := func(reason string) {
		s.fenceInstance(workflowID, inst.ID)
		fail(reason)
	}
	if err != nil {
		abort("registration-timeout")
		return
	}
	fresh, ok := s.stillBacks(workflowID, primaryRole, promoted.InstanceID)
	if !ok || fresh.Runtime[standbyRole].InstanceID != promoted.InstanceID {
		abort("superseded")
		return
	}
	p := fresh.Runtime[primaryRole]
	p.StandbyActive = false
	fresh.Runtime[primaryRole] = p
	sb := RoleRuntime{InstanceID: inst.ID, NodeID: node.ID, HostID: res.HostID}
	if seed != standbyRole {
		sb.SeedRole = seed
	}
	fresh.Runtime[standbyRole] = sb
	fresh.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(fresh); err != nil {
		abort("commit-failed")
		return
	}
	s.publish(fresh)
	s.publishStandbyEvent(standbyEvent{WorkflowID: workflowID, Role: primaryRole, StandbyRole: standbyRole, InstanceID: inst.ID, HostID: res.HostID, Status: "rearmed", At: time.Now()})
	slog.Info("workflows: standby re-established", "workflow", workflowID, "role", primaryRole, "standbyRole", standbyRole, "instance", inst.ID, "host", res.HostID)
}

// roleBaseEnv baut die Start-Umgebung einer Rolle ohne Seed und Zustandsschlüssel: Programmformat des Workflows,
// Rollenformat, Hooks der Module.
func (s *Service) roleBaseEnv(wf Workflow, roleDef Role) map[string]string {
	env := map[string]string{}
	for k, v := range formatExtraEnv(wf.Definition.Settings.ProgramFormat) {
		env[k] = v
	}
	for k, v := range formatExtraEnv(roleDef.Format) {
		env[k] = v
	}
	out := s.withRoleHooks(env, wf.Definition, roleDef)
	if out == nil {
		out = map[string]string{}
	}
	return out
}
