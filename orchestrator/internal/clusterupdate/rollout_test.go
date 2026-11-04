package clusterupdate

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
)

type fakeMember struct {
	version   string
	started   time.Time
	applyErr  error
	fetchErr  error
	applied   int
	neverUp   bool // nach Apply keine neue Version
	unreach   bool
	fetchedID string
}

type fakeCluster struct {
	ids     []string
	leader  string
	members map[string]*fakeMember
	log     []string
	clock   time.Time
}

func newFakeCluster(ids ...string) *fakeCluster {
	f := &fakeCluster{ids: ids, leader: ids[0], members: map[string]*fakeMember{}, clock: time.Unix(1_800_000_000, 0)}
	for _, id := range ids {
		f.members[id] = &fakeMember{version: "1.0", started: f.clock.Add(-time.Hour)}
	}
	return f
}

func addr(id string) string { return "http://" + id }

func (f *fakeCluster) status(id string) cluster.Status {
	st := cluster.Status{NodeID: id, State: "Follower", LeaderID: f.leader, AppliedIndex: 5, LastIndex: 5, PeerHTTPAddrs: map[string]string{}}
	if id == f.leader {
		st.State, st.IsLeader = "Leader", true
	}
	for _, i := range f.ids {
		st.Peers = append(st.Peers, cluster.Peer{ID: i, Suffrage: "Voter"})
		st.PeerHTTPAddrs[i] = addr(i)
	}
	return st
}

func (f *fakeCluster) idOf(a string) string { return strings.TrimPrefix(a, "http://") }

// Members
func (f *fakeCluster) Info(_ context.Context, a string) (Info, error) {
	m := f.members[f.idOf(a)]
	if m.unreach {
		return Info{}, errors.New("connection refused")
	}
	return Info{Version: m.version, StartedAt: m.started, Status: f.status(f.idOf(a))}, nil
}
func (f *fakeCluster) Fetch(_ context.Context, a, pkg string) error {
	m := f.members[f.idOf(a)]
	if m.fetchErr != nil {
		return m.fetchErr
	}
	m.fetchedID = pkg
	return nil
}
func (f *fakeCluster) Apply(_ context.Context, a string, k Kind, pkg, ver string, term uint64) error {
	id := f.idOf(a)
	m := f.members[id]
	if m.applyErr != nil {
		return m.applyErr
	}
	m.applied++
	f.log = append(f.log, "apply:"+id)
	if m.neverUp {
		return nil
	}
	f.clock = f.clock.Add(time.Minute)
	m.started = f.clock
	if k == KindUpdate {
		m.version = ver
	}
	return nil
}

// Local: Sicht des aktuellen Leaders (der Treiber läuft immer auf dem Leader).
func (f *fakeCluster) Status() cluster.Status { return f.status(f.leader) }
func (f *fakeCluster) IsLeader() bool         { return true }
func (f *fakeCluster) Term() uint64           { return 3 }
func (f *fakeCluster) TransferLeadership(id string) error {
	f.log = append(f.log, "transfer:"+f.leader+"->"+id)
	f.leader = id
	return nil
}

func newDriver(f *fakeCluster, st Store) *Driver {
	return &Driver{Store: st, Members: f, Local: f, VerifyTimeout: 50 * time.Millisecond, PollInterval: time.Millisecond}
}

func runAll(t *testing.T, d *Driver, st Store) *Rollout {
	t.Helper()
	for i := 0; i < 40; i++ {
		if err := d.Step(context.Background()); err != nil {
			t.Fatal(err)
		}
		r, _ := st.Latest()
		if r != nil && r.State != StateRunning {
			return r
		}
	}
	r, _ := st.Latest()
	t.Fatalf("Rollout nicht beendet: %+v", r)
	return nil
}

func startUpdate(t *testing.T, d *Driver) *Rollout {
	t.Helper()
	r, findings, err := d.Start(context.Background(), StartParams{Kind: KindUpdate, PackageID: "2.0-abc", TargetVersion: "2.0", RollingSafe: true})
	if err != nil || len(findings) > 0 {
		t.Fatalf("Start: %v %v", err, findings)
	}
	return r
}

func TestRolloutUpdatesFollowersThenTransfersThenLeaderLast(t *testing.T) {
	f := newFakeCluster("a", "b", "c") // a ist Leader
	st := &MemStore{}
	d := newDriver(f, st)
	startUpdate(t, d)
	r := runAll(t, d, st)
	if r.State != StateDone {
		t.Fatalf("state = %s (%s)", r.State, r.Error)
	}
	want := "apply:b apply:c transfer:a->b apply:a"
	if got := strings.Join(f.log, " "); got != want {
		t.Fatalf("Reihenfolge = %q, want %q", got, want)
	}
	for id, m := range f.members {
		if m.version != "2.0" || m.applied != 1 {
			t.Errorf("%s: version %s applied %d", id, m.version, m.applied)
		}
	}
}

