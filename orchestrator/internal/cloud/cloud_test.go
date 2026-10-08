package cloud

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

type fakeEnv struct {
	tokens   int
	agents   map[string]string // cloud host id -> agent host id
	counts   map[string]int    // agent host id -> instances
	draining map[string]bool
}

func newEnv() *fakeEnv {
	return &fakeEnv{agents: map[string]string{}, counts: map[string]int{}, draining: map[string]bool{}}
}
func (e *fakeEnv) NewBootstrapToken(time.Duration) (string, error) {
	e.tokens++
	return "tok" + string(rune('0'+e.tokens)), nil
}
func (e *fakeEnv) AgentRegistered(id string) (string, bool) { a, ok := e.agents[id]; return a, ok }
func (e *fakeEnv) InstanceCount(a string) (int, error)      { return e.counts[a], nil }
func (e *fakeEnv) SetDraining(a string, on bool)            { e.draining[a] = on }

func setup(t *testing.T) (*Manager, *MockProvider, *fakeEnv, *fakeClock) {
	t.Helper()
	clk := &fakeClock{t: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	p := NewMockProvider()
	p.Now = clk.now
	env := newEnv()
	m := NewManager(p, "dep1", []Pool{{
		Name: "burst", Region: "r1", InstanceType: "m.medium", Min: 0, Max: 2,
		UserDataTemplate: "token={{token}} host={{host}}", IdleAfter: 5 * time.Minute, MaxLifetime: 2 * time.Hour,
	}}, env, clk.now)
	return m, p, env, clk
}

func TestHostLifecycleToReadyAndDrainedTermination(t *testing.T) {
	m, p, env, clk := setup(t)
	ctx := context.Background()
	h, err := m.Provision(ctx, "burst")
	if err != nil || h.State != HostBooting {
		t.Fatalf("provision: %+v %v", h, err)
	}
	m.Tick(ctx)
	if m.Hosts()[0].State != HostBooting {
		t.Fatal("must still be booting before BootDelay")
	}
	clk.advance(2 * time.Minute)
	m.Tick(ctx)
	if m.Hosts()[0].State != HostWaitingAgent {
		t.Fatalf("want waiting-agent, got %s", m.Hosts()[0].State)
	}
	env.agents[h.ID] = "agent-1"
	m.Tick(ctx)
	got := m.Hosts()[0]
	if got.State != HostReady || got.AgentHostID != "agent-1" {
		t.Fatalf("want ready: %+v", got)
	}
	// Last drauf → nicht leerlaufend; Last weg → leerlaufend nach IdleAfter.
	env.counts["agent-1"] = 2
	m.Tick(ctx)
	if len(m.IdleHosts()) != 0 {
		t.Fatal("busy host must not be idle")
	}
	env.counts["agent-1"] = 0
	m.Tick(ctx)
	clk.advance(4 * time.Minute)
	if len(m.IdleHosts()) != 0 {
		t.Fatal("not idle long enough")
	}
	clk.advance(2 * time.Minute)
	if len(m.IdleHosts()) != 1 {
		t.Fatal("must be idle after IdleAfter")
	}
	// Abbau: Draining sperrt Placement; mit Last bleibt der Host, ohne Last wird er beendet.
	env.counts["agent-1"] = 1
	if err := m.Release(ctx, h.ID); err != nil {
		t.Fatal(err)
	}
	if !env.draining["agent-1"] {
		t.Fatal("draining must block placement")
	}
	m.Tick(ctx)
	if m.Hosts()[0].State != HostDraining {
		t.Fatal("must wait for the instance to leave")
	}
	env.counts["agent-1"] = 0
	m.Tick(ctx)
	if m.Hosts()[0].State != HostTerminated {
		t.Fatalf("want terminated, got %s", m.Hosts()[0].State)
	}
	if st, _ := p.Describe(ctx, h.Ref); st != StateTerminated {
		t.Fatalf("provider state %s", st)
	}
}

func TestProvisionRespectsMaxAndUnknownPool(t *testing.T) {
	m, _, _, _ := setup(t)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if _, err := m.Provision(ctx, "burst"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.Provision(ctx, "burst"); err == nil || !strings.Contains(err.Error(), "maximum") {
		t.Fatalf("want max error, got %v", err)
	}
	if _, err := m.Provision(ctx, "nope"); err == nil {
		t.Fatal("unknown pool must fail")
	}
}

func TestUserDataGetsTokenAndHostID(t *testing.T) {
	m, p, _, _ := setup(t)
	h, err := m.Provision(context.Background(), "burst")
	if err != nil {
		t.Fatal(err)
	}
	if ud := p.UserDataOf(h.Ref.ID); ud != "token=tok1 host="+h.ID {
		t.Fatalf("user data %q", ud)
	}
	// Die Instanz trägt die Tags; User-Data selbst prüfen wir über den ersetzten Wert im Request.
	list, _ := p.List(context.Background(), map[string]string{TagHost: h.ID})
	if len(list) != 1 || list[0].Tags[TagDeployment] != "dep1" || list[0].Tags[TagPool] != "burst" {
		t.Fatalf("tags: %+v", list)
	}
}

func TestBootTimeoutFailsAndTerminates(t *testing.T) {
	m, p, _, clk := setup(t)
	ctx := context.Background()
	p.BootDelay = time.Hour // bootet "nie"
	h, _ := m.Provision(ctx, "burst")
	clk.advance(11 * time.Minute)
	m.Tick(ctx)
	got := m.Hosts()[0]
	if got.State != HostFailed || !strings.Contains(got.Err, "boot timeout") {
		t.Fatalf("%+v", got)
	}
	if st, _ := p.Describe(ctx, h.Ref); st != StateTerminated {
		t.Fatal("failed boot must be terminated so it stops costing money")
	}
}

func TestAgentTimeoutFailsAndTerminates(t *testing.T) {
	m, p, _, clk := setup(t)
	ctx := context.Background()
	h, _ := m.Provision(ctx, "burst")
	clk.advance(2 * time.Minute)
	m.Tick(ctx) // running → waiting-agent
	clk.advance(10 * time.Minute)
	m.Tick(ctx)
	if m.Hosts()[0].State != HostFailed {
		t.Fatalf("got %s", m.Hosts()[0].State)
	}
	if st, _ := p.Describe(ctx, h.Ref); st != StateTerminated {
		t.Fatal("must be terminated")
	}
}

func TestReleaseWhileBootingTerminatesImmediately(t *testing.T) {
	m, p, _, _ := setup(t)
	ctx := context.Background()
	h, _ := m.Provision(ctx, "burst")
	if err := m.Release(ctx, h.ID); err != nil {
		t.Fatal(err)
	}
	if m.Hosts()[0].State != HostTerminated {
		t.Fatal("must be terminated")
	}
	if st, _ := p.Describe(ctx, h.Ref); st != StateTerminated {
		t.Fatal("provider")
	}
}

func TestFailedTerminateKeepsDrainingAndRetries(t *testing.T) {
	m, p, env, clk := setup(t)
	ctx := context.Background()
	h, _ := m.Provision(ctx, "burst")
	clk.advance(2 * time.Minute)
	m.Tick(ctx)
	env.agents[h.ID] = "a"
	m.Tick(ctx)
	_ = m.Release(ctx, h.ID)
	p.FailNext(errors.New("api down"))
	m.Tick(ctx)
	got := m.Hosts()[0]
	if got.State != HostDraining || got.Err == "" {
		t.Fatalf("must stay draining with error: %+v", got)
	}
	m.Tick(ctx)
	if m.Hosts()[0].State != HostTerminated {
		t.Fatal("must retry and succeed")
	}
}

func TestReconcileAdoptsUnknownAndMarksLost(t *testing.T) {
	m, p, _, clk := setup(t)
	ctx := context.Background()
	// Instanz, die der Manager nicht kennt (z. B. nach Orchestrator-Neustart).
	orphan, _ := p.Launch(ctx, LaunchRequest{InstanceType: "m.medium", Tags: map[string]string{TagDeployment: "dep1", TagPool: "burst", TagHost: "orphan-1"}})
	// Fremde Instanz eines anderen Deployments wird ignoriert.
	_, _ = p.Launch(ctx, LaunchRequest{InstanceType: "m.medium", Tags: map[string]string{TagDeployment: "other", TagHost: "x"}})
	h, _ := m.Provision(ctx, "burst")
	rep, err := m.Reconcile(ctx)
	if err != nil || len(rep.Adopted) != 1 || rep.Adopted[0] != "orphan-1" || len(rep.Lost) != 0 {
		t.Fatalf("%+v %v", rep, err)
	}
	// Außerhalb beendet → verloren.
	_ = p.Terminate(ctx, h.Ref)
	rep, _ = m.Reconcile(ctx)
	if len(rep.Lost) != 1 || rep.Lost[0] != h.ID {
		t.Fatalf("%+v", rep)
	}
	_ = orphan
	_ = clk
}

func TestReconcileGraceForFreshInstancesNotYetListed(t *testing.T) {
	m, p, _, clk := setup(t)
	ctx := context.Background()
	h, _ := m.Provision(ctx, "burst")
	// Der Anbieter listet sie (noch) nicht: simuliert durch Entfernen aus der Mock-Liste.
	p.mu.Lock()
	delete(p.instances, h.Ref.ID)
	p.mu.Unlock()
	rep, _ := m.Reconcile(ctx)
	if len(rep.Lost) != 0 {
		t.Fatal("fresh instance must get a grace period")
	}
	clk.advance(3 * time.Minute)
	rep, _ = m.Reconcile(ctx)
	if len(rep.Lost) != 1 {
		t.Fatal("after the grace period it counts as lost")
	}
}

func TestLifetimeExceededIsFlagged(t *testing.T) {
	m, _, env, clk := setup(t)
	ctx := context.Background()
	h, _ := m.Provision(ctx, "burst")
	clk.advance(2 * time.Minute)
	m.Tick(ctx)
	env.agents[h.ID] = "a"
	m.Tick(ctx)
	clk.advance(3 * time.Hour)
	m.Tick(ctx)
	if !m.Hosts()[0].LifetimeOver {
		t.Fatal("must flag max lifetime")
	}
}

func TestMockActualCostBillsPerSecondWithMinimumAndLag(t *testing.T) {
	_, p, _, clk := setup(t)
	ctx := context.Background()
	start := clk.now()
	ref, _ := p.Launch(ctx, LaunchRequest{InstanceType: "g.large", Tags: map[string]string{TagDeployment: "dep1"}}) // 0,90/h
	clk.advance(30 * time.Second)
	_ = p.Terminate(ctx, ref) // 30 s → Mindestabrechnung 60 s
	clk.advance(10 * time.Hour)
	rep, err := p.ActualCost(ctx, start, clk.now(), map[string]string{TagDeployment: "dep1"})
	if err != nil {
		t.Fatal(err)
	}
	want := 0.90 * 60.0 / 3600
	if math.Abs(rep.Amount-want) > 1e-6 || rep.Currency != "EUR" {
		t.Fatalf("amount %v want %v (%s)", rep.Amount, want, rep.Currency)
	}
	if !rep.AsOf.Equal(clk.now().Add(-6 * time.Hour)) {
		t.Fatalf("AsOf %v", rep.AsOf)
	}
	// Laufende Instanz: nur bis AsOf abgerechnet (Lag), nie bis jetzt.
	ref2, _ := p.Launch(ctx, LaunchRequest{InstanceType: "m.medium", Tags: map[string]string{TagDeployment: "dep2"}})
	_ = ref2
	clk.advance(10 * time.Hour)
	rep, _ = p.ActualCost(ctx, clk.now().Add(-10*time.Hour), clk.now(), map[string]string{TagDeployment: "dep2"})
	if math.Abs(rep.Amount-0.05*4) > 1e-6 { // 10 h − 6 h Verzögerung = 4 h
		t.Fatalf("running cost %v", rep.Amount)
	}
}
