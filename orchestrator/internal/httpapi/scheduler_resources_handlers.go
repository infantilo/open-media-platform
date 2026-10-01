package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// Ressourcenmodell für den Scheduler (Nutzerwunsch 2026-09-30: "wissen um
// verfügbare Ressourcen ist extrem wichtig"). Der Endpunkt liefert nur das
// MODELL — Host-Kapazitäten, gemessene Profile je Node-Typ, I/O-Ports und
// je Workflow, welche Rolle wie viel braucht. Die Zeitachse (welcher
// Workflow wann läuft) rechnet der Scheduler-View selbst aus den
// Zeitplänen, weil er sie beim Ziehen ohnehin live ändert und die
// Auswirkung sofort zeigen muss.
//
// Einheiten: CPU als Anzahl beanspruchter Kerne (Prozess-CPU-% der
// Host-Agents ist pro Kern gemessen: 100 % = ein Kern), Speicher in Bytes,
// I/O-Ports als Anzahl je (Kartentyp, Richtung). Geplant wird konservativ
// mit dem 95. Perzentil (CPU) bzw. dem Maximum (RSS) der Messhistorie.

// CatalogReader liefert den Node-Katalog (Netz-Deklaration je Typ) und die
// laufenden Instanzen (manuell gestartete zählen als Dauerlast);
// *launcher.Launcher erfüllt es.
type CatalogReader interface {
	Catalog() []launcher.CatalogEntry
	List() []launcher.Instance
}

type schedResHost struct {
	ID       string            `json:"id"`
	Label    string            `json:"label"`
	Local    bool              `json:"local,omitempty"`
	Online   bool              `json:"online"`
	NumCPU   int               `json:"numCpu"`
	MemTotal uint64            `json:"memTotalBytes"`
	Live     *schedResHostLive `json:"live,omitempty"`
	IOPorts  []schedResIOCap   `json:"ioPorts,omitempty"`
	CapKnown bool              `json:"capacityKnown"`
	// NetLinkMbps: vom Host-Agent gemeldete Link-Geschwindigkeit der
	// konfigurierten NIC (je Richtung, vollduplex). Fehlt, wenn keine NIC
	// konfiguriert ist oder der Treiber sie nicht meldet.
	NetLinkMbps float64 `json:"netLinkMbps,omitempty"`
	// GPUKnown: der Host-Agent meldet eine GPU (OMP_HOST_AGENT_GPU_INDEX
	// gesetzt, nvidia-smi erreichbar). Kapazität = eine GPU = 100 %.
	GPUKnown    bool    `json:"gpuKnown,omitempty"`
	LastSeenAge float64 `json:"lastSeenSeconds,omitempty"`
}

type schedResHostLive struct {
	CPUPercent float64  `json:"cpuPercent"`
	MemPercent float64  `json:"memPercent"`
	NetPercent *float64 `json:"netPercent,omitempty"`
	// Gemessener Durchsatz der konfigurierten NIC in Mbit/s (Momentaufnahme).
	NetRxMbps  float64  `json:"netRxMbps,omitempty"`
	NetTxMbps  float64  `json:"netTxMbps,omitempty"`
	GpuPercent *float64 `json:"gpuPercent,omitempty"`
}

type schedResIOCap struct {
	CardType  string `json:"cardType"`
	Direction string `json:"direction"`
	Total     int    `json:"total"`
	Claimed   int    `json:"claimed"`
}

type schedResRole struct {
	Name     string   `json:"name"`
	NodeType string   `json:"nodeType"`
	HostID   string   `json:"hostId,omitempty"` // leer = Auto-Platzierung
	CPUCores float64  `json:"cpuCores"`         // p95, in Kernen
	CPUAvg   float64  `json:"cpuAvgCores"`
	RSSBytes uint64   `json:"rssBytes"`
	Known    bool     `json:"known"` // false: kein Messprofil → Bedarf unbekannt
	Fallback bool     `json:"fallback,omitempty"`
	IOPort   *schedIO `json:"ioPort,omitempty"`
	// Netzbedarf in Mbit/s (berechnet, s. scheduler_network.go); Rx/Tx
	// aus Sicht des Hosts. NetEstimated: Format/Nennwert angenommen.
	NetRxMbps    float64 `json:"netRxMbps,omitempty"`
	NetTxMbps    float64 `json:"netTxMbps,omitempty"`
	NetEstimated bool    `json:"netEstimated,omitempty"`
	// GPU-Bedarf in Prozent einer GPU (p95 des Profils); GPUKnown=false:
	// nie gemessen — dann fehlt der Wert in der Planung, ohne den Slot als
	// unvollständig zu markieren (auf Hosts ohne GPU-Messung wäre sonst
	// jede Rolle "unbekannt").
	GPUPercent float64 `json:"gpuPercent,omitempty"`
	GPUKnown   bool    `json:"gpuKnown,omitempty"`
}