func TestRolloutHaltsOnFailureAndResumes(t *testing.T) {
	f := newFakeCluster("a", "b", "c")
	f.members["c"].applyErr = errors.New("supervisor beschaeftigt")
	st := &MemStore{}
	d := newDriver(f, st)
	startUpdate(t, d)
	r := runAll(t, d, st)
	if r.State != StateFailed || !strings.Contains(r.Error, "c:") {
		t.Fatalf("state = %s err = %q", r.State, r.Error)
	}
	if f.members["a"].applied != 0 || f.members["a"].version != "1.0" || f.members["b"].version != "2.0" {
		t.Fatalf("Reststand falsch: a=%+v b=%+v", f.members["a"], f.members["b"])
	}
	// weiter ohne Fortsetzen passiert nichts
	_ = d.Step(context.Background())
	if f.members["a"].applied != 0 {
		t.Fatal("angehaltener Rollout lief weiter")
	}
	f.members["c"].applyErr = nil
	if err := d.Resume(); err != nil {
		t.Fatal(err)
	}
	r = runAll(t, d, st)
	if r.State != StateDone || f.members["a"].version != "2.0" || f.members["b"].applied != 1 {
		t.Fatalf("nach Fortsetzen: %s %s b=%d", r.State, r.Error, f.members["b"].applied)
	}
}

func TestRolloutVerifyTimeoutFailsWhenVersionNeverArrives(t *testing.T) {
	f := newFakeCluster("a", "b", "c")
	f.members["b"].neverUp = true
	st := &MemStore{}
	d := newDriver(f, st)
	startUpdate(t, d)
	r := runAll(t, d, st)
	if r.State != StateFailed || !strings.Contains(r.Error, "nicht bestaetigt") {
		t.Fatalf("state = %s err = %q", r.State, r.Error)
	}
	if f.members["c"].applied != 0 {
		t.Fatal("zweites Mitglied angefasst trotz Fehler am ersten")
	}
}

func TestNewLeaderContinuesFromDatabaseState(t *testing.T) {
	f := newFakeCluster("a", "b", "c")
	st := &MemStore{}
	d1 := newDriver(f, st)
	r := startUpdate(t, d1)
	// Erster Treiber stirbt mitten in Schritt b (Zustand "verifying", Apply schon ausgeloest).
	f.members["b"].version = "2.0"
	f.members["b"].applied = 1
	r.Steps[1].State = StepVerifying
	r.Steps[1].AppliedAt = f.clock
	_ = st.Save(r)
	f.leader = "c" // neuer Leader
	d2 := newDriver(f, st)
	out := runAll(t, d2, st)
	if out.State != StateDone {
		t.Fatalf("state = %s (%s)", out.State, out.Error)
	}
	if f.members["b"].applied != 1 {
		t.Fatalf("b doppelt angewendet: %d", f.members["b"].applied)
	}
	if f.members["a"].version != "2.0" || f.members["c"].version != "2.0" {
		t.Fatal("Rest nicht aktualisiert")
	}
}

func TestStartBlocksTwoMembersUnreachableNonRollingSafeAndSecondRollout(t *testing.T) {
	f2 := newFakeCluster("a", "b")
	d := newDriver(f2, &MemStore{})
	_, findings, err := d.Start(context.Background(), StartParams{Kind: KindRestart})
	if err != nil || len(findings) == 0 || !strings.Contains(strings.Join(findings, "|"), "cluster-quorum") {
		t.Fatalf("2 Mitglieder: %v %v", findings, err)
	}

	f := newFakeCluster("a", "b", "c")
	f.members["c"].unreach = true
	d = newDriver(f, &MemStore{})
	_, findings, _ = d.Start(context.Background(), StartParams{Kind: KindRestart})
	if len(findings) != 1 || !strings.Contains(findings[0], "c: nicht erreichbar") {
		t.Fatalf("unerreichbar: %v", findings)
	}

	f = newFakeCluster("a", "b", "c")
	st := &MemStore{}
	d = newDriver(f, st)
	_, findings, _ = d.Start(context.Background(), StartParams{Kind: KindUpdate, PackageID: "p", TargetVersion: "2.0"})
	if len(findings) != 1 || !strings.Contains(findings[0], "rollingSafe") {
		t.Fatalf("ohne rollingSafe: %v", findings)
	}
	startUpdate(t, d)
	if _, _, err := d.Start(context.Background(), StartParams{Kind: KindRestart}); !errors.Is(err, ErrActive) {
		t.Fatalf("zweiter Rollout: %v", err)
	}
}

func TestRestartKindRestartsEveryoneLeaderLast(t *testing.T) {
	f := newFakeCluster("a", "b", "c")
	st := &MemStore{}
	d := newDriver(f, st)
	if _, fi, err := d.Start(context.Background(), StartParams{Kind: KindRestart}); err != nil || len(fi) > 0 {
		t.Fatalf("%v %v", err, fi)
	}
	r := runAll(t, d, st)
	if r.State != StateDone {
		t.Fatalf("%s %s", r.State, r.Error)
	}
	if got := strings.Join(f.log, " "); got != "apply:b apply:c transfer:a->b apply:a" {
		t.Fatalf("Reihenfolge %q", got)
	}
}

func TestQuorumGateStopsWhenAnotherMemberIsDown(t *testing.T) {
	f := newFakeCluster("a", "b", "c")
	st := &MemStore{}
	d := newDriver(f, st)
	startUpdate(t, d)
	f.members["c"].unreach = true // faellt nach der Vorpruefung aus
	r := runAll(t, d, st)
	if r.State != StateFailed || !strings.Contains(r.Error, "nicht erreichbar") {
		t.Fatalf("%s %q", r.State, r.Error)
	}
	if f.members["b"].applied != 0 {
		t.Fatal("b angefasst, obwohl c fehlt (Mehrheit waere weg)")
	}
}
