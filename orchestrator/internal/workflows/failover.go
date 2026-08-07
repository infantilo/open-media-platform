// K7 Teil 4 — Hot-Standby (docs/END-GOAL-FEATURES.md §7.4/§7.7,
// UMSETZUNG.md §7): automatischer Cross-Host-Failover für Rollen mit einer
// warmen Standby-Rolle (Role.StandbyFor, s. types.go). Zwei Auslöser:
//
//  1. Crash-Loop erschöpft (launcher.FailoverObserver.InstanceGaveUp) —
//     der Launcher hat die bestehende Crash-Loop-Bremse gezogen
//     (maxCrashRestarts=5/crashRestartWindow=60s, launcher.go) und startet
//     die Instanz nicht mehr automatisch neu (§7.5 Punkt 2: dieselbe
//     Schwelle wird als Failover-Trigger wiederverwendet, keine neue
//     Konfiguration).
//  2. Host komplett offline (RunFailoverWatcher-Ticker) — die Host-
//     Telemetrie (hosts.Tracker) ist seit hostOfflineTimeout ausgeblieben,
//     ein reiner Prozess-Crash-Loop würde diesen Fall NIE melden (der
//     Host-Agent selbst ist ja weg, es gibt kein NATS-Exit-Event).
//
// Die eigentliche Übernahme (promoteStandby) ist strukturell dieselbe
// Operation wie rewireAfterRestart (service.go, K7-Teil-1-Rewiring) — eine
// Rolle bekommt eine neue Instanz/Node-ID, alle ihre Connections werden
// neu angewendet, Runtime persistiert, SSE publiziert. Der einzige
// Unterschied: die "neue" Instanz ist die bereits laufende, warme
// Standby-Instanz statt einer frisch neu gestarteten derselben Rolle, und
// zusätzlich wird der zuletzt erfasste Bedienzustand (state.go) auf sie
// übertragen — "warm-unabonniert" bedeutet, die Standby-Node hat selbst
// noch keinen eigenen Bedienzustand, s. §7.7 ("kein Command-Mirroring,
// importiert nur den Bedienzustand bei Übernahme").
package workflows

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/safego"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// hostOfflineTimeout: 4× der Host-Agent-Telemetriefrequenz (5s,
// host-agent/main.go telemetryInterval, s. placement.EvaluateInterval-
// Doku) — toleriert bis zu drei aufeinanderfolgende verpasste
// Telemetrie-Sendungen, bevor ein Host als komplett ausgefallen gilt
// (analog der Begründung von orchestrator/main.go healthStaleAfter für
// Node-Health, dort mit anderer Quelle/anderem Schwellwert).
const hostOfflineTimeout = 20 * time.Second

// failoverCheckInterval ist der Takt des RunFailoverWatcher-Tickers —
// gleich placement.EvaluateInterval (5s), aus demselben Grund: selten
// genug, um nicht unnötig zu pollen, oft genug, um einen Host-Ausfall
// zeitnah (< hostOfflineTimeout + eine Taktlänge) zu erkennen.
const failoverCheckInterval = 5 * time.Second

// HostMetricsReader ist die von Service für die Host-Offline-Erkennung
// genutzte Teilmenge von *hosts.Tracker (gleiches Interface-Entkopplungs-
// Muster wie NodeLister/Launcher/EventPublisher/ResourcePrecheck) —
// implementiert vom bereits in main.go existierenden hostMetricsTracker.
type HostMetricsReader interface {
	Get(hostID string) (hosts.Metrics, bool)
}

// SetHostMetrics verdrahtet den Host-Telemetrie-Reader nach dem
// Konstruieren (main.go: hostMetricsTracker existiert unabhängig vom
// workflows.Service, gleiches Nachträglich-Verdrahtungsmuster wie
// launcher.SetRestartObserver/SetFailoverObserver). Nicht
// nebenläufigkeitsgeschützt — vor dem ersten RunFailoverWatcher-Tick
// verdrahten, wie die übrigen main.go-Service-Verkabelungen auch.
func (s *Service) SetHostMetrics(m HostMetricsReader) {
	s.hostMetrics = m
}

