// Package placement implementiert die erste Ausbaustufe der
// Resource-Aware Placement-Engine (ARCHITECTURE.md §6.1, UMSETZUNG.md D6
// Teil 3): "advisory zuerst" — die Engine beobachtet die bereits seit D6
// Teil 1 vorhandene Host-Telemetrie (CPU/RAM über NATS,
// internal/hosts.Tracker) und schlägt bei überlasteten Hosts mit
// laufenden Instanzen einen Ausweichhost vor. Sie führt **nichts aus**:
// kein Start einer Ersatz-Instanz, kein IS-05-Umschalten, kein Teardown
// — das vollständige Make-before-break-Protokoll (§6.1 Punkt 3) sowie
// die pro-Rolle konfigurierbaren Eskalationsstufen (advisory/
// auto-confirm-window/auto, §6.1 Erweiterung 2026-07-13) sind erst
// sinnvoll, sobald es überhaupt eine automatische Ausführung gibt —
// dokumentierte Folgearbeit, siehe docs/decisions.md D6 Teil 3.
//
// Ebenfalls bewusst nicht in dieser Runde: I/O-Karten-Claim/Release
// (§6.1 Erweiterung 2026-07-10 — braucht ein noch nicht existierendes
// Geräte-Inventar), GPU/NIC-Telemetrie (§18.4: herstellerspezifisch),
// Cloud-Kostenfaktor (§6.1 Punkt 4). Das Kernpaket ist bewusst
// host-klassen-unwissend (§6.1 Erweiterung 2026-07-13 Punkt 1: "ein
// Metrik-Schema, drei Quellen, ein Bus") — es liest ausschließlich
// hosts.Tracker, unabhängig davon, ob die Telemetrie von einem
// Bare-Metal-, VM- oder Cloud-Host-Agent stammt.
package placement

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"reflect"
	"sort"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// EvaluateInterval ist der Abstand zwischen zwei Bewertungsläufen —
// bewusst gleich der Telemetrie-Sendefrequenz des Host-Agent
// (host-agent/main.go: telemetryInterval = 5s), damit eine Bewertung
// selten auf veralteten Daten läuft, ohne unnötig oft über unveränderte
// Metriken zu iterieren.
const EvaluateInterval = 5 * time.Second

// HostLister liefert alle registrierten Hosts (implementiert von
// *hosts.Store).
type HostLister interface {
	ListHosts() ([]hosts.Host, error)
}

// MetricsReader liefert die zuletzt per NATS empfangene Telemetrie eines
// Hosts (implementiert von *hosts.Tracker).
type MetricsReader interface {
	Get(hostID string) (hosts.Metrics, bool)
}

// InstanceLister liefert alle bekannten Node-Instanzen samt ihrer
// HostID (implementiert von *launcher.Launcher) — die Placement-Engine
// warnt nur vor Hosts, auf denen tatsächlich etwas läuft; ein
// überlasteter, aber leerer Host ist niemandes Problem.
type InstanceLister interface {
	List() []launcher.Instance
}

// ProfileReader liefert das aggregierte Verbrauchsprofil eines Node-Typs
// (implementiert von *profiles.Store, Kapitel 14 Teil 3/4) — CheckHost
// nutzt es, um den erwarteten Bedarf des NEU zu startenden Node-Typs auf
// die aktuelle Host-Auslastung zu projizieren, statt nur mit dem
// Momentwert zu rechnen (§14.3d/§14.4 Teil 4: "D7-Teil-2-Vorprüfung
// rechnet mit Profilen"). Darf nil sein (dann rein Momentwert-basiert,
// unverändertes Vor-Teil-4-Verhalten — z. B. in Tests ohne eigene
// Profil-Fixture).
type ProfileReader interface {
	Get(ctx context.Context, nodeType, hostID string) (profiles.Snapshot, bool, error)
}

// EventPublisher verteilt ein SSE-Event an alle verbundenen Flow-Editor-
// Clients (implementiert von *sse.Hub) — optional, darf nil sein (z. B.
// in Tests), gleiches Muster wie launcher.EventPublisher.
type EventPublisher interface {
	Broadcast(sse.Event)
}

// Thresholds steuert, ab wann ein Host als überlastet gilt und ab wann
// ein anderer Host als Ausweichziel taugt. HealthyCPUPercent/
// HealthyMemPercent liegen bewusst unter CPUPercent/MemPercent (mit
// Abstand dazwischen) — ein Kandidat, der selbst nur knapp unter der
// Alarmschwelle liegt, wäre kein sinnvoller Vorschlag.
type Thresholds struct {
	CPUPercent        float64
	MemPercent        float64
	HealthyCPUPercent float64
	HealthyMemPercent float64
}

