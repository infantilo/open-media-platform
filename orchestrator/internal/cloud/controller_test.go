package cloud

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
)

type memRes struct{ list []Reservation }

func (m *memRes) List(from, to time.Time) ([]Reservation, error) {
	var out []Reservation
	for _, r := range m.list {
		if r.To.After(from) && r.From.Before(to) {
			out = append(out, r)
		}
	}
	return out, nil
}
func (m *memRes) Create(in ReservationInput, by string) (Reservation, error) {
	r := Reservation{ID: "r1", Pool: in.Pool, HostCount: in.HostCount, From: in.From, To: in.To}
	m.list = append(m.list, r)
	return r, nil
}
func (m *memRes) Delete(string) error { return nil }

func ctrlSetup(t *testing.T) (*PoolController, *Manager, *MockProvider, *SimEnv, *memRes, *fakeClock) {
	t.Helper()
	clk := &fakeClock{t: time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)}
	p := NewMockProvider()
	p.Now = clk.now
	p.BootDelay = 2 * time.Minute
	env := NewSimEnv(clk.now, 30*time.Second)
	m := NewManager(p, "dep", []Pool{{Name: "burst", Region: "r", InstanceType: "m.medium", Min: 0, Max: 3, IdleAfter: 2 * time.Minute, UserDataTemplate: "{{token}}"}}, env, clk.now)
	res := &memRes{}
	c := &PoolController{Manager: m, Reservations: res, Now: clk.now, Lead: 5 * time.Minute, Teardown: 5 * time.Minute}
	return c, m, p, env, res, clk
}

func states(m *Manager) map[HostState]int {
	out := map[HostState]int{}
	for _, h := range m.Hosts() {
		out[h.State]++
	}
	return out
}

func TestReservationProvisionsLeadBeforeStartAndReleasesAfterEnd(t *testing.T) {
	c, m, p, _, res, clk := ctrlSetup(t)
	ctx := context.Background()
	start := clk.now().Add(time.Hour)
	_, _ = res.Create(ReservationInput{Pool: "burst", HostCount: 2, From: start, To: start.Add(time.Hour)}, "x")

	_ = c.Tick(ctx)
	if len(m.Hosts()) != 0 {
		t.Fatal("must not provision an hour early")
	}
	clk.advance(56 * time.Minute) // 4 min vor Beginn: innerhalb Lead (5 min)
	_ = c.Tick(ctx)
	if got := states(m)[HostBooting]; got != 2 {
		t.Fatalf("want 2 booting, got %v", states(m))
	}
	// Boot + simulierte Agent-Anmeldung → bereit.
	clk.advance(3 * time.Minute)
	_ = c.Tick(ctx) // running → waiting-agent, Agent erstmals gesehen
	clk.advance(time.Minute)
	_ = c.Tick(ctx) // Agent erstmals gesehen
	clk.advance(time.Minute)
	_ = c.Tick(ctx)
	if got := states(m)[HostReady]; got != 2 {
		t.Fatalf("want 2 ready, got %v", states(m))
	}
	// Reservierungsende → überzählig; erst nach IdleAfter freigegeben.
	clk.advance(time.Hour)
	_ = c.Tick(ctx) // setzt IdleSince
	if states(m)[HostReady] != 2 {
		t.Fatal("not idle long enough yet")
	}
	clk.advance(3 * time.Minute)
	_ = c.Tick(ctx) // release → draining
	_ = c.Tick(ctx) // draining, leer → terminated
	if got := states(m)[HostTerminated]; got != 2 {
		t.Fatalf("want 2 terminated, got %v", states(m))
	}
	for _, h := range m.Hosts() {
		if st, _ := p.Describe(ctx, h.Ref); st != StateTerminated {
			t.Fatal("provider must be terminated")
		}
	}
	if n := len(c.Actions()); n < 4 {
		t.Fatalf("actions %d", n)
	}
}

