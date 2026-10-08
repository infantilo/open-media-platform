package cloud

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

type memPolicies map[string]Policy

func (m memPolicies) Get(pool string) (Policy, error) {
	if p, ok := m[pool]; ok {
		return p, nil
	}
	return DefaultPolicy(pool), nil
}
func (m memPolicies) Put(p Policy, _ string) error { m[p.Pool] = p; return nil }

type asSetup struct {
	c    *PoolController
	m    *Manager
	clk  *fakeClock
	pol  memPolicies
	load *LoadSample
}

func newAS(t *testing.T, p Policy) *asSetup {
	t.Helper()
	clk := &fakeClock{t: time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)}
	prov := NewMockProvider()
	prov.Now = clk.now
	prov.BootDelay = time.Minute
	prov.Types = []InstanceType{{Name: "m.medium", PricePerHour: 1.0, Currency: "EUR"}}
	env := NewSimEnv(clk.now, 10*time.Second)
	m := NewManager(prov, "dep", []Pool{{Name: "burst", Region: "r", InstanceType: "m.medium", Max: 4, IdleAfter: time.Minute, UserDataTemplate: "{{token}}"}}, env, clk.now)
	pol := memPolicies{"burst": p}
	load := &LoadSample{CPUPercent: 10, MemPercent: 10, Hosts: 2}
	pb := NewPriceBook(prov.Types, time.Minute)
	c := &PoolController{Manager: m, Reservations: &memRes{}, Now: clk.now, Lead: time.Minute, Teardown: time.Minute,
		Policies: pol, Load: func() (LoadSample, bool) { return *load, true },
		Prices: func(context.Context) (PriceBook, error) { return pb, nil }}
	return &asSetup{c: c, m: m, clk: clk, pol: pol, load: load}
}

func autoPolicy() Policy {
	p := DefaultPolicy("burst")
	p.Mode = ModeAuto
	p.UpAfterSec, p.DownAfterSec, p.CooldownSec = 120, 120, 300
	p.MaxAutoHosts = 2
	p.DailyBudget = 100
	return p
}

// run tickt n-mal im Abstand step.
func (s *asSetup) run(n int, step time.Duration) {
	for i := 0; i < n; i++ {
		_ = s.c.Tick(context.Background())
		s.clk.advance(step)
	}
}

func kinds(c *PoolController) map[string]int {
	out := map[string]int{}
	for _, a := range c.Actions() {
		out[a.Kind]++
	}
	return out
}

func TestAutoscaleOffIgnoresLoad(t *testing.T) {
	p := autoPolicy()
	p.Mode = ModeOff
	s := newAS(t, p)
	s.load.CPUPercent = 99
	s.run(30, 30*time.Second)
	if len(s.m.Hosts()) != 0 {
		t.Fatal("autoscaling off must not provision")
	}
}

func TestAutoscaleUpNeedsSustainedLoadThenCooldownAndMax(t *testing.T) {
	s := newAS(t, autoPolicy())
	s.load.CPUPercent = 95
	s.run(2, 30*time.Second) // 1 min hohe Last < UpAfter (2 min)
	if len(s.m.Hosts()) != 0 {
		t.Fatal("must wait for UpAfter")
	}
	s.run(4, 30*time.Second) // → 3 min: erster Host
	if got := len(s.m.Hosts()); got != 1 {
		t.Fatalf("want 1 host after sustained load, got %d (%v)", got, kinds(s.c))
	}
	s.run(4, 30*time.Second) // Cooldown 5 min noch nicht um
	if got := len(s.m.Hosts()); got != 1 {
		t.Fatalf("cooldown must hold the second host back, got %d", got)
	}
	s.run(30, 30*time.Second) // lange hohe Last: zweiter Host, dann Deckel MaxAutoHosts=2
	if got := len(s.m.Hosts()); got != 2 {
		t.Fatalf("want exactly 2 (maxAutoHosts), got %d", got)
	}
	if kinds(s.c)["autoscale-up"] != 2 {
		t.Fatalf("%v", kinds(s.c))
	}
}

func TestAutoscaleDownReleasesIdleExtraHost(t *testing.T) {
	s := newAS(t, autoPolicy())
	s.load.CPUPercent = 95
	s.run(8, 30*time.Second)
	if len(s.m.Hosts()) != 1 {
		t.Fatalf("%d", len(s.m.Hosts()))
	}
	s.load.CPUPercent = 10 // Last sinkt
	s.run(30, 30*time.Second)
	if kinds(s.c)["autoscale-down"] != 1 {
		t.Fatalf("want scale-down, got %v", kinds(s.c))
	}
	if st := states(s.m); st[HostTerminated] != 1 {
		t.Fatalf("idle extra host must be terminated: %v", st)
	}
}

