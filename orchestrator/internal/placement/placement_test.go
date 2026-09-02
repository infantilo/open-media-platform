package placement

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

type fakeHosts struct{ hosts []hosts.Host }

func (f fakeHosts) ListHosts() ([]hosts.Host, error) { return f.hosts, nil }

type fakeMetrics map[string]hosts.Metrics

// Get füllt einen fehlenden (Zeitwert-Null-)ReceivedAt mit time.Now() —
// die Test-Fixtures unten setzen ReceivedAt nie explizit, meinen mit
// einem Eintrag aber "Telemetrie für diesen Host liegt vor und ist
// aktuell", nicht "vor Jahrzehnten empfangen". Ohne das würde
// SelectHosts hostOnline()-Gate (s. dortige Live-Fund-Doku) jeden
// Fixture-Host als nicht erreichbar behandeln.
func (f fakeMetrics) Get(hostID string) (hosts.Metrics, bool) {
	m, ok := f[hostID]
	if ok && m.ReceivedAt.IsZero() {
		m.ReceivedAt = time.Now()
	}
	return m, ok
}

type fakeInstances struct{ instances []launcher.Instance }

func (f fakeInstances) List() []launcher.Instance { return f.instances }

type fakeEvents struct{ events []sse.Event }

func (f *fakeEvents) Broadcast(e sse.Event) { f.events = append(f.events, e) }

// fakeProfiles ist ein Test-Double für ProfileReader, keyed
// (nodeType, hostID) — identisch zur echten Fallback-Semantik
// (Aufrufer fragt profiles.GlobalHostID separat nach, wenn der
// host-spezifische Eintrag fehlt).
type fakeProfiles map[[2]string]profiles.Snapshot

func (f fakeProfiles) Get(_ context.Context, nodeType, hostID string) (profiles.Snapshot, bool, error) {
	snap, ok := f[[2]string{nodeType, hostID}]
	return snap, ok, nil
}

func testThresholds() Thresholds {
	return Thresholds{
		CPUPercent: 85, MemPercent: 90, NetPercent: 85,
		HealthyCPUPercent: 60, HealthyMemPercent: 70, HealthyNetPercent: 60,
	}
}

func TestEvaluateOnceNoAdviceBelowThreshold(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}}}
	mr := fakeMetrics{"h1": {CPUPercent: 50, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	il := fakeInstances{instances: []launcher.Instance{{ID: "i1", HostID: "h1"}}}

	e := NewEngine(hl, mr, il, nil, testThresholds(), nil)
	e.evaluateOnce()

	if got := e.List(); len(got) != 0 {
		t.Fatalf("List() = %+v, want empty (host below threshold)", got)
	}
}

func TestEvaluateOnceNoAdviceWithoutInstances(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}}}
	mr := fakeMetrics{"h1": {CPUPercent: 95, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	il := fakeInstances{} // keine Instanzen auf h1

	e := NewEngine(hl, mr, il, nil, testThresholds(), nil)
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
	e := NewEngine(hl, mr, il, events, testThresholds(), nil)
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

// TestEvaluateOnceAdviceForNetOverload (Nutzerauftrag 2026-09-02):
// h1 ist bei CPU/RAM unauffällig, aber die NIC ist zu 95% ausgelastet —
// muss denselben Alarm+Vorschlag-Weg wie ein CPU-Überlast auslösen.
func TestEvaluateOnceAdviceForNetOverload(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{
		{ID: "h1", Label: "Host 1"},
		{ID: "h2", Label: "Host 2"},
	}}
	mr := fakeMetrics{
		"h1": {
			CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000,
			Net: &hosts.NetMetrics{Iface: "eth0", RxBytesPerSec: 10_000_000, TxBytesPerSec: 1_875_000, LinkMbps: 100}, // 95%
		},
		"h2": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000}, // gesund, kein Net konfiguriert
	}
	il := fakeInstances{instances: []launcher.Instance{{ID: "i1", HostID: "h1"}}}

	e := NewEngine(hl, mr, il, nil, testThresholds(), nil)
	e.evaluateOnce()

	got := e.List()
	if len(got) != 1 {
		t.Fatalf("List() = %+v, want exactly one advice", got)
	}
	a := got[0]
	if a.Reason != "net" {
		t.Errorf("Reason = %q, want net", a.Reason)
	}
	if a.NetPercent == nil || *a.NetPercent < 85 {
		t.Errorf("NetPercent = %v, want a pointer to a value >= 85", a.NetPercent)
	}
	if a.SuggestedHostID != "h2" {
		t.Errorf("SuggestedHostID = %q, want h2", a.SuggestedHostID)
	}
}

