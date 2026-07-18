package placement

import (
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

type fakeHosts struct{ hosts []hosts.Host }

func (f fakeHosts) ListHosts() ([]hosts.Host, error) { return f.hosts, nil }

type fakeMetrics map[string]hosts.Metrics

func (f fakeMetrics) Get(hostID string) (hosts.Metrics, bool) {
	m, ok := f[hostID]
	return m, ok
}

type fakeInstances struct{ instances []launcher.Instance }

func (f fakeInstances) List() []launcher.Instance { return f.instances }

type fakeEvents struct{ events []sse.Event }

func (f *fakeEvents) Broadcast(e sse.Event) { f.events = append(f.events, e) }

func testThresholds() Thresholds {
	return Thresholds{CPUPercent: 85, MemPercent: 90, HealthyCPUPercent: 60, HealthyMemPercent: 70}
}

func TestEvaluateOnceNoAdviceBelowThreshold(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}}}
	mr := fakeMetrics{"h1": {CPUPercent: 50, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	il := fakeInstances{instances: []launcher.Instance{{ID: "i1", HostID: "h1"}}}

	e := NewEngine(hl, mr, il, nil, testThresholds())
	e.evaluateOnce()

	if got := e.List(); len(got) != 0 {
		t.Fatalf("List() = %+v, want empty (host below threshold)", got)
	}
}

func TestEvaluateOnceNoAdviceWithoutInstances(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}}}
	mr := fakeMetrics{"h1": {CPUPercent: 95, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	il := fakeInstances{} // keine Instanzen auf h1

	e := NewEngine(hl, mr, il, nil, testThresholds())
	e.evaluateOnce()

	if got := e.List(); len(got) != 0 {
		t.Fatalf("List() = %+v, want empty (overloaded but empty host is nobody's problem)", got)
	}
}

func TestEvaluateOnceAdviceWithSuggestedTarget(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{
		{ID: "h1", Label: "Host 1"},
		{ID: "h2", Label: "Host 2"},
	}}
	mr := fakeMetrics{
		"h1": {CPUPercent: 95, MemUsedBytes: 3000, MemTotalBytes: 4000}, // 75% mem, over 90%? no -> only cpu over
		"h2": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000}, // healthy
	}
	il := fakeInstances{instances: []launcher.Instance{
		{ID: "i1", HostID: "h1"},
		{ID: "i2", HostID: "h1"},
	}}

	events := &fakeEvents{}
	e := NewEngine(hl, mr, il, events, testThresholds())
	e.evaluateOnce()

	got := e.List()
	if len(got) != 1 {
		t.Fatalf("List() = %+v, want exactly one advice", got)
	}
	a := got[0]
	if a.HostID != "h1" {
		t.Errorf("HostID = %q, want h1", a.HostID)
	}
	if a.Reason != "cpu" {
		t.Errorf("Reason = %q, want cpu", a.Reason)
	}
	if a.SuggestedHostID != "h2" {
		t.Errorf("SuggestedHostID = %q, want h2", a.SuggestedHostID)
	}
	if len(a.InstanceIDs) != 2 {
		t.Errorf("InstanceIDs = %+v, want 2 entries", a.InstanceIDs)
	}
	if len(events.events) != 1 || events.events[0].Type != "placement.advice" {
		t.Errorf("events = %+v, want exactly one placement.advice event", events.events)
	}
}

func TestEvaluateOnceAdviceWithoutHealthyTarget(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{
		{ID: "h1", Label: "Host 1"},
		{ID: "h2", Label: "Host 2"},
	}}
	mr := fakeMetrics{
		"h1": {CPUPercent: 95, MemUsedBytes: 1000, MemTotalBytes: 4000},
		"h2": {CPUPercent: 70, MemUsedBytes: 1000, MemTotalBytes: 4000}, // over Healthy (60), not a candidate
	}
	il := fakeInstances{instances: []launcher.Instance{{ID: "i1", HostID: "h1"}}}

	e := NewEngine(hl, mr, il, nil, testThresholds())
	e.evaluateOnce()

	got := e.List()
	if len(got) != 1 {
		t.Fatalf("List() = %+v, want exactly one advice", got)
	}
	if got[0].SuggestedHostID != "" {
		t.Errorf("SuggestedHostID = %q, want empty (no healthy candidate — honest, no silent fallback)", got[0].SuggestedHostID)
	}
}

