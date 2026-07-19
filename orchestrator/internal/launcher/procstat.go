package launcher

import (
	"fmt"
	"os"
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
