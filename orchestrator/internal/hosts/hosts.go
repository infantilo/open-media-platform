// Package hosts implementiert die Orchestrator-Seite der Remote-Host-
// Erkennung (ARCHITECTURE.md §18, UMSETZUNG.md D6 Teil 1): Admin-
// ausgestellte, einmalige Bootstrap-Tokens (§18.3), eine Host-Tabelle
// (§18.1) und ein In-Memory-Tracker für die per NATS gepushte Telemetrie
// (§18.4, "omp.host.<id>.metrics").
//
// Bewusst NICHT Teil dieser Runde (dokumentierte Scope-Grenze, s.
// docs/decisions.md D6 Teil 1): mTLS-Zertifikatsausstellung über step-ca
// für den Host-Agent (§18.3 Punkt 3 — der Bootstrap-Token selbst bleibt
// die Zugriffskontrolle, mTLS folgt später, gleicher opt-in-Zustand wie
// der Rest des Stacks vor/ohne D3 Teil 1), GPU-Telemetrie und
// I/O-Karten-Inventar (herstellerspezifisch, §18.4: "Eigenrecherche bei
// der D6-Umsetzung"), der Kommandokanal für Remote-Start/-Stop (§18.5)
// und die Placement-Engine (§6.1) — dieser Schritt macht Hosts nur
// sichtbar, noch nicht zu Platzierungszielen nutzbar. NIC-Telemetrie kam
// 2026-09-02 dazu (s. Metrics.Net) — GPU bleibt offen.
package hosts

import (
	"time"
)

// Host ist ein erfolgreich registrierter omp-host-agent.
type Host struct {
	ID           string
	Label        string
	Hostname     string
	Capabilities []byte // opakes JSON, s. db/migrations/0003_hosts.sql
	RegisteredAt time.Time
}

// Metrics ist die zuletzt über NATS empfangene Telemetrie eines Hosts —
// CPU/RAM seit D6 Teil 1, Netzwerk-Durchsatz/-Kapazität seit 2026-09-02
// (§6.1 Punkt 1 nennt außerdem GPU, weiterhin herstellerspezifische
// dokumentierte Folgearbeit).
type Metrics struct {
	CPUPercent    float64   `json:"cpuPercent"`
	MemUsedBytes  uint64    `json:"memUsedBytes"`
	MemTotalBytes uint64    `json:"memTotalBytes"`
	ReceivedAt    time.Time `json:"receivedAt"`
	// Instances ist die additive Pro-Instanz-Ergänzung des Host-Agent-
	// Payloads (Kapitel 14 Teil 2, docs/END-GOAL-FEATURES.md §14.3b) —
	// Tracker.Touch braucht dafür keine Änderung (json.Unmarshal befüllt
	// das Feld automatisch, sofern der Payload es enthält; ein älterer
	// Host-Agent ohne dieses Feld liefert einfach nil, kein Fehler).
	Instances []InstanceMetrics `json:"instances,omitempty"`
	// Net ist nil, wenn der Host-Agent kein Interface für die
	// Bandbreiten-Telemetrie konfiguriert hat (OMP_HOST_AGENT_NET_IFACE,
	// s. host-agent/main.go) — Spiegelbild von
	// host-agent/internal/telemetry.NetSample (gleiche bewusste kleine
	// Wire-Format-Duplikation wie InstanceMetrics/InstanceSample).
	Net *NetMetrics `json:"net,omitempty"`
}

// NetMetrics ist die zuletzt gemessene Netzwerk-Durchsatz-/Kapazitäts-
// Momentaufnahme des per Host-Agent konfigurierten Interfaces.
type NetMetrics struct {
	Iface         string  `json:"iface"`
	RxBytesPerSec float64 `json:"rxBytesPerSec"`
	TxBytesPerSec float64 `json:"txBytesPerSec"`
	// LinkMbps ist 0 (JSON-Feld dadurch weggelassen, omitempty), wenn der
	// Treiber die Verbindungsgeschwindigkeit nicht meldet — dann bleibt
	// nur der Rohdurchsatz oben aussagekräftig, kein Auslastungs-% (s.
	// placement.scoreHost, das diesen Fall überspringt statt zu raten).
	LinkMbps float64 `json:"linkMbps,omitempty"`
}

// InstanceMetrics ist die zuletzt gemessene CPU/RSS-Auslastung einer
// vom Host-Agent verwalteten Instanz — Spiegelbild von
// host-agent/internal/telemetry.InstanceSample (eigenständige Go-
// Module, gleiche bewusste kleine Duplikation wie beim übrigen
// Wire-Format dieses Projekts).
type InstanceMetrics struct {
	InstanceID string  `json:"instanceId"`
	CPUPercent float64 `json:"cpuPercent"`
	RSSBytes   uint64  `json:"rssBytes"`
}
