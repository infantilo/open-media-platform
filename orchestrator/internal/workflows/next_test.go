package workflows

import (
	"testing"
	"time"
)

func TestNextStart(t *testing.T) {
	loc := time.FixedZone("T", 2*3600)
	now := time.Date(2026, 10, 2, 10, 0, 0, 0, loc) // Freitag
	wed := 3
	at := time.Date(2026, 10, 2, 12, 30, 0, 0, loc)
	old := time.Date(2026, 10, 1, 9, 0, 0, 0, loc)

	wf := func(s ...Schedule) Workflow { return Workflow{Definition: Definition{Schedules: s}} }
	day := 24 * time.Hour

	cases := []struct {
		name string
		wf   Workflow
		want time.Time
		ok   bool
	}{
		{"täglich später heute", wf(Schedule{Kind: ScheduleDaily, Action: ScheduleActionStart, TimeOfDay: "11:15"}), time.Date(2026, 10, 2, 11, 15, 0, 0, loc), true},
		{"täglich schon vorbei → morgen", wf(Schedule{Kind: ScheduleDaily, Action: ScheduleActionStart, TimeOfDay: "09:00"}), time.Date(2026, 10, 3, 9, 0, 0, 0, loc), true},
		{"genau jetzt zählt nicht (strikt danach)", wf(Schedule{Kind: ScheduleDaily, Action: ScheduleActionStart, TimeOfDay: "10:00"}), time.Date(2026, 10, 3, 10, 0, 0, 0, loc), true},
		{"wöchentlich Mittwoch", wf(Schedule{Kind: ScheduleWeekly, Action: ScheduleActionStart, TimeOfDay: "08:00", Weekday: &wed}), time.Date(2026, 10, 7, 8, 0, 0, 0, loc), true},
		{"einmalig in der Zukunft", wf(Schedule{Kind: ScheduleOnce, Action: ScheduleActionStart, At: &at}), at, true},
		{"einmalig vergangen", wf(Schedule{Kind: ScheduleOnce, Action: ScheduleActionStart, At: &old}), time.Time{}, false},
		{"Stop zählt nicht", wf(Schedule{Kind: ScheduleDaily, Action: ScheduleActionStop, TimeOfDay: "11:00"}), time.Time{}, false},
		{"frühester von mehreren", wf(
			Schedule{Kind: ScheduleDaily, Action: ScheduleActionStart, TimeOfDay: "23:00"},
			Schedule{Kind: ScheduleOnce, Action: ScheduleActionStart, At: &at}), at, true},
		{"kaputte Uhrzeit", wf(Schedule{Kind: ScheduleDaily, Action: ScheduleActionStart, TimeOfDay: "25:99"}), time.Time{}, false},
	}
	for _, c := range cases {
		got, ok := NextStart(c.wf, now, 7*day)
		if ok != c.ok || (ok && !got.Equal(c.want)) {
			t.Errorf("%s: got %v/%v, want %v/%v", c.name, got, ok, c.want, c.ok)
		}
	}
	// Horizont begrenzt.
	far := now.Add(10 * day)
	if _, ok := NextStart(wf(Schedule{Kind: ScheduleOnce, Action: ScheduleActionStart, At: &far}), now, 7*day); ok {
		t.Error("jenseits des Horizonts darf nichts gemeldet werden")
	}
}
