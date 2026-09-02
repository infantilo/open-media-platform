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
// Geräte-Inventar), GPU-Telemetrie (§18.4: herstellerspezifisch),
// Cloud-Kostenfaktor (§6.1 Punkt 4). NIC-Bandbreite dagegen ist seit
// 2026-09-02 Teil der Bewertung (s. Thresholds.NetPercent,
// netUtilizationPercent) — dieselbe kontinuierlich-teilbare
// Ressourcenklasse wie CPU/RAM, keine diskret-exklusive wie ein
// I/O-Karten-Port. Das Kernpaket ist bewusst
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
	"strings"
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

// HostOnlineThreshold: ein Host gilt für SelectHost nur dann als
// erreichbar, wenn seine letzte Telemetrie höchstens so alt ist —
// derselbe Wert wie der Online-Punkt im Flow-Editor (ui/graph/
// flow-canvas.ts::HOST_ONLINE_THRESHOLD_MS), damit ein Host, den der
// Operator dort als "offline" (grauer Punkt) sieht, auch von der
// automatischen Platzierung gemieden wird — s. SelectHost-Doku zum
// Live-Fund 2026-08-14 ("Neue Gruppe"-Workflow-Start hing an einem seit
// Registrierung nie online gewesenen Host).
const HostOnlineThreshold = 15 * time.Second

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
// HealthyMemPercent/HealthyNetPercent liegen bewusst unter CPUPercent/
// MemPercent/NetPercent (mit Abstand dazwischen) — ein Kandidat, der
// selbst nur knapp unter der Alarmschwelle liegt, wäre kein sinnvoller
// Vorschlag.
//
// NetPercent/HealthyNetPercent (Nutzerauftrag 2026-09-02, "netzwerk-
// bandbreite ... auch relevant"): dieselbe Rolle wie CPUPercent, nur
// gegen die per Host-Agent gemessene NIC-Auslastung (s.
// hosts.NetMetrics) statt CPU-Zeit. Nur wirksam, wenn ein Host
// überhaupt ein Interface MIT bekannter Link-Geschwindigkeit meldet
// (s. scoreHost/netUtilizationPercent) — ein Host ohne diese Angabe
// bleibt für die Netz-Dimension fail-open, exakt wie fehlende Telemetrie
// insgesamt.
type Thresholds struct {
	CPUPercent        float64
	MemPercent        float64
	NetPercent        float64
	HealthyCPUPercent float64
	HealthyMemPercent float64
	HealthyNetPercent float64
}

// DefaultThresholds sind die Dev-Defaults (config.Load) — 85%/90% Alarm,
// 60%/70% "gilt als Ausweichziel geeignet". Großzügig genug, um auf
// einer Single-Host-Dev-Maschine mit fingierten Metriken beide Fälle
// (Alarm mit und ohne verfügbaren Ausweichhost) gezielt provozieren zu
// können. NetPercent/HealthyNetPercent spiegeln bewusst dieselben Zahlen
// wie CPUPercent/HealthyCPUPercent — keine belastbare eigene Empirie für
// einen abweichenden NIC-Schwellwert vorhanden, s. Thresholds-Doku;
// beide über OMP_PLACEMENT_NET_THRESHOLD/
// OMP_PLACEMENT_HEALTHY_NET_THRESHOLD justierbar (config.Load).
var DefaultThresholds = Thresholds{
	CPUPercent:        85,
	MemPercent:        90,
	NetPercent:        85,
	HealthyCPUPercent: 60,
	HealthyMemPercent: 70,
	HealthyNetPercent: 60,
}

// Advice ist der aktuelle Alarm+Vorschlag für genau einen überlasteten
// Host. SuggestedHostID ist leer, wenn kein Ausweichhost unter den
// Healthy-Schwellwerten gefunden wurde — ein ehrlicher Befund
// ("nicht migrierbar", §6.1 Punkt 3 der I/O-Karten-Erweiterung nennt
// dasselbe Prinzip für den Hardware-Fall), kein stiller Fallback auf
// irgendeinen Host.
type Advice struct {
	HostID     string  `json:"hostId"`
	HostLabel  string  `json:"hostLabel"`
	Reason     string  `json:"reason"` // "cpu", "mem", "net" oder eine "+"-verbundene Kombination
	CPUPercent float64 `json:"cpuPercent"`
	MemPercent float64 `json:"memPercent"`
	// NetPercent ist nil, wenn dieser Host keine NIC-Auslastung mit
	// bekannter Link-Kapazität meldet (s. netUtilizationPercent) — kein
	// stiller 0-Wert, der wie "gemessen und leer" aussähe.
	NetPercent         *float64  `json:"netPercent,omitempty"`
	InstanceIDs        []string  `json:"instanceIds"`
	SuggestedHostID    string    `json:"suggestedHostId,omitempty"`
	SuggestedHostLabel string    `json:"suggestedHostLabel,omitempty"`
	DetectedAt         time.Time `json:"detectedAt"`
}

