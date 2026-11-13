// D6 Teil 4 — Automatisierte Placement-Eskalation (ARCHITECTURE.md §6.1
// Erweiterung 2026-07-13 Punkt 2, README "Offen"-Punkt 1: "automatische
// (statt nur ratschlagende) Placement-Entscheidungen"). Die Placement-
// Engine (internal/placement) erkennt überlastete Hosts und schlägt
// einen gesunden Ausweichhost vor, führt aber selbst nichts aus (s.
// dortiger Paketkommentar) — dieser Teil implementiert die Ausführung,
// pro Workflow-Rolle konfigurierbar über Role.Placement.Escalation:
//
//   - "advisory" (Default): keine Aktion, unverändertes Vor-D6-Teil-4-
//     Verhalten.
//   - "auto-confirm-window": ein Timer läuft an (SSE
//     "workflow.migration", Status "pending"); läuft er ab ODER wird er
//     per ConfirmMigration bestätigt, folgt echtes Make-before-break;
//     CancelMigration verwirft ihn ersatzlos.
//   - "auto": Make-before-break sofort, kein Timer.
//
// Strukturell eng an failover.go (K7 Teil 4, Hot-Standby) angelehnt —
// "neue Instanz/Node-ID für eine Rolle, Zustand überträgt sich,
// Connections neu anwenden, vor JEDEM Seiteneffekt erneut prüfen, ob
// die Rolle zwischenzeitlich überholt wurde" ist dieselbe Mechanik.
// Der Unterschied: failover.go übernimmt eine bereits laufende warme
// Standby-Instanz (die alte ist bereits tot), executeMigration hier
// startet eine FRISCHE Instanz auf dem Zielhost, während die alte noch
// lebt, und stoppt die alte erst nach erfolgreicher Umschaltung — das
// eigentliche Make-before-break-Protokoll aus §6.1 Punkt 3.
package workflows

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/safego"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// migrationRetryCooldown begrenzt, wie oft ein fehlgeschlagener oder
// abgebrochener Migrationsversuch für dieselbe (evtl. weiterhin
// überlastete) Instanz erneut versucht wird — ohne dieses Intervall
// würde ein dauerhaft nicht erreichbarer Zielhost bei jedem
// placement.EvaluateInterval-Tick (5s) einen neuen Versuch auslösen.
const migrationRetryCooldown = 60 * time.Second

// ErrNoPendingMigration wird von ConfirmMigration/CancelMigration
// geliefert, wenn für (workflowID, role) gerade kein
// auto-confirm-window-Timer läuft (bereits abgelaufen/bestätigt/
// abgebrochen, oder es gab nie einen).
var ErrNoPendingMigration = errors.New("workflows: no pending migration for this role")

// migrationState hält die nebenläufigkeitsgeschützte Buchführung für D6
// Teil 4 — separat von Service selbst initialisiert (newMigrationState),
// weil NewService (service.go) mehrere Konstruktor-Aufrufer hat (u. a.
// Tests) und dieses Feld additiv ist.
type migrationState struct {
	mu sync.Mutex
	// migratingInstances: instanceID -> "wird gerade betrachtet/
	// ausgeführt" — verhindert, dass zwei aufeinanderfolgende
	// evaluateOnce-Ticks (placement.EvaluateInterval) für dieselbe noch
	// überlastete Instanz parallel zwei Migrationsversuche anstoßen.
	migratingInstances map[string]bool
	// migrationCooldown: instanceID -> frühester Zeitpunkt für einen
	// erneuten Versuch (s. migrationRetryCooldown-Doku).
	migrationCooldown map[string]time.Time
	// pendingMigrations: "<workflowID>|<role>" -> laufender
	// auto-confirm-window-Timer.
	pendingMigrations map[string]*pendingMigration
}

func newMigrationState() *migrationState {
	return &migrationState{
		migratingInstances: map[string]bool{},
		migrationCooldown:  map[string]time.Time{},
		pendingMigrations:  map[string]*pendingMigration{},
	}
}

type pendingMigration struct {
	workflowID      string
	role            string
	instanceID      string
	hostID          string // der überlastete Quellhost (für OnAdviceCleared-Abgleich)
	targetHostID    string
	targetHostLabel string
	deadline        time.Time
	timer           *time.Timer
}

// migrationEvent ist der Payload des "workflow.migration"-SSE-Events —
// analog zu failoverEvent (failover.go), aber mit zusätzlichem
// Pending/Executing/Done/Failed/Cancelled-Status statt einem
// einmaligen Ereignis, weil auto-confirm-window mehrere sichtbare
// Zwischenzustände hat.
type migrationEvent struct {
	WorkflowID      string    `json:"workflowId"`
	Role            string    `json:"role"`
	FromInstanceID  string    `json:"fromInstanceId,omitempty"`
	ToInstanceID    string    `json:"toInstanceId,omitempty"`
	TargetHostID    string    `json:"targetHostId,omitempty"`
	TargetHostLabel string    `json:"targetHostLabel,omitempty"`
	Reason          string    `json:"reason"` // "overload" / "overload-confirmed" / "overload-confirm-window-expired" / "cancelled" / "host-recovered"
	Status          string    `json:"status"` // "pending" / "executing" / "done" / "failed" / "cancelled"
	DeadlineAt      time.Time `json:"deadlineAt,omitempty"`
	At              time.Time `json:"at"`
}

func (s *Service) publishMigrationEvent(ev migrationEvent) {
	if s.events == nil {
		return
	}
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	s.events.Broadcast(sse.Event{Type: "workflow.migration", Data: data})
}

// PendingMigrationView ist der öffentliche Read-Only-Blick auf einen
// laufenden auto-confirm-window-Countdown (GET
// /api/v1/placement/migrations) — für UI-Clients, die beim Laden noch
// keine SSE-Historie haben.
type PendingMigrationView struct {
	WorkflowID      string    `json:"workflowId"`
	Role            string    `json:"role"`
	TargetHostID    string    `json:"targetHostId"`
	TargetHostLabel string    `json:"targetHostLabel"`
	DeadlineAt      time.Time `json:"deadlineAt"`
}

