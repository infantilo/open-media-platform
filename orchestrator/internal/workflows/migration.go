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
	"log/slog"
	"sort"
	"strconv"
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
	if wf.Definition.Settings.ProgramWidth > 0 {
		extraEnv["OMP_WIDTH"] = strconv.FormatUint(uint64(wf.Definition.Settings.ProgramWidth), 10)
	}
	if wf.Definition.Settings.ProgramHeight > 0 {
		extraEnv["OMP_HEIGHT"] = strconv.FormatUint(uint64(wf.Definition.Settings.ProgramHeight), 10)
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

	// Schritt 2: auf ihre Registrierung warten.
	ctx, cancel := context.WithTimeout(context.Background(), registrationTimeout)
	node, err := s.awaitFreshRegistration(ctx, newInst.ID, oldNodeID)
	cancel()
	if err != nil {
		slog.Warn("workflows: executeMigration: new instance failed to register, stopping it and keeping old instance",
			"workflow", workflowID, "role", role, "instance", newInst.ID, "error", err)
		if stopErr := s.launcher.Stop(newInst.ID); stopErr != nil {
			slog.Warn("workflows: executeMigration: cleanup of failed new instance failed", "instance", newInst.ID, "error", stopErr)
		}
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
		return
	}
	wf = fresh

	// Schritt 3: Betriebszustand von der noch laufenden ALTEN Instanz
	// erfassen, BEVOR die Runtime unten mutiert wird — restoreOneRoleState
	// löst danach gegen die NEUE Runtime auf (identisches Muster wie
	// promoteStandby, s. dortige Doku).
	senderToAlias := s.buildSenderAliasIndex(wf)
	s.captureOneRoleState(wf, role, senderToAlias)

	// Schritt 5 (Teil 1): Runtime auf die neue Instanz umschreiben und
	// sofort committen — macht die neue Zuordnung zur DB-Wahrheit, bevor
	// der langsamere Connections-Teil beginnt (gleicher früher-Commit-
	// Grund wie promoteStandby).
	wf.Runtime[role] = RoleRuntime{InstanceID: newInst.ID, NodeID: node.ID, HostID: targetHostID}
	wf.UpdatedAt = time.Now()
	if err := s.store.UpdateRuntime(wf); err != nil {
		slog.Warn("workflows: executeMigration: early commit failed", "workflow", workflowID, "role", role, "error", err)
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
		connectCtx, connectCancel := context.WithTimeout(context.Background(), registrationTimeout)
		err := s.applyConnection(connectCtx, conn, fromNode, toNode, roleNodeType(wf, conn.ToRole))
		connectCancel()
		if err != nil {
			slog.Warn("workflows: executeMigration: reconnect failed", "workflow", wf.ID, "connection", conn, "error", err)
		}
	}

	if _, ok := s.stillBacks(wf.ID, role, newInst.ID); !ok {
		slog.Info("workflows: executeMigration: role superseded before teardown, leaving old instance running",
			"workflow", wf.ID, "role", role)
		return
	}

	// Schritt 6: erst JETZT die alte Instanz stoppen — der eigentliche
	// "Break"-Schritt, bewusst zuletzt. Der ALTE I/O-Port-Claim wird
	// erst hier freigegeben (gezielt per ReleasePort, nicht per
	// Release(workflowID, role) — der neue Claim für dasselbe
	// (workflowID, role) muss bestehen bleiben, s. Kommentar oben).
	if err := s.launcher.Stop(oldInstanceID); err != nil {
		slog.Warn("workflows: executeMigration: stop old instance failed", "workflow", wf.ID, "role", role, "instance", oldInstanceID, "error", err)
	}
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
