// Package profiles implementiert Kapitel 14 Teil 3
// (docs/END-GOAL-FEATURES.md §14.3c/§14.4): Verbrauchsprofile pro
// Node-Typ, aggregiert aus den seit Kapitel 14 Teil 2 vorhandenen
// Pro-Instanz-CPU%/RSS-Samples (internal/launcher.Instance.CPUPercent/
// RSSBytes für lokale Instanzen, hosts.Metrics.Instances für entfernte).
// Ziel: "das merkt sich der Orchestrator" — beim zweiten Start eines
// Node-Typs zeigt die UI eine profilbasierte Schätzung statt
// "unbekannt".
//
// Zwei Aggregations-Ebenen pro Snapshot: (nodeType, hostID) für
// host-spezifische Profile, dazu ein Typ-Fallback über alle Hosts
// hinweg unter dem reservierten Sentinel HostID = GlobalHostID — ein
// neuer Host ohne eigene Messhistorie erbt so trotzdem eine Schätzung
// (§14.3c), statt "unbekannt" zu bleiben, bis er selbst genug Samples
// gesammelt hat.
//
// Bewusst NICHT Teil dieser Runde: harte Start-Ablehnung (das bleibt
// D7-Teil-2-Scope, §6.2 Punkt 3 — dieses Paket liefert nur die
// Datengrundlage + Warnstufe), einstellbare Warnschwellen über die
// K11-Settings-Registry (§14.5 Frage 4 — feste Defaults aus
// placement.Thresholds wiederverwendet, gleiche
// Advisory-zuerst-Staffelung wie §6.1).
package profiles

import (
	"sort"
	"time"
)

// GlobalHostID ist der reservierte Sentinel für das Typ-Fallback-Profil
// über alle Hosts hinweg (s. Paketdoku). "" ist bereits durch die
// bestehende launcher.Instance.HostID-Konvention "lokal gestartete
// Instanz" belegt und bleibt deshalb ein eigener, echter Host-Eintrag.
const GlobalHostID = "*"

// Sample ist eine einzelne Pro-Instanz-Messung zu einem Zeitpunkt.
type Sample struct {
	Timestamp  time.Time
	CPUPercent float64
	RSSBytes   uint64
}

// Snapshot ist das aggregierte Profil für genau ein (nodeType, hostID)
// bzw. (nodeType, GlobalHostID) Paar — eine Zeile in node_type_profiles.
// CPU bekommt zusätzlich P95 (§14.3c: "cpu: min/avg/max/p95"), RSS nur
// min/avg/max (Speicherverbrauch ist deutlich weniger spitzenlastig als
// CPU bei den bisherigen Node-Typen, p95 dort kein Erkenntnisgewinn wert).
type Snapshot struct {
	NodeType    string
	HostID      string
	CPUMin      float64
	CPUAvg      float64
	CPUMax      float64
	CPUP95      float64
	RSSMin      uint64
	RSSAvg      uint64
	RSSMax      uint64
	SampleCount int
	UpdatedAt   time.Time
}

// computeSnapshot fasst samples (für genau ein (nodeType, hostID) Paar)
// zu einem Snapshot zusammen. p95 per "nearest rank"-Methode (kein
// Interpolations-Overhead nötig für advisory Schätzwerte).
func computeSnapshot(nodeType, hostID string, samples []Sample, now time.Time) Snapshot {
	snap := Snapshot{NodeType: nodeType, HostID: hostID, UpdatedAt: now, SampleCount: len(samples)}
	if len(samples) == 0 {
		return snap
	}

	cpus := make([]float64, len(samples))
	snap.CPUMin, snap.CPUMax = samples[0].CPUPercent, samples[0].CPUPercent
	snap.RSSMin, snap.RSSMax = samples[0].RSSBytes, samples[0].RSSBytes
	var cpuSum float64
	var rssSum uint64
	for i, s := range samples {
		cpus[i] = s.CPUPercent
		cpuSum += s.CPUPercent
		rssSum += s.RSSBytes
		if s.CPUPercent < snap.CPUMin {
			snap.CPUMin = s.CPUPercent
		}
		if s.CPUPercent > snap.CPUMax {
			snap.CPUMax = s.CPUPercent
		}
		if s.RSSBytes < snap.RSSMin {
			snap.RSSMin = s.RSSBytes
		}
		if s.RSSBytes > snap.RSSMax {
			snap.RSSMax = s.RSSBytes
		}
	}
	snap.CPUAvg = cpuSum / float64(len(samples))
	snap.RSSAvg = rssSum / uint64(len(samples))

	sort.Float64s(cpus)
	idx := int(0.95*float64(len(cpus))+0.999999) - 1 // nearest-rank, ceil(0.95*n)-1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(cpus) {
		idx = len(cpus) - 1
	}
	snap.CPUP95 = cpus[idx]

	return snap
}