// PendingMigrations liefert alle aktuell laufenden auto-confirm-window-
// Countdowns, nach (WorkflowID, Role) sortiert (stabile Reihenfolge für
// die API-Antwort, kein Map-Iterations-Jitter — gleiches Muster wie
// placement.Engine.List).
func (s *Service) PendingMigrations() []PendingMigrationView {
	s.migrations.mu.Lock()
	defer s.migrations.mu.Unlock()
	out := make([]PendingMigrationView, 0, len(s.migrations.pendingMigrations))
	for _, pm := range s.migrations.pendingMigrations {
		out = append(out, PendingMigrationView{
			WorkflowID:      pm.workflowID,
			Role:            pm.role,
			TargetHostID:    pm.targetHostID,
			TargetHostLabel: pm.targetHostLabel,
			DeadlineAt:      pm.deadline,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].WorkflowID != out[j].WorkflowID {
			return out[i].WorkflowID < out[j].WorkflowID
		}
		return out[i].Role < out[j].Role
	})
	return out
}

// OnAdviceRaised implementiert placement.AdviceObserver — von
// placement.Engine SYNCHRON aus evaluateOnce aufgerufen (selbes
// Goroutine wie der Run()-Ticker), muss deshalb schnell zurückkehren:
// nur die günstige, rein speicherbasierte Zuteilungsprüfung
// (claimMigrationAttempt) läuft hier direkt, die eigentliche Arbeit
// (Store-Lookups, Instanz-Start) läuft in einer eigenen Goroutine
// (considerMigration) — gleiches Async-Muster wie
// failover.go:InstanceGaveUp.
func (s *Service) OnAdviceRaised(a placement.Advice) {
	if a.SuggestedHostID == "" {
		return // kein gesunder Ausweichhost gefunden — bleibt advisory-only, s. placement.Advice-Doku ("nicht migrierbar", kein stiller Fallback)
	}
	for _, instanceID := range a.InstanceIDs {
		if !s.claimMigrationAttempt(instanceID) {
			continue
		}
		safego.Go("workflows.considerMigration", func() {
			s.considerMigration(instanceID, a.HostID, a.SuggestedHostID, a.SuggestedHostLabel)
		})
	}
}

// OnAdviceCleared implementiert placement.AdviceObserver: hostID ist
// nicht mehr überlastet — ein für diesen Host noch laufender
// auto-confirm-window-Timer wird verworfen (der Auslöser besteht nicht
// mehr), OHNE Cooldown (der Alarm ist echt weg, keine Unterdrückung
// eines legitimen künftigen Alarms nötig).
func (s *Service) OnAdviceCleared(hostID string) {
	s.migrations.mu.Lock()
	var cleared []*pendingMigration
	for key, pm := range s.migrations.pendingMigrations {
		if pm.hostID != hostID {
			continue
		}
		pm.timer.Stop()
		delete(s.migrations.pendingMigrations, key)
		cleared = append(cleared, pm)
	}
	s.migrations.mu.Unlock()

	for _, pm := range cleared {
		s.releaseMigrationClaim(pm.instanceID)
		s.publishMigrationEvent(migrationEvent{
			WorkflowID: pm.workflowID, Role: pm.role,
			TargetHostID: pm.targetHostID, TargetHostLabel: pm.targetHostLabel,
			Reason: "host-recovered", Status: "cancelled", At: time.Now(),
		})
		slog.Info("workflows: placement migration cancelled, host no longer overloaded",
			"workflow", pm.workflowID, "role", pm.role, "host", hostID)
	}
}

// claimMigrationAttempt reserviert instanceID für einen Migrations-
// Versuch — false, wenn bereits ein Versuch läuft, ein
// auto-confirm-window-Timer für diese Instanz existiert, oder die
// Cooldown-Frist eines vorherigen Fehlschlags noch nicht abgelaufen ist.
func (s *Service) claimMigrationAttempt(instanceID string) bool {
	s.migrations.mu.Lock()
	defer s.migrations.mu.Unlock()
	if s.migrations.migratingInstances[instanceID] {
		return false
	}
	if until, ok := s.migrations.migrationCooldown[instanceID]; ok && time.Now().Before(until) {
		return false
	}
	for _, pm := range s.migrations.pendingMigrations {
		if pm.instanceID == instanceID {
			return false
		}
	}
	s.migrations.migratingInstances[instanceID] = true
	return true
}

func (s *Service) releaseMigrationClaim(instanceID string) {
	s.migrations.mu.Lock()
	delete(s.migrations.migratingInstances, instanceID)
	s.migrations.mu.Unlock()
}

// finishMigrationAttempt beendet einen Versuch (erfolgreich, fehlgeschlagen
// oder manuell abgebrochen) und setzt die Cooldown-Frist für ein erneutes
// automatisches Auslösen — s. migrationRetryCooldown-Doku.
func (s *Service) finishMigrationAttempt(instanceID string) {
	s.migrations.mu.Lock()
	delete(s.migrations.migratingInstances, instanceID)
	s.migrations.migrationCooldown[instanceID] = time.Now().Add(migrationRetryCooldown)
	s.migrations.mu.Unlock()
}

// considerMigration löst instanceID auf eine (Workflow, Rolle) auf und
// verzweigt nach deren Role.Placement.Escalation. instanceID ohne
// laufenden Workflow (z. B. gerade gestoppt) oder unbekannte Rolle:
// Zuteilung wird wieder freigegeben, kein Fehlerfall.
func (s *Service) considerMigration(instanceID, sourceHostID, targetHostID, targetHostLabel string) {
	wf, role, ok := s.findStartedRoleForInstance(instanceID)
	if !ok {
		s.releaseMigrationClaim(instanceID)
		return
	}
	r, ok := roleByName(wf, role)
	if !ok {
		s.releaseMigrationClaim(instanceID)
		return
	}
	if s.roleHostBound(r) { // Hardware-/Host-Bindung: nie automatisch umziehen, nur Alarm
		s.releaseMigrationClaim(instanceID)
		return
	}
	if target, ok := s.groupMigrationTarget(wf, role, sourceHostID); ok {
		if target == sourceHostID { // der beste Platz für den Verbund bleibt der aktuelle: kein Umzug
			s.releaseMigrationClaim(instanceID)
			return
		}
		if target != targetHostID {
			targetHostID, targetHostLabel = target, target
		}
	}
	switch r.PlacementEscalation() {
	case EscalationAuto:
		s.executeMigration(wf.ID, role, instanceID, targetHostID, "overload")
	case EscalationAutoConfirmWindow:
		s.scheduleConfirmWindowMigration(wf.ID, role, instanceID, sourceHostID, targetHostID, targetHostLabel, r.PlacementConfirmWindowSeconds())
	default: // EscalationAdvisory
		s.releaseMigrationClaim(instanceID)
	}
}