// DefaultThresholds sind die Dev-Defaults (config.Load) — 85%/90% Alarm,
// 60%/70% "gilt als Ausweichziel geeignet". Großzügig genug, um auf
// einer Single-Host-Dev-Maschine mit fingierten Metriken beide Fälle
// (Alarm mit und ohne verfügbaren Ausweichhost) gezielt provozieren zu
// können.
var DefaultThresholds = Thresholds{
	CPUPercent:        85,
	MemPercent:        90,
	HealthyCPUPercent: 60,
	HealthyMemPercent: 70,
}

// Advice ist der aktuelle Alarm+Vorschlag für genau einen überlasteten
// Host. SuggestedHostID ist leer, wenn kein Ausweichhost unter den
// Healthy-Schwellwerten gefunden wurde — ein ehrlicher Befund
// ("nicht migrierbar", §6.1 Punkt 3 der I/O-Karten-Erweiterung nennt
// dasselbe Prinzip für den Hardware-Fall), kein stiller Fallback auf
// irgendeinen Host.
type Advice struct {
	HostID             string    `json:"hostId"`
	HostLabel          string    `json:"hostLabel"`
	Reason             string    `json:"reason"` // "cpu", "mem" oder "cpu+mem"
	CPUPercent         float64   `json:"cpuPercent"`
	MemPercent         float64   `json:"memPercent"`
	InstanceIDs        []string  `json:"instanceIds"`
	SuggestedHostID    string    `json:"suggestedHostId,omitempty"`
	SuggestedHostLabel string    `json:"suggestedHostLabel,omitempty"`
	DetectedAt         time.Time `json:"detectedAt"`
}

// Engine bewertet periodisch alle Hosts gegen Thresholds und hält den
// zuletzt berechneten Alarm-Stand vor (GET /api/v1/placement/advice).
type Engine struct {
	hostLister HostLister
	metrics    MetricsReader
	instances  InstanceLister
	events     EventPublisher
	thresholds Thresholds
	profiles   ProfileReader

	mu     sync.RWMutex
	advice map[string]Advice // hostID -> aktueller Alarm
}

// NewEngine erstellt eine Engine. events darf nil sein (kein SSE-Fanout,
// z. B. in Tests). profileReader darf ebenfalls nil sein (CheckHost
// rechnet dann rein mit Momentwerten, s. ProfileReader-Doku).
func NewEngine(hostLister HostLister, metrics MetricsReader, instances InstanceLister, events EventPublisher, thresholds Thresholds, profileReader ProfileReader) *Engine {
	return &Engine{
		hostLister: hostLister,
		metrics:    metrics,
		instances:  instances,
		events:     events,
		thresholds: thresholds,
		profiles:   profileReader,
		advice:     map[string]Advice{},
	}
}

// Run bewertet bis ctx beendet wird, im EvaluateInterval-Takt. Ein
// einzelner fehlgeschlagener Lauf (z. B. Postgres kurzzeitig weg) wird
// geloggt, der letzte gute Stand bleibt bestehen — gleiche
// Robustheits-Linie wie registry.Poller.Run.
func (e *Engine) Run(ctx context.Context) {
	e.evaluateOnce()

	ticker := time.NewTicker(EvaluateInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.evaluateOnce()
		}
	}
}

// List liefert den aktuellen Alarm-Stand, nach HostID sortiert (stabile
// Reihenfolge für die API-Antwort/UI, kein Map-Iterations-Jitter).
func (e *Engine) List() []Advice {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]Advice, 0, len(e.advice))
	for _, a := range e.advice {
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].HostID < out[j].HostID })
	return out
}

