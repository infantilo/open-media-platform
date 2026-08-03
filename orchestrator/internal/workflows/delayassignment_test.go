package workflows

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

// delayCatalog erweitert videoLatencyCatalog()s Muster um
// SupportsDelayCompensation: "scaler"/"mix" (D8 Teil 3: beide real
// implementiert) sind delay-fähig, "unmeasured" nicht.
func delayCatalog() []launcher.CatalogEntry {
	return []launcher.CatalogEntry{
		{Type: "scaler", Latency: &launcher.CatalogLatency{
			Video:                     &launcher.LatencyRange{MinLatencyFrames: 1, MaxLatencyFrames: 1},
			SupportsDelayCompensation: true,
		}},
		{Type: "mix", Latency: &launcher.CatalogLatency{
			Video:                     &launcher.LatencyRange{MinLatencyFrames: 0, MaxLatencyFrames: 2},
			SupportsDelayCompensation: true,
		}},
		{Type: "unmeasured"},
	}
}

func TestComputeDelayPlanSkipsWhenTargetUnset(t *testing.T) {
	def := Definition{Roles: []Role{{Name: "a", NodeType: "scaler"}}}
	plan, err := computeDelayPlan(def, delayCatalog())
	if err != nil {
		t.Fatalf("computeDelayPlan() error = %v, want nil", err)
	}
	if len(plan) != 0 {
		t.Fatalf("plan = %+v, want empty (target unset)", plan)
	}
}

func TestComputeDelayPlanAssignsToLatestCapableRole(t *testing.T) {
	// src(scaler,1) -> mid(mix,0-2) -> sink(scaler,1) = 2 Frames Minimum,
	// target=5 -> Defizit 3, muss an "sink" gehen (spätester delay-
	// fähiger Knoten im Pfad), nicht an "src" oder "mid".
	def := Definition{
		Roles: []Role{
			{Name: "src", NodeType: "scaler"},
			{Name: "mid", NodeType: "mix"},
			{Name: "sink", NodeType: "scaler"},
		},
		Connections: []Connection{
			{FromRole: "src", ToRole: "mid"},
			{FromRole: "mid", ToRole: "sink"},
		},
		Settings: Settings{TargetLatencyFrames: 5},
	}
	plan, err := computeDelayPlan(def, delayCatalog())
	if err != nil {
		t.Fatalf("computeDelayPlan() error = %v", err)
	}
	if len(plan) != 1 || plan["sink"] != 3 {
		t.Fatalf("plan = %+v, want {sink: 3}", plan)
	}
}

func TestComputeDelayPlanRejectsPathWithNoCapableRole(t *testing.T) {
	def := Definition{
		Roles: []Role{
			{Name: "src", NodeType: "unmeasured"},
			{Name: "sink", NodeType: "unmeasured"},
		},
		Connections: []Connection{{FromRole: "src", ToRole: "sink"}},
		Settings:    Settings{TargetLatencyFrames: 5},
	}
	// "unmeasured" hat keine deklarierte Video-Latenz -> würde bereits an
	// checkLatencyBudget scheitern; hier direkt mit einem Katalogeintrag
	// getestet, der Latenz deklariert, aber KEINE Delay-Fähigkeit.
	catalog := []launcher.CatalogEntry{
		{Type: "unmeasured", Latency: &launcher.CatalogLatency{
			Video: &launcher.LatencyRange{MinLatencyFrames: 1, MaxLatencyFrames: 1},
		}},
	}
	_, err := computeDelayPlan(def, catalog)
	if !errors.Is(err, ErrLatencyBudgetInsufficient) {
		t.Fatalf("computeDelayPlan() error = %v, want ErrLatencyBudgetInsufficient (no delay-capable role on the path)", err)
	}
}

