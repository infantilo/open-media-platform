package mcr

import (
	"context"
	"fmt"
	"sort"
)

// Vorprüfung der Kapazität (106.x): reicht die freie Rechenleistung der Hosts für alle Rollen des Events? Die Platzierung
// verteilt die Rollen selbst; hier wird nur summiert und gegen die Summe der Hosts gehalten. Das Ergebnis ist eine Warnung,
// kein Verbot — Telemetrie und Profile sind Schätzungen.

// Schwellen wie die der Platzierung (DefaultThresholds): oberhalb gilt ein Host als überlastet.
const (
	capCPUPercent = 85.0
	capMemPercent = 90.0
)

// HostCap ist die Kapazität eines Hosts zum Zeitpunkt der Prüfung.
type HostCap struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	Cores      float64 `json:"cores"`
	CPUPercent float64 `json:"cpuPercent"`
	MemTotal   uint64  `json:"memTotalBytes"`
	MemPercent float64 `json:"memPercent"`
}

// FreeCores: Kerne bis zur Überlastschwelle.
func (h HostCap) FreeCores() float64 {
	f := h.Cores * (capCPUPercent - h.CPUPercent) / 100
	if f < 0 {
		return 0
	}
	return f
}

// FreeMem: Speicher bis zur Überlastschwelle.
func (h HostCap) FreeMem() uint64 {
	f := float64(h.MemTotal) * (capMemPercent - h.MemPercent) / 100
	if f < 0 {
		return 0
	}
	return uint64(f)
}

// Demand ist der erwartete Bedarf eines Node-Typs (je Instanz).
type Demand struct {
	Cores     float64 `json:"cores"`
	RSSBytes  uint64  `json:"rssBytes"`
	Estimated bool    `json:"estimated"` // true = Richtwert statt gemessenem Profil
}

// CapacitySource liefert Hosts und Profile (im Orchestrator: Host-Verzeichnis, Telemetrie, Profil-Store).
type CapacitySource interface {
	Hosts(ctx context.Context) []HostCap
	// Profile: gemessener Bedarf (p95 CPU, größter RSS) eines Node-Typs; ok=false = noch nicht gemessen.
	Profile(ctx context.Context, nodeType string) (cores float64, rss uint64, ok bool)
}

// Richtwerte je Node-Typ, solange kein Profil gemessen ist (Kerne, RSS). Der Relay von omp-contribution maß 4–9 % eines Kerns.
var defaultDemand = map[string]Demand{
	NodeContribIn:   {Cores: 0.15, RSSBytes: 150 << 20, Estimated: true},
	NodeContribOut:  {Cores: 0.15, RSSBytes: 150 << 20, Estimated: true},
	NodeGateway2110: {Cores: 0.40, RSSBytes: 300 << 20, Estimated: true},
	NodeHLS:         {Cores: 0.30, RSSBytes: 250 << 20, Estimated: true},
	NodeNormalizer:  {Cores: 0.30, RSSBytes: 250 << 20, Estimated: true},
}

const fallbackDemand = 0.20

// CapacityItem: Bedarf einer Rollenart im Event.
type CapacityItem struct {
	NodeType  string  `json:"nodeType"`
	Count     int     `json:"count"`
	Cores     float64 `json:"cores"`
	RSSBytes  uint64  `json:"rssBytes"`
	Estimated bool    `json:"estimated"`
}

// CapacityReport ist das Ergebnis der Vorprüfung.
type CapacityReport struct {
	OK        bool           `json:"ok"`
	Items     []CapacityItem `json:"items"`
	NeedCores float64        `json:"needCores"`
	FreeCores float64        `json:"freeCores"`
	NeedMem   uint64         `json:"needMemBytes"`
	FreeMem   uint64         `json:"freeMemBytes"`
	Hosts     []HostCap      `json:"hosts"`
	Warnings  []string       `json:"warnings"`
}

// Precheck summiert den Bedarf aller Rollen des Events und hält ihn gegen die freie Leistung aller erreichbaren Hosts.
func Precheck(ctx context.Context, e Event, global *HouseFormat, src CapacitySource, chain ...ChainConfig) (CapacityReport, error) {
	rep := CapacityReport{OK: true, Items: []CapacityItem{}, Hosts: []HostCap{}, Warnings: []string{}}
	def, _, _, err := Materialize(e, global, "", chain...)
	if err != nil {
		return rep, err
	}
	count := map[string]int{}
	for _, r := range def.Roles {
		count[r.NodeType]++
	}
	types := make([]string, 0, len(count))
	for k := range count {
		types = append(types, k)
	}
	sort.Strings(types)
	for _, nt := range types {
		d, ok := defaultDemand[nt]
		if !ok {
			d = Demand{Cores: fallbackDemand, RSSBytes: 200 << 20, Estimated: true}
		}
		if c, rss, ok := src.Profile(ctx, nt); ok && c > 0 {
			d = Demand{Cores: c, RSSBytes: rss}
		}
		n := count[nt]
		it := CapacityItem{NodeType: nt, Count: n, Cores: d.Cores * float64(n), RSSBytes: d.RSSBytes * uint64(n), Estimated: d.Estimated}
		rep.Items = append(rep.Items, it)
		rep.NeedCores += it.Cores
		rep.NeedMem += it.RSSBytes
	}
	hosts := src.Hosts(ctx)
	rep.Hosts = append(rep.Hosts, hosts...)
	for _, h := range hosts {
		rep.FreeCores += h.FreeCores()
		rep.FreeMem += h.FreeMem()
	}
	switch {
	case len(hosts) == 0:
		rep.Warnings = append(rep.Warnings, "Kein Host mit bekannter Kapazität erreichbar — die Vorprüfung kann nichts belegen.")
	default:
		if rep.NeedCores > rep.FreeCores {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("Rechenleistung: erwartet %.1f Kerne, frei bis zur Überlastschwelle (%.0f %%) %.1f Kerne.", rep.NeedCores, capCPUPercent, rep.FreeCores))
		}
		if rep.FreeMem > 0 && rep.NeedMem > rep.FreeMem {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("Arbeitsspeicher: erwartet %d MB, frei bis zur Überlastschwelle (%.0f %%) %d MB.", rep.NeedMem>>20, capMemPercent, rep.FreeMem>>20))
		}
	}
	for _, it := range rep.Items {
		if it.Estimated {
			rep.Warnings = append(rep.Warnings, "Hinweis: für mindestens einen Node-Typ liegt noch kein gemessenes Profil vor, die Vorprüfung nutzt Richtwerte.")
			break
		}
	}
	rep.OK = !(rep.NeedCores > rep.FreeCores && len(hosts) > 0) && !(rep.FreeMem > 0 && rep.NeedMem > rep.FreeMem)
	return rep, nil
}
