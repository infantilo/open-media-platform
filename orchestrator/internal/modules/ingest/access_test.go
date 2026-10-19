package ingest

import (
	"context"
	"net/http"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

type fakeAccess map[string]struct {
	feats  []string
	groups []string
}

func (f fakeAccess) Identity(r *http.Request) module.Identity {
	u, _ := module.User(r)
	e := f[u]
	return module.Identity{User: u, Groups: e.groups, Has: func(x string) bool {
		for _, p := range e.feats {
			if p == x {
				return true
			}
		}
		return false
	}}
}
func (f fakeAccess) Can(r *http.Request, feat string) bool { return f.Identity(r).Has(feat) }

func scheduleBody(name string) map[string]any {
	return map[string]any{"name": name, "source": map[string]any{"instanceId": "src1", "label": "Studio"}, "profileId": "mxf-h264",
		"spec": map[string]any{"tz": "Europe/Berlin", "startLocal": "2026-10-20T20:00", "durationS": 900}}
}

func TestOwnershipGatesEditingAndAssignment(t *testing.T) {
	acc := fakeAccess{
		"alice": {feats: []string{FeatScheduleCreate, FeatScheduleEdit, FeatJobControl}},
		"bob":   {feats: []string{FeatScheduleEdit, FeatJobControl}},
		"carol": {feats: []string{FeatScheduleEdit, FeatJobControl}, groups: []string{"nachtschicht"}},
		"boss":  {feats: []string{FeatScheduleEdit, FeatJobControl, FeatManageAll, FeatAssign, FeatView}},
	}
	h := newHEnvWith(t, acc)
	rec := h.call(t, "POST", "/api/v1/ingest/schedules", scheduleBody("Nachrichten"))
	if rec.Code != 201 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	d := dec(t, rec)
	sc := d["schedule"].(map[string]any)
	id := sc["id"].(string)
	if sc["owner"] != "alice" {
		t.Fatalf("Verantwortlich ist standardmäßig der Ersteller: %v", sc["owner"])
	}
	jobs := d["jobs"].([]any)
	if len(jobs) == 0 || jobs[0].(map[string]any)["owner"] != "alice" {
		t.Fatalf("Aufträge erben den Verantwortlichen: %v", jobs)
	}
	jobID := jobs[0].(map[string]any)["id"].(string)

	// bob ist nicht verantwortlich → 403 beim Ändern, Beenden und Auftragssteuerung
	h.user = "bob"
	upd := scheduleBody("Nachrichten neu")
	if rec := h.call(t, "PUT", "/api/v1/ingest/schedules/"+id, upd); rec.Code != 403 {
		t.Errorf("bob PUT: %d %s", rec.Code, rec.Body)
	}
	if rec := h.call(t, "DELETE", "/api/v1/ingest/schedules/"+id, nil); rec.Code != 403 {
		t.Errorf("bob DELETE: %d", rec.Code)
	}
	if rec := h.call(t, "POST", "/api/v1/ingest/jobs/"+jobID+"/cancel", map[string]any{}); rec.Code != 403 {
		t.Errorf("bob cancel: %d", rec.Code)
	}
	// ohne „alle sehen“ sieht bob die fremde Aufnahme weder in der Liste noch einzeln
	if l := dec(t, h.call(t, "GET", "/api/v1/ingest/schedules", nil))["schedules"].([]any); containsID(l, id) {
		t.Errorf("bob sieht fremden Zeitplan")
	}
	if rec := h.call(t, "GET", "/api/v1/ingest/schedules/"+id, nil); rec.Code != 403 {
		t.Errorf("bob GET einzeln: %d", rec.Code)
	}
	// bob darf sich nicht selbst fremd zuweisen lassen / andere eintragen
	b := scheduleBody("Eigene")
	b["owner"] = "alice"
	h.user = "alice"
	// (alice trägt sich selbst ein: erlaubt; eine andere Person eintragen: nur mit „Verantwortliche festlegen“)
	b["owner"] = "bob"
	if rec := h.call(t, "POST", "/api/v1/ingest/schedules", b); rec.Code != 403 {
		t.Errorf("fremd zuweisen ohne Recht: %d %s", rec.Code, rec.Body)
	}
	// Chef darf alles, auch zuweisen: an die Gruppe → Mitglied carol darf nun steuern, bob weiterhin nicht
	h.user = "boss"
	upd["ownerGroup"] = "nachtschicht"
	upd["expectedRevision"] = sc["revision"]
	if rec := h.call(t, "PUT", "/api/v1/ingest/schedules/"+id, upd); rec.Code != 200 {
		t.Fatalf("boss PUT: %d %s", rec.Code, rec.Body)
	}
	got := dec(t, h.call(t, "GET", "/api/v1/ingest/schedules/"+id, nil))["schedule"].(map[string]any)
	if got["ownerGroup"] != "nachtschicht" {
		t.Fatalf("Gruppe nicht gespeichert: %v", got)
	}
	// Die neu berechneten Aufträge gehören der Gruppe → Aufgabenliste von carol enthält sie, die von bob nicht
	ctx := context.Background()
	taskIDs := func(user string, groups ...string) map[string]bool {
		ts, err := h.m.Tasks(ctx, module.Identity{User: user, Groups: groups, Has: func(string) bool { return false }})
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]bool{}
		for _, x := range ts {
			out[x.Title] = true
		}
		return out
	}
	*h.clock = h.clock.Add(0)
	if !taskIDs("carol", "nachtschicht")["Nachrichten neu"] {
		t.Errorf("carol (Gruppe) sieht die Aufgabe nicht: %v", taskIDs("carol", "nachtschicht"))
	}
	if taskIDs("bob")["Nachrichten neu"] {
		t.Errorf("bob sieht eine fremde Aufgabe")
	}
	h.user = "carol"
	if rec := h.call(t, "GET", "/api/v1/ingest/schedules/"+id, nil); rec.Code != 200 {
		t.Errorf("carol GET: %d", rec.Code)
	}
	upd["expectedRevision"] = got["revision"]
	upd["name"] = "Nachrichten von Carol"
	if rec := h.call(t, "PUT", "/api/v1/ingest/schedules/"+id, upd); rec.Code != 200 {
		t.Errorf("carol PUT als Gruppenmitglied: %d %s", rec.Code, rec.Body)
	}
}

func containsID(l []any, id string) bool {
	for _, x := range l {
		if x.(map[string]any)["id"] == id {
			return true
		}
	}
	return false
}