// TestEvaluateOnceSkipsNetOverloadedHostAsSuggestion: h2 ist bei CPU/RAM
// gesund, aber seine NIC liegt über HealthyNetPercent — darf NICHT als
// Ausweichziel für den überlasteten h1 vorgeschlagen werden.
func TestEvaluateOnceSkipsNetOverloadedHostAsSuggestion(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{
		{ID: "h1", Label: "Host 1"},
		{ID: "h2", Label: "Host 2"},
	}}
	mr := fakeMetrics{
		"h1": {CPUPercent: 95, MemUsedBytes: 1000, MemTotalBytes: 4000},
		"h2": {
			CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000,
			Net: &hosts.NetMetrics{Iface: "eth0", RxBytesPerSec: 10_000_000, TxBytesPerSec: 1_875_000, LinkMbps: 100}, // 95%, über HealthyNetPercent (60)
		},
	}
	il := fakeInstances{instances: []launcher.Instance{{ID: "i1", HostID: "h1"}}}

	e := NewEngine(hl, mr, il, nil, testThresholds(), nil)
	e.evaluateOnce()

	got := e.List()
	if len(got) != 1 {
		t.Fatalf("List() = %+v, want exactly one advice", got)
	}
	if got[0].SuggestedHostID != "" {
		t.Errorf("SuggestedHostID = %q, want empty (h2's NIC is over the healthy threshold)", got[0].SuggestedHostID)
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

	e := NewEngine(hl, mr, il, nil, testThresholds(), nil)
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
	e := NewEngine(hl, mr, il, events, testThresholds(), nil)
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
	e := NewEngine(hl, mr, il, events, testThresholds(), nil)
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

	e := NewEngine(hl, mr, il, nil, testThresholds(), nil)
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

	e := NewEngine(hl, mr, il, nil, testThresholds(), nil)
	e.evaluateOnce()

	if got := e.List(); len(got) != 0 {
		t.Fatalf("List() = %+v, want empty (only local instance exists)", got)
	}
}

// --- CheckHost (workflows.ResourcePrecheck, UMSETZUNG.md D7 Teil 2) ---

func TestCheckHostOKBelowThreshold(t *testing.T) {
	mr := fakeMetrics{"h1": {CPUPercent: 50, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds(), nil)

	if reason, ok := e.CheckHost("h1", "omp-video-mixer-me"); !ok || reason != "" {
		t.Fatalf("CheckHost() = (%q, %v), want (\"\", true)", reason, ok)
	}
}

func TestCheckHostRejectsOverCPUThreshold(t *testing.T) {
	mr := fakeMetrics{"h1": {CPUPercent: 95, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds(), nil)

	reason, ok := e.CheckHost("h1", "omp-video-mixer-me")
	if ok || reason == "" {
		t.Fatalf("CheckHost() = (%q, %v), want a non-empty rejection reason", reason, ok)
	}
}

func TestCheckHostRejectsOverMemThreshold(t *testing.T) {
	mr := fakeMetrics{"h1": {CPUPercent: 10, MemUsedBytes: 3800, MemTotalBytes: 4000}} // 95% mem
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds(), nil)

	if _, ok := e.CheckHost("h1", "omp-video-mixer-me"); ok {
		t.Fatalf("CheckHost() ok = true, want false (mem over threshold)")
	}
}

// TestCheckHostRejectsOverNetThreshold (Nutzerauftrag 2026-09-02):
// RxBytesPerSec+TxBytesPerSec ergeben zusammen 90 Mbit/s auf einem
// 100-MBit-Link (LinkMbps: 100) — 90% liegt über der 85%-Schwelle.
func TestCheckHostRejectsOverNetThreshold(t *testing.T) {
	mr := fakeMetrics{"h1": {
		CPUPercent: 10, MemUsedBytes: 1000, MemTotalBytes: 4000,
		Net: &hosts.NetMetrics{Iface: "eth0", RxBytesPerSec: 8_000_000, TxBytesPerSec: 3_250_000, LinkMbps: 100},
	}}
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds(), nil)

	reason, ok := e.CheckHost("h1", "omp-video-mixer-me")
	if ok || reason == "" {
		t.Fatalf("CheckHost() = (%q, %v), want a non-empty rejection reason (net over threshold)", reason, ok)
	}
	if !strings.Contains(reason, "Netz") {
		t.Errorf("reason = %q, want it to mention Netz", reason)
	}
}

