package radio

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestParseRecurrence(t *testing.T) {
	good := `{"enabled":true,"tz":"Europe/Berlin","time":"07:00","durationMin":180,"byDay":["mo","FR"]}`
	r, err := ParseRecurrence(json.RawMessage(good))
	if err != nil || r.HorizonDays != 14 || r.ByDay[0] != "MO" {
		t.Fatalf("%+v %v", r, err)
	}
	for _, bad := range []string{
		`{"enabled":true,"tz":"Mars/Base","time":"07:00","durationMin":60,"byDay":["MO"]}`,
		`{"enabled":true,"tz":"Europe/Berlin","time":"7h","durationMin":60,"byDay":["MO"]}`,
		`{"enabled":true,"tz":"Europe/Berlin","time":"07:00","durationMin":0,"byDay":["MO"]}`,
		`{"enabled":true,"tz":"Europe/Berlin","time":"07:00","durationMin":60,"byDay":[]}`,
		`{"enabled":true,"tz":"Europe/Berlin","time":"07:00","durationMin":60,"byDay":["XX"]}`,
		`{"enabled":true,"tz":"Europe/Berlin","time":"07:00","durationMin":60,"byDay":["MO"],"horizonDays":400}`,
	} {
		if _, err := ParseRecurrence(json.RawMessage(bad)); err == nil {
			t.Errorf("sollte abgelehnt werden: %s", bad)
		}
	}
	if r, err := ParseRecurrence(json.RawMessage(`{"enabled":false}`)); err != nil || r.Enabled {
		t.Fatalf("ausgeschaltet braucht keine Angaben: %v", err)
	}
}

func TestOccurrencesWeeklyAcrossDST(t *testing.T) {
	r, _ := ParseRecurrence(json.RawMessage(`{"enabled":true,"tz":"Europe/Berlin","time":"07:00","durationMin":180,"byDay":["MO","WE"]}`))
	from := time.Date(2026, 10, 19, 0, 0, 0, 0, time.UTC) // Mo. — Zeitumstellung am 25.10.
	occ, err := r.Occurrences(from, from.AddDate(0, 0, 14))
	if err != nil {
		t.Fatal(err)
	}
	if len(occ) != 4 { // Mo 19.10., Mi 21.10. (Sommerzeit), Mo 26.10., Mi 28.10. (Winterzeit)
		t.Fatalf("erwartet 4 Termine, es sind %d: %+v", len(occ), occ)
	}
	loc, _ := time.LoadLocation("Europe/Berlin")
	for _, o := range occ {
		if h := o.Start.In(loc).Hour(); h != 7 || o.End.Sub(o.Start) != 3*time.Hour {
			t.Errorf("%v: Wanduhr bleibt 07:00 und Dauer 3 h", o)
		}
	}
	// vor und nach der Umstellung unterscheidet sich der UTC-Zeitpunkt um eine Stunde
	if occ[0].Start.UTC().Hour() == occ[3].Start.UTC().Hour() {
		t.Errorf("UTC-Stunde müsste sich über die Umstellung ändern")
	}
	// erster Tag des Fensters zählt mit
	one, _ := r.Occurrences(time.Date(2026, 10, 25, 22, 0, 0, 0, time.UTC), time.Date(2026, 10, 26, 7, 0, 0, 0, time.UTC))
	if len(one) != 1 {
		t.Fatalf("Mo 26.10. 07:00 Ortszeit (06:00 UTC) liegt im Fenster: %+v", one)
	}
}

