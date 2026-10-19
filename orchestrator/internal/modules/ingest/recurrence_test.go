package ingest

import (
	"testing"
	"time"
)

func utc(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func occ(t *testing.T, s Spec, from, to string) []Occurrence {
	t.Helper()
	o, err := Occurrences(s, utc(from), utc(to))
	if err != nil {
		t.Fatal(err)
	}
	return o
}

func TestOnceWithTimezone(t *testing.T) {
	o := occ(t, Spec{TZ: "Europe/Berlin", StartLocal: "2026-10-20T14:00", DurationS: 3600}, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z")
	if len(o) != 1 || !o[0].Start.Equal(utc("2026-10-20T12:00:00Z")) || !o[0].End.Equal(utc("2026-10-20T13:00:00Z")) {
		t.Fatalf("%+v", o) // 14:00 CEST = 12:00 UTC
	}
	o = occ(t, Spec{TZ: "Europe/Berlin", StartLocal: "2026-12-20T14:00", DurationS: 60}, "2026-12-01T00:00:00Z", "2027-01-01T00:00:00Z")
	if !o[0].Start.Equal(utc("2026-12-20T13:00:00Z")) {
		t.Fatalf("winter: %+v", o) // 14:00 CET = 13:00 UTC
	}
}

// Sommerzeit-Umstellung 2026-03-29 02:00→03:00 (Europe/Berlin): 02:30 existiert nicht.
func TestDSTGapShiftsForwardDeterministically(t *testing.T) {
	s := Spec{TZ: "Europe/Berlin", StartLocal: "2026-03-27T02:30", DurationS: 1800, Rec: Recurrence{Freq: "daily", Count: 4}}
	o := occ(t, s, "2026-03-01T00:00:00Z", "2026-05-01T00:00:00Z")
	if len(o) != 4 {
		t.Fatalf("%d occurrences", len(o))
	}
	want := []string{"2026-03-27T01:30:00Z", "2026-03-28T01:30:00Z", "2026-03-29T01:30:00Z", "2026-03-30T00:30:00Z"}
	// 29.03.: 02:30 gibt es nicht → erster Zeitpunkt danach = 03:30 CEST = 01:30 UTC
	for i, w := range want {
		if !o[i].Start.Equal(utc(w)) {
			t.Errorf("occurrence %d = %s, want %s", i, o[i].Start.Format(time.RFC3339), w)
		}
	}
	if !o[2].Shifted || o[0].Shifted || o[3].Shifted {
		t.Errorf("shifted flags: %v %v %v", o[0].Shifted, o[2].Shifted, o[3].Shifted)
	}
}

// Winterzeit-Umstellung 2026-10-25 03:00→02:00: 02:30 gibt es zweimal → die erste Instanz.
func TestDSTOverlapPicksFirstInstance(t *testing.T) {
	s := Spec{TZ: "Europe/Berlin", StartLocal: "2026-10-24T02:30", DurationS: 3600, Rec: Recurrence{Freq: "daily", Count: 3}}
	o := occ(t, s, "2026-10-01T00:00:00Z", "2026-11-30T00:00:00Z")
	want := []string{"2026-10-24T00:30:00Z", "2026-10-25T00:30:00Z", "2026-10-26T01:30:00Z"}
	for i, w := range want {
		if !o[i].Start.Equal(utc(w)) {
			t.Errorf("occurrence %d = %s, want %s", i, o[i].Start.Format(time.RFC3339), w)
		}
	}
	if !o[1].Ambiguous || o[0].Ambiguous {
		t.Error("ambiguous flag wrong")
	}
}

func TestDurationIsRealTimeAcrossTransition(t *testing.T) {
	// 2 echte Stunden ab 01:30 CEST am Umstellungstag enden um 02:30 CET (= 01:30 UTC)
	s := Spec{TZ: "Europe/Berlin", StartLocal: "2026-10-25T01:30", DurationS: 7200}
	o := occ(t, s, "2026-10-24T00:00:00Z", "2026-10-26T00:00:00Z")
	if o[0].End.Sub(o[0].Start) != 2*time.Hour {
		t.Fatal("duration must be real elapsed time")
	}
	if got := o[0].End.In(time.FixedZone("CET", 3600)).Format("15:04"); got != "02:30" {
		t.Fatalf("end local = %s", got)
	}
}

func TestWeeklyByDayIntervalUntilCount(t *testing.T) {
	// Mo/Mi/Fr, jede 2. Woche, ab Mo 2026-10-05, bis 2026-10-31
	s := Spec{TZ: "UTC", StartLocal: "2026-10-05T08:00", DurationS: 600, Rec: Recurrence{Freq: "weekly", Interval: 2, ByDay: []string{"MO", "WE", "FR"}, Until: "2026-10-31"}}
	o := occ(t, s, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z")
	var days []string
	for _, x := range o {
		days = append(days, x.LocalDate)
	}
	want := []string{"2026-10-05", "2026-10-07", "2026-10-09", "2026-10-19", "2026-10-21", "2026-10-23"}
	if len(days) != len(want) {
		t.Fatalf("%v", days)
	}
	for i := range want {
		if days[i] != want[i] {
			t.Fatalf("%v, want %v", days, want)
		}
	}
	s.Rec = Recurrence{Freq: "weekly", ByDay: []string{"MO", "TU"}, Count: 3}
	o = occ(t, s, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z")
	if len(o) != 3 || o[2].LocalDate != "2026-10-12" {
		t.Fatalf("%+v", o)
	}
}

func TestCountIsIndependentOfWindow(t *testing.T) {
	s := Spec{TZ: "UTC", StartLocal: "2026-10-01T08:00", DurationS: 60, Rec: Recurrence{Freq: "daily", Count: 5}}
	o := occ(t, s, "2026-10-04T00:00:00Z", "2026-11-01T00:00:00Z")
	if len(o) != 2 || o[0].Index != 3 || o[1].Index != 4 {
		t.Fatalf("window must not reset Count: %+v", o)
	}
}

func TestMonthlySkipsShortMonths(t *testing.T) {
	s := Spec{TZ: "UTC", StartLocal: "2026-01-31T10:00", DurationS: 60, Rec: Recurrence{Freq: "monthly"}}
	o := occ(t, s, "2026-01-01T00:00:00Z", "2026-06-30T00:00:00Z")
	var d []string
	for _, x := range o {
		d = append(d, x.LocalDate)
	}
	if len(d) != 3 || d[0] != "2026-01-31" || d[1] != "2026-03-31" || d[2] != "2026-05-31" {
		t.Fatalf("%v", d)
	}
}

func TestValidateRejects(t *testing.T) {
	bad := []Spec{
		{TZ: "Mars/Base", StartLocal: "2026-01-01T10:00", DurationS: 60},
		{TZ: "UTC", StartLocal: "morgen", DurationS: 60},
		{TZ: "UTC", StartLocal: "2026-01-01T10:00", DurationS: 0},
		{TZ: "UTC", StartLocal: "2026-01-01T10:00", DurationS: 60, Rec: Recurrence{Freq: "hourly"}},
		{TZ: "UTC", StartLocal: "2026-01-01T10:00", DurationS: 60, Rec: Recurrence{Freq: "weekly", ByDay: []string{"XX"}}},
		{TZ: "", StartLocal: "2026-01-01T10:00", DurationS: 60},
	}
	for i, s := range bad {
		if s.Validate() == nil {
			t.Errorf("case %d must be rejected", i)
		}
	}
}

func TestIdempotencyKeyStable(t *testing.T) {
	s := Spec{TZ: "UTC", StartLocal: "2026-10-01T08:00", DurationS: 60, Rec: Recurrence{Freq: "daily"}}
	a := occ(t, s, "2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z")
	b := occ(t, s, "2026-10-02T00:00:00Z", "2026-10-04T00:00:00Z")
	if IdempotencyKey("s1", a[1]) != IdempotencyKey("s1", b[0]) {
		t.Fatal("same occurrence must give the same key regardless of window")
	}
	if IdempotencyKey("s1", a[0]) == IdempotencyKey("s2", a[0]) {
		t.Fatal("different schedules must differ")
	}
}