// CheckHost implementiert workflows.ResourcePrecheck (UMSETZUNG.md D7
// Teil 2, ARCHITECTURE.md §6.2 Punkt 3: "harte Vorbedingung" statt
// advisory) — wiederverwendet dieselben Alarm-Schwellwerte wie
// evaluateOnce, unabhängig vom zyklisch berechneten Advice-Cache (liest
// die Telemetrie live, damit ein Workflow-Start nicht auf den nächsten
// EvaluateInterval-Tick warten muss). Fehlende Telemetrie gilt als "ok"
// (fail-open) — dieselbe Haltung wie evaluateOnce bei nie gesehenen
// Hosts.
//
// Kapitel 14 Teil 4 (docs/END-GOAL-FEATURES.md §14.4 Teil 4): rechnet
// zusätzlich mit dem Verbrauchsprofil von nodeType — der aktuelle
// Momentwert allein sähe einen Host, der gerade z. B. bei 70% CPU
// liegt, fälschlich als "frei" an, obwohl der NEUE Node-Typ typisch
// weitere 20% braucht. Kein eigenes Profil für (nodeType, hostID)?
// Fällt auf das Typ-Fallback über alle Hosts zurück (profiles.
// GlobalHostID), genau wie httpapi.handleGetProfile. Kein Profil
// überhaupt bekannt (erster Start dieses Typs) oder e.profiles nil:
// fail-open wie bei fehlender Host-Telemetrie oben — ein unbekannter
// Bedarf ist kein Blocker, nur eine fehlende Datengrundlage (§14.3d:
// "nie ein stiller Block").
func (e *Engine) CheckHost(hostID, nodeType string) (string, bool) {
	m, ok := e.metrics.Get(hostID)
	if !ok {
		return "", true
	}
	memPercent := 0.0
	if m.MemTotalBytes > 0 {
		memPercent = float64(m.MemUsedBytes) / float64(m.MemTotalBytes) * 100
	}
	cpuPercent := m.CPUPercent

	if snap, ok := e.lookupProfile(nodeType, hostID); ok {
		cpuPercent += snap.CPUAvg
		if m.MemTotalBytes > 0 {
			memPercent += float64(snap.RSSAvg) / float64(m.MemTotalBytes) * 100
		}
	}

	overCPU := cpuPercent >= e.thresholds.CPUPercent
	overMem := memPercent >= e.thresholds.MemPercent
	switch {
	case overCPU && overMem:
		return fmt.Sprintf("CPU %.0f%% / RAM %.0f%% über dem Schwellwert (inkl. erwartetem Bedarf von %s)", cpuPercent, memPercent, nodeType), false
	case overCPU:
		return fmt.Sprintf("CPU %.0f%% über dem Schwellwert (inkl. erwartetem Bedarf von %s)", cpuPercent, nodeType), false
	case overMem:
		return fmt.Sprintf("RAM %.0f%% über dem Schwellwert (inkl. erwartetem Bedarf von %s)", memPercent, nodeType), false
	default:
		return "", true
	}
}

// lookupProfile holt das Profil für (nodeType, hostID), fällt auf das
// Typ-Fallback zurück, wenn keins host-spezifisches existiert — s.
// CheckHost-Doku. ok=false, wenn e.profiles nil ist oder überhaupt kein
// Profil (auch nicht das Fallback) existiert.
func (e *Engine) lookupProfile(nodeType, hostID string) (profiles.Snapshot, bool) {
	if e.profiles == nil {
		return profiles.Snapshot{}, false
	}
	if snap, ok, err := e.profiles.Get(context.Background(), nodeType, hostID); err == nil && ok {
		return snap, true
	}
	if snap, ok, err := e.profiles.Get(context.Background(), nodeType, profiles.GlobalHostID); err == nil && ok {
		return snap, true
	}
	return profiles.Snapshot{}, false
}

// scored bündelt einen Host mit seiner zuletzt gesehenen Telemetrie und
// der daraus abgeleiteten Speicherauslastung in Prozent.
type scored struct {
	host       hosts.Host
	m          hosts.Metrics
	memPercent float64
}