// scheduleConfirmWindowMigration startet den Bestätigungs-Timer. Die
// Migrations-Zuteilung (claimMigrationAttempt) bleibt für die gesamte
// Wartezeit gehalten — erst firePendingMigration/ConfirmMigration/
// CancelMigration geben sie wieder frei.
func (s *Service) scheduleConfirmWindowMigration(workflowID, role, instanceID, sourceHostID, targetHostID, targetHostLabel string, windowSeconds int) {
	if windowSeconds <= 0 {
		windowSeconds = DefaultConfirmWindowSeconds
	}
	window := time.Duration(windowSeconds) * time.Second
	deadline := time.Now().Add(window)
	key := workflowID + "|" + role

	pm := &pendingMigration{
		workflowID: workflowID, role: role, instanceID: instanceID,
		hostID: sourceHostID, targetHostID: targetHostID, targetHostLabel: targetHostLabel,
		deadline: deadline,
	}
	pm.timer = time.AfterFunc(window, func() { s.firePendingMigration(key) })

	s.migrations.mu.Lock()
	s.migrations.pendingMigrations[key] = pm
	s.migrations.mu.Unlock()

	s.publishMigrationEvent(migrationEvent{
		WorkflowID: workflowID, Role: role,
		TargetHostID: targetHostID, TargetHostLabel: targetHostLabel,
		Reason: "overload", Status: "pending", DeadlineAt: deadline, At: time.Now(),
	})
	slog.Info("workflows: placement migration pending confirmation",
		"workflow", workflowID, "role", role, "targetHost", targetHostID, "deadline", deadline)
}

func (s *Service) firePendingMigration(key string) {
	s.migrations.mu.Lock()
	pm, ok := s.migrations.pendingMigrations[key]
	if ok {
		delete(s.migrations.pendingMigrations, key)
	}
	s.migrations.mu.Unlock()
	if !ok {
		return // bereits durch ConfirmMigration/CancelMigration entfernt
	}
	s.executeMigration(pm.workflowID, pm.role, pm.instanceID, pm.targetHostID, "overload-confirm-window-expired")
}

// ConfirmMigration führt einen laufenden auto-confirm-window-Countdown
// sofort aus (Bedienereingriff "jetzt ausführen") statt auf den Ablauf
// zu warten — asynchron wie Start()/Stop(), liefert also selbst keinen
// Ausführungs-Erfolg zurück, nur dass die Ausführung angestoßen wurde.
func (s *Service) ConfirmMigration(workflowID, role string) error {
	pm, ok := s.takePendingMigration(workflowID, role)
	if !ok {
		return ErrNoPendingMigration
	}
	safego.Go("workflows.executeMigration", func() {
		s.executeMigration(pm.workflowID, pm.role, pm.instanceID, pm.targetHostID, "overload-confirmed")
	})
	return nil
}

// CancelMigration verwirft einen laufenden auto-confirm-window-Countdown
// ersatzlos — die alte Instanz bleibt unangetastet. Setzt eine Cooldown-
// Frist (finishMigrationAttempt), damit der nächste
// placement.EvaluateInterval-Tick (die Überlast besteht ja i. d. R.
// unmittelbar danach fort) nicht sofort einen neuen Timer aufsetzt und
// die Bedienerentscheidung faktisch ignoriert.
func (s *Service) CancelMigration(workflowID, role string) error {
	pm, ok := s.takePendingMigration(workflowID, role)
	if !ok {
		return ErrNoPendingMigration
	}
	s.finishMigrationAttempt(pm.instanceID)
	s.publishMigrationEvent(migrationEvent{
		WorkflowID: workflowID, Role: role,
		TargetHostID: pm.targetHostID, TargetHostLabel: pm.targetHostLabel,
		Reason: "cancelled", Status: "cancelled", At: time.Now(),
	})
	slog.Info("workflows: placement migration cancelled by operator", "workflow", workflowID, "role", role)
	return nil
}

func (s *Service) takePendingMigration(workflowID, role string) (*pendingMigration, bool) {
	key := workflowID + "|" + role
	s.migrations.mu.Lock()
	defer s.migrations.mu.Unlock()
	pm, ok := s.migrations.pendingMigrations[key]
	if !ok {
		return nil, false
	}
	pm.timer.Stop()
	delete(s.migrations.pendingMigrations, key)
	return pm, true
}

// MigrateRole (Kapitel 13 Teil 3, docs/END-GOAL-FEATURES.md §13.4:
// "Drag = begleiteter Umzug") — der bedienerausgelöste Anstoßpunkt für
// den Drag-Umzug im Flow-Editor (Host-Ansicht): eine Kachel in eine
// andere Host-Zone gezogen → Bestätigungsdialog im Client → dieser
// Aufruf. Nutzt exakt dasselbe Make-before-break-Protokoll wie der
// automatische D6-Teil-4-Pfad (executeMigration) — der Bediener hat
// bereits explizit entschieden (Bestätigungsdialog), daher kein
// Placement-Escalation-Gate wie bei considerMigration. targetHostID =
// "" bedeutet lokal (gleiche Konvention wie überall sonst,
// launcher.StartLabeled). Asynchron wie RestartRole/Start/Stop:
// liefert selbst nur "angestoßen", nicht "fertig" zurück (per SSE/Poll
// beobachtbar).
func (s *Service) MigrateRole(ctx context.Context, workflowID, role, targetHostID string) error {
	wf, err := s.store.Get(workflowID)
	if err != nil {
		return err
	}
	if wf.Status != StatusStarted {
		return ErrNotRunning
	}
	if _, ok := roleByName(wf, role); !ok {
		return fmt.Errorf("%w: role %q not found", ErrValidation, role)
	}
	rt, ok := wf.Runtime[role]
	if !ok || rt.InstanceID == "" {
		return fmt.Errorf("%w: role %q has no running instance", ErrValidation, role)
	}
	if rt.HostID == targetHostID {
		return fmt.Errorf("%w: role %q is already on the target host", ErrValidation, role)
	}
	if !s.claimMigrationAttempt(rt.InstanceID) {
		return fmt.Errorf("%w: a migration for role %q is already in progress", ErrValidation, role)
	}

	safego.Go("workflows.executeMigration", func() {
		s.executeMigration(wf.ID, role, rt.InstanceID, targetHostID, "manual-drag")
	})
	return nil
}