func TestEvaluateOnceStableAlarmDoesNotRepublish(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{
		{ID: "h1", Label: "Host 1"},
		{ID: "h2", Label: "Host 2"},
	}}
	mr := fakeMetrics{
		"h1": {CPUPercent: 95, MemUsedBytes: 1000, MemTotalBytes: 4000},
		"h2": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000},
	}
	il := fakeInstances{instances: []launcher.Instance{{ID: "i1", HostID: "h1"}}}

	events := &fakeEvents{}
	e := NewEngine(hl, mr, il, events, testThresholds())
	e.evaluateOnce()
	e.evaluateOnce()
	e.evaluateOnce()

	if len(events.events) != 1 {
		t.Fatalf("events = %d, want exactly 1 (unchanged alarm across repeated ticks must not republish)", len(events.events))
	}

	got := e.List()
	if len(got) != 1 {
		t.Fatalf("List() = %+v, want exactly one advice", got)
	}
	if time.Since(got[0].DetectedAt) > time.Second {
		t.Errorf("DetectedAt = %v, looks stale/unset", got[0].DetectedAt)
	}
}

func TestEvaluateOnceClearedAlarmBroadcasts(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}}}
	mr := fakeMetrics{"h1": {CPUPercent: 95, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	il := fakeInstances{instances: []launcher.Instance{{ID: "i1", HostID: "h1"}}}

	events := &fakeEvents{}
	e := NewEngine(hl, mr, il, events, testThresholds())
	e.evaluateOnce()
	if len(e.List()) != 1 {
		t.Fatalf("expected initial advice")
	}

	// Host entlastet sich.
	mr["h1"] = hosts.Metrics{CPUPercent: 10, MemUsedBytes: 1000, MemTotalBytes: 4000}
	e.evaluateOnce()

	if got := e.List(); len(got) != 0 {
		t.Fatalf("List() = %+v, want empty after host recovered", got)
	}
	if len(events.events) != 2 {
		t.Fatalf("events = %d, want 2 (raise + clear)", len(events.events))
	}
	if events.events[1].Type != "placement.advice" {
		t.Errorf("second event type = %q, want placement.advice", events.events[1].Type)
	}
}

func TestEvaluateOnceMemThresholdReason(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}}}
	mr := fakeMetrics{"h1": {CPUPercent: 10, MemUsedBytes: 3800, MemTotalBytes: 4000}} // 95% mem
	il := fakeInstances{instances: []launcher.Instance{{ID: "i1", HostID: "h1"}}}

	e := NewEngine(hl, mr, il, nil, testThresholds())
	e.evaluateOnce()

	got := e.List()
	if len(got) != 1 || got[0].Reason != "mem" {
		t.Fatalf("List() = %+v, want single mem advice", got)
	}
}

func TestEvaluateOnceLocalInstancesIgnored(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}}}
	mr := fakeMetrics{"h1": {CPUPercent: 95, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	// HostID leer => lokal beim Orchestrator gestartet, zählt nicht für h1.
	il := fakeInstances{instances: []launcher.Instance{{ID: "i1", HostID: ""}}}

	e := NewEngine(hl, mr, il, nil, testThresholds())
	e.evaluateOnce()

	if got := e.List(); len(got) != 0 {
		t.Fatalf("List() = %+v, want empty (only local instance exists)", got)
	}
}

// --- CheckHost (workflows.ResourcePrecheck, UMSETZUNG.md D7 Teil 2) ---

func TestCheckHostOKBelowThreshold(t *testing.T) {
	mr := fakeMetrics{"h1": {CPUPercent: 50, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds())

	if reason, ok := e.CheckHost("h1"); !ok || reason != "" {
		t.Fatalf("CheckHost() = (%q, %v), want (\"\", true)", reason, ok)
	}
}

func TestCheckHostRejectsOverCPUThreshold(t *testing.T) {
	mr := fakeMetrics{"h1": {CPUPercent: 95, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds())

	reason, ok := e.CheckHost("h1")
	if ok || reason == "" {
		t.Fatalf("CheckHost() = (%q, %v), want a non-empty rejection reason", reason, ok)
	}
}

func TestCheckHostRejectsOverMemThreshold(t *testing.T) {
	mr := fakeMetrics{"h1": {CPUPercent: 10, MemUsedBytes: 3800, MemTotalBytes: 4000}} // 95% mem
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds())

	if _, ok := e.CheckHost("h1"); ok {
		t.Fatalf("CheckHost() ok = true, want false (mem over threshold)")
	}
}

func TestCheckHostOKWhenNoTelemetrySeen(t *testing.T) {
	e := NewEngine(fakeHosts{}, fakeMetrics{}, fakeInstances{}, nil, testThresholds())

	// Fail-open: ein Host, von dem noch nie Telemetrie kam, darf einen
	// Workflow-Start nicht blockieren (s. checkResources-Doku).
	if reason, ok := e.CheckHost("never-seen"); !ok || reason != "" {
		t.Fatalf("CheckHost() = (%q, %v), want (\"\", true) for unseen host", reason, ok)
	}
}
