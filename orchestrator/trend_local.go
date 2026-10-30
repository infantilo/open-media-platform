package main

import (
	"context"
	"os"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/jobrun"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

// recordLocalHost trägt alle 5 s die Last des Orchestrator-Rechners samt Live-Anteil der lokal gestarteten Instanzen in die
// Host-Historie ein (Kapitel 54).
func recordLocalHost(ctx context.Context, l *launcher.Launcher, h *hosts.History) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		lh := l.LocalHost()
		if lh == nil {
			continue
		}
		total := memTotalBytes()
		m := hosts.Metrics{CPUPercent: lh.CPUPercent, MemTotalBytes: total, MemUsedBytes: uint64(lh.MemPercent / 100 * float64(total)), ReceivedAt: time.Now()}
		m.Sensors = sensorMetricsOf(lh.Sensors)
		m.Nics = hosts.TakeNICs()
		for _, in := range l.List() {
			if in.HostID != "" || in.CPUPercent == nil {
				continue
			}
			im := hosts.InstanceMetrics{InstanceID: in.ID, CPUPercent: *in.CPUPercent, GpuPercent: in.GPUPercent}
			if in.RSSBytes != nil {
				im.RSSBytes = *in.RSSBytes
			}
			m.Instances = append(m.Instances, im)
		}
		if lh.Net != nil {
			m.Net = &hosts.NetMetrics{Iface: lh.Net.Iface, RxBytesPerSec: lh.Net.RxBytesPerSec, TxBytesPerSec: lh.Net.TxBytesPerSec, LinkMbps: lh.Net.LinkMbps}
		}
		h.Record(jobrun.LocalHostID, m)
	}
}

func memTotalBytes() uint64 {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				var kb uint64
				for _, c := range f[1] {
					kb = kb*10 + uint64(c-'0')
				}
				return kb * 1024
			}
		}
	}
	return 0
}

// sensorMetricsOf übersetzt die lokale Sensor-Momentaufnahme in das Host-Wire-Format.
func sensorMetricsOf(s *launcher.SensorSample) *hosts.SensorMetrics {
	if s == nil {
		return nil
	}
	out := &hosts.SensorMetrics{TempC: s.TempC, PowerW: s.PowerW, PowerSource: s.PowerSource}
	for _, t := range s.Temps {
		out.Temps = append(out.Temps, hosts.SensorTemp{Name: t.Name, Label: t.Label, Celsius: t.Celsius})
	}
	return out
}