// failoverEvent ist der Payload des "workflow.failover"-SSE-Events.
type failoverEvent struct {
	WorkflowID     string    `json:"workflowId"`
	Role           string    `json:"role"`
	FromInstanceID string    `json:"fromInstanceId"`
	ToInstanceID   string    `json:"toInstanceId"`
	Trigger        string    `json:"trigger"` // "crash-loop" oder "host-offline"
	At             time.Time `json:"at"`
}

func (s *Service) publishFailover(ev failoverEvent) {
	if s.events == nil {
		return
	}
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	s.events.Broadcast(sse.Event{Type: "workflow.failover", Data: data})
}

// InstanceGaveUp implementiert launcher.FailoverObserver (Trigger 1) — der
// Launcher hat instanceID endgültig aufgegeben (Crash-Loop-Bremse
// gezogen). Best effort/asynchron, gleiches Muster wie InstanceRestarted/
// rewireAfterRestart: kein Standby für die betroffene Rolle ist kein
// Fehlerfall, nur der bestehende K7-Teil-1-Zustand ("crashed, wartet auf
// Bediener") bleibt unverändert bestehen.
func (s *Service) InstanceGaveUp(instanceID string) {
	safego.Go("workflows.tryPromoteForInstance", func() { s.tryPromoteForInstance(instanceID, "crash-loop") })
}

func (s *Service) tryPromoteForInstance(instanceID, trigger string) {
	wf, role, ok := s.findStartedRoleForInstance(instanceID)
	if !ok {
		return
	}
	standbyRole := s.standbyRoleFor(wf, role)
	if standbyRole == "" {
		return
	}
	s.promoteStandby(wf, role, standbyRole, trigger)
}

// findStartedRoleForInstance sucht wie rewireAfterRestart (service.go) den
// laufenden Workflow+Rolle, deren aktuelle Runtime-InstanceID instanceID
// ist.
func (s *Service) findStartedRoleForInstance(instanceID string) (Workflow, string, bool) {
	wfs, err := s.store.List()
	if err != nil {
		slog.Warn("workflows: findStartedRoleForInstance: list failed", "error", err)
		return Workflow{}, "", false
	}
	for _, wf := range wfs {
		if wf.Status != StatusStarted {
			continue
		}
		for role, rt := range wf.Runtime {
			if rt.InstanceID == instanceID {
				return wf, role, true
			}
		}
	}
	return Workflow{}, "", false
}

// standbyRoleFor liefert den Namen der Rolle mit StandbyFor == primaryRole
// in wf, falls vorhanden (validate() in service.go garantiert höchstens
// eine).
func (s *Service) standbyRoleFor(wf Workflow, primaryRole string) string {
	for _, r := range wf.Definition.Roles {
		if r.StandbyFor == primaryRole {
			return r.Name
		}
	}
	return ""
}

