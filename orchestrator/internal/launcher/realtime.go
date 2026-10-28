package launcher

import (
	"log/slog"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// CatalogRealtime (Handbuch Kap. 10) pinnt und priorisiert den Prozess eines
// Node-Typs. Umgesetzt als Wrapper `chrt … taskset … nice … <binary>`: alle drei
// Werkzeuge ersetzen sich per exec, die PID bleibt die des Nodes, und Affinität/
// Priorität gelten schon für den ersten Thread (kein Race wie bei nachträglichem
// sched_setaffinity). Nur für runner:"process"; Container: Podman-Optionen.
type CatalogRealtime struct {
	// Cpus: CPU-Liste im taskset-Format, z. B. "4-7" oder "4,6,8-11".
	Cpus string `json:"cpus,omitempty"`
	// Policy: "" / "other" (Standard), "fifo" oder "rr".
	Policy string `json:"policy,omitempty"`
	// Priority: 1..90, nur bei fifo/rr (99 ist dem Kernel vorbehalten).
	Priority int `json:"priority,omitempty"`
	// Nice: -20..19, nur bei Policy other (0 = unverändert).
	Nice int `json:"nice,omitempty"`
}

var cpuListRe = regexp.MustCompile(`^\d+(-\d+)?(,\d+(-\d+)?)*$`)

// maxOnlineCPU liest den höchsten Online-CPU-Index; -1 wenn unbekannt.
func maxOnlineCPU() int {
	b, err := os.ReadFile("/sys/devices/system/cpu/online")
	if err != nil {
		return -1
	}
	s := strings.TrimSpace(string(b))
	last := s[strings.LastIndexAny(s, ",-")+1:]
	n, err := strconv.Atoi(last)
	if err != nil {
		return -1
	}
	return n
}

func cpuListMax(list string) int {
	max := 0
	for _, part := range strings.Split(list, ",") {
		hi := part[strings.LastIndex(part, "-")+1:]
		if n, _ := strconv.Atoi(hi); n > max {
			max = n
		}
	}
	return max
}

var (
	probeMu    sync.Mutex
	probeCache = map[string]bool{}
)

// probeOK führt `argv… true` einmal aus (Rechte-Test, z. B. fehlendes
// LimitRTPRIO) und merkt sich das Ergebnis.
func probeOK(argv ...string) bool {
	key := strings.Join(argv, " ")
	probeMu.Lock()
	defer probeMu.Unlock()
	if v, ok := probeCache[key]; ok {
		return v
	}
	_, lerr := exec.LookPath(argv[0])
	ok := lerr == nil && exec.Command(argv[0], append(argv[1:], "true")...).Run() == nil
	probeCache[key] = ok
	return ok
}

// wrapRealtime liefert argv, ggf. mit Wrapper-Präfix. Nicht anwendbare Teile
// (CPU gibt es auf diesem Host nicht, keine Rechte, Werkzeug fehlt) werden mit
// einer Warnung weggelassen — der Node startet dann ungepinnt statt gar nicht,
// weil derselbe Katalog auf Hosts mit unterschiedlicher Kernzahl gilt.
// OMP_RT_DISABLE=1 auf dem Host schaltet alles ab.
func wrapRealtime(typ string, rt *CatalogRealtime, argv []string) []string {
	if rt == nil || os.Getenv("OMP_RT_DISABLE") == "1" {
		return argv
	}
	var prefix []string
	policy := strings.ToLower(rt.Policy)
	if (policy == "fifo" || policy == "rr") && rt.Priority >= 1 && rt.Priority <= 90 {
		flag := "-f"
		if policy == "rr" {
			flag = "-r"
		}
		p := []string{"chrt", flag, strconv.Itoa(rt.Priority)}
		if probeOK(p...) {
			prefix = append(prefix, p...)
		} else {
			slog.Warn("launcher: realtime-Priorität nicht möglich (Rechte/LimitRTPRIO/chrt fehlt) — ohne", "type", typ, "policy", policy, "priority", rt.Priority)
		}
	} else if policy != "" && policy != "other" {
		slog.Warn("launcher: realtime.policy/priority ungültig — ignoriert", "type", typ, "policy", rt.Policy, "priority", rt.Priority)
	}
	if rt.Cpus != "" {
		switch mx := maxOnlineCPU(); {
		case !cpuListRe.MatchString(rt.Cpus):
			slog.Warn("launcher: realtime.cpus ungültig — ignoriert", "type", typ, "cpus", rt.Cpus)
		case mx >= 0 && cpuListMax(rt.Cpus) > mx:
			slog.Warn("launcher: realtime.cpus liegt außerhalb der CPUs dieses Hosts — ignoriert", "type", typ, "cpus", rt.Cpus, "maxCpu", mx)
		default:
			p := []string{"taskset", "-c", rt.Cpus}
			if probeOK(p...) {
				prefix = append(prefix, p...)
			} else {
				slog.Warn("launcher: taskset nicht verfügbar/erlaubt — ohne Pinning", "type", typ, "cpus", rt.Cpus)
			}
		}
	}
	if rt.Nice != 0 && (policy == "" || policy == "other") && rt.Nice >= -20 && rt.Nice <= 19 {
		p := []string{"nice", "-n", strconv.Itoa(rt.Nice)}
		if probeOK(p...) {
			prefix = append(prefix, p...)
		} else {
			slog.Warn("launcher: nice nicht erlaubt (LimitNICE) — ohne", "type", typ, "nice", rt.Nice)
		}
	}
	if len(prefix) == 0 {
		return argv
	}
	return append(prefix, argv...)
}

// withCPUAffinity überlagert die Kernbindung des Katalogs mit der Instanz-/Typ-Option OMP_CPU_AFFINITY (CPU-Liste im
// taskset-Format, z. B. „2-3“). Leer/fehlt = Katalogwert bzw. keine Bindung (Standard aus). Ungültige oder nicht vorhandene
// CPUs werden von wrapRealtime mit Warnung ignoriert — der Node startet dann ungebunden.
func withCPUAffinity(rt *CatalogRealtime, env map[string]string) *CatalogRealtime {
	v := strings.TrimSpace(env["OMP_CPU_AFFINITY"])
	if v == "" {
		return rt
	}
	out := CatalogRealtime{}
	if rt != nil {
		out = *rt
	}
	out.Cpus = v
	return &out
}
