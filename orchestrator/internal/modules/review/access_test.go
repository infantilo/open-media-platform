package review

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// fakeAccess: Rechte und Gruppen je Nutzer (Kapitel 44).
type fakeAccess map[string]struct {
	feats  []string
	groups []string
}

func (f fakeAccess) Identity(r *http.Request) module.Identity {
	u, _ := module.User(r)
	e := f[u]
	return module.Identity{User: u, Groups: e.groups, Has: func(x string) bool {
		for _, p := range e.feats {
			if p == x || p == "*" {
				return true
			}
		}
		return false
	}}
}
func (f fakeAccess) Can(r *http.Request, feat string) bool { return f.Identity(r).Has(feat) }

func TestAssignmentRestrictsClaimAndTasksFollow(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.QCProfiles["broadcast-default"] = noLoudness(c.QCProfiles["broadcast-default"]) })
	ctx := context.Background()
	it := e.importReady(t)

	due := time.Now().Add(-time.Hour).UTC()
	as, err := e.svc.AssignTask(ctx, it.AssetID, "lead", "", "nachtschicht", &due, it.Revision)
	if err != nil || as.AssignedGroup != "nachtschicht" || as.DueAt == nil || as.AssignedBy != "lead" {
		t.Fatalf("assign: %v %+v", err, as)
	}
	// Nicht-Mitglied darf nicht übernehmen, Mitglied schon, Zuweisungsrecht immer
	if _, err := e.svc.ClaimAs(ctx, it.AssetID, "bob", []string{"tagschicht"}, false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Nicht-Mitglied: %v, want ErrForbidden", err)
	}
	// Aufgabenliste: Mitglied sieht die Gruppenaufgabe als übernehmbar und überfällig, Fremder sieht nichts
	m := &Module{}
	m.svc = e.svc
	// Die Testdatenbank wird von mehreren Tests geteilt: nur die eigene Datei betrachten.
	mine := func(user string, groups ...string) []module.Task {
		all, err := m.Tasks(ctx, module.Identity{User: user, Groups: groups, Has: func(string) bool { return false }})
		if err != nil {
			t.Fatal(err)
		}
		var out []module.Task
		for _, x := range all {
			if x.ID == it.AssetID {
				out = append(out, x)
			}
		}
		return out
	}
	tasks := mine("carol", "nachtschicht")
	if len(tasks) != 1 || !tasks[0].Claimable || !tasks[0].Overdue || tasks[0].Status != "error" || tasks[0].AssigneeGroup != "nachtschicht" {
		t.Fatalf("tasks carol: %+v", tasks)
	}
	if tasks := mine("bob", "tagschicht"); len(tasks) != 0 {
		t.Fatalf("Fremder sieht Aufgaben: %+v", tasks)
	}
	cl, err := e.svc.ClaimAs(ctx, it.AssetID, "carol", []string{"nachtschicht"}, false)
	if err != nil || cl.Assignee != "carol" || cl.AssignedTo != "carol" {
		t.Fatalf("claim carol: %v %+v", err, cl)
	}
	// Übernommen: persönlich „meine“ Aufgabe, nicht mehr übernehmbar
	tasks = mine("carol", "nachtschicht")
	if len(tasks) != 1 || !tasks[0].Mine || tasks[0].Claimable || tasks[0].Status != "error" {
		t.Fatalf("tasks nach Claim: %+v", tasks)
	}
	// Freigabe: Gruppenaufgabe fällt in den Pool zurück
	rel, err := e.svc.Release(ctx, it.AssetID, "carol", false, -1)
	if err != nil || rel.AssignedTo != "" || rel.AssignedGroup != "nachtschicht" {
		t.Fatalf("release: %v %+v", err, rel)
	}
	// Persönliche Zuweisung: nur diese Person (oder Zuweisungsrecht)
	as, err = e.svc.AssignTask(ctx, it.AssetID, "lead", "dave", "", nil, -1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.ClaimAs(ctx, it.AssetID, "carol", []string{"nachtschicht"}, false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("fremde Person: %v", err)
	}
	if _, err := e.svc.ClaimAs(ctx, it.AssetID, "lead", nil, true); err != nil {
		t.Fatalf("Zuweisungsrecht: %v", err)
	}
	_ = as
}

func TestHTTPListIsScopedWithoutViewRight(t *testing.T) {
	h := newHTTPEnv(t)
	it := h.importReady(t)
	ctx := context.Background()
	if _, err := h.svc.AssignTask(ctx, it.AssetID, "lead", "dave", "", nil, -1); err != nil {
		t.Fatal(err)
	}
	h2 := h
	m := &Module{Assets: h.svc.Assets, DataDir: h.svc.DataDir, Tools: h.svc.Tools}
	rts := fakeRoutes{}
	acc := fakeAccess{
		"dave":  {feats: []string{FeatWork}},
		"erin":  {feats: []string{FeatWork}},
		"boss":  {feats: []string{FeatView}},
		"appro": {feats: []string{FeatApprove}},
	}
	if err := m.Mount(rts, module.Deps{DB: h.svc.St.db, Settings: &memSettings{m: map[string][]byte{}}, Audit: &auditSink{}, Access: acc}); err != nil {
		t.Fatal(err)
	}
	h2 = &httpEnv{testEnv: h.testEnv, routes: rts}
	count := func(user string) int {
		rec := h2.call(t, "GET", "/api/v1/review/items", user, nil)
		if rec.Code != 200 {
			t.Fatalf("%s: %d %s", user, rec.Code, rec.Body)
		}
		l, _ := decode(t, rec)["items"].([]any)
		n := 0
		for _, x := range l {
			if x.(map[string]any)["assetId"] == it.AssetID {
				n++
			}
		}
		return n
	}
	if n := count("dave"); n != 1 {
		t.Errorf("dave (zugewiesen) sieht %d", n)
	}
	if n := count("erin"); n != 0 {
		t.Errorf("erin (nicht zugewiesen) sieht %d", n)
	}
	if n := count("boss"); n != 1 {
		t.Errorf("boss (view) sieht %d", n)
	}
	if rec := h2.call(t, "GET", "/api/v1/review/items/"+it.AssetID, "erin", nil); rec.Code != 403 {
		t.Errorf("Einzelabruf fremd: %d", rec.Code)
	}
	if rec := h2.call(t, "GET", "/api/v1/review/items/"+it.AssetID, "dave", nil); rec.Code != 200 {
		t.Errorf("Einzelabruf eigen: %d", rec.Code)
	}
	// Claim über HTTP: erin darf die Datei von dave nicht übernehmen
	if rec := h2.call(t, "POST", "/api/v1/review/items/"+it.AssetID+"/claim", "erin", nil); rec.Code != 403 {
		t.Errorf("claim fremd: %d %s", rec.Code, rec.Body)
	}
	if rec := h2.call(t, "POST", "/api/v1/review/items/"+it.AssetID+"/claim", "dave", nil); rec.Code != 200 {
		t.Errorf("claim eigen: %d %s", rec.Code, rec.Body)
	}
}