// promoteStandby lässt die Standby-Rolle standbyRole die Rolle primaryRole
// übernehmen. Lädt den Workflow frisch aus dem Store (wie
// rewireAfterRestart — zwischen Trigger-Erkennung und hier könnte der
// Workflow bereits gestoppt oder die Übernahme bereits durch den jeweils
// anderen Trigger erfolgt sein, s. Idempotenz-Check unten).
func (s *Service) promoteStandby(wf Workflow, primaryRole, standbyRole, trigger string) {
	fresh, err := s.store.Get(wf.ID)
	if err != nil {
		slog.Warn("workflows: promoteStandby: reload failed", "workflow", wf.ID, "error", err)
		return
	}
	if fresh.Status != StatusStarted {
		return
	}
	wf = fresh

	standbyRuntime, ok := wf.Runtime[standbyRole]
	if !ok || standbyRuntime.InstanceID == "" {
		slog.Warn("workflows: promoteStandby: standby role not registered", "workflow", wf.ID, "role", standbyRole)
		return
	}
	primaryRuntime := wf.Runtime[primaryRole]
	if primaryRuntime.InstanceID == standbyRuntime.InstanceID {
		// Bereits übernommen — Idempotenz, falls Crash-Loop- und
		// Host-Offline-Trigger kurz hintereinander für dieselbe Rolle
		// feuern.
		return
	}
	if _, ok := s.nodeForRole(wf, standbyRole); !ok {
		slog.Warn("workflows: promoteStandby: standby node not resolved in registry", "workflow", wf.ID, "role", standbyRole)
		return
	}

	fromInstanceID := primaryRuntime.InstanceID

	wf.Runtime[primaryRole] = RoleRuntime{
		InstanceID:    standbyRuntime.InstanceID,
		NodeID:        standbyRuntime.NodeID,
		HostID:        standbyRuntime.HostID,
		StandbyActive: true,
	}

	// Übernahme SOFORT committen, bevor der langsame Teil (State-Restore,
	// Connections) beginnt — live gefunden (Hot-Standby-Live-Test): ohne
	// diesen frühen Zwischen-Persist gäbe es unten nichts, wogegen die
	// Freshness-Re-Checks (stillBacks) sinnvoll prüfen könnten — die DB
	// zeigte noch die ALTE (gecrashte) InstanceID, ein Check gegen
	// standbyRuntime.InstanceID schlug dadurch schon beim allerersten
	// Connection-Versuch fehl und brach die eigene, gerade erst begonnene
	// Übernahme sofort wieder ab. Dieser frühe Commit macht die neue
	// Zuordnung zur DB-Wahrheit, GENAU wie ein normaler Restart-Zyklus
	// (rewireAfterRestart) seine InstanceID von Anfang an unverändert
	// lässt — ab hier gilt für stillBacks dieselbe Grundannahme.
	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: promoteStandby: early commit failed", "workflow", wf.ID, "error", err)
		return
	}
	s.publish(wf)

	// Zuletzt erfassten Bedienzustand übertragen, BEVOR die Connections
	// neu angewendet werden — restoreOneRoleState (state.go) löst
	// role:<primaryRole>:sender:<index>-Aliase gegen die gerade oben
	// aktualisierte Runtime auf, muss also nach der Runtime-Mutation
	// laufen, um auf die STANDBY-Node statt der toten Primär-Node zu
	// zeigen. §7.7: "importiert nur den Bedienzustand" — kein Frame-Sync.
	if saved, err := s.store.GetRoleState(wf.ID); err != nil {
		slog.Warn("workflows: promoteStandby: load role state failed", "workflow", wf.ID, "error", err)
	} else if raw, ok := saved[primaryRole]; ok {
		if err := s.restoreOneRoleState(wf, primaryRole, raw); err != nil {
			slog.Warn("workflows: promoteStandby: state restore failed", "workflow", wf.ID, "role", primaryRole, "error", err)
		}
	}

	// Alle Connections der Primärrolle neu anwenden — identisch zu
	// rewireAfterRestart, deckt sowohl IS-05-Connect als auch
	// Crosspoint-Methodenruf ab (beide Fälle laufen durch applyConnection).
	for _, conn := range wf.Definition.Connections {
		if conn.FromRole != primaryRole && conn.ToRole != primaryRole {
			continue
		}

		// Freshness-Re-Check pro Verbindung — gleicher Grund/gleiches
		// Live-Fund-Muster wie rewireAfterRestart.stillBacks (service.go,
		// dortige ausführliche Doku): die vorige applyConnection dieser
		// Schleife kann selbst mehrere Sekunden dauern, währenddessen
		// könnte eine noch neuere Übernahme (z. B. der jeweils andere
		// Trigger, Crash-Loop vs. Host-Offline, kurz hintereinander) diese
		// Rolle bereits erneut überholt haben.
		if _, ok := s.stillBacks(wf.ID, primaryRole, standbyRuntime.InstanceID); !ok {
			slog.Info("workflows: promoteStandby: role superseded mid-reconnect, aborting remaining connections",
				"workflow", wf.ID, "role", primaryRole, "instance", standbyRuntime.InstanceID)
			return
		}

		fromNode, ok := s.nodeForRole(wf, conn.FromRole)
		if !ok {
			slog.Warn("workflows: promoteStandby: sender role not ready", "workflow", wf.ID, "connection", conn)
			continue
		}
		toNode, ok := s.nodeForRole(wf, conn.ToRole)
		if !ok {
			slog.Warn("workflows: promoteStandby: receiver role not ready", "workflow", wf.ID, "connection", conn)
			continue
		}
		connectCtx, connectCancel := context.WithTimeout(context.Background(), registrationTimeout)
		err := s.applyConnection(connectCtx, conn, fromNode, toNode, roleNodeType(wf, conn.ToRole))
		connectCancel()
		if err != nil {
			slog.Warn("workflows: promoteStandby: reconnect failed", "workflow", wf.ID, "connection", conn, "error", err)
		}
	}

	// Runtime ist bereits committet (s. früher Persist oben) — hier nur
	// noch das erklärende "workflow.failover"-Event, best effort
	// übersprungen, falls diese Übernahme inzwischen selbst schon wieder
	// überholt wurde (kein doppelt-irreführender Toast in der UI).
	if _, ok := s.stillBacks(wf.ID, primaryRole, standbyRuntime.InstanceID); !ok {
		return
	}
	s.publishFailover(failoverEvent{
		WorkflowID:     wf.ID,
		Role:           primaryRole,
		FromInstanceID: fromInstanceID,
		ToInstanceID:   standbyRuntime.InstanceID,
		Trigger:        trigger,
		At:             time.Now(),
	})
	slog.Info("workflows: standby promoted", "workflow", wf.ID, "role", primaryRole, "standbyRole", standbyRole, "trigger", trigger)
}

