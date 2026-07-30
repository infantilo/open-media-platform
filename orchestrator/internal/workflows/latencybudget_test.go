package workflows

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

// videoLatencyCatalog baut einen Test-Katalog: "scaler" deklariert 1
// Frame, "mix" 0-2 Frames, "unmeasured" deklariert nichts (D8 Teil 1
// Muster: omp-scaler/omp-video-mixer-me).
func videoLatencyCatalog() []launcher.CatalogEntry {
	return []launcher.CatalogEntry{
		{Type: "scaler", Latency: &launcher.CatalogLatency{
			Video: &launcher.LatencyRange{MinLatencyFrames: 1, MaxLatencyFrames: 1},
		}},
		{Type: "mix", Latency: &launcher.CatalogLatency{
			Video: &launcher.LatencyRange{MinLatencyFrames: 0, MaxLatencyFrames: 2},
		}},
		{Type: "unmeasured"},
	}
}

func TestEnumerateLatencyPathsFanOutSumsEachBranchIndependently(t *testing.T) {
	def := Definition{
		Roles: []Role{
			{Name: "src", NodeType: "scaler"},
			{Name: "a", NodeType: "scaler"},
			{Name: "b", NodeType: "mix"},
		},
		Connections: []Connection{
			{FromRole: "src", ToRole: "a"},
			{FromRole: "src", ToRole: "b"},
		},
	}
	lookup := buildVideoLatencyLookup(videoLatencyCatalog())
	paths, err := enumerateLatencyPaths(def, lookup)
	if err != nil {
		t.Fatalf("enumerateLatencyPaths() error = %v", err)
	}
	if len(paths) != 2 {
		t.Fatalf("len(paths) = %d, want 2 (one per branch)", len(paths))
	}
	got := map[string]uint32{}
	for _, p := range paths {
		got[strings.Join(p.roles, "→")] = p.frames
	}
	// src (1) + a (1) = 2; src (1) + b (0, mix.min) = 1.
	if got["src→a"] != 2 {
		t.Errorf("src→a frames = %d, want 2", got["src→a"])
	}
	if got["src→b"] != 1 {
		t.Errorf("src→b frames = %d, want 1", got["src→b"])
	}
}

func TestEnumerateLatencyPathsFanInProducesOnePathPerSource(t *testing.T) {
	def := Definition{
		Roles: []Role{
			{Name: "src1", NodeType: "scaler"},
			{Name: "src2", NodeType: "scaler"},
			{Name: "sink", NodeType: "mix"},
		},
		Connections: []Connection{
			{FromRole: "src1", ToRole: "sink"},
			{FromRole: "src2", ToRole: "sink"},
		},
	}
	lookup := buildVideoLatencyLookup(videoLatencyCatalog())
	paths, err := enumerateLatencyPaths(def, lookup)
	if err != nil {
		t.Fatalf("enumerateLatencyPaths() error = %v", err)
	}
	if len(paths) != 2 {
		t.Fatalf("len(paths) = %d, want 2 (one per source feeding the fan-in)", len(paths))
	}
	for _, p := range paths {
		if p.frames != 1 {
			t.Errorf("path %v frames = %d, want 1 (source 1 frame + sink 0)", p.roles, p.frames)
		}
	}
}

func TestEnumerateLatencyPathsIsolatedRoleIsTrivialPath(t *testing.T) {
	def := Definition{Roles: []Role{{Name: "alone", NodeType: "scaler"}}}
	lookup := buildVideoLatencyLookup(videoLatencyCatalog())
	paths, err := enumerateLatencyPaths(def, lookup)
	if err != nil {
		t.Fatalf("enumerateLatencyPaths() error = %v", err)
	}
	if len(paths) != 1 || len(paths[0].roles) != 1 || paths[0].roles[0] != "alone" || paths[0].frames != 1 {
		t.Fatalf("paths = %+v, want single trivial path [alone]=1", paths)
	}
}

func TestEnumerateLatencyPathsDetectsCycle(t *testing.T) {
	def := Definition{
		Roles: []Role{
			{Name: "a", NodeType: "scaler"},
			{Name: "b", NodeType: "scaler"},
		},
		Connections: []Connection{
			{FromRole: "a", ToRole: "b"},
			{FromRole: "b", ToRole: "a"},
		},
	}
	lookup := buildVideoLatencyLookup(videoLatencyCatalog())
	_, err := enumerateLatencyPaths(def, lookup)
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("enumerateLatencyPaths() error = %v, want ErrValidation (cycle)", err)
	}
}