// TestCheckHostOKWhenNetLinkSpeedUnknown: derselbe Durchsatz wie oben,
// aber LinkMbps == 0 (Treiber meldet keine Verbindungsgeschwindigkeit,
// z. B. virtuelles Interface) — kein Prozentwert berechenbar, also
// fail-open für die Netz-Dimension (kein Rateversuch, s.
// netUtilizationPercent-Doku).
func TestCheckHostOKWhenNetLinkSpeedUnknown(t *testing.T) {
	mr := fakeMetrics{"h1": {
		CPUPercent: 10, MemUsedBytes: 1000, MemTotalBytes: 4000,
		Net: &hosts.NetMetrics{Iface: "eth0", RxBytesPerSec: 8_000_000, TxBytesPerSec: 3_250_000, LinkMbps: 0},
	}}
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds(), nil)

	if reason, ok := e.CheckHost("h1", "omp-video-mixer-me"); !ok || reason != "" {
		t.Fatalf("CheckHost() = (%q, %v), want (\"\", true) — unbekannte Link-Kapazität darf nicht blockieren", reason, ok)
	}
}

func TestCheckHostOKWhenNoTelemetrySeen(t *testing.T) {
	e := NewEngine(fakeHosts{}, fakeMetrics{}, fakeInstances{}, nil, testThresholds(), nil)

	// Fail-open: ein Host, von dem noch nie Telemetrie kam, darf einen
	// Workflow-Start nicht blockieren (s. checkResources-Doku).
	if reason, ok := e.CheckHost("never-seen", "omp-video-mixer-me"); !ok || reason != "" {
		t.Fatalf("CheckHost() = (%q, %v), want (\"\", true) for unseen host", reason, ok)
	}
}

// --- Kapitel 14 Teil 4: CheckHost rechnet mit Profilen ---

func TestCheckHostOKWithoutProfileReader(t *testing.T) {
	// profileReader=nil (Vor-Teil-4-Verhalten): reiner Momentwert-Check,
	// unverändert gegenüber den Tests oben.
	mr := fakeMetrics{"h1": {CPUPercent: 50, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds(), nil)

	if reason, ok := e.CheckHost("h1", "omp-video-mixer-me"); !ok || reason != "" {
		t.Fatalf("CheckHost() = (%q, %v), want (\"\", true)", reason, ok)
	}
}

func TestCheckHostRejectsWhenMomentValueOKButProfileProjectionExceedsThreshold(t *testing.T) {
	// Host allein bei 50% CPU (unter der 85%-Alarmschwelle) — aber
	// omp-video-mixer-me braucht laut Profil typisch weitere 40%, macht
	// projiziert 90%, über der Schwelle. Der reine Momentwert-Check
	// (Vor-Teil-4) hätte das übersehen.
	mr := fakeMetrics{"h1": {CPUPercent: 50, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	pr := fakeProfiles{{"omp-video-mixer-me", "h1"}: {NodeType: "omp-video-mixer-me", HostID: "h1", CPUAvg: 40}}
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds(), pr)

	reason, ok := e.CheckHost("h1", "omp-video-mixer-me")
	if ok || reason == "" {
		t.Fatalf("CheckHost() = (%q, %v), want rejection (projected 90%% CPU über 85%%-Schwelle)", reason, ok)
	}
}

func TestCheckHostOKWhenProfileProjectionStaysBelowThreshold(t *testing.T) {
	mr := fakeMetrics{"h1": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	pr := fakeProfiles{{"omp-source", "h1"}: {NodeType: "omp-source", HostID: "h1", CPUAvg: 15}}
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds(), pr)

	if reason, ok := e.CheckHost("h1", "omp-source"); !ok || reason != "" {
		t.Fatalf("CheckHost() = (%q, %v), want (\"\", true) (projected 35%% CPU, weit unter der Schwelle)", reason, ok)
	}
}

func TestCheckHostFallsBackToGlobalProfileWhenNoHostSpecificProfileExists(t *testing.T) {
	mr := fakeMetrics{"h2": {CPUPercent: 50, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	// Kein Eintrag für ("omp-video-mixer-me", "h2") — nur der
	// Typ-Fallback über alle Hosts hinweg.
	pr := fakeProfiles{{"omp-video-mixer-me", profiles.GlobalHostID}: {NodeType: "omp-video-mixer-me", HostID: profiles.GlobalHostID, CPUAvg: 40}}
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds(), pr)

	reason, ok := e.CheckHost("h2", "omp-video-mixer-me")
	if ok || reason == "" {
		t.Fatalf("CheckHost() = (%q, %v), want rejection via Typ-Fallback-Profil (projected 90%%)", reason, ok)
	}
}

func TestCheckHostOKWhenNoProfileKnownAtAllEvenWithReaderSet(t *testing.T) {
	// profileReader ist gesetzt, kennt aber diesen Node-Typ noch gar
	// nicht (erster Start) — fail-open, kein stiller Block mangels
	// Datengrundlage (§14.3d).
	mr := fakeMetrics{"h1": {CPUPercent: 50, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	e := NewEngine(fakeHosts{}, mr, fakeInstances{}, nil, testThresholds(), fakeProfiles{})

	if reason, ok := e.CheckHost("h1", "omp-brand-new-node-type"); !ok || reason != "" {
		t.Fatalf("CheckHost() = (%q, %v), want (\"\", true) for a never-profiled node type", reason, ok)
	}
}

// --- SelectHost (Nachtrag 99, ARCHITECTURE.md §6.1/§16-Erweiterung) ---

func TestSelectHostPreferredHostHealthyIsChosen(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}, {ID: "h2", Label: "Host 2"}}}
	mr := fakeMetrics{
		"h1": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000},
		"h2": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000},
	}
	e := NewEngine(hl, mr, fakeInstances{}, nil, testThresholds(), nil)

	result := e.SelectHost(PlacementRequest{NodeType: "omp-source", PreferredHostID: "h1"}, Occupancy{})
	if result.HostID != "h1" {
		t.Fatalf("SelectHost().HostID = %q, want %q (preferred host healthy)", result.HostID, "h1")
	}
}

