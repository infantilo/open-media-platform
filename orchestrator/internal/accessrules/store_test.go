package accessrules

import (
	"errors"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	db := dbtest.Open(t)
	clean := func() {
		if _, err := db.Exec(`DELETE FROM access_rules`); err != nil {
			t.Fatal(err)
		}
	}
	clean()
	t.Cleanup(clean)
	return NewStore(db)
}

func TestStoreCreateListUpdateDelete(t *testing.T) {
	s := testStore(t)
	r, err := s.Create(Rule{SubjectType: SubjectGroup, Subject: "g1", Kind: KindSink, Action: ActionRoute, Effect: EffectDeny, SelectorType: SelNode, SelectorValue: "n1", Note: "Test"}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if r.ID == "" || r.CreatedBy != "admin" || r.CreatedAt == "" {
		t.Fatalf("Regel = %+v", r)
	}
	list, _ := s.List()
	if len(list) != 1 || list[0].ID != r.ID {
		t.Fatalf("List = %+v", list)
	}
	r.Effect = EffectAllow
	up, err := s.Update(r.ID, r)
	if err != nil || up.Effect != EffectAllow {
		t.Fatalf("Update = %+v, %v", up, err)
	}
	if list, _ = s.List(); list[0].Effect != EffectAllow {
		t.Fatal("Cache nach Update nicht aktuell")
	}
	if _, err := s.Update("gibts-nicht", r); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Update(unbekannt) = %v", err)
	}
	if _, err := s.Create(Rule{SubjectType: "x"}, "admin"); !errors.Is(err, ErrValidation) {
		t.Fatalf("Create(ungültig) = %v", err)
	}
	if err := s.Delete(r.ID); err != nil {
		t.Fatal(err)
	}
	if list, _ = s.List(); len(list) != 0 {
		t.Fatalf("nach Delete: %+v", list)
	}
}

func TestEngineCollectsGlobalUserAndGroupRules(t *testing.T) {
	s := testStore(t)
	mk := func(st, subj, node string) {
		if _, err := s.Create(Rule{SubjectType: st, Subject: subj, Kind: KindSource, Action: ActionSee, Effect: EffectAllow, SelectorType: SelNode, SelectorValue: node}, "t"); err != nil {
			t.Fatal(err)
		}
	}
	mk(SubjectGlobal, "", "g")
	mk(SubjectUser, "anna", "u")
	mk(SubjectUser, "ben", "fremd")
	mk(SubjectGroup, "grp1", "gr")
	mk(SubjectGroup, "grp9", "andere")
	e := &Engine{Store: s, GroupIDs: func(u string) []string {
		if u == "anna" {
			return []string{"grp1"}
		}
		return nil
	}}
	p, err := e.PolicyFor("anna")
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"g", "u", "gr"} {
		if !p.Visible(KindSource, Endpoint{NodeID: n}).Allowed {
			t.Errorf("Node %s sollte für anna sichtbar sein", n)
		}
	}
	for _, n := range []string{"fremd", "andere", "sonst"} {
		if p.Visible(KindSource, Endpoint{NodeID: n}).Allowed {
			t.Errorf("Node %s darf für anna nicht sichtbar sein", n)
		}
	}
	other, _ := e.PolicyFor("carl")
	if !other.Visible(KindSource, Endpoint{NodeID: "g"}).Allowed || other.Visible(KindSource, Endpoint{NodeID: "u"}).Allowed {
		t.Fatal("carl bekommt nur die globale Regel")
	}
	if err := s.DeleteForSubject(SubjectUser, "anna"); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.List(); len(list) != 4 {
		t.Fatalf("nach DeleteForSubject: %d Regeln, want 4", len(list))
	}
}