func TestCheckLatencyBudgetSkipsCheckWhenTargetUnset(t *testing.T) {
	def := Definition{
		Roles:    []Role{{Name: "a", NodeType: "unmeasured"}},
		Settings: Settings{TargetLatencyFrames: 0},
	}
	if err := checkLatencyBudget(def, videoLatencyCatalog()); err != nil {
		t.Fatalf("checkLatencyBudget() error = %v, want nil (target unset must skip the check entirely, incl. unknown-latency roles)", err)
	}
}

func TestCheckLatencyBudgetAcceptsSufficientTarget(t *testing.T) {
	def := Definition{
		Roles: []Role{
			{Name: "s1", NodeType: "scaler"},
			{Name: "s2", NodeType: "scaler"},
		},
		Connections: []Connection{{FromRole: "s1", ToRole: "s2"}},
		Settings:    Settings{TargetLatencyFrames: 2},
	}
	if err := checkLatencyBudget(def, videoLatencyCatalog()); err != nil {
		t.Fatalf("checkLatencyBudget() error = %v, want nil (required minimum is exactly 2)", err)
	}
}

func TestCheckLatencyBudgetRejectsInsufficientTargetWithClearMessage(t *testing.T) {
	def := Definition{
		Roles: []Role{
			{Name: "s1", NodeType: "scaler"},
			{Name: "s2", NodeType: "scaler"},
		},
		Connections: []Connection{{FromRole: "s1", ToRole: "s2"}},
		Settings:    Settings{TargetLatencyFrames: 1},
	}
	err := checkLatencyBudget(def, videoLatencyCatalog())
	if !errors.Is(err, ErrLatencyBudgetInsufficient) {
		t.Fatalf("checkLatencyBudget() error = %v, want ErrLatencyBudgetInsufficient", err)
	}
	if !strings.Contains(err.Error(), "Minimum 2 Frames") || !strings.Contains(err.Error(), "s1→s2") {
		t.Fatalf("checkLatencyBudget() error = %q, want a message naming the path and the required minimum", err.Error())
	}
}

func TestCheckLatencyBudgetRejectsUnknownLatencyRole(t *testing.T) {
	def := Definition{
		Roles: []Role{
			{Name: "s1", NodeType: "scaler"},
			{Name: "u", NodeType: "unmeasured"},
		},
		Connections: []Connection{{FromRole: "s1", ToRole: "u"}},
		Settings:    Settings{TargetLatencyFrames: 100},
	}
	err := checkLatencyBudget(def, videoLatencyCatalog())
	if !errors.Is(err, ErrLatencyBudgetInsufficient) {
		t.Fatalf("checkLatencyBudget() error = %v, want ErrLatencyBudgetInsufficient (unknown latency, §15.2 'hoch annehmen' as honest rejection)", err)
	}
	if !strings.Contains(err.Error(), `"u"`) || !strings.Contains(err.Error(), "unmeasured") {
		t.Fatalf("checkLatencyBudget() error = %q, want it to name the role and node type with unknown latency", err.Error())
	}
}

// TestStartRejectsWorkflowWithInsufficientLatencyBudget verifiziert den
// echten Start()-Preflight (D8 Teil 2): ein zu knapp budgetierter
// Workflow scheitert SYNCHRON, bevor auch nur ein einziger Node
// gestartet wird (kein l.Start()-Aufruf, Status bleibt "stopped") —
// "ehrliche Ablehnung statt stillem Kürzer-Start".
func TestStartRejectsWorkflowWithInsufficientLatencyBudget(t *testing.T) {
	l := &fakeLauncher{catalog: videoLatencyCatalog()}
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, l)

	def := Definition{
		Roles: []Role{
			{Name: "s1", NodeType: "scaler"},
			{Name: "s2", NodeType: "scaler"},
		},
		Connections: []Connection{{FromRole: "s1", ToRole: "s2"}},
		Settings:    Settings{TargetLatencyFrames: 1},
	}
	wf, err := svc.Create("too-tight", def, nil)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	err = svc.Start(context.Background(), wf.ID)
	if !errors.Is(err, ErrLatencyBudgetInsufficient) {
		t.Fatalf("Start() error = %v, want ErrLatencyBudgetInsufficient", err)
	}

	l.mu.Lock()
	startedCount := len(l.started)
	l.mu.Unlock()
	if startedCount != 0 {
		t.Fatalf("launcher.started = %v, want no node started when the budget preflight rejects", l.started)
	}

	after, getErr := svc.Get(wf.ID)
	if getErr != nil {
		t.Fatalf("Get() error = %v", getErr)
	}
	if after.Status != StatusStopped {
		t.Fatalf("Status after rejected Start() = %q, want stopped (never transitioned to starting)", after.Status)
	}
}