func TestSelectHostFallsBackWhenPreferredHostOverloaded(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}, {ID: "h2", Label: "Host 2"}}}
	mr := fakeMetrics{
		"h1": {CPUPercent: 95, MemUsedBytes: 1000, MemTotalBytes: 4000}, // over threshold
		"h2": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000},
	}
	e := NewEngine(hl, mr, fakeInstances{}, nil, testThresholds(), nil)

	result := e.SelectHost(PlacementRequest{NodeType: "omp-source", PreferredHostID: "h1"}, Occupancy{})
	if result.HostID != "h2" {
		t.Fatalf("SelectHost().HostID = %q, want %q (preferred host overloaded, must fall back)", result.HostID, "h2")
	}
	if result.Reason == "" {
		t.Fatalf("SelectHost().Reason is empty, want an explanation for the fallback")
	}
}

// TestSelectHostNetPercentBreaksCPUMemTie (Nutzerauftrag 2026-09-02): h1
// und h2 sind bei CPU/RAM exakt gleichauf — ohne Präferenz muss der mit
// der niedrigeren NIC-Auslastung gewinnen, nicht einfach der erste im
// Ergebnis von ListHosts().
func TestSelectHostNetPercentBreaksCPUMemTie(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}, {ID: "h2", Label: "Host 2"}}}
	mr := fakeMetrics{
		"h1": {
			CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000,
			Net: &hosts.NetMetrics{Iface: "eth0", RxBytesPerSec: 5_000_000, TxBytesPerSec: 0, LinkMbps: 100}, // 40%
		},
		"h2": {
			CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000,
			Net: &hosts.NetMetrics{Iface: "eth0", RxBytesPerSec: 1_250_000, TxBytesPerSec: 0, LinkMbps: 100}, // 10%
		},
	}
	e := NewEngine(hl, mr, fakeInstances{}, nil, testThresholds(), nil)

	result := e.SelectHost(PlacementRequest{NodeType: "omp-source"}, Occupancy{})
	if result.HostID != "h2" {
		t.Fatalf("SelectHost().HostID = %q, want %q (lower NIC utilization at equal CPU/RAM)", result.HostID, "h2")
	}
}

func TestSelectHostFallsBackToLocalWhenPreferredHostUnknown(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}}}
	mr := fakeMetrics{"h1": {CPUPercent: 95, MemUsedBytes: 1000, MemTotalBytes: 4000}} // only host, overloaded
	e := NewEngine(hl, mr, fakeInstances{}, nil, testThresholds(), nil)

	result := e.SelectHost(PlacementRequest{NodeType: "omp-source", PreferredHostID: "does-not-exist"}, Occupancy{})
	if result.HostID != "" {
		t.Fatalf("SelectHost().HostID = %q, want \"\" (local fallback, no viable remote host)", result.HostID)
	}
}