// executeMigration ist das eigentliche Make-before-break-Protokoll
// (§6.1 Punkt 3): neue Instanz auf targetHostID starten → registrieren
// lassen → Betriebszustand + Connections der Rolle auf sie umziehen →
// ERST DANACH die alte Instanz stoppen. Jeder Seiteneffekt wird per
// stillBacks erneut gegen den aktuellen Store-Stand geprüft (K7-Teil-4-
// Lektion, s. failover.go-Moduldoku: "recheck vor jedem Seiteneffekt,
// nicht nur einmal") — die Rolle könnte zwischenzeitlich durch einen
// K7-Teil-4-Failover, einen manuellen RestartRole oder einen Stop
// überholt worden sein.
//
// Bewusst nicht behandelt (dokumentierte Grenze, gleiche Kategorie wie
// promoteStandbys "role superseded mid-reconnect"-Abbruch): bricht
// executeMigration NACH dem Runtime-Commit (Schritt 5), aber VOR dem
// Teardown der alten Instanz ab, bleibt die alte Instanz als Waise
// laufen (nicht mehr referenziert, nicht gestoppt) — erfordert ein
// zweites, noch selteneres Overtaking-Ereignis im exakt selben
// Zeitfenster, kein regulärer Pfad.
func (s *Service) executeMigration(workflowID, role, oldInstanceID, targetHostID, reason string) {
	s.runMigration(workflowID, role, oldInstanceID, targetHostID, reason, false)
}

