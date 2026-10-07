package launcher

import (
	"bufio"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// localhost.go: Lastmessung des Hosts, auf dem der Orchestrator selbst
// läuft (kein Host-Agent) — CPU, RAM und NIC-Durchsatz. Spiegelbild von
// host-agent/internal/telemetry (eigenständige Go-Module, bewusste kleine
// Duplikation wie in procstat.go), damit der Scheduler den lokalen Host
// wie jeden anderen zeigt und das Placement dessen Netz mitprüft.
// OMP_LOCAL_NET_IFACE: leer/"auto" = Interface der Default-Route, Name =
// dieses Interface, "off" = Netz nicht messen.

// LocalHostSample ist die letzte Messung des lokalen Hosts. Net ist nil,
// wenn kein Interface gemessen wird.
type LocalHostSample struct {
	CPUPercent float64
	MemPercent float64
	Net        *LocalNetSample
}

type LocalNetSample struct {
	Iface         string
	RxBytesPerSec float64
	TxBytesPerSec float64
	LinkMbps      float64 // 0 = Treiber meldet keine Geschwindigkeit
}

type localHostState struct {
	hasPrev  bool
	at       time.Time
	cpuTotal uint64
	cpuIdle  uint64
	iface    string
	rx, tx   uint64
}

func resolveLocalNetIface(spec string) string {
	switch s := strings.TrimSpace(spec); strings.ToLower(s) {
	case "", "auto":
		f, err := os.Open("/proc/net/route")
		if err != nil {
			return ""
		}
		defer f.Close()
		return parseDefaultRouteIface(f)
	case "off":
		return ""
	default:
		return s
	}
}

func parseDefaultRouteIface(r io.Reader) string {
	best, bestMetric := "", int64(-1)
	sc := bufio.NewScanner(r)
	sc.Scan() // Kopfzeile
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 8 || f[1] != "00000000" || f[7] != "00000000" {
			continue
		}
		m, err := strconv.ParseInt(f[6], 10, 64)
		if err != nil {
			continue
		}
		if bestMetric < 0 || m < bestMetric {
			best, bestMetric = f[0], m
		}
	}
	return best
}

func readCPUTimes() (total, idle uint64, ok bool) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	line, _, _ := strings.Cut(string(data), "\n")
	f := strings.Fields(line)
	if len(f) < 5 || f[0] != "cpu" {
		return 0, 0, false
	}
	for i, v := range f[1:] {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return 0, 0, false
		}
		if i < 8 { // user..steal; guest ist schon in user enthalten
			total += n
		}
		if i == 3 || i == 4 { // idle + iowait
			idle += n
		}
	}
	return total, idle, true
}

func readMemPercent() (float64, bool) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, false
	}
	defer f.Close()
	var total, avail uint64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		field := func() uint64 {
			p := strings.Fields(line)
			if len(p) < 2 {
				return 0
			}
			v, _ := strconv.ParseUint(p[1], 10, 64)
			return v
		}
		switch {
		case strings.HasPrefix(line, "MemTotal:"):
			total = field()
		case strings.HasPrefix(line, "MemAvailable:"):
			avail = field()
		}
	}
	if total == 0 {
		return 0, false
	}
	return float64(total-avail) / float64(total) * 100, true
}

func readNetBytes(iface string) (rx, tx uint64, ok bool) {
	data, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return 0, 0, false
	}
	for _, line := range strings.Split(string(data), "\n") {
		name, rest, found := strings.Cut(line, ":")
		if !found || strings.TrimSpace(name) != iface {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 9 {
			return 0, 0, false
		}
		rx, err1 := strconv.ParseUint(f[0], 10, 64)
		tx, err2 := strconv.ParseUint(f[8], 10, 64)
		return rx, tx, err1 == nil && err2 == nil
	}
	return 0, 0, false
}

func readNetLinkMbps(iface string) float64 {
	data, err := os.ReadFile("/sys/class/net/" + iface + "/speed")
	if err != nil {
		return 0
	}
	v, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil || v <= 0 {
		return 0
	}
	return float64(v)
}

// sampleLocalHost misst CPU/RAM/Netz des lokalen Hosts; Raten brauchen
// zwei Messpunkte (der erste Aufruf liefert nur RAM).
func (s *localHostState) sample(netSpec string) *LocalHostSample {
	now := time.Now()
	out := &LocalHostSample{}
	if m, ok := readMemPercent(); ok {
		out.MemPercent = m
	}
	total, idle, cpuOK := readCPUTimes()
	iface := resolveLocalNetIface(netSpec)
	rx, tx, netOK := uint64(0), uint64(0), false
	if iface != "" {
		rx, tx, netOK = readNetBytes(iface)
	}
	if s.hasPrev {
		if dt := now.Sub(s.at).Seconds(); dt > 0 {
			if cpuOK && total > s.cpuTotal {
				out.CPUPercent = (1 - float64(idle-s.cpuIdle)/float64(total-s.cpuTotal)) * 100
			}
			if netOK && iface == s.iface && rx >= s.rx && tx >= s.tx {
				out.Net = &LocalNetSample{Iface: iface, RxBytesPerSec: float64(rx-s.rx) / dt, TxBytesPerSec: float64(tx-s.tx) / dt, LinkMbps: readNetLinkMbps(iface)}
			}
		}
	}
	s.hasPrev, s.at, s.cpuTotal, s.cpuIdle, s.iface, s.rx, s.tx = true, now, total, idle, iface, rx, tx
	return out
}