func TestControllerDoesNotExceedPoolMaxAndRecordsError(t *testing.T) {
	c, m, _, _, res, clk := ctrlSetup(t)
	ctx := context.Background()
	// Reservierung über Max wäre per Validate abgelehnt; hier direkt eingeschleust → Controller bleibt bei Max.
	_, _ = res.Create(ReservationInput{Pool: "burst", HostCount: 5, From: clk.now(), To: clk.now().Add(time.Hour)}, "x")
	_ = c.Tick(ctx)
	if n := len(m.Hosts()); n != 3 {
		t.Fatalf("want 3 (max), got %d", n)
	}
	var sawErr bool
	for _, a := range c.Actions() {
		if a.Kind == "error" {
			sawErr = true
		}
	}
	if !sawErr {
		t.Fatal("max overrun must be recorded as error action")
	}
}

func TestProvisionFailureIsRetriedNextTick(t *testing.T) {
	c, m, p, _, res, clk := ctrlSetup(t)
	ctx := context.Background()
	_, _ = res.Create(ReservationInput{Pool: "burst", HostCount: 1, From: clk.now(), To: clk.now().Add(time.Hour)}, "x")
	p.FailNext(errors.New("quota"))
	_ = c.Tick(ctx)
	if len(m.Hosts()) != 0 {
		t.Fatal("launch failed")
	}
	_ = c.Tick(ctx)
	if len(m.Hosts()) != 1 {
		t.Fatal("must retry")
	}
}

func TestBusySurplusHostIsKept(t *testing.T) {
	c, m, _, env, res, clk := ctrlSetup(t)
	ctx := context.Background()
	_, _ = res.Create(ReservationInput{Pool: "burst", HostCount: 1, From: clk.now(), To: clk.now().Add(10 * time.Minute)}, "x")
	_ = c.Tick(ctx)
	clk.advance(3 * time.Minute)
	_ = c.Tick(ctx)
	clk.advance(time.Minute)
	_ = c.Tick(ctx)
	clk.advance(time.Minute)
	_ = c.Tick(ctx)
	if states(m)[HostReady] != 1 {
		t.Fatalf("%v", states(m))
	}
	_ = env // SimEnv liefert 0 Instanzen → leerlaufend; ein Host mit Last wird in TestHostsEnv geprüft
	// Reservierung vorbei, aber IdleSince noch nicht lange genug → bleibt.
	clk.advance(10 * time.Minute)
	_ = c.Tick(ctx)
	if states(m)[HostReady] != 1 {
		t.Fatal("host must be kept until idle long enough")
	}
}

func TestPoolMinimumKeepsHostsWithoutReservation(t *testing.T) {
	c, m, _, _, _, _ := ctrlSetup(t)
	m.pools["burst"] = func() Pool { p := m.pools["burst"]; p.Min = 1; return p }()
	_ = c.Tick(context.Background())
	if len(m.Hosts()) != 1 {
		t.Fatal("pool minimum must be provisioned")
	}
}