// runMigration ist executeMigration mit dem Sonderfall oldLost: der Host der alten Instanz ist ausgefallen
// (hostloss.go). Dann gibt es nichts mehr zu erhalten — der Zustand kommt aus der letzten Sicherung, die neue Instanz
// bekommt den Rollen-Seed (gleiche NMOS-IDs wie die verlorene, Verbraucher finden ihre Quelle von selbst wieder), es
// gibt keinen Rücksprung, und der Stop der alten Instanz wird beim Launcher vorgemerkt, bis ihr Host wieder da ist.
func (s *Service) runMigration(workflowID, role, oldInstanceID, targetHostID, reason string, oldLost bool) {
	defer s.finishMigrationAttempt(oldInstanceID)

	wf, ok := s.stillBacks(workflowID, role, oldInstanceID)
	if !ok {
		slog.Info("workflows: executeMigration: role no longer matches, aborting", "workflow", workflowID, "role", role)
		return
	}
	roleDef, ok := roleByName(wf, role)
	if !ok {
		return
	}
	oldNodeID := wf.Runtime[role].NodeID

	// MXL ist host-lokal: hängt der Node über MXL an Nodes auf einem anderen Host als dem Ziel, bliebe deren Bild nach dem Umzug stehen
	// (und eine nicht in der Workflow-Definition stehende Verbindung wird auch nicht neu aufgebaut). Vor jedem Seiteneffekt prüfen.
	if el, ok := s.graph.(interface{ Edges() []graph.Edge }); ok && s.nodes != nil {
		if ll, ok := s.launcher.(interface{ List() []launcher.Instance }); ok {
			instHost := map[string]string{}
			for _, in := range ll.List() {
				instHost[in.ID] = in.HostID
			}
			// Gegenstellen, die zum selben geplanten Verbund-Umzug gehören, sind kein Konflikt (netplace.go, groupMoves).
			ignore := s.groupPeerInstances(wf)
			if peer, bad := mxlPeerConflict(s.nodes.List(), el.Edges(), instHost, ignore, oldNodeID, targetHostID); bad {
				slog.Warn("workflows: executeMigration: not migrable, MXL peer on another host", "workflow", workflowID, "role", role, "peer", peer, "targetHost", targetHostID)
				s.publishMigrationEvent(migrationEvent{
					WorkflowID: workflowID, Role: role, FromInstanceID: oldInstanceID, TargetHostID: targetHostID,
					Reason: "not-migrable-mxl-peer", Status: "failed", At: time.Now(),
				})
				return
			}
		}
	}

	// D13 (ARCHITECTURE.md §6.1 Erweiterung 2026-07-10 Punkt 3, wörtlich:
	// "gibt es keinen Ersatz-Host mit Karte, ist der ehrliche Befund
	// 'nicht migrierbar' [...], kein stiller Fallback") — VOR jedem
	// Seiteneffekt (noch keine neue Instanz gestartet, kein
	// "executing"-Event) geprüft: braucht die Rolle einen I/O-Port,
	// muss der Zielhost einen passenden freien haben, sonst bricht die
	// Migration hier komplett ab, die alte Instanz bleibt unangetastet.
	// Der neue Claim teilt sich (workflowID, role) mit dem noch aktiven
	// alten — beide koexistieren bis zum erfolgreichen Cutover unten
	// (s. IOPortClaimer-Doku in service.go), deshalb GetClaim/
	// ReleasePort statt des mehrdeutigen Release(workflowID, role).
	var newPortHostID, newPortID string
	var oldPortHostID, oldPortID string
	var hasNewPort, hasOldPort bool
	if roleDef.RequiredIOPort != nil {
		if s.ioPorts == nil {
			slog.Warn("workflows: executeMigration: role needs an io port but no io port inventory is configured, not migrable",
				"workflow", workflowID, "role", role)
			s.publishMigrationEvent(migrationEvent{
				WorkflowID: workflowID, Role: role, FromInstanceID: oldInstanceID, TargetHostID: targetHostID,
				Reason: "not-migrable-no-io-port-inventory", Status: "failed", At: time.Now(),
			})
			return
		}
		// Zuerst den ALTEN Claim festhalten (vor dem neuen Claim
		// unzweideutig, s. Kommentar oben) — fehlt er (z. B. weil das
		// Inventar zwischenzeitlich geändert wurde), ist das kein
		// Abbruchgrund für sich, nur ReleasePort unten entfällt dann.
		if h, p, ok, err := s.ioPorts.GetClaim(workflowID, role); err != nil {
			slog.Warn("workflows: executeMigration: lookup of existing io port claim failed", "workflow", workflowID, "role", role, "error", err)
		} else if ok {
			oldPortHostID, oldPortID, hasOldPort = h, p, true
		}

		claimedHost, claimedPort, ok, err := s.ioPorts.Claim(roleDef.RequiredIOPort.CardType, roleDef.RequiredIOPort.Direction, targetHostID, workflowID, role, "")
		if err != nil {
			slog.Warn("workflows: executeMigration: io port claim on target host failed",
				"workflow", workflowID, "role", role, "targetHost", targetHostID, "error", err)
			s.publishMigrationEvent(migrationEvent{
				WorkflowID: workflowID, Role: role, FromInstanceID: oldInstanceID, TargetHostID: targetHostID,
				Reason: "not-migrable-io-port-claim-error", Status: "failed", At: time.Now(),
			})
			return
		}
		if !ok {
			slog.Info("workflows: executeMigration: not migrable, target host has no free matching io port",
				"workflow", workflowID, "role", role, "targetHost", targetHostID,
				"cardType", roleDef.RequiredIOPort.CardType, "direction", roleDef.RequiredIOPort.Direction)
			s.publishMigrationEvent(migrationEvent{
				WorkflowID: workflowID, Role: role, FromInstanceID: oldInstanceID, TargetHostID: targetHostID,
				Reason: "not-migrable-no-free-io-port", Status: "failed", At: time.Now(),
			})
			return
		}
		newPortHostID, newPortID, hasNewPort = claimedHost, claimedPort, true
	}

	s.publishMigrationEvent(migrationEvent{
		WorkflowID: workflowID, Role: role, FromInstanceID: oldInstanceID, TargetHostID: targetHostID,
		Reason: reason, Status: "executing", At: time.Now(),
	})

	extraEnv := map[string]string{}
	for k, v := range formatExtraEnv(wf.Definition.Settings.ProgramFormat) {
		extraEnv[k] = v
	}
	roleEnv := extraEnv
	if roleFormatEnv := formatExtraEnv(roleDef.Format); roleFormatEnv != nil {
		roleEnv = make(map[string]string, len(extraEnv)+len(roleFormatEnv))
		for k, v := range extraEnv {
			roleEnv[k] = v
		}
		for k, v := range roleFormatEnv {
			roleEnv[k] = v
		}
	}
	roleEnv = s.withRoleHooks(roleEnv, wf.Definition, roleDef)
	if oldLost {
		roleEnv = withRoleSeed(roleEnv, wf.ID, seedRoleName(wf, role))
		roleEnv[launcher.StateKeyEnv] = roleStateKey(wf.ID, roleDef.Name)
	} else {
		roleEnv = withRoleStateKey(roleEnv, wf.ID, roleDef.Name)
	}
	// D13-Fix (2026-08-20, s. ioPortExtraEnv-Doku in ioports.go): ohne
	// dies startet die neue Instanz auf dem Zielhost mit dem eingebauten
	// device-number-Default statt dem hier gerade neu geclaimten Port —
	// derselbe Bug wie in runStart, hier zusätzlich sicherheitsrelevant,
	// weil sonst zwei Instanzen (alte + neue) denselben Port(0) ansprechen
	// könnten, statt den tatsächlich exklusiv reservierten.
	if hasNewPort {
		if portEnv := IoPortExtraEnv(roleDef.RequiredIOPort, newPortID); portEnv != nil {
			merged := make(map[string]string, len(roleEnv)+len(portEnv))
			for k, v := range roleEnv {
				merged[k] = v
			}
			for k, v := range portEnv {
				merged[k] = v
			}
			roleEnv = merged
		}
	}

	// releaseNewPortOnAbort gibt den oben (falls vorhanden) neu
	// geclaimten Port wieder frei — der ALTE Claim bleibt in allen drei
	// Abbruchpfaden unten unangetastet (die alte Instanz läuft ja
	// unverändert weiter).
	releaseNewPortOnAbort := func() {
		if hasNewPort {
			if err := s.ioPorts.ReleasePort(newPortHostID, newPortID); err != nil {
				slog.Warn("workflows: executeMigration: release new io port claim after abort failed", "workflow", workflowID, "role", role, "error", err)
			}
		}
	}

	// Schritt 1: neue Instanz auf dem Zielhost — die alte bleibt
	// unangetastet laufen (der eigentliche Unterschied zu
	// rewireAfterRestart/promoteStandby, wo die alte Instanz bereits
	// tot bzw. bereits eine warme Standby-Instanz ist).
	newInst, err := s.launcher.StartLabeled(roleDef.NodeType, "", targetHostID, roleDef.Name, roleEnv)
	if err != nil {
		slog.Warn("workflows: executeMigration: start on target host failed, keeping old instance",
			"workflow", workflowID, "role", role, "targetHost", targetHostID, "error", err)
		releaseNewPortOnAbort()
		s.publishMigrationEvent(migrationEvent{
			WorkflowID: workflowID, Role: role, FromInstanceID: oldInstanceID, TargetHostID: targetHostID,
			Reason: reason, Status: "failed", At: time.Now(),
		})
		return
	}
	if hasNewPort {
		if err := s.ioPorts.UpdateInstanceID(workflowID, role, newInst.ID); err != nil {
			slog.Warn("workflows: executeMigration: update new io port claim instance id failed", "workflow", workflowID, "role", role, "error", err)
		}
	}
	// Control-Plane-Nodes (Automation, Studio-Logik, ...) holen ihr Service-Token über eine Bindung auf ihre
	// Instanz-ID (s. runStart/runRestartRole). Die neue Instanz hat eine neue ID — ohne eigene Bindung verlöre die
	// Rolle mit dem Umzug ihren Zugriff auf den Proxy und steuerte nichts mehr.
	controlPlane := s.authz != nil && s.IsControlPlaneNodeType(roleDef.NodeType)
	if controlPlane {
		if _, err := s.authz.Create(newInst.ID, workflowID, authz.AnyNode, authz.VerbOperate); err != nil {
			slog.Warn("workflows: executeMigration: failed to provision service-token role binding", "workflow", workflowID, "role", role, "instance", newInst.ID, "error", err)
		}
	}
	dropBinding := func(instanceID string) {
		if !controlPlane {
			return
		}
		if err := s.authz.DeleteInstanceBinding(instanceID, workflowID); err != nil {
			slog.Warn("workflows: executeMigration: failed to clean up instance role binding", "workflow", workflowID, "role", role, "instance", instanceID, "error", err)
		}
	}

	// Umzugs-Journal, Teil 1: die neue Instanz an der (noch gültigen) alten Zuordnung vermerken. Bricht der
	// Orchestrator ab, bevor umgeschaltet ist, wird sie beim nächsten Lauf wieder abgebaut.
	s.journalMigration(workflowID, role, oldInstanceID, func(rt *RoleRuntime) { rt.MigratingTo = newInst.ID })
	clearJournal := func() {
		s.journalMigration(workflowID, role, oldInstanceID, func(rt *RoleRuntime) {
			rt.MigratingTo, rt.MigrationBy, rt.MigrationNonce, rt.MigrationAt = "", "", "", nil
		})
	}

	// Schritt 2: auf ihre Registrierung warten. Mit Rollen-Seed (oldLost) meldet sich die neue Instanz unter der
	// Node-ID der verlorenen an — dort zählt allein die neue Instanz-ID.
	excludeNodeID := oldNodeID
	if oldLost {
		excludeNodeID = ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), registrationTimeout.Load())
	node, err := s.awaitFreshRegistration(ctx, newInst.ID, excludeNodeID)
	cancel()
	if err != nil {
		clearJournal()
		slog.Warn("workflows: executeMigration: new instance failed to register, stopping it and keeping old instance",
			"workflow", workflowID, "role", role, "instance", newInst.ID, "error", err)
		if stopErr := s.launcher.Stop(newInst.ID); stopErr != nil {
			slog.Warn("workflows: executeMigration: cleanup of failed new instance failed", "instance", newInst.ID, "error", stopErr)
		}
		dropBinding(newInst.ID)
		releaseNewPortOnAbort()
		s.publishMigrationEvent(migrationEvent{
			WorkflowID: workflowID, Role: role, FromInstanceID: oldInstanceID, ToInstanceID: newInst.ID, TargetHostID: targetHostID,
			Reason: reason, Status: "failed", At: time.Now(),
		})
		return
	}

	fresh, ok := s.stillBacks(workflowID, role, oldInstanceID)
	if !ok {
		slog.Info("workflows: executeMigration: role superseded before cutover, stopping the now-unneeded extra instance",
			"workflow", workflowID, "role", role)
		releaseNewPortOnAbort()
		if stopErr := s.launcher.Stop(newInst.ID); stopErr != nil {
			slog.Warn("workflows: executeMigration: cleanup after supersede failed", "instance", newInst.ID, "error", stopErr)
		}
		dropBinding(newInst.ID)
		return
	}
	wf = fresh
	oldRuntime := wf.Runtime[role]

	// Schritt 3: Betriebszustand von der noch laufenden ALTEN Instanz
	// erfassen, BEVOR die Runtime unten mutiert wird — restoreOneRoleState
	// löst danach gegen die NEUE Runtime auf (identisches Muster wie
	// promoteStandby, s. dortige Doku). Eine verlorene Instanz antwortet
	// nicht mehr: dort gilt die letzte Sicherung.
	if !oldLost {
		senderToAlias := s.buildSenderAliasIndex(wf)
		s.captureOneRoleState(wf, role, senderToAlias)
	}
	s.markUnrestored(wf.ID, role)

	// Schritt 5 (Teil 1): Runtime auf die neue Instanz umschreiben und
	// sofort committen — macht die neue Zuordnung zur DB-Wahrheit, bevor
	// der langsamere Connections-Teil beginnt (gleicher früher-Commit-
	// Grund wie promoteStandby). Umzugs-Journal, Teil 2: die alte Instanz
	// steht ab jetzt als "noch zu stoppen" an der neuen Zuordnung.
	now := time.Now()
	wf.Runtime[role] = RoleRuntime{
		InstanceID: newInst.ID, NodeID: node.ID, HostID: targetHostID,
		StandbyActive: oldRuntime.StandbyActive, SeedRole: oldRuntime.SeedRole,
		MigratedFrom: &RuntimeRef{InstanceID: oldInstanceID, NodeID: oldRuntime.NodeID, HostID: oldRuntime.HostID},
		MigrationBy:  s.identity, MigrationNonce: s.processNonce(), MigrationAt: &now,
	}
	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		// Die alte Instanz bleibt die gültige Zuordnung (nichts wurde gespeichert): die neue wieder abbauen, statt sie
		// unreferenziert weiterlaufen zu lassen und ihren Port belegt zu halten.
		slog.Warn("workflows: executeMigration: early commit failed, stopping new instance and keeping old one", "workflow", workflowID, "role", role, "error", err)
		if stopErr := s.launcher.Stop(newInst.ID); stopErr != nil {
			slog.Warn("workflows: executeMigration: cleanup after failed commit failed", "instance", newInst.ID, "error", stopErr)
		}
		dropBinding(newInst.ID)
		releaseNewPortOnAbort()
		s.clearUnrestored(workflowID, role)
		clearJournal()
		s.publishMigrationEvent(migrationEvent{
			WorkflowID: workflowID, Role: role, FromInstanceID: oldInstanceID, ToInstanceID: newInst.ID, TargetHostID: targetHostID,
			Reason: reason, Status: "failed", At: time.Now(),
		})
		return
	}
	s.publish(wf)

	if saved, err := s.store.GetRoleState(wf.ID); err != nil {
		slog.Warn("workflows: executeMigration: load role state failed", "workflow", wf.ID, "error", err)
	} else if raw, ok := saved[role]; ok {
		if err := s.restoreOneRoleState(wf, role, raw); err != nil {
			slog.Warn("workflows: executeMigration: state restore failed", "workflow", wf.ID, "role", role, "error", err)
		}
	}

	// Schritt 5 (Teil 2): alle Connections der Rolle neu anwenden —
	// identisch zu promoteStandby/rewireAfterRestart, inkl. Freshness-
	// Re-Check PRO Verbindung (eine einzelne applyConnection kann selbst
	// mehrere Sekunden dauern).
	failedConnections := 0
	for _, conn := range wf.Definition.Connections {
		if conn.FromRole != role && conn.ToRole != role {
			continue
		}
		if _, ok := s.stillBacks(wf.ID, role, newInst.ID); !ok {
			slog.Info("workflows: executeMigration: role superseded mid-reconnect, aborting remaining connections",
				"workflow", wf.ID, "role", role)
			return
		}
		fromNode, ok := s.nodeForRole(wf, conn.FromRole)
		if !ok {
			slog.Warn("workflows: executeMigration: sender role not ready", "workflow", wf.ID, "connection", conn)
			continue
		}
		toNode, ok := s.nodeForRole(wf, conn.ToRole)
		if !ok {
			slog.Warn("workflows: executeMigration: receiver role not ready", "workflow", wf.ID, "connection", conn)
			continue
		}
		connectCtx, connectCancel := context.WithTimeout(context.Background(), registrationTimeout.Load())
		err := s.applyConnection(connectCtx, conn, fromNode, toNode, roleNodeType(wf, conn.ToRole))
		connectCancel()
		if err != nil {
			slog.Warn("workflows: executeMigration: reconnect failed", "workflow", wf.ID, "connection", conn, "error", err)
			failedConnections++
		}
	}

	if _, ok := s.stillBacks(wf.ID, role, newInst.ID); !ok {
		slog.Info("workflows: executeMigration: role superseded before teardown, leaving old instance running",
			"workflow", wf.ID, "role", role)
		return
	}

	// Rücksprung (Kapitel 100 Punkt 6): ließ sich eine Verbindung der Rolle nicht auf die neue Instanz legen, wäre
	// der Umzug ein Signalausfall — die alte Instanz läuft noch und trägt das Signal. Also zurück auf sie, statt
	// sie trotzdem zu stoppen. (Nicht möglich, wenn die alte verloren ist.)
	if failedConnections > 0 && !oldLost {
		slog.Warn("workflows: executeMigration: connections to the new instance failed, rolling back to the old instance",
			"workflow", wf.ID, "role", role, "failed", failedConnections, "newInstance", newInst.ID)
		if s.rollbackMigration(wf.ID, role, oldRuntime, newInst.ID) {
			dropBinding(newInst.ID)
			releaseNewPortOnAbort()
			s.publishMigrationEvent(migrationEvent{
				WorkflowID: wf.ID, Role: role, FromInstanceID: oldInstanceID, ToInstanceID: newInst.ID, TargetHostID: targetHostID,
				Reason: "rolled-back-connection-failed", Status: "failed", At: time.Now(),
			})
		}
		return
	}

	// Schritt 5b: Verbraucher (Viewer, Bildmischer, ...) vollziehen den Quellenwechsel weich — erst wenn sie
	// nachweislich auf die neue Instanz umgeschaltet haben und Bild/Ton laufen, darf die alte stoppen.
	s.awaitHandover(wf, role, oldNodeID, node.ID)
	if _, ok := s.stillBacks(wf.ID, role, newInst.ID); !ok {
		slog.Info("workflows: executeMigration: role superseded during handover, leaving old instance running",
			"workflow", wf.ID, "role", role)
		return
	}

	// Schritt 6: erst JETZT die alte Instanz stoppen — der eigentliche
	// "Break"-Schritt, bewusst zuletzt. Der ALTE I/O-Port-Claim wird
	// erst hier freigegeben (gezielt per ReleasePort, nicht per
	// Release(workflowID, role) — der neue Claim für dasselbe
	// (workflowID, role) muss bestehen bleiben, s. Kommentar oben).
	if err := s.launcher.Stop(oldInstanceID); errors.Is(err, launcher.ErrStopDeferred) {
		slog.Info("workflows: executeMigration: old instance's host is unreachable, stop is deferred until it returns", "workflow", wf.ID, "role", role, "instance", oldInstanceID)
	} else if err != nil && !errors.Is(err, launcher.ErrUnknownInstance) {
		slog.Warn("workflows: executeMigration: stop old instance failed", "workflow", wf.ID, "role", role, "instance", oldInstanceID, "error", err)
	}
	dropBinding(oldInstanceID)
	// Umzugs-Journal schließen: alte Instanz gestoppt (oder ihr Stop beim Launcher vorgemerkt).
	s.journalMigration(wf.ID, role, newInst.ID, func(rt *RoleRuntime) {
		rt.MigratedFrom, rt.MigrationBy, rt.MigrationNonce, rt.MigrationAt = nil, "", "", nil
	})
	if hasOldPort {
		if err := s.ioPorts.ReleasePort(oldPortHostID, oldPortID); err != nil {
			slog.Warn("workflows: executeMigration: release old io port claim failed", "workflow", wf.ID, "role", role, "error", err)
		}
	}

	s.publishMigrationEvent(migrationEvent{
		WorkflowID: wf.ID, Role: role, FromInstanceID: oldInstanceID, ToInstanceID: newInst.ID, TargetHostID: targetHostID,
		Reason: reason, Status: "done", At: time.Now(),
	})
	slog.Info("workflows: placement migration completed",
		"workflow", wf.ID, "role", role, "from", oldInstanceID, "to", newInst.ID, "targetHost", targetHostID)
}