func (e *Engine) evaluateOnce() {
	allHosts, err := e.hostLister.ListHosts()
	if err != nil {
		slog.Warn("placement: list hosts failed", "error", err)
		return
	}

	// Referenz auf die vorherige Map einmal unter RLock einsammeln —
	// die Map selbst wird nach dem Anlegen nie mehr mutiert (jeder Lauf
	// baut eine frische `next`-Map), ein einzelner Read reicht deshalb,
	// kein Lock während der gesamten Auswertungsschleife nötig.
	e.mu.RLock()
	prev := e.advice
	e.mu.RUnlock()

	instancesByHost := map[string][]string{}
	for _, inst := range e.instances.List() {
		if inst.HostID == "" {
			continue // lokal beim Orchestrator gestartet, kein Migrationsziel-Kandidat.
		}
		instancesByHost[inst.HostID] = append(instancesByHost[inst.HostID], inst.ID)
	}

	var withMetrics []scored
	for _, h := range allHosts {
		m, ok := e.metrics.Get(h.ID)
		if !ok {
			continue // noch nie Telemetrie gesehen — weder Alarm noch Ausweichziel-Kandidat.
		}
		memPercent := 0.0
		if m.MemTotalBytes > 0 {
			memPercent = float64(m.MemUsedBytes) / float64(m.MemTotalBytes) * 100
		}
		withMetrics = append(withMetrics, scored{host: h, m: m, memPercent: memPercent})
	}

	next := map[string]Advice{}
	for _, s := range withMetrics {
		instanceIDs := instancesByHost[s.host.ID]
		if len(instanceIDs) == 0 {
			continue // überlasteter, aber leerer Host — kein Alarm ohne betroffene Instanzen.
		}

		overCPU := s.m.CPUPercent >= e.thresholds.CPUPercent
		overMem := s.memPercent >= e.thresholds.MemPercent
		if !overCPU && !overMem {
			continue
		}
		reason := "cpu"
		switch {
		case overCPU && overMem:
			reason = "cpu+mem"
		case overMem:
			reason = "mem"
		}

		detectedAt := time.Now()
		if prevAdvice, ok := prev[s.host.ID]; ok {
			// Alarm besteht bereits seit einem früheren Lauf fort —
			// ursprünglichen Zeitpunkt beibehalten, sonst würde jeder
			// Tick sowohl den Zeitstempel als auch (über
			// publishChanges/reflect.DeepEqual) ein neues SSE-Event
			// erzeugen, obwohl sich am Zustand nichts geändert hat.
			detectedAt = prevAdvice.DetectedAt
		}

		advice := Advice{
			HostID:      s.host.ID,
			HostLabel:   s.host.Label,
			Reason:      reason,
			CPUPercent:  s.m.CPUPercent,
			MemPercent:  s.memPercent,
			InstanceIDs: instanceIDs,
			DetectedAt:  detectedAt,
		}

		if target, ok := e.healthiestAlternative(withMetrics, s.host.ID); ok {
			advice.SuggestedHostID = target.host.ID
			advice.SuggestedHostLabel = target.host.Label
		}

		next[s.host.ID] = advice
	}

	e.mu.Lock()
	e.advice = next
	e.mu.Unlock()

	e.publishChanges(prev, next)
}

// healthiestAlternative sucht unter candidates (ausgenommen excludeID)
// den Host mit der niedrigsten CPU-Auslastung, der beide
// Healthy-Schwellwerte unterschreitet. Bei Gleichstand entscheidet die
// niedrigere Speicherauslastung, danach die HostID (deterministisch,
// kein Map-Iterations-Jitter im Testverhalten).
func (e *Engine) healthiestAlternative(candidates []scored, excludeID string) (scored, bool) {
	var best scored
	found := false
	for _, c := range candidates {
		if c.host.ID == excludeID {
			continue
		}
		if c.m.CPUPercent > e.thresholds.HealthyCPUPercent || c.memPercent > e.thresholds.HealthyMemPercent {
			continue
		}
		if !found ||
			c.m.CPUPercent < best.m.CPUPercent ||
			(c.m.CPUPercent == best.m.CPUPercent && c.memPercent < best.memPercent) ||
			(c.m.CPUPercent == best.m.CPUPercent && c.memPercent == best.memPercent && c.host.ID < best.host.ID) {
			best = c
			found = true
		}
	}
	return best, found
}

// publishChanges broadcastet ein "placement.advice"-Event pro Host,
// dessen Alarm-Stand sich seit dem letzten Lauf geändert hat (neu
// erschienen, verändert oder verschwunden — dann mit einem Advice, das
// nur HostID gesetzt hat und Reason == "cleared", damit UI-Clients ohne
// vollständigen Re-Poll wissen, welcher Alarm weg ist). Unveränderte
// Hosts erzeugen kein Event — kein SSE-Dauerfeuer bei stabiler Last.
func (e *Engine) publishChanges(prev, next map[string]Advice) {
	if e.events == nil {
		return
	}
	for hostID, a := range next {
		if old, ok := prev[hostID]; ok && reflect.DeepEqual(old, a) {
			continue
		}
		e.broadcastAdvice(a)
	}
	for hostID, old := range prev {
		if _, stillPresent := next[hostID]; stillPresent {
			continue
		}
		e.broadcastAdvice(Advice{HostID: hostID, HostLabel: old.HostLabel, Reason: "cleared"})
	}
}

func (e *Engine) broadcastAdvice(a Advice) {
	data, err := json.Marshal(a)
	if err != nil {
		slog.Warn("placement: failed to marshal advice for event", "error", err)
		return
	}
	e.events.Broadcast(sse.Event{Type: "placement.advice", Data: data})
}