type schedIO struct {
	CardType  string `json:"cardType"`
	Direction string `json:"direction"`
}

type schedResWorkflow struct {
	ID     string         `json:"id"`
	Name   string         `json:"name"`
	Status string         `json:"status"`
	Roles  []schedResRole `json:"roles"`
}

type schedResResponse struct {
	GeneratedAt time.Time          `json:"generatedAt"`
	Thresholds  map[string]float64 `json:"thresholds"`
	Hosts       []schedResHost     `json:"hosts"`
	Workflows   []schedResWorkflow `json:"workflows"`
	// ManualInstances: laufende Instanzen, die zu keinem Workflow gehören
	// (von Hand gestartet). Sie laufen, bis jemand sie stoppt — der
	// Scheduler plant sie deshalb als Dauerlast in jeden Zeit-Slot.
	ManualInstances []schedResManual `json:"manualInstances"`
}

type schedResManual struct {
	ID       string  `json:"id"`
	Label    string  `json:"label"`
	NodeType string  `json:"nodeType"`
	HostID   string  `json:"hostId,omitempty"`
	CPUCores float64 `json:"cpuCores"`
	RSSBytes uint64  `json:"rssBytes"`
	// Known: CPU/RAM stammen aus Messung oder Profil; false = Bedarf unbekannt.
	Known bool `json:"known"`
	// Measured: aktuelle Messung der Instanz floss ein (nicht nur das Profil).
	Measured     bool    `json:"measured,omitempty"`
	NetRxMbps    float64 `json:"netRxMbps,omitempty"`
	NetTxMbps    float64 `json:"netTxMbps,omitempty"`
	NetEstimated bool    `json:"netEstimated,omitempty"`
	GPUPercent   float64 `json:"gpuPercent,omitempty"`
	GPUKnown     bool    `json:"gpuKnown,omitempty"`
}

