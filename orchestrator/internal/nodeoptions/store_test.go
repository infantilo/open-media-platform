package nodeoptions

import (
	"reflect"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func TestStoreSetOverwriteResetAndScopes(t *testing.T) {
	s := NewStore(dbtest.Open(t))
	if err := s.Set(ScopeType, "omp-mxf-player", "OMP_MEDIA_DIR", "/mnt/a", "admin"); err != nil {
		t.Fatal(err)
	}
	_ = s.Set(ScopeType, "omp-mxf-player", "OMP_WIDTH", "1280", "admin")
	_ = s.Set(ScopeInstance, "inst1", "OMP_MEDIA_DIR", "/mnt/b", "admin")
	_ = s.Set(ScopeType, "omp-mxf-player", "OMP_MEDIA_DIR", "/mnt/c", "admin") // überschreiben

	got, _ := s.Values(ScopeType, "omp-mxf-player")
	if !reflect.DeepEqual(got, map[string]string{"OMP_MEDIA_DIR": "/mnt/c", "OMP_WIDTH": "1280"}) {
		t.Fatalf("Typ-Werte: %v", got)
	}
	if inst, _ := s.Values(ScopeInstance, "inst1"); inst["OMP_MEDIA_DIR"] != "/mnt/b" {
		t.Fatalf("Instanz-Wert: %v", inst)
	}
	if all, _ := s.AllInstanceValues(); all["inst1"]["OMP_MEDIA_DIR"] != "/mnt/b" || len(all) != 1 {
		t.Fatalf("AllInstanceValues: %v", all)
	}
	_ = s.Set(ScopeType, "omp-mxf-player", "OMP_WIDTH", "", "admin") // leer = Standard
	if got, _ := s.Values(ScopeType, "omp-mxf-player"); len(got) != 1 {
		t.Fatalf("nach Zurücksetzen: %v", got)
	}
	_ = s.Set(ScopeInstance, "alt", "OMP_WIDTH", "640", "admin")
	if err := s.MoveInstance("alt", "neu"); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.Values(ScopeInstance, "neu"); v["OMP_WIDTH"] != "640" {
		t.Fatalf("MoveInstance: %v", v)
	}
	if v, _ := s.Values(ScopeInstance, "alt"); len(v) != 0 {
		t.Fatalf("alte ID muss leer sein: %v", v)
	}
	_ = s.DeleteInstance("inst1")
	if inst, _ := s.Values(ScopeInstance, "inst1"); len(inst) != 0 {
		t.Fatalf("Instanz gelöscht: %v", inst)
	}
}