func TestComputeDelayPlanAllowsSameDeficitFromTwoPaths(t *testing.T) {
	// Fan-out ab "src": zwei Zweige, beide brauchen dieselbe Verzögerung
	// an ihrem jeweils EIGENEN Sink (kein gemeinsamer Knoten betroffen).
	def := Definition{
		Roles: []Role{
			{Name: "src", NodeType: "scaler"},
			{Name: "a", NodeType: "scaler"},
			{Name: "b", NodeType: "scaler"},
		},
		Connections: []Connection{
			{FromRole: "src", ToRole: "a"},
			{FromRole: "src", ToRole: "b"},
		},
		Settings: Settings{TargetLatencyFrames: 4},
	}
	plan, err := computeDelayPlan(def, delayCatalog())
	if err != nil {
		t.Fatalf("computeDelayPlan() error = %v", err)
	}
	// src->a = 2 Frames, src->b = 2 Frames -> je 2 Frames Defizit an a bzw. b.
	if plan["a"] != 2 || plan["b"] != 2 {
		t.Fatalf("plan = %+v, want {a:2, b:2}", plan)
	}
}

func TestComputeDelayPlanRejectsConflictingDeficitsOnSameRole(t *testing.T) {
	// "shared" ist der einzige delay-fähige Knoten auf ZWEI Pfaden
	// unterschiedlicher Länge (fan-in davor, fan-out danach) — die beiden
	// vorgelagerten Zweige haben unterschiedliche Summen, "shared" müsste
	// wegen des Fan-outs zwei verschiedene Defizite gleichzeitig
	// ausgleichen. Konstruiert über zwei unabhängige Quellen, die beide
	// direkt auf denselben delay-fähigen Knoten laufen, mit
	// unterschiedlicher Latenz je Quelle.
	def := Definition{
		Roles: []Role{
			{Name: "src1", NodeType: "scaler"}, // 1 Frame
			{Name: "src2", NodeType: "mix"},    // 0 Frames (min)
			{Name: "shared", NodeType: "scaler"},
		},
		Connections: []Connection{
			{FromRole: "src1", ToRole: "shared"},
			{FromRole: "src2", ToRole: "shared"},
		},
		Settings: Settings{TargetLatencyFrames: 5},
	}
	// src1->shared = 1(src1)+1(shared) = 2, Defizit 3.
	// src2->shared = 0(src2)+1(shared) = 1, Defizit 4.
	// Beide Pfade enden an "shared" — einzige delay-fähige Rolle in
	// beiden -> widersprüchliche Zuweisung (3 vs. 4).
	_, err := computeDelayPlan(def, delayCatalog())
	if !errors.Is(err, ErrLatencyBudgetInsufficient) {
		t.Fatalf("computeDelayPlan() error = %v, want ErrLatencyBudgetInsufficient (conflicting deficits on role %q)", err, "shared")
	}
}

// TestStartAppliesDelayPlanForTooShortPath verifiziert den echten
// Start()-Preflight (D8 Teil 3): ein Workflow, dessen kürzester Pfad
// dank eines delay-fähigen Knotens ausgleichbar ist, wird NICHT abgelehnt
// (anders als D8 Teil 2 ohne diesen Mechanismus).
func TestStartAcceptsWorkflowCompensableViaDelay(t *testing.T) {
	// Dieser Test prüft nur den SYNCHRONEN Start()-Preflight (beide
	// Checks laufen vor jeder Provisionierung, s. service.go) — die
	// asynchrone awaitRegistration in runStart ist hier nicht
	// Gegenstand der Prüfung, der kurze Timeout hält die im Hintergrund
	// weiterlaufende Goroutine nur kurz am Leben (fakeNodeLister
	// registriert nie etwas, runStart scheitert also ohnehin später
	// asynchron mit einem Registrierungs-Timeout).
	original, originalPoll := registrationTimeout, registrationPollInterval
	registrationTimeout = 200 * time.Millisecond
	registrationPollInterval = 10 * time.Millisecond
	defer func() { registrationTimeout, registrationPollInterval = original, originalPoll }()

	l := &fakeLauncher{catalog: delayCatalog()}
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, l)

	def := Definition{
		Roles: []Role{
			{Name: "s1", NodeType: "scaler"},
			{Name: "s2", NodeType: "scaler"},
		},
		Connections: []Connection{{FromRole: "s1", ToRole: "s2"}},
		// Minimum ist 2 (1+1), s2 ist delay-fähig -> 3 muss akzeptiert werden.
		Settings: Settings{TargetLatencyFrames: 3},
	}
	wf, err := svc.Create("compensable", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := svc.Start(context.Background(), wf.ID); err != nil {
		t.Fatalf("Start() error = %v, want nil (deficit is compensable via setOutputDelay)", err)
	}
}