// AdviceObserver wird informiert, wenn sich der Alarm-Stand EINES Hosts
// ändert (D6 Teil 4, ARCHITECTURE.md §6.1 Erweiterung 2026-07-13 Punkt
// 2) — implementiert von *workflows.Service, das daraus pro betroffener
// Instanz die zuständige Rolle auflöst und je nach
// Role.Placement.Escalation reagiert (advisory: nichts, s. dortige
// Doku). Bewusst dieselbe Granularität wie publishChanges/broadcastAdvice
// (ein Aufruf pro geändertem Host, kein Volltext-Diff nötig) — die
// Placement-Engine bleibt dadurch weiterhin vollständig
// workflow-unwissend, sie reicht nur ihren ohnehin schon berechneten
// Alarm-Stand durch (gleiches Entkopplungsmuster wie EventPublisher).
type AdviceObserver interface {
	// OnAdviceRaised wird für jeden Host aufgerufen, dessen Alarm neu
	// erschienen oder verändert ist (inkl. jedes Ticks mit leicht
	// geänderten Live-Metriken, s. evaluateOnce — der Aufrufer muss
	// selbst idempotent sein, nicht die Engine).
	OnAdviceRaised(Advice)
	// OnAdviceCleared wird aufgerufen, sobald ein zuvor gemeldeter Alarm
	// für hostID verschwunden ist (Host wieder unter dem Schwellwert
	// oder keine betroffenen Instanzen mehr) — der Aufrufer nutzt das,
	// um einen noch laufenden auto-confirm-window-Timer für diesen Host
	// zu verwerfen (die Überlast, die ihn ausgelöst hat, besteht nicht
	// mehr).
	OnAdviceCleared(hostID string)
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
	adviceObs  AdviceObserver

	mu     sync.RWMutex
	advice map[string]Advice // hostID -> aktueller Alarm
}

// SetAdviceObserver verdrahtet den Eskalations-Beobachter nach dem
// Konstruieren (main.go: workflows.Service existiert nicht vor der
// Placement-Engine, gleiches Nachträglich-Verdrahtungsmuster wie
// launcher.SetRestartObserver/workflows.Service.SetHostMetrics). Nicht
// nebenläufigkeitsgeschützt — vor dem ersten Run()-Tick verdrahten, wie
// die übrigen main.go-Verkabelungen auch.
func (e *Engine) SetAdviceObserver(o AdviceObserver) {
	e.adviceObs = o
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
	s := e.scoreHost(hostID, nodeType, profiles.Snapshot{})
	return s.reason, s.ok
}

// scored ist das Ergebnis einer Ressourcen-Bewertung für GENAU einen
// Host (Nachtrag 99, extrahiert aus der vormals monolithischen
// CheckHost-Logik, damit SelectHost dieselbe Bewertung pro
// Kandidatenhost wiederverwenden kann statt sie zu duplizieren).
type hostScore struct {
	cpuPercent float64
	memPercent float64
	// netPercent s. netUtilizationPercent-Doku: nil, wenn für diesen Host
	// keine NIC-Auslastung mit bekannter Link-Kapazität vorliegt.
	netPercent *float64
	hasMetrics bool
	ok         bool
	reason     string
}

