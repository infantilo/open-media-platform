package locations

import (
	"errors"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func TestInputValidate(t *testing.T) {
	ok := Input{Name: " Medien A ", Path: "/mnt/medien/../medien/"}
	if err := ok.Validate(); err == nil {
		t.Fatal("„..“ muss abgelehnt werden")
	}
	good := Input{Name: " Medien A ", Path: "/mnt/medien/"}
	if err := good.Validate(); err != nil || good.Name != "Medien A" || good.Path != "/mnt/medien" {
		t.Fatalf("%+v %v", good, err)
	}
	for _, bad := range []Input{{Name: "", Path: "/a"}, {Name: "x", Path: "relativ"}, {Name: "x", Path: ""}, {Name: "a\nb", Path: "/a"}} {
		b := bad
		if err := b.Validate(); !errors.Is(err, ErrValidation) {
			t.Errorf("%+v sollte ungültig sein: %v", bad, err)
		}
	}
}

func TestWithin(t *testing.T) {
	for _, c := range []struct {
		root, v string
		want    bool
	}{
		{"/mnt/m", "/mnt/m", true}, {"/mnt/m", "/mnt/m/sub/x.mxf", true}, {"/mnt/m", "/mnt/mehr", false},
		{"/mnt/m/", "/mnt/m/a", true}, {"/", "/etc", true}, {"", "/a", false}, {"/a", "", false},
	} {
		if got := Within(c.root, c.v); got != c.want {
			t.Errorf("Within(%q,%q)=%v", c.root, c.v, got)
		}
	}
}

func TestStoreCreateUpdateDuplicatesDelete(t *testing.T) {
	s := NewStore(dbtest.Open(t))
	all, _ := s.List()
	for _, l := range all {
		_ = s.Delete(l.ID)
	}
	a, err := s.Create(Input{Name: "Medien A", Path: "/mnt/a"}, "admin")
	if err != nil || a.Status != StatusActive {
		t.Fatalf("%+v %v", a, err)
	}
	if _, err := s.Create(Input{Name: "Medien A", Path: "/mnt/andere"}, "admin"); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("doppelter Name: %v", err)
	}
	if _, err := s.Create(Input{Name: "Zweit", Path: "/mnt/a"}, "admin"); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("doppelter Pfad auf gleichem Host: %v", err)
	}
	if _, err := s.Create(Input{Name: "Zweit", Path: "/mnt/a", HostID: "h1"}, "admin"); err != nil {
		t.Fatalf("gleicher Pfad auf anderem Host ist erlaubt: %v", err)
	}
	u, err := s.Update(a.ID, "Medien Neu", "Notiz", StatusDeprecated)
	if err != nil || u.Name != "Medien Neu" || u.Status != StatusDeprecated || u.Path != "/mnt/a" {
		t.Fatalf("%+v %v", u, err)
	}
	if _, err := s.Update(a.ID, "x", "", "kaputt"); !errors.Is(err, ErrValidation) {
		t.Fatalf("Status: %v", err)
	}
	if err := s.Delete(a.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("zweites Löschen: %v", err)
	}
	if _, err := s.Get("nix"); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	rest, _ := s.List()
	for _, l := range rest {
		_ = s.Delete(l.ID)
	}
}
