package profiles

import (
	"context"
	"sync"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

type fakeInstanceLister struct {
	instances []launcher.Instance
}

func (f *fakeInstanceLister) List() []launcher.Instance {
	// Kopie zurückgeben, damit ein Aufrufer (mergeInstanceMetrics)
	// Pointer-Felder setzen kann, ohne die Fixture selbst zu mutieren —
	// gleiches Verhalten wie launcher.Launcher.List() (dortiges Kopieren
	// beim Mischen).
	out := make([]launcher.Instance, len(f.instances))
	copy(out, f.instances)
	return out
}

type fakeHostMetrics struct {
	byHost map[string]hosts.Metrics
}

func (f *fakeHostMetrics) Get(hostID string) (hosts.Metrics, bool) {
	m, ok := f.byHost[hostID]
	return m, ok
}

type fakeStore struct {
	mu      sync.Mutex
	upserts []Snapshot
}

func (f *fakeStore) Upsert(_ context.Context, snap Snapshot) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upserts = append(f.upserts, snap)
	return nil
}

func (f *fakeStore) find(nodeType, hostID string) (Snapshot, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.upserts) - 1; i >= 0; i-- {
		if f.upserts[i].NodeType == nodeType && f.upserts[i].HostID == hostID {
			return f.upserts[i], true
		}
	}
	return Snapshot{}, false
}

func cpuRSS(cpu float64, rss uint64) (*float64, *uint64) {
	return &cpu, &rss
}

func TestCollectorSampleAndFlushLocalInstance(t *testing.T) {
	cpu, rss := cpuRSS(15, 200_000_000)
	lister := &fakeInstanceLister{instances: []launcher.Instance{
		{ID: "i1", Type: "omp-video-mixer-me", HostID: "", CPUPercent: cpu, RSSBytes: rss},
	}}
	store := &fakeStore{}
	c := NewCollector(lister, &fakeHostMetrics{}, store)

	c.sample()
	c.flush(context.Background())

	snap, ok := store.find("omp-video-mixer-me", "")
	if !ok {
		t.Fatalf("no snapshot upserted for (omp-video-mixer-me, local)")
	}
	if snap.SampleCount != 1 || snap.CPUAvg != 15 || snap.RSSAvg != 200_000_000 {
		t.Errorf("unexpected local snapshot: %+v", snap)
	}

	globalSnap, ok := store.find("omp-video-mixer-me", GlobalHostID)
	if !ok {
		t.Fatalf("no global fallback snapshot upserted")
	}
	if globalSnap.SampleCount != 1 || globalSnap.CPUAvg != 15 {
		t.Errorf("unexpected global snapshot: %+v", globalSnap)
	}
}

func TestCollectorSkipsInstancesWithoutSample(t *testing.T) {
	lister := &fakeInstanceLister{instances: []launcher.Instance{
		{ID: "i1", Type: "omp-source", HostID: "", CPUPercent: nil, RSSBytes: nil},
	}}
	store := &fakeStore{}
	c := NewCollector(lister, &fakeHostMetrics{}, store)

	c.sample()
	c.flush(context.Background())

	if len(store.upserts) != 0 {
		t.Errorf("expected no upserts for an instance without a resource sample, got %d", len(store.upserts))
	}
}

func TestCollectorMergesRemoteInstanceMetrics(t *testing.T) {
	lister := &fakeInstanceLister{instances: []launcher.Instance{
		{ID: "remote-1", Type: "omp-switcher", HostID: "host-a"},
	}}
	hostMetrics := &fakeHostMetrics{byHost: map[string]hosts.Metrics{
		"host-a": {Instances: []hosts.InstanceMetrics{
			{InstanceID: "remote-1", CPUPercent: 33, RSSBytes: 50_000_000},
		}},
	}}
	store := &fakeStore{}
	c := NewCollector(lister, hostMetrics, store)

	c.sample()
	c.flush(context.Background())

	snap, ok := store.find("omp-switcher", "host-a")
	if !ok {
		t.Fatalf("no snapshot upserted for remote instance")
	}
	if snap.CPUAvg != 33 || snap.RSSAvg != 50_000_000 {
		t.Errorf("unexpected merged remote snapshot: %+v", snap)
	}
}

func TestCollectorTwoInstancesSameTypeDifferentHostsFeedGlobalFallback(t *testing.T) {
	cpuA, rssA := cpuRSS(10, 100_000_000)
	cpuB, rssB := cpuRSS(30, 300_000_000)
	lister := &fakeInstanceLister{instances: []launcher.Instance{
		{ID: "i1", Type: "omp-video-mixer-me", HostID: "", CPUPercent: cpuA, RSSBytes: rssA},
		{ID: "i2", Type: "omp-video-mixer-me", HostID: "host-b", CPUPercent: cpuB, RSSBytes: rssB},
	}}
	store := &fakeStore{}
	c := NewCollector(lister, &fakeHostMetrics{}, store)

	c.sample()
	c.flush(context.Background())

	globalSnap, ok := store.find("omp-video-mixer-me", GlobalHostID)
	if !ok {
		t.Fatalf("no global fallback snapshot upserted")
	}
	if globalSnap.SampleCount != 2 {
		t.Errorf("global fallback should combine samples across hosts, SampleCount = %d, want 2", globalSnap.SampleCount)
	}
	if globalSnap.CPUAvg != 20 {
		t.Errorf("global fallback CPUAvg = %v, want 20 (avg of 10 and 30)", globalSnap.CPUAvg)
	}
}
