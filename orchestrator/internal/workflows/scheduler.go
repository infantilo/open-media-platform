// D7 Teil 2 (ARCHITECTURE.md §6.2 Punkt 1): führt die Start/Stop-
// Zeitpläne eines Workflows aus (Schedule, s. types.go). Läuft als
// eigene Hintergrund-Schleife (gleiches Muster wie registry.Poller.Run/
// placement.Engine.Run), unabhängig vom HTTP-Handler.
package workflows

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

// tickInterval ist der Abstand zwischen zwei Scheduler-Läufen. fireWindow
// ist das Zeitfenster, innerhalb dessen ein berechneter Ist-Zeitpunkt
// noch als "gerade fällig" gilt — größer als tickInterval, damit ein
// einzelner langsamer Tick (GC-Pause, kurzzeitige Systemlast) einen
// fälligen Zeitpunkt nicht verpasst, aber klein genug, um die in
// types.go dokumentierte "verfallen lassen"-Nachhol-Regel tatsächlich
// durchzusetzen (ein nach einem Neustart Stunden alter Zeitpunkt liegt
// weit außerhalb dieses Fensters und feuert nie nachträglich).
var tickInterval = 20 * time.Second

const fireWindow = 90 * time.Second

// SchedulerLauncher ist die von Scheduler genutzte Teilmenge von
// *Service — als Interface gehalten, damit scheduler_test.go ohne einen
// vollständigen Service (Store/Launcher/Graph/…) auskommt.
type SchedulerLauncher interface {
	List() ([]Workflow, error)
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string, confirm bool) error
	persistSchedule(wf Workflow) error
}

// Scheduler wertet bei jedem Tick die Schedules aller Workflows aus und
// löst fällige Start()/Stop()-Aufrufe aus.
type Scheduler struct {
	svc SchedulerLauncher
	now func() time.Time // Test-Seam, Default time.Now
}

// NewScheduler erstellt einen Scheduler für svc (typischerweise
// *Service selbst — s. Service.persistSchedule).
func NewScheduler(svc SchedulerLauncher) *Scheduler {
	return &Scheduler{svc: svc, now: time.Now}
}

// Run läuft bis ctx beendet wird, im tickInterval-Takt.
func (s *Scheduler) Run(ctx context.Context) {
	s.tick()

	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick()
		}
	}
}

func (s *Scheduler) tick() {
	wfs, err := s.svc.List()
	if err != nil {
		slog.Warn("workflows: scheduler: list failed", "error", err)
		return
	}

	now := s.now()
	for _, wf := range wfs {
		s.tickWorkflow(wf, now)
	}
}

func (s *Scheduler) tickWorkflow(wf Workflow, now time.Time) {
	changed := false
	for i := range wf.Definition.Schedules {
		sched := &wf.Definition.Schedules[i]
		occ, ok := occurrenceAt(*sched, now)
		if !ok {
			continue
		}
		elapsed := now.Sub(occ)
		if elapsed < 0 || elapsed >= fireWindow {
			continue // noch nicht fällig, oder verfallen (s. types.go Schedule-Doku)
		}
		if sched.LastFiredAt != nil && sched.LastFiredAt.Equal(occ) {
			continue // dieser Ist-Zeitpunkt hat bereits gefeuert
		}

		firedAt := occ
		sched.LastFiredAt = &firedAt
		changed = true
		s.fire(wf.ID, wf.Name, sched.Action)
	}
	if changed {
		if err := s.svc.persistSchedule(wf); err != nil {
			slog.Warn("workflows: scheduler: failed to persist LastFiredAt", "workflow", wf.ID, "error", err)
		}
	}
}

func (s *Scheduler) fire(workflowID, workflowName string, action ScheduleAction) {
	ctx, cancel := context.WithTimeout(context.Background(), registrationTimeout)
	defer cancel()

	var err error
	switch action {
	case ScheduleActionStart:
		err = s.svc.Start(ctx, workflowID)
	case ScheduleActionStop:
		// confirm=true: ein zeitgesteuerter Stop überspringt confirm_stop
		// bewusst (s. Service.Stop-Doku) — die Bestätigung ist beim
		// Anlegen des Zeitplans bereits erfolgt.
		err = s.svc.Stop(ctx, workflowID, true)
	default:
		return
	}
	if err != nil {
		slog.Warn("workflows: scheduled action failed", "workflow", workflowID, "name", workflowName, "action", action, "error", err)
		return
	}
	slog.Info("workflows: scheduled action fired", "workflow", workflowID, "name", workflowName, "action", action)
}

// occurrenceAt berechnet den für "jetzt" (bzw. den heutigen Tag)
// relevanten Ist-Zeitpunkt eines Schedules — ok=false, wenn der Schedule
// für den aktuellen Tag/Wochentag gar nicht zutrifft (z. B. "weekly" an
// einem anderen Wochentag).
func occurrenceAt(sched Schedule, now time.Time) (time.Time, bool) {
	switch sched.Kind {
	case ScheduleOnce:
		if sched.At == nil {
			return time.Time{}, false
		}
		return *sched.At, true
	case ScheduleDaily:
		hh, mm, ok := parseTimeOfDay(sched.TimeOfDay)
		if !ok {
			return time.Time{}, false
		}
		return time.Date(now.Year(), now.Month(), now.Day(), hh, mm, 0, 0, now.Location()), true
	case ScheduleWeekly:
		if sched.Weekday == nil || int(now.Weekday()) != *sched.Weekday {
			return time.Time{}, false
		}
		hh, mm, ok := parseTimeOfDay(sched.TimeOfDay)
		if !ok {
			return time.Time{}, false
		}
		return time.Date(now.Year(), now.Month(), now.Day(), hh, mm, 0, 0, now.Location()), true
	default:
		return time.Time{}, false
	}
}

// parseTimeOfDay parst "HH:MM" (24h). Bewusst keine time.Parse-Nutzung
// mit vollem Zeitzonen-/Datums-Overhead — die einzigen erlaubten Werte
// sind Stunde/Minute.
func parseTimeOfDay(s string) (hour, minute int, ok bool) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	hh, err1 := strconv.Atoi(parts[0])
	mm, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || hh < 0 || hh > 23 || mm < 0 || mm > 59 {
		return 0, 0, false
	}
	return hh, mm, true
}
