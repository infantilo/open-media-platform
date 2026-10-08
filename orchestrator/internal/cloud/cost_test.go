package cloud

import (
	"math"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 8, 11, 0, 0, 0, time.UTC)

func book() PriceBook {
	return NewPriceBook([]InstanceType{
		{Name: "m.medium", PricePerHour: 0.10, Currency: "EUR"},
		{Name: "g.large", PricePerHour: 1.00, Currency: "EUR"},
	}, 60*time.Second)
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func TestRunCostMinimumBilledAndUnknownType(t *testing.T) {
	pb := book()
	c, cur, err := pb.RunCost("m.medium", t0, t0.Add(30*time.Second))
	if err != nil || !near(c, 0.10*60.0/3600) || cur != "EUR" {
		t.Fatalf("%v %v %v", c, cur, err)
	}
	c, _, _ = pb.RunCost("m.medium", t0, t0.Add(90*time.Minute))
	if !near(c, 0.15) {
		t.Fatal(c)
	}
	if _, _, err := pb.RunCost("x", t0, t0.Add(time.Hour)); err == nil {
		t.Fatal("unknown type must error, not price 0")
	}
}

func TestEstimateSingleDemandIncludesLeadAndTeardown(t *testing.T) {
	// 2 Hosts g.large von 11:00–14:00, Vorlauf 5 min, Abbau 5 min → je 3h10 = 3,1667 h → 2 × 3,16667 €.
	est, err := book().Estimate([]Demand{{InstanceType: "g.large", Count: 2, From: t0, To: t0.Add(3 * time.Hour)}}, 5*time.Minute, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(est.Runs) != 2 || !est.Estimated || est.Currency != "EUR" {
		t.Fatalf("%+v", est)
	}
	want := 2 * 1.00 * (3.0 + 10.0/60)
	if !near(est.Total, want) {
		t.Fatalf("total %v want %v", est.Total, want)
	}
	if !est.Runs[0].Start.Equal(t0.Add(-5 * time.Minute)) {
		t.Fatalf("start %v", est.Runs[0].Start)
	}
}

func TestEstimateOverlapNeedsSecondHostOnlyWhileOverlapping(t *testing.T) {
	// A 11–13 (1 Host), B 12–14 (1 Host): Host 1 durchgehend 11–14, Host 2 nur 12–13.
	est, _ := book().Estimate([]Demand{
		{InstanceType: "m.medium", Count: 1, From: t0, To: t0.Add(2 * time.Hour)},
		{InstanceType: "m.medium", Count: 1, From: t0.Add(time.Hour), To: t0.Add(3 * time.Hour)},
	}, 0, 0)
	if len(est.Runs) != 2 {
		t.Fatalf("%+v", est.Runs)
	}
	if !near(est.Total, 0.10*3+0.10*1) {
		t.Fatalf("total %v", est.Total)
	}
}

func TestEstimateBridgesShortGapsButNotLongOnes(t *testing.T) {
	two := []Demand{
		{InstanceType: "m.medium", Count: 1, From: t0, To: t0.Add(time.Hour)},
		{InstanceType: "m.medium", Count: 1, From: t0.Add(time.Hour + 8*time.Minute), To: t0.Add(2 * time.Hour)},
	}
	// Lücke 8 min ≤ lead+teardown (10 min) → ein Lauf.
	est, _ := book().Estimate(two, 5*time.Minute, 5*time.Minute)
	if len(est.Runs) != 1 {
		t.Fatalf("short gap must be bridged: %d runs", len(est.Runs))
	}
	// Lücke 30 min → zwei Läufe.
	two[1].From = t0.Add(time.Hour + 30*time.Minute)
	est, _ = book().Estimate(two, 5*time.Minute, 5*time.Minute)
	if len(est.Runs) != 2 {
		t.Fatalf("long gap must split: %d runs", len(est.Runs))
	}
}

func TestEstimateSeamlessAdjacentDemandIsOneRun(t *testing.T) {
	est, _ := book().Estimate([]Demand{
		{InstanceType: "m.medium", Count: 1, From: t0, To: t0.Add(time.Hour)},
		{InstanceType: "m.medium", Count: 1, From: t0.Add(time.Hour), To: t0.Add(2 * time.Hour)},
	}, 0, 0)
	if len(est.Runs) != 1 || !near(est.Total, 0.20) {
		t.Fatalf("%+v", est)
	}
}

func TestEstimateIgnoresEmptyDemandAndRejectsUnknownType(t *testing.T) {
	est, err := book().Estimate([]Demand{{InstanceType: "m.medium", Count: 0, From: t0, To: t0.Add(time.Hour)}}, 0, 0)
	if err != nil || len(est.Runs) != 0 || est.Total != 0 {
		t.Fatalf("%+v %v", est, err)
	}
	if _, err := book().Estimate([]Demand{{InstanceType: "nope", Count: 1, From: t0, To: t0.Add(time.Hour)}}, 0, 0); err == nil {
		t.Fatal("must reject unknown type")
	}
}

func TestSpendClipsToPeriodAndReportsUnpriced(t *testing.T) {
	pb := book()
	hosts := []Host{
		{ID: "a", InstanceType: "g.large", RequestedAt: t0.Add(-2 * time.Hour), EndedAt: t0.Add(time.Hour)}, // 3 h, davon 1 h im Zeitraum ab t0
		{ID: "b", InstanceType: "m.medium", RequestedAt: t0, State: HostReady},                              // läuft noch
		{ID: "c", InstanceType: "exotic", RequestedAt: t0, State: HostReady},                                // ohne Preis
	}
	total, cur, unpriced := pb.Spend(hosts, t0, t0.Add(2*time.Hour), t0.Add(2*time.Hour))
	// a: 1 h × 1,00; b: 2 h × 0,10
	if !near(total, 1.00+0.20) || cur != "EUR" {
		t.Fatalf("total %v %s", total, cur)
	}
	if len(unpriced) != 1 || unpriced[0] != "c" {
		t.Fatalf("unpriced %v", unpriced)
	}
}

func TestProjectionAddsRunningHostsUntilPeriodEnd(t *testing.T) {
	pb := book()
	now := t0.Add(2 * time.Hour)
	hosts := []Host{
		{ID: "run", InstanceType: "g.large", RequestedAt: t0, State: HostReady},                                    // 2 h angefallen, läuft weiter
		{ID: "done", InstanceType: "m.medium", RequestedAt: t0, EndedAt: t0.Add(time.Hour), State: HostTerminated}, // 1 h abgeschlossen
	}
	spent, projected, _, _ := pb.Projection(hosts, t0, t0.Add(10*time.Hour), now)
	if !near(spent, 2.00+0.10) {
		t.Fatalf("spent %v", spent)
	}
	// 8 h Resttage × 1,00 €/h für den laufenden Host.
	if !near(projected, spent+8.00) {
		t.Fatalf("projected %v", projected)
	}
	// Periode schon vorbei: keine Hochrechnung.
	_, p2, _, _ := pb.Projection(hosts, t0, now, now)
	if !near(p2, spent) {
		t.Fatalf("p2 %v", p2)
	}
}