func TestSuggestModeCreatesOneSuggestionAcceptProvisions(t *testing.T) {
	p := autoPolicy()
	p.Mode = ModeSuggest
	s := newAS(t, p)
	s.load.CPUPercent = 95
	s.run(10, 30*time.Second)
	if len(s.m.Hosts()) != 0 {
		t.Fatal("suggest mode must not provision on its own")
	}
	sg := s.c.Suggestions()
	if len(sg) != 1 || sg[0].Pool != "burst" {
		t.Fatalf("want exactly one suggestion, got %+v", sg)
	}
	if err := s.c.Accept(context.Background(), "nope", "x"); !errors.Is(err, ErrSuggestionNotFound) {
		t.Fatalf("%v", err)
	}
	if err := s.c.Accept(context.Background(), sg[0].ID, "admin"); err != nil {
		t.Fatal(err)
	}
	s.run(2, 30*time.Second)
	if len(s.m.Hosts()) != 1 || len(s.c.Suggestions()) != 0 && s.c.Suggestions()[0].ID == sg[0].ID {
		t.Fatalf("accepted suggestion must provision: hosts=%d sugg=%v", len(s.m.Hosts()), s.c.Suggestions())
	}
}

func TestDismissRemovesSuggestion(t *testing.T) {
	p := autoPolicy()
	p.Mode = ModeSuggest
	s := newAS(t, p)
	s.load.CPUPercent = 95
	s.run(10, 30*time.Second)
	sg := s.c.Suggestions()
	if len(sg) != 1 || !s.c.Dismiss(sg[0].ID) || s.c.Dismiss(sg[0].ID) {
		t.Fatal("dismiss must succeed once")
	}
}

func TestBudgetCapBlocksProvisioningAndAccept(t *testing.T) {
	p := autoPolicy()
	p.DailyBudget = 3 // ein Host kostet 1 €/h → bis Tagesende (14 h) weit über 3 €
	s := newAS(t, p)
	s.load.CPUPercent = 95
	s.run(12, 30*time.Second)
	if len(s.m.Hosts()) != 0 {
		t.Fatal("budget cap must block the host")
	}
	if kinds(s.c)["budget"] != 1 {
		t.Fatalf("budget block must be reported exactly once (rate limited): %v", kinds(s.c))
	}
	if kinds(s.c)["autoscale-up"] != 0 {
		t.Fatalf("the target must not grow while the budget forbids a host: %v", kinds(s.c))
	}
	var why string
	for _, a := range s.c.Actions() {
		if a.Kind == "budget" {
			why = a.Reason
		}
	}
	if !strings.Contains(why, "daily budget cap") {
		t.Fatal(why)
	}
	// Auch eine Reservierung darf den Deckel nicht umgehen.
	res := s.c.Reservations.(*memRes)
	_, _ = res.Create(ReservationInput{Pool: "burst", HostCount: 1, From: s.clk.now(), To: s.clk.now().Add(time.Hour)}, "x")
	s.run(2, 30*time.Second)
	if len(s.m.Hosts()) != 0 {
		t.Fatal("reservation must not bypass the budget cap")
	}
	// Mit Spielraum entsteht ein Vorschlag; wird der Deckel danach gesenkt, scheitert das Annehmen daran.
	pp := p
	pp.Mode, pp.DailyBudget = ModeSuggest, 100
	s.pol["burst"] = pp
	s.run(10, 30*time.Second)
	sg := s.c.Suggestions()
	if len(sg) == 0 {
		t.Fatal("expected suggestion")
	}
	pp.DailyBudget = 3
	s.pol["burst"] = pp
	if err := s.c.Accept(context.Background(), sg[0].ID, "x"); !errors.Is(err, ErrBudget) {
		t.Fatalf("accept must fail with budget error: %v", err)
	}
}