// SetIdentity setzt den Namen dieses Orchestrators für das Umzugs-Journal (main.go: die eigene URL). Vor dem ersten
// Umzug verdrahten.
func (s *Service) SetIdentity(id string) { s.identity = id }

// processNonce unterscheidet Prozessläufe desselben Orchestrators: ein Journal-Eintrag mit eigener Identität, aber
// fremdem Nonce stammt aus einem früheren Lauf und ist damit sicher abgebrochen.
func (s *Service) processNonce() string {
	s.nonceOnce.Do(func() {
		if id, err := newID(); err == nil {
			s.nonce = id
		} else {
			s.nonce = time.Now().Format(time.RFC3339Nano)
		}
	})
	return s.nonce
}

// journalMigration ändert die Journal-Felder der Rolle, solange sie noch von instanceID erfüllt wird (sonst wurde der
// Umzug überholt und der Eintrag ist mit der Zuordnung verschwunden).
func (s *Service) journalMigration(workflowID, role, instanceID string, mutate func(*RoleRuntime)) {
	wf, ok := s.stillBacks(workflowID, role, instanceID)
	if !ok {
		return
	}
	rt := wf.Runtime[role]
	if rt.MigrationBy == "" {
		now := time.Now()
		rt.MigrationBy, rt.MigrationNonce, rt.MigrationAt = s.identity, s.processNonce(), &now
	}
	mutate(&rt)
	wf.Runtime[role] = rt
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: migration journal update failed", "workflow", workflowID, "role", role, "error", err)
	}
}