// handleSchedulerResources: GET /api/v1/scheduler/resources.
func handleSchedulerResources(
	registry HostRegistry,
	metrics HostMetricsReader,
	ioPortStore IOPortInventoryStore,
	profileStore ProfileReader,
	workflowSvc WorkflowService,
	catalog CatalogReader,
	th placement.Thresholds,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp := schedResResponse{
			GeneratedAt: time.Now().UTC(),
			Thresholds:  map[string]float64{"cpu": th.CPUPercent, "mem": th.MemPercent, "net": th.NetPercent, "gpu": th.GpuPercent},
			Hosts:       []schedResHost{},
			Workflows:   []schedResWorkflow{},

			ManualInstances: []schedResManual{},
		}

		var ports []ioPortInfo
		var claims []ioClaimInfo
		if ioPortStore != nil {
			if ps, err := ioPortStore.ListAllPorts(); err == nil {
				for _, p := range ps {
					ports = append(ports, ioPortInfo{p.HostID, p.CardType, p.Direction, p.PortID})
				}
			}
			if cs, err := ioPortStore.ListClaims(); err == nil {
				for _, c := range cs {
					claims = append(claims, ioClaimInfo{c.HostID, c.PortID})
				}
			}
		}

		// Lokaler Host (der Orchestrator selbst, HostID leer): kein Host-Agent,
		// Kapazität direkt aus dem Betriebssystem.
		local := schedResHost{ID: "", Label: "Orchestrator (lokal)", Local: true, Online: true, NumCPU: runtime.NumCPU(), MemTotal: localMemTotal()}
		local.CapKnown = local.MemTotal > 0
		local.IOPorts = ioCaps(ports, claims, "")
		resp.Hosts = append(resp.Hosts, local)

		all, err := registry.ListHosts()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		for _, h := range all {
			sh := schedResHost{ID: h.ID, Label: h.Label}
			var caps struct {
				NumCPU int `json:"numCPU"`
			}
			_ = json.Unmarshal(h.Capabilities, &caps)
			sh.NumCPU = caps.NumCPU
			if m, ok := metrics.Get(h.ID); ok {
				age := time.Since(m.ReceivedAt)
				sh.Online = age < placement.HostOnlineThreshold
				sh.LastSeenAge = age.Seconds()
				sh.MemTotal = m.MemTotalBytes
				if m.Net != nil {
					sh.NetLinkMbps = m.Net.LinkMbps
				}
				live := &schedResHostLive{CPUPercent: m.CPUPercent}
				if m.MemTotalBytes > 0 {
					live.MemPercent = float64(m.MemUsedBytes) / float64(m.MemTotalBytes) * 100
				}
				if m.Net != nil && m.Net.LinkMbps > 0 {
					v := (m.Net.RxBytesPerSec + m.Net.TxBytesPerSec) * 8 / (m.Net.LinkMbps * 1e6) * 100
					live.NetPercent = &v
				}
				if m.Net != nil {
					live.NetRxMbps = m.Net.RxBytesPerSec * 8 / 1e6
					live.NetTxMbps = m.Net.TxBytesPerSec * 8 / 1e6
				}
				if m.Gpu != nil {
					v := m.Gpu.UtilizationPercent
					live.GpuPercent = &v
					sh.GPUKnown = true
				}
				sh.Live = live
			}
			sh.CapKnown = sh.NumCPU > 0 && sh.MemTotal > 0
			sh.IOPorts = ioCaps(ports, claims, h.ID)
			resp.Hosts = append(resp.Hosts, sh)
		}

		wfs, err := workflowSvc.List()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		for _, wf := range wfs {
			sw := schedResWorkflow{ID: wf.ID, Name: wf.Name, Status: string(wf.Status)}
			for _, role := range wf.Definition.Roles {
				sr := schedResRole{Name: role.Name, NodeType: role.NodeType, HostID: role.HostID}
				if role.RequiredIOPort != nil {
					sr.IOPort = &schedIO{CardType: role.RequiredIOPort.CardType, Direction: role.RequiredIOPort.Direction}
				}
				if rn, has := computeRoleNetwork(catalog, wf.Definition, role); has {
					sr.NetRxMbps, sr.NetTxMbps, sr.NetEstimated = rn.RxMbps, rn.TxMbps, rn.Estimated
				}
				snap, ok, fallback := lookupProfile(r.Context(), profileStore, role.NodeType, role.HostID)
				if ok {
					sr.Known, sr.Fallback = true, fallback
					p95 := snap.CPUP95
					if p95 < snap.CPUAvg {
						p95 = snap.CPUAvg
					}
					sr.CPUCores = p95 / 100
					sr.CPUAvg = snap.CPUAvg / 100
					sr.RSSBytes = snap.RSSMax
					if sr.RSSBytes < snap.RSSAvg {
						sr.RSSBytes = snap.RSSAvg
					}
					if snap.GPUSamples > 0 {
						sr.GPUKnown = true
						sr.GPUPercent = snap.GPUP95
						if sr.GPUPercent < snap.GPUAvg {
							sr.GPUPercent = snap.GPUAvg
						}
					}
				}
				sw.Roles = append(sw.Roles, sr)
			}
			resp.Workflows = append(resp.Workflows, sw)
		}
		resp.ManualInstances = manualInstances(r.Context(), catalog, metrics, profileStore, wfs)
		writeJSON(w, http.StatusOK, resp)
	}
}

