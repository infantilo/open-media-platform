package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	mcrmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/mcr"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
)

// mcrCapacity liefert der MCR-Vorprüfung Hosts (Host-Agenten und lokaler Orchestrator-Host) und gemessene Profile.
type mcrCapacity struct {
	hosts   interface{ ListHosts() ([]hosts.Host, error) }
	metrics placement.MetricsReader
	local   interface {
		LocalHost() *launcher.LocalHostSample
	}
	profiles interface {
		Get(ctx context.Context, nodeType, hostID string) (profiles.Snapshot, bool, error)
	}
}

func (c mcrCapacity) Hosts(_ context.Context) []mcrmod.HostCap {
	var out []mcrmod.HostCap
	machines := map[string]bool{}
	all, _ := c.hosts.ListHosts()
	for _, h := range all {
		if h.MaintenanceSince != nil {
			continue
		}
		m, ok := c.metrics.Get(h.ID)
		if !ok || time.Since(m.ReceivedAt) >= placement.HostOnlineThreshold || m.MemTotalBytes == 0 {
			continue
		}
		var caps struct {
			NumCPU int `json:"numCPU"`
		}
		_ = json.Unmarshal(h.Capabilities, &caps)
		if caps.NumCPU == 0 {
			continue
		}
		label := h.Label
		if label == "" {
			label = h.Hostname
		}
		out = append(out, mcrmod.HostCap{ID: h.ID, Label: label, Cores: float64(caps.NumCPU), CPUPercent: m.CPUPercent, MemTotal: m.MemTotalBytes,
			MemPercent: float64(m.MemUsedBytes) / float64(m.MemTotalBytes) * 100})
		machines[h.Hostname] = true
	}
	// Orchestrator-Host (Nodes ohne Host-Agent); dieselbe Maschine wie ein Agent zählt nur einmal.
	name, _ := os.Hostname()
	if lh := c.local.LocalHost(); lh != nil && !machines[name] {
		if mem := procMemTotal(); mem > 0 {
			out = append(out, mcrmod.HostCap{ID: "", Label: "Orchestrator (lokal)", Cores: float64(runtime.NumCPU()), CPUPercent: lh.CPUPercent, MemTotal: mem, MemPercent: lh.MemPercent})
		}
	}
	return out
}

func (c mcrCapacity) Profile(ctx context.Context, nodeType string) (float64, uint64, bool) {
	s, ok, err := c.profiles.Get(ctx, nodeType, profiles.GlobalHostID)
	if err != nil || !ok || s.SampleCount == 0 {
		return 0, 0, false
	}
	return s.CPUP95 / 100, s.RSSMax, true
}

func procMemTotal() uint64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if rest, ok := strings.CutPrefix(sc.Text(), "MemTotal:"); ok {
			if fl := strings.Fields(rest); len(fl) >= 1 {
				kb, _ := strconv.ParseUint(fl[0], 10, 64)
				return kb * 1024
			}
		}
	}
	return 0
}
