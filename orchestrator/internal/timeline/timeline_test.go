package timeline

import (
	"database/sql"
	"encoding/json"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/audit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/domainaudit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/logbus"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

var t0 = time.Date(2026, 10, 27, 14, 0, 0, 0, time.UTC)

func ev(typ, payload string) sse.Event { return sse.Event{Type: typ, Data: json.RawMessage(payload)} }

func kinds(es []Event) []string {
	var k []string
	for _, e := range es {
		k = append(k, e.Kind+":"+e.Severity)
	}
	return k
}

func TestRecorderInstanceEvents(t *testing.T) {
	r := NewRecorder()
	got := r.Observe(ev("instance.crashed", `{"id":"i1","type":"omp-source","label":"Kamera","hostId":"h1","crashMessage":"signal: killed","restartCount":6}`), t0)
	if len(got) != 1 || got[0].Kind != "instance.crashed" || got[0].Severity != SevError || got[0].Subject != "i1" || got[0].Data["label"] != "Kamera" {
		t.Fatalf("%+v", got)
	}
	got = r.Observe(ev("instance.restarted", `{"id":"i1","label":"Kamera"}`), t0)
	if len(got) != 1 || got[0].Severity != SevWarn {
		t.Fatalf("%+v", got)
	}
	if r.Observe(ev("omp.health.x", `{"label":"n"}`), t0) != nil || r.Observe(ev("node.added", `{}`), t0) != nil {
		t.Error("Unbekanntes und Health ohne media_ready ergibt kein Ereignis")
	}
}

func TestRecorderNodeReadyFlips(t *testing.T) {
	r := NewRecorder()
	h := func(ready bool) sse.Event {
		b, _ := json.Marshal(map[string]any{"label": "Mixer", "media_ready": ready})
		return ev("omp.health.n1", string(b))
	}
	if got := r.Observe(h(true), t0); got != nil {
		t.Fatalf("erster Eindruck ist kein Ereignis: %+v", got)
	}
	if got := r.Observe(h(true), t0); got != nil {
		t.Fatalf("keine Änderung: %+v", got)
	}
	if got := kinds(r.Observe(h(false), t0)); len(got) != 1 || got[0] != "node.notready:error" {
		t.Fatalf("%v", got)
	}
	if got := kinds(r.Observe(h(true), t0)); len(got) != 1 || got[0] != "node.ready:info" {
		t.Fatalf("%v", got)
	}
}

func TestRecorderHostSilentResumedAndClock(t *testing.T) {
	r := NewRecorder()
	r.HostLabel = func(id string) string { return "Regie-" + id }
	m := func(synced bool) sse.Event {
		b, _ := json.Marshal(map[string]any{"clock": map[string]any{"synced": synced}})
		return ev("omp.host.A.metrics", string(b))
	}
	if got := r.Observe(m(true), t0); got != nil {
		t.Fatalf("%+v", got)
	}
	if got := kinds(r.Observe(m(false), t0.Add(time.Second))); len(got) != 1 || got[0] != "host.clock.lost:warn" {
		t.Fatalf("%v", got)
	}
	// Stille: erst nach 30 s, genau einmal, mit dem Zeitpunkt des letzten Lebenszeichens + 30 s
	if r.Tick(t0.Add(20*time.Second)) != nil {
		t.Fatal("zu früh")
	}
	silent := r.Tick(t0.Add(60 * time.Second))
	if len(silent) != 1 || silent[0].Kind != "host.silent" || silent[0].Data["label"] != "Regie-A" || !silent[0].At.Equal(t0.Add(time.Second+SilentAfter)) {
		t.Fatalf("%+v", silent)
	}
	if r.Tick(t0.Add(90*time.Second)) != nil {
		t.Fatal("nur einmal")
	}
	if got := kinds(r.Observe(m(false), t0.Add(100*time.Second))); len(got) != 1 || got[0] != "host.resumed:info" {
		t.Fatalf("%v", got)
	}
	// Absichtlich abgemeldet: Schweigen ist kein Ausfall
	r.Observe(ev("omp.host.A.metrics", `{"goodbye":true}`), t0.Add(110*time.Second))
	if r.Tick(t0.Add(300*time.Second)) != nil {
		t.Fatal("Goodbye darf nicht als Ausfall zählen")
	}
}

func TestStoreInsertDedupQueryPurge(t *testing.T) {
	db := dbtest.Open(t)
	mustExec(t, db, `TRUNCATE timeline_events`)
	s := NewStore(db)
	now := time.Now()
	e := Event{At: now, Kind: "instance.crashed", Severity: SevError, Subject: "i1", Data: map[string]any{"label": "K"}}
	if err := s.Insert(e); err != nil {
		t.Fatal(err)
	}
	if err := s.Insert(e); err != nil { // zweiter Orchestrator sieht dasselbe
		t.Fatal(err)
	}
	if err := s.Insert(Event{At: now, Kind: "marker", Actor: "anna"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Insert(Event{At: now, Kind: "marker", Actor: "anna"}); err != nil { // Marker sind nie Doppelte
		t.Fatal(err)
	}
	if err := s.Insert(Event{At: now.Add(-40 * 24 * time.Hour), Kind: "host.removed"}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.Query(now.Add(-time.Hour), now.Add(time.Hour), 10)
	if err != nil || len(rows) != 3 {
		t.Fatalf("rows = %d, err = %v (erwartet: 1 Absturz + 2 Marker)", len(rows), err)
	}
	old, _ := s.Query(now.Add(-50*24*time.Hour), now.Add(-30*24*time.Hour), 10)
	if len(old) != 1 {
		t.Fatalf("altes Ereignis fehlt: %d", len(old))
	}
	if n, err := s.PurgeOlderThan(14); err != nil || n != 1 {
		t.Fatalf("purge n=%d err=%v", n, err)
	}
}

type fakeAudit struct{ got audit.Filter }

func (f *fakeAudit) ListFiltered(flt audit.Filter) ([]audit.Entry, error) {
	f.got = flt
	return []audit.Entry{{ID: 5, OccurredAt: t0.Add(2 * time.Minute), Username: "anna", Method: "POST", Path: "/api/v1/instances", Status: 200},
		{ID: 4, OccurredAt: t0.Add(time.Minute), Username: "bob", Method: "DELETE", Path: "/api/v1/instances/x", Status: 403}}, nil
}

type fakeDomain struct{}

func (fakeDomain) List(int64, int) ([]domainaudit.Entry, error) {
	return []domainaudit.Entry{{ID: 1, OccurredAt: t0.Add(3 * time.Minute), Actor: "anna", ObjectType: "asset", ObjectID: "a1", Action: "approved"},
		{ID: 2, OccurredAt: t0.Add(-time.Hour), Actor: "x", ObjectType: "asset", ObjectID: "a2", Action: "zu alt"}}, nil
}

type fakeLogs struct{ got logbus.Filter }

func (f *fakeLogs) Query(flt logbus.Filter) ([]logbus.Entry, error) {
	f.got = flt
	return []logbus.Entry{{ID: 9, OccurredAt: t0.Add(4 * time.Minute), Level: "error", Message: "boom", NodeID: "n1", Source: "orchestrator"}}, nil
}

func TestSourcesMergeOrderAndFilters(t *testing.T) {
	a, l := &fakeAudit{}, &fakeLogs{}
	db := dbtest.Open(t)
	mustExec(t, db, `TRUNCATE timeline_events`)
	src := Sources{Store: NewStore(db), Audit: a, Domain: fakeDomain{}, Logs: l}
	if err := src.Store.Insert(Event{At: t0.Add(5 * time.Minute), Kind: "host.silent", Severity: SevError, Subject: "h1"}); err != nil {
		t.Fatal(err)
	}
	items, err := src.Query(t0, t0.Add(time.Hour), 50, false)
	if err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, it := range items {
		order = append(order, it.Source+":"+it.Kind)
	}
	want := []string{"event:host.silent", "log:log", "domain:domain", "audit:audit", "audit:audit"}
	if len(order) != len(want) {
		t.Fatalf("%v", order)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("Reihenfolge (neueste zuerst): %v", order)
		}
	}
	if items[4].Severity != SevWarn || items[3].Actor != "anna" {
		t.Errorf("Audit: Status >= 400 ist Hinweis, Nutzer als Akteur: %+v", items[3:])
	}
	// Bedienung (Regler/Schnitte) standardmäßig ausgeblendet, Layout-Speichern immer
	if len(a.got.ExcludeLike) != len(alwaysExclude)+len(operateExclude) {
		t.Errorf("ExcludeLike = %v", a.got.ExcludeLike)
	}
	if l.got.Level != "error" || l.got.Limit != 50 {
		t.Errorf("Log-Filter: %+v", l.got)
	}
	if _, _ = src.Query(t0, t0.Add(time.Hour), 500, true); len(a.got.ExcludeLike) != len(alwaysExclude) || l.got.Limit != maxLogs {
		t.Errorf("mit Bedienung: %v, Log-Limit %d", a.got.ExcludeLike, l.got.Limit)
	}
	if lim, _ := src.Query(t0, t0.Add(time.Hour), 2, false); len(lim) != 2 || lim[0].Kind != "host.silent" {
		t.Errorf("Begrenzung behält die neuesten: %v", lim)
	}
}

func TestRecorderWorkflowStatusOnlyOnChange(t *testing.T) {
	r := NewRecorder()
	wf := func(status, errText string) sse.Event {
		b, _ := json.Marshal(map[string]any{"id": "w1", "name": "Sendung", "status": status, "error": errText, "definition": map[string]any{"huge": true}})
		return ev("workflow.updated", string(b))
	}
	if r.Observe(wf("stopped", ""), t0) != nil || r.Observe(wf("stopped", ""), t0) != nil {
		t.Fatal("erster Eindruck und unveränderter Zustand sind keine Ereignisse")
	}
	got := r.Observe(wf("running", ""), t0)
	if len(got) != 1 || got[0].Kind != "workflow.status" || got[0].Data["name"] != "Sendung" || got[0].Data["previous"] != "stopped" {
		t.Fatalf("%+v", got)
	}
	if _, big := got[0].Data["definition"]; big {
		t.Error("die ganze Definition gehört nicht in die Zeile")
	}
	if got := r.Observe(wf("failed", "start: boom"), t0); len(got) != 1 || got[0].Severity != SevError {
		t.Fatalf("%+v", got)
	}
}

// Die Testdatenbank bleibt zwischen Läufen bestehen: jeder Test beginnt mit leerer Tabelle.
func mustExec(t *testing.T, db *sql.DB, q string) {
	t.Helper()
	if _, err := db.Exec(q); err != nil {
		t.Fatal(err)
	}
}