// rollbackMigration schreibt die Zuordnung der Rolle auf die alte Instanz zurück, legt ihre Verbindungen wieder auf
// sie und stoppt die neue. Liefert false, wenn die Rolle inzwischen überholt wurde (dann bleibt alles, wie es ist).
func (s *Service) rollbackMigration(workflowID, role string, oldRuntime RoleRuntime, newInstanceID string) bool {
	wf, ok := s.stillBacks(workflowID, role, newInstanceID)
	if !ok {
		return false
	}
	newNodeID := wf.Runtime[role].NodeID
	oldRuntime.MigratingTo, oldRuntime.MigratedFrom = "", nil
	oldRuntime.MigrationBy, oldRuntime.MigrationNonce, oldRuntime.MigrationAt = "", "", nil
	wf.Runtime[role] = oldRuntime
	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: rollbackMigration: commit failed, keeping the new instance", "workflow", workflowID, "role", role, "error", err)
		return false
	}
	s.publish(wf)
	// Die alte Instanz hat ihren Zustand nie verloren: nichts einzuspielen.
	s.clearUnrestored(workflowID, role)
	s.reapplyRoleConnections(wf, role, oldRuntime.InstanceID, "rollbackMigration")
	// Verbraucher, die schon auf die neue Instanz gewechselt haben, zurückholen, bevor sie verschwindet.
	if _, ok := s.stillBacks(workflowID, role, oldRuntime.InstanceID); ok {
		s.awaitHandover(wf, role, newNodeID, oldRuntime.NodeID)
	}
	if err := s.launcher.Stop(newInstanceID); err != nil && !errors.Is(err, launcher.ErrUnknownInstance) {
		slog.Warn("workflows: rollbackMigration: stop of the new instance failed", "instance", newInstanceID, "error", err)
	}
	return true
}