func TestSelectHostFallsBackToLocalWhenNoHostsRegistered(t *testing.T) {
	e := NewEngine(fakeHosts{}, fakeMetrics{}, fakeInstances{}, nil, testThresholds(), nil)

	result := e.SelectHost(PlacementRequest{NodeType: "omp-source"}, Occupancy{})
	if result.HostID != "" {
		t.Fatalf("SelectHost().HostID = %q, want \"\" (no hosts registered at all)", result.HostID)
	}
}

func TestSelectHostAvoidsRedundancyGroupCollocation(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}, {ID: "h2", Label: "Host 2"}}}
	mr := fakeMetrics{
		"h1": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000},
		"h2": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000},
	}
	e := NewEngine(hl, mr, fakeInstances{}, nil, testThresholds(), nil)

	// h1 already runs a role tagged "mixer-pair" — the redundant sibling
	// being placed now (same tag) must avoid h1, even though h1 looks
	// just as healthy as h2.
	occ := Occupancy{RedundancyGroupHosts: map[string][]string{"mixer-pair": {"h1"}}}
	result := e.SelectHost(PlacementRequest{NodeType: "omp-video-mixer-me", RedundancyGroup: "mixer-pair"}, occ)
	if result.HostID != "h2" {
		t.Fatalf("SelectHost().HostID = %q, want %q (must avoid the host already running the redundant sibling)", result.HostID, "h2")
	}
}

func TestSelectHostAcceptsRedundancyCollocationWhenNoAlternative(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}}}
	mr := fakeMetrics{"h1": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	e := NewEngine(hl, mr, fakeInstances{}, nil, testThresholds(), nil)

	// Only one viable host exists, and it already runs the redundant
	// sibling — the start must still succeed (never block), just with a
	// reason that flags the accepted conflict.
	occ := Occupancy{RedundancyGroupHosts: map[string][]string{"mixer-pair": {"h1"}}}
	result := e.SelectHost(PlacementRequest{NodeType: "omp-video-mixer-me", RedundancyGroup: "mixer-pair"}, occ)
	if result.HostID != "h1" {
		t.Fatalf("SelectHost().HostID = %q, want %q (no alternative, must still place)", result.HostID, "h1")
	}
	if result.Reason == "" {
		t.Fatalf("SelectHost().Reason is empty, want a note about the accepted redundancy conflict")
	}
}

func TestSelectHostPrefersAffinityGroupCollocation(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}, {ID: "h2", Label: "Host 2"}}}
	mr := fakeMetrics{
		// h2 looks slightly healthier than h1 on raw load...
		"h1": {CPUPercent: 30, MemUsedBytes: 1000, MemTotalBytes: 4000},
		"h2": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000},
	}
	e := NewEngine(hl, mr, fakeInstances{}, nil, testThresholds(), nil)

	// ...but h1 already runs the affinity-group sibling (latency/DMA
	// co-location need), which should win over the raw load difference.
	occ := Occupancy{AffinityGroupHosts: map[string][]string{"dma-cluster": {"h1"}}}
	result := e.SelectHost(PlacementRequest{NodeType: "omp-source", AffinityGroup: "dma-cluster"}, occ)
	if result.HostID != "h1" {
		t.Fatalf("SelectHost().HostID = %q, want %q (affinity co-location should win over minor load difference)", result.HostID, "h1")
	}
}

func TestSelectHostForecastExtraLoadMakesHostUnattractive(t *testing.T) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}, {ID: "h2", Label: "Host 2"}}}
	// h1 looks free right now (30% CPU)...
	mr := fakeMetrics{
		"h1": {CPUPercent: 30, MemUsedBytes: 1000, MemTotalBytes: 4000},
		"h2": {CPUPercent: 40, MemUsedBytes: 1000, MemTotalBytes: 4000},
	}
	e := NewEngine(hl, mr, fakeInstances{}, nil, testThresholds(), nil)

	// ...but a scheduled workflow is about to claim another 60% CPU on
	// h1 (Scheduler-Forecast) — projected 90%, over the 85% threshold,
	// so h1 must be rejected in favor of h2 even though h2's live value
	// alone is higher.
	occ := Occupancy{ExtraLoad: map[string]profiles.Snapshot{"h1": {CPUAvg: 60}}}
	result := e.SelectHost(PlacementRequest{NodeType: "omp-source"}, occ)
	if result.HostID != "h2" {
		t.Fatalf("SelectHost().HostID = %q, want %q (forecast load should make h1 unattractive)", result.HostID, "h2")
	}
}
