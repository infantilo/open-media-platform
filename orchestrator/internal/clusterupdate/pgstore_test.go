package clusterupdate

import (
	"errors"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func TestPGStoreRoundtripAndSingleActive(t *testing.T) {
	db := dbtest.Open(t)
	_, _ = db.Exec(`DELETE FROM cluster_rollouts`)
	s := NewPGStore(db)
	now := time.Now().UTC().Truncate(time.Millisecond)
	r := &Rollout{ID: "ro-1", Kind: KindUpdate, PackageID: "p", TargetVersion: "2.0", State: StateRunning, Created: now, Updated: now,
		Steps: []Step{{NodeID: "a", HTTPAddr: "http://a", State: StepPending, Updated: now}}}
	if err := s.Create(r); err != nil {
		t.Fatal(err)
	}
	if err := s.Create(&Rollout{ID: "ro-2", Kind: KindRestart, State: StateRunning, Created: now, Updated: now, Steps: []Step{}}); !errors.Is(err, ErrActive) {
		t.Fatalf("zweiter aktiver Rollout: %v", err)
	}
	r.Steps[0].State = StepDone
	r.State = StateDone
	if err := s.Save(r); err != nil {
		t.Fatal(err)
	}
	if a, _ := s.Active(); a != nil {
		t.Fatalf("fertiger Rollout noch aktiv: %+v", a)
	}
	l, err := s.Latest()
	if err != nil || l == nil || l.ID != "ro-1" || l.Steps[0].State != StepDone {
		t.Fatalf("Latest: %+v %v", l, err)
	}
	if err := s.Create(&Rollout{ID: "ro-3", Kind: KindRestart, State: StateRunning, Created: now, Updated: now, Steps: []Step{}}); err != nil {
		t.Fatalf("nach Ende wieder moeglich: %v", err)
	}
}