func TestMaterializeIdempotentAndSkips(t *testing.T) {
	st, m := newStore(t)
	ctx := context.Background()
	rec := json.RawMessage(`{"enabled":true,"tz":"Europe/Berlin","time":"07:00","durationMin":120,"byDay":["MO","TU","WE","TH","FR","SA","SU"],"horizonDays":3}`)
	tpl, err := st.Create(ctx, Input{Title: "Morgenshow", Template: true, Presenters: []string{"anna"}, Content: json.RawMessage(`{"carts":[{"label":"J"}]}`), Recurrence: rec}, "anna")
	if err != nil {
		t.Fatal(err)
	}
	m.Materialize(ctx)
	no := false
	l, _ := st.List(ctx, Filter{Template: &no})
	if n := len(l); n < 2 || n > 3 {
		t.Fatalf("3 Tage Vorlauf: 2–3 Sendungen, es sind %d", n)
	}
	first := l[0]
	full, _ := st.Get(ctx, first.ID)
	if first.SourceTemplateID != tpl.ID || first.Status != StatusDraft || !strings.Contains(first.Title, "Morgenshow ") || first.Owner != "anna" || !strings.Contains(string(full.Content), `"J"`) {
		t.Fatalf("erzeugte Sendung: %+v", first)
	}
	m.Materialize(ctx)
	if l2, _ := st.List(ctx, Filter{Template: &no}); len(l2) != len(l) {
		t.Fatalf("zweiter Lauf legt nichts doppelt an: %d → %d", len(l), len(l2))
	}
	// gelöscht → bleibt gelöscht
	if err := st.Delete(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	m.Materialize(ctx)
	if l3, _ := st.List(ctx, Filter{Template: &no}); len(l3) != len(l)-1 {
		t.Fatalf("gelöschter Termin wird nicht neu angelegt: %d", len(l3))
	}
	// Wiederkehr aus → keine neuen
	if _, err := st.Update(ctx, tpl.ID, Input{Title: "Morgenshow", Template: true, Presenters: []string{"anna"}, Recurrence: json.RawMessage(`{"enabled":false}`), RowVersion: 1}, "anna"); err != nil {
		t.Fatal(err)
	}
	st.db.ExecContext(ctx, `DELETE FROM radio_shows WHERE NOT template`)
	st.db.ExecContext(ctx, `DELETE FROM radio_show_skips`)
	m.Materialize(ctx)
	if l4, _ := st.List(ctx, Filter{Template: &no}); len(l4) != 0 {
		t.Fatalf("ausgeschaltete Wiederkehr erzeugt nichts: %d", len(l4))
	}
}

func TestRecurrenceOnlyOnTemplates(t *testing.T) {
	in := Input{Title: "x", Recurrence: json.RawMessage(`{"enabled":true,"tz":"Europe/Berlin","time":"07:00","durationMin":60,"byDay":["MO"]}`)}
	if err := in.Validate(); err == nil {
		t.Fatal("Wiederkehr an einer Sendung muss abgelehnt werden")
	}
	in.Template = true
	if err := in.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestAutoTransitions(t *testing.T) {
	st, m := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	mk := func(title string, startOff, endOff time.Duration, auto bool, ready bool) Show {
		s, e := now.Add(startOff), now.Add(endOff)
		sh, err := st.Create(ctx, Input{Title: title, SlotStart: &s, SlotEnd: &e, AutoLive: &auto}, "x")
		if err != nil {
			t.Fatal(err)
		}
		if ready {
			if _, err := st.SetStatus(ctx, sh.ID, StatusReady, "x"); err != nil {
				t.Fatal(err)
			}
		}
		return sh
	}
	running := mk("läuft jetzt", -time.Minute, time.Hour, true, true)
	later := mk("später", time.Hour, 2*time.Hour, true, true)
	manual := mk("manuell", -time.Minute, time.Hour, false, true)
	draft := mk("Entwurf", -time.Minute, time.Hour, true, false)
	missed := mk("verpasst", -3*time.Hour, -time.Hour, true, true)
	m.Transition(ctx, now)
	status := func(id string) string { s, _ := st.Get(ctx, id); return s.Status }
	if status(running.ID) != StatusLive || status(later.ID) != StatusReady || status(manual.ID) != StatusReady || status(draft.ID) != StatusDraft {
		t.Fatalf("Beginn: %s %s %s %s", status(running.ID), status(later.ID), status(manual.ID), status(draft.ID))
	}
	if status(missed.ID) != StatusReady {
		t.Fatalf("eine freigegebene Sendung, deren Fenster ganz vorbei ist, bleibt unberührt (wurde nie live): %s", status(missed.ID))
	}
	// Ende: live → done
	m.Transition(ctx, now.Add(90*time.Minute))
	if status(running.ID) != StatusDone || status(later.ID) != StatusLive {
		t.Fatalf("Ende: %s %s", status(running.ID), status(later.ID))
	}
}
