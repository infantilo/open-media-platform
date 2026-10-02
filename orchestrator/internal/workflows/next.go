package workflows

import "time"

// nextOccurrence liefert den ersten Zeitpunkt des Zeitplans, der STRIKT nach
// `after` liegt (Orchestrator-Ortszeit wie der Scheduler), höchstens bis
// `horizon` danach.
func nextOccurrence(s Schedule, after time.Time, horizon time.Duration) (time.Time, bool) {
	limit := after.Add(horizon)
	switch s.Kind {
	case ScheduleOnce:
		if s.At != nil && s.At.After(after) && !s.At.After(limit) {
			return *s.At, true
		}
	case ScheduleDaily, ScheduleWeekly:
		hh, mm, ok := parseTimeOfDay(s.TimeOfDay)
		if !ok || (s.Kind == ScheduleWeekly && s.Weekday == nil) {
			return time.Time{}, false
		}
		// +1: ein Tag Puffer, damit ein Zeitpunkt knapp vor `limit` nicht an der Tagesgrenze verloren geht.
		for d := 0; d <= int(horizon/(24*time.Hour))+1; d++ {
			day := after.AddDate(0, 0, d)
			if s.Kind == ScheduleWeekly && int(day.Weekday()) != *s.Weekday {
				continue
			}
			t := time.Date(day.Year(), day.Month(), day.Day(), hh, mm, 0, 0, after.Location())
			if t.After(after) && !t.After(limit) {
				return t, true
			}
		}
	}
	return time.Time{}, false
}

// NextStart ist der früheste geplante START des Workflows nach `now`
// (innerhalb `horizon`); ok=false, wenn keiner ansteht.
func NextStart(wf Workflow, now time.Time, horizon time.Duration) (time.Time, bool) {
	var best time.Time
	found := false
	for _, s := range wf.Definition.Schedules {
		if s.Action != ScheduleActionStart {
			continue
		}
		if t, ok := nextOccurrence(s, now, horizon); ok && (!found || t.Before(best)) {
			best, found = t, true
		}
	}
	return best, found
}