// RunFailoverWatcher läuft bis ctx endet, im failoverCheckInterval-Takt
// (main.go: eigene Goroutine, gleiches Muster wie placement.Engine.Run).
// Deckt pro Tick zwei Dinge ab, für jede Primärrolle MIT einer
// Standby-Rolle: (1) periodische Bedienzustands-Erfassung
// (captureOneRoleState, state.go) — ohne diese liefe promoteStandby beim
// Host-Offline-Trigger auf einen veralteten oder gar keinen Zustand,
// selbst wenn ein Stop nie erfolgte (captureRoleState lief bisher nur
// dort); (2) Host-Offline-Erkennung (Trigger 2). Beide Teile sind
// bewusst auf Rollen MIT Standby beschränkt — kein unnötiger /state-
// Overhead bzw. keine unnötige Telemetrie-Auswertung für redundanzlose
// Rollen (gleiche "kein Overhead ohne Bedarf"-Linie wie Kapitel 14s
// Profil-Sampling).
func (s *Service) RunFailoverWatcher(ctx context.Context) {
	ticker := time.NewTicker(failoverCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.failoverTick()
		}
	}
}

func (s *Service) failoverTick() {
	wfs, err := s.store.List()
	if err != nil {
		slog.Warn("workflows: failoverTick: list failed", "error", err)
		return
	}
	for _, wf := range wfs {
		if wf.Status != StatusStarted {
			continue
		}
		var senderToAlias map[string]string
		for _, role := range wf.Definition.Roles {
			standbyRole := s.standbyRoleFor(wf, role.Name)
			if standbyRole == "" {
				continue
			}
			if senderToAlias == nil {
				senderToAlias = s.buildSenderAliasIndex(wf)
			}
			s.captureOneRoleState(wf, role.Name, senderToAlias)
			s.checkHostOffline(wf, role.Name, standbyRole)
		}
	}
}

// checkHostOffline implementiert Trigger 2. rt.HostID=="" (lokal beim
// Orchestrator gestartet) wird übersprungen — der Orchestrator misst sich
// selbst nicht, gleiche Scope-Grenze wie placement.Engine.SelectHost
// (dortige Doku: "lokale Host-eigene Last fließt NICHT ein"). Bereits
// übernommene Rollen (StandbyActive) werden ebenfalls übersprungen —
// sonst würde ein dauerhaft offline bleibender ursprünglicher Host bei
// jedem Tick erneut (erfolglos, da bereits derselbe Standby) zu
// promoteStandby führen.
func (s *Service) checkHostOffline(wf Workflow, primaryRole, standbyRole string) {
	if s.hostMetrics == nil {
		return
	}
	rt, ok := wf.Runtime[primaryRole]
	if !ok || rt.HostID == "" || rt.StandbyActive {
		return
	}
	m, ok := s.hostMetrics.Get(rt.HostID)
	if !ok || time.Since(m.ReceivedAt) < hostOfflineTimeout {
		return
	}
	slog.Warn("workflows: host offline, triggering failover",
		"workflow", wf.ID, "role", primaryRole, "host", rt.HostID, "lastSeen", m.ReceivedAt)
	safego.Go("workflows.promoteStandby", func() { s.promoteStandby(wf, primaryRole, standbyRole, "host-offline") })
}