// manualInstances sammelt die laufenden Instanzen ohne Workflow-Zugehörigkeit.
// Bedarf: höherer Wert aus aktueller Messung und Profil-p95 (konservativ,
// wie die Workflow-Rollen); Netz aus der Katalog-Deklaration.
func manualInstances(ctx context.Context, cat CatalogReader, metrics HostMetricsReader, profileStore ProfileReader, wfs []workflows.Workflow) []schedResManual {
	out := []schedResManual{}
	if cat == nil {
		return out
	}
	owned := map[string]bool{}
	for _, wf := range wfs {
		for _, rt := range wf.Runtime {
			owned[rt.InstanceID] = true
		}
	}
	for _, inst := range cat.List() {
		if inst.Crashed || owned[inst.ID] {
			continue
		}
		mi := schedResManual{ID: inst.ID, Label: inst.Label, NodeType: inst.Type, HostID: inst.HostID}
		if inst.CPUPercent != nil && inst.RSSBytes != nil {
			mi.CPUCores, mi.RSSBytes, mi.Known, mi.Measured = *inst.CPUPercent/100, *inst.RSSBytes, true, true
		} else if inst.HostID != "" && metrics != nil {
			if m, ok := metrics.Get(inst.HostID); ok {
				for _, im := range m.Instances {
					if im.InstanceID == inst.ID {
						mi.CPUCores, mi.RSSBytes, mi.Known, mi.Measured = im.CPUPercent/100, im.RSSBytes, true, true
						if im.GpuPercent != nil {
							mi.GPUPercent, mi.GPUKnown = *im.GpuPercent, true
						}
					}
				}
			}
		}
		if snap, ok, _ := lookupProfile(ctx, profileStore, inst.Type, inst.HostID); ok {
			p95 := snap.CPUP95
			if p95 < snap.CPUAvg {
				p95 = snap.CPUAvg
			}
			rss := snap.RSSMax
			if rss < snap.RSSAvg {
				rss = snap.RSSAvg
			}
			if p95/100 > mi.CPUCores {
				mi.CPUCores = p95 / 100
			}
			if rss > mi.RSSBytes {
				mi.RSSBytes = rss
			}
			mi.Known = true
			if snap.GPUSamples > 0 {
				g := snap.GPUP95
				if g < snap.GPUAvg {
					g = snap.GPUAvg
				}
				if g > mi.GPUPercent {
					mi.GPUPercent = g
				}
				mi.GPUKnown = true
			}
		}
		if rn, has := computeRoleNetwork(cat, workflows.Definition{}, workflows.Role{Name: inst.Label, NodeType: inst.Type}); has {
			mi.NetRxMbps, mi.NetTxMbps, mi.NetEstimated = rn.RxMbps, rn.TxMbps, rn.Estimated
		}
		out = append(out, mi)
	}
	return out
}

func lookupProfile(ctx context.Context, store ProfileReader, nodeType, hostID string) (snap profiles.Snapshot, ok, fallback bool) {
	if store == nil || nodeType == "" {
		return profiles.Snapshot{}, false, false
	}
	if hostID != "" {
		if s, found, err := store.Get(ctx, nodeType, hostID); err == nil && found && s.SampleCount > 0 {
			return s, true, false
		}
	}
	if s, found, err := store.Get(ctx, nodeType, profiles.GlobalHostID); err == nil && found && s.SampleCount > 0 {
		return s, true, hostID != ""
	}
	return profiles.Snapshot{}, false, false
}

type ioPortInfo struct{ hostID, cardType, direction, portID string }
type ioClaimInfo struct{ hostID, portID string }

func ioCaps(ports []ioPortInfo, claims []ioClaimInfo, hostID string) []schedResIOCap {
	type key struct{ card, dir string }
	total := map[key]int{}
	portKey := map[string]key{}
	for _, p := range ports {
		if p.hostID != hostID {
			continue
		}
		k := key{p.cardType, p.direction}
		total[k]++
		portKey[p.portID] = k
	}
	claimed := map[key]int{}
	for _, c := range claims {
		if c.hostID != hostID {
			continue
		}
		if k, ok := portKey[c.portID]; ok {
			claimed[k]++
		}
	}
	var out []schedResIOCap
	for k, n := range total {
		out = append(out, schedResIOCap{CardType: k.card, Direction: k.dir, Total: n, Claimed: claimed[k]})
	}
	sortIOCaps(out)
	return out
}

func sortIOCaps(c []schedResIOCap) {
	for i := 1; i < len(c); i++ {
		for j := i; j > 0 && (c[j].CardType < c[j-1].CardType || (c[j].CardType == c[j-1].CardType && c[j].Direction < c[j-1].Direction)); j-- {
			c[j], c[j-1] = c[j-1], c[j]
		}
	}
}

// localMemTotal liest MemTotal aus /proc/meminfo (Linux), 0 wenn unbekannt.
func localMemTotal() uint64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if rest, ok := strings.CutPrefix(sc.Text(), "MemTotal:"); ok {
			fields := strings.Fields(rest)
			if len(fields) >= 1 {
				kb, _ := strconv.ParseUint(fields[0], 10, 64)
				return kb * 1024
			}
		}
	}
	return 0
}
