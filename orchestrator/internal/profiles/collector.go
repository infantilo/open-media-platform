package profiles

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

// SampleInterval ist der Abstand zwischen zwei Abtastungen — bewusst
// gleich der Host-Agent-/Launcher-Sendefrequenz (Kapitel 14 Teil 2),
// damit keine Samples zwischen zwei Abtastungen "verpasst" werden, ohne
// häufiger als nötig über unveränderte Werte zu iterieren.
const SampleInterval = 5 * time.Second

// FlushInterval ist der Abstand zwischen zwei Postgres-Upserts — gleich
// Kapitel 14 Teil 1s Aggregat-Bucket-Größe (1 Minute), aus demselben
// Grund: kleine, aber regelmäßige Schreiblast statt eines Upserts pro
// Sample.
const FlushInterval = time.Minute

// bufferWindow ist das Zeitfenster, aus dem ein Snapshot berechnet wird
// — ein gleitendes Fenster statt eines seit Prozessstart unbegrenzt
// wachsenden Akkumulators, damit sich ein Profil an geänderte
// Lastmuster anpasst (z. B. ein Node-Typ, der nachträglich mit anderen
// Parametern läuft), statt für immer von sehr alten Samples dominiert
// zu werden.
const bufferWindow = 15 * time.Minute

// InstanceLister liefert alle bekannten Node-Instanzen (implementiert
// von *launcher.Launcher).
type InstanceLister interface {
	List() []launcher.Instance
}

// HostMetricsReader liefert die zuletzt per NATS empfangene Telemetrie
// eines Hosts (implementiert von *hosts.Tracker) — hier gebraucht, um
// entfernte Instanzen genau wie httpapi.mergeInstanceMetrics um
// CPU%/RSS anzureichern (Launcher kennt das hosts-Paket bewusst nicht,
// s. dortige Run()-Doku; dieselbe kleine, bewusste Duplikation wie an
// der httpapi-Stelle, kein Cross-Package-Import, um keinen Zyklus mit
// httpapi zu riskieren).
type HostMetricsReader interface {
	Get(hostID string) (hosts.Metrics, bool)
}

// SnapshotStore persistiert einen Snapshot (implementiert von *Store).
type SnapshotStore interface {
	Upsert(ctx context.Context, snap Snapshot) error
}

type bufferKey struct {
	nodeType string
	hostID   string
}

// Collector tastet periodisch alle bekannten Instanzen ab, hält pro
// (nodeType, hostID) ein gleitendes Sample-Fenster im Speicher und
// schreibt daraus regelmäßig aggregierte Snapshots (host-spezifisch
// plus einen Typ-Fallback über alle Hosts, s. Paketdoku) nach Postgres.
type Collector struct {
	instances   InstanceLister
	hostMetrics HostMetricsReader
	store       SnapshotStore

	mu      sync.Mutex
	buffers map[bufferKey][]Sample
}

// NewCollector erstellt einen Collector. store darf nicht nil sein.
func NewCollector(instances InstanceLister, hostMetrics HostMetricsReader, store SnapshotStore) *Collector {
	return &Collector{
		instances:   instances,
		hostMetrics: hostMetrics,
		store:       store,
		buffers:     make(map[bufferKey][]Sample),
	}
}

// Run blockiert bis ctx endet — als eigene Goroutine gestartet
// (main.go), gleiches Muster wie placement.Engine.Run.
func (c *Collector) Run(ctx context.Context) {
	sampleTicker := time.NewTicker(SampleInterval)
	defer sampleTicker.Stop()
	flushTicker := time.NewTicker(FlushInterval)
	defer flushTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-sampleTicker.C:
			c.sample()
		case <-flushTicker.C:
			c.flush(ctx)
		}
	}
}

// mergeInstanceMetrics reichert list um die zuletzt vom Host-Agent
// gemeldeten CPU%/RSS-Werte entfernter Instanzen an — 1:1 dieselbe
// Logik wie httpapi.mergeInstanceMetrics (Kapitel 14 Teil 2), hier
// dupliziert statt importiert (s. HostMetricsReader-Doku).
func mergeInstanceMetrics(list []launcher.Instance, hostMetrics HostMetricsReader) {
	for i := range list {
		if list[i].HostID == "" || list[i].CPUPercent != nil {
			continue
		}
		m, ok := hostMetrics.Get(list[i].HostID)
		if !ok {
			continue
		}
		for _, im := range m.Instances {
			if im.InstanceID != list[i].ID {
				continue
			}
			cpu, rss := im.CPUPercent, im.RSSBytes
			list[i].CPUPercent = &cpu
			list[i].RSSBytes = &rss
			break
		}
	}
}

// sample tastet einmal alle Instanzen ab und hängt für jede mit einem
// bekannten CPU%/RSS-Wert ein Sample an ihr (nodeType, hostID)-Fenster.
func (c *Collector) sample() {
	list := c.instances.List()
	mergeInstanceMetrics(list, c.hostMetrics)

	now := time.Now()
	cutoff := now.Add(-bufferWindow)

	c.mu.Lock()
	defer c.mu.Unlock()
	for _, inst := range list {
		if inst.CPUPercent == nil || inst.RSSBytes == nil {
			continue
		}
		k := bufferKey{nodeType: inst.Type, hostID: inst.HostID}
		buf := append(c.buffers[k], Sample{Timestamp: now, CPUPercent: *inst.CPUPercent, RSSBytes: *inst.RSSBytes})
		buf = trimBefore(buf, cutoff)
		c.buffers[k] = buf
	}
}

func trimBefore(samples []Sample, cutoff time.Time) []Sample {
	i := 0
	for i < len(samples) && samples[i].Timestamp.Before(cutoff) {
		i++
	}
	if i == 0 {
		return samples
	}
	return samples[i:]
}

// flush berechnet aus jedem aktuellen Sample-Fenster einen Snapshot und
// schreibt ihn nach Postgres — zusätzlich einen Typ-Fallback-Snapshot
// (GlobalHostID) über alle Hosts hinweg pro nodeType (s. Paketdoku).
func (c *Collector) flush(ctx context.Context) {
	c.mu.Lock()
	windows := make(map[bufferKey][]Sample, len(c.buffers))
	for k, v := range c.buffers {
		if len(v) == 0 {
			continue
		}
		windows[k] = append([]Sample(nil), v...)
	}
	c.mu.Unlock()

	now := time.Now()
	perType := make(map[string][]Sample)
	for k, samples := range windows {
		snap := computeSnapshot(k.nodeType, k.hostID, samples, now)
		if err := c.store.Upsert(ctx, snap); err != nil {
			slog.Warn("profiles: upsert failed", "node_type", k.nodeType, "host_id", k.hostID, "error", err)
		}
		perType[k.nodeType] = append(perType[k.nodeType], samples...)
	}
	for nodeType, samples := range perType {
		snap := computeSnapshot(nodeType, GlobalHostID, samples, now)
		if err := c.store.Upsert(ctx, snap); err != nil {
			slog.Warn("profiles: upsert (global) failed", "node_type", nodeType, "error", err)
		}
	}
}