func TestReservationValidate(t *testing.T) {
	pools := map[string]Pool{"burst": {Name: "burst", Max: 3}}
	t0 := time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)
	ok := ReservationInput{Pool: "burst", HostCount: 2, From: t0, To: t0.Add(time.Hour)}
	if err := ok.Validate(pools); err != nil {
		t.Fatal(err)
	}
	for name, bad := range map[string]ReservationInput{
		"pool":   {Pool: "x", HostCount: 1, From: t0, To: t0.Add(time.Hour)},
		"count0": {Pool: "burst", HostCount: 0, From: t0, To: t0.Add(time.Hour)},
		"max":    {Pool: "burst", HostCount: 4, From: t0, To: t0.Add(time.Hour)},
		"order":  {Pool: "burst", HostCount: 1, From: t0, To: t0},
		"long":   {Pool: "burst", HostCount: 1, From: t0, To: t0.Add(40 * 24 * time.Hour)},
	} {
		b := bad
		if err := b.Validate(pools); !errors.Is(err, ErrReservationValidation) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestSQLReservationsRoundTrip(t *testing.T) {
	s := NewSQLReservations(dbtest.Open(t))
	t0 := time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)
	a, err := s.Create(ReservationInput{Pool: "burst", HostCount: 2, From: t0, To: t0.Add(time.Hour), Note: "Abend"}, "admin")
	if err != nil || a.ID == "" || a.CreatedBy != "admin" {
		t.Fatalf("%+v %v", a, err)
	}
	_, _ = s.Create(ReservationInput{Pool: "burst", HostCount: 1, From: t0.Add(5 * time.Hour), To: t0.Add(6 * time.Hour)}, "admin")
	got, _ := s.List(t0, t0.Add(2*time.Hour))
	if len(got) != 1 || got[0].ID != a.ID || got[0].HostCount != 2 || got[0].Note != "Abend" {
		t.Fatalf("%+v", got)
	}
	if err := s.Delete(a.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(a.ID); !errors.Is(err, ErrReservationNotFound) {
		t.Fatalf("%v", err)
	}
}

type fakeTokens struct{}

func (fakeTokens) CreateBootstrapToken(by string, ttl time.Duration) (string, time.Time, error) {
	return "T-" + by, time.Now().Add(ttl), nil
}

type fakeHostList []hosts.Host

func (f fakeHostList) ListHosts() ([]hosts.Host, error) { return f, nil }

type fakeInst map[string]int

func (f fakeInst) CountOnHost(id string) int { return f[id] }

type fakePlacement map[string]bool

func (f fakePlacement) SetDraining(id string, on bool) { f[id] = on }

func TestHostsEnvBindsToRealStoresViaLabel(t *testing.T) {
	pl := fakePlacement{}
	env := HostsEnv{Tokens: fakeTokens{}, Hosts: fakeHostList{{ID: "h-77", Label: "dep-burst-1"}}, Instances: fakeInst{"h-77": 3}, Placement: pl}
	if tok, err := env.NewBootstrapToken(time.Hour); err != nil || tok != "T-cloud-controller" {
		t.Fatalf("%q %v", tok, err)
	}
	if id, ok := env.AgentRegistered("dep-burst-1"); !ok || id != "h-77" {
		t.Fatalf("%q %v", id, ok)
	}
	if _, ok := env.AgentRegistered("other"); ok {
		t.Fatal("unknown label must not be registered")
	}
	if n, _ := env.InstanceCount("h-77"); n != 3 {
		t.Fatalf("%d", n)
	}
	env.SetDraining("h-77", true)
	if !pl["h-77"] {
		t.Fatal("draining must reach placement")
	}
}

func TestSurplusHostWithLoadIsKeptUntilItIsEmpty(t *testing.T) {
	clk := &fakeClock{t: time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)}
	p := NewMockProvider()
	p.Now = clk.now
	p.BootDelay = time.Minute
	env := newEnv()
	m := NewManager(p, "dep", []Pool{{Name: "burst", Region: "r", InstanceType: "m.medium", Max: 2, IdleAfter: time.Minute, UserDataTemplate: "{{token}}"}}, env, clk.now)
	res := &memRes{}
	c := &PoolController{Manager: m, Reservations: res, Now: clk.now, Lead: time.Minute, Teardown: time.Minute}
	ctx := context.Background()
	_, _ = res.Create(ReservationInput{Pool: "burst", HostCount: 1, From: clk.now(), To: clk.now().Add(5 * time.Minute)}, "x")
	_ = c.Tick(ctx)
	h := m.Hosts()[0]
	clk.advance(2 * time.Minute)
	_ = c.Tick(ctx)
	env.agents[h.ID] = "agent"
	env.counts["agent"] = 2 // ein Workflow läuft auf dem Cloud-Host
	_ = c.Tick(ctx)
	if m.Hosts()[0].State != HostReady {
		t.Fatalf("%s", m.Hosts()[0].State)
	}
	clk.advance(30 * time.Minute) // Reservierung lange vorbei
	for i := 0; i < 3; i++ {
		_ = c.Tick(ctx)
		clk.advance(2 * time.Minute)
	}
	if m.Hosts()[0].State != HostReady {
		t.Fatalf("host with load must not be released, got %s", m.Hosts()[0].State)
	}
	env.counts["agent"] = 0
	_ = c.Tick(ctx) // IdleSince setzen
	clk.advance(2 * time.Minute)
	_ = c.Tick(ctx) // release
	_ = c.Tick(ctx) // draining → terminated
	if m.Hosts()[0].State != HostTerminated {
		t.Fatalf("empty host must be terminated, got %s", m.Hosts()[0].State)
	}
}