func TestBudgetAllowsWhileUnderCapAndCountsTerminatedHosts(t *testing.T) {
	p := autoPolicy()
	p.DailyBudget = 20 // 1 Host für den Rest des Tages (14 h) passt, ein zweiter nicht
	s := newAS(t, p)
	s.load.CPUPercent = 95
	s.run(40, 30*time.Second)
	if got := len(s.m.Hosts()); got != 1 {
		t.Fatalf("second host must be blocked by the cap, got %d hosts %v", got, kinds(s.c))
	}
	costs, err := s.c.Costs(context.Background())
	if err != nil || len(costs) != 1 {
		t.Fatalf("%v %v", costs, err)
	}
	if costs[0].Day.Cap != 20 || costs[0].Day.Spent <= 0 || costs[0].Day.Projected <= costs[0].Day.Spent || !costs[0].Estimate {
		t.Fatalf("%+v", costs[0])
	}
}

func TestPolicyValidate(t *testing.T) {
	pl := Pool{Name: "burst", Max: 3}
	good := autoPolicy()
	if err := good.Validate(pl); err != nil {
		t.Fatal(err)
	}
	mut := func(f func(*Policy)) Policy { p := autoPolicy(); f(&p); return p }
	for name, bad := range map[string]Policy{
		"mode":       mut(func(p *Policy) { p.Mode = "x" }),
		"hysteresis": mut(func(p *Policy) { p.DownCPUPercent = 90 }),
		"short":      mut(func(p *Policy) { p.CooldownSec = 10 }),
		"max":        mut(func(p *Policy) { p.MaxAutoHosts = 9 }),
		"negative":   mut(func(p *Policy) { p.DailyBudget = -1 }),
		"order":      mut(func(p *Policy) { p.DailyBudget = 50; p.MonthlyBudget = 10 }),
		"nobudget":   mut(func(p *Policy) { p.DailyBudget, p.MonthlyBudget = 0, 0 }),
	} {
		b := bad
		if err := b.Validate(pl); !errors.Is(err, ErrPolicyValidation) {
			t.Errorf("%s: %v", name, err)
		}
	}
	off := autoPolicy()
	off.Mode, off.DailyBudget = ModeOff, 0
	if err := off.Validate(pl); err != nil {
		t.Fatalf("off needs no budget: %v", err)
	}
}

func TestSQLPoliciesAndHostsRoundTrip(t *testing.T) {
	db := dbtest.Open(t)
	ps := NewSQLPolicies(db)
	if p, err := ps.Get("burst"); err != nil || p.Mode != ModeOff {
		t.Fatalf("default must be off: %+v %v", p, err)
	}
	want := autoPolicy()
	want.DailyBudget = 42
	if err := ps.Put(want, "admin"); err != nil {
		t.Fatal(err)
	}
	got, _ := ps.Get("burst")
	if got != want {
		t.Fatalf("%+v != %+v", got, want)
	}
	hs := NewSQLHosts(db)
	h := Host{ID: "h1", Pool: "burst", InstanceType: "m.medium", State: HostReady, RequestedAt: time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)}
	if err := hs.Save(h); err != nil {
		t.Fatal(err)
	}
	h.State = HostTerminated
	_ = hs.Save(h)
	all, err := hs.LoadAll()
	found := false
	for _, x := range all {
		if x.ID == "h1" && x.State == HostTerminated {
			found = true
		}
	}
	if err != nil || !found {
		t.Fatalf("%v %v", all, err)
	}
}

type memHosts struct{ m map[string]Host }

func (s *memHosts) Save(h Host) error { s.m[h.ID] = h; return nil }
func (s *memHosts) LoadAll() ([]Host, error) {
	var out []Host
	for _, h := range s.m {
		out = append(out, h)
	}
	return out, nil
}

func TestManagerPersistsAndRestoresHostsIncludingTerminated(t *testing.T) {
	m, _, _, _ := setup(t)
	store := &memHosts{m: map[string]Host{}}
	if err := m.SetStore(store); err != nil {
		t.Fatal(err)
	}
	h, _ := m.Provision(context.Background(), "burst")
	if store.m[h.ID].State != HostBooting {
		t.Fatal("provision must persist")
	}
	_ = m.Release(context.Background(), h.ID) // beendet den bootenden Host sofort
	if store.m[h.ID].State != HostTerminated || store.m[h.ID].EndedAt.IsZero() {
		t.Fatalf("termination must persist: %+v", store.m[h.ID])
	}
	m2, _, _, _ := setup(t)
	if err := m2.SetStore(store); err != nil {
		t.Fatal(err)
	}
	got := m2.Hosts()
	if len(got) != 1 || got[0].State != HostTerminated {
		t.Fatalf("restored: %+v", got)
	}
}
