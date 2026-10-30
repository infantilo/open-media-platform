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
// der Rest des Stacks vor/ohne D3 Teil 1), I/O-Karten-Inventar
// (herstellerspezifisch, §18.4: "Eigenrecherche bei der D6-Umsetzung"),
// der Kommandokanal für Remote-Start/-Stop (§18.5) und die Placement-
// Engine (§6.1) — dieser Schritt macht Hosts nur sichtbar, noch nicht zu
// Platzierungszielen nutzbar. NIC-Telemetrie kam 2026-09-02 dazu (s.
// Metrics.Net), GPU-Telemetrie 2026-09-17 (s. Metrics.Gpu).
package hosts

import (
	"time"

	"github.com/infantilo/openmediaplatform/jobwire"
)

// Host ist ein erfolgreich registrierter omp-host-agent.
type Host struct {
	ID           string
	Label        string
	Hostname     string
	Capabilities []byte // opakes JSON, s. db/migrations/0003_hosts.sql
	RegisteredAt time.Time
	// MaintenanceSince ist gesetzt, solange der Host im Wartungsmodus ist.
	MaintenanceSince *time.Time
}

// Metrics ist die zuletzt über NATS empfangene Telemetrie eines Hosts —
// CPU/RAM seit D6 Teil 1, Netzwerk-Durchsatz/-Kapazität seit 2026-09-02,
// GPU-Auslastung/-Speicher seit 2026-09-17 (§6.1 Punkt 1 nannte GPU von
// Anfang an, herstellerspezifisch, s. Metrics.Gpu-Doku).
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
	// Gpu ist nil, wenn der Host-Agent keinen GPU-Index für die
	// Telemetrie konfiguriert hat (OMP_HOST_AGENT_GPU_INDEX) ODER
	// `nvidia-smi` dort nichts liefern konnte — Spiegelbild von
	// host-agent/internal/telemetry.GpuSample.
	Gpu *GpuMetrics `json:"gpu,omitempty"`
	// Sensors: Temperatur/Leistung; nil = nicht gemessen (VM, kein Sensor, keine Rechte).
	Sensors *SensorMetrics `json:"sensors,omitempty"`
	// Nics: physische Netzwerkkarten (Spiegel von host-agent telemetry.NicInfo); leer bei älterem Agent.
	Nics []NicMetrics `json:"nics,omitempty"`
	// Jobs: Fähigkeiten/Auslastung der Job-Ausführung (ffmpeg-Jobs, docs/ENTWURF-FFMPEG-HOSTWAHL.md); nil = auf dem
	// Host nicht freigegeben (keine tools.json).
	Jobs *JobsMetrics `json:"jobs,omitempty"`
	// Clock: Zustand der Systemuhr des Hosts (Spiegelbild von host-agent/internal/telemetry.ClockSample, Audit 2026-10-23 M1);
	// nil bei einem älteren Host-Agent.
	Clock *ClockMetrics `json:"clock,omitempty"`
	// Goodbye: der Host-Agent hat sich per SIGTERM/SIGINT absichtlich
	// abgemeldet (Spiegelbild von host-agent/internal/telemetry.Sample.
	// Goodbye). Ein danach ausbleibender Telemetrie-Strom ist kein Alarm;
	// ein Ausbleiben OHNE dieses Flag ist ein kritischer Alarm.
	Goodbye bool `json:"goodbye,omitempty"`
}

// JobsMetrics ist die Fähigkeitsmeldung der Job-Ausführung (gemeinsames Wire-Format, jobwire).
type JobsMetrics = jobwire.Info

// JobToolInfo: Version und Fähigkeiten eines freigegebenen Programms.
type JobToolInfo = jobwire.ToolInfo

// GpuMetrics ist die zuletzt gemessene Auslastungs-/Speicher-
// Momentaufnahme der per Host-Agent konfigurierten GPU.
// SensorMetrics: Temperatur und Leistungsaufnahme des Hosts (Spiegelbild von host-agent/internal/telemetry.SensorSample).
type SensorMetrics struct {
	TempC       *float64     `json:"tempC,omitempty"`
	Temps       []SensorTemp `json:"temps,omitempty"`
	PowerW      *float64     `json:"powerW,omitempty"`
	PowerSource string       `json:"powerSource,omitempty"`
}

type SensorTemp struct {
	Name    string  `json:"name"`
	Label   string  `json:"label,omitempty"`
	Celsius float64 `json:"celsius"`
}

type GpuMetrics struct {
	Index int `json:"index"` // -1 = alle GPUs des Hosts (Pool)
	// Count: Anzahl der gemessenen GPUs (Pool; 0 bei älteren Host-Agents,
	// dann gilt eine GPU). Auslastung ist der Mittelwert, Speicher die Summe.
	Count              int     `json:"count,omitempty"`
	UtilizationPercent float64 `json:"utilizationPercent"`
	MemUsedBytes       uint64  `json:"memUsedBytes"`
	MemTotalBytes      uint64  `json:"memTotalBytes"`
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
	// GpuPercent: GPU-Auslastung dieser Instanz in Prozent einer GPU; nil =
	// nicht gemessen (Host ohne konfigurierte GPU / nvidia-smi fehlt).
	GpuPercent *float64 `json:"gpuPercent,omitempty"`
	// GpuMemBytes: von dieser Instanz belegter VRAM; nil = nicht gemessen.
	GpuMemBytes *uint64 `json:"gpuMemBytes,omitempty"`
	// Outdated: Binary seit dem Prozessstart ersetzt (System-Update).
	Outdated bool `json:"outdated,omitempty"`
}

// ClockMetrics: Synchronisation und TAI-Versatz der Systemuhr eines Hosts.
type ClockMetrics struct {
	Synced     bool  `json:"synced"`
	MaxErrorUs int64 `json:"maxErrorUs"`
	EstErrorUs int64 `json:"estErrorUs"`
	TAIOffsetS int   `json:"taiOffsetS"`
	// Fix: was der Host selbst an der Uhr getan hat oder warum nicht ("tai-set", "stepped", "slewed", "no-permission", "no-server", "off").
	Fix string `json:"fix,omitempty"`
}

// Problem beschreibt, was an der Uhr nicht stimmt ("" = in Ordnung): MXL und Schaltzeitpunkte rechnen in TAI.
func (c *ClockMetrics) Problem() string {
	switch {
	case c == nil:
		return ""
	case !c.Synced && c.TAIOffsetS == 0:
		return "unsynced+tai"
	case !c.Synced:
		return "unsynced"
	case c.TAIOffsetS == 0:
		return "tai"
	}
	return ""
}
