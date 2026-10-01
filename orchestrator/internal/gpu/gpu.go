// Package gpu misst die GPU-Nutzung des Hosts, auf dem der Orchestrator
// selbst läuft (NVIDIA, über `nvidia-smi`): Pool-Auslastung/-Speicher des
// Hosts und je Prozess Auslastung + VRAM. Spiegel von
// host-agent/internal/telemetry (eigenständige Go-Module, gleiche bewusste
// kleine Duplikation wie beim übrigen Wire-Format) — entfernte Hosts melden
// dieselben Größen über ihren Host-Agent, nur der lokale Host hat keinen.
//
// Ehrlichkeitslinie wie überall: kein nvidia-smi / unbekanntes Format =
// "nicht gemessen" (nil), nie "0 %".
package gpu

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// HostSample ist die Pool-Momentaufnahme: Auslastung gemittelt über die
// Count GPUs, Speicher summiert.
type HostSample struct {
	Count       int
	UtilPercent float64
	MemUsed     uint64
	MemTotal    uint64
}

// Proc ist die GPU-Nutzung eines Prozesses (SM in Prozent einer GPU, FB =
// VRAM in Bytes, nur wenn der Treiber die Spalte liefert).
type Proc struct {
	SM    float64
	FB    uint64
	HasFB bool
}

// Result ist ein vollständiger Messdurchlauf; Host == nil heißt "keine
// GPU/nicht messbar".
type Result struct {
	Host    *HostSample
	Procs   map[int]Proc
	Parents map[int]int
}

// ParseSpec wertet OMP_LOCAL_GPU_INDEX aus: leer/"auto" = alle GPUs
// (index -1), "off"/"none" = aus, Zahl = nur diese GPU.
func ParseSpec(v string) (index int, enabled bool, err error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "auto":
		return -1, true, nil
	case "off", "none", "false":
		return -1, false, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 0 {
		return -1, false, fmt.Errorf("gpu: ungültiger OMP_LOCAL_GPU_INDEX %q (auto, off oder Zahl >= 0)", v)
	}
	return n, true, nil
}

// Probe misst Host-Pool und Prozesse. Ohne nvidia-smi im PATH sofort leer
// (kein Prozessstart je Tick auf Rechnern ohne NVIDIA).
func Probe(ctx context.Context) Result {
	index, enabled, err := ParseSpec(os.Getenv("OMP_LOCAL_GPU_INDEX"))
	if err != nil || !enabled {
		return Result{}
	}
	if _, err := exec.LookPath("nvidia-smi"); err != nil {
		return Result{}
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	args := []string{"--query-gpu=index,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"}
	pargs := []string{"pmon", "-c", "1", "-s", "um"}
	if index >= 0 {
		args = append(args, "-i", strconv.Itoa(index))
		pargs = append(pargs, "-i", strconv.Itoa(index))
	}
	out, err := exec.CommandContext(ctx, "nvidia-smi", args...).Output()
	if err != nil {
		return Result{}
	}
	host, err := ParseHost(string(out))
	if err != nil {
		return Result{}
	}
	res := Result{Host: &host}
	if pout, err := exec.CommandContext(ctx, "nvidia-smi", pargs...).Output(); err == nil {
		if procs, err := ParsePmon(string(pout)); err == nil {
			res.Procs, res.Parents = procs, ParentPIDs()
		}
	}
	return res
}

// ParseHost fasst die CSV-Zeilen "<index>, <util%>, <used MiB>, <total MiB>"
// (eine je GPU) zum Pool zusammen.
func ParseHost(out string) (HostSample, error) {
	const mib = 1024 * 1024
	var s HostSample
	var utilSum float64
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		f := strings.Split(strings.TrimSpace(line), ",")
		if len(f) != 4 {
			return HostSample{}, fmt.Errorf("gpu: unerwartete nvidia-smi-Ausgabe: %q", out)
		}
		n := make([]float64, 4)
		for i := range f {
			v, err := strconv.ParseFloat(strings.TrimSpace(f[i]), 64)
			if err != nil {
				return HostSample{}, fmt.Errorf("gpu: nvidia-smi Feld %d: %w", i, err)
			}
			n[i] = v
		}
		s.Count++
		utilSum += n[1]
		s.MemUsed += uint64(n[2] * mib)
		s.MemTotal += uint64(n[3] * mib)
	}
	if s.Count == 0 {
		return HostSample{}, fmt.Errorf("gpu: keine GPU in der Ausgabe")
	}
	s.UtilPercent = utilSum / float64(s.Count)
	return s, nil
}

// ParsePmon liest `nvidia-smi pmon -c 1 -s um`: Spalten werden aus der
// ersten Kopfzeile bestimmt (Reihenfolge hängt von der Treiberversion ab),
// "-" zählt als 0, mehrfach genannte PIDs (C/G, mehrere GPUs) werden
// summiert. Unbekanntes Format ist ein Fehler.
func ParsePmon(out string) (map[int]Proc, error) {
	pidCol, smCol, fbCol := -1, -1, -1
	procs := map[int]Proc{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			if pidCol >= 0 {
				continue
			}
			for i, f := range strings.Fields(strings.TrimPrefix(line, "#")) {
				switch f {
				case "pid":
					pidCol = i
				case "sm":
					smCol = i
				case "fb":
					fbCol = i
				}
			}
			continue
		}
		if pidCol < 0 || smCol < 0 {
			return nil, fmt.Errorf("gpu: pmon-Kopfzeile ohne pid/sm")
		}
		fields := strings.Fields(line)
		if len(fields) <= pidCol || len(fields) <= smCol {
			continue
		}
		pid, err := strconv.Atoi(fields[pidCol])
		if err != nil {
			continue
		}
		sm := 0.0
		if fields[smCol] != "-" {
			if sm, err = strconv.ParseFloat(fields[smCol], 64); err != nil {
				continue
			}
		}
		p := procs[pid]
		p.SM += sm
		if fbCol >= 0 && fbCol < len(fields) && fields[fbCol] != "-" {
			if mb, err := strconv.ParseFloat(fields[fbCol], 64); err == nil {
				p.FB += uint64(mb * 1024 * 1024)
				p.HasFB = true
			}
		}
		procs[pid] = p
	}
	if pidCol < 0 || smCol < 0 {
		return nil, fmt.Errorf("gpu: pmon ohne erkennbare Kopfzeile: %q", out)
	}
	return procs, nil
}

// ParentPIDs liest die Eltern-PID aller Prozesse aus /proc.
func ParentPIDs() map[int]int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	pp := make(map[int]int, len(entries))
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		s := string(data)
		i := strings.LastIndexByte(s, ')') // comm kann Klammern/Leerzeichen enthalten
		if i < 0 {
			continue
		}
		f := strings.Fields(s[i+1:])
		if len(f) < 2 {
			continue
		}
		if ppid, err := strconv.Atoi(f[1]); err == nil {
			pp[pid] = ppid
		}
	}
	return pp
}

// ForTree summiert die Nutzung von rootPID und allen Nachkommen.
func ForTree(procs map[int]Proc, parents map[int]int, rootPID int) Proc {
	var total Proc
	for pid, p := range procs {
		for cur, hops := pid, 0; hops < 64; hops++ {
			if cur == rootPID {
				total.SM += p.SM
				total.FB += p.FB
				total.HasFB = total.HasFB || p.HasFB
				break
			}
			next, ok := parents[cur]
			if !ok || next <= 1 || next == cur {
				break
			}
			cur = next
		}
	}
	return total
}