// netUtilizationPercent berechnet die NIC-Auslastung aus m.Net in
// Prozent der gemeldeten Link-Kapazität — nil, wenn der Host-Agent kein
// Interface konfiguriert hat ODER der Treiber dessen
// Verbindungsgeschwindigkeit nicht meldet (s. hosts.NetMetrics.LinkMbps-
// Doku). Kein Rateversuch in diesem Fall (§14.3d-Prinzip "nie raten",
// hier auf Bandbreite übertragen) — der Aufrufer behandelt nil als
// fail-open für die Netz-Dimension, exakt wie fehlende Host-Telemetrie
// insgesamt anderswo in diesem Paket.
func netUtilizationPercent(m hosts.Metrics) *float64 {
	if m.Net == nil || m.Net.LinkMbps <= 0 {
		return nil
	}
	usedMbps := (m.Net.RxBytesPerSec + m.Net.TxBytesPerSec) * 8 / 1_000_000
	p := usedMbps / m.Net.LinkMbps * 100
	return &p
}

// hostOnline meldet, ob hostID innerhalb von HostOnlineThreshold
// Telemetrie geschickt hat — SelectHost nutzt das als harten
// Erreichbarkeits-Filter VOR scoreHost (s. dortige Live-Fund-Doku),
// unabhängig von dessen bewusst fail-open gehaltener Ressourcen-
// Bewertung. Kein eigenständiger CheckHost-Gate: CheckHost bleibt die
// reine Ressourcen-Vorprüfung für einen vom Nutzer/Katalog explizit
// gewählten Host (§14.3d, "nie ein stiller Block") — dort bewusst
// unverändert.
func (e *Engine) hostOnline(hostID string) bool {
	m, ok := e.metrics.Get(hostID)
	if !ok {
		return false
	}
	return time.Since(m.ReceivedAt) < HostOnlineThreshold
}

