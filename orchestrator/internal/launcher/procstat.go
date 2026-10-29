package launcher

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// procstat.go: /proc/<pid>-Messung für lokal laufende Instanzen
// (Kapitel 14 Teil 2, docs/END-GOAL-FEATURES.md §14.3b) — identische
// Logik zu host-agent/internal/telemetry.processTimes/processRSSBytes
// (eigenständige Go-Module, gleiche bewusste kleine Duplikation wie
// buildEnv/tailBuffer zwischen diesem Paket und
// host-agent/internal/commands, s. dortiger Paketkommentar).

// clockTicksPerSecond ist USER_HZ, der Skalierungsfaktor von
// utime/stime in /proc/<pid>/stat (Kernel-ABI, "man proc"). Per
// `getconf CLK_TCK` auf der Entwicklungsmaschine verifiziert (=100, der
// praktisch universelle Linux-Default), nicht geraten (UMSETZUNG.md §0
// Punkt 9 gilt sinngemäß auch außerhalb von GStreamer).
const clockTicksPerSecond = 100

type procCPUState struct {
	ticks uint64
	at    time.Time
}

type instanceResourceSample struct {
	cpuPercent float64
	rssBytes   uint64
	// GPU-Nutzung dieser Instanz (inkl. Kindprozesse); nil = nicht
	// gemessen (kein nvidia-smi / Treiber ohne fb-Spalte).
	gpuPercent *float64
	gpuMem     *uint64
}

// processTimes liest utime+stime (Klock-Ticks) aus /proc/<pid>/stat.
// comm (Feld 2) kann Leerzeichen/Klammern enthalten — deshalb hinter der
// letzten ")" weiterparsen statt naiv nach Leerzeichen zu splitten. Nach
// der schließenden Klammer beginnt state (Feld 3) als Index 0; utime
// (Feld 14 gesamt) liegt damit bei Index 11, stime (Feld 15) bei Index 12.
func processTimes(pid int) (ticks uint64, err error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, err
	}
	text := string(data)
	closeParen := strings.LastIndexByte(text, ')')
	if closeParen < 0 {
		return 0, fmt.Errorf("launcher: unexpected /proc/%d/stat format", pid)
	}
	fields := strings.Fields(text[closeParen+1:])
	if len(fields) < 13 {
		return 0, fmt.Errorf("launcher: too few fields in /proc/%d/stat", pid)
	}
	utime, err := strconv.ParseUint(fields[11], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("launcher: parse utime for pid %d: %w", pid, err)
	}
	stime, err := strconv.ParseUint(fields[12], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("launcher: parse stime for pid %d: %w", pid, err)
	}
	return utime + stime, nil
}

// processRSSBytes liest VmRSS aus /proc/<pid>/status.
func processRSSBytes(pid int) (uint64, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0, fmt.Errorf("launcher: unexpected VmRSS line %q for pid %d", line, pid)
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("launcher: parse VmRSS for pid %d: %w", pid, err)
		}
		return kb * 1024, nil
	}
	// Keine VmRSS-Zeile (z. B. Prozess bereits beendet) — 0 statt Fehler,
	// gleiche Nachsicht wie das host-agent-Gegenstück.
	return 0, nil
}

// containerCgroup: cgroup-v2-Verzeichnis eines laufenden Podman-Containers samt Haupt-PID im Host-Namensraum.
// Der Node-Prozess allein (PID) hätte weder die Kindprozesse (Engine, Web-Renderer) noch einen sinnvollen RSS-Wert.
type containerCgroup struct {
	pid int
	dir string
}

var containerCgroupLookup = func(containerID string) (containerCgroup, error) {
	out, err := exec.Command("podman", "inspect", "--format", "{{.State.Pid}}", containerID).Output()
	if err != nil {
		return containerCgroup{}, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || pid <= 0 {
		return containerCgroup{}, fmt.Errorf("launcher: container %s hat keine PID", containerID)
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid))
	if err != nil {
		return containerCgroup{}, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		// Eigene cgroup nur, wenn der Container wirklich in einer liegt (nicht in der Wurzel, nicht cgroup v1).
		if rest, ok := strings.CutPrefix(line, "0::"); ok && strings.TrimSpace(rest) != "/" {
			return containerCgroup{pid: pid, dir: "/sys/fs/cgroup" + strings.TrimSpace(rest)}, nil
		}
	}
	return containerCgroup{pid: pid}, nil // Prozessbaum ab PID messen
}

// containerUsage liest CPU-Zeit (in Klock-Ticks wie /proc/<pid>/stat) und Speicher des gesamten Containers aus dessen cgroup.
func containerUsage(dir string) (ticks uint64, rssBytes uint64, err error) {
	stat, err := os.ReadFile(dir + "/cpu.stat")
	if err != nil {
		return 0, 0, err
	}
	found := false
	for _, line := range strings.Split(string(stat), "\n") {
		if rest, ok := strings.CutPrefix(line, "usage_usec "); ok {
			usec, perr := strconv.ParseUint(strings.TrimSpace(rest), 10, 64)
			if perr != nil {
				return 0, 0, perr
			}
			ticks, found = usec*clockTicksPerSecond/1_000_000, true
		}
	}
	if !found {
		return 0, 0, fmt.Errorf("launcher: usage_usec fehlt in %s/cpu.stat", dir)
	}
	mem, err := os.ReadFile(dir + "/memory.current")
	if err != nil {
		return 0, 0, err
	}
	rssBytes, err = strconv.ParseUint(strings.TrimSpace(string(mem)), 10, 64)
	return ticks, rssBytes, err
}

// processTreeUsage summiert CPU-Zeit und Speicher des Prozesses root und aller seiner Nachkommen (Ersatz, wenn der Container
// keine eigene cgroup hat, z. B. unter cgroup v1 oder in einer Container-in-Container-Umgebung).
func processTreeUsage(root int) (ticks uint64, rssBytes uint64, err error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, 0, err
	}
	parent := map[int]int{}
	for _, e := range entries {
		pid, convErr := strconv.Atoi(e.Name())
		if convErr != nil {
			continue
		}
		data, readErr := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if readErr != nil {
			continue
		}
		text := string(data)
		closeParen := strings.LastIndexByte(text, ')')
		if closeParen < 0 {
			continue
		}
		if f := strings.Fields(text[closeParen+1:]); len(f) > 1 {
			if ppid, perr := strconv.Atoi(f[1]); perr == nil {
				parent[pid] = ppid
			}
		}
	}
	inTree := map[int]bool{root: true}
	for changed := true; changed; {
		changed = false
		for pid, ppid := range parent {
			if !inTree[pid] && inTree[ppid] {
				inTree[pid], changed = true, true
			}
		}
	}
	found := false
	for pid := range inTree {
		t, terr := processTimes(pid)
		if terr != nil {
			continue
		}
		found = true
		ticks += t
		if r, rerr := processRSSBytes(pid); rerr == nil {
			rssBytes += r
		}
	}
	if !found {
		return 0, 0, fmt.Errorf("launcher: Container-Prozess %d nicht lesbar", root)
	}
	return ticks, rssBytes, nil
}
