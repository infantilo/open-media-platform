package telemetry

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// GPU-Auslastung pro Prozess (Nutzerauftrag 2026-10-01: "GPU-Messung pro
// Prozess" für den Scheduler). Quelle ist `nvidia-smi pmon` (Spalte `sm` =
// Auslastung der Shader-Kerne des Prozesses in Prozent einer GPU) — wie
// TakeGPU herstellerspezifisch, ohne generisches /proc-Äquivalent.
//
// Die Spaltenreihenfolge von pmon hängt von der Treiberversion ab (neuere
// Treiber ergänzen jpg/ofa/…), deshalb wird sie aus der ersten
// Kopfzeile ("# gpu pid type sm mem enc dec … command") gelesen statt
// fest verdrahtet. Ein "-" in einer Zelle heißt "für diesen Prozess nicht
// zutreffend" und zählt als 0.

// GPUProc ist die GPU-Nutzung eines Prozesses: SM = Auslastung in Prozent
// einer GPU, FBBytes = belegter VRAM (nur wenn der Treiber die `fb`-Spalte
// liefert, HasFB).
type GPUProc struct {
	SM      float64
	FBBytes uint64
	HasFB   bool
}

// parsePmon liefert die GPU-Nutzung je PID aus der Ausgabe von
// `nvidia-smi pmon -c 1 -s um` (u = Auslastung, m = Speicher `fb` in MB).
// Fehler, wenn die Kopfzeile weder `pid` noch `sm` enthält (unbekanntes
// Format — kein stilles Raten). Fehlt `fb`, bleibt HasFB false.
func parsePmon(out string) (map[int]GPUProc, error) {
	pidCol, smCol, fbCol := -1, -1, -1
	procs := map[int]GPUProc{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			if pidCol >= 0 {
				continue // zweite Kopfzeile (Einheiten)
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
			return nil, fmt.Errorf("telemetry: nvidia-smi pmon: Kopfzeile ohne pid/sm: %q", out)
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
		// derselbe Prozess kann als Compute (C) und Graphics (G) bzw. auf
		// mehreren GPUs erscheinen — Summen.
		p := procs[pid]
		p.SM += sm
		if fbCol >= 0 && fbCol < len(fields) && fields[fbCol] != "-" {
			if mb, err := strconv.ParseFloat(fields[fbCol], 64); err == nil {
				p.FBBytes += uint64(mb * 1024 * 1024)
				p.HasFB = true
			}
		}
		procs[pid] = p
	}
	if pidCol < 0 || smCol < 0 {
		if strings.TrimSpace(out) == "" {
			return nil, fmt.Errorf("telemetry: nvidia-smi pmon: leere Ausgabe")
		}
		return nil, fmt.Errorf("telemetry: nvidia-smi pmon: keine Kopfzeile mit pid/sm: %q", out)
	}
	return procs, nil
}

// TakeGPUProcs misst die GPU-Nutzung je PID auf allen GPUs (index < 0)
// bzw. der per index benannten GPU. ok=false heißt "nicht gemessen" (nvidia-smi fehlt, Format unbekannt,
// Timeout) — nie "0 %". Ein Prozess, der in der Liste fehlt, nutzt die GPU
// gerade nicht (0 %), das entscheidet der Aufrufer über GPUPercentForTree.
func TakeGPUProcs(ctx context.Context, index int) (map[int]GPUProc, bool) {
	args := []string{"pmon", "-c", "1", "-s", "um"}
	if index >= 0 {
		args = append(args, "-i", strconv.Itoa(index))
	}
	out, err := exec.CommandContext(ctx, "nvidia-smi", args...).Output()
	if err != nil {
		return nil, false
	}
	procs, err := parsePmon(string(out))
	if err != nil {
		return nil, false
	}
	return procs, true
}

// ParentPIDs liest die Eltern-PID aller Prozesse aus /proc (für
// GPUForTree: ein Node kann Kindprozesse starten, die die GPU nutzen,
// z. B. ein ffmpeg-Task).
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
		// comm (Feld 2) kann Leerzeichen/Klammern enthalten — hinter der
		// letzten ")" weiterparsen: state, dann ppid.
		i := strings.LastIndexByte(s, ')')
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

// GPUForTree summiert die GPU-Nutzung von rootPID und all seinen
// Nachkommen; HasFB nur, wenn mindestens ein Prozess des Baums einen
// VRAM-Wert geliefert hat.
func GPUForTree(procs map[int]GPUProc, parents map[int]int, rootPID int) GPUProc {
	var total GPUProc
	for pid, p := range procs {
		for cur, hops := pid, 0; hops < 64; hops++ {
			if cur == rootPID {
				total.SM += p.SM
				total.FBBytes += p.FBBytes
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

// ParseGPUSpec wertet OMP_HOST_AGENT_GPU_INDEX aus: leer oder "auto" = alle
// GPUs des Hosts als Pool (index -1), "off"/"none" = GPU-Telemetrie aus,
// eine Zahl = nur diese GPU. Ein anderer Wert ist ein Fehler.
func ParseGPUSpec(v string) (index int, enabled bool, err error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "auto":
		return -1, true, nil
	case "off", "none", "false":
		return -1, false, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 0 {
		return -1, false, fmt.Errorf("telemetry: ungültiger GPU-Index %q (auto, off oder eine Zahl >= 0)", v)
	}
	return n, true, nil
}
