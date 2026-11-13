package workflows

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

type listLauncher struct {
	*fakeLauncher
	insts []launcher.Instance
}

func (l *listLauncher) List() []launcher.Instance { return l.insts }

type fakeRelocator struct {
	mu    sync.Mutex
	calls [][2]string
	err   error
}

func (f *fakeRelocator) RelocateLost(_ context.Context, id, target string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, [2]string{id, target})
	return f.err
}

func (f *fakeRelocator) snapshot() [][2]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][2]string(nil), f.calls...)
}

func standaloneSetup(t *testing.T, target string) (*Service, *fakeRelocator, *fakeHostMetrics) {
	t.Helper()
	l := &listLauncher{fakeLauncher: &fakeLauncher{catalog: []launcher.CatalogEntry{
		{Type: "omp-capture-card", HostBound: true}, {Type: "omp-scaler"},
	}}, insts: []launcher.Instance{
		{ID: "free", Type: "omp-scaler", HostID: "host-a"},
		{ID: "card", Type: "omp-capture-card", HostID: "host-a"},
		{ID: "pending", Type: "omp-scaler", HostID: "host-a", StopPending: true},
		{ID: "other", Type: "omp-scaler", HostID: "host-c"},
		{ID: "local", Type: "omp-scaler"},
	}}
	svc := newTestService(newFakeStore(), &fakeNodeLister{}, &fakeGraph{}, l)
	svc.resources = fixedPlacer{host: target}
	rel := &fakeRelocator{}
	svc.SetStandaloneRelocator(rel)
	metrics := newFakeHostMetrics()
	svc.SetHostMetrics(metrics)
	metrics.set("host-c", time.Now())
	return svc, rel, metrics
}

// TestLostHostRelocatesStandaloneInstances: nur die umziehbare Instanz des ausgefallenen Hosts zieht um; hostgebundene
// Typen, vorgemerkte Stops, Instanzen anderer Hosts und lokale Instanzen bleiben.
func TestLostHostRelocatesStandaloneInstances(t *testing.T) {
	svc, rel, metrics := standaloneSetup(t, "host-b")
	metrics.set("host-a", time.Now())
	svc.failoverTick()
	time.Sleep(50 * time.Millisecond)
	if n := len(rel.snapshot()); n != 0 {
		t.Fatalf("relocation although the host is online (%d)", n)
	}
	metrics.set("host-a", time.Now().Add(-2*defaultHostLossRelocateAfter))
	svc.failoverTick()
	waitFor(t, func() bool { return len(rel.snapshot()) == 1 })
	if got := rel.snapshot()[0]; got != [2]string{"free", "host-b"} {
		t.Fatalf("relocation = %v", got)
	}
}

func TestLostHostStandaloneNoTargetOrSwitchOff(t *testing.T) {
	svc, rel, metrics := standaloneSetup(t, "host-a") // Platzwahl liefert den verlorenen Host selbst
	metrics.set("host-a", time.Now().Add(-time.Hour))
	if n := svc.relocateStandaloneFromLostHost("host-a"); n != 0 || len(rel.snapshot()) != 0 {
		t.Fatalf("moved %d without target, calls %v", n, rel.snapshot())
	}

	svc.resources = fixedPlacer{host: "host-b"}
	t.Setenv("OMP_HOST_FAILURE_RELOCATE", "off")
	if n := svc.relocateStandaloneFromLostHost("host-a"); n != 0 || len(rel.snapshot()) != 0 {
		t.Fatalf("moved %d although switched off", n)
	}
	t.Setenv("OMP_HOST_FAILURE_RELOCATE", "")

	// Goodbye (Host-Agent absichtlich beendet): kein Umzug.
	svc2, rel2, _ := standaloneSetup(t, "host-b")
	svc2.hostMetrics.(*fakeHostMetrics).mu.Lock()
	svc2.hostMetrics.(*fakeHostMetrics).byID["host-a"] = hostsMetricsGoodbye()
	svc2.hostMetrics.(*fakeHostMetrics).known["host-a"] = true
	svc2.hostMetrics.(*fakeHostMetrics).mu.Unlock()
	if n := svc2.relocateStandaloneFromLostHost("host-a"); n != 0 || len(rel2.snapshot()) != 0 {
		t.Fatalf("moved %d after goodbye", n)
	}
}

func hostsMetricsGoodbye() hosts.Metrics {
	return hosts.Metrics{ReceivedAt: time.Now().Add(-time.Hour), Goodbye: true}
}
