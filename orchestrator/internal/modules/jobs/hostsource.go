package jobs

import (
	"encoding/json"
	"runtime"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/jobrun"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// hostSource baut aus den Kernschnittstellen die Hostzustände für den Dispatcher.
type hostSource struct {
	m *Module
}

func (h hostSource) Hosts() []jobrun.HostState {
	d := h.m.deps()
	out := []jobrun.HostState{h.local(d)}
	if d.Hosts == nil {
		return out
	}
	list, err := d.Hosts.ListHosts()
	if err != nil {
		return out
	}
	for _, ho := range list {
		out = append(out, agentState(d, ho))
	}
	return out
}

func (h hostSource) local(d module.Deps) jobrun.HostState {
	st := jobrun.HostState{ID: jobrun.LocalHostID, Label: "Orchestrator-Host", Local: true, Online: true, Capable: false,
		CPUCores: float64(runtime.NumCPU()), NetUtil: -1, Tools: map[string]jobrun.ToolCaps{}}
	for _, t := range []string{"ffmpeg", "ffprobe"} {
		if h.m.LocalTool(t) != "" {
			st.Tools[t] = jobrun.ToolCaps{}
			st.Capable = true
		}
	}
	if d.Instances != nil {
		if cpu, mem, ok := d.Instances.LocalLoad(); ok {
			st.CPUPercent, st.MemUsedPct = cpu, mem
		}
		st.LiveInstances = d.Instances.CountOnHost("")
	}
	return st
}

func agentState(d module.Deps, ho hosts.Host) jobrun.HostState {
	label := ho.Label
	if label == "" {
		label = ho.Hostname
	}
	st := jobrun.HostState{ID: ho.ID, Label: label, Maintenance: ho.MaintenanceSince != nil, NetUtil: -1}
	if d.HostMetrics == nil {
		return st
	}
	m, ok := d.HostMetrics.Get(ho.ID)
	if !ok || time.Since(m.ReceivedAt) > 30*time.Second || m.Goodbye {
		return st
	}
	st.Online = true
	st.CPUPercent = m.CPUPercent
	if m.MemTotalBytes > 0 {
		st.MemUsedPct = 100 * float64(m.MemUsedBytes) / float64(m.MemTotalBytes)
	}
	st.CPUCores = coresOf(ho)
	for _, in := range m.Instances {
		st.LiveInstances++
		if st.CPUCores > 0 {
			st.LiveCPUPercent += in.CPUPercent / st.CPUCores
		}
	}
	if m.Gpu != nil {
		mem := 0.0
		if m.Gpu.MemTotalBytes > 0 {
			mem = 100 * float64(m.Gpu.MemUsedBytes) / float64(m.Gpu.MemTotalBytes)
		}
		st.Gpu = &jobrun.GPUState{UtilPercent: m.Gpu.UtilizationPercent, MemUsedPct: mem}
	}
	if m.Net != nil && m.Net.LinkMbps > 0 {
		used := (m.Net.RxBytesPerSec + m.Net.TxBytesPerSec) * 8 / 1e6
		st.NetUtil = used / m.Net.LinkMbps
	}
	if j := m.Jobs; j != nil {
		st.Capable = len(j.Tools) > 0
		st.Roots, st.AllowNet, st.MaxJobs = j.JobRoots, j.AllowNet, j.MaxJobs
		st.Tools = map[string]jobrun.ToolCaps{}
		for n, t := range j.Tools {
			st.Tools[n] = jobrun.ToolCaps{Version: t.Version, Encoders: t.Encoders, Decoders: t.Decoders, Hwaccels: t.Hwaccels}
		}
	}
	return st
}

// coresOf liest die Kernzahl aus den beim Registrieren gemeldeten Fähigkeiten (numCPU); Standard 4.
func coresOf(ho hosts.Host) float64 {
	var c struct {
		NumCPU float64 `json:"numCPU"`
	}
	if len(ho.Capabilities) > 0 && json.Unmarshal(ho.Capabilities, &c) == nil && c.NumCPU > 0 {
		return c.NumCPU
	}
	return 4
}