// reapplyRoleConnections wendet alle Verbindungen der Rolle erneut an (bestmöglich), solange sie von instanceID
// erfüllt wird. Liefert die Zahl der fehlgeschlagenen Verbindungen.
func (s *Service) reapplyRoleConnections(wf Workflow, role, instanceID, who string) int {
	failed := 0
	for _, conn := range wf.Definition.Connections {
		if conn.FromRole != role && conn.ToRole != role {
			continue
		}
		if _, ok := s.stillBacks(wf.ID, role, instanceID); !ok {
			return failed
		}
		fromNode, ok := s.nodeForRole(wf, conn.FromRole)
		if !ok {
			continue
		}
		toNode, ok := s.nodeForRole(wf, conn.ToRole)
		if !ok {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), registrationTimeout.Load())
		err := s.applyConnection(ctx, conn, fromNode, toNode, roleNodeType(wf, conn.ToRole))
		cancel()
		if err != nil {
			slog.Warn("workflows: "+who+": reconnect failed", "workflow", wf.ID, "connection", conn, "error", err)
			failed++
		}
	}
	return failed
}

// migrationJournalStale: so alt muss der Journal-Eintrag eines ANDEREN Cluster-Mitglieds sein, bevor er als
// abgebrochen gilt (ein Umzug dauert im ungünstigsten Fall wenige Minuten). Einträge eines früheren eigenen
// Prozesslaufs gelten sofort als abgebrochen.
const migrationJournalStale = 10 * time.Minute

// reconcileMigrationJournal räumt abgebrochene Umzüge auf (Aufruf im Takt des Failover-Wächters, nur Leader):
//   - MigratingTo gesetzt: es wurde nie umgeschaltet — die neue Instanz wird wieder abgebaut.
//   - MigratedFrom gesetzt: umgeschaltet, die alte Instanz aber nicht mehr gestoppt — Verbindungen der Rolle werden
//     noch einmal angewendet (der Abbruch kann mitten darin gelegen haben), dann wird die alte Instanz gestoppt.
func (s *Service) reconcileMigrationJournal(wf Workflow) {
	for role, rt := range wf.Runtime {
		if rt.MigratingTo == "" && rt.MigratedFrom == nil {
			continue
		}
		oldID := rt.InstanceID
		if rt.MigratedFrom != nil {
			oldID = rt.MigratedFrom.InstanceID
		}
		s.migrations.mu.Lock()
		inFlight := s.migrations.migratingInstances[oldID]
		s.migrations.mu.Unlock()
		if inFlight {
			continue // läuft in diesem Prozess
		}
		ownRun := rt.MigrationBy == s.identity && rt.MigrationNonce == s.processNonce()
		foreign := rt.MigrationBy != s.identity
		if foreign && rt.MigrationAt != nil && time.Since(*rt.MigrationAt) < migrationJournalStale {
			continue // ein anderes Mitglied kann noch daran arbeiten
		}
		if ownRun && rt.MigrationAt != nil && time.Since(*rt.MigrationAt) < 5*time.Second {
			continue // gerade erst eingetragen, die Buchführung zieht noch nach
		}
		role, rt := role, rt
		if !s.claimMigrationAttempt(oldID) {
			continue
		}
		safego.Go("workflows.recoverMigration", func() {
			defer s.releaseMigrationClaim(oldID)
			s.recoverMigration(wf.ID, role, rt)
		})
	}
}

func (s *Service) recoverMigration(workflowID, role string, rt RoleRuntime) {
	wf, ok := s.stillBacks(workflowID, role, rt.InstanceID)
	if !ok {
		return
	}
	stale := rt.MigratingTo
	if rt.MigratedFrom != nil {
		stale = rt.MigratedFrom.InstanceID
		s.reapplyRoleConnections(wf, role, rt.InstanceID, "recoverMigration")
	}
	slog.Warn("workflows: cleaning up an interrupted migration", "workflow", workflowID, "role", role, "keeps", rt.InstanceID, "stops", stale)
	if stale != "" {
		if err := s.launcher.Stop(stale); err != nil && !errors.Is(err, launcher.ErrUnknownInstance) && !errors.Is(err, launcher.ErrStopDeferred) {
			slog.Warn("workflows: recoverMigration: stop failed", "instance", stale, "error", err)
		}
		if s.authz != nil {
			_ = s.authz.DeleteInstanceBinding(stale, workflowID)
		}
		if rel, ok := s.ioPorts.(interface{ ReleaseClaimedByInstance(string) error }); ok && rt.MigratingTo != "" {
			_ = rel.ReleaseClaimedByInstance(stale)
		}
	}
	s.journalMigration(workflowID, role, rt.InstanceID, func(r *RoleRuntime) {
		r.MigratingTo, r.MigratedFrom, r.MigrationBy, r.MigrationNonce, r.MigrationAt = "", nil, "", "", nil
	})
	s.publishMigrationEvent(migrationEvent{
		WorkflowID: workflowID, Role: role, FromInstanceID: stale, ToInstanceID: rt.InstanceID,
		Reason: "interrupted-cleaned-up", Status: "done", At: time.Now(),
	})
}