// scoreHost bewertet hostID für nodeType wie CheckHost, plus optional
// extraLoad (Nachtrag 99: Scheduler-Forecast-Zusatzlast anderer, bald
// fällig werdender Workflows, s. workflows.Service) — additiv auf
// dieselbe Weise wie das Node-Typ-Profil projiziert. Fehlende Telemetrie
// bleibt fail-open (hasMetrics=false, ok=true) — für CheckHost (reine
// Ressourcen-Vorprüfung eines bereits feststehenden Hosts) unverändert
// die richtige Haltung; SelectHost filtert nicht erreichbare Hosts
// bereits vorher über hostOnline() aus, bevor es hier überhaupt
// ankommt (s. dortige Doku).
func (e *Engine) scoreHost(hostID, nodeType string, extraLoad profiles.Snapshot) hostScore {
	m, hasMetrics := e.metrics.Get(hostID)
	if !hasMetrics {
		return hostScore{ok: true}
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
	if extraLoad.CPUAvg > 0 || extraLoad.RSSAvg > 0 {
		cpuPercent += extraLoad.CPUAvg
		if m.MemTotalBytes > 0 {
			memPercent += float64(extraLoad.RSSAvg) / float64(m.MemTotalBytes) * 100
		}
	}
	// Kein Profil-/ExtraLoad-Zuschlag für Netz wie bei CPU/RAM oben: es
	// gibt noch keine gemessene Pro-Node-Typ-Bandbreitenschätzung
	// (dokumentierte Folgearbeit, gleiche Grenze wie der
	// ExpectedResources-Freitext im Node-Katalog).
	netPercent := netUtilizationPercent(m)

	type overage struct {
		over  bool
		label string
		value float64
	}
	overages := []overage{
		{cpuPercent >= e.thresholds.CPUPercent, "CPU", cpuPercent},
		{memPercent >= e.thresholds.MemPercent, "RAM", memPercent},
	}
	if netPercent != nil {
		overages = append(overages, overage{*netPercent >= e.thresholds.NetPercent, "Netz", *netPercent})
	}
	var over []string
	for _, o := range overages {
		if o.over {
			over = append(over, fmt.Sprintf("%s %.0f%%", o.label, o.value))
		}
	}
	if len(over) == 0 {
		return hostScore{cpuPercent, memPercent, netPercent, true, true, ""}
	}
	return hostScore{cpuPercent, memPercent, netPercent, true, false,
		fmt.Sprintf("%s über dem Schwellwert (inkl. erwartetem Bedarf von %s)", strings.Join(over, " / "), nodeType)}
}

// PlacementRequest beschreibt eine einzelne, noch zu platzierende Rolle
// (Nachtrag 99, ARCHITECTURE.md §6.1/§16-Erweiterung) — Eingabe für
// SelectHost.
type PlacementRequest struct {
	NodeType        string
	PreferredHostID string // workflows.Role.HostID — darf leer sein (keine Präferenz)
	AffinityGroup   string
	RedundancyGroup string
}

// Occupancy fasst zusammen, welche Affinitäts-/Redundanz-Tags auf
// welchen Hosts JETZT oder demnächst (laut Scheduler-Forecast) präsent
// sind, sowie eine optionale Zusatzlast je Host — vom Aufrufer
// (workflows.Service) gebaut, damit placement KEINE Abhängigkeit auf
// workflows braucht (Abhängigkeitsrichtung bleibt unverändert:
// workflows importiert placement, nicht umgekehrt).
type Occupancy struct {
	AffinityGroupHosts   map[string][]string
	RedundancyGroupHosts map[string][]string
	ExtraLoad            map[string]profiles.Snapshot
}

// PlacementResult ist das Ergebnis von SelectHost. HostID="" bedeutet
// lokal (beim Orchestrator selbst, wie schon immer bei leerem
// workflows.Role.HostID).
type PlacementResult struct {
	HostID string
	Reason string
}

// netPercentOrZero behandelt eine unbekannte Netz-Auslastung als 0 für
// Tie-Break-Vergleiche (pick()/healthiestAlternative) — bestraft einen
// Host ohne Bandbreiten-Telemetrie dadurch NICHT gegenüber einem Host
// mit gemessener, aber niedriger Auslastung, gleiche fail-open-Haltung
// wie beim übrigen Metriken-Handling in diesem Paket.
func netPercentOrZero(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// SelectHost wählt den Zielhost für EINE Rolle eines Workflow-Starts
// (Nachtrag 99 — löst die vormals harte checkResources-Vorbedingung ab,
// s. workflows.Service.runStart): anders als CheckHost (ein Host, ein
// Pass/Fail) sucht SelectHost unter ALLEN registrierten Hosts plus
// "lokal" den besten — der Start soll laut Vorgabe IMMER gelingen, nur
// eben ggf. anderswo als ursprünglich in der Definition eingetragen.
//
// Ablauf: (1) Kandidaten = alle Hosts + lokal, zuerst auf ERREICHBARKEIT
// gefiltert (s. hostOnline/HostOnlineThreshold — ein Host, der noch nie
// oder seit über 15s keine Telemetrie mehr geschickt hat, fliegt hier
// ganz raus, unabhängig von scoreHost), danach nach Ressourcen
// (scoreHost inkl. occ.ExtraLoad) — unter den verbliebenen ERREICHBAREN
// Hosts bleibt fehlende Lastauskunft weiterhin fail-open (kann bei
// gerade eben verbundenen Hosts kurz vorkommen, s. scoreHost-Doku).
// (2) Redundanz: Hosts ausschließen, auf denen laut
// occ.RedundancyGroupHosts[req.RedundancyGroup] bereits derselbe Tag
// sitzt — außer das ließe keinen Kandidaten übrig, dann Ausschluss
// fallen lassen (Start muss gelingen). (3) Affinität: unter den
// verbleibenden Hosts bevorzugen, wer laut
// occ.AffinityGroupHosts[req.AffinityGroup] den Tag schon trägt.
// (4) Unter Gleichstand: req.PreferredHostID, falls noch Kandidat, sonst
// der am wenigsten ausgelastete (Telemetrie-Hosts vor telemetrielosen).
// Lokal bleibt der Anker: nur automatisch gewählt, wenn PreferredHostID
// leer ist UND kein Remote-Host besser/registriert/ERREICHBAR ist —
// bestehendes Ein-Host-Dev-Verhalten bleibt dadurch unverändert.
//
// Live-Fund 2026-08-14 ("Neue Gruppe"-Workflow-Start hing minutenlang an
// „launcher: remote start on host …: nats: timeout"): vor diesem Fix
// zählte ein Host OHNE jemals empfangene Telemetrie (nie online
// gewesener/verwaister Registry-Eintrag) als "fail-open"-Kandidat GENAU
// WIE ein Host mit Telemetrie, aber niedriger Last — SelectHost konnte
// ihn also bevorzugt wählen (erster Kandidat ohne Metrik-Gegenkandidaten
// gewinnt, s. pick()), obwohl ein Start dort GARANTIERT scheitert (kein
// Host-Agent, der den NATS-Remote-Start beantwortet). Das widerspricht
// dem eigentlichen Zweck dieser Funktion ("der Start soll IMMER
// gelingen") — Ressourcen-Unbekanntheit (§14.3d: "nie ein stiller
// Block") und Erreichbarkeits-Unbekanntheit sind unterschiedliche Fragen;
// nur Erstere bleibt hier weiterhin bewusst fail-open.
//
// Bewusste Scope-Grenze (Nachtrag 99, kein stiller Gap): lokale
// Host-eigene CPU/RAM-Last fließt NICHT ein (der Orchestrator misst
// sich selbst nicht) — lokal bleibt wie bisher unconstrained.
func (e *Engine) SelectHost(req PlacementRequest, occ Occupancy) PlacementResult {
	allHosts, err := e.hostLister.ListHosts()
	if err != nil {
		slog.Warn("placement: SelectHost: list hosts failed, falling back to local", "error", err)
		return PlacementResult{HostID: "", Reason: "Host-Liste nicht verfügbar, lokal gestartet"}
	}

	type candidate struct {
		hostID     string
		score      hostScore
		affinity   bool
		redundancy bool
	}

	var candidates []candidate
	for _, h := range allHosts {
		if !e.hostOnline(h.ID) {
			continue
		}
		s := e.scoreHost(h.ID, req.NodeType, occ.ExtraLoad[h.ID])
		if !s.ok {
			continue
		}
		candidates = append(candidates, candidate{
			hostID:     h.ID,
			score:      s,
			affinity:   req.AffinityGroup != "" && containsString(occ.AffinityGroupHosts[req.AffinityGroup], h.ID),
			redundancy: req.RedundancyGroup != "" && containsString(occ.RedundancyGroupHosts[req.RedundancyGroup], h.ID),
		})
	}

	pick := func(pool []candidate, reasonSuffix string) (PlacementResult, bool) {
		if len(pool) == 0 {
			return PlacementResult{}, false
		}
		// Präferenz gewinnt, falls noch im Pool.
		if req.PreferredHostID != "" {
			for _, c := range pool {
				if c.hostID == req.PreferredHostID {
					return PlacementResult{HostID: c.hostID, Reason: "bevorzugter Host verfügbar" + reasonSuffix}, true
				}
			}
		}
		// Affinität bevorzugen.
		var affinityPool []candidate
		for _, c := range pool {
			if c.affinity {
				affinityPool = append(affinityPool, c)
			}
		}
		if len(affinityPool) > 0 {
			pool = affinityPool
			reasonSuffix += fmt.Sprintf(" (Affinitäts-Gruppe %q bereits auf diesem Host)", req.AffinityGroup)
		}
		best := pool[0]
		for _, c := range pool[1:] {
			if c.score.hasMetrics && (!best.score.hasMetrics || c.score.cpuPercent < best.score.cpuPercent ||
				(c.score.cpuPercent == best.score.cpuPercent && c.score.memPercent < best.score.memPercent) ||
				(c.score.cpuPercent == best.score.cpuPercent && c.score.memPercent == best.score.memPercent &&
					netPercentOrZero(c.score.netPercent) < netPercentOrZero(best.score.netPercent))) {
				best = c
			}
		}
		return PlacementResult{HostID: best.hostID, Reason: strings.TrimSpace("Ausweichhost gewählt" + reasonSuffix)}, true
	}

	// Redundanz zuerst versuchen zu respektieren (Hosts mit demselben
	// Redundanz-Tag ausschließen); nur falls das nichts übrig lässt,
	// den Ausschluss fallen lassen — der Start muss laut Vorgabe immer
	// gelingen.
	var withoutRedundancyConflict []candidate
	for _, c := range candidates {
		if !c.redundancy {
			withoutRedundancyConflict = append(withoutRedundancyConflict, c)
		}
	}
	if result, ok := pick(withoutRedundancyConflict, ""); ok {
		return result
	}
	if result, ok := pick(candidates, ""); ok {
		if req.RedundancyGroup != "" {
			result.Reason = fmt.Sprintf("%s (Redundanz-Gruppe %q hatte auf keinem Kandidaten Platz, Konflikt in Kauf genommen)", result.Reason, req.RedundancyGroup)
		}
		return result
	}

	// Kein Remote-Host registriert/ok — lokal ist der Anker, der immer
	// funktioniert (bestehendes Ein-Host-Dev-Verhalten).
	return PlacementResult{HostID: "", Reason: "kein passender Remote-Host, lokal gestartet"}
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

// ProjectedLoad liefert das erwartete Verbrauchsprofil von nodeType auf
// hostID (host-spezifisch oder Typ-Fallback, s. lookupProfile) —
// öffentlich gemacht, damit workflows.Service beim Bau des Scheduler-
// Forecasts (Nachtrag 99: die Zusatzlast bald fälliger Starts ANDERER
// Workflows) dieselbe Profil-Logik nutzen kann, ohne selbst eine
// profiles.Store-Abhängigkeit zu brauchen. Leeres Snapshot{}, wenn
// nichts bekannt ist (kein Fehlerfall, wie überall in diesem Paket).
func (e *Engine) ProjectedLoad(nodeType, hostID string) profiles.Snapshot {
	snap, ok := e.lookupProfile(nodeType, hostID)
	if !ok {
		return profiles.Snapshot{}
	}
	return snap
}

// scored bündelt einen Host mit seiner zuletzt gesehenen Telemetrie und
// der daraus abgeleiteten Speicher-/Netz-Auslastung in Prozent.
type scored struct {
	host       hosts.Host
	m          hosts.Metrics
	memPercent float64
	// netPercent s. netUtilizationPercent-Doku.
	netPercent *float64
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
		withMetrics = append(withMetrics, scored{host: h, m: m, memPercent: memPercent, netPercent: netUtilizationPercent(m)})
	}

	next := map[string]Advice{}
	for _, s := range withMetrics {
		instanceIDs := instancesByHost[s.host.ID]
		if len(instanceIDs) == 0 {
			continue // überlasteter, aber leerer Host — kein Alarm ohne betroffene Instanzen.
		}

		overCPU := s.m.CPUPercent >= e.thresholds.CPUPercent
		overMem := s.memPercent >= e.thresholds.MemPercent
		overNet := s.netPercent != nil && *s.netPercent >= e.thresholds.NetPercent
		if !overCPU && !overMem && !overNet {
			continue
		}
		var reasonParts []string
		if overCPU {
			reasonParts = append(reasonParts, "cpu")
		}
		if overMem {
			reasonParts = append(reasonParts, "mem")
		}
		if overNet {
			reasonParts = append(reasonParts, "net")
		}
		reason := strings.Join(reasonParts, "+")

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
			NetPercent:  s.netPercent,
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
		if c.netPercent != nil && *c.netPercent > e.thresholds.HealthyNetPercent {
			continue
		}
		if !found ||
			c.m.CPUPercent < best.m.CPUPercent ||
			(c.m.CPUPercent == best.m.CPUPercent && c.memPercent < best.memPercent) ||
			(c.m.CPUPercent == best.m.CPUPercent && c.memPercent == best.memPercent &&
				netPercentOrZero(c.netPercent) < netPercentOrZero(best.netPercent)) ||
			(c.m.CPUPercent == best.m.CPUPercent && c.memPercent == best.memPercent &&
				netPercentOrZero(c.netPercent) == netPercentOrZero(best.netPercent) && c.host.ID < best.host.ID) {
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
// Ruft zusätzlich (unabhängig von e.events, s. u.) den D6-Teil-4-
// AdviceObserver für dieselben Host-Änderungen auf — dieselbe
// "geändert seit letztem Lauf"-Granularität, kein zweiter,
// abweichender Diff nötig.
func (e *Engine) publishChanges(prev, next map[string]Advice) {
	for hostID, a := range next {
		if old, ok := prev[hostID]; ok && reflect.DeepEqual(old, a) {
			continue
		}
		e.broadcastAdvice(a)
		if e.adviceObs != nil {
			e.adviceObs.OnAdviceRaised(a)
		}
	}
	for hostID, old := range prev {
		if _, stillPresent := next[hostID]; stillPresent {
			continue
		}
		e.broadcastAdvice(Advice{HostID: hostID, HostLabel: old.HostLabel, Reason: "cleared"})
		if e.adviceObs != nil {
			e.adviceObs.OnAdviceCleared(hostID)
		}
	}
}

func (e *Engine) broadcastAdvice(a Advice) {
	if e.events == nil {
		return
	}
	data, err := json.Marshal(a)
	if err != nil {
		slog.Warn("placement: failed to marshal advice for event", "error", err)
		return
	}
	e.events.Broadcast(sse.Event{Type: "placement.advice", Data: data})
}
